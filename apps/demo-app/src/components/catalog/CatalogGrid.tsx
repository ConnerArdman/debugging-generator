'use client';

/**
 * Lumen Supply - the catalog listing's interactive surface.
 *
 * One page of products, with the controls a buyer uses to narrow it: the search and sort toolbar
 * above, the category chip row beneath it, the grid of product cards, and the pager that moves
 * between pages. The page that mounts this component reads the products and the categories and
 * writes the heading; everything below the heading belongs here.
 *
 * THE ADDRESS IS THE LISTING, AND THIS FILE KEEPS NO SECOND COPY OF IT
 * The search term, the category and the ordering belong to the query string. The page parses them
 * and hands them down as `query`, and a control the reader changes does exactly one thing: it
 * writes a new address, which the server answers with the page that address describes. Nothing here
 * filters, reorders or trims what arrived, because what arrived is one page of a query that was
 * already filtered, ordered and counted - narrowing it again in the browser would leave the cards
 * showing one listing while the count beside them and the pager below them describe another.
 *
 * WHAT IT OWNS
 * Two values, and neither is a property of the catalog: which card has its quick specifications
 * open, and the term sitting in the search field before the reader applies it. The first is local
 * by nature. The second is the ordinary courtesy of a search box - a term is applied when the
 * reader says so rather than on every keystroke, which would ask the server for a listing per
 * character - and it is returned to the applied term whenever the address changes, so the field can
 * never disagree with the listing for longer than the navigation it is waiting for.
 *
 * PAGING IS THE PAGER'S, AND EVERY OTHER CHANGE RETURNS TO THE FIRST PAGE
 * `CatalogPager` writes the page parameter; this file never does. That is a rule rather than a gap:
 * page four of one filter is not page four of another, so a changed term, category or ordering asks
 * for the first page of the new listing by leaving the parameter out and letting the catalog
 * query's own default apply - the same rule the inventory dashboard's filter row follows.
 *
 * THE PARAMETER NAMES ARE THE SERVER'S
 * Every key written below is a parameter of the one catalog query the endpoint and the page both
 * parse with the same schema. The two the toolbar's own fields submit are imported from that
 * component, which owns those fields; the rest are restated here as named constants, because this
 * folder reads no module from the server layer. A parameter is written only when it constrains
 * something, so the unfiltered catalog in its own order is addressed by the bare path.
 *
 * COMPOSED FROM THIS FOLDER AND THE SHARED PRIMITIVES
 * The five children come from this folder and the control inside the blank slate is
 * `@/components/ui/Button`; `CatalogGrid.module.css` places them and states no colour, border or
 * font of its own. The grid itself is a real list - a `<ul>` of `<li>` cells whose marker and
 * padding the stylesheet resets - so a reader is told how many products are in it, and the section
 * carries one accessible name for the whole surface.
 *
 * NOTHING HERE VARIES BETWEEN THE SERVER'S MARKUP AND THE BROWSER'S FIRST RENDER
 * Every value rendered is derived from the props - the page of products and the query it was read
 * under - and no clock, random number, ambient locale, address bar or document is read while
 * rendering. The first render in the browser therefore reproduces the markup the server sent, which
 * is the property that keeps hydration quiet.
 */

import { usePathname, useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/Button';
import type {
  CatalogQuery,
  CatalogSort,
  CategoryOption,
  PagedList,
  ProductSummary,
} from '@/lib/types';

import { CatalogEmptyNotice } from './CatalogEmptyNotice';
import type { CatalogEmptyNoticeProps } from './CatalogEmptyNotice';
import { CatalogPager } from './CatalogPager';
import {
  CATALOG_SEARCH_MAX_LENGTH,
  CATALOG_SEARCH_PARAM,
  CATALOG_SORT_PARAM,
  CatalogToolbar,
} from './CatalogToolbar';
import { CategoryFilterChips } from './CategoryFilterChips';
import { ProductCard } from './ProductCard';

import styles from './CatalogGrid.module.css';

/**
 * The catalog query the page of products beside these controls was read under: the two filters a
 * reader can set (`search`, `categorySlug`) and the ordering in force (`sort`).
 *
 * Derived from `CatalogQuery` in `@/lib/types` rather than declared again. That type is the one
 * statement of the catalog's query vocabulary - the endpoint's schema, the browser client and the
 * services all read their parameter names and member types from it - so taking these three members
 * from it means a renamed or retyped parameter is a compile error here instead of a control that
 * quietly writes a key nobody parses. The members are mapped rather than `Pick`ed so that each
 * filter can add `| undefined` back to the type the query declares: this workspace compiles with
 * `exactOptionalPropertyTypes`, under which a mapped `?` member accepts an absent key but not an
 * explicit `undefined`, and the page forwards exactly what it parsed - a value, or `undefined` -
 * rather than assembling this object conditionally. `sort` is the one member a listing always has,
 * because the query schema defaults it, so the absence the query type allows is removed here.
 *
 * The page window is deliberately absent: `products` already carries the page and the page size the
 * answer was built with, and one fact stated twice is a fact that can disagree with itself.
 */
export type CatalogGridQuery = {
  readonly [K in 'search' | 'categorySlug']?: CatalogQuery[K] | undefined;
} & {
  readonly sort: NonNullable<CatalogQuery['sort']>;
};

/**
 * The catalog surface's props: one page of products, the categories its chip row offers, and the
 * query that produced that page.
 *
 * All three describe one read, which is the whole point of passing the query down: the toolbar, the
 * chips and the pager show the term, the filter, the ordering and the page the products beside them
 * were actually read under, so a control can never claim one listing while a count describes
 * another.
 *
 * `categories` is `readonly` because the row below only reads the list, so the page may hand over
 * the array it already holds without copying it first.
 *
 * There is no message prop for a listing that did not arrive. A failed read produces no page of
 * products to draw controls, counts and a pager around, so the page renders its own notice in place
 * of this component rather than handing it an invented empty page - which is what kept "the catalog
 * is empty" and "the catalog could not be read" from being told apart here.
 */
export interface CatalogGridProps {
  /** One page of products, exactly as the catalog listing returned it. */
  products: PagedList<ProductSummary>;

  /** Every category the chip row offers, in the order the reader sees them. */
  categories: readonly CategoryOption[];

  /** The catalog query the page parsed, applied, and read `products` with. */
  query: CatalogGridQuery;
}

/**
 * The catalog query's category parameter, as the endpoint and the page both parse it.
 *
 * Restated here rather than imported: this folder reads no module from the server layer, and the
 * schema that declares the parameter lives there. The two parameters the toolbar's own fields carry
 * are imported from that component instead, so every key is declared exactly once.
 *
 * `satisfies keyof CatalogQuery` is what keeps the restatement honest without importing anything
 * from the server: a key the catalog's query vocabulary does not declare fails to compile here,
 * while the constant keeps its literal type. The same check guards the two below.
 */
const CATEGORY_PARAM = 'categorySlug' satisfies keyof CatalogQuery;

/** The catalog query's page-size parameter, for the same reason. */
const PAGE_SIZE_PARAM = 'pageSize' satisfies keyof CatalogQuery;

/**
 * The catalog query's page parameter.
 *
 * Written only when describing the address the reader is already at, and never into one a control
 * asks for: a changed term, category or ordering describes a different set of rows, so the new
 * listing starts at its first page, and leaving the parameter out is how the schema's default says
 * so.
 */
const PAGE_PARAM = 'page' satisfies keyof CatalogQuery;

/** The page every listing starts at, and the page a changed filter, term or ordering asks for. */
const FIRST_PAGE = 1;

/** The ordering a listing opens with: the catalog's own order, which is also the server's default. */
const DEFAULT_CATALOG_SORT: CatalogSort = 'featured';

/**
 * How many products one page of the catalog holds unless the address says otherwise.
 *
 * The catalog query's own default, stated here as a literal because this folder reads no module
 * from the server layer. It is used for one decision only - whether the page size has to be written
 * into an address at all - so a listing read at the default is addressed without the parameter, and
 * one the reader sized themselves keeps its size across a filter change.
 */
const DEFAULT_CATALOG_PAGE_SIZE = 48;

/**
 * A listing a set of controls asks for: what to search for, what to filter to, how to order.
 *
 * The three values a reader can change, in the form the controls hold them - an empty term rather
 * than an absent one, and `null` for "no category" - so a handler can name the single value it
 * changes and carry the other two over without knowing what they are.
 */
interface CatalogRequest {
  search: string;
  categorySlug: string | null;
  sort: CatalogSort;
}

/**
 * The highest code point the catalog query counts as a control character, and the delete character
 * that sits above the printable range.
 *
 * The two spans a search term may not contain, exactly as the query's schema states them. They are
 * named here rather than imported for the reason given with the parameters above, and the term is
 * cleaned by walking its code points rather than by matching a pattern - a pattern for these
 * characters would have to contain them, and the walk is free over a term bounded to eighty
 * characters. That is the same reading, and the same technique, the schema itself uses.
 */
const CONTROL = 0x1f;
const DELETE = 0x7f;

/**
 * The term `text` searches for, as it would reach the endpoint: every character the query refuses
 * replaced by a space, then cut to the length it accepts, then trimmed.
 *
 * Every step is a decision about the address rather than about the field, and together they are the
 * whole of what the catalog query asks of a search term. A term of nothing but spaces is not a
 * term; a term past the bound, or one carrying a control character - a tab or a newline pasted from
 * a spreadsheet cell or a wrapped document - would be refused by the schema, and a refused query is
 * answered with the *default* listing, discarding every filter the reader can see in front of them.
 * A control must never be able to produce one, so what cannot be sent is turned into a space rather
 * than dropped: a term stays two words when the separator between them was a tab.
 *
 * Cutting by UTF-16 units is deliberate, because that is the length the schema's own bound counts.
 */
function catalogSearchTerm(text: string): string {
  let sendable = '';

  for (const character of text) {
    const code = character.codePointAt(0);

    sendable += code === undefined || code <= CONTROL || code === DELETE ? ' ' : character;
  }

  return sendable.slice(0, CATALOG_SEARCH_MAX_LENGTH).trim();
}

/**
 * The query string a listing is addressed by: the parameters that constrain it, and nothing else.
 *
 * Four omissions, each a decision about the address. A term that searches for nothing is left out.
 * The catalog's own ordering and the default page size are left out, because the parameter would
 * say exactly what its absence already says, which is what keeps every ordinary catalog URL short.
 * And the page number is written only for a page past the first, so the first page of any listing is
 * the shortest address that listing has - which is also what makes this function usable for both
 * sides of a comparison: the address the reader is at, and the address a control is asking for.
 *
 * @param request What to search for, what to filter to and how to order.
 * @param pageSize How many products a page holds; omitted from the address when it is the default.
 * @param page The 1-based page to address; omitted when it is the first.
 * @returns The query string, without its leading `?`, and empty for the bare listing.
 */
function buildCatalogQuery(request: CatalogRequest, pageSize: number, page: number): string {
  const params = new URLSearchParams();
  const term = catalogSearchTerm(request.search);

  if (term.length > 0) {
    params.set(CATALOG_SEARCH_PARAM, term);
  }

  if (request.categorySlug !== null) {
    params.set(CATEGORY_PARAM, request.categorySlug);
  }

  if (request.sort !== DEFAULT_CATALOG_SORT) {
    params.set(CATALOG_SORT_PARAM, request.sort);
  }

  if (Number.isInteger(pageSize) && pageSize !== DEFAULT_CATALOG_PAGE_SIZE) {
    params.set(PAGE_SIZE_PARAM, String(pageSize));
  }

  if (Number.isInteger(page) && page > FIRST_PAGE) {
    params.set(PAGE_PARAM, String(page));
  }

  return params.toString();
}

/**
 * The applied query as the controls hold it: the filters the page parsed, with an absent filter
 * read as the value that stands for "not constrained" in a control rather than as an absence.
 */
function catalogRequestFor(query: CatalogGridQuery): CatalogRequest {
  return {
    search: query.search ?? '',
    categorySlug: query.categorySlug ?? null,
    sort: query.sort,
  };
}

/**
 * Render the catalog surface.
 *
 * Each card's two handlers are declared where the card is, because the values they report are that
 * card's own: pressing a card's specifications toggle opens it and pressing it again closes it, and
 * pressing a card's category chip asks for that category's listing or clears a filter already set
 * on it. Both read the same comparison the card's `selected` and `categoryActive` props do, so what
 * a card shows and what a press asks for can never disagree.
 *
 * @example
 * ```tsx
 * <CatalogGrid products={products} categories={categories} query={{ sort: 'featured' }} />
 * ```
 */
export function CatalogGrid({ products, categories, query }: CatalogGridProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  // The listing in front of the reader, and the address it is at - the one the controls describe and
  // the one a request is compared against before it is made.
  const applied = catalogRequestFor(query);
  const appliedCatalogQuery = buildCatalogQuery(applied, products.pageSize, products.page);

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState(applied.search);
  const [shownCatalogQuery, setShownCatalogQuery] = useState(appliedCatalogQuery);
  const [requestedCatalogQuery, setRequestedCatalogQuery] = useState<string | null>(null);

  /*
   * The address changed, so this surface catches up with it: the field returns to the term now in
   * force - the applied term after a step back through the history, and the trimmed, bounded form of
   * whatever was typed after a search - and nothing is outstanding any more, because what was asked
   * for has arrived, or the reader has gone somewhere else entirely.
   *
   * Adjusted while rendering rather than from an effect: React discards this render and re-runs the
   * component with the new values before anything reaches the browser, so no intermediate state is
   * ever shown, and no dependency list stands between the address and the field that describes it.
   */
  if (shownCatalogQuery !== appliedCatalogQuery) {
    setShownCatalogQuery(appliedCatalogQuery);
    setSearchDraft(applied.search);
    setRequestedCatalogQuery(null);
  } else if (requestedCatalogQuery !== null && !pending) {
    /*
     * A request settled on the address it started from: the server answered the query it could
     * parse rather than the one that was asked for, so the listing on screen is not the listing the
     * request described. Nothing is outstanding any more either way, and the field follows what
     * actually arrived rather than holding a term the listing beside it does not reflect. Reaching
     * this needs the endpoint to refuse something a control produced, which the normalisation above
     * is written to prevent; it is here so that a term this file cannot foresee resolves in favour
     * of the server's answer instead of leaving the two disagreeing.
     */
    setRequestedCatalogQuery(null);
    setSearchDraft(applied.search);
  }

  /*
   * What the controls hold right now: the applied category and ordering, and the term in the field
   * rather than the one in the address. A change to any one control therefore applies the term the
   * reader has typed as well, because the alternatives are to discard it or to leave it sitting in a
   * box in front of a listing it has nothing to do with.
   */
  const controls: CatalogRequest = { ...applied, search: searchDraft };

  /**
   * Show the listing `next` describes, by asking the router for its address.
   *
   * Nothing is asked for twice: a request for the address the reader is already at, or for the one
   * already on its way, only settles the field on the term that address carries. That is what makes
   * one intent one request - pressing Search twice, or pressing it on a term already applied, asks
   * the server for nothing.
   *
   * `replace` rather than `push`: trying three filters in a row is one intent rather than three
   * pages to step back through, and the pager's ordinary anchors remain the history a reader steps
   * through. `scroll: false` keeps the reader's position, because the narrowed listing appears in
   * the same place on the page. The navigation runs inside a transition, so the listing on screen
   * stays legible while the server produces the next one instead of the region blanking.
   */
  function commit(next: CatalogRequest): void {
    const wantedCatalogQuery = buildCatalogQuery(next, products.pageSize, FIRST_PAGE);

    if (wantedCatalogQuery === (requestedCatalogQuery ?? appliedCatalogQuery)) {
      setSearchDraft(catalogSearchTerm(next.search));
      return;
    }

    setSearchDraft(next.search);
    setRequestedCatalogQuery(wantedCatalogQuery);

    const href = wantedCatalogQuery.length === 0 ? pathname : `${pathname}?${wantedCatalogQuery}`;

    startTransition(() => {
      router.replace(href, { scroll: false });
    });
  }

  /**
   * Ask for the listing the controls now describe, from its first page.
   *
   * The toolbar's submission and the control offered when the requested page lies past the end of a
   * listing are the same request: the term, filter and ordering the reader can see, at the page
   * every listing starts at.
   */
  function handleCatalogApply(): void {
    commit(controls);
  }

  function handleSortChange(sort: CatalogSort): void {
    commit({ ...controls, sort });
  }

  function handleCategorySelect(categorySlug: string | null): void {
    commit({ ...controls, categorySlug });
  }

  /** Back to the whole catalog in its own order, with no card's specifications left open. */
  function handleClearFilters(): void {
    setSelectedSlug(null);
    commit({ search: '', categorySlug: null, sort: DEFAULT_CATALOG_SORT });
  }

  /*
   * The active category's label, for the blank slate's sentence. `find` answers `undefined` for an
   * unfiltered listing and for a slug the page's category list does not offer - a stale link, say -
   * and both mean "no category to name", so the value is read that way rather than asserted.
   */
  const activeCategoryOption = categories.find(
    (category) => category.slug === applied.categorySlug,
  );
  const activeCategoryName =
    activeCategoryOption === undefined ? undefined : activeCategoryOption.name;

  /*
   * Whether the listing was narrowed at all. The ordering is not a filter - it rearranges a listing
   * and can never empty one - so it has no bearing on why a page has no products on it.
   */
  const narrowed = applied.search.length > 0 || applied.categorySlug !== null;

  /*
   * Why this page has no products on it, read from the answer's own count rather than from the
   * emptiness of its page. The three cases are genuinely different situations and leave the reader
   * genuinely different things to do: a query that matched rows the requested page lies past, a
   * query that matched none, and a catalog with nothing published in it at all.
   */
  let blankSlateReason: CatalogEmptyNoticeProps['reason'] = 'empty-catalog';
  if (products.total > 0) {
    blankSlateReason = 'page-past-end';
  } else if (narrowed) {
    blankSlateReason = 'no-matches';
  }

  /*
   * The way out of the situation the blank slate describes: the filters cleared for a query that
   * matched nothing, the first page for a page past the end of one that matched something, and
   * nothing at all for a catalog with nothing published in it - no control would help there, and
   * offering one would suggest otherwise.
   */
  let blankSlateAction: ReactNode;
  if (blankSlateReason === 'no-matches') {
    blankSlateAction = (
      <Button variant="secondary" size="sm" onClick={handleClearFilters}>
        Clear filters
      </Button>
    );
  } else if (blankSlateReason === 'page-past-end') {
    blankSlateAction = (
      <Button variant="secondary" size="sm" onClick={handleCatalogApply}>
        Go to the first page
      </Button>
    );
  }

  /*
   * The parameters a submission of the toolbar's form has to carry that are not its own fields. A
   * GET submission replaces the whole query string with the fields the form holds, so without these
   * a submission made with no scripting running would drop the category filter and a page size the
   * reader asked for. They are derived from the same builder that writes every other address here,
   * minus the two parameters the form's own fields carry, so there is one statement of what an
   * address is made of rather than two that can drift. The page parameter is absent by
   * construction, which is how a submission returns to the first page of the listing it asks for.
   */
  const carried = new URLSearchParams(buildCatalogQuery(applied, products.pageSize, FIRST_PAGE));
  carried.delete(CATALOG_SEARCH_PARAM);
  carried.delete(CATALOG_SORT_PARAM);

  return (
    <section className={styles.root} aria-label="Product catalog">
      <CatalogToolbar
        searchText={searchDraft}
        onSearchTextChange={setSearchDraft}
        onSearchSubmit={handleCatalogApply}
        sort={applied.sort}
        onSortChange={handleSortChange}
        carriedParams={[...carried]}
        visibleCount={products.items.length}
        totalCount={products.total}
        pending={pending}
      />

      <div className={styles.filters}>
        <CategoryFilterChips
          categories={categories}
          activeSlug={applied.categorySlug}
          onSelect={handleCategorySelect}
        />
      </div>

      {products.items.length === 0 ? (
        <div className={styles.notice}>
          <CatalogEmptyNotice
            reason={blankSlateReason}
            searchText={blankSlateReason === 'no-matches' ? applied.search : undefined}
            categoryName={blankSlateReason === 'no-matches' ? activeCategoryName : undefined}
            action={blankSlateAction}
          />
        </div>
      ) : (
        <ul className={styles.grid}>
          {products.items.map((product) => (
            <li key={product.id} className={styles.cell}>
              <ProductCard
                product={product}
                selected={product.slug === selectedSlug}
                categoryActive={product.categorySlug === applied.categorySlug}
                onSelect={() =>
                  setSelectedSlug(product.slug === selectedSlug ? null : product.slug)
                }
                onCategorySelect={() =>
                  handleCategorySelect(
                    product.categorySlug === applied.categorySlug ? null : product.categorySlug,
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
