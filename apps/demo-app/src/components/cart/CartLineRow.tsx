'use client';

/*
 * CartLineRow - one line of the cart, and the two mutations that line owns.
 *
 * `./CartLineList.tsx` renders the `<ul>` and one of these per line; this file renders the `<li>`
 * and everything inside it: the thumbnail, the product name as a link to its page, the product
 * code, the unit price, the quantity control, the line total and the remove button. It is the row
 * that owns the cart mutations - `./QuantityStepper.tsx` is controlled and presentational and
 * reports a requested quantity, and the remove button has no meaning anywhere else - which is why
 * the two handlers, and the busy flag they set, live here and nowhere above or below.
 *
 * THE MUTATIONS ARE SYNCHRONOUS, SO THE HANDLERS ARE TOO
 * `@/hooks/useCart` publishes `setLineQuantity(lineId, quantity)` and `removeLine(lineId)` as
 * `() => void`: `CartProvider` applies both to the cart it already holds, with no request in
 * between (the storefront's browser client reads the cart and adds to it, and publishes no route
 * for either of these). Both are therefore called in a plain `try`/`catch`, and neither is
 * awaited - `await` on a value that is not a promise is what `await-thenable` exists to catch,
 * and an `async` function handed straight to `onClick` is what `no-misused-promises` exists to
 * catch. A throw is still handled rather than assumed away: it would mean a defect in the
 * provider, and this row reports that as a notice a shopper can read instead of an interaction
 * that silently did nothing. The cart's own persistent error wording stays where it belongs, on
 * `cartError` and `syncStatus`, which `./CartLineList.tsx` surfaces for the whole list.
 *
 * `pending` is this row's own report that this row's mutation is in flight, deliberately not the
 * context's `syncStatus`, which is global to the cart and cannot say which line is changing. It
 * dims the row through `data-busy`, announces itself through `aria-busy`, holds the stepper with
 * its `busy` prop and holds the remove button with `disabled`, so those four states cannot drift
 * apart. Because the provider settles inside the same React batch today, the flag opens and closes
 * without a paint - which is the honest reading of a synchronous mutation, and it is cleared in
 * `finally` so a provider that drops a call (a cart it has not loaded yet) can never strand the
 * row in a busy state it has no way out of.
 *
 * WHY THERE IS NO STOCK BADGE
 * `.meta` was drawn wide enough for an availability chip beside the unit price, and the cart's own
 * contract cannot fill it: `CartLine` in `@/lib/types` publishes `id`, `productId`, `sku`, `slug`,
 * `name`, `imageUrl`, `quantity`, `unitPriceCents` and `lineTotalCents`, and no stock state and no
 * available count at all. Availability belongs to `ProductSummary`, which reaches
 * `../product/StockBadge.tsx` on the pages that hold one. Deriving a state here - treating a line
 * that exists as a product in stock - would print a fact the server never asserted, and reading
 * one would mean a request this row must not make, so the cell carries the unit price alone. The
 * same contract is why the stepper gets no `max`: with no available count to cap a line at, its
 * own ceiling is the right one to apply.
 *
 * MONEY IS NEVER FORMATTED OR MULTIPLIED HERE
 * `../ui/Price` takes integer cents and is the application's only monetary formatter, so both
 * figures are passed through as the cents they arrive as. `lineTotalCents` is the server's own
 * product of the unit price and the quantity - `CartProvider` recomputes it the same way when a
 * quantity changes - so this row multiplies nothing and divides nothing: a total assembled here
 * would be a second opinion about the amount a shopper is about to be charged.
 *
 * NO MEMOIZATION, DELIBERATELY
 * No memoization of any kind - no component wrapper, no cached derivation, no stabilised handler,
 * no selector and no equality guard - so the handlers below are new functions on every render and
 * this row repaints whenever its list does. `CartProvider` republishes its context value, with
 * fresh callbacks, at `ShippingEtaProvider`'s 250 ms cadence, so it re-renders about four times a
 * second while the cart is open. That is AAP 0.8.2's second seeded defect propagating through
 * exactly this path, and it is the behaviour the tool under development exists to find and
 * explain; damping it in one row would hide the symptom rather than fix its cause. Local
 * `useState` for `pending` is the only hook in the file.
 *
 * Nothing here reads a clock, a random source, `window` or `document`, and nothing schedules a
 * timer, so the markup the server renders and the markup the browser first produces agree and a
 * capture of a cart interaction records no hydration warning to explain away.
 *
 * APPEARANCE AND NAMES
 * `./CartLineRow.module.css` owns every value: the five grid areas of the wide row, the two-line
 * fold its container query applies inside the drawer, the thumbnail's frame and the dimming keyed
 * off `data-busy`. All ten of the classes it exports are used below, composed with `clsx`, and
 * nothing is set with an inline style. The controls' own chrome and the single focus ring the
 * storefront draws belong to `../ui/Button` and the stepper, so no `tabIndex` is set here and no
 * focus style is suppressed: every control in the row is reachable and operable by keyboard in
 * DOM order. The remove button paints a glyph, which is `aria-hidden`, and takes its accessible
 * name from real text through `../ui/VisuallyHidden` - a screen reader hears "Remove <product>
 * from cart", never "times" - and the two bare figures are introduced the same way, so neither is
 * announced as a number with nothing to attach it to.
 */

import clsx from 'clsx';
import Link from 'next/link';
import { useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/Button';
import { Price } from '@/components/ui/Price';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import { useCart } from '@/hooks/useCart';
import { formatQuantityLabel, formatSkuLabel } from '@/lib/format';
import type { CartLine } from '@/lib/types';
import { useToastCenter, type ToastInput } from '@/providers/ToastProvider';

import { QuantityStepper } from './QuantityStepper';
import styles from './CartLineRow.module.css';

/**
 * The drawing shown for a line whose product has no artwork of its own, which is most of the
 * catalog: `apps/demo-app/public/products/` holds a handful of pictures and the seed creates far
 * more products than that.
 *
 * A literal path into `public/`, never a static asset import: that form is typed by the ambient
 * declarations Next.js generates into the git-ignored `next-env.d.ts`, so a clean clone that has
 * never run a build would fail `pnpm typecheck` on it. It shares its intrinsic 400 x 300 with the
 * rest of the product artwork, so the thumbnail's reserved box fits either source.
 */
const PLACEHOLDER_IMAGE = '/products/product-placeholder.svg';

/** Where a product's own page lives. The line's `slug` is what identifies it there. */
const PRODUCT_PATH_PREFIX = '/products';

/** Wording for an accepted quantity change. The body names the line, since the cart holds many. */
const QUANTITY_SAVED_TITLE = 'Quantity updated';

/** Wording when a quantity change was not applied. */
const QUANTITY_FAILED_TITLE = 'Quantity could not be changed';

/** Wording for an accepted removal. */
const LINE_REMOVED_TITLE = 'Removed from cart';

/** Wording when a removal was not applied. */
const LINE_REMOVE_FAILED_TITLE = 'Item could not be removed';

/** Introduces the small figure under the product code, which is the price of a single unit. */
const UNIT_PRICE_LABEL = 'Unit price';

/** Introduces the figure in the row's own column: the unit price taken `quantity` times. */
const LINE_TOTAL_LABEL = 'Line total';

/**
 * The remove button's glyph. A multiplication sign rather than the letter x or an SVG: it is the
 * dismissal mark the rest of the storefront uses, it needs no asset, and it is `aria-hidden` below
 * so it is never read out in place of the button's real name.
 */
const REMOVE_GLYPH = '\u00d7';

/**
 * The thumbnail's intrinsic width and height in pixels, written as attributes so the browser
 * reserves the box before the file arrives and the cart does not jump as thumbnails decode. Every
 * drawing in `public/products/` is authored at this size, placeholder included; the stylesheet
 * then scales the element down to the grid's first column.
 */
const IMAGE_WIDTH = 400;
const IMAGE_HEIGHT = 300;

/**
 * A notice for a mutation that threw, carrying the cause's own wording when it has some.
 *
 * Module-level and pure, so the two handlers below report a failure the same way and the shape can
 * be reasoned about without a component in hand. The body is attached only when there is something
 * to attach: `ToastInput.body` is `body?: string` and this workspace compiles with
 * `exactOptionalPropertyTypes`, under which a `body: undefined` is a type error rather than an
 * absent key - and a notice with an empty second line reads worse than one without it either way.
 * Only `Error.message` is ever forwarded; an object, a stack or a raw rejection value is not
 * something to put in front of a shopper, so anything else falls back to the title alone.
 */
function cartFailureNotice(title: string, cause: unknown): ToastInput {
  const detail = cause instanceof Error ? cause.message.trim() : '';

  return detail.length > 0 ? { tone: 'danger', title, body: detail } : { tone: 'danger', title };
}

/**
 * Props of `CartLineRow`, intentionally local and unexported, like every other props type in this
 * workspace: `packages/panel-renderer` publishes its own component catalog and this repository's
 * hardcoding guard harvests this workspace's multi-token identifiers into a policy no product file
 * may then contain, so this file puts exactly one new name - `CartLineRow` - into circulation. A
 * caller that needs this shape reads it back with `ComponentProps<typeof CartLineRow>`.
 */
interface Props {
  /**
   * The line to render, as the server captured it. Authoritative in every respect: the quantity it
   * states is what the stepper shows, and `lineTotalCents` is the amount this row prints.
   */
  line: CartLine;

  /**
   * An extra class from the placing list, for a position or a margin a row cannot know about. It is
   * composed after the base class, so it wins on equal specificity.
   *
   * Spelled `| undefined` because the workspace compiles with `exactOptionalPropertyTypes`: a bare
   * `className?: string` would reject the present-but-undefined value a caller holds, since a CSS
   * Module lookup is typed `string | undefined` under `noUncheckedIndexedAccess` and the caller
   * pattern is exactly `className={styles.someRow}`.
   */
  className?: string | undefined;
}

/**
 * Renders one cart line.
 *
 * @example One line of the drawer's list. The row takes the line and nothing else; the quantity
 * and remove mutations it performs are read from the cart provider, not passed in.
 * ```tsx
 * <ul>
 *   {lines.map((line) => (
 *     <CartLineRow key={line.id} line={line} />
 *   ))}
 * </ul>
 * ```
 */
export function CartLineRow({ line, className }: Props): ReactElement {
  const { setLineQuantity, removeLine } = useCart();
  const { showToast } = useToastCenter();

  // This row's own mutation state. See the header: it is not derived from the context's global
  // `syncStatus`, which cannot say which line is changing, and it is not lifted anywhere either.
  const [pending, setPending] = useState(false);

  /**
   * Accept the quantity the stepper asked for.
   *
   * The stepper has already clamped it to a whole number inside the line's permitted range and
   * never asks for 0 - emptying a line is the remove button's job - so there is nothing left to
   * validate here and the request goes straight to the cart.
   */
  function handleQuantityCommit(quantity: number): void {
    setPending(true);

    try {
      setLineQuantity(line.id, quantity);
      showToast({
        tone: 'success',
        title: QUANTITY_SAVED_TITLE,
        body: `${line.name} \u00d7 ${formatQuantityLabel(quantity)}`,
      });
    } catch (cause) {
      showToast(cartFailureNotice(QUANTITY_FAILED_TITLE, cause));
    } finally {
      setPending(false);
    }
  }

  /** Take this line out of the cart. */
  function handleLineRemove(): void {
    setPending(true);

    try {
      removeLine(line.id);
      showToast({ tone: 'success', title: LINE_REMOVED_TITLE, body: line.name });
    } catch (cause) {
      showToast(cartFailureNotice(LINE_REMOVE_FAILED_TITLE, cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <li
      className={clsx(styles.root, className)}
      data-busy={pending ? 'true' : undefined}
      aria-busy={pending}
    >
      <div className={styles.media}>
        {/*
         * Decorative, so `alt` is empty: the product's name is the next thing in the row as real
         * text and as the link to its page, and a thumbnail that repeated it would be read out
         * twice. The fill behind a transparent or missing drawing belongs to the stylesheet.
         */}
        <img
          className={styles.image}
          src={line.imageUrl ?? PLACEHOLDER_IMAGE}
          alt=""
          width={IMAGE_WIDTH}
          height={IMAGE_HEIGHT}
          loading="lazy"
          decoding="async"
        />
      </div>

      <div className={styles.details}>
        <Link className={styles.name} href={`${PRODUCT_PATH_PREFIX}/${line.slug}`}>
          {line.name}
        </Link>
        <span className={styles.sku}>{formatSkuLabel(line.sku)}</span>
        <div className={styles.meta}>
          <VisuallyHidden>{UNIT_PRICE_LABEL}</VisuallyHidden>
          <Price cents={line.unitPriceCents} size="sm" tone="muted" />
        </div>
      </div>

      <div className={styles.controls}>
        <QuantityStepper
          lineId={line.id}
          quantity={line.quantity}
          busy={pending}
          itemLabel={line.name}
          onCommit={handleQuantityCommit}
        />
      </div>

      <div className={styles.total}>
        <VisuallyHidden>{LINE_TOTAL_LABEL}</VisuallyHidden>
        <Price cents={line.lineTotalCents} size="md" />
      </div>

      <div className={styles.remove}>
        <Button variant="ghost" size="sm" onClick={handleLineRemove} disabled={pending}>
          <span aria-hidden="true">{REMOVE_GLYPH}</span>
          <VisuallyHidden>{`Remove ${line.name} from cart`}</VisuallyHidden>
        </Button>
      </div>
    </li>
  );
}
