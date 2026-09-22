/**
 * Tests for `./route-map.ts`: the module that answers "which file serves this
 * URL?" and "what is the URL of this file?".
 *
 * The suite is in four parts, and a failure in each means something different:
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
 * ## 3. Syntax reading, over an in-memory project
 *
 * Which methods a module exports and where they are declared is read from the
 * abstract syntax tree, so these cases construct small modules in an
 * in-memory ts-morph project — one per export shape a real project uses. That
 * keeps each shape isolated and keeps the committed corpus from having to
 * carry seven variants of one route module.
 *
 * ## 4. The corpus, opened where it lives
 *
 * The last group runs {@link buildRouteMap} over
 * `test/fixtures/sample-next-app` through the real `openProject`, which is
 * what a consumer does with a developer's project. The corpus is deliberately
 * hybrid — an App Router tree with a Pages Router remnant — and it is read
 * **only**, never written, so a run leaves `git status` unchanged. This group
 * also proves the two constructors agree: a map rebuilt by
 * {@link routeMapFromIndex} from a persisted index resolves every corpus URL
 * exactly as the ts-morph-built map does, which is the contract a reopened
 * session in the local service depends on.
 *
 * Fixture route names are fixture-invented test data. No route literal of
 * theirs appears in `./route-map.ts`, and none should: the module derives, it
 * does not recognise.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DEFAULT_RESOLUTION_CONFIDENCE, joinPosix, relativePosix, toPosix } from '@debuggen/shared';
import type { LogFields, LogLevel, Logger, SourceLocation } from '@debuggen/shared';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';

import { CODE_INDEX_SCHEMA_VERSION } from './graph/types.js';
import type { CodeIndex, CodeNode, CodeNodeOf } from './graph/types.js';
import { openProject } from './project.js';
import type { LoadedProject } from './project.js';
import {
  buildRouteEntry,
  buildRouteMap,
  deriveRouteFromFile,
  matchRoute,
  routeMapFromIndex,
} from './route-map.js';
import type { HttpMethod, RouteEntry, RouteMap, RouteSegmentKind } from './route-map.js';

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

/** The read-only indexing corpus, opened where it lives and never written. */
const FIXTURE_ROOT = fileURLToPath(new URL('../test/fixtures/sample-next-app', import.meta.url));

/** The project root every in-memory case uses. */
const MEMORY_ROOT = '/project';

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
  },
  {
    what: 'a catch-all segment',
    file: 'app/api/reports/[...trail]/route.ts',
    routePath: '/api/reports/[...trail]',
    router: 'app',
    kind: 'route-handler',
  },
  {
    what: 'an optional catch-all segment',
    file: 'app/api/reports/[[...trail]]/route.ts',
    routePath: '/api/reports/[[...trail]]',
    router: 'app',
    kind: 'route-handler',
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
    what: 'a dynamic api module',
    file: 'pages/api/reports/[id].ts',
    routePath: '/api/reports/[id]',
    router: 'pages',
    kind: 'route-handler',
  },
  {
    what: 'a catch-all api module',
    file: 'pages/api/reports/[...trail].ts',
    routePath: '/api/reports/[...trail]',
    router: 'pages',
    kind: 'route-handler',
  },
  {
    what: 'an optional catch-all api module',
    file: 'pages/api/reports/[[...trail]].ts',
    routePath: '/api/reports/[[...trail]]',
    router: 'pages',
    kind: 'route-handler',
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
        const derived = deriveRouteFromFile(testCase.file);

        if (testCase.routePath === undefined) {
          expect(derived).toBeUndefined();
          return;
        }

        expect(derived?.routePath).toBe(testCase.routePath);
        expect(derived?.router).toBe(testCase.router);
        expect(derived?.kind).toBe(testCase.kind);
        expect(derived?.file).toBe(testCase.file);
      });
    }
  });

  describe('Pages Router', () => {
    for (const testCase of PAGES_ROUTER_CASES) {
      it(`derives ${testCase.what}`, () => {
        const derived = deriveRouteFromFile(testCase.file);

        if (testCase.routePath === undefined) {
          expect(derived).toBeUndefined();
          return;
        }

        expect(derived?.routePath).toBe(testCase.routePath);
        expect(derived?.router).toBe(testCase.router);
        expect(derived?.kind).toBe(testCase.kind);
      });
    }
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

      expect(matchRoute(root, 'app-scheme://host')?.pathname).toBe('/');
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

/*
 * ---------------------------------------------------------------------------
 * 4. The corpus, opened where it lives
 * ---------------------------------------------------------------------------
 */

/** The corpus, opened read-only exactly as a consumer opens a developer's project. */
function openCorpus(): LoadedProject {
  const opened = openProject({ projectRoot: FIXTURE_ROOT });
  if (!opened.ok) {
    throw new Error(`the corpus did not open: ${opened.error.message}`);
  }
  return opened.value;
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
    const map = buildRouteMap(openCorpus());

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
      const map = buildRouteMap(openCorpus());
      const match = map.resolve(request.url, request.method);

      expect(match?.entry.file).toBe(request.file);
      expect(match?.params).toEqual(request.params);
    });
  }

  it('resolves nothing for a path no module serves', () => {
    const map = buildRouteMap(openCorpus());

    // The catch-all needs at least one segment, the dynamic route exactly one,
    // and a route group never appears in a URL.
    expect(map.resolve('/api/basins')).toBeUndefined();
    expect(map.resolve('/api/gauges/north-01/extra')).toBeUndefined();
    expect(map.resolve('/(observatory)/basins/7')).toBeUndefined();
    expect(map.resolve('/observatory/basins/7')).toBeUndefined();
  });

  it('refuses a method the matched module does not export', () => {
    const map = buildRouteMap(openCorpus());

    expect(map.resolve('/api/gauges', 'DELETE')).toBeUndefined();
    expect(map.resolve('/api/gauges/north-01', 'POST')).toBeUndefined();
  });

  it('locates each exported method of a multi-handler module at its declaration', () => {
    const map = buildRouteMap(openCorpus());
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
    const map = buildRouteMap(openCorpus());

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
    const map = buildRouteMap(openCorpus());
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
    const map = buildRouteMap(openCorpus());

    for (const entry of map.entries) {
      expect(entry.location.file).toBe(entry.file);
      expect(entry.location.file.startsWith('/')).toBe(false);
      expect(entry.location.line).toBeGreaterThanOrEqual(1);
      expect(entry.location.column).toBeGreaterThanOrEqual(1);
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
    const fromProject = buildRouteMap(openCorpus());
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
    const fromProject = buildRouteMap(openCorpus());
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
});
