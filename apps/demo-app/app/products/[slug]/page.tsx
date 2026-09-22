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
 * catalog rows at build time, no revalidation window is declared, no cached wrapper is put around
 * the service call, and the execution environment is left alone - the segment runs on Node, like
 * the rest of the application.
 *
 * TWO WAYS TO BE WRONG, TWO DIFFERENT ANSWERS
 * A slug that is not a slug and a slug no product owns are the same thing to a reader - they
 * followed a link to a product that is not there - so both answer `app/not-found.tsx` with a 404.
 * Anything else is an infrastructure fault, and it renders this page's own notice with one
 * sentence a buyer can act on. The two are kept apart deliberately: a 404 is a statement about the
 * address, and an unreachable database is not.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

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
 * The tab's title. Short on purpose: the store's name belongs to the root layout, which declares
 * it once as the `'%s · Lumen Supply'` template every nested route inherits, so this reads
 * `Product details · Lumen Supply` in the browser.
 *
 * A static `metadata` export rather than a derived one, even though the product's own name would
 * title the tab more precisely. Deriving it means reading the product a second time for
 * every request - Next.js resolves metadata in its own pass, so the read is not shared with the
 * render below - and this route exists to be a clean example of one interaction's work. A second
 * identical query per page view would be noise in exactly the measurement the application is here
 * to make.
 */
export const metadata: Metadata = {
  title: 'Product details',
};

/** The catalog's name, as the first breadcrumb and as the way out of the notice below. */
const CATALOG_LABEL = 'Catalog';

/** The heading of the notice shown when the product could not be read. */
const FAILURE_TITLE = 'This product could not be loaded';

/**
 * The sentence under that heading.
 *
 * It is fixed, and no part of the caught failure reaches it. The one failure this read raises on
 * purpose - the product does not exist - is answered with a 404 before this sentence is reached,
 * so everything that gets here is a bug, a driver refusal or an unreachable database, whose
 * message may name a host, a statement or a path. A reader can act on "try again"; none of those
 * tells them anything, and all of them would put the server's internals on a public page.
 */
const LOAD_FAILURE = 'We could not load this product just now. Please try again in a moment.';

interface Props {
  /**
   * The matched route segment. It is a promise in Next.js 16 and is awaited before `slug` is read,
   * which is also what marks this render as request-specific.
   */
  params: Promise<{ slug: string }>;
}

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

  // A segment the schema rejects is a 404 rather than a 400. Nothing was asked of the database,
  // and a reader who followed a truncated or hand-edited link is told the page is not there, which
  // is true and is the same answer they get for a slug that is merely unknown.
  if (!requested.success) {
    notFound();
  }

  // Declared before the read so the render below sits outside the `try`. Wrapping the JSX would
  // put every error React raises while rendering into the catch that is here for the read, and
  // would report a rendering bug as an unavailable product.
  let product: ProductDetail | null = null;

  try {
    product = await loadProductDetail({
      slug: requested.data.slug,
      origin: storefrontOrigin(),
    });
  } catch (error) {
    // `notFound` signals by throwing, so it is called from the catch rather than from the block
    // above: called inside the `try`, its control-flow error would be caught here and a missing
    // product would render as a failure instead of as a 404. The endpoint reports a slug no
    // product owns as `NOT_FOUND`, which is the same statement the service made directly.
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
        Renders nothing. The site header is drawn by the root layout, which makes it an ancestor of
        this route rather than a descendant, so this marker publishes the product on screen to the
        store the header subscribes to. Placed last because it contributes no markup: it belongs to
        the page's behaviour rather than to its composition.
      */}
      <ActiveProductMarker productId={product.id} />
    </div>
  );
}
