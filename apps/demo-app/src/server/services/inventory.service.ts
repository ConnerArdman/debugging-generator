/**
 * Stock availability, and the figures behind the inventory dashboard.
 *
 * Three operations live here, and they are the questions the warehouse side of
 * Lumen Supply is asked. `reserveStock` decides whether a cart can be promised,
 * names the distribution center each of its lines ships from and holds the
 * units it promised; it runs while an order is being placed, and `release`
 * gives those units back when the order it was promising did not happen.
 * `readInventorySummary` answers the inventory dashboard: the figures on its
 * cards, the stocking locations its filter row lists, one page of the stock
 * lines themselves, and the lines that have fallen to their reorder point.
 *
 * Both read the same two tables, and the difference between them is the whole
 * reason a reservation is not a single lookup. `inventory_levels` holds one row
 * per product per location carrying the units on the shelf, the units already
 * promised to somebody else and the point at which the line is reordered - what
 * a location currently believes it has. `inventory_movements` is the ledger:
 * one signed row for every recorded change, whether goods received, goods
 * shipped, stock transferred between locations, a correction after a count, or a
 * hold raised against an order. It is how the location came to believe it, and
 * it is where every hold this store raises is written down. A reservation
 * reconciles the two before it promises anything, and then writes itself into
 * both: the units it promised are added to what the location has promised, and
 * the hold that promised them is recorded in the ledger under a reference of
 * its own, so it can be given back by naming it.
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

import { MovementType } from '@/generated/prisma/client';
import type {
  CartLine,
  InventoryLevelRow,
  InventorySummary,
  LowStockRow,
  PagedList,
  ProductSummary,
  StockState,
  WarehouseSummary,
} from '@/lib/types';
import { pool } from '@/server/db/pool';
import { prisma } from '@/server/db/prisma';
import { StorefrontError, StorefrontNotFoundError } from '@/server/errors';
import { readProductsByIds } from '@/server/services/catalog.service';

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

/** Stock lines on one page of the dashboard's table, when the caller names no size. */
const DEFAULT_PAGE_SIZE = 50;

/**
 * The most stock lines one page may carry. The ceiling is deliberate: a page
 * stays a page, so no single request turns the paged table into a full extract
 * of the stock records.
 */
const MAX_PAGE_SIZE = 200;

/** The highest page number answered; beyond it the page is empty rather than refused. */
const MAX_PAGE = 10_000;

/**
 * How many of the lines at or below their reorder point the payload carries.
 *
 * The low-stock list is what to act on today rather than a second paged
 * listing - the page's own pager belongs to the stock table - so it names the
 * most urgent lines and stops. The figure the filters matched in full is
 * reported separately as `lowStockCount`, so a reader is never left thinking
 * twelve is all there are.
 */
const LOW_STOCK_LINES = 12;

/**
 * How a hold names itself in the ledger, ahead of the identifier that makes it
 * one hold rather than another. Short and legible, because a reference is read
 * by whoever is looking at the ledger rather than parsed by anything.
 */
const HOLD = 'RSV';

/* ---------------------------------------------------------------------------
 * Shapes
 * ------------------------------------------------------------------------- */

/**
 * One promised line of a cart: where it ships from, and the stock picture the
 * promise was made against.
 *
 * `availableQuantity` is what the chosen location could promise at the moment it
 * was chosen - its units on the shelf, less the units already promised to
 * somebody else - so it is at least `requestedQuantity` on every line of a
 * reservation that was returned rather than refused. It is the same figure the
 * inventory dashboard calls available, because a line is promised out of the
 * same headroom the dashboard reports. The remaining figures are that location's
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
 * `reference` names the hold the reservation raised. The units it covers are
 * promised to this reservation and to nothing else until they are shipped or
 * given back, and handing the reference to {@link release} is how they are
 * given back - which is what a caller whose order did not go through does with
 * it. A reservation is therefore a claim on stock rather than a statement about
 * it, and a second one for the same cart holds a second set of units.
 */
export type StockReservation = {
  lines: ReservedLine[];
  units: number;
  reference: string;
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
   * A stocking location, named by its identifier - the `id` of one of the
   * locations this module reports. `null` reports on every location.
   */
  warehouseId?: string | null | undefined;
  /** Units of headroom above a line's reorder point that still count as low. */
  threshold?: number | undefined;
  /** Which page of the stock lines to answer with, counted from `1`. */
  page?: number | undefined;
  /** How many stock lines one page carries. */
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
 * The units it promises are then held, all of them or none: availability was
 * read a line at a time and another order may have taken the same units since,
 * so each location is counted up under its own row and the hold is recorded in
 * the ledger against a reference of its own. A caller whose order does not go
 * through hands that reference to {@link release}, and the units return to the
 * locations they were promised out of.
 *
 * @param lines The cart's lines, quantified as the cart holds them.
 * @returns One {@link ReservedLine} per line, in the order they were given,
 * together with the reference the hold was raised under.
 * @throws StorefrontError `OUT_OF_STOCK` when a line cannot be promised, either
 * because the network holds fewer units than were asked for, because no single
 * location holds enough of them to ship the line complete, or because the units
 * it was promised went elsewhere before the hold could be raised.
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
      const available = Math.max(0, row.on_hand - row.reserved);

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

  const reference = `${HOLD}-${crypto.randomUUID()}`;

  await hold(promised, reference);

  return {
    lines: promised,
    units,
    reference,
    checkedAt: checked.toISOString(),
    since: ledger.toISOString(),
  };
}

/**
 * Gives back the units a hold was promising.
 *
 * The ledger is the record of what a hold took, so releasing one is a matter of
 * reading its rows back and writing their opposite: each location the hold
 * touched has the units it still holds returned to its headroom, and a row
 * recording the return goes into the ledger under the same reference, so the
 * hold and its release stand next to each other rather than one of them
 * quietly disappearing.
 *
 * Releasing twice is releasing once, and that has to hold when the two happen
 * at the same time as much as when one follows the other - a caller recovering
 * from a failure may well be one of several. So a release takes the reference
 * itself in hand for the length of its transaction, and reads the balance
 * while holding it: a second release of the same reference waits, then reads a
 * ledger that already contains the first one's rows, finds nothing owed and
 * writes nothing. A hold whose rows already cancel out is left alone, which is
 * what lets a caller call this without first working out whether an earlier
 * attempt already did.
 *
 * @param reference The hold to release, as {@link StockReservation} named it.
 */
export async function release(reference: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // One release of a reference at a time. The lock is the reference rather
    // than any row, because what is being made single is the decision about
    // what this hold still owes, and it is scoped to this transaction, so it is
    // given up when the transaction ends however it ends.
    await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(hashtext(${reference}::text))`;

    const rows = await tx.inventoryMovement.findMany({
      where: { reference, movementType: MovementType.RESERVATION },
      select: { productId: true, warehouseId: true, quantityDelta: true },
    });

    // A hold is one row per line when it is raised and one per line when it is
    // released, so what matters is the balance per location rather than the
    // rows: a location still owing units has a negative balance, and a released
    // one has none left.
    const balance = new Map<string, { productId: string; warehouseId: string; units: number }>();

    for (const row of rows) {
      const key = `${row.productId}:${row.warehouseId}`;
      const held = balance.get(key);

      if (held === undefined) {
        balance.set(key, {
          productId: row.productId,
          warehouseId: row.warehouseId,
          units: row.quantityDelta,
        });
      } else {
        held.units += row.quantityDelta;
      }
    }

    // Locations are written in the same order a hold writes them, so a release
    // and a hold that overlap queue behind one another rather than each waiting
    // on a row the other holds.
    const owed = [...balance.values()]
      .filter((held) => held.units < 0)
      .sort((one, other) =>
        one.productId === other.productId
          ? one.warehouseId.localeCompare(other.warehouseId)
          : one.productId.localeCompare(other.productId),
      );

    for (const held of owed) {
      const units = -held.units;

      await tx.inventoryLevel.updateMany({
        where: { productId: held.productId, warehouseId: held.warehouseId },
        data: { reserved: { decrement: units } },
      });

      await tx.inventoryMovement.create({
        data: {
          productId: held.productId,
          warehouseId: held.warehouseId,
          quantityDelta: units,
          movementType: MovementType.RESERVATION,
          reference,
        },
      });
    }
  });
}

/**
 * Holds the units a reservation promised, or promises none of them.
 *
 * Availability was read a moment ago, and a moment is long enough for another
 * order to have taken the same units, so the hold is not a matter of writing
 * down what was read. Each location's row is taken in hand as the units are
 * added to what it has promised, and the figure that results is read back
 * inside the same transaction, where the row is still held: a location can only
 * be counted up by one caller at a time, and the next caller reads what this
 * one left rather than the figure that stood before it. The row is only sound
 * if that result is still within what the location has on the shelf. A location
 * counted past its shelf is one whose units went elsewhere in between, which
 * fails the whole reservation: every line of a cart is held together or none of
 * it is, so a caller is never left holding half a cart's worth of stock.
 *
 * Locations are taken in a fixed order, by product and then by location, so two
 * carts holding overlapping lines queue behind one another rather than each
 * waiting on a row the other already holds.
 *
 * @param lines The lines to hold, as availability named them.
 * @param reference The hold's own reference, written on every row.
 * @throws StorefrontError `OUT_OF_STOCK` when a line's units went elsewhere
 * between availability being read and the hold being raised, or when the
 * location it was going to ship from no longer stocks it at all.
 */
async function hold(lines: readonly ReservedLine[], reference: string): Promise<void> {
  const ordered = [...lines].sort((one, other) =>
    one.productId === other.productId
      ? one.warehouseId.localeCompare(other.warehouseId)
      : one.productId.localeCompare(other.productId),
  );

  await prisma.$transaction(async (tx) => {
    for (const line of ordered) {
      const where = { productId: line.productId, warehouseId: line.warehouseId };

      const counted = await tx.inventoryLevel.updateMany({
        where,
        data: { reserved: { increment: line.requestedQuantity } },
      });

      const level =
        counted.count === 0
          ? null
          : await tx.inventoryLevel.findFirst({ where, select: { onHand: true, reserved: true } });

      if (level === null) {
        throw new StorefrontError(
          'OUT_OF_STOCK',
          409,
          'One of your items is no longer stocked where it was going to ship from. Review your cart and place the order again.',
          {
            details: { productId: line.productId, requested: line.requestedQuantity, available: 0 },
          },
        );
      }

      if (level.reserved > level.onHand) {
        throw new StorefrontError(
          'OUT_OF_STOCK',
          409,
          'Another order took the last units of one of your items. Review your cart and place the order again.',
          {
            details: {
              productId: line.productId,
              requested: line.requestedQuantity,
              available: Math.max(0, level.onHand - (level.reserved - line.requestedQuantity)),
            },
          },
        );
      }

      await tx.inventoryMovement.create({
        data: {
          productId: line.productId,
          warehouseId: line.warehouseId,
          quantityDelta: -line.requestedQuantity,
          movementType: MovementType.RESERVATION,
          reference,
        },
      });
    }
  });
}

/* ---------------------------------------------------------------------------
 * Dashboard
 * ------------------------------------------------------------------------- */

/**
 * The inventory dashboard's payload: the figures on its cards, the stocking
 * locations its filter row lists, one page of the stock lines the filters
 * matched, and the lines that have fallen to their reorder point.
 *
 * A stock line is one product at one stocking location. `page` and `pageSize`
 * window that listing - it is the surface the dashboard pages - and `levels`
 * reports the window it was answered with together with the number of lines the
 * filters matched in full, so a pager is sized from the payload rather than
 * re-derived from a query string. A page past the end of the listing is
 * answered as an empty page, which is what keeps a bookmarked dashboard address
 * working after the stock behind it has moved on. The page is ordered by
 * category, then by product, then by location, so a reader scans it the way the
 * table groups it, and the order is broken deterministically by product and
 * location identifier so paging never shows a line twice. `levelProducts` names
 * the products on that page, read through the catalog so a card's price and
 * selling state are derived in exactly one place.
 *
 * A line counts as low once its available units - the units on the shelf less
 * the units already promised - reach its reorder point plus the caller's
 * threshold, so a threshold of zero reports only the lines already at or under
 * their point and a larger one widens the list to the lines heading there. Each
 * reported line carries its own reorder point, so a reader always sees the
 * figure that classified it.
 *
 * `lowStock` holds the most urgent of those lines - ordered by how far each has
 * fallen below its point, broken deterministically by SKU and then by location
 * code - and `lowStockCount` counts every line the filters matched, which is
 * how a reader can tell a short list from a complete one.
 *
 * `movementVolume` is the throughput behind those figures rather than another
 * balance: the units the ledger has recorded against the lines the filters
 * matched, with goods in and goods out both counting as the units they moved.
 * It is read over the whole recorded history, so it answers how much stock has
 * passed through what the caller asked about, and a movement filter narrows it
 * to one kind of change.
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
    lines: string | null;
    on_hand: string | null;
    reserved: string | null;
    low: string | null;
  };

  type Level = {
    product_id: string;
    warehouse_id: string;
    warehouse_name: string;
    on_hand: number;
    reserved: number;
    available: number;
    reorder_point: number;
  };

  type Shortage = {
    product_id: string;
    sku: string;
    product_name: string;
    warehouse_name: string;
    available: number;
    reorder_point: number;
  };

  type Volume = {
    units: string | null;
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

  // The filter names a location by identifier and by nothing else: the short
  // code above is how a location is displayed, not a second key it answers to,
  // so a value that is not one of these identifiers matches no location at all.
  const named = input.warehouseId ?? null;
  let location: string | null = null;

  if (named !== null && named.trim().length > 0) {
    const wanted = named.trim();
    const match = warehouses.find((row) => row.id === wanted);

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

  // Four questions about the same stock, and none of them reads another's
  // answer: the figures on the cards, the page of stock lines, the lines that
  // have fallen to their point, and the units the ledger accounts for. They are
  // issued together and awaited once, so the dashboard costs one round trip to
  // the database rather than four in turn.
  const [totals, stock, shortages, volume] = await Promise.all([
    pool.query<Totals>(
      `
        SELECT
          COUNT(DISTINCT l.product_id) AS skus,
          COUNT(*) AS lines,
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
    ),
    // One page of the stock lines the same filters matched, under the same
    // selling-state rule as the figures above so the table and the cards can
    // never describe different stock. The two joins past the location are there
    // for the order alone: a reader scans the table by category and then by
    // product, and the line's own identifiers break the order so that a page is
    // the same page on every request.
    pool.query<Level>(
      `
        SELECT
          l.product_id,
          l.warehouse_id,
          w.name AS warehouse_name,
          l.on_hand,
          l.reserved,
          l.on_hand - l.reserved AS available,
          l.reorder_point
        FROM inventory_levels l
        JOIN warehouses w ON w.id = l.warehouse_id
        JOIN products p ON p.id = l.product_id
        JOIN categories c ON c.id = p.category_id
        WHERE ($1::text IS NULL OR l.warehouse_id = $1::text)
          AND ($3::text IS NULL
               OR ($3::text = 'OUT_OF_STOCK' AND l.on_hand - l.reserved <= 0)
               OR ($3::text = 'LOW_STOCK'
                   AND l.on_hand - l.reserved > 0
                   AND l.on_hand - l.reserved <= l.reorder_point + $2::int)
               OR ($3::text = 'IN_STOCK' AND l.on_hand - l.reserved > l.reorder_point + $2::int))
          AND ($4::text[] IS NULL OR l.product_id = ANY($4::text[]))
        ORDER BY c.name, p.name, l.product_id, w.code
        LIMIT $5::int OFFSET $6::int
      `,
      [location, threshold, state, only, size, (page - 1) * size],
    ),
    pool.query<Shortage>(
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
        LIMIT $5::int
      `,
      [location, threshold, state, only, LOW_STOCK_LINES],
    ),
    // Both directions count as the units they moved, so goods in and goods out
    // add up instead of cancelling: the figure is what the ledger has handled,
    // not what is left. The join is what holds it to the same lines the totals
    // above report on - a recorded change counts only where the line it moved
    // is one the caller asked about - and a movement filter narrows it to the
    // one kind of change directly, which is the question it was asked.
    pool.query<Volume>(
      `
        SELECT COALESCE(SUM(ABS(m.quantity_delta)), 0) AS units
        FROM inventory_movements m
        JOIN inventory_levels l
          ON l.product_id = m.product_id AND l.warehouse_id = m.warehouse_id
        WHERE ($1::text IS NULL OR m.warehouse_id = $1::text)
          AND ($3::text IS NULL
               OR ($3::text = 'OUT_OF_STOCK' AND l.on_hand - l.reserved <= 0)
               OR ($3::text = 'LOW_STOCK'
                   AND l.on_hand - l.reserved > 0
                   AND l.on_hand - l.reserved <= l.reorder_point + $2::int)
               OR ($3::text = 'IN_STOCK' AND l.on_hand - l.reserved > l.reorder_point + $2::int))
          AND ($4::text IS NULL OR m.movement_type::text = $4::text)
      `,
      [location, threshold, state, movement],
    ),
  ]);

  const figures = totals.rows[0];
  const moved = volume.rows[0];

  const levels: PagedList<InventoryLevelRow> = {
    items: stock.rows.map((row) => ({
      warehouseId: row.warehouse_id,
      warehouseName: row.warehouse_name,
      productId: row.product_id,
      onHand: row.on_hand,
      reserved: row.reserved,
      available: row.available,
      reorderPoint: row.reorder_point,
    })),
    total: amount(figures?.lines ?? null),
    page,
    pageSize: size,
  };

  const lowStock: LowStockRow[] = shortages.rows.map((row) => ({
    productId: row.product_id,
    sku: row.sku,
    productName: row.product_name,
    warehouseName: row.warehouse_name,
    available: row.available,
    reorderPoint: row.reorder_point,
  }));

  // The products behind the page of lines, and the one read that has to follow
  // another: which products to name is what the page of lines just decided. A
  // page holding no lines names none, and the catalog answers that without a
  // query of its own.
  const levelProducts: ProductSummary[] = await readProductsByIds(
    levels.items.map((row) => row.productId),
  );

  return {
    totalSkus: amount(figures?.skus ?? null),
    totalOnHand: amount(figures?.on_hand ?? null),
    totalReserved: amount(figures?.reserved ?? null),
    lowStockCount: amount(figures?.low ?? null),
    movementVolume: amount(moved?.units ?? null),
    warehouses,
    levels,
    levelProducts,
    lowStock,
    generatedAt: new Date().toISOString(),
  };
}
