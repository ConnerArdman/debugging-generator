'use client';

/*
 * CartTotalsPanel - what the cart comes to, printed the same way wherever it is quoted.
 *
 * Two surfaces render it and neither owns a figure: the cart drawer's footer (`variant="drawer"`,
 * the default, which is the tight form) and the `/cart` page together with the checkout review
 * column (`variant="page"`, the roomy one). All of them get the same rows in the same order - the
 * units in the cart, the merchandise subtotal, one row per charge the placing surface knows about,
 * the closing figure those charges add up to, and the dispatch line carrying the warehouse's
 * cut-off - because a shopper who opens the drawer and then the page must not be quoted two
 * different carts. Freight is stated only where an order is being quoted: a surface quoting a cart
 * names no freight figure and no freight allowance, and says instead that freight and delivery
 * time are quoted at checkout; the last two of the decisions below say why.
 *
 * IT PRINTS NO FIGURE UNTIL THERE IS A CART BEHIND ONE
 * `@/hooks/useCartSummary` publishes either the cart's totals or the reason it has none, and this
 * block renders whichever of the two it is handed. Where the contents are not established - the
 * first read still in flight, or a read that came back a failure - the rows are not rendered at
 * all: a zero in the units row and a subtotal of nothing would each be a claim about a cart the
 * storefront never saw, and the charge rows and closing figure would be a total assembled on a
 * subtotal nobody read. What is printed instead is the state, in
 * words, with placeholder bars holding the rows' space while a read is still in flight; the block
 * keeps its heading, its surface and the dispatch line either way, so the column it sits in
 * neither collapses nor jumps when the figures arrive. The notice a buyer can act on, and the
 * retry with it, belong to `./CartLineList`, which shows them for the same cart wherever these
 * figures are withheld.
 *
 * AND IT PRINTS NONE FOR A CART THAT HOLDS NOTHING
 * The same holds one step further on, where the contents *were* established and there are none:
 * "Items 0" and a subtotal of nothing are two figures about an order nobody is placing. So a
 * cart-quoting surface prints the state in words there too, and keeps only the dispatch line
 * beside it. This is the answer the cart drawer already gives by dropping its footer - totals and
 * both destinations together - for the same state, and one cart must not be answered two ways by
 * the two surfaces quoting it; on the cart's own page the row of actions withholds checkout for
 * exactly the same reading. A surface quoting an order's charges is the exception: it has rows of
 * its own and its own reading of an empty cart, so the figures there stay as that caller
 * assembled them.
 *
 * A failure that arrives *after* a cart has been read is the other case, and it keeps its figures:
 * the provider leaves the contents it last published in place when it refuses a change, so the
 * summary still reports them as established and this block goes on quoting the last figures a
 * buyer saw while the list beside it shows what was refused.
 *
 * EVERY FIGURE ARRIVES ALREADY DERIVED
 * `@/hooks/useCartSummary` is the one place the cart's totals are worked out, and this component
 * reads its `CartSummary` and prints it. Nothing here multiplies, compares or divides cents:
 * `subtotalCents`, `unitCountLabel` and `lineCount` are read as published, so no figure on screen
 * can disagree with the one the header badge and the checkout summary print for the same cart.
 * The one piece of arithmetic in the file is the closing row, which adds the charges a caller
 * passed to the merchandise subtotal in integer cents - a total of figures its caller derived,
 * never a figure derived here. Money goes through `../ui/Price`, which takes integer cents and is
 * the application's only monetary formatter, and the two bare counts go through
 * `formatQuantityLabel`. There is deliberately no `Intl` instance in this file.
 *
 * THE PROP IS AN OVERRIDE, NOT AN ALTERNATIVE
 * The hook is called unconditionally and a `summary` prop, when one is given, replaces its result.
 * That keeps the component usable from a surface that already holds a summary without ever making
 * the hook call conditional - which is what `react-hooks/rules-of-hooks` forbids, and what would
 * break the moment a caller passed the prop on one render and omitted it on the next.
 *
 * NOTHING HERE READS A CLOCK
 * No timestamp is taken, no timer is scheduled and no interval is started. The countdown arrives
 * as `dispatchCountdownMs` - a number the provider read from the clock after it mounted, or `null`
 * before its first reading - so the markup the server produced and the first markup the browser
 * renders always agree and the cart raises no hydration warning. Before that first reading the
 * dispatch line simply carries no countdown - a surface quoting charges prints the delivery
 * estimate its caller supplied, and a surface quoting a cart prints that freight and delivery time
 * are quoted at checkout - which is why nothing here suppresses a hydration warning either. The
 * countdown is folded down to whole minutes as well, so the sentence changes at most once a minute.
 *
 * MARKUP AND APPEARANCE
 * The rows are label-and-value pairs, so they are a `<dl>` with a `<div>` group per row, exactly
 * as `../checkout/OrderConfirmation` and `../product/ProductSpecList` write them; `app/globals.css`
 * resets the list's margins, so the stylesheet here needs no reset of its own. The surface,
 * padding rhythm and optional head slot belong to `../ui/Card`, which this component renders
 * inside and to which a caller's `className` is passed, because a caller's class is placement -
 * the cart drawer's footer and the checkout column both use it that way. Every length, colour and
 * type size lives in `./CartTotalsPanel.module.css`, whose ten classes are all used below; there
 * is no `style` prop. Variants are `data-variant`, read by attribute selectors in that file rather
 * than by looking a class name up.
 *
 * The presentation decisions worth recording, because each looks arbitrary otherwise:
 *
 *   - Heading level follows the variant: `<h2>` on the page, where the block is a section of the
 *     document, and `<h3>` in the drawer, whose dialog already carries the `<h2>`. A caller that
 *     titles the column itself passes its own `heading` text, and a blank one suppresses the head
 *     slot entirely rather than leaving an empty heading in the outline.
 *   - A MERCHANDISE SUBTOTAL AND AN ORDER TOTAL ARE NEVER THE SAME CLAIM, so this block never
 *     prints one figure under both labels. The cart itself has no freight, discount or tax line -
 *     those belong to the order the checkout request creates - so a surface that knows nothing
 *     about them passes no `charges` and gets a single money row, labelled "Merchandise subtotal"
 *     and carrying the closing emphasis: it is the only figure there is, and it says in words what
 *     it is a total of. A surface that does know them - the checkout review column, which reads
 *     the chosen freight charge from `../checkout/CheckoutCharges` - passes them as `charges`, and
 *     then the merchandise figure recedes (muted, one step down), each charge prints its own row,
 *     and the closing row is the sum, labelled "Order total" when every charge is settled and
 *     "Estimated total" while any of them is still to be confirmed. Nothing is ever invented to
 *     fill a row: a charge whose amount is not yet established says so in words, because a zero or
 *     a dash in a money column reads as a figure somebody computed.
 *   - FREIGHT IS A STATEMENT ABOUT AN ORDER, SO A SURFACE QUOTING A CART STATES NONE. What an
 *     order is charged for carriage is the carrier's quote for the destination and the service a
 *     buyer chooses at checkout, and the checkout request charges exactly that quote whatever the
 *     merchandise subtotal comes to - no allowance, threshold or discount on freight is applied
 *     anywhere. A cart has neither a destination nor a service, so any freight figure or freight
 *     promise printed beside it would be a claim no server stands behind: a line in the drawer
 *     promising carriage at no charge is contradicted by the freight the order is charged. So the
 *     merchandise-only surfaces name no freight figure and no allowance, and their dispatch line
 *     says that freight is quoted at checkout; where charges are quoted, what is true of freight
 *     is the freight row the caller passes and the caption the placing surface prints under these
 *     figures.
 *   - AN ARRIVAL ESTIMATE IS A STATEMENT ABOUT A SHIPPING SERVICE, SO IT IS PRINTED ONLY WHERE
 *     CHARGES ARE QUOTED. How long an order takes to arrive depends on the service that carries it
 *     and the destination it is carried to, and a cart has neither: the transit figure its own
 *     reading carries belongs to no service a buyer can choose, and the services quoted for one
 *     destination differ by days. Printed on a surface quoting a cart, that figure contradicts the
 *     service the buyer goes on to pick - "Arrives in 2 days" in the drawer beside a chosen
 *     seven-day freight service. So the merchandise-only surfaces say that freight and delivery
 *     time are quoted at checkout, and the surface quoting charges prints the estimate its caller
 *     supplies through `summary` for the service those charges are quoted for. The dispatch
 *     cut-off is printed on every surface in both readings: it is when the warehouse ships, which
 *     no choice of service changes.
 */

import clsx from 'clsx';
import type { ReactElement, ReactNode } from 'react';

import { Card } from '@/components/ui/Card';
import { Price } from '@/components/ui/Price';
import { Skeleton } from '@/components/ui/Skeleton';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import { useCartSummary, type CartSummary } from '@/hooks/useCartSummary';
import { formatQuantityLabel } from '@/lib/format';

import styles from './CartTotalsPanel.module.css';

/** The head slot's wording when a caller does not name the block itself. */
const DEFAULT_HEADING = 'Order summary';

/** Introduces the cart's unit count: eight of one product and two of another read as ten. */
const ITEMS_LABEL = 'Items';

/**
 * Introduces the merchandise figure: what the lines come to, before anything the order adds.
 *
 * Never "Subtotal" on its own, and never "Total". A bare "Subtotal" leaves a reader to guess what
 * it is a subtotal of, and "Total" over this figure is the claim the cart is not entitled to make -
 * freight, discounts and tax are settled on the order.
 */
const MERCHANDISE_LABEL = 'Merchandise subtotal';

/**
 * Read to assistive technology after {@link MERCHANDISE_LABEL} where that row is also the closing
 * one, because what the figure precedes is then written nowhere on screen: there are no charge
 * rows beneath it to say so.
 */
const MERCHANDISE_READING = 'before freight, discounts and tax';

/** Introduces the closing figure where every charge beneath the merchandise row is settled. */
const ORDER_TOTAL_LABEL = 'Order total';

/** Introduces the closing figure while any charge is still to be confirmed on the order. */
const ESTIMATED_TOTAL_LABEL = 'Estimated total';

/**
 * Read to assistive technology after {@link ESTIMATED_TOTAL_LABEL}: the word "estimated" says that
 * something is missing without saying what, and a buyer reading the figure out is entitled to both.
 */
const ESTIMATED_TOTAL_READING = 'excludes the charges still to be confirmed on the order';

/**
 * What a charge's value column says in place of an amount that is not yet established.
 *
 * Words rather than a zero or a dash: both of those read as a figure somebody worked out, and this
 * row exists precisely to say that nobody has yet.
 */
const PENDING_CHARGE_NOTE = 'Confirmed on the order';

/**
 * Read to assistive technology before the delivery estimate on a surface quoting charges, where
 * the dispatch line opens with the estimate the caller supplied for the service those charges are
 * quoted for. The estimate is printed as `summary` carries it, which can be a bare dash before the
 * dispatch provider's first reading, and would otherwise be announced with nothing to attach it to.
 */
const DELIVERY_READING = 'Delivery estimate:';

/**
 * Opens the dispatch line on a surface quoting a cart, in place of a freight figure and an arrival
 * estimate.
 *
 * A cart has no destination and no shipping service, so no freight charge and no arrival it could
 * state would hold for the service a buyer goes on to choose: checkout charges the carrier's quote
 * for that service and destination, whatever the merchandise comes to. This says where both are
 * given instead, and it is the only thing a cart-quoting surface says about freight. It names
 * itself, so unlike {@link DELIVERY_READING} it carries no hidden prefix.
 */
const DELIVERY_QUOTED_NOTE = 'Freight and delivery time quoted at checkout';

/** Introduces the line count under the units row; see {@link PRODUCT_NOUN}. */
const ACROSS_PREFIX = 'Across';

/** Singular and plural of the line-count noun. A cart of one line holding five units is common. */
const PRODUCT_NOUN = 'product';
const PRODUCT_NOUN_PLURAL = 'products';

/**
 * What the block says in place of its figures while the cart is still being read.
 *
 * A cart nobody has read yet has no units and no subtotal, and a zero printed for either of them
 * would read as a figure somebody established. So the rows are not rendered at all and this
 * sentence stands where they would be, alongside the placeholder bars that hold their space.
 */
const CART_PENDING_NOTE = 'Your cart is being read. Its totals appear here once it has been.';

/**
 * What it says where the read came back a failure and the contents were never established.
 *
 * It states what is missing and why, and nothing about the cart itself - "your cart is empty" is
 * exactly the claim this block must not make for contents nobody could see. The retry belongs to
 * the failure notice `./CartLineList` shows for the same cart, so this line does not offer a
 * second one or name where the first is: both surfaces are driven by the same published failure,
 * so the notice is on screen wherever these figures are withheld.
 */
const CART_UNAVAILABLE_NOTE =
  'Your cart could not be read, so there are no totals to show. They appear here once it has been read.';

/**
 * What it says for a cart that was read and holds nothing.
 *
 * A cart with no lines has no units to count and nothing to subtotal, so those rows are not
 * printed for it either: "Items 0" and "$0.00" are two figures about an order nobody is placing,
 * and the slide-over quoting this same cart prints neither of them - it drops its whole footer. So
 * this surface says what the state is, in one sentence, and points at the thing that would change
 * it.
 */
const CART_EMPTY_NOTE = 'Your cart is empty. Its totals appear here once you add a product.';

/** How many placeholder bars stand in for the rows while the cart is being read. */
const PENDING_ROW_COUNT = 3;

/**
 * Divides the dispatch line's opening - the delivery estimate, or {@link DELIVERY_QUOTED_NOTE} -
 * from the cut-off countdown printed after it.
 */
const NOTE_SEPARATOR = '\u00b7';

/** Opens the cut-off countdown, which follows the line's opening in the same quiet line. */
const CUTOFF_PREFIX = 'next dispatch cut-off in';

/** The countdown's wording inside its final minute, where whole minutes have nothing left to say. */
const CUTOFF_IMMINENT = `${CUTOFF_PREFIX} under a minute`;

/** Units of the countdown. Written out rather than abbreviated to a glyph a reader must decode. */
const HOUR_UNIT = 'h';
const MINUTE_UNIT = 'min';

/** Conversions for {@link dispatchCutoffNote}. The countdown arrives in milliseconds. */
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

/**
 * Wording for the cut-off countdown, or `null` when there is nothing to say about it.
 *
 * Module level and pure: it is a function of the milliseconds it is handed and reads no clock, so
 * the same countdown always yields the same sentence and a server render can produce it as
 * happily as a browser one.
 *
 * `null` covers all three ways the value can carry no countdown - the provider has not read the
 * clock yet (`null`), the cut-off has passed for this reading (`0` or negative), or the figure is
 * not a usable number at all - and the caller then prints the dispatch line's opening on its own
 * rather than a sentence built from a non-finite value.
 *
 * The result is coarse on purpose. Seconds are folded into whole minutes, so the wording changes
 * at most once a minute, and a shopper reading the line is not watching digits flicker while they
 * check a subtotal.
 *
 * @param countdownMs Milliseconds until the next dispatch cut-off, as the cart published them.
 */
function dispatchCutoffNote(countdownMs: number | null): string | null {
  if (countdownMs === null || !Number.isFinite(countdownMs) || countdownMs <= 0) {
    return null;
  }

  const seconds = Math.max(0, Math.floor(countdownMs / MS_PER_SECOND));
  const hours = Math.floor(seconds / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR));
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR;

  if (hours > 0) {
    return `${CUTOFF_PREFIX} ${formatQuantityLabel(hours)} ${HOUR_UNIT} ${formatQuantityLabel(minutes)} ${MINUTE_UNIT}`;
  }

  if (minutes > 0) {
    return `${CUTOFF_PREFIX} ${formatQuantityLabel(minutes)} ${MINUTE_UNIT}`;
  }

  return CUTOFF_IMMINENT;
}

/**
 * One charge a placing surface adds to the merchandise figure.
 *
 * Exported, unlike the props type below, because a caller has to build an array of these: freight,
 * a discount and tax are each assembled from state that surface owns, and a shape it cannot name is
 * a shape it cannot assemble without repeating the literal at every call site.
 *
 * `amountCents` carries the one distinction that matters on a checkout page: a number is an amount
 * this charge is, in integer cents like every monetary field in `@/lib/types`, and `null` means the
 * charge applies to the order but its amount is not established yet - which is a different
 * statement from a charge of nothing, and is printed as words rather than as a figure.
 */
export interface CartCharge {
  /** Stable key for the row. The charge's own name - `'freight'`, `'tax'` - not an array index. */
  readonly id: string;

  /** What the row is called, for example `'Freight'`. Printed as written. */
  readonly label: string;

  /**
   * A quiet qualification beside the label - the chosen service for a freight row, say. Omitted
   * where there is nothing to qualify; it is never used to explain a missing amount, which the row
   * says for itself.
   */
  readonly detail?: string | undefined;

  /** The amount in integer cents, or `null` while it is still to be established. */
  readonly amountCents: number | null;
}

/**
 * Props of `CartTotalsPanel`, intentionally local and unexported, like every other props type in
 * this workspace: a caller that needs the shape reads it back with
 * `ComponentProps<typeof CartTotalsPanel>`. So the file exports two names and no more - the
 * component, and the {@link CartCharge} a caller has to build an array of before it can call it.
 *
 * The optional members spell `| undefined` out because the workspace compiles with
 * `exactOptionalPropertyTypes`, under which `className?: string` means "absent or a string" and
 * rejects the present-but-undefined value every realistic caller holds - a CSS Module lookup is
 * typed `string | undefined` under `noUncheckedIndexedAccess`, and a wrapper forwarding its own
 * optional `variant` or `heading` hands on the same union.
 */
interface Props {
  /**
   * Totals to print instead of the ones this component would read for itself. For a surface that
   * already holds a `CartSummary`; omitted, the cart's own totals are read from the provider.
   */
  summary?: CartSummary | undefined;

  /**
   * What the placing surface adds to the merchandise figure, in the order the rows should be read.
   *
   * Omitted - the cart drawer and the `/cart` page, neither of which knows a destination or a
   * service - the block prints the merchandise subtotal as its single, closing money row, asserts
   * no order total and states no freight figure or arrival estimate. Given, each entry prints a
   * row and the closing row becomes their sum over that subtotal: see {@link CartCharge} for what
   * an unestablished amount means, and the header for why the two arrangements are labelled
   * differently.
   *
   * A caller that quotes charges also supplies, through `summary`, the delivery estimate for the
   * service those charges are quoted for: the dispatch line prints `estimatedDeliveryLabel` only
   * where charges are given, and prints it as that summary carries it.
   *
   * An empty array is the same as omitting it, so a caller assembling charges conditionally needs
   * no branch at the call site.
   */
  charges?: readonly CartCharge[] | undefined;

  /**
   * Which surface is rendering: `drawer` (the default) is the slide-over's short footer, `page`
   * is the `/cart` summary column and the checkout review. It selects the padding step, the type
   * range, the row rhythm and the heading level, and nothing else.
   */
  variant?: 'drawer' | 'page' | undefined;

  /**
   * The block's own heading. Blank or whitespace suppresses the head slot, for a surface that has
   * already titled the column above this block.
   */
  heading?: string | undefined;

  /**
   * An extra class from the placing surface, for the grid position or the stickiness a totals
   * block cannot know about. It reaches `../ui/Card`, which composes it after its own base class,
   * because the card is this component's outermost element.
   */
  className?: string | undefined;
}

/**
 * Renders the cart's totals.
 *
 * @example The drawer's footer and the `/cart` page's summary column: merchandise only, so the
 * subtotal is the closing figure, no order total is claimed, and freight and delivery time are
 * left to checkout.
 * ```tsx
 * <CartTotalsPanel variant="drawer" />
 * <CartTotalsPanel variant="page" className={styles.totals} />
 * ```
 *
 * @example The checkout review column, which knows the chosen freight charge and that service's
 * delivery estimate - carried in `reviewedTotals`, the cart's reading with `estimatedDeliveryLabel`
 * replaced - and knows that the discount and the tax are settled when the order is written.
 * ```tsx
 * <CartTotalsPanel
 *   variant="page"
 *   heading=""
 *   summary={reviewedTotals}
 *   charges={[
 *     { id: 'freight', label: 'Freight', detail: 'Standard ground', amountCents: 1250 },
 *     { id: 'discounts', label: 'Discounts', amountCents: null },
 *     { id: 'tax', label: 'Tax', amountCents: null },
 *   ]}
 * />
 * ```
 */
export function CartTotalsPanel({
  summary,
  charges,
  variant = 'drawer',
  heading,
  className,
}: Props): ReactElement {
  // Unconditional, and overridden by the prop rather than skipped for it - see the header.
  const derived = useCartSummary();
  const totals = summary ?? derived;

  const title = (heading ?? DEFAULT_HEADING).trim();

  // `undefined` rather than an empty element: `../ui/Card` renders neither the head slot nor its
  // divider for an absent head, which is what a surface asking for no heading should get.
  let head: ReactNode;
  if (title.length > 0) {
    head = variant === 'page' ? <h2>{title}</h2> : <h3>{title}</h3>;
  }

  const cutoff = dispatchCutoffNote(totals.dispatchCountdownMs);

  /*
   * The charges as the rows below iterate them, and the questions the block turns on. An absent
   * prop and an empty array are one case on purpose - a caller assembling charges conditionally
   * should not have to branch at the call site - and `hasCharges` is what decides whether the
   * merchandise row is the closing row or the first of several, and which reading the dispatch
   * line gives. Pure derivations of the props, so they are worked out before either early return
   * and read the same way by every arrangement.
   */
  const chargeRows: readonly CartCharge[] = charges ?? [];
  const hasCharges = chargeRows.length > 0;
  const hasPendingCharge = chargeRows.some((charge) => charge.amountCents === null);

  /*
   * The dispatch line, which is the one line that holds in every state of the cart: it is not a
   * property of what a buyer has collected, so it is printed whether or not there are figures to
   * print beside it. Assembled once here and rendered by every arrangement below rather than
   * written more than once.
   *
   * It has two readings, and `hasCharges` chooses between them. A surface quoting charges opens it
   * with the delivery estimate its `summary` carries, which that caller states for the service the
   * charges are quoted for. A surface quoting a cart has no service to state a freight charge or an
   * arrival for, so it opens it with {@link DELIVERY_QUOTED_NOTE} instead; see the header. Both
   * close with the dispatch provider's cut-off, which is the warehouse's and holds whatever service
   * carries the order.
   *
   * The space after the hidden prefix is load-bearing: without it the accessible reading runs the
   * two together, and the clipped span is out of flow, so the character collapses away as leading
   * whitespace rather than indenting the visible line.
   */
  const dispatch = (
    <p className={styles.dispatch}>
      {hasCharges ? (
        <>
          <VisuallyHidden>{DELIVERY_READING}</VisuallyHidden> {totals.estimatedDeliveryLabel}
        </>
      ) : (
        DELIVERY_QUOTED_NOTE
      )}
      {cutoff === null ? null : ` ${NOTE_SEPARATOR} ${cutoff}`}
    </p>
  );

  /*
   * NO FIGURE IS PRINTED FOR A CART NOBODY HAS READ.
   *
   * `@/hooks/useCartSummary` publishes either the cart's totals or the reason it has none, and
   * this is the second of those: the first read is still in flight, or it came back a failure, so
   * what the cart holds was never established. Every row below this point would be an invention -
   * "0 items" and a subtotal of nothing, which together would tell a buyer their cart is empty
   * when the truth is that the storefront cannot see it. The charge rows and the closing figure
   * are equally impossible, because a total assembled on a subtotal nobody read is not a total of
   * anything.
   *
   * So the rows are withheld and the state is stated instead, with the block keeping its heading,
   * its surface and the dispatch line so the column it sits in neither collapses nor jumps when
   * the figures arrive. A failure a buyer can act on is `./CartLineList`'s to show - it carries
   * the notice and the retry for this same cart - and it is deliberately not repeated here.
   *
   * The early return is what makes this safe rather than merely correct today: `totals` is a
   * discriminated union, so the arithmetic and the rows after it cannot be reached, and cannot
   * compile, until the contents are established.
   */
  if (!totals.contentsKnown) {
    return (
      <Card className={className} pad={variant === 'page' ? 'lg' : 'md'} head={head}>
        <div className={styles.root} data-variant={variant}>
          {/* Bars while the read is in flight, so the rows' space is held and the block settles
              rather than jumps when they land; nothing to hold once the read has failed, since
              no figures are coming until a buyer retries it. */}
          {totals.unknownReason === 'loading' ? (
            <Skeleton shape="text" lines={PENDING_ROW_COUNT} />
          ) : null}

          <p className={styles.note}>
            {totals.unknownReason === 'loading' ? CART_PENDING_NOTE : CART_UNAVAILABLE_NOTE}
          </p>

          {dispatch}
        </div>
      </Card>
    );
  }

  /*
   * NOTHING TO TOTAL: A CART THAT WAS READ AND HOLDS NOTHING.
   *
   * The contents are established here - this is not the case above - and what they establish is
   * that there are none. Every row below would then be a figure about an order nobody is placing:
   * a unit count of nought and a subtotal of nothing under a label that says what it comes
   * before. The cart drawer answers this same state by dropping its footer entirely, totals and
   * both destinations together, and one cart quoted two ways by two surfaces is the thing this
   * component exists to prevent. So the rows are withheld and the state is stated instead, with
   * the block keeping its heading, its surface and the dispatch line so the column neither
   * collapses nor jumps when a line is added.
   * No placeholder bars: nothing is in flight, and a bar standing where a figure will never arrive
   * would read as a cart still being counted.
   *
   * Only where this surface is quoting a cart, which is where `charges` is absent. A surface that
   * quotes an order's charges - the checkout review column - has rows of its own to print and its
   * own reading of an empty cart to give, so the figures stay as that caller assembled them and
   * this branch leaves them alone.
   */
  if (totals.isCartEmpty && !hasCharges) {
    return (
      <Card className={className} pad={variant === 'page' ? 'lg' : 'md'} head={head}>
        <div className={styles.root} data-variant={variant}>
          <p className={styles.note}>{CART_EMPTY_NOTE}</p>

          {dispatch}
        </div>
      </Card>
    );
  }

  /*
   * The closing figure: the merchandise subtotal plus every charge whose amount is established, in
   * cents, which is the only arithmetic this component performs on money. A pending charge
   * contributes nothing to the sum and the closing row says so in its label, so the figure is
   * always the floor of what the order comes to rather than a guess at it.
   */
  const closingCents = chargeRows.reduce(
    (running, charge) => running + (charge.amountCents ?? 0),
    totals.subtotalCents,
  );

  return (
    <Card className={className} pad={variant === 'page' ? 'lg' : 'md'} head={head}>
      <div className={styles.root} data-variant={variant}>
        <dl className={styles.rows}>
          <div className={styles.row}>
            <dt className={styles.rowLabel}>{ITEMS_LABEL}</dt>
            <dd className={styles.rowValue}>{totals.unitCountLabel}</dd>
          </div>

          {/* The merchandise figure. With no charges beneath it, it IS the closing row: it takes
              the `.total` treatment and the emphasised size step, and the hidden reading says what
              it comes before, because no row below it does. With charges it recedes to the quiet
              register the closing row is then read against. */}
          <div className={hasCharges ? styles.row : clsx(styles.row, styles.total)}>
            <dt className={styles.rowLabel}>
              {MERCHANDISE_LABEL}
              {hasCharges ? null : (
                <>
                  {' '}
                  <VisuallyHidden>{MERCHANDISE_READING}</VisuallyHidden>
                </>
              )}
            </dt>
            <dd className={styles.rowValue}>
              {hasCharges ? (
                <Price
                  cents={totals.subtotalCents}
                  size={variant === 'page' ? 'md' : 'sm'}
                  tone="muted"
                />
              ) : (
                <Price cents={totals.subtotalCents} size={variant === 'page' ? 'lg' : 'md'} />
              )}
            </dd>
          </div>

          {/* One row per charge, in the order the caller listed them. The key is the charge's own
              id rather than its position, so a freight row that arrives between renders does not
              inherit the identity of the row that was there before it. */}
          {chargeRows.map((charge) => (
            <div key={charge.id} className={styles.row}>
              <dt className={styles.rowLabel}>
                {charge.label}
                {charge.detail === undefined ? null : (
                  <>
                    {' '}
                    <span className={styles.chargeDetail}>{charge.detail}</span>
                  </>
                )}
              </dt>
              <dd className={styles.rowValue}>
                {charge.amountCents === null ? (
                  <span className={styles.chargePending}>{PENDING_CHARGE_NOTE}</span>
                ) : (
                  <Price cents={charge.amountCents} size={variant === 'page' ? 'md' : 'sm'} />
                )}
              </dd>
            </div>
          ))}

          {/* The closing row exists only where charges do: without them the merchandise row above
              is already the closing figure, so the same total is never stated twice. */}
          {hasCharges ? (
            <div className={clsx(styles.row, styles.total)}>
              <dt className={styles.rowLabel}>
                {hasPendingCharge ? (
                  <>
                    {ESTIMATED_TOTAL_LABEL}{' '}
                    <VisuallyHidden>{ESTIMATED_TOTAL_READING}</VisuallyHidden>
                  </>
                ) : (
                  ORDER_TOTAL_LABEL
                )}
              </dt>
              <dd className={styles.rowValue}>
                <Price cents={closingCents} size={variant === 'page' ? 'lg' : 'md'} />
              </dd>
            </div>
          ) : null}
        </dl>

        {/* The line count, printed only when it says something the units row does not: a cart of
            three lines holding twelve units. Equal figures make the note a restatement. */}
        {totals.lineCount === totals.unitCount ? null : (
          <p className={styles.note}>
            {`${ACROSS_PREFIX} ${formatQuantityLabel(totals.lineCount)} ${
              totals.lineCount === 1 ? PRODUCT_NOUN : PRODUCT_NOUN_PLURAL
            }`}
          </p>
        )}

        {/* The same line the no-figures arrangements above print, assembled once beside the
            countdown it reads: its reading turns on whether charges are quoted, never on what a
            buyer has collected. On a surface quoting merchandise alone it is also the only thing
            said about freight - that it is quoted at checkout - because no freight figure or
            allowance printed for a cart would hold for the order checkout goes on to charge. */}
        {dispatch}
      </div>
    </Card>
  );
}
