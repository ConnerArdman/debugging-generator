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
 */
import { describe, expect, it } from 'vitest';

import { ALL_ATTRIBUTE_KEYS, MAX_PREVIEW_LENGTH, MAX_TRACKED_KEYS } from '../schema/attributes.js';
import {
  telemetryEventIngressSchema,
  telemetryEventSchema,
  type TelemetryEvent,
  type TelemetryEventIngress,
} from '../schema/event.js';
import type { TelemetryKind, TelemetryTier } from '../schema/kinds.js';
import {
  DROPPED_ATTRIBUTE_KEYS,
  MAX_ATTRIBUTE_DEPTH,
  MAX_ATTRIBUTE_NODES,
  UNTRUNCATED_ATTRIBUTE_KEYS,
  redactAttributes,
  redactAttributesWithFindings,
  redactEvent,
  redactEventName,
  redactEventWithFindings,
} from './redactor.js';
import { REDACTION_MARKER, REDACTION_MASK, TRUNCATION_SUFFIX, findDeniedRules } from './rules.js';

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

/** A credentialed connection string, scheme and userinfo assembled separately. */
const CONNECTION_STRING = 'pg' + 'sql://svc:' + 'e5'.repeat(6) + '@127.0.0.1:5432/db_a';

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
      'initiator',
    ]);
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
