/**
 * Lumen Supply - the catalog, and the route a visitor lands on (`/`).
 *
 * The page answers one page of the product catalog, together with the categories its filter chips
 * offer. It is a server component: it reads the query string, parses it with the schema that
 * declares the catalog's parameters, asks this application's own catalog endpoint for the listing
 * and hands the two answers to `CatalogGrid`. Nothing else happens here.
 *
 * WHAT THIS FILE OWNS, AND WHAT IT DOES NOT
 * It owns the request - the query string, the two service calls, the failure path - the page's
 * heading block, and the one sentence that stands in for a listing that did not arrive. Everything
 * a listing that did arrive is made of belongs to `CatalogGrid`: the search and sort toolbar, the
 * category chips, the cards, the pager and the blank slate. That division is why no control, no
 * card and no piece of state appears in this file, and why it declares no component of its own.
 *
 * THE ANSWER IS ONE THING OR THE OTHER
 * A read either produced a listing or produced nothing, and `Outcome` below is which. The two
 * states are exclusive by construction rather than by a condition somebody has to remember to
 * write, so this page cannot show a grid and a failure at the same time - and, more to the point,
 * cannot show a failure and an empty catalog at the same time. There is no empty page to hand over
 * on the failure path, because that path carries no page at all: a reader whose listing is missing
 * is told exactly that and nothing about what the catalog holds, which on that path is the only
 * honest thing to say, since this page does not know.
 *
 * THE LISTING COMES FROM THE ENDPOINT
 * `GET /api/products` is the catalog's listing, and this page reads it over HTTP through
 * `loadCatalogPage` in `@/lib/api-client` rather than calling the catalog service in process. One
 * code path therefore answers the grid a reader is looking at and any other caller of the same
 * endpoint, so a bound, a default or a payload change cannot apply to one and not the other. A
 * server render has no relative base to resolve `/api/...` against, so the address the read is sent
 * to comes from `@/server/origin`, which answers with the storefront's configured address or the
 * loopback address on the port this process bound - never with anything a request carries.
 *
 * The chips' categories are the exception, and the reason is plain: this application publishes no
 * category endpoint, so `listCategoryOptions` is called as a function. An endpoint that does not
 * exist cannot be read, and inventing one for a list of chips would add a surface no caller asked
 * for.
 *
 * EVERY VISIT IS ITS OWN REQUEST
 * `dynamic = 'force-dynamic'` opts the segment out of static generation, so stock levels and
 * prices are read for the request that asked for them. It is also the build-time contract of this
 * workspace: `next build` renders no route against the database, so a clean clone builds with a
 * placeholder connection string and nothing listening. Hence no `generateStaticParams`, no
 * `revalidate`, no cached wrapper around either service call, and no `runtime` override - the
 * segment runs on Node, like the rest of the application.
 *
 * THE ADDRESS IS THE LISTING
 * The query string is the only statement of what the reader is looking at. This page parses it,
 * asks the endpoint for exactly that listing, and hands the parsed values down beside the answer,
 * so the toolbar, the chips and the pager open showing the filter, the ordering and the page the
 * products beside them were actually read under. A control the reader then changes writes a new
 * address and the server answers it; nothing narrows or reorders a listing after it has been read,
 * because what arrived is one page of a filtered, ordered, counted query rather than a sample of
 * the catalog to sift through locally.
 *
 * A MALFORMED ADDRESS IS STILL AN ADDRESS
 * Both ways a request can be wrong are answered with a page rather than an error. A query string
 * the schema cannot accept whole - `?page=abc`, a term past the length bound, a page number beyond
 * the catalog - is recovered parameter by parameter by `parseCatalogQuery`: every parameter that is
 * valid is applied, each one that is not falls back to its own default or to absence, and the page
 * says which parts of the address did not take effect. The reader who followed a truncated link
 * wants the catalog rather than a diagnostic, and they also want to know that the category they
 * clicked is not the one they are looking at. A listing that could not be read renders the page's
 * chrome and one reader-facing sentence in place of the listing.
 *
 * Neither notice speaks for the other, and both may be on the page at once: a rejected parameter is
 * worth reporting whether or not the listing behind it arrived.
 */

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

import { CatalogGrid } from '@/components/catalog/CatalogGrid';
import { Alert } from '@/components/ui/Alert';
import { StorefrontApiError, loadCatalogPage } from '@/lib/api-client';
import type { CategoryOption, PagedList, ProductSummary } from '@/lib/types';
import { storefrontOrigin } from '@/server/origin';
import { listCategoryOptions } from '@/server/services/catalog.service';
import {
  parseCatalogQuery,
  type CatalogQueryInput,
  type CatalogQueryParameter,
} from '@/server/validation/products';

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

/**
 * The heading above that sentence.
 *
 * It says which part of the page is missing, because the notice takes the listing's place and a
 * sentence on its own would leave a reader to work out what the empty space below the heading was
 * meant to hold. It states the outcome rather than a cause, for the reason given above.
 */
const LOAD_FAILURE_TITLE = 'The catalog could not be loaded';

/**
 * The heading above the notice shown when part of the address could not be applied.
 *
 * It says what happened to the address rather than what is wrong with it, because the reader did
 * not write the address: they followed a link, and the only thing they can act on is knowing that
 * the listing in front of them is not the one that link asked for.
 */
const UNAPPLIED_TITLE = 'Part of this link could not be applied';

/**
 * The opening of that notice, completed by the names of the parameters that were dropped.
 *
 * It names no bound, no limit and no parameter value. A bound is this application's business and
 * tells a reader nothing they can use, and a query string carries whatever a stranger put in a
 * link - echoing one back into the page would put that stranger's text on this store's page.
 */
const UNAPPLIED_LEAD = 'This link did not state a value the catalog could use for';

/**
 * The two endings of that notice: what the reader is looking at instead.
 *
 * Two constants rather than one, because the sentence has to agree with a list that may name one
 * parameter or several, and a notice that says "without them" about a single search term reads as
 * though the store cannot count. The closing clause is the point of the whole notice: the parts of
 * the address that were valid are still in effect, so a reader can trust the filters the page shows
 * them.
 */
const UNAPPLIED_TAIL_ONE =
  ', so the listing below was read without it. Every other part of the link was applied as it stands.';
const UNAPPLIED_TAIL_MANY =
  ', so the listing below was read without them. Every other part of the link was applied as it stands.';

/**
 * How each catalog parameter is named to a reader.
 *
 * Reader-facing words rather than the schema's field names: the reader is being told about the
 * category and the sort order they picked, not about a `categorySlug` key they have never seen.
 * Each name carries its own article, so the list below reads as English however many entries it
 * holds.
 *
 * `Record<CatalogQueryParameter, string>` is the compile check that keeps this list complete: a
 * parameter added to the catalog's query has to be given words here before this page compiles, so
 * no parameter can be dropped from an address and go unnamed in the notice.
 */
const UNAPPLIED_NAMES: Record<CatalogQueryParameter, string> = {
  categorySlug: 'the category',
  search: 'the search term',
  sort: 'the sort order',
  page: 'the page number',
  pageSize: 'the page size',
};

/** How the names are joined when several parameters were dropped. */
const NAME_SEPARATOR = ', ';
const NAME_CONJUNCTION = ' and ';

interface Props {
  /**
   * The route's query string. It is a promise in Next.js 16 and is awaited before any key is read,
   * which is also what marks this render as request-specific.
   */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * What one read of the catalog produced: the listing, or the sentence to show in its place.
 *
 * Two states rather than a payload with an optional message beside it. A message that travelled
 * alongside a payload would need a payload to travel with, and the only one a failed read has to
 * offer is an invented empty page - which, once it reaches a component, is indistinguishable from a
 * catalog that genuinely has nothing published in it. Giving the failure no payload at all is what
 * settles that at the source: the grid is only ever handed a listing that exists, so the question
 * of what an empty `items` array means never has two answers.
 */
type Outcome =
  | {
      /** The page the catalog answered with. */
      readonly products: PagedList<ProductSummary>;

      /** Every category the chip row offers, in the order the reader sees them. */
      readonly categories: readonly CategoryOption[];

      readonly failure: null;
    }
  | {
      readonly products: null;

      readonly categories: null;

      /** A reader-facing sentence describing a listing that did not arrive. */
      readonly failure: string;
    };

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
 * visitor - that is the contract of `StorefrontError`, whose message every route handler puts into
 * the response envelope verbatim and which arrives here as a reported `StorefrontApiError` - so it
 * is shown as it stands. Anything else is a bug, a driver refusal, an unreachable database or a
 * request that never arrived, and gets the fixed sentence above: an unreported message is this
 * page's own reading of a status rather than the store's statement, and a message the store did
 * write may name a file, a statement or a host, none of which belongs on this page.
 *
 * @param error The caught value; `catch` binds `unknown`.
 * @returns Copy a visitor can read and act on.
 */
function notice(error: unknown): string {
  if (error instanceof StorefrontApiError && error.reported && error.message.trim().length > 0) {
    return error.message;
  }

  return LOAD_FAILURE;
}

/**
 * The sentence naming the parameters of the address that could not be applied, or `null` when the
 * whole address took effect and there is nothing to report.
 *
 * Returning `null` for an accepted query is what keeps the decision in one place: the caller renders
 * a notice when there is a sentence to put in it, rather than counting rejections itself and then
 * building the copy separately. It is also what makes this function total - an empty list has no
 * sentence, and there is no half-built one to hand back.
 *
 * The names come out of {@link UNAPPLIED_NAMES} in the order `parseCatalogQuery` reported them,
 * which is the catalog's own parameter order rather than the order the validator happened to collect
 * its objections in, so the same malformed link always produces the same sentence.
 *
 * @param rejected The parameters that could not be applied, in reporting order.
 * @returns Copy a visitor can read, or `null` when nothing was dropped.
 */
function unapplied(rejected: readonly CatalogQueryParameter[]): string | null {
  const names = rejected.map((parameter) => UNAPPLIED_NAMES[parameter]);

  // Taking the last name off leaves the ones the separator joins, and answers the empty case at the
  // same time: a list with nothing in it has no final name, which is the one input with no sentence
  // to build. `names` is this function's own array, so nothing a caller holds is modified.
  const final = names.pop();

  if (final === undefined) {
    return null;
  }

  const listed =
    names.length === 0 ? final : `${names.join(NAME_SEPARATOR)}${NAME_CONJUNCTION}${final}`;
  const tail = names.length === 0 ? UNAPPLIED_TAIL_ONE : UNAPPLIED_TAIL_MANY;

  return `${UNAPPLIED_LEAD} ${listed}${tail}`;
}

/**
 * Reads the page of products and the categories for `query`.
 *
 * The authority is established first, because a request cannot be addressed without one. The two
 * reads that follow are issued together because neither depends on the other's result, and they are
 * awaited as one so the page waits for the slower of the two rather than for their sum. The filters
 * are forwarded by name, and each of the two optional ones is spread in only when it holds a value:
 * this workspace compiles with `exactOptionalPropertyTypes`, under which an unconstrained filter is
 * an absent key rather than a key holding `undefined`.
 *
 * The categories read takes the search term too, so a chip's count is the number of matches within
 * that category for the term the listing was read under. A count that ignored the term would have
 * the chip row advertising products while the count line beside it reports none of them.
 *
 * A failure is turned into a rendered page rather than propagated. `Promise.all` rejects as soon as
 * either read fails, so one `catch` covers both, and it neither retries nor waits: a reader is
 * shown what is known now, and the browser's own reload is the retry. One line goes to the server
 * log for whoever is watching the dev server, carrying a fixed label and the failure's kind only -
 * a message or a stack may hold a path, a statement or a connection string.
 *
 * The failure branch fabricates nothing. It returns no page, no categories and no counts, because
 * the read established none of them: a listing this function did not obtain is absent from its
 * answer rather than represented by an empty one.
 *
 * @param query A parsed catalog query; its filters, ordering and page window are the request.
 * @returns The listing, or the sentence to render in its place.
 */
async function load(query: CatalogQueryInput): Promise<Outcome> {
  try {
    const origin = storefrontOrigin();

    const [products, categories] = await Promise.all([
      loadCatalogPage({
        query: {
          sort: query.sort,
          page: query.page,
          pageSize: query.pageSize,
          ...(query.categorySlug === undefined ? {} : { categorySlug: query.categorySlug }),
          ...(query.search === undefined ? {} : { search: query.search }),
        },
        origin,
      }),
      listCategoryOptions(query.search),
    ]);

    return { products, categories, failure: null };
  } catch (error) {
    console.error(
      'Lumen Supply: the catalog listing could not be read:',
      error instanceof Error ? error.name : typeof error,
    );

    return { products: null, categories: null, failure: notice(error) };
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
 * answers cross into the client component exactly as the service produced them. The query crosses
 * with them, as the three values that describe the listing to a reader - the term searched for, the
 * category filtered to and the ordering applied - each in the canonical form the schema parsed it
 * into. The page window is not among them: the answer already carries the page it was built with,
 * so passing it a second time would be two statements of one fact.
 *
 * A listing that could not be read takes the grid's place with the notice instead, rather than
 * being handed over as an empty one. `warning` rather than `danger`, because `ui/Alert` announces
 * `danger` assertively and this failure is here on arrival - the reader did not cause it by
 * pressing anything.
 *
 * The notice about an address that was only partly applied sits above both, between the heading
 * block and the listing, on whichever of the two branches follows it. It carries the same `warning`
 * tone and for the same reason: the reader followed a link, so this is news about the page they were
 * given rather than the outcome of something they pressed. It is rendered only when a parameter was
 * actually dropped, so an ordinary visit carries no notice at all.
 */
export default async function CatalogPage({ searchParams }: Props): Promise<ReactElement> {
  const requested = parseCatalogQuery(scalars(await searchParams));
  const query = requested.query;
  const dropped = unapplied(requested.rejected);
  const outcome = await load(query);

  return (
    <div className="ls-stack">
      <header className="ls-page-head">
        <h1 className="ls-page-title">Industrial supply catalog</h1>
        <p className="ls-page-lede">
          Maintenance parts, tooling and consumables stocked across our regional distribution
          warehouses, with the units available to promise shown on every line.
        </p>
      </header>

      {dropped === null ? null : (
        <div className="ls-notice">
          <Alert tone="warning" title={UNAPPLIED_TITLE}>
            {dropped}
          </Alert>
        </div>
      )}

      {outcome.products === null ? (
        <div className="ls-notice">
          <Alert tone="warning" title={LOAD_FAILURE_TITLE}>
            {outcome.failure}
          </Alert>
        </div>
      ) : (
        <CatalogGrid
          products={outcome.products}
          categories={outcome.categories}
          query={{
            search: query.search,
            categorySlug: query.categorySlug,
            sort: query.sort,
          }}
        />
      )}
    </div>
  );
}
