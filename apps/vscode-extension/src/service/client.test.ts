/**
 * Tests for `./client.ts`: no thrown value's text reaches a log record.
 *
 * Every record the service client emits lands in the editor's
 * `LogOutputChannel` unredacted — `src/extension.ts` prints each record's
 * fields as JSON — so a caught value may be logged only as its projection:
 * {@link errorClassOf}'s closed class vocabulary, a `DebuggenError` code with
 * the class of its cause, and a Node error code only when it is a known system
 * or Node code — an invented `code` in an errno-like shape is dropped. Every
 * such record carries a correlation reference and the callback or frame kind
 * it concerns; a failure that is also returned to a caller names the same
 * reference (CWE-532; AAP §0.5.2).
 *
 * Each case plants sentinel secrets in a thrown value — a developer path, a
 * `?token=` URL and a provider-key shape in the message, a custom `name`, a
 * stack frame naming a private function — alongside the editor credential,
 * drives one catch site through the seam the client really exposes (the
 * injected WebSocket constructor, fetch, configuration source or credential
 * store), and asserts that no sentinel appears in any record at any level:
 * neither in its message nor in its fields, rendered both as JSON (what the
 * output channel prints) and through `util.inspect` (what a console sink
 * would print). The logger records at `trace`, so the debug-level records of
 * the protocol transports underneath are held to the same rule.
 *
 * ## The `vscode` substitute
 *
 * The editor supplies the `vscode` module at runtime and no installable
 * package provides it, so `vi.mock` registers a factory for the bare
 * specifier. Every case injects its own configuration source, so the
 * substitute only has to exist; its members answer nothing.
 *
 * The sentinels are assembled from fragments, so this tracked file carries no
 * contiguous credential shape for `pnpm check:secrets` to report.
 *
 * ## The journal walk
 *
 * The last block drives {@link readModificationJournal} against a scripted
 * `getModifications`: one request for a one-page journal, every page gathered
 * in order and de-duplicated by id, a later page's failure or throw kept as an
 * incomplete read with the records already gathered, a first page's failure
 * returned as it is, the defensive stops (a page that does not advance, the
 * page cap), the overall deadline bounding each page's `timeoutMs`, the abort
 * signal, and the endpoint and signal forwarded to every page.
 */

import { inspect } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvelope, encodeMessage } from '@debuggen/protocol';
import type {
  FetchLike,
  HttpResponseLike,
  ListPageRequest,
  ModificationRecord,
  ModificationsResponse,
  TimerApi,
  WebSocketConstructorLike,
  WebSocketLike,
  WsEventMapLike,
} from '@debuggen/protocol';
import { DebuggenError, createConsoleLogger, err, isErr, isOk, ok } from '@debuggen/shared';
import type { LogRecord, Result } from '@debuggen/shared';

import {
  MODIFICATION_JOURNAL_PAGE_CAP,
  createServiceClient,
  errorClassOf,
  readModificationJournal,
} from './client';
import type {
  ModificationJournalRead,
  ServiceClient,
  ServiceClientConfiguration,
  ServiceClientOptions,
  ServiceCredential,
  SessionEndpointCallOptions,
} from './client';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
  },
}));

// ---------------------------------------------------------------------------
// Sentinels
// ---------------------------------------------------------------------------

/** A developer path, as a stack frame or a file-system error quotes one. */
const SENTINEL_PATH = ['', 'home', 'sentinel-dev', 'private-project', 'src', 'checkout.ts'].join(
  '/',
);

/** A query credential, as a URL-parsing error quotes one. */
const SENTINEL_QUERY = ['token', ['sentinel', 'query', '7f3a9c'].join('-')].join('=');

/** A provider-key shape, as a failed model call might quote one. */
const SENTINEL_KEY = ['sk', 'ant', 'sentinel0123456789abcdef'].join('-');

/** A custom error name: free text the thrower chose. */
const SENTINEL_NAME = 'SentinelLeakyError';

/** A function name that appears only in the planted stack. */
const SENTINEL_FRAME = 'sentinelPrivateFrame';

/** The editor credential the fake store hands out; it must never be logged either. */
const EDITOR_TOKEN = ['editor', 'credential', 'sentinel', '5b1e'].join('_');

/**
 * Every value a record must not contain. The last entry is the common stem
 * of all of them, so a partial quotation is caught as well.
 */
const SENTINELS: readonly string[] = [
  SENTINEL_PATH,
  SENTINEL_QUERY,
  SENTINEL_KEY,
  SENTINEL_NAME,
  SENTINEL_FRAME,
  EDITOR_TOKEN,
  'sentinel',
];

/**
 * Codes a thrower invented in the shapes a pattern such as `E…`/`ERR_…` would
 * have admitted — each could be a credential. None is a system or Node error
 * code, so none may be logged.
 */
const INVENTED_CODES: readonly string[] = [
  ['E', 'PRIVATECREDENTIAL', '123'].join(''),
  ['ERR', 'PRIVATE', 'TOKEN', '7F3A'].join('_'),
  ['UND', 'ERR', 'PRIVATE', 'KEY'].join('_'),
];

/** Any correlation reference `newMessageId()` mints: `msg_` and sixteen characters. */
const ANY_REF: unknown = expect.stringMatching(/^msg_[0-9a-z]{16}$/u);

/** The service origin every case is configured with. */
const SERVICE_URL = 'http://127.0.0.1:43117';

/** A session id of the product's `ses_…` shape. */
const SESSION_ID = 'ses_4k2p9dq7m1zx0c3v';

/** The text every planted message carries. */
function sentinelText(): string {
  return `could not load ${SENTINEL_PATH} from ${SERVICE_URL}/checkout?${SENTINEL_QUERY} using ${SENTINEL_KEY}`;
}

/** A stack whose header and frame both carry sentinels. */
function sentinelStack(header: string): string {
  return `${header}: ${sentinelText()}\n    at ${SENTINEL_FRAME} (${SENTINEL_PATH}:12:7)`;
}

/** An `Error` with a sentinel message, a custom (unlisted) name and a sentinel stack. */
function leakyError(): Error {
  const error = new Error(sentinelText());
  error.name = SENTINEL_NAME;
  error.stack = sentinelStack(SENTINEL_NAME);
  return error;
}

/** A `TypeError` — a listed class — with a sentinel message and stack. */
function leakyTypeError(): TypeError {
  const error = new TypeError(sentinelText());
  error.stack = sentinelStack('TypeError');
  return error;
}

/** `error` with a `code` property, as Node attaches an errno. */
function withCode<E extends Error>(error: E, code: string): E & { readonly code: string } {
  return Object.assign(error, { code });
}

/** Throws `value` as it is, for the cases that throw something other than an `Error`. */
function throwValue(value: unknown): never {
  throw value;
}

// ---------------------------------------------------------------------------
// The capturing logger
// ---------------------------------------------------------------------------

/** A logger at `trace` and the records it received, each copied as emitted. */
interface CapturedLog {
  readonly logger: ReturnType<typeof createConsoleLogger>;
  readonly records: LogRecord[];
}

/** A logger that keeps every record, at every level, instead of printing it. */
function captureLog(): CapturedLog {
  const records: LogRecord[] = [];
  const logger = createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      records.push({ ...record, fields: { ...record.fields } });
    },
  });
  return { logger, records };
}

/** One record, rendered every way a sink could print it, lower-cased. */
function renderRecord(record: LogRecord): string {
  return [
    record.message,
    JSON.stringify(record.fields),
    inspect(record.fields, { depth: 8, showHidden: true }),
  ]
    .join('\n')
    .toLowerCase();
}

/** Fails the case when any record, at any level, carries any sentinel. */
function expectNoLeak(records: readonly LogRecord[]): void {
  expect(records.length).toBeGreaterThan(0);
  for (const record of records) {
    const rendered = renderRecord(record);
    for (const sentinel of SENTINELS) {
      expect(rendered, `${record.level} record "${record.message}"`).not.toContain(
        sentinel.toLowerCase(),
      );
    }
  }
}

/** The one record with `message`; fails the case unless exactly one was emitted. */
function recordOf(records: readonly LogRecord[], message: string): LogRecord {
  const matching = records.filter((record) => record.message === message);
  expect(matching, `records named "${message}"`).toHaveLength(1);
  const [record] = matching;
  if (record === undefined) {
    throw new Error(`expected a record named "${message}"`);
  }
  return record;
}

// ---------------------------------------------------------------------------
// The fake transports
// ---------------------------------------------------------------------------

/** The `readyState` values both real socket implementations use. */
const READY_STATE = Object.freeze({ connecting: 0, open: 1, closing: 2, closed: 3 });

/** The listeners a fake socket holds, per event. */
type ListenerSets = {
  [K in keyof WsEventMapLike]: Set<(event: WsEventMapLike[K]) => void>;
};

/** A socket a case drives by hand: it opens, receives and drops on request. */
class FakeSocket implements WebSocketLike {
  readyState: number = READY_STATE.connecting;

  /** Every frame the client wrote, in order. */
  readonly sent: string[] = [];

  readonly #listeners: ListenerSets = {
    open: new Set(),
    message: new Set(),
    close: new Set(),
    error: new Set(),
  };

  addEventListener<K extends keyof WsEventMapLike>(
    type: K,
    listener: (event: WsEventMapLike[K]) => void,
  ): void {
    this.#listeners[type].add(listener);
  }

  removeEventListener<K extends keyof WsEventMapLike>(
    type: K,
    listener: (event: WsEventMapLike[K]) => void,
  ): void {
    this.#listeners[type].delete(listener);
  }

  send(data: string): void {
    if (this.readyState !== READY_STATE.open) {
      throw new Error('the socket is not open');
    }
    this.sent.push(data);
  }

  close(): void {
    this.readyState = READY_STATE.closing;
  }

  /** The transport opened: the socket becomes writable and `open` fires. */
  open(): void {
    this.readyState = READY_STATE.open;
    this.#emit('open', { type: 'open' });
  }

  /** A text frame arrived. */
  receive(data: string): void {
    this.#emit('message', { data });
  }

  /** The peer closed the connection with `code` and `reason`. */
  drop(code: number, reason: string): void {
    this.readyState = READY_STATE.closed;
    this.#emit('close', { code, reason });
  }

  #emit<K extends keyof WsEventMapLike>(type: K, event: WsEventMapLike[K]): void {
    for (const listener of [...this.#listeners[type]]) {
      listener(event);
    }
  }
}

/** The injected constructor and every socket it built. */
interface FakeTransport {
  readonly webSocketConstructor: WebSocketConstructorLike;
  readonly sockets: FakeSocket[];
}

/** A constructor with its own registry, so no case sees another case's sockets. */
function createTransport(): FakeTransport {
  const sockets: FakeSocket[] = [];
  class RecordingSocket extends FakeSocket {
    constructor() {
      super();
      sockets.push(this);
    }
  }
  return { webSocketConstructor: RecordingSocket, sockets };
}

/** A constructor that always throws `thrown`, as `ws` does for a URL it refuses. */
function throwingConstructor(thrown: unknown): WebSocketConstructorLike {
  return class RefusingSocket extends FakeSocket {
    constructor() {
      super();
      throwValue(thrown);
    }
  };
}

/** Timers that never fire: no reconnect and no hello deadline runs during a case. */
function inertTimers(): TimerApi {
  let next = 1;
  return {
    setTimeout: () => {
      next += 1;
      return next;
    },
    clearTimeout: () => undefined,
  };
}

/** A fetch that answers every call with `response`. */
function answering(response: HttpResponseLike): FetchLike {
  return () => Promise.resolve(response);
}

/**
 * A response whose `status` getter throws — a read `HttpClient` makes outside
 * its guards, so the call rejects and reaches the client's own catch.
 */
function responseThrowing(thrown: Error): HttpResponseLike {
  return {
    ok: true,
    get status(): number {
      throw thrown;
    },
    text: () => Promise.resolve('{}'),
  };
}

/** An editor credential store holding {@link EDITOR_TOKEN}, with overridable members. */
function fakeCredential(overrides: Partial<ServiceCredential> = {}): ServiceCredential {
  return {
    token: () => EDITOR_TOKEN,
    read: () => Promise.resolve(ok(EDITOR_TOKEN)),
    refresh: () => Promise.resolve(ok(EDITOR_TOKEN)),
    ...overrides,
  };
}

/** A configuration source answering {@link SERVICE_URL} and never changing. */
function fixedConfiguration(): ServiceClientConfiguration {
  return {
    readServiceUrl: () => SERVICE_URL,
    onDidChangeServiceUrl: () => ({ dispose: () => undefined }),
  };
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

/** One client under test, its log and its sockets. */
interface Harness {
  readonly client: ServiceClient;
  readonly records: LogRecord[];
  readonly transport: FakeTransport;
}

/** Every client a case built, disposed after it. */
const created: ServiceClient[] = [];

afterEach(() => {
  for (const client of created.splice(0)) {
    client.dispose();
  }
});

/** A client on fake transports and a capturing logger; `overrides` replace any seam. */
function createHarness(overrides: Partial<ServiceClientOptions> = {}): Harness {
  const { logger, records } = captureLog();
  const transport = createTransport();
  const client = createServiceClient({
    credential: fakeCredential(),
    configuration: fixedConfiguration(),
    webSocketConstructor: transport.webSocketConstructor,
    fetch: answering({ ok: true, status: 200, text: () => Promise.resolve('{}') }),
    timers: inertTimers(),
    random: () => 0.5,
    ...overrides,
    logger,
  });
  created.push(client);
  return { client, records, transport };
}

/** Lets pending promise continuations and immediates run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** The socket the client constructed last; fails the case when there is none. */
function latestSocket(transport: FakeTransport): FakeSocket {
  const socket = transport.sockets.at(-1);
  if (socket === undefined) {
    throw new Error('expected the client to have constructed a socket');
  }
  return socket;
}

/** Connects, opens the socket (the hello is written) and lets the handshake settle. */
async function openConnection(harness: Harness): Promise<FakeSocket> {
  harness.client.connect();
  const socket = latestSocket(harness.transport);
  socket.open();
  await settle();
  return socket;
}

/** A valid inbound `session.progress` frame, as text. */
function progressFrame(): string {
  return encodeMessage(
    createEnvelope('session.progress', {
      sessionId: SESSION_ID,
      stage: 'investigate',
      status: 'done',
      message: 'Traced the click handler',
    }),
  );
}

// ---------------------------------------------------------------------------
// errorClassOf
// ---------------------------------------------------------------------------

describe('errorClassOf', () => {
  it('names the listed native classes, DOMException names and DebuggenError', () => {
    expect(errorClassOf(new Error(sentinelText()))).toBe('Error');
    expect(errorClassOf(leakyTypeError())).toBe('TypeError');
    expect(errorClassOf(new RangeError(sentinelText()))).toBe('RangeError');
    expect(errorClassOf(new SyntaxError(sentinelText()))).toBe('SyntaxError');
    expect(errorClassOf(new ReferenceError(sentinelText()))).toBe('ReferenceError');
    expect(errorClassOf(new EvalError(sentinelText()))).toBe('EvalError');
    expect(errorClassOf(new URIError(sentinelText()))).toBe('URIError');
    expect(errorClassOf(new AggregateError([leakyError()], sentinelText()))).toBe('AggregateError');
    expect(errorClassOf(new DOMException(sentinelText(), 'AbortError'))).toBe('AbortError');
    expect(errorClassOf(new DOMException(sentinelText(), 'TimeoutError'))).toBe('TimeoutError');
    expect(errorClassOf(new DebuggenError('INTERNAL', sentinelText()))).toBe('DebuggenError');
  });

  it('reports any other error class as unlisted, never by its name', () => {
    class SentinelLeakyError extends Error {
      override readonly name = SENTINEL_NAME;
    }
    expect(errorClassOf(leakyError())).toBe('unlisted');
    expect(errorClassOf(new SentinelLeakyError(sentinelText()))).toBe('unlisted');
    expect(errorClassOf(new DOMException(sentinelText(), SENTINEL_NAME))).toBe('unlisted');
  });

  it('answers only the typeof of a thrown value that is not an Error', () => {
    expect(errorClassOf(sentinelText())).toBe('string');
    expect(errorClassOf({ message: sentinelText(), stack: SENTINEL_FRAME })).toBe('object');
    expect(errorClassOf(null)).toBe('object');
    expect(errorClassOf(undefined)).toBe('undefined');
    expect(errorClassOf(404)).toBe('number');
    expect(errorClassOf(Symbol(SENTINEL_KEY))).toBe('symbol');
    expect(errorClassOf(() => SENTINEL_KEY)).toBe('function');
  });

  it('never throws for a value whose getters or proxy traps throw', () => {
    const hostileName = new Error(sentinelText());
    Object.defineProperty(hostileName, 'name', {
      get(): never {
        throw leakyError();
      },
    });
    const hostileProxy = new Proxy(
      {},
      {
        getPrototypeOf: () => throwValue(leakyError()),
        getOwnPropertyDescriptor: () => throwValue(leakyError()),
        get: () => throwValue(leakyError()),
        has: () => throwValue(leakyError()),
      },
    );
    expect(errorClassOf(hostileName)).toBe('unlisted');
    expect(errorClassOf(hostileProxy)).toBe('unlisted');
  });
});

// ---------------------------------------------------------------------------
// The catch sites
// ---------------------------------------------------------------------------

describe('log records built from a caught value', () => {
  it('logs a message handler that throws by frame type and class only, and keeps the connection', async () => {
    const harness = createHarness();
    harness.client.on('session.progress', () => {
      throw leakyError();
    });
    harness.client.on('session.progress', () => {
      throw leakyTypeError();
    });
    const socket = await openConnection(harness);

    socket.receive(progressFrame());

    const threw = harness.records.filter(
      (record) => record.message === 'a service message handler threw',
    );
    expect(threw.map((record) => record.level)).toEqual(['error', 'error']);
    expect(threw.map((record) => record.fields)).toEqual([
      { type: 'session.progress', ref: ANY_REF, errorClass: 'unlisted' },
      { type: 'session.progress', ref: ANY_REF, errorClass: 'TypeError' },
    ]);
    expect(new Set(threw.map((record) => record.fields.ref)).size).toBe(2);
    expect(harness.client.state).toBe('open');
    expectNoLeak(harness.records);
  });

  it('logs a thrown value that is not an Error by its typeof only', async () => {
    const harness = createHarness();
    harness.client.on('session.progress', () => throwValue(sentinelText()));
    harness.client.on('session.progress', () =>
      throwValue({ message: sentinelText(), token: EDITOR_TOKEN }),
    );
    const socket = await openConnection(harness);

    socket.receive(progressFrame());

    const threw = harness.records.filter(
      (record) => record.message === 'a service message handler threw',
    );
    expect(threw.map((record) => record.fields)).toEqual([
      { type: 'session.progress', ref: ANY_REF, errorClass: 'string' },
      { type: 'session.progress', ref: ANY_REF, errorClass: 'object' },
    ]);
    expectNoLeak(harness.records);
  });

  it('logs a state listener that throws by listener kind and class only', () => {
    const harness = createHarness();
    harness.client.onStateChange(() => {
      throw leakyTypeError();
    });

    harness.client.connect();

    const record = recordOf(harness.records, 'a service client listener threw');
    expect(record.level).toBe('error');
    expect(record.fields).toEqual({ kind: 'state', ref: ANY_REF, errorClass: 'TypeError' });
    expectNoLeak(harness.records);
  });

  it('logs a thrown DebuggenError by its code and the class and errno of its cause', async () => {
    const harness = createHarness();
    harness.client.onUnauthorized(() => {
      throw new DebuggenError('INTERNAL', sentinelText(), {
        hint: sentinelText(),
        details: { path: SENTINEL_PATH },
        cause: withCode(leakyTypeError(), 'ERR_INVALID_ARG_TYPE'),
      });
    });
    const socket = await openConnection(harness);

    // A refusal whose re-read yields the same token: the unauthorized signal.
    socket.drop(4401, 'the credential was refused');
    await settle();

    const record = recordOf(harness.records, 'a service client listener threw');
    expect(record.level).toBe('error');
    expect(record.fields).toEqual({
      kind: 'unauthorized',
      ref: ANY_REF,
      errorClass: 'DebuggenError',
      errorCode: 'INTERNAL',
      causeClass: 'TypeError',
      causeErrno: 'ERR_INVALID_ARG_TYPE',
    });
    expectNoLeak(harness.records);
  });

  it('logs an unexpected request failure under a reference the returned error carries too', async () => {
    const harness = createHarness({
      fetch: answering(responseThrowing(withCode(leakyError(), 'ECONNRESET'))),
    });

    const listed = await harness.client.listSessions();

    expect(isErr(listed)).toBe(true);
    if (!isErr(listed)) {
      return;
    }
    const record = recordOf(harness.records, 'a service request failed unexpectedly');
    expect(record.level).toBe('error');
    const ref = record.fields.ref;
    expect(ref).toMatch(/^msg_/u);
    expect(record.fields).toEqual({
      operation: 'session.list',
      ref,
      errorClass: 'unlisted',
      errno: 'ECONNRESET',
    });
    expect(listed.error.code).toBe('INTERNAL');
    expect(listed.error.details).toEqual({ operation: 'session.list', ref });
    expect(listed.error.message).toBe(
      `The session.list request failed unexpectedly (reference ${String(ref)}).`,
    );
    expect(listed.error.cause).toBeUndefined();
    expectNoLeak(harness.records);
  });

  it('mints a distinct reference per failure and drops a code that is not an errno', async () => {
    const harness = createHarness({
      fetch: answering(responseThrowing(withCode(leakyError(), SENTINEL_KEY))),
    });

    const first = await harness.client.listSessions();
    const second = await harness.client.request('session.get', { params: { id: SESSION_ID } });

    const failed = harness.records.filter(
      (record) => record.message === 'a service request failed unexpectedly',
    );
    expect(failed.map((record) => record.fields.operation)).toEqual([
      'session.list',
      'session.get',
    ]);
    for (const record of failed) {
      expect(record.fields).not.toHaveProperty('errno');
    }
    const refs = failed.map((record) => record.fields.ref);
    expect(new Set(refs).size).toBe(2);
    expect(isErr(first) ? first.error.details?.ref : undefined).toBe(refs[0]);
    expect(isErr(second) ? second.error.details?.ref : undefined).toBe(refs[1]);
    expectNoLeak(harness.records);
  });

  it('logs a WebSocket constructor that throws as a protocol problem by code and cause class', () => {
    const harness = createHarness({
      webSocketConstructor: throwingConstructor(
        withCode(new SyntaxError(sentinelText()), 'ERR_INVALID_URL'),
      ),
    });

    harness.client.connect();

    const record = recordOf(harness.records, 'service connection problem');
    expect(record.level).toBe('debug');
    expect(record.fields).toEqual({
      ref: ANY_REF,
      problem: 'socket',
      errorCode: 'TRANSPORT_DISCONNECTED',
      causeClass: 'SyntaxError',
      causeErrno: 'ERR_INVALID_URL',
    });
    expectNoLeak(harness.records);
  });

  it('logs a constructor that throws an unlisted error with a non-errno code by class alone', () => {
    const harness = createHarness({
      webSocketConstructor: throwingConstructor(withCode(leakyError(), SENTINEL_KEY)),
    });

    harness.client.connect();

    const record = recordOf(harness.records, 'service connection problem');
    expect(record.fields).toEqual({
      ref: ANY_REF,
      problem: 'socket',
      errorCode: 'TRANSPORT_DISCONNECTED',
      causeClass: 'unlisted',
    });
    expectNoLeak(harness.records);
  });

  it('warns about a refused inbound frame by its code only', async () => {
    const harness = createHarness();
    const socket = await openConnection(harness);

    socket.receive(
      JSON.stringify({ type: 'session.progress', path: SENTINEL_PATH, key: SENTINEL_KEY }),
    );

    const warned = harness.records.filter(
      (record) => record.message === 'service connection problem' && record.level === 'warn',
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]?.fields).toEqual({
      ref: ANY_REF,
      problem: 'frame',
      errorCode: 'PROTOCOL_INVALID_MESSAGE',
    });
    expectNoLeak(harness.records);
  });

  it('warns about an HTTP credential re-read that rejects by class only', async () => {
    const harness = createHarness({
      credential: fakeCredential({ refresh: () => Promise.reject(leakyError()) }),
      fetch: answering({ ok: false, status: 401, text: () => Promise.resolve('') }),
    });

    const listed = await harness.client.listSessions();

    expect(isErr(listed) ? listed.error.code : undefined).toBe('UNAUTHORIZED');
    const record = recordOf(harness.records, 'the editor credential could not be read again');
    expect(record.level).toBe('warn');
    expect(record.fields).toEqual({ ref: ANY_REF, errorClass: 'unlisted' });
    expectNoLeak(harness.records);
  });

  it('warns about a socket credential re-read that rejects by class only', async () => {
    const harness = createHarness({
      credential: fakeCredential({ refresh: () => Promise.reject(leakyTypeError()) }),
    });
    const socket = await openConnection(harness);

    socket.drop(4401, 'the credential was refused');
    await settle();

    const reread = recordOf(harness.records, 'the editor credential could not be read again');
    expect(reread.level).toBe('warn');
    expect(reread.fields).toEqual({ ref: ANY_REF, errorClass: 'TypeError' });
    const refused = recordOf(harness.records, 'the service refused the editor credential');
    expect(refused.fields).toMatchObject({
      credential: 'unavailable',
      credentialErrorCode: 'UNAUTHORIZED',
    });
    expectNoLeak(harness.records);
  });

  it('warns about a configuration source that throws by class only', () => {
    const harness = createHarness({
      configuration: {
        readServiceUrl: () => throwValue(leakyError()),
        onDidChangeServiceUrl: () => throwValue(withCode(leakyTypeError(), 'EPERM')),
      },
    });

    const unread = recordOf(harness.records, 'the service URL setting could not be read');
    expect(unread.level).toBe('warn');
    expect(unread.fields).toEqual({ ref: ANY_REF, errorClass: 'unlisted' });
    const unwatched = recordOf(
      harness.records,
      'changes to the service URL setting cannot be observed',
    );
    expect(unwatched.fields).toEqual({ ref: ANY_REF, errorClass: 'TypeError', errno: 'EPERM' });
    expect(harness.client.configurationError?.code).toBe('CONFIG_INVALID');
    expectNoLeak(harness.records);
  });
});

// ---------------------------------------------------------------------------
// Invented error codes
// ---------------------------------------------------------------------------

describe('a code property that is not a known system or Node error code', () => {
  /** Fails the case when any record, rendered as a sink would print it, names an invented code. */
  function expectNoInventedCode(records: readonly LogRecord[]): void {
    for (const record of records) {
      const rendered = renderRecord(record);
      for (const code of INVENTED_CODES) {
        expect(rendered, `${record.level} record "${record.message}"`).not.toContain(
          code.toLowerCase(),
        );
      }
    }
  }

  it.each(INVENTED_CODES)('is not logged when a message handler throws with %#', async (code) => {
    const harness = createHarness();
    harness.client.on('session.progress', () => {
      throw withCode(leakyTypeError(), code);
    });
    const socket = await openConnection(harness);

    socket.receive(progressFrame());

    const record = recordOf(harness.records, 'a service message handler threw');
    expect(record.level).toBe('error');
    expect(record.fields).toEqual({
      type: 'session.progress',
      ref: ANY_REF,
      errorClass: 'TypeError',
    });
    expectNoInventedCode(harness.records);
    expectNoLeak(harness.records);
  });

  it.each(INVENTED_CODES)(
    'is not logged when a request fails unexpectedly with %#',
    async (code) => {
      const harness = createHarness({
        fetch: answering(responseThrowing(withCode(leakyError(), code))),
      });

      const listed = await harness.client.listSessions();

      const record = recordOf(harness.records, 'a service request failed unexpectedly');
      expect(record.level).toBe('error');
      expect(record.fields).toEqual({
        operation: 'session.list',
        ref: ANY_REF,
        errorClass: 'unlisted',
      });
      expect(isErr(listed) ? JSON.stringify(listed.error.toPayload()) : '').not.toContain(code);
      expectNoInventedCode(harness.records);
      expectNoLeak(harness.records);
    },
  );

  it.each(INVENTED_CODES)(
    'is not logged at warn level for a watcher that throws with %#',
    (code) => {
      const harness = createHarness({
        configuration: {
          readServiceUrl: () => SERVICE_URL,
          onDidChangeServiceUrl: () => throwValue(withCode(leakyError(), code)),
        },
      });

      const record = recordOf(
        harness.records,
        'changes to the service URL setting cannot be observed',
      );
      expect(record.level).toBe('warn');
      expect(record.fields).toEqual({ ref: ANY_REF, errorClass: 'unlisted' });
      expectNoInventedCode(harness.records);
      expectNoLeak(harness.records);
    },
  );

  it.each(INVENTED_CODES)(
    'is not logged as the cause of a protocol problem or a thrown DebuggenError with %#',
    async (code) => {
      const refused = createHarness({
        webSocketConstructor: throwingConstructor(withCode(new SyntaxError(sentinelText()), code)),
      });
      refused.client.connect();
      expect(recordOf(refused.records, 'service connection problem').fields).toEqual({
        ref: ANY_REF,
        problem: 'socket',
        errorCode: 'TRANSPORT_DISCONNECTED',
        causeClass: 'SyntaxError',
      });
      expectNoInventedCode(refused.records);
      expectNoLeak(refused.records);

      const harness = createHarness();
      harness.client.onUnauthorized(() => {
        throw new DebuggenError('INTERNAL', sentinelText(), {
          cause: withCode(leakyTypeError(), code),
        });
      });
      const socket = await openConnection(harness);
      socket.drop(4401, 'the credential was refused');
      await settle();

      expect(recordOf(harness.records, 'a service client listener threw').fields).toEqual({
        kind: 'unauthorized',
        ref: ANY_REF,
        errorClass: 'DebuggenError',
        errorCode: 'INTERNAL',
        causeClass: 'TypeError',
      });
      expectNoInventedCode(harness.records);
      expectNoLeak(harness.records);
    },
  );
});

// ---------------------------------------------------------------------------
// readModificationJournal
// ---------------------------------------------------------------------------

/** The session every journal case reads. */
const JOURNAL_SESSION = 'ses_journal_fixture';

/** The owning endpoint every journal case names. */
const JOURNAL_ENDPOINT = 'http://127.0.0.1:43118';

/** Record `n` of the fixture journal: a distinct id and file, an empty diff. */
function journalRecord(n: number): ModificationRecord {
  return {
    id: `mod_${String(n).padStart(16, '0')}`,
    sessionId: JOURNAL_SESSION,
    planVersion: 1,
    file: `src/lib/module-${String(n)}.ts`,
    originalHash: 'a'.repeat(64),
    backupPath: `/tmp/debuggen-home/backups/${JOURNAL_SESSION}/${'a'.repeat(64)}`,
    instrumentedHash: 'b'.repeat(64),
    appliedAt: 1_700_000_000_000 + n,
    status: 'applied',
    diff: '',
  };
}

/** A page of the journal carrying `records`, as the service answers one. */
function journalPage(
  records: readonly ModificationRecord[],
  window: { readonly offset: number; readonly total: number; readonly nextOffset: number | null },
): ModificationsResponse {
  return { modifications: [...records], limit: 256, ...window };
}

/** One `getModifications` call the scripted client received. */
interface PageCall {
  readonly sessionId: string;
  readonly window: ListPageRequest | undefined;
  readonly options: SessionEndpointCallOptions | undefined;
}

/** What one scripted page answers: a result, or a throw. */
type PageAnswer =
  | Result<ModificationsResponse, DebuggenError>
  | { readonly throws: Error }
  | ((call: PageCall) => Result<ModificationsResponse, DebuggenError>);

/**
 * A `getModifications` that answers the scripted pages in order and records
 * every call; a call past the script fails the case.
 */
function scriptedJournal(...answers: readonly PageAnswer[]): {
  readonly client: Pick<ServiceClient, 'getModifications'>;
  readonly calls: PageCall[];
} {
  const calls: PageCall[] = [];
  const client: Pick<ServiceClient, 'getModifications'> = {
    getModifications: (sessionId, window, options) => {
      const call = { sessionId, window, options };
      calls.push(call);
      const answer = answers[calls.length - 1];
      if (answer === undefined) {
        throw new Error(`unscripted page request ${String(calls.length)}`);
      }
      if (typeof answer === 'function') {
        return Promise.resolve(answer(call));
      }
      if ('throws' in answer) {
        return Promise.reject(answer.throws);
      }
      return Promise.resolve(answer);
    },
  };
  return { client, calls };
}

/** The walk's value, failing the case when it answered an `Err`. */
function journalOf(read: Result<ModificationJournalRead, DebuggenError>): ModificationJournalRead {
  if (!isOk(read)) {
    throw new Error(`expected a journal, got ${read.error.code}`);
  }
  return read.value;
}

/** The ids of the gathered records, in order. */
function idsOf(read: ModificationJournalRead): string[] {
  return read.modifications.map((record) => record.id);
}

describe('readModificationJournal', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads a one-page journal with exactly one request for the service default window', async () => {
    const records = [journalRecord(1), journalRecord(2)];
    const { client, calls } = scriptedJournal(
      ok(journalPage(records, { offset: 0, total: 2, nextOffset: null })),
    );

    const read = journalOf(
      await readModificationJournal(client, JOURNAL_SESSION, { endpoint: JOURNAL_ENDPOINT }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessionId).toBe(JOURNAL_SESSION);
    expect(calls[0]?.window).toBeUndefined();
    expect(calls[0]?.options?.endpoint).toBe(JOURNAL_ENDPOINT);
    expect(read).toEqual({ modifications: records, total: 2, complete: true, pages: 1 });
    expect(Object.hasOwn(read, 'failure')).toBe(false);
  });

  it('walks every page along nextOffset, in order, forwarding the endpoint and the signal to each', async () => {
    const controller = new AbortController();
    const { client, calls } = scriptedJournal(
      ok(journalPage([journalRecord(1), journalRecord(2)], { offset: 0, total: 4, nextOffset: 2 })),
      ok(journalPage([journalRecord(3)], { offset: 2, total: 4, nextOffset: 3 })),
      ok(journalPage([journalRecord(4)], { offset: 3, total: 4, nextOffset: null })),
    );

    const read = journalOf(
      await readModificationJournal(client, JOURNAL_SESSION, {
        endpoint: JOURNAL_ENDPOINT,
        signal: controller.signal,
      }),
    );

    expect(calls.map((call) => call.window)).toEqual([undefined, { offset: 2 }, { offset: 3 }]);
    for (const call of calls) {
      expect(call.sessionId).toBe(JOURNAL_SESSION);
      expect(call.options?.endpoint).toBe(JOURNAL_ENDPOINT);
      expect(call.options?.signal).toBe(controller.signal);
    }
    expect(idsOf(read)).toEqual([1, 2, 3, 4].map((n) => journalRecord(n).id));
    expect(read.total).toBe(4);
    expect(read.complete).toBe(true);
    expect(read.pages).toBe(3);
  });

  it('keeps a record repeated on a later page once, as its first occurrence', async () => {
    const first = journalRecord(2);
    const repeated = { ...journalRecord(2), status: 'reverted' as const };
    const { client } = scriptedJournal(
      ok(journalPage([journalRecord(1), first], { offset: 0, total: 3, nextOffset: 1 })),
      ok(journalPage([repeated, journalRecord(3)], { offset: 1, total: 3, nextOffset: null })),
    );

    const read = journalOf(await readModificationJournal(client, JOURNAL_SESSION));

    expect(idsOf(read)).toEqual([1, 2, 3].map((n) => journalRecord(n).id));
    expect(read.modifications[1]).toBe(first);
    expect(read.complete).toBe(true);
  });

  it('keeps the gathered records and the failure when a later page fails', async () => {
    const failure = new DebuggenError('TRANSPORT_DISCONNECTED', 'The service went away', {
      hint: 'Start the local service.',
    });
    const { client, calls } = scriptedJournal(
      ok(journalPage([journalRecord(1)], { offset: 0, total: 3, nextOffset: 1 })),
      err(failure),
    );

    const read = journalOf(await readModificationJournal(client, JOURNAL_SESSION));

    expect(calls).toHaveLength(2);
    expect(idsOf(read)).toEqual([journalRecord(1).id]);
    expect(read.total).toBe(3);
    expect(read.complete).toBe(false);
    expect(read.pages).toBe(1);
    expect(read.failure).toBe(failure);
  });

  it('keeps the gathered records when a later page request throws', async () => {
    const { client } = scriptedJournal(
      ok(journalPage([journalRecord(1)], { offset: 0, total: 2, nextOffset: 1 })),
      { throws: new TypeError('a double that rejected') },
    );

    const read = journalOf(await readModificationJournal(client, JOURNAL_SESSION));

    expect(idsOf(read)).toEqual([journalRecord(1).id]);
    expect(read.complete).toBe(false);
    expect(read.failure).toBeInstanceOf(DebuggenError);
  });

  it('answers the first page’s failure as it is, without a second request', async () => {
    const failure = new DebuggenError('SESSION_NOT_FOUND', 'No such session');
    const { client, calls } = scriptedJournal(err(failure));

    const read = await readModificationJournal(client, JOURNAL_SESSION);

    expect(calls).toHaveLength(1);
    expect(isErr(read) ? read.error : undefined).toBe(failure);
  });

  it('stops, incomplete and without a failure, at a page whose nextOffset does not advance', async () => {
    const { client, calls } = scriptedJournal(
      ok(journalPage([journalRecord(1)], { offset: 0, total: 3, nextOffset: 1 })),
      ok(journalPage([journalRecord(2)], { offset: 1, total: 3, nextOffset: 1 })),
    );

    const read = journalOf(await readModificationJournal(client, JOURNAL_SESSION));

    expect(calls).toHaveLength(2);
    expect(idsOf(read)).toEqual([1, 2].map((n) => journalRecord(n).id));
    expect(read.complete).toBe(false);
    expect(read.failure).toBeUndefined();
  });

  it(`requests at most MODIFICATION_JOURNAL_PAGE_CAP (${String(MODIFICATION_JOURNAL_PAGE_CAP)}) pages`, async () => {
    const endless = (call: PageCall): Result<ModificationsResponse, DebuggenError> => {
      const offset = call.window?.offset ?? 0;
      return ok(
        journalPage([journalRecord(offset + 1)], {
          offset,
          total: Number.MAX_SAFE_INTEGER,
          nextOffset: offset + 1,
        }),
      );
    };
    const { client, calls } = scriptedJournal(
      ...Array.from({ length: MODIFICATION_JOURNAL_PAGE_CAP + 1 }, () => endless),
    );

    const read = journalOf(await readModificationJournal(client, JOURNAL_SESSION));

    expect(calls).toHaveLength(MODIFICATION_JOURNAL_PAGE_CAP);
    expect(read.pages).toBe(MODIFICATION_JOURNAL_PAGE_CAP);
    expect(read.modifications).toHaveLength(MODIFICATION_JOURNAL_PAGE_CAP);
    expect(read.complete).toBe(false);
    expect(read.failure).toBeUndefined();
  });

  it('bounds every page by what is left of the deadline and stops once it has elapsed', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const elapse = (ms: number): void => {
      vi.setSystemTime(Date.now() + ms);
    };
    const { client, calls } = scriptedJournal(
      () => {
        elapse(2_000);
        return ok(journalPage([journalRecord(1)], { offset: 0, total: 3, nextOffset: 1 }));
      },
      () => {
        elapse(1_500);
        return ok(journalPage([journalRecord(2)], { offset: 1, total: 3, nextOffset: 2 }));
      },
    );

    const read = journalOf(
      await readModificationJournal(client, JOURNAL_SESSION, {
        endpoint: JOURNAL_ENDPOINT,
        deadlineMs: 3_000,
      }),
    );

    expect(calls.map((call) => call.options?.timeoutMs)).toEqual([3_000, 1_000]);
    expect(idsOf(read)).toEqual([1, 2].map((n) => journalRecord(n).id));
    expect(read.complete).toBe(false);
    expect(read.failure?.code).toBe('TRANSPORT_DISCONNECTED');
    expect(read.failure?.details).toEqual({
      operation: 'modifications.list',
      cancelled: 'timeout',
      timeoutMs: 3_000,
    });
    expect(read.failure?.hint).toBeDefined();
  });

  it('keeps a tighter per-page timeout under the deadline, and forwards it unchanged without one', async () => {
    const onePage = ok(journalPage([journalRecord(1)], { offset: 0, total: 1, nextOffset: null }));

    const bounded = scriptedJournal(onePage);
    await readModificationJournal(bounded.client, JOURNAL_SESSION, {
      timeoutMs: 500,
      deadlineMs: 3_000,
    });
    expect(bounded.calls[0]?.options?.timeoutMs).toBe(500);

    const unbounded = scriptedJournal(onePage);
    await readModificationJournal(unbounded.client, JOURNAL_SESSION, { timeoutMs: 700 });
    expect(unbounded.calls[0]?.options?.timeoutMs).toBe(700);

    const defaulted = scriptedJournal(onePage);
    await readModificationJournal(defaulted.client, JOURNAL_SESSION, { deadlineMs: Number.NaN });
    expect(defaulted.calls[0]?.options?.timeoutMs).toBeUndefined();
  });

  it('requests nothing for an aborted signal, and no further page once it aborts', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const idle = scriptedJournal();
    const refused = await readModificationJournal(idle.client, JOURNAL_SESSION, {
      signal: aborted.signal,
    });
    expect(idle.calls).toHaveLength(0);
    expect(isErr(refused) ? refused.error.details : undefined).toEqual({
      operation: 'modifications.list',
      cancelled: 'aborted',
    });

    const controller = new AbortController();
    const { client, calls } = scriptedJournal(() => {
      controller.abort();
      return ok(journalPage([journalRecord(1)], { offset: 0, total: 2, nextOffset: 1 }));
    });
    const read = journalOf(
      await readModificationJournal(client, JOURNAL_SESSION, { signal: controller.signal }),
    );
    expect(calls).toHaveLength(1);
    expect(idsOf(read)).toEqual([journalRecord(1).id]);
    expect(read.complete).toBe(false);
    expect(read.failure?.details).toEqual({
      operation: 'modifications.list',
      cancelled: 'aborted',
    });
  });
});
