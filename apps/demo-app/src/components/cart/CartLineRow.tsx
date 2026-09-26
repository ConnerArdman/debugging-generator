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
 * THE MUTATIONS REACH THE SERVER, SO THE HANDLERS AWAIT THEM
 * `@/hooks/useCart` publishes `setLineQuantity(lineId, quantity)` and `removeLine(lineId)` as
 * `() => Promise<void>`: `CartProvider` carries each of them to the server as one request against
 * `/api/cart/items` and publishes the cart the server answers with, its line totals and its
 * subtotal included, so the quantity this row shows is the quantity checkout prices the order
 * from. Both handlers are therefore `async` and both `await` the call inside a
 * `try`/`catch`/`finally`, and each success notice is raised after its `await` has returned - a
 * refused change rejects instead, so the `catch` reports it and this row never tells a shopper a
 * quantity was saved that the server did not save. Neither `async` function is
 * handed to a prop directly - the stepper's `onCommit` and the button's `onClick` are both
 * `() => void`, and an `async` function passed straight to one is what `no-misused-promises`
 * exists to catch - so the JSX below calls the handler inside an arrow and discards the promise
 * with `void`, which is sound because the handler settles its own failure rather than letting one
 * escape. The cart's own persistent error wording stays where it belongs, on `cartError` and
 * `syncStatus`, which `./CartLineList.tsx` surfaces for the whole list.
 *
 * `pending` is this row's own report that this row's mutation is in flight, deliberately not the
 * context's `syncStatus`, which is global to the cart and cannot say which line is changing. It
 * dims the row through `data-busy`, announces itself through `aria-busy`, holds the stepper with
 * its `busy` prop and holds the remove button with `disabled`, so those four states cannot drift
 * apart. It covers the request for the whole life of that request: it is set before the call goes
 * out and cleared in `finally` once the provider has settled, whether the cart came back changed
 * or the write was refused, so no failure can strand the row in a busy state it has no way out of.
 *
 * WHAT ACTUALLY STOPS A SECOND WRITE IS THE LATCH, NOT `pending`
 * "The same line cannot be committed twice while the server is still deciding" is `mutating`, a
 * `useRef` boolean that both handlers check and set before they do anything else and clear in
 * their `finally`. It has to be a ref: `pending` is state, and state a handler reads is the value
 * from the render that created it, so two presses dispatched inside one JavaScript task would both
 * read `false` and both proceed - two concurrent writes to one line, the second of which the server
 * answers 404 because the first has already removed it. A ref is written the instant the first
 * press is handled, so the second sees the latch whatever React has or has not committed by then.
 *
 * `pending` and the `disabled` it drives are presentation on top of that: they dim the row, hold
 * the controls and say why, and they are the only thing a shopper can see. They are kept because a
 * held control is the right feedback for a press that will do nothing, not because the guarantee
 * rests on them - React writes `disabled` at commit, tens of milliseconds after the press, and a
 * double-click inside that window is an ordinary thing for a mouse to produce.
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
 * product of the unit price and the quantity - the server recomputes it, and publishes it again,
 * every time a quantity changes - so this row multiplies nothing and divides nothing: a total
 * assembled here would be a second opinion about the amount a shopper is about to be charged.
 *
 * WHERE FOCUS GOES WHEN THE ROW GOES
 * A removal unmounts this `<li>`, and the remove button inside it is usually the element holding
 * focus when that happens - so unless focus is moved first it lands on `<body>`, outside the
 * drawer's `aria-modal` dialog, and a keyboard shopper's next Tab starts from the top of the
 * document. The row therefore resolves a landing place before the mutation goes out and focuses it
 * once the removal has been applied: the next row's remove control, the previous row's, or the
 * enclosing dialog when the list has emptied. `focusTargetForRemoval` below states the rule and
 * the one case that must not move focus at all - a removal provoked while focus sits somewhere
 * else entirely.
 *
 * WHAT IT HOLDS
 * Beyond the two context reads at the top of the component - the cart and the toast centre - the
 * hooks are local `useState` for `pending` and two `useRef`s: the `<li>` element, which the focus
 * recovery above needs, and the in-flight latch the section before it describes. No effect, so
 * everything the row renders is a function of the `line` it is given and of `pending`.
 *
 * The two DOM readings this file does make - `document.activeElement` and the walk from the row to
 * its siblings - happen inside the remove handler, after mount and in response to a press, never
 * while rendering. Nothing here reads a clock, a random source or `window`, and nothing schedules
 * a timer, so the markup the server renders and the markup the browser first produces agree and
 * the cart raises no hydration warning to explain away.
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
import { useRef, useState, type ReactElement } from 'react';

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
 * How a row's remove control is found again once its own row is about to disappear.
 *
 * A removal unmounts the `<li>` the pressed button lives in, and a button that is removed while it
 * holds focus leaves focus on `<body>` - outside the drawer's `aria-modal` dialog, so a keyboard
 * shopper loses their place and their next Tab starts from the top of the document. Recovering
 * means focusing a neighbouring row's remove control, which means being able to identify one, and
 * an attribute is the way to do that: the control is `../ui/Button`, whose class comes from that
 * module's stylesheet and is a hashed CSS-Module name this file must not select on, and the
 * accessible name is per-product text. The attribute is written on the element below and read back
 * only through this selector, so the two cannot drift apart.
 */
const REMOVE_CONTROL_SELECTOR = '[data-line-remove]';

/**
 * The enclosing modal surface, when the row is being rendered inside one.
 *
 * The drawer's sheet carries `role="dialog"` and `tabIndex={-1}`, so it can hold focus itself; it
 * is the right landing place when a removal empties the list and there is no neighbouring row to
 * move to. On `/cart` and on the checkout review there is no such ancestor, and that is a state
 * with a meaning of its own rather than a gap - see {@link focusTargetForRemoval}.
 */
const DIALOG_SELECTOR = '[role="dialog"]';

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
 * Where focus should go when `row` is removed from the cart, or `null` for "leave focus alone".
 *
 * Module-level, and apart from the one `document.activeElement` reading it is built around it does
 * nothing but walk the element it is handed, so the rule can be read in one place: a removal moves
 * focus only when focus is inside the row being removed. A removal provoked from anywhere else -
 * another surface writing to the same cart, a quantity commit elsewhere on the page - must not
 * steal focus from whatever the shopper is actually using, and answering `null` for that case is
 * how this says so.
 *
 * The order of preference is the one a list gives: the next row's remove control, so repeated
 * removals walk down the list the way repeated presses of the same button would; the previous row's
 * when the removed row was last; and the enclosing dialog when the row was the only one left. On a
 * page there is no dialog to fall back to, and an emptied list has no control left to hold focus:
 * the answer is `null`, because inventing a tab stop for a list that no longer exists is worse than
 * letting the browser put focus where it puts it.
 *
 * It must be called BEFORE the mutation goes out, while the row and its siblings are still in the
 * document. The element it answers is a surviving sibling (the list keys rows by line id, so the
 * rows that stay keep their DOM identity) or an ancestor, never the row itself, which is why the
 * answer is still usable once the removal has been applied. The caller re-checks `isConnected`
 * anyway, because a cart republished from elsewhere may have taken that neighbour too.
 */
function focusTargetForRemoval(row: HTMLLIElement | null): HTMLElement | null {
  if (row === null) {
    return null;
  }

  const focused = document.activeElement;

  if (!(focused instanceof HTMLElement) || !row.contains(focused)) {
    return null;
  }

  return (
    row.nextElementSibling?.querySelector<HTMLElement>(REMOVE_CONTROL_SELECTOR) ??
    row.previousElementSibling?.querySelector<HTMLElement>(REMOVE_CONTROL_SELECTOR) ??
    row.closest<HTMLElement>(DIALOG_SELECTOR)
  );
}

/**
 * Props of `CartLineRow`, local to this file. A caller that needs this shape reads it back with
 * `ComponentProps<typeof CartLineRow>`.
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

  // The `<li>` this component renders, needed by `focusTargetForRemoval` to find the neighbour that
  // should hold focus once this row is gone. Read only from an event handler, never while
  // rendering.
  const rowRef = useRef<HTMLLIElement | null>(null);

  // The in-flight latch (see the header). One latch for both mutations rather than one each: they
  // write the same line through the same endpoint, and a quantity commit racing a removal of the
  // row that quantity belongs to is the same lost race as two removals. It is deliberately not
  // state - nothing renders from it, and a render is precisely what it cannot afford to wait for.
  const mutating = useRef(false);

  /**
   * Accept the quantity the stepper asked for.
   *
   * The stepper has already clamped it to a whole number inside the line's permitted range and
   * never asks for 0 - emptying a line is the remove button's job - so there is nothing left to
   * validate here and the request goes straight to the cart.
   *
   * The latch is taken first, before the `setPending` that only makes it visible: a commit that
   * arrives while this line is already being written - a second press of a stepper button inside
   * one task, or a blur that commits as a button press is still in flight - is dropped rather than
   * queued, because the quantity it carries was read from a cart the server is in the middle of
   * replacing.
   */
  async function handleQuantityCommit(quantity: number): Promise<void> {
    if (mutating.current) {
      return;
    }

    mutating.current = true;
    setPending(true);

    try {
      await setLineQuantity(line.id, quantity);
      showToast({
        tone: 'success',
        title: QUANTITY_SAVED_TITLE,
        body: `${line.name} \u00d7 ${formatQuantityLabel(quantity)}`,
      });
    } catch (cause) {
      showToast(cartFailureNotice(QUANTITY_FAILED_TITLE, cause));
    } finally {
      setPending(false);
      mutating.current = false;
    }
  }

  /**
   * Take this line out of the cart, and take focus somewhere it can still be used.
   *
   * The landing place is resolved first, while this row and its siblings are all still in the
   * document (see {@link focusTargetForRemoval}), and focus is moved only once the removal has
   * actually been applied: a refused removal leaves the row - and the button the shopper pressed -
   * exactly where they were, and moving focus off a control that is still there would be a second
   * surprise on top of the failure. `isConnected` is re-checked at that point because the cart is
   * republished by the provider between those two moments and may have taken the neighbour as well.
   *
   * The latch is taken before anything else here too, and it is the same one the quantity commit
   * takes. It is set synchronously on the first press, so a second press before the removal
   * settles is ignored rather than sending a second removal for a line the first has already taken
   * out - which the server would answer 404, reported as a failure of a removal the shopper watched
   * succeed.
   */
  async function handleLineRemove(): Promise<void> {
    if (mutating.current) {
      return;
    }

    mutating.current = true;
    setPending(true);

    const focusTarget = focusTargetForRemoval(rowRef.current);

    try {
      await removeLine(line.id);

      if (focusTarget !== null && focusTarget.isConnected) {
        focusTarget.focus();
      }

      showToast({ tone: 'success', title: LINE_REMOVED_TITLE, body: line.name });
    } catch (cause) {
      showToast(cartFailureNotice(LINE_REMOVE_FAILED_TITLE, cause));
    } finally {
      setPending(false);
      mutating.current = false;
    }
  }

  return (
    <li
      ref={rowRef}
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
          onCommit={(next) => {
            void handleQuantityCommit(next);
          }}
        />
      </div>

      <div className={styles.total}>
        <VisuallyHidden>{LINE_TOTAL_LABEL}</VisuallyHidden>
        <Price cents={line.lineTotalCents} size="md" />
      </div>

      <div className={styles.remove}>
        <Button
          variant="ghost"
          size="sm"
          // How a neighbouring row finds this control when its own row is removed. `Button`
          // extends the native element's props, so the attribute reaches the `<button>` untouched
          // and is never read as anything else; it carries no value because its presence is the
          // whole of what `REMOVE_CONTROL_SELECTOR` asks about.
          data-line-remove=""
          onClick={() => {
            void handleLineRemove();
          }}
          // Unavailable while the removal is in flight, stated as ARIA rather than as the native
          // attribute, because this control is the one the shopper is standing on when it becomes
          // unavailable. A `disabled` element cannot hold focus, so writing the native attribute
          // here would move focus to `<body>` the moment the request starts - outside the drawer's
          // `aria-modal` dialog, which is the one place focus must never go - and a refused removal
          // would leave it there, since focus is deliberately not moved when a removal is refused.
          // `aria-disabled` says exactly the same thing to assistive technology and picks up the
          // same dimming and `not-allowed` cursor from the primitive's stylesheet, which
          // declares `[aria-disabled='true']` beside `:disabled`, and it additionally takes
          // `pointer-events` away, so a second mouse press cannot land. `Button` spreads `aria-*`
          // through to the element as its documented escape hatch for finer ARIA than its boolean.
          //
          // What stops a second *keyboard* press - the one route still reaching this handler - is
          // `mutating`, the synchronous latch the handler takes before anything else. That latch,
          // not this attribute, is what makes the guard sound: the attribute is only ever written
          // during a React commit, which is too late to stop two presses inside one task.
          aria-disabled={pending ? 'true' : undefined}
        >
          <span aria-hidden="true">{REMOVE_GLYPH}</span>
          <VisuallyHidden>{`Remove ${line.name} from cart`}</VisuallyHidden>
        </Button>
      </div>
    </li>
  );
}
