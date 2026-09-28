/**
 * The coordination service's instrumentation driver: the one module that turns
 * a validated `InstrumentationPlan` into installed instrumentation, armed
 * telemetry producers and the protocol messages both user interfaces render.
 *
 * ## What it does
 *
 * - **Builds the adapter context** ({@link InstrumentationService.buildContext})
 *   — the absolute POSIX project root, the plan version, the product's state
 *   directory, the session's backup store, the modification journal, the
 *   code-analysis handles and the readiness facts the service actually
 *   observed. One construction site, reused by the install path, the readiness
 *   gate and the suites.
 * - **Installs a plan** ({@link InstrumentationService.install}) through the
 *   injected `installPlan`, bracketed by the conflict watcher's
 *   suspend → refresh → resume contract, and serialised per session.
 * - **Keeps the state root out of the project at the patch sink**:
 *   every install first re-checks, with `../config.ts`'s
 *   `requireProjectOutsideStateHome`, that its project root — the confirmed
 *   canonical root, when the request carries a confirmation — neither is,
 *   contains nor lies inside the canonical state root, and is refused
 *   `FS_UNSAFE_PATH` — reported as `instrumentation.failed` — before any backup
 *   or patch is written. The routes' checks run earlier; this one runs where
 *   the bytes are written, however late the pipeline gets there.
 * - **Re-proves the project root's identity at the patch sink** (CWE-367).
 *   The pipeline installs long after the request that admitted the session's
 *   root answered, and a link on that root's path can be retargeted in
 *   between. An install whose request carries
 *   {@link InstallRequest.confirmProjectRoot} calls it synchronously before it
 *   first acts on the root, and again after the readiness facts are collected
 *   with no `await` between that call and the installer's, and hands the patch
 *   layer the confirmed canonical root
 *   (`InstrumentationContext.canonicalProjectRoot`), inside which every target
 *   is resolved and written. A refusal fails the install, through the same
 *   `instrumentation.failed` path, before anything is written.
 * - **Applies only the delta of a follow-up** (AAP §0.4.2): plan version
 *   *n + 1* is the previous plan plus additive actions; the additive ids are
 *   computed with the upstream `actionIdentityKey`, installed actions are never
 *   re-installed or removed, and the session's active plan version advances only
 *   once the delta install succeeds.
 * - **Maps the installer's result onto the wire without reshaping it**
 *   (AAP §0.4.2): `instrumentation.ready` carries `applied`, `runtimeHooks` and
 *   `unavailable` exactly as the installer returned them — with one
 *   substitution AAP §0.5.5 requires: when this install's dev-server detection
 *   found the preload missing, every preload gap's `hint` is the exact
 *   relaunch command that detection composed, never the adapter's generic text
 *   ({@link withDetectedRelaunchHints}). `applied` lists exactly the records
 *   *this* install wrote: every record of a first install, only plan version
 *   *n + 1*'s records on a follow-up, and `[]` for a delta that installs
 *   nothing — which runs no installer, so its `runtimeHooks` and `unavailable`
 *   restate the session's current hooks and gaps. Records an earlier plan
 *   version applied were announced by that version's install and are never
 *   re-listed; the whole journal is the session record's `modifications`
 *   (`GET /sessions/:id/modifications`). `agent.config` and
 *   `server-agent.config` carry the installer's hook configuration and signal
 *   set; `instrumentation.failed` carries the installer's error code, the
 *   stage's fixed public copy for that code and a diagnostic reference in
 *   place of the error's own message, and the error's hint only when it is
 *   proven product text — the dev-server detection's exact relaunch command
 *   standing in for an adapter's — else the code's default next step.
 * - **Gives the detection the preload the launcher attaches**: when no
 *   preload path is injected, each install resolves the telemetry preload
 *   with the launcher's own `resolvePreloadPath`, so the relaunch command
 *   imports that absolute `file:` URL rather than a variable the developer
 *   would first have to export.
 * - **Arms and disarms the two producers at capture time, judged by
 *   receipts** ({@link InstrumentationService.armCapture},
 *   {@link InstrumentationService.disarmCapture}). `agent.config` requires a
 *   capture id, so arming belongs to the capture window; disarming sends the
 *   dormant page configuration and a preload configuration **without** a
 *   capture id, which is what makes the preload disable its instrumentations
 *   (AAP §0.5.1: runtime hooks are disabled, not merely idled). Each frame goes
 *   to its one recipient — `agent.config` to the connection carrying the
 *   session's bound tab, `server-agent.config` to the project's preloads — and
 *   the client registry's delivery receipt decides the outcome. A
 *   producer-applied acknowledgement is not part of the AAP §0.4.2 protocol, so
 *   that transport receipt *is* the acknowledgement. An arm whose page frame no
 *   connection took is refused before the preload is told anything; an arm
 *   whose preload is not connected proceeds with the page and reports every
 *   server signal it lacks (AAP §0.5.5).
 * - **Remembers what could not be delivered, and replays it**
 *   ({@link ProducerReconciler}). A disarm that no connection took, for a
 *   producer this process armed, stays pending — across `stopSession`, which
 *   cleanup calls right after disarming — until a reconnecting producer
 *   ({@link ProducerReconciler.producerConnected}), a rebinding tab
 *   ({@link ProducerReconciler.reconcileBoundSession}) or a later configuration
 *   settles it; {@link ProducerReconciler.onDormancyConfirmed} reports when a
 *   session's pending set empties. A reconnecting producer is re-armed for the
 *   project's open capture. A capture a restart interrupted is never resumed —
 *   it would be advertised before any producer took its configuration — but
 *   released ({@link ProducerReconciler.releaseInterruptedCapture}), so the
 *   dormant configuration its producers are owed stays pending until they
 *   take it. A preload that may hold an arming this service did not see
 *   disarmed there — its credential predates the service, or predates the
 *   project's last arming — is sent the capture-less configuration when it
 *   connects.
 * - **Reports degradation honestly** (AAP §0.5.5): every label that could not
 *   be enabled is one sentence — "Could not enable ‹signal›: ‹reason›.
 *   Continuing with: ‹enabled list›.", composed by `../sessions/progress.ts`'s
 *   `unavailableSignalMessage` over its `mergeUnavailableByLabel` (so neither
 *   signals sharing a label nor an adapter and the readiness gate reporting
 *   one signal give a label two contradictory rows) — shown as exactly one
 *   terminal ✗ (`failed`) progress row of the `instrument` stage: the
 *   checklist's row at install time, and a row of the same shape for a server
 *   signal the capture lost
 *   because the preload could not be reached. No `running` row precedes it, so
 *   no client merging rows by stage and message is left with a spinner. A
 *   degradation is never a session failure — no `stageFailed`, no
 *   `instrumentation.failed`. The only failure is the installer's own `Err`,
 *   which is what "nothing at all could be enabled" means — unless the
 *   install was cancelled through its signal: that `Err` is reported as a
 *   cancellation, never as a failure.
 *   When that failure includes a preload gap and the detection found the
 *   preload missing, the failure's hint is the exact relaunch command
 *   whichever signal the installer named, and each preload gap ("Could not
 *   enable Server spans: ‹reason›.") is shown as a ✗ row with that command
 *   before the failed row.
 * - **Checks a row only once readiness confirms it** (AAP §0.5.5, prompt §11
 *   Step 8): readiness is evaluated before any checklist row is sent; a signal
 *   is shown ✓ — and named after "Continuing with:" — only when the capture
 *   arms it *and* the verdict found a producer that will deliver it, every
 *   other planned signal is shown ✗ with the verdict's reason and hint, and
 *   "Ready to capture" closes the group last, only for a satisfied verdict.
 * - **Keeps the signal report true to the page** (AAP §0.5.5, §0.7.1). The
 *   install judges the page with the facts on file when it starts, and a
 *   panel usually binds a moment before its page agent reports. So the share
 *   of the report that runtime-only adapters produced — which writes no file
 *   and can be asked again — is re-judged whenever the facts it was judged
 *   against change: after the install's readiness verdict, when the bound
 *   tab's next document reports, and on a tab (re)bind. A corrected
 *   `instrumentation.ready` is sent only when the report actually changed,
 *   with ✓ rows for the signals it newly confirms. A signal the verdict holds
 *   back only because the bound page has not reported is left to the gate's
 *   reload request and never shown as failed. The latest report — or the
 *   latest failure — is replayed to a panel that binds
 *   ({@link SignalReportPublisher.replaySignalReport}).
 *
 * ## What it never does
 *
 * - **It never touches a developer's file.** Bytes reach a working tree only
 *   through the patch layer of `@debuggen/instrumentation`, which the installer
 *   drives, and come back only through that package's cleanup. This module hands
 *   the installer a correct journal and backup store — and, for a confirmed
 *   root, the canonical root the patch layer writes inside — and then calls it;
 *   it performs no rollback of its own — the installer already reverse-restores
 *   the records of a call that failed part-way.
 * - **It knows no adapter.** Every adapter arrives through the injected
 *   registry; nothing here imports, names or branches on a particular adapter or
 *   action type, so a seventh adapter is added by registering it, with no change
 *   to this file (AAP §0.4.2).
 * - **It never changes a session's status.** The session manager is the only
 *   writer of status; this module reports the plan version it left active and
 *   the readiness verdict, and the caller drives the state machine (whose
 *   `instrumenting → ready` edge is guarded on the verdict).
 * - **It never enforces capture ownership.** At most one session captures a
 *   project at a time; the manager decides that. This module only consults the
 *   manager's answer so a disarm never switches off another session's preload.
 * - **It reads no environment and holds no module state.** Every collaborator
 *   is injected and every piece of state lives inside one
 *   {@link createInstrumentationService} closure, so two services in one process
 *   cannot interfere.
 *
 * ## Privacy
 *
 * Log records carry ids, counts, plan versions, signal names, error codes and a
 * caught value's closed exception class (`describeException`) — never a diff,
 * never file content, never a credential, and never an exception's own name or
 * message (AAP §0.5.2). A caught value itself travels only under the logger's
 * error key, whose serializer decides what of it is emitted. The
 * server-agent credential belongs to the dev-server launcher and never passes
 * through here.
 *
 * @module
 */

import type {
  CodeGraph,
  CodeQueries,
  LoadedProject,
  ProjectSummary,
  RouteMap,
} from '@debuggen/code-analysis';
import {
  AGENT_HOOK_KEYS,
  CAPTURE_SIGNALS,
  DISABLED_SERVER_AGENT_SIGNALS,
  DORMANT_AGENT_HOOK_CONFIG,
  PATCH_TARGET_HELD_REASON,
  READINESS_HINT_MAX_LENGTH,
  READINESS_REASON_MAX_LENGTH,
  SERVER_AGENT_SIGNAL_KEYS,
  actionIdentityKey,
  buildReadiness,
  checkFeasibility,
  createAdapterRegistry,
  createBackupStore,
  deriveAgentHookConfig,
  deriveServerAgentSignals,
  installPlan,
  isCaptureSignal,
  parseInstrumentationPlan,
  type AdapterRegistry,
  type AgentHookConfig,
  type AggregateInstallResult,
  type BackupStore,
  type CaptureSignal,
  type InstallDelta,
  type InstrumentationAction,
  type InstrumentationContext,
  type InstrumentationPlan,
  type ModificationRecord,
  type ObservedReadinessInputs,
  type Readiness,
  type ReadinessSignal,
  type ReadinessStatus,
  type ServerAgentSignals,
  type UnavailableSignal,
} from '@debuggen/instrumentation';
import {
  CLIENT_KINDS,
  createEnvelope,
  parseAgentConfigPayload,
  parseInstrumentationFailedPayload,
  parseInstrumentationPlanPayload,
  parseInstrumentationReadyPayload,
  parseServerAgentConfigPayload,
  type AgentConfigPayload,
  type BoundTab,
  type ClientKind,
  type InstrumentationFailedPayload,
  type InstrumentationReadyPayload,
  type ProgressStage,
  type ProtocolMessage,
  type ServerAgentConfigPayload,
} from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  isAbsolutePosix,
  isErr,
  isSafeRelativePath,
  isWindowsAbsolute,
  newMessageId,
  normalizePosix,
  nowEpochMs,
  ok,
  toPosix,
  type LogFields,
  type Logger,
  type Result,
} from '@debuggen/shared';

import { canonicalizePath, requireProjectOutsideStateHome, type ServiceConfig } from '../config.js';
import {
  PRELOAD_DEPENDENT_SIGNALS,
  buildPreloadUnavailableSignals,
  type DevServerDetection,
} from '../dev-server/detect.js';
import { resolvePreloadPath } from '../dev-server/launcher.js';
import {
  LOG_BINDING_KEYS,
  LOG_ERROR_FIELD_KEY,
  describeException,
  type ExceptionDescription,
} from '../logging.js';
import type { CaptureOwner, SessionBroadcaster } from '../sessions/manager.js';
import {
  CAPTURE_SIGNAL_LABELS,
  INSTRUMENTATION_ROW_ORDER,
  authorProductText,
  buildStageCancelledRow,
  isProductAuthoredText,
  mergeUnavailableByLabel,
  publicFailureCopy,
  unavailableSignalMessage,
  type InstalledSignals,
  type ProgressRow,
  type SessionProgress,
} from '../sessions/progress.js';
import type { SessionFailure } from '../sessions/state-machine.js';
import type { ModificationsRepo } from '../store/modifications-repo.js';
import {
  MAX_RELOAD_WAIT_MS,
  collectReadinessEvidence,
  evaluateReadiness,
  waitForNextAgentReady,
  type BrowserAgentRegistry,
  type CollectObservedReadinessDeps,
  type ReadinessEvidence,
  type ReadinessVerdict,
  type ServerAgentReadinessSource,
} from './readiness.js';
import type { InstrumentationWatcher } from './watcher.js';

// ---------------------------------------------------------------------------
// Section A — constants
// ---------------------------------------------------------------------------

/** The progress stage every row this module emits belongs to. */
const INSTRUMENT_STAGE: ProgressStage = 'instrument';

/** The binding value this module's log records carry under `subsystem`. */
const LOG_SUBSYSTEM = 'instrumentation';

/**
 * Who receives `instrumentation.plan`, `.ready` and `.failed`: the editor's view
 * and the bound tab's DevTools panel (AAP §0.4.2). Typed against protocol's
 * `ClientKind`, so renaming a kind breaks this line rather than silently routing
 * the messages to nobody.
 */
const UI_CLIENT_KINDS: readonly ClientKind[] = Object.freeze(['vscode', 'devtools'] as const);

/** The client kind of a dev-server preload connection, which takes `server-agent.config`. */
const SERVER_AGENT_KIND = 'server-agent' as const satisfies ClientKind;

/** The client kind of a DevTools connection, which carries its bound tabs' page agents. */
const DEVTOOLS_KIND = 'devtools' as const satisfies ClientKind;

/** The page agent, as {@link DisarmCaptureOutcome.pending} names it; listed first. */
const PAGE_AGENT_PRODUCER: ArmedProducer = 'page-agent';

/** The dev-server preload, as {@link DisarmCaptureOutcome.pending} names it; listed second. */
const SERVER_AGENT_PRODUCER: ArmedProducer = 'server-agent';

/**
 * The reason every server signal of a capture carries when the arm could not
 * reach the dev-server preload (AAP §0.5.5): one line, closed by the sentence
 * `unavailableSignalMessage` builds around it.
 */
const PRELOAD_UNREACHABLE_REASON =
  'the dev-server preload is not connected, so this capture collects nothing on the server';

/** The next step of a server signal the arm could not reach, carried as the row's detail. */
const PRELOAD_UNREACHABLE_HINT =
  'Launch the dev server from Debug Generator so its Node preload connects (a launch also replaces a dev server it started whose credential was rotated or revoked); the capture picks the server signals up as soon as it does.';

/** The next step when the page agent could not be sent its capture configuration. */
const PAGE_AGENT_UNREACHABLE_HINT =
  'Open DevTools on the page with the Debug Generator panel so the tab is bound and connected, then start the capture again.';

/** The mode of an action installed as a runtime hook rather than a file patch. */
const RUNTIME_ACTION_MODE = 'runtime' as const satisfies InstrumentationAction['mode'];

/** The protocol bound on a progress row's detail (`session.progress`). */
const MAX_PROGRESS_DETAIL_LENGTH = 4000;

/** The protocol bound on `instrumentation.failed`'s message. */
const MAX_FAILURE_MESSAGE_LENGTH = 2000;

/** The protocol bound on `instrumentation.failed`'s hint. */
const MAX_FAILURE_HINT_LENGTH = 1000;

/** Any run of whitespace, collapsed to one space in display text. */
const WHITESPACE_RUN_PATTERN = /\s+/gu;

/** The checklist status of a confirmed signal the readiness verdict raised no gap for. */
const AVAILABLE_STATUS = 'available' as const satisfies ReadinessStatus;

/** The checklist status of a confirmed signal the readiness verdict holds a gap for. */
const DEGRADED_STATUS = 'degraded' as const satisfies ReadinessStatus;

/** The checklist status of a planned signal readiness did not confirm. */
const UNAVAILABLE_STATUS = 'unavailable' as const satisfies ReadinessStatus;

// ---------------------------------------------------------------------------
// Section B — injected ports
// ---------------------------------------------------------------------------

/**
 * The single-recipient delivery this module needs for `server-agent.config`.
 *
 * A dev-server preload is not a session client, so a session fan-out never
 * reaches it; the client registry (`src/server/clients.ts`) delivers the frame
 * to the online preload connections of one project and says whether any was
 * reached. Declared structurally so this module does not import the server
 * layer above it; the registry satisfies it as it stands.
 */
export interface ServerAgentConfigChannel {
  /**
   * Delivers `message` to every online server-agent connection scoped to
   * `projectRoot`.
   *
   * @returns `Ok` when at least one connection received it; `Err`
   * (`SERVER_AGENT_NOT_READY` and friends) when none could.
   */
  sendToServerAgent(projectRoot: string, message: ProtocolMessage): Result<unknown, DebuggenError>;
}

/**
 * The single-recipient delivery this module needs for `agent.config`.
 *
 * The MAIN-world page agent owns no socket: its frames travel under the
 * DevTools connection that carries the session's bound tab (AAP §0.4.2). The
 * client registry (`src/server/clients.ts`) resolves that one connection and
 * says whether it took the frame — which is the receipt every arm and disarm
 * here is judged by, because the AAP protocol has no producer acknowledgement
 * message. Declared structurally, like {@link ServerAgentConfigChannel}; the
 * registry satisfies it as it stands.
 */
export interface AgentConfigChannel {
  /**
   * Delivers `message` to the connection carrying the session's bound tab.
   *
   * @returns `Ok` when that connection took the frame; `Err` when none could —
   * `TAB_NOT_BOUND` (no tab is bound), `TRANSPORT_DISCONNECTED` (the binding's
   * connection is offline or the write failed), `UNAUTHORIZED` or
   * `PROTOCOL_INVALID_MESSAGE` (the registry refused the frame).
   */
  sendToBoundTab(sessionId: string, message: ProtocolMessage): Result<unknown, DebuggenError>;
}

/**
 * The manager's single answer to "which session holds the capture on this
 * project?" — `SessionManager.captureOwnerForProject`, declared structurally.
 *
 * Consulted, never enforced: the manager answers `409` with the owning session
 * when a second session tries to capture. Here the answer only keeps an arm from
 * speaking for a capture it does not own, and a disarm from switching off
 * another session's preload.
 */
export interface CaptureOwnerLookup {
  captureOwnerForProject(projectRoot: string): CaptureOwner | undefined;
}

/**
 * `installPlan`'s own type: the injection point that lets a suite script an
 * `AggregateInstallResult` without a filesystem, exactly as the dev-server
 * modules inject their fetch and spawn ports.
 */
export type InstallPlanFn = typeof installPlan;

/**
 * The code-analysis handles an install needs, supplied by the caller that holds
 * the project's index (the planning stage). This module never indexes a project.
 */
export interface CodeAnalysisHandles {
  /** The indexed code graph. */
  readonly graph: CodeGraph;
  /** The bounded, read-only query surface over {@link graph}. */
  readonly queries: CodeQueries;
  /** The URL ↔ route-file mapping. */
  readonly routeMap: RouteMap;
  /** The project's summary. */
  readonly summary: ProjectSummary;
  /** The loaded ts-morph project, only when AST work is possible. */
  readonly project?: LoadedProject | undefined;
}

/** Everything {@link createInstrumentationService} is given; all of it injected. */
export interface InstrumentationServiceDeps {
  /** The resolved service configuration: the state directory and the service address. */
  readonly config: ServiceConfig;
  /**
   * The state root as the filesystem resolves it — every symbolic link
   * followed — which every install's project root is kept apart from before a
   * backup or a patch is written (see "The state root stays outside every
   * project" in `../config.ts`). `src/main.ts` passes the value it resolved
   * once at start-up, so every check of the running service compares against
   * one root. When absent, `config.debuggenHome` is canonicalised on the
   * first install and kept once resolved; a failure is not kept, so the next
   * install tries again, and the install it fails is refused. A value given
   * must be absolute, or every install is refused.
   */
  readonly canonicalStateHome?: string | undefined;
  /** The service logger; this module binds `subsystem` and `sessionId` on it. */
  readonly logger: Logger;
  /**
   * The modification journal, handed to the installer as the context's journal
   * unchanged — the same object, never a wrapper.
   */
  readonly modifications: ModificationsRepo;
  /** The progress emitter both user interfaces render from. */
  readonly progress: SessionProgress;
  /**
   * The session fan-out for the user-interface frames (`instrumentation.plan`,
   * `.ready`, `.failed`). Never used for a producer's configuration: a fan-out
   * reports no receipt, and arming is judged by one.
   */
  readonly broadcaster: SessionBroadcaster;
  /** The single-recipient delivery for `agent.config`, with its receipt. */
  readonly agentChannel: AgentConfigChannel;
  /** The single-recipient delivery for `server-agent.config`, with its receipt. */
  readonly serverAgentChannel: ServerAgentConfigChannel;
  /** The live conflict detector the install brackets. */
  readonly watcher: InstrumentationWatcher;
  /**
   * The relayed `agent.ready` reports, kept per DevTools credential and tab
   * and read for a session's bound tab (`BoundTabRef` in `./readiness.ts`):
   * another paired browser's tab of the same id never answers for this
   * session.
   */
  readonly agents: BrowserAgentRegistry;
  /** Whether the dev-server preload of a project is connected, and when it last spoke. */
  readonly serverAgents: ServerAgentReadinessSource;
  /** The launched dev servers, read for the URL to probe when a request names none. */
  readonly devServers?: CollectObservedReadinessDeps['devServers'];
  /** The manager's capture-owner answer; see {@link CaptureOwnerLookup}. */
  readonly captures?: CaptureOwnerLookup | undefined;
  /**
   * The adapters to install through. Defaults to the built-in registry,
   * constructed once per service.
   */
  readonly adapters?: AdapterRegistry | undefined;
  /** The installer. Defaults to `installPlan`. */
  readonly installer?: InstallPlanFn | undefined;
  /** The dev-server detection readiness runs; defaults to the real detector. */
  readonly detectDevServer?: CollectObservedReadinessDeps['detect'];
  /**
   * The detector's own ports (fetch, file reads, the preload path), forwarded
   * unchanged — except that, without a `preloadPath`, each install adds the
   * one the launcher's `resolvePreloadPath` finds, so the relaunch command
   * names the preload's absolute `file:` URL.
   */
  readonly detectDeps?: CollectObservedReadinessDeps['detectDeps'];
  /** How long the readiness gate waits for a page reload, in milliseconds. */
  readonly reloadWaitMs?: number | undefined;
  /** The clock every timestamp is taken from; defaults to `nowEpochMs`. */
  readonly now?: (() => number) | undefined;
}

// ---------------------------------------------------------------------------
// Section C — requests and outcomes
// ---------------------------------------------------------------------------

/** What {@link InstrumentationService.buildContext} assembles a context from. */
export interface BuildContextInput {
  /** The session the context belongs to. */
  readonly sessionId: string;
  /** The project root: absolute, POSIX or Windows-style; normalised here. */
  readonly projectRoot: string;
  /**
   * The canonical path {@link BuildContextInput.projectRoot} was confirmed to
   * resolve to — every symbolic link resolved — when the caller holds one:
   * absolute, POSIX or Windows-style; normalised here.
   *
   * Stamped on the context as `canonicalProjectRoot`, which the patch layer
   * resolves, pins and writes every target inside, and refuses to patch
   * through once the path no longer resolves to itself. Omitted, the context
   * carries no canonical root and the patch layer resolves `projectRoot`
   * afresh. {@link InstrumentationService.install} supplies it from the
   * request's {@link InstallRequest.confirmProjectRoot}.
   */
  readonly canonicalProjectRoot?: string | undefined;
  /**
   * The plan version the context is for; its `planVersion` is stamped on the
   * context and is the only member read. Typed as the one field so the planning
   * stage can build the context of the version it is about to author — the
   * catalog, the fallback plan and the feasibility gate all need it before a
   * normalised plan exists — while an install passes its whole plan unchanged.
   */
  readonly plan: Pick<InstrumentationPlan, 'planVersion'>;
  /** The code-analysis handles. */
  readonly code: CodeAnalysisHandles;
  /** The readiness facts the service observed (`collectObservedReadiness`). */
  readonly readiness: ObservedReadinessInputs;
  /** The cancellation signal the installer honours between groups. */
  readonly signal?: AbortSignal | undefined;
}

/** One call of {@link InstrumentationService.install}. */
export interface InstallRequest {
  /** The session being instrumented. */
  readonly sessionId: string;
  /** The developer's project root. */
  readonly projectRoot: string;
  /** The normalised, validated plan version to install. */
  readonly plan: InstrumentationPlan;
  /** The project's code-analysis handles. */
  readonly code: CodeAnalysisHandles;
  /** The session's tab binding, when a tab is bound. */
  readonly boundTab?: BoundTab | undefined;
  /** The dev-server URL to probe when no preload is connected. */
  readonly devServerUrl?: string | undefined;
  /**
   * The plan version already installed, when this is a follow-up's delta
   * install. Must be exactly `plan.planVersion - 1`.
   */
  readonly previousPlanVersion?: number | undefined;
  /**
   * The previous plan version's actions, to compute the delta against.
   * Defaults to the actions this service installed for that version.
   */
  readonly previousActions?: readonly InstrumentationAction[] | undefined;
  /** Skips the installer's feasibility gate. Default `false`; for suites only. */
  readonly skipFeasibility?: boolean | undefined;
  /**
   * Whether this call announces the plan as `instrumentation.plan`. Default
   * `true`; a caller that has already announced this plan version passes
   * `false`, so the plan is announced exactly once.
   */
  readonly announcePlan?: boolean | undefined;
  /**
   * Whether a failed install emits the instrument stage's `failed` progress
   * row — and a cancelled one its cancellation row. Default `true`. A caller
   * that files the outcome on the session itself — moving it to `failed`
   * through the manager, which emits the same row as part of that transition,
   * or reporting the cancellation as the pipeline does — passes `false`, so the
   * row is not shown twice.
   */
  readonly reportStageFailure?: boolean | undefined;
  /** Whether the readiness gate may ask for a page reload. Default `true`. */
  readonly allowReloadPrompt?: boolean | undefined;
  /** Whether a missing preload blocks readiness when server signals are planned. Default `false`. */
  readonly requireServerAgent?: boolean | undefined;
  /**
   * Cancels the install; the installer unwinds what the call applied. A
   * cancelled install is reported as cancelled, never as failed: no
   * `instrumentation.failed` is sent (see {@link InstrumentationService.install}).
   */
  readonly signal?: AbortSignal | undefined;
  /**
   * Re-proves that the session's project root still resolves to the canonical
   * directory it was admitted under, and answers that directory — for the
   * pipeline, `SessionManager.confirmProjectRoot` for the request's session.
   *
   * **Why.** The pipeline installs long after the request that admitted the
   * root answered. A symbolic link on the root's path retargeted in between —
   * even to another directory inside the workspace — would otherwise redirect
   * the patch layer's writes into a directory nobody admitted (CWE-367).
   *
   * **When.** The service calls it synchronously twice: immediately before it
   * first acts on the root — the state-root separation check, which is then
   * judged on the confirmed canonical root — and again after the readiness
   * facts are collected, immediately before it hands the plan to the
   * installer, with no `await` between that second call and the installer's.
   * The install then runs **inside** the second answer's `canonicalRoot`: the
   * context carries it as `canonicalProjectRoot`, where the patch layer
   * resolves, pins and writes every target. Everything else keeps the
   * request's spelling — the readiness facts, the conflict watcher and every
   * frame.
   *
   * **Refusals.** An `Err` fails the install before anything is written and is
   * reported unchanged through `instrumentation.failed` and the returned
   * error. A callback that throws, or answers a canonical root that is not an
   * absolute path, fails it the same way as `INTERNAL`
   * (`details.reason`: `project-root-confirmation-threw`,
   * `project-root-confirmation-invalid`); the thrown value is not kept, since
   * nothing promises it is free of paths. Each refusal is logged at `warn` by
   * its code and reason alone.
   *
   * Omitted, the install behaves as before: the context carries no canonical
   * root and the patch layer resolves the spelled root itself.
   *
   * @example
   * ```ts
   * await instrumentation.install({
   *   ...request,
   *   confirmProjectRoot: () => sessions.confirmProjectRoot(request.sessionId),
   * });
   * ```
   */
  readonly confirmProjectRoot?:
    (() => Result<{ readonly canonicalRoot: string }, DebuggenError>) | undefined;
}

/** What a successful install left in place. Plain, JSON-serialisable data. */
export interface InstrumentationOutcome {
  /** The session instrumented. */
  readonly sessionId: string;
  /** The plan version this call installed. */
  readonly planVersion: number;
  /** The plan version now active for the session — equal to {@link planVersion} on success. */
  readonly activePlanVersion: number;
  /**
   * The records this call applied, as the installer returned them — the same
   * list `instrumentation.ready` carries. On a follow-up that is only the
   * delta's (plan version {@link planVersion}) records, and `[]` for a delta
   * that installs nothing; records of earlier plan versions stay in the
   * journal and are not repeated here.
   */
  readonly applied: readonly ModificationRecord[];
  /**
   * The runtime hooks this call armed, as the installer returned them. For a
   * delta that installs nothing — no installer runs — every hook the session's
   * installed plan versions armed.
   */
  readonly runtimeHooks: readonly string[];
  /**
   * The signals this call could not enable, as the installer returned them —
   * each preload gap's hint the detection's exact relaunch command when the
   * preload is missing ({@link withDetectedRelaunchHints}). For a delta that
   * installs nothing, the gaps the previous install reported.
   */
  readonly unavailable: readonly UnavailableSignal[];
  /**
   * The page-agent configuration the next capture arms. For a first install,
   * the installer's own; for a delta, the previous version's widened by the
   * delta's, because the earlier version's hooks stay installed.
   */
  readonly agentHooks: AgentHookConfig;
  /** The preload signal set the next capture arms, composed as {@link agentHooks} is. */
  readonly serverSignals: ServerAgentSignals;
  /** The readiness gate's verdict for the installed plan version. */
  readonly readiness: ReadinessVerdict;
  /**
   * The degradation sentences, one per label that could not be enabled: byte
   * for byte the messages of the checklist's ✗ rows, which fold
   * {@link unavailable} and the readiness report's unavailable signals into
   * one row per label (`mergeUnavailableByLabel` in `../sessions/progress.ts`).
   */
  readonly degradations: readonly string[];
}

/** What {@link InstrumentationService.armCapture} is told. */
export interface ArmCaptureRequest {
  /** The session whose capture window opened. */
  readonly sessionId: string;
  /** The capture window's id, from the manager's `startCapture`. */
  readonly captureId: string;
  /**
   * The session's project root — needed only when this service holds no state
   * for the session (after a restart), together with {@link plan}.
   */
  readonly projectRoot?: string | undefined;
  /**
   * The session's stored, active plan — the fallback the configurations are
   * recomputed from after a restart. Ignored when this service installed the
   * session's plan itself.
   */
  readonly plan?: InstrumentationPlan | undefined;
}

/**
 * How a `server-agent.config` frame fared, judged by the client registry's
 * delivery receipt: `delivered` (at least one preload connection of the
 * project took it), `unreachable` (none did), `not-needed` (nothing had to be
 * sent), or `skipped-other-owner` (another session holds the project's
 * capture, so its configuration stays in force).
 */
export type ServerAgentDelivery =
  'delivered' | 'unreachable' | 'not-needed' | 'skipped-other-owner';

/**
 * A telemetry producer this service configures: the MAIN-world page agent of
 * the bound tab, or the project's dev-server preload.
 */
export type ArmedProducer = 'page-agent' | 'server-agent';

/**
 * How an `agent.config` frame fared, judged by the client registry's delivery
 * receipt: `delivered` (the bound tab's connection took it), `unreachable` (no
 * online bound-tab connection did), `not-needed` (the capture enables no page
 * hook, so nothing was sent), or `not-armed` (no capture is known to disarm, so
 * nothing was sent).
 */
export type PageAgentDelivery = 'delivered' | 'unreachable' | 'not-needed' | 'not-armed';

/** What an arm sent. */
export interface ArmCaptureOutcome {
  readonly sessionId: string;
  readonly captureId: string;
  /** The plan version whose configuration was armed. */
  readonly planVersion: number;
  /** The `agent.config` hooks sent. */
  readonly agentHooks: AgentHookConfig;
  /** The `server-agent.config` signals sent (or that would have been). */
  readonly serverSignals: ServerAgentSignals;
  /**
   * `delivered`, `unreachable` (no preload connected — the capture degrades,
   * AAP §0.5.5, and {@link unavailable} lists what it proceeds without), or
   * `not-needed` (the plan collects nothing server-side, so the preload is left
   * disabled).
   */
  readonly serverAgent: ServerAgentDelivery;
  /**
   * `delivered`, or `not-needed` when the capture enables no page hook. An arm
   * whose page frame could not be delivered is an `Err`, never an outcome.
   * Always set by this service; optional only so hand-built outcomes of other
   * suites stay valid.
   */
  readonly pageAgent?: PageAgentDelivery | undefined;
  /**
   * The server signals this capture proceeds without because the preload could
   * not be reached — one entry per enabled signal, each with its reason and the
   * next step — and empty otherwise. Always set by this service; optional only
   * so hand-built outcomes of other suites stay valid.
   */
  readonly unavailable?: readonly UnavailableSignal[] | undefined;
}

/** What {@link InstrumentationService.disarmCapture} is told. */
export interface DisarmCaptureRequest {
  /** The session whose capture window closed or is being abandoned. */
  readonly sessionId: string;
  /**
   * The capture being disarmed. Defaults to the capture this service armed.
   * `agent.config` requires one, so without either the page frame is skipped.
   */
  readonly captureId?: string | undefined;
  /** The project root, when this service holds no state for the session. */
  readonly projectRoot?: string | undefined;
}

/** What a disarm sent. */
export interface DisarmCaptureOutcome {
  readonly sessionId: string;
  /** The capture the dormant `agent.config` named, when one was sent. */
  readonly captureId?: string | undefined;
  /**
   * Whether the dormant `agent.config` was **delivered** — taken by the bound
   * tab's connection — and not merely attempted.
   */
  readonly agentDisarmed: boolean;
  /**
   * `delivered`, `unreachable`, or `skipped-other-owner` when another session
   * now holds the project's capture and its preload must stay armed.
   */
  readonly serverAgent: ServerAgentDelivery;
  /**
   * `delivered`, `unreachable`, or `not-armed` when no capture id is known, so
   * no dormant frame was sent. Always set by this service; optional only so
   * hand-built outcomes of other suites stay valid.
   */
  readonly pageAgent?: PageAgentDelivery | undefined;
  /**
   * The producers this service armed for the session that have not yet been
   * delivered their dormant configuration — `page-agent` first, then
   * `server-agent`. They are replayed when the producer reconnects
   * ({@link ProducerReconciler.producerConnected},
   * {@link ProducerReconciler.reconcileBoundSession}); an empty list means both
   * producers are known to be dormant for this session. Always set by this
   * service; optional only so hand-built outcomes of other suites stay valid.
   */
  readonly pending?: readonly ArmedProducer[] | undefined;
}

/** What {@link InstrumentationService.restoreArming} recomputes from a stored plan. */
export interface RestoreArmingInput {
  readonly sessionId: string;
  readonly projectRoot: string;
  /** The session's active, stored plan. */
  readonly plan: InstrumentationPlan;
}

/** The arming state this service holds for one session. */
export interface ArmingSnapshot {
  readonly sessionId: string;
  /** The normalised project root. */
  readonly projectRoot: string;
  /** The session's active plan version. */
  readonly activePlanVersion: number;
  /** The page-agent configuration a capture of that version arms. */
  readonly agentHooks: AgentHookConfig;
  /** The preload signal set a capture of that version arms. */
  readonly serverSignals: ServerAgentSignals;
  /** The capture currently armed, when one is. */
  readonly armedCaptureId?: string | undefined;
}

/** The instrumentation driver of one service process. */
export interface InstrumentationService {
  /**
   * Assembles the {@link InstrumentationContext} every adapter is handed —
   * every field the upstream declaration names, populated from the injected
   * collaborators. Pure apart from constructing the session's backup-store
   * handle (which touches nothing on disk).
   *
   * @returns The context, or `Err` for an empty session id, a relative or
   * empty project root, or a canonical project root that is given but not
   * absolute.
   */
  buildContext(input: BuildContextInput): Result<InstrumentationContext, DebuggenError>;

  /**
   * Installs one plan version: a session's first install, or a follow-up's
   * delta install when {@link InstallRequest.previousPlanVersion} is given.
   * With {@link InstallRequest.confirmProjectRoot}, the root is re-proved
   * before the install first acts on it and immediately before the installer,
   * and the install runs inside the confirmed canonical root.
   *
   * An install whose {@link InstallRequest.signal} was aborted — the
   * installer's error then carries `details.reason: "aborted"` — is a
   * cancellation, not a failure: it sends no `instrumentation.failed`, keeps
   * no failure report for a panel that binds later and emits no preload-gap ✗
   * row; with {@link InstallRequest.reportStageFailure} left on, the stage is
   * closed by its cancellation row instead of a `failed` one.
   *
   * @returns The outcome, or `Err` when the installer reported that nothing
   * could be enabled, when a delta failed part-way (the error's
   * `details.activePlanVersion` is the previous version), when the install was
   * cancelled, when another install for the session is still running, when
   * the root's confirmation refused or could not stand, or when a collaborator
   * threw.
   */
  install(request: InstallRequest): Promise<Result<InstrumentationOutcome, DebuggenError>>;

  /** Sends the armed `agent.config` and `server-agent.config` for a capture window. */
  armCapture(request: ArmCaptureRequest): Result<ArmCaptureOutcome, DebuggenError>;

  /** Sends the dormant `agent.config` and the capture-less `server-agent.config`. */
  disarmCapture(request: DisarmCaptureRequest): Result<DisarmCaptureOutcome, DebuggenError>;

  /**
   * Recomputes a session's arming state from its stored plan after a restart,
   * with the upstream derivations. Keeps the state this service already holds
   * for the same plan version, which the installer derived more precisely.
   */
  restoreArming(input: RestoreArmingInput): Result<ArmingSnapshot, DebuggenError>;

  /** The arming state held for one session, if any. */
  arming(sessionId: string): ArmingSnapshot | undefined;

  /** Whether an install for the session is in flight. */
  isInstalling(sessionId: string): boolean;

  /**
   * Stops watching one session and drops its in-memory state. Restores nothing:
   * end-of-session restoration belongs to the cleanup module.
   */
  stopSession(sessionId: string): Promise<void>;

  /** Stops all watching and clears all state. Idempotent. */
  dispose(): Promise<void>;
}

/** A producer connection that has just registered with the client registry. */
export interface ProducerConnection {
  /** The connection's kind; only `server-agent` and `devtools` are replayed to. */
  readonly kind: ClientKind;
  /** A `server-agent` connection's project root, from its credential's scope. */
  readonly projectRoot?: string | undefined;
  /** The sessions whose bound tabs a `devtools` connection carries. */
  readonly sessionIds?: readonly string[] | undefined;
  /**
   * When the connection's credential was issued, in epoch milliseconds. A
   * preload whose credential predates this service may still hold a
   * configuration an earlier process armed, and one whose credential predates
   * the project's last arming may have been armed then and missed the
   * disarm, so either is sent the capture-less configuration even when no
   * disarm is owed; one issued after both holds only what this service sent
   * it. Omitted, the preload is treated as possibly holding an arming.
   */
  readonly credentialIssuedAt?: number | undefined;
}

/** What {@link ProducerReconciler.producerConnected} replayed. */
export interface ProducerReplayOutcome {
  /** The sessions whose open capture was re-armed on the reconnected producer. */
  readonly rearmed: readonly string[];
  /** The sessions whose outstanding disarm the replay delivered or superseded. */
  readonly disarmed: readonly string[];
  /**
   * How the preload replay fared for a `server-agent` connection, and
   * `not-applicable` for any other kind.
   */
  readonly serverAgent: ServerAgentDelivery | 'not-applicable';
}

/** What {@link ProducerReconciler.reconcileBoundSession} is told after a tab (re)binds. */
export interface BoundSessionReconcileRequest {
  readonly sessionId: string;
  /** The session's project root. */
  readonly projectRoot: string;
  /** The session's open capture window, when it has one. */
  readonly activeCaptureId?: string | undefined;
  /** The session's most recent capture, from the store, when it has one. */
  readonly lastCaptureId?: string | undefined;
  /**
   * When that capture started, in epoch milliseconds. A capture this service
   * saw open is answered by its own record — the page holds it only if this
   * service armed it and has not disarmed it — so its id alone sends nothing.
   * Omitted, or earlier than this service, the capture belongs to an earlier
   * process and its page agent is sent the dormant configuration unless this
   * service already delivered it.
   */
  readonly lastCaptureStartedAt?: number | undefined;
}

/**
 * What {@link ProducerReconciler.reconcileBoundSession} did:
 * `capture-active` (a capture is open, so the caller re-arms instead; nothing
 * sent), `dormant-delivered` (the bound tab's connection took the dormant
 * `agent.config`), `dormant-unreachable` (it did not; any outstanding disarm is
 * kept), `already-dormant` (this process already delivered the dormant
 * configuration for that capture and nothing is outstanding), or
 * `nothing-armed` (no capture is known, or the last one was opened by this
 * service and is not armed in the page, so there is nothing to disarm).
 */
export type BoundSessionReconcileOutcome =
  | 'capture-active'
  | 'dormant-delivered'
  | 'dormant-unreachable'
  | 'already-dormant'
  | 'nothing-armed';

/**
 * What {@link ProducerReconciler.pageAgentReleased} did: `settled` (the
 * session owed its page agent the dormant configuration, and that disarm is
 * now settled) or `nothing-owed` (no page disarm was outstanding, so nothing
 * changed).
 */
export type PageAgentReleaseOutcome = 'settled' | 'nothing-owed';

/**
 * What {@link ProducerReconciler.releaseInterruptedCapture} is told about a
 * capture window a restart ended: the previous process had armed it, and the
 * session was failed, since no capture is continued across a restart.
 */
export interface InterruptedCaptureInput {
  readonly sessionId: string;
  /** The capture window the previous process held open. */
  readonly captureId: string;
  /** The session's project root. */
  readonly projectRoot: string;
  /**
   * The stored plan the capture was opened with. Without it, which producers
   * the capture armed is unknown, so both are treated as still holding it.
   */
  readonly plan?: InstrumentationPlan | undefined;
}

/**
 * The producer-state half of the driver: what keeps this service's belief
 * about the two producers true across disconnects and restarts.
 *
 * The AAP §0.4.2 protocol has no producer acknowledgement message — a producer
 * applies `agent.config` / `server-agent.config` and says nothing — so the
 * receipt of the producer's own connection is the acknowledgement this service
 * can verify. A configuration that no connection took is remembered as
 * outstanding and replayed when the producer comes back.
 */
export interface ProducerReconciler {
  /**
   * Replays outstanding configuration to a producer connection that has just
   * registered: a preload is re-armed for the project's open capture or
   * disabled when none is open; a DevTools connection's page agents are
   * re-armed for their open captures or sent their outstanding dormant
   * configuration. Never throws.
   */
  producerConnected(connection: ProducerConnection): ProducerReplayOutcome;

  /**
   * Returns a freshly bound tab's page agent to dormant when its session has no
   * open capture — the path that disarms a page agent which outlived a service
   * restart or a failed disarm.
   *
   * @returns The outcome, or `Err` for an empty session id or a relative
   * project root.
   */
  reconcileBoundSession(
    request: BoundSessionReconcileRequest,
  ): Result<BoundSessionReconcileOutcome, DebuggenError>;

  /**
   * Disarms a capture window a restart ended. The producers the previous
   * process armed for it — those the plan enables, or both when the plan is
   * unknown — may still hold its configuration, so they are recorded as armed
   * for it and then disarmed exactly as
   * {@link InstrumentationService.disarmCapture} would: a dormant configuration
   * no connection takes becomes outstanding, is replayed when the producer
   * reconnects, and keeps the session's cleanup `partial` until then.
   *
   * @returns The disarm's outcome, or `Err` for invalid input.
   */
  releaseInterruptedCapture(
    input: InterruptedCaptureInput,
  ): Result<DisarmCaptureOutcome, DebuggenError>;

  /**
   * Settles the page disarm an ended session still owes, because the tab that
   * held it has just been refused a re-bind to it.
   *
   * The disarm became owed when the session ended while the tab's DevTools
   * connection was away — no connection took the dormant `agent.config` — and
   * it can no longer be replayed the usual way:
   * {@link ProducerReconciler.producerConnected} and
   * {@link ProducerReconciler.reconcileBoundSession} reach a page agent
   * through a live binding, and an ended session is never bound again. When
   * that connection comes back it re-announces the tab's binding to the ended
   * session; the binding route refuses it (`SESSION_INVALID_STATE`, or
   * `SESSION_NOT_FOUND` for a session that vanished) and calls this.
   *
   * The contract that makes this a settlement rather than a guess: the refusal
   * is delivered on the live connection that asked, and the DevTools service
   * worker answers exactly that refusal by ending the tab's binding as
   * `session-ended`, which returns the tab's page agent to its dormant
   * configuration (AAP §0.5.1) — the one delivery this service could not make
   * itself. Settling the owed disarm fires
   * {@link ProducerReconciler.onDormancyConfirmed} when it empties the
   * session's pending set, which upgrades a `partial` cleanup. The preload's
   * owed disarm, if any, is untouched: only its own reconnect settles it.
   *
   * @returns Whether a page disarm was settled, or `Err` for an empty session id.
   */
  pageAgentReleased(sessionId: string): Result<PageAgentReleaseOutcome, DebuggenError>;

  /**
   * The producers of one session still owed their dormant configuration,
   * `page-agent` first, then `server-agent`.
   */
  pendingDisarms(sessionId: string): readonly ArmedProducer[];

  /**
   * Subscribes to "every outstanding disarm of a session is settled": fired
   * once whenever a replay, a supersession or a later disarm empties a
   * session's previously non-empty pending set. A listener that throws is
   * logged and never affects the others.
   *
   * @returns The unsubscribe function.
   */
  onDormancyConfirmed(listener: (sessionId: string) => void): () => void;
}

/** What {@link SignalReportPublisher.replaySignalReport} replays, and to whom. */
export interface SignalReportReplayRequest {
  /** The session whose latest signal report is replayed. */
  readonly sessionId: string;
  /**
   * The tab the session is bound to now. Remembered as the page a later
   * refresh of the report waits on; omitted, the tab this service last knew
   * for the session is kept.
   */
  readonly boundTab?: BoundTab | undefined;
  /** The client kinds the replay is sent to — for a bind, the DevTools panel alone. */
  readonly kinds: readonly ClientKind[];
}

/**
 * What a replay did: `replayed` (the latest report, the latest failure, or
 * both, were sent) or `nothing-to-replay` (this process has installed nothing
 * for the session, so it holds no report — after a restart, say).
 */
export type SignalReportReplayOutcome = 'replayed' | 'nothing-to-replay';

/**
 * The signal-report half of the driver: what keeps a panel's "Signals" list
 * in step with the session's latest install, whenever the panel attaches.
 *
 * Kept apart from {@link InstrumentationService} on purpose: that surface is
 * what the pipeline consumes and what a capture-readiness wrapper re-exposes
 * member by member, and a replay is the binding layer's concern alone.
 */
export interface SignalReportPublisher {
  /**
   * Sends the session's latest signal report to `kinds`: the latest
   * `instrumentation.ready` this service composed — installer fields,
   * corrected by any later refresh — and, when the latest install failed, the
   * `instrumentation.failed` it announced, after it. Synchronous: both frames
   * are sent before it returns.
   *
   * It also records `boundTab` and, when the report still holds a gap a newer
   * page report could clear, schedules a background refresh: the report is
   * re-judged against the tab's facts now and after its next document
   * reports, and a corrected `instrumentation.ready` — with ✓ rows for the
   * signals it newly confirms — is sent to both user interfaces when it
   * changed. The refresh never emits "Ready to capture": moving a session to
   * `ready` is the orchestrator's. A replay that arrives while an install for
   * the session runs sends what is held now; the install's own report reaches
   * the bound panel through its broadcast, and is re-judged against `boundTab`
   * as soon as that install is over.
   *
   * @returns `nothing-to-replay` when no report is held, `Err` for a malformed
   * request, a disposed service, or a frame the client registry threw on.
   */
  replaySignalReport(
    request: SignalReportReplayRequest,
  ): Result<SignalReportReplayOutcome, DebuggenError>;
}

/**
 * The full driver {@link createInstrumentationService} returns: the service
 * surface every stage and route consumes, the producer reconciler that the
 * connection and binding layers drive, and the signal-report publisher the
 * binding layer replays through.
 */
export type InstrumentationDriver = InstrumentationService &
  ProducerReconciler &
  SignalReportPublisher;

// ---------------------------------------------------------------------------
// Section D — pure helpers
// ---------------------------------------------------------------------------

/**
 * Rewrites any text as one line of display text: control characters become
 * spaces, whitespace runs collapse to one space, and the ends are trimmed.
 */
function toDisplayLine(text: string): string {
  let spaced = '';

  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    spaced += code < 0x20 || code === 0x7f ? ' ' : character;
  }

  return spaced.replace(WHITESPACE_RUN_PATTERN, ' ').trim();
}

/** Clips display text to `maxLength` code units, closing a clipped text with an ellipsis. */
function clip(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

/** The display label of a reported signal: its product label, or the reported name itself. */
function labelForSignal(signal: string): string {
  return isCaptureSignal(signal) ? CAPTURE_SIGNAL_LABELS[signal] : toDisplayLine(signal);
}

/**
 * Builds the AAP §0.5.5 degradation sentence for every signal that could not be
 * enabled: "Could not enable ‹signal›: ‹reason›. Continuing with: ‹enabled
 * list›."
 *
 * Each sentence is `../sessions/progress.ts`'s `unavailableSignalMessage`, the
 * one composer the checklist's ✗ rows use too, so a sentence returned here is
 * byte-identical to the row the progress view shows for the same entry and
 * the same `enabledLabels`:
 *
 * - **‹signal›** is the product's label from `CAPTURE_SIGNAL_LABELS` for one of
 *   the known capture signals, and the reported name for a signal a registered
 *   third-party adapter defined. No label is restated here.
 * - **‹reason›** is the adapter's reason, as one bounded line, with trailing
 *   whitespace and full stops dropped so the sentence closes it once.
 * - **‹enabled list›** is `enabledLabels` in the order given, less the entry's
 *   own label, bounded; "no confirmed signal" when nothing remains.
 *
 * One sentence per entry, in input order; byte-identical sentences collapse
 * onto the first, and an entry whose signal is blank yields none. The entry's
 * `hint` — for a server-tier gap, the exact relaunch command — is not part of
 * the sentence: it travels as the progress row's detail and in
 * `instrumentation.ready`, verbatim.
 *
 * Pure: no clock, no logger, no I/O.
 *
 * @param unavailable The signals the installer could not enable.
 * @param enabledLabels The labels of the signals the capture proceeds with, in
 * the progress view's ✓ order.
 * @returns The sentences, frozen.
 */
export function buildDegradationNotice(
  unavailable: readonly UnavailableSignal[],
  enabledLabels: readonly string[],
): readonly string[] {
  const sentences: string[] = [];
  const seen = new Set<string>();

  for (const entry of unavailable) {
    const sentence = unavailableSignalMessage(
      labelForSignal(entry.signal),
      entry.reason,
      enabledLabels,
    );

    if (sentence !== undefined && !seen.has(sentence)) {
      seen.add(sentence);
      sentences.push(sentence);
    }
  }

  return Object.freeze(sentences);
}

/**
 * The page-agent hooks a capture of a plan version arms: the installer's
 * configuration widened with the hooks of the plan's runtime actions.
 *
 * This is the widening `armCapture` applies when it builds `agent.config` — a
 * runtime hook an adapter left unarmed because no page agent had reported yet
 * is armed at capture time, since arming one edits no file — so the checklist
 * judges exactly the hooks the capture will send, no more and no fewer.
 *
 * @param agentHooks The configuration the installer (or the delta union) produced.
 * @param actions The plan version's actions; only the runtime ones widen it.
 * @returns The hooks the next capture arms.
 */
function captureAgentHooks(
  agentHooks: AgentHookConfig,
  actions: readonly InstrumentationAction[],
): AgentHookConfig {
  return unionAgentHooks(
    agentHooks,
    deriveAgentHookConfig(actions.filter((action) => action.mode === RUNTIME_ACTION_MODE)),
  );
}

/**
 * The capture signals an installed configuration arms, read with the rules the
 * progress view's ✓ rows use: a page-agent hook flag, a preload flag or a
 * non-empty `functions` list, and a runtime-hook entry that is exactly a signal
 * name or exactly a label. A label arms every signal it stands for, because
 * choosing one of them would be a guess; readiness then decides which of them
 * a producer will actually deliver.
 *
 * Pure: the configuration is read, never kept.
 *
 * @example
 * ```ts
 * armedCaptureSignals(hooks, signals, ['Database tracing']); // ⊇ { 'prisma', 'pg' }
 * ```
 */
function armedCaptureSignals(
  agentHooks: AgentHookConfig,
  serverSignals: ServerAgentSignals,
  runtimeHooks: readonly string[],
): ReadonlySet<CaptureSignal> {
  const armed = new Set<CaptureSignal>();

  for (const key of AGENT_HOOK_KEYS) {
    if (agentHooks[key]) {
      armed.add(key);
    }
  }

  for (const key of SERVER_AGENT_SIGNAL_KEYS) {
    const value = serverSignals[key];

    if (value === true || (Array.isArray(value) && value.length > 0)) {
      armed.add(key);
    }
  }

  const hookNames = new Set<string>(runtimeHooks);

  for (const signal of CAPTURE_SIGNALS) {
    if (hookNames.has(signal) || hookNames.has(CAPTURE_SIGNAL_LABELS[signal])) {
      armed.add(signal);
    }
  }

  return armed;
}

/**
 * The signals the checklist may show ✓: every signal the readiness verdict
 * found deliverable and does not hold the session back on, that the capture
 * also arms, minus every signal the installer reported unavailable — in
 * capture-signal order.
 *
 * Every condition is required. A deliverable signal nothing arms collects
 * nothing, and an armed signal readiness did not confirm — a server signal with
 * no connected preload, a page signal with no agent for the bound document —
 * has no producer to collect it. A signal the verdict lists as blocking is
 * never confirmed either, even when it also counts as deliverable: the one
 * such case is a signal two producers share (`fetch`) whose page half is
 * gated, and arming is not tracked per producer here, so a ✓ could stand for
 * the half that will collect nothing. Showing any of these as enabled would
 * present a failure as success (AAP §0.5.5).
 *
 * @param verdict The verdict's deliverable and blocking signals.
 * @param armed What the capture arms ({@link armedCaptureSignals}).
 * @param unavailable The installer's unavailable signals, each withdrawn.
 * @returns The confirmed signals, frozen.
 */
function confirmedSignals(
  verdict: Pick<ReadinessVerdict, 'deliverableSignals' | 'blocking'>,
  armed: ReadonlySet<CaptureSignal>,
  unavailable: readonly UnavailableSignal[],
): readonly CaptureSignal[] {
  const delivered = new Set<CaptureSignal>(verdict.deliverableSignals);
  const withheld = new Set<string>([
    ...verdict.blocking.map((gap) => gap.signal),
    ...unavailable.map((entry) => entry.signal),
  ]);

  return Object.freeze(
    CAPTURE_SIGNALS.filter(
      (signal) => delivered.has(signal) && armed.has(signal) && !withheld.has(signal),
    ),
  );
}

/**
 * The display labels of `signals`, de-duplicated by label and ordered as the
 * progress view orders its ✓ rows, so the "Continuing with:" list and the
 * checklist read the same.
 */
function labelsOfSignals(signals: readonly CaptureSignal[]): readonly string[] {
  const labels = new Set<string>(signals.map((signal) => CAPTURE_SIGNAL_LABELS[signal]));

  return INSTRUMENTATION_ROW_ORDER.filter((label) => labels.has(label));
}

/**
 * Rewrites a gap's reason or hint as readiness-row text: every C0, DEL and C1
 * control character becomes a space — the readiness schema refuses all three,
 * where {@link toDisplayLine} only rewrites the first two — whitespace runs
 * collapse, the ends are trimmed and the text is clipped to `maxLength`.
 *
 * @param text The gap's text; anything but a string yields nothing.
 * @param maxLength The schema's bound for the field.
 * @returns The single-line text, or `undefined` when nothing printable remains,
 * so the row omits the key instead of carrying a blank the schema refuses.
 */
function toReadinessText(text: unknown, maxLength: number): string | undefined {
  if (typeof text !== 'string') {
    return undefined;
  }

  let spaced = '';

  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    spaced += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : character;
  }

  const line = clip(spaced.replace(WHITESPACE_RUN_PATTERN, ' ').trim(), maxLength);

  return line.length === 0 ? undefined : line;
}

/** The first gap naming `signal`, searching `sources` in the order given. */
function gapFor(
  signal: CaptureSignal,
  sources: readonly (readonly UnavailableSignal[])[],
): UnavailableSignal | undefined {
  for (const source of sources) {
    const gap = source.find((entry) => entry.signal === signal);

    if (gap !== undefined) {
      return gap;
    }
  }

  return undefined;
}

/** One aggregate readiness row, carrying the gap's reason and hint when it has any. */
function readinessRow(
  signal: CaptureSignal,
  status: ReadinessStatus,
  gap: UnavailableSignal | undefined,
): ReadinessSignal {
  const reason = toReadinessText(gap?.reason, READINESS_REASON_MAX_LENGTH);
  const hint = toReadinessText(gap?.hint, READINESS_HINT_MAX_LENGTH);

  return {
    signal,
    status,
    ...(reason === undefined ? {} : { reason }),
    ...(hint === undefined ? {} : { hint }),
  };
}

/**
 * The aggregate readiness report the checklist is drawn from: one row per
 * signal the plan needs, in the verdict's order.
 *
 * | Planned signal | Status | Reason and hint |
 * | --- | --- | --- |
 * | confirmed, no verdict gap | `available` | — |
 * | confirmed, with a degraded gap in the verdict | `degraded` | the gap's |
 * | not confirmed | `unavailable` | the verdict's blocking gap, else its degraded gap, else the installer's entry |
 *
 * The progress module turns an `unavailable` row into a ✗ row — "Could not
 * enable ‹signal›: ‹reason›." with the hint (for a missing preload, the exact
 * relaunch command) as its detail — unless the installer already reported that
 * signal, and a `degraded` row into a ✓ row that explains itself.
 *
 * Built with `buildReadiness` and no adapter id, because the service's
 * aggregate belongs to no single adapter. Every text is single-line, clipped
 * to `READINESS_REASON_MAX_LENGTH` / `READINESS_HINT_MAX_LENGTH` and omitted
 * when blank, so every row satisfies `readinessSignalSchema`.
 *
 * A signal in `awaitingPage` gets no row here: it is waiting for a tab to be
 * bound or for the bound tab's page to report, which its waiting row says,
 * and a ✗ row would present it as a failure (AAP §0.5.5).
 *
 * Pure apart from reading `now` once.
 *
 * @param verdict The readiness verdict of the installed plan version.
 * @param confirmed The signals {@link confirmedSignals} kept.
 * @param unavailable The installer's unavailable signals.
 * @param now The clock `checkedAt` is read from.
 * @param awaitingPage The signals held back only on the page gate; none by default.
 * @returns The report.
 */
function buildConfirmedReadiness(
  verdict: Pick<ReadinessVerdict, 'plannedSignals' | 'blocking' | 'degraded'>,
  confirmed: readonly CaptureSignal[],
  unavailable: readonly UnavailableSignal[],
  now: () => number,
  awaitingPage: ReadonlySet<CaptureSignal> = new Set<CaptureSignal>(),
): Readiness {
  const kept = new Set<CaptureSignal>(confirmed);
  const reported = verdict.plannedSignals.filter(
    (signal) => kept.has(signal) || !awaitingPage.has(signal),
  );
  const signals = reported.map((signal) => {
    if (kept.has(signal)) {
      const gap = gapFor(signal, [verdict.degraded]);
      return readinessRow(signal, gap === undefined ? AVAILABLE_STATUS : DEGRADED_STATUS, gap);
    }

    return readinessRow(
      signal,
      UNAVAILABLE_STATUS,
      gapFor(signal, [verdict.blocking, verdict.degraded, unavailable]),
    );
  });

  return buildReadiness({ signals, now });
}

/**
 * Widens one page-agent configuration with another: a hook either enables
 * stays on. Both inputs already satisfy the upstream prerequisite (any hook on
 * implies the interaction listener on), and a union of two such configurations
 * does too.
 */
function unionAgentHooks(first: AgentHookConfig, second: AgentHookConfig): AgentHookConfig {
  const merged: Record<(typeof AGENT_HOOK_KEYS)[number], boolean> = {
    ...DORMANT_AGENT_HOOK_CONFIG,
  };

  for (const key of AGENT_HOOK_KEYS) {
    merged[key] = first[key] || second[key];
  }

  return merged;
}

/** The keys of {@link ServerAgentSignals} whose values are on/off flags. */
type ServerAgentFlagKey = {
  [K in keyof ServerAgentSignals]: ServerAgentSignals[K] extends boolean ? K : never;
}[keyof ServerAgentSignals];

/** Whether a preload signal key is an on/off flag, judged from the upstream disabled set. */
function isServerAgentFlagKey(key: keyof ServerAgentSignals): key is ServerAgentFlagKey {
  return typeof DISABLED_SERVER_AGENT_SIGNALS[key] === 'boolean';
}

/**
 * Widens one preload signal set with another: a flag either enables stays on,
 * and the timed symbol names are united, de-duplicated and ordered by code unit
 * as the upstream derivation orders them. Walks the upstream key list, so a
 * signal added upstream is united here without an edit.
 */
function unionServerSignals(
  first: ServerAgentSignals,
  second: ServerAgentSignals,
): ServerAgentSignals {
  const merged: ServerAgentSignals = {
    ...DISABLED_SERVER_AGENT_SIGNALS,
    functions: [...new Set([...first.functions, ...second.functions])].sort(),
  };

  for (const key of SERVER_AGENT_SIGNAL_KEYS) {
    if (isServerAgentFlagKey(key)) {
      merged[key] = first[key] || second[key];
    }
  }

  return merged;
}

/** Whether one preload signal is enabled: a flag that is on, or a non-empty name list. */
function isServerSignalEnabled(
  signals: ServerAgentSignals,
  key: keyof ServerAgentSignals,
): boolean {
  const value = signals[key];
  return value === true || (Array.isArray(value) && value.length > 0);
}

/** Whether a preload signal set collects anything at all. */
function collectsServerSignals(signals: ServerAgentSignals): boolean {
  return SERVER_AGENT_SIGNAL_KEYS.some((key) => isServerSignalEnabled(signals, key));
}

/** Whether a page-agent configuration enables any hook, so a capture needs the page agent. */
function enablesAnyPageHook(hooks: AgentHookConfig): boolean {
  return AGENT_HOOK_KEYS.some((key) => hooks[key]);
}

/** Whether the page agent collects `signal` itself under `hooks`. */
function pageCollects(hooks: AgentHookConfig, signal: string): boolean {
  return AGENT_HOOK_KEYS.some((key) => key === signal && hooks[key]);
}

/**
 * The gaps of a capture whose preload could not be reached: one entry per
 * enabled server signal, in the upstream key order, each with the same reason
 * and next step. Pure.
 */
function preloadGaps(signals: ServerAgentSignals): readonly UnavailableSignal[] {
  return Object.freeze(
    SERVER_AGENT_SIGNAL_KEYS.filter((key) => isServerSignalEnabled(signals, key)).map((key) =>
      Object.freeze({
        signal: key,
        reason: PRELOAD_UNREACHABLE_REASON,
        hint: PRELOAD_UNREACHABLE_HINT,
      }),
    ),
  );
}

/** Appends the entries of `extra` not already in `base`, keeping first occurrences. */
function unionStrings(base: readonly string[], extra: readonly string[]): readonly string[] {
  return [...new Set([...base, ...extra])];
}

/** Whether a value is a non-null, non-array object whose keys can be read. */
function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a value has the shape of an {@link UnavailableSignal}: three strings. */
function isGapLike(value: unknown): value is UnavailableSignal {
  return (
    isObjectRecord(value) &&
    typeof value['signal'] === 'string' &&
    typeof value['reason'] === 'string' &&
    typeof value['hint'] === 'string'
  );
}

/** Whether two gaps say the same thing: the same signal, reason and hint. */
function sameGap(first: UnavailableSignal, second: UnavailableSignal): boolean {
  return (
    first.signal === second.signal && first.reason === second.reason && first.hint === second.hint
  );
}

/**
 * `entries` with one occurrence of each gap in `removed` taken out, compared by
 * value — a multiset difference, so a gap two sources reported identically is
 * removed once per source. Order is kept. Returns `entries` itself when
 * nothing was removed.
 */
function withoutGaps(
  entries: readonly UnavailableSignal[],
  removed: readonly UnavailableSignal[],
): readonly UnavailableSignal[] {
  if (removed.length === 0) {
    return entries;
  }

  const remaining = [...removed];
  const kept = entries.filter((entry) => {
    const index = remaining.findIndex((candidate) => sameGap(candidate, entry));

    if (index === -1) {
      return true;
    }

    remaining.splice(index, 1);
    return false;
  });

  return kept.length === entries.length ? entries : kept;
}

/** Whether two string lists hold the same entries in the same order. */
function sameStrings(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((entry, index) => entry === second[index]);
}

/** Whether two gap lists hold the same gaps in the same order. */
function sameGaps(
  first: readonly UnavailableSignal[],
  second: readonly UnavailableSignal[],
): boolean {
  return (
    first.length === second.length &&
    first.every((entry, index) => {
      const other = second[index];
      return other !== undefined && sameGap(entry, other);
    })
  );
}

/**
 * Whether the observed facts a runtime share depends on differ between two
 * readings: whether a page agent is known and, for one that is, its document,
 * its install timing and whether it found React; and whether a preload is
 * connected. Receipt times and producer ids are not facts an adapter judges.
 */
function observedFactsDiffer(
  first: ObservedReadinessInputs,
  second: ObservedReadinessInputs,
): boolean {
  const before = first.browserAgent;
  const after = second.browserAgent;

  if ((before === undefined) !== (after === undefined)) {
    return true;
  }

  if (
    before !== undefined &&
    after !== undefined &&
    (before.documentId !== after.documentId ||
      before.installedBeforeReact !== after.installedBeforeReact ||
      before.reactDetected !== after.reactDetected)
  ) {
    return true;
  }

  return (first.serverAgent?.connected === true) !== (second.serverAgent?.connected === true);
}

/** The page-agent hooks a raw install result contributed, as additive flags. */
function hookContributionOf(value: unknown): Partial<AgentHookConfig> {
  const contribution: Partial<Record<(typeof AGENT_HOOK_KEYS)[number], boolean>> = {};

  if (isObjectRecord(value)) {
    for (const key of AGENT_HOOK_KEYS) {
      if (value[key] === true) {
        contribution[key] = true;
      }
    }
  }

  return contribution;
}

/** The preload signals a raw install result contributed, as a full additive set. */
function serverContributionOf(value: unknown): ServerAgentSignals {
  const functions =
    isObjectRecord(value) && Array.isArray(value['functions'])
      ? value['functions'].filter(isNonBlankString)
      : [];
  const merged: ServerAgentSignals = { ...DISABLED_SERVER_AGENT_SIGNALS, functions };

  if (isObjectRecord(value)) {
    for (const key of SERVER_AGENT_SIGNAL_KEYS) {
      if (isServerAgentFlagKey(key) && value[key] === true) {
        merged[key] = true;
      }
    }
  }

  return merged;
}

/**
 * Widens a page-agent configuration with the hooks a set of actions derives and
 * an adapter's own contribution — additive only — then re-closes the upstream
 * prerequisite the installer closes: any hook on turns the interaction
 * listener on, since it mints the trace root the other hooks hang off.
 */
function widenAgentHooks(
  base: AgentHookConfig,
  actions: readonly InstrumentationAction[],
  contribution: Partial<AgentHookConfig>,
): AgentHookConfig {
  const merged: Record<(typeof AGENT_HOOK_KEYS)[number], boolean> = {
    ...unionAgentHooks(base, deriveAgentHookConfig(actions)),
  };

  for (const key of AGENT_HOOK_KEYS) {
    if (contribution[key] === true) {
      merged[key] = true;
    }
  }

  if (AGENT_HOOK_KEYS.some((key) => merged[key])) {
    merged.interactions = true;
  }

  return merged;
}

/** Whether a value is a non-blank string. */
function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Normalises a project root to an absolute POSIX path — backslashes become
 * slashes, `.`/`..` segments and trailing separators are resolved — and refuses
 * an empty or relative one. A Windows drive path is accepted only after that
 * normalisation, never as written.
 */
function normalizeProjectRoot(projectRoot: unknown): Result<string, DebuggenError> {
  if (!isNonBlankString(projectRoot)) {
    return err(
      new DebuggenError(
        'PROJECT_NOT_FOUND',
        'Instrumentation was asked about an empty project root.',
        {
          hint: 'Pass the absolute path of the project being debugged.',
          details: { field: 'projectRoot' },
        },
      ),
    );
  }

  const posix = toPosix(projectRoot.trim());

  if (!isAbsolutePosix(posix) && !isWindowsAbsolute(posix)) {
    return err(
      new DebuggenError(
        'PROJECT_NOT_FOUND',
        'Instrumentation was asked about a relative project root.',
        {
          hint: 'Pass the absolute path of the project being debugged.',
          details: { field: 'projectRoot' },
        },
      ),
    );
  }

  return ok(normalizePosix(posix));
}

/** A programmer-level input error: the wiring, not the developer's project, is wrong. */
function wiringError(message: string, hint: string, field: string): DebuggenError {
  return new DebuggenError('INTERNAL', message, { hint, details: { field } });
}

/**
 * The act a {@link InstallRequest.confirmProjectRoot} call guards, as its log
 * record names it: the state-root separation check, the install's first act on
 * the root; or the hand-over of the plan to the installer.
 */
type RootConfirmationStage = 'before-state-root-check' | 'before-install';

/** Why an answer of {@link InstallRequest.confirmProjectRoot} could not stand as a confirmation. */
type RootConfirmationFailure =
  'project-root-confirmation-threw' | 'project-root-confirmation-invalid';

/**
 * A `details.reason` of the shape this module logs: a short kebab-case word
 * list. A confirmation's refusal is a caller's value, so its reason is logged
 * only when it has this closed shape — never free text that could hold a path.
 */
const LOGGABLE_REASON = /^[a-z][a-z0-9-]{0,63}$/u;

/**
 * Whether `value` is a non-empty absolute path, POSIX or Windows-style, read
 * as given — a canonical path is never trimmed, since its every character is
 * the filesystem's.
 */
function isAbsoluteRootPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }

  const posix = toPosix(value);
  return isAbsolutePosix(posix) || isWindowsAbsolute(posix);
}

/**
 * The canonical root a confirmation answered, read structurally because the
 * answer is a caller's, which the compiler may not have checked; `undefined`
 * when it names no absolute path.
 */
function confirmedCanonicalRoot(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('canonicalRoot' in value)) {
    return undefined;
  }

  const { canonicalRoot } = value;
  return isAbsoluteRootPath(canonicalRoot) ? canonicalRoot : undefined;
}

/**
 * The refusal of an install whose project-root confirmation could not stand:
 * `INTERNAL`, because it is a defect of the caller's check rather than
 * anything the developer did. Constant sentences that name no path, and no
 * cause, so a thrown value's text never reaches a frame or a record.
 */
function rootConfirmationError(reason: RootConfirmationFailure): DebuggenError {
  return new DebuggenError(
    'INTERNAL',
    'The project root could not be confirmed, so no instrumentation was installed.',
    {
      hint: 'The service log holds the reason. Start the session again from the project folder in VS Code.',
      details: { reason },
    },
  );
}

/** An error's `details.reason`, when it has the shape this module logs. */
function loggableReasonOf(error: DebuggenError): string | undefined {
  const reason = error.details?.['reason'];
  return typeof reason === 'string' && LOGGABLE_REASON.test(reason) ? reason : undefined;
}

/**
 * The `details.reason` the installer (`packages/instrumentation/src/installer.ts`)
 * gives the error of an install whose context's signal was aborted — before
 * the first adapter was asked, or between two asks — after it unwound what the
 * call applied.
 */
const INSTALL_ABORTED_REASON = 'aborted';

/**
 * Whether an install error reports a cancelled install rather than a failed
 * one, by the installer's own classification ({@link INSTALL_ABORTED_REASON}).
 * The service's re-issues of an installer error ({@link withServiceRelaunchHint},
 * {@link withHeldTargetHint}, {@link withPlanVersions}) keep its details, so
 * the classification survives them.
 *
 * @param error An install error, as `prepareInstall` answered it.
 * @returns `true` when the install was cancelled.
 */
function isCancelledInstall(error: DebuggenError): boolean {
  return error.details?.['reason'] === INSTALL_ABORTED_REASON;
}

/**
 * Re-issues an install error with the plan versions it concerns in its details,
 * keeping its code, message, hint and the original as its cause, so a caller —
 * and a suite — can read which version the session was left at.
 */
function withPlanVersions(
  error: DebuggenError,
  versions: { readonly planVersion: number; readonly activePlanVersion: number | undefined },
): DebuggenError {
  const details: Record<string, unknown> = { ...error.details, planVersion: versions.planVersion };

  if (versions.activePlanVersion !== undefined) {
    details['activePlanVersion'] = versions.activePlanVersion;
  }

  const options: {
    hint?: string;
    details: Readonly<Record<string, unknown>>;
    cause: unknown;
  } = { details, cause: error };

  if (error.hint !== undefined) {
    options.hint = error.hint;
  }

  return new DebuggenError(error.code, error.message, options);
}

/**
 * Whether an unavailable signal is a gap only the dev-server preload can close
 * for this capture:
 *
 * - a signal only the preload supplies (`PRELOAD_DEPENDENT_SIGNALS`: incoming
 *   requests, route handlers, database queries and function timing); or
 * - a preload signal the page agent also collects (`fetch`), when `pageHooks`
 *   arms the page's share. The page then delivers its half, so a gap still
 *   reported for that signal can only be the server's. When the page does not
 *   arm it, the gap may be the page's own — no tab bound, a hook withheld — and
 *   is not claimed for the preload.
 *
 * Pure.
 *
 * @param signal The unavailable entry's signal.
 * @param pageHooks The page-agent hooks the capture arms.
 * @returns Whether relaunching the dev server with the preload closes the gap.
 */
function isPreloadGap(signal: string, pageHooks: AgentHookConfig): boolean {
  return (
    PRELOAD_DEPENDENT_SIGNALS.some((dependent) => dependent === signal) ||
    (SERVER_AGENT_SIGNAL_KEYS.some((key) => key === signal) && pageCollects(pageHooks, signal))
  );
}

/**
 * The exact relaunch command this install's dev-server detection composed — its
 * `relaunchHint` — when the detection found the preload missing and the hint is
 * proven product text (`isProductAuthoredText`; `../dev-server/detect.ts`
 * registers every hint it composes). `undefined` without a detection, with the
 * preload attached, or for a hint this process did not compose, which is never
 * shown in place of anything.
 *
 * @param devServer The detection readiness collected for the install, if it ran.
 * @returns The proven relaunch hint, or `undefined`.
 */
function provenRelaunchHint(
  devServer: Pick<DevServerDetection, 'preloadAttached' | 'relaunchHint'> | undefined,
): string | undefined {
  return devServer !== undefined &&
    !devServer.preloadAttached &&
    isProductAuthoredText(devServer.relaunchHint)
    ? devServer.relaunchHint
    : undefined;
}

/**
 * Gives every preload gap of an install the exact relaunch command the
 * install's own dev-server detection composed (AAP §0.5.5: "if the dev server
 * was not started with the preload, the hint carries the exact relaunch
 * command").
 *
 * An adapter speaks about a preload it cannot see: its hint can only name the
 * preload by package specifier — which the target project need not resolve —
 * and carries no ingest address or credential, so it does not start an
 * instrumented dev server. The detection renders the command the launcher
 * runs: the editor's token-free "Launch Dev Server" route first, then the
 * manual line with the absolute `file:` URL of the preload this service
 * resolved, the service's ingest URL, the project root and the
 * `"$DEBUGGEN_TOKEN"` reference. So when the detection found the preload
 * missing and its `relaunchHint` is proven product text, the `hint` of every
 * entry that is a preload gap ({@link isPreloadGap}) becomes that
 * `relaunchHint`; its `signal` and `reason` are kept. Every other entry — a
 * page signal, a third-party signal, a shared signal the page does not arm —
 * keeps its own hint, and with the preload attached nothing changes.
 *
 * Applied once per install, before the session's state is recorded, so
 * `instrumentation.ready`, the degradation rows, the checklist's ✗ rows and
 * the outcome all show the same command.
 *
 * Pure apart from refreshing the provenance registry's recency for the hint.
 *
 * @param unavailable The installer's unavailable signals.
 * @param devServer The dev-server detection readiness collected for the install, if it ran.
 * @param pageHooks The page-agent hooks the next capture arms ({@link captureAgentHooks}).
 * @returns `unavailable` itself when no entry changes, otherwise a frozen copy.
 *
 * @example
 * ```ts
 * // detection.preloadAttached === false; detection.relaunchHint composed by detect.ts
 * withDetectedRelaunchHints(
 *   [{ signal: 'http', reason: 'no preload is attached', hint: adapterHint }],
 *   detection,
 *   pageHooks,
 * ); // → [{ signal: 'http', reason: 'no preload is attached', hint: detection.relaunchHint }]
 * ```
 */
export function withDetectedRelaunchHints(
  unavailable: readonly UnavailableSignal[],
  devServer: Pick<DevServerDetection, 'preloadAttached' | 'relaunchHint'> | undefined,
  pageHooks: AgentHookConfig,
): readonly UnavailableSignal[] {
  const relaunchHint = provenRelaunchHint(devServer);

  if (relaunchHint === undefined) {
    return unavailable;
  }

  const replaces = (entry: UnavailableSignal): boolean =>
    entry.hint !== relaunchHint && isPreloadGap(entry.signal, pageHooks);

  if (!unavailable.some(replaces)) {
    return unavailable;
  }

  return Object.freeze(
    unavailable.map((entry) =>
      replaces(entry) ? Object.freeze({ ...entry, hint: relaunchHint }) : entry,
    ),
  );
}

/**
 * Projects an install error onto `instrumentation.failed`'s error shape — the
 * frame both user interfaces display, so its text must be the product's, never
 * the failure's own (CWE-209):
 *
 * - **message** — the fixed public copy of the `instrument` stage failing with
 *   the error's code (`publicFailureCopy`), then `(ref: ‹ref›)`. Never the
 *   error's message: `DebuggenError.from` keeps whatever an adapter or a
 *   dependency threw, and the installer quotes an adapter's failure text, so
 *   that message can name a path, a statement or a URL.
 * - **hint** — which protocol requires on this frame — the error's own hint
 *   only when it is proven product text (`isProductAuthoredText`): the exact
 *   dev-server relaunch command `../dev-server/detect.ts` composed (see
 *   {@link withServiceRelaunchHint}), the session to end when another session
 *   holds a target (see {@link withHeldTargetHint}), or any other recovery
 *   step a product builder registered. Otherwise the code's default next
 *   step: an installer error's hint can be an adapter's own text — its
 *   failure's hint, or the hint of the gap it reported — which may quote a
 *   path, a statement or a URL.
 *   A proven hint is registered again in its display form, so the failed row
 *   built from this frame proves it too.
 * - **ref** — the diagnostic reference, which the failure's local `warn` and
 *   `debug` records also carry, so a developer can match the frame to the log.
 *
 * Both texts are single-line and within protocol's bounds; the reference is
 * never the part a bound cuts.
 *
 * @param error The install error.
 * @param ref A fresh diagnostic reference (`newMessageId()`).
 * @returns The frame's error.
 */
function toFailedError(error: DebuggenError, ref: string): InstrumentationFailedPayload['error'] {
  const wire = error.toPayload();
  const copy = publicFailureCopy(INSTRUMENT_STAGE, wire.code);
  const suffix = ` (ref: ${ref})`;
  const summary = clip(copy.message, MAX_FAILURE_MESSAGE_LENGTH - suffix.length);
  const statedHint = isProductAuthoredText(wire.hint)
    ? clip(toDisplayLine(wire.hint), MAX_FAILURE_HINT_LENGTH)
    : '';

  return {
    code: wire.code,
    message: `${summary}${suffix}`,
    hint:
      statedHint.length === 0
        ? clip(copy.hint, MAX_FAILURE_HINT_LENGTH)
        : authorProductText(statedHint),
    ref,
  };
}

/**
 * The preload-dependent signals an installer failure names: its
 * `details.blockedSignal` and the `signal` of every entry of its
 * `details.unavailable` list (the installer's `{ signal, reason, hint }[]`), in
 * `PRELOAD_DEPENDENT_SIGNALS` order, each once.
 *
 * The details are read structurally, because an injected installer's error is
 * a caller's value: only a string signal of a record entry counts, and a
 * missing, malformed or foreign list contributes nothing. A preload signal the
 * page also collects (`fetch`) is not counted — a failed install armed no page
 * hook, so that gap may be the page's own ({@link isPreloadGap}).
 *
 * Pure.
 *
 * @param error The installer's error.
 * @returns The preload-dependent signals it reports, frozen.
 */
function preloadGapSignalsOf(error: DebuggenError): readonly CaptureSignal[] {
  const named = new Set<unknown>([error.details?.['blockedSignal']]);
  const listed: unknown = error.details?.['unavailable'];
  const entries: readonly unknown[] = Array.isArray(listed) ? listed : [];

  for (const entry of entries) {
    if (typeof entry === 'object' && entry !== null && 'signal' in entry) {
      named.add(entry.signal);
    }
  }

  return Object.freeze(PRELOAD_DEPENDENT_SIGNALS.filter((signal) => named.has(signal)));
}

/** An installer failure as {@link failInstall} reports it. */
interface ReportedInstallFailure {
  /** The error to report: the installer's own, or its re-issue with the relaunch hint. */
  readonly error: DebuggenError;
  /**
   * The instrument stage's ✗ rows owed ahead of the failed row: one entry per
   * preload gap, each with the detection's product-authored reason and its
   * relaunch hint. Empty when the relaunch hint does not apply.
   */
  readonly preloadGaps: readonly UnavailableSignal[];
}

/**
 * Re-issues an installer error with the relaunch hint this service's own
 * dev-server detection composed, and names the preload gaps to report as ✗
 * rows, whenever the preload is the recovery the developer needs (AAP §0.5.5:
 * "Could not enable ‹signal›: ‹reason›." — or, if nothing could be enabled,
 * `instrumentation.failed` whose hint, if the dev server was not started with
 * the preload, carries the exact relaunch command).
 *
 * The installer's "nothing could be enabled" failure (`INSTRUMENTATION_UNAVAILABLE`)
 * names one blocked signal in `details.blockedSignal` — the first reported gap
 * with a hint, which on a plain dev server with no tab bound is a page signal
 * — carries that gap's adapter hint, and lists every gap in
 * `details.unavailable`. So when the detection collected for this install found
 * the preload missing, its `relaunchHint` is proven product text (registered by
 * `../dev-server/detect.ts` when it composed it), and the blocked signal **or
 * any listed gap** depends on the preload ({@link preloadGapSignalsOf}):
 *
 * - the error is re-issued with that `relaunchHint` as its hint, whichever
 *   signal the installer named and whatever hint it carried — the exact command
 *   is the step AAP §0.5.5 requires; the code, message and details are kept,
 *   and the original error is the cause, so the local diagnostic still holds
 *   what the installer said;
 * - the preload gaps are returned as `buildPreloadUnavailableSignals` words
 *   them — product-authored reasons, the `relaunchHint` as every hint — for
 *   {@link failInstall} to report as "Could not enable Server spans: …" and
 *   the other preload rows before the failed row.
 *
 * In every other case — another code, no detection, an attached preload, a
 * hint this process did not compose, no preload gap — the error is returned
 * itself with no gap, and {@link toFailedError} decides its hint as before.
 *
 * @param error The installer's error.
 * @param devServer The dev-server detection readiness collected, if it ran.
 * @returns The error to report and the preload gaps to show ahead of it.
 */
function withServiceRelaunchHint(
  error: DebuggenError,
  devServer: ReadinessEvidence['devServer'],
): ReportedInstallFailure {
  const relaunchHint = provenRelaunchHint(devServer);

  if (
    error.code !== 'INSTRUMENTATION_UNAVAILABLE' ||
    devServer === undefined ||
    relaunchHint === undefined
  ) {
    return { error, preloadGaps: [] };
  }

  const signals = preloadGapSignalsOf(error);

  if (signals.length === 0) {
    return { error, preloadGaps: [] };
  }

  return {
    error:
      error.hint === relaunchHint
        ? error
        : new DebuggenError(error.code, error.message, {
            hint: relaunchHint,
            ...(error.details === undefined ? {} : { details: error.details }),
            cause: error,
          }),
    preloadGaps: buildPreloadUnavailableSignals(devServer, signals),
  };
}

/** The shape of a holding session id {@link withHeldTargetHint} will quote. */
const HELD_TARGET_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

/** The longest held file path {@link withHeldTargetHint} will quote. */
const HELD_TARGET_FILE_MAX_LENGTH = 512;

/** A control character or a line or paragraph separator: never in a quoted fact. */
const HELD_TARGET_LINE_BREAKER_PATTERN = /[\p{Cc}\u2028\u2029]/u;

/**
 * How many links of an error's `cause` chain {@link withHeldTargetHint}
 * inspects: the installer wraps an adapter's refusal once, and a service
 * re-issue wraps it once more, so a real chain is a few links long and a
 * cyclic or adversarial one is cut off here.
 */
const HELD_TARGET_CAUSE_DEPTH = 8;

/** The two facts the held-target hint is worded from, both validated. */
interface HeldTargetFacts {
  /** The held file, project-relative POSIX. */
  readonly file: string;

  /** The session whose instrumented bytes the file holds. */
  readonly owningSessionId: string;
}

/**
 * Reads the held-target facts off a structured value — an element of the
 * installer's `details.heldTargets`, or a held refusal's `details` — or
 * answers `undefined` when either fact is not safe to quote.
 *
 * `owningSessionId` must match {@link HELD_TARGET_SESSION_ID_PATTERN}, the
 * shape of an id this service mints. `file` must be a project-relative path
 * `isSafeRelativePath` accepts — no absolute path, no drive letter, no
 * backslash, no escape above the root — on a single line and at most
 * {@link HELD_TARGET_FILE_MAX_LENGTH} characters. Anything else is refused as
 * a whole, because the hint is shown to the developer verbatim.
 *
 * @param value Any value.
 * @returns The validated facts, or `undefined`.
 */
function heldTargetFactsOf(value: unknown): HeldTargetFacts | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const { file, owningSessionId } = value as { file?: unknown; owningSessionId?: unknown };

  if (
    typeof owningSessionId !== 'string' ||
    !HELD_TARGET_SESSION_ID_PATTERN.test(owningSessionId)
  ) {
    return undefined;
  }

  if (
    typeof file !== 'string' ||
    file.length > HELD_TARGET_FILE_MAX_LENGTH ||
    HELD_TARGET_LINE_BREAKER_PATTERN.test(file) ||
    !isSafeRelativePath(file)
  ) {
    return undefined;
  }

  return { file, owningSessionId };
}

/**
 * The target another session holds that an install error is about, or
 * `undefined` when it is about something else.
 *
 * Two structured sources, in order, and never an error's message or hint:
 *
 * 1. The installer's nothing-enabled failure lists the holders of the targets
 *    it set aside in `details.heldTargets`; its first entry is the one read.
 * 2. Otherwise the error and its `cause` chain — at most
 *    {@link HELD_TARGET_CAUSE_DEPTH} links, each a `DebuggenError` — are
 *    searched for the patch layer's own refusal: `PATCH_UNSUPPORTED` whose
 *    `details.reason` is `PATCH_TARGET_HELD_REASON`. That is how a held target
 *    the installer had to treat as fatal (one met after the same adapter call
 *    applied a record) still names its holder.
 *
 * @param error The install error.
 * @returns The validated facts, or `undefined`.
 */
function findHeldTarget(error: DebuggenError): HeldTargetFacts | undefined {
  const listed = error.details?.['heldTargets'];

  if (Array.isArray(listed)) {
    const first = heldTargetFactsOf(listed[0]);

    if (first !== undefined) {
      return first;
    }
  }

  let link: unknown = error;

  for (let depth = 0; depth < HELD_TARGET_CAUSE_DEPTH && DebuggenError.is(link); depth += 1) {
    if (
      link.code === 'PATCH_UNSUPPORTED' &&
      link.details?.['reason'] === PATCH_TARGET_HELD_REASON
    ) {
      const facts = heldTargetFactsOf(link.details);

      if (facts !== undefined) {
        return facts;
      }
    }

    link = link.cause;
  }

  return undefined;
}

/**
 * Re-issues an installer error with a hint this service words itself when the
 * install failed because a target is held by another session on the same
 * project, so the developer is told how to release it (AAP §0.5.5: if nothing
 * could be enabled, `instrumentation.failed` carries the hint).
 *
 * The installer's own hint for that case is the patch layer's sentence, which
 * {@link toFailedError} must not show — it is not proven product text, and a
 * gap's text may quote whatever an adapter wrote — so without this the
 * developer would read the code's generic next step while the real cause sat
 * in the debug log. The hint is instead composed here from two validated
 * identifiers (see {@link findHeldTarget}) and registered with
 * `authorProductText` at the point of composition, which is what lets
 * `instrumentation.failed` and the instrument stage's failed row show it.
 *
 * Which recovery it names depends on whether the holder is still a live
 * session of this service — one it installed and has not stopped, or one
 * whose install is running (`isLive`):
 *
 * - **Live** — ending it runs its cleanup, which restores the file:
 *
 *   > ‹file› is already instrumented by session ‹id›. End that session — its
 *   > cleanup restores the file — then ask again.
 *
 * - **Not live** — the holder already ended (its cleanup ran and left this
 *   record claiming the bytes; ending it again answers from its stored
 *   verdict), or it belongs to a process that is gone. Ending it cannot
 *   release the file, so the step is the one that can: a restart, whose
 *   start-up reconciliation judges every open record whatever its session's
 *   state (AAP §0.5.1):
 *
 *   > ‹file› is still instrumented by session ‹id›, which is no longer
 *   > running. Restart the Debug Generator service — its start-up
 *   > reconciliation restores or closes the file's records — then ask again.
 *
 * The code, message and details are kept, and the original error is the
 * cause, so the local diagnostic still holds what the installer said. The
 * public message is unaffected: {@link toFailedError} replaces it with the
 * code's fixed copy and a diagnostic reference whatever the hint (CWE-209).
 *
 * Returns `error` itself when its hint is already proven product text — the
 * relaunch hint of {@link withServiceRelaunchHint}, which runs first — and
 * when no held target with safely quotable facts is found.
 *
 * @param error The installer's error, after {@link withServiceRelaunchHint}.
 * @param isLive Whether this service still runs the session with that id.
 * @returns The error to report.
 *
 * @example
 * ```ts
 * const reported = withHeldTargetHint(
 *   withServiceRelaunchHint(installed.error, devServer).error,
 *   (id) => sessions.has(id) || inFlight.has(id),
 * );
 * // reported.hint === 'src/server/report.ts is already instrumented by session ses_abc. End that session — its cleanup restores the file — then ask again.'
 * ```
 */
function withHeldTargetHint(
  error: DebuggenError,
  isLive: (sessionId: string) => boolean,
): DebuggenError {
  if (isProductAuthoredText(error.hint)) {
    return error;
  }

  const held = findHeldTarget(error);

  if (held === undefined) {
    return error;
  }

  return new DebuggenError(error.code, error.message, {
    hint: authorProductText(
      isLive(held.owningSessionId)
        ? `${held.file} is already instrumented by session ${held.owningSessionId}. End that session — its cleanup restores the file — then ask again.`
        : `${held.file} is still instrumented by session ${held.owningSessionId}, which is no longer running. Restart the Debug Generator service — its start-up reconciliation restores or closes the file's records — then ask again.`,
    ),
    ...(error.details === undefined ? {} : { details: error.details }),
    cause: error,
  });
}

/**
 * The installer's `sessionOnAnotherProject` predicate for one install: `true`
 * only for a session this service installed on a project other than
 * `projectRoot`.
 *
 * `ModificationJournal.listOpen` answers every open record of every session on
 * every project, and a record names only a project-relative file. The patch
 * layer's hold check (`PATCH_TARGET_HELD_REASON`) matches another session's
 * record by that file **and** by the digest of the bytes the file holds, which
 * decides *whether* the file is held exactly. It cannot decide *by whom* when
 * two copies of one project — two worktrees of a repository — were patched the
 * same way: both copies then hold the same bytes under the same relative path,
 * so the session it names could be the other copy's, and the developer would
 * be told to end a session whose cleanup releases nothing here. With this
 * predicate the installer lists the adapters no record of such a session.
 *
 * A session this service does not know answers `false`, so its records stay
 * listed: leaving them out could let a second patch be layered over a file it
 * holds, which is the corruption the hold check exists to prevent. In a
 * running service every record that can hold a file (`applied`, `pending`,
 * `failed`) belongs to a session installed by this process, because start-up
 * reconciliation settles every record an earlier process left before a
 * client is accepted.
 *
 * Only the install is given the predicate: start-up reconciliation and session
 * cleanup keep the global listing their reconciliation requires, and the
 * context's journal is handed to the installer unchanged.
 *
 * @param projectRoot The project being instrumented, as the install's request names it.
 * @param projectOf The project a session was installed on, when this service knows it.
 * @returns The predicate.
 *
 * @example
 * ```ts
 * const elsewhere = sessionOnAnotherProjectThan(projectRoot, (id) => sessions.get(id)?.projectRoot);
 * await installer(plan, context, { adapters, sessionOnAnotherProject: elsewhere });
 * ```
 */
export function sessionOnAnotherProjectThan(
  projectRoot: string,
  projectOf: (sessionId: string) => string | undefined,
): (sessionId: string) => boolean {
  return (sessionId) => {
    const owner = projectOf(sessionId);

    return owner !== undefined && owner !== projectRoot;
  };
}

/**
 * The log fields of a caught value: its label in the closed exception
 * taxonomy, its closed-vocabulary code when it carries one, and the value
 * itself under {@link LOG_ERROR_FIELD_KEY}, where the service logger's error
 * serializer — not this module — decides what of it a record may hold.
 *
 * Never the value's own `name`, `message` or `String(…)`: an exception this
 * service did not author can carry a path, a statement or a credential in
 * any of them (CWE-532), and `describeException` maps rather than copies.
 */
function exceptionFields(thrown: unknown): LogFields {
  return { ...describeException(thrown), [LOG_ERROR_FIELD_KEY]: thrown };
}

// ---------------------------------------------------------------------------
// Section E — per-service state
// ---------------------------------------------------------------------------

/** What a capture of one plan version arms in the two producers. */
interface ProducerConfig {
  readonly agentHooks: AgentHookConfig;
  readonly serverSignals: ServerAgentSignals;
}

/**
 * The three `instrumentation.ready` fields of the latest install, as that
 * install sent them: `applied` holds only the records it wrote, never the
 * session's whole journal.
 */
interface ReadyFields {
  readonly applied: readonly ModificationRecord[];
  readonly runtimeHooks: readonly string[];
  readonly unavailable: readonly UnavailableSignal[];
}

/** The two report fields a refresh can change: the armed hooks and the gaps. */
interface ReportParts {
  readonly runtimeHooks: readonly string[];
  readonly unavailable: readonly UnavailableSignal[];
}

/**
 * One refreshable adapter's share of a session's signal report: what it armed
 * and could not arm the last time it was asked, and what it contributed to the
 * producers' configurations when it armed anything.
 *
 * An adapter is refreshable when it is registered and every action the active
 * plan gives it installs in `runtime` mode: asking it again writes no file, so
 * its answer can be brought up to date with the page. An adapter with any
 * `patch` action is never asked again — its share of the report stays as the
 * installer returned it.
 */
interface RuntimeShare {
  readonly adapterId: string;
  readonly runtimeHooks: readonly string[];
  readonly unavailable: readonly UnavailableSignal[];
  /** The page-agent hooks it contributed; empty when it armed nothing. */
  readonly agentHooks: Partial<AgentHookConfig>;
  /** The preload signals it contributed; fully disabled when it armed nothing. */
  readonly serverSignals: ServerAgentSignals;
}

/**
 * What a session's signal report is composed from and re-judged with. Replaced,
 * never mutated; a refresh that finds the session's report replaced while it
 * worked drops its result, since a newer install or replay has superseded it.
 */
interface SignalReport {
  /** The plan version the report describes, with its normalised plan. */
  readonly plan: InstrumentationPlan;
  /** The install's context, without its request's abort signal. */
  readonly context: InstrumentationContext;
  /** The install request's dev-server URL, for collecting the facts again. */
  readonly devServerUrl?: string | undefined;
  /** Whether the install skipped the feasibility gate, which a refresh then skips too. */
  readonly skipFeasibility: boolean;
  /** Whether a missing preload blocks readiness for this session. */
  readonly requireServerAgent: boolean;
  /** The observed facts the shares were last judged against. */
  readonly judged: ObservedReadinessInputs;
  /** The part of the report no refresh changes: every source but the shares. */
  readonly fixed: ReportParts;
  /** Each refreshable adapter's share, in registry order. */
  readonly shares: readonly RuntimeShare[];
  /**
   * The signals the latest verdict held back only on the page gate: no tab
   * bound yet, or the bound tab's page not (or not in time) reported.
   */
  readonly awaitingPage: readonly CaptureSignal[];
  /** Every signal a ✓ row has been shown for, for this plan version. */
  readonly confirmed: readonly CaptureSignal[];
  /**
   * The checklist rows shown as waiting for this plan version and not yet
   * settled, with the detail each was last shown with: a ✓ row, or a ✗ row
   * when the page answered with a gap, replaces each in place.
   */
  readonly waiting: readonly WaitingRow[];
}

/**
 * A checklist row shown as waiting — `running`, "◌ ‹label›" — for a signal
 * the page gate holds back (AAP §0.7.3: check/spinner/cross rows).
 *
 * Its message is the signal's checklist label, exactly the message the
 * signal's ✓ row carries, so when the page reports and the signal is
 * confirmed the ✓ row replaces the waiting row in place in both user
 * interfaces — which identify a row by its stage and message — and the
 * checklist keeps its order above "Ready to capture", whichever of the two
 * arrives first. Its detail says what the signal is waiting for and what the
 * developer can do, in the readiness gate's own words.
 */
interface WaitingRow {
  readonly label: string;
  readonly detail: string;
}

/**
 * What this service holds for one session. Replaced, never mutated, so a
 * reader holding the previous value is never surprised by a change under it.
 */
interface SessionState {
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly activePlanVersion: number;
  /** The active plan version's actions — the default delta baseline of a follow-up. */
  readonly actions: readonly InstrumentationAction[];
  /** The producer configuration per plan version, as installed (or recomputed). */
  readonly configs: ReadonlyMap<number, ProducerConfig>;
  /**
   * The latest install's `instrumentation.ready` fields. Its `unavailable` is
   * the baseline a later capture's and an empty delta's gap reports build on;
   * its `applied` is that install's records only — the journal, not this
   * state, is the authority on every record the session holds.
   */
  readonly ready: ReadyFields;
  /** Every runtime hook armed across the session's installed plan versions. */
  readonly runtimeHooks: readonly string[];
  /** The capture currently armed, when one is. */
  readonly armedCaptureId?: string | undefined;
  /**
   * The signal report of the active plan version, when this process installed
   * it — never for arming state restored from a stored plan, which no install
   * of this process judged.
   */
  readonly signals?: SignalReport | undefined;
}

/**
 * What this process knows about the two producers of one session, from the
 * delivery receipts of the configurations it sent. Kept apart from
 * {@link SessionState} because it describes live processes outside this one —
 * a page agent and a preload stay armed whether or not this service still holds
 * the session's plan — so it outlives `stopSession`. Replaced, never mutated.
 */
interface ProducerLedger {
  /** The session's normalised project root. */
  readonly projectRoot: string;
  /**
   * The capture whose armed `agent.config` the bound tab's connection took, not
   * since followed by a delivered dormant one.
   */
  readonly pageArmedCaptureId?: string | undefined;
  /**
   * The capture whose armed `server-agent.config` a preload connection took,
   * not since followed by a delivered capture-less one or superseded by another
   * session's capture.
   */
  readonly serverArmedCaptureId?: string | undefined;
  /**
   * The capture whose armed `server-agent.config` no preload has taken yet;
   * replayed when the project's preload connects.
   */
  readonly serverAwaitingCaptureId?: string | undefined;
  /** The capture whose unreachable-preload degradation rows were emitted, so they are emitted once. */
  readonly degradedCaptureId?: string | undefined;
  /** The capture whose dormant `agent.config` this process delivered last. */
  readonly dormantCaptureId?: string | undefined;
}

/**
 * The disarms of one session that no producer connection has taken yet. Kept
 * apart from {@link SessionState} so it survives `stopSession` — cleanup
 * releases the session right after disarming it — and cleared only by a
 * delivery, a supersession or `dispose`.
 */
interface PendingDisarm {
  /** The session's normalised project root, which the preload replay is keyed by. */
  readonly projectRoot: string;
  /** The capture the outstanding dormant `agent.config` names, when the page is owed one. */
  readonly pageCaptureId?: string | undefined;
  /** Whether the preload is owed its capture-less configuration. */
  readonly server: boolean;
}

/** How one producer configuration fared, with the channel's code when it was refused. */
interface DeliveryAttempt {
  readonly delivered: boolean;
  /** The refusing channel's error code, or the thrown error's; set only when not delivered. */
  readonly code?: string | undefined;
}

/**
 * A collaborator that failed while this module was using it: the
 * collaborator and step this module names, and the failure's closed
 * {@link ExceptionDescription} — never text read off the thrown value, since
 * the list travels in the details of the error an install returns.
 */
interface CollaboratorFailure extends ExceptionDescription {
  readonly collaborator: string;
  readonly step: string;
}

/** What a follow-up's delta resolved to. */
interface ResolvedDelta {
  readonly delta: InstallDelta;
  /** The previous plan version's actions the delta was computed against. */
  readonly previousActions: readonly InstrumentationAction[];
}

/** What the preparation half of an install produced. */
type PreparedInstall =
  | {
      readonly kind: 'installed';
      readonly context: InstrumentationContext;
      readonly evidence: ReadinessEvidence;
      readonly resolved: ResolvedDelta | undefined;
      readonly result: AggregateInstallResult;
    }
  | {
      readonly kind: 'unchanged';
      readonly context: InstrumentationContext;
      readonly evidence: ReadinessEvidence;
      readonly resolved: ResolvedDelta;
    };

/** The validated shape of an install request. */
interface CheckedInstall {
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly plan: InstrumentationPlan;
}

const EMPTY_READY: ReadyFields = Object.freeze({
  applied: Object.freeze([]),
  runtimeHooks: Object.freeze([]),
  unavailable: Object.freeze([]),
});

/** The `warn` line a rejecting page-agent wait of the background refresh is logged with. */
const SIGNAL_WAIT_FAILURE_MESSAGE =
  'Waiting for the bound page to report for the signal report failed';

/**
 * One adapter's share of the signal report, read defensively off its raw
 * install results — the adapter's own answers, as the installer kept them.
 *
 * `undefined` when any answer is not an ordinary runtime result: not an object,
 * a fatal `failure`, a record applied, or a list missing. Such an adapter is
 * not treated as a share at all, so its contribution stays in the report's
 * fixed part exactly as the installer aggregated it.
 *
 * Hooks are de-duplicated with the first occurrence kept; a contribution to
 * the producers' configurations is kept only from an answer that armed a
 * hook, as the installer aggregates contributions only from enabled results.
 */
function readShare(adapterId: string, answers: readonly unknown[]): RuntimeShare | undefined {
  const runtimeHooks: string[] = [];
  const unavailable: UnavailableSignal[] = [];
  let agentHooks: Partial<AgentHookConfig> = {};
  let serverSignals: ServerAgentSignals = serverContributionOf(undefined);

  for (const answer of answers) {
    if (!isObjectRecord(answer) || answer['failure'] !== undefined) {
      return undefined;
    }

    const applied = answer['applied'];
    const hooks = answer['runtimeHooks'];
    const gaps = answer['unavailable'];

    if (
      !Array.isArray(applied) ||
      applied.length > 0 ||
      !Array.isArray(hooks) ||
      !Array.isArray(gaps)
    ) {
      return undefined;
    }

    const armed = hooks.filter(isNonBlankString);
    runtimeHooks.push(...armed);
    unavailable.push(...gaps.filter(isGapLike));

    if (armed.length > 0) {
      agentHooks = { ...agentHooks, ...hookContributionOf(answer['agentHooks']) };
      serverSignals = unionServerSignals(
        serverSignals,
        serverContributionOf(answer['serverSignals']),
      );
    }
  }

  return {
    adapterId,
    runtimeHooks: unionStrings([], runtimeHooks),
    unavailable,
    agentHooks,
    serverSignals,
  };
}

/**
 * The part of a report no refresh changes: `report` without what the shares
 * put there. A gap is taken out once per share that reported it (a multiset
 * difference, by value); a hook only when a share armed it and no other
 * source did (`kept`), since a hook list holds each label once.
 */
function fixedPartOf(
  report: ReportParts,
  shares: readonly RuntimeShare[],
  kept: ReadonlySet<string>,
): ReportParts {
  const shareHooks = new Set<string>(shares.flatMap((share) => share.runtimeHooks));

  return {
    runtimeHooks: report.runtimeHooks.filter((hook) => kept.has(hook) || !shareHooks.has(hook)),
    unavailable: withoutGaps(
      report.unavailable,
      shares.flatMap((share) => share.unavailable),
    ),
  };
}

/**
 * A report composed from its fixed part and its shares: the fixed hooks, then
 * each share's, de-duplicated with the first occurrence kept; the fixed gaps,
 * then each share's, in registry order.
 */
function composeParts(fixed: ReportParts, shares: readonly RuntimeShare[]): ReportParts {
  return {
    runtimeHooks: unionStrings(
      fixed.runtimeHooks,
      shares.flatMap((share) => share.runtimeHooks),
    ),
    unavailable: [...fixed.unavailable, ...shares.flatMap((share) => share.unavailable)],
  };
}

/** Whether two share lists say the same thing: the same adapters, hooks and gaps, in order. */
function sameShares(first: readonly RuntimeShare[], second: readonly RuntimeShare[]): boolean {
  return (
    first.length === second.length &&
    first.every((share, index) => {
      const other = second[index];

      return (
        other !== undefined &&
        other.adapterId === share.adapterId &&
        sameStrings(share.runtimeHooks, other.runtimeHooks) &&
        sameGaps(share.unavailable, other.unavailable)
      );
    })
  );
}

/** A plan's runtime actions that one adapter installs. */
function runtimeActionsOf(
  actions: readonly InstrumentationAction[],
  adapterId: string,
): readonly InstrumentationAction[] {
  return actions.filter(
    (action) => action.mode === RUNTIME_ACTION_MODE && action.adapter === adapterId,
  );
}

/**
 * Widens a plan version's producer configuration with every share that arms
 * something, as the installer widens its derivation with each enabled
 * adapter's contribution: the page hooks the share's actions derive plus its
 * own page contribution, and its own preload contribution. The preload side is
 * never derived from the actions here — which tier an action's signal is
 * delivered on is the installer's judgement — so it widens only with what the
 * adapter itself said it arms there.
 */
function widenConfig(
  config: ProducerConfig,
  actions: readonly InstrumentationAction[],
  shares: readonly RuntimeShare[],
): ProducerConfig {
  let agentHooks = config.agentHooks;
  let serverSignals = config.serverSignals;

  for (const share of shares) {
    if (share.runtimeHooks.length === 0) {
      continue;
    }

    agentHooks = widenAgentHooks(
      agentHooks,
      runtimeActionsOf(actions, share.adapterId),
      share.agentHooks,
    );
    serverSignals = unionServerSignals(serverSignals, share.serverSignals);
  }

  return { agentHooks, serverSignals };
}

/** What folding refreshed shares into a report produced. */
interface FoldedShares {
  readonly report: SignalReport;
  readonly ready: ReadyFields;
  readonly config: ProducerConfig;
  readonly runtimeHooks: readonly string[];
  /** Whether the composed `instrumentation.ready` fields differ from the ones given. */
  readonly changed: boolean;
}

/**
 * Folds refreshed shares into a report, and the report into the session's
 * announced fields and producer configuration. Pure.
 *
 * Unchanged shares leave everything as it was — the fields keep the installer's
 * own ordering — apart from recording the facts they were judged against.
 * Changed shares recompose the report from its fixed part, widen the
 * configuration with what they now arm, and add their hooks to the session's
 * hook union.
 */
function foldShares(input: {
  readonly report: SignalReport;
  readonly shares: readonly RuntimeShare[];
  readonly judged: ObservedReadinessInputs;
  readonly ready: ReadyFields;
  readonly config: ProducerConfig;
  readonly runtimeHooks: readonly string[];
}): FoldedShares {
  const report: SignalReport = { ...input.report, shares: input.shares, judged: input.judged };

  if (sameShares(input.report.shares, input.shares)) {
    return {
      report,
      ready: input.ready,
      config: input.config,
      runtimeHooks: input.runtimeHooks,
      changed: false,
    };
  }

  const parts = composeParts(report.fixed, input.shares);
  const changed =
    !sameStrings(parts.runtimeHooks, input.ready.runtimeHooks) ||
    !sameGaps(parts.unavailable, input.ready.unavailable);

  return {
    report,
    ready: changed ? { applied: input.ready.applied, ...parts } : input.ready,
    config: widenConfig(input.config, report.plan.instrumentationTargets, input.shares),
    runtimeHooks: unionStrings(input.runtimeHooks, parts.runtimeHooks),
    changed,
  };
}

/**
 * The gaps the progress rows are drawn from: `unavailable` without the gaps a
 * share reported for a signal the verdict holds back only on the page gate.
 * Such a signal is waiting, not failed — its {@link WaitingRow} says what for —
 * and its gap still reaches `instrumentation.ready`. Returns `unavailable`
 * itself when nothing waits.
 */
function rowGapsOf(
  unavailable: readonly UnavailableSignal[],
  shares: readonly RuntimeShare[],
  awaitingPage: ReadonlySet<string>,
): readonly UnavailableSignal[] {
  if (awaitingPage.size === 0) {
    return unavailable;
  }

  return withoutGaps(
    unavailable,
    shares.flatMap((share) => share.unavailable).filter((gap) => awaitingPage.has(gap.signal)),
  );
}

/** Matches the closing punctuation and whitespace a reason fragment may end with. */
const CLOSING_PUNCTUATION_PATTERN = /[\s.!?;:,]+$/u;

/**
 * What a waiting row's detail says: "Waiting: ‹reason›. ‹hint›", from the
 * gate's gap for the signal — for a missing binding, that no tab is bound and
 * how to open the panel; for a page that has not reported, that no page agent
 * has and the reload request. Single-line and clipped to the progress schema's
 * detail bound.
 */
function waitingDetail(gap: UnavailableSignal | undefined): string {
  const reason = toDisplayLine(gap?.reason ?? '').replace(CLOSING_PUNCTUATION_PATTERN, '');
  const hint = toDisplayLine(gap?.hint ?? '');
  const sentence = reason.length === 0 ? 'Waiting for the page' : `Waiting: ${reason}`;

  return clip(
    hint.length === 0 ? `${sentence}.` : `${sentence}. ${hint}`,
    MAX_PROGRESS_DETAIL_LENGTH,
  );
}

/**
 * The detail of a waiting row the page answered with a gap: each distinct gap
 * of the label's signals as "‹reason›. ‹hint›", in order, single-line and
 * clipped to the progress schema's detail bound; "Not enabled." when no gap
 * names why.
 */
function settledDetail(gaps: readonly (UnavailableSignal | undefined)[]): string {
  const sentences: string[] = [];

  for (const gap of gaps) {
    if (gap === undefined) {
      continue;
    }

    // A reason is a fragment written to follow "Could not enable ‹signal›: ";
    // standing alone, it opens its sentence.
    const fragment = toDisplayLine(gap.reason).replace(CLOSING_PUNCTUATION_PATTERN, '');
    const reason = `${fragment.charAt(0).toUpperCase()}${fragment.slice(1)}`;
    const hint = toDisplayLine(gap.hint ?? '');
    const sentence = [reason.length === 0 ? '' : `${reason}.`, hint]
      .filter((part) => part.length > 0)
      .join(' ');

    if (sentence.length > 0 && !sentences.includes(sentence)) {
      sentences.push(sentence);
    }
  }

  const detail = sentences.join(' ');

  return clip(detail.length === 0 ? 'Not enabled.' : detail, MAX_PROGRESS_DETAIL_LENGTH);
}

/**
 * The waiting rows a verdict calls for: one per checklist label of a signal in
 * `awaitingPage` that no ✓ row has been shown for (`shown`), ordered as the
 * checklist orders its ✓ rows, each with the {@link waitingDetail} of the
 * label's first such signal's blocking gap. Pure.
 */
function waitingRowsOf(
  verdict: Pick<ReadinessVerdict, 'plannedSignals' | 'blocking'>,
  awaitingPage: ReadonlySet<CaptureSignal>,
  shown: ReadonlySet<string>,
): readonly WaitingRow[] {
  const details = new Map<string, string>();

  for (const signal of verdict.plannedSignals) {
    const label = CAPTURE_SIGNAL_LABELS[signal];

    if (awaitingPage.has(signal) && !shown.has(label) && !details.has(label)) {
      details.set(label, waitingDetail(gapFor(signal, [verdict.blocking])));
    }
  }

  return INSTRUMENTATION_ROW_ORDER.flatMap((label) => {
    const detail = details.get(label);

    return detail === undefined ? [] : [{ label, detail }];
  });
}

/** Whether a report holds a gap that a newer reading of the page could clear. */
function hasRefreshableGap(report: SignalReport): boolean {
  return (
    report.awaitingPage.length > 0 || report.shares.some((share) => share.unavailable.length > 0)
  );
}

/** Whether a value is a tab binding: a non-negative integer tab id and a non-blank URL. */
function isBoundTab(value: unknown): value is BoundTab {
  if (!isObjectRecord(value)) {
    return false;
  }

  const tabId = value['tabId'];

  return (
    typeof tabId === 'number' &&
    Number.isSafeInteger(tabId) &&
    tabId >= 0 &&
    isNonBlankString(value['url'])
  );
}

/** Whether a value is a non-empty list of known client kinds. */
function isClientKindList(value: unknown): value is readonly ClientKind[] {
  const known: readonly string[] = CLIENT_KINDS;

  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((kind) => typeof kind === 'string' && known.includes(kind))
  );
}

// ---------------------------------------------------------------------------
// Section F — the service
// ---------------------------------------------------------------------------

/**
 * Creates the instrumentation driver of one service process.
 *
 * Constructs the default adapter registry once (when none is injected) and
 * nothing else: no timer, no watcher, no I/O until a method is called. All state
 * — per-session arming, the producer ledger, the pending disarms and their
 * listeners, the watched-session set, the in-flight set and the reload-prompt
 * ledger — lives in this closure.
 *
 * @param deps The injected collaborators.
 * @returns The driver: the service surface and its producer reconciler.
 *
 * @example
 * ```ts
 * const instrumentation = createInstrumentationService({
 *   config, logger, modifications, progress, broadcaster: clients,
 *   agentChannel: clients, serverAgentChannel: clients, watcher, agents,
 *   serverAgents, captures: manager,
 * });
 *
 * const installed = await instrumentation.install({ sessionId, projectRoot, plan, code, boundTab });
 * if (installed.ok && installed.value.readiness.satisfied) {
 *   await manager.transitionTo(sessionId, 'ready', { readinessSatisfied: true });
 * }
 *
 * // When a producer registers, replay what it is owed.
 * instrumentation.producerConnected({ kind: 'server-agent', projectRoot });
 * ```
 */
export function createInstrumentationService(
  deps: InstrumentationServiceDeps,
): InstrumentationDriver {
  const clock = deps.now ?? nowEpochMs;
  const serviceLog = deps.logger.child({ [LOG_BINDING_KEYS.subsystem]: LOG_SUBSYSTEM });
  const adapters = deps.adapters ?? createAdapterRegistry({ logger: serviceLog });
  const installer = deps.installer ?? installPlan;

  const sessions = new Map<string, SessionState>();
  const watched = new Set<string>();
  const inFlight = new Set<string>();
  const reloadPrompts = new Set<string>();
  /** Per session: what the producers were delivered; outlives `stopSession`. */
  const ledgers = new Map<string, ProducerLedger>();
  /** Per session: the disarms no producer connection has taken yet; outlives `stopSession`. */
  const pending = new Map<string, PendingDisarm>();
  const dormancyListeners = new Set<(sessionId: string) => void>();
  /**
   * Per session: the `instrumentation.failed` payload of the latest install,
   * when that install failed — what a binding panel is replayed after the
   * latest report. Cleared by a later successful install.
   */
  const failedReports = new Map<string, InstrumentationFailedPayload>();
  /** Per session: the tab its latest install or bind named, which a refresh waits on. */
  const knownTabs = new Map<string, BoundTab>();
  /**
   * The sessions a bind named a tab for while their install ran. That install
   * judged the page without the tab, so the report it leaves is re-judged
   * against the tab the moment the install is over (see `install`).
   */
  const boundDuringInstall = new Set<string>();
  /** Per session: the one background refresh of its signal report, cancelled by its controller. */
  const signalWaiters = new Map<string, AbortController>();
  let disposed = false;

  /**
   * When this service came into being. A producer credential issued, or a
   * capture opened, before it belongs to an earlier process, whose arming this
   * one never saw; anything issued or opened since is answered by this
   * service's own ledger and pending disarms.
   */
  const createdAt = clock();

  /**
   * When each project's preloads were last sent an armed configuration that a
   * connection took, by project root. A project may have several preloads, and
   * a delivery receipt counts the fan-out as a whole: one that was offline when
   * a later capture-less configuration reached the others may still hold that
   * arming. So a preload whose credential existed by then is disabled when it
   * connects, whatever the pending disarms say. Kept until `dispose`; one entry
   * per project ever armed.
   */
  const serverArmedAt = new Map<string, number>();

  /**
   * The canonical state root, or the one canonicalisation of
   * `config.debuggenHome` in flight or resolved; see
   * {@link InstrumentationServiceDeps.canonicalStateHome}. Reset when that
   * canonicalisation fails, so a later install tries again.
   */
  let stateHome: Promise<Result<string, DebuggenError>> | undefined =
    deps.canonicalStateHome === undefined
      ? undefined
      : Promise.resolve(ok(deps.canonicalStateHome));

  /** Resolves the canonical state root, canonicalising the configured one at most once. */
  function canonicalStateHome(): Promise<Result<string, DebuggenError>> {
    if (stateHome === undefined) {
      const resolving = canonicalizePath(deps.config.debuggenHome).then((resolved) => {
        if (isErr(resolved) && stateHome === resolving) {
          stateHome = undefined;
        }
        return resolved;
      });
      stateHome = resolving;
    }
    return stateHome;
  }

  /**
   * Refuses to install into a project root that is, contains or lies inside
   * the state root (CWE-200), re-checked on every install at the sink itself:
   * the session and dev-server routes check before a session exists, but the
   * pipeline installs later and asynchronously, and a folder can be replaced
   * by a link into the state root in between. Runs before anything is read for
   * the install, so a refused install writes no backup, no journal record and
   * no patch.
   *
   * The refusal is `requireProjectOutsideStateHome`'s own `FS_UNSAFE_PATH`
   * error — or `canonicalizePath`'s, when the configured state root cannot be
   * resolved — whose message and hint are constant sentences of `../config.ts`
   * that name no path. Its hint is registered as product text, so the
   * `instrumentation.failed` frame shows the recovery step itself.
   */
  async function requireStateHomeApart(projectRoot: string): Promise<Result<void, DebuggenError>> {
    const home = await canonicalStateHome();
    let refusal: DebuggenError;

    if (isErr(home)) {
      refusal = home.error;
    } else {
      const posixHome = toPosix(home.value);

      if (!isAbsolutePosix(posixHome) && !isWindowsAbsolute(posixHome)) {
        return err(
          wiringError(
            'The instrumentation service was given a state root that is not an absolute path.',
            'Pass the canonical absolute state root the service resolved at start-up.',
            'canonicalStateHome',
          ),
        );
      }

      const apart = await requireProjectOutsideStateHome(home.value, projectRoot);

      if (!isErr(apart)) {
        return ok(undefined);
      }

      refusal = apart.error;
    }

    if (refusal.hint !== undefined) {
      authorProductText(refusal.hint);
    }

    return err(refusal);
  }

  /** The logger of one session's work: `subsystem` and `sessionId` bound in one call. */
  function sessionLog(sessionId: string): Logger {
    return deps.logger.child({
      [LOG_BINDING_KEYS.subsystem]: LOG_SUBSYSTEM,
      [LOG_BINDING_KEYS.sessionId]: sessionId,
    });
  }

  /** Runs a synchronous collaborator call; a throw is logged and recorded, never propagated. */
  function attempt<T>(
    failures: CollaboratorFailure[],
    log: Logger,
    collaborator: string,
    step: string,
    call: () => T,
  ): T | undefined {
    try {
      return call();
    } catch (thrown) {
      failures.push({ collaborator, step, ...describeException(thrown) });
      log.error('An instrumentation collaborator threw', {
        collaborator,
        step,
        ...exceptionFields(thrown),
      });
      return undefined;
    }
  }

  /** {@link attempt} for a collaborator call that returns a promise. */
  async function attemptAsync<T>(
    failures: CollaboratorFailure[],
    log: Logger,
    collaborator: string,
    step: string,
    call: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await call();
    } catch (thrown) {
      failures.push({ collaborator, step, ...describeException(thrown) });
      log.error('An instrumentation collaborator rejected', {
        collaborator,
        step,
        ...exceptionFields(thrown),
      });
      return undefined;
    }
  }

  /** Logs a progress row the protocol schema refused; progress is advisory. */
  function noteProgress(log: Logger, step: string, result: Result<unknown> | undefined): void {
    if (result !== undefined && isErr(result)) {
      log.warn('A progress row was rejected and not sent', { step, code: result.error.code });
    }
  }

  /**
   * Builds one frame through `createEnvelope` and sends it to the session's
   * editor and DevTools clients. A throw from either step is recorded, never
   * propagated.
   */
  function sendToInterfaces(
    failures: CollaboratorFailure[],
    log: Logger,
    sessionId: string,
    step: string,
    build: () => ProtocolMessage,
  ): void {
    attempt(failures, log, 'broadcaster', step, () => {
      deps.broadcaster.broadcastToKinds(sessionId, UI_CLIENT_KINDS, build());
    });
  }

  /**
   * Delivers one `server-agent.config` frame to the project's preload
   * connections, judged by the registry's receipt. A throw counts as not
   * delivered and is logged by name only.
   */
  function deliverServerConfig(
    log: Logger,
    projectRoot: string,
    payload: ServerAgentConfigPayload,
  ): DeliveryAttempt {
    try {
      const message = createEnvelope('server-agent.config', payload, { ts: clock() });
      const sent = deps.serverAgentChannel.sendToServerAgent(projectRoot, message);

      if (isErr(sent)) {
        log.info('No dev-server preload received the configuration', { code: sent.error.code });
        return { delivered: false, code: sent.error.code };
      }

      return { delivered: true };
    } catch (thrown) {
      log.error('Delivering the preload configuration threw', exceptionFields(thrown));
      return { delivered: false, code: DebuggenError.from(thrown, 'TRANSPORT_DISCONNECTED').code };
    }
  }

  /**
   * Delivers one `agent.config` frame to the connection carrying the session's
   * bound tab, judged by the registry's receipt. A throw counts as not
   * delivered and is logged by name only.
   */
  function deliverPageConfig(
    log: Logger,
    sessionId: string,
    payload: AgentConfigPayload,
  ): DeliveryAttempt {
    try {
      const message = createEnvelope('agent.config', payload, { ts: clock() });
      const sent = deps.agentChannel.sendToBoundTab(sessionId, message);

      if (isErr(sent)) {
        log.info('No bound-tab connection received the page-agent configuration', {
          code: sent.error.code,
        });
        return { delivered: false, code: sent.error.code };
      }

      return { delivered: true };
    } catch (thrown) {
      log.error('Delivering the page-agent configuration threw', exceptionFields(thrown));
      return { delivered: false, code: DebuggenError.from(thrown, 'TRANSPORT_DISCONNECTED').code };
    }
  }

  /**
   * Builds and delivers the dormant `agent.config` of one capture — every hook
   * false, which detaches the page agent's hooks (AAP §0.5.1). A payload the
   * schema refuses is logged and counts as not delivered.
   */
  function deliverDormantPageConfig(
    log: Logger,
    sessionId: string,
    captureId: string,
  ): DeliveryAttempt {
    const dormant = parseAgentConfigPayload({
      sessionId,
      captureId,
      hooks: DORMANT_AGENT_HOOK_CONFIG,
    });

    if (isErr(dormant)) {
      log.error('The dormant page-agent configuration was rejected and not sent', {
        code: dormant.error.code,
      });
      return { delivered: false, code: dormant.error.code };
    }

    return deliverPageConfig(log, sessionId, dormant.value);
  }

  /**
   * Builds and delivers the capture-less `server-agent.config` — the disabled
   * signal set with no capture id, which makes the preload disable its
   * instrumentations (AAP §0.5.1). A payload the schema refuses is logged and
   * counts as not delivered.
   */
  function deliverDisabledServerConfig(log: Logger, projectRoot: string): DeliveryAttempt {
    const disabled = parseServerAgentConfigPayload({ signals: DISABLED_SERVER_AGENT_SIGNALS });

    if (isErr(disabled)) {
      log.error('The capture-less preload configuration was rejected and not sent', {
        code: disabled.error.code,
      });
      return { delivered: false, code: disabled.error.code };
    }

    return deliverServerConfig(log, projectRoot, disabled.value);
  }

  // -------------------------------------------------------------------------
  // Producer bookkeeping — the ledger and the pending disarms
  // -------------------------------------------------------------------------

  /** One session's producer ledger, or an empty one rooted at `projectRoot`. */
  function ledgerOf(sessionId: string, projectRoot: string): ProducerLedger {
    return ledgers.get(sessionId) ?? { projectRoot };
  }

  /** Replaces one session's producer ledger; nothing is recorded after `dispose`. */
  function writeLedger(sessionId: string, next: ProducerLedger): void {
    if (!disposed) {
      ledgers.set(sessionId, next);
    }
  }

  /** The producers a pending entry names, in the stable order: page agent, then preload. */
  function producersOf(entry: PendingDisarm | undefined): readonly ArmedProducer[] {
    if (entry === undefined) {
      return Object.freeze([]);
    }

    const producers: ArmedProducer[] = [];

    if (entry.pageCaptureId !== undefined) {
      producers.push(PAGE_AGENT_PRODUCER);
    }

    if (entry.server) {
      producers.push(SERVER_AGENT_PRODUCER);
    }

    return Object.freeze(producers);
  }

  /** Tells every dormancy listener that a session's outstanding disarms are all settled. */
  function notifyDormancy(sessionId: string): void {
    for (const listener of [...dormancyListeners]) {
      try {
        listener(sessionId);
      } catch (thrown) {
        sessionLog(sessionId).error('A dormancy listener threw', exceptionFields(thrown));
      }
    }
  }

  /**
   * Replaces one session's pending disarms — dropping the entry once it names
   * no producer — and notifies the dormancy listeners when that empties a set
   * that was not empty. Nothing is recorded after `dispose`.
   */
  function writePending(sessionId: string, next: PendingDisarm | undefined): void {
    if (disposed) {
      return;
    }

    const wasPending = producersOf(pending.get(sessionId)).length > 0;
    const isPending = producersOf(next).length > 0;

    if (next === undefined || !isPending) {
      pending.delete(sessionId);
    } else {
      pending.set(sessionId, next);
    }

    if (wasPending && !isPending) {
      sessionLog(sessionId).info('Every producer of the session is known to be dormant');
      notifyDormancy(sessionId);
    }
  }

  /**
   * Settles a session's outstanding page disarm: its dormant configuration was
   * delivered, or a later armed configuration superseded it.
   *
   * @returns Whether a page disarm was outstanding.
   */
  function settlePendingPage(sessionId: string): boolean {
    const entry = pending.get(sessionId);

    if (entry?.pageCaptureId === undefined) {
      return false;
    }

    writePending(sessionId, { ...entry, pageCaptureId: undefined });
    return true;
  }

  /**
   * Records a preload configuration the project's preloads took. A capture-less
   * one (no `armedFor`) disables the preload outright, so no session of the
   * project has it armed any more; an armed one makes the preload follow that
   * capture alone, so every other session's arm is superseded. Either way,
   * every outstanding preload disarm of the project is settled.
   *
   * @returns The sessions whose outstanding preload disarm was settled.
   */
  function settleServerForProject(
    projectRoot: string,
    armedFor: { readonly sessionId: string; readonly captureId: string } | undefined,
  ): readonly string[] {
    if (armedFor !== undefined && !ledgers.has(armedFor.sessionId)) {
      writeLedger(armedFor.sessionId, { projectRoot });
    }

    for (const [sessionId, ledger] of [...ledgers]) {
      if (ledger.projectRoot !== projectRoot) {
        continue;
      }

      if (armedFor?.sessionId === sessionId) {
        writeLedger(sessionId, {
          ...ledger,
          serverArmedCaptureId: armedFor.captureId,
          serverAwaitingCaptureId: undefined,
        });
      } else if (
        ledger.serverArmedCaptureId !== undefined ||
        ledger.serverAwaitingCaptureId !== undefined
      ) {
        writeLedger(sessionId, {
          ...ledger,
          serverArmedCaptureId: undefined,
          serverAwaitingCaptureId: undefined,
        });
      }
    }

    const settled: string[] = [];

    for (const [sessionId, entry] of [...pending]) {
      if (entry.projectRoot === projectRoot && entry.server) {
        settled.push(sessionId);
        writePending(sessionId, { ...entry, server: false });
      }
    }

    return Object.freeze(settled);
  }

  /**
   * The read-only view of one session's state. Its `agentHooks` are the hooks
   * {@link armCapture} sends for the active version ({@link armedPageHooks}),
   * not the install-time configuration alone: a page hook the install could not
   * arm because no page agent had reported yet is armed by every capture of
   * that version, and a reader judging a capture by what it armed (the capture
   * stage's interaction-hook diagnostic) must see it.
   */
  function snapshotOf(state: SessionState): ArmingSnapshot {
    const config = state.configs.get(state.activePlanVersion);

    return {
      sessionId: state.sessionId,
      projectRoot: state.projectRoot,
      activePlanVersion: state.activePlanVersion,
      agentHooks: config === undefined ? DORMANT_AGENT_HOOK_CONFIG : armedPageHooks(state, config),
      serverSignals: config?.serverSignals ?? DISABLED_SERVER_AGENT_SIGNALS,
      ...(state.armedCaptureId === undefined ? {} : { armedCaptureId: state.armedCaptureId }),
    };
  }

  /** The producer configuration recomputed from a plan version's actions. */
  function deriveConfig(actions: readonly InstrumentationAction[]): ProducerConfig {
    return {
      agentHooks: deriveAgentHookConfig(actions),
      serverSignals: deriveServerAgentSignals(actions),
    };
  }

  // -------------------------------------------------------------------------
  // buildContext
  // -------------------------------------------------------------------------

  function buildContext(input: BuildContextInput): Result<InstrumentationContext, DebuggenError> {
    if (!isNonBlankString(input.sessionId)) {
      return err(
        wiringError(
          'An instrumentation context was requested without a session id.',
          'Pass the id of the session being instrumented.',
          'sessionId',
        ),
      );
    }

    const projectRoot = normalizeProjectRoot(input.projectRoot);

    if (isErr(projectRoot)) {
      return projectRoot;
    }

    const canonicalProjectRoot = input.canonicalProjectRoot;

    // A canonical root the patch layer would refuse at construction is refused
    // here instead, before a backup store is opened for the context.
    if (canonicalProjectRoot !== undefined && !isAbsoluteRootPath(canonicalProjectRoot)) {
      return err(
        wiringError(
          'An instrumentation context was requested with a canonical project root that is not an absolute path.',
          'Pass the canonical path the session’s project root was confirmed to resolve to, or omit it.',
          'canonicalProjectRoot',
        ),
      );
    }

    const code: unknown = input.code;

    if (typeof code !== 'object' || code === null) {
      return err(
        wiringError(
          'An instrumentation context was requested without the project’s code-analysis handles.',
          'Pass the code graph, queries, route map and summary of the indexed project.',
          'code',
        ),
      );
    }

    const planVersion = input.plan.planVersion;

    if (!Number.isSafeInteger(planVersion) || planVersion < 1) {
      return err(
        wiringError(
          'An instrumentation context was requested for a plan without a valid plan version.',
          'Pass the normalised plan, whose plan version counts from 1.',
          'plan.planVersion',
        ),
      );
    }

    const logger = sessionLog(input.sessionId);
    let backups: BackupStore;

    try {
      backups = createBackupStore({
        debuggenHome: deps.config.debuggenHome,
        sessionId: input.sessionId,
        logger,
      });
    } catch (thrown) {
      const error = DebuggenError.from(thrown, 'INTERNAL');
      logger.error('The session backup store could not be opened', {
        code: error.code,
        ...exceptionFields(thrown),
      });
      return err(error);
    }

    const context: InstrumentationContext = {
      sessionId: input.sessionId,
      projectRoot: projectRoot.value,
      // Present only when the caller confirmed one (exactOptionalPropertyTypes):
      // an absent key is what tells the patch layer to resolve `projectRoot`.
      ...(canonicalProjectRoot === undefined
        ? {}
        : { canonicalProjectRoot: normalizePosix(toPosix(canonicalProjectRoot)) }),
      planVersion,
      debuggenHome: deps.config.debuggenHome,
      logger,
      graph: input.code.graph,
      queries: input.code.queries,
      routeMap: input.code.routeMap,
      projectSummary: input.code.summary,
      loaded: input.code.project,
      journal: deps.modifications,
      backups,
      readiness: input.readiness,
      now: clock,
      signal: input.signal,
    };

    return ok(Object.freeze(context));
  }

  // -------------------------------------------------------------------------
  // install — request validation and the delta
  // -------------------------------------------------------------------------

  /**
   * Validates an install request before anything is reported or suspended: the
   * session id, the project root, the plan (against the normalised plan schema,
   * so an authoring-shaped plan is refused here), the plan's session, and the
   * follow-up revision rule — plan version *n + 1* builds on version *n*.
   */
  function checkInstallRequest(request: InstallRequest): Result<CheckedInstall, DebuggenError> {
    if (!isNonBlankString(request.sessionId)) {
      return err(
        wiringError(
          'An install was requested without a session id.',
          'Pass the id of the session being instrumented.',
          'sessionId',
        ),
      );
    }

    const projectRoot = normalizeProjectRoot(request.projectRoot);

    if (isErr(projectRoot)) {
      return projectRoot;
    }

    const parsed = parseInstrumentationPlan(request.plan);

    if (isErr(parsed)) {
      return parsed;
    }

    const plan = request.plan;

    if (plan.sessionId !== request.sessionId) {
      return err(
        wiringError(
          'An install was requested with a plan that belongs to a different session.',
          'Install each plan for the session it was normalised for.',
          'plan.sessionId',
        ),
      );
    }

    const previous = request.previousPlanVersion;

    if (
      previous !== undefined &&
      (!Number.isSafeInteger(previous) || previous < 1 || previous !== plan.planVersion - 1)
    ) {
      return err(
        wiringError(
          'A follow-up install named a previous plan version that is not the one immediately before the plan being installed.',
          'Pass the plan version already installed, which is exactly one less than the new plan version.',
          'previousPlanVersion',
        ),
      );
    }

    return ok({ sessionId: request.sessionId, projectRoot: projectRoot.value, plan });
  }

  /**
   * Resolves a follow-up's delta: the ids of the new plan version's actions
   * whose identity — the upstream `actionIdentityKey` — the previous version did
   * not carry. Installed actions are never installed twice and never removed.
   */
  function resolveDelta(
    request: InstallRequest,
    plan: InstrumentationPlan,
    prior: SessionState | undefined,
    log: Logger,
  ): Result<ResolvedDelta | undefined, DebuggenError> {
    const previousPlanVersion = request.previousPlanVersion;

    if (previousPlanVersion === undefined) {
      return ok(undefined);
    }

    const previousActions =
      request.previousActions ??
      (prior?.activePlanVersion === previousPlanVersion ? prior.actions : undefined);

    if (previousActions === undefined) {
      return err(
        new DebuggenError(
          'SESSION_INVALID_STATE',
          'A follow-up install could not tell which actions are already installed.',
          {
            hint: 'Pass the previous plan version’s actions, so only the additive actions are installed.',
            details: { field: 'previousActions', previousPlanVersion },
          },
        ),
      );
    }

    const installedKeys = new Set(previousActions.map((action) => actionIdentityKey(action)));
    const plannedKeys = new Set(
      plan.instrumentationTargets.map((action) => actionIdentityKey(action)),
    );
    const actionIds = plan.instrumentationTargets
      .filter((action) => !installedKeys.has(actionIdentityKey(action)))
      .map((action) => action.id);
    const dropped = [...installedKeys].filter((key) => !plannedKeys.has(key)).length;

    if (dropped > 0) {
      log.warn(
        'A follow-up plan omits actions an earlier plan version installed; they stay installed',
        {
          previousPlanVersion,
          planVersion: plan.planVersion,
          dropped,
        },
      );
    }

    return ok({ delta: { previousPlanVersion, actionIds }, previousActions });
  }

  /**
   * Runs an install's {@link InstallRequest.confirmProjectRoot} for one act,
   * synchronously, so the caller can act with no `await` between the proof and
   * the act.
   *
   * The caller's own refusal is returned unchanged. A throw, or an answer
   * whose canonical root is not an absolute path, fails closed as an
   * `INTERNAL` refusal ({@link rootConfirmationError}) rather than letting a
   * root nobody re-proved be written in; the thrown value is not kept — only
   * its closed exception class is logged. Every refusal is logged at `warn` by
   * its code and reason alone, never a path.
   *
   * @param request The install request, which may carry the confirmation.
   * @param log The session's logger.
   * @param stage The act the confirmation guards, for the log.
   * @returns `Ok(undefined)` when the request carries no confirmation, the
   *   confirmed canonical root, or the refusal.
   */
  function confirmInstallRoot(
    request: InstallRequest,
    log: Logger,
    stage: RootConfirmationStage,
  ): Result<{ readonly canonicalRoot: string } | undefined, DebuggenError> {
    const confirm = request.confirmProjectRoot;

    if (confirm === undefined) {
      return ok(undefined);
    }

    let answer: Result<{ readonly canonicalRoot: string }, DebuggenError>;
    let thrown: ExceptionDescription | undefined;

    try {
      answer = confirm();
    } catch (caught) {
      thrown = describeException(caught);
      answer = err(rootConfirmationError('project-root-confirmation-threw'));
    }

    if (isErr(answer)) {
      const reason = loggableReasonOf(answer.error);
      log.warn('The project root was not confirmed; no instrumentation was installed', {
        stage,
        code: answer.error.code,
        ...(reason === undefined ? {} : { reason }),
        ...thrown,
      });
      return answer;
    }

    const canonicalRoot = confirmedCanonicalRoot(answer.value);

    if (canonicalRoot === undefined) {
      const invalid = rootConfirmationError('project-root-confirmation-invalid');
      log.warn('The project root was not confirmed; no instrumentation was installed', {
        stage,
        code: invalid.code,
        reason: 'project-root-confirmation-invalid',
      });
      return err(invalid);
    }

    return ok({ canonicalRoot });
  }

  /**
   * The dev-server detection's collaborators for one install: the injected
   * ones, plus — when none was injected — the absolute path of the telemetry
   * preload, so the detection's relaunch command imports the very file the
   * launcher attaches (`--import file:///…/register.mjs`) rather than a
   * `"$DEBUGGEN_PRELOAD_URL"` reference the developer would first have to
   * export (AAP §0.5.5: the hint carries the exact relaunch command).
   *
   * Resolved per install with the launcher's own `resolvePreloadPath`, over the
   * candidates a launch uses, so the command and a launch agree on the file; a
   * preload built or removed while the service runs is seen by the next
   * install. It only checks that files exist. A miss — the telemetry package is
   * not built — keeps the reference, since a path is never fabricated, and so
   * does a throw: an install never fails for want of a more exact hint. Neither
   * is logged with a path, only with its code or closed exception class.
   */
  function detectionDeps(log: Logger): CollectObservedReadinessDeps['detectDeps'] {
    const supplied = deps.detectDeps;

    if (supplied?.preloadPath !== undefined) {
      return supplied;
    }

    let preload: Result<string, DebuggenError>;

    try {
      preload = resolvePreloadPath({ logger: log });
    } catch (thrown) {
      log.debug(
        'Resolving the telemetry preload threw; the relaunch command keeps its preload reference',
        exceptionFields(thrown),
      );
      return supplied;
    }

    if (isErr(preload)) {
      log.debug(
        'The telemetry preload was not found; the relaunch command keeps its preload reference',
        { code: preload.error.code },
      );
      return supplied;
    }

    return { ...supplied, preloadPath: preload.value };
  }

  /**
   * The preparation half of an install: the root's first confirmation, the
   * state-root separation check, the readiness facts, the root's second
   * confirmation, the context, the delta, and — unless the delta is empty —
   * the installer's call. A refused confirmation or separation check ends the
   * install here, through {@link failInstall} like every other preparation
   * failure.
   *
   * With {@link InstallRequest.confirmProjectRoot}, the root is re-proved
   * immediately before the install first acts on it — the separation check,
   * judged on the confirmed canonical root — and again after the readiness
   * facts' `await`, from where the context, the delta and the installer's
   * invocation follow with no `await` in between, the context carrying the
   * second answer as `canonicalProjectRoot`. A link retargeted while the
   * readiness facts were collected is therefore refused rather than written
   * through.
   *
   * An installer failure is reported through {@link withServiceRelaunchHint},
   * with this install's detection: the error it answers is returned, and the
   * preload gaps it names are appended to `failedPreloadGaps` — the caller's
   * accumulator, as `failures` is — for {@link failInstall} to show as ✗ rows.
   */
  async function prepareInstall(
    request: InstallRequest,
    checked: CheckedInstall,
    prior: SessionState | undefined,
    log: Logger,
    failedPreloadGaps: UnavailableSignal[],
  ): Promise<Result<PreparedInstall, DebuggenError>> {
    const { sessionId, projectRoot, plan } = checked;
    const beforeCheck = confirmInstallRoot(request, log, 'before-state-root-check');

    if (isErr(beforeCheck)) {
      return beforeCheck;
    }

    // Logged by `failInstall`, whose record carries the error's closed shape
    // (its code and constant details) and never a path.
    const apart = await requireStateHomeApart(beforeCheck.value?.canonicalRoot ?? projectRoot);

    if (isErr(apart)) {
      return apart;
    }

    const evidence = await collectReadinessEvidence(
      {
        serverAgents: deps.serverAgents,
        agents: deps.agents,
        devServers: deps.devServers,
        detect: deps.detectDevServer,
        detectDeps: detectionDeps(log),
        config: { host: deps.config.host, port: deps.config.port },
        logger: log,
        now: clock,
      },
      {
        sessionId,
        projectRoot,
        boundTab: request.boundTab,
        plan,
        devServerUrl: request.devServerUrl,
        signal: request.signal,
      },
    );

    if (isErr(evidence)) {
      return evidence;
    }

    // Re-proved after the last `await` before the installer: from here to the
    // installer's invocation below, everything runs in this turn.
    const beforeInstall = confirmInstallRoot(request, log, 'before-install');

    if (isErr(beforeInstall)) {
      return beforeInstall;
    }

    const context = buildContext({
      sessionId,
      projectRoot,
      ...(beforeInstall.value === undefined
        ? {}
        : { canonicalProjectRoot: beforeInstall.value.canonicalRoot }),
      plan,
      code: request.code,
      readiness: evidence.value.observed,
      signal: request.signal,
    });

    if (isErr(context)) {
      return context;
    }

    const resolved = resolveDelta(request, plan, prior, log);

    if (isErr(resolved)) {
      return resolved;
    }

    if (resolved.value !== undefined && resolved.value.delta.actionIds.length === 0) {
      log.info('The follow-up plan adds no action; nothing is installed', {
        planVersion: plan.planVersion,
        previousPlanVersion: resolved.value.delta.previousPlanVersion,
      });

      return ok({
        kind: 'unchanged',
        context: context.value,
        evidence: evidence.value,
        resolved: resolved.value,
      });
    }

    const installed = await installer(plan, context.value, {
      adapters,
      delta: resolved.value?.delta,
      skipFeasibility: request.skipFeasibility ?? false,
      // The hold check of the patch layer names the session holding a target;
      // a session this service installed on another project is never it.
      sessionOnAnotherProject: sessionOnAnotherProjectThan(
        projectRoot,
        (holder) => sessions.get(holder)?.projectRoot,
      ),
    });

    if (isErr(installed)) {
      // The relaunch command first, then — when that did not apply — the
      // session holding a target this plan needed; each keeps a proven hint.
      // A holder is live while this service still tracks it — installed, or
      // with its install running (its pending records hold the target) —
      // and `stopSession` forgets a session once its cleanup has run.
      const reported = withServiceRelaunchHint(installed.error, evidence.value.devServer);
      failedPreloadGaps.push(...reported.preloadGaps);
      return err(
        withHeldTargetHint(
          reported.error,
          (holder) => sessions.has(holder) || inFlight.has(holder),
        ),
      );
    }

    return ok({
      kind: 'installed',
      context: context.value,
      evidence: evidence.value,
      resolved: resolved.value,
      result: installed.value,
    });
  }

  /**
   * The watcher half of the self-write contract, on every branch: a session
   * already watched is refreshed from the journal; a session not yet watched
   * starts being watched (its watch set is built from the journal, and it
   * starts suspended because it was suspended before the install); then the
   * suspension ends and every watched file is evaluated once.
   */
  async function settleWatcher(
    failures: CollaboratorFailure[],
    log: Logger,
    sessionId: string,
    projectRoot: string,
  ): Promise<void> {
    if (watched.has(sessionId)) {
      const refreshed = await attemptAsync(failures, log, 'watcher', 'refresh', () =>
        deps.watcher.refresh(sessionId),
      );

      if (refreshed !== undefined && isErr(refreshed)) {
        log.warn('The conflict watcher could not refresh its watch set', {
          code: refreshed.error.code,
        });
      }
    } else {
      const started = await attemptAsync(failures, log, 'watcher', 'watchSession', () =>
        deps.watcher.watchSession({ sessionId, projectRoot }),
      );

      if (started !== undefined) {
        if (isErr(started)) {
          log.warn('The conflict watcher could not start watching the session', {
            code: started.error.code,
          });
        } else if (!disposed) {
          watched.add(sessionId);
        }
      }
    }

    attempt(failures, log, 'watcher', 'resume', () => {
      deps.watcher.resume(sessionId);
    });
  }

  // -------------------------------------------------------------------------
  // install — announcing, succeeding, failing
  // -------------------------------------------------------------------------

  /** Announces the normalised plan as `instrumentation.plan`. */
  function announcePlan(
    failures: CollaboratorFailure[],
    log: Logger,
    sessionId: string,
    plan: InstrumentationPlan,
  ): void {
    const payload = parseInstrumentationPlanPayload({ sessionId, plan });

    if (isErr(payload)) {
      failures.push({
        collaborator: 'protocol',
        step: 'instrumentation.plan',
        ...describeException(payload.error),
      });
      log.error('The plan announcement was rejected and not sent', { code: payload.error.code });
      return;
    }

    sendToInterfaces(failures, log, sessionId, 'instrumentation.plan', () =>
      createEnvelope('instrumentation.plan', payload.value, { ts: clock() }),
    );
  }

  /**
   * Emits the capture-time ✗ rows of {@link reportPreloadGaps}: one terminal
   * `failed` row of the `instrument` stage per gap, whose message is
   * `unavailableSignalMessage`'s sentence — the wording and shape of the
   * checklist's ✗ rows — and whose detail is the gap's hint verbatim, as one
   * line. Byte-identical rows are emitted once.
   *
   * The row's `failed` status is the ✗ of a signal the capture proceeds
   * without, never a session failure: nothing here calls `stageFailed` or
   * sends `instrumentation.failed`. A progress collaborator that throws or
   * refuses the row is logged and costs the arm nothing, because the capture
   * is already armed with what it has.
   */
  function emitPreloadGapRows(
    log: Logger,
    sessionId: string,
    gaps: readonly UnavailableSignal[],
    enabledLabels: readonly string[],
  ): void {
    const emitted = new Set<string>();

    for (const gap of gaps) {
      const message = unavailableSignalMessage(
        labelForSignal(gap.signal),
        gap.reason,
        enabledLabels,
      );

      if (message === undefined) {
        continue;
      }

      const detail = clip(toDisplayLine(gap.hint), MAX_PROGRESS_DETAIL_LENGTH);
      const key = `${message}\n${detail}`;

      if (emitted.has(key)) {
        continue;
      }

      emitted.add(key);

      const row: ProgressRow = {
        stage: INSTRUMENT_STAGE,
        status: 'failed',
        message,
        ...(detail.length === 0 ? {} : { detail }),
      };

      noteProgress(
        log,
        'preloadGap',
        attempt([], log, 'progress', 'preloadGap', () => deps.progress.emit(sessionId, row)),
      );
    }
  }

  /**
   * Emits one checklist row per entry, in order, under the instrument stage,
   * with `status` — `running` for a {@link WaitingRow} being shown, `failed`
   * for one the page answered with a gap. A throw or a schema refusal is
   * recorded and logged; progress is advisory.
   */
  function emitChecklistRows(
    failures: CollaboratorFailure[],
    log: Logger,
    sessionId: string,
    rows: readonly WaitingRow[],
    status: 'running' | 'failed',
  ): void {
    const step = status === 'running' ? 'waitingRow' : 'settledWaitingRow';

    for (const entry of rows) {
      const row: ProgressRow = {
        stage: INSTRUMENT_STAGE,
        status,
        message: entry.label,
        ...(entry.detail.length === 0 ? {} : { detail: entry.detail }),
      };

      noteProgress(
        log,
        step,
        attempt(failures, log, 'progress', step, () => deps.progress.emit(sessionId, row)),
      );
    }
  }

  /**
   * The `instrumentation.ready` fields of an empty delta, which installs
   * nothing (AAP §0.4.2: "the installer applies only the delta").
   *
   * - `applied` is `[]`: this install wrote no record. The records earlier plan
   *   versions applied were announced by their own installs and remain in the
   *   journal — `SessionRecord.modifications`,
   *   `GET /sessions/:id/modifications` — so re-listing them here would
   *   misreport them as this plan version's edits.
   * - `runtimeHooks` and `unavailable` report the session's current state,
   *   because no installer ran to report a narrower one: every hook armed
   *   across the installed plan versions, and the gaps the previous install
   *   reported when this service holds that version as active.
   *
   * Pure: the journal is not read, so nothing here can fail.
   */
  function emptyDeltaReady(
    prior: SessionState | undefined,
    previousPlanVersion: number,
  ): ReadyFields {
    const known = prior?.activePlanVersion === previousPlanVersion ? prior.ready : EMPTY_READY;

    return {
      applied: EMPTY_READY.applied,
      runtimeHooks: prior?.runtimeHooks ?? known.runtimeHooks,
      unavailable: known.unavailable,
    };
  }

  /** The error an install returns when it succeeded but a collaborator threw around it. */
  function collaboratorError(
    failures: readonly CollaboratorFailure[],
    planVersion: number,
    appliedCount: number,
  ): DebuggenError {
    return new DebuggenError(
      'INTERNAL',
      'Instrumentation was installed, but reporting it to the user interfaces failed.',
      {
        hint: 'Check the service log for the failing collaborator, then reopen the session to see the instrumentation it holds.',
        details: {
          planVersion,
          activePlanVersion: planVersion,
          applied: appliedCount,
          failures: failures.map((failure) => ({ ...failure })),
        },
      },
    );
  }

  /**
   * Validates and sends one `instrumentation.ready` frame to the session's
   * editor and DevTools clients. A payload the ready schema refuses is logged
   * with `rejectedMessage`, recorded as a failure and not sent.
   */
  function sendReady(
    failures: CollaboratorFailure[],
    log: Logger,
    sessionId: string,
    ready: ReadyFields,
    rejectedMessage: string,
  ): void {
    const readyPayload = parseInstrumentationReadyPayload({
      sessionId,
      applied: ready.applied,
      runtimeHooks: ready.runtimeHooks,
      unavailable: ready.unavailable,
    });

    if (isErr(readyPayload)) {
      failures.push({
        collaborator: 'protocol',
        step: 'instrumentation.ready',
        ...describeException(readyPayload.error),
      });
      log.error(rejectedMessage, { code: readyPayload.error.code });
      return;
    }

    const payload: InstrumentationReadyPayload = readyPayload.value;
    sendToInterfaces(failures, log, sessionId, 'instrumentation.ready', () =>
      createEnvelope('instrumentation.ready', payload, { ts: clock() }),
    );
  }

  // -------------------------------------------------------------------------
  // The signal report — runtime shares, their refresh, and the bind replay
  // -------------------------------------------------------------------------

  /**
   * The ids of the adapters whose share of a plan's report can be asked again:
   * registered, given at least one of the plan's actions, and every one of
   * those actions in `runtime` mode — so asking again writes no file. Read off
   * the plan's own `adapter` fields and the registry, never off a list of ids.
   */
  function refreshableAdapterIds(actions: readonly InstrumentationAction[]): ReadonlySet<string> {
    const runtimeOnly = new Map<string, boolean>();

    for (const action of actions) {
      runtimeOnly.set(
        action.adapter,
        (runtimeOnly.get(action.adapter) ?? true) && action.mode === RUNTIME_ACTION_MODE,
      );
    }

    const ids = new Set<string>();

    for (const [adapterId, onlyRuntime] of runtimeOnly) {
      if (onlyRuntime && adapters.get(adapterId) !== undefined) {
        ids.add(adapterId);
      }
    }

    return ids;
  }

  /**
   * Splits an installer result into the shares of its refreshable adapters, in
   * registry order, and the fixed rest: the feasibility and grouping gaps, and
   * every other adapter's hooks and gaps.
   */
  function splitReport(
    result: AggregateInstallResult,
    refreshable: ReadonlySet<string>,
  ): { readonly fixed: ReportParts; readonly shares: readonly RuntimeShare[] } {
    const answersByAdapter = new Map<string, unknown[]>();

    for (const answer of result.perAdapter) {
      const adapterId: unknown = answer.adapterId;

      if (isNonBlankString(adapterId) && refreshable.has(adapterId)) {
        const answers = answersByAdapter.get(adapterId) ?? [];
        answers.push(answer);
        answersByAdapter.set(adapterId, answers);
      }
    }

    const shares: RuntimeShare[] = [];

    for (const adapter of adapters.adapters()) {
      const answers = answersByAdapter.get(adapter.id);
      const share = answers === undefined ? undefined : readShare(adapter.id, answers);

      if (share !== undefined) {
        shares.push(share);
      }
    }

    const shared = new Set<string>(shares.map((share) => share.adapterId));
    const otherHooks = new Set<string>();

    for (const answer of result.perAdapter) {
      const adapterId: unknown = answer.adapterId;
      const hooks: unknown = answer.runtimeHooks;

      if (isNonBlankString(adapterId) && shared.has(adapterId)) {
        continue;
      }

      if (Array.isArray(hooks)) {
        for (const hook of hooks.filter(isNonBlankString)) {
          otherHooks.add(hook);
        }
      }
    }

    return { fixed: fixedPartOf(result, shares, otherHooks), shares };
  }

  /**
   * The signal report an install leaves: for an installed plan, split off the
   * installer's result and judged against the facts the install's context
   * carried; for an empty delta, the previous version's shares carried over —
   * judged against the facts they were judged against — with the fixed part
   * re-derived from the re-announced fields.
   */
  function signalReportOf(
    request: InstallRequest,
    prepared: PreparedInstall,
    prior: SessionState | undefined,
    ready: ReadyFields,
    plan: InstrumentationPlan,
  ): SignalReport {
    const refreshable = refreshableAdapterIds(plan.instrumentationTargets);
    let fixed: ReportParts;
    let shares: readonly RuntimeShare[];
    let judged: ObservedReadinessInputs;

    if (prepared.kind === 'installed') {
      ({ fixed, shares } = splitReport(prepared.result, refreshable));
      judged = prepared.context.readiness;
    } else {
      const previous =
        prior?.activePlanVersion === prepared.resolved.delta.previousPlanVersion
          ? prior.signals
          : undefined;
      shares = (previous?.shares ?? []).filter((share) => refreshable.has(share.adapterId));
      fixed = fixedPartOf(ready, shares, new Set<string>(previous?.fixed.runtimeHooks ?? []));
      judged = previous?.judged ?? prepared.context.readiness;
    }

    return {
      plan,
      context: { ...prepared.context, signal: undefined },
      devServerUrl: request.devServerUrl,
      skipFeasibility: request.skipFeasibility ?? false,
      requireServerAgent: request.requireServerAgent === true,
      judged,
      fixed,
      shares,
      awaitingPage: [],
      confirmed: [],
      waiting: [],
    };
  }

  /**
   * Asks every share's adapter again, against `readiness`, with the runtime
   * actions of the report's plan it installs — those that still pass the
   * feasibility gate, unless the install skipped it.
   *
   * Only refreshable adapters have shares, so nothing here can write a file. A
   * throw, an abort or an answer that is not an ordinary runtime result keeps
   * that adapter's previous share, as does a feasibility check that cannot be
   * run; each is logged with the adapter id and the error's closed shape.
   */
  async function refreshShares(
    report: SignalReport,
    readiness: ObservedReadinessInputs,
    signal: AbortSignal | undefined,
    log: Logger,
  ): Promise<readonly RuntimeShare[]> {
    if (report.shares.length === 0) {
      return report.shares;
    }

    const context: InstrumentationContext = { ...report.context, readiness, signal };
    const actions = report.plan.instrumentationTargets;
    const candidates = report.shares.flatMap((share) => runtimeActionsOf(actions, share.adapterId));
    let feasible: ReadonlySet<string> | undefined;

    if (!report.skipFeasibility) {
      try {
        feasible = new Set<string>(
          checkFeasibility(candidates, context, { resolver: adapters }).feasible.map(
            (action) => action.id,
          ),
        );
      } catch (thrown) {
        log.warn(
          'The runtime actions could not be checked again; the signal report is kept',
          exceptionFields(thrown),
        );
        return report.shares;
      }
    }

    const shares: RuntimeShare[] = [];

    for (const share of report.shares) {
      const adapter = adapters.get(share.adapterId);
      const shareActions = runtimeActionsOf(actions, share.adapterId).filter(
        (action) => feasible === undefined || feasible.has(action.id),
      );

      if (adapter === undefined || shareActions.length === 0 || signal?.aborted === true) {
        shares.push(share);
        continue;
      }

      let answer: unknown;

      try {
        answer = await adapter.install(shareActions, context);
      } catch (thrown) {
        log.warn('A runtime adapter could not be asked again; its share of the report is kept', {
          adapter: share.adapterId,
          ...exceptionFields(thrown),
        });
        shares.push(share);
        continue;
      }

      const refreshed = readShare(share.adapterId, [answer]);

      if (refreshed === undefined) {
        log.warn(
          'A runtime adapter answered the refresh with no runtime result; its share is kept',
          {
            adapter: share.adapterId,
          },
        );
        shares.push(share);
        continue;
      }

      shares.push(refreshed);
    }

    return shares;
  }

  /** Cancels the session's background refresh of its signal report, when one runs. */
  function stopSignalWaiter(sessionId: string): void {
    const waiter = signalWaiters.get(sessionId);

    if (waiter !== undefined) {
      signalWaiters.delete(sessionId);
      waiter.abort();
    }
  }

  /**
   * Starts the session's one background refresh of its signal report,
   * replacing any that runs: with `immediate`, the report is re-judged at once;
   * then, while the latest verdict still holds a signal back on the bound page,
   * the tab's next document is awaited — at most {@link MAX_RELOAD_WAIT_MS} for
   * each — and the report re-judged when one reports. A timeout ends it, as do
   * `stopSession`, `dispose`, a newer install, replay or arm.
   *
   * Fire and forget: nothing it does is awaited by a caller, and nothing it
   * meets escapes it.
   */
  function startSignalWaiter(sessionId: string, immediate: boolean): void {
    stopSignalWaiter(sessionId);

    if (disposed || sessions.get(sessionId)?.signals === undefined) {
      return;
    }

    const controller = new AbortController();
    const log = sessionLog(sessionId);
    signalWaiters.set(sessionId, controller);

    void runSignalWaiter(sessionId, controller.signal, immediate, log)
      .catch((thrown: unknown) => {
        log.error('The background refresh of the signal report threw', exceptionFields(thrown));
      })
      .finally(() => {
        if (signalWaiters.get(sessionId) === controller) {
          signalWaiters.delete(sessionId);
        }
      });
  }

  /** The body of {@link startSignalWaiter}. */
  async function runSignalWaiter(
    sessionId: string,
    signal: AbortSignal,
    immediate: boolean,
    log: Logger,
  ): Promise<void> {
    if (immediate) {
      await refreshSignalReport(sessionId, signal, log);
    }

    let afterDocumentId = sessions.get(sessionId)?.signals?.judged.browserAgent?.documentId;

    while (!signal.aborted && !disposed) {
      const report = sessions.get(sessionId)?.signals;
      const tab = knownTabs.get(sessionId);

      if (report === undefined || tab === undefined || report.awaitingPage.length === 0) {
        return;
      }

      const next = await waitForNextAgentReady(
        deps.agents,
        {
          sessionId,
          tabId: tab.tabId,
          afterDocumentId,
          timeoutMs: MAX_RELOAD_WAIT_MS,
          signal,
          failureMessage: SIGNAL_WAIT_FAILURE_MESSAGE,
        },
        log,
      );

      if (next === undefined || signal.aborted) {
        log.debug('No new document reported on the bound tab; the signal report stays as it is', {
          tabId: tab.tabId,
        });
        return;
      }

      // Waiting again needs a document other than this one, so a report that
      // changes nothing cannot answer the next wait at once.
      afterDocumentId = next.documentId;
      await refreshSignalReport(sessionId, signal, log);
    }
  }

  /**
   * Re-judges one session's signal report against the page as it is now: the
   * facts are collected again for the tab this service knows, the shares are
   * asked again when those facts changed, and the readiness gate evaluates the
   * report's plan — never asking for a reload, never announcing "Ready to
   * capture" — then {@link publishRefresh} states what changed.
   *
   * Skipped while an install for the session runs, and dropped when the
   * session's report was replaced meanwhile. Never throws.
   */
  async function refreshSignalReport(
    sessionId: string,
    signal: AbortSignal,
    log: Logger,
  ): Promise<void> {
    const state = sessions.get(sessionId);
    const report = state?.signals;

    if (disposed || signal.aborted || inFlight.has(sessionId) || state === undefined) {
      return;
    }

    if (report === undefined) {
      return;
    }

    const current = (): boolean =>
      !disposed &&
      !signal.aborted &&
      !inFlight.has(sessionId) &&
      sessions.get(sessionId)?.signals === report;
    const boundTab = knownTabs.get(sessionId);

    try {
      const evidence = await collectReadinessEvidence(
        {
          serverAgents: deps.serverAgents,
          agents: deps.agents,
          devServers: deps.devServers,
          detect: deps.detectDevServer,
          detectDeps: deps.detectDeps,
          config: { host: deps.config.host, port: deps.config.port },
          logger: log,
          now: clock,
        },
        {
          sessionId,
          projectRoot: state.projectRoot,
          boundTab,
          plan: report.plan,
          devServerUrl: report.devServerUrl,
          signal,
        },
      );

      if (isErr(evidence)) {
        log.warn('The page facts could not be collected again; the signal report is kept', {
          code: evidence.error.code,
        });
        return;
      }

      if (!current()) {
        return;
      }

      let judged = evidence.value.observed;
      let shares = observedFactsDiffer(report.judged, judged)
        ? await refreshShares(report, judged, signal, log)
        : report.shares;

      const verdict = await evaluateReadiness(
        { adapters, agents: deps.agents, logger: log, now: clock, reloadPrompts },
        {
          context: { ...report.context, readiness: judged, signal },
          plan: report.plan,
          boundTab,
          devServer: evidence.value.devServer,
          allowReloadPrompt: false,
          requireServerAgent: report.requireServerAgent,
          announceReady: false,
          signal,
        },
      );

      if (isErr(verdict)) {
        log.warn('Readiness could not be evaluated again; the signal report is kept', {
          code: verdict.error.code,
        });
        return;
      }

      // The gate may have settled on a report that arrived while it judged.
      if (observedFactsDiffer(judged, verdict.value.observed)) {
        judged = verdict.value.observed;
        shares = await refreshShares({ ...report, shares }, judged, signal, log);
      }

      if (current()) {
        publishRefresh(sessionId, report, shares, judged, verdict.value, log);
      }
    } catch (thrown) {
      log.warn('Re-judging the signal report threw; the report is kept', exceptionFields(thrown));
    }
  }

  /**
   * States what a background refresh changed, in the order the progress view
   * reads: the session's state first; then one corrected
   * `instrumentation.ready` to both user interfaces when the composed report
   * differs from the one announced; then each {@link WaitingRow} not shown
   * yet, or shown with another detail (a tab was bound, its page has not
   * reported yet); then each waiting row the page answered with a gap,
   * settled as ✗ in place with that gap's words; then a ✓ row for each signal
   * the checklist now confirms that no ✓ row has been shown for — replacing
   * its waiting row in place — and the checklist's one terminal ✗ row, in AAP
   * §0.5.5 words, for each gap that is not waiting for the page and was not
   * announced before — or was, but only while its signal waited, so it was
   * never shown as a failure. Nothing else — no "Ready to capture", which the
   * orchestrator's own re-gate emits as it moves the session to `ready`, and
   * which the checklist rows above it keep their places before.
   */
  function publishRefresh(
    sessionId: string,
    expected: SignalReport,
    shares: readonly RuntimeShare[],
    judged: ObservedReadinessInputs,
    verdict: ReadinessVerdict,
    log: Logger,
  ): void {
    const state = sessions.get(sessionId);
    const planVersion = expected.plan.planVersion;
    const config = state?.configs.get(planVersion);

    if (state === undefined || config === undefined || state.activePlanVersion !== planVersion) {
      return;
    }

    const folded = foldShares({
      report: expected,
      shares,
      judged,
      ready: state.ready,
      config,
      runtimeHooks: state.runtimeHooks,
    });
    const armed = armedCaptureSignals(
      captureAgentHooks(folded.config.agentHooks, expected.plan.instrumentationTargets),
      folded.config.serverSignals,
      folded.runtimeHooks,
    );
    const confirmed = confirmedSignals(verdict, armed, folded.ready.unavailable);
    const awaitingPage = new Set<CaptureSignal>(verdict.awaitingPageSignals ?? []);
    const shownLabels = new Set<string>(labelsOfSignals(expected.confirmed));
    const newlyConfirmed = confirmed.filter(
      (signal) => !shownLabels.has(CAPTURE_SIGNAL_LABELS[signal]),
    );
    const checkedLabels = new Set<string>(labelsOfSignals([...expected.confirmed, ...confirmed]));
    // A signal that was waiting was never shown as a failure, so a gap it now
    // has is new to the developer even when the report already listed it.
    const wasWaiting = new Set<string>(expected.awaitingPage);
    const newGaps = rowGapsOf(folded.ready.unavailable, shares, awaitingPage).filter(
      (gap) =>
        wasWaiting.has(gap.signal) ||
        !state.ready.unavailable.some((announced) => sameGap(announced, gap)),
    );
    // Waiting rows: shown anew, or again when what they wait for changed —
    // a tab was bound, but its page has not reported yet — and settled as ✗
    // when the page answered with a gap; a ✓ row settles the rest in place.
    const waiting = waitingRowsOf(verdict, awaitingPage, checkedLabels);
    const waitingNow = new Set<string>(waiting.map((row) => row.label));
    const shownWaiting = waiting.filter(
      (row) =>
        !expected.waiting.some(
          (previous) => previous.label === row.label && previous.detail === row.detail,
        ),
    );
    const settledAsFailed: readonly WaitingRow[] = expected.waiting
      .filter((previous) => !waitingNow.has(previous.label) && !checkedLabels.has(previous.label))
      .map((previous) => ({
        label: previous.label,
        detail: settledDetail(
          verdict.plannedSignals
            .filter((signal) => CAPTURE_SIGNAL_LABELS[signal] === previous.label)
            .map((signal) =>
              gapFor(signal, [
                newGaps,
                verdict.blocking,
                verdict.degraded,
                folded.ready.unavailable,
              ]),
            ),
        ),
      }));
    // A waiting row settled as ✗ closes its label's row in place; the
    // checklist's ✗ row for the gap still states the failure in AAP §0.5.5
    // words (`unavailableSignalMessage`), so every new gap is reported to it.
    const checklistGaps = newGaps;
    const configs = new Map<number, ProducerConfig>(state.configs);
    configs.set(planVersion, folded.config);

    sessions.set(sessionId, {
      ...state,
      configs,
      ready: folded.ready,
      runtimeHooks: folded.runtimeHooks,
      signals: {
        ...folded.report,
        awaitingPage: [...awaitingPage],
        confirmed: CAPTURE_SIGNALS.filter(
          (signal) => expected.confirmed.includes(signal) || confirmed.includes(signal),
        ),
        waiting,
      },
    });

    const failures: CollaboratorFailure[] = [];

    if (folded.changed) {
      sendReady(
        failures,
        log,
        sessionId,
        folded.ready,
        'The refreshed signal report was rejected by the ready schema and not sent',
      );
    }

    emitChecklistRows(failures, log, sessionId, shownWaiting, 'running');
    emitChecklistRows(failures, log, sessionId, settledAsFailed, 'failed');

    if (newlyConfirmed.length > 0 || checklistGaps.length > 0) {
      const newlySet = new Set<CaptureSignal>(newlyConfirmed);
      const rows = buildConfirmedReadiness(verdict, confirmed, checklistGaps, clock, awaitingPage);
      const readiness = buildReadiness({
        signals: rows.signals.filter(
          (row) => isCaptureSignal(row.signal) && newlySet.has(row.signal),
        ),
        now: clock,
      });

      noteProgress(
        log,
        'reportInstrumentation',
        attempt(failures, log, 'progress', 'reportInstrumentation', () =>
          deps.progress.reportInstrumentation(sessionId, {
            ...(newlyConfirmed.length === 0 ? {} : { signals: newlyConfirmed, readiness }),
            ...(checklistGaps.length === 0 ? {} : { unavailable: checklistGaps }),
          }),
        ),
      );
    }

    log.info('The signal report was brought up to date with the page', {
      planVersion,
      changed: folded.changed,
      newlyConfirmedSignals: newlyConfirmed,
      newGapSignals: newGaps.map((gap) => gap.signal),
      unavailableSignals: folded.ready.unavailable.map((gap) => gap.signal),
      awaitingPageSignals: [...awaitingPage],
      waitingRows: waiting.map((row) => row.label),
      settledWaitingRows: settledAsFailed.map((row) => row.label),
      satisfied: verdict.satisfied,
      collaboratorFailures: failures.length,
    });
  }

  function replaySignalReport(
    request: SignalReportReplayRequest,
  ): Result<SignalReportReplayOutcome, DebuggenError> {
    if (
      !isObjectRecord(request) ||
      !isNonBlankString(request.sessionId) ||
      !isClientKindList(request.kinds) ||
      (request.boundTab !== undefined && !isBoundTab(request.boundTab))
    ) {
      return err(
        wiringError(
          'A signal report was replayed without a session id, client kinds or a valid tab binding.',
          'Pass the session id, the client kinds to replay to and the binding as the session record holds it.',
          'request',
        ),
      );
    }

    if (disposed) {
      return err(
        new DebuggenError('INTERNAL', 'The instrumentation service has been shut down.', {
          hint: 'Restart the Debug Generator service, then bind the tab again.',
        }),
      );
    }

    const { sessionId, kinds } = request;
    const log = sessionLog(sessionId);

    if (request.boundTab !== undefined) {
      knownTabs.set(sessionId, request.boundTab);

      // The running install built its verdict without this tab: the report it
      // leaves is re-judged against the tab once it is over.
      if (inFlight.has(sessionId)) {
        boundDuringInstall.add(sessionId);
      }
    }

    const state = sessions.get(sessionId);
    const report = state?.signals;
    const failed = failedReports.get(sessionId);

    if ((state === undefined || report === undefined) && failed === undefined) {
      log.debug('No signal report is held for the session; nothing was replayed');
      return ok('nothing-to-replay');
    }

    const failures: CollaboratorFailure[] = [];

    if (state !== undefined && report !== undefined) {
      const payload = parseInstrumentationReadyPayload({
        sessionId,
        applied: state.ready.applied,
        runtimeHooks: state.ready.runtimeHooks,
        unavailable: state.ready.unavailable,
      });

      if (isErr(payload)) {
        log.error('The held signal report was rejected by the ready schema and not replayed', {
          code: payload.error.code,
        });
      } else {
        const value: InstrumentationReadyPayload = payload.value;
        attempt(failures, log, 'broadcaster', 'instrumentation.ready.replay', () => {
          deps.broadcaster.broadcastToKinds(
            sessionId,
            kinds,
            createEnvelope('instrumentation.ready', value, { ts: clock() }),
          );
        });
      }
    }

    if (failed !== undefined) {
      attempt(failures, log, 'broadcaster', 'instrumentation.failed.replay', () => {
        deps.broadcaster.broadcastToKinds(
          sessionId,
          kinds,
          createEnvelope('instrumentation.failed', failed, { ts: clock() }),
        );
      });
    }

    if (report !== undefined && hasRefreshableGap(report) && knownTabs.has(sessionId)) {
      startSignalWaiter(sessionId, true);
    }

    log.info('The latest signal report was replayed', {
      kinds: [...kinds],
      ready: report !== undefined,
      failed: failed !== undefined,
      refreshing: signalWaiters.has(sessionId),
    });

    if (failures.length > 0) {
      return err(
        new DebuggenError(
          'INTERNAL',
          'The latest signal report could not be replayed to the session’s clients.',
          {
            hint: 'Check the service log for the failing collaborator, then bind the tab again.',
            details: { failures: failures.map((failure) => ({ ...failure })) },
          },
        ),
      );
    }

    return ok('replayed');
  }

  /**
   * The success branch, in the order the progress view must read (AAP §0.5.5,
   * prompt §11 Step 8):
   *
   * 1. Records the session's state and broadcasts `instrumentation.ready` with
   *    the installer's three fields as they are — `applied` being only the
   *    records this install wrote, so a follow-up announces its delta alone —
   *    except that a preload gap's hint is the detection's exact relaunch
   *    command when the preload is missing ({@link withDetectedRelaunchHints});
   *    or, for a delta that installs nothing, {@link emptyDeltaReady}'s empty
   *    `applied` beside the session's current hooks and gaps.
   * 2. Evaluates readiness **first**, with `announceReady: false`, so "Ready to
   *    capture" cannot precede the rows it closes. A reload request the gate
   *    emits is the only row that may come before the checklist.
   * 3. Confirms the checklist: a signal is enabled only when the capture arms
   *    it ({@link captureAgentHooks}, {@link armedCaptureSignals}) and the
   *    verdict found it deliverable without blocking on it, minus the
   *    installer's unavailable signals ({@link confirmedSignals}).
   * 4. Reports the checklist as the confirmed signals, the installer's
   *    unavailable entries and an aggregate readiness report
   *    ({@link buildConfirmedReadiness}) — never as the requested hook
   *    configuration, signal set or runtime hooks, whose label rule would
   *    re-add a ✓ for a signal readiness withdrew (a `Database tracing`
   *    runtime hook with no connected preload). The checklist is the one
   *    report of each label that could not be enabled: its terminal ✗ row,
   *    worded "Could not enable ‹signal›: ‹reason›. Continuing with:
   *    ‹confirmed labels›." with the hint as detail — one per label, the
   *    gate's verdict superseding an adapter's own words for the same signal
   *    (`mergeUnavailableByLabel`). No other row is emitted for it.
   * 5. Returns as `degradations` the same sentences
   *    ({@link buildDegradationNotice} over the same per-label merge and the
   *    confirmed labels), byte for byte the messages of those ✗ rows.
   * 6. Emits "Ready to capture" once, last, and only for a satisfied verdict.
   *
   * When readiness cannot be evaluated — a collaborator threw, or it answered
   * `Err` — nothing is presented as enabled: the checklist carries only the
   * installer's ✗ rows, whose sentences continue with "no confirmed signal",
   * no ready row is emitted, and the error is returned.
   */
  async function completeInstall(
    failures: CollaboratorFailure[],
    log: Logger,
    request: InstallRequest,
    checked: CheckedInstall,
    prior: SessionState | undefined,
    prepared: PreparedInstall,
  ): Promise<Result<InstrumentationOutcome, DebuggenError>> {
    const { sessionId, projectRoot, plan } = checked;
    const planVersion = plan.planVersion;
    let ready: ReadyFields;
    let config: ProducerConfig;
    let runtimeHooks: readonly string[];

    if (prepared.kind === 'installed') {
      const { result, resolved } = prepared;
      ready = {
        applied: result.applied,
        runtimeHooks: result.runtimeHooks,
        unavailable: result.unavailable,
      };

      if (resolved === undefined) {
        config = { agentHooks: result.agentHooks, serverSignals: result.serverSignals };
        runtimeHooks = result.runtimeHooks;
      } else {
        // A delta's result covers the delta's actions only, while the earlier
        // version's hooks stay installed: the next capture arms both.
        const previous =
          prior?.configs.get(resolved.delta.previousPlanVersion) ??
          deriveConfig(resolved.previousActions);
        config = {
          agentHooks: unionAgentHooks(previous.agentHooks, result.agentHooks),
          serverSignals: unionServerSignals(previous.serverSignals, result.serverSignals),
        };
        runtimeHooks = unionStrings(prior?.runtimeHooks ?? [], result.runtimeHooks);
      }
    } else {
      const previousPlanVersion = prepared.resolved.delta.previousPlanVersion;
      config =
        prior?.configs.get(previousPlanVersion) ?? deriveConfig(prepared.resolved.previousActions);
      ready = emptyDeltaReady(prior, previousPlanVersion);
      runtimeHooks = ready.runtimeHooks;
    }

    // AAP §0.5.5: with the preload missing, every preload gap carries the exact
    // relaunch command this install's detection composed. Substituted before
    // the state is recorded, so the ready frame, the degradation rows, the
    // checklist and the outcome all show the same command.
    const pageHooks = captureAgentHooks(config.agentHooks, plan.instrumentationTargets);
    ready = {
      ...ready,
      unavailable: withDetectedRelaunchHints(
        ready.unavailable,
        prepared.evidence.devServer,
        pageHooks,
      ),
    };

    let report = signalReportOf(request, prepared, prior, ready, plan);

    /** Folds refreshed shares into the install's report, fields and configuration. */
    const fold = (shares: readonly RuntimeShare[], judged: ObservedReadinessInputs): boolean => {
      const folded = foldShares({ report, shares, judged, ready, config, runtimeHooks });
      report = folded.report;
      ready = folded.ready;
      config = folded.config;
      runtimeHooks = folded.runtimeHooks;
      return folded.changed;
    };

    /** Records the session's state as the install now describes it. */
    const writeState = (): void => {
      if (disposed) {
        return;
      }

      const configs = new Map<number, ProducerConfig>(
        prior !== undefined && prior.projectRoot === projectRoot ? prior.configs : [],
      );
      configs.set(planVersion, config);
      sessions.set(sessionId, {
        sessionId,
        projectRoot,
        activePlanVersion: planVersion,
        actions: plan.instrumentationTargets,
        configs,
        ready,
        runtimeHooks,
        // Written twice when the report is corrected: the second write keeps
        // whatever capture was armed in between.
        armedCaptureId: (sessions.get(sessionId) ?? prior)?.armedCaptureId,
        signals: report,
      });
    };

    // An empty delta re-announces the previous version's report, which was
    // judged against the page as it was then: brought up to date with the
    // facts this install collected, it is never re-announced stale.
    if (
      prepared.kind === 'unchanged' &&
      observedFactsDiffer(report.judged, prepared.context.readiness)
    ) {
      fold(
        await refreshShares(report, prepared.context.readiness, request.signal, log),
        prepared.context.readiness,
      );
    }

    writeState();

    if (!disposed) {
      failedReports.delete(sessionId);

      if (request.boundTab !== undefined) {
        knownTabs.set(sessionId, request.boundTab);
      }
    }

    sendReady(
      failures,
      log,
      sessionId,
      ready,
      'The installer result was rejected by the ready schema and not sent',
    );

    // Readiness is judged before a single checklist row is sent, and told not
    // to announce "Ready to capture" itself: that row closes the group below,
    // after the rows it summarises.
    const verdict = await attemptAsync(failures, log, 'readiness', 'evaluateReadiness', () =>
      evaluateReadiness(
        {
          adapters,
          agents: deps.agents,
          progress: deps.progress,
          logger: log,
          now: clock,
          reloadWaitMs: deps.reloadWaitMs,
          reloadPrompts,
        },
        {
          context: prepared.context,
          plan,
          boundTab: request.boundTab,
          devServer: prepared.evidence.devServer,
          allowReloadPrompt: request.allowReloadPrompt,
          requireServerAgent: request.requireServerAgent,
          announceReady: false,
          signal: request.signal,
        },
      ),
    );

    const reportChecklist = (installed: InstalledSignals): void => {
      noteProgress(
        log,
        'reportInstrumentation',
        attempt(failures, log, 'progress', 'reportInstrumentation', () =>
          deps.progress.reportInstrumentation(sessionId, installed),
        ),
      );
    };

    if (verdict === undefined || isErr(verdict)) {
      // Without a verdict nothing is confirmed, so nothing is shown as
      // enabled: the installer's gaps are still reported, as ✗ rows only.
      reportChecklist({ unavailable: ready.unavailable });

      if (verdict === undefined) {
        return err(collaboratorError(failures, planVersion, ready.applied.length));
      }

      log.error('Readiness could not be evaluated for the installed plan', {
        code: verdict.error.code,
        planVersion,
      });
      return err(withPlanVersions(verdict.error, { planVersion, activePlanVersion: planVersion }));
    }

    // The verdict judged the page as it is now — after the gate settled on a
    // report that was in flight, or on the reloaded document. When that is not
    // the page the runtime shares were judged against, they are asked again
    // before anything is confirmed, and the corrected report is announced
    // once, in place of the stale one.
    if (observedFactsDiffer(report.judged, verdict.value.observed)) {
      const changed = fold(
        await refreshShares(report, verdict.value.observed, request.signal, log),
        verdict.value.observed,
      );

      writeState();

      if (changed) {
        sendReady(
          failures,
          log,
          sessionId,
          ready,
          'The corrected signal report was rejected by the ready schema and not sent',
        );
      }
    }

    const armed = armedCaptureSignals(
      captureAgentHooks(config.agentHooks, plan.instrumentationTargets),
      config.serverSignals,
      runtimeHooks,
    );
    const confirmed = confirmedSignals(verdict.value, armed, ready.unavailable);
    // A signal held back only on the page gate — no tab bound yet, or the
    // bound tab's page not reported — is still listed in
    // `instrumentation.ready`, but shown neither as a degradation nor as ✗:
    // its checklist row waits, and turns ✓ in place once the page reports.
    const awaitingPage = new Set<CaptureSignal>(verdict.value.awaitingPageSignals ?? []);
    const rowGaps = rowGapsOf(ready.unavailable, report.shares, awaitingPage);
    const enabledLabels = labelsOfSignals(confirmed);
    const readiness = buildConfirmedReadiness(
      verdict.value,
      confirmed,
      rowGaps,
      clock,
      awaitingPage,
    );
    // The checklist below derives its ✓ labels — and so every ✗ row's
    // "Continuing with:" list — from `confirmed` alone (none of them is
    // withdrawn: `confirmedSignals` removed the installer's gaps, and the
    // aggregate readiness marks every confirmed signal available or degraded),
    // and its ✗ rows from the same per-label merge of the gaps and the
    // readiness report, so these sentences are byte for byte the messages of
    // its ✗ rows: one per label, the gate's verdict superseding an adapter's
    // own words for the same signal.
    const degradations = buildDegradationNotice(
      mergeUnavailableByLabel({ unavailable: rowGaps, readiness }),
      enabledLabels,
    );
    const waiting = waitingRowsOf(verdict.value, awaitingPage, new Set<string>(enabledLabels));

    emitChecklistRows(failures, log, sessionId, waiting, 'running');
    reportChecklist({ signals: confirmed, unavailable: rowGaps, readiness });

    report = { ...report, awaitingPage: [...awaitingPage], confirmed, waiting };
    writeState();

    if (verdict.value.satisfied) {
      noteProgress(
        log,
        'readyToCapture',
        attempt(failures, log, 'progress', 'readyToCapture', () =>
          deps.progress.readyToCapture(sessionId),
        ),
      );
    }

    // The page is still awaited: the report is corrected, and the newly
    // confirmed signals checked, when the bound tab's next document reports.
    if (awaitingPage.size > 0 && request.boundTab !== undefined) {
      startSignalWaiter(sessionId, false);
    }

    if (failures.length > 0) {
      return err(collaboratorError(failures, planVersion, ready.applied.length));
    }

    log.info('Instrumentation installed', {
      planVersion,
      delta: request.previousPlanVersion !== undefined,
      applied: ready.applied.length,
      runtimeHooks: ready.runtimeHooks.length,
      unavailableSignals: ready.unavailable.map((entry) => entry.signal),
      confirmedSignals: confirmed,
      awaitingPageSignals: [...awaitingPage],
      satisfied: verdict.value.satisfied,
    });

    return ok({
      sessionId,
      planVersion,
      activePlanVersion: planVersion,
      applied: ready.applied,
      runtimeHooks: ready.runtimeHooks,
      unavailable: ready.unavailable,
      agentHooks: config.agentHooks,
      serverSignals: config.serverSignals,
      readiness: verdict.value,
      degradations,
    });
  }

  /**
   * The failure branch: `instrumentation.failed` with the public projection of
   * the installer's error (see {@link toFailedError}) — never
   * `instrumentation.ready` — the instrument stage's `failed` row, and the
   * error returned with the plan version the session is left at. A failed delta
   * leaves the previous version active; the installer has already unwound what
   * the call applied.
   *
   * Both user-facing texts come from {@link toFailedError}: the fixed copy of
   * the code, and a hint only when it is proven product text, so the failed
   * row's `SessionFailure` carries nothing the installer copied from an
   * adapter or an exception.
   *
   * The preload gaps {@link withServiceRelaunchHint} named for this failure
   * come first, once, as the stage's ✗ rows — "Could not enable Server spans:
   * ‹reason›." and the other preload signals, each with the exact relaunch
   * command as its detail — so a plain dev server is reported as missing its
   * preload whichever signal the installer named (AAP §0.5.5). They are sent
   * whether or not this call emits the failed row, since a caller that emits
   * it does so after the install returns. Every text in them is product
   * authored.
   *
   * The error itself is kept for the local log only, under
   * {@link LOG_ERROR_FIELD_KEY} and the diagnostic reference the frame shows:
   * a `warn` record, written at the default levels, where the serializer emits
   * the closed error shape; and its `debug` twin with the same reference and
   * error, where the serializer adds the redacted message, hint and stack.
   *
   * A cancelled install ({@link isCancelledInstall}) takes
   * {@link cancelInstall} instead: it did not fail, so none of the above is
   * sent.
   */
  function failInstall(
    failures: CollaboratorFailure[],
    log: Logger,
    request: InstallRequest,
    checked: CheckedInstall,
    prior: SessionState | undefined,
    error: DebuggenError,
    preloadGaps: readonly UnavailableSignal[],
  ): Result<never, DebuggenError> {
    const { sessionId, plan } = checked;
    const planVersion = plan.planVersion;
    const activePlanVersion = request.previousPlanVersion ?? prior?.activePlanVersion;

    if (isCancelledInstall(error)) {
      return cancelInstall(failures, log, request, sessionId, error, {
        planVersion,
        activePlanVersion,
      });
    }

    const ref = newMessageId();
    const failed = toFailedError(error, ref);
    const payload = parseInstrumentationFailedPayload({ sessionId, error: failed });

    if (preloadGaps.length > 0) {
      noteProgress(
        log,
        'reportInstrumentation',
        attempt(failures, log, 'progress', 'reportInstrumentation', () =>
          deps.progress.reportInstrumentation(sessionId, { unavailable: preloadGaps }),
        ),
      );
    }

    if (isErr(payload)) {
      log.error('The failure report was rejected and not sent', { code: payload.error.code });
    } else {
      const value: InstrumentationFailedPayload = payload.value;
      sendToInterfaces(failures, log, sessionId, 'instrumentation.failed', () =>
        createEnvelope('instrumentation.failed', value, { ts: clock() }),
      );

      // Kept so a panel that binds later is told the latest install failed.
      if (!disposed) {
        failedReports.set(sessionId, value);
      }
    }

    if (request.reportStageFailure !== false) {
      const failure: SessionFailure = {
        stage: INSTRUMENT_STAGE,
        code: failed.code,
        message: failed.message,
        hint: failed.hint,
      };

      noteProgress(
        log,
        'stageFailed',
        attempt(failures, log, 'progress', 'stageFailed', () =>
          deps.progress.stageFailed(sessionId, failure),
        ),
      );
    }

    log.warn('The instrumentation install failed', {
      code: error.code,
      ref,
      planVersion,
      activePlanVersion,
      collaboratorFailures: failures.length,
      preloadGapSignals: preloadGaps.map((gap) => gap.signal),
      [LOG_ERROR_FIELD_KEY]: error,
    });
    log.debug('The diagnostic of a failed instrumentation install', {
      code: error.code,
      ref,
      [LOG_ERROR_FIELD_KEY]: error,
    });

    return err(withPlanVersions(error, { planVersion, activePlanVersion }));
  }

  /**
   * The cancellation branch of {@link failInstall}: an install whose signal
   * was aborted — for the pipeline, the session is being ended — did not
   * fail, and is not reported as failing (AAP §0.5.5 reserves
   * `instrumentation.failed` for an install that could enable nothing).
   *
   * - No `instrumentation.failed` is sent and no failure report is kept for a
   *   panel that binds later. The installer unwound what the call applied, so
   *   the service's record of the session stays as the previous install left
   *   it — including a report of an earlier failure, which still describes the
   *   latest install that ran to an outcome.
   * - No preload-gap ✗ row is emitted: a gap is a signal the capture proceeds
   *   without, and no capture proceeds from a cancelled install.
   * - With {@link InstallRequest.reportStageFailure} left on, the instrument
   *   stage is closed by its cancellation row
   *   (`buildStageCancelledRow(INSTRUMENT_STAGE, 'cancelled')`) instead of a
   *   `failed` row. The pipeline passes `false` and reports the cancellation
   *   itself, naming the session's end as its cause.
   *
   * Logged at `info` by code and plan versions only. The error — with its plan
   * versions, as {@link withPlanVersions} adds them — is returned, so the
   * caller still sees the cancellation (`details.reason: "aborted"`).
   */
  function cancelInstall(
    failures: CollaboratorFailure[],
    log: Logger,
    request: InstallRequest,
    sessionId: string,
    error: DebuggenError,
    versions: { readonly planVersion: number; readonly activePlanVersion: number | undefined },
  ): Result<never, DebuggenError> {
    if (request.reportStageFailure !== false) {
      noteProgress(
        log,
        'stageCancelled',
        attempt(failures, log, 'progress', 'stageCancelled', () =>
          deps.progress.emit(sessionId, buildStageCancelledRow(INSTRUMENT_STAGE, 'cancelled')),
        ),
      );
    }

    log.info('The instrumentation install was cancelled', {
      code: error.code,
      planVersion: versions.planVersion,
      activePlanVersion: versions.activePlanVersion,
      collaboratorFailures: failures.length,
    });

    return err(withPlanVersions(error, versions));
  }

  /** One install, from the stage header to the outcome. */
  async function runInstall(
    request: InstallRequest,
    checked: CheckedInstall,
  ): Promise<Result<InstrumentationOutcome, DebuggenError>> {
    const { sessionId, projectRoot, plan } = checked;
    const log = sessionLog(sessionId);
    const failures: CollaboratorFailure[] = [];
    /** The preload gaps an installer failure owes ✗ rows for; filled by `prepareInstall`. */
    const failedPreloadGaps: UnavailableSignal[] = [];
    const prior = sessions.get(sessionId);

    noteProgress(
      log,
      'stageStarted',
      attempt(failures, log, 'progress', 'stageStarted', () =>
        deps.progress.stageStarted(sessionId, INSTRUMENT_STAGE),
      ),
    );

    if (request.announcePlan !== false) {
      announcePlan(failures, log, sessionId, plan);
    }

    const failuresBeforeSuspend = failures.length;

    attempt(failures, log, 'watcher', 'suspend', () => {
      deps.watcher.suspend(sessionId);
    });

    let prepared: Result<PreparedInstall, DebuggenError>;

    if (failures.length > failuresBeforeSuspend) {
      // An unsuspended watcher would judge the installer's own writes as a
      // developer's edits, so nothing is installed without the suspension.
      prepared = err(
        new DebuggenError(
          'INTERNAL',
          'The conflict watcher could not be paused, so no instrumentation was installed.',
          {
            hint: 'Restart the Debug Generator service, then plan the instrumentation again.',
            details: { collaborator: 'watcher', step: 'suspend' },
          },
        ),
      );
    } else {
      try {
        prepared = await prepareInstall(request, checked, prior, log, failedPreloadGaps);
      } catch (thrown) {
        const error = DebuggenError.from(thrown, 'INTERNAL');
        log.error('Preparing or running the install threw', {
          code: error.code,
          ...exceptionFields(thrown),
        });
        prepared = err(error);
      }
    }

    await settleWatcher(failures, log, sessionId, projectRoot);

    if (isErr(prepared)) {
      return failInstall(failures, log, request, checked, prior, prepared.error, failedPreloadGaps);
    }

    return completeInstall(failures, log, request, checked, prior, prepared.value);
  }

  async function install(
    request: InstallRequest,
  ): Promise<Result<InstrumentationOutcome, DebuggenError>> {
    if (disposed) {
      return err(
        new DebuggenError('INTERNAL', 'The instrumentation service has been shut down.', {
          hint: 'Restart the Debug Generator service, then plan the instrumentation again.',
        }),
      );
    }

    const checked = checkInstallRequest(request);

    if (isErr(checked)) {
      serviceLog.warn('An install request was refused', { code: checked.error.code });
      return checked;
    }

    const { sessionId } = checked.value;

    if (inFlight.has(sessionId)) {
      return err(
        new DebuggenError(
          'SESSION_INVALID_STATE',
          'An instrumentation install is already running for this session.',
          {
            hint: 'Wait for the running install to finish, then try again.',
            details: { sessionId },
          },
        ),
      );
    }

    inFlight.add(sessionId);
    // A newer install supersedes the background refresh of the previous report.
    stopSignalWaiter(sessionId);

    try {
      return await runInstall(request, checked.value);
    } catch (thrown) {
      const error = DebuggenError.from(thrown, 'INTERNAL');
      serviceLog.error('An install ended with an unexpected throw', {
        code: error.code,
        ...exceptionFields(thrown),
      });
      return err(error);
    } finally {
      inFlight.delete(sessionId);
      refreshAfterBindDuringInstall(sessionId);
    }
  }

  /**
   * Re-judges, at once, the report an install just left when a bind named the
   * session's tab while that install ran: the install's verdict saw no tab (or
   * the previous one), and the refresh skips a session whose install is in
   * flight, so without this the report would wait for the next capture to be
   * corrected. Runs only once the install is no longer in flight.
   */
  function refreshAfterBindDuringInstall(sessionId: string): void {
    if (!boundDuringInstall.delete(sessionId) || disposed) {
      return;
    }

    const signals = sessions.get(sessionId)?.signals;

    if (signals !== undefined && hasRefreshableGap(signals) && knownTabs.has(sessionId)) {
      startSignalWaiter(sessionId, true);
    }
  }

  // -------------------------------------------------------------------------
  // Arming — the capture window
  // -------------------------------------------------------------------------

  /**
   * The page hooks a capture of the session's active plan version arms: the
   * installer's configuration, widened by the hooks of the plan's runtime
   * actions. A page-agent hook an adapter could not arm at install time — the
   * bound tab's agent had not reported yet, the usual order when the editor
   * creates the session before the panel binds its tab — is armed now. Arming
   * one edits no file, and a capture is admitted only after its readiness gate
   * has re-evaluated the bound tab.
   */
  function armedPageHooks(state: SessionState, config: ProducerConfig): AgentHookConfig {
    return unionAgentHooks(
      config.agentHooks,
      deriveAgentHookConfig(state.actions.filter((action) => action.mode === RUNTIME_ACTION_MODE)),
    );
  }

  /**
   * The error of an arm whose page frame no bound-tab connection took:
   * `TAB_NOT_BOUND` when no tab is bound, `TRANSPORT_DISCONNECTED` for every
   * other refusal, with the channel's own code as `details.reason`.
   */
  function pageUnreachableError(
    log: Logger,
    sessionId: string,
    captureId: string,
    channelCode: string | undefined,
  ): DebuggenError {
    const reason = channelCode ?? 'TRANSPORT_DISCONNECTED';
    const unbound = reason === 'TAB_NOT_BOUND';

    log.warn('The page agent could not be armed, so the capture was not armed', {
      [LOG_BINDING_KEYS.captureId]: captureId,
      reason,
    });

    return new DebuggenError(
      unbound ? 'TAB_NOT_BOUND' : 'TRANSPORT_DISCONNECTED',
      unbound
        ? 'No Chrome tab is bound to this session, so the page agent could not be armed.'
        : 'The DevTools connection of the session’s tab did not take the page-agent configuration, so the capture could not be armed.',
      {
        hint: PAGE_AGENT_UNREACHABLE_HINT,
        details: { sessionId, captureId, reason },
      },
    );
  }

  /**
   * Emits the AAP §0.5.5 ✗ rows for the server signals a capture proceeds
   * without because the preload could not be reached — one terminal `failed`
   * row per signal, once per capture, shaped as the checklist's ✗ rows
   * ({@link emitPreloadGapRows}) — skipping every signal the install already
   * reported unavailable. The "Continuing with" list keeps a signal the page
   * agent still collects (`fetch` is both a page hook and a preload signal),
   * so no other row claims the page's share is gone; like every such
   * sentence, a row never lists its own signal's label.
   */
  function reportPreloadGaps(
    log: Logger,
    sessionId: string,
    state: SessionState,
    config: ProducerConfig,
    agentHooks: AgentHookConfig,
    gaps: readonly UnavailableSignal[],
  ): void {
    const reported = new Set(state.ready.unavailable.map((entry) => entry.signal));
    const fresh = gaps.filter((gap) => !reported.has(gap.signal));

    if (fresh.length === 0) {
      return;
    }

    const withdrawn = [
      ...state.ready.unavailable,
      ...fresh.filter((gap) => !pageCollects(agentHooks, gap.signal)),
    ];
    // What the capture still proceeds with: the armed signals minus every one
    // withdrawn, labelled as the progress view's ✓ rows are.
    const gone = new Set<string>(withdrawn.map((entry) => entry.signal));
    const armed = armedCaptureSignals(agentHooks, config.serverSignals, state.runtimeHooks);
    const enabledLabels = labelsOfSignals(
      CAPTURE_SIGNALS.filter((signal) => armed.has(signal) && !gone.has(signal)),
    );

    emitPreloadGapRows(log, sessionId, fresh, enabledLabels);
  }

  function restoreArming(input: RestoreArmingInput): Result<ArmingSnapshot, DebuggenError> {
    if (!isNonBlankString(input.sessionId)) {
      return err(
        wiringError(
          'Arming state was requested without a session id.',
          'Pass the id of the session whose plan is being restored.',
          'sessionId',
        ),
      );
    }

    const projectRoot = normalizeProjectRoot(input.projectRoot);

    if (isErr(projectRoot)) {
      return projectRoot;
    }

    const parsed = parseInstrumentationPlan(input.plan);

    if (isErr(parsed)) {
      return parsed;
    }

    const plan = input.plan;

    if (plan.sessionId !== input.sessionId) {
      return err(
        wiringError(
          'Arming state was requested with a plan that belongs to a different session.',
          'Restore each session from its own stored plan.',
          'plan.sessionId',
        ),
      );
    }

    const existing = sessions.get(input.sessionId);

    if (
      existing !== undefined &&
      existing.projectRoot === projectRoot.value &&
      existing.activePlanVersion === plan.planVersion &&
      existing.configs.has(plan.planVersion)
    ) {
      return ok(snapshotOf(existing));
    }

    const configs = new Map<number, ProducerConfig>(
      existing !== undefined && existing.projectRoot === projectRoot.value ? existing.configs : [],
    );
    configs.set(plan.planVersion, deriveConfig(plan.instrumentationTargets));

    const state: SessionState = {
      sessionId: input.sessionId,
      projectRoot: projectRoot.value,
      activePlanVersion: plan.planVersion,
      actions: plan.instrumentationTargets,
      configs,
      ready: existing?.ready ?? EMPTY_READY,
      runtimeHooks: existing?.runtimeHooks ?? [],
      armedCaptureId: existing?.armedCaptureId,
    };

    sessions.set(input.sessionId, state);
    sessionLog(input.sessionId).info('Arming state recomputed from the stored plan', {
      planVersion: plan.planVersion,
    });

    return ok(snapshotOf(state));
  }

  function armCapture(request: ArmCaptureRequest): Result<ArmCaptureOutcome, DebuggenError> {
    const { sessionId, captureId } = request;

    if (!isNonBlankString(sessionId) || !isNonBlankString(captureId)) {
      return err(
        wiringError(
          'A capture was armed without a session id or a capture id.',
          'Pass the session id and the capture id the capture window opened with.',
          isNonBlankString(sessionId) ? 'captureId' : 'sessionId',
        ),
      );
    }

    let state = sessions.get(sessionId);

    if (state === undefined && request.plan !== undefined && request.projectRoot !== undefined) {
      const restored = restoreArming({
        sessionId,
        projectRoot: request.projectRoot,
        plan: request.plan,
      });

      if (isErr(restored)) {
        return restored;
      }

      state = sessions.get(sessionId);
    }

    const config = state?.configs.get(state.activePlanVersion);

    if (state === undefined || config === undefined) {
      return err(
        new DebuggenError(
          'SESSION_INVALID_STATE',
          'No installed instrumentation is known for this session, so there is nothing to arm.',
          {
            hint: 'Install the session’s plan before starting a capture, or pass its stored plan and project root.',
            details: { sessionId },
          },
        ),
      );
    }

    const log = sessionLog(sessionId);
    const owner = deps.captures?.captureOwnerForProject(state.projectRoot);

    if (owner !== undefined && owner.sessionId !== sessionId) {
      return err(
        new DebuggenError(
          'CAPTURE_ALREADY_ACTIVE',
          'Another session is capturing this project, so this capture cannot be armed.',
          {
            hint: 'Stop the other session’s capture, then start this one again.',
            details: { owningSessionId: owner.sessionId },
          },
        ),
      );
    }

    if (owner !== undefined && owner.captureId !== captureId) {
      return err(
        new DebuggenError(
          'SESSION_INVALID_STATE',
          'The capture being armed is not the capture window this session holds.',
          {
            hint: 'Arm the capture the session manager opened.',
            details: { sessionId },
          },
        ),
      );
    }

    const agentHooks = armedPageHooks(state, config);
    const pageRequired = enablesAnyPageHook(agentHooks);
    const serverRequired = collectsServerSignals(config.serverSignals);

    if (!pageRequired && !serverRequired) {
      log.warn('The capture enables no producer signal, so nothing was armed', {
        [LOG_BINDING_KEYS.captureId]: captureId,
        planVersion: state.activePlanVersion,
      });
      return err(
        new DebuggenError(
          'INSTRUMENTATION_UNAVAILABLE',
          'The session’s plan enables no page hook and no server signal, so a capture would collect nothing.',
          {
            hint: 'Plan the instrumentation again so it enables at least one signal, then start the capture.',
            details: { sessionId, captureId, planVersion: state.activePlanVersion },
          },
        ),
      );
    }

    let agentPayload: AgentConfigPayload | undefined;

    if (pageRequired) {
      const parsed = parseAgentConfigPayload({ sessionId, captureId, hooks: agentHooks });

      if (isErr(parsed)) {
        log.error('The page-agent configuration was rejected and not sent', {
          code: parsed.error.code,
        });
        return parsed;
      }

      agentPayload = parsed.value;
    }

    let serverPayload: ServerAgentConfigPayload | undefined;

    if (serverRequired) {
      const parsed = parseServerAgentConfigPayload({
        sessionId,
        captureId,
        signals: config.serverSignals,
      });

      if (isErr(parsed)) {
        log.error('The preload configuration was rejected and not sent', {
          code: parsed.error.code,
        });
        return parsed;
      }

      serverPayload = parsed.value;
    }

    // The page first: a capture whose page hooks cannot reach the page agent
    // is refused before the preload is told anything, so nothing is armed and
    // the caller can close the window it opened.
    let pageAgent: PageAgentDelivery = 'not-needed';

    if (agentPayload !== undefined) {
      const page = deliverPageConfig(log, sessionId, agentPayload);

      if (!page.delivered) {
        return err(pageUnreachableError(log, sessionId, captureId, page.code));
      }

      pageAgent = 'delivered';
    }

    let serverAgent: ServerAgentDelivery = 'not-needed';
    let serverCode: string | undefined;

    if (serverPayload !== undefined) {
      const server = deliverServerConfig(log, state.projectRoot, serverPayload);
      serverAgent = server.delivered ? 'delivered' : 'unreachable';
      serverCode = server.code;
    }

    if (serverAgent === 'unreachable' && pageAgent !== 'delivered') {
      log.warn(
        'No dev-server preload took the configuration and the plan collects nothing in the page; the capture was not armed',
        {
          [LOG_BINDING_KEYS.captureId]: captureId,
          ...(serverCode === undefined ? {} : { code: serverCode }),
        },
      );
      return err(
        new DebuggenError(
          'SERVER_AGENT_NOT_READY',
          'No dev-server preload is connected for this project, and the plan collects nothing in the page, so the capture could not be armed.',
          {
            hint: 'Launch the dev server from Debug Generator so its Node preload connects (a launch also replaces a dev server it started whose credential was rotated or revoked), then start the capture again.',
            details: { sessionId, captureId, reason: serverCode ?? 'SERVER_AGENT_NOT_READY' },
          },
        ),
      );
    }

    // The page is armed and the preload is not: the capture proceeds with what
    // it has and says what it lacks (AAP §0.5.5), once per capture however
    // often the tab re-binds; the preload is armed when it connects.
    const unavailable: readonly UnavailableSignal[] =
      serverAgent === 'unreachable' ? preloadGaps(config.serverSignals) : Object.freeze([]);
    const ledger = ledgerOf(sessionId, state.projectRoot);
    const reportGaps = unavailable.length > 0 && ledger.degradedCaptureId !== captureId;

    if (reportGaps) {
      reportPreloadGaps(log, sessionId, state, config, agentHooks, unavailable);
    }

    if (!disposed) {
      sessions.set(sessionId, { ...state, armedCaptureId: captureId });
    }

    writeLedger(sessionId, {
      ...ledger,
      projectRoot: state.projectRoot,
      ...(pageAgent === 'delivered'
        ? { pageArmedCaptureId: captureId, dormantCaptureId: undefined }
        : {}),
      ...(serverAgent === 'unreachable' ? { serverAwaitingCaptureId: captureId } : {}),
      ...(reportGaps ? { degradedCaptureId: captureId } : {}),
    });

    if (pageAgent === 'delivered') {
      // The page now follows this capture, so a dormant frame still owed for an
      // earlier one is moot.
      settlePendingPage(sessionId);
    }

    if (serverAgent === 'delivered') {
      // The preload serves the whole project and now follows this capture alone.
      settleServerForProject(state.projectRoot, { sessionId, captureId });
      recordServerArmed(state.projectRoot);
    }

    log.info('Capture armed', {
      [LOG_BINDING_KEYS.captureId]: captureId,
      planVersion: state.activePlanVersion,
      pageAgent,
      serverAgent,
      unavailableSignals: unavailable.map((entry) => entry.signal),
    });

    // The capture's own readiness gate has just judged the page. A report
    // still holding a gap the page could clear is re-judged in the background,
    // so the signals the capture arms are not left announced as unavailable.
    const signals = sessions.get(sessionId)?.signals;

    if (signals !== undefined && hasRefreshableGap(signals) && knownTabs.has(sessionId)) {
      startSignalWaiter(sessionId, true);
    }

    return ok({
      sessionId,
      captureId,
      planVersion: state.activePlanVersion,
      agentHooks,
      serverSignals: config.serverSignals,
      serverAgent,
      pageAgent,
      unavailable,
    });
  }

  function disarmCapture(
    request: DisarmCaptureRequest,
  ): Result<DisarmCaptureOutcome, DebuggenError> {
    const { sessionId } = request;

    if (!isNonBlankString(sessionId)) {
      return err(
        wiringError(
          'A capture was disarmed without a session id.',
          'Pass the id of the session whose capture ended.',
          'sessionId',
        ),
      );
    }

    const state = sessions.get(sessionId);
    const known = ledgers.get(sessionId)?.projectRoot ?? pending.get(sessionId)?.projectRoot;
    let projectRoot: string;

    if (state !== undefined) {
      projectRoot = state.projectRoot;
    } else if (request.projectRoot !== undefined) {
      const normalized = normalizeProjectRoot(request.projectRoot);

      if (isErr(normalized)) {
        return normalized;
      }

      projectRoot = normalized.value;
    } else if (known !== undefined) {
      // The session's plan state was released, but its producers are still
      // known to this process — which is exactly when a disarm matters.
      projectRoot = known;
    } else {
      return err(
        new DebuggenError(
          'SESSION_INVALID_STATE',
          'No instrumentation is known for this session, so the project to disarm is unknown.',
          {
            hint: 'Pass the session’s project root to disarm its producers.',
            details: { sessionId },
          },
        ),
      );
    }

    const log = sessionLog(sessionId);
    const captureId =
      request.captureId !== undefined && isNonBlankString(request.captureId)
        ? request.captureId
        : state?.armedCaptureId;
    const ledger = ledgerOf(sessionId, projectRoot);
    const owed = pending.get(sessionId);

    // The page agent. Its dormant frame is owed — and so becomes pending when
    // no bound-tab connection takes it — only if this process delivered an
    // armed configuration it has not since disarmed, or a disarm is already
    // owed; a page that was never armed is not waited for.
    let pageAgent: PageAgentDelivery;
    let pageOwed = owed?.pageCaptureId;

    if (captureId === undefined) {
      pageAgent = 'not-armed';
      log.info('No capture id is known, so the dormant page-agent configuration was not sent');
    } else if (deliverDormantPageConfig(log, sessionId, captureId).delivered) {
      pageAgent = 'delivered';
      pageOwed = undefined;
    } else {
      pageAgent = 'unreachable';

      if (ledger.pageArmedCaptureId !== undefined || pageOwed !== undefined) {
        pageOwed = captureId;
      }
    }

    // The preload serves the whole project: while another session holds the
    // project's capture, its configuration must stay in force.
    const owner = deps.captures?.captureOwnerForProject(projectRoot);
    const otherArmed = [...sessions.values()].some(
      (other) =>
        other.sessionId !== sessionId &&
        other.projectRoot === projectRoot &&
        other.armedCaptureId !== undefined,
    );
    let serverAgent: ServerAgentDelivery;

    if ((owner !== undefined && owner.sessionId !== sessionId) || otherArmed) {
      serverAgent = 'skipped-other-owner';
    } else if (deliverDisabledServerConfig(log, projectRoot).delivered) {
      serverAgent = 'delivered';
      // A disabled preload holds no session's capture, so every disarm the
      // project owed its preload is settled with this one.
      settleServerForProject(projectRoot, undefined);
    } else {
      serverAgent = 'unreachable';
    }

    // Re-read after the project-wide settlement, which may have rewritten both.
    const settledLedger = ledgerOf(sessionId, projectRoot);
    const serverOwed =
      (pending.get(sessionId)?.server ?? false) ||
      (serverAgent === 'unreachable' && settledLedger.serverArmedCaptureId !== undefined);
    const next: PendingDisarm = { projectRoot, pageCaptureId: pageOwed, server: serverOwed };
    const outstanding = producersOf(next);

    if (ledgers.has(sessionId) || pageAgent === 'delivered') {
      writeLedger(sessionId, {
        ...settledLedger,
        // The capture is over: nothing is replayed to arm it any more.
        serverAwaitingCaptureId: undefined,
        ...(pageAgent === 'delivered'
          ? { pageArmedCaptureId: undefined, dormantCaptureId: captureId }
          : {}),
      });
    }

    writePending(sessionId, next);

    if (state !== undefined && !disposed) {
      sessions.set(sessionId, { ...state, armedCaptureId: undefined });
    }

    const agentDisarmed = pageAgent === 'delivered';

    log.info('Capture disarmed', {
      ...(captureId === undefined ? {} : { [LOG_BINDING_KEYS.captureId]: captureId }),
      agentDisarmed,
      pageAgent,
      serverAgent,
      pending: outstanding,
    });

    if (outstanding.length > 0) {
      log.warn(
        'Producers still hold the capture configuration; their dormant configuration is replayed when they reconnect',
        { pending: outstanding, pageAgent, serverAgent },
      );
    }

    return ok({
      sessionId,
      ...(captureId === undefined ? {} : { captureId }),
      agentDisarmed,
      serverAgent,
      pageAgent,
      pending: outstanding,
    });
  }

  // -------------------------------------------------------------------------
  // Producer reconciliation — replay on reconnect, rebind and restart
  // -------------------------------------------------------------------------

  /**
   * Records that a session's page agent took its dormant configuration for
   * `captureId`: nothing is armed in the page any more, and an owed page disarm
   * is settled.
   */
  function recordDormantPage(sessionId: string, projectRoot: string, captureId: string): void {
    writeLedger(sessionId, {
      ...ledgerOf(sessionId, projectRoot),
      pageArmedCaptureId: undefined,
      dormantCaptureId: captureId,
    });
    settlePendingPage(sessionId);
  }

  /**
   * The capture that holds a project: the manager's answer when one is wired,
   * otherwise the session this service has armed on the project.
   */
  function captureOwnerOf(projectRoot: string): CaptureOwner | undefined {
    if (deps.captures !== undefined) {
      return deps.captures.captureOwnerForProject(projectRoot);
    }

    for (const state of sessions.values()) {
      if (state.projectRoot === projectRoot && state.armedCaptureId !== undefined) {
        return { sessionId: state.sessionId, captureId: state.armedCaptureId };
      }
    }

    return undefined;
  }

  /**
   * Whether the capture this service armed for a session is still the
   * project's open capture — so a reconnect never re-arms a window the manager
   * has already closed.
   */
  function isOpenCapture(state: SessionState, captureId: string): boolean {
    const owner = captureOwnerOf(state.projectRoot);
    return owner?.sessionId === state.sessionId && owner.captureId === captureId;
  }

  /** Notes that a project's preloads were just sent an armed configuration a connection took. */
  function recordServerArmed(projectRoot: string): void {
    if (!disposed) {
      serverArmedAt.set(projectRoot, clock());
    }
  }

  /**
   * Whether a preload of a project, whose credential was issued at
   * `credentialIssuedAt`, may still hold an arming it was never seen to drop:
   * its credential predates this service (an earlier process may have armed
   * it), or it existed when the project was last armed (it may have been armed
   * then and missed the capture-less configuration the others took), or this
   * service owes the project's preloads a disarm. A credential issued after all
   * of that has only ever been sent what this service would send it now.
   */
  function preloadMayHoldArmingFor(
    projectRoot: string,
    credentialIssuedAt: number | undefined,
  ): boolean {
    if (credentialIssuedAt === undefined || credentialIssuedAt < createdAt) {
      return true;
    }

    const armedAt = serverArmedAt.get(projectRoot);

    return (
      (armedAt !== undefined && credentialIssuedAt <= armedAt) || preloadMayHoldArming(projectRoot)
    );
  }

  /**
   * Whether this service armed a project's preload for a capture it has not
   * seen disarmed, or owes it a disarm: the two ways a preload this service
   * configured can still hold a capture.
   */
  function preloadMayHoldArming(projectRoot: string): boolean {
    for (const ledger of ledgers.values()) {
      if (
        ledger.projectRoot === projectRoot &&
        (ledger.serverArmedCaptureId !== undefined || ledger.serverAwaitingCaptureId !== undefined)
      ) {
        return true;
      }
    }

    for (const owed of pending.values()) {
      if (owed.projectRoot === projectRoot && owed.server) {
        return true;
      }
    }

    return false;
  }

  /**
   * A preload connected: re-arm it for the project's open capture, or disable
   * it when no capture needs it — which also settles every preload disarm the
   * project owed. With an open capture this service holds no arming for,
   * nothing is sent: a capture the manager says is open is never switched off.
   * Nor is anything sent to a preload that cannot hold an arming (see
   * {@link preloadMayHoldArmingFor}): it has nothing to disable.
   */
  function replayToServerAgent(
    rawProjectRoot: string | undefined,
    credentialIssuedAt: number | undefined,
  ): ProducerReplayOutcome {
    const normalized = normalizeProjectRoot(rawProjectRoot);

    if (isErr(normalized)) {
      serviceLog.debug('A preload connected without a usable project root; nothing was replayed');
      return { rearmed: [], disarmed: [], serverAgent: 'not-needed' };
    }

    const projectRoot = normalized.value;
    const owner = captureOwnerOf(projectRoot);

    if (owner !== undefined) {
      const log = sessionLog(owner.sessionId);
      const state = sessions.get(owner.sessionId);
      const config = state?.configs.get(state.activePlanVersion);

      if (
        state === undefined ||
        config === undefined ||
        state.projectRoot !== projectRoot ||
        state.armedCaptureId !== owner.captureId
      ) {
        log.warn(
          'A preload connected while a capture is open that this service holds no arming for; nothing was sent',
          { [LOG_BINDING_KEYS.captureId]: owner.captureId },
        );
        return { rearmed: [], disarmed: [], serverAgent: 'not-needed' };
      }

      if (collectsServerSignals(config.serverSignals)) {
        const armed = parseServerAgentConfigPayload({
          sessionId: owner.sessionId,
          captureId: owner.captureId,
          signals: config.serverSignals,
        });

        if (isErr(armed)) {
          log.error('The preload configuration was rejected and not replayed', {
            code: armed.error.code,
          });
          return { rearmed: [], disarmed: [], serverAgent: 'unreachable' };
        }

        const awaited = ledgers.get(owner.sessionId)?.serverAwaitingCaptureId === owner.captureId;

        if (!deliverServerConfig(log, projectRoot, armed.value).delivered) {
          return { rearmed: [], disarmed: [], serverAgent: 'unreachable' };
        }

        const settled = settleServerForProject(projectRoot, {
          sessionId: owner.sessionId,
          captureId: owner.captureId,
        });
        recordServerArmed(projectRoot);

        log.info('The reconnected preload was re-armed for the open capture', {
          [LOG_BINDING_KEYS.captureId]: owner.captureId,
          awaited,
          settledDisarms: settled.length,
        });

        return { rearmed: [owner.sessionId], disarmed: settled, serverAgent: 'delivered' };
      }
    }

    // No capture needs the preload — none is open, or the open one collects
    // nothing server-side — so it is disabled, whatever it last held. Only a
    // preload that cannot hold any arming — its credential was issued by this
    // service after the project was last armed, and nothing is owed — is sent
    // nothing.
    if (!preloadMayHoldArmingFor(projectRoot, credentialIssuedAt)) {
      serviceLog.debug('A preload connected that holds no capture; nothing was replayed');
      return { rearmed: [], disarmed: [], serverAgent: 'not-needed' };
    }

    if (!deliverDisabledServerConfig(serviceLog, projectRoot).delivered) {
      return { rearmed: [], disarmed: [], serverAgent: 'unreachable' };
    }

    const settled = settleServerForProject(projectRoot, undefined);

    serviceLog.info('The reconnected preload was sent its capture-less configuration', {
      settledDisarms: settled.length,
    });

    return { rearmed: [], disarmed: settled, serverAgent: 'delivered' };
  }

  /**
   * A DevTools connection registered: each session its bound tabs carry is
   * re-armed for its open capture, or sent the dormant configuration it is
   * owed.
   */
  function replayToPageAgents(sessionIds: readonly string[]): ProducerReplayOutcome {
    const rearmed: string[] = [];
    const disarmed: string[] = [];

    for (const sessionId of new Set(sessionIds)) {
      if (!isNonBlankString(sessionId)) {
        continue;
      }

      const log = sessionLog(sessionId);
      const state = sessions.get(sessionId);
      const config = state?.configs.get(state.activePlanVersion);
      const captureId = state?.armedCaptureId;

      if (state !== undefined && config !== undefined && captureId !== undefined) {
        const hooks = armedPageHooks(state, config);

        if (enablesAnyPageHook(hooks) && isOpenCapture(state, captureId)) {
          const armed = parseAgentConfigPayload({ sessionId, captureId, hooks });

          if (isErr(armed)) {
            log.error('The page-agent configuration was rejected and not replayed', {
              code: armed.error.code,
            });
          } else if (deliverPageConfig(log, sessionId, armed.value).delivered) {
            writeLedger(sessionId, {
              ...ledgerOf(sessionId, state.projectRoot),
              pageArmedCaptureId: captureId,
              dormantCaptureId: undefined,
            });
            settlePendingPage(sessionId);
            rearmed.push(sessionId);
            log.info('The reconnected page agent was re-armed for the open capture', {
              [LOG_BINDING_KEYS.captureId]: captureId,
            });
          }

          continue;
        }
      }

      const owed = pending.get(sessionId);

      if (owed?.pageCaptureId === undefined) {
        continue;
      }

      if (deliverDormantPageConfig(log, sessionId, owed.pageCaptureId).delivered) {
        recordDormantPage(sessionId, owed.projectRoot, owed.pageCaptureId);
        disarmed.push(sessionId);
        log.info('The reconnected page agent was sent the dormant configuration it was owed', {
          [LOG_BINDING_KEYS.captureId]: owed.pageCaptureId,
        });
      }
    }

    return { rearmed, disarmed, serverAgent: 'not-applicable' };
  }

  function producerConnected(connection: ProducerConnection): ProducerReplayOutcome {
    const kind = connection.kind;

    if (disposed) {
      return { rearmed: [], disarmed: [], serverAgent: 'not-applicable' };
    }

    try {
      if (kind === SERVER_AGENT_KIND) {
        return replayToServerAgent(connection.projectRoot, connection.credentialIssuedAt);
      }

      if (kind === DEVTOOLS_KIND) {
        return replayToPageAgents(connection.sessionIds ?? []);
      }
    } catch (thrown) {
      serviceLog.error('Replaying configuration to a reconnected producer threw', {
        kind,
        ...exceptionFields(thrown),
      });
      return {
        rearmed: [],
        disarmed: [],
        serverAgent: kind === SERVER_AGENT_KIND ? 'unreachable' : 'not-applicable',
      };
    }

    return { rearmed: [], disarmed: [], serverAgent: 'not-applicable' };
  }

  function reconcileBoundSession(
    request: BoundSessionReconcileRequest,
  ): Result<BoundSessionReconcileOutcome, DebuggenError> {
    const { sessionId } = request;

    if (!isNonBlankString(sessionId)) {
      return err(
        wiringError(
          'A bound tab was reconciled without a session id.',
          'Pass the id of the session the tab was bound to.',
          'sessionId',
        ),
      );
    }

    const projectRoot = normalizeProjectRoot(request.projectRoot);

    if (isErr(projectRoot)) {
      return projectRoot;
    }

    if (isNonBlankString(request.activeCaptureId)) {
      // The capture continues in the tab; re-arming it is the binding route's call.
      return ok('capture-active');
    }

    const log = sessionLog(sessionId);
    const owedCaptureId = pending.get(sessionId)?.pageCaptureId;
    const ledger = ledgers.get(sessionId);
    const lastCaptureId = isNonBlankString(request.lastCaptureId)
      ? request.lastCaptureId
      : undefined;
    // A capture this service saw open is answered by its own record: the page
    // holds it only while this service has it armed there. One opened by an
    // earlier process may still be armed in the page whatever this one knows.
    const openedHere =
      lastCaptureId !== undefined &&
      request.lastCaptureStartedAt !== undefined &&
      request.lastCaptureStartedAt >= createdAt;
    const captureId =
      owedCaptureId ?? ledger?.pageArmedCaptureId ?? (openedHere ? undefined : lastCaptureId);

    if (captureId === undefined) {
      return ok(
        openedHere && ledger?.dormantCaptureId === lastCaptureId
          ? 'already-dormant'
          : 'nothing-armed',
      );
    }

    if (
      owedCaptureId === undefined &&
      ledger?.dormantCaptureId === captureId &&
      ledger.pageArmedCaptureId === undefined
    ) {
      return ok('already-dormant');
    }

    if (deliverDormantPageConfig(log, sessionId, captureId).delivered) {
      recordDormantPage(sessionId, projectRoot.value, captureId);
      log.info('The bound tab’s page agent was returned to dormant', {
        [LOG_BINDING_KEYS.captureId]: captureId,
        owed: owedCaptureId !== undefined,
      });
      return ok('dormant-delivered');
    }

    log.warn('The bound tab’s page agent could not be sent its dormant configuration', {
      [LOG_BINDING_KEYS.captureId]: captureId,
      owed: owedCaptureId !== undefined,
    });
    return ok('dormant-unreachable');
  }

  function pageAgentReleased(sessionId: string): Result<PageAgentReleaseOutcome, DebuggenError> {
    if (!isNonBlankString(sessionId)) {
      return err(
        wiringError(
          'A released page agent was reported without a session id.',
          'Pass the id of the session whose tab was refused a re-bind.',
          'sessionId',
        ),
      );
    }

    const owed = pending.get(sessionId);

    if (owed?.pageCaptureId === undefined) {
      return ok('nothing-owed');
    }

    // Recorded as delivered: the refused tab's service worker returns its
    // page agent to dormant on the refusal (see the interface contract).
    recordDormantPage(sessionId, owed.projectRoot, owed.pageCaptureId);
    sessionLog(sessionId).info(
      'The owed page disarm was settled: the tab re-announcing the ended session was refused, and its worker returns the page agent to dormant',
      { [LOG_BINDING_KEYS.captureId]: owed.pageCaptureId },
    );
    return ok('settled');
  }

  /**
   * Which producers a plan arms for a capture: the page agent when any page
   * hook is enabled (the installer's configuration widened by the plan's
   * runtime actions, as {@link armedPageHooks} computes it), the preload when
   * any server signal is.
   */
  function producersArmedBy(plan: InstrumentationPlan): {
    readonly page: boolean;
    readonly server: boolean;
  } {
    const config = deriveConfig(plan.instrumentationTargets);
    const pageHooks = unionAgentHooks(
      config.agentHooks,
      deriveAgentHookConfig(
        plan.instrumentationTargets.filter((action) => action.mode === RUNTIME_ACTION_MODE),
      ),
    );

    return {
      page: enablesAnyPageHook(pageHooks),
      server: collectsServerSignals(config.serverSignals),
    };
  }

  function releaseInterruptedCapture(
    input: InterruptedCaptureInput,
  ): Result<DisarmCaptureOutcome, DebuggenError> {
    const { sessionId, captureId } = input;

    if (!isNonBlankString(sessionId) || !isNonBlankString(captureId)) {
      return err(
        wiringError(
          'An interrupted capture was released without a session id or a capture id.',
          'Pass the session id and the id of the capture window the restart ended.',
          isNonBlankString(sessionId) ? 'captureId' : 'sessionId',
        ),
      );
    }

    const projectRoot = normalizeProjectRoot(input.projectRoot);

    if (isErr(projectRoot)) {
      return projectRoot;
    }

    let armed = { page: true, server: true };

    if (input.plan !== undefined) {
      const parsed = parseInstrumentationPlan(input.plan);

      if (isErr(parsed)) {
        return parsed;
      }

      if (input.plan.sessionId !== sessionId) {
        return err(
          wiringError(
            'An interrupted capture was released with a plan that belongs to a different session.',
            'Release each capture with its own session’s stored plan.',
            'plan.sessionId',
          ),
        );
      }

      armed = producersArmedBy(input.plan);
    }

    // What the previous process armed is what the producers may still hold, so
    // the disarm below owes each of them its dormant configuration until a
    // connection takes it.
    writeLedger(sessionId, {
      ...ledgerOf(sessionId, projectRoot.value),
      projectRoot: projectRoot.value,
      ...(armed.page ? { pageArmedCaptureId: captureId, dormantCaptureId: undefined } : {}),
      ...(armed.server ? { serverArmedCaptureId: captureId } : {}),
    });

    sessionLog(sessionId).info(
      'A capture the restart ended is disarmed; producers that may still hold it are owed their dormant configuration',
      {
        [LOG_BINDING_KEYS.captureId]: captureId,
        planKnown: input.plan !== undefined,
        pageArmed: armed.page,
        serverArmed: armed.server,
      },
    );

    return disarmCapture({ sessionId, captureId, projectRoot: projectRoot.value });
  }

  function onDormancyConfirmed(listener: (sessionId: string) => void): () => void {
    if (!disposed) {
      dormancyListeners.add(listener);
    }

    return () => {
      dormancyListeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async function stopSession(sessionId: string): Promise<void> {
    const log = sessionLog(sessionId);

    try {
      await deps.watcher.stopSession(sessionId);
    } catch (thrown) {
      log.error('Stopping the conflict watcher for the session threw', exceptionFields(thrown));
    }

    watched.delete(sessionId);
    sessions.delete(sessionId);
    stopSignalWaiter(sessionId);
    failedReports.delete(sessionId);
    knownTabs.delete(sessionId);
    boundDuringInstall.delete(sessionId);

    // What the producers still hold is not this session's plan state: an armed
    // producer and an owed disarm are kept, so a later disarm or reconnect
    // still settles them. Only a ledger with nothing armed is let go.
    const ledger = ledgers.get(sessionId);

    if (
      ledger !== undefined &&
      ledger.pageArmedCaptureId === undefined &&
      ledger.serverArmedCaptureId === undefined &&
      ledger.serverAwaitingCaptureId === undefined
    ) {
      ledgers.delete(sessionId);
    }

    log.debug('Instrumentation state released for the session', {
      pending: producersOf(pending.get(sessionId)),
    });
  }

  async function dispose(): Promise<void> {
    if (disposed) {
      return;
    }

    disposed = true;

    try {
      await deps.watcher.stopAll();
    } catch (thrown) {
      serviceLog.error(
        'Stopping the conflict watcher threw during shutdown',
        exceptionFields(thrown),
      );
    }

    sessions.clear();
    watched.clear();
    reloadPrompts.clear();
    ledgers.clear();
    serverArmedAt.clear();
    pending.clear();
    dormancyListeners.clear();
    failedReports.clear();
    knownTabs.clear();
    boundDuringInstall.clear();

    for (const waiter of signalWaiters.values()) {
      waiter.abort();
    }

    signalWaiters.clear();
  }

  return {
    buildContext,
    install,
    armCapture,
    disarmCapture,
    restoreArming,
    arming: (sessionId) => {
      const state = sessions.get(sessionId);
      return state === undefined ? undefined : snapshotOf(state);
    },
    isInstalling: (sessionId) => inFlight.has(sessionId),
    stopSession,
    dispose,
    producerConnected,
    reconcileBoundSession,
    releaseInterruptedCapture,
    pageAgentReleased,
    pendingDisarms: (sessionId) => producersOf(pending.get(sessionId)),
    onDormancyConfirmed,
    replaySignalReport,
  };
}
