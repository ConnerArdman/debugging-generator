'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useSyncExternalStore, type FormEvent, type ReactElement } from 'react';

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
 * It places five things and nothing else: the "Skip to content" link, the brand lockup that leads
 * home, the search form, a short strip of suggestions while a product is on screen, and the cart
 * control with the count beside it. The sheet that control opens is `@/components/cart/CartDrawer`,
 * rendered here and portalled out of this subtree by that component.
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
 * Submitting the field sends the reader to the catalog with the term in the URL. This bar asks the
 * server for nothing and renders no results: the catalog page reads the term from its own search
 * parameters and is the single place a product query is run, so a second reader of that endpoint up
 * here would put two answers to one question on the page.
 *
 * The parameters that survive a submit are read from the address bar inside the submit handler,
 * rather than through the router's search-parameter hook. Reading them with that hook opts every
 * route this bar renders into dynamic rendering, including the ones Next.js prerenders
 * (`app/not-found.tsx`, `app/error.tsx`), which would cost `next build` its static output for a
 * value needed only at the moment the form is submitted - and a submit only ever happens in a
 * browser, where `window.location.search` answers the same question for nothing. The submitted key is `search`, the name `CatalogQuery` gives a catalog's text query,
 * and the field's native `name` is that same key so a submit without JavaScript produces the URL
 * the catalog expects. `page` is dropped, because a new term starts at the first page of results;
 * every other parameter - the category, the sort order - travels untouched, so searching inside a
 * category stays inside it.
 *
 * THE CART CONTROL
 * `@/hooks/useCartSummary` is where the figures come from, so the count up here and the totals in
 * the sheet, on `/cart` and in the checkout summary are all the same arithmetic over the same
 * lines. The boolean that opens the sheet lives here because the control that sets it does;
 * everything else about that dialog - its role, its label, the focus it takes on the way in, the
 * focus it hands back on the way out, the trap while it is open, Escape, the scrim - belongs to
 * `CartDrawer`, and `onClose` does nothing but turn the boolean off.
 *
 * The count is announced from a region built out of the cart's own figures and nothing else. The
 * bar reads other published values as well, and a region whose text quoted one of those would speak
 * again whenever that value moved, with nothing about the cart having changed; a count-derived
 * string speaks when - and only when - the cart does. The chip that prints the same number is
 * hidden from assistive technology so the figure is not heard twice, and it is wrapped for that
 * rather than given an attribute, because `ui/Badge` takes a label, a tone, a size and a class and
 * nothing else. A static wrapper is not a containing block, so the chip still positions itself
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
 * on both axes rather than in a second row, and nothing in this file sets a height, an inline style
 * or a second row of its own.
 *
 * CLASS CONTRACT
 * `SiteHeader.module.css` defines twelve classes and this file uses all twelve - `skipLink`, `root`,
 * `inner`, `brand`, `logo`, `search`, `searchField`, `searchSubmit`, `miniRail`, `actions`,
 * `cartButton` and `cartBadge` - composed with `clsx` and never with an inline `style`. The three
 * wrappers exist because the primitives inside them own their own chrome and the geometry around
 * them has to live on an element of this file's own.
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

/** The field's accessible name, and the placeholder that repeats it once the label is collapsed. */
const SEARCH_LABEL = 'Search products';

/** The word on the submit control. */
const SEARCH_WORD = 'Search';

/**
 * The search parameter a term is submitted as - the name `CatalogQuery` gives a catalog's text
 * query, and the one the catalog page's validation reads. It is also the field's native `name`, so
 * a form submitted without JavaScript lands on the same URL this file's handler builds.
 */
const SEARCH_PARAM = 'search';

/** The paging parameter, dropped on submit because a new term starts at the first page. */
const PAGE_PARAM = 'page';

/** The word on the cart control, which is its whole accessible name. */
const CART_WORD = 'Cart';

/**
 * What follows the count in the announcement, so the region reads "12 in cart". The leading space
 * is part of the string: the number is interpolated immediately before it.
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
 * Props of this component, kept local to it: nothing outside needs to name this shape, and a
 * second, exported name for "an optional class" would spend vocabulary for nothing.
 */
interface Props {
  /** Extra class for the `<header>` element, composed after the module's own `root` class. */
  className?: string;
}

/**
 * The storefront's top bar: skip link, brand, search, the suggestions strip for the product on
 * screen, and the cart control with the sheet it opens.
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

  // Whether the cart sheet is on screen. Owned here because the control that opens it is here.
  const [cartOpen, setCartOpen] = useState(false);

  // The cart's figures, summed in one place for every surface that quotes them.
  const summary = useCartSummary();

  // The product the reader is on, as the product page published it, or `null` anywhere else.
  const activeProductId = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  /**
   * Sends the trimmed term to the catalog, keeping the parameters that still apply.
   *
   * The current parameters are read from the address bar here rather than through a hook, for the
   * reason recorded at the top of this file, and this is the only code in the bar that reads a
   * browser global - it runs when a reader submits, never while markup is being produced.
   */
  const handleSearchSubmit = (event: FormEvent<HTMLFormElement>): void => {
    // The router owns the navigation; letting the browser submit the form as well would reload the
    // page underneath it.
    event.preventDefault();

    const term = searchDraft.trim();
    const params = new URLSearchParams(window.location.search);

    // An empty field clears the term rather than searching for nothing, so the reader lands on the
    // unfiltered catalog instead of on a query no product can match.
    if (term === '') {
      params.delete(SEARCH_PARAM);
    } else {
      params.set(SEARCH_PARAM, term);
    }

    // A new term starts at the first page; the category and the sort order are left alone.
    params.delete(PAGE_PARAM);

    const query = params.toString();

    router.push(query === '' ? CATALOG_PATH : `${CATALOG_PATH}?${query}`);
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
            one control, and it navigates rather than fetching. */}
        <form role="search" className={styles.search} onSubmit={handleSearchSubmit}>
          {/* A real label, collapsed rather than replaced by the placeholder: a placeholder
              disappears the moment the reader types, and the field's name has to outlast that. */}
          <VisuallyHidden>
            <label htmlFor={SEARCH_FIELD_ID}>{SEARCH_LABEL}</label>
          </VisuallyHidden>

          {/* Placement only - the field's border, background and focus ring are `Input`'s. */}
          <div className={styles.searchField}>
            <Input
              id={SEARCH_FIELD_ID}
              name={SEARCH_PARAM}
              type="search"
              value={searchDraft}
              placeholder={SEARCH_LABEL}
              onChange={(event) => {
                setSearchDraft(event.target.value);
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
            </Button>

            {/* The chip, hidden from assistive technology because the region below announces the
                same figure. Wrapped for it: `Badge` takes a label, a tone, a size and a class. The
                class travels through `clsx` because a CSS Module lookup is `string | undefined`
                under `noUncheckedIndexedAccess`, which this workspace's `exactOptionalPropertyTypes`
                will not hand to an optional `string` - the same composition every other caller of a
                primitive in this application uses, and no assertion. */}
            {summary.isCartEmpty ? null : (
              <span aria-hidden="true">
                <Badge tone="info" size="sm" className={clsx(styles.cartBadge)}>
                  {formatQuantityLabel(summary.unitCount)}
                </Badge>
              </span>
            )}
          </div>

          {/* Built from the cart's count alone, so it speaks when the cart changes and not when
              anything else this bar reads does. */}
          <VisuallyHidden>
            <span role="status" aria-live="polite">
              {`${formatQuantityLabel(summary.unitCount)}${CART_COUNT_SUFFIX}`}
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
