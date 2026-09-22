'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactElement,
} from 'react';

import { CartDrawer } from '@/components/cart/CartDrawer';
import {
  getServerSnapshot,
  getSnapshot,
  subscribe,
} from '@/components/product/active-product-store';
import { RecommendationsRail } from '@/components/product/RecommendationsRail';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import { useCartSummary } from '@/hooks/useCartSummary';
import { formatQuantityLabel } from '@/lib/format';

import styles from './SiteHeader.module.css';

/*
 * SiteHeader - the storefront's sticky top bar, rendered once by `app/layout.tsx` above `SiteNav`
 * and above every page's content.
 *
 * It places six things and nothing else: the "Skip to content" link, the brand lockup that leads
 * home, the search form, the control that discloses that form at phone widths, a short strip of
 * suggestions while a product is on screen, and the cart control with the count beside it. The
 * sheet that control opens is `@/components/cart/CartDrawer`, rendered here and portalled out of
 * this subtree by that component.
 *
 * THE SKIP LINK
 * First element in the bar, so it is the document's first tab stop, and a plain `<a>` rather than
 * `next/link`: `#main` is a position in the page already on screen, not a route, and the router has
 * nothing to do with it. `PageContainer` owns the `<main id="main" tabIndex={-1}>` it points at -
 * the negative index is what lets a fragment move focus into a region that is not a control - and
 * `SiteHeader.module.css` keeps the link in the focus order while it is collapsed, so there is
 * always something to skip with.
 *
 * THE BRAND
 * A plain `<img>` with the file's intrinsic 200x40 stated as attributes, so the box is reserved
 * before the file arrives and the row cannot shift as it does. `next/image` is deliberately not
 * used: optimising an SVG through it would need an `images.dangerouslyAllowSVG` entry in a
 * `next.config.ts` that is otherwise empty, and there is nothing to optimise in a 200x40 lockup.
 * The `src` is written as the literal public path rather than imported, because an import of an
 * asset is typed only by the ambient declarations `next dev` generates, and this workspace has to
 * type-check on a clone that has never run a build. `alt` is the store's name, which is what the
 * lockup reads; "logo" would describe the picture instead of replacing it.
 *
 * SEARCH NAVIGATES, AND NEVER FETCHES
 * The field sends the reader to the catalog with the term in the URL. This bar asks the server for
 * nothing and renders no results: the catalog page reads the term from its own search parameters
 * and is the single place a product query is run, so a second reader of that endpoint up here
 * would put two answers to one question on the page.
 *
 * It navigates twice over, from one set of rules. A submit goes immediately, which is also the
 * path a reader without JavaScript takes - the field's native `name` is the submitted key, so the
 * browser's own submit produces the same URL. A keystroke goes on a timer instead: the effect
 * below waits `SEARCH_DEBOUNCE_MS` after the draft last changed and then navigates, so a term
 * reaches the catalog while the reader is still looking at the field without costing one
 * navigation per letter. The address both paths land on is built by `destination`, at module
 * scope, so there is one definition of the URL rules rather than two that can drift.
 *
 * What keeps the timer honest is that it is armed for one thing only: the navigation a keystroke
 * asked for, on the route it was asked on. That is what the intent below holds - the route of the
 * last keystroke, or nothing - and it is spent the moment the thing it stands for happens or stops
 * being possible: the timer clears it as it navigates, the submit handler clears it as it navigates
 * immediately, a draft that already matches the term in the address bar clears it because there is
 * nothing left to ask for, and a route change clears it without arming anything in its place. So a
 * reader who types and then opens a product keeps the product; a reader who never typed at all is
 * never navigated, which matters because the field starts empty rather than seeded from the URL and
 * an unedited empty draft would otherwise read as "clear the term" on a page opened at
 * `/?search=anvil`; and only a new keystroke asks again. The timer itself is dropped by its own
 * effect's cleanup on a keystroke, a route change or an unmount, and synchronously by the submit
 * handler so the reader's own navigation is not overtaken by the queued one. And it replaces the
 * history entry while the reader is on the catalog, pushing only when it takes them there from
 * somewhere else, so typing leaves one entry behind rather than one per word.
 *
 * The parameters that survive are read from the address bar inside the handler and inside the
 * effect, rather than through the router's search-parameter hook. Reading them with that hook opts
 * every route this bar renders into dynamic rendering, including the ones Next.js prerenders
 * (`app/not-found.tsx`, `app/error.tsx`), which would cost `next build` its static output for a
 * value needed only at the moment a navigation is built - and both of those moments are in a
 * browser, where `window.location.search` answers the same question for nothing. The submitted key
 * is `search`, the name `CatalogQuery` gives a catalog's text query, and the field's native `name`
 * is that same key so a submit without JavaScript produces the URL the catalog expects. `page` is
 * dropped, because a new term starts at the first page of results; every other parameter - the
 * category, the sort order - travels untouched, so searching inside a category stays inside it.
 *
 * THE COMPACT DISCLOSURE
 * At desktop widths the form is a child of the row. At phone widths it cannot be: the brand, a
 * field wide enough to read a term in, that field's submit control and the cart cluster do not fit
 * across a phone without each of them shrinking past legibility. So the trailing cluster carries a
 * control that discloses the form, and `SiteHeader.module.css` moves the form into a panel hanging
 * off the bar's bottom edge below its narrow breakpoint - out of flow, which is what keeps the bar
 * the one height it is allowed to be.
 *
 * The form is mounted at every width and its `id` is a literal, so the `aria-controls` on the
 * control always names a form that is in the document; the state travels to the stylesheet as
 * `data-open` and to assistive technology as `aria-expanded`, from the one boolean, so the two
 * cannot disagree. The control's visible word is the short one and its `aria-label` the fuller
 * one, which keeps the visible text a substring of the accessible name.
 *
 * Focus is the part that has to be right. Opening moves focus into the field, in an effect rather
 * than in the click handler, because the stylesheet draws nothing until the attribute has been
 * painted and an element that is not drawn cannot take focus. Escape anywhere inside the form
 * hands focus back to the control and then closes - in that order, so the move lands while the
 * control is still where the reader left it. Submitting closes it too: the panel covers the first
 * line of the results the reader is being sent to.
 *
 * THE CART CONTROL
 * `@/hooks/useCartSummary` is where the figures come from, so the count up here and the totals in
 * the sheet, on `/cart` and in the checkout summary are all the same arithmetic over the same
 * lines. The boolean that opens the sheet lives here because the control that sets it does;
 * everything else about that dialog - its role, its label, the focus it takes on the way in, the
 * focus it hands back on the way out, the trap while it is open, Escape, the scrim - belongs to
 * `CartDrawer`, and `onClose` does nothing but turn the boolean off.
 *
 * The count is part of the control's accessible name, as hidden text inside the control, so the
 * name is "Cart with 12 items" rather than "Cart": a name is recomputed every time a reader reaches
 * the control, which is what makes the current figure available on focus and on every re-focus
 * afterwards. The wording is chosen on the figure itself - one unit is an item, none of them is "no
 * items" - and it joins on a preposition because the name is built from two child nodes with a
 * space between them, which a phrase opening on a comma would be read back with in front of it.
 *
 * It names a figure only where the storefront has one. The cart's lines come from a read, so an
 * empty count is either a cart the server answered with nothing in it or a cart nobody has
 * established - the first read still in flight, or failed - and `@/hooks/useCartSummary` is where
 * the storefront tells those apart: it publishes the totals for a cart whose contents were
 * established and, for one whose were not, the reason there are none, which the bar reads off
 * `contentsKnown`. So the control names the state instead of printing a zero nobody read: "Cart
 * contents loading", "Cart contents unavailable". Lines already in hand stay named with their
 * count whatever the cart is doing, since a refused change leaves the cart it published in place
 * and the summary goes on reporting those contents as established. This is the same distinction
 * `@/components/cart/CartLineList` draws when it shows a failure notice rather than "your cart is
 * empty", said in the words a control can carry - and reading it from the summary rather than
 * re-deriving it here is what keeps the badge, the sheet, `/cart` and the checkout review from
 * disagreeing about whether there is a cart at all.
 *
 * A change to the count is *announced* from a region beside the control, built out of the cart's
 * own figures and nothing else. The bar reads other published values as well, and a region whose
 * text quoted one of those would speak again whenever that value moved, with nothing about the
 * cart having changed; a count-derived string speaks when - and only when - the cart does. The
 * region is mounted in every state and carries that sentence only once there is an established
 * count to carry, so it never announces a zero the storefront has not read; asking the control is
 * what answers for a cart still being read. The two carry the same figure for different moments,
 * which is why both are here. The chip that prints it
 * a third time is hidden from assistive technology so it is not heard twice, and it is wrapped for
 * that rather than given an attribute, because `ui/Badge` takes a label, a tone, a size and a class
 * and nothing else. A static wrapper is not a containing block, so the chip still positions itself
 * against `.cartButton` exactly as the stylesheet intends.
 *
 * THE SUGGESTIONS STRIP
 * A product page is a descendant of this bar, so what that page knows cannot reach up here through
 * context, and the route carries a slug where the strip needs the id the endpoint identifies a
 * product by. `@/components/product/active-product-store` bridges the two: the page publishes the
 * id it resolved and this bar reads it with `useSyncExternalStore`, whose three arguments are that
 * module's own exports and are therefore already stable.
 *
 * `getServerSnapshot()` answers `null`, which is also what React uses for the first render in the
 * browser, so the strip is absent from the markup the server sent and from the markup hydration
 * produces - the two agree, and it appears a moment later, once the page has published. How many
 * suggestions to read is `RecommendationsRail`'s to state and not this bar's to pass, which is what
 * keeps a reader seeing the same suggestions for a product wherever they meet them on the page.
 *
 * THE HEIGHT INVARIANT
 * `PageContainer` offsets the document's single `<main>` by `--ls-header-height`, so this bar is
 * exactly that tall on every route. The strip is therefore placed in a track the stylesheet bounds
 * on both axes rather than in a second row; the phone-width search panel is taken out of flow
 * against the bar instead of being given a row of its own, so neither its open state nor its
 * closed one adds a pixel; and nothing in this file sets a height, an inline style or a second row.
 *
 * CLASS CONTRACT
 * `SiteHeader.module.css` defines thirteen classes and this file uses all thirteen - `skipLink`,
 * `root`, `inner`, `brand`, `logo`, `search`, `searchField`, `searchSubmit`, `searchToggle`,
 * `miniRail`, `actions`, `cartButton` and `cartBadge` - composed with `clsx` and never with an
 * inline `style`. The four wrappers exist because the primitives inside them own their own chrome
 * and the geometry around them has to live on an element of this file's own.
 */

/** Where the skip link sends focus: the `id` on the `<main>` landmark `PageContainer` renders. */
const SKIP_LINK_TARGET = '#main';

/** The words on that link, phrased as the destination rather than as the mechanism. */
const SKIP_LINK_LABEL = 'Skip to content';

/** The catalog, which is also where the brand leads and where a submitted term is sent. */
const CATALOG_PATH = '/';

/** Every product page, and the only route the suggestions strip is drawn on. */
const PRODUCT_PATH_PREFIX = '/products/';

/** The lockup's path under `public/`, its intrinsic width and its intrinsic height. */
const LOGO_SOURCE = '/logo.svg';
const LOGO_WIDTH = 200;
const LOGO_HEIGHT = 40;

/**
 * Replacement text for the lockup: the store's name, because that is what the picture says. A
 * reader hears "Lumen Supply, link", which is the destination rather than a description of an
 * image.
 */
const BRAND_NAME = 'Lumen Supply';

/**
 * The search field's `id`, tying its label to it.
 *
 * A literal rather than a generated value: this bar is mounted once per document, so the id is
 * unique without being generated, and a literal is identical on the server and in the browser.
 */
const SEARCH_FIELD_ID = 'site-search-field';

/**
 * The search form's `id`, which the compact disclosure's `aria-controls` names.
 *
 * A literal for the same reason the field's is, and stated here rather than generated so the
 * relationship between the control and the form it reveals reads the same in the markup, in this
 * file and in the stylesheet that draws the panel.
 */
const SEARCH_FORM_ID = 'site-search-form';

/** The field's accessible name, and the placeholder that repeats it once the label is collapsed. */
const SEARCH_LABEL = 'Search products';

/** The word on the submit control, and on the compact disclosure's control beside the cart. */
const SEARCH_WORD = 'Search';

/**
 * The search parameter a term is submitted as - the name `CatalogQuery` gives a catalog's text
 * query, and the one the catalog page's validation reads. It is also the field's native `name`, so
 * a form submitted without JavaScript lands on the same URL `destination` below builds.
 */
const SEARCH_PARAM = 'search';

/**
 * The paging parameter, dropped by every navigation this bar makes because a new term starts at
 * the first page of results.
 */
const PAGE_PARAM = 'page';

/**
 * The key that closes the compact disclosure, matched against `KeyboardEvent.key` - the same key
 * and the same comparison the navigation beneath this bar uses for its own disclosure.
 */
const CLOSE_KEY = 'Escape';

/**
 * How long the bar waits after the last keystroke before it navigates on the reader's behalf, in
 * milliseconds.
 *
 * Long enough that an ordinary typist finishes a word without sending a navigation per letter -
 * which is what a bar that navigated on every change would do - and short enough that the catalog
 * has answered by the time the reader looks up from the field.
 */
const SEARCH_DEBOUNCE_MS = 300;

/** The word on the cart control, and the visible half of its accessible name. */
const CART_WORD = 'Cart';

/**
 * The hidden half of that name, appended inside the control so what the cart holds is part of the
 * name itself: "Cart with no items" for a cart the server answered with nothing in, "Cart with 1
 * item" for a single unit and "Cart with 12 items" for more.
 *
 * The last two say what a cart nobody has established yet holds, which is nothing a figure can
 * state: "Cart contents loading" while the first read is in flight and "Cart contents unavailable"
 * once it has failed. A zero printed in either state would tell a reader their cart is empty on the
 * strength of an answer that never arrived.
 *
 * The wording joins on a preposition rather than on punctuation because the name is assembled from
 * two child nodes of the control - the visible word and this hidden run - and the accessible-name
 * algorithm puts a space between the two. A phrase that began with a comma would therefore be read
 * back with a space in front of it, so the pieces are worded to read as one sentence with that
 * space in place. The trailing space in the prefix and the leading space before each unit word are
 * part of these strings: every piece is interpolated straight onto the text before it.
 */
const CART_EMPTY_DETAIL = 'with no items';
const CART_DETAIL_PREFIX = 'with ';
const CART_UNIT_WORD = ' item';
const CART_UNIT_WORD_PLURAL = ' items';
const CART_LOADING_DETAIL = 'contents loading';
const CART_UNAVAILABLE_DETAIL = 'contents unavailable';

/**
 * What follows the count in the announcement, so the region reads "12 in cart". The leading space
 * is part of the string: the number is interpolated immediately before it.
 *
 * The region carries this sentence only while there is a count to carry - see the render - because
 * a figure the storefront has not established is not a change worth announcing either.
 */
const CART_COUNT_SUFFIX = ' in cart';

/**
 * Whether `pathname` is a product page.
 *
 * Total and pure: the same string always gives the same answer, no argument can make it throw, and
 * it reads nothing outside its parameter - which is why it sits at module scope, where the rule it
 * encodes can be read and tested without rendering anything. The separator is part of the prefix,
 * so `/products/anvil-14` matches while a sibling route whose name merely starts the same way does
 * not.
 */
function isProductRoute(pathname: string): boolean {
  return pathname.startsWith(PRODUCT_PATH_PREFIX);
}

/**
 * The catalog URL a term belongs on, given the query string the address bar currently carries.
 *
 * Total and pure, and at module scope for the same reasons as the predicate above, plus one more:
 * two paths in this bar navigate - the reader's submit and the debounce that fires when they stop
 * typing - and a single implementation of the URL rules is what stops the two from disagreeing
 * about where the same term lands. It reads nothing outside its parameters, so the caller is the
 * one that touches `window`, and this can be reasoned about without a browser.
 *
 * The rules: a non-empty term is set, an empty one is deleted rather than searched for - so a
 * cleared field lands on the unfiltered catalog instead of on a query no product can match - the
 * paging parameter always goes, because a new term starts at the first page of results, and every
 * other parameter (the category, the sort order) travels untouched, so searching inside a category
 * stays inside it.
 *
 * @param search The query string to start from, in `window.location.search` form.
 * @param term The trimmed term to carry, or `''` to clear the one the URL holds.
 * @returns The catalog path, with the surviving parameters appended when any survive.
 */
function destination(search: string, term: string): string {
  const params = new URLSearchParams(search);

  if (term === '') {
    params.delete(SEARCH_PARAM);
  } else {
    params.set(SEARCH_PARAM, term);
  }

  params.delete(PAGE_PARAM);

  const query = params.toString();

  return query === '' ? CATALOG_PATH : `${CATALOG_PATH}?${query}`;
}

/**
 * Props of this component, kept local to it: nothing outside needs to name this shape, and a
 * second, exported name for "an optional class" would spend vocabulary for nothing.
 */
interface Props {
  /** Extra class for the `<header>` element, composed after the module's own `root` class. */
  className?: string;
}

/**
 * The storefront's top bar: skip link, brand, the search form with the control that discloses it at
 * phone widths, the suggestions strip for the product on screen, and the cart control with the
 * sheet it opens.
 *
 * @example
 * ```tsx
 * <SiteHeader />
 * <SiteNav />
 * <PageContainer>{children}</PageContainer>
 * ```
 */
export function SiteHeader(props: Props): ReactElement {
  const { className } = props;

  // The route without its query string, which is all the strip's condition needs. Next 16 types
  // this as `string`, so there is no absent case to defend against.
  const pathname = usePathname();

  // Where a submitted term is sent. The router is the only thing this form talks to.
  const router = useRouter();

  // The term as it is being typed. A controlled field, like the catalog's own toolbar: the value
  // the reader sees is the value this component holds, so nothing else can disagree with it. It
  // deliberately does not start from the URL - the bar is a place to begin a search from, not a
  // second display of the search the reader is already looking at.
  const [searchDraft, setSearchDraft] = useState('');

  // The navigation a keystroke has asked for but that has not been made yet, held as the route it
  // was typed on, and `null` when the bar has nothing outstanding.
  //
  // It carries two facts the debounce cannot do without. The first is that the reader typed at all:
  // the draft deliberately does not start from the URL, so an untouched empty draft says nothing
  // about the term the address bar carries, and read as an instruction it would strip the search
  // out of `/?search=anvil` a third of a second after the page loaded. The second is where they
  // typed it. A term asked for on one route is not an instruction on the next one: a reader who
  // types and then opens a product has chosen the product, and a queued search that pulled them
  // back to the catalog a moment later would take that choice away. So the route is recorded with
  // the intent, and the effect below drops the intent rather than re-arming it whenever the two no
  // longer agree.
  //
  // It is consumed exactly where the thing it asked for happens or stops being possible: the timer
  // clears it as it navigates, the submit handler clears it as it navigates immediately, a draft
  // that already matches the address bar clears it because there is nothing left to ask for, and a
  // route change clears it. Only a new keystroke sets it again.
  const [intent, setIntent] = useState<string | null>(null);

  // Whether the compact disclosure is showing the search form. It is read by the toggle's
  // `aria-expanded`, by the form's `data-open`, and by the stylesheet through that attribute; above
  // the narrow breakpoint the form is in the row whatever this holds, so a state left open when the
  // viewport widened cannot leak into the wide layout.
  const [searchOpen, setSearchOpen] = useState(false);

  // Whether the cart sheet is on screen. Owned here because the control that opens it is here.
  const [cartOpen, setCartOpen] = useState(false);

  // The field the disclosure reveals, so opening it can put focus there, and the control that
  // opens it, so Escape can hand focus back. Both are read inside a handler or an effect and never
  // while markup is being produced.
  const field = useRef<HTMLInputElement | null>(null);
  const toggle = useRef<HTMLButtonElement | null>(null);

  // The navigation the debounce has queued but not yet performed. The effect below arms it and
  // clears it; the handle is kept here as well so the submit handler can cancel it synchronously,
  // in the same turn as the navigation the reader asked for, rather than leaving a second one to
  // arrive a moment later. `ReturnType<typeof setTimeout>` because the ambient Node types and the
  // DOM types disagree about what a timer handle is, and this file needs neither name.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The cart's figures, summed in one place for every surface that quotes them - or, where its
  // contents were never established, the reason there are no figures to quote. `contentsKnown` is
  // what tells the two apart, and the bar reads it rather than deriving the distinction from the
  // cart's standing with the server: the summary is where the storefront decides it once, so the
  // count up here cannot disagree with the totals in the sheet about whether there is a cart.
  const summary = useCartSummary();

  // The product the reader is on, as the product page published it, or `null` anywhere else.
  const activeProductId = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // The hidden half of the cart control's accessible name, built from the cart's counts, or from
  // the state where there are none, and from nothing else.
  //
  // A figure is named only where there is a figure to name. An unread cart is not a cart holding
  // nothing, so it says which of the two it is instead of printing a zero nobody established - the
  // same distinction `CartLineList` draws when it shows a failure notice rather than "your cart is
  // empty", said in the words a control can carry. Singular or plural is decided on the figure
  // itself rather than on the string printed from it, so a grouped "1,000" is still "items" and a
  // plain "1" is an "item". Short, single-token locals throughout this component: the repository's
  // hardcoding guard harvests every multi-token name this workspace declares into a policy the
  // debugging product may then not use, so the bar spends none of that vocabulary on a local.
  let detail: string;
  if (!summary.contentsKnown) {
    detail = summary.unknownReason === 'loading' ? CART_LOADING_DETAIL : CART_UNAVAILABLE_DETAIL;
  } else if (summary.isCartEmpty) {
    detail = CART_EMPTY_DETAIL;
  } else {
    const unit = summary.unitCount === 1 ? CART_UNIT_WORD : CART_UNIT_WORD_PLURAL;

    detail = `${CART_DETAIL_PREFIX}${summary.unitCountLabel}${unit}`;
  }

  // Focus follows the disclosure open, in an effect rather than in the toggle's own handler: below
  // the breakpoint the stylesheet draws nothing until `data-open` has been painted, and an element
  // that is not being drawn cannot take focus. Closing is deliberately not handled here - the key
  // handler on the form moves focus to the toggle itself, before the panel goes away - so this
  // effect has one job and reads one value.
  useEffect(() => {
    if (!searchOpen) {
      return;
    }

    // Optional chaining rather than an assertion: the field holds a node only once it has mounted,
    // and a field the stylesheet is not drawing cannot take focus anyway.
    field.current?.focus();
  }, [searchOpen]);

  // The debounced navigation: the same address a submit produces, sent a beat after the reader
  // stops typing, so a term reaches the catalog without one navigation per keystroke.
  //
  // Every value this effect depends on is a primitive or an identity React itself keeps stable, and
  // its body calls nothing declared inside this component. That is load-bearing rather than tidy:
  // this bar re-renders several times a second, because the cart provider above it republishes its
  // value on a ticker, and an effect that depended on a function defined in the component body
  // would be torn down and re-armed on every one of those renders - the delay would never elapse
  // and the navigation would never happen. The timer is therefore driven by the draft, the pending
  // intent, the route and the router, and by nothing else.
  useEffect(() => {
    // Nothing outstanding: no keystroke has asked for a navigation since the last one was carried
    // out, which is also the state of a draft the reader never touched.
    if (intent === null) {
      return;
    }

    // The reader has gone somewhere else since they typed. The intent belonged to the route it was
    // typed on, so it is dropped here rather than re-armed against the new one: this effect re-runs
    // on a route change precisely so that it can let the queued navigation go, and a term asked for
    // on the cart must not pull a reader out of the product they opened next. Cleared rather than
    // merely skipped, so returning to that route later does not revive an instruction from before
    // the reader left it. Their next keystroke asks again, and the submit control asks immediately.
    if (intent !== pathname) {
      setIntent(null);

      return;
    }

    const term = searchDraft.trim();

    // What the address bar already carries, read from `window` rather than through the router's
    // search-parameter hook for the reason recorded at the top of this file. An effect only ever
    // runs in a browser, where this is the same answer for nothing.
    const current = new URLSearchParams(window.location.search).get(SEARCH_PARAM) ?? '';

    // A draft that already says what the address bar says asks for no navigation: this is the
    // state every navigation of this bar's own leaves behind, and the one a reader who typed a term
    // back to what it was returns to. The intent is satisfied, so it is spent rather than left
    // standing for whatever route the reader visits next.
    if (term === current) {
      setIntent(null);

      return;
    }

    const handle = setTimeout(() => {
      pending.current = null;

      // Spent as the navigation it asked for is made, so the route change that follows finds
      // nothing outstanding to re-arm.
      setIntent(null);

      const target = destination(window.location.search, term);

      // Typing on the catalog rewrites the entry rather than stacking one per word, so Back still
      // leads to the page the reader came from; arriving from another route is a real move and
      // keeps its place in the history.
      if (pathname === CATALOG_PATH) {
        router.replace(target);
      } else {
        router.push(target);
      }
    }, SEARCH_DEBOUNCE_MS);

    pending.current = handle;

    // The next keystroke, a route change and an unmount all cancel a navigation that has not
    // happened yet, so nothing this bar queued can arrive after the reader has moved on. On a route
    // change the guard above is what keeps it cancelled: this cleanup drops the timer, and the run
    // that follows it finds the intent and the route disagreeing and arms nothing in its place.
    return () => {
      clearTimeout(handle);
      pending.current = null;
    };
  }, [searchDraft, intent, pathname, router]);

  /**
   * Sends the trimmed term to the catalog immediately, keeping the parameters that still apply.
   *
   * The immediate path, and the one that works without JavaScript at all: a reader who presses
   * Enter or the submit control has asked for the results now rather than in a third of a second,
   * so the pending debounce is dropped first and this navigation is the only one that happens. The
   * address is built by the module-scope helper, so the two paths cannot land anywhere different.
   *
   * The current parameters are read from the address bar here rather than through a hook, for the
   * reason recorded at the top of this file - a submit only ever happens in a browser, never while
   * markup is being produced.
   */
  const handleSearchSubmit = (event: FormEvent<HTMLFormElement>): void => {
    // The router owns the navigation; letting the browser submit the form as well would reload the
    // page underneath it.
    event.preventDefault();

    // Cancelled synchronously, in this turn: a timer left armed would navigate again a moment
    // after the reader's own navigation, undoing wherever they had got to by then. The intent goes
    // with it, because this handler is about to carry out the very thing it was standing for.
    if (pending.current !== null) {
      clearTimeout(pending.current);
      pending.current = null;
    }

    setIntent(null);

    // The disclosure has done its job once the term is on its way, and the panel it opened covers
    // the first line of the results the reader is being sent to. Focus goes back to the control
    // first, as it does on Escape, so it is not left on a submit button the stylesheet stops
    // drawing - which would drop it to the document. Guarded on the state, so a submit in the wide
    // layout, where the form is in the row and the control is not drawn at all, is untouched.
    if (searchOpen) {
      toggle.current?.focus();
      setSearchOpen(false);
    }

    router.push(destination(window.location.search, searchDraft.trim()));
  };

  return (
    <header className={clsx(styles.root, className)}>
      <div className={styles.inner}>
        {/* First in the bar, and therefore the document's first tab stop. */}
        <a className={styles.skipLink} href={SKIP_LINK_TARGET}>
          {SKIP_LINK_LABEL}
        </a>

        <Link href={CATALOG_PATH} className={styles.brand}>
          {/* Intrinsic dimensions as attributes: the box is reserved before the file arrives. */}
          <img
            className={styles.logo}
            src={LOGO_SOURCE}
            alt={BRAND_NAME}
            width={LOGO_WIDTH}
            height={LOGO_HEIGHT}
          />
        </Link>

        {/* `role="search"` makes the form a landmark a reader can jump to; it holds one field and
            one control, and it navigates rather than fetching.

            It keeps its `id` and its place in the markup at every width: the stylesheet decides
            whether it sits in the row or in the panel the disclosure reveals, so the `id` the
            toggle names always belongs to a form that exists. `data-open` is what the stylesheet
            reads, and `'false'` is written out rather than left off so the closed state is as
            explicit in the markup as the open one. */}
        <form
          role="search"
          id={SEARCH_FORM_ID}
          className={styles.search}
          data-open={searchOpen ? 'true' : 'false'}
          onSubmit={handleSearchSubmit}
          // Escape, handled where the focus already is - anywhere inside the form. The guard on
          // `searchOpen` keeps a key press with nothing to close from queueing a state update that
          // would change nothing, which above the breakpoint is every press: the form is in the row
          // there and the toggle the focus would return to is not drawn at all.
          onKeyDown={(event) => {
            if (!searchOpen || event.key !== CLOSE_KEY) {
              return;
            }

            // Focus first, close second. React holds the state update until this handler returns,
            // so the move lands while the toggle is still the control it was pressed from.
            toggle.current?.focus();
            setSearchOpen(false);
          }}
        >
          {/* A real label, collapsed rather than replaced by the placeholder: a placeholder
              disappears the moment the reader types, and the field's name has to outlast that. */}
          <VisuallyHidden>
            <label htmlFor={SEARCH_FIELD_ID}>{SEARCH_LABEL}</label>
          </VisuallyHidden>

          {/* Placement only - the field's border, background and focus ring are `Input`'s. */}
          <div className={styles.searchField}>
            <Input
              // `Input` extends `ComponentPropsWithRef<'input'>` and spreads the rest of its props
              // onto its `<input>`, so React 19 delivers this straight to the element and no
              // `forwardRef` is involved.
              ref={field}
              id={SEARCH_FIELD_ID}
              name={SEARCH_PARAM}
              type="search"
              value={searchDraft}
              placeholder={SEARCH_LABEL}
              // The draft, plus the intent the debounce acts on: this keystroke, on this route.
              // Both are set from the same event, so the intent can never lag the value it stands
              // for, and recording the route here is what lets the effect tell a term still being
              // typed from one the reader left behind when they navigated. An inline arrow, like
              // every other handler in this bar.
              onChange={(event) => {
                setSearchDraft(event.target.value);
                setIntent(pathname);
              }}
            />
          </div>

          {/* `Button` defaults to `type="button"`, so a control that is meant to submit says so. */}
          <div className={styles.searchSubmit}>
            <Button type="submit" variant="secondary" size="md">
              {SEARCH_WORD}
            </Button>
          </div>
        </form>

        {/* The strip, on a product route and once the page has published which product it is. Both
            conditions matter: the route is what makes suggestions relevant, and the id is what the
            endpoint identifies a product by. */}
        {isProductRoute(pathname) && activeProductId !== null ? (
          <div className={styles.miniRail}>
            <RecommendationsRail productId={activeProductId} variant="compact" />
          </div>
        ) : null}

        <div className={styles.actions}>
          {/* The compact disclosure's control, first in the trailing cluster so a reader meets it
              before the cart. Placement only - the control's own appearance is `Button`'s, and the
              stylesheet drops this wrapper entirely above the narrow breakpoint, where the form is
              already in the row and there is nothing to disclose. The visible word is the short
              one and the label the fuller one, so the name a reader hears contains the name a
              reader sees. */}
          <div className={styles.searchToggle}>
            <Button
              // `Button` extends `ComponentPropsWithRef<'button'>`, so this reaches the element
              // the same way the field's ref does.
              ref={toggle}
              variant="ghost"
              size="md"
              aria-label={SEARCH_LABEL}
              aria-expanded={searchOpen}
              aria-controls={SEARCH_FORM_ID}
              onClick={() => {
                setSearchOpen((value) => !value);
              }}
            >
              {SEARCH_WORD}
            </Button>
          </div>

          <div className={styles.cartButton}>
            <Button
              variant="ghost"
              size="md"
              aria-haspopup="dialog"
              aria-expanded={cartOpen}
              onClick={() => {
                setCartOpen(true);
              }}
            >
              {CART_WORD}

              {/* Inside the control, so the count is part of the name a reader hears on every
                  focus - not a fact a neighbouring region stated once, when it last changed. */}
              <VisuallyHidden>{detail}</VisuallyHidden>
            </Button>

            {/* The chip, hidden from assistive technology because the control's own name and the
                region below already carry this figure - a third reading of it would be heard twice
                over. Wrapped for it: `Badge` takes a label, a tone, a size and a class. The
                class travels through `clsx` because a CSS Module lookup is `string | undefined`
                under `noUncheckedIndexedAccess`, which this workspace's `exactOptionalPropertyTypes`
                will not hand to an optional `string` - the same composition every other caller of a
                primitive in this application uses, and no assertion. */}
            {summary.contentsKnown && !summary.isCartEmpty ? (
              <span aria-hidden="true">
                <Badge tone="info" size="sm" className={clsx(styles.cartBadge)}>
                  {formatQuantityLabel(summary.unitCount)}
                </Badge>
              </span>
            ) : null}
          </div>

          {/* The announcement of a change, kept alongside the name above: the name answers "what
              is in the cart now" whenever a reader asks, and this speaks the moment the answer
              moves. Built from the cart's count alone, so it speaks when the cart changes and not
              when anything else this bar reads does.

              The region is mounted in every state and carries the sentence only while there is an
              established count to carry - a region inserted at the moment its message appears is
              not reliably announced, and a zero the storefront never read is not a figure to
              announce. Until then it is empty, the way the cart list's own status region is: the
              control's name is what says which of "loading" and "unavailable" the cart is in, once
              a reader asks it. */}
          <VisuallyHidden>
            <span role="status" aria-live="polite">
              {summary.contentsKnown
                ? `${formatQuantityLabel(summary.unitCount)}${CART_COUNT_SUFFIX}`
                : null}
            </span>
          </VisuallyHidden>
        </div>
      </div>

      {/* Always rendered and always controlled: it draws nothing while closed, and it portals its
          own markup to the end of the document rather than painting it inside this bar. */}
      <CartDrawer
        open={cartOpen}
        onClose={() => {
          setCartOpen(false);
        }}
      />
    </header>
  );
}
