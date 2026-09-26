/**
 * The lifecycle of the page-side telemetry agent: when it is armed, when it is
 * re-armed after a reload or a same-origin navigation, when it is returned to
 * dormancy, and the single circumstance in which the extension asks Chrome to
 * reload the developer's page.
 *
 * ## The agent this module steers
 *
 * The MAIN-world agent (`public/agent.iife.js`, copied verbatim from
 * `@debuggen/telemetry`'s build) and the isolated-world bridge
 * (`../content/bridge.ts`) are **statically declared** `document_start`
 * content scripts for the local app origins (AAP §0.1.1, §0.7.1 Group 4). Both
 * run on every load and both stay dormant until this module forwards an
 * `agent.config`. Nothing here injects, registers or evaluates code: the
 * extension's permission set is exactly `storage`, `alarms` and `tabs`, and the
 * only `chrome.*` capability this module uses is the tab reload, reached
 * through the injected {@link AgentTabsApi}.
 *
 * ## What it does
 *
 * - **Arming** ({@link AgentControl.applyConfig}). The service's `agent.config`
 *   is routed to the tab bound to the configuration's session — resolved
 *   through the injected {@link AgentBindingLookup}, never guessed — and
 *   recorded as that tab's *desired state*. When no bridge is attached yet the
 *   configuration is held, not dropped: the page may still be loading or be
 *   mid-navigation, and the next `agent.ready` delivers it (AAP §0.5.5).
 * - **Readiness and re-arming** ({@link AgentControl.handleAgentReady}). The
 *   page agent owns no socket, so its `agent.ready` is relayed upward with the
 *   `tabId` the bridge port's sender supplied (AAP §0.4.2). The report is
 *   memoised per tab with its `documentId`, and the desired configuration is
 *   re-sent — which is how a mid-capture reload continues the **same**
 *   `captureId` (AAP §0.5.5, "the same `captureId` continues").
 * - **The consented reload** ({@link AgentControl.requestConsentedReload},
 *   offered through {@link AgentControl.getReloadOffer}). Two states of a page
 *   that was open before the extension have one remedy, a reload: the last
 *   report says the React hook arrived after React
 *   (`installedBeforeReact === false`), or no agent runs in the tab at all —
 *   no report and no content-script bridge, because Chrome injects the
 *   manifest's `document_start` scripts only into documents that load after
 *   the extension is enabled. The reload happens here, only here, and only as
 *   the answer to the panel's explicit `page.reload` request; the wait for the
 *   new document's `agent.ready` is bounded by {@link PENDING_READY_TIMEOUT_MS}.
 * - **Dormancy** ({@link AgentControl.disarm}). An all-false hook set is the
 *   instruction that detaches every listener, restores the `fetch`/XHR patch and
 *   unsubscribes the fiber-hook handlers (AAP §0.4.2, §0.5.1) — hooks are
 *   *disabled*, not idled. The service's own all-false `agent.config` is
 *   forwarded as it arrives; a local disarm derives the dormant set
 *   mechanically from the last received configuration's own hook keys, so no
 *   hook name is ever spelled in this file.
 * - **Navigation** ({@link AgentControl.handleNavigationDecision}).
 *   `tab-registry.ts` classifies a committed navigation; this module acts on
 *   the verdict — re-arm on the same origin, forget the tab on another.
 *
 * ## Invariants
 *
 * - **Configuration reaches only the bound tab.** A configuration is sent to
 *   exactly one tab per session; a tab displaced by a new binding is returned
 *   to dormant, and a document whose origin differs from the bound origin is
 *   never handed the session's configuration (it is held until the navigation
 *   verdict arrives), so session and capture ids cannot leak to another app.
 * - **No import-time side effect and no module-level mutable state.** Every
 *   top-level statement is a declaration; all state lives in the closure of
 *   {@link createAgentControl}. `apps/chrome-extension/test/agent-control.test.ts`
 *   constructs it with fakes for every dependency.
 * - **No expected condition throws.** A missing bridge, an unbound session, a
 *   stale report, a failed or timed-out reload — each is a typed outcome.
 * - **Privacy.** Logs carry `tabId`, `sessionId`, `captureId`, document
 *   fingerprints and decisions only: never a page URL, a hook value, event
 *   contents or a credential (AAP §0.5.2). A document id is page-supplied, so
 *   it is logged only as its `fingerprintPageId` digest — with, where a report
 *   is first seen, whether it has the canonical shape — and kept raw only in
 *   state and in the relayed `agent.ready`.
 *
 * Governed by AAP §0.5.5 ("Application reloads mid-session"), §0.7.1 Group 2
 * (`instrumentation/readiness.ts`: readiness for the bound tab's current
 * document, the one-click consented reload) and Group 4, §0.4.2 (`agent.config`,
 * `agent.ready`), §0.5.1 (the end-of-session guarantee) and §0.1.1 (the dormant,
 * statically declared MAIN-world agent).
 *
 * @module apps/chrome-extension/src/background/agent-control
 */

import type { AgentConfigPayload, AgentHookConfig, AgentReadyPayload } from '@debuggen/protocol';
import type { CaptureId, Logger, SessionId } from '@debuggen/shared';
import { noopLogger, nowEpochMs } from '@debuggen/shared';

import type {
  BridgeDownstreamMessage,
  PageAgentReadyPayload,
  PanelReloadReason,
  PanelReloadState,
  PortBindingPush,
} from '../shared/messages';
import {
  EXTENSION_CHANNEL,
  fingerprintPageId,
  isPageDocumentId,
  PANEL_RELOAD_NOT_NEEDED,
  PORT_PROTOCOL_VERSION,
} from '../shared/messages';
import type {
  AgentReadinessState,
  BridgeSend,
  PortPushSink,
  ProtocolSend,
  TabBindingRecord,
  WorkerClock,
  WorkerTimerApi,
} from './messages';
import { workerError } from './messages';

/*
 * ===========================================================================
 * Section A — derived primitives
 * ===========================================================================
 */

/** A Chrome tab id, exactly as the protocol's `agent.ready` payload types it. */
type TabId = AgentReadyPayload['tabId'];

/** The page agent's per-document id, as `agent.ready` carries it. */
type DocumentId = AgentReadyPayload['documentId'];

/** A wall-clock instant in Unix epoch milliseconds, the shared time base. */
type EpochMs = ReturnType<typeof nowEpochMs>;

/*
 * ===========================================================================
 * Section B — constants
 * ===========================================================================
 */

/**
 * How long a consented reload waits for the new document's `agent.ready`
 * before it reports a timeout: twenty seconds.
 *
 * The agent posts `agent.ready` from `document_start`, so on a warm dev server
 * the report arrives well under a second after the reload. The bound is set by
 * the slow case instead — a development server that recompiles the route on
 * the reload before it answers — while still guaranteeing that the developer's
 * one-click reload resolves to a definite outcome rather than a spinner that
 * never stops. Tests assert against this constant, never a copied number.
 */
export const PENDING_READY_TIMEOUT_MS = 20_000;

/**
 * The `reloading` reload state, frozen: what {@link AgentControl.getReloadOffer}
 * answers while a consented reload awaits the new document's `agent.ready`.
 */
const RELOAD_IN_FLIGHT: PanelReloadState = Object.freeze({ kind: 'reloading' });

/*
 * ===========================================================================
 * Section C — the injection surface
 * ===========================================================================
 */

/**
 * The tab of the binding a configuration's session holds, and that binding's
 * origin.
 *
 * A projection of `TabBindingRecord` rather than a restatement, so the record
 * `tab-registry.ts` keeps satisfies it as it is. `origin` is what keeps a
 * session's configuration off a document of any other origin.
 */
export type AgentBindingTarget = Pick<TabBindingRecord, 'tabId' | 'origin'>;

/**
 * Resolve the tab currently bound to a session.
 *
 * Supplied by `service-worker.ts` from the tab registry (which may have to
 * hydrate from `chrome.storage.session` after a worker revival, hence the
 * promise form). `undefined` means no tab is bound to that session. A lookup
 * that throws or rejects is handled like an absent binding.
 */
export type AgentBindingLookup = (
  sessionId: SessionId,
) => AgentBindingTarget | undefined | PromiseLike<AgentBindingTarget | undefined>;

/**
 * The single `chrome.tabs` operation this module performs, and nothing more.
 *
 * `chrome.tabs` itself satisfies it — {@link ChromeTabsSatisfiesAgentTabsApi}
 * proves that at compile time — so `service-worker.ts` passes the real
 * namespace and a test passes a one-method fake.
 */
export interface AgentTabsApi {
  /** Reload the tab; resolves once Chrome has started the reload. */
  reload(tabId: TabId): Promise<void>;
}

/** Fails to compile unless its argument is exactly `true`. */
type AssertTrue<Assertion extends true> = Assertion;

/**
 * Compile-time proof that the real `chrome.tabs` namespace is assignable to
 * {@link AgentTabsApi}; if `@types/chrome` changes `reload` incompatibly,
 * `tsc -b` fails here rather than at the wiring in `service-worker.ts`.
 * Type-level only: it emits nothing.
 */
export type ChromeTabsSatisfiesAgentTabsApi = AssertTrue<
  typeof chrome.tabs extends AgentTabsApi ? true : false
>;

/*
 * ===========================================================================
 * Section D — outcomes and inputs
 *
 * Every public operation answers with one of these discriminated unions, so
 * `service-worker.ts` and the tests branch exhaustively on `kind` and every
 * recovery state of AAP §0.5.5 is observable rather than inferred.
 * ===========================================================================
 */

/**
 * What became of one attempt to hand the desired configuration to a tab.
 *
 * - `delivered` — the tab's bridge port took the frame.
 * - `pending-bridge` — no bridge is attached (the page has not loaded yet, is
 *   mid-navigation or reloading); the configuration is held and delivered on
 *   the tab's next `agent.ready`.
 * - `pending-navigation` — the tab's latest document reported an origin other
 *   than the bound one; the configuration is withheld until the navigation
 *   verdict arrives, so it never reaches another app's page.
 */
export type ConfigDelivery = 'delivered' | 'pending-bridge' | 'pending-navigation';

/** The answer to {@link AgentControl.applyConfig}. */
export type ApplyConfigOutcome =
  | {
      /** The configuration is now the tab's desired state. */
      readonly kind: 'routed';
      readonly tabId: TabId;
      readonly sessionId: SessionId;
      readonly captureId: CaptureId;
      /** Whether every hook in the configuration is off. */
      readonly dormant: boolean;
      readonly delivery: ConfigDelivery;
    }
  | {
      /**
       * No tab is bound to the session, so nothing was armed. A tab that still
       * held an armed configuration for it was returned to dormant.
       */
      readonly kind: 'not-bound';
      readonly sessionId: SessionId;
      readonly captureId: CaptureId;
      readonly reason: 'no-binding' | 'lookup-failed';
    }
  | {
      /** The target tab was cleared, or the controller disposed, mid-lookup. */
      readonly kind: 'discarded';
      readonly sessionId: SessionId;
      readonly captureId: CaptureId;
      readonly reason: 'tab-cleared' | 'disposed';
    };

/** The answer to {@link AgentControl.handleAgentReady}. */
export type AgentReadyOutcome =
  | {
      /**
       * The report came from the document a consented reload replaced — a
       * re-announcement by its bridge before it unloaded. It was not relayed,
       * memoised or answered, so it cannot be mistaken for the new document.
       */
      readonly kind: 'stale';
      readonly tabId: TabId;
      readonly documentId: DocumentId;
    }
  | {
      /** The report is the tab's current readiness. */
      readonly kind: 'recorded';
      readonly tabId: TabId;
      readonly readiness: AgentReadinessState;
      /** Whether the protocol `agent.ready` was handed to the socket client. */
      readonly relayed: boolean;
      /**
       * Whether a consented reload would help: the hook was installed after
       * React. The prompt itself is the service's readiness progress; this
       * flag only says the offer stands.
       */
      readonly reloadOffered: boolean;
      /** The desired configuration's re-delivery, or `none` if there is none. */
      readonly config: ConfigDelivery | 'none';
    };

/**
 * Why a reload request was refused because it answers no outstanding offer.
 *
 * - `no-agent-report` — no `agent.ready` has been recorded for the tab's
 *   current document, but its content-script bridge is attached: the agent is
 *   present and still loading, and its report will say whether a reload helps.
 * - `hook-installed-before-react` — the current document's agent was in place
 *   before React; a reload would change nothing.
 */
export type ReloadRefusalReason = 'no-agent-report' | 'hook-installed-before-react';

/** The answer to {@link AgentControl.requestConsentedReload}. */
export type ReloadOutcome =
  | {
      /** The reloaded document's agent reported in. */
      readonly kind: 'ready';
      readonly tabId: TabId;
      readonly readiness: AgentReadinessState;
    }
  | {
      /** No `agent.ready` arrived within {@link PENDING_READY_TIMEOUT_MS}. */
      readonly kind: 'timeout';
      readonly tabId: TabId;
      readonly timeoutMs: number;
    }
  | {
      /**
       * The tab could not be reloaded (`reload-failed`: Chrome refused, most
       * often because the tab is gone) or was forgotten while the reload was in
       * flight (`cleared`: the tab closed, the binding ended, or the controller
       * was disposed).
       */
      readonly kind: 'no-tab';
      readonly tabId: TabId;
      readonly reason: 'reload-failed' | 'cleared';
    }
  | {
      /** The request answers no outstanding reload offer; nothing was reloaded. */
      readonly kind: 'not-consented';
      readonly tabId: TabId;
      readonly reason: ReloadRefusalReason;
    };

/**
 * Why the worker is disarming a tab locally. Recorded in logs and in the
 * change notification; it does not alter what is sent.
 *
 * - `unbound` — the binding ended (DevTools closed, the tab left the session).
 * - `session-ended` — the session ended and cleanup ran.
 * - `displaced` — another tab took this tab's session.
 * - `service-lost` — the worker gave up on the local service.
 * - `requested` — any other explicit caller decision.
 */
export type DisarmReason = 'unbound' | 'session-ended' | 'displaced' | 'service-lost' | 'requested';

/** The answer to {@link AgentControl.disarm}. */
export type DisarmOutcome =
  | {
      /** No configuration was ever received for the tab: nothing to disarm. */
      readonly kind: 'not-armed';
      readonly tabId: TabId;
    }
  | {
      /** The tab's desired state is now the dormant configuration. */
      readonly kind: 'disarmed';
      readonly tabId: TabId;
      readonly sessionId: SessionId;
      readonly captureId: CaptureId;
      readonly delivery: ConfigDelivery;
    };

/**
 * The navigation verdict this module consumes, as `tab-registry.ts` produces it
 * for a committed navigation of a tracked tab (AAP §0.2.3, §0.5.5).
 *
 * Declared here as this module's *input* contract, structurally, because the
 * folder's behavioural modules never import one another (see `./messages`);
 * `service-worker.ts` passes the registry's decision straight through. The
 * three verdicts:
 *
 * - `kept-same-origin` — the binding survived; re-arm the new document with the
 *   same configuration (the registry's preserved `captureId` rides along for
 *   the log line, the configuration itself carries the authoritative one);
 * - `unbound-cross-origin` — the tab left the bound origin and the binding was
 *   dropped;
 * - `not-bound` — the tab holds no binding.
 */
export type AgentNavigationDecision =
  | {
      readonly kind: 'kept-same-origin';
      readonly tabId: TabId;
      readonly sessionId: SessionId;
      readonly captureId?: CaptureId | undefined;
    }
  | {
      readonly kind: 'unbound-cross-origin';
      readonly tabId: TabId;
      readonly sessionId?: SessionId | undefined;
    }
  | {
      readonly kind: 'not-bound';
      readonly tabId: TabId;
    };

/** The answer to {@link AgentControl.handleNavigationDecision}. */
export type NavigationOutcome =
  | {
      /** Same origin: the desired configuration was re-sent or is held. */
      readonly kind: 're-armed';
      readonly tabId: TabId;
      readonly delivery: ConfigDelivery;
    }
  | {
      /** Same origin, but no configuration was ever received for the tab. */
      readonly kind: 'no-config';
      readonly tabId: TabId;
    }
  | {
      /** The tab's desired configuration, readiness and reload wait were dropped. */
      readonly kind: 'cleared';
      readonly tabId: TabId;
    }
  | {
      /** The tab was not tracked here; nothing to do. */
      readonly kind: 'ignored';
      readonly tabId: TabId;
    };

/**
 * A structured, sentence-free notification of a state change, for
 * `service-worker.ts` to fold into the status it shows panels (the readiness
 * behind the consented-reload offer, a reload in flight, a tab returned to
 * dormant). Every user-facing sentence stays with its owners: the service's
 * readiness progress and the vocabulary of `../shared/messages`.
 */
export type AgentControlChange =
  | {
      readonly kind: 'config-routed';
      readonly tabId: TabId;
      readonly sessionId: SessionId;
      readonly captureId: CaptureId;
      readonly dormant: boolean;
      readonly delivery: ConfigDelivery;
    }
  | {
      readonly kind: 'agent-ready';
      readonly tabId: TabId;
      readonly readiness: AgentReadinessState;
      readonly reloadOffered: boolean;
    }
  | {
      readonly kind: 'reload-started';
      readonly tabId: TabId;
      /**
       * The document the reload replaces; `undefined` when no agent had
       * reported for the tab (a page loaded before the extension was enabled).
       */
      readonly previousDocumentId: DocumentId | undefined;
    }
  | {
      readonly kind: 'reload-settled';
      readonly tabId: TabId;
      readonly outcome: ReloadOutcome;
    }
  | {
      readonly kind: 'disarmed';
      readonly tabId: TabId;
      readonly sessionId: SessionId;
      readonly captureId: CaptureId;
      readonly reason: DisarmReason;
      readonly delivery: ConfigDelivery;
    }
  | {
      readonly kind: 'cleared';
      readonly tabId: TabId;
    };

/** Receives every {@link AgentControlChange}. Must not throw; if it does, the throw is logged and ignored. */
export type AgentControlListener = (change: AgentControlChange) => void;

/**
 * Everything {@link createAgentControl} is handed. Every member is a contract
 * declared in `./messages` or here; `service-worker.ts` supplies the real
 * implementations and a unit test supplies recording fakes.
 */
export interface AgentControlDeps {
  /**
   * Send one frame to a tab's content-script bridge. `false` — no bridge
   * attached — is the recoverable "held" state, never an error.
   */
  readonly sendToBridge: BridgeSend;
  /** Send one protocol frame to the service; used to relay `agent.ready`. */
  readonly send: ProtocolSend;
  /** Resolve the tab bound to a configuration's session. */
  readonly resolveBinding: AgentBindingLookup;
  /** The tab reload, for the consented reload only. */
  readonly tabs: AgentTabsApi;
  /** One-shot timers for the bounded wait after a consented reload. */
  readonly timers: WorkerTimerApi;
  /**
   * Whether a content-script bridge is attached for a tab — the port hub's
   * `hasBridge`. Read only by the consent rule, to tell a tab whose agent has
   * simply not reported yet (a bridge is attached: nothing to offer) from a
   * tab with no agent at all (no bridge: a page loaded before the extension
   * was enabled, which only a reload can give an agent).
   *
   * Defaults to `() => true`, the conservative reading: without the fact, a
   * tab with no report is assumed to have an agent on its way, so a reload is
   * never offered on the strength of a missing report alone. A lookup that
   * throws is read the same way.
   */
  readonly hasBridge?: ((tabId: TabId) => boolean) | undefined;
  /** The epoch-millisecond clock stamping `receivedAt`; defaults to `nowEpochMs`. */
  readonly now?: WorkerClock['now'] | undefined;
  /**
   * Push to the panels of one tab. Used for one state: after the agent of a
   * bound tab's current document reports in and is re-armed, the tab's
   * binding line is refreshed with that document's (query-redacted) URL, in
   * the binding vocabulary of `../shared/messages`.
   */
  readonly pushStatus?: PortPushSink | undefined;
  /** Receives every {@link AgentControlChange}. */
  readonly onChange?: AgentControlListener | undefined;
  /** Diagnostics; defaults to `noopLogger`. */
  readonly logger?: Logger | undefined;
}

/** The agent controller: one per service-worker generation. */
export interface AgentControl {
  /**
   * Route the service's `agent.config` to the tab bound to its session, record
   * it as that tab's desired state and forward it to the tab's bridge — or hold
   * it until the bridge attaches. Calls are applied strictly in arrival order.
   *
   * @param config The inbound protocol payload, as the socket client validated it.
   * @returns Where the configuration went; never rejects.
   */
  applyConfig(config: AgentConfigPayload): Promise<ApplyConfigOutcome>;

  /**
   * Record a page agent's `agent.ready`, relay it upward with the tab filled
   * in, re-send the tab's desired configuration and answer a pending consented
   * reload.
   *
   * @param tabId The tab of the bridge port the report arrived on (its sender).
   * @param payload The page-channel payload, which cannot know its own tab.
   */
  handleAgentReady(tabId: TabId, payload: PageAgentReadyPayload): AgentReadyOutcome;

  /**
   * Act on `tab-registry.ts`'s verdict for a committed navigation: re-arm on
   * the same origin, forget the tab on another.
   */
  handleNavigationDecision(decision: AgentNavigationDecision): NavigationOutcome;

  /**
   * Reload a tab whose agent cannot observe its page, then wait — at most
   * {@link PENDING_READY_TIMEOUT_MS} — for the new document's `agent.ready`.
   *
   * **Calling this is the developer's consent.** `service-worker.ts` is its
   * only caller and invokes it solely from the panel's `page.reload` request
   * (declared in `../shared/messages`), which the panel sends only from the
   * developer's click on the one-click reload action — never from a timer, a
   * readiness report or a navigation. The request must also answer a standing
   * offer, by the one rule {@link getReloadOffer} states — the tab's last
   * report said `installedBeforeReact === false`, or the tab has neither a
   * report nor a bridge — or nothing is reloaded (`not-consented`). With no
   * report the reload settles on the first `agent.ready` that arrives. A
   * second request while one is in flight shares the first one's outcome.
   */
  requestConsentedReload(tabId: TabId): Promise<ReloadOutcome>;

  /**
   * Whether the one-click reload is offered for a tab, by the same rule
   * {@link requestConsentedReload} applies — so the panel is offered exactly
   * the reloads the worker would perform:
   *
   * - a consented reload in flight → `reloading`;
   * - the current document's agent reported → `offered` for
   *   `hook-after-react` when the hook arrived after React, otherwise
   *   `not-needed`;
   * - no report → `not-needed` while a content-script bridge is attached (the
   *   agent is present and will report), otherwise `offered` for
   *   `agent-missing` (a page loaded before the extension was enabled).
   *
   * Pure: nothing is sent, scheduled or reloaded. Whether the tab is bound is
   * the caller's question — an unbound tab is never offered a reload.
   */
  getReloadOffer(tabId: TabId): PanelReloadState;

  /**
   * Return a tab's agent to dormant with an all-false configuration derived
   * from the last received configuration's own hook keys. A tab that never
   * received one is left alone.
   */
  disarm(tabId: TabId, reason?: DisarmReason): DisarmOutcome;

  /**
   * Relay a tab's last `agent.ready` upward again — for instance after the tab
   * was bound, so the service's readiness gate sees the current document
   * without waiting for another load.
   *
   * @returns Whether a report was known and the socket client took it.
   */
  reannounce(tabId: TabId): boolean;

  /** The readiness of the tab's current document, if its agent has reported. */
  getReadiness(tabId: TabId): AgentReadinessState | undefined;

  /** The configuration the tab should be running, if one was received. */
  getDesiredConfig(tabId: TabId): AgentConfigPayload | undefined;

  /** Whether a consented reload of the tab is awaiting its `agent.ready`. */
  isReloadPending(tabId: TabId): boolean;

  /**
   * Drop every piece of state held for the tab — on tab close and when the
   * binding is gone for good — settling a pending reload as `no-tab`.
   */
  clear(tabId: TabId): void;

  /** Clear every tab; in-flight configuration lookups are discarded. */
  dispose(): void;
}

/*
 * ===========================================================================
 * Section E — private state and pure helpers
 * ===========================================================================
 */

/** A consented reload awaiting the new document's `agent.ready`. */
interface PendingReload {
  /**
   * The document the reload replaces; its reports are stale from now on.
   * `undefined` when no agent had reported for the tab, in which case the
   * first `agent.ready` that arrives settles the reload.
   */
  readonly previousDocumentId: DocumentId | undefined;
  /**
   * The readiness memo the reload cleared, restored if Chrome refuses the
   * reload; `undefined` when there was none, and then nothing is restored.
   */
  readonly previousReadiness: AgentReadinessState | undefined;
  /** The report the reload cleared, restored alongside {@link previousReadiness}. */
  readonly previousReport: AgentReadyPayload | undefined;
  /** Shared by every request for this reload. */
  readonly promise: Promise<ReloadOutcome>;
  /** Resolves {@link promise}. */
  readonly resolve: (outcome: ReloadOutcome) => void;
  /** Whether the outcome is decided; the first settlement wins. */
  settled: boolean;
  /** The bounded-wait timer, once scheduled. */
  timer: number | undefined;
}

/** Everything held for one tab. */
interface TabState {
  /**
   * The last configuration received for this tab — the object itself — or the
   * dormant configuration derived from it by a local disarm.
   */
  desired: AgentConfigPayload | undefined;
  /** The origin of the binding the desired configuration was routed by. */
  boundOrigin: string | undefined;
  /**
   * Whether the tab is still bound to the desired configuration's session, as
   * far as this module was told: set when a configuration is routed through a
   * binding, cleared by a disarm for a binding that ended.
   */
  bound: boolean;
  /** The memo of the current document's `agent.ready`. */
  readiness: AgentReadinessState | undefined;
  /**
   * The current document's full report, kept only to re-announce it; its URL
   * was query-redacted by the agent and is never logged.
   */
  lastReport: AgentReadyPayload | undefined;
  /**
   * The serialized origin of the current document, parsed from its report;
   * `'null'` when the URL is opaque or unparseable, `undefined` before any
   * report for the current document.
   */
  documentOrigin: string | undefined;
  /** The document the last consented reload replaced. */
  retiredDocumentId: DocumentId | undefined;
  /** The consented reload in flight, if any. */
  reload: PendingReload | undefined;
}

/**
 * The consent rule's verdict for one tab — the single decision behind both
 * {@link AgentControl.getReloadOffer} and
 * {@link AgentControl.requestConsentedReload}, so the offer the panel shows
 * and the reload the worker performs can never disagree.
 */
type ConsentVerdict =
  | {
      /** A consented reload is in flight; a new request shares it. */
      readonly kind: 'in-flight';
      readonly pending: PendingReload;
    }
  | {
      /** A reload would help, for `reason`. */
      readonly kind: 'offered';
      readonly reason: PanelReloadReason;
    }
  | {
      /** A reload would not help; a request is refused for `reason`. */
      readonly kind: 'not-needed';
      readonly reason: ReloadRefusalReason;
    };

/** Whether every hook of a configuration is off — the dormancy instruction. */
function isDormantConfig(config: AgentConfigPayload): boolean {
  return Object.values(config.hooks).every((enabled) => !enabled);
}

/** Whether a key is one of the hook set's own keys. */
function isHookKey(hooks: AgentHookConfig, key: string): key is keyof AgentHookConfig {
  return Object.hasOwn(hooks, key);
}

/**
 * The dormant configuration for a received one: the same session, the same
 * capture, and every one of *its own* hook keys mapped to `false`.
 *
 * Mechanical on purpose. `AgentHookConfig` is owned by
 * `@debuggen/instrumentation` and reaches this file through the protocol; a
 * local list of hook names would be a second definition that keeps disarming
 * the old set when a hook is added upstream.
 */
function dormantConfigFrom(config: AgentConfigPayload): AgentConfigPayload {
  const hooks: AgentHookConfig = { ...config.hooks };
  for (const key of Object.keys(hooks)) {
    if (isHookKey(hooks, key)) {
      hooks[key] = false;
    }
  }
  return { sessionId: config.sessionId, captureId: config.captureId, hooks };
}

/**
 * The serialized origin of a document URL; `'null'` — the serialization of an
 * opaque origin, which never equals a bound one — when the URL cannot be
 * parsed. Parsed with the platform `URL`, never compared by string prefix.
 */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'null';
  }
}

/** The name of a thrown value, for a log line that must not carry its message. */
function errorName(cause: unknown): string {
  return cause instanceof Error ? cause.name : typeof cause;
}

/** How a log line names a page document without carrying its page-supplied id. */
interface DocumentLogFields {
  /** The id's {@link fingerprintPageId} digest. */
  readonly document: string;
  /** Whether the id has the agent's canonical `doc_…` shape. */
  readonly documentIdCanonical: boolean;
}

/**
 * The log fields for a document the page reported.
 *
 * `documentId` arrives in the page-originated `agent.ready`, so a page script
 * can put any bounded text there (CWE-532). A log line therefore carries its
 * fingerprint and a shape verdict only; the raw id stays in the readiness memo
 * and the relayed report, where the stale-report check and the service's
 * readiness gate need it.
 *
 * @param documentId The document id as the page reported it.
 */
function documentLogFields(documentId: DocumentId): DocumentLogFields {
  return {
    document: fingerprintPageId(documentId),
    documentIdCanonical: isPageDocumentId(documentId),
  };
}

/** Whether a disarm reason means the tab no longer holds the session's binding. */
function endsBinding(reason: DisarmReason): boolean {
  switch (reason) {
    case 'unbound':
    case 'session-ended':
    case 'displaced':
      return true;
    case 'service-lost':
    case 'requested':
      return false;
  }
}

/*
 * ===========================================================================
 * Section F — the factory
 * ===========================================================================
 */

/**
 * Create the agent controller.
 *
 * Pure construction: nothing is sent, scheduled or subscribed until a method is
 * called, and all state lives in this closure.
 *
 * @example
 * ```ts
 * const agents = createAgentControl({
 *   sendToBridge: ports.sendToBridge,
 *   send: (type, payload, options) => client.send(type, payload, options),
 *   // (sessionId) => { tabId, origin } | undefined, answered by the tab registry
 *   resolveBinding: lookupBoundTab,
 *   tabs: chrome.tabs,
 *   timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) },
 *   hasBridge: ports.hasBridge,
 *   pushStatus: ports.pushToTab,
 *   logger,
 * });
 * subscribe('agent.config', (message) => void agents.applyConfig(message.payload));
 * // The panel's `page.reload` request — the developer's consent — and nothing else:
 * if (agents.getReloadOffer(tabId).kind !== 'not-needed') {
 *   const outcome = await agents.requestConsentedReload(tabId);
 * }
 * ```
 */
export function createAgentControl(deps: AgentControlDeps): AgentControl {
  const log = (deps.logger ?? noopLogger).child({ module: 'agent-control' });
  const now: () => EpochMs = deps.now ?? nowEpochMs;

  /** Per-tab state; an entry exists only while something is held for the tab. */
  const tabs = new Map<TabId, TabState>();

  /** Bumped by {@link AgentControl.dispose}; an older in-flight lookup is discarded. */
  let generation = 0;
  /** Bumped by every {@link AgentControl.clear}. */
  let clearSeq = 0;
  /** The `clearSeq` at which a tab was cleared, kept only while lookups are in flight. */
  const clearedAt = new Map<TabId, number>();
  /** How many `applyConfig` lookups are awaiting their binding. */
  let appliesInFlight = 0;
  /** The tail of the `applyConfig` queue, which keeps configurations in arrival order. */
  let applyTail: Promise<unknown> = Promise.resolve();

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  function stateFor(tabId: TabId): TabState {
    const existing = tabs.get(tabId);
    if (existing !== undefined) {
      return existing;
    }
    const created: TabState = {
      desired: undefined,
      boundOrigin: undefined,
      bound: false,
      readiness: undefined,
      lastReport: undefined,
      documentOrigin: undefined,
      retiredDocumentId: undefined,
      reload: undefined,
    };
    tabs.set(tabId, created);
    return created;
  }

  /** Drop a tab's entry once it holds nothing at all. */
  function pruneIfEmpty(tabId: TabId, state: TabState): void {
    if (
      state.desired === undefined &&
      state.readiness === undefined &&
      state.reload === undefined &&
      state.retiredDocumentId === undefined &&
      tabs.get(tabId) === state
    ) {
      tabs.delete(tabId);
    }
  }

  function emit(change: AgentControlChange): void {
    if (deps.onChange === undefined) {
      return;
    }
    try {
      deps.onChange(change);
    } catch (cause) {
      log.warn('agent-control listener threw', {
        tabId: change.tabId,
        change: change.kind,
        error: errorName(cause),
      });
    }
  }

  /**
   * Whether a content-script bridge is attached for the tab, read through the
   * injected lookup; absent or throwing, the conservative `true` (see
   * {@link AgentControlDeps.hasBridge}).
   */
  function bridgeAttached(tabId: TabId): boolean {
    if (deps.hasBridge === undefined) {
      return true;
    }
    try {
      return deps.hasBridge(tabId);
    } catch (cause) {
      log.warn('bridge lookup threw', { tabId, error: errorName(cause) });
      return true;
    }
  }

  /** Refresh the tab's binding line after its current document was re-armed. */
  function pushBound(tabId: TabId, sessionId: SessionId, url: string): void {
    if (deps.pushStatus === undefined) {
      return;
    }
    const push: PortBindingPush = {
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'push',
      kind: 'binding',
      state: { kind: 'bound', sessionId, tabId, url },
    };
    try {
      deps.pushStatus(tabId, push);
    } catch (cause) {
      log.warn('binding push threw', { tabId, sessionId, error: errorName(cause) });
    }
  }

  /**
   * Hand a configuration to the tab's bridge, unless the tab's latest document
   * reported an origin other than the bound one.
   */
  function deliver(tabId: TabId, state: TabState, config: AgentConfigPayload): ConfigDelivery {
    if (
      state.boundOrigin !== undefined &&
      state.documentOrigin !== undefined &&
      state.documentOrigin !== state.boundOrigin
    ) {
      return 'pending-navigation';
    }
    const frame: BridgeDownstreamMessage = {
      channel: EXTENSION_CHANNEL,
      version: PORT_PROTOCOL_VERSION,
      direction: 'downstream',
      type: 'agent.config',
      payload: config,
    };
    let taken: boolean;
    try {
      taken = deps.sendToBridge(tabId, frame);
    } catch (cause) {
      log.warn('bridge send threw', { tabId, error: errorName(cause) });
      taken = false;
    }
    return taken ? 'delivered' : 'pending-bridge';
  }

  /** Relay one full `agent.ready` report to the service. */
  function relay(report: AgentReadyPayload): boolean {
    try {
      const outcome = deps.send('agent.ready', report);
      if (!outcome.ok) {
        log.warn('agent.ready not relayed', {
          tabId: report.tabId,
          ...documentLogFields(report.documentId),
          code: outcome.error.code,
        });
        return false;
      }
      return true;
    } catch (cause) {
      log.warn('agent.ready relay threw', {
        tabId: report.tabId,
        ...documentLogFields(report.documentId),
        error: errorName(cause),
      });
      return false;
    }
  }

  /** Tabs other than `except` whose desired configuration names the session. */
  function holdersOf(sessionId: SessionId, armedOnly: boolean, except?: TabId): TabId[] {
    const holders: TabId[] = [];
    for (const [tabId, state] of tabs) {
      const desired = state.desired;
      if (
        tabId !== except &&
        desired !== undefined &&
        desired.sessionId === sessionId &&
        (!armedOnly || !isDormantConfig(desired))
      ) {
        holders.push(tabId);
      }
    }
    return holders;
  }

  /** Replace a tab's desired configuration with its dormant form and deliver it. */
  function disarmTab(
    tabId: TabId,
    state: TabState,
    desired: AgentConfigPayload,
    reason: DisarmReason,
  ): DisarmOutcome {
    const dormant = dormantConfigFrom(desired);
    state.desired = dormant;
    if (endsBinding(reason)) {
      state.bound = false;
    }
    const delivery = deliver(tabId, state, dormant);
    log.info('agent disarmed', {
      tabId,
      sessionId: dormant.sessionId,
      captureId: dormant.captureId,
      reason,
      delivery,
    });
    emit({
      kind: 'disarmed',
      tabId,
      sessionId: dormant.sessionId,
      captureId: dormant.captureId,
      reason,
      delivery,
    });
    return {
      kind: 'disarmed',
      tabId,
      sessionId: dormant.sessionId,
      captureId: dormant.captureId,
      delivery,
    };
  }

  // -------------------------------------------------------------------------
  // The consented reload's wait
  // -------------------------------------------------------------------------

  /**
   * The wait for a reload of the document `previousReadiness` describes, or —
   * `undefined` — of a document no agent reported for.
   */
  function createPendingReload(
    previousReadiness: AgentReadinessState | undefined,
    previousReport: AgentReadyPayload | undefined,
  ): PendingReload {
    let resolveOutcome: ((outcome: ReloadOutcome) => void) | undefined;
    const promise = new Promise<ReloadOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    return {
      previousDocumentId: previousReadiness?.documentId,
      previousReadiness,
      previousReport,
      promise,
      resolve: (outcome) => {
        resolveOutcome?.(outcome);
      },
      settled: false,
      timer: undefined,
    };
  }

  /** Decide a pending reload's outcome, once; later settlements are ignored. */
  function settleReload(tabId: TabId, pending: PendingReload, outcome: ReloadOutcome): void {
    if (pending.settled) {
      return;
    }
    pending.settled = true;
    if (pending.timer !== undefined) {
      deps.timers.clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    const state = tabs.get(tabId);
    if (state !== undefined && state.reload === pending) {
      state.reload = undefined;
      // A reload of a tab no agent had reported for may have been all that
      // was held for it; an entry exists only while something is held.
      pruneIfEmpty(tabId, state);
    }
    log.info('consented reload settled', {
      tabId,
      previousDocument: fingerprintPageId(pending.previousDocumentId),
      outcome: outcome.kind,
      ...(outcome.kind === 'ready'
        ? { document: fingerprintPageId(outcome.readiness.documentId) }
        : {}),
    });
    pending.resolve(outcome);
    emit({ kind: 'reload-settled', tabId, outcome });
  }

  /**
   * Chrome refused the reload, so the document was never replaced: restore
   * its memo — when there was one, and unless a newer report already arrived —
   * and settle as `no-tab`. A reload of a tab no agent had reported for
   * restores nothing, so no readiness is ever invented.
   */
  function failReload(tabId: TabId, pending: PendingReload, cause: unknown): void {
    if (pending.settled) {
      return;
    }
    log.warn('consented reload refused by Chrome', {
      tabId,
      previousDocument: fingerprintPageId(pending.previousDocumentId),
      error: errorName(cause),
    });
    const state = tabs.get(tabId);
    const previousReadiness = pending.previousReadiness;
    if (state !== undefined && state.reload === pending && previousReadiness !== undefined) {
      if (state.retiredDocumentId === previousReadiness.documentId) {
        state.retiredDocumentId = undefined;
      }
      if (state.readiness === undefined) {
        state.readiness = previousReadiness;
        state.lastReport = pending.previousReport;
        state.documentOrigin =
          pending.previousReport === undefined ? undefined : originOf(pending.previousReport.url);
      }
    }
    settleReload(tabId, pending, { kind: 'no-tab', tabId, reason: 'reload-failed' });
  }

  /** Forget everything held for a tab, settling a reload in flight as `cleared`. */
  function forgetTab(tabId: TabId, state: TabState): void {
    tabs.delete(tabId);
    const pending = state.reload;
    if (pending !== undefined) {
      settleReload(tabId, pending, { kind: 'no-tab', tabId, reason: 'cleared' });
    }
  }

  // -------------------------------------------------------------------------
  // Arming
  // -------------------------------------------------------------------------

  async function applyNow(config: AgentConfigPayload): Promise<ApplyConfigOutcome> {
    const { sessionId, captureId } = config;
    const startGeneration = generation;
    const startClearSeq = clearSeq;
    appliesInFlight += 1;
    try {
      let target: AgentBindingTarget | undefined;
      let lookupFailed = false;
      try {
        target = await deps.resolveBinding(sessionId);
      } catch (cause) {
        lookupFailed = true;
        const failure = workerError(
          'TAB_NOT_BOUND',
          'The tab bound to the session could not be resolved.',
          { cause },
        );
        log.warn('binding lookup failed', {
          sessionId,
          captureId,
          code: failure.code,
          error: errorName(cause),
        });
      }

      if (generation !== startGeneration) {
        log.debug('agent.config discarded: controller disposed', { sessionId, captureId });
        return { kind: 'discarded', sessionId, captureId, reason: 'disposed' };
      }

      const dormant = isDormantConfig(config);

      if (target !== undefined) {
        const tabId = target.tabId;
        if ((clearedAt.get(tabId) ?? -1) > startClearSeq) {
          log.debug('agent.config discarded: tab cleared during lookup', {
            tabId,
            sessionId,
            captureId,
          });
          return { kind: 'discarded', sessionId, captureId, reason: 'tab-cleared' };
        }
        // One session, one armed tab: a tab the binding moved away from goes dormant.
        for (const displaced of holdersOf(sessionId, true, tabId)) {
          const displacedState = tabs.get(displaced);
          const displacedConfig = displacedState?.desired;
          if (displacedState !== undefined && displacedConfig !== undefined) {
            disarmTab(displaced, displacedState, displacedConfig, 'displaced');
          }
        }
        const state = stateFor(tabId);
        state.desired = config;
        state.boundOrigin = target.origin;
        state.bound = true;
        const delivery = deliver(tabId, state, config);
        log.info('agent.config routed', { tabId, sessionId, captureId, dormant, delivery });
        emit({ kind: 'config-routed', tabId, sessionId, captureId, dormant, delivery });
        return { kind: 'routed', tabId, sessionId, captureId, dormant, delivery };
      }

      const reason = lookupFailed ? 'lookup-failed' : 'no-binding';

      if (dormant) {
        // The service's own dormancy frame for a session whose binding is
        // already gone: forward it verbatim to the tab still armed for the
        // session, so the end-of-session guarantee does not depend on the
        // order in which the unbind and the disarm arrived (AAP §0.5.1). The
        // one-armed-tab invariant means there is at most one such tab; a tab
        // already returned to dormant needs nothing.
        const [holder] = holdersOf(sessionId, true);
        const holderState = holder === undefined ? undefined : tabs.get(holder);
        if (holder !== undefined && holderState !== undefined) {
          holderState.desired = config;
          holderState.bound = false;
          const delivery = deliver(holder, holderState, config);
          log.info('dormant agent.config forwarded to the former holder', {
            tabId: holder,
            sessionId,
            captureId,
            delivery,
          });
          emit({
            kind: 'config-routed',
            tabId: holder,
            sessionId,
            captureId,
            dormant,
            delivery,
          });
          return { kind: 'routed', tabId: holder, sessionId, captureId, dormant, delivery };
        }
      } else {
        // No binding means nothing may stay armed for this session.
        for (const holder of holdersOf(sessionId, true)) {
          const holderState = tabs.get(holder);
          const holderConfig = holderState?.desired;
          if (holderState !== undefined && holderConfig !== undefined) {
            disarmTab(holder, holderState, holderConfig, 'unbound');
          }
        }
      }

      log.warn('agent.config not routed: no tab is bound to the session', {
        sessionId,
        captureId,
        reason,
      });
      return { kind: 'not-bound', sessionId, captureId, reason };
    } finally {
      appliesInFlight -= 1;
      if (appliesInFlight === 0) {
        clearedAt.clear();
      }
    }
  }

  function applyConfig(config: AgentConfigPayload): Promise<ApplyConfigOutcome> {
    const run = applyTail.then(() => applyNow(config));
    applyTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // -------------------------------------------------------------------------
  // Readiness and re-arming
  // -------------------------------------------------------------------------

  function handleAgentReady(tabId: TabId, payload: PageAgentReadyPayload): AgentReadyOutcome {
    const existing = tabs.get(tabId);
    if (existing !== undefined && existing.retiredDocumentId === payload.documentId) {
      log.debug('stale agent.ready dropped', { tabId, ...documentLogFields(payload.documentId) });
      return { kind: 'stale', tabId, documentId: payload.documentId };
    }

    // Copied field by field: only the protocol's own fields travel upward.
    const report: AgentReadyPayload = {
      tabId,
      documentId: payload.documentId,
      producerId: payload.producerId,
      url: payload.url,
      installedBeforeReact: payload.installedBeforeReact,
      reactDetected: payload.reactDetected,
    };
    const relayed = relay(report);

    const state = stateFor(tabId);
    const readiness: AgentReadinessState = {
      tabId,
      documentId: report.documentId,
      producerId: report.producerId,
      installedBeforeReact: report.installedBeforeReact,
      reactDetected: report.reactDetected,
      receivedAt: now(),
    };
    state.readiness = readiness;
    state.lastReport = report;
    state.documentOrigin = originOf(report.url);

    const reloadOffered = !report.installedBeforeReact;
    let config: ConfigDelivery | 'none' = 'none';
    const desired = state.desired;
    if (desired !== undefined) {
      // A reload or a same-origin navigation re-runs the dormant agent; the
      // same configuration — and so the same `captureId` — arms it again.
      config = deliver(tabId, state, desired);
      if (config !== 'pending-navigation' && state.bound) {
        pushBound(tabId, desired.sessionId, report.url);
      }
    }
    log.debug('agent.ready recorded', {
      tabId,
      ...documentLogFields(report.documentId),
      installedBeforeReact: report.installedBeforeReact,
      reactDetected: report.reactDetected,
      relayed,
      config,
      ...(desired === undefined
        ? {}
        : { sessionId: desired.sessionId, captureId: desired.captureId }),
    });
    emit({ kind: 'agent-ready', tabId, readiness, reloadOffered });

    // A reload of a tab no agent had reported for (`previousDocumentId`
    // undefined) settles on this, the first report to arrive.
    const pending = state.reload;
    if (pending !== undefined && pending.previousDocumentId !== report.documentId) {
      settleReload(tabId, pending, { kind: 'ready', tabId, readiness });
    }

    return { kind: 'recorded', tabId, readiness, relayed, reloadOffered, config };
  }

  // -------------------------------------------------------------------------
  // The consented reload
  // -------------------------------------------------------------------------

  /**
   * The consent rule, stated once (see {@link AgentControl.getReloadOffer}):
   * a reload in flight is shared; a recorded report offers a reload only when
   * the hook arrived after React; with no report, an attached bridge means the
   * agent is present and will report, and no bridge means no agent runs in
   * the tab at all.
   */
  function consentFor(tabId: TabId): ConsentVerdict {
    const state = tabs.get(tabId);
    const pending = state?.reload;
    if (pending !== undefined) {
      return { kind: 'in-flight', pending };
    }
    const readiness = state?.readiness;
    if (readiness !== undefined) {
      return readiness.installedBeforeReact
        ? { kind: 'not-needed', reason: 'hook-installed-before-react' }
        : { kind: 'offered', reason: 'hook-after-react' };
    }
    return bridgeAttached(tabId)
      ? { kind: 'not-needed', reason: 'no-agent-report' }
      : { kind: 'offered', reason: 'agent-missing' };
  }

  function getReloadOffer(tabId: TabId): PanelReloadState {
    const verdict = consentFor(tabId);
    switch (verdict.kind) {
      case 'in-flight':
        return RELOAD_IN_FLIGHT;
      case 'offered':
        return { kind: 'offered', reason: verdict.reason };
      case 'not-needed':
        return PANEL_RELOAD_NOT_NEEDED;
    }
  }

  function requestConsentedReload(tabId: TabId): Promise<ReloadOutcome> {
    const verdict = consentFor(tabId);
    switch (verdict.kind) {
      case 'in-flight':
        log.debug('consented reload already in flight', {
          tabId,
          previousDocument: fingerprintPageId(verdict.pending.previousDocumentId),
        });
        return verdict.pending.promise;
      case 'not-needed': {
        const documentId = tabs.get(tabId)?.readiness?.documentId;
        log.info('reload refused: no reload is offered for the tab', {
          tabId,
          reason: verdict.reason,
          ...(documentId === undefined ? {} : documentLogFields(documentId)),
        });
        return Promise.resolve({ kind: 'not-consented', tabId, reason: verdict.reason });
      }
      case 'offered':
        return startReload(tabId, verdict.reason);
    }
  }

  /**
   * Perform the reload `consentFor` offered: retire the current document's
   * memo (when an agent reported one), bound the wait for the next
   * `agent.ready`, and ask Chrome to reload the tab — exactly once.
   */
  function startReload(tabId: TabId, reason: PanelReloadReason): Promise<ReloadOutcome> {
    // `agent-missing` is a tab nothing was held for yet: the wait needs an entry.
    const state = stateFor(tabId);
    const readiness = state.readiness;
    const pending = createPendingReload(readiness, state.lastReport);
    state.reload = pending;
    // The old document is about to go: its memo no longer describes the tab,
    // and anything it still says is stale. The desired configuration stays,
    // so the new document is re-armed by its own `agent.ready`. A tab no agent
    // reported for has no document to retire.
    if (readiness !== undefined) {
      state.retiredDocumentId = readiness.documentId;
    }
    state.readiness = undefined;
    state.lastReport = undefined;
    state.documentOrigin = undefined;
    pending.timer = deps.timers.setTimeout(() => {
      settleReload(tabId, pending, {
        kind: 'timeout',
        tabId,
        timeoutMs: PENDING_READY_TIMEOUT_MS,
      });
    }, PENDING_READY_TIMEOUT_MS);

    log.info('consented reload started', {
      tabId,
      reason,
      previousDocument: fingerprintPageId(pending.previousDocumentId),
    });
    emit({ kind: 'reload-started', tabId, previousDocumentId: pending.previousDocumentId });

    let reloading: Promise<void>;
    try {
      reloading = deps.tabs.reload(tabId);
    } catch (cause) {
      failReload(tabId, pending, cause);
      return pending.promise;
    }
    // Both branches are handled here, so the chained promise is intentionally
    // not returned: the caller waits on the agent, not on Chrome's reply.
    void reloading.then(
      () => {
        log.debug('reload initiated', { tabId });
      },
      (cause: unknown) => {
        failReload(tabId, pending, cause);
      },
    );
    return pending.promise;
  }

  // -------------------------------------------------------------------------
  // Navigation, dormancy and clearing
  // -------------------------------------------------------------------------

  function handleNavigationDecision(decision: AgentNavigationDecision): NavigationOutcome {
    const { tabId } = decision;
    const state = tabs.get(tabId);

    switch (decision.kind) {
      case 'kept-same-origin': {
        const desired = state?.desired;
        if (state === undefined || desired === undefined) {
          log.debug('navigation kept: nothing to re-arm', { tabId, sessionId: decision.sessionId });
          return { kind: 'no-config', tabId };
        }
        if (desired.sessionId !== decision.sessionId) {
          // The binding now names another session; this configuration no
          // longer belongs to the tab, and the new session's own
          // `agent.config` is what arms it.
          state.desired = undefined;
          state.boundOrigin = undefined;
          state.bound = false;
          log.info('navigation kept under another session: stale configuration dropped', {
            tabId,
            sessionId: decision.sessionId,
            staleSessionId: desired.sessionId,
          });
          pruneIfEmpty(tabId, state);
          return { kind: 'no-config', tabId };
        }
        // Delivered now if the new document's bridge is already attached,
        // otherwise on that document's `agent.ready`.
        const delivery = deliver(tabId, state, desired);
        log.info('navigation kept: agent re-armed', {
          tabId,
          sessionId: desired.sessionId,
          captureId: desired.captureId,
          delivery,
          ...(decision.captureId !== undefined && decision.captureId !== desired.captureId
            ? { registryCaptureId: decision.captureId }
            : {}),
        });
        return { kind: 're-armed', tabId, delivery };
      }

      case 'unbound-cross-origin': {
        if (state === undefined) {
          return { kind: 'ignored', tabId };
        }
        const previousOrigin = state.boundOrigin;
        state.desired = undefined;
        state.boundOrigin = undefined;
        state.bound = false;
        // The old document's memo is stale; a report that already arrived
        // from the new, other-origin document is the tab's current readiness
        // and is kept. Nothing is sent: the new document's agent is dormant by
        // construction, and handing it the session's ids would leak them to
        // another app.
        if (previousOrigin === undefined || state.documentOrigin === previousOrigin) {
          state.readiness = undefined;
          state.lastReport = undefined;
          state.documentOrigin = undefined;
        }
        const pending = state.reload;
        if (pending !== undefined) {
          settleReload(tabId, pending, { kind: 'no-tab', tabId, reason: 'cleared' });
        }
        pruneIfEmpty(tabId, state);
        log.info('navigation left the bound origin: agent state cleared', {
          tabId,
          ...(decision.sessionId === undefined ? {} : { sessionId: decision.sessionId }),
        });
        emit({ kind: 'cleared', tabId });
        return { kind: 'cleared', tabId };
      }

      case 'not-bound': {
        if (state?.desired === undefined) {
          return { kind: 'ignored', tabId };
        }
        // An unbound tab keeps its readiness (it describes the document, not
        // a session) but must not be re-armed with a configuration it no
        // longer has a binding for.
        state.desired = undefined;
        state.boundOrigin = undefined;
        state.bound = false;
        pruneIfEmpty(tabId, state);
        log.info('navigation of an unbound tab: configuration dropped', { tabId });
        emit({ kind: 'cleared', tabId });
        return { kind: 'cleared', tabId };
      }
    }
  }

  function disarm(tabId: TabId, reason: DisarmReason = 'requested'): DisarmOutcome {
    const state = tabs.get(tabId);
    const desired = state?.desired;
    if (state === undefined || desired === undefined) {
      log.debug('disarm: no configuration was received for the tab', { tabId, reason });
      return { kind: 'not-armed', tabId };
    }
    return disarmTab(tabId, state, desired, reason);
  }

  function reannounce(tabId: TabId): boolean {
    const report = tabs.get(tabId)?.lastReport;
    if (report === undefined) {
      return false;
    }
    return relay(report);
  }

  function getReadiness(tabId: TabId): AgentReadinessState | undefined {
    return tabs.get(tabId)?.readiness;
  }

  function getDesiredConfig(tabId: TabId): AgentConfigPayload | undefined {
    return tabs.get(tabId)?.desired;
  }

  function isReloadPending(tabId: TabId): boolean {
    return tabs.get(tabId)?.reload !== undefined;
  }

  function clear(tabId: TabId): void {
    clearSeq += 1;
    if (appliesInFlight > 0) {
      clearedAt.set(tabId, clearSeq);
    }
    const state = tabs.get(tabId);
    if (state === undefined) {
      return;
    }
    forgetTab(tabId, state);
    log.debug('agent state cleared', { tabId });
    emit({ kind: 'cleared', tabId });
  }

  function dispose(): void {
    generation += 1;
    const held = [...tabs];
    for (const [tabId, state] of held) {
      forgetTab(tabId, state);
      emit({ kind: 'cleared', tabId });
    }
    clearedAt.clear();
    log.debug('agent control disposed', { tabs: held.length });
  }

  return {
    applyConfig,
    handleAgentReady,
    handleNavigationDecision,
    requestConsentedReload,
    getReloadOffer,
    disarm,
    reannounce,
    getReadiness,
    getDesiredConfig,
    isReloadPending,
    clear,
    dispose,
  };
}
