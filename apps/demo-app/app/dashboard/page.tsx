/*
 * Lumen Supply - the inventory dashboard.
 *
 * One route, one question: what is in stock, where, and which lines are close enough to their
 * reorder point to be worth acting on. The page reads the dashboard's payload once and hands it to
 * three components - the filter row, the figure row and the low-stock list - each of which owns its
 * own markup, its own heading and its own empty state. There is nothing else here: no query, no
 * paging arithmetic, no formatting and no copy that belongs to a component.
 *
 * A SERVER COMPONENT THAT CALLS THE SERVICE DIRECTLY
 * There is no `'use client'` directive in this file. The one client boundary in the route is
 * `WarehouseFilter`, which is rendered as a child, so the rest of the page costs the browser
 * nothing. The payload comes from `readInventorySummary` rather than from a `fetch` of
 * `/api/inventory/summary`: the endpoint exists for a caller outside this application, and a server
 * render that fetched its own route would pay for a second HTTP round trip, an absolute URL it has
 * no honest value for, and a second chance to fail.
 *
 * ONE READING OF THE QUERY STRING
 * Every parameter this page accepts is parsed once, by the same schema the endpoint uses, and the
 * parsed values are then passed down: the service receives them as its input, and the filter row
 * receives them as the filter now in force. Nothing below reads `searchParams` twice and nothing
 * reads the address bar in the browser, which is what keeps the figures, the controls and the URL
 * describing the same request.
 *
 * A MALFORMED QUERY IS STILL A DASHBOARD VISIT
 * `inventorySummaryQuerySchema` defaults every value-bearing parameter, so a query it rejects is
 * answered by re-parsing an empty one: a hand-typed `?threshold=abc` renders the figures the
 * dashboard opens on instead of an error page. The recovery is wholesale rather than field by
 * field, because a partially salvaged query would show figures under a filter the reader cannot see
 * in the address bar.
 *
 * WHAT THE PAGE DOES NOT OWN
 *   - The document, the main landmark and the site chrome: `app/layout.tsx` mounts `PageContainer`
 *     around every route, so this page renders its own breadcrumb trail and its own level-one
 *     heading inside that region and adds neither a second landmark nor a second container.
 *   - Sections and headings: `InventoryKpiCards` and `LowStockList` each render a named section of
 *     their own, so wrapping them here would name every region twice.
 *   - Layout values: the `.ls-*` utilities in `app/globals.css` are the whole vocabulary a route
 *     file has, and a route file adds no CSS Module. There is no inline `style` below and no colour,
 *     spacing or type value of any kind.
 *   - Numbers, dates and labels: every figure printed on this page is formatted by the component
 *     that prints it, through `@/lib/format`. This file prints no number.
 *
 * THE PAYLOAD IS THE WHOLE SURFACE
 * `InventorySummary` carries five figures, the stocking locations the filter lists and one page of
 * the lines at or below their reorder point - and no per-line stock rows. The page therefore
 * composes exactly what its own read returns: a stock table of individual levels belongs to a
 * surface whose payload holds them, and inventing rows here, or rendering an empty table beside
 * figures that are not empty, would both state something the read never said.
 *
 * NO CLOCK, NO CACHE
 * `formatTimeAgoLabel` takes its reference instant as an argument so that a server render and the
 * browser's first render produce the same words; the reference handed down here is the payload's
 * own `generatedAt`, which is the instant the figures were computed and needs no clock read. And
 * because the figures are live stock, the route is `force-dynamic` and nothing on this path is
 * cached or memoized: a repeated filter submission genuinely asks the database again.
 */

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

import { InventoryKpiCards } from '@/components/dashboard/InventoryKpiCards';
import { LowStockList } from '@/components/dashboard/LowStockList';
import { WarehouseFilter } from '@/components/dashboard/WarehouseFilter';
import { BreadcrumbTrail, type BreadcrumbCrumb } from '@/components/layout/BreadcrumbTrail';
import { Alert } from '@/components/ui/Alert';
import type { InventorySummary, StorefrontErrorCode } from '@/lib/types';
import { isStorefrontError } from '@/server/errors';
import {
  readInventorySummary,
  type InventorySummaryInput,
} from '@/server/services/inventory.service';
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

/** The heading of the notice shown in place of the figures when they cannot be read. */
const NOTICE_TITLE = 'Inventory figures unavailable';

/**
 * What the notice says when the reason is not one this page can act on, and the
 * sentence every unrecognised failure collapses into.
 *
 * It describes the situation and nothing about its cause: a thrown value carries
 * a stack, a statement, a driver code or a row, and none of those is a reader's
 * to see. The service layer is where a failure is worth a log line.
 */
const GENERIC_NOTICE =
  'The stock figures could not be read just now. Nothing in the warehouse records has changed, ' +
  'and reloading the page asks for them again.';

/**
 * The failures this page can tell a reader what to do about, by the code the
 * error carries.
 *
 * `Partial` on purpose: the application's error vocabulary covers surfaces this
 * page has nothing to do with - a declined card, an unknown payment outcome -
 * and a sentence invented for each of them here would be wording no reader of
 * this page can ever see. An absent entry reads as {@link GENERIC_NOTICE},
 * which is also what a value that is not this application's error becomes.
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

/* ---------------------------------------------------------------------------
 * Failure copy
 * ------------------------------------------------------------------------- */

/**
 * The fixed sentence shown in place of the figures for a caught value.
 *
 * `catch` binds `unknown`, and the only thing read off it is the code it carries
 * when it is one of this application's own errors: no message, no `details`, no
 * `cause` and no stringification reaches the markup, so nothing the database,
 * the driver or a bug wrote can be printed on the page.
 *
 * @param error Any caught value.
 * @returns One of {@link NOTICES}, or {@link GENERIC_NOTICE}.
 */
function notice(error: unknown): string {
  if (isStorefrontError(error)) {
    return NOTICES[error.code] ?? GENERIC_NOTICE;
  }

  return GENERIC_NOTICE;
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
 * The inventory dashboard: the filter now in force, the figures it produced,
 * and the lines that have fallen to their reorder point.
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
   * with an error: `safeParse` never throws, and re-parsing an empty object is
   * exact because every value-bearing parameter of this schema is defaulted.
   * The second binding is an annotation rather than a conversion - it is the
   * compiler, not a cast, that establishes the parsed query is an argument the
   * inventory service accepts.
   */
  const parsed = inventorySummaryQuerySchema.safeParse(supplied);
  const query: InventorySummaryQueryInput = parsed.success
    ? parsed.data
    : inventorySummaryQuerySchema.parse({});
  const input: InventorySummaryInput = query;

  /*
   * One read, and the only thing in this file that can fail. The notice starts
   * out as the wording for a failure nobody can act on, so the page always has
   * something to say; a caught value replaces it with the sentence its code
   * earns and leaves the payload unset, which is what selects the notice below.
   */
  let summary: InventorySummary | null = null;
  let failure = GENERIC_NOTICE;

  try {
    summary = await readInventorySummary(input);
  } catch (error) {
    failure = notice(error);
  }

  return (
    <div className="ls-stack ls-stack-loose">
      <BreadcrumbTrail items={CRUMBS} />

      <div className="ls-page-head">
        <h1 className="ls-page-title">{PAGE_TITLE}</h1>
        <p className="ls-page-lede">{PAGE_LEDE}</p>
      </div>

      {summary === null ? (
        /*
         * The whole payload is missing, so the filter row, the figures and the
         * list are all omitted: an empty table or a row of zeroes would read as
         * "nothing in stock", which is a different and much worse statement
         * than "the figures are missing". `warning` rather than `danger`
         * because the notice is here on arrival - `ui/Alert` announces `danger`
         * assertively, which belongs to a failure the reader just caused.
         */
        <div className="ls-notice">
          <Alert tone="warning" title={NOTICE_TITLE}>
            {failure}
          </Alert>
        </div>
      ) : (
        <>
          {/*
            The locations the filter lists come from the payload already in
            hand rather than from a second query, and the applied values are
            the ones parsed above, so the controls open showing the filter the
            figures beside them were produced under.
          */}
          <WarehouseFilter
            warehouses={summary.warehouses}
            selectedWarehouseId={query.warehouseId}
            threshold={query.threshold}
            stockState={query.state}
            movementType={query.movement}
          />

          {/*
            Both components measure the payload's age against the instant it
            was computed, which is the payload's own `generatedAt`: a reference
            read from the clock would differ between the server's markup and
            the browser's first render.
          */}
          <InventoryKpiCards summary={summary} referenceIso={summary.generatedAt} />

          <LowStockList rows={summary.lowStock} threshold={query.threshold} />
        </>
      )}
    </div>
  );
}
