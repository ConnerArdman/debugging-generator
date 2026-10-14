/**
 * Colocated suite for the sensitive-header handler.
 *
 * It pins one row of the AAP §0.5.2 deny-list table — for `authorization`,
 * `cookie`, `set-cookie`, `x-api-key`, `x-auth-token` and
 * `proxy-authorization` the **value is replaced with `[redacted]` while the
 * header's presence is retained** — which AAP §0.8.3 names as required
 * redaction coverage. Beyond that row the suite records the decisions
 * `./headers.ts` documents but a reader cannot otherwise verify: that the deny
 * list is exact rather than substring-based, that a sensitive name outside the
 * six is still masked one layer down by `scrubNamedValue`, that the returned
 * keys keep the caller's spelling, and that the handler is total — a throwing
 * getter or a hostile `Proxy` yields the marker instead of costing the rest of
 * an ingested batch.
 *
 * **Why the marker literal is asserted through the imported constant.** Every
 * expectation here compares against `REDACTION_MARKER` rather than a spelled
 * `'[redacted]'`, so a deliberate change to the marker moves this suite with
 * the implementation instead of failing it. Exactly one test spells the literal
 * out, because `packages/model-provider/src/redact-guard.ts` re-declares the
 * same bytes independently — AAP §0.2.2's package edge list forbids an import
 * between the two packages — and treats a denied header whose value *is* that
 * literal as already-safe rather than as a finding. The bytes are therefore a
 * cross-package contract, and that one test is where it is recorded.
 *
 * **Credential-shaped fixtures are assembled at runtime.** This file is tracked
 * and `scripts/check-secrets.mjs` scans tracked content with the same rule
 * classes `./rules.ts` implements, so no provider prefix, `Bearer`-scheme
 * credential or token body appears here as a contiguous literal: the helpers
 * below join short fragments, exactly as `./rules.ts` assembles its own
 * patterns. Even the scheme word is kept out of running prose in the form the
 * `bearer-token` pattern matches — a scheme word followed by whitespace and a
 * long run — so a scan of this file reports nothing to triage. The precedent is
 * `packages/model-provider/src/redact-guard.test.ts`.
 *
 * Fixtures are built inline for the same reason the handler takes no
 * configuration: a header set is three lines of object literal, and reading the
 * expectation next to its input is worth more than a shared fixture file. No
 * fixture is loaded from `packages/telemetry/test/fixtures/**`.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DENIED_HEADER_NAMES,
  headerNameFromAttributeKey,
  isDeniedHeaderName,
  isHeaderAttributeKey,
  isHeaderObjectAttributeKey,
  normalizeHeaderName,
  redactHeaderValue,
  redactHeaders,
} from './headers.js';
import type { HeaderRecord, HeaderValue } from './headers.js';
import { REDACTION_MARKER } from './rules.js';

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

/**
 * Presents a loosely typed fixture as the declared input type.
 *
 * `redactHeaders` is documented as total over values a producer can actually
 * send — a number, a `null`, an object, a throwing getter — while its exported
 * signature stays honest about what a *caller* should pass. Testing the runtime
 * guarantees therefore needs one narrowing assertion, and it lives here so the
 * robustness cases read as data rather than as casts.
 */
function looseHeaders(record: Record<string, unknown>): HeaderRecord {
  return record as HeaderRecord;
}

/**
 * A provider-shaped credential, assembled so the recognisable prefix never
 * appears as a contiguous literal in tracked source.
 *
 * The shape matches the `provider-key` rule of `./rules.ts`: the prefix
 * followed by a token body well over its sixteen-character minimum. It is
 * returned whole only at runtime, so the repository secret gate sees fragments.
 */
function assembleProviderCredential(): string {
  return ['s', 'k-', 'ant-', 'R7q', 'Ze2', 'Mv9', 'Xb4', 'Kt6', 'Lp1'].join('');
}

/**
 * The HTTP authentication scheme word, assembled for the same reason.
 *
 * It is needed on its own because the `bearer-token` rule captures the scheme
 * and replaces only the credential after it, so the scheme word is expected to
 * *survive* redaction — which is what makes an authenticated call still
 * diagnosable.
 */
function assembleBearerScheme(): string {
  return ['Bear', 'er'].join('');
}

/** A `Bearer`-scheme credential: the scheme word, a space, and a token body. */
function assembleBearerCredential(): string {
  return assembleBearerScheme() + ' ' + ['Qm4', 'Tz8', 'Wd1', 'Yr5'].join('');
}

/**
 * Asserts that `needle` appears nowhere in the serialised result.
 *
 * Checking the whole serialisation rather than one key is deliberate: a
 * handler that moved a value to a different key, kept it inside an array
 * element or reported it in a diagnostic field would still pass a per-key
 * assertion, and any of those would be a leak.
 */
function expectAbsent(result: Record<string, HeaderValue>, needle: string): void {
  expect(JSON.stringify(result)).not.toContain(needle);
}

/**
 * The deny-list table, derived from the exported constant rather than retyped,
 * so a name added to (or removed from) `DENIED_HEADER_NAMES` is covered by
 * these cases automatically instead of silently losing its test.
 *
 * Each fixture value is distinctive and deliberately *not* credential-shaped:
 * masking under a denied name is positional, so a value no content rule would
 * match is what proves the position drove the decision.
 */
const deniedHeaderCases = DENIED_HEADER_NAMES.map((name, index) => ({
  name,
  value: ['fixture', name, 'value', String(index)].join('-'),
}));

/*
 * ---------------------------------------------------------------------------
 * The marker literal: the one cross-package contract
 * ---------------------------------------------------------------------------
 */

describe('the redaction marker', () => {
  it('is the exact literal the outbound model guard re-declares', () => {
    // The ONLY place in this suite where the marker is spelled out. Its bytes
    // are a contract: `packages/model-provider/src/redact-guard.ts` declares
    // the same string independently (no import edge is permitted between the
    // two packages) and accepts a denied header carrying it as already-safe.
    // A change to the marker therefore has to be made in both places, and this
    // assertion is what stops it being made in only one.
    expect(REDACTION_MARKER).toBe('[redacted]');
    expect(redactHeaders({ Authorization: assembleBearerCredential() })).toEqual({
      Authorization: '[redacted]',
    });
  });
});

/*
 * ---------------------------------------------------------------------------
 * The deny list
 * ---------------------------------------------------------------------------
 */

describe('DENIED_HEADER_NAMES', () => {
  it('holds exactly the six names AAP §0.5.2 enumerates', () => {
    // Pinned as a list, not a count: the outbound guard mirrors these six by
    // hand, so an addition or a rename here is a change that has to be made
    // there too and must not pass silently.
    expect(DENIED_HEADER_NAMES).toEqual([
      'authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
      'x-auth-token',
      'proxy-authorization',
    ]);
  });

  it('is already normalised, so the list needs no folding at the call site', () => {
    for (const name of DENIED_HEADER_NAMES) {
      expect(normalizeHeaderName(name)).toBe(name);
      expect(isDeniedHeaderName(name)).toBe(true);
    }
  });
});

describe('redactHeaders on a denied header', () => {
  it.each(deniedHeaderCases)(
    'replaces the value of $name and keeps the header present',
    ({ name, value }) => {
      const result = redactHeaders({ [name]: value });

      // Presence retained: that a request carried this header explains an
      // authenticated call, a 401 or a cache miss (AAP §0.5.2).
      expect(Object.keys(result)).toEqual([name]);
      expect(result[name]).toBe(REDACTION_MARKER);
      // Value gone from the whole serialisation, not merely from its own key.
      expectAbsent(result, value);
    },
  );

  it.each(deniedHeaderCases)('reports $name as denied by name alone', ({ name }) => {
    expect(isDeniedHeaderName(name)).toBe(true);
  });

  it('masks only the denied headers of a realistic request set', () => {
    const result = redactHeaders({
      accept: 'application/json',
      authorization: assembleBearerCredential(),
      'content-type': 'application/json',
      cookie: 'a=1; b=2',
      'user-agent': 'node-fetch/3',
    });

    expect(result).toEqual({
      accept: 'application/json',
      authorization: REDACTION_MARKER,
      'content-type': 'application/json',
      cookie: REDACTION_MARKER,
      'user-agent': 'node-fetch/3',
    });
  });

  it('masks an empty denied value, because the classification is positional', () => {
    // Over-redaction is the safe direction for a privacy boundary, and the
    // outbound guard accepts the marker and an empty value alike.
    expect(redactHeaders({ cookie: '' })).toEqual({ cookie: REDACTION_MARKER });
  });

  it('leaves no fragment of a credential carried by a denied header', () => {
    const credential = assembleProviderCredential();
    const result = redactHeaders({ 'x-api-key': credential });

    expect(result['x-api-key']).toBe(REDACTION_MARKER);
    expectAbsent(result, credential);
    // Not even the token body without its prefix survives - the value is
    // replaced whole rather than pattern-matched.
    expectAbsent(result, credential.slice(-12));
  });
});

/*
 * ---------------------------------------------------------------------------
 * Name matching: case, padding and exactness
 * ---------------------------------------------------------------------------
 */

describe('deny-list matching ignores case and padding', () => {
  const spellings = ['Authorization', 'AUTHORIZATION', 'authorization', '  Authorization  '];

  it.each(spellings)('treats %j as the denied name', (spelling) => {
    expect(isDeniedHeaderName(spelling)).toBe(true);

    const result = redactHeaders({ [spelling]: assembleBearerCredential() });

    // The key comes back in the caller's spelling, padding and all, so a panel
    // can render the header exactly as it was sent.
    expect(Object.keys(result)).toEqual([spelling]);
    expect(result[spelling]).toBe(REDACTION_MARKER);
  });

  it('keeps the caller spelling of every key, denied or not', () => {
    const result = redactHeaders({
      'Set-Cookie': ['a=1'],
      'Proxy-Authorization': assembleBearerCredential(),
      Accept: '*/*',
    });

    expect(Object.keys(result)).toEqual(['Set-Cookie', 'Proxy-Authorization', 'Accept']);
    expect(result['Set-Cookie']).toEqual([REDACTION_MARKER]);
    expect(result['Proxy-Authorization']).toBe(REDACTION_MARKER);
    expect(result.Accept).toBe('*/*');
  });
});

describe('normalizeHeaderName', () => {
  it.each([
    { input: '  Authorization  ', expected: 'authorization' },
    { input: 'AUTHORIZATION', expected: 'authorization' },
    { input: 'X-API-KEY', expected: 'x-api-key' },
    { input: '\tSet-Cookie\n', expected: 'set-cookie' },
    { input: 'cookie', expected: 'cookie' },
    { input: '   ', expected: '' },
    { input: '', expected: '' },
  ])('normalises $input to $expected', ({ input, expected }) => {
    expect(normalizeHeaderName(input)).toBe(expected);
  });

  it('is idempotent, so a normalised name can be normalised again', () => {
    for (const name of ['  Proxy-Authorization ', 'X-Auth-Token', 'cookie']) {
      const once = normalizeHeaderName(name);
      expect(normalizeHeaderName(once)).toBe(once);
    }
  });

  it('trims only the ends and never rewrites separators inside the name', () => {
    // Separator folding belongs to the name vocabulary in `./rules.ts`, not
    // here: the deny-list comparison is exact, so `X_API_KEY` is not one of the
    // six even though it names the same thing.
    expect(normalizeHeaderName('X_API_KEY')).toBe('x_api_key');
    expect(isDeniedHeaderName('X_API_KEY')).toBe(false);
    // It is masked all the same, one layer down, by the key vocabulary.
    expect(redactHeaders({ X_API_KEY: 'v1' })).toEqual({ X_API_KEY: REDACTION_MARKER });
  });
});

describe('isDeniedHeaderName is exact, never a substring test', () => {
  const nearMisses = [
    'authorization-context',
    'x-api-keys',
    'x-authorization',
    'proxy-authorization-hint',
    'set-cookie-policy',
    'cookies',
  ];

  it.each(nearMisses)('does not report %s as one of the six', (name) => {
    expect(isDeniedHeaderName(name)).toBe(false);
  });

  it('masks the credential-carrying near-misses through the key vocabulary', () => {
    // Exactness above is not a gap: every non-denied value is routed through
    // `scrubNamedValue`, whose vocabulary covers names built from `key`,
    // `token`, `secret`, `password`, `credential` and `auth`.
    const result = redactHeaders({
      'authorization-context': 'ctx-42',
      'x-api-keys': 'k1,k2',
      'x-authorization': assembleBearerCredential(),
      'proxy-authorization-hint': 'upstream',
    });

    expect(result).toEqual({
      'authorization-context': REDACTION_MARKER,
      'x-api-keys': REDACTION_MARKER,
      'x-authorization': REDACTION_MARKER,
      'proxy-authorization-hint': REDACTION_MARKER,
    });
  });

  it('records that a near-miss naming no credential keeps its value', () => {
    // The decision this test exists to record: neither rule class fires for a
    // name that is not one of the six and is not key-like, so the value passes
    // through. `set-cookie-policy` states a policy and `cookies` is not the
    // header a browser sends - the carriers are spelled `cookie` and
    // `set-cookie`, and those two are denied above. Widening either rule to
    // catch these would mask ordinary diagnostic headers instead.
    expect(redactHeaders({ 'set-cookie-policy': 'strict', cookies: 'a=1' })).toEqual({
      'set-cookie-policy': 'strict',
      cookies: 'a=1',
    });
  });
});

/*
 * ---------------------------------------------------------------------------
 * The multi-value form
 * ---------------------------------------------------------------------------
 */

describe('the multi-value form', () => {
  it('masks a three-value set-cookie into three markers, count and order kept', () => {
    const values = ['session=a1; Path=/', 'flags=b2; HttpOnly', 'locale=c3; Secure'];
    const result = redactHeaders({ 'set-cookie': values });

    expect(result['set-cookie']).toEqual([REDACTION_MARKER, REDACTION_MARKER, REDACTION_MARKER]);
    // How many cookies a response set is diagnostic and carries no data, so the
    // element count survives while every value goes.
    expect(result['set-cookie']).toHaveLength(values.length);
    for (const value of values) {
      expectAbsent(result, value);
    }
  });

  it('returns a fresh array, never the caller instance', () => {
    // Ingest keeps the parsed event and the browser agent's batch is shared
    // across events, so an array from the input must never be stored.
    const values = ['session=a1', 'flags=b2', 'locale=c3'];
    const result = redactHeaders({ 'set-cookie': values });

    expect(result['set-cookie']).not.toBe(values);
    expect(values).toEqual(['session=a1', 'flags=b2', 'locale=c3']);
  });

  it('preserves order and content of a benign multi-value header', () => {
    // Three distinct values rather than three markers: order preservation is
    // only observable when the elements differ.
    const result = redactHeaders({ 'Accept-Encoding': ['gzip', 'br', 'deflate'] });

    expect(result['Accept-Encoding']).toEqual(['gzip', 'br', 'deflate']);
  });

  it('scrubs credential material element-wise in a benign multi-value header', () => {
    const result = redactHeaders({ 'x-debug-note': ['plain', assembleBearerCredential()] });

    expect(result['x-debug-note']).toEqual([
      'plain',
      assembleBearerScheme() + ' ' + REDACTION_MARKER,
    ]);
  });

  it('masks an empty multi-value header as an empty array', () => {
    expect(redactHeaders({ 'set-cookie': [] })).toEqual({ 'set-cookie': [] });
  });

  it('gives redactHeaderValue the same fresh-array guarantee', () => {
    const values = ['session=a1', 'flags=b2'];
    const masked = redactHeaderValue('Set-Cookie', values);

    expect(masked).toEqual([REDACTION_MARKER, REDACTION_MARKER]);
    expect(masked).not.toBe(values);
    expect(values).toEqual(['session=a1', 'flags=b2']);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Headers outside the deny list
 * ---------------------------------------------------------------------------
 */

describe('a sensitive header name outside the six', () => {
  it.each([
    'X-Refresh-Token',
    'X-Session-Secret',
    'X-Csrf-Token',
    'X-Signing-Credential',
    'Db-Password',
  ])('is masked because %s is key-like', (name) => {
    // The deny list is short on purpose (AAP §0.5.2 enumerates six names);
    // everything else sensitive is caught one layer down by `scrubNamedValue`'s
    // key vocabulary, which is why adding names here is unnecessary.
    expect(isDeniedHeaderName(name)).toBe(false);

    const result = redactHeaders({ [name]: 'value-to-hide' });

    expect(result[name]).toBe(REDACTION_MARKER);
    expectAbsent(result, 'value-to-hide');
  });
});

describe('a benign header', () => {
  it('passes through unchanged', () => {
    const headers = {
      'content-type': 'text/html; charset=utf-8',
      accept: '*/*',
      'x-request-id': 'req-7f3a',
    };

    expect(redactHeaders(headers)).toEqual(headers);
  });

  it('keeps a numeric or flag value readable', () => {
    expect(redactHeaders({ 'content-length': '2048', 'x-cache': 'HIT', age: '30' })).toEqual({
      'content-length': '2048',
      'x-cache': 'HIT',
      age: '30',
    });
  });

  it('loses a provider credential from its value and keeps the rest', () => {
    const result = redactHeaders({
      'x-debug-note': 'retry with ' + assembleProviderCredential() + ' later',
    });

    expect(result['x-debug-note']).toBe('retry with ' + REDACTION_MARKER + ' later');
    expectAbsent(result, assembleProviderCredential());
  });

  it('keeps the scheme word of a `Bearer` credential and drops the material after it', () => {
    // The scheme word survives so an authenticated call stays diagnosable;
    // only the material after it is replaced.
    const result = redactHeaders({
      'x-debug-note': 'saw ' + assembleBearerCredential() + ' expired',
    });

    expect(result['x-debug-note']).toBe(
      'saw ' + assembleBearerScheme() + ' ' + REDACTION_MARKER + ' expired',
    );
    expectAbsent(result, assembleBearerCredential());
  });
});

/*
 * ---------------------------------------------------------------------------
 * Robustness: a producer is not a compiler
 * ---------------------------------------------------------------------------
 */

describe('redactHeaders is total over what a producer can send', () => {
  it('omits a key whose value is undefined', () => {
    // An absent header is not data, and the telemetry event schema cannot
    // carry `undefined` inside `attributes`; keeping the key would turn a
    // missing header into a present one.
    const result = redactHeaders(looseHeaders({ accept: '*/*', 'if-none-match': undefined }));

    expect(result).toEqual({ accept: '*/*' });
    expect('if-none-match' in result).toBe(false);
    expect(Object.keys(result)).toEqual(['accept']);
  });

  it('coerces a numeric, boolean or bigint value to its string form', () => {
    // A loose producer's spelling of a numeric or flag header stringifies
    // faithfully, so the value stays useful instead of becoming a marker.
    const result = redactHeaders(
      looseHeaders({ 'content-length': 2048, 'x-cache-hit': true, 'x-retry-after': 10n }),
    );

    expect(result).toEqual({
      'content-length': '2048',
      'x-cache-hit': 'true',
      'x-retry-after': '10',
    });
  });

  it('masks a value with no faithful header form instead of passing it through', () => {
    // Guessing a string for an unexamined shape would mean sending it across
    // the privacy boundary, so every one of these becomes the marker.
    const result = redactHeaders(
      looseHeaders({
        'x-object': { nested: 'inner-value' },
        'x-array-of-objects': [{ nested: 'inner-value' }],
        'x-null': null,
        'x-function': () => 'computed',
        'x-symbol': Symbol('opaque'),
      }),
    );

    expect(result).toEqual({
      'x-object': REDACTION_MARKER,
      'x-array-of-objects': [REDACTION_MARKER],
      'x-null': REDACTION_MARKER,
      'x-function': REDACTION_MARKER,
      'x-symbol': REDACTION_MARKER,
    });
    expectAbsent(result, 'inner-value');
  });

  it('produces the whole record when one property has a throwing getter', () => {
    // Ingest processes batches: one hostile property must cost its own value
    // and nothing else.
    const throwingGetter = vi.fn((): string => {
      throw new Error('header read refused');
    });
    const record: Record<string, unknown> = { accept: '*/*' };
    Object.defineProperty(record, 'x-boom', {
      enumerable: true,
      configurable: true,
      get: throwingGetter,
    });
    record['content-type'] = 'text/plain';

    const result = redactHeaders(looseHeaders(record));

    expect(result).toEqual({
      accept: '*/*',
      'x-boom': REDACTION_MARKER,
      'content-type': 'text/plain',
    });
    expect(Object.keys(result)).toEqual(['accept', 'x-boom', 'content-type']);
    // The getter really was read - the record is total, not merely skipped.
    expect(throwingGetter).toHaveBeenCalledTimes(1);
  });

  it('masks a multi-value header whose elements cannot be read', () => {
    // A hostile `Proxy` collapses to a scalar marker: the header's presence
    // survives, its element count is unknowable and nothing is invented.
    const hostile = new Proxy(['session=a1', 'flags=b2'], {
      get(target, property, receiver): unknown {
        if (property === '0') {
          throw new Error('element read refused');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const result = redactHeaders({ 'set-cookie': hostile });

    expect(result['set-cookie']).toBe(REDACTION_MARKER);
  });

  it('yields an empty record when the header set cannot be enumerated', () => {
    const unenumerable = new Proxy(
      {},
      {
        ownKeys(): string[] {
          throw new Error('keys refused');
        },
      },
    );

    expect(redactHeaders(looseHeaders(unenumerable))).toEqual({});
  });

  it('yields an empty record for an empty header set', () => {
    expect(redactHeaders({})).toEqual({});
  });

  it('preserves key insertion order', () => {
    // A redacted event is compared and stored, so the output must be
    // byte-stable for the same input.
    const result = redactHeaders({
      'x-request-id': 'req-7f3a',
      Authorization: assembleBearerCredential(),
      'content-type': 'application/json',
      'set-cookie': ['session=a1'],
    });

    expect(Object.keys(result)).toEqual([
      'x-request-id',
      'Authorization',
      'content-type',
      'set-cookie',
    ]);
  });

  it('ignores symbol-keyed properties, which are never header data', () => {
    const record: Record<string, unknown> = { accept: '*/*' };
    Object.defineProperty(record, Symbol('cookie'), {
      enumerable: true,
      configurable: true,
      value: 'not-header-data',
    });

    const result = redactHeaders(looseHeaders(record));

    expect(result).toEqual({ accept: '*/*' });
    expectAbsent(result, 'not-header-data');
  });

  it('keeps a header named __proto__ as an own key and leaves the prototype alone', () => {
    // `Object.fromEntries` defines own data properties, so this name cannot
    // reassign the result's prototype the way an assignment loop would.
    const parsed = JSON.parse('{"__proto__":"pass-through","authorization":"x"}') as Record<
      string,
      unknown
    >;

    const result = redactHeaders(looseHeaders(parsed));

    expect(Object.keys(result)).toEqual(['__proto__', 'authorization']);
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toBe('pass-through');
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result.authorization).toBe(REDACTION_MARKER);
  });

  it('accepts an empty header name without special-casing it', () => {
    expect(redactHeaders({ '': 'value' })).toEqual({ '': 'value' });
  });
});

/*
 * ---------------------------------------------------------------------------
 * Properties the pipeline depends on
 * ---------------------------------------------------------------------------
 */

describe('redactHeaders as a function', () => {
  it('never mutates its input, directly or through a shared array', () => {
    const cookies = ['session=a1', 'flags=b2'];
    const input = {
      Authorization: assembleBearerCredential(),
      'set-cookie': cookies,
      accept: '*/*',
    };
    // A pristine clone built independently of `input`, so the comparison
    // cannot be satisfied by both sides changing together.
    const pristine = {
      Authorization: assembleBearerCredential(),
      'set-cookie': ['session=a1', 'flags=b2'],
      accept: '*/*',
    };
    const serialisedBefore = JSON.stringify(input);

    redactHeaders(input);

    expect(input).toEqual(pristine);
    expect(JSON.stringify(input)).toBe(serialisedBefore);
    expect(input['set-cookie']).toBe(cookies);
    expect(cookies).toEqual(['session=a1', 'flags=b2']);
  });

  it('is idempotent: a second pass changes nothing', () => {
    const headers = {
      Authorization: assembleBearerCredential(),
      'set-cookie': ['session=a1', 'flags=b2', 'locale=c3'],
      'content-type': 'application/json',
      'x-debug-note': 'saw ' + assembleBearerCredential() + ' expired',
      'x-refresh-token': 'value-to-hide',
    };

    const once = redactHeaders(headers);
    const twice = redactHeaders(once);

    expect(twice).toEqual(once);
    // Element counts stay stable rather than collapsing on the second pass.
    expect(twice['set-cookie']).toHaveLength(3);
  });

  it('leaves an already-marked value alone rather than re-marking it', () => {
    // This is what lets the outbound guard see a value equal to the marker and
    // conclude that this checkpoint ran.
    const alreadyMasked = {
      'x-debug-note': REDACTION_MARKER,
      'set-cookie': [REDACTION_MARKER, REDACTION_MARKER],
    };

    expect(redactHeaders(alreadyMasked)).toEqual(alreadyMasked);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Attribute-key helpers, as `./redactor.ts` uses them
 * ---------------------------------------------------------------------------
 */

/** Keys carrying a single header value on a span, in every spelling seen. */
const headerAttributeKeys = [
  'http.request.header.authorization',
  'http.response.header.set-cookie',
  'HTTP.Request.Header.X-Api-Key',
  '  http.request.header.cookie  ',
];

/** Keys that are not single-header attribute keys, and why each is not. */
const nonHeaderAttributeKeys = [
  // Ordinary span attributes handled by other rules.
  'http.method',
  'url',
  'db.statement',
  // A whole header map - `isHeaderObjectAttributeKey`'s business, not this one.
  'http.request.headers',
  // The prefix with no name after it, so it names no header.
  'http.request.header.',
  'http.request.header.   ',
  // A prefix that only looks like one.
  'header.authorization',
  'request.header.authorization',
  '',
];

describe('isHeaderAttributeKey', () => {
  it.each(headerAttributeKeys)('accepts %j', (key) => {
    expect(isHeaderAttributeKey(key)).toBe(true);
  });

  it.each(nonHeaderAttributeKeys)('rejects %j', (key) => {
    expect(isHeaderAttributeKey(key)).toBe(false);
  });
});

describe('headerNameFromAttributeKey', () => {
  it.each([
    { key: 'http.request.header.authorization', expected: 'authorization' },
    { key: 'HTTP.Response.Header.Set-Cookie', expected: 'Set-Cookie' },
    { key: 'http.response.header.set-cookie', expected: 'set-cookie' },
    { key: '  http.request.header.X-Api-Key  ', expected: 'X-Api-Key' },
  ])('reads $expected out of $key', ({ key, expected }) => {
    // The prefix is matched case-insensitively while the trailing segment keeps
    // its original spelling, so the caller can both compare it and display it.
    expect(headerNameFromAttributeKey(key)).toBe(expected);
  });

  it.each(nonHeaderAttributeKeys)('returns undefined for %j', (key) => {
    expect(headerNameFromAttributeKey(key)).toBeUndefined();
  });

  it('agrees with isHeaderAttributeKey on every key', () => {
    // The predicate is documented as equivalent to this comparison, which is
    // what guarantees an accepted key always yields a name for the redaction
    // call that follows.
    for (const key of [...headerAttributeKeys, ...nonHeaderAttributeKeys]) {
      expect(isHeaderAttributeKey(key)).toBe(headerNameFromAttributeKey(key) !== undefined);
    }
  });

  it('feeds the masking call exactly as redactHeaderValue documents', () => {
    // The dispatch `./redactor.ts` performs for a dotted span attribute.
    const key = 'http.request.header.Authorization';
    const name = headerNameFromAttributeKey(key) ?? key;

    expect(name).toBe('Authorization');
    expect(redactHeaderValue(name, assembleBearerCredential())).toBe(REDACTION_MARKER);
  });
});

describe('isHeaderObjectAttributeKey', () => {
  it.each([
    'headers',
    'requestHeaders',
    'responseHeaders',
    'http.request.headers',
    'http.response.headers',
  ])('accepts the declared key %j', (key) => {
    expect(isHeaderObjectAttributeKey(key)).toBe(true);
  });

  it.each([
    'HEADERS',
    'request_headers',
    'Response-Headers',
    'http_request_headers',
    '  headers  ',
  ])('accepts the case- and separator-variant %j', (key) => {
    // Producers spell this key in several ways, so the match folds case and
    // `[\s._-]` separators alike.
    expect(isHeaderObjectAttributeKey(key)).toBe(true);
  });

  it.each([
    'header',
    'headersSent',
    'url',
    'db.statement',
    'http.method',
    'cookie',
    'http.request.header.authorization',
    '',
  ])('rejects %j', (key) => {
    expect(isHeaderObjectAttributeKey(key)).toBe(false);
  });

  it('is disjoint from isHeaderAttributeKey', () => {
    // The two predicates route a key to different handlers, so no key may
    // satisfy both.
    for (const key of [
      ...headerAttributeKeys,
      'headers',
      'requestHeaders',
      'http.response.headers',
    ]) {
      expect(isHeaderAttributeKey(key) && isHeaderObjectAttributeKey(key)).toBe(false);
    }
  });

  it('marks the value a whole header map, which redactHeaders then masks', () => {
    const key = 'responseHeaders';
    const value: HeaderRecord = {
      'set-cookie': ['session=a1', 'flags=b2'],
      'content-type': 'application/json',
    };

    expect(isHeaderObjectAttributeKey(key)).toBe(true);

    const masked: Record<string, HeaderValue> = redactHeaders(value);

    expect(masked).toEqual({
      'set-cookie': [REDACTION_MARKER, REDACTION_MARKER],
      'content-type': 'application/json',
    });
  });
});
