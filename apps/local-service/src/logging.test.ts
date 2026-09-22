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
 *    AAP §0.5.2 — tokens, `Authorization`/cookie headers, raw SQL and a
 *    rejected model payload — plus the bounds and hostile-value cases that
 *    keep the value walk from stalling or throwing.
 *
 * Every credential-shaped fixture is **assembled at runtime from fragments**,
 * following `packages/model-provider/src/redact-guard.test.ts` and
 * `scripts/check-secrets.test.mjs`: this file is tracked, so
 * `pnpm check:secrets` scans it, and a literal that matched a provider regex
 * would fail that gate even though it is obviously fake.
 */

import { describe, expect, it } from 'vitest';

import { DebuggenError, noopLogger, type LogFields, type Logger } from '@debuggen/shared';
import { REDACTION_MARKER } from '@debuggen/telemetry';

import type { ServiceConfig } from './config.js';
import {
  FIELDS_TRUNCATED_KEY,
  LOG_BINDING_KEYS,
  LOG_ERROR_FIELD_KEY,
  LOG_MARKERS,
  RESERVED_FIELD_PREFIX,
  RESERVED_LOG_KEYS,
  SERVICE_LOG_REDACT_PATHS,
  SERVICE_SENSITIVE_KEY_NAMES,
  SQL_STATEMENT_FIELD_KEYS,
  createServiceLogger,
  scrubLogFields,
  scrubLogMessage,
  sessionLogger,
  subsystemLogger,
} from './logging.js';

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
