/**
 * Seed data for "Lumen Supply", the B2B industrial-supply storefront in this
 * workspace.
 *
 * Run it with `pnpm demo:seed` from the repository root, or `pnpm seed` inside
 * apps/demo-app. Both go through `prisma db seed`, which executes
 * `tsx prisma/seed.ts` with the working directory set to this workspace, so the
 * optional `.env` next to package.json is the one Node's environment loader
 * picks up and the single relative import below resolves from prisma/.
 * `DATABASE_URL` must address a database whose schema is already in place:
 * `pnpm demo:db` starts PostgreSQL and `pnpm demo:migrate` applies the schema.
 *
 * Three properties of this script matter as much as the data it writes.
 *
 *   Determinism. Every value comes from one fixed pseudo-random sequence and
 *   from one timestamp anchor, `SEED_NOW` (UTC midnight of the current day).
 *   Two runs on the same day therefore produce byte-identical rows, and runs on
 *   different machines agree. Nothing here reads the platform random source or
 *   the wall clock beyond that anchor, which is also what keeps the catalog and
 *   the dashboard looking freshly stocked rather than frozen in the past.
 *
 *   Re-runnability. The load begins by truncating all twelve tables in one
 *   statement, so it can be repeated as often as wanted without accumulating
 *   rows, without row-wise deletes and without touching the working tree: this
 *   script writes no files and creates no directories.
 *
 *   Bounded statements and bounded memory. PostgreSQL's wire protocol accepts
 *   at most 65 535 bound parameters per statement, so every insert is chunked
 *   to a row count derived from that table's column count (see
 *   `rowsPerStatement`), and the inventory ledger — by far the largest table —
 *   is generated one chunk at a time instead of being materialised in full.
 *
 * The client is constructed the way the application constructs it in
 * src/server/db: one `pg.Pool`, wrapped by `PrismaPg`. The handful of raw
 * statements this script needs (the reset, `ANALYZE`, the closing row-count
 * report) run through that same pool.
 */

import { performance } from 'node:perf_hooks';

import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

import type { Prisma } from '../src/generated/prisma/client';
import {
  CartStatus,
  MovementType,
  OrderStatus,
  PrismaClient,
} from '../src/generated/prisma/client';

/**
 * A `createMany` row whose primary key this script assigned itself.
 *
 * Ids are minted in process (see `mint`) rather than left to the schema's
 * `@default(cuid())`, so a parent row's id is known before it is written and
 * every relation below is wired in memory — the whole load needs no read-back
 * round trip. The generated create inputs declare `id` as optional, which would
 * otherwise make each id `string | undefined` at the point where a child row
 * references it.
 */
type WithAssignedId<T> = T & { id: string };

// ---------------------------------------------------------------------------
// Deterministic pseudo-randomness
// ---------------------------------------------------------------------------

/**
 * Seed of the pseudo-random sequence. Any fixed 32-bit value works; this one is
 * arbitrary and must never change, because changing it rewrites every generated
 * value and invalidates any expectation recorded against this data set.
 */
const RANDOM_SEED = 0x5c1d27f3;

/** Alphabet of the minted ids: the base36 range a cuid also draws from. */
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Characters after the leading `c`, which makes a minted id cuid-shaped. */
const ID_LENGTH = 24;

/** Current state of the sequence. Advanced by `random` and by nothing else. */
let randomState = RANDOM_SEED;

/**
 * The next value of the sequence, in `[0, 1)` — a mulberry32 generator, chosen
 * because it is six lines of arithmetic, needs no dependency and is stable
 * across platforms (every step stays inside 32-bit integer operations).
 *
 * This is the only source of randomness in the file; the platform's own random
 * source is never consulted, so the data cannot vary between runs.
 */
function random(): number {
  randomState = (randomState + 0x6d2b79f5) | 0;
  let mixed = randomState;
  mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
  mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
}

/**
 * A whole number in `[min, max]`, both ends included.
 *
 * @throws When the range is empty, which is always a mistake in the caller.
 */
function between(min: number, max: number): number {
  if (max < min) {
    throw new Error(`between() needs min <= max, received ${String(min)}..${String(max)}`);
  }
  return min + Math.floor(random() * (max - min + 1));
}

/** Whether the next draw falls under `probability`, expressed in `[0, 1]`. */
function chance(probability: number): boolean {
  return random() < probability;
}

/**
 * One element of `items`, drawn uniformly.
 *
 * The explicit check is what lets the rest of the file read indexed values
 * without a non-null assertion under `noUncheckedIndexedAccess`.
 *
 * @throws When `items` is empty.
 */
function pick<T>(items: readonly T[]): T {
  const value = items[Math.floor(random() * items.length)];
  if (value === undefined) {
    throw new Error('pick() requires a non-empty array');
  }
  return value;
}

/**
 * The element at `index`, wrapping around the end of `items`.
 *
 * Used where a value has to vary predictably rather than randomly — product
 * names, for instance, walk their category's word lists by index so that no two
 * products in a category end up with the same name.
 *
 * @throws When `items` is empty.
 */
function entry<T>(items: readonly T[], index: number): T {
  const value = items[index % items.length];
  if (value === undefined) {
    throw new Error('entry() requires a non-empty array');
  }
  return value;
}

/**
 * `count` distinct elements of `items` (or all of them, when `items` is
 * shorter), drawn without replacement.
 *
 * Distinctness is what the composite unique keys on cart lines require, so the
 * draw retries on a repeat rather than deduplicating afterwards. The attempt
 * ceiling only exists so that a caller mistake can never spin forever.
 *
 * @throws When the ceiling is reached.
 */
function sample<T>(items: readonly T[], count: number): T[] {
  const wanted = Math.min(count, items.length);
  const taken = new Set<number>();
  const chosen: T[] = [];
  let attempts = 0;
  const ceiling = 1000 + wanted * 200;

  while (chosen.length < wanted) {
    attempts += 1;
    if (attempts > ceiling) {
      throw new Error(`sample() could not draw ${String(wanted)} distinct elements`);
    }
    const index = Math.floor(random() * items.length);
    if (taken.has(index)) {
      continue;
    }
    taken.add(index);
    chosen.push(entry(items, index));
  }

  return chosen;
}

/**
 * One value from a list of `[value, weight]` pairs, drawn in proportion to the
 * weights. Weights need not sum to one.
 *
 * @throws When no pair is supplied.
 */
function weighted<T>(pairs: readonly (readonly [T, number])[]): T {
  let total = 0;
  for (const [, weight] of pairs) {
    total += weight;
  }

  let remaining = random() * total;
  for (const [value, weight] of pairs) {
    remaining -= weight;
    if (remaining <= 0) {
      return value;
    }
  }

  const last = pairs[pairs.length - 1];
  if (last === undefined) {
    throw new Error('weighted() requires at least one pair');
  }
  return last[0];
}

/** A minted cuid-shaped opaque id: a leading `c` and 24 base36 characters. */
function mint(): string {
  let value = 'c';
  for (let index = 0; index < ID_LENGTH; index += 1) {
    value += ID_ALPHABET.charAt(Math.floor(random() * ID_ALPHABET.length));
  }
  return value;
}

/** A URL-safe slug: lowercase, non-alphanumeric runs collapsed to a hyphen. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Milliseconds in a day, the unit every generated offset is expressed in. */
const DAY_MS = 86_400_000;

/**
 * The single anchor every generated timestamp is measured back from: UTC
 * midnight of the current day.
 *
 * Taking the date — and nothing finer — from the clock is what reconciles the
 * two requirements on this data. Rows stay plausibly recent, so the catalog and
 * the dashboard do not look abandoned, while the run remains reproducible: two
 * runs on the same day agree byte for byte, and so do runs on two machines.
 */
const SEED_NOW = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);

/** The instant `ms` milliseconds before `SEED_NOW`. */
function before(ms: number): Date {
  return new Date(SEED_NOW.getTime() - ms);
}

/** The instant `ms` milliseconds after `SEED_NOW`. */
function after(ms: number): Date {
  return new Date(SEED_NOW.getTime() + ms);
}

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

/** Prefix on every line this script prints, so its output is greppable. */
const LOG_PREFIX = 'lumen-supply seed';

/** Writes one progress line. */
function log(message: string): void {
  console.log(`${LOG_PREFIX}: ${message}`);
}

/** Formats an elapsed `performance.now()` span for a progress line. */
function elapsed(since: number): string {
  const ms = performance.now() - since;
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${String(Math.round(ms))} ms`;
}

// ---------------------------------------------------------------------------
// Batched inserts
// ---------------------------------------------------------------------------

/**
 * Bound parameters allowed per statement. PostgreSQL's limit is 65 535; half of
 * it leaves room for the driver's own parameters and keeps each round trip
 * comfortably small.
 */
const PARAMETER_BUDGET = 30_000;

/** Chunks after which a long-running insert reports progress. */
const PROGRESS_INTERVAL = 10;

/**
 * Rows a single insert may carry for a table with `columns` columns, derived
 * from `PARAMETER_BUDGET` so no chunk can exceed the wire protocol's parameter
 * limit however wide the table is.
 */
function rowsPerStatement(columns: number): number {
  return Math.max(1, Math.floor(PARAMETER_BUDGET / columns));
}

/**
 * Writes `rows` through `insert` in chunks sized for the table's width, and
 * reports what landed.
 *
 * @param table Physical table name, used only in the progress line.
 * @param columns Number of columns each row binds.
 * @param rows Every row to write, in insertion order.
 * @param insert Performs one chunk, returning the row count the server applied.
 * @returns The total number of rows the server reported.
 */
async function insertSeedRows<T>(
  table: string,
  columns: number,
  rows: readonly T[],
  insert: (chunk: T[]) => Promise<{ count: number }>,
): Promise<number> {
  const started = performance.now();
  const size = rowsPerStatement(columns);
  let written = 0;
  let chunks = 0;

  for (let start = 0; start < rows.length; start += size) {
    const result = await insert(rows.slice(start, start + size));
    written += result.count;
    chunks += 1;
    if (chunks % PROGRESS_INTERVAL === 0 && start + size < rows.length) {
      log(`${table} ${String(written)}/${String(rows.length)} rows (${elapsed(started)})`);
    }
  }

  log(`${table} ${String(written)} rows (${elapsed(started)})`);
  return written;
}

// ---------------------------------------------------------------------------
// Catalog vocabulary
// ---------------------------------------------------------------------------

/**
 * The twelve categories the catalog is built from, each carrying the word lists
 * its products are named from.
 *
 * A product name is `modifier + noun + size`, and the three lists are walked by
 * index rather than drawn at random so that names stay distinct within a
 * category: five modifiers, six nouns and six sizes give 180 combinations for
 * the roughly 34 products each category receives.
 *
 * `tile` names the catalog artwork this category's products are shown with. The
 * committed artwork is a small set of shared category tiles under
 * `public/products/` rather than one drawing per stock-keeping unit, so each
 * category points at the tile whose subject matches it — fasteners at the bolt,
 * hydraulics and piping at the valve, electrical at the cable reel — and a
 * category whose subject none of them depicts takes `product-placeholder`, the
 * generic catalog tile the storefront falls back to.
 */
const CATEGORY_BLUEPRINTS = [
  {
    code: 'FST',
    name: 'Fasteners & Hardware',
    description:
      'Structural bolts, screws, anchors and hardware for assembly, repair and plant maintenance.',
    duty: 'general structural assembly',
    tile: 'fastener',
    modifiers: [
      'Zinc-Plated',
      'Stainless Steel',
      'Hot-Dip Galvanized',
      'Grade 8 Alloy',
      'Black Oxide',
    ],
    nouns: [
      'Hex Bolt',
      'Socket Cap Screw',
      'Flange Nut',
      'Wedge Anchor',
      'Threaded Rod',
      'Lock Washer',
    ],
    sizes: [
      'M6 x 25 mm',
      'M8 x 40 mm',
      'M10 x 60 mm',
      '1/4 in x 1 in',
      '3/8 in x 2 in',
      '1/2 in x 3 in',
    ],
  },
  {
    code: 'BRG',
    name: 'Bearings & Bushings',
    description: 'Rolling and sleeve bearings, mounted units and bushings for rotating equipment.',
    duty: 'continuous-duty rotating equipment',
    tile: 'product-placeholder',
    modifiers: ['Sealed', 'Open', 'Double-Row', 'Flanged', 'Self-Aligning'],
    nouns: [
      'Deep Groove Ball Bearing',
      'Tapered Roller Bearing',
      'Pillow Block Unit',
      'Bronze Sleeve Bushing',
      'Thrust Bearing',
      'Needle Roller Bearing',
    ],
    sizes: ['20 mm Bore', '25 mm Bore', '35 mm Bore', '50 mm Bore', '1 in Bore', '2 in Bore'],
  },
  {
    code: 'PWT',
    name: 'Power Transmission',
    description: 'Belts, chains, sprockets, couplings and gearing for mechanical drive trains.',
    duty: 'high-torque drive trains',
    tile: 'product-placeholder',
    modifiers: ['Heavy-Duty', 'Corrosion-Resistant', 'Precision-Ground', 'Hardened', 'Balanced'],
    nouns: [
      'V-Belt',
      'Roller Chain',
      'Taper-Lock Sprocket',
      'Jaw Coupling',
      'Timing Pulley',
      'Worm Gear Reducer',
    ],
    sizes: ['A-Section', 'B-Section', 'ANSI 40', 'ANSI 60', '14 mm Pitch', '20:1 Ratio'],
  },
  {
    code: 'HYD',
    name: 'Hydraulics & Pneumatics',
    description: 'Cylinders, hose, fittings and air preparation for fluid-power circuits.',
    duty: 'fluid-power circuits',
    tile: 'valve',
    modifiers: ['Double-Acting', 'Single-Acting', 'Stainless', 'High-Pressure', 'Compact'],
    nouns: [
      'Hydraulic Cylinder',
      'Pneumatic Actuator',
      'Hose Assembly',
      'Directional Valve',
      'Filter Regulator',
      'Quick-Disconnect Coupler',
    ],
    sizes: ['1.5 in Bore', '2 in Bore', '3/8 in NPT', '1/2 in NPT', '3000 psi', '5000 psi'],
  },
  {
    code: 'ELC',
    name: 'Electrical & Controls',
    description: 'Contactors, drives, sensors and enclosures for machine control panels.',
    duty: 'machine control panels',
    tile: 'cable-reel',
    modifiers: ['DIN-Rail', 'Panel-Mount', 'IP67-Rated', 'Three-Phase', 'Shielded'],
    nouns: [
      'Motor Contactor',
      'Variable Frequency Drive',
      'Inductive Proximity Sensor',
      'Safety Relay',
      'Terminal Block Kit',
      'Steel Enclosure',
    ],
    sizes: ['24 V DC', '120 V AC', '480 V AC', '5 hp', '15 hp', '12 x 10 x 6 in'],
  },
  {
    code: 'HND',
    name: 'Hand Tools',
    description: 'Wrenches, drivers, pliers and striking tools for maintenance crews.',
    duty: 'field maintenance work',
    tile: 'hand-tool',
    modifiers: ['Chrome-Vanadium', 'Insulated', 'Non-Sparking', 'Ratcheting', 'Cushion-Grip'],
    nouns: [
      'Combination Wrench',
      'Torque Wrench',
      'Locking Pliers',
      'Screwdriver Set',
      'Ball-Peen Hammer',
      'Hex Key Set',
    ],
    sizes: ['13 mm', '19 mm', '3/4 in', '10-150 Nm', '8-Piece', '10-Piece'],
  },
  {
    code: 'CUT',
    name: 'Cutting Tools',
    description: 'Drills, end mills, inserts and saw blades for machining and fabrication.',
    duty: 'machining and fabrication',
    tile: 'power-tool',
    modifiers: ['Cobalt', 'Carbide', 'TiAlN-Coated', 'High-Speed Steel', 'Diamond-Ground'],
    nouns: [
      'Jobber Drill Bit',
      'Square End Mill',
      'Turning Insert',
      'Bandsaw Blade',
      'Thread Mill',
      'Annular Cutter',
    ],
    sizes: ['6 mm', '10 mm', '1/4 in', '1/2 in', '93 in x 1 in', '14 TPI'],
  },
  {
    code: 'MHL',
    name: 'Material Handling',
    description: 'Casters, hoists, slings and storage for moving and staging inventory.',
    duty: 'plant material handling',
    tile: 'product-placeholder',
    modifiers: ['Swivel', 'Rigid', 'Powder-Coated', 'Load-Rated', 'Heavy-Gauge'],
    nouns: [
      'Polyurethane Caster',
      'Chain Hoist',
      'Round Sling',
      'Pallet Rack Beam',
      'Steel Shelving Unit',
      'Drum Lifter',
    ],
    sizes: ['4 in Wheel', '6 in Wheel', '1 Ton', '2 Ton', '96 in Span', '36 x 18 in'],
  },
  {
    code: 'SFT',
    name: 'Safety & PPE',
    description: 'Protective equipment, lockout hardware and spill control for regulated sites.',
    duty: 'regulated work sites',
    tile: 'safety-gear',
    modifiers: ['ANSI-Rated', 'Cut-Resistant', 'Flame-Resistant', 'High-Visibility', 'Dielectric'],
    nouns: [
      'Safety Glasses',
      'Work Glove',
      'Hard Hat',
      'Lockout Hasp Kit',
      'Absorbent Spill Pad',
      'Face Shield',
    ],
    sizes: ['Universal', 'Medium', 'Large', 'X-Large', '20-Pack', '100-Pack'],
  },
  {
    code: 'PVF',
    name: 'Pipe, Valves & Fittings',
    description: 'Pipe, tubing, valves and fittings for process and utility piping.',
    duty: 'process and utility piping',
    tile: 'valve',
    modifiers: ['Schedule 40', 'Schedule 80', 'Brass', '316 Stainless', 'Threaded'],
    nouns: [
      'Ball Valve',
      'Butterfly Valve',
      'Pipe Nipple',
      'Elbow Fitting',
      'Check Valve',
      'Compression Tee',
    ],
    sizes: ['1/2 in', '3/4 in', '1 in', '2 in', '3 in', '4 in'],
  },
  {
    code: 'ABR',
    name: 'Abrasives & Finishing',
    description: 'Wheels, discs, belts and compounds for grinding, blending and finishing.',
    duty: 'grinding and surface finishing',
    tile: 'product-placeholder',
    modifiers: ['Aluminium Oxide', 'Zirconia', 'Ceramic', 'Silicon Carbide', 'Non-Woven'],
    nouns: [
      'Grinding Wheel',
      'Flap Disc',
      'Sanding Belt',
      'Cut-Off Wheel',
      'Surface Conditioning Disc',
      'Polishing Compound',
    ],
    sizes: ['4.5 in', '7 in', '2 x 48 in', '60 Grit', '80 Grit', '120 Grit'],
  },
  {
    code: 'LUB',
    name: 'Lubricants & Chemicals',
    description: 'Greases, oils, cleaners and sealants for equipment upkeep.',
    duty: 'scheduled equipment upkeep',
    tile: 'product-placeholder',
    modifiers: ['Food-Grade', 'Synthetic', 'Lithium-Complex', 'Extreme-Pressure', 'Low-VOC'],
    nouns: [
      'Bearing Grease',
      'Gear Oil',
      'Chain Lubricant',
      'Parts Cleaner',
      'Thread Sealant',
      'Anti-Seize Compound',
    ],
    sizes: ['14 oz Cartridge', '1 gal', '5 gal', '55 gal Drum', '12 oz Aerosol', '250 ml Tube'],
  },
] as const;

/** The six distribution centres, one per region. */
const WAREHOUSE_BLUEPRINTS = [
  { code: 'ATL-01', name: 'Atlanta Distribution Center', region: 'Southeast' },
  { code: 'CHI-02', name: 'Chicago Distribution Center', region: 'Great Lakes' },
  { code: 'DFW-03', name: 'Dallas Fulfillment Center', region: 'South Central' },
  { code: 'DEN-04', name: 'Denver Fulfillment Center', region: 'Mountain West' },
  { code: 'NWK-05', name: 'Newark Distribution Center', region: 'Northeast' },
  { code: 'SEA-06', name: 'Seattle Fulfillment Center', region: 'Pacific Northwest' },
] as const;

/** First half of a customer's company name. */
const COMPANY_PREFIXES = [
  'Northshore',
  'Atlas',
  'Redline',
  'Cascade',
  'Granite',
  'Ironwood',
  'Meridian',
  'Pioneer',
  'Summit',
  'Harborview',
  'Copperfield',
  'Westbrook',
  'Lakeside',
  'Foundry',
  'Beacon',
  'Silverline',
  'Clearwater',
  'Brightworks',
  'Tallgrass',
  'Stonebridge',
] as const;

/** Second half of a customer's company name. */
const COMPANY_SUFFIXES = [
  'Mechanical',
  'Fabrication',
  'Industrial Supply',
  'Manufacturing',
  'Engineering',
  'Logistics',
  'Contracting',
  'Maintenance',
  'Machine Works',
  'Utilities',
] as const;

/** Given names of the buying contacts. */
const CONTACT_GIVEN_NAMES = [
  'Dana',
  'Marcus',
  'Priya',
  'Elena',
  'Tobias',
  'Ingrid',
  'Rafael',
  'Naomi',
  'Cormac',
  'Yusuf',
  'Greta',
  'Desmond',
  'Lucia',
  'Anton',
  'Simone',
  'Hector',
  'Freya',
  'Omar',
  'Beatrix',
  'Callum',
] as const;

/** Family names of the buying contacts. */
const CONTACT_FAMILY_NAMES = [
  'Whitfield',
  'Okafor',
  'Larsen',
  'Navarro',
  'Brennan',
  'Kowalski',
  'Ferreira',
  'Halloran',
  'Nakamura',
  'Delgado',
] as const;

/** Carrier codes the shipping quotes are attributed to. */
const CARRIER_CODES = ['NLEX', 'RVCF', 'ATLW', 'PCFL'] as const;

/**
 * The service levels a quote can offer, with the transit time and price band
 * each one implies, so `etaDays` and `amountCents` stay consistent with the
 * level named on the row.
 */
const SERVICE_LEVELS = [
  { level: 'GROUND', etaMin: 3, etaMax: 7, minCents: 1_200, maxCents: 3_800, weight: 50 },
  { level: 'TWO_DAY', etaMin: 2, etaMax: 2, minCents: 4_200, maxCents: 9_500, weight: 25 },
  { level: 'OVERNIGHT', etaMin: 1, etaMax: 1, minCents: 11_000, maxCents: 24_000, weight: 10 },
  { level: 'LTL_FREIGHT', etaMin: 5, etaMax: 12, minCents: 18_000, maxCents: 65_000, weight: 15 },
] as const;

/** Document-reference prefix per movement type, as a warehouse system uses. */
const MOVEMENT_REFERENCE_PREFIXES = {
  RECEIPT: 'PO',
  SHIPMENT: 'SO',
  ADJUSTMENT: 'ADJ',
  TRANSFER: 'TRF',
  RESERVATION: 'RSV',
} as const;

/**
 * How often each movement type occurs. Goods arriving and shipping out account
 * for most of the ledger; corrections, inter-warehouse transfers and
 * reservations are the long tail.
 */
const MOVEMENT_TYPE_WEIGHTS = [
  [MovementType.SHIPMENT, 50],
  [MovementType.RECEIPT, 28],
  [MovementType.ADJUSTMENT, 9],
  [MovementType.TRANSFER, 8],
  [MovementType.RESERVATION, 5],
] as const satisfies readonly (readonly [MovementType, number])[];

/** Minimum-quantity tiers a price rule can be written against. */
const QUANTITY_TIERS = [1, 5, 10, 25, 50] as const;

/**
 * Discount band per quantity tier, in basis points. Index matches
 * `QUANTITY_TIERS`, so a larger commitment always earns at least as much as a
 * smaller one.
 */
const TIER_DISCOUNT_BANDS = [
  { min: 100, max: 300 },
  { min: 350, max: 700 },
  { min: 750, max: 1_200 },
  { min: 1_300, max: 1_900 },
  { min: 1_950, max: 2_500 },
] as const;

// ---------------------------------------------------------------------------
// Volumes
// ---------------------------------------------------------------------------

/** Products in the catalog, spread evenly across the twelve categories. */
const PRODUCT_COUNT = 400;

/** Ledger rows per product, giving a 200 000-row inventory movement history. */
const MOVEMENTS_PER_PRODUCT = 500;

/** Days of movement history behind `SEED_NOW`: roughly eighteen months. */
const MOVEMENT_HISTORY_DAYS = 547;

/**
 * Share of products that carry their own tier ladder of price rules. With one
 * rule per quantity tier this is what sets the size of the price_rules table,
 * and with it how much work resolving a price for a cart line represents.
 */
const TIERED_PRICING_SHARE = 0.44;

/** Price rules that apply to every product regardless of category. */
const GLOBAL_PRICE_RULE_COUNT = 4;

/** Customer accounts. */
const CUSTOMER_COUNT = 40;

/** Carts in total, across all three statuses. */
const CART_COUNT = 60;

/** Carts left in the `ACTIVE` state, the seeded demo cart included. */
const ACTIVE_CART_COUNT = 5;

/** Lines on the seeded demo cart. */
const DEMO_CART_LINE_COUNT = 12;

/**
 * Session token of the one cart a developer can rely on finding populated. It
 * is a fixed, readable value rather than a minted one precisely so that the
 * storefront and the end-to-end helpers can address that cart directly.
 */
const DEMO_CART_TOKEN = 'lumen-supply-demo-cart';

/**
 * The account the storefront shops as: the first customer written, the one the
 * demo cart is attached to, and the one whose order history `/orders` lists
 * when the address bar names no account.
 *
 * Its contact details are the buyer the checkout form opens on, so the three
 * surfaces agree about who is shopping across a freshly seeded database: the
 * cart belongs to this account, an order placed from it is filed under this
 * account, and the history the storefront shows is this account's - including
 * the order just placed. Without that agreement an order would be filed under
 * an account resolved from the typed email address, which no seeded customer
 * owns, and would be missing from the only history the storefront links to.
 *
 * The values are duplicated from `app/checkout/page.tsx` rather than shared
 * with it, exactly as {@link DEMO_CART_TOKEN} is duplicated from
 * `@/server/validation/cart` and `@/server/services/checkout.service`: this
 * file is a script the Prisma CLI runs, nothing under `app/` or `src/` may
 * import from it, and a readable literal is a cheaper thing to keep in step
 * than an import edge between a page and a seed script. They are openly
 * fictional - a reserved `.example` domain and a street that names no real
 * receiving dock - for the reason that page states.
 */
const DEMO_ACCOUNT = {
  email: 'purchasing@northfield-fabrication.example',
  companyName: 'Northfield Fabrication',
  contactName: 'Dana Whitfield',
} as const;

/** Historical orders. */
const ORDER_COUNT = 300;

/** Days of order history behind `SEED_NOW`: one year. */
const ORDER_HISTORY_DAYS = 364;

/** Beyond this age an order has almost certainly reached its final state. */
const ORDER_SETTLED_AFTER_DAYS = 45;

/**
 * Price bands, as `[[minCents, maxCents], weight]`. Most of the catalog is
 * consumable hardware; a minority are capital items, which is what gives the
 * catalog its long price tail.
 */
const PRICE_BANDS: readonly (readonly [readonly [number, number], number])[] = [
  [[1_500, 25_000], 70],
  [[25_001, 120_000], 22],
  [[120_001, 450_000], 8],
];

/** Lead-time bands in days, as `[[minDays, maxDays], weight]`. */
const LEAD_TIME_BANDS: readonly (readonly [readonly [number, number], number])[] = [
  [[1, 10], 60],
  [[11, 25], 30],
  [[26, 45], 10],
];

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** The twelve categories, in blueprint order. */
function buildCategoryRows(): WithAssignedId<Prisma.CategoryCreateManyInput>[] {
  return CATEGORY_BLUEPRINTS.map((blueprint) => ({
    id: mint(),
    name: blueprint.name,
    slug: slugify(blueprint.name),
    description: blueprint.description,
  }));
}

/**
 * `PRODUCT_COUNT` products spread evenly across the categories.
 *
 * Product `index` belongs to category `index % 12`, which keeps the categories
 * within one product of each other, and is the `ordinal`-th product of that
 * category. The ordinal drives both the stock-keeping unit and the walk through
 * the category's word lists, so names and units are distinct and reproducible.
 */
function buildProductRows(
  categories: readonly WithAssignedId<Prisma.CategoryCreateManyInput>[],
): WithAssignedId<Prisma.ProductCreateManyInput>[] {
  const rows: WithAssignedId<Prisma.ProductCreateManyInput>[] = [];

  for (let index = 0; index < PRODUCT_COUNT; index += 1) {
    const slot = index % CATEGORY_BLUEPRINTS.length;
    const ordinal = Math.floor(index / CATEGORY_BLUEPRINTS.length);
    const blueprint = entry(CATEGORY_BLUEPRINTS, slot);
    const category = entry(categories, slot);

    const modifier = entry(blueprint.modifiers, ordinal);
    const noun = entry(blueprint.nouns, Math.floor(ordinal / blueprint.modifiers.length));
    const size = entry(
      blueprint.sizes,
      Math.floor(ordinal / (blueprint.modifiers.length * blueprint.nouns.length)) + ordinal,
    );

    const name = `${modifier} ${noun} ${size}`;
    const sku = `${blueprint.code}-${String(ordinal + 1).padStart(5, '0')}`;

    const [priceFloor, priceCeiling] = weighted(PRICE_BANDS);
    const asking = between(priceFloor, priceCeiling);
    // Round to a catalog-looking price ending in .24, .49, .74 or .99, then keep
    // it inside its band.
    const unitPriceCents = Math.min(
      priceCeiling,
      Math.max(priceFloor, Math.round(asking / 25) * 25 - 1),
    );

    const [leadFloor, leadCeiling] = weighted(LEAD_TIME_BANDS);
    const leadTimeDays = between(leadFloor, leadCeiling);

    const listedDaysAgo = between(30, 540);
    const revisedDaysAgo = between(0, Math.min(28, listedDaysAgo - 1));

    rows.push({
      id: mint(),
      sku,
      slug: slugify(`${name} ${sku}`),
      name,
      description:
        `${modifier} ${noun.toLowerCase()} in ${size}, specified for ${blueprint.duty}. ` +
        `Stocked in every distribution center with a standard lead time of ` +
        `${String(leadTimeDays)} days.`,
      categoryId: category.id,
      unitPriceCents,
      leadTimeDays,
      // The category's shared tile from `public/products/`, addressed by the
      // public path the storefront renders it from. Most products carry it; the
      // rest are left without artwork, which is the case the catalog's
      // no-image path exists for.
      imageUrl: chance(0.92) ? `/products/${blueprint.tile}.svg` : null,
      active: chance(0.97),
      createdAt: before(listedDaysAgo * DAY_MS + between(0, DAY_MS - 1)),
      updatedAt: before(revisedDaysAgo * DAY_MS + between(0, DAY_MS - 1)),
    });
  }

  return rows;
}

/** The six distribution centers, in blueprint order. */
function buildWarehouseRows(): WithAssignedId<Prisma.WarehouseCreateManyInput>[] {
  return WAREHOUSE_BLUEPRINTS.map((blueprint) => ({
    id: mint(),
    code: blueprint.code,
    name: blueprint.name,
    region: blueprint.region,
  }));
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/** Share of stock positions that sit below their reorder point. */
const UNDERSTOCKED_SHARE = 0.03;

/**
 * How many stock positions are promised out in full: `reserved` equal to
 * `onHand`, so the location has nothing left to sell although its shelf is not
 * empty.
 *
 * A count rather than a share, and deliberately not zero. "Out of stock" is a
 * state this storefront renders in three places - the stock badge's danger
 * tone, the wording `formatStockLabel` produces for it, and the dashboard's own
 * `?state=OUT_OF_STOCK` filter - and a seed in which no position ever reaches
 * it leaves all three unexercised: a reader never sees what the state looks
 * like, and nothing can assert it. Fully promised rather than an empty shelf,
 * because that is the ordinary way a warehouse runs out - the units are there
 * and every one of them belongs to an order already taken - and it also gives
 * the dashboard a line whose available quantity is exactly zero, which is the
 * figure its zero formatting is for.
 *
 * Taken from the front of the generated positions, which is the first product
 * of the catalog at the first distribution center. The dashboard reaches it
 * through its low-stock list - a position that far under its reorder point
 * sorts to the top of it - and through `?state=OUT_OF_STOCK`, rather than by
 * position in the stock table, which is ordered by category and product name.
 */
const PROMISED_OUT_POSITIONS = 1;

/**
 * One stock position per product and distribution center, so the dashboard's
 * inventory table is complete.
 *
 * A small share of the positions is generated below its reorder point, which is
 * what gives the low-stock list something to show; the rest carry comfortable
 * cover, and the first {@link PROMISED_OUT_POSITIONS} are promised out in full.
 * Reserved quantity never exceeds what is on hand.
 */
function buildStockLevelRows(
  products: readonly WithAssignedId<Prisma.ProductCreateManyInput>[],
  warehouses: readonly WithAssignedId<Prisma.WarehouseCreateManyInput>[],
): WithAssignedId<Prisma.InventoryLevelCreateManyInput>[] {
  const rows: WithAssignedId<Prisma.InventoryLevelCreateManyInput>[] = [];

  for (const product of products) {
    for (const warehouse of warehouses) {
      const reorderPoint = between(25, 500);
      const onHand = chance(UNDERSTOCKED_SHARE)
        ? between(0, reorderPoint - 1)
        : between(reorderPoint + 40, 4_000);

      /*
       * Drawn whether or not it is used, so that promising a position out in
       * full changes that one row and nothing after it: this generator is a
       * seeded sequence, and skipping a draw would shift every position and
       * every movement that follows.
       */
      const held = between(0, Math.floor(onHand * 0.35));

      rows.push({
        id: mint(),
        productId: product.id,
        warehouseId: warehouse.id,
        onHand,
        reserved: rows.length < PROMISED_OUT_POSITIONS ? onHand : held,
        reorderPoint,
        updatedAt: before(between(0, 14) * DAY_MS + between(0, DAY_MS - 1)),
      });
    }
  }

  return rows;
}

/**
 * Writes the inventory ledger: `MOVEMENTS_PER_PRODUCT` movements for every
 * product, spread over `MOVEMENT_HISTORY_DAYS` of history and over all six
 * distribution centers.
 *
 * This is the one table generated as it is written. At 200 000 rows, holding
 * every row object in memory before the first statement would cost far more
 * than the load itself, so rows accumulate into a buffer that is flushed
 * whenever it reaches the chunk size for this table's seven columns.
 *
 * @returns The total number of rows the server reported.
 */
async function seedInventoryMovements(
  prisma: PrismaClient,
  products: readonly WithAssignedId<Prisma.ProductCreateManyInput>[],
  warehouses: readonly WithAssignedId<Prisma.WarehouseCreateManyInput>[],
): Promise<number> {
  const started = performance.now();
  const size = rowsPerStatement(7);
  const expected = products.length * MOVEMENTS_PER_PRODUCT;
  let buffer: Prisma.InventoryMovementCreateManyInput[] = [];
  let written = 0;
  let reported = 0;

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) {
      return;
    }
    const result = await prisma.inventoryMovement.createMany({ data: buffer });
    written += result.count;
    buffer = [];
    if (written - reported >= size * PROGRESS_INTERVAL && written < expected) {
      reported = written;
      log(`inventory_movements ${String(written)}/${String(expected)} rows (${elapsed(started)})`);
    }
  };

  for (const product of products) {
    for (let index = 0; index < MOVEMENTS_PER_PRODUCT; index += 1) {
      const warehouse = pick(warehouses);
      const movementType = weighted(MOVEMENT_TYPE_WEIGHTS);
      const createdAt = before(between(0, MOVEMENT_HISTORY_DAYS) * DAY_MS + between(0, DAY_MS - 1));

      buffer.push({
        id: mint(),
        productId: product.id,
        warehouseId: warehouse.id,
        quantityDelta: movementQuantity(movementType),
        movementType,
        reference: chance(0.8) ? movementReference(movementType, createdAt) : null,
        createdAt,
      });

      if (buffer.length >= size) {
        await flush();
      }
    }
  }

  await flush();
  log(`inventory_movements ${String(written)} rows (${elapsed(started)})`);
  return written;
}

/**
 * The signed quantity a movement of `movementType` carries: goods received and
 * transferred in are positive, goods shipped and reserved are negative, and a
 * stock correction can go either way.
 */
function movementQuantity(movementType: MovementType): number {
  switch (movementType) {
    case MovementType.RECEIPT:
      return between(25, 1_200);
    case MovementType.SHIPMENT:
      return -between(1, 240);
    case MovementType.ADJUSTMENT:
      return chance(0.5) ? between(1, 40) : -between(1, 40);
    case MovementType.TRANSFER:
      return chance(0.5) ? between(10, 300) : -between(10, 300);
    case MovementType.RESERVATION:
      return -between(1, 60);
  }
}

/**
 * The document reference a movement of `movementType` was raised against, in
 * the `PREFIX-YEAR-SEQUENCE` form a warehouse management system produces.
 */
function movementReference(movementType: MovementType, raisedAt: Date): string {
  const prefix = MOVEMENT_REFERENCE_PREFIXES[movementType];
  const width = prefix.length === 2 ? 6 : 5;
  return `${prefix}-${String(raisedAt.getUTCFullYear())}-${String(between(1, 10 ** width - 1)).padStart(width, '0')}`;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * The volume price rules the pricing service reads.
 *
 * Three kinds are written, in the order the service resolves them: a tier
 * ladder for the share of products that negotiate their own pricing, one
 * fallback rule per category, and a handful of catalog-wide rules that apply
 * when neither of the others matches.
 */
function buildPriceRuleRows(
  products: readonly WithAssignedId<Prisma.ProductCreateManyInput>[],
  categories: readonly WithAssignedId<Prisma.CategoryCreateManyInput>[],
): WithAssignedId<Prisma.PriceRuleCreateManyInput>[] {
  const rows: WithAssignedId<Prisma.PriceRuleCreateManyInput>[] = [];

  // Drawn as an exact count rather than product by product, so the number of
  // rules is the same on every run instead of varying with the draw.
  const negotiated = sample(products, Math.round(products.length * TIERED_PRICING_SHARE));

  for (const product of negotiated) {
    for (const [tier, minQuantity] of QUANTITY_TIERS.entries()) {
      const band = entry(TIER_DISCOUNT_BANDS, tier);
      rows.push({
        id: mint(),
        productId: product.id,
        categoryId: null,
        minQuantity,
        discountBasisPoints: between(band.min, band.max),
        startsAt: before(between(30, 400) * DAY_MS),
        endsAt: chance(0.4) ? after(between(10, 200) * DAY_MS) : null,
        active: chance(0.9),
      });
    }
  }

  for (const category of categories) {
    const tier = between(0, QUANTITY_TIERS.length - 1);
    const band = entry(TIER_DISCOUNT_BANDS, tier);
    rows.push({
      id: mint(),
      productId: null,
      categoryId: category.id,
      minQuantity: entry(QUANTITY_TIERS, tier),
      discountBasisPoints: between(band.min, Math.floor((band.min + band.max) / 2)),
      startsAt: before(between(60, 500) * DAY_MS),
      endsAt: chance(0.25) ? after(between(30, 240) * DAY_MS) : null,
      active: chance(0.9),
    });
  }

  for (let index = 0; index < GLOBAL_PRICE_RULE_COUNT; index += 1) {
    const tier = index % QUANTITY_TIERS.length;
    const band = entry(TIER_DISCOUNT_BANDS, tier);
    rows.push({
      id: mint(),
      productId: null,
      categoryId: null,
      minQuantity: entry(QUANTITY_TIERS, tier),
      discountBasisPoints: between(100, band.max),
      startsAt: before(between(200, 700) * DAY_MS),
      endsAt: null,
      active: chance(0.9),
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Customers, carts and orders
// ---------------------------------------------------------------------------

/** Line quantities, as `[[minUnits, maxUnits], weight]`. */
const LINE_QUANTITY_BANDS: readonly (readonly [readonly [number, number], number])[] = [
  [[1, 4], 55],
  [[5, 12], 30],
  [[13, 48], 15],
];

/** How many lines an order carries, as `[lineCount, weight]`. */
const ORDER_LINE_COUNTS = [
  [1, 10],
  [2, 18],
  [3, 22],
  [4, 20],
  [5, 17],
  [6, 13],
] as const satisfies readonly (readonly [number, number])[];

/** Status mix for orders old enough to have reached their final state. */
const SETTLED_ORDER_STATUS = [
  [OrderStatus.FULFILLED, 86],
  [OrderStatus.CANCELLED, 9],
  [OrderStatus.PAID, 5],
] as const satisfies readonly (readonly [OrderStatus, number])[];

/** Status mix for orders placed recently enough to still be in flight. */
const RECENT_ORDER_STATUS = [
  [OrderStatus.PAID, 38],
  [OrderStatus.FULFILLED, 28],
  [OrderStatus.PENDING, 24],
  [OrderStatus.CANCELLED, 10],
] as const satisfies readonly (readonly [OrderStatus, number])[];

/** The service levels paired with their own weights, ready for `weighted`. */
const SERVICE_LEVEL_WEIGHTS = SERVICE_LEVELS.map((service) => [service, service.weight] as const);

/** Share of order lines that were sold with a negotiated discount. */
const DISCOUNTED_LINE_SHARE = 0.35;

/**
 * `CUSTOMER_COUNT` accounts, each with a distinct company, contact and email.
 * The first is {@link DEMO_ACCOUNT}, the account the storefront shops as; the
 * rest are generated.
 *
 * Every account draws its identifier and its age from the shared pseudo-random
 * sequence in the same order whether or not it is the first, so naming the
 * first one changes which details it carries and nothing else about the data
 * set - the identifier `/orders` defaults to still belongs to it.
 */
function buildCustomerRows(): WithAssignedId<Prisma.CustomerCreateManyInput>[] {
  const rows: WithAssignedId<Prisma.CustomerCreateManyInput>[] = [];

  for (let index = 0; index < CUSTOMER_COUNT; index += 1) {
    // The prefix repeats every twenty accounts while the suffix advances by an
    // extra step on each lap, so all forty company names — and therefore all
    // forty email addresses — are distinct.
    const company = `${entry(COMPANY_PREFIXES, index)} ${entry(
      COMPANY_SUFFIXES,
      index * 3 + Math.floor(index / COMPANY_PREFIXES.length),
    )}`;
    // Both name lists advance by a step that is coprime with their length, and
    // the family name takes an extra step on each lap of the given names, so no
    // two of the forty contacts share a name either.
    const contact = `${entry(CONTACT_GIVEN_NAMES, index * 7)} ${entry(
      CONTACT_FAMILY_NAMES,
      index * 3 + 1 + Math.floor(index / CONTACT_GIVEN_NAMES.length),
    )}`;

    // Drawn for every account, first or not, so the sequence advances
    // identically and the identifier of each account is the one it has always
    // had. Only which details the first account carries differs.
    const id = mint();
    const createdAt = before(between(60, 900) * DAY_MS + between(0, DAY_MS - 1));

    rows.push(
      index === 0
        ? { id, ...DEMO_ACCOUNT, createdAt }
        : {
            id,
            email: `${slugify(contact)}@${slugify(company)}.example.com`,
            companyName: company,
            contactName: contact,
            createdAt,
          },
    );
  }

  return rows;
}

/**
 * `CART_COUNT` carts. The first is the seeded demo cart — always `ACTIVE`,
 * always reachable through `DEMO_CART_TOKEN` and always attached to the first
 * customer. The next few are ordinary active carts, and the remainder have
 * either converted into an order or been abandoned.
 *
 * A cart that is still `ACTIVE` also holds its session's open-cart pointer,
 * which is what `@/server/services/cart.service` resolves a session's cart by;
 * a cart that has converted or been abandoned has given it up, so the session
 * that filled it is free to open another. Writing the pointer here rather than
 * leaving it null is what lets the storefront find the seeded demo cart at all,
 * and leaving it null on the finished carts is what makes their session tokens
 * history rather than claims on a cart.
 */
function buildCartRows(
  customers: readonly WithAssignedId<Prisma.CustomerCreateManyInput>[],
): WithAssignedId<Prisma.CartCreateManyInput>[] {
  const rows: WithAssignedId<Prisma.CartCreateManyInput>[] = [];

  for (let index = 0; index < CART_COUNT; index += 1) {
    const active = index < ACTIVE_CART_COUNT;
    // Offsets are drawn in milliseconds and the later one is bounded by the
    // earlier, so a cart is never touched before it was opened.
    const openedAgo = (active ? between(0, 3) : between(5, 200)) * DAY_MS + between(0, DAY_MS - 1);
    const touchedAgo = between(0, openedAgo);

    let customerId: string | null = null;
    if (index === 0) {
      customerId = entry(customers, 0).id;
    } else if (!chance(0.1)) {
      customerId = pick(customers).id;
    }

    // Drawn in the order the fields were once written in, so the identifier and
    // the session token of every cart are the values they have always had; the
    // pointer below is derived from the token rather than drawn.
    const id = mint();
    const sessionToken = index === 0 ? DEMO_CART_TOKEN : mint();

    rows.push({
      id,
      customerId,
      sessionToken,
      openToken: active ? sessionToken : null,
      status: active
        ? CartStatus.ACTIVE
        : chance(0.6)
          ? CartStatus.CONVERTED
          : CartStatus.ABANDONED,
      createdAt: before(openedAgo),
      updatedAt: before(touchedAgo),
    });
  }

  return rows;
}

/**
 * The lines of every cart, deduplicated per cart so the composite unique key on
 * `(cart_id, product_id)` holds. The demo cart carries
 * `DEMO_CART_LINE_COUNT` lines; the rest carry a handful each.
 */
function buildCartLineRows(
  carts: readonly WithAssignedId<Prisma.CartCreateManyInput>[],
  products: readonly WithAssignedId<Prisma.ProductCreateManyInput>[],
): WithAssignedId<Prisma.CartItemCreateManyInput>[] {
  const rows: WithAssignedId<Prisma.CartItemCreateManyInput>[] = [];

  for (const [index, cart] of carts.entries()) {
    let lines = between(2, 5);
    if (index === 0) {
      lines = DEMO_CART_LINE_COUNT;
    } else if (index < ACTIVE_CART_COUNT) {
      lines = between(1, 4);
    }

    for (const product of sample(products, lines)) {
      rows.push({
        id: mint(),
        cartId: cart.id,
        productId: product.id,
        quantity: between(...weighted(LINE_QUANTITY_BANDS)),
        unitPriceCents: product.unitPriceCents,
      });
    }
  }

  return rows;
}

/**
 * `ORDER_COUNT` historical orders with their lines and their shipping quotes.
 *
 * The three are built together because their money has to agree: a line's total
 * is its gross less its discount, an order's subtotal and discount are the sums
 * over its lines, its shipping charge is the amount on its own quote, and its
 * total is `subtotal - discount + shipping`.
 */
function buildOrderRows(
  customers: readonly WithAssignedId<Prisma.CustomerCreateManyInput>[],
  products: readonly WithAssignedId<Prisma.ProductCreateManyInput>[],
): {
  orders: WithAssignedId<Prisma.OrderCreateManyInput>[];
  lines: WithAssignedId<Prisma.OrderItemCreateManyInput>[];
  quotes: WithAssignedId<Prisma.ShippingQuoteCreateManyInput>[];
} {
  const orders: WithAssignedId<Prisma.OrderCreateManyInput>[] = [];
  const lines: WithAssignedId<Prisma.OrderItemCreateManyInput>[] = [];
  const quotes: WithAssignedId<Prisma.ShippingQuoteCreateManyInput>[] = [];

  for (let index = 0; index < ORDER_COUNT; index += 1) {
    const orderId = mint();
    const placedAt = before(between(1, ORDER_HISTORY_DAYS) * DAY_MS + between(0, DAY_MS - 1));

    let subtotalCents = 0;
    let discountCents = 0;

    for (const product of sample(products, weighted(ORDER_LINE_COUNTS))) {
      const quantity = between(...weighted(LINE_QUANTITY_BANDS));
      // The price the product carried when the order was placed, which is what
      // an order line records rather than today's catalog price.
      const unitPriceCents = product.unitPriceCents;
      const gross = quantity * unitPriceCents;
      const band = pick(TIER_DISCOUNT_BANDS);
      const lineDiscountCents = chance(DISCOUNTED_LINE_SHARE)
        ? Math.floor((gross * between(band.min, band.max)) / 10_000)
        : 0;

      subtotalCents += gross;
      discountCents += lineDiscountCents;

      lines.push({
        id: mint(),
        orderId,
        productId: product.id,
        quantity,
        unitPriceCents,
        discountCents: lineDiscountCents,
        lineTotalCents: gross - lineDiscountCents,
      });
    }

    const service = weighted(SERVICE_LEVEL_WEIGHTS);
    const shippingCents = between(service.minCents, service.maxCents);

    quotes.push({
      id: mint(),
      orderId,
      cartId: null,
      carrierCode: pick(CARRIER_CODES),
      serviceLevel: service.level,
      amountCents: shippingCents,
      etaDays: between(service.etaMin, service.etaMax),
      quotedAt: new Date(placedAt.getTime() - between(60_000, 1_800_000)),
    });

    const settled = placedAt.getTime() < SEED_NOW.getTime() - ORDER_SETTLED_AFTER_DAYS * DAY_MS;

    orders.push({
      id: orderId,
      orderNumber: `LS-${String(placedAt.getUTCFullYear())}-${String(index + 1).padStart(4, '0')}`,
      customerId: pick(customers).id,
      status: weighted(settled ? SETTLED_ORDER_STATUS : RECENT_ORDER_STATUS),
      subtotalCents,
      discountCents,
      shippingCents,
      totalCents: subtotalCents - discountCents + shippingCents,
      placedAt,
    });
  }

  return { orders, lines, quotes };
}

/**
 * A live shipping quote for every cart still `ACTIVE`, so the checkout page has
 * a rate to show before an order exists.
 */
function buildCartQuoteRows(
  carts: readonly WithAssignedId<Prisma.CartCreateManyInput>[],
): WithAssignedId<Prisma.ShippingQuoteCreateManyInput>[] {
  const rows: WithAssignedId<Prisma.ShippingQuoteCreateManyInput>[] = [];

  for (const cart of carts) {
    if (cart.status !== CartStatus.ACTIVE) {
      continue;
    }
    const service = weighted(SERVICE_LEVEL_WEIGHTS);
    rows.push({
      id: mint(),
      orderId: null,
      cartId: cart.id,
      carrierCode: pick(CARRIER_CODES),
      serviceLevel: service.level,
      amountCents: between(service.minCents, service.maxCents),
      etaDays: between(service.etaMin, service.etaMax),
      quotedAt: before(between(0, 2) * DAY_MS + between(0, DAY_MS - 1)),
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Reset and reporting
// ---------------------------------------------------------------------------

/**
 * Empties every table in one statement, children before parents, and resets the
 * sequences behind them.
 *
 * One `TRUNCATE` replaces the row-wise deletes a seed script usually opens with:
 * it is a single static statement with nothing interpolated into it, it needs no
 * index to find the rows it removes, and `CASCADE` reaches anything the explicit
 * list might have missed.
 */
const TRUNCATE_EVERY_TABLE = `
  TRUNCATE TABLE "shipping_quotes", "order_items", "orders", "cart_items", "carts",
    "customers", "price_rules", "inventory_movements", "inventory_levels",
    "warehouses", "products", "categories" RESTART IDENTITY CASCADE
`;

/**
 * Counts every table in insertion order, so the closing summary reports what
 * the database actually holds rather than what this script believes it wrote.
 */
const ROW_COUNT_REPORT = `
  SELECT 1 AS slot, 'categories' AS table_name, count(*) AS row_count FROM "categories"
  UNION ALL SELECT 2, 'products', count(*) FROM "products"
  UNION ALL SELECT 3, 'warehouses', count(*) FROM "warehouses"
  UNION ALL SELECT 4, 'inventory_levels', count(*) FROM "inventory_levels"
  UNION ALL SELECT 5, 'inventory_movements', count(*) FROM "inventory_movements"
  UNION ALL SELECT 6, 'price_rules', count(*) FROM "price_rules"
  UNION ALL SELECT 7, 'customers', count(*) FROM "customers"
  UNION ALL SELECT 8, 'carts', count(*) FROM "carts"
  UNION ALL SELECT 9, 'cart_items', count(*) FROM "cart_items"
  UNION ALL SELECT 10, 'orders', count(*) FROM "orders"
  UNION ALL SELECT 11, 'order_items', count(*) FROM "order_items"
  UNION ALL SELECT 12, 'shipping_quotes', count(*) FROM "shipping_quotes"
  ORDER BY slot
`;

/** PostgreSQL's error code for a relation that does not exist. */
const UNDEFINED_TABLE = '42P01';

/** Whether `error` is PostgreSQL reporting that a table is not there. */
function isUndefinedTable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return error.code === UNDEFINED_TABLE;
}

/** Empties every table, translating a missing schema into a usable message. */
async function resetLumenTables(pool: Pool): Promise<void> {
  const started = performance.now();

  try {
    await pool.query(TRUNCATE_EVERY_TABLE);
  } catch (error: unknown) {
    if (isUndefinedTable(error)) {
      throw new Error(
        'The demo tables are missing from this database. Start PostgreSQL with `pnpm demo:db`, ' +
          'apply the schema with `pnpm demo:migrate`, then run `pnpm demo:seed` again.',
        { cause: error },
      );
    }
    throw error;
  }

  log(`reset every table (${elapsed(started)})`);
}

/** Prints the row count of every table, read back from the database. */
async function reportTableCounts(pool: Pool): Promise<void> {
  const result = await pool.query<{ table_name: string; row_count: string }>(ROW_COUNT_REPORT);

  log('row counts');
  for (const row of result.rows) {
    console.log(`  ${row.table_name.padEnd(21)}${row.row_count.padStart(7)}`);
  }
}

// ---------------------------------------------------------------------------
// The load
// ---------------------------------------------------------------------------

/**
 * Loads the whole data set over one connection pool.
 *
 * Tables are written in foreign-key order — categories, products, warehouses,
 * stock levels, the movement ledger, price rules, customers, carts, cart lines,
 * orders, order lines, shipping quotes — and every parent id is known in memory
 * before its children are built, so no step reads anything back.
 *
 * Nothing here opens a transaction: the reset makes the whole script repeatable
 * on its own, an interactive transaction would have to outlive a 200 000-row
 * insert, and the closing `ANALYZE` cannot run inside one.
 */
async function loadLumenSupply(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const started = performance.now();

  try {
    await resetLumenTables(pool);

    const categories = buildCategoryRows();
    await insertSeedRows('categories', 4, categories, (chunk) =>
      prisma.category.createMany({ data: chunk }),
    );

    const products = buildProductRows(categories);
    await insertSeedRows('products', 12, products, (chunk) =>
      prisma.product.createMany({ data: chunk }),
    );

    const warehouses = buildWarehouseRows();
    await insertSeedRows('warehouses', 4, warehouses, (chunk) =>
      prisma.warehouse.createMany({ data: chunk }),
    );

    const levels = buildStockLevelRows(products, warehouses);
    await insertSeedRows('inventory_levels', 7, levels, (chunk) =>
      prisma.inventoryLevel.createMany({ data: chunk }),
    );

    await seedInventoryMovements(prisma, products, warehouses);

    const rules = buildPriceRuleRows(products, categories);
    await insertSeedRows('price_rules', 8, rules, (chunk) =>
      prisma.priceRule.createMany({ data: chunk }),
    );

    const customers = buildCustomerRows();
    await insertSeedRows('customers', 5, customers, (chunk) =>
      prisma.customer.createMany({ data: chunk }),
    );

    const carts = buildCartRows(customers);
    await insertSeedRows('carts', 6, carts, (chunk) => prisma.cart.createMany({ data: chunk }));

    const cartLines = buildCartLineRows(carts, products);
    await insertSeedRows('cart_items', 5, cartLines, (chunk) =>
      prisma.cartItem.createMany({ data: chunk }),
    );

    const placed = buildOrderRows(customers, products);
    await insertSeedRows('orders', 9, placed.orders, (chunk) =>
      prisma.order.createMany({ data: chunk }),
    );
    await insertSeedRows('order_items', 7, placed.lines, (chunk) =>
      prisma.orderItem.createMany({ data: chunk }),
    );

    const quotes = [...placed.quotes, ...buildCartQuoteRows(carts)];
    await insertSeedRows('shipping_quotes', 8, quotes, (chunk) =>
      prisma.shippingQuote.createMany({ data: chunk }),
    );

    // Planner statistics are maintained by autovacuum on a database that has
    // been running for a while; gathering them once here means the first
    // queries against a freshly loaded database are planned from real numbers
    // instead of from the defaults, which is what makes repeated runs
    // comparable. It cannot run inside a transaction.
    const gathering = performance.now();
    await pool.query('ANALYZE');
    log(`gathered planner statistics (${elapsed(gathering)})`);

    await reportTableCounts(pool);
    log(`done in ${elapsed(started)}`);
  } catch (error: unknown) {
    console.error(
      `${LOG_PREFIX}: the load did not finish. Whatever it had already written is left in ` +
        'place, so treat the data set as incomplete until it succeeds. Address the cause ' +
        'below and run `pnpm demo:seed` again — every table is truncated at the start of a ' +
        'run, so repeating it is safe.',
    );
    console.error(error);
    process.exitCode = 1;
  } finally {
    // Both halves of the connection have to be released: `$disconnect` closes
    // what Prisma opened through the adapter, and the pool itself was created
    // here, so nothing else will end it. Skipping either one leaves the process
    // alive and `prisma db seed` waiting for a command that already finished.
    //
    // That is why each release gets its own `try` instead of running in
    // sequence: a rejection from the first would otherwise leave the second
    // unreached, which is precisely the case it guards against. The failures are
    // collected and reported together afterwards, so neither hides the other and
    // neither hides the load error the `catch` above has already reported.
    const releaseFailures: unknown[] = [];

    try {
      await prisma.$disconnect();
    } catch (error: unknown) {
      releaseFailures.push(error);
    }

    try {
      await pool.end();
    } catch (error: unknown) {
      releaseFailures.push(error);
    }

    if (releaseFailures.length > 0) {
      console.error(
        `${LOG_PREFIX}: releasing the database connection failed. The data written by this run ` +
          'is unaffected, but a connection may still be held open, so a process that does not ' +
          'exit on its own is the symptom to expect. Address the cause below and run ' +
          '`pnpm demo:seed` again.',
      );
      for (const failure of releaseFailures) {
        console.error(failure);
      }
      // Raised, never cleared: the `catch` above may already have set it for a
      // failed load, and a run that could not let go of its connection is not a
      // successful run either. `process.exit` is deliberately not called — it
      // would discard whatever output is still buffered.
      process.exitCode = 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The one environment variable this script reads. */
const CONNECTION_VARIABLE = 'DATABASE_URL';

try {
  process.loadEnvFile();
} catch {
  // `.env` is optional, and missing far more often than not: a fresh clone has
  // none, and CI, Docker Compose and the dev-server launcher all pass
  // DATABASE_URL through the environment instead. Whatever the reason, the check
  // below is what reports an unset variable, and it reports it usefully.
}

const configured = process.env[CONNECTION_VARIABLE]?.trim() ?? '';

if (configured === '') {
  // Reported rather than left to the driver: without this, an unset variable
  // surfaces from deep inside the connection attempt as a SASL authentication
  // error, which says nothing about what is actually missing. The value itself
  // is never printed, here or anywhere else in this script.
  console.error(
    [
      `${LOG_PREFIX}: ${CONNECTION_VARIABLE} is not set, so there is no database to seed.`,
      '  1. start PostgreSQL:  pnpm demo:db',
      '  2. copy apps/demo-app/.env.example to apps/demo-app/.env, which carries the local',
      '     development connection URL (or export DATABASE_URL yourself)',
      '  3. apply the schema:   pnpm demo:migrate',
      '  4. load the data:      pnpm demo:seed',
    ].join('\n'),
  );
  process.exitCode = 1;
} else {
  await loadLumenSupply(configured);
}
