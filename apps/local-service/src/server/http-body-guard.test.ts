/**
 * Colocated unit suite for `./http.ts`'s middleware chain: the request-body
 * guard and the response verifier.
 *
 * What it pins:
 *
 * 1. **A body is bounded while it is read, not after.** An endless chunked
 *    body — one that declares no length and never ends — is answered `413` by
 *    every body-reading route module, so no route can be made to buffer it
 *    whole. A body that stops arriving is answered `408` at the time ceiling.
 *    The rest of a refused body is dropped within a bound and its source is
 *    then cancelled, so the drop itself is bounded too.
 * 2. **The guard is lazy.** A route that refuses a caller before it reads the
 *    body (a role the operation does not admit) reads none of it.
 * 3. **The refusal status is guaranteed.** A route that answers a refused body
 *    at another status is overridden with the refusal.
 * 4. **The contract with the route modules.** Each route module states the
 *    guard's two refusal reasons itself (it never imports `./http.ts`); each
 *    route answering with its *own* message — which names its operation — is
 *    what proves that module's copy matches.
 * 5. **Responses are validated once.** In the default `bounded` mode a success
 *    body is never re-read (its route validated it before serializing it),
 *    while framing and failure bodies still are, a failure body at most
 *    sixteen kibibytes deep; `full` mode re-parses success bodies.
 *
 * The application is built by `createHttpApp` over stub dependencies: only the
 * functions a request reaches before its body is read are real behaviour, and
 * every request these tests send is refused at, or just after, the body step.
 * Two route modules are wrapped with `vi.mock` so a test can make the health
 * route answer an off-contract reply and make `devServer.stop` misreport a
 * refused body; each wrapper delegates to the real handler unless the test
 * asked otherwise.
 */

import { createServer, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HTTP_ROUTES, buildPath } from '@debuggen/protocol';
import type { HttpOperationId } from '@debuggen/protocol';
import { isErr, noopLogger, ok } from '@debuggen/shared';

import { DEV_SERVER_CREDENTIAL_PATH } from '../dev-server/launcher.js';
import type { PairingCompletionRequest, Principal } from './auth.js';
import {
  DEFAULT_REQUEST_BODY_LIMIT_BYTES,
  REQUEST_BODY_LIMIT_BYTES,
  REQUEST_BODY_REFUSAL_REASONS,
  createHttpApp,
} from './http.js';
import type { HttpApp, HttpAppDeps, ResponseVerificationMode } from './http.js';
import { MAX_CREDENTIALS_REQUEST_BODY_BYTES } from './routes/credentials.js';
import type * as DevServerModule from './routes/dev-server.js';
import type * as HealthModule from './routes/health.js';
import { MAX_PAIR_REQUEST_BODY_BYTES } from './routes/pair.js';

/* -------------------------------------------------------------------------------------------------
 * Route wrappers
 * ---------------------------------------------------------------------------------------------- */

/** What a test may make the two wrapped route modules do instead of their real handlers. */
interface RouteOverrides {
  /** When set, the health route answers this reply instead of its own. */
  healthReply: (() => Response) | undefined;
  /** When `true`, `devServer.stop` reads the body and answers any read failure `400`. */
  misreportStopBody: boolean;
}

const overrides = vi.hoisted((): RouteOverrides => ({
  healthReply: undefined,
  misreportStopBody: false,
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

vi.mock('./routes/dev-server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof DevServerModule>();
  return {
    ...actual,
    createDevServerRoutes: (
      ...args: Parameters<typeof actual.createDevServerRoutes>
    ): ReturnType<typeof actual.createDevServerRoutes> => {
      const real = actual.createDevServerRoutes(...args);
      const realStop = real.handlers['devServer.stop'];
      const stop: typeof realStop = async (c, next): Promise<Response> => {
        if (!overrides.misreportStopBody) {
          return (await realStop(c, next)) as Response;
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
      return Object.freeze({
        ...real,
        handlers: Object.freeze({ ...real.handlers, 'devServer.stop': stop }),
      });
    },
  };
});

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/** The project every principal and stub session is scoped to. */
const PROJECT_ROOT = '/work/lumen-project';

/** A well-formed session id: the session prefix and the id alphabet. */
const SESSION_ID = 'ses_0123456789abcdef';

/** A well-formed pairing code, in the shape the stub mints. */
const PAIRING_CODE = 'ABCD2345';

/** The base every in-process request is addressed to; the listener is never bound for these. */
const BASE_URL = 'http://127.0.0.1';

/** The message of a refusal the guard itself renders (see `./http.ts`). */
const GUARD_TOO_LARGE_MESSAGE = 'The request body is larger than this operation accepts.';

/** The time ceiling the timeout cases run under, in milliseconds. */
const SHORT_BODY_TIMEOUT_MS = 50;

/** How long a test waits for the bounded drop of a refused body to cancel its source. */
const DISCARD_SETTLE_TIMEOUT_MS = 5_000;

const EDITOR: Principal = Object.freeze({
  role: 'vscode',
  scope: Object.freeze({ kind: 'machine-user', workspaceFolders: Object.freeze([PROJECT_ROOT]) }),
  tokenHash: 'e'.repeat(64),
  issuedAt: 0,
});

const DEVTOOLS: Principal = Object.freeze({
  role: 'devtools',
  scope: Object.freeze({ kind: 'extension', extensionId: 'a'.repeat(32) }),
  tokenHash: 'd'.repeat(64),
  issuedAt: 0,
});

const SERVER_AGENT: Principal = Object.freeze({
  role: 'server-agent',
  scope: Object.freeze({ kind: 'project', projectRoot: PROJECT_ROOT }),
  tokenHash: 's'.repeat(64),
  issuedAt: 0,
});

/** One built application and what its stubs observed. */
interface BuiltApp {
  readonly app: HttpApp;
  /** Every code the stub `completePairing` was asked to redeem. */
  readonly redeemed: readonly string[];
  /** Sets the principal the stub access boundary resolves for every request. */
  readonly setPrincipal: (principal: Principal | null) => void;
}

/** What {@link buildApp} may tune. */
interface BuildOptions {
  readonly verifyResponses?: ResponseVerificationMode | boolean;
  readonly requestBodyTimeoutMs?: number;
}

/**
 * Builds the real application over stub dependencies. Only what a request
 * reaches before or at its body is backed by behaviour; nothing else is ever
 * called by these tests.
 */
function buildApp(options: BuildOptions = {}): BuiltApp {
  let principal: Principal | null = null;
  const redeemed: string[] = [];

  const deps = {
    auth: {
      authorizeHttpRequest: () => ok(principal),
      startPairing: () => ok({ code: PAIRING_CODE, expiresAt: Date.now() + 60_000 }),
      completePairing: (request: PairingCompletionRequest) => {
        redeemed.push(request.code);
        // A redemption answers the credential and the read proof issued with it.
        return ok({ token: 't'.repeat(43), readProof: 'r'.repeat(43) });
      },
      // The revocation fence a route consults once it has read a body: every
      // stand-in credential here stays live, so each body is judged on its own.
      requireLiveCredential: () => ok(undefined),
    },
    config: { host: '127.0.0.1' },
    logger: noopLogger,
    sessions: { get: (id: string) => ok({ id, projectRoot: PROJECT_ROOT }) },
    bindings: { list: () => [], get: () => undefined },
    serviceVersion: '0.1.0',
    isPairingAvailable: () => true,
    ...(options.verifyResponses === undefined ? {} : { verifyResponses: options.verifyResponses }),
    ...(options.requestBodyTimeoutMs === undefined
      ? {}
      : { requestBodyTimeoutMs: options.requestBodyTimeoutMs }),
  } as unknown as HttpAppDeps;

  const built = createHttpApp(deps);
  if (isErr(built)) {
    throw built.error;
  }
  return {
    app: built.value,
    redeemed,
    setPrincipal: (next) => {
      principal = next;
    },
  };
}

/** A test body stream and what its consumer did to it. */
interface TestBody {
  readonly stream: ReadableStream<Uint8Array>;
  /** How many chunks were pulled. */
  pulls(): number;
  /** Whether the stream was cancelled. */
  cancelled(): boolean;
}

/** A body that never ends: one chunk of spaces per pull, forever. */
function endlessBody(chunkBytes = 16 * 1024): TestBody {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller): void {
        pulls += 1;
        controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
      },
      cancel(): void {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulls: () => pulls, cancelled: () => cancelled };
}

/** A body that sends `prefix`, then never sends another byte and never ends. */
function stalledBody(prefix: string): TestBody {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller): Promise<void> | undefined {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode(prefix));
          return undefined;
        }
        return new Promise<void>(() => {
          // Never settles: the client went quiet mid-body.
        });
      },
      cancel(): void {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulls: () => pulls, cancelled: () => cancelled };
}

/** A complete body delivered in `parts` chunks. */
function chunkedBody(text: string, parts: number): TestBody {
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil(bytes.byteLength / parts);
  let offset = 0;
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller): void {
        pulls += 1;
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + size));
        offset += size;
      },
      cancel(): void {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulls: () => pulls, cancelled: () => cancelled };
}

/** A streamed (length-less) request to `path`. */
function streamedRequest(method: string, path: string, body: TestBody): Request {
  return new Request(`${BASE_URL}${path}`, {
    method,
    body: body.stream,
    duplex: 'half',
    headers: { 'content-type': 'application/json' },
  });
}

/** Reads a reply's JSON error body. */
async function errorBody(response: Response): Promise<{ code: string; message: string }> {
  return (await response.json()) as { code: string; message: string };
}

/** One body-reading route: how to address it, who may call it, and the label its messages carry. */
interface BodyRoute {
  readonly label: string;
  readonly method: string;
  readonly path: string;
  readonly principal: Principal | null;
}

/** A protocol operation as a {@link BodyRoute}. */
function operationRoute(
  operation: HttpOperationId,
  principal: Principal | null,
  params?: Readonly<Record<string, string>>,
): BodyRoute {
  return {
    label: operation,
    method: HTTP_ROUTES[operation].method,
    path: buildPath(operation, params),
    principal,
  };
}

/** Every route module that reads a body, each through at least one of its operations. */
const BODY_ROUTES: readonly BodyRoute[] = [
  operationRoute('session.create', EDITOR),
  operationRoute('telemetry.event', SERVER_AGENT),
  operationRoute('panel.data', EDITOR, { id: SESSION_ID }),
  operationRoute('devServer.launch', EDITOR),
  {
    label: 'devServer.credential',
    method: 'POST',
    path: DEV_SERVER_CREDENTIAL_PATH,
    principal: EDITOR,
  },
  operationRoute('pair.start', EDITOR),
  operationRoute('pair.complete', null),
  operationRoute('credentials.rotate', EDITOR),
  operationRoute('credentials.release', EDITOR),
];

afterEach(() => {
  overrides.healthReply = undefined;
  overrides.misreportStopBody = false;
});

/* -------------------------------------------------------------------------------------------------
 * The request-body guard
 * ---------------------------------------------------------------------------------------------- */

describe('the request-body guard', () => {
  it('names the two refusal reasons every route module states for itself', () => {
    expect(REQUEST_BODY_REFUSAL_REASONS).toEqual({
      tooLarge: 'body-too-large',
      timedOut: 'body-read-timeout',
    });
  });

  it('bounds only body-carrying protocol operations, each by a positive byte count', () => {
    for (const [operation, maxBytes] of Object.entries(REQUEST_BODY_LIMIT_BYTES)) {
      expect(Object.hasOwn(HTTP_ROUTES, operation)).toBe(true);
      expect(HTTP_ROUTES[operation as HttpOperationId].method).not.toBe('GET');
      expect(Number.isSafeInteger(maxBytes) && maxBytes > 0).toBe(true);
    }
    expect(REQUEST_BODY_LIMIT_BYTES['pair.complete']).toBe(MAX_PAIR_REQUEST_BODY_BYTES);
    // The release's one-token body shares the credentials module's bound with the rotation.
    expect(REQUEST_BODY_LIMIT_BYTES['credentials.release']).toBe(
      MAX_CREDENTIALS_REQUEST_BODY_BYTES,
    );
    expect(DEFAULT_REQUEST_BODY_LIMIT_BYTES).toBeGreaterThan(0);
  });

  it('answers an endless chunked body on the unauthenticated pairing route with 413, without waiting for its end', async () => {
    const { app, redeemed } = buildApp();
    const body = endlessBody();

    const response = await app.fetch(streamedRequest('POST', buildPath('pair.complete'), body));

    expect(response.status).toBe(413);
    const payload = await errorBody(response);
    expect(payload.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(payload.message).toContain('pair.complete');
    expect(redeemed).toEqual([]);
    // The rest of the refused body is dropped within a bound, then its source is cancelled.
    await vi.waitFor(
      () => {
        expect(body.cancelled()).toBe(true);
      },
      { timeout: DISCARD_SETTLE_TIMEOUT_MS },
    );
  });

  it('passes a streamed body within its bound to the route unchanged', async () => {
    const { app, redeemed } = buildApp();
    const body = chunkedBody(JSON.stringify({ code: PAIRING_CODE }), 3);

    const response = await app.fetch(streamedRequest('POST', buildPath('pair.complete'), body));

    expect(response.status).toBe(200);
    expect(redeemed).toEqual([PAIRING_CODE]);
    expect(body.cancelled()).toBe(false);
  });

  it('answers a body that stops arriving with 408 at the time ceiling', async () => {
    const { app, redeemed } = buildApp({ requestBodyTimeoutMs: SHORT_BODY_TIMEOUT_MS });
    const body = stalledBody('{"code":');

    const response = await app.fetch(streamedRequest('POST', buildPath('pair.complete'), body));

    expect(response.status).toBe(408);
    const payload = await errorBody(response);
    expect(payload.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(payload.message).toContain('pair.complete');
    expect(payload.message).toContain('did not arrive in time');
    expect(redeemed).toEqual([]);
    await vi.waitFor(
      () => {
        expect(body.cancelled()).toBe(true);
      },
      { timeout: DISCARD_SETTLE_TIMEOUT_MS },
    );
  });

  it.each(BODY_ROUTES)(
    '$label answers an endless body with its own 413',
    async ({ label, method, path, principal }) => {
      const { app, setPrincipal } = buildApp();
      setPrincipal(principal);

      const response = await app.fetch(streamedRequest(method, path, endlessBody()));

      expect(response.status).toBe(413);
      const payload = await errorBody(response);
      expect(payload.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(payload.message).toContain(label);
    },
  );

  it.each(BODY_ROUTES)(
    '$label answers a stalled body with its own 408',
    async ({ label, method, path, principal }) => {
      const { app, setPrincipal } = buildApp({ requestBodyTimeoutMs: SHORT_BODY_TIMEOUT_MS });
      setPrincipal(principal);

      const response = await app.fetch(streamedRequest(method, path, stalledBody('{')));

      expect(response.status).toBe(408);
      const payload = await errorBody(response);
      expect(payload.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(payload.message).toContain(label);
      expect(payload.message).toContain('did not arrive in time');
    },
  );

  it('reads none of a body a route refuses before it reads the body', async () => {
    const { app, setPrincipal } = buildApp();
    setPrincipal(DEVTOOLS);
    const body = endlessBody();

    const response = await app.fetch(streamedRequest('POST', buildPath('session.create'), body));

    expect(response.status).toBe(403);
    expect(body.pulls()).toBe(0);
  });

  it('answers the refusal status when a route reports a refused body as another failure', async () => {
    overrides.misreportStopBody = true;
    const { app, setPrincipal } = buildApp();
    setPrincipal(EDITOR);

    const response = await app.fetch(
      streamedRequest('POST', buildPath('devServer.stop'), endlessBody()),
    );

    expect(response.status).toBe(413);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const payload = await errorBody(response);
    expect(payload).toMatchObject({
      code: 'PROTOCOL_INVALID_MESSAGE',
      message: GUARD_TOO_LARGE_MESSAGE,
    });
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

    it('delivers the 413 to a client that keeps sending, and keeps serving afterwards', async () => {
      const { app, redeemed } = buildApp();
      const listening = createServer(app.requestListener);
      server = listening;
      await new Promise<void>((resolve) => {
        listening.listen(0, '127.0.0.1', resolve);
      });
      const { port } = listening.address() as AddressInfo;

      const refused = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const chunk = Buffer.alloc(16 * 1024, 0x20);
        let answered = false;
        const request = httpRequest({
          host: '127.0.0.1',
          port,
          path: buildPath('pair.complete'),
          method: 'POST',
          agent: false,
          headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
        });
        const pump = (): void => {
          while (!answered) {
            if (!request.write(chunk)) {
              request.once('drain', pump);
              return;
            }
          }
        };
        request.on('response', (response) => {
          answered = true;
          request.end();
          const parts: Buffer[] = [];
          response.on('data', (part: Buffer) => {
            parts.push(part);
          });
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(parts).toString('utf8'),
            });
          });
        });
        request.on('error', (error) => {
          if (!answered) {
            reject(error);
          }
        });
        pump();
      });

      expect(refused.status).toBe(413);
      expect(JSON.parse(refused.body)).toMatchObject({ code: 'PROTOCOL_INVALID_MESSAGE' });
      expect(redeemed).toEqual([]);

      const health = await fetch(`http://127.0.0.1:${String(port)}${buildPath('health')}`);
      expect(health.status).toBe(200);
    });
  });
});

/* -------------------------------------------------------------------------------------------------
 * The response verifier
 * ---------------------------------------------------------------------------------------------- */

describe('the response verifier', () => {
  /** Sends `GET /health` with the health route answering `reply`. */
  async function healthAnswering(
    reply: () => Response,
    verifyResponses?: ResponseVerificationMode | boolean,
  ): Promise<Response> {
    overrides.healthReply = reply;
    const { app } = buildApp(verifyResponses === undefined ? {} : { verifyResponses });
    return app.fetch(new Request(`${BASE_URL}${buildPath('health')}`));
  }

  const unparseableSuccess = (): Response =>
    new Response('{"version":', { status: 200, headers: { 'content-type': 'application/json' } });

  const offSchemaSuccess = (): Response => Response.json({ bogus: true });

  it('does not read a success body again by default: its route validated it', async () => {
    const response = await healthAnswering(unparseableSuccess);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"version":');
  });

  it('passes an off-schema success body by default and refuses it in full mode', async () => {
    expect((await healthAnswering(offSchemaSuccess)).status).toBe(200);

    const full = await healthAnswering(offSchemaSuccess, 'full');
    expect(full.status).toBe(500);
    expect(await errorBody(full)).toMatchObject({ code: 'INTERNAL' });
  });

  it('re-parses success bodies in full mode, and reads true as full and false as off', async () => {
    expect((await healthAnswering(unparseableSuccess, 'full')).status).toBe(500);
    expect((await healthAnswering(unparseableSuccess, true)).status).toBe(500);
    expect((await healthAnswering(unparseableSuccess, false)).status).toBe(200);
    expect((await healthAnswering(unparseableSuccess, 'off')).status).toBe(200);
  });

  it('still checks the framing of a success reply by default', async () => {
    const response = await healthAnswering(
      () => new Response('plain', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );

    expect(response.status).toBe(500);
    expect(await errorBody(response)).toMatchObject({ code: 'INTERNAL' });
  });

  it('passes a conforming failure body and refuses an off-schema one by default', async () => {
    const conforming = await healthAnswering(() =>
      Response.json({ code: 'SESSION_NOT_FOUND', message: 'No such session.' }, { status: 404 }),
    );
    expect(conforming.status).toBe(404);

    const offSchema = await healthAnswering(() => Response.json({ nope: 1 }, { status: 404 }));
    expect(offSchema.status).toBe(500);
    expect(await errorBody(offSchema)).toMatchObject({ code: 'INTERNAL' });

    expect(
      (await healthAnswering(() => Response.json({ nope: 1 }, { status: 404 }), 'off')).status,
    ).toBe(404);
  });

  it('reads a failure body at most sixteen kibibytes deep and refuses a larger one', async () => {
    const padded = `${JSON.stringify({ code: 'SESSION_NOT_FOUND', message: 'No such session.' })}${' '.repeat(20 * 1024)}`;

    const response = await healthAnswering(
      () => new Response(padded, { status: 404, headers: { 'content-type': 'application/json' } }),
    );

    expect(response.status).toBe(500);
    expect(await errorBody(response)).toMatchObject({ code: 'INTERNAL' });
  });
});
