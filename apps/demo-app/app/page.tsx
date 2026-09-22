/**
 * Lumen Supply - the catalog, and the route a visitor lands on (`/`).
 *
 * The page answers one page of the product catalog, together with the categories its filter chips
 * offer. It is a server component: it reads the query string, parses it with the schema that
 * declares the catalog's parameters, calls the catalog service directly and hands the two answers
 * to `CatalogGrid`. Nothing else happens here.
 *
 * WHAT THIS FILE OWNS, AND WHAT IT DOES NOT
 * It owns the request - the query string, the two service calls, the failure path - and the page's
 * heading block. Everything below the heading belongs to `CatalogGrid`: the search and sort
 * toolbar, the category chips, the cards, the pager, the blank slate and the notice shown when a
 * listing did not arrive intact. That division is why no control, no card and no piece of state
 * appears in this file, and why it declares no component of its own.
 *
 * THE SERVICE IS CALLED, NOT THE ENDPOINT
 * `browseCatalog` and `listCategoryOptions` are invoked as functions. A server component that
 * fetched its own `/api/products` instead would pay for a second HTTP exchange, a second
 * serialization and a second trip through the same service on every page view, and would report
 * one request where the reader made none.
 *
 * EVERY VISIT IS ITS OWN REQUEST
 * `dynamic = 'force-dynamic'` opts the segment out of static generation, so stock levels and
 * prices are read for the request that asked for them. It is also the build-time contract of this
 * workspace: `next build` renders no route against the database, so a clean clone builds with a
 * placeholder connection string and nothing listening. Hence no `generateStaticParams`, no
 * `revalidate`, no cached wrapper around either service call, and no `runtime` override - the
 * segment runs on Node, like the rest of the application.
 *
 * A MALFORMED ADDRESS IS STILL AN ADDRESS
 * Both ways a request can be wrong are answered with a page rather than an error. A query string
 * the schema rejects - `?page=abc`, a term past the length bound, a parameter nobody sends - falls
 * back to the schema's own defaults, because the reader who followed a truncated link wants the
 * catalog, not a diagnostic. A listing that could not be read renders the page's chrome, an empty
 * page of products and one reader-facing sentence, which `CatalogGrid` shows above its grid.
 */

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

import { CatalogGrid } from '@/components/catalog/CatalogGrid';
import type { CategoryOption, PagedList, ProductSummary } from '@/lib/types';
import { isStorefrontError } from '@/server/errors';
import { browseCatalog, listCategoryOptions } from '@/server/services/catalog.service';
import { catalogQuerySchema, type CatalogQueryInput } from '@/server/validation/products';

/**
 * Rendering mode for this segment: one render per request, and no data read at build time.
 *
 * The root layout declares the same value for the whole application. It is restated here because
 * the guarantee is the segment's own - a page that renders no data at build time is what lets the
 * repository be built and type-checked on a machine with no database - and a segment inherits
 * nothing it does not say for itself once it is rendered on its own.
 */
export const dynamic = 'force-dynamic';

/**
 * The tab's title. Short on purpose: the store's name belongs to the root layout, which declares
 * it once as both the fallback title and the `'%s · Lumen Supply'` template every route inherits.
 *
 * A static `metadata` export rather than `generateMetadata`: the title is the same for every
 * filter, sort and page, so deriving it would mean a second pass over the same query for a value
 * that never changes.
 *
 * One Next.js rule shapes what a reader actually sees here, and it is stated so that the tab is
 * not "corrected" later by writing the store's name into this string: a title template applies to
 * *child* route segments, never to a page of the segment that declares it. This page and the root
 * layout are the same segment, so `/` renders `Catalog` while every nested route renders
 * `<page> · Lumen Supply`. Naming the store here instead would print it twice on every other page
 * or force this one to opt out of the template it should be inheriting from.
 */
export const metadata: Metadata = {
  title: 'Catalog',
};

/**
 * The sentence shown when a listing could not be read for a reason this application did not raise
 * itself - the database is unreachable, the driver refused the connection, a dependency failed.
 *
 * It names nothing about the cause. A reader can act on "try again"; a statement, a path or a
 * connection string tells them nothing and would put the server's internals on a public page.
 */
const LOAD_FAILURE = 'We could not load the catalog just now. Please try again in a moment.';

interface Props {
  /**
   * The route's query string. It is a promise in Next.js 16 and is awaited before any key is read,
   * which is also what marks this render as request-specific.
   */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** What the page renders: one page of products, the chips' categories, and how the read went. */
interface Listing {
  /** The page the catalog answered with, or an empty page when it could not be read. */
  products: PagedList<ProductSummary>;

  /** Every category the chip row offers; empty when the listing could not be read. */
  categories: readonly CategoryOption[];

  /** A reader-facing sentence describing a listing that did not arrive, or `null` when it did. */
  loadError: string | null;
}

/**
 * The query string as a record of single values, which is the shape `catalogQuerySchema` reads.
 *
 * A parameter may legitimately arrive more than once - `?sort=name_asc&sort=price_asc`, or a link
 * that accumulated a duplicate - in which case Next.js hands over an array. The first occurrence is
 * taken and the rest are dropped: a filter has one value, and choosing the first makes the answer a
 * function of the address rather than of the order a client happened to append parameters in.
 *
 * A key holding `undefined` is left out entirely instead of being copied as an absent value,
 * because the schema distinguishes an unconstrained filter from one constrained to nothing. Keys
 * the schema does not declare are carried in and dropped by it, so this function knows none of the
 * catalog's parameter names.
 *
 * @param params The awaited `searchParams` object, exactly as the route received it.
 * @returns One string per parameter that carried a value.
 */
function scalars(params: Record<string, string | string[] | undefined>): Record<string, string> {
  const flat: Record<string, string> = {};

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') {
      flat[key] = value;
      continue;
    }

    if (Array.isArray(value)) {
      const [first] = value;

      if (first !== undefined) {
        flat[key] = first;
      }
    }
  }

  return flat;
}

/**
 * The sentence to show for a listing that could not be read.
 *
 * A failure this application raised on purpose already carries a complete sentence written for a
 * visitor - that is the contract of `StorefrontError`, whose message reaches the browser verbatim
 * through every route handler - so it is shown as it stands. Anything else is a bug, a driver
 * refusal or an unreachable database, and gets the fixed sentence above: its message may name a
 * file, a statement or a host, none of which belongs on this page.
 *
 * @param error The caught value; `catch` binds `unknown`.
 * @returns Copy a visitor can read and act on.
 */
function notice(error: unknown): string {
  if (isStorefrontError(error) && error.message.trim().length > 0) {
    return error.message;
  }

  return LOAD_FAILURE;
}

/**
 * Reads the page of products and the categories for `query`.
 *
 * Both reads are issued together because neither depends on the other's result, and they are
 * awaited as one so the page waits for the slower of the two rather than for their sum. The filters
 * are forwarded by name, and each of the two optional ones is spread in only when it holds a value:
 * this workspace compiles with `exactOptionalPropertyTypes`, under which an unconstrained filter is
 * an absent key rather than a key holding `undefined`.
 *
 * A failure is turned into a rendered page rather than propagated. `Promise.all` rejects as soon as
 * either read fails, so one `catch` covers both, and it neither retries nor waits: a reader is
 * shown what is known now, and the browser's own reload is the retry. One line goes to the server
 * log for whoever is watching the dev server, carrying a fixed label and the failure's kind only -
 * a message or a stack may hold a path, a statement or a connection string.
 *
 * @param query A parsed catalog query; its `page` and `pageSize` size the empty page below.
 * @returns The listing, with `loadError` set when it could not be read.
 */
async function load(query: CatalogQueryInput): Promise<Listing> {
  try {
    const [products, categories] = await Promise.all([
      browseCatalog({
        sort: query.sort,
        page: query.page,
        pageSize: query.pageSize,
        ...(query.categorySlug === undefined ? {} : { categorySlug: query.categorySlug }),
        ...(query.search === undefined ? {} : { search: query.search }),
      }),
      listCategoryOptions(),
    ]);

    return { products, categories, loadError: null };
  } catch (error) {
    console.error(
      'Lumen Supply: the catalog listing could not be read:',
      error instanceof Error ? error.name : typeof error,
    );

    return {
      products: { items: [], total: 0, page: query.page, pageSize: query.pageSize },
      categories: [],
      loadError: notice(error),
    };
  }
}

/**
 * Renders the catalog.
 *
 * The heading block and the listing are the whole of the page. There is no `<main>` element and no
 * page container here: the root layout mounts the document's single main landmark around every
 * route, and a second one would give assistive technology two to choose between and break the
 * header's "Skip to content" link. There is no breadcrumb trail either - this is the route the
 * trail would lead back to.
 *
 * Everything handed to `CatalogGrid` is already serializable: the catalog's data-transfer types
 * carry integer cents and ISO-8601 strings and no `Date`, `Decimal` or class instance, so the two
 * answers cross into the client component exactly as the service produced them.
 */
export default async function CatalogPage({ searchParams }: Props): Promise<ReactElement> {
  const requested = catalogQuerySchema.safeParse(scalars(await searchParams));
  const query = requested.success ? requested.data : catalogQuerySchema.parse({});
  const { products, categories, loadError } = await load(query);

  return (
    <div className="ls-stack">
      <header className="ls-page-head">
        <h1 className="ls-page-title">Industrial supply catalog</h1>
        <p className="ls-page-lede">
          Maintenance parts, tooling and consumables stocked across our regional distribution
          warehouses, with the units available to promise shown on every line.
        </p>
      </header>

      <CatalogGrid products={products} categories={categories} loadError={loadError} />
    </div>
  );
}
