/**
 * The end-to-end session walk of the local service: create → progress → ready
 * → capture → analysis → panel → end, driven entirely through the real HTTP
 * routes and WebSocket pushes of a harness-booted service (AAP §0.8.3, §0.5.5).
 *
 * ## What makes this suite different from the colocated unit suites
 *
 * `src/sessions/state-machine.test.ts` proves the pure transition table and
 * `src/pipeline/orchestrator.test.ts` proves stage sequencing against fakes.
 * Neither is restated here. This file's value is the **real** walk: a real
 * `node:sqlite` store in a temporary `$DEBUGGEN_HOME`, the real HTTP and
 * WebSocket transports, the real ts-morph code index over a copied fixture
 * project, the real installer and cleanup writing and restoring that copy, and
 * the real rules-based provider (`DEBUGGEN_PROVIDER=deterministic`, the harness
 * default). The provider is handed to the service behind the harness's
 * pass-through recorder (`createScriptedProvider` with an empty script, whose
 * fallback *is* the deterministic provider), which changes no answer and only
 * lets the reopen replay prove that it made no model call.
 *
 * ## The from-findings guarantee
 *
 * `src/sessions/progress.ts` deliberately ships no colocated suite; its brief
 * names this file as the place where its pure row builders are asserted
 * against real findings. So the progress checks below do not stop at "rows
 * arrived": they prove that every investigation row names a route or file that
 * exists in the copied corpus, that rewording the question leaves the rows
 * unchanged, that renaming a route in another copy changes them accordingly,
 * and that the builders reproduce the service's rows from the same findings.
 *
 * ## Conventions
 *
 * - One harness per file, booted in `beforeAll` and proven leak-free in
 *   `afterAll`. The `it` blocks of the walk share one session and run in
 *   order, each well inside the project's 30 s `testTimeout`. The one
 *   exception is the classified-question suite at the end, which boots a
 *   second harness of its own because its Stage 1 must classify the question,
 *   and the walk's recorder must stay a pass-through.
 * - Statuses, stages, progress statuses and cleanup statuses are read from
 *   protocol's tuples through {@link vocabularyOf}; a name that is not in the
 *   tuple is a compile error rather than a silently wrong literal.
 * - Nothing instruments the project by hand: the plan stage installs through
 *   the real installer and `POST /sessions/:id/end` removes it through the real
 *   cleanup. Every project copy is snapshotted before its session and compared
 *   byte for byte after it (AAP §0.5.1).
 * - Questions are generic and name nothing in the corpus (AAP §0.5.4); corpus
 *   names appear only as *expected outputs* of code analysis.
 * - No credential literal appears here: every token is minted by the harness.
 */

import { homedir } from 'node:os';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DORMANT_AGENT_HOOK_CONFIG,
  problemUnderstandingSchema,
  telemetryKindsForSignal,
} from '@debuggen/instrumentation';
import type { ProblemUnderstanding } from '@debuggen/instrumentation';
import { createDeterministicProvider } from '@debuggen/model-provider';
import type { ModelProvider } from '@debuggen/model-provider';
import { validatePanelSpec } from '@debuggen/panel-schema';
import {
  CLEANUP_STATUSES,
  CONFIDENCE_LEVELS,
  HTTP_ROUTES,
  METRIC_IDS,
  MODIFICATION_STATUSES,
  PROGRESS_STAGES,
  PROGRESS_STATUSES,
  SESSION_STATUSES,
  TELEMETRY_TIERS,
  isMessageOfType,
  parseAnalysisResult,
  parseHttpResponse,
  parseSessionRecord,
} from '@debuggen/protocol';
import type {
  AnalysisResult,
  CaptureSummary,
  DataQuery,
  HttpOperationId,
  MessageType,
  PanelSpec,
  ProgressStage,
  ProtocolMessage,
  SessionProgressPayload,
  SessionRecord,
  SessionStatus,
  TelemetryEventIngress,
  TraceNode,
} from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  isErr,
  newEventId,
  newProducerId,
  newSpanId,
  newTraceId,
  ok,
} from '@debuggen/shared';

import { LOG_ERROR_FIELD_KEY } from '../../src/logging.js';
import { PIPELINE_STAGE_ORDER } from '../../src/pipeline/orchestrator.js';
import { MAX_SUMMARY_EVENTS, SUMMARY_PAGE_SIZE } from '../../src/pipeline/stages/capture.js';
import { createSessionManager } from '../../src/sessions/manager.js';
import type { SessionBroadcaster } from '../../src/sessions/manager.js';
import {
  CANCELLATION_COPY_BY_CAUSE,
  CAPTURE_SIGNAL_LABELS,
  FAILURE_COPY_BY_CODE,
  INSTRUMENTATION_ROW_ORDER,
  MAX_FINDING_ROWS_PER_STAGE,
  PROGRESS_STAGE_GROUPS,
  PROGRESS_STAGE_TITLES,
  READY_TO_CAPTURE_MESSAGE,
  STAGE_FAILURE_DIAGNOSTIC_MESSAGE,
  STAGE_FAILURE_LOG_MESSAGE,
  buildInstrumentationRows,
  buildInvestigationRows,
  buildStageCancelledRow,
  createSessionProgress,
} from '../../src/sessions/progress.js';
import type { ProgressRow } from '../../src/sessions/progress.js';
import { MAX_REPLAYED_PROGRESS_ROWS, REPLAY_MESSAGE_ORDER } from '../../src/sessions/reopen.js';
import { allowedTransitions, statusForStage } from '../../src/sessions/state-machine.js';
import type { ProgressEntry } from '../../src/store/sessions-repo.js';

import {
  DEFAULT_FIXTURE_PROJECT,
  HARNESS_TIMEOUTS,
  PROMPTS_DIR,
  assertTreeUnchanged,
  createScriptedProvider,
  diffTreeSnapshots,
  fixturePath,
  readFixtureJson,
  readTelemetryBatch,
  snapshotTree,
  startHarness,
  waitFor,
} from './harness.js';
import type {
  DevtoolsConnection,
  FixtureProjectCopy,
  Harness,
  HarnessMessage,
  HarnessWsClient,
  ScriptedProvider,
  TreeSnapshot,
} from './harness.js';

/* -------------------------------------------------------------------------------------------------
 * Vocabularies, read from protocol's tuples
 * ---------------------------------------------------------------------------------------------- */

/** A closed vocabulary as a name → name map, so a property access is checked against the tuple. */
type Vocabulary<T extends string> = { readonly [K in T]: K };

/** Builds a {@link Vocabulary} from one of protocol's `as const` tuples. */
function vocabularyOf<const T extends string>(values: readonly T[]): Vocabulary<T> {
  return Object.freeze(Object.fromEntries(values.map((value) => [value, value]))) as Vocabulary<T>;
}

/** The eleven session statuses. */
const STATUS = vocabularyOf(SESSION_STATUSES);

/** The nine progress stages. */
const STAGE = vocabularyOf(PROGRESS_STAGES);

/** The three progress row statuses: `running`, `done`, `failed`. */
const ROW = vocabularyOf(PROGRESS_STATUSES);

/** The four cleanup verdicts. */
const CLEANUP = vocabularyOf(CLEANUP_STATUSES);

/** The five states of a recorded file modification. */
const MODIFICATION = vocabularyOf(MODIFICATION_STATUSES);

/** The three telemetry tiers. */
const TIER = vocabularyOf(TELEMETRY_TIERS);

/**
 * Every capture signal. `CAPTURE_SIGNAL_LABELS` is declared
 * `satisfies Record<CaptureSignal, string>`, so its keys are exactly the
 * instrumentation package's `CAPTURE_SIGNALS` — the compiler holds the two equal.
 */
const ALL_CAPTURE_SIGNALS = Object.freeze(
  Object.keys(CAPTURE_SIGNAL_LABELS) as (keyof typeof CAPTURE_SIGNAL_LABELS)[],
);

/** Every label an instrumentation ✓ row may carry: the labels over every signal. */
const SIGNAL_LABELS: ReadonlySet<string> = new Set(
  ALL_CAPTURE_SIGNALS.map((signal) => CAPTURE_SIGNAL_LABELS[signal]),
);

/** The fixed opening of AAP §0.5.5's "Could not enable ‹signal›: ‹reason›. Continuing with: …". */
const DEGRADATION_OPENING = 'Could not enable ';

/* -------------------------------------------------------------------------------------------------
 * Suite constants
 * ---------------------------------------------------------------------------------------------- */

/** The developer's question: generic, naming nothing in the corpus (AAP §0.5.4). */
const QUESTION = 'Why is this interaction slow?';

/** The same question in other words — the only input that differs for the wording check. */
const REWORDED_QUESTION = 'What makes this interaction take so long?';

/** The inspected Chrome tab the DevTools client speaks for. */
const TAB_ID = 4_101;

/** The page-agent document the relayed `agent.ready` reports. */
const AGENT_DOCUMENT_ID = 'doc_lifecycle000000001';

/** The telemetry batch ingested through both producers. */
const CROSS_TIER_BATCH = 'telemetry-trace-cross-tier.json';

/** Its expected correlated trace, owned by the panel-data suite and reused as a cross-check. */
const EXPECTED_TRACE_FIXTURE = 'panel-data-expected-trace-tree.json';

/**
 * AAP §0.5.5, "Capture yielded nothing": the developer-facing sentence, quoted
 * from the specification rather than from the implementation it tests.
 */
const EMPTY_CAPTURE_MESSAGE =
  'No telemetry was captured. Interact with the page while capture is running, then Capture again.';

/** The route operations the walk drives, each named by its method and pattern in a title. */
const WALK_OPERATIONS = Object.freeze([
  'devServer.launch',
  'session.create',
  'capture.start',
  'telemetry.event',
  'capture.stop',
  'panel.data',
  'session.get',
  'session.list',
  'modifications.list',
  'session.end',
] as const satisfies readonly HttpOperationId[]);

/** `METHOD /pattern` of one route, read from protocol's route table. */
function route(operation: (typeof WALK_OPERATIONS)[number]): string {
  const { method, pattern } = HTTP_ROUTES[operation];
  return `${method} ${pattern}`;
}

/** The part of `panel-data-expected-trace-tree.json` this suite reads. */
interface ExpectedTraceTree {
  readonly traceId: string;
  readonly query: DataQuery;
  readonly expectedNodeCount: number;
  readonly expectedRootSpanId: string;
  readonly expectedPreOrderSpanIds: readonly string[];
}

/** One stage's entry of `prompts/manifest.json`. */
interface ManifestStage {
  readonly current: string;
  readonly available: readonly string[];
}

/** `prompts/manifest.json`, as this suite reads it. */
interface PromptManifest {
  readonly version: number;
  readonly stages: Readonly<Record<string, ManifestStage>>;
}

/* -------------------------------------------------------------------------------------------------
 * Transcript helpers — read what a client received, never what the store says it sent
 * ---------------------------------------------------------------------------------------------- */

/** A received `session.progress` frame. */
type ProgressFrame = HarnessMessage<'session.progress'>;

/** Whether a received frame is `type` and concerns `sessionId` (by envelope or payload). */
function concerns<K extends MessageType>(
  message: ProtocolMessage,
  type: K,
  sessionId: string,
): message is HarnessMessage<K> {
  if (!isMessageOfType(message, type)) {
    return false;
  }
  if (message.sessionId === sessionId) {
    return true;
  }
  const payload: unknown = message.payload;
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const direct = (payload as { readonly sessionId?: unknown }).sessionId;
  const nested = (payload as { readonly session?: { readonly id?: unknown } }).session?.id;
  return direct === sessionId || nested === sessionId;
}

/** Every frame of `type` a client received for `sessionId`, from transcript index `from`. */
function framesOf<K extends MessageType>(
  client: HarnessWsClient,
  type: K,
  sessionId: string,
  from = 0,
): HarnessMessage<K>[] {
  return client.received
    .slice(from)
    .filter((message): message is HarnessMessage<K> => concerns(message, type, sessionId));
}

/** The transcript index of the first frame of `type` for `sessionId` satisfying `predicate`. */
function indexOfFrame<K extends MessageType>(
  client: HarnessWsClient,
  type: K,
  sessionId: string,
  predicate: (message: HarnessMessage<K>) => boolean = () => true,
): number {
  return client.received.findIndex(
    (message) => concerns(message, type, sessionId) && predicate(message),
  );
}

/** Waits for a `session.updated` of `sessionId` whose record satisfies `predicate`. */
function waitForRecord(
  client: HarnessWsClient,
  sessionId: string,
  predicate: (record: SessionRecord) => boolean,
  timeoutMs: number = HARNESS_TIMEOUTS.pipeline,
): Promise<HarnessMessage<'session.updated'>> {
  return waitFor(
    client,
    'session.updated',
    (message) => message.payload.session.id === sessionId && predicate(message.payload.session),
    timeoutMs,
  );
}

/** Waits for a frame of `type` about `sessionId` that arrived at transcript index `from` or later. */
function waitForFrame<K extends MessageType>(
  client: HarnessWsClient,
  type: K,
  sessionId: string,
  from = 0,
  timeoutMs: number = HARNESS_TIMEOUTS.pipeline,
): Promise<HarnessMessage<K>> {
  return waitFor(
    client,
    type,
    (message, index) => index >= from && concerns(message, type, sessionId),
    timeoutMs,
  );
}

/** A progress payload as the row the builders produce: stage, status, message, detail. */
function rowOf(payload: SessionProgressPayload): ProgressRow {
  return payload.detail === undefined
    ? { stage: payload.stage, status: payload.status, message: payload.message }
    : {
        stage: payload.stage,
        status: payload.status,
        message: payload.message,
        detail: payload.detail,
      };
}

/**
 * A stored `session_progress` entry as the same row shape. The store types `stage` as text and
 * parses `detail` back from JSON as `unknown`, so the values stay `unknown` and the comparison
 * against the live rows is what proves they are the same strings.
 */
function storedRowOf(entry: ProgressEntry): Readonly<Record<string, unknown>> {
  return entry.detail === undefined
    ? { stage: entry.stage, status: entry.status, message: entry.message }
    : { stage: entry.stage, status: entry.status, message: entry.message, detail: entry.detail };
}

/** The rows a client received for `sessionId`, in arrival order. */
function progressRows(client: HarnessWsClient, sessionId: string, from = 0): ProgressRow[] {
  return framesOf(client, 'session.progress', sessionId, from).map((frame) => rowOf(frame.payload));
}

/**
 * The statuses a client saw a session hold, in order, from `session.created`
 * and every `session.updated` — consecutive repeats collapsed, because a
 * record that changed without changing status is not a transition.
 */
function statusTrail(client: HarnessWsClient, sessionId: string): SessionStatus[] {
  const trail: SessionStatus[] = [];
  for (const message of client.received) {
    let status: SessionStatus | undefined;
    if (concerns(message, 'session.created', sessionId)) {
      status = message.payload.session.status;
    } else if (concerns(message, 'session.updated', sessionId)) {
      status = message.payload.session.status;
    }
    if (status !== undefined && trail.at(-1) !== status) {
      trail.push(status);
    }
  }
  return trail;
}

/** A stable identity for one progress frame: its stored timestamp plus its row. */
function frameKey(frame: ProgressFrame): string {
  return JSON.stringify([frame.ts, rowOf(frame.payload)]);
}

/**
 * The finding rows of a stage: every row of the Step-8 group the stage reports
 * in ({@link PROGRESS_STAGE_GROUPS}) except the group's header and closing
 * title rows, and — for the instrumentation group — except the "Ready to
 * capture" row, which is the readiness gate's, not a finding.
 */
function findingRows(rows: readonly ProgressRow[], stage: ProgressStage): ProgressRow[] {
  const group = PROGRESS_STAGE_GROUPS[stage];
  const title: string = PROGRESS_STAGE_TITLES[group];
  return rows.filter(
    (row) =>
      row.stage === group &&
      row.message !== title &&
      row.message !== READY_TO_CAPTURE_MESSAGE &&
      row.status !== ROW.running,
  );
}

/** The Step-8 groups the pipeline's stages report in, each once, in pipeline order. */
const PIPELINE_GROUP_ORDER: readonly ProgressStage[] = Object.freeze([
  ...new Set(PIPELINE_STAGE_ORDER.map((stage) => PROGRESS_STAGE_GROUPS[stage])),
]);

/** A sequence with each run of equal consecutive entries collapsed onto its first. */
function collapseRepeats<T>(values: readonly T[]): T[] {
  return values.filter((value, index) => index === 0 || values[index - 1] !== value);
}

/**
 * Asserts one group's header rows: the group opens with its title as a
 * `running` row, every pipeline stage of the group re-opens that same header
 * once as it starts — and no other `running` row appears — and the group
 * closes settled.
 */
function expectGroupHeaders(rows: readonly ProgressRow[], group: ProgressStage): void {
  const title: string = PROGRESS_STAGE_TITLES[group];
  const ofGroup = rows.filter((row) => row.stage === group);
  expect(ofGroup[0]).toEqual({ stage: group, status: ROW.running, message: title });
  const members = PIPELINE_STAGE_ORDER.filter((stage) => PROGRESS_STAGE_GROUPS[stage] === group);
  expect(
    ofGroup.filter((row) => row.status === ROW.running).map((row) => row.message),
    `${group}'s header, once per stage reporting in it`,
  ).toEqual(members.map(() => title));
  expect([ROW.done, ROW.failed]).toContain(ofGroup.at(-1)?.status);
}

/**
 * The route path a Next.js App Router file serves: `app/page.tsx` → `/`,
 * `app/api/<segments>/route.ts` → `/api/<segments>`. Route groups (`(name)`)
 * add no segment. `undefined` for a file that is not a route or a page.
 */
function routePathOfFile(file: string): string | undefined {
  const match = /^app((?:\/[^/]+)*)\/(?:route\.ts|page\.tsx)$/u.exec(file);
  if (match === null) {
    return undefined;
  }
  const segments = (match[1] ?? '')
    .split('/')
    .filter((segment) => segment.length > 0 && !/^\(.*\)$/u.test(segment));
  return `/${segments.join('/')}`;
}

/** Depth-first pre-order span ids of a correlated trace. */
function preOrderSpanIds(nodes: readonly TraceNode[]): string[] {
  return nodes.flatMap((node) => [node.event.spanId, ...preOrderSpanIds(node.children)]);
}

/** Every `.ts`/`.tsx` source file under `root`, as root-relative POSIX paths. */
async function sourceFilesOf(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true });
  return entries
    .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .map((entry) => entry.split(sep).join('/'))
    .sort();
}

/**
 * Renames one API route of a project copy the way a developer would: moves its
 * directory and rewrites every source reference to its path.
 *
 * @returns The new route path.
 */
async function renameRoute(root: string, routeFile: string, oldPath: string): Promise<string> {
  const newPath = `${oldPath}-renamed`;
  const oldDirectory = routeFile.slice(0, routeFile.lastIndexOf('/'));
  const newDirectory = `${oldDirectory}-renamed`;
  await rename(join(root, oldDirectory), join(root, newDirectory));
  for (const file of await sourceFilesOf(root)) {
    const absolute = join(root, file);
    const text = await readFile(absolute, 'utf8');
    if (text.includes(oldPath)) {
      await writeFile(absolute, text.split(oldPath).join(newPath));
    }
  }
  return newPath;
}

/* -------------------------------------------------------------------------------------------------
 * The suite
 * ---------------------------------------------------------------------------------------------- */

let harness: Harness;

/** The pass-through recorder in front of the deterministic provider: every model call, in order. */
let recorder: ScriptedProvider;

beforeAll(async () => {
  recorder = createScriptedProvider([], { id: 'deterministic' });
  harness = await startHarness({ provider: recorder.provider });
});

afterAll(async () => {
  await harness.assertNoLeaks();
});

describe('a debugging session, walked end to end through the real routes and pushes', () => {
  /** The instrumented copy of the corpus; its root is the session's `projectRoot`. */
  let project: FixtureProjectCopy;
  /** The copy's bytes immediately before the session was created. */
  let preSessionSnapshot: TreeSnapshot;
  /** The origin of the stand-in dev server the real launcher started for the copy. */
  let devServerOrigin: string;
  /** The editor client announcing the copy's root. */
  let vscode: HarnessWsClient;
  /** The DevTools client of the inspected tab, and the credential it presented. */
  let devtools: DevtoolsConnection;
  /** The session as `POST /sessions` answered it. */
  let session: SessionRecord;
  /** Every progress row the editor had received by then. */
  let readyRows: ProgressRow[];
  /** The investigation finding rows the editor received. */
  let investigationRows: ProgressRow[];
  /** The capture that yielded nothing, and the capture that carried the cross-tier trace. */
  let emptyCaptureId: string;
  let captureId: string;
  /** The summary `POST /sessions/:id/capture/stop` answered for the real capture. */
  let summary: CaptureSummary;
  /** The artifacts the live pushes carried. */
  let liveAnalysis: AnalysisResult;
  let livePanel: PanelSpec;
  /** The instrumentation rows and report of a session whose tab was never bound. */
  let unboundInstrumentRows: ProgressRow[];
  let unboundUnavailable: HarnessMessage<'instrumentation.ready'>['payload']['unavailable'];

  /**
   * A pure read of the session through the DevTools credential, with the read
   * proof pairing issued with it, as the extension reads: no replay is broadcast.
   */
  async function readSession(): Promise<SessionRecord> {
    const read = await harness
      .http(devtools.credential.token, { origin: devtools.credential.origin })
      .request('session.get', {
        params: { id: session.id },
        tabId: TAB_ID,
        readProof: devtools.credential.readProof,
      });
    if (isErr(read)) {
      throw new Error(`session.get was refused (${read.error.code}): ${read.error.message}`);
    }
    return read.value;
  }

  it(`${route('session.create')} answers a created SessionRecord for a generic question`, async () => {
    project = harness.requireProject();
    preSessionSnapshot = await snapshotTree(project.root);
    expect(diffTreeSnapshots(project.snapshot, preSessionSnapshot)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });

    const launched = await harness.launchDevServer(project.root);
    if (isErr(launched)) {
      throw new Error(`the dev server did not launch (${launched.error.code})`);
    }
    devServerOrigin = new URL(launched.value.devServerUrl).origin;

    vscode = await harness.editor(project.root);
    devtools = await harness.connectDevtools({ tabId: TAB_ID });

    // The page agent's report, relayed on the tab's DevTools connection as the
    // Chrome service worker relays it after every document load.
    const report = devtools.client.send('agent.ready', {
      tabId: TAB_ID,
      documentId: AGENT_DOCUMENT_ID,
      producerId: readTelemetryBatch(CROSS_TIER_BATCH).find((event) => event.tier === TIER.browser)!
        .producerId,
      url: `${devServerOrigin}/`,
      installedBeforeReact: true,
      reactDetected: true,
    });
    expect(await devtools.client.flush()).toBe(true);
    expect(devtools.client.errorsFor(report.id)).toEqual([]);

    session = await harness.createSession({ projectRoot: project.root, question: QUESTION });

    const parsed = parseSessionRecord(session);
    expect(parsed.ok).toBe(true);
    expect(session.status).toBe(STATUS.created);
    expect(session.projectRoot).toBe(project.root);
    expect(session.question).toBe(QUESTION);
    expect(new URL(session.devServerUrl).origin).toBe(devServerOrigin);
    expect(session.provider.id).toBe(harness.config.provider);
    expect(session.relevantFiles).toEqual([]);
    expect(session.plans).toEqual([]);
    expect(session.modifications).toEqual([]);
    expect(session.captures).toEqual([]);
    expect(session.analyses).toEqual([]);
    expect(session.panelIds).toEqual([]);
    expect(session.cleanup).toEqual({ status: CLEANUP.pending, conflicts: [] });

    const bound = await harness.bindTab(devtools.client, {
      tabId: TAB_ID,
      url: `${devServerOrigin}/`,
      origin: devServerOrigin,
      sessionId: session.id,
    });
    if (isErr(bound)) {
      throw new Error(`session.bind was refused (${bound.error.code}): ${bound.error.message}`);
    }
    expect(bound.value.payload).toMatchObject({ sessionId: session.id, tabId: TAB_ID });

    const created = await waitForFrame(vscode, 'session.created', session.id);
    expect(created.payload.session.id).toBe(session.id);
    expect(created.payload.session.status).toBe(STATUS.created);
  });

  it('streams the pipeline’s own progress rows to both clients until the session is ready', async () => {
    await waitForRecord(
      vscode,
      session.id,
      (record) => record.status === STATUS.ready && record.promptVersions.plan !== undefined,
    );
    expect(await vscode.flush()).toBe(true);
    expect(await devtools.client.flush()).toBe(true);

    const frames = framesOf(vscode, 'session.progress', session.id);
    const rows = frames.map((frame) => rowOf(frame.payload));
    expect(rows.length).toBeGreaterThan(0);

    // Every stage is protocol's, and each reported inside its Step-8 group: the investigation
    // within "Understanding problem", planning within "Preparing instrumentation". The groups
    // ran in the pipeline's order, each as one run of rows.
    const stages = [...new Set(rows.map((row) => row.stage))];
    for (const stage of stages) {
      expect(PROGRESS_STAGES).toContain(stage);
    }
    expect(stages).toEqual(PIPELINE_GROUP_ORDER.slice(0, stages.length));
    expect(collapseRepeats(rows.map((row) => row.stage))).toEqual(stages);
    expect(stages).toEqual([STAGE.understand, STAGE.instrument]);

    // Each group opens with its header, re-opened by each stage reporting in it, and closes
    // with `done`; nothing failed.
    for (const stage of stages) {
      expectGroupHeaders(rows, stage);
    }
    expect(rows.filter((row) => row.status === ROW.failed)).toEqual([]);

    // The live rows are exactly the persisted progress log, time stamps included.
    const stored = harness.repos.sessions.listProgress(session.id);
    if (isErr(stored)) {
      throw new Error(`listProgress failed (${stored.error.code})`);
    }
    expect(stored.value.map((entry) => storedRowOf(entry))).toEqual(rows);
    expect(stored.value.map((entry) => entry.ts)).toEqual(frames.map((frame) => frame.ts));

    // The DevTools client holds every row too: replayed on bind, live after it.
    const devtoolsKeys = new Set(
      framesOf(devtools.client, 'session.progress', session.id).map(frameKey),
    );
    expect(devtoolsKeys).toEqual(new Set(frames.map(frameKey)));

    // The status choreography, each edge one the state machine's table admits.
    const trail = statusTrail(vscode, session.id);
    expect(trail).toEqual([
      STATUS.created,
      STATUS.understanding,
      STATUS.investigating,
      STATUS.planning,
      STATUS.instrumenting,
      STATUS.ready,
    ]);
    trail.slice(1).forEach((to, index) => {
      expect(allowedTransitions(trail[index]!)).toContain(to);
    });

    readyRows = rows;
    investigationRows = findingRows(rows, STAGE.investigate);
  });

  it('builds the investigation rows from the code graph of the copied corpus, not from the question', async () => {
    const record = await readSession();
    const corpus = await sourceFilesOf(project.root);

    // The database row's wording is the builder's own (it is not exported), so read it back from
    // the builder rather than restating it; its detail is call-site text this test cannot know.
    const [databaseRow] = buildInvestigationRows({ databaseDependencies: ['query'] });
    expect(databaseRow).toMatchObject({
      stage: PROGRESS_STAGE_GROUPS[STAGE.investigate],
      status: ROW.done,
    });

    // There are findings, within the bound, and every one points into the corpus.
    expect(investigationRows.length).toBeGreaterThan(0);
    expect(investigationRows.length).toBeLessThanOrEqual(MAX_FINDING_ROWS_PER_STAGE);
    for (const row of investigationRows) {
      expect(row.status).toBe(ROW.done);
      expect(row.message).toMatch(/^(?:Found|Traced) \S/u);
      // The two class rows carry their evidence in the detail (`‹names› · ‹files›`), whose file
      // part names every corpus file holding one of the class's findings.
      const classFiles = (): readonly string[] => {
        const files = row.detail?.split(' · ').at(-1)?.split(', ') ?? [];
        expect(files.length).toBeGreaterThan(0);
        return files;
      };
      if (row.message.startsWith('Traced')) {
        // The one event-handler row: the Step-8 label verbatim.
        expect(row.message).toBe('Traced event handler');
        for (const file of classFiles()) {
          expect(corpus).toContain(file);
        }
        continue;
      }
      if (row.message === databaseRow?.message) {
        // The one database row: its call sites, then their files.
        for (const file of classFiles()) {
          expect(corpus).toContain(file);
        }
        continue;
      }
      expect(corpus).toContain(row.detail);
      const path = /^Found (\/\S*)$/u.exec(row.message)?.[1];
      if (path !== undefined) {
        // A route row names exactly the path its origin file serves.
        expect(routePathOfFile(row.detail ?? '')).toBe(path);
      }
    }

    // What the code graph resolved in this corpus — expected outputs, never inputs.
    // Listed under "Understanding problem", the group the investigation reports in.
    expect(investigationRows).toContainEqual({
      stage: PROGRESS_STAGE_GROUPS[STAGE.investigate],
      status: ROW.done,
      message: 'Found /api/trail-report',
      detail: 'app/api/trail-report/route.ts',
    });
    const relevant = record.relevantFiles.map((entry) => entry.file);
    expect(relevant.length).toBeGreaterThan(0);
    for (const file of relevant) {
      expect(corpus).toContain(file);
    }
    expect(relevant).toContain('app/api/trail-report/route.ts');
    expect(relevant).toContain('src/server/services/trail-report.service.ts');
    expect(relevant.some((file) => /^src\/components\/Trail[A-Za-z]*\.tsx$/u.test(file))).toBe(
      true,
    );

    // No finding row carries a word of the question.
    const questionWords = QUESTION.toLowerCase()
      .split(/[^a-z]+/u)
      .filter((word) => word.length >= 4);
    expect(questionWords.length).toBeGreaterThan(0);
    for (const row of investigationRows) {
      for (const word of questionWords) {
        expect(`${row.message} ${row.detail ?? ''}`.toLowerCase()).not.toContain(word);
      }
    }

    // The pure builder reproduces the service's rows from the same findings, and
    // renders nothing it was not handed.
    const routes = investigationRows.flatMap((row) => {
      const path = /^Found (\/\S*)$/u.exec(row.message)?.[1];
      return path === undefined ? [] : [path];
    });
    const components = investigationRows.flatMap((row) => {
      const name = /^Found ([^/\s]\S*)$/u.exec(row.message)?.[1];
      return name === undefined ? [] : [name];
    });
    const eventHandlers = investigationRows.flatMap((row) =>
      row.message === 'Traced event handler'
        ? (row.detail?.split(' · ')[0]?.split(', ') ?? [])
        : [],
    );
    const rebuiltFrom = (findings: {
      readonly components: readonly string[];
      readonly eventHandlers: readonly string[];
      readonly routes: readonly string[];
    }): readonly ProgressRow[] =>
      buildInvestigationRows({
        ...findings,
        databaseDependencies: [],
        relevantFiles: record.relevantFiles,
      });
    // The rebuild renders no database row: its call sites are text it cannot know.
    const withoutDatabaseRow = investigationRows.filter(
      (row) => row.message !== databaseRow?.message,
    );
    expect(rebuiltFrom({ components, eventHandlers, routes })).toEqual(withoutDatabaseRow);

    const [firstRoute, ...otherRoutes] = routes;
    expect(firstRoute).toBeDefined();
    expect(rebuiltFrom({ components, eventHandlers, routes: otherRoutes })).toEqual(
      withoutDatabaseRow.filter((row) => row.message !== `Found ${firstRoute ?? ''}`),
    );
    expect(buildInvestigationRows({})).toEqual([]);

    const overflowing = Array.from(
      { length: MAX_FINDING_ROWS_PER_STAGE + 3 },
      (_, index) => `${firstRoute ?? '/'}#${String(index)}`,
    );
    const bounded = buildInvestigationRows({ components: overflowing });
    expect(bounded).toHaveLength(MAX_FINDING_ROWS_PER_STAGE);
    const hidden = overflowing.length - (MAX_FINDING_ROWS_PER_STAGE - 1);
    expect(bounded.at(-1)?.message).toBe(`+${String(hidden)} more`);
  });

  it('keeps the rows when only the wording changes, and follows a renamed route in another copy', async () => {
    /** Runs a session on `copy` until its plan is installed, returning its rows; then ends it. */
    const runUntilInstalled = async (
      copy: FixtureProjectCopy,
      question: string,
    ): Promise<{
      readonly rows: ProgressRow[];
      readonly ready: HarnessMessage<'instrumentation.ready'>;
    }> => {
      const before = await snapshotTree(copy.root);
      const launched = await harness.launchDevServer(copy.root);
      if (isErr(launched)) {
        throw new Error(`the dev server did not launch (${launched.error.code})`);
      }
      const editor = await harness.editor(copy.root);
      const created = await harness.createSession({ projectRoot: copy.root, question });
      const ready = await waitForFrame(editor, 'instrumentation.ready', created.id);
      expect(await editor.flush()).toBe(true);
      const rows = progressRows(editor, created.id);

      const ended = await harness.endSession(created.id);
      if (isErr(ended)) {
        throw new Error(`session.end was refused (${ended.error.code})`);
      }
      expect(ended.value.cleanup).toBe(CLEANUP.clean);
      await assertTreeUnchanged(copy.root, before);
      return { rows, ready };
    };

    // The same corpus, the same bytes, other words.
    const reworded = await runUntilInstalled(await harness.copyFixtureProject(), REWORDED_QUESTION);
    expect(findingRows(reworded.rows, STAGE.investigate)).toEqual(investigationRows);

    // Another copy in which one route was renamed the way a developer renames it.
    const routeRow = investigationRows.find((row) =>
      /^app\/api\/.+\/route\.ts$/u.test(row.detail ?? ''),
    );
    expect(routeRow).toBeDefined();
    const routeFile = routeRow?.detail ?? '';
    const oldPath = routeRow?.message.slice('Found '.length) ?? '';
    const renamed = await harness.copyFixtureProject();
    const newPath = await renameRoute(renamed.root, routeFile, oldPath);
    const renamedRun = await runUntilInstalled(renamed, QUESTION);

    const renamedRows = findingRows(renamedRun.rows, STAGE.investigate);
    const routeDirectory = routeFile.slice(0, routeFile.lastIndexOf('/'));
    const routeBasename = routeFile.slice(routeDirectory.length);
    expect(renamedRows).toEqual(
      investigationRows.map((row) =>
        row === routeRow
          ? {
              ...row,
              message: `Found ${newPath}`,
              detail: `${routeDirectory}-renamed${routeBasename}`,
            }
          : row,
      ),
    );
    expect(renamedRows.map((row) => row.message)).not.toContain(`Found ${oldPath}`);

    // The copy whose tab was never bound is the source of real "could not
    // enable" reports for the instrumentation-row checks below.
    unboundInstrumentRows = renamedRun.rows.filter((row) => row.stage === STAGE.instrument);
    unboundUnavailable = renamedRun.ready.payload.unavailable;
  });

  it('arms the plan through the real installer and reports what it armed, closing with Ready to capture', async () => {
    // Both user interfaces were told about the plan and about what came of it.
    for (const client of [vscode, devtools.client]) {
      expect(framesOf(client, 'instrumentation.plan', session.id)).toHaveLength(1);
      expect(framesOf(client, 'instrumentation.ready', session.id)).toHaveLength(1);
    }
    const { plan } = framesOf(vscode, 'instrumentation.plan', session.id)[0]!.payload;
    const report = framesOf(vscode, 'instrumentation.ready', session.id)[0]!.payload;
    expect(plan.sessionId).toBe(session.id);
    expect(plan.planVersion).toBe(1);
    expect(plan.instrumentationTargets.length).toBeGreaterThan(0);
    expect(Array.isArray(report.applied)).toBe(true);
    expect(Array.isArray(report.runtimeHooks)).toBe(true);
    expect(Array.isArray(report.unavailable)).toBe(true);

    // Every modification went in through the installer, recorded before it was written.
    const corpus = await sourceFilesOf(project.root);
    expect(report.applied.length).toBeGreaterThan(0);
    for (const record of report.applied) {
      expect(record.sessionId).toBe(session.id);
      expect(record.planVersion).toBe(plan.planVersion);
      expect(record.status).toBe(MODIFICATION.applied);
      expect(corpus).toContain(record.file);
      expect(record.originalHash).toBe(preSessionSnapshot.get(record.file));
      expect(record.instrumentedHash).not.toBe(record.originalHash);
    }
    const appliedFiles = [...new Set(report.applied.map((record) => record.file))].sort();
    for (const action of plan.instrumentationTargets.filter((target) => target.mode === 'patch')) {
      expect(appliedFiles).toContain(action.file);
    }

    // The working tree differs from its pre-session bytes on exactly those files.
    const instrumented = diffTreeSnapshots(preSessionSnapshot, await snapshotTree(project.root));
    expect(instrumented).toEqual({ added: [], removed: [], changed: appliedFiles });

    // The instrumentation rows: labels over the capture signals, bounded, closed by readiness.
    const instrumentRows = readyRows.filter((row) => row.stage === STAGE.instrument);
    expect(instrumentRows.at(-1)).toEqual({
      stage: STAGE.instrument,
      status: ROW.done,
      message: READY_TO_CAPTURE_MESSAGE,
    });
    const findings = findingRows(readyRows, STAGE.instrument);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.length).toBeLessThanOrEqual(MAX_FINDING_ROWS_PER_STAGE);
    const enabled = findings.filter((row) => row.status === ROW.done).map((row) => row.message);
    for (const label of enabled) {
      expect(SIGNAL_LABELS.has(label)).toBe(true);
    }
    expect(new Set(enabled).size).toBe(enabled.length);
    expect(enabled).toEqual(INSTRUMENTATION_ROW_ORDER.filter((label) => enabled.includes(label)));
    // Every "could not enable" row is terminal and names, after "Continuing
    // with:", exactly the ✓ labels the service showed — so the builder given
    // those labels and the service's own report renders the same ✗ rows.
    expect(
      instrumentRows.filter(
        (row) => row.message.startsWith(DEGRADATION_OPENING) && row.status !== ROW.failed,
      ),
    ).toEqual([]);
    expect(findings.filter((row) => row.status === ROW.failed)).toEqual(
      buildInstrumentationRows({
        runtimeHooks: enabled,
        unavailable: report.unavailable,
      }).filter((row) => row.status === ROW.failed),
    );

    // The pure builder, over real reports. The copy whose tab was never bound
    // still lists its page gaps in its report, and the builder renders them as
    // "could not enable" rows; but the service shows a page signal that waits
    // for a tab as waiting — one row per label, which its ✓ row replaces once
    // the page reports — never as ✗ (AAP §0.5.5, §0.7.1). Its ✗ rows are
    // exactly the builder's rows for its other gaps, over the ✓ labels that
    // copy showed, and every one of them is terminal.
    expect(unboundUnavailable.length).toBeGreaterThan(0);
    const pageSignals = new Set<string>(Object.keys(DORMANT_AGENT_HOOK_CONFIG));
    const pageGaps = unboundUnavailable.filter((gap) => pageSignals.has(gap.signal));
    expect(pageGaps.length).toBeGreaterThan(0);
    expect(
      buildInstrumentationRows({ signals: ALL_CAPTURE_SIGNALS, unavailable: pageGaps }).filter(
        (row) => row.status === ROW.failed,
      ).length,
    ).toBeGreaterThan(0);
    const unboundChecked = unboundInstrumentRows
      .filter((row) => row.status === ROW.done && SIGNAL_LABELS.has(row.message))
      .map((row) => row.message);
    expect(unboundInstrumentRows.filter((row) => row.status === ROW.failed)).toEqual(
      buildInstrumentationRows({
        runtimeHooks: unboundChecked,
        unavailable: unboundUnavailable.filter((gap) => !pageSignals.has(gap.signal)),
      }).filter((row) => row.status === ROW.failed),
    );
    expect(
      unboundInstrumentRows.filter(
        (row) => row.message.startsWith(DEGRADATION_OPENING) && row.status !== ROW.failed,
      ),
    ).toEqual([]);
    const pageLabels = [
      ...new Set(
        ALL_CAPTURE_SIGNALS.filter((signal) => pageGaps.some((gap) => gap.signal === signal)).map(
          (signal) => CAPTURE_SIGNAL_LABELS[signal],
        ),
      ),
    ];
    const waitingLabels = unboundInstrumentRows
      .filter((row) => row.status === ROW.running && SIGNAL_LABELS.has(row.message))
      .map((row) => row.message);
    // Every page gap waits, once per label — beside the readiness gate's
    // waiting rows for the page hooks the install armed pending a tab (an
    // unbound session's plan is not refused for the tab it has yet to bind),
    // which are page labels too.
    expect(waitingLabels).toEqual(expect.arrayContaining(pageLabels));
    expect(new Set(waitingLabels).size).toBe(waitingLabels.length);
    const pageSignalLabels = new Set<string>(
      ALL_CAPTURE_SIGNALS.filter((signal) => pageSignals.has(signal)).map(
        (signal) => CAPTURE_SIGNAL_LABELS[signal],
      ),
    );
    for (const label of waitingLabels) {
      expect(pageSignalLabels.has(label)).toBe(true);
    }
    const everything = buildInstrumentationRows({ signals: ALL_CAPTURE_SIGNALS });
    expect(everything.map((row) => row.message)).toEqual([...INSTRUMENTATION_ROW_ORDER]);
    expect(everything.length).toBeLessThanOrEqual(MAX_FINDING_ROWS_PER_STAGE);
    expect(buildInstrumentationRows({})).toEqual([]);
  });

  it(`an empty capture (${route('capture.start')}, then ${route('capture.stop')}) skips analysis and returns to ready`, async () => {
    const mark = vscode.received.length;
    const started = await harness.startCapture(session.id);
    if (isErr(started)) {
      throw new Error(
        `capture.start was refused (${started.error.code}): ${started.error.message}`,
      );
    }
    emptyCaptureId = started.value.captureId;
    await waitForFrame(vscode, 'capture.started', session.id, mark);

    const stopped = await harness.stopCapture(session.id);
    if (isErr(stopped)) {
      throw new Error(`capture.stop was refused (${stopped.error.code}): ${stopped.error.message}`);
    }
    expect(stopped.value.summary.eventCount).toBe(0);
    await waitForRecord(
      vscode,
      session.id,
      (record) =>
        record.status === STATUS.ready &&
        record.captures.some(
          (capture) => capture.id === emptyCaptureId && capture.stoppedAt !== undefined,
        ),
    );
    const closed = await waitForFrame(vscode, 'capture.stopped', session.id, mark);
    expect(closed.payload.captureId).toBe(emptyCaptureId);
    expect(closed.payload.summary.eventCount).toBe(0);
    expect(await vscode.flush()).toBe(true);

    // The developer is told, in AAP §0.5.5's words, and no analysis ran.
    const rows = progressRows(vscode, session.id, mark);
    expect(rows).toContainEqual({
      stage: STAGE.capture,
      status: ROW.done,
      message: EMPTY_CAPTURE_MESSAGE,
    });
    expect(rows.map((row) => row.stage)).not.toContain(STAGE.analyze);
    expect(rows.map((row) => row.stage)).not.toContain(STAGE['generate-panel']);
    expect(framesOf(vscode, 'analysis.completed', session.id)).toEqual([]);
    expect(framesOf(vscode, 'panel.generated', session.id)).toEqual([]);

    const trail = statusTrail(vscode, session.id);
    expect(trail.slice(-3)).toEqual([STATUS.ready, STATUS.capturing, STATUS.ready]);
    expect(trail).not.toContain(STATUS.analyzing);
    expect(trail).not.toContain(STATUS.generated);

    const record = await readSession();
    expect(record.status).toBe(STATUS.ready);
    expect(record.analyses).toEqual([]);
    expect(record.panelIds).toEqual([]);
    expect(
      record.captures.find((capture) => capture.id === emptyCaptureId)?.summary?.eventCount ?? 0,
    ).toBe(0);
    const analyses = harness.repos.panels.listAnalyses(session.id);
    const panels = harness.repos.panels.listPanels(session.id);
    expect(isErr(analyses) ? undefined : analyses.value).toEqual([]);
    expect(isErr(panels) ? undefined : panels.value).toEqual([]);
  });

  it(`a ${route('capture.stop')} whose status write the store refuses changes nothing: the window stays open, the project owned, its producers armed, and no capture.stopped is sent`, async () => {
    // Its own session on its own copy, so the walk's session, captures and
    // status trail stay exactly as the tests around this one expect them.
    const tabId = TAB_ID + 1;
    const copy = await harness.copyFixtureProject();
    const before = await snapshotTree(copy.root);
    const launched = await harness.launchDevServer(copy.root);
    if (isErr(launched)) {
      throw new Error(`the dev server did not launch (${launched.error.code})`);
    }
    const origin = new URL(launched.value.devServerUrl).origin;
    const editor = await harness.editor(copy.root);
    const created = await harness.createSession({ projectRoot: copy.root, question: QUESTION });
    const tab = await harness.connectDevtools({ tabId });
    const bound = await harness.bindTab(tab.client, {
      tabId,
      url: `${origin}/`,
      origin,
      sessionId: created.id,
    });
    if (isErr(bound)) {
      throw new Error(`session.bind was refused (${bound.error.code}): ${bound.error.message}`);
    }
    const report = tab.client.send('agent.ready', {
      tabId,
      documentId: 'doc_lifecycle000000002',
      producerId: newProducerId(),
      url: `${origin}/`,
      installedBeforeReact: true,
      reactDetected: true,
    });
    expect(await tab.client.flush()).toBe(true);
    expect(tab.client.errorsFor(report.id)).toEqual([]);
    await waitForRecord(editor, created.id, (record) => record.status === STATUS.ready);

    const armMark = tab.client.received.length;
    const started = await harness.startCapture(created.id);
    if (isErr(started)) {
      throw new Error(
        `capture.start was refused (${started.error.code}): ${started.error.message}`,
      );
    }
    const heldCaptureId = started.value.captureId;
    await waitForFrame(editor, 'capture.started', created.id);
    const owner = { sessionId: created.id, captureId: heldCaptureId };
    expect(harness.manager.captureOwnerForProject(copy.root)).toEqual(owner);
    // What the capture armed the tab's page agent with, to compare the re-arm against.
    const armedAtStart = await waitForFrame(tab.client, 'agent.config', created.id, armMark);
    expect(armedAtStart.payload.captureId).toBe(heldCaptureId);
    expect(armedAtStart.payload.hooks).not.toEqual(DORMANT_AGENT_HOOK_CONFIG);
    const mark = editor.received.length;
    const tabMark = tab.client.received.length;

    // The injected failure: a TEMP trigger on the service's own connection that
    // aborts every write moving this session out of `capturing` — the stop's
    // next status and the pipeline's own move to `failed` alike.
    if (!/^[A-Za-z0-9_-]+$/u.test(created.id)) {
      throw new Error('The session id cannot be quoted into a trigger.');
    }
    const trigger = `lifecycle_block_leave_capturing_${created.id.replaceAll('-', '_')}`;
    harness.store.db.exec(
      `CREATE TEMP TRIGGER ${trigger} BEFORE UPDATE OF status ON sessions WHEN OLD.id = '${created.id}' AND OLD.status = 'capturing' AND NEW.status <> 'capturing' BEGIN SELECT RAISE(ABORT, 'session-lifecycle suite: injected status write failure'); END;`,
    );
    try {
      const refused = await harness.stopCapture(created.id);
      if (!isErr(refused)) {
        throw new Error('capture.stop was expected to be refused, but it succeeded.');
      }
      expect(refused.error.code).toBe('STORE_ERROR');

      // The store, the owner index and the transcript all still say "capturing".
      const stored = harness.repos.sessions.get(created.id);
      expect(isErr(stored) ? undefined : stored.value?.status).toBe(STATUS.capturing);
      const active = harness.repos.sessions.getActiveCapture(created.id);
      if (isErr(active)) {
        throw new Error(`the open capture could not be read (${active.error.code})`);
      }
      expect(active.value?.capture.id).toBe(heldCaptureId);
      expect(active.value?.capture.stoppedAt).toBeUndefined();
      expect(active.value?.capture.summary).toBeUndefined();
      expect(harness.manager.captureOwnerForProject(copy.root)).toEqual(owner);
      expect(await editor.flush()).toBe(true);
      expect(framesOf(editor, 'capture.stopped', created.id, mark)).toEqual([]);
      expect(
        framesOf(editor, 'session.updated', created.id, mark).filter(
          (frame) => frame.payload.session.status !== STATUS.capturing,
        ),
      ).toEqual([]);

      // The stop returned the page agent to dormant before the store refused it;
      // the window is still the session's live capture, so the agent is armed
      // again — for the same capture, with the hooks the capture started with.
      const configs = await tab.client.until(
        () => {
          const received = framesOf(tab.client, 'agent.config', created.id, tabMark);
          const last = received.at(-1);
          return last !== undefined &&
            !isDeepStrictEqual(last.payload.hooks, DORMANT_AGENT_HOOK_CONFIG)
            ? received
            : undefined;
        },
        HARNESS_TIMEOUTS.capture,
        () => 'the page agent was not armed again after the refused stop',
      );
      expect(configs.map((frame) => frame.payload.captureId)).toEqual([
        heldCaptureId,
        heldCaptureId,
      ]);
      expect(configs[0]?.payload.hooks).toEqual(DORMANT_AGENT_HOOK_CONFIG);
      expect(configs[1]?.payload.hooks).toEqual(armedAtStart.payload.hooks);

      // What the re-armed agent sends next is evidence of the same, still-open window.
      const traceId = newTraceId();
      const producers = new Map<string, string>();
      const resumed = readTelemetryBatch(CROSS_TIER_BATCH)
        .filter((event) => event.tier === TIER.browser)
        .map((event): TelemetryEventIngress => {
          const producerId = producers.get(event.producerId) ?? newProducerId();
          producers.set(event.producerId, producerId);
          return { ...event, id: newEventId(), traceId, producerId };
        });
      expect(resumed.length).toBeGreaterThan(0);
      const relayed = await harness.ingestFromAgent(tab.client, resumed);
      expect(relayed.sent.ok).toBe(true);
      expect(relayed.settled).toBe(true);
      expect(relayed.errors).toEqual([]);
      const attributed = harness.repos.telemetry.listByCapture(created.id, heldCaptureId);
      if (isErr(attributed)) {
        throw new Error(`listByCapture failed (${attributed.error.code})`);
      }
      expect(
        attributed.value.rows
          .filter((event) => event.traceId === traceId)
          .map((event) => event.id)
          .sort(),
      ).toEqual(resumed.map((event) => event.id).sort());
    } finally {
      harness.store.db.exec(`DROP TRIGGER IF EXISTS temp.${trigger};`);
    }

    // With the store writable again, the same stop succeeds once, completely,
    // and summarises what the window collected after the refusal.
    const stopped = await harness.stopCapture(created.id);
    if (isErr(stopped)) {
      throw new Error(`capture.stop was refused (${stopped.error.code}): ${stopped.error.message}`);
    }
    expect(stopped.value.summary.captureId).toBe(heldCaptureId);
    expect(stopped.value.summary.eventCount).toBeGreaterThan(0);
    await waitForRecord(
      editor,
      created.id,
      (record) =>
        record.status === STATUS.generated &&
        record.captures.some(
          (capture) => capture.id === heldCaptureId && capture.stoppedAt !== undefined,
        ),
    );
    expect(await editor.flush()).toBe(true);
    const closedFrames = framesOf(editor, 'capture.stopped', created.id, mark);
    expect(closedFrames.map((frame) => frame.payload.captureId)).toEqual([heldCaptureId]);
    // `capture.stopped` precedes the `session.updated` that leaves `capturing`.
    const stoppedAt = editor.received.indexOf(closedFrames[0]!);
    const movedAt = editor.received.findIndex(
      (message, index) =>
        index >= mark &&
        concerns(message, 'session.updated', created.id) &&
        message.payload.session.status !== STATUS.capturing,
    );
    expect(stoppedAt).toBeGreaterThanOrEqual(mark);
    expect(movedAt).toBeGreaterThan(stoppedAt);
    const after = harness.repos.sessions.getActiveCapture(created.id);
    expect(isErr(after) ? 'unreadable' : after.value).toBeUndefined();
    expect(harness.manager.captureOwnerForProject(copy.root)).toBeUndefined();

    const ended = await harness.endSession(created.id);
    if (isErr(ended)) {
      throw new Error(`session.end was refused (${ended.error.code})`);
    }
    expect(ended.value.cleanup).toBe(CLEANUP.clean);
    await assertTreeUnchanged(copy.root, before);
  });

  it(`captures one cross-tier trace through both producers: the tab’s telemetry.event frame and ${route('telemetry.event')}`, async () => {
    const mark = vscode.received.length;
    const devtoolsMark = devtools.client.received.length;
    const started = await harness.startCapture(session.id);
    if (isErr(started)) {
      throw new Error(
        `capture.start was refused (${started.error.code}): ${started.error.message}`,
      );
    }
    captureId = started.value.captureId;
    expect(captureId).not.toBe(emptyCaptureId);

    // Every client of the session hears that the window opened, and the page agent is armed.
    expect((await waitForFrame(vscode, 'capture.started', session.id, mark)).payload).toEqual({
      sessionId: session.id,
      captureId,
    });
    expect(
      (await waitForFrame(devtools.client, 'capture.started', session.id, devtoolsMark)).payload,
    ).toEqual({ sessionId: session.id, captureId });
    await waitForRecord(
      vscode,
      session.id,
      (record) => record.status === STATUS.capturing && record.captures.at(-1)?.id === captureId,
    );
    const armed = await waitForFrame(devtools.client, 'agent.config', session.id, devtoolsMark);
    expect(armed.payload.captureId).toBe(captureId);
    const armedRows = buildInstrumentationRows({ hooks: armed.payload.hooks });
    expect(armedRows.length).toBeGreaterThan(0);
    const installLabels = findingRows(readyRows, STAGE.instrument).map((row) => row.message);
    for (const row of armedRows.filter((candidate) => candidate.status === ROW.done)) {
      // What the capture armed is what the install reported as enabled.
      expect(installLabels).toContain(row.message);
    }

    // The browser tier over the bound tab's WebSocket; the server and database
    // tiers from the dev-server side, with a credential scoped to the project.
    const batch = readTelemetryBatch(CROSS_TIER_BATCH);
    const browserEvents = batch.filter((event) => event.tier === TIER.browser);
    const serverEvents = batch.filter((event) => event.tier !== TIER.browser);
    expect(browserEvents.length).toBeGreaterThan(0);
    expect(serverEvents.length).toBeGreaterThan(0);
    const relayed = await harness.ingestFromAgent(devtools.client, browserEvents);
    expect(relayed.sent.ok).toBe(true);
    expect(relayed.settled).toBe(true);
    expect(relayed.errors).toEqual([]);
    const serverAgent = harness.issueServerAgentCredential(project.root);
    const posted = await harness.ingestFromServerAgent({
      token: serverAgent.token,
      projectRoot: project.root,
      events: serverEvents,
    });
    if (isErr(posted)) {
      throw new Error(
        `telemetry.event was refused (${posted.error.code}): ${posted.error.message}`,
      );
    }
    expect(posted.value.accepted).toBe(serverEvents.length);

    // The live tail reaches the DevTools panel, in its persisted, redacted form.
    const expectedIds = new Set(batch.map((event) => event.id));
    const tailed = await devtools.client.until(
      () => {
        const events = framesOf(
          devtools.client,
          'telemetry.tail',
          session.id,
          devtoolsMark,
        ).flatMap((frame) => frame.payload.events);
        return new Set(events.map((event) => event.id)).size === expectedIds.size
          ? events
          : undefined;
      },
      HARNESS_TIMEOUTS.capture,
      () => `the live tail did not carry all ${String(expectedIds.size)} events`,
    );
    expect(new Set(tailed.map((event) => event.id))).toEqual(expectedIds);
    const stored = harness.repos.telemetry.listByCapture(session.id, captureId);
    if (isErr(stored)) {
      throw new Error(`listByCapture failed (${stored.error.code})`);
    }
    const storedById = new Map(stored.value.rows.map((event) => [event.id, event]));
    expect(storedById.size).toBe(expectedIds.size);
    for (const event of tailed) {
      expect(event.sessionId).toBe(session.id);
      expect(event.captureId).toBe(captureId);
      expect(Number.isSafeInteger(event.ingestSeq) && event.ingestSeq > 0).toBe(true);
      // The redaction marker is the one persisted: the tail is post-redaction.
      expect(event.redacted).toEqual(storedById.get(event.id)?.redacted);
    }
    const queryValues = batch.flatMap((event: TelemetryEventIngress) => {
      const url = event.attributes['url'];
      return typeof url === 'string'
        ? [...new URL(url, devServerOrigin).searchParams.values()]
        : [];
    });
    expect(queryValues.length).toBeGreaterThan(0);
    const carriedQueries = new Set(
      batch
        .filter((event) => {
          const url = event.attributes['url'];
          return typeof url === 'string' && url.includes('?');
        })
        .map((event) => event.id),
    );
    for (const event of tailed.filter((candidate) => carriedQueries.has(candidate.id))) {
      expect(event.redacted).toContain('url');
    }
    const tailText = JSON.stringify(framesOf(devtools.client, 'telemetry.tail', session.id));
    for (const value of queryValues) {
      expect(tailText).not.toContain(value);
    }
    expect(await vscode.flush()).toBe(true);
    expect(vscode.received.filter((message) => message.type === 'telemetry.tail')).toEqual([]);

    // Stopping answers the summary, and capture.stopped carries the same one.
    const stopMark = vscode.received.length;
    const stopped = await harness.stopCapture(session.id);
    if (isErr(stopped)) {
      throw new Error(`capture.stop was refused (${stopped.error.code}): ${stopped.error.message}`);
    }
    summary = stopped.value.summary;
    expect((await waitForFrame(vscode, 'capture.stopped', session.id, stopMark)).payload).toEqual({
      sessionId: session.id,
      captureId,
      summary,
    });
    expect(summary.captureId).toBe(captureId);
    expect(summary.eventCount).toBe(batch.length);
    expect(summary.metrics.map((metric) => metric.id).sort()).toEqual([...METRIC_IDS].sort());
    expect(summary.producerIds.slice().sort()).toEqual(
      [...new Set(batch.map((event) => event.producerId))].sort(),
    );
    for (const tier of TELEMETRY_TIERS) {
      expect(summary.tierCounts[tier]).toBe(batch.filter((event) => event.tier === tier).length);
    }

    // One interaction resolves to one ordered tree across both producers.
    const expected = readFixtureJson<ExpectedTraceTree>(EXPECTED_TRACE_FIXTURE);
    expect(summary.traceCount).toBe(1);
    expect(summary.primaryTraceId).toBe(expected.traceId);
    const data = await harness
      .http(devtools.credential.token, { origin: devtools.credential.origin })
      .request('panel.data', { params: { id: session.id }, body: expected.query, tabId: TAB_ID });
    if (isErr(data)) {
      throw new Error(`panel.data was refused (${data.error.code}): ${data.error.message}`);
    }
    if (data.value.source !== 'trace' || data.value.trace === null) {
      throw new Error(`panel.data answered no trace from the ${data.value.source} source`);
    }
    expect(data.value.trace.nodeCount).toBe(expected.expectedNodeCount);
    expect(data.value.trace.roots.map((root) => root.event.spanId)).toEqual([
      expected.expectedRootSpanId,
    ]);
    expect(preOrderSpanIds(data.value.trace.roots)).toEqual(expected.expectedPreOrderSpanIds);
  });

  it('reaches generated only after analysis.completed and panel.generated, with both artifacts stored', async () => {
    await waitForRecord(vscode, session.id, (record) => record.status === STATUS.generated);
    expect(await vscode.flush()).toBe(true);
    expect(await devtools.client.flush()).toBe(true);

    // The §0.5.5 guard is about order: `generated` is only ever seen after both artifacts.
    for (const client of [vscode, devtools.client]) {
      expect(framesOf(client, 'analysis.completed', session.id)).toHaveLength(1);
      expect(framesOf(client, 'panel.generated', session.id)).toHaveLength(1);
      const analysisAt = indexOfFrame(client, 'analysis.completed', session.id);
      const panelAt = indexOfFrame(client, 'panel.generated', session.id);
      const generatedAt = indexOfFrame(
        client,
        'session.updated',
        session.id,
        (message) => message.payload.session.status === STATUS.generated,
      );
      expect(analysisAt).toBeGreaterThanOrEqual(0);
      expect(panelAt).toBeGreaterThanOrEqual(0);
      expect(generatedAt).toBeGreaterThan(analysisAt);
      expect(generatedAt).toBeGreaterThan(panelAt);
    }
    const trail = statusTrail(vscode, session.id);
    expect(trail).toEqual([
      STATUS.created,
      STATUS.understanding,
      STATUS.investigating,
      STATUS.planning,
      STATUS.instrumenting,
      STATUS.ready,
      STATUS.capturing,
      STATUS.ready,
      STATUS.capturing,
      STATUS.analyzing,
      STATUS.generated,
    ]);
    trail.slice(1).forEach((to, index) => {
      expect(allowedTransitions(trail[index]!)).toContain(to);
    });
    expect((await readSession()).status).toBe(STATUS.generated);

    // The analysis: evidence-backed facts, every cited event one of the ingested ones.
    const analysisFrame = framesOf(vscode, 'analysis.completed', session.id)[0]!;
    const parsed = parseAnalysisResult(analysisFrame.payload.analysis);
    if (isErr(parsed)) {
      throw new Error(`the analysis does not parse: ${parsed.error.message}`);
    }
    liveAnalysis = parsed.value;
    expect(liveAnalysis.sessionId).toBe(session.id);
    expect(liveAnalysis.captureId).toBe(captureId);
    const ingested = new Set(readTelemetryBatch(CROSS_TIER_BATCH).map((event) => event.id));
    expect(liveAnalysis.observed.length).toBeGreaterThan(0);
    for (const fact of [...liveAnalysis.observed, ...liveAnalysis.likelyCauses]) {
      expect(fact.evidence.length).toBeGreaterThan(0);
      for (const reference of fact.evidence) {
        expect(ingested.has(reference.eventId)).toBe(true);
      }
    }
    for (const cause of liveAnalysis.likelyCauses) {
      expect(CONFIDENCE_LEVELS).toContain(cause.confidence);
    }

    // The panel: valid, and its facts are the analysis's facts, never its own.
    const panelFrame = framesOf(vscode, 'panel.generated', session.id)[0]!;
    const validated = validatePanelSpec(panelFrame.payload.panel);
    if (isErr(validated)) {
      throw new Error(`the panel does not validate: ${validated.error.message}`);
    }
    livePanel = validated.value;
    expect(panelFrame.payload.panelId).toBe(livePanel.id);
    expect(livePanel.sessionId).toBe(session.id);
    expect(livePanel.layout.length).toBeGreaterThan(0);
    expect(livePanel.summary.observed).toEqual(liveAnalysis.observed);
    expect(livePanel.summary.likelyCauses).toEqual(liveAnalysis.likelyCauses);

    // Both artifacts are persisted for this session.
    const analyses = harness.repos.panels.listAnalyses(session.id);
    const panels = harness.repos.panels.listPanels(session.id);
    if (isErr(analyses) || isErr(panels)) {
      throw new Error('the analysis and panel history could not be read');
    }
    expect(analyses.value.map((analysis) => analysis.id)).toEqual([liveAnalysis.id]);
    expect(panels.value.map((panel) => panel.id)).toEqual([livePanel.id]);

    // Every group of the whole walk opened with its header and closed with done.
    const rows = progressRows(vscode, session.id);
    const stages = [...new Set(rows.map((row) => row.stage))];
    expect(stages).toEqual(PIPELINE_GROUP_ORDER.slice(0, stages.length));
    expect(stages).toContain(STAGE['generate-panel']);
    for (const stage of stages) {
      const ofStage = rows.filter((row) => row.stage === stage);
      expect(ofStage[0]).toEqual({
        stage,
        status: ROW.running,
        message: PROGRESS_STAGE_TITLES[stage],
      });
      expect(ofStage.at(-1)?.status).toBe(ROW.done);
    }
    expect(rows.filter((row) => row.status === ROW.failed)).toEqual([]);
  });

  it(`${route('session.get')} returns a record that accumulated every artifact of the walk`, async () => {
    const record = await readSession();
    expect(parseSessionRecord(record).ok).toBe(true);
    expect(record.status).toBe(STATUS.generated);
    expect(record.understanding).toBeDefined();
    expect(record.relevantFiles.length).toBeGreaterThan(0);
    expect(record.boundTab).toMatchObject({ tabId: TAB_ID });

    const { plan } = framesOf(vscode, 'instrumentation.plan', session.id)[0]!.payload;
    expect(record.plans).toEqual([plan]);
    record.plans.forEach((stored, index) => {
      expect(stored.planVersion).toBe(index + 1);
    });
    const { applied } = framesOf(vscode, 'instrumentation.ready', session.id)[0]!.payload;
    expect(record.modifications.map((modification) => modification.id)).toEqual(
      applied.map((modification) => modification.id),
    );
    for (const modification of record.modifications) {
      expect(modification.status).toBe(MODIFICATION.applied);
    }

    expect(record.captures.map((capture) => capture.id)).toEqual([emptyCaptureId, captureId]);
    const last = record.captures.at(-1);
    expect(last?.planVersion).toBe(plan.planVersion);
    expect(last?.stoppedAt).toBeDefined();
    expect(last?.summary).toEqual(summary);
    expect(record.analyses).toEqual([liveAnalysis]);
    expect(record.panelIds).toEqual([livePanel.id]);

    const manifest = JSON.parse(
      await readFile(join(PROMPTS_DIR, 'manifest.json'), 'utf8'),
    ) as PromptManifest;
    expect(record.promptVersions).toEqual(
      Object.fromEntries(
        Object.entries(manifest.stages).map(([stage, entry]) => [stage, entry.current]),
      ),
    );
    expect(record.cleanup).toEqual({ status: CLEANUP.pending, conflicts: [] });
  });

  it('files a failing stage as failed, names that stage, and offers no way on to generated', async () => {
    // A real failure: a copy whose TypeScript configuration was left half-written.
    const broken = await harness.copyFixtureProject();
    await writeFile(join(broken.root, 'tsconfig.json'), '{ "compilerOptions": ');
    const before = await snapshotTree(broken.root);
    const launched = await harness.launchDevServer(broken.root);
    if (isErr(launched)) {
      throw new Error(`the dev server did not launch (${launched.error.code})`);
    }
    const editor = await harness.editor(broken.root);
    const failing = await harness.createSession({ projectRoot: broken.root, question: QUESTION });
    await waitForRecord(editor, failing.id, (record) => record.status === STATUS.failed);
    expect(await editor.flush()).toBe(true);

    const trail = statusTrail(editor, failing.id);
    expect(trail.at(-1)).toBe(STATUS.failed);
    expect(trail).not.toContain(STATUS.generated);
    // Failing is not ending: nothing broadcast `ended` before the explicit end
    // below, and the stored record holds `failed` rather than a later status.
    expect(trail).not.toContain(STATUS.ended);
    const stored = harness.repos.sessions.get(failing.id);
    expect(isErr(stored) ? undefined : stored.value?.status).toBe(STATUS.failed);

    // The failing stage reaches the user interface as the one `failed` row.
    const failedRows = progressRows(editor, failing.id).filter((row) => row.status === ROW.failed);
    expect(failedRows).toHaveLength(1);
    const failedRow = failedRows[0]!;
    expect(PIPELINE_STAGE_ORDER).toContain(failedRow.stage);
    expect(statusForStage(failedRow.stage)).toBe(trail.at(-2));
    expect(failedRow.message.length).toBeGreaterThan(0);
    expect(failedRow.detail).toMatch(/error code: [A-Z][A-Z_]+/u);

    // No route leads from `failed` to `generated`: the table has no such edge,
    // and neither capture route moves the session on.
    expect(allowedTransitions(STATUS.failed)).not.toContain(STATUS.generated);
    expect(isErr(await harness.startCapture(failing.id))).toBe(true);
    expect(isErr(await harness.stopCapture(failing.id))).toBe(true);
    const reread = harness.manager.get(failing.id);
    expect(isErr(reread) ? undefined : reread.value?.status).toBe(STATUS.failed);
    expect(framesOf(editor, 'analysis.completed', failing.id)).toEqual([]);
    expect(framesOf(editor, 'panel.generated', failing.id)).toEqual([]);

    // Ending it is still possible, and nothing had been written to restore.
    const ended = await harness.endSession(failing.id);
    if (isErr(ended)) {
      throw new Error(`session.end was refused (${ended.error.code})`);
    }
    expect(ended.value.cleanup).toBe(CLEANUP.clean);
    await assertTreeUnchanged(broken.root, before);
  });

  it(`reopening through ${route('session.get')} replays the stored session in order and changes nothing`, async () => {
    const fresh = await harness.ws({ client: 'vscode', projectRoot: project.root });
    const progressBefore = harness.repos.sessions.listProgress(session.id);
    const storedAnalysis = harness.repos.panels.getLatestAnalysis(session.id);
    const storedPanel = harness.repos.panels.getLatestPanel(session.id);
    if (isErr(progressBefore) || isErr(storedAnalysis) || isErr(storedPanel)) {
      throw new Error('the stored session could not be read');
    }
    const recordBefore = await readSession();
    const modelCallsBefore = recorder.calls.length;
    expect(progressBefore.value.length).toBeGreaterThan(0);
    expect(progressBefore.value.length).toBeLessThanOrEqual(MAX_REPLAYED_PROGRESS_ROWS);

    const reopened = await harness.http().request('session.get', { params: { id: session.id } });
    if (isErr(reopened)) {
      throw new Error(
        `session.get was refused (${reopened.error.code}): ${reopened.error.message}`,
      );
    }
    expect(await fresh.flush()).toBe(true);

    // Exactly: the record, every stored progress row, the latest analysis, the latest panel.
    const [updatedType, progressType, analysisType, panelType] = REPLAY_MESSAGE_ORDER;
    expect(fresh.received.map((message) => message.type)).toEqual([
      updatedType,
      ...progressBefore.value.map(() => progressType),
      analysisType,
      panelType,
    ]);
    const [updated] = framesOf(fresh, 'session.updated', session.id);
    expect(updated?.payload.session).toEqual(recordBefore);
    const replayedProgress = framesOf(fresh, 'session.progress', session.id);
    expect(replayedProgress.map((frame) => rowOf(frame.payload))).toEqual(
      progressBefore.value.map((entry) => storedRowOf(entry)),
    );
    expect(replayedProgress.map((frame) => frame.ts)).toEqual(
      progressBefore.value.map((entry) => entry.ts),
    );
    const [replayedAnalysis] = framesOf(fresh, 'analysis.completed', session.id);
    expect(replayedAnalysis?.payload.analysis).toEqual(storedAnalysis.value);
    expect(replayedAnalysis?.payload.analysis).toEqual(liveAnalysis);
    const [replayedPanel] = framesOf(fresh, 'panel.generated', session.id);
    expect(replayedPanel?.payload.panelId).toBe(livePanel.id);
    expect(JSON.stringify(replayedPanel?.payload.panel)).toBe(JSON.stringify(storedPanel.value));
    expect(JSON.stringify(replayedPanel?.payload.panel)).toBe(JSON.stringify(livePanel));

    // Read-only: no transition, no progress row, no stage, no model call.
    expect(reopened.value).toEqual(recordBefore);
    expect(await readSession()).toEqual(recordBefore);
    const progressAfter = harness.repos.sessions.listProgress(session.id);
    expect(isErr(progressAfter) ? undefined : progressAfter.value).toEqual(progressBefore.value);
    expect(recorder.calls).toHaveLength(modelCallsBefore);
    const counts = harness.repos.panels.countBySession(session.id);
    expect(isErr(counts) ? undefined : counts.value).toMatchObject({ analyses: 1, panels: 1 });
    expect(statusTrail(vscode, session.id).at(-1)).toBe(STATUS.generated);
  });

  it(`an editor ${route('session.get')} re-renders the bound DevTools panel without resending the progress history it already holds`, async () => {
    const stored = harness.repos.sessions.listProgress(session.id);
    if (isErr(stored)) {
      throw new Error(`listProgress failed (${stored.error.code})`);
    }
    expect(stored.value.length).toBeGreaterThan(0);
    expect(await devtools.client.flush()).toBe(true);
    expect(await vscode.flush()).toBe(true);
    const [updatedType, progressType, analysisType, panelType] = REPLAY_MESSAGE_ORDER;
    const replayTypes = new Set<MessageType>(REPLAY_MESSAGE_ORDER);
    /** The replay frames about the walk's session a client received from transcript index `from`. */
    const replayedTo = (client: HarnessWsClient, from: number): MessageType[] =>
      client.received
        .slice(from)
        .filter(
          (message) => replayTypes.has(message.type) && concerns(message, message.type, session.id),
        )
        .map((message) => message.type);
    // The panel already holds every stored row exactly once — replayed on bind, live after it.
    const panelKeysBefore = framesOf(devtools.client, progressType, session.id).map(frameKey);
    expect(new Set(panelKeysBefore)).toEqual(
      new Set(stored.value.map((entry) => JSON.stringify([entry.ts, storedRowOf(entry)]))),
    );
    const devtoolsMark = devtools.client.received.length;
    const editorMark = vscode.received.length;

    // The editor's reopen, twice — as a reopen followed by a resync would issue it.
    for (let read = 0; read < 2; read += 1) {
      const reopened = await harness.http().request('session.get', { params: { id: session.id } });
      if (isErr(reopened)) {
        throw new Error(
          `session.get was refused (${reopened.error.code}): ${reopened.error.message}`,
        );
      }
    }
    expect(await devtools.client.flush()).toBe(true);
    expect(await vscode.flush()).toBe(true);

    // The bound panel re-renders from stored data — the record, the analysis and the panel, in the
    // fixed order, once per read — and is sent no progress row at all.
    expect(replayedTo(devtools.client, devtoolsMark)).toEqual([
      updatedType,
      analysisType,
      panelType,
      updatedType,
      analysisType,
      panelType,
    ]);
    expect(framesOf(devtools.client, progressType, session.id, devtoolsMark)).toEqual([]);
    const [panelFrame] = framesOf(devtools.client, panelType, session.id, devtoolsMark);
    expect(panelFrame?.payload.panelId).toBe(livePanel.id);
    expect(framesOf(devtools.client, progressType, session.id).map(frameKey)).toEqual(
      panelKeysBefore,
    );

    // The editor, the requester, receives the whole replay on each read, rows with their stored ts.
    const perRead = [updatedType, ...stored.value.map(() => progressType), analysisType, panelType];
    expect(replayedTo(vscode, editorMark)).toEqual([...perRead, ...perRead]);
    expect(framesOf(vscode, progressType, session.id, editorMark).map((frame) => frame.ts)).toEqual(
      [...stored.value, ...stored.value].map((entry) => entry.ts),
    );

    // Still read-only.
    const after = harness.repos.sessions.listProgress(session.id);
    expect(isErr(after) ? undefined : after.value).toEqual(stored.value);
  });

  it(`${route('session.end')} removes the instrumentation through the real cleanup and keeps the session readable`, async () => {
    const mark = vscode.received.length;
    const ended = await harness.endSession(session.id);
    if (isErr(ended)) {
      throw new Error(`session.end was refused (${ended.error.code}): ${ended.error.message}`);
    }
    expect(ended.value.cleanup).toBe(CLEANUP.clean);
    expect((await waitForFrame(vscode, 'cleanup.completed', session.id, mark)).payload).toEqual({
      sessionId: session.id,
      status: CLEANUP.clean,
      conflicts: [],
    });

    // Every file the plan touched is byte-identical to its pre-session content.
    await assertTreeUnchanged(project.root, preSessionSnapshot);
    await assertTreeUnchanged(project.root, project.snapshot);

    // Still readable, over the literal routes of protocol's table.
    const listed = await harness.rawFetch('session.list');
    expect(listed.status).toBe(200);
    const list = parseHttpResponse('session.list', listed.json);
    if (isErr(list)) {
      throw new Error(`the session list does not parse: ${list.error.message}`);
    }
    expect(list.value.sessions.map((listedSession) => listedSession.id)).toContain(session.id);
    const got = await harness.rawFetch({ operation: 'session.get', params: { id: session.id } });
    expect(got.status).toBe(200);
    const record = parseHttpResponse('session.get', got.json);
    if (isErr(record)) {
      throw new Error(`the session does not parse: ${record.error.message}`);
    }
    expect(record.value.status).toBe(STATUS.ended);
    expect(record.value.cleanup.status).toBe(CLEANUP.clean);
    expect(record.value.cleanup.completedAt).toEqual(expect.any(Number));
    expect(record.value.cleanup.conflicts).toEqual([]);
    // The record lists what the installer applied, each entry carrying the journal's verdict:
    // it agrees record for record with `GET /sessions/:id/modifications` — every one restored.
    expect(record.value.modifications.length).toBeGreaterThan(0);
    const journalResponse = await harness.rawFetch({
      operation: 'modifications.list',
      params: { id: session.id },
    });
    expect(journalResponse.status).toBe(200);
    const journal = parseHttpResponse('modifications.list', journalResponse.json);
    if (isErr(journal)) {
      throw new Error(`the modification journal does not parse: ${journal.error.message}`);
    }
    // The same records on both sides, each carrying the journal's verdict. The journal is
    // authoritative and serves them in application order; the record is its mirror, whose order
    // the session contract leaves open, so both are compared keyed by id.
    const byId = (left: readonly [string, string], right: readonly [string, string]): number =>
      left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
    const verdictsOf = (
      modifications: readonly { readonly id: string; readonly status: string }[],
    ): (readonly [string, string])[] =>
      modifications
        .map((modification) => [modification.id, modification.status] as const)
        .sort(byId);
    const verdicts = verdictsOf(journal.value.modifications);
    expect(verdicts.length).toBeGreaterThan(0);
    for (const [, status] of verdicts) {
      expect(status).toBe(MODIFICATION.reverted);
    }
    expect(verdictsOf(record.value.modifications)).toEqual(verdicts);

    // So does every `session.updated` that reported the end — the cleanup outcome's and the
    // `ended` one — rather than the statuses the install mirrored.
    await waitForRecord(vscode, session.id, (pushed) => pushed.status === STATUS.ended);
    const reported = framesOf(vscode, 'session.updated', session.id, mark).filter(
      (frame) => frame.payload.session.cleanup.status === CLEANUP.clean,
    );
    expect(reported.length).toBeGreaterThanOrEqual(2);
    expect(reported.at(-1)?.payload.session.status).toBe(STATUS.ended);
    for (const frame of reported) {
      expect(verdictsOf(frame.payload.session.modifications)).toEqual(verdicts);
    }

    // And so does the replay a reopen of the ended session sends.
    const reopener = await harness.ws({ client: 'vscode', projectRoot: project.root });
    const reopened = await harness.http().request('session.get', { params: { id: session.id } });
    if (isErr(reopened)) {
      throw new Error(
        `session.get was refused (${reopened.error.code}): ${reopened.error.message}`,
      );
    }
    expect(verdictsOf(reopened.value.modifications)).toEqual(verdicts);
    expect(await reopener.flush()).toBe(true);
    const [replayed] = framesOf(reopener, 'session.updated', session.id);
    expect(replayed).toBeDefined();
    expect(verdictsOf(replayed?.payload.session.modifications ?? [])).toEqual(verdicts);
    expect(record.value.analyses).toEqual([liveAnalysis]);
    expect(record.value.panelIds).toEqual([livePanel.id]);
    expect(statusTrail(vscode, session.id).at(-1)).toBe(STATUS.ended);

    // Every route the walk drove demanded a credential (AAP §0.5.6).
    for (const operation of WALK_OPERATIONS) {
      expect(HTTP_ROUTES[operation].authExempt).toBe(false);
    }

    // Nothing reached the developer's real state directory, and the committed corpus is untouched.
    expect(harness.home.startsWith(join(homedir(), '.debuggen'))).toBe(false);
    await assertTreeUnchanged(fixturePath(DEFAULT_FIXTURE_PROJECT), project.snapshot);
  });
});

/* -------------------------------------------------------------------------------------------------
 * A cleanup that fails: the row shows product text, never the runner's hint
 * ---------------------------------------------------------------------------------------------- */

/**
 * The private fragments of a hint a cleanup runner can propagate from a
 * collaborator — a backup store's path, a statement, a URL query value.
 */
const CLEANUP_HINT_FRAGMENTS: readonly string[] = Object.freeze([
  '/home/dev/zz-cleanup-project/.debuggen/backups/zz-digest',
  'zz-cleanup-sql-literal',
  'zz-cleanup-query-value',
]);

/** That hint: it reads like a recovery step, and no product builder registered it. */
const CLEANUP_RUNNER_HINT =
  `Restore ${String(CLEANUP_HINT_FRAGMENTS[0])} by hand, rerun ` +
  "UPDATE journal SET status = 'zz-cleanup-sql-literal', then open " +
  'http://127.0.0.1:3999/status?token=zz-cleanup-query-value.';

/** The runner's own message, which only the failure's debug diagnostic may carry. */
const CLEANUP_RUNNER_MESSAGE = `The backup under ${String(CLEANUP_HINT_FRAGMENTS[0])} is unreadable.`;

describe('a cleanup that fails, filed through the real manager, progress emitter and store', () => {
  it("shows the product's retry step or a proven hint, never a hint the cleanup runner propagated", async () => {
    // The service's own store, progress emitter and logger, with only the
    // cleanup runner replaced: the first ending fails with a private hint,
    // the second with a hint that is fixed product copy.
    const frames: { readonly kinds: readonly string[]; readonly message: ProtocolMessage }[] = [];
    const broadcaster: SessionBroadcaster = {
      broadcast: (_sessionId, message) => {
        frames.push({ kinds: ['*'], message });
      },
      broadcastToKinds: (_sessionId, kinds, message) => {
        frames.push({ kinds, message });
      },
    };
    const progress = createSessionProgress({
      sessions: harness.repos.sessions,
      broadcaster,
      logger: harness.logger.root,
    });
    const failures = [
      new DebuggenError('CLEANUP_PARTIAL', CLEANUP_RUNNER_MESSAGE, { hint: CLEANUP_RUNNER_HINT }),
      new DebuggenError('CLEANUP_PARTIAL', CLEANUP_RUNNER_MESSAGE, {
        hint: FAILURE_COPY_BY_CODE.MODIFICATION_CONFLICT.hint,
      }),
    ];
    let attempt = 0;
    const manager = createSessionManager({
      sessions: harness.repos.sessions,
      broadcaster,
      progress,
      cleanup: {
        run: () => {
          const failure = failures[attempt];
          attempt += 1;
          return Promise.resolve(
            err(failure ?? new DebuggenError('CLEANUP_PARTIAL', CLEANUP_RUNNER_MESSAGE)),
          );
        },
      },
      config: { provider: 'deterministic' },
      logger: harness.logger.root,
    });
    const created = await manager.create({
      projectRoot: '/work/zz-cleanup-project',
      question: QUESTION,
      devServerUrl: 'http://127.0.0.1:3999/',
    });
    if (isErr(created)) {
      throw new Error(`the probe session was refused (${created.error.code})`);
    }
    const sessionId = created.value.id;

    const first = await manager.end(sessionId);
    const second = await manager.end(sessionId);
    expect(isErr(first) ? first.error.code : 'ended').toBe('CLEANUP_PARTIAL');
    expect(isErr(second) ? second.error.code : 'ended').toBe('CLEANUP_PARTIAL');

    // The persisted rows: the retry step for the unproven hint, the proven hint as it was written.
    const stored = harness.repos.sessions.listProgress(sessionId);
    if (isErr(stored)) {
      throw new Error(`the probe session's progress could not be read (${stored.error.code})`);
    }
    const failedRows = stored.value.filter(
      (row) => row.stage === STAGE.cleanup && row.status === ROW.failed,
    );
    expect(failedRows).toHaveLength(2);
    const refPattern = /\(error code: CLEANUP_PARTIAL, ref: (msg_[A-Za-z0-9_-]+)\)$/u;
    expect(String(failedRows[0]?.detail)).toMatch(
      /^End the session again to retry cleanup\. \(error code: CLEANUP_PARTIAL, ref: msg_[A-Za-z0-9_-]+\)$/u,
    );
    expect(
      String(failedRows[1]?.detail).startsWith(
        `${FAILURE_COPY_BY_CODE.MODIFICATION_CONFLICT.hint} (error code: CLEANUP_PARTIAL`,
      ),
    ).toBe(true);
    const refs = failedRows.map((row) => refPattern.exec(String(row.detail))?.[1]);
    expect(refs.every((ref) => ref !== undefined)).toBe(true);

    // Neither the stored rows nor any frame the clients were sent carries the runner's words.
    const surfaces = JSON.stringify([stored.value, frames.map(({ message }) => message)]);
    for (const fragment of [
      CLEANUP_RUNNER_HINT,
      CLEANUP_RUNNER_MESSAGE,
      ...CLEANUP_HINT_FRAGMENTS,
    ]) {
      expect(surfaces, `a surface carries ${fragment}`).not.toContain(fragment);
    }
    const progressFrames = frames.filter(({ message }) => message.type === 'session.progress');
    expect(progressFrames.length).toBeGreaterThanOrEqual(2);
    for (const { kinds } of progressFrames) {
      expect(kinds).toEqual(['vscode', 'devtools']);
    }

    // Each row's reference leads to its warn record and its debug diagnostic.
    const warned = harness.logger
      .withMessage(STAGE_FAILURE_LOG_MESSAGE)
      .filter((record) => record.fields['sessionId'] === sessionId);
    const twins = harness.logger
      .withMessage(STAGE_FAILURE_DIAGNOSTIC_MESSAGE)
      .filter((record) => record.fields['sessionId'] === sessionId);
    expect(warned.map((record) => record.fields['ref'])).toEqual(refs);
    expect(twins.map((record) => record.fields['ref'])).toEqual(refs);
    expect(twins.map((record) => record.level)).toEqual(['debug', 'debug']);
    for (const record of warned) {
      for (const fragment of CLEANUP_HINT_FRAGMENTS) {
        expect(record.line, `the warn record carries ${fragment}`).not.toContain(fragment);
      }
    }
    for (const record of twins) {
      const diagnostic = record.fields[LOG_ERROR_FIELD_KEY];
      expect(diagnostic).toMatchObject({ type: 'DebuggenError', code: 'CLEANUP_PARTIAL' });
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * An end whose binding removal the store refuses: `ended` is stored with it or not at all
 * ---------------------------------------------------------------------------------------------- */

describe(`a ${route('session.end')} whose tab-binding removal the store refuses`, () => {
  it('leaves the session open and bound, and the retried end stores `ended` with the binding removed', async () => {
    // Its own session on its own copy and tab, so the walk above is untouched.
    const tabId = TAB_ID + 2;
    const copy = await harness.copyFixtureProject();
    const before = await snapshotTree(copy.root);
    const launched = await harness.launchDevServer(copy.root);
    if (isErr(launched)) {
      throw new Error(`the dev server did not launch (${launched.error.code})`);
    }
    const origin = new URL(launched.value.devServerUrl).origin;
    const editor = await harness.editor(copy.root);
    const created = await harness.createSession({ projectRoot: copy.root, question: QUESTION });
    const tab = await harness.connectDevtools({ tabId });
    const bound = await harness.bindTab(tab.client, {
      tabId,
      url: `${origin}/`,
      origin,
      sessionId: created.id,
    });
    if (isErr(bound)) {
      throw new Error(`session.bind was refused (${bound.error.code}): ${bound.error.message}`);
    }
    const report = tab.client.send('agent.ready', {
      tabId,
      documentId: 'doc_lifecycle000000003',
      producerId: newProducerId(),
      url: `${origin}/`,
      installedBeforeReact: true,
      reactDetected: true,
    });
    expect(await tab.client.flush()).toBe(true);
    expect(tab.client.errorsFor(report.id)).toEqual([]);
    await waitForRecord(
      editor,
      created.id,
      (record) => record.status === STATUS.ready && record.boundTab?.tabId === tabId,
    );

    /** The session as the service's store holds it, and the tab its `bindings` row names. */
    const storedState = (): { readonly record: SessionRecord; readonly boundTabId?: number } => {
      const record = harness.repos.sessions.get(created.id);
      const binding = harness.repos.sessions.getBindingBySession(created.id);
      if (isErr(record) || record.value === undefined || isErr(binding)) {
        throw new Error('the session or its binding could not be read from the store');
      }
      return binding.value === undefined
        ? { record: record.value }
        : { record: record.value, boundTabId: binding.value.tab.tabId };
    };
    const mark = editor.received.length;

    // The injected failure: a TEMP trigger on the service's own connection that
    // aborts every removal of this session's `bindings` row — the write the
    // manager commits together with `ended`.
    if (!/^[A-Za-z0-9_-]+$/u.test(created.id)) {
      throw new Error('The session id cannot be quoted into a trigger.');
    }
    const trigger = `lifecycle_block_unbind_${created.id.replaceAll('-', '_')}`;
    harness.store.db.exec(
      `CREATE TEMP TRIGGER ${trigger} BEFORE DELETE ON bindings WHEN OLD.session_id = '${created.id}' BEGIN SELECT RAISE(ABORT, 'session-lifecycle suite: injected binding delete failure'); END;`,
    );
    try {
      const refused = await harness.endSession(created.id);
      if (!isErr(refused)) {
        throw new Error('session.end was expected to be refused, but it succeeded.');
      }
      expect(refused.error.code).toBe('STORE_ERROR');

      // Nothing ended: the status, the record's tab and the binding row all stay.
      const open = storedState();
      expect(open.record.status).toBe(STATUS.ready);
      expect(open.record.boundTab?.tabId).toBe(tabId);
      expect(open.boundTabId).toBe(tabId);
      expect(await editor.flush()).toBe(true);
      expect(
        framesOf(editor, 'session.updated', created.id, mark).filter(
          (frame) => frame.payload.session.status === STATUS.ended,
        ),
      ).toEqual([]);
    } finally {
      harness.store.db.exec(`DROP TRIGGER IF EXISTS temp.${trigger};`);
    }

    // With the store writable again, ending again re-runs the idempotent
    // cleanup and stores `ended` together with the binding's removal.
    const ended = await harness.endSession(created.id);
    if (isErr(ended)) {
      throw new Error(`session.end was refused (${ended.error.code}): ${ended.error.message}`);
    }
    expect(ended.value.cleanup).toBe(CLEANUP.clean);
    const closed = storedState();
    expect(closed.record.status).toBe(STATUS.ended);
    expect(closed.record.boundTab).toBeUndefined();
    expect(closed.boundTabId).toBeUndefined();
    const announced = await waitForRecord(
      editor,
      created.id,
      (record) => record.status === STATUS.ended,
    );
    expect(announced.payload.session).toEqual(closed.record);
    await assertTreeUnchanged(copy.root, before);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The capture summary and the empty-capture rule, over captures the walk above does not make
 * ---------------------------------------------------------------------------------------------- */

/** The page-agent-relayed fixture whose render and commit events stand in for a page idling. */
const RENDERS_BATCH = 'telemetry-renders-state.json';

/** A session on its own copy, bound to its own tab, whose pipeline has reached `ready`. */
interface ReadySession {
  readonly copy: FixtureProjectCopy;
  readonly before: TreeSnapshot;
  readonly editor: HarnessWsClient;
  readonly tab: DevtoolsConnection;
  readonly session: SessionRecord;
}

/**
 * Creates a session on a fresh copy of the corpus in `target`, binds it to
 * `tabId`, relays the page agent's report on that tab and waits for `ready` —
 * the same steps the walk takes, on state no other test reads.
 */
async function openReadySession(
  target: Harness,
  tabId: number,
  documentId: string,
): Promise<ReadySession> {
  const copy = await target.copyFixtureProject();
  const before = await snapshotTree(copy.root);
  const launched = await target.launchDevServer(copy.root);
  if (isErr(launched)) {
    throw new Error(`the dev server did not launch (${launched.error.code})`);
  }
  const origin = new URL(launched.value.devServerUrl).origin;
  const editor = await target.editor(copy.root);
  const created = await target.createSession({ projectRoot: copy.root, question: QUESTION });
  const tab = await target.connectDevtools({ tabId });
  const bound = await target.bindTab(tab.client, {
    tabId,
    url: `${origin}/`,
    origin,
    sessionId: created.id,
  });
  if (isErr(bound)) {
    throw new Error(`session.bind was refused (${bound.error.code}): ${bound.error.message}`);
  }
  const report = tab.client.send('agent.ready', {
    tabId,
    documentId,
    producerId: newProducerId(),
    url: `${origin}/`,
    installedBeforeReact: true,
    reactDetected: true,
  });
  expect(await tab.client.flush()).toBe(true);
  expect(tab.client.errorsFor(report.id)).toEqual([]);
  // Read from the editor's own pushes: a `session.get` on the editor
  // credential would replay the session's frames to it.
  const { session: settled } = (
    await waitForRecord(
      editor,
      created.id,
      (record) => record.status === STATUS.ready || record.status === STATUS.failed,
    )
  ).payload;
  if (settled.status !== STATUS.ready) {
    expect(await editor.flush()).toBe(true);
    const failed = progressRows(editor, created.id).filter((row) => row.status === ROW.failed);
    throw new Error(`The session settled as ${settled.status}: ${JSON.stringify(failed)}`);
  }
  return { copy, before, editor, tab, session: settled };
}

/** When the session's open capture window started, by the service's clock. */
function openCaptureStart(target: Harness, sessionId: string): number {
  const active = target.repos.sessions.getActiveCapture(sessionId);
  if (isErr(active) || active.value === undefined) {
    throw new Error('the open capture window could not be read from the store');
  }
  return active.value.capture.startedAt;
}

/**
 * One copy of a fixture batch as fresh evidence of a capture: new event,
 * trace and span ids (parent links kept inside the copy, dropped where the
 * parent is not in it), one fresh producer per fixture producer continuing at
 * `seq`, and start times moved so the copy's first event starts at `startAt`
 * with the fixture's own spacing.
 */
function freshCopyOf(
  events: readonly TelemetryEventIngress[],
  startAt: number,
  producers: Map<string, { readonly id: string; seq: number }>,
): TelemetryEventIngress[] {
  const origin = Math.min(...events.map((event) => event.startTime));
  const spans = new Map(events.map((event) => [event.spanId, newSpanId()]));
  const traceId = newTraceId();
  return events.map((event) => {
    const { parentSpanId, ...rest } = event;
    const parent = parentSpanId === undefined ? undefined : spans.get(parentSpanId);
    const producer = producers.get(event.producerId) ?? { id: newProducerId(), seq: 0 };
    producers.set(event.producerId, producer);
    producer.seq += 1;
    return {
      ...rest,
      id: newEventId(),
      traceId,
      spanId: spans.get(event.spanId) ?? newSpanId(),
      ...(parent === undefined ? {} : { parentSpanId: parent }),
      producerId: producer.id,
      seq: producer.seq,
      startTime: startAt + (event.startTime - origin),
    };
  });
}

/** Moves the harness clock past the evidence a test placed ahead of it. */
function advanceClock(target: Harness, ms: number): void {
  if (target.clock === undefined) {
    throw new Error('This suite needs the harness clock to place its evidence inside the window.');
  }
  target.clock.advance(ms);
}

describe('a capture holding more events than the former 10 000-event summary bound', () => {
  /** Background render cycles, then one cross-tier reproduction: past 10 000, under the bound. */
  const BACKGROUND_EVENTS = 2 * SUMMARY_PAGE_SIZE + 1_234;

  /** Rows per `insertMany` transaction while the capture is seeded. */
  const SEED_BATCH = 2_000;

  it('summarises every stored event, the reproduction recorded after the first 10 000 included', async () => {
    const tabId = TAB_ID + 3;
    const {
      copy,
      before,
      editor,
      session: created,
    } = await openReadySession(harness, tabId, 'doc_lifecycle000000004');
    const started = await harness.startCapture(created.id);
    if (isErr(started)) {
      throw new Error(
        `capture.start was refused (${started.error.code}): ${started.error.message}`,
      );
    }
    const captureId = started.value.captureId;
    await waitForFrame(editor, 'capture.started', created.id);
    const windowStart = openCaptureStart(harness, created.id);

    // A page re-rendering in the background for the whole capture, then the
    // interaction the question is about — its fetch, route, handler and
    // queries all ordered after the first 10 000 events, as in XL-F05.
    const interactionKinds: readonly string[] = telemetryKindsForSignal('interactions');
    const renders = readTelemetryBatch(RENDERS_BATCH).filter(
      (event) => !interactionKinds.includes(event.kind),
    );
    const producers = new Map<string, { readonly id: string; seq: number }>();
    const background: TelemetryEventIngress[] = [];
    while (background.length < BACKGROUND_EVENTS) {
      const cycle = freshCopyOf(renders, windowStart + 1 + background.length, producers);
      background.push(...cycle.slice(0, BACKGROUND_EVENTS - background.length));
    }
    const backgroundEnd = Math.max(...background.map((event) => event.startTime + event.duration));
    const reproduction = freshCopyOf(
      readTelemetryBatch(CROSS_TIER_BATCH),
      Math.ceil(backgroundEnd) + 1,
      producers,
    );
    expect(reproduction.map((event) => event.kind)).toEqual(
      expect.arrayContaining([...interactionKinds]),
    );
    const evidence = [...background, ...reproduction];
    expect(evidence.length).toBeGreaterThan(10_000);
    expect(evidence.length).toBeLessThan(MAX_SUMMARY_EVENTS);
    for (let from = 0; from < evidence.length; from += SEED_BATCH) {
      const inserted = harness.repos.telemetry.insertMany(
        evidence
          .slice(from, from + SEED_BATCH)
          .map((event) => ({ ...event, sessionId: created.id, captureId })),
      );
      if (isErr(inserted)) {
        throw new Error(`insertMany failed (${inserted.error.code})`);
      }
    }
    const lastEnd = Math.max(...evidence.map((event) => event.startTime + event.duration));
    advanceClock(harness, Math.ceil(lastEnd - windowStart) + 1);

    const stopped = await harness.stopCapture(created.id, {
      timeoutMs: HARNESS_TIMEOUTS.pipeline,
    });
    if (isErr(stopped)) {
      throw new Error(`capture.stop was refused (${stopped.error.code}): ${stopped.error.message}`);
    }

    // The summary the stop answered covers the whole capture: every stored
    // event, and exactly the store's own count of every kind.
    const stamp = harness.repos.telemetry.captureStamp(created.id, captureId);
    const kinds = harness.repos.telemetry.countByKind(created.id, captureId);
    if (isErr(stamp) || isErr(kinds)) {
      throw new Error('the capture’s stored counts could not be read');
    }
    expect(stamp.value.count).toBe(evidence.length);
    const { summary: answered } = stopped.value;
    expect(answered.eventCount).toBe(stamp.value.count);
    expect(answered.kindCounts).toEqual(kinds.value);
    expect(answered.coverage).toMatchObject({
      storedEvents: stamp.value.count,
      summarizedEvents: stamp.value.count,
      complete: true,
    });
    for (const event of reproduction) {
      expect(answered.kindCounts[event.kind], event.kind).toBeGreaterThan(0);
    }
    for (const tier of [TIER.browser, TIER.server, TIER.db]) {
      expect(answered.tierCounts[tier], tier).toBeGreaterThan(0);
    }

    // The stored capture holds the same summary, and no row calls it incomplete.
    await waitForRecord(
      editor,
      created.id,
      (record) => record.status === STATUS.generated || record.status === STATUS.failed,
      HARNESS_TIMEOUTS.pipeline * 2,
    );
    const stored = harness.repos.sessions.get(created.id);
    if (isErr(stored) || stored.value === undefined) {
      throw new Error('the session could not be read from the store');
    }
    expect(stored.value.status).toBe(STATUS.generated);
    const storedSummary = stored.value.captures.find(
      (capture) => capture.id === captureId,
    )?.summary;
    expect(storedSummary?.eventCount).toBe(stamp.value.count);
    expect(storedSummary?.coverage?.complete).toBe(true);
    expect(await editor.flush()).toBe(true);
    const captureRows = progressRows(editor, created.id).filter(
      (row) => row.stage === STAGE.capture,
    );
    expect(captureRows.map((row) => row.status)).not.toContain(ROW.failed);
    expect(captureRows.some((row) => /incomplete/iu.test(row.message))).toBe(false);

    const ended = await harness.endSession(created.id);
    if (isErr(ended)) {
      throw new Error(`session.end was refused (${ended.error.code})`);
    }
    expect(ended.value.cleanup).toBe(CLEANUP.clean);
    await assertTreeUnchanged(copy.root, before);
  }, 180_000);
});

/**
 * The real rules-based provider, except that Stage 1's answer is classified:
 * its category is the one last set through `classifyAs` — standing in for a
 * Stage 1 that classifies the question instead of answering the rules'
 * `'other'` — and its signals include the interaction signal, as the rules
 * add it for any project with event handlers. Every other stage, and every
 * other field of the understanding — the entities and search hints
 * investigation is seeded from — is the rules' own, so the pipeline runs as it
 * does under `DEBUGGEN_PROVIDER=deterministic`. The answer still passes Stage
 * 1's own validation gate; an answer the rules could not give is passed on
 * untouched.
 */
function classifyingProvider(): {
  readonly provider: ModelProvider;
  readonly classifyAs: (category: ProblemUnderstanding['category']) => void;
  readonly classified: () => number;
} {
  const rules = createDeterministicProvider();
  if (isErr(rules)) {
    throw new Error(`The rules-based provider could not be built (${rules.error.code}).`);
  }
  const base = rules.value;
  let category: ProblemUnderstanding['category'] | undefined;
  let classified = 0;
  const generateStructured: ModelProvider['generateStructured'] = async (schema, request) => {
    const answered = await base.generateStructured(schema, request);
    if (request.metadata.stage !== STAGE.understand || isErr(answered) || category === undefined) {
      return answered;
    }
    const understood = problemUnderstandingSchema.safeParse(answered.value.raw);
    if (!understood.success) {
      return answered;
    }
    const signals = understood.data.signalsNeeded;
    const raw: ProblemUnderstanding = problemUnderstandingSchema.parse({
      ...understood.data,
      category,
      signalsNeeded: signals.includes('interactions') ? signals : ['interactions', ...signals],
    });
    classified += 1;
    return ok({
      raw,
      model: answered.value.model,
      providerId: answered.value.providerId,
      ...(answered.value.usage === undefined ? {} : { usage: answered.value.usage }),
    });
  };
  return {
    provider: {
      id: base.id,
      generateText: (request) => base.generateText(request),
      generateStructured,
      callTools: (request, tools) => base.callTools(request, tools),
    },
    classifyAs: (next) => {
      category = next;
    },
    classified: () => classified,
  };
}

/** What {@link captureIdleRenders} captured and what the stop answered. */
interface IdleCapture {
  readonly captureId: string;
  readonly mark: number;
  readonly eventCount: number;
}

/**
 * Captures a page that re-renders on its own while nobody touches it: renders
 * and commits, relayed by the tab's page agent inside the window, and no
 * interaction. Answers once `capture.stop` has summarised them.
 */
async function captureIdleRenders(target: Harness, ready: ReadySession): Promise<IdleCapture> {
  const { editor, tab, session } = ready;
  const mark = editor.received.length;
  const started = await target.startCapture(session.id);
  if (isErr(started)) {
    throw new Error(`capture.start was refused (${started.error.code}): ${started.error.message}`);
  }
  await waitForFrame(editor, 'capture.started', session.id, mark);
  const windowStart = openCaptureStart(target, session.id);

  const reactKinds: readonly string[] = telemetryKindsForSignal('react');
  const renders = readTelemetryBatch(RENDERS_BATCH).filter((event) =>
    reactKinds.includes(event.kind),
  );
  const idle = freshCopyOf(renders, windowStart + 1, new Map());
  expect(idle.length).toBeGreaterThan(0);
  const relayed = await target.ingestFromAgent(tab.client, idle);
  expect(relayed.sent.ok).toBe(true);
  expect(relayed.settled).toBe(true);
  expect(relayed.errors).toEqual([]);
  const lastEnd = Math.max(...idle.map((event) => event.startTime + event.duration));
  advanceClock(target, Math.ceil(lastEnd - windowStart) + 1);

  const stopped = await target.stopCapture(session.id);
  if (isErr(stopped)) {
    throw new Error(`capture.stop was refused (${stopped.error.code}): ${stopped.error.message}`);
  }
  const { summary } = stopped.value;
  expect(summary.eventCount).toBe(idle.length);
  for (const kind of telemetryKindsForSignal('interactions')) {
    expect(summary.kindCounts[kind], kind).toBe(0);
  }
  return { captureId: started.value.captureId, mark, eventCount: summary.eventCount };
}

/** Ends a session through the real cleanup and proves its copy is byte-identical again. */
async function endAndVerify(target: Harness, ready: ReadySession): Promise<void> {
  const ended = await target.endSession(ready.session.id);
  if (isErr(ended)) {
    throw new Error(`session.end was refused (${ended.error.code})`);
  }
  expect(ended.value.cleanup).toBe(CLEANUP.clean);
  await assertTreeUnchanged(ready.copy.root, ready.before);
}

describe('a classified interaction question whose capture holds only background renders', () => {
  /** A service whose Stage 1 classifies the question and whose other stages answer as the rules do. */
  let classified: Harness;
  let classifying: ReturnType<typeof classifyingProvider>;

  beforeAll(async () => {
    classifying = classifyingProvider();
    classified = await startHarness({ provider: classifying.provider });
  }, HARNESS_TIMEOUTS.boot * 2);

  afterAll(async () => {
    await classified.assertNoLeaks();
  });

  it(`is empty for a performance question: ${route('capture.stop')} skips analysis, returns to ready and says so in AAP §0.5.5's words`, async () => {
    // The slow-button question of OBS-F10, classified: renders of a page
    // nobody touched are not a reproduction of the click it is about.
    classifying.classifyAs('performance');
    const ready = await openReadySession(classified, TAB_ID + 4, 'doc_lifecycle000000005');
    const { editor, session } = ready;
    expect(classifying.classified()).toBe(1);
    expect(session.understanding?.category).toBe('performance');
    expect(session.understanding?.signalsNeeded).toContain('interactions');

    const { captureId, mark } = await captureIdleRenders(classified, ready);
    await waitForRecord(
      editor,
      session.id,
      (record) =>
        record.status === STATUS.ready &&
        record.captures.some(
          (capture) => capture.id === captureId && capture.stoppedAt !== undefined,
        ),
    );
    expect(await editor.flush()).toBe(true);

    // The developer is told, in AAP §0.5.5's words, and nothing was analysed.
    const rows = progressRows(editor, session.id, mark);
    expect(rows).toContainEqual({
      stage: STAGE.capture,
      status: ROW.done,
      message: EMPTY_CAPTURE_MESSAGE,
    });
    expect(rows.map((row) => row.stage)).not.toContain(STAGE.analyze);
    expect(rows.map((row) => row.stage)).not.toContain(STAGE['generate-panel']);
    expect(framesOf(editor, 'analysis.completed', session.id)).toEqual([]);
    expect(framesOf(editor, 'panel.generated', session.id)).toEqual([]);
    const trail = statusTrail(editor, session.id);
    expect(trail.slice(-3)).toEqual([STATUS.ready, STATUS.capturing, STATUS.ready]);
    expect(trail).not.toContain(STATUS.analyzing);
    const analyses = classified.repos.panels.listAnalyses(session.id);
    const panels = classified.repos.panels.listPanels(session.id);
    expect(isErr(analyses) ? undefined : analyses.value).toEqual([]);
    expect(isErr(panels) ? undefined : panels.value).toEqual([]);

    await endAndVerify(classified, ready);
  }, 120_000);

  it('holds evidence for a rendering question: the same idle renders are analysed and a panel generated', async () => {
    // A rendering question is answered by the renders the page records on its
    // own, so the interaction it lists among its signals is not demanded.
    classifying.classifyAs('rendering');
    const ready = await openReadySession(classified, TAB_ID + 5, 'doc_lifecycle000000006');
    const { editor, session } = ready;
    expect(classifying.classified()).toBe(2);
    expect(session.understanding?.category).toBe('rendering');
    expect(session.understanding?.signalsNeeded).toContain('interactions');

    const { mark } = await captureIdleRenders(classified, ready);
    const { session: settled } = (
      await waitForRecord(
        editor,
        session.id,
        (record) => record.status === STATUS.generated || record.status === STATUS.failed,
      )
    ).payload;
    expect(await editor.flush()).toBe(true);
    const rows = progressRows(editor, session.id, mark);
    expect(rows.map((row) => row.message)).not.toContain(EMPTY_CAPTURE_MESSAGE);
    expect(rows.filter((row) => row.status === ROW.failed)).toEqual([]);
    expect(settled.status).toBe(STATUS.generated);
    expect(rows.map((row) => row.stage)).toContain(STAGE.analyze);
    expect(framesOf(editor, 'analysis.completed', session.id)).toHaveLength(1);
    expect(framesOf(editor, 'panel.generated', session.id)).toHaveLength(1);

    await endAndVerify(classified, ready);
  }, 120_000);
});

/* -------------------------------------------------------------------------------------------------
 * Ending a session while its pipeline is still running is a cancellation, never a failure
 * ---------------------------------------------------------------------------------------------- */

/**
 * The real rules-based provider, except that Stage 3's model call is held
 * until the call's own signal aborts — standing in for a plan the model is
 * still writing when the developer ends the session — and is then passed to
 * the rules, which answer an abandoned call as the model boundary does
 * (`MODEL_UNAVAILABLE`, with no `reason: "aborted"`). Every other stage answers
 * as under `DEBUGGEN_PROVIDER=deterministic`. `planning` resolves once the
 * held call has been made, so a suite can end the session while the pipeline
 * is certainly still planning.
 */
function planHoldingProvider(): {
  readonly provider: ModelProvider;
  readonly planning: Promise<void>;
  readonly held: () => number;
} {
  const rules = createDeterministicProvider();
  if (isErr(rules)) {
    throw new Error(`The rules-based provider could not be built (${rules.error.code}).`);
  }
  const base = rules.value;
  let announce: () => void = () => undefined;
  const planning = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let held = 0;
  const generateStructured: ModelProvider['generateStructured'] = async (schema, request) => {
    if (request.metadata.stage !== STAGE.plan) {
      return base.generateStructured(schema, request);
    }
    const { signal } = request;
    if (signal === undefined) {
      return err(
        new DebuggenError('INTERNAL', 'The planning call carried no signal to be held on.'),
      );
    }
    held += 1;
    announce();
    if (!signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      });
    }
    return base.generateStructured(schema, request);
  };
  return {
    provider: {
      id: base.id,
      generateText: (request) => base.generateText(request),
      generateStructured,
      callTools: (request, tools) => base.callTools(request, tools),
    },
    planning,
    held: () => held,
  };
}

describe(`a ${route('session.end')} while the pipeline is still planning`, () => {
  /** A service whose Stage 3 model call waits for the session's end. */
  let holding: Harness;
  let planner: ReturnType<typeof planHoldingProvider>;

  beforeAll(async () => {
    planner = planHoldingProvider();
    holding = await startHarness({ provider: planner.provider });
  }, HARNESS_TIMEOUTS.boot * 2);

  afterAll(async () => {
    await holding.assertNoLeaks();
  });

  it('reports the planning stage as cancelled by the end — never instrumentation.failed, never failed — and ends clean', async () => {
    const copy = await holding.copyFixtureProject();
    const before = await snapshotTree(copy.root);
    const launched = await holding.launchDevServer(copy.root);
    if (isErr(launched)) {
      throw new Error(`the dev server did not launch (${launched.error.code})`);
    }
    const editor = await holding.editor(copy.root);
    const created = await holding.createSession({ projectRoot: copy.root, question: QUESTION });

    // The pipeline is inside Stage 3, waiting on its model call.
    await planner.planning;
    await waitForRecord(editor, created.id, (record) => record.status === STATUS.planning);

    const ended = await holding.endSession(created.id);
    if (isErr(ended)) {
      throw new Error(`session.end was refused (${ended.error.code}): ${ended.error.message}`);
    }
    expect(ended.value.cleanup).toBe(CLEANUP.clean);
    await waitForRecord(editor, created.id, (record) => record.status === STATUS.ended);
    expect(await editor.flush()).toBe(true);
    expect(planner.held()).toBe(1);

    // The status went from planning straight to ended: nothing filed it failed.
    const trail = statusTrail(editor, created.id);
    expect(trail.slice(-2)).toEqual([STATUS.planning, STATUS.ended]);
    expect(trail).not.toContain(STATUS.failed);

    // No failure was sent or stored — neither a failed row nor instrumentation.failed.
    const rows = progressRows(editor, created.id);
    expect(rows.filter((row) => row.status === ROW.failed)).toEqual([]);
    expect(framesOf(editor, 'instrumentation.failed', created.id)).toEqual([]);
    const stored = holding.repos.sessions.listProgress(created.id);
    if (isErr(stored)) {
      throw new Error('the stored progress could not be read');
    }
    expect(stored.value.filter((entry) => entry.status === ROW.failed)).toEqual([]);

    // The stage the end stopped is reported once, as cancelled, inside the
    // "Preparing instrumentation" group — before the session is announced ended.
    const cancelled = buildStageCancelledRow(STAGE.plan, 'session-ended');
    const expected: ProgressRow = { ...cancelled, stage: PROGRESS_STAGE_GROUPS[cancelled.stage] };
    expect(expected).toStrictEqual({
      stage: STAGE.instrument,
      status: ROW.done,
      message: 'Planning instrumentation cancelled: the session was ended.',
      detail: CANCELLATION_COPY_BY_CAUSE['session-ended'].detail,
    });
    const clauses = Object.values(CANCELLATION_COPY_BY_CAUSE).map((copy) => copy.clause);
    expect(
      rows.filter((row) => clauses.some((clause) => row.message.endsWith(clause))),
    ).toStrictEqual([expected]);
    const cancelledAt = indexOfFrame(
      editor,
      'session.progress',
      created.id,
      (frame) => frame.payload.message === expected.message,
    );
    const endedAt = indexOfFrame(
      editor,
      'session.updated',
      created.id,
      (frame) => frame.payload.session.status === STATUS.ended,
    );
    expect(cancelledAt).toBeGreaterThanOrEqual(0);
    expect(cancelledAt).toBeLessThan(endedAt);

    // Nothing of the session remains in the project.
    await assertTreeUnchanged(copy.root, before);
  }, 120_000);
});
