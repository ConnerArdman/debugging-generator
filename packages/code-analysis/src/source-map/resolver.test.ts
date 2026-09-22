/**
 * Tests for `./resolver.ts`: a browser stack trace in, a clickable
 * `SourceLocation` out.
 *
 * This suite is the last line of defence for click-to-source accuracy. What the
 * resolver returns travels `SourceLink` -> `PanelActions.openSource` ->
 * `source.open` -> `showTextDocument` (AAP 0.4.2), so a location that is merely
 * *plausible* is worse than none at all: the editor opens, the developer reads
 * the wrong line, and nothing anywhere reports a fault. Three habits follow
 * from that, and they are why this file is shaped the way it is.
 *
 * 1. **Every expected number is transcribed from
 *    `../../test/fixtures/source-maps/README.md`, never computed from the
 *    implementation.** That document is the committed contract: it holds, per
 *    fixture, the generated -> original table in *raw source-map coordinates*
 *    (1-based line, 0-based column) together with each segment's `names` entry.
 *    Deriving the expectations by running `resolveStack` would make this suite
 *    a tautology and would let a coordinate-base bug ship with a green gate.
 *    The tables below are that document, retyped; a disagreement between the
 *    two is a fixture/implementation mismatch to report, never a number to
 *    adjust here.
 *
 * 2. **The three coordinate systems are named at every boundary.** A V8 frame
 *    is 1-based in line *and column*; `originalPositionFor` takes and returns a
 *    1-based line with a **0-based** column; `SourceLocation` (AAP 0.2.3) is
 *    1-based in both. So this file converts in exactly two places —
 *    {@link frameLine}/{@link stackFrameFor} add one going in, and
 *    {@link expectedSourceLocation} adds one coming out — and both are written
 *    as a commented step rather than as inline arithmetic. The reason is that
 *    the failure is silent: `originalPositionFor` defaults to a
 *    greatest-lower-bound search, so a needle one column early does not fail,
 *    it returns the *previous* segment. {@link describe} "column bases" exists
 *    for nothing but that, and it asserts the exact answer at three adjacent
 *    inputs so no single-sided mistake can pass.
 *
 * 3. **Skipping is the contract, so the negative cases are assertions about
 *    resolution, not about exceptions.** `resolveStack` and
 *    `resolveStackFrame` never throw and never reject: most frames of a real
 *    stack are unresolvable (bundler runtime, dependencies, `native`), and an
 *    exception would take down click-to-source for the whole chain instead of
 *    one rung of it. Every negative case therefore asserts
 *    `.resolves.toEqual([])` (or `.resolves.toBeUndefined()`) rather than
 *    `not.toThrow()`, so a regression that throws is caught as a failing
 *    assertion instead of surfacing as an unhandled rejection.
 *
 * ## What the fixtures buy, and why none of them is substitutable
 *
 * - `webpack-basin-page.js` is the only map carrying `sourcesContent`, so it is
 *   the only fixture that exercises "the original travelled with the map". It
 *   also carries the one `node_modules` source, which is the frame
 *   `normalizeSourcePath` must reject.
 * - `turbopack-gauge-route.js` is the repository's only **sectioned** document
 *   *and* it deliberately omits `sourcesContent`, so it covers two separate
 *   requirements at once: the `AnyMap` branch and the read-the-original-from-
 *   the-project branch. Its section 2 is the case that proves the resolver
 *   keeps the *authored* `sources` spelling (`turbopack:///./app/...`): the
 *   flattened tracer reports the `./`-collapsed form, which normalisation
 *   refuses, so a resolver that consulted only the tracer would silently lose
 *   every frame of that section.
 * - `turbopack-station-widget.js` names a map under a **different, hashed**
 *   stem, so it proves the pairing survives end to end from the directive
 *   rather than from the chunk's filename.
 * - `inline-map-basin-detail.js` carries its map in a `data:` URI and must
 *   resolve with exactly **one** HTTP request.
 * - `unmapped-observatory-runtime.js` has no directive at all.
 *
 * ## Harness
 *
 * One throwaway `node:http` listener on `127.0.0.1` and an ephemeral port
 * serves that folder as inert bytes with an accurate `Content-Length` — the
 * harness the fixtures' README specifies, and the origin every case pins to.
 * Nothing leaves loopback, no port is fixed (a sibling checkout on this host
 * may be running the same suite), and the two mutable cases copy into an
 * `mkdtemp` sandbox: `packages/code-analysis/test/fixtures/**` is a read-only
 * input, and `git status --porcelain packages/code-analysis` must stay empty
 * after `pnpm test`.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  isOk,
  isSourceLocation,
  ok,
  parseSourceLocation,
} from '@debuggen/shared';
import type { LogFields, LogLevel, Logger, SourceLocation } from '@debuggen/shared';
import { AnyMap, FlattenMap, TraceMap } from '@jridgewell/trace-mapping';
import type { SectionedSourceMapInput, SourceMapInput } from '@jridgewell/trace-mapping';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSourceMapCache, fetchSourceMap, isSectionedSourceMap } from './fetch-map.js';
import type { SourceMapCache, SourceMapDocument, SourceMapLookup } from './fetch-map.js';
import { normalizeSourcePath } from './normalize.js';
import {
  DEFAULT_MAX_FRAMES,
  DEFAULT_MAX_MAPS,
  parseStackFrames,
  resolveStack,
  resolveStackFrame,
} from './resolver.js';
import type { ResolveStackOptions, StackFrame } from './resolver.js';

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/** The committed chunk/map corpus. Read-only; its README is the contract. */
const FIXTURE_DIR = new URL('../../test/fixtures/source-maps/', import.meta.url);

/**
 * The indexed project every map's sources point into, and the `projectRoot`
 * every resolution below uses unless a case names a sandbox instead.
 *
 * Read in place rather than copied: the resolver only ever *reads* an original
 * from it, through `readFileNoFollow`, to sanity-check a mapped position and to
 * derive a symbol.
 */
const PROJECT_ROOT = fileURLToPath(new URL('../../test/fixtures/sample-next-app', import.meta.url));

/** The webpack chunk: the only map with `sourcesContent`. */
const WEBPACK_CHUNK = 'webpack-basin-page.js';

/** Its map, named by a directive sharing the chunk's stem. */
const WEBPACK_MAP = 'webpack-basin-page.js.map';

/** The Turbopack chunk whose map is the folder's only sectioned document. */
const SECTIONED_CHUNK = 'turbopack-gauge-route.js';

/** That sectioned map. */
const SECTIONED_MAP = 'turbopack-gauge-route.js.map';

/** The chunk whose directive names a differently hashed map stem. */
const HASHED_CHUNK = 'turbopack-station-widget.js';

/** That map, reachable through the directive and through nothing else. */
const HASHED_MAP = 'turbopack-station-widget-6f3ad91c.js.map';

/** The chunk carrying its whole map inline, in a `data:` URI. */
const INLINE_CHUNK = 'inline-map-basin-detail.js';

/** The chunk with no `sourceMappingURL` directive at all. */
const UNMAPPED_CHUNK = 'unmapped-observatory-runtime.js';

/**
 * A synthetic chunk and map pair, served from memory beside the fixtures.
 *
 * Not a fixture and never written to the fixture folder: the committed corpus
 * has no map with an **absolute** `sources` entry, and an absolute entry
 * outside the project root is the only input that reaches
 * `normalizeSourcePath`'s containment rejection through the real transport.
 * (Pointing `projectRoot` at an unrelated directory does not reach it: the
 * fixtures' sources are bundler-scheme spellings such as
 * `webpack://_N_E/./src/lib/http.ts`, which normalise to the same
 * project-relative path under *any* absolute root, because normalisation is a
 * statement about the string and never a filesystem lookup. That case is
 * asserted separately, against the resolver's documented behaviour, in
 * "the two content branches".) Its second source is an ordinary project source,
 * so one stack can assert that the refused frame is dropped while its
 * neighbour still resolves.
 */
const ESCAPING_CHUNK = 'escaping-source-chunk.js';

/** The map named by {@link ESCAPING_CHUNK}'s directive. */
const ESCAPING_MAP = 'escaping-source.js.map';

/**
 * A second synthetic pair, whose map spells its one source **relatively**.
 *
 * Also not a fixture: every committed map names its sources with a bundler
 * scheme (`webpack://`, `turbopack:///`), and a scheme-less relative entry is
 * both a real producer form and the only form for which the tracer's optional
 * `mapUrl` argument changes anything at all — see "the `mapUrl` argument the
 * resolver does not pass".
 */
const RELATIVE_CHUNK = 'relative-sources-chunk.js';

/** The map named by {@link RELATIVE_CHUNK}'s directive. */
const RELATIVE_MAP = 'relative-sources.js.map';

/** Every fixture artifact the harness serves, read once as bytes. */
const SERVED_FIXTURES: readonly string[] = [
  WEBPACK_CHUNK,
  WEBPACK_MAP,
  SECTIONED_CHUNK,
  SECTIONED_MAP,
  HASHED_CHUNK,
  HASHED_MAP,
  INLINE_CHUNK,
  UNMAPPED_CHUNK,
];

/**
 * The absolute source path {@link ESCAPING_MAP}'s first entry names.
 *
 * Absolute and outside every plausible project root, including an `mkdtemp`
 * directory under the OS temp directory, so the containment check refuses it
 * whatever `projectRoot` a case passes.
 */
const ESCAPING_SOURCE = '/outside-the-project/src/escaped.ts';

/**
 * {@link ESCAPING_MAP}, verbatim.
 *
 * Two mapped generated lines, one segment each and no `names`:
 * `1:0 -> sources[0] 1:0` (the absolute, refusable entry) and
 * `2:0 -> sources[1] 21:0` (`src/lib/http.ts`, a real project source). The
 * `mappings` string is the VLQ encoding of exactly those two segments —
 * `[[0,0,0,0]]` then `[[0,1,20,0]]`, all four fields 0-based — so a frame on
 * generated line 1 must be dropped and a frame on generated line 2 must
 * resolve.
 */
const ESCAPING_MAP_JSON = JSON.stringify({
  version: 3,
  file: ESCAPING_CHUNK,
  sources: [ESCAPING_SOURCE, 'webpack://_N_E/./src/lib/http.ts'],
  names: [],
  mappings: 'AAAA;ACoBA',
});

/**
 * {@link ESCAPING_CHUNK}, verbatim.
 *
 * Three lines: the two the map describes and the directive. The chunk's own
 * text is never mapped against — only its directive is read — so the body is
 * the minimum that makes the two generated lines real.
 */
const ESCAPING_CHUNK_JS = [
  'const escapedModule = 1;',
  'const projectModule = 2;',
  `//# sourceMappingURL=${ESCAPING_MAP}`,
  '',
].join('\n');

/**
 * {@link RELATIVE_MAP}, verbatim.
 *
 * One mapped generated line and one relative source:
 * `1:0 -> sources[0] 21:0`, where `sources[0]` is `src/lib/http.ts` spelled
 * with no scheme and no `sourceRoot`. `mappings` is the VLQ encoding of the
 * single segment `[[0, 0, 20, 0]]`, all four fields 0-based.
 */
const RELATIVE_MAP_JSON = JSON.stringify({
  version: 3,
  file: RELATIVE_CHUNK,
  sources: ['src/lib/http.ts'],
  names: [],
  mappings: 'AAoBA',
});

/** {@link RELATIVE_CHUNK}, verbatim: the one mapped line and the directive. */
const RELATIVE_CHUNK_JS = [
  'const relativeModule = 1;',
  `//# sourceMappingURL=${RELATIVE_MAP}`,
  '',
].join('\n');

// ---------------------------------------------------------------------------
// The expectation tables, transcribed from the fixtures' README
// ---------------------------------------------------------------------------

/**
 * A position in **raw source-map coordinates**: 1-based line, 0-based column.
 *
 * Every `Generated` and `Original` cell of the fixtures' README is one of
 * these, and so is every literal in the tables below. The two conversions to
 * and from the conventions either side of them are named steps, never inline
 * arithmetic — see this file's overview.
 */
interface RawPosition {
  readonly line: number;
  readonly column: number;
}

/** One row of a README expectation table. */
interface MappingCase {
  /** The generated position, raw. */
  readonly generated: RawPosition;

  /** The project-relative POSIX path the source normalises to. */
  readonly file: string;

  /** The original position, raw. */
  readonly original: RawPosition;

  /**
   * The segment's `names` entry, or `undefined` where the README prints `—`.
   *
   * A `—` row means the segment has four fields and carries no name at all, so
   * `originalPositionFor` reports `name: null` and the resolver falls back to
   * the identifier at the resolved column. In this corpus every such position
   * lands on a reserved word (`const`, `export`, `async`, `return`) or on a
   * non-identifier (`<p>`), all of which the resolver refuses to report as a
   * symbol — so `undefined` here means the emitted location omits `symbol`,
   * and that is asserted rather than assumed.
   */
  readonly symbol: string | undefined;
}

/**
 * `webpack-basin-page.js` -> `webpack-basin-page.js.map`, per the README.
 *
 * The `16:6` row of that table is deliberately absent here: it maps into
 * `node_modules/react/cjs/react.development.js` and belongs to the skip paths,
 * where it is asserted by name.
 */
const WEBPACK_CASES: readonly MappingCase[] = [
  {
    generated: { line: 19, column: 6 },
    file: 'src/widgets/GaugeReadout.tsx',
    original: { line: 40, column: 2 },
    symbol: undefined,
  },
  {
    generated: { line: 19, column: 15 },
    file: 'src/widgets/GaugeReadout.tsx',
    original: { line: 40, column: 8 },
    symbol: 'handleReadoutClick',
  },
  {
    generated: { line: 20, column: 8 },
    file: 'src/widgets/GaugeReadout.tsx',
    original: { line: 41, column: 4 },
    symbol: undefined,
  },
  {
    generated: { line: 37, column: 6 },
    file: 'src/lib/http.ts',
    original: { line: 21, column: 0 },
    symbol: undefined,
  },
  {
    generated: { line: 37, column: 21 },
    file: 'src/lib/http.ts',
    original: { line: 21, column: 22 },
    symbol: 'fetchGaugeIndex',
  },
  {
    generated: { line: 44, column: 8 },
    file: 'src/lib/http.ts',
    original: { line: 28, column: 2 },
    symbol: undefined,
  },
];

/**
 * `turbopack-gauge-route.js` -> its sectioned map, per the README, in absolute
 * generated coordinates.
 *
 * All three sections are represented, which is the point: section 0 carries the
 * percent-encoded dynamic segment (`gauges/%5Bid%5D/route.ts`), section 1's
 * second source (`45:8`) proves `AnyMap` flattens rather than mapping one
 * source per section, and section 2 is the `turbopack:///./app/(observatory)/…`
 * spelling that only survives through the *authored* `sources` entry.
 */
const SECTIONED_CASES: readonly MappingCase[] = [
  {
    generated: { line: 13, column: 21 },
    file: 'app/api/gauges/[id]/route.ts',
    original: { line: 65, column: 22 },
    symbol: 'GET',
  },
  {
    generated: { line: 14, column: 8 },
    file: 'app/api/gauges/[id]/route.ts',
    original: { line: 69, column: 2 },
    symbol: undefined,
  },
  {
    generated: { line: 15, column: 8 },
    file: 'app/api/gauges/[id]/route.ts',
    original: { line: 71, column: 2 },
    symbol: undefined,
  },
  {
    generated: { line: 40, column: 21 },
    file: 'src/lib/station-service.ts',
    original: { line: 88, column: 22 },
    symbol: 'summarizeBasin',
  },
  {
    generated: { line: 41, column: 8 },
    file: 'src/lib/station-service.ts',
    original: { line: 90, column: 2 },
    symbol: undefined,
  },
  {
    generated: { line: 45, column: 8 },
    file: 'src/widgets/BasinSummary.tsx',
    original: { line: 61, column: 2 },
    symbol: undefined,
  },
  {
    generated: { line: 59, column: 21 },
    file: 'app/(observatory)/basins/[id]/page.tsx',
    original: { line: 58, column: 30 },
    symbol: 'BasinDetailPage',
  },
  {
    generated: { line: 61, column: 8 },
    file: 'app/(observatory)/basins/[id]/page.tsx',
    original: { line: 62, column: 2 },
    symbol: undefined,
  },
  {
    generated: { line: 66, column: 12 },
    file: 'app/(observatory)/basins/[id]/page.tsx',
    original: { line: 69, column: 6 },
    symbol: undefined,
  },
];

/**
 * `turbopack-station-widget.js` -> `turbopack-station-widget-6f3ad91c.js.map`,
 * per the README.
 *
 * The chunk declares `http.ts` first and `GaugeReadout.tsx` second while the
 * map's `sources` holds them the other way round, so index and declaration
 * sequence disagree on purpose.
 */
const HASHED_CASES: readonly MappingCase[] = [
  {
    generated: { line: 9, column: 6 },
    file: 'src/lib/http.ts',
    original: { line: 21, column: 7 },
    symbol: undefined,
  },
  {
    generated: { line: 9, column: 21 },
    file: 'src/lib/http.ts',
    original: { line: 21, column: 22 },
    symbol: 'fetchGaugeIndex',
  },
  {
    generated: { line: 10, column: 8 },
    file: 'src/lib/http.ts',
    original: { line: 28, column: 2 },
    symbol: undefined,
  },
  {
    generated: { line: 23, column: 8 },
    file: 'src/widgets/GaugeReadout.tsx',
    original: { line: 40, column: 2 },
    symbol: undefined,
  },
  {
    generated: { line: 23, column: 14 },
    file: 'src/widgets/GaugeReadout.tsx',
    original: { line: 40, column: 8 },
    symbol: 'handleReadoutClick',
  },
];

/** `inline-map-basin-detail.js`, whose map travels inside it, per the README. */
const INLINE_CASES: readonly MappingCase[] = [
  {
    generated: { line: 12, column: 21 },
    file: 'app/(observatory)/basins/[id]/page.tsx',
    original: { line: 58, column: 30 },
    symbol: 'BasinDetailPage',
  },
  {
    generated: { line: 13, column: 8 },
    file: 'app/(observatory)/basins/[id]/page.tsx',
    original: { line: 59, column: 2 },
    symbol: undefined,
  },
  {
    generated: { line: 15, column: 8 },
    file: 'app/(observatory)/basins/[id]/page.tsx',
    original: { line: 62, column: 2 },
    symbol: undefined,
  },
];

/**
 * The generated position of the webpack map's dependency row, `16:6`.
 *
 * Its own table row says it maps to `node_modules/react/cjs/react.development.js`
 * line 15, column 0. No `SourceLocation` may ever be produced for it.
 */
const WEBPACK_DEPENDENCY_POSITION: RawPosition = { line: 16, column: 6 };

/** The `sources` entry that row resolves to, and that normalisation refuses. */
const WEBPACK_DEPENDENCY_SOURCE = 'webpack://_N_E/./node_modules/react/cjs/react.development.js';

/**
 * Generated positions the webpack map does not describe.
 *
 * `30:0` is a gap between mapped lines inside the chunk, and `120:0` is past
 * its last line (the chunk is 52 lines). Both make `originalPositionFor` report
 * `source: null`, which is a skip and not an error.
 */
const WEBPACK_UNMAPPED_POSITIONS: readonly RawPosition[] = [
  { line: 30, column: 0 },
  { line: 120, column: 0 },
];

/**
 * The README's source-URL normalisation table, minus the rejected row.
 *
 * Asserted directly against `normalizeSourcePath` so that the `file` values in
 * the tables above are pinned to the documented cross-folder contract — four
 * bundler prefix forms, percent-decoded dynamic segments and route-group
 * folders that must survive — rather than only to whatever the resolver
 * happens to emit.
 */
const NORMALISATION_CASES: readonly (readonly [source: string, file: string])[] = [
  ['webpack://_N_E/./src/widgets/GaugeReadout.tsx', 'src/widgets/GaugeReadout.tsx'],
  ['webpack://_N_E/./src/lib/http.ts', 'src/lib/http.ts'],
  [
    'webpack://_N_E/./app/(observatory)/basins/[id]/page.tsx',
    'app/(observatory)/basins/[id]/page.tsx',
  ],
  ['turbopack:///[project]/app/api/gauges/%5Bid%5D/route.ts', 'app/api/gauges/[id]/route.ts'],
  ['turbopack:///[project]/src/lib/station-service.ts', 'src/lib/station-service.ts'],
  ['turbopack:///_N_E/src/widgets/BasinSummary.tsx', 'src/widgets/BasinSummary.tsx'],
  [
    'turbopack:///./app/(observatory)/basins/%5Bid%5D/page.tsx',
    'app/(observatory)/basins/[id]/page.tsx',
  ],
  ['turbopack:///[project]/src/widgets/GaugeReadout.tsx', 'src/widgets/GaugeReadout.tsx'],
  ['turbopack:///[project]/src/lib/http.ts', 'src/lib/http.ts'],
];

// ---------------------------------------------------------------------------
// The loopback harness
// ---------------------------------------------------------------------------

/** Where the harness pretends a dev server serves its chunks from. */
const CHUNK_PREFIX = '/_next/static/chunks/';

/** The media type a chunk is served with. */
const JS_MEDIA_TYPE = 'application/javascript; charset=utf-8';

/** The media type a map is served with. */
const JSON_MEDIA_TYPE = 'application/json; charset=utf-8';

/** The media type the 404 body is served with. */
const TEXT_MEDIA_TYPE = 'text/plain; charset=utf-8';

/** Every path the harness was asked for, in arrival order. Cleared per case. */
const received: string[] = [];

/** The bytes the harness serves, keyed by artifact name. */
const bodies = new Map<string, Buffer>();

/** Every accepted socket, so teardown cannot block on a live connection. */
const openSockets = new Set<Socket>();

/** The listener, held so `afterAll` can close exactly the one it opened. */
let server: Server | undefined;

/** `http://127.0.0.1:<ephemeral>`: the origin every case pins to. */
let liveOrigin = '';

/** Reads one fixture artifact as bytes. This suite never writes to that tree. */
function fixtureBytes(name: string): Buffer {
  return readFileSync(new URL(name, FIXTURE_DIR));
}

/** Reads one fixture artifact as text. */
function fixtureText(name: string): string {
  return readFileSync(new URL(name, FIXTURE_DIR), 'utf8');
}

/** Sends one complete response with an accurate `Content-Length`. */
function respond(response: ServerResponse, status: number, mediaType: string, body: Buffer): void {
  response.writeHead(status, {
    'content-type': mediaType,
    'content-length': String(body.byteLength),
  });
  response.end(body);
}

beforeAll(async () => {
  for (const name of SERVED_FIXTURES) {
    bodies.set(name, fixtureBytes(name));
  }
  bodies.set(ESCAPING_CHUNK, Buffer.from(ESCAPING_CHUNK_JS, 'utf8'));
  bodies.set(ESCAPING_MAP, Buffer.from(ESCAPING_MAP_JSON, 'utf8'));
  bodies.set(RELATIVE_CHUNK, Buffer.from(RELATIVE_CHUNK_JS, 'utf8'));
  bodies.set(RELATIVE_MAP, Buffer.from(RELATIVE_MAP_JSON, 'utf8'));

  const listener = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? '';
    received.push(path);

    const body = path.startsWith(CHUNK_PREFIX)
      ? bodies.get(path.slice(CHUNK_PREFIX.length))
      : undefined;

    if (body === undefined) {
      // Everything unrouted 404s, including the three `.map` paths the fixture
      // folder deliberately does not contain: a resolver that derived a map
      // name from a chunk name would get this, not a map.
      respond(response, 404, TEXT_MEDIA_TYPE, Buffer.from('not found', 'utf8'));
      return;
    }

    respond(response, 200, path.endsWith('.map') ? JSON_MEDIA_TYPE : JS_MEDIA_TYPE, body);
  });

  listener.on('connection', (socket: Socket) => {
    openSockets.add(socket);
    socket.on('close', () => {
      openSockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    listener.once('error', (error: Error) => {
      reject(error);
    });
    // Loopback and port 0: never a wildcard bind, and never a fixed port a
    // sibling checkout on this host could already own.
    listener.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });

  const address = listener.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the loopback harness did not bind to a TCP port');
  }

  server = listener;
  liveOrigin = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  // Sockets first: `close` waits for connections rather than cutting them, so
  // a keep-alive connection left open would hang the suite instead of ending
  // it.
  for (const socket of openSockets) {
    socket.destroy();
  }
  openSockets.clear();

  const listener = server;
  server = undefined;
  if (listener === undefined) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    listener.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

beforeEach(() => {
  received.length = 0;
});

// ---------------------------------------------------------------------------
// Sandboxes for the cases that need bytes the fixtures do not have
// ---------------------------------------------------------------------------

/**
 * Sandbox roots created by the current case, removed when it ends.
 *
 * `packages/code-analysis/test/fixtures/**` is a read-only input, so a case
 * that needs a missing or a different original copies nothing and plants its
 * own instead. Removing them per case rather than per file is what keeps one
 * case's planted original from answering the next case's read.
 */
const sandboxes: string[] = [];

/**
 * A throwaway project root under the OS temp directory.
 *
 * `realpathSync` because containment is compared against the resolved path: on
 * a platform whose temp directory is itself a symbolic link, an unresolved root
 * would make every source look as though it escaped the project.
 */
function createSandbox(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'debuggen-resolver-')));
  sandboxes.push(root);
  return root;
}

/** Writes `content` to `relative` inside `root`, creating its directories. */
function plant(root: string, relative: string, content: string): void {
  const target = join(root, relative);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

afterEach(() => {
  for (const root of sandboxes.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Frames, options and spies
// ---------------------------------------------------------------------------

/** The URL of `name` on the harness's origin. */
function liveUrl(name: string): string {
  return `${liveOrigin}${CHUNK_PREFIX}${name}`;
}

/** The path the harness records for `name`. */
function livePath(name: string): string {
  return `${CHUNK_PREFIX}${name}`;
}

/**
 * **Conversion in.** The V8 column of a raw generated position.
 *
 * The tables in this file are the README's, so their columns are raw
 * source-map columns: **0-based**. V8 prints a **1-based** column in a stack
 * frame, and `resolver.ts` subtracts that one again in `toNeedleColumn` before
 * it queries the map. This function is the single place the two conventions
 * meet, and the `+ 1` is written here, once and named, rather than inline at
 * each call site — because the mistake it prevents is silent: with a needle one
 * column early, `originalPositionFor`'s greatest-lower-bound search returns the
 * *previous* segment instead of failing.
 */
function toV8Column(rawColumn: number): number {
  return rawColumn + 1;
}

/** A synthetic Chrome frame line for a raw generated position in `chunk`. */
function frameLine(chunk: string, generated: RawPosition, fn?: string): string {
  const location = `${liveUrl(chunk)}:${String(generated.line)}:${String(
    toV8Column(generated.column),
  )}`;
  return fn === undefined ? `    at ${location}` : `    at ${fn} (${location})`;
}

/** The same position as a pre-parsed {@link StackFrame}. */
function stackFrameFor(chunk: string, generated: RawPosition, fn?: string): StackFrame {
  return {
    ...(fn === undefined ? {} : { fn }),
    url: liveUrl(chunk),
    line: generated.line,
    column: toV8Column(generated.column),
  };
}

/**
 * A stack string with a V8 header and the given frame lines.
 *
 * The header is always present so that every case in this file also asserts,
 * implicitly, that `parseStackFrames` drops it.
 */
function stackOf(...frames: readonly string[]): string {
  return ['Error: fixture stack', ...frames].join('\n');
}

/**
 * The options every case starts from: the fixture project and the harness's
 * origin as the mandatory pin, plus a cache of this case's own.
 *
 * A fresh `createSourceMapCache()` per call is deliberate — a cache shared
 * across cases would let one case's parsed document satisfy the next case's
 * "exactly one request" assertion.
 */
function resolveOptions(overrides: Partial<ResolveStackOptions> = {}): ResolveStackOptions {
  return {
    projectRoot: PROJECT_ROOT,
    devServerOrigin: liveOrigin,
    cache: createSourceMapCache(),
    ...overrides,
  };
}

/** A `fetchImpl` that records every URL it is asked for and then delegates. */
interface FetchRecorder {
  /** Pass as {@link ResolveStackOptions.fetchImpl}. */
  readonly impl: typeof fetch;

  /** The URLs requested, in order. */
  readonly urls: string[];

  /** How many times the implementation was called. */
  calls(): number;
}

function recordingFetch(): FetchRecorder {
  const urls: string[] = [];
  const impl = vi.fn(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): ReturnType<typeof fetch> => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return await globalThis.fetch(input, init);
    },
  );

  return {
    impl,
    urls,
    calls: (): number => impl.mock.calls.length,
  };
}

/** A logger that records everything, for the cases that assert on a skip. */
interface RecordedLog {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

interface RecordingLogger {
  readonly logger: Logger;
  readonly records: readonly RecordedLog[];
}

function createRecordingLogger(): RecordingLogger {
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

/** A logger whose every method throws, for the never-throws cases. */
function createThrowingLogger(): Logger {
  const explode = (): never => {
    throw new Error('this logger is hostile');
  };

  const logger: Logger = {
    level: 'trace',
    trace: explode,
    debug: explode,
    info: explode,
    warn: explode,
    error: explode,
    fatal: explode,
    child: () => logger,
  };

  return logger;
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/**
 * **Conversion out.** The `SourceLocation` a README row must produce.
 *
 * `SourceLocation` is 1-based in **both** axes (AAP 0.2.3) while the README's
 * `Original` cells are raw source-map coordinates, so the column gains one and
 * the line does not. `symbol` is *omitted* rather than set to `undefined`,
 * because the resolver spreads it conditionally and every case here asserts
 * with `toStrictEqual`, which tells the two apart.
 */
function expectedSourceLocation(mapping: MappingCase): SourceLocation {
  return {
    file: mapping.file,
    line: mapping.original.line,
    column: mapping.original.column + 1,
    ...(mapping.symbol === undefined ? {} : { symbol: mapping.symbol }),
    resolvedBy: 'source-map',
    confidence: DEFAULT_RESOLUTION_CONFIDENCE['source-map'],
  };
}

/**
 * Asserts the emitted location satisfies the shared contract, whatever its
 * coordinates.
 *
 * Deliberately independent of the tables: `parseSourceLocation` is the gate
 * this value passes through on its way to `source.open` and
 * `showTextDocument`, and `file` being relative POSIX is a security boundary
 * (AAP 0.2.3) rather than a formatting preference — an absolute developer path
 * would leak the machine's layout into a panel and a `..` would be an
 * arbitrary-file-read attempt.
 */
function expectSchemaValid(location: SourceLocation): void {
  expect(isSourceLocation(location)).toBe(true);
  expect(isOk(parseSourceLocation(location))).toBe(true);

  expect(location.resolvedBy).toBe('source-map');
  expect(location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE['source-map']);

  expect(location.file.startsWith('/')).toBe(false);
  expect(location.file.split('/')).not.toContain('..');
  expect(location.file).not.toContain('\\');
  expect(/^[A-Za-z]:/.test(location.file)).toBe(false);

  expect(Number.isInteger(location.line)).toBe(true);
  expect(Number.isInteger(location.column)).toBe(true);
  expect(location.line).toBeGreaterThanOrEqual(1);
  expect(location.column).toBeGreaterThanOrEqual(1);
}

/**
 * The single location a stack was expected to resolve to.
 *
 * `noUncheckedIndexedAccess` types `located[0]` as possibly absent, and a
 * narrowing helper says why the case would fail rather than asserting on
 * `undefined` three lines later.
 */
function onlyLocation(located: readonly SourceLocation[]): SourceLocation {
  expect(located).toHaveLength(1);
  const [first] = located;
  if (first === undefined) {
    throw new Error('expected exactly one resolved location');
  }
  return first;
}

/** The location at `index`, failing the case when the array is shorter. */
function locationAt(located: readonly SourceLocation[], index: number): SourceLocation {
  const found = located[index];
  if (found === undefined) {
    throw new Error(`expected a resolved location at index ${String(index)}`);
  }
  return found;
}

/** Resolves one README row through the whole route and asserts its location. */
async function expectMapping(chunk: string, mapping: MappingCase): Promise<void> {
  const located = await resolveStack(
    stackOf(frameLine(chunk, mapping.generated)),
    resolveOptions(),
  );

  const location = onlyLocation(located);
  expect(location).toStrictEqual(expectedSourceLocation(mapping));
  expectSchemaValid(location);
}

// ---------------------------------------------------------------------------
// The two library facts the resolver branches on
// ---------------------------------------------------------------------------

describe('the sectioned document, and why `AnyMap` is not interchangeable', () => {
  it('throws from the plain `TraceMap` constructor and succeeds through `AnyMap`', () => {
    // The reason `createLoadedMap` branches on `isSectionedSourceMap` — a
    // statement about the document — instead of trying one constructor and
    // catching the failure. The fixtures' README records this behaviour for
    // @jridgewell/trace-mapping 0.3.31, and only *that it throws* is asserted:
    // the message ("Cannot read properties of undefined (reading 'map')",
    // raised inside `sources.map(…)` before the constructor's own `sections`
    // guard can speak) is an implementation detail of the pinned version.
    const document: unknown = JSON.parse(fixtureText(SECTIONED_MAP));

    expect(() => new TraceMap(document as SourceMapInput)).toThrow();
    expect(() => new AnyMap(document as SectionedSourceMapInput)).not.toThrow();
  });

  it('is the only fixture the sectioned branch applies to', () => {
    expect(isSectionedSourceMap(JSON.parse(fixtureText(SECTIONED_MAP)) as SourceMapDocument)).toBe(
      true,
    );

    for (const plain of [WEBPACK_MAP, HASHED_MAP]) {
      expect(isSectionedSourceMap(JSON.parse(fixtureText(plain)) as SourceMapDocument)).toBe(false);
    }
  });

  it('exposes `AnyMap` as the published alias of `FlattenMap`', () => {
    // Stated because the resolver imports the alias: were the two ever to
    // diverge, the sectioned branch would be constructing something else.
    expect(AnyMap).toBe(FlattenMap);
  });
});

describe('the source-URL normalisation contract the `file` values rest on', () => {
  for (const [source, file] of NORMALISATION_CASES) {
    it(`normalises ${source} to ${file}`, () => {
      expect(normalizeSourcePath(source, { projectRoot: PROJECT_ROOT })).toBe(file);
    });
  }

  it('refuses the one dependency source in the corpus', () => {
    // The single deliberate exception in the README's table, and the reason the
    // webpack fixture carries three sources rather than two.
    expect(
      normalizeSourcePath(WEBPACK_DEPENDENCY_SOURCE, { projectRoot: PROJECT_ROOT }),
    ).toBeUndefined();
  });

  it('refuses an absolute source outside the project root', () => {
    expect(normalizeSourcePath(ESCAPING_SOURCE, { projectRoot: PROJECT_ROOT })).toBeUndefined();
  });
});

describe('the `mapUrl` argument the resolver does not pass', () => {
  /** The one document in play whose sources a `mapUrl` would rewrite. */
  function relativeDocument(): SourceMapInput {
    return JSON.parse(RELATIVE_MAP_JSON) as SourceMapInput;
  }

  it('rewrites a relative source into a URL that normalisation refuses', () => {
    // Both tracer constructors take an optional second argument that resolves
    // each `sources` entry against the map's own URL. The resolver passes none,
    // and this is the observable reason: `./normalize.ts` speaks the producers'
    // spellings, and an `http://127.0.0.1:…` URL is not one of them.
    const withoutMapUrl = new TraceMap(relativeDocument());
    const withMapUrl = new TraceMap(relativeDocument(), liveUrl(RELATIVE_MAP));

    expect(withoutMapUrl.resolvedSources).toStrictEqual(['src/lib/http.ts']);
    expect(normalizeSourcePath('src/lib/http.ts', { projectRoot: PROJECT_ROOT })).toBe(
      'src/lib/http.ts',
    );

    expect(withMapUrl.resolvedSources).toStrictEqual([
      `${liveOrigin}${CHUNK_PREFIX}src/lib/http.ts`,
    ]);
    expect(
      withMapUrl.resolvedSources.map((source) =>
        normalizeSourcePath(source, { projectRoot: PROJECT_ROOT }),
      ),
    ).toStrictEqual([undefined]);
  });

  it('leaves a bundler-scheme source untouched, whichever way it is constructed', () => {
    // Which is why the argument alone is not what keeps this route working:
    // every source in the committed corpus carries a scheme, so a `mapUrl`
    // would be a no-op for all of them, and the resolver's habit of trying the
    // *authored* spelling before the resolved one is what actually makes the
    // decision safe for the relative form above.
    const document: unknown = JSON.parse(fixtureText(WEBPACK_MAP));

    expect(new TraceMap(document as SourceMapInput, liveUrl(WEBPACK_MAP)).resolvedSources).toEqual(
      new TraceMap(document as SourceMapInput).resolvedSources,
    );
  });
});

// ---------------------------------------------------------------------------
// Frame parsing
// ---------------------------------------------------------------------------

/** One row of the parsing table: a V8 line and what must come out of it. */
interface ParseCase {
  readonly description: string;
  readonly line: string;
  readonly expected: StackFrame | undefined;
}

const PARSE_CASES: readonly ParseCase[] = [
  {
    description: 'the common `at fn (url:l:c)` form',
    line: '    at handleReadoutClick (http://127.0.0.1:4311/chunks/page.js:19:16)',
    expected: {
      fn: 'handleReadoutClick',
      url: 'http://127.0.0.1:4311/chunks/page.js',
      line: 19,
      column: 16,
    },
  },
  {
    description: 'the bare `at url:l:c` form, with no function slot',
    line: '    at http://127.0.0.1:4311/chunks/page.js:19:16',
    expected: { url: 'http://127.0.0.1:4311/chunks/page.js', line: 19, column: 16 },
  },
  {
    description: 'an `async` decoration, stripped from the slot',
    line: '    at async fetchGaugeIndex (http://127.0.0.1:4311/chunks/page.js:37:22)',
    expected: {
      fn: 'fetchGaugeIndex',
      url: 'http://127.0.0.1:4311/chunks/page.js',
      line: 37,
      column: 22,
    },
  },
  {
    description: 'a `new` decoration, stripped from the slot',
    line: '    at new GaugeReadout (http://127.0.0.1:4311/chunks/page.js:25:7)',
    expected: {
      fn: 'GaugeReadout',
      url: 'http://127.0.0.1:4311/chunks/page.js',
      line: 25,
      column: 7,
    },
  },
  {
    description: 'an `[as alias]` suffix, dropped in favour of the declared name',
    line: '    at Object.handleReadoutClick [as onClick] (http://127.0.0.1:4311/chunks/page.js:19:16)',
    expected: {
      fn: 'Object.handleReadoutClick',
      url: 'http://127.0.0.1:4311/chunks/page.js',
      line: 19,
      column: 16,
    },
  },
  {
    description: 'an anonymous slot, which keeps the position and reports no name',
    line: '    at <anonymous> (http://127.0.0.1:4311/chunks/page.js:19:16)',
    expected: { url: 'http://127.0.0.1:4311/chunks/page.js', line: 19, column: 16 },
  },
  {
    description: 'an `eval at …` frame, from which the innermost position is taken',
    line: '    at eval (eval at handleReadoutClick (http://127.0.0.1:4311/chunks/page.js:19:16), <anonymous>:1:9)',
    expected: {
      fn: 'handleReadoutClick',
      url: 'http://127.0.0.1:4311/chunks/page.js',
      line: 19,
      column: 16,
    },
  },
  {
    description: 'a `<anonymous>` frame with no position at all',
    line: '    at <anonymous>',
    expected: undefined,
  },
  {
    description: 'a `native` frame',
    line: '    at native',
    expected: undefined,
  },
  {
    description: 'a bundler-internal specifier, which no dev-server map describes',
    line: '    at handleReadoutClick (webpack-internal:///./src/widgets/GaugeReadout.tsx:40:8)',
    expected: undefined,
  },
  {
    description: 'a `file:` URL',
    line: '    at loadThing (file:///home/dev/project/src/lib/thing.ts:12:3)',
    expected: undefined,
  },
  {
    description: 'a Node internal frame',
    line: '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
    expected: undefined,
  },
  {
    description: 'a frame reporting line 0, which is not a position V8 emits',
    line: '    at handleReadoutClick (http://127.0.0.1:4311/chunks/page.js:0:16)',
    expected: undefined,
  },
  {
    description: 'a frame reporting column 0',
    line: '    at handleReadoutClick (http://127.0.0.1:4311/chunks/page.js:19:0)',
    expected: undefined,
  },
  {
    description: 'a header line, which is not a frame',
    line: 'Error: something went wrong',
    expected: undefined,
  },
];

describe('parseStackFrames', () => {
  for (const testCase of PARSE_CASES) {
    it(`reads ${testCase.description}`, () => {
      const frames = parseStackFrames(testCase.line);

      if (testCase.expected === undefined) {
        expect(frames).toEqual([]);
        return;
      }

      expect(frames).toHaveLength(1);
      expect(frames[0]).toStrictEqual(testCase.expected);
    });
  }

  it('drops the header of a multi-line stack and keeps the frames in order', () => {
    const frames = parseStackFrames(
      [
        'TypeError: gauge is undefined',
        '    at handleReadoutClick (http://127.0.0.1:4311/chunks/page.js:19:16)',
        '    at async fetchGaugeIndex (http://127.0.0.1:4311/chunks/page.js:37:22)',
        '    at native',
        '    at http://127.0.0.1:4311/chunks/runtime.js:8:3',
      ].join('\n'),
    );

    // Innermost first, as V8 prints them, with the two unusable lines absent —
    // so the returned indices do not correspond to positions in the stack.
    expect(frames).toStrictEqual([
      {
        fn: 'handleReadoutClick',
        url: 'http://127.0.0.1:4311/chunks/page.js',
        line: 19,
        column: 16,
      },
      {
        fn: 'fetchGaugeIndex',
        url: 'http://127.0.0.1:4311/chunks/page.js',
        line: 37,
        column: 22,
      },
      { url: 'http://127.0.0.1:4311/chunks/runtime.js', line: 8, column: 3 },
    ]);
  });

  it('reads a stack with Windows line endings', () => {
    const frames = parseStackFrames(
      [
        'Error: gauge read failed',
        '    at handleReadoutClick (http://127.0.0.1:4311/chunks/page.js:19:16)',
        '    at fetchGaugeIndex (http://127.0.0.1:4311/chunks/page.js:37:22)',
      ].join('\r\n'),
    );

    expect(frames.map((frame) => frame.line)).toStrictEqual([19, 37]);
    expect(frames.map((frame) => frame.fn)).toStrictEqual([
      'handleReadoutClick',
      'fetchGaugeIndex',
    ]);
  });

  it('does not read a port as a line number', () => {
    // The lookahead in the location pattern earns its keep here: a lazy URL
    // would otherwise stop at the scheme's authority and read `:4311` as the
    // line.
    const [frame] = parseStackFrames(
      '    at handleReadoutClick (http://127.0.0.1:4311/chunks/page.js:19:16)',
    );

    expect(frame?.url).toBe('http://127.0.0.1:4311/chunks/page.js');
    expect(frame?.line).toBe(19);
    expect(frame?.column).toBe(16);
  });

  it('returns nothing for an empty string, a header-only stack or garbage', () => {
    expect(parseStackFrames('')).toEqual([]);
    expect(parseStackFrames('Error: gauge read failed')).toEqual([]);
    expect(parseStackFrames('\u0000\uFFFD not a stack at all {} [] ::::')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The coordinate contract, one group per fixture
// ---------------------------------------------------------------------------

describe('resolveStack — the webpack map, whose originals travel with it', () => {
  for (const mapping of WEBPACK_CASES) {
    const at = `${String(mapping.generated.line)}:${String(mapping.generated.column)}`;

    it(`resolves ${at} to ${mapping.file}:${String(mapping.original.line)}`, async () => {
      await expectMapping(WEBPACK_CHUNK, mapping);
    });
  }

  it('resolves every row of its table in one stack, in frame order', async () => {
    // Six distinct positions across two files, so no constant-returning
    // implementation and no implementation that resolved only the first
    // segment of a line can pass this group.
    const located = await resolveStack(
      stackOf(...WEBPACK_CASES.map((mapping) => frameLine(WEBPACK_CHUNK, mapping.generated))),
      resolveOptions(),
    );

    expect(located).toStrictEqual(WEBPACK_CASES.map(expectedSourceLocation));
  });

  it('derives no symbol where the segment carries no name', async () => {
    // Every name-less row of this corpus resolves onto a reserved word, and
    // `symbol: 'const'` on a source chip reads as a resolved name while being
    // nothing of the kind — so the key is absent rather than wrong.
    const located = await resolveStack(
      stackOf(frameLine(WEBPACK_CHUNK, { line: 44, column: 8 })),
      resolveOptions(),
    );

    expect(onlyLocation(located)).not.toHaveProperty('symbol');
  });

  it('reports the original name from the map, never the name in the chunk', async () => {
    // The generated function on that line is `fetchGaugeIndex` too, so the
    // frame's own slot is set to something else entirely: a resolver that used
    // `StackFrame.fn` as a fallback would report the generated name on
    // minified output, and this is the assertion that says it must not.
    const located = await resolveStack(
      stackOf(frameLine(WEBPACK_CHUNK, { line: 37, column: 21 }, 'o.$fetchGaugeIndex$2')),
      resolveOptions(),
    );

    expect(onlyLocation(located).symbol).toBe('fetchGaugeIndex');
  });
});

describe('resolveStack — the sectioned Turbopack map, read from the project', () => {
  for (const mapping of SECTIONED_CASES) {
    const at = `${String(mapping.generated.line)}:${String(mapping.generated.column)}`;

    it(`resolves ${at} to ${mapping.file}:${String(mapping.original.line)}`, async () => {
      // This map carries no `sourcesContent` in any section, so each of these
      // also exercises the read-the-original-from-the-project branch: the
      // position is validated, and a name-less segment's symbol is derived,
      // from the real file under `test/fixtures/sample-next-app`.
      await expectMapping(SECTIONED_CHUNK, mapping);
    });
  }

  it('resolves the percent-encoded dynamic segment of section 0', async () => {
    const located = await resolveStack(
      stackOf(frameLine(SECTIONED_CHUNK, { line: 13, column: 21 })),
      resolveOptions(),
    );

    // `turbopack:///[project]/app/api/gauges/%5Bid%5D/route.ts` — the brackets
    // arrive percent-encoded and must come back literal, because that is the
    // directory on disk.
    expect(onlyLocation(located).file).toBe('app/api/gauges/[id]/route.ts');
  });

  it('resolves a section after the first, so the section offset is applied', async () => {
    // Section 1 begins at generated line 27 (`offset.line` 26, 0-based), so a
    // frame at absolute line 40 is section-local line 14. An implementation
    // that ignored the offsets would resolve this against section 0 or not at
    // all.
    const located = await resolveStack(
      stackOf(frameLine(SECTIONED_CHUNK, { line: 40, column: 21 })),
      resolveOptions(),
    );

    expect(onlyLocation(located)).toStrictEqual(
      expectedSourceLocation({
        generated: { line: 40, column: 21 },
        file: 'src/lib/station-service.ts',
        original: { line: 88, column: 22 },
        symbol: 'summarizeBasin',
      }),
    );
  });

  it('resolves into the second source of a section, so the sources are flattened', async () => {
    // The README calls this row the one that proves flattening: it lands in
    // section 1's *second* declared source, which an implementation assuming
    // one source per section gets wrong while every other row still passes.
    const located = await resolveStack(
      stackOf(frameLine(SECTIONED_CHUNK, { line: 45, column: 8 })),
      resolveOptions(),
    );

    expect(onlyLocation(located).file).toBe('src/widgets/BasinSummary.tsx');
  });

  it('resolves section 2, whose authored `./` spelling the tracer collapses', async () => {
    // `turbopack:///./app/(observatory)/basins/%5Bid%5D/page.tsx` authored;
    // `turbopack:///app/(observatory)/…` after the library's `./` collapsing,
    // in which the first path segment reads as a namespace and normalisation
    // refuses the source. The resolver keeps the authored spelling alongside
    // the tracer's own, and this row is what that is for. The route group
    // `(observatory)` must survive too: it is a real directory.
    const located = await resolveStack(
      stackOf(frameLine(SECTIONED_CHUNK, { line: 59, column: 21 })),
      resolveOptions(),
    );

    const location = onlyLocation(located);
    expect(location.file).toBe('app/(observatory)/basins/[id]/page.tsx');
    expect(location.symbol).toBe('BasinDetailPage');
  });

  it('resolves all three sections in one stack', async () => {
    const located = await resolveStack(
      stackOf(...SECTIONED_CASES.map((mapping) => frameLine(SECTIONED_CHUNK, mapping.generated))),
      resolveOptions(),
    );

    expect(located).toStrictEqual(SECTIONED_CASES.map(expectedSourceLocation));
  });
});

describe('resolveStack — the map named under a different, hashed stem', () => {
  for (const mapping of HASHED_CASES) {
    const at = `${String(mapping.generated.line)}:${String(mapping.generated.column)}`;

    it(`resolves ${at} to ${mapping.file}:${String(mapping.original.line)}`, async () => {
      await expectMapping(HASHED_CHUNK, mapping);
    });
  }

  it('reads the map the directive names and never one derived from the chunk', async () => {
    const recorder = recordingFetch();

    const located = await resolveStack(
      stackOf(frameLine(HASHED_CHUNK, { line: 23, column: 14 })),
      resolveOptions({ fetchImpl: recorder.impl }),
    );

    expect(onlyLocation(located).symbol).toBe('handleReadoutClick');
    // `turbopack-station-widget.js.map` is absent from the fixture folder by
    // design and 404s here, so a name-deriving implementation would resolve
    // nothing at all — and the request list says which name was asked for.
    expect(received).toStrictEqual([livePath(HASHED_CHUNK), livePath(HASHED_MAP)]);
    expect(recorder.urls).toStrictEqual([liveUrl(HASHED_CHUNK), liveUrl(HASHED_MAP)]);
  });
});

describe('resolveStack — the inline map', () => {
  for (const mapping of INLINE_CASES) {
    const at = `${String(mapping.generated.line)}:${String(mapping.generated.column)}`;

    it(`resolves ${at} to ${mapping.file}:${String(mapping.original.line)}`, async () => {
      await expectMapping(INLINE_CHUNK, mapping);
    });
  }

  it('resolves with exactly one HTTP request', async () => {
    const recorder = recordingFetch();

    const located = await resolveStack(
      stackOf(frameLine(INLINE_CHUNK, { line: 12, column: 21 })),
      resolveOptions({ fetchImpl: recorder.impl }),
    );

    const location = onlyLocation(located);
    expect(location.file).toBe('app/(observatory)/basins/[id]/page.tsx');
    expect(location.symbol).toBe('BasinDetailPage');

    // The payload is decoded out of the directive, so there is no second
    // request — and none for `inline-map-basin-detail.js.map`, which the
    // fixture folder deliberately does not contain.
    expect(recorder.calls()).toBe(1);
    expect(received).toStrictEqual([livePath(INLINE_CHUNK)]);
  });
});

describe('resolveStack — a map whose one source is spelled relatively', () => {
  it('resolves it against the project root, with no scheme to strip', async () => {
    const located = await resolveStack(
      stackOf(frameLine(RELATIVE_CHUNK, { line: 1, column: 0 }, 'relativeModule')),
      resolveOptions(),
    );

    // `src/lib/http.ts` line 21, column 0 — the same original the bundler-scheme
    // maps reach by a longer route, and the only `sources` form in this file for
    // which the tracer's `mapUrl` argument would change the answer.
    expect(onlyLocation(located)).toStrictEqual(
      expectedSourceLocation({
        generated: { line: 1, column: 0 },
        file: 'src/lib/http.ts',
        original: { line: 21, column: 0 },
        symbol: undefined,
      }),
    );
    expectSchemaValid(onlyLocation(located));
  });
});

describe('resolveStack — every emitted location satisfies the shared schema', () => {
  it('validates the locations of a stack spanning all four maps', async () => {
    const located = await resolveStack(
      stackOf(
        frameLine(WEBPACK_CHUNK, { line: 19, column: 15 }, 'handleReadoutClick'),
        frameLine(SECTIONED_CHUNK, { line: 59, column: 21 }, 'BasinDetailPage'),
        frameLine(HASHED_CHUNK, { line: 9, column: 21 }, 'fetchGaugeIndex'),
        frameLine(INLINE_CHUNK, { line: 15, column: 8 }),
      ),
      resolveOptions(),
    );

    expect(located).toHaveLength(4);
    for (const location of located) {
      expectSchemaValid(location);
    }

    expect(located.map((location) => location.file)).toStrictEqual([
      'src/widgets/GaugeReadout.tsx',
      'app/(observatory)/basins/[id]/page.tsx',
      'src/lib/http.ts',
      'app/(observatory)/basins/[id]/page.tsx',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Column bases
// ---------------------------------------------------------------------------

describe('column bases, the mistake that fails silently', () => {
  /**
   * The webpack map's line 19 has segments at generated columns 6 and 15, and
   * that gap is the lever: `originalPositionFor` searches for the greatest
   * segment at or before the needle, so an input one column early returns the
   * *previous* segment rather than failing. Three adjacent raw columns
   * therefore have three known answers, and any single-sided base error changes
   * at least one of them.
   */
  const NEIGHBOURS: readonly (readonly [raw: number, expected: MappingCase])[] = [
    [
      14,
      {
        generated: { line: 19, column: 14 },
        file: 'src/widgets/GaugeReadout.tsx',
        original: { line: 40, column: 2 },
        symbol: undefined,
      },
    ],
    [
      15,
      {
        generated: { line: 19, column: 15 },
        file: 'src/widgets/GaugeReadout.tsx',
        original: { line: 40, column: 8 },
        symbol: 'handleReadoutClick',
      },
    ],
    [
      16,
      {
        generated: { line: 19, column: 16 },
        file: 'src/widgets/GaugeReadout.tsx',
        original: { line: 40, column: 8 },
        symbol: 'handleReadoutClick',
      },
    ],
  ];

  for (const [raw, expected] of NEIGHBOURS) {
    it(`answers raw generated column ${String(raw)} with original column ${String(
      expected.original.column + 1,
    )}`, async () => {
      const located = await resolveStack(
        stackOf(frameLine(WEBPACK_CHUNK, { line: 19, column: raw })),
        resolveOptions(),
      );

      expect(onlyLocation(located)).toStrictEqual(expectedSourceLocation(expected));
    });
  }

  it('does not answer the column to the left of a segment with that segment', async () => {
    // Stated as an inequality as well as an equality: the three cases above
    // pin the values, and this one pins the *shape* of the failure a wrong
    // input base produces, which is two adjacent needles collapsing onto one
    // answer.
    const left = await resolveStack(
      stackOf(frameLine(WEBPACK_CHUNK, { line: 19, column: 14 })),
      resolveOptions(),
    );
    const exact = await resolveStack(
      stackOf(frameLine(WEBPACK_CHUNK, { line: 19, column: 15 })),
      resolveOptions(),
    );

    expect(onlyLocation(left).column).not.toBe(onlyLocation(exact).column);
    expect(onlyLocation(left).symbol).toBeUndefined();
    expect(onlyLocation(exact).symbol).toBe('handleReadoutClick');
  });

  it('reports a 1-based column, one greater than the column in the map', async () => {
    // The out conversion, isolated: the map's segment for this position is
    // column 22 and `SourceLocation` is 1-based on both axes, so 23 is the
    // only correct answer and 22 is what dropping the conversion produces.
    const location = onlyLocation(
      await resolveStack(
        stackOf(frameLine(WEBPACK_CHUNK, { line: 37, column: 21 })),
        resolveOptions(),
      ),
    );

    expect(location.line).toBe(21);
    expect(location.column).toBe(23);
  });
});

// ---------------------------------------------------------------------------
// Skip paths: no location, no throw, and the neighbours still resolved
// ---------------------------------------------------------------------------

describe('skip paths', () => {
  it('skips a frame mapping into a dependency and keeps its neighbour', async () => {
    const recording = createRecordingLogger();

    const located = await resolveStack(
      stackOf(
        frameLine(WEBPACK_CHUNK, WEBPACK_DEPENDENCY_POSITION, 'requireModule'),
        frameLine(WEBPACK_CHUNK, { line: 19, column: 15 }, 'handleReadoutClick'),
      ),
      resolveOptions({ logger: recording.logger }),
    );

    // The dependency frame is simply absent: the returned array is shorter
    // than the stack and its indices do not correspond to frame positions.
    expect(located).toStrictEqual([
      expectedSourceLocation({
        generated: { line: 19, column: 15 },
        file: 'src/widgets/GaugeReadout.tsx',
        original: { line: 40, column: 8 },
        symbol: 'handleReadoutClick',
      }),
    ]);

    // Explained once, at `debug`: an unresolvable frame is normal operation,
    // and anything louder would fill a session's log with the design working.
    expect(recording.records.some((record) => record.level === 'debug')).toBe(true);
    expect(recording.records.every((record) => record.level === 'debug')).toBe(true);
  });

  it('skips every frame of a chunk that carries no directive, after one request', async () => {
    const recorder = recordingFetch();

    // Absence is this fixture's whole payload, so it is asserted about the
    // fixture as well as about the resolver.
    expect(fixtureText(UNMAPPED_CHUNK)).not.toContain('sourceMappingURL');

    await expect(
      resolveStack(
        stackOf(
          frameLine(UNMAPPED_CHUNK, { line: 10, column: 2 }),
          frameLine(UNMAPPED_CHUNK, { line: 20, column: 4 }),
        ),
        resolveOptions({ fetchImpl: recorder.impl }),
      ),
    ).resolves.toEqual([]);

    // One request for the chunk, none for a guessed
    // `unmapped-observatory-runtime.js.map`, and none for the second frame:
    // the per-call memo records that the lookup was already attempted.
    expect(recorder.calls()).toBe(1);
    expect(received).toStrictEqual([livePath(UNMAPPED_CHUNK)]);
  });

  for (const position of WEBPACK_UNMAPPED_POSITIONS) {
    it(`skips a frame at unmapped generated position ${String(position.line)}:${String(
      position.column,
    )}`, async () => {
      await expect(
        resolveStack(stackOf(frameLine(WEBPACK_CHUNK, position)), resolveOptions()),
      ).resolves.toEqual([]);
    });
  }

  it('keeps the neighbours of a frame at an unmapped position', async () => {
    const located = await resolveStack(
      stackOf(
        frameLine(WEBPACK_CHUNK, { line: 30, column: 0 }),
        frameLine(WEBPACK_CHUNK, { line: 44, column: 8 }),
      ),
      resolveOptions(),
    );

    expect(located).toStrictEqual([
      expectedSourceLocation({
        generated: { line: 44, column: 8 },
        file: 'src/lib/http.ts',
        original: { line: 28, column: 2 },
        symbol: undefined,
      }),
    ]);
  });

  it('makes no request at all for a chunk URL that is not the pinned origin', async () => {
    const recorder = recordingFetch();

    await expect(
      resolveStack(
        stackOf('    at handler (http://example.com/_next/static/chunks/page.js:19:16)'),
        resolveOptions({ fetchImpl: recorder.impl }),
      ),
    ).resolves.toEqual([]);

    // The refusal is observed as the *absence* of a call rather than as a
    // request that happened to fail, which is the only way to tell a policy
    // from a coincidence.
    expect(recorder.calls()).toBe(0);
    expect(received).toStrictEqual([]);
  });

  it('makes no request for a loopback URL on a port other than the pin', async () => {
    const recorder = recordingFetch();

    // Loopback is not a trust boundary on a developer's machine: a dozen
    // listeners live there, this product's own service among them, and only the
    // exact-origin pin tells the session's dev server apart from the rest.
    await expect(
      resolveStack(
        stackOf('    at handler (http://127.0.0.1:1/_next/static/chunks/page.js:19:16)'),
        resolveOptions({ fetchImpl: recorder.impl }),
      ),
    ).resolves.toEqual([]);

    expect(recorder.calls()).toBe(0);
  });

  it('drops frames whose URL is not http(s) before anything tries to fetch them', async () => {
    const recorder = recordingFetch();

    await expect(
      resolveStack(
        stackOf(
          '    at handleReadoutClick (webpack-internal:///./src/widgets/GaugeReadout.tsx:40:8)',
          '    at <anonymous>',
          '    at native',
          '    at loadThing (file:///home/dev/project/src/lib/thing.ts:12:3)',
        ),
        resolveOptions({ fetchImpl: recorder.impl }),
      ),
    ).resolves.toEqual([]);

    expect(recorder.calls()).toBe(0);
  });

  it('resolves nothing when no dev-server origin is pinned', async () => {
    const recorder = recordingFetch();

    // Omitting the pin is a refusal rather than a relaxation: the field is
    // optional in the type only so a caller with no dev server gets an empty
    // result instead of a type error.
    await expect(
      resolveStack(
        stackOf(frameLine(WEBPACK_CHUNK, { line: 19, column: 15 })),
        resolveOptions({ devServerOrigin: undefined, fetchImpl: recorder.impl }),
      ),
    ).resolves.toEqual([]);

    expect(recorder.calls()).toBe(0);
  });

  it('skips a frame whose original source falls outside the project root', async () => {
    const located = await resolveStack(
      stackOf(
        frameLine(ESCAPING_CHUNK, { line: 1, column: 0 }, 'escapedModule'),
        frameLine(ESCAPING_CHUNK, { line: 2, column: 0 }, 'projectModule'),
      ),
      resolveOptions(),
    );

    // The absolute entry yields nothing — not an absolute path, not a path
    // with a surviving `..`, and not a location at all — while the ordinary
    // project source beside it in the same map still resolves.
    expect(located).toStrictEqual([
      expectedSourceLocation({
        generated: { line: 2, column: 0 },
        file: 'src/lib/http.ts',
        original: { line: 21, column: 0 },
        symbol: undefined,
      }),
    ]);
    expectSchemaValid(onlyLocation(located));
  });

  it('skips it whatever the project root is', async () => {
    // Same map, a throwaway root: an absolute source outside the project is
    // refused by containment, never re-rooted onto whichever project is being
    // indexed.
    const located = await resolveStack(
      stackOf(frameLine(ESCAPING_CHUNK, { line: 1, column: 0 })),
      resolveOptions({ projectRoot: createSandbox() }),
    );

    expect(located).toEqual([]);
  });

  it('resolves nothing for an empty, header-only, unresolvable or garbage stack', async () => {
    const options = resolveOptions();

    await expect(resolveStack('', options)).resolves.toEqual([]);
    await expect(resolveStack('Error: gauge read failed', options)).resolves.toEqual([]);
    await expect(
      resolveStack(stackOf('    at native', '    at <anonymous>'), options),
    ).resolves.toEqual([]);
    await expect(
      resolveStack('\u0000\uFFFD not a stack at all {} [] ::::', options),
    ).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The two content branches
// ---------------------------------------------------------------------------

describe('the two content branches', () => {
  it('reads the original from the map when it travels with it, without touching disk', async () => {
    const readSourceFile = vi.fn((): string | undefined => undefined);

    // The webpack map is the only one carrying `sourcesContent`, and this case
    // points `projectRoot` at an empty sandbox to prove the branch needs
    // nothing from the project: the position is still validated and the
    // location still emitted.
    const located = await resolveStack(
      stackOf(frameLine(WEBPACK_CHUNK, { line: 19, column: 15 })),
      resolveOptions({ projectRoot: createSandbox(), readSourceFile }),
    );

    expect(onlyLocation(located)).toStrictEqual(
      expectedSourceLocation({
        generated: { line: 19, column: 15 },
        file: 'src/widgets/GaugeReadout.tsx',
        original: { line: 40, column: 8 },
        symbol: 'handleReadoutClick',
      }),
    );
    expect(readSourceFile).not.toHaveBeenCalled();
  });

  it('reads the original from the project when the map does not carry it', async () => {
    const seen: string[] = [];
    const readSourceFile = vi.fn((absPath: string): string | undefined => {
      seen.push(absPath);
      return Array.from({ length: 30 }, () => 'const stationReadingLine = 1;').join('\n');
    });

    const located = await resolveStack(
      stackOf(frameLine(HASHED_CHUNK, { line: 9, column: 21 })),
      resolveOptions({ readSourceFile }),
    );

    expect(onlyLocation(located).file).toBe('src/lib/http.ts');
    // Called only with an absolute path the containment check has vouched for,
    // which is the contract of that seam.
    expect(seen).toStrictEqual([join(PROJECT_ROOT, 'src/lib/http.ts')]);
  });

  it('derives a symbol from the project file when the segment carries no name', async () => {
    const root = createSandbox();
    // The hashed map's `10:8` row maps to `src/lib/http.ts` line 28, column 2
    // and carries no `names` index, so the symbol can only come from the text
    // at that column. Planted rather than copied: the committed original has a
    // reserved word there, which the resolver correctly refuses to report.
    plant(root, 'src/lib/http.ts', `${'\n'.repeat(27)}  gaugeReadingCursor();\n`);

    const located = await resolveStack(
      stackOf(frameLine(HASHED_CHUNK, { line: 10, column: 8 })),
      resolveOptions({ projectRoot: root }),
    );

    expect(onlyLocation(located)).toStrictEqual(
      expectedSourceLocation({
        generated: { line: 10, column: 8 },
        file: 'src/lib/http.ts',
        original: { line: 28, column: 2 },
        symbol: 'gaugeReadingCursor',
      }),
    );
  });

  it('skips a position the original no longer has, rather than clamping it', async () => {
    const root = createSandbox();
    // A map built before an edit still resolves, and it resolves into a file
    // that has since changed. An editor asked to open line 21 of a two-line
    // file silently lands somewhere arbitrary, which is worse than no link.
    plant(root, 'src/lib/http.ts', 'export const nothingIsMappedHere = 1;\n');

    await expect(
      resolveStack(
        stackOf(frameLine(HASHED_CHUNK, { line: 9, column: 21 })),
        resolveOptions({ projectRoot: root }),
      ),
    ).resolves.toEqual([]);
  });

  it('trusts the map when neither branch can supply the original', async () => {
    const recording = createRecordingLogger();
    // No `sourcesContent` on this map and nothing on disk under the sandbox
    // root, so the position cannot be sanity-checked. The resolver's documented
    // behaviour is to emit it anyway — a location the map reports is better
    // than none — and to record the fact rather than hide it.
    const located = await resolveStack(
      stackOf(frameLine(HASHED_CHUNK, { line: 9, column: 21 })),
      resolveOptions({ projectRoot: createSandbox(), logger: recording.logger }),
    );

    const location = onlyLocation(located);
    expect(location).toStrictEqual(
      expectedSourceLocation({
        generated: { line: 9, column: 21 },
        file: 'src/lib/http.ts',
        original: { line: 21, column: 22 },
        symbol: 'fetchGaugeIndex',
      }),
    );
    // Still project-relative POSIX: a missing original never turns the path
    // into the absolute one that was looked for.
    expectSchemaValid(location);
    expect(recording.records.some((record) => record.message.includes('trusting the map'))).toBe(
      true,
    );
  });

  it('omits the symbol when there is no name and no content to derive one from', async () => {
    const located = await resolveStack(
      stackOf(frameLine(HASHED_CHUNK, { line: 10, column: 8 })),
      resolveOptions({ projectRoot: createSandbox() }),
    );

    expect(onlyLocation(located)).not.toHaveProperty('symbol');
  });
});

// ---------------------------------------------------------------------------
// Lookups, bounds, ordering and cancellation
// ---------------------------------------------------------------------------

describe('map lookups and the bounds on them', () => {
  it('looks a chunk map up exactly once however many frames point into it', async () => {
    const recorder = recordingFetch();

    const located = await resolveStack(
      stackOf(
        frameLine(WEBPACK_CHUNK, { line: 19, column: 15 }),
        frameLine(WEBPACK_CHUNK, { line: 37, column: 21 }),
        frameLine(WEBPACK_CHUNK, { line: 44, column: 8 }),
      ),
      resolveOptions({ fetchImpl: recorder.impl }),
    );

    expect(located).toHaveLength(3);
    // Two requests for three frames: the chunk, then the map its directive
    // names. A per-call memo sits in front of the lookup, so the cache option
    // is not what makes this hold.
    expect(received).toStrictEqual([livePath(WEBPACK_CHUNK), livePath(WEBPACK_MAP)]);
    expect(recorder.calls()).toBe(2);
  });

  it('looks one map up per distinct chunk for a stack spanning two', async () => {
    const recorder = recordingFetch();

    const located = await resolveStack(
      stackOf(
        frameLine(WEBPACK_CHUNK, { line: 19, column: 15 }),
        frameLine(HASHED_CHUNK, { line: 9, column: 21 }),
        frameLine(WEBPACK_CHUNK, { line: 44, column: 8 }),
      ),
      resolveOptions({ fetchImpl: recorder.impl }),
    );

    expect(located).toHaveLength(3);
    // The third frame returns to the first chunk and costs nothing: the memo's
    // *presence* is what means "already attempted", so alternating frames
    // cannot re-request either map.
    expect(received).toStrictEqual([
      livePath(WEBPACK_CHUNK),
      livePath(WEBPACK_MAP),
      livePath(HASHED_CHUNK),
      livePath(HASHED_MAP),
    ]);
    expect(recorder.calls()).toBe(4);
  });

  it('serves a second call from an injected cache', async () => {
    const cache: SourceMapCache = createSourceMapCache();
    const stack = stackOf(frameLine(WEBPACK_CHUNK, { line: 19, column: 15 }));

    const first = await resolveStack(stack, resolveOptions({ cache }));
    const second = await resolveStack(stack, resolveOptions({ cache }));

    expect(second).toStrictEqual(first);
    // The chunk is fetched both times — only the chunk can say where its map
    // is — while the map itself is parsed once and then served from the cache.
    expect(received).toStrictEqual([
      livePath(WEBPACK_CHUNK),
      livePath(WEBPACK_MAP),
      livePath(WEBPACK_CHUNK),
    ]);
    expect(cache.size).toBe(1);
  });

  it('considers only `maxFrames` frames, taken from the top of the stack', async () => {
    const recorder = recordingFetch();

    const located = await resolveStack(
      stackOf(
        frameLine(WEBPACK_CHUNK, { line: 19, column: 15 }),
        frameLine(HASHED_CHUNK, { line: 9, column: 21 }),
      ),
      resolveOptions({ maxFrames: 1, fetchImpl: recorder.impl }),
    );

    // Innermost first, because that is what a developer means by "where did
    // this come from".
    expect(located).toStrictEqual([
      expectedSourceLocation({
        generated: { line: 19, column: 15 },
        file: 'src/widgets/GaugeReadout.tsx',
        original: { line: 40, column: 8 },
        symbol: 'handleReadoutClick',
      }),
    ]);
    expect(received).toStrictEqual([livePath(WEBPACK_CHUNK), livePath(WEBPACK_MAP)]);
  });

  it('looks up only `maxMaps` distinct maps and still returns what that map covers', async () => {
    const recorder = recordingFetch();

    const located = await resolveStack(
      stackOf(
        frameLine(WEBPACK_CHUNK, { line: 19, column: 15 }),
        frameLine(WEBPACK_CHUNK, { line: 37, column: 21 }),
        frameLine(HASHED_CHUNK, { line: 9, column: 21 }),
      ),
      resolveOptions({ maxMaps: 1, fetchImpl: recorder.impl }),
    );

    // The budget is charged per lookup, so the two frames of the loaded chunk
    // both resolve while the third is skipped without a request.
    expect(located.map((location) => location.file)).toStrictEqual([
      'src/widgets/GaugeReadout.tsx',
      'src/lib/http.ts',
    ]);
    expect(received).toStrictEqual([livePath(WEBPACK_CHUNK), livePath(WEBPACK_MAP)]);
    expect(recorder.calls()).toBe(2);
  });

  it('falls back to its defaults for a cap that is not a positive safe integer', async () => {
    // A caller who asked for `0`, `-1` or `NaN` frames has a bug, and silently
    // resolving nothing would hide it.
    for (const invalid of [0, -1, Number.NaN, 1.5]) {
      const located = await resolveStack(
        stackOf(frameLine(WEBPACK_CHUNK, { line: 19, column: 15 })),
        resolveOptions({ maxFrames: invalid, maxMaps: invalid }),
      );

      expect(located).toHaveLength(1);
    }
  });

  it('declares bounds that are positive integers and wide enough to be bounds', () => {
    // Relationships rather than literals: these two are responsiveness bounds
    // and may be retuned, but a cap below the stacks this route actually sees
    // would turn a bound into a truncation.
    expect(Number.isSafeInteger(DEFAULT_MAX_FRAMES)).toBe(true);
    expect(Number.isSafeInteger(DEFAULT_MAX_MAPS)).toBe(true);
    expect(DEFAULT_MAX_FRAMES).toBeGreaterThan(DEFAULT_MAX_MAPS);
    expect(DEFAULT_MAX_MAPS).toBeGreaterThanOrEqual(SERVED_FIXTURES.length / 2);
  });
});

describe('ordering and identity of the result', () => {
  it('returns the locations in frame order', async () => {
    const located = await resolveStack(
      stackOf(
        frameLine(HASHED_CHUNK, { line: 9, column: 21 }),
        frameLine(WEBPACK_CHUNK, { line: 19, column: 15 }),
        frameLine(SECTIONED_CHUNK, { line: 13, column: 21 }),
      ),
      resolveOptions(),
    );

    expect(located.map((location) => location.file)).toStrictEqual([
      'src/lib/http.ts',
      'src/widgets/GaugeReadout.tsx',
      'app/api/gauges/[id]/route.ts',
    ]);
  });

  it('does not deduplicate two frames that resolve to the same location', async () => {
    const located = await resolveStack(
      stackOf(
        frameLine(WEBPACK_CHUNK, { line: 19, column: 15 }, 'handleReadoutClick'),
        frameLine(WEBPACK_CHUNK, { line: 19, column: 15 }, 'onReadout'),
      ),
      resolveOptions(),
    );

    // The caller wants the chain, and two frames in one function — a callback
    // and its enclosing call, a loop body — are two rungs of it.
    const expected = expectedSourceLocation({
      generated: { line: 19, column: 15 },
      file: 'src/widgets/GaugeReadout.tsx',
      original: { line: 40, column: 8 },
      symbol: 'handleReadoutClick',
    });

    expect(located).toStrictEqual([expected, expected]);
    expect(locationAt(located, 0)).not.toBe(locationAt(located, 1));
  });
});

describe('cancellation', () => {
  it('resolves nothing, and fetches nothing, for an already-aborted signal', async () => {
    const recorder = recordingFetch();

    await expect(
      resolveStack(
        stackOf(frameLine(WEBPACK_CHUNK, { line: 19, column: 15 })),
        resolveOptions({ signal: AbortSignal.abort(), fetchImpl: recorder.impl }),
      ),
    ).resolves.toEqual([]);

    expect(recorder.calls()).toBe(0);
  });

  it('returns what it had already resolved when the caller aborts mid-stack', async () => {
    const controller = new AbortController();
    const recorder = recordingFetch();

    // The signal is checked between frames, so a session that ends during a
    // resolution keeps the rungs already resolved instead of discarding them —
    // and never raises.
    const fetchSourceMapImpl: typeof fetchSourceMap = async (chunkUrl, options) => {
      const lookup = await fetchSourceMap(chunkUrl, options);
      controller.abort();
      return lookup;
    };

    const located = await resolveStack(
      stackOf(
        frameLine(WEBPACK_CHUNK, { line: 19, column: 15 }),
        frameLine(HASHED_CHUNK, { line: 9, column: 21 }),
      ),
      resolveOptions({
        signal: controller.signal,
        fetchImpl: recorder.impl,
        fetchSourceMapImpl,
      }),
    );

    expect(located.map((location) => location.file)).toStrictEqual([
      'src/widgets/GaugeReadout.tsx',
    ]);
    expect(received).toStrictEqual([livePath(WEBPACK_CHUNK), livePath(WEBPACK_MAP)]);
  });
});

// ---------------------------------------------------------------------------
// resolveStackFrame, and the promise that nothing here throws
// ---------------------------------------------------------------------------

describe('resolveStackFrame', () => {
  it('resolves one pre-parsed frame to the same location the stack form gives', async () => {
    const generated: RawPosition = { line: 13, column: 21 };

    const fromFrame = await resolveStackFrame(
      stackFrameFor(SECTIONED_CHUNK, generated, 'GET'),
      resolveOptions(),
    );
    const fromStack = await resolveStack(
      stackOf(frameLine(SECTIONED_CHUNK, generated, 'GET')),
      resolveOptions(),
    );

    expect(fromFrame).toStrictEqual(
      expectedSourceLocation({
        generated,
        file: 'app/api/gauges/[id]/route.ts',
        original: { line: 65, column: 22 },
        symbol: 'GET',
      }),
    );
    expect(fromFrame).toStrictEqual(onlyLocation(fromStack));
  });

  it('re-screens a frame a caller built, whatever its type claims', async () => {
    const options = resolveOptions();

    const unusable: readonly unknown[] = [
      // A 0-based column, built by mistake.
      { url: liveUrl(WEBPACK_CHUNK), line: 19, column: 0 },
      // A 0-based line.
      { url: liveUrl(WEBPACK_CHUNK), line: 0, column: 16 },
      // Not a number at all, as it would arrive from JSON.
      { url: liveUrl(WEBPACK_CHUNK), line: '19', column: '16' },
      // A specifier no dev-server map describes.
      { url: 'webpack-internal:///./src/widgets/GaugeReadout.tsx', line: 40, column: 9 },
      // Not an object.
      'at handleReadoutClick (http://127.0.0.1:1/page.js:19:16)',
      null,
      undefined,
    ];

    for (const candidate of unusable) {
      await expect(resolveStackFrame(candidate as StackFrame, options)).resolves.toBeUndefined();
    }
  });

  it('returns undefined rather than throwing for a frame it cannot map', async () => {
    await expect(
      resolveStackFrame(stackFrameFor(UNMAPPED_CHUNK, { line: 10, column: 2 }), resolveOptions()),
    ).resolves.toBeUndefined();
  });
});

describe('the promise that neither entry point throws', () => {
  it('survives an options bag whose properties throw when read', async () => {
    const hostile = {
      get projectRoot(): string {
        throw new Error('this options bag is hostile');
      },
    } as unknown as ResolveStackOptions;

    await expect(
      resolveStack(stackOf(frameLine(WEBPACK_CHUNK, { line: 19, column: 15 })), hostile),
    ).resolves.toEqual([]);
    await expect(
      resolveStackFrame(stackFrameFor(WEBPACK_CHUNK, { line: 19, column: 15 }), hostile),
    ).resolves.toBeUndefined();
  });

  it('survives a stack that is neither a string nor an array of frames', async () => {
    const options = resolveOptions();

    for (const candidate of [42, null, undefined, { frames: [] }]) {
      await expect(resolveStack(candidate as unknown as string, options)).resolves.toEqual([]);
    }
  });

  it('survives a map lookup that rejects', async () => {
    const fetchSourceMapImpl: typeof fetchSourceMap = () => {
      throw new Error('the dev server went away');
    };

    await expect(
      resolveStack(
        stackOf(frameLine(WEBPACK_CHUNK, { line: 19, column: 15 })),
        resolveOptions({ fetchSourceMapImpl }),
      ),
    ).resolves.toEqual([]);
  });

  it('survives a source reader that throws', async () => {
    const readSourceFile = (): string | undefined => {
      throw new Error('this reader is hostile');
    };

    // The hashed map carries no `sourcesContent`, so the reader is the only
    // route to the original: a throw from it means "no content", which leaves
    // the map as the authority rather than failing the frame.
    const located = await resolveStack(
      stackOf(frameLine(HASHED_CHUNK, { line: 9, column: 21 })),
      resolveOptions({ readSourceFile }),
    );

    expect(onlyLocation(located).file).toBe('src/lib/http.ts');
  });

  it('survives a logger whose every method throws, keeping what it had resolved', async () => {
    // A resolution that needs no log resolves; the frame after it is a skip,
    // which is where this module logs, so the hostile logger throws there. The
    // contract is that the throw is contained and the chain already resolved is
    // still returned — a caller's logger is not allowed to break
    // click-to-source, and it is not allowed to undo it either.
    const located = await resolveStack(
      stackOf(
        frameLine(WEBPACK_CHUNK, { line: 19, column: 15 }, 'handleReadoutClick'),
        frameLine(WEBPACK_CHUNK, WEBPACK_DEPENDENCY_POSITION, 'requireModule'),
      ),
      resolveOptions({ logger: createThrowingLogger() }),
    );

    expect(located.map((location) => location.file)).toStrictEqual([
      'src/widgets/GaugeReadout.tsx',
    ]);
  });

  it('survives a logger whose every method throws on a stack that resolves nothing', async () => {
    const options = resolveOptions({ logger: createThrowingLogger() });

    await expect(
      resolveStack(stackOf(frameLine(UNMAPPED_CHUNK, { line: 10, column: 2 })), options),
    ).resolves.toEqual([]);
    await expect(
      resolveStackFrame(
        stackFrameFor(WEBPACK_CHUNK, WEBPACK_DEPENDENCY_POSITION),
        resolveOptions({ logger: createThrowingLogger() }),
      ),
    ).resolves.toBeUndefined();
  });

  it('survives a map document that cannot be decoded', async () => {
    // A document that satisfies the shape check and still cannot be decoded —
    // `mappings` that is not valid VLQ — yields no location and no throw.
    const undecodable: SourceMapDocument = {
      version: 3,
      file: WEBPACK_CHUNK,
      sources: ['webpack://_N_E/./src/lib/http.ts'],
      names: [],
      mappings: '!!!not-vlq!!!',
    };

    const fetchSourceMapImpl: typeof fetchSourceMap = (chunkUrl) =>
      Promise.resolve(
        ok<SourceMapLookup>({
          kind: 'found',
          map: undecodable,
          mapUrl: `${chunkUrl}.map`,
          inline: false,
        }),
      );

    await expect(
      resolveStack(
        stackOf(frameLine(WEBPACK_CHUNK, { line: 19, column: 15 })),
        resolveOptions({ fetchSourceMapImpl }),
      ),
    ).resolves.toEqual([]);
  });
});
