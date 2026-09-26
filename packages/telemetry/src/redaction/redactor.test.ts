/**
 * Colocated suite for the privacy boundary's composition point
 * (`./redactor.ts`).
 *
 * This file is the executable form of AAP 0.5.2. Every `it` below is one
 * sentence of that section: headers masked by name, URL parameter values
 * masked while the path stays, bodies and row contents never captured, SQL
 * stored parameterised, React props and state carried as key names plus
 * bounded previews, and `request_key` — computed *before* redaction from the
 * unredacted URL — surviving untouched so duplicate-request analysis still
 * groups (AAP 0.5.2, 0.8.3).
 *
 * Four conventions hold throughout:
 *
 * - **Credential-shaped fixtures are assembled at runtime** from short
 *   fragments, never written as contiguous literals, so
 *   `scripts/check-secrets.mjs` sees no credential prefix, token body or
 *   credentialed connection string in the committed bytes (AAP 0.3.4). Each
 *   assembled value is fake by construction — a repeated character pair, a
 *   loopback host — authenticates against nothing, and carries far too little
 *   entropy to trip the secret gate's own bound.
 * - **Fixtures are neutral.** Components are `AlphaPanel` and `BetaRow`,
 *   routes are `/api/alpha` and `/api/beta`, the table is `items_t`. Nothing
 *   here names a component, service, model or route of the bundled demo
 *   application: this is tracked product source, and
 *   `scripts/check-no-hardcoding.mjs` fails the build if a demo identifier
 *   appears in it (AAP 0.5.4).
 * - **The schema is the final assertion.** Several tests re-parse the
 *   redacted event with `../schema/event.ts`. Both event schemas are strict,
 *   so an added or removed top-level key, an over-long `name` or an
 *   untransportable attribute value would break the ingest path — the failure
 *   mode an assertion on one field would miss.
 * - **Bounds come from their single declaration.** `MAX_PREVIEW_LENGTH`,
 *   `MAX_TRACKED_KEYS`, `MAX_ATTRIBUTE_DEPTH` and `MAX_ATTRIBUTE_NODES` are
 *   imported, never restated, so a change to a privacy bound fails here with
 *   its reason rather than with an off-by-one.
 * - **Fixtures are valid before they are redacted.** Every whole-event
 *   fixture is parsed with `../schema/event.ts` first (see
 *   {@link checkedEvent}), and its tier is derived from `KIND_ALLOWED_TIERS`
 *   rather than typed by hand, so a failure below means the redactor is
 *   wrong and never that the fixture was malformed.
 * - **The four committed corpora are loaded, not restated.** Inline fixtures
 *   cover the rules; `../../test/fixtures/redaction-*.json` are the *shared*
 *   before/after pairs of AAP 0.2.5, read by other checkpoints and by
 *   `docs/SECURITY.md`'s examples, and a corpus nothing loads can drift
 *   silently while every test here stays green. The suite therefore reads all
 *   four from disk, parses both sides with `../schema/event.ts` and asserts
 *   the redactor reproduces them — see
 *   {@link describe `the committed redaction corpora`}. That one filesystem
 *   read is the only I/O in this file; nothing here opens a socket, and the
 *   path is resolved with `fileURLToPath` rather than `new URL` for the
 *   reason given on {@link FIXTURE_DIRECTORY}.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ALL_ATTRIBUTE_KEYS,
  COMPONENT_TREE_ATTRIBUTE_KEYS,
  ERROR_ATTRIBUTE_KEYS,
  MAX_PREVIEW_LENGTH,
  MAX_TRACKED_KEYS,
  SERVICE_ASSIGNED_ATTRIBUTE_KEYS,
} from '../schema/attributes.js';
import {
  telemetryEventIngressSchema,
  telemetryEventSchema,
  type TelemetryEvent,
  type TelemetryEventIngress,
} from '../schema/event.js';
import {
  KIND_ALLOWED_TIERS,
  QUERY_KINDS,
  RENDER_KINDS,
  REQUEST_KINDS,
  type TelemetryKind,
  type TelemetryTier,
} from '../schema/kinds.js';
import { HEADER_OBJECT_ATTRIBUTE_KEYS } from './headers.js';
import {
  DROPPED_ATTRIBUTE_KEYS,
  MAX_ATTRIBUTE_DEPTH,
  MAX_ATTRIBUTE_NODES,
  STACK_ATTRIBUTE_KEYS,
  UNTRUNCATED_ATTRIBUTE_KEYS,
  redactAttributes,
  redactAttributesWithFindings,
  redactEvent,
  redactEventName,
  redactEventWithFindings,
} from './redactor.js';
import {
  MAX_SCAN_LENGTH,
  REDACTION_MARKER,
  REDACTION_MASK,
  TRUNCATION_SUFFIX,
  findDeniedRules,
  isHighEntropySecret,
} from './rules.js';
import { redactSqlStatement } from './sql.js';
import { isUrlAttributeKey, redactUrl } from './url.js';

/*
 * ---------------------------------------------------------------------------
 * Credential-shaped fixtures, assembled from fragments
 * ---------------------------------------------------------------------------
 */

/** A provider-credential-shaped value: split prefix, low-entropy repeated body. */
const PROVIDER_CREDENTIAL = 's' + 'k-ant-' + 'A1'.repeat(14);

/** The credential half of a bearer header value. */
const BEARER_BODY = 'B2'.repeat(24);

/** A bearer header value: the scheme word the rule keeps, then the credential. */
const BEARER_HEADER_VALUE = 'bearer ' + BEARER_BODY;

/** A JOSE compact-serialisation token, its identifying prefix split. */
const JOSE_TOKEN = 'ey' + 'J0eXAiOiJKV1QifQ.' + 'c3'.repeat(12) + '.' + 'd4'.repeat(12);

/**
 * The credential half of {@link CONNECTION_STRING}, named so the leak table
 * can search for the password alone as well as for the whole string.
 */
const CONNECTION_PASSWORD = 'e5'.repeat(6);

/** A credentialed connection string, scheme and userinfo assembled separately. */
const CONNECTION_STRING = 'pg' + 'sql://svc:' + CONNECTION_PASSWORD + '@127.0.0.1:5432/db_a';

/** The base64 body of {@link PEM_BLOCK}: key material by position, not by content. */
const PEM_BODY = 'MIIB' + 'f7'.repeat(20);

/** The label shared by a PEM block's opening and closing delimiter, split in two. */
const PEM_LABEL = 'RSA ' + 'PRIVATE' + ' KEY';

/**
 * The opening delimiter of {@link PEM_BLOCK}.
 *
 * Named separately because it holds no newline and can therefore be searched
 * for in JSON text, where the block's own line breaks are escaped.
 */
const PEM_HEADER = '-'.repeat(5) + 'BEGIN ' + PEM_LABEL + '-'.repeat(5);

/**
 * A PEM private-key block.
 *
 * Its delimiters are assembled from pieces — the dashes by repetition, the
 * label in two halves — so the committed bytes of this tracked file hold no
 * contiguous key header for `scripts/check-secrets.mjs` to report. That is
 * the same technique the gate itself uses on its own patterns, and the
 * assembled value is key material in shape only: the body is a repeated
 * character pair.
 */
const PEM_BLOCK =
  PEM_HEADER + '\n' + PEM_BODY + '\n' + '-'.repeat(5) + 'END ' + PEM_LABEL + '-'.repeat(5);

/**
 * An ordinary personal identifier, of the kind a real query string carries.
 *
 * Deliberately **not** credential-shaped: no deny-list pattern matches it, and
 * `scrub` leaves it exactly as it arrived. That is what makes it the right
 * fixture for the positional rules — a value that only masking a query
 * parameter can remove, so a test using it cannot pass because some content
 * rule happened to catch it on the way past. The domain is the reserved
 * `example.test`, which resolves nowhere.
 */
const CONTACT_ADDRESS = 'person' + '@example.test';

/**
 * An attribute **name** with no structure and high entropy: thirty-two
 * characters, each distinct.
 *
 * A producer that uses an opaque handle as an attribute name hands the walk a
 * name indistinguishable from a captured secret, which is the case
 * `deniedKeyNameRules` drops. Assembled from fragments and named without a
 * key-like term, so `scripts/check-secrets.mjs` sees neither a contiguous
 * high-entropy literal bound to a `key`/`token`/`secret`/`password` name nor
 * any provider prefix in the committed bytes (AAP 0.3.4). The tests that use
 * it assert `isHighEntropySecret` agrees, so the fixture's premise is checked
 * rather than assumed.
 */
const OPAQUE_ATTRIBUTE_NAME = 'A1b2C3d4' + 'E5f6G7h8' + 'I9j0K1l2' + 'M3n4O5p6';

/*
 * ---------------------------------------------------------------------------
 * Event fixtures
 *
 * Built by explicit factories rather than by spreading a `Partial`, so every
 * field is a concrete value under `exactOptionalPropertyTypes` and the
 * compiler checks each fixture against the schema's inferred type.
 * ---------------------------------------------------------------------------
 */

/** A valid epoch-millisecond timestamp inside the schema's bounds. */
const START_TIME = 1_800_000_000_123.456;

function eventOf(
  kind: TelemetryKind,
  tier: TelemetryTier,
  name: string,
  attributes: Record<string, unknown>,
): TelemetryEventIngress {
  return {
    id: 'evt_a1a1a1a1a1a1a1a1',
    traceId: 'abcdef0123456789abcdef0123456789',
    spanId: '0123456789abcdef',
    kind,
    name,
    startTime: START_TIME,
    duration: 12.5,
    tier,
    attributes,
    status: 'ok',
    producerId: 'prd_b2b2b2b2b2b2b2b2',
    seq: 7,
  };
}

function fetchEvent(attributes: Record<string, unknown>): TelemetryEventIngress {
  return eventOf('fetch', 'browser', 'GET /api/alpha', attributes);
}

function persistedEvent(
  kind: TelemetryKind,
  tier: TelemetryTier,
  name: string,
  attributes: Record<string, unknown>,
): TelemetryEvent {
  return {
    ...eventOf(kind, tier, name, attributes),
    sessionId: 'ses_c3c3c3c3c3c3c3c3',
    captureId: 'cap_d4d4d4d4d4d4d4d4',
    ingestSeq: 42,
  };
}

/** The attribute bag of a redacted event, for assertions that read one key. */
function attributesOf(event: TelemetryEventIngress): Record<string, unknown> {
  return event.attributes;
}

/**
 * The first tier `KIND_ALLOWED_TIERS` permits for a kind.
 *
 * A fixture's tier is *derived* rather than typed, because the event schema
 * cross-checks the kind/tier pair and a hand-written pair is the fixture
 * mistake that costs a debugging session: `db.query` on `browser` is rejected
 * by the schema, so a test written that way would fail for a reason that has
 * nothing to do with redaction.
 *
 * Every kind declares at least one tier, so the fallback is unreachable; it
 * exists only because `noUncheckedIndexedAccess` types the lookup as
 * optional, and `browser` is the honest choice — the tier of most kinds these
 * fixtures use. `checkedEvent` would reject a wrong pair anyway.
 */
function tierFor(kind: TelemetryKind): TelemetryTier {
  return KIND_ALLOWED_TIERS[kind][0] ?? 'browser';
}

/** An event of `kind` on a tier that kind allows, with no tier to get wrong. */
function eventOfKind(
  kind: TelemetryKind,
  name: string,
  attributes: Record<string, unknown>,
): TelemetryEventIngress {
  return eventOf(kind, tierFor(kind), name, attributes);
}

/**
 * Parses a fixture with the schema the ingest path parses a producer's event
 * with, and returns it unchanged.
 *
 * Redaction runs *after* validation in the real pipeline (validate → key →
 * redact → attribute → persist), so a fixture that the schema would have
 * rejected tests a state the redactor never sees. Asserting validity here
 * keeps every failure below attributable: it means the redactor is wrong, not
 * that the fixture was. The two deliberately invalid fixtures in this file —
 * the hostile bag the boundary has to make parseable, and the event with no
 * attribute bag at all — say so at their own call sites and skip this.
 */
function checkedEvent(event: TelemetryEventIngress): TelemetryEventIngress {
  const parsed = telemetryEventIngressSchema.safeParse(event);
  expect(parsed.success, `fixture for kind "${event.kind}" must be valid before redaction`).toBe(
    true,
  );
  return event;
}

/*
 * ---------------------------------------------------------------------------
 * The deny list
 * ---------------------------------------------------------------------------
 */

describe('redactAttributes — header values', () => {
  it('masks a denied header arriving as a span-attribute key, keeping the key', () => {
    const redacted = redactAttributes(
      {
        'http.request.header.authorization': BEARER_HEADER_VALUE,
        'http.request.header.x-alpha-trace': 'trace-1',
      },
      { kind: 'http.server' },
    );

    expect(redacted).toEqual({
      'http.request.header.authorization': REDACTION_MARKER,
      'http.request.header.x-alpha-trace': 'trace-1',
    });
  });

  it('masks every element of a multi-value header and keeps the count', () => {
    const redacted = redactAttributes({
      'http.response.header.set-cookie': ['a=1', 'b=2', 'c=3'],
    });

    expect(redacted['http.response.header.set-cookie']).toEqual([
      REDACTION_MARKER,
      REDACTION_MARKER,
      REDACTION_MARKER,
    ]);
  });

  it('masks a whole header map field by field, keeping casing and order', () => {
    const redacted = redactAttributes({
      requestHeaders: {
        Authorization: BEARER_HEADER_VALUE,
        'Content-Type': 'application/json',
        Cookie: 'sid=1',
      },
    });

    expect(redacted.requestHeaders).toEqual({
      Authorization: REDACTION_MARKER,
      'Content-Type': 'application/json',
      Cookie: REDACTION_MARKER,
    });
    expect(Object.keys(redacted.requestHeaders as Record<string, unknown>)).toEqual([
      'Authorization',
      'Content-Type',
      'Cookie',
    ]);
  });

  it('replaces a header map that did not arrive as a record', () => {
    const redacted = redactAttributes({
      responseHeaders: 'set-cookie: sid=1; authorization: ' + BEARER_HEADER_VALUE,
    });

    expect(redacted.responseHeaders).toBe(REDACTION_MARKER);
  });
});

describe('redactAttributes — content and name rules', () => {
  it('scrubs credential material out of an otherwise benign value', () => {
    const redacted = redactAttributes(
      {
        'log.message': 'startup used ' + PROVIDER_CREDENTIAL + ' from config',
        'logger.name': 'alpha',
      },
      { kind: 'log' },
    );

    expect(redacted['log.message']).toBe('startup used [redacted] from config');
    expect(redacted['logger.name']).toBe('alpha');
  });

  it('scrubs a JOSE token and a credentialed connection string', () => {
    const redacted = redactAttributes({
      'error.message': 'rejected ' + JOSE_TOKEN,
      'db.name': CONNECTION_STRING,
    });

    expect(redacted['error.message']).toBe('rejected [redacted]');
    expect(redacted['db.name']).toBe('pgsql://[redacted]@127.0.0.1:5432/db_a');
  });

  it('masks any value under a key-like name, whatever its type', () => {
    const redacted = redactAttributes({
      apiKey: 'short',
      'x-auth-token': 1234,
      sessionPassword: true,
      credentials: { user: 'svc', pass: 'e5e5' },
      emptySecret: '',
      absentToken: null,
    });

    expect(redacted).toEqual({
      apiKey: REDACTION_MARKER,
      'x-auth-token': REDACTION_MARKER,
      sessionPassword: REDACTION_MARKER,
      credentials: REDACTION_MARKER,
      emptySecret: '',
      absentToken: null,
    });
  });

  it('masks a key-like name nested inside an ordinary structure', () => {
    const redacted = redactAttributes({
      attribution: { container: 'alpha', apiKey: PROVIDER_CREDENTIAL },
    });

    expect(redacted.attribution).toEqual({ container: 'alpha', apiKey: REDACTION_MARKER });
  });
});

/*
 * ---------------------------------------------------------------------------
 * Service-assigned keys
 * ---------------------------------------------------------------------------
 */

describe('redactAttributes — service-assigned keys', () => {
  /**
   * 64 characters of hex: the shape `./request-key.ts` produces. Its name ends
   * in "key" and its value is dense, so both the name rule and an entropy
   * heuristic would destroy it — and `../aggregate/requests.ts` groups
   * duplicate requests by exactly this value.
   */
  const REQUEST_KEY = 'f6'.repeat(32);

  it('passes request_key through byte-for-byte at the top level', () => {
    const redacted = redactAttributes({ request_key: REQUEST_KEY }, { kind: 'fetch' });

    expect(redacted.request_key).toBe(REQUEST_KEY);
  });

  it('reports no redaction for an event whose only long value is request_key', () => {
    const { report } = redactAttributesWithFindings(
      { request_key: REQUEST_KEY },
      { kind: 'fetch' },
    );

    expect(report).toEqual({
      rules: [],
      droppedKeys: 0,
      truncatedValues: 0,
      maskedValues: 0,
    });
  });

  it('does not exempt a nested key of the same name', () => {
    const redacted = redactAttributes({ nested: { request_key: REQUEST_KEY } });
    const nested = redacted.nested as Record<string, unknown>;

    // Not exempt, so the preview bound applies: 64 characters survive here
    // only because they fit it.
    expect(nested.request_key).toBe(REQUEST_KEY);
    expect(redactAttributes({ nested: { request_key: 'f6'.repeat(200) } })).toEqual({
      nested: {
        request_key: 'f6'.repeat(200).slice(0, MAX_PREVIEW_LENGTH - 1) + TRUNCATION_SUFFIX,
      },
    });
  });

  it('redacts a non-scalar value a producer put under a service-assigned key', () => {
    const redacted = redactAttributes({ request_key: { forged: PROVIDER_CREDENTIAL } });

    expect(redacted.request_key).toEqual({ forged: REDACTION_MARKER });
  });
});

/*
 * ---------------------------------------------------------------------------
 * Bodies and row contents
 * ---------------------------------------------------------------------------
 */

describe('redactAttributes — dropped keys', () => {
  it('drops every declared body, row and parameter key', () => {
    const bag: Record<string, unknown> = { 'http.method': 'POST' };
    for (const key of DROPPED_ATTRIBUTE_KEYS) {
      bag[key] = { leaked: PROVIDER_CREDENTIAL };
    }

    const { attributes, report } = redactAttributesWithFindings(bag, { kind: 'fetch' });

    expect(attributes).toEqual({ 'http.method': 'POST' });
    expect(report.droppedKeys).toBe(DROPPED_ATTRIBUTE_KEYS.length);
  });

  it('drops a body key in any spelling', () => {
    const redacted = redactAttributes({
      request_body: 'a',
      'Response-Body': 'b',
      REQUESTBODY: 'c',
      'db.rowCount': 4,
    });

    expect(redacted).toEqual({ 'db.rowCount': 4 });
  });

  it('drops no key the attribute catalog declares', () => {
    const folded = (key: string): string => key.toLowerCase().replace(/[\s._-]/g, '');
    const droppedFolds = new Set(DROPPED_ATTRIBUTE_KEYS.map(folded));

    expect(ALL_ATTRIBUTE_KEYS.filter((key) => droppedFolds.has(folded(key)))).toEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * URLs
 * ---------------------------------------------------------------------------
 */

describe('redactAttributes — URLs', () => {
  it('masks query parameter values per key and keeps method, path and host', () => {
    const redacted = redactAttributes(
      {
        'http.method': 'GET',
        url: 'http://127.0.0.1:20450/api/alpha?itemId=A17&mode=full',
        'http.status_code': 200,
      },
      { kind: 'fetch' },
    );

    expect(redacted).toEqual({
      'http.method': 'GET',
      url: `http://127.0.0.1:20450/api/alpha?itemId=${REDACTION_MASK}&mode=${REDACTION_MASK}`,
      'http.status_code': 200,
    });
  });

  it('masks userinfo and recognises the conventional URL spellings', () => {
    const redacted = redactAttributes({
      'http.target': '/api/beta?q=1',
      documentUrl: 'http://svc:' + 'e5'.repeat(6) + '@127.0.0.1:20450/api/beta',
      'initiator.type': 'script',
    });

    expect(redacted['http.target']).toBe(`/api/beta?q=${REDACTION_MASK}`);
    expect(redacted.documentUrl).toBe(`http://${REDACTION_MARKER}@127.0.0.1:20450/api/beta`);
    expect(redacted['initiator.type']).toBe('script');
  });

  it('never truncates a URL to the preview bound', () => {
    const longUrl = 'http://127.0.0.1:20450/api/alpha/' + 'x'.repeat(MAX_PREVIEW_LENGTH * 2);
    const redacted = redactAttributes({ url: longUrl }, { kind: 'xhr' });

    expect(redacted.url).toBe(longUrl);
  });

  it('exempts exactly the structural keys from the preview bound', () => {
    expect([...UNTRUNCATED_ATTRIBUTE_KEYS]).toEqual([
      'db.statement',
      'url',
      'http.url',
      'http.target',
      'target',
      'error.source',
      'initiator',
    ]);
  });

  it("routes an error event's source URL through the URL handler", () => {
    // `../browser/errors.ts` records `error.source` verbatim from
    // `ErrorEvent.filename` or a failing element's `src`, so it is an
    // ordinary page URL with an ordinary query string on it. The key ends in
    // `source`, not `url`, so the suffix rule does not reach it and
    // membership in `URL_ATTRIBUTE_KEYS` is what masks it.
    expect(ERROR_ATTRIBUTE_KEYS).toContain('error.source');
    expect(isUrlAttributeKey('error.source')).toBe(true);

    const redacted = redactAttributes(
      {
        'error.type': 'TypeError',
        'error.message': 'Cannot read properties of undefined',
        'error.source': `http://127.0.0.1:20450/checkout?email=${CONTACT_ADDRESS}&step=2`,
        component: 'AlphaPanel',
      },
      { kind: 'error' },
    );

    expect(redacted['error.source']).toBe(
      `http://127.0.0.1:20450/checkout?email=${REDACTION_MASK}&step=${REDACTION_MASK}`,
    );
    expect(JSON.stringify(redacted)).not.toContain(CONTACT_ADDRESS);
    expect(redacted['error.type']).toBe('TypeError');
    expect(redacted.component).toBe('AlphaPanel');
  });

  it('never truncates an error source URL to the preview bound', () => {
    // The source-map resolution route reads the whole value, exactly as it
    // does for a request URL, so the key belongs to the untruncated set.
    const longSource = 'http://127.0.0.1:20450/static/' + 'y'.repeat(MAX_PREVIEW_LENGTH * 2);
    const redacted = redactAttributes({ 'error.source': longSource }, { kind: 'error' });

    expect(redacted['error.source']).toBe(longSource);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Stack text
 *
 * A stack is the one captured value that holds URLs *inside* other text, and
 * the initiator is exempt from the preview bound, so the whole of it travels.
 * Query masking is positional — `scrub` cannot do it — which is why these
 * fixtures carry {@link CONTACT_ADDRESS} rather than a credential: a content
 * rule must not be able to pass the test on the URL handler's behalf.
 * ---------------------------------------------------------------------------
 */

/** A dev-server chunk URL, which carries a cache-busting query like any other. */
const CHUNK_FRAME_URL = 'http://127.0.0.1:20450/_next/static/chunks/alpha.js';

/** A served source URL with a position and no query: the frame that resolves. */
const SOURCE_FRAME_URL = 'http://127.0.0.1:20450/src/lib/alpha-client.ts:31:9';

/** A bundler's own module identifier, which is not an `http` URL at all. */
const INTERNAL_FRAME = 'webpack-internal:///./src/lib/alpha-client.ts:7:11';

/** A three-frame initiator stack, as `../browser/fetch.ts` captures one. */
function initiatorStack(): string {
  return (
    'Error\n' +
    `    at send (${CHUNK_FRAME_URL}?email=${CONTACT_ADDRESS}:42:17)\n` +
    `    at flush (${SOURCE_FRAME_URL})\n` +
    `    at commit (${INTERNAL_FRAME})`
  );
}

describe('redactAttributes — stack text', () => {
  it('names exactly the declared stack keys', () => {
    expect([...STACK_ATTRIBUTE_KEYS]).toEqual(['initiator', 'error.stack']);
  });

  it('masks query values inside an initiator stack and keeps every frame', () => {
    const redacted = redactAttributes(
      {
        url: `http://127.0.0.1:20450/api/alpha?email=${CONTACT_ADDRESS}`,
        initiator: initiatorStack(),
      },
      { kind: 'fetch' },
    );

    expect(redacted.initiator).toBe(
      'Error\n' +
        // The chunk URL's query value is masked and the position the runtime
        // appended survives, because the run sits in a recognised frame — the
        // position is what AAP 0.4.2's source-map route resolves.
        `    at send (${CHUNK_FRAME_URL}?email=${REDACTION_MASK}:42:17)\n` +
        // No query at all, so the frame survives byte-identical.
        `    at flush (${SOURCE_FRAME_URL})\n` +
        // Not an `http` URL: left exactly as the bundler wrote it.
        `    at commit (${INTERNAL_FRAME})`,
    );
    expect(JSON.stringify(redacted)).not.toContain(CONTACT_ADDRESS);
  });

  it('keeps a queried frame resolvable end to end through redactAttributes', () => {
    // The composition the source-map route actually sees: `scrub` first, then
    // the URL masking, then the untruncated-key exemption. What comes out must
    // still carry the file, the line and the column of every frame.
    const redacted = redactAttributes(
      {
        initiator:
          `Error\n` +
          `    at send (${CHUNK_FRAME_URL}?v=1730&email=${CONTACT_ADDRESS}:42:17)\n` +
          `    at boot (http://127.0.0.1:20450/app#${CONTACT_ADDRESS}:3:5)`,
      },
      { kind: 'fetch' },
    );

    expect(redacted.initiator).toBe(
      `Error\n` +
        `    at send (${CHUNK_FRAME_URL}?v=${REDACTION_MASK}&email=${REDACTION_MASK}:42:17)\n` +
        `    at boot (http://127.0.0.1:20450/app#${REDACTION_MASK}:3:5)`,
    );
    expect(String(redacted.initiator)).not.toContain(CONTACT_ADDRESS);
    expect(redactAttributes(redacted, { kind: 'fetch' })).toEqual(redacted);
  });

  it('reports the truncation of an over-bound stack, whatever the cut fell on', () => {
    // `scrub`'s bound cuts long stack text and appends the marker. Both passes
    // have to agree about it: the marker must still be there afterwards —
    // "something was removed here" is a fact the developer needs — the value
    // must stay inside the bound and free of the parameter, and the result
    // must be a fixed point so the second redaction changes nothing.
    const frame = `    at send (${CHUNK_FRAME_URL}?email=${CONTACT_ADDRESS}:42:17)\n`;
    const redacted = redactAttributes(
      { initiator: frame.repeat(Math.ceil((MAX_SCAN_LENGTH * 2) / frame.length)) },
      { kind: 'fetch' },
    );
    const initiator = String(redacted.initiator);

    expect(initiator.endsWith(REDACTION_MARKER)).toBe(true);
    expect(initiator).not.toContain(CONTACT_ADDRESS);
    expect(initiator.length).toBeLessThanOrEqual(MAX_SCAN_LENGTH);
    expect(redactAttributes(redacted, { kind: 'fetch' })).toEqual(redacted);
  });

  it("moves the marker to its own line when the bound cut a frame's URL", () => {
    // The case that used to destroy it: the cut lands *inside* a URL, so
    // `scrub` leaves `…http://1[redacted]` with nothing between, and the URL
    // scan would otherwise read the marker as query text and mask it away.
    // The padding puts the last frame's URL across the bound deterministically.
    const pad = 'x'.repeat(MAX_SCAN_LENGTH - REDACTION_MARKER.length - 30);
    const redacted = redactAttributes(
      {
        initiator: `${pad}\n    at send (${CHUNK_FRAME_URL}?email=${CONTACT_ADDRESS}:42:17)`,
      },
      { kind: 'fetch' },
    );
    const initiator = String(redacted.initiator);

    expect(initiator.endsWith(`\n${REDACTION_MARKER}`)).toBe(true);
    expect(initiator).not.toContain(CONTACT_ADDRESS);
    expect(initiator.length).toBeLessThanOrEqual(MAX_SCAN_LENGTH);
    expect(redactAttributes(redacted, { kind: 'fetch' })).toEqual(redacted);
  });

  it('masks a URL inside an error stack and reports the query-value rule', () => {
    const { attributes, report } = redactAttributesWithFindings(
      {
        'error.type': 'TypeError',
        'error.stack': `at load (http://127.0.0.1:20450/a.js?email=${CONTACT_ADDRESS}:1:1)`,
      },
      { kind: 'error' },
    );

    expect(attributes['error.stack']).toBe(
      `at load (http://127.0.0.1:20450/a.js?email=${REDACTION_MASK}:1:1)`,
    );
    expect(report.rules).toContain('url-query-value');
    expect(report.maskedValues).toBe(1);
  });

  it('recognises the conventional stack spellings', () => {
    const redacted = redactAttributes({
      componentStack: `at AlphaPanel (http://127.0.0.1:20450/b.js?email=${CONTACT_ADDRESS})`,
      'cause.stack': `at boot (http://127.0.0.1:20450/c.js?email=${CONTACT_ADDRESS})`,
    });

    expect(redacted.componentStack).toBe(
      `at AlphaPanel (http://127.0.0.1:20450/b.js?email=${REDACTION_MASK})`,
    );
    expect(redacted['cause.stack']).toBe(
      `at boot (http://127.0.0.1:20450/c.js?email=${REDACTION_MASK})`,
    );
  });

  it('leaves a stack whose frames carry no URL untouched', () => {
    // The frames `../browser/fetch.ts` produces for application source are
    // project-relative paths with no scheme, and nothing in them is maskable.
    const stack =
      'at send (src/lib/alpha-client.ts:18:3)\n    at flush (src/lib/alpha-client.ts:31:9)';

    expect(redactAttributes({ initiator: stack }, { kind: 'fetch' }).initiator).toBe(stack);
  });

  it('masks a stack idempotently', () => {
    const once = redactAttributes({ initiator: initiatorStack() }, { kind: 'fetch' });
    const twice = redactAttributes(once, { kind: 'fetch' });

    expect(twice).toEqual(once);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Key names
 *
 * Every other block here judges a value. An attribute bag's *names* are as
 * page-supplied as its values, so a name can be the secret rather than label
 * one, and a walk that redacted only values re-emitted it verbatim.
 * ---------------------------------------------------------------------------
 */

describe('redactAttributes — key names', () => {
  it('drops an attribute whose key name is itself a credential', () => {
    const { attributes, report } = redactAttributesWithFindings({
      component: 'AlphaPanel',
      [PROVIDER_CREDENTIAL]: 'cache-hit',
    });

    expect(Object.keys(attributes)).toEqual(['component']);
    expect(report.rules).toContain('provider-key');
    expect(report.droppedKeys).toBe(1);
    expect(JSON.stringify(attributes)).not.toContain(PROVIDER_CREDENTIAL);
  });

  it('drops an opaque high-entropy key name and reports the entropy rule', () => {
    // The fixture's premise, checked rather than assumed: this name is what
    // the entropy test is for.
    expect(isHighEntropySecret(OPAQUE_ATTRIBUTE_NAME)).toBe(true);

    const { attributes, report } = redactAttributesWithFindings({
      component: 'AlphaPanel',
      [OPAQUE_ATTRIBUTE_NAME]: 'cache-hit',
    });

    expect(Object.keys(attributes)).toEqual(['component']);
    expect(report.rules).toContain('entropy');
  });

  it('records a dropped key name as the marker, never as the name', () => {
    // `normalizePath` scrubs a path by content, which a high-entropy name
    // survives, so the name must not reach the path list at all — the
    // `redacted` list travels on the event and is serialised with it.
    const event = checkedEvent(
      eventOfKind('log', 'boot alpha', {
        component: 'AlphaPanel',
        [OPAQUE_ATTRIBUTE_NAME]: 'cache-hit',
      }),
    );

    const redacted = redactEvent(event);

    expect(redacted.redacted).toEqual([REDACTION_MARKER]);
    expect(JSON.stringify(redacted)).not.toContain(OPAQUE_ATTRIBUTE_NAME);
  });

  it('drops a secret-named key at any depth, with its subtree', () => {
    expect(redactAttributes({ detail: { [PROVIDER_CREDENTIAL]: { nested: 1 } } })).toEqual({
      detail: {},
    });
  });

  it('keeps a secret-shaped name out of the path list when a bound drops the key', () => {
    // The bound's exit records a path too, and it is reached before the value
    // is ever looked at — so the name rule has to run first or a key past the
    // node budget rides out on the `redacted` list it populates.
    const event = checkedEvent(
      eventOfKind('log', 'boot alpha', {
        component: 'AlphaPanel',
        [OPAQUE_ATTRIBUTE_NAME]: 'cache-hit',
      }),
    );

    // A budget of one node: the first key is emitted, and the second is
    // dropped by the bound before the name rule's own exit is reached.
    const { event: redacted, report } = redactEventWithFindings(event, { maxNodes: 1 });

    expect(redacted.attributes).toEqual({ component: 'AlphaPanel' });
    expect(redacted.redacted).toEqual([REDACTION_MARKER]);
    expect(report.droppedKeys).toBe(1);
    // Reported whichever exit took the key: the report states what the bag
    // held, not what fitted inside a bound.
    expect(report.rules).toContain('entropy');
    expect(JSON.stringify(redacted)).not.toContain(OPAQUE_ATTRIBUTE_NAME);
  });

  it('never reads the value of a secret-named key', () => {
    // The name is judged before the property is read, so a getter on a
    // secret-named key does not run — a page's object can do anything in one.
    let read = 0;
    const bag: Record<string, unknown> = { component: 'AlphaPanel' };
    Object.defineProperty(bag, PROVIDER_CREDENTIAL, {
      enumerable: true,
      get: () => {
        read += 1;
        return 'cache-hit';
      },
    });

    expect(Object.keys(redactAttributes(bag))).toEqual(['component']);
    expect(read).toBe(0);
  });

  it('keeps an ordinary application name, and masks the value under a key-like one', () => {
    // A key *called* `apiKey` is a useful attribute name: its value is
    // replaced, and the key stays so the developer can see the field was
    // there. Dropping it would hide the evidence instead of the secret.
    expect(redactAttributes({ customerLabel: 'Alpha Industrial', apiKey: 'F9'.repeat(8) })).toEqual(
      {
        customerLabel: 'Alpha Industrial',
        apiKey: REDACTION_MARKER,
      },
    );
  });

  it('keeps every key name the catalog declares', () => {
    // The regression guard for the name rule: a heuristic that reached a
    // declared name would delete evidence on every event of that kind, and
    // `request_key` is the name it would reach first.
    //
    // The component-tree key is judged by its *value* as well: its handler
    // re-serialises a parsed forest and omits the key when there is no
    // document to parse (a `null` is not one), so it is fed the smallest valid
    // forest — one named node — instead. The name rule is what this case is
    // about.
    const componentTreeKeys: ReadonlySet<string> = new Set<string>(COMPONENT_TREE_ATTRIBUTE_KEYS);
    const minimalForest = JSON.stringify([{ name: 'App' }]);
    for (const key of ALL_ATTRIBUTE_KEYS) {
      const value = componentTreeKeys.has(key) ? minimalForest : null;
      expect(redactAttributes({ [key]: value })).toHaveProperty([key]);
    }
  });

  it('masks the search parameter values a component-tree React key embeds, and keeps every other key', () => {
    // Next.js keys a page segment by its search parameters, serialised as JSON
    // after a `?`: a query in all but syntax, so its values never travel.
    const planted = 'cf53ae80c4bc5e0040c5357c';
    const forest = [
      {
        name: 'Head',
        key: `/__PAGE__?{"probe":"${planted}","page":"2"}`,
        children: [
          { name: 'Row', key: 'row?id=42&sort=asc' },
          { name: 'Layout', key: 'layout' },
          { name: 'Card', key: 48 },
        ],
      },
    ];

    const redacted = redactAttributes({ componentTree: JSON.stringify(forest) });
    const text = redacted['componentTree'];

    expect(typeof text).toBe('string');
    expect(String(text)).not.toContain(planted);
    const [head] = JSON.parse(String(text)) as [
      { key: string; children: readonly { key?: string }[] },
    ];
    expect(head.key).toBe('/__PAGE__?{"probe":"?","page":"?"}');
    expect(head.children.map((child) => child.key)).toEqual(['row?id=?&sort=?', 'layout', '48']);
    // Idempotent: the masked document masks to itself.
    expect(redactAttributes({ componentTree: text })['componentTree']).toBe(text);
  });

  it('keeps the service-assigned request key, name and value', () => {
    const requestKey = 'a1'.repeat(32);

    expect(
      redactAttributes({ request_key: requestKey, url: '/api/alpha' }, { kind: 'fetch' }),
    ).toEqual({
      request_key: requestKey,
      url: '/api/alpha',
    });
  });

  it.each([...HEADER_OBJECT_ATTRIBUTE_KEYS])(
    'drops a credential-shaped member name inside %s',
    (attributeKey) => {
      // `./headers.ts` keeps every member key so a denied header's presence
      // survives with its value masked — which makes a header map the one
      // place a page-supplied name reaches the event without the walk's own
      // key rule seeing it. A page may name a request header anything.
      const { attributes, report } = redactAttributesWithFindings(
        {
          [attributeKey]: {
            accept: 'application/json',
            authorization: BEARER_HEADER_VALUE,
            [PROVIDER_CREDENTIAL]: 'cache-hit',
            [OPAQUE_ATTRIBUTE_NAME]: 'cache-hit',
          },
        },
        { kind: 'fetch' },
      );

      expect(attributes[attributeKey]).toEqual({
        accept: 'application/json',
        // Presence retained, value masked: the guarantee stays intact.
        authorization: REDACTION_MARKER,
      });
      expect(report.droppedKeys).toBe(2);
      expect(report.rules).toContain('provider-key');
      expect(report.rules).toContain('entropy');

      const serialised = JSON.stringify(attributes);
      expect(serialised).not.toContain(PROVIDER_CREDENTIAL);
      expect(serialised).not.toContain(OPAQUE_ATTRIBUTE_NAME);
    },
  );

  it('keeps a secret-shaped header member name out of the path list', () => {
    const event = checkedEvent(
      eventOfKind('fetch', 'fetch GET /api/alpha', {
        'http.request.headers': { accept: 'application/json', [PROVIDER_CREDENTIAL]: 'cache-hit' },
      }),
    );

    const redacted = redactEvent(event);

    // The recorded path is the *attribute's*, which is declared vocabulary;
    // the member name appears nowhere, in the bag or in the provenance list.
    expect(redacted.redacted).toEqual(['http.request.headers']);
    expect(JSON.stringify(redacted)).not.toContain(PROVIDER_CREDENTIAL);
  });

  it('judges a header attribute key by its header name alone', () => {
    // Retaining a denied header's presence is a stated guarantee, so the
    // declared `http.request.header.` prefix cannot be what condemns a key;
    // only the protocol token after it is judged, and a header no client
    // could have sent is dropped.
    const redacted = redactAttributes(
      {
        'http.request.header.authorization': BEARER_HEADER_VALUE,
        ['http.request.header.' + PROVIDER_CREDENTIAL]: 'cache-hit',
      },
      { kind: 'fetch' },
    );

    expect(redacted).toEqual({ 'http.request.header.authorization': REDACTION_MARKER });
  });
});

/*
 * ---------------------------------------------------------------------------
 * SQL
 * ---------------------------------------------------------------------------
 */

describe('redactAttributes — statements', () => {
  it('leaves a parameterised statement untouched and keeps the row count', () => {
    const redacted = redactAttributes(
      {
        'db.system': 'postgresql',
        'db.statement': 'SELECT id FROM items_t WHERE id = $1',
        'db.rowCount': 128,
        'db.client': 'pg',
      },
      { kind: 'db.query' },
    );

    expect(redacted).toEqual({
      'db.system': 'postgresql',
      'db.statement': 'SELECT id FROM items_t WHERE id = $1',
      'db.rowCount': 128,
      'db.client': 'pg',
    });
  });

  it('masks every inline literal in a statement, on any kind', () => {
    const redacted = redactAttributes({
      'db.statement': "SELECT id FROM items_t WHERE code = 'A17' AND qty = 42",
    });

    expect(redacted['db.statement']).toBe(
      `SELECT id FROM items_t WHERE code = ${REDACTION_MASK} AND qty = ${REDACTION_MASK}`,
    );
  });

  it('treats a conventional statement spelling as SQL only on a query kind', () => {
    const statement = "SELECT id FROM items_t WHERE code = 'A17'";

    expect(redactAttributes({ sql: statement }, { kind: 'db.query' }).sql).toBe(
      `SELECT id FROM items_t WHERE code = ${REDACTION_MASK}`,
    );
    // On a log event the same key is not a statement, so the value takes the
    // generic path: scrubbed by content and bounded to the preview length.
    expect(redactAttributes({ sql: statement }, { kind: 'log' }).sql).toBe(statement);
  });
});

/*
 * ---------------------------------------------------------------------------
 * React prop and state previews
 * ---------------------------------------------------------------------------
 */

describe('redactAttributes — preview families', () => {
  it('keeps changed prop names while scrubbing and bounding their previews', () => {
    const redacted = redactAttributes(
      {
        component: 'AlphaPanel',
        trigger: 'props',
        changedProps: [
          {
            key: 'itemCount',
            previous: { type: 'number', preview: '3', truncated: false },
            next: { type: 'number', preview: '4', truncated: false },
          },
          {
            key: 'sessionHint',
            previous: {
              type: 'string',
              preview: '"' + PROVIDER_CREDENTIAL + '"',
              truncated: false,
            },
            next: {
              type: 'string',
              preview: '"' + 'y'.repeat(MAX_PREVIEW_LENGTH * 2) + '"',
              truncated: true,
            },
          },
        ],
      },
      { kind: 'render' },
    );

    const entries = redacted.changedProps as Record<string, unknown>[];
    const first = entries[0] as Record<string, unknown>;
    const second = entries[1] as Record<string, unknown>;
    const secondNext = second.next as Record<string, unknown>;

    expect(first).toEqual({
      key: 'itemCount',
      previous: { type: 'number', preview: '3', truncated: false },
      next: { type: 'number', preview: '4', truncated: false },
    });
    expect(second.key).toBe('sessionHint');
    expect((second.previous as Record<string, unknown>).preview).toBe(`"${REDACTION_MARKER}"`);
    expect((secondNext.preview as string).length).toBe(MAX_PREVIEW_LENGTH);
    expect(secondNext.preview as string).toMatch(new RegExp(`${TRUNCATION_SUFFIX}$`));
  });

  it('keeps hook labels and scrubs state value summaries by content', () => {
    const redacted = redactAttributes(
      {
        component: 'BetaRow',
        hookIndex: 2,
        hookLabel: 'sessionState',
        previousValue: { type: 'string', preview: BEARER_HEADER_VALUE, truncated: false },
        nextValue: {
          type: 'string',
          preview: '"' + PROVIDER_CREDENTIAL + '"',
          truncated: false,
        },
        triggerEventId: 'evt_e5e5e5e5e5e5e5e5',
      },
      { kind: 'state' },
    );

    // The label is evidence and survives; both previews are scrubbed by the
    // content rules, which keep the bearer scheme word because its presence
    // is diagnostic and the credential is what goes.
    expect(redacted.hookLabel).toBe('sessionState');
    expect((redacted.previousValue as Record<string, unknown>).preview).toBe(
      `bearer ${REDACTION_MARKER}`,
    );
    expect((redacted.nextValue as Record<string, unknown>).preview).toBe(`"${REDACTION_MARKER}"`);
  });

  it('bounds a preview a summary claimed was already bounded', () => {
    // The division of labour, stated as a test: `../browser/fiber-diff.ts`
    // applies the *name* rule with each prop's own name and bounds the
    // preview; this module re-applies the content rules and the bound, and
    // cannot re-derive a name it was never given. A value that is neither
    // credential-shaped nor under a telling key therefore survives, bounded
    // — which is exactly what a 120-character summary of an application value
    // is meant to be.
    const dense = BEARER_BODY.repeat(4);
    const redacted = redactAttributes(
      { previousValue: { type: 'string', preview: dense, truncated: false } },
      { kind: 'state' },
    );
    const preview = (redacted.previousValue as Record<string, unknown>).preview as string;

    expect(preview.length).toBe(MAX_PREVIEW_LENGTH);
    expect(preview.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  it('applies the name rule to the same key outside its kind family', () => {
    const bag = { changedProps: [{ key: 'itemCount' }] };

    // On a render event `key` names a prop and must survive.
    const asRender = redactAttributes(bag, { kind: 'render' });
    expect(
      ((asRender.changedProps as Record<string, unknown>[])[0] as Record<string, unknown>).key,
    ).toBe('itemCount');

    // On any other kind the same field is an unknown value under a key-like
    // name, and over-redaction is the safe direction.
    const asLog = redactAttributes(bag, { kind: 'log' });
    expect(
      ((asLog.changedProps as Record<string, unknown>[])[0] as Record<string, unknown>).key,
    ).toBe(REDACTION_MARKER);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Generic values
 * ---------------------------------------------------------------------------
 */

describe('redactAttributes — generic values', () => {
  it('passes numbers, booleans and null through unchanged', () => {
    const bag = {
      actualDuration: 4.25,
      renderCount: 12,
      sameOrigin: true,
      traceparentInjected: false,
      hookLabel: null,
    };

    expect(redactAttributes(bag)).toEqual(bag);
  });

  it('bounds an over-long preview the producer failed to bound', () => {
    const preview = 'z'.repeat(MAX_PREVIEW_LENGTH * 3);
    const redacted = redactAttributes({ 'error.stack': preview });

    expect((redacted['error.stack'] as string).length).toBe(MAX_PREVIEW_LENGTH);
    expect(redacted['error.stack']).toBe('z'.repeat(MAX_PREVIEW_LENGTH - 1) + TRUNCATION_SUFFIX);
  });

  it('scrubs before truncating, so a credential cannot survive by being cut', () => {
    const value = 'prefix '.repeat(20) + PROVIDER_CREDENTIAL;
    const redacted = redactAttributes({ 'log.message': value }) as { 'log.message': string };

    expect(redacted['log.message']).not.toContain('k-ant-');
    expect(redacted['log.message'].length).toBeLessThanOrEqual(MAX_PREVIEW_LENGTH);
  });

  it('omits values that cannot be transported', () => {
    const redacted = redactAttributes({
      kept: 'alpha',
      absent: undefined,
      callback: () => 'never',
      marker: Symbol('never'),
      huge: 10n,
    });

    expect(redacted).toEqual({ kept: 'alpha' });
  });

  it('replaces an exotic object rather than walking it', () => {
    class Holder {
      readonly secret = PROVIDER_CREDENTIAL;
    }

    const redacted = redactAttributes({
      when: new Date(START_TIME),
      lookup: new Map([['a', 1]]),
      instance: new Holder(),
      plain: { nested: 'alpha' },
    });

    expect(redacted).toEqual({
      when: REDACTION_MARKER,
      lookup: REDACTION_MARKER,
      instance: REDACTION_MARKER,
      plain: { nested: 'alpha' },
    });
  });

  it('walks a null-prototype object like any other bag', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.ownerChain = ['AlphaPanel', 'BetaRow'];
    bare.apiKey = PROVIDER_CREDENTIAL;

    expect(redactAttributes({ bare })).toEqual({
      bare: { ownerChain: ['AlphaPanel', 'BetaRow'], apiKey: REDACTION_MARKER },
    });
  });

  it('keeps array positions, marking an element that cannot travel', () => {
    const redacted = redactAttributes({
      lineageCandidates: ['0123456789abcdef', undefined, 'fedcba9876543210'],
    });

    expect(redacted.lineageCandidates).toEqual([
      '0123456789abcdef',
      REDACTION_MARKER,
      'fedcba9876543210',
    ]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Bounds
 * ---------------------------------------------------------------------------
 */

describe('redactAttributes — bounds', () => {
  it('bounds a nested object to the tracked-key count but never the bag itself', () => {
    const nested: Record<string, unknown> = {};
    const bag: Record<string, unknown> = {};
    for (let index = 0; index < MAX_TRACKED_KEYS + 5; index += 1) {
      nested[`n${String(index)}`] = index;
      bag[`k${String(index)}`] = index;
    }

    const redactedBag = redactAttributes(bag);
    expect(Object.keys(redactedBag)).toHaveLength(MAX_TRACKED_KEYS + 5);

    const redactedNested = redactAttributes({ nested }).nested as Record<string, unknown>;
    expect(Object.keys(redactedNested)).toHaveLength(MAX_TRACKED_KEYS);
    expect(Object.keys(redactedNested)[0]).toBe('n0');
  });

  it('bounds an array to the same count, keeping the leading elements', () => {
    const elements = Array.from({ length: MAX_TRACKED_KEYS + 5 }, (_unused, index) => index);
    const redacted = redactAttributes({ elements }).elements as unknown[];

    expect(redacted).toHaveLength(MAX_TRACKED_KEYS);
    expect(redacted[0]).toBe(0);
    expect(redacted[MAX_TRACKED_KEYS - 1]).toBe(MAX_TRACKED_KEYS - 1);
  });

  it('stops emitting containers at the depth bound', () => {
    let deepest: Record<string, unknown> = { leaf: 'alpha' };
    for (let level = MAX_ATTRIBUTE_DEPTH + 2; level > 0; level -= 1) {
      deepest = { [`l${String(level)}`]: deepest };
    }

    const redacted = redactAttributes(deepest);

    let levels = 0;
    let cursor: unknown = redacted;
    while (cursor !== undefined && typeof cursor === 'object' && cursor !== null) {
      const keys = Object.keys(cursor);
      const first = keys[0];
      if (first === undefined) {
        break;
      }
      levels += 1;
      cursor = (cursor as Record<string, unknown>)[first];
    }

    // The bag is level 0 and its own values are level 1, so the deepest
    // container emitted sits one level short of the bound and the container
    // that would have been at the bound is omitted with everything under it.
    expect(levels).toBe(MAX_ATTRIBUTE_DEPTH - 1);
  });

  it('still carries a scalar at the depth bound', () => {
    let deepest: Record<string, unknown> = { leaf: 'alpha' };
    // One container per level below the bag, with the scalar leaf exactly at
    // the bound: containers stop there, scalars do not.
    for (let level = MAX_ATTRIBUTE_DEPTH - 1; level > 0; level -= 1) {
      deepest = { [`l${String(level)}`]: deepest };
    }

    let cursor: unknown = redactAttributes(deepest);
    for (let level = 1; level < MAX_ATTRIBUTE_DEPTH; level += 1) {
      cursor = (cursor as Record<string, unknown>)[`l${String(level)}`];
    }

    expect(cursor).toEqual({ leaf: 'alpha' });
  });

  it('honours explicit bounds and reports what they omitted', () => {
    const { attributes, report } = redactAttributesWithFindings(
      { a: 1, b: 2, c: 3, d: 4, e: 5 },
      undefined,
      { maxNodes: 3 },
    );

    expect(Object.keys(attributes)).toEqual(['a', 'b', 'c']);
    expect(report.droppedKeys).toBe(2);
  });

  it('caps the total node count of a wide, deep bag', () => {
    const bag: Record<string, unknown> = {};
    for (let outer = 0; outer < 40; outer += 1) {
      const inner: Record<string, unknown> = {};
      for (let index = 0; index < MAX_TRACKED_KEYS; index += 1) {
        inner[`n${String(index)}`] = index;
      }
      bag[`k${String(outer)}`] = inner;
    }

    const redacted = redactAttributes(bag);
    let nodes = 0;
    for (const value of Object.values(redacted)) {
      nodes += 1;
      if (value !== null && typeof value === 'object') {
        nodes += Object.keys(value).length;
      }
    }

    expect(nodes).toBeLessThanOrEqual(MAX_ATTRIBUTE_NODES);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Totality
 * ---------------------------------------------------------------------------
 */

describe('redactAttributes — totality', () => {
  it('marks a throwing getter and keeps every sibling', () => {
    const bag: Record<string, unknown> = { before: 'alpha', after: 'beta' };
    Object.defineProperty(bag, 'hostile', {
      enumerable: true,
      get() {
        throw new Error('read denied');
      },
    });

    expect(redactAttributes(bag)).toEqual({
      before: 'alpha',
      hostile: REDACTION_MARKER,
      after: 'beta',
    });
  });

  it('survives an object that cannot be enumerated', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('enumeration denied');
        },
      },
    );

    expect(redactAttributes(hostile)).toEqual({});
    expect(redactAttributes({ hostile })).toEqual({ hostile: {} });
  });

  it('terminates on a cyclic structure', () => {
    const cyclic: Record<string, unknown> = { label: 'alpha' };
    cyclic.self = cyclic;
    const cyclicList: unknown[] = ['beta'];
    cyclicList.push(cyclicList);

    expect(redactAttributes({ cyclic, cyclicList })).toEqual({
      cyclic: { label: 'alpha', self: REDACTION_MARKER },
      cyclicList: ['beta', REDACTION_MARKER],
    });
  });

  it('walks a structure that repeats a sibling reference without calling it a cycle', () => {
    const shared = { label: 'alpha' };

    expect(redactAttributes({ left: shared, right: shared })).toEqual({
      left: { label: 'alpha' },
      right: { label: 'alpha' },
    });
  });

  it('keeps a key named __proto__ as a key', () => {
    const bag = JSON.parse('{"__proto__": {"apiKey": "x"}, "after": "beta"}') as Record<
      string,
      unknown
    >;

    const redacted = redactAttributes(bag);

    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
    expect(Object.keys(redacted)).toEqual(['__proto__', 'after']);
    expect(Object.getOwnPropertyDescriptor(redacted, '__proto__')?.value).toEqual({
      apiKey: REDACTION_MARKER,
    });
  });

  it('applies the whole dispatch table at every depth', () => {
    const redacted = redactAttributes(
      {
        outer: {
          url: 'http://127.0.0.1:20450/api/alpha?itemId=A17',
          body: { never: true },
          'http.request.header.cookie': 'sid=1',
          requestHeaders: { Authorization: BEARER_HEADER_VALUE },
          'db.statement': "SELECT id FROM items_t WHERE code = 'A17'",
        },
      },
      { kind: 'db.query' },
    );

    expect(redacted.outer).toEqual({
      url: `http://127.0.0.1:20450/api/alpha?itemId=${REDACTION_MASK}`,
      'http.request.header.cookie': REDACTION_MARKER,
      requestHeaders: { Authorization: REDACTION_MARKER },
      'db.statement': `SELECT id FROM items_t WHERE code = ${REDACTION_MASK}`,
    });
  });

  it('accepts a bag that is not a record at all', () => {
    expect(redactAttributes(null as unknown as Record<string, unknown>)).toEqual({});
    expect(redactAttributes('text' as unknown as Record<string, unknown>)).toEqual({});
  });
});

/*
 * ---------------------------------------------------------------------------
 * Immutability, idempotence and determinism
 * ---------------------------------------------------------------------------
 */

describe('redactAttributes — immutability and determinism', () => {
  it('never mutates the input and never shares a nested structure', () => {
    const bag = {
      url: 'http://127.0.0.1:20450/api/alpha?itemId=A17',
      requestHeaders: { Authorization: BEARER_HEADER_VALUE },
      ownerChain: ['AlphaPanel', 'BetaRow'],
    };
    const before = structuredClone(bag);

    const redacted = redactAttributes(bag, { kind: 'fetch' });

    expect(bag).toEqual(before);
    expect(redacted.requestHeaders).not.toBe(bag.requestHeaders);
    expect(redacted.ownerChain).not.toBe(bag.ownerChain);
  });

  it('is idempotent over every handler', () => {
    const bag: Record<string, unknown> = {
      url: 'http://svc:' + 'e5'.repeat(6) + '@127.0.0.1:20450/api/alpha?itemId=A17',
      request_key: 'f6'.repeat(32),
      'http.request.header.authorization': BEARER_HEADER_VALUE,
      requestHeaders: { Cookie: 'sid=1' },
      responseHeaders: 'raw blob',
      'db.statement': "SELECT id FROM items_t WHERE code = 'A17'",
      'db.rowCount': 3,
      apiKey: PROVIDER_CREDENTIAL,
      'log.message': 'w'.repeat(MAX_PREVIEW_LENGTH * 2),
      when: new Date(START_TIME),
      body: { dropped: true },
      elements: Array.from({ length: MAX_TRACKED_KEYS + 3 }, (_unused, index) => index),
    };

    const once = redactAttributes(bag, { kind: 'fetch' });
    const twice = redactAttributes(once, { kind: 'fetch' });

    expect(twice).toEqual(once);
  });

  it('is deterministic across calls', () => {
    const bag = { url: 'http://127.0.0.1:20450/api/beta?q=1', apiKey: PROVIDER_CREDENTIAL };

    expect(JSON.stringify(redactAttributes(bag, { kind: 'xhr' }))).toBe(
      JSON.stringify(redactAttributes(bag, { kind: 'xhr' })),
    );
  });
});

/*
 * ---------------------------------------------------------------------------
 * The findings report
 * ---------------------------------------------------------------------------
 */

describe('redactAttributesWithFindings — the report', () => {
  it('reports rules in vocabulary order, counts, and nothing else', () => {
    const { report } = redactAttributesWithFindings(
      {
        'http.request.header.authorization': BEARER_HEADER_VALUE,
        url: 'http://127.0.0.1:20450/api/alpha?itemId=A17',
        'log.message': 'used ' + PROVIDER_CREDENTIAL,
        apiKey: 'short',
      },
      { kind: 'fetch' },
    );

    // `sensitive-header` is positional, `bearer-token` and `provider-key` are
    // content rules, `url-query-value` is `./url.ts`'s, and `entropy` is the
    // name-driven rule. All four come back in `REDACTION_RULE_IDS` order.
    expect(report.rules).toEqual([
      'sensitive-header',
      'provider-key',
      'bearer-token',
      'url-query-value',
      'entropy',
    ]);
    expect(report.maskedValues).toBe(4);
    expect(Object.keys(report).sort()).toEqual([
      'droppedKeys',
      'maskedValues',
      'rules',
      'truncatedValues',
    ]);
  });

  it('carries no value and no attribute path into the report', () => {
    const { report } = redactAttributesWithFindings({
      apiKey: PROVIDER_CREDENTIAL,
      body: { rows: 1 },
    });
    const serialised = JSON.stringify(report);

    expect(serialised).not.toContain('apiKey');
    expect(serialised).not.toContain('body');
    expect(serialised).not.toContain('k-ant-');
  });

  it('counts a truncation and a mask separately for one value', () => {
    const { report } = redactAttributesWithFindings({
      'log.message': 'lead '.repeat(10) + PROVIDER_CREDENTIAL + ' tail'.repeat(30),
    });

    expect(report.maskedValues).toBe(1);
    expect(report.truncatedValues).toBe(1);
  });

  it('names no value it masked, benign or not, and no path it found one at', () => {
    // Most masked values are perfectly ordinary — a query parameter, a prop
    // preview — and the report is written to logs that a redacted payload
    // could not be written to. So neither the credential nor the benign value
    // may appear in it, and nor may the attribute path either was found at: a
    // path is built from page-supplied key names. The rule ids are the whole
    // report, which is what makes it loggable.
    const { report } = redactAttributesWithFindings(
      {
        url: 'http://127.0.0.1:20450/api/alpha?itemId=DistinctBenignA17',
        'log.message': 'used ' + PROVIDER_CREDENTIAL,
      },
      { kind: 'fetch' },
    );
    const serialised = JSON.stringify(report);

    expect(serialised).not.toContain('DistinctBenignA17');
    expect(serialised).not.toContain('k-ant-');
    expect(serialised).not.toContain('log.message');
    expect(serialised).not.toContain('itemId');
    // The positional rule is still reported, by id alone.
    expect(report.rules).toContain('url-query-value');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Span names
 * ---------------------------------------------------------------------------
 */

describe('redactEventName', () => {
  it('masks query values in a request span name and keeps the method and route', () => {
    expect(redactEventName('fetch', 'GET /api/alpha?itemId=A17')).toBe(
      `GET /api/alpha?itemId=${REDACTION_MASK}`,
    );
    expect(redactEventName('xhr', 'xhr POST http://127.0.0.1:20450/api/beta?u=admin&p=pw')).toBe(
      `xhr POST http://127.0.0.1:20450/api/beta?u=${REDACTION_MASK}&p=${REDACTION_MASK}`,
    );
  });

  it('masks a URL in any span name that carries an authority', () => {
    expect(
      redactEventName(
        'http.client',
        'fetch GET http://svc:' + 'e5'.repeat(6) + '@127.0.0.1:20450/api/beta',
      ),
    ).toBe(`fetch GET http://${REDACTION_MARKER}@127.0.0.1:20450/api/beta`);
  });

  it('leaves an ordinary span name exactly as it arrived', () => {
    expect(redactEventName('render', 'AlphaPanel')).toBe('AlphaPanel');
    expect(redactEventName('route.handler', 'executing api route (app) /api/alpha')).toBe(
      'executing api route (app) /api/alpha',
    );
    expect(redactEventName('db.query', 'SELECT id FROM items_t WHERE id = ?')).toBe(
      'SELECT id FROM items_t WHERE id = ?',
    );
  });

  it('scrubs a credential out of a name and never returns a longer one', () => {
    const name = 'boot ' + PROVIDER_CREDENTIAL;

    expect(redactEventName('log', name)).toBe(`boot ${REDACTION_MARKER}`);
    expect(
      redactEventName('function', 'pg://svc:' + 'e5'.repeat(6) + '@h/d').length,
    ).toBeLessThanOrEqual(('pg://svc:' + 'e5'.repeat(6) + '@h/d').length);
  });

  it('never returns an empty name', () => {
    expect(redactEventName('log', PROVIDER_CREDENTIAL)).toBe(REDACTION_MARKER);
  });

  it('is idempotent', () => {
    const names = [
      'GET /api/alpha?itemId=A17',
      'fetch GET http://svc:' + 'e5'.repeat(6) + '@127.0.0.1:20450/api/beta?q=1#frag',
      'pg' + '://svc:' + 'e5'.repeat(3) + '@127.0.0.1:5432/db_a',
      'AlphaPanel',
    ];

    for (const name of names) {
      const once = redactEventName('fetch', name);
      expect(redactEventName('fetch', once)).toBe(once);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Whole events
 * ---------------------------------------------------------------------------
 */

describe('redactEvent', () => {
  it('preserves every field but name, attributes and redacted', () => {
    const source = {
      file: 'src/components/AlphaPanel.tsx',
      line: 42,
      column: 7,
      symbol: 'onAlphaClick',
      resolvedBy: 'code-graph' as const,
      confidence: 0.8,
    };
    const event: TelemetryEventIngress = {
      ...fetchEvent({ url: 'http://127.0.0.1:20450/api/alpha?itemId=A17' }),
      parentSpanId: 'fedcba9876543210',
      source,
    };

    const redacted = redactEvent(event);

    expect(redacted.id).toBe(event.id);
    expect(redacted.traceId).toBe(event.traceId);
    expect(redacted.spanId).toBe(event.spanId);
    expect(redacted.parentSpanId).toBe(event.parentSpanId);
    expect(redacted.kind).toBe(event.kind);
    expect(redacted.startTime).toBe(event.startTime);
    expect(redacted.duration).toBe(event.duration);
    expect(redacted.tier).toBe(event.tier);
    expect(redacted.status).toBe(event.status);
    expect(redacted.producerId).toBe(event.producerId);
    expect(redacted.seq).toBe(event.seq);
    // A source location is a project path, a line and a column: no runtime
    // data, so it is passed through untouched.
    expect(redacted.source).toBe(source);
    expect(redacted).not.toBe(event);
  });

  it('records the attribute paths it changed and omits the field when it changed nothing', () => {
    const changed = redactEvent(
      fetchEvent({
        url: 'http://127.0.0.1:20450/api/alpha?itemId=A17',
        'http.status_code': 200,
        body: { never: true },
        nested: { apiKey: PROVIDER_CREDENTIAL },
      }),
    );

    expect(changed.redacted).toEqual(['url', 'body', 'nested.apiKey']);

    const untouched = redactEvent(fetchEvent({ 'http.method': 'GET', 'http.status_code': 200 }));
    expect(untouched.redacted).toBeUndefined();
    expect('redacted' in untouched).toBe(false);
  });

  it('merges the paths an already-redacted event carried', () => {
    const event: TelemetryEventIngress = {
      ...fetchEvent({ apiKey: PROVIDER_CREDENTIAL }),
      redacted: ['http.request.header.cookie'],
    };

    expect(redactEvent(event).redacted).toEqual(['http.request.header.cookie', 'apiKey']);
  });

  it('scrubs a credential out of an inherited path and keeps it non-empty', () => {
    const event: TelemetryEventIngress = {
      ...fetchEvent({}),
      redacted: [PROVIDER_CREDENTIAL, ''],
    };

    expect(redactEvent(event).redacted).toEqual([REDACTION_MARKER]);
  });

  it('is idempotent over a rich event', () => {
    const event = persistedEvent('db.query', 'db', 'pg.query items_t', {
      'db.system': 'postgresql',
      'db.statement': "SELECT id FROM items_t WHERE code = 'A17'",
      'db.rowCount': 9,
      'http.request.header.authorization': BEARER_HEADER_VALUE,
      requestHeaders: { Cookie: 'sid=1', 'Content-Type': 'application/json' },
      url: 'http://svc:' + 'e5'.repeat(6) + '@127.0.0.1:5432/db_a?sslmode=require',
      request_key: 'f6'.repeat(32),
      apiKey: PROVIDER_CREDENTIAL,
      'log.message': 'v'.repeat(MAX_PREVIEW_LENGTH * 2),
      results: [{ id: 1 }],
      when: new Date(START_TIME),
    });

    const once = redactEvent(event);
    const twice = redactEvent(once);

    expect(twice).toEqual(once);
    expect(twice.redacted).toEqual(once.redacted);
  });

  it('does not mutate the event it was given', () => {
    const event = fetchEvent({
      url: 'http://127.0.0.1:20450/api/alpha?itemId=A17',
      requestHeaders: { Authorization: BEARER_HEADER_VALUE },
    });
    const before = structuredClone(event);

    redactEvent(event);

    expect(event).toEqual(before);
  });

  it('counts a redacted span name in the event report', () => {
    const { event, report } = redactEventWithFindings(
      eventOf('log', 'browser', 'boot used ' + PROVIDER_CREDENTIAL, {}),
    );

    expect(event.name).toBe(`boot used ${REDACTION_MARKER}`);
    expect(report.maskedValues).toBe(1);
    expect(report.rules).toEqual(['provider-key']);

    // A name nothing touched contributes nothing.
    expect(redactEventWithFindings(eventOf('log', 'browser', 'boot ok', {})).report).toEqual({
      rules: [],
      droppedKeys: 0,
      truncatedValues: 0,
      maskedValues: 0,
    });
  });

  it('returns the report alongside the event', () => {
    const { event, report } = redactEventWithFindings(
      fetchEvent({ 'http.request.header.cookie': 'sid=1' }),
    );

    expect(attributesOf(event)['http.request.header.cookie']).toBe(REDACTION_MARKER);
    expect(report.rules).toEqual(['sensitive-header']);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The second checkpoint
 * ---------------------------------------------------------------------------
 */

describe('redactEvent — what the outbound guard will see', () => {
  /** Collects every string this event would carry, at any depth. */
  function stringsOf(value: unknown, into: string[]): string[] {
    if (typeof value === 'string') {
      into.push(value);
    } else if (Array.isArray(value)) {
      for (const element of value) {
        stringsOf(element, into);
      }
    } else if (value !== null && typeof value === 'object') {
      for (const nested of Object.values(value)) {
        stringsOf(nested, into);
      }
    }
    return into;
  }

  it('emits no string that any content rule still matches', () => {
    // `packages/model-provider/src/redact-guard.ts` re-checks every outbound
    // payload with this same vocabulary and *refuses the call* when a denied
    // pattern survived (AAP 0.5.2). So a finding here is not a style
    // disagreement: it is the pipeline failing at its second checkpoint, and
    // the bug would be in this module. The marker and an empty value are the
    // guard's documented already-redacted cases and are exempt.
    const event = persistedEvent('fetch', 'browser', 'fetch GET /api/alpha?itemId=A17', {
      url: 'http://svc:' + 'e5'.repeat(6) + '@127.0.0.1:20450/api/alpha?itemId=A17&mode=full',
      'http.request.header.authorization': BEARER_HEADER_VALUE,
      requestHeaders: { Cookie: 'sid=1', 'Content-Type': 'application/json' },
      initiator: 'at onAlphaClick (src/components/AlphaPanel.tsx:42:7) token=' + JOSE_TOKEN,
      'db.statement': "SELECT id FROM items_t WHERE code = 'A17'",
      'db.name': CONNECTION_STRING,
      'log.message': 'boot used ' + PROVIDER_CREDENTIAL,
      apiKey: PROVIDER_CREDENTIAL,
      changedProps: [{ key: 'itemCount', next: { type: 'string', preview: BEARER_HEADER_VALUE } }],
    });

    const redacted = redactEvent(event);
    const values = stringsOf(attributesOf(redacted), [redacted.name]);

    expect(values.length).toBeGreaterThan(8);
    for (const value of values) {
      if (value.length === 0 || value === REDACTION_MARKER) {
        continue;
      }
      expect(findDeniedRules(value)).toEqual([]);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Schema round-trip
 * ---------------------------------------------------------------------------
 */

describe('redactEvent — schema round-trip', () => {
  it('returns an event the ingress schema still accepts', () => {
    const event = fetchEvent({
      url: 'http://127.0.0.1:20450/api/alpha?itemId=A17',
      'http.request.header.authorization': BEARER_HEADER_VALUE,
      request_key: 'f6'.repeat(32),
      body: { never: true },
    });

    const parsed = telemetryEventIngressSchema.safeParse(redactEvent(event));

    expect(parsed.success).toBe(true);
  });

  it('returns a persisted event the persisted schema still accepts', () => {
    const event = persistedEvent('db.query', 'db', 'pg.query items_t', {
      'db.statement': "SELECT id FROM items_t WHERE code = 'A17'",
      'db.rowCount': 2,
    });

    const parsed = telemetryEventSchema.safeParse(redactEvent(event));

    expect(parsed.success).toBe(true);
  });

  it('turns a hostile event into a parseable one', () => {
    const cyclic: Record<string, unknown> = { label: 'alpha' };
    cyclic.self = cyclic;
    const event: TelemetryEventIngress = eventOf('log', 'browser', 'boot ' + CONNECTION_STRING, {
      callback: () => 'never',
      marker: Symbol('never'),
      huge: 11n,
      when: new Date(START_TIME),
      cyclic,
      'log.message': 'u'.repeat(MAX_PREVIEW_LENGTH * 40),
    });

    // The input itself is not parseable — the schema rejects a function and a
    // symbol on the bag — which is the point: the boundary has to make it so.
    expect(telemetryEventIngressSchema.safeParse(event).success).toBe(false);

    const redacted = redactEvent(event);
    const parsed = telemetryEventIngressSchema.safeParse(redacted);

    expect(parsed.success).toBe(true);
    expect(redacted.name.length).toBeLessThanOrEqual(event.name.length);
    expect(redacted.name).not.toContain('svc:');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The fixtures themselves
 * ---------------------------------------------------------------------------
 */

describe('fixtures — valid before they are redacted', () => {
  /**
   * Every kind whose dispatch this file exercises, gathered from the imported
   * groups plus the single-member kinds that have their own handler or their
   * own tier.
   */
  const EXERCISED_KINDS: readonly TelemetryKind[] = [
    ...REQUEST_KINDS,
    ...RENDER_KINDS,
    ...QUERY_KINDS,
    'interaction',
    'state',
    'error',
    'http.server',
    'route.handler',
    'function',
    'http.client',
    'log',
  ];

  it('builds each exercised kind on a tier that kind allows', () => {
    for (const kind of EXERCISED_KINDS) {
      const event = eventOfKind(kind, 'alpha span', { component: 'AlphaPanel' });

      expect(KIND_ALLOWED_TIERS[kind], `tier for kind "${kind}"`).toContain(event.tier);
      expect(
        telemetryEventIngressSchema.safeParse(event).success,
        `ingress fixture for kind "${kind}"`,
      ).toBe(true);
    }
  });

  it('builds shared ingress and persisted fixtures the two schemas accept', () => {
    expect(
      telemetryEventIngressSchema.safeParse(fetchEvent({ 'http.method': 'GET' })).success,
    ).toBe(true);
    expect(
      telemetryEventSchema.safeParse(persistedEvent('db.query', 'db', 'pg.query items_t', {}))
        .success,
    ).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Per-kind dispatch, on whole events
 * ---------------------------------------------------------------------------
 */

describe('redactEvent — per-kind dispatch', () => {
  it('masks a fetch URL and header while method, status and the stack stay readable', () => {
    const initiator =
      'at onAlphaClick (src/components/AlphaPanel.tsx:42:7) token=' +
      JOSE_TOKEN +
      ' ' +
      'at send (src/lib/alpha-client.ts:18:3) '.repeat(6);
    const event = checkedEvent(
      eventOfKind('fetch', 'fetch GET /api/alpha', {
        'http.method': 'POST',
        url: 'http://127.0.0.1:20450/api/alpha?itemId=A17&mode=full',
        'http.status_code': 201,
        'http.request.header.authorization': BEARER_HEADER_VALUE,
        initiator,
      }),
    );

    const attributes = attributesOf(redactEvent(event));

    // Method and status are the two fields AAP 0.5.2 keeps verbatim.
    expect(attributes['http.method']).toBe('POST');
    expect(attributes['http.status_code']).toBe(201);
    expect(attributes.url).toBe(
      `http://127.0.0.1:20450/api/alpha?itemId=${REDACTION_MASK}&mode=${REDACTION_MASK}`,
    );
    // The header's key survives so the panel can say which header was present.
    expect(attributes['http.request.header.authorization']).toBe(REDACTION_MARKER);

    // `initiator` is in `UNTRUNCATED_ATTRIBUTE_KEYS` because source-map
    // resolution reads the whole stack: the token goes, every frame stays, and
    // the preview bound does not apply.
    const stack = attributes.initiator as string;
    expect(stack).not.toContain(JOSE_TOKEN);
    expect(stack).toContain('src/components/AlphaPanel.tsx:42:7');
    expect(stack).toContain('src/lib/alpha-client.ts:18:3');
    expect(stack.length).toBeGreaterThan(MAX_PREVIEW_LENGTH);
    expect(stack.endsWith(TRUNCATION_SUFFIX)).toBe(false);
  });

  it('keeps a db.query statement parameterised, with row count and system intact', () => {
    const event = checkedEvent(
      eventOfKind('db.query', 'pg.query items_t', {
        'db.system': 'postgresql',
        'db.statement': "SELECT id FROM items_t WHERE id = $1 AND code = 'L1teralA17'",
        'db.rowCount': 12,
      }),
    );

    const attributes = attributesOf(redactEvent(event));

    // A placeholder is structure and stays; an inline literal is data and
    // goes. AAP 0.5.2 keeps the row *count* and never a row.
    expect(attributes['db.statement']).toBe(
      `SELECT id FROM items_t WHERE id = $1 AND code = ${REDACTION_MASK}`,
    );
    expect(attributes['db.rowCount']).toBe(12);
    expect(attributes['db.system']).toBe('postgresql');
  });

  it('keeps render evidence and bounds each changed-prop preview', () => {
    const atBound = 'q'.repeat(MAX_PREVIEW_LENGTH);
    const overBound = 'r'.repeat(MAX_PREVIEW_LENGTH + 1);
    const event = checkedEvent(
      eventOfKind('render', 'AlphaPanel', {
        component: 'AlphaPanel',
        phase: 'update',
        renderCount: 4,
        trigger: 'props',
        actualDuration: 3.5,
        changedProps: [
          { key: 'atBound', next: { type: 'string', preview: atBound, truncated: false } },
          { key: 'overBound', next: { type: 'string', preview: overBound, truncated: false } },
        ],
      }),
    );

    const attributes = attributesOf(redactEvent(event));
    const entries = attributes.changedProps as Record<string, unknown>[];
    const previewOf = (index: number): string =>
      ((entries[index] as Record<string, unknown>).next as Record<string, unknown>)
        .preview as string;

    // Everything `../aggregate/renders.ts` and the `renderTable` node read.
    expect(attributes.component).toBe('AlphaPanel');
    expect(attributes.phase).toBe('update');
    expect(attributes.renderCount).toBe(4);
    expect(attributes.trigger).toBe('props');
    expect(attributes.actualDuration).toBe(3.5);

    // A preview exactly at the bound already conforms and is returned as it
    // arrived; one code point over it is cut to the bound, suffix included.
    expect(previewOf(0)).toBe(atBound);
    expect(previewOf(1)).toHaveLength(MAX_PREVIEW_LENGTH);
    expect(previewOf(1).endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  it('scrubs both state value summaries and keeps the transition readable', () => {
    const event = checkedEvent(
      eventOfKind('state', 'setAlphaCount', {
        component: 'BetaRow',
        hookIndex: 1,
        hookLabel: 'alphaCount',
        previousValue: { type: 'string', preview: BEARER_HEADER_VALUE, truncated: false },
        nextValue: {
          type: 'string',
          preview: 'n'.repeat(MAX_PREVIEW_LENGTH * 2),
          truncated: true,
        },
        triggerEventId: 'evt_e5e5e5e5e5e5e5e5',
      }),
    );

    const redacted = redactEvent(event);
    const attributes = attributesOf(redacted);
    const previewOf = (key: string): string =>
      (attributes[key] as Record<string, unknown>).preview as string;

    expect(attributes.component).toBe('BetaRow');
    expect(attributes.hookIndex).toBe(1);
    expect(attributes.hookLabel).toBe('alphaCount');
    // The triggering-event reference is a correlation id, not runtime data:
    // `StateTransitionViewer` follows it to the event that caused the change.
    expect(attributes.triggerEventId).toBe('evt_e5e5e5e5e5e5e5e5');
    expect(previewOf('previousValue')).toBe(`bearer ${REDACTION_MARKER}`);
    expect(previewOf('nextValue')).toHaveLength(MAX_PREVIEW_LENGTH);
    expect(redacted.redacted).toEqual(['previousValue.preview', 'nextValue.preview']);
  });

  it('scrubs an error message and the frame a token was planted in', () => {
    const event = checkedEvent(
      eventOfKind('error', 'TypeError in AlphaPanel', {
        'error.type': 'TypeError',
        'error.message': 'request rejected: ' + JOSE_TOKEN,
        'error.stack': 'at send (src/lib/alpha-client.ts:18:3) token=' + JOSE_TOKEN,
        component: 'AlphaPanel',
      }),
    );

    const attributes = attributesOf(redactEvent(event));

    // The structure is the evidence — type, component, the frame that threw —
    // and only the planted credential goes.
    expect(attributes['error.type']).toBe('TypeError');
    expect(attributes.component).toBe('AlphaPanel');
    expect(attributes['error.message']).toBe(`request rejected: ${REDACTION_MARKER}`);
    expect(attributes['error.stack']).toBe(
      `at send (src/lib/alpha-client.ts:18:3) token=${REDACTION_MARKER}`,
    );
  });
});

/*
 * ---------------------------------------------------------------------------
 * Dispatch by kind group, never by kind string
 * ---------------------------------------------------------------------------
 */

describe('redactEvent — dispatch by kind group', () => {
  /*
   * Every kind-gated handler asks `../schema/kinds.ts` for **group
   * membership** rather than comparing against a literal kind string, which
   * is that module's stated contract. Each case below therefore iterates the
   * imported group and covers every member: a handler special-cased on one
   * member fails here on the others, and a kind added to a group is covered
   * the moment it is declared.
   */

  it('opens the preview subtree for every render kind', () => {
    expect(RENDER_KINDS.length).toBeGreaterThan(1);

    for (const kind of RENDER_KINDS) {
      const event = checkedEvent(
        eventOfKind(kind, 'AlphaPanel', {
          changedProps: [
            {
              key: 'itemCount',
              next: { type: 'string', preview: '"' + PROVIDER_CREDENTIAL + '"', truncated: false },
            },
          ],
        }),
      );

      const entry = (attributesOf(redactEvent(event)).changedProps as Record<string, unknown>[])[0];
      const fields = entry as Record<string, unknown>;

      // The prop *name* is the evidence the render table shows and is exempt
      // from the name rule inside a preview subtree; the prop *value* preview
      // is page data and is scrubbed.
      expect(fields.key, `changed-prop name on kind "${kind}"`).toBe('itemCount');
      expect((fields.next as Record<string, unknown>).preview).toBe(`"${REDACTION_MARKER}"`);
    }
  });

  it('masks the URL in the span name of every request kind', () => {
    expect(REQUEST_KINDS.length).toBeGreaterThan(1);

    for (const kind of REQUEST_KINDS) {
      const redacted = redactEvent(
        checkedEvent(eventOfKind(kind, 'GET /api/alpha?itemId=A17', {})),
      );

      // Method and route survive; the parameter value does not.
      expect(redacted.name, `span name on kind "${kind}"`).toBe(
        `GET /api/alpha?itemId=${REDACTION_MASK}`,
      );
    }
  });

  it('treats a conventional statement spelling as SQL on every query kind', () => {
    for (const kind of QUERY_KINDS) {
      const event = checkedEvent(
        eventOfKind(kind, 'pg.query items_t', {
          statement: "SELECT id FROM items_t WHERE code = 'L1teralA17'",
        }),
      );

      expect(attributesOf(redactEvent(event)).statement, `statement on kind "${kind}"`).toBe(
        `SELECT id FROM items_t WHERE code = ${REDACTION_MASK}`,
      );
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Every service-assigned key, not just the one
 * ---------------------------------------------------------------------------
 */

describe('redactAttributes — every service-assigned key', () => {
  /**
   * 64 characters of hex: the shape `./request-key.ts` produces.
   *
   * The exemption these two tests protect is load-bearing and is exactly the
   * kind a later "tighten the rules" change destroys silently. The key's name
   * ends in "key" and its value is dense, so the name rule would mask it and
   * an entropy heuristic would agree — and `../aggregate/requests.ts` groups
   * duplicate requests by exactly this value, so a masked key would collapse
   * every request in a capture into one duplicate group and make
   * `duplicate_request_count` meaningless. It is computed *before* redaction
   * from the unredacted URL and is a keyed hash of the request's shape, never
   * of its data (AAP 0.5.2).
   *
   * Written as a loop over the imported tuple rather than as one test for
   * `request_key`, so a key the service starts assigning is covered as soon
   * as it is declared.
   */
  const DIGEST = 'a9'.repeat(32);

  it('passes a scalar through byte-for-byte at the top level of the bag', () => {
    expect(SERVICE_ASSIGNED_ATTRIBUTE_KEYS.length).toBeGreaterThan(0);

    for (const key of SERVICE_ASSIGNED_ATTRIBUTE_KEYS) {
      const { attributes, report } = redactAttributesWithFindings(
        { [key]: DIGEST, 'http.method': 'GET' },
        { kind: 'fetch' },
      );

      expect(attributes[key], `service-assigned key "${key}"`).toBe(DIGEST);
      expect(attributes['http.method']).toBe('GET');
      // Not merely unchanged: not even reported, so a log cannot suggest a
      // finding where the service wrote its own value.
      expect(report).toEqual({ rules: [], droppedKeys: 0, truncatedValues: 0, maskedValues: 0 });
    }
  });

  it('records no redaction path for one on a whole event', () => {
    const event = checkedEvent(
      eventOfKind(
        'fetch',
        'fetch GET /api/alpha',
        Object.fromEntries(SERVICE_ASSIGNED_ATTRIBUTE_KEYS.map((key) => [key, DIGEST])),
      ),
    );

    const redacted = redactEvent(event);

    expect('redacted' in redacted).toBe(false);
    for (const key of SERVICE_ASSIGNED_ATTRIBUTE_KEYS) {
      expect(attributesOf(redacted)[key], `service-assigned key "${key}"`).toBe(DIGEST);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Event-level invariants
 * ---------------------------------------------------------------------------
 */

describe('redactEvent — event-level invariants', () => {
  /*
   * `redacted` is the provenance record AAP 0.5.2 asks for, and
   * `../schema/event.ts` declares it as the attribute **paths** whose values
   * this module replaced — not a boolean flag. Its absence therefore means
   * exactly "no value was replaced", and never "this event has not crossed
   * the boundary". That second question is answered by the ingest path's call
   * order rather than by any field: an event reaches the store or the
   * `telemetry.tail` feed only through `redactEvent`, and an event that has
   * not been through this function must not be persisted or broadcast at all.
   * Both event schemas are strict, so a boolean marker would make a redacted
   * event unparseable — which is why this contract cannot drift.
   */

  it('returns the same key set, gaining redacted only when something was replaced', () => {
    const clean = checkedEvent(
      eventOfKind('fetch', 'fetch GET /api/alpha', { 'http.method': 'GET' }),
    );
    expect(Object.keys(redactEvent(clean))).toEqual(Object.keys(clean));

    const dirty = checkedEvent(
      eventOfKind('fetch', 'fetch GET /api/alpha', { apiKey: PROVIDER_CREDENTIAL }),
    );
    expect(Object.keys(redactEvent(dirty))).toEqual([...Object.keys(dirty), 'redacted']);
  });

  it('carries the three attribution fields of a persisted event through untouched', () => {
    const event = persistedEvent('db.query', 'db', 'pg.query items_t', {
      'db.statement': "SELECT id FROM items_t WHERE code = 'L1teralA17'",
      'db.rowCount': 3,
    });
    expect(telemetryEventSchema.safeParse(event).success).toBe(true);

    const redacted = redactEvent(event);

    // The three fields the service assigns at ingest: attribution the store
    // and every aggregate index by, and nothing a producer supplied.
    expect(redacted.sessionId).toBe(event.sessionId);
    expect(redacted.captureId).toBe(event.captureId);
    expect(redacted.ingestSeq).toBe(event.ingestSeq);
    expect(Object.keys(redacted)).toEqual([...Object.keys(event), 'redacted']);
    expect(telemetryEventSchema.safeParse(redacted).success).toBe(true);
  });

  it('is synchronous: the event comes back, never a promise', () => {
    const redacted: unknown = redactEvent(checkedEvent(fetchEvent({ 'http.method': 'GET' })));

    // Only `./request-key.ts` is async on the ingest path. A thenable here
    // would be persisted as an object with no attributes and no kind, and the
    // whole batch's evidence would be lost silently.
    expect(redacted).not.toBeInstanceOf(Promise);
    expect((redacted as { then?: unknown }).then).toBeUndefined();
    expect((redacted as TelemetryEventIngress).kind).toBe('fetch');
  });

  it('accepts an empty attribute bag and an event whose bag is missing', () => {
    const empty = checkedEvent(eventOfKind('interaction', 'click AlphaPanel', {}));
    const redactedEmpty = redactEvent(empty);

    expect(redactedEmpty.attributes).toEqual({});
    expect('redacted' in redactedEmpty).toBe(false);
    expect(telemetryEventIngressSchema.safeParse(redactedEmpty).success).toBe(true);

    // A producer that omitted the bag entirely is malformed — the schema
    // rejects it, which is how ingest reports it — but redaction runs on the
    // way to that report, so it has to be total here too. The key stays, with
    // an empty bag under it, and the result parses.
    const missing = redactEvent({
      ...empty,
      attributes: undefined,
    } as unknown as TelemetryEventIngress);

    expect(missing.attributes).toEqual({});
    expect(Object.keys(missing)).toEqual(Object.keys(empty));
    expect(telemetryEventIngressSchema.safeParse(missing).success).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The leak suite
 * ---------------------------------------------------------------------------
 */

/**
 * One secret class of AAP 0.5.2, the event that carries it, and what must and
 * must not survive.
 */
interface LeakCase {
  /** The secret class, in the terms AAP 0.5.2 uses. */
  readonly secretClass: string;
  /** Substrings that must appear nowhere in the emitted event. */
  readonly secrets: readonly string[];
  /** Evidence that must survive, so a row cannot pass by emitting nothing. */
  readonly keeps: string;
  /** The event as its producer would send it. */
  readonly build: () => TelemetryEventIngress;
}

describe('redactEvent — the leak suite', () => {
  /*
   * The most important block in this file: one row per secret class AAP 0.5.2
   * names, each asserting that the credential appears nowhere in the emitted
   * event — not in an attribute, not in a nested preview, not in the span
   * name, and not in the `redacted` path list, which is built from
   * page-supplied key names and is serialised with everything else.
   *
   * CROSS-CHECKPOINT VERIFICATION. Everything this function emits must also
   * **pass** `packages/model-provider/src/redact-guard.ts`, the second
   * checkpoint of the privacy boundary, whose documented negative (passing)
   * cases are exactly `[redacted]` header values, `?`-masked URLs,
   * `$1`-parameterised SQL and previews of at most `MAX_PREVIEW_LENGTH`
   * characters — the four shapes every expectation in this file accepts. The
   * guard *refuses the model call* when a denied pattern survives, so a
   * credential that gets through here does not merely leak: it fails the
   * pipeline at its second checkpoint. If the guard would reject an event
   * this suite accepts, the defect is in `./redactor.ts` and not in the
   * guard.
   *
   * Table-driven so that a new secret class is one row.
   */
  const LEAK_CASES: readonly LeakCase[] = [
    {
      secretClass: 'provider key in a log message',
      secrets: [PROVIDER_CREDENTIAL, 'k-ant-'],
      keeps: 'startup used',
      build: () =>
        eventOfKind('log', 'boot alpha', {
          'log.message': 'startup used ' + PROVIDER_CREDENTIAL + ' for /api/alpha',
          'logger.name': 'alpha',
        }),
    },
    {
      secretClass: 'bearer credential in a request header',
      secrets: [BEARER_BODY],
      keeps: 'http.request.header.authorization',
      build: () =>
        eventOfKind('fetch', 'fetch POST /api/alpha', {
          'http.method': 'POST',
          'http.request.header.authorization': BEARER_HEADER_VALUE,
        }),
    },
    {
      secretClass: 'JOSE token in an error message',
      secrets: [JOSE_TOKEN, 'J0eXAiOiJKV1QifQ'],
      keeps: 'request rejected',
      build: () =>
        eventOfKind('error', 'TypeError in AlphaPanel', {
          'error.type': 'TypeError',
          'error.message': 'request rejected: ' + JOSE_TOKEN,
        }),
    },
    {
      secretClass: 'PEM private-key block in a log message',
      // The block's own line breaks are escaped inside JSON text, so the
      // searched substrings are its newline-free parts: the delimiter, the
      // label and the body.
      secrets: [PEM_HEADER, PEM_LABEL, PEM_BODY],
      keeps: 'operator pasted',
      build: () =>
        eventOfKind('log', 'boot alpha', {
          'log.message': 'operator pasted ' + PEM_BLOCK,
        }),
    },
    {
      secretClass: 'credentialed connection string in a database attribute',
      secrets: [CONNECTION_PASSWORD, CONNECTION_STRING],
      keeps: '127.0.0.1:5432/db_a',
      build: () =>
        eventOfKind('db.query', 'pg.query items_t', {
          'db.system': 'postgresql',
          'db.name': CONNECTION_STRING,
          'db.rowCount': 1,
        }),
    },
    {
      secretClass: 'value under a password, token or apiKey name',
      secrets: ['D7'.repeat(8), 'E8'.repeat(8), 'F9'.repeat(8)],
      keeps: 'AlphaPanel',
      build: () =>
        eventOfKind('log', 'boot alpha', {
          component: 'AlphaPanel',
          password: 'D7'.repeat(8),
          token: 'E8'.repeat(8),
          apiKey: 'F9'.repeat(8),
        }),
    },
    {
      secretClass: 'token inside a URL query value',
      secrets: [JOSE_TOKEN],
      keeps: '/api/alpha',
      build: () =>
        eventOfKind('fetch', 'fetch GET /api/alpha', {
          url: 'http://127.0.0.1:20450/api/alpha?access=' + JOSE_TOKEN,
          'http.status_code': 200,
        }),
    },
    {
      secretClass: 'inline literal inside a SQL statement',
      secrets: ["'L1teralA17'", 'L1teralA17'],
      keeps: 'items_t',
      build: () =>
        eventOfKind('db.query', 'pg.query items_t', {
          'db.statement': "SELECT id FROM items_t WHERE code = 'L1teralA17' LIMIT 1",
        }),
    },
    {
      secretClass: 'token inside a React prop preview',
      secrets: [BEARER_BODY],
      keeps: 'itemCount',
      build: () =>
        eventOfKind('render', 'AlphaPanel', {
          component: 'AlphaPanel',
          trigger: 'props',
          changedProps: [
            {
              key: 'itemCount',
              previous: { type: 'string', preview: BEARER_HEADER_VALUE, truncated: false },
              next: { type: 'string', preview: '"4"', truncated: false },
            },
          ],
        }),
    },
    {
      secretClass: 'token inside an error stack frame',
      secrets: [JOSE_TOKEN],
      keeps: 'src/lib/alpha-client.ts:18:3',
      build: () =>
        eventOfKind('error', 'TypeError in AlphaPanel', {
          'error.stack':
            'at send (src/lib/alpha-client.ts:18:3) token=' +
            JOSE_TOKEN +
            '\n    at flush (src/lib/alpha-client.ts:31:9)',
        }),
    },
    {
      secretClass: 'credential inside a span name',
      secrets: [CONNECTION_PASSWORD],
      keeps: '127.0.0.1:20450/api/beta',
      build: () =>
        eventOfKind(
          'http.client',
          'fetch GET http://svc:' + CONNECTION_PASSWORD + '@127.0.0.1:20450/api/beta',
          {},
        ),
    },
    {
      // The key side of the pair: a producer that used a credential as an
      // attribute *name*. The name must reach neither the emitted bag nor the
      // `redacted` path list built from it.
      secretClass: 'credential used as an attribute key name',
      secrets: [PROVIDER_CREDENTIAL],
      keeps: 'AlphaPanel',
      build: () =>
        eventOfKind('log', 'boot alpha', {
          component: 'AlphaPanel',
          [PROVIDER_CREDENTIAL]: 'cache-hit',
        }),
    },
    {
      secretClass: 'opaque high-entropy attribute key name',
      secrets: [OPAQUE_ATTRIBUTE_NAME],
      keeps: 'AlphaPanel',
      build: () =>
        eventOfKind('log', 'boot alpha', {
          component: 'AlphaPanel',
          [OPAQUE_ATTRIBUTE_NAME]: 'cache-hit',
        }),
    },
    {
      // The header handler keeps every member key on purpose, so a name
      // inside a header map is the one that reaches the event unjudged.
      secretClass: 'credential used as a header name inside a header map',
      secrets: [PROVIDER_CREDENTIAL],
      keeps: 'application/json',
      build: () =>
        eventOfKind('fetch', 'fetch GET /api/alpha', {
          'http.request.headers': {
            accept: 'application/json',
            [PROVIDER_CREDENTIAL]: 'cache-hit',
          },
        }),
    },
    {
      // Not a credential: a query parameter value of the kind every real
      // request carries, under the key an error records its script URL in.
      // No content rule matches it, so only the URL handler can remove it.
      secretClass: 'personal identifier inside an error source URL',
      secrets: [CONTACT_ADDRESS],
      keeps: '/checkout',
      build: () =>
        eventOfKind('error', 'TypeError in AlphaPanel', {
          'error.type': 'TypeError',
          'error.source': `http://127.0.0.1:20450/checkout?email=${CONTACT_ADDRESS}&step=2`,
        }),
    },
    {
      secretClass: 'personal identifier inside a request initiator stack',
      secrets: [CONTACT_ADDRESS],
      // The frame that must survive whole: a URL with no query keeps its
      // position, which is what the source-map route resolves.
      keeps: SOURCE_FRAME_URL,
      build: () =>
        eventOfKind('fetch', 'fetch GET /api/alpha', {
          url: 'http://127.0.0.1:20450/api/alpha',
          initiator: initiatorStack(),
        }),
    },
  ];

  it.each(LEAK_CASES)(
    'never emits a $secretClass',
    ({ secretClass, secrets, keeps, build }: LeakCase) => {
      const fixture = checkedEvent(build());

      // Non-vacuous by construction: the fixture really carries each secret
      // before redaction, so no expectation below can pass because the
      // fixture never held what the row claims it does.
      const arrived = JSON.stringify(fixture);
      for (const secret of secrets) {
        expect(arrived, `fixture must carry the ${secretClass} it names`).toContain(secret);
      }

      const serialised = JSON.stringify(redactEvent(fixture));

      for (const secret of secrets) {
        expect(serialised, `a ${secretClass} survived redaction`).not.toContain(secret);
      }
      // The row's own evidence, so "nothing leaked" cannot be satisfied by
      // emitting nothing: the boundary removes credentials, not diagnostics.
      expect(serialised).toContain(keeps);
    },
  );

  it('covers every secret class exactly once', () => {
    const classes = LEAK_CASES.map((leakCase) => leakCase.secretClass);

    expect(new Set(classes).size).toBe(classes.length);
    // A guard on the table itself: a row deleted in a refactor is a class
    // that stops being checked, and nothing else in this file would notice.
    expect(classes.length).toBeGreaterThanOrEqual(10);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The committed corpora
 *
 * `../../test/fixtures/redaction-*.json` are the four shared before/after
 * pairs of AAP 0.2.5 — the single tracked-telemetry exemption of AAP 0.3.4 —
 * and they are read by other checkpoints and quoted by `docs/SECURITY.md`.
 * Everything above builds its own fixtures, so until this block existed all
 * four could drift from the redactor while every test in the file stayed
 * green. Each is therefore loaded from disk, parsed with `../schema/event.ts`
 * and replayed through `redactEvent` here.
 *
 * ## Why two of them are masked on both sides
 *
 * A corpus is committed telemetry, so it is held to the policy it documents:
 * a query string in it carries `?` for every value and a statement carries
 * `?`/`$n` placeholders rather than literals, on the `before` side as much as
 * the `after` side. `redaction-headers.json` already encodes that convention
 * for the fields it is not demonstrating ("`url`: already in its masked
 * form"), and the two corpora whose *subject* is a query string and a
 * statement follow the same rule.
 *
 * The pre-redaction value each one stands for is therefore rebuilt at run
 * time, by substituting synthetic sentinels for the masks — see
 * {@link materialiseQueryValues} and {@link materialiseSqlLiterals}. The
 * demonstration is unchanged and strictly stronger: the sentinels are values
 * no content rule matches, they are asserted present before redaction and
 * absent after it, and the masked bytes on disk are additionally asserted to
 * be a fixed point of the very handler they document.
 * ---------------------------------------------------------------------------
 */

/**
 * The fixture directory, as a filesystem path.
 *
 * Resolved with `fileURLToPath` and `resolve` rather than with
 * `new URL(relative, import.meta.url)`: this package's Vitest project runs
 * under happy-dom, whose global `URL` resolves a relative specifier against
 * the document base (`http://localhost:3000/`) instead of against the `file:`
 * URL it was handed, which yields an unreadable http URL. Converting the
 * module URL to a path first keeps the resolution pure path arithmetic and
 * independent of the environment — the convention
 * `../schema/attributes.test.ts` documents for the same reason.
 */
const FIXTURE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures');

/** One committed pair, with each side normalised to an array of raw events. */
interface RawCorpus {
  /** File name, used in every assertion message. */
  readonly file: string;
  readonly before: readonly unknown[];
  readonly after: readonly unknown[];
}

/** Normalises one side to an array, and says which file is malformed if not. */
function corpusSide(file: string, side: string, value: unknown): readonly unknown[] {
  if (value === undefined) {
    throw new Error(`${file} is missing its ${side} side`);
  }
  return Array.isArray(value) ? (value as readonly unknown[]) : [value];
}

/**
 * Reads one corpus at module load.
 *
 * Throws rather than asserting: `expect` may not be called outside a test, and
 * a corpus that cannot be read is not a redaction failure. The message names
 * the resolved path, because the usual cause is a moved fixture.
 *
 * `redaction-props-state.json` carries a two-element array per side (a render
 * event and a state event) while the other three carry one event; both shapes
 * are normalised here so every assertion below is written once.
 */
function readCorpus(file: string): RawCorpus {
  const path = resolve(FIXTURE_DIRECTORY, file);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(
      `the redaction corpus could not be read at ${path}. It is a tracked fixture of ` +
        'AAP 0.2.5; if it has moved, point this suite at its new path rather than removing ' +
        'the check.',
      { cause },
    );
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} must hold an object with a before and an after side`);
  }
  const { before, after } = parsed as { before?: unknown; after?: unknown };
  return {
    file,
    before: corpusSide(file, 'before', before),
    after: corpusSide(file, 'after', after),
  };
}

/** Parses one raw event with the schema the ingest path uses. */
function parsedEvent(label: string, raw: unknown): TelemetryEventIngress {
  const parsed = telemetryEventIngressSchema.safeParse(raw);
  expect(parsed.success, `${label} must parse as an ingress event`).toBe(true);
  if (!parsed.success) {
    // Unreachable: the expectation above has already failed the test.
    throw parsed.error;
  }
  return parsed.data;
}

/** Reads a string attribute, failing with the key when it is not one. */
function stringAttribute(event: TelemetryEventIngress, key: string): string {
  const value = event.attributes[key];
  expect(typeof value, `the corpus event must carry a string under ${key}`).toBe('string');
  return String(value);
}

/**
 * The synthetic values the URL corpus's masked query stands for, in order.
 *
 * Not credential-shaped and not short: no deny-list pattern matches them, so
 * the assertions they drive can only pass if `./url.ts` masked the query, and
 * each is distinctive enough that "absent after redaction" cannot be satisfied
 * by a coincidental substring of an id, a timestamp or a key name.
 */
const URL_CORPUS_QUERY_VALUES = [
  'sentinel-item-a17',
  'sentinel-sort-desc',
  'sentinel-page-two',
] as const;

/** The synthetic literals the SQL corpus's masked statement stands for, in order. */
const SQL_CORPUS_LITERALS = ["'sentinel-status'", "'sentinel-since'", '9081726'] as const;

/**
 * Rebuilds a pre-redaction query string from its masked form.
 *
 * Each `=?` pair value, in order, becomes the next synthetic sentinel. The
 * count is asserted rather than assumed, so a corpus edited to hold a
 * different number of parameters fails here with that as its reason instead of
 * silently testing fewer values than the sentinel list names.
 */
function materialiseQueryValues(masked: string, values: readonly string[]): string {
  let next = 0;
  const filled = masked.replace(/=\?(?=&|$)/g, () => {
    const value = values[next];
    next += 1;
    return value === undefined ? `=${REDACTION_MASK}` : `=${value}`;
  });

  expect(next, `expected ${String(values.length)} masked query values in "${masked}"`).toBe(
    values.length,
  );
  return filled;
}

/**
 * Rebuilds a pre-redaction statement from its parameterised form.
 *
 * Every `?` mask, in order, becomes the next synthetic literal; `$n`
 * placeholders hold no `?` and are therefore untouched, which is the
 * distinction the corpus exists to document — `$1` is structure the developer
 * needs, `?` is data that was removed.
 */
function materialiseSqlLiterals(masked: string, literals: readonly string[]): string {
  let next = 0;
  const filled = masked.replace(/\?/g, () => {
    const literal = literals[next];
    next += 1;
    return literal ?? REDACTION_MASK;
  });

  expect(next, `expected ${String(literals.length)} masks in "${masked}"`).toBe(literals.length);
  return filled;
}

/** The URL corpus's pre-redaction event: sentinels in the span name and the URL. */
function materialiseUrlEvent(event: TelemetryEventIngress): TelemetryEventIngress {
  return {
    ...event,
    name: materialiseQueryValues(event.name, URL_CORPUS_QUERY_VALUES),
    attributes: {
      ...event.attributes,
      url: materialiseQueryValues(stringAttribute(event, 'url'), URL_CORPUS_QUERY_VALUES),
    },
  };
}

/** The SQL corpus's pre-redaction event: sentinel literals in the statement. */
function materialiseSqlEvent(event: TelemetryEventIngress): TelemetryEventIngress {
  return {
    ...event,
    attributes: {
      ...event.attributes,
      'db.statement': materialiseSqlLiterals(
        stringAttribute(event, 'db.statement'),
        SQL_CORPUS_LITERALS,
      ),
    },
  };
}

/** One corpus, how its pre-redaction side is rebuilt, and what must not survive. */
interface CorpusCase {
  readonly file: string;
  readonly corpus: RawCorpus;
  /** Identity where the committed `before` side *is* the pre-redaction event. */
  readonly materialise: (event: TelemetryEventIngress) => TelemetryEventIngress;
  /**
   * Substrings that must be present before redaction and absent after it, so
   * no row can pass by demonstrating nothing.
   */
  readonly removed: readonly string[];
}

const CORPUS_CASES: readonly CorpusCase[] = [
  {
    file: 'redaction-headers.json',
    corpus: readCorpus('redaction-headers.json'),
    materialise: (event) => event,
    removed: ['example-placeholder'],
  },
  {
    file: 'redaction-url.json',
    corpus: readCorpus('redaction-url.json'),
    materialise: materialiseUrlEvent,
    removed: [...URL_CORPUS_QUERY_VALUES],
  },
  {
    file: 'redaction-sql.json',
    corpus: readCorpus('redaction-sql.json'),
    materialise: materialiseSqlEvent,
    removed: ['sentinel-status', 'sentinel-since', '9081726'],
  },
  {
    file: 'redaction-props-state.json',
    corpus: readCorpus('redaction-props-state.json'),
    materialise: (event) => event,
    // The tails of the two over-bound previews, which truncation removes.
    removed: ['anyone on the team', 'pinned to the left edge'],
  },
];

describe('the committed redaction corpora', () => {
  it('covers every corpus the fixture folder ships', () => {
    expect(CORPUS_CASES.map((corpusCase) => corpusCase.file)).toEqual([
      'redaction-headers.json',
      'redaction-url.json',
      'redaction-sql.json',
      'redaction-props-state.json',
    ]);
  });

  it.each([...CORPUS_CASES])('parses both sides of $file as ingress events', ({ corpus }) => {
    expect(corpus.before.length).toBeGreaterThan(0);
    expect(corpus.after).toHaveLength(corpus.before.length);

    for (const [index, raw] of corpus.before.entries()) {
      const before = parsedEvent(`${corpus.file} before[${String(index)}]`, raw);
      const after = parsedEvent(`${corpus.file} after[${String(index)}]`, corpus.after[index]);

      // Same event, redacted: identity, timing and provenance are untouched,
      // and `redacted` is the one key the after side may add.
      expect(after.id).toBe(before.id);
      expect(after.traceId).toBe(before.traceId);
      expect(after.spanId).toBe(before.spanId);
      expect(after.kind).toBe(before.kind);
      expect(after.tier).toBe(before.tier);
      expect(after.startTime).toBe(before.startTime);
      expect(after.duration).toBe(before.duration);
      expect(after.producerId).toBe(before.producerId);
      expect(after.seq).toBe(before.seq);
      expect(after.source).toEqual(before.source);
      expect(Object.keys(before)).not.toContain('redacted');
      expect(new Set(Object.keys(after))).toEqual(
        new Set([...Object.keys(before), ...(after.redacted === undefined ? [] : ['redacted'])]),
      );
    }
  });

  it.each([...CORPUS_CASES])(
    'reproduces $file from its pre-redaction side',
    ({ corpus, materialise, removed }) => {
      const inputs = corpus.before.map((raw, index) => {
        const label = `${corpus.file}[${String(index)}]`;
        // The pre-redaction event, validated exactly as the ingest path
        // validates a producer's event before redaction runs.
        return parsedEvent(
          `${label} materialised`,
          materialise(parsedEvent(`${label} before`, raw)),
        );
      });
      const outputs = inputs.map((input) => redactEvent(input));

      // Asserted over the whole side rather than per event, because a pair
      // may spread what it demonstrates across its elements: the props/state
      // corpus puts one over-bound preview on its render event and another on
      // its state event.
      const arrived = JSON.stringify(inputs);
      for (const secret of removed) {
        expect(arrived, `${corpus.file} must carry "${secret}" before redaction`).toContain(secret);
      }

      inputs.forEach((_input, index) => {
        const label = `${corpus.file}[${String(index)}]`;
        expect(outputs[index], label).toEqual(parsedEvent(`${label} after`, corpus.after[index]));
      });

      const serialised = JSON.stringify(outputs);
      for (const secret of removed) {
        expect(serialised, `"${secret}" survived redaction in ${corpus.file}`).not.toContain(
          secret,
        );
      }
    },
  );

  it.each([...CORPUS_CASES])('re-redacts $file to itself', ({ corpus }) => {
    // Idempotence on real data: the after side is a fixed point of the whole
    // event-level pass, `redacted` path list included.
    for (const [index, raw] of corpus.after.entries()) {
      const after = parsedEvent(`${corpus.file} after[${String(index)}]`, raw);

      expect(redactEvent(after)).toEqual(after);
    }
  });

  it.each([...CORPUS_CASES])('does not mutate the loaded $file events', ({ corpus }) => {
    for (const [index, raw] of corpus.before.entries()) {
      const event = parsedEvent(`${corpus.file} before[${String(index)}]`, raw);
      const snapshot = structuredClone(event);

      redactEvent(event);

      expect(event).toEqual(snapshot);
    }
  });

  it.each([...CORPUS_CASES])(
    'holds no unmasked query value or SQL literal in $file',
    ({ corpus }) => {
      // The committed-bytes policy, stated as a check rather than as a
      // comment: every URL in the corpus is already `?`-masked and every
      // statement already parameterised, on both sides. Deliberately narrow —
      // the header corpus's placeholder credentials and the props/state
      // corpus's over-bound previews are the dimensions those pairs
      // demonstrate, and each is masked by its own `after` side.
      for (const side of ['before', 'after'] as const) {
        for (const [index, raw] of corpus[side].entries()) {
          const label = `${corpus.file} ${side}[${String(index)}]`;
          const event = parsedEvent(label, raw);

          expect(redactEventName(event.kind, event.name), `${label}.name`).toBe(event.name);

          for (const [key, value] of Object.entries(event.attributes)) {
            if (isUrlAttributeKey(key)) {
              expect(redactUrl(value), `${label}.${key}`).toBe(value);
            }
            // The catalog's statement key, as the corpus spells it.
            if (key === 'db.statement') {
              expect(redactSqlStatement(value), `${label}.${key}`).toBe(value);
            }
          }
        }
      }
    },
  );
});
