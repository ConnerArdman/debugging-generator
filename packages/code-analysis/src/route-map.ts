/**
 * The product's only URL ↔ route-file mapper.
 *
 * Two questions are asked of this module constantly, and both have to have
 * exactly one answer in the whole product:
 *
 * 1. **"Which file serves this URL?"** — a captured `http.server` span carries
 *    a request path and nothing else, and a developer clicking it expects to
 *    land in the module that answered it. The same question is behind
 *    `./graph/query.ts`'s `routeForUrl` and `handlersFor`, and behind the
 *    problem-understanding stage's attempt to turn "the page at `/<segment>`
 *    is slow" into a file to investigate.
 * 2. **"What is the URL of this file?"** — the route inventory `./summary.ts`
 *    reports, and the `routePath` every `api-route` node carries out of
 *    `./extractors/api-routes.ts`.
 *
 * Both answers come from one algorithm, {@link deriveRouteFromFile}, which is
 * why that function is exported: `./extractors/api-routes.ts` **imports it**
 * rather than re-implementing the derivation. A second implementation would be
 * a second answer to "what path is this file", and the two would disagree on
 * the first route group, parallel slot or optional catch-all they met —
 * silently, in a panel, weeks later. `./graph/types.ts` records the same
 * division of labour from the other side: it declares the vocabulary
 * (`RouterKind`, `ApiRouteKind`, `HTTP_METHOD_NAMES`) and states that this
 * module owns the derivation.
 *
 * This module is also the origin of every `SourceLocation` whose `resolvedBy`
 * is `"route-map"` (AAP 0.2.3): the third of the four resolution routes, ahead
 * of the source-map and React-owner routes and behind a patch's own recorded
 * position.
 *
 * ## What it knows about, and what it deliberately does not
 *
 * The two routing conventions of the supported stack:
 *
 * - **App Router** (`app/` or `src/app/`): a `route.*` module is a request
 *   handler and a `page.*` module renders; the URL is the directory path the
 *   module sits in, with route groups `(group)` and parallel slots `@slot`
 *   contributing nothing, `[param]` / `[...param]` / `[[...param]]`
 *   contributing a dynamic, catch-all or optional catch-all segment, and a
 *   private `_folder` making the file unroutable altogether.
 * - **Pages Router** (`pages/` or `src/pages/`): a module under `api/` is a
 *   request handler whose default export *is* the route, everything else is a
 *   page, and `index` collapses to its directory.
 *
 * Both may be present in one project — a migration in progress is the normal
 * state of a real codebase, not an edge case — so entries from both appear in
 * the same {@link RouteMap} and carry their own `router`.
 *
 * Four things are refused rather than guessed at, and each refusal is a
 * deliberate `undefined`:
 *
 * - **Intercepting routes** (`(.)`, `(..)`, `(...)`, `(..)(..)`). Their served
 *   URL depends on where the interception is *rendered from*, which is a piece
 *   of runtime context a static path has no access to. Claiming a URL for one
 *   would attribute a captured span to the wrong module, so v1 treats such a
 *   file as unroutable and the route simply does not appear in the map.
 * - **A malformed bracket segment** (`[`, `[]`, `[...]`, `[a][b]`). A segment
 *   that is not one of the three legal dynamic forms has no knowable URL
 *   contribution.
 * - **A catch-all that is not the last URL segment.** The framework rejects it
 *   too; matching it would mean inventing a rule nobody implements.
 * - **A path this module cannot vouch for**: absolute, drive-lettered, or
 *   carrying a surviving `..` segment. Every file is identified by its
 *   **project-relative POSIX** path, checked with `isSafeRelativePath`, and no
 *   absolute path is ever emitted — a location that reaches a panel, a prompt
 *   or an editor must not carry a developer's directory layout.
 *
 * ## Purity, and the one impure half
 *
 * {@link deriveRouteFromFile} and {@link matchRoute} are pure string
 * functions: no filesystem, no ts-morph, no clock. That is what lets the
 * algorithm be pinned by a table of cases independently of any fixture, and
 * what lets {@link routeMapFromIndex} rebuild a working map from a persisted
 * `CodeIndex` — a reopened session in the local service holds the serialised
 * index and no compiler at all.
 *
 * {@link buildRouteMap} is the half that reads syntax: it asks each derived
 * handler module which HTTP methods it exports and where they are declared.
 * Even that reads nothing from disk of its own — every `SourceFile` it touches
 * was already loaded by `./project.ts`, which is the module that owns the file
 * set and the guarantee that environment files are never read.
 *
 * ## Method reporting
 *
 * | Module | `methods` |
 * | --- | --- |
 * | App Router `route.*` with named method exports | one per export, in source order |
 * | App Router `route.*` with no method export | `[]` — a finding, not a normal state |
 * | Pages Router `api/**` with a default export | `['ANY']`, which matches every method |
 * | Pages Router `api/**` with no default export | `[]` |
 * | `page.*` in either router | `['GET']` — a document request is the only thing a page answers |
 *
 * `ANY` is not an HTTP method; it is what a single entry point that dispatches
 * internally reports, so a consumer asking "does this route answer a `POST`?"
 * treats it as a match. {@link matchRoute} does exactly that.
 *
 * @see ./project.ts for how the files this module reads are chosen.
 * @see ./graph/types.ts for the vocabulary and the `api-route` node payload.
 */

import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  basenamePosix,
  extnamePosix,
  isSafeRelativePath,
  joinPosix,
  noopLogger,
  normalizePosix,
  toPosix,
} from '@debuggen/shared';
import type { Logger, SourceLocation } from '@debuggen/shared';
import { Node } from 'ts-morph';
import type { SourceFile } from 'ts-morph';

import { HTTP_METHOD_NAMES } from './graph/types.js';
import type {
  ApiRouteKind,
  CodeIndex,
  CodeNodeOf,
  HttpMethodName,
  RouterKind,
} from './graph/types.js';
import type { LoadedProject } from './project.js';

/**
 * The project-wide router reading, re-exported from the module that declares
 * it.
 *
 * Re-exported rather than redeclared — the same declaration, so a barrel that
 * star-exports both this module and `./graph/types.js` sees one symbol and no
 * ambiguity. Note the distinction the two names carry: `RouterStyle` is the
 * *project* reading `./summary.ts` reports and includes `hybrid` and `none`,
 * while a single route's router is a {@link RouterKind} — which is the type
 * {@link DerivedRoute.router} uses, because that value is copied straight onto
 * an `api-route` node.
 */
export type { RouterStyle } from './graph/types.js';

/**
 * Whether a route module is a request handler or a page.
 *
 * An alias of `ApiRouteKind` from `./graph/types.js` rather than a second
 * union: the value is copied onto an `api-route` node unchanged, so the two
 * cannot be allowed to drift.
 */
export type RouteEntryKind = ApiRouteKind;

/**
 * One HTTP method a route can declare, plus the wildcard `ANY`.
 *
 * An alias of `HttpMethodName` from `./graph/types.js`, for the same reason
 * {@link RouteEntryKind} is an alias. `ANY` is what a single dispatching entry
 * point reports and matches every method — see the method table on this
 * module.
 */
export type HttpMethod = HttpMethodName;

/**
 * What one URL segment of a route contributes.
 *
 * - `static` — a literal segment that must match byte for byte.
 * - `dynamic` — `[param]`, matching exactly one non-empty segment.
 * - `catch-all` — `[...param]`, matching one or more segments.
 * - `optional-catch-all` — `[[...param]]`, matching zero or more segments, so
 *   it also matches its own parent path.
 *
 * The order above is the specificity order {@link matchRoute} resolves
 * ambiguity with: static beats dynamic beats catch-all beats optional
 * catch-all.
 */
export type RouteSegmentKind = 'static' | 'dynamic' | 'catch-all' | 'optional-catch-all';

/**
 * One URL segment of a route, as written in the file path.
 *
 * Route groups, parallel slots and the file name itself are *not* segments —
 * they contribute nothing to the URL — so the segments of a route are exactly
 * the pieces of its {@link DerivedRoute.routePath}, in order.
 */
export interface RouteSegment {
  /**
   * The segment exactly as it appears in the URL path, brackets included:
   * `'items'`, `'[id]'`, `'[...rest]'`, `'[[...rest]]'`.
   */
  readonly raw: string;

  /** What the segment matches. See {@link RouteSegmentKind}. */
  readonly kind: RouteSegmentKind;

  /**
   * The parameter name a dynamic or catch-all segment captures under.
   *
   * Absent — never present and empty — for a `static` segment, which captures
   * nothing.
   */
  readonly param?: string;
}

/**
 * A route derived from a file path alone: no syntax read, no filesystem
 * touched.
 *
 * This is the whole of what a path can tell you. What it cannot tell you —
 * which HTTP methods the module exports and where they are declared — is what
 * {@link RouteEntry} adds.
 */
export interface DerivedRoute {
  /**
   * The URL this route answers: POSIX, always leading `/`, never a trailing
   * `/` except for the root, with dynamic segments left in their bracket form
   * (`'/api/<segment>/[id]'`) and route groups removed.
   */
  readonly routePath: string;

  /** Which convention the module belongs to. */
  readonly router: RouterKind;

  /** Whether the module answers requests or renders a document. */
  readonly kind: RouteEntryKind;

  /**
   * The module's **project-relative POSIX** path, normalised — the form every
   * node, location and message in the product carries.
   */
  readonly file: string;

  /** The route's URL segments, in URL order. Empty for the root route. */
  readonly segments: readonly RouteSegment[];

  /**
   * The names of the parameters this route captures, in URL order.
   *
   * Derived from {@link DerivedRoute.segments} so a consumer that only needs
   * the names does not have to filter them out itself.
   */
  readonly dynamicParams: readonly string[];

  /**
   * Whether the route ends in a catch-all of either kind, and therefore
   * captures a variable number of trailing segments.
   */
  readonly isCatchAll: boolean;

  /**
   * Whether that catch-all is the optional form, and therefore also matches
   * the route's own parent path with no captured segment at all.
   */
  readonly isOptionalCatchAll: boolean;
}

/**
 * A derived route plus what reading the module told us: the methods it answers
 * and where to open it.
 */
export interface RouteEntry extends DerivedRoute {
  /**
   * The methods this route answers. See the method table on this module for
   * what each module shape reports, and why `[]` is a finding.
   */
  readonly methods: readonly HttpMethod[];

  /**
   * Where to open the route: the first handler declaration for a request
   * handler, the default export for a page, and line 1 column 1 for a module
   * whose handler could not be located.
   *
   * Always `resolvedBy: 'route-map'` with the confidence that route reports by
   * default, because this module is that route.
   */
  readonly location: SourceLocation;

  /**
   * Where each individual method handler is declared, keyed by method name.
   *
   * Absent rather than empty when nothing was located — and absent entirely
   * for a map rebuilt by {@link routeMapFromIndex}, which has no syntax to
   * read. Keyed by `string` rather than by {@link HttpMethod} because it is a
   * partial record: a route that exports only `GET` has one key.
   */
  readonly methodLocations?: Readonly<Record<string, SourceLocation>>;
}

/**
 * A resolved request: which route answered, what it captured, and the
 * normalised path it answered for.
 */
export interface RouteMatch {
  /** The route that matched. */
  readonly entry: RouteEntry;

  /**
   * The captured parameters: a string for a dynamic segment, an array of the
   * remaining segments for a catch-all of either kind (empty only for an
   * optional catch-all matching its parent path). Values are
   * percent-**decoded**.
   */
  readonly params: Readonly<Record<string, string | readonly string[]>>;

  /**
   * The pathname that was matched, normalised: percent-decoded, no query, no
   * fragment, no trailing slash, always leading `/`.
   */
  readonly pathname: string;
}

/**
 * Every route of one project, and the resolver over them.
 *
 * Built either from a loaded project ({@link buildRouteMap}) or from a
 * persisted index ({@link routeMapFromIndex}); both produce the same
 * resolution behaviour, which is asserted in the sibling `route-map.test.ts`.
 */
export interface RouteMap {
  /**
   * Every route, in a deterministic order: by `routePath`, then App Router
   * before Pages Router, then request handler before page, then by `file`.
   *
   * Frozen and shared — the same array instance on every read.
   */
  readonly entries: readonly RouteEntry[];

  /**
   * Resolves a request to the route that answers it, or `undefined` when
   * nothing does.
   *
   * @param urlOrPathname An absolute URL or a bare pathname, with or without a
   * query string, a fragment or a trailing slash. A malformed URL resolves to
   * `undefined` rather than throwing.
   * @param method The method to require, when the caller knows it. `ANY`, and
   * a route that declares no method at all, match everything.
   * @returns The match, or `undefined`.
   */
  resolve(urlOrPathname: string, method?: HttpMethod): RouteMatch | undefined;
}

/**
 * Where the route trees of a project live, when they are not in the
 * conventional places.
 *
 * Both members spell `| undefined` explicitly because the repository compiles
 * with `exactOptionalPropertyTypes`: a caller forwarding a value it received
 * as `string | undefined` must be able to pass it through without branching.
 */
export interface DeriveRouteOptions {
  /**
   * The App Router directory, project-relative (`'app'`, `'src/app'`,
   * `'apps/web/app'`).
   *
   * When omitted, `app` and then `src/app` are probed — the two conventional
   * locations. When given, it is the *only* App Router directory considered,
   * so a file under a different one is not an App Router route.
   */
  readonly appDir?: string | undefined;

  /**
   * The Pages Router directory, project-relative. Probed as `pages` and then
   * `src/pages` when omitted, with the same exclusivity when given.
   */
  readonly pagesDir?: string | undefined;
}

/**
 * How to build a route map from a loaded project.
 */
export interface BuildRouteMapOptions extends DeriveRouteOptions {
  /**
   * Where to report what was found and what collided.
   *
   * Defaults to `noopLogger`, so a library caller that has not chosen a
   * logging backend gets silence rather than console output. Route paths and
   * project-relative file paths are logged; file *contents* never are.
   */
  readonly logger?: Logger | undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Vocabulary
 * ---------------------------------------------------------------------------------------------- */

/** The POSIX path separator, and the URL path separator, spelled once. */
const SEPARATOR = '/';

/** The root route, which is also what a route with no URL segment resolves to. */
const ROOT_ROUTE_PATH = SEPARATOR;

/**
 * Where an App Router tree conventionally lives, in probe order.
 *
 * Both are supported because both are conventional and a project picks one:
 * `src/app` when the application keeps its sources under `src`, `app` when it
 * does not. Probing `app` first costs nothing — the two cannot both match one
 * path.
 */
const APP_DIRECTORY_CANDIDATES: readonly string[] = Object.freeze(['app', 'src/app']);

/** Where a Pages Router tree conventionally lives, in probe order. */
const PAGES_DIRECTORY_CANDIDATES: readonly string[] = Object.freeze(['pages', 'src/pages']);

/**
 * The extensions an App Router `route.*` or `page.*` module may carry.
 *
 * The same set the indexer reads (`INDEXABLE_EXTENSIONS` in `./project.ts`):
 * TypeScript, its two explicit module flavours, JSX and the JavaScript
 * equivalents. A route module written in JavaScript is ordinary in a project
 * that has not finished migrating, and refusing it would silently drop the
 * route from the map.
 */
const APP_ROUTE_EXTENSIONS: readonly string[] = Object.freeze([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

/**
 * The extensions a Pages Router module may carry.
 *
 * Narrower than the App Router set on purpose: the framework's default page
 * extensions are `tsx`, `ts`, `jsx` and `js`, and a `.mjs`/`.cjs` file under
 * `pages/` is not served. Treating one as a route would invent a URL that
 * answers nothing.
 */
const PAGES_ROUTE_EXTENSIONS: readonly string[] = Object.freeze(['.ts', '.tsx', '.js', '.jsx']);

/** The App Router file name that makes a directory a request handler. */
const APP_HANDLER_STEM = 'route';

/** The App Router file name that makes a directory a page. */
const APP_PAGE_STEM = 'page';

/** The file name that collapses to its own directory in the Pages Router. */
const PAGES_INDEX_STEM = 'index';

/**
 * The Pages Router file name that is a framework hook rather than a route.
 *
 * `_app`, `_document` and `_error` need no entry here: every name beginning
 * with `_` is refused as private, which is the same rule the App Router uses
 * for a `_folder`.
 */
const PAGES_MIDDLEWARE_STEM = 'middleware';

/** The directory under a Pages Router tree whose modules answer requests. */
const PAGES_API_SEGMENT = 'api';

/**
 * The methods a route module can declare by exporting a handler of that name.
 *
 * Derived from `HTTP_METHOD_NAMES` in `./graph/types.js` minus `ANY`, which is
 * not an HTTP method and is never exported: it is what a single dispatching
 * entry point *reports*. Deriving it keeps one vocabulary — adding a method
 * there adds it here in the same edit.
 */
const EXPORTABLE_METHODS: ReadonlySet<HttpMethod> = new Set(
  HTTP_METHOD_NAMES.filter((method) => method !== 'ANY'),
);

/** What a page reports: a document request is the only thing it answers. */
const PAGE_METHODS: readonly HttpMethod[] = Object.freeze<HttpMethod[]>(['GET']);

/** What a single dispatching entry point reports. See the method table above. */
const DISPATCHING_METHODS: readonly HttpMethod[] = Object.freeze<HttpMethod[]>(['ANY']);

/** The methods of a route module that exports no handler at all: a finding. */
const NO_METHODS: readonly HttpMethod[] = Object.freeze<HttpMethod[]>([]);

/**
 * The marker {@link classifyAppDirectorySegment} returns for a directory that
 * is legal but contributes nothing to the URL.
 *
 * A distinct sentinel rather than `undefined`, because `undefined` already
 * means "this file is not routable at all" and conflating the two would turn
 * every route group into a dropped route.
 */
const SKIPPED_SEGMENT = Symbol('debuggen.route-map.skipped-segment');

/** The name a default export is spelled with in an export specifier. */
const DEFAULT_EXPORT_NAME = 'default';

/**
 * How specific each segment kind is, higher being more specific.
 *
 * The order stated on {@link RouteSegmentKind}, expressed as the numbers that
 * order it. {@link matchRoute} compares two candidates segment by segment with
 * these ranks, which is how a static route beats a dynamic sibling and a
 * dynamic one beats a catch-all.
 */
const SEGMENT_RANK: Readonly<Record<RouteSegmentKind, number>> = Object.freeze({
  static: 3,
  dynamic: 2,
  'catch-all': 1,
  'optional-catch-all': 0,
});

/**
 * The rank of "this route has no segment here at all".
 *
 * Above every real rank, so a route that matched the request exactly beats one
 * that needed a catch-all to swallow the same suffix: `/<segment>` beats
 * `/<segment>/[[...rest]]` for the request `/<segment>`.
 */
const EXHAUSTED_RANK = 4;

/** App Router entries win an exact route-path collision; see {@link buildRouteMap}. */
const ROUTER_RANK: Readonly<Record<RouterKind, number>> = Object.freeze({ app: 0, pages: 1 });

/** A request handler is preferred over a page at the same path and specificity. */
const KIND_RANK: Readonly<Record<RouteEntryKind, number>> = Object.freeze({
  'route-handler': 0,
  page: 1,
});

/**
 * A scheme prefix, which is what distinguishes an absolute URL from a bare
 * pathname.
 *
 * Deliberately not `startsWith('http')`: a dev server may be reached over any
 * scheme a browser reports, and the grammar here is the URL standard's own
 * (letter, then letters, digits, `+`, `-`, `.`, then `:`).
 */
const SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

/**
 * An intercepting-route marker at the start of a segment: `(.)`, `(..)`,
 * `(...)` and, by the same prefix, `(..)(..)`.
 *
 * Matched as a prefix rather than as a whole segment because the marker
 * decorates a name (`(..)<segment>`). See this module's note on why an
 * intercepting route is refused rather than guessed at.
 */
const INTERCEPTING_PREFIX = /^\(\.{1,3}\)/;

/**
 * A legal parameter name: anything that is not a separator, a bracket, a dot
 * or whitespace.
 *
 * Permissive on purpose. A parameter name reaches application code as an
 * object key, so a hyphen or a non-ASCII letter is legal there and this module
 * has no business rejecting it; what it must reject is a name that would make
 * the segment ambiguous — a nested bracket, an embedded separator, or the dots
 * that spell a catch-all.
 */
const PARAM_NAME = /^[^[\].\s/]+$/;

/* -------------------------------------------------------------------------------------------------
 * Derivation: the pure algorithm
 * ---------------------------------------------------------------------------------------------- */

/**
 * Derives the route a file serves from its path alone.
 *
 * Pure: no filesystem, no ts-morph, no syntax. Given the project-relative path
 * of a module it answers what URL that module answers, which router it belongs
 * to and what its segments are — or `undefined` when the file is not a route
 * at all.
 *
 * `undefined` is the answer for every one of these, and the list is the whole
 * of it:
 *
 * - a path outside the App Router and Pages Router trees (a component, a
 *   service, a configuration module);
 * - an App Router file whose name is not `route.*` or `page.*` — which covers
 *   `layout.*`, `loading.*`, `error.*`, `not-found.*`, `template.*`,
 *   `default.*`, `global-error.*`, `middleware.*`, `instrumentation.*`,
 *   `opengraph-image.*`, `sitemap.*`, `robots.*`, `manifest.*` and anything
 *   else a framework adds later, because the rule is stated positively;
 * - a Pages Router file named `_app.*`, `_document.*`, `_error.*`,
 *   `middleware.*` or any other `_`-prefixed name, and a dotfile;
 * - a file below a private `_folder` in either tree;
 * - an intercepting route, a malformed bracket segment, a catch-all that is
 *   not last, or an unsupported extension;
 * - a path that is absolute, drive-lettered or escapes the project.
 *
 * @param projectRelativeFile The module's path, relative to the project root.
 * Accepted with either separator style and normalised before use; an absolute
 * path is refused rather than repaired.
 * @param options Where the route trees live, when they are not in the
 * conventional places.
 * @returns The derived route, or `undefined` when the file serves no URL.
 *
 * @example
 * ```ts
 * deriveRouteFromFile('app/api/<segment>/route.ts')?.routePath; // '/api/<segment>'
 * deriveRouteFromFile('app/(group)/<segment>/[id]/page.tsx')?.routePath; // '/<segment>/[id]'
 * deriveRouteFromFile('app/layout.tsx'); // undefined
 * ```
 */
export function deriveRouteFromFile(
  projectRelativeFile: string,
  options?: DeriveRouteOptions,
): DerivedRoute | undefined {
  const file = normalizeRouteFile(projectRelativeFile);
  if (file === undefined) {
    return undefined;
  }

  for (const directory of candidateDirectories(options?.appDir, APP_DIRECTORY_CANDIDATES)) {
    const rest = relativeToDirectory(file, directory);
    if (rest !== undefined) {
      return deriveAppRoute(file, rest);
    }
  }

  for (const directory of candidateDirectories(options?.pagesDir, PAGES_DIRECTORY_CANDIDATES)) {
    const rest = relativeToDirectory(file, directory);
    if (rest !== undefined) {
      return derivePagesRoute(file, rest);
    }
  }

  return undefined;
}

/**
 * Normalises a candidate file path and refuses one this module cannot vouch
 * for.
 *
 * Separators are converted first, so a path that arrived from a Windows host
 * is understood rather than refused for its slashes, and the result is checked
 * with `isSafeRelativePath`: no absolute or drive-lettered path, no surviving
 * `..`, no control character. Every path that leaves this module — a
 * `DerivedRoute.file`, a `SourceLocation.file` — has been through here.
 *
 * @param candidate The path as the caller spelled it.
 * @returns The normalised project-relative POSIX path, or `undefined`.
 */
function normalizeRouteFile(candidate: string): string | undefined {
  const normalized = normalizePosix(toPosix(candidate));
  return isSafeRelativePath(normalized) ? normalized : undefined;
}

/**
 * The directories to probe for one router: the caller's, or the conventional
 * ones.
 *
 * A caller-supplied directory is exclusive — naming `src/app` means a file
 * under `app/` is not an App Router route — because a project with both trees
 * would otherwise have every module counted twice. A supplied directory that
 * is not a usable project-relative path yields no candidates rather than
 * falling back to the conventions, so a configuration mistake produces an
 * empty map instead of a plausible wrong one.
 *
 * @param requested The caller's directory, or `undefined`.
 * @param conventional The directories to probe when the caller named none.
 * @returns The directories to probe, in order.
 */
function candidateDirectories(
  requested: string | undefined,
  conventional: readonly string[],
): readonly string[] {
  if (requested === undefined) {
    return conventional;
  }
  const normalized = normalizeRouteFile(requested);
  return normalized === undefined ? [] : [normalized];
}

/**
 * The part of `file` below `directory`, or `undefined` when it is not below
 * it.
 *
 * A segment-boundary test, not a string prefix test: `application/page.tsx` is
 * not below `app`. The directory itself is not "below itself", so a file whose
 * whole path *is* the directory is refused too.
 *
 * @param file A normalised project-relative path.
 * @param directory A normalised project-relative directory path.
 * @returns The remainder of the path, with no leading separator.
 */
function relativeToDirectory(file: string, directory: string): string | undefined {
  const prefix = `${directory}${SEPARATOR}`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : undefined;
}

/**
 * The segments of a POSIX path, with empty ones dropped.
 *
 * @param path A path, absolute or relative.
 * @returns Its non-empty segments, in order.
 */
function splitSegments(path: string): readonly string[] {
  return path.split(SEPARATOR).filter((segment) => segment.length > 0);
}

/**
 * Derives an App Router route from the part of a path below the app directory.
 *
 * The URL is the *directory* the module sits in, which is the whole idea of
 * the convention: `route.*` and `page.*` are names that mark a directory as
 * routable rather than names that appear in a URL. Everything interesting is
 * therefore in {@link classifyAppDirectorySegment}, which decides what each
 * directory above the file contributes.
 *
 * @param file The module's project-relative path, normalised.
 * @param rest The part of that path below the app directory.
 * @returns The derived route, or `undefined` when the file is not routable.
 */
function deriveAppRoute(file: string, rest: string): DerivedRoute | undefined {
  const base = basenamePosix(rest);
  const extension = extnamePosix(base);
  if (!APP_ROUTE_EXTENSIONS.includes(extension)) {
    return undefined;
  }

  const stem = basenamePosix(base, extension);
  let kind: RouteEntryKind;
  if (stem === APP_HANDLER_STEM) {
    kind = 'route-handler';
  } else if (stem === APP_PAGE_STEM) {
    kind = 'page';
  } else {
    // Stated positively, so every special file the framework has now or adds
    // later - layout, loading, error, not-found, template, default,
    // global-error, middleware, instrumentation, the image and metadata
    // conventions - is non-routable without this module listing it.
    return undefined;
  }

  const segments: RouteSegment[] = [];
  for (const raw of splitSegments(rest).slice(0, -1)) {
    const classified = classifyAppDirectorySegment(raw);
    if (classified === undefined) {
      return undefined;
    }
    if (classified !== SKIPPED_SEGMENT) {
      segments.push(classified);
    }
  }

  return finishDerivation(file, 'app', kind, segments);
}

/**
 * What one directory above an App Router module contributes to its URL.
 *
 * Four outcomes:
 *
 * - `undefined` — the file is not routable: a private `_folder`, an
 *   intercepting-route marker, or a malformed bracket segment.
 * - {@link SKIPPED_SEGMENT} — a route group `(group)` or a parallel-route slot
 *   `@slot`, both of which organise the tree without appearing in the URL.
 *   The directory stays part of `file`; it just contributes no segment.
 * - A `static` segment — an ordinary directory name.
 * - A dynamic, catch-all or optional catch-all segment.
 *
 * @param raw The directory name, exactly as written on disk.
 * @returns The contribution, the skip marker, or `undefined`.
 */
function classifyAppDirectorySegment(
  raw: string,
): RouteSegment | typeof SKIPPED_SEGMENT | undefined {
  if (raw.startsWith('_')) {
    // A private folder opts its whole subtree out of routing.
    return undefined;
  }
  if (INTERCEPTING_PREFIX.test(raw)) {
    // The served URL of an intercepting route depends on where it is rendered
    // from, which a path cannot know. Refused rather than guessed at.
    return undefined;
  }
  if (raw.startsWith('(') && raw.endsWith(')')) {
    return SKIPPED_SEGMENT;
  }
  if (raw.startsWith('@')) {
    return SKIPPED_SEGMENT;
  }
  return classifySegment(raw);
}

/**
 * Derives a Pages Router route from the part of a path below the pages
 * directory.
 *
 * Unlike the App Router, the *file name* is part of the URL here, `index`
 * collapses to its own directory, and a module under `api/` answers requests
 * while everything else renders. Parentheses carry no meaning in this
 * convention, so a parenthesised directory is an ordinary static segment
 * rather than a group.
 *
 * @param file The module's project-relative path, normalised.
 * @param rest The part of that path below the pages directory.
 * @returns The derived route, or `undefined` when the file is not routable.
 */
function derivePagesRoute(file: string, rest: string): DerivedRoute | undefined {
  const base = basenamePosix(rest);
  const extension = extnamePosix(base);
  if (!PAGES_ROUTE_EXTENSIONS.includes(extension)) {
    return undefined;
  }

  const stem = basenamePosix(base, extension);
  if (stem.startsWith('_') || stem.startsWith('.') || stem === PAGES_MIDDLEWARE_STEM) {
    // `_app`, `_document`, `_error` and any other underscore-prefixed module
    // are framework hooks; a dotfile is not served; `middleware` is a request
    // interceptor rather than a route.
    return undefined;
  }

  const pathSegments = splitSegments(rest);
  const directorySegments = pathSegments.slice(0, -1);
  const kind: RouteEntryKind =
    directorySegments[0] === PAGES_API_SEGMENT ? 'route-handler' : 'page';

  const segments: RouteSegment[] = [];
  for (const raw of directorySegments) {
    if (raw.startsWith('_')) {
      return undefined;
    }
    const classified = classifySegment(raw);
    if (classified === undefined) {
      return undefined;
    }
    segments.push(classified);
  }

  if (stem !== PAGES_INDEX_STEM) {
    const classified = classifySegment(stem);
    if (classified === undefined) {
      return undefined;
    }
    segments.push(classified);
  }

  return finishDerivation(file, 'pages', kind, segments);
}

/**
 * Classifies one URL-contributing piece — a directory name in either router,
 * or a Pages Router file name — as static or as one of the three dynamic
 * forms.
 *
 * The three legal dynamic spellings are recognised exactly, longest form
 * first, and anything else that carries a bracket is refused: a segment this
 * module cannot read has no knowable URL contribution, and inventing one would
 * attribute a captured request to the wrong module.
 *
 * Brackets are read literally, because a file path carries them literally. A
 * percent-encoded bracket belongs to a URL, and by the time a URL reaches
 * {@link matchRoute} each of its segments has been decoded, so no such
 * spelling ever reaches this function.
 *
 * @param raw The piece, exactly as written on disk.
 * @returns The segment, or `undefined` when the spelling is not legal.
 */
function classifySegment(raw: string): RouteSegment | undefined {
  if (raw.length === 0) {
    return undefined;
  }

  if (raw.startsWith('[[...') && raw.endsWith(']]')) {
    return dynamicSegment(raw, 'optional-catch-all', raw.slice('[[...'.length, -']]'.length));
  }
  if (raw.startsWith('[...') && raw.endsWith(']') && !raw.endsWith(']]')) {
    return dynamicSegment(raw, 'catch-all', raw.slice('[...'.length, -']'.length));
  }
  if (raw.startsWith('[') && raw.endsWith(']') && !raw.startsWith('[[')) {
    return dynamicSegment(raw, 'dynamic', raw.slice('['.length, -']'.length));
  }
  if (raw.includes('[') || raw.includes(']')) {
    return undefined;
  }
  return Object.freeze({ raw, kind: 'static' as const });
}

/**
 * Builds a dynamic segment, refusing an unusable parameter name.
 *
 * @param raw The segment as written, brackets included.
 * @param kind Which dynamic form it is.
 * @param param The captured name, already stripped of its brackets.
 * @returns The segment, or `undefined` when the name is not usable.
 */
function dynamicSegment(
  raw: string,
  kind: Exclude<RouteSegmentKind, 'static'>,
  param: string,
): RouteSegment | undefined {
  return PARAM_NAME.test(param) ? Object.freeze({ raw, kind, param }) : undefined;
}

/**
 * Assembles a {@link DerivedRoute} from its parts, enforcing the one
 * cross-segment rule.
 *
 * That rule is the position of a catch-all: it consumes every remaining
 * segment, so anything after it could never match and the framework rejects
 * such a tree outright. A file that spells one is refused rather than given a
 * URL whose matching behaviour nobody implements.
 *
 * @param file The module's project-relative path, normalised.
 * @param router Which convention it belongs to.
 * @param kind Whether it answers requests or renders.
 * @param segments Its URL segments, in URL order.
 * @returns The frozen route, or `undefined` when a catch-all is misplaced.
 */
function finishDerivation(
  file: string,
  router: RouterKind,
  kind: RouteEntryKind,
  segments: readonly RouteSegment[],
): DerivedRoute | undefined {
  const lastIndex = segments.length - 1;
  for (const [index, segment] of segments.entries()) {
    if (isCatchAllKind(segment.kind) && index !== lastIndex) {
      return undefined;
    }
  }

  const last = segments.at(-1);
  const dynamicParams: string[] = [];
  for (const segment of segments) {
    if (segment.param !== undefined) {
      dynamicParams.push(segment.param);
    }
  }

  return Object.freeze({
    routePath: routePathOf(segments),
    router,
    kind,
    file,
    segments: Object.freeze([...segments]),
    dynamicParams: Object.freeze(dynamicParams),
    isCatchAll: last !== undefined && isCatchAllKind(last.kind),
    isOptionalCatchAll: last?.kind === 'optional-catch-all',
  });
}

/**
 * Whether a segment kind consumes the remainder of a request path.
 *
 * @param kind The segment kind.
 * @returns `true` for both catch-all forms.
 */
function isCatchAllKind(kind: RouteSegmentKind): boolean {
  return kind === 'catch-all' || kind === 'optional-catch-all';
}

/**
 * The URL path of a list of segments: leading `/`, no trailing `/`, bracket
 * forms preserved.
 *
 * Built with `joinPosix` so the separator arithmetic is the shared
 * implementation's rather than this module's. Nothing a segment can hold makes
 * that normalisation lossy: a directory can be named neither `.` nor `..`, and
 * a bracket form contains no separator, both of which
 * {@link classifySegment} has already established.
 *
 * @param segments The route's segments, in URL order.
 * @returns The route path; the root when there are no segments.
 */
function routePathOf(segments: readonly RouteSegment[]): string {
  if (segments.length === 0) {
    return ROOT_ROUTE_PATH;
  }
  return joinPosix(SEPARATOR, ...segments.map((segment) => segment.raw));
}

/* -------------------------------------------------------------------------------------------------
 * Matching
 * ---------------------------------------------------------------------------------------------- */

/**
 * Resolves a request to the route that answers it.
 *
 * Pure, and the single implementation behind every {@link RouteMap.resolve} —
 * a map built from a loaded project and one rebuilt from a persisted index
 * share this function, which is what makes their behaviour identical rather
 * than merely similar.
 *
 * The input may be an absolute URL or a bare pathname, with a query string, a
 * fragment or a trailing slash. It is reduced to a list of segments:
 *
 * - an input carrying a scheme is parsed with the global `URL`, and a
 *   malformed one yields `undefined` rather than an exception — the caller is
 *   handling a captured span attribute or a value typed into a user interface,
 *   neither of which is trustworthy;
 * - a bare pathname is truncated at its first `?` or `#` and normalised
 *   lexically, so `.` and `..` are resolved exactly as a URL parser would;
 * - segments are split **before** they are percent-decoded, so an encoded
 *   separator (`%2F`) stays inside one segment instead of splitting it — the
 *   difference between one parameter holding `'a/b'` and a path of two
 *   segments;
 * - a malformed percent sequence yields `undefined` for the same reason a
 *   malformed URL does;
 * - matching is **case-sensitive**, because the framework's routing is.
 *
 * Among the routes that match, the most specific wins: segment by segment,
 * static beats dynamic beats catch-all beats optional catch-all, and an
 * exhausted route (one that needed no catch-all at all) beats one that
 * swallowed the same suffix. Remaining ties are broken deterministically —
 * longer static prefix, then App Router before Pages Router, then request
 * handler before page, then the lexicographically smaller `file` — so the same
 * project always resolves the same way.
 *
 * @param entries The routes to consider; order is irrelevant to the outcome.
 * @param pathname An absolute URL or a bare pathname.
 * @param method The method to require. `ANY`, and a route that declares no
 * method at all, match everything.
 * @returns The match, or `undefined` when nothing answers.
 */
export function matchRoute(
  entries: readonly RouteEntry[],
  pathname: string,
  method?: HttpMethod,
): RouteMatch | undefined {
  const requestSegments = parseRequestPath(pathname);
  if (requestSegments === undefined) {
    return undefined;
  }

  const normalizedPathname =
    requestSegments.length === 0
      ? ROOT_ROUTE_PATH
      : `${SEPARATOR}${requestSegments.join(SEPARATOR)}`;

  let best: RouteEntry | undefined;
  let bestParams: Readonly<Record<string, string | readonly string[]>> | undefined;

  for (const entry of entries) {
    if (!methodMatches(entry, method)) {
      continue;
    }
    const params = matchSegments(entry.segments, requestSegments);
    if (params === undefined) {
      continue;
    }
    if (best === undefined || compareCandidates(entry, best) < 0) {
      best = entry;
      bestParams = params;
    }
  }

  if (best === undefined || bestParams === undefined) {
    return undefined;
  }

  return Object.freeze({ entry: best, params: bestParams, pathname: normalizedPathname });
}

/**
 * Reduces a URL or pathname to the decoded segments matching works on.
 *
 * See {@link matchRoute} for the rules and why each one is what it is. The
 * function never throws: both parsing steps that can fail are guarded, and
 * every failure is the same `undefined`.
 *
 * @param input An absolute URL or a bare pathname.
 * @returns The decoded, non-empty segments, or `undefined` when the input
 * cannot be read as a path.
 */
function parseRequestPath(input: string): readonly string[] | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  let rawPath: string;
  if (SCHEME_PREFIX.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    rawPath = parsed.pathname;
  } else {
    // A bare pathname may still carry a query or a fragment; both end the
    // path. `??` is not usable here because `-1` is a legitimate "not found".
    const queryAt = trimmed.indexOf('?');
    const fragmentAt = trimmed.indexOf('#');
    const candidates = [queryAt, fragmentAt].filter((at) => at >= 0);
    rawPath = candidates.length === 0 ? trimmed : trimmed.slice(0, Math.min(...candidates));
  }

  // `normalizePosix` answers `'.'` for a path that reduces to nothing, which a
  // URL with an empty pathname (a non-special scheme) and a bare `'.'` both
  // do. Both mean the root, not a request for a segment literally named `'.'`.
  const normalized = normalizePosix(rawPath);
  const rawSegments = normalized === '.' ? [] : splitSegments(normalized);

  const decoded: string[] = [];
  for (const segment of rawSegments) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    decoded.push(value);
  }

  return decoded;
}

/**
 * Matches one route's segments against a request's segments, capturing
 * parameters.
 *
 * A dynamic segment requires exactly one non-empty segment; a catch-all
 * requires at least one and takes every one that remains; an optional
 * catch-all takes what remains and is content with nothing. A route matches
 * only when the request is fully consumed, which is what stops
 * `/<segment>/[id]` from answering `/<segment>/<id>/extra`.
 *
 * @param entrySegments The route's segments.
 * @param requestSegments The request's decoded segments.
 * @returns The captured parameters, frozen, or `undefined` when the route does
 * not match.
 */
function matchSegments(
  entrySegments: readonly RouteSegment[],
  requestSegments: readonly string[],
): Readonly<Record<string, string | readonly string[]>> | undefined {
  const params: Record<string, string | readonly string[]> = {};
  let consumed = 0;

  for (const segment of entrySegments) {
    if (segment.kind === 'static') {
      if (requestSegments[consumed] !== segment.raw) {
        return undefined;
      }
      consumed += 1;
      continue;
    }

    const param = segment.param;
    if (param === undefined) {
      // A dynamic segment without a name cannot capture. Unreachable through
      // this module's own derivation, and refused rather than trusted for an
      // entry that arrived from a persisted index.
      return undefined;
    }

    if (segment.kind === 'dynamic') {
      const value = requestSegments[consumed];
      if (value === undefined || value.length === 0) {
        return undefined;
      }
      params[param] = value;
      consumed += 1;
      continue;
    }

    const rest = requestSegments.slice(consumed);
    if (segment.kind === 'catch-all' && rest.length === 0) {
      return undefined;
    }
    params[param] = Object.freeze(rest);
    consumed = requestSegments.length;
  }

  return consumed === requestSegments.length ? Object.freeze(params) : undefined;
}

/**
 * Whether a route answers the method a caller asked about.
 *
 * Three cases match unconditionally, and each is deliberate: no method was
 * asked about; the route declares no method at all (a module whose handler
 * could not be located is still the module that serves the path, and hiding it
 * would turn a finding into a missing route); or the question itself is `ANY`.
 * Otherwise the method must be declared, with a declared `ANY` matching
 * everything — which is what a single dispatching entry point reports.
 *
 * @param entry The route.
 * @param method The method asked about, or `undefined`.
 * @returns `true` when the route may answer it.
 */
function methodMatches(entry: RouteEntry, method: HttpMethod | undefined): boolean {
  if (method === undefined || entry.methods.length === 0 || method === 'ANY') {
    return true;
  }
  return entry.methods.includes(method) || entry.methods.includes('ANY');
}

/**
 * Orders two matching routes by specificity, then by the deterministic
 * tie-breakers.
 *
 * Negative means `left` answers the request; see {@link matchRoute} for the
 * order and {@link SEGMENT_RANK} and {@link EXHAUSTED_RANK} for the ranks.
 *
 * @param left One matching route.
 * @param right The other.
 * @returns A negative number when `left` wins, positive when `right` does.
 */
function compareCandidates(left: RouteEntry, right: RouteEntry): number {
  const length = Math.max(left.segments.length, right.segments.length);
  for (let index = 0; index < length; index += 1) {
    const leftRank = rankAt(left.segments, index);
    const rightRank = rankAt(right.segments, index);
    if (leftRank !== rightRank) {
      return rightRank - leftRank;
    }
  }

  const staticPrefix = staticPrefixLength(right.segments) - staticPrefixLength(left.segments);
  if (staticPrefix !== 0) {
    return staticPrefix;
  }

  const router = ROUTER_RANK[left.router] - ROUTER_RANK[right.router];
  if (router !== 0) {
    return router;
  }

  const kind = KIND_RANK[left.kind] - KIND_RANK[right.kind];
  if (kind !== 0) {
    return kind;
  }

  return compareStrings(left.file, right.file);
}

/**
 * The specificity rank of the segment at `index`, or {@link EXHAUSTED_RANK}
 * when the route has no segment there.
 *
 * @param segments A route's segments.
 * @param index The position to rank.
 * @returns The rank, higher being more specific.
 */
function rankAt(segments: readonly RouteSegment[], index: number): number {
  const segment = segments[index];
  return segment === undefined ? EXHAUSTED_RANK : SEGMENT_RANK[segment.kind];
}

/**
 * How many leading segments of a route are static.
 *
 * The tie-breaker the specificity rules name explicitly: between two routes of
 * otherwise equal shape, the one that pinned more of the path literally is the
 * more precise answer.
 *
 * @param segments A route's segments.
 * @returns The count of leading `static` segments.
 */
function staticPrefixLength(segments: readonly RouteSegment[]): number {
  let count = 0;
  for (const segment of segments) {
    if (segment.kind !== 'static') {
      break;
    }
    count += 1;
  }
  return count;
}

/**
 * Byte-wise string comparison, so an order is identical on every machine.
 *
 * `localeCompare` is deliberately not used: it is locale-sensitive, and an
 * ordering that depends on the developer's environment would make a route map
 * - and the cache key and test expectation built on it - non-reproducible.
 *
 * @param left One string.
 * @param right The other.
 * @returns `-1`, `0` or `1`.
 */
function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/* -------------------------------------------------------------------------------------------------
 * Methods and locations: the half that reads syntax
 * ---------------------------------------------------------------------------------------------- */

/**
 * One handler declaration found in a route module.
 *
 * `position` is the character offset the declaration starts at and exists only
 * to order the declarations as they appear in the source, which is the order
 * `methods` is reported in.
 */
interface HandlerDeclaration {
  /** The method the declaration answers. */
  readonly method: HttpMethod;

  /** The 1-based line the declaration starts on. */
  readonly line: number;

  /** The 1-based column the declaration starts at. */
  readonly column: number;

  /** The 1-based line the declaration ends on. */
  readonly endLine: number;

  /** The character offset the declaration starts at, for source ordering. */
  readonly position: number;
}

/**
 * A located declaration with no method attached: a default export, or nothing.
 */
interface LocatedDeclaration {
  /** The declared name, when the declaration has one. */
  readonly symbol: string | undefined;

  /** The 1-based line the declaration starts on. */
  readonly line: number;

  /** The 1-based column the declaration starts at. */
  readonly column: number;

  /** The 1-based line the declaration ends on. */
  readonly endLine: number;
}

/**
 * Completes a derived route by reading the module: which methods it answers,
 * and where each one is declared.
 *
 * Exported for the same reason {@link deriveRouteFromFile} is — one
 * implementation, two callers. `./extractors/api-routes.ts` builds its
 * `api-route` node payload from this entry (`routePath`, `router`, `kind`,
 * `methods`) rather than reading exports again, so a node's methods and a
 * route map's methods cannot disagree.
 *
 * Reads syntax only: the `SourceFile` was already loaded by `./project.ts`, no
 * path is touched, and nothing is written.
 *
 * @param sourceFile The module, as loaded by `./project.ts`.
 * @param derived What the module's path said about it.
 * @returns The complete entry, always — a module whose handler cannot be
 * located still serves its path, and reports `[]` methods and a location at
 * line 1 column 1.
 */
export function buildRouteEntry(sourceFile: SourceFile, derived: DerivedRoute): RouteEntry {
  if (derived.kind === 'page') {
    // A page renders a document; the request that reaches it is a GET whether
    // or not this module could find the component that renders it.
    return entryFromDefaultExport(sourceFile, derived, PAGE_METHODS, PAGE_METHODS);
  }

  if (derived.router === 'pages') {
    // A legacy API module dispatches on `req.method` inside one default-
    // exported function, so there is nothing per-method to enumerate. With no
    // default export there is no handler at all, which is a finding.
    return entryFromDefaultExport(sourceFile, derived, DISPATCHING_METHODS, NO_METHODS);
  }

  return appHandlerEntry(sourceFile, derived);
}

/**
 * Builds an entry for a module whose handler is its default export.
 *
 * @param sourceFile The module.
 * @param derived What its path said about it.
 * @param whenPresent The methods to report when a default export was found.
 * @param whenAbsent The methods to report when none was.
 * @returns The entry.
 */
function entryFromDefaultExport(
  sourceFile: SourceFile,
  derived: DerivedRoute,
  whenPresent: readonly HttpMethod[],
  whenAbsent: readonly HttpMethod[],
): RouteEntry {
  const declaration = findDefaultExport(sourceFile);
  const location =
    declaration === undefined
      ? fallbackLocation(derived.file)
      : sourceLocationFor(
          derived.file,
          declaration.line,
          declaration.column,
          declaration.symbol,
          declaration.endLine,
        );

  return Object.freeze({
    ...derived,
    methods: declaration === undefined ? whenAbsent : whenPresent,
    location,
  });
}

/**
 * Builds an entry for an App Router handler module, one location per exported
 * method.
 *
 * @param sourceFile The module.
 * @param derived What its path said about it.
 * @returns The entry, with `methods` in source order.
 */
function appHandlerEntry(sourceFile: SourceFile, derived: DerivedRoute): RouteEntry {
  const declarations = collectHandlerDeclarations(sourceFile);
  if (declarations.length === 0) {
    return Object.freeze({
      ...derived,
      methods: NO_METHODS,
      location: fallbackLocation(derived.file),
    });
  }

  const methodLocations: Record<string, SourceLocation> = {};
  for (const declaration of declarations) {
    methodLocations[declaration.method] = sourceLocationFor(
      derived.file,
      declaration.line,
      declaration.column,
      declaration.method,
      declaration.endLine,
    );
  }

  const first = declarations[0];
  const location =
    first === undefined
      ? fallbackLocation(derived.file)
      : sourceLocationFor(derived.file, first.line, first.column, first.method, first.endLine);

  return Object.freeze({
    ...derived,
    methods: Object.freeze(declarations.map((declaration) => declaration.method)),
    location,
    methodLocations: Object.freeze(methodLocations),
  });
}

/**
 * Every HTTP-method handler an App Router module exports, in source order.
 *
 * Three export shapes are recognised, because all three are ordinary in real
 * projects:
 *
 * - `export function GET(…)` / `export async function GET(…)` — and a
 *   function declared locally but exported through an export clause, which
 *   ts-morph reports as exported too;
 * - `export const POST = …` — the arrow form, and equally a handler produced
 *   by a wrapper (`export const POST = withSomething(handler)`), because what
 *   makes the export a handler is its *name*, not the shape of its
 *   initialiser;
 * - `export { handler as PUT }` — including a re-export from another module,
 *   whose position is then the specifier's own, so the reported location is
 *   always inside the route module a developer clicked.
 *
 * A `export * from …` clause is not followed: the methods it might carry are
 * not visible in this module's syntax, and resolving them would make the
 * answer depend on the type checker's view of another file. Such a module
 * reports no method, which is the documented finding rather than a guess.
 *
 * Duplicates collapse to their first occurrence, so a method exported twice
 * (once declared, once re-exported) is reported once, at the earlier
 * position.
 *
 * @param sourceFile The module to read.
 * @returns The declarations, ordered by position, one per method.
 */
function collectHandlerDeclarations(sourceFile: SourceFile): readonly HandlerDeclaration[] {
  const found: HandlerDeclaration[] = [];

  for (const declaration of sourceFile.getFunctions()) {
    const name = declaration.getName();
    if (!declaration.isExported() || declaration.isDefaultExport() || name === undefined) {
      continue;
    }
    if (isExportableMethod(name)) {
      found.push(
        handlerAt(sourceFile, name, declaration.getStart(), declaration.getEndLineNumber()),
      );
    }
  }

  for (const statement of sourceFile.getVariableStatements()) {
    if (!statement.isExported()) {
      continue;
    }
    const declarations = statement.getDeclarations();
    for (const declaration of declarations) {
      const name = declaration.getName();
      if (!isExportableMethod(name)) {
        continue;
      }
      // A single-declarator statement is reported from its `export` keyword,
      // which is where a developer expects to land. A statement declaring
      // several bindings has no single start that names this one, so the
      // binding's own position is used instead.
      const single = declarations.length === 1;
      const position = single ? statement.getStart() : declaration.getNameNode().getStart();
      const endLine = single ? statement.getEndLineNumber() : declaration.getEndLineNumber();
      found.push(handlerAt(sourceFile, name, position, endLine));
    }
  }

  for (const exportDeclaration of sourceFile.getExportDeclarations()) {
    for (const specifier of exportDeclaration.getNamedExports()) {
      const exportedName = specifier.getAliasNode()?.getText() ?? specifier.getName();
      if (isExportableMethod(exportedName)) {
        found.push(
          handlerAt(sourceFile, exportedName, specifier.getStart(), specifier.getEndLineNumber()),
        );
      }
    }
  }

  found.sort((left, right) => left.position - right.position);

  const seen = new Set<HttpMethod>();
  const ordered: HandlerDeclaration[] = [];
  for (const declaration of found) {
    if (seen.has(declaration.method)) {
      continue;
    }
    seen.add(declaration.method);
    ordered.push(declaration);
  }

  return ordered;
}

/**
 * Whether an exported name is an HTTP method a route handler can be declared
 * under.
 *
 * `ANY` is excluded by {@link EXPORTABLE_METHODS}: it is a report, not an
 * export.
 *
 * @param name The exported name.
 * @returns `true` when the name is a declarable method.
 */
function isExportableMethod(name: string): name is HttpMethod {
  return EXPORTABLE_METHODS.has(name as HttpMethod);
}

/**
 * Turns a method name and a character offset into a {@link HandlerDeclaration}.
 *
 * @param sourceFile The module the offset belongs to.
 * @param method The method name.
 * @param position The character offset the declaration starts at.
 * @param endLine The 1-based line the declaration ends on.
 * @returns The declaration record.
 */
function handlerAt(
  sourceFile: SourceFile,
  method: HttpMethod,
  position: number,
  endLine: number,
): HandlerDeclaration {
  const { line, column } = sourceFile.getLineAndColumnAtPos(position);
  return { method, line, column, endLine, position };
}

/**
 * The module's default export, wherever it is spelled.
 *
 * Four spellings, in the order they are probed: `export default function`,
 * `export default class`, `export default <expression>` — whose symbol is the
 * identifier's name when it is one, and absent for an inline expression — and
 * `export { X as default }`, whose symbol is the local name being exported.
 *
 * `export =` is skipped: it is a CommonJS-only form that no supported router
 * serves.
 *
 * @param sourceFile The module to read.
 * @returns The located declaration, or `undefined` when the module has no
 * default export.
 */
function findDefaultExport(sourceFile: SourceFile): LocatedDeclaration | undefined {
  for (const declaration of sourceFile.getFunctions()) {
    if (declaration.isDefaultExport()) {
      return locatedAt(
        sourceFile,
        declaration.getName(),
        declaration.getStart(),
        declaration.getEndLineNumber(),
      );
    }
  }

  for (const declaration of sourceFile.getClasses()) {
    if (declaration.isDefaultExport()) {
      return locatedAt(
        sourceFile,
        declaration.getName(),
        declaration.getStart(),
        declaration.getEndLineNumber(),
      );
    }
  }

  for (const assignment of sourceFile.getExportAssignments()) {
    if (assignment.isExportEquals()) {
      continue;
    }
    const expression = assignment.getExpression();
    const symbol = Node.isIdentifier(expression) ? expression.getText() : undefined;
    return locatedAt(sourceFile, symbol, assignment.getStart(), assignment.getEndLineNumber());
  }

  for (const exportDeclaration of sourceFile.getExportDeclarations()) {
    for (const specifier of exportDeclaration.getNamedExports()) {
      const exportedName = specifier.getAliasNode()?.getText() ?? specifier.getName();
      if (exportedName === DEFAULT_EXPORT_NAME) {
        return locatedAt(
          sourceFile,
          specifier.getName(),
          specifier.getStart(),
          specifier.getEndLineNumber(),
        );
      }
    }
  }

  return undefined;
}

/**
 * Turns a name and a character offset into a {@link LocatedDeclaration}.
 *
 * @param sourceFile The module the offset belongs to.
 * @param symbol The declared name, when there is one.
 * @param position The character offset the declaration starts at.
 * @param endLine The 1-based line the declaration ends on.
 * @returns The located declaration.
 */
function locatedAt(
  sourceFile: SourceFile,
  symbol: string | undefined,
  position: number,
  endLine: number,
): LocatedDeclaration {
  const { line, column } = sourceFile.getLineAndColumnAtPos(position);
  return { symbol, line, column, endLine };
}

/**
 * Builds the {@link SourceLocation} a route entry carries.
 *
 * Three things about it are contractual, and none of them is this module's
 * choice to make differently:
 *
 * - `file` is the project-relative POSIX path that already passed
 *   `isSafeRelativePath`, so the location satisfies the shared schema's own
 *   refinement without a second sanitisation;
 * - `line` and `column` are 1-based, clamped so a position this module could
 *   not determine becomes the start of the file rather than a `0` the schema
 *   would reject;
 * - `confidence` comes from `DEFAULT_RESOLUTION_CONFIDENCE['route-map']` and
 *   is never written as a number here — four independent resolvers share that
 *   table precisely so their numbers mean the same thing.
 *
 * `symbol` and `endLine` are omitted rather than set to `undefined`, which is
 * what `exactOptionalPropertyTypes` and the schema's "absent or a value"
 * contract require; `endLine` is also omitted when it would merely repeat
 * `line`, because a single-line declaration is a point.
 *
 * @param file The module's project-relative POSIX path.
 * @param line The 1-based start line.
 * @param column The 1-based start column.
 * @param symbol The handler or component name, when known.
 * @param endLine The 1-based end line, when known.
 * @returns The location.
 */
function sourceLocationFor(
  file: string,
  line: number,
  column: number,
  symbol: string | undefined,
  endLine: number | undefined,
): SourceLocation {
  const safeLine = clampPosition(line);
  const safeColumn = clampPosition(column);
  const safeEndLine =
    endLine === undefined ? undefined : Math.max(clampPosition(endLine), safeLine);

  return Object.freeze({
    file,
    line: safeLine,
    column: safeColumn,
    ...(symbol !== undefined && symbol.length > 0 ? { symbol } : {}),
    ...(safeEndLine !== undefined && safeEndLine > safeLine ? { endLine: safeEndLine } : {}),
    resolvedBy: 'route-map' as const,
    confidence: DEFAULT_RESOLUTION_CONFIDENCE['route-map'],
  });
}

/**
 * The location of a route module whose handler could not be located: the start
 * of the file.
 *
 * Opening the file at its first line is a worse answer than opening it at the
 * handler, and a far better one than refusing to open it — the module is still
 * the one that serves the path.
 *
 * @param file The module's project-relative POSIX path.
 * @returns A location at line 1, column 1.
 */
function fallbackLocation(file: string): SourceLocation {
  return sourceLocationFor(file, 1, 1, undefined, undefined);
}

/**
 * Forces a position onto the 1-based integer domain the location schema
 * accepts.
 *
 * @param value A line or column from a parser, or from a persisted index.
 * @returns The value floored to an integer of at least 1.
 */
function clampPosition(value: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

/* -------------------------------------------------------------------------------------------------
 * Map construction
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds the route map of a loaded project.
 *
 * Every file of `loaded.sourceFiles()` is offered to
 * {@link deriveRouteFromFile}, and every file that derives a route is read for
 * its methods and their positions by {@link buildRouteEntry}. Nothing else
 * happens: no path is resolved, no file is opened, nothing is written. The
 * file set, and with it the guarantee that environment files are never read,
 * belongs to `./project.ts`.
 *
 * Two routes can legitimately claim one path — an App Router module and a
 * Pages Router remnant of a migration in progress, most often. Both stay in
 * {@link RouteMap.entries}, because dropping one would hide a real module from
 * an inventory a developer reads, and the collision is reported at `warn` with
 * both files named. Resolution is unambiguous regardless: the App Router entry
 * wins, which is what the framework itself does.
 *
 * @param loaded The project, as opened by `./project.ts`.
 * @param options Where the route trees live, and where to report.
 * @returns The map. A project with no route module yields an empty one rather
 * than an error: "this project has no routes" is an answer.
 */
export function buildRouteMap(loaded: LoadedProject, options?: BuildRouteMapOptions): RouteMap {
  const logger = options?.logger ?? noopLogger;
  const deriveOptions: DeriveRouteOptions = {
    appDir: options?.appDir,
    pagesDir: options?.pagesDir,
  };

  const entries: RouteEntry[] = [];
  const byRoutePath = new Map<string, RouteEntry>();

  for (const sourceFile of loaded.sourceFiles()) {
    const file = loaded.projectRelative(toPosix(sourceFile.getFilePath()));
    if (file === undefined) {
      // A file the project cannot express relative to its own root cannot be
      // pointed at by a location, so it cannot be a route this map serves.
      continue;
    }

    const derived = deriveRouteFromFile(file, deriveOptions);
    if (derived === undefined) {
      continue;
    }

    const entry = buildRouteEntry(sourceFile, derived);
    const existing = byRoutePath.get(entry.routePath);
    if (existing === undefined) {
      byRoutePath.set(entry.routePath, entry);
    } else {
      logger.warn('route path is served by more than one module', {
        routePath: entry.routePath,
        files: [existing.file, entry.file],
        routers: [existing.router, entry.router],
      });
    }

    entries.push(entry);
  }

  logger.debug('route map built', {
    projectRoot: loaded.projectRoot,
    routes: entries.length,
  });

  return createRouteMap(entries);
}

/**
 * Rebuilds a route map from a persisted code index, with no compiler and no
 * filesystem.
 *
 * This is the path a reopened session takes in the local service: the index
 * came back from `$DEBUGGEN_HOME/index` as plain JSON, ts-morph was never
 * started, and a captured `http.server` span still has to resolve to a file.
 * Every `api-route` node carries what matching needs — `routePath`, `router`,
 * `kind`, `methods` and a position — so the segments are re-parsed from the
 * `routePath` the derivation produced rather than from the file path, which
 * makes the result independent of where that project happened to keep its
 * route trees.
 *
 * What is lost is only {@link RouteEntry.methodLocations}, which is not part
 * of the node payload and plays no part in resolution; the sibling
 * `route-map.test.ts` asserts that the two maps agree on every fixture URL.
 *
 * A node this module cannot read — an unusable `file`, a `routePath` whose
 * segments do not parse — is skipped rather than allowed to produce a route
 * that would resolve wrongly. There is no logger here by design: this function
 * takes a value, not a session.
 *
 * @param index The persisted index.
 * @returns The map.
 */
export function routeMapFromIndex(index: CodeIndex): RouteMap {
  const entries: RouteEntry[] = [];

  for (const node of index.nodes) {
    if (node.kind !== 'api-route') {
      continue;
    }
    const entry = entryFromIndexNode(node);
    if (entry !== undefined) {
      entries.push(entry);
    }
  }

  return createRouteMap(entries);
}

/**
 * Rebuilds one entry from an `api-route` node.
 *
 * @param node The node.
 * @returns The entry, or `undefined` when the node cannot be read.
 */
function entryFromIndexNode(node: CodeNodeOf<'api-route'>): RouteEntry | undefined {
  const file = normalizeRouteFile(node.file);
  if (file === undefined) {
    return undefined;
  }

  const segments = parseRoutePath(node.data.routePath);
  if (segments === undefined) {
    return undefined;
  }

  const derived = finishDerivation(file, node.data.router, node.data.kind, segments);
  if (derived === undefined) {
    return undefined;
  }

  return Object.freeze({
    ...derived,
    methods: Object.freeze([...node.data.methods]),
    location: sourceLocationFor(file, node.line, node.column, node.symbol, node.endLine),
  });
}

/**
 * Parses a route path back into segments.
 *
 * The inverse of {@link routePathOf} and the reason a persisted index is
 * enough to resolve with: a `routePath` has already had its route groups
 * stripped and its dynamic segments left in bracket form, so re-reading it
 * yields exactly the segments the derivation produced.
 *
 * @param routePath A route path, as an `api-route` node carries it.
 * @returns The segments, or `undefined` when the path does not parse.
 */
function parseRoutePath(routePath: string): readonly RouteSegment[] | undefined {
  if (!routePath.startsWith(SEPARATOR)) {
    return undefined;
  }

  const segments: RouteSegment[] = [];
  for (const raw of splitSegments(routePath)) {
    const classified = classifySegment(raw);
    if (classified === undefined) {
      return undefined;
    }
    segments.push(classified);
  }

  return segments;
}

/**
 * Sorts, freezes and closes over a list of entries to make a {@link RouteMap}.
 *
 * The sort is what makes {@link RouteMap.entries} reproducible for a consumer
 * that renders or hashes it; it has no effect on resolution, which compares
 * candidates on their own merits ({@link compareCandidates}) rather than on
 * their position in this array.
 *
 * @param entries The entries, in whatever order they were discovered.
 * @returns The frozen map.
 */
function createRouteMap(entries: readonly RouteEntry[]): RouteMap {
  const sorted = Object.freeze([...entries].sort(compareEntries));
  return Object.freeze({
    entries: sorted,
    resolve: (urlOrPathname: string, method?: HttpMethod): RouteMatch | undefined =>
      matchRoute(sorted, urlOrPathname, method),
  });
}

/**
 * The deterministic inventory order of {@link RouteMap.entries}: by route
 * path, then App Router before Pages Router, then request handler before page,
 * then by file.
 *
 * @param left One entry.
 * @param right The other.
 * @returns A negative number when `left` sorts first.
 */
function compareEntries(left: RouteEntry, right: RouteEntry): number {
  const byPath = compareStrings(left.routePath, right.routePath);
  if (byPath !== 0) {
    return byPath;
  }

  const byRouter = ROUTER_RANK[left.router] - ROUTER_RANK[right.router];
  if (byRouter !== 0) {
    return byRouter;
  }

  const byKind = KIND_RANK[left.kind] - KIND_RANK[right.kind];
  if (byKind !== 0) {
    return byKind;
  }

  return compareStrings(left.file, right.file);
}
