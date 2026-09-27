/**
 * The catalog's read layer.
 *
 * Three questions are asked of the catalog, and this module answers all three:
 * the filtered, sorted page of products behind the catalog grid, one product by
 * its slug for the detail page, and the categories the filter chips are built
 * from. Each answer is stated in the data-transfer shapes of `@/lib/types`
 * rather than in database rows, so nothing above this module holds a column
 * name, a relation it has to walk or a value JSON cannot carry.
 *
 * Two conversions belong to this boundary and happen nowhere else:
 *
 * * **Money stays an integer count of US cents.** `unitPriceCents` is stored
 *   that way, so the value is passed through rather than scaled or rounded.
 * * **Instants become ISO-8601 UTC strings.** A `Date` does not survive the
 *   trip from a server component into a client component, so the one timestamp
 *   the detail payload carries is stringified here.
 *
 * Stock is a third derivation. `StockState` is no column: it is read off the
 * stock positions these queries already select, which is why the badge on a
 * catalog card and the badge on a product page cannot disagree.
 *
 * Importing this module opens no connection and reads no configuration other
 * than `DATABASE_URL`, which `@/server/db/pool` reads to build the pool the
 * client in `@/server/db/prisma` queries through. Neither connects until the
 * first query, and an absent `DATABASE_URL` surfaces only there, so a page that
 * imports this module still builds and type-checks against a machine with no
 * database.
 */

import type { Prisma } from '@/generated/prisma/client';
import type {
  CatalogQuery,
  CatalogSort,
  CategoryOption,
  InventoryLevelRow,
  PagedList,
  ProductDetail,
  ProductImage,
  ProductSpec,
  ProductSummary,
  StockState,
} from '@/lib/types';
import { prisma } from '@/server/db/prisma';
import { StorefrontNotFoundError } from '@/server/errors';

/** A full page of catalog cards: what a caller naming no page size is answered with. */
const PAGE_SIZE_DEFAULT = 48;

/** The largest page this module answers, whatever size a caller asks for. */
const PAGE_SIZE_CEILING = 96;

/** The stock fields both queries select, and everything the derivations below read. */
type Levels = readonly {
  onHand: number;
  reserved: number;
  reorderPoint: number;
}[];

/** The stock fields the detail query selects on top of {@link Levels}. */
type Stocks = readonly {
  productId: string;
  warehouseId: string;
  onHand: number;
  reserved: number;
  reorderPoint: number;
  warehouse: { name: string };
}[];

/** The product fields a catalog card is built from, as both queries select them. */
type Row = {
  id: string;
  sku: string;
  slug: string;
  name: string;
  unitPriceCents: number;
  imageUrl: string | null;
  category: { name: string; slug: string };
  inventoryLevels: Levels;
};

/**
 * A page number or page size as a whole number, or `fallback` when the caller
 * named none or named something that is not a finite number.
 *
 * The bounds are left to the caller, because the two parameters are bounded
 * differently. Guarding them at all is deliberate: a parsed request arrives
 * with both already coerced, but a server component calls these functions
 * directly and with values of its own.
 */
function whole(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/**
 * The condition both listing queries run under: the products the catalog
 * merchandises, narrowed by whichever filters the caller constrained.
 *
 * `active` is the catalog's own condition rather than one of those filters - a
 * product that is no longer listed is not merchandised, though it stays
 * readable by its own address, as {@link readProductBySlug} describes. A
 * category slug no category owns matches nothing and answers an empty page,
 * and a blank search term narrows nothing at all, so a search box submitted
 * empty answers the whole catalog instead of none of it.
 */
function filters(query: CatalogQuery): Prisma.ProductWhereInput {
  const where: Prisma.ProductWhereInput = { active: true };

  if (query.categorySlug !== undefined) {
    where.category = { slug: query.categorySlug };
  }

  const term = query.search?.trim() ?? '';

  if (term.length > 0) {
    where.OR = [
      { name: { contains: term, mode: 'insensitive' } },
      { sku: { contains: term, mode: 'insensitive' } },
    ];
  }

  return where;
}

/**
 * The ordering `sort` asks for, with the product id as its final key.
 *
 * Every ordering ends in a unique column so that paging is stable: products
 * tied on price or on listing date would otherwise be free to change places
 * between one request and the next, and a product can only be missing from one
 * page and repeated on another while that is true. `featured` is the catalog's
 * own order, most recently listed first.
 */
function ordering(sort: CatalogSort): Prisma.ProductOrderByWithRelationInput[] {
  switch (sort) {
    case 'price_asc':
      return [{ unitPriceCents: 'asc' }, { id: 'asc' }];
    case 'price_desc':
      return [{ unitPriceCents: 'desc' }, { id: 'asc' }];
    case 'name_asc':
      return [{ name: 'asc' }, { id: 'asc' }];
    case 'featured':
      return [{ createdAt: 'desc' }, { id: 'asc' }];
  }
}

/**
 * Units available to promise across every stocking location: what is on hand
 * less what is already reserved against an order, and never below zero.
 */
function available(levels: Levels): number {
  let units = 0;

  for (const level of levels) {
    units += level.onHand - level.reserved;
  }

  return Math.max(0, units);
}

/**
 * How freely the product can be sold: nothing available is `OUT_OF_STOCK`,
 * available units at or below the reorder points they are measured against are
 * `LOW_STOCK`, and anything above them is `IN_STOCK`.
 *
 * The comparison is made across every location at once, because one location's
 * reorder point says little about a product stocked in six distribution
 * centers. A product with no stock position at all is out of stock rather than
 * unknown: there is nothing to sell either way.
 */
function state(levels: Levels): StockState {
  const units = available(levels);

  if (units <= 0) {
    return 'OUT_OF_STOCK';
  }

  let floor = 0;

  for (const level of levels) {
    floor += level.reorderPoint;
  }

  return units <= floor ? 'LOW_STOCK' : 'IN_STOCK';
}

/**
 * One product as a catalog card presents it.
 *
 * `listPriceCents` is `null` because a catalog price is a list price here: the
 * price rules this application keeps are volume tiers, resolved against an
 * ordered quantity when a cart is priced rather than against the single unit a
 * card shows.
 */
function card(row: Row): ProductSummary {
  return {
    id: row.id,
    sku: row.sku,
    slug: row.slug,
    name: row.name,
    categoryName: row.category.name,
    categorySlug: row.category.slug,
    priceCents: row.unitPriceCents,
    listPriceCents: null,
    imageUrl: row.imageUrl,
    stockState: state(row.inventoryLevels),
    availableQuantity: available(row.inventoryLevels),
  };
}

/** The product's stock, one row per stocking location. */
function availability(levels: Stocks): InventoryLevelRow[] {
  return levels.map((level) => ({
    warehouseId: level.warehouseId,
    warehouseName: level.warehouse.name,
    productId: level.productId,
    onHand: level.onHand,
    reserved: level.reserved,
    available: level.onHand - level.reserved,
    reorderPoint: level.reorderPoint,
  }));
}

/**
 * The product's gallery: the image recorded against it, if it has one.
 *
 * The path is passed through exactly as stored. A product without artwork gets
 * an empty gallery rather than a substitute chosen here, which leaves that
 * decision to the component doing the rendering.
 */
function images(url: string | null, name: string): ProductImage[] {
  return url === null ? [] : [{ url, alt: name }];
}

/**
 * The product's specification rows, read off the columns it actually carries:
 * what to order it by, where it sits in the catalog, how long it takes to
 * dispatch and how many locations stock it.
 */
function specs(sku: string, category: string, days: number, locations: number): ProductSpec[] {
  return [
    { label: 'SKU', value: sku },
    { label: 'Category', value: category },
    { label: 'Lead time', value: days === 1 ? '1 business day' : `${String(days)} business days` },
    {
      label: 'Stocked at',
      value: locations === 1 ? '1 location' : `${String(locations)} locations`,
    },
  ];
}

/**
 * One page of the catalog.
 *
 * The filters the caller constrained decide which products the page is drawn
 * from, and the same condition sizes the total: the count is of every product
 * the filters matched rather than of the cards returned, so a pager can be laid
 * out without a second request. Both statements are issued together because
 * neither depends on the other's result.
 *
 * A caller that constrains nothing is answered the first page of the catalog's
 * own order, which is what makes `browseCatalog()` a complete request.
 *
 * @param query Filters, ordering and page. Every member is optional, and an
 * omitted filter constrains nothing rather than constraining on nothing.
 * @returns The page's cards, the number of products the filters matched, and
 * the page number and page size the answer was actually built with - both
 * resolved, so a caller never has to re-derive them.
 */
export async function browseCatalog(query: CatalogQuery = {}): Promise<PagedList<ProductSummary>> {
  const size = Math.min(Math.max(whole(query.pageSize, PAGE_SIZE_DEFAULT), 1), PAGE_SIZE_CEILING);
  const page = Math.max(whole(query.page, 1), 1);
  const where = filters(query);

  const [rows, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: ordering(query.sort ?? 'featured'),
      skip: (page - 1) * size,
      take: size,
      select: {
        id: true,
        sku: true,
        slug: true,
        name: true,
        unitPriceCents: true,
        imageUrl: true,
        category: { select: { name: true, slug: true } },
        inventoryLevels: { select: { onHand: true, reserved: true, reorderPoint: true } },
      },
    }),
    prisma.product.count({ where }),
  ]);

  return {
    items: rows.map(card),
    total,
    page,
    pageSize: size,
  };
}

/**
 * The catalog cards for a set of products named by identifier.
 *
 * It answers the surfaces that hold product identifiers without holding the
 * products themselves - the inventory dashboard's stock table is one, where a
 * stock line names its product by identifier and the table prints its name, its
 * code, its unit price and the category it groups under. Reading them here
 * rather than beside the caller is what keeps one derivation of a card: the
 * price, the units available to promise and the selling state on one of these
 * come from the same code as the ones on a catalog card, so two surfaces can
 * never badge the same product differently.
 *
 * The catalog's own merchandising condition is deliberately not applied. A
 * product the catalog no longer lists can still be stocked, and a stock line
 * with no name is worse than a line naming a delisted product - which is the
 * same reading {@link readProductBySlug} takes of a delisted product's own
 * page.
 *
 * @param ids The products to name; repeats are collapsed and an empty set is
 * answered without a query.
 * @returns One card per product that exists, ordered by identifier. An
 * identifier no product owns is simply absent, so a caller matches by `id`
 * rather than by position.
 */
export async function readProductsByIds(ids: readonly string[]): Promise<ProductSummary[]> {
  const wanted = [...new Set(ids)];

  if (wanted.length === 0) {
    return [];
  }

  const rows = await prisma.product.findMany({
    where: { id: { in: wanted } },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      sku: true,
      slug: true,
      name: true,
      unitPriceCents: true,
      imageUrl: true,
      category: { select: { name: true, slug: true } },
      inventoryLevels: { select: { onHand: true, reserved: true, reorderPoint: true } },
    },
  });

  return rows.map(card);
}

/**
 * One product, as its detail page presents it.
 *
 * The lookup is by slug, which is unique, so the page's address is the key and
 * nothing has to be searched for. Stock is read per location and ordered by
 * distribution-center code, so the availability table reads the same on every
 * visit.
 *
 * A product the catalog no longer merchandises is still answered here: its
 * address is a link a customer may have bookmarked or a search engine may have
 * indexed, and a page that shows its stock as it stands is a better answer to
 * that link than a missing one.
 *
 * @param slug The product's slug, exactly as its address carries it.
 * @returns The product's full detail payload.
 * @throws StorefrontNotFoundError when no product owns the slug. The failure is
 * an error rather than a `null` return so that every caller - a route handler
 * and a server component alike - reports it the one way, and the message names
 * no value the caller supplied.
 */
export async function readProductBySlug(slug: string): Promise<ProductDetail> {
  const row = await prisma.product.findUnique({
    where: { slug },
    select: {
      id: true,
      sku: true,
      slug: true,
      name: true,
      description: true,
      unitPriceCents: true,
      leadTimeDays: true,
      imageUrl: true,
      updatedAt: true,
      category: { select: { name: true, slug: true } },
      inventoryLevels: {
        select: {
          productId: true,
          warehouseId: true,
          onHand: true,
          reserved: true,
          reorderPoint: true,
          warehouse: { select: { name: true } },
        },
        orderBy: { warehouse: { code: 'asc' } },
      },
    },
  });

  if (row === null) {
    throw new StorefrontNotFoundError('That product is not in the catalog.');
  }

  return {
    ...card(row),
    description: row.description,
    images: images(row.imageUrl, row.name),
    specs: specs(row.sku, row.category.name, row.leadTimeDays, row.inventoryLevels.length),
    leadTimeDays: row.leadTimeDays,
    availability: availability(row.inventoryLevels),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Every category the catalog is divided into, with the number of products each
 * one currently merchandises.
 *
 * The counts come from the same condition the listing runs under, so a chip
 * claiming a count and the page it leads to agree. The search term is part of
 * that condition: a chip is offered *within* the listing a reader is looking
 * at, so under `?search=wrench` it counts the wrench products in its category
 * rather than everything the category holds - otherwise a chip advertising
 * thirty-four products leads to another empty result, and the count line and
 * the chip row contradict each other on the same screen.
 *
 * The category filter is deliberately *not* part of it. Each chip counts within
 * its own category, which is what {@link filters} applies no category for: a
 * per-category count narrowed to the category already selected would leave
 * every other chip at zero and make the row unable to say where else the term
 * has matches.
 *
 * Categories are returned whether or not they hold products: the chips are a
 * stable set that neither reorders nor disappears as stock, listings and search
 * terms change, and a count of zero says so plainly. The order is by name, with
 * the unique slug as its final key so that two categories sharing a name could
 * not swap places between requests.
 *
 * @param search The term the listing is filtered by, or `undefined` for the
 * unfiltered catalog. A blank term narrows nothing, exactly as it does for the
 * listing.
 * @returns The categories in display order.
 */
export async function listCategoryOptions(search?: string): Promise<CategoryOption[]> {
  // One condition, built by the listing's own helper rather than restated here,
  // which is what keeps a chip's count and the page it leads to in agreement.
  // The term is spread in only when it holds a value: this workspace compiles
  // with `exactOptionalPropertyTypes`, under which an unconstrained filter is an
  // absent key rather than a key holding `undefined`.
  const counted = filters({ ...(search === undefined ? {} : { search }) });

  const rows = await prisma.category.findMany({
    select: {
      id: true,
      name: true,
      slug: true,
      _count: { select: { products: { where: counted } } },
    },
    orderBy: [{ name: 'asc' }, { slug: 'asc' }],
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    productCount: row._count.products,
  }));
}
