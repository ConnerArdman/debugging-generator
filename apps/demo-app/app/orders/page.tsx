/*
 * Lumen Supply - the order history, served at `/orders`.
 *
 * One route, one question: what has this account ordered, when, and how far along is each one. The
 * page reads the query string, parses it with the schema that declares the listing's parameters,
 * asks this application's own orders endpoint for the page of orders and hands it to
 * `OrderHistoryList`. There is nothing else here.
 *
 * WHAT THIS FILE OWNS, AND WHAT IT DOES NOT
 * It owns the request - the query string, the one service call, the failure path - together with
 * the page's ancestry trail, its heading block and the notice shown when the history cannot be
 * read. Everything below the heading belongs to `OrderHistoryList`: the result count, the column
 * strip, the rows, the pager and the blank slate a customer with no orders sees. That division is
 * why no row, no count and no page arithmetic appears in this file, and why it declares no
 * component of its own. The list has no error prop by design, so the notice is this page's own
 * surface rather than something passed into it.
 *
 * THE HISTORY COMES FROM THE ENDPOINT
 * `GET /api/orders` answers this listing, and the page reads it over HTTP through
 * `loadOrderHistory` in `@/lib/api-client` rather than calling the order service in process. One
 * code path therefore answers the list a customer is looking at and any other caller of the same
 * endpoint, so a bound, a default or a payload change cannot apply to one and not the other. A
 * server render has no relative base to resolve `/api/...` against, so the address the read is sent
 * to comes from `@/server/origin`, which answers with the storefront's configured address or the
 * loopback address on the port this process bound - never with anything a request carries.
 *
 * EVERY VISIT IS ITS OWN REQUEST
 * An order moves from pending to paid to fulfilled while the customer is watching, so the segment
 * is `force-dynamic` and nothing on this path is cached, memoized or revalidated: turning a page
 * genuinely asks the database again. It is also this workspace's build-time contract - `next build`
 * renders no route against the database, so a clean clone builds with a placeholder connection
 * string and nothing listening - hence no `generateStaticParams`, no `revalidate` and no `runtime`
 * override; the segment runs on Node, like the rest of the application.
 *
 * A MALFORMED ADDRESS IS STILL AN ADDRESS
 * Both ways a visit can be wrong are answered with a page rather than an error. A query string the
 * schema rejects - `?page=abc`, a page size past the bound, a status this store does not use -
 * falls back to the listing's own defaults, because the reader who followed a truncated link wants
 * their orders, not a diagnostic. A history that could not be read renders the trail, the heading
 * and one reader-facing sentence, and omits the list entirely: an empty list would say "you have
 * never ordered anything", which is a different and much worse statement than "the history is
 * missing".
 *
 * NO CLOCK
 * `OrderHistoryList` forwards an optional `referenceIso` to each row, which is the instant relative
 * date wording would be measured against. None is passed here: the only honest source would be a
 * clock read, the server would read one instant and the browser's first render another, and the
 * rows print the absolute date alone without it. Nothing in this file formats a date or a sum
 * either - the row and `@/lib/format` own that.
 */

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

import { OrderHistoryList } from '@/components/checkout/OrderHistoryList';
import { BreadcrumbTrail, type BreadcrumbCrumb } from '@/components/layout/BreadcrumbTrail';
import { Alert } from '@/components/ui/Alert';
import { StorefrontApiError, loadOrderHistory } from '@/lib/api-client';
import type { OrderSummary, PagedList, StorefrontErrorCode } from '@/lib/types';
import { storefrontOrigin } from '@/server/origin';
import { ordersQuerySchema, type OrdersQueryInput } from '@/server/validation/orders';

/* ---------------------------------------------------------------------------
 * Copy
 *
 * All-caps by convention, and the convention earns its keep:
 * `scripts/check-no-hardcoding.mjs` harvests this application's camel-case declarations into
 * vocabulary no product file may then mention, and skips a name with no camel boundary. A constant
 * spelled this way costs the product nothing.
 * ------------------------------------------------------------------------- */

/** The page's heading, and the title the root layout's template suffixes. */
const PAGE_TITLE = 'Orders';

/** The sentence under the heading: what the list shows and the order it shows it in. */
const PAGE_LEDE =
  'Every order placed on this account, newest first, with what it cost, how many units it ' +
  'carried and how far along it is. The history is read for each visit, so a status that has ' +
  'moved since the last look is already here.';

/**
 * The ancestry the trail prints. Two entries, which is the minimum `BreadcrumbTrail` renders
 * anything for: the storefront's entry point, and this page itself with no destination, which is
 * the one crumb marked as current.
 */
const CRUMBS: readonly BreadcrumbCrumb[] = [{ label: 'Catalog', href: '/' }, { label: PAGE_TITLE }];

/** The heading of the notice shown in place of the list when the history cannot be read. */
const NOTICE_TITLE = 'Order history unavailable';

/**
 * What the notice says when the reason is not one a reader can act on, and the sentence every
 * unrecognised failure collapses into.
 *
 * It describes the situation and nothing about its cause: a thrown value carries a stack, a
 * statement, a driver code or a row, and none of those is a customer's to see. It also states what
 * has *not* happened, because a missing order history is exactly the moment a customer wonders
 * whether an order went missing with it.
 */
const GENERIC_NOTICE =
  'Your order history could not be read just now. No order has been changed or cancelled, and ' +
  'reloading the page asks for the list again.';

/**
 * The failures this page can tell a reader what to do about, by the code the error carries.
 *
 * `Partial` on purpose: the application's error vocabulary covers surfaces this page has nothing to
 * do with - a declined card, an unknown payment outcome, a cart conflict - and a sentence invented
 * for each of them here would be wording no reader of this page can ever see. An absent entry reads
 * as {@link GENERIC_NOTICE}, which is also what a value that is not this application's error
 * becomes.
 *
 * Both sentences name the address bar rather than a parameter, because that is what a reader can
 * act on; a parameter name is an implementation detail.
 */
const NOTICES: Partial<Record<StorefrontErrorCode, string>> = {
  NOT_FOUND:
    'No account matches the one named in the address bar. Opening Orders from the store ' +
    'navigation lists the history for this account instead.',
  VALIDATION_FAILED:
    'The address bar asks for something this history cannot list. Opening Orders from the store ' +
    'navigation returns to the first page of it.',
};

/* ---------------------------------------------------------------------------
 * The account whose orders are listed
 * ------------------------------------------------------------------------- */

/** Where this list is served from, and the path its pager rewrites the page parameter of. */
const PATH = '/orders';

/**
 * The query parameters the pager's base carries forward, spelled exactly as
 * `ordersQuerySchema` reads them so that a page the pager links to parses as the page the reader
 * was already looking at.
 */
const ACCOUNT_PARAM = 'customerId';
const STATUS_PARAM = 'status';
const SIZE_PARAM = 'pageSize';

/**
 * The account this page lists when the address names none.
 *
 * `ordersQuerySchema` requires a customer - every order belongs to exactly one, and a listing with
 * no customer would be every customer's orders - so the identifier has to come from somewhere for
 * the store navigation's plain `/orders` link to answer with a history at all. It is the account
 * `prisma/seed.ts` writes first and attaches its one populated demo cart to, which is the same
 * account the cart drawer, checkout and this list therefore agree on across a freshly seeded
 * database, a storefront opened for the first time and an automated run.
 *
 * The literal is duplicated from the seed rather than shared with it, exactly as
 * `@/server/validation/cart` and `@/server/services/checkout.service` duplicate the demo cart's
 * session token: `prisma/seed.ts` is a script the Prisma CLI runs, nothing under `src/` or `app/`
 * may import from it, and the value is reproducible - the seed draws every identifier from one
 * fixed pseudo-random sequence, so each load writes this same account.
 *
 * It is a default, never an assumption: an identifier no customer owns is answered with an empty
 * page rather than a failure, so a database seeded differently shows the list's blank slate here
 * instead of an error, and `?customerId=` names any other account explicitly.
 */
const DEMO_ACCOUNT = 'chqahbkbcz8f69elo6g8tq5bd';

/**
 * The account to list: the one the address named, or {@link DEMO_ACCOUNT}.
 *
 * A parameter that carries nothing is treated as one that was never sent - absent, and whitespace
 * alike, which is what a cleared field or a copied link leaves behind - so the default takes over
 * instead of the schema rejecting a blank identifier and the whole query falling back with it.
 * Every other value is passed through untouched for the schema to judge: the bounds and the
 * character rules are its, not this function's.
 *
 * @param value Whatever the address supplied for the account, if anything.
 * @returns An identifier to parse, never a blank one.
 */
function account(value: string | undefined): string {
  return value === undefined || value.trim().length === 0 ? DEMO_ACCOUNT : value;
}

/* ---------------------------------------------------------------------------
 * The query string
 * ------------------------------------------------------------------------- */

/**
 * The query string as a record of single values, which is the shape `ordersQuerySchema` reads.
 *
 * A parameter may legitimately arrive more than once - a link that accumulated a duplicate, a form
 * submitted twice - in which case Next.js hands over an array. The first occurrence is taken and
 * the rest are dropped: a filter has one value, and choosing the first makes the listing a function
 * of the address rather than of the order a client happened to append parameters in.
 *
 * A key holding `undefined` is left out entirely instead of being copied as an absent value, so the
 * field's own default takes over. Every key is forwarded rather than a hand-written list of the ones
 * this page knows about - the schema owns that vocabulary and strips whatever it does not
 * recognise - so an orders URL that also carries a campaign parameter is still a perfectly good
 * request for this history.
 *
 * @param params The awaited `searchParams` object, exactly as the route received it.
 * @returns One string per parameter that carried a value.
 */
function scalars(params: Record<string, string | string[] | undefined>): Record<string, string> {
  const flat: Record<string, string> = {};

  for (const [key, value] of Object.entries(params)) {
    const first = Array.isArray(value) ? value[0] : value;

    if (first !== undefined) {
      flat[key] = first;
    }
  }

  return flat;
}

/**
 * The address `OrderHistoryList`'s pager rewrites the page number of.
 *
 * It is built from the parsed query rather than from the address bar, so every destination the
 * pager offers is a request that parses: a value the schema coerced is carried forward in its
 * canonical form, and a value it rejected is not carried forward at all - the reader is looking at
 * the fallback listing in that case, and a base still claiming the rejected filter would send them
 * back to it on every page turn.
 *
 * The page size is always stated so that a reader who asked for a different window keeps it while
 * moving through the pages. The account is stated only when it is not this page's own default,
 * which keeps the address a reader can copy free of an identifier they never typed; the next
 * request resolves the same account for itself. The page number is deliberately absent - the pager
 * sets it, and a value here would only be one it overwrites.
 *
 * @param query The parsed query the listing on screen was read with.
 * @returns A relative URL carrying every parameter except the page number.
 */
function base(query: OrdersQueryInput): string {
  const params = new URLSearchParams();

  if (query.customerId !== DEMO_ACCOUNT) {
    params.set(ACCOUNT_PARAM, query.customerId);
  }

  if (query.status !== undefined) {
    params.set(STATUS_PARAM, query.status);
  }

  params.set(SIZE_PARAM, String(query.pageSize));

  return `${PATH}?${params.toString()}`;
}

/* ---------------------------------------------------------------------------
 * Failure copy
 * ------------------------------------------------------------------------- */

/**
 * The sentence shown in place of the list for a caught value.
 *
 * `catch` binds `unknown`, and the only thing read off it is the code the endpoint reported: no
 * message, no `details`, no status and no stringification reaches the markup, so nothing the
 * database, the driver or a bug wrote can be printed on the page. A reason this application did
 * not state itself - a request that never arrived, a reply that could not be read - collapses into
 * the generic sentence rather than becoming advice about the address bar, because it says nothing
 * about the address bar.
 *
 * @param error Any caught value.
 * @returns One of {@link NOTICES}, or {@link GENERIC_NOTICE}.
 */
function notice(error: unknown): string {
  if (error instanceof StorefrontApiError && error.reported) {
    return NOTICES[error.code] ?? GENERIC_NOTICE;
  }

  return GENERIC_NOTICE;
}

/* ---------------------------------------------------------------------------
 * The route
 * ------------------------------------------------------------------------- */

/**
 * Props of the route, kept local to it: a page's props are Next.js's contract with this file and
 * nothing else's.
 */
interface Props {
  /**
   * The request's query string. It is a promise in the App Router, so it is awaited before any key
   * is read; the union is what a query string can carry, a repeated parameter included.
   */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Answer every visit from the database rather than from a build-time render or a cached entry.
 *
 * Restated here rather than inherited, because it is this page's contract as much as the layout's:
 * an order's status is live, so a render is only meaningful for the request that asked for it, and
 * `next build` must reach for no database to produce this route.
 */
export const dynamic = 'force-dynamic';

/**
 * The tab's title. Short and static: the root layout's `'%s · Lumen Supply'` template supplies the
 * rest, and there is nothing about this route that a request could change about it.
 */
export const metadata: Metadata = { title: PAGE_TITLE };

/**
 * The order history: one page of this account's orders, or the notice that stands in for it.
 *
 * @param props The route's props; only the query string is read.
 * @returns The page's content, which the layout places inside the document's single main region -
 * hence no main landmark of its own, no second page container, and exactly one level-one heading.
 */
export default async function OrderHistoryPage({ searchParams }: Props): Promise<ReactElement> {
  const supplied = scalars(await searchParams);

  /*
   * The account is resolved before the query is parsed, so the schema sees a complete request and
   * applies its own defaults to everything else. A rejected query is then answered with the
   * listing's defaults rather than with an error: `safeParse` never throws, and re-parsing the
   * account alone is exact because every other parameter of this schema is defaulted. The parsed
   * values are the endpoint's own parameters, so they are forwarded by name below rather than
   * reshaped.
   */
  const parsed = ordersQuerySchema.safeParse({
    ...supplied,
    [ACCOUNT_PARAM]: account(supplied[ACCOUNT_PARAM]),
  });
  const query: OrdersQueryInput = parsed.success
    ? parsed.data
    : ordersQuerySchema.parse({ [ACCOUNT_PARAM]: DEMO_ACCOUNT });

  /*
   * One read, and the only thing in this file that can fail - the authority the request is
   * addressed to included, which is established inside the same `try` because an address this
   * store may not call itself on and an endpoint that answered with a failure are the same thing
   * to a reader. The notice starts out as the wording for a failure nobody can act on, so the page
   * always has something to say; a caught value replaces it with the sentence its code earns and
   * leaves the page of orders unset, which is what selects the notice below. The log line carries a
   * fixed label and the failure's kind only - a message or a stack may hold a path, a statement or
   * a connection string - and it goes to the server's own output, never to the page.
   */
  let orders: PagedList<OrderSummary> | null = null;
  let failure = GENERIC_NOTICE;

  try {
    const origin = storefrontOrigin();

    orders = await loadOrderHistory({
      customerId: query.customerId,
      status: query.status,
      page: query.page,
      pageSize: query.pageSize,
      origin,
    });
  } catch (error) {
    console.error(
      'Lumen Supply: the order history could not be read:',
      error instanceof Error ? error.name : typeof error,
    );

    failure = notice(error);
  }

  return (
    <div className="ls-stack ls-stack-loose">
      <BreadcrumbTrail items={CRUMBS} />

      <header className="ls-page-head">
        <h1 className="ls-page-title">{PAGE_TITLE}</h1>
        <p className="ls-page-lede">{PAGE_LEDE}</p>
      </header>

      {orders === null ? (
        /*
         * `warning` rather than `danger`: the notice is here on arrival, and `ui/Alert` announces
         * `danger` assertively, which belongs to a failure the reader just caused. The element
         * carries no `role` and no `aria-live` of its own - the primitive pairs those with the tone
         * itself, and a second pairing here would have the message announced twice.
         */
        <div className="ls-notice">
          <Alert tone="warning" title={NOTICE_TITLE}>
            {failure}
          </Alert>
        </div>
      ) : (
        /*
         * The page of orders is passed exactly as the service produced it - integer cents, an
         * ISO-8601 timestamp, no `Date` and no class instance - and the pager is given the address
         * the listing was read from, so the page it offers next is this same query one page on.
         */
        <OrderHistoryList orders={orders} pageHrefBase={base(query)} />
      )}
    </div>
  );
}
