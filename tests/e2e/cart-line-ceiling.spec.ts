/**
 * The demo cart's per-line ceiling, proven to hold while many requests race to
 * raise one line.
 *
 * ## What the demo does
 *
 * A Lumen Supply cart holds one line per product, and a line holds at most
 * {@link LINE_UNITS_CEILING} units. `addCartLine` in
 * `apps/demo-app/src/server/services/cart.service.ts` never reads a line and
 * compares afterwards. The ceiling is the predicate of the one `UPDATE` that
 * raises the quantity (`quantity <= ceiling - units`, then `quantity + units`).
 * Under PostgreSQL's READ COMMITTED, a writer that waited on a rival's row lock
 * re-evaluates that predicate against the rival's committed quantity, so two
 * racers cannot both be told there was room.
 *
 * A line the cart does not hold yet is opened by an insert. The
 * `(cart_id, product_id)` unique constraint lets exactly one racer win it, and
 * each loser retries the conditional increment once. A request left with no
 * headroom is answered `409 CART_CONFLICT`, and its `details` name the units the
 * line `held`, the units `requested` and the `ceiling`. The session's cart is
 * opened the same way: `carts.open_token` is unique, so racers that all find no
 * cart still produce exactly one.
 *
 * ## What this spec proves
 *
 * {@link BURST_SIZE} `POST /api/cart/items` adds of one product are fired at
 * once, over HTTP, at the demo the product's launcher started, backed by its
 * real PostgreSQL database. There are two scenarios:
 *
 * 1. **Racing to open and fill a fresh line.** The session has no cart and no
 *    line when the burst starts, so the burst races to open the cart, to open
 *    the line and to raise it, all at once.
 * 2. **Racing at the boundary.** The line already holds nearly the ceiling, so
 *    every request of the burst contends for the last few units of headroom.
 *
 * In both scenarios:
 *
 * - every answer is `200` or `409`: no `5xx`, no `400` and no `404`;
 * - exactly the admissible number of adds succeed, and every other one is
 *   refused;
 * - every refusal is the ceiling's own decision, carrying its code, the
 *   requested units, the ceiling and a held quantity that left no room. That
 *   separates it from the bare `409` the demo's error mapper gives a unique
 *   violation nobody recovered from, which carries no `details`;
 * - every successful add answers with the same cart, holding one line for the
 *   product that has never crossed the ceiling;
 * - the stored cart, read back with `GET /api/cart`, holds exactly one line at
 *   exactly the admitted quantity, and its `itemCount` agrees.
 *
 * ## Why the counts are exact
 *
 * Every request of a burst adds the same number of units to the same line, and
 * nothing takes units away. The line therefore only climbs, from a known start,
 * in steps of that size. A request is refused only when the line has less
 * headroom than it asks for, and from that moment no later request can be
 * admitted either. So whatever order the database serialises the burst in, the
 * admitted count is `min(burst, floor((ceiling - start) / units))` (see
 * {@link admittedAdds}), the line ends at `start + admitted × units`, and every
 * refusal saw that final quantity.
 *
 * The spec asserts exact values rather than bounds for that reason, and it does
 * not depend on timing: an interleaving changes which requests win, never how
 * many win. Concurrency is what gives a regression room to show. A
 * read-then-write ceiling or an unrecovered duplicate line would surface here
 * as a quantity past the ceiling, a second line, or a `409` or `500` that is not
 * the ceiling's.
 *
 * ## Isolation and cleanup
 *
 * Each scenario shops with a session token of its own
 * (`e2e-line-ceiling-<scenario>-<uuid>`), passed in the query string. No other
 * spec's cart is read or changed, the storefront's default demo cart included,
 * and a rerun never meets a line an earlier run left behind.
 *
 * Each burst is preceded by an add the request schema rejects (zero units).
 * That pays `next dev`'s first compile of the route before the burst, so the
 * burst's requests reach the handler together. The rejection happens before
 * any cart is looked up, so a fresh token still has no cart when its burst
 * begins.
 *
 * Every cart a scenario changed is emptied in `afterEach`, whether the scenario
 * passed or not. The empty cart itself stays behind under its unique token,
 * where nothing else looks for it.
 *
 * ## What this spec does not do
 *
 * It launches no browser and opens no debugging session. It requests only the
 * worker-scoped `demoApp` fixture, which migrates and seeds the database and
 * starts the demo through the launcher. It writes nothing under
 * `apps/demo-app`, imports none of the demo's source, never sleeps, and names
 * no seeded product: the product is resolved at runtime from the demo's own
 * `GET /api/products`. `tests/e2e/**` is exempt from the no-hardcoding gate,
 * which is why the demo's routes appear below.
 *
 * @module tests/e2e/cart-line-ceiling.spec
 */

import { randomUUID } from 'node:crypto';

import { E2E_TIMEOUTS, expect, test } from './helpers/fixtures';
import { messageOf } from './helpers/demo-app';

// ---------------------------------------------------------------------------
// The demo's cart surface
// ---------------------------------------------------------------------------

/**
 * The most units one demo cart line may hold.
 *
 * This restates `LINE_UNITS_CEILING` from the demo's cart service, because a
 * spec never imports demo source. Every refusal is also checked to report this
 * same value as its `details.ceiling`, so the two copies cannot drift apart
 * without this spec failing.
 */
const LINE_UNITS_CEILING = 99;

/**
 * The longest session token the demo's cart query schema accepts. A longer
 * token is refused with a `400` before any cart is read.
 */
const SESSION_TOKEN_MAX_LENGTH = 64;

/** The storefront's cart read route, which answers the stored `CartView`. */
const CART_PATH = '/api/cart';

/** The storefront's cart mutation route (`CartMutation` bodies). */
const CART_ITEMS_PATH = '/api/cart/items';

/** The storefront's catalog listing route (`PagedList<ProductSummary>`). */
const PRODUCTS_PATH = '/api/products';

/** The status of an applied cart change and of a cart read. */
const HTTP_OK = 200;

/** The status of a body the request schema rejects. */
const HTTP_BAD_REQUEST = 400;

/** The status of an add the line has no headroom for. */
const HTTP_CONFLICT = 409;

/** The error code the demo answers a ceiling refusal with. */
const CONFLICT_CODE = 'CART_CONFLICT';

// ---------------------------------------------------------------------------
// The bursts
// ---------------------------------------------------------------------------

/**
 * How many adds each burst fires at once.
 *
 * Twelve outnumbers the demo's database pool of eight connections, so the burst
 * queues for connections as well as for row locks. It stays well inside the
 * pool's five-second wait for a free connection, so every request is answered
 * by the cart rather than by a pool timeout.
 */
const BURST_SIZE = 12;

/**
 * The units each add of the fresh-line scenario asks for. Three of them fit
 * under the ceiling and a fourth would not.
 */
const FILL_UNITS = 30;

/** Where the boundary scenario's line starts, set by one serial add before its burst. */
const EDGE_START_UNITS = 90;

/** The units each add of the boundary scenario asks for. */
const EDGE_UNITS = 1;

/**
 * The quantity the warm-up add asks for. It is below the request schema's
 * minimum of one unit, so the add is refused with a `400` before any cart is
 * read or opened.
 */
const REJECTED_QUANTITY = 0;

/** The prefix of every session token this spec shops with. */
const SESSION_TOKEN_PREFIX = 'e2e-line-ceiling';

/**
 * The bound on one request, the burst's included. It is the e2e project's
 * budget for one readiness GET of the demo, because the first request to reach
 * a route may wait out `next dev`'s compile of it.
 */
const REQUEST_TIMEOUT_MS = E2E_TIMEOUTS.pageReady;

/**
 * The most request rounds one scenario runs one after another: the catalog
 * read, the warm-up, the serial start, the burst, the read-back and the
 * `afterEach` emptying.
 */
const SCENARIO_REQUEST_ROUNDS = 6;

/** One scenario's budget, hooks included: each of its rounds at its own bound. */
const SCENARIO_TIMEOUT_MS = SCENARIO_REQUEST_ROUNDS * REQUEST_TIMEOUT_MS;

// ---------------------------------------------------------------------------
// Shapes read off the wire
// ---------------------------------------------------------------------------

/** One stored cart line, as far as this spec reads it. */
interface StoredLine {
  readonly id: string;
  readonly productId: string;
  readonly quantity: number;
}

/** A `CartView`, as far as this spec reads it. */
interface CartReading {
  readonly id: string;
  readonly lines: readonly StoredLine[];
  readonly itemCount: number;
}

/**
 * What a `409` said, read without judging it. The fields stay `unknown` so the
 * assertion compares them with the expected refusal and reports whatever
 * arrived instead.
 */
interface ConflictReading {
  readonly code: unknown;
  readonly held: unknown;
  readonly requested: unknown;
  readonly ceiling: unknown;
}

/** How one add of a burst was answered. */
type AddOutcome =
  | { readonly kind: 'added'; readonly cart: CartReading }
  | { readonly kind: 'refused'; readonly conflict: ConflictReading }
  | { readonly kind: 'unexpected'; readonly account: string };

/** Where a burst's line starts and how many units each of its adds asks for. */
interface Burst {
  readonly startUnits: number;
  readonly units: number;
}

/** The cart changes this spec sends, as the demo's `CartMutation` union spells them. */
type CartMutationBody =
  | { readonly operation: 'add'; readonly productId: string; readonly quantity: number }
  | { readonly operation: 'empty' };

// ---------------------------------------------------------------------------
// Cleanup state
// ---------------------------------------------------------------------------

/**
 * The session tokens whose carts the running scenario may have changed.
 *
 * A token is registered just before its first mutating request, and
 * `afterEach` drains the list, so a scenario that fails half-way still leaves
 * its cart empty.
 */
const changedCartTokens: string[] = [];

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Whether `value` is a plain JSON object, whose fields can then be read as `unknown`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The number of adds a burst admits, whatever order they are serialised in:
 * as many as the line's headroom has room for, and never more than the burst
 * sends.
 */
function admittedAdds(burst: Burst): number {
  return Math.min(BURST_SIZE, Math.floor((LINE_UNITS_CEILING - burst.startUnits) / burst.units));
}

/** The quantity a burst leaves the line at: its start plus every admitted add. */
function settledQuantity(burst: Burst): number {
  return burst.startUnits + admittedAdds(burst) * burst.units;
}

/**
 * A session token no other cart has used: the prefix, the scenario's tag and
 * a random UUID.
 *
 * @throws Error when the tag would take the token past the length the demo
 * accepts, which would turn every request into a `400`.
 */
function sessionToken(tag: string): string {
  const token = `${SESSION_TOKEN_PREFIX}-${tag}-${randomUUID()}`;
  if (token.length > SESSION_TOKEN_MAX_LENGTH) {
    throw new Error(
      `cart-line-ceiling.spec: the session token for "${tag}" is ${String(token.length)} characters, past the ${String(SESSION_TOKEN_MAX_LENGTH)} the demo accepts; shorten the tag.`,
    );
  }
  return token;
}

/** A demo route addressed to one session's cart. */
function cartRouteUrl(baseUrl: string, path: string, token: string): string {
  const url = new URL(path, baseUrl);
  url.searchParams.set('sessionToken', token);
  return url.toString();
}

/**
 * A response body parsed as JSON, or `undefined` when it is not JSON at all,
 * such as an HTML error page from `next dev`. No JSON text parses to
 * `undefined`, so the marker cannot be mistaken for a body.
 */
async function jsonBodyOf(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

/** The `error.code` of the demo's failure envelope, or a word saying there was none. */
function errorCodeOf(body: unknown): string {
  if (body === undefined) {
    return 'a body that is not JSON';
  }
  const code = isRecord(body) && isRecord(body.error) ? body.error.code : undefined;
  return typeof code === 'string' ? code : 'no error code';
}

/** One stored line, or `undefined` when `value` is not shaped like one. */
function storedLineOf(value: unknown): StoredLine | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.productId !== 'string' ||
    typeof value.quantity !== 'number'
  ) {
    return undefined;
  }
  return { id: value.id, productId: value.productId, quantity: value.quantity };
}

/**
 * A `CartView` body, read down to the fields this spec asserts on.
 *
 * @throws Error naming `label` when the body is not a `CartView`, so a
 * malformed answer fails with its request named rather than as an undefined
 * field further on.
 */
function cartOf(body: unknown, label: string): CartReading {
  if (
    isRecord(body) &&
    typeof body.id === 'string' &&
    typeof body.itemCount === 'number' &&
    Array.isArray(body.lines)
  ) {
    const lines: StoredLine[] = [];
    for (const entry of body.lines as unknown[]) {
      const line = storedLineOf(entry);
      if (line === undefined) {
        break;
      }
      lines.push(line);
    }
    if (lines.length === body.lines.length) {
      return { id: body.id, lines, itemCount: body.itemCount };
    }
  }
  throw new Error(
    `cart-line-ceiling.spec: ${label} answered HTTP ${String(HTTP_OK)} with a body that is not a CartView (id, itemCount and lines of id, productId and quantity).`,
  );
}

/** What a `409` body said about the refusal, each field as it arrived. */
function conflictOf(body: unknown): ConflictReading {
  const error = isRecord(body) && isRecord(body.error) ? body.error : {};
  const details = isRecord(error.details) ? error.details : {};
  return {
    code: error.code,
    held: details.held,
    requested: details.requested,
    ceiling: details.ceiling,
  };
}

/** The lines of `cart` that hold `productId`. */
function linesFor(cart: CartReading, productId: string): StoredLine[] {
  return cart.lines.filter((line) => line.productId === productId);
}

/** A burst's answers counted by kind, for assertion messages. */
function tally(outcomes: readonly AddOutcome[]): string {
  const added = outcomes.filter((outcome) => outcome.kind === 'added').length;
  const refused = outcomes.filter((outcome) => outcome.kind === 'refused').length;
  const unexpected = outcomes.flatMap((outcome) =>
    outcome.kind === 'unexpected' ? [outcome.account] : [],
  );
  const rest = unexpected.length === 0 ? 'nothing else' : unexpected.join('; ');
  return `${String(added)} × ${String(HTTP_OK)}, ${String(refused)} × ${String(HTTP_CONFLICT)}, ${rest}`;
}

// ---------------------------------------------------------------------------
// The demo interactions
// ---------------------------------------------------------------------------

/** Send one cart change for one session's cart, bounded by {@link REQUEST_TIMEOUT_MS}. */
function postCartMutation(
  baseUrl: string,
  token: string,
  mutation: CartMutationBody,
): Promise<Response> {
  return fetch(cartRouteUrl(baseUrl, CART_ITEMS_PATH, token), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(mutation),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/**
 * The id of the first product the demo's catalog lists, read from its own
 * listing route. Which product it is does not matter: a cart line's ceiling
 * is the same for every product, and adding to a cart promises no stock.
 */
async function firstCatalogProductId(baseUrl: string): Promise<string> {
  const response = await fetch(new URL(PRODUCTS_PATH, baseUrl), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(response.status, `GET ${PRODUCTS_PATH} on the demo`).toBe(HTTP_OK);
  const body = await jsonBodyOf(response);
  const items = isRecord(body) && Array.isArray(body.items) ? (body.items as unknown[]) : [];
  for (const item of items) {
    if (isRecord(item) && typeof item.id === 'string' && item.id !== '') {
      return item.id;
    }
  }
  throw new Error(
    `cart-line-ceiling.spec: GET ${PRODUCTS_PATH} listed ${String(items.length)} product(s) and none carries an id; re-seed the demo database (pnpm demo:seed).`,
  );
}

/**
 * Pay `next dev`'s first compile of the cart route before a burst, with an add
 * the request schema rejects. The rejection is required to be the schema's
 * `400`, which the route answers before it looks up any cart, so the session's
 * cart is exactly as it was.
 */
async function warmCartRoute(baseUrl: string, token: string, productId: string): Promise<void> {
  const response = await postCartMutation(baseUrl, token, {
    operation: 'add',
    productId,
    quantity: REJECTED_QUANTITY,
  });
  const body = await jsonBodyOf(response);
  expect(
    response.status,
    `the warm-up add of ${String(REJECTED_QUANTITY)} units must be refused by the request schema (${errorCodeOf(body)})`,
  ).toBe(HTTP_BAD_REQUEST);
}

/**
 * Add `units` of `productId` to one session's cart, and say how the demo
 * answered.
 *
 * @throws Error when a `200` does not carry a `CartView`, or when no answer
 * arrived within {@link REQUEST_TIMEOUT_MS}; {@link fireBurst} reports either
 * as an unexpected outcome.
 */
async function addToCart(
  baseUrl: string,
  token: string,
  productId: string,
  units: number,
): Promise<AddOutcome> {
  const response = await postCartMutation(baseUrl, token, {
    operation: 'add',
    productId,
    quantity: units,
  });
  const body = await jsonBodyOf(response);
  if (response.status === HTTP_OK) {
    return { kind: 'added', cart: cartOf(body, `POST ${CART_ITEMS_PATH}`) };
  }
  if (response.status === HTTP_CONFLICT) {
    return { kind: 'refused', conflict: conflictOf(body) };
  }
  return { kind: 'unexpected', account: `HTTP ${String(response.status)} ${errorCodeOf(body)}` };
}

/**
 * Fire {@link BURST_SIZE} adds of `units` at once and wait for every one of
 * them to settle.
 *
 * Every request is started before any is awaited, so they are in flight
 * together. They are collected with `allSettled` rather than `all`, so a
 * request that failed outright is reported beside the others, and no request
 * is still running when the scenario's cart is read back or emptied.
 */
async function fireBurst(
  baseUrl: string,
  token: string,
  productId: string,
  units: number,
): Promise<readonly AddOutcome[]> {
  const settled = await Promise.allSettled(
    Array.from({ length: BURST_SIZE }, () => addToCart(baseUrl, token, productId, units)),
  );
  return settled.map((result): AddOutcome =>
    result.status === 'fulfilled'
      ? result.value
      : { kind: 'unexpected', account: `no usable answer: ${messageOf(result.reason)}` },
  );
}

/** The session's cart as the demo's database now holds it (`GET /api/cart`). */
async function readStoredCart(baseUrl: string, token: string): Promise<CartReading> {
  const response = await fetch(cartRouteUrl(baseUrl, CART_PATH, token), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await jsonBodyOf(response);
  expect(response.status, `GET ${CART_PATH} after the burst (${errorCodeOf(body)})`).toBe(HTTP_OK);
  return cartOf(body, `GET ${CART_PATH}`);
}

// ---------------------------------------------------------------------------
// The assertions
// ---------------------------------------------------------------------------

/**
 * Check a scenario's own arithmetic before its burst is fired: the line must
 * start inside the ceiling, the burst must ask for more than the line has
 * room for, and the admitted adds must leave the line with less headroom than
 * one more add needs. Without all three, the refusals the scenario expects
 * would not be the ceiling's.
 */
function expectOversubscribed(burst: Burst): void {
  const admitted = admittedAdds(burst);
  const settled = settledQuantity(burst);
  expect(burst.startUnits, 'the line must start inside the ceiling').toBeLessThanOrEqual(
    LINE_UNITS_CEILING,
  );
  expect(admitted, 'the burst must ask for more units than the line has room for').toBeLessThan(
    BURST_SIZE,
  );
  expect(settled, 'the admitted adds must leave the line inside the ceiling').toBeLessThanOrEqual(
    LINE_UNITS_CEILING,
  );
  expect(
    settled + burst.units,
    'the admitted adds must leave less headroom than one more add needs',
  ).toBeGreaterThan(LINE_UNITS_CEILING);
}

/**
 * Assert a settled burst held the ceiling: every answer was a `200` or the
 * ceiling's `409`, exactly the admissible number were admitted, every refusal
 * saw a full line, and every admitted add answered with one cart holding one
 * line for the product inside the ceiling.
 *
 * @returns The id of the cart every admitted add answered with.
 */
function expectBurstHeldTheCeiling(
  outcomes: readonly AddOutcome[],
  burst: Burst,
  productId: string,
): string {
  const admitted = admittedAdds(burst);
  const settled = settledQuantity(burst);
  const answered = tally(outcomes);

  expect(
    outcomes.filter((outcome) => outcome.kind === 'unexpected').length,
    `every add must be answered ${String(HTTP_OK)} or ${String(HTTP_CONFLICT)} (${answered})`,
  ).toBe(0);
  expect(
    outcomes.filter((outcome) => outcome.kind === 'added').length,
    `exactly ${String(admitted)} adds of ${String(burst.units)} fit between ${String(burst.startUnits)} and the ceiling of ${String(LINE_UNITS_CEILING)} (${answered})`,
  ).toBe(admitted);
  expect(
    outcomes.filter((outcome) => outcome.kind === 'refused').length,
    `every add past the ceiling must be refused (${answered})`,
  ).toBe(BURST_SIZE - admitted);

  const carts = outcomes.flatMap((outcome) => (outcome.kind === 'added' ? [outcome.cart] : []));
  for (const cart of carts) {
    const lines = linesFor(cart, productId);
    expect(lines.length, 'an admitted add must answer with one line for the product').toBe(1);
    const quantity = lines[0]?.quantity ?? Number.NaN;
    expect(quantity, 'an admitted add must have raised the line').toBeGreaterThan(burst.startUnits);
    expect(quantity, 'no answer may show the line past what the burst admits').toBeLessThanOrEqual(
      settled,
    );
    expect(
      (quantity - burst.startUnits) % burst.units,
      'the line must climb in whole adds of the burst',
    ).toBe(0);
  }

  const cartIds = [...new Set(carts.map((cart) => cart.id))];
  expect(cartIds.length, 'every admitted add must answer with the same cart').toBe(1);

  const refusals = outcomes.flatMap((outcome) =>
    outcome.kind === 'refused' ? [outcome.conflict] : [],
  );
  for (const conflict of refusals) {
    expect(
      conflict,
      `a refused add must be the ceiling's own decision, made against the full line of ${String(settled)}`,
    ).toEqual({
      code: CONFLICT_CODE,
      held: settled,
      requested: burst.units,
      ceiling: LINE_UNITS_CEILING,
    });
  }

  const [cartId] = cartIds;
  if (cartId === undefined) {
    throw new Error('cart-line-ceiling.spec: the burst admitted no add, so no cart answered.');
  }
  return cartId;
}

/**
 * Assert the stored cart matches the burst: the same cart the admitted adds
 * answered with, one line in all, and that line holding exactly the settled
 * quantity, which the cart's `itemCount` agrees with.
 */
function expectStoredLine(
  stored: CartReading,
  cartId: string,
  burst: Burst,
  productId: string,
): void {
  const settled = settledQuantity(burst);
  expect(stored.id, `GET ${CART_PATH} must read back the cart the burst changed`).toBe(cartId);
  expect(
    stored.lines.length,
    'the stored cart must hold one line in all: the product the burst added',
  ).toBe(1);
  const lines = linesFor(stored, productId);
  expect(lines.length, 'the stored cart must hold exactly one line for the product').toBe(1);
  expect(
    lines[0]?.quantity,
    `the stored line must hold exactly the ${String(settled)} units the burst admitted`,
  ).toBe(settled);
  expect(stored.itemCount, 'the stored cart must count the units of its one line').toBe(settled);
}

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

test.describe('demo cart — a line never crosses its ceiling under concurrent adds', () => {
  test.describe.configure({ timeout: SCENARIO_TIMEOUT_MS });

  test.afterEach(async ({ demoApp }) => {
    for (const token of changedCartTokens.splice(0)) {
      const response = await postCartMutation(demoApp.baseUrl, token, { operation: 'empty' });
      const body = await jsonBodyOf(response);
      expect(response.status, `emptying the scenario's cart after it (${errorCodeOf(body)})`).toBe(
        HTTP_OK,
      );
      expect(
        cartOf(body, `POST ${CART_ITEMS_PATH} (empty)`).lines,
        "the scenario's cart must be left empty",
      ).toEqual([]);
    }
  });

  test('racing to open and fill a fresh line admits only the adds that fit', async ({
    demoApp,
  }) => {
    const burst: Burst = { startUnits: 0, units: FILL_UNITS };
    expectOversubscribed(burst);

    const baseUrl = demoApp.baseUrl;
    const productId = await firstCatalogProductId(baseUrl);
    const token = sessionToken('fill');
    await warmCartRoute(baseUrl, token, productId);

    changedCartTokens.push(token);
    const outcomes = await fireBurst(baseUrl, token, productId, burst.units);
    const cartId = expectBurstHeldTheCeiling(outcomes, burst, productId);

    expectStoredLine(await readStoredCart(baseUrl, token), cartId, burst, productId);
  });

  test('racing at the boundary admits exactly the remaining headroom', async ({ demoApp }) => {
    const burst: Burst = { startUnits: EDGE_START_UNITS, units: EDGE_UNITS };
    expectOversubscribed(burst);

    const baseUrl = demoApp.baseUrl;
    const productId = await firstCatalogProductId(baseUrl);
    const token = sessionToken('edge');
    await warmCartRoute(baseUrl, token, productId);

    changedCartTokens.push(token);
    const start = await addToCart(baseUrl, token, productId, burst.startUnits);
    if (start.kind !== 'added') {
      throw new Error(
        `cart-line-ceiling.spec: the serial add of ${String(burst.startUnits)} units that sets up the boundary was not applied (${tally([start])}).`,
      );
    }
    const startLines = linesFor(start.cart, productId);
    expect(startLines.length, 'the serial add must open one line for the product').toBe(1);
    expect(
      startLines[0]?.quantity,
      `the serial add must leave the line at ${String(burst.startUnits)} units`,
    ).toBe(burst.startUnits);

    const outcomes = await fireBurst(baseUrl, token, productId, burst.units);
    const cartId = expectBurstHeldTheCeiling(outcomes, burst, productId);
    expect(cartId, 'the burst must raise the cart the serial add opened').toBe(start.cart.id);

    expectStoredLine(await readStoredCart(baseUrl, token), cartId, burst, productId);
  });
});
