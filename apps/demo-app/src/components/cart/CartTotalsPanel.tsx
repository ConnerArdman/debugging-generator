'use client';

/*
 * CartTotalsPanel - what the cart comes to, printed the same way wherever it is quoted.
 *
 * Two surfaces render it and neither owns a figure: the cart drawer's footer (`variant="drawer"`,
 * the default, which is the tight form) and the `/cart` page together with the checkout review
 * column (`variant="page"`, the roomy one). Both get the same rows in the same order - the units
 * in the cart, the merchandise subtotal, the closing total, the free-freight state and the
 * dispatch promise - because a shopper who opens the drawer and then the page must not be quoted
 * two different carts.
 *
 * EVERY FIGURE ARRIVES ALREADY DERIVED
 * `@/hooks/useCartSummary` is the one place the cart's totals are worked out, and this component
 * reads its `CartSummary` and prints it. Nothing here sums, multiplies, compares against a
 * threshold or divides cents: `freeFreightRemainingCents`, `freeFreightThresholdCents` and
 * `qualifiesForFreeFreight` are read as published, so the free-freight sentence can never
 * disagree with the state the badge beside it shows. Money goes through `../ui/Price`, which takes
 * integer cents and is the application's only monetary formatter, and the two bare counts go
 * through `formatQuantityLabel`. There is deliberately no `Intl` instance in this file.
 *
 * THE PROP IS AN OVERRIDE, NOT AN ALTERNATIVE
 * The hook is called unconditionally and a `summary` prop, when one is given, replaces its result.
 * That keeps the component usable from a surface that already holds a summary without ever making
 * the hook call conditional - which is what `react-hooks/rules-of-hooks` forbids, and what would
 * break the moment a caller passed the prop on one render and omitted it on the next.
 *
 * IT RE-RENDERS SEVERAL TIMES A SECOND, AND THAT IS THE POINT
 * `<ShippingEtaProvider>` republishes the dispatch countdown every 250 ms and `<CartProvider>`
 * builds a fresh context value each time it does, so `useCartSummary` recomputes and this panel
 * re-renders roughly four times a second for as long as it is mounted. That is the storefront's
 * behaviour under investigation, not a defect in this file: there is no `memo`, no `useMemo`, no
 * `useCallback`, no selector layer and no equality guard anywhere below, and none may be added -
 * the excessive-render acceptance test exists to discover exactly this propagation path.
 *
 * NOTHING HERE READS A CLOCK
 * No timestamp is taken, no timer is scheduled and no interval is started. The countdown arrives
 * as `dispatchCountdownMs` - a number the provider read from the clock after it mounted, or `null`
 * before its first reading - so the markup the server produced and the first markup the browser
 * renders always agree and the cart raises no hydration warning for a capture to record. Before
 * that first reading the panel simply prints `estimatedDeliveryLabel` and no countdown, which is
 * why nothing here suppresses a hydration warning either. The countdown is folded down to whole
 * minutes as well, so the sentence changes once a minute rather than four times a second.
 *
 * MARKUP AND APPEARANCE
 * The rows are label-and-value pairs, so they are a `<dl>` with a `<div>` group per row, exactly
 * as `../checkout/OrderConfirmation` and `../product/ProductSpecList` write them; `app/globals.css`
 * resets the list's margins, so the stylesheet here needs no reset of its own. The surface,
 * padding rhythm and optional head slot belong to `../ui/Card`, which this component renders
 * inside and to which a caller's `className` is passed, because a caller's class is placement -
 * the cart drawer's footer and the checkout column both use it that way. Every length, colour and
 * type size lives in `./CartTotalsPanel.module.css`, whose nine classes are all used below; there
 * is no `style` prop. Variants are `data-variant` and the free-freight state is `data-qualifies`,
 * both read by attribute selectors in that file rather than by looking a class name up.
 *
 * Two presentation decisions worth recording, because both look arbitrary otherwise:
 *
 *   - Heading level follows the variant: `<h2>` on the page, where the block is a section of the
 *     document, and `<h3>` in the drawer, whose dialog already carries the `<h2>`. A caller that
 *     titles the column itself passes its own `heading` text, and a blank one suppresses the head
 *     slot entirely rather than leaving an empty heading in the outline.
 *   - The cart has no tax or freight line of its own - checkout owns both - so the subtotal and
 *     the total print the same amount. The subtotal therefore recedes (muted, one step down) and
 *     the total carries the emphasis, which is the hierarchy `../checkout/OrderConfirmation` uses
 *     for its own breakdown. Inventing a tax or shipping row to make the two differ would put a
 *     figure on the page that no server computed.
 */

import clsx from 'clsx';
import type { ReactElement, ReactNode } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Price } from '@/components/ui/Price';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import { useCartSummary, type CartSummary } from '@/hooks/useCartSummary';
import { formatQuantityLabel } from '@/lib/format';

import styles from './CartTotalsPanel.module.css';

/** The head slot's wording when a caller does not name the block itself. */
const DEFAULT_HEADING = 'Order summary';

/** Introduces the cart's unit count: eight of one product and two of another read as ten. */
const ITEMS_LABEL = 'Items';

/** Introduces the merchandise subtotal, which is the amount before checkout adds anything. */
const SUBTOTAL_LABEL = 'Subtotal';

/** Introduces the closing figure. */
const TOTAL_LABEL = 'Total';

/**
 * Read to assistive technology after {@link TOTAL_LABEL}, because the reason this figure equals
 * the subtotal is not written anywhere on screen: the cart quotes merchandise only.
 */
const TOTAL_READING = 'merchandise only';

/** Names the dispatch line for a reader, since its value can be a bare dash before the first
 * countdown reading arrives and would otherwise be announced with nothing to attach it to. */
const DELIVERY_READING = 'Delivery estimate:';

/** The qualifying state, as the label that carries it rather than as a colour alone. */
const FREE_FREIGHT_BADGE = 'Free freight';

/** Confirms the qualifying state in words beside that label. */
const FREIGHT_EARNED_NOTE = 'This order ships at no freight charge.';

/** Introduces the line count under the units row; see {@link PRODUCT_NOUN}. */
const ACROSS_PREFIX = 'Across';

/** Singular and plural of the line-count noun. A cart of one line holding five units is common. */
const PRODUCT_NOUN = 'product';
const PRODUCT_NOUN_PLURAL = 'products';

/** Divides the dispatch estimate from the cut-off countdown printed after it. */
const NOTE_SEPARATOR = '\u00b7';

/** Opens the cut-off countdown, which follows the dispatch estimate in the same quiet line. */
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
 * not a usable number at all - and the caller then prints the dispatch estimate on its own rather
 * than a sentence built from a non-finite value.
 *
 * The result is coarse on purpose. Seconds are folded into whole minutes, so a panel that
 * re-renders several times a second still prints wording that changes once a minute, and a
 * shopper reading the line is not watching digits flicker while they check a subtotal.
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
 * Props of `CartTotalsPanel`, intentionally local and unexported, like every other props type in
 * this workspace: a caller that needs the shape reads it back with
 * `ComponentProps<typeof CartTotalsPanel>`, so this file puts exactly one new name into
 * circulation.
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
 * @example The drawer's footer and the `/cart` page's summary column.
 * ```tsx
 * <CartTotalsPanel variant="drawer" />
 * <CartTotalsPanel variant="page" className={styles.totals} />
 * ```
 */
export function CartTotalsPanel({
  summary,
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
   * The free-freight line has three readings, and an empty cart needs its own: "add $750.00 for
   * free freight" is a true statement about a cart with nothing in it and a useless one to print,
   * so the threshold is stated as the offer it is instead. The remaining two are the published
   * state - qualifying, which the badge carries in words, and the shortfall, which names both the
   * amount left and the threshold it is measured against.
   */
  let freight: ReactNode;
  if (totals.qualifiesForFreeFreight) {
    freight = (
      <>
        <Badge tone="success" size="sm">
          {FREE_FREIGHT_BADGE}
        </Badge>{' '}
        <span className={styles.rowLabel}>{FREIGHT_EARNED_NOTE}</span>
      </>
    );
  } else if (totals.isCartEmpty) {
    freight = (
      <span className={styles.rowLabel}>
        Orders from <Price cents={totals.freeFreightThresholdCents} size="sm" /> ship at no freight
        charge.
      </span>
    );
  } else {
    freight = (
      <span className={styles.rowLabel}>
        Add <Price cents={totals.freeFreightRemainingCents} size="sm" /> more for free freight on
        orders from <Price cents={totals.freeFreightThresholdCents} size="sm" />.
      </span>
    );
  }

  return (
    <Card className={className} pad={variant === 'page' ? 'lg' : 'md'} head={head}>
      <div className={styles.root} data-variant={variant}>
        <dl className={styles.rows}>
          <div className={styles.row}>
            <dt className={styles.rowLabel}>{ITEMS_LABEL}</dt>
            <dd className={styles.rowValue}>{totals.unitCountLabel}</dd>
          </div>

          <div className={styles.row}>
            <dt className={styles.rowLabel}>{SUBTOTAL_LABEL}</dt>
            <dd className={styles.rowValue}>
              <Price
                cents={totals.subtotalCents}
                size={variant === 'page' ? 'md' : 'sm'}
                tone="muted"
              />
            </dd>
          </div>

          <div className={clsx(styles.row, styles.total)}>
            <dt className={styles.rowLabel}>
              {TOTAL_LABEL} <VisuallyHidden>{TOTAL_READING}</VisuallyHidden>
            </dt>
            <dd className={styles.rowValue}>
              <Price cents={totals.subtotalCents} size={variant === 'page' ? 'lg' : 'md'} />
            </dd>
          </div>
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

        {/* `role="paragraph"` restores what the layout takes away, and is not a duplicate of the
            element's own semantics: this line is laid out as a flex container so the qualifying
            label can sit beside its sentence, and Chromium maps role `paragraph` onto block-flow
            boxes only - measured in the browser, the note and dispatch lines below are exposed as
            paragraphs while this one was ignored, so a reader navigating by paragraph skipped the
            one line that carries the freight state. */}
        <p
          className={styles.freight}
          role="paragraph"
          data-qualifies={totals.qualifiesForFreeFreight ? 'true' : 'false'}
        >
          {freight}
        </p>

        {/* The space after the hidden prefix is load-bearing: without it the accessible reading
            runs the two together, and the clipped span is out of flow, so the character collapses
            away as leading whitespace rather than indenting the visible line. */}
        <p className={styles.dispatch}>
          <VisuallyHidden>{DELIVERY_READING}</VisuallyHidden> {totals.estimatedDeliveryLabel}
          {cutoff === null ? null : ` ${NOTE_SEPARATOR} ${cutoff}`}
        </p>
      </div>
    </Card>
  );
}
