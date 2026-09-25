/**
 * Capture ownership across the real service boundary: **at most one session may
 * hold a capture on a project at a time** (AAP §0.4.2, the `server-agent.config`
 * row: "`capture.start` for a project whose dev server is already captured by
 * another session answers `409 { owningSessionId }`, and `server-agent.config`
 * always names the single owner … tested in `test/integration/concurrency.test.ts`").
 *
 * The ownership decision itself belongs to `src/sessions/manager.ts` and is not
 * re-tested here. This suite owns the two consequences only an in-process
 * service can show:
 *
 * - **The `409` over the real route, both halves of it** — the numeric status on
 *   a raw response, and the `{ owningSessionId }` body through protocol's
 *   `captureStartConflictResponseSchema` and `HttpClient.startCapture`'s
 *   structured failure details.
 * - **What ownership gates** — the `server-agent.config` the project's preload
 *   connection receives names the owner and nobody else, server-tier telemetry
 *   is attributed to the owner's open capture window, and telemetry arriving for
 *   a non-owning session is dropped under a reason from the closed
 *   `DROP_REASONS` vocabulary with nothing persisted.
 *
 * ## Rules ruling
 *
 * - **User rules (AAP §0.10).** `review_rules` answers "No user rules
 *   provided.", so no user rule governs this file; the §0.10 baseline does.
 * - **Gate membership.** Collected by the `local-service-integration` project
 *   (`pnpm test:integration`, inside `pnpm verify`) and part of the `tsc -b`,
 *   `eslint --max-warnings 0` and `prettier --check .` programs.
 * - **No committed secret.** Every credential is minted at run time through the
 *   harness's real auth service; no token-shaped literal appears below.
 * - **Closed dependency set.** `vitest`, the `@debuggen/*` packages the service
 *   itself may import (never `panel-renderer`), the service's own modules and
 *   the harness. No `zod`, no DOM types.
 *
 * ## Why one session per pair plans without a patch
 *
 * The deterministic provider plans the same actions for every question on the
 * sample project, and one of them is a `function-timing` patch of the project's
 * route handler. The patch layer refuses to wrap a target another open session
 * already instrumented (`PATCH_UNSUPPORTED`, reason `already-instrumented`), and
 * the installer stops at that refusal, so a second deterministic session on the
 * same project would be filed `failed` and could never ask for a capture at
 * all. {@link createPlanQueue} therefore answers the plan stage of the second
 * session of each pair with a runtime-only authoring payload — validated by the
 * planner's own authoring schema like any model output — while the first
 * session plans, patches and (on `session.end`) cleans up through the real
 * deterministic pipeline.
 *
 * ## The narrative
 *
 * The tests run in declaration order over one harness and build on each
 * other's state, exactly as a developer's sessions would: session A (the
 * deterministic owner) and session B (runtime-only) share the harness's copy of
 * the sample project; session C lives on a second copy; sessions D and E are
 * opened on the first copy once A has ended, for the races.
 *
 * @module
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DISABLED_SERVER_AGENT_SIGNALS,
  TARGETLESS_FILE,
  TARGETLESS_SYMBOL,
} from '@debuggen/instrumentation';
import type { InstrumentationPlanInput } from '@debuggen/instrumentation';
import { parseInstrumentationPlanInput } from '@debuggen/instrumentation/schema';
import { createDeterministicProvider } from '@debuggen/model-provider';
import type { ModelProvider, PromptStage } from '@debuggen/model-provider';
import {
  CAPTURE_CONFLICT_ERROR_CODE,
  captureStartConflictResponseSchema,
  httpErrorResponseSchema,
  isMessageOfType,
  parseServerAgentConfigPayload,
} from '@debuggen/protocol';
import type { ServerAgentConfigPayload, SessionRecord } from '@debuggen/protocol';
import { isErr, newEventId, newId, newProducerId, newTraceId, ok } from '@debuggen/shared';
import type { DebuggenError, Result } from '@debuggen/shared';
import type { TelemetryEventIngress } from '@debuggen/telemetry';

import { HTTP_ERROR_STATUS_BY_CODE } from '../../src/server/http.js';
import {
  DROP_REASONS,
  PRODUCING_ORIGIN_BY_TIER,
  isDropReason,
} from '../../src/telemetry/attribute.js';
import type { DropReason, IngestOrigin } from '../../src/telemetry/attribute.js';
import {
  HARNESS_TIMEOUTS,
  owningSessionIdOf,
  readTelemetryBatch,
  startHarness,
  waitFor,
} from './harness.js';
import type { CapturedLogRecord, Harness, HarnessWsClient } from './harness.js';

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The status a capture-ownership conflict is answered with, as the service's
 * own code → status table states it. Every assertion reads this name; the one
 * deliberate numeric literal is {@link PINNED_CONFLICT_STATUS}.
 */
const CONFLICT_STATUS = HTTP_ERROR_STATUS_BY_CODE[CAPTURE_CONFLICT_ERROR_CODE];

/**
 * AAP §0.4.2 fixes the conflict as `409` on the wire. Pinned once, where the raw
 * status is the thing under test, so a remapped code table cannot move the
 * contract without this suite noticing.
 */
const PINNED_CONFLICT_STATUS = 409;

/** The code of a request the session's own state does not admit. */
const INVALID_STATE_CODE = 'SESSION_INVALID_STATE' as const;

/** Its status, from the same table. */
const INVALID_STATE_STATUS = HTTP_ERROR_STATUS_BY_CODE[INVALID_STATE_CODE];

/** The question every session asks; nothing in the service may branch on it (AAP §0.5.4). */
const QUESTION = 'Why is the trail report slow to load after I pick a trail?';

/** The committed cross-tier batch the ingest assertions post (fixture README, tag `ct`). */
const CROSS_TIER_FIXTURE = 'telemetry-trace-cross-tier.json';

/** The pipeline stage whose answer {@link createPlanQueue} may replace. */
const PLAN_STAGE: PromptStage = 'plan';

/** The model id a queued plan reports, so a reader of the session can tell it apart. */
const QUEUED_PLAN_MODEL = 'concurrency-suite-queued-plan';

/** The prefix of the per-document ids the simulated page agents report in `agent.ready`. */
const DOCUMENT_ID_PREFIX = 'doc';

/** The first inspected tab id; every session gets the next one. */
const FIRST_TAB_ID = 7_100;

/**
 * A runtime-only plan in the authoring shape a model returns: interaction,
 * request and database signals, every action targetless, so installing it
 * edits no file and it can coexist with a sibling session's patch.
 * `db-query-tracking` is what makes the capture collect server-tier
 * telemetry, so arming it sends a `server-agent.config`.
 */
const RUNTIME_ONLY_PLAN: InstrumentationPlanInput = {
  objective: 'Observe the interaction, its requests and its database queries without editing code',
  capture: ['click event timing', 'fetch calls', 'database query spans'],
  instrumentationTargets: [
    { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'interaction-tracking' },
    { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'fetch-tracking' },
    { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: 'db-query-tracking' },
  ],
};

/** Every telemetry row one trace left in the store, in ingest order. */
const ROWS_BY_TRACE_SQL =
  'SELECT id, session_id AS sessionId, capture_id AS captureId FROM telemetry_events WHERE trace_id = ? ORDER BY ingest_seq';

/** How many telemetry rows the store holds. */
const EVENT_COUNT_SQL = 'SELECT COUNT(*) AS total FROM telemetry_events';

/** How many capture windows are open on one project root. */
const OPEN_CAPTURES_SQL =
  'SELECT COUNT(*) AS total FROM captures JOIN sessions ON sessions.id = captures.session_id WHERE captures.stopped_at IS NULL AND sessions.project_root = ?';

/* -------------------------------------------------------------------------------------------------
 * The plan queue
 * ---------------------------------------------------------------------------------------------- */

/** The deterministic provider, with a queue of plan-stage answers in front of it. */
interface PlanQueue {
  /** The provider handed to {@link startHarness}. */
  readonly provider: ModelProvider;
  /** Answers the next plan-stage call with `plan` instead of the deterministic planner. */
  enqueue(plan: InstrumentationPlanInput): void;
  /** How many queued plans have not been served yet. */
  pending(): number;
}

/**
 * Wraps the real deterministic provider so the suite can decide, per session,
 * whether its plan is the deterministic one or {@link RUNTIME_ONLY_PLAN}.
 *
 * Honours the provider contract exactly as the harness's scripted fake does:
 * one attempt per call, never a throw or a rejection, and no repair loop of its
 * own — a queued answer still goes through the planner's authoring schema,
 * normalisation and feasibility gate. Every other stage and every unqueued plan
 * call is answered by the deterministic provider unchanged.
 */
function createPlanQueue(): PlanQueue {
  const created = createDeterministicProvider();
  if (isErr(created)) {
    throw new Error(`The deterministic provider could not be built: ${created.error.message}`, {
      cause: created.error,
    });
  }
  const base = created.value;
  const queued: InstrumentationPlanInput[] = [];

  const provider: ModelProvider = {
    id: base.id,
    generateText: (request) => base.generateText(request),
    generateStructured: (schema, request) => {
      const next = request.metadata.stage === PLAN_STAGE ? queued.shift() : undefined;
      if (next === undefined) {
        return base.generateStructured(schema, request);
      }
      return Promise.resolve(ok({ raw: next, model: QUEUED_PLAN_MODEL, providerId: base.id }));
    },
    callTools: (request, tools) => base.callTools(request, tools),
  };

  return {
    provider,
    enqueue: (plan) => {
      queued.push(plan);
    },
    pending: () => queued.length,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Suite state and the shapes the helpers share
 * ---------------------------------------------------------------------------------------------- */

let harness: Harness;
let planQueue: PlanQueue;
let nextTabId = FIRST_TAB_ID;

/** One copy of the sample project, its launched dev server and its preload connection. */
interface ProjectUnderTest {
  /** The copy's absolute POSIX root — the key capture ownership is decided by. */
  readonly root: string;
  /** The URL the launched (stand-in) dev server answers on. */
  readonly devServerUrl: string;
  /** That URL's origin, which a DevTools binding must match. */
  readonly origin: string;
  /** A `server-agent` connection whose credential is scoped to {@link root}. */
  readonly serverAgent: HarnessWsClient;
  /** That credential, for the `telemetry.event` ingest operation. */
  readonly serverAgentToken: string;
}

/** Which planner answers a new session's plan stage. */
type PlanSource = 'deterministic' | 'runtime-only';

/** A session in `ready`, with a bound DevTools tab whose page agent reported. */
interface SessionUnderTest {
  readonly id: string;
  readonly projectRoot: string;
  readonly tabId: number;
  /** The DevTools connection that bound the tab. */
  readonly devtools: HarnessWsClient;
  /** Its credential, so a leak check can look for it. */
  readonly devtoolsToken: string;
}

/** A re-identified slice of the cross-tier batch and the one trace it now belongs to. */
interface FreshBatch {
  readonly traceId: string;
  readonly events: readonly TelemetryEventIngress[];
}

/** Where the store filed one telemetry row. */
interface StoredAttribution {
  readonly id: string;
  readonly sessionId: string;
  readonly captureId: string;
}

/* -------------------------------------------------------------------------------------------------
 * Setup helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Launches the project's dev server through the real launcher (the harness's
 * stand-in command, preload attached) and connects a `server-agent` client
 * with a credential scoped to exactly this project.
 */
async function prepareProject(root: string): Promise<ProjectUnderTest> {
  const launched = await harness.launchDevServer(root);
  if (isErr(launched)) {
    throw new Error(
      `devServer.launch was refused (${launched.error.code}): ${launched.error.message}`,
      { cause: launched.error },
    );
  }
  const { devServerUrl } = launched.value;
  const credential = harness.issueServerAgentCredential(root);
  const serverAgent = await harness.ws({
    client: 'server-agent',
    projectRoot: root,
    token: credential.token,
  });
  if (!serverAgent.authenticated) {
    throw new Error(`The server-agent connection was not accepted: ${serverAgent.describe()}`);
  }
  return Object.freeze({
    root,
    devServerUrl,
    origin: new URL(devServerUrl).origin,
    serverAgent,
    serverAgentToken: credential.token,
  });
}

/**
 * Creates a session on `project` and brings it to `ready` the way the product
 * does: the pipeline plans and installs, a DevTools connection binds a tab to
 * the session, and the page agent of that tab reports a document whose React
 * hook was installed first — the readiness gate's two browser preconditions.
 *
 * @throws Error When the session is filed anything but `ready`.
 */
async function openSession(project: ProjectUnderTest, plan: PlanSource): Promise<SessionUnderTest> {
  if (plan === 'runtime-only') {
    planQueue.enqueue(RUNTIME_ONLY_PLAN);
  }
  const created = await harness.createSession({ projectRoot: project.root, question: QUESTION });

  const tabId = nextTabId;
  nextTabId += 1;
  const { client, credential } = await harness.connectDevtools({ tabId });
  const bound = await harness.bindTab(client, {
    tabId,
    url: project.devServerUrl,
    origin: project.origin,
    sessionId: created.id,
  });
  if (isErr(bound)) {
    throw new Error(`session.bind was refused (${bound.error.code}): ${bound.error.message}`);
  }

  const receipt = client.send('agent.ready', {
    tabId,
    documentId: newId(DOCUMENT_ID_PREFIX),
    producerId: newProducerId(),
    url: project.devServerUrl,
    installedBeforeReact: true,
    reactDetected: true,
  });
  if (isErr(receipt.result)) {
    throw new Error(`agent.ready could not be sent: ${receipt.result.error.message}`);
  }
  const settled = await client.flush();
  const refusals = client.errorsFor(receipt.id);
  if (!settled || refusals.length > 0) {
    throw new Error(`agent.ready was not accepted: ${client.describe()}`);
  }

  const reached = await harness.waitForSession(
    created.id,
    (record) => record.status === 'ready' || record.status === 'failed',
  );
  if (reached.status !== 'ready') {
    throw new Error(`Session ${created.id} was filed "${reached.status}" instead of "ready".`);
  }
  expect(planQueue.pending()).toBe(0);
  const actions = reached.plans.at(-1)?.instrumentationTargets ?? [];
  if (plan === 'runtime-only') {
    expect(actions.map((action) => action.mode)).toEqual(
      RUNTIME_ONLY_PLAN.instrumentationTargets.map(() => 'runtime'),
    );
    expect(reached.modifications).toEqual([]);
  } else {
    expect(reached.modifications.some((record) => record.status === 'applied')).toBe(true);
  }

  return Object.freeze({
    id: created.id,
    projectRoot: created.projectRoot,
    tabId,
    devtools: client,
    devtoolsToken: credential.token,
  });
}

/**
 * The cross-tier fixture's events of one producing origin, re-identified —
 * fresh event ids, one fresh trace and fresh producer ids — because the store
 * refuses an event id it already holds, and several captures here receive the
 * same slice. Order, `seq`, timing, span links and attributes are untouched.
 */
function freshBatch(origin: IngestOrigin): FreshBatch {
  const traceId = newTraceId();
  const producers = new Map<string, string>();
  const events = readTelemetryBatch(CROSS_TIER_FIXTURE)
    .filter((event) => PRODUCING_ORIGIN_BY_TIER[event.tier] === origin)
    .map((event): TelemetryEventIngress => {
      const producerId = producers.get(event.producerId) ?? newProducerId();
      producers.set(event.producerId, producerId);
      return { ...event, id: newEventId(), traceId, producerId };
    });
  if (events.length === 0) {
    throw new Error(`${CROSS_TIER_FIXTURE} holds no event an ${origin} produces.`);
  }
  return Object.freeze({ traceId, events });
}

/* -------------------------------------------------------------------------------------------------
 * Probes: the store, the manager, the logs and the transcripts
 * ---------------------------------------------------------------------------------------------- */

/** A text column of one store row. */
function textColumn(row: Readonly<Record<string, unknown>>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new Error(`The store row has no text column "${column}".`);
  }
  return value;
}

/** The `total` of a `COUNT(*) AS total` query. */
function countOf(sql: string, ...params: readonly string[]): number {
  const value = harness.store.statement(sql).get(...params)?.['total'];
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    throw new Error('The count query answered no total.');
  }
  return Number(value);
}

/** How many capture windows are open on `projectRoot`, read from the `captures` table. */
function openCaptures(projectRoot: string): number {
  return countOf(OPEN_CAPTURES_SQL, projectRoot);
}

/** How many telemetry rows the store holds in all. */
function storedEventCount(): number {
  return countOf(EVENT_COUNT_SQL);
}

/** Where the store filed every row of one trace, in ingest order. */
function rowsOfTrace(traceId: string): StoredAttribution[] {
  return harness.store
    .statement(ROWS_BY_TRACE_SQL)
    .all(traceId)
    .map((row) => ({
      id: textColumn(row, 'id'),
      sessionId: textColumn(row, 'sessionId'),
      captureId: textColumn(row, 'captureId'),
    }));
}

/** The open capture window of a session, as the store holds it. */
function activeCaptureId(sessionId: string): string | undefined {
  const active = harness.repos.sessions.getActiveCapture(sessionId);
  if (isErr(active)) {
    throw new Error(`The open capture of ${sessionId} could not be read (${active.error.code}).`);
  }
  return active.value?.capture.id;
}

/** A session as the store holds it. */
function storedSession(sessionId: string): SessionRecord {
  const read = harness.repos.sessions.get(sessionId);
  if (isErr(read) || read.value === undefined) {
    throw new Error(`Session ${sessionId} could not be read from the store.`);
  }
  return read.value;
}

/** The manager's single answer to "who captures this project?". */
function ownerOf(projectRoot: string): { sessionId: string; captureId: string } | undefined {
  const owner = harness.manager.captureOwnerForProject(projectRoot);
  return owner === undefined
    ? undefined
    : { sessionId: owner.sessionId, captureId: owner.captureId };
}

/** The `server-agent.config` payloads `client` received from transcript index `from` on. */
function serverConfigsSince(client: HarnessWsClient, from: number): ServerAgentConfigPayload[] {
  return client.received
    .slice(from)
    .flatMap((message) =>
      isMessageOfType(message, 'server-agent.config') ? [message.payload] : [],
    );
}

/**
 * Waits for a `server-agent.config` at transcript index `from` or later that
 * satisfies `predicate`, and re-validates it with protocol's payload parser.
 */
async function waitForServerConfig(
  client: HarnessWsClient,
  from: number,
  predicate: (payload: ServerAgentConfigPayload) => boolean,
): Promise<ServerAgentConfigPayload> {
  const message = await waitFor(
    client,
    'server-agent.config',
    (candidate, index) => index >= from && predicate(candidate.payload),
    HARNESS_TIMEOUTS.capture,
  );
  const parsed = parseServerAgentConfigPayload(message.payload);
  if (isErr(parsed)) {
    throw new Error(`A server-agent.config failed its payload schema: ${parsed.error.message}`);
  }
  return parsed.value;
}

/** The attribution-drop records written since log index `mark` for one producing origin. */
function dropRecordsSince(mark: number, origin: IngestOrigin): CapturedLogRecord[] {
  return harness.logger.records
    .slice(mark)
    .filter((record) => record.fields.origin === origin && isDropReason(record.fields.reason));
}

/**
 * Proves a batch was dropped by attribution under exactly `reason` — a member
 * of the closed `DROP_REASONS` vocabulary — and, when `sessionId` is given,
 * that the refusal was made in that session's context.
 */
function expectDropped(
  mark: number,
  origin: IngestOrigin,
  reason: DropReason,
  sessionId?: string,
): void {
  const records = dropRecordsSince(mark, origin);
  expect(records.length).toBeGreaterThan(0);
  expect([...new Set(records.map((record) => record.fields.reason))]).toEqual([reason]);
  expect(DROP_REASONS).toContain(reason);
  if (sessionId !== undefined) {
    expect(records.some((record) => Object.values(record.fields).includes(sessionId))).toBe(true);
  }
}

/** The capture id of a successful `capture.start`, or a failure naming the refusal. */
function expectStarted(
  result: Result<{ readonly captureId: string }, DebuggenError>,
  label: string,
): string {
  if (isErr(result)) {
    throw new Error(
      `${label}: capture.start was refused (${result.error.code}): ${result.error.message}`,
    );
  }
  return result.value.captureId;
}

/** The refusal of a `capture.start` or `capture.stop` that must fail. */
function expectRefused<T>(result: Result<T, DebuggenError>, label: string): DebuggenError {
  if (!isErr(result)) {
    throw new Error(`${label} was expected to be refused, but it succeeded.`);
  }
  return result.error;
}

/** Posts a server-tier batch with the project's scoped credential and returns the counts. */
async function ingestServerBatch(
  project: ProjectUnderTest,
  batch: FreshBatch,
): Promise<{ readonly accepted: number; readonly rejected?: number | undefined }> {
  const ingested = await harness.ingestFromServerAgent({
    token: project.serverAgentToken,
    projectRoot: project.root,
    events: batch.events,
  });
  if (isErr(ingested)) {
    throw new Error(
      `telemetry ingest was refused (${ingested.error.code}): ${ingested.error.message}`,
    );
  }
  return ingested.value;
}

/** Proves every event of `batch` is stored under `sessionId` and `captureId`, and nothing else is. */
function expectAttributed(batch: FreshBatch, sessionId: string, captureId: string): void {
  const rows = rowsOfTrace(batch.traceId);
  expect(rows.map((row) => row.id).sort()).toEqual(batch.events.map((event) => event.id).sort());
  for (const row of rows) {
    expect(row).toEqual({ id: row.id, sessionId, captureId });
  }
}

/* -------------------------------------------------------------------------------------------------
 * The suite
 * ---------------------------------------------------------------------------------------------- */

describe('one capture per project root, across the real service boundary', () => {
  /** The harness's own copy of the sample project: sessions A, B, D and E. */
  let primary: ProjectUnderTest;
  /** A second, independent copy: session C. */
  let secondary: ProjectUnderTest;
  /** The deterministic session that captures first. */
  let sessionA: SessionUnderTest;
  /** The runtime-only session that asks second. */
  let sessionB: SessionUnderTest;
  /** Opened on the primary copy once A has ended and restored its patch. */
  let sessionD: SessionUnderTest;
  let captureA: string;
  let captureB: string;
  /** Every editor and DevTools connection, for "this frame reached nobody else" checks. */
  const uiClients: HarnessWsClient[] = [];

  beforeAll(async () => {
    expect(isErr(parseInstrumentationPlanInput(RUNTIME_ONLY_PLAN))).toBe(false);
    planQueue = createPlanQueue();
    harness = await startHarness({ provider: planQueue.provider });

    primary = await prepareProject(harness.requireProject().root);
    const secondCopy = await harness.copyFixtureProject();
    secondary = await prepareProject(secondCopy.root);
    uiClients.push(await harness.editor(primary.root), await harness.editor(secondary.root));

    sessionA = await openSession(primary, 'deterministic');
    sessionB = await openSession(primary, 'runtime-only');
    uiClients.push(sessionA.devtools, sessionB.devtools);
    expect(sessionB.projectRoot).toBe(sessionA.projectRoot);
  });

  afterAll(async () => {
    await harness.assertNoLeaks();
  });

  it("answers a second session's capture.start with a typed 409 that names the owner", async () => {
    const marks = new Map(uiClients.map((client) => [client, client.received.length] as const));

    captureA = expectStarted(await harness.startCapture(sessionA.id), 'session A');
    const started = await waitFor(
      sessionA.devtools,
      'capture.started',
      (message) => message.payload.captureId === captureA,
      HARNESS_TIMEOUTS.capture,
    );
    expect(started.payload.sessionId).toBe(sessionA.id);
    expect(ownerOf(primary.root)).toEqual({ sessionId: sessionA.id, captureId: captureA });

    // The protocol client's half: a structured failure carrying the owner, never a throw.
    const refused = expectRefused(await harness.http().startCapture(sessionB.id), 'session B');
    expect(refused.code).toBe(CAPTURE_CONFLICT_ERROR_CODE);
    expect(owningSessionIdOf(refused)).toBe(sessionA.id);
    expect(refused.details?.['status']).toBe(CONFLICT_STATUS);

    // The wire's half: the numeric status, pinned once, and the body through its schema.
    const raw = await harness.rawFetch(
      { operation: 'capture.start', params: { id: sessionB.id } },
      { body: {} },
    );
    expect(raw.status).toBe(PINNED_CONFLICT_STATUS);
    expect(CONFLICT_STATUS).toBe(PINNED_CONFLICT_STATUS);
    const conflict = captureStartConflictResponseSchema.safeParse(raw.json);
    if (!conflict.success) {
      throw new Error(`The 409 body is not the capture-conflict shape: ${raw.text}`);
    }
    expect(conflict.data.code).toBe(CAPTURE_CONFLICT_ERROR_CODE);
    expect(conflict.data.owningSessionId).toBe(sessionA.id);
    // Strict schemas: the typed conflict is not a plain error body in disguise.
    expect(httpErrorResponseSchema.safeParse(raw.json).success).toBe(false);

    // Nothing beyond the owning session's id: no path, no credential, no internal detail.
    const withheld = [
      primary.root,
      harness.home,
      harness.editorToken,
      sessionA.devtoolsToken,
      sessionB.devtoolsToken,
      primary.serverAgentToken,
      sessionB.id,
    ];
    for (const value of withheld) {
      expect(raw.text).not.toContain(value);
    }

    // Session A's capture is untouched, and B never advanced.
    expect(activeCaptureId(sessionA.id)).toBe(captureA);
    expect(activeCaptureId(sessionB.id)).toBeUndefined();
    expect(ownerOf(primary.root)).toEqual({ sessionId: sessionA.id, captureId: captureA });
    expect(storedSession(sessionA.id).status).toBe('capturing');
    expect(storedSession(sessionB.id).status).toBe('ready');
    expect(openCaptures(primary.root)).toBe(1);

    // Every frame written before the barrier replies has arrived: none announced B.
    await Promise.all(uiClients.map((client) => client.flush()));
    for (const client of uiClients) {
      const announcedB = client.received
        .slice(marks.get(client) ?? 0)
        .filter(
          (message) =>
            isMessageOfType(message, 'capture.started') &&
            message.payload.sessionId === sessionB.id,
        );
      expect(announcedB).toEqual([]);
    }
  });

  it('scopes ownership to the project root: a session on another project captures alongside', async () => {
    const sessionC = await openSession(secondary, 'deterministic');
    uiClients.push(sessionC.devtools);
    const primaryMark = primary.serverAgent.received.length;
    const secondaryMark = secondary.serverAgent.received.length;

    const captureC = expectStarted(await harness.http().startCapture(sessionC.id), 'session C');
    expect(ownerOf(secondary.root)).toEqual({ sessionId: sessionC.id, captureId: captureC });
    expect(ownerOf(primary.root)).toEqual({ sessionId: sessionA.id, captureId: captureA });
    expect(openCaptures(primary.root)).toBe(1);
    expect(openCaptures(secondary.root)).toBe(1);

    // Each project's preload hears about its own owner only.
    const configC = await waitForServerConfig(
      secondary.serverAgent,
      secondaryMark,
      (payload) => payload.captureId === captureC,
    );
    expect(configC.sessionId).toBe(sessionC.id);
    await primary.serverAgent.flush();
    expect(
      serverConfigsSince(primary.serverAgent, primaryMark).filter(
        (payload) => payload.captureId === captureC || payload.sessionId === sessionC.id,
      ),
    ).toEqual([]);

    // Releasing C leaves the primary project's owner exactly as it was.
    const stoppedC = await harness.stopCapture(sessionC.id);
    if (isErr(stoppedC)) {
      throw new Error(`session C: capture.stop was refused (${stoppedC.error.code})`);
    }
    expect(stoppedC.value.summary.captureId).toBe(captureC);
    expect(ownerOf(secondary.root)).toBeUndefined();
    expect(ownerOf(primary.root)).toEqual({ sessionId: sessionA.id, captureId: captureA });
  });

  it('names the single owner in server-agent.config and attributes server-tier telemetry to its capture', async () => {
    const config = await waitForServerConfig(
      primary.serverAgent,
      0,
      (payload) => payload.captureId === captureA,
    );
    expect(config.sessionId).toBe(sessionA.id);
    expect(config.signals).not.toEqual(DISABLED_SERVER_AGENT_SIGNALS);

    // Delivered to the project's preload connection, once, and to nobody else.
    await Promise.all([...uiClients, secondary.serverAgent].map((client) => client.flush()));
    expect(
      serverConfigsSince(primary.serverAgent, 0).filter(
        (payload) => payload.captureId === captureA,
      ),
    ).toHaveLength(1);
    expect(
      serverConfigsSince(secondary.serverAgent, 0).filter(
        (payload) => payload.captureId === captureA || payload.sessionId === sessionA.id,
      ),
    ).toEqual([]);
    for (const client of uiClients) {
      expect(serverConfigsSince(client, 0)).toEqual([]);
    }

    // Server-tier spans are filed under the owner's open capture window.
    const serverBatch = freshBatch('server-agent');
    const counts = await ingestServerBatch(primary, serverBatch);
    expect(counts).toEqual({ accepted: serverBatch.events.length });
    expectAttributed(serverBatch, sessionA.id, captureA);

    // Telemetry arriving in the non-owner's context is dropped, and nothing is stored.
    const storedBefore = storedEventCount();
    const logMark = harness.logger.records.length;
    const browserBatch = freshBatch('browser-agent');
    const relayed = await harness.ingestFromAgent(sessionB.devtools, browserBatch.events);
    expect(relayed.settled).toBe(true);
    expect(relayed.errors).toEqual([]);
    expectDropped(logMark, 'browser-agent', 'no-active-capture', sessionB.id);
    expect(storedEventCount()).toBe(storedBefore);
    expect(rowsOfTrace(browserBatch.traceId)).toEqual([]);
    expect(ownerOf(primary.root)).toEqual({ sessionId: sessionA.id, captureId: captureA });
  });

  it("releases ownership when the owner's session ends, and names the next owner", async () => {
    const configMark = primary.serverAgent.received.length;

    const ended = await harness.endSession(sessionA.id);
    if (isErr(ended)) {
      throw new Error(`session A: session.end was refused (${ended.error.code})`);
    }
    // Cleanup ran: A's patch was restored and the capture window closed with the session.
    expect(ended.value.cleanup).toBe('clean');
    expect(storedSession(sessionA.id).status).toBe('ended');
    expect(activeCaptureId(sessionA.id)).toBeUndefined();
    expect(ownerOf(primary.root)).toBeUndefined();
    expect(openCaptures(primary.root)).toBe(0);

    captureB = expectStarted(await harness.http().startCapture(sessionB.id), 'session B');
    expect(ownerOf(primary.root)).toEqual({ sessionId: sessionB.id, captureId: captureB });
    expect(openCaptures(primary.root)).toBe(1);

    const config = await waitForServerConfig(
      primary.serverAgent,
      configMark,
      (payload) => payload.captureId === captureB,
    );
    expect(config.sessionId).toBe(sessionB.id);
    expect(config.signals).not.toEqual(DISABLED_SERVER_AGENT_SIGNALS);

    const serverBatch = freshBatch('server-agent');
    const counts = await ingestServerBatch(primary, serverBatch);
    expect(counts).toEqual({ accepted: serverBatch.events.length });
    expectAttributed(serverBatch, sessionB.id, captureB);
  });

  it('releases ownership on capture.stop: the preload is disabled and server telemetry is dropped', async () => {
    const configMark = primary.serverAgent.received.length;

    const stopped = await harness.stopCapture(sessionB.id);
    if (isErr(stopped)) {
      throw new Error(`session B: capture.stop was refused (${stopped.error.code})`);
    }
    expect(stopped.value.summary.captureId).toBe(captureB);
    expect(ownerOf(primary.root)).toBeUndefined();
    expect(openCaptures(primary.root)).toBe(0);

    // No capture, no captureId: the frame that makes the preload disable its instrumentations.
    const disabled = await waitForServerConfig(
      primary.serverAgent,
      configMark,
      (payload) => payload.captureId === undefined,
    );
    expect(disabled.sessionId).toBeUndefined();
    expect(disabled.signals).toEqual(DISABLED_SERVER_AGENT_SIGNALS);

    // With nobody owning the project, the preload's spans have no capture to join.
    const storedBefore = storedEventCount();
    const logMark = harness.logger.records.length;
    const serverBatch = freshBatch('server-agent');
    const counts = await ingestServerBatch(primary, serverBatch);
    expect(counts).toEqual({ accepted: 0, rejected: serverBatch.events.length });
    expectDropped(logMark, 'server-agent', 'no-active-capture');
    expect(storedEventCount()).toBe(storedBefore);
    expect(rowsOfTrace(serverBatch.traceId)).toEqual([]);

    // B's analysis runs on after the stop; let it settle before the project is reused.
    await harness.waitForSession(
      sessionB.id,
      (record) => record.status !== 'capturing' && record.status !== 'analyzing',
    );

    // The released project admits the next session's capture, and names it.
    sessionD = await openSession(primary, 'deterministic');
    uiClients.push(sessionD.devtools);
    const nextMark = primary.serverAgent.received.length;
    const captureD = expectStarted(await harness.http().startCapture(sessionD.id), 'session D');
    expect(ownerOf(primary.root)).toEqual({ sessionId: sessionD.id, captureId: captureD });
    const config = await waitForServerConfig(
      primary.serverAgent,
      nextMark,
      (payload) => payload.captureId === captureD,
    );
    expect(config.sessionId).toBe(sessionD.id);

    // An empty capture returns D to `ready`, free to race below.
    const stoppedD = await harness.stopCapture(sessionD.id);
    if (isErr(stoppedD)) {
      throw new Error(`session D: capture.stop was refused (${stoppedD.error.code})`);
    }
    expect(storedSession(sessionD.id).status).toBe('ready');
    expect(ownerOf(primary.root)).toBeUndefined();
  });

  it('lets exactly one of two concurrent capture.start requests win', async () => {
    const sessionE = await openSession(primary, 'runtime-only');
    uiClients.push(sessionE.devtools);
    const contenders = [sessionD, sessionE] as const;

    const results = await Promise.all(
      contenders.map((session) => harness.http().startCapture(session.id)),
    );
    const outcomes = contenders.map((session, index) => ({ session, result: results[index] }));
    const winners = outcomes.flatMap(({ session, result }) =>
      result !== undefined && !isErr(result)
        ? [{ session, captureId: result.value.captureId }]
        : [],
    );
    const losers = outcomes.flatMap(({ session, result }) =>
      result !== undefined && isErr(result) ? [{ session, error: result.error }] : [],
    );
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const [winner] = winners;
    const [loser] = losers;
    if (winner === undefined || loser === undefined) {
      throw new Error('The race produced no winner or no loser.');
    }

    // The loser's refusal is the typed conflict naming the winner.
    expect(loser.error.code).toBe(CAPTURE_CONFLICT_ERROR_CODE);
    expect(owningSessionIdOf(loser.error)).toBe(winner.session.id);
    expect(loser.error.details?.['status']).toBe(CONFLICT_STATUS);
    expect(openCaptures(primary.root)).toBe(1);
    expect(ownerOf(primary.root)).toEqual({
      sessionId: winner.session.id,
      captureId: winner.captureId,
    });
    expect(activeCaptureId(loser.session.id)).toBeUndefined();
    expect(storedSession(loser.session.id).status).toBe('ready');

    // Asking again for the capture it holds is a typed state error, never a second window.
    const repeated = expectRefused(
      await harness.http().startCapture(winner.session.id),
      'a repeated capture.start',
    );
    expect(repeated.code).toBe(INVALID_STATE_CODE);
    expect(owningSessionIdOf(repeated)).toBeUndefined();
    expect(repeated.details?.['status']).toBe(INVALID_STATE_STATUS);
    const repeatedRaw = await harness.rawFetch(
      { operation: 'capture.start', params: { id: winner.session.id } },
      { body: {} },
    );
    expect(repeatedRaw.status).toBe(INVALID_STATE_STATUS);
    expect(httpErrorResponseSchema.safeParse(repeatedRaw.json).success).toBe(true);
    expect(captureStartConflictResponseSchema.safeParse(repeatedRaw.json).success).toBe(false);
    expect(openCaptures(primary.root)).toBe(1);
    expect(activeCaptureId(winner.session.id)).toBe(winner.captureId);

    // Stopping a capture the loser never held is refused and releases nothing.
    const strayStop = expectRefused(
      await harness.stopCapture(loser.session.id),
      "the loser's capture.stop",
    );
    expect(strayStop.code).toBe(INVALID_STATE_CODE);
    expect(strayStop.details?.['status']).toBe(INVALID_STATE_STATUS);
    expect(ownerOf(primary.root)).toEqual({
      sessionId: winner.session.id,
      captureId: winner.captureId,
    });
    expect(activeCaptureId(winner.session.id)).toBe(winner.captureId);
    expect(openCaptures(primary.root)).toBe(1);

    // The winner releases the project, and the store agrees.
    const released = await harness.stopCapture(winner.session.id);
    if (isErr(released)) {
      throw new Error(`the winner's capture.stop was refused (${released.error.code})`);
    }
    expect(ownerOf(primary.root)).toBeUndefined();
    expect(openCaptures(primary.root)).toBe(0);
  });
});
