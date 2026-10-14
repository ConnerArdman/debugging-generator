/**
 * Tests for the DevTools read proof across this package's contract: the header
 * constant and the proof schema in `../http.ts`, the `readProof` the
 * `POST /pair/complete` response carries beside the credential, the
 * `client.hello` payload in `../messages/agent.ts` (which carries none), and
 * the HTTP client that returns the proof from pairing and sends it on reads
 * (`../client/http-client.ts`) — the part of the service's access boundary
 * that admits a DevTools read only from the caller that redeemed the pairing
 * code.
 *
 * Chrome sends a DevTools `GET` without an `Origin`, and an `Origin` is only a
 * claim any local process holding the credential can write. So the service
 * issues a second secret when the pairing code is redeemed, and every DevTools
 * read presents it. What this suite pins, from the contract's side:
 *
 * - **The wire names.** One lowercase header name, distinct from every other
 *   header this package defines, and one proof shape: {@link READ_PROOF_BYTES}
 *   random bytes as {@link READ_PROOF_LENGTH} base64url characters, with no
 *   padding, whitespace, standard-alphabet character or other length admitted.
 * - **Pairing.** The strict `pair.complete` response requires a well-formed
 *   proof beside the token, refuses a missing or malformed one without quoting
 *   it, and {@link HttpClient.pairComplete} returns it exactly as sent.
 * - **The socket.** The strict hello schema refuses a `readProof` key: nothing
 *   sent on a connection can register or replace a proof.
 * - **The HTTP client.** The proof travels as the header on every
 *   authenticated `GET`, and nowhere else: on a write or an auth-exempt
 *   operation, or malformed, it is refused before the credential provider or
 *   the transport is reached. No error or log record carries it.
 *
 * Every proof here is drawn at run time from the platform CSPRNG, so this file
 * holds no high-entropy literal for `scripts/check-secrets.mjs` to flag.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { createConsoleLogger, isOk } from '@debuggen/shared';
import type { DebuggenError, LogRecord, Result } from '@debuggen/shared';

import { HttpClient } from '../client/http-client.js';
import type {
  FetchLike,
  HttpFetchInit,
  HttpPathParams,
  HttpRequestArgs,
  HttpResponseLike,
  TokenProvider,
} from '../client/http-client.js';
import {
  ACTING_TAB_HEADER,
  AUTHORIZATION_HEADER,
  HTTP_OPERATIONS,
  HTTP_ROUTES,
  READ_PROOF_BYTES,
  READ_PROOF_HEADER,
  READ_PROOF_LENGTH,
  isAuthExemptOperation,
  isReadProof,
  pairCompleteResponseSchema,
  readProofSchema,
} from '../http.js';
import type { HttpOperation } from '../http.js';
import * as protocolBarrel from '../index.js';
import { clientHelloPayloadSchema } from '../messages/index.js';
import { PROTOCOL_VERSION } from '../version.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The canonical loopback origin every client below is built on. */
const ORIGIN = 'http://127.0.0.1:43117';

/** A short, readable DevTools credential: not worth a scanner false positive. */
const DEVTOOLS_TOKEN = 'tok-devtools-1';

/** The session every session-scoped route is called for. */
const SESSION_ID = 'ses_4k2p9dq7m1zx0c3v';

/** The panel `panel.getById` is called for. */
const PANEL_ID = 'pan_6h2j8k4l0z5x1c7v';

/** The tab a DevTools call acts for. */
const ACTING_TAB = 4_242;

/**
 * The body every recording transport answers with unless a case says
 * otherwise. The read cases assert on what was sent, or on a local refusal, so
 * any JSON value will do.
 */
const ANY_REPLY_BODY = {};

/**
 * `READ_PROOF_BYTES` fresh CSPRNG bytes as base64url without padding — the
 * shape the service issues at pairing, computed by an encoder independent of
 * the service's own (`btoa` over the binary string, then the RFC 4648 §5
 * alphabet).
 *
 * @param size How many bytes to draw; the proof size unless a case needs a
 * wrong-sized value.
 * @returns The encoded proof.
 */
function newReadProof(size: number = READ_PROOF_BYTES): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(size));
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A proof-length value that is not a proof because one character is outside
 * the base64url alphabet.
 *
 * @param character The foreign character.
 * @returns The value.
 */
function proofWith(character: string): string {
  return `${newReadProof().slice(0, READ_PROOF_LENGTH - 1)}${character}`;
}

/** The operations whose route is a `GET` and which carry a credential. */
const AUTHENTICATED_READS = HTTP_OPERATIONS.filter(
  (operation) => HTTP_ROUTES[operation].method === 'GET' && !isAuthExemptOperation(operation),
);

/** The operations that carry a credential and are not a `GET`. */
const AUTHENTICATED_WRITES = HTTP_OPERATIONS.filter(
  (operation) => HTTP_ROUTES[operation].method !== 'GET' && !isAuthExemptOperation(operation),
);

/** The two operations called without a credential. */
const EXEMPT_OPERATIONS = HTTP_OPERATIONS.filter((operation) => isAuthExemptOperation(operation));

/**
 * The path parameters every operation declares, keyed by operation. The mapped
 * type makes the table exhaustive: an operation added to the route table
 * without an entry here is a compile error.
 */
const PATH_PARAMS: { readonly [O in HttpOperation]: HttpPathParams<O> } = {
  'session.create': {},
  'session.list': {},
  'session.get': { id: SESSION_ID },
  'session.question': { id: SESSION_ID },
  'session.end': { id: SESSION_ID },
  'session.purge': {},
  'capture.start': { id: SESSION_ID },
  'capture.stop': { id: SESSION_ID },
  'target.request': { id: SESSION_ID },
  'panel.data': { id: SESSION_ID },
  'panel.get': { id: SESSION_ID },
  'panel.getById': { id: SESSION_ID, panelId: PANEL_ID },
  'modifications.list': { id: SESSION_ID },
  'telemetry.event': {},
  'devServer.launch': {},
  'devServer.stop': {},
  'devServer.credential': {},
  health: {},
  'pair.start': {},
  'pair.complete': {},
  'credentials.rotate': {},
  'credentials.release': {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Every string reachable from a value through own properties, enumerable or
 * not — an error's message, hint, details and cause chain — joined into one
 * searchable text, so a leak is found whether or not it serialises.
 *
 * @param root The value to walk.
 * @returns Every reachable property name and string value.
 */
function reachableText(root: unknown): string {
  const seen = new Set<object>();
  const parts: string[] = [];

  const visit = (value: unknown, depth: number): void => {
    if (typeof value === 'string') {
      parts.push(value);

      return;
    }

    if (typeof value !== 'object' || value === null || depth > 10 || seen.has(value)) {
      return;
    }

    seen.add(value);

    for (const key of Object.getOwnPropertyNames(value)) {
      parts.push(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const member: unknown =
        descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;

      visit(member, depth + 1);
    }
  };

  visit(root, 0);

  return parts.join('\n');
}

/**
 * The failure a result carries, failing the case when it succeeded.
 *
 * @param result The result.
 * @returns Its error.
 */
function failureOf<T>(result: Result<T, DebuggenError>): DebuggenError {
  if (isOk(result)) {
    return expect.unreachable('expected a failure');
  }

  return result.error;
}

/** A logger that keeps every record, and the records it kept. */
function recordingLogger(): {
  readonly logger: ReturnType<typeof createConsoleLogger>;
  readonly records: LogRecord[];
} {
  const records: LogRecord[] = [];
  const logger = createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      records.push(record);
    },
  });

  return { logger, records };
}

/**
 * An HTTP response answering a call.
 *
 * @param status The status.
 * @param body The JSON body; {@link ANY_REPLY_BODY} unless given.
 * @returns The response.
 */
function reply(status: number, body: unknown = ANY_REPLY_BODY): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

/** A DevTools-credentialled HTTP client over a recording transport. */
function devtoolsHttpClient(): {
  readonly client: HttpClient;
  readonly fetch: Mock<FetchLike>;
  readonly token: Mock<TokenProvider>;
  readonly records: LogRecord[];
} {
  const fetch = vi.fn<FetchLike>(() => Promise.resolve(reply(404)));
  const token = vi.fn<TokenProvider>(() => DEVTOOLS_TOKEN);
  const { logger, records } = recordingLogger();
  const client = new HttpClient({ baseUrl: ORIGIN, token, fetch, logger, defaultTimeoutMs: 1_000 });

  return { client, fetch, token, records };
}

/**
 * The arguments of one operation's call with a proof, and nothing else that
 * the route does not need. Bodies are omitted: every case here either reaches
 * a `GET` (which has none) or is refused before the body is examined.
 *
 * @param operation The operation.
 * @param readProof The proof to pass.
 * @returns The arguments.
 */
function argsWithProof<O extends HttpOperation>(
  operation: O,
  readProof: string,
): HttpRequestArgs<O> {
  // The read proof is refused before the body is validated, so a body-less
  // call is a faithful probe for every operation, write or read.
  return { params: PATH_PARAMS[operation], readProof };
}

/**
 * The single call a recording transport received.
 *
 * @param fetch The spy.
 * @returns The URL and the init it was called with.
 */
function onlyCall(fetch: Mock<FetchLike>): {
  readonly url: string;
  readonly init: HttpFetchInit;
  readonly headers: Readonly<Record<string, string>>;
} {
  expect(fetch).toHaveBeenCalledTimes(1);
  const call = fetch.mock.calls[0];
  const init = call?.[1];

  if (call === undefined || init?.headers === undefined) {
    return expect.unreachable('the transport was not called with headers');
  }

  return { url: call[0], init, headers: init.headers };
}

// ---------------------------------------------------------------------------
// The wire names
// ---------------------------------------------------------------------------

describe('the read-proof header and shape', () => {
  it('names one lowercase header, distinct from every other header this package defines', () => {
    expect(READ_PROOF_HEADER).toBe('x-debuggen-read-proof');
    expect(READ_PROOF_HEADER).toBe(READ_PROOF_HEADER.toLowerCase());
    expect(READ_PROOF_HEADER).not.toBe(ACTING_TAB_HEADER);
    expect(READ_PROOF_HEADER).not.toBe(AUTHORIZATION_HEADER);
  });

  it('is exported, unchanged, by the package barrel every consumer imports', () => {
    expect(protocolBarrel.READ_PROOF_HEADER).toBe(READ_PROOF_HEADER);
    expect(protocolBarrel.READ_PROOF_BYTES).toBe(READ_PROOF_BYTES);
    expect(protocolBarrel.READ_PROOF_LENGTH).toBe(READ_PROOF_LENGTH);
    expect(protocolBarrel.readProofSchema).toBe(readProofSchema);
    expect(protocolBarrel.isReadProof).toBe(isReadProof);
  });

  it('is 32 random bytes as 43 base64url characters without padding', () => {
    expect(READ_PROOF_BYTES).toBe(32);
    expect(READ_PROOF_LENGTH).toBe(Math.ceil((READ_PROOF_BYTES * 4) / 3));
    expect(newReadProof()).toHaveLength(READ_PROOF_LENGTH);
  });

  it('accepts every freshly minted proof', () => {
    for (let draw = 0; draw < 256; draw += 1) {
      const proof = newReadProof();

      expect(isReadProof(proof)).toBe(true);
      expect(readProofSchema.safeParse(proof).success).toBe(true);
    }
  });

  it.each([
    ['one character short', () => newReadProof().slice(0, READ_PROOF_LENGTH - 1)],
    ['one character long', () => `${newReadProof()}A`],
    ['padded as standard base64 pads', () => `${newReadProof().slice(0, READ_PROOF_LENGTH - 1)}=`],
    ['padded after full length', () => `${newReadProof()}=`],
    ["carrying the standard alphabet's '+'", () => proofWith('+')],
    ["carrying the standard alphabet's '/'", () => proofWith('/')],
    ['with a leading space', () => ` ${newReadProof().slice(1)}`],
    ['with a trailing newline', () => `${newReadProof().slice(1)}\n`],
    ['surrounded by whitespace', () => ` ${newReadProof()} `],
    ['carrying a non-ASCII letter', () => proofWith('é')],
    ['a proof of 24 bytes', () => newReadProof(24)],
    ['a proof of 48 bytes', () => newReadProof(48)],
    ['empty', () => ''],
  ])('refuses a value %s', (_label, make) => {
    const value = make();
    const parsed = readProofSchema.safeParse(value);

    expect(isReadProof(value)).toBe(false);
    expect(parsed.success).toBe(false);

    if (!parsed.success && value.trim().length > 0) {
      expect(reachableText(parsed.error.issues)).not.toContain(value.trim());
    }
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 43],
    ['an array', ['A'.repeat(READ_PROOF_LENGTH)]],
    ['an object', { proof: 'A'.repeat(READ_PROOF_LENGTH) }],
  ])('refuses %s', (_label, value) => {
    expect(isReadProof(value)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pairing: where the proof comes from
// ---------------------------------------------------------------------------

describe('the pair.complete response and the read proof', () => {
  it('carries the credential and the read proof issued with it, and keeps both as sent', () => {
    const readProof = newReadProof();
    const parsed = pairCompleteResponseSchema.safeParse({ token: DEVTOOLS_TOKEN, readProof });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ token: DEVTOOLS_TOKEN, readProof });
  });

  it('refuses a response without a read proof, so no client keeps a credential it cannot read with', () => {
    const parsed = pairCompleteResponseSchema.safeParse({ token: DEVTOOLS_TOKEN });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['readProof']);
  });

  it.each([
    ['from the standard alphabet', () => proofWith('/')],
    ['padded', () => `${newReadProof()}=`],
    ['whitespace-padded', () => ` ${newReadProof()} `],
    ['short', () => newReadProof(24)],
  ])('refuses a read proof %s without quoting it in the issues', (_label, make) => {
    const malformed = make();
    const parsed = pairCompleteResponseSchema.safeParse({
      token: DEVTOOLS_TOKEN,
      readProof: malformed,
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['readProof']);
    expect(reachableText(parsed.error?.issues)).not.toContain(malformed.trim());
  });

  it('refuses a misspelled key rather than dropping it', () => {
    const parsed = pairCompleteResponseSchema.safeParse({
      token: DEVTOOLS_TOKEN,
      readProof: newReadProof(),
      readproof: newReadProof(),
    });

    expect(parsed.success).toBe(false);
  });

  it('is returned by HttpClient.pairComplete exactly as the service sent it, and logged nowhere', async () => {
    const readProof = newReadProof();
    const { client, fetch, token, records } = devtoolsHttpClient();
    fetch.mockImplementation(() =>
      Promise.resolve(reply(200, { token: DEVTOOLS_TOKEN, readProof })),
    );

    const result = await client.pairComplete('ABCD2345');

    expect(isOk(result)).toBe(true);
    expect(isOk(result) ? result.value : undefined).toEqual({ token: DEVTOOLS_TOKEN, readProof });
    expect(token).not.toHaveBeenCalled();
    expect(READ_PROOF_HEADER in onlyCall(fetch).headers).toBe(false);
    expect(JSON.stringify(records)).not.toContain(readProof);
    expect(reachableText(records)).not.toContain(readProof);
  });

  it('turns a pairing reply without a proof into a failure that quotes neither secret', async () => {
    const { client, fetch, records } = devtoolsHttpClient();
    fetch.mockImplementation(() => Promise.resolve(reply(200, { token: DEVTOOLS_TOKEN })));

    const error = failureOf(await client.pairComplete('ABCD2345'));

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(reachableText(error)).not.toContain(DEVTOOLS_TOKEN);
    expect(JSON.stringify(records)).not.toContain(DEVTOOLS_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// The socket carries no proof
// ---------------------------------------------------------------------------

describe('client.hello and the read proof', () => {
  const baseHello = {
    client: 'devtools',
    version: PROTOCOL_VERSION,
    token: DEVTOOLS_TOKEN,
  } as const;

  it('accepts a DevTools hello with no proof', () => {
    expect(clientHelloPayloadSchema.safeParse(baseHello).success).toBe(true);
  });

  it('refuses a hello carrying readProof: nothing sent on a socket registers or replaces a proof', () => {
    const readProof = newReadProof();
    const parsed = clientHelloPayloadSchema.safeParse({ ...baseHello, readProof });

    expect(parsed.success).toBe(false);
    expect(reachableText(parsed.error?.issues)).not.toContain(readProof);
  });
});

// ---------------------------------------------------------------------------
// The HTTP client
// ---------------------------------------------------------------------------

describe('HttpClient and the read proof', () => {
  it('knows the authenticated reads it may send a proof on', () => {
    expect(AUTHENTICATED_READS).toEqual([
      'session.list',
      'session.get',
      'panel.get',
      'panel.getById',
      'modifications.list',
    ]);
    expect(EXEMPT_OPERATIONS).toEqual(['health', 'pair.complete']);
  });

  it.each(AUTHENTICATED_READS)(
    'sends the proof as the header on %s, exactly as given',
    async (operation) => {
      const proof = newReadProof();
      const { client, fetch, records } = devtoolsHttpClient();

      await client.request(operation, argsWithProof(operation, proof));

      const { init, headers } = onlyCall(fetch);

      expect(init.method).toBe('GET');
      expect(headers[READ_PROOF_HEADER]).toBe(proof);
      expect(headers[AUTHORIZATION_HEADER]).toBe(`Bearer ${DEVTOOLS_TOKEN}`);
      expect(Object.keys(headers).sort()).toEqual(
        ['accept', AUTHORIZATION_HEADER, READ_PROOF_HEADER].sort(),
      );
      expect(JSON.stringify(records)).not.toContain(proof);
    },
  );

  it('sends the proof beside the acting-tab header when a call acts for a tab', async () => {
    const proof = newReadProof();
    const { client, fetch } = devtoolsHttpClient();

    await client.request('session.get', {
      params: { id: SESSION_ID },
      tabId: ACTING_TAB,
      readProof: proof,
    });

    const { headers } = onlyCall(fetch);

    expect(headers[READ_PROOF_HEADER]).toBe(proof);
    expect(headers[ACTING_TAB_HEADER]).toBe(String(ACTING_TAB));
  });

  it('sends no proof header when the call passes none, or passes undefined', async () => {
    const { client, fetch } = devtoolsHttpClient();

    await client.request('session.get', { params: { id: SESSION_ID } });
    await client.request('session.get', { params: { id: SESSION_ID }, readProof: undefined });

    expect(fetch).toHaveBeenCalledTimes(2);

    for (const [, init] of fetch.mock.calls) {
      expect(init?.headers).toBeDefined();
      expect(READ_PROOF_HEADER in (init?.headers ?? {})).toBe(false);
    }
  });

  it.each(AUTHENTICATED_WRITES)(
    'refuses a proof on %s locally, before the credential or the transport',
    async (operation) => {
      const proof = newReadProof();
      const { client, fetch, token, records } = devtoolsHttpClient();

      const error = failureOf(await client.request(operation, argsWithProof(operation, proof)));

      expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(error.message).toBe(
        `Cannot call ${operation}: a read proof was given for a request that is not a read`,
      );
      expect(error.details).toEqual({ operation, header: READ_PROOF_HEADER });
      expect(fetch).not.toHaveBeenCalled();
      expect(token).not.toHaveBeenCalled();
      expect(reachableText(error)).not.toContain(proof);
      expect(JSON.stringify(records)).not.toContain(proof);
    },
  );

  it.each(EXEMPT_OPERATIONS)(
    'refuses a proof on the auth-exempt %s locally, before anything is sent',
    async (operation) => {
      const proof = newReadProof();
      const { client, fetch, token } = devtoolsHttpClient();

      const error = failureOf(await client.request(operation, argsWithProof(operation, proof)));

      expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(error.message).toBe(
        `Cannot call ${operation}: a read proof was given for an operation that carries no credential`,
      );
      expect(error.details).toEqual({ operation, header: READ_PROOF_HEADER });
      expect(fetch).not.toHaveBeenCalled();
      expect(token).not.toHaveBeenCalled();
      expect(reachableText(error)).not.toContain(proof);
    },
  );

  it.each([
    ['from the standard alphabet', () => proofWith('+')],
    ['with padding', () => `${newReadProof()}=`],
    ['whitespace-padded', () => ` ${newReadProof()} `],
    ['short', () => newReadProof(24)],
    ['empty', () => ''],
  ])('refuses a malformed proof %s on a read, before anything is sent', async (_label, make) => {
    const malformed = make();
    const { client, fetch, token, records } = devtoolsHttpClient();

    const error = failureOf(
      await client.request('session.get', { params: { id: SESSION_ID }, readProof: malformed }),
    );

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(error.message).toBe(
      'Cannot call session.get: readProof is not a well-formed read proof',
    );
    expect(error.details).toEqual({ operation: 'session.get', header: READ_PROOF_HEADER });
    expect(fetch).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();

    if (malformed.trim().length > 0) {
      expect(reachableText(error)).not.toContain(malformed.trim());
      expect(JSON.stringify(records)).not.toContain(malformed.trim());
    }
  });

  it('keeps a refused-proof answer as the UNAUTHORIZED the service sent, and never quotes the proof', async () => {
    const proof = newReadProof();
    const { client, fetch, records } = devtoolsHttpClient();
    fetch.mockImplementation(() =>
      Promise.resolve(
        reply(401, {
          code: 'UNAUTHORIZED',
          message:
            'This DevTools read carried a read proof other than the one issued with its credential.',
        }),
      ),
    );

    const error = failureOf(
      await client.request('session.get', { params: { id: SESSION_ID }, readProof: proof }),
    );

    expect(error.code).toBe('UNAUTHORIZED');
    expect(reachableText(error)).not.toContain(proof);
    expect(JSON.stringify(records)).not.toContain(proof);
  });
});
