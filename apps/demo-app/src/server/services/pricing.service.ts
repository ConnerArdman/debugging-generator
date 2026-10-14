/**
 * Promotion pricing for the Lumen Supply checkout.
 *
 * Trade customers buy on volume pricing, so what a cart line is charged is not
 * simply the catalog price it was captured at: the price rules hold the
 * negotiated discounts, and this module is where a cart's lines meet them.
 *
 * A rule carries a minimum quantity, a discount in basis points and a validity
 * window, and it is written at one of three scopes - a single product, a whole
 * category, or the catalog. The narrower scope wins: a rule written for the
 * product itself takes precedence over one written for its category, which in
 * turn takes precedence over a catalog-wide rule. Within one scope the larger
 * discount applies, and two rules offering the same discount are settled by
 * their identifiers, so a cart priced twice prices the same both times. A line
 * that no rule reaches is charged in full, which is an ordinary outcome rather
 * than a failure.
 *
 * Money is an integer number of US cents throughout, exactly as `@/lib/types`
 * requires. A line's gross is its unit price taken `quantity` times, its
 * discount is that gross scaled by the rule's basis points and rounded once,
 * and its total is the difference. The outcome's figures are the sums of the
 * lines', so `totalCents` equals `subtotalCents` less `discountCents` and
 * equals the lines' totals added up - the three can never disagree. No
 * `Decimal` and no `Date` reaches the returned value: it goes on into an order
 * and through JSON to the browser.
 */

import type { CartLine } from '@/lib/types';
import { prisma } from '@/server/db/prisma';
import { StorefrontValidationError } from '@/server/errors';

/** The columns of a price rule this module reads. */
type Rule = {
  id: string;
  productId: string | null;
  categoryId: string | null;
  discountBasisPoints: number;
};

/**
 * One cart line, priced.
 *
 * The fields are the ones an order line records, so a placed order can be
 * written from this shape without deriving any of them a second time.
 */
export type PricedLine = {
  productId: string;
  quantity: number;
  /** What one unit is charged at, in cents, before any discount. */
  unitPriceCents: number;
  /** What the applicable rule took off the line, in cents; `0` when none applied. */
  discountCents: number;
  /** `unitPriceCents * quantity - discountCents`. */
  lineTotalCents: number;
};

/**
 * A priced cart: every line with its discount, and the totals they add up to.
 *
 * `totalCents` is the merchandise total alone - freight and tax are added by
 * the checkout that goes on to use it.
 */
export type PromotionOutcome = {
  lines: PricedLine[];
  /** The lines' gross, in cents, before any discount. */
  subtotalCents: number;
  /** What the applicable rules took off, in cents. */
  discountCents: number;
  /** `subtotalCents - discountCents`. */
  totalCents: number;
};

/**
 * How narrow a rule's scope is: `0` for one product, `1` for a category, `2`
 * for the whole catalog. The lower number wins.
 */
function scope(rule: Rule): number {
  if (rule.productId !== null) {
    return 0;
  }
  if (rule.categoryId !== null) {
    return 1;
  }
  return 2;
}

/** Whether `rule` prices a line better than `chosen` does. */
function beats(rule: Rule, chosen: Rule): boolean {
  const a = scope(rule);
  const b = scope(chosen);
  if (a !== b) {
    return a < b;
  }
  if (rule.discountBasisPoints !== chosen.discountBasisPoints) {
    return rule.discountBasisPoints > chosen.discountBasisPoints;
  }
  // Same scope and the same discount: the lower identifier settles it, so the
  // choice cannot depend on the order the rows came back in.
  return rule.id < chosen.id;
}

/** The rule a line is priced with, or `undefined` when none of them applies. */
function best(rules: readonly Rule[]): Rule | undefined {
  let chosen: Rule | undefined;
  for (const rule of rules) {
    if (chosen === undefined || beats(rule, chosen)) {
      chosen = rule;
    }
  }
  return chosen;
}

/**
 * Prices `lines` against the rules in force, and returns them with the totals
 * they add up to.
 *
 * @param lines The cart's lines. An empty cart prices to an empty outcome with
 *   zero totals, which is not a failure.
 * @returns The priced lines together with the subtotal, the discount and the
 *   total, every figure an integer number of cents.
 * @throws StorefrontValidationError When a line carries a quantity or a unit
 *   price no charge can be derived from: a fraction, a quantity below one, or a
 *   negative price.
 */
export async function applyPromotions(lines: readonly CartLine[]): Promise<PromotionOutcome> {
  const now = new Date();
  const priced: PricedLine[] = [];
  let subtotal = 0;
  let discount = 0;
  let total = 0;

  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new StorefrontValidationError(
        'A line in the cart has a quantity that cannot be priced. Use whole units.',
        { details: { productId: line.productId } },
      );
    }
    if (!Number.isInteger(line.unitPriceCents) || line.unitPriceCents < 0) {
      throw new StorefrontValidationError(
        'A line in the cart has a price that cannot be charged. Add the product again.',
        { details: { productId: line.productId } },
      );
    }

    const gross = line.unitPriceCents * line.quantity;

    const rules = await prisma.priceRule.findMany({
      where: {
        active: true,
        minQuantity: { lte: line.quantity },
        startsAt: { lte: now },
        AND: [
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
          {
            OR: [
              { productId: line.productId },
              { category: { products: { some: { id: line.productId } } } },
              { productId: null, categoryId: null },
            ],
          },
        ],
      },
      select: { id: true, productId: true, categoryId: true, discountBasisPoints: true },
    });

    const rule = best(rules);
    // Held between zero and the line's gross, so a rule written with an
    // out-of-range discount can neither raise the price nor push the line
    // below nothing owed.
    const cut =
      rule === undefined
        ? 0
        : Math.min(gross, Math.max(0, Math.round((gross * rule.discountBasisPoints) / 10_000)));

    subtotal += gross;
    discount += cut;
    total += gross - cut;

    priced.push({
      productId: line.productId,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      discountCents: cut,
      lineTotalCents: gross - cut,
    });
  }

  return { lines: priced, subtotalCents: subtotal, discountCents: discount, totalCents: total };
}
