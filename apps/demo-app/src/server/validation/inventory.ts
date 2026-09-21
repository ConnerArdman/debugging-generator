/**
 * Request validation for the inventory dashboard's feed — `GET /api/inventory/summary`.
 *
 * The dashboard is rendered on the server, so one request produces its whole surface: the KPI
 * figures, one page of stock lines, the stocking locations its filter row lists and the low-stock
 * list. Everything a caller may vary about that request is a query parameter, and this module is
 * the single place those parameters are turned into values the inventory service can trust. It
 * describes the request and nothing else — the response shapes live in `@/lib/types`.
 *
 * Four conventions shape the schema below, and they are the reason it is not simply a handful of
 * strings and numbers:
 *
 * 1. **Everything arrives as text.** A query string carries characters, never numbers, so each
 *    numeric parameter is coerced rather than declared numeric. A value that is not a whole number
 *    inside its range is rejected rather than quietly becoming `NaN` or a fraction of a page.
 * 2. **Every parameter is optional, and an omission is itself a value.** Parsing an empty object
 *    succeeds and answers the figures the dashboard opens on, which is what lets the page render
 *    from a bare URL. An absent parameter, an explicit `null` and a blank one are normalised to
 *    the same outcome — the default figure, or a filter that is not applied — so the filter row
 *    may submit an empty control to mean "no constraint", and a handler may read a parameter with
 *    `URLSearchParams.get()` (which answers `null` for a parameter that is not there) without
 *    either of them turning an ordinary dashboard visit into a failed request.
 * 3. **A filter that is not applied is `null`, not a missing key.** A parsed query therefore reads
 *    the same whether or not the caller constrained a filter, and no consumer has to distinguish
 *    "every location" from "nobody has decided yet".
 * 4. **A rejection is not this module's to report.** `parse` throws, the route handler hands the
 *    error to the single mapper in `@/server/errors`, and the response names the parameters that
 *    were rejected without echoing what was received. Nothing here builds a response, reads the
 *    environment, opens a connection or imports a service: the schema is an ordinary value, so the
 *    handler, the page and the filter row can all hold the same one.
 *
 * Unknown parameters are stripped rather than rejected, because a dashboard URL that also carries
 * a campaign or analytics parameter is still a perfectly good request for this feed. There is
 * deliberately no sort parameter: the table's columns are plain, and a parameter no surface offers
 * would be a promise this schema cannot keep.
 */

import { z } from 'zod';

import type { MovementType, StockState } from '@/lib/types';

/**
 * Normalises a parameter that says nothing onto `undefined`, so that the field's own default or
 * its "not applied" value takes over.
 *
 * Three inputs mean the same thing on this surface and are collapsed here rather than in six
 * places: a parameter the caller never sent (already `undefined`), one read with
 * `URLSearchParams.get()` and found absent (`null`), and one submitted empty by a control in the
 * dashboard's filter row (`''`, or the whitespace a copied-and-pasted URL can leave behind).
 * Everything else is passed through untouched for the field's own schema to judge, which is why
 * the signature is `unknown`: this step decides whether a value is worth judging, never what it
 * means.
 */
function unset(value: unknown): unknown {
  if (value === null) {
    return undefined;
  }

  if (typeof value === 'string' && value.trim().length === 0) {
    return undefined;
  }

  return value;
}

/**
 * The selling states a stock line can be reported in.
 *
 * The tuple is annotated with the imported union instead of declaring literals of its own, so the
 * vocabulary keeps one home: a state the storefront does not recognise fails to compile here
 * rather than becoming a filter value no stock line can ever match. All three members are listed,
 * so the filter can name any state the dashboard is able to badge.
 */
const states: readonly [StockState, ...StockState[]] = ['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK'];

/**
 * The reasons a stock change is recorded, mirroring the movement vocabulary the same way
 * {@link states} mirrors the selling states: annotated with the imported union, and listing every
 * member, so the filter can name any kind of change the ledger holds.
 */
const movements: readonly [MovementType, ...MovementType[]] = [
  'RECEIPT',
  'SHIPMENT',
  'ADJUSTMENT',
  'TRANSFER',
  'RESERVATION',
];

/**
 * The query the inventory dashboard's feed accepts.
 *
 * Parsing succeeds for a request that carries nothing, and the result is always complete: the
 * three figures hold their defaults and the three filters hold `null`.
 */
export const inventorySummaryQuerySchema = z.object({
  /**
   * Which stocking location to report on, named by its identifier — the `id` of one of the
   * `WarehouseSummary` entries the same response lists, which is what the filter row submits and
   * what the service resolves against. The short code a location is displayed under is wording for
   * a reader rather than a value this parameter accepts, so a parameter named for an identifier
   * matches on nothing else. Sixty-four characters is comfortably more than an identifier needs and
   * short enough that no caller can smuggle a document into a filter.
   *
   * `null` is what the dashboard opens on and means every location.
   */
  warehouseId: z.preprocess(unset, z.string().trim().min(1).max(64).nullable().default(null)),

  /**
   * How much headroom above a stock line's reorder point still counts as low, in units.
   *
   * A line is reported in the low-stock list once its available units reach its reorder point plus
   * this figure, so `0` reports only the lines already at or under their reorder point, and a
   * larger figure widens the list to the lines heading there. Each reported line carries its own
   * reorder point, so a reader always sees the figure that classified it.
   *
   * Ten units is the buying cushion the dashboard opens on: wide enough that the list names the
   * lines worth acting on today rather than only the ones already short.
   */
  threshold: z.preprocess(unset, z.coerce.number().int().min(0).max(10_000).default(10)),

  /**
   * Which page of stock lines to answer with, counted from `1` as `PagedList` numbers its pages.
   * A page number past the end of the listing is accepted here and answered as an empty page
   * rather than rejected, which is what keeps a bookmarked dashboard URL working after the stock
   * behind it has moved on; the ceiling only keeps the number a page number.
   */
  page: z.preprocess(unset, z.coerce.number().int().min(1).max(10_000).default(1)),

  /**
   * How many stock lines one page carries. Fifty fills the table on a dashboard-width screen, and
   * two hundred is the most a caller may ask for: the ceiling is deliberate, so that a page stays
   * a page and a hand-written URL cannot turn a paged listing into a full extract of the stock
   * records.
   */
  pageSize: z.preprocess(unset, z.coerce.number().int().min(1).max(200).default(50)),

  /**
   * Report only the stock lines in one selling state, named from {@link states}. `null` applies no
   * constraint and is what the dashboard opens on.
   */
  state: z.preprocess(unset, z.enum(states).nullable().default(null)),

  /**
   * Report only the recorded stock changes of one kind, named from {@link movements}. `null`
   * applies no constraint and is what the dashboard opens on.
   */
  movement: z.preprocess(unset, z.enum(movements).nullable().default(null)),
});

/**
 * A parsed inventory query: the shape the route handler hands to the inventory service.
 *
 * It is derived from the schema rather than declared beside it, so the two can never drift, and it
 * is the output shape — every figure present, every filter either a value or `null` — not the
 * loose collection of strings that came in off the URL.
 */
export type InventorySummaryQueryInput = z.infer<typeof inventorySummaryQuerySchema>;
