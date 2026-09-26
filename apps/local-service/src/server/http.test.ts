/**
 * Tests for `./http.ts`'s error boundary: a `DebuggenError` thrown while a
 * request is answered reaches a `4xx` body with its own message only when that
 * message is proven product text, and the body's `ref` names the boundary's
 * local records — the closed `warn` record and, at `debug`, the redacted
 * diagnostic twin (CWE-209, CWE-532).
 *
 * Every collaborator the application reaches while answering is a stand-in
 * that throws one chosen `DebuggenError`, so the failure arrives at
 * `app.onError` exactly as a collaborator's thrown error would.
 */

import { describe, expect, it } from 'vitest';

import { DebuggenError, newSessionId } from '@debuggen/shared';

import type { ServiceConfig } from '../config.js';
import { createServiceLogger } from '../logging.js';
import { FAILURE_COPY_BY_CODE, authorProductText } from '../sessions/progress.js';
import { createHttpApp, type HttpAppDeps } from './http.js';

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
const DEBUG_LEVEL = 20;

/** The private text a collaborator's error carries: a URL query value and an SQL literal. */
const SENTINEL = 'zz-boundary-private';

interface Harness {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly records: () => Record<string, unknown>[];
}

/**
 * The application over stand-in collaborators: every dependency this test
 * does not supply is an object whose every method throws `thrown`.
 */
function harness(thrown: DebuggenError, logLevel: ServiceConfig['logLevel']): Harness {
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
  };
  const deps = new Proxy(own, {
    get: (target, key) => (typeof key === 'string' && key in target ? target[key] : throwing),
  }) as unknown as HttpAppDeps;

  const app = createHttpApp(deps);
  if (!app.ok) {
    throw new Error(`the HTTP application did not assemble: ${app.error.code}`);
  }
  return {
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
