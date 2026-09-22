'use client';

/*
 * CheckoutCharges - the channel that carries the chosen freight charge across the checkout page.
 *
 * WHY THIS EXISTS
 * `/checkout` puts the form in one column and the order review in the other, and the buyer reads a
 * closing figure in the second column for a service they chose in the first. The two are siblings:
 * neither can see the other's state, and `app/checkout/page.tsx` cannot hold the value between them
 * because it is a Server Component - the chosen service changes in the browser, after that page has
 * finished rendering, and a server component has no state to change. So the value travels on a
 * context mounted around both columns: the form publishes what the buyer chose, the review reads it,
 * and the figure printed under the lines is the same figure printed beside the radio button.
 *
 * WHAT TRAVELS, AND IN WHAT UNIT
 * One value: the service the buyer chose and the rate currently quoted for it, as
 * {@link SelectedFreight}. `amountCents` is a whole number of cents, like every monetary field in
 * `@/lib/types`, because a major-unit amount or a formatted string would put a second monetary
 * convention into the storefront - and `@/components/ui/Price` is the one component that turns cents
 * into text. Nothing else is published here: the merchandise figures belong to `@/hooks/useCartSummary`,
 * and the discounts and tax an order attracts are settled by the endpoint that writes the order.
 *
 * TWO CONTEXTS, NOT ONE OBJECT
 * The published value and the publisher travel on separate contexts. The publisher's context value is
 * a function that never changes identity, so a component that only publishes - the form - is not
 * re-rendered when the value it published comes back round; and the value's context is the bare
 * `SelectedFreight | null`, so there is no per-render object to keep stable. One combined
 * `{ value, publish }` object would have needed exactly that, for no gain to either side.
 *
 * THE EQUALITY GUARD IS LOAD-BEARING
 * `<ShippingEtaProvider>` republishes the dispatch countdown every 250 ms and `<CartProvider>` builds
 * a fresh context value each time it does (AAP 0.8.2 defect 2), so the checkout form re-renders
 * roughly four times a second while it is merely sitting on screen. The form publishes from an
 * effect, and an effect that called `setState` with a fresh object on each of those renders would
 * turn a countdown into a state-update storm across the page. {@link isSameFreight} is therefore
 * consulted before the state is written: a field-wise-equal value is ignored, and the review column
 * re-renders only when the buyer's chosen service or its quoted rate actually changes.
 *
 * NEITHER HOOK THROWS OUTSIDE THE PROVIDER
 * The defaults are inert - no chosen service, and a publisher that does nothing - so a form or a
 * summary placed on a surface that mounts no provider simply shares nothing: the summary prints the
 * freight row as not yet established and the form's publication goes nowhere. That is deliberate and
 * it is the opposite of `@/hooks/useCart`, which throws: a missing cart means a shopper is told their
 * cart is empty when it is not, whereas a missing charge channel means one row of a review says a
 * figure is still to be confirmed, which is true. `@/components/cart/CartTotalsPanel` and
 * `./CheckoutSummaryPanel` are both rendered on surfaces with no provider (the cart drawer, the
 * `/cart` page), and a throwing hook would take those surfaces down.
 *
 * This module renders no element of its own: the provider returns the tree it was given, wrapped only
 * in the two context providers, so the page's own layout classes and DOM structure are untouched.
 */

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

/**
 * The freight the buyer chose, as the form publishes it and the review prints it.
 *
 * The three fields are exactly what the review has to say about the charge - which service was
 * chosen, what it is called on screen, and what it costs - and nothing that would let the two columns
 * disagree: the label is the wording the shipping group prints for that service, and `amountCents` is
 * the rate that group prints beside it, so the freight row under the lines and the chosen radio row
 * always quote one figure.
 *
 * All three come from the same place, and it is the live quote for the destination and shipment in
 * the form's fields rather than the store's list rates. A charge is published only while the store
 * is currently offering that service at that price, so a quote that omits the chosen service - or a
 * shipment with no quote at all - publishes `null` instead, and the review column prints the row as
 * a charge still to be established. That is what keeps this channel from carrying a figure the order
 * would not be charged.
 */
export interface SelectedFreight {
  /** The chosen service's id, as `ShippingOption.id` and as the order's `shippingOptionId`. */
  readonly optionId: string;
  /** The service's wording, as the shipping group prints it - for example `'Standard ground'`. */
  readonly label: string;
  /** The rate quoted for that service and destination, as a whole number of cents. */
  readonly amountCents: number;
}

/** What a publisher does where nothing is listening; see the header's note on the inert defaults. */
function ignoreFreight(): void {
  // Intentionally empty: outside a `<CheckoutChargesProvider>` there is nothing to publish to, and
  // discarding the value is what lets the form render on such a surface unchanged.
}

/**
 * Whether two published freight charges say the same thing.
 *
 * Field-wise rather than by identity, because the publisher is called from an effect that builds a
 * fresh object every time it runs, and the form runs it several times a second (see the header).
 * The first branch settles every combination involving `null`: nothing chosen equals nothing
 * chosen, and nothing chosen never equals a charge.
 *
 * @param current The charge the context is holding.
 * @param next The charge a publisher is offering.
 * @returns True when writing `next` would change nothing a consumer prints.
 */
function isSameFreight(current: SelectedFreight | null, next: SelectedFreight | null): boolean {
  if (current === null || next === null) {
    return current === next;
  }

  return (
    current.optionId === next.optionId &&
    current.label === next.label &&
    current.amountCents === next.amountCents
  );
}

/**
 * The chosen freight charge, or `null` when nothing has been chosen - which is also the value read on
 * a surface that mounts no provider.
 */
const SelectedFreightContext = createContext<SelectedFreight | null>(null);

/**
 * The publisher. Its default discards what it is given, so publishing outside a provider is a no-op
 * rather than a failure; see the header.
 */
const PublishSelectedFreightContext =
  createContext<(freight: SelectedFreight | null) => void>(ignoreFreight);

/** What {@link CheckoutChargesProvider} takes: the subtree the channel is mounted around. */
interface Props {
  /** The columns that publish and read the charge. The provider adds no element around them. */
  children: ReactNode;
}

/**
 * Mounts the charge channel around a checkout page's columns.
 *
 * Place it around every component that publishes or reads the chosen freight - in practice the whole
 * two-column layout - and nothing else: a provider mounted per column would give each column its own
 * value, which is the state of affairs this module exists to end.
 *
 * @example The checkout route, whose two columns are siblings.
 * ```tsx
 * <CheckoutChargesProvider>
 *   <div className="ls-split">
 *     <div className="ls-split-main">
 *       <CheckoutForm shippingOptions={BASELINE_SHIPPING_OPTIONS} />
 *     </div>
 *     <div className="ls-split-side">
 *       <CheckoutSummaryPanel />
 *     </div>
 *   </div>
 * </CheckoutChargesProvider>
 * ```
 */
export function CheckoutChargesProvider({ children }: Props): ReactElement {
  const [freight, setFreight] = useState<SelectedFreight | null>(null);

  /*
   * One stable publisher for the life of the provider. `useCallback` with no dependencies is what
   * makes it stable, and the functional update is what lets the equality guard compare against the
   * value actually held without the publisher having to close over it - a publisher that changed
   * identity whenever the freight changed would re-run the form's publishing effect, which would
   * publish again, on every change.
   */
  const publish = useCallback((next: SelectedFreight | null): void => {
    setFreight((current) => (isSameFreight(current, next) ? current : next));
  }, []);

  return (
    <PublishSelectedFreightContext.Provider value={publish}>
      <SelectedFreightContext.Provider value={freight}>{children}</SelectedFreightContext.Provider>
    </PublishSelectedFreightContext.Provider>
  );
}

/**
 * Reads the publisher for the chosen freight charge.
 *
 * The returned function is stable for as long as the provider is mounted, so it is safe as an effect
 * dependency, and it ignores a value field-wise equal to the one already published. Publish `null`
 * for "nothing chosen", including from a publishing component's cleanup, so a column that goes away
 * does not leave a charge behind it.
 *
 * @returns The publisher, or an inert one outside a `<CheckoutChargesProvider>`.
 */
export function usePublishSelectedFreight(): (freight: SelectedFreight | null) => void {
  return useContext(PublishSelectedFreightContext);
}

/**
 * Reads the chosen freight charge.
 *
 * `null` means no service has been chosen yet - or that the reading component is outside a
 * `<CheckoutChargesProvider>`, which a review column renders as a freight row whose amount is still
 * to be established rather than as a zero.
 *
 * @returns The published charge, or `null`.
 */
export function useSelectedFreight(): SelectedFreight | null {
  return useContext(SelectedFreightContext);
}
