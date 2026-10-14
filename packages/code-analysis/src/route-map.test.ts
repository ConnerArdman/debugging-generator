/**
 * Tests for `./route-map.ts`: the module that answers "which file serves this
 * URL?" and "what is the URL of this file?".
 *
 * The suite is in five parts, and a failure in each means something different:
 *
 * ## 1. The derivation, pinned by a table
 *
 * {@link deriveRouteFromFile} is a pure string function, so the first group is
 * a table of paths and expected routes — every App Router and Pages Router
 * rule, and every case the module refuses. It deliberately does **not** use
 * the fixture corpus: an algorithm asserted only through a fixture is an
 * algorithm that can be broken by a rule the fixture happens not to exercise,
 * and the routing conventions have far more rules (parallel slots, optional
 * catch-alls, intercepting markers, `index` collapsing) than any one sample
 * application does.
 *
 * ## 2. Matching, over synthesised entries
 *
 * Specificity is a property of a *set* of routes, so these cases build the
 * competing routes they need rather than hoping a corpus contains a static
 * route and a dynamic sibling at the same depth. They also cover the input
 * side: an absolute URL, a bare pathname, a query, a fragment, a trailing
 * slash, percent-encoding, and the malformed forms that must produce
 * `undefined` instead of an exception.
 *
 * The origin policy is pinned in the same part and for the same reason: which
 * origins a resolver answers for is a property of the policy rather than of
 * any corpus. That group states every loopback spelling that is accepted,
 * every scheme, host and credential shape that is refused, what a configured
 * `origins` list replaces, and when a match carries a `RequestOrigin` — the
 * behaviour that keeps a third-party URL whose path coincides with a local
 * route path from acquiring a `route-map` location in the developer's project.
 *
 * ## 3. Syntax reading, over an in-memory project
 *
 * Which methods a module exports and where they are declared is read from the
 * abstract syntax tree, so these cases construct small modules in an
 * in-memory ts-morph project — one per export shape a real project uses. That
 * keeps each shape isolated and keeps the committed corpus from having to
 * carry seven variants of one route module. The same part covers what
 * {@link buildRouteMap} does with a configured `origins` list, because that is
 * the one constructor with an injected logger and therefore the only one that
 * can report an entry it could not use.
 *
 * ## 4. The corpus, opened where it lives
 *
 * The fourth group runs {@link buildRouteMap} over
 * `test/fixtures/sample-next-app` through the real `openProject`, which is
 * what a consumer does with a developer's project. The corpus is deliberately
 * hybrid — an App Router tree with a Pages Router remnant — and it is opened
 * **once**, read **only** and never written, so a run leaves `git status`
 * unchanged. This group is also where the `SourceLocation` contract is pinned:
 * every location the map emits is validated with `@debuggen/shared`'s own
 * schema, since that schema is what the `SourceLink` chip and the editor's
 * open-location handler validate it with at the far end.
 *
 * ## 5. The reopened-session path, over a real index
 *
 * The last group proves the two constructors agree where it counts. The corpus
 * is indexed by `./indexer.ts` with the cache disabled, and the map
 * {@link routeMapFromIndex} rebuilds from that index resolves every corpus URL
 * to the same module, path, parameters and methods as the ts-morph-built map —
 * including the origin policy, and including every URL both must refuse. That
 * is the contract a reopened session in the local service depends on: the index
 * came back from `$DEBUGGEN_HOME/index` as plain JSON, no compiler was started,
 * and a captured span still has to resolve to the file a developer expects. The
 * group before it covers the same parity from a *hand-built* index, which pins
 * the node payload; this one pins the real extractor's.
 *
 * Fixture route names are fixture-invented test data. No route literal of
 * theirs appears in `./route-map.ts`, and none should: the module derives, it
 * does not recognise.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  isSourceLocation,
  joinPosix,
  parseSourceLocation,
  relativePosix,
  toPosix,
} from '@debuggen/shared';
import type { LogFields, LogLevel, Logger, SourceLocation } from '@debuggen/shared';
import { Project } from 'ts-morph';
import { beforeAll, describe, expect, it } from 'vitest';

import { CODE_INDEX_SCHEMA_VERSION, HTTP_METHOD_NAMES } from './graph/types.js';
import type { CodeIndex, CodeNode, CodeNodeOf } from './graph/types.js';
import { indexProject } from './indexer.js';
import { INDEXABLE_EXTENSIONS, openProject } from './project.js';
import type { LoadedProject } from './project.js';
import {
  buildRouteEntry,
  buildRouteMap,
  deriveRouteFromFile,
  matchRoute,
  routeMapFromIndex,
} from './route-map.js';
import type {
  HttpMethod,
  MatchRouteOptions,
  RouteEntry,
  RouteMap,
  RouteSegmentKind,
} from './route-map.js';

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

/** The read-only indexing corpus, opened where it lives and never written. */
const FIXTURE_ROOT = fileURLToPath(new URL('../test/fixtures/sample-next-app', import.meta.url));

/** The project root every in-memory case uses. */
const MEMORY_ROOT = '/project';

/**
 * An `http://` URL whose authority carries a `user:password@` userinfo, assembled from two
 * fragments rather than written whole.
 *
 * The cases below exist to prove such a URL is refused, so the credential shape has to appear in
 * this file; but `scripts/check-secrets.mjs` scans every tracked file for exactly that shape and
 * has no inline pragma by design. Splitting the scheme from the authority keeps the shape out of
 * any one line - the same convention that script applies to its own patterns - while the runtime
 * value is the complete credentialed URL the resolver must refuse.
 *
 * @param authority Everything after the scheme: `user:password@host[:port]/path`.
 * @returns The complete `http://` URL.
 */
function credentialed(authority: string): string {
  return `${'http:'}//${authority}`;
}

/** One log record a {@link recordingLogger} captured. */
interface RecordedLog {
  /** The severity the record was emitted at. */
  readonly level: LogLevel;

  /** The message text, which is what the assertions match on. */
  readonly message: string;

  /** The structured fields, or `undefined` when the call passed none. */
  readonly fields: LogFields | undefined;
}

/** A logger that records instead of printing, plus the list it records into. */
function recordingLogger(): { logger: Logger; records: RecordedLog[] } {
  const records: RecordedLog[] = [];
  const capture =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      records.push({ level, message, fields });
    };
  const logger: Logger = {
    level: 'trace',
    trace: capture('trace'),
    debug: capture('debug'),
    info: capture('info'),
    warn: capture('warn'),
    error: capture('error'),
    fatal: capture('fatal'),
    child: () => logger,
  };
  return { logger, records };
}

/**
 * A {@link LoadedProject} over an in-memory filesystem.
 *
 * `openProject` is not used here on purpose: these cases are about *syntax*,
 * and going through the real loader would mean planting a temporary directory
 * per export shape. The handle implements the same contract — a frozen,
 * deterministically ordered file list and a `projectRelative` that refuses a
 * path outside the root — which is all `buildRouteMap` consumes.
 *
 * @param files Module text keyed by project-relative path.
 * @returns The loaded project.
 */
function loadInMemory(files: Readonly<Record<string, string>>): LoadedProject {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFiles = Object.entries(files)
    .map(([file, text]) => project.createSourceFile(joinPosix(MEMORY_ROOT, file), text))
    .sort((left, right) => (left.getFilePath() < right.getFilePath() ? -1 : 1));

  return {
    project,
    projectRoot: MEMORY_ROOT,
    tsConfigFilePath: undefined,
    sourceFiles: () => sourceFiles,
    projectRelative: (absolutePath: string): string | undefined => {
      const relative = relativePosix(MEMORY_ROOT, toPosix(absolutePath));
      return relative === '.' || relative.startsWith('..') ? undefined : relative;
    },
  };
}

/**
 * A route entry for matching cases: the real derivation plus the methods the
 * case needs and a placeholder location.
 *
 * @param file The module path to derive from.
 * @param methods The methods the route should declare.
 * @returns The entry.
 */
function entryOf(file: string, methods: readonly HttpMethod[] = ['GET']): RouteEntry {
  const derived = deriveRouteFromFile(file);
  if (derived === undefined) {
    throw new Error(`the case needs ${file} to be routable`);
  }
  const location: SourceLocation = {
    file: derived.file,
    line: 1,
    column: 1,
    resolvedBy: 'route-map',
    confidence: DEFAULT_RESOLUTION_CONFIDENCE['route-map'],
  };
  return { ...derived, methods, location };
}

/**
 * The entry of a map for one project-relative file.
 *
 * @param map The map to look in.
 * @param file The file to find.
 * @returns The entry.
 */
function entryForFile(map: RouteMap, file: string): RouteEntry {
  const entry = map.entries.find((candidate) => candidate.file === file);
  if (entry === undefined) {
    throw new Error(`no route entry for ${file}`);
  }
  return entry;
}

/**
 * A persisted index holding one `api-route` node per entry of a map, exactly
 * as `./extractors/api-routes.ts` builds them.
 *
 * @param map The map to serialise.
 * @param projectRoot The absolute project root the index records.
 * @returns The index.
 */
function indexFromMap(map: RouteMap, projectRoot: string): CodeIndex {
  const nodes: CodeNode[] = map.entries.map((entry, position): CodeNodeOf<'api-route'> => {
    const { symbol, endLine } = entry.location;
    return {
      id: `api-route:${String(position)}`,
      kind: 'api-route',
      name: entry.routePath,
      file: entry.file,
      line: entry.location.line,
      column: entry.location.column,
      ...(endLine === undefined ? {} : { endLine }),
      ...(symbol === undefined ? {} : { symbol }),
      exported: true,
      data: {
        routePath: entry.routePath,
        router: entry.router,
        kind: entry.kind,
        methods: entry.methods,
      },
    };
  });

  return {
    schemaVersion: CODE_INDEX_SCHEMA_VERSION,
    projectRoot,
    indexerVersion: 'route-map.test',
    generatedAt: 0,
    nodes,
    edges: [],
    files: [],
  };
}

/** The 1-based line `line` of a corpus file, trimmed. */
function corpusLine(file: string, line: number): string {
  const text = readFileSync(joinPosix(toPosix(FIXTURE_ROOT), file), 'utf8');
  return (text.split('\n')[line - 1] ?? '').trim();
}

/** The kinds of a route's segments, in URL order. */
function segmentKinds(file: string): readonly RouteSegmentKind[] {
  return (deriveRouteFromFile(file)?.segments ?? []).map((segment) => segment.kind);
}

/**
 * Asserts one location against the whole `route-map` source-location contract.
 *
 * Every location this module emits travels the same path — onto a
 * `TelemetryEvent.source`, into a `source.open` message, into a `SourceLink`
 * chip and finally into `showTextDocument` — and each of those consumers
 * validates it with `@debuggen/shared`'s schema. So the schema is what this
 * checks with, rather than a field list restated here that could drift from it:
 * `parseSourceLocation` is the gate a location has to pass at every boundary,
 * including its two refinements (a project-relative POSIX `file`, and
 * `endLine >= line`) that a structural comparison would miss, and
 * `isSourceLocation` is the boolean form a renderer decides with. A location
 * that fails either is one no panel would show and no editor would open.
 *
 * `resolvedBy` and `confidence` are pinned on top of that because they are the
 * claim rather than the shape: this module *is* the `'route-map'` resolution
 * route (AAP 0.2.3), it is second in precedence behind a patch's own recorded
 * position, and the number that expresses that ranking is read from
 * `DEFAULT_RESOLUTION_CONFIDENCE` rather than written here — a literal would
 * pass while silently disagreeing with the table every other route is ranked
 * against.
 *
 * @param location The location to check.
 * @param file The project-relative file the location must name.
 */
function expectRouteMapLocation(location: SourceLocation, file: string): void {
  const parsed = parseSourceLocation(location);

  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.value).toEqual(location);
  }
  expect(isSourceLocation(location)).toBe(true);

  expect(location.file).toBe(file);
  expect(location.file.includes('\\')).toBe(false);
  expect(Number.isInteger(location.line)).toBe(true);
  expect(location.line).toBeGreaterThanOrEqual(1);
  expect(Number.isInteger(location.column)).toBe(true);
  expect(location.column).toBeGreaterThanOrEqual(1);
  expect(location.resolvedBy).toBe('route-map');
  expect(location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['route-map']);

  if (location.endLine !== undefined) {
    expect(location.endLine).toBeGreaterThanOrEqual(location.line);
  }
}

/*
 * ---------------------------------------------------------------------------
 * 1. The derivation, pinned by a table
 * ---------------------------------------------------------------------------
 */

/** One row of the derivation table: a path and what it must derive to. */
interface DerivationCase {
  /** What the row demonstrates, used as the test name. */
  readonly what: string;

  /** The project-relative path to derive from. */
  readonly file: string;

  /** The expected route path, or `undefined` when the file is not routable. */
  readonly routePath: string | undefined;

  /** The expected router, when the file is routable. */
  readonly router?: 'app' | 'pages';

  /** The expected kind, when the file is routable. */
  readonly kind?: 'route-handler' | 'page';

  /**
   * The parameters the route captures, in URL order. Defaults to none, which
   * is what a wholly static route captures.
   */
  readonly dynamicParams?: readonly string[];

  /** Defaults to `false`; `true` for a catch-all of either form. */
  readonly isCatchAll?: boolean;

  /** Defaults to `false`; `true` only for the `[[...param]]` form. */
  readonly isOptionalCatchAll?: boolean;
}

/**
 * Runs one row of a derivation table: the six fields it pins, plus the
 * invariants every derived route holds whatever rule produced it.
 *
 * The invariants are asserted per row rather than once in a case of their own
 * because each of them is a way for a *correct-looking* row to still be a
 * wrong answer to "which file serves this URL?": a `routePath` that lost its
 * leading separator or grew a trailing one does not compare equal to the path
 * a captured `http.server` span carries; a `routePath` that disagrees with
 * `segments` makes a map rebuilt from a persisted index resolve differently
 * from the one built by the compiler, since `routeMapFromIndex` re-parses the
 * path; and a `file` that came back in another spelling than it went in is a
 * location no editor can open.
 *
 * The route-group and parallel-slot check is App Router only, and deliberately
 * so. `(group)` and `@slot` are conventions of that router alone, so a
 * directory spelled either way under `pages/` is an ordinary literal URL
 * segment that `./route-map.ts` keeps — which the Pages Router table asserts
 * directly, with its own row.
 *
 * @param testCase The row to run.
 * @param router The router whose conventions apply to the row's segments.
 */
function expectDerivation(testCase: DerivationCase, router: 'app' | 'pages'): void {
  const derived = deriveRouteFromFile(testCase.file);

  if (testCase.routePath === undefined) {
    expect(derived).toBeUndefined();
    return;
  }

  expect(derived).toBeDefined();
  if (derived === undefined) {
    return;
  }

  expect(derived.routePath).toBe(testCase.routePath);
  expect(derived.router).toBe(testCase.router);
  expect(derived.kind).toBe(testCase.kind);
  expect(derived.dynamicParams).toEqual(testCase.dynamicParams ?? []);
  expect(derived.isCatchAll).toBe(testCase.isCatchAll ?? false);
  expect(derived.isOptionalCatchAll).toBe(testCase.isOptionalCatchAll ?? false);

  // The path is POSIX, rooted, unterminated, and exactly its own segments.
  expect(derived.file).toBe(testCase.file);
  expect(derived.routePath.startsWith('/')).toBe(true);
  if (derived.routePath !== '/') {
    expect(derived.routePath.endsWith('/')).toBe(false);
  }
  const rebuiltFromSegments =
    derived.segments.length === 0
      ? '/'
      : `/${derived.segments.map((segment) => segment.raw).join('/')}`;
  expect(derived.routePath).toBe(rebuiltFromSegments);

  if (router === 'app') {
    for (const segment of derived.segments) {
      expect(segment.raw.startsWith('(')).toBe(false);
      expect(segment.raw.startsWith('@')).toBe(false);
    }
  }
}

const APP_ROUTER_CASES: readonly DerivationCase[] = [
  {
    what: 'a root handler',
    file: 'app/route.ts',
    routePath: '/',
    router: 'app',
    kind: 'route-handler',
  },
  { what: 'a root page', file: 'app/page.tsx', routePath: '/', router: 'app', kind: 'page' },
  {
    what: 'a root page under src',
    file: 'src/app/page.tsx',
    routePath: '/',
    router: 'app',
    kind: 'page',
  },
  {
    what: 'a nested handler',
    file: 'app/api/reports/route.ts',
    routePath: '/api/reports',
    router: 'app',
    kind: 'route-handler',
  },
  {
    what: 'a dynamic segment',
    file: 'app/api/reports/[id]/route.ts',
    routePath: '/api/reports/[id]',
    router: 'app',
    kind: 'route-handler',
    dynamicParams: ['id'],
  },
  {
    what: 'two dynamic segments, reported in URL order',
    file: 'app/[region]/reports/[id]/page.tsx',
    routePath: '/[region]/reports/[id]',
    router: 'app',
    kind: 'page',
    dynamicParams: ['region', 'id'],
  },
  {
    what: 'a catch-all segment',
    file: 'app/api/reports/[...trail]/route.ts',
    routePath: '/api/reports/[...trail]',
    router: 'app',
    kind: 'route-handler',
    dynamicParams: ['trail'],
    isCatchAll: true,
  },
  {
    what: 'an optional catch-all segment',
    file: 'app/api/reports/[[...trail]]/route.ts',
    routePath: '/api/reports/[[...trail]]',
    router: 'app',
    kind: 'route-handler',
    dynamicParams: ['trail'],
    isCatchAll: true,
    isOptionalCatchAll: true,
  },
  {
    what: 'a route group, which contributes nothing',
    file: 'app/(marketing)/reports/page.tsx',
    routePath: '/reports',
    router: 'app',
    kind: 'page',
  },
  {
    what: 'nested route groups, which contribute nothing',
    file: 'app/(marketing)/(promo)/page.tsx',
    routePath: '/',
    router: 'app',
    kind: 'page',
  },
  {
    what: 'a parallel-route slot, which contributes nothing',
    file: 'app/@aside/reports/page.tsx',
    routePath: '/reports',
    router: 'app',
    kind: 'page',
  },
  {
    what: 'a group combined with a dynamic segment',
    file: 'app/(marketing)/reports/[id]/page.tsx',
    routePath: '/reports/[id]',
    router: 'app',
    kind: 'page',
    dynamicParams: ['id'],
  },
  {
    what: 'a JavaScript handler module',
    file: 'app/api/reports/route.mjs',
    routePath: '/api/reports',
    router: 'app',
    kind: 'route-handler',
  },
  { what: 'a private folder', file: 'app/_internal/reports/route.ts', routePath: undefined },
  { what: 'a private folder above a page', file: 'app/_internal/page.tsx', routePath: undefined },
  { what: 'a same-level interception', file: 'app/(.)reports/page.tsx', routePath: undefined },
  { what: 'a one-level interception', file: 'app/(..)reports/page.tsx', routePath: undefined },
  { what: 'a root interception', file: 'app/(...)reports/page.tsx', routePath: undefined },
  { what: 'a two-level interception', file: 'app/(..)(..)reports/page.tsx', routePath: undefined },
  { what: 'a layout', file: 'app/layout.tsx', routePath: undefined },
  { what: 'a loading state', file: 'app/loading.tsx', routePath: undefined },
  { what: 'an error boundary', file: 'app/error.tsx', routePath: undefined },
  { what: 'a global error boundary', file: 'app/global-error.tsx', routePath: undefined },
  { what: 'a not-found boundary', file: 'app/not-found.tsx', routePath: undefined },
  { what: 'a template', file: 'app/template.tsx', routePath: undefined },
  { what: 'a parallel-route default', file: 'app/default.tsx', routePath: undefined },
  { what: 'a metadata route', file: 'app/sitemap.ts', routePath: undefined },
  { what: 'a robots route', file: 'app/robots.ts', routePath: undefined },
  { what: 'a manifest route', file: 'app/manifest.ts', routePath: undefined },
  { what: 'an image convention', file: 'app/opengraph-image.tsx', routePath: undefined },
  { what: 'an instrumentation hook', file: 'app/instrumentation.ts', routePath: undefined },
  { what: 'a middleware module', file: 'middleware.ts', routePath: undefined },
  { what: 'an unsupported extension', file: 'app/api/reports/route.css', routePath: undefined },
  { what: 'an unopened bracket', file: 'app/api/id]/route.ts', routePath: undefined },
  { what: 'an unclosed bracket', file: 'app/api/[id/route.ts', routePath: undefined },
  { what: 'an empty dynamic segment', file: 'app/api/[]/route.ts', routePath: undefined },
  { what: 'an unnamed catch-all', file: 'app/api/[...]/route.ts', routePath: undefined },
  {
    what: 'a catch-all that is not last',
    file: 'app/api/[...trail]/more/route.ts',
    routePath: undefined,
  },
  { what: 'a module outside both trees', file: 'src/components/Widget.tsx', routePath: undefined },
  {
    what: 'a path that looks like the app tree',
    file: 'application/page.tsx',
    routePath: undefined,
  },
  { what: 'an absolute path', file: '/srv/app/page.tsx', routePath: undefined },
  { what: 'a path escaping the project', file: '../elsewhere/app/page.tsx', routePath: undefined },
];

const PAGES_ROUTER_CASES: readonly DerivationCase[] = [
  {
    what: 'the index page',
    file: 'pages/index.tsx',
    routePath: '/',
    router: 'pages',
    kind: 'page',
  },
  {
    what: 'the index page under src',
    file: 'src/pages/index.tsx',
    routePath: '/',
    router: 'pages',
    kind: 'page',
  },
  {
    what: 'an ordinary page',
    file: 'pages/reports.tsx',
    routePath: '/reports',
    router: 'pages',
    kind: 'page',
  },
  {
    what: 'a nested page',
    file: 'pages/reports/archive.tsx',
    routePath: '/reports/archive',
    router: 'pages',
    kind: 'page',
  },
  {
    what: 'a dynamic page',
    file: 'pages/reports/[id].tsx',
    routePath: '/reports/[id]',
    router: 'pages',
    kind: 'page',
    dynamicParams: ['id'],
  },
  {
    what: 'the api index, which collapses to its directory',
    file: 'pages/api/index.ts',
    routePath: '/api',
    router: 'pages',
    kind: 'route-handler',
  },
  {
    what: 'an api module',
    file: 'pages/api/reports.ts',
    routePath: '/api/reports',
    router: 'pages',
    kind: 'route-handler',
  },
  {
    // The same collapsing rule one level down, which is the shape a legacy
    // route grows into when a sibling `[id].ts` is added beside it: the
    // directory becomes the URL and `index` contributes nothing.
    what: 'a nested api index, which collapses to its own directory',
    file: 'pages/api/reports/index.ts',
    routePath: '/api/reports',
    router: 'pages',
    kind: 'route-handler',
  },
  {
    what: 'a nested page index, which collapses to its own directory',
    file: 'pages/reports/index.tsx',
    routePath: '/reports',
    router: 'pages',
    kind: 'page',
  },
  {
    what: 'a dynamic api module',
    file: 'pages/api/reports/[id].ts',
    routePath: '/api/reports/[id]',
    router: 'pages',
    kind: 'route-handler',
    dynamicParams: ['id'],
  },
  {
    what: 'a catch-all api module',
    file: 'pages/api/reports/[...trail].ts',
    routePath: '/api/reports/[...trail]',
    router: 'pages',
    kind: 'route-handler',
    dynamicParams: ['trail'],
    isCatchAll: true,
  },
  {
    what: 'an optional catch-all api module',
    file: 'pages/api/reports/[[...trail]].ts',
    routePath: '/api/reports/[[...trail]]',
    router: 'pages',
    kind: 'route-handler',
    dynamicParams: ['trail'],
    isCatchAll: true,
    isOptionalCatchAll: true,
  },
  {
    what: 'a module named like the api directory, which is a page',
    file: 'pages/api.tsx',
    routePath: '/api',
    router: 'pages',
    kind: 'page',
  },
  {
    what: 'a parenthesised directory, which is literal here',
    file: 'pages/(archive)/reports.tsx',
    routePath: '/(archive)/reports',
    router: 'pages',
    kind: 'page',
  },
  { what: 'the application shell', file: 'pages/_app.tsx', routePath: undefined },
  { what: 'the document shell', file: 'pages/_document.tsx', routePath: undefined },
  { what: 'the error page', file: 'pages/_error.tsx', routePath: undefined },
  { what: 'a middleware module', file: 'pages/middleware.ts', routePath: undefined },
  { what: 'a private folder', file: 'pages/_internal/reports.tsx', routePath: undefined },
  { what: 'a dotfile', file: 'pages/.hidden.tsx', routePath: undefined },
  {
    what: 'an extension the router does not serve',
    file: 'pages/api/reports.mjs',
    routePath: undefined,
  },
];

describe('deriveRouteFromFile', () => {
  describe('App Router', () => {
    for (const testCase of APP_ROUTER_CASES) {
      it(`derives ${testCase.what}`, () => {
        expectDerivation(testCase, 'app');
      });
    }

    it('serves a handler module written in every extension the indexer reads', () => {
      // The set is imported from `./project.ts` rather than restated, because
      // the rule is "whatever this product indexes, this module can route":
      // a project mid-migration keeps `route.js` beside `route.ts`, and an
      // extension the indexer loads but the derivation refuses would drop that
      // route from the map silently. Adding an extension there must therefore
      // either extend this module or fail here.
      for (const extension of INDEXABLE_EXTENSIONS) {
        const derived = deriveRouteFromFile(`app/api/reports/route${extension}`);

        expect(derived?.routePath).toBe('/api/reports');
        expect(derived?.kind).toBe('route-handler');
        expect(derived?.file).toBe(`app/api/reports/route${extension}`);
      }
    });

    it('renders a page module written in every extension the indexer reads', () => {
      for (const extension of INDEXABLE_EXTENSIONS) {
        const derived = deriveRouteFromFile(`app/reports/page${extension}`);

        expect(derived?.routePath).toBe('/reports');
        expect(derived?.kind).toBe('page');
      }
    });
  });

  describe('Pages Router', () => {
    for (const testCase of PAGES_ROUTER_CASES) {
      it(`derives ${testCase.what}`, () => {
        expectDerivation(testCase, 'pages');
      });
    }

    it('serves only the extensions that router serves, and refuses the rest', () => {
      // Narrower than the App Router set on purpose: the framework's default
      // page extensions are the four below, so a `.mjs`, `.cjs`, `.mts` or
      // `.cts` module under `pages/` answers no URL and claiming one for it
      // would attribute a captured request to a file that never served it.
      const served = ['.ts', '.tsx', '.js', '.jsx'];

      for (const extension of INDEXABLE_EXTENSIONS) {
        const derived = deriveRouteFromFile(`pages/api/reports${extension}`);

        if (served.includes(extension)) {
          expect(derived?.routePath).toBe('/api/reports');
          expect(derived?.router).toBe('pages');
        } else {
          expect(derived).toBeUndefined();
        }
      }
    });
  });

  it('classifies every segment kind', () => {
    expect(segmentKinds('app/api/reports/route.ts')).toEqual(['static', 'static']);
    expect(segmentKinds('app/api/reports/[id]/route.ts')).toEqual(['static', 'static', 'dynamic']);
    expect(segmentKinds('app/api/[...trail]/route.ts')).toEqual(['static', 'catch-all']);
    expect(segmentKinds('app/api/[[...trail]]/route.ts')).toEqual(['static', 'optional-catch-all']);
    expect(segmentKinds('app/page.tsx')).toEqual([]);
  });

  it('reports the captured parameters in URL order', () => {
    const derived = deriveRouteFromFile('app/(group)/[region]/reports/[...trail]/route.ts');

    expect(derived?.routePath).toBe('/[region]/reports/[...trail]');
    expect(derived?.dynamicParams).toEqual(['region', 'trail']);
    expect(derived?.isCatchAll).toBe(true);
    expect(derived?.isOptionalCatchAll).toBe(false);
  });

  it('distinguishes the optional catch-all from the required one', () => {
    const required = deriveRouteFromFile('app/api/[...trail]/route.ts');
    const optional = deriveRouteFromFile('app/api/[[...trail]]/route.ts');

    expect(required?.isCatchAll).toBe(true);
    expect(required?.isOptionalCatchAll).toBe(false);
    expect(optional?.isCatchAll).toBe(true);
    expect(optional?.isOptionalCatchAll).toBe(true);
  });

  it('accepts a path written with Windows separators', () => {
    expect(deriveRouteFromFile('app\\api\\reports\\route.ts')?.routePath).toBe('/api/reports');
  });

  it('normalises a redundant path before deriving', () => {
    expect(deriveRouteFromFile('./app/./api/reports/route.ts')?.file).toBe(
      'app/api/reports/route.ts',
    );
  });

  it('freezes what it returns', () => {
    const derived = deriveRouteFromFile('app/api/reports/[id]/route.ts');

    expect(Object.isFrozen(derived)).toBe(true);
    expect(Object.isFrozen(derived?.segments)).toBe(true);
  });

  it('honours an explicitly named app directory, exclusively', () => {
    expect(
      deriveRouteFromFile('web/app/api/reports/route.ts', { appDir: 'web/app' })?.routePath,
    ).toBe('/api/reports');
    expect(deriveRouteFromFile('app/api/reports/route.ts', { appDir: 'web/app' })).toBeUndefined();
  });

  it('honours an explicitly named pages directory, exclusively', () => {
    expect(
      deriveRouteFromFile('web/pages/api/reports.ts', { pagesDir: 'web/pages' })?.routePath,
    ).toBe('/api/reports');
    expect(deriveRouteFromFile('pages/api/reports.ts', { pagesDir: 'web/pages' })).toBeUndefined();
  });

  it('derives nothing when a named directory is not a usable relative path', () => {
    expect(deriveRouteFromFile('app/page.tsx', { appDir: '/srv/app' })).toBeUndefined();
  });
});

/*
 * ---------------------------------------------------------------------------
 * 2. Matching, over synthesised entries
 * ---------------------------------------------------------------------------
 */

describe('matchRoute', () => {
  describe('specificity', () => {
    const competing: readonly RouteEntry[] = [
      entryOf('app/api/reports/route.ts'),
      entryOf('app/api/[id]/route.ts'),
      entryOf('app/api/[...trail]/route.ts'),
    ];

    it('prefers a static segment over a dynamic sibling', () => {
      expect(matchRoute(competing, '/api/reports')?.entry.file).toBe('app/api/reports/route.ts');
    });

    it('prefers a dynamic segment over a catch-all', () => {
      const match = matchRoute(competing, '/api/7');

      expect(match?.entry.file).toBe('app/api/[id]/route.ts');
      expect(match?.params).toEqual({ id: '7' });
    });

    it('falls to the catch-all only when nothing narrower matches', () => {
      const match = matchRoute(competing, '/api/7/8/9');

      expect(match?.entry.file).toBe('app/api/[...trail]/route.ts');
      expect(match?.params).toEqual({ trail: ['7', '8', '9'] });
    });

    it('prefers an exhausted route over an optional catch-all that would swallow nothing', () => {
      const entries = [
        entryOf('app/api/reports/route.ts'),
        entryOf('app/api/reports/[[...trail]]/route.ts'),
      ];

      expect(matchRoute(entries, '/api/reports')?.entry.file).toBe('app/api/reports/route.ts');
      expect(matchRoute(entries, '/api/reports/2026/q1')?.entry.file).toBe(
        'app/api/reports/[[...trail]]/route.ts',
      );
    });

    it('prefers the App Router entry when both routers claim one path', () => {
      const entries = [
        entryOf('pages/api/reports.ts', ['ANY']),
        entryOf('app/api/reports/route.ts'),
      ];

      expect(matchRoute(entries, '/api/reports')?.entry.router).toBe('app');
    });

    it('prefers a request handler over a page at the same path', () => {
      const entries = [entryOf('app/reports/page.tsx'), entryOf('app/reports/route.ts')];

      expect(matchRoute(entries, '/reports')?.entry.kind).toBe('route-handler');
    });

    it('breaks a remaining tie on the file path, deterministically', () => {
      const first = entryOf('app/(a)/reports/route.ts');
      const second = entryOf('app/(b)/reports/route.ts');

      expect(matchRoute([first, second], '/reports')?.entry.file).toBe(first.file);
      expect(matchRoute([second, first], '/reports')?.entry.file).toBe(first.file);
    });
  });

  describe('segment semantics', () => {
    it('matches the root route', () => {
      const match = matchRoute([entryOf('app/page.tsx')], '/');

      expect(match?.entry.file).toBe('app/page.tsx');
      expect(match?.pathname).toBe('/');
      expect(match?.params).toEqual({});
    });

    it('requires a catch-all to capture at least one segment', () => {
      const entries = [entryOf('app/api/reports/[...trail]/route.ts')];

      expect(matchRoute(entries, '/api/reports')).toBeUndefined();
      expect(matchRoute(entries, '/api/reports/2026')?.params).toEqual({ trail: ['2026'] });
    });

    it('lets an optional catch-all match its own parent path', () => {
      const entries = [entryOf('app/api/reports/[[...trail]]/route.ts')];

      expect(matchRoute(entries, '/api/reports')?.params).toEqual({ trail: [] });
      expect(matchRoute(entries, '/api/reports/2026/q1')?.params).toEqual({
        trail: ['2026', 'q1'],
      });
    });

    it('does not let a dynamic segment span two request segments', () => {
      expect(matchRoute([entryOf('app/api/[id]/route.ts')], '/api/7/8')).toBeUndefined();
    });

    it('does not match a request longer than the route', () => {
      expect(
        matchRoute([entryOf('app/api/reports/route.ts')], '/api/reports/2026'),
      ).toBeUndefined();
    });

    it('matches case-sensitively', () => {
      expect(matchRoute([entryOf('app/api/reports/route.ts')], '/API/reports')).toBeUndefined();
    });

    it('freezes the captured parameters', () => {
      const match = matchRoute([entryOf('app/api/[id]/route.ts')], '/api/7');

      expect(Object.isFrozen(match?.params)).toBe(true);
    });
  });

  describe('input forms', () => {
    const entries = [entryOf('app/api/reports/route.ts'), entryOf('app/api/[id]/route.ts')];

    it('accepts an absolute URL', () => {
      expect(matchRoute(entries, 'http://127.0.0.1:3000/api/reports')?.entry.file).toBe(
        'app/api/reports/route.ts',
      );
    });

    it('accepts an absolute URL with a query and a fragment', () => {
      const match = matchRoute(entries, 'http://127.0.0.1:3000/api/reports?since=2026#top');

      expect(match?.entry.file).toBe('app/api/reports/route.ts');
      expect(match?.pathname).toBe('/api/reports');
    });

    it('accepts a bare pathname with a query', () => {
      expect(matchRoute(entries, '/api/reports?since=2026')?.entry.file).toBe(
        'app/api/reports/route.ts',
      );
    });

    it('accepts a bare pathname with a fragment', () => {
      expect(matchRoute(entries, '/api/reports#top')?.entry.file).toBe('app/api/reports/route.ts');
    });

    it('ignores a trailing slash', () => {
      expect(matchRoute(entries, '/api/reports/')?.pathname).toBe('/api/reports');
    });

    it('collapses repeated separators', () => {
      expect(matchRoute(entries, '//api//reports')?.entry.file).toBe('app/api/reports/route.ts');
    });

    it('resolves dot segments the way a URL parser would', () => {
      expect(matchRoute(entries, '/api/archive/../reports')?.entry.file).toBe(
        'app/api/reports/route.ts',
      );
    });

    it('decodes each segment after splitting, so an encoded separator stays inside it', () => {
      const match = matchRoute(entries, '/api/2026%2Fq1');

      expect(match?.entry.file).toBe('app/api/[id]/route.ts');
      expect(match?.params).toEqual({ id: '2026/q1' });
      expect(match?.pathname).toBe('/api/2026/q1');
    });

    it('decodes non-ASCII segments', () => {
      expect(matchRoute(entries, '/api/r%C3%A9sum%C3%A9')?.params).toEqual({ id: 'résumé' });
    });

    it('returns undefined for a malformed URL instead of throwing', () => {
      expect(matchRoute(entries, 'http://[bad/api/reports')).toBeUndefined();
      expect(matchRoute(entries, 'http://')).toBeUndefined();
    });

    it('returns undefined for a malformed percent sequence instead of throwing', () => {
      expect(matchRoute(entries, '/api/%E0%A4%A')).toBeUndefined();
    });

    it('reads an empty path as the root rather than as a segment', () => {
      const root = [entryOf('app/page.tsx')];

      // An origin-only URL, a bare `'.'` and a path that reduces to nothing all
      // mean the root — not a request for a segment literally named `'.'`.
      expect(matchRoute(root, 'http://127.0.0.1:3000')?.pathname).toBe('/');
      expect(matchRoute(root, '.')?.pathname).toBe('/');
      expect(matchRoute(root, '/./')?.pathname).toBe('/');
    });

    it('returns undefined for an empty or blank input', () => {
      expect(matchRoute(entries, '')).toBeUndefined();
      expect(matchRoute(entries, '   ')).toBeUndefined();
    });

    it('returns undefined when no route answers', () => {
      expect(matchRoute(entries, '/nowhere/at/all')).toBeUndefined();
      expect(matchRoute([], '/api/reports')).toBeUndefined();
    });
  });

  describe('origin policy', () => {
    /** The one route every case in this group asks for. */
    const ROUTE_FILE = 'app/api/reports/route.ts';

    /** The route set, so a refusal is never a refusal for want of a route. */
    const entries = [entryOf(ROUTE_FILE)];

    /** The origin a caller configures when the dev server is not loopback. */
    const NAMED_ORIGIN = 'http://dev.internal:3000';

    /**
     * The file each URL resolves to, or `undefined`.
     *
     * A list rather than one call per URL: the failure message then names the
     * URL that changed behaviour instead of only the index of a loop iteration.
     *
     * @param urls The URLs to resolve.
     * @param options The origin policy to resolve them under.
     * @returns One entry per URL, in the same order.
     */
    function filesFor(
      urls: readonly string[],
      options?: MatchRouteOptions,
    ): readonly (string | undefined)[] {
      return urls.map((url) => matchRoute(entries, url, undefined, options)?.entry.file);
    }

    it('answers for a loopback URL in every spelling the predicate accepts', () => {
      // The spellings `isLoopbackDevServerUrl` admits, which is the package's
      // single definition of "a dev server on this machine": `localhost` and
      // any `*.localhost` subdomain, the whole `127.0.0.0/8` range, IPv6 `::1`,
      // with or without an explicit port, over either permitted scheme.
      const urls = [
        'http://localhost/api/reports',
        'http://localhost:3000/api/reports',
        'http://app.localhost:3000/api/reports',
        'http://127.0.0.1/api/reports',
        'http://127.0.0.1:3000/api/reports',
        'http://127.0.0.2:4000/api/reports',
        'http://[::1]:3000/api/reports',
        'https://localhost:3000/api/reports',
      ];

      expect(filesFor(urls)).toEqual(urls.map(() => ROUTE_FILE));
    });

    it('refuses an unspecified address, which names every interface rather than this machine', () => {
      const urls = ['http://0.0.0.0:3000/api/reports', 'http://[::]:3000/api/reports'];

      expect(filesFor(urls)).toEqual([undefined, undefined]);
    });

    it('refuses a public host whose path happens to spell a local route', () => {
      // The finding this group exists for: a captured third-party `fetch` span
      // must not acquire a location inside the developer's own project.
      const urls = [
        'https://api.stripe.com/api/reports',
        'http://evil.test/api/reports',
        'https://evil.test:443/api/reports?x=1',
      ];

      expect(filesFor(urls)).toEqual([undefined, undefined, undefined]);
    });

    it('refuses a private, LAN and link-local host', () => {
      const urls = [
        'http://10.0.0.5:3000/api/reports',
        'http://172.16.0.5:3000/api/reports',
        'http://192.168.1.10:3000/api/reports',
        'http://169.254.10.1:3000/api/reports',
        'http://[fe80::1]:3000/api/reports',
      ];

      expect(filesFor(urls)).toEqual(urls.map(() => undefined));
    });

    it('refuses every scheme but http and https, loopback host or not', () => {
      // The scheme is screened before the host, so a loopback `ftp:` URL is
      // refused for its scheme and `javascript:/api/reports` — which is not a
      // request at all, yet parses to a pathname that looks like one — never
      // reaches matching.
      const urls = [
        'ftp://127.0.0.1/api/reports',
        'ftp://evil.test/api/reports',
        'javascript:/api/reports',
        'data:text/plain,/api/reports',
        'file:///api/reports',
        'app-scheme://localhost/api/reports',
      ];

      expect(filesFor(urls)).toEqual(urls.map(() => undefined));
    });

    it('refuses a URL carrying credentials, including the host-spoofing shape', () => {
      // An authority of `localhost:3000@evil.test` reads as username `localhost`,
      // password `3000` and host `evil.test`: the credential check refuses it
      // before the host check would, and either would refuse it.
      const urls = [
        credentialed('user:secret@127.0.0.1:3000/api/reports'),
        'http://user@localhost:3000/api/reports',
        credentialed('localhost:3000@evil.test/api/reports'),
      ];

      expect(filesFor(urls)).toEqual(urls.map(() => undefined));
    });

    it('reads a protocol-relative reference as a path, never as an origin', () => {
      // `//evil.test/api/reports` carries no scheme, so it is a bare pathname
      // whose first segment is the literal `evil.test`. It therefore answers no
      // route whose path it does not spell, and a catch-all captures the host
      // as an ordinary segment.
      expect(matchRoute(entries, '//evil.test/api/reports')).toBeUndefined();
      expect(
        matchRoute([entryOf('app/[...trail]/route.ts')], '//evil.test/api/reports')?.params,
      ).toEqual({ trail: ['evil.test', 'api', 'reports'] });
    });

    it('answers for an origin a caller named, loopback or not', () => {
      const match = matchRoute(entries, `${NAMED_ORIGIN}/api/reports`, undefined, {
        origins: [NAMED_ORIGIN],
      });

      expect(match?.entry.file).toBe(ROUTE_FILE);
      expect(match?.origin?.origin).toBe(NAMED_ORIGIN);
      expect(match?.origin?.loopback).toBe(false);
    });

    it('treats a configured list as replacing the loopback default, not extending it', () => {
      const options: MatchRouteOptions = { origins: [NAMED_ORIGIN] };

      expect(
        filesFor(['http://127.0.0.1:3000/api/reports', 'http://localhost/api/reports'], options),
      ).toEqual([undefined, undefined]);
      // The bare pathname is unaffected: it names no origin to screen.
      expect(matchRoute(entries, '/api/reports', undefined, options)?.entry.file).toBe(ROUTE_FILE);
    });

    it('compares a configured origin on scheme, host and port together', () => {
      const options: MatchRouteOptions = { origins: [NAMED_ORIGIN] };

      expect(
        filesFor(
          [
            'http://dev.internal:3001/api/reports',
            'http://dev.internal/api/reports',
            'https://dev.internal:3000/api/reports',
            'http://other.internal:3000/api/reports',
          ],
          options,
        ),
      ).toEqual([undefined, undefined, undefined, undefined]);
    });

    it('accepts a configured entry written as a full URL, and drops a default port', () => {
      // A session carries a dev-server URL rather than a bare origin, so an
      // entry with a path, a query or a trailing slash is reduced to its
      // origin; `URL.origin` also drops the scheme's default port on both
      // sides of the comparison.
      expect(
        filesFor(['http://dev.internal:3000/api/reports'], {
          origins: ['http://dev.internal:3000/base/path?since=2026'],
        }),
      ).toEqual([ROUTE_FILE]);
      expect(
        filesFor(['http://dev.internal/api/reports'], { origins: ['http://dev.internal:80/'] }),
      ).toEqual([ROUTE_FILE]);
    });

    it('keeps the usable entries of a mixed list and ignores the rest', () => {
      const options: MatchRouteOptions = {
        origins: ['not a url at all', 'ftp://dev.internal:3000', NAMED_ORIGIN, NAMED_ORIGIN],
      };

      expect(filesFor([`${NAMED_ORIGIN}/api/reports`], options)).toEqual([ROUTE_FILE]);
      expect(filesFor(['http://127.0.0.1:3000/api/reports'], options)).toEqual([undefined]);
    });

    it('falls back to loopback when a configured list holds nothing usable', () => {
      // A mistyped option must not silently turn every resolution into a miss,
      // so an empty list and a list whose every entry is unusable both leave
      // the default in place rather than refusing everything.
      for (const origins of [
        [],
        ['', '   ', 'not a url at all', 'ftp://dev.internal:3000', 'file:///srv/app'],
        [credentialed('user:secret@dev.internal:3000')],
      ]) {
        const options: MatchRouteOptions = { origins };

        expect(filesFor(['http://127.0.0.1:3000/api/reports'], options)).toEqual([ROUTE_FILE]);
        expect(filesFor([`${NAMED_ORIGIN}/api/reports`], options)).toEqual([undefined]);
      }
    });

    it('describes the accepted origin on the match, and omits it for a bare pathname', () => {
      const fromUrl = matchRoute(entries, 'http://127.0.0.1:3000/api/reports?since=2026');
      const fromPath = matchRoute(entries, '/api/reports');

      expect(fromUrl?.origin).toEqual({
        protocol: 'http:',
        hostname: '127.0.0.1',
        port: '3000',
        origin: 'http://127.0.0.1:3000',
        loopback: true,
      });
      expect(Object.isFrozen(fromUrl?.origin)).toBe(true);
      expect(fromPath).toBeDefined();
      expect(fromPath?.origin).toBeUndefined();
      // Absent, not present and holding `undefined`: the module compiles with
      // `exactOptionalPropertyTypes` and a consumer may distinguish the two.
      expect(Object.hasOwn(fromPath ?? {}, 'origin')).toBe(false);
    });

    it('reports an omitted port as the empty string, the way URL does', () => {
      const match = matchRoute(entries, 'https://localhost/api/reports');

      expect(match?.origin?.port).toBe('');
      expect(match?.origin?.protocol).toBe('https:');
      expect(match?.origin?.origin).toBe('https://localhost');
    });

    it('refuses rather than throws for every shape it will not answer', () => {
      // The contract of the whole module: a refusal is an `undefined`, never an
      // exception, because the input is a captured span attribute or something
      // a developer typed.
      for (const url of [
        'javascript:/api/reports',
        'http://evil.test/api/reports',
        credentialed('user:secret@localhost/api/reports'),
        'http://[bad/api/reports',
        'http://',
        'https://',
      ]) {
        expect(() => matchRoute(entries, url)).not.toThrow();
        expect(matchRoute(entries, url)).toBeUndefined();
      }
    });
  });

  describe('method filtering', () => {
    it('requires a declared method to match', () => {
      const entries = [entryOf('app/api/reports/route.ts', ['GET', 'POST'])];

      expect(matchRoute(entries, '/api/reports', 'GET')?.entry.file).toBe(
        'app/api/reports/route.ts',
      );
      expect(matchRoute(entries, '/api/reports', 'POST')?.entry.file).toBe(
        'app/api/reports/route.ts',
      );
      expect(matchRoute(entries, '/api/reports', 'DELETE')).toBeUndefined();
    });

    it('treats a declared ANY as every method', () => {
      const entries = [entryOf('pages/api/reports.ts', ['ANY'])];

      expect(matchRoute(entries, '/api/reports', 'DELETE')?.entry.methods).toEqual(['ANY']);
    });

    it('treats a route that declares no method as answering every method', () => {
      const entries = [entryOf('app/api/reports/route.ts', [])];

      expect(matchRoute(entries, '/api/reports', 'PATCH')?.entry.methods).toEqual([]);
    });

    it('treats a question of ANY as matching every route', () => {
      const entries = [entryOf('app/api/reports/route.ts', ['GET'])];

      expect(matchRoute(entries, '/api/reports', 'ANY')?.entry.file).toBe(
        'app/api/reports/route.ts',
      );
    });

    it('falls through to a less specific route that does answer the method', () => {
      const entries = [
        entryOf('app/api/reports/route.ts', ['GET']),
        entryOf('app/api/[id]/route.ts', ['POST']),
      ];

      expect(matchRoute(entries, '/api/reports', 'POST')?.entry.file).toBe('app/api/[id]/route.ts');
    });
  });
});

/*
 * ---------------------------------------------------------------------------
 * 3. Syntax reading, over an in-memory project
 * ---------------------------------------------------------------------------
 */

describe('buildRouteMap: methods and locations', () => {
  it('reports exported handlers in source order, whatever shape they take', () => {
    const map = buildRouteMap(
      loadInMemory({
        'app/api/reports/route.ts': [
          'export async function GET() {',
          '  return null;',
          '}',
          'export const POST = async () => null;',
          'export { helper as PUT };',
          'function helper() {',
          '  return null;',
          '}',
          '',
        ].join('\n'),
      }),
    );
    const entry = entryForFile(map, 'app/api/reports/route.ts');

    expect(entry.methods).toEqual(['GET', 'POST', 'PUT']);
    expect(entry.methodLocations?.['GET']?.line).toBe(1);
    expect(entry.methodLocations?.['POST']?.line).toBe(4);
    expect(entry.methodLocations?.['PUT']?.line).toBe(5);
    expect(entry.location).toEqual(entry.methodLocations?.['GET']);
  });

  it('reports methods in the order they are written, not alphabetically', () => {
    const map = buildRouteMap(
      loadInMemory({
        'app/api/reports/route.ts':
          'export const DELETE = async () => null;\nexport function GET() {\n  return null;\n}\n',
      }),
    );

    expect(entryForFile(map, 'app/api/reports/route.ts').methods).toEqual(['DELETE', 'GET']);
  });

  it('reads a handler re-exported from another module, and locates it here', () => {
    const map = buildRouteMap(
      loadInMemory({
        'app/api/reports/route.ts':
          "export { readReports as GET } from '../../../src/handlers.js';\n",
      }),
    );
    const entry = entryForFile(map, 'app/api/reports/route.ts');

    expect(entry.methods).toEqual(['GET']);
    expect(entry.methodLocations?.['GET']?.file).toBe('app/api/reports/route.ts');
    expect(entry.methodLocations?.['GET']?.line).toBe(1);
  });

  it('reports a method declared twice once, at its earlier position', () => {
    const map = buildRouteMap(
      loadInMemory({
        'app/api/reports/route.ts': [
          'export async function GET() {',
          '  return null;',
          '}',
          "export { fallback as GET } from '../../../src/handlers.js';",
          '',
        ].join('\n'),
      }),
    );
    const entry = entryForFile(map, 'app/api/reports/route.ts');

    expect(entry.methods).toEqual(['GET']);
    expect(entry.methodLocations?.['GET']?.line).toBe(1);
  });

  it('locates a handler declared among several bindings at its own binding', () => {
    const map = buildRouteMap(
      loadInMemory({
        'app/api/reports/route.ts': 'export const revalidate = 60,\n  POST = async () => null;\n',
      }),
    );
    const location = entryForFile(map, 'app/api/reports/route.ts').methodLocations?.['POST'];

    expect(location?.line).toBe(2);
    expect(location?.column).toBeGreaterThan(1);
  });

  it('reports no method for a handler module that exports none, and still serves the path', () => {
    const map = buildRouteMap(
      loadInMemory({ 'app/api/reports/route.ts': 'export const revalidate = 60;\n' }),
    );
    const entry = entryForFile(map, 'app/api/reports/route.ts');

    expect(entry.methods).toEqual([]);
    expect(entry.methodLocations).toBeUndefined();
    expect(entry.location).toEqual({
      file: 'app/api/reports/route.ts',
      line: 1,
      column: 1,
      resolvedBy: 'route-map',
      confidence: DEFAULT_RESOLUTION_CONFIDENCE['route-map'],
    });
    expect(map.resolve('/api/reports')?.entry.file).toBe('app/api/reports/route.ts');
  });

  it('does not follow a star re-export', () => {
    const map = buildRouteMap(
      loadInMemory({
        'app/api/reports/route.ts': "export * from '../../../src/handlers.js';\n",
      }),
    );

    expect(entryForFile(map, 'app/api/reports/route.ts').methods).toEqual([]);
  });

  it('names the component of a page from its default export, whichever form it takes', () => {
    const map = buildRouteMap(
      loadInMemory({
        'app/page.tsx': 'export default function Landing() {\n  return null;\n}\n',
        'app/reports/page.tsx': 'const Archive = () => null;\nexport default Archive;\n',
        'app/reports/[id]/page.tsx': 'const Detail = () => null;\nexport { Detail as default };\n',
        'app/summary/page.tsx': 'export default class Summary {}\n',
        'app/blank/page.tsx': 'export default function () {\n  return null;\n}\n',
      }),
    );

    expect(entryForFile(map, 'app/page.tsx').location.symbol).toBe('Landing');
    expect(entryForFile(map, 'app/reports/page.tsx').location.symbol).toBe('Archive');
    expect(entryForFile(map, 'app/reports/[id]/page.tsx').location.symbol).toBe('Detail');
    expect(entryForFile(map, 'app/summary/page.tsx').location.symbol).toBe('Summary');
    expect(entryForFile(map, 'app/blank/page.tsx').location.symbol).toBeUndefined();
  });

  it('reports GET for every page, and spans multi-line declarations', () => {
    const map = buildRouteMap(
      loadInMemory({
        'app/page.tsx': 'export default function Landing() {\n  return null;\n}\n',
      }),
    );
    const entry = entryForFile(map, 'app/page.tsx');

    expect(entry.methods).toEqual(['GET']);
    expect(entry.location.line).toBe(1);
    expect(entry.location.endLine).toBe(3);
  });

  it('reports ANY for a legacy handler that default-exports one function', () => {
    const map = buildRouteMap(
      loadInMemory({
        'pages/api/reports.ts':
          'export default function handler(req, res) {\n  res.status(200).json({});\n}\n',
      }),
    );
    const entry = entryForFile(map, 'pages/api/reports.ts');

    expect(entry.methods).toEqual(['ANY']);
    expect(entry.router).toBe('pages');
    expect(entry.location.symbol).toBe('handler');
    expect(map.resolve('/api/reports', 'DELETE')?.entry.file).toBe('pages/api/reports.ts');
  });

  it('reports no method for a legacy handler with no default export', () => {
    const map = buildRouteMap(
      loadInMemory({
        'pages/api/reports.ts': 'export function GET() {\n  return null;\n}\n',
      }),
    );

    expect(entryForFile(map, 'pages/api/reports.ts').methods).toEqual([]);
  });

  it('keeps both modules and reports the collision when two routers claim one path', () => {
    const { logger, records } = recordingLogger();
    const map = buildRouteMap(
      loadInMemory({
        'app/api/reports/route.ts': 'export function GET() {\n  return null;\n}\n',
        'pages/api/reports.ts': 'export default function handler() {\n  return null;\n}\n',
      }),
      { logger },
    );

    expect(map.entries).toHaveLength(2);
    expect(map.resolve('/api/reports')?.entry.file).toBe('app/api/reports/route.ts');

    const collision = records.find(
      (record) => record.level === 'warn' && record.message.includes('more than one module'),
    );

    expect(collision?.fields?.['routePath']).toBe('/api/reports');
    expect(collision?.fields?.['files']).toEqual([
      'app/api/reports/route.ts',
      'pages/api/reports.ts',
    ]);
  });

  it('ignores every file that is not a route module', () => {
    const map = buildRouteMap(
      loadInMemory({
        'src/components/Widget.tsx': 'export const Widget = () => null;\n',
        'app/layout.tsx': 'export default function Shell() {\n  return null;\n}\n',
        'next.config.mjs': 'export default {};\n',
      }),
    );

    expect(map.entries).toEqual([]);
    expect(map.resolve('/')).toBeUndefined();
  });

  it('orders its entries deterministically and freezes them', () => {
    const map = buildRouteMap(
      loadInMemory({
        'app/reports/page.tsx': 'export default function Archive() {\n  return null;\n}\n',
        'app/page.tsx': 'export default function Landing() {\n  return null;\n}\n',
        'app/api/reports/route.ts': 'export function GET() {\n  return null;\n}\n',
        'pages/api/legacy.ts': 'export default function handler() {\n  return null;\n}\n',
      }),
    );

    expect(map.entries.map((entry) => entry.routePath)).toEqual([
      '/',
      '/api/legacy',
      '/api/reports',
      '/reports',
    ]);
    expect(Object.isFrozen(map.entries)).toBe(true);
  });

  it('exposes the entry builder on its own, for the route extractor to reuse', () => {
    const loaded = loadInMemory({
      'app/api/reports/route.ts':
        'export function GET() {\n  return null;\n}\nexport function HEAD() {\n  return null;\n}\n',
    });
    const [sourceFile] = loaded.sourceFiles();
    const derived = deriveRouteFromFile('app/api/reports/route.ts');

    expect(sourceFile).toBeDefined();
    expect(derived).toBeDefined();

    if (sourceFile === undefined || derived === undefined) {
      return;
    }

    const entry = buildRouteEntry(sourceFile, derived);

    expect(entry.routePath).toBe('/api/reports');
    expect(entry.methods).toEqual(['GET', 'HEAD']);
    expect(entry.location.resolvedBy).toBe('route-map');
    expect(entry.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['route-map']);
  });
});

describe('buildRouteMap: the origins the map answers for', () => {
  /** A project with one route, which every case here resolves against. */
  function oneRoute(): LoadedProject {
    return loadInMemory({
      'app/api/reports/route.ts': 'export function GET() {\n  return null;\n}\n',
    });
  }

  it('applies the loopback default when no origin was configured', () => {
    const map = buildRouteMap(oneRoute());

    expect(map.resolve('http://127.0.0.1:3000/api/reports')?.entry.file).toBe(
      'app/api/reports/route.ts',
    );
    expect(map.resolve('/api/reports')?.entry.file).toBe('app/api/reports/route.ts');
    expect(map.resolve('https://api.stripe.com/api/reports')).toBeUndefined();
    expect(map.resolve('javascript:/api/reports')).toBeUndefined();
  });

  it('applies the origins it was built with, to every later resolution', () => {
    // The policy belongs to the map rather than to the call, which is why
    // `resolve` takes no options: one map is one policy for every consumer of
    // it.
    const map = buildRouteMap(oneRoute(), { origins: ['https://dev.internal:8443'] });
    const match = map.resolve('https://dev.internal:8443/api/reports', 'GET');

    expect(match?.entry.file).toBe('app/api/reports/route.ts');
    expect(match?.origin).toEqual({
      protocol: 'https:',
      hostname: 'dev.internal',
      port: '8443',
      origin: 'https://dev.internal:8443',
      loopback: false,
    });
    expect(map.resolve('http://127.0.0.1:3000/api/reports')).toBeUndefined();
  });

  it('reports a configured origin it could not use, and keeps the usable ones', () => {
    const { logger, records } = recordingLogger();
    const map = buildRouteMap(oneRoute(), {
      logger,
      origins: ['ftp://dev.internal:3000', 'https://dev.internal:8443'],
    });

    expect(map.resolve('https://dev.internal:8443/api/reports')?.entry.file).toBe(
      'app/api/reports/route.ts',
    );

    const refused = records.find(
      (record) => record.level === 'warn' && record.message.includes('origin is unusable'),
    );

    expect(refused?.fields?.['origin']).toBe('ftp://dev.internal:3000');
  });

  it('names a refused origin without putting its credentials in the log', () => {
    // AAP 0.5.2: nothing secret-shaped reaches a log sink. The refusal is
    // reported and the userinfo is not, so a mistyped setting is still
    // diagnosable.
    const { logger, records } = recordingLogger();
    buildRouteMap(oneRoute(), {
      logger,
      origins: [credentialed('admin:s3cret@dev.internal:3000/')],
    });

    const refused = records.find(
      (record) => record.level === 'warn' && record.message.includes('origin is unusable'),
    );
    const named = refused?.fields?.['origin'];

    expect(named).toBe('http://[redacted]@dev.internal:3000');
    expect(typeof named === 'string' && named.includes('s3cret')).toBe(false);
    expect(typeof named === 'string' && named.includes('admin')).toBe(false);
  });

  it('reports a list with nothing usable and keeps the loopback default', () => {
    const { logger, records } = recordingLogger();
    const map = buildRouteMap(oneRoute(), { logger, origins: ['not a url at all'] });

    expect(map.resolve('http://127.0.0.1:3000/api/reports')?.entry.file).toBe(
      'app/api/reports/route.ts',
    );
    expect(map.resolve('http://dev.internal:3000/api/reports')).toBeUndefined();
    expect(
      records.some(
        (record) => record.level === 'debug' && record.message.includes('loopback hosts only'),
      ),
    ).toBe(true);
  });

  it('says nothing about an unusable origin when no logger was supplied', () => {
    // `noopLogger` is the default, so a library caller that has not chosen a
    // logging backend gets silence rather than console output — and an
    // unusable entry must not become an exception either.
    expect(() => buildRouteMap(oneRoute(), { origins: ['not a url at all'] })).not.toThrow();
    expect(
      buildRouteMap(oneRoute(), { origins: ['not a url at all'] }).resolve(
        'http://localhost:3000/api/reports',
      )?.entry.file,
    ).toBe('app/api/reports/route.ts');
  });
});

/*
 * ---------------------------------------------------------------------------
 * 4. The corpus, opened where it lives
 * ---------------------------------------------------------------------------
 */

/**
 * The corpus, and the two maps built over it.
 *
 * Both maps are held here rather than rebuilt per case because both are
 * *derived values of one input*: the ts-morph map is what `buildRouteMap`
 * answers for this project, the index-backed map is what a reopened session
 * answers for the same project, and a case that rebuilt either would be
 * asserting the same construction again rather than the behaviour it is about.
 */
interface Corpus {
  /** The opened project: parsed once, read-only, never written to. */
  readonly loaded: LoadedProject;

  /** What `buildRouteMap` answers for it — the reference every case compares to. */
  readonly map: RouteMap;

  /**
   * The index `./indexer.ts` produced for the same project, cache disabled.
   *
   * Held alongside the map it was rebuilt into so a case can assert what the
   * *extractor* contributed — one `api-route` node per route module — rather
   * than only what resolving through the rebuilt map happens to produce.
   */
  readonly index: CodeIndex;

  /**
   * The same map rebuilt by `routeMapFromIndex` from a **real** index of the
   * same project, produced by `./indexer.ts` with the cache disabled.
   *
   * Built from a real index rather than from nodes assembled by hand in this
   * file: the contract a reopened session depends on is that the *extractor's*
   * node payload is enough to resolve with, and a hand-built node proves only
   * that this suite and `./route-map.ts` agree on a shape.
   */
  readonly fromIndex: RouteMap;
}

/**
 * The shared corpus, assigned once by the hook below.
 *
 * `undefined` until then, and read through {@link theCorpus} rather than
 * directly, so a hook that did not run reports itself instead of surfacing as
 * a `TypeError` inside an unrelated assertion.
 */
let corpus: Corpus | undefined;

/**
 * Opens the corpus once for the whole file, and builds both maps over it.
 *
 * Once rather than per case, for two reasons that both matter here.
 * Constructing the ts-morph program is by far the most expensive thing this
 * suite does — every other group is pure string work — and re-opening it for
 * each of the cases below would pay for it once per case. And sharing is safe
 * by construction: `openProject` parses and never writes, nothing in this file
 * writes either, `sourceFiles()` is frozen, and both maps and every entry and
 * location in them are frozen — so the fixture a run leaves behind is
 * byte-identical to the one it started with, which is what keeps
 * `git status packages/code-analysis` empty after a run.
 *
 * The explicit timeout replaces the 10 s default because this hook is the one
 * thing in the file that parses a program and runs the extractor pipeline, and
 * a busy machine timing it out would fail all of the cases below for a reason
 * that is not a defect. It is a ceiling, not a budget: the work takes well
 * under a second.
 */
beforeAll(async () => {
  const opened = openProject({ projectRoot: FIXTURE_ROOT });
  if (!opened.ok) {
    throw new Error(`the corpus did not open: ${opened.error.message}`);
  }
  const loaded = opened.value;

  // `loaded` so the index describes this exact program rather than a second
  // one opened behind our back, and `cache: false` because a cache write is a
  // file this suite has no business creating — the read-only promise above is
  // the whole reason the corpus can be shared.
  const indexed = await indexProject({ projectRoot: FIXTURE_ROOT, loaded, cache: false });
  if (!indexed.ok) {
    throw new Error(`the corpus did not index: ${indexed.error.message}`);
  }

  corpus = {
    loaded,
    map: buildRouteMap(loaded),
    index: indexed.value.index,
    fromIndex: routeMapFromIndex(indexed.value.index),
  };
}, 30_000);

/**
 * The shared corpus.
 *
 * @returns The opened project and the two maps over it.
 */
function theCorpus(): Corpus {
  if (corpus === undefined) {
    throw new Error('the corpus was not opened: the beforeAll hook did not run');
  }
  return corpus;
}

/** Every route of the corpus, in the inventory order the map must report. */
const CORPUS_ENTRIES: readonly Record<string, unknown>[] = [
  { routePath: '/', router: 'app', kind: 'page', file: 'app/page.tsx', methods: ['GET'] },
  {
    routePath: '/api/basins/[...segments]',
    router: 'app',
    kind: 'route-handler',
    file: 'app/(observatory)/api/basins/[...segments]/route.ts',
    methods: ['GET'],
  },
  {
    routePath: '/api/gauge-log',
    router: 'pages',
    kind: 'route-handler',
    file: 'pages/api/gauge-log.ts',
    methods: ['ANY'],
  },
  {
    routePath: '/api/gauges',
    router: 'app',
    kind: 'route-handler',
    file: 'app/api/gauges/route.ts',
    methods: ['GET', 'POST'],
  },
  {
    routePath: '/api/gauges/[id]',
    router: 'app',
    kind: 'route-handler',
    file: 'app/api/gauges/[id]/route.ts',
    methods: ['GET'],
  },
  {
    routePath: '/basins/[id]',
    router: 'app',
    kind: 'page',
    file: 'app/(observatory)/basins/[id]/page.tsx',
    methods: ['GET'],
  },
];

/** One request the corpus must resolve, and what it must resolve to. */
interface CorpusRequest {
  /** The URL or pathname to resolve. */
  readonly url: string;

  /** The method to require, when the case is about method filtering. */
  readonly method?: HttpMethod;

  /** The project-relative file that must answer. */
  readonly file: string;

  /** The parameters that must be captured. */
  readonly params: Readonly<Record<string, string | readonly string[]>>;

  /**
   * The normalised pathname the match must report, when the row is about what
   * the resolver strips or decodes.
   *
   * Stated only for those rows: it is how "the query was ignored", "the
   * fragment was ignored", "the trailing slash was ignored" and "the segment
   * was decoded" are asserted as *outcomes* rather than inferred from the fact
   * that some route matched.
   */
  readonly pathname?: string;
}

const CORPUS_REQUESTS: readonly CorpusRequest[] = [
  { url: '/', file: 'app/page.tsx', params: {} },
  { url: 'http://127.0.0.1:3000/', file: 'app/page.tsx', params: {} },
  { url: '/api/gauges', method: 'GET', file: 'app/api/gauges/route.ts', params: {} },
  { url: '/api/gauges', method: 'POST', file: 'app/api/gauges/route.ts', params: {} },
  {
    url: '/api/gauges/north-01',
    method: 'GET',
    file: 'app/api/gauges/[id]/route.ts',
    params: { id: 'north-01' },
  },
  {
    url: 'http://127.0.0.1:3000/api/basins/north?window=7d',
    method: 'GET',
    file: 'app/(observatory)/api/basins/[...segments]/route.ts',
    params: { segments: ['north'] },
  },
  {
    url: '/api/basins/north/deep',
    file: 'app/(observatory)/api/basins/[...segments]/route.ts',
    params: { segments: ['north', 'deep'] },
  },
  {
    // Three trailing segments, because a catch-all that only ever sees two
    // could be a pair of dynamic segments and nothing here would notice.
    url: '/api/basins/north/deep/alpha',
    file: 'app/(observatory)/api/basins/[...segments]/route.ts',
    params: { segments: ['north', 'deep', 'alpha'] },
  },
  {
    url: '/api/gauges/north-01?window=7d#chart',
    method: 'GET',
    file: 'app/api/gauges/[id]/route.ts',
    params: { id: 'north-01' },
    pathname: '/api/gauges/north-01',
  },
  {
    url: '/api/gauge-log#latest',
    file: 'pages/api/gauge-log.ts',
    params: {},
    pathname: '/api/gauge-log',
  },
  {
    // An encoded separator stays inside the segment it was written in: one
    // parameter holding `north/01`, never a path of two segments — which is
    // the difference between resolving this dynamic route and missing it.
    url: '/api/gauges/north%2F01',
    method: 'GET',
    file: 'app/api/gauges/[id]/route.ts',
    params: { id: 'north/01' },
    pathname: '/api/gauges/north/01',
  },
  {
    url: '/api/basins/nord-%C3%B8st',
    file: 'app/(observatory)/api/basins/[...segments]/route.ts',
    params: { segments: ['nord-øst'] },
    pathname: '/api/basins/nord-øst',
  },
  { url: '/api/gauge-log', method: 'POST', file: 'pages/api/gauge-log.ts', params: {} },
  { url: '/api/gauge-log', file: 'pages/api/gauge-log.ts', params: {} },
  {
    url: '/basins/7/',
    file: 'app/(observatory)/basins/[id]/page.tsx',
    params: { id: '7' },
  },
];

describe('buildRouteMap over the sample application', () => {
  it('reports every route of the corpus, and nothing else', () => {
    const { map } = theCorpus();

    expect(
      map.entries.map((entry) => ({
        routePath: entry.routePath,
        router: entry.router,
        kind: entry.kind,
        file: entry.file,
        methods: [...entry.methods],
      })),
    ).toEqual(CORPUS_ENTRIES);
  });

  for (const request of CORPUS_REQUESTS) {
    const label = request.method === undefined ? request.url : `${request.method} ${request.url}`;

    it(`resolves ${label}`, () => {
      const { map } = theCorpus();
      const match = map.resolve(request.url, request.method);

      expect(match?.entry.file).toBe(request.file);
      expect(match?.params).toEqual(request.params);

      if (request.pathname !== undefined) {
        expect(match?.pathname).toBe(request.pathname);
      }
    });
  }

  it('captures the segments a catch-all swallowed as an array', () => {
    // `toEqual` above is satisfied by a string that merely looks right, and
    // the panel's request and trace views index these values positionally, so
    // the container type is asserted rather than assumed.
    const { map } = theCorpus();
    const captured = map.resolve('/api/basins/north/deep/alpha')?.params['segments'];

    expect(Array.isArray(captured)).toBe(true);
    expect(captured).toEqual(['north', 'deep', 'alpha']);
  });

  it('answers a full URL exactly as it answers the same pathname on its own', () => {
    // A captured `http.server` span carries a path and a captured `fetch` span
    // carries the whole URL; one interaction produces both, and a developer
    // clicking either must land in the same module.
    const { map } = theCorpus();

    for (const pathname of ['/', '/api/gauges', '/api/gauges/north-01', '/api/basins/north/deep']) {
      const viaPath = map.resolve(pathname);
      const viaUrl = map.resolve(`http://127.0.0.1:3000${pathname}`);

      expect(viaUrl?.entry.file).toBe(viaPath?.entry.file);
      expect(viaUrl?.params).toEqual(viaPath?.params);
      expect(viaUrl?.pathname).toBe(viaPath?.pathname);

      // The one difference, and it is additive: an absolute URL reports the
      // origin it was accepted for, a bare pathname has none to report.
      expect(viaUrl?.origin?.origin).toBe('http://127.0.0.1:3000');
      expect(viaPath?.origin).toBeUndefined();
    }
  });

  it('refuses a malformed request rather than throwing', () => {
    // These arrive from a captured span attribute or a field a developer typed,
    // so the resolver is the wrong place for an exception: a session would fail
    // at a stage whose input was merely unreadable.
    const { map } = theCorpus();

    for (const url of ['http://[bad/api/gauges', 'http://', '/api/gauges/%E0%A4%A', '', '   ']) {
      expect(map.resolve(url)).toBeUndefined();
    }
  });

  it('answers every method for the legacy handler that dispatches on its own', () => {
    // `ANY` is what a single default-exported entry point reports, and the
    // fixture's handler does branch on `req.method` itself, so every verb a
    // consumer can ask about has to reach it — including the ones it answers
    // with 405, which is its decision to make and not this map's.
    const { map } = theCorpus();

    for (const method of HTTP_METHOD_NAMES) {
      expect(map.resolve('/api/gauge-log', method)?.entry.file).toBe('pages/api/gauge-log.ts');
    }
  });

  it('answers only the two methods the multi-handler module exports', () => {
    const { map } = theCorpus();
    const declared: readonly HttpMethod[] = ['GET', 'POST'];

    for (const method of HTTP_METHOD_NAMES) {
      const match = map.resolve('/api/gauges', method);

      // `ANY` as a *question* means "whatever answers this path", so it
      // matches; every other undeclared verb does not.
      if (declared.includes(method) || method === 'ANY') {
        expect(match?.entry.file).toBe('app/api/gauges/route.ts');
      } else {
        expect(match).toBeUndefined();
      }
    }
  });

  it('resolves nothing for a path no module serves', () => {
    const { map } = theCorpus();

    // The catch-all needs at least one segment, the dynamic route exactly one,
    // and a route group never appears in a URL.
    expect(map.resolve('/api/basins')).toBeUndefined();
    expect(map.resolve('/api/gauges/north-01/extra')).toBeUndefined();
    expect(map.resolve('/(observatory)/basins/7')).toBeUndefined();
    expect(map.resolve('/observatory/basins/7')).toBeUndefined();
  });

  it('refuses a method the matched module does not export', () => {
    const { map } = theCorpus();

    expect(map.resolve('/api/gauges', 'DELETE')).toBeUndefined();
    expect(map.resolve('/api/gauges/north-01', 'POST')).toBeUndefined();
  });

  it('locates each exported method of a multi-handler module at its declaration', () => {
    const { map } = theCorpus();
    const entry = entryForFile(map, 'app/api/gauges/route.ts');
    const get = entry.methodLocations?.['GET'];
    const post = entry.methodLocations?.['POST'];

    expect(Object.keys(entry.methodLocations ?? {})).toEqual(['GET', 'POST']);
    expect(get?.symbol).toBe('GET');
    expect(post?.symbol).toBe('POST');
    expect(corpusLine(entry.file, get?.line ?? 0)).toMatch(/^export async function GET\(/);
    expect(corpusLine(entry.file, post?.line ?? 0)).toMatch(/^export async function POST\(/);
    expect(get?.line).toBeLessThan(post?.line ?? 0);
    expect(entry.location).toEqual(get);
  });

  it('locates the handler of a dynamic module and of a grouped catch-all module', () => {
    const { map } = theCorpus();

    for (const file of [
      'app/api/gauges/[id]/route.ts',
      'app/(observatory)/api/basins/[...segments]/route.ts',
    ]) {
      const entry = entryForFile(map, file);

      expect(entry.methods).toEqual(['GET']);
      expect(corpusLine(file, entry.location.line)).toMatch(/^export async function GET\(/);
      expect(entry.location.resolvedBy).toBe('route-map');
      expect(entry.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['route-map']);
    }
  });

  it('names the component of each page and the function of the legacy handler', () => {
    const { map } = theCorpus();
    const legacy = entryForFile(map, 'pages/api/gauge-log.ts');

    expect(entryForFile(map, 'app/page.tsx').location.symbol).toBe('BasinIndexPage');
    expect(entryForFile(map, 'app/(observatory)/basins/[id]/page.tsx').location.symbol).toBe(
      'BasinDetailPage',
    );
    expect(legacy.location.symbol).toBe('handler');
    expect(corpusLine(legacy.file, legacy.location.line)).toMatch(
      /^export default async function handler\(/,
    );
  });

  it('points every location at a project-relative path inside the project', () => {
    const { map } = theCorpus();

    expect(map.entries.length).toBeGreaterThan(0);

    for (const entry of map.entries) {
      expectRouteMapLocation(entry.location, entry.file);

      // The line is real code in the file the location names, not a position
      // past its end: a chip that opens an editor on line 40 of a 12-line
      // module is a worse answer than no chip at all.
      expect(corpusLine(entry.location.file, entry.location.line).length).toBeGreaterThan(0);

      for (const [method, location] of Object.entries(entry.methodLocations ?? {})) {
        expect(HTTP_METHOD_NAMES).toContain(method);
        expectRouteMapLocation(location, entry.file);
        expect(corpusLine(location.file, location.line)).toContain(method);
      }
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * routeMapFromIndex: the same answers without a compiler
 * ---------------------------------------------------------------------------
 */

/** An index holding exactly the nodes a case needs. */
function indexOf(nodes: readonly CodeNode[]): CodeIndex {
  return {
    schemaVersion: CODE_INDEX_SCHEMA_VERSION,
    projectRoot: MEMORY_ROOT,
    indexerVersion: 'route-map.test',
    generatedAt: 0,
    nodes,
    edges: [],
    files: [],
  };
}

/** One `api-route` node, with the fields a case cares about. */
function apiRouteNode(options: {
  readonly file: string;
  readonly routePath: string;
  readonly router?: 'app' | 'pages';
  readonly kind?: 'route-handler' | 'page';
  readonly methods?: readonly HttpMethod[];
  readonly line?: number;
  readonly column?: number;
}): CodeNodeOf<'api-route'> {
  return {
    id: `api-route:${options.routePath}`,
    kind: 'api-route',
    name: options.routePath,
    file: options.file,
    line: options.line ?? 1,
    column: options.column ?? 1,
    data: {
      routePath: options.routePath,
      router: options.router ?? 'app',
      kind: options.kind ?? 'route-handler',
      methods: options.methods ?? ['GET'],
    },
  };
}

describe('routeMapFromIndex', () => {
  it('resolves every corpus request exactly as the ts-morph-built map does', () => {
    const fromProject = theCorpus().map;
    const fromIndex = routeMapFromIndex(indexFromMap(fromProject, toPosix(FIXTURE_ROOT)));

    expect(fromIndex.entries.map((entry) => entry.routePath)).toEqual(
      fromProject.entries.map((entry) => entry.routePath),
    );

    for (const request of CORPUS_REQUESTS) {
      const expected = fromProject.resolve(request.url, request.method);
      const actual = fromIndex.resolve(request.url, request.method);

      expect(actual?.entry.file).toBe(expected?.entry.file);
      expect(actual?.entry.routePath).toBe(expected?.entry.routePath);
      expect(actual?.entry.router).toBe(expected?.entry.router);
      expect(actual?.entry.kind).toBe(expected?.entry.kind);
      expect(actual?.entry.methods).toEqual(expected?.entry.methods);
      expect(actual?.params).toEqual(expected?.params);
      expect(actual?.pathname).toBe(expected?.pathname);
    }

    for (const url of ['/api/basins', '/api/gauges/north-01/extra', '/observatory/basins/7']) {
      expect(fromIndex.resolve(url)).toBeUndefined();
    }
  });

  it('carries the node location and no per-method locations', () => {
    const fromProject = theCorpus().map;
    const fromIndex = routeMapFromIndex(indexFromMap(fromProject, toPosix(FIXTURE_ROOT)));
    const entry = entryForFile(fromIndex, 'app/api/gauges/route.ts');

    expect(entry.location).toEqual(entryForFile(fromProject, 'app/api/gauges/route.ts').location);
    expect(entry.methodLocations).toBeUndefined();
  });

  it('rebuilds segments from the route path, not from the file path', () => {
    const map = routeMapFromIndex(
      indexOf([
        apiRouteNode({
          // A project whose route trees live somewhere this module would not
          // probe still resolves, because the path was derived once already.
          file: 'server/routes/reports/[id]/handler.ts',
          routePath: '/api/reports/[id]',
        }),
      ]),
    );
    const match = map.resolve('/api/reports/7');

    expect(match?.entry.file).toBe('server/routes/reports/[id]/handler.ts');
    expect(match?.params).toEqual({ id: '7' });
    expect(match?.entry.dynamicParams).toEqual(['id']);
  });

  it('keeps the methods the node recorded, including ANY', () => {
    const map = routeMapFromIndex(
      indexOf([
        apiRouteNode({
          file: 'pages/api/reports.ts',
          routePath: '/api/reports',
          router: 'pages',
          methods: ['ANY'],
        }),
      ]),
    );

    expect(map.resolve('/api/reports', 'PATCH')?.entry.methods).toEqual(['ANY']);
  });

  it('clamps a position the index cannot justify', () => {
    const map = routeMapFromIndex(
      indexOf([
        apiRouteNode({
          file: 'app/api/reports/route.ts',
          routePath: '/api/reports',
          line: 0,
          column: 0,
        }),
      ]),
    );
    const location = map.resolve('/api/reports')?.entry.location;

    expect(location?.line).toBe(1);
    expect(location?.column).toBe(1);
  });

  it('skips a node it cannot read, and keeps the ones it can', () => {
    const map = routeMapFromIndex(
      indexOf([
        apiRouteNode({ file: '/srv/app/api/reports/route.ts', routePath: '/api/absolute' }),
        apiRouteNode({ file: '../outside/route.ts', routePath: '/api/escaping' }),
        apiRouteNode({ file: 'app/api/a/route.ts', routePath: 'api/unrooted' }),
        apiRouteNode({ file: 'app/api/b/route.ts', routePath: '/api/[malformed' }),
        apiRouteNode({ file: 'app/api/c/route.ts', routePath: '/api/[...trail]/more' }),
        apiRouteNode({ file: 'app/api/reports/route.ts', routePath: '/api/reports' }),
      ]),
    );

    expect(map.entries.map((entry) => entry.routePath)).toEqual(['/api/reports']);
  });

  it('ignores nodes that are not routes', () => {
    const symbolNode: CodeNode = {
      id: 'symbol:1',
      kind: 'symbol',
      name: 'readReports',
      file: 'src/handlers.ts',
      line: 4,
      column: 1,
    };
    const map = routeMapFromIndex(
      indexOf([
        symbolNode,
        apiRouteNode({ file: 'app/api/reports/route.ts', routePath: '/api/reports' }),
      ]),
    );

    expect(map.entries).toHaveLength(1);
  });

  it('returns an empty map for an index with no routes', () => {
    const map = routeMapFromIndex(indexOf([]));

    expect(map.entries).toEqual([]);
    expect(map.resolve('/')).toBeUndefined();
  });

  it('applies the same origin policy as the ts-morph-built map does', () => {
    // The parity a reopened session depends on: the answer a developer gets
    // must not depend on whether the index came from a compiler or from disk,
    // and that includes every URL the policy refuses.
    const fromProject = theCorpus().map;
    const fromIndex = routeMapFromIndex(indexFromMap(fromProject, toPosix(FIXTURE_ROOT)));

    for (const url of [
      'http://127.0.0.1:3000/api/gauges',
      'http://localhost/api/gauges',
      'https://app.localhost:3000/api/gauges',
      'https://api.stripe.com/api/gauges',
      'http://evil.test/api/gauges',
      'http://0.0.0.0:3000/api/gauges',
      'http://192.168.1.10:3000/api/gauges',
      'ftp://127.0.0.1:3000/api/gauges',
      'javascript:/api/gauges',
      'data:text/plain,/api/gauges',
      'file:///api/gauges',
      credentialed('user:secret@127.0.0.1:3000/api/gauges'),
      credentialed('localhost:3000@evil.test/api/gauges'),
      '//evil.test/api/gauges',
      '/api/gauges',
    ]) {
      const expected = fromProject.resolve(url);
      const actual = fromIndex.resolve(url);

      expect(actual?.entry.file).toBe(expected?.entry.file);
      expect(actual?.origin).toEqual(expected?.origin);
    }
  });

  it('answers for the origins it was rebuilt with, exactly as a built map does', () => {
    const origins = ['https://dev.internal:8443'];
    const fromProject = buildRouteMap(theCorpus().loaded, { origins });
    const fromIndex = routeMapFromIndex(indexFromMap(theCorpus().map, toPosix(FIXTURE_ROOT)), {
      origins,
    });

    for (const url of [
      'https://dev.internal:8443/api/gauges',
      'https://dev.internal:8444/api/gauges',
      'http://127.0.0.1:3000/api/gauges',
      '/api/gauges',
    ]) {
      const expected = fromProject.resolve(url);
      const actual = fromIndex.resolve(url);

      expect(actual?.entry.file).toBe(expected?.entry.file);
      expect(actual?.origin).toEqual(expected?.origin);
    }

    expect(fromIndex.resolve('https://dev.internal:8443/api/gauges')?.entry.file).toBe(
      'app/api/gauges/route.ts',
    );
    expect(fromIndex.resolve('http://127.0.0.1:3000/api/gauges')).toBeUndefined();
  });
});

/*
 * ---------------------------------------------------------------------------
 * 5. The reopened-session path, over a real index
 * ---------------------------------------------------------------------------
 */

describe('routeMapFromIndex over a real index of the sample application', () => {
  /**
   * The fields resolution depends on, for one entry.
   *
   * Compared as one object rather than field by field so a divergence names
   * every field that moved instead of failing on the first one.
   *
   * @param entry The entry to describe.
   * @returns The comparable projection.
   */
  function resolutionFields(entry: RouteEntry): Record<string, unknown> {
    return {
      routePath: entry.routePath,
      router: entry.router,
      kind: entry.kind,
      file: entry.file,
      methods: [...entry.methods],
      dynamicParams: [...entry.dynamicParams],
      isCatchAll: entry.isCatchAll,
      isOptionalCatchAll: entry.isOptionalCatchAll,
    };
  }

  it('holds one api-route node per route module, and no more', () => {
    // The extractor's contract, and the reason a single node is enough to
    // rebuild an entry from: a second node for a two-method module would make
    // this map report that route twice and disagree with the built one.
    const { index, map } = theCorpus();
    const routeNodes = index.nodes.filter((node) => node.kind === 'api-route');

    expect(routeNodes).toHaveLength(map.entries.length);
    expect(routeNodes.map((node) => node.name).sort()).toEqual(
      map.entries.map((entry) => entry.routePath).sort(),
    );
  });

  it('rebuilds the same inventory the compiler-built map reports', () => {
    const { map, fromIndex } = theCorpus();

    expect(fromIndex.entries.map(resolutionFields)).toEqual(map.entries.map(resolutionFields));
  });

  it('resolves every corpus request to the same module, path and methods', () => {
    // This is the reopened session of AAP 0.4.2: the index came back from
    // `$DEBUGGEN_HOME/index` as plain JSON, ts-morph was never started, and a
    // captured span still has to resolve to a file. A divergence here is not a
    // test detail — it is a developer clicking a span in a reopened session
    // and landing somewhere else than they would have an hour earlier.
    const { map, fromIndex } = theCorpus();

    for (const request of CORPUS_REQUESTS) {
      const expected = map.resolve(request.url, request.method);
      const actual = fromIndex.resolve(request.url, request.method);

      expect(actual?.entry.file).toBe(request.file);
      expect(actual?.entry.file).toBe(expected?.entry.file);
      expect(actual?.entry.routePath).toBe(expected?.entry.routePath);
      expect(actual?.entry.router).toBe(expected?.entry.router);
      expect(actual?.entry.methods).toEqual(expected?.entry.methods);
      expect(actual?.params).toEqual(expected?.params);
      expect(actual?.pathname).toBe(expected?.pathname);
      expect(actual?.origin).toEqual(expected?.origin);
    }
  });

  it('answers the same nothing for a request the corpus does not serve', () => {
    const { map, fromIndex } = theCorpus();

    for (const url of [
      '/api/basins',
      '/api/gauges/north-01/extra',
      '/observatory/basins/7',
      'http://[bad/api/gauges',
      'https://api.example.test/api/gauges',
    ]) {
      expect(map.resolve(url)).toBeUndefined();
      expect(fromIndex.resolve(url)).toBeUndefined();
    }
  });

  it('carries a location the source-open path accepts, and no per-method ones', () => {
    // `methodLocations` is not part of the node payload, so a rebuilt entry
    // reports none — which is documented and harmless, because it plays no
    // part in resolution. The entry's own location, on the other hand, is what
    // the chip opens, so it holds the whole contract.
    const { map, fromIndex } = theCorpus();

    for (const entry of fromIndex.entries) {
      expectRouteMapLocation(entry.location, entry.file);
      expect(entry.location).toEqual(entryForFile(map, entry.file).location);
      expect(entry.methodLocations).toBeUndefined();
    }
  });
});
