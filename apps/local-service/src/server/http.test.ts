/**
 * Tests for `./http.ts`'s error boundary and its response-header policy.
 *
 * 1. **The error boundary.** A `DebuggenError` thrown while a request is
 *    answered reaches a `4xx` body with its own message only when that message
 *    is proven product text, and the body's `ref` names the boundary's local
 *    records — the closed `warn` record and, at `debug`, the redacted
 *    diagnostic twin (CWE-209, CWE-532).
 * 2. **The response-header policy (CWE-693).** Every reply — success, each
 *    refusal, `404`, `5xx`, the `503` after close, the body guard's and the
 *    verifier's replacements, an immutable-headers reply, `HEAD`, and the Node
 *    listener's own fallbacks over a real socket — carries
 *    `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, and none
 *    carries `Access-Control-Allow-Origin` (so no web page can read a reply) or
 *    a `Server` banner.
 * 3. **Every reply names its ref.** Every reply carries `X-Debuggen-Ref`; a
 *    failure body that satisfies protocol's error schema carries the same
 *    value as `ref` — added to a route's or the access boundary's body that
 *    lacked one, kept when the body already named its own — and the failure is
 *    filed at `info` under that ref with its code. A body that is not the error
 *    shape is left untouched.
 *
 * Every collaborator a test does not supply is a stand-in that throws one
 * chosen `DebuggenError`, so a failure arrives at `app.onError` exactly as a
 * collaborator's thrown error would. Two route modules are wrapped with
 * `vi.mock` so a test can make the health route answer a reply of its choosing
 * and make `pair.complete` misreport a refused body; each wrapper delegates to
 * the real handler unless the test asked otherwise.
 */

import { createServer, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildPath } from '@debuggen/protocol';
import { DebuggenError, err, newMessageId, newSessionId, ok } from '@debuggen/shared';

import type { ServiceConfig } from '../config.js';
import { createServiceLogger } from '../logging.js';
import { FAILURE_COPY_BY_CODE, authorProductText } from '../sessions/progress.js';
import {
  AUTH_FAILURE_REASONS,
  REFUSAL_LOG_BURST,
  REFUSAL_LOG_WINDOW_MS,
  type HttpAuthorizationRequest,
} from './auth.js';
import { createHttpApp, type HttpApp, type HttpAppDeps } from './http.js';
import type * as HealthModule from './routes/health.js';
import type * as PairModule from './routes/pair.js';

/** What a test may make the two wrapped route modules do instead of their real handlers. */
interface RouteOverrides {
  /** When set, the health route answers this reply instead of its own. */
  healthReply: (() => Response) | undefined;
  /** When `true`, `pair.complete` reads the body and answers any read failure `400`. */
  misreportPairBody: boolean;
}

const overrides = vi.hoisted((): RouteOverrides => ({
  healthReply: undefined,
  misreportPairBody: false,
}));

vi.mock('./routes/health.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HealthModule>();
  return {
    ...actual,
    createHealthRoutes: (
      ...args: Parameters<typeof actual.createHealthRoutes>
    ): ReturnType<typeof actual.createHealthRoutes> => {
      const real = actual.createHealthRoutes(...args);
      const health: (typeof real)['health'] = async (c, next): Promise<Response> => {
        const replaced = overrides.healthReply?.();
        if (replaced !== undefined) {
          return replaced;
        }
        return (await real.health(c, next)) as Response;
      };
      return Object.freeze({ ...real, health });
    },
  };
});

vi.mock('./routes/pair.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PairModule>();
  return {
    ...actual,
    createPairRoutes: (
      ...args: Parameters<typeof actual.createPairRoutes>
    ): ReturnType<typeof actual.createPairRoutes> => {
      const real = actual.createPairRoutes(...args);
      const realComplete = real['pair.complete'];
      const complete: typeof realComplete = async (c, next): Promise<Response> => {
        if (!overrides.misreportPairBody) {
          return (await realComplete(c, next)) as Response;
        }
        try {
          await c.req.text();
        } catch {
          // Deliberately misreported below: the guard must correct the status.
        }
        return c.json(
          { code: 'PROTOCOL_INVALID_MESSAGE', message: 'The body was unreadable.' },
          400,
        );
      };
      return Object.freeze({ ...real, 'pair.complete': complete });
    },
  };
});

afterEach(() => {
  overrides.healthReply = undefined;
  overrides.misreportPairBody = false;
});

/** A resolved configuration; nothing here touches the file system. */
const BASE_CONFIG: ServiceConfig = {
  host: '127.0.0.1',
  port: 20240,
  logLevel: 'info',
  retentionDays: 30,
  provider: 'deterministic',
  debuggenHome: '/tmp/debuggen-home/24',
  databasePath: '/tmp/debuggen-home/24/sessions.sqlite',
  backupsDir: '/tmp/debuggen-home/24/backups',
  indexCacheDir: '/tmp/debuggen-home/24/index',
  authFilePath: '/tmp/debuggen-home/24/auth.json',
  promptsDir: '/tmp/prompts',
};

/** pino's numeric levels, as the service logger writes them. */
const WARN_LEVEL = 40;
const INFO_LEVEL = 30;
const DEBUG_LEVEL = 20;

/** The private text a collaborator's error carries: a URL query value and an SQL literal. */
const SENTINEL = 'zz-boundary-private';

interface Harness {
  readonly app: HttpApp;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly records: () => Record<string, unknown>[];
}

/**
 * The application over stand-in collaborators: every dependency this test
 * does not supply is an object whose every method throws `thrown`.
 *
 * @param supplied Dependencies that replace a default or a stand-in by name.
 */
function harness(
  thrown: DebuggenError,
  logLevel: ServiceConfig['logLevel'],
  supplied: Readonly<Record<string, unknown>> = {},
): Harness {
  const lines: string[] = [];
  const config: ServiceConfig = { ...BASE_CONFIG, logLevel };
  const logger = createServiceLogger(config, {
    destination: { write: (line: string) => void lines.push(line) },
  });
  const throwing: unknown = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === 'then'
          ? undefined
          : () => {
              throw thrown;
            },
    },
  );
  const own: Record<string, unknown> = {
    config,
    logger,
    serviceVersion: '0.1.0',
    isPairingAvailable: () => false,
    verifyResponses: true,
    // Optional knobs left unset, so the application uses its own defaults.
    newRequestRef: undefined,
    now: undefined,
    platform: undefined,
    ...supplied,
  };
  const deps = new Proxy(own, {
    get: (target, key) => (typeof key === 'string' && key in target ? target[key] : throwing),
  }) as unknown as HttpAppDeps;

  const app = createHttpApp(deps);
  if (!app.ok) {
    throw new Error(`the HTTP application did not assemble: ${app.error.code}`);
  }
  return {
    app: app.value,
    fetch: app.value.fetch,
    records: () =>
      lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((record) => record['subsystem'] === 'server.http'),
  };
}

/** A request the application must dispatch through its collaborators. */
function sessionsRequest(): Request {
  return new Request('http://127.0.0.1/sessions', {
    method: 'GET',
    headers: { authorization: 'Bearer stand-in' },
  });
}

describe('the HTTP error boundary', () => {
  it("answers a thrown error's unproven message with fixed copy and a ref its records share", async () => {
    const thrown = new DebuggenError(
      'SESSION_NOT_FOUND',
      `lookup of /api/items?email=${SENTINEL} failed: WHERE note = '${SENTINEL}'`,
    );
    const h = harness(thrown, 'info');

    const response = await h.fetch(sessionsRequest());
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body['code']).toBe('SESSION_NOT_FOUND');
    expect(body['message']).toBe(FAILURE_COPY_BY_CODE.SESSION_NOT_FOUND.summary);
    expect(body['ref']).toMatch(/^msg_[0-9a-z]{16}$/u);
    expect(text).not.toContain(SENTINEL);

    const matching = h.records().filter((record) => record['ref'] === body['ref']);
    expect(matching.map((record) => record['level'])).toContain(WARN_LEVEL);
    for (const record of h.records()) {
      expect(JSON.stringify(record)).not.toContain(SENTINEL);
    }
  });

  it('answers a registered product sentence verbatim', async () => {
    const message = authorProductText(`The session ${newSessionId()} is no longer available.`);
    const h = harness(new DebuggenError('SESSION_NOT_FOUND', message), 'info');

    const response = await h.fetch(sessionsRequest());
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body['message']).toBe(message);
  });

  it('files the redacted reason at debug under the same ref', async () => {
    const thrown = new DebuggenError(
      'SESSION_NOT_FOUND',
      `lookup of /api/items?email=${SENTINEL} failed: WHERE note = '${SENTINEL}'`,
    );
    const h = harness(thrown, 'debug');

    const response = await h.fetch(sessionsRequest());
    const body = (await response.json()) as Record<string, unknown>;
    const twins = h
      .records()
      .filter((record) => record['ref'] === body['ref'] && record['level'] === DEBUG_LEVEL);

    expect(twins.length).toBeGreaterThan(0);
    const carried = twins.map((record) => JSON.stringify(record['err'] ?? {})).join('\n');
    expect(carried).toContain('?email=?');
    expect(carried).toContain('note = ?');
    for (const record of h.records()) {
      expect(JSON.stringify(record)).not.toContain(SENTINEL);
    }
  });

  it('never rewords a 5xx: its body is already a fixed sentence', async () => {
    const h = harness(
      new DebuggenError('INTERNAL', `boom at /api/items?email=${SENTINEL}`),
      'info',
    );

    const response = await h.fetch(sessionsRequest());
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain(SENTINEL);
    expect((JSON.parse(text) as Record<string, unknown>)['ref']).toMatch(/^msg_/u);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The response-header policy
 * ---------------------------------------------------------------------------------------------- */

/** The error every stand-in the policy tests never mean to reach would throw. */
const UNREACHED = new DebuggenError('INTERNAL', 'A stand-in the test did not mean to reach ran.');

/** A web origin the service refuses outright. */
const WEB_ORIGIN = 'https://attacker.example';

/** A body longer than `pair.complete`'s ceiling (`MAX_PAIR_REQUEST_BODY_BYTES`, 4 KiB). */
const OVERSIZED_BODY = `{"code":"${'A'.repeat(8 * 1024)}"}`;

/** The headers the policy fixes, and the two it forbids, as one reply carries them. */
interface PolicyHeaders {
  readonly contentTypeOptions: string | null;
  readonly cacheControl: string | null;
  readonly allowOrigin: string | null;
  readonly server: string | null;
}

/** What every reply of the service must carry. */
const EXPECTED_POLICY: PolicyHeaders = {
  contentTypeOptions: 'nosniff',
  cacheControl: 'no-store',
  allowOrigin: null,
  server: null,
};

/** Reads the policy headers from a WHATWG reply or from a Node client's parsed reply. */
function policyOf(headers: Headers | IncomingHttpHeaders): PolicyHeaders {
  const read = (name: string): string | null => {
    if (headers instanceof Headers) {
      return headers.get(name);
    }
    const value = headers[name];
    return Array.isArray(value) ? value.join(', ') : (value ?? null);
  };
  return {
    contentTypeOptions: read('x-content-type-options'),
    cacheControl: read('cache-control'),
    allowOrigin: read('access-control-allow-origin'),
    server: read('server'),
  };
}

/** An access boundary that admits every request without a principal, as it does the exempt routes. */
function admittingAuth(): Record<string, unknown> {
  return {
    authorizeHttpRequest: () => ok(null),
    startPairing: () => {
      throw UNREACHED;
    },
    completePairing: () => ok({ token: 't'.repeat(43) }),
  };
}

/** An access boundary that refuses every request for a missing credential. */
function refusingAuth(): Record<string, unknown> {
  const descriptor = AUTH_FAILURE_REASONS['missing-credential'];
  return {
    authorizeHttpRequest: () =>
      err(
        new DebuggenError(descriptor.code, descriptor.message, {
          details: { reason: 'missing-credential' },
        }),
      ),
  };
}

/** A request to protocol's path for `operation`, addressed like the in-process suites. */
function operationRequest(operation: 'health' | 'pair.complete', init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1${buildPath(operation)}`, init);
}

/** A reply read over a real socket by Node's HTTP client. */
interface SocketReply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** Sends one request line to `port` and reads the whole reply. */
async function socketExchange(port: number, path: string): Promise<SocketReply> {
  return new Promise<SocketReply>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', agent: false });
    request.on('response', (response) => {
      const parts: Buffer[] = [];
      response.on('data', (part: Buffer) => {
        parts.push(part);
      });
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(parts).toString('utf8'),
        });
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

describe('the response-header policy', () => {
  it('marks a success reply', async () => {
    const h = harness(UNREACHED, 'info', { auth: admittingAuth() });

    const response = await h.fetch(operationRequest('health'));

    expect(response.status).toBe(200);
    expect(policyOf(response.headers)).toEqual(EXPECTED_POLICY);
  });

  it('marks the reply to a HEAD request, which hono re-wraps outside the chain', async () => {
    const h = harness(UNREACHED, 'info', { auth: admittingAuth() });

    const response = await h.fetch(operationRequest('health', { method: 'HEAD' }));

    expect(response.status).toBe(200);
    expect(policyOf(response.headers)).toEqual(EXPECTED_POLICY);
  });

  it('marks the refusal of a web origin, which the origin guard answers first', async () => {
    const h = harness(UNREACHED, 'info', { auth: admittingAuth() });

    const response = await h.fetch(operationRequest('health', { headers: { origin: WEB_ORIGIN } }));

    expect(response.status).toBe(403);
    expect(policyOf(response.headers)).toEqual(EXPECTED_POLICY);
  });

  it("marks the access boundary's refusal of a missing credential", async () => {
    const h = harness(UNREACHED, 'info', { auth: refusingAuth() });

    const response = await h.fetch(sessionsRequest());

    expect(response.status).toBe(401);
    expect(policyOf(response.headers)).toEqual(EXPECTED_POLICY);
  });

  it('marks the reply to a path no route answers', async () => {
    const h = harness(UNREACHED, 'info', { auth: admittingAuth() });

    const response = await h.fetch(new Request('http://127.0.0.1/no-such-route'));

    expect(response.status).toBe(404);
    expect(policyOf(response.headers)).toEqual(EXPECTED_POLICY);
  });

  it("marks the error boundary's 500", async () => {
    const h = harness(UNREACHED, 'info');

    const response = await h.fetch(sessionsRequest());

    expect(response.status).toBe(500);
    expect(policyOf(response.headers)).toEqual(EXPECTED_POLICY);
  });

  it('marks the 503 every request is answered with after close', async () => {
    const h = harness(UNREACHED, 'info', { auth: admittingAuth() });
    h.app.close();

    const response = await h.fetch(operationRequest('health'));

    expect(response.status).toBe(503);
    expect(policyOf(response.headers)).toEqual(EXPECTED_POLICY);
  });

  it("marks a route's own 413 for a body over the operation's ceiling", async () => {
    const h = harness(UNREACHED, 'info', { auth: admittingAuth() });

    const response = await h.fetch(
      operationRequest('pair.complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: OVERSIZED_BODY,
      }),
    );

    expect(response.status).toBe(413);
    expect(policyOf(response.headers)).toEqual(EXPECTED_POLICY);
  });

  it("marks the body guard's own 413, which replaces a misreported refusal", async () => {
    overrides.misreportPairBody = true;
    const h = harness(UNREACHED, 'info', { auth: admittingAuth() });

    const response = await h.fetch(
      operationRequest('pair.complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: OVERSIZED_BODY,
      }),
    );

    expect(response.status).toBe(413);
    expect(policyOf(response.headers)).toEqual(EXPECTED_POLICY);
    expect(h.records().map((record) => record['msg'])).toContain(
      'A route answered a refused request body at another status; answering the refusal',
    );
  });

  it("marks the verifier's 500, which replaces an off-contract reply", async () => {
    overrides.healthReply = () =>
      new Response('<p>not the contract</p>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    const h = harness(UNREACHED, 'info', { auth: admittingAuth() });

    const response = await h.fetch(operationRequest('health'));

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/u);
    expect(policyOf(response.headers)).toEqual(EXPECTED_POLICY);
    expect(h.records().map((record) => record['msg'])).toContain(
      'A route answered with a reply its protocol contract refuses; answering 500',
    );
  });

  it('re-wraps a reply whose headers the platform made immutable, keeping its status and headers', async () => {
    const location = 'http://127.0.0.1/elsewhere';
    overrides.healthReply = () => Response.redirect(location, 302);
    const h = harness(UNREACHED, 'info', { auth: admittingAuth(), verifyResponses: 'off' });

    const response = await h.fetch(operationRequest('health'));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(location);
    expect(policyOf(response.headers)).toEqual(EXPECTED_POLICY);
  });

  it('answers an immutable reply that cannot be re-wrapped with a 500 that carries the policy', async () => {
    // `Response.error()` has immutable headers and status 0, which no
    // `Response` can be constructed with, so the re-wrap itself fails.
    overrides.healthReply = () => Response.error();
    const h = harness(UNREACHED, 'info', { auth: admittingAuth(), verifyResponses: 'off' });

    const response = await h.fetch(operationRequest('health'));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body['code']).toBe('INTERNAL');
    expect(policyOf(response.headers)).toEqual(EXPECTED_POLICY);
  });

  describe('over a real socket', () => {
    let server: Server | undefined;

    afterEach(async () => {
      const open = server;
      server = undefined;
      if (open !== undefined) {
        open.closeAllConnections();
        await new Promise<void>((resolve) => {
          open.close(() => {
            resolve();
          });
        });
      }
    });

    /** Serves `app` on an ephemeral loopback port and returns the port. */
    async function listen(app: HttpApp): Promise<number> {
      const listening = createServer(app.requestListener);
      server = listening;
      await new Promise<void>((resolve) => {
        listening.listen(0, '127.0.0.1', resolve);
      });
      return (listening.address() as AddressInfo).port;
    }

    it('writes the policy on a reply the application answered', async () => {
      const h = harness(UNREACHED, 'info', { auth: admittingAuth() });
      const port = await listen(h.app);

      const reply = await socketExchange(port, buildPath('health'));

      expect(reply.status).toBe(200);
      expect(policyOf(reply.headers)).toEqual(EXPECTED_POLICY);
    });

    it("writes the policy on the listener's refusal of a request URL it cannot read", async () => {
      const h = harness(UNREACHED, 'info', { auth: admittingAuth() });
      const port = await listen(h.app);

      // The asterisk form is a request target Node accepts and the adapter
      // cannot turn into a URL, so the listener's own error handler answers.
      const reply = await socketExchange(port, '*');

      expect(reply.status).toBe(400);
      expect((JSON.parse(reply.body) as Record<string, unknown>)['code']).toBe(
        'PROTOCOL_INVALID_MESSAGE',
      );
      expect(policyOf(reply.headers)).toEqual(EXPECTED_POLICY);
    });

    it('writes the policy on the raw 500 written when the listener itself fails', async () => {
      // The first ref is the one the listener's error handler mints: failing
      // it makes that handler throw, which is what reaches the raw fallback.
      let refs = 0;
      const newRequestRef = (): string => {
        refs += 1;
        if (refs === 1) {
          throw new Error('The ref source is unavailable.');
        }
        return newMessageId();
      };
      const h = harness(UNREACHED, 'info', { auth: admittingAuth(), newRequestRef });
      const port = await listen(h.app);

      const reply = await socketExchange(port, '*');
      const body = JSON.parse(reply.body) as Record<string, unknown>;

      expect(reply.status).toBe(500);
      expect(reply.headers['content-type']).toBe('application/json');
      expect(body['code']).toBe('INTERNAL');
      expect(body['ref']).toMatch(/^msg_/u);
      expect(policyOf(reply.headers)).toEqual(EXPECTED_POLICY);
      const fallback = h
        .records()
        .filter((record) => record['msg'] === 'The HTTP listener failed while writing a response');
      expect(fallback.map((record) => record['ref'])).toEqual([body['ref']]);
    });
  });
});

/* -------------------------------------------------------------------------------------------------
 * Every reply names its ref
 * ---------------------------------------------------------------------------------------------- */

/** The response header every reply carries its correlation ref in. */
const REF_HEADER = 'x-debuggen-ref';

/** The record every answered failure is filed under at `info`. */
const FAILURE_ANSWERED_LOG = 'Answered an HTTP request with a failure';

/** The record every answered success is filed under at `debug`. */
const SUCCESS_ANSWERED_LOG = 'Answered an HTTP request';

/** The shape of every ref the service mints. */
const MINTED_REF = /^msg_[0-9a-z]{16}$/u;

/** Asserts that a body names a ref the service minted, and returns it. */
function mintedRefOf(body: Readonly<Record<string, unknown>>): string {
  const ref = body['ref'];
  if (typeof ref !== 'string') {
    throw new Error('The failure body names no ref.');
  }
  expect(ref).toMatch(MINTED_REF);
  return ref;
}

/** The records with `message` a harness captured. */
function recordsWith(h: Harness, message: string): Record<string, unknown>[] {
  return h.records().filter((record) => record['msg'] === message);
}

/** An access boundary that refuses a missing credential and keeps the ref each request handed it. */
function refRecordingAuth(seen: (string | undefined)[]): Record<string, unknown> {
  const descriptor = AUTH_FAILURE_REASONS['missing-credential'];
  return {
    authorizeHttpRequest: (request: HttpAuthorizationRequest) => {
      seen.push(request.ref);
      return err(
        new DebuggenError(descriptor.code, descriptor.message, {
          details: { reason: 'missing-credential' },
        }),
      );
    },
  };
}

describe('every reply names its ref', () => {
  it("adds the request's ref to a route's failure body that has none, in the header and the info record too", async () => {
    const text = JSON.stringify({ code: 'SESSION_NOT_FOUND', message: 'No such session.' });
    overrides.healthReply = () =>
      new Response(text, {
        status: 404,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(text)),
        },
      });
    const h = harness(UNREACHED, 'info', { auth: admittingAuth() });

    const response = await h.fetch(operationRequest('health'));
    const raw = await response.text();
    const body = JSON.parse(raw) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body).toEqual({
      code: 'SESSION_NOT_FOUND',
      message: 'No such session.',
      ref: mintedRefOf(body),
    });
    expect(response.headers.get(REF_HEADER)).toBe(body['ref']);
    // The stale length of the shorter body is never sent with the longer one.
    expect(response.headers.get('content-length')).not.toBe(String(Buffer.byteLength(text)));
    expect(policyOf(response.headers)).toEqual(EXPECTED_POLICY);

    const failures = recordsWith(h, FAILURE_ANSWERED_LOG);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      level: INFO_LEVEL,
      method: 'GET',
      operation: 'health',
      status: 404,
      errorCode: 'SESSION_NOT_FOUND',
      ref: body['ref'],
    });
    expect(typeof failures[0]?.['durationMs']).toBe('number');
    // The route's pattern, never the request's path, headers or body.
    for (const key of ['path', 'url', 'headers', 'body']) {
      expect(Object.keys(failures[0] ?? {})).not.toContain(key);
    }
  });

  it('keeps the ref a failure body already names, and files the header and the record under it', async () => {
    const own = 'msg_routeownref00001';
    overrides.healthReply = () =>
      Response.json(
        { code: 'SESSION_NOT_FOUND', message: 'No such session.', ref: own },
        { status: 404 },
      );
    const h = harness(UNREACHED, 'info', { auth: admittingAuth() });

    const response = await h.fetch(operationRequest('health'));

    expect(await response.json()).toEqual({
      code: 'SESSION_NOT_FOUND',
      message: 'No such session.',
      ref: own,
    });
    expect(response.headers.get(REF_HEADER)).toBe(own);
    expect(recordsWith(h, FAILURE_ANSWERED_LOG).map((record) => record['ref'])).toEqual([own]);
  });

  it('adds the ref to a capture-conflict body and keeps its owning session', async () => {
    const owningSessionId = newSessionId();
    overrides.healthReply = () =>
      Response.json(
        {
          code: 'CAPTURE_ALREADY_ACTIVE',
          message: 'Another session is capturing.',
          owningSessionId,
        },
        { status: 409 },
      );
    const h = harness(UNREACHED, 'info', { auth: admittingAuth() });

    const response = await h.fetch(operationRequest('health'));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body).toEqual({
      code: 'CAPTURE_ALREADY_ACTIVE',
      message: 'Another session is capturing.',
      owningSessionId,
      ref: mintedRefOf(body),
    });
    expect(response.headers.get(REF_HEADER)).toBe(body['ref']);
  });

  it('leaves a failure body that is not the error shape untouched, header aside', async () => {
    overrides.healthReply = () =>
      new Response('not the contract', { status: 404, headers: { 'content-type': 'text/plain' } });
    const h = harness(UNREACHED, 'info', { auth: admittingAuth(), verifyResponses: 'off' });

    const response = await h.fetch(operationRequest('health'));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('not the contract');
    const ref = response.headers.get(REF_HEADER);
    expect(ref).toMatch(MINTED_REF);
    const failures = recordsWith(h, FAILURE_ANSWERED_LOG);
    expect(failures.map((record) => record['ref'])).toEqual([ref]);
    expect(failures[0]?.['errorCode']).toBeUndefined();
  });

  it("names the ref of the access boundary's refusal in its body, its header, the boundary's call and the record", async () => {
    const seen: (string | undefined)[] = [];
    const h = harness(UNREACHED, 'info', { auth: refRecordingAuth(seen) });

    const response = await h.fetch(sessionsRequest());
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body['code']).toBe('UNAUTHORIZED');
    expect(body['ref']).toMatch(MINTED_REF);
    expect(response.headers.get(REF_HEADER)).toBe(body['ref']);
    // The boundary was handed the very ref its refusal is answered under.
    expect(seen).toEqual([body['ref']]);
    const failures = recordsWith(h, FAILURE_ANSWERED_LOG);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      level: INFO_LEVEL,
      operation: 'session.list',
      status: 401,
      errorCode: 'UNAUTHORIZED',
      ref: body['ref'],
    });
  });

  it('names the ref of the origin guard’s refusal in its body and its header', async () => {
    const h = harness(UNREACHED, 'info', { auth: admittingAuth() });

    const response = await h.fetch(operationRequest('health', { headers: { origin: WEB_ORIGIN } }));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: 'FORBIDDEN_ORIGIN',
      message: AUTH_FAILURE_REASONS['forbidden-origin'].message,
      ref: mintedRefOf(body),
    });
    expect(response.headers.get(REF_HEADER)).toBe(body['ref']);
  });

  it('carries the header on a success, and files the success at debug only under the same ref', async () => {
    const quiet = harness(UNREACHED, 'info', { auth: admittingAuth() });
    const answered = await quiet.fetch(operationRequest('health'));
    expect(answered.status).toBe(200);
    expect(answered.headers.get(REF_HEADER)).toMatch(MINTED_REF);
    expect(quiet.records()).toEqual([]);

    const verbose = harness(UNREACHED, 'debug', { auth: admittingAuth() });
    const response = await verbose.fetch(operationRequest('health', { method: 'HEAD' }));
    expect(response.status).toBe(200);
    const ref = response.headers.get(REF_HEADER);
    expect(ref).toMatch(MINTED_REF);
    const successes = recordsWith(verbose, SUCCESS_ANSWERED_LOG);
    expect(successes.map((record) => [record['level'], record['ref']])).toEqual([
      [DEBUG_LEVEL, ref],
    ]);
    expect(recordsWith(verbose, FAILURE_ANSWERED_LOG)).toEqual([]);
  });

  it('keeps the shape of the boundary’s own 404, 500 and 503, each naming its ref in the header', async () => {
    const lost = harness(UNREACHED, 'info', { auth: admittingAuth() });
    const notFound = await lost.fetch(new Request('http://127.0.0.1/no-such-route'));
    const notFoundBody = (await notFound.json()) as Record<string, unknown>;
    expect(notFound.status).toBe(404);
    expect(Object.keys(notFoundBody).sort()).toEqual(['code', 'message', 'ref']);
    expect(notFound.headers.get(REF_HEADER)).toBe(notFoundBody['ref']);

    const failing = harness(UNREACHED, 'info');
    const failed = await failing.fetch(sessionsRequest());
    const failedBody = (await failed.json()) as Record<string, unknown>;
    expect(failed.status).toBe(500);
    expect(Object.keys(failedBody).sort()).toEqual(['code', 'message', 'ref']);
    expect(failed.headers.get(REF_HEADER)).toBe(failedBody['ref']);
    // The boundary's error record and the request's failure record share the ref.
    const refs = failing
      .records()
      .filter((record) => record['level'] === INFO_LEVEL || record['level'] === 50)
      .map((record) => record['ref']);
    expect(new Set(refs)).toEqual(new Set([failedBody['ref']]));

    const closing = harness(UNREACHED, 'info', { auth: admittingAuth() });
    closing.app.close();
    const refused = await closing.fetch(operationRequest('health'));
    const refusedBody = (await refused.json()) as Record<string, unknown>;
    expect(refused.status).toBe(503);
    expect(Object.keys(refusedBody).sort()).toEqual(['code', 'message', 'ref']);
    expect(refused.headers.get(REF_HEADER)).toBe(refusedBody['ref']);
    expect(recordsWith(closing, FAILURE_ANSWERED_LOG).map((record) => record['ref'])).toEqual([
      refusedBody['ref'],
    ]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The origin guard's record
 * ---------------------------------------------------------------------------------------------- */

/** The record the origin guard files for every web origin it refuses. */
const ORIGIN_REFUSED_LOG = 'Refused a request from an origin this service never serves';

describe("the origin guard's record", () => {
  it('files a web-origin refusal at warn, naming its sanitized origin and the ref its reply carries', async () => {
    const h = harness(UNREACHED, 'info', { auth: admittingAuth() });
    // The userinfo is added at run time, so the committed source holds no
    // credential-shaped URL for `scripts/check-secrets.mjs` to flag.
    const craftedUrl = new URL('https://evil.example:8443/zz-path?zz-query=1');
    craftedUrl.username = 'user';
    craftedUrl.password = 'zz-secret';
    const crafted = craftedUrl.href;
    expect(crafted).toContain('user:zz-secret@');

    const response = await h.fetch(operationRequest('health', { headers: { origin: crafted } }));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(403);
    const refusals = recordsWith(h, ORIGIN_REFUSED_LOG);
    expect(refusals).toHaveLength(1);
    // Through the service's own logger: its redaction leaves the `origin` field readable.
    expect(refusals[0]).toMatchObject({
      level: WARN_LEVEL,
      method: 'GET',
      status: 403,
      origin: 'https://evil.example:8443',
      ref: body['ref'],
      suppressed: 0,
    });
    const text = JSON.stringify(h.records());
    for (const part of ['zz-secret', 'zz-path', 'zz-query', 'user:']) {
      expect(text).not.toContain(part);
    }
  });

  it('files refusals past the burst at debug, and counts them into the next window’s first warn', async () => {
    let clock = 0;
    const h = harness(UNREACHED, 'debug', { auth: admittingAuth(), now: () => clock });
    const refuse = async (): Promise<void> => {
      const response = await h.fetch(
        operationRequest('health', { headers: { origin: 'http://evil.example' } }),
      );
      expect(response.status).toBe(403);
    };

    for (let attempt = 0; attempt < REFUSAL_LOG_BURST + 2; attempt += 1) {
      await refuse();
    }
    clock += REFUSAL_LOG_WINDOW_MS;
    await refuse();

    const levels = recordsWith(h, ORIGIN_REFUSED_LOG).map((record) => [
      record['level'],
      record['origin'],
      record['suppressed'],
    ]);
    expect(levels).toEqual([
      ...Array.from({ length: REFUSAL_LOG_BURST }, () => [WARN_LEVEL, 'http://evil.example', 0]),
      [DEBUG_LEVEL, 'http://evil.example', undefined],
      [DEBUG_LEVEL, 'http://evil.example', undefined],
      [WARN_LEVEL, 'http://evil.example', 2],
    ]);
  });
});
