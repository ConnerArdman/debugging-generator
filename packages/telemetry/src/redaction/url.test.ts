/**
 * Tests for `./url.ts`: the URL handler of the redaction layer, and the single
 * URL/query parser the rest of the layer canonicalises with.
 *
 * Two guarantees are on trial here, and they fail in opposite directions.
 *
 * 1. **Privacy.** The privacy model states one rule for URLs — *"URL query
 *    parameter values → replaced with `?` per key for display and storage; path
 *    retained"*. A surviving parameter value is a captured customer identifier,
 *    a search term or a one-time link in the session store and, worse, in an
 *    outbound prompt: the outbound guard's `url-query-value` rule rejects a
 *    payload in which a query value survived, so a leak here becomes a hard
 *    failure two layers away rather than a quiet one. Every masking assertion
 *    below therefore ends with {@link expectOnlyMaskedValues}, which states the
 *    guard's condition directly: in the output, every query value is absent,
 *    empty or the mask.
 *
 * 2. **Fidelity.** `./request-key.ts` computes the per-session keyed hash that
 *    groups duplicate requests from the **unredacted** URL, through the very
 *    same {@link parseUrlParts}, {@link parseQueryPairs} and
 *    {@link decodeQueryComponent} used for masking. If the parser drifts,
 *    `productId=A` and `productId=B` can collapse into one group (or two
 *    byte-identical requests can stop colliding) while every panel still shows
 *    a plausible `productId=?` — a defect that is invisible until a
 *    duplicate-request investigation quietly returns nothing. The round-trip
 *    table is the proof that the decomposition is byte-faithful, and it is the
 *    reason this suite asserts on the parser at all rather than only on the
 *    redacted output.
 *
 * Note for whoever finds one of these red: a failing round-trip case means the
 * **parser** is wrong, not the table. Masking and keying must agree on one
 * decomposition, so the fix belongs in `./url.ts`.
 *
 * ## Why some fixtures are assembled at runtime
 *
 * `scripts/check-secrets.mjs` scans every tracked file and fails the build on a
 * credentialed connection string or a provider-key prefix appearing in source.
 * The fixtures that must *look* like credentials to `scrub` are therefore joined
 * from fragments at run time ({@link USERINFO_URL}, {@link PROVIDER_SHAPED}),
 * which keeps this file free of a contiguous secret-shaped literal while the
 * values the functions see are exactly the ones the patterns match. The
 * credential bodies are runs of one character on purpose: they satisfy the
 * pattern's length requirement with zero entropy, so the scanner's entropy rule
 * has nothing to report either.
 */

import { describe, expect, it } from 'vitest';

import { MAX_SCAN_LENGTH, REDACTION_MARKER, REDACTION_MASK, scrub } from './rules.js';
import {
  MAX_QUERY_PAIRS,
  URL_ATTRIBUTE_KEYS,
  decodeQueryComponent,
  formatUrlParts,
  isUrlAttributeKey,
  parseQueryPairs,
  parseUrlParts,
  redactQueryString,
  redactUrl,
  type UrlParts,
} from './url.js';

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------
 */

/**
 * Provider-credential prefix, split so this tracked file never contains it
 * contiguously (see the module documentation).
 */
const PROVIDER_PREFIX = 's' + 'k-ant-';

/**
 * A value `scrub`'s `provider-key` rule matches: the prefix plus a run of token
 * characters longer than the rule's identifying minimum.
 */
const PROVIDER_SHAPED = PROVIDER_PREFIX + 'A'.repeat(24);

/** A credentialed absolute URL, assembled from fragments. */
const USERINFO_URL = ['postgresql', '://', 'demo', ':', 'pw', '@', 'db.example.test:5432/app'].join(
  '',
);

/** The same URL with its userinfo replaced — what both handlers must produce. */
const REDACTED_USERINFO_URL = `postgresql://${REDACTION_MARKER}@db.example.test:5432/app`;

/** A protocol-relative URL carrying userinfo, assembled from fragments. */
const PROTOCOL_RELATIVE_USERINFO_URL = ['//', 'demo', ':', 'pw', '@', 'host.example.test/p'].join(
  '',
);

/**
 * The path budget `./url.ts` applies, mirrored here because the module keeps the
 * constant private.
 *
 * The bounds cases below assert it as an upper bound rather than an exact
 * length, so raising the budget later loosens these expectations instead of
 * breaking them.
 */
const PATH_BUDGET = 4_096;

/** One entry of the fixture table, labelled so failures name themselves. */
interface UrlFixture {
  readonly label: string;
  readonly value: string;
}

/**
 * The part of the `URL` global this suite uses, typed locally.
 *
 * The normalisation cases below are worth little unless the fixture really is
 * one the `URL` global reshapes, so they demonstrate the difference rather than
 * asserting it in prose. Reaching the constructor through `globalThis` with a
 * hand-written type keeps that demonstration free of the DOM and Node type
 * packages, which this suite otherwise needs no part of — `./url.ts` is
 * dependency-light because the browser-agent bundle embeds it.
 */
type UrlNormaliser = new (input: string) => { toString(): string };

/** The `URL` global, present in every environment the telemetry project runs in. */
const { URL: urlGlobal } = globalThis as unknown as { URL: UrlNormaliser };

/** What the `URL` global makes of a value, for contrast with {@link redactUrl}. */
function normaliseWithUrlGlobal(value: string): string {
  return new urlGlobal(value).toString();
}

/**
 * Every URL shape that reaches the redaction layer, each of which must survive
 * `formatUrlParts(parseUrlParts(v)) === v` and `redactUrl(redactUrl(v)) ===
 * redactUrl(v)`.
 *
 * The list is deliberately wider than the absolute-URL happy path: the browser
 * agent reports whatever the page passed to `fetch`, which is routinely
 * origin-relative and occasionally not a URL at all, and the Node preload's span
 * attributes carry authority-only and credentialed forms.
 */
const URL_FIXTURES: readonly UrlFixture[] = [
  {
    label: 'absolute with port, query and fragment',
    value: 'https://a.example.test:8443/v1/p?slug=x&limit=20#top',
  },
  { label: 'absolute without a path', value: 'https://api.example.test' },
  { label: 'absolute with an empty path and a query', value: 'https://api.example.test?slug=x' },
  { label: 'origin-relative', value: '/api/products?slug=x' },
  { label: 'protocol-relative', value: '//cdn.example.test/p' },
  { label: 'bare-relative', value: 'products?a=1' },
  { label: 'credentialed', value: USERINFO_URL },
  { label: 'credentialed and protocol-relative', value: PROTOCOL_RELATIVE_USERINFO_URL },
  { label: 'query present but empty', value: '/p?' },
  { label: 'fragment present but empty', value: '/p#' },
  { label: 'path only', value: '/only/path' },
  { label: 'the empty string', value: '' },
  { label: 'a non-URL string with spaces', value: 'not a url with spaces' },
  { label: 'mixed case, default port, escaped path', value: 'HTTP://Host.Example:80/A%2FB?q=1#f' },
  { label: 'an empty port', value: 'http://host:/p' },
  { label: 'a bracketed IPv6 authority', value: 'http://[::1]:3000/p?a=1' },
  { label: 'an empty userinfo', value: '//@host/p' },
  { label: 'userinfo containing an @', value: '//a@b@host/p' },
  { label: 'a scheme with no authority', value: 'mailto:someone@example.test' },
  { label: 'a fragment containing a query', value: 'https://h.test/p#/route?x=1' },
  { label: 'a lone question mark', value: '?' },
  { label: 'a lone hash', value: '#' },
  { label: 'repeated, bare and empty parameters', value: '/api/p?flag&empty=&x=1&x=2' },
  { label: 'a raw, undecoded key', value: 'https://h.test/p?a%20b=c+d' },
];

/**
 * Values that are already redacted output.
 *
 * Idempotence is what makes the layer safe to apply twice — at ingest and again
 * on the outbound path — and these are the shapes that would break it if any
 * treatment were not a fixed point: a masked value must not become `??` or
 * `%3F`, a replaced userinfo must not be replaced again, a masked fragment must
 * stay one mask and the overflow marker must re-parse as a bare key.
 */
const REDACTED_FIXTURES: readonly UrlFixture[] = [
  { label: 'a masked query value', value: '/api/p?a=?' },
  { label: 'a masked, bare and empty value together', value: '/api/p?flag&empty=&x=?' },
  { label: 'a replaced userinfo', value: REDACTED_USERINFO_URL },
  { label: 'a masked fragment', value: '/p#?' },
  { label: 'an overflow marker segment', value: `/api/p?a=?&${REDACTION_MARKER}` },
  { label: 'a replaced authority', value: `https://${REDACTION_MARKER}` },
];

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

/** The query of a URL, or `undefined` when it carried no `?`. */
function queryOf(value: string): string | undefined {
  return parseUrlParts(value).query;
}

/** The `[key, value]` pairs of a URL's query, empty when it had none. */
function queryPairsOf(value: string): Array<[string, string | undefined]> {
  const query = queryOf(value);
  return query === undefined ? [] : parseQueryPairs(query);
}

/** The keys of a URL's query, in arrival order. */
function queryKeysOf(value: string): string[] {
  return queryPairsOf(value).map(([key]) => key);
}

/**
 * Asserts the condition the outbound `url-query-value` guard checks: in a
 * redacted URL, every query parameter value is absent (a bare flag), empty (as
 * it arrived) or the mask — never data.
 *
 * Applied to every masking assertion in this file, so a value that survives one
 * fixture's specific expectation still fails here.
 */
function expectOnlyMaskedValues(redacted: string): void {
  for (const [, value] of queryPairsOf(redacted)) {
    if (value !== undefined && value.length > 0) {
      expect(value).toBe(REDACTION_MASK);
    }
  }
}

/*
 * ---------------------------------------------------------------------------
 * Parser correctness
 * ---------------------------------------------------------------------------
 */

describe('parseUrlParts and formatUrlParts', () => {
  describe('round-trips every URL shape byte for byte', () => {
    for (const { label, value } of [...URL_FIXTURES, ...REDACTED_FIXTURES]) {
      it(label, () => {
        expect(formatUrlParts(parseUrlParts(value))).toBe(value);
      });
    }
  });

  it('decomposes an absolute URL into every component', () => {
    const expected: UrlParts = {
      scheme: 'https',
      host: 'api.example.test',
      port: '8443',
      path: '/v1/products',
      query: 'slug=x&limit=20',
      fragment: 'top',
    };
    expect(parseUrlParts('https://api.example.test:8443/v1/products?slug=x&limit=20#top')).toEqual(
      expected,
    );
  });

  it('distinguishes an absent query from an empty one', () => {
    expect(queryOf('/p')).toBeUndefined();
    expect(queryOf('/p?')).toBe('');
    expect(queryOf('/p?a=1')).toBe('a=1');
  });

  it('distinguishes an absent fragment from an empty one', () => {
    expect(parseUrlParts('/p').fragment).toBeUndefined();
    expect(parseUrlParts('/p#').fragment).toBe('');
    expect(parseUrlParts('/p#top').fragment).toBe('top');
  });

  it('binds the fragment before the query, so a query inside a fragment stays there', () => {
    const parts = parseUrlParts('https://h.test/p#/route?x=1');
    expect(parts.fragment).toBe('/route?x=1');
    expect(parts.query).toBeUndefined();
    expect(parts.path).toBe('/p');
  });

  it('splits the userinfo at the last @', () => {
    expect(parseUrlParts('//a@b@host/p')).toEqual({ userinfo: 'a@b', host: 'host', path: '/p' });
  });

  it('keeps an empty userinfo and an empty port, which carry no data but do round-trip', () => {
    expect(parseUrlParts('//@host/p').userinfo).toBe('');
    expect(parseUrlParts('http://host:/p').port).toBe('');
  });

  it('finds the port of a bracketed IPv6 authority after the closing bracket', () => {
    expect(parseUrlParts('http://[::1]:3000/p?a=1')).toEqual({
      scheme: 'http',
      host: '[::1]',
      port: '3000',
      path: '/p',
      query: 'a=1',
    });
  });

  it('reads a scheme only when an authority marker follows it', () => {
    // `mailto:` has no `//`, so the whole value is a path: masking never has to
    // guess at a scheme-specific syntax the parser does not model.
    expect(parseUrlParts('mailto:someone@example.test')).toEqual({
      path: 'mailto:someone@example.test',
    });
  });

  it('treats a value with no recognisable structure as a bare path', () => {
    expect(parseUrlParts('not a url with spaces')).toEqual({ path: 'not a url with spaces' });
    expect(parseUrlParts('')).toEqual({ path: '' });
  });

  it('never throws, whatever it is handed', () => {
    const inputs = [
      '?',
      '#',
      '#?',
      '//',
      '://',
      '?#',
      '\u0000\u0001\u0007',
      '\ud800',
      'a'.repeat(5000),
    ];
    for (const input of inputs) {
      expect(() => parseUrlParts(input)).not.toThrow();
      expect(formatUrlParts(parseUrlParts(input))).toBe(input);
    }
  });
});

describe('parseQueryPairs', () => {
  it('preserves arrival order rather than sorting', () => {
    expect(parseQueryPairs('z=1&a=2&m=3')).toEqual([
      ['z', '1'],
      ['a', '2'],
      ['m', '3'],
    ]);
  });

  it('splits a segment on its first = only', () => {
    // How a server reads it: the value of `a` is `b=c`, not `b`.
    expect(parseQueryPairs('a=b=c')).toEqual([['a', 'b=c']]);
  });

  it('reports a bare flag as undefined, distinguishing ?flag from ?flag=', () => {
    expect(parseQueryPairs('flag')).toEqual([['flag', undefined]]);
    expect(parseQueryPairs('flag=')).toEqual([['flag', '']]);
  });

  it('drops empty segments instead of inventing nameless pairs', () => {
    const expected = [
      ['a', '1'],
      ['b', '2'],
    ];
    expect(parseQueryPairs('a=1&&b=2')).toEqual(expected);
    expect(parseQueryPairs('&a=1&b=2&')).toEqual(expected);
    expect(parseQueryPairs('')).toEqual([]);
    expect(parseQueryPairs('&')).toEqual([]);
  });

  it('decodes nothing: pairs are raw slices of the input', () => {
    // Keying and masking both need the bytes as they arrived; decoding happens
    // only where a caller asks for it, through decodeQueryComponent.
    expect(parseQueryPairs('a%20b=c+d')).toEqual([['a%20b', 'c+d']]);
  });

  it('caps the pairs it returns at MAX_QUERY_PAIRS', () => {
    const query = Array.from(
      { length: MAX_QUERY_PAIRS + 40 },
      (_, index) => `k${String(index)}=v${String(index)}`,
    ).join('&');
    expect(parseQueryPairs(query)).toHaveLength(MAX_QUERY_PAIRS);
  });
});

describe('decodeQueryComponent', () => {
  it('maps + to a space and decodes percent escapes', () => {
    expect(decodeQueryComponent('a+b')).toBe('a b');
    expect(decodeQueryComponent('a%20b')).toBe('a b');
    expect(decodeQueryComponent('a%2Fb')).toBe('a/b');
    expect(decodeQueryComponent('a+b%20c')).toBe('a b c');
  });

  it('canonicalises the three spellings of a space identically', () => {
    // The property duplicate detection rests on: `a b`, `a+b` and `a%20b` are
    // the same request parameter and must key the same way.
    const forms = ['a b', 'a+b', 'a%20b'].map((form) => decodeQueryComponent(form));
    expect(new Set(forms).size).toBe(1);
  });

  it('returns malformed input unchanged instead of throwing', () => {
    // decodeURIComponent throws on these; losing a telemetry batch to one
    // malformed parameter would be absurd.
    expect(decodeQueryComponent('%zz')).toBe('%zz');
    expect(decodeQueryComponent('%')).toBe('%');
    expect(decodeQueryComponent('a%')).toBe('a%');
    expect(decodeQueryComponent('%ED%A0%80')).toBe('%ED%A0%80');
    // The `+` substitution still applies, so the result is deterministic.
    expect(decodeQueryComponent('a+b%zz')).toBe('a b%zz');
  });

  it('accepts an empty component', () => {
    expect(decodeQueryComponent('')).toBe('');
  });
});

describe('redactQueryString', () => {
  it('masks every value with REDACTION_MASK while keeping keys and order', () => {
    expect(redactQueryString('productId=42&limit=20')).toBe(
      `productId=${REDACTION_MASK}&limit=${REDACTION_MASK}`,
    );
  });

  it('keeps a bare flag bare and an explicitly empty value empty', () => {
    // Masking `a=` would invent a value that was never sent.
    expect(redactQueryString('flag&empty=&x=1')).toBe(`flag&empty=&x=${REDACTION_MASK}`);
  });

  it('masks a repeated key once per occurrence and never collapses it', () => {
    expect(redactQueryString('a=1&a=2')).toBe(`a=${REDACTION_MASK}&a=${REDACTION_MASK}`);
  });

  it('masks the whole value of a segment with several = characters', () => {
    expect(redactQueryString('a=b=c')).toBe(`a=${REDACTION_MASK}`);
  });

  it('keeps keys raw, neither decoded nor re-encoded', () => {
    expect(redactQueryString('a%20b=c+d')).toBe(`a%20b=${REDACTION_MASK}`);
  });

  it('returns an empty query as an empty string', () => {
    expect(redactQueryString('')).toBe('');
  });

  it('cuts at a pair boundary and marks the remainder when the length budget is spent', () => {
    // Values mask to one character, so only oversized *keys* can exhaust the
    // query budget. The cut is whole pairs plus one marker segment.
    const oversizedName = 'k'.repeat(4000);
    const masked = redactQueryString(
      [`${oversizedName}=1`, `${oversizedName}=1`, `${oversizedName}=1`].join('&'),
    );
    const segments = masked.split('&');
    expect(segments).toHaveLength(3);
    expect(segments.at(-1)).toBe(REDACTION_MARKER);
    expect(masked).not.toContain('=1');
    expect(redactQueryString(masked)).toBe(masked);
  });

  it('caps the pairs it renders and marks the remainder', () => {
    const query = Array.from(
      { length: MAX_QUERY_PAIRS + 40 },
      (_, index) => `k${String(index)}=v${String(index)}`,
    ).join('&');
    const masked = redactQueryString(query);
    const segments = masked.split('&');
    expect(segments).toHaveLength(MAX_QUERY_PAIRS);
    expect(segments.at(-1)).toBe(REDACTION_MARKER);
    expect(masked).not.toContain(`k${String(MAX_QUERY_PAIRS)}`);
  });

  it('is a fixed point of its own output', () => {
    expect(redactQueryString(`a=${REDACTION_MASK}`)).toBe(`a=${REDACTION_MASK}`);
    expect(redactQueryString(REDACTION_MARKER)).toBe(REDACTION_MARKER);
  });
});

describe('redactUrl does not normalise the way the URL global does', () => {
  it('keeps the case of the scheme and the host', () => {
    const value = 'HTTP://Host.Example/A?q=1';
    expect(redactUrl(value)).toBe(`HTTP://Host.Example/A?q=${REDACTION_MASK}`);
    // The contrast that motivates the hand-written parser: the URL global
    // lower-cases both, so a panel built on it would stop matching the request
    // the DevTools Network pane shows.
    expect(normaliseWithUrlGlobal(value)).toContain('host.example');
  });

  it('keeps an explicit default port', () => {
    expect(redactUrl('http://h.test:80/p')).toBe('http://h.test:80/p');
    expect(redactUrl('https://h.test:443/p')).toBe('https://h.test:443/p');
    expect(normaliseWithUrlGlobal('https://h.test:443/p')).not.toContain(':443');
  });

  it('does not decode a percent escape in the path', () => {
    expect(redactUrl('https://h.test/A%2FB/c')).toBe('https://h.test/A%2FB/c');
  });

  it('leaves a relative URL relative instead of inventing an origin', () => {
    expect(redactUrl('/api/products?slug=x')).toBe(`/api/products?slug=${REDACTION_MASK}`);
    expect(redactUrl('products?a=1')).toBe(`products?a=${REDACTION_MASK}`);
    expect(redactUrl('//cdn.example.test/p')).toBe('//cdn.example.test/p');
  });

  it('does not collapse a duplicate key: both occurrences appear, each masked', () => {
    const redacted = redactUrl('/api/p?a=1&a=2');
    expect(redacted).toBe(`/api/p?a=${REDACTION_MASK}&a=${REDACTION_MASK}`);
    expect(queryKeysOf(redacted)).toEqual(['a', 'a']);
    expectOnlyMaskedValues(redacted);
  });

  it('does not reorder parameters', () => {
    const redacted = redactUrl('/api/p?z=1&a=2&m=3');
    expect(queryKeysOf(redacted)).toEqual(['z', 'a', 'm']);
    expectOnlyMaskedValues(redacted);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Masking
 * ---------------------------------------------------------------------------
 */

describe('redactUrl masks query values and keeps the request shape', () => {
  it('masks every value while keeping the keys, their order and the path', () => {
    const redacted = redactUrl('/api/p?productId=42&limit=20');
    expect(redacted).toBe(`/api/p?productId=${REDACTION_MASK}&limit=${REDACTION_MASK}`);
    expect(queryKeysOf(redacted)).toEqual(['productId', 'limit']);
    expectOnlyMaskedValues(redacted);
  });

  it('keeps scheme, host, port and path around a masked query', () => {
    const redacted = redactUrl('https://api.example.test:8443/v1/products?slug=x&limit=20');
    expect(redacted).toBe(
      `https://api.example.test:8443/v1/products?slug=${REDACTION_MASK}&limit=${REDACTION_MASK}`,
    );
    expectOnlyMaskedValues(redacted);
  });

  it('keeps a bare flag bare, an empty value empty, and masks a repeat per occurrence', () => {
    const redacted = redactUrl('/api/p?flag&empty=&x=1&x=2');
    expect(redacted).toBe(`/api/p?flag&empty=&x=${REDACTION_MASK}&x=${REDACTION_MASK}`);
    expect(queryPairsOf(redacted)).toEqual([
      ['flag', undefined],
      ['empty', ''],
      ['x', REDACTION_MASK],
      ['x', REDACTION_MASK],
    ]);
    expectOnlyMaskedValues(redacted);
  });

  it('returns a URL with no query unchanged, modulo path scrubbing', () => {
    expect(redactUrl('https://api.example.test/v1/products')).toBe(
      'https://api.example.test/v1/products',
    );
    expect(redactUrl('/only/path')).toBe('/only/path');
    expect(redactUrl('https://api.example.test')).toBe('https://api.example.test');
    expect(redactUrl('/')).toBe('/');
  });

  it('masks the query of an absolute URL whose path is empty', () => {
    expect(redactUrl('https://api.example.test?slug=x')).toBe(
      `https://api.example.test?slug=${REDACTION_MASK}`,
    );
  });

  it('replaces userinfo with the marker, keeping the @ and the rest of the authority', () => {
    // The topology stays visible: which host and port were reached, and that a
    // credential was present, without the credential itself.
    const redacted = redactUrl(USERINFO_URL);
    expect(redacted).toBe(REDACTED_USERINFO_URL);
    expect(redacted).toContain(`${REDACTION_MARKER}@`);
    expect(redacted).toContain('db.example.test:5432/app');
    expect(redacted).not.toContain('demo');
  });

  it("produces exactly the shape rules.ts's connection-string rule produces", () => {
    // Two handlers, one output shape: a URL redacted here and a connection
    // string scrubbed by content must look identical, or the same value stored
    // under two different attribute keys would read as two different values.
    expect(redactUrl(USERINFO_URL)).toBe(scrub(USERINFO_URL));
  });

  it('replaces userinfo the content scrubber alone would miss', () => {
    // `scrub`'s rule is anchored on `scheme://`, so a protocol-relative URL
    // slips past it; positional knowledge is exactly what this handler adds.
    expect(redactUrl(PROTOCOL_RELATIVE_USERINFO_URL)).toBe(
      `//${REDACTION_MARKER}@host.example.test/p`,
    );
    expect(scrub(PROTOCOL_RELATIVE_USERINFO_URL)).toBe(PROTOCOL_RELATIVE_USERINFO_URL);
  });

  it('preserves an empty userinfo, which hides nothing', () => {
    expect(redactUrl('//@host/p')).toBe('//@host/p');
  });

  it('masks a non-empty fragment and preserves an empty one', () => {
    // Client-side routing state, and occasionally an implicit-flow credential,
    // live in the fragment.
    expect(redactUrl('https://h.test/p#section')).toBe(`https://h.test/p#${REDACTION_MASK}`);
    expect(redactUrl('#section')).toBe(`#${REDACTION_MASK}`);
    expect(redactUrl('/p#')).toBe('/p#');
    expect(redactUrl('#')).toBe('#');
  });

  it('masks a fragment whole, including a query inside it', () => {
    expect(redactUrl('https://h.test/p#/route?x=1')).toBe(`https://h.test/p#${REDACTION_MASK}`);
  });

  it('scrubs a credential-shaped path segment while the path structure survives', () => {
    const redacted = redactUrl(`https://h.test/reset/${PROVIDER_SHAPED}/done?a=1`);
    expect(redacted).toBe(`https://h.test/reset/${REDACTION_MARKER}/done?a=${REDACTION_MASK}`);
    expect(redacted).not.toContain(PROVIDER_SHAPED);
    expect(redacted).not.toContain(PROVIDER_PREFIX);
    expect(redacted).toContain('/reset/');
    expect(redacted).toContain('/done');
  });

  it('scrubs a value with no URL structure rather than returning it raw', () => {
    // Nothing to mask positionally, but the content rules still apply.
    expect(redactUrl('not a url with spaces')).toBe(scrub('not a url with spaces'));
    expect(redactUrl(PROVIDER_SHAPED)).toBe(REDACTION_MARKER);
  });

  it('returns the empty string for the empty string', () => {
    expect(redactUrl('')).toBe('');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Bounds and robustness
 * ---------------------------------------------------------------------------
 */

describe('redactUrl bounds the work it does and the text it returns', () => {
  it('caps the query at MAX_QUERY_PAIRS and marks the remainder', () => {
    const pairs = Array.from(
      { length: MAX_QUERY_PAIRS + 40 },
      (_, index) => `k${String(index)}=v${String(index)}`,
    );
    // A value planted past the cap must not survive: pairs beyond it are
    // dropped, never passed through unexamined.
    const plantedIndex = MAX_QUERY_PAIRS + 20;
    pairs[plantedIndex] = `planted=${PROVIDER_SHAPED}`;
    const redacted = redactUrl(`/api/p?${pairs.join('&')}#frag`);

    const rendered = queryPairsOf(redacted);
    expect(rendered).toHaveLength(MAX_QUERY_PAIRS);
    expect(rendered.at(-1)).toEqual([REDACTION_MARKER, undefined]);
    expect(rendered.slice(0, 3)).toEqual([
      ['k0', REDACTION_MASK],
      ['k1', REDACTION_MASK],
      ['k2', REDACTION_MASK],
    ]);
    expect(redacted).not.toContain('planted');
    expect(redacted).not.toContain(PROVIDER_SHAPED);
    // The fragment sits past the cut, so reporting it would report state that
    // was never examined.
    expect(redacted).not.toContain('#');
    expect(redacted.startsWith('/api/p?k0=')).toBe(true);
    expect(redactUrl(redacted)).toBe(redacted);
    expectOnlyMaskedValues(redacted);
  });

  it('leaves an input of exactly MAX_SCAN_LENGTH unmarked', () => {
    const prefix = 'https://h.test/p?a=';
    const atBound = prefix + 'x'.repeat(MAX_SCAN_LENGTH - prefix.length);
    expect(atBound).toHaveLength(MAX_SCAN_LENGTH);
    expect(redactUrl(atBound)).toBe(`https://h.test/p?a=${REDACTION_MASK}`);
  });

  it('marks an input one character past MAX_SCAN_LENGTH', () => {
    const prefix = 'https://h.test/p?a=';
    const pastBound = prefix + 'x'.repeat(MAX_SCAN_LENGTH - prefix.length + 1);
    const redacted = redactUrl(pastBound);
    expect(redacted).toBe(`https://h.test/p?a=${REDACTION_MASK}&${REDACTION_MARKER}`);
    expect(redactUrl(redacted)).toBe(redacted);
  });

  it('returns no unscanned tail for an input far beyond the scan window', () => {
    // The credential sits past the window; the tail must be replaced, not
    // emitted unexamined.
    const value = `https://h.test/${'a'.repeat(20_000)}/${PROVIDER_SHAPED}`;
    const redacted = redactUrl(value);
    expect(redacted.length).toBeLessThanOrEqual(MAX_SCAN_LENGTH);
    expect(redacted.length).toBeLessThan(value.length);
    expect(redacted).not.toContain(PROVIDER_SHAPED);
    expect(redacted).not.toContain(PROVIDER_PREFIX);
    expect(redacted.startsWith('https://h.test/aaa')).toBe(true);
    expect(redacted.endsWith(`?${REDACTION_MARKER}`)).toBe(true);
    expect(redactUrl(redacted)).toBe(redacted);
  });

  it('cuts between characters, never inside one, when the boundary lands on a surrogate pair', () => {
    // A captured event is JSON-encoded and posted to the service, so a cut that
    // left a lone surrogate behind would produce a body that is not valid
    // UTF-8. `encodeURIComponent` is the probe: it throws on exactly that.
    const value = `https://h.test/${'\u{1F600}'.repeat(9_000)}`;
    const redacted = redactUrl(value);
    expect(() => encodeURIComponent(redacted)).not.toThrow();
    expect(redacted.length).toBeLessThanOrEqual(MAX_SCAN_LENGTH);
    expect(redacted).toContain('\u{1F600}');
    expect(redacted.endsWith(`?${REDACTION_MARKER}`)).toBe(true);
    expect(redactUrl(redacted)).toBe(redacted);
  });

  it('cuts an oversized path at its own budget and marks the cut', () => {
    const redacted = redactUrl(`/${'a/'.repeat(5_000)}`);
    expect(redacted.length).toBeLessThanOrEqual(PATH_BUDGET);
    expect(redacted.startsWith('/a/a/')).toBe(true);
    expect(redacted.endsWith(REDACTION_MARKER)).toBe(true);
    expect(redactUrl(redacted)).toBe(redacted);
  });

  it('drops an authority too long to be an authority', () => {
    // A cut authority could strip the `@` that makes a credential
    // recognisable, so the whole authority goes and the result re-parses to
    // itself.
    const redacted = redactUrl(`https://${'h'.repeat(600)}/p?a=1`);
    expect(redacted).toBe(`https://${REDACTION_MARKER}`);
    expect(redactUrl(redacted)).toBe(redacted);
  });

  it('never throws on garbage and still returns pattern-cleaned text', () => {
    const inputs = [
      '?',
      '#',
      '??',
      '/p??',
      '//',
      '://',
      '\u0000\u0001\uFFFD binary?\u0007#x',
      '\ud800',
      `${'/very'.repeat(400)}/deep`,
      `junk ${PROVIDER_SHAPED} junk`,
      `/p?a=${PROVIDER_SHAPED}`,
    ];
    for (const input of inputs) {
      expect(() => redactUrl(input)).not.toThrow();
      const redacted = redactUrl(input);
      expect(typeof redacted).toBe('string');
      expect(redacted).not.toContain(PROVIDER_SHAPED);
      expect(redactUrl(redacted)).toBe(redacted);
    }
    // A lone delimiter is structure with nothing in it, and comes back as sent.
    expect(redactUrl('?')).toBe('?');
    expect(redactUrl('#')).toBe('#');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Properties
 * ---------------------------------------------------------------------------
 */

describe('redactUrl is idempotent', () => {
  // Redaction runs at ingest and again on the outbound path, so a value is
  // routinely redacted twice. Every treatment must be a fixed point: `?` must
  // not become `??` or `%3F`, a replaced userinfo must not be replaced again,
  // and a marked cut must survive re-parsing.
  for (const { label, value } of [...URL_FIXTURES, ...REDACTED_FIXTURES]) {
    it(label, () => {
      const once = redactUrl(value);
      expect(redactUrl(once)).toBe(once);
      expectOnlyMaskedValues(once);
    });
  }

  it('does not re-mask an already masked value, fragment or userinfo', () => {
    expect(redactUrl(`/api/p?a=${REDACTION_MASK}`)).toBe(`/api/p?a=${REDACTION_MASK}`);
    expect(redactUrl(`/p#${REDACTION_MASK}`)).toBe(`/p#${REDACTION_MASK}`);
    expect(redactUrl(REDACTED_USERINFO_URL)).toBe(REDACTED_USERINFO_URL);
    // In particular the mask is never percent-encoded on a second pass.
    expect(redactUrl(`/api/p?a=${REDACTION_MASK}`)).not.toContain('%3F');
  });
});

describe('the module is pure', () => {
  it('returns the same output for repeated calls', () => {
    for (const { value } of URL_FIXTURES) {
      expect(redactUrl(value)).toBe(redactUrl(value));
      expect(parseUrlParts(value)).toEqual(parseUrlParts(value));
    }
  });

  it('does not mutate the parts object it is handed', () => {
    const parts = parseUrlParts('https://h.test:8443/p?a=1#f');
    const before = JSON.stringify(parts);
    formatUrlParts(parts);
    expect(JSON.stringify(parts)).toBe(before);
  });

  it('returns fresh containers the caller may mutate without affecting later calls', () => {
    // No mutable module state: two calls must not share an array, or a caller
    // that filters its pairs would corrupt the next event's decomposition.
    const first = parseQueryPairs('a=1&b=2');
    first.push(['injected', 'x']);
    expect(parseQueryPairs('a=1&b=2')).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);

    const parts = parseUrlParts('/p?a=1');
    parts.path = '/mutated';
    expect(parseUrlParts('/p?a=1').path).toBe('/p');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Attribute-key dispatch
 * ---------------------------------------------------------------------------
 */

describe('isUrlAttributeKey', () => {
  it('accepts every declared URL attribute key', () => {
    for (const key of URL_ATTRIBUTE_KEYS) {
      expect(isUrlAttributeKey(key)).toBe(true);
    }
    // `url` is the key the fetch attribute vocabulary declares; the others are
    // the OpenTelemetry spellings that arrive from the Node preload.
    expect(URL_ATTRIBUTE_KEYS).toContain('url');
  });

  it('accepts the conventional dotted and camelCase suffixes', () => {
    for (const key of ['url', 'http.url', 'http.target', 'target', 'someUrl', 'a.b.url']) {
      expect(isUrlAttributeKey(key)).toBe(true);
    }
  });

  it('rejects keys whose values are not URLs', () => {
    // Over-matching is the safe direction — a non-URL value reaching redactUrl
    // is scrubbed by content — but these keys carry values the panel needs
    // intact, and `request_key` in particular must survive redaction.
    for (const key of ['db.statement', 'component', 'initiator', 'request_key']) {
      expect(isUrlAttributeKey(key)).toBe(false);
    }
  });

  it('is case-sensitive about the camelCase suffix, so an ordinary word is not a URL key', () => {
    expect(isUrlAttributeKey('curl')).toBe(false);
    expect(isUrlAttributeKey('documentUrl')).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Cross-checkpoint: the condition the outbound guard enforces
 * ---------------------------------------------------------------------------
 */

describe('no query parameter value survives redaction', () => {
  // The outbound redaction guard rejects a prompt payload in which a URL still
  // carries a query value, and it accepts a `?`-masked URL. These cases assert
  // the same condition at the source: after masking, no value appears anywhere
  // in the string, while every key does.
  const cases: readonly UrlFixture[] = [
    { label: 'origin-relative with two values', value: '/api/prices?productId=QQZZ7&window=WWXX9' },
    {
      label: 'absolute with a fragment',
      value: 'https://api.example.test/v1/search?term=ZZTOP42&cursor=YYKK13#anchorVVBB',
    },
    { label: 'an escaped value', value: '/api/users?email=someone%40example.test' },
    { label: 'a credential-shaped value', value: `/api/callback?state=${PROVIDER_SHAPED}` },
  ];

  for (const { label, value } of cases) {
    it(label, () => {
      const redacted = redactUrl(value);
      for (const [key, raw] of queryPairsOf(value)) {
        expect(redacted).toContain(key);
        if (raw !== undefined && raw.length > 0) {
          expect(redacted).not.toContain(raw);
        }
      }
      const fragment = parseUrlParts(value).fragment;
      if (fragment !== undefined && fragment.length > 0) {
        expect(redacted).not.toContain(fragment);
      }
      expectOnlyMaskedValues(redacted);
    });
  }
});
