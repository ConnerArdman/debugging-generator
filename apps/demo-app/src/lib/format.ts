/**
 * Lumen Supply - the strings the storefront prints.
 *
 * Every formatter here pins its locale, currency and time zone explicitly and takes any instant it
 * needs as an argument, so the same input produces the same text in a server component and in the
 * browser. Nothing below reads the ambient locale, the ambient time zone or a clock.
 */

import type { CartStatus, MovementType, OrderStatus, StockState } from './types';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------- */

/** The locale every formatter in this module is built with: `'en-US'`. */
export const STORE_LOCALE = 'en-US';

/** The currency every `…Cents` field of `./types` is denominated in: `'USD'`. */
export const STORE_CURRENCY = 'USD';

/** The time zone every date is rendered in, matching the UTC timestamps the server sends. */
export const STORE_TIME_ZONE = 'UTC';

/** Printed where a value is missing or unreadable, so a row shows `—` rather than `NaN`. */
const MISSING_VALUE_LABEL = '—';

// Formatter instances are immutable and fully pinned by their options, so each is built once and
// shared. Constructing one is the only work this module does at module scope.

const PRICE_FORMAT = new Intl.NumberFormat(STORE_LOCALE, {
  style: 'currency',
  currency: STORE_CURRENCY,
});

const QUANTITY_FORMAT = new Intl.NumberFormat(STORE_LOCALE, { maximumFractionDigits: 0 });

const DISCOUNT_FORMAT = new Intl.NumberFormat(STORE_LOCALE, {
  style: 'percent',
  maximumFractionDigits: 0,
});

const ORDER_DATE_FORMAT = new Intl.DateTimeFormat(STORE_LOCALE, {
  timeZone: STORE_TIME_ZONE,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const ORDER_DATE_TIME_FORMAT = new Intl.DateTimeFormat(STORE_LOCALE, {
  timeZone: STORE_TIME_ZONE,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

const TIME_AGO_FORMAT = new Intl.RelativeTimeFormat(STORE_LOCALE, { numeric: 'auto' });

/* ---------------------------------------------------------------------------
 * Money, quantities and percentages
 * ------------------------------------------------------------------------- */

/** Formats an integer count of US cents: `129900` -> `'$1,299.00'`. */
export function formatPriceLabel(cents: number): string {
  if (!Number.isFinite(cents)) {
    return MISSING_VALUE_LABEL;
  }

  return PRICE_FORMAT.format(cents / 100);
}

/** Formats a whole number of units with digit grouping: `200000` -> `'200,000'`. */
export function formatQuantityLabel(value: number): string {
  if (!Number.isFinite(value)) {
    return MISSING_VALUE_LABEL;
  }

  return QUANTITY_FORMAT.format(value);
}

/**
 * Formats a discount given as a fraction of the list price - not a percentage and not a pair of
 * prices, so a caller holding `listPriceCents` and `priceCents` divides first: `0.15` -> `'15%'`.
 */
export function formatDiscountLabel(fraction: number): string {
  if (!Number.isFinite(fraction)) {
    return MISSING_VALUE_LABEL;
  }

  return DISCOUNT_FORMAT.format(fraction);
}

/* ---------------------------------------------------------------------------
 * Dates
 * ------------------------------------------------------------------------- */

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_WEEK = 7 * MS_PER_DAY;
const MS_PER_MONTH = 30 * MS_PER_DAY;
const MS_PER_YEAR = 365 * MS_PER_DAY;

/**
 * ISO-8601 calendar date, optionally with a time and a UTC offset - the shape
 * `Date.prototype.toISOString()` produces, which is what `./types` documents its timestamps as.
 * Only this shape is parsed, because ECMAScript specifies how it is read while everything else is
 * left to the engine.
 */
const ISO_TIMESTAMP_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/** One rung of the relative-time ladder: the span it covers and the unit it counts in. */
interface RelativeTimeRung {
  readonly ceiling: number;
  readonly span: number;
  readonly unit: Intl.RelativeTimeFormatUnit;
}

const RELATIVE_TIME_RUNGS: readonly RelativeTimeRung[] = [
  { ceiling: MS_PER_MINUTE, span: MS_PER_SECOND, unit: 'second' },
  { ceiling: MS_PER_HOUR, span: MS_PER_MINUTE, unit: 'minute' },
  { ceiling: MS_PER_DAY, span: MS_PER_HOUR, unit: 'hour' },
  { ceiling: MS_PER_WEEK, span: MS_PER_DAY, unit: 'day' },
  { ceiling: MS_PER_MONTH, span: MS_PER_WEEK, unit: 'week' },
  { ceiling: MS_PER_YEAR, span: MS_PER_MONTH, unit: 'month' },
];

/** Anything a year or more away is counted in years. */
const RELATIVE_TIME_TOP_RUNG: RelativeTimeRung = {
  ceiling: Number.POSITIVE_INFINITY,
  span: MS_PER_YEAR,
  unit: 'year',
};

/**
 * Milliseconds since the epoch for an ISO-8601 timestamp, or `null` when the string is not one.
 *
 * The calendar fields are checked against the instant they parsed to, so a date that does not exist
 * is rejected here instead of being silently rolled forward into the next month.
 */
function parseInstant(value: string): number | null {
  const fields = ISO_TIMESTAMP_PATTERN.exec(value)?.groups;

  if (fields === undefined) {
    return null;
  }

  const year = Number(fields.year);
  const month = Number(fields.month) - 1;
  const day = Number(fields.day);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  // `Date.UTC` rolls an out-of-range field forward - the 31st of February becomes the 3rd of
  // March - so the fields are compared back against the instant they produced.
  const midnight = new Date(Date.UTC(year, month, day));

  if (
    midnight.getUTCFullYear() !== year ||
    midnight.getUTCMonth() !== month ||
    midnight.getUTCDate() !== day
  ) {
    return null;
  }

  const instant = Date.parse(value);

  return Number.isNaN(instant) ? null : instant;
}

/** Formats an ISO-8601 timestamp as a date in the store's time zone: `'Mar 14, 2026'`. */
export function formatOrderDate(iso: string): string {
  const instant = parseInstant(iso);

  return instant === null ? MISSING_VALUE_LABEL : ORDER_DATE_FORMAT.format(instant);
}

/** Formats an ISO-8601 timestamp as a date and time: `'Mar 14, 2026, 11:30 PM UTC'`. */
export function formatOrderDateTime(iso: string): string {
  const instant = parseInstant(iso);

  return instant === null ? MISSING_VALUE_LABEL : ORDER_DATE_TIME_FORMAT.format(instant);
}

/**
 * Formats `iso` relative to `referenceIso` in the largest sensible unit: `'3 days ago'`,
 * `'yesterday'`, `'in 2 hours'`.
 *
 * The reference instant is a parameter rather than the current time on purpose: the caller supplies
 * a stable one - a timestamp computed on the server and passed as a prop, or a value a client
 * component captures in state after it mounts - so both renders of a page agree on the wording.
 */
export function formatTimeAgoLabel(iso: string, referenceIso: string): string {
  const instant = parseInstant(iso);
  const reference = parseInstant(referenceIso);

  if (instant === null || reference === null) {
    return MISSING_VALUE_LABEL;
  }

  const elapsed = instant - reference;
  const distance = Math.abs(elapsed);
  const rung =
    RELATIVE_TIME_RUNGS.find((candidate) => distance < candidate.ceiling) ?? RELATIVE_TIME_TOP_RUNG;

  return TIME_AGO_FORMAT.format(Math.round(elapsed / rung.span), rung.unit);
}

/* ---------------------------------------------------------------------------
 * Domain labels
 * ------------------------------------------------------------------------- */

// A `Record` keyed by the union is exhaustive by construction - the compiler rejects a missing
// key - and reading it with a union value yields `string` rather than `string | undefined`.

const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  PENDING: 'Pending',
  PAID: 'Paid',
  FULFILLED: 'Fulfilled',
  CANCELLED: 'Cancelled',
};

const MOVEMENT_TYPE_LABELS: Record<MovementType, string> = {
  RECEIPT: 'Receipt',
  SHIPMENT: 'Shipment',
  ADJUSTMENT: 'Adjustment',
  TRANSFER: 'Transfer',
  RESERVATION: 'Reservation',
};

const CART_STATUS_LABELS: Record<CartStatus, string> = {
  ACTIVE: 'Active',
  CONVERTED: 'Converted',
  ABANDONED: 'Abandoned',
};

const STOCK_STATE_LABELS: Record<StockState, string> = {
  IN_STOCK: 'In stock',
  LOW_STOCK: 'Low stock',
  OUT_OF_STOCK: 'Out of stock',
};

/** Names an order's lifecycle state for a reader: `'FULFILLED'` -> `'Fulfilled'`. */
export function formatOrderStatusLabel(status: OrderStatus): string {
  return ORDER_STATUS_LABELS[status];
}

/** Names why stock moved: `'ADJUSTMENT'` -> `'Adjustment'`. */
export function formatMovementTypeLabel(type: MovementType): string {
  return MOVEMENT_TYPE_LABELS[type];
}

/** Names a cart's lifecycle state: `'ACTIVE'` -> `'Active'`. */
export function formatCartStatusLabel(status: CartStatus): string {
  return CART_STATUS_LABELS[status];
}

/**
 * Wording for a stock badge, with the units available to promise: `('IN_STOCK', 128)` ->
 * `'In stock (128)'`. Nothing sellable is left to count when the state is `'OUT_OF_STOCK'`, so that
 * label carries no number.
 */
export function formatStockLabel(state: StockState, available: number): string {
  const label = STOCK_STATE_LABELS[state];

  if (state === 'OUT_OF_STOCK') {
    return label;
  }

  return `${label} (${formatQuantityLabel(available)})`;
}

/**
 * Wording for a `ShippingOption.estimatedDays` transit time in business days: `2` ->
 * `'Arrives in 2 days'`, `1` -> `'Arrives tomorrow'`, `0` -> `'Arrives today'`.
 */
export function formatShippingEtaLabel(days: number): string {
  if (!Number.isFinite(days)) {
    return MISSING_VALUE_LABEL;
  }

  const rounded = Math.round(days);

  if (rounded <= 0) {
    return 'Arrives today';
  }

  if (rounded === 1) {
    return 'Arrives tomorrow';
  }

  return `Arrives in ${formatQuantityLabel(rounded)} days`;
}

/* ---------------------------------------------------------------------------
 * Identifiers
 * ------------------------------------------------------------------------- */

/** Normalises a stock-keeping unit for display: `' fstn-00001 '` -> `'FSTN-00001'`. */
export function formatSkuLabel(sku: string): string {
  return sku.trim().toUpperCase();
}

/**
 * Turns a URL slug into words for a breadcrumb or a chip: `'hex-head-bolts'` ->
 * `'Hex Head Bolts'`.
 */
export function formatSlugLabel(slug: string): string {
  return slug
    .split('-')
    .filter((word) => word.length > 0)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(' ');
}
