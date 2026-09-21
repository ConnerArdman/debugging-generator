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
 * Three habits in here are deliberate.
 *
 * 1. **No network and no server.** Every case injects `fetchImpl`, so the suite
 *    is hermetic and — more importantly — can count what would have been
 *    requested. A refusal that "worked" because a port happened to be closed
 *    would prove nothing.
 * 2. **Exact call lists.** `expect(double.calls).toEqual([...])` rather than a
 *    call-count assertion, so a request to the wrong URL fails as loudly as an
 *    extra one.
 * 3. **Every outcome read through the `Result`.** The module's contract is that
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

/** What a route serves: a body string, or a factory for a specific response. */
type Route = string | (() => Response);

/** The init argument of a `fetch` call, named without reaching for a global. */
type FetchInit = Parameters<typeof fetch>[1];

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
    return Promise.resolve(typeof route === 'string' ? new Response(route) : route());
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
      expect(found.map.sections).toHaveLength(3);
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
  it('discriminates the two document forms', () => {
    const sectioned = JSON.parse(fixture('turbopack-gauge-route.js.map')) as SourceMapDocument;
    const plain = JSON.parse(fixture('webpack-basin-page.js.map')) as SourceMapDocument;

    expect(isSectionedSourceMap(sectioned)).toBe(true);
    expect(isSectionedSourceMap(plain)).toBe(false);
  });
});
