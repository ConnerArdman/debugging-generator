/**
 * Session and capture attribution for arriving telemetry — the gate that
 * decides which debugging session and which capture window an event belongs
 * to, or that it belongs to none and must not be stored.
 *
 * Every producer sends {@link TelemetryEventIngress} events that carry no
 * session and no capture: the MAIN-world page agent is armed per tab and the
 * dev-server preload runs per process, so neither knows whom it is serving, and
 * the strict ingress schema refuses an element that tries to say. Attribution is
 * the service's job alone (AAP §0.4.2): browser events belong to the session
 * **bound to the tab** they were relayed for, server and database events to the
 * session that **owns the capture of the project** the credential is scoped to,
 * and in both cases only while that session has an **open capture window**
 * (AAP §0.7.1 Group 2: "attribute to the bound session's active capture").
 *
 * ## Why this module is split in two — do not "fix" it
 *
 * The per-event order `./ingest.ts` runs is fixed:
 * `parse → request_key → redact → attribute → persist`. The `request_key` HMAC
 * is keyed with the **per-session** secret (AAP §0.5.2), so the session must be
 * known *before* the first event is hashed — which is before attribution runs
 * on it. Resolving the session inside the per-event step would therefore be too
 * late for the step that precedes it. Hence two halves:
 *
 * - **Once per batch — {@link IngestAttributor.resolveBatch}.** Resolves the
 *   session, its active capture and, for the server tier, the credential's
 *   project scope, from the batch's *transport* identity. `./ingest.ts` calls it
 *   first, then fetches that session's request-key secret, then runs the
 *   per-event pipeline. A batch is homogeneous in identity — one relayed frame
 *   is one tab, one ingest request is one credential — so resolving once is
 *   exact, not an approximation.
 * - **Once per event — {@link IngestAttributor.attributeEvent}.** Stamps the
 *   resolved identity onto one event and applies the per-event rule (the tier
 *   gate). Pure, synchronous and free of I/O: it reads no store, calls no
 *   dependency and logs nothing. {@link IngestAttributor.attributeBatch} is the
 *   same decision over a whole batch plus one summary log line of counts.
 *
 * ## Capture identity, not timestamps — why a late batch is refused, not relabelled
 *
 * The capture a batch is stamped with is the one open **when the batch
 * arrives**. A batch recorded during capture A can arrive after A closed and B
 * opened — a frame the service worker queued while the socket was away and
 * replayed on reconnect, or a preload POST retried in place across a Stop and
 * a Start — and stamping it with B would put A's evidence into B's analysis
 * (telemetry belongs to the bound session's *active* capture,
 * which is the capture the producer was armed for).
 *
 * Both producers are armed per capture and both name the capture a batch was
 * recorded for, as `armedCaptureId`:
 *
 * - the page agent is armed by `agent.config { captureId }`, and its relayed
 *   frame names that capture (`@debuggen/protocol`'s
 *   `telemetryEventPayloadSchema`);
 * - the dev-server preload is armed by `server-agent.config { captureId }`,
 *   and every `POST /telemetry/ingest` body names the capture its spans were
 *   recorded in (`telemetryIngestRequestSchema`).
 *
 * So {@link IngestAttributor.resolveBatch} compares **identities**: a batch
 * naming a capture other than the open one — the bound session's for a
 * browser batch, the project's capture owner's for a server batch — is refused
 * whole as `stale-capture`, never relabelled and never split. The comparison
 * is refusal-only and cannot attribute anything: the session and
 * the capture still come from the transport (the tab's binding, or the
 * credential's project scope and its capture owner) and the store's open
 * capture row, naming the open capture adds no authority over omitting the
 * field, and naming another one can only discard the producer's own batch. A
 * batch of either tier without the field is attributed exactly as before. When
 * no capture is open at all the batch is `no-active-capture` whatever it
 * names, and a server batch whose owner cannot be confirmed stays
 * `capture-owner-mismatch`: those reasons already refuse it whole, and the
 * first keeps the routine flush after a stop at `debug`.
 *
 * Event `startTime`s are deliberately **not** compared with capture windows.
 * AAP §0.2.3 applies no clock alignment between producers and the service
 * (`clockOffsetMs` is informational): a window's bounds are read from the
 * service's clock while an event's `startTime` is the producer's, and a span
 * that starts just before Start and ends inside the window straddles its
 * boundary. A time test would therefore both drop real evidence and admit a
 * late batch whose clock happened to agree; identity has neither failure.
 *
 * **Each side guards what the other cannot see.** The preload's span processor
 * stamps each span with the capture it started in and drops one whose capture
 * has since been replaced, and its control channel flushes the outgoing
 * capture before it arms the next. A batch already handed to the exporter is
 * past both guards, so a POST of it retried after the re-arm reaches the
 * service while the next capture is open — and is refused here, because its
 * body still names the capture it was recorded for.
 *
 * ## The drop contract (relied on by `./ingest.ts` and `../server/routes/telemetry.ts`)
 *
 * **A batch whose context cannot be resolved is a drop, not a server error.**
 * `resolveBatch` never throws and never rejects; every refusal is an `Err`
 * carrying a {@link DebuggenError} whose `details` hold:
 *
 * - `reason` — a {@link DropReason}, always; this is what makes it a drop;
 * - `attributionDrop: true` — the marker {@link attributionDropReason} checks,
 *   so a drop can never be confused with an unrelated error that happens to
 *   carry a `reason` detail;
 * - `origin`, and where known `tabId`, `sessionId`, `captureId` or
 *   `owningSessionId` — identifiers only;
 * - `mismatch` for a project-scope refusal (which *kind* of mismatch, never the
 *   paths) and `fault` when the refusal came from a failed or throwing
 *   dependency read rather than from an absent fact.
 *
 * `code` is always a member of `@debuggen/shared`'s closed code vocabulary: the
 * reason's entry in {@link DROP_REASON_ERROR_CODES} when a fact was absent, or
 * the failing read's own code (`STORE_ERROR`, `INTERNAL`) when the store could
 * not answer. Either way the caller counts the batch under its reason in the
 * ingest report and answers the producer with "accepted, nothing stored"
 * (`202`-style) semantics — never a `5xx` that would make a producer retry a
 * batch that can never be attributed. The route may still choose to answer a
 * `project-scope-mismatch` as an authorization refusal, since its code is
 * `UNAUTHORIZED`; that choice is the route's, and this module supplies the
 * reason either way.
 *
 * Dropping outside an active capture is a product requirement, not an
 * optimisation: outside a capture the preload's span processor drops every span
 * so that "an unrelated plan collects no backend telemetry" (AAP §0.7.1), and
 * this module is the service-side twin of that guarantee for both producers.
 *
 * ## Authorization comes from the transport, never from the payload
 *
 * AAP §0.5.6: an authorization decision must never depend on a client's
 * self-description. So:
 *
 * - The **browser** context names a `tabId` the caller derived from the
 *   authenticated DevTools connection the frame arrived on (whose binding is
 *   recorded against that connection's principal) — never a tab or session a
 *   page nominated. `documentId`, `producerId` and `url` are accepted as
 *   diagnostic context and are not authorization facts; `armedCaptureId` is
 *   refusal-only context (see "Capture identity" above).
 * - The **server** context carries both the `projectRoot` the ingest body
 *   claims and the `scopedProjectRoot` the presented `server-agent` credential
 *   is bound to. They must agree exactly after POSIX normalisation — a scoped
 *   credential authorises one project, not a subtree — and only then is the
 *   capture owner of that project looked up. The body's `armedCaptureId` is
 *   refusal-only context, exactly as the browser's is, and is compared only
 *   once that owner and its open capture are confirmed.
 * - The **tier gate** is the per-event expression of the same role scoping: a
 *   page may only report `browser`-tier events, a dev server only `server` and
 *   `db` ones (see {@link TIER_BY_ORIGIN}).
 *
 * ## Read-only with respect to session state
 *
 * This module starts no capture, stops none, writes no binding, emits no
 * protocol message and never reads the request-key secret. Capture rows belong
 * to `../store/sessions-repo.ts`, capture ownership to `../sessions/manager.ts`;
 * both reach this module through the two narrow structural ports below, which
 * list only the methods called here, so a suite can drive it with plain
 * objects.
 *
 * ## Time base and field fidelity
 *
 * Identity fields are stamped and nothing else changes: `startTime`,
 * `duration` and every other field of an event pass through untouched, and no
 * `ingestSeq` is added — the store assigns it (`telemetry_events.ingest_seq
 * INTEGER PRIMARY KEY AUTOINCREMENT`, returned by `TelemetryRepo.insertMany`).
 *
 * ## Privacy
 *
 * Log records and error payloads carry counts, reasons, codes and identifiers
 * only. No event name, attribute value, URL, SQL statement, project path or
 * rejected value ever reaches a log line or an error — a project-scope refusal
 * says *what kind* of mismatch it saw, never which two paths it compared.
 *
 * @example
 * ```ts
 * const attributor = createIngestAttributor({ sessions, sessionManager, logger });
 *
 * const resolved = await attributor.resolveBatch({
 *   origin: 'server-agent',
 *   projectRoot: body.projectRoot,
 *   scopedProjectRoot: principal.scope,
 *   ...(body.armedCaptureId === undefined ? {} : { armedCaptureId: body.armedCaptureId }),
 * });
 * if (isErr(resolved)) {
 *   const reason = attributionDropReason(resolved.error); // counted, answered 202
 *   return;
 * }
 * const secret = sessions.getOrCreateRequestKeySecret(resolved.value.sessionId);
 * // …per event: request_key → redact → attributeEvent(event, resolved.value) → persist
 * ```
 *
 * @module
 */

import type { ClientKind, SessionStatus } from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  isErr,
  isWithin,
  noopLogger,
  normalizePosix,
  nowEpochMs,
  ok,
  toPosix,
} from '@debuggen/shared';
import type {
  CaptureId,
  DebuggenErrorCode,
  LogFields,
  Logger,
  ProducerId,
  Result,
  SessionId,
} from '@debuggen/shared';
import { TELEMETRY_TIERS, isTelemetryTier } from '@debuggen/telemetry';
import type { TelemetryEvent, TelemetryEventIngress, TelemetryTier } from '@debuggen/telemetry';

import { LOG_BINDING_KEYS, guardLogger, sessionLogger, subsystemLogger } from '../logging.js';

/* -------------------------------------------------------------------------------------------------
 * Vocabularies
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `subsystem` binding every record from this module carries, so its lines
 * can be filtered out of a session's log without matching on message text.
 */
export const ATTRIBUTION_SUBSYSTEM = 'telemetry.attribute';

/**
 * The two transports a telemetry batch can arrive on.
 *
 * - `browser-agent` — a `telemetry.event` frame the Chrome service worker
 *   relayed for the page agent of one inspected tab.
 * - `server-agent` — a `POST /telemetry/ingest` request from the dev-server
 *   preload, authenticated by a `server-agent` credential.
 */
export const INGEST_ORIGINS = Object.freeze(['browser-agent', 'server-agent'] as const);

/** One member of {@link INGEST_ORIGINS}. */
export type IngestOrigin = (typeof INGEST_ORIGINS)[number];

/**
 * Every reason a batch or an event is refused, as a closed tuple.
 *
 * Every drop path in this module uses one of these; no free-text reason exists.
 *
 * - `no-binding` — the browser batch's tab is not bound to any session (or its
 *   binding could not be read).
 * - `session-missing` — the session the tab is bound to no longer exists.
 * - `no-active-capture` — the session (browser) or the project (server) has no
 *   open capture window, so nothing may be stored.
 * - `project-scope-mismatch` — the ingest body names a project the presented
 *   `server-agent` credential is not scoped to, or one of the two is missing.
 * - `capture-owner-mismatch` — the project has a capture owner, but that
 *   owner's open capture window could not be confirmed.
 * - `tier-not-permitted` — per event: the event's tier is not one its producer
 *   may report (or could not be read at all).
 * - `stale-capture` — the batch names the capture its producer was armed for,
 *   and that is not the open capture it would be stamped with (the bound
 *   session's for a browser batch, the project's capture owner's for a server
 *   batch): evidence recorded for an earlier window that arrived after it
 *   closed (see "Capture identity, not timestamps" above).
 */
export const DROP_REASONS = Object.freeze([
  'no-binding',
  'session-missing',
  'no-active-capture',
  'project-scope-mismatch',
  'capture-owner-mismatch',
  'tier-not-permitted',
  'stale-capture',
] as const);

/** One member of {@link DROP_REASONS}. */
export type DropReason = (typeof DROP_REASONS)[number];

/**
 * Whether `value` is one of the {@link DROP_REASONS}.
 *
 * @param value Any value, typically read back out of an error's details.
 * @returns `true` for a member of the closed vocabulary.
 */
export function isDropReason(value: unknown): value is DropReason {
  return DROP_REASONS.some((reason) => reason === value);
}

/**
 * The error code a batch-level drop is reported under when the fact it needed
 * was absent (a failed store read reports the store's own code instead).
 *
 * Total over {@link DropReason}, so a reason added to the tuple without a code
 * here is a compile error, and typed against the shared vocabulary, so no code
 * string is ever invented here:
 *
 * - `no-binding` → `TAB_NOT_BOUND`: no deterministic recipient session exists
 *   for the tab.
 * - `session-missing` → `SESSION_NOT_FOUND`: the bound session is gone,
 *   including one purged by retention.
 * - `no-active-capture`, `capture-owner-mismatch` and `stale-capture` →
 *   `SESSION_INVALID_STATE`: storing telemetry is a real operation that is not
 *   legal while no confirmed capture window is open — or, for a stale batch,
 *   into a window other than the one it was recorded for.
 * - `project-scope-mismatch` → `UNAUTHORIZED`: the vocabulary's code for an
 *   out-of-scope credential (AAP §0.5.6).
 * - `tier-not-permitted` → `UNAUTHORIZED`: the producer's role does not cover
 *   that tier. Per-event drops are outcomes, not errors; the entry exists so the
 *   table stays total for a caller that reports one as an error.
 */
export const DROP_REASON_ERROR_CODES: Readonly<Record<DropReason, DebuggenErrorCode>> =
  Object.freeze({
    'no-binding': 'TAB_NOT_BOUND',
    'session-missing': 'SESSION_NOT_FOUND',
    'no-active-capture': 'SESSION_INVALID_STATE',
    'project-scope-mismatch': 'UNAUTHORIZED',
    'capture-owner-mismatch': 'SESSION_INVALID_STATE',
    'tier-not-permitted': 'UNAUTHORIZED',
    'stale-capture': 'SESSION_INVALID_STATE',
  });

/**
 * The `details` key marking an error as an attribution drop. See the module's
 * drop contract and {@link attributionDropReason}.
 */
export const ATTRIBUTION_DROP_DETAIL_KEY = 'attributionDrop';

/**
 * Which producer may report each tier: the single table the tier gate is
 * derived from.
 *
 * Keyed over the imported {@link TelemetryTier} union, so a tier added to
 * `@debuggen/telemetry`'s `TELEMETRY_TIERS` without an entry here is a compile
 * error rather than a tier nobody may submit. `db` belongs to the server agent
 * because database spans are produced by the preload's Prisma and `pg`
 * instrumentations inside the dev-server process; a page never observes a
 * query directly.
 */
export const PRODUCING_ORIGIN_BY_TIER: Readonly<Record<TelemetryTier, IngestOrigin>> =
  Object.freeze({
    browser: 'browser-agent',
    server: 'server-agent',
    db: 'server-agent',
  });

/**
 * The tiers one origin produces, in `TELEMETRY_TIERS` order.
 *
 * @param origin The producing transport.
 * @returns A frozen list derived from the imported tier vocabulary.
 */
function tiersProducedBy(origin: IngestOrigin): readonly TelemetryTier[] {
  return Object.freeze(TELEMETRY_TIERS.filter((tier) => PRODUCING_ORIGIN_BY_TIER[tier] === origin));
}

/**
 * The tiers each origin may submit — the tier gate of
 * {@link IngestAttributor.attributeEvent}.
 *
 * `browser-agent` → `['browser']`; `server-agent` → `['server', 'db']`.
 * Derived from {@link PRODUCING_ORIGIN_BY_TIER} over the imported
 * `TELEMETRY_TIERS`, never restated.
 *
 * Why it matters: without it, a compromised or confused page could forge
 * `db`-tier query spans or `server`-tier request spans into a session's
 * evidence, and the analysis would cite a database cause the database never
 * reported. It is the telemetry-side expression of AAP §0.5.6's role scoping.
 */
export const TIER_BY_ORIGIN: Readonly<Record<IngestOrigin, readonly TelemetryTier[]>> =
  Object.freeze({
    'browser-agent': tiersProducedBy('browser-agent'),
    'server-agent': tiersProducedBy('server-agent'),
  });

/**
 * The protocol client kind that speaks for each origin, used as the standard
 * `client` log binding.
 *
 * The page agent owns no socket (its frames are relayed), so a browser batch
 * is attributed to the `agent` kind; the preload is the `server-agent` kind.
 */
export const INGEST_ORIGIN_CLIENT_KIND: Readonly<Record<IngestOrigin, ClientKind>> = Object.freeze({
  'browser-agent': 'agent',
  'server-agent': 'server-agent',
});

/* -------------------------------------------------------------------------------------------------
 * Batch contexts and the resolved attribution
 * ---------------------------------------------------------------------------------------------- */

/**
 * What the service knows about a browser batch: the `telemetry.event` frame the
 * Chrome service worker relayed for one inspected tab.
 */
export interface BrowserIngestContext {
  /** The browser transport. */
  readonly origin: 'browser-agent';
  /**
   * The inspected tab the frame was relayed for, taken from the authenticated
   * DevTools connection — never from the page. A non-negative integer.
   */
  readonly tabId: number;
  /** The page document the agent reported in `agent.ready`. Diagnostic only. */
  readonly documentId?: string | undefined;
  /**
   * The producer id the agent announced for this document. Diagnostic only:
   * an event carrying a different one is still attributed (and counted).
   */
  readonly producerId?: ProducerId | undefined;
  /** The tab's current URL. Diagnostic only, and never logged. */
  readonly url?: string | undefined;
  /**
   * The capture the page agent was armed for when it recorded the batch — the
   * `captureId` of the `agent.config` it last applied, relayed by the service
   * worker from the bridge frame (`telemetryEventPayloadSchema.armedCaptureId`).
   *
   * **Refusal-only** (AAP §0.5.6): it never chooses a session or a capture.
   * When present and different from the bound session's open capture, the
   * batch is refused whole as `stale-capture`; when absent, the batch is
   * attributed as it always was. Never logged or echoed: it is page-supplied.
   */
  readonly armedCaptureId?: CaptureId | undefined;
}

/**
 * What the service knows about a server batch: a `POST /telemetry/ingest`
 * request and the credential it was authenticated with.
 */
export interface ServerIngestContext {
  /** The server transport. */
  readonly origin: 'server-agent';
  /** The `projectRoot` of the ingest body (`telemetryIngestRequestSchema`). */
  readonly projectRoot: string;
  /**
   * The project root the presented `server-agent` credential is scoped to,
   * resolved by the access boundary. Must equal {@link projectRoot} after POSIX
   * normalisation.
   */
  readonly scopedProjectRoot: string;
  /** The preload's per-process producer id, when known. Diagnostic only. */
  readonly producerId?: ProducerId | undefined;
  /**
   * The capture the preload recorded the batch's spans in — the `captureId`
   * of the `server-agent.config` it was armed with when those spans started,
   * sent on the ingest body (`telemetryIngestRequestSchema.armedCaptureId`).
   *
   * **Refusal-only**: it never chooses a session or a capture.
   * When present and different from the open capture of the project's capture
   * owner, the batch is refused whole as `stale-capture`; when absent, the
   * batch is attributed as it always was. Never logged or echoed: it is
   * producer-supplied.
   */
  readonly armedCaptureId?: CaptureId | undefined;
}

/** The transport identity of one batch, discriminated on `origin`. */
export type IngestContext = BrowserIngestContext | ServerIngestContext;

/**
 * Whom a resolved batch belongs to: the output of
 * {@link IngestAttributor.resolveBatch} and the input of every per-event call.
 */
export interface IngestAttribution {
  /** The session the batch's events are stamped with. */
  readonly sessionId: SessionId;
  /** The session's open capture window at resolution time. */
  readonly captureId: CaptureId;
  /** The transport the batch arrived on; selects the permitted tiers. */
  readonly origin: IngestContext['origin'];
  /**
   * The normalised project root: the credential's scope for a server batch,
   * the bound session's root for a browser batch.
   */
  readonly projectRoot?: string | undefined;
  /** The inspected tab, for a browser batch. */
  readonly tabId?: number | undefined;
  /**
   * The producer id the context announced. Used only to count events whose
   * own `producerId` differs — never to refuse one.
   */
  readonly producerId?: ProducerId | undefined;
  /** When the batch was resolved, in epoch milliseconds, from the injected clock. */
  readonly resolvedAt?: number | undefined;
}

/**
 * An event after attribution: every ingress field unchanged, plus `sessionId`
 * and `captureId`. Deliberately without `ingestSeq`, which only the store
 * assigns; adding it yields a value the strict persisted schema accepts.
 */
export type AttributedEvent = Omit<TelemetryEvent, 'ingestSeq'>;

/** The per-event decision. */
export type AttributionOutcome =
  | { readonly kind: 'attributed'; readonly event: AttributedEvent }
  | { readonly kind: 'dropped'; readonly reason: DropReason };

/** The per-batch decision of {@link IngestAttributor.attributeBatch}. */
export interface AttributedBatch {
  /** One outcome per input event, in input order. */
  readonly outcomes: readonly AttributionOutcome[];
  /** The attributed events only, in input order: what `./ingest.ts` persists. */
  readonly events: readonly AttributedEvent[];
  /** How many events were dropped, per reason; every reason is present. */
  readonly dropped: Readonly<Record<DropReason, number>>;
  /** How many events were dropped in total. */
  readonly droppedTotal: number;
  /**
   * How many attributed events carried a `producerId` other than the one the
   * context announced. Informational: those events were attributed.
   */
  readonly producerMismatches: number;
}

/* -------------------------------------------------------------------------------------------------
 * Consumer-side ports
 *
 * Narrow structural views of the two collaborators, listing only what this
 * module calls. The real `SessionsRepo` and `SessionManager` satisfy them as
 * they stand.
 * ---------------------------------------------------------------------------------------------- */

/** What this module reads of a tab binding. */
export interface BindingLike {
  /** The session the tab is bound to. */
  readonly sessionId: SessionId;
}

/** What this module reads of a session record. */
export interface SessionLike {
  /** The session's id; must be the id that was asked for. */
  readonly id: SessionId;
  /** The session's project root, when the record carries one. */
  readonly projectRoot?: string | undefined;
}

/** What this module reads of an open capture window. */
export interface ActiveCaptureLike {
  /** The open capture. */
  readonly capture: {
    /** The capture's id. */
    readonly id: CaptureId;
  };
}

/** The session-list query of the repository fallback. */
export interface CapturingSessionsQuery {
  /** Always `['capturing']`. */
  readonly statuses: readonly SessionStatus[];
  /** The page size. */
  readonly limit: number;
  /** How many matching sessions to skip. */
  readonly offset: number;
}

/** What this module reads of one listed session. */
export interface ListedSessionLike {
  /** The session's id. */
  readonly id: SessionId;
  /** The session's project root. */
  readonly projectRoot: string;
}

/** What this module reads of one page of the session list. */
export interface SessionPageLike {
  /** The sessions on this page. */
  readonly items: readonly ListedSessionLike[];
  /** How many sessions match the query in total. */
  readonly total: number;
}

/**
 * The sessions repository, as far as attribution needs it: three reads, plus
 * the session list for the fallback owner lookup.
 *
 * Every method is synchronous and answers with a `Result`, `ok(undefined)`
 * meaning "no such row" — the contract of the real repository.
 *
 * @see ../store/sessions-repo.js — `SessionsRepo`, the implementation.
 */
export interface SessionsRepoLike {
  /** The binding of one inspected tab (`SessionsRepo.getBindingByTab`). */
  getBindingByTab(tabId: number): Result<BindingLike | undefined>;
  /** One session record (`SessionsRepo.get`). */
  get(id: SessionId): Result<SessionLike | undefined>;
  /** The open capture of one session (`SessionsRepo.getActiveCapture`). */
  getActiveCapture(sessionId: SessionId): Result<ActiveCaptureLike | undefined>;
  /**
   * The session list (`SessionsRepo.list`). Consulted **only** by the
   * server-origin fallback, when no session manager is injected; a repository
   * without it makes that fallback find no owner.
   */
  list?(query: CapturingSessionsQuery): Result<SessionPageLike>;
}

/** The capture owner of a project, as the session manager names it. */
export interface CaptureOwnerLike {
  /** The session holding the project's capture. */
  readonly sessionId: SessionId;
  /** That session's capture window. */
  readonly captureId: CaptureId;
}

/**
 * The session manager, as far as attribution needs it: the single
 * authoritative answer to "which session owns this project's capture", which
 * is also the owner `server-agent.config` names (AAP §0.4.2 allows at most one
 * capturing session per project).
 *
 * @see ../sessions/manager.js — `SessionManager.captureOwnerForProject`.
 */
export interface SessionManagerLike {
  /** The owner of `projectRoot`'s capture, or `undefined` when none captures it. */
  captureOwnerForProject(projectRoot: string): CaptureOwnerLike | undefined;
}

/** Everything {@link createIngestAttributor} is given; all of it injected. */
export interface IngestAttributorDeps {
  /** The sessions repository: bindings, records and capture windows. */
  readonly sessions: SessionsRepoLike;
  /**
   * The session manager, whose owner index answers the server-origin lookup.
   * When absent, the lookup falls back to listing `capturing` sessions through
   * {@link SessionsRepoLike.list} and confirming exactly one open capture on the
   * project — the same answer from the store's rows, at the cost of a scan.
   */
  readonly sessionManager?: SessionManagerLike | undefined;
  /** The service logger; defaults to `noopLogger`. Bound to `subsystem: "telemetry.attribute"`. */
  readonly logger?: Logger | undefined;
  /** The clock `resolvedAt` is read from; defaults to `nowEpochMs`. */
  readonly now?: (() => number) | undefined;
}

/** The attribution gate of one service process. */
export interface IngestAttributor {
  /**
   * Resolves a batch's session and open capture from its transport identity.
   *
   * Never rejects and never throws. Every refusal is a drop as described in
   * the module's drop contract; read its reason with
   * {@link attributionDropReason}.
   *
   * @param context The batch's transport identity.
   * @returns `ok(attribution)`, or `err` carrying a {@link DropReason}.
   */
  resolveBatch(context: IngestContext): Promise<Result<IngestAttribution, DebuggenError>>;

  /**
   * Attributes one event: applies the tier gate and returns a **new** object
   * with `sessionId` and `captureId` stamped and every other field preserved.
   *
   * Pure, synchronous, free of I/O and of logging, and never throws — an event
   * whose fields cannot even be read is refused `tier-not-permitted`, because
   * its tier cannot be shown to be permitted. The input is never mutated.
   *
   * @param event One validated ingress event.
   * @param attribution The batch's resolved attribution.
   * @returns The attributed event, or the reason it was dropped.
   */
  attributeEvent(event: TelemetryEventIngress, attribution: IngestAttribution): AttributionOutcome;

  /**
   * {@link attributeEvent} over a whole batch, with per-reason counts and one
   * summary log line (counts and reasons only).
   *
   * @param events The batch's validated ingress events.
   * @param attribution The batch's resolved attribution.
   * @returns The outcomes, the attributed events and the counts.
   */
  attributeBatch(
    events: readonly TelemetryEventIngress[],
    attribution: IngestAttribution,
  ): AttributedBatch;
}

/**
 * The drop reason of an error returned by {@link IngestAttributor.resolveBatch}.
 *
 * @param error Any value, typically the `error` of a `resolveBatch` `Err`.
 * @returns The reason when `error` is an attribution drop, otherwise `undefined`.
 */
export function attributionDropReason(error: unknown): DropReason | undefined {
  if (!DebuggenError.is(error)) {
    return undefined;
  }

  const details = error.details;

  if (details?.[ATTRIBUTION_DROP_DETAIL_KEY] !== true) {
    return undefined;
  }

  const reason = details.reason;

  return isDropReason(reason) ? reason : undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Internals: refusal details, messages and bounded reads
 * ---------------------------------------------------------------------------------------------- */

/**
 * Why a refusal came from a dependency or a malformed value rather than from
 * an absent fact. Recorded in `details.fault`; never a free-text description.
 */
type DropFault =
  | 'store-read-failed'
  | 'dependency-threw'
  | 'invalid-context'
  | 'invalid-tab-id'
  | 'invalid-binding'
  | 'session-id-mismatch'
  | 'invalid-capture'
  | 'invalid-owner'
  | 'capture-closed'
  | 'capture-changed'
  | 'ambiguous-owner'
  | 'owner-lookup-unavailable'
  | 'invalid-armed-capture';

/** The two faults a dependency read can end in. */
type ReadFault = Extract<DropFault, 'store-read-failed' | 'dependency-threw'>;

/**
 * Which kind of project-scope mismatch was seen — the only thing a
 * `project-scope-mismatch` refusal says about the two paths it compared.
 */
type ScopeMismatch =
  | 'missing-project-root'
  | 'missing-credential-scope'
  | 'descendant-of-scope'
  | 'ancestor-of-scope'
  | 'different-project';

/** Everything one refusal is built from. Identifiers only, never a path or a URL. */
interface RefusalSpec {
  readonly reason: DropReason;
  /** Absent only when the context was too malformed to name one. */
  readonly origin?: IngestOrigin | undefined;
  /** Overrides the reason's code: a failed read reports the store's own code. */
  readonly code?: DebuggenErrorCode | undefined;
  readonly fault?: DropFault | undefined;
  readonly mismatch?: ScopeMismatch | undefined;
  readonly tabId?: number | undefined;
  readonly sessionId?: SessionId | undefined;
  readonly captureId?: CaptureId | undefined;
  readonly owningSessionId?: SessionId | undefined;
}

/** A dependency read that produced an answer, or the fault it ended in. */
type ReadOutcome<T> =
  | { readonly read: 'value'; readonly value: T }
  | { readonly read: 'failed'; readonly code: DebuggenErrorCode; readonly fault: ReadFault };

/** The developer-facing text of one refusal: its message line and its recovery step. */
interface RefusalText {
  readonly message: string;
  readonly hint: string;
}

/**
 * The developer-facing sentence and recovery step per reason, for a refusal
 * caused by an absent fact. Structural on purpose: nothing here is
 * interpolated, so no path, URL or value can reach a message or a hint.
 */
const REFUSAL_TEXT: Readonly<Record<DropReason, RefusalText>> = Object.freeze({
  'no-binding': {
    message:
      'The inspected tab is not bound to a debugging session, so its telemetry was not stored.',
    hint: 'Open the Debug Generator panel for this tab so it binds to the session, then start a capture.',
  },
  'session-missing': {
    message:
      'The debugging session this tab is bound to no longer exists, so its telemetry was not stored.',
    hint: 'Start a new session or reopen one from the Sessions view, then open the panel for this tab again.',
  },
  'no-active-capture': {
    message: 'No capture is running for this telemetry, so it was not stored.',
    hint: 'Start a capture, then reproduce the issue: telemetry outside a capture window is discarded by design.',
  },
  'project-scope-mismatch': {
    message:
      'The server telemetry names a project its credential is not scoped to, so it was not stored.',
    hint: 'Relaunch the dev server from Debug Generator so its credential is issued for this project.',
  },
  'capture-owner-mismatch': {
    message:
      'The capture window of the session that owns this project could not be confirmed, so the server telemetry was not stored.',
    hint: 'Stop the capture and start it again.',
  },
  'tier-not-permitted': {
    message: 'The telemetry reports a tier its producer may not report, so it was not stored.',
    hint: 'Run the browser agent and the dev-server preload from the same Debug Generator build as the service.',
  },
  'stale-capture': {
    message:
      'The telemetry was recorded for a different capture than the one now running, so it was not stored.',
    hint: 'No action is needed: late events from a previous capture are discarded so they cannot mix into this one. Reproduce the issue again if this capture looks incomplete.',
  },
});

/** The sentence for a refusal caused by a failed or throwing dependency read. */
const READ_FAILURE_TEXT: RefusalText = Object.freeze({
  message: 'The session store could not be read while attributing telemetry, so it was not stored.',
  hint: 'Check the Debug Generator service log; if the failure persists, restart the service.',
});

/** The sentence for a context too malformed to name a transport identity. */
const INVALID_CONTEXT_TEXT: RefusalText = Object.freeze({
  message: 'A telemetry batch arrived without a usable transport identity, so it was not stored.',
  hint: 'Update the Debug Generator extension and dev-server preload to the build the service runs.',
});

/** The session statuses the repository fallback lists owner candidates from. */
const CAPTURING_STATUSES: readonly SessionStatus[] = Object.freeze(['capturing'] as const);

/** Page size of the repository fallback's session listing. */
const FALLBACK_PAGE_SIZE = 100;

/**
 * Upper bound on the pages the repository fallback reads — 5 000 capturing
 * sessions, far beyond one capture per project. Reaching it ends the scan with
 * what was found, which can only make the lookup refuse, never attribute to a
 * session it did not confirm.
 */
const MAX_FALLBACK_PAGES = 50;

/** Whether `value` is a usable identifier: a non-empty string. */
function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Whether `value` is a well-formed browser tab id: a non-negative safe integer. */
function isTabId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The comparison key of a project root: POSIX separators, lexically
 * normalised — exactly the key `../sessions/manager.ts` indexes owners by, so
 * the two modules agree on what "the same project" means.
 */
function projectKey(projectRoot: string): string {
  return normalizePosix(toPosix(projectRoot));
}

/**
 * Names the kind of mismatch between two normalised, unequal project keys.
 * Used for the refusal's `details.mismatch` only — never to accept anything.
 */
function classifyScopeMismatch(scopeKey: string, requestKey: string): ScopeMismatch {
  if (isWithin(scopeKey, requestKey)) {
    return 'descendant-of-scope';
  }
  if (isWithin(requestKey, scopeKey)) {
    return 'ancestor-of-scope';
  }
  return 'different-project';
}

/** The code of a failed read's error, defaulting to the store's own code. */
function codeOf(error: unknown): DebuggenErrorCode {
  return DebuggenError.is(error) ? error.code : 'STORE_ERROR';
}

/**
 * Runs one dependency read and projects the fields this module needs from its
 * answer, all inside one `try`, so a failed read, a throwing dependency and a
 * malformed answer all become a {@link ReadOutcome} rather than an exception.
 *
 * @param operation The repository call.
 * @param project Extracts what is needed from the `ok` value.
 * @returns The projected value, or the fault the read ended in.
 */
function readStore<T, U>(operation: () => Result<T>, project: (value: T) => U): ReadOutcome<U> {
  try {
    const outcome = operation();

    if (isErr(outcome)) {
      return { read: 'failed', code: codeOf(outcome.error), fault: 'store-read-failed' };
    }

    return { read: 'value', value: project(outcome.value) };
  } catch {
    // The thrown value is deliberately not kept: it may quote a row, a path or
    // a statement, and nothing rejected is ever echoed (see "Privacy" above).
    return { read: 'failed', code: 'INTERNAL', fault: 'dependency-threw' };
  }
}

/** A zeroed per-reason counter. */
function zeroCounts(): Record<DropReason, number> {
  return {
    'no-binding': 0,
    'session-missing': 0,
    'no-active-capture': 0,
    'project-scope-mismatch': 0,
    'capture-owner-mismatch': 0,
    'tier-not-permitted': 0,
    'stale-capture': 0,
  };
}

/** A dropped outcome. */
function dropped(reason: DropReason): AttributionOutcome {
  return { kind: 'dropped', reason };
}

/** One event's decision plus the informational producer-id comparison. */
interface EventDecision {
  readonly outcome: AttributionOutcome;
  readonly producerMismatch: boolean;
}

/**
 * The per-event decision shared by `attributeEvent` and `attributeBatch`.
 *
 * Pure: it reads the event once into a shallow snapshot (so a getter runs at
 * most once and the input is never touched again), checks the attribution and
 * the tier gate, and builds a new object.
 */
function decideEvent(event: TelemetryEventIngress, attribution: IngestAttribution): EventDecision {
  let snapshot: TelemetryEventIngress;
  let sessionId: unknown;
  let captureId: unknown;
  let origin: unknown;
  let announcedProducer: unknown;

  try {
    snapshot = { ...event };
    ({ sessionId, captureId, origin, producerId: announcedProducer } = attribution);
  } catch {
    // An event (or attribution) whose fields cannot be read cannot be shown to
    // carry a permitted tier: fail closed.
    return { outcome: dropped('tier-not-permitted'), producerMismatch: false };
  }

  // An attribution resolveBatch did not produce: never persist an event
  // without a session or outside a capture.
  if (!isIdentifier(sessionId)) {
    return { outcome: dropped('session-missing'), producerMismatch: false };
  }
  if (!isIdentifier(captureId)) {
    return { outcome: dropped('no-active-capture'), producerMismatch: false };
  }

  // The tier gate (see TIER_BY_ORIGIN): a page may not submit server or
  // database spans, and a dev server may not submit browser ones.
  const permitted =
    origin === 'browser-agent' || origin === 'server-agent' ? TIER_BY_ORIGIN[origin] : undefined;
  const tier: unknown = snapshot.tier;

  if (permitted === undefined || !isTelemetryTier(tier) || !permitted.includes(tier)) {
    return { outcome: dropped('tier-not-permitted'), producerMismatch: false };
  }

  // Identity is stamped last so a smuggled sessionId/captureId is overwritten;
  // every other field — startTime and duration included — is carried as is.
  // `captureId` is the window resolveBatch confirmed for the whole batch: a
  // batch of either tier whose producer was armed for another capture was
  // refused there as `stale-capture`, so it never reaches this stamp.
  const stamped: AttributedEvent = { ...snapshot, sessionId, captureId };

  // The store assigns ingestSeq. A value that bypassed the strict ingress
  // schema must not pre-empt it, so the key is removed from the new object.
  if (Object.hasOwn(stamped, 'ingestSeq')) {
    Reflect.deleteProperty(stamped, 'ingestSeq');
  }

  const producerMismatch =
    isIdentifier(announcedProducer) && snapshot.producerId !== announcedProducer;

  return { outcome: { kind: 'attributed', event: stamped }, producerMismatch };
}

/* -------------------------------------------------------------------------------------------------
 * The attributor
 * ---------------------------------------------------------------------------------------------- */

/**
 * Creates the attribution gate over the injected repository, session manager,
 * logger and clock.
 *
 * @param deps The collaborators; see {@link IngestAttributorDeps}.
 * @returns The attributor. It holds no state of its own between calls.
 */
export function createIngestAttributor(deps: IngestAttributorDeps): IngestAttributor {
  const sessions = deps.sessions;
  const manager = deps.sessionManager;
  const clock = deps.now ?? nowEpochMs;
  // Guarded before the child is derived: a logger that throws must never turn
  // an attribution decision into a crash, so neither `child()` nor any level
  // method of `log` or its children can throw — a failed write is dropped and
  // counted by the shared best-effort policy of `../logging.ts`.
  const log = subsystemLogger(guardLogger(deps.logger ?? noopLogger), ATTRIBUTION_SUBSYSTEM);

  /**
   * Emits one record, bound to the session and capture when known, through the
   * guarded logger; it never throws, so the decision stands whatever the sink does.
   */
  function emit(
    level: 'debug' | 'warn' | 'error',
    message: string,
    fields: LogFields,
    sessionId?: SessionId,
    captureId?: CaptureId,
  ): void {
    const target = sessionId === undefined ? log : sessionLogger(log, sessionId, captureId);
    target[level](message, fields);
  }

  /** The clock's reading, or `undefined` when it throws or is not finite. */
  function stamp(): number | undefined {
    try {
      const value = clock();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Builds and logs one refusal: an `Err` whose details carry the reason, the
   * drop marker and identifiers only.
   *
   * Routine refusals — a tab that is not bound, a session that has gone, no
   * capture running — are logged at `debug`, because producers legitimately
   * flush buffers around capture boundaries. Refusals that indicate a scope
   * violation, an inconsistent owner, a failing dependency or a batch recorded
   * for another capture (`stale-capture` — evidence that would otherwise have
   * been misfiled, and that this capture is missing) are logged at `warn`.
   */
  function refuse(spec: RefusalSpec): Result<never, DebuggenError> {
    const text =
      spec.fault === 'invalid-context'
        ? INVALID_CONTEXT_TEXT
        : spec.fault === 'store-read-failed' || spec.fault === 'dependency-threw'
          ? READ_FAILURE_TEXT
          : REFUSAL_TEXT[spec.reason];
    const code = spec.code ?? DROP_REASON_ERROR_CODES[spec.reason];
    const identifiers: LogFields = {
      ...(spec.tabId === undefined ? {} : { tabId: spec.tabId }),
      ...(spec.owningSessionId === undefined ? {} : { owningSessionId: spec.owningSessionId }),
    };
    const classification: LogFields = {
      ...(spec.fault === undefined ? {} : { fault: spec.fault }),
      ...(spec.mismatch === undefined ? {} : { mismatch: spec.mismatch }),
    };
    const error = new DebuggenError(code, text.message, {
      hint: text.hint,
      details: {
        reason: spec.reason,
        [ATTRIBUTION_DROP_DETAIL_KEY]: true,
        ...(spec.origin === undefined ? {} : { origin: spec.origin }),
        ...identifiers,
        ...(spec.sessionId === undefined ? {} : { sessionId: spec.sessionId }),
        ...(spec.captureId === undefined ? {} : { captureId: spec.captureId }),
        ...classification,
      },
    });
    const notable =
      spec.fault !== undefined ||
      spec.reason === 'project-scope-mismatch' ||
      spec.reason === 'capture-owner-mismatch' ||
      spec.reason === 'stale-capture';

    emit(
      notable ? 'warn' : 'debug',
      'telemetry batch dropped',
      {
        reason: spec.reason,
        code,
        ...(spec.origin === undefined
          ? {}
          : {
              origin: spec.origin,
              [LOG_BINDING_KEYS.client]: INGEST_ORIGIN_CLIENT_KIND[spec.origin],
            }),
        ...identifiers,
        ...classification,
      },
      spec.sessionId,
      spec.captureId,
    );

    return err(error);
  }

  /** Logs a resolved batch and returns its attribution. */
  function resolved(attribution: IngestAttribution): Result<IngestAttribution, DebuggenError> {
    emit(
      'debug',
      'telemetry batch resolved',
      {
        origin: attribution.origin,
        [LOG_BINDING_KEYS.client]: INGEST_ORIGIN_CLIENT_KIND[attribution.origin],
        ...(attribution.tabId === undefined ? {} : { tabId: attribution.tabId }),
      },
      attribution.sessionId,
      attribution.captureId,
    );

    return ok(attribution);
  }

  // -----------------------------------------------------------------------
  // Browser origin: tab binding → session → open capture
  // -----------------------------------------------------------------------

  function resolveBrowser(context: BrowserIngestContext): Result<IngestAttribution, DebuggenError> {
    const origin = 'browser-agent';
    const tabId: unknown = context.tabId;

    if (!isTabId(tabId)) {
      return refuse({ reason: 'no-binding', origin, fault: 'invalid-tab-id' });
    }

    const binding = readStore(
      () => sessions.getBindingByTab(tabId),
      (value): unknown => (value === undefined ? undefined : value.sessionId),
    );

    if (binding.read === 'failed') {
      return refuse({
        reason: 'no-binding',
        origin,
        code: binding.code,
        fault: binding.fault,
        tabId,
      });
    }
    if (binding.value === undefined) {
      return refuse({ reason: 'no-binding', origin, tabId });
    }

    const sessionId = binding.value;

    if (!isIdentifier(sessionId)) {
      return refuse({ reason: 'no-binding', origin, fault: 'invalid-binding', tabId });
    }

    const session = readStore(
      () => sessions.get(sessionId),
      (value): { readonly id: unknown; readonly projectRoot: unknown } | undefined =>
        value === undefined ? undefined : { id: value.id, projectRoot: value.projectRoot },
    );

    if (session.read === 'failed') {
      return refuse({
        reason: 'session-missing',
        origin,
        code: session.code,
        fault: session.fault,
        tabId,
        sessionId,
      });
    }
    if (session.value === undefined) {
      return refuse({ reason: 'session-missing', origin, tabId, sessionId });
    }
    if (session.value.id !== sessionId) {
      return refuse({
        reason: 'session-missing',
        origin,
        code: 'STORE_ERROR',
        fault: 'session-id-mismatch',
        tabId,
        sessionId,
      });
    }

    const capture = readStore(
      () => sessions.getActiveCapture(sessionId),
      (value): unknown => (value === undefined ? undefined : value.capture.id),
    );

    if (capture.read === 'failed') {
      return refuse({
        reason: 'no-active-capture',
        origin,
        code: capture.code,
        fault: capture.fault,
        tabId,
        sessionId,
      });
    }
    if (capture.value === undefined) {
      return refuse({ reason: 'no-active-capture', origin, tabId, sessionId });
    }

    const captureId = capture.value;

    if (!isIdentifier(captureId)) {
      return refuse({
        reason: 'no-active-capture',
        origin,
        code: 'STORE_ERROR',
        fault: 'invalid-capture',
        tabId,
        sessionId,
      });
    }

    // Refusal-only capture identity (module notes, "Capture identity, not
    // timestamps"): a batch the agent recorded for another capture is refused
    // whole rather than relabelled into this one. Checked only once an open
    // capture is confirmed, so "nothing is open" stays `no-active-capture`
    // whatever the batch names. The page-supplied value is compared, never
    // echoed: the refusal names the open capture it protected.
    const armedCaptureId: unknown = context.armedCaptureId;

    if (armedCaptureId !== undefined && armedCaptureId !== captureId) {
      return refuse({
        reason: 'stale-capture',
        origin,
        ...(isIdentifier(armedCaptureId) ? {} : { fault: 'invalid-armed-capture' as const }),
        tabId,
        sessionId,
        captureId,
      });
    }

    const projectRoot = session.value.projectRoot;
    const producerId: unknown = context.producerId;
    const resolvedAt = stamp();

    return resolved({
      sessionId,
      captureId,
      origin,
      tabId,
      ...(isIdentifier(projectRoot) ? { projectRoot: projectKey(projectRoot) } : {}),
      ...(isIdentifier(producerId) ? { producerId } : {}),
      ...(resolvedAt === undefined ? {} : { resolvedAt }),
    });
  }

  // -----------------------------------------------------------------------
  // Server origin: credential scope → capture owner → confirmed capture
  // -----------------------------------------------------------------------

  /**
   * The capture owner as the session manager names it, confirmed against the
   * store's open capture row of that session.
   */
  function ownerFromManager(
    sessionManager: SessionManagerLike,
    key: string,
  ): Result<CaptureOwnerLike, DebuggenError> {
    const origin = 'server-agent';
    let named: { readonly sessionId: unknown; readonly captureId: unknown } | undefined;

    try {
      const owner = sessionManager.captureOwnerForProject(key);
      named =
        owner === undefined
          ? undefined
          : { sessionId: owner.sessionId, captureId: owner.captureId };
    } catch {
      return refuse({
        reason: 'capture-owner-mismatch',
        origin,
        code: 'INTERNAL',
        fault: 'dependency-threw',
      });
    }

    if (named === undefined) {
      return refuse({ reason: 'no-active-capture', origin });
    }

    const { sessionId, captureId } = named;

    if (!isIdentifier(sessionId) || !isIdentifier(captureId)) {
      return refuse({
        reason: 'capture-owner-mismatch',
        origin,
        code: 'INTERNAL',
        fault: 'invalid-owner',
      });
    }

    const open = readStore(
      () => sessions.getActiveCapture(sessionId),
      (value): unknown => (value === undefined ? undefined : value.capture.id),
    );

    if (open.read === 'failed') {
      return refuse({
        reason: 'capture-owner-mismatch',
        origin,
        code: open.code,
        fault: open.fault,
        owningSessionId: sessionId,
      });
    }
    if (open.value === undefined) {
      return refuse({
        reason: 'capture-owner-mismatch',
        origin,
        fault: 'capture-closed',
        owningSessionId: sessionId,
      });
    }
    if (open.value !== captureId) {
      return refuse({
        reason: 'capture-owner-mismatch',
        origin,
        fault: 'capture-changed',
        owningSessionId: sessionId,
      });
    }

    return ok({ sessionId, captureId });
  }

  /**
   * The documented fallback when no session manager is injected: list the
   * `capturing` sessions, keep those whose normalised root is the project's,
   * and require that exactly one of them has an open capture window.
   *
   * This reaches the same answer as the manager's owner index — which is
   * itself rebuilt from these rows — without its in-memory state. Zero owners
   * is `no-active-capture`; two is an exclusivity violation (AAP §0.4.2) and is
   * refused rather than resolved by guessing.
   */
  function ownerFromRepository(key: string): Result<CaptureOwnerLike, DebuggenError> {
    const origin = 'server-agent';

    if (typeof sessions.list !== 'function') {
      return refuse({ reason: 'no-active-capture', origin, fault: 'owner-lookup-unavailable' });
    }

    const candidates = new Set<SessionId>();
    let offset = 0;
    let exhausted = false;

    for (let pages = 0; pages < MAX_FALLBACK_PAGES; pages += 1) {
      const query: CapturingSessionsQuery = {
        statuses: CAPTURING_STATUSES,
        limit: FALLBACK_PAGE_SIZE,
        offset,
      };
      const page = readStore(
        (): Result<SessionPageLike | undefined> => sessions.list?.(query) ?? ok(undefined),
        (value): { readonly items: readonly ListedSessionLike[]; readonly total: number } =>
          value === undefined
            ? { items: [], total: 0 }
            : { items: Array.from(value.items), total: value.total },
      );

      if (page.read === 'failed') {
        return refuse({
          reason: 'capture-owner-mismatch',
          origin,
          code: page.code,
          fault: page.fault,
        });
      }

      for (const item of page.value.items) {
        const id: unknown = item.id;
        const root: unknown = item.projectRoot;

        if (isIdentifier(id) && isIdentifier(root) && projectKey(root) === key) {
          candidates.add(id);
        }
      }

      offset += page.value.items.length;

      if (page.value.items.length === 0 || offset >= page.value.total) {
        exhausted = true;
        break;
      }
    }

    if (!exhausted) {
      emit('warn', 'capture owner scan stopped at its page bound', {
        origin,
        pages: MAX_FALLBACK_PAGES,
        candidates: candidates.size,
      });
    }

    const owners: CaptureOwnerLike[] = [];

    for (const sessionId of candidates) {
      const open = readStore(
        () => sessions.getActiveCapture(sessionId),
        (value): unknown => (value === undefined ? undefined : value.capture.id),
      );

      if (open.read === 'failed') {
        return refuse({
          reason: 'capture-owner-mismatch',
          origin,
          code: open.code,
          fault: open.fault,
          owningSessionId: sessionId,
        });
      }
      if (isIdentifier(open.value)) {
        owners.push({ sessionId, captureId: open.value });
      }
    }

    const [owner, second] = owners;

    if (owner === undefined) {
      return refuse({ reason: 'no-active-capture', origin });
    }
    if (second !== undefined) {
      emit('error', 'two sessions hold an open capture window on one project', {
        origin,
        owners: owners.length,
      });
      return refuse({ reason: 'capture-owner-mismatch', origin, fault: 'ambiguous-owner' });
    }

    return ok(owner);
  }

  function resolveServer(context: ServerIngestContext): Result<IngestAttribution, DebuggenError> {
    const origin = 'server-agent';
    const requested: unknown = context.projectRoot;
    const scoped: unknown = context.scopedProjectRoot;

    // Both halves are required: the body's claim alone is a self-description,
    // and the credential's scope alone would let a batch omit what it is for.
    if (!isIdentifier(requested)) {
      return refuse({ reason: 'project-scope-mismatch', origin, mismatch: 'missing-project-root' });
    }
    if (!isIdentifier(scoped)) {
      return refuse({
        reason: 'project-scope-mismatch',
        origin,
        mismatch: 'missing-credential-scope',
      });
    }

    const requestKey = projectKey(requested);
    const scopeKey = projectKey(scoped);

    // Equality, deliberately not containment. A server-agent credential is
    // minted for exactly one project root (AAP §0.5.6); a directory beneath it
    // — a workspace package, a nested app — is a different project whose
    // sessions the credential was never issued for, so a descendant is refused
    // exactly like an unrelated path. isWithin only names the kind of mismatch.
    if (requestKey !== scopeKey) {
      return refuse({
        reason: 'project-scope-mismatch',
        origin,
        mismatch: classifyScopeMismatch(scopeKey, requestKey),
      });
    }

    const owner =
      manager === undefined ? ownerFromRepository(scopeKey) : ownerFromManager(manager, scopeKey);

    if (isErr(owner)) {
      return owner;
    }

    // Both owner paths answer only with a capture confirmed against the
    // store's open capture row, so this is the window the batch would be
    // stamped with.
    const { sessionId, captureId } = owner.value;

    // Refusal-only capture identity, exactly as for a browser batch (module
    // notes, "Capture identity, not timestamps"): a batch the preload recorded
    // for another capture — a POST retried in place across a Stop and a Start —
    // is refused whole rather than relabelled into this one. Checked only once
    // the owner and its open capture are confirmed, so the scope refusals,
    // `no-active-capture` and `capture-owner-mismatch` stand whatever the batch
    // names. The producer-supplied value is compared, never echoed: the refusal
    // names the open capture it protected.
    const armedCaptureId: unknown = context.armedCaptureId;

    if (armedCaptureId !== undefined && armedCaptureId !== captureId) {
      return refuse({
        reason: 'stale-capture',
        origin,
        ...(isIdentifier(armedCaptureId) ? {} : { fault: 'invalid-armed-capture' as const }),
        sessionId,
        captureId,
      });
    }

    const producerId: unknown = context.producerId;
    const resolvedAt = stamp();

    return resolved({
      sessionId,
      captureId,
      origin,
      projectRoot: scopeKey,
      ...(isIdentifier(producerId) ? { producerId } : {}),
      ...(resolvedAt === undefined ? {} : { resolvedAt }),
    });
  }

  // -----------------------------------------------------------------------
  // Public surface
  // -----------------------------------------------------------------------

  /**
   * Dispatches on the context's origin. Every dependency read below is already
   * guarded, so the `catch` is reached only by a context whose own fields
   * throw; it is refused with the reason its origin's first check would have
   * produced. A context naming no known origin cannot be bound to anything.
   */
  function resolve(context: IngestContext): Result<IngestAttribution, DebuggenError> {
    let origin: IngestOrigin | undefined;

    try {
      switch (context.origin) {
        case 'browser-agent':
          origin = 'browser-agent';
          return resolveBrowser(context);
        case 'server-agent':
          origin = 'server-agent';
          return resolveServer(context);
        default:
          break;
      }
    } catch {
      return refuse({
        reason: origin === 'server-agent' ? 'project-scope-mismatch' : 'no-binding',
        origin,
        code: 'INTERNAL',
        fault: 'invalid-context',
      });
    }

    return refuse({ reason: 'no-binding', code: 'INTERNAL', fault: 'invalid-context' });
  }

  function resolveBatch(context: IngestContext): Promise<Result<IngestAttribution, DebuggenError>> {
    // Synchronous underneath — both collaborators are — and asynchronous in
    // its contract, so a collaborator may become asynchronous without every
    // caller changing shape.
    return Promise.resolve(resolve(context));
  }

  function attributeEvent(
    event: TelemetryEventIngress,
    attribution: IngestAttribution,
  ): AttributionOutcome {
    return decideEvent(event, attribution).outcome;
  }

  function attributeBatch(
    events: readonly TelemetryEventIngress[],
    attribution: IngestAttribution,
  ): AttributedBatch {
    const outcomes: AttributionOutcome[] = [];
    const attributed: AttributedEvent[] = [];
    const counts = zeroCounts();
    let droppedTotal = 0;
    let producerMismatches = 0;
    let batch: readonly TelemetryEventIngress[];

    try {
      // Copied once, so a batch that changes while it is being attributed
      // cannot make the counts disagree with the outcomes.
      batch = Array.isArray(events) ? Array.from(events) : [];
    } catch {
      batch = [];
    }

    for (const event of batch) {
      const decision = decideEvent(event, attribution);

      outcomes.push(decision.outcome);

      if (decision.outcome.kind === 'attributed') {
        attributed.push(decision.outcome.event);
        if (decision.producerMismatch) {
          producerMismatches += 1;
        }
      } else {
        counts[decision.outcome.reason] += 1;
        droppedTotal += 1;
      }
    }

    const droppedByReason: LogFields = {};

    for (const reason of DROP_REASONS) {
      if (counts[reason] > 0) {
        droppedByReason[reason] = counts[reason];
      }
    }

    const summary: LogFields = {
      events: batch.length,
      attributed: attributed.length,
      dropped: droppedTotal,
      ...(droppedTotal > 0 ? { droppedByReason } : {}),
      producerMismatches,
    };

    let sessionId: unknown;
    let captureId: unknown;
    let origin: unknown;

    try {
      ({ sessionId, captureId, origin } = attribution);
    } catch {
      sessionId = undefined;
      captureId = undefined;
      origin = undefined;
    }

    if (origin === 'browser-agent' || origin === 'server-agent') {
      summary.origin = origin;
      summary[LOG_BINDING_KEYS.client] = INGEST_ORIGIN_CLIENT_KIND[origin];
    }

    // A refused tier is a producer claiming more than its role: worth a warning.
    emit(
      counts['tier-not-permitted'] > 0 ? 'warn' : 'debug',
      'telemetry batch attributed',
      summary,
      isIdentifier(sessionId) ? sessionId : undefined,
      isIdentifier(captureId) ? captureId : undefined,
    );

    return {
      outcomes,
      events: attributed,
      dropped: Object.freeze(counts),
      droppedTotal,
      producerMismatches,
    };
  }

  return Object.freeze({ resolveBatch, attributeEvent, attributeBatch });
}
