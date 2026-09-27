/**
 * Unit tests for the revocation fence of `./pair.ts`'s `POST /pair/start`
 * route, and for `POST /pair/complete` staying outside it.
 *
 * `pair.start` mints a pairing code on the authority of the editor credential
 * the auth middleware resolved when the request arrived. Reading the body
 * awaits the client, and a credential retired inside that gap — by a rotation,
 * a revocation or an expiry — must not mint a code. The handler therefore asks
 * `requireLiveCredential` once the body is read and immediately before
 * `startPairing`; these tests pin that it does so exactly once, with the
 * resolved principal, before the code is minted and never while the body is
 * still arriving, and that every verdict other than "live" mints nothing: a
 * refusal is answered `401` in `../auth.ts`'s own words, and a fence that
 * cannot give a verdict — a store failure or a throw — fails closed with a
 * fixed `500` that carries neither the store's words nor the thrown text.
 *
 * `pair.complete` is auth-exempt: no principal exists for it, so it must never
 * consult the fence.
 *
 * Each handler is driven in-process through a hono app whose only middleware
 * stands in for `../auth.ts`'s, setting the principal it would have resolved
 * (or none, for the exempt route). The access boundary is a set of fakes and
 * the logger keeps every record. No HTTP server and no socket is opened.
 */

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { HTTP_ROUTES, buildPath } from '@debuggen/protocol';
import { DebuggenError, err, ok } from '@debuggen/shared';
import type { LogFields, Logger } from '@debuggen/shared';

import { AUTH_FAILURE_REASONS } from '../auth.js';
import type { AuthFailureReason, AuthService, EditorPrincipal, ServerEnv } from '../auth.js';

import { createPairRoutes } from './pair.js';
import type { PairRouteHandlers } from './pair.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/** When the editor credential was issued, in epoch milliseconds. */
const ISSUED_AT = 1_768_000_000_000;

/** The code the fake access boundary mints: eight characters, like the real generator's. */
const PAIRING_CODE = 'ABCD2345';

/** When {@link PAIRING_CODE} stops being accepted. */
const PAIRING_EXPIRES_AT = ISSUED_AT + 300_000;

/** The DevTools credential and read proof the fake redemption issues. */
const ISSUED_TOKEN = 't'.repeat(43);
const ISSUED_READ_PROOF = 'r'.repeat(43);

/** The `chrome-extension://<id>` origin a redemption is presented from. */
const EXTENSION_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;

/** The URLs every request of these tests is sent to, built from protocol's table. */
const PAIR_START_URL = `http://127.0.0.1${buildPath('pair.start')}`;
const PAIR_COMPLETE_URL = `http://127.0.0.1${buildPath('pair.complete')}`;

/** The fixed sentence every `pair.start` `500` opens with (see `./pair.ts`). */
const START_UNAVAILABLE_WORDS = 'could not issue a pairing code';

/** The error payload every failed request answers with. */
interface ErrorPayload {
  readonly code: string;
  readonly message: string;
}

/** One captured log record. */
interface Entry {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields;
}

/** A logger that keeps every record it is handed, its children included. */
function capturingLogger(entries: Entry[]): Logger {
  const record =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields: fields ?? {} });
    };
  const logger: Logger = {
    level: 'trace',
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    child: () => logger,
  };
  return logger;
}

/** The principal `../auth.ts`'s middleware resolved from the editor credential. */
function editorPrincipal(): EditorPrincipal {
  return {
    role: 'vscode',
    tokenHash: 'e'.repeat(64),
    scope: { kind: 'machine-user', workspaceFolders: [] },
    issuedAt: ISSUED_AT,
  };
}

/** The refusal `../auth.ts`'s fence returns for `reason`, from its own table. */
function fenceRefusal(reason: AuthFailureReason): DebuggenError {
  const descriptor = AUTH_FAILURE_REASONS[reason];
  return new DebuggenError(descriptor.code, descriptor.message, { details: { reason } });
}

/**
 * The two handlers over a fake access boundary and a capturing logger. The
 * fence answers as `fence` does; `startPairing` and `completePairing` always
 * succeed, so a test's verdict is the fence's alone.
 */
function harness(fence: AuthService['requireLiveCredential'] = () => ok(undefined)) {
  const entries: Entry[] = [];
  const startPairing = vi.fn<AuthService['startPairing']>(() =>
    ok({ code: PAIRING_CODE, expiresAt: PAIRING_EXPIRES_AT }),
  );
  const completePairing = vi.fn<AuthService['completePairing']>(() =>
    ok({ token: ISSUED_TOKEN, readProof: ISSUED_READ_PROOF }),
  );
  const requireLiveCredential = vi.fn<AuthService['requireLiveCredential']>(fence);
  const routes = createPairRoutes({
    auth: { startPairing, completePairing, requireLiveCredential },
    logger: capturingLogger(entries),
  });
  return { routes, entries, startPairing, completePairing, requireLiveCredential };
}

/**
 * Both pairing routes behind a stand-in for the auth middleware. It sets
 * `principal` for `pair.start` only: the middleware resolves none for the
 * exempt `pair.complete`, so none is ever placed on its context.
 */
function pairApp(routes: PairRouteHandlers, principal: EditorPrincipal): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();
  app.use(HTTP_ROUTES['pair.start'].pattern, async (c, next) => {
    c.set('principal', principal);
    await next();
  });
  app.post(HTTP_ROUTES['pair.start'].pattern, routes['pair.start']);
  app.post(HTTP_ROUTES['pair.complete'].pattern, routes['pair.complete']);
  return app;
}

/** A `pair.start` request carrying its whole (empty-object) body at once. */
function startRequest(): Request {
  return new Request(PAIR_START_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

/**
 * A request body the test sends by hand: the handler awaits it for as long as
 * the test holds it back, like an editor that has not finished sending.
 */
interface HeldBody {
  readonly stream: ReadableStream<Uint8Array>;
  /**
   * Whether every chunk sent so far has left the stream's queue — taken by
   * the one reader, the handler's body read. The queue holds one chunk
   * (`highWaterMark: 1`), so a sent chunk not yet read leaves no room.
   */
  drained(): boolean;
  send(text: string): void;
  end(): void;
}

/** Builds a {@link HeldBody}. */
function heldBody(): HeldBody {
  let held: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        held = controller;
      },
    },
    { highWaterMark: 1 },
  );
  const controller = (): ReadableStreamDefaultController<Uint8Array> => {
    if (held === undefined) {
      throw new Error('The held body stream did not start.');
    }
    return held;
  };
  return {
    stream,
    drained: () => (controller().desiredSize ?? 0) > 0,
    send: (text) => {
      controller().enqueue(new TextEncoder().encode(text));
    },
    end: () => {
      controller().close();
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * POST /pair/start — the revocation fence
 * ---------------------------------------------------------------------------------------------- */

describe('POST /pair/start — the revocation fence', () => {
  it('mints a code once, after confirming the resolved credential is still live', async () => {
    const h = harness();
    const principal = editorPrincipal();

    const response = await pairApp(h.routes, principal).fetch(startRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ code: PAIRING_CODE, expiresAt: PAIRING_EXPIRES_AT });
    expect(h.requireLiveCredential).toHaveBeenCalledTimes(1);
    expect(
      h.requireLiveCredential.mock.calls[0]?.[0],
      'the fence judges the resolved principal',
    ).toBe(principal);
    expect(h.startPairing).toHaveBeenCalledTimes(1);
    const [fencedAt] = h.requireLiveCredential.mock.invocationCallOrder;
    const [mintedAt] = h.startPairing.mock.invocationCallOrder;
    expect(fencedAt, 'the fence runs before the code is minted').toBeLessThan(
      mintedAt ?? Number.NEGATIVE_INFINITY,
    );
  });

  it.each(['unknown-credential', 'expired-credential', 'corrupt-credential'] as const)(
    'answers 401 and mints nothing when the fence refuses the credential (%s)',
    async (reason) => {
      const h = harness(() => err(fenceRefusal(reason)));

      const response = await pairApp(h.routes, editorPrincipal()).fetch(startRequest());

      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const payload = (await response.json()) as ErrorPayload;
      expect(payload.code).toBe('UNAUTHORIZED');
      expect(payload.message).toBe(AUTH_FAILURE_REASONS[reason].message);
      expect(h.requireLiveCredential).toHaveBeenCalledTimes(1);
      expect(h.startPairing, 'a retired credential mints no code').not.toHaveBeenCalled();
    },
  );

  it('answers a fixed 500 and mints nothing when the fence cannot read the store', async () => {
    const storeWords = 'SQLITE_BUSY: database is locked';
    const h = harness(() => err(new DebuggenError('STORE_ERROR', storeWords)));

    const response = await pairApp(h.routes, editorPrincipal()).fetch(startRequest());

    expect(response.status).toBe(500);
    const payload = (await response.json()) as ErrorPayload;
    expect(payload.code).toBe('STORE_ERROR');
    expect(payload.message).toContain(START_UNAVAILABLE_WORDS);
    expect(payload.message, 'the store’s own words never reach the editor').not.toContain(
      'SQLITE_BUSY',
    );
    expect(h.startPairing).not.toHaveBeenCalled();
  });

  it('fails closed with a 500 INTERNAL and mints nothing when the fence throws', async () => {
    const thrownWords = 'fence defect near tok_should_never_leak';
    const h = harness(() => {
      throw new Error(thrownWords);
    });

    const response = await pairApp(h.routes, editorPrincipal()).fetch(startRequest());

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text, 'the thrown value is never answered').not.toContain('tok_should_never_leak');
    const payload = JSON.parse(text) as ErrorPayload;
    expect(payload.code).toBe('INTERNAL');
    expect(payload.message).toContain(START_UNAVAILABLE_WORDS);
    expect(h.requireLiveCredential).toHaveBeenCalledTimes(1);
    expect(h.startPairing).not.toHaveBeenCalled();
    const failures = h.entries.filter((entry) => entry.level === 'error');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.fields).toMatchObject({ operation: 'pair.start', errorCode: 'INTERNAL' });
    expect(JSON.stringify(h.entries), 'the thrown value is never logged').not.toContain(
      'tok_should_never_leak',
    );
  });

  it('judges the credential only once its body has arrived, so one retired meanwhile mints nothing', async () => {
    let retired = false;
    const h = harness(() => (retired ? err(fenceRefusal('unknown-credential')) : ok(undefined)));
    const principal = editorPrincipal();
    const body = heldBody();

    const pending = pairApp(h.routes, principal).fetch(
      new Request(PAIR_START_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body.stream,
        duplex: 'half',
      }),
    );

    // Half the body, taken by the handler's read, which now waits on the editor.
    body.send('{');
    await vi.waitFor(() => {
      expect(body.drained(), 'the handler has read the first half').toBe(true);
    });
    expect(
      h.requireLiveCredential,
      'no verdict is taken while the body is arriving',
    ).not.toHaveBeenCalled();
    expect(h.startPairing).not.toHaveBeenCalled();

    // The credential is retired — a rotation, a revocation or an expiry —
    // while the editor holds the rest of its body back.
    retired = true;
    body.send('}');
    body.end();
    const response = await pending;

    expect(response.status).toBe(401);
    expect(((await response.json()) as ErrorPayload).code).toBe('UNAUTHORIZED');
    expect(h.requireLiveCredential).toHaveBeenCalledTimes(1);
    expect(
      h.requireLiveCredential.mock.calls[0]?.[0],
      'the fence judges the resolved principal',
    ).toBe(principal);
    expect(h.startPairing, 'a retired credential mints no code').not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------------------------------
 * POST /pair/complete — outside the fence
 * ---------------------------------------------------------------------------------------------- */

describe('POST /pair/complete — outside the fence', () => {
  it('redeems a code without a principal and never consults the fence', async () => {
    // A fence that refuses everything: were the exempt route to consult it,
    // the redemption below would be refused.
    const h = harness(() => err(fenceRefusal('unknown-credential')));

    const response = await pairApp(h.routes, editorPrincipal()).fetch(
      new Request(PAIR_COMPLETE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
        body: JSON.stringify({ code: PAIRING_CODE }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ token: ISSUED_TOKEN, readProof: ISSUED_READ_PROOF });
    expect(
      h.requireLiveCredential,
      'the exempt route has no credential to fence',
    ).not.toHaveBeenCalled();
    expect(h.completePairing).toHaveBeenCalledTimes(1);
    expect(h.completePairing).toHaveBeenCalledWith({
      code: PAIRING_CODE,
      origin: EXTENSION_ORIGIN,
    });
    expect(h.startPairing).not.toHaveBeenCalled();
  });
});
