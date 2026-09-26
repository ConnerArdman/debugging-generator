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
 * - **Keeps the state root out of the project at the patch sink** (AAP §0.4.2):
 *   every install first re-checks, with `../config.ts`'s
 *   `requireProjectOutsideStateHome`, that its project root neither is,
 *   contains nor lies inside the canonical state root, and is refused
 *   `FS_UNSAFE_PATH` — reported as `instrumentation.failed` — before any backup
 *   or patch is written. The routes' checks run earlier; this one runs where
 *   the bytes are written, however late the pipeline gets there.
 * - **Applies only the delta of a follow-up** (AAP §0.4.2): plan version
 *   *n + 1* is the previous plan plus additive actions; the additive ids are
 *   computed with the upstream `actionIdentityKey`, installed actions are never
 *   re-installed or removed, and the session's active plan version advances only
 *   once the delta install succeeds.
 * - **Maps the installer's result onto the wire without reshaping it**
 *   (AAP §0.4.2): `instrumentation.ready` carries `applied`, `runtimeHooks` and
 *   `unavailable` exactly as the installer returned them; `agent.config` and
 *   `server-agent.config` carry the installer's hook configuration and signal
 *   set; `instrumentation.failed` carries the installer's error code, the
 *   stage's fixed public copy for that code and a diagnostic reference in
 *   place of the error's own message, and the error's hint only when it is
 *   proven product text — the dev-server detection's exact relaunch command
 *   standing in for an adapter's — else the code's default next step.
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
 * - **Reports degradation honestly** (AAP §0.5.5): every unavailable signal is
 *   one sentence — "Could not enable ‹signal›: ‹reason›. Continuing with:
 *   ‹enabled list›." — emitted as a `running` progress row, never as a failure.
 *   The only failure is the installer's own `Err`, which is what "nothing at all
 *   could be enabled" means.
 * - **Checks a row only once readiness confirms it** (AAP §0.5.5, prompt §11
 *   Step 8): readiness is evaluated before any checklist row is sent; a signal
 *   is shown ✓ — and named after "Continuing with:" — only when the capture
 *   arms it *and* the verdict found a producer that will deliver it, every
 *   other planned signal is shown ✗ with the verdict's reason and hint, and
 *   "Ready to capture" closes the group last, only for a satisfied verdict.
 *
 * ## What it never does
 *
 * - **It never touches a developer's file.** Bytes reach a working tree only
 *   through the patch layer of `@debuggen/instrumentation`, which the installer
 *   drives, and come back only through that package's cleanup. This module hands
 *   the installer a correct journal and backup store and then calls it; it
 *   performs no rollback of its own — the installer already reverse-restores the
 *   records of a call that failed part-way (AAP §0.5.1, §0.5.3).
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
  READINESS_HINT_MAX_LENGTH,
  READINESS_REASON_MAX_LENGTH,
  SERVER_AGENT_SIGNAL_KEYS,
  actionIdentityKey,
  buildReadiness,
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
import { PRELOAD_DEPENDENT_SIGNALS } from '../dev-server/detect.js';
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
  isProductAuthoredText,
  publicFailureCopy,
  type InstalledSignals,
  type ProgressRow,
  type SessionProgress,
} from '../sessions/progress.js';
import type { SessionFailure } from '../sessions/state-machine.js';
import type { ModificationsRepo } from '../store/modifications-repo.js';
import {
  collectReadinessEvidence,
  evaluateReadiness,
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
 * `buildDegradationNotice` builds around it.
 */
const PRELOAD_UNREACHABLE_REASON =
  'the dev-server preload is not connected, so this capture collects nothing on the server';

/** The next step of a server signal the arm could not reach, carried as the row's detail. */
const PRELOAD_UNREACHABLE_HINT =
  'Launch the dev server from Debug Generator so its Node preload connects; the capture picks the server signals up as soon as it does.';

/** The next step when the page agent could not be sent its capture configuration. */
const PAGE_AGENT_UNREACHABLE_HINT =
  'Open DevTools on the page with the Debug Generator panel so the tab is bound and connected, then start the capture again.';

/** The mode of an action installed as a runtime hook rather than a file patch. */
const RUNTIME_ACTION_MODE = 'runtime' as const satisfies InstrumentationAction['mode'];

/** The protocol bound on a progress row's message (`session.progress`). */
const MAX_PROGRESS_MESSAGE_LENGTH = 2000;

/** The protocol bound on a progress row's detail (`session.progress`). */
const MAX_PROGRESS_DETAIL_LENGTH = 4000;

/** The protocol bound on `instrumentation.failed`'s message. */
const MAX_FAILURE_MESSAGE_LENGTH = 2000;

/** The protocol bound on `instrumentation.failed`'s hint. */
const MAX_FAILURE_HINT_LENGTH = 1000;

/** The enabled-list wording of a degradation notice when no label is enabled. */
const NOTHING_ELSE_ENABLED = 'the signals that remain available';

/** Punctuation stripped from the end of a reason before the sentence closes it. */
const TRAILING_PUNCTUATION_PATTERN = /[\s.!?;:,]+$/u;

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
   * backup or a patch is written (AAP §0.4.2; see "The state root stays outside
   * every project" in `../config.ts`). `src/main.ts` passes the value it
   * resolved once at start-up, so every check of the running service compares
   * against one root. When absent, `config.debuggenHome` is canonicalised on the
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
  /** The relayed `agent.ready` reports, per tab. */
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
  /** The detector's own ports (fetch, file reads), forwarded unchanged. */
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
   * row. Default `true`. A caller that moves the session to `failed` through the
   * manager — which emits the same row as part of that transition — passes
   * `false`, so the row is not shown twice.
   */
  readonly reportStageFailure?: boolean | undefined;
  /** Whether the readiness gate may ask for a page reload. Default `true`. */
  readonly allowReloadPrompt?: boolean | undefined;
  /** Whether a missing preload blocks readiness when server signals are planned. Default `false`. */
  readonly requireServerAgent?: boolean | undefined;
  /** Cancels the install; the installer unwinds what the call applied. */
  readonly signal?: AbortSignal | undefined;
}

/** What a successful install left in place. Plain, JSON-serialisable data. */
export interface InstrumentationOutcome {
  /** The session instrumented. */
  readonly sessionId: string;
  /** The plan version this call installed. */
  readonly planVersion: number;
  /** The plan version now active for the session — equal to {@link planVersion} on success. */
  readonly activePlanVersion: number;
  /** The records this call applied, as the installer returned them. */
  readonly applied: readonly ModificationRecord[];
  /** The runtime hooks this call armed, as the installer returned them. */
  readonly runtimeHooks: readonly string[];
  /** The signals this call could not enable, as the installer returned them. */
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
  /** The degradation sentences emitted, one per unavailable signal. */
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
   * @returns The context, or `Err` for an empty session id or a relative or
   * empty project root.
   */
  buildContext(input: BuildContextInput): Result<InstrumentationContext, DebuggenError>;

  /**
   * Installs one plan version: a session's first install, or a follow-up's
   * delta install when {@link InstallRequest.previousPlanVersion} is given.
   *
   * @returns The outcome, or `Err` when the installer reported that nothing
   * could be enabled, when a delta failed part-way (the error's
   * `details.activePlanVersion` is the previous version), when another install
   * for the session is still running, or when a collaborator threw.
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

/**
 * The full driver {@link createInstrumentationService} returns: the service
 * surface every stage and route consumes, plus the producer reconciler that
 * the connection and binding layers drive.
 */
export type InstrumentationDriver = InstrumentationService & ProducerReconciler;

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
 * - **‹signal›** is the product's label from `CAPTURE_SIGNAL_LABELS` for one of
 *   the known capture signals, and the reported name for a signal a registered
 *   third-party adapter defined. No label is restated here.
 * - **‹reason›** is the adapter's reason verbatim, as one line, with trailing
 *   punctuation dropped so the sentence closes it once.
 * - **‹enabled list›** is `enabledLabels` joined in the order given.
 *
 * One sentence per entry, in input order; byte-identical sentences collapse
 * onto the first. The entry's `hint` — for a server-tier gap, the exact
 * relaunch command — is not part of the sentence: it travels as the progress
 * row's detail and in `instrumentation.ready`, verbatim.
 *
 * Pure: no clock, no logger, no I/O.
 *
 * @param unavailable The signals the installer could not enable.
 * @param enabledLabels The labels of the signals the capture proceeds with.
 * @returns The sentences, frozen.
 */
export function buildDegradationNotice(
  unavailable: readonly UnavailableSignal[],
  enabledLabels: readonly string[],
): readonly string[] {
  const enabled = enabledLabels.map(toDisplayLine).filter((label) => label.length > 0);
  const continuing = enabled.length === 0 ? NOTHING_ELSE_ENABLED : enabled.join(', ');
  const sentences: string[] = [];
  const seen = new Set<string>();

  for (const entry of unavailable) {
    const label = labelForSignal(entry.signal);

    if (label.length === 0) {
      continue;
    }

    const reason = toDisplayLine(entry.reason).replace(TRAILING_PUNCTUATION_PATTERN, '');
    const opening =
      reason.length === 0 ? `Could not enable ${label}.` : `Could not enable ${label}: ${reason}.`;
    const sentence = clip(
      `${opening} Continuing with: ${continuing}.`,
      MAX_PROGRESS_MESSAGE_LENGTH,
    );

    if (!seen.has(sentence)) {
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
 * Pure apart from reading `now` once.
 *
 * @param verdict The readiness verdict of the installed plan version.
 * @param confirmed The signals {@link confirmedSignals} kept.
 * @param unavailable The installer's unavailable signals.
 * @param now The clock `checkedAt` is read from.
 * @returns The report.
 */
function buildConfirmedReadiness(
  verdict: Pick<ReadinessVerdict, 'plannedSignals' | 'blocking' | 'degraded'>,
  confirmed: readonly CaptureSignal[],
  unavailable: readonly UnavailableSignal[],
  now: () => number,
): Readiness {
  const kept = new Set<CaptureSignal>(confirmed);
  const signals = verdict.plannedSignals.map((signal) => {
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
 *   {@link withServiceRelaunchHint}), or any other recovery step a product
 *   builder registered. Otherwise the code's default next step: an installer
 *   error's hint can be an adapter's own text — its failure's hint, or the
 *   hint of the gap it reported — which may quote a path, a statement or a URL.
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
 * Re-issues an installer error with the relaunch hint this service's own
 * dev-server detection composed, when that is the recovery the developer needs
 * and the error's own hint is not proven product text (AAP §0.5.5: if the dev
 * server was not started with the preload, the hint carries the exact relaunch
 * command).
 *
 * The installer's "nothing could be enabled" failure (`INSTRUMENTATION_UNAVAILABLE`)
 * names its most actionable blocked signal in `details.blockedSignal` and
 * carries that gap's hint, which for a preload-dependent signal is the
 * adapter's own relaunch text — never registered, so {@link toFailedError}
 * would replace it with fixed copy and the exact command would be lost. When
 * the blocked signal depends on the preload and the detection collected for
 * this install found the preload missing, the detection's `relaunchHint` —
 * registered by `../dev-server/detect.ts` when it composed it — takes its
 * place. The code, message and details are kept, and the original error is the
 * cause, so the local diagnostic still holds what the installer said.
 *
 * Returns `error` itself in every other case, including a hint that is
 * already proven and a detection whose hint this process did not compose.
 *
 * @param error The installer's error.
 * @param devServer The dev-server detection readiness collected, if it ran.
 * @returns The error to report.
 */
function withServiceRelaunchHint(
  error: DebuggenError,
  devServer: ReadinessEvidence['devServer'],
): DebuggenError {
  const blockedSignal = error.details?.['blockedSignal'];

  if (
    error.code !== 'INSTRUMENTATION_UNAVAILABLE' ||
    isProductAuthoredText(error.hint) ||
    devServer === undefined ||
    devServer.preloadAttached ||
    !isProductAuthoredText(devServer.relaunchHint) ||
    !PRELOAD_DEPENDENT_SIGNALS.some((signal) => signal === blockedSignal)
  ) {
    return error;
  }

  return new DebuggenError(error.code, error.message, {
    hint: devServer.relaunchHint,
    ...(error.details === undefined ? {} : { details: error.details }),
    cause: error,
  });
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

/** The three `instrumentation.ready` fields of the latest install. */
interface ReadyFields {
  readonly applied: readonly ModificationRecord[];
  readonly runtimeHooks: readonly string[];
  readonly unavailable: readonly UnavailableSignal[];
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
  /** The latest install's `instrumentation.ready` fields. */
  readonly ready: ReadyFields;
  /** Every runtime hook armed across the session's installed plan versions. */
  readonly runtimeHooks: readonly string[];
  /** The capture currently armed, when one is. */
  readonly armedCaptureId?: string | undefined;
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
   * the state root (AAP §0.4.2; CWE-200), re-checked on every install at the
   * sink itself: the session and dev-server routes check before a session
   * exists, but the pipeline installs later and asynchronously, and a folder
   * can be replaced by a link into the state root in between. Runs before
   * anything is read for the install, so a refused install writes no backup,
   * no journal record and no patch.
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
   * The preparation half of an install: the state-root separation check, the
   * readiness facts, the context, the delta, and — unless the delta is empty —
   * the installer's call. A refused separation check ends the install here,
   * through {@link failInstall} like every other preparation failure.
   */
  async function prepareInstall(
    request: InstallRequest,
    checked: CheckedInstall,
    prior: SessionState | undefined,
    log: Logger,
  ): Promise<Result<PreparedInstall, DebuggenError>> {
    const { sessionId, projectRoot, plan } = checked;
    // Logged by `failInstall`, whose record carries the error's closed shape
    // (its code and constant details) and never a path.
    const apart = await requireStateHomeApart(projectRoot);

    if (isErr(apart)) {
      return apart;
    }

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

    const context = buildContext({
      sessionId,
      projectRoot,
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
    });

    if (isErr(installed)) {
      return err(withServiceRelaunchHint(installed.error, evidence.value.devServer));
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
   * Emits one `running` row per degradation sentence, the signal's hint — the
   * exact relaunch command, for a server-tier gap — as its detail, verbatim.
   */
  function emitDegradations(
    failures: CollaboratorFailure[],
    log: Logger,
    sessionId: string,
    unavailable: readonly UnavailableSignal[],
    enabledLabels: readonly string[],
  ): void {
    const emitted = new Set<string>();

    for (const entry of unavailable) {
      const [message] = buildDegradationNotice([entry], enabledLabels);

      if (message === undefined) {
        continue;
      }

      const detail = clip(toDisplayLine(entry.hint), MAX_PROGRESS_DETAIL_LENGTH);
      const key = `${message}\n${detail}`;

      if (emitted.has(key)) {
        continue;
      }

      emitted.add(key);

      const row: ProgressRow = {
        stage: INSTRUMENT_STAGE,
        status: 'running',
        message,
        ...(detail.length === 0 ? {} : { detail }),
      };

      noteProgress(
        log,
        'degradation',
        attempt(failures, log, 'progress', 'degradation', () => deps.progress.emit(sessionId, row)),
      );
    }
  }

  /**
   * The `instrumentation.ready` fields of an empty delta, which installs
   * nothing: the session's current state — the records the journal holds as
   * applied, and the hooks and gaps the previous install reported.
   */
  async function currentReady(
    failures: CollaboratorFailure[],
    log: Logger,
    sessionId: string,
    prior: SessionState | undefined,
    previousPlanVersion: number,
  ): Promise<ReadyFields> {
    const known = prior?.activePlanVersion === previousPlanVersion ? prior.ready : EMPTY_READY;
    const runtimeHooks = prior?.runtimeHooks ?? known.runtimeHooks;
    const listed = await attemptAsync(failures, log, 'modifications', 'listBySession', () =>
      deps.modifications.listBySession(sessionId),
    );

    if (listed === undefined || isErr(listed)) {
      if (listed !== undefined) {
        log.warn('The journal could not be read; re-announcing the last known records', {
          code: listed.error.code,
        });
      }

      return { applied: known.applied, runtimeHooks, unavailable: known.unavailable };
    }

    return {
      applied: listed.value.filter((record) => record.status === 'applied'),
      runtimeHooks,
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
   * The success branch, in the order the progress view must read (AAP §0.5.5,
   * prompt §11 Step 8):
   *
   * 1. Records the session's state and broadcasts `instrumentation.ready` with
   *    the installer's three fields as they are.
   * 2. Evaluates readiness **first**, with `announceReady: false`, so "Ready to
   *    capture" cannot precede the rows it closes. A reload request the gate
   *    emits is the only row that may come before the checklist.
   * 3. Confirms the checklist: a signal is enabled only when the capture arms
   *    it ({@link captureAgentHooks}, {@link armedCaptureSignals}) and the
   *    verdict found it deliverable without blocking on it, minus the
   *    installer's unavailable signals ({@link confirmedSignals}).
   * 4. Emits one degradation row per unavailable signal, naming only the
   *    confirmed signals after "Continuing with:".
   * 5. Reports the checklist as the confirmed signals, the installer's
   *    unavailable entries and an aggregate readiness report
   *    ({@link buildConfirmedReadiness}) — never as the requested hook
   *    configuration, signal set or runtime hooks, whose label rule would
   *    re-add a ✓ for a signal readiness withdrew (a `Database tracing`
   *    runtime hook with no connected preload).
   * 6. Emits "Ready to capture" once, last, and only for a satisfied verdict.
   *
   * When readiness cannot be evaluated — a collaborator threw, or it answered
   * `Err` — nothing is presented as enabled: the degradation rows name no
   * signal, the checklist carries only the installer's ✗ rows, no ready row is
   * emitted, and the error is returned.
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
      ready = await currentReady(failures, log, sessionId, prior, previousPlanVersion);
      runtimeHooks = ready.runtimeHooks;
    }

    if (!disposed) {
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
        armedCaptureId: prior?.armedCaptureId,
      });
    }

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
      log.error('The installer result was rejected by the ready schema and not sent', {
        code: readyPayload.error.code,
      });
    } else {
      const payload: InstrumentationReadyPayload = readyPayload.value;
      sendToInterfaces(failures, log, sessionId, 'instrumentation.ready', () =>
        createEnvelope('instrumentation.ready', payload, { ts: clock() }),
      );
    }

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
      emitDegradations(failures, log, sessionId, ready.unavailable, []);
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

    const armed = armedCaptureSignals(
      captureAgentHooks(config.agentHooks, plan.instrumentationTargets),
      config.serverSignals,
      runtimeHooks,
    );
    const confirmed = confirmedSignals(verdict.value, armed, ready.unavailable);
    const enabledLabels = labelsOfSignals(confirmed);
    const degradations = buildDegradationNotice(ready.unavailable, enabledLabels);

    emitDegradations(failures, log, sessionId, ready.unavailable, enabledLabels);
    reportChecklist({
      signals: confirmed,
      unavailable: ready.unavailable,
      readiness: buildConfirmedReadiness(verdict.value, confirmed, ready.unavailable, clock),
    });

    if (verdict.value.satisfied) {
      noteProgress(
        log,
        'readyToCapture',
        attempt(failures, log, 'progress', 'readyToCapture', () =>
          deps.progress.readyToCapture(sessionId),
        ),
      );
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
   * The error itself is kept for the local log only, under
   * {@link LOG_ERROR_FIELD_KEY} and the diagnostic reference the frame shows:
   * a `warn` record, written at the default levels, where the serializer emits
   * the closed error shape; and its `debug` twin with the same reference and
   * error, where the serializer adds the redacted message, hint and stack.
   */
  function failInstall(
    failures: CollaboratorFailure[],
    log: Logger,
    request: InstallRequest,
    checked: CheckedInstall,
    prior: SessionState | undefined,
    error: DebuggenError,
  ): Result<never, DebuggenError> {
    const { sessionId, plan } = checked;
    const planVersion = plan.planVersion;
    const activePlanVersion = request.previousPlanVersion ?? prior?.activePlanVersion;
    const ref = newMessageId();
    const failed = toFailedError(error, ref);
    const payload = parseInstrumentationFailedPayload({ sessionId, error: failed });

    if (isErr(payload)) {
      log.error('The failure report was rejected and not sent', { code: payload.error.code });
    } else {
      const value: InstrumentationFailedPayload = payload.value;
      sendToInterfaces(failures, log, sessionId, 'instrumentation.failed', () =>
        createEnvelope('instrumentation.failed', value, { ts: clock() }),
      );
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
      [LOG_ERROR_FIELD_KEY]: error,
    });
    log.debug('The diagnostic of a failed instrumentation install', {
      code: error.code,
      ref,
      [LOG_ERROR_FIELD_KEY]: error,
    });

    return err(withPlanVersions(error, { planVersion, activePlanVersion }));
  }

  /** One install, from the stage header to the outcome. */
  async function runInstall(
    request: InstallRequest,
    checked: CheckedInstall,
  ): Promise<Result<InstrumentationOutcome, DebuggenError>> {
    const { sessionId, projectRoot, plan } = checked;
    const log = sessionLog(sessionId);
    const failures: CollaboratorFailure[] = [];
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
        prepared = await prepareInstall(request, checked, prior, log);
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
      return failInstall(failures, log, request, checked, prior, prepared.error);
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
   * Emits the AAP §0.5.5 rows for the server signals a capture proceeds
   * without because the preload could not be reached, skipping every signal
   * the install already reported unavailable. The "Continuing with" list keeps
   * a signal the page agent still collects (`fetch` is both a page hook and a
   * preload signal), so it never claims the page's share is gone.
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

    emitDegradations([], log, sessionId, fresh, enabledLabels);
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
            hint: 'Launch the dev server from Debug Generator so its Node preload connects, then start the capture again.',
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
    pendingDisarms: (sessionId) => producersOf(pending.get(sessionId)),
    onDormancyConfirmed,
  };
}
