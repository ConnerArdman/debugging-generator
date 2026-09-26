/**
 * The revocation fence of `POST /sessions/:id/panel-data` (AAP §0.5.6), across
 * a real credential rotation.
 *
 * The auth middleware resolves a principal once, before the handler runs; the
 * handler then awaits the body and the resolver. A rotation that lands inside
 * those awaits must leave the request with nothing: the route re-checks the
 * credential after its last `await` and before any answer is built, so a
 * request authorized a moment before `AuthService.rotateAll` receives protocol's
 * `401` refusal and none of the evidence the resolver found. That window is
 * opened here deterministically: the route runs over a gated resolver that
 * records its call, signals that it was entered — the middleware, the session
 * and scope checks and the body read all lie behind it — and holds its answer
 * until the test releases it, after the rotation. Behind the gate is the real
 * resolver over the harness's own store, so every answer is one the service
 * itself would compute. The body read is the other window, opened the same
 * way: a streamed body whose first pull — the handler's own read — signals
 * the test and then holds, so a rotation lands while the route awaits the
 * client, and a body the route would refuse must be answered `401` instead of
 * with its own verdict.
 *
 * ## What is composed, and why this suite has its own harness
 *
 * The route is mounted in-test on a bare hono application behind the real
 * `createAuthMiddleware`, keyed by protocol's route table, with the service's
 * own `AuthService` as both the middleware's access boundary and the route's
 * fence — only the resolver is gated, and one case swaps the fence for a
 * failing one. A rotation deletes every credential of the service it runs on
 * and closes every socket, so it would disturb any suite sharing the service:
 * this file boots its own harness and re-announces the editor under the
 * regenerated credential before every case that needs one.
 *
 * ## Rules ruling
 *
 * - **User rules (AAP §0.10).** `review_rules` answers "No user rules
 *   provided.", so the §0.10 baseline governs this file.
 * - **Gate membership.** Collected by the `local-service-integration` project
 *   (`pnpm test:integration`) and held to `tsc -b`, `eslint --max-warnings 0`
 *   and `prettier --check` like any source file.
 * - **No committed secrets.** Every credential is minted by the real auth
 *   service at run time and read through the harness; nothing credential-shaped
 *   is written here, and the probes of the failing fence are built from
 *   `node:crypto` randomness.
 */

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DataQuery } from '@debuggen/panel-schema';
import {
  AUTHORIZATION_HEADER,
  HTTP_ROUTES,
  WS_CLOSE_UNAUTHORIZED,
  buildPath,
  formatBearer,
  httpErrorResponseSchema,
} from '@debuggen/protocol';
import type {
  DataResult,
  HttpErrorResponse,
  PanelDataRequest,
  SessionRecord,
} from '@debuggen/protocol';
import { DebuggenError, err, isErr, newPanelId } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';

import { createPanelDataResolver } from '../../src/panels/data.js';
import type { PanelDataContext, PanelDataResolver } from '../../src/panels/data.js';
import { AUTH_FAILURE_REASONS, createAuthMiddleware } from '../../src/server/auth.js';
import type { ServerEnv } from '../../src/server/auth.js';
import { PANEL_DATA_OPERATION, createPanelDataRoutes } from '../../src/server/routes/panel-data.js';
import type { PanelDataRoutesDeps } from '../../src/server/routes/panel-data.js';
import { createTraceCorrelator } from '../../src/telemetry/correlate.js';

import { HARNESS_TIMEOUTS, startHarness } from './harness.js';
import type { CapturedLogRecord, FixtureProjectCopy, Harness, HarnessWsClient } from './harness.js';

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/** The question the suite's one session is created with. */
const QUESTION = 'Why does a panel keep drawing evidence after its credential was rotated?';

/** The route under test, read from protocol's one route table. */
const ROUTE = HTTP_ROUTES[PANEL_DATA_OPERATION];

/**
 * The query every case sends: a live `events` read. The session holds no
 * capture, so the real resolver answers it with the source's empty page — a
 * success that still carries every paging field a result is made of.
 */
const LIVE_QUERY: PanelDataRequest = Object.freeze({ source: 'events' });

/** The response header that keeps captured evidence out of every cache. */
const CACHE_CONTROL_HEADER = 'cache-control';

/** The one value that header carries on every answer of this route. */
const NO_STORE = 'no-store';

/** The record the access boundary writes when the fence refuses a retired credential. */
const FENCE_REFUSAL_LOG =
  'refused a request whose credential was retired after it was authenticated';

/** The record the auth middleware's access boundary writes when it refuses a request. */
const MIDDLEWARE_REFUSAL_LOG = 'refused an HTTP request';

/** The record the route writes for every refusal it answers below `500`. */
const ROUTE_REFUSAL_LOG = 'A panel-data request was refused';

/** The record the route writes for every failure it answers `500`. */
const ROUTE_FAILURE_LOG = 'A panel-data request failed';

/* -------------------------------------------------------------------------------------------------
 * Lifecycle
 * ---------------------------------------------------------------------------------------------- */

let harness: Harness;
let project: FixtureProjectCopy;
let session: SessionRecord;
let resolver: PanelDataResolver;

beforeAll(
  async () => {
    harness = await startHarness();
    project = harness.requireProject();
    // A session needs a dev server that answers: the harness's stand-in, never
    // the fixture itself.
    const launched = await harness.launchDevServer(project.root);
    if (isErr(launched)) {
      throw new Error(`The stand-in dev server did not launch (${launched.error.code}).`);
    }
    session = await harness.createSession({ projectRoot: project.root, question: QUESTION });
    // The pipeline settles at the readiness gate, waiting for a bound tab, so no
    // stage is still running when a case rotates the credentials.
    await harness.waitForSession(
      session.id,
      (record) => record.status === 'instrumenting' || record.status === 'ready',
    );
    const logger = harness.logger.root;
    resolver = createPanelDataResolver({
      telemetry: harness.repos.telemetry,
      correlator: createTraceCorrelator({ telemetry: harness.repos.telemetry, logger }),
      sessions: harness.repos.sessions,
      logger,
    });
  },
  HARNESS_TIMEOUTS.boot + HARNESS_TIMEOUTS.pipeline + HARNESS_TIMEOUTS.request,
);

afterAll(async () => {
  // `harness` is unset only when `startHarness` itself threw, and it releases
  // everything it acquired before rethrowing.
  await harness?.assertNoLeaks();
}, HARNESS_TIMEOUTS.teardown + HARNESS_TIMEOUTS.socketClose);

/* -------------------------------------------------------------------------------------------------
 * The gated resolver
 * ---------------------------------------------------------------------------------------------- */

/** One call the route made to the resolver. */
interface ResolverCall {
  readonly context: PanelDataContext;
  readonly query: DataQuery;
}

/** A resolver that holds its answer until released, and what it observed. */
interface GatedResolver {
  /** The port handed to the route. */
  readonly resolver: Pick<PanelDataResolver, 'resolve'>;
  /** Every call the route made, in order. */
  readonly calls: readonly ResolverCall[];
  /** Every answer the real resolver behind the gate gave, in order. */
  readonly answers: readonly Result<DataResult, DebuggenError>[];
  /**
   * Settles once the route has entered the resolver: the middleware, the
   * session and scope checks and the body read are all behind the request.
   */
  readonly entered: Promise<void>;
  /** Lets every held call, and every later one, through to the real resolver. */
  readonly release: () => void;
}

/**
 * Wraps the suite's real resolver in a gate.
 *
 * @param open Whether the gate starts released (a control case) or held.
 * @returns The gated port and what it observed.
 */
function gateResolver(open: boolean): GatedResolver {
  const calls: ResolverCall[] = [];
  const answers: Result<DataResult, DebuggenError>[] = [];
  let signalEntered: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let signalRelease: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    signalRelease = resolve;
  });
  if (open) {
    signalRelease();
  }
  return {
    resolver: {
      resolve: async (context, query) => {
        calls.push({ context, query });
        signalEntered();
        await released;
        const answer = await resolver.resolve(context, query);
        answers.push(answer);
        return answer;
      },
    },
    calls,
    answers,
    entered,
    release: () => {
      signalRelease();
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * The composed route and its replies
 * ---------------------------------------------------------------------------------------------- */

/**
 * Mounts the route behind the real auth middleware, as `src/server/http.ts`
 * registers it: protocol's method and pattern, the middleware built for the
 * operation, then the handler.
 *
 * @param port The resolver the route delegates to.
 * @param fence The revocation fence; the service's own access boundary unless
 * a case replaces it.
 * @returns The application.
 */
function composeRoute(
  port: Pick<PanelDataResolver, 'resolve'>,
  fence: PanelDataRoutesDeps['auth'] = harness.auth,
): Hono<ServerEnv> {
  const routes = createPanelDataRoutes({
    resolver: port,
    sessions: harness.repos.sessions,
    // Every case acts as the editor, whose access never depends on a binding.
    bindings: { bindingForSession: () => undefined },
    auth: fence,
    logger: harness.logger.root,
  });
  const app = new Hono<ServerEnv>();
  app.on(
    ROUTE.method,
    ROUTE.pattern,
    createAuthMiddleware(harness.auth)(PANEL_DATA_OPERATION),
    routes[PANEL_DATA_OPERATION],
  );
  return app;
}

/** One answered request, read in full. */
interface Reply {
  readonly status: number;
  readonly cacheControl: string | null;
  readonly text: string;
  readonly json: unknown;
}

/**
 * Posts one panel-data query for the suite's session.
 *
 * @param app The composed route.
 * @param token The bearer credential to present.
 * @param query The body.
 * @returns The reply.
 */
async function postQuery(
  app: Hono<ServerEnv>,
  token: string,
  query: PanelDataRequest,
): Promise<Reply> {
  const response = await app.request(buildPath(PANEL_DATA_OPERATION, { id: session.id }), {
    method: ROUTE.method,
    headers: {
      [AUTHORIZATION_HEADER]: formatBearer(token),
      'content-type': 'application/json',
    },
    body: JSON.stringify(query),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    status: response.status,
    cacheControl: response.headers.get(CACHE_CONTROL_HEADER),
    text,
    json,
  };
}

/**
 * The reply's body as protocol's error payload.
 *
 * @throws Error When the body is not one.
 */
function refusalOf(reply: Reply): HttpErrorResponse {
  const parsed = httpErrorResponseSchema.safeParse(reply.json);
  if (!parsed.success) {
    throw new Error(`The ${String(reply.status)} reply is not protocol's error payload.`);
  }
  return parsed.data;
}

/** The top-level keys of a reply's body; empty when it is not an object. */
function bodyKeys(reply: Reply): readonly string[] {
  return typeof reply.json === 'object' && reply.json !== null ? Object.keys(reply.json) : [];
}

/** The records written since `mark` whose message equals `message`. */
function logsSince(mark: number, message: string): readonly CapturedLogRecord[] {
  return harness.logger.records.slice(mark).filter((record) => record.message === message);
}

/** The one answer the gated resolver gave. @throws Error Unless it gave exactly one. */
function onlyAnswer(gate: GatedResolver): Result<DataResult, DebuggenError> {
  expect(gate.answers).toHaveLength(1);
  const [answer] = gate.answers;
  if (answer === undefined) {
    throw new Error('The resolver behind the gate never answered.');
  }
  return answer;
}

/**
 * A body that is not JSON — an object left open — which the route refuses
 * `400` once it has read it all. Nothing in it is data: it only has to fail to
 * parse.
 */
const UNPARSEABLE_BODY = '{"source":';

/** A request body the test holds open until it chooses to finish it. */
interface HeldBody {
  /** The stream handed to the request. */
  readonly stream: ReadableStream<Uint8Array>;
  /**
   * Settles once the route has started reading the body: the middleware, the
   * session and scope checks are all behind the request, and the handler is
   * awaiting the client.
   */
  readonly reading: Promise<void>;
  /** Sends the rest of the body — {@link UNPARSEABLE_BODY} — and ends it. */
  readonly finish: () => void;
}

/**
 * A body delivered only when the test says so.
 *
 * `highWaterMark: 0` keeps the stream from pulling before a reader asks, so
 * the first pull is the handler's own body read; that pull reports
 * {@link HeldBody.reading} and then waits for {@link HeldBody.finish}, which
 * delivers the whole unparseable body and closes the stream.
 *
 * @param held Whether the body is held (a race case) or sent at once (a control).
 */
function holdBody(held: boolean): HeldBody {
  let signalReading: () => void = () => undefined;
  const reading = new Promise<void>((resolve) => {
    signalReading = resolve;
  });
  let signalFinish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    signalFinish = resolve;
  });
  if (!held) {
    signalFinish();
  }
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller): Promise<void> {
        pulls += 1;
        if (pulls > 1) {
          controller.close();
          return;
        }
        signalReading();
        await finished;
        controller.enqueue(new TextEncoder().encode(UNPARSEABLE_BODY));
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, reading, finish: () => signalFinish() };
}

/**
 * Posts a streamed, length-less body for the suite's session — the request
 * shape whose body the route awaits for as long as the client takes.
 *
 * @param app The composed route.
 * @param token The bearer credential to present.
 * @param body The held body.
 * @returns The reply.
 */
async function postStreamed(app: Hono<ServerEnv>, token: string, body: HeldBody): Promise<Reply> {
  const response = await app.request(
    new Request(`http://127.0.0.1${buildPath(PANEL_DATA_OPERATION, { id: session.id })}`, {
      method: ROUTE.method,
      headers: {
        [AUTHORIZATION_HEADER]: formatBearer(token),
        'content-type': 'application/json',
      },
      body: body.stream,
      duplex: 'half',
    }),
  );
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    status: response.status,
    cacheControl: response.headers.get(CACHE_CONTROL_HEADER),
    text,
    json,
  };
}

/* -------------------------------------------------------------------------------------------------
 * The editor and the rotation
 * ---------------------------------------------------------------------------------------------- */

/**
 * The live editor connection announcing the suite's project — opened under the
 * current credential when a rotation closed the last one — which editor
 * session requests require (AAP §0.5.6).
 */
async function announcedEditor(): Promise<HarnessWsClient> {
  const editor = await harness.editor(project.root);
  expect(editor.authenticated, editor.describe()).toBe(true);
  return editor;
}

/**
 * Rotates every credential through the service's own `AuthService.rotateAll`
 * and waits until `editor` was closed with `WS_CLOSE_UNAUTHORIZED`, so it is
 * never mistaken for a live announcement afterwards.
 *
 * @param editor The editor connection the rotation must close.
 * @returns The credential the rotation retired.
 */
async function rotateClosing(editor: HarnessWsClient): Promise<string> {
  const retired = harness.editorToken;
  const closesBefore = editor.closes.length;
  harness.rotateAll();
  const closed = await editor.waitForClose(HARNESS_TIMEOUTS.message, closesBefore);
  expect(closed.code, editor.describe()).toBe(WS_CLOSE_UNAUTHORIZED);
  expect(harness.editorToken).not.toBe(retired);
  return retired;
}

/* -------------------------------------------------------------------------------------------------
 * The cases
 * ---------------------------------------------------------------------------------------------- */

describe('the panel-data revocation fence', () => {
  it('answers a query whose credential stays live with the resolver’s own result', async () => {
    await announcedEditor();
    const gate = gateResolver(true);
    const mark = harness.logger.records.length;

    const reply = await postQuery(composeRoute(gate.resolver), harness.editorToken, LIVE_QUERY);

    expect(reply.status).toBe(200);
    expect(reply.cacheControl).toBe(NO_STORE);
    expect(gate.calls).toHaveLength(1);
    const answer = onlyAnswer(gate);
    if (isErr(answer)) {
      throw new Error(`The resolver refused the control query (${answer.error.code}).`);
    }
    expect(ROUTE.response.safeParse(reply.json).success).toBe(true);
    expect(reply.json).toEqual(answer.value);
    expect(logsSince(mark, FENCE_REFUSAL_LOG)).toEqual([]);
  });

  it('refuses a query whose credential a rotation retired while the resolver ran, and sends none of its result', async () => {
    const editor = await announcedEditor();
    const gate = gateResolver(false);
    const pending = postQuery(composeRoute(gate.resolver), harness.editorToken, LIVE_QUERY);

    // Entered: the middleware authenticated the request and every check before
    // the resolver passed. The rotation lands while the resolver holds its answer.
    await gate.entered;
    const mark = harness.logger.records.length;
    await rotateClosing(editor);
    gate.release();
    const reply = await pending;

    expect(reply.status).toBe(401);
    expect(reply.cacheControl).toBe(NO_STORE);
    const refusal = refusalOf(reply);
    expect(refusal.code).toBe(AUTH_FAILURE_REASONS['unknown-credential'].code);
    expect(refusal.message).toBe(AUTH_FAILURE_REASONS['unknown-credential'].message);

    // The resolver answered, once, and the route discarded its result unsent.
    expect(gate.calls).toHaveLength(1);
    const answer = onlyAnswer(gate);
    if (isErr(answer)) {
      throw new Error(`The resolver refused the held query (${answer.error.code}).`);
    }
    expect(ROUTE.response.safeParse(reply.json).success).toBe(false);
    for (const key of Object.keys(answer.value)) {
      expect(bodyKeys(reply)).not.toContain(key);
    }

    // The fence refused it — not the middleware, which admitted it before the rotation.
    const fenced = logsSince(mark, FENCE_REFUSAL_LOG);
    expect(fenced).toHaveLength(1);
    expect(fenced[0]?.fields['reason']).toBe('unknown-credential');
    expect(fenced[0]?.fields['role']).toBe('vscode');
    expect(logsSince(mark, MIDDLEWARE_REFUSAL_LOG)).toEqual([]);
    const refused = logsSince(mark, ROUTE_REFUSAL_LOG);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.fields['status']).toBe(401);
    expect(refused[0]?.fields['reason']).toBe('unknown-credential');
  });

  it('refuses a retired credential before the resolver’s own failure can describe the session', async () => {
    // A panel this session does not hold: the resolver refuses it `409`, which
    // tells the caller something about the session. A retired credential must
    // not learn even that.
    const panelBound: PanelDataRequest = { source: 'events', panelId: newPanelId() };

    const editor = await announcedEditor();
    const control = await postQuery(
      composeRoute(gateResolver(true).resolver),
      harness.editorToken,
      panelBound,
    );
    expect(control.status).toBe(409);
    expect(refusalOf(control).code).toBe('SESSION_INVALID_STATE');

    const gate = gateResolver(false);
    const pending = postQuery(composeRoute(gate.resolver), harness.editorToken, panelBound);
    await gate.entered;
    await rotateClosing(editor);
    gate.release();
    const reply = await pending;

    const answer = onlyAnswer(gate);
    expect(isErr(answer) ? answer.error.code : 'answered').toBe('SESSION_INVALID_STATE');
    expect(reply.status).toBe(401);
    expect(refusalOf(reply).code).toBe(AUTH_FAILURE_REASONS['unknown-credential'].code);
    expect(refusalOf(reply).message).toBe(AUTH_FAILURE_REASONS['unknown-credential'].message);
  });

  it('refuses a credential a rotation retired while its body was still arriving, rather than judging the body', async () => {
    // Control: on a live credential the same unparseable body keeps its own
    // verdict, a `400`, and never reaches the resolver.
    await announcedEditor();
    const controlGate = gateResolver(true);
    const control = await postStreamed(
      composeRoute(controlGate.resolver),
      harness.editorToken,
      holdBody(false),
    );
    expect(control.status).toBe(400);
    expect(control.cacheControl).toBe(NO_STORE);
    expect(refusalOf(control).code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(controlGate.calls).toEqual([]);

    // Race: the handler is awaiting the rest of the body when the rotation lands.
    const editor = await announcedEditor();
    const gate = gateResolver(true);
    const body = holdBody(true);
    const pending = postStreamed(composeRoute(gate.resolver), harness.editorToken, body);
    await body.reading;
    const mark = harness.logger.records.length;
    await rotateClosing(editor);
    body.finish();
    const reply = await pending;

    expect(reply.status).toBe(401);
    expect(reply.cacheControl).toBe(NO_STORE);
    const refusal = refusalOf(reply);
    expect(refusal.code).toBe(AUTH_FAILURE_REASONS['unknown-credential'].code);
    expect(refusal.message).toBe(AUTH_FAILURE_REASONS['unknown-credential'].message);
    expect(gate.calls).toEqual([]);

    // The fence refused it after the body read — not the middleware, which
    // admitted it before the rotation — and the body's own verdict was never sent.
    const fenced = logsSince(mark, FENCE_REFUSAL_LOG);
    expect(fenced).toHaveLength(1);
    expect(fenced[0]?.fields['reason']).toBe('unknown-credential');
    expect(logsSince(mark, MIDDLEWARE_REFUSAL_LOG)).toEqual([]);
    const refused = logsSince(mark, ROUTE_REFUSAL_LOG);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.fields['status']).toBe(401);
    expect(refused[0]?.fields['reason']).toBe('unknown-credential');
  });

  it('refuses a query presenting a rotated-away credential at the middleware, before the resolver is entered', async () => {
    const retired = await rotateClosing(await announcedEditor());
    const gate = gateResolver(true);
    const app = composeRoute(gate.resolver);
    const mark = harness.logger.records.length;

    const reply = await postQuery(app, retired, LIVE_QUERY);

    expect(reply.status).toBe(401);
    expect(refusalOf(reply).code).toBe(AUTH_FAILURE_REASONS['unknown-credential'].code);
    expect(refusalOf(reply).message).toBe(AUTH_FAILURE_REASONS['unknown-credential'].message);
    expect(gate.calls).toEqual([]);
    const refusedByMiddleware = logsSince(mark, MIDDLEWARE_REFUSAL_LOG);
    expect(refusedByMiddleware).toHaveLength(1);
    expect(refusedByMiddleware[0]?.fields['operation']).toBe(PANEL_DATA_OPERATION);
    expect(refusedByMiddleware[0]?.fields['reason']).toBe('unknown-credential');
    expect(logsSince(mark, FENCE_REFUSAL_LOG)).toEqual([]);

    // The regenerated credential, announced again, is answered by the same route.
    await announcedEditor();
    const renewed = await postQuery(app, harness.editorToken, LIVE_QUERY);
    expect(renewed.status).toBe(200);
    expect(gate.calls).toHaveLength(1);
  });

  it('fails closed with the route’s fixed 500 when the fence cannot confirm the credential', async () => {
    await announcedEditor();

    // The body every opaque failure of this route carries, read from the route
    // itself: a resolver that rejects is answered with it.
    const rejecting = await postQuery(
      composeRoute({
        resolve: () => Promise.reject(new Error(`resolver probe ${randomUUID()}`)),
      }),
      harness.editorToken,
      LIVE_QUERY,
    );
    expect(rejecting.status).toBe(500);
    const opaque = refusalOf(rejecting);
    expect(opaque.code).toBe('INTERNAL');

    // A fence that throws: the thrown value is dropped, never answered or logged.
    const thrownProbe = `fence probe ${randomUUID()}`;
    const throwingGate = gateResolver(true);
    // How many answers the resolver had given at each fence call: an assertion
    // inside the fence would itself be a throw the route converts, so the
    // observation is recorded here and asserted below.
    const answersAtFence: number[] = [];
    const throwingFence: PanelDataRoutesDeps['auth'] = {
      requireLiveCredential: () => {
        answersAtFence.push(throwingGate.answers.length);
        throw new Error(thrownProbe);
      },
    };
    let mark = harness.logger.records.length;
    const thrown = await postQuery(
      composeRoute(throwingGate.resolver, throwingFence),
      harness.editorToken,
      LIVE_QUERY,
    );
    // Called once, and only once the resolver had answered.
    expect(answersAtFence).toEqual([1]);
    expect(thrown.status).toBe(500);
    expect(thrown.cacheControl).toBe(NO_STORE);
    expect(refusalOf(thrown)).toEqual(opaque);
    expect(bodyKeys(thrown)).not.toContain('events');
    expect(thrown.text).not.toContain(thrownProbe);
    const failed = logsSince(mark, ROUTE_FAILURE_LOG);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.fields['reason']).toBe('credential-check-threw');
    expect(harness.logger.text()).not.toContain(thrownProbe);

    // A fence whose credential read failed: `500` under the failure's own code
    // and the same fixed message, never the store's words.
    const storeProbe = `store probe ${randomUUID()}`;
    const failingFence: PanelDataRoutesDeps['auth'] = {
      requireLiveCredential: () =>
        err(new DebuggenError('STORE_ERROR', storeProbe, { details: { reason: 'probe' } })),
    };
    mark = harness.logger.records.length;
    const unreadable = await postQuery(
      composeRoute(gateResolver(true).resolver, failingFence),
      harness.editorToken,
      LIVE_QUERY,
    );
    expect(unreadable.status).toBe(500);
    expect(refusalOf(unreadable)).toEqual({ code: 'STORE_ERROR', message: opaque.message });
    expect(unreadable.text).not.toContain(storeProbe);
    expect(logsSince(mark, ROUTE_FAILURE_LOG)).toHaveLength(1);
  });
});
