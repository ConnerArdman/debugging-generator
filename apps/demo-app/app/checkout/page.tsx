/*
 * Lumen Supply - checkout at its own address (`/checkout`).
 *
 * The route is where a collected cart becomes an order: the buyer's details and destination on one
 * side, the order they are about to place on the other, and one control that commits it. It is the
 * last page of the storefront's buying path, which is why the trail below names the two pages that
 * lead here.
 *
 * A SERVER COMPONENT THAT READS ONE ORDER, AND ONLY WHEN ITS ADDRESS NAMES ONE
 * There is no client-component directive here, and the cart is never read here: no cart service
 * call, no cookie, header or environment read of its own, and no clock. Both columns read what
 * they need for themselves - the form owns every field and the single request that places the
 * order, and the summary column reads the cart from the provider `app/layout.tsx` mounts - so a
 * cart read here would put a second answer about the same cart on the same page, and the two could
 * disagree the moment a quantity changed.
 *
 * What it does read is the query string, and specifically `?order=`. A placed order needs an
 * address a buyer can return to, reload and copy, and this route is that address: `CheckoutForm`
 * pushes it with `history.pushState` the moment an order exists - which changes the URL without
 * remounting the form, so the receipt on screen survives it - and every later arrival at the same
 * URL, when the receipt that component held is long gone, is answered with that receipt again. So
 * when, and only when, the address carries a well-formed reference, this page reads that one order
 * through `readOrderByNumber` at request time - calling the order service in process, as
 * `app/page.tsx` calls the catalog service for its chips - and hands it to the form, which renders
 * it in place of the fields exactly as it does after a submission. An address naming no order
 * reads nothing, so a plain `/checkout` still reaches for no database, and `next build` still
 * produces the route on a clean clone with nothing listening because the segment is never rendered
 * at build time.
 *
 * The read can come to three things, and the page answers each without an error page: the order,
 * which the form shows as its receipt; no order with that reference, which a notice says plainly
 * above the ordinary form; and a read that failed - the database unreachable, a query that did not
 * complete - which a notice reports as a receipt that cannot be shown right now, with a control
 * that asks for this same address again. The order travels to the browser as the plain JSON
 * `OrderDetail` already is, and the receipt reads no clock, so the markup the server sends is the
 * markup the browser hydrates and this route raises no hydration warning of its own.
 *
 * WHAT THE PAGE OWNS
 * Five things: the ancestry trail, the heading block, the read of the order its address names
 * together with the notice that stands in for that order when it cannot be shown, the two columns
 * and their order, and the channel the two columns share a charge over.
 *
 * Not the freight services. A rate is a property of a destination, so there is nothing honest for
 * this page to name before an address has been filled in: the services on offer are the ones
 * `GET /api/shipping/quote` answers with for the destination in the fields, and until it has
 * answered the group shows none and says why. A list of list rates here would be a priced,
 * selectable offer the order would never be charged at, and one a buyer could place an order on
 * while an alert beside it said no service had been quoted.
 *
 * Everything else belongs to what it composes - the contact and destination fields with
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
 * either. The provider renders no element of its own, so it adds nothing to the two columns'
 * wrappers or to the class contract below.
 *
 * WHY EACH COMPONENT IS PASSED SO LITTLE
 * `CheckoutSummaryPanel` is passed its grid class and nothing else - see the class contract below
 * for why that one class travels into it. Its defaults - the "Order review" heading and the listed
 * lines - are written for this exact placing, which its own documentation gives as the example
 * call, and naming the same heading again here would keep one string in two files. The
 * freight charge it prints is not passed either, for a better reason than brevity: it reads it off
 * the shared channel, so the figure travels from the column that owns it to the column that prints
 * it without this page relaying - and therefore without this page being able to relay a different
 * one. The form is passed two sets of starting values, the order its address names when that order
 * was found, and deliberately no `onOrderPlaced` handler: the receipt appears whether a handler was
 * supplied or not, and a page-level hook that navigated or re-requested anything would add a second
 * outcome to a submission that already has one.
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
 * Module, so eight class names are the whole of this page's styling: `.ls-stack` with its
 * `.ls-stack-loose` step, `.ls-page-head` with `.ls-page-title` and `.ls-page-lede`, `.ls-notice`
 * for the notice about the order the address names, and `.ls-split` with `.ls-split-main` and
 * `.ls-split-side`. All but one sit on this page's own wrapper elements. The exception is
 * `.ls-split-side`, which is handed to `CheckoutSummaryPanel` as its `className`, so the review
 * column is itself the grid item rather than the child of one: `.ls-split` holds every item at its
 * own height (`align-items: start`), so a wrapper around the panel would be exactly as tall as the
 * panel and leave its sticky treatment no room to travel while the form beside it scrolls past.
 * That utility contributes nothing but `min-width: 0`, so the panel's module keeps sole ownership
 * of its own box - including which track the column occupies on a wide viewport and how it behaves
 * as the page scrolls, both of which `CheckoutSummaryPanel.module.css` declares and this file
 * therefore does not. The form's wrapper keeps `.ls-split-main`, and the form's own `className` is
 * left alone.
 *
 * The anchor inside that notice carries no class at all, for the reason
 * `app/not-found.tsx` states about its own: the utility set is closed and holds none for a link, so
 * it inherits the alert's ink and the single focus ring the application draws for keyboard use, and
 * `Alert` already lays out the row it sits in.
 */

import type { Metadata } from 'next';
import Link from 'next/link';

import type { ReactElement } from 'react';

import { CheckoutChargesProvider } from '@/components/checkout/CheckoutCharges';
import { CheckoutForm } from '@/components/checkout/CheckoutForm';
import { CheckoutSummaryPanel } from '@/components/checkout/CheckoutSummaryPanel';
import { BreadcrumbTrail, type BreadcrumbCrumb } from '@/components/layout/BreadcrumbTrail';
import { Alert } from '@/components/ui/Alert';
import { Retry } from '@/components/ui/Retry';
import type { CustomerContact, OrderDetail, ShippingAddress } from '@/lib/types';
import { StorefrontNotFoundError } from '@/server/errors';
import { readOrderByNumber } from '@/server/services/order.service';

/* ---------------------------------------------------------------------------
 * Copy
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
 *
 * It points to the order by the heading `CheckoutSummaryPanel` prints over it in every state,
 * "Order review", and then says where that is for both arrangements of the page, because the
 * sentence is read at every width: the review sits beside the form once there is room for two
 * columns, and above it - ahead of the control that places the order - when there is not. It
 * quotes that heading word for word, so renaming the heading means rewording this sentence too.
 */
const PAGE_LEDE =
  'Confirm who the order is for and where it is going, choose the delivery service for that ' +
  'destination, then place the order. What you are ordering is listed under Order review, ' +
  'beside the form or above it on a narrow screen.';

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
 * The address of a placed order
 *
 * A checkout that leaves the URL untouched leaves a placed order with nowhere to be: Back exits
 * the storefront, a reload loses the reference, and nothing on the page routes to it. So the form
 * writes the order's reference into this page's address as it places it, and the declarations below
 * are this route's side of that: the parameter's name, what counts as a reference, the one function
 * that reads the address, the one read of the order it names, and the notice that stands in for
 * that order when it cannot be shown.
 * ------------------------------------------------------------------------- */

/**
 * The query parameter carrying the reference of a placed order.
 *
 * `src/components/checkout/CheckoutForm.tsx` writes the same name with `history.pushState` the
 * moment an order exists, and links to it from the notice about an order this tab lost sight of,
 * and it declares the name separately: a route's query vocabulary is its own contract with the
 * browser - `app/orders/page.tsx` declares its three the same way - and a component importing this
 * module would be a page depending on nothing and a component depending on a page. Change one and
 * change the other.
 */
const ORDER_PARAM = 'order';

/**
 * The shape of a Lumen Supply order reference: `LS-`, the year it was filed under, and the
 * identifier the store minted for it.
 *
 * The parameter is checked against it rather than printed as it arrives, and for a reason that
 * matters on a page anybody can address: whatever a query string carries ends up in this page's
 * markup, so what is printed is bounded to the store's own reference vocabulary - upper-case
 * letters, digits and the two hyphens - and anything else is not a reference this store issued and
 * names no order. The upper bound keeps a very long value out of the heading as well.
 *
 * It is also the gate in front of the database: only a value of this shape is looked up, so an
 * address carrying anything else costs no query and is answered as the plain checkout it is.
 */
const ORDER_NUMBER_SHAPE = /^LS-[0-9]{4}-[0-9A-Z]{4,32}$/;

/**
 * What the notice about a reference no order carries says, under a heading that quotes the
 * reference.
 *
 * It says what is known - the store holds no order with this reference - and the one thing a
 * buyer can check, which is the reference itself against the one they were given. It also says
 * what the form below it does, because a buyer who came here for a receipt is now looking at a
 * form that places an order.
 */
const MISSING_ORDER_BODY =
  'Lumen Supply has no order with this reference. Check it against the order number on your ' +
  'confirmation. The form below places a new order from your cart.';

/**
 * What the notice about an order that could not be read says, under a heading that quotes the
 * reference.
 *
 * A failed read establishes nothing about the order, so the notice claims nothing about it -
 * neither that it exists nor that it does not - and says what the control beside it does: it
 * reads the order again, and reading an order cannot place a second one. That sentence is there
 * for the buyer most likely to see this notice, who has just placed an order and is being shown a
 * form that could place another.
 */
const UNREADABLE_ORDER_BODY =
  'Lumen Supply could not read this order just now, so its receipt cannot be shown. Try again in ' +
  'a moment: trying again only reads the order, so it cannot place a second one.';

/**
 * The label of the control on the notice about a reference no order carries, which routes to the
 * order history.
 *
 * Offered as somewhere to go rather than as a promise about what is there: `app/orders/page.tsx`
 * lists the one demonstration account its own `DEMO_ACCOUNT` names, while `POST /api/checkout`
 * files an order against the session's account or the one it derives from the submitted contact
 * email, so an order placed from this form need not be on the history's default page.
 */
const ORDERS_ACTION = 'View your orders';

/** Where the storefront lists orders. */
const ORDERS_PATH = '/orders';

/**
 * What the read of the order this address names came to.
 *
 * Four states, exclusive by construction, so the page cannot show a receipt and a notice about
 * the same order at once:
 *
 *   `none`         The address names no order - no `?order=`, or a value that is not one of this
 *                  store's references - so nothing was read and the page is the plain checkout.
 *   `found`        The store holds the order, and it is handed to the form to render as its
 *                  receipt.
 *   `missing`      The reference is well formed and the store holds no order with it.
 *   `unavailable`  The read itself failed, so whether the order exists is not known.
 *
 * The last two carry the reference, because their notices quote it; it is the value
 * {@link orderReference} already bounded to this store's reference vocabulary.
 */
type OrderLookup =
  | { readonly state: 'none' }
  | { readonly state: 'found'; readonly order: OrderDetail }
  | { readonly state: 'missing'; readonly reference: string }
  | { readonly state: 'unavailable'; readonly reference: string };

/**
 * The reference this request's address names, or `null` when it names none.
 *
 * A parameter may legitimately arrive more than once - a link that accumulated a duplicate, an
 * address assembled twice - in which case Next.js hands over an array; the first occurrence is
 * taken and the rest dropped, exactly as `app/orders/page.tsx` treats its own, so what is shown is
 * a function of the address rather than of the order the parameters were appended in. A value that
 * is not one of this store's references is answered as no reference at all.
 *
 * @param params The awaited `searchParams` object, exactly as the route received it.
 * @returns The order reference to name, or `null`.
 */
function orderReference(params: Record<string, string | string[] | undefined>): string | null {
  const supplied = params[ORDER_PARAM];
  const first = Array.isArray(supplied) ? supplied[0] : supplied;

  if (first === undefined) {
    return null;
  }

  const trimmed = first.trim();

  return ORDER_NUMBER_SHAPE.test(trimmed) ? trimmed : null;
}

/**
 * Reads the order a reference names, and says what the read came to.
 *
 * One query, issued only for a reference {@link orderReference} accepted, and none otherwise. It
 * never throws: the order service's own "no such order" is the `missing` state, and every other
 * failure - a database that is not listening, a query that did not complete - is the
 * `unavailable` state, so neither reaches `app/error.tsx` and a buyer is never shown an error page
 * for a receipt. The log line carries a fixed label and the failure's kind only - a message or a
 * stack may hold a statement or a connection string - and it goes to the server's own output,
 * never to the page.
 *
 * @param reference The reference the address names, or `null` when it names none.
 * @returns What the read came to; see {@link OrderLookup}.
 */
async function lookUpOrder(reference: string | null): Promise<OrderLookup> {
  if (reference === null) {
    return { state: 'none' };
  }

  try {
    return { state: 'found', order: await readOrderByNumber(reference) };
  } catch (error) {
    if (error instanceof StorefrontNotFoundError) {
      return { state: 'missing', reference };
    }

    console.error(
      'Lumen Supply: the order this checkout address names could not be read:',
      error instanceof Error ? error.name : typeof error,
    );

    return { state: 'unavailable', reference };
  }
}

/**
 * The notice that stands in for the order this address names when it cannot be shown, or `null`
 * when there is nothing to say - no order named, or the order found and shown as the receipt.
 *
 * `warning` for both: the notice is on screen when the page arrives, and `Alert` announces that
 * tone politely, where `danger` interrupts and belongs to a failure the reader has just caused. The
 * element carries no `role` or `aria-live` of its own, because the primitive pairs those with the
 * tone. The two controls are the recoveries that fit each case: a reference nobody holds is
 * somewhere to go from, and a read that failed is a read to repeat - `ui/Retry` asks for this same
 * address again from the browser, which is the recovery a reload performs without discarding the
 * reader's place, and the control every in-notice retry in this store uses.
 *
 * @param lookup What the read of the order came to.
 * @returns The notice, wrapped in this page's `.ls-notice` block, or `null`.
 */
function orderNotice(lookup: OrderLookup): ReactElement | null {
  switch (lookup.state) {
    case 'none':
    case 'found':
      return null;
    case 'missing':
      return (
        <div className="ls-notice">
          <Alert
            tone="warning"
            title={`No order was found for ${lookup.reference}`}
            actions={<Link href={ORDERS_PATH}>{ORDERS_ACTION}</Link>}
          >
            {MISSING_ORDER_BODY}
          </Alert>
        </div>
      );
    case 'unavailable':
      return (
        <div className="ls-notice">
          <Alert
            tone="warning"
            title={`Order ${lookup.reference} could not be loaded`}
            actions={<Retry />}
          >
            {UNREADABLE_ORDER_BODY}
          </Alert>
        </div>
      );
  }
}

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
 * Props of the route, kept local to it: a page's props are Next.js's contract with this file and
 * nothing else's.
 */
interface Props {
  /**
   * The request's query string. It is a promise in the App Router, so it is awaited before any key
   * is read; the union is what a query string can carry, a repeated parameter included. The only
   * key this page reads is {@link ORDER_PARAM}.
   */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

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
 * The checkout page: the trail, the heading, the notice about the order this address names when
 * that order cannot be shown, and the form - or the order's receipt in its place - beside the
 * order review.
 *
 * The two columns are a `.ls-split`, which is a single column until there is room for the second
 * one, so the page needs no breakpoint of its own. The review comes first in the document, and
 * therefore first in reading and keyboard order. On a narrow viewport that puts it above the
 * form, so a buyer has read what they are ordering before they reach the control that places it,
 * rather than finding the order listed only after that control. On a wide viewport
 * `CheckoutSummaryPanel.module.css` places the review in the second track and the form falls into
 * the first, so the review sits beside the form and stays in view while it is filled in.
 *
 * `async` for two reasons: `searchParams` is a promise in the App Router and the reference is read
 * out of it, and the order that reference names is read before the page renders. The second await
 * issues a query only when the address names an order - see the header.
 *
 * @param props The route's props; only the query string is read.
 * @returns The page's content, which the layout places inside the document's single main region.
 */
export default async function CheckoutPage({ searchParams }: Props): Promise<ReactElement> {
  const lookup = await lookUpOrder(orderReference(await searchParams));

  return (
    <div className="ls-stack ls-stack-loose">
      <BreadcrumbTrail items={CRUMBS} />

      <div className="ls-page-head">
        <h1 className="ls-page-title">{PAGE_TITLE}</h1>
        <p className="ls-page-lede">{PAGE_LEDE}</p>
      </div>

      {/* Above both columns, because it is about what a buyer arriving at this URL came for: the
          order the address names, when that order is not the receipt below. A found order has no
          notice at all - the receipt in the first column is the whole of what there is to say
          about it, and a second block naming the same order would describe it twice. */}
      {orderNotice(lookup)}

      {/* The charge channel wraps both columns and contributes no element, so the split below sits
          directly in the page's own DOM - see the note in the header. The review is the first
          grid item and carries the side-column class itself, so it is read before the form and
          its sticky treatment has the whole row to travel in; its module places it in the second
          track once there are two. */}
      <CheckoutChargesProvider>
        <div className="ls-split">
          <CheckoutSummaryPanel className="ls-split-side" />

          <div className="ls-split-main">
            {/* A found order is handed over as it was read, and the form renders it as its
                receipt in place of the fields - the same receipt a submission shows. */}
            <CheckoutForm
              initialContact={PREFILLED_CONTACT}
              initialAddress={PREFILLED_ADDRESS}
              placedOrder={lookup.state === 'found' ? lookup.order : undefined}
            />
          </div>
        </div>
      </CheckoutChargesProvider>
    </div>
  );
}
