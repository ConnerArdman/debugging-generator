/**
 * The suggestions shown alongside a product.
 *
 * `GET /api/recommendations` fills the rail on a product page, and this module
 * is what it answers from: the products the catalog merchandises in the same
 * category as the one the buyer is looking at, minus that product itself. The
 * category is the whole basis of the suggestion, which is why answering takes
 * one lookup of the product named and one listing of its category - the
 * relation the listing narrows on is indexed, and neither statement reads a
 * column the answer does not carry.
 *
 * The answer is stated in `RecommendationItem` from `@/lib/types` rather than in
 * database rows, so the two conventions of that module hold here as they do at
 * every other boundary in the server layer:
 *
 * * **Money stays an integer count of US cents.** `unitPriceCents` is stored
 *   that way, so the value is passed through rather than scaled or rounded.
 * * **Nothing that JSON cannot carry reaches the returned value.** The rail is a
 *   client component, so every field is a string, a number or `null`; the
 *   product's artwork is the path recorded against it, passed through exactly as
 *   stored, and a product without artwork answers `null` rather than a
 *   substitute chosen here.
 *
 * The listing is ordered on the stock-keeping unit, which is unique, so the
 * ordering is total: the same product asked about twice is answered the same
 * products in the same order, and the strip a buyer sees does not reshuffle
 * itself between visits.
 *
 * Importing this module opens no connection and reads no configuration - the
 * client in `@/server/db/prisma` connects on its first query - so a page that
 * imports it still builds and type-checks against a machine with no database.
 */

import type { RecommendationItem } from '@/lib/types';
import { prisma } from '@/server/db/prisma';
import { StorefrontNotFoundError } from '@/server/errors';

/**
 * The most suggestions one call answers with, whatever number it was asked for.
 *
 * It matches the ceiling the request schema for this feed states, so a route
 * handler and a server component calling in directly are held to one bound.
 */
const LIMIT_CEILING = 24;

/** How many suggestions a caller naming no usable number is answered with. */
const LIMIT_FALLBACK = 8;

/** Which product the suggestions accompany, and how many of them to answer. */
export interface RelatedProductsInput {
  /** The product on screen, as `RecommendationItem.productId` identifies one. */
  productId: string;
  /**
   * How many suggestions to answer with - the size of the rail asking. It is
   * held between one and {@link LIMIT_CEILING}, so a figure outside those bounds
   * narrows or widens to them rather than being refused.
   */
  limit: number;
}

/**
 * How many rows to read: `limit` as a whole number inside the bounds this
 * module answers within.
 *
 * Guarding the value at all is deliberate. A parsed request arrives with it
 * already coerced and bounded, and a server component calls in with a figure of
 * its own, so both are held to the same bounds in one place.
 *
 * @param limit The number of suggestions asked for.
 * @returns A whole number between one and {@link LIMIT_CEILING}, or
 *   {@link LIMIT_FALLBACK} when `limit` is not a finite number.
 */
function size(limit: number): number {
  if (!Number.isFinite(limit)) {
    return LIMIT_FALLBACK;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), LIMIT_CEILING);
}

/**
 * The products worth showing alongside the one named.
 *
 * The product itself is looked up first, because its category is what the
 * suggestions are drawn from and because a product that is not in the catalog
 * has no suggestions to make rather than an empty strip of them - the failure
 * is reported, and the rail turns it into one line of wording in place of its
 * tiles.
 *
 * Only products the catalog still merchandises are suggested: a buyer sent to a
 * product that cannot be ordered would have nothing to do there. The product
 * asked about is excluded, so a rail never suggests the page it sits on.
 *
 * @param input The product to suggest against, and how many suggestions to
 *   answer with.
 * @returns The suggestions, ordered so that the same input answers the same
 *   strip every time, and at most `input.limit` of them. A category holding
 *   nothing else answers an empty list, which is an ordinary outcome rather
 *   than a failure.
 * @throws StorefrontNotFoundError When no product owns `input.productId`. It is
 *   an error rather than an empty answer so that a route handler and a server
 *   component report an unknown product the one way, and the message names no
 *   value the caller supplied.
 */
export async function listRelatedProducts(
  input: RelatedProductsInput,
): Promise<RecommendationItem[]> {
  const anchor = await prisma.product.findUnique({
    where: { id: input.productId },
    select: { id: true, name: true, categoryId: true },
  });

  if (anchor === null) {
    throw new StorefrontNotFoundError('That product is not in the catalog.');
  }

  const rows = await prisma.product.findMany({
    where: { active: true, categoryId: anchor.categoryId, id: { not: anchor.id } },
    orderBy: { sku: 'asc' },
    take: size(input.limit),
    select: {
      id: true,
      sku: true,
      slug: true,
      name: true,
      unitPriceCents: true,
      imageUrl: true,
    },
  });

  // The one sentence every tile in this answer carries: what the suggestions
  // have in common with the product they accompany.
  const reason = `In the same category as ${anchor.name}`;

  return rows.map((row) => ({
    productId: row.id,
    sku: row.sku,
    slug: row.slug,
    name: row.name,
    priceCents: row.unitPriceCents,
    imageUrl: row.imageUrl,
    reason,
  }));
}
