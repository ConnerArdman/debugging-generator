'use client';

/*
 * CartLineList - the cart's lines, and the states the collection itself can be in.
 *
 * `./CartLineRow.tsx` renders one `<li>` and everything inside it - the thumbnail, the product
 * name, the quantity control, the line total and the remove button. This file renders the `<ul>`
 * around those rows and decides which of four things a shopper should be looking at: a failure they
 * can act on, placeholders while the first read is still in flight, the block that says the cart is
 * empty, or the lines themselves.
 *
 * It is mounted twice in the storefront and the arrangement is the only difference between the two
 * placings: `variant="drawer"` inside the cart panel, whose body row is the one region that
 * scrolls it, and `variant="page"` on `/cart`, where the document scrolls. Neither arrangement
 * scrolls the list itself. Both read the same cart at the same moment, because both read it the
 * same way.
 *
 * THE CART IS READ HERE, NEVER FETCHED
 * `@/hooks/useCart` is the only cart this file knows about. The lines, the two counts and the
 * totals are published by `@/providers/CartProvider`, which owns every request the cart makes
 * against `/api/cart`, so this component issues none: no `fetch`, no API client, no state of its
 * own holding a copy of the lines. `refreshCart()` is the single exception, and it is not a request
 * this file composes - it is the provider's own re-read, asked for by the one control that has a
 * reason to ask, the retry button in the failure notice. That is what keeps the header badge, this
 * list and the checkout summary quoting the same cart: there is one reader and one writer of it.
 *
 * WHICH STATE WINS
 * The four are resolved in a fixed order, and only the first of them is allowed to coexist with
 * another:
 *
 *   1. A failure. `cartError` carries wording the provider has already made fit to show and
 *      `cartErrorTitle` the heading for the operation it belongs to, so both are rendered as given
 *      inside a `danger` `../ui/Alert` - which announces itself assertively -
 *      with a retry control beside it. The list stays rendered underneath whenever there are still
 *      lines in hand: a refused change leaves the previously published cart in place, and replacing
 *      a cart a shopper can still read and still act on with an error screen would lose them work
 *      that was never lost. With no lines in hand it is the only thing on the surface, for the
 *      reason 3 gives.
 *   2. The first read. Placeholder rows, and only while there is nothing else to show - a re-read
 *      over a cart that already has lines keeps those lines on screen rather than blanking them.
 *   3. An empty cart, once it is known to be empty rather than merely unread. A published failure
 *      is the second of those and rules this state out: lines a failed read never returned say
 *      nothing about what the cart holds, so the notice from 1 is shown on its own rather than
 *      over a block telling a shopper their cart is empty on the strength of contents nobody
 *      established.
 *   4. The lines.
 *
 * `syncStatus === 'saving'` is not one of the four. A change being carried to the server is
 * reported on the root through `aria-busy` and in the live region below, and it deliberately
 * neither disables the list nor unmounts a row: a row that vanished while its own quantity was
 * being saved would take the control a shopper was using out from under them, and each row already
 * holds its own control for the duration of its own mutation.
 *
 * WHAT ASSISTIVE TECHNOLOGY IS TOLD
 * `../ui/Skeleton` is `aria-hidden` and has no text, so the placeholders say nothing on their own
 * and the reading of "the cart is being read" has to be written out. One polite live region does
 * that, for both the first read and a save. It stays mounted in every state and carries text only
 * while there is something to say, because a region inserted at the moment its message appears is
 * not reliably announced - the region has to be there first for the change inside it to be a
 * change. Its class takes it out of flow, so an empty one costs no space and a save does not move
 * the list as it starts.
 *
 * The rows are a real `<ul>` of `<li>`s, which is what lets a screen reader say how many lines
 * there are, and nothing here adds a list role, a table role or a tab stop of its own: every
 * control inside a row is focusable in DOM order, with the focus ring the storefront draws in
 * `../ui/Button` and the stepper, and focusing one scrolls the surface's own scroll container to
 * it.
 *
 * APPEARANCE AND NAMES
 * `./CartLineList.module.css` owns every value - the column, the two `data-variant` arrangements,
 * the row container the lines collapse against, the hairline between rows and the placeholder
 * geometry. All eight of the classes it declares are used below and nothing else is: a CSS Module
 * lookup yields `undefined` for a name that does not exist rather than failing to compile, so the
 * two files are kept in step by hand. Nothing is set through an inline style, and the empty
 * state's illustration is named to `../ui/BlankSlate` by its `art` key rather than referenced as a
 * file, so no asset path appears here at all.
 *
 * WHERE FOCUS GOES WHEN THE CONTROL IT WAS ON LEAVES THE LIST
 * Two presses inside this collection take the pressed control out of the document, and a control
 * removed while it holds focus leaves focus on `<body>`, where a keyboard shopper's next Tab starts
 * from the top of the page (WCAG 2.4.3). The root is therefore a landing place of its own: a group
 * named "Cart items", focusable only programmatically (`tabIndex={-1}`, so it is never a stop in
 * the tab order), marked `data-cart-lines` so `./CartLineRow.tsx` can find it, and rendered in
 * every one of the four states, so it is still there whatever the cart turns out to hold.
 *
 *   - Removing the last line: the row moves focus here when it has no neighbouring row to move to
 *     and no dialog around it - the `/cart` page and the checkout review, where the emptied list
 *     leaves no control behind.
 *   - The notice's retry: `refreshCart()` clears the failure the moment the read starts, so the
 *     notice - and the control that was pressed - unmounts before the answer arrives. Focus is
 *     moved here first, while the control is still in the document; if the read fails again the
 *     new notice's retry takes it back, so pressing Enter again is all it takes to retry again,
 *     and if the read succeeds it stays here, on the lines that arrived.
 *
 * Nothing in this file reads a clock, a random source or `window`, and nothing schedules a timer.
 * `document` is read in exactly two places - the retry handler and the effect that settles the
 * retry's focus - both after mount and never while rendering, so the markup the server renders and
 * the markup the browser first produces agree and the cart raises no hydration warning to explain
 * away.
 */

import clsx from 'clsx';

import { useEffect, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { Alert } from '@/components/ui/Alert';
import { BlankSlate } from '@/components/ui/BlankSlate';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import { useCart } from '@/hooks/useCart';
import type { CartLine } from '@/lib/types';

import { CartLineRow } from './CartLineRow';
import styles from './CartLineList.module.css';

/**
 * The failure notice's heading when the cart published none of its own.
 *
 * The heading names what could not be done and the sentence underneath it is the provider's own
 * wording for what went wrong, so the two have to describe the same operation - a change the store
 * refused, reported under a heading about reading the cart, sends a shopper to fix a cart that
 * loaded perfectly and is listed correctly right below the notice. The provider publishes the
 * heading with the wording for exactly that reason and this list prints the one it published; this
 * constant covers the only state with wording but no heading, a read that never answered, and it
 * says what the provider's own read heading says so the two readings never differ.
 */
const ERROR_TITLE = 'Your cart could not be read';

/** The retry control's label. */
const RETRY_LABEL = 'Try again';

/**
 * The accessible name of the collection's root, which is where focus lands when the control it was
 * on leaves the list (see the header). A name rather than a heading: the surfaces placing this list
 * already title it - the drawer's dialog, the cart page's `h1`, the checkout review's heading - and
 * the group only has to say which part of that surface a reader has been moved to.
 */
const CART_LINES_LABEL = 'Cart items';

/** What the live region says while the cart is being read for the first time. */
const LOADING_ANNOUNCEMENT = 'Loading your cart\u2026';

/** What it says while a change is being carried to the server. */
const SAVING_ANNOUNCEMENT = 'Saving changes\u2026';

/** The empty state's heading, and the sentence under it. */
const EMPTY_HEADING = 'Your cart is empty';
const EMPTY_BODY = 'Browse the catalog to add items.';

/**
 * Alternative text for the empty state's illustration, which `../ui/BlankSlate` draws from
 * `public/illustrations/empty-cart.svg`. The caller chooses it because only the caller knows what
 * its own heading says.
 */
const EMPTY_ART_ALT = 'An empty shopping cart';

/**
 * How many placeholder rows stand in for the cart while it is first being read.
 *
 * Three, which reads as a list rather than as a single stray row and is close to the number of
 * lines a cart usually holds. Each one occupies the geometry `./CartLineList.module.css` mirrors
 * from a real row - the same thumbnail track, column gap and block padding - so the list settles
 * rather than jumps when the lines arrive. It does not land to the pixel, and cannot: the
 * remainder is the quantity stepper's own border and text metrics, which belong to that component
 * and are not knowable from here.
 */
const SKELETON_ROW_COUNT = 3;

/**
 * The placeholders' React keys.
 *
 * Fixed strings computed once at module scope rather than the loop's own offsets: a key is a claim
 * about identity, and an index taken from the data would let React reuse a placeholder's box for
 * whichever line happens to land at that offset. These keys belong to no line at all, which is
 * exactly what they are saying.
 */
const SKELETON_ROW_KEYS: readonly string[] = Array.from(
  { length: SKELETON_ROW_COUNT },
  (_unused, index) => `cart-line-placeholder-${index + 1}`,
);

/**
 * The collection's inputs.
 *
 * Local and deliberately not exported, like every other props type in this workspace: a caller that
 * needs the shape writes `ComponentProps<typeof CartLineList>` rather than putting a second name
 * into circulation. The optional fields are spelled `?: T | undefined` because
 * `exactOptionalPropertyTypes` is on here, so a caller may pass a value it is still resolving -
 * including the `string | undefined` a CSS Module lookup is typed as - straight through instead of
 * assembling the element's props conditionally.
 */
interface Props {
  /**
   * Which of the two arrangements `./CartLineList.module.css` declares to use. `drawer` is the
   * compact rhythm, for a panel whose own body row scrolls the list; `page` is a step looser and
   * lets the document do the scrolling. Neither makes the list a scroll container of its own.
   *
   * @default 'drawer'
   */
  variant?: 'drawer' | 'page' | undefined;

  /**
   * What to show in place of the default empty block, for a placing that has something more useful
   * to say than "your cart is empty" - a panel that can offer its own way back to the catalog, for
   * instance. Leave it out and the default block is rendered.
   */
  emptySlot?: ReactNode;

  /** The placing surface's own class, for the geometry a collection cannot know about. */
  className?: string | undefined;
}

/**
 * Renders the cart's lines, or the state the cart is in instead.
 *
 * @example The drawer's body, which is the one scrolling region of that panel.
 * ```tsx
 * <CartLineList variant="drawer" />
 * ```
 *
 * @example The `/cart` page, uncapped, with the page's own wording for an empty cart.
 * ```tsx
 * <CartLineList variant="page" emptySlot={<EmptyCartPanel />} />
 * ```
 */
export function CartLineList({ variant = 'drawer', emptySlot, className }: Props): ReactElement {
  const { lines, syncStatus, cartError, cartErrorTitle, refreshCart } = useCart();

  // The collection's root, which is the landing place for focus described in the header, and the
  // notice's retry control while a notice is on screen (React sets it back to `null` when the
  // notice unmounts). Both are read only from the retry handler and the effect below.
  const cartLinesRegion = useRef<HTMLDivElement | null>(null);
  const cartRetryControl = useRef<HTMLButtonElement | null>(null);

  // Set when a press of the retry control moved focus onto the root, and cleared once the read it
  // started has settled. A ref: nothing renders from it, and the effect below is its only reader.
  const cartRetryFocusPending = useRef(false);

  /*
   * Ask the provider to read the cart again.
   *
   * `refreshCart()` returns a promise, and this is a DOM handler, so the promise is discarded with
   * `void` rather than awaited: an `async` function handed straight to `onClick` is what
   * `no-misused-promises` exists to catch, and an unawaited call without `void` is what
   * `no-floating-promises` catches. Nothing is lost by discarding it - the provider publishes the
   * cart it read and clears or replaces `cartError` on its own, so the outcome of this click
   * arrives as a new render of this component rather than as a value here.
   *
   * Focus is moved onto the root before the read is asked for, and only when it is on the control
   * being pressed: the provider clears the failure as the read starts, which unmounts the notice in
   * the very next commit, and a control removed while focused leaves focus on `<body>`. A press
   * made with focus elsewhere - a pointer press on a control that does not take focus - leaves it
   * where it is.
   */
  const handleRetry = (): void => {
    const region = cartLinesRegion.current;

    if (region !== null && document.activeElement === cartRetryControl.current) {
      region.focus();
      cartRetryFocusPending.current = true;
    }

    void refreshCart();
  };

  /*
   * Settle where the retry left focus, once the read it started has answered.
   *
   * It runs after the commit that publishes the outcome, so the DOM already shows it: a read that
   * failed again has mounted a new notice, and its retry control takes focus back from the root so
   * the next Enter retries again; a read that succeeded leaves focus on the root, around the lines
   * it returned. Nothing is moved unless focus is still on the root where the handler put it - a
   * shopper who has gone on to another control while the read was in flight keeps it. The pending
   * mark is cleared either way, so a later failure published for an unrelated reason never pulls
   * focus onto its notice. `'loading'` is the read still in flight, so it is skipped.
   *
   * Keyed on `syncStatus` alone: every read passes through `'loading'` and out again, and the
   * notice's presence is a function of the state it settles on. No state is written here, so the
   * effect adds no render of its own.
   */
  useEffect(() => {
    if (!cartRetryFocusPending.current || syncStatus === 'loading') {
      return;
    }

    cartRetryFocusPending.current = false;

    if (document.activeElement === cartLinesRegion.current) {
      cartRetryControl.current?.focus();
    }
  }, [syncStatus]);

  /*
   * The one sentence the live region carries, and `null` in the states that have nothing to say.
   * The two it does cover are mutually exclusive readings of the same field, so there is never more
   * than one thing to announce at a time.
   */
  const announcement =
    syncStatus === 'loading'
      ? LOADING_ANNOUNCEMENT
      : syncStatus === 'saving'
        ? SAVING_ANNOUNCEMENT
        : null;

  return (
    /*
      The landing place for focus described in the header: a named group, focusable only
      programmatically, and marked for `./CartLineRow.tsx`'s removal fallback. `data-cart-lines`
      carries no value because its presence is the whole of what that file's selector asks about;
      the two spellings are kept in step by hand, like this file's class contract.
    */
    <div
      ref={cartLinesRegion}
      className={clsx(styles.root, className)}
      data-variant={variant}
      data-cart-lines=""
      role="group"
      aria-label={CART_LINES_LABEL}
      tabIndex={-1}
      aria-busy={syncStatus === 'saving'}
    >
      {/*
        Always rendered, never in flow. See the header: a live region has to exist before its
        content changes for that change to be announced, and `.status` is sized to nothing so an
        empty one neither paints nor takes a row of the grid it sits in.
      */}
      <div className={styles.status} role="status" aria-live="polite">
        {announcement === null ? null : <VisuallyHidden>{announcement}</VisuallyHidden>}
      </div>

      {/*
        State 1. Compared against `null` rather than tested for truthiness, so a failure the
        provider described in an empty string still shows its heading and its retry control. The
        wrapper carries the block's spacing; the `Alert` owns its tone, border and padding, and its
        `actions` slot is why the button is passed in from here.
      */}
      {cartError === null ? null : (
        <div className={styles.notice}>
          <Alert
            tone="danger"
            title={cartErrorTitle ?? ERROR_TITLE}
            actions={
              <Button ref={cartRetryControl} variant="secondary" size="sm" onClick={handleRetry}>
                {RETRY_LABEL}
              </Button>
            }
          >
            {cartError}
          </Alert>
        </div>
      )}

      {/*
        State 2. Only while there is nothing else to show - a re-read over a cart that already has
        lines leaves those lines on screen. The rows sit outside `.scroll` on purpose: the
        stylesheet gives them the rhythm of the root's own grid.
      */}
      {syncStatus === 'loading' && lines.length === 0
        ? SKELETON_ROW_KEYS.map((key) => (
            <div className={styles.skeletonRow} key={key}>
              <Skeleton shape="block" className={styles.skeletonMedia} />
              <Skeleton shape="text" lines={2} className={styles.skeletonText} />
            </div>
          ))
        : null}

      {/*
        State 3. Known to be empty, not merely unread, which is why the loading branch above and a
        published failure are both excluded rather than left to ordering: a read that did not
        answer leaves no lines behind either, and a cart whose contents nobody established is not
        a cart holding nothing - the notice above stands alone for that. `cartError` is compared
        against `null` for the same reason state 1 compares it that way, so a failure the provider
        described in an empty string suppresses this block as any other failure does. `emptySlot`
        replaces the whole block when a placing supplies one.
      */}
      {cartError === null && lines.length === 0 && syncStatus !== 'loading'
        ? (emptySlot ?? (
            <BlankSlate art="empty-cart" alt={EMPTY_ART_ALT} heading={EMPTY_HEADING}>
              {EMPTY_BODY}
            </BlankSlate>
          ))
        : null}

      {/*
        State 4. `.map` rather than a counted loop: under `noUncheckedIndexedAccess` a `lines[i]`
        lookup is `CartLine | undefined` and would need a guard for a line that cannot be absent,
        while the callback's parameter is a line. The key is the line's own identifier, which is
        stable as quantities change and as other lines are removed around it in a way an offset is
        not. Each row renders its own `<li>`, so nothing is wrapped here.
      */}
      {lines.length === 0 ? null : (
        <div className={styles.scroll}>
          <ul className={styles.list}>
            {lines.map((line: CartLine) => (
              <CartLineRow key={line.id} line={line} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
