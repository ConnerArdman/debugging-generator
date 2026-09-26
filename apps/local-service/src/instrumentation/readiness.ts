/**
 * The service-side **readiness gate**: the one module that decides whether a
 * session may enter `ready` — "Ready to capture" — and the one that collects
 * the observed facts every instrumentation adapter reads its own readiness
 * from.
 *
 * Authority: AAP §0.7.1 Group 2 (readiness requires a relayed `agent.ready`
 * for the bound tab's current document with `installedBeforeReact = true`,
 * otherwise `session.progress` asks for a one-click reload), §0.4.2 (the
 * adapter registry: "`readiness` gates the 'Ready to capture' state"), §0.5.5
 * (graceful degradation, and the exact relaunch command when the dev server
 * runs without the preload) and §0.8.1 slice 9.
 *
 * ## Two questions, two functions
 *
 * - {@link collectObservedReadiness} answers "what has the service actually
 *   seen?" It reads the relayed `agent.ready` for the bound tab, the
 *   `server-agent` presence for the project and — when server signals may be
 *   needed and no preload is connected — the dev-server detection, and returns
 *   the upstream `ObservedReadinessInputs` that
 *   `./service.ts` places on the `InstrumentationContext`. Nothing in it is
 *   inferred: an absent report is recorded as absent, never as a report with
 *   false flags. {@link collectReadinessEvidence} is the same collection with
 *   the dev-server detection and the notes kept alongside, for a caller that
 *   wants the exact relaunch command as well.
 * - {@link evaluateReadiness} answers "may the developer reproduce the problem
 *   now?" It derives the signals a plan needs through the upstream
 *   derivations, asks every adapter that claims the plan's action types for its
 *   own readiness report, adds the session-level preconditions no adapter can
 *   see — a bound tab, a page agent for its current document, that agent
 *   installed before React and the page loaded — and returns a
 *   {@link ReadinessVerdict} whose `satisfied` flag feeds the state machine's
 *   `instrumenting → ready` guard.
 *
 * ## What blocks, and what merely degrades
 *
 * `satisfied` is load-bearing: a wrong `true` lets a session claim readiness
 * it does not have, and a wrong `false` strands the developer. The line is the
 * one AAP §0.5.5 draws — capture proceeds with the signals that are available —
 * plus the session-level gate AAP §0.7.1 states for the page:
 *
 * | Condition | Effect | Remediation |
 * | --- | --- | --- |
 * | browser signals planned, no bound tab | blocking | `bind-tab` |
 * | browser signals planned, no `agent.ready` for the current document | blocking | `reload-page` |
 * | browser signals planned, the current document's agent installed late (`installedBeforeReact = false`: after React loaded, or after the page began loading) | blocking, for every browser signal | `reload-page` (with the document id) |
 * | no planned signal deliverable at all | blocking | whatever the gaps name |
 * | server signals planned, no `server-agent` for the project | degraded | `relaunch-dev-server` |
 * | React signals planned, agent installed in time, no React on the page | degraded | — |
 * | any adapter-reported gap, including a stale preload heartbeat | degraded | the adapter's hint |
 * | an adapter's readiness probe throws or answers an invalid report | its signals `unavailable`: degraded when another adapter confirms them, else not deliverable | the failure's hint |
 *
 * An adapter-reported gap degrades only while some adapter still establishes
 * the signal. A probe that fails establishes nothing, so it can never be the
 * reason a signal counts as deliverable; when no other adapter vouches for any
 * planned signal, the "no planned signal deliverable" row applies and the
 * session does not become ready (AAP §0.5.5: capture proceeds with the signals
 * that are *available*, and a failure is never presented as success).
 *
 * A stale heartbeat is judged by the adapters that depend on the preload: this
 * module hands them `lastHeartbeatAt` and they apply their own staleness
 * windows, so there is one judgement per signal rather than two that could
 * disagree. A caller that wants the stricter reading of AAP §0.7.1 — no ready
 * state until the preload connects whenever server signals are planned — sets
 * {@link EvaluateReadinessRequest.requireServerAgent}.
 *
 * ## The current document
 *
 * The page gate judges the bound tab's *current* document, and the registry
 * cannot say which that is: the relaying layer replaces a tab's report only
 * when a new document's `agent.ready` arrives, and a navigation by itself
 * clears nothing. What does follow every committed same-origin navigation is
 * the binding — the binding route mirrors the new URL onto the session
 * record's `boundTab`, which is what this module receives, and the capture
 * stage re-evaluates readiness at capture start with the fresh record. So
 * {@link evaluateReadiness} is the "before capture" check, and it judges
 * currency itself:
 *
 * | The report, against the binding | Judgement |
 * | --- | --- |
 * | same origin and path (query and fragment ignored), or either URL unreadable, and no navigation recorded after it was received | current, used at once |
 * | another path — or the same one, with a navigation recorded after it was received ({@link BrowserAgentRegistry.latestNavigationAt}: a reload, a load of the same URL) — and a new document for the bound origin reports within {@link EvaluateReadinessDeps.navigationSettleMs} | replaced: the new document's facts are judged |
 * | as above, and a new document reports from another origin | no page agent for the current document |
 * | as above, and nothing new reports within the bound | a same-document navigation: the report is kept |
 *
 * A mismatch alone never blocks. `tab.navigated` carries no document id, and a
 * history-API navigation moves the binding's URL within one document whose
 * agent never announces itself again; only a replacement document that
 * actually reports supersedes the stored one. Telling a replacement that never
 * reports apart from a history-API navigation needs the navigation's own
 * document identity, which no port carries today. The wait is bounded
 * ({@link DEFAULT_NAVIGATION_SETTLE_MS}, at most
 * {@link MAX_NAVIGATION_SETTLE_MS}, `0` for none), skipped for an already
 * aborted request, and backstopped like the reload wait. The collection
 * functions never wait: they record the report as observed, with a note when
 * it is not trusted on sight.
 *
 * ## The one-click reload
 *
 * When the page gate fails, the verdict asks for a reload: one `running`
 * progress row carrying {@link RELOAD_REQUEST_MESSAGE}, at most once per
 * document, followed by a bounded wait for the next `agent.ready` and exactly
 * one re-evaluation. The Chrome service worker performs the actual
 * `chrome.tabs.reload` on the developer's consent; this module only asks. A
 * wait that times out leaves the remediation in the verdict and the session
 * where it was — never failed, never blocked forever.
 *
 * ## Boundaries
 *
 * - **It writes nothing** — not to the developer's project, not to
 *   `$DEBUGGEN_HOME`, not to the database — and spawns nothing: launching a dev
 *   server is `../dev-server/launcher.ts`'s job, reached by the pipeline and
 *   the routes, never from here. The one state it touches is
 *   `../sessions/progress.ts`'s bounded, in-memory product-text registry: the
 *   fixed wording it places in a gap entry is registered there as it is used,
 *   so a failure surface can prove it is the product's (CWE-209).
 * - **It restates no vocabulary.** Signal names, readiness statuses, progress
 *   stages, error codes, signal labels, the "Ready to capture" wording and the
 *   relaunch command are all imported from the module that owns them.
 *   {@link RELOAD_REQUEST_MESSAGE} and the short explanations of the three
 *   session-level gates are the only developer-facing prose defined here,
 *   because no other module observes those preconditions.
 * - **It knows no adapter.** Adapters are discovered through the injected
 *   registry; no concrete adapter is imported and no branch reads an adapter
 *   id, so adding an adapter changes nothing here (AAP §0.4.2).
 * - **It knows no project.** Nothing here names a file, component, function or
 *   route of any application, and nothing reads the developer's question
 *   (AAP §0.5.4).
 * - **It is side-effect free at load time**: no environment read, no console,
 *   no timer, no global. Every collaborator is injected.
 * - **It logs no page-supplied identifier.** A relayed `agent.ready` is shaped
 *   by the page, so its `documentId` is page-controlled text: the verdict, the
 *   reload ledger and the "different document" comparison keep it as is, and
 *   every log line carries only `./document-fingerprint.ts`'s `document`
 *   fingerprint and `documentIdCanonical` flag in its place (CWE-532,
 *   AAP §0.5.2).
 *
 * `./service.ts` imports this module; this module imports neither it nor
 * `./watcher.ts`, which keeps the folder's dependency direction one-way. Its
 * only import from this folder is the leaf `./document-fingerprint.ts`.
 *
 * @module
 */

import { PACKAGE_MANAGERS } from '@debuggen/code-analysis';
import {
  BROWSER_CAPTURE_SIGNALS,
  CAPTURE_SIGNALS,
  READINESS_REASON_MAX_LENGTH,
  SERVER_CAPTURE_SIGNALS,
  buildReadiness,
  deriveAgentHookConfig,
  deriveServerAgentSignals,
  isCaptureSignal,
  parseReadiness,
  type AdapterRegistry,
  type CaptureSignal,
  type InstrumentationAction,
  type InstrumentationActionType,
  type InstrumentationAdapter,
  type InstrumentationContext,
  type InstrumentationPlan,
  type ObservedBrowserAgent,
  type ObservedReadinessInputs,
  type ObservedServerAgent,
  type Readiness,
  type ReadinessSignal,
  type ReadinessStatus,
  type UnavailableSignal,
} from '@debuggen/instrumentation';
import type {
  AgentReadyPayload,
  BoundTab,
  ProgressStage,
  ProgressStatus,
} from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  isAbsolutePosix,
  isErr,
  isWindowsAbsolute,
  noopLogger,
  normalizePosix,
  nowEpochMs,
  ok,
  toPosix,
  type LogFields,
  type Logger,
  type Result,
} from '@debuggen/shared';

import type { ServiceConfig } from '../config.js';
import {
  buildPreloadUnavailableSignals,
  buildRelaunchHint,
  detectDevServer,
  formatRelaunchCommand,
  type DevServerDetectDeps,
  type DevServerDetection,
  type PackageManagerId,
  type RelaunchCommandInput,
  type ServerAgentPresence,
} from '../dev-server/detect.js';
import type {
  DevServerLauncher,
  LaunchedDevServer,
  LaunchedDevServerStatus,
} from '../dev-server/launcher.js';
import {
  LOG_BINDING_KEYS,
  LOG_ERROR_FIELD_KEY,
  describeException,
  guardLogger,
} from '../logging.js';
import { authorProductText, type SessionProgress } from '../sessions/progress.js';
import { documentLogFields } from './document-fingerprint.js';

// ---------------------------------------------------------------------------
// Section A — constants
// ---------------------------------------------------------------------------

/**
 * The reload request a developer sees when the page cannot be observed yet.
 *
 * The only sentence of its kind in the product: it is the `message` of the one
 * `running` progress row this module emits for the `instrument` stage, and the
 * `hint` of the blocking signals a reload would unblock. The editor view and
 * the DevTools panel render it verbatim; the panel's one-click reload is the
 * Chrome service worker's `chrome.tabs.reload`, performed on the developer's
 * consent (AAP §0.5.5, §0.7.1 Group 2).
 */
export const RELOAD_REQUEST_MESSAGE =
  'Reload the page so the Debug Generator hook is in place before React loads.';

/**
 * How long {@link evaluateReadiness} waits for the next `agent.ready` after
 * asking for a reload, in milliseconds, when the caller injects nothing else.
 *
 * The wait covers the developer reading the request and clicking, and a dev
 * server recompiling the route on the reload — so it is longer than the
 * service worker's own twenty-second wait for a reload already consented to.
 * It is bounded all the same: a developer who walks away finds the reload
 * still listed as the remediation, never a session that hangs.
 */
export const DEFAULT_RELOAD_WAIT_MS = 60_000;

/** The ceiling an injected {@link EvaluateReadinessDeps.reloadWaitMs} is clamped to. */
export const MAX_RELOAD_WAIT_MS = 300_000;

/**
 * How long {@link evaluateReadiness} waits, in milliseconds, for the document
 * that replaced a page-agent report the binding has moved away from, when the
 * caller injects nothing else (see "The current document" in the module
 * overview).
 *
 * A full navigation's new document announces itself as soon as its agent has
 * installed at `document_start` and the service worker has relayed it — well
 * inside this window on a local dev server. A history-API navigation keeps its
 * document and announces nothing, so this is also the delay such a navigation
 * adds to one evaluation: short enough not to be noticed, long enough for a
 * relay to arrive.
 */
export const DEFAULT_NAVIGATION_SETTLE_MS = 1_500;

/** The ceiling an injected {@link EvaluateReadinessDeps.navigationSettleMs} is clamped to. */
export const MAX_NAVIGATION_SETTLE_MS = 10_000;

/**
 * Grace added to this module's own backstop timer around
 * {@link BrowserAgentRegistry.waitForAgentReady}.
 *
 * The port is required to resolve on its own timeout; the backstop exists so a
 * port that forgot to still cannot make the wait unbounded. It fires only after
 * the port's deadline has already passed, so a correct port always wins.
 */
const WAIT_BACKSTOP_GRACE_MS = 250;

/** The `subsystem` binding every log line of this module carries. */
const LOG_SUBSYSTEM = 'instrumentation';

/** The progress stage the reload request is reported under. */
const INSTRUMENT_STAGE: ProgressStage = 'instrument';

/** The progress status of the reload request: the stage is still working. */
const RUNNING_STATUS: ProgressStatus = 'running';

/** The readiness status of a signal that will not be collected at all. */
const UNAVAILABLE_STATUS: ReadinessStatus = 'unavailable';

/** The readiness status of a signal collected with a stated limitation. */
const DEGRADED_STATUS: ReadinessStatus = 'degraded';

/**
 * The signals that exist only through the page agent's React fiber hook.
 *
 * `react` is the hook itself; `state` is recorded while a commit is walked and
 * `componentTree` is taken from the retained fiber root, so neither exists
 * without it (see `AGENT_HOOKS_BY_ACTION_TYPE` in the instrumentation schema).
 * These are the signals a page without React cannot deliver, so the
 * `react-absent` degradation applies to them alone; AAP §0.7.1 Group 2's
 * `installedBeforeReact` gate applies to every planned browser signal. Checked
 * against the imported vocabulary with `satisfies`, so a renamed signal is a
 * compile error here.
 */
const FIBER_HOOK_SIGNALS: ReadonlySet<CaptureSignal> = new Set([
  'react',
  'state',
  'componentTree',
] as const satisfies readonly CaptureSignal[]);

/**
 * The launch states in which a launched dev server is (or is about to be)
 * serving with the preload attached.
 */
const LIVE_LAUNCH_STATUSES: ReadonlySet<LaunchedDevServerStatus> = new Set([
  'starting',
  'ready',
] as const satisfies readonly LaunchedDevServerStatus[]);

/** The package managers a relaunch command can be formed for, widened for membership tests. */
const KNOWN_PACKAGE_MANAGERS: readonly string[] = PACKAGE_MANAGERS;

/**
 * The explanations of the session-level gates.
 *
 * These preconditions are observed by no adapter — an adapter sees the page
 * agent's report, never the binding that makes a tab this session's — so their
 * wording belongs here. Each `reason` is a fragment that reads after "Could not
 * enable ‹signal›: " (AAP §0.5.5) and each `hint` names one action. The reload
 * gates' hint is {@link RELOAD_REQUEST_MESSAGE} itself.
 *
 * The late-install gate has two wordings for one fact (`installedBeforeReact`
 * false): `hookLate` for a document where the agent found React, `agentLate`
 * for one without React, where there is no React to have been late for — only
 * an agent that started after the page had begun loading.
 *
 * Every text here is registered with `authorProductText` where it is placed in
 * a gap entry ({@link gateWording}), not once at load time: the registry
 * forgets its least recently used texts, and registering on use keeps the
 * wording in use proven. The capture gate quotes a registered reason or hint
 * verbatim in its refusal and replaces anything unproven with fixed copy.
 */
const GATE_WORDING = Object.freeze({
  noTab: Object.freeze({
    reason: 'no Chrome tab is bound to this session',
    hint: 'Open the application in Chrome and open the "Debug Generator" panel in its DevTools.',
  }),
  noAgent: Object.freeze({
    reason: "no page agent has reported from the bound tab's current page",
    hint: RELOAD_REQUEST_MESSAGE,
  }),
  hookLate: Object.freeze({
    reason: 'the React hook was installed after the page had already loaded React',
    hint: RELOAD_REQUEST_MESSAGE,
  }),
  agentLate: Object.freeze({
    reason: 'the page agent was installed after the page had already started loading',
    hint: RELOAD_REQUEST_MESSAGE,
  }),
  reactAbsent: Object.freeze({
    reason: "the page agent found no React on the bound tab's current page",
    hint: 'Navigate the bound tab to a page of the application that renders React, then capture again.',
  }),
  adapterFailed: Object.freeze({
    hint: 'Capture proceeds with the signals that are available; check the service log, then evaluate readiness again.',
  }),
  invalidReport: Object.freeze({
    reason: 'the adapter returned a readiness report that does not match the readiness schema',
  }),
});

// ---------------------------------------------------------------------------
// Section B — injected ports
// ---------------------------------------------------------------------------

/**
 * Options of {@link BrowserAgentRegistry.waitForAgentReady}.
 *
 * Every member is optional; `| undefined` is spelled out so a caller may pass
 * a key it has no value for under `exactOptionalPropertyTypes`.
 */
export interface WaitForAgentReadyOptions {
  /** How long to wait, in milliseconds, before resolving `undefined`. */
  readonly timeoutMs?: number | undefined;

  /** Abandons the wait early; the promise then resolves `undefined`. */
  readonly signal?: AbortSignal | undefined;

  /**
   * The document the caller already knows about. Only an `agent.ready` whose
   * `documentId` differs from it resolves the wait — which is what makes "the
   * page was reloaded" observable rather than a replay of the old report.
   */
  readonly afterDocumentId?: string | undefined;
}

/**
 * The relayed page-agent facts, per tab — the consumer-declared port this
 * module reads browser readiness through.
 *
 * Satisfied structurally by the service's client registry
 * (`../server/clients.ts`), which receives every `agent.ready` the Chrome
 * service worker relays under a tab's connection (AAP §0.4.2). Declared here,
 * where it is consumed, following the precedent of `ServerAgentPresence` in
 * `../dev-server/detect.ts`, so this module builds and tests without the
 * transport layer.
 */
export interface BrowserAgentRegistry {
  /**
   * The newest relayed `agent.ready` for `tabId`; absent when no page agent has
   * reported from the tab.
   *
   * The relaying layer replaces the stored report when a new document's
   * `agent.ready` arrives. A navigation does not replace or clear it, so the
   * report returned may describe a document the tab has since left; this
   * module judges currency against the binding's URL (see "The current
   * document" in the module overview) rather than trusting the port to know.
   */
  latestAgentReady(tabId: number): AgentReadyPayload | undefined;

  /**
   * Resolves with the next `agent.ready` for `tabId` whose `documentId` differs
   * from `options.afterDocumentId`, or `undefined` on timeout or abort.
   *
   * Never rejects for a timeout. This module additionally races the promise
   * against its own backstop timer, so an implementation that ignores
   * `timeoutMs` still cannot make a readiness evaluation unbounded.
   */
  waitForAgentReady(
    tabId: number,
    options: WaitForAgentReadyOptions,
  ): Promise<AgentReadyPayload | undefined>;

  /**
   * When the report {@link latestAgentReady} returns was received, in epoch
   * milliseconds. Optional: without it the report is stamped with the time it
   * was read, which an adapter's staleness window then measures from.
   */
  latestAgentReadyAt?(tabId: number): number | undefined;

  /**
   * When the binding last recorded a committed navigation of `tabId`, in epoch
   * milliseconds — every same-origin `tab.navigated` the binding keeps,
   * including a reload and a navigation that leaves the URL unchanged, which
   * the binding's URL alone cannot show. Optional: without it, readiness can
   * tell that a report may be stale only from the binding's URL.
   *
   * Compared with the report's receipt time ({@link latestAgentReadyAt}): a
   * report received before the latest navigation describes a document the tab
   * may have left, so it is not trusted on sight (see "The current document" in
   * the module overview).
   */
  latestNavigationAt?(tabId: number): number | undefined;
}

/**
 * A snapshot of the live `server-agent` connection for a project: whether it
 * is up and when it last spoke.
 *
 * Structurally satisfied by the client registry's `RegisteredClient`, whose
 * `online` and `lastSeenAt` are exactly these facts. `lastSeenAt` becomes
 * `ObservedServerAgent.lastHeartbeatAt`, which is what lets the preload-bound
 * adapters apply their own heartbeat-staleness windows.
 */
export interface ServerAgentSnapshot {
  /** Whether the connection is up now. */
  readonly online: boolean;

  /** When the connection last delivered a frame, in epoch milliseconds. */
  readonly lastSeenAt?: number | undefined;

  /** When the connection was opened, in epoch milliseconds. */
  readonly connectedAt?: number | undefined;

  /** The project root the connection's credential is scoped to. */
  readonly projectRoot?: string | undefined;
}

/**
 * The `server-agent` evidence this module reads: the upstream presence port,
 * optionally extended with a snapshot of the connection.
 *
 * `hasServerAgentForProject` is the authority on whether the preload is
 * connected — the same answer `../dev-server/detect.ts` relies on. The
 * optional `serverAgentForProject` adds when it last spoke; the client
 * registry answers it with a `Result`, `SERVER_AGENT_NOT_READY` when none is
 * connected.
 */
export interface ServerAgentReadinessSource extends ServerAgentPresence {
  /** The most recent live connection for the project, when the source can describe one. */
  serverAgentForProject?(projectRoot: string): Result<ServerAgentSnapshot, DebuggenError>;
}

/**
 * Remembers which documents the developer has already been asked to reload,
 * so the request is emitted at most once per document.
 *
 * A `Set<string>` satisfies it. Held by the caller — one per service process —
 * because {@link evaluateReadiness} is a function of its inputs and keeps no
 * state of its own between calls.
 */
export interface ReloadPromptLedger {
  /** Whether the key was recorded. */
  has(key: string): boolean;

  /** Records the key. The return value is ignored. */
  add(key: string): unknown;
}

// ---------------------------------------------------------------------------
// Section C — the verdict
// ---------------------------------------------------------------------------

/**
 * One thing the developer can do to move a session towards "Ready to
 * capture", discriminated on `kind`.
 *
 * - `bind-tab` — browser signals are planned but no Chrome tab is bound to the
 *   session: open the application and the "Debug Generator" DevTools panel.
 * - `reload-page` — the bound tab's current document cannot be observed: no
 *   page agent has reported for it, or its agent was installed late
 *   (`installedBeforeReact` false — its React hook arrived after React, or the
 *   agent after the page began loading). `documentId` names the document to
 *   replace when one is known.
 * - `relaunch-dev-server` — server signals are planned but no preload is
 *   connected for the project. `command` and `hint` are the dev-server
 *   detection's `relaunchCommand` and `relaunchHint`, verbatim, so every
 *   surface shows the same exact command (AAP §0.5.5).
 */
export type ReadinessRemediation =
  | { readonly kind: 'bind-tab' }
  | { readonly kind: 'reload-page'; readonly tabId: number; readonly documentId?: string }
  | {
      readonly kind: 'relaunch-dev-server';
      readonly projectRoot: string;
      readonly command: string;
      readonly hint: string;
    };

/** One of the {@link ReadinessRemediation} kinds. */
export type ReadinessRemediationKind = ReadinessRemediation['kind'];

/** One adapter's readiness report, as the verdict carries it. */
export interface ReadinessAdapterReport {
  /** The id of the adapter that was asked. */
  readonly adapterId: string;

  /**
   * Its report — validated against the readiness schema. For an adapter whose
   * probe rejected or answered something invalid, a report built here with an
   * `'unavailable'` row per signal it covers, carrying the failure's reason: an
   * unverified probe establishes nothing, so such a signal is deliverable only
   * when another adapter's row confirms it.
   */
  readonly readiness: Readiness;
}

/**
 * The answer to "may this session enter `ready`?", with everything a surface
 * needs to explain it.
 *
 * Plain JSON data: no class instance, no function, no `undefined`-valued key.
 * It can be logged, persisted and sent as it is.
 */
export interface ReadinessVerdict {
  /**
   * Whether the session may enter `ready`: no blocking condition holds and at
   * least one planned signal is deliverable. The value the state machine's
   * `readinessSatisfied` guard reads.
   */
  readonly satisfied: boolean;

  /** Every adapter that was asked, in registry order, with its report. */
  readonly perAdapter: readonly ReadinessAdapterReport[];

  /** The gaps that hold the session back, one per signal. */
  readonly blocking: readonly UnavailableSignal[];

  /** The gaps the capture proceeds without, one per signal (AAP §0.5.5). */
  readonly degraded: readonly UnavailableSignal[];

  /** What the developer can do, at most one per kind, in the order above. */
  readonly remediations: readonly ReadinessRemediation[];

  /** Every signal the plan needs, in capture-signal vocabulary order. */
  readonly plannedSignals: readonly CaptureSignal[];

  /** The planned signals that will actually be collected, in the same order. */
  readonly deliverableSignals: readonly CaptureSignal[];

  /** When the verdict was reached, in epoch milliseconds. */
  readonly evaluatedAt: number;

  /**
   * The observed facts the final evaluation read — after a reload, the new
   * document's report. A caller rebuilding its context for the capture uses
   * these rather than the facts it started with.
   */
  readonly observed: ObservedReadinessInputs;

  /** Whether this evaluation emitted the reload request. */
  readonly reloadRequested: boolean;
}

// ---------------------------------------------------------------------------
// Section D — collection: dependencies, request and evidence
// ---------------------------------------------------------------------------

/**
 * The detection collaborators {@link collectReadinessEvidence} forwards to
 * `detectDevServer` — everything except what this module supplies itself.
 */
export type ReadinessDetectDeps = Omit<
  DevServerDetectDeps,
  'config' | 'logger' | 'serverAgents' | 'now'
>;

/** Collaborators of {@link collectObservedReadiness}; all of them injected. */
export interface CollectObservedReadinessDeps {
  /** Whether a preload is connected for a project, and optionally when it last spoke. */
  readonly serverAgents: ServerAgentReadinessSource;

  /** The relayed page-agent reports. */
  readonly agents: BrowserAgentRegistry;

  /**
   * The dev servers this service launched, read only through `list()`: a live
   * launch for the project supplies the URL detection probes.
   */
  readonly devServers?: Pick<DevServerLauncher, 'list'> | undefined;

  /** The detection function; injectable so a suite needs no network or filesystem. */
  readonly detect?: typeof detectDevServer | undefined;

  /** Further detection collaborators — the resolved preload path, a fetch stub, a manifest reader. */
  readonly detectDeps?: ReadinessDetectDeps | undefined;

  /** The service's address, which the relaunch command's ingest URL is rendered from. */
  readonly config: Pick<ServiceConfig, 'host' | 'port'>;

  /** Parent logger; lines are bound to `subsystem: "instrumentation"` and the session. */
  readonly logger?: Logger | undefined;

  /** Clock in epoch milliseconds. Default `nowEpochMs`. */
  readonly now?: (() => number) | undefined;
}

/** What {@link collectObservedReadiness} is asked about. */
export interface CollectObservedReadinessRequest {
  /** The session the facts are collected for. */
  readonly sessionId: string;

  /** Absolute path of the project being debugged. */
  readonly projectRoot: string;

  /** The tab bound to the session, when one is. */
  readonly boundTab?: BoundTab | undefined;

  /**
   * The plan the facts are for, when one exists. A plan that needs no server
   * signal spares the dev-server detection entirely.
   */
  readonly plan?: InstrumentationPlan | undefined;

  /** The session's dev-server URL, which detection probes when it is known. */
  readonly devServerUrl?: string | undefined;

  /** Skips the remaining steps once aborted; collected facts are still returned. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Everything {@link collectReadinessEvidence} learned: the upstream observed
 * inputs, plus what no adapter reads but a remediation needs.
 */
export interface ReadinessEvidence {
  /** The facts `./service.ts` places on `InstrumentationContext.readiness`. */
  readonly observed: ObservedReadinessInputs;

  /**
   * The dev-server detection, when it ran — the source of the exact relaunch
   * command {@link evaluateReadiness} puts in a `relaunch-dev-server`
   * remediation.
   */
  readonly devServer?: DevServerDetection;

  /** A live dev server this service launched for the project, when there is one. */
  readonly launchedDevServer?: LaunchedDevServer;

  /** One line per degraded collection step, in the order they occurred. */
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------
// Section E — evaluation: dependencies and request
// ---------------------------------------------------------------------------

/** Collaborators of {@link evaluateReadiness}; all of them injected. */
export interface EvaluateReadinessDeps {
  /** The adapters to ask, discovered by claim — never by id. */
  readonly adapters: Pick<AdapterRegistry, 'adapters' | 'get' | 'claimants'>;

  /** The relayed page-agent reports, read fresh and waited on after a reload request. */
  readonly agents: BrowserAgentRegistry;

  /**
   * Where the reload request and the "Ready to capture" row go. Absent — a
   * suite, a dry run — and nothing is emitted, though the verdict is the same.
   */
  readonly progress?: Pick<SessionProgress, 'emit' | 'readyToCapture'> | undefined;

  /** Parent logger; lines are bound to `subsystem: "instrumentation"` and the session. */
  readonly logger?: Logger | undefined;

  /** Clock in epoch milliseconds. Default `nowEpochMs`. */
  readonly now?: (() => number) | undefined;

  /**
   * How long to wait for a reload, in milliseconds. Default
   * {@link DEFAULT_RELOAD_WAIT_MS}, clamped to {@link MAX_RELOAD_WAIT_MS}; `0`
   * asks without waiting.
   */
  readonly reloadWaitMs?: number | undefined;

  /**
   * How long to wait, in milliseconds, for the document that replaced a report
   * whose page no longer matches the binding's URL. Default
   * {@link DEFAULT_NAVIGATION_SETTLE_MS}, clamped to
   * {@link MAX_NAVIGATION_SETTLE_MS}; `0` does not wait, and the report is kept.
   */
  readonly navigationSettleMs?: number | undefined;

  /**
   * The documents already asked about, across calls. Absent, the request is
   * still emitted at most once per call.
   */
  readonly reloadPrompts?: ReloadPromptLedger | undefined;
}

/** What {@link evaluateReadiness} is asked about. */
export interface EvaluateReadinessRequest {
  /** The context the plan was (or will be) installed with. */
  readonly context: InstrumentationContext;

  /** The normalised plan whose signals must be deliverable. */
  readonly plan: InstrumentationPlan;

  /** The tab bound to the session, when one is. */
  readonly boundTab?: BoundTab | undefined;

  /**
   * The dev-server detection the caller already holds (for instance
   * {@link ReadinessEvidence.devServer}). Its relaunch command and hint are
   * used verbatim; without it, the generic form is formatted by
   * `../dev-server/detect.ts` from the project root and package manager.
   */
  readonly devServer?: DevServerDetection | undefined;

  /** `false` skips the reload request and the wait entirely. Default `true`. */
  readonly allowReloadPrompt?: boolean | undefined;

  /**
   * `true` makes a missing preload blocking whenever server signals are
   * planned — the strict reading of AAP §0.7.1 Group 2. Default `false`: the
   * gap degrades the capture (AAP §0.5.5).
   */
  readonly requireServerAgent?: boolean | undefined;

  /** `false` suppresses the "Ready to capture" row on success. Default `true`. */
  readonly announceReady?: boolean | undefined;

  /**
   * Abandons the navigation-settle and reload waits early; the verdict is
   * still returned. Already aborted, neither wait starts.
   */
  readonly signal?: AbortSignal | undefined;
}

// ---------------------------------------------------------------------------
// Section F — small internal helpers
// ---------------------------------------------------------------------------

/**
 * The session-bound child logger every function here writes through.
 *
 * Guarded once, here, with `guardLogger`: every log call in this module runs
 * on a degraded path — a port that threw, a probe that failed, a clock that
 * misread — and an injected logger that throws there must not replace the
 * verdict being assembled with its own failure.
 */
function bindLogger(parent: Logger | undefined, sessionId: string): Logger {
  return guardLogger(parent ?? noopLogger).child({
    [LOG_BINDING_KEYS.subsystem]: LOG_SUBSYSTEM,
    [LOG_BINDING_KEYS.sessionId]: sessionId,
  });
}

/** Whether a value is a finite, strictly positive number — a usable epoch timestamp. */
function isEpochMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * The injected clock, made total: a clock that throws or answers something
 * other than a positive finite number is replaced by `nowEpochMs` for that
 * reading, because a test seam must not cost the developer a verdict.
 *
 * The fallback is a deliberate best-effort decision, not a silent one: the
 * first fallback of each clock this returns is recorded at `debug` with an
 * enumerated reason and, for a throw, the closed exception fields. Later
 * readings of the same clock fall back without a record, so a clock broken
 * for a whole evaluation yields one line rather than one per reading.
 *
 * @param now The injected clock, if any.
 * @param log The (guarded) logger the fallback is recorded through.
 */
function totalClock(now: (() => number) | undefined, log: Logger): () => number {
  if (now === undefined) {
    return nowEpochMs;
  }

  let recorded = false;

  const wallClock = (fields: LogFields): number => {
    if (!recorded) {
      recorded = true;
      log.debug('The injected clock could not be read; the wall clock is used instead', fields);
    }

    return nowEpochMs();
  };

  return () => {
    let value: unknown;

    try {
      value = now();
    } catch (thrown) {
      return wallClock({ reason: 'clock-threw', ...describeException(thrown) });
    }

    return isEpochMs(value) ? value : wallClock({ reason: 'clock-reading-unusable' });
  };
}

/** Whether a value is a non-blank string. */
function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Whether a value is a usable Chrome tab id: a non-negative safe integer. */
function isTabId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The log fields of a caught value: its label in the closed exception
 * taxonomy, its closed-vocabulary code when it carries one, and the value
 * itself under {@link LOG_ERROR_FIELD_KEY}, where the service logger's error
 * serializer decides what of it a record may hold.
 *
 * Never the value's own `name` or `message`: both are writable text an
 * adapter, a registry port or a dependency can fill with a path, a query
 * value or a statement (CWE-532), and `describeException` maps rather than
 * copies.
 */
function exceptionFields(thrown: unknown): LogFields {
  return { ...describeException(thrown), [LOG_ERROR_FIELD_KEY]: thrown };
}

/** Whether a value is a plain (non-null, non-array) object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalises a project root for comparison and for the facts handed to the
 * adapters: separators converted, lexically normalised, and required to be
 * absolute (POSIX, or a Windows drive/UNC root).
 */
function normalizeProjectRoot(projectRoot: unknown): Result<string, DebuggenError> {
  if (!isNonBlankString(projectRoot)) {
    return err(
      new DebuggenError('PROJECT_NOT_FOUND', 'Readiness was asked about an empty project root.', {
        hint: 'Pass the absolute path of the project being debugged.',
        details: { field: 'projectRoot' },
      }),
    );
  }

  const posix = toPosix(projectRoot);

  if (!isAbsolutePosix(posix) && !isWindowsAbsolute(posix)) {
    return err(
      new DebuggenError('PROJECT_NOT_FOUND', 'Readiness was asked about a relative project root.', {
        hint: 'Pass the absolute path of the project being debugged.',
        details: { field: 'projectRoot' },
      }),
    );
  }

  return ok(normalizePosix(posix));
}

/** Validates an optional bound tab: a non-negative integer id and a non-blank URL. */
function checkBoundTab(boundTab: unknown): Result<void, DebuggenError> {
  if (boundTab === undefined) {
    return ok(undefined);
  }

  if (!isRecord(boundTab) || !isTabId(boundTab['tabId']) || !isNonBlankString(boundTab['url'])) {
    return err(
      new DebuggenError('TAB_NOT_BOUND', 'Readiness was given a malformed tab binding.', {
        hint: 'Pass the binding exactly as the session record holds it: a non-negative tab id and its URL.',
        details: { field: 'boundTab' },
      }),
    );
  }

  return ok(undefined);
}

/**
 * Rewrites any text as one line of display text within `maxLength`: control
 * characters become spaces, runs of whitespace collapse, and an over-long text
 * is clipped with an ellipsis. Returns the empty string for text with nothing
 * printable in it.
 */
function toSingleLine(text: string, maxLength: number): string {
  let cleaned = '';

  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    cleaned += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? ' ' : character;
  }

  const collapsed = cleaned.replace(/\s+/gu, ' ').trim();

  if (collapsed.length <= maxLength) {
    return collapsed;
  }

  return `${collapsed.slice(0, Math.max(maxLength - 1, 0)).trimEnd()}…`;
}

/**
 * The reason a readiness probe that threw is reported with: a fixed sentence
 * naming only the adapter's registered id, which reads after "Could not enable
 * ‹signal›: " (AAP §0.5.5) and is bounded like every reason. Whatever the
 * probe threw stays in the local log (see `askAdapter`).
 */
function adapterFailedReason(adapterId: string): string {
  return authorProductText(
    toSingleLine(
      `the ${adapterId} adapter could not report readiness`,
      READINESS_REASON_MAX_LENGTH,
    ),
  );
}

/**
 * One of this module's fixed gate texts, registered as product-authored where
 * it is used (see {@link GATE_WORDING}), and returned unchanged.
 */
function gateWording(text: string): string {
  return authorProductText(text);
}

/**
 * The origin of a URL, when it has a meaningful one. `undefined` for an
 * unparsable URL and for opaque origins (`file:`, `data:`), which cannot be
 * compared.
 */
function originOf(url: string): string | undefined {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/**
 * The display form of a page URL handed to an adapter: origin and path only.
 *
 * The page agent already redacts query values before a report leaves the page
 * (AAP §0.5.2); dropping the query and fragment here as well means no value an
 * adapter could echo into a hint ever reaches it. `undefined` for anything that
 * is not an `http:`/`https:` URL.
 */
function displayUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }

    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/** Two project roots name the same project once both are normalised. */
function sameProjectRoot(left: string, right: string): boolean {
  return normalizePosix(toPosix(left)) === normalizePosix(toPosix(right));
}

/** The signals a plan needs, split by the producer that supplies them. */
interface PlannedSignals {
  /** The page-agent signals — the enabled keys of the derived `AgentHookConfig`. */
  readonly browser: ReadonlySet<CaptureSignal>;

  /** The dev-server signals — the enabled keys of the derived `ServerAgentSignals`. */
  readonly server: ReadonlySet<CaptureSignal>;

  /** Both, deduplicated, in capture-signal vocabulary order. */
  readonly ordered: readonly CaptureSignal[];
}

/**
 * The signals a set of actions needs, derived through the upstream
 * derivations rather than by mapping action types here: `deriveAgentHookConfig`
 * decides the browser hooks (including the forced interaction listener and the
 * React prerequisite of state tracking) and `deriveServerAgentSignals` decides
 * the server set (including the request and route-handler spine).
 */
function derivePlannedSignals(actions: readonly InstrumentationAction[]): PlannedSignals {
  const hooks = deriveAgentHookConfig(actions);
  const serverSignals = deriveServerAgentSignals(actions);

  const browser = new Set<CaptureSignal>(BROWSER_CAPTURE_SIGNALS.filter((signal) => hooks[signal]));
  const server = new Set<CaptureSignal>(
    SERVER_CAPTURE_SIGNALS.filter((signal) => {
      const value = serverSignals[signal];
      return Array.isArray(value) ? value.length > 0 : value;
    }),
  );

  return {
    browser,
    server,
    ordered: CAPTURE_SIGNALS.filter((signal) => browser.has(signal) || server.has(signal)),
  };
}

/**
 * Converts a relayed `agent.ready` into the upstream observed shape.
 *
 * Exported so the relaying layer and the suites convert a report exactly as
 * readiness does. The URL is reduced to origin and path (see
 * {@link displayUrl}); every other field is copied as observed.
 *
 * @param payload The validated `agent.ready` payload.
 * @param observedAt When the report was received, in epoch milliseconds.
 * @returns The observed report, with no key present-and-undefined.
 */
export function toObservedBrowserAgent(
  payload: AgentReadyPayload,
  observedAt: number,
): ObservedBrowserAgent {
  const url = displayUrl(payload.url);

  return {
    producerId: payload.producerId,
    documentId: payload.documentId,
    ...(url === undefined ? {} : { url }),
    installedBeforeReact: payload.installedBeforeReact,
    reactDetected: payload.reactDetected,
    observedAt,
  };
}

/**
 * Whether a relayed report can describe a document of the binding at all: the
 * same tab, and — when both origins can be read — the same origin as the
 * binding. A report from another origin is a document the binding no longer
 * covers (the service worker unbinds on a cross-origin navigation). Whether it
 * is the tab's *current* document is a separate judgement,
 * {@link isOnBoundPage}.
 */
function describesBoundDocument(payload: AgentReadyPayload, boundTab: BoundTab): boolean {
  if (payload.tabId !== boundTab.tabId) {
    return false;
  }

  const boundOrigin = originOf(boundTab.url);
  const documentOrigin = originOf(payload.url);

  return (
    boundOrigin === undefined || documentOrigin === undefined || boundOrigin === documentOrigin
  );
}

/**
 * Whether an observed report (already matched to the bound tab and origin) is
 * for the page the binding records now: the same origin and path, query and
 * fragment ignored — the binding route mirrors every committed same-origin
 * navigation's URL onto the binding, while the stored report changes only
 * when a new document announces itself.
 *
 * Either URL unreadable as an `http(s)` URL gives no judgement and reads as
 * current, so a comparison this module cannot make never withholds a report.
 * `false` is not a verdict that the report is stale — a history-API navigation
 * moves the binding's URL within one document — only that it is not trusted on
 * sight (see {@link settleCurrentDocument}).
 */
function isOnBoundPage(agent: ObservedBrowserAgent, boundTab: BoundTab): boolean {
  const boundPage = displayUrl(boundTab.url);

  return agent.url === undefined || boundPage === undefined || agent.url === boundPage;
}

/**
 * Whether the registry recorded a committed navigation of the tab after the
 * report was received ({@link BrowserAgentRegistry.latestNavigationAt}) — the
 * one sign of a reload or a same-URL load, which {@link isOnBoundPage} cannot
 * see. A registry without the method, one that throws or answers something
 * that is not an epoch time, gives no such sign.
 */
function navigatedSinceReport(
  agents: BrowserAgentRegistry,
  tabId: number,
  agent: ObservedBrowserAgent,
): boolean {
  if (agents.latestNavigationAt === undefined) {
    return false;
  }

  try {
    const navigatedAt = agents.latestNavigationAt(tabId);

    return isEpochMs(navigatedAt) && navigatedAt > agent.observedAt;
  } catch {
    return false;
  }
}

/**
 * Whether a report (already matched to the bound tab and origin) may be judged
 * as the tab's current document without waiting: it is for the page the
 * binding records, and no navigation was recorded after it arrived.
 */
function isTrustedOnSight(
  agents: BrowserAgentRegistry,
  agent: ObservedBrowserAgent,
  boundTab: BoundTab,
): boolean {
  return isOnBoundPage(agent, boundTab) && !navigatedSinceReport(agents, boundTab.tabId, agent);
}

/**
 * Reads the bound tab's latest page-agent report through the registry,
 * defensively: a registry that throws, a report for another tab or another
 * origin all read as "no report", each with a note. Synchronous; whether the
 * report is for the tab's current document is judged by the caller.
 */
function readBoundTabAgent(
  agents: BrowserAgentRegistry,
  boundTab: BoundTab,
  clock: () => number,
  notes: string[],
  log: Logger,
): ObservedBrowserAgent | undefined {
  let payload: AgentReadyPayload | undefined;

  try {
    payload = agents.latestAgentReady(boundTab.tabId);
  } catch (thrown) {
    notes.push('The page-agent registry could not be read; the page agent is treated as absent.');
    log.warn('Reading the latest agent.ready failed; treating the page agent as absent', {
      tabId: boundTab.tabId,
      ...exceptionFields(thrown),
    });
    return undefined;
  }

  if (payload === undefined) {
    notes.push("No page agent has reported for the bound tab's current document.");
    return undefined;
  }

  if (!describesBoundDocument(payload, boundTab)) {
    notes.push('The latest page-agent report describes a document the binding does not cover.');
    log.debug('Ignoring an agent.ready for a different tab or origin', {
      tabId: boundTab.tabId,
      reportedTabId: payload.tabId,
      ...documentLogFields(payload.documentId),
    });
    return undefined;
  }

  let receivedAt: number | undefined;

  try {
    receivedAt = agents.latestAgentReadyAt?.(boundTab.tabId);
  } catch {
    receivedAt = undefined;
  }

  return toObservedBrowserAgent(payload, isEpochMs(receivedAt) ? receivedAt : clock());
}

// ---------------------------------------------------------------------------
// Section G — collection
// ---------------------------------------------------------------------------

/**
 * The observed `server-agent` for a project, from the presence port and — when
 * the source offers one — the connection snapshot.
 *
 * - Connected: `{ connected: true, projectRoot, lastHeartbeatAt? }`.
 * - Known but down (the snapshot describes a connection that is offline):
 *   `{ connected: false, projectRoot, lastHeartbeatAt? }`.
 * - Never connected, or unknowable: absent, which is the honest answer at the
 *   start of a session (see `ObservedReadinessInputs`).
 */
function observeServerAgent(
  source: ServerAgentReadinessSource,
  projectRoot: string,
  notes: string[],
  log: Logger,
): ObservedServerAgent | undefined {
  let connected: boolean;

  try {
    connected = source.hasServerAgentForProject(projectRoot);
  } catch (thrown) {
    notes.push('Dev-server preload presence could not be read; the preload is treated as absent.');
    log.warn('Reading server-agent presence failed; treating the preload as absent', {
      ...exceptionFields(thrown),
    });
    return undefined;
  }

  let snapshot: ServerAgentSnapshot | undefined;

  try {
    const described = source.serverAgentForProject?.(projectRoot);
    snapshot = described === undefined || isErr(described) ? undefined : described.value;
  } catch (thrown) {
    log.debug('Reading the server-agent snapshot failed; heartbeat age is unknown', {
      ...exceptionFields(thrown),
    });
    snapshot = undefined;
  }

  const lastHeartbeatAt = isEpochMs(snapshot?.lastSeenAt) ? snapshot.lastSeenAt : undefined;

  if (connected) {
    return {
      connected: true,
      projectRoot,
      ...(lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt }),
    };
  }

  if (snapshot === undefined) {
    return undefined;
  }

  return {
    connected: false,
    projectRoot,
    ...(lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt }),
  };
}

/**
 * The live dev server this service launched for the project, most recent
 * first, when there is one. Read-only: `list()` is the only launcher method
 * this module calls.
 */
function findLaunchedDevServer(
  launcher: Pick<DevServerLauncher, 'list'> | undefined,
  projectRoot: string,
  notes: string[],
  log: Logger,
): LaunchedDevServer | undefined {
  if (launcher === undefined) {
    return undefined;
  }

  let launched: readonly LaunchedDevServer[];

  try {
    launched = launcher.list();
  } catch (thrown) {
    notes.push('The list of launched dev servers could not be read.');
    log.warn('Listing launched dev servers failed', exceptionFields(thrown));
    return undefined;
  }

  let newest: LaunchedDevServer | undefined;

  for (const entry of launched) {
    if (
      LIVE_LAUNCH_STATUSES.has(entry.status) &&
      sameProjectRoot(entry.projectRoot, projectRoot) &&
      (newest === undefined || entry.startedAt > newest.startedAt)
    ) {
      newest = entry;
    }
  }

  return newest;
}

/**
 * Whether dev-server detection has anything to contribute: only when the plan
 * may need a server signal (or no plan is known yet) and no preload is
 * connected — a connected preload needs no relaunch command.
 */
function needsDetection(
  plan: InstrumentationPlan | undefined,
  serverAgent: ObservedServerAgent | undefined,
): boolean {
  if (serverAgent?.connected === true) {
    return false;
  }

  return plan === undefined || derivePlannedSignals(plan.instrumentationTargets).server.size > 0;
}

/** Validates a collection request. */
function checkCollectRequest(
  request: CollectObservedReadinessRequest,
): Result<{ readonly sessionId: string; readonly projectRoot: string }, DebuggenError> {
  if (!isRecord(request) || !isNonBlankString(request.sessionId)) {
    return err(
      new DebuggenError('INTERNAL', 'Readiness facts were requested without a session id.', {
        hint: 'Pass the id of the session the facts are collected for.',
        details: { field: 'sessionId' },
      }),
    );
  }

  const projectRoot = normalizeProjectRoot(request.projectRoot);

  if (isErr(projectRoot)) {
    return projectRoot;
  }

  const boundTab = checkBoundTab(request.boundTab);

  if (isErr(boundTab)) {
    return boundTab;
  }

  if (
    request.plan !== undefined &&
    (!isRecord(request.plan) || !Array.isArray(request.plan.instrumentationTargets))
  ) {
    return err(
      new DebuggenError('INTERNAL', 'Readiness facts were requested for a malformed plan.', {
        hint: 'Pass the normalised instrumentation plan, or no plan at all.',
        details: { field: 'plan' },
      }),
    );
  }

  return ok({ sessionId: request.sessionId, projectRoot: projectRoot.value });
}

/**
 * Collects the readiness facts for a session — the observed inputs, plus the
 * dev-server detection and the launch record a remediation needs.
 *
 * Steps, each of which degrades to a note instead of failing (AAP §0.5.5):
 *
 * 1. **Page agent.** With a bound tab, the latest relayed `agent.ready` for it,
 *    when it names the bound tab and origin. Without one, the absence is
 *    recorded — never a default that reads as "present". A report for another
 *    path than the binding records is kept, with a note: this read never
 *    waits, and {@link evaluateReadiness} confirms the current document before
 *    capture.
 * 2. **Preload.** `hasServerAgentForProject` decides whether it is connected;
 *    the optional snapshot supplies when it last spoke, so the preload-bound
 *    adapters can apply their own staleness windows.
 * 3. **Launched dev server.** A live launch for the project, read through the
 *    launcher's `list()`, supplies the URL to probe when the request has none.
 * 4. **Detection.** Only when a server signal may be needed and no preload is
 *    connected: the injected `detect` (default `detectDevServer`) runs with the
 *    service's address and the presence port, so its relaunch command is the
 *    exact one for this project. A detection that throws is recorded as
 *    unknown, not attached.
 *
 * Returns `Err` only for programmer-level input problems: an empty session id,
 * an empty or relative project root, a malformed tab binding or plan. It writes
 * nothing, caches nothing and starts no timer; with the same inputs and clock
 * it produces the same value.
 *
 * @param deps The injected collaborators.
 * @param request The session, project, binding and plan to collect for.
 * @returns The evidence, or the input error.
 */
export async function collectReadinessEvidence(
  deps: CollectObservedReadinessDeps,
  request: CollectObservedReadinessRequest,
): Promise<Result<ReadinessEvidence, DebuggenError>> {
  const checked = checkCollectRequest(request);

  if (isErr(checked)) {
    return checked;
  }

  const { sessionId, projectRoot } = checked.value;
  const log = bindLogger(deps.logger, sessionId);
  const clock = totalClock(deps.now, log);
  const notes: string[] = [];

  let browserAgent: ObservedBrowserAgent | undefined;

  if (request.boundTab === undefined) {
    notes.push('No tab is bound to this session.');
  } else {
    browserAgent = readBoundTabAgent(deps.agents, request.boundTab, clock, notes, log);

    // Collection stays a synchronous read: the report is kept as observed, and
    // evaluateReadiness — run again at capture start — decides whether it is
    // the current document.
    if (
      browserAgent !== undefined &&
      !isTrustedOnSight(deps.agents, browserAgent, request.boundTab)
    ) {
      notes.push(
        'The latest page-agent report predates the page the binding records now; readiness confirms the current document before capture.',
      );
    }
  }

  const serverAgent = observeServerAgent(deps.serverAgents, projectRoot, notes, log);
  const launchedDevServer = findLaunchedDevServer(deps.devServers, projectRoot, notes, log);

  let devServer: DevServerDetection | undefined;

  if (request.signal?.aborted === true) {
    notes.push('Collection was cancelled before dev-server detection.');
  } else if (needsDetection(request.plan, serverAgent)) {
    const detect = deps.detect ?? detectDevServer;
    const devServerUrl = request.devServerUrl ?? launchedDevServer?.devServerUrl;

    try {
      devServer = await detect(
        { projectRoot, devServerUrl },
        {
          ...deps.detectDeps,
          config: deps.config,
          logger: deps.logger,
          serverAgents: deps.serverAgents,
          now: clock,
        },
      );
    } catch (thrown) {
      notes.push('Dev-server detection failed; the preload is treated as not attached.');
      log.warn('Dev-server detection failed; treating the preload as not attached', {
        ...exceptionFields(thrown),
      });
      devServer = undefined;
    }
  }

  const observed: ObservedReadinessInputs = {
    ...(browserAgent === undefined ? {} : { browserAgent }),
    ...(serverAgent === undefined ? {} : { serverAgent }),
  };

  log.debug('Readiness facts collected', {
    tabId: request.boundTab?.tabId,
    browserAgentPresent: browserAgent !== undefined,
    serverAgentConnected: serverAgent?.connected === true,
    devServerDetected: devServer !== undefined,
    launchedDevServer: launchedDevServer !== undefined,
    noteCount: notes.length,
  });

  return ok({
    observed,
    ...(devServer === undefined ? {} : { devServer }),
    ...(launchedDevServer === undefined ? {} : { launchedDevServer }),
    notes: Object.freeze([...notes]),
  });
}

/**
 * Collects the observed readiness inputs every adapter reads — the value
 * `./service.ts` places on `InstrumentationContext.readiness`.
 *
 * Exactly {@link collectReadinessEvidence}'s `observed` member: the upstream
 * `ObservedReadinessInputs`, populated field for field and never restated. A
 * caller that also needs the exact relaunch command uses
 * {@link collectReadinessEvidence} and passes its `devServer` to
 * {@link evaluateReadiness}.
 *
 * @param deps The injected collaborators.
 * @param request The session, project, binding and plan to collect for.
 * @returns The observed inputs, or the input error.
 */
export async function collectObservedReadiness(
  deps: CollectObservedReadinessDeps,
  request: CollectObservedReadinessRequest,
): Promise<Result<ObservedReadinessInputs, DebuggenError>> {
  const evidence = await collectReadinessEvidence(deps, request);

  return isErr(evidence) ? evidence : ok(evidence.value.observed);
}

// ---------------------------------------------------------------------------
// Section H — evaluation internals
// ---------------------------------------------------------------------------

/**
 * The page gate's answer for one planned browser signal.
 *
 * - `no-tab` / `no-agent` / `hook-late` block (AAP §0.7.1 Group 2).
 *   `hook-late` is the current document's report with `installedBeforeReact`
 *   false, and applies to every planned browser signal.
 * - `react-absent` degrades a fiber-hook signal on a timely document: the page
 *   is observable, it just renders no React.
 * - `ok` passes, leaving the decision to the adapters' rows.
 */
type BrowserGate = 'ok' | 'no-tab' | 'no-agent' | 'hook-late' | 'react-absent';

/** The adapters to ask and, per adapter id, the planned signals its actions cover. */
interface AdapterSelection {
  readonly adapters: readonly InstrumentationAdapter[];
  readonly covered: ReadonlyMap<string, readonly CaptureSignal[]>;
}

/** One readiness row, remembered with the adapter that reported it. */
interface AttributedRow {
  readonly adapterId: string;
  readonly row: ReadinessSignal;
}

/** One adapter's answer, with an extra gap when its failure covers no known signal. */
interface AdapterAnswer {
  readonly report: ReadinessAdapterReport;
  readonly uncovered?: UnavailableSignal;
}

/** The reload a failed page gate asks for. */
interface ReloadAsk {
  readonly tabId: number;
  readonly documentId?: string;
  /** The gate's reason, used as the reload row's second line. */
  readonly reason: string;
}

/** Everything one evaluation pass reads. */
interface PassInput {
  readonly context: InstrumentationContext;
  readonly planned: PlannedSignals;
  readonly selection: AdapterSelection;
  readonly boundTab: BoundTab | undefined;
  readonly browserAgent: ObservedBrowserAgent | undefined;
  readonly devServer: DevServerDetection | undefined;
  readonly requireServerAgent: boolean;
  readonly clock: () => number;
  readonly log: Logger;
}

/** What one evaluation pass concluded. */
interface PassOutcome {
  readonly satisfied: boolean;
  readonly perAdapter: readonly ReadinessAdapterReport[];
  readonly blocking: readonly UnavailableSignal[];
  readonly degraded: readonly UnavailableSignal[];
  readonly remediations: readonly ReadinessRemediation[];
  readonly deliverable: readonly CaptureSignal[];
  readonly observed: ObservedReadinessInputs;
  readonly reload?: ReloadAsk;
}

/** Whether a value is a package manager a relaunch command can name. */
function isPackageManagerId(value: unknown): value is PackageManagerId {
  return typeof value === 'string' && KNOWN_PACKAGE_MANAGERS.includes(value);
}

/**
 * Selects the adapters to ask, by claim and never by id: the adapter each
 * action was normalised to (`registry.get(action.adapter)` — the one that will
 * install it) and every applicable claimant of each distinct action type
 * (`registry.claimants(context, type)` — for instance both database adapters
 * when a project uses both). Deduplicated by id and returned in registry
 * order, so the verdict is deterministic. A registry method that throws is
 * contained: that question contributes nothing.
 */
function selectAdapters(
  registry: EvaluateReadinessDeps['adapters'],
  context: InstrumentationContext,
  actions: readonly InstrumentationAction[],
  log: Logger,
): AdapterSelection {
  const chosen = new Map<string, InstrumentationAdapter>();
  const actionsByAdapter = new Map<string, Map<string, InstrumentationAction>>();

  const include = (adapter: InstrumentationAdapter, action: InstrumentationAction): void => {
    if (!chosen.has(adapter.id)) {
      chosen.set(adapter.id, adapter);
    }

    let bucket = actionsByAdapter.get(adapter.id);

    if (bucket === undefined) {
      bucket = new Map<string, InstrumentationAction>();
      actionsByAdapter.set(adapter.id, bucket);
    }

    bucket.set(action.id, action);
  };

  for (const action of actions) {
    let named: InstrumentationAdapter | undefined;

    try {
      named = registry.get(action.adapter);
    } catch (thrown) {
      log.warn('Looking up an action adapter failed; relying on claimants', {
        actionId: action.id,
        ...exceptionFields(thrown),
      });
      named = undefined;
    }

    if (named !== undefined) {
      include(named, action);
    }
  }

  const types = new Set<InstrumentationActionType>(actions.map((action) => action.type));

  for (const type of types) {
    let claimants: readonly InstrumentationAdapter[];

    try {
      claimants = registry.claimants(context, type);
    } catch (thrown) {
      log.warn('Asking the registry for claimants failed', {
        actionType: type,
        ...exceptionFields(thrown),
      });
      claimants = [];
    }

    for (const claimant of claimants) {
      for (const action of actions) {
        if (action.type === type) {
          include(claimant, action);
        }
      }
    }
  }

  let registered: readonly InstrumentationAdapter[];

  try {
    registered = registry.adapters();
  } catch (thrown) {
    log.warn('Listing registered adapters failed; keeping discovery order', {
      ...exceptionFields(thrown),
    });
    registered = [];
  }

  const insertionOrder = [...chosen.keys()];
  const rankOf = (id: string): number => {
    const registeredIndex = registered.findIndex((adapter) => adapter.id === id);
    return registeredIndex >= 0 ? registeredIndex : registered.length + insertionOrder.indexOf(id);
  };

  const adapters = [...chosen.values()].sort((left, right) => rankOf(left.id) - rankOf(right.id));
  const covered = new Map<string, readonly CaptureSignal[]>();

  for (const adapter of adapters) {
    const bucket = actionsByAdapter.get(adapter.id);
    covered.set(
      adapter.id,
      bucket === undefined ? [] : derivePlannedSignals([...bucket.values()]).ordered,
    );
  }

  return { adapters, covered };
}

/**
 * Asks one adapter for its readiness, so that nothing it does can propagate.
 *
 * A report is validated with `parseReadiness`. A probe that rejects (or throws
 * synchronously) or answers an invalid report has established nothing, so it
 * becomes a report built here with one `'unavailable'` row per planned signal
 * the adapter's actions cover. An unverified probe therefore never makes a
 * signal deliverable on its own — the signal stays deliverable only when
 * another adapter's row for it is not `'unavailable'` (independent
 * confirmation, the `evaluatePass` rule), and a plan left with nothing
 * deliverable blocks. When the failure covers no known signal, the gap travels
 * as an extra degraded entry named after the adapter: there is no signal to
 * withhold, only a failure to report.
 *
 * The reason of a thrown probe is always this module's fixed sentence
 * ({@link adapterFailedReason}), never the thrown value's message: a reason is
 * shown in both user interfaces' progress rows, in `instrumentation.ready`'s
 * `unavailable` list and in the capture gate's refusal, and an adapter or a
 * dependency it calls can throw text quoting a path, a statement or a URL
 * (CWE-209). The hint is always this module's generic next step, never the
 * thrown value's — not even a `DebuggenError`'s: an adapter mints its own
 * errors, and their hints can quote the same private text. Both are
 * registered as product-authored, so the capture gate may show them. The
 * value itself is logged locally under the logger's error key, with the
 * closed exception class, once at `warn` and once more at `debug`, where the
 * service's error serializer adds its redacted message and hint.
 */
async function askAdapter(
  adapter: InstrumentationAdapter,
  context: InstrumentationContext,
  covered: readonly CaptureSignal[],
  clock: () => number,
  log: Logger,
): Promise<AdapterAnswer> {
  let reason: string;
  let hint: string;

  try {
    const answer: unknown = await adapter.readiness(context);
    const parsed = parseReadiness(answer);

    if (!isErr(parsed)) {
      return { report: { adapterId: adapter.id, readiness: parsed.value } };
    }

    log.warn(
      'An adapter returned an invalid readiness report; treating its signals as unavailable',
      {
        adapterId: adapter.id,
        issues: parsed.error.details,
      },
    );
    reason = gateWording(GATE_WORDING.invalidReport.reason);
    hint = gateWording(GATE_WORDING.adapterFailed.hint);
  } catch (thrown) {
    log.warn('An adapter readiness probe failed; treating its signals as unavailable', {
      adapterId: adapter.id,
      ...exceptionFields(thrown),
    });
    log.debug('The diagnostic of a failed adapter readiness probe', {
      adapterId: adapter.id,
      ...exceptionFields(thrown),
    });
    reason = adapterFailedReason(adapter.id);
    hint = gateWording(GATE_WORDING.adapterFailed.hint);
  }

  // Fail closed: a probe that could not answer has not established any of the
  // signals it covers, so each is withheld until another adapter confirms it.
  const readiness = buildReadiness({
    adapter: adapter.id,
    signals: covered.map((signal) => ({ signal, status: UNAVAILABLE_STATUS, reason, hint })),
    now: clock,
  });

  return covered.length > 0
    ? { report: { adapterId: adapter.id, readiness } }
    : {
        report: { adapterId: adapter.id, readiness },
        uncovered: { signal: adapter.id, reason, hint },
      };
}

/**
 * The page gate for one planned browser signal, in AAP §0.7.1 Group 2's order:
 * a bound tab, a page agent for its current document, and that agent installed
 * at `document_start` — before React and before the page began loading
 * (`installedBeforeReact`). The late-install check applies to every browser
 * signal: an agent that started late may have missed part of the load it
 * joined — requests, performance entries, errors and interactions, not only
 * React's commits. Only on a timely document is a missing React judged, and
 * only for the fiber-hook signals, as a degradation.
 */
function browserGateFor(signal: CaptureSignal, input: PassInput): BrowserGate {
  if (input.boundTab === undefined) {
    return 'no-tab';
  }

  const agent = input.browserAgent;

  if (agent === undefined) {
    return 'no-agent';
  }

  if (!agent.installedBeforeReact) {
    return 'hook-late';
  }

  if (FIBER_HOOK_SIGNALS.has(signal) && !agent.reactDetected) {
    return 'react-absent';
  }

  return 'ok';
}

/**
 * The late-install gate's wording for one document: the React hook's when the
 * agent found React on the page, the page agent's otherwise (see
 * {@link GATE_WORDING}). Used for every gap entry and for the reload request,
 * so the row's second line and the gaps it would clear say the same thing.
 */
function lateInstallWording(agent: ObservedBrowserAgent | undefined): {
  readonly reason: string;
  readonly hint: string;
} {
  return agent?.reactDetected === true ? GATE_WORDING.hookLate : GATE_WORDING.agentLate;
}

/** Whether a page gate holds the session back. */
function isBlockingGate(
  gate: BrowserGate | undefined,
): gate is 'no-tab' | 'no-agent' | 'hook-late' {
  return gate === 'no-tab' || gate === 'no-agent' || gate === 'hook-late';
}

/**
 * The gap one page gate reports for one signal, in this module's words, both
 * registered as product-authored (see {@link GATE_WORDING}). `agent` is the
 * report the gate read, which chooses the late-install wording.
 */
function gateEntry(
  signal: CaptureSignal,
  gate: Exclude<BrowserGate, 'ok'>,
  agent: ObservedBrowserAgent | undefined,
): UnavailableSignal {
  const wording = gateWordingOf(gate, agent);

  return { signal, reason: gateWording(wording.reason), hint: gateWording(wording.hint) };
}

/** The fixed reason and hint of one page gate; `agent` chooses the late-install wording. */
function gateWordingOf(
  gate: Exclude<BrowserGate, 'ok'>,
  agent: ObservedBrowserAgent | undefined,
): {
  readonly reason: string;
  readonly hint: string;
} {
  switch (gate) {
    case 'no-tab':
      return GATE_WORDING.noTab;
    case 'no-agent':
      return GATE_WORDING.noAgent;
    case 'hook-late':
      return lateInstallWording(agent);
    case 'react-absent':
      return GATE_WORDING.reactAbsent;
  }
}

/**
 * The most severe adapter row for a signal that is not fully available: the
 * first `'unavailable'` row in registry order, else the first `'degraded'` one.
 */
function strongestGap(rows: readonly AttributedRow[]): AttributedRow | undefined {
  return (
    rows.find((entry) => entry.row.status === UNAVAILABLE_STATUS) ??
    rows.find((entry) => entry.row.status === DEGRADED_STATUS)
  );
}

/**
 * An adapter row as a gap entry, in the adapter's own words.
 *
 * The adapter's `reason` and `hint` are relayed verbatim — they are the
 * "Could not enable ‹signal›: ‹reason›" of AAP §0.5.5's degradation rows — and
 * are never registered as product-authored, so the capture gate never quotes
 * them in a refusal. Only the fallbacks this module writes for a row that
 * states none are registered: a sentence naming the adapter's registered id
 * and the row's schema-validated status, and the generic next step.
 */
function rowEntry(signal: CaptureSignal, attributed: AttributedRow): UnavailableSignal {
  const { adapterId, row } = attributed;

  return {
    signal,
    reason:
      row.reason ?? authorProductText(`the ${adapterId} adapter reported it as ${row.status}`),
    hint: row.hint ?? gateWording(GATE_WORDING.adapterFailed.hint),
  };
}

/**
 * The relaunch facts for a missing preload: the detection to phrase the gap
 * from, and the exact command and hint.
 *
 * A detection the caller holds is used verbatim. One that still believes the
 * preload is attached — it connected earlier and has since gone — is
 * re-situated as "running without the preload", and its hint recomposed by
 * `buildRelaunchHint` around the same command, so the wording matches the fact.
 * Without a detection, `../dev-server/detect.ts` formats the generic command
 * from the project root and the package manager the project summary reports.
 * No command text is composed here in any case.
 */
function relaunchFacts(
  context: InstrumentationContext,
  devServer: DevServerDetection | undefined,
): {
  readonly detection: Pick<
    DevServerDetection,
    'running' | 'preloadAttached' | 'preloadReason' | 'relaunchHint'
  >;
  readonly command: string;
  readonly hint: string;
} {
  if (devServer !== undefined && !devServer.preloadAttached) {
    return {
      detection: devServer,
      command: devServer.relaunchCommand,
      hint: devServer.relaunchHint,
    };
  }

  if (devServer !== undefined) {
    const resituated: DevServerDetection = {
      ...devServer,
      preloadAttached: false,
      preloadReason: 'no-server-agent-connection',
    };
    const hint = buildRelaunchHint(resituated);

    return {
      detection: { ...resituated, relaunchHint: hint },
      command: devServer.relaunchCommand,
      hint,
    };
  }

  const summary: unknown = context.projectSummary;
  const packageManager = isRecord(summary) ? summary['packageManager'] : undefined;
  const input: RelaunchCommandInput = {
    projectRoot: context.projectRoot,
    packageManager: isPackageManagerId(packageManager) ? packageManager : 'unknown',
  };
  const hint = buildRelaunchHint(input);

  return {
    detection: {
      running: true,
      preloadAttached: false,
      preloadReason: 'unknown',
      relaunchHint: hint,
    },
    command: formatRelaunchCommand(input),
    hint,
  };
}

/**
 * One evaluation pass: ask the adapters, apply the gates, classify every
 * planned signal and name the remediations. Pure apart from the adapter calls,
 * which are contained.
 */
async function evaluatePass(input: PassInput): Promise<PassOutcome> {
  const { context, planned, selection, boundTab, browserAgent, log } = input;
  const serverAgent = context.readiness.serverAgent;

  const observed: ObservedReadinessInputs = {
    ...(browserAgent === undefined ? {} : { browserAgent }),
    ...(serverAgent === undefined ? {} : { serverAgent }),
  };
  const passContext: InstrumentationContext = { ...context, readiness: observed };

  const answers = await Promise.all(
    selection.adapters.map((adapter) =>
      askAdapter(adapter, passContext, selection.covered.get(adapter.id) ?? [], input.clock, log),
    ),
  );

  const perAdapter = answers.map((answer) => answer.report);
  const rowsBySignal = new Map<CaptureSignal, AttributedRow[]>();

  for (const { adapterId, readiness } of perAdapter) {
    for (const row of readiness.signals) {
      if (!isCaptureSignal(row.signal) || !planned.ordered.includes(row.signal)) {
        continue;
      }

      const rows = rowsBySignal.get(row.signal) ?? [];
      rows.push({ adapterId, row });
      rowsBySignal.set(row.signal, rows);
    }
  }

  const serverConnected =
    serverAgent?.connected === true &&
    sameProjectRoot(serverAgent.projectRoot, context.projectRoot);

  let blocking: UnavailableSignal[] = [];
  let degraded: UnavailableSignal[] = [];
  const deliverable: CaptureSignal[] = [];
  const serverGapSignals: CaptureSignal[] = [];
  let tabMissing = false;
  let reload: ReloadAsk | undefined;

  for (const signal of planned.ordered) {
    const inBrowser = planned.browser.has(signal);
    const inServer = planned.server.has(signal);
    const gate = inBrowser ? browserGateFor(signal, input) : undefined;
    const browserDeliverable = gate === 'ok' || gate === 'react-absent';
    const serverGap = inServer && !inBrowser && !serverConnected;
    const rows = rowsBySignal.get(signal) ?? [];

    const gatesPass = !isBlockingGate(gate) && !serverGap;
    const adaptersAllow =
      rows.length === 0 || rows.some((entry) => entry.row.status !== UNAVAILABLE_STATUS);
    const delivered = gatesPass
      ? adaptersAllow
      : browserDeliverable || (inServer && serverConnected);

    if (delivered) {
      deliverable.push(signal);
    }

    if (isBlockingGate(gate)) {
      blocking.push(gateEntry(signal, gate, browserAgent));

      if (gate === 'no-tab') {
        tabMissing = true;
      } else if (boundTab !== undefined && reload === undefined) {
        const documentId = gate === 'hook-late' ? browserAgent?.documentId : undefined;
        const reason =
          gate === 'hook-late'
            ? lateInstallWording(browserAgent).reason
            : GATE_WORDING.noAgent.reason;
        reload = {
          tabId: boundTab.tabId,
          ...(documentId === undefined ? {} : { documentId }),
          reason,
        };
      }

      continue;
    }

    if (serverGap) {
      serverGapSignals.push(signal);
      continue;
    }

    const gap = strongestGap(rows);

    if (gap !== undefined) {
      degraded.push(rowEntry(signal, gap));
    } else if (gate === 'react-absent') {
      degraded.push(gateEntry(signal, gate, browserAgent));
    }
  }

  for (const answer of answers) {
    if (answer.uncovered !== undefined) {
      degraded.push(answer.uncovered);
    }
  }

  const remediations: ReadinessRemediation[] = [];

  if (tabMissing) {
    remediations.push({ kind: 'bind-tab' });
  }

  if (reload !== undefined) {
    remediations.push({
      kind: 'reload-page',
      tabId: reload.tabId,
      ...(reload.documentId === undefined ? {} : { documentId: reload.documentId }),
    });
  }

  if (serverGapSignals.length > 0) {
    const facts = relaunchFacts(context, input.devServer);
    const gaps = buildPreloadUnavailableSignals(facts.detection, serverGapSignals);

    if (input.requireServerAgent) {
      blocking.push(...gaps);
    } else {
      degraded.push(...gaps);
    }

    remediations.push({
      kind: 'relaunch-dev-server',
      projectRoot: context.projectRoot,
      command: facts.command,
      hint: facts.hint,
    });
  }

  // Rule 4: a capture that would collect nothing at all is not ready, whatever
  // else is true. Every gap then holds the session back.
  if (deliverable.length === 0 && degraded.length > 0) {
    blocking = [...blocking, ...degraded];
    degraded = [];
  }

  const satisfied = blocking.length === 0 && deliverable.length > 0;

  return {
    satisfied,
    perAdapter,
    blocking,
    degraded,
    remediations,
    deliverable,
    observed,
    ...(reload === undefined ? {} : { reload }),
  };
}

/**
 * An injected wait, clamped: `fallback` when nothing usable was injected (absent,
 * not finite, or negative), `0` to not wait at all, whole milliseconds, and
 * never above `ceiling`. Used for {@link EvaluateReadinessDeps.reloadWaitMs}
 * ({@link DEFAULT_RELOAD_WAIT_MS}, {@link MAX_RELOAD_WAIT_MS}) and
 * {@link EvaluateReadinessDeps.navigationSettleMs}
 * ({@link DEFAULT_NAVIGATION_SETTLE_MS}, {@link MAX_NAVIGATION_SETTLE_MS}).
 */
function resolveWaitMs(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return Math.min(Math.floor(value), ceiling);
}

/** The ledger key of one reload request: one per session, tab and document. */
function reloadPromptKey(sessionId: string, reload: ReloadAsk): string {
  return JSON.stringify([sessionId, reload.tabId, reload.documentId ?? null]);
}

/**
 * Emits the reload request, at most once per document: skipped when the
 * ledger already holds the key, recorded only once the row was actually sent,
 * so a request that could not be delivered is asked again next time.
 *
 * @returns Whether the request was emitted by this call.
 */
function askForReload(
  deps: EvaluateReadinessDeps,
  sessionId: string,
  reload: ReloadAsk,
  log: Logger,
): boolean {
  const key = reloadPromptKey(sessionId, reload);

  if (deps.reloadPrompts?.has(key) === true) {
    log.debug('The reload was already requested for this document', {
      tabId: reload.tabId,
      ...documentLogFields(reload.documentId),
    });
    return false;
  }

  if (deps.progress === undefined) {
    return false;
  }

  try {
    const sent = deps.progress.emit(sessionId, {
      stage: INSTRUMENT_STAGE,
      status: RUNNING_STATUS,
      message: RELOAD_REQUEST_MESSAGE,
      detail: reload.reason,
    });

    if (isErr(sent)) {
      log.warn('The reload request row was rejected and not sent', { code: sent.error.code });
      return false;
    }
  } catch (thrown) {
    log.warn('Emitting the reload request failed', exceptionFields(thrown));
    return false;
  }

  deps.reloadPrompts?.add(key);
  log.info('Asked the developer to reload the bound tab', {
    tabId: reload.tabId,
    ...documentLogFields(reload.documentId),
  });

  return true;
}

/** What one bounded wait for a tab's next `agent.ready` is about. */
interface NextAgentReadyWait {
  /** The tab whose next report is awaited. */
  readonly tabId: number;

  /** The document already known; only a report for another document answers. */
  readonly afterDocumentId: string | undefined;

  /** The port's deadline, in milliseconds; `0` does not wait at all. */
  readonly timeoutMs: number;

  /** Abandons the wait early; already aborted, the wait never starts. */
  readonly signal: AbortSignal | undefined;

  /** The `warn` line a rejecting port is logged with; the error's name is its only field. */
  readonly failureMessage: string;
}

/**
 * Waits, bounded, for a tab's next `agent.ready` — the one wait behind both the
 * navigation settle ({@link settleCurrentDocument}) and the reload.
 *
 * The port is asked for the next report whose document differs from
 * `afterDocumentId`. Its promise is raced against a backstop timer that fires
 * {@link WAIT_BACKSTOP_GRACE_MS} after the port's own deadline and against the
 * abort signal, and a rejection is contained — so this never waits longer than
 * the stated bound and never throws. The timer and listener are always
 * released.
 */
async function waitForNextAgentReady(
  agents: BrowserAgentRegistry,
  wait: NextAgentReadyWait,
  log: Logger,
): Promise<AgentReadyPayload | undefined> {
  const { tabId, afterDocumentId, timeoutMs, signal } = wait;

  if (timeoutMs <= 0 || signal?.aborted === true) {
    return undefined;
  }

  const options: WaitForAgentReadyOptions = {
    timeoutMs,
    ...(signal === undefined ? {} : { signal }),
    ...(afterDocumentId === undefined ? {} : { afterDocumentId }),
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const backstop = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, timeoutMs + WAIT_BACKSTOP_GRACE_MS);
    onAbort = () => {
      resolve(undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  const waited = Promise.resolve()
    .then(() => agents.waitForAgentReady(tabId, options))
    .catch((thrown: unknown) => {
      log.warn(wait.failureMessage, exceptionFields(thrown));
      return undefined;
    });

  try {
    return await Promise.race([waited, backstop]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }

    if (onAbort !== undefined) {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * When the registry received the report of `documentId`: its receipt time while
 * the registry still holds that very report and knows when it arrived,
 * `undefined` otherwise — and for a registry that throws — so the caller stamps
 * the report with its own clock instead.
 */
function receivedAtOf(
  agents: BrowserAgentRegistry,
  tabId: number,
  documentId: string,
): number | undefined {
  if (agents.latestAgentReadyAt === undefined) {
    return undefined;
  }

  try {
    if (agents.latestAgentReady(tabId)?.documentId !== documentId) {
      return undefined;
    }

    const receivedAt = agents.latestAgentReadyAt(tabId);
    return isEpochMs(receivedAt) ? receivedAt : undefined;
  } catch {
    return undefined;
  }
}

/** What {@link settleCurrentDocument} confirms, and with what. */
interface CurrentDocumentCheck {
  readonly agents: BrowserAgentRegistry;
  readonly boundTab: BoundTab;
  /** The bound tab's latest report, as {@link readBoundTabAgent} read it. */
  readonly agent: ObservedBrowserAgent | undefined;
  /** The resolved {@link EvaluateReadinessDeps.navigationSettleMs}. */
  readonly settleMs: number;
  readonly signal: AbortSignal | undefined;
  readonly clock: () => number;
  readonly log: Logger;
}

/**
 * Confirms that the report readiness is about to judge is the bound tab's
 * current document (see "The current document" in the module overview).
 *
 * A report on the page the binding records, with no navigation recorded after
 * it arrived ({@link isTrustedOnSight}), is returned as it is, without
 * waiting. One for another page — or received before the tab's latest recorded
 * navigation, as a reload or a same-URL load leaves it — is not trusted on
 * sight: the registry is asked, for at most `settleMs` plus the backstop
 * grace, for the document that replaced it ({@link waitForNextAgentReady}).
 *
 * - A report that arrives for the bound tab and origin with another document
 *   id is the current document. It is stamped with the registry's receipt time
 *   when the registry holds that document, else with the clock.
 * - A report that arrives for the bound tab from another origin is a document
 *   the binding no longer covers: no page agent is known for the current
 *   document, exactly as {@link readBoundTabAgent} reads such a report.
 * - Nothing within the bound — a zero wait, an aborted request, a timeout, a
 *   port that rejects or never answers, or an answer about another tab or the
 *   same document — means no replacement document announced itself. That is
 *   read as a navigation that stayed within one document (the history API),
 *   and the original report is kept.
 *
 * Never throws, and never waits longer than the stated bound.
 */
async function settleCurrentDocument(
  check: CurrentDocumentCheck,
): Promise<ObservedBrowserAgent | undefined> {
  const { agents, boundTab, agent, settleMs, signal, clock, log } = check;

  if (agent === undefined || isTrustedOnSight(agents, agent, boundTab)) {
    return agent;
  }

  const waited = settleMs > 0 && signal?.aborted !== true;
  const next = await waitForNextAgentReady(
    agents,
    {
      tabId: boundTab.tabId,
      afterDocumentId: agent.documentId,
      timeoutMs: settleMs,
      signal,
      failureMessage: 'Waiting for the page agent of the navigated document failed',
    },
    log,
  );

  if (next === undefined || next.tabId !== boundTab.tabId || next.documentId === agent.documentId) {
    log.debug('No new document announced itself on the bound page; keeping the latest report', {
      tabId: boundTab.tabId,
      waited,
    });
    return agent;
  }

  if (!describesBoundDocument(next, boundTab)) {
    log.debug('The document that replaced the report is outside the binding; no current report', {
      tabId: boundTab.tabId,
    });
    return undefined;
  }

  log.debug('The bound tab reported the document it navigated to', { tabId: boundTab.tabId });

  return toObservedBrowserAgent(
    next,
    receivedAtOf(agents, boundTab.tabId, next.documentId) ?? clock(),
  );
}

/** Validates an evaluation request. */
function checkEvaluateRequest(request: EvaluateReadinessRequest): Result<void, DebuggenError> {
  if (!isRecord(request) || !isRecord(request.context) || !isRecord(request.plan)) {
    return err(
      new DebuggenError('INTERNAL', 'Readiness was evaluated without a context and a plan.', {
        hint: 'Pass the instrumentation context and the normalised plan it was built for.',
        details: { field: 'request' },
      }),
    );
  }

  const { context, plan } = request;

  if (!isNonBlankString(context.sessionId)) {
    return err(
      new DebuggenError('INTERNAL', 'Readiness was evaluated for a context without a session id.', {
        hint: 'Build the context with the id of the session being evaluated.',
        details: { field: 'context.sessionId' },
      }),
    );
  }

  const projectRoot = normalizeProjectRoot(context.projectRoot);

  if (isErr(projectRoot)) {
    return projectRoot;
  }

  if (!Array.isArray(plan.instrumentationTargets)) {
    return err(
      new DebuggenError('INTERNAL', 'Readiness was evaluated for a plan without targets.', {
        hint: 'Pass the normalised instrumentation plan.',
        details: { field: 'plan.instrumentationTargets' },
      }),
    );
  }

  if (plan.sessionId !== context.sessionId || plan.planVersion !== context.planVersion) {
    return err(
      new DebuggenError(
        'INTERNAL',
        'Readiness was evaluated with a plan that does not belong to the context.',
        {
          hint: 'Evaluate each plan version with the context built for that session and plan version.',
          details: {
            field: 'plan',
            planVersion: plan.planVersion,
            contextPlanVersion: context.planVersion,
          },
        },
      ),
    );
  }

  return checkBoundTab(request.boundTab);
}

// ---------------------------------------------------------------------------
// Section I — evaluation
// ---------------------------------------------------------------------------

/**
 * Decides whether a session may enter `ready` — "Ready to capture".
 *
 * 1. **Planned signals** come from the upstream derivations over the plan's
 *    actions: `deriveAgentHookConfig` for the page agent and
 *    `deriveServerAgentSignals` for the dev-server preload.
 * 2. **Adapters** are the registry's — the one each action was normalised to
 *    and every applicable claimant of each action type — deduplicated and asked
 *    in registry order. A probe that fails is never an error: its signals read
 *    `unavailable`, so each stays deliverable only when another adapter's row
 *    confirms it.
 * 3. **Page facts** are read fresh for the bound tab, so the verdict describes
 *    the document open now, and handed to the adapters on a copy of the
 *    context; the context itself is never mutated. A report whose origin and
 *    path differ from the binding's URL, or that arrived before the tab's
 *    latest recorded navigation, is not trusted on sight: the document
 *    that replaced it is awaited for at most
 *    {@link EvaluateReadinessDeps.navigationSettleMs} and, when one reports,
 *    its facts are the ones judged; when none does, the navigation stayed
 *    within one document and the report is kept (see "The current document"
 *    in the module overview).
 * 4. **Gates** apply as the module overview's table states: a missing binding,
 *    a missing page agent and a page agent installed late
 *    (`installedBeforeReact` false) block every planned browser signal; a
 *    missing preload, a page without React and every adapter-reported gap
 *    degrade; nothing deliverable at all blocks.
 * 5. **The reload.** When a page gate blocks and the request allows it, one
 *    `running` row carrying {@link RELOAD_REQUEST_MESSAGE} is emitted — at
 *    most once per document — the next `agent.ready` is awaited for a bounded
 *    time, and the whole evaluation runs exactly once more on the new facts.
 *    A wait that times out returns the verdict with the reload still listed.
 * 6. **Ready.** On a satisfied verdict, `progress.readyToCapture` emits the
 *    "Ready to capture" row, whose wording that module owns.
 *
 * Returns `Err` only for programmer-level input problems — a context without a
 * session id or with a relative project root, a plan for another session or
 * plan version, a malformed binding. Every environmental fact is data in the
 * verdict (AAP §0.5.5). It writes nothing and drives nothing: the reload itself
 * is the Chrome service worker's, performed on the developer's consent.
 *
 * @param deps The injected collaborators.
 * @param request The context, the plan and the session's binding.
 * @returns The verdict, or the input error.
 *
 * @example
 * ```ts
 * const evidence = await collectReadinessEvidence(collectDeps, { sessionId, projectRoot, boundTab, plan });
 * // … build the context from evidence.value.observed and install the plan …
 * const verdict = await evaluateReadiness(
 *   { adapters, agents, progress, logger, reloadPrompts },
 *   { context, plan, boundTab, devServer: evidence.value.devServer },
 * );
 * if (verdict.ok && verdict.value.satisfied) {
 *   await manager.transitionTo(sessionId, 'ready', { readinessSatisfied: true });
 * }
 * ```
 */
export async function evaluateReadiness(
  deps: EvaluateReadinessDeps,
  request: EvaluateReadinessRequest,
): Promise<Result<ReadinessVerdict, DebuggenError>> {
  const checked = checkEvaluateRequest(request);

  if (isErr(checked)) {
    return checked;
  }

  const { context, plan, boundTab } = request;
  const sessionId = context.sessionId;
  const log = bindLogger(deps.logger, sessionId);
  const clock = totalClock(deps.now, log);
  const planned = derivePlannedSignals(plan.instrumentationTargets);
  const selection = selectAdapters(deps.adapters, context, plan.instrumentationTargets, log);

  const passInput = (browserAgent: ObservedBrowserAgent | undefined): PassInput => ({
    context,
    planned,
    selection,
    boundTab,
    browserAgent,
    devServer: request.devServer,
    requireServerAgent: request.requireServerAgent === true,
    clock,
    log,
  });

  const initialAgent =
    boundTab === undefined
      ? undefined
      : await settleCurrentDocument({
          agents: deps.agents,
          boundTab,
          agent: readBoundTabAgent(deps.agents, boundTab, clock, [], log),
          settleMs: resolveWaitMs(
            deps.navigationSettleMs,
            DEFAULT_NAVIGATION_SETTLE_MS,
            MAX_NAVIGATION_SETTLE_MS,
          ),
          signal: request.signal,
          clock,
          log,
        });
  let outcome = await evaluatePass(passInput(initialAgent));
  let reloadRequested = false;

  const reload = outcome.reload;

  if (
    reload !== undefined &&
    boundTab !== undefined &&
    request.allowReloadPrompt !== false &&
    request.signal?.aborted !== true
  ) {
    reloadRequested = askForReload(deps, sessionId, reload, log);

    const next = await waitForNextAgentReady(
      deps.agents,
      {
        tabId: reload.tabId,
        afterDocumentId: reload.documentId,
        timeoutMs: resolveWaitMs(deps.reloadWaitMs, DEFAULT_RELOAD_WAIT_MS, MAX_RELOAD_WAIT_MS),
        signal: request.signal,
        failureMessage: 'Waiting for the reloaded page agent failed',
      },
      log,
    );

    if (
      next !== undefined &&
      describesBoundDocument(next, boundTab) &&
      (reload.documentId === undefined || next.documentId !== reload.documentId)
    ) {
      log.info('The bound tab reported a new document; evaluating readiness again', {
        tabId: boundTab.tabId,
        ...documentLogFields(next.documentId),
      });
      outcome = await evaluatePass(passInput(toObservedBrowserAgent(next, clock())));
    } else {
      log.info('No new page-agent report arrived after the reload request', {
        tabId: boundTab.tabId,
      });
    }
  }

  const verdict: ReadinessVerdict = {
    satisfied: outcome.satisfied,
    perAdapter: outcome.perAdapter,
    blocking: outcome.blocking,
    degraded: outcome.degraded,
    remediations: outcome.remediations,
    plannedSignals: planned.ordered,
    deliverableSignals: outcome.deliverable,
    evaluatedAt: clock(),
    observed: outcome.observed,
    reloadRequested,
  };

  if (verdict.satisfied && request.announceReady !== false && deps.progress !== undefined) {
    try {
      const sent = deps.progress.readyToCapture(sessionId);

      if (isErr(sent)) {
        log.warn('The ready-to-capture row was rejected and not sent', { code: sent.error.code });
      }
    } catch (thrown) {
      log.warn('Emitting the ready-to-capture row failed', exceptionFields(thrown));
    }
  }

  log.info('Readiness evaluated', {
    satisfied: verdict.satisfied,
    planVersion: plan.planVersion,
    plannedSignals: verdict.plannedSignals,
    deliverableSignals: verdict.deliverableSignals,
    blockingSignals: verdict.blocking.map((gap) => gap.signal),
    degradedSignals: verdict.degraded.map((gap) => gap.signal),
    remediations: verdict.remediations.map((remediation) => remediation.kind),
    adapters: verdict.perAdapter.map((report) => report.adapterId),
    reloadRequested,
  });

  return ok(verdict);
}
