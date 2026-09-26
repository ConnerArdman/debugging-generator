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
 * Normalises a parameter that says nothing onto `undefined`, so that the
 * field's own default - or its absence - takes over.
 *
 * Three inputs mean "nothing was said" about a catalog parameter, and
 * collapsing them in one place is what gives this module a single empty-value
 * policy rather than one per field: a parameter the caller never sent (already
 * `undefined`), one read with `URLSearchParams.get()` and found absent, which
 * answers `null` rather than `undefined`, and one carrying nothing but
 * whitespace - which is exactly what a GET form submitted with an untouched
 * control, or a filter UI that emits every key it knows, puts on the query
 * string. Everything else is passed through untouched for the field's own
 * schema to judge, which is why the parameter is `unknown`: this step decides
 * whether a value is worth judging, never what it means.
 *
 * It is the same helper, with the same reasoning, that
 * `@/server/validation/cart` and `@/server/validation/inventory` apply to their
 * own parameters. It is duplicated rather than shared because these modules are
 * deliberately inert and import nothing of each other: a six-line
 * normalisation is a cheaper thing to keep in step than an import edge between
 * three validation modules would be.
 *
 * @param value Whatever the caller supplied for the field.
 * @returns `undefined` when the value says nothing, and `value` itself
 * otherwise.
 */
function unset(value: unknown): unknown {
  if (value === null) {
    return undefined;
  }

  if (typeof value === 'string' && value.trim().length === 0) {
    return undefined;
  }

  return value;
}

/**
 * The highest code point counted as a control character, and the delete
 * character that sits above the printable range.
 *
 * The two figures name the spans a catalog slug or a search term never
 * contains - the C0 controls `U+0000`–`U+001F`, and `U+007F` - and they are
 * named rather than written into {@link printable} so that the range being
 * refused can be read where it is applied.
 */
const CONTROL = 0x1f;
const DELETE = 0x7f;

/**
 * Whether `value` is free of control characters, which is the one thing the
 * length bounds below cannot express.
 *
 * Trimming removes the whitespace a copied catalog link padded a parameter
 * with, and nothing else: every other control character survives it, `U+0000`
 * above all, which a query string carries and a `UTF8` database parameter has
 * no representation for. Both textual filters here travel into a statement as
 * parameters - a slug is compared against a category's, a term is matched
 * against product names and SKUs - so a value carrying one is refused before it
 * becomes a query the driver cannot send, which is the difference between a 400
 * naming the parameter and a 500 naming nothing.
 *
 * The check walks code points instead of matching a pattern, because a pattern
 * for these characters would have to contain them, and the walk is free over
 * parameters bounded to sixty-four and eighty characters. A character with no
 * code point cannot come out of a string iteration, and counting one as
 * unprintable keeps the check total without an assertion standing in for the
 * impossible case.
 *
 * @param value A parameter the length rules have already accepted.
 * @returns `true` when every character is printable, and `false` as soon as one
 * is not.
 */
function printable(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);

    if (code === undefined || code <= CONTROL || code === DELETE) {
      return false;
    }
  }

  return true;
}

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
 * Every field - the filters included - is wrapped in {@link unset}, so one
 * empty-value policy covers the whole query: a parameter sent blank says
 * nothing, and a parameter that says nothing resolves to the field's default or
 * to absence rather than being rejected. That matters because a blank value is
 * not a caller's mistake but the ordinary output of the surfaces that build
 * these addresses - a search box submitted empty, a filter row that emits every
 * key it knows, a copied link whose value was truncated away - and because a
 * caller reading `?sort=` as a failure while `?search=` succeeded would be
 * meeting two policies on one endpoint. A value that says something is still
 * held to every bound below: `?sort=bogus`, `?page=0` and `?pageSize=97` are
 * rejected, and the rejection names the field.
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
  // page, which is a result rather than a bad request. A slug carrying a
  // control character is rejected, because that is a value no filter chip
  // produces and no parameter can be sent as; the check sits after the length
  // bounds and before `optional()`, so an unconstrained filter is still an
  // absent key.
  categorySlug: z.preprocess(
    unset,
    z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine(printable, 'A category slug contains no control characters.')
      .optional(),
  ),
  // A free-text term matched against product names and SKUs. A blank term
  // narrows nothing, so a search box submitted empty is not an error the
  // customer has to read: `unset` turns it into an absent filter and the
  // listing is unfiltered. A term made only of printable characters is the
  // whole of what a search box can produce, so one carrying a control character
  // is refused rather than matched against nothing.
  search: z.preprocess(
    unset,
    z
      .string()
      .trim()
      .max(80)
      .refine(printable, 'A search term contains no control characters.')
      .optional(),
  ),
  sort: z.preprocess(unset, z.enum(sorts).default('featured')),
  // 1-based, like `PagedList.page`. The ceiling sits far beyond the catalog's
  // size and exists so that an absurd page number is refused before it becomes
  // an offset the database has to count through. `unset` runs before the
  // coercion, which is what makes a blank parameter resolve to the default:
  // `Number('')` is `0`, so an empty value reaching the coercion would be
  // refused by the lower bound as a page number nobody asked for.
  page: z.preprocess(unset, z.coerce.number().int().min(1).max(10_000).default(1)),
  // A full page of catalog cards. The maximum is the largest page the grid is
  // laid out for; a caller who wants more asks for the next page.
  pageSize: z.preprocess(unset, z.coerce.number().int().min(1).max(96).default(48)),
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
 * One of the catalog's query parameters, named by its own schema field.
 *
 * It is `keyof CatalogQuery` rather than a union written out here, so the
 * vocabulary a rejection is reported in cannot drift from the vocabulary the
 * query string, the schema and the service already share. A consumer that
 * turns a rejected parameter into words for a reader therefore declares its
 * wording against this type and is told by the compiler when a parameter is
 * added, renamed or removed.
 */
export type CatalogQueryParameter = keyof CatalogQuery;

/**
 * Where each parameter sits in the order a rejection is reported in.
 *
 * The order is this module's own declaration order - the two filters, then the
 * ordering, then the page window - and it exists so that what a reader is told
 * is a function of the address rather than of the order Zod happened to collect
 * its issues in. Two addresses that fail the same way therefore produce the same
 * sentence, whichever parameter tripped first.
 *
 * `Record<CatalogQueryParameter, number>` is the compile check that keeps this
 * map honest in both directions: every parameter has to appear, so a field
 * added to the schema cannot be silently unreportable, and a name no parameter
 * carries cannot be added. That is stronger than an ordered tuple of names,
 * which catches the invented name but not the forgotten one.
 */
const order: Record<CatalogQueryParameter, number> = {
  categorySlug: 1,
  search: 2,
  sort: 3,
  page: 4,
  pageSize: 5,
};

/**
 * Whether `name` is one of the catalog's parameters.
 *
 * The test is membership of {@link order}, which `Record<CatalogQueryParameter,
 * …>` holds to exactly the fields `catalogQuerySchema` declares, so the guard
 * cannot claim a name the schema does not know or miss one it does.
 *
 * @param name The first segment of a Zod issue's path, or a key off the raw
 * query string.
 * @returns `true` when the name is a parameter this module declares.
 */
function parameter(name: string): name is CatalogQueryParameter {
  return Object.hasOwn(order, name);
}

/**
 * The parameter names in `names`, deduplicated and in reporting order.
 *
 * A name no parameter carries is dropped rather than reported: the only names
 * that reach here come from this schema's own issues and from the query string,
 * and a caller who appended an analytics parameter is not owed a sentence about
 * a filter this catalog does not have.
 *
 * @param names Candidate parameter names, in any order and with repeats.
 * @returns The declared parameters among them, each once, ordered by
 * {@link order}.
 */
function reported(names: Iterable<string>): CatalogQueryParameter[] {
  const declared = new Set<CatalogQueryParameter>();

  for (const name of names) {
    if (parameter(name)) {
      declared.add(name);
    }
  }

  return [...declared].sort((left, right) => order[left] - order[right]);
}

/**
 * A recovered catalog query: the listing to read, and the parameters that could
 * not be applied to it.
 *
 * The two travel together because neither is complete on its own. A query
 * without its rejections would render a listing that silently ignores part of
 * its address, and a list of rejections without a query is a diagnostic rather
 * than a page.
 */
export interface CatalogQueryResult {
  /** The query to read the catalog with; complete, whatever the caller sent. */
  readonly query: CatalogQueryInput;

  /**
   * The parameters the caller stated that could not be applied, in reporting
   * order, and empty when the whole query was accepted. Each one fell back to
   * its own declared default or to absence, so the query above is a listing
   * that exists rather than the address as it was written.
   */
  readonly rejected: readonly CatalogQueryParameter[];
}

/**
 * Parses a catalog query field by field, keeping every parameter that is valid
 * and reporting the ones that are not.
 *
 * WHY THIS EXISTS BESIDE THE SCHEMA'S OWN PARSE
 * `catalogQuerySchema` judges a query as one value: a single rejected field
 * fails the whole object, which is exactly right for `GET /api/products`. A
 * caller of an endpoint wants the 400 - it names the parameter it could not
 * accept, and inventing a page for a request that was not made would hide a
 * caller's bug behind a plausible answer. That is why the route handler keeps
 * the throwing `catalogQuerySchema.parse(...)` and does not call this function.
 *
 * A page is the other case. A reader who followed a link that a mail client
 * truncated, or that carried a parameter from an older version of this
 * storefront, wants the catalog - so the valid parameters of that address are
 * applied rather than discarded along with the invalid one, and the reader is
 * told, in the page, which part of the address did not take effect. Both halves
 * matter: recovering without reporting is how an address and a listing come to
 * contradict each other silently.
 *
 * HOW IT RECOVERS
 * Deterministically, and on top of the one schema rather than beside it, so no
 * bound, default or refinement is restated here. The whole record is parsed
 * first, which is the ordinary case and costs one parse. On failure, the first
 * path segment of every issue names the field that failed; those keys are
 * removed from the record and it is parsed again, so each failed parameter
 * falls back to its own declared default or to absence while every other
 * parameter the caller stated survives untouched.
 *
 * The second parse cannot normally fail - every field either defaults or is
 * optional, and every field that objected has been removed - but the function
 * is written to be total rather than to rely on that: should it fail, the query
 * is the schema's own defaults and the report names every parameter the caller
 * stated, which is the truth on that path, because a query of bare defaults
 * applied none of them.
 *
 * @param raw The query string as a record of single values, exactly the shape
 * {@link catalogQuerySchema} reads. Keys this module does not declare are
 * carried in and dropped by the schema.
 * @returns The query to read the catalog with, and the parameters that could
 * not be applied.
 */
export function parseCatalogQuery(raw: Record<string, string>): CatalogQueryResult {
  const requested = catalogQuerySchema.safeParse(raw);

  if (requested.success) {
    return { query: requested.data, rejected: [] };
  }

  const failed = new Set<string>();

  for (const issue of requested.error.issues) {
    const [first] = issue.path;

    // A field's issue carries that field's name as its first path segment. The
    // type check is what keeps the set of names a set of names: a path may hold
    // an index or a symbol for nested shapes, and this schema's fields are flat
    // strings.
    if (typeof first === 'string') {
      failed.add(first);
    }
  }

  const retained: Record<string, string> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!failed.has(key)) {
      retained[key] = value;
    }
  }

  const recovered = catalogQuerySchema.safeParse(retained);

  if (recovered.success) {
    return { query: recovered.data, rejected: reported(failed) };
  }

  return {
    query: catalogQuerySchema.parse({}),
    rejected: reported([...Object.keys(raw), ...failed]),
  };
}

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
