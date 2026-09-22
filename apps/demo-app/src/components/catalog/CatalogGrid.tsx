'use client';

/**
 * Lumen Supply - the catalog listing's interactive surface.
 *
 * One page of products, with the controls a buyer uses to narrow it: the search and sort toolbar
 * above, the category chip row beneath it, the grid of product cards, and the pager that moves
 * between pages. The page that mounts this component fetches the products and the categories and
 * writes the heading; everything below the heading belongs here.
 *
 * WHAT IT OWNS, AND WHAT IT DOES NOT
 * The component owns exactly four values - the search text, the active category, the ordering and
 * which card has its quick specifications open - and each of them is a property of the listing in
 * front of the reader rather than of the catalog as a whole. Everything else arrives as props, and
 * nothing here requests, caches or stores anything: the toolbar and the chip row are pure control
 * surfaces that report a change and are handed the new value back, and the cards take a product and
 * two handlers.
 *
 * FILTERING IS LOCAL; PAGING IS NOT
 * The search term, the category and the ordering narrow and reorder the page that was handed over,
 * in the browser, without an address change or a request - which is what makes a chip press or a
 * keystroke feel immediate. Moving to another page is the opposite: a different page is a different
 * set of rows, so `CatalogPager` writes the page number into the query string and the server answers
 * with that page. That split is why this file navigates nowhere and holds no page number of its own.
 *
 * THE TWO DERIVATIONS ARE PURE AND LIVE AT MODULE SCOPE
 * `filterProducts` and `sortProducts` are ordinary functions of their arguments, declared outside
 * the component so they can be read - and reasoned about - without the surrounding render. Both take
 * their list as `readonly`, and `sortProducts` copies before ordering, so the array the page owns is
 * never rearranged underneath it. Every ordering ends in the product id, which is what makes the
 * result of a sort the same list every time rather than one of several orderings of equally ranked
 * products.
 *
 * COMPOSED FROM THIS FOLDER AND THE SHARED PRIMITIVES
 * The five children come from this folder, the error notice is `@/components/ui/Alert` and the
 * control inside the blank slate is `@/components/ui/Button`; `CatalogGrid.module.css` places them
 * and states no colour, border or font of its own. The grid itself is a real list - a `<ul>` of
 * `<li>` cells whose marker and padding the stylesheet resets - so a reader is told how many
 * products are in it, and the section carries one accessible name for the whole surface.
 *
 * NOTHING HERE VARIES BETWEEN THE SERVER'S MARKUP AND THE BROWSER'S FIRST RENDER
 * The four initial values are constants - an empty search, no category, the listing's default
 * ordering and no open card - and no clock, random number, ambient locale or document is read while
 * rendering. The first render in the browser therefore reproduces the markup the server sent, which
 * is the property that keeps hydration quiet.
 */

import { useState } from 'react';

import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import type { CatalogSort, CategoryOption, PagedList, ProductSummary } from '@/lib/types';

import { CatalogEmptyNotice } from './CatalogEmptyNotice';
import { CatalogPager } from './CatalogPager';
import { CatalogToolbar } from './CatalogToolbar';
import { CategoryFilterChips } from './CategoryFilterChips';
import { ProductCard } from './ProductCard';

import styles from './CatalogGrid.module.css';

/**
 * The catalog surface's props: one page of products, the categories its chip row offers, and an
 * optional message describing a load that did not finish.
 *
 * `categories` is `readonly` because the row below only reads the list, so the page may hand over
 * the array it already holds without copying it first.
 *
 * `loadError` spells `undefined` out in its type rather than relying on the bare `?`. The workspace
 * compiles with `exactOptionalPropertyTypes`, under which an optional property does not accept an
 * explicit `undefined`; the wider union lets the page forward the value it computed - a string on
 * the failure path, nothing on the ordinary one - without assembling the props object conditionally.
 */
export interface CatalogGridProps {
  /** One page of products, exactly as the catalog listing returned it. */
  products: PagedList<ProductSummary>;

  /** Every category the chip row offers, in the order the reader sees them. */
  categories: readonly CategoryOption[];

  /**
   * Reader-facing copy for a page of products that could not be loaded, or `null` / absent when the
   * listing arrived intact. Rendered above the grid, which still shows whatever did arrive.
   */
  loadError?: string | null | undefined;
}

/**
 * How many products one page of the listing shows.
 *
 * The same page size the catalog query applies by default, stated here as a literal because this
 * folder reads no module from the server layer. It caps the list this component renders, so a page
 * narrowed in the browser can never show more cards than the page the server answered with.
 */
const CATALOG_PAGE_SIZE = 48;

/** The ordering a listing opens with: the catalog's own order, which is also the server's default. */
const DEFAULT_CATALOG_SORT: CatalogSort = 'featured';

/**
 * Compare two strings by code point.
 *
 * Deliberately not `localeCompare`, and no `Intl.Collator`: both read an ambient locale, so the
 * order they produce depends on where the code runs. A comparison that cannot differ between the
 * server and the browser is what keeps a sorted list from being rearranged during hydration, and it
 * is what makes the tie-breaker below a total order rather than an approximation of one.
 */
function compareCatalogText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

/**
 * The products of `items` a reader searching for `searchText` inside `categorySlug` should see.
 *
 * The term is trimmed and lower-cased once, then matched against the product's name, its product
 * code and its category's label, so a buyer who knows any one of the three finds the product. An
 * empty or whitespace-only term matches everything, which is how "stop searching" is expressed, and
 * a `null` category means the listing is unfiltered. When neither narrows anything the list is
 * returned as it stands rather than copied.
 */
function filterProducts(
  items: readonly ProductSummary[],
  searchText: string,
  categorySlug: string | null,
): readonly ProductSummary[] {
  const term = searchText.trim().toLowerCase();

  if (term.length === 0 && categorySlug === null) {
    return items;
  }

  return items.filter((product) => {
    if (categorySlug !== null && product.categorySlug !== categorySlug) {
      return false;
    }

    if (term.length === 0) {
      return true;
    }

    return (
      product.name.toLowerCase().includes(term) ||
      product.sku.toLowerCase().includes(term) ||
      product.categoryName.toLowerCase().includes(term)
    );
  });
}

/**
 * The products of `items` in the order `sort` asks for.
 *
 * The list is copied before it is ordered, so the array the page owns keeps the order the server
 * chose. Prices are compared as the whole numbers of cents they are stored as - no amount is
 * divided, rounded or reformatted to be ranked - and names are compared lower-cased so that a
 * capitalised product code in a name does not sort a product away from its neighbours.
 *
 * Every ordering breaks a tie on the product id, exactly as the catalog's own query does, so two
 * products of the same price or the same name keep one fixed order however often the list is
 * rebuilt. `featured` is the catalog's own order, which arrives already applied - the summary a card
 * is built from carries no listing date to re-derive it from - so that case hands the page back in
 * the order it was given. The `return` after the switch is the same answer for a stored value the
 * union has since outgrown.
 */
function sortProducts(
  items: readonly ProductSummary[],
  sort: CatalogSort,
): readonly ProductSummary[] {
  const copy = [...items];

  switch (sort) {
    case 'price_asc':
      return copy.sort((left, right) => {
        const priceOrder = left.priceCents - right.priceCents;
        return priceOrder === 0 ? compareCatalogText(left.id, right.id) : priceOrder;
      });
    case 'price_desc':
      return copy.sort((left, right) => {
        const priceOrder = right.priceCents - left.priceCents;
        return priceOrder === 0 ? compareCatalogText(left.id, right.id) : priceOrder;
      });
    case 'name_asc':
      return copy.sort((left, right) => {
        const productNameOrder = compareCatalogText(
          left.name.toLowerCase(),
          right.name.toLowerCase(),
        );
        return productNameOrder === 0 ? compareCatalogText(left.id, right.id) : productNameOrder;
      });
    case 'featured':
      return copy;
  }

  return copy;
}

/**
 * Render the catalog surface.
 *
 * Each card's two handlers are declared where the card is, because the values they report are that
 * card's own: pressing a card's specifications toggle opens it and pressing it again closes it, and
 * pressing a card's category chip filters the listing to that category or clears a filter already
 * set on it. Both read the same comparison the card's `selected` and `categoryActive` props do, so
 * what a card shows and what a press reports can never disagree.
 *
 * `handleClearFilters` returns all four values to the state a listing opens in, which is what the
 * control in the blank slate below does: the reader who filtered their way to nothing gets the full
 * page back in one press.
 *
 * @example
 * ```tsx
 * <CatalogGrid products={products} categories={categories} />
 * <CatalogGrid products={emptyPage} categories={categories} loadError="We could not load the catalog just now." />
 * ```
 */
export function CatalogGrid({ products, categories, loadError }: CatalogGridProps) {
  const [searchText, setSearchText] = useState('');
  const [activeCategorySlug, setActiveCategorySlug] = useState<string | null>(null);
  const [sort, setSort] = useState<CatalogSort>(DEFAULT_CATALOG_SORT);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  const derived = sortProducts(
    filterProducts(products.items, searchText, activeCategorySlug),
    sort,
  ).slice(0, CATALOG_PAGE_SIZE);

  /*
   * The active category's label, for the blank slate's sentence. `find` answers `undefined` for a
   * listing with no filter and for a slug the page's category list does not offer - a stale link,
   * say - and both mean "no category to name", so the value is read that way rather than asserted.
   */
  const activeCategoryOption = categories.find((category) => category.slug === activeCategorySlug);
  const activeCategoryName =
    activeCategoryOption === undefined ? undefined : activeCategoryOption.name;

  /*
   * An absent message and an empty one both mean the page arrived intact. The length check is
   * deliberate rather than a truthiness test, so an empty string cannot put an alert with no words
   * in it above the grid.
   */
  const catalogLoadError =
    loadError !== null && loadError !== undefined && loadError.length > 0 ? loadError : undefined;

  function handleClearFilters(): void {
    setSearchText('');
    setActiveCategorySlug(null);
    setSort(DEFAULT_CATALOG_SORT);
    setSelectedSlug(null);
  }

  return (
    <section className={styles.root} aria-label="Product catalog">
      <CatalogToolbar
        searchText={searchText}
        onSearchTextChange={setSearchText}
        sort={sort}
        onSortChange={setSort}
        visibleCount={derived.length}
        totalCount={products.total}
      />

      <div className={styles.filters}>
        <CategoryFilterChips
          categories={categories}
          activeSlug={activeCategorySlug}
          onSelect={setActiveCategorySlug}
        />
      </div>

      {catalogLoadError === undefined ? null : (
        <div className={styles.notice}>
          <Alert tone="danger" title="Some products could not be loaded">
            {catalogLoadError}
          </Alert>
        </div>
      )}

      {derived.length === 0 ? (
        <div className={styles.notice}>
          <CatalogEmptyNotice
            reason={products.items.length === 0 ? 'empty-catalog' : 'no-matches'}
            searchText={searchText}
            categoryName={activeCategoryName}
            action={
              <Button variant="secondary" size="sm" onClick={handleClearFilters}>
                Clear filters
              </Button>
            }
          />
        </div>
      ) : (
        <ul className={styles.grid}>
          {derived.map((product) => (
            <li key={product.id} className={styles.cell}>
              <ProductCard
                product={product}
                selected={product.slug === selectedSlug}
                categoryActive={product.categorySlug === activeCategorySlug}
                onSelect={() =>
                  setSelectedSlug(product.slug === selectedSlug ? null : product.slug)
                }
                onCategorySelect={() =>
                  setActiveCategorySlug(
                    product.categorySlug === activeCategorySlug ? null : product.categorySlug,
                  )
                }
              />
            </li>
          ))}
        </ul>
      )}

      <CatalogPager page={products.page} pageSize={products.pageSize} total={products.total} />
    </section>
  );
}
