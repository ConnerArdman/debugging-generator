'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { useEffect, useId, useRef, useSyncExternalStore, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

import { Badge } from '@/components/ui/Badge';
import { BlankSlate } from '@/components/ui/BlankSlate';
import { Button } from '@/components/ui/Button';
import buttonStyles from '@/components/ui/Button.module.css';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import { useCartSummary } from '@/hooks/useCartSummary';

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
 * `@/hooks/useCartSummary` and nothing else: `contentsKnown` with `isCartEmpty`, to decide whether
 * there is a total worth footing the sheet with, and `unitCount` with its `unitCountLabel` wording
 * for the badge beside the heading - the same count the header's cart badge quotes.
 * The summary is read rather than the cart counted here because an empty set of lines is two
 * different statements - a cart the server answered with nothing in it, or a cart whose read is
 * still in flight or came back a failure - and that hook is where the storefront tells them apart
 * once, for the badge up here, the totals in the foot, `/cart` and the checkout review alike. So a
 * cart nobody has read is announced by neither a zero in the chip nor an empty foot: the body's
 * own notice says what happened. Every mutation stays where its
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
 * THE MODAL ENVIRONMENT: BACKGROUND INERT, PAGE SCROLLING LOCKED
 * `aria-modal="true"` is a promise to a reader that nothing behind the sheet is reachable, and a
 * keydown trap cannot keep it: Tab is only one of the ways focus moves, so a programmatic
 * `element.focus()`, a find-in-page match or an assistive-technology cursor would otherwise land
 * in the page behind the scrim with no way back. So while the sheet is showing, the single effect
 * below writes three things to the document and takes all three back on cleanup:
 *
 *   1. `inert` on every child of `document.body` except the dialog itself, the notification live
 *      region and any subtree holding a custom element (a tag name containing `-`), which in this
 *      application is only ever development tooling - Next's `nextjs-portal` and its route
 *      announcer, the first of which is mounted inside one of the script elements React streams
 *      into the body, so "holding one" rather than "being one" is what keeps the error overlay
 *      usable while the cart is open.
 *      `inert` both removes the subtree from the accessibility tree and refuses focus, which is
 *      what a keydown trap could never do. The live region is excluded deliberately and the
 *      exclusion is load-bearing: this sheet's own rows raise notices ("Quantity updated",
 *      "Removed from cart"), and an inert live region announces nothing, so `../ui/ToastViewport`
 *      marks its root `data-ls-live-region="true"` and the sweep below skips any body child that
 *      is, or contains, that marker. Only the elements this effect actually changed are put back,
 *      so a subtree that was already inert for a reason of its own stays inert.
 *   2. `overflow: hidden` on `document.documentElement`, so the page behind the scrim holds still
 *      instead of scrolling under the reader's gesture or their keyboard. The layout shift that
 *      normally comes with that - the page's scrollbar disappearing and everything behind sliding
 *      over by its width - is answered rather than accepted: the gutter is measured as
 *      `window.innerWidth - documentElement.clientWidth` BEFORE the lock, and when it is greater
 *      than zero (a classic scrollbar) `scrollbar-gutter: stable` keeps exactly that much space
 *      reserved. When it is zero (overlay scrollbars, a touch device, a page that does not
 *      overflow) nothing is reserved, because reserving anything there would introduce the very
 *      shift being avoided. Both declarations are inline and are restored to whatever they were,
 *      `removeProperty` and the `style` attribute itself included, so a page that declared neither
 *      ends up declaring neither.
 *   3. A `scroll` listener on `window` that puts the document's offset straight back. The lock in
 *      2 is what a wheel, a swipe and the paging keys answer to, and it is all they answer to: the
 *      element stays a scroll container, so a *scripted* scroll still moves the page behind the
 *      scrim - find-in-page, an in-page anchor, and this storefront's own `scroll-behavior: smooth`
 *      animating over several frames. The offset is read while it is still the reader's and
 *      restored instantly on any document scroll; the sheet's own list is untouched by this,
 *      because a scroll event on an element does not bubble to `window`.
 *
 * `CartDrawer.module.css` still stops a scroll gesture chaining out of the list with
 * `overscroll-behavior: contain` on `.body`, which is the part of the behaviour that belongs in CSS:
 * the lock is applied by this component to `document.documentElement`, which no CSS Module class
 * can reach.
 *
 * THE FOOTER'S RESERVATION FOR THE NOTIFICATION REGION
 * The toast region is fixed to the same bottom-inline-end corner as this sheet's pinned `.foot`
 * and sits one stacking tier above it (`--ls-z-toast` 60 over `--ls-z-drawer` 40), because a notice
 * must never be hidden behind the drawer. Left there it would cover the footer's Checkout link for
 * the notice's whole life, so the two surfaces share a corner by reservation rather than by
 * stacking: while the sheet is open this component publishes the footer's measured height as
 * `--ls-toast-inset-block-end` on `document.body`, and `../ui/ToastViewport.module.css` adds it to
 * its own inset, which lifts the notice column to sit directly above the footer. The property is
 * removed on cleanup and its stylesheet fallback is `0px`, so every other surface in the storefront
 * is exactly as it was. The footer is conditionally rendered and changes height as the totals do, so
 * the effect that publishes it is gated on the footer's presence and keeps a `ResizeObserver` on it.
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
 * The dialog carries a literal `id`, {@link CART_DIALOG_ID}, exported so the header's cart control
 * can name the sheet it opens through `aria-controls`. A literal rather than a generated value: the
 * header mounts this component once per document, so the id is unique without being generated, and
 * the control and the dialog read it from one declaration. The control sets the reference only
 * while it holds `open`, because this component renders nothing while closed and a reference to an
 * element that is not in the document is broken rather than merely absent.
 *
 * The sheet is the only element in the file that suppresses its focus outline, and
 * `CartDrawer.module.css` does it there for a container that is focused programmatically and is not
 * itself a control. Every control inside keeps the ring the application draws - the two footer
 * anchors from this module, the empty state's action from the button stylesheet it wears, the
 * close control and the rows' own controls from their components.
 *
 * NO CLOCK
 * Nothing in this file reads a clock or schedules anything: no interval, no deferred callback and
 * no reading of the current time. The dispatch estimate in the footer is `CartTotalsPanel`'s.
 *
 * CLASS CONTRACT
 * `CartDrawer.module.css` declares nine classes and this component uses all nine - `overlay`,
 * `panel`, `head`, `title`, `close`, `body`, `foot`, `checkoutLink` and `cartLink`. A CSS Module
 * lookup answers `undefined` for a name that is not there rather than failing to compile, so the two
 * files are kept in step by hand. No element in this tree carries a `style` prop - the only inline
 * declarations this file writes are the document-level ones described above, on
 * `document.documentElement` and `document.body`, because neither element is in this tree for a
 * class to be put on. The empty state's illustration is named to `../ui/BlankSlate` by its `art` key
 * rather than imported as a file, so no asset path appears here at all. The empty state's one
 * action is an anchor wearing `../ui/Button.module.css`'s own `.root` and `.label` with its
 * `data-variant` and `data-size`, exactly as the cart page's actions do, so it reads as the
 * storefront's primary control without a tenth class here restating that control's chrome.
 */

/**
 * The dialog's `id`, which the header's cart control names in `aria-controls` while the sheet is
 * open. Exported for that one reader; see DIALOG SEMANTICS above for why it is a literal.
 */
export const CART_DIALOG_ID = 'site-cart-dialog';

/** The dialog's visible heading, which is also its accessible name. */
const DIALOG_TITLE = 'Your cart';

/**
 * Screen-reader-only continuation of the count badge, so it is announced as "12 items in your cart"
 * rather than as a bare number beside a heading. The badge counts units - the figure the header's
 * own cart badge and its "with 12 items" name quote - so one cart is one count wherever a reader
 * meets it, and the noun is the header's too. Two forms, because "1 items" is not English; the
 * leading space is part of each string, since the number and this text are separate elements and
 * the announced name is their concatenation.
 */
const COUNT_SUFFIX_ONE = ' item in your cart';
const COUNT_SUFFIX_MANY = ' items in your cart';

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

/**
 * The empty state's way on: the catalog, which is where every line in a cart comes from and what
 * the sentence above already points at. Worded as that sentence's own verb and object, so the
 * control a reader meets is the action they were just told to take.
 */
const EMPTY_ACTION_LABEL = 'Browse the catalog';
const EMPTY_ACTION_HREF = '/';

/**
 * The size step of that action, from `../ui/Button.module.css`'s scale: `md`, the storefront's
 * ordinary control height. The sheet is a narrow column, and the page-level `lg` step the cart
 * page's own actions take would crowd the illustration and the sentence it follows.
 */
const EMPTY_ACTION_SIZE = 'md';

/** The keys this dialog answers to, spelled as `KeyboardEvent.key` reports them. */
const CLOSE_KEY = 'Escape';
const CYCLE_KEY = 'Tab';

/**
 * The attribute that takes a background subtree out of the accessibility tree and refuses it focus
 * while this dialog is open. Set as an attribute rather than through the `inert` IDL property so the
 * state is visible in the document a reader or an audit is looking at, and so the restore is
 * unambiguous: an element this effect marked has the attribute removed, an element that already
 * carried it is never touched.
 */
const INERT = 'inert';

/**
 * The one body subtree the sweep leaves alone besides this dialog: the notification live region,
 * which `../ui/ToastViewport` marks with `data-ls-live-region="true"`. Matched as a selector so a
 * body child that merely *contains* the region is spared as well - the region's position in the
 * layout tree is the root layout's business, not this file's.
 */
const LIVE_REGION = '[data-ls-live-region]';

/**
 * The properties this component writes to the document while the sheet is open, and takes back
 * afterwards.
 *
 * `overflow` and `scrollbar-gutter` go on `document.documentElement`: the first stops the page
 * behind the scrim scrolling, the second keeps the space the vanished scrollbar had, so nothing
 * behind the sheet moves. `--ls-toast-inset-block-end` goes on `document.body` and is read by
 * `../ui/ToastViewport.module.css`, which adds it to the notification column's own inset so a
 * notice stacks above this sheet's footer instead of over it.
 */
const PAGE_OVERFLOW = 'overflow';
const PAGE_GUTTER = 'scrollbar-gutter';
const TOAST_INSET = '--ls-toast-inset-block-end';

/** What the two page properties above are set to while the sheet is open. */
const LOCKED = 'hidden';
const RESERVED = 'stable';

/**
 * Puts one inline style declaration back exactly as it was found.
 *
 * `setProperty(name, '')` is not the same as never having declared the property - the first leaves
 * an empty declaration behind, which is why "it was not declared" has to be restored with
 * `removeProperty`. Reading a declaration that was never made answers the empty string, so the two
 * halves of this pair compose: read before the change, hand the reading back afterwards.
 */
function restore(style: CSSStyleDeclaration, name: string, value: string): void {
  if (value === '') {
    style.removeProperty(name);
    return;
  }

  style.setProperty(name, value);
}

/**
 * Drops the `style` attribute from `element` once it declares nothing.
 *
 * `removeProperty` empties a declaration but leaves the attribute itself behind, and an element
 * carrying `style=""` is not the element this component was handed: a restore has to be
 * indistinguishable from never having written, for an audit, a snapshot test or a selector reading
 * the attribute's presence. Guarded on the declaration count, so a property something else set on
 * the same element keeps both that property and the attribute.
 */
function tidy(element: HTMLElement): void {
  if (element.style.length === 0) {
    element.removeAttribute('style');
  }
}

/**
 * Whether `root` is, or contains, a custom element - an element whose tag name has a `-` in it.
 *
 * Nothing this application renders is a custom element (every component in it emits plain HTML), so
 * a match means development tooling put the element there: Next's `nextjs-portal`, which carries the
 * error and build overlays, and its `next-route-announcer`. Those have to keep working while the
 * dialog is open - an inert error overlay is a developer staring at a dimmed page with no way to
 * read the exception behind it - and making them inert protects nobody, since they are not part of
 * the storefront a reader is shopping in.
 *
 * The containment half is the part that is easy to leave out and then get wrong: Next mounts
 * `nextjs-portal` *inside* one of the script elements React streams into the body, so a rule that
 * only looked at each body child's own tag name would put `inert` on that script and take the
 * overlay with it. The scan short-circuits on the first match and runs once per opening, over a
 * document body whose children are the site chrome and a handful of script elements.
 */
function tooling(root: HTMLElement): boolean {
  if (root.tagName.includes('-')) {
    return true;
  }

  for (const descendant of root.querySelectorAll('*')) {
    if (descendant.tagName.includes('-')) {
      return true;
    }
  }

  return false;
}

/**
 * Whether the background subtree `child` - a child of `document.body` - must stay interactive while
 * the dialog is open.
 *
 * Three cases, and no others: the dialog's own overlay (`scrim`, which is the dialog and everything
 * in it); the notification live region, because a notice raised by this sheet's own rows has to be
 * announced while the sheet is open and an inert live region announces nothing; and a subtree
 * holding a custom element, which is development tooling - see {@link tooling}.
 */
function spared(child: HTMLElement, scrim: HTMLDivElement | null): boolean {
  if (scrim !== null && (child === scrim || child.contains(scrim))) {
    return true;
  }

  if (child.matches(LIVE_REGION) || child.querySelector(LIVE_REGION) !== null) {
    return true;
  }

  return tooling(child);
}

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

/** The dialog's inputs, kept local to this file: nothing outside needs to name this shape. */
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

  // The published cart's totals, or the reason it has none: `@/hooks/useCartSummary` publishes a
  // reading discriminated by `contentsKnown`, which is what says whether the storefront has
  // established what the cart holds at all. `unitCount` is the number of units across every line,
  // which is what the badge beside the heading counts - the figure the header's own badge quotes,
  // so the badge a reader pressed and the badge in the sheet it opened never disagree.
  //
  // Read from the summary rather than counted from the cart here, and for one reason: an empty
  // `lines` array is a cart the server answered with nothing in it *or* a cart whose read is still
  // in flight or failed, and the summary is where the storefront tells those apart once. A badge
  // counting the array directly would print "0 items in your cart" for contents nobody read.
  const summary = useCartSummary();

  // Ties `aria-labelledby` on the sheet to the heading inside it. `useId` rather than a counter or a
  // random value: React produces the same id on the server and during hydration, so the reference is
  // valid in the first frame it exists.
  const labelId = useId();

  // The sheet, so it can be focused as it opens and asked for its focusable contents while Tab is
  // being pressed, and the element focus came from, so it can be handed back.
  const sheet = useRef<HTMLDivElement | null>(null);
  const origin = useRef<HTMLElement | null>(null);

  // The scrim, and the pinned footer inside the sheet. Both are read by the effects below and by
  // nothing else: the scrim is the one child of `document.body` the inert sweep must spare, because
  // it is the dialog, and the footer is the rectangle the notification region is asked to keep
  // clear of.
  const scrim = useRef<HTMLDivElement | null>(null);
  const foot = useRef<HTMLDivElement | null>(null);

  // Whether the browser has taken over from the server; see `readOnServer` above.
  const mounted = useSyncExternalStore(subscribeNever, readInBrowser, readOnServer);

  // `open && mounted` - exactly the condition the early return below renders on, named once so the
  // effects can be gated on the same fact. An effect that ran while the sheet was not in the
  // document would focus a ref holding nothing and listen for a key nothing is waiting for.
  const showing = open && mounted;

  // Whether the sheet has a footer at all - exactly the condition the `.foot` block below renders
  // on, named once so the reservation effect can re-run the moment it changes. A cart whose contents
  // nobody established, and a cart established as empty, both have nothing to total and so no
  // footer for a notice to be lifted above.
  const footed = summary.contentsKnown && !summary.isCartEmpty;

  // The whole modal environment, in one effect: where focus came from, the background going inert,
  // the page's scroll lock, and focus moving into the sheet - engaged in that order and released in
  // the reverse.
  //
  // One effect rather than one per step, because the order is the behaviour and not an accident of
  // which effect React happens to clean up first. Two of the steps interact directly: `inert` refuses
  // focus, so an `inert` still standing when focus is handed back to the header's cart control would
  // make that `focus()` call do nothing at all and leave the reader on `<body>`. Splitting the
  // environment across effects would make the outcome depend on declaration order, which is a fact
  // about this file nobody reading the two halves separately can see.
  //
  // Gated on `showing` alone, so it engages once per opening: an effect that re-ran whenever the
  // cart changed would blur whatever control the reader was using to put focus back on the sheet.
  // The footer's reservation, which genuinely does depend on the cart, is the effect below.
  useEffect(() => {
    if (!showing) {
      return;
    }

    // `instanceof HTMLElement` rather than a cast: `document.activeElement` is an `Element | null`,
    // and only an HTML element has `focus()`. An SVG element or `null` therefore leaves nothing
    // remembered, and the cleanup below simply does nothing - which is the right outcome, since
    // there is no control to hand the reader back to.
    //
    // Read before anything else happens: `inert` on the subtree holding the focused element blurs
    // it, so a reading taken after the sweep would answer `<body>` and the reader would be handed
    // back to nowhere.
    const active = document.activeElement;
    origin.current = active instanceof HTMLElement ? active : null;

    // ENGAGE 1 - the background stops being reachable. The list is built as the sweep runs and
    // holds only the elements this effect actually changed, which is what makes the release exact:
    // a subtree that was already `inert` when the sheet opened is never touched and never cleared.
    const inerted: HTMLElement[] = [];

    // `Array.from` rather than iterating the live `HTMLCollection`: `document.body.children`
    // updates as the document does, and this loop is reading it while React commits.
    for (const child of Array.from(document.body.children)) {
      // `document.body.children` is typed `Element`, while the list above and `spared` below both
      // deal in HTML elements, so a child that is not one - an SVG root dropped straight into the
      // body, which nothing in this application produces - is narrowed out and left as it is.
      if (!(child instanceof HTMLElement)) {
        continue;
      }

      if (child.hasAttribute(INERT) || spared(child, scrim.current)) {
        continue;
      }

      child.setAttribute(INERT, '');
      inerted.push(child);
    }

    // ENGAGE 2 - the page behind the scrim stops scrolling. The gutter is measured before the lock
    // and while the scrollbar is still there, because that is the only moment the difference
    // between the two widths is the scrollbar's own width.
    const page = document.documentElement;
    const gutter = window.innerWidth - page.clientWidth;
    const overflow = page.style.getPropertyValue(PAGE_OVERFLOW);
    const reserved = page.style.getPropertyValue(PAGE_GUTTER);

    if (gutter > 0) {
      page.style.setProperty(PAGE_GUTTER, RESERVED);
    }

    page.style.setProperty(PAGE_OVERFLOW, LOCKED);

    // ENGAGE 3 - the offset that lock is holding, held. `overflow: hidden` is what a wheel, a
    // swipe and the paging keys answer to, and it is the whole of what they answer to: the element
    // stays a scroll container, so anything that scrolls it *by script* still moves the page behind
    // the scrim. Find-in-page does that, an in-page anchor does it, and this storefront's own
    // `scroll-behavior: smooth` animates it over several frames.
    //
    // So the offset is remembered while it is still the reader's, and any scroll of the document is
    // put straight back. Only the document's own scroll reaches this listener: a scroll event on an
    // element does not bubble, so the sheet's list scrolls without ever consulting this - and the
    // equality guard makes a scroll that changed nothing a no-op, which is what stops the correction
    // below from answering itself forever. `behavior: 'instant'` rather than the default, because
    // the default is the page's own `smooth` and a correction that animates is a background still
    // sliding, just more slowly.
    const offset = { top: window.scrollY, left: window.scrollX };

    const pin = (): void => {
      if (window.scrollY === offset.top && window.scrollX === offset.left) {
        return;
      }

      window.scrollTo({ ...offset, behavior: 'instant' });
    };

    window.addEventListener('scroll', pin, { passive: true });

    // ENGAGE 4 - the reader is moved into the dialog, which is also what a screen reader needs in
    // order to be inside it. Last, so the sheet is focused into a document where everything else is
    // already unreachable.
    sheet.current?.focus();

    return () => {
      // RELEASE, in the reverse order. The page scrolls again, the background becomes reachable
      // again, and only then is focus handed back - `focus()` on a still-inert control is silently
      // ignored, so this order is the difference between returning the reader to the control they
      // opened the cart with and dropping them on `<body>`.
      window.removeEventListener('scroll', pin);

      restore(page.style, PAGE_OVERFLOW, overflow);
      restore(page.style, PAGE_GUTTER, reserved);
      tidy(page);

      for (const child of inerted) {
        child.removeAttribute(INERT);
      }

      // Optional chaining, never an assertion: the reference is empty when the drawer was opened
      // from nothing focusable, and an element that has since left the document cannot take focus
      // either - the browser answers both by leaving focus where it is.
      origin.current?.focus();
    };
  }, [showing]);

  // The notification region's reservation over the sheet's pinned footer: while both are on screen
  // they claim the same bottom-inline-end corner, and the region is one stacking tier above the
  // drawer on purpose - a notice must never be hidden behind it - so the corner is shared by
  // reservation instead. `--ls-toast-inset-block-end` on `document.body` is the footer's measured
  // height, which `../ui/ToastViewport.module.css` adds to its own inset; removed on cleanup, and
  // read there with a `0px` fallback, so every surface without a drawer open is untouched.
  //
  // Its own effect, separately from the modal environment above, because it has to follow the cart:
  // the footer exists only once the contents are known and non-empty, so `footed` is a dependency,
  // and a footer that appears with the first line added from inside the sheet has to be measured
  // then. The `ResizeObserver` covers the rest - a quantity edited, a dispatch estimate re-worded,
  // a total that grows a digit - without this effect re-running for any of it.
  useEffect(() => {
    if (!showing || !footed) {
      return;
    }

    const element = foot.current;

    // The footer is rendered on exactly the condition `footed` states, so the ref is populated by
    // the time effects run. Guarded rather than asserted all the same: a missing measurement must
    // publish nothing, not `NaN` or a reservation the region would then honour forever.
    if (element === null) {
      return;
    }

    const publish = (): void => {
      // `getBoundingClientRect().height` rather than `offsetHeight`: the footer's height is a
      // fractional number of CSS pixels at most zoom levels, and a rounded-down reading would let
      // the notice overlap the footer's top hairline.
      document.body.style.setProperty(TOAST_INSET, `${element.getBoundingClientRect().height}px`);
    };

    publish();

    // Observed rather than measured once: the totals panel re-words its dispatch estimate in place,
    // and a stale reservation would leave a notice sitting over the footer again.
    const observer = new ResizeObserver(publish);
    observer.observe(element);

    return () => {
      observer.disconnect();
      document.body.style.removeProperty(TOAST_INSET);
      tidy(document.body);
    };
  }, [showing, footed]);

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
  }, [showing, onClose]);

  // Nothing is rendered while the drawer is closed, and nothing is rendered before the browser has
  // taken over, so `document.body` below is only ever read where it exists.
  if (!showing) {
    return null;
  }

  return createPortal(
    <div
      className={styles.overlay}
      // Referenced so the inert sweep can recognise the dialog among `document.body`'s children and
      // leave it - and only it - reachable.
      ref={scrim}
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
        id={CART_DIALOG_ID}
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

          {/* The unit count, the one the header's badge quotes, in the wording the summary
              publishes - formatted by the application's own number formatter rather than by an
              `Intl` instance built here, so every figure in the storefront groups its digits the
              same way - and printed only where the cart's contents were established. A cart still
              being read, or one whose read failed, has no count to put in a chip: a zero here
              would state that the sheet is empty while the body below it is showing placeholders
              or a failure notice for the very same cart. `CartLineList` says which of the two it
              is, in the one place a reader is looking. */}
          {summary.contentsKnown ? (
            <Badge size="sm">
              {summary.unitCountLabel}
              <VisuallyHidden>
                {summary.unitCount === 1 ? COUNT_SUFFIX_ONE : COUNT_SUFFIX_MANY}
              </VisuallyHidden>
            </Badge>
          ) : null}

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
            looking at.

            Its heading is an `<h3>`, one level under the dialog's own `<h2>`. It offers the one
            way on an empty cart has - the catalog - because a sheet whose footer is withheld for
            an empty cart would otherwise end in a sentence and a close control. The action is an
            anchor, since it navigates, and it dismisses the dialog as it is followed, exactly as
            the footer's links do, so the sheet is not left standing over the page it sent the
            reader to; focus then returns to the control the sheet was opened from. It is a
            `next/link` anchor inside the sheet, so the focus trap reaches it by Tab and Enter
            follows it. */}
        <div className={styles.body}>
          <CartLineList
            variant="drawer"
            emptySlot={
              <BlankSlate
                art="empty-cart"
                alt={EMPTY_ART_ALT}
                heading={EMPTY_HEADING}
                headingAs="h3"
                action={
                  <Link
                    href={EMPTY_ACTION_HREF}
                    className={clsx(buttonStyles.root)}
                    data-variant="primary"
                    data-size={EMPTY_ACTION_SIZE}
                    onClick={onClose}
                  >
                    <span className={clsx(buttonStyles.label)}>{EMPTY_ACTION_LABEL}</span>
                  </Link>
                }
              >
                {EMPTY_BODY}
              </BlankSlate>
            }
          />
        </div>

        {/* Totals and the two ways on, and only once there is a line to total - which is a cart
            whose contents were established and hold something, exactly the two conditions below.
            A cart nobody could read has nothing to total and nowhere to send a reader from here,
            so the foot stays out of the sheet and the body's own notice stands alone. */}
        {footed ? (
          // Referenced so the effect above can measure this block's height and publish it as the
          // notification region's reservation, which is what keeps a notice off the Checkout link.
          <div className={styles.foot} ref={foot}>
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
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
