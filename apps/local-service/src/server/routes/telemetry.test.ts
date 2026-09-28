/**
 * Unit tests for the relayed-frame admission and the diagnostics bounds of
 * `./telemetry.ts` (CWE-400), and for the revocation fence of its
 * `POST /telemetry/ingest` route (CWE-613).
 *
 * The frame handler is driven directly with a fake ingest entry, a live
 * binding view in which each relaying tab is bound — by the connection's own
 * credential — to a session of its own (the relayed-tab rule admits a frame of
 * no other tab), a stepped clock and a capturing logger. The ingest route is
 * driven in-process through a hono app whose only middleware stands in for
 * `../auth.ts`'s, setting the server-agent principal it would have resolved,
 * with a fake revocation fence. No HTTP server and no socket is opened.
 *
 * The relayed-tab cases pin that a frame's tab is resolved to the connection's
 * own credential's live binding: ingest is handed that binding's holder
 * (`boundBy`), so attribution reads that holder's durable row, and a tab id only
 * another paired browser bound is refused before ingest — never a holder logged.
 *
 * The ingest cases pin what the route hands ingest — the body's delivery
 * context (`armedCaptureId`, `droppedCount`, `lossReportId`) exactly as sent,
 * and nothing it omitted — and what it refuses before ingest, without echoing
 * a refused value.
 */

import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HTTP_ROUTES, buildPath, createEnvelope, parseHttpRequest } from '@debuggen/protocol';
import type { TelemetryIngestRequest } from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  isErr,
  newCaptureId,
  newEventId,
  newProducerId,
  newSpanId,
  newTraceId,
  ok,
} from '@debuggen/shared';
import type { LogFields, Logger, Result } from '@debuggen/shared';
import { parseTelemetryEventIngress } from '@debuggen/telemetry';
import type { TelemetryEventIngress } from '@debuggen/telemetry';

import type { DropReason } from '../../telemetry/attribute.js';
import { LOG_THROTTLE_INTERVAL_MS } from '../../telemetry/ingest.js';
import type {
  IngestReport,
  ServerAgentIngestInput,
  TelemetryIngest,
} from '../../telemetry/ingest.js';
import { AUTH_FAILURE_REASONS } from '../auth.js';
import type {
  AuthFailureReason,
  AuthService,
  Principal,
  ServerAgentPrincipal,
  ServerEnv,
} from '../auth.js';
import type { TabBindingView } from '../clients.js';

import {
  MALFORMED_FRAME_LIMIT,
  MALFORMED_FRAME_WINDOW_MS,
  createTelemetryRoutes,
} from './telemetry.js';
import type {
  TelemetryEventFrame,
  TelemetryFrameConnection,
  TelemetryRoutes,
} from './telemetry.js';

const FIXED_NOW = 1_768_000_000_000;
const TAB = 7;
const OTHER_TAB = 8;

/** The `tokenHash` of the paired DevTools credential every frame's connection carries. */
const TOKEN_HASH = 'f'.repeat(64);

/** The session each relaying tab is bound to; both bindings are live. */
const SESSION_OF_TAB: ReadonlyMap<number, string> = new Map([
  [TAB, 'ses_relaytabseven'],
  [OTHER_TAB, 'ses_relaytabeight'],
]);

/**
 * The live binding of `tabId`, made by the paired credential ({@link TOKEN_HASH}),
 * if the tab is bound. Asked for another credential, it answers nothing — as
 * the client registry does: a tab id is unique only within one browser, and
 * another browser's tab of the same id is not this binding's tab.
 */
function liveBinding(tabId: number, principal?: Principal): TabBindingView | undefined {
  const sessionId = SESSION_OF_TAB.get(tabId);
  return sessionId === undefined || (principal !== undefined && principal.tokenHash !== TOKEN_HASH)
    ? undefined
    : {
        tabId,
        sessionId,
        url: 'http://127.0.0.1:3100/',
        boundBy: TOKEN_HASH,
        boundAt: FIXED_NOW,
        recipientId: 'cli_relay',
        online: true,
      };
}

/** One captured log record. */
interface Entry {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields;
}

/** A logger that keeps every record it is handed. */
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

/** A clock the test moves by hand. */
function steppedClock(): { readonly now: () => number; advance(ms: number): void } {
  let reading = FIXED_NOW;
  return {
    now: () => reading,
    advance(ms: number): void {
      reading += ms;
    },
  };
}

/**
 * A report with only the counts the two handlers read set to something
 * meaningful: the ingest route's log record totals `dropped`, so it is present
 * and empty.
 */
function reportOf(counts: { persisted: number; invalid: number }): IngestReport {
  const report: Partial<IngestReport> = {
    received: counts.persisted + counts.invalid,
    parsed: counts.persisted,
    invalid: counts.invalid,
    dropped: {} as IngestReport['dropped'],
    persisted: counts.persisted,
    inserted: counts.persisted,
    skipped: 0,
    requestKeysComputed: 0,
    tracesTouched: [],
  };
  return report as IngestReport;
}

/** The DevTools connection every frame arrives on, announcing `tabId`, of the paired credential by default. */
function connection(tabId: number, tokenHash: string = TOKEN_HASH): TelemetryFrameConnection {
  return {
    id: 'cli_relay',
    kind: 'devtools',
    tabId,
    principal: {
      role: 'devtools',
      tokenHash,
      scope: { kind: 'extension', extensionId: 'abcdefghijklmnopabcdefghijklmnop' },
      issuedAt: 0,
    },
  };
}

/** A `telemetry.event` frame carrying `events` on the connection for `tabId`. */
function frame(events: unknown, tabId: number = TAB): TelemetryEventFrame {
  const message = createEnvelope('telemetry.event', { events: [] });
  return {
    message: { ...message, payload: { events } } as TelemetryEventFrame['message'],
    client: connection(tabId),
  };
}

/** What a test may replace in {@link harness} beyond the relayed-frame answer. */
interface HarnessOptions {
  /** The revocation fence; by default every credential is still live. */
  readonly requireLiveCredential?: AuthService['requireLiveCredential'];
}

/**
 * The routes over fake ingest entries, a fake revocation fence, a stepped
 * clock and a capturing logger. The server-agent entry stores every event it
 * is handed.
 */
function harness(
  answer: (events: readonly unknown[]) => Result<IngestReport, DebuggenError>,
  options: HarnessOptions = {},
) {
  const clock = steppedClock();
  const entries: Entry[] = [];
  const ingestFromAgent = vi.fn<TelemetryIngest['ingestFromAgent']>((input) =>
    Promise.resolve(answer(input.events as readonly unknown[])),
  );
  const ingestFromServerAgent = vi.fn<TelemetryIngest['ingestFromServerAgent']>((input) =>
    Promise.resolve(
      ok(
        reportOf({ persisted: Array.isArray(input.events) ? input.events.length : 0, invalid: 0 }),
      ),
    ),
  );
  const requireLiveCredential = vi.fn<AuthService['requireLiveCredential']>(
    options.requireLiveCredential ?? (() => ok(undefined)),
  );
  const routes = createTelemetryRoutes({
    ingest: { ingestFromAgent, ingestFromServerAgent },
    bindings: {
      bindingForTab: liveBinding,
      bindingForSession: (sessionId) =>
        [...SESSION_OF_TAB.keys()]
          .map((tabId) => liveBinding(tabId))
          .find((binding) => binding?.sessionId === sessionId),
    },
    auth: { requireLiveCredential },
    logger: capturingLogger(entries),
    now: clock.now,
  });
  return { routes, clock, entries, ingestFromAgent, ingestFromServerAgent, requireLiveCredential };
}

/** Every element malformed: stored nothing. */
const MALFORMED = (): Result<IngestReport, DebuggenError> =>
  ok(reportOf({ persisted: 0, invalid: 1 }));

afterEach(() => {
  vi.useRealTimers();
});

describe('relayed-frame admission', () => {
  it('refuses a tab’s frames unread once it relayed the malformed-frame limit, for the window', async () => {
    const h = harness(MALFORMED);

    for (let index = 0; index < MALFORMED_FRAME_LIMIT; index += 1) {
      const outcome = await h.routes.handleTelemetryEventFrame(frame([null]));
      expect(outcome.ok).toBe(true);
    }
    expect(h.ingestFromAgent).toHaveBeenCalledTimes(MALFORMED_FRAME_LIMIT);

    // Hundreds more: none reaches ingest, none has its payload read.
    let payloadReads = 0;
    const watched = new Proxy([null], {
      get(target, property, receiver) {
        payloadReads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    for (let index = 0; index < 300; index += 1) {
      const refused = await h.routes.handleTelemetryEventFrame(frame(watched));
      expect(isErr(refused) && refused.error.code).toBe('RATE_LIMITED');
    }
    expect(h.ingestFromAgent).toHaveBeenCalledTimes(MALFORMED_FRAME_LIMIT);
    expect(payloadReads, 'a refused frame is not read').toBe(0);

    const closed = h.entries.filter((entry) => entry.level === 'warn');
    expect(closed).toHaveLength(1);
    expect(closed[0]?.fields).toMatchObject({ tabId: TAB, malformed: MALFORMED_FRAME_LIMIT });
    expect(
      h.entries.filter((entry) => entry.level === 'debug'),
      'the per-frame refusal debug record is throttled',
    ).toHaveLength(1);

    // The window passes: the tab's frames are admitted again.
    h.clock.advance(MALFORMED_FRAME_WINDOW_MS);
    expect((await h.routes.handleTelemetryEventFrame(frame([null]))).ok).toBe(true);
    expect(h.ingestFromAgent).toHaveBeenCalledTimes(MALFORMED_FRAME_LIMIT + 1);
  });

  it('never counts well-formed frames, and closes only the flooding tab', async () => {
    const h = harness((events) =>
      events[0] === 'good' ? ok(reportOf({ persisted: 1, invalid: 0 })) : MALFORMED(),
    );

    for (let index = 0; index < MALFORMED_FRAME_LIMIT * 5; index += 1) {
      expect((await h.routes.handleTelemetryEventFrame(frame(['good']))).ok).toBe(true);
    }
    for (let index = 0; index < MALFORMED_FRAME_LIMIT; index += 1) {
      await h.routes.handleTelemetryEventFrame(frame([null], OTHER_TAB));
    }

    const flooding = await h.routes.handleTelemetryEventFrame(frame(['good'], OTHER_TAB));
    expect(isErr(flooding) && flooding.error.code).toBe('RATE_LIMITED');
    const neighbour = await h.routes.handleTelemetryEventFrame(frame(['good']));
    expect(neighbour.ok, 'the other tab on the same connection is unaffected').toBe(true);
  });

  it('counts frames that are not arrays or are refused as malformed, but not service faults', async () => {
    let answer: Result<IngestReport, DebuggenError> = err(
      new DebuggenError('STORE_ERROR', 'The store is unavailable.'),
    );
    const h = harness(() => answer);

    for (let index = 0; index < MALFORMED_FRAME_LIMIT * 2; index += 1) {
      const outcome = await h.routes.handleTelemetryEventFrame(frame([{}]));
      expect(isErr(outcome) && outcome.error.code, 'a store outage is never the tab’s doing').toBe(
        'STORE_ERROR',
      );
    }

    answer = err(new DebuggenError('PROTOCOL_INVALID_MESSAGE', 'Not a batch.'));
    for (let index = 0; index < MALFORMED_FRAME_LIMIT / 2; index += 1) {
      await h.routes.handleTelemetryEventFrame(frame('not-an-array'));
      await h.routes.handleTelemetryEventFrame(frame([{}]));
    }
    const refused = await h.routes.handleTelemetryEventFrame(frame([{}]));
    expect(isErr(refused) && refused.error.code).toBe('RATE_LIMITED');
    expect(isErr(refused) && refused.error.details?.['retryAfterMs']).toBe(
      MALFORMED_FRAME_WINDOW_MS,
    );
  });

  it('reports a refused flood that stops with a trailing summary', async () => {
    vi.useFakeTimers();
    const h = harness(MALFORMED);

    for (let index = 0; index < MALFORMED_FRAME_LIMIT + 50; index += 1) {
      await h.routes.handleTelemetryEventFrame(frame([null]));
    }
    const debugBefore = h.entries.filter((entry) => entry.level === 'debug');
    expect(debugBefore).toHaveLength(1);

    h.clock.advance(LOG_THROTTLE_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(LOG_THROTTLE_INTERVAL_MS);

    const debugAfter = h.entries.filter((entry) => entry.level === 'debug');
    expect(debugAfter).toHaveLength(2);
    expect(debugAfter[1]?.fields).toMatchObject({
      tabId: TAB,
      suppressed: 49,
      trailingSummary: true,
    });
    const serialised = JSON.stringify(h.entries);
    expect(serialised, 'throttle keys are never written').not.toContain('\\u0000');
  });
});

/* -------------------------------------------------------------------------------------------------
 * POST /telemetry/ingest — the revocation fence
 * ---------------------------------------------------------------------------------------------- */

/** The project the dev server's server-agent credential is scoped to. */
const PROJECT_ROOT = '/work/lumen-supply';

/** A project the credential is not scoped to. */
const OTHER_PROJECT_ROOT = '/work/other-shop';

/** The `tokenHash` of the dev server's server-agent credential. */
const AGENT_TOKEN_HASH = 'a'.repeat(64);

/** The ingest operation's route, from protocol's table: registered at its pattern, addressed at its path. */
const INGEST_ROUTE = HTTP_ROUTES['telemetry.event'];

/** The URL every ingest request of these tests is sent to. */
const INGEST_URL = `http://127.0.0.1${buildPath('telemetry.event')}`;

/** The error payload every failed ingest request answers with. */
interface ErrorPayload {
  readonly code: string;
  readonly message: string;
}

/** The principal `../auth.ts`'s middleware resolved from the dev server's credential. */
function serverAgentPrincipal(): ServerAgentPrincipal {
  return {
    role: 'server-agent',
    tokenHash: AGENT_TOKEN_HASH,
    scope: { kind: 'project', projectRoot: PROJECT_ROOT },
    issuedAt: FIXED_NOW,
  };
}

/** The preload's per-process producer id, shared by every span it posts. */
const SERVER_PRODUCER = newProducerId();

/** The next `seq` a server span is given. */
let serverSeq = 0;

/** A fresh server-tier span, as the dev-server preload reports it, that protocol's strict ingress schema accepts. */
function serverSpan(): TelemetryEventIngress {
  const seq = serverSeq;
  serverSeq += 1;
  return {
    id: newEventId(),
    traceId: newTraceId(),
    spanId: newSpanId(),
    kind: 'http.server',
    name: 'GET /api/report',
    startTime: FIXED_NOW + seq,
    duration: 12.5,
    tier: 'server',
    attributes: {},
    status: 'ok',
    producerId: SERVER_PRODUCER,
    seq,
  };
}

/**
 * A one-span ingest body claiming `projectRoot`, checked against protocol's
 * own request schema so a test's verdict is never a body refusal in disguise.
 */
function ingestBody(projectRoot: string = PROJECT_ROOT): TelemetryIngestRequest {
  const body: TelemetryIngestRequest = { projectRoot, events: [serverSpan()] };
  const parsed = parseHttpRequest('telemetry.event', body);
  if (isErr(parsed)) {
    throw new Error(`The test ingest body does not satisfy protocol: ${parsed.error.message}`);
  }
  return body;
}

/** The refusal `../auth.ts`'s fence returns for `reason`, from its own table. */
function fenceRefusal(reason: AuthFailureReason): DebuggenError {
  const descriptor = AUTH_FAILURE_REASONS[reason];
  return new DebuggenError(descriptor.code, descriptor.message, { details: { reason } });
}

/** `POST /telemetry/ingest` behind a stand-in for the auth middleware, which resolved `principal`. */
function ingestApp(routes: TelemetryRoutes, principal: ServerAgentPrincipal): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();
  app.use('*', async (c, next) => {
    c.set('principal', principal);
    await next();
  });
  app.post(INGEST_ROUTE.pattern, routes.handleIngestRequest);
  return app;
}

/** A JSON ingest request carrying `body` whole. */
function ingestRequest(body: unknown): Request {
  return new Request(INGEST_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * A request body the test sends by hand: the handler awaits it for as long as
 * the test holds it back, like a producer that has not finished sending.
 */
interface HeldBody {
  readonly stream: ReadableStream<Uint8Array>;
  /**
   * Whether every chunk sent so far has left the stream's queue — taken by
   * the one reader, the handler's body read. The queue holds one chunk
   * (`highWaterMark: 1`), so a sent chunk not yet read leaves no room.
   */
  drained(): boolean;
  send(chunk: Uint8Array): void;
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
    send: (chunk) => {
      controller().enqueue(chunk);
    },
    end: () => {
      controller().close();
    },
  };
}

describe('the relayed tab’s holder', () => {
  /** Another paired browser's credential digest, whose tab ids may equal the first browser's. */
  const OTHER_TOKEN_HASH = 'e'.repeat(64);

  it('hands ingest the verified holder of the acting tab’s live binding', async () => {
    const h = harness(() => ok(reportOf({ persisted: 1, invalid: 0 })));

    expect((await h.routes.handleTelemetryEventFrame(frame(['event']))).ok).toBe(true);

    expect(h.ingestFromAgent).toHaveBeenCalledTimes(1);
    expect(h.ingestFromAgent.mock.calls[0]?.[0]).toMatchObject({ tabId: TAB, boundBy: TOKEN_HASH });
    expect(JSON.stringify(h.entries), 'the holder is never logged').not.toContain(TOKEN_HASH);
  });

  it('refuses a frame for a tab id only another credential bound, before ingest', async () => {
    const h = harness(() => ok(reportOf({ persisted: 1, invalid: 0 })));
    const foreign: TelemetryEventFrame = {
      ...frame(['event']),
      client: connection(TAB, OTHER_TOKEN_HASH),
    };

    const refused = await h.routes.handleTelemetryEventFrame(foreign);

    expect(isErr(refused) && refused.error.code).toBe(
      AUTH_FAILURE_REASONS['session-not-bound'].code,
    );
    expect(h.ingestFromAgent).not.toHaveBeenCalled();
    const logged = JSON.stringify(h.entries);
    expect(logged, 'neither holder is logged').not.toContain(TOKEN_HASH);
    expect(logged).not.toContain(OTHER_TOKEN_HASH);
  });
});

describe('POST /telemetry/ingest — the revocation fence', () => {
  it('ingests the batch once, after confirming the resolved credential is still live', async () => {
    const h = harness(MALFORMED);
    const principal = serverAgentPrincipal();
    const body = ingestBody();

    const response = await ingestApp(h.routes, principal).fetch(ingestRequest(body));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 1 });
    expect(h.requireLiveCredential).toHaveBeenCalledTimes(1);
    expect(
      h.requireLiveCredential.mock.calls[0]?.[0],
      'the fence judges the resolved principal',
    ).toBe(principal);
    expect(h.ingestFromServerAgent).toHaveBeenCalledTimes(1);
    expect(h.ingestFromServerAgent).toHaveBeenCalledWith({
      projectRoot: PROJECT_ROOT,
      scopedProjectRoot: PROJECT_ROOT,
      events: body.events,
    });
    const [fencedAt] = h.requireLiveCredential.mock.invocationCallOrder;
    const [ingestedAt] = h.ingestFromServerAgent.mock.invocationCallOrder;
    expect(fencedAt, 'the fence runs before the batch is handed to ingest').toBeLessThan(
      ingestedAt ?? Number.NEGATIVE_INFINITY,
    );
  });

  it.each(['unknown-credential', 'expired-credential', 'corrupt-credential'] as const)(
    'answers 401 and ingests nothing when the fence refuses the credential (%s)',
    async (reason) => {
      const h = harness(MALFORMED, { requireLiveCredential: () => err(fenceRefusal(reason)) });

      const response = await ingestApp(h.routes, serverAgentPrincipal()).fetch(
        ingestRequest(ingestBody()),
      );

      expect(response.status).toBe(401);
      const payload = (await response.json()) as ErrorPayload;
      expect(payload.code).toBe('UNAUTHORIZED');
      expect(payload.message).toBe(AUTH_FAILURE_REASONS[reason].message);
      expect(h.requireLiveCredential).toHaveBeenCalledTimes(1);
      expect(h.ingestFromServerAgent).not.toHaveBeenCalled();
      expect(
        h.entries.filter((entry) => entry.level === 'warn' || entry.level === 'error'),
        'a refusal auth.ts already logged is not logged again as a failure',
      ).toHaveLength(0);
      expect(JSON.stringify(h.entries), 'no project path is logged').not.toContain(PROJECT_ROOT);
    },
  );

  it('refuses a retired credential before the body’s project claim is judged', async () => {
    const h = harness(MALFORMED, {
      requireLiveCredential: () => err(fenceRefusal('unknown-credential')),
    });

    const response = await ingestApp(h.routes, serverAgentPrincipal()).fetch(
      ingestRequest(ingestBody(OTHER_PROJECT_ROOT)),
    );

    expect(response.status, 'the retired credential, not the scope mismatch, decides').toBe(401);
    expect(h.ingestFromServerAgent).not.toHaveBeenCalled();
  });

  it('answers a retryable 500 and ingests nothing when the fence cannot read the store', async () => {
    const storeWords = 'SQLITE_BUSY: database is locked';
    const h = harness(MALFORMED, {
      requireLiveCredential: () => err(new DebuggenError('STORE_ERROR', storeWords)),
    });

    const response = await ingestApp(h.routes, serverAgentPrincipal()).fetch(
      ingestRequest(ingestBody()),
    );

    expect(response.status).toBe(500);
    const payload = (await response.json()) as ErrorPayload;
    expect(payload.code).toBe('STORE_ERROR');
    expect(payload.message, 'the store’s own words never reach the producer').not.toContain(
      'SQLITE_BUSY',
    );
    expect(payload.message, 'the producer is told it may send the batch again').toContain(
      'may be sent again',
    );
    expect(h.ingestFromServerAgent).not.toHaveBeenCalled();
    const failures = h.entries.filter((entry) => entry.level === 'error');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.fields).toMatchObject({
      operation: 'telemetry.event',
      errorCode: 'STORE_ERROR',
      received: 1,
    });
  });

  it('fails closed with a 500 and ingests nothing when the fence throws', async () => {
    const thrownWords = 'fence defect near tok_should_never_leak';
    const h = harness(MALFORMED, {
      requireLiveCredential: () => {
        throw new Error(thrownWords);
      },
    });

    const response = await ingestApp(h.routes, serverAgentPrincipal()).fetch(
      ingestRequest(ingestBody()),
    );

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text, 'the thrown value is never answered').not.toContain('tok_should_never_leak');
    expect((JSON.parse(text) as ErrorPayload).code).toBe('INTERNAL');
    expect(h.requireLiveCredential).toHaveBeenCalledTimes(1);
    expect(h.ingestFromServerAgent).not.toHaveBeenCalled();
    const failures = h.entries.filter((entry) => entry.level === 'error');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.fields).toMatchObject({
      operation: 'telemetry.event',
      errorCode: 'INTERNAL',
    });
    expect(JSON.stringify(h.entries), 'the thrown value is never logged').not.toContain(
      'tok_should_never_leak',
    );
  });

  it('judges the credential only once its body has arrived, so one retired meanwhile ingests nothing', async () => {
    let retired = false;
    const h = harness(MALFORMED, {
      requireLiveCredential: () =>
        retired ? err(fenceRefusal('unknown-credential')) : ok(undefined),
    });
    const principal = serverAgentPrincipal();
    const encoded = new TextEncoder().encode(JSON.stringify(ingestBody()));
    const half = Math.floor(encoded.byteLength / 2);
    const body = heldBody();

    const pending = ingestApp(h.routes, principal).fetch(
      new Request(INGEST_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body.stream,
        duplex: 'half',
      }),
    );

    // Half the body, taken by the handler's read, which now waits on the producer.
    body.send(encoded.subarray(0, half));
    await vi.waitFor(() => {
      expect(body.drained(), 'the handler has read the first half').toBe(true);
    });
    expect(
      h.requireLiveCredential,
      'no verdict is taken while the body is arriving',
    ).not.toHaveBeenCalled();
    expect(h.ingestFromServerAgent).not.toHaveBeenCalled();

    // The credential is retired — a rotation, a revocation or an expiry —
    // while the producer holds the rest of its body back.
    retired = true;
    body.send(encoded.subarray(half));
    body.end();
    const response = await pending;

    expect(response.status).toBe(401);
    expect(((await response.json()) as ErrorPayload).code).toBe('UNAUTHORIZED');
    expect(h.requireLiveCredential).toHaveBeenCalledTimes(1);
    expect(
      h.requireLiveCredential.mock.calls[0]?.[0],
      'the fence judges the resolved principal',
    ).toBe(principal);
    expect(h.ingestFromServerAgent, 'a retired credential ingests nothing').not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------------------------------
 * POST /telemetry/ingest — the delivery context
 * ---------------------------------------------------------------------------------------------- */

/** The dev-server preload's principal: a server-agent credential scoped to {@link PROJECT_ROOT}. */
const SERVER_AGENT: ServerAgentPrincipal = {
  role: 'server-agent',
  tokenHash: 'e'.repeat(64),
  issuedAt: 0,
  scope: { kind: 'project', projectRoot: PROJECT_ROOT },
};

/**
 * A report of the counts `toIngestResponse` and the route's log fields read:
 * `received` events, `persisted` of them stored, `invalid` refused by the
 * element schema, and optionally the whole batch dropped under `dropReason`.
 */
function serverReportOf(counts: {
  readonly received: number;
  readonly persisted: number;
  readonly invalid?: number;
  readonly dropReason?: DropReason;
}): IngestReport {
  const invalid = counts.invalid ?? 0;
  const dropped = counts.received - counts.persisted - invalid;
  const report: Partial<IngestReport> = {
    received: counts.received,
    parsed: counts.received - invalid,
    invalid,
    dropped: (counts.dropReason === undefined
      ? {}
      : { [counts.dropReason]: dropped }) as IngestReport['dropped'],
    persisted: counts.persisted,
    inserted: counts.persisted,
    skipped: 0,
    requestKeysComputed: 0,
    tracesTouched: [],
    ...(counts.dropReason === undefined ? {} : { batchDropReason: counts.dropReason }),
  };
  return report as IngestReport;
}

/** What one in-process `POST /telemetry/ingest` answered. */
interface IngestAnswer {
  readonly status: number;
  /** The response body as sent: the haystack a refused value must not appear in. */
  readonly text: string;
  readonly json: unknown;
}

/**
 * The ingest route in an in-process hono application: a stand-in for the auth
 * middleware sets {@link SERVER_AGENT}, the revocation fence confirms every
 * credential, and `ingestFromServerAgent` is a spy answering with
 * `answer(input)`.
 */
function ingestHarness(
  answer: (input: ServerAgentIngestInput) => Result<IngestReport, DebuggenError>,
) {
  const entries: Entry[] = [];
  const ingestFromServerAgent = vi.fn<TelemetryIngest['ingestFromServerAgent']>((input) =>
    Promise.resolve(answer(input)),
  );
  const ingestFromAgent = vi.fn<TelemetryIngest['ingestFromAgent']>(() =>
    Promise.resolve(ok(reportOf({ persisted: 0, invalid: 0 }))),
  );
  const routes = createTelemetryRoutes({
    ingest: { ingestFromAgent, ingestFromServerAgent },
    bindings: { bindingForTab: () => undefined, bindingForSession: () => undefined },
    auth: { requireLiveCredential: () => ok(undefined) },
    logger: capturingLogger(entries),
    now: steppedClock().now,
  });

  const app = new Hono<ServerEnv>();
  app.use('*', async (c, next) => {
    c.set('principal', SERVER_AGENT);
    await next();
  });
  app.on(INGEST_ROUTE.method, INGEST_ROUTE.pattern, routes.handlers['telemetry.event']);

  /** Posts `body`, serialised as JSON, and reads the answer whole. */
  async function post(body: unknown): Promise<IngestAnswer> {
    const response = await app.request(INGEST_ROUTE.pattern, {
      method: INGEST_ROUTE.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) as unknown };
  }

  /** The single input ingest was handed; fails unless it was called exactly once. */
  function onlyInput(): ServerAgentIngestInput {
    expect(ingestFromServerAgent).toHaveBeenCalledTimes(1);
    const input = ingestFromServerAgent.mock.calls[0]?.[0];
    if (input === undefined) {
      throw new Error('ingestFromServerAgent was not handed an input.');
    }
    return input;
  }

  return { post, onlyInput, entries, ingestFromServerAgent, ingestFromAgent };
}

/** An answer storing every element it was handed, as ingest does for a sound batch. */
function storesAll(input: ServerAgentIngestInput): Result<IngestReport, DebuggenError> {
  const received = Array.isArray(input.events) ? input.events.length : 0;
  return ok(serverReportOf({ received, persisted: received }));
}

/** The error code of a response body, when it is protocol's error payload. */
function codeOf(json: unknown): unknown {
  return typeof json === 'object' && json !== null && 'code' in json ? json.code : undefined;
}

describe('POST /telemetry/ingest delivery context', () => {
  it('builds its spans from protocol’s strict ingress schema', () => {
    expect(isErr(parseTelemetryEventIngress(serverSpan()))).toBe(false);
  });

  it('forwards armedCaptureId and droppedCount to ingest exactly, beside the credential’s scope', async () => {
    const h = ingestHarness(storesAll);
    const armedCaptureId = newCaptureId();
    const events = [serverSpan(), serverSpan()];

    const answered = await h.post({
      projectRoot: PROJECT_ROOT,
      events,
      armedCaptureId,
      droppedCount: 5,
    });

    expect(answered.status).toBe(202);
    expect(answered.json).toEqual({ accepted: 2 });
    expect(h.onlyInput()).toStrictEqual({
      projectRoot: PROJECT_ROOT,
      scopedProjectRoot: PROJECT_ROOT,
      events,
      armedCaptureId,
      droppedCount: 5,
    });
    expect(h.ingestFromAgent, 'the browser entry is never used').not.toHaveBeenCalled();
    expect(answered.text, 'the named capture is never echoed').not.toContain(armedCaptureId);
    expect(JSON.stringify(h.entries), 'nor logged').not.toContain(armedCaptureId);
  });

  it('forwards lossReportId exactly beside its loss report, never echoing or logging it', async () => {
    const h = ingestHarness((input) => {
      const received = Array.isArray(input.events) ? input.events.length : 0;
      return ok(serverReportOf({ received, persisted: received }));
    });
    const armedCaptureId = newCaptureId();
    const batchReportId = `loss_${newCaptureId()}`;
    const lossOnlyReportId = `loss_${newCaptureId()}`;
    const events = [serverSpan()];

    const withEvents = await h.post({
      projectRoot: PROJECT_ROOT,
      events,
      armedCaptureId,
      droppedCount: 3,
      lossReportId: batchReportId,
    });
    const lossOnly = await h.post({
      projectRoot: PROJECT_ROOT,
      events: [],
      armedCaptureId,
      droppedCount: 2,
      lossReportId: lossOnlyReportId,
    });

    expect(withEvents.status).toBe(202);
    expect(withEvents.json).toEqual({ accepted: 1 });
    expect(lossOnly.status).toBe(202);
    expect(lossOnly.json).toEqual({ accepted: 0 });
    expect(h.ingestFromServerAgent.mock.calls.map(([input]) => input)).toStrictEqual([
      {
        projectRoot: PROJECT_ROOT,
        scopedProjectRoot: PROJECT_ROOT,
        events,
        armedCaptureId,
        droppedCount: 3,
        lossReportId: batchReportId,
      },
      {
        projectRoot: PROJECT_ROOT,
        scopedProjectRoot: PROJECT_ROOT,
        events: [],
        armedCaptureId,
        droppedCount: 2,
        lossReportId: lossOnlyReportId,
      },
    ]);
    for (const id of [batchReportId, lossOnlyReportId]) {
      expect(withEvents.text + lossOnly.text, 'the report id is never echoed').not.toContain(id);
      expect(JSON.stringify(h.entries), 'nor logged').not.toContain(id);
    }
  });

  it('omits every delivery field from the ingest input when the body carries none', async () => {
    const h = ingestHarness(storesAll);
    const events = [serverSpan()];

    const answered = await h.post({ projectRoot: PROJECT_ROOT, events });

    expect(answered.status).toBe(202);
    expect(answered.json).toEqual({ accepted: 1 });
    const input = h.onlyInput();
    expect(input).toStrictEqual({
      projectRoot: PROJECT_ROOT,
      scopedProjectRoot: PROJECT_ROOT,
      events,
    });
    expect(Object.hasOwn(input, 'armedCaptureId')).toBe(false);
    expect(Object.hasOwn(input, 'droppedCount')).toBe(false);
    expect(Object.hasOwn(input, 'lossReportId')).toBe(false);
  });

  it('omits lossReportId from the ingest input when a loss report carries none', async () => {
    const h = ingestHarness(storesAll);
    const events = [serverSpan()];

    await h.post({ projectRoot: PROJECT_ROOT, events, droppedCount: 4 });

    const input = h.onlyInput();
    expect(input).toStrictEqual({
      projectRoot: PROJECT_ROOT,
      scopedProjectRoot: PROJECT_ROOT,
      events,
      droppedCount: 4,
    });
    expect(Object.hasOwn(input, 'lossReportId')).toBe(false);
  });

  it('forwards each field on its own, and a zero loss report as sent', async () => {
    const armedOnly = ingestHarness(storesAll);
    const armedCaptureId = newCaptureId();
    const events = [serverSpan()];
    await armedOnly.post({ projectRoot: PROJECT_ROOT, events, armedCaptureId });
    expect(armedOnly.onlyInput()).toStrictEqual({
      projectRoot: PROJECT_ROOT,
      scopedProjectRoot: PROJECT_ROOT,
      events,
      armedCaptureId,
    });

    const lossOnly = ingestHarness(storesAll);
    await lossOnly.post({ projectRoot: PROJECT_ROOT, events, droppedCount: 0 });
    expect(lossOnly.onlyInput()).toStrictEqual({
      projectRoot: PROJECT_ROOT,
      scopedProjectRoot: PROJECT_ROOT,
      events,
      droppedCount: 0,
    });
  });

  it('hands a loss-only body to ingest and answers 202 { accepted: 0 }', async () => {
    const h = ingestHarness(() => ok(serverReportOf({ received: 0, persisted: 0 })));
    const armedCaptureId = newCaptureId();

    const bare = await h.post({ projectRoot: PROJECT_ROOT, events: [], droppedCount: 3 });
    expect(bare.status).toBe(202);
    expect(bare.json).toEqual({ accepted: 0 });
    expect(h.onlyInput()).toStrictEqual({
      projectRoot: PROJECT_ROOT,
      scopedProjectRoot: PROJECT_ROOT,
      events: [],
      droppedCount: 3,
    });

    const named = await h.post({
      projectRoot: PROJECT_ROOT,
      events: [],
      armedCaptureId,
      droppedCount: 2,
    });
    expect(named.status).toBe(202);
    expect(named.json).toEqual({ accepted: 0 });
    expect(h.ingestFromServerAgent.mock.calls[1]?.[0]).toStrictEqual({
      projectRoot: PROJECT_ROOT,
      scopedProjectRoot: PROJECT_ROOT,
      events: [],
      armedCaptureId,
      droppedCount: 2,
    });
  });

  it.each([
    ['no loss report', {}],
    ['a loss report of zero', { droppedCount: 0 }],
    ['a named capture but no loss', { armedCaptureId: newCaptureId() }],
  ])(
    'refuses an empty batch with %s as PROTOCOL_INVALID_MESSAGE (400), before ingest',
    async (_label, context) => {
      const h = ingestHarness(storesAll);

      const answered = await h.post({ projectRoot: PROJECT_ROOT, events: [], ...context });

      expect(answered.status).toBe(400);
      expect(codeOf(answered.json)).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(h.ingestFromServerAgent).not.toHaveBeenCalled();
    },
  );

  /** A value a refusal must never quote: unique per run, so a hit cannot be a coincidence. */
  const SENTINEL = `sentinel_${newCaptureId()}`;

  it.each([
    ['an armedCaptureId padded with whitespace', { armedCaptureId: ` ${SENTINEL} ` }],
    ['an empty armedCaptureId', { armedCaptureId: '' }],
    ['an armedCaptureId that is not a string', { armedCaptureId: { value: SENTINEL } }],
    ['a droppedCount that is a string', { droppedCount: SENTINEL }],
    ['a negative droppedCount', { droppedCount: -1 }],
    ['a fractional droppedCount', { droppedCount: 1.5 }],
    ['a droppedCount beyond the safe-integer range', { droppedCount: Number.MAX_SAFE_INTEGER + 2 }],
    ['a lossReportId padded with whitespace', { droppedCount: 1, lossReportId: ` ${SENTINEL} ` }],
    ['an empty lossReportId', { droppedCount: 1, lossReportId: '' }],
    ['a lossReportId that is not a string', { droppedCount: 1, lossReportId: { value: SENTINEL } }],
    [
      'a lossReportId longer than an identifier',
      { droppedCount: 1, lossReportId: `${SENTINEL}${'x'.repeat(64)}` },
    ],
  ])('refuses %s whole (400), never echoing or logging the value', async (_label, context) => {
    const h = ingestHarness(storesAll);
    const events = [serverSpan()];

    // With a sound batch, and with one whose only other fault is element-level:
    // a malformed field is an envelope issue, so neither body is recovered.
    for (const batch of [events, [...events, { kind: SENTINEL }]]) {
      const answered = await h.post({ projectRoot: PROJECT_ROOT, events: batch, ...context });

      expect(answered.status).toBe(400);
      expect(codeOf(answered.json)).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(answered.text, 'the refusal never quotes the value').not.toContain(SENTINEL);
    }
    expect(h.ingestFromServerAgent).not.toHaveBeenCalled();
    expect(JSON.stringify(h.entries), 'no record quotes the value').not.toContain(SENTINEL);
  });

  it.each([
    ['no loss report', {}],
    ['a loss report of zero', { droppedCount: 0 }],
    ['a named capture but no loss', { armedCaptureId: newCaptureId() }],
  ])(
    'refuses a lossReportId beside %s (400) before ingest, never echoing or logging it',
    async (_label, context) => {
      const h = ingestHarness(storesAll);
      const events = [serverSpan()];

      // A sound batch and one whose only other fault is element-level: protocol
      // states the rule only on an otherwise valid body, and the route refuses
      // the second whole rather than recover it with an id that names no loss.
      for (const batch of [events, [...events, { kind: SENTINEL }]]) {
        const answered = await h.post({
          projectRoot: PROJECT_ROOT,
          events: batch,
          ...context,
          lossReportId: SENTINEL,
        });

        expect(answered.status).toBe(400);
        expect(codeOf(answered.json)).toBe('PROTOCOL_INVALID_MESSAGE');
        expect(answered.text, 'the refusal names the field whose rule failed').toContain(
          'lossReportId',
        );
        expect(answered.text, 'the refusal never quotes the value').not.toContain(SENTINEL);
      }

      // An event-less body: refused by the loss-only rule, which it breaks too.
      const empty = await h.post({
        projectRoot: PROJECT_ROOT,
        events: [],
        ...context,
        lossReportId: SENTINEL,
      });
      expect(empty.status).toBe(400);
      expect(codeOf(empty.json)).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(empty.text).not.toContain(SENTINEL);

      expect(h.ingestFromServerAgent).not.toHaveBeenCalled();
      expect(JSON.stringify(h.entries), 'no record quotes the value').not.toContain(SENTINEL);
    },
  );

  it('recovers a batch whose only faults are element-level, forwarding its delivery context with the raw array', async () => {
    const h = ingestHarness((input) => {
      const received = Array.isArray(input.events) ? input.events.length : 0;
      return ok(serverReportOf({ received, persisted: received - 1, invalid: 1 }));
    });
    const armedCaptureId = newCaptureId();
    const lossReportId = `loss_${newCaptureId()}`;
    const sound = serverSpan();
    const malformed = { ...serverSpan(), tier: 'not-a-tier' };

    const answered = await h.post({
      projectRoot: PROJECT_ROOT,
      events: [sound, malformed],
      armedCaptureId,
      droppedCount: 4,
      lossReportId,
    });

    expect(answered.status).toBe(202);
    expect(answered.json).toEqual({ accepted: 1, rejected: 1 });
    expect(h.onlyInput()).toStrictEqual({
      projectRoot: PROJECT_ROOT,
      scopedProjectRoot: PROJECT_ROOT,
      events: [sound, malformed],
      armedCaptureId,
      droppedCount: 4,
      lossReportId,
    });
    expect(answered.text, 'the report id is never echoed').not.toContain(lossReportId);
    expect(JSON.stringify(h.entries), 'nor logged').not.toContain(lossReportId);
  });

  it('recovers an element-level fault beside a loss report without an id, forwarding no id', async () => {
    const h = ingestHarness((input) => {
      const received = Array.isArray(input.events) ? input.events.length : 0;
      return ok(serverReportOf({ received, persisted: received - 1, invalid: 1 }));
    });
    const sound = serverSpan();
    const malformed = { ...serverSpan(), tier: 'not-a-tier' };

    const answered = await h.post({
      projectRoot: PROJECT_ROOT,
      events: [sound, malformed],
      droppedCount: 6,
    });

    expect(answered.status).toBe(202);
    expect(answered.json).toEqual({ accepted: 1, rejected: 1 });
    const input = h.onlyInput();
    expect(input).toStrictEqual({
      projectRoot: PROJECT_ROOT,
      scopedProjectRoot: PROJECT_ROOT,
      events: [sound, malformed],
      droppedCount: 6,
    });
    expect(Object.hasOwn(input, 'lossReportId')).toBe(false);
  });

  it('answers a stale-capture drop 202 with its counts, as an honest report rather than a refusal', async () => {
    const h = ingestHarness((input) => {
      const received = Array.isArray(input.events) ? input.events.length : 0;
      return ok(serverReportOf({ received, persisted: 0, dropReason: 'stale-capture' }));
    });
    const staleCaptureId = newCaptureId();

    const answered = await h.post({
      projectRoot: PROJECT_ROOT,
      events: [serverSpan(), serverSpan(), serverSpan()],
      armedCaptureId: staleCaptureId,
    });

    expect(answered.status).toBe(202);
    expect(answered.json).toEqual({ accepted: 0, rejected: 3 });
    expect(h.onlyInput().armedCaptureId).toBe(staleCaptureId);
    expect(answered.text, 'the stale capture is never echoed').not.toContain(staleCaptureId);
    expect(JSON.stringify(h.entries), 'nor logged').not.toContain(staleCaptureId);
    expect(
      h.entries.some((entry) => entry.fields['dropReason'] === 'stale-capture'),
      'the drop is logged by its reason',
    ).toBe(true);
  });

  it('still refuses a project outside the credential scope before ingest, whatever capture it names', async () => {
    const h = ingestHarness(storesAll);

    const answered = await h.post({
      projectRoot: `${PROJECT_ROOT}-sibling`,
      events: [serverSpan()],
      armedCaptureId: newCaptureId(),
      droppedCount: 1,
    });

    expect(answered.status).toBe(403);
    expect(codeOf(answered.json)).toBe('PATH_OUTSIDE_PROJECT');
    expect(h.ingestFromServerAgent).not.toHaveBeenCalled();
  });
});
