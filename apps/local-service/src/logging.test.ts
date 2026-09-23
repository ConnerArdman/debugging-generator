/**
 * Tests for `./logging.ts`, the service's pino adapter.
 *
 * Two invariants dominate, and neither is enforced by the compiler:
 *
 * 1. **Argument order.** The shared `Logger` is message-first and pino is
 *    object-first, so an inverted adapter produces records whose `msg` is
 *    `[object Object]` and whose fields are a string. The first suite asserts
 *    the emitted JSON directly rather than trusting the call signature.
 * 2. **Redaction.** A log record is the last checkpoint between the
 *    developer's runtime data and a file on disk. One suite per class named in
 *    AAP §0.5.2 — tokens, `Authorization`/cookie headers, raw SQL, a rejected
 *    model payload and a database connection URL — plus the bounds and
 *    hostile-value cases that keep the value walk from stalling or throwing.
 *
 * Every credential-shaped fixture is **assembled at runtime from fragments**,
 * following `packages/model-provider/src/redact-guard.test.ts` and
 * `scripts/check-secrets.test.mjs`: this file is tracked, so
 * `pnpm check:secrets` scans it, and a literal that matched a provider regex
 * would fail that gate even though it is obviously fake.
 *
 * ## Why the second half of this file exists
 *
 * The suites from `redaction class 5 — database connection URLs` onwards cover
 * the hardening the module gained *after* the first ten suites were written,
 * each case aimed at a guarantee whose failure mode is silent:
 *
 * - **The database-URL name rule.** `DATABASE_URL` is data AAP §0.5.2 forbids
 *   capturing at all, and it defeats both general heuristics — the telemetry
 *   key vocabulary does not contain the word, and the connection-string
 *   content rule only removes a *userinfo* prefix, so a credential-free
 *   internal DSN survives it intact. The rule is name-based, and it has to
 *   distinguish `DIRECT_URL` from `redirectUrl` and `databaseUrl` from
 *   `databasePath` — a match that is too eager silently masks the session
 *   store's own path, and one that is too narrow writes the developer's
 *   database topology to a file.
 * - **Field names pino cannot receive.** pino resolves a serializer as
 *   `serializers[key]` on a plain object, so a field named after an
 *   `Object.prototype` property finds that property through the prototype
 *   chain: `logger.info` then *throws*, or emits a line no consumer can
 *   parse, or drops the field. `logger.error(...)` throwing is the one thing a
 *   logger must never do, so every name is exercised through the real pino
 *   path and every emitted line is parsed back.
 * - **Values that refuse to be read.** The objects reaching this layer include
 *   rejected model payloads and errors this service did not author. A throwing
 *   getter, a `Proxy` that refuses enumeration and one that refuses a
 *   prototype lookup each become a marker under their own key while every
 *   sibling field still travels.
 * - **The bounds.** Depth, node and key caps come from the redaction layer's
 *   own constants so this checkpoint can never be looser than the ingest one,
 *   and reaching any of them flags the record instead of leaving a reader to
 *   guess whether a branch was absent or merely cut.
 */

import { describe, expect, it } from 'vitest';

import pino from 'pino';

import { DebuggenError, noopLogger, type LogFields, type Logger } from '@debuggen/shared';
import { MAX_ATTRIBUTE_NODES, MAX_TRACKED_KEYS, REDACTION_MARKER } from '@debuggen/telemetry';

import type { ServiceConfig } from './config.js';
import {
  FIELDS_TRUNCATED_KEY,
  FIELDS_UNREADABLE_KEY,
  LOG_BINDING_KEYS,
  LOG_ERROR_FIELD_KEY,
  LOG_MARKERS,
  PROTOTYPE_LOG_KEYS,
  RESERVED_FIELD_PREFIX,
  RESERVED_LOG_KEYS,
  SERVICE_DATABASE_URL_KEY_NAMES,
  SERVICE_LOG_REDACT_PATHS,
  SERVICE_SENSITIVE_KEY_NAMES,
  SQL_STATEMENT_FIELD_KEYS,
  createServiceLogger,
  scrubLogFields,
  scrubLogMessage,
  sessionLogger,
  subsystemLogger,
} from './logging.js';

/**
 * A fully populated configuration, used as data only.
 *
 * Nothing here is created, opened or bound: every case constructs its logger
 * over a capturing destination, so the paths are strings the redaction rules
 * are asserted against (`databasePath` must stay readable, `authFilePath` must
 * not) and the port is never listened on.
 */
const BASE_CONFIG: ServiceConfig = {
  host: '127.0.0.1',
  port: 20310,
  logLevel: 'trace',
  retentionDays: 30,
  provider: 'deterministic',
  debuggenHome: '/tmp/debuggen-home/31',
  databasePath: '/tmp/debuggen-home/31/sessions.sqlite',
  backupsDir: '/tmp/debuggen-home/31/backups',
  indexCacheDir: '/tmp/debuggen-home/31/index',
  authFilePath: '/tmp/debuggen-home/31/auth.json',
  promptsDir: '/tmp/prompts',
};

/** Credential-shaped fixtures, assembled at runtime so no literal is ever written. */
const fixtures = {
  providerKey: ['sk', 'ant', 'api03', 'Zq'.repeat(24)].join('-'),
  bearer: ['Bearer', ['tk', 'Wv'.repeat(22)].join('')].join(' '),
  jwt: [
    ['eyJhbGciOiJIUzI1', 'NiIsInR5cCI6Ikp', 'XVCJ9'].join(''),
    ['eyJzdWIiOiIxMjM0', 'NTY3ODkwIn0'].join(''),
    ['Qm', 'Xy'.repeat(18)].join(''),
  ].join('.'),
  connectionString: ['postgresql://', 'u', ':', 'p', '@localhost:5432/db'].join(''),
  /**
   * A credential-*free* DSN: the case the content rules provably do not catch,
   * which is the whole reason the name rule of
   * {@link SERVICE_DATABASE_URL_KEY_NAMES} exists. Assembled from fragments
   * like the rest so `pnpm check:secrets` has nothing to match on.
   */
  dsnWithoutCredentials: ['postgresql://', 'db.internal', ':5432/', 'appdb'].join(''),
};

interface Capture {
  readonly logger: Logger;
  readonly records: () => Record<string, unknown>[];
  readonly lines: () => string[];
}

function capture(config: Partial<ServiceConfig> = {}, bindings?: LogFields): Capture {
  const lines: string[] = [];
  const merged: ServiceConfig = { ...BASE_CONFIG, ...config };
  const logger = createServiceLogger(merged, {
    destination: { write: (line: string) => void lines.push(line) },
    ...(bindings === undefined ? {} : { bindings }),
  });
  return {
    logger,
    lines: () => [...lines],
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/**
 * A field bag that refuses to be enumerated at all.
 *
 * `Object.keys` is not inert on an arbitrary value, and the objects reaching
 * this layer include rejected model payloads: a `Proxy` whose `ownKeys` trap
 * throws is the shape that would otherwise take a whole log call down.
 */
function unreadableBag(): LogFields {
  const target: LogFields = {};
  return new Proxy(target, {
    ownKeys(): never {
      throw new Error('this object refuses enumeration');
    },
  });
}

/**
 * A value whose prototype cannot be inspected.
 *
 * The walk asks `value instanceof Error` before anything else, and
 * `instanceof` consults the value's prototype — which a `Proxy` may refuse.
 * This is the one hostile shape that throws *outside* a property read.
 */
function hostilePrototype(): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    getPrototypeOf(): never {
      throw new Error('this object refuses a prototype lookup');
    },
  });
}

describe('pino argument order', () => {
  it('emits the message as msg and the fields as siblings', () => {
    const c = capture();
    c.logger.info('message', { a: 1 });
    const [record] = c.records();
    expect(record).toBeDefined();
    expect(record?.msg).toBe('message');
    expect(record?.a).toBe(1);
    expect(record?.level).toBe(30);
    expect(typeof record?.time).toBe('number');
  });

  it('emits no merge object when there are no fields', () => {
    const c = capture();
    c.logger.info('plain');
    const [record] = c.records();
    expect(Object.keys(record ?? {}).sort()).toEqual(['level', 'msg', 'time']);
  });

  it('emits no merge object when every field was dropped', () => {
    const c = capture();
    c.logger.info('plain', { absent: undefined });
    const [record] = c.records();
    expect(Object.keys(record ?? {}).sort()).toEqual(['level', 'msg', 'time']);
  });

  it('drops pino base bindings (pid, hostname)', () => {
    const c = capture();
    c.logger.info('plain');
    const [record] = c.records();
    expect(record).not.toHaveProperty('pid');
    expect(record).not.toHaveProperty('hostname');
  });
});

describe('levels', () => {
  it('implements all six with pino level values', () => {
    const c = capture();
    c.logger.trace('t');
    c.logger.debug('d');
    c.logger.info('i');
    c.logger.warn('w');
    c.logger.error('e');
    c.logger.fatal('f');
    expect(c.records().map((r) => r.level)).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it('gates below the configured threshold', () => {
    const c = capture({ logLevel: 'warn' });
    c.logger.trace('t');
    c.logger.debug('d');
    c.logger.info('i');
    c.logger.warn('w');
    expect(c.records().map((r) => r.msg)).toEqual(['w']);
    expect(c.logger.level).toBe('warn');
  });

  it('returns noopLogger for silent and writes nothing', () => {
    const c = capture({ logLevel: 'silent' });
    expect(c.logger).toBe(noopLogger);
    expect(c.logger.level).toBe('silent');
    c.logger.error('never');
    c.logger.child({ a: 1 }).error('never');
    expect(c.lines()).toEqual([]);
  });

  it('clamps an unrecognised level instead of throwing', () => {
    const c = capture({ logLevel: 'bogus' as ServiceConfig['logLevel'] });
    expect(c.logger.level).toBe('info');
    c.logger.debug('suppressed');
    c.logger.info('kept');
    expect(c.records().map((r) => r.msg)).toEqual(['kept']);
  });

  it('honours an options level override', () => {
    const lines: string[] = [];
    const logger = createServiceLogger(BASE_CONFIG, {
      destination: { write: (line: string) => void lines.push(line) },
      level: 'error',
    });
    expect(logger.level).toBe('error');
    logger.warn('no');
    logger.error('yes');
    expect(lines).toHaveLength(1);
  });
});

describe('child loggers', () => {
  it('returns a Logger, not a pino instance', () => {
    const child = capture().logger.child({ subsystem: 'store' });
    expect(typeof child.child).toBe('function');
    expect(child.level).toBe('trace');
    expect(child).not.toHaveProperty('levelVal');
    expect(child).not.toHaveProperty('bindings');
  });

  it('carries bindings onto every record', () => {
    const c = capture();
    subsystemLogger(c.logger, 'store').info('opened', { schemaVersion: 3 });
    const [record] = c.records();
    expect(record?.[LOG_BINDING_KEYS.subsystem]).toBe('store');
    expect(record?.schemaVersion).toBe(3);
  });

  it('lets a per-call field win over a child binding (last-wins)', () => {
    const c = capture();
    c.logger.child({ sessionId: 'from-child' }).info('m', { sessionId: 'from-call' });
    const [record] = c.records();
    expect(record?.sessionId).toBe('from-call');
  });

  it('lets a child binding win over a parent binding', () => {
    const c = capture();
    c.logger.child({ client: 'vscode' }).child({ client: 'devtools' }).info('m');
    const [record] = c.records();
    expect(record?.client).toBe('devtools');
  });

  it('binds captureId only when given', () => {
    const c = capture();
    sessionLogger(c.logger, 's1').info('a');
    sessionLogger(c.logger, 's1', 'c1').info('b');
    const records = c.records();
    expect(records[0]).not.toHaveProperty(LOG_BINDING_KEYS.captureId);
    expect(records[1]?.[LOG_BINDING_KEYS.captureId]).toBe('c1');
  });

  it('seeds root bindings from options', () => {
    const c = capture({}, { [LOG_BINDING_KEYS.client]: 'server-agent' });
    c.logger.info('m');
    expect(c.records()[0]?.client).toBe('server-agent');
  });

  it('redacts a sensitive child binding', () => {
    const c = capture();
    c.logger.child({ token: fixtures.providerKey }).info('m');
    expect(c.records()[0]?.token).toBe(REDACTION_MARKER);
  });
});

describe('redaction class 1 — tokens', () => {
  it('masks a top-level token', () => {
    expect(scrubLogFields({ token: fixtures.providerKey }).token).toBe(REDACTION_MARKER);
  });

  it('masks a token nested deeper than a pino wildcard reaches', () => {
    const scrubbed = scrubLogFields({ outer: { inner: { token: fixtures.providerKey } } });
    const outer = scrubbed.outer as Record<string, unknown>;
    const inner = outer.inner as Record<string, unknown>;
    expect(inner.token).toBe(REDACTION_MARKER);
    expect(JSON.stringify(scrubbed)).not.toContain(fixtures.providerKey);
  });

  it('masks every name the service adds beyond the telemetry vocabulary', () => {
    for (const name of SERVICE_SENSITIVE_KEY_NAMES) {
      expect(scrubLogFields({ [name]: fixtures.bearer })[name]).toBe(REDACTION_MARKER);
    }
  });

  it('masks the per-session request_key HMAC key', () => {
    expect(scrubLogFields({ sessionKey: fixtures.providerKey }).sessionKey).toBe(REDACTION_MARKER);
  });

  it('keeps the product identifiers readable', () => {
    const scrubbed = scrubLogFields({
      sessionId: 's1',
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
    });
    expect(scrubbed.sessionId).toBe('s1');
    expect(scrubbed.traceId).toBe('a'.repeat(32));
    expect(scrubbed.spanId).toBe('b'.repeat(16));
  });

  it('scrubs a credential in a value under an innocent name', () => {
    const scrubbed = scrubLogFields({ note: `key is ${fixtures.providerKey} ok` });
    expect(scrubbed.note).not.toContain(fixtures.providerKey);
    expect(String(scrubbed.note)).toContain(REDACTION_MARKER);
  });

  it('scrubs a jwt and a credentialed connection string', () => {
    expect(scrubLogFields({ note: fixtures.jwt }).note).toBe(REDACTION_MARKER);
    expect(String(scrubLogFields({ dsn: fixtures.connectionString }).dsn)).not.toContain(':p@');
  });

  it('scrubs the message too', () => {
    const c = capture();
    c.logger.error(`failed with ${fixtures.providerKey}`);
    expect(c.lines().join('')).not.toContain(fixtures.providerKey);
    expect(scrubLogMessage(fixtures.jwt)).toBe(REDACTION_MARKER);
  });
});

describe('redaction class 2 — Authorization and cookie headers', () => {
  it('masks the value and keeps the presence', () => {
    const scrubbed = scrubLogFields({
      headers: {
        authorization: fixtures.bearer,
        cookie: ['sid', fixtures.providerKey].join('='),
        'content-type': 'application/json',
      },
    });
    const headers = scrubbed.headers as Record<string, unknown>;
    expect(headers.authorization).toBe(REDACTION_MARKER);
    expect(headers.cookie).toBe(REDACTION_MARKER);
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.stringify(scrubbed)).not.toContain(fixtures.providerKey);
  });

  it('masks the OpenTelemetry header attribute spelling', () => {
    const scrubbed = scrubLogFields({
      'http.request.header.authorization': fixtures.bearer,
      'http.response.header.set-cookie': fixtures.providerKey,
    });
    expect(scrubbed['http.request.header.authorization']).toBe(REDACTION_MARKER);
    expect(scrubbed['http.response.header.set-cookie']).toBe(REDACTION_MARKER);
  });

  it('survives the full logger path', () => {
    const c = capture();
    c.logger.info('request', { headers: { Authorization: fixtures.bearer } });
    expect(c.lines().join('')).not.toContain(fixtures.bearer.split(' ')[1] ?? 'x');
  });
});

describe('redaction class 3 — raw SQL', () => {
  it('parameterises every inline literal', () => {
    for (const key of SQL_STATEMENT_FIELD_KEYS) {
      const scrubbed = scrubLogFields({
        [key]: "SELECT id FROM customer WHERE email = 'ada@example.com' AND age > 42",
      });
      const text = String(scrubbed[key]);
      expect(text).not.toContain('ada@example.com');
      expect(text).not.toContain('42');
      expect(text).toContain('?');
      expect(text).toContain('SELECT');
    }
  });

  it('never emits row contents or bound parameters', () => {
    const scrubbed = scrubLogFields({
      rows: [{ email: 'ada@example.com' }],
      params: ['ada@example.com'],
      body: { password: 'hunter2' },
      responseBody: 'x',
    });
    expect(scrubbed.rows).toBe(REDACTION_MARKER);
    expect(scrubbed.params).toBe(REDACTION_MARKER);
    expect(scrubbed.body).toBe(REDACTION_MARKER);
    expect(scrubbed.responseBody).toBe(REDACTION_MARKER);
    expect(JSON.stringify(scrubbed)).not.toContain('ada@example.com');
  });
});

describe('redaction class 4 — rejected model payloads', () => {
  it('scrubs a credential anywhere inside a rejected structured output', () => {
    const rejected = {
      title: 'Checkout Latency',
      layout: [
        { type: 'timeline', note: fixtures.providerKey },
        { type: 'table', headers: { authorization: fixtures.bearer } },
      ],
      apiKey: fixtures.providerKey,
      raw: fixtures.jwt,
    };
    const c = capture();
    c.logger.warn('panel input failed normalisation', { input: rejected, stage: 'generate-panel' });
    const line = c.lines().join('');
    expect(line).not.toContain(fixtures.providerKey);
    expect(line).not.toContain(fixtures.jwt);
    expect(line).toContain('generate-panel');
    expect(line).toContain('Checkout Latency');
  });
});

describe('structure, bounds and hostile values', () => {
  it('never mutates the caller fields', () => {
    const fields: LogFields = { token: fixtures.providerKey, nested: { a: 1 } };
    const before = JSON.stringify(fields);
    capture().logger.info('m', fields);
    expect(JSON.stringify(fields)).toBe(before);
  });

  it('renames a field that collides with a pino key', () => {
    const c = capture();
    c.logger.info('real message', { msg: 'field value', level: 'bogus', time: 1, a: 2 });
    const [record] = c.records();
    expect(record?.msg).toBe('real message');
    expect(record?.level).toBe(30);
    expect(typeof record?.time).toBe('number');
    for (const key of RESERVED_LOG_KEYS) {
      expect(record).toHaveProperty(`${RESERVED_FIELD_PREFIX}${key}`);
    }
    expect(record?.[`${RESERVED_FIELD_PREFIX}msg`]).toBe('field value');
    expect(record?.a).toBe(2);
  });

  it('keeps scalar JSON types and converts what pino would mangle', () => {
    const scrubbed = scrubLogFields({
      n: 42,
      b: false,
      z: null,
      big: 9007199254740993n,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      when: new Date(0),
      fn: () => 1,
    });
    expect(scrubbed.n).toBe(42);
    expect(scrubbed.b).toBe(false);
    expect(scrubbed.z).toBeNull();
    expect(scrubbed.big).toBe('9007199254740993');
    expect(scrubbed.nan).toBe('NaN');
    expect(scrubbed.inf).toBe('Infinity');
    expect(scrubbed.when).toBe('1970-01-01T00:00:00.000Z');
    expect(scrubbed.fn).toBe(LOG_MARKERS.function);
  });

  it('cuts a cycle but keeps sibling references', () => {
    const shared: Record<string, unknown> = { name: 'x' };
    shared.self = shared;
    const scrubbed = scrubLogFields({ a: shared, b: shared });
    const a = scrubbed.a as Record<string, unknown>;
    const b = scrubbed.b as Record<string, unknown>;
    expect(a.self).toBe(LOG_MARKERS.circular);
    expect(b.name).toBe('x');
  });

  it('bounds depth and flags the record', () => {
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: 'far' } } } } } } };
    const scrubbed = scrubLogFields(deep);
    expect(scrubbed[FIELDS_TRUNCATED_KEY]).toBe(true);
    expect(JSON.stringify(scrubbed)).toContain(LOG_MARKERS.truncated);
  });

  it('bounds the key count per object', () => {
    const wide: LogFields = {};
    for (let i = 0; i < 60; i += 1) {
      wide[`k${i}`] = i;
    }
    const scrubbed = scrubLogFields(wide);
    expect(Object.keys(scrubbed).length).toBeLessThanOrEqual(33);
    expect(scrubbed[FIELDS_TRUNCATED_KEY]).toBe(true);
  });

  it('bounds an array and marks the cut', () => {
    const scrubbed = scrubLogFields({ list: Array.from({ length: 100 }, (_, i) => i) });
    const list = scrubbed.list as unknown[];
    expect(list.length).toBeLessThanOrEqual(33);
    expect(list.at(-1)).toBe(LOG_MARKERS.truncated);
  });

  it('survives a throwing getter without throwing', () => {
    const hostile = {
      get boom(): string {
        throw new Error('nope');
      },
      ok: 1,
    };
    const c = capture();
    expect(() => c.logger.info('m', { hostile })).not.toThrow();
    const line = c.lines().join('');
    expect(line).toContain(LOG_MARKERS.unserializable);
  });

  it('never invokes an untrusted toJSON or toString', () => {
    let called = 0;
    const hostile = {
      toJSON: () => {
        called += 1;
        return 'via-toJSON';
      },
      toString: () => {
        called += 1;
        return 'via-toString';
      },
      safe: 'kept',
    };
    const scrubbed = scrubLogFields({ hostile });
    expect(called).toBe(0);
    const inner = scrubbed.hostile as Record<string, unknown>;
    expect(inner.safe).toBe('kept');
    expect(inner.toJSON).toBe(LOG_MARKERS.function);
  });

  it('converts a Map and a Set structurally', () => {
    const scrubbed = scrubLogFields({
      m: new Map<string, unknown>([
        ['token', fixtures.providerKey],
        ['count', 2],
      ]),
      s: new Set([1, 2, 2]),
    });
    const m = scrubbed.m as Record<string, unknown>;
    expect(m.token).toBe(REDACTION_MARKER);
    expect(m.count).toBe(2);
    expect(scrubbed.s).toEqual([1, 2]);
  });
});

describe('errors', () => {
  it('serialises a plain Error with a scrubbed message and stack', () => {
    const c = capture();
    c.logger.error('failed', {
      [LOG_ERROR_FIELD_KEY]: new Error(`bad key ${fixtures.providerKey}`),
    });
    const [record] = c.records();
    const err = record?.[LOG_ERROR_FIELD_KEY] as Record<string, unknown>;
    expect(err.type).toBe('Error');
    expect(String(err.message)).toContain(REDACTION_MARKER);
    expect(typeof err.stack).toBe('string');
    expect(c.lines().join('')).not.toContain(fixtures.providerKey);
  });

  it('serialises a DebuggenError as its payload plus scrubbed details', () => {
    const error = new DebuggenError('CONFIG_INVALID', 'config rejected', {
      hint: 'set DEBUGGEN_LOG_LEVEL',
      details: { setting: 'DEBUGGEN_PORT', key: 'DEBUGGEN_PORT', token: fixtures.providerKey },
      cause: new Error(`inner ${fixtures.jwt}`),
    });
    const c = capture();
    c.logger.fatal('boom', { [LOG_ERROR_FIELD_KEY]: error });
    const [record] = c.records();
    const err = record?.[LOG_ERROR_FIELD_KEY] as Record<string, unknown>;
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.message).toBe('config rejected');
    expect(err.hint).toBe('set DEBUGGEN_LOG_LEVEL');
    const details = err.details as Record<string, unknown>;
    expect(details.setting).toBe('DEBUGGEN_PORT');
    // Deliberately over-masked: any name folding onto a sensitive term is masked.
    expect(details.key).toBe(REDACTION_MARKER);
    expect(details.token).toBe(REDACTION_MARKER);
    const cause = err.cause as Record<string, unknown>;
    expect(String(cause.message)).toContain(REDACTION_MARKER);
    expect(c.lines().join('')).not.toContain(fixtures.jwt);
  });
});

describe('layer 1 declaration', () => {
  it('is a frozen, non-empty path list pino accepts', () => {
    expect(Object.isFrozen(SERVICE_LOG_REDACT_PATHS)).toBe(true);
    expect(SERVICE_LOG_REDACT_PATHS.length).toBeGreaterThan(0);
    expect(() => capture().logger.info('m')).not.toThrow();
  });

  it('censors with the imported marker', () => {
    const lines: string[] = [];
    const logger = createServiceLogger(BASE_CONFIG, {
      destination: { write: (line: string) => void lines.push(line) },
    });
    logger.info('m', { password: 'x'.repeat(8) });
    expect(lines.join('')).toContain(REDACTION_MARKER);
  });
});

describe('redaction class 5 — database connection URLs', () => {
  it('masks every spelling the name rule declares', () => {
    for (const name of SERVICE_DATABASE_URL_KEY_NAMES) {
      const scrubbed = scrubLogFields({ [name]: fixtures.dsnWithoutCredentials });
      expect(scrubbed[name], name).toBe(REDACTION_MARKER);
    }
  });

  it('masks a compound name carrying the declared word run, singular or plural', () => {
    const scrubbed = scrubLogFields({
      shadowDatabaseUrl: fixtures.dsnWithoutCredentials,
      DATABASE_URL_UNPOOLED: fixtures.dsnWithoutCredentials,
      connectionStrings: [fixtures.dsnWithoutCredentials],
      databaseUrls: [fixtures.dsnWithoutCredentials],
    });
    expect(scrubbed.shadowDatabaseUrl).toBe(REDACTION_MARKER);
    expect(scrubbed.DATABASE_URL_UNPOOLED).toBe(REDACTION_MARKER);
    // A denied name masks the value whole, so wrapping a DSN in an array does
    // not carry it past the rule.
    expect(scrubbed.connectionStrings).toBe(REDACTION_MARKER);
    expect(scrubbed.databaseUrls).toBe(REDACTION_MARKER);
    expect(JSON.stringify(scrubbed)).not.toContain(fixtures.dsnWithoutCredentials);
  });

  it('leaves a name that merely resembles one readable', () => {
    const redirect = 'https://app.example.test/next';
    const requestUrl = 'https://app.example.test/api/items?page=2';
    const scrubbed = scrubLogFields({
      redirectUrl: redirect,
      databasePath: BASE_CONFIG.databasePath,
      url: requestUrl,
    });
    // `redirecturl` contains `directurl` when folded; the word-run rule is
    // what keeps a redirect target — and the store's own SQLite path, and the
    // request URLs this product exists to show — out of the mask.
    expect(scrubbed.redirectUrl).toBe(redirect);
    expect(scrubbed.databasePath).toBe(BASE_CONFIG.databasePath);
    expect(scrubbed.url).toBe(requestUrl);
  });

  it('masks the credential file path while the state paths stay readable', () => {
    // This is the record the service emits at start-up under
    // `subsystem: config`, and the sensitive-term vocabulary is what separates
    // its paths: `authFilePath` folds onto `auth`, so the file holding the
    // editor credential is masked, while the store, backup and index paths are
    // diagnostics a developer needs and fold onto nothing.
    const scrubbed = scrubLogFields({
      databasePath: BASE_CONFIG.databasePath,
      backupsDir: BASE_CONFIG.backupsDir,
      indexCacheDir: BASE_CONFIG.indexCacheDir,
      authFilePath: BASE_CONFIG.authFilePath,
    });
    expect(scrubbed.databasePath).toBe(BASE_CONFIG.databasePath);
    expect(scrubbed.backupsDir).toBe(BASE_CONFIG.backupsDir);
    expect(scrubbed.indexCacheDir).toBe(BASE_CONFIG.indexCacheDir);
    expect(scrubbed.authFilePath).toBe(REDACTION_MARKER);
  });

  it('masks a DSN nested deeper than a pino wildcard reaches', () => {
    const scrubbed = scrubLogFields({
      store: { pool: { connectionString: fixtures.dsnWithoutCredentials } },
    });
    const store = scrubbed.store as Record<string, unknown>;
    const pool = store.pool as Record<string, unknown>;
    expect(pool.connectionString).toBe(REDACTION_MARKER);
    expect(JSON.stringify(scrubbed)).not.toContain(fixtures.dsnWithoutCredentials);
  });

  it('declares the same names in both layers', () => {
    expect(Object.isFrozen(SERVICE_DATABASE_URL_KEY_NAMES)).toBe(true);
    for (const name of SERVICE_DATABASE_URL_KEY_NAMES) {
      expect(SERVICE_LOG_REDACT_PATHS, name).toContain(name);
      expect(SERVICE_LOG_REDACT_PATHS, name).toContain(`*.${name}`);
    }
  });

  it('survives the full logger path', () => {
    const c = capture();
    c.logger.info('store ready', {
      DATABASE_URL: fixtures.dsnWithoutCredentials,
      pool: { connectionString: fixtures.dsnWithoutCredentials },
      databasePath: BASE_CONFIG.databasePath,
    });
    const line = c.lines().join('');
    expect(line).not.toContain(fixtures.dsnWithoutCredentials);
    expect(line).toContain(REDACTION_MARKER);
    expect(line).toContain(BASE_CONFIG.databasePath);
  });
});

describe('field names pino cannot receive', () => {
  it('derives the prototype names from the runtime', () => {
    expect([...PROTOTYPE_LOG_KEYS].sort()).toEqual(
      [...Object.getOwnPropertyNames(Object.prototype)].sort(),
    );
    expect(Object.isFrozen(PROTOTYPE_LOG_KEYS)).toBe(true);
    // The three behaviours the module documents: a throw, unquoted JSON and a
    // silently dropped field. All three names must be in the list.
    expect(PROTOTYPE_LOG_KEYS).toContain('valueOf');
    expect(PROTOTYPE_LOG_KEYS).toContain('constructor');
    expect(PROTOTYPE_LOG_KEYS).toContain('isPrototypeOf');
  });

  it('renames every prototype name, throws nothing and stays parseable', () => {
    for (const name of PROTOTYPE_LOG_KEYS) {
      const c = capture();
      expect(() => {
        c.logger.info('real message', { [name]: 'field value', keep: 1 });
      }, name).not.toThrow();
      const [line] = c.lines();
      expect(line, name).toBeDefined();
      expect(() => {
        JSON.parse(line ?? '');
      }, name).not.toThrow();
      const [record] = c.records();
      expect(record?.msg, name).toBe('real message');
      expect(record?.keep, name).toBe(1);
      expect(record?.[`${RESERVED_FIELD_PREFIX}${name}`], name).toBe('field value');
      expect(Object.hasOwn(record ?? {}, name), name).toBe(false);
    }
  });

  it('keeps a nested prototype name as data without touching a prototype', () => {
    const nested: Record<string, unknown> = {};
    // A computed assignment, not `{ __proto__: … }`: the literal form would
    // set this fixture's own prototype instead of adding the field under test.
    Object.defineProperty(nested, '__proto__', {
      value: 'ordinary data',
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const scrubbed = scrubLogFields({ outer: nested });
    const outer = scrubbed.outer as Record<string, unknown>;
    expect(Object.hasOwn(outer, '__proto__')).toBe(true);
    expect(outer['__proto__']).toBe('ordinary data');
    // Null prototype is why the assignment above became an own property rather
    // than reaching Object.prototype's setter and dropping the field.
    expect(Object.getPrototypeOf(outer)).toBeNull();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('resolves a collision with the prefixed name by prefixing again', () => {
    const scrubbed = scrubLogFields({ [`${RESERVED_FIELD_PREFIX}msg`]: 'first', msg: 'second' });
    expect(scrubbed[`${RESERVED_FIELD_PREFIX}msg`]).toBe('first');
    expect(scrubbed[`${RESERVED_FIELD_PREFIX}${RESERVED_FIELD_PREFIX}msg`]).toBe('second');
  });

  it('lets a binding carry a prototype name, at the root and on a child', () => {
    // pino's `child()` calls `bindings.hasOwnProperty(…)` on the object it is
    // handed, which is why the record pino merges keeps its prototype: a
    // null-prototype bag throws here instead of binding.
    const c = capture({}, { valueOf: 'root binding' });
    expect(() => {
      c.logger.child({ hasOwnProperty: 'child binding' }).info('bound');
    }).not.toThrow();
    const [record] = c.records();
    expect(record?.[`${RESERVED_FIELD_PREFIX}valueOf`]).toBe('root binding');
    expect(record?.[`${RESERVED_FIELD_PREFIX}hasOwnProperty`]).toBe('child binding');
  });
});

describe('values that refuse to be read', () => {
  it('reports a field bag that refuses enumeration instead of dropping it', () => {
    const scrubbed = scrubLogFields(unreadableBag());
    expect(Object.keys(scrubbed)).toEqual([FIELDS_UNREADABLE_KEY]);
    expect(scrubbed[FIELDS_UNREADABLE_KEY]).toBe(LOG_MARKERS.unserializable);
    // Distinct from the truncation flag: the walk did not choose to stop.
    expect(scrubbed[FIELDS_TRUNCATED_KEY]).toBeUndefined();
  });

  it('confines an unreadable nested value to its own key', () => {
    const c = capture();
    expect(() => {
      c.logger.warn('ingest rejected', { inner: unreadableBag(), sibling: 'kept' });
    }).not.toThrow();
    const [record] = c.records();
    const inner = record?.inner as Record<string, unknown>;
    expect(inner[FIELDS_UNREADABLE_KEY]).toBe(LOG_MARKERS.unserializable);
    expect(record?.sibling).toBe('kept');
  });

  it('survives a value whose prototype lookup throws', () => {
    const scrubbed = scrubLogFields({ bad: hostilePrototype(), good: 2 });
    expect(scrubbed.bad).toBe(LOG_MARKERS.unserializable);
    expect(scrubbed.good).toBe(2);
  });

  it('survives such a value inside an array without losing its neighbours', () => {
    const scrubbed = scrubLogFields({ list: [1, hostilePrototype(), 3] });
    expect(scrubbed.list).toEqual([1, LOG_MARKERS.unserializable, 3]);
  });

  it('serialises an error whose own properties throw or lie', () => {
    const error = new Error('never read');
    Object.defineProperty(error, 'name', { get: () => 42 });
    Object.defineProperty(error, 'message', {
      get: (): string => {
        throw new Error('this error refuses its message');
      },
    });
    Object.defineProperty(error, 'cause', {
      get: (): unknown => {
        throw new Error('this error refuses its cause');
      },
    });
    Object.defineProperty(error, 'stack', { value: '' });

    const c = capture();
    expect(() => {
      c.logger.error('failed', { [LOG_ERROR_FIELD_KEY]: error });
    }).not.toThrow();
    const [record] = c.records();
    const err = record?.[LOG_ERROR_FIELD_KEY] as Record<string, unknown>;
    expect(err.type).toBe(LOG_MARKERS.unserializable);
    expect(err.message).toBe(LOG_MARKERS.unserializable);
    expect(err.cause).toBe(LOG_MARKERS.unserializable);
    // An empty stack is omitted rather than emitted as an empty string.
    expect(err).not.toHaveProperty('stack');
  });

  it('serialises a DebuggenError that carries neither hint nor details', () => {
    const c = capture();
    c.logger.error('failed', {
      [LOG_ERROR_FIELD_KEY]: new DebuggenError('INTERNAL', 'bare failure'),
    });
    const [record] = c.records();
    const err = record?.[LOG_ERROR_FIELD_KEY] as Record<string, unknown>;
    expect(err.type).toBe('DebuggenError');
    expect(err.code).toBe('INTERNAL');
    expect(err.message).toBe('bare failure');
    expect(err).not.toHaveProperty('hint');
    expect(err).not.toHaveProperty('details');
    expect(typeof err.stack).toBe('string');
  });
});

describe('bounds, from the redaction layer constants', () => {
  it('stops at the node budget, cutting the array it was inside and the field after it', () => {
    // One key per array plus its elements is `MAX_TRACKED_KEYS + 1` nodes, so
    // the budget runs out part-way through the array at index `spent` and is
    // already gone when the field after it is reached. Both cuts are asserted,
    // because they are two different guards: one inside the array walk, one at
    // the field walk before any value is read.
    const spent = Math.ceil(MAX_ATTRIBUTE_NODES / (MAX_TRACKED_KEYS + 1)) - 1;
    const fields: LogFields = {};
    for (let index = 0; index <= spent + 1; index += 1) {
      fields[`k${index}`] = Array.from({ length: MAX_TRACKED_KEYS }, (_, element) => element);
    }

    const scrubbed = scrubLogFields(fields);
    expect(scrubbed[FIELDS_TRUNCATED_KEY]).toBe(true);
    expect(scrubbed.k0).toHaveLength(MAX_TRACKED_KEYS);
    const cutArray = scrubbed[`k${spent}`] as unknown[];
    expect(cutArray.at(-1)).toBe(LOG_MARKERS.truncated);
    expect(cutArray.length).toBeLessThan(MAX_TRACKED_KEYS);
    expect(scrubbed[`k${spent + 1}`]).toBe(LOG_MARKERS.truncated);
  });

  it('bounds a Map at the key cap and flags the record', () => {
    const map = new Map<string, number>();
    for (let index = 0; index < MAX_TRACKED_KEYS + 8; index += 1) {
      map.set(`m${index}`, index);
    }
    const scrubbed = scrubLogFields({ map });
    expect(Object.keys(scrubbed.map as object)).toHaveLength(MAX_TRACKED_KEYS);
    expect(scrubbed[FIELDS_TRUNCATED_KEY]).toBe(true);
  });

  it('lets a scalar at the depth bound travel', () => {
    const scrubbed = scrubLogFields({ l1: { l2: { l3: { l4: { l5: { l6: 'far' } } } } } });
    expect(scrubbed[FIELDS_TRUNCATED_KEY]).toBeUndefined();
    expect(JSON.stringify(scrubbed)).toContain('far');
  });

  it('masks a denied name whatever the value is, and keeps an empty value empty', () => {
    const scrubbed = scrubLogFields({
      token: null,
      password: '',
      secret: { nested: fixtures.providerKey },
    });
    expect(scrubbed.token).toBe(REDACTION_MARKER);
    // Empty stays empty so a reader can tell "absent" from "suppressed".
    expect(scrubbed.password).toBe('');
    expect(scrubbed.secret).toBe(REDACTION_MARKER);
  });

  it('is idempotent: scrubbing a scrubbed bag changes nothing', () => {
    const once = scrubLogFields({
      note: `key is ${fixtures.providerKey}`,
      nested: { list: [1, 2] },
      token: fixtures.bearer,
    });
    expect(scrubLogFields(once)).toEqual(once);
  });
});

describe('value kinds JSON cannot carry', () => {
  it('renders a symbol by description and scrubs it', () => {
    const scrubbed = scrubLogFields({
      plain: Symbol('stage'),
      hostile: Symbol(fixtures.providerKey),
    });
    expect(scrubbed.plain).toBe('Symbol(stage)');
    expect(String(scrubbed.hostile)).toContain(REDACTION_MARKER);
    expect(String(scrubbed.hostile)).not.toContain(fixtures.providerKey);
  });

  it('reports an invalid Date rather than emitting its coercion', () => {
    expect(scrubLogFields({ when: new Date(Number.NaN) }).when).toBe(LOG_MARKERS.unserializable);
  });

  it('turns an undefined array element into null', () => {
    const list: unknown[] = [1, undefined, 3];
    expect(scrubLogFields({ list }).list).toEqual([1, null, 3]);
  });

  it('names a Map key of every primitive kind and refuses an object key', () => {
    const map = new Map<unknown, unknown>([
      [1, 'number'],
      [true, 'boolean'],
      [7n, 'bigint'],
      [Symbol('sym'), 'symbol'],
      [{ shaped: 'like a key' }, 'object'],
    ]);
    const entries = scrubLogFields({ map }).map as Record<string, unknown>;
    expect(entries['1']).toBe('number');
    expect(entries.true).toBe('boolean');
    expect(entries['7']).toBe('bigint');
    expect(entries['Symbol(sym)']).toBe('symbol');
    // An object key is never rendered through its own `toString`.
    expect(entries[REDACTION_MARKER]).toBe('object');
  });

  it('drops a Map value of undefined like an absent field', () => {
    const entries = scrubLogFields({ map: new Map([['a', undefined]]) }).map as Record<
      string,
      unknown
    >;
    expect(Object.keys(entries)).toEqual([]);
  });
});

describe('construction seams', () => {
  it('adopts a pre-built pino instance and ignores the destination', () => {
    const adopted: string[] = [];
    const ignored: string[] = [];
    const logger = createServiceLogger(BASE_CONFIG, {
      pinoLogger: pino(
        { level: 'trace', base: null },
        { write: (line: string) => void adopted.push(line) },
      ),
      destination: { write: (line: string) => void ignored.push(line) },
    });

    logger.info('adopted', { token: fixtures.providerKey });
    expect(ignored).toEqual([]);
    expect(adopted).toHaveLength(1);
    const record = JSON.parse(adopted[0] ?? '{}') as Record<string, unknown>;
    expect(record.msg).toBe('adopted');
    // The value walk lives in the adapter, so an adopted instance carrying no
    // `redact` option of its own still cannot emit a credential.
    expect(record.token).toBe(REDACTION_MARKER);
  });

  it('constructs against the default destination without writing anything', () => {
    // No `destination`: pino's own stdout destination is created at call time,
    // which is what keeps importing this module side-effect free. Nothing is
    // logged here, so a passing run prints nothing.
    const logger = createServiceLogger({ ...BASE_CONFIG, logLevel: 'fatal' });
    expect(logger.level).toBe('fatal');
    expect(typeof logger.child).toBe('function');
    expect(logger).not.toBe(noopLogger);
  });
});

describe('nothing secret-shaped reaches the sink', () => {
  it('emits one parseable record carrying no fixture value and every diagnostic', () => {
    const c = capture();
    c.logger.error('pipeline stage failed', {
      headers: {
        authorization: fixtures.bearer,
        cookie: ['sid', fixtures.providerKey].join('='),
        'content-type': 'application/json',
      },
      DATABASE_URL: fixtures.dsnWithoutCredentials,
      sessionKey: fixtures.providerKey,
      note: `raw ${fixtures.jwt}`,
      statement: "SELECT id FROM account WHERE email = 'ada@example.com'",
      body: { password: 'hunter2' },
      [LOG_ERROR_FIELD_KEY]: new Error(`inner ${fixtures.connectionString}`),
      [LOG_BINDING_KEYS.sessionId]: 'session-42',
      stage: 'generate-panel',
    });

    const [line] = c.lines();
    expect(line).toBeDefined();
    expect(() => {
      JSON.parse(line ?? '');
    }).not.toThrow();
    for (const [name, value] of Object.entries(fixtures)) {
      expect(line, name).not.toContain(value);
    }
    expect(line).not.toContain('ada@example.com');
    expect(line).not.toContain('hunter2');
    // What must survive: the product's own identifiers and the diagnostics a
    // reader needs to act on the record.
    expect(line).toContain('session-42');
    expect(line).toContain('generate-panel');
    expect(line).toContain('pipeline stage failed');
    expect(line).toContain('application/json');
  });
});
