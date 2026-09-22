'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { useEffect, useId, useRef, useSyncExternalStore, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

import { Badge } from '@/components/ui/Badge';
import { BlankSlate } from '@/components/ui/BlankSlate';
import { Button } from '@/components/ui/Button';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import { useCart } from '@/hooks/useCart';
import { formatQuantityLabel } from '@/lib/format';

import { CartLineList } from './CartLineList';
import { CartTotalsPanel } from './CartTotalsPanel';
import styles from './CartDrawer.module.css';

/*
 * CartDrawer - the storefront's cart, as a slide-over dialog, and the one dialog this application
 * has. `SiteNav` says so in its own header: every other dismissible surface here is a disclosure,
 * and the trapping behaviour below is what makes this one different.
 *
 * CONTROLLED, AND OWNING NO TRIGGER
 * Two props, `open` and `onClose`, and nothing else. The header holds the boolean and renders the
 * control that sets it, because the control lives in the bar and the sheet is portalled to the end
 * of the document - one owner for the pair, and no second copy of "is the cart open" for the two to
 * disagree over. There is no internal `isOpen`, no trigger prop and no context of this file's own,
 * so the only way this dialog opens is a caller passing `open`, and the only thing it does about
 * closing is say that it happened.
 *
 * `onClose` is a plain `() => void`, called straight from the handlers below. Nothing here awaits
 * it, so a caller that starts something asynchronous in it keeps that promise to itself and this
 * file has no floating one to answer for.
 *
 * WHAT IT READS
 * `@/hooks/useCart` and nothing else: `lines`, to decide whether there is a total worth footing the
 * sheet with, and `lineCount` for the badge beside the heading. Every mutation stays where its
 * control is - a quantity stepper and a remove button, inside `./CartLineRow.tsx` - so this
 * component changes nothing about the cart and issues no request of its own.
 *
 * PORTAL, AND WHY THE MOUNT IS GATED
 * The sheet is rendered into `document.body` rather than in place, so it escapes the header's
 * stacking and overflow contexts and needs no `z-index` cooperation from its ancestors. That means
 * touching `document`, which does not exist while the server renders, so the portal is reached only
 * once the browser has taken over: `mounted` is `false` on the server AND on the first render in the
 * browser, which is the render React matches against the server's markup. A closed drawer renders
 * nothing at all in either place, an opening one only ever happens after a reader has pressed
 * something, and there is no `suppressHydrationWarning` anywhere - the markup simply agrees.
 *
 * `useSyncExternalStore` rather than `setState` in an effect: the value is read during render and
 * has to differ between the server and the browser, which is the one thing that hook exists for.
 * `active-product-store.ts` uses it in this workspace for the same reason, and an effect that
 * called `setMounted(true)` would be a cascading render this repository's React rules reject.
 *
 * PAGE SCROLLING IS NEVER LOCKED
 * Nothing here writes to the document body's inline style, hides an ancestor's overflow or
 * compensates for a scrollbar width. Taking the page's scrollbar away while the sheet is open moves
 * the whole page behind it, which is precisely the layout shift this storefront must not produce.
 * `CartDrawer.module.css` keeps a scroll gesture from chaining out of the list with
 * `overscroll-behavior: contain` on `.body`, which is the part of that behaviour worth having.
 *
 * DIALOG SEMANTICS
 * `role="dialog"`, `aria-modal="true"`, and an accessible name taken from the visible heading
 * through `aria-labelledby` - not an `aria-label`, so the name a reader hears is the text they can
 * see. The sheet itself is programmatically focusable (`tabIndex={-1}`) and is focused as it opens,
 * which puts a screen reader inside the dialog and gives the keyboard a position to tab from; the
 * element focus came from is remembered and handed back when the sheet goes away, so dismissing the
 * cart returns the reader to the control they opened it with. Tab and Shift+Tab cycle inside the
 * sheet, Escape dismisses it, and a press on the scrim dismisses it.
 *
 * The sheet is the only element in the file that suppresses its focus outline, and
 * `CartDrawer.module.css` does it there for a container that is focused programmatically and is not
 * itself a control. Every control inside keeps the ring the application draws - the two footer
 * anchors from this module, the close control and the rows' own controls from their components.
 *
 * RENDER BEHAVIOUR, LEFT EXACTLY AS IT IS
 * The cart is published by `@/providers/CartProvider`, which rebuilds its context value on every
 * render while the dispatch countdown ticks, so this subtree re-renders several times a second for
 * as long as it is open. That is the storefront's behaviour and not this component's to correct:
 * there is no `memo`, no `useMemo`, no `useCallback`, no selector layer and no equality guard here,
 * and the only short-circuit is the early return that renders nothing while the drawer is closed. A
 * drawer that quietly held still would hide the very thing this repository's tool is built to find.
 *
 * Nothing in this file reads a clock or schedules anything: no interval, no deferred callback and
 * no reading of the current time. The dispatch estimate in the footer is `CartTotalsPanel`'s, read
 * off the cart it is given.
 *
 * CLASS CONTRACT
 * `CartDrawer.module.css` declares nine classes and this component uses all nine - `overlay`,
 * `panel`, `head`, `title`, `close`, `body`, `foot`, `checkoutLink` and `cartLink`. A CSS Module
 * lookup answers `undefined` for a name that is not there rather than failing to compile, so the two
 * files are kept in step by hand. No value is set through an inline `style`, and the empty state's
 * illustration is named to `../ui/BlankSlate` by its `art` key rather than imported as a file, so no
 * asset path appears here at all.
 */

/** The dialog's visible heading, which is also its accessible name. */
const DIALOG_TITLE = 'Your cart';

/**
 * Screen-reader-only continuation of the count badge, so it is announced as "12 lines in your cart"
 * rather than as a bare number beside a heading. Two forms, because "1 lines" is not English; the
 * leading space is part of each string, since the number and this text are separate elements and
 * the announced name is their concatenation.
 */
const COUNT_SUFFIX_ONE = ' line in your cart';
const COUNT_SUFFIX_MANY = ' lines in your cart';

/**
 * The close control: a glyph the eye reads as a dismissal, hidden from assistive technology, plus
 * the words that name the action for a reader who cannot see it. `\u00d7` is the multiplication
 * sign, which is the shape this glyph is - not the letter `x`.
 */
const CLOSE_GLYPH = '\u00d7';
const CLOSE_LABEL = 'Close cart';

/** The footer's two destinations, in the order a reader most often wants them. */
const CHECKOUT_LABEL = 'Checkout';
const VIEW_CART_LABEL = 'View cart';

/** Wording for an empty cart, chosen here because only this surface knows what its heading says. */
const EMPTY_HEADING = 'Your cart is empty';
const EMPTY_BODY = 'Browse the catalog to add items.';
const EMPTY_ART_ALT = 'An empty shopping cart';

/** The keys this dialog answers to, spelled as `KeyboardEvent.key` reports them. */
const CLOSE_KEY = 'Escape';
const CYCLE_KEY = 'Tab';

/**
 * Everything inside the sheet a reader can tab to.
 *
 * Queried against the sheet each time Tab is pressed rather than held from render to render: rows
 * arrive and leave as the cart is edited, the footer appears with the first line and the failure
 * notice brings a retry control with it, so a list captured earlier would trap focus against
 * controls that are no longer there. The `[tabindex="-1"]` exclusion is what keeps the sheet itself
 * - programmatically focusable, never tabbed to - out of its own cycle.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Subscribes a reader of "has the browser taken over" to changes it will never receive.
 *
 * The answer goes from no to yes exactly once, at the hand-off React performs on its own, and never
 * changes again, so there is nothing for this store to publish. It exists because
 * `useSyncExternalStore` requires a subscribe function, and it is declared at module scope so the
 * same function is passed on every render and the hook never re-subscribes.
 */
function subscribeNever(): () => void {
  return ignore;
}

/** The unsubscribe half of {@link subscribeNever}: nothing was ever subscribed to. */
function ignore(): void {
  /* Intentionally empty - see subscribeNever. */
}

/** What the sheet's host answers in the browser, where `document` exists to portal into. */
function readInBrowser(): boolean {
  return true;
}

/**
 * What it answers while the server renders, and on the first render in the browser - the render
 * React reconciles against the server's markup. Both therefore produce nothing, which is what keeps
 * hydration silent, and the portal below is unreachable until React has re-read the value above.
 */
function readOnServer(): boolean {
  return false;
}

/**
 * The dialog's inputs, kept local to this file: nothing outside needs to name this shape, and the
 * repository's hardcoding guard harvests this workspace's declared names into a policy the debugging
 * product may not then use, so a second exported name for "open, and how to close" would spend that
 * vocabulary for nothing.
 */
interface Props {
  /** Whether the sheet is on screen. The caller owns this boolean; this file never sets it. */
  open: boolean;

  /**
   * Called when the reader dismisses the dialog - Escape, the close control, the scrim, or
   * following one of the footer's links. It is the caller's job to turn {@link Props.open} off in
   * response; this component does not assume that it will, and renders whatever it is next given.
   */
  onClose: () => void;
}

/**
 * Renders the cart as a modal slide-over, or nothing at all while it is closed.
 *
 * @example The header owns the boolean and the control that sets it.
 * ```tsx
 * const [cartOpen, setCartOpen] = useState(false);
 *
 * <Button onClick={() => { setCartOpen(true); }}>Cart</Button>
 * <CartDrawer open={cartOpen} onClose={() => { setCartOpen(false); }} />
 * ```
 */
export function CartDrawer(props: Props): ReactElement | null {
  const { open, onClose } = props;

  // The published cart. `lineCount` is the number of lines, which is what this sheet lists and what
  // the badge beside the heading counts; the header's own badge quotes `itemCount` instead.
  const { lines, lineCount } = useCart();

  // Ties `aria-labelledby` on the sheet to the heading inside it. `useId` rather than a counter or a
  // random value: React produces the same id on the server and during hydration, so the reference is
  // valid in the first frame it exists.
  const labelId = useId();

  // The sheet, so it can be focused as it opens and asked for its focusable contents while Tab is
  // being pressed, and the element focus came from, so it can be handed back. Single-token names:
  // the guard described above `Props` harvests every multi-token name this workspace declares, and
  // "the sheet" is what `CartDrawer.module.css` calls this element throughout.
  const sheet = useRef<HTMLDivElement | null>(null);
  const origin = useRef<HTMLElement | null>(null);

  // Whether the browser has taken over from the server; see `readOnServer` above.
  const mounted = useSyncExternalStore(subscribeNever, readInBrowser, readOnServer);

  // `open && mounted` - exactly the condition the early return below renders on, named once so the
  // effects can be gated on the same fact. An effect that ran while the sheet was not in the
  // document would focus a ref holding nothing and listen for a key nothing is waiting for.
  const showing = open && mounted;

  // Focus in on open, and back out on close. One effect for both halves, because the element to
  // return focus to is the one that had it when this effect ran: capturing it anywhere else would
  // either miss it or record the sheet itself.
  useEffect(() => {
    if (!showing) {
      return;
    }

    // `instanceof HTMLElement` rather than a cast: `document.activeElement` is an `Element | null`,
    // and only an HTML element has `focus()`. An SVG element or `null` therefore leaves nothing
    // remembered, and the cleanup below simply does nothing - which is the right outcome, since
    // there is no control to hand the reader back to.
    const active = document.activeElement;
    origin.current = active instanceof HTMLElement ? active : null;

    sheet.current?.focus();

    return () => {
      // Optional chaining, never an assertion: the reference is empty when the drawer was opened
      // from nothing focusable, and an element that has since left the document cannot take focus
      // either - the browser answers both by leaving focus where it is.
      origin.current?.focus();
    };
  }, [showing]);

  // Escape, listened for on the document rather than on the sheet. Focus is inside the sheet while
  // it is open, so bubbling would usually reach a handler here anyway - but "usually" is not a
  // guarantee once a reader has clicked the scrim or a row has removed the control they were on, and
  // a dialog that stops answering Escape because focus slipped is a dialog a keyboard cannot leave.
  useEffect(() => {
    if (!showing) {
      return;
    }

    const dismiss = (event: KeyboardEvent): void => {
      if (event.key === CLOSE_KEY) {
        onClose();
      }
    };

    document.addEventListener('keydown', dismiss);

    return () => {
      document.removeEventListener('keydown', dismiss);
    };

    // `onClose` is a fresh function on every render by design - the header builds it inline - so
    // this effect re-subscribes as often as this subtree renders. That is cheap and correct, and it
    // is deliberately not "fixed" with a ref or a memo: the identity churn is the storefront's
    // behaviour, and hiding it here would hide it from the tool built to observe it.
  }, [showing, onClose]);

  // Nothing is rendered while the drawer is closed, and nothing is rendered before the browser has
  // taken over, so `document.body` below is only ever read where it exists.
  if (!showing) {
    return null;
  }

  return createPortal(
    <div
      className={styles.overlay}
      // The scrim dismisses, the sheet does not. Comparing the target with the element the handler
      // is on is what draws that line: a press anywhere inside the sheet has the sheet, or something
      // in it, as its target and is ignored here. `onBlur` would be the other way to notice a reader
      // leaving, and it would fire every time focus moved between two controls inside the sheet.
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        tabIndex={-1}
        ref={sheet}
        // Tab cycles inside the sheet. The set is read at the moment the key is pressed, for the
        // reasons `FOCUSABLE` gives, and the wrap is applied only at the two ends: everywhere else
        // the browser's own order is already right and preventing it would fight it.
        onKeyDown={(event) => {
          if (event.key !== CYCLE_KEY) {
            return;
          }

          const items = Array.from(sheet.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);

          // Under `noUncheckedIndexedAccess` both lookups are `HTMLElement | undefined`, and both
          // are genuinely absent in one real state: an empty cart whose block offers no control at
          // all. Guarded rather than asserted, and a sheet with nothing to focus simply lets the
          // key through - there is no cycle to hold a reader inside.
          const first = items[0];
          const last = items[items.length - 1];

          if (first === undefined || last === undefined) {
            return;
          }

          const active = document.activeElement;

          if (event.shiftKey) {
            // Backwards off the first control wraps to the last. The sheet itself counts as being
            // at the start: it holds focus in the moment after opening, and Shift+Tab from there
            // would otherwise leave the dialog through the top.
            if (active === first || active === sheet.current) {
              event.preventDefault();
              last.focus();
            }

            return;
          }

          // Forwards off the last control wraps to the first.
          if (active === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className={styles.head}>
          <h2 id={labelId} className={styles.title}>
            {DIALOG_TITLE}
          </h2>

          {/* The count, formatted by the application's own number formatter rather than by an
              `Intl` instance built here, so every figure in the storefront groups its digits the
              same way. */}
          <Badge size="sm">
            {formatQuantityLabel(lineCount)}
            <VisuallyHidden>
              {lineCount === 1 ? COUNT_SUFFIX_ONE : COUNT_SUFFIX_MANY}
            </VisuallyHidden>
          </Badge>

          {/* `.close` is placement only - this control's chrome, its focus ring and its explicit
              `type="button"` are `../ui/Button`'s - and it belongs on the control itself rather
              than on a wrapper, which is what `CartDrawer.module.css` documents and what keeps the
              row's height the button's own. `clsx` is what turns the module's `string | undefined`
              lookup into the definite string `Button` declares under `exactOptionalPropertyTypes`;
              a missing class composes to no class, exactly as passing nothing would. */}
          <Button className={clsx(styles.close)} variant="ghost" size="sm" onClick={onClose}>
            <span aria-hidden="true">{CLOSE_GLYPH}</span>
            <VisuallyHidden>{CLOSE_LABEL}</VisuallyHidden>
          </Button>
        </div>

        {/* The only scrolling region of the sheet. `CartLineList` owns what is shown in it - a
            failure a reader can act on, placeholders while the cart is first read, the empty block,
            or the lines - so none of those states is restated here. The empty block is the one
            thing this surface supplies, because the wording belongs to the surface a reader is
            looking at. */}
        <div className={styles.body}>
          <CartLineList
            variant="drawer"
            emptySlot={
              <BlankSlate art="empty-cart" alt={EMPTY_ART_ALT} heading={EMPTY_HEADING}>
                {EMPTY_BODY}
              </BlankSlate>
            }
          />
        </div>

        {/* Totals and the two ways on, and only once there is a line to total. An explicit ternary
            rather than `&&`: `0` is what a length yields and React would print it. */}
        {lines.length === 0 ? null : (
          <div className={styles.foot}>
            <CartTotalsPanel variant="drawer" />

            {/* Anchors, and no `Button` nested inside them: a link that navigates is an anchor, and
                wrapping one in a control would announce two things and nest interactive elements.
                `CartDrawer.module.css` draws them. Both dismiss the dialog as they are followed, so
                the sheet is not left standing over the page it just sent the reader to. */}
            <Link href="/checkout" className={styles.checkoutLink} onClick={onClose}>
              {CHECKOUT_LABEL}
            </Link>
            <Link href="/cart" className={styles.cartLink} onClick={onClose}>
              {VIEW_CART_LABEL}
            </Link>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
