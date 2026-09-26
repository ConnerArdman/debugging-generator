/**
 * Lumen Supply - the inventory dashboard's stock table.
 *
 * One page of stock lines: a product, the location holding it, what that location has on hand, how
 * much of it is already promised, what is left to promise, and the selling state those figures add
 * up to. The seeded catalog carries roughly 2 400 of these lines over six stocking locations, so
 * the table is dense, tabular-numeral and - this is the load-bearing decision - *paged*. It renders
 * the `PagedList<InventoryLevelRow>` it is given and never more: no virtualization library (the
 * workspace pins its dependencies and declares none), no scroll-to-load, and nothing that grows
 * with the size of the listing rather than with the size of a page.
 *
 * A SERVER COMPONENT, AND EVERYTHING THAT FOLLOWS FROM IT
 * No `'use client'`, no hook, no event handler, no data access. Rows arrive as props from
 * `app/dashboard/page.tsx`, which is also where sorting and filtering live - the filter row is its
 * own component (`./WarehouseFilter`) submitting a GET form, and the validation schema behind the
 * dashboard's feed (`src/server/validation/inventory.ts`) deliberately exposes no sort parameter, so
 * the column headers here are plain and this file offers no sort affordance that would lead
 * nowhere. Paging is therefore expressed the way a server-rendered listing has to express it: as
 * links. Previous and Next are real `next/link` anchors carrying the feed's own `page` parameter,
 * which buys middle-click, Ctrl/Cmd-click, hover preview, "Copy link address" and a link announced
 * as a link - none of which a click handler could give back. Every other parameter the reader
 * arrived with is carried across untouched, so a location filter survives a page change without
 * this file knowing that the filter exists. Both links carry `scroll={false}`: this table is the
 * bottom of a very long page, and a page turn that scrolled the document back to the top would
 * leave the reader four viewports away from the pager they had just used.
 *
 * The one thing a server component cannot do here is measure itself, and the scrollport needs
 * measuring: it has to say when the table is wider than the space the page gave it, and it has to
 * answer Home and End with its own scroll rather than the document's. That box is therefore
 * `./Scroller`, a small client leaf this file wraps the table in. The rows still render on the
 * server and pass through it as `children`, so nothing about the table itself moves to the browser.
 *
 * WHAT IT READS, AND WHAT IT CANNOT KNOW
 * `InventoryLevelRow` names its product by identifier only. The optional `products` prop is how a
 * row acquires a name, a code, a price and a category to group under; a row whose product is
 * absent from it still renders, identified by the identifier it does carry, because a row a reader
 * cannot place is worse than a row with a plain name. That lookup is the one place
 * `noUncheckedIndexedAccess` bites hardest, and it is handled by narrowing every time rather than
 * by asserting once.
 *
 * The selling state is deliberately *not* one of the things a row borrows from its product. A row
 * carries the units available at its own location and the reorder point that location restocks it
 * at, and the `threshold` prop carries the headroom the listing was read under, so the badge is
 * derived from the line under the same rule the listing was filtered by. A product's own state is
 * summed across every location and allows for no headroom, so using it here would badge a row the
 * low-stock filter had just selected as "In stock".
 *
 * WHAT BELONGS TO SOMEONE ELSE
 *   - Surface: `ui/Card` owns background, border, radius, elevation and padding. This module's
 *     `.root` is geometry only and is handed to its `className`.
 *   - The scrollport: `./Scroller` owns the focusable, named region the table scrolls inside, its
 *     edge fades, its hint and its Home/End keys. This file hands it the caption to be named by,
 *     the sentence to show, and the radius that matches the card.
 *   - Status colour: `ui/Badge` paints the selling state, and always with the words
 *     `formatStockLabel` produces, so the state never rests on colour alone. The figures' own
 *     `data-figure` states - a muted zero, a negative quantity in the danger tone - are this
 *     file's, and both are still said in the text of the figure itself.
 *   - Money: `ui/Price` formats every `...Cents` figure. Nothing here divides by a hundred.
 *   - Category artwork: `ui/CategoryGlyph` holds the only copy of the "not every category has a
 *     drawing" rule and answers `null` when there is no asset, so no broken image can reach a
 *     grouping row.
 *   - Locale, currency, time zone and every number, date and label: `@/lib/format`, whose
 *     formatters are fully pinned. No `Intl` constructor and no clock is read here - the relative
 *     time in the caption is measured against the `referenceIso` the page supplies, so the server's
 *     markup and the browser's first render cannot disagree.
 *
 * THREE STATES, THREE EXPORTS
 * The loaded table handles its own empty case with `ui/BlankSlate`; loading and failure are
 * separate components, `InventoryLevelsTablePlaceholder` and `InventoryLevelsTableNotice`, so a
 * page can compose them with Suspense or an error boundary. The placeholder reuses this table's
 * shell, head cells and cell classes, which is what keeps the layout from jumping when the figures
 * land.
 */

import clsx from 'clsx';
import Link from 'next/link';
import { Fragment } from 'react';
import type { ComponentProps, ReactElement, ReactNode } from 'react';

import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { BlankSlate } from '@/components/ui/BlankSlate';
import { Card } from '@/components/ui/Card';
import { CategoryGlyph } from '@/components/ui/CategoryGlyph';
import { Price } from '@/components/ui/Price';
import { Skeleton } from '@/components/ui/Skeleton';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import {
  formatQuantityLabel,
  formatSkuLabel,
  formatSlugLabel,
  formatStockLabel,
  formatTimeAgoLabel,
} from '@/lib/format';
import type { InventoryLevelRow, PagedList, ProductSummary, StockState } from '@/lib/types';

import styles from './InventoryLevelsTable.module.css';
import { Scroller } from './Scroller';

/* ---------------------------------------------------------------------------
 * Constants
 *
 * All-caps by convention.
 * ------------------------------------------------------------------------- */

/** Printed where a figure or a name is not available, matching `@/lib/format`'s own placeholder. */
const MISSING_VALUE_LABEL = '—';

/**
 * The query parameter the dashboard's feed reads its page number from.
 *
 * Spelled out rather than imported: `src/server/validation/inventory.ts` parses it, but that module
 * belongs to the server layer and a component may not import from it. The literal is the contract.
 */
const PAGE_PARAMETER = 'page';

/** Where the pager's links point when the caller names no path of its own. */
const DEFAULT_BASE_PATH = '/dashboard';

/** How many placeholder rows the loading state reserves when the caller names no figure. */
const DEFAULT_PLACEHOLDER_ROWS = 8;

/**
 * The `<caption>` identifiers the two table shells are named by.
 *
 * A constant rather than a generated identifier, because a generated one would need `useId` and
 * this is a server component. One table of each kind appears on the dashboard, and the loaded table
 * and its placeholder are alternatives that never render together, so the two names below are
 * enough to keep every identifier on the page unique.
 */
const CAPTION_ID = 'inventory-levels-caption';
const PLACEHOLDER_CAPTION_ID = 'inventory-levels-placeholder-caption';

/**
 * What the scrollport says when the table is wider than the space the page gives it.
 *
 * Seven columns fit the measure a dashboard-width page offers, so this sentence is shown only
 * where they genuinely cannot - a phone, a split window, a reader at a large text size. `Scroller`
 * decides that by measuring, not by guessing at a breakpoint, and hides the line entirely when
 * there is nothing to scroll; it also names the keys, because the region takes focus and a reader
 * who cannot see the edge fade has no other way to learn that.
 */
const SCROLL_HINT =
  'This table is wider than the space available: scroll it sideways for the remaining columns, ' +
  'or give it focus and use the arrow, Home and End keys.';

/** Introduces the rows whose product the page's catalog listing does not name. */
const UNGROUPED_LABEL = 'Other products';

/**
 * Which of `ui/Badge`'s tones paints each selling state, read off the primitive rather than
 * restated, so a tone the stylesheet does not select cannot be named here.
 *
 * A `Record` over the finite union rather than a `switch` with a default: a fourth state becomes a
 * compile error here instead of a silently neutral chip, and indexing it with a `StockState` yields
 * a tone rather than `tone | undefined` under `noUncheckedIndexedAccess`.
 */
const STOCK_TONES: Record<StockState, NonNullable<ComponentProps<typeof Badge>['tone']>> = {
  IN_STOCK: 'success',
  LOW_STOCK: 'warning',
  OUT_OF_STOCK: 'danger',
};

/**
 * The seven columns, in order, with the ones that carry figures marked.
 *
 * Declared once because three places need exactly this list and must not drift: the head cells, the
 * `colSpan` of a grouping row, and the placeholder's cells. `numeric` selects the module's
 * `.numericCell` modifier - right-aligned, monospaced, tabular - which is what lets a reader scan a
 * column of quantities down the page instead of merely reading it across.
 */
const COLUMNS: readonly { readonly label: string; readonly numeric: boolean }[] = [
  { label: 'Product', numeric: false },
  { label: 'Location', numeric: false },
  { label: 'Unit price', numeric: true },
  { label: 'On hand', numeric: true },
  { label: 'Reserved', numeric: true },
  { label: 'Available', numeric: true },
  { label: 'Stock', numeric: false },
];

/* ---------------------------------------------------------------------------
 * Pure helpers
 * ------------------------------------------------------------------------- */

/** Returns `value` when it is a usable number, and `fallback` for `NaN` and the infinities. */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * The query parameters to carry across a page change: every parameter the reader arrived with,
 * minus the page number itself, which the pager rewrites.
 *
 * The shape accepted is the one a Next.js page already holds - a value is a string, a repeated
 * parameter is an array of strings, and an absent one is `undefined` - so the page passes its own
 * search parameters straight through instead of normalising them first. Blank values are dropped
 * rather than carried, because a filter row that submits an empty control means "no constraint" and
 * the feed's schema reads it that way too.
 */
function carriedParams(
  query: Readonly<Record<string, string | readonly string[] | undefined>> | undefined,
): URLSearchParams {
  const params = new URLSearchParams();

  if (query === undefined) {
    return params;
  }

  for (const [key, value] of Object.entries(query)) {
    if (key === PAGE_PARAMETER) {
      continue;
    }

    if (typeof value === 'string') {
      if (value.length > 0) {
        params.append(key, value);
      }

      continue;
    }

    if (value === undefined) {
      continue;
    }

    for (const entry of value) {
      if (entry.length > 0) {
        params.append(key, entry);
      }
    }
  }

  return params;
}

/**
 * The URL of one page of the listing: `basePath`, the carried parameters, and the page number.
 *
 * `carried` is copied rather than mutated, so one call cannot leave its page number behind in the
 * next one's link.
 */
function hrefForPage(basePath: string, carried: URLSearchParams, target: number): string {
  const params = new URLSearchParams(carried);
  params.set(PAGE_PARAMETER, String(target));

  return `${basePath}?${params.toString()}`;
}

/**
 * The selling state of one stock line, at this location and under the threshold in force.
 *
 * Every figure it reads belongs to the line: the units available at this location, and the reorder
 * point that location restocks it at. That is the same rule the listing is filtered by - nothing
 * available is out of stock, available units at or below the reorder point plus the reader's
 * headroom are low, anything above that is in stock - so a row the low-stock filter selected is
 * badged low. A product's own selling state cannot answer this question: it is summed across every
 * location and measured against no headroom, so it would badge a location that has fallen to its
 * point as in stock whenever the network as a whole has plenty.
 *
 * The two figures that arrive from a payload are folded through {@link finiteOr} for the same
 * reason the paging arithmetic is - they answer a query string a reader can type by hand - and a
 * negative reorder point or threshold narrows the low band to nothing rather than widening it.
 * `available` is expected to be finite; the caller prints a placeholder instead of a badge when it
 * is not.
 */
function stockStateFor(available: number, reorderPoint: number, threshold: number): StockState {
  if (available <= 0) {
    return 'OUT_OF_STOCK';
  }

  const point =
    Math.max(0, Math.trunc(finiteOr(reorderPoint, 0))) +
    Math.max(0, Math.trunc(finiteOr(threshold, 0)));

  return available <= point ? 'LOW_STOCK' : 'IN_STOCK';
}

/**
 * Which data state a quantity is in, spelled as the value `InventoryLevelsTable.module.css` reads
 * through its `data-figure` selectors - and `undefined` for an ordinary figure, so the common case
 * carries no attribute at all and the cell keeps the column's own ink.
 *
 * Zero is a state because it is a different statement from a quantity, and at the same ink it reads
 * as neither: a reader scanning the Reserved column cannot see which lines have nothing promised,
 * and an empty result set looks exactly like a healthy one. Below zero is a state because a
 * location that has promised more than it holds is a figure to act on today. Both are still said
 * in text - the digit and the minus sign - and the Stock column states the selling state in words,
 * so nothing here is carried by colour alone.
 *
 * A figure that is not a number returns `undefined` rather than a state of its own: the caller
 * prints `@/lib/format`'s placeholder for it, and a placeholder tinted as "zero" would assert a
 * quantity the row does not have.
 */
function figure(value: number): 'zero' | 'negative' | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }

  if (value === 0) {
    return 'zero';
  }

  return value < 0 ? 'negative' : undefined;
}

/**
 * The wording of a grouping row: the category's own name when the catalog gave one, the slug turned
 * into words when it did not, and a plain heading for the rows whose product is not named at all.
 */
function categoryLabelFor(category: string | null, categoryName: string | undefined): string {
  if (category === null) {
    return UNGROUPED_LABEL;
  }

  const named = categoryName === undefined ? '' : categoryName.trim();

  return named.length > 0 ? named : formatSlugLabel(category);
}

/* ---------------------------------------------------------------------------
 * The loaded table
 * ------------------------------------------------------------------------- */

/**
 * Props of {@link InventoryLevelsTable}.
 *
 * Local and deliberately not exported: the dashboard page types its own props and passes them
 * through.
 *
 * Every optional member spells `| undefined` out where its type does not already include it,
 * because this workspace compiles with `exactOptionalPropertyTypes`: under it a bare
 * `className?: string` rejects a present-but-undefined value, and every realistic caller has one -
 * a CSS Module lookup is `string | undefined`, and a page forwarding its own optional value hands
 * on the same union.
 */
interface Props {
  /**
   * One page of stock lines, exactly as the listing returned it. The wrapper is taken whole rather
   * than as loose rows plus numbers, so `page`, `pageSize` and `total` cannot drift apart from the
   * rows they describe - the pager reports the page the listing answered with, never one
   * re-derived from a URL.
   */
  levels: PagedList<InventoryLevelRow>;

  /**
   * Catalog entries naming the products behind those lines, matched by `id`. Optional, and a row
   * whose product is missing is rendered all the same: the name, code, unit price and category are
   * the only things it goes without. The selling state is not among them - a line carries the
   * figures that classify it, so every row is badged whether or not its product is named.
   */
  products?: readonly ProductSummary[] | undefined;

  /**
   * The headroom above a line's reorder point that still counts as low, in units, exactly as the
   * listing was read: `0` badges only the lines already at or under their point, and a larger
   * figure badges the lines heading there too.
   *
   * It is required, and it is the threshold *in force* rather than a default of this component's
   * own, because it is what makes the Stock column agree with the filter that produced the rows: a
   * page read under a threshold of ten and badged under a threshold of zero would show "In stock"
   * on every row a low-stock filter had just selected.
   */
  threshold: number;

  /**
   * The instant the page treats as "now", as an ISO-8601 UTC timestamp. Required, and required to
   * be a value rather than a clock read: the relative wording in the caption is measured against
   * it, so a stable reference is what keeps a server render and the browser's first render
   * identical.
   */
  referenceIso: string;

  /**
   * When the figures were computed, as an ISO-8601 UTC timestamp - the `generatedAt` of the
   * dashboard's payload. Named in the caption relative to `referenceIso` when given, so a reader
   * can tell how current the stock is.
   */
  generatedAt?: string | undefined;

  /**
   * Optional heading for the card head: the table's visible title. When it is given the caption
   * carries the same information for assistive technology only, because a title shown twice is a
   * title read out twice; when it is absent the caption is the visible title.
   */
  heading?: ReactNode;

  /** The path the pager's links point at. Defaults to the dashboard's own route. */
  basePath?: string | undefined;

  /**
   * The search parameters the reader arrived with, carried across every page change except for the
   * page number itself. A page passes its own `searchParams` straight through.
   */
  query?: Readonly<Record<string, string | readonly string[] | undefined>> | undefined;

  /** The placing page's own class, composed alongside `.root` for placement and sizing. */
  className?: string | undefined;
}

/**
 * Render one page of inventory levels as a table, with its pager.
 *
 * @example
 * ```tsx
 * <InventoryLevelsTable
 *   levels={levels}
 *   products={catalog.items}
 *   threshold={query.threshold}
 *   generatedAt={summary.generatedAt}
 *   referenceIso={renderedAt}
 *   query={search}
 *   heading={<h2>Inventory levels</h2>}
 * />
 * ```
 */
export function InventoryLevelsTable({
  levels,
  products,
  threshold,
  referenceIso,
  generatedAt,
  heading,
  basePath = DEFAULT_BASE_PATH,
  query,
  className,
}: Props): ReactElement {
  /*
   * Defensive arithmetic, for the same reason the catalog's pager does it: these figures come from a
   * listing that answered a query string a reader can type by hand, so a zero page size, a negative
   * total, a fractional page and a non-finite value are each folded into the nearest sensible whole
   * number here rather than propagated into a division, a link out of range or a `NaN` on the page.
   *
   * The page number is not clamped to the end of the listing, because the page the reader asked for
   * is what the empty state below has to name: the feed answers a page past the end with no rows
   * rather than an error, and "none of them are on page 9" is the sentence that explains that.
   */
  const rows = levels.items;
  const pageSize = Math.max(1, Math.trunc(finiteOr(levels.pageSize, 1)));
  const total = Math.max(0, Math.trunc(finiteOr(levels.total, 0)));
  const page = Math.max(1, Math.trunc(finiteOr(levels.page, 1)));

  const carried = carriedParams(query);

  if (rows.length === 0) {
    /*
     * Nothing to table. Two situations reach here and they need different words: a filter that
     * matched nothing, and a page number past the end of a listing that does hold lines - which is
     * what a bookmarked dashboard URL turns into once the stock behind it has moved on. The second
     * gets a way back, as a link rather than a control, since this is a server component.
     */
    const past = total > 0;

    return (
      <Card className={clsx(styles.root, className)} head={heading}>
        <BlankSlate
          art="no-results"
          alt=""
          tone="neutral"
          heading="No stock lines to show"
          action={
            past ? (
              <Link className={styles.pagerLink} href={hrefForPage(basePath, carried, 1)}>
                First page
              </Link>
            ) : undefined
          }
        >
          {past
            ? `The listing holds ${formatQuantityLabel(total)} stock lines, but none of them are on page ${formatQuantityLabel(page)}.`
            : 'No stock lines matched the filters above. Choose another stocking location, or clear the stock-state filter, to see stock again.'}
        </BlankSlate>
      </Card>
    );
  }

  /*
   * The position of this page within the listing, and how far the listing goes. The last line is
   * counted from the rows actually in hand rather than from `page * pageSize`, and the total is
   * widened to at least that line, so the "showing" wording can neither claim rows the page does not
   * hold nor name a range past its own total - a short last page and a listing whose total lags
   * behind its rows both read correctly. The last page then follows from that widened count, which
   * is never below the first line of this page, so the page a reader is on is always within it.
   */
  const firstStockLine = (page - 1) * pageSize + 1;
  const lastStockLine = firstStockLine + rows.length - 1;
  const counted = Math.max(total, lastStockLine);
  const lastPage = Math.ceil(counted / pageSize);

  /*
   * Each row paired with the catalog entry that names it, resolved once through a map rather than by
   * searching the listing per row, and with the category it is grouped under: the slug when the
   * product is named and carries one, and `null` when it is not. Grouping rows are rendered only
   * when at least one line on the page resolves a category, so a page given no catalog entries
   * reads as a plain table instead of one long "Other products" group.
   */
  const named = new Map<string, ProductSummary>();

  for (const product of products ?? []) {
    named.set(product.id, product);
  }

  const lines = rows.map((row) => {
    const product = named.get(row.productId);
    const category =
      product !== undefined && product.categorySlug.length > 0 ? product.categorySlug : null;

    return { row, product, category };
  });

  const grouped = lines.some((line) => line.category !== null);

  /*
   * The caption is the table's name, and it is the whole name: when the card head shows the title,
   * this is the only place a screen reader hears how many lines there are, which page this is and
   * how current the figures are. It is always a real `<caption>` element, so the table is never
   * unnamed, and `data-hidden` drops the spacing the invisible line would otherwise reserve.
   */
  const caption = [
    `Inventory levels: ${formatQuantityLabel(counted)} stock lines by product and stocking location`,
    `page ${formatQuantityLabel(page)} of ${formatQuantityLabel(lastPage)}`,
  ];

  if (generatedAt !== undefined) {
    caption.push(`figures updated ${formatTimeAgoLabel(generatedAt, referenceIso)}`);
  }

  const captionSentence = `${caption.join(', ')}.`;

  const status = (
    <p className={styles.pagerStatus}>
      {`Showing ${formatQuantityLabel(firstStockLine)}–${formatQuantityLabel(lastStockLine)} of ${formatQuantityLabel(counted)} stock lines`}
    </p>
  );

  return (
    <Card className={clsx(styles.root, className)} head={heading}>
      {/*
        The scrollport, and the whole responsive answer for seven columns: a viewport too narrow for
        them scrolls the table inside this box rather than widening the page. `Scroller` is what
        makes that honest - it is focusable and named, because a scrollable region a keyboard cannot
        reach is an accessibility defect; it fades the edge the content continues past and shows the
        sentence above, because an overlay scrollbar is no indication at rest; and it answers Home
        and End with the region's own scroll instead of letting the document jump. The caption it
        points at is the name a reader of the surrounding page already has.
      */}
      <Scroller labelledBy={CAPTION_ID} hint={SCROLL_HINT} className={styles.scroller}>
        <table className={styles.table}>
          <caption
            className={styles.caption}
            id={CAPTION_ID}
            data-hidden={heading === undefined ? undefined : 'true'}
          >
            {heading === undefined ? (
              captionSentence
            ) : (
              <VisuallyHidden>{captionSentence}</VisuallyHidden>
            )}
          </caption>

          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <th
                  key={column.label}
                  scope="col"
                  className={clsx(styles.headCell, column.numeric && styles.numericCell)}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {lines.map((line, index) => {
              /*
               * A grouping row opens wherever the category changes from the line before it - and at
               * the top of the table, where there is no line before it. The previous entry is typed
               * `... | undefined` under `noUncheckedIndexedAccess`, which is exactly the check this
               * needs, so it is narrowed rather than asserted.
               */
              const previous = lines[index - 1];
              const opensCategory =
                grouped && (previous === undefined || previous.category !== line.category);
              const available = line.row.available;
              /*
               * `null` is "this line's availability is not a number", which is the one case that
               * gets no badge: `formatQuantityLabel` already prints a placeholder for the figure,
               * and a chip would have to assert a selling state the row cannot support. Everything
               * else is decided by the line itself - its available units against its own reorder
               * point, widened by the threshold the listing was read under - so the badge says
               * what the filter above it means.
               */
              const state = Number.isFinite(available)
                ? stockStateFor(available, line.row.reorderPoint, threshold)
                : null;

              return (
                <Fragment key={`${line.row.productId}:${line.row.warehouseId}`}>
                  {opensCategory ? (
                    <tr className={styles.groupRow}>
                      <th colSpan={COLUMNS.length} scope="colgroup">
                        <span className={styles.groupLabel}>
                          {line.category === null ? null : (
                            <CategoryGlyph slug={line.category} size="sm" />
                          )}
                          {categoryLabelFor(line.category, line.product?.categoryName)}
                        </span>
                      </th>
                    </tr>
                  ) : null}

                  <tr>
                    <th scope="row" className={styles.rowHeadCell}>
                      {line.product === undefined ? 'Unlisted product' : line.product.name}
                      <span className={styles.sku}>
                        {line.product === undefined
                          ? line.row.productId
                          : formatSkuLabel(line.product.sku)}
                      </span>
                    </th>

                    <td className={styles.cell}>{line.row.warehouseName}</td>

                    <td className={clsx(styles.cell, styles.numericCell)}>
                      {line.product === undefined ? (
                        MISSING_VALUE_LABEL
                      ) : (
                        <Price cents={line.product.priceCents} size="sm" />
                      )}
                    </td>

                    {/*
                      The three quantity columns carry their data state as `data-figure`, so a
                      line with nothing on the shelf, nothing promised or nothing left to promise
                      is visibly not a line holding three thousand units. The money column beside
                      them does not: a unit price is a property of the product rather than a
                      position to act on, and `ui/Price` owns how it is printed.
                    */}
                    <td
                      className={clsx(styles.cell, styles.numericCell)}
                      data-figure={figure(line.row.onHand)}
                    >
                      {formatQuantityLabel(line.row.onHand)}
                    </td>

                    <td
                      className={clsx(styles.cell, styles.numericCell)}
                      data-figure={figure(line.row.reserved)}
                    >
                      {formatQuantityLabel(line.row.reserved)}
                    </td>

                    <td
                      className={clsx(styles.cell, styles.numericCell)}
                      data-figure={figure(available)}
                    >
                      {formatQuantityLabel(available)}
                    </td>

                    {/*
                      The state always carries its own words, through `formatStockLabel`, so nothing
                      here is said in colour alone.
                    */}
                    <td className={styles.cell}>
                      {state === null ? (
                        MISSING_VALUE_LABEL
                      ) : (
                        <Badge tone={STOCK_TONES[state]} size="sm" dot>
                          {formatStockLabel(state, available)}
                        </Badge>
                      )}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </Scroller>

      {/*
        The pager. It is a `<nav>` only when there is somewhere to go: a one-page listing still says
        where the reader is, but a landmark holding nothing to navigate is noise. The controls are
        direct children of the row, which is how the stylesheet groups them, and the two directions
        the current page leaves nowhere to go are inert `<span>`s - rendered rather than omitted, so
        the row keeps its shape as the reader moves through the pages.

        Both links carry `scroll={false}`, which keeps the document's scroll position across the
        navigation. A page change swaps the rows of a table far down a long page, and Next.js's
        default would scroll the document to the top, away from the control the reader just used.
        With the position kept, the reader stays by the paged table and can turn page after page in
        place - the same as the filter row above, whose own navigations keep the position too.
      */}
      {lastPage > 1 ? (
        <nav className={styles.pager} aria-label="Inventory levels pages">
          {status}

          {page > 1 ? (
            <Link
              className={styles.pagerLink}
              href={hrefForPage(basePath, carried, page - 1)}
              rel="prev"
              scroll={false}
            >
              Previous
              <VisuallyHidden>{' page'}</VisuallyHidden>
            </Link>
          ) : (
            <span className={styles.pagerLink} aria-disabled="true">
              Previous
              <VisuallyHidden>{' page'}</VisuallyHidden>
            </span>
          )}

          <span className={styles.pagerLink} aria-current="page">
            {`Page ${formatQuantityLabel(page)} of ${formatQuantityLabel(lastPage)}`}
          </span>

          {page < lastPage ? (
            <Link
              className={styles.pagerLink}
              href={hrefForPage(basePath, carried, page + 1)}
              rel="next"
              scroll={false}
            >
              Next
              <VisuallyHidden>{' page'}</VisuallyHidden>
            </Link>
          ) : (
            <span className={styles.pagerLink} aria-disabled="true">
              Next
              <VisuallyHidden>{' page'}</VisuallyHidden>
            </span>
          )}
        </nav>
      ) : (
        <div className={styles.pager}>{status}</div>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------------------
 * The loading state
 * ------------------------------------------------------------------------- */

/**
 * Props of {@link InventoryLevelsTablePlaceholder}. Local, and optional throughout: a placeholder
 * that needed configuring to hold a space would be a placeholder rendered too late.
 */
interface InventoryPlaceholderProps {
  /** The same heading the loaded table is given, so the card head does not appear with the data. */
  heading?: ReactNode;

  /**
   * How many rows to reserve - the page size the listing is being asked for, where the caller knows
   * it. Anything below one row is raised to one: a placeholder reserving no space would let the
   * layout jump when the figures land, which is the whole point of having one.
   */
  rows?: number | undefined;

  /** The placing page's own class, composed alongside `.root`. */
  className?: string | undefined;
}

/**
 * Reserve the table's space while the figures are being fetched.
 *
 * It is the loaded table's shell - the same card, scrollport, head cells and cell classes - with
 * grey bars where the values go, which is what keeps the two renders the same height. `ui/Skeleton`
 * is `aria-hidden`, so the announcement is made once, in the caption, rather than as four dozen
 * empty boxes.
 *
 * @example
 * ```tsx
 * <Suspense fallback={<InventoryLevelsTablePlaceholder rows={query.pageSize} />}>
 *   <InventoryLevels {...query} />
 * </Suspense>
 * ```
 */
export function InventoryLevelsTablePlaceholder({
  heading,
  rows = DEFAULT_PLACEHOLDER_ROWS,
  className,
}: InventoryPlaceholderProps): ReactElement {
  const count = Math.max(1, Math.trunc(finiteOr(rows, DEFAULT_PLACEHOLDER_ROWS)));
  const captionSentence = 'Inventory levels are loading.';

  return (
    <Card className={clsx(styles.root, className)} head={heading}>
      <Scroller labelledBy={PLACEHOLDER_CAPTION_ID} hint={SCROLL_HINT} className={styles.scroller}>
        <table className={styles.table}>
          <caption
            className={styles.caption}
            id={PLACEHOLDER_CAPTION_ID}
            data-hidden={heading === undefined ? undefined : 'true'}
          >
            {heading === undefined ? (
              captionSentence
            ) : (
              <VisuallyHidden>{captionSentence}</VisuallyHidden>
            )}
          </caption>

          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <th
                  key={column.label}
                  scope="col"
                  className={clsx(styles.headCell, column.numeric && styles.numericCell)}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {/*
              Keyed by index, which is correct in precisely this case: the rows are empty,
              interchangeable placeholders in a list whose only change is its length, so an index
              key can never move state or DOM to the wrong row - there is neither to move.
            */}
            {Array.from({ length: count }, (_, index) => (
              <tr key={index} className={styles.skeletonRow}>
                {COLUMNS.map((column, position) =>
                  position === 0 ? (
                    <th key={column.label} scope="row" className={styles.rowHeadCell}>
                      <Skeleton shape="block" className={styles.skeletonCell} />
                    </th>
                  ) : (
                    <td
                      key={column.label}
                      className={clsx(styles.cell, column.numeric && styles.numericCell)}
                    >
                      <Skeleton shape="block" className={styles.skeletonCell} />
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Scroller>
    </Card>
  );
}

/* ---------------------------------------------------------------------------
 * The failure state
 * ------------------------------------------------------------------------- */

/**
 * Props of {@link InventoryLevelsTableNotice}. Local, and the wording is not among them: the notice
 * says one thing, and a caller that passes its own sentence would be free to describe a failure as
 * something else.
 */
interface InventoryNoticeProps {
  /** The same heading the loaded table is given, so the card keeps its place on the dashboard. */
  heading?: ReactNode;

  /**
   * Optional control beside the message - the page's own retry link or button. Rendered as given;
   * the control's own module owns its size, colour and focus ring, and this notice adds no handler
   * of its own because it is a server component.
   */
  action?: ReactNode;

  /** The placing page's own class, composed alongside `.root`. */
  className?: string | undefined;
}

/**
 * Say that the stock figures could not be read, in place of the table.
 *
 * The `danger` tone of `ui/Alert` is announced assertively, which is right here: a dashboard that
 * silently showed an empty table would be read as "no stock", and that is a different and much
 * worse statement than "the figures are missing".
 *
 * @example
 * ```tsx
 * <InventoryLevelsTableNotice action={<Link href="/dashboard">Try again</Link>} />
 * ```
 */
export function InventoryLevelsTableNotice({
  heading,
  action,
  className,
}: InventoryNoticeProps): ReactElement {
  return (
    <Card className={clsx(styles.root, className)} head={heading}>
      <Alert tone="danger" title="Stock levels are unavailable" actions={action}>
        The inventory figures could not be read just now. Nothing has changed in the warehouse
        records, and the rest of the dashboard is unaffected.
      </Alert>
    </Card>
  );
}
