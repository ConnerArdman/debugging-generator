/**
 * Lumen Supply - the inventory dashboard's loading UI (`/dashboard`).
 *
 * Next.js renders this file as the Suspense fallback around `app/dashboard/page.tsx` while that
 * page is on its way - a client-side navigation shows it the moment the link is followed - and,
 * being the nearest `loading.tsx`, it replaces the root one, which cannot see this page and
 * reserves no more than the heading block every page opens with.
 *
 * The reservation follows the dashboard's own composition, top to bottom:
 *
 *   - the breadcrumb trail's line, held to the reading measure;
 *   - the heading block - the page's `<h1>` and the sentence under it - as a bar and two lines;
 *   - the filter form - one label bar over a control-height box per filter - and the line under
 *     it that says what the figures cover;
 *   - the row of headline figures, one small card per figure, each a label bar over a
 *     figure-height box;
 *   - the `.ls-split` the page lays its two data regions out in: the stock table in the main
 *     column, a card with a head and one row box per line of the page size an address with no
 *     query asks for, and the low-stock list in the side column, a section title over its rows.
 *
 * Once this file has done its work the page's own streamed shell takes over, and that shell keeps
 * a placeholder of its own in each data region while the inventory feed is read. This file is the
 * wait before that: the few moments in which the dashboard's code and styles are still arriving.
 *
 * ONLY STYLESHEETS THE ROOT SHELL HAS ALREADY LOADED
 * That is also why it does not render the dashboard components' own placeholders. A loading file
 * can only paint once every stylesheet it draws with is in the document: React holds back a
 * boundary whose stylesheet is still downloading and shows the nearest boundary above it instead -
 * here the root `app/loading.tsx`, which knows nothing of the dashboard. A reader arriving from
 * another page has not loaded the dashboard's styles yet, so a class from the dashboard components
 * would keep this file off the screen for exactly as long as it is needed. It therefore draws only
 * with what every page of the storefront has already loaded: the `.ls-*` utilities of
 * `app/globals.css`, the `ui` primitives the root layout renders, and the stylesheet of
 * `SiteFooter`, which the root layout renders on every route. The footer's `.columns` is the one
 * fluid row of equal columns in that set - `auto-fit` over a 200px floor, with no breakpoint of
 * its own - so it lays the five figure cards in one row at desktop width and reflows them as the
 * measure narrows, as the loaded figure row does over its own slightly smaller floor (the two can
 * differ by a card just above a reflow point, never by more); the filters take the same row. It
 * adds no CSS Module of its own.
 *
 * Exactly one status region exists in this subtree, carrying the one busy message; every
 * `Skeleton` is `aria-hidden` by construction, so the wait is announced once. There is no main
 * landmark - `app/layout.tsx` owns it - and no data access, clock or random read: the fallback
 * renders at once and identically on server and client, and parsing an empty query is a pure
 * computation over a schema value on the server.
 */

import type { ReactElement } from 'react';

import footerStyles from '@/components/layout/SiteFooter.module.css';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import { inventorySummaryQuerySchema } from '@/server/validation/inventory';

/**
 * What the wait is announced as: a fragment about the content arriving, in the reader's terms, and
 * nothing about how long it is taking. It names the whole page because the whole page is what is
 * on its way.
 */
const BUSY_MESSAGE = 'Loading the inventory dashboard';

/** Fields in the filter form: location, low-stock headroom, stock state and movement kind. */
const FILTER_FIELDS = 4;

/** Cards in the headline row: one per figure the dashboard reports. */
const FIGURE_TILES = 5;

/**
 * How many table rows to reserve: the page size of the dashboard's opening state - the address
 * every link to the dashboard carries. Every value-bearing parameter of the schema is defaulted,
 * so parsing an empty query yields that state exactly, the same way `app/dashboard/page.tsx`
 * derives its own defaults, and the two cannot drift. The schema is read on the server only: this
 * file is a Server Component, so it adds nothing to what the browser downloads.
 */
const RESERVED_ROWS = inventorySummaryQuerySchema.parse({}).pageSize;

/** Bars in the low-stock placeholder: the rows that list reserves while it loads. */
const LOW_STOCK_BARS = 5;

/**
 * Index lists for the repeated placeholders. An index is the key in exactly this case: the boxes
 * are empty and interchangeable, in lists whose only variable is their length, so an index key
 * cannot move state or DOM to the wrong item - there is neither to move.
 */
const FIELDS = Array.from({ length: FILTER_FIELDS }, (_unused, index) => index);
const TILES = Array.from({ length: FIGURE_TILES }, (_unused, index) => index);
const ROWS = Array.from({ length: RESERVED_ROWS }, (_unused, index) => index);

/**
 * Render the inventory dashboard's loading state.
 *
 * Next.js passes no props to a `loading` file, so this takes none; it is a plain synchronous
 * function component whose output depends on nothing outside this module.
 *
 * The status region wraps the filters, the figures and both columns rather than sitting beside
 * them, so the region that announces the wait is the region that is waiting, and `aria-busy` is
 * cleared for all of it at once when the page replaces this subtree.
 */
export default function DashboardLoading(): ReactElement {
  return (
    <div className="ls-stack ls-stack-loose">
      <div className="ls-page-lede">
        <Skeleton shape="text" />
      </div>

      <div className="ls-page-head">
        <Skeleton shape="text" />

        <div className="ls-page-lede">
          <Skeleton shape="text" lines={2} />
        </div>
      </div>

      <div role="status" aria-busy="true" className="ls-stack ls-stack-loose">
        <VisuallyHidden>{BUSY_MESSAGE}</VisuallyHidden>

        <div className="ls-stack">
          <div className={footerStyles.columns}>
            {FIELDS.map((field) => (
              <div key={field} className="ls-stack ls-stack-tight">
                <Skeleton shape="text" />
                <Skeleton shape="block" />
              </div>
            ))}
          </div>

          <div className="ls-page-lede">
            <Skeleton shape="text" />
          </div>
        </div>

        <div className={footerStyles.columns}>
          {TILES.map((tile) => (
            <Card key={tile} pad="sm">
              <div className="ls-stack ls-stack-tight">
                <Skeleton shape="text" />
                <Skeleton shape="block" />
              </div>
            </Card>
          ))}
        </div>

        <div className="ls-split">
          <div className="ls-split-main">
            <Card pad="md" head={<Skeleton shape="text" />}>
              <div className="ls-stack ls-stack-tight">
                {ROWS.map((row) => (
                  <Skeleton key={row} shape="block" />
                ))}
              </div>
            </Card>
          </div>

          <div className="ls-split-side ls-section">
            <Skeleton shape="text" />
            <Skeleton shape="text" lines={LOW_STOCK_BARS} />
          </div>
        </div>
      </div>
    </div>
  );
}
