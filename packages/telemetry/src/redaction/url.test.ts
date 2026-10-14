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
 * from fragments at run time ({@link USERINFO_URL}, {@link PROVIDER_SHAPED},
 * {@link JOSE_SHAPED}, {@link CREDENTIALED_DSN}), which keeps this file free of
 * a contiguous secret-shaped literal while the values the functions see are
 * exactly the ones the patterns match. The
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
  redactEmbeddedUrls,
  redactQueryString,
  redactStackText,
  redactStackUrls,
  redactTextUrls,
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

/**
 * JOSE header prefix, split so this tracked file never contains it contiguously
 * (see the module documentation).
 */
const JOSE_PREFIX = 'ey' + 'J';

/**
 * A value `scrub`'s `jwt` rule matches: the header prefix and two further
 * base64url segments, each a zero-entropy run of one character.
 */
const JOSE_SHAPED = [JOSE_PREFIX + 'B'.repeat(20), 'C'.repeat(20), 'D'.repeat(20)].join('.');

/**
 * The scheme of {@link CREDENTIALED_DSN}. Redaction keeps it — it names the
 * tier that was called and is not secret — and so does a cut that lands inside
 * the credential, which is why it is named rather than inlined.
 */
const DSN_SCHEME = ['postgresql', '://'].join('');

/** The user part of {@link DSN_SECRET}, asserted absent on its own. */
const DSN_USER = 'demo';

/**
 * The userinfo of {@link CREDENTIALED_DSN}: the part no output may carry, in
 * whole or in part.
 */
const DSN_SECRET = [DSN_USER, ':', 'P'.repeat(24)].join('');

/**
 * A credentialed connection string whose userinfo is long enough to straddle a
 * bound, assembled from fragments.
 *
 * The `connection-string` rule needs the terminating `@` to match at all, so
 * this is the fixture that shows what a cut before the `@` costs: the rule sees
 * nothing, and the user and the head of the password are left in plain text.
 */
const CREDENTIALED_DSN = [DSN_SCHEME, DSN_SECRET, '@', 'db.example.test/app'].join('');

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

/**
 * The characters that end a URL run in text — whitespace, quotes, angle
 * brackets and the backtick, the delimiters `./url.ts`'s text patterns stop at.
 *
 * Splitting redacted text on them yields the runs {@link expectOnlyMaskedValues}
 * can judge one at a time, without a selector's closing quote being read as
 * part of the last value.
 */
const URL_RUN_DELIMITERS = /[\s"'<>`]+/;

/**
 * Width of the sliding window the crossing-bound cases compare against.
 *
 * A `toContain` on the whole credential proves nothing about a cut, because
 * what a plain slice leaves behind is the credential's *head* and the whole
 * value never matches that. Eight code units is short enough to catch a cut
 * anywhere inside a credential and long enough that it cannot collide with the
 * single-character padding those fixtures are built from.
 */
const CREDENTIAL_WINDOW = 8;

/**
 * Asserts that no {@link CREDENTIAL_WINDOW}-wide window of `credential` appears
 * in `redacted` — the assertion a cut through the middle of a credential fails
 * and a cut moved back to its start passes.
 */
function expectNoCredentialWindow(redacted: string, credential: string): void {
  for (let start = 0; start + CREDENTIAL_WINDOW <= credential.length; start += 1) {
    expect(redacted).not.toContain(credential.slice(start, start + CREDENTIAL_WINDOW));
  }
}

/**
 * Asserts that `value` really does place `credential` across `bound`.
 *
 * Without it, a change to a fixture, to `MAX_SCAN_LENGTH` or to the path budget
 * could move the credential wholly to one side of the cut, and the case would
 * keep passing while asserting nothing at all.
 */
function expectStraddles(value: string, credential: string, bound: number): void {
  const start = value.indexOf(credential);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(start).toBeLessThan(bound);
  expect(start + credential.length).toBeGreaterThan(bound);
}

/**
 * Asserts everything a truncating cut owes its caller: the result is within the
 * module's output bound, it says that it was cut, it carries no part of the
 * credential that straddled the cut nor the prefix that would reveal it, every
 * query value is still masked, and it is a fixed point.
 *
 * @param redacted Output of {@link redactUrl} for a crossing-bound fixture.
 * @param credential The secret text the cut ran through.
 * @param prefix The shorter fragment that identifies the credential's class
 * and is therefore the leak a window comparison alone can miss.
 */
function expectCutClear(redacted: string, credential: string, prefix: string): void {
  expect(redacted.length).toBeLessThanOrEqual(MAX_SCAN_LENGTH);
  expect(redacted.endsWith(REDACTION_MARKER)).toBe(true);
  expect(redacted).not.toContain(prefix);
  expectNoCredentialWindow(redacted, credential);
  expectOnlyMaskedValues(redacted);
  expect(redactUrl(redacted)).toBe(redacted);
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
 * Credentials that straddle a bound
 *
 * `./url.ts` cuts in two places: once before parsing, at MAX_SCAN_LENGTH, and
 * once per component, at the path budget. Both cuts land in text no pattern has
 * run over yet, and every rule identifies a credential by a prefix followed by
 * a run — so a plain slice through the run keeps the prefix and the first
 * characters of the secret while discarding exactly the part that would have
 * matched. `scrub` then has nothing left to recognise, and a query key or a path
 * segment is stored precisely as it is scrubbed.
 *
 * The head that escapes is deliberately short in every case below: while it is
 * still long enough to satisfy the rule's identifying minimum, `scrub` matches
 * it and redacts it anyway, so the leak only exists in the last few characters
 * before the bound. That is why each fixture positions the credential to begin
 * a handful of code units before the cut rather than halfway across it, and why
 * {@link expectStraddles} pins that placement.
 * ---------------------------------------------------------------------------
 */

describe('redactUrl cuts clear of a credential that straddles a bound', () => {
  /** Padding no rule matches and whose windows no credential fixture shares. */
  const padding = 'x';

  /** Where the pre-parse cut falls. */
  const scanCut = MAX_SCAN_LENGTH;

  /**
   * Where the path budget's cut falls: the budget less the marker the cut
   * appends, which is the position a credential has to straddle to be split.
   */
  const pathCut = PATH_BUDGET - REDACTION_MARKER.length;

  /**
   * A URL whose final query segment is `credential`, positioned so that segment
   * begins `headroom` code units before {@link scanCut}.
   *
   * A query *key* is the sharpest case in the module: values are masked whatever
   * they contain, so only a key — or a bare flag, which is what this builds —
   * carries text through `scrub` into the stored URL.
   */
  function queryKeyStraddling(credential: string, headroom: number): string {
    const prefix = '/p?a=';
    const pad = scanCut - headroom - prefix.length - 1;
    return `${prefix}${padding.repeat(pad)}&${credential}`;
  }

  /**
   * A URL whose final path segment is `credential`, positioned so that segment
   * begins `headroom` code units before `cut`, with `suffix` appended after it.
   */
  function pathSegmentStraddling(
    credential: string,
    headroom: number,
    cut: number,
    suffix: string,
  ): string {
    const prefix = '/reset/';
    const pad = cut - headroom - prefix.length - 1;
    return `${prefix}${padding.repeat(pad)}/${credential}${suffix}`;
  }

  it('moves the cut to the start of a provider key crossing the scan bound in a query key', () => {
    // Eleven token characters is fewer than the rule's identifying minimum of
    // sixteen, so a plain slice leaves a head `scrub` cannot match and the
    // prefix is stored as a query key.
    const value = queryKeyStraddling(PROVIDER_SHAPED, PROVIDER_PREFIX.length + 11);
    expectStraddles(value, PROVIDER_SHAPED, scanCut);

    const redacted = redactUrl(value);
    expect(redacted).toBe(`/p?a=${REDACTION_MASK}&${REDACTION_MARKER}`);
    expectCutClear(redacted, PROVIDER_SHAPED, PROVIDER_PREFIX);
  });

  it('moves the cut to the start of a JOSE token crossing the scan bound in a query key', () => {
    // The `jwt` rule needs a payload segment, so a cut a few characters into
    // the header leaves `eyJ` plus a short run: shaped like a token, matched by
    // nothing.
    const value = queryKeyStraddling(JOSE_SHAPED, JOSE_PREFIX.length + 5);
    expectStraddles(value, JOSE_SHAPED, scanCut);

    const redacted = redactUrl(value);
    expect(redacted).toBe(`/p?a=${REDACTION_MASK}&${REDACTION_MARKER}`);
    expectCutClear(redacted, JOSE_SHAPED, JOSE_PREFIX);
  });

  it('keeps only the scheme of a connection string crossing the scan bound in a query key', () => {
    // The `connection-string` rule is anchored on the terminating `@`, which
    // here sits past the bound, so a plain slice stores the user and the head
    // of the password verbatim. The cut keeps `scheme://` — the same
    // diagnostic prefix the replacement keeps — and nothing after it.
    const value = queryKeyStraddling(CREDENTIALED_DSN, DSN_SCHEME.length + 10);
    expectStraddles(value, CREDENTIALED_DSN, scanCut);

    const redacted = redactUrl(value);
    expect(redacted).toBe(`/p?a=${REDACTION_MASK}&${DSN_SCHEME}&${REDACTION_MARKER}`);
    expect(redacted).toContain(DSN_SCHEME);
    expectCutClear(redacted, DSN_SECRET, DSN_USER);
  });

  it('carries no provider key head when one crosses the scan bound in a path segment', () => {
    // In a path the two bounds compound: a path long enough to reach the scan
    // bound necessarily exceeds the path budget, so the budget's cut removes
    // the region the scan bound cut. The case is here because the guarantee
    // rests on that composition, and neither bound may be changed without it
    // still holding.
    const value = pathSegmentStraddling(PROVIDER_SHAPED, PROVIDER_PREFIX.length + 11, scanCut, '');
    expectStraddles(value, PROVIDER_SHAPED, scanCut);

    const redacted = redactUrl(value);
    expect(redacted.startsWith(`/reset/${padding.repeat(3)}`)).toBe(true);
    expect(redacted).toContain(`?${REDACTION_MARKER}`);
    expectCutClear(redacted, PROVIDER_SHAPED, PROVIDER_PREFIX);
  });

  it('carries no JOSE token head when one crosses the scan bound in a path segment', () => {
    // The same composition as the case above, for the other class of
    // credential a reset or download link realistically carries in its path.
    const value = pathSegmentStraddling(JOSE_SHAPED, JOSE_PREFIX.length + 5, scanCut, '');
    expectStraddles(value, JOSE_SHAPED, scanCut);

    const redacted = redactUrl(value);
    expect(redacted.startsWith(`/reset/${padding.repeat(3)}`)).toBe(true);
    expect(redacted).toContain(`?${REDACTION_MARKER}`);
    expectCutClear(redacted, JOSE_SHAPED, JOSE_PREFIX);
  });

  it('cuts clear of a provider key crossing the path budget', () => {
    // The second cut site. `boundedScrub` scrubs before it cuts, so here the
    // credential is already replaced by the time the budget applies — the
    // budget's own cut lands inside a `[redacted]`, not inside a secret. This
    // case pins that outcome so the *composite* stays honest: reverse those two
    // statements and it is the boundary-aware cut, not the scrub, that keeps it
    // green, which is the whole reason both cut sites use the same primitive.
    const value = pathSegmentStraddling(
      PROVIDER_SHAPED,
      PROVIDER_PREFIX.length + 11,
      pathCut,
      `/done/${padding.repeat(200)}`,
    );
    expectStraddles(value, PROVIDER_SHAPED, pathCut);

    const redacted = redactUrl(value);
    expect(redacted.length).toBeLessThanOrEqual(PATH_BUDGET);
    expect(redacted.startsWith(`/reset/${padding.repeat(3)}`)).toBe(true);
    expectCutClear(redacted, PROVIDER_SHAPED, PROVIDER_PREFIX);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Untrusted input
 * ---------------------------------------------------------------------------
 */

/** One untrusted-input case: what arrives, and what both entry points return. */
interface UntrustedFixture {
  readonly label: string;
  readonly value: unknown;
  /**
   * The text both entry points produce. Established by running them, not
   * restated from the coercion policy — a fixture that merely repeats the
   * policy cannot notice the policy changing.
   */
  readonly expected: string;
}

/**
 * Every type a captured URL or query string actually arrives as.
 *
 * The call sites in `redactor.ts` are typed, but the values reaching them come
 * out of `JSON.parse` on a posted event body and out of OpenTelemetry span
 * attributes declared `unknown`, neither of which checks anything. A privacy
 * boundary that threw there would lose the whole batch it was redacting, and one
 * that stringified anything at all could run page-supplied code through a
 * `toString` getter — which is why the last fixture's `toString` throws.
 *
 * A scalar keeps its text: it is evidence a panel is built from, it is no
 * credential shape this layer knows, and erasing it would hide the producer bug
 * that sent a number where a URL belongs. Anything else becomes the marker, so
 * the event still records that something was there.
 */
const UNTRUSTED_FIXTURES: readonly UntrustedFixture[] = [
  { label: 'null', value: null, expected: REDACTION_MARKER },
  { label: 'undefined', value: undefined, expected: REDACTION_MARKER },
  { label: 'a number', value: 42, expected: '42' },
  { label: 'zero, falsy but still evidence', value: 0, expected: '0' },
  { label: 'a negative non-integer number', value: -1.5, expected: '-1.5' },
  {
    label: 'NaN, which is information rather than a credential',
    value: Number.NaN,
    expected: 'NaN',
  },
  { label: 'a boolean', value: true, expected: 'true' },
  { label: 'a bigint', value: 42n, expected: '42' },
  { label: 'an object', value: { url: '/api/p?a=1' }, expected: REDACTION_MARKER },
  { label: 'an array', value: ['/api/p?a=1'], expected: REDACTION_MARKER },
  { label: 'a function', value: () => '/api/p?a=1', expected: REDACTION_MARKER },
  { label: 'a symbol', value: Symbol('a symbol description'), expected: REDACTION_MARKER },
  { label: 'a Date', value: new Date(0), expected: REDACTION_MARKER },
  {
    label: 'an object whose toString throws, which must never be called',
    value: {
      toString(): string {
        throw new Error('page-supplied code must never run inside redaction');
      },
    },
    expected: REDACTION_MARKER,
  },
];

describe('the redaction entry points accept untrusted input of any type', () => {
  for (const { label, value, expected } of UNTRUSTED_FIXTURES) {
    it(`redactUrl: ${label}`, () => {
      expect(() => redactUrl(value)).not.toThrow();
      const redacted = redactUrl(value);
      expect(redacted).toBe(expected);
      // Redaction runs at ingest and again on the outbound path, so the second
      // pass sees the first pass's output — a string by then, whatever arrived.
      expect(redactUrl(redacted)).toBe(redacted);
      expectOnlyMaskedValues(redacted);
    });

    it(`redactQueryString: ${label}`, () => {
      expect(() => redactQueryString(value)).not.toThrow();
      const masked = redactQueryString(value);
      expect(masked).toBe(expected);
      expect(redactQueryString(masked)).toBe(masked);
    });

    it(`redactStackUrls: ${label}`, () => {
      expect(() => redactStackUrls(value)).not.toThrow();
      const masked = redactStackUrls(value);
      // Coercion is shared with the other entry points; masking is positional,
      // and none of these coerced values holds an `http` URL, so the coerced
      // text is the whole result.
      expect(masked).toBe(expected);
      expect(redactStackUrls(masked)).toBe(masked);
    });
  }

  it('reports a value it could not examine rather than erasing it', () => {
    // An attribute that silently became `""` would read as "no URL was
    // captured", which is a different fact from "a URL was captured and could
    // not be examined" — and the second is the one a developer needs.
    expect(redactUrl(null)).toBe(REDACTION_MARKER);
    expect(redactUrl(null)).not.toBe('');
    expect(redactQueryString(undefined)).toBe(REDACTION_MARKER);
    expect(redactQueryString(undefined)).not.toBe('');
  });

  it('still returns the empty string for the empty string, which is not an error', () => {
    // The empty-string early return sits after coercion, so it keeps its
    // meaning: nothing was sent, and nothing is reported.
    expect(redactUrl('')).toBe('');
    expect(redactQueryString('')).toBe('');
  });

  it('masks a query value even when the query arrived as a non-string', () => {
    // Coercion happens before masking, not instead of it: a coerced scalar is
    // still parsed and masked like any other query.
    expect(redactQueryString('a=1')).toBe(`a=${REDACTION_MASK}`);
    expect(redactQueryString(123)).toBe('123');
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
    // `url` is the key the fetch attribute vocabulary declares; `http.url`,
    // `http.target` and `target` are the OpenTelemetry spellings that arrive
    // from the Node preload.
    expect(URL_ATTRIBUTE_KEYS).toContain('url');
    // `error.source` is the script or resource URL an `error` event carries,
    // recorded verbatim by `../browser/errors.ts`. It ends in `source`, so no
    // suffix rule reaches it and only membership masks its query values — the
    // spelling is the one `../schema/attributes.ts` declares in
    // `ERROR_ATTRIBUTE_KEYS`, a tie this file asserts because the module
    // deliberately imports nothing but `./rules.js`.
    expect(URL_ATTRIBUTE_KEYS).toContain('error.source');
    expect(isUrlAttributeKey('error.source')).toBe(true);
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
 * Stack text
 *
 * A captured stack is the one value that carries URLs *inside* other text, and
 * `./redactor.ts` exempts a request's `initiator` from the preview bound so the
 * whole of it travels. Masking a query parameter is positional, so `scrub` —
 * the only treatment stack text used to get — cannot touch it: every
 * expectation below therefore uses an ordinary identifier as the parameter
 * value, one no deny-list pattern matches, so nothing but this function can
 * make the assertion pass.
 * ---------------------------------------------------------------------------
 */

describe('redactStackUrls', () => {
  /** A dev-server chunk URL, which carries a cache-busting query. */
  const CHUNK_URL = 'http://127.0.0.1:20450/_next/static/chunks/alpha.js';

  /** An ordinary identifier: PII in a query string, invisible to `scrub`. */
  const IDENTIFIER = 'person' + '@example.test';

  it('masks the query of a frame URL and keeps the frame, position included', () => {
    // A dev-server chunk URL carries a cache-busting query, so this is the
    // common frame: the value goes, and the `:42:17` the runtime appended
    // stays, because AAP 0.4.2 resolves exactly that position back to source.
    expect(redactStackUrls(`    at send (${CHUNK_URL}?email=${IDENTIFIER}:42:17)`)).toBe(
      `    at send (${CHUNK_URL}?email=${REDACTION_MASK}:42:17)`,
    );
  });

  it('keeps the position of a bare frame and of the SpiderMonkey form', () => {
    expect(redactStackUrls(`    at ${CHUNK_URL}?email=${IDENTIFIER}:8:1`)).toBe(
      `    at ${CHUNK_URL}?email=${REDACTION_MASK}:8:1`,
    );
    expect(redactStackUrls(`send@${CHUNK_URL}?email=${IDENTIFIER}:8:1`)).toBe(
      `send@${CHUNK_URL}?email=${REDACTION_MASK}:8:1`,
    );
  });

  it('masks a fragment inside a frame and keeps the position', () => {
    expect(redactStackUrls(`    at boot (http://127.0.0.1:20450/app#${IDENTIFIER}:3:5)`)).toBe(
      `    at boot (http://127.0.0.1:20450/app#${REDACTION_MASK}:3:5)`,
    );
  });

  it('keeps the position of a frame whose URL has no query', () => {
    // The ordinary case, and the one that resolves to source: a frame with no
    // query comes back byte-identical, position included, so
    // `packages/code-analysis/src/source-map/resolver.ts` can still map it.
    const frame = '    at flush (http://127.0.0.1:20450/src/lib/alpha-client.ts:31:9)';

    expect(redactStackUrls(frame)).toBe(frame);
  });

  it('masks the position with the query when the text is not a frame', () => {
    // Outside a frame nothing licenses reading a trailing `:10:5` as a
    // position — `?v=1730:10:5` is equally "the value `1730:10:5`" — so the
    // whole run is masked and the digits go with the value.
    expect(redactStackUrls(`loaded ${CHUNK_URL}?v=1730:10:5 in 2ms`)).toBe(
      `loaded ${CHUNK_URL}?v=${REDACTION_MASK} in 2ms`,
    );
    // "look at" is not the frame token followed by a URL on this line, but it
    // is close enough to show which way the test cuts: the value is masked
    // either way, and only the position's fate differs.
    expect(redactStackUrls(`chunk ${CHUNK_URL}?v=1730:10:5`)).toBe(
      `chunk ${CHUNK_URL}?v=${REDACTION_MASK}`,
    );
  });

  it('masks userinfo inside a frame URL', () => {
    expect(
      redactStackUrls('at fetch (http://svc:' + 'e5'.repeat(6) + '@127.0.0.1:20450/p:1:1)'),
    ).toBe(`at fetch (http://${REDACTION_MARKER}@127.0.0.1:20450/p:1:1)`);
  });

  it('leaves a scheme it does not model exactly as the bundler wrote it', () => {
    // `webpack-internal:` and `turbopack:` identifiers are module paths with no
    // query, and the source-map resolver's own grammar is `http`/`https` only.
    const stack =
      'at commit (webpack-internal:///./src/lib/alpha-client.ts:7:11)\n' +
      '    at boot (turbopack:///[project]/src/main.ts:3:5)\n' +
      '    at run (file:///workspace/src/main.ts:9:1)';

    expect(redactStackUrls(stack)).toBe(stack);
  });

  it('leaves a stack of project-relative frames untouched', () => {
    const stack =
      'Error\n    at send (src/lib/alpha-client.ts:18:3)\n    at flush (src/lib/x.ts:31:9)';

    expect(redactStackUrls(stack)).toBe(stack);
  });

  it('masks every frame of a multi-frame stack and keeps their order', () => {
    const stack =
      'Error\n' +
      `    at a (${CHUNK_URL}?email=${IDENTIFIER}:1:1)\n` +
      `    at b (http://127.0.0.1:20450/beta.js?email=${IDENTIFIER}:2:2)`;

    const masked = redactStackUrls(stack);

    expect(masked).toBe(
      'Error\n' +
        `    at a (${CHUNK_URL}?email=${REDACTION_MASK}:1:1)\n` +
        `    at b (http://127.0.0.1:20450/beta.js?email=${REDACTION_MASK}:2:2)`,
    );
    expect(masked).not.toContain(IDENTIFIER);
    // The frame text itself is diagnostic evidence and survives whole.
    expect(masked.split('\n')).toHaveLength(3);
  });

  it('masks a quoted URL up to its closing quote, which ends the run', () => {
    expect(redactStackUrls(`loaded "${CHUNK_URL}?email=${IDENTIFIER}".`)).toBe(
      `loaded "${CHUNK_URL}?email=${REDACTION_MASK}".`,
    );
  });

  it('masks punctuation after a query with the value it may belong to', () => {
    // `)`, `]`, `;` and `.` are legal query-value characters, so outside a
    // frame's position nothing tells them apart from the last value: they go
    // with it rather than being handed back as sentence punctuation.
    expect(redactStackUrls(`[${CHUNK_URL}?email=${IDENTIFIER}]`)).toBe(
      `[${CHUNK_URL}?email=${REDACTION_MASK}`,
    );
    expect(redactStackUrls('https://x.test/reset?code=);')).toBe(
      `https://x.test/reset?code=${REDACTION_MASK}`,
    );
    expect(redactStackUrls('see https://x.test/a?b=1).')).toBe(
      `see https://x.test/a?b=${REDACTION_MASK}`,
    );
    expect(redactStackUrls(`(${CHUNK_URL}#${IDENTIFIER})`)).toBe(`(${CHUNK_URL}#${REDACTION_MASK}`);
    // A frame with no position gives nothing to separate its bracket from the
    // value either, so the bracket goes too.
    expect(redactStackUrls(`    at d (${CHUNK_URL}?v=abc)`)).toBe(
      `    at d (${CHUNK_URL}?v=${REDACTION_MASK}`,
    );
  });

  it('keeps the position and the closing bracket of a frame whose URL carries a query', () => {
    expect(redactStackUrls(`    at fn (${CHUNK_URL}?v=${IDENTIFIER}:10:5)`)).toBe(
      `    at fn (${CHUNK_URL}?v=${REDACTION_MASK}:10:5)`,
    );
    expect(redactStackUrls(`fn@${CHUNK_URL}?v=${IDENTIFIER}:10:5),`)).toBe(
      `fn@${CHUNK_URL}?v=${REDACTION_MASK}:10:5),`,
    );
  });

  it('keeps punctuation after a URL that carries no query and no fragment', () => {
    // Only the query and the fragment are ever masked, so peeling costs no
    // value here and the text comes back as it was.
    for (const text of [`see ${CHUNK_URL}.`, `(${CHUNK_URL})`, `[${CHUNK_URL}:4:2],`]) {
      expect(redactStackUrls(text), text).toBe(text);
    }
  });

  it('matches the scheme in any letter case', () => {
    expect(redactStackUrls(`HTTP://127.0.0.1:20450/a?email=${IDENTIFIER}`)).toBe(
      `HTTP://127.0.0.1:20450/a?email=${REDACTION_MASK}`,
    );
    expect(redactStackUrls(`    at fn (Https://h.test/a.js?v=${IDENTIFIER}:1:2)`)).toBe(
      `    at fn (Https://h.test/a.js?v=${REDACTION_MASK}:1:2)`,
    );
  });

  it('is idempotent', () => {
    for (const input of [
      `at a (${CHUNK_URL}?email=${IDENTIFIER}:1:1)`,
      `at b (http://127.0.0.1:20450/src/x.ts:9:2)`,
      `at c (${CHUNK_URL}?v=${REDACTION_MASK}:1:1)`,
      `at d (${CHUNK_URL}?v=${REDACTION_MASK})`,
      `loaded ${CHUNK_URL}?v=1730:10:5`,
      `send@${CHUNK_URL}?email=${IDENTIFIER}:8:1`,
      'at e (webpack-internal:///./src/x.ts:1:1)',
      `at f (${CHUNK_URL}?email=${IDENTIFIER.slice(0, 4)}${REDACTION_MARKER}`,
      `[${CHUNK_URL}?email=${IDENTIFIER}]`,
      'https://x.test/reset?code=);',
      'see https://x.test/a?b=1).',
      `    at fn (${CHUNK_URL}?v=${IDENTIFIER}:10:5)`,
      `    at d (${CHUNK_URL}?v=abc)`,
      `see ${CHUNK_URL}.`,
      `HTTP://127.0.0.1:20450/a?email=${IDENTIFIER}`,
      '',
    ]) {
      const once = redactStackUrls(input);
      expect(redactStackUrls(once)).toBe(once);
    }
  });

  it('keeps a marker `scrub` left inside a cut frame, on its own line', () => {
    // `./redactor.ts` scrubs before masking, and `scrub`'s own bound appends
    // the marker with nothing between it and the URL it cut. The marker is
    // this layer's token, so it survives — moved to its own line, where a
    // later pass cannot read it as query text.
    expect(redactStackUrls(`at a (${CHUNK_URL}?email=pers${REDACTION_MARKER}`)).toBe(
      `at a (${CHUNK_URL}?email=${REDACTION_MASK}\n${REDACTION_MARKER}`,
    );
  });

  it('bounds what it examines and reports the loss', () => {
    const frame = `at a (${CHUNK_URL}?email=${IDENTIFIER}:1:1)\n`;
    const long = frame.repeat(Math.ceil((MAX_SCAN_LENGTH * 2) / frame.length));

    const masked = redactStackUrls(long);

    expect(masked.length).toBeLessThanOrEqual(MAX_SCAN_LENGTH);
    // Reported on a line of its own, which is also what keeps the second pass
    // from reading the marker as part of the cut frame's URL.
    expect(masked.endsWith(`\n${REDACTION_MARKER}`)).toBe(true);
    // The bound must not become a way past the rule: nothing that was examined
    // kept its parameter value, and nothing past the bound was emitted at all.
    expect(masked).not.toContain(IDENTIFIER);
    expect(redactStackUrls(masked)).toBe(masked);
  });

  it('does not scrub by content, which is its caller`s job', () => {
    // `./redactor.ts` runs `scrub` first and then this function, in that order
    // (cutting before scrubbing can split a credential). Stating the division
    // here keeps a later change from making the two overlap silently.
    const credential = 'ey' + 'J0eXAiOiJKV1QifQ.' + 'c3'.repeat(12) + '.' + 'd4'.repeat(12);
    const line = `at send (src/lib/alpha-client.ts:18:3) token=${credential}`;

    expect(redactStackUrls(line)).toBe(line);
    expect(scrub(line)).not.toContain(credential);
  });
});

describe('redactTextUrls', () => {
  it('masks the query of a standalone absolute URL exactly as redactUrl does', () => {
    const link = 'http://127.0.0.1:3000/reset?coupon=QQZZ7&step=2#confirmVVBB';

    expect(redactTextUrls(link)).toBe(redactUrl(link));
    expect(redactTextUrls(link)).toBe('http://127.0.0.1:3000/reset?coupon=?&step=?#?');
  });

  it('masks an origin-relative query inside prose and keeps the sentence around it', () => {
    const text = 'Visit /reset?coupon=QQZZ7 now, or /orders?id=WWXX9.';

    // The full stop ends the last run, and a run is masked whole: `.` is a
    // legal value character, so it goes with the value it may belong to.
    expect(redactTextUrls(text)).toBe('Visit /reset?coupon=? now, or /orders?id=?');
  });

  it('masks a query inside an attribute selector and keeps the selector shape', () => {
    expect(redactTextUrls('main > a[href="/p?id=QQZZ7&ref=WWXX9"]')).toBe(
      'main > a[href="/p?id=?&ref=?"]',
    );
    expect(redactTextUrls("a[href='?page=QQZZ7']")).toBe("a[href='?page=?']");
  });

  it('masks bare relative and query-only references, and a fragment after them', () => {
    expect(redactTextUrls('see p?id=QQZZ7#sectionVVBB')).toBe('see p?id=?#?');
    expect(redactTextUrls('?token=QQZZ7&flag')).toBe('?token=?&flag');
    expect(redactTextUrls('/a?b=QQZZ7#')).toBe('/a?b=?#');
  });

  it('masks punctuation at the end of a query with the value it may belong to', () => {
    // Every one of these characters is legal inside a query value, so a run
    // that ends in them may end in data: `/reset?code=!!!!` carries `!!!!`.
    // The run is masked whole rather than guessed apart.
    const cases: readonly (readonly [string, string])[] = [
      ['/reset?code=!!!!', '/reset?code=?'],
      ['/reset?code=....', '/reset?code=?'],
      ['/reset?code=ZIP42!', '/reset?code=?'],
      ['See /p?id=7.', 'See /p?id=?'],
      ['(open /p?id=QQZZ7)', '(open /p?id=?'],
      ['Try /p?id=QQZZ7!', 'Try /p?id=?'],
      ['/p?a=QQZZ7; /q?b=WWXX9,', '/p?a=? /q?b=?'],
      ['https://x.test/reset?code=);', 'https://x.test/reset?code=?'],
      ['https://x.test/a?b=1).', 'https://x.test/a?b=?'],
      ['[https://x.test/p?email=QQZZ7]', '[https://x.test/p?email=?'],
      ['a[href="/reset?code=!!!!"]', 'a[href="/reset?code=?"]'],
    ];

    for (const [text, expected] of cases) {
      const redacted = redactTextUrls(text);

      expect(redacted, text).toBe(expected);
      expect(redactTextUrls(redacted), text).toBe(redacted);
      for (const token of redacted.split(URL_RUN_DELIMITERS)) {
        expectOnlyMaskedValues(token);
      }
    }
  });

  it('masks a fragment after an origin-relative query that holds no pair', () => {
    // Everything `redactEmbeddedUrls` masks, this masks too.
    expect(redactTextUrls('see /p?flag#sectionVVBB')).toBe('see /p?flag#?');
    expect(redactTextUrls('see /p?flag#sectionVVBB')).toBe(
      redactEmbeddedUrls('see /p?flag#sectionVVBB'),
    );
  });

  it('masks everything redactEmbeddedUrls masks, and bare and quoted references besides', () => {
    for (const text of [
      'GET /reset?code=ZIP42 then https://x.test/a?b=1#top',
      '(see /reset?code=ZIP42).',
      'line\n/p?a=1&b=&c#frag',
      'p?id=QQZZ7 and ?id=WWXX9',
      "fetch('/api/x?a=QQZZ7')",
    ]) {
      const embedded = redactEmbeddedUrls(text);
      const masked = redactTextUrls(text);

      // Applying the wider pass to the narrower one's output changes nothing
      // the narrower one already decided, and reaches the same text.
      expect(redactTextUrls(embedded), text).toBe(masked);
      for (const token of masked.split(URL_RUN_DELIMITERS)) {
        expectOnlyMaskedValues(token);
      }
    }
    expect(redactTextUrls("fetch('/api/x?a=QQZZ7')")).toBe("fetch('/api/x?a=?')");
    expect(redactTextUrls('p?id=QQZZ7 and ?id=WWXX9')).toBe('p?id=? and ?id=?');
  });

  it('leaves text with no name=value pair after a ? unchanged', () => {
    for (const text of ['Why? Because.', 'Save changes?', '?flag', 'a?b', 'x = y ? 1 : 2', '']) {
      expect(redactTextUrls(text), text).toBe(text);
    }
  });

  it('anchors at the ? that opens the pairs', () => {
    expect(redactTextUrls('a?b?c=QQZZ7')).toBe('a?b?c=?');
    expect(redactTextUrls('Why? a=QQZZ7')).toBe('Why? a=QQZZ7');
  });

  it('leaves no query value anywhere in the text, for every token the guard examines', () => {
    const text =
      'Links: https://api.example.test/v1/search?term=ZZTOP42&cursor=YYKK13 and /api/users?email=someone%40example.test';
    const redacted = redactTextUrls(text);

    for (const raw of ['ZZTOP42', 'YYKK13', 'someone%40example.test']) {
      expect(redacted).not.toContain(raw);
    }
    for (const token of redacted.split(/\s+/)) {
      expectOnlyMaskedValues(token);
    }
  });

  it('is idempotent', () => {
    for (const text of [
      'Visit /reset?coupon=QQZZ7 and https://x.test/a?b=1#top.',
      'a[href="/p?id=QQZZ7"]',
      '?token=QQZZ7&flag',
      '/reset?code=!!!!',
      '/reset?code=....',
      '/reset?code=ZIP42!',
      'https://x.test/reset?code=);',
      'https://x.test/a?b=1).',
      '[https://x.test/p?email=QQZZ7]',
      '(open /p?id=QQZZ7)',
      'see /p?flag#sectionVVBB',
      `    at fn (https://x.test/a.js?v=QQZZ7:10:5)`,
    ]) {
      const once = redactTextUrls(text);
      expect(redactTextUrls(once), text).toBe(once);
    }
  });

  it('masks userinfo of an embedded absolute URL, like the stack pass it builds on', () => {
    const redacted = redactTextUrls(
      `see ${['http', '://', 'demo', ':', 'pw', '@', 'host.example.test/p'].join('')}`,
    );

    expect(redacted).toBe(`see http://${REDACTION_MARKER}@host.example.test/p`);
  });

  it('bounds its output and reports the loss on a line of its own', () => {
    const long = '/p?id=QQZZ7 '.repeat(Math.ceil((MAX_SCAN_LENGTH * 2) / 12));
    const redacted = redactTextUrls(long);

    expect(redacted.length).toBeLessThanOrEqual(MAX_SCAN_LENGTH);
    expect(redacted.endsWith(`\n${REDACTION_MARKER}`)).toBe(true);
    expect(redacted).not.toContain('QQZZ7');
    expect(redactTextUrls(redacted)).toBe(redacted);
  });

  it('never throws, whatever it is given', () => {
    for (const value of [undefined, null, 42, true, { href: '/p?id=1' }, ['?a=1']]) {
      expect(() => redactTextUrls(value)).not.toThrow();
      expect(typeof redactTextUrls(value)).toBe('string');
    }
  });
});

describe('redactEmbeddedUrls', () => {
  it('masks an origin-relative query in prose, and an absolute URL beside it', () => {
    expect(redactEmbeddedUrls('GET /reset?code=ZIP42 then https://x.test/a?b=1#top')).toBe(
      'GET /reset?code=? then https://x.test/a?b=?#?',
    );
  });

  it('anchors a run at the start of the text, after whitespace and after an opening parenthesis', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['/reset?code=ZIP42', '/reset?code=?'],
      ['Why is /reset?code=ZIP42 slow', 'Why is /reset?code=? slow'],
      ['first line\n/p?id=QQZZ7', 'first line\n/p?id=?'],
      ['tab\t/p?id=QQZZ7', 'tab\t/p?id=?'],
      ['(see /reset?code=ZIP42).', '(see /reset?code=?'],
      ['fn(/a?b=QQZZ7)', 'fn(/a?b=?'],
      ['// see /api/x?id=QQZZ7', '// see /api/x?id=?'],
    ];

    for (const [text, expected] of cases) {
      const redacted = redactEmbeddedUrls(text);

      expect(redacted, text).toBe(expected);
      for (const token of redacted.split(URL_RUN_DELIMITERS)) {
        expectOnlyMaskedValues(token);
      }
    }
  });

  it('masks every value and a non-empty fragment, keeping keys, flags and empty values', () => {
    expect(redactEmbeddedUrls('/p?a=QQZZ7&b=&c&a=WWXX9#frag')).toBe('/p?a=?&b=&c&a=?#?');
    expect(redactEmbeddedUrls('/p?flag#frag')).toBe('/p?flag#?');
    expect(redactEmbeddedUrls('/p?a=QQZZ7#')).toBe('/p?a=?#');
    expect(redactEmbeddedUrls('/p?')).toBe('/p?');
  });

  it('masks the whole run, punctuation at its end included', () => {
    for (const [text, expected] of [
      ['/reset?code=!!!!', '/reset?code=?'],
      ['/reset?code=ZIP42!', '/reset?code=?'],
      ['see /p?id=7.', 'see /p?id=?'],
      ['see https://x.test/a?b=1).', 'see https://x.test/a?b=?'],
    ] as const) {
      expect(redactEmbeddedUrls(text), text).toBe(expected);
    }
  });

  it('anchors a run after a written whitespace escape, as the outbound guard reads one', () => {
    // A JSON-rendered prompt section or a string literal writes a line break
    // as `\n`; the run after it starts a line there.
    for (const [text, expected] of [
      ['const s = "a\\n/api/x?id=QQZZ7";', 'const s = "a\\n/api/x?id=?";'],
      ['first\\t/p?id=QQZZ7 then', 'first\\t/p?id=? then'],
      ['x\\u000b/p?id=QQZZ7', 'x\\u000b/p?id=?'],
    ] as const) {
      expect(redactEmbeddedUrls(text), text).toBe(expected);
      expect(redactEmbeddedUrls(expected), expected).toBe(expected);
    }
    // A backslash before any other letter is not whitespace, and does not
    // anchor.
    expect(redactEmbeddedUrls('a\\x/p?id=1')).toBe('a\\x/p?id=1');
  });

  it('matches an absolute scheme in any letter case and keeps a frame position', () => {
    expect(redactEmbeddedUrls('HTTP://X.test/a?b=QQZZ7')).toBe('HTTP://X.test/a?b=?');
    expect(redactEmbeddedUrls('    at fn (https://x.test/a.js?v=QQZZ7:10:5)')).toBe(
      '    at fn (https://x.test/a.js?v=?:10:5)',
    );
  });

  it('leaves code and relative shapes that are not an anchored URL unchanged', () => {
    // The context builder runs this over source excerpts, where each of these
    // is an expression rather than a URL.
    for (const text of [
      'p?id=1',
      '?id=1',
      'const re = /^(?=\\S+$)(?:\\S*[0-9]\\S*|[^a-z]+)$/;',
      '/^(?=\\S+$)(?:\\S*[0-9]\\S*|[^a-z]+)$/',
      'const x = a ? b : c;',
      'const n = total /count ? 1 : 0;',
      'if (a?.b) { return c?.d; }',
      "const url = '/api/x?a=1';",
      'const url = "/api/x?a=1";',
      'fetch(`/x?a=${v}`)',
      '//cdn.example.test/p?a=1',
      'x/p?a=1',
      'Why? Because.',
      '',
    ]) {
      expect(redactEmbeddedUrls(text), text).toBe(text);
    }
  });

  it('is idempotent', () => {
    for (const text of [
      'GET /reset?code=ZIP42 then https://x.test/a?b=1#top',
      '(see /reset?code=ZIP42).',
      '/p?a=QQZZ7&b=&c&a=WWXX9#frag',
      '/reset?code=!!!!',
      '    at fn (https://x.test/a.js?v=QQZZ7:10:5)',
      `/p?${'a=1&'.repeat(MAX_QUERY_PAIRS + 4)}`,
      "const url = '/api/x?a=1'; if (a?.b) {}",
    ]) {
      const once = redactEmbeddedUrls(text);

      expect(redactEmbeddedUrls(once), text.slice(0, 40)).toBe(once);
    }
  });

  it('bounds its output and reports the loss on a line of its own', () => {
    const long = 'see /p?id=QQZZ7 '.repeat(Math.ceil((MAX_SCAN_LENGTH * 2) / 16));
    const redacted = redactEmbeddedUrls(long);

    expect(redacted.length).toBeLessThanOrEqual(MAX_SCAN_LENGTH);
    expect(redacted.endsWith(`\n${REDACTION_MARKER}`)).toBe(true);
    expect(redacted).not.toContain('QQZZ7');
    expect(redactEmbeddedUrls(redacted)).toBe(redacted);
  });

  it('never throws, whatever it is given', () => {
    for (const value of [undefined, null, 42, true, { href: '/p?id=1' }, ['/p?a=1']]) {
      expect(() => redactEmbeddedUrls(value)).not.toThrow();
      expect(typeof redactEmbeddedUrls(value)).toBe('string');
    }
    expect(redactEmbeddedUrls(null)).toBe(REDACTION_MARKER);
  });
});

describe('redactStackText', () => {
  it("masks every reference in a stack's message lines as free text", () => {
    // The first line is the thrown error's message, which quotes URLs the
    // way page text does; `redactTextUrls` masks the same text under
    // `error.message`.
    const stack =
      "Error: failed '/reset?code=QQZZ7' and reset?code=WWXX9 and ?code=ZZYY3\n" +
      'caused by a[href="/p?id=QQZZ7"]\n' +
      '    at fn (http://127.0.0.1:3000/app.js?v=QQZZ7:10:5)';

    expect(redactStackText(stack)).toBe(
      "Error: failed '/reset?code=?' and reset?code=? and ?code=?\n" +
        'caused by a[href="/p?id=?"]\n' +
        '    at fn (http://127.0.0.1:3000/app.js?v=?:10:5)',
    );
  });

  it('keeps the position of every V8 and SpiderMonkey frame', () => {
    const stack =
      'Error: boom\n' +
      '    at fn (http://127.0.0.1:3000/app.js?v=QQZZ7:10:5)\n' +
      '    at http://127.0.0.1:3000/b.js?v=WWXX9:2:1\n' +
      'load@http://127.0.0.1:3000/c.js?v=ZZYY3:7:3\n' +
      '@http://127.0.0.1:3000/d.js?v=QQZZ7:1:9';

    expect(redactStackText(stack)).toBe(
      'Error: boom\n' +
        '    at fn (http://127.0.0.1:3000/app.js?v=?:10:5)\n' +
        '    at http://127.0.0.1:3000/b.js?v=?:2:1\n' +
        'load@http://127.0.0.1:3000/c.js?v=?:7:3\n' +
        '@http://127.0.0.1:3000/d.js?v=?:1:9',
    );
  });

  it('classifies a frame by its whole line, so a message quoting a frame is still masked', () => {
    // A message line that merely contains `@https://…` is page text: every
    // query on it is masked, and the position after the URL goes with it.
    const stack = 'Error: failed reset?code=QQZZ7; fn@https://h.test/app.js?v=WWXX9:10:5';
    const redacted = redactStackText(stack);

    expect(redacted).toBe('Error: failed reset?code=? fn@https://h.test/app.js?v=?');
    expect(redacted).not.toContain('QQZZ7');
    expect(redacted).not.toContain('WWXX9');
  });

  it('masks a bare-relative query on a frame line and keeps the frame position', () => {
    const stack =
      'Error: boom\n' +
      '    at handler (src/a.ts?code=QQZZ7:3:4)\n' +
      'load@http://h.test/b.js?v=WWXX9:7:3\n' +
      '    at run (src/c.ts?page=ZZYY3)';

    const redacted = redactStackText(stack);
    expect(redacted).toBe(
      'Error: boom\n' +
        '    at handler (src/a.ts?code=?:3:4)\n' +
        'load@http://h.test/b.js?v=?:7:3\n' +
        '    at run (src/c.ts?page=?',
    );
    expect(redactStackText(redacted)).toBe(redacted);
  });

  it('masks everything redactEmbeddedUrls masks, and leaves a stack without a query alone', () => {
    const cases = [
      'GET /reset?code=ZIP42 then https://x.test/a?b=1#top',
      '(see /reset?code=ZIP42).',
      "Error: '/p?id=QQZZ7' and p?id=WWXX9",
    ];
    for (const text of cases) {
      const redacted = redactStackText(text);

      expect(redactEmbeddedUrls(redacted), text).toBe(redacted);
      for (const token of redacted.split(URL_RUN_DELIMITERS)) {
        expectOnlyMaskedValues(token);
      }
    }
    const plain = 'Error: boom\n    at send (src/a.ts:18:3)\n    at flush (src/a.ts:31:9)';
    expect(redactStackText(plain)).toBe(plain);
  });

  it('is idempotent, bounded and total', () => {
    for (const text of [
      "Error: failed '/reset?code=QQZZ7'\n    at fn (http://x.test/a.js?v=1:10:5)",
      'Error: see p?id=7.\nload@http://x.test/c.js?v=2:7:3',
      "Error: '/reset?code=!!!!'",
    ]) {
      const once = redactStackText(text);

      expect(redactStackText(once), text).toBe(once);
    }
    const long = "Error: '/p?id=QQZZ7' ".repeat(Math.ceil((MAX_SCAN_LENGTH * 2) / 21));
    const redacted = redactStackText(long);
    expect(redacted.length).toBeLessThanOrEqual(MAX_SCAN_LENGTH);
    expect(redacted).not.toContain('QQZZ7');
    expect(redactStackText(redacted)).toBe(redacted);
    for (const value of [undefined, null, 42, { stack: '/p?id=1' }]) {
      expect(() => redactStackText(value)).not.toThrow();
      expect(typeof redactStackText(value)).toBe('string');
    }
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
