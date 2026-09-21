/**
 * Stock availability, and the figures behind the inventory dashboard.
 *
 * Two operations live here, and they are the two questions the warehouse side of
 * Lumen Supply is asked. `reserveStock` decides whether a cart can be promised
 * and which distribution center each of its lines ships from; it runs while an
 * order is being placed. `readInventorySummary` answers the inventory
 * dashboard: the figures on its cards, the stocking locations its filter row
 * lists, and the lines that have fallen to their reorder point.
 *
 * Both read the same two tables, and the difference between them is the whole
 * reason a reservation is not a single lookup. `inventory_levels` holds one row
 * per product per location carrying the units on the shelf, the units already
 * promised to somebody else and the point at which the line is reordered - what
 * a location currently believes it has. `inventory_movements` is the ledger:
 * one signed row for every recorded change, whether goods received, goods
 * shipped, stock transferred between locations, a correction after a count, or a
 * hold raised against an order. It is how the location came to believe it, and
 * it is where the holds that have not yet reached the level row are recorded.
 * A reservation reconciles the two before it promises anything.
 *
 * Statements against the ledger are written as SQL and run on the shared pool,
 * because they aggregate a signed column into several figures per location, and
 * because the low-stock rule compares one column against another - neither of
 * which the ORM's filter and aggregate vocabulary can express. Everything the
 * ORM can express goes through it. Both handles reach the database through the
 * single pool of `@/server/db/pool`, so a statement written either way runs on
 * the same connections, under the same limits.
 *
 * The conventions of `@/lib/types` hold at this boundary: quantities are plain
 * integers, instants are ISO-8601 UTC strings, and neither a `Date` nor a raw
 * driver row ever leaves this module.
 */

import type {
  CartLine,
  InventorySummary,
  LowStockRow,
  MovementType,
  StockState,
  WarehouseSummary,
} from '@/lib/types';
import { pool } from '@/server/db/pool';
import { prisma } from '@/server/db/prisma';
import { StorefrontError, StorefrontNotFoundError } from '@/server/errors';

/* ---------------------------------------------------------------------------
 * Figures the two operations are tuned by
 * ------------------------------------------------------------------------- */

/**
 * How far back a reservation reconciles a line's ledger, in days.
 *
 * Eighteen months is the seasonal cycle a supply business plans against, so the
 * movement a reservation reports is the line's whole trading history at that
 * location rather than a recent slice of it that a quiet month would distort.
 */
const LEDGER_DAYS = 540;

/**
 * How recent a movement has to be to still count as open, in days.
 *
 * A hold raised against an order is expected to ship within the month, and
 * demand older than that says more about last season than about what a location
 * can promise today. Holds and demand are therefore read over this window while
 * the reconciliation above reads the whole history.
 */
const RECENT_DAYS = 30;

/** Milliseconds in a day, for the two windows above. */
const DAY_MS = 86_400_000;

/**
 * Units of headroom above the reorder point that still count as low, when the
 * caller names no threshold. Ten units is the buying cushion the dashboard
 * opens on, so its list names the lines worth acting on today rather than only
 * the ones already short.
 */
const DEFAULT_THRESHOLD = 10;

/** The widest headroom a caller may ask the low-stock rule to allow for. */
const MAX_THRESHOLD = 10_000;

/** Lines on one page of the low-stock list, when the caller names no size. */
const DEFAULT_PAGE_SIZE = 50;

/** The most lines one page of the low-stock list may carry. */
const MAX_PAGE_SIZE = 200;

/** The highest page number the low-stock list answers; beyond it the page is empty. */
const MAX_PAGE = 10_000;

/* ---------------------------------------------------------------------------
 * Shapes
 * ------------------------------------------------------------------------- */

/**
 * One promised line of a cart: where it ships from, and the stock picture the
 * promise was made against.
 *
 * `availableQuantity` is what the chosen location could promise at the moment it
 * was chosen - its units on the shelf, less the units already promised to
 * somebody else, less the units held by orders that have not shipped yet - so it
 * is at least `requestedQuantity` on every line of a reservation that was
 * returned rather than refused. The remaining figures are that location's
 * ledger for this product: `net` over the reconciled history, `shipped` and
 * `held` over the recent window, `received` and `restockedAt` from its goods-in,
 * `adjusted` from its transfers and counts, and `movements` counting the
 * recorded changes behind them.
 */
export type ReservedLine = {
  productId: string;
  /** Identifier of the location the line ships from. */
  warehouseId: string;
  /** That location's short code, as the dashboard's filter row lists it. */
  warehouse: string;
  requestedQuantity: number;
  availableQuantity: number;
  /** The point at which that location reorders the line. */
  reorderPoint: number;
  /** Units held at that location by orders that have not shipped yet. */
  held: number;
  /** Units the ledger has added to that location, net of what it removed. */
  net: number;
  /** Units shipped from that location recently. */
  shipped: number;
  /** Units that location took in over the reconciled history. */
  received: number;
  /** Units transferred into that location, or corrected after a count. */
  adjusted: number;
  /** Recorded changes behind the figures above. */
  movements: number;
  /** When the line last moved at that location, or `null` if it never has. */
  movedAt: string | null;
  /** When that location last took the product in, or `null` if it never has. */
  restockedAt: string | null;
};

/**
 * What a cart can be promised: one {@link ReservedLine} per line of the cart, in
 * the order the lines were given.
 *
 * `units` is the quantity summed across those lines rather than the number of
 * them. `checkedAt` is when availability was established and `since` is the
 * start of the ledger history it was reconciled against, so a reader can tell
 * both how current the promise is and how much history stands behind it.
 *
 * A reservation reads stock and records nothing: it is a statement about what
 * the network can promise at `checkedAt`, not a claim on it, so establishing one
 * twice for the same cart answers the same thing twice.
 */
export type StockReservation = {
  lines: ReservedLine[];
  units: number;
  checkedAt: string;
  since: string;
};

/**
 * What the inventory dashboard may vary about the figures it asks for.
 *
 * Every member is optional and this module applies its own defaults, so a bare
 * `{}` answers the figures the dashboard opens on. The members are named after
 * the query parameters of the dashboard's feed, and the shape is deliberately
 * structural rather than imported: the schema that parses those parameters
 * validates a request, and this module never needs to know that a request is
 * where its arguments came from.
 */
export interface InventorySummaryInput {
  /**
   * A stocking location, named either by its identifier or by the short code
   * the filter row lists it under. `null` reports on every location.
   */
  warehouse?: string | null | undefined;
  /** Units of headroom above a line's reorder point that still count as low. */
  threshold?: number | undefined;
  /** Which page of the low-stock list to answer with, counted from `1`. */
  page?: number | undefined;
  /** How many low-stock lines one page carries. */
  pageSize?: number | undefined;
  /** Report only the lines in one selling state. `null` applies no constraint. */
  state?: StockState | null | undefined;
  /**
   * Report only the lines whose ledger holds a change of one kind. `null`
   * applies no constraint.
   */
  movement?: MovementType | null | undefined;
}

/* ---------------------------------------------------------------------------
 * Row conversion
 * ------------------------------------------------------------------------- */

/**
 * The whole number the driver row carried in `value`.
 *
 * PostgreSQL answers a `SUM` or a `COUNT` as a 64-bit integer, which the driver
 * hands over as a string so that no figure is silently rounded on its way into
 * JavaScript, and answers a `SUM` over no rows at all as `null`. An absent or
 * unparseable figure becomes `0`, so no quantity ever reaches a caller as `NaN`.
 */
function amount(value: string | null): number {
  if (value === null) {
    return 0;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

/**
 * The instant `value` names, as an ISO-8601 UTC string, or `null` when the row
 * carried none. A timestamp column arrives from raw SQL as a `Date`, which is
 * not a value the shapes in `@/lib/types` let out.
 */
function instant(value: Date | null): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

/**
 * `value` as a whole number between `min` and `max`, or `fallback` when the
 * caller named nothing usable. The dashboard's own schema rejects a figure
 * outside its range before it gets here; holding the range again costs nothing
 * and means a caller assembling an argument by hand cannot turn a page into a
 * full extract of the stock records.
 */
function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(value), min), max);
}

/* ---------------------------------------------------------------------------
 * Availability
 * ------------------------------------------------------------------------- */

/**
 * Establishes what the network can promise for every line of a cart, and names
 * the location each line ships from.
 *
 * Each line is read against its own ledger at every location that stocks it: the
 * movements recorded over the reconciled history, the units held by orders that
 * have not shipped yet, the units shipped recently, the goods-in behind the
 * shelf figure, and what has been transferred in or corrected after a count.
 * The line is promised to the location with the most units available, because a
 * line that ships complete from one location arrives as one delivery rather than
 * three; locations are read in code order, so the same cart resolves to the same
 * locations every time.
 *
 * @param lines The cart's lines, quantified as the cart holds them.
 * @returns One {@link ReservedLine} per line, in the order they were given.
 * @throws StorefrontError `OUT_OF_STOCK` when a line cannot be promised, either
 * because the network holds fewer units than were asked for or because no single
 * location holds enough of them to ship the line complete.
 */
export async function reserveStock(lines: readonly CartLine[]): Promise<StockReservation> {
  type Row = {
    warehouse_id: string;
    warehouse_code: string;
    on_hand: number;
    reserved: number;
    reorder_point: number;
    net: string | null;
    movements: string | null;
    last_movement: Date | null;
    held: string | null;
    shipped: string | null;
    received: string | null;
    last_receipt: Date | null;
    adjusted: string | null;
  };

  const checked = new Date();
  const ledger = new Date(checked.getTime() - LEDGER_DAYS * DAY_MS);
  const recent = new Date(checked.getTime() - RECENT_DAYS * DAY_MS);
  const promised: ReservedLine[] = [];
  let units = 0;

  for (const line of lines) {
    const result = await pool.query<Row>(
      `
        WITH ledger AS (
          SELECT
            m.warehouse_id,
            SUM(m.quantity_delta) AS net,
            COUNT(m.id) AS movements,
            MAX(m.created_at) AS last_movement
          FROM inventory_movements m
          WHERE m.product_id = $1
            AND m.created_at >= $2
          GROUP BY m.warehouse_id
        ),
        holds AS (
          SELECT
            m.warehouse_id,
            SUM(-m.quantity_delta) AS held
          FROM inventory_movements m
          WHERE m.product_id = $1
            AND m.created_at >= $3
            AND m.movement_type = 'RESERVATION'
          GROUP BY m.warehouse_id
        ),
        demand AS (
          SELECT
            m.warehouse_id,
            SUM(-m.quantity_delta) AS shipped
          FROM inventory_movements m
          WHERE m.product_id = $1
            AND m.created_at >= $3
            AND m.movement_type = 'SHIPMENT'
          GROUP BY m.warehouse_id
        ),
        restock AS (
          SELECT
            m.warehouse_id,
            SUM(m.quantity_delta) AS received,
            MAX(m.created_at) AS last_receipt
          FROM inventory_movements m
          WHERE m.product_id = $1
            AND m.created_at >= $2
            AND m.movement_type = 'RECEIPT'
          GROUP BY m.warehouse_id
        ),
        moved AS (
          SELECT
            m.warehouse_id,
            SUM(m.quantity_delta) AS adjusted
          FROM inventory_movements m
          WHERE m.product_id = $1
            AND m.created_at >= $2
            AND m.movement_type IN ('TRANSFER', 'ADJUSTMENT')
          GROUP BY m.warehouse_id
        )
        SELECT
          l.warehouse_id,
          w.code AS warehouse_code,
          l.on_hand,
          l.reserved,
          l.reorder_point,
          ledger.net,
          ledger.movements,
          ledger.last_movement,
          holds.held,
          demand.shipped,
          restock.received,
          restock.last_receipt,
          moved.adjusted
        FROM inventory_levels l
        JOIN warehouses w ON w.id = l.warehouse_id
        LEFT JOIN ledger ON ledger.warehouse_id = l.warehouse_id
        LEFT JOIN holds ON holds.warehouse_id = l.warehouse_id
        LEFT JOIN demand ON demand.warehouse_id = l.warehouse_id
        LEFT JOIN restock ON restock.warehouse_id = l.warehouse_id
        LEFT JOIN moved ON moved.warehouse_id = l.warehouse_id
        WHERE l.product_id = $1
        ORDER BY w.code
      `,
      [line.productId, ledger, recent],
    );

    // The location the line is promised to and the units it can promise, plus
    // the two figures a refusal reports: the deepest single location, and what
    // the network holds altogether.
    let pick: Row | null = null;
    let cover = 0;
    let deepest = 0;
    let stocked = 0;

    for (const row of result.rows) {
      const available = Math.max(0, row.on_hand - row.reserved - amount(row.held));

      stocked += available;
      deepest = Math.max(deepest, available);

      if (available >= line.quantity && available > cover) {
        cover = available;
        pick = row;
      }
    }

    if (pick === null) {
      const message =
        stocked < line.quantity
          ? `Only ${stocked} units of ${line.name} remain in stock.`
          : `Only ${deepest} units of ${line.name} can ship from one location.`;

      throw new StorefrontError('OUT_OF_STOCK', 409, message, {
        details: {
          productId: line.productId,
          requested: line.quantity,
          available: stocked,
          largest: deepest,
        },
      });
    }

    promised.push({
      productId: line.productId,
      warehouseId: pick.warehouse_id,
      warehouse: pick.warehouse_code,
      requestedQuantity: line.quantity,
      availableQuantity: cover,
      reorderPoint: pick.reorder_point,
      held: amount(pick.held),
      net: amount(pick.net),
      shipped: amount(pick.shipped),
      received: amount(pick.received),
      adjusted: amount(pick.adjusted),
      movements: amount(pick.movements),
      movedAt: instant(pick.last_movement),
      restockedAt: instant(pick.last_receipt),
    });

    units += line.quantity;
  }

  return {
    lines: promised,
    units,
    checkedAt: checked.toISOString(),
    since: ledger.toISOString(),
  };
}

/* ---------------------------------------------------------------------------
 * Dashboard
 * ------------------------------------------------------------------------- */

/**
 * The inventory dashboard's payload: the figures on its cards, the stocking
 * locations its filter row lists, and one page of the lines that have fallen to
 * their reorder point.
 *
 * A line counts as low once its available units - the units on the shelf less
 * the units already promised - reach its reorder point plus the caller's
 * threshold, so a threshold of zero reports only the lines already at or under
 * their point and a larger one widens the list to the lines heading there. Each
 * reported line carries its own reorder point, so a reader always sees the
 * figure that classified it.
 *
 * `lowStockCount` counts every line the filters matched rather than the lines on
 * the page, so the list can be paged without a second request. The low-stock
 * page is ordered by how far each line has fallen below its point, which puts
 * the lines worth acting on first, and is broken deterministically by SKU and
 * then by location code so that paging never shows a line twice.
 *
 * @param input Which locations, states and lines to report on; `{}` answers the
 * figures the dashboard opens on.
 * @returns The dashboard's payload, computed at `generatedAt`.
 * @throws StorefrontNotFoundError when the named stocking location does not
 * exist.
 */
export async function readInventorySummary(
  input: InventorySummaryInput,
): Promise<InventorySummary> {
  type Totals = {
    skus: string | null;
    on_hand: string | null;
    reserved: string | null;
    low: string | null;
  };

  type Shortage = {
    product_id: string;
    sku: string;
    product_name: string;
    warehouse_name: string;
    available: number;
    reorder_point: number;
  };

  const threshold = bounded(input.threshold, DEFAULT_THRESHOLD, 0, MAX_THRESHOLD);
  const page = bounded(input.page, 1, 1, MAX_PAGE);
  const size = bounded(input.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const state = input.state ?? null;
  const movement = input.movement ?? null;

  // Six rows, ordered here rather than by the database: the filter row lists
  // them by code, and the low-stock rows below name their location by code too.
  const warehouses: WarehouseSummary[] = (await prisma.warehouse.findMany())
    .map((row) => ({ id: row.id, code: row.code, name: row.name, region: row.region }))
    .sort((a, b) => a.code.localeCompare(b.code));

  const named = input.warehouse ?? null;
  let location: string | null = null;

  if (named !== null && named.trim().length > 0) {
    const wanted = named.trim();
    const match = warehouses.find(
      (row) => row.id === wanted || row.code.toUpperCase() === wanted.toUpperCase(),
    );

    if (match === undefined) {
      throw new StorefrontNotFoundError('No stocking location matches that filter.');
    }

    location = match.id;
  }

  // A movement filter asks for the lines whose ledger holds a change of that
  // kind, which is a question about the ledger rather than about stock: the
  // products it names are resolved first and then constrain both statements
  // below, so neither of them has to reach into the ledger itself.
  let only: string[] | null = null;

  if (movement !== null) {
    const groups = await prisma.inventoryMovement.groupBy({
      by: ['productId'],
      where:
        location === null
          ? { movementType: movement }
          : { movementType: movement, warehouseId: location },
    });

    only = groups.map((group) => group.productId);
  }

  const totals = await pool.query<Totals>(
    `
      SELECT
        COUNT(DISTINCT l.product_id) AS skus,
        SUM(l.on_hand) AS on_hand,
        SUM(l.reserved) AS reserved,
        COUNT(*) FILTER (WHERE l.on_hand - l.reserved <= l.reorder_point + $2::int) AS low
      FROM inventory_levels l
      WHERE ($1::text IS NULL OR l.warehouse_id = $1::text)
        AND ($3::text IS NULL
             OR ($3::text = 'OUT_OF_STOCK' AND l.on_hand - l.reserved <= 0)
             OR ($3::text = 'LOW_STOCK'
                 AND l.on_hand - l.reserved > 0
                 AND l.on_hand - l.reserved <= l.reorder_point + $2::int)
             OR ($3::text = 'IN_STOCK' AND l.on_hand - l.reserved > l.reorder_point + $2::int))
        AND ($4::text[] IS NULL OR l.product_id = ANY($4::text[]))
    `,
    [location, threshold, state, only],
  );

  const shortages = await pool.query<Shortage>(
    `
      SELECT
        l.product_id,
        p.sku,
        p.name AS product_name,
        w.name AS warehouse_name,
        l.on_hand - l.reserved AS available,
        l.reorder_point
      FROM inventory_levels l
      JOIN products p ON p.id = l.product_id
      JOIN warehouses w ON w.id = l.warehouse_id
      WHERE l.on_hand - l.reserved <= l.reorder_point + $2::int
        AND ($1::text IS NULL OR l.warehouse_id = $1::text)
        AND ($3::text IS NULL
             OR ($3::text = 'OUT_OF_STOCK' AND l.on_hand - l.reserved <= 0)
             OR ($3::text = 'LOW_STOCK' AND l.on_hand - l.reserved > 0)
             OR ($3::text = 'IN_STOCK' AND l.on_hand - l.reserved > l.reorder_point + $2::int))
        AND ($4::text[] IS NULL OR l.product_id = ANY($4::text[]))
      ORDER BY (l.on_hand - l.reserved) - l.reorder_point, p.sku, w.code
      LIMIT $5::int OFFSET $6::int
    `,
    [location, threshold, state, only, size, (page - 1) * size],
  );

  const figures = totals.rows[0];

  const lowStock: LowStockRow[] = shortages.rows.map((row) => ({
    productId: row.product_id,
    sku: row.sku,
    productName: row.product_name,
    warehouseName: row.warehouse_name,
    available: row.available,
    reorderPoint: row.reorder_point,
  }));

  return {
    totalSkus: amount(figures?.skus ?? null),
    totalOnHand: amount(figures?.on_hand ?? null),
    totalReserved: amount(figures?.reserved ?? null),
    lowStockCount: amount(figures?.low ?? null),
    warehouses,
    lowStock,
    generatedAt: new Date().toISOString(),
  };
}
