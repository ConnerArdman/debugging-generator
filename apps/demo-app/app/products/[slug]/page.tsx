/**
 * Lumen Supply - one product, and the page every catalog card and suggestion tile links to
 * (`/products/[slug]`).
 *
 * The page answers a single product for the slug in its address: its artwork, its copy, the stock
 * behind its badge, what it costs, the control that puts it in the cart, its specifications, and
 * the strip of suggestions below them. It is a server component - it parses the route segment,
 * asks this application's own product endpoint for the answer and hands it to the components that
 * draw it - and it declares no component, no state and no style of its own.
 *
 * WHAT THIS FILE OWNS, AND WHAT IT DOES NOT
 * It owns the request - the segment, the service call, the two failure paths - the page's heading
 * block, its breadcrumb trail and the arrangement of the blocks below. Everything inside those
 * blocks belongs to the component that renders it: the frame and its thumbnail strip to
 * `ProductGallery`, the chip and its unit count to `StockBadge`, the currency to `Price`, the
 * quantity control and its messages to `AddToCartControl`, the specification rows to
 * `ProductSpecList`, and the suggestion strip - including its own heading - to
 * `RecommendationsRail`. That division is why no card, no control and no piece of copy about a
 * product appears in this file.
 *
 * THE PRODUCT COMES FROM THE ENDPOINT
 * `GET /api/products/[slug]` answers this product, and the page reads it over HTTP through
 * `loadProductDetail` in `@/lib/api-client` rather than calling the catalog service in process.
 * One code path therefore answers the page a reader is looking at and any other caller of the same
 * endpoint, so the two cannot describe a product differently. A server render has no relative base
 * to resolve `/api/...` against, so the address the read is sent to comes from `@/server/origin`,
 * which answers with the storefront's configured address or the loopback address on the port this
 * process bound - never with anything a request carries.
 *
 * EVERY VISIT IS ITS OWN REQUEST
 * `dynamic = 'force-dynamic'` opts the segment out of static generation, so the price and the
 * units on this page are read for the request that asked for them. It is also the build-time
 * contract of this workspace: `next build` renders no route against the database, so a clean clone
 * builds with a placeholder connection string and nothing listening. Hence nothing here enumerates
 * catalog rows at build time, no revalidation window is declared, nothing holds an answer past the
 * response it was read for - React's `cache()` around the read below is a memo for the one request
 * being served, not a store that outlives it - and the execution environment is left alone: the
 * segment runs on Node, like the rest of the application.
 *
 * TWO WAYS TO BE WRONG, TWO DIFFERENT ANSWERS
 * A slug that is not a slug and a slug no product owns are the same thing to a reader - they
 * followed a link to a product that is not there - so both answer with `app/not-found.tsx`, under
 * that page's own "Page not found" title. Anything else is an infrastructure fault, and it renders
 * this page's own notice with one sentence a buyer can act on, under this page's ordinary title.
 * The two are kept apart deliberately: "there is nothing at this address" is a statement about the
 * address, and an unreachable database is not.
 *
 * WHERE "IS THERE A PRODUCT HERE?" IS DECIDED
 * In two places, for the two halves of the answer.
 *
 * The status line is decided before this file runs. This segment renders inside the root loading
 * boundary, `app/loading.tsx`, and a response streamed through a Suspense boundary has sent its
 * `200` before anything here can raise a not-found signal - Next.js marks a response 404 only when
 * that signal escapes the shell of the render, and the boundary absorbs it first. So `proxy.ts`
 * looks the slug up ahead of rendering, with the same slug schema this file parses with, and
 * rewrites an address no product owns to the not-found route, which answers with a 404 status
 * line - what an uptime monitor, a CDN and a search crawler read.
 *
 * The document is decided by `generateMetadata`, because Next.js resolves a page's metadata as one
 * unit. Ask the render alone, and the answer arrives after the loading boundary has flushed the
 * shell: a `notFound()` thrown from the render swaps the markup for `app/not-found.tsx` while the
 * tab still says `Product details`. Raised while the metadata is being resolved, the same call
 * makes Next.js resolve that unit under the not-found convention instead, so the tab, the
 * `next-error` marker and `robots: noindex` all describe what the reader is actually looking at.
 *
 * This file's own `notFound()` calls are the render's guarantee rather than a copy of the proxy's
 * check. They answer the cases the proxy cannot settle - a lookup that fell through because the
 * proxy could not read the database, and a product removed between the proxy's read and this one
 * - and in those cases the not-found page is streamed under the `200` already sent, marked
 * `robots: noindex`, which is Next.js's documented answer once a body has started. (A dotted
 * segment never reaches this file either: the proxy leaves it alone because `/products/<name>.svg`
 * is where the product artwork is served from, and one that names no file is rewritten to the
 * not-found route, with a 404, by the `afterFiles` rewrite in `next.config.ts`.)
 *
 * The render keeps its own parse and its own failure path all the same - it is the code that types
 * the slug and the code that answers an infrastructure fault - and the two never disagree, because
 * both read the product through one memoized call and therefore see one outcome per request.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache, type ReactElement } from 'react';

import { BreadcrumbTrail, type BreadcrumbCrumb } from '@/components/layout/BreadcrumbTrail';
import { ActiveProductMarker } from '@/components/product/ActiveProductMarker';
import { AddToCartControl } from '@/components/product/AddToCartControl';
import { ProductGallery } from '@/components/product/ProductGallery';
import { ProductSpecList } from '@/components/product/ProductSpecList';
import { RecommendationsRail } from '@/components/product/RecommendationsRail';
import { StockBadge } from '@/components/product/StockBadge';
import { Alert } from '@/components/ui/Alert';
import { Price } from '@/components/ui/Price';
import { StorefrontApiError, loadProductDetail } from '@/lib/api-client';
import { formatSlugLabel } from '@/lib/format';
import type { ProductDetail } from '@/lib/types';
import { storefrontOrigin } from '@/server/origin';
import { productSlugParamsSchema } from '@/server/validation/products';

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
 * What Next.js hands both of this file's entry points: the metadata pass and the render, each
 * called once per request with the same matched segment.
 */
interface Props {
  /**
   * The matched route segment. It is a promise in Next.js 16 and is awaited before `slug` is read,
   * which is also what marks this render as request-specific.
   */
  params: Promise<{ slug: string }>;
}

/**
 * The tab's title for a product that exists. Short on purpose: the store's name belongs to the
 * root layout, which declares it once as the `'%s · Lumen Supply'` template every nested route
 * inherits, so this reads `Product details · Lumen Supply` in the browser.
 *
 * It titles the page rather than the product, so every product page carries the same tab title.
 * A slug no product owns is not titled from here at all: `proxy.ts` rewrites its address to the
 * not-found route before this file runs, and one that reaches this file anyway is answered by
 * `generateMetadata` with `notFound()` - either way `app/not-found.tsx` supplies its own "Page not
 * found".
 */
const PAGE_TITLE = 'Product details';

/**
 * The product for one slug, read at most once per request.
 *
 * Two callers need the same answer in the same request: `generateMetadata`, which decides whether
 * there is a product at this address at all, and the render below, which draws it. Next.js
 * resolves metadata in its own pass, and `storefrontRequest` sends its `fetch` with
 * `cache: 'no-store'`, which opts the request out of Next.js's own per-request memoization - so
 * without something here the two passes would issue two identical `GET /api/products/[slug]`
 * calls for every page request, doubling the load on the endpoint and the database behind it.
 *
 * React's `cache()` is that something. It memoizes by argument for the lifetime of a single
 * request's render, so the second caller receives the first caller's promise: one HTTP call, one
 * outcome, and no window in which metadata and markup could disagree about whether the product
 * exists. It holds nothing between requests - a later visit reads the price and the units again,
 * which is what `dynamic = 'force-dynamic'` above promises.
 *
 * The function is `async` so that every way it can fail arrives the same way: a rejection.
 * `storefrontOrigin()` throws synchronously when this deployment's address cannot be established,
 * and wrapping the call in an async function turns that into a rejected promise, which the two
 * callers already handle. A rejection is memoized exactly as a value is, so the render replays the
 * rejection `generateMetadata` saw rather than retrying the read - which is precisely what the
 * notice path needs: metadata keeps the page's title, the render answers the failure.
 */
const PRODUCT_FOR_SLUG = cache(async (slug: string): Promise<ProductDetail> =>
  loadProductDetail({ slug, origin: storefrontOrigin() }),
);

/**
 * The document head for this route, and the point at which a missing product stops being one.
 *
 * It does not decide the status line. This route renders inside the root loading boundary, so
 * `proxy.ts` sets the 404 for an address no product owns before rendering begins, and a missing
 * product reaches this pass only when the proxy could not settle it - its lookup fell through, or
 * the product was removed between its read and this one.
 *
 * Next.js resolves this pass as one unit, which is the only reason the decision is here rather than
 * in the render alone: thrown from the render, `notFound()` arrives after the loading boundary has
 * flushed the shell, and the not-found markup is served under this page's own title. Raised here,
 * it makes the head the not-found page's head. The three answers below are the route's contract:
 *
 *   - a segment the slug schema rejects, and a slug the endpoint reports as `NOT_FOUND`, both call
 *     `notFound()`, so the response carries `app/not-found.tsx` under its own "Page not found"
 *     title, with the `next-error` and `robots: noindex` markers Next.js writes for it - streamed
 *     under the `200` the loading boundary has already sent;
 *   - anything else that goes wrong reading the product - an unreachable database, a driver
 *     refusal, an address this deployment cannot establish - is not a statement about the address
 *     and must not be dressed up as one. It is caught here and the page's ordinary title is
 *     returned, leaving the render below to answer with its "could not be loaded" notice rather
 *     than reporting a product that exists as missing;
 *   - a product that exists is titled {@link PAGE_TITLE}.
 *
 * Nothing about the failure is logged here. The render below logs the same rejection once, with
 * the failure's kind only, and this pass would otherwise report every infrastructure fault twice.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const requested = productSlugParamsSchema.safeParse(await params);

  if (!requested.success) {
    notFound();
  }

  try {
    await PRODUCT_FOR_SLUG(requested.data.slug);
  } catch (error) {
    // Called from the catch rather than from inside the `try`: `notFound()` signals by throwing,
    // and its control-flow error raised inside the block would be swallowed right here, leaving a
    // product that does not exist to be served under this page's own title.
    if (error instanceof StorefrontApiError && error.code === 'NOT_FOUND') {
      notFound();
    }
  }

  return { title: PAGE_TITLE };
}

/** The catalog's name, as the first breadcrumb and as the way out of the notice below. */
const CATALOG_LABEL = 'Catalog';

/** The heading of the notice shown when the product could not be read. */
const FAILURE_TITLE = 'This product could not be loaded';

/**
 * The sentence under that heading.
 *
 * It is fixed, and no part of the caught failure reaches it. The one failure this read raises on
 * purpose - the product does not exist - is answered with the not-found page before this sentence
 * is reached, so everything that gets here is a bug, a driver refusal or an unreachable database,
 * whose message may name a host, a statement or a path. A reader can act on "try again"; none of
 * those tells them anything, and all of them would put the server's internals on a public page.
 */
const LOAD_FAILURE = 'We could not load this product just now. Please try again in a moment.';

/**
 * Renders one product.
 *
 * There is no main landmark element and no page container here: the root layout mounts the
 * document's single main region around every route, and a second one would give assistive
 * technology two to choose between and break the header's "Skip to content" link. So the `<h1>`
 * below is the page's only one, and the only heading this file writes - `RecommendationsRail`
 * renders its own `<section>` and its own `<h2>`, so it is placed as it stands rather than wrapped
 * in a section whose heading would repeat the strip's.
 *
 * Everything handed to the four client components is already serializable: the catalog's
 * data-transfer types carry integer cents and ISO-8601 strings and no `Date`, `Decimal` or class
 * instance, so each field crosses the boundary exactly as the service produced it. No value here
 * is formatted, converted or rounded on the way - `Price` is given cents, and the components that
 * print a quantity or a SKU own their own wording.
 */
export default async function ProductDetailPage({ params }: Props): Promise<ReactElement> {
  const requested = productSlugParamsSchema.safeParse(await params);

  // A segment the schema rejects is answered with the not-found page rather than with a 400.
  // Nothing was asked of the database, and a reader who followed a truncated or hand-edited link
  // is told the page is not there, which is true and is the same answer they get for a slug that
  // is merely unknown. `proxy.ts` has already rewritten such segments to the not-found route (a
  // dotted one is left to `public/` and to the rewrite in `next.config.ts`), and
  // `generateMetadata` refuses them too, so this is the render's own guarantee rather than the
  // reader's only protection: it is what types the slug for the read below, and what keeps this
  // component correct on its own terms.
  if (!requested.success) {
    notFound();
  }

  // Declared before the read so the render below sits outside the `try`. Wrapping the JSX would
  // put every error React raises while rendering into the catch that is here for the read, and
  // would report a rendering bug as an unavailable product.
  let product: ProductDetail | null = null;

  try {
    // The same memoized call `generateMetadata` made, so this request's product arrives without a
    // second `GET /api/products/[slug]` and cannot differ from the one the title was chosen for.
    product = await PRODUCT_FOR_SLUG(requested.data.slug);
  } catch (error) {
    // `notFound` signals by throwing, so it is called from the catch rather than from the block
    // above: called inside the `try`, its control-flow error would be caught here and a missing
    // product would render as a failure instead of as a missing page. The endpoint reports a slug
    // no product owns as `NOT_FOUND`, passing on the catalog service's own answer. Such a slug
    // normally never gets here - `proxy.ts` rewrites its address to the not-found route before
    // rendering - and when one does, because the proxy's lookup fell through or the product was
    // removed after it, the metadata pass has already answered the request with the not-found page
    // by the time the render is reached. The render checks all the same, because its answer must
    // depend on neither, and the call is the right one to make here - only later than the head
    // needs it.
    if (error instanceof StorefrontApiError && error.code === 'NOT_FOUND') {
      notFound();
    }

    // One line for whoever is watching the dev server, carrying a fixed label and the failure's
    // kind only. A message or a stack may hold a path, a statement or a connection string.
    console.error(
      'Lumen Supply: a product could not be read:',
      error instanceof Error ? error.name : typeof error,
    );
  }

  // Nothing was read, so nothing about the product is asserted: the notice is the whole page. A
  // partially drawn product page would print an empty frame, a blank price and a disabled control,
  // each of which states something the server never answered.
  if (product === null) {
    return (
      <div className="ls-notice">
        <Alert
          tone="warning"
          title={FAILURE_TITLE}
          actions={
            <div className="ls-actions">
              <Link href="/">{CATALOG_LABEL}</Link>
            </div>
          }
        >
          {LOAD_FAILURE}
        </Alert>
      </div>
    );
  }

  // The category's name as stored, or its slug read as words when the name is blank. Either way
  // the crumb says something: an empty middle crumb would print two separators around nothing.
  const category =
    product.categoryName.trim().length > 0
      ? product.categoryName
      : formatSlugLabel(product.categorySlug);

  // Where the category crumb goes: the catalog filtered by this category, which is a parameter the
  // catalog route declares and answers server-side. A product with no category slug gets no
  // destination and the trail prints the name as plain text.
  const link =
    product.categorySlug.trim().length > 0
      ? `/?categorySlug=${encodeURIComponent(product.categorySlug)}`
      : null;

  const trail: BreadcrumbCrumb[] = [
    { label: CATALOG_LABEL, href: '/' },
    // Spread rather than `href: undefined`: this workspace compiles with
    // `exactOptionalPropertyTypes`, under which a crumb with no destination is an absent key.
    { label: category, ...(link === null ? {} : { href: link }) },
    // The product itself, last and with no destination - it is the page the reader is on, and
    // `BreadcrumbTrail` marks the final crumb as the current page.
    { label: product.name },
  ];

  // What the product used to cost, and only when that is more than it costs today. A list price
  // equal to or below the current one says nothing worth striking through, and the field is
  // nullable, so the comparison resolves to the figure to print or to nothing at all.
  const listed =
    product.listPriceCents !== null && product.listPriceCents > product.priceCents
      ? product.listPriceCents
      : null;

  return (
    <div className="ls-stack">
      <BreadcrumbTrail items={trail} />

      <header className="ls-page-head">
        <h1 className="ls-page-title">{product.name}</h1>
        {product.description.trim().length > 0 ? (
          <p className="ls-page-lede">{product.description}</p>
        ) : null}
      </header>

      <div className="ls-split">
        {/*
          The artwork leads, in the wider column and first in the DOM, so reading and keyboard
          order reach the product before the panel that sells it. Each column is a wrapper this
          page owns: a placement class put on an element a component renders would lose the
          cascade to that component's own module class and silently do nothing.
        */}
        <div className="ls-split-main">
          <ProductGallery images={product.images} productName={product.name} />
        </div>

        <div className="ls-split-side ls-stack">
          <StockBadge state={product.stockState} available={product.availableQuantity} />

          <div className="ls-stack ls-stack-tight">
            <Price cents={product.priceCents} size="lg" />
            {listed === null ? null : <Price cents={listed} size="sm" tone="muted" strike />}
          </div>

          <AddToCartControl
            productId={product.id}
            productName={product.name}
            stockState={product.stockState}
            maxQuantity={product.availableQuantity}
          />

          {/*
            The specifications carry their own SKU row - the catalog service puts it first in the
            list - so the identifier is not passed a second time, which would print it twice.
          */}
          <ProductSpecList specs={product.specs} />
        </div>
      </div>

      <RecommendationsRail productId={product.id} variant="detail" />

      {/*
        Renders nothing: it publishes the product on screen to a shared store, for components the
        root layout draws outside this route. Placed last because it contributes no markup: it
        belongs to the page's behaviour rather than to its composition.
      */}
      <ActiveProductMarker productId={product.id} />
    </div>
  );
}
