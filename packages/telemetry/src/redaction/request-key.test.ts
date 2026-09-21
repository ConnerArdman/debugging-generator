/**
 * Tests for `./request-key.ts`: the keyed request identity that duplicate
 * detection groups by.
 *
 * This suite is the gate on one product guarantee, stated in the privacy
 * model: *"`productId=A` and `productId=B` are distinct while byte-identical
 * requests collide"*. Both halves fail silently in production if they fail at
 * all — a wrong key still looks like 64 plausible hex characters, every panel
 * still renders, and the only symptom is a duplicate-request investigation
 * that either finds nothing or reports two unrelated requests as one. Nothing
 * downstream can detect that, so it is caught here or not at all.
 *
 * This file is where those assertions live because the plan puts them here
 * twice: AAP §0.5.2 states the guarantee and adds that "`request-key.test.ts`
 * asserts both cases", and AAP §0.8.3's redaction row names the "`request-key`
 * true-duplicate vs different-parameter cases" among the unit tests. The two
 * cases are `computeRequestKey`'s "gives byte-identical requests the same key"
 * and "gives requests differing only in a parameter value different keys"
 * below; the rest of the suite exists to keep those two honest.
 *
 * What is therefore asserted, and why each assertion exists:
 *
 * - **The canonical message, exactly.** {@link buildRequestKeyMessage} is pure
 *   and synchronous precisely so that the format can be pinned as a string
 *   rather than inferred from a digest. Persisted `request_key` values depend
 *   on that format, so a change to it that does not also change
 *   {@link REQUEST_KEY_MESSAGE_VERSION} must fail here.
 * - **An unambiguous message.** A digest identifies a request only if the
 *   string behind it does, so two structurally different requests must never
 *   share a canonical message. The delimiter cases below — a value containing
 *   `&`, a key containing `=`, a newline in a value, a newline in the method
 *   or the path — are each a pair of requests that a framing built from bare
 *   `\n`, `&` and `=` merged into one message and therefore one key, and each
 *   is asserted at both levels: the message must differ, and so must the
 *   digest. They sit beside the equivalences that must *survive* the encoding
 *   (parameter order, repeated parameters, `%20` versus `+` versus a literal
 *   space), because the two properties are easy to trade for one another and
 *   the fix is only right if it keeps both.
 * - **A known-answer vector.** A keyed digest cannot be validated against
 *   itself: an implementation that hex-encodes backwards, or that encodes the
 *   message as UTF-16, is perfectly self-consistent. The RFC 4231 vectors below
 *   are what prove the key decoding, the UTF-8 encoding and the hex output are
 *   each right, and they are what keep this WebCrypto implementation in step
 *   with the `node:crypto` helper behind `@debuggen/shared/node`.
 * - **Lazy global resolution.** The absent-Web-Crypto path is only reachable
 *   while `globalThis.crypto` is read inside each function. Stubbing it away
 *   and then restoring it proves the read is lazy; against a module-scope
 *   capture the stub would do nothing and the assertion would be vacuous.
 * - **The failure contract.** Every asynchronous export returns a `Result` and
 *   never rejects, because ingest must not lose a batch of five thousand
 *   events to one malformed URL.
 * - **Privacy.** A session key is a secret and a pre-redaction URL is the
 *   material the whole redaction layer exists to contain, so the rejection for
 *   a malformed key must not echo it.
 *
 * ## Fixtures carry no demo knowledge
 *
 * Every path below is a generic one (`/api/items`, `/api/prices`,
 * `/api/lookup`) rather than a route of the demo application, so nothing here
 * could serve as a shortcut for a pipeline that is supposed to discover such a
 * route by analysing code. `productId` is the one borrowed name, and it is
 * borrowed from the privacy model's own sentence about this function rather
 * than from any application: it is what makes the `productId=A` versus
 * `productId=B` assertion recognisably the case the specification names.
 *
 * ## Why some fixtures are assembled at runtime
 *
 * `scripts/check-secrets.mjs` scans every tracked file, and a credentialed URL
 * written out in full is a finding whatever its purpose. The one such fixture
 * here is joined from fragments at run time, with a password that is a run of a
 * single character so the scanner's entropy rule has nothing to measure either
 * — the same convention `url.test.ts` follows. The session keys are built by
 * repeating a short literal for the same reason.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { DebuggenError, isErr, isOk, unwrap } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';

import { MAX_QUERY_PAIRS } from './url.js';
import {
  REQUEST_KEY_MESSAGE_VERSION,
  REQUEST_KEY_SESSION_KEY_BYTES,
  REQUEST_KEY_SESSION_KEY_PATTERN,
  buildRequestKeyMessage,
  computeRequestKey,
  createRequestKeyHasher,
  createRequestKeySessionKey,
  hmacSha256Hex,
} from './request-key.js';

/*
 * ---------------------------------------------------------------------------
 * Fixtures and helpers
 * ---------------------------------------------------------------------------
 */

/** A valid session key: 64 lowercase hex characters, built from a short literal. */
const SESSION_A = '0123456789abcdef'.repeat(4);

/** A second valid session key, so cross-session unlinkability can be asserted. */
const SESSION_B = 'fedcba9876543210'.repeat(4);

/**
 * A malformed session key that is recognisable in any text it leaks into.
 *
 * Deliberately not hex and deliberately distinctive: the assertion that the
 * rejection does not echo the supplied value is only meaningful if the value
 * would be obvious in the serialised error.
 */
const MALFORMED_SESSION_KEY = `not-a-session-key-${'q'.repeat(24)}`;

/**
 * An absolute URL carrying userinfo, joined from fragments so this tracked
 * file never contains `user:password@host` contiguously (see the module
 * documentation); the password is a run of one character, so the scanner's
 * entropy rule has nothing to measure either. The value
 * {@link buildRequestKeyMessage} sees is exactly the credentialed URL a
 * producer could report.
 */
const CREDENTIALED_URL = [
  'https',
  '://',
  'operator',
  ':',
  'w'.repeat(12),
  '@',
  'shop.test/api/items?limit=20',
].join('');

/** RFC 4231 test case 1 key: 20 bytes of `0x0b`. */
const VECTOR_1_KEY_HEX = '0b'.repeat(20);

/** RFC 4231 test case 1 data. */
const VECTOR_1_DATA = 'Hi There';

/** RFC 4231 test case 1 expected HMAC-SHA-256. */
const VECTOR_1_MAC = 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7';

/** RFC 4231 test case 2 key: the four bytes of the ASCII text `Jefe`. */
const VECTOR_2_KEY_HEX = '4a656665';

/** RFC 4231 test case 2 data. */
const VECTOR_2_DATA = 'what do ya want for nothing?';

/** RFC 4231 test case 2 expected HMAC-SHA-256. */
const VECTOR_2_MAC = '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843';

/** A digest's shape: 64 lowercase hex characters. */
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** Asserts a `Result` is `Ok` and returns its value, failing the test if not. */
function expectOk<T>(result: Result<T, DebuggenError>): T {
  expect(isOk(result)).toBe(true);
  return unwrap(result);
}

/** Asserts a `Result` is `Err` and returns the error, failing the test if not. */
function expectErr(result: Result<unknown, DebuggenError>): DebuggenError {
  expect(isErr(result)).toBe(true);
  if (!isErr(result)) {
    throw new Error('Expected an Err result.');
  }
  return result.error;
}

/**
 * Everything a `DebuggenError` would carry into a log, a session record or a
 * user interface, as one string — which is what the "never echoes its input"
 * assertions search.
 */
function reportableText(error: DebuggenError): string {
  return JSON.stringify({
    message: error.message,
    hint: error.hint,
    details: error.details,
  });
}

/** The four parts of a canonical message, with absent parts as empty strings. */
function messageParts(message: string): {
  version: string;
  method: string;
  path: string;
  query: string;
} {
  const [version = '', method = '', path = '', query = ''] = message.split('\n');
  return { version, method, path, query };
}

/** The sorted-pairs part of a canonical message. */
function queryPart(message: string): string {
  return messageParts(message).query;
}

/** A URL whose query carries `pairCount` zero-padded pairs in sorted order. */
function longQueryUrl(pairCount: number): string {
  const pairs: string[] = [];
  for (let index = 0; index < pairCount; index += 1) {
    pairs.push(`p${String(index).padStart(4, '0')}=${String(index)}`);
  }
  return `/api/items?${pairs.join('&')}`;
}

/** The `request_key` of one request under {@link SESSION_A}. */
async function keyFor(method: string, url: string, sessionKey = SESSION_A): Promise<string> {
  return expectOk(await computeRequestKey({ sessionKey, method, url }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/*
 * ---------------------------------------------------------------------------
 * The canonical message
 * ---------------------------------------------------------------------------
 */

describe('buildRequestKeyMessage', () => {
  it('renders the documented four-part layout', () => {
    const message = buildRequestKeyMessage({
      method: 'GET',
      url: 'https://shop.test:3000/api/items?limit=20&q=hex%20bolt#top',
    });

    expect(message).toBe('v2\n"GET"\n"/api/items"\n[["limit","20"],["q","hex bolt"]]');
    expect(messageParts(message).version).toBe(REQUEST_KEY_MESSAGE_VERSION);
    // Every part after the tag is a JSON value, which is what makes the four
    // parts unambiguous rather than merely separated.
    expect(message.split('\n')).toHaveLength(4);
  });

  it('trims and upper-cases the method, so get and GET collide', () => {
    const upper = buildRequestKeyMessage({ method: 'POST', url: '/api/lookup' });

    expect(upper).toBe(buildRequestKeyMessage({ method: 'post', url: '/api/lookup' }));
    expect(upper).toBe(buildRequestKeyMessage({ method: '  PoSt \n', url: '/api/lookup' }));
    expect(messageParts(upper).method).toBe('"POST"');
  });

  it('excludes the origin, so an absolute and an origin-relative URL agree', () => {
    const relative = buildRequestKeyMessage({ method: 'GET', url: '/api/items?limit=20' });

    expect(
      buildRequestKeyMessage({ method: 'GET', url: 'http://localhost:3000/api/items?limit=20' }),
    ).toBe(relative);
    expect(
      buildRequestKeyMessage({ method: 'GET', url: 'https://other.test/api/items?limit=20' }),
    ).toBe(relative);
    expect(buildRequestKeyMessage({ method: 'GET', url: '//host.test/api/items?limit=20' })).toBe(
      relative,
    );
  });

  it('excludes the fragment and any userinfo', () => {
    const plain = buildRequestKeyMessage({ method: 'GET', url: '/api/items?limit=20' });

    expect(buildRequestKeyMessage({ method: 'GET', url: CREDENTIALED_URL })).toBe(plain);
    expect(buildRequestKeyMessage({ method: 'GET', url: '/api/items?limit=20#section' })).toBe(
      plain,
    );
  });

  it('keeps the path byte-faithfully: no case, slash or escape folding', () => {
    expect(messageParts(buildRequestKeyMessage({ method: 'GET', url: '/API/Items/' })).path).toBe(
      '"/API/Items/"',
    );
    expect(buildRequestKeyMessage({ method: 'GET', url: '/api/items/' })).not.toBe(
      buildRequestKeyMessage({ method: 'GET', url: '/api/items' }),
    );
    expect(messageParts(buildRequestKeyMessage({ method: 'GET', url: '/a%2Fb' })).path).toBe(
      '"/a%2Fb"',
    );
  });

  it('sorts pairs by key then value in code-unit order, never a locale collation', () => {
    const message = buildRequestKeyMessage({ method: 'GET', url: '/p?a=2&Z=1&a=1' });

    expect(queryPart(message)).toBe('[["Z","1"],["a","1"],["a","2"]]');
    // The comparison the implementation must not use disagrees on exactly this
    // pair, which is what makes the assertion above a real constraint rather
    // than a coincidence of the fixture.
    expect('Z'.localeCompare('a', 'en')).toBe(1);
    expect('Z' < 'a').toBe(true);
  });

  it('is insensitive to the order of parameters, including repeated ones', () => {
    const canonical = buildRequestKeyMessage({
      method: 'GET',
      url: '/api/items?limit=20&tag=a&tag=b',
    });

    expect(buildRequestKeyMessage({ method: 'GET', url: '/api/items?tag=b&limit=20&tag=a' })).toBe(
      canonical,
    );
    expect(queryPart(canonical)).toBe('[["limit","20"],["tag","a"],["tag","b"]]');
  });

  it('canonicalises %20, + and a literal space to one value', () => {
    const escaped = buildRequestKeyMessage({ method: 'GET', url: '/api/items?q=hex%20bolt' });

    expect(buildRequestKeyMessage({ method: 'GET', url: '/api/items?q=hex+bolt' })).toBe(escaped);
    expect(buildRequestKeyMessage({ method: 'GET', url: '/api/items?q=hex bolt' })).toBe(escaped);
    expect(queryPart(escaped)).toBe('[["q","hex bolt"]]');
  });

  it('decodes the parameter name as well as its value', () => {
    expect(queryPart(buildRequestKeyMessage({ method: 'GET', url: '/p?product%20id=7' }))).toBe(
      '[["product id","7"]]',
    );
  });

  it('gives a bare flag the empty value', () => {
    const bare = buildRequestKeyMessage({ method: 'GET', url: '/api/items?reload' });

    expect(queryPart(bare)).toBe('[["reload",""]]');
    expect(buildRequestKeyMessage({ method: 'GET', url: '/api/items?reload=' })).toBe(bare);
  });

  it('keeps a fixed arity when the query is absent or empty', () => {
    const absent = buildRequestKeyMessage({ method: 'GET', url: '/api/items' });

    expect(absent).toBe('v2\n"GET"\n"/api/items"\n[]');
    expect(absent.split('\n')).toHaveLength(4);
    expect(buildRequestKeyMessage({ method: 'GET', url: '/api/items?' })).toBe(absent);
    expect(buildRequestKeyMessage({ method: 'GET', url: '/api/items?&&' })).toBe(absent);
  });

  it('canonicalises the capped pair prefix deterministically', () => {
    const overflowing = buildRequestKeyMessage({
      method: 'GET',
      url: longQueryUrl(MAX_QUERY_PAIRS + 88),
    });
    const capped = buildRequestKeyMessage({ method: 'GET', url: longQueryUrl(MAX_QUERY_PAIRS) });

    expect(JSON.parse(queryPart(overflowing)) as unknown[]).toHaveLength(MAX_QUERY_PAIRS);
    expect(overflowing).toBe(capped);
    // Same input, same message: the cap is a deterministic prefix, so a URL
    // beyond it still keys stably.
    expect(buildRequestKeyMessage({ method: 'GET', url: longQueryUrl(MAX_QUERY_PAIRS + 88) })).toBe(
      overflowing,
    );
  });

  it('is total: a malformed escape or a lone delimiter does not throw', () => {
    expect(() => buildRequestKeyMessage({ method: 'GET', url: '%' })).not.toThrow();
    expect(queryPart(buildRequestKeyMessage({ method: 'GET', url: '/p?q=%zz' }))).toBe(
      '[["q","%zz"]]',
    );
    expect(buildRequestKeyMessage({ method: '', url: '' })).toBe('v2\n""\n""\n[]');
  });

  it('is total for a lone surrogate, which percent-encoding could not be', () => {
    // `encodeURIComponent('\uD800')` throws `URIError`; the encoder this module
    // uses escapes the code unit instead, which is why it is the one chosen.
    // An unpaired surrogate reaches here from any producer that slices a URL
    // mid-character, and losing the event is not an option.
    const message = buildRequestKeyMessage({ method: 'GET', url: '/p?q=\uD800' });

    expect(() => encodeURIComponent('\uD800')).toThrow(URIError);
    expect(queryPart(message)).toBe('[["q","\\ud800"]]');
    expect(message.split('\n')).toHaveLength(4);
  });

  /*
   * The delimiter cases. Each pair below is two structurally different
   * requests that a framing of bare `\n`, `&` and `=` rendered as one message,
   * and therefore grouped as one repeated request. Asserted on the message
   * here and on the digest in the `computeRequestKey` block, because the
   * message is what the digest is taken over and only the digest is what
   * duplicate detection actually compares.
   */

  it('does not merge a value containing & with two parameters', () => {
    const oneParameter = buildRequestKeyMessage({ method: 'GET', url: '/x?a=b%26c=d' });
    const twoParameters = buildRequestKeyMessage({ method: 'GET', url: '/x?a=b&c=d' });

    expect(oneParameter).not.toBe(twoParameters);
    expect(queryPart(oneParameter)).toBe('[["a","b&c=d"]]');
    expect(queryPart(twoParameters)).toBe('[["a","b"],["c","d"]]');
  });

  it('does not merge a key containing = with a value containing =', () => {
    const keyHasEquals = buildRequestKeyMessage({ method: 'GET', url: '/x?a%3Db=c' });
    const valueHasEquals = buildRequestKeyMessage({ method: 'GET', url: '/x?a=b=c' });

    expect(keyHasEquals).not.toBe(valueHasEquals);
    expect(queryPart(keyHasEquals)).toBe('[["a=b","c"]]');
    expect(queryPart(valueHasEquals)).toBe('[["a","b=c"]]');
  });

  it('keeps a decoded newline inside its part instead of forging a new one', () => {
    const message = buildRequestKeyMessage({ method: 'GET', url: '/x?q=a%0Ab' });

    expect(message.split('\n')).toHaveLength(4);
    expect(queryPart(message)).toBe('[["q","a\\nb"]]');
    expect(buildRequestKeyMessage({ method: 'GET', url: '/x?q=a b' })).not.toBe(message);
  });

  it('does not let a method or a path forge the part delimiter', () => {
    // `parseUrlParts` reproduces a path verbatim and the method is only
    // trimmed and upper-cased, so either can arrive carrying a newline.
    const methodCarriesIt = buildRequestKeyMessage({ method: 'GET\n/b', url: '/a' });
    const pathCarriesIt = buildRequestKeyMessage({ method: 'GET', url: '/B\n/a' });

    expect(methodCarriesIt).not.toBe(pathCarriesIt);
    expect(methodCarriesIt.split('\n')).toHaveLength(4);
    expect(pathCarriesIt.split('\n')).toHaveLength(4);
    expect(messageParts(methodCarriesIt).method).toBe('"GET\\n/B"');
    expect(messageParts(pathCarriesIt).path).toBe('"/B\\n/a"');
  });

  it('is injective across the delimiter cases taken together', () => {
    // One message per distinct request: the property the digest inherits, and
    // the one a delimiter-only framing broke four different ways.
    const requests = [
      { method: 'GET', url: '/x?a=b%26c=d' },
      { method: 'GET', url: '/x?a=b&c=d' },
      { method: 'GET', url: '/x?a%3Db=c' },
      { method: 'GET', url: '/x?a=b=c' },
      { method: 'GET', url: '/x?q=a%0Ab' },
      { method: 'GET', url: '/x?q=a b' },
      { method: 'GET\n/b', url: '/a' },
      { method: 'GET', url: '/B\n/a' },
      { method: 'GET', url: '/x?a=b' },
    ];

    const messages = new Set(requests.map((request) => buildRequestKeyMessage(request)));

    expect(messages.size).toBe(requests.length);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The low-level primitive
 * ---------------------------------------------------------------------------
 */

describe('hmacSha256Hex', () => {
  it('matches the RFC 4231 known-answer vectors', async () => {
    expect(expectOk(await hmacSha256Hex(VECTOR_1_KEY_HEX, VECTOR_1_DATA))).toBe(VECTOR_1_MAC);
    expect(expectOk(await hmacSha256Hex(VECTOR_2_KEY_HEX, VECTOR_2_DATA))).toBe(VECTOR_2_MAC);
  });

  it('returns 64 lowercase hex characters', async () => {
    const digest = expectOk(await hmacSha256Hex(SESSION_A, 'v1\nGET\n/api/items\n'));

    expect(digest).toMatch(DIGEST_PATTERN);
    expect(digest).toHaveLength(64);
  });

  it('reads a key in either hex case, because both spell the same bytes', async () => {
    expect(expectOk(await hmacSha256Hex(VECTOR_1_KEY_HEX.toUpperCase(), VECTOR_1_DATA))).toBe(
      VECTOR_1_MAC,
    );
  });

  it('encodes the message as UTF-8, so a multi-byte character is authenticated', async () => {
    const first = expectOk(await hmacSha256Hex(VECTOR_1_KEY_HEX, 'ø'));
    const second = expectOk(await hmacSha256Hex(VECTOR_1_KEY_HEX, 'o'));

    expect(first).not.toBe(second);
  });

  it('rejects an empty, odd-length or non-hex key without echoing it', async () => {
    for (const badKey of ['', '0b0', 'zz', `${VECTOR_1_KEY_HEX}g0`]) {
      const error = expectErr(await hmacSha256Hex(badKey, VECTOR_1_DATA));

      expect(error.code).toBe('INTERNAL');
      expect(error.message).toContain('hexadecimal');
      expect(error.details).toEqual({ receivedCharacters: badKey.length });
      if (badKey.length > 0) {
        expect(reportableText(error)).not.toContain(badKey);
      }
    }
  });

  it('returns an Err instead of rejecting when signing fails', async () => {
    const failure = new Error('operation failed');
    vi.spyOn(globalThis.crypto.subtle, 'sign').mockRejectedValueOnce(failure);

    const error = expectErr(await hmacSha256Hex(VECTOR_1_KEY_HEX, VECTOR_1_DATA));

    expect(error.code).toBe('INTERNAL');
    expect(error.cause).toBe(failure);
    // The material being authenticated never reaches a reportable field.
    expect(reportableText(error)).not.toContain(VECTOR_1_DATA);
    expect(reportableText(error)).not.toContain(VECTOR_1_KEY_HEX);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Session keys
 * ---------------------------------------------------------------------------
 */

describe('createRequestKeySessionKey', () => {
  it('mints 32 bytes as 64 lowercase hex characters', () => {
    const sessionKey = createRequestKeySessionKey();

    expect(sessionKey).toMatch(REQUEST_KEY_SESSION_KEY_PATTERN);
    expect(sessionKey).toHaveLength(REQUEST_KEY_SESSION_KEY_BYTES * 2);
  });

  it('mints a distinct key every time', () => {
    const minted = new Set(Array.from({ length: 32 }, () => createRequestKeySessionKey()));

    expect(minted.size).toBe(32);
  });

  it('throws a typed error when the host has no Web Crypto, and works once it returns', () => {
    vi.stubGlobal('crypto', undefined);

    let caught: unknown;
    try {
      createRequestKeySessionKey();
    } catch (error) {
      caught = error;
    }

    expect(DebuggenError.is(caught)).toBe(true);
    if (!DebuggenError.is(caught)) {
      throw new Error('Expected a DebuggenError.');
    }
    expect(caught.code).toBe('INTERNAL');
    expect(caught.message).toContain('getRandomValues');

    // Proof that the global is resolved lazily: restoring it is enough.
    vi.unstubAllGlobals();
    expect(createRequestKeySessionKey()).toMatch(REQUEST_KEY_SESSION_KEY_PATTERN);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The keys duplicate detection groups by
 * ---------------------------------------------------------------------------
 */

describe('computeRequestKey', () => {
  it('gives byte-identical requests the same key', async () => {
    const url = '/api/prices?limit=6&productId=A';

    expect(await keyFor('GET', url)).toBe(await keyFor('GET', url));
  });

  it('gives requests differing only in a parameter value different keys', async () => {
    const withA = await keyFor('GET', '/api/prices?limit=6&productId=A');
    const withB = await keyFor('GET', '/api/prices?limit=6&productId=B');

    expect(withA).not.toBe(withB);
  });

  it('ignores parameter order, method case and encoding variants', async () => {
    const canonical = await keyFor('GET', '/api/items?limit=20&q=hex%20bolt');

    expect(await keyFor('get', '/api/items?q=hex+bolt&limit=20')).toBe(canonical);
    expect(await keyFor(' GET ', '/api/items?q=hex bolt&limit=20')).toBe(canonical);
  });

  it('separates the path and the method', async () => {
    const get = await keyFor('GET', '/api/lookup');

    expect(await keyFor('POST', '/api/lookup')).not.toBe(get);
    expect(await keyFor('GET', '/api/lookups')).not.toBe(get);
  });

  it('is unlinkable across sessions: one request, two keys', async () => {
    const url = '/api/prices?productId=A';

    expect(await keyFor('GET', url, SESSION_B)).not.toBe(await keyFor('GET', url, SESSION_A));
  });

  it('returns 64 lowercase hex characters', async () => {
    expect(await keyFor('GET', '/api/items')).toMatch(DIGEST_PATTERN);
  });

  it('is the HMAC of the canonical message, version tag included', async () => {
    const message = buildRequestKeyMessage({ method: 'GET', url: '/api/items?limit=20' });

    expect(await keyFor('GET', '/api/items?limit=20')).toBe(
      expectOk(await hmacSha256Hex(SESSION_A, message)),
    );
    // A different version tag over the same request is a different key, which
    // is what makes a future layout change safe. Written against whatever the
    // current tag is, so the assertion survives the next bump.
    const otherVersion = message.replace(
      `${REQUEST_KEY_MESSAGE_VERSION}\n`,
      `${REQUEST_KEY_MESSAGE_VERSION}x\n`,
    );
    expect(otherVersion).not.toBe(message);
    expect(await keyFor('GET', '/api/items?limit=20')).not.toBe(
      expectOk(await hmacSha256Hex(SESSION_A, otherVersion)),
    );
  });

  it('keys a pathological URL rather than losing the event', async () => {
    for (const url of [
      '',
      '%',
      '???',
      '/p?q=%zz',
      'mailto:someone@example.test',
      '/p?q=\uD800',
      '/p?q=a%0Ab',
    ]) {
      expect(await keyFor('GET', url)).toMatch(DIGEST_PATTERN);
    }
  });

  it('gives structurally different queries different keys, not one group', async () => {
    // The digest-level half of the delimiter cases: these pairs shared a
    // canonical message under a bare `key=value&…` join, so duplicate
    // detection saw one repeated request where there were two distinct ones.
    const pairs = [
      ['/x?a=b%26c=d', '/x?a=b&c=d'],
      ['/x?a%3Db=c', '/x?a=b=c'],
      ['/x?q=a%0Ab', '/x?q=a b'],
    ] as const;

    for (const [left, right] of pairs) {
      expect(await keyFor('GET', left)).not.toBe(await keyFor('GET', right));
    }

    expect(await keyFor('GET\n/b', '/a')).not.toBe(await keyFor('GET', '/B\n/a'));
  });

  it('still groups the requests that are the same request', async () => {
    // The equivalences the encoding must not cost: an interaction firing the
    // same fetch twice has to land in one group, however each call spelled it.
    const canonical = await keyFor('GET', '/api/prices?limit=6&tag=a&tag=b');

    expect(await keyFor('GET', '/api/prices?tag=b&tag=a&limit=6')).toBe(canonical);
    expect(await keyFor('get', '/api/prices?limit=6&tag=a&tag=b')).toBe(canonical);
    expect(await keyFor('GET', 'http://localhost:3000/api/prices?limit=6&tag=a&tag=b#x')).toBe(
      canonical,
    );
  });

  it('rejects a malformed session key without echoing it', async () => {
    const candidates = [
      MALFORMED_SESSION_KEY,
      SESSION_A.toUpperCase(),
      SESSION_A.slice(0, 63),
      `${SESSION_A}0`,
      '',
    ];

    for (const sessionKey of candidates) {
      const error = expectErr(
        await computeRequestKey({ sessionKey, method: 'GET', url: '/api/items' }),
      );

      expect(error.code).toBe('INTERNAL');
      expect(error.message).toContain('64 lowercase hexadecimal characters');
      expect(error.details).toEqual({
        expectedCharacters: 64,
        receivedCharacters: sessionKey.length,
      });
      if (sessionKey.length > 0) {
        expect(reportableText(error)).not.toContain(sessionKey);
      }
    }
  });

  it('returns an Err rather than rejecting when the host has no Web Crypto', async () => {
    for (const stub of [undefined, {}, { subtle: {} }, { subtle: { importKey: 1, sign: 2 } }]) {
      vi.stubGlobal('crypto', stub);

      const error = expectErr(
        await computeRequestKey({ sessionKey: SESSION_A, method: 'GET', url: '/api/items' }),
      );

      expect(error.code).toBe('INTERNAL');
      expect(error.message).toContain('crypto.subtle');
    }

    // Lazy resolution again: the very next call succeeds once the global is back.
    vi.unstubAllGlobals();
    expect(await keyFor('GET', '/api/items')).toMatch(DIGEST_PATTERN);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The batch-scoped hasher
 * ---------------------------------------------------------------------------
 */

describe('createRequestKeyHasher', () => {
  it('imports the CryptoKey once for a whole batch, non-extractable and sign-only', async () => {
    const importKey = vi.spyOn(globalThis.crypto.subtle, 'importKey');
    const hasher = expectOk(createRequestKeyHasher(SESSION_A));

    const first = expectOk(await hasher.compute('GET', '/api/items?limit=20'));
    const second = expectOk(await hasher.compute('POST', '/api/lookup'));
    const third = expectOk(await hasher.compute('GET', '/api/items?limit=20'));

    expect(importKey).toHaveBeenCalledTimes(1);
    expect(importKey.mock.calls[0]?.[0]).toBe('raw');
    expect(importKey.mock.calls[0]?.[3]).toBe(false);
    expect(importKey.mock.calls[0]?.[4]).toEqual(['sign']);

    expect(first).toBe(third);
    expect(first).not.toBe(second);
  });

  it('agrees with computeRequestKey for the same session key', async () => {
    const hasher = expectOk(createRequestKeyHasher(SESSION_A));

    expect(expectOk(await hasher.compute('GET', '/api/items?limit=20'))).toBe(
      await keyFor('GET', '/api/items?limit=20'),
    );
  });

  it('shares one in-flight import between concurrent computes', async () => {
    const importKey = vi.spyOn(globalThis.crypto.subtle, 'importKey');
    const hasher = expectOk(createRequestKeyHasher(SESSION_A));

    const results = await Promise.all([
      hasher.compute('GET', '/api/items?page=1'),
      hasher.compute('GET', '/api/items?page=2'),
      hasher.compute('GET', '/api/items?page=1'),
    ]);

    const digests = results.map((result) => expectOk(result));
    expect(importKey).toHaveBeenCalledTimes(1);
    expect(digests[0]).toBe(digests[2]);
    expect(digests[0]).not.toBe(digests[1]);
  });

  it('re-imports after a failed compute instead of replaying the failure', async () => {
    // Computed before the spy exists, so the count below measures the hasher
    // alone and not this expectation's own import.
    const expected = await keyFor('GET', '/api/items');
    const importKey = vi
      .spyOn(globalThis.crypto.subtle, 'importKey')
      .mockRejectedValueOnce(new Error('transient'));
    const hasher = expectOk(createRequestKeyHasher(SESSION_A));

    expect(expectErr(await hasher.compute('GET', '/api/items')).code).toBe('INTERNAL');
    expect(expectOk(await hasher.compute('GET', '/api/items'))).toBe(expected);
    expect(importKey).toHaveBeenCalledTimes(2);
  });

  it('validates the session key before any crypto is touched', () => {
    vi.stubGlobal('crypto', undefined);

    const error = expectErr(createRequestKeyHasher(MALFORMED_SESSION_KEY));

    expect(error.code).toBe('INTERNAL');
    expect(reportableText(error)).not.toContain(MALFORMED_SESSION_KEY);
  });
});
