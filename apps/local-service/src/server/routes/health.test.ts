/**
 * Tests for `./health.ts`: the `GET /health` body every client relies on, and
 * the identity proof a challenging client uses to authenticate the service
 * before it sends the editor credential.
 *
 * The handler is mounted on a bare hono application at protocol's own method
 * and pattern, with no auth middleware in front of it (the route is exempt,
 * and `../http.ts`'s own suites pin the middleware). Each case writes a real
 * `auth.json` into a fresh private directory, so the no-follow inspection, the
 * bounded read and the strict record check all run against the file system.
 *
 * The proof is checked against an **independent** computation: `node:crypto`
 * HMAC-SHA256 over the contract message written out here as literals, never
 * through the module's own helpers or constants, so a change to the wire
 * contract fails this suite instead of being mirrored by it.
 *
 * Every credential is minted at run time with `randomBytes`, and every reply
 * is searched for the credential, its SHA-256 (hex and base64url) and the
 * `auth.json` path.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HTTP_ROUTES, PROTOCOL_VERSION, healthResponseSchema } from '@debuggen/protocol';
import type { LogFields, LogLevel, Logger } from '@debuggen/shared';

import { AUTH_FILE_VERSION } from '../auth.js';
import type { ServerEnv } from '../auth.js';
import {
  AUTH_FILE_READ_LIMIT_BYTES,
  SERVICE_IDENTITY_CHALLENGE_HEADER,
  SERVICE_IDENTITY_ENDPOINT_HEADER,
  SERVICE_IDENTITY_PROOF_HEADER,
  SERVICE_IDENTITY_PROOF_LABEL,
  computeServiceIdentityProof,
  createHealthRoutes,
  formatServiceIdentityEndpoint,
  isValidServiceIdentityChallenge,
} from './health.js';
import type { HealthRoutesDeps } from './health.js';

/* -------------------------------------------------------------------------------------------------
 * Platform capabilities
 * ---------------------------------------------------------------------------------------------- */

/** Whether this platform has no user ids, and so no permission-bit model to test against. */
const NO_POSIX_IDS = typeof process.getuid !== 'function';

/**
 * Whether this process may give a file to another account — only a superuser
 * can, and it is the only way to plant a foreign-owned `auth.json`.
 */
const CAN_CHOWN = typeof process.getuid === 'function' && process.getuid() === 0;

/** Whether this process can create a symbolic link at all (Windows may withhold it). */
const CAN_CREATE_SYMLINKS = ((): boolean => {
  const probeRoot = mkdtempSync(join(tmpdir(), 'debuggen-health-probe-'));
  try {
    symlinkSync(join(probeRoot, 'absent'), join(probeRoot, 'link'));
    return lstatSync(join(probeRoot, 'link')).isSymbolicLink();
  } catch {
    // No link could be planted, so the cases that need one are skipped.
    return false;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
})();

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/** The service version every route under test reports. */
const SERVICE_VERSION = '0.1.0';

/** The bound port the proof is expected to name. */
const BOUND_PORT = 43_117;

/** The contract's request header, written out rather than imported. */
const CHALLENGE_HEADER = 'X-Debuggen-Identity-Challenge';

/** The contract's proof header. */
const PROOF_HEADER = 'X-Debuggen-Identity-Proof';

/** The contract's endpoint header. */
const ENDPOINT_HEADER = 'X-Debuggen-Identity-Endpoint';

/** The contract's label. */
const LABEL = 'debuggen-service-identity/v1';

/** The one sentence a withheld proof is logged with. */
const WITHHELD_MESSAGE = 'health probe answered a challenge without an identity proof';

/** A fresh 32-byte challenge, as the CLI draws it: 43 base64url characters. */
function newChallenge(): string {
  return randomBytes(32).toString('base64url');
}

/** A fresh editor-shaped credential. */
function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The proof, computed independently of the module under test. */
function expectedProof(token: string, challenge: string, endpoint: string): string {
  return createHmac('sha256', Buffer.from(token, 'utf8'))
    .update(Buffer.from(`${LABEL}\n${challenge}\n${endpoint}`, 'utf8'))
    .digest('base64url');
}

/** One log call as the recording logger saw it. */
interface LoggedRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/** A `Logger` that records every call, children included, into one list. */
function recordingLogger(records: LoggedRecord[], bindings: LogFields = {}): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      records.push({ level, message, fields: { ...bindings, ...(fields ?? {}) } });
    };
  return {
    level: 'trace',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: (next) => recordingLogger(records, { ...bindings, ...next }),
  };
}

/** A private state directory and the `auth.json` path inside it, as the service lays them out. */
interface StateDir {
  readonly dir: string;
  readonly authFilePath: string;
}

/** Writes an `auth.json` record for `token` at `path` with `mode`. */
function writeAuthFile(path: string, token: string, mode = 0o600): void {
  const record = { version: AUTH_FILE_VERSION, token, issuedAt: Date.now() };
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode });
  // `writeFileSync` applies the umask; the mode under test is set exactly.
  chmodSync(path, mode);
}

/** What one mounted route answered, read once. */
interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

/** Mounts the health handler at protocol's method and pattern. */
function mount(deps: HealthRoutesDeps): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();
  const routes = createHealthRoutes(deps);
  app.on(HTTP_ROUTES.health.method, HTTP_ROUTES.health.pattern, routes.health);
  return app;
}

/** Sends `GET /health`, with a challenge header when one is given. */
async function probe(app: Hono<ServerEnv>, challenge?: string): Promise<Answer> {
  const headers: Record<string, string> = {};
  if (challenge !== undefined) {
    headers[CHALLENGE_HEADER] = challenge;
  }
  const response = await Promise.resolve(
    app.request(HTTP_ROUTES.health.pattern, { method: HTTP_ROUTES.health.method, headers }),
  );
  return { status: response.status, headers: response.headers, text: await response.text() };
}

/** Every header value of an answer, joined, for leak searches. */
function headerText(answer: Answer): string {
  return [...answer.headers.entries()].map(([name, value]) => `${name}: ${value}`).join('\n');
}

/**
 * Asserts that nothing in an answer — header or body — carries the credential,
 * either form of its SHA-256, or the path of the file it came from.
 */
function expectNoSecret(answer: Answer, token: string, authFilePath: string): void {
  const digest = createHash('sha256').update(token, 'utf8').digest();
  const forbidden: Readonly<Record<string, string>> = {
    'the credential': token,
    'its SHA-256 (hex)': digest.toString('hex'),
    'its SHA-256 (base64url)': digest.toString('base64url'),
    'the auth.json path': authFilePath,
  };
  const surfaces: Readonly<Record<string, string>> = {
    headers: headerText(answer),
    body: answer.text,
  };
  for (const [surface, text] of Object.entries(surfaces)) {
    for (const [label, value] of Object.entries(forbidden)) {
      expect(text.includes(value), `${label} appeared in the ${surface}`).toBe(false);
    }
  }
}

/** Asserts an answer is the plain probe: `200`, the exact body, `no-store`, no identity header. */
function expectPlainProbe(answer: Answer, pairingAvailable = false): void {
  expect(answer.status).toBe(200);
  expect(JSON.parse(answer.text)).toStrictEqual({
    version: SERVICE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    pairingAvailable,
  });
  expect(healthResponseSchema.safeParse(JSON.parse(answer.text)).success).toBe(true);
  expect(answer.headers.get('cache-control')).toBe('no-store');
  expect(answer.headers.get(PROOF_HEADER)).toBeNull();
  expect(answer.headers.get(ENDPOINT_HEADER)).toBeNull();
}

/* -------------------------------------------------------------------------------------------------
 * Per-test state
 * ---------------------------------------------------------------------------------------------- */

let state: StateDir;
let token: string;
let records: LoggedRecord[];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'debuggen-health-'));
  chmodSync(dir, 0o700);
  state = { dir, authFilePath: join(dir, 'auth.json') };
  token = newToken();
  records = [];
});

afterEach(() => {
  rmSync(state.dir, { recursive: true, force: true });
});

/** The deps of a fully configured route over {@link state}. */
function configuredDeps(overrides: Partial<HealthRoutesDeps> = {}): HealthRoutesDeps {
  return {
    serviceVersion: SERVICE_VERSION,
    isPairingAvailable: () => false,
    config: { host: '127.0.0.1', port: BOUND_PORT, authFilePath: state.authFilePath },
    logger: recordingLogger(records),
    ...overrides,
  };
}

/** The withheld-proof log records, in order. */
function withheldRecords(): readonly LoggedRecord[] {
  return records.filter((record) => record.message === WITHHELD_MESSAGE);
}

/* -------------------------------------------------------------------------------------------------
 * The contract's constants
 * ---------------------------------------------------------------------------------------------- */

describe('the identity-proof contract', () => {
  it('exports the header names, label and read limit the client restates', () => {
    expect(SERVICE_IDENTITY_CHALLENGE_HEADER).toBe(CHALLENGE_HEADER);
    expect(SERVICE_IDENTITY_PROOF_HEADER).toBe(PROOF_HEADER);
    expect(SERVICE_IDENTITY_ENDPOINT_HEADER).toBe(ENDPOINT_HEADER);
    expect(SERVICE_IDENTITY_PROOF_LABEL).toBe(LABEL);
    expect(AUTH_FILE_READ_LIMIT_BYTES).toBeGreaterThanOrEqual(1024);
  });

  it('accepts exactly the 22-to-128-character base64url challenges', () => {
    expect(isValidServiceIdentityChallenge(newChallenge())).toBe(true);
    expect(isValidServiceIdentityChallenge('A'.repeat(22))).toBe(true);
    expect(isValidServiceIdentityChallenge('_-'.repeat(64))).toBe(true);
    for (const invalid of [
      '',
      'A'.repeat(21),
      'A'.repeat(129),
      `${'A'.repeat(42)}=`,
      `${'A'.repeat(42)}+`,
      `${'A'.repeat(42)}/`,
      `${'A'.repeat(21)} ${'A'.repeat(21)}`,
      `${newChallenge()}, ${newChallenge()}`,
      `${newChallenge()}\n`,
      undefined,
      43,
    ]) {
      expect(isValidServiceIdentityChallenge(invalid), JSON.stringify(invalid)).toBe(false);
    }
  });

  it('formats the endpoint canonically and refuses an unusable host or port', () => {
    expect(formatServiceIdentityEndpoint('127.0.0.1', BOUND_PORT)).toBe(`127.0.0.1:${BOUND_PORT}`);
    expect(formatServiceIdentityEndpoint(' 127.0.0.2 ', 1)).toBe('127.0.0.2:1');
    expect(formatServiceIdentityEndpoint('::1', 65_535)).toBe('[::1]:65535');
    expect(formatServiceIdentityEndpoint('[::1]', BOUND_PORT)).toBe(`[::1]:${BOUND_PORT}`);
    expect(formatServiceIdentityEndpoint('FE80::1', BOUND_PORT)).toBe(`[fe80::1]:${BOUND_PORT}`);
    for (const port of [0, -1, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(formatServiceIdentityEndpoint('127.0.0.1', port), String(port)).toBeUndefined();
    }
    for (const host of ['', '   ', 'local host', 'l\u00f6calhost', 'a\nb', undefined]) {
      expect(formatServiceIdentityEndpoint(host, BOUND_PORT), JSON.stringify(host)).toBeUndefined();
    }
  });

  it('has no endpoint for a host name, which can stand for more than one listener', () => {
    for (const host of [
      'localhost',
      ' LocalHost ',
      'LOCALHOST',
      'app.localhost',
      '127.1',
      '[localhost]',
    ]) {
      expect(formatServiceIdentityEndpoint(host, BOUND_PORT), host).toBeUndefined();
    }
  });

  it('computes the proof as base64url HMAC-SHA256 of the label, challenge and endpoint', () => {
    const challenge = newChallenge();
    const endpoint = `127.0.0.1:${BOUND_PORT}`;
    const proof = computeServiceIdentityProof({ key: token, challenge, endpoint });
    expect(proof).toBe(expectedProof(token, challenge, endpoint));
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      computeServiceIdentityProof({ key: Buffer.from(token, 'utf8'), challenge, endpoint }),
    ).toBe(proof);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The plain probe
 * ---------------------------------------------------------------------------------------------- */

describe('GET /health without a challenge', () => {
  it('answers exactly the protocol body, no-store, and no identity header', async () => {
    writeAuthFile(state.authFilePath, token);
    const answer = await probe(mount(configuredDeps()));
    expectPlainProbe(answer);
    expectNoSecret(answer, token, state.authFilePath);
    expect(withheldRecords()).toEqual([]);
  });

  it('reports pairing availability and degrades a throwing predicate to unavailable', async () => {
    expectPlainProbe(await probe(mount(configuredDeps({ isPairingAvailable: () => true }))), true);
    const failing = mount(
      configuredDeps({
        isPairingAvailable: () => {
          throw new Error('registry unavailable');
        },
      }),
    );
    expectPlainProbe(await probe(failing), false);
  });

  it('answers the same with no configuration at all', async () => {
    const answer = await probe(
      mount({ serviceVersion: SERVICE_VERSION, isPairingAvailable: () => false }),
    );
    expectPlainProbe(answer);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The challenged probe
 * ---------------------------------------------------------------------------------------------- */

describe('GET /health with a valid challenge', () => {
  it('proves the credential in auth.json, bound to the configured endpoint', async () => {
    writeAuthFile(state.authFilePath, token);
    const app = mount(configuredDeps());
    const challenge = newChallenge();

    const answer = await probe(app, challenge);

    const endpoint = `127.0.0.1:${BOUND_PORT}`;
    expect(answer.status).toBe(200);
    expect(answer.headers.get(ENDPOINT_HEADER)).toBe(endpoint);
    expect(answer.headers.get(PROOF_HEADER)).toBe(expectedProof(token, challenge, endpoint));
    expect(answer.headers.get('cache-control')).toBe('no-store');
    // The body is the plain probe's, byte for byte.
    expect(answer.text).toBe((await probe(app)).text);
    expectNoSecret(answer, token, state.authFilePath);
    expect(withheldRecords()).toEqual([]);
  });

  it('answers a different proof for every challenge', async () => {
    writeAuthFile(state.authFilePath, token);
    const app = mount(configuredDeps());
    const first = await probe(app, newChallenge());
    const second = await probe(app, newChallenge());
    expect(first.headers.get(PROOF_HEADER)).not.toBeNull();
    expect(first.headers.get(PROOF_HEADER)).not.toBe(second.headers.get(PROOF_HEADER));
  });

  it('brackets an IPv6 host and normalises the host before binding the proof to it', async () => {
    writeAuthFile(state.authFilePath, token);
    const challenge = newChallenge();
    for (const [host, endpoint] of [
      ['::1', `[::1]:${BOUND_PORT}`],
      ['[::1]', `[::1]:${BOUND_PORT}`],
      [' FE80::1 ', `[fe80::1]:${BOUND_PORT}`],
      [' 127.0.0.1 ', `127.0.0.1:${BOUND_PORT}`],
    ] as const) {
      const app = mount(
        configuredDeps({
          config: { host, port: BOUND_PORT, authFilePath: state.authFilePath },
        }),
      );
      const answer = await probe(app, challenge);
      expect(answer.headers.get(ENDPOINT_HEADER), host).toBe(endpoint);
      expect(answer.headers.get(PROOF_HEADER), host).toBe(
        expectedProof(token, challenge, endpoint),
      );
    }
  });

  it('binds the proof to the endpoint, so a relay on another port cannot reuse it', async () => {
    writeAuthFile(state.authFilePath, token);
    const challenge = newChallenge();
    const service = await probe(mount(configuredDeps()), challenge);
    const relay = await probe(
      mount(
        configuredDeps({
          config: { host: '127.0.0.1', port: BOUND_PORT + 1, authFilePath: state.authFilePath },
        }),
      ),
      challenge,
    );
    const servicesProof = service.headers.get(PROOF_HEADER);
    expect(servicesProof).not.toBeNull();
    expect(relay.headers.get(PROOF_HEADER)).not.toBe(servicesProof);
    // A client that dialled the relay's port recomputes over that endpoint and
    // does not get the service's proof.
    expect(expectedProof(token, challenge, `127.0.0.1:${BOUND_PORT + 1}`)).not.toBe(servicesProof);
  });

  it('reads the port on every request, so the bound port of a live configuration is proved', async () => {
    writeAuthFile(state.authFilePath, token);
    let bound = 0;
    const config = {
      host: '127.0.0.1',
      authFilePath: state.authFilePath,
      get port(): number {
        return bound;
      },
    };
    const app = mount(configuredDeps({ config }));
    const challenge = newChallenge();

    expectPlainProbe(await probe(app, challenge));
    expect(withheldRecords().map((record) => record.fields.reason)).toEqual([
      'endpoint-unavailable',
    ]);

    bound = BOUND_PORT + 7;
    const answer = await probe(app, challenge);
    const endpoint = `127.0.0.1:${bound}`;
    expect(answer.headers.get(ENDPOINT_HEADER)).toBe(endpoint);
    expect(answer.headers.get(PROOF_HEADER)).toBe(expectedProof(token, challenge, endpoint));
  });

  it('follows the credential when auth.json is replaced', async () => {
    writeAuthFile(state.authFilePath, token);
    const app = mount(configuredDeps());
    const challenge = newChallenge();
    const before = await probe(app, challenge);

    const rotated = newToken();
    rmSync(state.authFilePath);
    writeAuthFile(state.authFilePath, rotated);
    const after = await probe(app, challenge);

    const endpoint = `127.0.0.1:${BOUND_PORT}`;
    expect(before.headers.get(PROOF_HEADER)).toBe(expectedProof(token, challenge, endpoint));
    expect(after.headers.get(PROOF_HEADER)).toBe(expectedProof(rotated, challenge, endpoint));
    expect(after.headers.get(PROOF_HEADER)).not.toBe(before.headers.get(PROOF_HEADER));
    expectNoSecret(after, rotated, state.authFilePath);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Withholding the proof
 * ---------------------------------------------------------------------------------------------- */

describe('GET /health withholds the proof', () => {
  it.each([
    ['too short', 'A'.repeat(21)],
    ['too long', 'A'.repeat(129)],
    ['padded base64', `${'A'.repeat(42)}=`],
    ['standard base64', `${'A'.repeat(41)}+/`],
    ['a repeated header', `${'A'.repeat(43)}, ${'B'.repeat(43)}`],
    ['empty', ''],
  ])('for a challenge that is %s', async (_label, challenge) => {
    writeAuthFile(state.authFilePath, token);
    const answer = await probe(mount(configuredDeps()), challenge);
    expectPlainProbe(answer);
    expectNoSecret(answer, token, state.authFilePath);
    expect(withheldRecords()).toEqual([
      {
        level: 'debug',
        message: WITHHELD_MESSAGE,
        fields: { operation: 'health', reason: 'challenge-invalid' },
      },
    ]);
  });

  it.each([
    ['no configuration', (): HealthRoutesDeps['config'] => undefined, 'endpoint-unavailable'],
    [
      'an unbound port',
      (): HealthRoutesDeps['config'] => ({
        host: '127.0.0.1',
        port: 0,
        authFilePath: state.authFilePath,
      }),
      'endpoint-unavailable',
    ],
    [
      'no host',
      (): HealthRoutesDeps['config'] => ({ port: BOUND_PORT, authFilePath: state.authFilePath }),
      'endpoint-unavailable',
    ],
    [
      'no port',
      (): HealthRoutesDeps['config'] => ({ host: '127.0.0.1', authFilePath: state.authFilePath }),
      'endpoint-unavailable',
    ],
    [
      'no auth.json path',
      (): HealthRoutesDeps['config'] => ({ host: '127.0.0.1', port: BOUND_PORT }),
      'credential-path-unavailable',
    ],
    [
      'a relative auth.json path',
      (): HealthRoutesDeps['config'] => ({
        host: '127.0.0.1',
        port: BOUND_PORT,
        authFilePath: 'auth.json',
      }),
      'credential-path-unavailable',
    ],
  ] as const)('for %s', async (_label, configFor, reason) => {
    writeAuthFile(state.authFilePath, token);
    const answer = await probe(mount(configuredDeps({ config: configFor() })), newChallenge());
    expectPlainProbe(answer);
    expect(withheldRecords().map((record) => [record.level, record.fields.reason])).toEqual([
      ['debug', reason],
    ]);
  });

  it('for a host name, with a warning once until a proof succeeds', async () => {
    writeAuthFile(state.authFilePath, token);
    const named = mount(
      configuredDeps({
        config: { host: 'localhost', port: BOUND_PORT, authFilePath: state.authFilePath },
      }),
    );
    const first = await probe(named, newChallenge());
    const second = await probe(named, newChallenge());
    expectPlainProbe(first);
    expectPlainProbe(second);
    expect(withheldRecords().map((record) => [record.level, record.fields.reason])).toEqual([
      ['warn', 'endpoint-not-an-address'],
      ['debug', 'endpoint-not-an-address'],
    ]);
  });

  it('when auth.json is absent', async () => {
    const answer = await probe(mount(configuredDeps()), newChallenge());
    expectPlainProbe(answer);
    expect(withheldRecords().map((record) => record.fields.reason)).toEqual(['credential-absent']);
  });

  it.skipIf(NO_POSIX_IDS)('when auth.json is readable by the group or other accounts', async () => {
    for (const mode of [0o644, 0o640, 0o604, 0o660]) {
      records.length = 0;
      writeAuthFile(state.authFilePath, token, mode);
      const answer = await probe(mount(configuredDeps()), newChallenge());
      expectPlainProbe(answer);
      expectNoSecret(answer, token, state.authFilePath);
      expect(
        withheldRecords().map((record) => record.fields.reason),
        mode.toString(8),
      ).toEqual(['credential-exposed']);
      rmSync(state.authFilePath);
    }
  });

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'when auth.json is a symbolic link to a private record',
    async () => {
      const target = join(state.dir, 'elsewhere.json');
      writeAuthFile(target, token);
      symlinkSync(target, state.authFilePath);
      const answer = await probe(mount(configuredDeps()), newChallenge());
      expectPlainProbe(answer);
      expectNoSecret(answer, token, state.authFilePath);
      expect(withheldRecords().map((record) => record.fields.reason)).toEqual([
        'credential-unsafe',
      ]);
    },
  );

  it('when auth.json has a second hard link', async () => {
    writeAuthFile(state.authFilePath, token);
    linkSync(state.authFilePath, join(state.dir, 'second-link.json'));
    const answer = await probe(mount(configuredDeps()), newChallenge());
    expectPlainProbe(answer);
    expect(withheldRecords().map((record) => record.fields.reason)).toEqual(['credential-unsafe']);
  });

  it('when auth.json is a directory', async () => {
    mkdirSync(state.authFilePath, { mode: 0o700 });
    const answer = await probe(mount(configuredDeps()), newChallenge());
    expectPlainProbe(answer);
    expect(withheldRecords().map((record) => record.fields.reason)).toEqual(['credential-unsafe']);
  });

  it.skipIf(!CAN_CHOWN)('when auth.json is owned by another account', async () => {
    writeAuthFile(state.authFilePath, token);
    chownSync(state.authFilePath, 65_534, 65_534);
    const answer = await probe(mount(configuredDeps()), newChallenge());
    expectPlainProbe(answer);
    expect(withheldRecords().map((record) => record.fields.reason)).toEqual(['credential-unsafe']);
  });

  it.each([
    ['not JSON', (): string | Buffer => '{ "version": 1, "token": ', 'credential-not-json'],
    [
      'not UTF-8',
      (): string | Buffer => Buffer.from([0x7b, 0xff, 0xfe, 0x7d]),
      'credential-not-json',
    ],
    ['JSON of another shape', (): string | Buffer => '[]', 'credential-not-a-record'],
    [
      'a record with an extra key',
      (): string | Buffer =>
        JSON.stringify({ version: AUTH_FILE_VERSION, token, issuedAt: 1, extra: true }),
      'credential-not-a-record',
    ],
    [
      'a record of another version',
      (): string | Buffer => JSON.stringify({ version: AUTH_FILE_VERSION + 1, token, issuedAt: 1 }),
      'credential-not-a-record',
    ],
    [
      'a record with an empty credential',
      (): string | Buffer => JSON.stringify({ version: AUTH_FILE_VERSION, token: '', issuedAt: 1 }),
      'credential-not-a-record',
    ],
    [
      'larger than the read limit',
      (): string | Buffer =>
        `${JSON.stringify({ version: AUTH_FILE_VERSION, token, issuedAt: 1 })}${' '.repeat(AUTH_FILE_READ_LIMIT_BYTES)}`,
      'credential-oversize',
    ],
  ] as const)('when auth.json is %s', async (_label, contents, reason) => {
    writeFileSync(state.authFilePath, contents(), { mode: 0o600 });
    chmodSync(state.authFilePath, 0o600);
    const answer = await probe(mount(configuredDeps()), newChallenge());
    expectPlainProbe(answer);
    expectNoSecret(answer, token, state.authFilePath);
    expect(withheldRecords().map((record) => record.fields.reason)).toEqual([reason]);
  });

  it('accepts a record exactly at the read limit', async () => {
    const record = JSON.stringify({ version: AUTH_FILE_VERSION, token, issuedAt: 1 });
    writeFileSync(
      state.authFilePath,
      `${record}${' '.repeat(AUTH_FILE_READ_LIMIT_BYTES - Buffer.byteLength(record))}`,
      { mode: 0o600 },
    );
    chmodSync(state.authFilePath, 0o600);
    const challenge = newChallenge();
    const answer = await probe(mount(configuredDeps()), challenge);
    expect(answer.headers.get(PROOF_HEADER)).toBe(
      expectedProof(token, challenge, `127.0.0.1:${BOUND_PORT}`),
    );
  });

  it.skipIf(NO_POSIX_IDS)(
    'warns once per file-state reason until a proof succeeds, and logs nothing identifying',
    async () => {
      writeAuthFile(state.authFilePath, token, 0o644);
      const app = mount(configuredDeps());
      const challenge = newChallenge();

      await probe(app, challenge);
      await probe(app, challenge);
      rmSync(state.authFilePath);
      await probe(app, challenge);
      writeAuthFile(state.authFilePath, token);
      const proven = await probe(app, challenge);
      expect(proven.headers.get(PROOF_HEADER)).not.toBeNull();
      rmSync(state.authFilePath);
      await probe(app, challenge);

      expect(withheldRecords().map((record) => [record.level, record.fields.reason])).toEqual([
        ['warn', 'credential-exposed'],
        ['debug', 'credential-exposed'],
        ['warn', 'credential-absent'],
        ['warn', 'credential-absent'],
      ]);
      const logged = JSON.stringify(records);
      for (const value of [token, challenge, state.authFilePath, state.dir]) {
        expect(logged.includes(value)).toBe(false);
      }
    },
  );
});
