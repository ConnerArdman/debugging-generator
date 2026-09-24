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
 * - **Applies only the delta of a follow-up** (AAP §0.4.2): plan version
 *   *n + 1* is the previous plan plus additive actions; the additive ids are
 *   computed with the upstream `actionIdentityKey`, installed actions are never
 *   re-installed or removed, and the session's active plan version advances only
 *   once the delta install succeeds.
 * - **Maps the installer's result onto the wire without reshaping it**
 *   (AAP §0.4.2): `instrumentation.ready` carries `applied`, `runtimeHooks` and
 *   `unavailable` exactly as the installer returned them; `agent.config` and
 *   `server-agent.config` carry the installer's hook configuration and signal
 *   set; `instrumentation.failed` carries the installer's error.
 * - **Arms and disarms the two producers at capture time**
 *   ({@link InstrumentationService.armCapture},
 *   {@link InstrumentationService.disarmCapture}). `agent.config` requires a
 *   capture id, so arming belongs to the capture window; disarming sends the
 *   dormant page configuration and a preload configuration **without** a
 *   capture id, which is what makes the preload disable its instrumentations
 *   (AAP §0.5.1: runtime hooks are disabled, not merely idled).
 * - **Reports degradation honestly** (AAP §0.5.5): every unavailable signal is
 *   one sentence — "Could not enable ‹signal›: ‹reason›. Continuing with:
 *   ‹enabled list›." — emitted as a `running` progress row, never as a failure.
 *   The only failure is the installer's own `Err`, which is what "nothing at all
 *   could be enabled" means.
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
 * Log records carry ids, counts, plan versions, signal names and error codes —
 * never a diff, never file content, never a credential (AAP §0.5.2). The
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
  SERVER_AGENT_SIGNAL_KEYS,
  actionIdentityKey,
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
  normalizePosix,
  nowEpochMs,
  ok,
  toPosix,
  type Logger,
  type Result,
} from '@debuggen/shared';

import type { ServiceConfig } from '../config.js';
import { LOG_BINDING_KEYS } from '../logging.js';
import type { CaptureOwner, SessionBroadcaster } from '../sessions/manager.js';
import {
  CAPTURE_SIGNAL_LABELS,
  INSTRUMENTATION_ROW_ORDER,
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

/**
 * Who receives `agent.config`: the MAIN-world page agent, which owns no socket —
 * its frames travel under the bound tab's DevTools connection, which the client
 * registry resolves from this kind.
 */
const AGENT_CLIENT_KINDS: readonly ClientKind[] = Object.freeze(['agent'] as const);

/** The protocol bound on a progress row's message (`session.progress`). */
const MAX_PROGRESS_MESSAGE_LENGTH = 2000;

/** The protocol bound on a progress row's detail (`session.progress`). */
const MAX_PROGRESS_DETAIL_LENGTH = 4000;

/** The protocol bound on `instrumentation.failed`'s message. */
const MAX_FAILURE_MESSAGE_LENGTH = 2000;

/** The protocol bound on `instrumentation.failed`'s hint. */
const MAX_FAILURE_HINT_LENGTH = 1000;

/**
 * The next step `instrumentation.failed` carries when the installer's error
 * brought none. Protocol requires a hint on this message because it is the
 * developer's only route back from a failed install.
 */
export const DEFAULT_INSTALL_FAILURE_HINT =
  'Review the reason reported for each signal, fix the setup it names, then plan the instrumentation again.';

/**
 * The message `instrumentation.failed` carries when the installer's error
 * message cannot be sent as it stands (it was blank after normalisation).
 */
const FALLBACK_FAILURE_MESSAGE = 'Instrumentation could not be installed for this session.';

/** The enabled-list wording of a degradation notice when no label is enabled. */
const NOTHING_ELSE_ENABLED = 'the signals that remain available';

/** Punctuation stripped from the end of a reason before the sentence closes it. */
const TRAILING_PUNCTUATION_PATTERN = /[\s.!?;:,]+$/u;

/** Any run of whitespace, collapsed to one space in display text. */
const WHITESPACE_RUN_PATTERN = /\s+/gu;

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
  /** The service logger; this module binds `subsystem` and `sessionId` on it. */
  readonly logger: Logger;
  /**
   * The modification journal, handed to the installer as the context's journal
   * unchanged — the same object, never a wrapper.
   */
  readonly modifications: ModificationsRepo;
  /** The progress emitter both user interfaces render from. */
  readonly progress: SessionProgress;
  /** The session fan-out for the editor, DevTools and page-agent recipients. */
  readonly broadcaster: SessionBroadcaster;
  /** The single-recipient delivery for `server-agent.config`. */
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
  /** The plan version the context is for; its `planVersion` is stamped on the context. */
  readonly plan: InstrumentationPlan;
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

/** How a `server-agent.config` frame fared. */
export type ServerAgentDelivery =
  'delivered' | 'unreachable' | 'not-needed' | 'skipped-other-owner';

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
   * AAP §0.5.5), or `not-needed` (the plan collects nothing server-side, so the
   * preload is left disabled).
   */
  readonly serverAgent: ServerAgentDelivery;
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
  /** Whether the dormant `agent.config` was sent. */
  readonly agentDisarmed: boolean;
  /**
   * `delivered`, `unreachable`, or `skipped-other-owner` when another session
   * now holds the project's capture and its preload must stay armed.
   */
  readonly serverAgent: ServerAgentDelivery;
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
 * The labels of the signals a capture proceeds with, in the progress view's
 * display order: every signal the hook configuration, the signal set or a
 * runtime-hook entry enables, minus every signal reported unavailable.
 *
 * Read with the same rules the progress view's ✓ rows use — a runtime-hook entry
 * counts only when it is exactly a signal name or exactly a label — so the
 * degradation sentence and the checklist never disagree about what is enabled.
 */
function enabledSignalLabels(
  agentHooks: AgentHookConfig,
  serverSignals: ServerAgentSignals,
  runtimeHooks: readonly string[],
  unavailable: readonly UnavailableSignal[],
): readonly string[] {
  const withdrawn = new Set<string>(unavailable.map((entry) => entry.signal));
  const enabled = new Set<CaptureSignal>();
  const hookLabels = new Set<string>();

  for (const key of AGENT_HOOK_KEYS) {
    if (agentHooks[key]) {
      enabled.add(key);
    }
  }

  for (const key of SERVER_AGENT_SIGNAL_KEYS) {
    const value = serverSignals[key];

    if (value === true || (Array.isArray(value) && value.length > 0)) {
      enabled.add(key);
    }
  }

  for (const hook of runtimeHooks) {
    if (isCaptureSignal(hook)) {
      enabled.add(hook);
    } else {
      hookLabels.add(hook);
    }
  }

  const labels = new Set<string>();

  for (const signal of CAPTURE_SIGNALS) {
    const label = CAPTURE_SIGNAL_LABELS[signal];

    if (withdrawn.has(signal)) {
      continue;
    }

    if (enabled.has(signal) || hookLabels.has(label)) {
      labels.add(label);
    }
  }

  return INSTRUMENTATION_ROW_ORDER.filter((label) => labels.has(label));
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

/** Whether a preload signal set collects anything at all. */
function collectsServerSignals(signals: ServerAgentSignals): boolean {
  return SERVER_AGENT_SIGNAL_KEYS.some((key) => {
    const value = signals[key];
    return value === true || (Array.isArray(value) && value.length > 0);
  });
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
 * Projects an install error onto `instrumentation.failed`'s error shape:
 * `DebuggenError.toPayload()`'s code and message, and its hint — which protocol
 * requires on this message — or {@link DEFAULT_INSTALL_FAILURE_HINT} when the
 * error carried none. Both texts are made single-line and bounded.
 */
function toFailedError(error: DebuggenError): InstrumentationFailedPayload['error'] {
  const wire = error.toPayload();
  const message = clip(toDisplayLine(wire.message), MAX_FAILURE_MESSAGE_LENGTH);
  const hint = clip(toDisplayLine(wire.hint ?? ''), MAX_FAILURE_HINT_LENGTH);

  return {
    code: wire.code,
    message: message.length === 0 ? FALLBACK_FAILURE_MESSAGE : message,
    hint: hint.length === 0 ? DEFAULT_INSTALL_FAILURE_HINT : hint,
  };
}

/** The name of a thrown value, for a log record that must not carry its message. */
function thrownName(thrown: unknown): string {
  return thrown instanceof Error ? thrown.name : typeof thrown;
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

/** A collaborator that threw while this module was using it. Names only. */
interface CollaboratorFailure {
  readonly collaborator: string;
  readonly step: string;
  readonly errorName: string;
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
 * — per-session arming, the watched-session set, the in-flight set and the
 * reload-prompt ledger — lives in this closure.
 *
 * @param deps The injected collaborators.
 * @returns The service.
 *
 * @example
 * ```ts
 * const instrumentation = createInstrumentationService({
 *   config, logger, modifications, progress, broadcaster: clients,
 *   serverAgentChannel: clients, watcher, agents, serverAgents, captures: manager,
 * });
 *
 * const installed = await instrumentation.install({ sessionId, projectRoot, plan, code, boundTab });
 * if (installed.ok && installed.value.readiness.satisfied) {
 *   await manager.transitionTo(sessionId, 'ready', { readinessSatisfied: true });
 * }
 * ```
 */
export function createInstrumentationService(
  deps: InstrumentationServiceDeps,
): InstrumentationService {
  const clock = deps.now ?? nowEpochMs;
  const serviceLog = deps.logger.child({ [LOG_BINDING_KEYS.subsystem]: LOG_SUBSYSTEM });
  const adapters = deps.adapters ?? createAdapterRegistry({ logger: serviceLog });
  const installer = deps.installer ?? installPlan;

  const sessions = new Map<string, SessionState>();
  const watched = new Set<string>();
  const inFlight = new Set<string>();
  const reloadPrompts = new Set<string>();
  let disposed = false;

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
      const errorName = thrownName(thrown);
      failures.push({ collaborator, step, errorName });
      log.error('An instrumentation collaborator threw', { collaborator, step, errorName });
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
      const errorName = thrownName(thrown);
      failures.push({ collaborator, step, errorName });
      log.error('An instrumentation collaborator rejected', { collaborator, step, errorName });
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

  /** Delivers one `server-agent.config` frame to the project's preload connections. */
  function deliverToServerAgent(
    log: Logger,
    projectRoot: string,
    payload: ServerAgentConfigPayload,
  ): ServerAgentDelivery {
    try {
      const message = createEnvelope('server-agent.config', payload, { ts: clock() });
      const sent = deps.serverAgentChannel.sendToServerAgent(projectRoot, message);

      if (isErr(sent)) {
        log.info('No dev-server preload received the configuration', { code: sent.error.code });
        return 'unreachable';
      }

      return 'delivered';
    } catch (thrown) {
      log.error('Delivering the preload configuration threw', { errorName: thrownName(thrown) });
      return 'unreachable';
    }
  }

  /** The read-only view of one session's state. */
  function snapshotOf(state: SessionState): ArmingSnapshot {
    const config = state.configs.get(state.activePlanVersion);

    return {
      sessionId: state.sessionId,
      projectRoot: state.projectRoot,
      activePlanVersion: state.activePlanVersion,
      agentHooks: config?.agentHooks ?? DORMANT_AGENT_HOOK_CONFIG,
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
      logger.error('The session backup store could not be opened', { code: error.code });
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
   * The preparation half of an install: the readiness facts, the context, the
   * delta, and — unless the delta is empty — the installer's call.
   */
  async function prepareInstall(
    request: InstallRequest,
    checked: CheckedInstall,
    prior: SessionState | undefined,
    log: Logger,
  ): Promise<Result<PreparedInstall, DebuggenError>> {
    const { sessionId, projectRoot, plan } = checked;
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
      return installed;
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
        errorName: payload.error.code,
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
   * The success branch: records the session's state, broadcasts
   * `instrumentation.ready` with the installer's three fields as they are,
   * reports degradation and the checklist from what was actually armed, and
   * evaluates readiness.
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
        errorName: readyPayload.error.code,
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

    const enabledLabels = enabledSignalLabels(
      config.agentHooks,
      config.serverSignals,
      runtimeHooks,
      ready.unavailable,
    );
    const degradations = buildDegradationNotice(ready.unavailable, enabledLabels);

    emitDegradations(failures, log, sessionId, ready.unavailable, enabledLabels);

    const installed: InstalledSignals = {
      hooks: config.agentHooks,
      serverSignals: config.serverSignals,
      runtimeHooks,
      unavailable: ready.unavailable,
    };

    noteProgress(
      log,
      'reportInstrumentation',
      attempt(failures, log, 'progress', 'reportInstrumentation', () =>
        deps.progress.reportInstrumentation(sessionId, installed),
      ),
    );

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
          signal: request.signal,
        },
      ),
    );

    if (verdict === undefined) {
      return err(collaboratorError(failures, planVersion, ready.applied.length));
    }

    if (isErr(verdict)) {
      log.error('Readiness could not be evaluated for the installed plan', {
        code: verdict.error.code,
        planVersion,
      });
      return err(withPlanVersions(verdict.error, { planVersion, activePlanVersion: planVersion }));
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
   * The failure branch: `instrumentation.failed` with the installer's error —
   * never `instrumentation.ready` — the instrument stage's `failed` row, and the
   * error returned with the plan version the session is left at. A failed delta
   * leaves the previous version active; the installer has already unwound what
   * the call applied.
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
    const failed = toFailedError(error);
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
      planVersion,
      activePlanVersion,
      collaboratorFailures: failures.length,
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
          errorName: thrownName(thrown),
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
        errorName: thrownName(thrown),
      });
      return err(error);
    } finally {
      inFlight.delete(sessionId);
    }
  }

  // -------------------------------------------------------------------------
  // Arming — the capture window
  // -------------------------------------------------------------------------

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

    const agentPayload = parseAgentConfigPayload({
      sessionId,
      captureId,
      hooks: config.agentHooks,
    });

    if (isErr(agentPayload)) {
      log.error('The page-agent configuration was rejected and not sent', {
        code: agentPayload.error.code,
      });
      return agentPayload;
    }

    const collectsServer = collectsServerSignals(config.serverSignals);
    let serverPayload: ServerAgentConfigPayload | undefined;

    if (collectsServer) {
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

    try {
      const armed: AgentConfigPayload = agentPayload.value;
      deps.broadcaster.broadcastToKinds(
        sessionId,
        AGENT_CLIENT_KINDS,
        createEnvelope('agent.config', armed, { ts: clock() }),
      );
    } catch (thrown) {
      log.error('Sending the page-agent configuration threw', { errorName: thrownName(thrown) });
      return err(
        new DebuggenError('TRANSPORT_DISCONNECTED', 'The page agent could not be armed.', {
          hint: 'Reopen the Debug Generator panel for the page, then start the capture again.',
          details: { sessionId },
          cause: thrown,
        }),
      );
    }

    const serverAgent: ServerAgentDelivery =
      serverPayload === undefined
        ? 'not-needed'
        : deliverToServerAgent(log, state.projectRoot, serverPayload);

    if (!disposed) {
      sessions.set(sessionId, { ...state, armedCaptureId: captureId });
    }

    log.info('Capture armed', {
      [LOG_BINDING_KEYS.captureId]: captureId,
      planVersion: state.activePlanVersion,
      serverAgent,
    });

    return ok({
      sessionId,
      captureId,
      planVersion: state.activePlanVersion,
      agentHooks: config.agentHooks,
      serverSignals: config.serverSignals,
      serverAgent,
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
    let projectRoot: string;

    if (state !== undefined) {
      projectRoot = state.projectRoot;
    } else if (request.projectRoot !== undefined) {
      const normalized = normalizeProjectRoot(request.projectRoot);

      if (isErr(normalized)) {
        return normalized;
      }

      projectRoot = normalized.value;
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
    let agentDisarmed = false;

    if (captureId === undefined) {
      log.info('No capture id is known, so the dormant page-agent configuration was not sent');
    } else {
      const dormant = parseAgentConfigPayload({
        sessionId,
        captureId,
        hooks: DORMANT_AGENT_HOOK_CONFIG,
      });

      if (isErr(dormant)) {
        log.error('The dormant page-agent configuration was rejected and not sent', {
          code: dormant.error.code,
        });
      } else {
        try {
          const payload: AgentConfigPayload = dormant.value;
          deps.broadcaster.broadcastToKinds(
            sessionId,
            AGENT_CLIENT_KINDS,
            createEnvelope('agent.config', payload, { ts: clock() }),
          );
          agentDisarmed = true;
        } catch (thrown) {
          log.error('Sending the dormant page-agent configuration threw', {
            errorName: thrownName(thrown),
          });
        }
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
    } else {
      const disabled = parseServerAgentConfigPayload({ signals: DISABLED_SERVER_AGENT_SIGNALS });

      if (isErr(disabled)) {
        log.error('The capture-less preload configuration was rejected and not sent', {
          code: disabled.error.code,
        });
        serverAgent = 'unreachable';
      } else {
        serverAgent = deliverToServerAgent(log, projectRoot, disabled.value);
      }
    }

    if (state !== undefined && !disposed) {
      sessions.set(sessionId, { ...state, armedCaptureId: undefined });
    }

    log.info('Capture disarmed', {
      ...(captureId === undefined ? {} : { [LOG_BINDING_KEYS.captureId]: captureId }),
      agentDisarmed,
      serverAgent,
    });

    return ok({
      sessionId,
      ...(captureId === undefined ? {} : { captureId }),
      agentDisarmed,
      serverAgent,
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async function stopSession(sessionId: string): Promise<void> {
    const log = sessionLog(sessionId);

    try {
      await deps.watcher.stopSession(sessionId);
    } catch (thrown) {
      log.error('Stopping the conflict watcher for the session threw', {
        errorName: thrownName(thrown),
      });
    }

    watched.delete(sessionId);
    sessions.delete(sessionId);
    log.debug('Instrumentation state released for the session');
  }

  async function dispose(): Promise<void> {
    if (disposed) {
      return;
    }

    disposed = true;

    try {
      await deps.watcher.stopAll();
    } catch (thrown) {
      serviceLog.error('Stopping the conflict watcher threw during shutdown', {
        errorName: thrownName(thrown),
      });
    }

    sessions.clear();
    watched.clear();
    reloadPrompts.clear();
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
  };
}
