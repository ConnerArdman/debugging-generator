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
 * ## Two sessions, one patch target
 *
 * The deterministic provider plans the same actions for every question on the
 * sample project, and one of them is a `function-timing` patch of the project's
 * route handler. The second session to plan it while the first is open finds
 * the file holding the first session's instrumented bytes: the patch layer
 * refuses the target before anything is backed up or written
 * (`PATCH_UNSUPPORTED`, reason `held-by-another-session`), and the installer
 * sets it aside as a Function-timing gap naming the holder and installs the
 * rest of the plan (AAP §0.5.5). Every session here therefore plans through
 * the real deterministic pipeline: the second of each pair (`'deterministic-held'`
 * in {@link openSession}) reaches `ready` with no modification of its own, and
 * its `instrumentation.ready` names the holding session in one `unavailable`
 * entry per held patch target.
 *
 * {@link createPlanQueue} is kept for the one plan no question produces: a
 * plan of nothing but the held patch targets (session F). With nothing else
 * to enable, its install is the nothing-enabled failure, and the suite proves
 * the developer is told why — `instrumentation.failed` and the failed progress
 * row carry the service's own hint naming the holding session and the held
 * file — and that a new tab bound by origin goes to a live session, never to
 * the failed one.
 *
 * ## The narrative
 *
 * The tests run in declaration order over one harness and build on each
 * other's state, exactly as a developer's sessions would: session A (the
 * deterministic owner, which patches) and session B (deterministic, its patch
 * target held by A) share the harness's copy of the sample project; session C
 * lives on a second copy, and its patch — byte-for-byte A's — stands for the
 * rest of the suite, so the holder every held-target assertion names is proven
 * to be the session on the same copy (the service scopes the patch layer's
 * hold lookup to the install's project); session F
 * fails on the first copy while A still holds its patch; sessions D and E are
 * opened on the first copy once A has ended — D
 * patches, E's patch target is held by D — for the races, and are then
 * reused, both back in `ready`, for the store-failure checks.
 *
 * ## Injected store failures
 *
 * The last tests prove that ownership follows the **store**, not the attempt:
 * a capture window that cannot be closed keeps its session the project's owner,
 * whether a failure, an end or a rebuild of the owner index (`hydrate`, which
 * reads the open windows and closes orphans) tried to close it.
 * The failure is injected with a `TEMP` trigger on {@link Harness.store} — the
 * service's own connection — that aborts the one `UPDATE` closing a chosen
 * window. A temporary trigger lives on that connection only, never reaches the
 * database file, and is dropped in a `finally` by the test that created it.
 *
 * @module
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DISABLED_SERVER_AGENT_SIGNALS } from '@debuggen/instrumentation';
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

import { sessionOnAnotherProjectThan } from '../../src/instrumentation/service.js';
import { HTTP_ERROR_STATUS_BY_CODE } from '../../src/server/http.js';
import {
  SESSION_REQUEST_DIAGNOSTIC_MESSAGE,
  SESSION_REQUEST_REFUSED_LOG_MESSAGE,
} from '../../src/server/routes/sessions.js';
import { FAILURE_COPY_BY_CODE } from '../../src/sessions/progress.js';
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

/** The signal a held patch target is reported under: Function timing. */
const HELD_PATCH_SIGNAL = 'functions' as const;

/** The code of an install that could enable nothing at all (AAP §0.5.5). */
const NOTHING_ENABLED_CODE = 'INSTRUMENTATION_UNAVAILABLE' as const;

/**
 * The hint the service words for a target another session holds — the exact
 * sentence of `withHeldTargetHint` in `src/instrumentation/service.ts`,
 * restated here so a changed wording is a deliberate change of this suite.
 */
function heldTargetHint(file: string, owningSessionId: string): string {
  return `${file} is already instrumented by session ${owningSessionId}. End that session — its cleanup restores the file — then ask again.`;
}

/** Every telemetry row one trace left in the store, in ingest order. */
const ROWS_BY_TRACE_SQL =
  'SELECT id, session_id AS sessionId, capture_id AS captureId FROM telemetry_events WHERE trace_id = ? ORDER BY ingest_seq';

/** How many telemetry rows the store holds. */
const EVENT_COUNT_SQL = 'SELECT COUNT(*) AS total FROM telemetry_events';

/** How many capture windows are open on one project root. */
const OPEN_CAPTURES_SQL =
  'SELECT COUNT(*) AS total FROM captures JOIN sessions ON sessions.id = captures.session_id WHERE captures.stopped_at IS NULL AND sessions.project_root = ?';

/**
 * The only shape of id a trigger's `WHEN` clause may quote. DDL cannot bind a
 * parameter, so an id is checked against this before it is written into one;
 * every id the service mints (`cap_…`) matches.
 */
const TRIGGER_SAFE_ID = /^[A-Za-z0-9_-]+$/u;

/** What the injected store failure aborts the closing `UPDATE` with. */
const INJECTED_CLOSE_FAILURE = 'concurrency suite: injected capture-window close failure';

/** The code a store write the injected trigger aborted is reported with. */
const STORE_ERROR_CODE = 'STORE_ERROR' as const;

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
 * whether its plan is the deterministic one or one the suite authors — the
 * patch-only plan of the session that fails on a held target.
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

/**
 * What a new session's deterministic plan meets when it installs:
 *
 * - `'deterministic'` — a project no other open session has patched, so its
 *   patch targets are applied.
 * - `'deterministic-held'` — a project whose patch targets another open
 *   session holds, so each is set aside as a Function-timing gap naming that
 *   session and nothing of this session's is written.
 */
type PlanSource = 'deterministic' | 'deterministic-held';

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
 * For `'deterministic-held'`, the project editor's `instrumentation.ready` for
 * the session must report one Function-timing gap per patch target of its
 * plan, each naming `holderId` and the target's file, and the editor must have
 * received no `instrumentation.failed` for it.
 *
 * @param project The project to open the session on.
 * @param plan What its deterministic plan meets when it installs.
 * @param holderId The session holding the project's patch targets; required
 * for `'deterministic-held'` and refused otherwise.
 * @throws Error When the session is filed anything but `ready`, or `holderId`
 * does not fit `plan`.
 */
async function openSession(
  project: ProjectUnderTest,
  plan: PlanSource,
  holderId?: string,
): Promise<SessionUnderTest> {
  if ((plan === 'deterministic-held') !== (holderId !== undefined)) {
    throw new Error(`openSession(${plan}) was given the wrong holder: ${String(holderId)}.`);
  }
  const editor = await harness.editor(project.root);
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
  if (holderId === undefined) {
    expect(reached.modifications.some((record) => record.status === 'applied')).toBe(true);
  } else {
    await expectHeldTargetsReported(editor, reached, holderId);
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
 * Proves a session planned on a project another session holds went on without
 * the held targets instead of failing: nothing of its own was written, the
 * project editor's `instrumentation.ready` for it reports every patch target
 * of its plan as a Function-timing gap naming the holder and the target's
 * file, and the editor received no `instrumentation.failed` for it.
 */
async function expectHeldTargetsReported(
  editor: HarnessWsClient,
  record: SessionRecord,
  holderId: string,
): Promise<void> {
  expect(record.modifications).toEqual([]);
  const patchTargets = (record.plans.at(-1)?.instrumentationTargets ?? []).filter(
    (action) => action.mode === 'patch',
  );
  expect(patchTargets.length).toBeGreaterThan(0);

  const ready = await waitFor(
    editor,
    'instrumentation.ready',
    (message) => message.payload.sessionId === record.id,
  );
  expect(ready.payload.applied).toEqual([]);
  const held = ready.payload.unavailable.filter((gap) => gap.reason.includes(holderId));
  expect(held).toHaveLength(patchTargets.length);
  for (const target of patchTargets) {
    const reason = `${target.file} is already instrumented by session ${holderId}`;
    const gap = held.find((entry) => entry.reason === reason);
    expect(gap?.signal, reason).toBe(HELD_PATCH_SIGNAL);
    expect(gap?.hint, reason).toContain(holderId);
  }

  await editor.flush();
  expect(
    editor.received.filter(
      (message) =>
        isMessageOfType(message, 'instrumentation.failed') &&
        message.payload.sessionId === record.id,
    ),
  ).toEqual([]);
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

/**
 * The instrumented digests two sessions' applied records share for the same
 * project-relative file — non-empty exactly when a file of one session's copy
 * holds the bytes of a file of the other's, which is what makes a holder
 * ambiguous to a lookup that matches by path and digest alone.
 */
function identicalPatchDigests(firstId: string, secondId: string): string[] {
  const appliedOf = (sessionId: string): Map<string, string> =>
    new Map(
      storedSession(sessionId)
        .modifications.filter((record) => record.status === 'applied')
        .map((record) => [
          `${record.file}\u0000${record.instrumentedHash}`,
          record.instrumentedHash,
        ]),
    );
  const first = appliedOf(firstId);
  return [...appliedOf(secondId).keys()].flatMap((key) => {
    const digest = first.get(key);
    return digest === undefined ? [] : [digest];
  });
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

/**
 * Makes the store refuse to close one capture window: a `TEMP` trigger on the
 * service's own connection aborts every `UPDATE` of that row's `stopped_at`.
 *
 * @returns The function that drops the trigger again; call it in a `finally`.
 */
function blockCaptureClose(captureId: string): () => void {
  if (!TRIGGER_SAFE_ID.test(captureId)) {
    throw new Error('The capture id cannot be quoted into a trigger.');
  }
  const trigger = `concurrency_block_close_${captureId.replaceAll('-', '_')}`;
  harness.store.db.exec(
    `CREATE TEMP TRIGGER ${trigger} BEFORE UPDATE OF stopped_at ON captures WHEN OLD.id = '${captureId}' BEGIN SELECT RAISE(ABORT, '${INJECTED_CLOSE_FAILURE}'); END;`,
  );
  return () => {
    harness.store.db.exec(`DROP TRIGGER IF EXISTS temp.${trigger};`);
  };
}

/**
 * Opens a capture window straight in the store for a session that keeps its
 * status — the orphan a start interrupted between the window and the status
 * leaves behind, which the manager itself can no longer produce.
 *
 * @returns The orphan window's capture id.
 */
function openOrphanWindow(sessionId: string): string {
  const plan = harness.repos.sessions.latestPlanVersion(sessionId);
  if (isErr(plan) || plan.value === undefined) {
    throw new Error(`Session ${sessionId} has no plan to open an orphan window under.`);
  }
  const opened = harness.repos.sessions.startCapture({ sessionId, planVersion: plan.value });
  if (isErr(opened)) {
    throw new Error(`The orphan window could not be opened (${opened.error.code}).`);
  }
  return opened.value.capture.id;
}

/** How many `failed` progress rows the store holds for a session. */
function failedRowCount(sessionId: string): number {
  const rows = harness.repos.sessions.listProgress(sessionId);
  if (isErr(rows)) {
    throw new Error(`The progress of ${sessionId} could not be read (${rows.error.code}).`);
  }
  return rows.value.filter((row) => row.status === 'failed').length;
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
  /**
   * The deterministic session on the second copy. Its patch is byte-for-byte
   * A's — one fixture, one deterministic transform — and it stands for the
   * rest of the suite, so every held-target assertion on the primary copy also
   * proves the holder named is the session on that copy, never C.
   */
  let sessionC: SessionUnderTest;
  /** The deterministic session that patches the primary copy and captures first. */
  let sessionA: SessionUnderTest;
  /** The deterministic session that asks second, its patch target held by A. */
  let sessionB: SessionUnderTest;
  /** Opened on the primary copy once A has ended and restored its patch. */
  let sessionD: SessionUnderTest;
  /** D's rival in the race, its patch target held by D; reused with D by the store-failure checks. */
  let sessionE: SessionUnderTest;
  let captureA: string;
  let captureB: string;
  /** Every editor and DevTools connection, for "this frame reached nobody else" checks. */
  const uiClients: HarnessWsClient[] = [];

  beforeAll(async () => {
    planQueue = createPlanQueue();
    harness = await startHarness({ provider: planQueue.provider });

    primary = await prepareProject(harness.requireProject().root);
    const secondCopy = await harness.copyFixtureProject();
    secondary = await prepareProject(secondCopy.root);
    uiClients.push(await harness.editor(primary.root), await harness.editor(secondary.root));

    sessionA = await openSession(primary, 'deterministic');
    sessionB = await openSession(primary, 'deterministic-held', sessionA.id);
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
    sessionC = await openSession(secondary, 'deterministic');
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

    // C's patch of its copy is byte-for-byte A's patch of the primary copy —
    // one fixture, one deterministic transform — so each copy's file now
    // holds the same instrumented digest under the same relative path. C is
    // left standing: the patch layer's hold check matches by path and digest,
    // and only the service's project scoping keeps it from naming C as the
    // holder of the primary copy's file, which the tests below assert.
    await harness.waitForSession(
      sessionC.id,
      (record) => record.status !== 'capturing' && record.status !== 'analyzing',
    );
    expect(identicalPatchDigests(sessionA.id, sessionC.id).length).toBeGreaterThan(0);
    expect(ownerOf(primary.root)).toEqual({ sessionId: sessionA.id, captureId: captureA });
  });

  it("scopes the patch layer's hold lookup to the install's project while two copies hold identical patches", async () => {
    // The journal lists open records by session id, so which of A's and C's
    // identical records a path-and-digest match meets last is an accident of
    // two random ids. The service hands the installer a predicate that leaves
    // out the records of sessions it installed on another project, which is
    // what makes the holder named deterministic; an unknown session is kept.
    expect(identicalPatchDigests(sessionA.id, sessionC.id).length).toBeGreaterThan(0);
    const listed = await harness.repos.modifications.listOpen();
    if (isErr(listed)) {
      throw new Error(`The open records could not be listed (${listed.error.code}).`);
    }
    const knownProjects = new Map([
      [sessionA.id, primary.root],
      [sessionC.id, secondary.root],
    ]);
    const holdersSeenFrom = (
      projectRoot: string,
      projectOf: (sessionId: string) => string | undefined,
    ): Set<string> => {
      const elsewhere = sessionOnAnotherProjectThan(projectRoot, projectOf);
      return new Set(
        listed.value
          .filter((record) => !elsewhere(record.sessionId))
          .map((record) => record.sessionId),
      );
    };

    expect(new Set(listed.value.map((record) => record.sessionId))).toEqual(
      new Set([sessionA.id, sessionC.id]),
    );
    expect(holdersSeenFrom(primary.root, (id) => knownProjects.get(id))).toEqual(
      new Set([sessionA.id]),
    );
    expect(holdersSeenFrom(secondary.root, (id) => knownProjects.get(id))).toEqual(
      new Set([sessionC.id]),
    );
    expect(holdersSeenFrom(primary.root, () => undefined)).toEqual(
      new Set([sessionA.id, sessionC.id]),
    );
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

  it('fails a plan of nothing but held patch targets with a hint naming the holder, and binds a new tab to a live session instead', async () => {
    const editor = await harness.editor(primary.root);
    const holder = storedSession(sessionA.id);
    const heldTargets = (holder.plans.at(-1)?.instrumentationTargets ?? []).filter(
      (action) => action.mode === 'patch',
    );
    if (heldTargets.length === 0) {
      throw new Error(`Session ${sessionA.id} holds no patch target to plan against.`);
    }
    const appliedBefore = holder.modifications
      .filter((record) => record.status === 'applied')
      .map((record) => record.id);
    expect(appliedBefore.length).toBeGreaterThan(0);

    // A's own patch targets, and nothing else: every one is held, so nothing
    // at all can be enabled. The authoring schema admits the plan like any
    // model output.
    const patchOnly: InstrumentationPlanInput = {
      objective: 'Time the functions another session has already instrumented',
      capture: ['function timing'],
      instrumentationTargets: heldTargets.map(({ file, symbol, type }) => ({ file, symbol, type })),
    };
    expect(isErr(parseInstrumentationPlanInput(patchOnly))).toBe(false);
    planQueue.enqueue(patchOnly);

    const created = await harness.createSession({ projectRoot: primary.root, question: QUESTION });
    const reached = await harness.waitForSession(
      created.id,
      (record) => record.status === 'failed' || record.status === 'ready',
    );
    expect(reached.status).toBe('failed');
    expect(planQueue.pending()).toBe(0);
    expect(reached.modifications).toEqual([]);

    // Both surfaces say why, in the service's own words: the held file and
    // the session to end. The message stays the code's fixed copy. C's patch
    // of the second copy — the same bytes under the same relative path — still
    // stands, so naming A rather than C is the service's project scoping at
    // work, not an accident of which record the journal lists last.
    expect(identicalPatchDigests(sessionA.id, sessionC.id).length).toBeGreaterThan(0);
    // The hint names one of the held files — the installer lists what it set
    // aside in its own install order (adapter, then action id), not the plan's,
    // and the ids are minted afresh for this plan — and always the holder, A.
    const heldHints = heldTargets.map((target) => heldTargetHint(target.file, sessionA.id));
    const failedFrame = await waitFor(
      editor,
      'instrumentation.failed',
      (message) => message.payload.sessionId === created.id,
    );
    expect(failedFrame.payload.error.code).toBe(NOTHING_ENABLED_CODE);
    const reportedHint = failedFrame.payload.error.hint;
    expect(heldHints).toContain(reportedHint);
    const expectedHint = String(reportedHint);
    expect(expectedHint).not.toContain(sessionC.id);
    for (const target of heldTargets) {
      expect(failedFrame.payload.error.message).not.toContain(target.file);
    }
    const progress = harness.repos.sessions.listProgress(created.id);
    if (isErr(progress)) {
      throw new Error(`The progress of ${created.id} could not be read (${progress.error.code}).`);
    }
    const failedRows = progress.value.filter((row) => row.status === 'failed');
    expect(failedRows).toHaveLength(1);
    const failedDetail = String(failedRows[0]?.detail);
    expect(
      failedDetail.startsWith(`${expectedHint} (error code: ${NOTHING_ENABLED_CODE}, ref: msg_`),
      failedDetail,
    ).toBe(true);
    await editor.flush();
    expect(
      editor.received.filter(
        (message) =>
          isMessageOfType(message, 'instrumentation.ready') &&
          message.payload.sessionId === created.id,
      ),
    ).toEqual([]);

    // The holder is untouched: A still captures, its records still applied.
    const holderAfter = storedSession(sessionA.id);
    expect(holderAfter.status).toBe('capturing');
    expect(
      holderAfter.modifications
        .filter((record) => record.status === 'applied')
        .map((record) => record.id),
    ).toEqual(appliedBefore);
    expect(ownerOf(primary.root)).toEqual({ sessionId: sessionA.id, captureId: captureA });

    // A new tab on the origin, bound without a session id, goes to a live
    // session — never to the failed one, however recently it was updated.
    const tabId = nextTabId;
    nextTabId += 1;
    const { client } = await harness.connectDevtools({ tabId });
    uiClients.push(client);
    const byOrigin = await harness.bindTab(client, {
      tabId,
      url: primary.devServerUrl,
      origin: primary.origin,
    });
    if (isErr(byOrigin)) {
      throw new Error(`session.bind by origin was refused (${byOrigin.error.code}).`);
    }
    const boundId = byOrigin.value.payload.sessionId;
    expect(boundId).not.toBe(created.id);
    expect(storedSession(boundId).status).not.toBe('failed');
    const displaced = [sessionA, sessionB].find((session) => session.id === boundId);
    if (displaced === undefined) {
      throw new Error(`The new tab bound to ${boundId}, not to a session on the primary project.`);
    }

    // One tab per session: give the displaced session its own tab back, by
    // name, so the tests after this one see the bindings they were given.
    // The flush lets the announcement that its tab was replaced arrive first,
    // so it cannot be mistaken for the answer to the re-bind.
    await displaced.devtools.flush();
    const restored = await harness.bindTab(displaced.devtools, {
      tabId: displaced.tabId,
      url: primary.devServerUrl,
      origin: primary.origin,
      sessionId: displaced.id,
    });
    if (isErr(restored)) {
      throw new Error(`Re-binding ${displaced.id} was refused (${restored.error.code}).`);
    }
    // An establishment — reason `bound`, or absent — never the replacement notice.
    expect(restored.value.payload.sessionId).toBe(displaced.id);
    expect([undefined, 'bound']).toContain(restored.value.payload.reason);
    expect(storedSession(displaced.id).boundTab?.tabId).toBe(displaced.tabId);
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
    sessionE = await openSession(primary, 'deterministic-held', sessionD.id);
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
    // The refusal was composed outside the route layer and registered by no
    // product builder, so it is answered with its code's fixed copy and a
    // diagnostic reference that the refusal record and its debug twin repeat.
    const repeatedBody = httpErrorResponseSchema.safeParse(repeatedRaw.json);
    if (!repeatedBody.success) {
      throw new Error(`The repeated capture.start answered no error body: ${repeatedRaw.text}`);
    }
    expect(repeatedBody.data.message).toBe(FAILURE_COPY_BY_CODE.SESSION_INVALID_STATE.summary);
    const repeatedRef = repeatedBody.data.ref;
    expect(repeatedRef).toMatch(/^msg_/u);
    expect(
      harness.logger
        .withMessage(SESSION_REQUEST_REFUSED_LOG_MESSAGE)
        .filter((record) => record.fields['ref'] === repeatedRef)
        .map((record) => [record.level, record.fields['errorCode']]),
    ).toEqual([['warn', INVALID_STATE_CODE]]);
    expect(
      harness.logger
        .withMessage(SESSION_REQUEST_DIAGNOSTIC_MESSAGE)
        .filter((record) => record.fields['ref'] === repeatedRef)
        .map((record) => record.level),
    ).toEqual(['debug']);
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

  /**
   * Proves `holder` still captures the primary project on `captureId` — in the
   * store and in the owner index — and that `competitor` is answered the typed
   * `409` naming it, with nothing opened for the competitor.
   */
  async function expectProjectHeld(
    holder: SessionUnderTest,
    competitor: SessionUnderTest,
    captureId: string,
  ): Promise<void> {
    expect(storedSession(holder.id).status).toBe('capturing');
    expect(activeCaptureId(holder.id)).toBe(captureId);
    expect(ownerOf(primary.root)).toEqual({ sessionId: holder.id, captureId });
    expect(openCaptures(primary.root)).toBe(1);

    const refused = expectRefused(
      await harness.http().startCapture(competitor.id),
      "the competitor's capture.start",
    );
    expect(refused.code).toBe(CAPTURE_CONFLICT_ERROR_CODE);
    expect(owningSessionIdOf(refused)).toBe(holder.id);
    expect(refused.details?.['status']).toBe(CONFLICT_STATUS);
    expect(activeCaptureId(competitor.id)).toBeUndefined();
    expect(storedSession(competitor.id).status).toBe('ready');
    expect(openCaptures(primary.root)).toBe(1);
  }

  it('keeps ownership while a failing or ending session cannot close its capture window', async () => {
    const [holder, competitor] = [sessionD, sessionE];
    expect(storedSession(holder.id).status).toBe('ready');
    expect(storedSession(competitor.id).status).toBe('ready');
    const held = expectStarted(await harness.http().startCapture(holder.id), 'the holder');
    expect(ownerOf(primary.root)).toEqual({ sessionId: holder.id, captureId: held });
    const failedRowsBefore = failedRowCount(holder.id);

    const unblock = blockCaptureClose(held);
    try {
      // A stage failure cannot file the holder `failed` while its window stays
      // open: the whole move is refused, and no failed row is reported.
      const failed = expectRefused(
        await harness.manager.fail(holder.id, {
          stage: 'capture',
          code: STORE_ERROR_CODE,
          message: 'The capture could not be completed.',
        }),
        'the failure transition',
      );
      expect(failed.code).toBe(STORE_ERROR_CODE);
      expect(failedRowCount(holder.id)).toBe(failedRowsBefore);
      await expectProjectHeld(holder, competitor, held);

      // Ending it is refused before cleanup runs, with ownership retained.
      const ended = expectRefused(await harness.endSession(holder.id), 'session.end');
      expect(ended.code).toBe(STORE_ERROR_CODE);
      await expectProjectHeld(holder, competitor, held);
    } finally {
      unblock();
    }

    // Once the window can close, stopping releases the project and the store agrees.
    const stopped = await harness.stopCapture(holder.id);
    if (isErr(stopped)) {
      throw new Error(`the holder's capture.stop was refused (${stopped.error.code})`);
    }
    expect(stopped.value.summary.captureId).toBe(held);
    expect(activeCaptureId(holder.id)).toBeUndefined();
    expect(storedSession(holder.id).status).toBe('ready');
    expect(ownerOf(primary.root)).toBeUndefined();
    expect(openCaptures(primary.root)).toBe(0);

    // The competitor is admitted now, and named.
    const next = expectStarted(await harness.http().startCapture(competitor.id), 'the competitor');
    expect(ownerOf(primary.root)).toEqual({ sessionId: competitor.id, captureId: next });
    const releasedNext = await harness.stopCapture(competitor.id);
    if (isErr(releasedNext)) {
      throw new Error(`the competitor's capture.stop was refused (${releasedNext.error.code})`);
    }
    expect(ownerOf(primary.root)).toBeUndefined();
    expect(openCaptures(primary.root)).toBe(0);
  });

  it('rebuilds the owner index from the open windows: an open capture keeps its owner, an orphan is closed, an unseen or unclosable orphan owns the project', async () => {
    const [capturer, orphaned] = [sessionE, sessionD];
    expect(storedSession(capturer.id).status).toBe('ready');
    expect(storedSession(orphaned.id).status).toBe('ready');

    // A rebuild while a capture is open names the same owner, and still refuses the rival.
    const held = expectStarted(await harness.http().startCapture(capturer.id), 'the capturer');
    const logMark = harness.logger.records.length;
    const rebuilt = await harness.manager.hydrate();
    expect(isErr(rebuilt) ? rebuilt.error.code : 'ok').toBe('ok');
    await expectProjectHeld(capturer, orphaned, held);
    // The rebuild read the one open window, not the sessions the store holds.
    const rebuildRecords = harness.logger.records
      .slice(logMark)
      .filter((record) => record.message === 'capture-owner index rebuilt');
    expect(rebuildRecords.map((record) => record.fields)).toEqual([
      expect.objectContaining({ windows: 1, owners: 1, orphansClosed: 0, orphansOpen: 0 }),
    ]);
    const stopped = await harness.stopCapture(capturer.id);
    if (isErr(stopped)) {
      throw new Error(`the capturer's capture.stop was refused (${stopped.error.code})`);
    }
    expect(ownerOf(primary.root)).toBeUndefined();
    expect(openCaptures(primary.root)).toBe(0);

    // An orphan window on a `ready` session is closed by the rebuild, not indexed.
    const capturesBefore = storedSession(orphaned.id).captures;
    const orphan = openOrphanWindow(orphaned.id);
    expect(openCaptures(primary.root)).toBe(1);
    const cleared = await harness.manager.hydrate();
    expect(isErr(cleared) ? cleared.error.code : 'ok').toBe('ok');
    expect(activeCaptureId(orphaned.id)).toBeUndefined();
    const closedOrphan = harness.repos.sessions.getCapture(orphan);
    expect(isErr(closedOrphan) ? undefined : closedOrphan.value?.capture.stoppedAt).toEqual(
      expect.any(Number),
    );
    expect(openCaptures(primary.root)).toBe(0);
    expect(ownerOf(primary.root)).toBeUndefined();
    expect(storedSession(orphaned.id).status).toBe('ready');
    expect(storedSession(orphaned.id).captures).toEqual(capturesBefore);

    // A window the owner index has never seen still refuses a rival — the
    // store's own project check, inside the start's transaction — and the
    // index adopts its session as the owner.
    const unseen = openOrphanWindow(orphaned.id);
    expect(ownerOf(primary.root)).toBeUndefined();
    const adopted = expectRefused(
      await harness.http().startCapture(capturer.id),
      "the capturer's capture.start",
    );
    expect(adopted.code).toBe(CAPTURE_CONFLICT_ERROR_CODE);
    expect(owningSessionIdOf(adopted)).toBe(orphaned.id);
    expect(adopted.details?.['status']).toBe(CONFLICT_STATUS);
    expect(activeCaptureId(capturer.id)).toBeUndefined();
    expect(storedSession(capturer.id).status).toBe('ready');
    expect(openCaptures(primary.root)).toBe(1);
    expect(ownerOf(primary.root)).toEqual({ sessionId: orphaned.id, captureId: unseen });
    const adoptedCleared = await harness.manager.hydrate();
    expect(isErr(adoptedCleared) ? adoptedCleared.error.code : 'ok').toBe('ok');
    expect(activeCaptureId(orphaned.id)).toBeUndefined();
    expect(ownerOf(primary.root)).toBeUndefined();

    // An orphan the store refuses to close is reported, and its session owns
    // the project until the window is verifiably closed.
    const stuck = openOrphanWindow(orphaned.id);
    const unblock = blockCaptureClose(stuck);
    try {
      const refused = await harness.manager.hydrate();
      if (!isErr(refused)) {
        throw new Error('hydrate was expected to report the unclosable orphan, but it succeeded.');
      }
      expect(refused.error.code).toBe(STORE_ERROR_CODE);
      expect(activeCaptureId(orphaned.id)).toBe(stuck);
      expect(storedSession(orphaned.id).status).toBe('ready');
      expect(ownerOf(primary.root)).toEqual({ sessionId: orphaned.id, captureId: stuck });

      const conflict = expectRefused(
        await harness.http().startCapture(capturer.id),
        "the capturer's capture.start",
      );
      expect(conflict.code).toBe(CAPTURE_CONFLICT_ERROR_CODE);
      expect(owningSessionIdOf(conflict)).toBe(orphaned.id);
      expect(conflict.details?.['status']).toBe(CONFLICT_STATUS);
      expect(activeCaptureId(capturer.id)).toBeUndefined();
      expect(storedSession(capturer.id).status).toBe('ready');
      expect(openCaptures(primary.root)).toBe(1);
    } finally {
      unblock();
    }

    // Closable again: the next rebuild closes it and frees the project.
    const recovered = await harness.manager.hydrate();
    expect(isErr(recovered) ? recovered.error.code : 'ok').toBe('ok');
    expect(activeCaptureId(orphaned.id)).toBeUndefined();
    expect(ownerOf(primary.root)).toBeUndefined();
    expect(openCaptures(primary.root)).toBe(0);
  });
});
