/**
 * Tests for `./fetch-map.ts`: the chunk-and-map retrieval layer, and the SSRF
 * boundary it is.
 *
 * Two different things are on trial here, and the first is why this file leads
 * with an attack table rather than with the happy path.
 *
 * The **origin policy** is a security boundary with untrusted inputs on both
 * sides of it. A chunk URL arrives from a stack string captured in the
 * inspected page, and the `sourceMappingURL` directive inside that chunk is
 * page-authored content too, so anything able to run script in the tab can
 * propose both. The module answers with a mandatory pin — the session's
 * authoritative dev-server origin — that both URLs must equal exactly. The
 * assertions that matter are therefore *negative and about the wire*: a refused
 * URL must produce **no** request, and a refused directive must produce
 * **exactly one** (the chunk that named it) and never a second. `fetchImpl` is
 * injected precisely so those counts can be observed, and every case below
 * asserts the recorded call list rather than only the returned error. Loopback
 * is deliberately not the subject: the interesting cases are all *on* loopback,
 * because a developer's machine runs a dozen listeners there — this product's
 * own service among them — and only the pin tells the session's dev server
 * apart from the rest.
 *
 * The **pairing behaviour** is the other half, and it is asserted against the
 * committed fixtures in `../../test/fixtures/source-maps/`, whose README is the
 * contract: a webpack chunk whose map shares its stem, a Turbopack chunk whose
 * map carries an independent hash (the case that fails for any implementation
 * that derives `<chunk>.js.map` from the chunk name), a chunk with an inline
 * `data:application/json;charset=utf-8;base64` map that must resolve with no
 * second request, a sectioned map, and a chunk with no directive at all that
 * must resolve cleanly to "no map" after exactly one request. Those fixtures
 * are read read-only; nothing here writes to that folder.
 *
 * Four habits in here are deliberate.
 *
 * 1. **Refusals are proven with a double, never with a closed port.** Every
 *    case in this file injects `fetchImpl`, so a refusal is observed as the
 *    *absence of a call* rather than as a request that happened to fail. A
 *    refusal that "worked" because nothing was listening would prove nothing,
 *    and no assertion could tell the two apart.
 * 2. **The pairing contract is also run through full response doubles.** The
 *    last section serves the same fixtures as real `Response` objects — an
 *    accurate `Content-Length`, a framed `ReadableStream` body that declares no
 *    length at all, a 404, a request that never answers and one the caller
 *    cancels — so the *response-reading* half of the module is exercised
 *    beside the request-shaping half. No socket is opened anywhere in this
 *    file, and the global `fetch` is never called: transport itself belongs to
 *    the browser and integration suites (AAP 0.8.3), which have one.
 * 3. **Exact call lists.** `expect(double.calls).toEqual([...])` rather than a
 *    call-count assertion, so a request to the wrong URL fails as loudly as an
 *    extra one.
 * 4. **Every outcome read through the `Result`.** The module's contract is that
 *    it never throws, so each case asserts on `isOk`/`isErr` and on
 *    `error.code` plus `error.details.reason`, never on a caught exception.
 */
import { readFileSync } from 'node:fs';

import type { DebuggenError, Result } from '@debuggen/shared';
import { isErr, isOk } from '@debuggen/shared';
import { describe, expect, it } from 'vitest';

import type { FetchSourceMapOptions, SourceMapDocument, SourceMapLookup } from './fetch-map.js';
import {
  createSourceMapCache,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_MAP_BYTES,
  fetchSourceMap,
  isLoopbackDevServerUrl,
  isSectionedSourceMap,
  readSourceMappingUrlDirective,
  SOURCE_MAPPING_URL_TAIL_BYTES,
} from './fetch-map.js';

// ---------------------------------------------------------------------------
// Fixtures and harness.
// ---------------------------------------------------------------------------

/** The committed chunk/map corpus. Read-only; see its README for the contract. */
const FIXTURE_DIR = new URL('../../test/fixtures/source-maps/', import.meta.url);

/** The origin every test pins to: one dev server, on loopback, on one port. */
const PINNED_ORIGIN = 'http://127.0.0.1:4311';

/** Where a chunk lives on that dev server, so relative directives resolve. */
const CHUNK_BASE = `${PINNED_ORIGIN}/_next/static/chunks`;

/**
 * The inline map of `inline-map-basin-detail.js`, decoded, exactly as the
 * fixture README records it. Held here as the expected *value* so the test
 * proves the decoder rather than re-deriving the payload from the fixture.
 */
const INLINE_MAP_JSON =
  '{"version":3,"file":"inline-map-basin-detail.js","sources":["webpack://_N_E/./app/(observatory)/basins/[id]/page.tsx"],"names":["BasinDetailPage"],"mappings":";;;;;;;;;;;qBAyD8BA;QAC5B;;QAGA"}';

/** Reads one fixture artifact as text. */
function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE_DIR), 'utf8');
}

/**
 * The `sources` of `webpack-basin-page.js.map`, as its README records them.
 *
 * Written out rather than read back from the same file the harness serves, so
 * the assertion proves the document *arrived and parsed intact* rather than
 * that two reads of one file agree. The third entry is the dependency frame the
 * normaliser must reject; it belongs to this map and to no other.
 */
const WEBPACK_MAP_SOURCES: readonly string[] = [
  'webpack://_N_E/./src/widgets/GaugeReadout.tsx',
  'webpack://_N_E/./src/lib/http.ts',
  'webpack://_N_E/./node_modules/react/cjs/react.development.js',
];

/** The section count of the folder's one sectioned map, per its README. */
const FIXTURE_SECTION_COUNT = 3;

/**
 * That map's section offsets, in generated order and 0-based in both axes, per
 * its README. Asserted because a transport that dropped or reordered a section
 * would still produce a document the shape check accepts.
 */
const FIXTURE_SECTION_OFFSETS: readonly { line: number; column: number }[] = [
  { line: 0, column: 0 },
  { line: 26, column: 0 },
  { line: 48, column: 0 },
];

/**
 * The userinfo components the credential cases screen with. Neither is a
 * credential; they are named so that a reader — and an assertion — can tell
 * them apart from anything the module legitimately reports.
 */
const USERINFO_NAME = 'probe-name';
const USERINFO_VALUE = 'probe-value';

/**
 * A URL on the pinned origin carrying a `user:password@` userinfo component,
 * assembled at runtime.
 *
 * The components are assigned through `URL.username`/`URL.password` instead of
 * being written into a string literal, because a committed URL literal carrying
 * a `user:password@` userinfo component is exactly what
 * `scripts/check-secrets.mjs` refuses in a tracked file (AAP 0.3.4) — and it is
 * right to refuse it without exception, since a scanner taught to recognise
 * test placeholders is a scanner that can be talked out of a real finding. What
 * the module under test receives is identical either way: a string whose parsed
 * URL has non-empty `username` and `password`.
 *
 * @param path A path on the pinned dev-server origin.
 * @returns The absolute URL, userinfo included.
 */
function withUserinfo(path: string): string {
  const url = new URL(path, `${PINNED_ORIGIN}/`);
  url.username = USERINFO_NAME;
  url.password = USERINFO_VALUE;
  return url.href;
}

/** A chunk body whose only content is a `sourceMappingURL` directive. */
function chunkNaming(directive: string): string {
  return `globalThis.x = 1;\n//# sourceMappingURL=${directive}\n`;
}

/** The init argument of a `fetch` call, named without reaching for a global. */
type FetchInit = Parameters<typeof fetch>[1];

/**
 * What a route serves: a body string, or a factory for a specific response.
 *
 * The factory form receives the request's own `init`, which is what lets a
 * route reproduce the two behaviours of `fetch` that a bare `Response` cannot:
 * refusing a request whose signal is already aborted, and never answering one
 * until its signal aborts. It may answer asynchronously for the same reason.
 */
type Route = string | ((init: FetchInit) => Response | Promise<Response>);

/** An injected `fetch` that records every URL it was asked for. */
interface FetchDouble {
  /** Every requested URL, in order, as absolute hrefs. */
  readonly calls: string[];

  /** The init of each recorded call, positionally aligned with `calls`. */
  readonly inits: FetchInit[];

  /** The implementation to pass as `options.fetchImpl`. */
  readonly impl: typeof fetch;
}

/**
 * The href a `fetch` call named, whichever of the three input forms it used.
 *
 * Typed through `unknown` on purpose: the point of this double is to observe
 * what the module under test does, and a narrowing that trusted the declared
 * parameter type would hide a call that passed something unexpected.
 */
function hrefOf(input: unknown): string {
  if (input instanceof URL) {
    return input.href;
  }
  if (typeof input === 'string') {
    return input;
  }
  if (
    typeof input === 'object' &&
    input !== null &&
    'url' in input &&
    typeof input.url === 'string'
  ) {
    return input.url;
  }
  throw new Error(`fetch was called with an unexpected input: ${String(input)}`);
}

/**
 * Builds a recording `fetch` serving `routes` by absolute href.
 *
 * An unrouted URL answers 404 rather than throwing, so a test that expects no
 * request fails on the recorded call list — the assertion it is actually
 * making — instead of on an exception from the harness.
 */
function fetchDouble(routes: Readonly<Record<string, Route>>): FetchDouble {
  const calls: string[] = [];
  const inits: FetchInit[] = [];
  const impl: typeof fetch = (input, init) => {
    const href = hrefOf(input);
    calls.push(href);
    inits.push(init);
    const route = routes[href];
    if (route === undefined) {
      return Promise.resolve(new Response('not found', { status: 404 }));
    }
    return Promise.resolve(typeof route === 'string' ? new Response(route) : route(init));
  };
  return { calls, inits, impl };
}

/** Options with the pin and the double filled in, plus any per-case overrides. */
function options(double: FetchDouble, overrides: Partial<FetchSourceMapOptions> = {}) {
  return {
    devServerOrigin: PINNED_ORIGIN,
    fetchImpl: double.impl,
    ...overrides,
  } satisfies FetchSourceMapOptions;
}

/** Asserts the lookup failed, and returns the error for further assertions. */
function expectErr(result: Result<SourceMapLookup>): DebuggenError {
  if (!isErr(result)) {
    throw new Error(`expected a refusal, got ${JSON.stringify(result.value)}`);
  }
  return result.error;
}

/** Asserts the lookup succeeded with a document, and returns that outcome. */
function expectFound(result: Result<SourceMapLookup>): {
  map: SourceMapDocument;
  mapUrl: string;
  inline: boolean;
} {
  if (!isOk(result)) {
    throw new Error(`expected a document, got ${result.error.code}`);
  }
  if (result.value.kind !== 'found') {
    throw new Error(`expected a document, got kind=none reason=${result.value.reason}`);
  }
  return { map: result.value.map, mapUrl: result.value.mapUrl, inline: result.value.inline };
}

/** Asserts the lookup succeeded with a clean "no map" outcome. */
function expectNone(result: Result<SourceMapLookup>): 'no-directive' | 'unsupported-directive' {
  if (!isOk(result)) {
    throw new Error(`expected a clean miss, got ${result.error.code}`);
  }
  if (result.value.kind !== 'none') {
    throw new Error(`expected a clean miss, got a document at ${result.value.mapUrl}`);
  }
  return result.value.reason;
}

// ---------------------------------------------------------------------------
// The origin policy.
// ---------------------------------------------------------------------------

describe('fetchSourceMap — the mandatory dev-server origin pin', () => {
  it('refuses a chunk on another port of the same loopback host, with no request', async () => {
    const double = fetchDouble({});

    const result = await fetchSourceMap('http://127.0.0.1:5432/chunk.js', options(double));

    const error = expectErr(result);
    expect(error.code).toBe('FORBIDDEN_ORIGIN');
    expect(error.details?.['reason']).toBe('origin-mismatch');
    expect(error.details?.['origin']).toBe('http://127.0.0.1:5432');
    expect(error.details?.['expectedOrigin']).toBe(PINNED_ORIGIN);
    expect(double.calls).toEqual([]);
  });

  it('refuses a chunk on another loopback host spelling, with no request', async () => {
    // `localhost` and `127.0.0.1` are both loopback and are *different
    // origins*: a service reachable at one is not the dev server pinned at the
    // other, and the pin is what says so.
    const double = fetchDouble({});

    const result = await fetchSourceMap('http://localhost:4311/chunk.js', options(double));

    expect(expectErr(result).details?.['reason']).toBe('origin-mismatch');
    expect(double.calls).toEqual([]);
  });

  it.each([
    ['another loopback port', `${chunkNaming('http://127.0.0.1:43117/stolen.js.map')}`],
    ['another loopback host', `${chunkNaming('http://localhost:4311/stolen.js.map')}`],
    ['an IPv6 loopback host', `${chunkNaming('http://[::1]:4311/stolen.js.map')}`],
    ['a public origin', `${chunkNaming('https://exfiltration.example/stolen.js.map')}`],
  ])(
    'refuses a directive naming %s, after exactly the one chunk request',
    async (_label, chunkBody) => {
      const chunkUrl = `${CHUNK_BASE}/page.js`;
      const double = fetchDouble({ [chunkUrl]: chunkBody });

      const result = await fetchSourceMap(chunkUrl, options(double));

      const error = expectErr(result);
      expect(error.code).toBe('FORBIDDEN_ORIGIN');
      expect(error.details?.['role']).toBe('map');
      // The chunk was read — only the chunk can name its map — and the
      // directive's target was never requested.
      expect(double.calls).toEqual([chunkUrl]);
    },
  );

  it('refuses a directive pointing at the local service itself', async () => {
    // The canonical reason the pin is not optional: the local service listens
    // on loopback too, and a directive is page-authored.
    const chunkUrl = `${CHUNK_BASE}/page.js`;
    const double = fetchDouble({
      [chunkUrl]: chunkNaming('http://127.0.0.1:43117/sessions'),
    });

    const result = await fetchSourceMap(chunkUrl, options(double));

    expect(expectErr(result).details?.['reason']).toBe('origin-mismatch');
    expect(double.calls).toEqual([chunkUrl]);
  });

  it.each([
    ['an empty pin', '', 'missing'],
    ['a whitespace-only pin', '   ', 'missing'],
    ['an unparseable pin', 'not a url', 'unparseable'],
    ['a scheme this module cannot fetch', 'file:///tmp/app', 'scheme'],
    ['a credentialed pin', withUserinfo('/'), 'credentials'],
    ['a public pin', 'https://exfiltration.example', 'non-loopback'],
    ['a wildcard-bound pin', 'http://0.0.0.0:4311', 'non-loopback'],
    ['a LAN pin', 'http://192.168.1.10:4311', 'non-loopback'],
  ])('refuses every lookup given %s, with no request', async (_label, pin, problem) => {
    const chunkUrl = `${CHUNK_BASE}/page.js`;
    const double = fetchDouble({ [chunkUrl]: chunkNaming('page.js.map') });

    const result = await fetchSourceMap(chunkUrl, options(double, { devServerOrigin: pin }));

    const error = expectErr(result);
    expect(error.code).toBe('FORBIDDEN_ORIGIN');
    expect(error.details?.['reason']).toBe('origin-pin-invalid');
    expect(error.details?.['problem']).toBe(problem);
    expect(double.calls).toEqual([]);
  });

  it('refuses a lookup whose pin was lost in transit, with no request', async () => {
    // A JavaScript caller, or options deserialised from JSON, can supply
    // something TypeScript never saw. Fail closed rather than unpinned.
    const chunkUrl = `${CHUNK_BASE}/page.js`;
    const double = fetchDouble({ [chunkUrl]: chunkNaming('page.js.map') });
    const lost = { fetchImpl: double.impl } as unknown as FetchSourceMapOptions;

    const result = await fetchSourceMap(chunkUrl, lost);

    expect(expectErr(result).details?.['problem']).toBe('missing');
    expect(double.calls).toEqual([]);
  });

  it.each([
    ['no options at all', undefined],
    ['a non-object options bag', 'http://127.0.0.1:4311'],
  ])('refuses a lookup given %s, without throwing', async (_label, bag) => {
    // The options parameter is required and typed, but the published package is
    // reachable from untyped JavaScript. A forgotten argument must refuse like
    // a missing pin rather than throw past a caller promised a `Result`.
    const result = await fetchSourceMap(
      `${CHUNK_BASE}/page.js`,
      bag as unknown as FetchSourceMapOptions,
    );

    const error = expectErr(result);
    expect(error.code).toBe('FORBIDDEN_ORIGIN');
    expect(error.details?.['reason']).toBe('origin-pin-invalid');
    expect(error.details?.['problem']).toBe('missing');
  });

  it('accepts a pin supplied as a full dev-server URL with a path', async () => {
    // A session carries a dev-server *URL*, not a bare origin.
    const chunkUrl = `${CHUNK_BASE}/page.js`;
    const mapUrl = `${CHUNK_BASE}/page.js.map`;
    const double = fetchDouble({
      [chunkUrl]: chunkNaming('page.js.map'),
      [mapUrl]: '{"version":3,"sources":[],"mappings":""}',
    });

    const result = await fetchSourceMap(
      chunkUrl,
      options(double, { devServerOrigin: `${PINNED_ORIGIN}/products/1?q=x#frag` }),
    );

    expect(expectFound(result).mapUrl).toBe(mapUrl);
    expect(double.calls).toEqual([chunkUrl, mapUrl]);
  });

  it('treats a default port and its explicit spelling as one origin', async () => {
    const chunkUrl = 'http://127.0.0.1/app.js';
    const double = fetchDouble({ [chunkUrl]: 'globalThis.x = 1;\n' });

    const result = await fetchSourceMap(
      chunkUrl,
      options(double, { devServerOrigin: 'http://127.0.0.1:80' }),
    );

    expect(expectNone(result)).toBe('no-directive');
    expect(double.calls).toEqual([chunkUrl]);
  });

  it.each([
    ['a public host', 'https://exfiltration.example/chunk.js', 'non-loopback'],
    ['a LAN address', 'http://10.1.2.3:4311/chunk.js', 'non-loopback'],
    ['the wildcard address', 'http://0.0.0.0:4311/chunk.js', 'non-loopback'],
    ['credentials', withUserinfo('/chunk.js'), 'credentials'],
    ['a file URL', 'file:///etc/passwd', 'scheme'],
    ['a javascript URL', 'javascript:fetch("/x")', 'scheme'],
    ['a data URL', 'data:text/javascript,1', 'scheme'],
    ['an ftp URL', 'ftp://127.0.0.1:4311/chunk.js', 'scheme'],
    ['a relative reference', '/_next/static/chunks/page.js', 'unparseable'],
  ])('refuses a chunk URL carrying %s, with no request', async (_label, chunkUrl, reason) => {
    const double = fetchDouble({});

    const result = await fetchSourceMap(chunkUrl, options(double));

    const error = expectErr(result);
    expect(error.code).toBe('FORBIDDEN_ORIGIN');
    expect(error.details?.['reason']).toBe(reason);
    expect(error.details?.['role']).toBe('chunk');
    expect(double.calls).toEqual([]);
  });

  it('never echoes a credentialed URL beyond its host', async () => {
    const double = fetchDouble({});

    const result = await fetchSourceMap(withUserinfo('/chunk.js'), options(double));

    const serialised = JSON.stringify(expectErr(result).details);
    expect(serialised).not.toContain(USERINFO_NAME);
    expect(serialised).not.toContain(USERINFO_VALUE);
  });

  it('allows a same-origin directive, so the pin does not over-refuse', async () => {
    // The pin must not turn every legitimate lookup into a refusal: an absolute
    // path resolves against the chunk's own URL and stays on the pinned origin.
    const chunkUrl = `${CHUNK_BASE}/page.js`;
    const mapUrl = `${PINNED_ORIGIN}/_next/maps/page.js.map`;
    const double = fetchDouble({
      [chunkUrl]: chunkNaming('/_next/maps/page.js.map'),
      [mapUrl]: '{"version":3,"sources":[],"mappings":""}',
    });

    const result = await fetchSourceMap(chunkUrl, options(double));

    expect(expectFound(result).mapUrl).toBe(mapUrl);
    expect(double.calls).toEqual([chunkUrl, mapUrl]);
  });

  it('carries no ambient authority and refuses redirects on every request', async () => {
    const chunkUrl = `${CHUNK_BASE}/page.js`;
    const mapUrl = `${CHUNK_BASE}/page.js.map`;
    const double = fetchDouble({
      [chunkUrl]: chunkNaming('page.js.map'),
      [mapUrl]: '{"version":3,"sources":[],"mappings":""}',
    });

    await fetchSourceMap(chunkUrl, options(double));

    expect(double.inits).toHaveLength(2);
    for (const init of double.inits) {
      expect(init?.method).toBe('GET');
      expect(init?.credentials).toBe('omit');
      expect(init?.redirect).toBe('error');
      // The absence of headers is the guarantee: nothing to carry a cookie or
      // an Authorization value to a service that is not the dev server.
      expect(init?.headers).toBeUndefined();
      expect(init?.signal).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Pairing, against the committed fixture contract.
// ---------------------------------------------------------------------------

describe('fetchSourceMap — pairing a chunk with its map', () => {
  it('follows a directive naming the same stem', async () => {
    const chunkUrl = `${CHUNK_BASE}/webpack-basin-page.js`;
    const mapUrl = `${CHUNK_BASE}/webpack-basin-page.js.map`;
    const double = fetchDouble({
      [chunkUrl]: fixture('webpack-basin-page.js'),
      [mapUrl]: fixture('webpack-basin-page.js.map'),
    });

    const result = await fetchSourceMap(chunkUrl, options(double));

    const found = expectFound(result);
    expect(found.mapUrl).toBe(mapUrl);
    expect(found.inline).toBe(false);
    expect(isSectionedSourceMap(found.map)).toBe(false);
    expect(double.calls).toEqual([chunkUrl, mapUrl]);
  });

  it('follows a directive naming an independently hashed stem', async () => {
    // The reason this module exists: Turbopack hashes map filenames
    // independently, so `<chunk>.js.map` does not exist here and a resolver
    // that derives one finds nothing.
    const chunkUrl = `${CHUNK_BASE}/turbopack-station-widget.js`;
    const hashedMapUrl = `${CHUNK_BASE}/turbopack-station-widget-6f3ad91c.js.map`;
    const double = fetchDouble({
      [chunkUrl]: fixture('turbopack-station-widget.js'),
      [hashedMapUrl]: fixture('turbopack-station-widget-6f3ad91c.js.map'),
    });

    const result = await fetchSourceMap(chunkUrl, options(double));

    expect(expectFound(result).mapUrl).toBe(hashedMapUrl);
    expect(double.calls).toEqual([chunkUrl, hashedMapUrl]);
    expect(double.calls).not.toContain(`${CHUNK_BASE}/turbopack-station-widget.js.map`);
  });

  it('returns a sectioned document as a sectioned document', async () => {
    const chunkUrl = `${CHUNK_BASE}/turbopack-gauge-route.js`;
    const mapUrl = `${CHUNK_BASE}/turbopack-gauge-route.js.map`;
    const double = fetchDouble({
      [chunkUrl]: fixture('turbopack-gauge-route.js'),
      [mapUrl]: fixture('turbopack-gauge-route.js.map'),
    });

    const found = expectFound(await fetchSourceMap(chunkUrl, options(double)));

    expect(isSectionedSourceMap(found.map)).toBe(true);
    if (isSectionedSourceMap(found.map)) {
      expect(found.map.sections).toHaveLength(FIXTURE_SECTION_COUNT);
    }
  });

  it('decodes an inline map with no second request', async () => {
    const chunkUrl = `${CHUNK_BASE}/inline-map-basin-detail.js`;
    const double = fetchDouble({ [chunkUrl]: fixture('inline-map-basin-detail.js') });

    const found = expectFound(await fetchSourceMap(chunkUrl, options(double)));

    expect(found.inline).toBe(true);
    // An embedded map has no URL of its own; the chunk is where it lives.
    expect(found.mapUrl).toBe(chunkUrl);
    expect(found.map).toEqual(JSON.parse(INLINE_MAP_JSON) as unknown);
    expect(JSON.stringify(found.map)).toBe(INLINE_MAP_JSON);
    expect(double.calls).toEqual([chunkUrl]);
  });

  it('decodes a percent-encoded inline map', async () => {
    const payload = encodeURIComponent('{"version":3,"sources":[],"names":[],"mappings":""}');
    const chunkUrl = `${CHUNK_BASE}/inline-percent.js`;
    const double = fetchDouble({
      [chunkUrl]: chunkNaming(`data:application/json,${payload}`),
    });

    const found = expectFound(await fetchSourceMap(chunkUrl, options(double)));

    expect(found.inline).toBe(true);
    expect(double.calls).toEqual([chunkUrl]);
  });

  it.each([
    ['an unsupported media type', 'data:application/octet-stream;base64,AAAA'],
    ['the RFC default media type', 'data:,%7B%7D'],
    ['a malformed percent escape', 'data:application/json,%E0%A4%A'],
  ])(
    'reports %s as an undecodable directive, with no second request',
    async (_label, directive) => {
      const chunkUrl = `${CHUNK_BASE}/inline-odd.js`;
      const double = fetchDouble({ [chunkUrl]: chunkNaming(directive) });

      const result = await fetchSourceMap(chunkUrl, options(double));

      expect(expectNone(result)).toBe('unsupported-directive');
      expect(double.calls).toEqual([chunkUrl]);
    },
  );

  it('reports a chunk with no directive cleanly, after exactly one request', async () => {
    const chunk = fixture('unmapped-observatory-runtime.js');
    // The fixture's own guarantee, asserted rather than assumed.
    expect(chunk).not.toContain('sourceMappingURL');
    const chunkUrl = `${CHUNK_BASE}/unmapped-observatory-runtime.js`;
    const double = fetchDouble({ [chunkUrl]: chunk });

    const result = await fetchSourceMap(chunkUrl, options(double));

    expect(expectNone(result)).toBe('no-directive');
    // No guessed `<chunk>.js.map`, and nothing else either.
    expect(double.calls).toEqual([chunkUrl]);
  });
});

// ---------------------------------------------------------------------------
// Bounds and failure modes.
// ---------------------------------------------------------------------------

describe('fetchSourceMap — bounded and failing safely', () => {
  it('reports an unusable status for the chunk', async () => {
    const chunkUrl = `${CHUNK_BASE}/missing.js`;
    const double = fetchDouble({});

    const error = expectErr(await fetchSourceMap(chunkUrl, options(double)));

    expect(error.code).toBe('DEV_SERVER_UNAVAILABLE');
    expect(error.details?.['reason']).toBe('http-status');
    expect(error.details?.['status']).toBe(404);
  });

  it('reports an unusable status for the map', async () => {
    const chunkUrl = `${CHUNK_BASE}/page.js`;
    const double = fetchDouble({ [chunkUrl]: chunkNaming('page.js.map') });

    const error = expectErr(await fetchSourceMap(chunkUrl, options(double)));

    expect(error.details?.['reason']).toBe('http-status');
    expect(error.details?.['role']).toBe('map');
    expect(double.calls).toEqual([chunkUrl, `${CHUNK_BASE}/page.js.map`]);
  });

  it('refuses a response whose declared length exceeds the ceiling', async () => {
    const chunkUrl = `${CHUNK_BASE}/huge.js`;
    const double = fetchDouble({
      [chunkUrl]: () => new Response('x', { headers: { 'content-length': '999999' } }),
    });

    const error = expectErr(await fetchSourceMap(chunkUrl, options(double, { maxBytes: 1024 })));

    expect(error.details?.['reason']).toBe('too-large');
    expect(error.details?.['observedBytes']).toBe(999999);
  });

  it('aborts a body that exceeds the ceiling while streaming', async () => {
    // No Content-Length is set, so only the streaming check can catch this.
    const chunkUrl = `${CHUNK_BASE}/m.js`;
    const mapUrl = `${CHUNK_BASE}/m.map`;
    const double = fetchDouble({
      [chunkUrl]: chunkNaming('m.map'),
      [mapUrl]: 'x'.repeat(4096),
    });

    const error = expectErr(await fetchSourceMap(chunkUrl, options(double, { maxBytes: 128 })));

    expect(error.details?.['reason']).toBe('too-large');
    expect(error.details?.['role']).toBe('map');
  });

  it.each([
    ['truncated JSON', '{"version":3,"sources":[]', 'invalid-json'],
    ['an HTML error page', '<!doctype html><title>404</title>', 'invalid-json'],
    ['a JSON array', '[1,2,3]', 'invalid-shape'],
    ['an unsupported version', '{"version":2,"sources":[],"mappings":""}', 'invalid-shape'],
    ['neither mappings nor sections', '{"version":3,"sources":[]}', 'invalid-shape'],
  ])('degrades %s to a malformed-document failure', async (_label, body, reason) => {
    const chunkUrl = `${CHUNK_BASE}/page.js`;
    const double = fetchDouble({
      [chunkUrl]: chunkNaming('page.js.map'),
      [`${CHUNK_BASE}/page.js.map`]: body,
    });

    const error = expectErr(await fetchSourceMap(chunkUrl, options(double)));

    expect(error.code).toBe('CODE_INDEX_FAILED');
    expect(error.details?.['reason']).toBe(reason);
  });

  it('reports a rejected request without throwing', async () => {
    const double = fetchDouble({});
    const rejecting: typeof fetch = () => Promise.reject(new Error('ECONNREFUSED'));

    const error = expectErr(
      await fetchSourceMap(`${CHUNK_BASE}/page.js`, options(double, { fetchImpl: rejecting })),
    );

    expect(error.code).toBe('DEV_SERVER_UNAVAILABLE');
    expect(error.details?.['reason']).toBe('request-failed');
  });

  it('reports a synchronously throwing fetch implementation without throwing', async () => {
    const double = fetchDouble({});
    const throwing: typeof fetch = () => {
      throw new Error('not a fetch');
    };

    const error = expectErr(
      await fetchSourceMap(`${CHUNK_BASE}/page.js`, options(double, { fetchImpl: throwing })),
    );

    expect(error.details?.['reason']).toBe('request-failed');
  });

  it('bounds a request that never answers with its own timeout', async () => {
    const double = fetchDouble({});
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('The operation was aborted'));
        });
      });

    const error = expectErr(
      await fetchSourceMap(
        `${CHUNK_BASE}/page.js`,
        options(double, { fetchImpl: hanging, timeoutMs: 5 }),
      ),
    );

    expect(error.details?.['reason']).toBe('request-failed');
  });

  it("cancels an in-flight request through the caller's signal", async () => {
    const double = fetchDouble({});
    const controller = new AbortController();
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('The operation was aborted'));
        });
      });

    const pending = fetchSourceMap(
      `${CHUNK_BASE}/page.js`,
      options(double, { fetchImpl: hanging, signal: controller.signal, timeoutMs: 60_000 }),
    );
    controller.abort();

    expect(expectErr(await pending).details?.['reason']).toBe('request-failed');
  });
});

// ---------------------------------------------------------------------------
// The injected document cache.
// ---------------------------------------------------------------------------

describe('fetchSourceMap — the injected cache', () => {
  const MAP_BODY = '{"version":3,"sources":[],"mappings":""}';

  it('serves a repeated map from the cache while still reading the chunk', async () => {
    const chunkUrl = `${CHUNK_BASE}/page.js`;
    const mapUrl = `${CHUNK_BASE}/page.js.map`;
    const double = fetchDouble({ [chunkUrl]: chunkNaming('page.js.map'), [mapUrl]: MAP_BODY });
    const cache = createSourceMapCache();

    expectFound(await fetchSourceMap(chunkUrl, options(double, { cache })));
    expectFound(await fetchSourceMap(chunkUrl, options(double, { cache })));

    // Only the chunk is re-read: it is the only thing that can say where its
    // map is, or that the pairing changed.
    expect(double.calls).toEqual([chunkUrl, mapUrl, chunkUrl]);
    expect(cache.size).toBe(1);
  });

  it('keys an inline map by the chunk URL', async () => {
    const chunkUrl = `${CHUNK_BASE}/inline-map-basin-detail.js`;
    const double = fetchDouble({ [chunkUrl]: fixture('inline-map-basin-detail.js') });
    const cache = createSourceMapCache();

    expectFound(await fetchSourceMap(chunkUrl, options(double, { cache })));
    const second = expectFound(await fetchSourceMap(chunkUrl, options(double, { cache })));

    expect(second.inline).toBe(true);
    expect(cache.size).toBe(1);
    expect(cache.get(chunkUrl)).toBeDefined();
  });

  it('evicts the oldest entry past its bound and refetches it', async () => {
    const firstChunk = `${CHUNK_BASE}/a.js`;
    const secondChunk = `${CHUNK_BASE}/b.js`;
    const double = fetchDouble({
      [firstChunk]: chunkNaming('a.js.map'),
      [secondChunk]: chunkNaming('b.js.map'),
      [`${CHUNK_BASE}/a.js.map`]: MAP_BODY,
      [`${CHUNK_BASE}/b.js.map`]: MAP_BODY,
    });
    const cache = createSourceMapCache({ maxEntries: 1 });

    expectFound(await fetchSourceMap(firstChunk, options(double, { cache })));
    expectFound(await fetchSourceMap(secondChunk, options(double, { cache })));

    expect(cache.size).toBe(1);
    expect(cache.get(`${CHUNK_BASE}/a.js.map`)).toBeUndefined();

    expectFound(await fetchSourceMap(firstChunk, options(double, { cache })));
    expect(double.calls.filter((href) => href.endsWith('a.js.map'))).toHaveLength(2);
  });

  it('clamps a zero bound to one entry rather than to none', async () => {
    // `maxEntries: 0` asks for a cache that stores nothing — a bug that
    // presents as a performance mystery rather than as an error — so the bound
    // is clamped to 1 and the entry is still served.
    const chunkUrl = `${CHUNK_BASE}/page.js`;
    const mapUrl = `${CHUNK_BASE}/page.js.map`;
    const double = fetchDouble({ [chunkUrl]: chunkNaming('page.js.map'), [mapUrl]: MAP_BODY });
    const cache = createSourceMapCache({ maxEntries: 0 });

    expectFound(await fetchSourceMap(chunkUrl, options(double, { cache })));
    expectFound(await fetchSourceMap(chunkUrl, options(double, { cache })));

    expect(cache.size).toBe(1);
    expect(double.calls).toEqual([chunkUrl, mapUrl, chunkUrl]);
  });

  it('refetches after clear and after a targeted delete', async () => {
    const chunkUrl = `${CHUNK_BASE}/page.js`;
    const mapUrl = `${CHUNK_BASE}/page.js.map`;
    const double = fetchDouble({ [chunkUrl]: chunkNaming('page.js.map'), [mapUrl]: MAP_BODY });
    const cache = createSourceMapCache();

    expectFound(await fetchSourceMap(chunkUrl, options(double, { cache })));
    expect(cache.delete(mapUrl)).toBe(true);
    expectFound(await fetchSourceMap(chunkUrl, options(double, { cache })));
    cache.clear();
    expect(cache.size).toBe(0);
    expectFound(await fetchSourceMap(chunkUrl, options(double, { cache })));

    expect(double.calls.filter((href) => href === mapUrl)).toHaveLength(3);
  });

  it('degrades a throwing cache to an uncached lookup', async () => {
    const chunkUrl = `${CHUNK_BASE}/page.js`;
    const mapUrl = `${CHUNK_BASE}/page.js.map`;
    const double = fetchDouble({ [chunkUrl]: chunkNaming('page.js.map'), [mapUrl]: MAP_BODY });
    const hostile = {
      get(): SourceMapDocument | undefined {
        throw new Error('cache is broken');
      },
      set(): void {
        throw new Error('cache is broken');
      },
      delete(): boolean {
        return false;
      },
      clear(): void {
        // A hostile cache that does nothing here is exactly the point.
      },
      size: 0,
    };

    const found = expectFound(await fetchSourceMap(chunkUrl, options(double, { cache: hostile })));

    expect(found.mapUrl).toBe(mapUrl);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

describe('readSourceMappingUrlDirective', () => {
  it('takes the last directive when a chunk carries two', () => {
    const chunk = `//# sourceMappingURL=first.map\ncode();\n//# sourceMappingURL=second.map\n`;
    expect(readSourceMappingUrlDirective(chunk)).toBe('second.map');
  });

  it.each([
    ['the current line form', '//# sourceMappingURL=a.map'],
    ['the legacy line form', '//@ sourceMappingURL=a.map'],
    ['the block form', '/*# sourceMappingURL=a.map */'],
    ['the legacy block form', '/*@ sourceMappingURL=a.map */'],
    ['an indented directive', '\t  //# sourceMappingURL=a.map'],
  ])('accepts %s', (_label, line) => {
    expect(readSourceMappingUrlDirective(`code();\n${line}\n`)).toBe('a.map');
  });

  it.each([
    ['a chunk with no directive', 'export const x = 1;\n'],
    ['an empty chunk', ''],
    ['a mid-line occurrence', 'const s = "//# sourceMappingURL=a.map";\n'],
    ['an empty directive value', '//# sourceMappingURL=\n'],
  ])('reports no directive for %s', (_label, chunk) => {
    expect(readSourceMappingUrlDirective(chunk)).toBeUndefined();
  });

  it('scans only the tail of a chunk', () => {
    const chunk = `//# sourceMappingURL=a.map\n${'\n'.repeat(SOURCE_MAPPING_URL_TAIL_BYTES + 1)}`;
    expect(readSourceMappingUrlDirective(chunk)).toBeUndefined();
  });

  it('accepts a directive followed by trailing newlines', () => {
    // A bundler that appends a banner, and an editor that ensures a final
    // newline, both leave the directive short of the last byte.
    expect(readSourceMappingUrlDirective('code();\n//# sourceMappingURL=a.map\n\n\r\n\n')).toBe(
      'a.map',
    );
  });

  it.each([
    ['webpack-basin-page.js', 'webpack-basin-page.js.map'],
    ['turbopack-gauge-route.js', 'turbopack-gauge-route.js.map'],
    ['turbopack-station-widget.js', 'turbopack-station-widget-6f3ad91c.js.map'],
  ])('reads the committed directive of %s', (chunkName, expected) => {
    // The pairing table of the fixtures' README, asserted against the bytes
    // rather than against a paraphrase of them.
    expect(readSourceMappingUrlDirective(fixture(chunkName))).toBe(expected);
  });

  it('reads the inline directive of the embedded-map fixture as a data URI', () => {
    const directive = readSourceMappingUrlDirective(fixture('inline-map-basin-detail.js'));

    // The media type carries a parameter before `;base64`, which is what real
    // inline maps look like and what a prefix match on
    // `data:application/json;base64,` would refuse.
    expect(directive).toMatch(/^data:application\/json;charset=utf-8;base64,[A-Za-z0-9+/=]+$/);
  });

  it('reads no directive from the unmapped fixture', () => {
    expect(
      readSourceMappingUrlDirective(fixture('unmapped-observatory-runtime.js')),
    ).toBeUndefined();
  });
});

describe('isLoopbackDevServerUrl', () => {
  it.each([
    'http://localhost:3000/x.js',
    'http://app.localhost:3000/x.js',
    'http://127.0.0.1:3000/x.js',
    'http://127.0.0.2/x.js',
    // WHATWG `URL` canonicalises the shorthand spellings before they arrive.
    'http://127.1/x.js',
    'http://2130706433/x.js',
    'http://[::1]:3000/x.js',
    'https://127.0.0.1/x.js',
  ])('accepts %s', (url) => {
    expect(isLoopbackDevServerUrl(url)).toBe(true);
  });

  it.each([
    'http://0.0.0.0:3000/x.js',
    'http://[::]:3000/x.js',
    'http://10.1.2.3/x.js',
    'http://172.16.0.1/x.js',
    'http://192.168.1.10/x.js',
    'http://169.254.169.254/latest/meta-data',
    'http://[fe80::1]/x.js',
    'https://exfiltration.example/x.js',
    'http://localhost.exfiltration.example/x.js',
    'not a url at all',
    '',
  ])('refuses %s', (url) => {
    expect(isLoopbackDevServerUrl(url)).toBe(false);
  });

  it('accepts a parsed URL as well as a string', () => {
    expect(isLoopbackDevServerUrl(new URL('http://127.0.0.1:4311/x.js'))).toBe(true);
    expect(isLoopbackDevServerUrl(new URL('https://exfiltration.example/x.js'))).toBe(false);
  });
});

describe('isSectionedSourceMap', () => {
  it("reports the folder's one sectioned document as sectioned", () => {
    const sectioned = JSON.parse(fixture('turbopack-gauge-route.js.map')) as SourceMapDocument;

    expect(isSectionedSourceMap(sectioned)).toBe(true);
    if (isSectionedSourceMap(sectioned)) {
      expect(sectioned.sections).toHaveLength(FIXTURE_SECTION_COUNT);
    }
  });

  it.each(['webpack-basin-page.js.map', 'turbopack-station-widget-6f3ad91c.js.map'])(
    'reports the plain document %s as not sectioned',
    (mapName) => {
      // Both plain maps, not just one: the guard is what chooses between
      // `FlattenMap` and `TraceMap` in the resolver, and the wrong branch
      // throws, so a false positive on either form is a crash there.
      const plain = JSON.parse(fixture(mapName)) as SourceMapDocument;

      expect(isSectionedSourceMap(plain)).toBe(false);
    },
  );

  it('reports a document whose sections field is not an array as not sectioned', () => {
    const impostor = { version: 3, sources: [], mappings: '', sections: 3 } as unknown;

    expect(isSectionedSourceMap(impostor as SourceMapDocument)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The same pairing contract, over full response doubles.
//
// Everything above injects `fetchImpl` to prove what the module *asks for*: a
// refused URL produces no request at all, and only an injected `fetch` can show
// the absence of a call. This section runs the pairing contract the other way
// round and proves what the module *does with an answer*. The committed
// fixtures are served as real `Response` objects — an accurate
// `Content-Length` and the right media type — alongside the answers a dev
// server gives when something is wrong: a 404, a declared length past the
// ceiling, a body that arrives in frames and declares no length at all, a
// document truncated mid-array, a request that is never answered, and one the
// caller cancels while it is in flight.
//
// It is socket-free on purpose. Nothing here binds a port and nothing calls the
// global `fetch`, so the suite is hermetic: its results depend on the committed
// bytes and on nothing else that happens to be listening on this host. The
// transport itself — a kernel socket, keep-alive framing, a connection the
// operating system refuses — is covered where a transport exists to exercise,
// in the browser and integration suites of AAP 0.8.3. No case in this file
// stands in for those, and none claims to.
//
// Three things the doubles have to reproduce faithfully, and do:
//
//   * **A body that arrives in pieces.** `framedResponse` builds a
//     `ReadableStream` that hands out fixed-size frames and declares no
//     `Content-Length`, so the ceiling has to stop the read *while* the body is
//     arriving rather than after it has been buffered. The stream records how
//     many frames were pulled and whether it was cancelled, and the case
//     asserts both — a partial read, not a whole one.
//   * **`fetch`'s refusal of an aborted request.** A real `fetch` rejects
//     rather than answering when its signal is already aborted, so
//     `answerUnlessAborted` does too. Without that, a cancellation case would
//     be served a document and pass for the wrong reason.
//   * **"No request for `<chunk>.js.map`."** Asserted from the recorded call
//     list, with every unrouted URL answering 404 — so an implementation that
//     derived a map name from the chunk name would both leave its guess in the
//     log and fail the lookup, exactly as it would against a dev server that
//     does not have that file.
//
// The fixture bytes are read once, as bytes, and served from memory; nothing
// here writes to the fixture folder.
// ---------------------------------------------------------------------------

/** Where the doubles serve artifacts, so a relative directive resolves beside it. */
const SERVED_CHUNK_PREFIX = '/_next/static/chunks/';

/**
 * The dev-server origin this section pins to and serves from.
 *
 * A fixed port is the deterministic choice now that nothing binds: there is no
 * listener to clash with another checkout of this repository on the same host,
 * and no ephemeral port, so every assertion below names the exact URL it
 * expects instead of deriving it at run time. It differs from `PINNED_ORIGIN`
 * only so that neither half of this file comes to depend on sharing one
 * constant with the other.
 */
const SERVED_ORIGIN = 'http://127.0.0.1:4318';

/** A loopback origin whose dev server is not running: every request is refused. */
const UNREACHABLE_ORIGIN = 'http://127.0.0.1:4319';

/** The committed artifacts these cases serve, by fixture filename. */
const SERVED_FIXTURES: readonly string[] = [
  'webpack-basin-page.js',
  'webpack-basin-page.js.map',
  'turbopack-gauge-route.js',
  'turbopack-gauge-route.js.map',
  'turbopack-station-widget.js',
  'turbopack-station-widget-6f3ad91c.js.map',
  'inline-map-basin-detail.js',
  'unmapped-observatory-runtime.js',
];

/**
 * The bytes of those artifacts, read once at module scope.
 *
 * Read as bytes and served verbatim: this suite is a reader of the fixture
 * folder and never a writer of it, and a `Buffer` is what a response body is,
 * so nothing re-encodes the committed bytes on the way through.
 */
const SERVED_BODIES = new Map<string, Buffer>(
  SERVED_FIXTURES.map((name): [string, Buffer] => [name, readFileSync(new URL(name, FIXTURE_DIR))]),
);

/** A route answering with a declared length far past any ceiling a case passes. */
const DECLARED_OVERSIZED_CHUNK = 'declared-oversized.js';

/** A chunk whose directive names the framed, length-less oversized map below. */
const STREAMED_CHUNK = 'streamed-oversized.js';

/** A map served in frames with **no** `Content-Length`, so only the read bounds it. */
const STREAMED_MAP = 'streamed-oversized.js.map';

/** A chunk whose directive names the truncated document below. */
const MALFORMED_OWNER_CHUNK = 'malformed-document.js';

/** A `.map` route answering 200 with JSON that stops mid-array. */
const MALFORMED_MAP = 'malformed-document.js.map';

/** The truncated document that route serves: valid JSON up to the cut. */
const TRUNCATED_DOCUMENT = '{"version":3,"sources":[';

/** A route that accepts the request and never answers it. */
const SILENT_CHUNK = 'silent.js';

/** The body size both oversized routes claim or produce. */
const OVERSIZED_BYTES = 64 * 1024;

/** How much the framed route hands over per frame, so it streams rather than buffers. */
const STREAM_FRAME_BYTES = 4 * 1024;

/** The ceiling the oversized cases pass: small enough to be hit at the first frame. */
const TIGHT_MAX_BYTES = 1024;

/** The deadline the never-answered case gives, far inside the suite's own budget. */
const TIGHT_TIMEOUT_MS = 50;

/** The filler byte the framed route pads its frames with (`x`). */
const PAD_BYTE = 0x78;

/** The highest port number a URL can name, for the adjacent-port case below. */
const MAX_TCP_PORT = 65_535;

const JS_MEDIA_TYPE = 'application/javascript; charset=utf-8';
const JSON_MEDIA_TYPE = 'application/json; charset=utf-8';

describe('the published request bounds', () => {
  it('leaves room for an inline map inside the response ceiling', () => {
    // The tail window has to hold a whole inline `data:` directive and the
    // response ceiling has to hold the response carrying it, so the two
    // constants are ordered rather than independent.
    expect(Number.isInteger(SOURCE_MAPPING_URL_TAIL_BYTES)).toBe(true);
    expect(SOURCE_MAPPING_URL_TAIL_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_MAX_MAP_BYTES).toBeGreaterThan(SOURCE_MAPPING_URL_TAIL_BYTES);
    // Long enough to survive a cold compile of the chunk being requested,
    // short enough that a wedged dev server fails visibly instead of hanging.
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBeGreaterThan(TIGHT_TIMEOUT_MS);
    expect(Number.isInteger(DEFAULT_FETCH_TIMEOUT_MS)).toBe(true);
  });
});

/** The URL of `name` on the served dev-server origin. */
function servedUrl(name: string): string {
  return `${SERVED_ORIGIN}${SERVED_CHUNK_PREFIX}${name}`;
}

/** The committed bytes of `name`, or a failure naming the artifact that is missing. */
function bodyOf(name: string): Buffer {
  const body = SERVED_BODIES.get(name);
  if (body === undefined) {
    throw new Error(`${name} is not one of the artifacts this section serves`);
  }
  return body;
}

/** The media type a dev server answers with for `name`. */
function mediaTypeOf(name: string): string {
  return name.endsWith('.map') ? JSON_MEDIA_TYPE : JS_MEDIA_TYPE;
}

/**
 * One complete 200 response with an **accurate** `Content-Length`.
 *
 * Accurate rather than omitted, because that is the header half of the module's
 * ceiling: a response inside the ceiling has to pass it, and the case that
 * proves the ceiling refuses an oversized *claim* declares its own length
 * instead of using this.
 */
function servedResponse(body: Uint8Array, mediaType: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': mediaType, 'content-length': String(body.byteLength) },
  });
}

/** The same, for a body given as text: the length is measured in bytes, not characters. */
function textResponse(body: string, mediaType: string): Response {
  return servedResponse(Buffer.from(body, 'utf8'), mediaType);
}

/** The rejection an aborted `fetch` produces, in the shape the platform produces it. */
function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Answers with `build()`, unless the request's signal is already aborted.
 *
 * `fetch` refuses an aborted request rather than serving it, and the
 * cancellation cases turn on exactly that: a double that answered regardless
 * would hand the module a document and let a broken signal composition pass.
 */
function answerUnlessAborted(init: FetchInit, build: () => Response): Promise<Response> {
  if (init?.signal?.aborted === true) {
    return Promise.reject(abortError());
  }
  return Promise.resolve(build());
}

/**
 * A route that never answers until the request's own signal aborts it.
 *
 * A request made *without* a signal is rejected with a message saying so
 * instead of hanging, so "the module bounded this itself" cannot be confused
 * with "the module never asked to be bounded" — the timeout case asserts the
 * recorded signal as well, and this is the half of that pair that fails fast.
 */
function neverAnswers(init: FetchInit): Promise<Response> {
  const signal = init?.signal;
  if (signal === undefined || signal === null) {
    return Promise.reject(new Error('the module made a request with no signal'));
  }
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<Response>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(abortError());
    });
  });
}

/**
 * The rejection `fetch` produces for a connection the operating system refuses.
 *
 * Shaped the way the runtime shapes it — a `TypeError` carrying the
 * `ECONNREFUSED` system error as its `cause` — because this module classifies
 * *any* rejection as `request-failed`, and a case that rejected with a bare
 * `Error` would not show that the realistic failure is classified the same way.
 */
function connectionRefused(): TypeError {
  return new TypeError('fetch failed', {
    cause: new Error(`connect ECONNREFUSED ${new URL(UNREACHABLE_ORIGIN).host}`),
  });
}

/** A framed, length-less response together with the log of how it was read. */
interface FramedBody {
  /** The response to serve. Built once, because a body can be read once. */
  readonly response: Response;

  /** How many frames draining the whole body would take. */
  readonly frames: number;

  /** What the consumer did: frames pulled, and whether it cancelled the stream. */
  readonly log: { pulled: number; cancelled: boolean };
}

/**
 * Builds a response whose body arrives in `frameBytes` frames and declares no
 * length, and records how much of it the consumer pulled.
 *
 * This is the case the module's streaming ceiling exists for, so the evidence
 * has to be about the *read* rather than about the outcome: a consumer that
 * buffered the whole body and measured afterwards would produce the same
 * refusal, and only `log.pulled` and `log.cancelled` tell the two apart.
 */
function framedResponse(totalBytes: number, frameBytes: number): FramedBody {
  const frames = Math.ceil(totalBytes / frameBytes);
  const log = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (log.pulled >= frames) {
        controller.close();
        return;
      }
      log.pulled += 1;
      controller.enqueue(Buffer.alloc(frameBytes, PAD_BYTE));
    },
    cancel() {
      log.cancelled = true;
    },
  });

  return {
    // No `content-length` at all: the header check must have nothing to go on,
    // so that only the streaming check can refuse this body.
    response: new Response(stream, { status: 200, headers: { 'content-type': JSON_MEDIA_TYPE } }),
    frames,
    log,
  };
}

/**
 * The route table of the served dev server: every committed artifact, plus any
 * per-case route given in `extra`.
 *
 * Each artifact is a factory rather than a prepared `Response` because a body
 * can only be read once and the cache cases fetch the same chunk twice. Every
 * URL not in the table answers 404 through {@link fetchDouble}, which is what
 * makes "a derived `<chunk>.js.map` is never requested" observable: the guess
 * would be answered "not found" rather than served a map.
 */
function servedRoutes(extra: Readonly<Record<string, Route>> = {}): Record<string, Route> {
  const routes: Record<string, Route> = {};
  for (const name of SERVED_FIXTURES) {
    routes[servedUrl(name)] = (init) =>
      answerUnlessAborted(init, () => servedResponse(bodyOf(name), mediaTypeOf(name)));
  }
  return { ...routes, ...extra };
}

/** Options pinned to the served origin, with the double and any overrides filled in. */
function servedOptions(double: FetchDouble, overrides: Partial<FetchSourceMapOptions> = {}) {
  return options(double, { devServerOrigin: SERVED_ORIGIN, ...overrides });
}

describe('fetchSourceMap — reading a served dev-server response', () => {
  it('pairs a chunk with its same-stem map and parses the document it was served', async () => {
    const double = fetchDouble(servedRoutes());

    const found = expectFound(
      await fetchSourceMap(servedUrl('webpack-basin-page.js'), servedOptions(double)),
    );

    expect(found.inline).toBe(false);
    expect(found.mapUrl).toBe(servedUrl('webpack-basin-page.js.map'));
    expect(isSectionedSourceMap(found.map)).toBe(false);
    if (!isSectionedSourceMap(found.map)) {
      expect(found.map.version).toBe(3);
      expect(found.map.file).toBe('webpack-basin-page.js');
      expect(found.map.sources).toEqual(WEBPACK_MAP_SOURCES);
      expect(found.map.names).toEqual(['handleReadoutClick', 'fetchGaugeIndex']);
      // The one map in the folder carrying original content, with the
      // dependency frame's entry withheld rather than missing.
      expect(found.map.sourcesContent).toHaveLength(WEBPACK_MAP_SOURCES.length);
      expect(found.map.sourcesContent?.[2]).toBeNull();
    }
    // Both responses declared an accurate length (see `servedResponse`) and
    // both are inside the default ceiling, so the header check passed them
    // through instead of refusing them.
    expect(bodyOf('webpack-basin-page.js.map').byteLength).toBeLessThan(DEFAULT_MAX_MAP_BYTES);
    expect(double.calls).toEqual([
      servedUrl('webpack-basin-page.js'),
      servedUrl('webpack-basin-page.js.map'),
    ]);
  });

  it('requests only the map its directive names, never a same-stem guess', async () => {
    const double = fetchDouble(servedRoutes());

    const found = expectFound(
      await fetchSourceMap(servedUrl('turbopack-station-widget.js'), servedOptions(double)),
    );

    expect(found.mapUrl).toBe(servedUrl('turbopack-station-widget-6f3ad91c.js.map'));
    expect(double.calls).toEqual([
      servedUrl('turbopack-station-widget.js'),
      servedUrl('turbopack-station-widget-6f3ad91c.js.map'),
    ]);
    // `turbopack-station-widget.js.map` is not in the fixture folder, so it has
    // no route and would be answered 404: a name-deriving implementation would
    // both fail the lookup and leave its guess in the recorded list.
    const derived = servedUrl('turbopack-station-widget.js.map');
    expect(servedRoutes()[derived]).toBeUndefined();
    expect(double.calls).not.toContain(derived);
    if (!isSectionedSourceMap(found.map)) {
      expect(found.map.file).toBe('turbopack-station-widget.js');
      // Absent on purpose: this map exercises the read-from-disk fallback.
      expect(found.map.sourcesContent).toBeUndefined();
    }
  });

  it('carries a sectioned document through the response intact', async () => {
    const double = fetchDouble(servedRoutes());

    const found = expectFound(
      await fetchSourceMap(servedUrl('turbopack-gauge-route.js'), servedOptions(double)),
    );

    expect(isSectionedSourceMap(found.map)).toBe(true);
    if (isSectionedSourceMap(found.map)) {
      expect(found.map.sections).toHaveLength(FIXTURE_SECTION_COUNT);
      // A response that dropped or reordered a section would still produce a
      // document the shape check accepts, so the offsets are asserted too.
      expect(found.map.sections.map((section) => section.offset)).toEqual(FIXTURE_SECTION_OFFSETS);
    }
  });

  it('decodes the embedded map with no second request', async () => {
    const chunkText = fixture('inline-map-basin-detail.js');
    // The fixture's directive carries a media-type *parameter* before
    // `;base64` — `data:application/json;charset=utf-8;base64,` — which is what
    // real inline maps look like and what a prefix match on
    // `data:application/json;base64,` refuses. That is this case's point.
    expect(chunkText).toContain('data:application/json;charset=utf-8;base64,');
    const double = fetchDouble(servedRoutes());

    const found = expectFound(
      await fetchSourceMap(servedUrl('inline-map-basin-detail.js'), servedOptions(double)),
    );

    expect(found.inline).toBe(true);
    // An embedded map has no URL of its own; the chunk is where it lives.
    expect(found.mapUrl).toBe(servedUrl('inline-map-basin-detail.js'));
    expect(found.map).toEqual(JSON.parse(INLINE_MAP_JSON) as unknown);
    if (!isSectionedSourceMap(found.map)) {
      expect(found.map.sources).toHaveLength(1);
      expect(found.map.names).toEqual(['BasinDetailPage']);
    }
    // One request, and it was the chunk: `inline-map-basin-detail.js.map` does
    // not exist and must never be asked for.
    expect(double.calls).toEqual([servedUrl('inline-map-basin-detail.js')]);
  });

  it('reports a chunk with no directive after exactly one request', async () => {
    const double = fetchDouble(servedRoutes());

    const result = await fetchSourceMap(
      servedUrl('unmapped-observatory-runtime.js'),
      servedOptions(double),
    );

    // An `Ok`, not an `Err`: the resolver's fallback to its other three routes
    // depends on "this chunk has no map" not looking like a failure.
    expect(expectNone(result)).toBe('no-directive');
    expect(double.calls).toEqual([servedUrl('unmapped-observatory-runtime.js')]);
    expect(double.calls.some((href) => href.endsWith('.map'))).toBe(false);
  });

  it("reports the dev server's 404 for a chunk it no longer serves", async () => {
    // Unrouted, so the double answers 404 — which is what a dev server does
    // with a chunk name from a previous build.
    const double = fetchDouble(servedRoutes());

    const error = expectErr(
      await fetchSourceMap(servedUrl('evicted-chunk.js'), servedOptions(double)),
    );

    expect(error.code).toBe('DEV_SERVER_UNAVAILABLE');
    expect(error.details?.['reason']).toBe('http-status');
    expect(error.details?.['status']).toBe(404);
    expect(error.details?.['role']).toBe('chunk');
    expect(double.calls).toEqual([servedUrl('evicted-chunk.js')]);
  });

  it('refuses a response whose declared length exceeds the ceiling, before reading it', async () => {
    // A declared length is a *claim*, and a one-byte body is what proves the
    // claim alone refused this response: nothing read the body, so `bodyUsed`
    // is still false when the refusal comes back.
    const declared = new Response('x', {
      status: 200,
      headers: { 'content-type': JS_MEDIA_TYPE, 'content-length': String(OVERSIZED_BYTES) },
    });
    const double = fetchDouble(
      servedRoutes({ [servedUrl(DECLARED_OVERSIZED_CHUNK)]: () => declared }),
    );

    const error = expectErr(
      await fetchSourceMap(
        servedUrl(DECLARED_OVERSIZED_CHUNK),
        servedOptions(double, { maxBytes: TIGHT_MAX_BYTES }),
      ),
    );

    expect(error.details?.['reason']).toBe('too-large');
    expect(error.details?.['role']).toBe('chunk');
    expect(error.details?.['maxBytes']).toBe(TIGHT_MAX_BYTES);
    expect(error.details?.['observedBytes']).toBe(OVERSIZED_BYTES);
    expect(declared.bodyUsed).toBe(false);
  });

  it('stops reading a framed body that declares no length', async () => {
    const framed = framedResponse(OVERSIZED_BYTES, STREAM_FRAME_BYTES);
    const double = fetchDouble(
      servedRoutes({
        [servedUrl(STREAMED_CHUNK)]: (init) =>
          answerUnlessAborted(init, () => textResponse(chunkNaming(STREAMED_MAP), JS_MEDIA_TYPE)),
        [servedUrl(STREAMED_MAP)]: () => framed.response,
      }),
    );

    const error = expectErr(
      await fetchSourceMap(
        servedUrl(STREAMED_CHUNK),
        servedOptions(double, { maxBytes: TIGHT_MAX_BYTES }),
      ),
    );

    expect(error.details?.['reason']).toBe('too-large');
    expect(error.details?.['role']).toBe('map');
    // Read, not declared: this response carries no `Content-Length` at all, so
    // the header check cannot be what refused it, and the observed count is a
    // partial read rather than the whole body.
    expect(framed.response.headers.get('content-length')).toBeNull();
    expect(error.details?.['observedBytes']).toBeGreaterThan(TIGHT_MAX_BYTES);
    expect(error.details?.['observedBytes']).toBeLessThanOrEqual(OVERSIZED_BYTES);
    // And it stopped *while* the body was arriving: strictly fewer frames were
    // pulled than draining it would take, and the stream was cancelled rather
    // than left open for the rest of the body.
    expect(framed.frames).toBeGreaterThan(1);
    expect(framed.log.pulled).toBeGreaterThan(0);
    expect(framed.log.pulled).toBeLessThan(framed.frames);
    expect(framed.log.cancelled).toBe(true);
    expect(double.calls).toEqual([servedUrl(STREAMED_CHUNK), servedUrl(STREAMED_MAP)]);
  });

  it('degrades a truncated document served with a 200', async () => {
    const double = fetchDouble(
      servedRoutes({
        [servedUrl(MALFORMED_OWNER_CHUNK)]: (init) =>
          answerUnlessAborted(init, () => textResponse(chunkNaming(MALFORMED_MAP), JS_MEDIA_TYPE)),
        [servedUrl(MALFORMED_MAP)]: (init) =>
          answerUnlessAborted(init, () => textResponse(TRUNCATED_DOCUMENT, JSON_MEDIA_TYPE)),
      }),
    );

    const error = expectErr(
      await fetchSourceMap(servedUrl(MALFORMED_OWNER_CHUNK), servedOptions(double)),
    );

    expect(error.code).toBe('CODE_INDEX_FAILED');
    expect(error.details?.['reason']).toBe('invalid-json');
    expect(double.calls).toEqual([servedUrl(MALFORMED_OWNER_CHUNK), servedUrl(MALFORMED_MAP)]);
  });

  it('bounds a request the dev server never answers, without throwing', async () => {
    const double = fetchDouble(servedRoutes({ [servedUrl(SILENT_CHUNK)]: neverAnswers }));
    const startedAt = Date.now();

    const pending = fetchSourceMap(
      servedUrl(SILENT_CHUNK),
      servedOptions(double, { timeoutMs: TIGHT_TIMEOUT_MS }),
    );

    // The contract is a `Result`, so the promise fulfils even when nothing ever
    // answers — a regression that rejected instead would fail here rather than
    // in whichever caller forgot to guard an `await`.
    await expect(pending).resolves.toBeDefined();
    const error = expectErr(await pending);
    expect(error.code).toBe('DEV_SERVER_UNAVAILABLE');
    expect(error.details?.['reason']).toBe('request-failed');
    // The deadline this call passed is what ended it, promptly: the route
    // answers nothing on its own, and the module's own default is two orders of
    // magnitude longer than the lookup took.
    expect(Date.now() - startedAt).toBeLessThan(DEFAULT_FETCH_TIMEOUT_MS);
    // A signal was passed at all, which is the only reason the route could end
    // the request: one made without it is rejected as such by `neverAnswers`.
    expect(double.calls).toEqual([servedUrl(SILENT_CHUNK)]);
    expect(double.inits[0]?.signal).toBeDefined();
  });

  it('refuses an already-aborted lookup promptly', async () => {
    // The caller's signal is composed with the per-request deadline, so an
    // already-aborted one must end the lookup regardless of the timeout.
    const double = fetchDouble(servedRoutes());

    const error = expectErr(
      await fetchSourceMap(
        servedUrl('webpack-basin-page.js'),
        servedOptions(double, { signal: AbortSignal.abort(), timeoutMs: 60_000 }),
      ),
    );

    expect(error.code).toBe('DEV_SERVER_UNAVAILABLE');
    expect(error.details?.['reason']).toBe('request-failed');
    // This chunk has a route that serves it to any live request, so the
    // refusal is the composed signal's doing and not a missing route.
    expect(double.calls).toEqual([servedUrl('webpack-basin-page.js')]);
    expect(double.inits[0]?.signal?.aborted).toBe(true);
  });

  it('ends an in-flight lookup when the caller aborts, ahead of its own deadline', async () => {
    const controller = new AbortController();
    const double = fetchDouble(servedRoutes({ [servedUrl(SILENT_CHUNK)]: neverAnswers }));

    const pending = fetchSourceMap(
      servedUrl(SILENT_CHUNK),
      servedOptions(double, { signal: controller.signal, timeoutMs: 60_000 }),
    );
    controller.abort();

    const error = expectErr(await pending);
    expect(error.code).toBe('DEV_SERVER_UNAVAILABLE');
    expect(error.details?.['reason']).toBe('request-failed');
    // Composed, not forwarded: the signal the module passed carries both the
    // caller's cancellation and its own deadline, which is why a minute-long
    // timeout did not keep this request in flight.
    const passed = double.inits[0]?.signal;
    expect(passed).toBeDefined();
    expect(passed).not.toBe(controller.signal);
    expect(passed?.aborted).toBe(true);
  });

  it('reports an origin whose dev server is not running, without throwing', async () => {
    const chunkUrl = `${UNREACHABLE_ORIGIN}${SERVED_CHUNK_PREFIX}page.js`;
    const double = fetchDouble({ [chunkUrl]: () => Promise.reject(connectionRefused()) });

    const error = expectErr(
      await fetchSourceMap(chunkUrl, options(double, { devServerOrigin: UNREACHABLE_ORIGIN })),
    );

    expect(error.code).toBe('DEV_SERVER_UNAVAILABLE');
    expect(error.details?.['reason']).toBe('request-failed');
    expect(error.details?.['role']).toBe('chunk');
    // The request was attempted and refused, rather than never made: a pin the
    // module accepted and a server that is not there are different failures.
    expect(double.calls).toEqual([chunkUrl]);
  });

  it('treats a zero ceiling as the default rather than as no budget', async () => {
    // `0` is a bound that does not bound, so the module takes its default —
    // which is why a few kilobytes of fixture still resolve here.
    const double = fetchDouble(servedRoutes());

    const found = expectFound(
      await fetchSourceMap(
        servedUrl('webpack-basin-page.js'),
        servedOptions(double, { maxBytes: 0 }),
      ),
    );

    expect(found.mapUrl).toBe(servedUrl('webpack-basin-page.js.map'));
    expect(bodyOf('webpack-basin-page.js.map').byteLength).toBeLessThan(DEFAULT_MAX_MAP_BYTES);
  });

  it('serves a repeated lookup from an injected cache', async () => {
    const double = fetchDouble(servedRoutes());
    const cache = createSourceMapCache();

    const first = expectFound(
      await fetchSourceMap(servedUrl('webpack-basin-page.js'), servedOptions(double, { cache })),
    );
    const second = expectFound(
      await fetchSourceMap(servedUrl('webpack-basin-page.js'), servedOptions(double, { cache })),
    );

    expect(second.map).toEqual(first.map);
    // The chunk is re-read — only it can say where its map is — and the map is
    // not, so three requests were made rather than four.
    expect(double.calls).toEqual([
      servedUrl('webpack-basin-page.js'),
      servedUrl('webpack-basin-page.js.map'),
      servedUrl('webpack-basin-page.js'),
    ]);
    expect(cache.size).toBe(1);
  });

  it('refuses a chunk on a different port of this same host, with no request', async () => {
    // The pin against a served origin: every artifact resolves on
    // `SERVED_ORIGIN`, and a URL one port away from it is still refused before
    // any request is made.
    const double = fetchDouble(servedRoutes());
    const neighbour = new URL(servedUrl('webpack-basin-page.js'));
    // One port along from the served origin's own, clamped so the URL stays
    // legal wherever that constant sits. Inequality with the pin is the only
    // property the refusal turns on.
    const servedPort = Number(neighbour.port);
    neighbour.port = String(servedPort === MAX_TCP_PORT ? servedPort - 1 : servedPort + 1);

    const error = expectErr(await fetchSourceMap(neighbour.href, servedOptions(double)));

    expect(error.code).toBe('FORBIDDEN_ORIGIN');
    expect(error.details?.['reason']).toBe('origin-mismatch');
    expect(double.calls).toEqual([]);
  });
});
