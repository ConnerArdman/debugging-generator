'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
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

/** Wording for a failed read of the cart the server did not describe in terms a buyer can act on. */
const CART_READ_FAILURE_LABEL = 'Your cart could not be read. Try again in a moment.';

/** Wording for a refused change the server did not describe in terms a buyer can act on. */
const CART_CHANGE_FAILURE_LABEL = 'That change could not be applied. Try again in a moment.';

/**
 * The heading a surface prints over a failure reading the cart.
 *
 * Published with the wording rather than fixed by each surface, so the heading and the sentence
 * under it always describe the same operation; see {@link CartContextValue.cartErrorTitle}.
 */
const CART_READ_FAILURE_TITLE = 'Your cart could not be read';

/** The heading a surface prints over a change the cart refused; see the one above. */
const CART_CHANGE_FAILURE_TITLE = 'That change could not be applied';

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
 * cart in place so the buyer keeps seeing what they had, except in two cases: where the failure
 * was read back from the server, in which case what that read found is published and the wording
 * stays with it, and where a read of the cart was answered with there being no cart at all, in
 * which case the contents go with the failure because they describe a cart that no longer exists.
 *
 * `'error'` states nothing about what the cart holds. Where the failure was the first read there
 * was never a cart to leave in place, so {@link CartContextValue.lines} is empty for want of ever
 * having been filled rather than because the cart is empty. A surface must not present an empty
 * state while {@link CartContextValue.cartError} is non-null; see that member and `lines`.
 */
export type CartSyncStatus = 'loading' | 'idle' | 'saving' | 'error';

/**
 * Which of the cart's two dealings with the server a failure belongs to.
 *
 * `'read'` is the cart being fetched - the first read, a refresh, or the read taken to find out
 * what a refused change did - and `'change'` is a write the server refused. They are told apart
 * because a buyer has to be told which one failed: a refused change leaves a cart that loaded
 * perfectly, and reporting it as a cart that could not be read would send a buyer to fix something
 * that is not broken.
 */
type CartFailureKind = 'read' | 'change';

/** A published failure: the heading a surface prints, and the sentence under it. */
interface CartFailureCopy {
  /** The heading, which names the operation that failed. */
  readonly title: string;
  /** The sentence, which a surface may show a buyer as it stands. */
  readonly message: string;
}

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
  /**
   * The lines of the cart, in the order the server returned them.
   *
   * An empty array is two different statements and {@link CartContextValue.cartError} is what
   * tells them apart: with no failure published it is a cart the server answered with nothing in,
   * and alongside a non-null `cartError` it is contents that could not be established - the read
   * that would have filled this array is the one that failed, or the one that found the store has
   * no cart for this browser at all, which takes away contents that had been read before. A
   * surface must therefore not show an
   * empty state, "your cart is empty" or otherwise, while a failure is published: an array nobody
   * managed to fill is not a cart known to hold nothing, and the failure notice is what a buyer
   * has to act on there.
   */
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
  /**
   * Wording for the last failure, or `null` when the cart is in step with the server.
   *
   * It is also what qualifies {@link CartContextValue.lines}, per that member: non-null, an empty
   * `lines` means the contents are unknown rather than known to be nothing. Compare it against
   * `null` rather than testing it for truthiness - a failure the server could only describe in an
   * empty string is still a failure, and a surface that reads it as absent would go on to claim
   * the cart is empty.
   */
  readonly cartError: string | null;
  /**
   * The heading for {@link CartContextValue.cartError}, or `null` when there is none.
   *
   * It names the operation that failed - reading the cart, or changing it - so a surface printing
   * the sentence prints a heading that describes the same thing. A surface takes the heading from
   * here rather than fixing one of its own: a notice headed for a read over wording about a
   * refused change tells a buyer their cart is broken when a single change was turned down, and
   * the cart in front of them is the evidence that it is not.
   *
   * It is `null` exactly when `cartError` is, so the two are read together.
   */
  readonly cartErrorTitle: string | null;
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
   * or less takes the line out of the cart, which is the write `removeLine` performs.
   *
   * A refused change is not reported until the cart has been read back from the server, for the
   * same reason a refused addition is not: the answer to a request is not always the state of the
   * cart. A cart found holding the quantity that was asked for - because another press had already
   * applied it, or because the change landed and only its reply was lost - makes this the success
   * it turned out to be, and the promise resolves with nothing said about a failure the buyer has
   * no reason to hear about. Otherwise the contents that read found are published with wording on
   * `cartError` and the promise rejects.
   */
  readonly setLineQuantity: (lineId: string, quantity: number) => Promise<void>;
  /**
   * Takes one line out of the cart on the server, then publishes the cart it answers.
   *
   * A refusal is settled against a read of the cart, exactly as `setLineQuantity` describes: a
   * line the cart no longer holds is the removal the buyer asked for, however the request was
   * answered, so the promise resolves and no failure is published. The server refusing a line it
   * has already taken out is the ordinary way that happens, and a buyer who saw the line go has no
   * failure to act on. A line still in the cart is a refusal, published and rejected as one.
   */
  readonly removeLine: (lineId: string) => Promise<void>;
  /**
   * Takes every line out of the cart on the server, then publishes the cart it answers, for a
   * buyer starting their order again. A cart that is already empty is emptied successfully.
   *
   * A refusal is settled against a read of the cart, as with the two changes above: a cart found
   * holding nothing is the emptying that was asked for, and the promise resolves.
   */
  readonly emptyCart: () => Promise<void>;
  /**
   * Reads the cart from the server again, replacing what is published.
   *
   * It is also how a surface that has learned the published cart is out of date - a page restored
   * from the browser's back/forward cache, a tab brought back to the front, an order that has just
   * turned this cart into one - asks for the current one. A read the store answers with there
   * being no cart takes the published contents away with it, so a surface cannot go on quoting
   * figures for a cart that no longer exists.
   */
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
 * Wording for `cause` that a buyer may read as it stands, describing the operation that failed.
 *
 * A failure the server described - a rejected quantity, a product that went out of stock while the
 * page was open, a cart it no longer holds - carries a sentence the store wrote for a customer,
 * and that sentence is published. Everything else is reported in the store's own words for the
 * operation that failed, so neither an internal message, nor a stack, nor an HTTP status reaches
 * the page: a status is how this browser read a reply the store did not explain, which tells a
 * buyer nothing they can act on and reads like a fault they caused.
 *
 * `kind` decides the generic wording, and it is what keeps that wording truthful. The same failure
 * is a different sentence depending on what was being attempted: a page-load read that fails has
 * not updated anything, so telling a buyer their cart could not be updated would describe an
 * operation nobody asked for.
 *
 * @param cause The failure the request came back with.
 * @param kind Which operation it belonged to; see {@link CartFailureKind}.
 * @returns A sentence fit to show a buyer.
 */
function cartFailureText(cause: unknown, kind: CartFailureKind): string {
  const generic = kind === 'read' ? CART_READ_FAILURE_LABEL : CART_CHANGE_FAILURE_LABEL;

  if (!(cause instanceof StorefrontApiError)) {
    return generic;
  }

  switch (cause.code) {
    case 'NETWORK_FAILURE':
      return 'The cart could not be reached. Check your connection and try again.';
    case 'CART_CONFLICT':
      return 'This cart changed in another tab. Refresh it to see what it holds now.';
    case 'MALFORMED_RESPONSE':
      return 'Lumen Supply sent a cart this page could not read. Refresh it to try again.';
    case 'INTERNAL_ERROR':
      // The store failing at something of its own is not a statement about this buyer's cart, so
      // what it says about it goes in the log rather than on the page: the operation that failed
      // and the fact that it is worth another try is the whole of what a buyer can use.
      return generic;
    default:
      // Everything left is the store refusing the request and naming the condition itself - a
      // quantity it will not hold, a line it no longer has, a cart it has closed - and those
      // sentences are written for a customer, so they are published as they stand. A reason this
      // browser derived from a status instead is not: its text quotes that status, which tells a
      // buyer nothing, so the operation's own wording goes out in its place.
      return cause.reported ? cause.message : generic;
  }
}

/** The heading published beside {@link cartFailureText} for the same operation. */
function cartFailureHeading(kind: CartFailureKind): string {
  return kind === 'read' ? CART_READ_FAILURE_TITLE : CART_CHANGE_FAILURE_TITLE;
}

/**
 * Whether `cause` is the store answering that it holds no cart for this browser.
 *
 * It is the one failure that says something about the contents rather than about the request: a
 * cart that is not there has no lines, so lines read from it before are no longer a reading of
 * anything. Every other failure leaves what was last read standing.
 *
 * @param cause The failure a request came back with.
 * @returns True when the store reported that there is no such cart.
 */
function isCartGone(cause: unknown): boolean {
  return cause instanceof StorefrontApiError && cause.code === 'NOT_FOUND';
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
  const [failure, setFailure] = useState<CartFailureCopy | null>(null);

  /**
   * The order the cart's requests were made in, and which of their outcomes has been published.
   *
   * A buyer can ask for two changes to one line faster than either can be answered - two presses
   * of a remove button inside a single task will do it - and the two requests then come back in
   * whatever order the store finishes them. Without this the last answer to arrive would win
   * whatever it said, so a refusal belonging to a request the buyer has already seen superseded
   * would replace a cart that is correct, and a slow success would put back contents a later
   * change had taken out. `issued` hands out a ticket per request and `applied` remembers the
   * newest one whose outcome reached the screen; see `claim`.
   *
   * The two agreeing is also how the cart knows nothing is outstanding, because every request
   * publishes an outcome and the newest one always wins: a difference between them is a request
   * still waiting to be answered. The revalidation below is the one thing that asks.
   */
  const sequence = useRef({ issued: 0, applied: 0 });

  // `null` when the layout mounted the cart outside the dispatch countdown: the totals then quote
  // no estimate, rather than taking the storefront down over a missing delivery line.
  const dispatchEta = useContext(DispatchEtaContext);

  /**
   * Claims the right to publish the outcome of the request that took `ticket`, or refuses it.
   *
   * An outcome arriving after a later request's outcome has already been published describes a
   * cart that has since moved on, and the buyer is looking at the newer one. So it is dropped here
   * rather than overwriting the screen, and the caller is told what became of its own request
   * through the promise it is holding instead - which is the whole of what it asked for.
   *
   * @param ticket The ticket the request took when it was made.
   * @returns True when this is the newest outcome so far, which is then recorded as published;
   *   false when a later one has already been published and this one is stale.
   */
  function claim(ticket: number): boolean {
    if (ticket < sequence.current.applied) {
      return false;
    }

    sequence.current.applied = ticket;

    return true;
  }

  function publishServerCart(next: CartView, ticket: number): void {
    if (!claim(ticket)) {
      return;
    }

    setCart(next);
    setSyncStatus('idle');
    setFailure(null);
  }

  /**
   * Publishes `cause` as the cart's failure, in the words of the operation it belonged to.
   *
   * A read the store answers with there being no cart is the one failure that also settles what
   * the cart holds, so the published contents go with it: lines read from a cart that no longer
   * exists are not a reading of anything, and a surface left holding them would go on listing
   * them, offering controls over them and pricing an order against them. Every other failure
   * leaves the last contents in place, so a buyer keeps seeing what they had.
   */
  function reportCartFailure(cause: unknown, kind: CartFailureKind, ticket: number): void {
    if (!claim(ticket)) {
      return;
    }

    if (kind === 'read' && isCartGone(cause)) {
      setCart(null);
    }

    setSyncStatus('error');
    setFailure({ title: cartFailureHeading(kind), message: cartFailureText(cause, kind) });
  }

  /**
   * Publishes `contents` while leaving the cart reporting `copy` as its failure.
   *
   * For the one case that is both at once: a change the server refused, and a read of the cart
   * taken afterwards to find out what it actually holds. `publishServerCart` would clear the
   * failure the buyer still needs to see, so the contents are published and the wording kept.
   * `null` is a read that did not answer either, which leaves the previously published contents
   * on screen - the same thing every other failure here does.
   */
  function publishCartUnderFailure(
    contents: CartView | null,
    copy: CartFailureCopy,
    ticket: number,
  ): void {
    if (!claim(ticket)) {
      return;
    }

    if (contents !== null) {
      setCart(contents);
    }

    setSyncStatus('error');
    setFailure(copy);
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
    const ticket = (sequence.current.issued += 1);

    let reconciled: CartView | null;

    try {
      reconciled = await loadCartContents();
    } catch (unread) {
      if (isCartGone(unread)) {
        // Not an outcome nobody established: the store has no cart for this browser, which is
        // both why the addition failed and the end of the contents this page was holding.
        reportCartFailure(unread, 'read', ticket);

        throw new CartAdditionError(CART_ADDITION_UNKNOWN_LABEL, { outcome: 'unknown', cause });
      }

      // The read is how the outcome would have been established, so its own failure is not a
      // second thing to tell the buyer about: it is what makes the outcome unknown below.
      reconciled = null;
    }

    if (reconciled !== null && unitsBefore !== null) {
      const wanted = requestedQuantity(draft.quantity);
      const delta = unitsOfProductHeld(reconciled.lines, draft.productId) - unitsBefore;

      if (wanted > 0 && delta === wanted) {
        publishServerCart(reconciled, ticket);

        return;
      }

      if (delta === 0) {
        const message = `${cartFailureText(cause, 'change')} ${CART_ADDITION_NOT_APPLIED_LABEL}`;

        publishCartUnderFailure(
          reconciled,
          { title: cartFailureHeading('change'), message },
          ticket,
        );

        throw new CartAdditionError(message, { outcome: 'not-applied', cause });
      }
    }

    publishCartUnderFailure(
      reconciled,
      { title: cartFailureHeading('change'), message: CART_ADDITION_UNKNOWN_LABEL },
      ticket,
    );

    throw new CartAdditionError(CART_ADDITION_UNKNOWN_LABEL, { outcome: 'unknown', cause });
  }

  /**
   * Works out what became of a refused change and reports it, having established it first.
   *
   * The cart is read from the server and `settled` asked whether the lines it came back with are
   * what the change was asking for. They often are, and a refusal is then not something to put in
   * front of a buyer: a second press arriving after the first has already taken a line out is
   * refused because the line has gone, which is exactly what was wanted, and a change whose reply
   * was lost on the way back may have been applied in full. In both cases the read is the evidence,
   * the contents it found are published, the promise resolves, and nothing is said - which is what
   * keeps a notice a buyer cannot act on, and a warning about a change that did happen, off the
   * screen. A cart that still holds what it held is a refusal, published and rejected as one.
   *
   * A read that answers with there being no cart is neither: the cart is gone, so the contents go
   * with it and the failure is reported as the read failure it is.
   *
   * `addLine` takes {@link settleAdditionFailure} instead, because an addition asks for units on
   * top of whatever a line already holds and so has to be measured against the figure taken before
   * the request rather than against what was asked for.
   *
   * @param cause The failure the change came back with.
   * @param settled Whether the lines the cart now holds are what the change asked for.
   * @throws The original `cause`, once the failure has been published, when they are not.
   */
  async function settleChangeFailure(
    cause: unknown,
    settled: (lines: readonly CartLine[]) => boolean,
  ): Promise<void> {
    const ticket = (sequence.current.issued += 1);

    let reconciled: CartView;

    try {
      reconciled = await loadCartContents();
    } catch (unread) {
      // A read that says there is no cart is reported as itself, because it is the more important
      // of the two failures and the only one that settles the contents. Any other read failure is
      // what leaves the outcome unestablished, so the refusal the buyer asked about is what they
      // are told about and the contents they had stay on screen.
      if (isCartGone(unread)) {
        reportCartFailure(unread, 'read', ticket);
      } else {
        reportCartFailure(cause, 'change', ticket);
      }

      throw cause;
    }

    if (settled(reconciled.lines)) {
      publishServerCart(reconciled, ticket);

      return;
    }

    publishCartUnderFailure(
      reconciled,
      { title: cartFailureHeading('change'), message: cartFailureText(cause, 'change') },
      ticket,
    );

    throw cause;
  }

  // The cart lives on the server, so the browser reads it once, when the application starts. There
  // is no polling and no reading of it on a schedule: every operation below writes through to the
  // server and publishes the cart it answered with, which is the cart checkout will price the order
  // from. The cart is read again only where something has happened that a read is the answer to -
  // a refused change, whose outcome the read is what establishes; a document the browser restored
  // or a tab brought back to the front, which is the effect below; and a surface calling
  // `refreshCart` because it has learned the published cart is out of date.
  //
  // The read belongs to this mount, so it is carried out under a signal this effect owns. A cart
  // that unmounts while its first read is in flight aborts it rather than holding a connection open
  // for an answer nobody is left to show - and the abort is the provider letting go, so neither the
  // answer nor the rejection it produces is published.
  useEffect(() => {
    const controller = new AbortController();
    const ticket = (sequence.current.issued += 1);

    void (async () => {
      try {
        const stored = await loadCartContents({ signal: controller.signal });

        if (!controller.signal.aborted) {
          publishServerCart(stored, ticket);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          reportCartFailure(cause, 'read', ticket);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, []);

  // A document the browser froze and later restored - Back and Forward from a page in the same
  // tab, which Chrome answers from its back/forward cache - comes back with the cart exactly as it
  // was when the page was left, and no request of any kind is made for it. The cart itself lives
  // on the server and one browser may be shopping in more than one tab, so figures from before the
  // freeze are figures nobody can vouch for: they are what the cart held then, printed as what it
  // holds now. The same goes for a tab brought back to the front after time spent elsewhere.
  //
  // So a restored or re-shown document asks the server what the cart holds, and what it answers
  // replaces what is on screen. The status is deliberately left where it is rather than going back
  // to 'loading': a buyer looking at their cart should see it change to the current figures when
  // the answer lands, not watch it blank while the question is in flight.
  //
  // The listeners belong to this mount and are taken off with it, under a signal this effect owns,
  // so a read still in flight when the provider goes away is abandoned rather than published.
  useEffect(() => {
    const controller = new AbortController();

    const revalidate = (): void => {
      // Only where nothing the cart asked for is still outstanding, which is what the two counters
      // agreeing says: every request made so far has had its outcome published. A read started
      // over a change still in flight would be answered by the store in either order, so it could
      // come back with the cart as it was before that change and then be the newer of the two
      // outcomes - which would take a change the store did apply back off the screen. The
      // outstanding request is the better answer anyway: it publishes the cart the store returned
      // for it, which is at least as current as this read would be.
      if (sequence.current.issued !== sequence.current.applied) {
        return;
      }

      const ticket = (sequence.current.issued += 1);

      void (async () => {
        try {
          const stored = await loadCartContents({ signal: controller.signal });

          if (!controller.signal.aborted) {
            publishServerCart(stored, ticket);
          }
        } catch (cause) {
          if (!controller.signal.aborted) {
            reportCartFailure(cause, 'read', ticket);
          }
        }
      })();
    };

    // `persisted` is the browser saying this document was restored rather than loaded. A first
    // load answers `false`, and the read that belongs to it is the one above, so nothing is asked
    // for twice.
    const restored = (event: PageTransitionEvent): void => {
      if (event.persisted) {
        revalidate();
      }
    };

    const shown = (): void => {
      if (document.visibilityState === 'visible') {
        revalidate();
      }
    };

    window.addEventListener('pageshow', restored);
    document.addEventListener('visibilitychange', shown);

    return () => {
      controller.abort();
      window.removeEventListener('pageshow', restored);
      document.removeEventListener('visibilitychange', shown);
    };
  }, []);

  async function addLine(draft: CartItemDraft): Promise<void> {
    // The units this cart holds of the product as the press is made, which is the figure a failed
    // addition is settled against. `null` while no cart has been published: there is no baseline
    // then, and an outcome measured against a figure that was never read would be invented.
    const unitsBefore = cart === null ? null : unitsOfProductHeld(cart.lines, draft.productId);
    const ticket = (sequence.current.issued += 1);

    setSyncStatus('saving');
    setFailure(null);

    try {
      const saved = await addCartItem(draft);

      publishServerCart(saved, ticket);
    } catch (cause) {
      await settleAdditionFailure(cause, draft, unitsBefore);
    }
  }

  async function refreshCart(): Promise<void> {
    const ticket = (sequence.current.issued += 1);

    setSyncStatus('loading');
    setFailure(null);

    try {
      const stored = await loadCartContents();

      publishServerCart(stored, ticket);
    } catch (cause) {
      reportCartFailure(cause, 'read', ticket);
    }
  }

  async function setLineQuantity(lineId: string, quantity: number): Promise<void> {
    const wanted = requestedQuantity(quantity);
    const ticket = (sequence.current.issued += 1);

    setSyncStatus('saving');
    setFailure(null);

    try {
      // Asking for none of a product is the same as taking its line out of the cart, and the
      // endpoint's set operation holds a line at one unit or more, so a normalised 0 is a removal.
      const saved =
        wanted === 0
          ? await removeCartItem(lineId)
          : await setCartItemQuantity({ lineId, quantity: wanted });

      publishServerCart(saved, ticket);
    } catch (cause) {
      await settleChangeFailure(cause, (lines) => {
        const held = lines.find((line) => line.id === lineId);

        return wanted === 0 ? held === undefined : held?.quantity === wanted;
      });
    }
  }

  async function removeLine(lineId: string): Promise<void> {
    const ticket = (sequence.current.issued += 1);

    setSyncStatus('saving');
    setFailure(null);

    try {
      const saved = await removeCartItem(lineId);

      publishServerCart(saved, ticket);
    } catch (cause) {
      await settleChangeFailure(cause, (lines) => !lines.some((line) => line.id === lineId));
    }
  }

  async function emptyCart(): Promise<void> {
    const ticket = (sequence.current.issued += 1);

    setSyncStatus('saving');
    setFailure(null);

    try {
      const saved = await clearCartContents();

      publishServerCart(saved, ticket);
    } catch (cause) {
      await settleChangeFailure(cause, (lines) => lines.length === 0);
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
    cartError: failure === null ? null : failure.message,
    cartErrorTitle: failure === null ? null : failure.title,
    addLine,
    setLineQuantity,
    removeLine,
    emptyCart,
    refreshCart,
  };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}
