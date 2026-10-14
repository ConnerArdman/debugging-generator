'use client';

/*
 * CartPageActions - the two ways on from the cart's own page, and the one of them that depends on
 * there being a cart to check out.
 *
 * `app/cart/page.tsx` renders this inside its `.ls-actions` row. The page cannot make either of
 * these decisions itself: it is a server component with no access to the cart, whose contents
 * belong to the provider `app/layout.tsx` mounts, so the question "is there anything to check out"
 * can only be answered here, one layer down, by the same hook every other cart surface reads.
 *
 * CHECKOUT IS OFFERED ONLY FOR A CART THAT HOLDS SOMETHING
 * The condition is `contentsKnown && !isCartEmpty`, which is the condition `./CartDrawer` puts on
 * its whole footer, restated here rather than reinvented: one cart must not be answered two ways
 * by two surfaces quoting it. So a cart nobody has read yet offers no checkout - there is nothing
 * to say it would carry - a cart that came back empty offers none either, and the route is offered
 * the moment the cart is known to hold a line. The way back to the catalog is offered in every one
 * of those states, because a reader who cannot go forward still has somewhere to go, and it is the
 * action the empty block beside it ("Browse the catalog to add items.") is already pointing at.
 *
 * Absent rather than dimmed: the drawer removes the affordance for this state, and a dimmed
 * `aria-disabled` link here would be a third answer about the same cart - offered, but not really.
 * Nothing is gated on a figure this component derived; `contentsKnown` and `isCartEmpty` are read
 * from `@/hooks/useCartSummary` exactly as published.
 *
 * THE APPEARANCE IS THE BUTTON'S OWN, NOT A SECOND SET OF VALUES
 * An action that navigates is an anchor, so these are `next/link` anchors and not `../ui/Button`
 * controls wrapped in one - nesting the two would announce each destination twice and put an
 * interactive element inside an interactive element. What they carry instead is the button's
 * stylesheet: `../ui/Button.module.css`'s `.root` with `data-variant` and `data-size`, which is
 * the one place the storefront's control geometry, palette, hover, focus and press treatments are
 * declared. That file resets the underline and the inline display precisely so a link wearing this
 * class matches a control, and it carries an `[aria-disabled='true']` rule for the state an anchor
 * has no `:disabled` for. Reading it here rather than restating it in a module of this component's
 * own is what keeps the cart's primary action identical to the catalog's and the product page's: a
 * local copy of the same colours would be a third treatment to keep in step by hand, and the size
 * step or the focus ring would drift the first time one of them changed.
 *
 * `.label` is included for the same reason a control includes it - it is the child that gives way
 * when the row is narrower than the text, so the anchor keeps the control's height instead of
 * wrapping into a taller box.
 *
 * Both anchors take the `lg` step, which is the page's committing action and its counterpart at
 * the same height; the product page's "Add to cart" is the same step, so the storefront's three
 * strongest actions read as one family. No `className` prop is accepted: placement belongs to the
 * `.ls-actions` row this sits in, and a caller that wanted a different appearance would be asking
 * for a different action.
 *
 * NO STATE, NO EFFECT, NO CLOCK
 * There is no state, no effect, no timer and no clock read - the only input is the published
 * summary - so the markup the server produces and the browser's first pass over it agree, and the
 * cart's first read simply resolves into the row without a hydration warning.
 */

import clsx from 'clsx';
import Link from 'next/link';
import type { ReactElement } from 'react';

import buttonStyles from '@/components/ui/Button.module.css';
import { useCartSummary } from '@/hooks/useCartSummary';

/** The way forward, in a buyer's words rather than the router's. */
const CHECKOUT_LABEL = 'Proceed to checkout';

/** Where that leads: the route that chooses a delivery option and places the order. */
const CHECKOUT_HREF = '/checkout';

/** The way back, for a buyer who is still adding to the cart rather than finishing with it. */
const CATALOG_LABEL = 'Continue shopping';

/** Where that leads: the storefront's entry point, which is the catalog. */
const CATALOG_HREF = '/';

/**
 * The size step both actions take, from `../ui/Button.module.css`'s scale.
 *
 * `lg` is the step the product page's add-to-cart control uses, and these are the cart's
 * equivalents, so the three read at one height. Declared once because the two anchors must not
 * differ: a row of one tall action beside one short one reads as a mistake rather than as a
 * hierarchy, which is what the variants are for.
 */
const ACTION_SIZE = 'lg';

/**
 * Renders the row's contents: the checkout action where there is a cart to check out, and the way
 * back to the catalog always.
 *
 * A fragment rather than an element of its own, because the row - its direction, its wrapping and
 * the gap between the two - is `.ls-actions` in `app/globals.css`, which the page puts around this.
 * Returning a container here would nest a second flex box inside that one and take the wrapping
 * away from it.
 *
 * @returns The cart page's actions, as direct children of the row that lays them out.
 *
 * @example The whole of the call site, in `app/cart/page.tsx`.
 * ```tsx
 * <div className="ls-actions">
 *   <CartPageActions />
 * </div>
 * ```
 */
export function CartPageActions(): ReactElement {
  // Unconditional, like every other reading of the cart in this folder: the summary publishes
  // either the cart's totals or the reason it has none, and the branch below is taken on what it
  // says rather than on anything derived here.
  const summary = useCartSummary();

  /*
   * Whether checking out is a thing this cart can do. Both halves matter and neither is redundant:
   * `contentsKnown` excludes a cart still being read and a read that came back a failure, where
   * offering the route would promise something the storefront cannot see; `!isCartEmpty` excludes
   * the cart that was read and holds nothing, where the route has nothing to carry. It is the same
   * expression `./CartDrawer` gates its footer on.
   */
  const checkoutOffered = summary.contentsKnown && !summary.isCartEmpty;

  return (
    <>
      {checkoutOffered ? (
        <Link
          href={CHECKOUT_HREF}
          className={clsx(buttonStyles.root)}
          data-variant="primary"
          data-size={ACTION_SIZE}
        >
          <span className={clsx(buttonStyles.label)}>{CHECKOUT_LABEL}</span>
        </Link>
      ) : null}

      {/* Offered in every state of the cart, and always the quieter of the two treatments: it is
          the alternative to checking out when that is possible, and the only way on when it is
          not, but it is never the action a buyer came to the cart to take. */}
      <Link
        href={CATALOG_HREF}
        className={clsx(buttonStyles.root)}
        data-variant="secondary"
        data-size={ACTION_SIZE}
      >
        <span className={clsx(buttonStyles.label)}>{CATALOG_LABEL}</span>
      </Link>
    </>
  );
}
