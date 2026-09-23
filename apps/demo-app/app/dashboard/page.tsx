/*
 * Lumen Supply - the inventory dashboard.
 *
 * One route, one question: what is in stock, where, and which lines are close enough to their
 * reorder point to be worth acting on. The page reads the dashboard's payload once and hands it to
 * four components - the filter row, the figure row, the stock table and the low-stock list - each
 * of which owns its own markup, its own heading and its own empty state. There is nothing else
 * here: no query, no paging arithmetic, no formatting and no copy that belongs to a component.
 *
 * THE ENDPOINT IS READ, NOT THE SERVICE
 * `GET /api/inventory/summary` is this dashboard's feed, and the page asks it for the payload over
 * HTTP - through `loadInventorySummary` in `@/lib/api-client` - rather than calling the inventory
 * service in process. One code path therefore answers the dashboard a reader is looking at and any
 * other caller of the same endpoint, so the two cannot drift: the parameters the endpoint bounds
 * are bounded for this page too, and the payload it serializes is the payload rendered here. A
 * server render has no relative base to resolve `/api/...` against, so the address the read is sent
 * to comes from `@/server/origin`, which answers with the storefront's configured address or the
 * loopback address on the port this process bound - never with anything a request carries.
 *
 * ONE READING OF THE QUERY STRING
 * Every parameter this page accepts is parsed once, by the same schema the endpoint uses, and the
 * parsed values are then passed down: the endpoint receives them as its query, the filter row
 * receives them as the filter now in force, and the stock table's pager carries them across a page
 * change. Nothing below reads `searchParams` twice and nothing reads the address bar in the
 * browser, which is what keeps the figures, the controls and the URL describing the same request.
 *
 * A MALFORMED QUERY IS STILL A DASHBOARD VISIT
 * `inventorySummaryQuerySchema` defaults every value-bearing parameter, so a query it rejects is
 * answered by re-parsing an empty one: a hand-typed `?threshold=abc` renders the figures the
 * dashboard opens on instead of an error page. The recovery is wholesale rather than field by
 * field, because a partially salvaged query would show figures under a filter the reader cannot see
 * in the address bar.
 *
 * AND A FAILED READ IS STILL A DASHBOARD VISIT
 * A query the schema accepts can still ask for something the feed cannot answer - a location
 * identifier that no longer names one is the everyday case - and the answer to that is a notice in
 * place of the figures, never in place of the page. The filter row stays mounted above it and the
 * notice carries a link back to this route's own path, so the filter the notice is asking the
 * reader to clear is a filter they can actually reach: with both, recovery is one control away by
 * pointer or by keyboard, and with neither it was a URL to retype by hand.
 *
 * WHAT THE PAGE DOES NOT OWN
 *   - The document, the main landmark and the site chrome: `app/layout.tsx` mounts `PageContainer`
 *     around every route, so this page renders its own breadcrumb trail and its own level-one
 *     heading inside that region and adds neither a second landmark nor a second container.
 *   - Sections and headings: `InventoryKpiCards`, `InventoryLevelsTable` and `LowStockList` each
 *     render a named region of their own, so wrapping them here would name every region twice. The
 *     table takes its visible title as a prop because its `<caption>` is the alternative, and one
 *     of the two has to be the name assistive technology hears.
 *   - Layout values: the `.ls-*` utilities in `app/globals.css` are the whole vocabulary a route
 *     file has, and a route file adds no CSS Module. There is no inline `style` below and no colour,
 *     spacing or type value of any kind.
 *   - Numbers, dates and labels: every figure printed on this page is formatted by the component
 *     that prints it, through `@/lib/format`. This file prints no number.
 *
 * THE SHELL ARRIVES FIRST
 * The read is not awaited before the page returns. The trail and the heading are sent immediately,
 * the single `Suspense` boundary below holds the space the data will occupy, and the body swaps in
 * when the payload lands. What fills that space is each component's own placeholder -
 * `InventoryKpiCardsPlaceholder`, `InventoryLevelsTablePlaceholder`, `LowStockListPlaceholder` - so
 * the wait has the shape of the answer and the layout does not jump when the figures arrive.
 *
 * THE PAYLOAD IS THE WHOLE SURFACE
 * `InventorySummary` carries five figures, the stocking locations the filter lists, one page of the
 * stock lines together with the products naming them, and the most urgent lines at or below their
 * reorder point. The page composes exactly that and invents nothing: `page` and `pageSize` in the
 * address window the stock table, which is the surface that carries a pager, while the low-stock
 * list is the lines worth acting on today and reports its own total through the figure row.
 *
 * NO CLOCK, NO CACHE
 * `formatTimeAgoLabel` takes its reference instant as an argument so that a server render and the
 * browser's first render produce the same words; the reference handed down here is the payload's
 * own `generatedAt`, which is the instant the figures were computed and needs no clock read. And
 * because the figures are live stock, the route is `force-dynamic` and nothing on this path is
 * cached or memoized: a repeated filter submission genuinely asks the database again.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense, type ReactElement } from 'react';

import {
  InventoryKpiCards,
  InventoryKpiCardsPlaceholder,
} from '@/components/dashboard/InventoryKpiCards';
import {
  InventoryLevelsTable,
  InventoryLevelsTablePlaceholder,
} from '@/components/dashboard/InventoryLevelsTable';
import { LowStockList, LowStockListPlaceholder } from '@/components/dashboard/LowStockList';
import { WarehouseFilter } from '@/components/dashboard/WarehouseFilter';
import { BreadcrumbTrail, type BreadcrumbCrumb } from '@/components/layout/BreadcrumbTrail';
import { Alert } from '@/components/ui/Alert';
import { Retry } from '@/components/ui/Retry';
import { StorefrontApiError, loadInventorySummary } from '@/lib/api-client';
import type { InventorySummary, StorefrontErrorCode } from '@/lib/types';
import { storefrontOrigin } from '@/server/origin';
import {
  inventorySummaryQuerySchema,
  type InventorySummaryQueryInput,
} from '@/server/validation/inventory';

/* ---------------------------------------------------------------------------
 * Copy
 *
 * All-caps by convention, and the convention earns its keep:
 * `scripts/check-no-hardcoding.mjs` harvests this application's camel-case
 * declarations into vocabulary no product file may then mention, and skips a
 * name with no camel boundary. A constant spelled this way costs the product
 * nothing.
 * ------------------------------------------------------------------------- */

/** The page's heading, and the title the root layout's template suffixes. */
const PAGE_TITLE = 'Inventory';

/** The sentence under the heading: what the page shows, and how current it is. */
const PAGE_LEDE =
  'Stock held across every location this network ships from, with the lines closest to their ' +
  'reorder point listed first. The figures are read from the warehouse records for each visit, ' +
  'so a reload answers with the position as it stands.';

/**
 * The ancestry the trail prints. Two entries, which is the minimum
 * `BreadcrumbTrail` renders anything for: the storefront's entry point, and the
 * page itself with no destination, which is the one crumb marked as current.
 */
const CRUMBS: readonly BreadcrumbCrumb[] = [{ label: 'Catalog', href: '/' }, { label: PAGE_TITLE }];

/** The stock table's visible title, which is also the name its caption carries. */
const TABLE_TITLE = 'Stock by location';

/** Where the stock table's pager points, which is this route's own address. */
const PATH = '/dashboard';

/** The heading of the notice shown in place of the figures when they cannot be read. */
const NOTICE_TITLE = 'Inventory figures unavailable';

/**
 * What the notice says when the reason is not one this page can act on, and the
 * sentence every unrecognised failure collapses into.
 *
 * It describes the situation and nothing about its cause: a failed read carries
 * a status, a stack, a statement or a driver code, and none of those is a
 * reader's to see. The service layer is where a failure is worth a log line.
 */
const GENERIC_NOTICE =
  'The stock figures could not be read just now. Nothing in the warehouse records has changed, ' +
  'and reloading the page asks for them again.';

/**
 * The failures this page can tell a reader what to do about, by the code the
 * failure carries.
 *
 * `Partial` on purpose: the application's error vocabulary covers surfaces this
 * page has nothing to do with - a declined card, an unknown payment outcome -
 * and a sentence invented for each of them here would be wording no reader of
 * this page can ever see. An absent entry reads as {@link GENERIC_NOTICE},
 * which is also what an unreported reason becomes.
 *
 * Both sentences name the address bar rather than a parameter: the filter row
 * writes the query string, so "clear the filter" is an instruction a reader can
 * follow, while a parameter name is an implementation detail.
 */
const NOTICES: Partial<Record<StorefrontErrorCode, string>> = {
  NOT_FOUND:
    'No stocking location matches the filter in the address bar. Clearing the location filter ' +
    'reports on every location again.',
  VALIDATION_FAILED:
    'The filter in the address bar asks for something this dashboard cannot report. Clearing it ' +
    'returns to the figures the dashboard opens on.',
};

/**
 * The wording of the notice's own way out: this route with nothing asked of it.
 *
 * It names the outcome rather than the mechanism - a reader who has arrived at
 * a dashboard with no figures wants every location back, not to be told about a
 * query string - and it is a link rather than a button because it is exactly
 * that: a destination, reachable with no scripting, which the filter row's Clear
 * then duplicates for a reader already holding the controls.
 */
const RECOVERY_LABEL = 'Report on every location';

/* ---------------------------------------------------------------------------
 * The query
 * ------------------------------------------------------------------------- */

/**
 * The query a bare visit to this route parses to: every parameter at the value
 * its absence means.
 *
 * Read from the schema rather than restated, so the figures this page opens on
 * and the figures it falls back to cannot drift from the endpoint's own
 * defaults, and so no default is written down twice. Parsing an empty object is
 * exact because every value-bearing parameter of the schema is defaulted, and it
 * is done once at module scope because the answer cannot differ between
 * requests.
 *
 * Used for two things: the query a rejected one is answered with, and the
 * comparison that decides whether a visit is filtered at all - which is what
 * tells the notice below whether it has anything to offer a way out of.
 */
const DEFAULT_QUERY: InventorySummaryQueryInput = inventorySummaryQuerySchema.parse({});

/**
 * Whether `query` asks for anything other than the dashboard's opening state.
 *
 * The three filters are compared against "absent" and the headroom figure
 * against the default the schema applies, which is precisely the set of
 * parameters the filter row writes into the URL - so this answers the reader's
 * question, "is there a filter here to get rid of", and not a narrower one about
 * one parameter. `page` and `pageSize` are deliberately not read: a reader on
 * page four of an unfiltered dashboard has nothing to clear.
 *
 * @param query The parsed query the page is answering.
 * @returns `true` when at least one filter is in force.
 */
function filtered(query: InventorySummaryQueryInput): boolean {
  return (
    query.warehouseId !== null ||
    query.state !== null ||
    query.movement !== null ||
    query.threshold !== DEFAULT_QUERY.threshold
  );
}

/* ---------------------------------------------------------------------------
 * The read
 * ------------------------------------------------------------------------- */

/**
 * What one read of the dashboard's feed produced: the payload, or the sentence
 * to show in its place.
 *
 * Two states rather than a payload and an optional message, so the body below
 * cannot render a table and a notice at the same time.
 */
type Outcome =
  | { readonly summary: InventorySummary; readonly failure: null }
  | { readonly summary: null; readonly failure: string };

/**
 * The fixed sentence shown in place of the figures for a caught value.
 *
 * `catch` binds `unknown`, and the only thing read off it is the code the
 * endpoint reported: no message, no `details`, no status and no stringification
 * reaches the markup, so nothing the database, the driver or a bug wrote can be
 * printed on the page. A reason this application did not state itself - a
 * request that never arrived, a reply that could not be read - is not treated
 * as a statement about the filter, because it is not one.
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

/**
 * Reads the dashboard's feed for `query`.
 *
 * The authority is established first, because a request cannot be addressed
 * without one, and deliberately outside the `try`: the two failures it can
 * raise are this deployment being configured with an address it cannot be
 * reached at, and a process that cannot establish the address it answers on.
 * Neither is a figure that could not be read, and neither is something a reader
 * can do anything about by asking for the dashboard again, so neither is
 * collapsed into this page's notice - they leave this function, and
 * `app/error.tsx` is what says so, once, for every route in the store.
 *
 * A read that fails is a different matter and is what the `try` is for: it
 * never rejects, because a dashboard that cannot show its figures is still a
 * dashboard visit.
 *
 * @param query The parsed query, whose members are the endpoint's parameters.
 * @returns The payload, or the sentence to render in its place.
 * @throws StorefrontError `INTERNAL_ERROR` when the address this store answers
 * on cannot be established, which reaches the route's error boundary.
 */
async function read(query: InventorySummaryQueryInput): Promise<Outcome> {
  const origin = storefrontOrigin();

  try {
    const summary = await loadInventorySummary({
      warehouseId: query.warehouseId,
      threshold: query.threshold,
      page: query.page,
      pageSize: query.pageSize,
      state: query.state,
      movement: query.movement,
      origin,
    });

    return { summary, failure: null };
  } catch (error) {
    return { summary: null, failure: notice(error) };
  }
}

/**
 * The parameters the stock table's pager carries across a page change.
 *
 * Built from the parsed query rather than from the address the reader arrived
 * with, so every destination the pager offers is a request that parses: a value
 * the schema coerced is carried forward in its canonical form, and a value it
 * rejected is not carried forward at all - the reader is looking at the fallback
 * figures in that case, and a link still claiming the rejected filter would send
 * them back to it on every page turn. The page number is deliberately absent:
 * the pager sets it, and a value here would only be one it overwrites.
 *
 * @param query The parsed query the figures on screen were read with.
 * @returns One string per parameter that is in force.
 */
function carried(query: InventorySummaryQueryInput): Record<string, string> {
  const params: Record<string, string> = {
    threshold: String(query.threshold),
    pageSize: String(query.pageSize),
  };

  if (query.warehouseId !== null) {
    params.warehouseId = query.warehouseId;
  }

  if (query.state !== null) {
    params.state = query.state;
  }

  if (query.movement !== null) {
    params.movement = query.movement;
  }

  return params;
}

/* ---------------------------------------------------------------------------
 * The data regions
 * ------------------------------------------------------------------------- */

/**
 * The space the data occupies while the feed is still being read: the figure
 * row, the stock table and the low-stock list, each reserved by its own
 * component's placeholder so the layout the reader waits in front of is the
 * layout that arrives.
 *
 * Each placeholder owns its own busy region and its own announcement, which is
 * why this function adds neither: a second `role="status"` here would have the
 * wait announced twice.
 */
function DashboardPlaceholder({ rows }: { rows: number }): ReactElement {
  return (
    <>
      <InventoryKpiCardsPlaceholder />

      <div className="ls-split">
        <div className="ls-split-main">
          <InventoryLevelsTablePlaceholder heading={<h2>{TABLE_TITLE}</h2>} rows={rows} />
        </div>

        <div className="ls-split-side">
          <LowStockListPlaceholder />
        </div>
      </div>
    </>
  );
}

/**
 * The dashboard's data: one read of the feed, and either the four components it
 * fills or the filter row over the notice that stands in for the other three.
 *
 * The failure is one notice rather than one per region, because one read
 * produced all three: three notices would announce a single failure three times,
 * and `ui/Alert` is announced politely here because the reader did not cause it.
 * An empty answer is not a failure and is not treated as one - the table and the
 * list each say what an empty page of their own means.
 *
 * @param props The parsed query, which is both what to ask for and what the
 * controls show as being in force.
 * @returns The populated dashboard, or the notice in its place.
 */
async function DashboardData({
  query,
}: {
  query: InventorySummaryQueryInput;
}): Promise<ReactElement> {
  const outcome = await read(query);

  if (outcome.summary === null) {
    /*
     * The payload is missing, so the figures, the table and the list are all
     * omitted: an empty table or a row of zeroes would read as "nothing in
     * stock", which is a different and much worse statement than "the figures
     * are missing". `warning` rather than `danger` because `ui/Alert` announces
     * `danger` assertively, which belongs to a failure the reader just caused.
     *
     * The filter row is NOT omitted, and that is the difference between a
     * notice and a dead end. The most likely reason this branch is reached is
     * the filter itself - an identifier in the address bar that no longer names
     * a location - and the notice's own advice is to clear it, which a reader
     * can only follow if the controls are still there. Dropping them left the
     * whole page holding one interactive element, a breadcrumb, under a sentence
     * about a filter that was nowhere on screen; recovery meant editing the URL
     * by hand. The row is given no locations, because the payload that lists
     * them is the payload that did not arrive, and it is given the parsed query,
     * so it shows what was asked for - naming an unlisted location as unlisted -
     * rather than a filter nobody chose.
     *
     * It is passed no children either: there are no figures behind this notice
     * to mark as updating, and the notice already announces itself.
     *
     * The copy says that asking again is what fetches the figures, so the
     * control that asks is in the notice with it rather than left to the reader
     * to find: `ui/Retry` requests this route again from the browser, which is
     * the same recovery a reload performs without discarding the cart, the
     * filter in the address bar or the reader's place on the page. It is the one
     * control every in-notice action in this store uses, so nothing about its
     * size or colour is decided here.
     */
    const action = (
      <div className="ls-actions">
        <Retry />
        {filtered(query) ? <Link href={PATH}>{RECOVERY_LABEL}</Link> : null}
      </div>
    );

    return (
      <>
        <WarehouseFilter
          warehouses={[]}
          selectedWarehouseId={query.warehouseId}
          threshold={query.threshold}
          stockState={query.state}
          movementType={query.movement}
        />

        <div className="ls-notice">
          {/*
            Asking again is always offered. The way out of the filter is offered
            only when there is something to leave: on an unfiltered visit this
            branch means the read itself failed, and a link to the address
            already being shown would be a control that changes nothing - the
            same dead affordance this notice was missing, in the opposite
            direction.
          */}
          <Alert tone="warning" title={NOTICE_TITLE} actions={action}>
            {outcome.failure}
          </Alert>
        </div>
      </>
    );
  }

  const summary = outcome.summary;

  return (
    <>
      {/*
        The locations the filter lists come from the payload already in hand
        rather than from a second request, and the applied values are the ones
        parsed above, so the controls open showing the filter the figures beside
        them were produced under.

        The three regions the filter governs are its children, and that is an
        accessibility decision rather than a layout one. A filter change is a
        navigation the row performs inside a transition, so React keeps this
        already-mounted subtree on screen while the server answers and the
        boundary below never falls back to its placeholder: the figures a reader
        is looking at mid-change are the previous filter's figures. The row is
        the only component that knows a change is in flight, so it is the
        component that marks them - see its `children` prop - and `bodyClassName`
        hands it the rhythm these regions had as members of this page's own
        stack, so the wrapper it renders takes that level's place rather than
        adding one.
      */}
      <WarehouseFilter
        warehouses={summary.warehouses}
        selectedWarehouseId={query.warehouseId}
        threshold={query.threshold}
        stockState={query.state}
        movementType={query.movement}
        bodyClassName="ls-stack ls-stack-loose"
      >
        {/*
          Every component below measures the payload's age against the instant it
          was computed, which is the payload's own `generatedAt`: a reference read
          from the clock would differ between the server's markup and the browser's
          first render.
        */}
        <InventoryKpiCards summary={summary} referenceIso={summary.generatedAt} />

        <div className="ls-split">
          <div className="ls-split-main">
            {/*
              The page of stock lines exactly as the feed answered it - the rows,
              the page they are on and the number of lines the filters matched -
              together with the products naming them. The pager's links are this
              route's own address carrying the filter now in force, so a page
              change keeps the filter and changes only the page.
            */}
            <InventoryLevelsTable
              levels={summary.levels}
              products={summary.levelProducts}
              threshold={query.threshold}
              generatedAt={summary.generatedAt}
              referenceIso={summary.generatedAt}
              heading={<h2>{TABLE_TITLE}</h2>}
              basePath={PATH}
              query={carried(query)}
            />
          </div>

          <div className="ls-split-side">
            <LowStockList rows={summary.lowStock} threshold={query.threshold} />
          </div>
        </div>
      </WarehouseFilter>
    </>
  );
}

/* ---------------------------------------------------------------------------
 * The route
 * ------------------------------------------------------------------------- */

/**
 * Props of the route, kept local to it: a page's props are Next.js's contract
 * with this file and nothing else's.
 */
interface Props {
  /**
   * The request's query string. It is a promise in the App Router, so it is
   * awaited before any key is read; the union is what a query string can carry,
   * a repeated parameter included.
   */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Answer every visit from the database rather than from a build-time render or
 * a cached entry.
 *
 * Restated here rather than inherited, because it is this page's contract as
 * much as the layout's: the figures are live stock, so a render is only
 * meaningful for the request that asked for it, and `next build` must reach for
 * no database to produce this route.
 */
export const dynamic = 'force-dynamic';

/**
 * The tab's title. Short and static: the root layout's `'%s · Lumen Supply'`
 * template supplies the rest, and there is nothing about this route that a
 * request could change about it.
 */
export const metadata: Metadata = { title: PAGE_TITLE };

/**
 * The inventory dashboard: the filter now in force, the figures it produced, the
 * page of stock lines behind them, and the lines that have fallen to their
 * reorder point.
 *
 * @param props The route's props; only the query string is read.
 * @returns The page's content, which the layout places inside the document's
 * single main region.
 */
export default async function InventoryDashboardPage({
  searchParams,
}: Props): Promise<ReactElement> {
  const resolved = await searchParams;

  /*
   * The query as the schema expects it: one string per parameter. A repeated
   * parameter is read as its first value, and one that carries nothing at all
   * is left out entirely so the field's own default takes over. Every key is
   * forwarded rather than a hand-written list of the ones this page knows
   * about - the schema owns that vocabulary and strips whatever it does not
   * recognise, so a dashboard URL that also carries a campaign parameter is
   * still a perfectly good request for these figures.
   */
  const supplied: Record<string, string> = {};

  for (const [key, value] of Object.entries(resolved)) {
    const first = Array.isArray(value) ? value[0] : value;

    if (first !== undefined) {
      supplied[key] = first;
    }
  }

  /*
   * A rejected query is answered with the dashboard's own defaults rather than
   * with an error: `safeParse` never throws, and {@link DEFAULT_QUERY} is what
   * an empty query parses to, which is exact because every value-bearing
   * parameter of this schema is defaulted. Nothing below mutates the query, so
   * the one parsed at module scope can be handed over as it is.
   */
  const parsed = inventorySummaryQuerySchema.safeParse(supplied);
  const query: InventorySummaryQueryInput = parsed.success ? parsed.data : DEFAULT_QUERY;

  return (
    <div className="ls-stack ls-stack-loose">
      <BreadcrumbTrail items={CRUMBS} />

      <div className="ls-page-head">
        <h1 className="ls-page-title">{PAGE_TITLE}</h1>
        <p className="ls-page-lede">{PAGE_LEDE}</p>
      </div>

      {/*
        One boundary for one read. The body is not awaited here, so the trail and
        the heading above reach the browser while the feed is still answering,
        and the placeholder reserves as many table rows as the page asked for so
        the swap does not move the page under a reader.
      */}
      <Suspense fallback={<DashboardPlaceholder rows={query.pageSize} />}>
        <DashboardData query={query} />
      </Suspense>
    </div>
  );
}
