/**
 * Request validation for the catalog's two read surfaces.
 *
 * `GET /api/products` answers a filtered, sorted page of the catalog, and
 * `GET /api/products/[slug]` answers one product. Both learn everything they
 * know from the request line — a query string in the first case, a path
 * segment in the second — which is the least trustworthy input this
 * application takes: strings of unknown length and unknown shape, written by
 * whoever called the endpoint. The two schemas below are where those strings
 * become the typed values the rest of the server works with, and they are the
 * only place either surface is parsed.
 *
 * The module is deliberately inert. It imports Zod and the storefront's
 * data-transfer types and nothing else: no database client, no service, no
 * `next/server`, no environment. Declaring the schemas is all that happens at
 * import time, so a route handler, a server component, `next build` on a
 * machine with no database and `tsc -b` on a fresh clone all load it equally
 * happily. The parameter names come from `CatalogQuery` rather than from a URL
 * convention invented here, which is what keeps the query string, the handler,
 * the service signature and `PagedList` speaking one vocabulary.
 *
 * Reporting a failure is not this module's business either. A handler parses
 * with `safeParse` — or with `parse` inside a `try` — and hands the resulting
 * `ZodError` to the single mapper in `@/server/errors`, which copies each
 * issue's `path` and `message` into the response body. That division is why no
 * message below repeats the value it rejected: a rejected value came from the
 * caller and may carry anything, so only the constraint is ever described.
 */

import { z } from 'zod';

import type { CatalogQuery, CatalogSort } from '@/lib/types';

/**
 * Every ordering the catalog offers, in the order `CatalogSort` declares them.
 *
 * The annotation is what keeps the list honest: a value `CatalogSort` does not
 * declare fails to compile, so the orderings the endpoint accepts and the union
 * the services switch on cannot drift apart. The type is a non-empty tuple
 * because `z.enum` needs at least one value to build an enumeration from.
 */
const sorts: readonly [CatalogSort, ...CatalogSort[]] = [
  'featured',
  'price_asc',
  'price_desc',
  'name_asc',
];

/**
 * The fields `catalogQuerySchema` has to declare, read off `CatalogQuery`.
 *
 * Mapping over `keyof Required<CatalogQuery>` states three requirements at
 * once: every field of the type is present, a field the type does not declare
 * cannot be added, and each field parses to the member type the type declares.
 * A renamed or invented parameter is therefore a compile error here rather
 * than a query string nobody answers.
 *
 * `Required<…>[K]` reads each member's declared type without its optionality,
 * which this workspace's `exactOptionalPropertyTypes` would otherwise widen,
 * and `| undefined` is added back because an omitted filter parses to
 * `undefined`.
 */
type Fields = {
  [K in keyof Required<CatalogQuery>]: z.ZodType<Required<CatalogQuery>[K] | undefined>;
};

/**
 * The query parameters `GET /api/products` accepts.
 *
 * A caller hands this schema the raw query string as a record of strings —
 * `Object.fromEntries(request.nextUrl.searchParams)` — so both numbers are
 * coerced, `"2"` being the only form in which a page number can arrive. Every
 * bound is stated rather than left open: an unbounded page size is a way to
 * ask a single request to read the whole catalog, and an unbounded search term
 * is a way to hand the database a megabyte.
 *
 * The three parameters that say *how* to read the catalog carry defaults, so a
 * bare `GET /api/products` is a complete request that answers the first page in
 * the catalog's own order. The two that *filter* it carry none: an unconstrained
 * filter is an absent key rather than a value meaning "everything", exactly the
 * distinction `CatalogQuery` draws.
 *
 * `satisfies Fields` is a compile-time check and nothing more — it narrows no
 * type, emits no code and is not an assertion — so `CatalogQueryInput` below is
 * still inferred from the schema itself and keeps what parsing guarantees:
 * `sort`, `page` and `pageSize` hold a value once a request has been parsed,
 * which is more than the optional members of `CatalogQuery` promise.
 */
export const catalogQuerySchema = z.object({
  // A category's slug, as the catalog's filter chips link to it. A slug no
  // category owns is not rejected here: it matches nothing and answers an empty
  // page, which is a result rather than a bad request.
  categorySlug: z.string().trim().min(1).max(64).optional(),
  // A free-text term matched against product names and SKUs. A blank term is
  // accepted and narrows nothing, so a search box submitted empty is not an
  // error the customer has to read.
  search: z.string().trim().max(80).optional(),
  sort: z.enum(sorts).default('featured'),
  // 1-based, like `PagedList.page`. The ceiling sits far beyond the catalog's
  // size and exists so that an absurd page number is refused before it becomes
  // an offset the database has to count through.
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  // A full page of catalog cards. The maximum is the largest page the grid is
  // laid out for; a caller who wants more asks for the next page.
  pageSize: z.coerce.number().int().min(1).max(96).default(48),
} satisfies Fields);

/**
 * A parsed catalog query: each filter as the caller constrained it, and the
 * ordering, page number and page size resolved to a value.
 *
 * A filter the caller left out is an absent key at runtime rather than a key
 * holding `undefined`, but its inferred type is `string | undefined` all the
 * same, and `exactOptionalPropertyTypes` does not accept that for the
 * exact-optional members of `CatalogQuery`. A handler passing the query on
 * therefore names the fields it forwards and spreads each filter in only when
 * it holds a value, instead of handing this value over whole.
 */
export type CatalogQueryInput = z.infer<typeof catalogQuerySchema>;

/**
 * The route parameters `GET /api/products/[slug]` accepts.
 *
 * An object rather than a bare string, so a handler can parse the params object
 * itself — `const { slug } = productSlugParamsSchema.parse(await params)` — and
 * get a field path in the issue when the segment is malformed.
 *
 * The pattern is the shape a product slug actually has: lowercase alphanumeric
 * words joined by single hyphens, which is what the catalog's slugs are built
 * from and comfortably inside the length limit. Matching it here matters
 * because the segment travels on as a lookup key, so path junk, a traversal
 * attempt and anything quoted are refused before a query is built instead of
 * being trusted to find nothing.
 */
export const productSlugParamsSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase words separated by single hyphens'),
});

/** A parsed product slug: one segment, safe to look a product up with. */
export type ProductSlugParamsInput = z.infer<typeof productSlugParamsSchema>;
