/**
 * The `followup` suite of `local-service-integration` (AAP §0.8.3): both paths
 * of AAP §0.4.2's Follow-up row driven end to end through the in-process
 * service — HTTP routes, the orchestrator, the follow-up stage, the real
 * installer, the real store and the real cleanup — with nothing faked below
 * the model boundary.
 *
 * ## What this suite proves that the colocated unit suite cannot
 *
 * `src/pipeline/stages/followup.test.ts` pins `diffAdditionalActions`, the
 * decision guard and both paths against fakes. This file proves the same rules
 * hold where they matter:
 *
 * - **Real version ladders.** `analyses`, `panels` (with `supersedes`) and
 *   `plans` (by `planVersion`) are read back from the service's own SQLite
 *   store; every new rung is appended and every earlier rung is asserted
 *   byte-for-byte unchanged.
 * - **A real chain.** Plan version *n* and *n + 1* both patch
 *   `src/server/services/trail-report.service.ts` through `installPlan`, so the
 *   second record's `originalHash` equals the first record's `instrumentedHash`
 *   because the patcher genuinely wrote those bytes — never because a fixture
 *   was hand-edited to look instrumented.
 * - **Reverse-order restoration, proven by SHA-256.** `POST /sessions/:id/end`
 *   runs the real `cleanupSession`/`restoreChain`; the newest record is reverted
 *   before the one it is layered on, and the copied project is byte-identical
 *   to its pre-session snapshot afterwards.
 * - **Additive-only is enforced, not observed.** A decision proposing a
 *   removal, a replacement and a re-scope of the installed action is refused
 *   proposal by proposal, each with its own reason, and the next plan version
 *   is the previous plan plus exactly the accepted addition.
 * - **A delta that fails part-way is undone at once.** The failure is injected
 *   at the filesystem, not through a code seam: a file planted in the session's
 *   content-addressed backup directory under the digest the second delta
 *   target will need makes the backup store refuse that write, so the patcher
 *   stops after the first delta target was already applied.
 * - **An edit between two installs becomes a conflict, never an overwrite.**
 *   A second session on a second copy edits the chained file after the first
 *   install; the second install refuses to layer over it, and cleanup leaves
 *   the developer's bytes exactly as they were.
 *
 * ## Rules ruling
 *
 * - **User rules (AAP §0.10).** `review_rules` answers "No user rules
 *   provided."; no user rule governs this file, so the §0.10 baseline does.
 * - **Gate membership.** Collected by `pnpm test:integration`
 *   (`vitest run --project local-service-integration`) inside `pnpm verify`,
 *   compiled by `tsc -b`, linted with `--max-warnings 0` and formatted by
 *   `prettier --check .`.
 * - **Reversible, recorded file changes.** Every patch comes from the real
 *   installer and goes back through the real cleanup; the committed corpus is
 *   only ever copied (`harness.copyFixtureProject`) and each copy is compared
 *   against its snapshot with `assertTreeUnchanged`/`diffTreeSnapshots`.
 * - **No committed secrets.** Every credential is minted by the harness through
 *   the service's own auth service; no secret-shaped literal appears here.
 * - **Closed dependency set.** `@debuggen/*` (never `panel-renderer`),
 *   `node:*`, `vitest` and the harness. No `zod`, no DOM types.
 *
 * ## The model boundary
 *
 * Every stage runs on the real deterministic provider except the follow-up
 * decision, which is scripted: the suite must force each path and hand the
 * decision real action ids from the live plan (a removal names the installed
 * action's id), so {@link enqueueDecision} feeds one `FollowUpDecision` per
 * follow-up through the harness's scripted provider. The decisions are exactly
 * the `{ needsNewCapture, additionalActions }` contract the stage validates;
 * everything after the decision — the additive-only verdict, normalisation,
 * feasibility, the install, the store writes — is the product's own.
 *
 * @module
 */

import { constants as fsConstants } from 'node:fs';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  INSTRUMENTATION_ACTION_TYPES,
  INSTRUMENTATION_MODES,
  MODIFICATION_STATUSES,
  actionIdentityKey,
} from '@debuggen/instrumentation';
import type {
  InstrumentationAction,
  InstrumentationActionType,
  InstrumentationPlan,
  InstrumentationTargetInput,
  ModificationRecord,
} from '@debuggen/instrumentation';
import { validatePanelSpec } from '@debuggen/panel-schema';
import type { PanelSpec } from '@debuggen/panel-schema';
import {
  CLEANUP_STATUSES,
  PROGRESS_STAGES,
  PROGRESS_STATUSES,
  SESSION_STATUSES,
  isMessageOfType,
} from '@debuggen/protocol';
import type { AnalysisResult, SessionRecord, SessionStatus } from '@debuggen/protocol';
import { isErr, newActionId } from '@debuggen/shared';
import type { DebuggenError, Result } from '@debuggen/shared';
import { SECURE_FILE_MODE, sha256Hex, sha256OfFile } from '@debuggen/shared/node';
import { TELEMETRY_TIERS } from '@debuggen/telemetry';

import {
  FOLLOW_UP_DELTA_REJECTION_REASONS,
  FOLLOW_UP_PATHS,
  FOLLOW_UP_STAGE,
} from '../../src/pipeline/stages/followup.js';
import type {
  FollowUpAdditionalAction,
  FollowUpDecision,
} from '../../src/pipeline/stages/followup.js';
import { transition } from '../../src/sessions/state-machine.js';
import {
  HARNESS_TIMEOUTS,
  assertTreeUnchanged,
  createScriptedProvider,
  diffTreeSnapshots,
  readTelemetryBatch,
  snapshotTree,
  startHarness,
  waitFor,
  waitUntil,
} from './harness.js';
import type {
  FixtureProjectCopy,
  Harness,
  HarnessMessage,
  HarnessWsClient,
  ScriptedProvider,
  ScriptedStep,
} from './harness.js';

/* -------------------------------------------------------------------------------------------------
 * Vocabularies — every status, stage, type and mode is taken from its owning package
 * ---------------------------------------------------------------------------------------------- */

/**
 * One member of a published vocabulary, checked twice: by the compiler (the
 * literal must be assignable to the tuple's member type, so a rename upstream
 * fails `tsc -b` here) and at run time (so a value removed from a frozen tuple
 * fails with the vocabulary named rather than as a confusing mismatch later).
 */
function memberOf<const T extends string>(vocabulary: readonly T[], value: NoInfer<T>): T {
  if (!vocabulary.includes(value)) {
    throw new Error(`"${value}" is not a member of [${vocabulary.join(', ')}].`);
  }
  return value;
}

/** The session statuses this suite walks through (`SESSION_STATUSES`). */
const STATUS = Object.freeze({
  ready: memberOf(SESSION_STATUSES, 'ready'),
  planning: memberOf(SESSION_STATUSES, 'planning'),
  instrumenting: memberOf(SESSION_STATUSES, 'instrumenting'),
  analyzing: memberOf(SESSION_STATUSES, 'analyzing'),
  generated: memberOf(SESSION_STATUSES, 'generated'),
  failed: memberOf(SESSION_STATUSES, 'failed'),
  ended: memberOf(SESSION_STATUSES, 'ended'),
});

/** The modification statuses this suite asserts (`MODIFICATION_STATUSES`). */
const MODIFICATION = Object.freeze({
  applied: memberOf(MODIFICATION_STATUSES, 'applied'),
  reverted: memberOf(MODIFICATION_STATUSES, 'reverted'),
  conflict: memberOf(MODIFICATION_STATUSES, 'conflict'),
});

/** The cleanup verdicts this suite expects (`CLEANUP_STATUSES`). */
const CLEANUP = Object.freeze({
  clean: memberOf(CLEANUP_STATUSES, 'clean'),
  conflict: memberOf(CLEANUP_STATUSES, 'conflict'),
});

/** The action types the scripted decisions propose (`INSTRUMENTATION_ACTION_TYPES`). */
const ACTION_TYPE = Object.freeze({
  functionTiming: memberOf(INSTRUMENTATION_ACTION_TYPES, 'function-timing'),
  serverSpan: memberOf(INSTRUMENTATION_ACTION_TYPES, 'server-span'),
});

/** The install mode that edits a developer's file (`INSTRUMENTATION_MODES`). */
const PATCH_MODE = memberOf(INSTRUMENTATION_MODES, 'patch');

/** The progress stage and status of the install's closing "ready" row. */
const INSTRUMENT_STAGE = memberOf(PROGRESS_STAGES, 'instrument');
const PROGRESS_DONE = memberOf(PROGRESS_STATUSES, 'done');
const PROGRESS_FAILED = memberOf(PROGRESS_STATUSES, 'failed');

/** The tier the browser agent reports in; every other tier is the preload's. */
const BROWSER_TIER = memberOf(TELEMETRY_TIERS, 'browser');

/**
 * The message of the follow-up stage's decision record. Which proposal was
 * refused for which reason is logged there and nowhere else — the decision
 * artifact is pipeline-internal and deliberately not part of the session
 * record — so it is the witness the additive-only assertions read, through the
 * harness's capture of the service's own logger.
 */
const FOLLOW_UP_DECIDED_LOG = 'Follow-up decided.';

/* -------------------------------------------------------------------------------------------------
 * The corpus — `test/fixtures/sample-project`, copied, never written in place
 * ---------------------------------------------------------------------------------------------- */

/**
 * The files and symbols of the `fixture-trailhead-guide` corpus the scripted
 * decisions name. The deterministic plan patches only the route handler, so the
 * follow-ups reach into the service layer: `summarizeConditions` exists in the
 * corpus precisely to give a follow-up plan its own patchable symbol beside
 * `loadTrailReport` (see the header of `app/api/trail-report/route.ts`).
 */
const CORPUS = Object.freeze({
  serviceFile: 'src/server/services/trail-report.service.ts',
  loadSymbol: 'loadTrailReport',
  summarizeSymbol: 'summarizeConditions',
  poolFile: 'src/server/db/pool.ts',
  poolQuerySymbol: 'queryTrailConditionReports',
  poolGateSymbol: 'queryTrailheadGateStatus',
});

/** The committed cross-tier batch every capture of this suite replays. */
const CROSS_TIER_BATCH = 'telemetry-trace-cross-tier.json';

/** One ingress event of a batch, typed through the harness reader. */
type IngressEvent = ReturnType<typeof readTelemetryBatch>[number];

/**
 * The batch re-identified for a later capture.
 *
 * The store refuses an event id it already holds under another session, and a
 * second capture of the same session must not collide with the first, so a
 * capture after the first gets its own id block, following the fixture README's
 * id registry: the event-id tag becomes `f<block>`, the trace id's first hex
 * digit and the span ids' twelfth position become `<block>`, and the producer
 * ordinals move past the registry's last taken value. Only identities change —
 * kinds, timings, attributes and the parent/child shape (the deliberate orphan
 * included) are carried over verbatim.
 *
 * @param events The parsed committed batch.
 * @param block A digit 1–3, unique per capture within this file.
 */
function reidentifyBatch(events: readonly IngressEvent[], block: number): IngressEvent[] {
  if (!Number.isInteger(block) || block < 1 || block > 3) {
    throw new RangeError('A re-identified batch needs a block from 1 to 3.');
  }
  const digit = String(block);
  const span = (id: string): string => `${id.slice(0, 12)}${digit}${id.slice(13)}`;
  return events.map((event) => ({
    ...event,
    id: event.id.replace(/^evt_[a-z]{2}/u, `evt_f${digit}`),
    traceId: `${digit}${event.traceId.slice(1)}`,
    spanId: span(event.spanId),
    ...(event.parentSpanId === undefined ? {} : { parentSpanId: span(event.parentSpanId) }),
    producerId: `${event.producerId.slice(0, -1)}${String(6 + block)}`,
  }));
}

/** The committed batch split by the producer that sends each half. */
function splitByProducer(events: readonly IngressEvent[]): {
  readonly browser: IngressEvent[];
  readonly server: IngressEvent[];
} {
  return {
    browser: events.filter((event) => event.tier === BROWSER_TIER),
    server: events.filter((event) => event.tier !== BROWSER_TIER),
  };
}

/* -------------------------------------------------------------------------------------------------
 * Small utilities
 * ---------------------------------------------------------------------------------------------- */

/** The value of an `Ok`, or a thrown error naming the call and the refusal's code. */
function unwrap<T>(result: Result<T, DebuggenError>, what: string): T {
  if (isErr(result)) {
    throw new Error(`${what} was refused (${result.error.code}): ${result.error.message}`, {
      cause: result.error,
    });
  }
  return result.value;
}

/** The only element of a list, failing with `what` when there is not exactly one. */
function only<T>(items: readonly T[], what: string): T {
  const [first, ...rest] = items;
  if (first === undefined || rest.length > 0) {
    throw new Error(`Expected exactly one ${what}, found ${String(items.length)}.`);
  }
  return first;
}

/** The last element of a list, failing with `what` when it is empty. */
function last<T>(items: readonly T[], what: string): T {
  const found = items.at(-1);
  if (found === undefined) {
    throw new Error(`Expected at least one ${what}.`);
  }
  return found;
}

/** Whether a path exists on disk. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** An absolute path inside a project copy. */
function inProject(project: FixtureProjectCopy, file: string): string {
  return join(project.root, file);
}

/* -------------------------------------------------------------------------------------------------
 * The scripted follow-up decisions
 * ---------------------------------------------------------------------------------------------- */

/**
 * How many follow-ups this file asks: four in the first session (existing
 * evidence, the refused-and-accepted delta, the delta that fails part-way and
 * the chain) and two in the conflict session. Exactly this many script steps
 * exist, and the last test asserts every one was served — a repair turn or an
 * unexpected extra decision would shift the queue and fail loudly.
 */
const FOLLOW_UP_COUNT = 6;

/** The decisions the next follow-ups receive, oldest first. */
const pendingDecisions: FollowUpDecision[] = [];

/** Queues the decision the next follow-up's model call answers with. */
function enqueueDecision(decision: FollowUpDecision): void {
  pendingDecisions.push(decision);
}

/**
 * One script step per follow-up, answering only the `followup` stage. The
 * answer is read when the call arrives — a decision can only name the live
 * plan's action ids once that plan exists — and is handed to the stage's own
 * structured-output gate exactly as a provider's transport would hand it over.
 */
const DECISION_SCRIPT: readonly ScriptedStep[] = Array.from(
  { length: FOLLOW_UP_COUNT },
  (): ScriptedStep => ({
    stage: FOLLOW_UP_STAGE,
    get raw(): unknown {
      return pendingDecisions.shift();
    },
  }),
);

/** An authoring target for a scripted decision. */
function authoringTarget(
  file: string,
  symbol: string,
  type: InstrumentationActionType,
  rationale: string,
): InstrumentationTargetInput {
  return { file, symbol, type, rationale };
}

/**
 * A fully resolved proposal built from an installed action with some fields
 * replaced — the shape a model would use to try to change what is installed.
 */
function resolvedProposal(
  installed: InstrumentationAction,
  changes: Partial<Pick<InstrumentationAction, 'id' | 'file' | 'symbol' | 'type'>>,
  rationale: string,
): FollowUpAdditionalAction {
  return {
    id: changes.id ?? installed.id,
    file: changes.file ?? installed.file,
    symbol: changes.symbol ?? installed.symbol,
    type: changes.type ?? installed.type,
    adapter: installed.adapter,
    mode: installed.mode,
    rationale,
  };
}

/* -------------------------------------------------------------------------------------------------
 * The harness, and the session helpers built on it
 * ---------------------------------------------------------------------------------------------- */

let harness: Harness;
let scripted: ScriptedProvider;

/** A session driven through the real routes, with the connections that speak for it. */
interface LiveSession {
  /** The project copy the session instruments. */
  readonly project: FixtureProjectCopy;
  /** The session id. */
  readonly id: string;
  /** The inspected tab the DevTools connection bound. */
  readonly tabId: number;
  /** The editor connection announcing the project: the transcript every assertion reads. */
  readonly editor: HarnessWsClient;
  /** The DevTools connection, which also relays the page agent's frames. */
  readonly devtools: HarnessWsClient;
  /** The server-agent credential the dev-server preload would present. */
  readonly serverAgentToken: string;
  /** The message of the install's closing `done` row, as the first install showed it. */
  readonly readyMessage: string;
}

/** The session as the service's own store holds it. */
function storedSession(sessionId: string): SessionRecord {
  const record = unwrap(harness.repos.sessions.get(sessionId), 'sessions.get');
  if (record === undefined) {
    throw new Error(`The session ${sessionId} is not in the store.`);
  }
  return record;
}

/**
 * Waits until the stored session satisfies `predicate`. The store is read
 * directly rather than through `GET /sessions/:id`, because that route is the
 * reopen path and replays frames to every connected client — which would put
 * replays into the transcripts this suite reads pushes from.
 */
function waitForStored(
  sessionId: string,
  predicate: (record: SessionRecord) => boolean,
  description: string,
): Promise<SessionRecord> {
  return waitUntil(
    () => {
      const record = storedSession(sessionId);
      return predicate(record) ? record : undefined;
    },
    description,
    HARNESS_TIMEOUTS.pipeline,
  );
}

/** The session's modification journal, in application order. */
async function modificationsOf(sessionId: string): Promise<ModificationRecord[]> {
  return unwrap(await harness.repos.modifications.listBySession(sessionId), 'modifications');
}

/** The session's analysis ladder, oldest first. */
function analysesOf(sessionId: string): AnalysisResult[] {
  return unwrap(harness.repos.panels.listAnalyses(sessionId), 'panels.listAnalyses');
}

/** The session's panel ladder, oldest first. */
function panelsOf(sessionId: string): PanelSpec[] {
  return unwrap(harness.repos.panels.listPanels(sessionId), 'panels.listPanels');
}

/** The session's stored plan versions, oldest first. */
function plansOf(sessionId: string): InstrumentationPlan[] {
  return unwrap(harness.repos.sessions.listPlans(sessionId), 'sessions.listPlans');
}

/**
 * The ordered statuses a session moved through, as its `session.updated`
 * pushes after transcript index `from` announced them, starting from `initial`
 * and with repeats collapsed.
 */
function statusWalk(
  client: HarnessWsClient,
  sessionId: string,
  from: number,
  initial: SessionStatus,
): SessionStatus[] {
  const walk: SessionStatus[] = [initial];
  for (const message of client.received.slice(from)) {
    if (isMessageOfType(message, 'session.updated') && message.payload.session.id === sessionId) {
      const { status } = message.payload.session;
      if (walk.at(-1) !== status) {
        walk.push(status);
      }
    }
  }
  return walk;
}

/** Waits for the push announcing that the session reached `status` with `predicate` holding. */
function waitForPushedStatus(
  session: LiveSession,
  from: number,
  status: SessionStatus,
  predicate: (record: SessionRecord) => boolean = () => true,
): Promise<HarnessMessage<'session.updated'>> {
  return waitFor(
    session.editor,
    'session.updated',
    (message, index) =>
      index >= from &&
      message.payload.session.id === session.id &&
      message.payload.session.status === status &&
      predicate(message.payload.session),
    HARNESS_TIMEOUTS.pipeline,
  );
}

/** The instrument stage's closing `done` rows pushed after transcript index `from`. */
function readyRowsSince(session: LiveSession, from: number): HarnessMessage<'session.progress'>[] {
  const rows: HarnessMessage<'session.progress'>[] = [];
  for (const [index, message] of session.editor.received.entries()) {
    if (
      index >= from &&
      isMessageOfType(message, 'session.progress') &&
      message.payload.sessionId === session.id &&
      message.payload.stage === INSTRUMENT_STAGE &&
      message.payload.status === PROGRESS_DONE
    ) {
      rows.push(message);
    }
  }
  return rows;
}

/**
 * Creates a session for `project` and drives it to `ready` through the real
 * pipeline: the launcher starts a stand-in dev server, a server-agent
 * connection stands for the preload (without one no file is ever patched), a
 * DevTools connection binds the tab and relays the page agent's `agent.ready`,
 * and the deterministic provider plans.
 */
async function openReadySession(
  project: FixtureProjectCopy,
  tabId: number,
  question: string,
): Promise<LiveSession> {
  unwrap(await harness.launchDevServer(project.root), 'devServer.launch');
  const credential = harness.issueServerAgentCredential(project.root);
  const serverAgent = await harness.ws({
    client: 'server-agent',
    projectRoot: project.root,
    token: credential.token,
  });
  expect(serverAgent.authenticated).toBe(true);
  const editor = await harness.editor(project.root);

  const created = await harness.createSession({ projectRoot: project.root, question });
  const { client: devtools } = await harness.connectDevtools({ tabId });
  const bound = await harness.bindTab(devtools, {
    tabId,
    url: created.devServerUrl,
    origin: new URL(created.devServerUrl).origin,
    sessionId: created.id,
  });
  if (isErr(bound)) {
    throw new Error(`session.bind was refused (${bound.error.code}): ${bound.error.message}`);
  }
  const announced = devtools.send('agent.ready', {
    tabId,
    documentId: `doc_followup_tab_${String(tabId)}`,
    producerId: `prd_followup_tab_${String(tabId)}`,
    url: created.devServerUrl,
    installedBeforeReact: true,
    reactDetected: true,
  });
  unwrap(announced.result, 'agent.ready');
  expect(await devtools.flush()).toBe(true);
  expect(devtools.errorsFor(announced.id)).toEqual([]);

  await waitForStored(
    created.id,
    (record) => record.status === STATUS.ready,
    'the session is ready',
  );
  const readyRow = await waitFor(
    editor,
    'session.progress',
    (message) =>
      message.payload.sessionId === created.id &&
      message.payload.stage === INSTRUMENT_STAGE &&
      message.payload.status === PROGRESS_DONE,
  );
  return Object.freeze({
    project,
    id: created.id,
    tabId,
    editor,
    devtools,
    serverAgentToken: credential.token,
    readyMessage: readyRow.payload.message,
  });
}

/** What one capture produced. */
interface CaptureOutcome {
  readonly captureId: string;
  readonly record: SessionRecord;
}

/**
 * Opens a capture, sends the batch through both producers — the browser half
 * as a `telemetry.event` frame on the DevTools connection, the server half on
 * the preload's ingest route — closes it, and waits for the analysis and panel
 * the capture's evidence yields.
 */
async function captureAndGenerate(
  session: LiveSession,
  events: readonly IngressEvent[],
): Promise<CaptureOutcome> {
  const before = storedSession(session.id);
  const { captureId } = unwrap(await harness.startCapture(session.id), 'capture.start');
  const { browser, server } = splitByProducer(events);

  const relayed = await harness.ingestFromAgent(session.devtools, browser);
  unwrap(relayed.sent, 'telemetry.event');
  expect(relayed.settled).toBe(true);
  expect(relayed.errors).toEqual([]);
  unwrap(
    await harness.ingestFromServerAgent({
      token: session.serverAgentToken,
      projectRoot: session.project.root,
      events: server,
    }),
    'telemetry ingest',
  );

  unwrap(await harness.stopCapture(session.id), 'capture.stop');
  const record = await waitForStored(
    session.id,
    (current) =>
      current.status === STATUS.generated &&
      current.analyses.length === before.analyses.length + 1 &&
      current.panelIds.length === before.panelIds.length + 1,
    'the capture is analysed and its panel generated',
  );
  return { captureId, record };
}

/** What asking one follow-up answered. */
interface AskedFollowUp {
  /** The editor transcript index before the question was sent. */
  readonly mark: number;
  /**
   * What `session.question` answered: the record holding the follow-up once
   * the stage has recorded it, or — when the follow-up itself settles first,
   * as a delta install that fails at once can — that settlement's own failure.
   * The route documents both answers; which one a fast failure produces is a
   * race the suite does not depend on.
   */
  readonly answered: Result<SessionRecord, DebuggenError>;
}

/** Queues `decision` and asks `question` through `POST /sessions/:id/question`. */
async function askFollowUp(
  session: LiveSession,
  question: string,
  decision: FollowUpDecision,
): Promise<AskedFollowUp> {
  enqueueDecision(decision);
  await harness.editor(session.project.root);
  const mark = session.editor.received.length;
  const answered = await harness.http().request('session.question', {
    params: { id: session.id },
    body: { question },
  });
  return { mark, answered };
}

/**
 * Holds the answer of a follow-up whose delta install failed: either the
 * recorded follow-up, or exactly the failure `instrumentation.failed` carried —
 * never a success that hides it, and never a different error.
 */
function expectRecordedOrFailedAs(
  answered: Result<SessionRecord, DebuggenError>,
  question: string,
  failureCode: string,
): void {
  if (isErr(answered)) {
    expect(answered.error.code).toBe(failureCode);
  } else {
    expect(last(answered.value.followUps, 'follow-up').question).toBe(question);
  }
}

/** The SHA-256 of a project file's raw bytes. */
function digestOf(project: FixtureProjectCopy, file: string): Promise<string> {
  return sha256OfFile(inProject(project, file));
}

/** The digest the committed corpus holds for `file`, from the copy's pre-session snapshot. */
function pristineDigest(project: FixtureProjectCopy, file: string): string {
  const digest = project.snapshot.get(file);
  if (digest === undefined) {
    throw new Error(`The corpus has no file ${file}.`);
  }
  return digest;
}

/** The records of `records` for one file, in application order. */
function recordsFor(records: readonly ModificationRecord[], file: string): ModificationRecord[] {
  return records.filter((record) => record.file === file);
}

/** One record by id, failing when the journal no longer holds it. */
function recordById(records: readonly ModificationRecord[], id: string): ModificationRecord {
  const found = records.find((record) => record.id === id);
  if (found === undefined) {
    throw new Error(`The journal no longer holds ${id}.`);
  }
  return found;
}

/* -------------------------------------------------------------------------------------------------
 * The suite
 * ---------------------------------------------------------------------------------------------- */

/** The inspected tabs of the two sessions. */
const FIRST_TAB = 41;
const CONFLICT_TAB = 42;

beforeAll(async () => {
  scripted = createScriptedProvider(DECISION_SCRIPT);
  harness = await startHarness({ provider: scripted.provider });
});

afterAll(async () => {
  // `harness` is unset only when `startHarness` itself threw, which the hook reports.
  if (harness !== undefined) {
    await harness.assertNoLeaks();
  }
});

describe('the follow-up paths of one session', () => {
  /** The live session every test of this block continues. */
  let session: LiveSession;

  /** The first plan, analysis, panel and capture: the ladders' rung n. */
  let baseline: {
    readonly plan: InstrumentationPlan;
    readonly analysis: AnalysisResult;
    readonly panel: PanelSpec;
    readonly captureId: string;
    readonly records: readonly ModificationRecord[];
  };

  /** The patch-mode action of plan version n — the one file edit the first install made. */
  let installedPatch: InstrumentationAction;

  beforeAll(async () => {
    session = await openReadySession(
      harness.requireProject(),
      FIRST_TAB,
      'Why does the trail report take so long to appear after I pick a trail?',
    );
    const { captureId } = await captureAndGenerate(session, readTelemetryBatch(CROSS_TIER_BATCH));
    baseline = Object.freeze({
      plan: only(plansOf(session.id), 'plan version'),
      analysis: only(analysesOf(session.id), 'analysis'),
      panel: only(panelsOf(session.id), 'panel'),
      captureId,
      records: await modificationsOf(session.id),
    });
    installedPatch = only(
      baseline.plan.instrumentationTargets.filter((action) => action.mode === PATCH_MODE),
      'patch-mode action of the first plan',
    );
  });

  it('reaches `generated` through the real pipeline and records rung n of every ladder', async () => {
    const record = storedSession(session.id);
    expect(record.status).toBe(STATUS.generated);

    // Rung n of the plan ladder: the deterministic plan, installed once.
    expect(record.plans).toEqual([baseline.plan]);
    const firstRecord = only(baseline.records, 'modification of the first install');
    expect(firstRecord).toMatchObject({
      file: installedPatch.file,
      planVersion: baseline.plan.planVersion,
      status: MODIFICATION.applied,
      originalHash: pristineDigest(session.project, installedPatch.file),
    });
    expect(firstRecord.previousRecordId).toBeUndefined();
    expect(await digestOf(session.project, installedPatch.file)).toBe(firstRecord.instrumentedHash);

    // Rung n of the analysis and panel ladders, drawn from the first capture.
    expect(baseline.analysis.captureId).toBe(baseline.captureId);
    expect(baseline.analysis.supersedes).toBeUndefined();
    expect(baseline.panel.supersedes).toBeUndefined();
    expect(record.panelIds).toEqual([baseline.panel.id]);
    expect(record.analyses.map((analysis) => analysis.id)).toEqual([baseline.analysis.id]);
    expect(record.followUps).toEqual([]);
  });

  it('answers from the stored evidence: `generated → analyzing → generated`, rung n + 1 appended, nothing installed or captured', async () => {
    const question = 'Which step of that request accounts for most of its time?';
    const analysesBefore = analysesOf(session.id);
    const panelsBefore = panelsOf(session.id);
    const plansBefore = plansOf(session.id);
    const capturesBefore = unwrap(
      harness.repos.sessions.listCaptures(session.id),
      'sessions.listCaptures',
    );
    const recordsBefore = await modificationsOf(session.id);
    const treeBefore = await snapshotTree(session.project.root);

    const asked = await askFollowUp(session, question, {
      needsNewCapture: false,
      additionalActions: [],
    });
    const { mark } = asked;

    // The route answers with the record the question was recorded on.
    const answered = unwrap(asked.answered, 'session.question');
    expect(answered.id).toBe(session.id);
    expect(last(answered.followUps, 'follow-up').question).toBe(question);

    const done = await waitForStored(
      session.id,
      (record) =>
        record.status === STATUS.generated &&
        record.analyses.length === analysesBefore.length + 1 &&
        record.panelIds.length === panelsBefore.length + 1,
      'the follow-up regenerated the analysis and the panel',
    );
    await waitForPushedStatus(
      session,
      mark,
      STATUS.generated,
      (record) => record.panelIds.length === panelsBefore.length + 1,
    );
    expect(statusWalk(session.editor, session.id, mark, STATUS.generated)).toEqual([
      STATUS.generated,
      STATUS.analyzing,
      STATUS.generated,
    ]);

    // Nothing was captured and nothing was installed: no capture window, no new
    // or changed modification record, no plan version, no byte of the project.
    expect(
      unwrap(harness.repos.sessions.getActiveCapture(session.id), 'getActiveCapture'),
    ).toBeUndefined();
    expect(
      unwrap(harness.repos.sessions.listCaptures(session.id), 'sessions.listCaptures'),
    ).toEqual(capturesBefore);
    expect(await modificationsOf(session.id)).toEqual(recordsBefore);
    expect(plansOf(session.id)).toEqual(plansBefore);
    await assertTreeUnchanged(session.project.root, treeBefore);

    // The analysis ladder: rung n is still there, unmodified, and rung n + 1
    // supersedes it, drawn from the same stored capture.
    const analysesAfter = analysesOf(session.id);
    expect(analysesAfter.slice(0, -1)).toEqual(analysesBefore);
    const previousAnalysis = last(analysesBefore, 'analysis');
    const analysis = last(analysesAfter, 'analysis');
    expect(analysis.id).not.toBe(previousAnalysis.id);
    expect(analysis.analysisVersion).toBe(previousAnalysis.analysisVersion + 1);
    expect(analysis.supersedes).toBe(previousAnalysis.id);
    expect(analysis.captureId).toBe(previousAnalysis.captureId);
    expect(last(done.analyses, 'stored analysis')).toEqual(analysis);

    // The panel ladder, likewise: append-only, `supersedes` naming rung n.
    const panelsAfter = panelsOf(session.id);
    expect(panelsAfter.slice(0, -1)).toEqual(panelsBefore);
    const previousPanel = last(panelsBefore, 'panel');
    const panel = last(panelsAfter, 'panel');
    expect(panel.id).not.toBe(previousPanel.id);
    expect(panel.panelVersion).toBe(previousPanel.panelVersion + 1);
    expect(panel.supersedes).toBe(previousPanel.id);
    expect(done.panelIds).toEqual([...panelsBefore.map((spec) => spec.id), panel.id]);
    unwrap(validatePanelSpec(panel), 'validatePanelSpec');

    // `panel.generated` carries the new version, and — inside the specification —
    // the link to the version it replaces.
    const pushed = await waitFor(
      session.editor,
      'panel.generated',
      (message, index) => index >= mark && message.payload.panelId === panel.id,
    );
    expect(pushed.payload.sessionId).toBe(session.id);
    expect(pushed.payload.panel).toEqual(panel);
    expect(pushed.payload.panel.supersedes).toBe(previousPanel.id);
    unwrap(validatePanelSpec(pushed.payload.panel), 'validatePanelSpec(panel.generated)');

    // The follow-up is appended with the outcome it produced, and the follow-up
    // prompt version the stage actually rendered is the one recorded.
    const followUp = last(done.followUps, 'follow-up');
    expect(done.followUps).toHaveLength(1);
    expect(followUp).toMatchObject({
      question,
      needsNewCapture: false,
      captureId: previousAnalysis.captureId,
      analysisId: analysis.id,
      panelId: panel.id,
    });
    const decisionCall = last(
      scripted.calls.filter((call) => call.stage === FOLLOW_UP_STAGE),
      'follow-up model call',
    );
    expect(decisionCall.scripted).toBe(true);
    expect(done.promptVersions[FOLLOW_UP_STAGE]).toBe(decisionCall.promptVersion);
  });

  it('replays the latest analysis and panel on reopen and still serves the superseded panel', async () => {
    const latestAnalysis = last(analysesOf(session.id), 'analysis');
    const latestPanel = last(panelsOf(session.id), 'panel');
    const mark = session.editor.received.length;
    const http = harness.http();

    const reopened = unwrap(
      await http.request('session.get', { params: { id: session.id } }),
      'session.get',
    );
    expect(last(reopened.analyses, 'analysis')).toEqual(latestAnalysis);
    expect(last(reopened.panelIds, 'panel id')).toBe(latestPanel.id);

    const replayedAnalysis = await waitFor(
      session.editor,
      'analysis.completed',
      (message, index) => index >= mark && message.payload.sessionId === session.id,
    );
    expect(replayedAnalysis.payload.analysis).toEqual(latestAnalysis);
    const replayedPanel = await waitFor(
      session.editor,
      'panel.generated',
      (message, index) => index >= mark && message.payload.sessionId === session.id,
    );
    expect(replayedPanel.payload.panelId).toBe(latestPanel.id);
    expect(replayedPanel.payload.panel).toEqual(latestPanel);

    const current = unwrap(
      await http.request('panel.get', { params: { id: session.id } }),
      'panel.get',
    );
    expect(current.panel).toEqual(latestPanel);
    const superseded = unwrap(
      await http.request('panel.getById', {
        params: { id: session.id, panelId: baseline.panel.id },
      }),
      'panel.getById',
    );
    expect(superseded.panel).toEqual(baseline.panel);
  });

  it('refuses a removal, a replacement and a re-scope, then installs only the accepted addition: `generated → planning → instrumenting → ready`', async () => {
    const question = 'Is the time going into loading the trail report itself?';
    const previousPlan = last(plansOf(session.id), 'plan version');
    const recordsBefore = await modificationsOf(session.id);
    const installedRecord = only(recordsBefore, 'modification record');
    const installedFileDigest = await digestOf(session.project, installedPatch.file);
    const rationale = 'The follow-up needs this step measured rather than inferred.';
    const addition = authoringTarget(
      CORPUS.serviceFile,
      CORPUS.loadSymbol,
      ACTION_TYPE.functionTiming,
      rationale,
    );

    const asked = await askFollowUp(session, question, {
      needsNewCapture: true,
      additionalActions: [
        // A removal: the installed action's id moved onto another target.
        resolvedProposal(
          installedPatch,
          { file: CORPUS.poolFile, symbol: CORPUS.poolGateSymbol },
          rationale,
        ),
        // A replacement: the installed identity re-issued under another id.
        resolvedProposal(installedPatch, { id: newActionId() }, rationale),
        // A re-scope: the installed id kept on its target with another type.
        resolvedProposal(
          installedPatch,
          {
            type:
              installedPatch.type === ACTION_TYPE.serverSpan
                ? ACTION_TYPE.functionTiming
                : ACTION_TYPE.serverSpan,
          },
          rationale,
        ),
        // The one genuine addition.
        addition,
      ],
    });
    const { mark } = asked;
    const answered = unwrap(asked.answered, 'session.question');
    expect(last(answered.followUps, 'follow-up').question).toBe(question);

    const ready = await waitForStored(
      session.id,
      (record) => record.status === STATUS.ready && record.plans.length === 2,
      'plan version n + 1 is installed and the session is ready again',
    );
    await waitForPushedStatus(session, mark, STATUS.ready);
    expect(statusWalk(session.editor, session.id, mark, STATUS.generated)).toEqual([
      STATUS.generated,
      STATUS.planning,
      STATUS.instrumenting,
      STATUS.ready,
    ]);

    // Each refused proposal was refused for its own reason, and only the addition
    // was accepted — read from the stage's own decision record.
    const decided = last(harness.logger.withMessage(FOLLOW_UP_DECIDED_LOG), 'decision log record');
    expect(decided.fields).toMatchObject({
      path: memberOf(FOLLOW_UP_PATHS, 'new-capture'),
      needsNewCapture: true,
      proposed: 4,
      accepted: 1,
      rejected: {
        [memberOf(FOLLOW_UP_DELTA_REJECTION_REASONS, 'removal')]: 1,
        [memberOf(FOLLOW_UP_DELTA_REJECTION_REASONS, 'replacement')]: 1,
        [memberOf(FOLLOW_UP_DELTA_REJECTION_REASONS, 're-scope')]: 1,
      },
    });

    // Plan version n + 1 is the previous plan plus exactly the accepted addition:
    // every installed action is still there, verbatim and in place, and nothing a
    // refused proposal named reached the plan.
    const plans = plansOf(session.id);
    expect(plans[0]).toEqual(previousPlan);
    const plan = last(plans, 'plan version');
    expect(ready.plans).toEqual(plans);
    expect(plan.planVersion).toBe(previousPlan.planVersion + 1);
    const previousCount = previousPlan.instrumentationTargets.length;
    expect(plan.instrumentationTargets.slice(0, previousCount)).toEqual(
      previousPlan.instrumentationTargets,
    );
    const previousKeys = previousPlan.instrumentationTargets.map(actionIdentityKey);
    const keys = plan.instrumentationTargets.map(actionIdentityKey);
    expect(keys.slice(0, previousCount)).toEqual(previousKeys);
    expect(new Set(keys).size).toBe(keys.length);
    const delta = only(plan.instrumentationTargets.slice(previousCount), 'delta action');
    expect(actionIdentityKey(delta)).toBe(actionIdentityKey(addition));
    expect(delta.mode).toBe(PATCH_MODE);
    expect(previousPlan.instrumentationTargets.map((action) => action.id)).not.toContain(delta.id);
    expect(plan.instrumentationTargets.filter((action) => action.id === installedPatch.id)).toEqual(
      [installedPatch],
    );

    // The installer received only the delta: the earlier record and its file are
    // exactly as they were, and the one new record is the delta's.
    const records = await modificationsOf(session.id);
    expect(recordById(records, installedRecord.id)).toEqual(installedRecord);
    expect(await digestOf(session.project, installedPatch.file)).toBe(installedFileDigest);
    const added = records.filter((record) => record.id !== installedRecord.id);
    const deltaRecord = only(added, 'record of the delta install');
    expect(deltaRecord).toMatchObject({
      file: CORPUS.serviceFile,
      planVersion: plan.planVersion,
      status: MODIFICATION.applied,
      originalHash: pristineDigest(session.project, CORPUS.serviceFile),
    });
    expect(deltaRecord.previousRecordId).toBeUndefined();
    expect(await digestOf(session.project, CORPUS.serviceFile)).toBe(deltaRecord.instrumentedHash);
    expect(await digestOf(session.project, CORPUS.poolFile)).toBe(
      pristineDigest(session.project, CORPUS.poolFile),
    );

    // `instrumentation.ready` reports the delta install, not the whole plan again.
    const announced = await waitFor(
      session.editor,
      'instrumentation.ready',
      (message, index) => index >= mark && message.payload.sessionId === session.id,
    );
    expect(announced.payload.applied).toEqual([deltaRecord]);
    expect(announced.payload.unavailable).toEqual([]);
    expect(announced.payload.runtimeHooks.every((hook) => typeof hook === 'string')).toBe(true);

    // The developer is asked to reproduce again: the install closes with the same
    // "ready" row the first install ended with, and no capture has started.
    const readyRows = readyRowsSince(session, mark);
    expect(readyRows.map((row) => row.payload.message)).toContain(session.readyMessage);
    expect(
      unwrap(harness.repos.sessions.getActiveCapture(session.id), 'getActiveCapture'),
    ).toBeUndefined();
    expect(last(ready.followUps, 'follow-up')).toMatchObject({
      question,
      needsNewCapture: true,
      planVersion: plan.planVersion,
    });
  });

  it('drives the new capture through `analyzing → generated` as rung n + 2 of both ladders', async () => {
    const analysesBefore = analysesOf(session.id);
    const panelsBefore = panelsOf(session.id);
    const mark = session.editor.received.length;

    const { captureId, record } = await captureAndGenerate(
      session,
      reidentifyBatch(readTelemetryBatch(CROSS_TIER_BATCH), 1),
    );
    await waitForPushedStatus(
      session,
      mark,
      STATUS.generated,
      (pushed) => pushed.panelIds.length === panelsBefore.length + 1,
    );
    expect(statusWalk(session.editor, session.id, mark, STATUS.ready).slice(-2)).toEqual([
      STATUS.analyzing,
      STATUS.generated,
    ]);
    expect(captureId).not.toBe(baseline.captureId);

    const analysesAfter = analysesOf(session.id);
    expect(analysesAfter.slice(0, -1)).toEqual(analysesBefore);
    const analysis = last(analysesAfter, 'analysis');
    expect(analysis.analysisVersion).toBe(baseline.analysis.analysisVersion + 2);
    expect(analysis.supersedes).toBe(last(analysesBefore, 'analysis').id);
    expect(analysis.captureId).toBe(captureId);

    const panelsAfter = panelsOf(session.id);
    expect(panelsAfter.slice(0, -1)).toEqual(panelsBefore);
    const panel = last(panelsAfter, 'panel');
    expect(panel.panelVersion).toBe(baseline.panel.panelVersion + 2);
    expect(panel.supersedes).toBe(last(panelsBefore, 'panel').id);
    unwrap(validatePanelSpec(panel), 'validatePanelSpec');
    expect(record.panelIds).toEqual(panelsAfter.map((spec) => spec.id));

    // The whole ladder reads n → n + 1 → n + 2, each rung naming the one below.
    expect(analysesAfter.map((entry) => entry.supersedes)).toEqual([
      undefined,
      baseline.analysis.id,
      last(analysesBefore, 'analysis').id,
    ]);
    expect(panelsAfter.map((entry) => entry.supersedes)).toEqual([
      undefined,
      baseline.panel.id,
      last(panelsBefore, 'panel').id,
    ]);
  });

  it('undoes a delta that fails part-way at once and leaves the session at its previous plan version', async () => {
    const question = 'Does the lookup behind the report also read the trailhead gate?';
    const plansBefore = plansOf(session.id);
    const analysesBefore = analysesOf(session.id);
    const panelsBefore = panelsOf(session.id);
    const recordsBefore = await modificationsOf(session.id);
    const serviceHead = only(recordsFor(recordsBefore, CORPUS.serviceFile), 'service record');
    const routeDigest = await digestOf(session.project, installedPatch.file);

    // The injected failure: the second delta target (patched after the first, by
    // file order) must back its current bytes up under their digest, and a file
    // that does not hash to that name already sits there, so the backup store
    // refuses the write and the patcher stops with the first target applied.
    const currentDigest = await digestOf(session.project, CORPUS.serviceFile);
    expect(currentDigest).toBe(serviceHead.instrumentedHash);
    const planted = join(dirname(serviceHead.backupPath), currentDigest);
    expect(await exists(planted)).toBe(false);
    const plantedBytes = Buffer.from(
      'planted by the follow-up suite: these bytes do not hash to this name\n',
    );
    expect(sha256Hex(plantedBytes)).not.toBe(currentDigest);
    await writeFile(planted, plantedBytes, { mode: SECURE_FILE_MODE, flag: 'wx' });

    let asked: AskedFollowUp;
    let plantedAfter: Buffer;
    try {
      asked = await askFollowUp(session, question, {
        needsNewCapture: true,
        additionalActions: [
          authoringTarget(
            CORPUS.poolFile,
            CORPUS.poolQuerySymbol,
            ACTION_TYPE.functionTiming,
            'The query layer is where the report waits.',
          ),
          authoringTarget(
            CORPUS.serviceFile,
            CORPUS.summarizeSymbol,
            ACTION_TYPE.functionTiming,
            'Folding the reports may be where the time goes.',
          ),
        ],
      });
      await waitForStored(
        session.id,
        (record) => record.status === STATUS.failed,
        'the failed delta install files the session as failed',
      );
      plantedAfter = await readFile(planted);
    } finally {
      await rm(planted, { force: true });
    }
    const { mark } = asked;

    // The backup store kept the file it found rather than overwriting it.
    expect(plantedAfter).toEqual(plantedBytes);

    // The failure surfaces as `instrumentation.failed` with a hint — never as a
    // partially applied plan — and the question's answer, when it came after the
    // failure, is that same failure.
    const failed = await waitFor(
      session.editor,
      'instrumentation.failed',
      (message, index) => index >= mark && message.payload.sessionId === session.id,
    );
    expect(failed.payload.error.hint?.trim().length ?? 0).toBeGreaterThan(0);
    expectRecordedOrFailedAs(asked.answered, question, failed.payload.error.code);
    expect(
      session.editor.received
        .slice(mark)
        .some((message) => isMessageOfType(message, 'instrumentation.ready')),
    ).toBe(false);
    const failedRow = await waitFor(
      session.editor,
      'session.progress',
      (message, index) =>
        index >= mark &&
        message.payload.sessionId === session.id &&
        message.payload.status === PROGRESS_FAILED,
    );
    expect(failedRow.payload.message.length).toBeGreaterThan(0);

    // The plan ladder did not move: version n + 1 was never recorded.
    expect(plansOf(session.id)).toEqual(plansBefore);
    const previousVersion = last(plansBefore, 'plan version').planVersion;
    expect(unwrap(harness.repos.sessions.latestPlanVersion(session.id), 'latestPlanVersion')).toBe(
      previousVersion,
    );
    expect(
      unwrap(harness.repos.sessions.getPlan(session.id, previousVersion + 1), 'getPlan'),
    ).toBeUndefined();

    // The record the call applied was reverse-restored immediately; the earlier
    // versions' records are untouched and their files still carry their patches.
    const records = await modificationsOf(session.id);
    for (const earlier of recordsBefore) {
      expect(recordById(records, earlier.id)).toEqual(earlier);
    }
    const attempted = records.filter(
      (record) => !recordsBefore.some((earlier) => earlier.id === record.id),
    );
    const undone = only(attempted, 'record of the failed delta');
    expect(undone).toMatchObject({
      file: CORPUS.poolFile,
      planVersion: previousVersion + 1,
      status: MODIFICATION.reverted,
    });
    expect(await exists(undone.backupPath)).toBe(false);
    expect(await digestOf(session.project, CORPUS.poolFile)).toBe(
      pristineDigest(session.project, CORPUS.poolFile),
    );
    expect(await digestOf(session.project, CORPUS.serviceFile)).toBe(serviceHead.instrumentedHash);
    expect(await digestOf(session.project, installedPatch.file)).toBe(routeDigest);

    // No analysis or panel came of it, and the follow-up carries no outcome link.
    expect(analysesOf(session.id)).toEqual(analysesBefore);
    expect(panelsOf(session.id)).toEqual(panelsBefore);
    const record = storedSession(session.id);
    const followUp = last(record.followUps, 'follow-up');
    expect(followUp.question).toBe(question);
    expect(followUp.planVersion).toBeUndefined();
    expect(followUp.analysisId).toBeUndefined();
    expect(followUp.panelId).toBeUndefined();

    // `generated` is out of reach from here: the only edge into it leaves
    // `analyzing`, and only with a validated analysis and panel in hand.
    expect(record.status).toBe(STATUS.failed);
    expect(transition(record.status, STATUS.generated).ok).toBe(false);
    expect(transition(STATUS.analyzing, STATUS.generated).ok).toBe(false);
  });

  it('layers the next plan version over an already instrumented file as a verified `previousRecordId` chain', async () => {
    const question = 'How long does folding the reports into a summary take?';
    const plansBefore = plansOf(session.id);
    const previousPlan = last(plansBefore, 'plan version');
    const recordsBefore = await modificationsOf(session.id);
    const parent = only(
      recordsFor(recordsBefore, CORPUS.serviceFile),
      'record of the first service patch',
    );
    const addition = authoringTarget(
      CORPUS.serviceFile,
      CORPUS.summarizeSymbol,
      ACTION_TYPE.functionTiming,
      'Folding the reports may be where the time goes.',
    );

    const asked = await askFollowUp(session, question, {
      needsNewCapture: true,
      additionalActions: [addition],
    });
    const { mark } = asked;
    expect(last(unwrap(asked.answered, 'session.question').followUps, 'follow-up').question).toBe(
      question,
    );
    const ready = await waitForStored(
      session.id,
      (record) => record.status === STATUS.ready && record.plans.length === plansBefore.length + 1,
      'the chained delta is installed',
    );
    await waitForPushedStatus(session, mark, STATUS.ready);
    expect(statusWalk(session.editor, session.id, mark, STATUS.failed)).toEqual([
      STATUS.failed,
      STATUS.planning,
      STATUS.instrumenting,
      STATUS.ready,
    ]);

    // The failed attempt consumed no version: this is n + 1 on top of n.
    const plan = last(plansOf(session.id), 'plan version');
    expect(plan.planVersion).toBe(previousPlan.planVersion + 1);
    expect(plan.instrumentationTargets.slice(0, -1)).toEqual(previousPlan.instrumentationTargets);
    expect(actionIdentityKey(last(plan.instrumentationTargets, 'action'))).toBe(
      actionIdentityKey(addition),
    );
    expect(ready.plans).toEqual(plansOf(session.id));

    // The chain: the new record replaced the bytes the earlier patch wrote, so its
    // originalHash is that record's instrumentedHash and it links back to it.
    const records = await modificationsOf(session.id);
    for (const earlier of recordsBefore) {
      expect(recordById(records, earlier.id)).toEqual(earlier);
    }
    const child = only(
      records.filter((record) => !recordsBefore.some((earlier) => earlier.id === record.id)),
      'record of the chained delta',
    );
    expect(child).toMatchObject({
      file: CORPUS.serviceFile,
      planVersion: plan.planVersion,
      status: MODIFICATION.applied,
      originalHash: parent.instrumentedHash,
      previousRecordId: parent.id,
    });
    expect(recordById(records, parent.id).status).toBe(MODIFICATION.applied);
    expect(child.instrumentedHash).not.toBe(parent.instrumentedHash);
    expect(await digestOf(session.project, CORPUS.serviceFile)).toBe(child.instrumentedHash);

    // The child's backup holds the bytes the parent patch wrote — exactly what a
    // reverse restore must put back before the parent's own backup is written.
    expect(await sha256OfFile(child.backupPath)).toBe(parent.instrumentedHash);
    expect(await sha256OfFile(parent.backupPath)).toBe(parent.originalHash);
    expect(parent.originalHash).toBe(pristineDigest(session.project, CORPUS.serviceFile));

    // The journal reads the chain oldest → newest, so a caller iterates it in
    // strict reverse; the head is the child.
    const chain = unwrap(await harness.repos.modifications.listChain(child.id), 'listChain');
    expect(chain.map((record) => record.id)).toEqual([parent.id, child.id]);
    const head = unwrap(
      await harness.repos.modifications.latestRecordForFile(session.id, CORPUS.serviceFile),
      'latestRecordForFile',
    );
    expect(head?.id).toBe(child.id);

    const announced = await waitFor(
      session.editor,
      'instrumentation.ready',
      (message, index) => index >= mark && message.payload.sessionId === session.id,
    );
    expect(announced.payload.applied).toEqual([child]);
  });

  it('restores the chain in strict reverse order on session end and leaves the copy byte-identical', async () => {
    const recordsBefore = await modificationsOf(session.id);
    const [parent, child] = recordsFor(recordsBefore, CORPUS.serviceFile).filter(
      (record) => record.status === MODIFICATION.applied,
    );
    if (parent === undefined || child === undefined) {
      throw new Error('The service file must carry a two-record chain before the session ends.');
    }
    expect(child.previousRecordId).toBe(parent.id);
    const mark = session.editor.received.length;

    const ended = unwrap(await harness.endSession(session.id), 'session.end');
    expect(ended.cleanup).toBe(CLEANUP.clean);

    // Every record is reverted, and the chain was unwound newest first: each
    // revert is stamped with its own clock reading, and the child's comes first.
    const records = await modificationsOf(session.id);
    expect(records.map((record) => record.status)).toEqual(
      records.map(() => MODIFICATION.reverted),
    );
    const revertedParent = recordById(records, parent.id);
    const revertedChild = recordById(records, child.id);
    expect(revertedChild.appliedAt).toBeLessThan(revertedParent.appliedAt);
    expect(revertedChild.appliedAt).toBeGreaterThan(child.appliedAt);

    // Byte-for-byte: the copy is the committed corpus again.
    await assertTreeUnchanged(session.project.root, session.project.snapshot);

    // Backups are deleted only once their restores verified — and all of them did.
    for (const record of records) {
      expect(await exists(record.backupPath)).toBe(false);
    }

    const record = storedSession(session.id);
    expect(record.status).toBe(STATUS.ended);
    expect(record.cleanup.status).toBe(CLEANUP.clean);
    expect(record.cleanup.conflicts).toEqual([]);
    const completed = await waitFor(
      session.editor,
      'cleanup.completed',
      (message, index) => index >= mark && message.payload.sessionId === session.id,
    );
    expect(completed.payload.status).toBe(CLEANUP.clean);
    expect(completed.payload.conflicts).toEqual([]);
  });
});

describe('an edit made between two installs of one file', () => {
  /** A second session, on a second copy of the corpus, so its conflict stays its own. */
  let session: LiveSession;

  /** The first install's record for the service file, which the developer's edit invalidates. */
  let firstRecord: ModificationRecord;

  /** The bytes the developer saved over the instrumented file. */
  let developerBytes: Buffer;

  beforeAll(async () => {
    const project = await harness.copyFixtureProject();
    session = await openReadySession(
      project,
      CONFLICT_TAB,
      'Why is the trail report slow to load on the conditions board?',
    );
    await captureAndGenerate(session, reidentifyBatch(readTelemetryBatch(CROSS_TIER_BATCH), 2));
  });

  it('installs a first delta on the service file and captures again', async () => {
    const asked = await askFollowUp(session, 'Is loading the trail report the slow part?', {
      needsNewCapture: true,
      additionalActions: [
        authoringTarget(
          CORPUS.serviceFile,
          CORPUS.loadSymbol,
          ACTION_TYPE.functionTiming,
          'The follow-up needs the report load measured.',
        ),
      ],
    });
    const { mark } = asked;
    unwrap(asked.answered, 'session.question');
    await waitForStored(
      session.id,
      (record) => record.status === STATUS.ready && record.plans.length === 2,
      'the first delta is installed',
    );
    await waitForPushedStatus(session, mark, STATUS.ready);
    firstRecord = only(
      recordsFor(await modificationsOf(session.id), CORPUS.serviceFile),
      'record of the first service patch',
    );
    expect(firstRecord.status).toBe(MODIFICATION.applied);
    expect(await digestOf(session.project, CORPUS.serviceFile)).toBe(firstRecord.instrumentedHash);

    await captureAndGenerate(session, reidentifyBatch(readTelemetryBatch(CROSS_TIER_BATCH), 3));
  });

  it('turns the edit into a conflict and refuses to layer the second install over it', async () => {
    const servicePath = inProject(session.project, CORPUS.serviceFile);
    developerBytes = Buffer.concat([
      await readFile(servicePath),
      Buffer.from('\n// Saved by hand while the debugging session was still running.\n'),
    ]);
    await writeFile(servicePath, developerBytes);

    // The watcher sees the file no longer hashes to what the patch wrote.
    await waitUntil(
      async () => {
        const current = unwrap(await harness.repos.modifications.get(firstRecord.id), 'get');
        return current?.status === MODIFICATION.conflict ? current : undefined;
      },
      'the edited file is reported as a conflict',
      HARNESS_TIMEOUTS.capture,
    );

    const plansBefore = plansOf(session.id);
    const question = 'How long does summarising the reports take?';
    const asked = await askFollowUp(session, question, {
      needsNewCapture: true,
      additionalActions: [
        authoringTarget(
          CORPUS.serviceFile,
          CORPUS.summarizeSymbol,
          ACTION_TYPE.functionTiming,
          'Folding the reports may be where the time goes.',
        ),
      ],
    });
    const { mark } = asked;
    await waitForStored(
      session.id,
      (record) => record.status === STATUS.failed,
      'the second install is refused',
    );
    const failed = await waitFor(
      session.editor,
      'instrumentation.failed',
      (message, index) => index >= mark && message.payload.sessionId === session.id,
    );
    expect(failed.payload.error.hint?.trim().length ?? 0).toBeGreaterThan(0);
    expectRecordedOrFailedAs(asked.answered, question, failed.payload.error.code);
    expect(last(storedSession(session.id).followUps, 'follow-up').question).toBe(question);

    // The chain halts at the conflict: nothing was layered over the edit, the
    // plan ladder did not move, and the developer's bytes are on disk untouched.
    const layered = recordsFor(await modificationsOf(session.id), CORPUS.serviceFile).filter(
      (record) => record.id !== firstRecord.id && record.status !== MODIFICATION.reverted,
    );
    expect(layered).toEqual([]);
    expect(plansOf(session.id)).toEqual(plansBefore);
    expect(await readFile(servicePath)).toEqual(developerBytes);
  });

  it("keeps the developer's bytes and the original through cleanup, reporting the conflict", async () => {
    const servicePath = inProject(session.project, CORPUS.serviceFile);
    const ended = unwrap(await harness.endSession(session.id), 'session.end');
    expect(ended.cleanup).toBe(CLEANUP.conflict);

    // Only the edited file differs from the corpus, and it holds exactly what the
    // developer saved; every other patched file was restored.
    expect(await readFile(servicePath)).toEqual(developerBytes);
    const difference = diffTreeSnapshots(
      session.project.snapshot,
      await snapshotTree(session.project.root),
    );
    expect(difference).toEqual({ added: [], removed: [], changed: [CORPUS.serviceFile] });

    // The conflicting record keeps its backup, and the backup is the original.
    const records = await modificationsOf(session.id);
    const conflicted = recordById(records, firstRecord.id);
    expect(conflicted.status).toBe(MODIFICATION.conflict);
    expect(await sha256OfFile(conflicted.backupPath)).toBe(
      pristineDigest(session.project, CORPUS.serviceFile),
    );
    for (const record of records.filter((entry) => entry.file !== CORPUS.serviceFile)) {
      expect(record.status).toBe(MODIFICATION.reverted);
    }

    const stored = storedSession(session.id);
    expect(stored.status).toBe(STATUS.ended);
    expect(stored.cleanup.status).toBe(CLEANUP.conflict);
    expect(stored.cleanup.conflicts.map((conflict) => conflict.file)).toContain(CORPUS.serviceFile);
  });
});

it('served every scripted follow-up decision exactly once', () => {
  scripted.assertConsumed();
  expect(pendingDecisions).toEqual([]);
  expect(scripted.calls.filter((call) => call.stage === FOLLOW_UP_STAGE)).toHaveLength(
    FOLLOW_UP_COUNT,
  );
});
