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
 * - **The closed exception shape.** An exception's `message`, `stack` and
 *   `name` carry whatever the failing code was handed, which `scrub` cannot
 *   recognise. Low-entropy sentinels — a URL query value, an inline SQL
 *   literal, a codeframe line, a hostile `name`, a thrown string — are
 *   asserted absent from every record at `info`, `warn`, `error` and `fatal`,
 *   and present only in redacted form at `debug` and `trace`. They are
 *   deliberately *not* credential-shaped: a sentinel `scrub` would catch
 *   proves nothing about the closed shape. The same holds for a
 *   `DebuggenError`'s `hint` and `details`, and a `DebuggenError` cause's:
 *   at the operating levels no hint is emitted and `details` keeps only its
 *   closed-token entries, and at the diagnostic levels both are present with
 *   every string redacted by context.
 */

import { describe, expect, it } from 'vitest';

import pino from 'pino';

import { DebuggenError, noopLogger, type LogFields, type Logger } from '@debuggen/shared';
import { MAX_ATTRIBUTE_NODES, MAX_TRACKED_KEYS, REDACTION_MARKER } from '@debuggen/telemetry';

import type { ServiceConfig } from './config.js';
import {
  CLOSED_DETAIL_KEY_PATTERN,
  CLOSED_DETAIL_MAX_LENGTH,
  CLOSED_DETAIL_TOKEN_PATTERN,
  DETAILS_OMITTED_KEY,
  DIAGNOSTIC_LOG_LEVELS,
  DIAGNOSTIC_TEXT_MAX_LENGTH,
  EXCEPTION_CLASSES,
  FIELDS_TRUNCATED_KEY,
  FIELDS_UNREADABLE_KEY,
  LOG_BINDING_KEYS,
  LOG_ERROR_FIELD_KEY,
  LOG_FAILURE_NOTICE_MESSAGE,
  LOG_MARKERS,
  PROTOTYPE_LOG_KEYS,
  RESERVED_FIELD_PREFIX,
  RESERVED_LOG_KEYS,
  SERVICE_DATABASE_URL_KEY_NAMES,
  SERVICE_LOG_REDACT_PATHS,
  SERVICE_SENSITIVE_KEY_NAMES,
  SQL_STATEMENT_FIELD_KEYS,
  createServiceLogger,
  describeException,
  guardLogger,
  redactDiagnosticText,
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
  it('serialises a plain Error in the closed shape, with neither message nor stack', () => {
    const c = capture();
    c.logger.error('failed', {
      [LOG_ERROR_FIELD_KEY]: new Error(`bad key ${fixtures.providerKey}`),
    });
    const [record] = c.records();
    expect(record?.[LOG_ERROR_FIELD_KEY]).toEqual({ type: 'Error' });
    const line = c.lines().join('');
    expect(line).not.toContain(fixtures.providerKey);
    expect(line).not.toContain('bad key');
  });

  it('adds a scrubbed message and the stack to a plain Error at DEBUG only', () => {
    const c = capture();
    c.logger.debug('failed', {
      [LOG_ERROR_FIELD_KEY]: new Error(`bad key ${fixtures.providerKey}`),
    });
    const [record] = c.records();
    const err = record?.[LOG_ERROR_FIELD_KEY] as Record<string, unknown>;
    expect(err.type).toBe('Error');
    expect(String(err.message)).toContain('bad key');
    expect(String(err.message)).toContain(REDACTION_MARKER);
    expect(typeof err.stack).toBe('string');
    expect(c.lines().join('')).not.toContain(fixtures.providerKey);
  });

  it('serialises a DebuggenError as its code, closed-token details and a closed cause, never its hint', () => {
    const error = new DebuggenError('CONFIG_INVALID', 'config rejected', {
      hint: 'set DEBUGGEN_LOG_LEVEL',
      details: { setting: 'DEBUGGEN_PORT', key: 'DEBUGGEN_PORT', token: fixtures.providerKey },
      cause: new Error(`inner ${fixtures.jwt}`),
    });
    const c = capture();
    c.logger.fatal('boom', { [LOG_ERROR_FIELD_KEY]: error });
    const [record] = c.records();
    // `setting` is a closed token under an identifier key; `key` is withheld
    // by its name (any name folding onto a sensitive term is), and `token` by
    // its name and its value. Both are counted, neither is named.
    expect(record?.[LOG_ERROR_FIELD_KEY]).toEqual({
      type: 'DebuggenError',
      code: 'CONFIG_INVALID',
      details: { setting: 'DEBUGGEN_PORT' },
      [DETAILS_OMITTED_KEY]: 2,
      cause: { type: 'Error' },
    });
    const line = c.lines().join('');
    expect(line).not.toContain('"hint"');
    expect(line).not.toContain('set DEBUGGEN_LOG_LEVEL');
    expect(line).not.toContain('config rejected');
    expect(line).not.toContain('inner');
    expect(line).not.toContain(fixtures.jwt);
    expect(line).not.toContain(fixtures.providerKey);
  });

  it('adds the redacted hint and the name-masked details of a DebuggenError at DEBUG', () => {
    const error = new DebuggenError('CONFIG_INVALID', 'config rejected', {
      hint: 'set DEBUGGEN_LOG_LEVEL',
      details: { setting: 'DEBUGGEN_PORT', key: 'DEBUGGEN_PORT', token: fixtures.providerKey },
    });
    const c = capture();
    c.logger.debug('boom', { [LOG_ERROR_FIELD_KEY]: error });
    const [record] = c.records();
    const err = record?.[LOG_ERROR_FIELD_KEY] as Record<string, unknown>;
    expect(err.hint).toBe('set DEBUGGEN_LOG_LEVEL');
    // At a diagnostic level every entry travels, through the full value walk:
    // a denied name is still masked, and nothing is counted as withheld.
    expect(err.details).toEqual({
      setting: 'DEBUGGEN_PORT',
      key: REDACTION_MARKER,
      token: REDACTION_MARKER,
    });
    expect(err).not.toHaveProperty(DETAILS_OMITTED_KEY);
    expect(c.lines().join('')).not.toContain(fixtures.providerKey);
  });

  it('adds the DebuggenError message and a scrubbed cause message at DEBUG', () => {
    const error = new DebuggenError('CONFIG_INVALID', 'config rejected', {
      cause: new Error(`inner ${fixtures.jwt}`),
    });
    const c = capture();
    c.logger.debug('boom', { [LOG_ERROR_FIELD_KEY]: error });
    const [record] = c.records();
    const err = record?.[LOG_ERROR_FIELD_KEY] as Record<string, unknown>;
    expect(err.message).toBe('config rejected');
    expect(typeof err.stack).toBe('string');
    const cause = err.cause as Record<string, unknown>;
    expect(cause.type).toBe('Error');
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
      c.logger.debug('failed', { [LOG_ERROR_FIELD_KEY]: error });
    }).not.toThrow();
    const [atError, atDebug] = c.records();
    const err = atError?.[LOG_ERROR_FIELD_KEY] as Record<string, unknown>;
    // A lying `name` cannot choose the label: the closed taxonomy does.
    expect(err.type).toBe('Error');
    expect(err).not.toHaveProperty('message');
    expect(err.cause).toBe(LOG_MARKERS.unserializable);
    expect(err).not.toHaveProperty('stack');
    const diagnostic = atDebug?.[LOG_ERROR_FIELD_KEY] as Record<string, unknown>;
    expect(diagnostic.type).toBe('Error');
    expect(diagnostic.message).toBe(LOG_MARKERS.unserializable);
    expect(diagnostic.cause).toBe(LOG_MARKERS.unserializable);
    // An empty stack is omitted rather than emitted as an empty string.
    expect(diagnostic).not.toHaveProperty('stack');
  });

  it('serialises a DebuggenError that carries neither hint nor details', () => {
    const c = capture();
    const error = new DebuggenError('INTERNAL', 'bare failure');
    c.logger.error('failed', { [LOG_ERROR_FIELD_KEY]: error });
    c.logger.trace('failed', { [LOG_ERROR_FIELD_KEY]: error });
    const [atError, atTrace] = c.records();
    expect(atError?.[LOG_ERROR_FIELD_KEY]).toEqual({ type: 'DebuggenError', code: 'INTERNAL' });
    const diagnostic = atTrace?.[LOG_ERROR_FIELD_KEY] as Record<string, unknown>;
    expect(diagnostic.type).toBe('DebuggenError');
    expect(diagnostic.code).toBe('INTERNAL');
    expect(diagnostic.message).toBe('bare failure');
    expect(diagnostic).not.toHaveProperty('hint');
    expect(diagnostic).not.toHaveProperty('details');
    expect(typeof diagnostic.stack).toBe('string');
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
    // The error travels as its closed shape: neither its text nor its stack.
    expect(c.records()[0]?.[LOG_ERROR_FIELD_KEY]).toEqual({ type: 'Error' });
    expect(line).not.toContain('inner');
    // What must survive: the product's own identifiers and the diagnostics a
    // reader needs to act on the record.
    expect(line).toContain('session-42');
    expect(line).toContain('generate-panel');
    expect(line).toContain('pipeline stage failed');
    expect(line).toContain('application/json');
  });
});

describe('describeException — the closed taxonomy', () => {
  it('names the product error by its code and never by its text', () => {
    const described = describeException(
      new DebuggenError('STORE_ERROR', 'SELECT * FROM account WHERE email = ?'),
    );
    expect(described).toEqual({ errorClass: 'DebuggenError', errorCode: 'STORE_ERROR' });
  });

  it('maps the built-in constructors onto their own labels', () => {
    expect(describeException(new TypeError('x'))).toEqual({ errorClass: 'TypeError' });
    expect(describeException(new RangeError('x'))).toEqual({ errorClass: 'RangeError' });
    expect(describeException(new SyntaxError('x'))).toEqual({ errorClass: 'SyntaxError' });
    expect(describeException(new Error('x'))).toEqual({ errorClass: 'Error' });
  });

  it('keeps an errno or ERR_ code and labels the value a system error', () => {
    const errno = Object.assign(new Error('listen EADDRINUSE: address already in use'), {
      code: 'EADDRINUSE',
    });
    expect(describeException(errno)).toEqual({
      errorClass: 'SystemError',
      errorCode: 'EADDRINUSE',
    });
    const internal = Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL' });
    expect(describeException(internal)).toEqual({
      errorClass: 'TypeError',
      errorCode: 'ERR_INVALID_URL',
    });
  });

  it('never copies an arbitrary name or code', () => {
    const hostile = Object.assign(new Error('boom'), {
      name: '/home/dev/project/src/secret.ts',
      code: "ada@example.com' OR 1=1",
    });
    const described = describeException(hostile);
    expect(described).toEqual({ errorClass: 'Error' });
    expect(EXCEPTION_CLASSES).toContain(described.errorClass);
    const prefixed = Object.assign(new Error('boom'), { name: 'TypeError: /home/dev/x' });
    expect(describeException(prefixed)).toEqual({ errorClass: 'Error' });
  });

  it('labels every non-Error value NonError', () => {
    for (const value of ['a string', 42, null, undefined, { message: 'plain' }, Symbol('s')]) {
      expect(describeException(value)).toEqual({ errorClass: 'NonError' });
    }
  });

  it('survives a value that refuses a prototype lookup or a property read', () => {
    expect(describeException(hostilePrototype())).toEqual({ errorClass: 'Error' });
    const getter = new Error('boom');
    Object.defineProperty(getter, 'name', {
      get(): never {
        throw new Error('no name for you');
      },
    });
    expect(describeException(getter)).toEqual({ errorClass: 'Error' });
  });
});

/**
 * Low-entropy private sentinels for the closed exception shape.
 *
 * None is credential-shaped, so `scrub` leaves every one of them intact: only
 * the closed shape (at the operating levels) and the context-aware redactor
 * (at the diagnostic levels) can keep them out of a record, which is exactly
 * what these suites assert.
 */
const sentinels = {
  query: 'zz-query-sentinel',
  relativeQuery: 'zz-relative-sentinel',
  socketQuery: 'zz-socket-sentinel',
  sql: 'zz-sql-sentinel',
  sqlNumber: '918273645',
  source: 'zzSourceSentinel',
  name: 'zz-name-sentinel',
  thrown: 'zz-thrown-sentinel',
} as const;

/** A request URL whose query value is private. */
const SENTINEL_URL = `https://app.test/api/items?email=${sentinels.query}`;

/** A statement carrying an inline string literal and an inline number. */
const SENTINEL_SQL = `SELECT id FROM account WHERE email = '${sentinels.sql}' AND tenant = ${sentinels.sqlNumber}`;

/** A Babel / Next.js codeframe whose pointed-at line is private source. */
const SENTINEL_CODEFRAME = [
  '  11 | export function load() {',
  `> 12 |   const secret = ${sentinels.source};`,
  '     |         ^',
  '  13 | }',
].join('\n');

/** A V8 frame, which the redactor must keep byte-identical. */
const SENTINEL_FRAME = '    at load (/home/dev/project/src/load.ts:12:9)';

/** The escape code, built at runtime so no control character sits in the source. */
const ESC = String.fromCharCode(0x1b);

/**
 * An error carrying every sentinel: a hostile `name`, a URL query value and a
 * codeframe in its message and stack, a SQL literal in its cause, and a thrown
 * string — with a relative URL — as the cause's cause.
 */
function sentinelError(): Error {
  const cause = new Error(`cause: ${SENTINEL_SQL}`, {
    cause: `${sentinels.thrown} while reading /api/items?email=${sentinels.relativeQuery}`,
  });
  cause.name = sentinels.name;
  cause.stack = [`${sentinels.name}: cause: ${SENTINEL_SQL}`, SENTINEL_FRAME].join('\n');
  const error = new Error(`request to ${SENTINEL_URL} failed\n${SENTINEL_CODEFRAME}`, { cause });
  error.name = sentinels.name;
  error.stack = [
    `${sentinels.name}: request to ${SENTINEL_URL} failed`,
    SENTINEL_CODEFRAME,
    SENTINEL_FRAME,
  ].join('\n');
  return error;
}

/** The levels a record is written at by default, where only the closed shape may appear. */
const OPERATING_LEVELS = ['info', 'warn', 'error', 'fatal'] as const;

describe('the closed exception shape — no free text at INFO, WARN, ERROR or FATAL', () => {
  it('declares debug and trace as the only diagnostic levels', () => {
    expect([...DIAGNOSTIC_LOG_LEVELS].sort()).toEqual(['debug', 'trace']);
    expect(Object.isFrozen(DIAGNOSTIC_LOG_LEVELS)).toBe(true);
  });

  for (const level of OPERATING_LEVELS) {
    it(`keeps every sentinel out of the ${level.toUpperCase()} record and keeps the codes`, () => {
      const c = capture();
      c.logger[level]('the request failed', {
        [LOG_ERROR_FIELD_KEY]: sentinelError(),
        nested: { [LOG_ERROR_FIELD_KEY]: `${sentinels.thrown} ${SENTINEL_SQL}` },
        bind: Object.assign(new Error(`listen EADDRINUSE ${SENTINEL_URL}`), {
          code: 'EADDRINUSE',
        }),
        store: new DebuggenError('STORE_ERROR', SENTINEL_SQL, { cause: SENTINEL_URL }),
      });
      c.logger[level]('a string was thrown', { [LOG_ERROR_FIELD_KEY]: sentinels.thrown });

      const lines = c.lines();
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        for (const [name, value] of Object.entries(sentinels)) {
          expect(line, `${level}: ${name}`).not.toContain(value);
        }
        expect(line).not.toContain('"message"');
        expect(line).not.toContain('"stack"');
      }

      const [record, thrown] = c.records();
      const err = record?.[LOG_ERROR_FIELD_KEY] as Record<string, unknown>;
      expect(EXCEPTION_CLASSES).toContain(err.type);
      expect(err).toEqual({ type: 'Error', cause: { type: 'Error', cause: { type: 'NonError' } } });
      expect(record?.nested).toEqual({ [LOG_ERROR_FIELD_KEY]: { type: 'NonError' } });
      expect(record?.bind).toEqual({ type: 'SystemError', code: 'EADDRINUSE' });
      expect(record?.store).toEqual({
        type: 'DebuggenError',
        code: 'STORE_ERROR',
        cause: { type: 'NonError' },
      });
      expect(thrown?.[LOG_ERROR_FIELD_KEY]).toEqual({ type: 'NonError' });
    });
  }

  it('emits the closed shape from scrubLogFields unless diagnostics are asked for', () => {
    const error = new Error(`request to ${SENTINEL_URL} failed`);
    expect(scrubLogFields({ [LOG_ERROR_FIELD_KEY]: error })).toEqual({
      [LOG_ERROR_FIELD_KEY]: { type: 'Error' },
    });
    expect(scrubLogFields({ [LOG_ERROR_FIELD_KEY]: error }, { diagnostics: false })).toEqual({
      [LOG_ERROR_FIELD_KEY]: { type: 'Error' },
    });
    const diagnostic = scrubLogFields({ [LOG_ERROR_FIELD_KEY]: error }, { diagnostics: true });
    const err = diagnostic[LOG_ERROR_FIELD_KEY] as Record<string, unknown>;
    expect(err.message).toBe('request to https://app.test/api/items?email=? failed');
  });

  it('never gives a child binding the diagnostic text, even on a DEBUG record', () => {
    const c = capture();
    c.logger.child({ [LOG_ERROR_FIELD_KEY]: sentinelError() }).debug('bound');
    const [line] = c.lines();
    for (const [name, value] of Object.entries(sentinels)) {
      expect(line, name).not.toContain(value);
    }
    expect(c.records()[0]?.[LOG_ERROR_FIELD_KEY]).toMatchObject({ type: 'Error' });
  });

  it('bounds a cause chain by depth and cuts a cause cycle', () => {
    let chain = new Error('link 0');
    for (let link = 1; link < 12; link += 1) {
      chain = new Error(`link ${link}`, { cause: chain });
    }
    const scrubbed = scrubLogFields({ [LOG_ERROR_FIELD_KEY]: chain });
    let node: unknown = scrubbed[LOG_ERROR_FIELD_KEY];
    let links = 0;
    while (typeof node === 'object' && node !== null) {
      links += 1;
      node = (node as Record<string, unknown>).cause;
    }
    expect(node).toBe(LOG_MARKERS.truncated);
    expect(links).toBeLessThan(12);
    expect(scrubbed[FIELDS_TRUNCATED_KEY]).toBe(true);

    const looped = new Error('loop');
    looped.cause = looped;
    expect(scrubLogFields({ [LOG_ERROR_FIELD_KEY]: looped })[LOG_ERROR_FIELD_KEY]).toEqual({
      type: 'Error',
      cause: LOG_MARKERS.circular,
    });
  });

  it('reports a value under err whose prototype cannot be inspected', () => {
    expect(scrubLogFields({ [LOG_ERROR_FIELD_KEY]: hostilePrototype() })).toEqual({
      [LOG_ERROR_FIELD_KEY]: LOG_MARKERS.unserializable,
    });
  });
});

describe('the diagnostic levels — redacted message and stack at DEBUG and TRACE', () => {
  for (const level of DIAGNOSTIC_LOG_LEVELS) {
    it(`emits the redacted message and stack at ${level.toUpperCase()}`, () => {
      const c = capture();
      c.logger[level]('the request failed', { [LOG_ERROR_FIELD_KEY]: sentinelError() });
      const [record] = c.records();
      const err = record?.[LOG_ERROR_FIELD_KEY] as Record<string, unknown>;
      // The label is still closed: a hostile name never becomes the type.
      expect(err.type).toBe('Error');

      const message = String(err.message);
      expect(message).toContain('request to https://app.test/api/items?email=? failed');
      expect(message).toContain(REDACTION_MARKER);
      expect(message).not.toContain(sentinels.query);
      expect(message).not.toContain(sentinels.source);
      expect(message).not.toContain('> 12 |');

      const stack = String(err.stack);
      expect(stack.split('\n')).toContain(SENTINEL_FRAME);
      expect(stack).not.toContain(sentinels.query);
      expect(stack).not.toContain(sentinels.source);

      const cause = err.cause as Record<string, unknown>;
      expect(cause.type).toBe('Error');
      expect(cause.message).toBe('cause: SELECT id FROM account WHERE email = ? AND tenant = ?');
      expect(String(cause.stack)).not.toContain(sentinels.sql);
      expect(String(cause.stack)).not.toContain(sentinels.sqlNumber);

      const thrown = cause.cause as Record<string, unknown>;
      expect(thrown.type).toBe('NonError');
      expect(thrown.message).toBe(`${sentinels.thrown} while reading /api/items?email=?`);
    });
  }
});

/**
 * Low-entropy private sentinels for a `DebuggenError`'s own free text: its
 * `hint`, and its `details` as string values, inside a nested object, inside
 * an array and as a key — and the same fields of a `DebuggenError` cause.
 *
 * Like {@link sentinels}, none is credential-shaped, so `scrub` leaves every
 * one intact: only the closed-token rule (at the operating levels) and the
 * context-aware redactor (at the diagnostic levels) can keep them out.
 */
const contextSentinels = {
  hintQuery: 'zz-hint-query',
  hintSql: 'zz-hint-sql',
  hintSource: 'zzHintSource',
  detailQuery: 'zz-detail-query',
  detailSql: 'zz-detail-sql',
  detailSource: 'zzDetailSource',
  nestedQuery: 'zz-nested-query',
  nestedSql: 'zz-nested-sql',
  listQuery: 'zz-list-query',
  listSource: 'zzListSource',
  labelQuery: 'zz-label-query',
  causeHintQuery: 'zz-cause-hint-query',
  causeHintSql: 'zz-cause-hint-sql',
  causeHintSource: 'zzCauseHintSource',
  causeDetailQuery: 'zz-cause-detail-query',
  causeDetailSql: 'zz-cause-detail-sql',
  causeDetailSource: 'zzCauseDetailSource',
  causeNestedSql: 'zz-cause-nested-sql',
  causeListQuery: 'zz-cause-list-query',
} as const;

/** An origin-relative request URL whose query value is private. */
const queryText = (value: string): string => `/api/probe?email=${value}`;

/** A statement carrying a private inline literal. */
const sqlText = (value: string): string =>
  `lookup failed: SELECT id FROM account WHERE email = '${value}'`;

/** One Babel / Next.js codeframe source line whose source is private. */
const codeframeText = (value: string): string => `> 12 |   const x = ${value};`;

/** A recovery hint carrying all three kinds of private text, one per line. */
const hintText = (query: string, sql: string, source: string): string =>
  [`Reload ${queryText(query)} and retry.`, sqlText(sql), codeframeText(source)].join('\n');

/** {@link queryText} after `redactDiagnosticText`: the path and key stay, the value is `?`. */
const REDACTED_QUERY = '/api/probe?email=?';

/** {@link sqlText} after `redactDiagnosticText`: the literal is parameterised. */
const REDACTED_SQL = 'lookup failed: SELECT id FROM account WHERE email = ?';

/** {@link hintText} after `redactDiagnosticText`: the codeframe line becomes the marker. */
const REDACTED_HINT = [`Reload ${REDACTED_QUERY} and retry.`, REDACTED_SQL, REDACTION_MARKER].join(
  '\n',
);

/**
 * A `DebuggenError` whose hint and details carry every context sentinel next
 * to two content-free entries (`reason: 'probe-failed'`, `count: 3`), and
 * whose cause is another `DebuggenError` built the same way.
 */
function contextError(): DebuggenError {
  const s = contextSentinels;
  const cause = new DebuggenError('STORE_ERROR', 'the store refused the write', {
    hint: hintText(s.causeHintQuery, s.causeHintSql, s.causeHintSource),
    details: {
      reason: 'store-locked',
      attempt: 2,
      url: queryText(s.causeDetailQuery),
      note: sqlText(s.causeDetailSql),
      excerpt: codeframeText(s.causeDetailSource),
      nested: { note: sqlText(s.causeNestedSql) },
      list: [queryText(s.causeListQuery)],
    },
  });
  return new DebuggenError('AGENT_NOT_READY', 'the probe failed', {
    hint: hintText(s.hintQuery, s.hintSql, s.hintSource),
    details: {
      reason: 'probe-failed',
      count: 3,
      url: queryText(s.detailQuery),
      note: sqlText(s.detailSql),
      excerpt: codeframeText(s.detailSource),
      nested: { url: queryText(s.nestedQuery), note: sqlText(s.nestedSql) },
      list: [queryText(s.listQuery), codeframeText(s.listSource)],
      [queryText(s.labelQuery)]: 1,
    },
    cause,
  });
}

/**
 * The closed shape {@link contextError} takes at every operating level: the
 * two content-free entries of each error, and the count of the rest — six
 * withheld from the error (`url`, `note`, `excerpt`, `nested`, `list` and the
 * URL-shaped key) and five from its cause.
 */
const CLOSED_CONTEXT_ERROR = Object.freeze({
  type: 'DebuggenError',
  code: 'AGENT_NOT_READY',
  details: { reason: 'probe-failed', count: 3 },
  [DETAILS_OMITTED_KEY]: 6,
  cause: {
    type: 'DebuggenError',
    code: 'STORE_ERROR',
    details: { reason: 'store-locked', attempt: 2 },
    [DETAILS_OMITTED_KEY]: 5,
  },
});

/** Asserts that no context sentinel appears anywhere in an emitted line. */
function expectNoContextSentinel(line: string | undefined, label: string): void {
  expect(line, label).toBeDefined();
  for (const [name, value] of Object.entries(contextSentinels)) {
    expect(line, `${label}: ${name}`).not.toContain(value);
  }
}

describe('DebuggenError hint and details — closed at INFO, WARN, ERROR and FATAL', () => {
  for (const level of OPERATING_LEVELS) {
    it(`emits no hint and only closed-token details at ${level.toUpperCase()}, causes included`, () => {
      const c = capture();
      c.logger[level]('probe diagnostics', {
        [LOG_ERROR_FIELD_KEY]: contextError(),
        // The same rules wherever the error sits: under an ordinary name, and
        // as the cause of an error that is not a DebuggenError at all.
        failure: contextError(),
        wrapped: new Error('wrapper', { cause: contextError() }),
      });

      const lines = c.lines();
      expect(lines).toHaveLength(1);
      const [line] = lines;
      expectNoContextSentinel(line, level);
      expect(line).not.toContain('"hint"');
      expect(line).not.toContain('"message"');
      expect(line).not.toContain('"stack"');
      expect(line).not.toContain('the probe failed');
      expect(line).not.toContain('the store refused the write');
      expect(line).not.toContain('wrapper');

      const [record] = c.records();
      expect(record?.[LOG_ERROR_FIELD_KEY]).toEqual(CLOSED_CONTEXT_ERROR);
      expect(record?.failure).toEqual(CLOSED_CONTEXT_ERROR);
      expect(record?.wrapped).toEqual({ type: 'Error', cause: CLOSED_CONTEXT_ERROR });
      expect(record).not.toHaveProperty(FIELDS_TRUNCATED_KEY);
    });
  }

  it('keeps a closed token, a finite number and a boolean, and withholds everything else', () => {
    const details: Record<string, unknown> = {
      reason: 'probe-failed',
      state: 'state-tree',
      sessionId: 'ses_4k2p9dq7m1zx0c3v',
      errno: 'ENOENT',
      code: 'STORE_ERROR',
      stage: 'generate-panel',
      ok: true,
      ratio: 0.5,
      edge: 'a'.repeat(CLOSED_DETAIL_MAX_LENGTH),
      ['k'.repeat(CLOSED_DETAIL_MAX_LENGTH)]: 'kept',
      // An absent value is no entry: neither emitted nor counted.
      missing: undefined,
      // Withheld by value: not a closed token, or not a finite scalar.
      version: '1.2.3',
      phone: '5551234567',
      path: 'src/load.ts',
      sentence: 'probe failed twice',
      camel: 'stateTree',
      long: 'a'.repeat(CLOSED_DETAIL_MAX_LENGTH + 1),
      huge: 'a'.repeat(200_000),
      inf: Number.POSITIVE_INFINITY,
      nan: Number.NaN,
      big: 10n,
      none: null,
      // Withheld by value although the grammar admits it: `scrub` recognises
      // an access key id, so a credential never travels on the grammar alone.
      accessId: ['AKIA', 'Q'.repeat(16)].join(''),
      // Withheld by key: the grammar, then every name rule of the value walk.
      'bad key': 'x',
      ['k'.repeat(CLOSED_DETAIL_MAX_LENGTH + 1)]: 'x',
      token: 'probe-failed',
      databaseUrl: 'db',
      body: 'x',
      sql: 'x',
      [LOG_ERROR_FIELD_KEY]: 'x',
    };
    const c = capture();
    c.logger.error('failed', {
      [LOG_ERROR_FIELD_KEY]: new DebuggenError('INTERNAL', 'failed', { details }),
    });
    const err = c.records()[0]?.[LOG_ERROR_FIELD_KEY] as Record<string, unknown>;
    expect(err.details).toEqual({
      reason: 'probe-failed',
      state: 'state-tree',
      sessionId: 'ses_4k2p9dq7m1zx0c3v',
      errno: 'ENOENT',
      code: 'STORE_ERROR',
      stage: 'generate-panel',
      ok: true,
      ratio: 0.5,
      edge: 'a'.repeat(CLOSED_DETAIL_MAX_LENGTH),
      ['k'.repeat(CLOSED_DETAIL_MAX_LENGTH)]: 'kept',
    });
    // Twelve withheld by value, seven by key; `missing` is not counted.
    expect(err[DETAILS_OMITTED_KEY]).toBe(19);
    const line = c.lines().join('');
    expect(line).not.toContain('AKIA');
    expect(line).not.toContain('src/load.ts');
    expect(line).not.toContain('5551234567');
  });

  it('omits details altogether when no entry qualifies, and still counts them', () => {
    const c = capture();
    c.logger.warn('failed', {
      [LOG_ERROR_FIELD_KEY]: new DebuggenError('INTERNAL', 'failed', {
        details: {
          url: queryText(contextSentinels.detailQuery),
          nested: { reason: 'probe-failed' },
        },
      }),
    });
    expect(c.records()[0]?.[LOG_ERROR_FIELD_KEY]).toEqual({
      type: 'DebuggenError',
      code: 'INTERNAL',
      [DETAILS_OMITTED_KEY]: 2,
    });
    expectNoContextSentinel(c.lines()[0], 'warn');
  });

  it('bounds the closed pass by the key cap, counts the rest and flags the record', () => {
    const details: Record<string, number> = {};
    for (let index = 0; index < MAX_TRACKED_KEYS + 5; index += 1) {
      details[`e${index}`] = index;
    }
    const scrubbed = scrubLogFields({
      [LOG_ERROR_FIELD_KEY]: new DebuggenError('INTERNAL', 'failed', { details }),
    });
    const err = scrubbed[LOG_ERROR_FIELD_KEY] as Record<string, unknown>;
    expect(Object.keys(err.details as object)).toHaveLength(MAX_TRACKED_KEYS);
    expect(err[DETAILS_OMITTED_KEY]).toBe(5);
    expect(scrubbed[FIELDS_TRUNCATED_KEY]).toBe(true);
  });

  it('confines hostile details: a throwing getter costs its entry, a refusing Proxy the field', () => {
    const getterDetails: Record<string, unknown> = { reason: 'probe-failed' };
    Object.defineProperty(getterDetails, 'lazy', {
      enumerable: true,
      get: (): never => {
        throw new Error(`getter refused ${queryText(contextSentinels.detailQuery)}`);
      },
    });
    const refusing = new Proxy<Record<string, unknown>>(
      {},
      {
        ownKeys(): never {
          throw new Error('these details refuse enumeration');
        },
      },
    );

    const c = capture();
    expect(() => {
      for (const level of ['error', 'debug'] as const) {
        c.logger[level]('failed', {
          getter: new DebuggenError('INTERNAL', 'failed', { details: getterDetails }),
          refusing: new DebuggenError('INTERNAL', 'failed', { details: refusing }),
        });
      }
    }).not.toThrow();
    const [atError, atDebug] = c.records();
    expect(atError?.getter).toEqual({
      type: 'DebuggenError',
      code: 'INTERNAL',
      details: { reason: 'probe-failed' },
      [DETAILS_OMITTED_KEY]: 1,
    });
    expect(atError?.refusing).toEqual({
      type: 'DebuggenError',
      code: 'INTERNAL',
      details: LOG_MARKERS.unserializable,
    });
    const getterAtDebug = atDebug?.getter as Record<string, unknown>;
    expect(getterAtDebug.details).toEqual({
      reason: 'probe-failed',
      lazy: LOG_MARKERS.unserializable,
    });
    const refusingAtDebug = atDebug?.refusing as Record<string, unknown>;
    expect(refusingAtDebug.details).toEqual({
      [FIELDS_UNREADABLE_KEY]: LOG_MARKERS.unserializable,
    });
    for (const line of c.lines()) {
      expectNoContextSentinel(line, 'hostile details');
    }
  });

  it('reports details that turn unreadable after classification, at every level', () => {
    // `DebuggenError.is` reads `details` once to classify the value; a getter
    // that throws only on a later read reaches the serializer's own guard.
    const error = new DebuggenError('INTERNAL', 'failed', { hint: 'h', details: {} });
    let reads = 0;
    Object.defineProperty(error, 'details', {
      get: (): Record<string, unknown> => {
        reads += 1;
        if (reads % 2 === 0) {
          throw new Error('these details refuse a second read');
        }
        return {};
      },
    });
    const c = capture();
    c.logger.error('failed', { [LOG_ERROR_FIELD_KEY]: error });
    c.logger.debug('failed', { [LOG_ERROR_FIELD_KEY]: error });
    const [atError, atDebug] = c.records();
    expect(atError?.[LOG_ERROR_FIELD_KEY]).toEqual({
      type: 'DebuggenError',
      code: 'INTERNAL',
      details: LOG_MARKERS.unserializable,
    });
    const diagnostic = atDebug?.[LOG_ERROR_FIELD_KEY] as Record<string, unknown>;
    expect(diagnostic.hint).toBe('h');
    expect(diagnostic.details).toBe(LOG_MARKERS.unserializable);
  });

  it('declares the grammar, its bound and the omitted counter', () => {
    expect(CLOSED_DETAIL_MAX_LENGTH).toBe(64);
    expect(DETAILS_OMITTED_KEY).toBe('detailsOmitted');
    expect(Object.isFrozen(CLOSED_DETAIL_KEY_PATTERN)).toBe(true);
    expect(Object.isFrozen(CLOSED_DETAIL_TOKEN_PATTERN)).toBe(true);

    expect(CLOSED_DETAIL_KEY_PATTERN.test(`a${'b'.repeat(CLOSED_DETAIL_MAX_LENGTH - 1)}`)).toBe(
      true,
    );
    expect(CLOSED_DETAIL_KEY_PATTERN.test(`a${'b'.repeat(CLOSED_DETAIL_MAX_LENGTH)}`)).toBe(false);
    for (const key of ['reason', 'planVersion', 'active_plan2']) {
      expect(CLOSED_DETAIL_KEY_PATTERN.test(key), key).toBe(true);
    }
    for (const key of ['', '_private', '2fa', 'http.method', 'bad key', 'a-b', '/api']) {
      expect(CLOSED_DETAIL_KEY_PATTERN.test(key), key).toBe(false);
    }

    for (const token of [
      'probe-failed',
      'state-tree',
      'ses_4k2p9dq7m1zx0c3v',
      'generate-panel',
      'v1.plan',
      'ENOENT',
      'STORE_ERROR',
      'ERR_INVALID_URL',
    ]) {
      expect(CLOSED_DETAIL_TOKEN_PATTERN.test(token), token).toBe(true);
    }
    for (const token of [
      '',
      'Probe-failed',
      'stateTree',
      '1.2.3',
      'probe--failed',
      'probe-',
      'STORE-ERROR',
      'STORE__ERROR',
      'probe failed',
      '/api/probe',
      'email=zz',
      "'zz'",
      '> 12 |',
    ]) {
      expect(CLOSED_DETAIL_TOKEN_PATTERN.test(token), token).toBe(false);
    }
  });
});

describe('DebuggenError hint and details — redacted at DEBUG and TRACE', () => {
  for (const level of DIAGNOSTIC_LOG_LEVELS) {
    it(`emits the redacted hint and every redacted detail at ${level.toUpperCase()}, cause included`, () => {
      const c = capture();
      c.logger[level]('the probe failed', { [LOG_ERROR_FIELD_KEY]: contextError() });

      const [line] = c.lines();
      expectNoContextSentinel(line, level);

      const err = c.records()[0]?.[LOG_ERROR_FIELD_KEY] as Record<string, unknown>;
      expect(err.type).toBe('DebuggenError');
      expect(err.code).toBe('AGENT_NOT_READY');
      expect(err.hint).toBe(REDACTED_HINT);
      // Every entry travels — strings, the nested object, the array and the
      // URL-shaped key — each string redacted by context, nothing counted.
      expect(err.details).toEqual({
        reason: 'probe-failed',
        count: 3,
        url: REDACTED_QUERY,
        note: REDACTED_SQL,
        excerpt: REDACTION_MARKER,
        nested: { url: REDACTED_QUERY, note: REDACTED_SQL },
        list: [REDACTED_QUERY, REDACTION_MARKER],
        [REDACTED_QUERY]: 1,
      });
      expect(err).not.toHaveProperty(DETAILS_OMITTED_KEY);
      expect(err.message).toBe('the probe failed');
      expect(typeof err.stack).toBe('string');

      expect(err.cause).toMatchObject({
        type: 'DebuggenError',
        code: 'STORE_ERROR',
        hint: REDACTED_HINT,
        details: {
          reason: 'store-locked',
          attempt: 2,
          url: REDACTED_QUERY,
          note: REDACTED_SQL,
          excerpt: REDACTION_MARKER,
          nested: { note: REDACTED_SQL },
          list: [REDACTED_QUERY],
        },
        message: 'the store refused the write',
      });
      expect(err.cause).not.toHaveProperty(DETAILS_OMITTED_KEY);
    });
  }

  it('confines the context-aware redaction to the details it was entered for', () => {
    const inner = new DebuggenError('INTERNAL', 'inner', {
      details: { url: queryText(contextSentinels.nestedQuery) },
    });
    const c = capture();
    c.logger.debug('failed', {
      before: '/api/probe?page=2',
      [LOG_ERROR_FIELD_KEY]: new DebuggenError('INTERNAL', 'outer', {
        // A DebuggenError nested in details enters and leaves the mode itself;
        // the entry after it is still redacted, because the outer walk is.
        details: { inner, after: queryText(contextSentinels.listQuery) },
      }),
      after: '/api/probe?page=2',
    });
    expectNoContextSentinel(c.lines()[0], 'nested details');
    const [record] = c.records();
    const details = (record?.[LOG_ERROR_FIELD_KEY] as Record<string, unknown>).details as Record<
      string,
      unknown
    >;
    expect((details.inner as Record<string, unknown>).details).toEqual({ url: REDACTED_QUERY });
    expect(details.after).toBe(REDACTED_QUERY);
    // Ordinary fields on either side keep their `scrub`-only treatment.
    expect(record?.before).toBe('/api/probe?page=2');
    expect(record?.after).toBe('/api/probe?page=2');
  });

  it('stays bounded and total on a huge hint, a huge value, a huge key and a cycle', () => {
    const huge = `${queryText(contextSentinels.detailQuery)} ${'word '.repeat(40_000)}`;
    const details: Record<string, unknown> = { huge, [huge]: 1 };
    details.self = details;
    const c = capture();
    expect(() => {
      c.logger.trace('failed', {
        [LOG_ERROR_FIELD_KEY]: new DebuggenError('INTERNAL', 'failed', { hint: huge, details }),
      });
    }).not.toThrow();
    expectNoContextSentinel(c.lines()[0], 'adversarial details');

    const err = c.records()[0]?.[LOG_ERROR_FIELD_KEY] as Record<string, unknown>;
    expect(String(err.hint).length).toBeLessThanOrEqual(DIAGNOSTIC_TEXT_MAX_LENGTH);
    expect(String(err.hint).startsWith(`${REDACTED_QUERY} word`)).toBe(true);
    const emitted = err.details as Record<string, unknown>;
    expect(String(emitted.huge).length).toBeLessThanOrEqual(DIAGNOSTIC_TEXT_MAX_LENGTH);
    for (const key of Object.keys(emitted)) {
      expect(key.length).toBeLessThanOrEqual(DIAGNOSTIC_TEXT_MAX_LENGTH);
    }
    // The walk's own cycle cut, unchanged: the self-reference is walked once
    // as a container and cut where it recurs.
    expect((emitted.self as Record<string, unknown>).self).toBe(LOG_MARKERS.circular);
  });
});

describe('redactDiagnosticText — context-aware diagnostic redaction', () => {
  it('masks URL query values and keeps the path, host and a frame position', () => {
    const redacted = redactDiagnosticText(
      [
        `GET ${SENTINEL_URL} failed`,
        `redirected to /checkout?coupon=${sentinels.relativeQuery}.`,
        `socket ws://127.0.0.1:20240/ws?ticket=${sentinels.socketQuery} closed`,
        `    at fetchItems (https://app.test/_next/static/chunks/app.js?v=${sentinels.query}:12:5)`,
      ].join('\n'),
    );
    expect(redacted).toBe(
      [
        'GET https://app.test/api/items?email=? failed',
        'redirected to /checkout?coupon=?.',
        'socket ws://127.0.0.1:20240/ws?ticket=? closed',
        '    at fetchItems (https://app.test/_next/static/chunks/app.js?v=?:12:5)',
      ].join('\n'),
    );
  });

  it('parameterises SQL literals in a statement, across lines and in any case', () => {
    expect(redactDiagnosticText(`query failed: ${SENTINEL_SQL}`)).toBe(
      'query failed: SELECT id FROM account WHERE email = ? AND tenant = ?',
    );
    const multiLine = redactDiagnosticText(
      `update account set note = 'first line\n${sentinels.sql}' where id = 7`,
    );
    expect(multiLine).toBe('update account set note = ? where id = ?');
    // A frame after the statement is not read as SQL and keeps its position.
    expect(redactDiagnosticText(`${SENTINEL_SQL}\n${SENTINEL_FRAME}`)).toBe(
      `SELECT id FROM account WHERE email = ? AND tenant = ?\n${SENTINEL_FRAME}`,
    );
    // Prose without a statement keeps its quotes and numbers.
    expect(redactDiagnosticText("the value 'kept' failed 3 times")).toBe(
      "the value 'kept' failed 3 times",
    );
  });

  it('matches its documented example', () => {
    const email = ['ada', 'example.com'].join('@');
    expect(
      redactDiagnosticText(
        `GET /api/items?email=${email} failed: SELECT id FROM account WHERE email = '${email}'`,
      ),
    ).toBe('GET /api/items?email=? failed: SELECT id FROM account WHERE email = ?');
  });

  it('removes Babel, esbuild and TypeScript codeframes, colour included', () => {
    expect(
      redactDiagnosticText(
        ['Unexpected token (12:17)', SENTINEL_CODEFRAME, SENTINEL_FRAME].join('\n'),
      ),
    ).toBe(['Unexpected token (12:17)', REDACTION_MARKER, SENTINEL_FRAME].join('\n'));

    const coloured = `${ESC}[31m${ESC}[1m>${ESC}[22m${ESC}[39m${ESC}[90m 12 |${ESC}[39m   const secret ${ESC}[33m=${ESC}[39m ${sentinels.source};`;
    expect(redactDiagnosticText(`${ESC}[31mUnexpected token${ESC}[39m\n${coloured}`)).toBe(
      `Unexpected token\n${REDACTION_MARKER}`,
    );

    const esbuild = [
      '    src/load.ts:12:17:',
      `      12 │   const secret = ${sentinels.source};`,
      '         ╵                  ^',
    ].join('\n');
    expect(redactDiagnosticText(esbuild)).toBe(`    src/load.ts:12:17:\n${REDACTION_MARKER}`);

    const typescript = [
      "src/load.ts:12:17 - error TS1005: ';' expected.",
      '',
      `${ESC}[7m12${ESC}[0m   const secret = ${sentinels.source}`,
      `${ESC}[7m  ${ESC}[0m ${ESC}[91m                 ~~~~~~~~~~~~~~~~${ESC}[0m`,
    ].join('\n');
    expect(redactDiagnosticText(typescript)).toBe(
      `src/load.ts:12:17 - error TS1005: ';' expected.\n\n${REDACTION_MARKER}`,
    );
  });

  it('scrubs credentials, strips control characters and bounds the result', () => {
    const redacted = redactDiagnosticText(
      `key ${fixtures.providerKey}${ESC}[0m${String.fromCharCode(0x07)} done`,
    );
    expect(redacted).not.toContain(fixtures.providerKey);
    expect(redacted).toContain(REDACTION_MARKER);
    expect(redacted).not.toContain(ESC);
    expect(redacted).not.toContain(String.fromCharCode(0x07));
    expect(redacted.endsWith(' done')).toBe(true);

    const long = redactDiagnosticText('word '.repeat(5_000));
    expect(long.length).toBeLessThanOrEqual(DIAGNOSTIC_TEXT_MAX_LENGTH);
    expect(long.endsWith(`\n${LOG_MARKERS.truncated}`)).toBe(true);
  });

  it('stays bounded on adversarial input shaped against each pass', () => {
    // Overlapping URL starts, a scheme run with no query, an unterminated
    // literal after a keyword, and a codeframe-shaped flood: each is the
    // worst case of one pass, and each must come back bounded.
    for (const hostile of [
      '(/'.repeat(8_000),
      'x://'.repeat(4_000),
      `SELECT '${'a'.repeat(15_000)}`,
      '> 1 | x\n'.repeat(2_000),
      `${ESC}[`.repeat(8_000),
    ]) {
      const redacted = redactDiagnosticText(hostile);
      expect(redacted.length).toBeLessThanOrEqual(DIAGNOSTIC_TEXT_MAX_LENGTH);
    }
  });

  it('is total: a value it cannot scan becomes the marker and nothing throws', () => {
    expect(redactDiagnosticText('')).toBe('');
    expect(redactDiagnosticText(42)).toBe('42');
    expect(redactDiagnosticText(null)).toBe(REDACTION_MARKER);
    expect(redactDiagnosticText({ message: sentinels.query })).toBe(REDACTION_MARKER);
    expect(() => redactDiagnosticText(hostilePrototype())).not.toThrow();
  });
});

/** A `Logger` whose every method throws, standing in for a failing destination. */
function throwingLogger(): Logger {
  const fail = (): never => {
    throw new Error('EPIPE: the destination is closed at /home/dev/project');
  };
  return {
    level: 'trace',
    trace: fail,
    debug: fail,
    info: fail,
    warn: fail,
    error: fail,
    fatal: fail,
    child: fail,
  };
}

describe('guardLogger — best-effort, never-throwing logging', () => {
  it('never throws from a level method and announces the first drop once', () => {
    const notices: string[] = [];
    const log = guardLogger(throwingLogger(), {
      fallback: (line) => void notices.push(line),
      now: () => 1_000,
    });
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      expect(() => {
        log[level]('a record', { a: 1 });
      }).not.toThrow();
    }
    expect(notices).toHaveLength(1);
    const notice = JSON.parse(notices[0] ?? '') as Record<string, unknown>;
    expect(notice).toMatchObject({
      level: 50,
      subsystem: 'logging',
      msg: LOG_FAILURE_NOTICE_MESSAGE,
      operation: 'trace',
      errorClass: 'Error',
      droppedRecords: 1,
    });
    // The notice is built from constants and counts only: nothing the failure said.
    expect(notices[0]).not.toContain('/home/dev/project');
    expect(notices[0]).not.toContain('a record');
  });

  it('rate-limits notices and carries the drops folded into the next one', () => {
    const notices: string[] = [];
    let now = 0;
    const log = guardLogger(throwingLogger(), {
      fallback: (line) => void notices.push(line),
      now: () => now,
      noticeIntervalMs: 100,
    });
    log.info('first');
    now = 50;
    log.info('second');
    log.info('third');
    expect(notices).toHaveLength(1);
    now = 150;
    log.info('fourth');
    expect(notices).toHaveLength(2);
    expect(JSON.parse(notices[1] ?? '')).toMatchObject({
      droppedRecords: 4,
      droppedSinceLastNotice: 3,
    });
  });

  it('counts a notice its own sink refuses and still never throws', () => {
    let now = 0;
    const accepted: string[] = [];
    let refuse = true;
    const log = guardLogger(throwingLogger(), {
      fallback: (line) => {
        if (refuse) {
          throw new Error('stderr is gone too');
        }
        accepted.push(line);
      },
      now: () => now,
      noticeIntervalMs: 10,
    });
    expect(() => {
      log.error('dropped');
    }).not.toThrow();
    refuse = false;
    now = 20;
    log.error('dropped again');
    expect(JSON.parse(accepted[0] ?? '')).toMatchObject({ failedNotices: 1, droppedRecords: 2 });
  });

  it('replaces a refused child with one merging the bindings into each call', () => {
    const received: { message: string; fields: LogFields | undefined }[] = [];
    const notices: string[] = [];
    const parent: Logger = {
      ...throwingLogger(),
      info: (message, fields) => {
        received.push({ message, fields });
      },
    };
    const log = guardLogger(parent, { fallback: (line) => void notices.push(line) });
    const child = log.child({ subsystem: 'store', a: 'binding' });
    child.info('from the child', { a: 'call' });
    expect(received).toEqual([
      { message: 'from the child', fields: { subsystem: 'store', a: 'call' } },
    ]);
    expect(JSON.parse(notices[0] ?? '')).toMatchObject({ operation: 'child' });
    expect(() => {
      child.child({ captureId: 'c1' }).warn('nested');
    }).not.toThrow();
  });

  it('is the identity for noopLogger and for a logger it already guarded', () => {
    expect(guardLogger(noopLogger)).toBe(noopLogger);
    const once = guardLogger(throwingLogger(), { fallback: () => undefined });
    expect(guardLogger(once)).toBe(once);
  });

  it('keeps the level and forwards arguments unchanged when nothing fails', () => {
    const received: unknown[][] = [];
    const inner: Logger = {
      level: 'debug',
      trace: (...args: unknown[]) => void received.push(['trace', ...args]),
      debug: (...args: unknown[]) => void received.push(['debug', ...args]),
      info: (...args: unknown[]) => void received.push(['info', ...args]),
      warn: (...args: unknown[]) => void received.push(['warn', ...args]),
      error: (...args: unknown[]) => void received.push(['error', ...args]),
      fatal: (...args: unknown[]) => void received.push(['fatal', ...args]),
      child: () => inner,
    };
    const log = guardLogger(inner);
    expect(log.level).toBe('debug');
    log.info('plain');
    log.warn('with fields', { a: 1 });
    expect(received).toEqual([
      ['info', 'plain'],
      ['warn', 'with fields', { a: 1 }],
    ]);
  });
});

describe('createServiceLogger never throws from a failing destination', () => {
  it('drops the record, announces it through the policy and keeps serving', () => {
    const notices: string[] = [];
    let healthy = false;
    const lines: string[] = [];
    const logger = createServiceLogger(BASE_CONFIG, {
      destination: {
        write: (line: string) => {
          if (!healthy) {
            throw new Error('EPIPE');
          }
          lines.push(line);
        },
      },
      failurePolicy: { fallback: (line) => void notices.push(line) },
    });
    const store = subsystemLogger(logger, 'store');
    expect(() => {
      store.error('the store failed', { code: 'STORE_ERROR' });
    }).not.toThrow();
    expect(notices).toHaveLength(1);
    healthy = true;
    store.info('the store recovered');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      msg: 'the store recovered',
      subsystem: 'store',
    });
  });
});
