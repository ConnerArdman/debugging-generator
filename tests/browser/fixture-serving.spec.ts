/**
 * `fixture-serving` — `serveFixtureApp` on the real path: a real install of the
 * private copy, a real launch through the running service, a real session on
 * the served origin, and a teardown that must leave nothing behind.
 *
 * `tests/browser/fixtures.ts` never adopts a server it did not start (the
 * service could not attribute it to the worker's fresh private copy, see
 * `planFixtureServing`). This file proves both ways the configured origin can
 * look, end to end:
 *
 * - **free** — the copy is served on the configured origin itself by the
 *   service's launcher; a session created for the copy records that origin as
 *   its dev server and ends with cleanup `clean`; teardown reports nothing,
 *   the origin goes quiet and the private boundary is gone;
 * - **occupied by a fixture app this worker did not start** — a `node:http`
 *   stand-in that honours the fixture contract. The copy is served on an
 *   alternate origin of the worker's own, a session there ends `clean`, and
 *   the occupant is still answering afterwards, having received exactly the
 *   two identification requests (`GET /`, `GET /api/ping`) — nothing was
 *   launched against it, stopped, or asked anything else;
 * - **occupied by a foreign server whose answers carry a secret** — the body,
 *   an `x-api-token` header and the `Content-Type` parameters carry a random
 *   token. The worker serves elsewhere as above, and the token appears in no
 *   diagnostic: not in `displaced.description`, not in the stderr notice.
 *
 * Only the `service` worker fixture is requested — never `fixtureApp` (each
 * test drives `serveFixtureApp` itself) and never `pairing`, which cannot run
 * against a service outside the extension's fixed origin. The automatic
 * `_hygiene` fixture still launches the suite's Chromium harness, which these
 * tests do not use. Sessions are created one at a time: two concurrent
 * sessions of one project are a known `partial` cleanup, not this file's
 * subject. Every server and state this file starts is released in `finally`.
 */
import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { expect, serveFixtureApp, test } from './fixtures';
import type { FixtureAppHandle, FixtureAppState, ServiceHandle } from './fixtures';

/** A dependency install into the copy, a cold `next dev` compile and a session round trip, on a loaded host. */
const SERVE_TEST_TIMEOUT_MS = 240_000;

/** Bound on one liveness request this file makes itself. */
const PROBE_TIMEOUT_MS = 5_000;

/** A question in the fixture app's own vocabulary. */
const QUESTION = 'Why does the ping button take so long to show its reply?';

/** One request a stand-in server received. */
interface RecordedRequest {
  readonly method: string;
  readonly url: string;
}

/** A `node:http` stand-in occupying an origin, recording every request it receives. */
interface Occupant {
  readonly origin: string;
  readonly requests: readonly RecordedRequest[];
  close(): Promise<void>;
}

/**
 * Start a stand-in on a free loopback port. `respond` answers each request;
 * every request is recorded before it is answered.
 */
async function startOccupant(
  respond: (url: string) => {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  },
): Promise<Occupant> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const url = request.url ?? '';
    requests.push({ method: request.method ?? '', url });
    const answer = respond(url);
    response.writeHead(answer.status, answer.headers);
    response.end(answer.body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
  };
}

/** A loopback port nothing listens on right now (listen on `0`, read it, close). */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      probe.off('error', reject);
      resolve();
    });
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
  return port;
}

/** Whether anything answers `origin` over HTTP within the bound. */
async function answers(origin: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/', origin), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'manual',
    });
    await response.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

/** `GET /api/ping` on `origin` answers the fixture contract `{ reply: string }`. */
async function expectPingContract(origin: string): Promise<void> {
  const response = await fetch(new URL('/api/ping', origin), {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 6),
  });
  expect(response.status).toBe(200);
  const reply: unknown = await response.json();
  expect(reply).toEqual({ reply: expect.any(String) as unknown });
}

/**
 * One session on the served copy: created, then ended at once. Its recorded
 * dev server must be the origin the worker serves, and its cleanup `clean`.
 */
async function expectCleanSession(service: ServiceHandle, handle: FixtureAppHandle): Promise<void> {
  const session = await service.createSession({
    projectRoot: handle.projectRoot,
    question: QUESTION,
  });
  const ended = await service.endSession(session.id);
  expect(session.projectRoot).toBe(handle.projectRoot);
  expect(new URL(session.devServerUrl).origin).toBe(handle.baseUrl);
  expect(ended).toEqual({ cleanup: 'clean' });
}

/**
 * Release `state` and prove it: no problem reported, the served origin quiet,
 * the private boundary (the copy's parent) gone.
 */
async function expectReleased(state: FixtureAppState): Promise<void> {
  expect(await state.dispose()).toEqual([]);
  expect(await answers(state.handle.baseUrl)).toBe(false);
  await expect(lstat(path.dirname(state.handle.projectRoot))).rejects.toMatchObject({
    code: 'ENOENT',
  });
}

/**
 * The teardown of a test that failed before `expectReleased` ran: release
 * anyway, and record what that found next to the test's own error.
 */
async function releaseAfterFailure(state: FixtureAppState): Promise<void> {
  for (const problem of await state.dispose()) {
    test.info().annotations.push({ type: 'fixture-teardown', description: problem });
  }
}

/** Everything written to this process's stderr while capturing, for "never printed" assertions. */
function captureStderr(): { readonly text: () => string; readonly restore: () => void } {
  const stream = process.stderr;
  // Whatever writer is installed now (Playwright's worker wraps it), bound to
  // the stream, so the spy forwards every write and `restore` reinstates it.
  const previous = stream.write.bind(stream);
  const chunks: string[] = [];
  const spy = (...args: Parameters<typeof previous>): boolean => {
    const [chunk] = args;
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return previous(...args);
  };
  stream.write = spy as typeof stream.write;
  return {
    text: () => chunks.join(''),
    restore: () => {
      stream.write = previous;
    },
  };
}

test.describe('serveFixtureApp', () => {
  test('a free configured origin is served itself, and a session there ends clean', async ({
    service,
  }) => {
    test.setTimeout(SERVE_TEST_TIMEOUT_MS);
    const configured = `http://127.0.0.1:${String(await freePort())}`;
    const state = await serveFixtureApp(service, configured);
    let released = false;
    try {
      const { handle } = state;
      expect(handle.servedBy).toBe('service-launcher');
      expect(handle.startedByFixture).toBe(true);
      expect(handle.baseUrl).toBe(configured);
      expect(handle.configuredUrl).toBe(configured);
      expect(handle.displaced).toBeUndefined();
      await expectPingContract(handle.baseUrl);
      await expectCleanSession(service, handle);
      released = true;
      await expectReleased(state);
    } finally {
      if (!released) {
        await releaseAfterFailure(state);
      }
    }
  });

  test('an origin a fixture app occupies is left untouched, and the copy is served on an alternate origin', async ({
    service,
  }) => {
    test.setTimeout(SERVE_TEST_TIMEOUT_MS);
    const occupant = await startOccupant((url) =>
      url === '/api/ping'
        ? {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reply: 'pong' }),
          }
        : {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: '<!doctype html><title>stand-in</title><p>a fixture app this worker did not start</p>',
          },
    );
    try {
      const state = await serveFixtureApp(service, occupant.origin);
      let released = false;
      try {
        const { handle } = state;
        expect(handle.servedBy).toBe('service-launcher');
        expect(handle.startedByFixture).toBe(true);
        expect(handle.configuredUrl).toBe(occupant.origin);
        expect(handle.baseUrl).not.toBe(occupant.origin);
        expect(new URL(handle.baseUrl).hostname).toBe('127.0.0.1');
        expect(Number(new URL(handle.baseUrl).port)).toBeGreaterThanOrEqual(1024);
        expect(handle.displaced?.occupant).toBe('fixture');
        expect(handle.displaced?.description).toContain('honours the fixture contract');
        await expectPingContract(handle.baseUrl);
        await expectCleanSession(service, handle);
        released = true;
        await expectReleased(state);
      } finally {
        if (!released) {
          await releaseAfterFailure(state);
        }
      }
      // Exactly the two identification requests reached the occupant, before
      // this file's own liveness check below.
      expect([...occupant.requests]).toEqual([
        { method: 'GET', url: '/' },
        { method: 'GET', url: '/api/ping' },
      ]);
      await expectPingContract(occupant.origin);
    } finally {
      await occupant.close();
    }
  });

  test('a foreign occupant whose answers carry a secret is never quoted', async ({ service }) => {
    test.setTimeout(SERVE_TEST_TIMEOUT_MS);
    const token = randomBytes(24).toString('hex');
    expect(token).toHaveLength(48);
    const occupant = await startOccupant((url) => ({
      status: url === '/api/ping' ? 500 : 200,
      headers: {
        'content-type': `text/html; charset=utf-8; token=${token}`,
        'x-api-token': token,
      },
      body: `<!doctype html><p>DEBUG: API_TOKEN=${token}</p>`,
    }));
    try {
      const stderr = captureStderr();
      let state: FixtureAppState | undefined;
      let failure = '';
      try {
        state = await serveFixtureApp(service, occupant.origin);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      } finally {
        stderr.restore();
      }
      const captured = stderr.text();
      expect(failure).not.toContain(token);
      expect(failure).toBe('');
      if (state === undefined) {
        return;
      }
      let released = false;
      try {
        const { handle } = state;
        expect(handle.displaced?.occupant).toBe('foreign');
        expect(handle.displaced?.description).toContain('does not honour the fixture contract');
        expect(handle.displaced?.description).toContain('(text/html)');
        expect(handle.displaced?.description).not.toContain(token);
        expect(handle.baseUrl).not.toBe(occupant.origin);
        // The one displacement notice names both origins, and no secret.
        expect(captured).toContain(`${occupant.origin} (FIXTURE_APP_URL) is occupied`);
        expect(captured).toContain(handle.baseUrl);
        expect(captured).not.toContain(token);
        released = true;
        await expectReleased(state);
      } finally {
        if (!released) {
          await releaseAfterFailure(state);
        }
      }
      expect([...occupant.requests]).toEqual([
        { method: 'GET', url: '/' },
        { method: 'GET', url: '/api/ping' },
      ]);
    } finally {
      await occupant.close();
    }
  });
});
