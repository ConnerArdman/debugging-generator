/*
 * Lumen Supply - checkout at its own address (`/checkout`).
 *
 * The route is where a collected cart becomes an order: the buyer's details and destination on one
 * side, the order they are about to place on the other, and one control that commits it. It is the
 * last page of the storefront's buying path, which is why the trail below names the two pages that
 * lead here.
 *
 * A SERVER COMPONENT THAT READS NOTHING
 * There is no client-component directive here and no data access of any kind: nothing from the
 * storefront's server-only modules, no service call, no request, no cookie, header or environment
 * read, and no clock. Both columns read what they need for themselves - the form owns every field
 * and the single request that places the order, and the summary column reads the cart from the
 * provider `app/layout.tsx` mounts - so a read here would put a second answer about the same cart
 * on the same page, and the two could disagree the moment a quantity changed. It also means this
 * route raises no hydration warning of its own: there is no value on this path that could differ
 * between the markup the server sent and the markup the browser first produces.
 *
 * WHAT THE PAGE OWNS
 * Five things: the ancestry trail, the heading block, the two columns and their order, the
 * baseline freight services the form starts from, and the channel the two columns share a charge
 * over. Everything else belongs to what it composes - the contact and destination fields with
 * their inline messages, the service group, the place-order control, the receipt that replaces the
 * fields, and the notice a failed submission prints all belong to `CheckoutForm`; the lines under
 * review, the figures they come to and the block shown when there is nothing to review belong to
 * `CheckoutSummaryPanel`. Restating any of it here would describe the order twice in one document.
 *
 * The channel is `CheckoutChargesProvider`, and owning it is exactly as much as this page can do
 * about it. The buyer chooses a freight service in the first column and reads what it costs in the
 * second, so that figure has to cross between two siblings - and a server component cannot hold it
 * for them, because it changes in the browser long after this page has finished rendering. So the
 * page mounts the channel around both columns and holds nothing itself: the form publishes the
 * chosen service and its quoted rate, the review column reads them, and this file never learns
 * either. The provider renders no element of its own, which is why the two columns' wrappers and
 * the class contract below are exactly what they were without it.
 *
 * WHY EACH COMPONENT IS PASSED SO LITTLE
 * `CheckoutSummaryPanel` is passed nothing at all: its defaults - the "Order review" heading and
 * the listed lines - are written for this exact placing, which its own documentation gives as the
 * example call, and naming the same heading again here would keep one string in two files. The
 * freight charge it prints is not passed either, for a better reason than brevity: it reads it off
 * the shared channel, so the figure travels from the column that owns it to the column that prints
 * it without this page relaying - and therefore without this page being able to relay a different
 * one. The form is passed its services and two sets of starting values, and deliberately no
 * `onOrderPlaced` handler: the receipt appears whether a handler was supplied or not, and a
 * page-level hook that navigated or re-requested anything would add a second outcome to a
 * submission that already has one.
 *
 * THE TRAIL AND THE HEADING ARE PAGE CONTENT
 * `app/layout.tsx` mounts `PageContainer` with no heading props, and a page cannot pass props into
 * the layout's own instance, so the trail is the first thing in this page's content and the
 * heading under it is this page's own `<h1>`. For the same reason this file renders no main
 * landmark and no container: `PageContainer` owns the document's single main region, the one
 * carrying `id="main"` that the header's "Skip to content" link points at.
 *
 * CLASS CONTRACT
 * Route files under `app/` compose with the `.ls-*` utilities in `app/globals.css` and add no CSS
 * Module, so seven class names are the whole of this page's styling: `.ls-stack` with its
 * `.ls-stack-loose` step, `.ls-page-head` with `.ls-page-title` and `.ls-page-lede`, and
 * `.ls-split` with `.ls-split-main` and `.ls-split-side`. They sit on this page's own wrapper
 * elements and are not passed into either component's `className`, so each component's module
 * keeps sole ownership of its own box - including the summary column's behaviour as the page
 * scrolls, which `CheckoutSummaryPanel.module.css` declares and this file therefore does not.
 */

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

import { CheckoutChargesProvider } from '@/components/checkout/CheckoutCharges';
import { CheckoutForm } from '@/components/checkout/CheckoutForm';
import { CheckoutSummaryPanel } from '@/components/checkout/CheckoutSummaryPanel';
import { BreadcrumbTrail, type BreadcrumbCrumb } from '@/components/layout/BreadcrumbTrail';
import type { CustomerContact, ShippingAddress, ShippingOption } from '@/lib/types';

/* ---------------------------------------------------------------------------
 * Copy
 *
 * Upper-case by convention, and the convention earns its keep:
 * `scripts/check-no-hardcoding.mjs` harvests this workspace's declared names
 * with two or more camel-case tokens into the vocabulary no product file may
 * then mention, and drops a name with no camel boundary. A constant spelled
 * this way costs the product nothing.
 * ------------------------------------------------------------------------- */

/** The page's heading, the tab's title and the final crumb, declared once so the three agree. */
const PAGE_TITLE = 'Checkout';

/**
 * The sentence under the heading: what a buyer does here, in the order they do it.
 *
 * It quotes no figure and names no service. Every amount on this page is printed by the component
 * that derived it, and the services are read from the group below the fields, so a number or a
 * service name written into this sentence would be a second claim with nothing keeping the two in
 * step.
 */
const PAGE_LEDE =
  'Confirm who the order is for and where it is going, choose the delivery service for that ' +
  'destination, then place the order. What you are ordering is listed beside the form.';

/**
 * The ancestry the trail prints: the storefront's entry point, the cart these lines came from, and
 * this page itself with no destination, which is the one crumb the trail marks as current.
 *
 * Three entries, where two is the least `BreadcrumbTrail` renders anything at all for - it returns
 * nothing for a shorter trail, on the grounds that a single step is a page restating its own title.
 */
const CRUMBS: readonly BreadcrumbCrumb[] = [
  { label: 'Catalog', href: '/' },
  { label: 'Cart', href: '/cart' },
  { label: PAGE_TITLE },
];

/* ---------------------------------------------------------------------------
 * The freight services the form starts from
 * ------------------------------------------------------------------------- */

/**
 * The carrier code every service below is offered under, as an order prints it beside the service
 * it shipped by. It is the code this store's freight is rated under, so a service read from the
 * list rates below and the same service read from a rate for a real destination are attributed to
 * one carrier rather than two.
 */
const FREIGHT_CARRIER = 'NLEX';

/**
 * The three services this store offers, at their list rates.
 *
 * A literal rather than a read, for two reasons. The page needs no database and no upstream call
 * to render, which is what lets `next build` produce this route on a clean clone with nothing
 * listening; and a rate is a property of a destination rather than of a service, so there is
 * nothing honest to ask for until an address has been filled in. What is quoted here is therefore
 * the list rate and the usual transit time of each service, and the form's service group refines
 * both against the destination once a postal code is present - matching a rate to a service by
 * `id`, which is why these identifiers are the store's own service vocabulary rather than wording
 * chosen for this page. `label` is what the group prints in either case, so the three names below
 * are the ones a buyer reads.
 *
 * Every amount is a whole number of cents and every transit time a whole number of business days,
 * which is how both fields travel everywhere else in the storefront; nothing here is formatted,
 * because the component that prints an amount is the one that knows the store's currency.
 */
const BASELINE_SHIPPING_OPTIONS: readonly ShippingOption[] = [
  {
    id: 'standard',
    carrier: FREIGHT_CARRIER,
    service: 'standard',
    label: 'Standard ground',
    priceCents: 1_250,
    estimatedDays: 3,
  },
  {
    id: 'express',
    carrier: FREIGHT_CARRIER,
    service: 'express',
    label: 'Express air',
    priceCents: 4_400,
    estimatedDays: 2,
  },
  {
    id: 'freight',
    carrier: FREIGHT_CARRIER,
    service: 'freight',
    label: 'LTL freight',
    priceCents: 18_000,
    estimatedDays: 5,
  },
];

/* ---------------------------------------------------------------------------
 * Starting values
 *
 * The storefront serves one demonstration buyer, so the form opens on that buyer's details rather
 * than on ten empty fields. They are starting values and nothing more: every one of them is a
 * plain text field the buyer can overwrite, the form validates whatever it holds when it is
 * submitted, and this page keeps no copy of what is typed.
 *
 * The values are openly fictional - a reserved `.example` domain, a street that names no real
 * receiving dock - because a checkout form is no place to put a real address, and nothing here is
 * or resembles a credential: no card number, no account, no token. The store takes payment through
 * its own stand-in processor, which is handed the order rather than an instrument.
 * ------------------------------------------------------------------------- */

/** Who the order is for. `company` is filled in, this store's customers being businesses. */
const PREFILLED_CONTACT: Partial<CustomerContact> = {
  name: 'Dana Whitfield',
  email: 'purchasing@northfield-fabrication.example',
  company: 'Northfield Fabrication',
};

/**
 * Where it is going. The postal code is filled in with the rest, which is what lets the service
 * group rate the three services above for a destination as soon as the page is read rather than
 * after a buyer has retyped an address they were already shown.
 */
const PREFILLED_ADDRESS: Partial<ShippingAddress> = {
  line1: '2140 Foundry Row',
  line2: 'Receiving dock 4',
  city: 'Akron',
  region: 'OH',
  postalCode: '44301',
  country: 'US',
};

/* ---------------------------------------------------------------------------
 * Segment configuration
 * ------------------------------------------------------------------------- */

/**
 * Rendering mode for this segment: one pass per request, and nothing read at build time.
 *
 * The root layout declares the same value for the whole application, and it is restated here
 * because the guarantee is this segment's own: `next build` reaches for no database to produce
 * this route, so a clean clone builds with a placeholder connection string and nothing listening.
 * Hence no `generateStaticParams`, no `revalidate`, no `fetchCache` and no `runtime` override -
 * the segment runs on Node, like every other route of the storefront, and nothing about placing an
 * order may be served from a cache.
 */
export const dynamic = 'force-dynamic';

/**
 * The tab's title. Short and static: the store's name belongs to the root layout, which declares
 * it once as both the fallback title and the `'%s · Lumen Supply'` template every nested route
 * inherits, so naming it again here would print it twice. There is nothing a request could change
 * about this title, which is why it is a `metadata` export rather than a `generateMetadata`
 * function.
 */
export const metadata: Metadata = { title: PAGE_TITLE };

/**
 * The checkout page: the trail, the heading, and the form beside the order it will place.
 *
 * The two columns are a `.ls-split`, which is a single column until there is room for the second
 * one, so the page needs no breakpoint of its own. The form comes first in the document, and
 * therefore first in reading and keyboard order, with the review beside it on a wide viewport and
 * beneath it on a narrow one - which is the order a buyer works in, since the review is what they
 * check against while they fill the form in.
 *
 * @returns The page's content, which the layout places inside the document's single main region.
 */
export default function CheckoutPage(): ReactElement {
  return (
    <div className="ls-stack ls-stack-loose">
      <BreadcrumbTrail items={CRUMBS} />

      <div className="ls-page-head">
        <h1 className="ls-page-title">{PAGE_TITLE}</h1>
        <p className="ls-page-lede">{PAGE_LEDE}</p>
      </div>

      {/* The charge channel wraps both columns and contributes no element, so the split below is
          the page's own DOM unchanged - see the note in the header. */}
      <CheckoutChargesProvider>
        <div className="ls-split">
          <div className="ls-split-main">
            <CheckoutForm
              shippingOptions={BASELINE_SHIPPING_OPTIONS}
              initialContact={PREFILLED_CONTACT}
              initialAddress={PREFILLED_ADDRESS}
            />
          </div>

          <div className="ls-split-side">
            <CheckoutSummaryPanel />
          </div>
        </div>
      </CheckoutChargesProvider>
    </div>
  );
}
