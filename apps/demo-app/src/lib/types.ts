/**
 * The data-transfer shapes the Lumen Supply storefront is built on.
 *
 * Every route handler response, every route handler request body and every
 * value that crosses the boundary from a server component into a client
 * component is described here, so the server layer, the route handlers, the
 * pages and the React tree all speak one vocabulary. The module declares types
 * and nothing else: it has no imports and no runtime code, which is what lets a
 * browser component and a database-backed service share it.
 *
 * Three conventions hold throughout, and they are why the shapes below do not
 * simply re-export the database models:
 *
 * 1. **Money is an integer number of US cents.** Every monetary field is a
 *    plain `number` whose name ends in `Cents`. Integer cents neither
 *    accumulate the rounding error a floating-point currency amount does nor
 *    need a decimal type to survive arithmetic.
 * 2. **Timestamps are ISO-8601 strings in UTC** — exactly what
 *    `Date.prototype.toISOString()` produces. Consumers render them with an
 *    explicitly pinned locale and time zone.
 * 3. **Nothing appears here that JSON cannot carry**: no `Date`, no `Decimal`,
 *    no `bigint`, no class instance. Those values are converted once, at the
 *    service boundary, because everything below is serialized on its way from
 *    a server component to a client component and from a route handler to the
 *    browser.
 */

/* ---------------------------------------------------------------------------
 * Unions
 * ------------------------------------------------------------------------- */

/** Lifecycle of an order, mirroring the `order_status` database enum. */
export type OrderStatus = 'PENDING' | 'PAID' | 'FULFILLED' | 'CANCELLED';

/** Why an inventory movement was recorded, mirroring the `movement_type` database enum. */
export type MovementType = 'RECEIPT' | 'SHIPMENT' | 'ADJUSTMENT' | 'TRANSFER' | 'RESERVATION';

/** Lifecycle of a cart, mirroring the `cart_status` database enum. */
export type CartStatus = 'ACTIVE' | 'CONVERTED' | 'ABANDONED';

/**
 * How freely a product can be sold right now.
 *
 * It is a presentation state the server derives from the stock on hand, the
 * units already promised and the product's reorder point — not a stored column.
 * The product stock badge and the dashboard's low-stock list both read it so
 * neither has to re-apply a threshold of its own.
 */
export type StockState = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';

/** Orderings the catalog listing accepts; `featured` is the server's default. */
export type CatalogSort = 'featured' | 'price_asc' | 'price_desc' | 'name_asc';

/**
 * The machine-readable failure reason carried by {@link StorefrontErrorBody}.
 *
 * `NETWORK_FAILURE` and `MALFORMED_RESPONSE` are produced only by the browser
 * client — the request never reached the server, or the response was not the
 * JSON the caller expected — and a route handler never returns either.
 */
export type StorefrontErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'OUT_OF_STOCK'
  | 'CART_CONFLICT'
  | 'PAYMENT_DECLINED'
  | 'INTERNAL_ERROR'
  | 'NETWORK_FAILURE'
  | 'MALFORMED_RESPONSE';

/* ---------------------------------------------------------------------------
 * Envelopes and errors
 * ------------------------------------------------------------------------- */

/**
 * One page of a listing response.
 *
 * `page` is 1-based, and `total` counts every row the filter matched rather than
 * the rows in `items`, so a caller can size a pager without a second request.
 */
export type PagedList<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

/**
 * The body a route handler returns when it fails, and the body the browser
 * client parses to build an error state.
 *
 * `details` is the one deliberately unshaped value in this module: a validation
 * failure attaches the field paths it rejected, and a consumer must narrow the
 * value before reading it instead of trusting a shape the server may widen.
 */
export interface StorefrontErrorBody {
  error: {
    code: StorefrontErrorCode;
    message: string;
    details?: unknown;
  };
}

/* ---------------------------------------------------------------------------
 * Catalog
 * ------------------------------------------------------------------------- */

/** A category as the catalog's filter chips list it. */
export interface CategoryOption {
  id: string;
  name: string;
  slug: string;
  productCount: number;
}

/** An image together with the alternative text a screen reader announces for it. */
export interface ProductImage {
  url: string;
  alt: string;
}

/** One labelled row of a product's specification table. */
export interface ProductSpec {
  label: string;
  value: string;
}

/**
 * A product as a catalog card presents it: enough to price it, badge its stock
 * and link to its detail page, and deliberately nothing more.
 */
export interface ProductSummary {
  id: string;
  sku: string;
  slug: string;
  name: string;
  categoryName: string;
  categorySlug: string;
  /** What the customer pays today, in cents. */
  priceCents: number;
  /** The undiscounted price in cents, or `null` when the product is not discounted. */
  listPriceCents: number | null;
  imageUrl: string | null;
  stockState: StockState;
  /** Units available to promise, summed across every warehouse. */
  availableQuantity: number;
}

/**
 * A product as its detail page presents it: the catalog payload plus the copy,
 * the media, the specification rows and the per-warehouse stock behind the
 * badge.
 */
export interface ProductDetail extends ProductSummary {
  description: string;
  images: ProductImage[];
  specs: ProductSpec[];
  /** Business days between an order being placed and the product being dispatched. */
  leadTimeDays: number;
  /** Stock per warehouse; see {@link InventoryLevelRow}. */
  availability: InventoryLevelRow[];
  updatedAt: string;
}

/**
 * The query parameters the catalog listing accepts.
 *
 * Every field is optional, and a caller omits the ones it does not constrain:
 * this workspace compiles with `exactOptionalPropertyTypes`, so an unconstrained
 * parameter is an absent key rather than a key holding `undefined`.
 */
export interface CatalogQuery {
  categorySlug?: string;
  search?: string;
  sort?: CatalogSort;
  /** 1-based page number; the server applies its default when omitted. */
  page?: number;
  pageSize?: number;
}

/* ---------------------------------------------------------------------------
 * Inventory
 * ------------------------------------------------------------------------- */

/** A stocking location, as the dashboard's warehouse filter lists it. */
export interface WarehouseSummary {
  id: string;
  code: string;
  name: string;
  region: string;
}

/**
 * Stock for one product at one warehouse.
 *
 * `available` is `onHand - reserved`: reserved units are still on the shelf but
 * already promised to an order, so only the available ones may be sold again.
 */
export interface InventoryLevelRow {
  warehouseId: string;
  warehouseName: string;
  productId: string;
  onHand: number;
  reserved: number;
  available: number;
}

/**
 * One recorded change to stock, in the columns the movements table keeps.
 *
 * `quantityDelta` is signed — a receipt adds units and a shipment removes them —
 * and `reference` names the document behind the movement when there is one.
 */
export interface InventoryMovementRow {
  id: string;
  productId: string;
  warehouseId: string;
  quantityDelta: number;
  movementType: MovementType;
  reference: string | null;
  createdAt: string;
}

/** A product sitting at or below its reorder point at one warehouse. */
export interface LowStockRow {
  productId: string;
  sku: string;
  productName: string;
  warehouseName: string;
  available: number;
  reorderPoint: number;
}

/**
 * The inventory dashboard's payload: totals across every warehouse, the
 * warehouses themselves and the rows the low-stock list renders.
 *
 * `movementVolume` is the units the recorded stock changes account for, counting
 * a receipt and a shipment alike as the units they moved. It reads as
 * throughput rather than as a balance, which is why it is far larger than
 * `totalOnHand` and why nothing is subtracted from it.
 *
 * `generatedAt` is the instant the server computed the totals, which the page
 * prints so a reader can tell how current the figures are.
 */
export interface InventorySummary {
  totalSkus: number;
  totalOnHand: number;
  totalReserved: number;
  lowStockCount: number;
  movementVolume: number;
  warehouses: WarehouseSummary[];
  lowStock: LowStockRow[];
  generatedAt: string;
}

/* ---------------------------------------------------------------------------
 * Cart
 * ------------------------------------------------------------------------- */

/**
 * One line of a cart.
 *
 * `unitPriceCents` is the price the line was captured at, and `lineTotalCents`
 * is that price taken `quantity` times. Both are computed by the server, so no
 * consumer multiplies money of its own.
 */
export interface CartLine {
  id: string;
  productId: string;
  sku: string;
  slug: string;
  name: string;
  imageUrl: string | null;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

/**
 * A cart as every consumer reads it.
 *
 * The contents are `lines`, which reads the same in the cart drawer, the header
 * badge and the checkout summary; `itemCount` is the quantity summed across
 * those lines rather than the number of lines.
 */
export interface CartView {
  id: string;
  status: CartStatus;
  lines: CartLine[];
  itemCount: number;
  subtotalCents: number;
  updatedAt: string;
}

/** The request body that puts a quantity of one product into the cart. */
export interface CartItemDraft {
  productId: string;
  quantity: number;
}

/**
 * The request body that sets one line of the cart to an exact quantity.
 *
 * `lineId` is the {@link CartLine.id} the server published rather than a
 * product identifier: a cart holds one line per product, and a line is the
 * thing a shopper changes the quantity of.
 *
 * `quantity` is the number of units the line holds afterwards, not a delta, so
 * the same request applied twice leaves the cart where one application left it.
 * It is at least one unit, because a line of nothing is a line that is gone and
 * removing one is {@link CartLineRemoval}'s job.
 */
export interface CartLineQuantityDraft {
  lineId: string;
  quantity: number;
}

/** The request body that takes one line, named by its {@link CartLine.id}, out of the cart. */
export interface CartLineRemoval {
  lineId: string;
}

/**
 * Every change `POST /api/cart/items` accepts, tagged by the change being asked
 * for.
 *
 * The four members are the cart's whole write surface: add units of a product,
 * set a line to a quantity, take one line out, and take every line out. They
 * share one endpoint because a cart's contents are one resource, and each of
 * them is answered with the same authoritative {@link CartView} — so a browser
 * that changed the cart never has to work out what the cart now holds, and the
 * prices and totals it displays remain the server's.
 *
 * `operation` is a literal on every member, which makes the union
 * discriminated: a body that omits the tag or invents a value is refused by the
 * endpoint's schema instead of being treated as some other change, and the
 * server switches on a value the compiler has already narrowed to one shape.
 */
export type CartMutation =
  | ({ operation: 'add' } & CartItemDraft)
  | ({ operation: 'set' } & CartLineQuantityDraft)
  | ({ operation: 'remove' } & CartLineRemoval)
  | { operation: 'empty' };

/* ---------------------------------------------------------------------------
 * Checkout and orders
 * ------------------------------------------------------------------------- */

/**
 * The request body that turns the cart into an order.
 *
 * It carries no cart identifier on purpose: the cart belongs to the browser's
 * own session and the server resolves it from the storefront's cookie, so a
 * caller can neither name nor guess somebody else's. `shippingOptionId` echoes
 * back the {@link ShippingOption} the customer chose, and `notes` is `null`
 * when they left the field empty.
 */
export interface CheckoutDraft {
  contact: CustomerContact;
  shippingAddress: ShippingAddress;
  shippingOptionId: string;
  notes: string | null;
}

/** One line of a placed order, priced as it stood when the order was placed. */
export interface OrderLine {
  id: string;
  productId: string;
  sku: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

/**
 * An order as the order list renders it.
 *
 * The breakdown reconciles:
 * `subtotalCents - discountCents + shippingCents + taxCents === totalCents`.
 */
export interface OrderSummary {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  placedAt: string;
  itemCount: number;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
}

/**
 * An order as the confirmation screen and the order detail view render it: the
 * list payload plus its lines, the service it ships by and where it ships to.
 *
 * `shippingOption` is `null` for an order whose chosen service was not recorded.
 */
export interface OrderDetail extends OrderSummary {
  lines: OrderLine[];
  shippingOption: ShippingOption | null;
  contact: CustomerContact;
  shippingAddress: ShippingAddress;
}

/** The response body of a completed checkout: the order created and how its payment resolved. */
export interface CheckoutResult {
  order: OrderDetail;
  payment: PaymentAuthorization;
}

/* ---------------------------------------------------------------------------
 * Shipping and payment
 * ------------------------------------------------------------------------- */

/**
 * A destination address. `line2` holds `null` rather than being absent when the
 * customer leaves it blank, so the shape is the same on the way in and out.
 */
export interface ShippingAddress {
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

/** Who is buying. `company` is `null` for a customer purchasing as an individual. */
export interface CustomerContact {
  name: string;
  email: string;
  company: string | null;
}

/**
 * One shipping service offered at checkout.
 *
 * `id` is what {@link CheckoutDraft} sends back, `label` is the wording the
 * picker shows, and `estimatedDays` is transit time in business days.
 */
export interface ShippingOption {
  id: string;
  carrier: string;
  service: string;
  label: string;
  priceCents: number;
  estimatedDays: number;
}

/**
 * The response body of a shipping quote.
 *
 * The name ends in `Result` so a server module can hold it beside the persisted
 * quote model without having to alias either name.
 *
 * `id` names the quote the store recorded for the service it offered, so a
 * checkout can put the order it places on the very quote its customer chose
 * rather than on whichever quote was taken most recently. It is `null` only
 * when nothing was on offer and there was therefore no rate to record.
 */
export interface ShippingQuoteResult {
  id: string | null;
  options: ShippingOption[];
  destinationPostalCode: string;
  quotedAt: string;
}

/**
 * How the payment behind a checkout resolved.
 *
 * `reference` is the processor's identifier for the attempt, and `declineReason`
 * carries the wording to show the customer when `authorized` is `false`; it is
 * `null` on an approval.
 */
export interface PaymentAuthorization {
  authorized: boolean;
  reference: string;
  amountCents: number;
  processedAt: string;
  declineReason: string | null;
}

/* ---------------------------------------------------------------------------
 * Recommendations
 * ------------------------------------------------------------------------- */

/**
 * One product suggested alongside another. `reason` is the short human wording
 * the rail prints beneath the tile to say why it is being suggested.
 */
export interface RecommendationItem {
  productId: string;
  sku: string;
  slug: string;
  name: string;
  priceCents: number;
  imageUrl: string | null;
  reason: string;
}
