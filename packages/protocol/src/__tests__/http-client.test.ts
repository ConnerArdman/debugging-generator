/**
 * Tests for `../client/http-client.ts`, the HTTP half of this package's
 * transport SDK, in the directory `packages/protocol/tsconfig.json` names for
 * this package's suites.
 *
 * What is on trial is the **client**, not the route table: `./http.test.ts`
 * already pins every route, schema and exemption. Here a fake `fetch` — a
 * `vi.fn` answering `{ ok, status, text }` — and fake credential providers drive
 * a real `HttpClient`, and every assertion is about what that client sends, to
 * whom, with which credential, and what it hands back when anything goes wrong.
 *
 * The cases group into what can actually go wrong:
 *
 * - **Where a credential may go.** `parseServiceOrigin` is the one host policy
 *   both transports share. Every loopback spelling it accepts is checked for its
 *   canonical output, and every rule it enforces is checked for its refusal. A
 *   client built on a refused base URL — a public name, a private or unspecified
 *   address, a look-alike host, embedded credentials, a path, a query, a
 *   fragment — must still construct, and every one of the twenty-one operations
 *   must then fail locally: the transport is never called, the credential
 *   provider is never asked, no `authorization` header exists, and the raw value
 *   (seeded with a unique marker) appears nowhere, because it may carry a pasted
 *   credential (CWE-200, CWE-918).
 * - **The credential itself.** Sixteen operations carry
 *   `authorization: Bearer <token>`; `health` and `pair.complete` never do, even
 *   when a credential is configured. A credential may be a string,
 *   a synchronous or asynchronous provider, may throw, reject or be absent, and
 *   may be rotated between calls — each of those has a case.
 * - **What goes on the wire.** Method and URL come from `HTTP_ROUTES` and
 *   `buildPath`; headers are exactly `accept`, `content-type` with a body, the
 *   credential, and `x-debuggen-tab` only when the call acts for a tab;
 *   `credentials: 'omit'` always; no `origin`, `cookie` or `access-control-*`
 *   header ever. A missing path parameter or a body the route's schema refuses
 *   fails before anything is sent.
 * - **The acting tab.** One paired DevTools credential serves every inspected
 *   tab, so a call's `tabId` becomes the acting-tab header by which the service
 *   scopes a DevTools request — through `request` and through a named method's
 *   options alike. No `tabId`, no header; a `tabId` that is not a tab
 *   id, or one given for an auth-exempt operation, fails locally with neither
 *   the credential provider nor the transport reached.
 * - **What comes back.** A valid reply parses; invalid JSON, a schema-violating
 *   reply and an empty body are protocol failures; a non-2xx keeps the service's
 *   code, except that `401`/`403` stay in the unauthorized family (a `403`
 *   scope refusal of an accepted credential — `TAB_NOT_BOUND`,
 *   `PATH_OUTSIDE_PROJECT` — keeps its code); `429`, `5xx`
 *   and unconformant bodies map by status; a `409` on `capture.start` names the
 *   owning session; a transport that throws, rejects or fails mid-body is
 *   `TRANSPORT_DISCONNECTED`.
 * - **Cancellation (R1-F07).** Under fake timers: a credential provider that
 *   never settles ends at the timeout, and its late credential never reaches the
 *   transport; a caller abort before or during credential resolution, during the
 *   request or during the body read ends the call with `details.cancelled`; a
 *   timeout aborts the signal the transport was given; and after every call no
 *   timer and no listener is left behind.
 * - **Never rejects, never leaks.** Every call resolves to a `Result`, and
 *   neither an error's message, hint, details and cause chain nor a log record
 *   carries a credential, a request or response body value, a pairing code or
 *   the raw configured URL.
 *
 * `scripts/check-secrets.mjs` scans this tracked file like any other, so the
 * credentials below are short, low-entropy literals, and every URL with user
 * information is assembled at run time from fragments rather than written out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DebuggenError, isErr, isOk } from '@debuggen/shared';
import type { LogFields, LogLevel, Logger, Result } from '@debuggen/shared';
import type { TelemetryEventIngress } from '@debuggen/telemetry';

import { HttpClient, parseServiceOrigin } from '../client/http-client.js';
import type {
  FetchLike,
  HttpFetchInit,
  HttpPathParams,
  HttpRequestArgs,
  HttpResponseLike,
  ServiceOriginRule,
  TokenProvider,
} from '../client/http-client.js';
import {
  ACTING_TAB_HEADER,
  AUTHORIZATION_HEADER,
  CAPTURE_CONFLICT_ERROR_CODE,
  HTTP_OPERATIONS,
  HTTP_ROUTES,
  READ_PROOF_LENGTH,
  WS_PATH,
  buildPath,
  formatBearer,
  isAuthExemptOperation,
} from '../http.js';
import type { HttpOperation, HttpRequestBody } from '../http.js';

// ---------------------------------------------------------------------------
// Fixtures
//
// Ids follow the product's `<prefix>_<sixteen alphanumerics>` shape, as in
// `./http.test.ts`. Credentials are deliberately short and readable: a test
// credential is not worth a secrets-scanner false positive.
// ---------------------------------------------------------------------------

/** The canonical loopback origin every accepting client below is built on. */
const ORIGIN = 'http://127.0.0.1:43117';

/** The editor credential most cases present. */
const EDITOR_TOKEN = 'tok-editor-1';

/** The credential a rotation replaces it with. */
const ROTATED_TOKEN = 'tok-editor-2';

/**
 * A unique string seeded into every value that must never be echoed — a
 * refused base URL, a request body, a response body — so its absence from an
 * error or a log record is a precise assertion rather than a guess.
 */
const MARKER = 'zq9leakmarker';

/** A one-time pairing code, which is a capability and must never be echoed. */
const PAIRING_CODE = 'PAIR2X7Q';

/** The session every session-scoped route is called for. */
const SESSION_ID = 'ses_4k2p9dq7m1zx0c3v';

/** The session a capture-ownership conflict names. */
const OWNING_SESSION_ID = 'ses_9m3q7w1e5r2t8y4u';

/** The panel `panel.getById` is called for. */
const PANEL_ID = 'pan_6h2j8k4l0z5x1c7v';

/** The capture window `capture.start` answers with. */
const CAPTURE_ID = 'cap_7f3q0m2zk1x8ab9c';

/** The developer's workspace folder. */
const PROJECT_ROOT = '/home/example/workspace/site';

/** A fixed point in time, so no assertion depends on the clock. */
const START_TIME = 1_758_000_000_000;

/** One event as a producer sends it, for the `telemetry.event` body. */
const INGRESS_EVENT: TelemetryEventIngress = {
  id: 'evt_1a2b3c4d5e6f7g8h',
  traceId: '3f2a'.repeat(8),
  spanId: '1b2c3d4e5f60718a',
  kind: 'interaction',
  name: 'click primary action',
  startTime: START_TIME,
  duration: 12.5,
  tier: 'browser',
  attributes: { 'event.type': 'click' },
  status: 'ok',
  producerId: 'prd_8x4c2v6b0n1m5q3w',
  seq: 0,
};

/**
 * A valid request body for every operation, keyed by operation.
 *
 * The mapped type makes the table exhaustive: an operation added to the route
 * table without a body here is a compile error. The `GET` routes hold
 * `undefined`, which is their body type.
 */
const VALID_REQUESTS: { readonly [O in HttpOperation]: HttpRequestBody<O> } = {
  'session.create': { projectRoot: PROJECT_ROOT, question: 'Why does this action take so long?' },
  'session.list': undefined,
  'session.get': undefined,
  'session.question': { question: 'Why did that step run twice?' },
  'session.end': {},
  'session.purge': {},
  'capture.start': {},
  'capture.stop': {},
  'target.request': {},
  'panel.data': { source: 'spans', sort: 'duration_desc', limit: 25, offset: 0 },
  'panel.get': undefined,
  'panel.getById': undefined,
  'modifications.list': undefined,
  'telemetry.event': { projectRoot: PROJECT_ROOT, events: [INGRESS_EVENT] },
  'devServer.launch': { projectRoot: PROJECT_ROOT },
  'devServer.stop': { projectRoot: PROJECT_ROOT },
  'devServer.credential': { projectRoot: PROJECT_ROOT },
  health: undefined,
  'pair.start': {},
  'pair.complete': { code: PAIRING_CODE },
  'credentials.rotate': {},
};

/** The path parameters every operation declares, keyed by operation. */
const VALID_PARAMS: { readonly [O in HttpOperation]: HttpPathParams<O> } = {
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
};

/** A valid `GET /health` reply. */
const HEALTH_REPLY = { version: '0.1.0', protocolVersion: '1.0.0', pairingAvailable: true };

/**
 * A valid `GET /sessions` reply: an empty first page, with the paging echo the
 * listing always carries.
 */
const EMPTY_SESSION_PAGE = { sessions: [], total: 0, limit: 100, offset: 0, nextOffset: null };

/** The two operations that are called without a credential. */
const EXEMPT_OPERATIONS = HTTP_OPERATIONS.filter((operation) => isAuthExemptOperation(operation));

/** The nineteen operations that must carry one. */
const PROTECTED_OPERATIONS = HTTP_OPERATIONS.filter(
  (operation) => !isAuthExemptOperation(operation),
);

/** The only header names this client may ever write. */
const ALLOWED_HEADER_NAMES: readonly string[] = [
  'accept',
  'content-type',
  AUTHORIZATION_HEADER,
  ACTING_TAB_HEADER,
];

/** The inspected tab the acting-tab cases act for: distinctive on purpose. */
const ACTING_TAB = 8_675_309;

/** The only fields a log record may carry. */
const ALLOWED_LOG_FIELDS: readonly string[] = ['operation', 'status', 'elapsedMs', 'cancelled'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The arguments that make one operation's call valid.
 *
 * @param operation The operation.
 * @returns Its path parameters and body.
 */
function argsFor<O extends HttpOperation>(operation: O): HttpRequestArgs<O> {
  return { params: VALID_PARAMS[operation], body: VALID_REQUESTS[operation] };
}

/**
 * A response the fake transport answers with.
 *
 * @param status The HTTP status; `ok` is derived from it.
 * @param body A string sent verbatim, or a value sent as JSON.
 * @returns A structural response.
 */
function reply(status: number, body: unknown): HttpResponseLike {
  const text = typeof body === 'string' ? body : JSON.stringify(body);

  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text) };
}

/**
 * A fake transport that answers every call with one response.
 *
 * @param response The response.
 * @returns A spy satisfying {@link FetchLike}.
 */
function fetchReplying(response: HttpResponseLike): Mock<FetchLike> {
  return vi.fn<FetchLike>(() => Promise.resolve(response));
}

/** A promise with its settlement functions exposed. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
}

/**
 * A promise settled by the test, never by itself — how a stalled credential
 * provider, transport or body read is modelled.
 *
 * @returns The promise and the functions that settle it.
 */
function deferred<T>(): Deferred<T> {
  const settlers: { resolve?: (value: T) => void; reject?: (reason: Error) => void } = {};
  const promise = new Promise<T>((resolve, reject) => {
    settlers.resolve = resolve;
    settlers.reject = reject;
  });

  return {
    promise,
    resolve: (value) => settlers.resolve?.(value),
    reject: (reason) => settlers.reject?.(reason),
  };
}

/**
 * The single call a fake transport received.
 *
 * @param fetch The spy.
 * @returns The URL and the init it was called with.
 */
function onlyCall(fetch: Mock<FetchLike>): { readonly url: string; readonly init: HttpFetchInit } {
  expect(fetch).toHaveBeenCalledTimes(1);
  const call = fetch.mock.calls[0];

  if (call === undefined) {
    return expect.unreachable('the transport was not called');
  }

  const [url, init] = call;

  if (init === undefined) {
    return expect.unreachable('the transport was called without an init');
  }

  return { url, init };
}

/**
 * The failure a result carries, failing the case when it succeeded.
 *
 * @param result The result.
 * @returns Its error.
 */
function failureOf<T>(result: Result<T, DebuggenError>): DebuggenError {
  if (isOk(result)) {
    return expect.unreachable(`expected a failure, got ${JSON.stringify(result.value)}`);
  }

  return result.error;
}

/**
 * The value a result carries, failing the case when it failed.
 *
 * @param result The result.
 * @returns Its value.
 */
function valueOf<T>(result: Result<T, DebuggenError>): T {
  if (isErr(result)) {
    return expect.unreachable(
      `expected a success, got ${result.error.code}: ${result.error.message}`,
    );
  }

  return result.value;
}

/**
 * Every string reachable from a value through own properties, enumerable or
 * not — an error's `message`, `stack`, `hint`, `details` and its whole `cause`
 * chain; a client's private fields — joined into one searchable text.
 *
 * Stronger than `JSON.stringify`, which skips non-enumerable members such as
 * `message` and `cause`: a leak is a leak whether or not it serialises.
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

/** One record a capturing logger received. */
interface CapturedRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/**
 * A logger that keeps every record, so a case can assert on what was logged.
 *
 * @returns The logger and the records it has received.
 */
function capturingLogger(): { readonly logger: Logger; readonly records: CapturedRecord[] } {
  const records: CapturedRecord[] = [];

  const create = (bindings: LogFields): Logger => {
    const write =
      (level: LogLevel) =>
      (message: string, fields?: LogFields): void => {
        records.push({ level, message, fields: { ...bindings, ...fields } });
      };

    return {
      level: 'trace',
      trace: write('trace'),
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
      fatal: write('fatal'),
      child: (childBindings) => create({ ...bindings, ...childBindings }),
    };
  };

  return { logger: create({}), records };
}

/**
 * Lets every pending promise reaction run, under real or fake timers alike.
 *
 * Fake timers do not replace promise microtasks, so a bounded chain of resolved
 * awaits drains everything a step of the client can have queued.
 */
async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// parseServiceOrigin — the one host policy
// ---------------------------------------------------------------------------

describe('parseServiceOrigin — accepted loopback spellings and their canonical form', () => {
  it.each([
    ['http://127.0.0.1:43117', 'http://127.0.0.1:43117'],
    ['http://127.1:43117', 'http://127.0.0.1:43117'],
    ['http://0x7f.1:43117', 'http://127.0.0.1:43117'],
    ['http://2130706433:43117', 'http://127.0.0.1:43117'],
    ['http://127.255.255.254:8080', 'http://127.255.255.254:8080'],
    ['http://[::1]:43117', 'http://[::1]:43117'],
    ['http://[0:0:0:0:0:0:0:1]:43117', 'http://[::1]:43117'],
    ['http://[::ffff:127.0.0.1]:43117', 'http://[::ffff:7f00:1]:43117'],
    ['http://localhost:43117', 'http://localhost:43117'],
    ['http://LOCALHOST:43117', 'http://localhost:43117'],
    ['https://127.0.0.1:43117', 'https://127.0.0.1:43117'],
    ['ws://127.0.0.1:43117', 'http://127.0.0.1:43117'],
    ['wss://localhost:43117', 'https://localhost:43117'],
    ['http://127.0.0.1:43117/', 'http://127.0.0.1:43117'],
    ['  http://127.0.0.1:43117  ', 'http://127.0.0.1:43117'],
    ['http://127.0.0.1:80', 'http://127.0.0.1'],
  ])('accepts %s as %s', (input, canonical) => {
    expect(valueOf(parseServiceOrigin(input))).toBe(canonical);
  });

  it('accepts the one extra path the caller allows, and still returns the bare origin', () => {
    expect(
      valueOf(parseServiceOrigin(`ws://127.0.0.1:43117${WS_PATH}`, { allowedPath: WS_PATH })),
    ).toBe('http://127.0.0.1:43117');
    expect(isErr(parseServiceOrigin(`ws://127.0.0.1:43117${WS_PATH}`))).toBe(true);
  });
});

/** A refused value, the rule it breaks, and a label for the case name. */
interface RefusedValue {
  readonly label: string;
  readonly value: string;
  readonly rule: ServiceOriginRule;
}

/**
 * Values the policy must refuse, each seeded with {@link MARKER} wherever it has
 * room for one, so each doubles as a non-leakage probe. User information is
 * assembled from fragments: `scripts/check-secrets.mjs` reads this file.
 */
const REFUSED_BASE_URLS: readonly RefusedValue[] = [
  { label: 'an empty value', value: '', rule: 'empty' },
  { label: 'whitespace only', value: '   ', rule: 'empty' },
  { label: 'an unparseable value', value: `${MARKER} is not a url`, rule: 'unparseable' },
  {
    label: 'a host and port with no scheme',
    value: `127.0.0.1:43117/${MARKER}`,
    rule: 'unparseable',
  },
  {
    label: 'a user name and password',
    value: 'http://' + ['u', MARKER].join(':') + '@127.0.0.1:43117',
    rule: 'userinfo',
  },
  { label: 'a user name alone', value: 'http://' + MARKER + '@127.0.0.1:43117', rule: 'userinfo' },
  // The parser erases an empty userinfo, so these are caught on the raw
  // authority; each would otherwise parse with an empty `username`.
  { label: 'an empty user name', value: 'http://@127.0.0.1:43117', rule: 'userinfo' },
  {
    label: 'an empty user name and password',
    value: 'http://' + ':' + '@127.0.0.1:43117',
    rule: 'userinfo',
  },
  { label: 'an empty userinfo on a socket URL', value: `ws://@127.0.0.1:43117`, rule: 'userinfo' },
  // Forms the parser reads leniently as an origin, refused as not written as one.
  {
    label: 'a special scheme written without slashes',
    value: 'http:127.0.0.1:43117',
    rule: 'unparseable',
  },
  {
    label: 'an empty userinfo written without slashes',
    value: 'http:@127.0.0.1:43117',
    rule: 'unparseable',
  },
  {
    label: 'backslashes in place of the slashes',
    value: 'http:\\\\127.0.0.1:43117',
    rule: 'unparseable',
  },
  { label: 'a tab inside the value', value: 'http://127.0.0.1:43\t117', rule: 'unparseable' },
  { label: 'a newline inside the value', value: 'http://127.0.0.1\n:43117', rule: 'unparseable' },
  {
    label: 'user information in front of a remote host',
    value: 'http://' + ['u', MARKER].join(':') + '@example.com',
    rule: 'userinfo',
  },
  { label: 'an ftp URL', value: `ftp://127.0.0.1:43117/${MARKER}`, rule: 'scheme' },
  { label: 'a file URL', value: `file:///${MARKER}`, rule: 'scheme' },
  { label: 'a name read as a scheme', value: `localhost:43117/${MARKER}`, rule: 'scheme' },
  {
    label: 'a public host name',
    value: `http://${MARKER}.example.com:43117`,
    rule: 'not-loopback',
  },
  {
    label: 'a private 10.x address',
    value: `http://10.0.0.1:43117/?${MARKER}`,
    rule: 'not-loopback',
  },
  {
    label: 'a private 192.168.x address',
    value: `http://192.168.1.20:43117#${MARKER}`,
    rule: 'not-loopback',
  },
  {
    label: 'the unspecified address',
    value: `http://0.0.0.0:43117/${MARKER}`,
    rule: 'not-loopback',
  },
  {
    label: 'the unspecified IPv6 address',
    value: `http://[::]:43117/${MARKER}`,
    rule: 'not-loopback',
  },
  {
    label: 'an IPv4-mapped private address',
    value: `http://[::ffff:10.0.0.1]:43117/${MARKER}`,
    rule: 'not-loopback',
  },
  {
    label: 'an IPv4-compatible loopback address',
    value: `http://[::7f00:1]:43117/${MARKER}`,
    rule: 'not-loopback',
  },
  {
    label: 'localhost with a trailing dot',
    value: `http://localhost.:43117/${MARKER}`,
    rule: 'not-loopback',
  },
  {
    label: 'a look-alike host under a loopback-looking label',
    value: `http://127.0.0.1.${MARKER}.example:43117`,
    rule: 'not-loopback',
  },
  { label: 'a path', value: `http://127.0.0.1:43117/${MARKER}`, rule: 'path' },
  // Paths the parser normalises to the root, refused as written.
  {
    label: 'a path that dot-segments back to the root',
    value: `http://127.0.0.1:43117/${MARKER}/..`,
    rule: 'path',
  },
  { label: 'a single dot segment', value: 'http://127.0.0.1:43117/./', rule: 'path' },
  { label: 'an encoded dot segment', value: 'http://127.0.0.1:43117/%2e', rule: 'path' },
  { label: 'a backslash for the root', value: 'http://127.0.0.1:43117\\', rule: 'path' },
  { label: 'a doubled slash', value: 'http://127.0.0.1:43117//', rule: 'path' },
  { label: 'an at-sign in the path', value: 'http://127.0.0.1:43117/@x', rule: 'path' },
  {
    label: 'the socket path without allowedPath',
    value: `http://127.0.0.1:43117${WS_PATH}`,
    rule: 'path',
  },
  { label: 'a query', value: `http://127.0.0.1:43117/?token=${MARKER}`, rule: 'query-or-fragment' },
  { label: 'an empty query', value: 'http://127.0.0.1:43117?', rule: 'query-or-fragment' },
  { label: 'a fragment', value: `http://127.0.0.1:43117#${MARKER}`, rule: 'query-or-fragment' },
  { label: 'an empty fragment', value: 'http://127.0.0.1:43117/#', rule: 'query-or-fragment' },
];

describe('parseServiceOrigin — refusals', () => {
  it.each(REFUSED_BASE_URLS)('refuses $label with rule $rule', ({ value, rule }) => {
    const error = failureOf(parseServiceOrigin(value));

    expect(error).toBeInstanceOf(DebuggenError);
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.details).toEqual({ rule });
    expect(error.hint).toEqual(expect.any(String));
    expect(error.cause).toBeUndefined();
    expect(reachableText(error)).not.toContain(MARKER);
  });

  it('refuses a path other than the one allowed', () => {
    const error = failureOf(
      parseServiceOrigin('ws://127.0.0.1:43117/other', { allowedPath: WS_PATH }),
    );

    expect(error.details).toEqual({ rule: 'path' });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 43117],
    ['an object', { href: 'http://127.0.0.1:43117' }],
  ] as const)('refuses %s — a value that is not text — without throwing', (_label, untyped) => {
    const value: unknown = untyped;
    const error = failureOf(parseServiceOrigin(value as string));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.details).toEqual({ rule: 'unparseable' });
    expect(error.message).toBe('The service base URL is not text');
    expect(error.cause).toBeUndefined();
  });

  it('keeps a constant message per rule, whatever the refused value was', () => {
    const first = failureOf(parseServiceOrigin(`http://${MARKER}.example.com`));
    const second = failureOf(parseServiceOrigin('http://192.0.2.1'));

    expect(first.message).toBe(second.message);
    expect(first.hint).toBe(second.hint);
  });

  it('covers every rule except the defensive host rule', () => {
    const exercised = new Set(REFUSED_BASE_URLS.map(({ rule }) => rule));
    const expected: readonly ServiceOriginRule[] = [
      'empty',
      'unparseable',
      'userinfo',
      'scheme',
      'not-loopback',
      'path',
      'query-or-fragment',
    ];

    expect([...exercised].sort()).toEqual([...expected].sort());
  });

  it('never reaches the host rule for an accepted scheme: the URL parser refuses an empty host first', () => {
    for (const scheme of ['http:', 'https:', 'ws:', 'wss:']) {
      for (const value of [`${scheme}//`, `${scheme}///`, `${scheme}//:43117`]) {
        expect(failureOf(parseServiceOrigin(value)).details).toEqual({ rule: 'unparseable' });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// A refused base URL: nothing is resolved and nothing is sent
// ---------------------------------------------------------------------------

describe('HttpClient on a refused base URL', () => {
  it.each(REFUSED_BASE_URLS)(
    '$label: constructs, sends nothing and resolves no credential for any operation',
    async ({ value, rule }) => {
      const fetch = fetchReplying(reply(200, HEALTH_REPLY));
      const token = vi.fn<TokenProvider>(() => EDITOR_TOKEN);
      const { logger, records } = capturingLogger();
      const client = new HttpClient({
        baseUrl: value,
        token,
        fetch,
        logger,
        defaultTimeoutMs: 1_000,
      });

      expect(client.baseUrl).toBeUndefined();
      expect(client.configurationError?.code).toBe('CONFIG_INVALID');
      expect(client.configurationError?.details).toEqual({ rule });
      expect(reachableText(client)).not.toContain(MARKER);

      for (const operation of HTTP_OPERATIONS) {
        const error = failureOf(await client.request(operation, argsFor(operation)));

        expect(error.code).toBe('CONFIG_INVALID');
        expect(error.message).toBe(
          `Cannot call ${operation}: the configured service base URL was refused`,
        );
        expect(error.hint).toBe(client.configurationError?.hint);
        expect(error.details).toEqual({ operation, rule });
        expect(error.cause).toBe(client.configurationError);
        expect(reachableText(error)).not.toContain(MARKER);
      }

      failureOf(await client.health());
      failureOf(await client.pairComplete(PAIRING_CODE));
      failureOf(await client.startCapture(SESSION_ID));

      expect(fetch).not.toHaveBeenCalled();
      expect(token).not.toHaveBeenCalled();
      expect(records).toEqual([]);
    },
  );

  it('never throws from the constructor, even for a value that is not a string', () => {
    const untyped: unknown = undefined;
    const client = new HttpClient({
      baseUrl: untyped as string,
      fetch: fetchReplying(reply(200, {})),
    });

    expect(client.baseUrl).toBeUndefined();
    // The shared policy's own answer for a value that is not text, so the
    // WebSocket client reports the same rule for the same input.
    expect(client.configurationError?.details).toEqual({ rule: 'unparseable' });
    expect(client.configurationError?.message).toBe('The service base URL is not text');
  });

  it('exposes the canonical origin and no configuration error for an accepted value', () => {
    const client = new HttpClient({
      baseUrl: 'ws://LOCALHOST:43117/',
      fetch: fetchReplying(reply(200, {})),
    });

    expect(client.baseUrl).toBe('http://localhost:43117');
    expect(client.configurationError).toBeUndefined();
  });

  it('sends to the canonical origin, never to the configured spelling', async () => {
    const fetch = fetchReplying(reply(200, HEALTH_REPLY));
    const client = new HttpClient({ baseUrl: '  http://127.1:43117/  ', fetch });

    valueOf(await client.health());

    expect(onlyCall(fetch).url).toBe(`${ORIGIN}${buildPath('health')}`);
  });
});

// ---------------------------------------------------------------------------
// What goes on the wire
// ---------------------------------------------------------------------------

describe('HttpClient — method, URL, body and headers from the route table', () => {
  it.each(HTTP_OPERATIONS)('%s is sent as its route declares', async (operation) => {
    const fetch = fetchReplying(reply(200, {}));
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });

    await client.request(operation, argsFor(operation));

    const { url, init } = onlyCall(fetch);
    const body = VALID_REQUESTS[operation];
    const expectedHeaders: Record<string, string> = { accept: 'application/json' };

    if (body !== undefined) {
      expectedHeaders['content-type'] = 'application/json';
    }

    if (!isAuthExemptOperation(operation)) {
      expectedHeaders[AUTHORIZATION_HEADER] = formatBearer(EDITOR_TOKEN);
    }

    expect(url).toBe(`${ORIGIN}${buildPath(operation, VALID_PARAMS[operation])}`);
    expect(init.method).toBe(HTTP_ROUTES[operation].method);
    expect(init.credentials).toBe('omit');
    expect(init.headers).toEqual(expectedHeaders);
    expect(
      Object.keys(init.headers ?? {}).every((name) => ALLOWED_HEADER_NAMES.includes(name)),
    ).toBe(true);

    if (body === undefined) {
      expect(init).not.toHaveProperty('body');
    } else {
      expect(init.body).toBe(JSON.stringify(body));
    }

    // No caller signal and no timeout: nothing to link, so nothing is sent.
    expect(init).not.toHaveProperty('signal');
  });

  it('never writes an origin, cookie or access-control header', async () => {
    const fetch = fetchReplying(reply(200, {}));
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });

    await client.request('session.create', argsFor('session.create'));

    const names = Object.keys(onlyCall(fetch).init.headers ?? {});

    expect(names).not.toContain('origin');
    expect(names).not.toContain('cookie');
    expect(names.some((name) => name.startsWith('access-control-'))).toBe(false);
  });

  it('encodes a path parameter into a single segment', async () => {
    const fetch = fetchReplying(reply(200, {}));
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });

    await client.request('session.get', { params: { id: 'a/b?c#d' } });

    expect(onlyCall(fetch).url).toBe(`${ORIGIN}/sessions/a%2Fb%3Fc%23d`);
  });

  it('sends a page window as the query string the listing parses', async () => {
    const fetch = vi.fn<FetchLike>((url) =>
      Promise.resolve(
        reply(
          200,
          url.includes('/modifications')
            ? { modifications: [], total: 0, limit: 0, offset: 0, nextOffset: null }
            : { ...EMPTY_SESSION_PAGE, limit: 50, offset: 100 },
        ),
      ),
    );
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });

    expect((await client.request('session.list', { query: { limit: 50, offset: 100 } })).ok).toBe(
      true,
    );
    expect(
      (
        await client.request('modifications.list', {
          params: { id: SESSION_ID },
          query: { limit: 0 },
        })
      ).ok,
    ).toBe(true);
    await client.request('session.list', { query: { limit: undefined, offset: undefined } });

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${ORIGIN}/sessions?limit=50&offset=100`,
      `${ORIGIN}${buildPath('modifications.list', { id: SESSION_ID })}?limit=0`,
      `${ORIGIN}/sessions`,
    ]);
  });

  it('refuses a page window locally, before any credential or transport is reached', async () => {
    const fetch = fetchReplying(reply(200, EMPTY_SESSION_PAGE));
    const token = vi.fn<TokenProvider>(() => EDITOR_TOKEN);
    const client = new HttpClient({ baseUrl: ORIGIN, token, fetch });

    const tooLarge = failureOf(await client.request('session.list', { query: { limit: 501 } }));
    const negative = failureOf(
      await client.request('modifications.list', {
        params: { id: SESSION_ID },
        query: { offset: -1 },
      }),
    );
    // An untyped caller naming a window for a route that reads none.
    const untyped = failureOf(
      await client.request('session.get', {
        params: { id: SESSION_ID },
        query: { limit: 1 },
      } as unknown as HttpRequestArgs<'session.get'>),
    );

    for (const error of [tooLarge, negative, untyped]) {
      expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    }
    expect(token).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails a missing path parameter locally, before any credential is resolved', async () => {
    const fetch = fetchReplying(reply(200, {}));
    const token = vi.fn<TokenProvider>(() => EDITOR_TOKEN);
    const client = new HttpClient({ baseUrl: ORIGIN, token, fetch });

    const error = failureOf(await client.request('session.get'));

    expect(error.code).toBe('INTERNAL');
    expect(error.details).toEqual({ operation: 'session.get', parameter: 'id' });
    expect(fetch).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
  });

  it('fails a body the route schema refuses locally, without echoing it', async () => {
    const fetch = fetchReplying(reply(200, {}));
    const token = vi.fn<TokenProvider>(() => EDITOR_TOKEN);
    const client = new HttpClient({ baseUrl: ORIGIN, token, fetch });
    const invalid: unknown = { projectRoot: PROJECT_ROOT, question: 42, note: MARKER };

    const error = failureOf(
      await client.request('session.create', {
        body: invalid as HttpRequestBody<'session.create'>,
      }),
    );

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(fetch).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
    expect(reachableText(error)).not.toContain(MARKER);
    expect(reachableText(error)).not.toContain(PROJECT_ROOT);
  });

  it('fails a schema-valid body that cannot be serialised as JSON, before anything is sent', async () => {
    const fetch = fetchReplying(reply(200, { accepted: 1 }));
    const token = vi.fn<TokenProvider>(() => EDITOR_TOKEN);
    const client = new HttpClient({ baseUrl: ORIGIN, token, fetch });
    const cyclic: Record<string, unknown> = { label: MARKER };

    cyclic.self = cyclic;

    // The attribute guard is shallow by design, so a BigInt or a nested cycle
    // passes the schema and only fails at `JSON.stringify`.
    for (const attributes of [{ 'db.rowCount': 10n }, { nested: cyclic }]) {
      const error = failureOf(
        await client.request('telemetry.event', {
          body: { projectRoot: PROJECT_ROOT, events: [{ ...INGRESS_EVENT, attributes }] },
        }),
      );

      expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(error.message).toBe(
        'The telemetry.event request body could not be serialised as JSON',
      );
      expect(error.details).toEqual({ operation: 'telemetry.event' });
      expect(reachableText(error)).not.toContain(MARKER);
    }

    expect(fetch).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
  });

  it('refuses a body on a route that declares none', async () => {
    const fetch = fetchReplying(reply(200, {}));
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });
    const unexpected: unknown = { note: MARKER };

    const error = failureOf(
      await client.request('session.list', { body: unexpected as HttpRequestBody<'session.list'> }),
    );

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the platform fetch, resolved at call time, when none is injected', async () => {
    const platformFetch = fetchReplying(reply(200, HEALTH_REPLY));
    const client = new HttpClient({ baseUrl: ORIGIN });

    vi.stubGlobal('fetch', platformFetch);

    try {
      expect(valueOf(await client.health())).toEqual(HEALTH_REPLY);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(platformFetch).toHaveBeenCalledTimes(1);
  });

  it('fails locally when the runtime has no fetch and none is injected', async () => {
    const client = new HttpClient({ baseUrl: ORIGIN });

    vi.stubGlobal('fetch', undefined);

    try {
      const error = failureOf(await client.health());

      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.details).toEqual({ operation: 'health' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// The credential
// ---------------------------------------------------------------------------

describe('HttpClient — the bearer credential', () => {
  it.each(EXEMPT_OPERATIONS)(
    '%s never carries a credential, even when one is configured',
    async (operation) => {
      const fetch = fetchReplying(reply(200, {}));
      const token = vi.fn<TokenProvider>(() => EDITOR_TOKEN);
      const client = new HttpClient({ baseUrl: ORIGIN, token, fetch });

      await client.request(operation, argsFor(operation));

      expect(onlyCall(fetch).init.headers).not.toHaveProperty(AUTHORIZATION_HEADER);
      expect(token).not.toHaveBeenCalled();
    },
  );

  it('names exactly health and pair.complete as exempt', () => {
    expect([...EXEMPT_OPERATIONS].sort()).toEqual(['health', 'pair.complete']);
    expect(PROTECTED_OPERATIONS).toHaveLength(19);
  });

  it.each(PROTECTED_OPERATIONS)('%s carries authorization: Bearer <token>', async (operation) => {
    const fetch = fetchReplying(reply(200, {}));
    const token = vi.fn<TokenProvider>(() => EDITOR_TOKEN);
    const client = new HttpClient({ baseUrl: ORIGIN, token, fetch });

    await client.request(operation, argsFor(operation));

    expect(onlyCall(fetch).init.headers?.[AUTHORIZATION_HEADER]).toBe(`Bearer ${EDITOR_TOKEN}`);
    expect(token).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a string', EDITOR_TOKEN],
    ['a synchronous provider', (): string => EDITOR_TOKEN],
    ['an asynchronous provider', (): Promise<string> => Promise.resolve(EDITOR_TOKEN)],
  ] as const)('accepts the credential as %s', async (_label, source) => {
    const fetch = fetchReplying(reply(200, EMPTY_SESSION_PAGE));
    const client = new HttpClient({ baseUrl: ORIGIN, token: source, fetch });

    expect(valueOf(await client.request('session.list'))).toEqual(EMPTY_SESSION_PAGE);
    expect(onlyCall(fetch).init.headers?.[AUTHORIZATION_HEADER]).toBe(formatBearer(EDITOR_TOKEN));
  });

  it.each([
    ['omitted', undefined, 'no bearer credential is available'],
    ['an empty string', '', 'no bearer credential is available'],
    [
      'a provider answering undefined',
      (): undefined => undefined,
      'no bearer credential is available',
    ],
    ['a provider answering an empty string', (): string => '', 'no bearer credential is available'],
    [
      'a provider resolving undefined',
      (): Promise<undefined> => Promise.resolve(undefined),
      'no bearer credential is available',
    ],
    [
      'a provider that throws',
      (): string => {
        throw new Error(`storage unavailable ${MARKER}`);
      },
      'the credential provider threw',
    ],
    [
      'a provider that rejects',
      (): Promise<string> => Promise.reject(new Error(`storage unavailable ${MARKER}`)),
      'the credential provider failed',
    ],
  ] as const)(
    'fails a protected call locally when the credential is %s',
    async (_label, source, reason) => {
      const fetch = fetchReplying(reply(200, EMPTY_SESSION_PAGE));
      const client = new HttpClient({ baseUrl: ORIGIN, token: source, fetch });

      const error = failureOf(await client.request('session.list'));

      expect(error.code).toBe('UNAUTHORIZED');
      expect(error.message).toBe(`Cannot call session.list: ${reason}`);
      expect(error.details).toEqual({ operation: 'session.list' });
      expect(error.hint).toEqual(expect.stringContaining('setToken()'));
      // A credential store's own failure text is never carried, not even as
      // `cause`: it can name a storage key or quote the value it failed to read.
      expect(error.cause).toBeUndefined();
      expect(reachableText(error)).not.toContain(MARKER);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('still calls an exempt operation when no credential is available', async () => {
    const fetch = fetchReplying(reply(200, HEALTH_REPLY));
    const client = new HttpClient({ baseUrl: ORIGIN, fetch });

    expect(valueOf(await client.health())).toEqual(HEALTH_REPLY);
  });

  it('presents the rotated credential from the next call onward, and none once cleared', async () => {
    const fetch = fetchReplying(reply(200, EMPTY_SESSION_PAGE));
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });

    await client.request('session.list');
    client.setToken(ROTATED_TOKEN);
    await client.request('session.list');
    client.setToken(undefined);
    const cleared = failureOf(await client.request('session.list'));

    expect(fetch.mock.calls.map(([, init]) => init?.headers?.[AUTHORIZATION_HEADER])).toEqual([
      formatBearer(EDITOR_TOKEN),
      formatBearer(ROTATED_TOKEN),
    ]);
    expect(cleared.code).toBe('UNAUTHORIZED');
  });

  it('resolves a provider per call, so a rotated value takes effect without a new client', async () => {
    const fetch = fetchReplying(reply(200, EMPTY_SESSION_PAGE));
    const issued = [EDITOR_TOKEN, ROTATED_TOKEN];
    const token = vi.fn<TokenProvider>(() => issued.shift());
    const client = new HttpClient({ baseUrl: ORIGIN, token, fetch });

    await client.request('session.list');
    await client.request('session.list');

    expect(token).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([, init]) => init?.headers?.[AUTHORIZATION_HEADER])).toEqual([
      formatBearer(EDITOR_TOKEN),
      formatBearer(ROTATED_TOKEN),
    ]);
  });

  it('switches from a string to a provider with setToken', async () => {
    const fetch = fetchReplying(reply(200, EMPTY_SESSION_PAGE));
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });
    const provider = vi.fn<TokenProvider>(() => Promise.resolve(ROTATED_TOKEN));

    client.setToken(provider);
    await client.request('session.list');

    expect(provider).toHaveBeenCalledTimes(1);
    expect(onlyCall(fetch).init.headers?.[AUTHORIZATION_HEADER]).toBe(formatBearer(ROTATED_TOKEN));
  });
});

// ---------------------------------------------------------------------------
// The acting tab
// ---------------------------------------------------------------------------

describe('HttpClient — the acting tab a DevTools request is for', () => {
  it.each(PROTECTED_OPERATIONS)(
    '%s sends tabId as x-debuggen-tab beside the credential',
    async (operation) => {
      const fetch = fetchReplying(reply(200, {}));
      const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });

      await client.request(operation, { ...argsFor(operation), tabId: ACTING_TAB });

      const headers = onlyCall(fetch).init.headers ?? {};

      expect(headers[ACTING_TAB_HEADER]).toBe(String(ACTING_TAB));
      expect(headers[AUTHORIZATION_HEADER]).toBe(formatBearer(EDITOR_TOKEN));
      expect(Object.keys(headers).every((name) => ALLOWED_HEADER_NAMES.includes(name))).toBe(true);
    },
  );

  it('sends the tab through a named method’s options', async () => {
    const fetch = fetchReplying(reply(200, { captureId: CAPTURE_ID }));
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });

    const started = await client.startCapture(SESSION_ID, { tabId: ACTING_TAB });

    expect(valueOf(started)).toEqual({ captureId: CAPTURE_ID });
    expect(onlyCall(fetch).init.headers?.[ACTING_TAB_HEADER]).toBe(String(ACTING_TAB));
  });

  it('sends tab 0, which is a real tab rather than an absent one', async () => {
    const fetch = fetchReplying(reply(200, { sessions: [] }));
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });

    await client.request('session.list', { tabId: 0 });

    expect(onlyCall(fetch).init.headers?.[ACTING_TAB_HEADER]).toBe('0');
  });

  it.each([
    ['omitted', {}],
    ['explicitly undefined', { tabId: undefined }],
  ] as const)('sends no acting-tab header when tabId is %s', async (_label, extra) => {
    const fetch = fetchReplying(reply(200, { captureId: CAPTURE_ID }));
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });

    await client.request('capture.start', { ...argsFor('capture.start'), ...extra });
    await client.startCapture(SESSION_ID, extra);

    for (const [, init] of fetch.mock.calls) {
      expect(init?.headers).not.toHaveProperty(ACTING_TAB_HEADER);
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['chrome.tabs.TAB_ID_NONE', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['an infinite value', Number.POSITIVE_INFINITY],
    ['the first integer beyond the safe range', Number.MAX_SAFE_INTEGER + 1],
    ['a string from untyped code', '7' as unknown as number],
  ])(
    'refuses %s as tabId locally, before the credential or the transport',
    async (_label, tabId) => {
      const fetch = fetchReplying(reply(200, {}));
      const token = vi.fn<TokenProvider>(() => EDITOR_TOKEN);
      const client = new HttpClient({ baseUrl: ORIGIN, token, fetch });

      const viaRequest = failureOf(
        await client.request('panel.data', { ...argsFor('panel.data'), tabId }),
      );
      const viaMethod = failureOf(await client.startCapture(SESSION_ID, { tabId }));

      expect(viaRequest.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(viaRequest.message).toBe(
        'Cannot call panel.data: tabId is not a non-negative safe-integer Chrome tab id',
      );
      expect(viaRequest.details).toEqual({ operation: 'panel.data', header: ACTING_TAB_HEADER });
      expect(viaMethod.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(viaMethod.details).toEqual({ operation: 'capture.start', header: ACTING_TAB_HEADER });
      expect(fetch).not.toHaveBeenCalled();
      expect(token).not.toHaveBeenCalled();
    },
  );

  it('never quotes a refused tab id in the failure', async () => {
    const fetch = fetchReplying(reply(200, {}));
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });
    // Negative and distinctive, so the search cannot be satisfied by a digit
    // that an unrelated part of the error happens to contain.
    const refused = -ACTING_TAB;

    const error = failureOf(await client.request('session.list', { tabId: refused }));

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(reachableText(error)).not.toContain(String(ACTING_TAB));
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(EXEMPT_OPERATIONS)(
    'refuses a tabId on the exempt %s operation, which has no principal to act as',
    async (operation) => {
      const fetch = fetchReplying(reply(200, HEALTH_REPLY));
      const token = vi.fn<TokenProvider>(() => EDITOR_TOKEN);
      const client = new HttpClient({ baseUrl: ORIGIN, token, fetch });

      const error = failureOf(
        await client.request(operation, { ...argsFor(operation), tabId: ACTING_TAB }),
      );

      expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(error.message).toBe(
        `Cannot call ${operation}: an acting tab was given for an operation that carries no credential`,
      );
      expect(error.details).toEqual({ operation, header: ACTING_TAB_HEADER });
      expect(reachableText(error)).not.toContain(String(ACTING_TAB));
      expect(fetch).not.toHaveBeenCalled();
      expect(token).not.toHaveBeenCalled();
    },
  );

  it('refuses a tabId passed to the named health and pairComplete methods', async () => {
    const fetch = fetchReplying(reply(200, HEALTH_REPLY));
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });

    const health = failureOf(await client.health({ tabId: ACTING_TAB }));
    const paired = failureOf(await client.pairComplete(PAIRING_CODE, { tabId: ACTING_TAB }));

    expect(health.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(health.details).toEqual({ operation: 'health', header: ACTING_TAB_HEADER });
    expect(paired.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(paired.details).toEqual({ operation: 'pair.complete', header: ACTING_TAB_HEADER });
    expect(reachableText(paired)).not.toContain(PAIRING_CODE);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still answers a refused base URL first, whatever the tab', async () => {
    const fetch = fetchReplying(reply(200, {}));
    const client = new HttpClient({ baseUrl: 'http://example.com:43117', fetch });

    const error = failureOf(await client.request('session.list', { tabId: -1 }));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// What comes back
// ---------------------------------------------------------------------------

describe('HttpClient — replies', () => {
  it('parses a valid 2xx reply with the route schema', async () => {
    const client = new HttpClient({
      baseUrl: ORIGIN,
      token: EDITOR_TOKEN,
      fetch: fetchReplying(reply(200, { captureId: CAPTURE_ID })),
    });

    expect(valueOf(await client.startCapture(SESSION_ID))).toEqual({ captureId: CAPTURE_ID });
  });

  it('parses the named health and pairing replies', async () => {
    const health = new HttpClient({
      baseUrl: ORIGIN,
      fetch: fetchReplying(reply(200, HEALTH_REPLY)),
    });
    // A low-entropy stand-in for the read proof the service issues at pairing.
    const readProof = 'p'.repeat(READ_PROOF_LENGTH);
    const pairing = new HttpClient({
      baseUrl: ORIGIN,
      fetch: fetchReplying(reply(200, { token: 'tok-devtools-1', readProof })),
    });

    expect(valueOf(await health.health())).toEqual(HEALTH_REPLY);
    expect(valueOf(await pairing.pairComplete(PAIRING_CODE))).toEqual({
      token: 'tok-devtools-1',
      readProof,
    });
  });

  it('sends the pairing code as the pair.complete body and nowhere else', async () => {
    const fetch = fetchReplying(
      reply(200, { token: 'tok-devtools-1', readProof: 'p'.repeat(READ_PROOF_LENGTH) }),
    );
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });

    await client.pairComplete(PAIRING_CODE);

    const { url, init } = onlyCall(fetch);

    expect(init.body).toBe(JSON.stringify({ code: PAIRING_CODE }));
    expect(url).not.toContain(PAIRING_CODE);
    expect(init.headers).not.toHaveProperty(AUTHORIZATION_HEADER);
  });

  it('reports a 2xx reply that is not JSON as a protocol failure', async () => {
    const client = new HttpClient({
      baseUrl: ORIGIN,
      token: EDITOR_TOKEN,
      fetch: fetchReplying(reply(200, `{ "sessions": [${MARKER}`)),
    });

    const error = failureOf(await client.request('session.list'));

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(error.message).toBe('The session.list reply was not valid JSON (status 200)');
    expect(error.details).toEqual({ operation: 'session.list', status: 200 });
    expect(reachableText(error)).not.toContain(MARKER);
  });

  it('reports a 2xx reply that violates the route schema, with the status attached', async () => {
    const client = new HttpClient({
      baseUrl: ORIGIN,
      fetch: fetchReplying(
        reply(200, { version: MARKER, protocolVersion: 7, pairingAvailable: 'yes' }),
      ),
    });

    const error = failureOf(await client.health());

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(error.details).toEqual(expect.objectContaining({ operation: 'health', status: 200 }));
    expect(error.cause).toBeInstanceOf(DebuggenError);
    expect(reachableText(error)).not.toContain(MARKER);
  });

  it('judges an empty 2xx body by the route schema rather than as invalid JSON', async () => {
    const client = new HttpClient({ baseUrl: ORIGIN, fetch: fetchReplying(reply(200, '')) });

    const error = failureOf(await client.health());

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(error.message).not.toContain('not valid JSON');
    expect(error.details).toEqual(expect.objectContaining({ operation: 'health', status: 200 }));
  });

  it("keeps the service's own code, message and ref on a non-2xx reply", async () => {
    const client = new HttpClient({
      baseUrl: ORIGIN,
      token: EDITOR_TOKEN,
      fetch: fetchReplying(
        reply(404, { code: 'SESSION_NOT_FOUND', message: 'No such session', ref: 'ref_1' }),
      ),
    });

    const error = failureOf(await client.request('session.get', { params: { id: SESSION_ID } }));

    expect(error.code).toBe('SESSION_NOT_FOUND');
    expect(error.message).toBe('The session.get request failed (status 404): No such session');
    expect(error.details).toEqual({ operation: 'session.get', status: 404, ref: 'ref_1' });
  });

  /**
   * A fragment unique to the recovery hint of each unauthorized-family code, so
   * a case asserts the remedy a refusal carries — and that it carries no other
   * code's remedy — rather than merely that it carries one.
   */
  const FAMILY_HINT_FRAGMENTS = {
    FORBIDDEN_ORIGIN: 'http: or https: web page',
    PAIRING_EXPIRED: 'no longer valid',
    PAIRING_INVALID: 'did not accept this pairing code',
    RATE_LIMITED: 'rate-limiting',
    UNAUTHORIZED: 'setToken()',
  } as const;

  /**
   * Asserts that a hint is the one for `code`, and names no other family code's
   * remedy.
   *
   * @param hint The hint the failure carried.
   * @param code The unauthorized-family code it was reported with.
   */
  function expectFamilyHint(
    hint: string | undefined,
    code: keyof typeof FAMILY_HINT_FRAGMENTS,
  ): void {
    expect(hint).toEqual(expect.stringContaining(FAMILY_HINT_FRAGMENTS[code]));

    const others = Object.entries(FAMILY_HINT_FRAGMENTS).filter(([other]) => other !== code);

    for (const [, fragment] of others) {
      expect(hint).not.toContain(fragment);
    }
  }

  it.each([
    [401, '', 'UNAUTHORIZED'],
    [401, { code: 'SESSION_NOT_FOUND', message: 'No such session' }, 'UNAUTHORIZED'],
    [401, { code: 'UNAUTHORIZED', message: 'Unknown credential' }, 'UNAUTHORIZED'],
    [403, { code: 'INTERNAL', message: 'Refused' }, 'UNAUTHORIZED'],
    [403, `refused ${MARKER}`, 'UNAUTHORIZED'],
    [401, { code: 'PAIRING_EXPIRED', message: 'The pairing code expired' }, 'PAIRING_EXPIRED'],
    [401, { code: 'PAIRING_INVALID', message: 'Not accepted' }, 'PAIRING_INVALID'],
    [403, { code: 'FORBIDDEN_ORIGIN', message: 'Web origins are refused' }, 'FORBIDDEN_ORIGIN'],
    [401, { code: 'RATE_LIMITED', message: 'Too many attempts' }, 'RATE_LIMITED'],
  ] as const)(
    'keeps a %i reply in the unauthorized family, with the hint for its code (body %j → %s)',
    async (status, body, code) => {
      const client = new HttpClient({
        baseUrl: ORIGIN,
        token: EDITOR_TOKEN,
        fetch: fetchReplying(reply(status, body)),
      });

      const error = failureOf(await client.request('session.list'));

      expect(error.code).toBe(code);
      expect(error.details).toEqual(expect.objectContaining({ operation: 'session.list', status }));
      expectFamilyHint(error.hint, code);
      expect(reachableText(error)).not.toContain(MARKER);
      expect(reachableText(error)).not.toContain(EDITOR_TOKEN);
    },
  );

  it.each([
    [
      403,
      { code: 'TAB_NOT_BOUND', message: 'The tab is not bound to this session' },
      'TAB_NOT_BOUND',
    ],
    [403, { code: 'PATH_OUTSIDE_PROJECT', message: 'Outside the project' }, 'PATH_OUTSIDE_PROJECT'],
  ] as const)(
    'keeps the scope refusal of an accepted credential as sent (a %i with %j → %s), never as a refused credential',
    async (status, body, code) => {
      const client = new HttpClient({
        baseUrl: ORIGIN,
        token: EDITOR_TOKEN,
        fetch: fetchReplying(reply(status, body)),
      });

      const error = failureOf(await client.request('session.list'));

      expect(error.code).toBe(code);
      expect(error.details).toEqual(expect.objectContaining({ operation: 'session.list', status }));
      expect(error.hint ?? '').not.toContain(FAMILY_HINT_FRAGMENTS.UNAUTHORIZED);
      expect(reachableText(error)).not.toContain(EDITOR_TOKEN);
    },
  );

  it.each([
    [429, '', 'RATE_LIMITED'],
    [429, { code: 'RATE_LIMITED', message: 'Too many attempts' }, 'RATE_LIMITED'],
    [500, '', 'INTERNAL'],
    [502, `<html>${MARKER}</html>`, 'INTERNAL'],
    [503, { code: 'STORE_ERROR', message: 'The store is locked' }, 'STORE_ERROR'],
    [400, `plain text ${MARKER}`, 'PROTOCOL_INVALID_MESSAGE'],
    [422, { code: 'INTERNAL', message: 'x', extra: MARKER }, 'PROTOCOL_INVALID_MESSAGE'],
  ] as const)('maps a %i reply (body %j) to %s', async (status, body, code) => {
    const client = new HttpClient({
      baseUrl: ORIGIN,
      token: EDITOR_TOKEN,
      fetch: fetchReplying(reply(status, body)),
    });

    const error = failureOf(await client.request('session.list'));

    expect(error.code).toBe(code);
    expect(error.details).toEqual(expect.objectContaining({ operation: 'session.list', status }));
    expect(reachableText(error)).not.toContain(MARKER);
  });

  it('adds a recovery hint for a rate limit and a server failure, and none for a bare refusal', async () => {
    const hints = await Promise.all(
      [429, 500, 400].map(async (status) => {
        const client = new HttpClient({
          baseUrl: ORIGIN,
          token: EDITOR_TOKEN,
          fetch: fetchReplying(reply(status, '')),
        });

        return failureOf(await client.request('session.list')).hint;
      }),
    );

    expect(hints[0]).toEqual(expect.stringContaining('rate-limiting'));
    expect(hints[1]).toEqual(expect.stringContaining('log'));
    expect(hints[2]).toBeUndefined();
  });

  it('explains the origin policy, not re-pairing, when a 403 names FORBIDDEN_ORIGIN', async () => {
    const client = new HttpClient({
      baseUrl: ORIGIN,
      token: EDITOR_TOKEN,
      fetch: fetchReplying(
        reply(403, {
          code: 'FORBIDDEN_ORIGIN',
          message: 'Debug Generator refuses requests from web origins.',
        }),
      ),
    });

    // The auth-exempt route and a protected one: the service refuses a web
    // origin before it looks at a credential, so both get the same remedy.
    const errors = [
      failureOf(await client.health()),
      failureOf(await client.request('session.list')),
    ];

    for (const error of errors) {
      expect(error.code).toBe('FORBIDDEN_ORIGIN');
      expectFamilyHint(error.hint, 'FORBIDDEN_ORIGIN');
      expect(error.hint).toEqual(expect.stringContaining('chrome-extension://'));
      expect(error.hint).not.toContain('Pair this client again');
      expect(error.hint).not.toContain('setToken()');
      expect(reachableText(error)).not.toContain(EDITOR_TOKEN);
      expect(reachableText(error)).not.toContain(ORIGIN);
    }
  });

  it.each([
    [401, 'PAIRING_EXPIRED', 'The pairing code expired'],
    [401, 'PAIRING_INVALID', 'The pairing code was not accepted'],
    [400, 'PAIRING_INVALID', 'The pairing code is malformed'],
  ] as const)(
    'asks for a fresh pairing code when pair.complete answers %i %s',
    async (status, code, message) => {
      const client = new HttpClient({
        baseUrl: ORIGIN,
        fetch: fetchReplying(reply(status, { code, message })),
      });

      const error = failureOf(await client.pairComplete(PAIRING_CODE));

      expect(error.code).toBe(code);
      expect(error.details).toEqual({ operation: 'pair.complete', status });
      expectFamilyHint(error.hint, code);
      expect(error.hint).toEqual(expect.stringContaining('debuggen.pairChrome'));
      expect(error.hint).not.toContain('setToken()');
      expect(reachableText(error)).not.toContain(PAIRING_CODE);
    },
  );

  it.each([400, 429, 503])(
    'gives a RATE_LIMITED code the rate-limit hint when it arrives as a %i',
    async (status) => {
      const client = new HttpClient({
        baseUrl: ORIGIN,
        fetch: fetchReplying(reply(status, { code: 'RATE_LIMITED', message: 'Too many attempts' })),
      });

      const error = failureOf(await client.pairComplete(PAIRING_CODE));

      expect(error.code).toBe('RATE_LIMITED');
      expectFamilyHint(error.hint, 'RATE_LIMITED');
      expect(error.hint).not.toContain('its log names the stage');
      expect(reachableText(error)).not.toContain(PAIRING_CODE);
    },
  );

  it('falls back to the status family when the resolved code has no hint of its own', async () => {
    const replies = [
      reply(429, { code: 'INTERNAL', message: 'Slow down' }),
      reply(503, { code: 'STORE_ERROR', message: 'The store is locked' }),
      reply(404, { code: 'SESSION_NOT_FOUND', message: 'No such session' }),
    ];
    const failures = await Promise.all(
      replies.map(async (response) => {
        const client = new HttpClient({
          baseUrl: ORIGIN,
          token: EDITOR_TOKEN,
          fetch: fetchReplying(response),
        });

        return failureOf(await client.request('session.get', { params: { id: SESSION_ID } }));
      }),
    );

    expect(failures.map((error) => error.code)).toEqual([
      'INTERNAL',
      'STORE_ERROR',
      'SESSION_NOT_FOUND',
    ]);
    expect(failures[0]?.hint).toEqual(expect.stringContaining('rate-limiting'));
    expect(failures[1]?.hint).toEqual(expect.stringContaining('its log names the stage'));
    expect(failures[2]?.hint).toBeUndefined();
  });

  it('names the owning session when capture.start answers 409', async () => {
    const fetch = fetchReplying(
      reply(409, {
        code: CAPTURE_CONFLICT_ERROR_CODE,
        message: 'Another session is capturing this project',
        owningSessionId: OWNING_SESSION_ID,
      }),
    );
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });

    const error = failureOf(await client.startCapture(SESSION_ID));

    expect(error.code).toBe(CAPTURE_CONFLICT_ERROR_CODE);
    expect(error.details).toEqual({
      operation: 'capture.start',
      status: 409,
      owningSessionId: OWNING_SESSION_ID,
    });

    const { url, init } = onlyCall(fetch);

    expect(url).toBe(`${ORIGIN}${buildPath('capture.start', { id: SESSION_ID })}`);
    expect(init.body).toBe('{}');
  });
});

// ---------------------------------------------------------------------------
// The editor's target request
// ---------------------------------------------------------------------------

describe('HttpClient — the target.request operation', () => {
  /** The Chrome tab the session is bound to. */
  const TAB_ID = 7;

  /** The arguments of a valid call for the fixture session. */
  const TARGET_REQUEST_ARGS: HttpRequestArgs<'target.request'> = {
    params: { id: SESSION_ID },
    body: {},
  };

  it('posts an empty body with the editor credential and parses the session and tab it reached', async () => {
    const fetch = fetchReplying(reply(200, { sessionId: SESSION_ID, tabId: TAB_ID }));
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });

    const answer = valueOf(await client.request('target.request', TARGET_REQUEST_ARGS));

    expect(answer).toEqual({ sessionId: SESSION_ID, tabId: TAB_ID });

    const { url, init } = onlyCall(fetch);

    expect(url).toBe(`${ORIGIN}/sessions/${SESSION_ID}/target/request`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(init.headers?.[AUTHORIZATION_HEADER]).toBe(formatBearer(EDITOR_TOKEN));
  });

  it('refuses a body carrying any key locally, before a credential is resolved', async () => {
    const fetch = fetchReplying(reply(200, { sessionId: SESSION_ID, tabId: TAB_ID }));
    const token = vi.fn<TokenProvider>(() => EDITOR_TOKEN);
    const client = new HttpClient({ baseUrl: ORIGIN, token, fetch });
    const invalid: unknown = { tabId: TAB_ID, note: MARKER };

    const error = failureOf(
      await client.request('target.request', {
        params: { id: SESSION_ID },
        body: invalid as HttpRequestBody<'target.request'>,
      }),
    );

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(fetch).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
    expect(reachableText(error)).not.toContain(MARKER);
  });

  it('reports a 2xx reply without the tab as a protocol failure, with the status attached', async () => {
    const client = new HttpClient({
      baseUrl: ORIGIN,
      token: EDITOR_TOKEN,
      fetch: fetchReplying(reply(200, { sessionId: SESSION_ID })),
    });

    const error = failureOf(await client.request('target.request', TARGET_REQUEST_ARGS));

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(error.details).toEqual(
      expect.objectContaining({ operation: 'target.request', status: 200 }),
    );
  });

  it.each([
    [404, 'SESSION_NOT_FOUND', 'No such session'],
    [409, 'SESSION_INVALID_STATE', 'The session has ended'],
    [409, 'TAB_NOT_BOUND', 'No DevTools tab is bound to this session'],
    [503, 'TRANSPORT_DISCONNECTED', 'The bound tab is offline'],
  ] as const)(
    'keeps the route’s documented %i %s refusal as the service sent it',
    async (status, code, message) => {
      const client = new HttpClient({
        baseUrl: ORIGIN,
        token: EDITOR_TOKEN,
        fetch: fetchReplying(reply(status, { code, message })),
      });

      const error = failureOf(await client.request('target.request', TARGET_REQUEST_ARGS));

      expect(error.code).toBe(code);
      expect(error.details).toEqual(
        expect.objectContaining({ operation: 'target.request', status }),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// The transport failing
// ---------------------------------------------------------------------------

describe('HttpClient — a transport that fails', () => {
  /**
   * Asserts the shape every transport failure shares.
   *
   * @param error The failure.
   */
  function expectTransportFailure(error: DebuggenError): void {
    expect(error.code).toBe('TRANSPORT_DISCONNECTED');
    expect(error.message).toBe(`The session.list request to ${ORIGIN} did not complete`);
    expect(error.details).toEqual({ operation: 'session.list', baseUrl: ORIGIN });
    expect(error.cause).toBeInstanceOf(DebuggenError);
    expect(error.hint).toEqual(expect.stringContaining(ORIGIN));
  }

  it('reports a transport that throws synchronously', async () => {
    const fetch = vi.fn<FetchLike>(() => {
      throw new TypeError('no route to host');
    });
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });

    expectTransportFailure(failureOf(await client.request('session.list')));
  });

  it('reports a transport that rejects, and logs that it did not complete', async () => {
    const { logger, records } = capturingLogger();
    const fetch = vi.fn<FetchLike>(() => Promise.reject(new TypeError('fetch failed')));
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch, logger });

    expectTransportFailure(failureOf(await client.request('session.list')));
    expect(records.map(({ message }) => message)).toEqual([
      'protocol http request did not complete',
    ]);
  });

  it('reports a body read that throws synchronously', async () => {
    const response: HttpResponseLike = {
      ok: true,
      status: 200,
      text: () => {
        throw new Error('stream locked');
      },
    };
    const client = new HttpClient({
      baseUrl: ORIGIN,
      token: EDITOR_TOKEN,
      fetch: fetchReplying(response),
    });

    expectTransportFailure(failureOf(await client.request('session.list')));
  });

  it('reports a body read that rejects', async () => {
    const response: HttpResponseLike = {
      ok: true,
      status: 200,
      text: () => Promise.reject(new Error('connection reset')),
    };
    const client = new HttpClient({
      baseUrl: ORIGIN,
      token: EDITOR_TOKEN,
      fetch: fetchReplying(response),
    });

    expectTransportFailure(failureOf(await client.request('session.list')));
  });

  it('never rejects, whatever the transport, the body or the provider throws', async () => {
    const hostile: readonly HttpClient[] = [
      new HttpClient({
        baseUrl: ORIGIN,
        token: EDITOR_TOKEN,
        fetch: vi.fn<FetchLike>(() => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- a hostile transport throwing a non-Error is the case under test
          throw 'not an error';
        }),
      }),
      new HttpClient({
        baseUrl: ORIGIN,
        token: EDITOR_TOKEN,
        fetch: vi.fn<FetchLike>(() =>
          Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('[') }),
        ),
      }),
      new HttpClient({
        baseUrl: ORIGIN,
        token: (): string => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- a hostile provider throwing a non-Error is the case under test
          throw null;
        },
        fetch: fetchReplying(reply(200, {})),
      }),
    ];

    for (const client of hostile) {
      await expect(client.request('session.list')).resolves.toEqual(
        expect.objectContaining({ ok: false }),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Cancellation (R1-F07)
// ---------------------------------------------------------------------------

describe('HttpClient — cancellation is established before the credential is resolved', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('ends a call whose credential provider never settles at the timeout', async () => {
    const fetch = fetchReplying(reply(200, EMPTY_SESSION_PAGE));
    const late = deferred<string | undefined>();
    const token = vi.fn<TokenProvider>(() => late.promise);
    const { logger, records } = capturingLogger();
    const client = new HttpClient({ baseUrl: ORIGIN, token, fetch, logger });
    let settled = false;

    const pending = client.request('session.list', { timeoutMs: 1_000 });
    void pending.then(() => {
      settled = true;
    });

    expect(token).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const error = failureOf(await pending);

    expect(error.code).toBe('TRANSPORT_DISCONNECTED');
    expect(error.message).toBe('The session.list request timed out after 1000 ms');
    expect(error.details).toEqual({
      operation: 'session.list',
      cancelled: 'timeout',
      timeoutMs: 1_000,
    });
    expect(vi.getTimerCount()).toBe(0);

    // The credential arrives after the call ended: it must never be sent.
    late.resolve(EDITOR_TOKEN);
    await drainMicrotasks();

    expect(fetch).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it('applies the client default timeout to credential resolution too', async () => {
    const fetch = fetchReplying(reply(200, EMPTY_SESSION_PAGE));
    const late = deferred<string | undefined>();
    const client = new HttpClient({
      baseUrl: ORIGIN,
      token: () => late.promise,
      fetch,
      defaultTimeoutMs: 250,
    });

    const pending = client.request('session.list');
    await vi.advanceTimersByTimeAsync(250);

    expect(failureOf(await pending).details).toEqual({
      operation: 'session.list',
      cancelled: 'timeout',
      timeoutMs: 250,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets a per-call timeout override the client default', async () => {
    const late = deferred<string | undefined>();
    const client = new HttpClient({
      baseUrl: ORIGIN,
      token: () => late.promise,
      fetch: fetchReplying(reply(200, {})),
      defaultTimeoutMs: 10_000,
    });

    const pending = client.request('session.list', { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);

    expect(failureOf(await pending).details).toEqual(
      expect.objectContaining({ cancelled: 'timeout', timeoutMs: 50 }),
    );
  });

  it('answers a signal that had already fired without reading a credential or sending', async () => {
    const fetch = fetchReplying(reply(200, HEALTH_REPLY));
    const token = vi.fn<TokenProvider>(() => EDITOR_TOKEN);
    const client = new HttpClient({ baseUrl: ORIGIN, token, fetch, defaultTimeoutMs: 1_000 });
    const caller = new AbortController();

    caller.abort();

    for (const operation of ['session.list', 'health'] as const) {
      const error = failureOf(await client.request(operation, { signal: caller.signal }));

      expect(error.code).toBe('TRANSPORT_DISCONNECTED');
      expect(error.message).toBe(`The ${operation} request was cancelled`);
      expect(error.details).toEqual({ operation, cancelled: 'aborted', timeoutMs: 1_000 });
    }

    expect(token).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends the call when the caller aborts during credential resolution, and ignores the late credential', async () => {
    const fetch = fetchReplying(reply(200, EMPTY_SESSION_PAGE));
    const late = deferred<string | undefined>();
    const client = new HttpClient({ baseUrl: ORIGIN, token: () => late.promise, fetch });
    const caller = new AbortController();
    const added = vi.spyOn(caller.signal, 'addEventListener');
    const removed = vi.spyOn(caller.signal, 'removeEventListener');

    const pending = client.request('session.list', { signal: caller.signal });
    await drainMicrotasks();
    caller.abort();

    const error = failureOf(await pending);

    expect(error.details).toEqual({ operation: 'session.list', cancelled: 'aborted' });

    late.resolve(EDITOR_TOKEN);
    await drainMicrotasks();

    expect(fetch).not.toHaveBeenCalled();
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls[0]?.[1]).toBe(added.mock.calls[0]?.[1]);
  });

  it('aborts the signal handed to a stalled transport when the timeout elapses', async () => {
    const stalled = deferred<HttpResponseLike>();
    const fetch = vi.fn<FetchLike>(() => stalled.promise);
    const { logger, records } = capturingLogger();
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch, logger });

    const pending = client.request('session.list', { timeoutMs: 500 });
    await drainMicrotasks();

    const { init } = onlyCall(fetch);

    expect(init.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    const error = failureOf(await pending);

    expect(error.details).toEqual({
      operation: 'session.list',
      cancelled: 'timeout',
      timeoutMs: 500,
    });
    expect(init.signal?.aborted).toBe(true);
    expect(records).toEqual([
      {
        level: 'debug',
        message: 'protocol http request did not complete',
        fields: { operation: 'session.list', cancelled: 'timeout', elapsedMs: 500 },
      },
    ]);

    // A reply that arrives after the deadline is never read.
    const text = vi.fn(() => Promise.resolve('{"sessions":[]}'));
    stalled.resolve({ ok: true, status: 200, text });
    await drainMicrotasks();

    expect(text).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('classifies a transport rejection caused by the abort as a cancellation', async () => {
    const fetch = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise<HttpResponseLike>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('The operation was aborted'));
            },
            { once: true },
          );
        }),
    );
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });

    const pending = client.request('session.list', { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);

    const error = failureOf(await pending);

    expect(error.code).toBe('TRANSPORT_DISCONNECTED');
    expect(error.details).toEqual({
      operation: 'session.list',
      cancelled: 'timeout',
      timeoutMs: 100,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards the caller's abort to the transport's signal, with the caller's reason", async () => {
    const stalled = deferred<HttpResponseLike>();
    const fetch = vi.fn<FetchLike>(() => stalled.promise);
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });
    const caller = new AbortController();
    const reason = new Error('view disposed');

    const pending = client.request('session.list', { signal: caller.signal });
    await drainMicrotasks();

    const { init } = onlyCall(fetch);

    // The transport receives the call's own linked signal, not the caller's.
    expect(init.signal).not.toBe(caller.signal);

    caller.abort(reason);
    const error = failureOf(await pending);

    expect(error.details).toEqual({ operation: 'session.list', cancelled: 'aborted' });
    expect(init.signal?.aborted).toBe(true);
    expect(init.signal?.reason).toBe(reason);
  });

  it('reports a transport that throws after the caller aborted as a cancellation', async () => {
    const caller = new AbortController();
    const fetch = vi.fn<FetchLike>(() => {
      caller.abort();
      throw new Error('The operation was aborted');
    });
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });

    const error = failureOf(await client.request('session.list', { signal: caller.signal }));

    expect(error.code).toBe('TRANSPORT_DISCONNECTED');
    expect(error.details).toEqual({ operation: 'session.list', cancelled: 'aborted' });
  });

  it('keeps a timer that could not be cleared inert once the call has ended', async () => {
    const client = new HttpClient({
      baseUrl: ORIGIN,
      token: EDITOR_TOKEN,
      fetch: fetchReplying(reply(200, EMPTY_SESSION_PAGE)),
    });
    let result: Result<unknown, DebuggenError> | undefined;

    vi.stubGlobal('clearTimeout', undefined);

    try {
      result = await client.request('session.list', { timeoutMs: 100 });
    } finally {
      vi.unstubAllGlobals();
    }

    // Without clearTimeout the handle survives the call, and firing it later
    // must change nothing the call already answered.
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100);

    expect(vi.getTimerCount()).toBe(0);
    expect(valueOf(result)).toEqual(EMPTY_SESSION_PAGE);
  });

  it('ends a call whose body read stalls at the timeout', async () => {
    const stalledBody = deferred<string>();
    const response: HttpResponseLike = { ok: true, status: 200, text: () => stalledBody.promise };
    const { logger, records } = capturingLogger();
    const client = new HttpClient({
      baseUrl: ORIGIN,
      token: EDITOR_TOKEN,
      fetch: fetchReplying(response),
      logger,
    });

    const pending = client.request('session.list', { timeoutMs: 300 });
    await vi.advanceTimersByTimeAsync(300);

    expect(failureOf(await pending).details).toEqual({
      operation: 'session.list',
      cancelled: 'timeout',
      timeoutMs: 300,
    });
    expect(records).toEqual([
      {
        level: 'debug',
        message: 'protocol http request did not complete',
        fields: { operation: 'session.list', status: 200, cancelled: 'timeout', elapsedMs: 300 },
      },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timer and listener once a call succeeds', async () => {
    const fetch = fetchReplying(reply(200, EMPTY_SESSION_PAGE));
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });
    const caller = new AbortController();
    const removed = vi.spyOn(caller.signal, 'removeEventListener');

    valueOf(await client.request('session.list', { signal: caller.signal, timeoutMs: 5_000 }));

    expect(vi.getTimerCount()).toBe(0);
    expect(removed).toHaveBeenCalledTimes(1);

    // An abort after the call ended changes nothing the call already answered.
    caller.abort();
    expect(onlyCall(fetch).init.signal?.aborted).toBe(false);
  });

  it('clears its timer on every failure path', async () => {
    const clients = [
      new HttpClient({ baseUrl: ORIGIN, fetch: fetchReplying(reply(200, {})) }),
      new HttpClient({
        baseUrl: ORIGIN,
        token: EDITOR_TOKEN,
        fetch: fetchReplying(reply(401, '')),
      }),
      new HttpClient({
        baseUrl: ORIGIN,
        token: EDITOR_TOKEN,
        fetch: fetchReplying(reply(200, '[')),
      }),
      new HttpClient({
        baseUrl: ORIGIN,
        token: EDITOR_TOKEN,
        fetch: vi.fn<FetchLike>(() => Promise.reject(new Error('refused'))),
      }),
    ];

    for (const client of clients) {
      failureOf(await client.request('session.list', { timeoutMs: 5_000 }));
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'treats a timeout of %d as no timeout',
    async (timeoutMs) => {
      const stalled = deferred<HttpResponseLike>();
      const fetch = vi.fn<FetchLike>(() => stalled.promise);
      const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });

      const pending = client.request('session.list', { timeoutMs });
      await drainMicrotasks();

      expect(vi.getTimerCount()).toBe(0);
      expect(onlyCall(fetch).init).not.toHaveProperty('signal');

      stalled.resolve(reply(200, EMPTY_SESSION_PAGE));

      expect(valueOf(await pending)).toEqual(EMPTY_SESSION_PAGE);
    },
  );

  it('schedules a timeout beyond the platform timer limit at that limit, not immediately', async () => {
    const stalled = deferred<HttpResponseLike>();
    const client = new HttpClient({
      baseUrl: ORIGIN,
      token: EDITOR_TOKEN,
      fetch: vi.fn<FetchLike>(() => stalled.promise),
    });
    let settled = false;

    const pending = client.request('session.list', { timeoutMs: 1e12 });
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(settled).toBe(false);

    stalled.resolve(reply(200, EMPTY_SESSION_PAGE));

    expect(valueOf(await pending)).toEqual(EMPTY_SESSION_PAGE);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still enforces the timeout and the caller signal in a runtime without AbortController', async () => {
    const stalled = deferred<HttpResponseLike>();
    const fetch = vi.fn<FetchLike>(() => stalled.promise);
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });
    const caller = new AbortController();

    vi.stubGlobal('AbortController', undefined);
    const pending = client.request('session.list', { signal: caller.signal, timeoutMs: 100 });
    vi.unstubAllGlobals();
    await drainMicrotasks();

    // Without a controller to link through, the caller's own signal is sent.
    expect(onlyCall(fetch).init.signal).toBe(caller.signal);

    await vi.advanceTimersByTimeAsync(100);

    expect(failureOf(await pending).details).toEqual({
      operation: 'session.list',
      cancelled: 'timeout',
      timeoutMs: 100,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('degrades to no timeout in a runtime without timers', async () => {
    const stalled = deferred<HttpResponseLike>();
    const fetch = vi.fn<FetchLike>(() => stalled.promise);
    const client = new HttpClient({ baseUrl: ORIGIN, token: EDITOR_TOKEN, fetch });

    vi.stubGlobal('setTimeout', undefined);
    const pending = client.request('session.list', { timeoutMs: 100 });
    vi.unstubAllGlobals();
    await drainMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onlyCall(fetch).init.signal?.aborted).toBe(false);

    stalled.resolve(reply(200, EMPTY_SESSION_PAGE));

    expect(valueOf(await pending)).toEqual(EMPTY_SESSION_PAGE);
  });
});

// ---------------------------------------------------------------------------
// Logging and non-leakage
// ---------------------------------------------------------------------------

describe('HttpClient — what a log record and a failure may carry', () => {
  it('logs one record per exchange, with the operation, the status and the elapsed time only', async () => {
    const { logger, records } = capturingLogger();
    const body = { projectRoot: `/home/example/${MARKER}`, question: `Why is ${MARKER} slow?` };
    const client = new HttpClient({
      baseUrl: ORIGIN,
      token: EDITOR_TOKEN,
      fetch: fetchReplying(reply(500, { code: 'INTERNAL', message: 'Stage failed' })),
      logger,
    });

    failureOf(await client.request('session.create', { body }));
    failureOf(await client.pairComplete(PAIRING_CODE));

    expect(records).toHaveLength(2);

    for (const record of records) {
      expect(record.level).toBe('debug');
      expect(record.message).toBe('protocol http request completed');
      expect(Object.keys(record.fields).every((key) => ALLOWED_LOG_FIELDS.includes(key))).toBe(
        true,
      );
      expect(record.fields).toEqual(expect.objectContaining({ status: 500 }));
    }

    const logged = JSON.stringify(records);

    for (const secret of [EDITOR_TOKEN, PAIRING_CODE, MARKER, ORIGIN, '/sessions', '/pair']) {
      expect(logged).not.toContain(secret);
    }
  });

  it('keeps the credential, the bodies, the pairing code and the origin spelling out of every failure', async () => {
    const requestBody = {
      projectRoot: `/home/example/${MARKER}`,
      question: `Why is ${MARKER} slow?`,
    };
    const responses: readonly HttpResponseLike[] = [
      reply(200, { id: MARKER }),
      reply(200, `${MARKER}{`),
      reply(401, { code: 'UNAUTHORIZED', message: 'Credential refused', leaked: MARKER }),
      reply(500, `trace: ${MARKER}`),
      reply(409, { code: 'INTERNAL', message: 'Conflict', owningSessionId: 42, note: MARKER }),
    ];
    const failures: DebuggenError[] = [];

    for (const response of responses) {
      const client = new HttpClient({
        baseUrl: 'http://127.1:43117/',
        token: EDITOR_TOKEN,
        fetch: fetchReplying(response),
      });

      failures.push(failureOf(await client.request('session.create', { body: requestBody })));
      failures.push(failureOf(await client.pairComplete(PAIRING_CODE)));
    }

    const rejected = new HttpClient({
      baseUrl: ORIGIN,
      token: EDITOR_TOKEN,
      fetch: vi.fn<FetchLike>(() => Promise.reject(new Error('socket hang up'))),
    });

    failures.push(failureOf(await rejected.request('session.create', { body: requestBody })));
    failures.push(failureOf(await rejected.pairComplete(PAIRING_CODE)));

    for (const failure of failures) {
      const exposed = reachableText(failure);

      expect(exposed).not.toContain(EDITOR_TOKEN);
      expect(exposed).not.toContain(MARKER);
      expect(exposed).not.toContain(PAIRING_CODE);
      expect(exposed).not.toContain('127.1:');
      expect(JSON.stringify(failure.toPayload())).not.toContain(MARKER);
    }
  });
});
