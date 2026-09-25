/**
 * The single import surface of the Playwright `e2e` project (AAP §0.8.3
 * "End-to-end demo"): the extended `test` and `expect` every spec under
 * `tests/e2e/**` imports, the fixtures that compose this folder's seven sibling
 * modules, the ordered and exception-safe teardown that owns their lifecycle,
 * the fixture-level timeout budgets, and the curated re-export of the folder's
 * public names. It is the `e2e` counterpart of `tests/browser/fixtures.ts`.
 *
 * ## The fixture graph
 *
 * Worker-scoped — `workers: 1` and `fullyParallel: false` make that one
 * instance per run, reused by every spec file until a failure restarts the
 * worker. These hold the shared resources: one Chromium context, one service,
 * one PostgreSQL database, one `DEBUGGEN_HOME`.
 *
 * | fixture            | set up with                                                        | torn down with                  |
 * | ------------------ | ------------------------------------------------------------------ | ------------------------------- |
 * | `extensionContext` | `launchExtensionContext()` (`./chrome`)                            | `close()` — context + temp profile |
 * | `extensionId`      | `extensionContext.extensionId`                                     | —                               |
 * | `service`          | `createServiceHandle()` then `expectHealthy()` (`./service`)       | — (holds no resource)           |
 * | `demoApp`          | prerequisites → `ensureDatabase()` → `start()` via the launcher    | `stop()` via the launcher       |
 * | `sampleApp`        | `ensurePortFree()` → `start()` via the launcher                    | `stop()` via the launcher       |
 * | `pairing`          | a serialised wrapper over `ensurePaired(service, panel)`           | — (pairing is sticky)           |
 *
 * Test-scoped — per-test handles, each released before the next test starts:
 * `serviceWorker`, `appPage`, `samplePage`, `openPanelPage`, `panel`,
 * `editorClient`, `sessions` and `resetExtension` (see {@link E2ETestFixtures}).
 *
 * ## Every fixture is lazy — `clean-clone.spec.ts` pays for nothing
 *
 * No fixture here is `{ auto: true }`, and this module does no work when it is
 * imported: no top-level `await`, no I/O, no environment read, no handle
 * constructed. Playwright instantiates a fixture only when a test (or another
 * fixture it requests) names it, so a spec that destructures only `test` and
 * `expect` — `clean-clone.spec.ts` — launches no browser, opens no socket,
 * seeds no database and starts no dev server. The one internal fixture,
 * `_testScope`, is not automatic either and does no I/O.
 *
 * ## Teardown order
 *
 * Teardown is the reverse of setup and runs in four phases whatever order
 * Playwright happens to tear the fixtures down in:
 *
 * 1. `sessions` — `SessionTracker.endAll()` ends every session the test
 *    registered, inside a live editor announcement (the `vscode` role may only
 *    end sessions under a folder a live connection announced), so no session,
 *    capture or applied patch leaks into the next spec under `workers: 1`;
 * 2. `panels` — every panel opened through `openPanelPage` is closed;
 * 3. `pages` — `appPage` and `samplePage` are closed;
 * 4. `editor` — the `editorClient` socket is closed.
 *
 * Every fixture registers its release with the internal `_testScope`
 * coordinator, and whichever fixture Playwright tears down first drains every
 * earlier phase before its own. Each step runs even when an earlier one threw;
 * the problems are aggregated and reported once — as `fixture-teardown`
 * annotations when the test already failed (so they never mask its own
 * failure), as a thrown error otherwise. The worker phase follows: the apps are
 * stopped, then the context is closed.
 *
 * ## Failure diagnostics
 *
 * Only when `testInfo.status !== testInfo.expectedStatus` — a passing test
 * attaches nothing, which keeps the uploaded `playwright-report/` small — the
 * teardown attaches, each capped and stating its cap in its first lines (see
 * {@link DIAGNOSTIC_LIMITS}): a screenshot of the most recent panels (the
 * pairing dialog and the event-details drawer masked), the tail of each
 * panel's scrubbed console log, the tail of the application page's console,
 * the editor client's message-type timeline (types, counts and first/last
 * arrival — never payloads), the last `session.progress` rows, the `endAll()`
 * cleanup report, a file-and-status summary of each session's modification
 * journal, and the service's `/health` body. Never `auth.json`, a token, a
 * pairing code, a telemetry attribute map, a diff or file contents: every
 * attached line additionally passes through a credential-shape scrubber.
 *
 * ## Relationship to `tests/browser/fixtures.ts`
 *
 * The fixture names, the worker/test scope split, the shared timeout constants
 * and the teardown discipline mirror that file. It is deliberately **not
 * imported**: it belongs to the other Playwright project, its app-start
 * contract differs (it serves a preload-free copy of the fixture app, while
 * this suite launches both apps through the product's launcher with the
 * telemetry preload attached), its `ServiceHandle` is a narrower type, and
 * importing it would evaluate its fixture graph — including its automatic
 * `_hygiene` fixture, which boots the browser. Deliberate divergences:
 *
 * - `serviceWorker` is test-scoped here, re-acquired through
 *   `extensionContext.getServiceWorker()` at the start of every test that
 *   requests it: the MV3 worker suspends after roughly 30 s idle, and a
 *   worker-scoped `Worker` would be a cached, possibly dead handle. Code that
 *   runs longer re-acquires with `extensionContext.getServiceWorker()`.
 * - `extensionContext` is `./chrome`'s {@link ExtensionContextHandle} rather
 *   than a bare `BrowserContext` (`extensionContext.context` is that).
 * - `panel` is a convenience the browser suite lacks: the DevTools surface of
 *   `appPage`'s tab, opened and paired — what `runDebugSession` requires.
 * - `resetExtension` is named for the action rather than for
 *   `resetExtensionState()`, which this module re-exports under that name.
 * - There is no automatic per-test binding reset: it would boot the browser
 *   for specs that never use it. Specs call `resetExtension()` when they need
 *   a clean binding state.
 *
 * ## Budgets
 *
 * {@link E2E_TIMEOUTS} holds the fixture-level budgets only, derived from the
 * siblings' own constants. The per-command budgets are `./repo`'s and the
 * session budgets `./session`'s ({@link DEFAULT_SESSION_TIMEOUTS}); both are
 * re-exported from here, never redefined. The direction is strictly one-way —
 * no sibling imports this module — so there is no `fixtures → session →
 * fixtures` cycle. The Playwright config owns the global `timeout` and
 * `expect.timeout`; nothing here overrides them.
 *
 * ## Two import routes
 *
 * Specs may import everything from here, and may still import a sibling by
 * path (`./helpers/session`, `./helpers/demo-app`, …): the re-exports below
 * are the same bindings, not copies. Where two siblings export one identifier
 * (`demo-app.ts` and `sample-app.ts` share ten), the demo's is re-exported
 * under its own name and the fixture app's under a `sample`-prefixed alias.
 *
 * This file declares no `test(...)` or `describe(...)` block, never sleeps,
 * writes nothing under `apps/demo-app` or `tests/fixtures/sample-next-app`
 * (AAP §0.5.1), and contains no credential (AAP §0.5.2, `pnpm check:secrets`).
 *
 * @module tests/e2e/helpers/fixtures
 */
import { test as base } from '@playwright/test';
import type { Page, TestInfo, Worker } from '@playwright/test';

import { isOpenModificationStatus } from '@debuggen/instrumentation/schema';
import type { ModificationRecord } from '@debuggen/instrumentation/schema';
import type { PanelNodeType } from '@debuggen/panel-schema';
import type { SessionProgressPayload } from '@debuggen/protocol';

import type { DebuggenTestOptions } from '../../../playwright.config';
import {
  DEVTOOLS_PAGE_READY_TIMEOUT_MS,
  PAIRING_TIMEOUT_MS,
  PANEL_CONSOLE_LINE_MAX_LENGTH,
  PANEL_CONSOLE_LOG_LIMIT,
  PANEL_READY_TIMEOUT_MS,
  TAB_RESOLVE_TIMEOUT_MS,
  WORKER_READY_TIMEOUT_MS,
  ensurePaired,
  launchExtensionContext,
  openPanelPage as openExtensionPanel,
  resetExtensionState,
  tabIdForPage,
} from './chrome';
import type {
  EnsurePairedOptions,
  ExtensionContextHandle,
  OpenPanelPageOptions,
  PairingResult,
  PanelHandle,
} from './chrome';
import {
  DEMO_APP_SETUP_TIMEOUT_MS,
  DEMO_READY_PROBE_TIMEOUT_MS,
  DEMO_STOP_TIMEOUT_MS,
  createDemoAppHandle,
  withEditorAnnouncement,
} from './demo-app';
import type { DemoAppHandle } from './demo-app';
import { repoRoot } from './repo';
import {
  PORT_RELEASE_TIMEOUT_MS,
  SAMPLE_APP_LAUNCH_TIMEOUT_MS,
  SAMPLE_APP_READY_PROBE_TIMEOUT_MS,
  SAMPLE_APP_READY_TIMEOUT_MS,
  SAMPLE_APP_STOP_TIMEOUT_MS,
  createSampleAppHandle,
} from './sample-app';
import type { SampleAppHandle } from './sample-app';
import {
  ANNOUNCEMENT_SETTLE_MS,
  EDITOR_CONNECT_TIMEOUT_MS,
  HEALTH_PROBE_TIMEOUT_MS,
  POLL_INTERVALS_MS,
  SERVICE_READY_TIMEOUT_MS,
  createEditorClient,
  createServiceHandle,
} from './service';
import type { EditorClientHandle, ServiceHandle } from './service';
import { DEFAULT_SESSION_TIMEOUTS, createSessionTracker } from './session';
import type { EndAllReport, SessionTracker } from './session';

// ---------------------------------------------------------------------------
// The curated public surface of tests/e2e/helpers — the siblings' own bindings
// ---------------------------------------------------------------------------

export { expect } from '@playwright/test';

/** Product types a spec names alongside the helpers (types only: nothing is evaluated). */
export type { ModificationRecord, PanelNodeType };

// ./repo — repository root, command runner, git enumerator, tracked-tree copy, command budgets.
export {
  BUILD_TIMEOUT_MS,
  CommandFailedError,
  GIT_COMMAND_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  INSTALL_TIMEOUT_MS,
  MIGRATE_TIMEOUT_MS,
  SEED_TIMEOUT_MS,
  SHORT_COMMAND_TIMEOUT_MS,
  TERMINATION_GRACE_MS,
  TYPECHECK_TIMEOUT_MS,
  copyTrackedTree,
  listTrackedFiles,
  repoPath,
  repoRoot,
  runCommand,
  runGit,
  runPnpm,
} from './repo';
export type {
  CommandResult,
  CopyTrackedTreeOptions,
  CopyTrackedTreeResult,
  RunCommandOptions,
} from './repo';

// ./service — the typed service client and the recording editor connection.
export { CaptureConflictError, ServiceCallError } from './service';
export type {
  EditorClientHandle,
  HealthResponse,
  MessageTypeTimelineEntry,
  PanelSpec,
  RecordedEnvelope,
  ServiceHandle,
  SessionRecord,
} from './service';

// ./chrome — the extension context, the DevTools surface, selection and the panel DOM map.
export {
  expectNoPanelErrorState,
  panelLocators,
  resetExtensionState,
  selectTarget,
  tabIdForPage,
  waitForBound,
} from './chrome';
export type {
  DevtoolsTheme,
  EnsurePairedOptions,
  ExtensionContextHandle,
  OpenPanelPageOptions,
  PairingResult,
  PanelConnectionStatus,
  PanelHandle,
  PanelLocators,
  SelectTargetOptions,
  SelectTargetResult,
  SelectedTarget,
} from './chrome';

// ./demo-app — the demo's lifecycle, restoration contract and runtime source lookup.
export { DemoAppError, sourceLineContaining } from './demo-app';
export type {
  DemoAppHandle,
  DemoAppLaunch,
  RestorationReport,
  SourceLineMatch,
  SourceLineOptions,
  TrackedFileSnapshot,
} from './demo-app';

// ./sample-app — the generalization target. `sample-app.ts` exports ten names
// `demo-app.ts` also exports (isServing, expectServing, expectPreloadAttached,
// snapshotTrackedFiles, verifyRestored, findMarkers, worktreeDirty,
// runResidualCheck, expectNoResidualInstrumentation, sourceLineContaining).
// The demo's keep their names above; the one module-level function a spec needs
// from the fixture app is aliased with a `sample` prefix, and the other nine are
// reached through the `sampleApp` handle (or by importing ./sample-app by path).
export { SampleAppError, sourceLineContaining as sampleSourceLineContaining } from './sample-app';
export type { SampleAppHandle, SampleAppLaunch } from './sample-app';

// ./session — the workflow driver, the follow-up driver, the tracker and the session budgets.
export {
  DEFAULT_SESSION_TIMEOUTS,
  SessionWorkflowError,
  askFollowUp,
  createSessionTracker,
  generatePanelNodeTypes,
  runDebugSession,
} from './session';
export type {
  AskFollowUpOptions,
  DebugSessionOutcome,
  EndAllReport,
  FollowUpPath,
  PanelNodeTypesResult,
  ReadinessRoute,
  RunDebugSessionOptions,
  SessionEndEntry,
  SessionInteraction,
  SessionInteractionContext,
  SessionStageRecord,
  SessionTimeouts,
  SessionTracker,
} from './session';

// ./assertions — the whole shared assertion vocabulary, listed explicitly so a
// future name clash with another sibling fails to compile instead of shadowing.
export {
  DEFAULT_ANCESTOR_MAX_DEPTH,
  PERMITTED_VISUALIZATION_OVERLAP,
  ancestorChainOf,
  buildSpanIndex,
  collectSpanIdCollisions,
  describeEvent,
  duplicateGroupsOf,
  eventsOfKind,
  expectAncestorKinds,
  expectAnyNodeType,
  expectDisjointVisualizations,
  expectDuplicateGroup,
  expectEventOfKind,
  expectEvidenceResolves,
  expectFactsAndHypothesesSeparate,
  expectHexId,
  expectMetricAvailable,
  expectMetricUnavailable,
  expectNoSpanIdCollisions,
  expectNodeTypes,
  expectQueryGroup,
  expectRenderStat,
  expectRenderTrigger,
  expectSingleTrace,
  expectSourceLocationShape,
  expectValidPanelSpec,
  flattenTrace,
  metricValue,
  nodeTypesOf,
  queryGroupMatching,
  renderStatFor,
  traceIdsOf,
  visualizationNodeTypesOf,
} from './assertions';
export type {
  AncestorChainOptions,
  AncestorKindStep,
  AncestorKindsOptions,
  DisjointVisualizationOptions,
  DuplicateGroupOptions,
  EventOfKindOptions,
  EvidenceOptions,
  Findings,
  MetricOptions,
  NodeTypesOptions,
  QueryGroupOptions,
  RenderStatOptions,
  RenderTriggerOptions,
  SingleTraceOptions,
  SourceLocationShapeOptions,
  SpanIdCollision,
  SpanSource,
  ValidPanelSpecOptions,
} from './assertions';

// ---------------------------------------------------------------------------
// Fixture-level budgets — derived from the siblings' constants, never restated
// ---------------------------------------------------------------------------

/**
 * How many sequential phases `ensurePaired` may each spend a whole
 * `PAIRING_TIMEOUT_MS` on: the pill settling, clearing a refused credential,
 * the dialog opening, and the pill reaching "Connected".
 */
const PAIRING_PHASES = 4;

/**
 * Chromium's cold start on a busy CI host, before the MV3 worker even begins
 * to register. The only budget this module owns outright: no sibling bounds
 * the browser launch itself.
 */
const BROWSER_COLD_START_MS = 45_000;

/**
 * How many sessions one test's teardown is budgeted to end, each within
 * `SessionTimeouts.end`. A spec that creates more should call
 * `sessions.end(id)` as it goes rather than leave them all to teardown.
 */
const TEARDOWN_SESSION_ALLOWANCE = 3;

/** Slack for the failure diagnostics a teardown attaches (screenshots, `/health`, journal reads). */
const TEARDOWN_DIAGNOSTICS_MS = 30_000;

/** Every session budget laid end to end: the worst case of one `runDebugSession` plus its end. */
const SESSION_WORKFLOW_BUDGET_MS = Object.values(DEFAULT_SESSION_TIMEOUTS).reduce(
  (total, budget) => total + budget,
  0,
);

/** The fixture-level budgets of the `e2e` project, in milliseconds. */
export interface E2ETimeouts {
  /**
   * The `extensionContext` worker fixture: Chromium's cold start plus
   * `WORKER_READY_TIMEOUT_MS` for the MV3 worker to register.
   */
  readonly extensionLaunch: number;
  /**
   * Reaching the service: `SERVICE_READY_TIMEOUT_MS` of `/health` polling,
   * then `EDITOR_CONNECT_TIMEOUT_MS` for an editor socket and
   * `ANNOUNCEMENT_SETTLE_MS` for its workspace announcement to take effect.
   */
  readonly connection: number;
  /**
   * The `demoApp` / `sampleApp` worker fixtures, whichever is longer: the
   * demo's migrate + seed + launch + first compile (`DEMO_APP_SETUP_TIMEOUT_MS`)
   * plus its stop, or the fixture app's port release + stop + launch + ready.
   */
  readonly devServerReady: number;
  /**
   * One navigation of `appPage` / `samplePage`: the bound on one readiness GET
   * of either app (`DEMO_READY_PROBE_TIMEOUT_MS`,
   * `SAMPLE_APP_READY_PROBE_TIMEOUT_MS`), which may wait out a first compile.
   */
  readonly pageReady: number;
  /**
   * The `panel` fixture: resolving the tab (`TAB_RESOLVE_TIMEOUT_MS`), the
   * DevTools page and the panel document becoming interactive
   * (`DEVTOOLS_PAGE_READY_TIMEOUT_MS`, `PANEL_READY_TIMEOUT_MS`), and pairing
   * (up to four `PAIRING_TIMEOUT_MS` phases).
   */
  readonly panelOpen: number;
  /**
   * One test's ordered teardown: three sessions ended within
   * `SessionTimeouts.end` each, plus the failure diagnostics.
   */
  readonly teardown: number;
  /** The back-off intervals of every `expect.poll` in this folder (`./service`'s `POLL_INTERVALS_MS`). */
  readonly pollIntervals: readonly number[];
  /**
   * For `test.setTimeout` in a spec that runs one whole workflow: every
   * `SessionTimeouts` budget laid end to end, plus `panelOpen` and `pageReady`.
   */
  readonly longTestTimeoutMs: number;
}

const PANEL_OPEN_MS =
  TAB_RESOLVE_TIMEOUT_MS +
  DEVTOOLS_PAGE_READY_TIMEOUT_MS +
  PANEL_READY_TIMEOUT_MS +
  PAIRING_PHASES * PAIRING_TIMEOUT_MS;

const PAGE_READY_MS = Math.max(DEMO_READY_PROBE_TIMEOUT_MS, SAMPLE_APP_READY_PROBE_TIMEOUT_MS);

/**
 * The fixture-level budgets (see {@link E2ETimeouts}). The per-command budgets
 * are `./repo`'s and the session budgets `./session`'s; both are re-exported
 * above rather than repeated here.
 */
export const E2E_TIMEOUTS: E2ETimeouts = Object.freeze({
  extensionLaunch: BROWSER_COLD_START_MS + WORKER_READY_TIMEOUT_MS,
  connection: SERVICE_READY_TIMEOUT_MS + EDITOR_CONNECT_TIMEOUT_MS + ANNOUNCEMENT_SETTLE_MS,
  devServerReady: Math.max(
    DEMO_APP_SETUP_TIMEOUT_MS + DEMO_STOP_TIMEOUT_MS,
    PORT_RELEASE_TIMEOUT_MS +
      SAMPLE_APP_STOP_TIMEOUT_MS +
      SAMPLE_APP_LAUNCH_TIMEOUT_MS +
      SAMPLE_APP_READY_TIMEOUT_MS,
  ),
  pageReady: PAGE_READY_MS,
  panelOpen: PANEL_OPEN_MS,
  teardown: TEARDOWN_SESSION_ALLOWANCE * DEFAULT_SESSION_TIMEOUTS.end + TEARDOWN_DIAGNOSTICS_MS,
  pollIntervals: POLL_INTERVALS_MS,
  longTestTimeoutMs: SESSION_WORKFLOW_BUDGET_MS + PANEL_OPEN_MS + PAGE_READY_MS,
});

/**
 * The fixture timeout of `appPage`, `samplePage`, `openPanelPage`,
 * `editorClient` and `sessions`. A fixture with its own `timeout` gets its own
 * time slot for setup and another for teardown, so the ordered teardown (which
 * may end sessions) never runs on whatever the test body left of its budget.
 */
const TEST_FIXTURE_TIMEOUT_MS = Math.max(
  E2E_TIMEOUTS.teardown,
  E2E_TIMEOUTS.pageReady,
  E2E_TIMEOUTS.connection,
);

// ---------------------------------------------------------------------------
// Diagnostic bounds
// ---------------------------------------------------------------------------

/** The caps of every failure attachment; each attachment states the caps it applied. */
export interface DiagnosticLimits {
  /** How many of the most recently opened, still-open panels are screenshotted. */
  readonly panels: number;
  /** How many trailing panel console lines are attached per panel. */
  readonly panelConsoleTailLines: number;
  /** How many application-page console lines are retained per page (oldest dropped first). */
  readonly pageConsoleLines: number;
  /** How many trailing application-page console lines are attached. */
  readonly pageConsoleTailLines: number;
  /** The longest console line retained, in characters. */
  readonly lineLength: number;
  /** How many trailing `session.progress` rows are attached. */
  readonly progressRows: number;
  /** The longest progress message (and detail) quoted, in characters. */
  readonly progressTextLength: number;
  /** How many message types the timeline lists. */
  readonly timelineTypes: number;
  /** How many sessions the modification summary covers (the most recently registered). */
  readonly sessions: number;
  /** How many modification records are listed per session. */
  readonly modificationsPerSession: number;
  /** The largest text attachment, in characters. */
  readonly attachmentChars: number;
  /** The bound on one diagnostic screenshot, in milliseconds. */
  readonly screenshotTimeoutMs: number;
}

/** The caps applied to failure diagnostics (see {@link DiagnosticLimits}). */
export const DIAGNOSTIC_LIMITS: DiagnosticLimits = Object.freeze({
  panels: 3,
  panelConsoleTailLines: 50,
  pageConsoleLines: PANEL_CONSOLE_LOG_LIMIT,
  pageConsoleTailLines: 50,
  lineLength: PANEL_CONSOLE_LINE_MAX_LENGTH,
  progressRows: 20,
  progressTextLength: 240,
  timelineTypes: 64,
  sessions: 10,
  modificationsPerSession: 50,
  attachmentChars: 32_768,
  screenshotTimeoutMs: 5_000,
});

/** The prefix of every attachment this module adds, so the report groups them. */
const DIAGNOSTIC_PREFIX = 'e2e-diagnostics-';

/** The longest error description quoted in a teardown problem, in characters. */
const MAX_ERROR_TEXT = 500;

// ---------------------------------------------------------------------------
// Text hygiene — bounded and credential-free
// ---------------------------------------------------------------------------

/** The replacement for anything {@link scrub} removes. */
const REDACTED = '[redacted]';

/**
 * A run shaped like a credential: 32 or more base64url / base64 token
 * characters. The service's credentials are 32 random bytes rendered base64url
 * (43 characters), so every one of them is caught; `/` and `.` are not in the
 * class, so a project-relative path survives segment by segment.
 */
const TOKEN_RUN = /[A-Za-z0-9_+-]{32,}={0,2}/g;

/** Userinfo in a URL: a user name and a password between the `//` and the `@` of the authority. */
const URL_USERINFO = /\/\/[^\s/@:]+:[^\s/@]+@/g;

/** An HTTP authorization value (`Bearer …`, `Basic …`). */
const AUTH_VALUE = /\b(Bearer|Basic)\s+[^\s,;"']+/gi;

/** `text` with every credential-shaped value replaced by {@link REDACTED}. */
function scrub(text: string): string {
  return text
    .replace(AUTH_VALUE, (_match: string, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(URL_USERINFO, `//${REDACTED}@`)
    .replace(TOKEN_RUN, REDACTED);
}

/** `text` cut to `max` characters, with an ellipsis when it was longer. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** A bounded, scrubbed one-line description of a thrown value. */
function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return truncate(scrub(text).replace(/\s+/g, ' ').trim(), MAX_ERROR_TEXT);
}

/** An epoch-millisecond instant as ISO-8601 (or the raw number when it is not a valid instant). */
function isoOf(epochMs: number): string {
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : String(epochMs);
}

/** A configured option, or `undefined` when it was left at the empty default. */
function nonEmpty(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * A bounded, scrubbed line buffer: at most `limit` lines of at most
 * `maxLength` characters each, the oldest dropped first and counted.
 */
class BoundedLines {
  readonly #lines: string[] = [];
  readonly #limit: number;
  readonly #maxLength: number;
  #dropped = 0;

  constructor(limit: number, maxLength: number) {
    this.#limit = limit;
    this.#maxLength = maxLength;
  }

  /** Append one line, scrubbed and truncated; evict the oldest beyond the limit. */
  push(line: string): void {
    this.#lines.push(truncate(scrub(line), this.#maxLength));
    while (this.#lines.length > this.#limit) {
      this.#lines.shift();
      this.#dropped += 1;
    }
  }

  /** The last `count` retained lines, oldest first. */
  tail(count: number): string[] {
    return this.#lines.slice(-count);
  }

  /** How many lines are retained. */
  get size(): number {
    return this.#lines.length;
  }

  /** How many lines were evicted. */
  get dropped(): number {
    return this.#dropped;
  }
}

/** Forward a page's console messages and uncaught exceptions into `log`. */
function forwardPageLog(page: Page, log: BoundedLines): void {
  page.on('console', (message) => {
    log.push(`console.${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    log.push(`uncaught ${error.name}: ${error.message}`);
  });
}

// ---------------------------------------------------------------------------
// Ordered, exception-safe teardown
// ---------------------------------------------------------------------------

/** Whether the running test ended other than as expected (failed, timed out, unexpectedly passed…). */
function testFailed(testInfo: TestInfo): boolean {
  return testInfo.status !== testInfo.expectedStatus;
}

/** One labelled teardown step. */
type TeardownStep = readonly [label: string, run: () => Promise<unknown>];

/** Run every step in order — each even when an earlier one threw — and collect what went wrong. */
async function runSteps(steps: readonly TeardownStep[]): Promise<string[]> {
  const problems: string[] = [];
  for (const [label, run] of steps) {
    try {
      await run();
    } catch (error) {
      problems.push(`${label}: ${describeError(error)}`);
    }
  }
  return problems;
}

/** Throw one error naming every problem, when there is any. */
function throwIfProblems(owner: string, problems: readonly string[]): void {
  if (problems.length > 0) {
    throw new Error(
      `${owner}: ${String(problems.length)} teardown step(s) failed — ${problems.join('; ')}`,
    );
  }
}

/**
 * Report teardown problems without ever masking the test's own outcome: as
 * `fixture-teardown` annotations when the test already failed (or its setup
 * did), as a thrown error when it passed — a context that will not close or a
 * session that will not end after a green test is a real failure. A worker
 * fixture has no test to annotate, so its problems are thrown, or written to
 * stderr when its setup already threw.
 */
function reportProblems(
  owner: string,
  testInfo: TestInfo | undefined,
  problems: readonly string[],
  setupFailed: boolean,
): void {
  if (problems.length === 0) {
    return;
  }
  const annotate = setupFailed || (testInfo !== undefined && testFailed(testInfo));
  if (!annotate) {
    throwIfProblems(`${owner} fixture`, problems);
    return;
  }
  for (const problem of problems) {
    const description = `${owner}: ${problem}`;
    if (testInfo === undefined) {
      process.stderr.write(`[tests/e2e/helpers/fixtures] teardown: ${description}\n`);
    } else {
      testInfo.annotations.push({ type: 'fixture-teardown', description });
    }
  }
}

/**
 * The lifecycle of one fixture: run `body` (its setup and `use`), then — no
 * matter how `body` ended — `teardown`, then report teardown problems with
 * {@link reportProblems}. A setup failure is re-thrown after teardown, so the
 * test reports the setup error rather than a teardown one.
 */
async function guarded(
  owner: string,
  testInfo: TestInfo | undefined,
  body: () => Promise<void>,
  teardown: () => Promise<readonly string[]>,
): Promise<void> {
  let setupFailure: { readonly error: unknown } | undefined;
  try {
    await body();
  } catch (error) {
    setupFailure = { error };
  }
  let problems: readonly string[];
  try {
    problems = await teardown();
  } catch (error) {
    problems = [describeError(error)];
  }
  reportProblems(owner, testInfo, problems, setupFailure !== undefined);
  if (setupFailure !== undefined) {
    throw setupFailure.error;
  }
}

/** The four phases of a test's teardown, in the order they must run. */
const TEARDOWN_PHASES = ['sessions', 'panels', 'pages', 'editor'] as const;

/** One phase of a test's teardown. */
type TeardownPhase = (typeof TEARDOWN_PHASES)[number];

/** A release a test-scoped fixture registered for its phase. */
interface TeardownAction {
  readonly phase: TeardownPhase;
  readonly label: string;
  readonly run: () => Promise<void>;
}

/**
 * The per-test teardown coordinator behind the `_testScope` fixture. Every
 * test-scoped fixture that holds something registers its release here; each
 * fixture's own teardown then calls {@link runThrough} with its phase, which
 * first runs every pending release of an earlier phase. Whichever fixture
 * Playwright happens to tear down first, sessions therefore end before a panel
 * closes, panels close before a page, and pages close before the editor
 * socket. Creating it does no I/O.
 */
interface TestScope {
  /** Register a release for `phase`; releases of one phase run in registration order. */
  onTeardown(phase: TeardownPhase, label: string, run: () => Promise<void>): void;
  /**
   * Register, once per test, the failure-only attachment of `service`'s
   * `/health` body (first phase, so it describes the service before cleanup).
   */
  noteService(service: ServiceHandle, testInfo: TestInfo): void;
  /**
   * Run every pending release of `phase` and of every earlier phase, each
   * exactly once, and resolve with the problems this call produced. Calls are
   * serialised; a release never runs twice.
   */
  runThrough(phase: TeardownPhase): Promise<readonly string[]>;
}

/** Create the coordinator of one test (see {@link TestScope}). */
function createTestScope(): TestScope {
  const pending: TeardownAction[] = [];
  let serviceNoted = false;
  let chain: Promise<unknown> = Promise.resolve();

  const drain = async (through: TeardownPhase): Promise<string[]> => {
    const last = TEARDOWN_PHASES.indexOf(through);
    const problems: string[] = [];
    for (const phase of TEARDOWN_PHASES.slice(0, last + 1)) {
      let next = pending.find((action) => action.phase === phase);
      while (next !== undefined) {
        const action = next;
        pending.splice(pending.indexOf(action), 1);
        try {
          await action.run();
        } catch (error) {
          problems.push(`${action.label}: ${describeError(error)}`);
        }
        next = pending.find((candidate) => candidate.phase === phase);
      }
    }
    return problems;
  };

  return {
    onTeardown(phase, label, run): void {
      pending.push({ phase, label, run });
    },

    noteService(service, testInfo): void {
      if (serviceNoted) {
        return;
      }
      serviceNoted = true;
      pending.push({
        phase: 'sessions',
        label: 'attach the service /health body',
        run: () => attachServiceHealth(service, testInfo),
      });
    },

    runThrough(phase): Promise<readonly string[]> {
      const result = chain.then(
        () => drain(phase),
        () => drain(phase),
      );
      chain = result.catch(() => undefined);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Failure diagnostics — bounded, credential-free, attached only on failure
// ---------------------------------------------------------------------------

/**
 * Attach `lines` as one text attachment: a header naming what it is, the caps
 * applied and what is excluded, then the lines — each scrubbed — and the whole
 * cut at `DIAGNOSTIC_LIMITS.attachmentChars`.
 */
async function attachText(
  testInfo: TestInfo,
  name: string,
  bounds: string,
  lines: readonly string[],
): Promise<void> {
  const header = [
    `# ${name}`,
    `# bounded: ${bounds}; at most ${String(DIAGNOSTIC_LIMITS.attachmentChars)} characters in all`,
    '# credential-free: no token, pairing code, auth.json, header value, attribute map, diff or file contents; credential-shaped runs are redacted',
    '',
  ];
  let body = [...header, ...lines.map(scrub)].join('\n');
  if (body.length > DIAGNOSTIC_LIMITS.attachmentChars) {
    const marker = `\n… truncated at ${String(DIAGNOSTIC_LIMITS.attachmentChars)} characters`;
    body = `${body.slice(0, DIAGNOSTIC_LIMITS.attachmentChars - marker.length)}${marker}`;
  }
  await testInfo.attach(`${DIAGNOSTIC_PREFIX}${name}.txt`, {
    body: `${body}\n`,
    contentType: 'text/plain',
  });
}

/** Settle `promise`, or reject after `ms` with a message naming `label`; the timer never outlives the call. */
async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} did not answer within ${String(ms)} ms`));
    }, ms);
  });
  // A late rejection of the loser must not surface as an unhandled rejection.
  void promise.catch(() => undefined);
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** On failure, attach the service's `/health` body (unauthenticated, credential-free by definition). */
async function attachServiceHealth(service: ServiceHandle, testInfo: TestInfo): Promise<void> {
  if (!testFailed(testInfo)) {
    return;
  }
  let lines: string[];
  try {
    const health = await withDeadline(service.health(), HEALTH_PROBE_TIMEOUT_MS, 'GET /health');
    lines = JSON.stringify(health, null, 2).split('\n');
  } catch (error) {
    lines = [`GET /health failed: ${describeError(error)}`];
  }
  await attachText(
    testInfo,
    'service-health',
    `the unauthenticated GET /health body only, within ${String(HEALTH_PROBE_TIMEOUT_MS)} ms`,
    [`service: ${service.baseUrl}`, ...lines],
  );
}

/** The editor client's message-type timeline: types, counts and first/last arrival — never payloads. */
function timelineLines(client: EditorClientHandle): string[] {
  const rows = client.timeline();
  const shown = rows.slice(0, DIAGNOSTIC_LIMITS.timelineTypes);
  return [
    `connection state: ${client.state()}`,
    `envelopes dropped on overflow: ${String(client.dropped())}`,
    `protocol errors recorded: ${String(client.protocolErrors().length)}`,
    '',
    'type\tcount\tfirst received\tlast received',
    ...shown.map(
      (row) =>
        `${row.type}\t${String(row.count)}\t${isoOf(row.firstReceivedAt)}\t${isoOf(row.lastReceivedAt)}`,
    ),
    ...(rows.length > shown.length ? [`(+${String(rows.length - shown.length)} more types)`] : []),
  ];
}

/** One `session.progress` row as a bounded line: time, session, stage/status and the service's prose. */
function progressLine(ts: number, payload: SessionProgressPayload): string {
  const detail =
    payload.detail === undefined
      ? ''
      : ` — ${truncate(payload.detail, DIAGNOSTIC_LIMITS.progressTextLength)}`;
  return `${isoOf(ts)} ${payload.sessionId} ${payload.stage}/${payload.status}: ${truncate(payload.message, DIAGNOSTIC_LIMITS.progressTextLength)}${detail}`;
}

/** The last `session.progress` rows the editor client recorded, oldest first. */
function progressLines(client: EditorClientHandle): string[] {
  const rows = client.messagesOf('session.progress');
  const shown = rows.slice(-DIAGNOSTIC_LIMITS.progressRows);
  return [
    `${String(rows.length)} session.progress row(s) retained; the last ${String(shown.length)}:`,
    ...shown.map((message) => progressLine(message.ts, message.payload)),
  ];
}

/** A modification journal as file-and-status lines — no hashes, diff, backup path or contents. */
function modificationLines(sessionId: string, records: readonly ModificationRecord[]): string[] {
  const open = records.filter((record) => isOpenModificationStatus(record.status));
  const shown = records.slice(0, DIAGNOSTIC_LIMITS.modificationsPerSession);
  return [
    `${sessionId}: ${String(records.length)} record(s), ${String(open.length)} not reverted`,
    ...shown.map(
      (record) =>
        `  ${record.file} — ${record.status}${isOpenModificationStatus(record.status) ? ' (NOT REVERTED)' : ''}`,
    ),
    ...(records.length > shown.length
      ? [`  (+${String(records.length - shown.length)} more)`]
      : []),
  ];
}

/** On failure, attach a file-and-status summary of each tracked session's modification journal. */
async function attachModificationSummary(
  testInfo: TestInfo,
  service: ServiceHandle,
  sessionIds: readonly string[],
): Promise<void> {
  const shown = sessionIds.slice(-DIAGNOSTIC_LIMITS.sessions);
  const lines: string[] = [];
  // The journal route is scope-checked like every editor route, so it is read
  // inside a live announcement of the repository root.
  await withEditorAnnouncement(service, async () => {
    for (const sessionId of shown) {
      try {
        lines.push(...modificationLines(sessionId, await service.getModifications(sessionId)));
      } catch (error) {
        lines.push(
          `${sessionId}: the modification journal could not be read (${describeError(error)})`,
        );
      }
    }
  });
  if (sessionIds.length > shown.length) {
    lines.push(`(+${String(sessionIds.length - shown.length)} earlier session(s) not listed)`);
  }
  await attachText(
    testInfo,
    'session-modifications',
    `the last ${String(DIAGNOSTIC_LIMITS.sessions)} tracked session(s), ${String(DIAGNOSTIC_LIMITS.modificationsPerSession)} record(s) each, file and status only`,
    lines,
  );
}

/**
 * End every session `tracker` registered, inside a live editor announcement of
 * the repository root: the `vscode` role may end a session only under a folder
 * a live connection announced, and this phase must not depend on whether the
 * test also requested `editorClient`. With nothing left to end, no socket is
 * opened. `endAll()` never throws; should the announcement itself fail (the
 * service is unreachable), it is attempted once more without one and the
 * failure is recorded in the report.
 */
async function endTrackedSessions(
  service: ServiceHandle,
  tracker: SessionTracker,
): Promise<{ readonly report: EndAllReport; readonly announcementProblem: string | undefined }> {
  const outstanding = tracker.registered.filter((sessionId) => !tracker.ended.includes(sessionId));
  if (outstanding.length === 0) {
    return { report: await tracker.endAll(), announcementProblem: undefined };
  }
  try {
    return {
      report: await withEditorAnnouncement(service, () => tracker.endAll()),
      announcementProblem: undefined,
    };
  } catch (error) {
    return {
      report: await tracker.endAll(),
      announcementProblem: `the editor announcement for ending sessions could not be opened: ${describeError(error)}`,
    };
  }
}

/**
 * Phase 1 of a test's teardown: end every tracked session, then — when the
 * test failed or a cleanup did not come back clean — attach the cleanup report
 * and the journal summary.
 */
async function endSessionsAndReport(
  service: ServiceHandle,
  tracker: SessionTracker,
  testInfo: TestInfo,
): Promise<void> {
  const { report, announcementProblem } = await endTrackedSessions(service, tracker);
  // `endAll()` records an unclean cleanup as a soft failure, so the status is
  // read after it. A failed announcement alone is not a failure: when the
  // retry without it still ended every session clean, nothing leaked.
  if (!testFailed(testInfo) && report.clean) {
    return;
  }
  const steps: TeardownStep[] = [
    [
      'attach the session cleanup report',
      () =>
        attachText(
          testInfo,
          'session-cleanup',
          'SessionTracker.endAll() report: session ids, outcomes, cleanup statuses and conflict counts, at most 50 sessions',
          [
            ...report.text.split('\n'),
            ...(announcementProblem === undefined ? [] : [`PROBLEM: ${announcementProblem}`]),
          ],
        ),
    ],
  ];
  if (tracker.registered.length > 0) {
    steps.push([
      'attach the modification journal summary',
      () => attachModificationSummary(testInfo, service, tracker.registered),
    ]);
  }
  throwIfProblems('sessions', await runSteps(steps));
}

/** Attach a screenshot of `panel` with the pairing dialog and the event-details drawer masked. */
async function attachPanelScreenshot(
  testInfo: TestInfo,
  panel: PanelHandle,
  name: string,
): Promise<void> {
  const png = await panel.page.screenshot({
    timeout: DIAGNOSTIC_LIMITS.screenshotTimeoutMs,
    animations: 'disabled',
    // The dialog may still hold a typed one-time code; the drawer shows an
    // event's attribute table. Neither belongs in a report.
    mask: [panel.locators.pairDialog, panel.locators.eventDetails],
  });
  await testInfo.attach(`${DIAGNOSTIC_PREFIX}${name}.png`, {
    body: png,
    contentType: 'image/png',
  });
}

/**
 * Phase 2 of a test's teardown: on failure, screenshot the most recent open
 * panels and attach their console tails; then close every panel, newest first.
 */
async function closePanels(opened: readonly PanelHandle[], testInfo: TestInfo): Promise<void> {
  const steps: TeardownStep[] = [];
  if (testFailed(testInfo)) {
    const recent = opened.filter((panel) => !panel.isClosed()).slice(-DIAGNOSTIC_LIMITS.panels);
    recent.forEach((panel, position) => {
      const name = `panel-${String(position + 1)}-tab-${String(panel.tabId)}`;
      steps.push(
        [`screenshot ${name}`, () => attachPanelScreenshot(testInfo, panel, name)],
        [
          `attach the ${name} console tail`,
          () =>
            attachText(
              testInfo,
              `${name}-console`,
              `the last ${String(DIAGNOSTIC_LIMITS.panelConsoleTailLines)} of at most ${String(PANEL_CONSOLE_LOG_LIMIT)} retained lines, ${String(PANEL_CONSOLE_LINE_MAX_LENGTH)} characters per line (scrubbed by ./chrome)`,
              [
                `${String(panel.consoleLog().length)} line(s) retained`,
                ...panel.consoleLog().slice(-DIAGNOSTIC_LIMITS.panelConsoleTailLines),
              ],
            ),
        ],
      );
    });
  }
  for (const panel of [...opened].reverse()) {
    steps.push([
      `close the panel of tab ${String(panel.tabId)}`,
      // This module attaches its own bounded tail above, so ./chrome's is off.
      () => panel.close({ attachOnFailure: false }),
    ]);
  }
  throwIfProblems('openPanelPage', await runSteps(steps));
}

/** Phase 3 of a test's teardown for one application page: on failure attach its console tail, then close it. */
async function closePage(
  page: Page,
  log: BoundedLines,
  label: string,
  testInfo: TestInfo,
): Promise<void> {
  const steps: TeardownStep[] = [];
  if (testFailed(testInfo)) {
    steps.push([
      `attach the ${label} console tail`,
      () =>
        attachText(
          testInfo,
          `${label.replace(/\s+/g, '-')}-console`,
          `the last ${String(DIAGNOSTIC_LIMITS.pageConsoleTailLines)} of at most ${String(DIAGNOSTIC_LIMITS.pageConsoleLines)} retained lines (${String(log.dropped)} older dropped), ${String(DIAGNOSTIC_LIMITS.lineLength)} characters per line`,
          [
            `${String(log.size)} line(s) retained`,
            ...log.tail(DIAGNOSTIC_LIMITS.pageConsoleTailLines),
          ],
        ),
    ]);
  }
  steps.push([`close the ${label}`, () => page.close()]);
  throwIfProblems(label, await runSteps(steps));
}

/** Phase 4 of a test's teardown: on failure attach the message timeline and the progress tail, then close. */
async function closeEditorClient(client: EditorClientHandle, testInfo: TestInfo): Promise<void> {
  const steps: TeardownStep[] = [];
  if (testFailed(testInfo)) {
    steps.push(
      [
        'attach the editor message-type timeline',
        () =>
          attachText(
            testInfo,
            'editor-message-timeline',
            `message types, counts and first/last arrival only — never payloads; at most ${String(DIAGNOSTIC_LIMITS.timelineTypes)} types`,
            timelineLines(client),
          ),
      ],
      [
        'attach the session.progress tail',
        () =>
          attachText(
            testInfo,
            'session-progress',
            `the last ${String(DIAGNOSTIC_LIMITS.progressRows)} session.progress rows, ${String(DIAGNOSTIC_LIMITS.progressTextLength)} characters per message and detail`,
            progressLines(client),
          ),
      ],
    );
  }
  steps.push([
    'close the editor client',
    () => {
      client.close();
      return Promise.resolve();
    },
  ]);
  throwIfProblems('editorClient', await runSteps(steps));
}

// ---------------------------------------------------------------------------
// Handles this module adds
// ---------------------------------------------------------------------------

/**
 * The worker-scoped pairing of the extension with the service. Pairing is
 * sticky by design — the devtools credential lives in the worker's
 * `chrome.storage.local`, `resetExtensionState()` keeps it, and
 * `tests/browser/extension-connect.spec.ts` leaves it established — so after
 * the first successful call every later one answers `{ paired: 'already' }`
 * without spending a one-time code (and without inviting the 5-failure /
 * 60-second lockout).
 */
export interface PairingHandle {
  /**
   * `./chrome`'s `ensurePaired(service, panel, options)` for the worker's
   * service, serialised so two callers never type two codes at once.
   */
  ensurePaired(panel: PanelHandle, options?: EnsurePairedOptions): Promise<PairingResult>;
  /** The outcome of the most recent successful call, or `undefined` before one. */
  readonly lastResult: PairingResult | undefined;
}

/** Create the {@link PairingHandle} of one service. Does no work until called. */
function createPairingHandle(service: ServiceHandle): PairingHandle {
  let chain: Promise<unknown> = Promise.resolve();
  let last: PairingResult | undefined;
  return {
    ensurePaired(panel, options): Promise<PairingResult> {
      const run = async (): Promise<PairingResult> => {
        const result = await ensurePaired(service, panel, options);
        last = result;
        return result;
      };
      const result = chain.then(run, run);
      chain = result.catch(() => undefined);
      return result;
    },
    get lastResult(): PairingResult | undefined {
      return last;
    },
  };
}

/**
 * Open the DevTools surface (the real built DevTools page and the panel
 * document) for one inspected tab: `./chrome`'s `openPanelPage` bound to the
 * worker's context, with every handle it returns closed in teardown.
 */
export type OpenPanelPage = (options: OpenPanelPageOptions) => Promise<PanelHandle>;

// ---------------------------------------------------------------------------
// Fixture type maps
// ---------------------------------------------------------------------------

/**
 * Worker-scoped fixtures: the run's shared resources. The four
 * {@link DebuggenTestOptions} keys are the Playwright config's `use` values,
 * declared as options exactly as `tests/browser/fixtures.ts` declares them;
 * `extensionPath` and `serviceUrl` are honoured by `extensionContext` and
 * `service`, while `demoUrl` and `fixtureAppUrl` are read by `./demo-app` and
 * `./sample-app` from the same config export.
 */
export interface E2EWorkerFixtures extends DebuggenTestOptions {
  /** The persistent Chromium context with the unpacked extension loaded (`./chrome`). */
  extensionContext: ExtensionContextHandle;
  /** The extension id, read from the MV3 worker's `chrome-extension://<id>/` URL. */
  extensionId: string;
  /** The running local service, health-checked once (`./service`). */
  service: ServiceHandle;
  /** The demo, migrated, seeded and launched through the product's launcher with the preload attached. */
  demoApp: DemoAppHandle;
  /** The generalization fixture app, launched through the product's launcher with the preload attached. */
  sampleApp: SampleAppHandle;
  /** The sticky, serialised pairing of the extension (see {@link PairingHandle}). */
  pairing: PairingHandle;
}

/** Test-scoped fixtures: the per-test handles, all released by the ordered teardown. */
export interface E2ETestFixtures {
  /**
   * The extension's live MV3 worker, re-acquired at the start of each test
   * through `extensionContext.getServiceWorker()` (it suspends after roughly
   * 30 s idle). Re-acquire again with that method in a long-running test.
   */
  serviceWorker: Worker;
  /**
   * A tab of the extension's context on the demo's `/`, opened after the
   * context exists so the statically declared MAIN-world agent runs at
   * `document_start` (the `direct` readiness route). Console output and
   * uncaught errors are kept in a bounded log attached on failure.
   */
  appPage: Page;
  /** The same for the fixture app's `/` (`generalization.spec.ts`). */
  samplePage: Page;
  /** Open the DevTools surface for a tab; every panel opened is closed in teardown. */
  openPanelPage: OpenPanelPage;
  /**
   * The common case: the DevTools surface of `appPage`'s tab, opened with the
   * real DevTools page (which announces the tab) and paired — ready for
   * `runDebugSession`.
   */
  panel: PanelHandle;
  /**
   * An editor-role observer connected for this test, announcing the
   * repository root (which contains both apps), with a clean recording buffer.
   */
  editorClient: EditorClientHandle;
  /**
   * The test's session tracker (`createSessionTracker(service)`): teardown
   * ends every session registered with it before any panel, page or socket
   * closes, and attaches the report on failure.
   */
  sessions: SessionTracker;
  /**
   * `resetExtensionState(extensionContext, { keepPairing: true })`: clear the
   * worker's persisted tab bindings (re-acquiring a suspended worker) while
   * keeping the paired credential.
   */
  resetExtension: () => Promise<void>;
  /** Internal: the per-test teardown coordinator (see the module header). */
  _testScope: TestScope;
}

// ---------------------------------------------------------------------------
// Application pages
// ---------------------------------------------------------------------------

/**
 * Open a tab of the extension's context on `baseUrl`'s `/`, register its
 * release for the `pages` phase before navigating (so a failed navigation
 * still closes it), and hand it to the test.
 */
async function serveApplicationPage(
  extension: ExtensionContextHandle,
  baseUrl: string,
  label: string,
  scope: TestScope,
  testInfo: TestInfo,
  use: (page: Page) => Promise<void>,
): Promise<void> {
  const log = new BoundedLines(DIAGNOSTIC_LIMITS.pageConsoleLines, DIAGNOSTIC_LIMITS.lineLength);
  const page = await extension.context.newPage();
  forwardPageLog(page, log);
  scope.onTeardown('pages', `close the ${label}`, () => closePage(page, log, label, testInfo));
  await guarded(
    label,
    testInfo,
    async () => {
      await page.goto(new URL('/', baseUrl).toString(), { timeout: E2E_TIMEOUTS.pageReady });
      await use(page);
    },
    () => scope.runThrough('pages'),
  );
}

// ---------------------------------------------------------------------------
// The extended test
// ---------------------------------------------------------------------------

/**
 * The `test` every spec under `tests/e2e/**` imports. Fixtures are lazy: a
 * spec pays only for what it destructures (and what those fixtures depend on).
 */
export const test = base.extend<E2ETestFixtures, E2EWorkerFixtures>({
  // The Playwright config's `use` values (`DebuggenTestOptions`).
  extensionPath: ['', { option: true, scope: 'worker' }],
  serviceUrl: ['', { option: true, scope: 'worker' }],
  demoUrl: ['', { option: true, scope: 'worker' }],
  fixtureAppUrl: ['', { option: true, scope: 'worker' }],

  // --- worker scope --------------------------------------------------------

  extensionContext: [
    async ({ extensionPath, headless, channel, launchOptions }, use, workerInfo) => {
      const handle = await launchExtensionContext({
        extensionPath: nonEmpty(extensionPath),
        headless,
        channel,
        launchOptions,
        viewport: workerInfo.project.use.viewport,
      });
      await guarded(
        'extensionContext',
        undefined,
        () => use(handle),
        // Closes every panel still open, the context, then the temporary profile.
        () => runSteps([['close the extension context', () => handle.close()]]),
      );
    },
    { scope: 'worker', timeout: E2E_TIMEOUTS.extensionLaunch },
  ],

  extensionId: [
    async ({ extensionContext }, use) => {
      await use(extensionContext.extensionId);
    },
    { scope: 'worker' },
  ],

  service: [
    async ({ serviceUrl }, use) => {
      const handle = await createServiceHandle({ baseUrl: nonEmpty(serviceUrl) });
      // Once per worker: an absent or unbuilt service fails here, with the
      // actionable message, instead of once per spec.
      await handle.expectHealthy({ timeoutMs: SERVICE_READY_TIMEOUT_MS });
      await use(handle);
    },
    { scope: 'worker', timeout: E2E_TIMEOUTS.connection },
  ],

  demoApp: [
    async ({ service }, use) => {
      const handle = createDemoAppHandle(service);
      let launchAttempted = false;
      await guarded(
        'demoApp',
        undefined,
        async () => {
          await handle.assertPrerequisites();
          await handle.ensureDatabase();
          launchAttempted = true;
          // POST /dev-server/launch; `start()` asserts the preload by default,
          // and the explicit check documents the contract at the call site.
          await handle.start();
          handle.expectPreloadAttached();
          await use(handle);
        },
        () =>
          launchAttempted
            ? runSteps([['stop the demo through POST /dev-server/stop', () => handle.stop()]])
            : Promise.resolve([]),
      );
    },
    { scope: 'worker', timeout: E2E_TIMEOUTS.devServerReady },
  ],

  sampleApp: [
    async ({ service }, use) => {
      const handle = createSampleAppHandle(service);
      let launchAttempted = false;
      await guarded(
        'sampleApp',
        undefined,
        async () => {
          // Frees the port of a launch this service owns; refuses a foreign
          // server (for example one `pnpm test:browser` left) with the fix.
          await handle.ensurePortFree();
          launchAttempted = true;
          await handle.start();
          handle.expectPreloadAttached();
          await use(handle);
        },
        () =>
          launchAttempted
            ? runSteps([
                ['stop the fixture app through POST /dev-server/stop', () => handle.stop()],
              ])
            : Promise.resolve([]),
      );
    },
    { scope: 'worker', timeout: E2E_TIMEOUTS.devServerReady },
  ],

  pairing: [
    async ({ service }, use) => {
      await use(createPairingHandle(service));
    },
    { scope: 'worker' },
  ],

  // --- test scope ----------------------------------------------------------

  // Playwright reads a fixture's dependencies from its first parameter's
  // destructuring pattern, so a dependency-free fixture must spell it empty.
  // eslint-disable-next-line no-empty-pattern
  _testScope: async ({}, use, testInfo) => {
    const scope = createTestScope();
    // Torn down last (every registering fixture depends on it): drains
    // whatever release is still pending, so nothing registered is ever skipped.
    await guarded(
      'test scope',
      testInfo,
      () => use(scope),
      () => scope.runThrough('editor'),
    );
  },

  serviceWorker: async ({ extensionContext }, use) => {
    await use(await extensionContext.getServiceWorker());
  },

  appPage: [
    async ({ extensionContext, demoApp, _testScope }, use, testInfo) => {
      await serveApplicationPage(
        extensionContext,
        demoApp.baseUrl,
        'app page',
        _testScope,
        testInfo,
        use,
      );
    },
    { timeout: TEST_FIXTURE_TIMEOUT_MS },
  ],

  samplePage: [
    async ({ extensionContext, sampleApp, _testScope }, use, testInfo) => {
      await serveApplicationPage(
        extensionContext,
        sampleApp.baseUrl,
        'sample page',
        _testScope,
        testInfo,
        use,
      );
    },
    { timeout: TEST_FIXTURE_TIMEOUT_MS },
  ],

  openPanelPage: [
    async ({ extensionContext, _testScope }, use, testInfo) => {
      const opened: PanelHandle[] = [];
      _testScope.onTeardown('panels', 'close the panel pages', () => closePanels(opened, testInfo));
      await guarded(
        'openPanelPage',
        testInfo,
        () =>
          use(async (options) => {
            const panel = await openExtensionPanel(extensionContext, options);
            opened.push(panel);
            return panel;
          }),
        () => _testScope.runThrough('panels'),
      );
    },
    { timeout: TEST_FIXTURE_TIMEOUT_MS },
  ],

  panel: [
    async (
      { appPage, extensionContext, openPanelPage, pairing, service, _testScope },
      use,
      testInfo,
    ) => {
      _testScope.noteService(service, testInfo);
      const tabId = await tabIdForPage(extensionContext, appPage);
      const handle = await openPanelPage({
        tabId,
        inspectedPage: appPage,
        inspectedUrl: appPage.url(),
      });
      await pairing.ensurePaired(handle);
      // Closed by `openPanelPage`'s release in the `panels` phase.
      await use(handle);
    },
    { timeout: E2E_TIMEOUTS.panelOpen },
  ],

  editorClient: [
    async ({ service, _testScope }, use, testInfo) => {
      _testScope.noteService(service, testInfo);
      const client = await createEditorClient({
        baseUrl: service.baseUrl,
        home: service.debuggenHome,
        projectRoot: repoRoot(),
        connectTimeoutMs: EDITOR_CONNECT_TIMEOUT_MS,
      });
      _testScope.onTeardown('editor', 'close the editor client', () =>
        closeEditorClient(client, testInfo),
      );
      await guarded(
        'editorClient',
        testInfo,
        () => use(client),
        () => _testScope.runThrough('editor'),
      );
    },
    { timeout: TEST_FIXTURE_TIMEOUT_MS },
  ],

  sessions: [
    async ({ service, _testScope }, use, testInfo) => {
      _testScope.noteService(service, testInfo);
      const tracker = createSessionTracker(service);
      _testScope.onTeardown('sessions', 'end every tracked session', () =>
        endSessionsAndReport(service, tracker, testInfo),
      );
      await guarded(
        'sessions',
        testInfo,
        () => use(tracker),
        () => _testScope.runThrough('sessions'),
      );
    },
    { timeout: TEST_FIXTURE_TIMEOUT_MS },
  ],

  resetExtension: async ({ extensionContext }, use) => {
    await use(() => resetExtensionState(extensionContext, { keepPairing: true }));
  },
});
