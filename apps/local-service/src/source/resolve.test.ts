/**
 * Unit tests for `./resolve.ts`, the source-location resolver.
 *
 * The code-analysis handles are real: `indexProject` indexes the workspace's
 * own `test/fixtures/sample-project` corpus (a route handler calling a service
 * calling two pooled-driver queries, plus a handful of components), and a
 * throwaway project written to a temporary directory supplies a name two files
 * declare. Everything with side effects — the modification journal, the
 * telemetry store, the stack resolver, `fetch` and the logger — is injected, so
 * no test touches the network or the session store, and every assertion reads
 * its expected confidence from `DEFAULT_RESOLUTION_CONFIDENCE` rather than
 * restating a number.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MAX_FRAMES,
  DEFAULT_MAX_MAPS,
  createCodeQueries,
  createSourceMapCache,
  indexProject,
} from '@debuggen/code-analysis';
import type { CodeGraph, CodeQueries, RouteMap, resolveStack } from '@debuggen/code-analysis';
import type { ModificationRecord, SelectedTarget } from '@debuggen/instrumentation';
import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  DebuggenError,
  SOURCE_RESOLVED_BY,
  err,
  newCaptureId,
  newEventId,
  newProducerId,
  newSessionId,
  newSpanId,
  newTraceId,
  ok,
} from '@debuggen/shared';
import type { LogFields, Logger, Result, SourceLocation } from '@debuggen/shared';
import { MAX_CALLER_LOOKUP_HOPS, allowedTiersFor } from '@debuggen/telemetry';
import type { TelemetryEvent, TelemetryKind } from '@debuggen/telemetry';

import {
  SOURCE_RESOLUTION_MISS_REASONS,
  SOURCE_RESOLVE_LIMITS,
  SOURCE_ROUTE_ORDER,
  createSourceResolver,
} from './resolve.js';
import type {
  ModificationCorroborationPort,
  ParentEventPort,
  SourceResolution,
  SourceResolverDeps,
} from './resolve.js';

/* -------------------------------------------------------------------------------------------------
 * Fixture project and handles
 * ---------------------------------------------------------------------------------------------- */

/** The workspace's own sample corpus, indexed once for the whole file. */
const SAMPLE_ROOT = fileURLToPath(new URL('../../test/fixtures/sample-project', import.meta.url));

/** Facts about the sample corpus the assertions below rely on (verified by the harness check). */
const SAMPLE = Object.freeze({
  routeFile: 'app/api/trail-report/route.ts',
  routePath: '/api/trail-report',
  serviceFile: 'src/server/services/trail-report.service.ts',
  serviceSymbol: 'loadTrailReport',
  poolFile: 'src/server/db/pool.ts',
  component: 'TrailCard',
  componentFile: 'src/components/TrailCard.tsx',
  outerComponent: 'TrailList',
});

/** The dev-server origin the source-map tests pin; loopback, never contacted. */
const DEV_ORIGIN = 'http://127.0.0.1:20191';

interface IndexedProject {
  readonly graph: CodeGraph;
  readonly routeMap: RouteMap;
  readonly queries: CodeQueries;
}

let sample: IndexedProject;
let duplicateRoot: string;
let duplicate: IndexedProject;

async function indexed(projectRoot: string): Promise<IndexedProject> {
  const result = await indexProject({ projectRoot });
  if (!result.ok) {
    throw new Error(`indexing the fixture failed: ${result.error.code}`);
  }
  const { graph, routeMap } = result.value;
  return { graph, routeMap, queries: createCodeQueries(graph, { routes: routeMap.entries }) };
}

beforeAll(async () => {
  sample = await indexed(SAMPLE_ROOT);

  // Two modules that each declare a component of the same name.
  duplicateRoot = mkdtempSync(join(tmpdir(), 'debuggen-resolve-'));
  writeFileSync(
    join(duplicateRoot, 'package.json'),
    JSON.stringify({ name: 'duplicate-names', private: true }),
  );
  writeFileSync(
    join(duplicateRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        jsx: 'preserve',
        strict: true,
        module: 'esnext',
        moduleResolution: 'bundler',
      },
      include: ['src'],
    }),
  );
  mkdirSync(join(duplicateRoot, 'src/first'), { recursive: true });
  mkdirSync(join(duplicateRoot, 'src/second'), { recursive: true });
  writeFileSync(
    join(duplicateRoot, 'src/first/Tile.tsx'),
    'export function Tile(props: { label: string }) {\n  return <span>{props.label}</span>;\n}\n',
  );
  writeFileSync(
    join(duplicateRoot, 'src/second/Tile.tsx'),
    'export function Tile(props: { count: number }) {\n  return <b>{props.count}</b>;\n}\n',
  );
  duplicate = await indexed(duplicateRoot);
}, 60_000);

afterAll(() => {
  rmSync(duplicateRoot, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------------------------------
 * Event, record and port fixtures
 * ---------------------------------------------------------------------------------------------- */

const SESSION = newSessionId();
const CAPTURE = newCaptureId();
const PRODUCER = newProducerId();
const TRACE = newTraceId();
const BASE_TIME = 1_750_000_000_000;

let seq = 0;

interface EventOverrides {
  readonly kind: TelemetryKind;
  readonly name?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly attributes?: Record<string, unknown>;
  readonly source?: SourceLocation;
  readonly startTime?: number;
  readonly sessionId?: string;
}

function firstTier(kind: TelemetryKind): TelemetryEvent['tier'] {
  const [tier] = allowedTiersFor(kind);
  if (tier === undefined) {
    throw new Error(`no tier for ${kind}`);
  }
  return tier;
}

function makeEvent(overrides: EventOverrides): TelemetryEvent {
  seq += 1;
  return {
    id: newEventId(),
    traceId: TRACE,
    spanId: overrides.spanId ?? newSpanId(),
    ...(overrides.parentSpanId === undefined ? {} : { parentSpanId: overrides.parentSpanId }),
    kind: overrides.kind,
    name: overrides.name ?? 'span',
    startTime: overrides.startTime ?? BASE_TIME + seq,
    duration: 4.5,
    tier: firstTier(overrides.kind),
    attributes: overrides.attributes ?? {},
    status: 'ok',
    producerId: PRODUCER,
    seq,
    ...(overrides.source === undefined ? {} : { source: overrides.source }),
    sessionId: overrides.sessionId ?? SESSION,
    captureId: CAPTURE,
    ingestSeq: seq,
  };
}

function patchSource(file: string, line: number, column: number, symbol: string): SourceLocation {
  return {
    file,
    line,
    column,
    symbol,
    resolvedBy: 'patch',
    confidence: DEFAULT_RESOLUTION_CONFIDENCE.patch,
  };
}

function record(
  file: string,
  status: ModificationRecord['status'],
  appliedAt = BASE_TIME - 1_000,
): ModificationRecord {
  return {
    id: 'mod_0123456789abcdef',
    sessionId: SESSION,
    planVersion: 1,
    file,
    originalHash: '0'.repeat(64),
    backupPath: '/tmp/debuggen-backups/original',
    instrumentedHash: '1'.repeat(64),
    appliedAt,
    status,
    diff: '',
  };
}

function journal(records: readonly ModificationRecord[]): ModificationCorroborationPort & {
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    listBySession(
      sessionId: string,
    ): Promise<Result<readonly ModificationRecord[], DebuggenError>> {
      calls.push(sessionId);
      return Promise.resolve(ok(records.filter((entry) => entry.sessionId === sessionId)));
    },
  };
}

function store(events: readonly TelemetryEvent[]): ParentEventPort {
  return {
    getBySpanId(
      sessionId: string,
      spanId: string,
    ): Result<TelemetryEvent | undefined, DebuggenError> {
      return ok(events.find((event) => event.sessionId === sessionId && event.spanId === spanId));
    },
  };
}

interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields;
}

function recordingLogger(entries: LogEntry[], bindings: LogFields = {}): Logger {
  const write =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields: { ...bindings, ...fields } });
    };
  return {
    level: 'trace',
    trace: write('trace'),
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    fatal: write('fatal'),
    child: (more: LogFields): Logger => recordingLogger(entries, { ...bindings, ...more }),
  };
}

/** A fetch that must never be reached by a test that does not expect it. */
function forbiddenFetch(): typeof fetch {
  return vi.fn(() => Promise.reject(new Error('network access is not allowed in unit tests')));
}

function resolverFor(overrides: Partial<SourceResolverDeps> = {}) {
  return createSourceResolver({
    projectRoot: SAMPLE_ROOT,
    queries: sample.queries,
    routeMap: sample.routeMap,
    graph: sample.graph,
    modifications: journal([]),
    fetchImpl: forbiddenFetch(),
    ...overrides,
  });
}

function resolvedOrThrow(
  result: Result<SourceResolution, DebuggenError>,
): Extract<SourceResolution, { status: 'resolved' }> {
  if (!result.ok) {
    throw new Error(`expected Ok, got ${result.error.code}`);
  }
  if (result.value.status !== 'resolved') {
    throw new Error(`expected resolved, got ${result.value.reason}`);
  }
  return result.value;
}

function unresolvedOrThrow(
  result: Result<SourceResolution, DebuggenError>,
): Extract<SourceResolution, { status: 'unresolved' }> {
  if (!result.ok) {
    throw new Error(`expected Ok, got ${result.error.code}`);
  }
  if (result.value.status !== 'unresolved') {
    throw new Error(`expected unresolved, got ${result.value.route}`);
  }
  return result.value;
}

/* -------------------------------------------------------------------------------------------------
 * Harness self-check
 * ---------------------------------------------------------------------------------------------- */

describe('fixture corpus', () => {
  it('holds the declarations the cases rely on', () => {
    expect(sample.queries.findSymbol(SAMPLE.serviceFile, SAMPLE.serviceSymbol)).toBeDefined();
    expect(sample.routeMap.entries.some((entry) => entry.routePath === SAMPLE.routePath)).toBe(
      true,
    );
    expect(
      sample.graph.nodesByKind('db-call').filter((node) => node.file === SAMPLE.poolFile),
    ).toHaveLength(2);
    expect(
      sample.queries.findByName(SAMPLE.component, { exact: true, kinds: ['component'] }),
    ).toHaveLength(1);
    expect(
      duplicate.queries.findByName('Tile', { exact: true, kinds: ['component'] }),
    ).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Public constants
 * ---------------------------------------------------------------------------------------------- */

describe('SOURCE_ROUTE_ORDER', () => {
  it('is SOURCE_RESOLVED_BY sorted by the shared default confidence, highest first', () => {
    const expected = [...SOURCE_RESOLVED_BY].sort(
      (left, right) => DEFAULT_RESOLUTION_CONFIDENCE[right] - DEFAULT_RESOLUTION_CONFIDENCE[left],
    );
    expect(SOURCE_ROUTE_ORDER).toEqual(expected);
    expect(new Set(SOURCE_ROUTE_ORDER)).toEqual(new Set(SOURCE_RESOLVED_BY));
    for (let index = 1; index < SOURCE_ROUTE_ORDER.length; index += 1) {
      const previous = SOURCE_ROUTE_ORDER[index - 1];
      const current = SOURCE_ROUTE_ORDER[index];
      if (previous === undefined || current === undefined) {
        throw new Error('route order has a hole');
      }
      expect(DEFAULT_RESOLUTION_CONFIDENCE[previous]).toBeGreaterThanOrEqual(
        DEFAULT_RESOLUTION_CONFIDENCE[current],
      );
    }
  });

  it('yields patch, route-map, code-graph, source-map, react-owner for today’s table', () => {
    expect(SOURCE_ROUTE_ORDER).toEqual([
      'patch',
      'route-map',
      'code-graph',
      'source-map',
      'react-owner',
    ]);
    expect(Object.isFrozen(SOURCE_ROUTE_ORDER)).toBe(true);
  });
});

describe('SOURCE_RESOLVE_LIMITS and SOURCE_RESOLUTION_MISS_REASONS', () => {
  it('derives the stack and parent-walk caps from their upstream constants', () => {
    expect(Object.isFrozen(SOURCE_RESOLVE_LIMITS)).toBe(true);
    expect(SOURCE_RESOLVE_LIMITS.maxStackFrames).toBe(DEFAULT_MAX_FRAMES);
    expect(SOURCE_RESOLVE_LIMITS.maxSourceMaps).toBe(DEFAULT_MAX_MAPS);
    expect(SOURCE_RESOLVE_LIMITS.maxParentHops).toBe(MAX_CALLER_LOOKUP_HOPS);
    expect(SOURCE_RESOLVE_LIMITS.maxNameCandidates).toBeGreaterThanOrEqual(2);
  });

  it('is a closed, duplicate-free vocabulary', () => {
    expect(Object.isFrozen(SOURCE_RESOLUTION_MISS_REASONS)).toBe(true);
    expect(new Set(SOURCE_RESOLUTION_MISS_REASONS).size).toBe(
      SOURCE_RESOLUTION_MISS_REASONS.length,
    );
  });
});

/* -------------------------------------------------------------------------------------------------
 * Route 1 — patch
 * ---------------------------------------------------------------------------------------------- */

describe('patch route', () => {
  function serviceDeclaration(): SourceLocation {
    const declared = sample.queries.findSymbol(SAMPLE.serviceFile, SAMPLE.serviceSymbol);
    if (declared === undefined) {
      throw new Error('fixture lost its service function');
    }
    return declared.location;
  }

  function patchedFunctionEvent(startTime?: number): TelemetryEvent {
    const declared = serviceDeclaration();
    return makeEvent({
      kind: 'function',
      name: SAMPLE.serviceSymbol,
      source: patchSource(declared.file, declared.line, declared.column, SAMPLE.serviceSymbol),
      attributes: { symbol: SAMPLE.serviceSymbol },
      ...(startTime === undefined ? {} : { startTime }),
    });
  }

  it('keeps a patch stamp the session journal corroborates, at the patch confidence', async () => {
    const resolver = resolverFor({
      modifications: journal([record(SAMPLE.serviceFile, 'applied')]),
    });
    const resolution = resolvedOrThrow(await resolver.resolveEvent(patchedFunctionEvent()));

    expect(resolution.route).toBe('patch');
    expect(resolution.location.resolvedBy).toBe('patch');
    expect(resolution.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE.patch);
    expect(resolution.location.file).toBe(SAMPLE.serviceFile);
    expect(resolution.location.line).toBe(serviceDeclaration().line);
    expect(resolution.attempted).toEqual([{ route: 'patch', outcome: 'hit' }]);
  });

  it('refuses an uncorroborated stamp and falls through to the code graph', async () => {
    const resolver = resolverFor({
      modifications: journal([record('src/elsewhere.ts', 'applied')]),
    });
    const resolution = resolvedOrThrow(await resolver.resolveEvent(patchedFunctionEvent()));

    expect(resolution.attempted[0]).toEqual({
      route: 'patch',
      outcome: 'rejected',
      reason: 'not-corroborated',
    });
    expect(resolution.route).toBe('code-graph');
    expect(resolution.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['code-graph']);
    expect(resolution.location).toEqual(serviceDeclaration());
  });

  it('accepts a reverted record only when the patch was applied before the span ran', async () => {
    const applied = BASE_TIME + 10_000;
    const resolver = resolverFor({
      modifications: journal([record(SAMPLE.serviceFile, 'reverted', applied)]),
    });

    const after = resolvedOrThrow(await resolver.resolveEvent(patchedFunctionEvent(applied + 5)));
    expect(after.route).toBe('patch');

    const before = resolvedOrThrow(await resolver.resolveEvent(patchedFunctionEvent(applied - 5)));
    expect(before.route).toBe('code-graph');
  });

  it('builds a candidate from forwarded patch meta attributes', async () => {
    const declared = serviceDeclaration();
    const resolver = resolverFor({
      modifications: journal([record(SAMPLE.serviceFile, 'conflict')]),
    });
    const event = makeEvent({
      kind: 'function',
      name: SAMPLE.serviceSymbol,
      attributes: {
        file: declared.file,
        line: declared.line,
        column: declared.column,
        symbol: SAMPLE.serviceSymbol,
      },
    });
    const resolution = resolvedOrThrow(await resolver.resolveEvent(event));
    expect(resolution.route).toBe('patch');
    expect(resolution.location).toMatchObject({
      file: declared.file,
      line: declared.line,
      column: declared.column,
      symbol: SAMPLE.serviceSymbol,
      confidence: DEFAULT_RESOLUTION_CONFIDENCE.patch,
    });
  });

  it('drops a candidate outside the project instead of repairing it', async () => {
    const resolver = resolverFor({
      modifications: journal([record(SAMPLE.serviceFile, 'applied')]),
    });
    for (const file of [
      '../outside/secrets.ts',
      '/etc/hosts',
      `${SAMPLE_ROOT}/${SAMPLE.serviceFile}`,
    ]) {
      const event = makeEvent({
        kind: 'function',
        name: 'notDeclaredAnywhere',
        attributes: { file, line: 3, column: 1, symbol: 'notDeclaredAnywhere' },
      });
      const resolution = unresolvedOrThrow(await resolver.resolveEvent(event));
      expect(resolution.reason).toBe('outside-project');
      expect(resolution).not.toHaveProperty('location');
      expect(resolution.attempted).toContainEqual({
        route: 'patch',
        outcome: 'rejected',
        reason: 'outside-project',
      });
    }
  });

  it('answers Err when the journal port fails or throws', async () => {
    const failing = resolverFor({
      modifications: {
        listBySession: () =>
          err(new DebuggenError('STORE_ERROR', 'The journal could not be read.')),
      },
    });
    const failed = await failing.resolveEvent(patchedFunctionEvent());
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe('STORE_ERROR');
    }

    const throwing = resolverFor({
      modifications: {
        listBySession: () => {
          throw new Error('boom');
        },
      },
    });
    const thrown = await throwing.resolveEvent(patchedFunctionEvent());
    expect(thrown.ok).toBe(false);
    if (!thrown.ok) {
      expect(thrown.error.code).toBe('STORE_ERROR');
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Route 2 — route-map
 * ---------------------------------------------------------------------------------------------- */

describe('route-map route', () => {
  function routeEntryLocation(): SourceLocation {
    const entry = sample.routeMap.entries.find(
      (candidate) => candidate.routePath === SAMPLE.routePath,
    );
    if (entry === undefined) {
      throw new Error('fixture lost its route');
    }
    return entry.methodLocations?.['GET'] ?? entry.location;
  }

  it('locates a request span at its route handler, unchanged, at the route-map confidence', async () => {
    const resolver = resolverFor();
    const event = makeEvent({
      kind: 'http.server',
      name: `GET ${SAMPLE.routePath}`,
      attributes: { 'http.method': 'GET', 'next.route': SAMPLE.routePath },
    });
    const resolution = resolvedOrThrow(await resolver.resolveEvent(event));
    expect(resolution.route).toBe('route-map');
    expect(resolution.location).toEqual(routeEntryLocation());
    expect(resolution.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['route-map']);
    expect(resolution.attempted.map((attempt) => attempt.route)).toEqual(['patch', 'route-map']);
  });

  it('matches a file-convention pattern and a concrete URL', async () => {
    const resolver = resolverFor();
    const suffixed = makeEvent({
      kind: 'route.handler',
      attributes: { 'http.method': 'GET', 'next.route': `${SAMPLE.routePath}/route` },
    });
    expect(resolvedOrThrow(await resolver.resolveEvent(suffixed)).location).toEqual(
      routeEntryLocation(),
    );

    const concrete = makeEvent({
      kind: 'http.server',
      attributes: { 'http.method': 'GET', url: `${SAMPLE.routePath}?trailId=?` },
    });
    expect(resolvedOrThrow(await resolver.resolveEvent(concrete)).location).toEqual(
      routeEntryLocation(),
    );
  });

  it('works from the code queries alone and degrades without any index', async () => {
    const event = makeEvent({
      kind: 'http.server',
      attributes: { 'http.method': 'GET', url: SAMPLE.routePath },
    });
    const queriesOnly = resolverFor({ routeMap: undefined });
    expect(resolvedOrThrow(await queriesOnly.resolveEvent(event)).route).toBe('route-map');

    const noIndex = resolverFor({ routeMap: undefined, queries: undefined, graph: undefined });
    const resolution = unresolvedOrThrow(await noIndex.resolveEvent(event));
    expect(resolution.reason).toBe('index-unavailable');
  });

  it('reports a request no route answers as unresolved', async () => {
    const resolver = resolverFor();
    const event = makeEvent({ kind: 'http.server', attributes: { url: '/no/such/route/here' } });
    expect(unresolvedOrThrow(await resolver.resolveEvent(event)).reason).toBe('symbol-not-found');
  });
});

/* -------------------------------------------------------------------------------------------------
 * Route 3 — code-graph
 * ---------------------------------------------------------------------------------------------- */

describe('code-graph route', () => {
  it('locates a render by component display name, unwrapping wrapper names', async () => {
    const resolver = resolverFor();
    const expected = sample.queries.findByName(SAMPLE.component, {
      exact: true,
      kinds: ['component'],
    })[0];

    for (const component of [SAMPLE.component, `Memo(${SAMPLE.component})`]) {
      const event = makeEvent({ kind: 'render', name: component, attributes: { component } });
      const resolution = resolvedOrThrow(await resolver.resolveEvent(event));
      expect(resolution.route).toBe('code-graph');
      expect(resolution.location).toEqual(expected?.location);
      expect(resolution.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['code-graph']);
    }
  });

  it('reports an ambiguous name rather than guessing', async () => {
    const resolver = resolverFor({
      projectRoot: duplicateRoot,
      queries: duplicate.queries,
      routeMap: duplicate.routeMap,
      graph: duplicate.graph,
    });
    const event = makeEvent({ kind: 'render', attributes: { component: 'Tile' } });
    const resolution = unresolvedOrThrow(await resolver.resolveEvent(event));
    expect(resolution.reason).toBe('ambiguous');
    expect(resolution).not.toHaveProperty('location');
  });

  it('reports an unknown component, and a missing index, as unresolved', async () => {
    const event = makeEvent({ kind: 'state', attributes: { component: 'NoComponentByThisName' } });
    expect(unresolvedOrThrow(await resolverFor().resolveEvent(event)).reason).toBe(
      'symbol-not-found',
    );
    expect(
      unresolvedOrThrow(await resolverFor({ queries: undefined }).resolveEvent(event)).reason,
    ).toBe('index-unavailable');
  });

  it('locates an unpatched function span by module and symbol', async () => {
    const event = makeEvent({
      kind: 'function',
      name: SAMPLE.serviceSymbol,
      attributes: { symbol: SAMPLE.serviceSymbol, module: SAMPLE.serviceFile },
    });
    const resolution = resolvedOrThrow(await resolverFor().resolveEvent(event));
    expect(resolution.route).toBe('code-graph');
    expect(resolution.location).toEqual(
      sample.queries.findSymbol(SAMPLE.serviceFile, SAMPLE.serviceSymbol)?.location,
    );
  });

  describe('database query call sites', () => {
    function callSiteInside(symbol: string): {
      readonly file: string;
      readonly line: number;
      readonly column: number;
    } {
      const node = sample.graph
        .nodesByKind('db-call')
        .find((candidate) => candidate.symbol === symbol);
      if (node === undefined) {
        throw new Error(`fixture lost the call site inside ${symbol}`);
      }
      return { file: node.file, line: node.line, column: node.column };
    }

    function queryFunctionName(): string {
      const calls = sample.graph.nodesByKind('db-call');
      const reachable = calls.find(
        (node) =>
          node.symbol !== undefined &&
          sample.queries.pathBetween(
            { file: SAMPLE.serviceFile, symbol: SAMPLE.serviceSymbol },
            node.id,
            { direction: 'out' },
          ) !== undefined,
      );
      if (reachable?.symbol === undefined) {
        throw new Error('fixture service reaches no query');
      }
      return reachable.symbol;
    }

    it('narrows through the enclosing function span to the one reachable call site', async () => {
      const parent = makeEvent({
        kind: 'function',
        name: SAMPLE.serviceSymbol,
        attributes: { symbol: SAMPLE.serviceSymbol, module: SAMPLE.serviceFile },
      });
      const query = makeEvent({
        kind: 'db.query',
        parentSpanId: parent.spanId,
        attributes: {
          'db.system': 'postgresql',
          'db.client': 'pg',
          'db.statement': 'SELECT * FROM t WHERE id = $1',
        },
      });
      const resolver = resolverFor({ events: store([parent]) });
      const resolution = resolvedOrThrow(await resolver.resolveEvent(query));

      expect(resolution.route).toBe('code-graph');
      expect(resolution.location).toMatchObject(callSiteInside(queryFunctionName()));
      expect(resolution.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['code-graph']);
    });

    it('narrows through a route handler span two calls away', async () => {
      const handler = makeEvent({
        kind: 'route.handler',
        attributes: { 'http.method': 'GET', 'next.route': SAMPLE.routePath },
      });
      const query = makeEvent({ kind: 'db.query', parentSpanId: handler.spanId, attributes: {} });
      const resolution = resolvedOrThrow(
        await resolverFor({ events: store([handler]) }).resolveEvent(query),
      );
      expect(resolution.location).toMatchObject(callSiteInside(queryFunctionName()));
    });

    it('is ambiguous with no enclosing span, and unavailable without a graph', async () => {
      const orphan = makeEvent({ kind: 'db.query', attributes: { 'db.client': 'pg' } });
      expect(unresolvedOrThrow(await resolverFor().resolveEvent(orphan)).reason).toBe('ambiguous');
      expect(
        unresolvedOrThrow(await resolverFor({ graph: undefined }).resolveEvent(orphan)).reason,
      ).toBe('index-unavailable');
    });

    it('answers Err when the parent-span port fails', async () => {
      const query = makeEvent({ kind: 'db.query', parentSpanId: newSpanId() });
      const result = await resolverFor({
        events: {
          getBySpanId: () => Promise.resolve(err(new DebuggenError('STORE_ERROR', 'unreadable'))),
        },
      }).resolveEvent(query);
      expect(result.ok).toBe(false);
    });
  });
});

/* -------------------------------------------------------------------------------------------------
 * Route 4 — source-map
 * ---------------------------------------------------------------------------------------------- */

describe('source-map route', () => {
  const CHUNK_STACK = [
    'Error',
    `    at loadThings (${DEV_ORIGIN}/_next/static/chunks/app/page.js:12:34)`,
    `    at onClick (${DEV_ORIGIN}/_next/static/chunks/app/page.js:40:9)`,
  ].join('\n');

  function mapped(file: string): SourceLocation {
    return {
      file,
      line: 21,
      column: 5,
      symbol: 'loadThings',
      resolvedBy: 'source-map',
      confidence: 0.1,
    };
  }

  it('drives resolveStack through the injected seams and keeps the first project frame', async () => {
    const fetchImpl = forbiddenFetch();
    const resolveStackImpl = vi.fn<typeof resolveStack>(() =>
      Promise.resolve([mapped(SAMPLE.componentFile), mapped(SAMPLE.serviceFile)]),
    );
    const resolver = resolverFor({ fetchImpl, resolveStackImpl, devServerOrigin: DEV_ORIGIN });
    const event = makeEvent({
      kind: 'fetch',
      attributes: { initiator: CHUNK_STACK, url: '/x?token=?' },
    });

    const resolution = resolvedOrThrow(await resolver.resolveEvent(event));
    expect(resolution.route).toBe('source-map');
    expect(resolution.location.file).toBe(SAMPLE.componentFile);
    // The producer's confidence is never kept: the route's default always is.
    expect(resolution.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['source-map']);

    expect(resolveStackImpl).toHaveBeenCalledTimes(1);
    const [stack, options] = resolveStackImpl.mock.calls[0] ?? [];
    expect(stack).toBe(CHUNK_STACK);
    expect(options).toMatchObject({
      projectRoot: SAMPLE_ROOT,
      devServerOrigin: DEV_ORIGIN,
      fetchImpl,
      maxFrames: DEFAULT_MAX_FRAMES,
      maxMaps: DEFAULT_MAX_MAPS,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('with the real resolver, only ever calls the injected fetch, for the pinned origin', async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      requested.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    const resolver = resolverFor({ fetchImpl, devServerOrigin: DEV_ORIGIN });
    const event = makeEvent({ kind: 'fetch', attributes: { initiator: CHUNK_STACK } });

    const resolution = unresolvedOrThrow(await resolver.resolveEvent(event));
    expect(resolution.reason).toBe('unmapped-frame');
    expect(fetchImpl).toHaveBeenCalled();
    for (const url of requested) {
      expect(url.startsWith(`${DEV_ORIGIN}/`)).toBe(true);
    }
  });

  it('refuses a mapped frame outside the project', async () => {
    const resolveStackImpl = vi.fn<typeof resolveStack>(() =>
      Promise.resolve([mapped('../elsewhere/x.ts')]),
    );
    const resolver = resolverFor({ resolveStackImpl, devServerOrigin: DEV_ORIGIN });
    const event = makeEvent({ kind: 'xhr', attributes: { initiator: CHUNK_STACK } });
    const resolution = unresolvedOrThrow(await resolver.resolveEvent(event));
    expect(resolution.reason).toBe('outside-project');
  });

  it('reports a missing stack and a missing dev-server origin without fetching', async () => {
    const resolveStackImpl = vi.fn<typeof resolveStack>(() => Promise.resolve([]));
    const withOrigin = resolverFor({ resolveStackImpl, devServerOrigin: DEV_ORIGIN });
    const noStack = makeEvent({ kind: 'fetch', attributes: { url: '/x' } });
    expect(unresolvedOrThrow(await withOrigin.resolveEvent(noStack)).reason).toBe(
      'no-initiator-stack',
    );

    const noOrigin = resolverFor({ resolveStackImpl });
    const withStack = makeEvent({ kind: 'fetch', attributes: { initiator: CHUNK_STACK } });
    expect(unresolvedOrThrow(await noOrigin.resolveEvent(withStack)).reason).toBe(
      'dev-server-unknown',
    );
    expect(resolveStackImpl).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------------------------------
 * Route 5 — react-owner
 * ---------------------------------------------------------------------------------------------- */

describe('react-owner route', () => {
  function target(componentChain: string[]): SelectedTarget {
    return {
      selector: 'main > ul > li:nth-child(2) > button',
      tagName: 'BUTTON',
      text: 'Details',
      componentChain,
      url: `${DEV_ORIGIN}/`,
    };
  }

  it('walks the chain nearest-first and re-stamps the location as react-owner', async () => {
    const resolution = resolvedOrThrow(
      await resolverFor().resolveTarget(
        target(['NoSuchOwner', SAMPLE.component, SAMPLE.outerComponent]),
      ),
    );
    const codeGraph = sample.queries.findByName(SAMPLE.component, {
      exact: true,
      kinds: ['component'],
    })[0];

    expect(resolution.route).toBe('react-owner');
    expect(resolution.location.resolvedBy).toBe('react-owner');
    expect(resolution.location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['react-owner']);
    expect(resolution.location.confidence).not.toBe(DEFAULT_RESOLUTION_CONFIDENCE['code-graph']);
    expect(resolution.location.file).toBe(codeGraph?.location.file);
    expect(resolution.location.line).toBe(codeGraph?.location.line);
    expect(resolution.attempted.map((attempt) => attempt.outcome)).toEqual([
      'skipped',
      'skipped',
      'skipped',
      'skipped',
      'hit',
    ]);
  });

  it('resolves an interaction event through its component chain', async () => {
    const event = makeEvent({
      kind: 'interaction',
      attributes: { componentChain: [SAMPLE.component, SAMPLE.outerComponent] },
    });
    expect(resolvedOrThrow(await resolverFor().resolveEvent(event)).route).toBe('react-owner');
  });

  it('answers unresolved for an empty or ambiguous chain', async () => {
    const empty = unresolvedOrThrow(await resolverFor().resolveTarget(target([])));
    expect(empty.reason).toBe('no-applicable-route');

    const ambiguous = unresolvedOrThrow(
      await resolverFor({
        projectRoot: duplicateRoot,
        queries: duplicate.queries,
        routeMap: duplicate.routeMap,
        graph: duplicate.graph,
      }).resolveTarget(target(['Tile'])),
    );
    expect(ambiguous.reason).toBe('ambiguous');
  });
});

/* -------------------------------------------------------------------------------------------------
 * Faults, cancellation, batches, privacy, determinism
 * ---------------------------------------------------------------------------------------------- */

describe('faults and cancellation', () => {
  it('answers Err for a malformed event and a malformed target', async () => {
    const resolver = resolverFor();
    const malformed = { ...makeEvent({ kind: 'render' }), traceId: 'not-a-trace-id' };
    const event = await resolver.resolveEvent(malformed);
    expect(event.ok).toBe(false);
    if (!event.ok) {
      expect(event.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    }

    const target = await resolver.resolveTarget({
      selector: '',
      tagName: 'DIV',
      componentChain: [],
      url: 'not a url',
    });
    expect(target.ok).toBe(false);
  });

  it('answers Err with an aborted reason when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await resolverFor().resolveEvent(
      makeEvent({ kind: 'render', attributes: { component: SAMPLE.component } }),
      {
        signal: controller.signal,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details).toMatchObject({ reason: 'aborted' });
    }
  });

  it('answers Err for a project root that is not absolute', async () => {
    const result = await resolverFor({ projectRoot: 'relative/root' }).resolveEvent(
      makeEvent({ kind: 'render', attributes: { component: SAMPLE.component } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PROJECT_NOT_FOUND');
    }
  });

  it('never throws when a code query throws', async () => {
    const throwing: CodeQueries = {
      ...sample.queries,
      findByName: () => {
        throw new Error('index exploded');
      },
    };
    const result = await resolverFor({ queries: throwing }).resolveEvent(
      makeEvent({ kind: 'render', attributes: { component: SAMPLE.component } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
    }
  });
});

describe('resolveEvents', () => {
  it('keys resolved events by id, skips malformed ones and shares one scope across the page', async () => {
    const declared = sample.queries.findSymbol(SAMPLE.serviceFile, SAMPLE.serviceSymbol);
    if (declared === undefined) {
      throw new Error('fixture lost its service function');
    }
    const modifications = journal([record(SAMPLE.serviceFile, 'applied')]);
    const caches = new Set<unknown>();
    const resolveStackImpl = vi.fn<typeof resolveStack>((_stack, options) => {
      caches.add(options.cache);
      return Promise.resolve([
        {
          file: SAMPLE.componentFile,
          line: 3,
          column: 1,
          resolvedBy: 'source-map',
          confidence: 0.75,
        },
      ]);
    });
    const resolver = resolverFor({ modifications, resolveStackImpl, devServerOrigin: DEV_ORIGIN });

    const patchedA = makeEvent({
      kind: 'function',
      source: patchSource(
        declared.location.file,
        declared.location.line,
        declared.location.column,
        SAMPLE.serviceSymbol,
      ),
    });
    const patchedB = makeEvent({
      kind: 'function',
      source: patchSource(
        declared.location.file,
        declared.location.line,
        declared.location.column,
        SAMPLE.serviceSymbol,
      ),
    });
    const fetchA = makeEvent({
      kind: 'fetch',
      attributes: { initiator: 'Error\n    at a (x.js:1:1)' },
    });
    const fetchB = makeEvent({
      kind: 'fetch',
      attributes: { initiator: 'Error\n    at b (x.js:1:1)' },
    });
    const parent = makeEvent({
      kind: 'function',
      name: SAMPLE.serviceSymbol,
      attributes: { symbol: SAMPLE.serviceSymbol, module: SAMPLE.serviceFile },
    });
    const query = makeEvent({
      kind: 'db.query',
      parentSpanId: parent.spanId,
      attributes: { 'db.client': 'pg' },
    });
    const unknown = makeEvent({
      kind: 'render',
      attributes: { component: 'NoComponentByThisName' },
    });
    const malformed = { ...makeEvent({ kind: 'render' }), spanId: 'zz' };

    const result = await resolver.resolveEvents([
      patchedA,
      fetchA,
      malformed,
      patchedB,
      fetchB,
      query,
      parent,
      unknown,
    ]);
    if (!result.ok) {
      throw new Error(`expected Ok, got ${result.error.code}`);
    }
    const located = result.value;

    expect([...located.keys()]).toEqual([
      patchedA.id,
      fetchA.id,
      patchedB.id,
      fetchB.id,
      query.id,
      parent.id,
    ]);
    expect(located.get(patchedA.id)?.resolvedBy).toBe('patch');
    expect(located.get(query.id)?.file).toBe(SAMPLE.poolFile);
    expect(located.has(unknown.id)).toBe(false);
    expect(located.has(malformed.id)).toBe(false);
    expect(modifications.calls).toEqual([SESSION]);
    expect(caches.size).toBe(1);
  });

  it('uses an injected cross-call cache as given', async () => {
    const shared = createSourceMapCache();
    const seen: unknown[] = [];
    const resolveStackImpl = vi.fn<typeof resolveStack>((_stack, options) => {
      seen.push(options.cache);
      return Promise.resolve([]);
    });
    const resolver = resolverFor({
      resolveStackImpl,
      devServerOrigin: DEV_ORIGIN,
      sourceMapCache: shared,
    });
    await resolver.resolveEvent(
      makeEvent({ kind: 'fetch', attributes: { initiator: 'Error\n    at a (x.js:1:1)' } }),
    );
    expect(seen).toEqual([shared]);
  });
});

describe('privacy and determinism', () => {
  it('never logs a statement, a URL, a query value, a stack or an attribute value', async () => {
    const entries: LogEntry[] = [];
    const privateValue = 'private-query-value';
    const statement = `SELECT * FROM accounts WHERE email = '${privateValue}'`;
    const stack = `Error\n    at leak (${DEV_ORIGIN}/_next/static/chunks/${privateValue}.js:1:1)`;
    const resolver = resolverFor({
      logger: recordingLogger(entries),
      devServerOrigin: DEV_ORIGIN,
      resolveStackImpl: () => Promise.resolve([]),
    });

    const events = [
      makeEvent({ kind: 'db.query', attributes: { 'db.statement': statement, 'db.client': 'pg' } }),
      makeEvent({ kind: 'http.server', attributes: { url: `/api/search?q=${privateValue}` } }),
      makeEvent({ kind: 'fetch', attributes: { initiator: stack, url: `/x?q=${privateValue}` } }),
      makeEvent({
        kind: 'render',
        attributes: { component: privateValue, changedProps: [privateValue] },
      }),
    ];
    for (const event of events) {
      await resolver.resolveEvent(event);
    }
    await resolver.resolveEvents(events);

    expect(entries.length).toBeGreaterThan(0);
    const logged = JSON.stringify(entries);
    expect(logged).not.toContain(privateValue);
    expect(logged).not.toContain('SELECT');
    expect(logged).not.toContain(DEV_ORIGIN);
    expect(entries.every((entry) => entry.fields['subsystem'] === 'source')).toBe(true);
  });

  it('answers identical input with identical output', async () => {
    const resolver = resolverFor();
    const event = makeEvent({ kind: 'render', attributes: { component: SAMPLE.component } });
    const first = await resolver.resolveEvent(event);
    const second = await resolver.resolveEvent(event);
    expect(second).toEqual(first);
  });
});
