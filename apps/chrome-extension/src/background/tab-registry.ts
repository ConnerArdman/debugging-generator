/**
 * The service worker's memory of which inspected tab belongs to which
 * debugging session — the tab ↔ session registry of AAP §0.7.1 Group 4,
 * persisted in `chrome.storage.session`.
 *
 * ## The worker mirrors; the service decides
 *
 * AAP §0.2.3 makes the **local service** the authority on bindings: the
 * DevTools panel announces its inspected tab with `session.bind`, the service
 * matches the tab's origin against a session's dev-server origin (or checks
 * the origin of the session the panel named) and answers `session.bound`. This
 * module therefore does exactly two things with a binding:
 *
 * - it **requests** one ({@link TabRegistry.requestBind}), which records
 *   nothing, and
 * - it **records** what the service confirmed ({@link TabRegistry.applyBound}),
 *   which is the only path that creates a {@link TabBindingRecord}.
 *
 * A tab whose origin "looks right" is never bound locally: that would let a tab
 * claim a session the service never approved.
 *
 * ## The rules it keeps (AAP §0.2.3, §0.4.2, §0.5.5)
 *
 * 1. One tab binds to at most one session, and one session accepts one bound
 *    tab at a time. Recording a binding removes any other record for the same
 *    session and replaces any record for the same tab; a tab displaced that way
 *    is told through its panel, so it never keeps claiming "Connected".
 * 2. Every committed navigation to a URL the service accepts is reported as
 *    `tab.navigated`. A same-origin navigation keeps the binding (and the
 *    capture running on it) and returns a decision telling `agent-control.ts`
 *    to re-arm the page agent; a cross-origin navigation sends
 *    `session.unbind`, drops the record and pushes the "Tab left ‹origin›"
 *    state to the panel. A navigation to a document with no URL the service
 *    accepts (`chrome://`, `about:blank`, `file:`, an extension page) cannot
 *    be reported, so it is handed over as the tab id alone
 *    ({@link TabRegistry.handleUnreportableNavigation}) and, for a bound tab,
 *    takes the cross-origin branch without the report: the URL never leaves
 *    the worker. A tab that later commits a document on the very origin it
 *    left is no longer away ({@link TabRegistry.handleReturnedNavigation}):
 *    its "Tab left ‹origin›" state is withdrawn, and `service-worker.ts`
 *    announces the tab again so the service can bind it.
 * 3. DevTools closing, the tab closing and the session ending all send
 *    `session.unbind`.
 * 4. Every `session.unbind` is owed until the service has it: the intent is
 *    written ahead as a tombstone and re-sent after a reconnect (below).
 * 5. The registry is bounded, and nothing it forgets to stay bounded is left
 *    bound at the service. See "Capacity" below.
 *
 * ## Unbind tombstones: an unbind outlives the worker that decided it
 *
 * `session.unbind` is the only way the service learns that a binding ended on
 * the worker's side, and the service keeps a binding across a dropped socket
 * (AAP §0.5.5). A frame handed to a reconnecting socket waits in the socket
 * client's memory, which a worker eviction discards; a refused frame is not
 * sent at all; and a reconnect re-announces only the bindings that remain. A
 * lost unbind would therefore leave the service routing `agent.config`,
 * `telemetry.tail` and `panel.generated` to a tab that left or closed.
 *
 * So every unbind — a cross-origin navigation, a navigation to a document the
 * service cannot be told about, DevTools closing, the tab closing, the session
 * ending, a binding ended to stay within {@link MAX_STORED_TAB_BINDINGS} —
 * first writes a {@link TabUnbindTombstone} under
 * {@link UNBIND_TOMBSTONE_STORAGE_KEY}, *before* the frame is reported and
 * before the record is dropped, so a crash anywhere after the decision still
 * leaves the intent recorded. A tab holds at most one tombstone (a newer one
 * replaces it) and never a tombstone and a record at once, and the list holds
 * at most {@link MAX_STORED_UNBIND_TOMBSTONES} (see "Capacity").
 *
 * ### Delivery
 *
 * {@link TabRegistry.flushPendingUnbinds} re-sends every tombstone, oldest
 * first, each time the socket opens. A frame queued while the socket
 * reconnects is not a delivery (it dies with the worker), and a refused one
 * leaves the tombstone as it was.
 *
 * The wire payload of `session.unbind` is the tab id alone, so an unbind that
 * reaches the service *after* a newer `session.bind` of the same tab ends the
 * newer binding. {@link TabRegistry.requestBind} of a tab holding a tombstone
 * therefore hands the owed `session.unbind` to the transport first and the
 * `session.bind` second — the socket client is FIFO within one worker
 * generation, so the service ends whatever stale binding it holds before it
 * considers the bind — and marks the tab in this generation's memory: later
 * flushes of this generation skip its tombstone, because a flushed unbind
 * would now follow the bind. The mark is dropped whenever the tombstone is
 * retired or replaced, and it dies with the worker, so the next generation's
 * first flush re-sends the unbind. That is right whether the bind was lost
 * with the socket client's queue or rejected by the service; if the service
 * applied it and only its `session.bound` was lost, the re-sent unbind ends
 * it, and the DevTools page's rebind on the next connect restores it.
 *
 * ### Retirement
 *
 * A tombstone is retired only when it is:
 *
 * - **acknowledged** — the service announces a drop (`unbound`,
 *   `origin-changed` or `replaced`) for the tab, and for the tombstone's
 *   session when it names one;
 * - **superseded by a confirmed bind** — {@link TabRegistry.applyBound}
 *   records a binding for the tab: the service accepted a bind, which replaced
 *   whatever it held. *Asking* for a bind supersedes nothing: a bind lost on
 *   eviction, refused by the transport or rejected by the service leaves the
 *   stale binding at the service and the unbind owed;
 * - **exhausted** — its frame was delivered to an open socket on
 *   {@link MAX_UNBIND_TOMBSTONE_DELIVERIES} connections without an answer; or
 * - **expired** — it was delivered at least once and is older than
 *   {@link UNBIND_TOMBSTONE_TTL_MS}. A tombstone never delivered to an open
 *   socket is never retired by age.
 *
 * Whatever remains is discarded with `chrome.storage.session` when the browser
 * session ends.
 *
 * ### Storage failures
 *
 * The tombstone key hydrates separately from the binding key. A failed read
 * leaves it unhydrated: nothing is written to it — a write would erase the
 * intents it holds — and the read is retried at the start of every later
 * operation until it succeeds. The stored tombstones are then merged under
 * what this generation decided, which is newer: its own tombstones, and its
 * own retirements and confirmed bindings of a tab. A failed write keeps the
 * list in memory, marked dirty, and is retried at the start of every later
 * operation — every flush included — until it succeeds.
 *
 * Meanwhile the unbind is still sent and the record still dropped: the tab did
 * leave or close, and keeping the record would keep routing the session's
 * `agent.config`, `telemetry.tail` and `panel.generated` to it (AAP §0.2.3).
 * The cost is that an eviction before a retried write succeeds loses the
 * intent, as it would have without a tombstone.
 *
 * A crash between writing a tombstone and dropping the record can leave both
 * for one tab. Hydration keeps whichever decision came last: a tombstone
 * created at or after the record's `boundAt` ends the record, an older one is
 * stale and is dropped. When the tombstone key hydrates late, a record it ends
 * has already been in use, so that removal is pushed and announced like any
 * other.
 *
 * ## Capacity: bounded, and nothing owed is forgotten
 *
 * The service keeps a devtools binding across a dropped socket and a client
 * that unregisters, and never tells the worker which bindings it holds; the
 * worker's records and tombstones are therefore the only account of them. So
 * the registry is bounded by the **obligations** it tracks, not by evicting
 * them. A tab *holds a slot* while the service may hold a binding for it that
 * this worker still has to account for:
 *
 * - it has a **record** (a binding the service confirmed);
 * - it has an **undelivered tombstone** (`deliveries: 0` — an unbind that has
 *   never reached an open socket); or
 * - it has a **bind in flight**: a `session.bind` this worker generation
 *   handed to the transport that no confirmation has recorded and no unbind
 *   of the tab has ended (memory only — the socket that would answer it dies
 *   with the generation).
 *
 * The registry's own writes never let more than
 * {@link MAX_STORED_TAB_BINDINGS} tabs hold a slot, and
 * {@link MAX_STORED_UNBIND_TOMBSTONES} is at least that, so every undelivered
 * tombstone always fits in the list. The limit is kept where an obligation is
 * **taken on**, never by dropping one:
 *
 * - {@link TabRegistry.requestBind} of a tab that holds no slot while every
 *   slot is held is refused with `RATE_LIMITED` before anything is sent, so a
 *   bind the service may apply always has a slot to land in;
 * - a confirmation of a tab that holds no slot (its bind's slot was released —
 *   DevTools closed on it, say) at the limit first makes room: owed unbinds are
 *   delivered now, then the least recently bound binding is ended through the
 *   ordinary unbind (tombstone written ahead with cause `binding-limit`,
 *   `session.unbind` reported, `unbound` pushed, change announced). Only a
 *   delivered unbind frees a slot, so when the socket takes no frame the
 *   confirmation is declined rather than recorded past the limit; the
 *   DevTools page's rebind on the next connect records it then;
 * - an unbind of a tab holding no slot — DevTools closing on a tab with no
 *   binding, no bind in flight and no owed unbind — while every slot is held
 *   is still handed to the transport, but not written as a tombstone: nothing
 *   this generation did can have left the service a binding of that tab.
 *
 * Every other change converts a slot rather than adding one (a record ending
 * becomes its tombstone, a confirmation lands in its bind's slot) or frees one
 * (a delivery, an acknowledgement, a superseding confirmation). The tombstone
 * list outgrows its limit only through *delivered* tombstones, and those are
 * what is evicted, oldest first: their unbind has reached the service's socket,
 * and only the retransmission {@link MAX_UNBIND_TOMBSTONE_DELIVERIES} allows is
 * given up. No sequence of the registry's own writes evicts an undelivered
 * tombstone; only state it did not write can force that — stored data beyond
 * its limits, or a merge after an unreadable tombstone key counted nothing
 * stored — and such an eviction is logged as an error.
 *
 * Hydration applies the same rule to what it cannot keep. Stored bindings
 * beyond {@link MAX_STORED_TAB_BINDINGS} were confirmed once and may still be
 * bound at the service, so each is ended through an owed unbind (cause
 * `binding-limit`, the frame sent at once unless a bind of the tab is in
 * flight, whose confirmation supersedes it) and its removal pushed and
 * announced — never forgotten silently. At most
 * {@link MAX_STORED_UNBIND_TOMBSTONES} are ended that way, so corrupted storage
 * cannot make the worker send an unbounded burst; the rest are dropped and
 * logged as an error. A binding dropped because another stored entry names the
 * same session is not unbound: the service holds that session on one tab only,
 * and a `session.unbind { tabId }` for the stale duplicate could end an
 * unrelated, newer binding of that tab.
 *
 * `chrome.storage.session` is cleared when the extension is disabled, reloaded
 * or updated and when the browser restarts, so what hydration reads was always
 * written by this code — within these limits — and stored data beyond them is
 * corruption. It is still handled as above, never trusted to be impossible.
 *
 * ## Why `chrome.storage.session`
 *
 * A Manifest V3 service worker is evicted after roughly thirty seconds idle and
 * re-evaluated from scratch on the next event, so a binding held only in memory
 * would vanish mid-session. `chrome.storage.session` survives that eviction and
 * is cleared when the browser session ends — exactly the lifetime a binding
 * has: tab ids are only meaningful within one browser session, and a binding
 * that outlived it would route telemetry to whatever tab reused the id.
 * `chrome.storage.local` is wrong for the same reason — it persists across
 * browser restarts, so a stale binding would outlive the tabs it names. Unbind
 * tombstones live in the same area for the same reason: a tombstone names a tab
 * id, and replayed in a later browser session it could end the binding of
 * whatever tab reused that id.
 *
 * The in-memory maps are a **cache** of that storage, never the source of truth.
 * After a revival they are empty, so every read path hydrates both keys from
 * storage first ({@link TabRegistry.reload}), and every mutation is written
 * through to storage — or, for the tombstones, held dirty and retried — before
 * it is announced to a panel or a listener. What is read back is
 * untrusted JSON from an earlier worker generation, and each entry is validated
 * field by field before it is relied on, with the protocol schemas that define
 * those fields rather than limits restated here: a binding's session id, tab id
 * and URL with the `session.bound` payload's schema, its capture id with the
 * `capture.started` payload's, a tombstone's tab id with the `session.unbind`
 * payload's (the frame it re-sends) and its session id with the binding's. So a
 * URL longer than 2,048 characters, or an id longer than 64, is never hydrated.
 * A malformed entry is dropped, never cast; of the valid ones, only the newest
 * bindings within {@link MAX_STORED_TAB_BINDINGS} are kept (the rest are ended
 * through owed unbinds, as "Capacity" describes) and the tombstones within
 * {@link MAX_STORED_UNBIND_TOMBSTONES}, undelivered ones first; and whatever
 * was dropped is rewritten out of storage.
 *
 * ## Invariants
 *
 * - **No import-time side effect.** Every top-level statement is a declaration;
 *   all state lives in the {@link createTabRegistry} closure, and no `chrome.*`
 *   listener is registered here — `service-worker.ts` owns
 *   `chrome.tabs.onUpdated`/`onRemoved` and feeds this module.
 * - **No transport.** Frames leave through the injected {@link ProtocolSend};
 *   panel state leaves through the injected {@link PortPushSink}. No socket, no
 *   `fetch`, no `chrome.tabs`, no `chrome.alarms`, nothing read from a page.
 * - **Serialized.** Every operation — reads included — runs on one promise
 *   chain, so two rapid navigations cannot interleave into a lost update and
 *   outbound frames leave in the order the calls were made. Each queued
 *   operation first retries whatever tombstone storage I/O an earlier one
 *   left owed (a failed read, a dirty list), and does no I/O when nothing is.
 * - **Bounded, and written as it is read.** In memory and in storage alike, the
 *   binding map never holds more than {@link MAX_STORED_TAB_BINDINGS} records
 *   and the tombstone list never more than {@link MAX_STORED_UNBIND_TOMBSTONES}
 *   entries; no write of the registry's own makes more than
 *   {@link MAX_STORED_TAB_BINDINGS} tabs hold a slot, and a bind request is
 *   refused rather than let the in-flight binds do so. Every field held is
 *   within the protocol schema that defines it: a confirmed binding is
 *   validated by `session.bound`'s schema, a capture id by
 *   `capture.started`'s, and a navigation URL outside `tab.navigated`'s bounds
 *   is never recorded. What one generation writes is therefore exactly what
 *   the next one hydrates.
 * - **No authored wording.** The "Tab left ‹origin›" notice is
 *   `formatTabLeftMessage` from `../shared/messages`; every binding reason is a
 *   member of the protocol's `BINDING_REASONS` vocabulary.
 * - **Privacy.** Log lines carry the tab id, session id, origin, decision and
 *   counts only — never a URL (its path and query stay out of every log), never a
 *   token, never page content. URLs handed to this module are expected to be
 *   query-redacted by their producer (AAP §0.5.2); the module stores and sends
 *   them as given and never inspects them beyond their origin.
 *
 * Governed by AAP §0.2.3 ("Tab/session binding"), §0.4.2 (the `session.bind`,
 * `session.bound`, `tab.navigated` and `session.unbind` rows), §0.5.5
 * ("Application reloads mid-session"), §0.7.1 Group 4 and §0.8.1 slice 4.
 *
 * @module apps/chrome-extension/src/background/tab-registry
 */

import type {
  BindingReason,
  CaptureStartedPayload,
  CaptureStoppedPayload,
  MessagePayload,
  MessageType,
  SendOutcome,
  SessionBindPayload,
  SessionBoundPayload,
  SessionStatus,
  SessionUnbindPayload,
  SessionUpdatedPayload,
  TabNavigatedPayload,
} from '@debuggen/protocol';
import {
  captureStartedPayloadSchema,
  MESSAGE_TYPE,
  parseSessionBindPayload,
  parseSessionBoundPayload,
  parseSessionUnbindPayload,
  parseTabNavigatedPayload,
  sessionBoundPayloadSchema,
} from '@debuggen/protocol';
import type { CaptureId, LogFields, Logger, Result, SessionId } from '@debuggen/shared';
import { assertNever, DebuggenError, err, noopLogger, nowEpochMs, ok } from '@debuggen/shared';

import type { PanelBindingState, PortBindingPush } from '../shared/messages';
import { EXTENSION_CHANNEL, formatTabLeftMessage, PORT_PROTOCOL_VERSION } from '../shared/messages';

import type { PortPushSink, ProtocolSend, TabBindingRecord, TabBindingSnapshot } from './messages';
import { workerError } from './messages';

/*
 * ===========================================================================
 * Section A — derived primitives and vocabulary
 * ===========================================================================
 */

/** A Chrome tab id, exactly as the protocol's binding payloads type it. */
type TabId = SessionBindPayload['tabId'];

/** A wall-clock instant in epoch milliseconds, as {@link nowEpochMs} returns it. */
type EpochMs = ReturnType<typeof nowEpochMs>;

/*
 * The binding reasons this module branches on or announces. Each is a member
 * of the protocol's closed `BINDING_REASONS` vocabulary — `satisfies` makes a
 * reason the vocabulary does not contain a compile error here — and every
 * `switch` over a `BindingReason` below ends in `assertNever`, so a reason
 * added upstream stops this module compiling until it is handled.
 */
const REASON_BOUND = 'bound' satisfies BindingReason;
const REASON_REPLACED = 'replaced' satisfies BindingReason;
const REASON_NAVIGATED = 'navigated' satisfies BindingReason;
const REASON_ORIGIN_CHANGED = 'origin-changed' satisfies BindingReason;
const REASON_UNBOUND = 'unbound' satisfies BindingReason;

/**
 * The session status that means "this session is over" — a member of the
 * protocol's `SESSION_STATUSES`, checked by `satisfies`. The registry reacts to
 * it arriving on `session.updated`; it never derives it.
 */
const SESSION_STATUS_ENDED = 'ended' satisfies SessionStatus;

/**
 * The key under which the whole binding map is stored in
 * `chrome.storage.session`.
 *
 * Declared once, here, because this module is the single owner of that
 * storage entry: nothing else in the extension reads or writes it. The value
 * stored under it is a {@link TabBindingSnapshot}.
 */
export const BINDING_STORAGE_KEY = 'debuggen.tabBindings';

/**
 * Why the worker itself ends a binding — the three causes of `session.unbind`
 * the worker observes (AAP §0.2.3): the DevTools window inspecting the tab
 * closed (the panel or devtools port disconnected, reported by `ports.ts`), the
 * tab closed (`chrome.tabs.onRemoved`, fed by `service-worker.ts`), or the
 * session ended (relayed `session.updated` / `cleanup.completed`).
 *
 * A worker-internal vocabulary: it is logged and reported on
 * {@link TabBindingChange.cause}, and never sent — the wire payload of
 * `session.unbind` is the tab id alone, because the service does not need to
 * know which of the three it was.
 */
export const TAB_UNBIND_CAUSES = Object.freeze([
  'devtools-closed',
  'tab-closed',
  'session-ended',
] as const);

/** One of {@link TAB_UNBIND_CAUSES}. */
export type TabUnbindCause = (typeof TAB_UNBIND_CAUSES)[number];

/** The cause {@link TabRegistry.handleSessionEnded} unbinds under. */
const CAUSE_SESSION_ENDED = 'session-ended' satisfies TabUnbindCause;

/**
 * The cause whose unbind is reported even when no record exists: a panel that
 * was open on the tab may have asked for a binding the service confirmed but
 * whose `session.bound` has not reached this worker yet, and `session.unbind`
 * is idempotent at the service, so reporting it costs nothing and closes that
 * race. Its tombstone names no session, so any drop the service announces for
 * the tab acknowledges it.
 */
const CAUSE_DEVTOOLS_CLOSED = 'devtools-closed' satisfies TabUnbindCause;

/**
 * Every reason an {@link TabUnbindTombstone} records: the three
 * {@link TAB_UNBIND_CAUSES}, plus two the worker decides on its own:
 *
 * - `navigated-away` — a bound tab committed a document off its bound origin:
 *   a cross-origin navigation, or one with no URL the service accepts
 *   (`chrome://`, `about:blank`, `file:`, an extension page);
 * - `binding-limit` — the binding was ended to keep the registry within
 *   {@link MAX_STORED_TAB_BINDINGS}: it was the least recently bound when a
 *   confirmation needed a slot none was free for, or a stored binding beyond
 *   the limit that hydration could not keep (see "Capacity" in the module
 *   overview).
 *
 * Stored and logged, never sent. Neither of the two is a
 * {@link TabUnbindCause}, so a change announcing either carries no `cause`
 * (see {@link TabBindingChange.cause}).
 */
export const UNBIND_TOMBSTONE_CAUSES = Object.freeze([
  ...TAB_UNBIND_CAUSES,
  'navigated-away',
  'binding-limit',
] as const);

/** One of {@link UNBIND_TOMBSTONE_CAUSES}. */
export type UnbindTombstoneCause = (typeof UNBIND_TOMBSTONE_CAUSES)[number];

/** The cause a navigation off the bound origin is tombstoned under. */
const CAUSE_NAVIGATED_AWAY = 'navigated-away' satisfies UnbindTombstoneCause;

/** The cause a binding ended to stay within {@link MAX_STORED_TAB_BINDINGS} is tombstoned under. */
const CAUSE_BINDING_LIMIT = 'binding-limit' satisfies UnbindTombstoneCause;

/**
 * The key under which the pending unbind tombstones are stored in
 * `chrome.storage.session`, separately from {@link BINDING_STORAGE_KEY} so the
 * {@link TabBindingSnapshot} shape stays exactly the bindings. The value
 * stored under it is an array of {@link TabUnbindTombstone}, oldest first.
 * Owned by this module alone, like the binding key.
 */
export const UNBIND_TOMBSTONE_STORAGE_KEY = 'debuggen.tabUnbindTombstones';

/**
 * How many deliveries — hand-offs of one tombstone's `session.unbind` to an
 * **open** socket (transport outcome `sent`) — retire it unacknowledged.
 *
 * **Why not wait for an acknowledgement alone.** The service answers
 * `session.unbind` (with `session.bound`, reason `unbound`) only when the tab
 * was still bound; an unbind of an unbound tab is ignored without any reply.
 * So an unbind the service applied whose answer was lost with the socket, one
 * the service had already applied, and one it never needed (DevTools closing
 * on a tab it never bound) are indistinguishable here from one it never
 * received. An acknowledgement-only rule would re-send each of them on every
 * reconnect for the rest of the browser session.
 *
 * **Why three deliveries on distinct connections.** What the worker can
 * observe is whether a frame was written to an open socket. A WebSocket is an
 * ordered, reliable stream the service reads in order, so a written frame is
 * lost only when its connection drops before the service reads it. The count
 * grows at most once per *delivery epoch* — the span between two
 * {@link TabRegistry.flushPendingUnbinds} calls, which `service-worker.ts`
 * makes once per transition of the socket to connected — however often
 * {@link TabRegistry.requestBind} re-sends the unbind ahead of a bind within
 * it, so the counted deliveries lie on distinct connections. Three
 * connections each dropping before the service read the frame is the
 * strongest evidence of receipt available without a reply. One skew is
 * inherent: a frame that an operation already running writes to a socket
 * that opened just before its flush ran is counted in the previous epoch, so
 * one connection can contribute two counts and the three deliveries then span
 * at least two distinct connections.
 */
export const MAX_UNBIND_TOMBSTONE_DELIVERIES = 3;

/**
 * The age, in milliseconds, past which a *delivered* tombstone is retired by
 * {@link TabRegistry.flushPendingUnbinds}: twenty-four hours.
 *
 * Only a tombstone delivered to an open socket at least once
 * (`deliveries >= 1`) ages out, short of
 * {@link MAX_UNBIND_TOMBSTONE_DELIVERIES}: its unbind has reached the service's
 * socket, and the binding it names is at least a day old. A tombstone that was
 * only queued or refused has told the service nothing, and the service keeps a
 * devtools binding across a dropped socket (AAP §0.5.5), so the intent must
 * outlast any outage — a service down or restarting, a revoked credential
 * awaiting re-pairing: age never retires it. It persists until it is
 * delivered, acknowledged, superseded by a confirmed bind, or discarded with
 * `chrome.storage.session` when the browser session ends.
 */
export const UNBIND_TOMBSTONE_TTL_MS = 24 * 60 * 60_000;

/**
 * The most tabs the registry tracks as possibly bound at the service — tabs
 * holding a *slot*: a binding, an undelivered unbind or a bind in flight (see
 * "Capacity" in the module overview) — and so the most bindings it holds in
 * memory, under {@link BINDING_STORAGE_KEY}, and on hydration: 256.
 *
 * **Why a limit.** The stored snapshot is read back as untrusted data, and
 * every binding it yields is held, validated, re-announced and routed to for
 * the rest of the worker's life; a corrupted or oversized entry must not be
 * able to make a restarted worker carry an unbounded map.
 *
 * **Why 256.** A binding is one DevTools-inspected tab per live session — one
 * session accepts one bound tab at a time — so the count in use is the number
 * of sessions a developer runs at once with DevTools open on each: a handful.
 * 256 is two orders of magnitude of headroom over that, and small enough that
 * validating and sorting a full snapshot on every worker revival costs nothing
 * noticeable.
 *
 * **At the limit.** A bind request of a tab holding no slot is refused
 * (`RATE_LIMITED`, nothing sent); a confirmation that needs a slot first
 * delivers owed unbinds and then ends the least recently bound binding through
 * the ordinary unbind (a tombstone with cause `binding-limit`,
 * `session.unbind`, the `unbound` push and a change), and is declined when the
 * socket takes neither. Hydration keeps the most recently bound records (the
 * higher `boundAt`, then the higher tab id — the rule a session named twice is
 * resolved by) and ends the rest through owed unbinds. The service is always
 * told, never left routing to a tab the worker no longer tracks.
 */
export const MAX_STORED_TAB_BINDINGS = 256;

/**
 * The most unbind tombstones the registry holds — in memory, under
 * {@link UNBIND_TOMBSTONE_STORAGE_KEY}, and on hydration: 256.
 *
 * **Why 256.** A tab holds at most one tombstone. An *undelivered* one holds a
 * slot, and at most {@link MAX_STORED_TAB_BINDINGS} tabs hold a slot, so a
 * limit equal to it (never below it) always has room for every unbind still
 * owed — an outage never retires one (see {@link UNBIND_TOMBSTONE_TTL_MS}) —
 * while bounding what a corrupted entry can make every flush re-send.
 *
 * **At the limit.** What goes first is a *delivered* tombstone, oldest first
 * (logged, counts only): its unbind has reached the service's socket, and only
 * the retransmission is given up. An undelivered tombstone is never evicted by
 * the registry's own writes; only state it did not write — stored data beyond
 * its limits, or a merge after an unreadable tombstone key — can force that,
 * and it is logged as an error. Hydration keeps undelivered tombstones before
 * delivered ones and, within each, the newest (the higher `createdAt`, then the
 * higher tab id), and rewrites storage without the rest.
 */
export const MAX_STORED_UNBIND_TOMBSTONES = 256;

/** The transport outcome that means the frame was written to an open socket. */
const OUTCOME_SENT = 'sent' satisfies SendOutcome;

/*
 * ===========================================================================
 * Section B — the injection surface
 * ===========================================================================
 */

/**
 * The part of a `chrome.storage` area the registry uses: promise-returning
 * `get`, `set` and `remove` of one key.
 *
 * `chrome.storage.session` satisfies it — {@link ChromeSessionStorageSatisfiesTabRegistryStorage}
 * proves that at compile time — so `service-worker.ts` passes the real area,
 * and a unit test passes a small fake over a plain object. The values are typed
 * `unknown` on the way out on purpose: whatever `get` returns is re-validated
 * before it is trusted.
 */
export interface TabRegistryStorageArea {
  /** Read one key; resolves to an object holding it when it is set. */
  get(keys: string): Promise<Record<string, unknown>>;
  /** Write every key of `items`. */
  set(items: Record<string, unknown>): Promise<void>;
  /** Delete one key. */
  remove(keys: string): Promise<void>;
}

/**
 * Fails to compile unless its argument is exactly `true` — the same private
 * helper `./messages` declares for its own drift assertion.
 */
type AssertTrue<Assertion extends true> = Assertion;

/**
 * Compile-time proof that the real `chrome.storage.session` area is assignable
 * to {@link TabRegistryStorageArea}: if `@types/chrome` ever changes `get`,
 * `set` or `remove` incompatibly, the argument becomes `false` and `tsc -b`
 * fails here (TS2344) rather than at the wiring in `service-worker.ts`.
 * Type-level only — it emits nothing, and it is exported solely so
 * `noUnusedLocals` accepts it.
 */
export type ChromeSessionStorageSatisfiesTabRegistryStorage = AssertTrue<
  typeof chrome.storage.session extends TabRegistryStorageArea ? true : false
>;

/** What {@link createTabRegistry} is built from. */
export interface TabRegistryDeps {
  /**
   * Where bindings and unbind tombstones persist, under
   * {@link BINDING_STORAGE_KEY} and {@link UNBIND_TOMBSTONE_STORAGE_KEY}:
   * `chrome.storage.session` in the worker, a fake in a test. See the module
   * overview for why it is the session area.
   */
  readonly storage: TabRegistryStorageArea;
  /**
   * Send one protocol frame to the service — `session.bind`, `tab.navigated`
   * and `session.unbind` are the three this module sends. The socket belongs to
   * `ws-bridge.ts`; this module never touches it.
   */
  readonly send: ProtocolSend;
  /**
   * Push one binding state to the panels of one tab. A tab with no panel is a
   * normal condition, so nothing is expected back.
   */
  readonly notify: PortPushSink;
  /** Where diagnostics go; defaults to `noopLogger`. */
  readonly logger?: Logger | undefined;
  /**
   * The epoch-millisecond clock stamping `boundAt` and a tombstone's
   * `createdAt`, and aging tombstones against {@link UNBIND_TOMBSTONE_TTL_MS};
   * defaults to `nowEpochMs`.
   */
  readonly now?: (() => EpochMs) | undefined;
}

/**
 * What {@link TabRegistry.requestBind} asks the service for — the fields of a
 * `session.bind` payload, with `sessionId` omitted (or `undefined`) meaning
 * "bind me to whichever session owns this origin".
 */
export interface TabBindRequest {
  /** The inspected tab, from `chrome.devtools.inspectedWindow.tabId`. */
  readonly tabId: TabId;
  /** The tab's current document URL, query-redacted by its producer. */
  readonly url: string;
  /** That URL's serialized origin. */
  readonly origin: string;
  /** The session asked for, when the panel asks for one in particular. */
  readonly sessionId?: SessionId | undefined;
}

/**
 * A committed navigation, as `service-worker.ts` observed it on
 * `chrome.tabs.onUpdated` — the `tab.navigated` payload's own shape.
 */
export type TabNavigation = TabNavigatedPayload;

/*
 * ===========================================================================
 * Section C — what the registry answers
 * ===========================================================================
 */

/**
 * One pending `session.unbind`, as it is stored under
 * {@link UNBIND_TOMBSTONE_STORAGE_KEY} — the write-ahead record of an unbind
 * the service has not acknowledged yet. See the module overview for its
 * lifecycle.
 *
 * Like a {@link TabBindingRecord}, what is read back is untrusted data from an
 * earlier worker generation: each entry is validated field by field and
 * rebuilt, and a malformed one is dropped.
 */
export interface TabUnbindTombstone {
  /** The tab whose binding ended — the whole wire payload of `session.unbind`. */
  readonly tabId: TabId;
  /**
   * The session the tab was bound to when the unbind was decided. Absent when
   * DevTools closed on a tab with no record here; an acknowledgement is then
   * matched on the tab alone.
   */
  readonly sessionId?: SessionId | undefined;
  /** Why the binding ended. Stored and logged, never sent. */
  readonly cause: UnbindTombstoneCause;
  /** When the unbind was decided, from the injected clock. */
  readonly createdAt: EpochMs;
  /**
   * How many delivery epochs handed the frame to an open socket (outcome
   * `sent`) — at most one count per epoch; retired at
   * {@link MAX_UNBIND_TOMBSTONE_DELIVERIES}. While it is `0`,
   * {@link UNBIND_TOMBSTONE_TTL_MS} does not apply.
   */
  readonly deliveries: number;
}

/**
 * The verdict on one committed navigation, returned by
 * {@link TabRegistry.handleNavigated} and
 * {@link TabRegistry.handleUnreportableNavigation} and consumed by
 * `agent-control.ts` (through `service-worker.ts`), which acts on it: this
 * module decides, it does not re-arm or disarm anything itself.
 *
 * Discriminated on `kind`, so a consumer's `switch` narrows exhaustively:
 *
 * - `kept-same-origin` — the tab stayed on its bound origin (a reload, or an
 *   in-app navigation). The binding is kept with its new `url`, and the page
 *   agent must be **re-armed** in the new document with the same
 *   configuration. `captureId` is the capture that was running, preserved so
 *   the same capture continues across the reload (AAP §0.5.5). Only
 *   `handleNavigated` answers it.
 * - `unbound-cross-origin` — the tab left its bound origin (or navigated to a
 *   document with no usable origin, such as `about:blank` or a `chrome://`
 *   page). An unbind tombstone was written, `session.unbind` was handed to the
 *   transport, the record was dropped, and the panel was told the tab left.
 *   The page agent must be returned to **dormant**, and `captureId` is the
 *   capture that was running when the tab left, if any. `notice` is the
 *   panel's sentence for this state, from `formatTabLeftMessage`, for a caller
 *   that surfaces it elsewhere (a status hint, an event-log entry). From
 *   `handleUnreportableNavigation`, `origin` is always `undefined` and
 *   `reported` always `false`: that URL never leaves the worker.
 * - `not-bound` — the tab holds no binding (or the tab id is invalid). From
 *   `handleNavigated` the navigation was reported and nothing else happened;
 *   from `handleUnreportableNavigation` nothing at all was sent. An unbound
 *   tab navigating is not an event.
 *
 * `reported` says whether a `tab.navigated` frame was handed to the transport
 * (sent, or queued while the socket reconnects). It says nothing about the
 * `session.unbind`, whose delivery the tombstone guarantees.
 */
export type NavigationDecision =
  | {
      readonly kind: 'kept-same-origin';
      readonly tabId: TabId;
      readonly sessionId: SessionId;
      readonly captureId: CaptureId | undefined;
      readonly url: string;
      readonly origin: string;
      readonly reported: boolean;
    }
  | {
      readonly kind: 'unbound-cross-origin';
      readonly tabId: TabId;
      readonly sessionId: SessionId;
      readonly captureId: CaptureId | undefined;
      /** The origin the tab left — the one its binding was for. */
      readonly previousOrigin: string;
      /** The new document's origin, or `undefined` when it has none (opaque or unparseable). */
      readonly origin: string | undefined;
      /** `formatTabLeftMessage(previousOrigin)`. */
      readonly notice: string;
      readonly reported: boolean;
    }
  | {
      readonly kind: 'not-bound';
      readonly tabId: TabId;
      readonly reported: boolean;
    };

/** One of the {@link NavigationDecision} kinds. */
export type NavigationDecisionKind = NavigationDecision['kind'];

/**
 * What one {@link TabRegistry.applyBound} did with the service's announcement.
 *
 * - `recorded` — a binding was established (or replaced the tab's binding to
 *   another session). `previous` is the tab's earlier record, if it had one;
 *   `displaced` lists the records of *other* tabs removed because the session
 *   may hold only one tab, each of whose panels was told. A binding ended to
 *   stay within {@link MAX_STORED_TAB_BINDINGS} is not listed there: it was
 *   unbound (`session.unbind` sent, tombstone written), and its removal reaches
 *   its panel and every listener as a change like any other unbind.
 * - `updated` — an existing binding of this tab to this session was refreshed:
 *   a re-announcement after a reconnect, or a kept same-origin navigation.
 * - `removed` — the announcement dropped this tab's binding (`replaced`,
 *   `origin-changed` or `unbound`); `removed` is the record that was dropped.
 * - `ignored` — the announcement was about a binding this worker does not hold
 *   (a late frame about an older binding, or a drop already applied). A late
 *   frame must never undo the current binding, so it changes nothing. Also the
 *   answer to a confirmation declined at the limit (see "Capacity" in the
 *   module overview): the tab is not recorded, though another tab the service
 *   moved the session away from is still removed and announced, since the
 *   service no longer holds it there.
 */
export type ApplyBoundOutcome =
  | {
      readonly kind: 'recorded';
      readonly record: TabBindingRecord;
      readonly previous: TabBindingRecord | undefined;
      readonly displaced: readonly TabBindingRecord[];
      readonly reason: BindingReason;
    }
  | {
      readonly kind: 'updated';
      readonly record: TabBindingRecord;
      readonly reason: BindingReason;
    }
  | {
      readonly kind: 'removed';
      readonly removed: TabBindingRecord;
      readonly reason: BindingReason;
    }
  | {
      readonly kind: 'ignored';
      readonly reason: BindingReason;
    };

/**
 * One change to one tab's binding, delivered to every {@link TabRegistry.onChange}
 * listener after the change was written through and pushed to the tab's panel.
 *
 * `service-worker.ts` uses it to refresh the `WorkerStatusSnapshot` it pushes to
 * panels. `state` is the {@link PanelBindingState} that was pushed; `reason` is
 * the protocol reason the change corresponds to (the service's own, when the
 * change came from `session.bound`); `cause` is set when the worker itself
 * unbound the tab for one of the {@link TAB_UNBIND_CAUSES}.
 */
export interface TabBindingChange {
  /** `recorded` (a new binding), `updated` (url or capture changed) or `removed`. */
  readonly kind: 'recorded' | 'updated' | 'removed';
  /** The tab whose binding changed. */
  readonly tabId: TabId;
  /** The record before the change, if there was one. */
  readonly previous: TabBindingRecord | undefined;
  /** The record after the change, if there is one. */
  readonly current: TabBindingRecord | undefined;
  /** What the tab's panel was told. */
  readonly state: PanelBindingState;
  /** The binding reason the change corresponds to. */
  readonly reason: BindingReason;
  /**
   * Why the worker unbound the tab, when it did so for one of the
   * {@link TAB_UNBIND_CAUSES}. `undefined` for a change the service announced,
   * and for the two unbinds the worker decides on its own: leaving the bound
   * origin (announced with reason `origin-changed`) and ending a binding to
   * stay within {@link MAX_STORED_TAB_BINDINGS} — the least recently bound one
   * at a confirmation, or a stored one hydration could not keep — announced
   * with reason `unbound`, which a consumer handles as it handles an unbind the
   * service announced.
   */
  readonly cause: TabUnbindCause | undefined;
}

/** A {@link TabRegistry.onChange} subscriber. */
export type TabBindingListener = (change: TabBindingChange) => void;

/**
 * The registry. Every member is a function-valued property rather than a
 * method, so `service-worker.ts` can hand one on as a plain callback
 * (`listBindings: registry.listBindings`) without binding it. Every
 * asynchronous member runs on the registry's single operation queue, in call
 * order, and none rejects for an expected condition.
 */
export interface TabRegistry {
  /**
   * Re-read the bindings from storage, replacing the binding cache, and
   * hydrate the unbind tombstones unless this generation already read them
   * successfully.
   *
   * Tombstones already hydrated are kept, not re-read: from then on the
   * in-memory list is the newer copy — every change since was written through
   * or is held dirty for the next write — so replacing it with storage could
   * only lose intents. `service-worker.ts` calls it on a cold start; every
   * other read path hydrates on its own when the cache is cold, so calling it
   * is never required for correctness. Malformed entries — any field outside
   * the protocol schema that defines it — are dropped, and the cleaned map or
   * list is written back. Valid bindings beyond {@link MAX_STORED_TAB_BINDINGS}
   * are ended through owed unbinds — each `session.unbind` sent at once, its
   * panel pushed `unbound` and the removal announced — and tombstones beyond
   * {@link MAX_STORED_UNBIND_TOMBSTONES} are dropped delivered ones first (see
   * "Capacity" in the module overview); a tab left holding both a record and a
   * tombstone is reconciled as the module overview describes.
   *
   * @returns Every valid binding, ordered by tab id.
   */
  readonly reload: () => Promise<readonly TabBindingRecord[]>;

  /**
   * Ask the service to bind a tab: send `session.bind`. Records nothing — the
   * binding exists once the service answers and {@link applyBound} records it.
   *
   * When the tab holds an unbind tombstone, its `session.unbind { tabId }` is
   * handed to the transport **first** (and counted as a delivery like any
   * other), so on the FIFO transport the service ends the stale binding before
   * it considers the bind. The tombstone is kept — only a bind the service
   * confirms supersedes it — and the tab is marked for this worker generation,
   * so later flushes of this generation skip that tombstone rather than send
   * an unbind that would follow, and end, the bind. When the transport refuses
   * the owed unbind, the bind is not sent (it would not be ordered behind the
   * unbind) and that refusal is answered; when it refuses the bind, nothing
   * is pending and the tab is not marked, so the next flush still sends the
   * unbind. The same mark is set when the tombstone key has not hydrated yet,
   * because the tab may hold a stored tombstone.
   *
   * A bind handed to the transport holds a slot for its tab until it is
   * confirmed or the tab is unbound, so its confirmation always has room. A
   * tab holding no slot is refused while all {@link MAX_STORED_TAB_BINDINGS}
   * are held — before anything is sent — rather than making room by forgetting
   * an obligation (see "Capacity" in the module overview).
   *
   * @returns The transport's outcome for the `session.bind`: `ok('sent')`, or
   * `ok('queued')` while the socket reconnects (a success, AAP §0.5.5); an
   * `err` when the request is not a valid `session.bind` payload
   * (`PROTOCOL_INVALID_MESSAGE`, nothing sent, no tombstone touched), when
   * every slot is held (`RATE_LIMITED`, nothing sent), or when the transport
   * refused the owed `session.unbind` or the `session.bind`.
   */
  readonly requestBind: (request: TabBindRequest) => Promise<Result<SendOutcome, DebuggenError>>;

  /**
   * Record the service's `session.bound` announcement — the authoritative
   * write. Enforces one tab per session and one session per tab, writes
   * through, pushes the new state to the affected tabs' panels and notifies
   * listeners.
   *
   * It is also the only place a tab's unbind tombstone is retired other than
   * by exhaustion or age: a recorded binding supersedes it (the service
   * accepted a bind, replacing whatever it held), and a drop (`unbound`,
   * `origin-changed`, `replaced`) acknowledges it when the tombstone names no
   * session or the announced one — even when this worker holds no record for
   * the tab, in which case the outcome is still `ignored`.
   *
   * A binding of a tab that holds no slot (see {@link requestBind}), recorded
   * while every slot is held, first makes room: owed unbinds are delivered,
   * then the least recently bound binding is ended exactly as {@link unbind}
   * would end it (cause `binding-limit` on its tombstone). When the socket
   * takes neither frame, no room can be made without forgetting an
   * obligation, so the confirmation is declined (`ignored`, logged) and the
   * DevTools page's rebind on the next connect records it.
   *
   * @returns What was done, or an `err` (`PROTOCOL_INVALID_MESSAGE`) when the
   * payload is not a valid `session.bound`, or names a document without an
   * HTTP(S) origin, in which case nothing changes.
   */
  readonly applyBound: (
    payload: SessionBoundPayload,
  ) => Promise<Result<ApplyBoundOutcome, DebuggenError>>;

  /**
   * Handle one committed navigation: always report `tab.navigated`, then keep
   * the binding (same origin) or drop it (different origin) under a
   * write-ahead unbind tombstone. See {@link NavigationDecision}.
   *
   * A navigation that is not a valid `tab.navigated` payload — a URL longer
   * than the protocol admits, or no absolute URL at all — has no form the
   * service accepts, so it is handled exactly as
   * {@link handleUnreportableNavigation} handles one: nothing is reported and
   * the URL is never recorded.
   */
  readonly handleNavigated: (navigation: TabNavigation) => Promise<NavigationDecision>;

  /**
   * Handle a committed navigation whose URL has no form the service accepts —
   * `chrome://`, `about:blank`, `file:`, an extension page — which
   * `service-worker.ts` therefore cannot report as `tab.navigated`. Such a
   * document is never on the bound origin, so for a bound tab this is the
   * cross-origin branch of {@link handleNavigated} without the report: write
   * the unbind tombstone, send `session.unbind { tabId }` (the tab id alone —
   * the URL is not even given to this module), drop the record, push the
   * "Tab left ‹origin›" state and notify.
   *
   * @returns `unbound-cross-origin` (with `origin: undefined` and
   * `reported: false`) for a bound tab, for the caller to hand to
   * `agent-control.ts` so the page agent is returned to dormant; `not-bound`
   * (`reported: false`, nothing sent) for a tab with no record or an invalid
   * tab id.
   */
  readonly handleUnreportableNavigation: (tabId: TabId) => Promise<NavigationDecision>;

  /**
   * Handle a committed navigation of a tab this registry holds no binding
   * for, whose new document's HTTP(S) origin is `origin` (`undefined` when it
   * has none). A tab showing "Tab left ‹origin›" that has come back to the
   * very origin it left is no longer away: its `tab-left` state is forgotten
   * and its panels are pushed `unbound`, so the notice never outlives the
   * departure it describes. Whether the tab binds again is the service's
   * answer to the worker's next `session.bind`, which records the binding
   * through {@link applyBound}. Nothing is sent and no listener is notified —
   * no binding changed.
   *
   * @returns `true` when a `tab-left` state was withdrawn; `false` for a bound
   * tab, a tab that is not away, or one still away from the origin it left.
   */
  readonly handleReturnedNavigation: (tabId: TabId, origin: string | undefined) => Promise<boolean>;

  /**
   * End a tab's binding because DevTools closed, the tab closed or the session
   * ended: write the unbind tombstone, send `session.unbind`, drop the record,
   * write through, push the `unbound` state and notify.
   *
   * `session.unbind` is sent whenever the tab held a record, and additionally
   * without one for `'devtools-closed'` (see the module notes on that cause,
   * whose tombstone names no session) and for a tab with a `session.bind`
   * still pending over its tombstone (see {@link requestBind}): that bind may
   * yet be applied, and the unbind, sent after it, ends it. Its tombstone
   * then names no session. For a tab this worker knows nothing about, closing
   * it sends and stores nothing. A `'devtools-closed'` unbind of a tab holding
   * no slot — no record, no bind in flight, no undelivered tombstone — while
   * every slot is held is sent without a tombstone (see "Capacity" in the
   * module overview). An unbind that is reported ends the tab's bind in
   * flight, whose slot its tombstone takes over.
   *
   * @returns The record that was removed, or `undefined` when there was none.
   */
  readonly unbind: (tabId: TabId, cause: TabUnbindCause) => Promise<TabBindingRecord | undefined>;

  /**
   * Re-send every pending unbind tombstone and open a new delivery epoch:
   * hydrate, retire the *delivered* tombstones (`deliveries >= 1`) older than
   * {@link UNBIND_TOMBSTONE_TTL_MS}, then hand `session.unbind { tabId }` to
   * the transport for each remaining one, oldest first — except a tombstone a
   * `session.bind` of this worker generation is pending over (see
   * {@link requestBind}), which is skipped. A `sent` outcome counts one
   * delivery for the epoch and retires the tombstone at
   * {@link MAX_UNBIND_TOMBSTONE_DELIVERIES}; `queued` and a refused frame
   * leave it as it was. The list is written through once when it changed —
   * after the retry every queued operation starts with, of a tombstone read
   * or write still owed — and the counts — never a URL — are logged.
   *
   * `service-worker.ts` calls it once on every transition of the socket to
   * connected, which is what makes an epoch one connection; called while the
   * socket is not open it is harmless (frames queue or are refused, and
   * nothing is counted). Never rejects.
   *
   * @returns How many frames were handed to the transport (`sent` or `queued`).
   */
  readonly flushPendingUnbinds: () => Promise<number>;

  /**
   * Unbind whichever tab holds a session that has ended.
   *
   * @returns The record that was removed, or `undefined` when no tab held it.
   */
  readonly handleSessionEnded: (sessionId: SessionId) => Promise<TabBindingRecord | undefined>;

  /**
   * React to a relayed `session.updated`: when the record's status is the
   * ended status, unbind the tab that held the session. Any other status is
   * the service's state machine at work and changes nothing here.
   *
   * @returns The record that was removed, if any.
   */
  readonly handleSessionUpdated: (
    payload: SessionUpdatedPayload,
  ) => Promise<TabBindingRecord | undefined>;

  /**
   * Remember the capture running on a bound tab, so a mid-capture reload
   * continues the same capture.
   *
   * @returns `true` when the tab is bound and the id was stored; `false` when
   * the tab is not bound or the id is not a capture id the protocol admits
   * (empty, or longer than the `capture.started` schema allows) — a value
   * hydration would refuse is never held.
   */
  readonly setCaptureId: (tabId: TabId, captureId: CaptureId) => Promise<boolean>;

  /**
   * Forget the capture on a bound tab. When `captureId` is given, only that
   * capture is cleared — a late `capture.stopped` for an earlier capture must
   * not clear a newer one.
   *
   * @returns `true` when a stored capture id was cleared.
   */
  readonly clearCaptureId: (tabId: TabId, captureId?: CaptureId) => Promise<boolean>;

  /**
   * Apply a relayed `capture.started`: store its `captureId` on the tab bound
   * to its session.
   *
   * @returns The tab that was updated, or `undefined` when no tab holds the session.
   */
  readonly handleCaptureStarted: (payload: CaptureStartedPayload) => Promise<TabId | undefined>;

  /**
   * Apply a relayed `capture.stopped`: clear that capture from the tab bound to
   * its session, if it is still the stored one.
   *
   * @returns The tab that was updated, or `undefined` when nothing was cleared.
   */
  readonly handleCaptureStopped: (payload: CaptureStoppedPayload) => Promise<TabId | undefined>;

  /** The binding of one tab, or `undefined`. Hydrates when the cache is cold. */
  readonly getBinding: (tabId: TabId) => Promise<TabBindingRecord | undefined>;

  /** The tab bound to one session, or `undefined`. Hydrates when the cache is cold. */
  readonly getTabForSession: (sessionId: SessionId) => Promise<TabId | undefined>;

  /** Every binding, ordered by tab id. Hydrates when the cache is cold. */
  readonly listBindings: () => Promise<readonly TabBindingRecord[]>;

  /**
   * The {@link PanelBindingState} a panel inspecting this tab should render:
   * `bound` for a recorded binding, `tab-left` after the tab navigated off its
   * bound origin (until it binds again, is unbound or closes), and `unbound`
   * otherwise. What `session.snapshot` answers a freshly opened panel with.
   *
   * The `tab-left` memory is held in the worker's memory only; after an
   * eviction a reopened panel sees `unbound`, which is also true.
   */
  readonly getPanelBindingState: (tabId: TabId) => Promise<PanelBindingState>;

  /**
   * Subscribe to binding changes.
   *
   * @returns A function that removes the subscription; calling it twice is
   * harmless.
   */
  readonly onChange: (listener: TabBindingListener) => () => void;
}

/*
 * ===========================================================================
 * Section D — pure helpers
 *
 * Total functions: each returns a value for every input and none throws. The
 * guards narrow through `typeof`, plain property reads and the protocol's own
 * schemas (whose `safeParse` and `parse…` helpers answer rather than throw),
 * so nothing read back from storage is ever cast into a record.
 * ===========================================================================
 */

/** A plain object — not `null`, not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string with at least one character. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * A Chrome tab id: a non-negative safe integer. `-1` is
 * `chrome.tabs.TAB_ID_NONE`, never a tab — the protocol's rule too.
 */
function isTabId(value: unknown): value is TabId {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A plausible epoch-millisecond stamp: a finite, non-negative number. */
function isEpochMs(value: unknown): value is EpochMs {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * A session id the protocol admits — non-empty and at most 64 characters —
 * checked with the `session.bound` payload's own field validator, the schema
 * that confirmed every binding this module records, rather than with a limit
 * restated here.
 */
function isSessionId(value: unknown): value is SessionId {
  return sessionBoundPayloadSchema.shape.sessionId.safeParse(value).success;
}

/**
 * A capture id the protocol admits — non-empty and at most 64 characters —
 * checked with the field validator of the `capture.started` payload that
 * announces every capture this module stores.
 */
function isCaptureId(value: unknown): value is CaptureId {
  return captureStartedPayloadSchema.shape.captureId.safeParse(value).success;
}

/**
 * The serialized origin of an HTTP or HTTPS URL, or `undefined` when the URL
 * does not parse or has no such origin (`about:blank`, `chrome://…`, an
 * extension page, `file://…`).
 *
 * Origins are always compared through this — the platform `URL` parser's own
 * serialization — and never by a string prefix, which would equate
 * `http://127.0.0.1:3000` with `http://127.0.0.1:30001`.
 */
function httpOriginOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

/** Every field of a {@link TabBindingRecord}, with `captureId` spelled out. */
interface TabBindingFields {
  readonly tabId: TabId;
  readonly sessionId: SessionId;
  readonly url: string;
  readonly origin: string;
  readonly boundAt: EpochMs;
  readonly captureId: CaptureId | undefined;
}

/**
 * Build a frozen record. `captureId` is omitted rather than stored as
 * `undefined`, so the JSON written to storage has no empty keys.
 */
function makeRecord(fields: TabBindingFields): TabBindingRecord {
  const base = {
    tabId: fields.tabId,
    sessionId: fields.sessionId,
    url: fields.url,
    origin: fields.origin,
    boundAt: fields.boundAt,
  };
  return Object.freeze(
    fields.captureId === undefined ? base : { ...base, captureId: fields.captureId },
  );
}

/** A record's fields, for building an amended copy of it. */
function fieldsOf(record: TabBindingRecord): TabBindingFields {
  return {
    tabId: record.tabId,
    sessionId: record.sessionId,
    url: record.url,
    origin: record.origin,
    boundAt: record.boundAt,
    captureId: record.captureId,
  };
}

/** Records ordered by tab id, as a frozen array — the order every list is in. */
function sortRecords(records: Iterable<TabBindingRecord>): readonly TabBindingRecord[] {
  return Object.freeze([...records].sort((left, right) => left.tabId - right.tabId));
}

/**
 * Order two records by how recently they were bound, least recent first: the
 * earlier `boundAt`, then the lower tab id, so equal stamps still order
 * deterministically. The one recency rule this module applies — to a session
 * named twice in storage, to the records hydration keeps within
 * {@link MAX_STORED_TAB_BINDINGS}, and to the record a bind at that limit
 * ends.
 */
function compareBindingRecency(left: TabBindingRecord, right: TabBindingRecord): number {
  return left.boundAt - right.boundAt || left.tabId - right.tabId;
}

/**
 * The least recently bound of `records` under {@link compareBindingRecency},
 * or `undefined` when there is none.
 */
function leastRecentlyBound(records: Iterable<TabBindingRecord>): TabBindingRecord | undefined {
  let oldest: TabBindingRecord | undefined;
  for (const record of records) {
    if (oldest === undefined || compareBindingRecency(record, oldest) < 0) {
      oldest = record;
    }
  }
  return oldest;
}

/**
 * The `limit` last of `entries` under `compare` — which orders the first to be
 * left out first — and the ones left out, in that order. `entries` itself is
 * answered, with nothing left out, when it is within the limit.
 */
function keepWithin<T>(
  entries: readonly T[],
  compare: (left: T, right: T) => number,
  limit: number,
): { readonly kept: readonly T[]; readonly excess: readonly T[] } {
  if (entries.length <= limit) {
    return { kept: entries, excess: [] };
  }
  const ordered = [...entries].sort(compare);
  const cut = entries.length - limit;
  return { kept: ordered.slice(cut), excess: ordered.slice(0, cut) };
}

/**
 * Validate one stored entry and rebuild it as a fresh record, or answer
 * `undefined` for anything malformed.
 *
 * An entry is valid when its session id, tab id and URL form a valid
 * `session.bound` payload — the schema of the announcement that confirmed the
 * binding, so the session id is non-empty and at most 64 characters, the tab
 * id a real tab and the URL absolute and at most 2,048 characters — its key is
 * that tab id rendered in decimal, its origin is exactly the URL's HTTP(S)
 * origin, its `boundAt` is a plausible stamp, and its `captureId` is absent or
 * a capture id the `capture.started` schema admits. Unknown keys on the stored
 * object are not carried over — the record is rebuilt from the validated
 * fields alone.
 */
function readStoredRecord(key: string, value: unknown): TabBindingRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { tabId, sessionId, url, origin, boundAt, captureId } = value;
  const confirmed = parseSessionBoundPayload({ sessionId, tabId, url });
  if (!confirmed.ok || String(confirmed.value.tabId) !== key || !isEpochMs(boundAt)) {
    return undefined;
  }
  const derivedOrigin = httpOriginOf(confirmed.value.url);
  if (derivedOrigin === undefined || origin !== derivedOrigin) {
    return undefined;
  }
  if (captureId !== undefined && !isCaptureId(captureId)) {
    return undefined;
  }
  return makeRecord({
    tabId: confirmed.value.tabId,
    sessionId: confirmed.value.sessionId,
    url: confirmed.value.url,
    origin: derivedOrigin,
    boundAt,
    captureId,
  });
}

/** The outcome of reading a stored snapshot back. */
interface ParsedSnapshot {
  /** Every record kept, one per tab and one per session, ordered by tab id. */
  readonly records: readonly TabBindingRecord[];
  /**
   * How many stored entries were refused — malformed, a session's older
   * duplicate, or beyond {@link MAX_STORED_TAB_BINDINGS} — or `1` when the
   * whole value was malformed.
   */
  readonly dropped: number;
  /**
   * The valid records beyond {@link MAX_STORED_TAB_BINDINGS} (counted in
   * `dropped`), least recently bound first: bindings the service confirmed
   * once and may still hold, which the caller ends through owed unbinds.
   */
  readonly pruned: readonly TabBindingRecord[];
}

/**
 * Read a stored {@link TabBindingSnapshot} back into validated records.
 *
 * Absent storage is an empty registry. A value that is not an object is
 * dropped whole. Each entry is validated by {@link readStoredRecord}; when two
 * valid entries name the same session — which the registry never writes, so it
 * can only be corruption — the one bound most recently is kept (ties broken by
 * the higher tab id, so the answer is deterministic) and the other dropped,
 * restoring the one-tab-per-session invariant. Of what remains, only the
 * {@link MAX_STORED_TAB_BINDINGS} most recently bound are kept, by the same
 * rule; the rest are counted in `dropped` and answered in `pruned`, so the
 * caller rewrites storage without them and ends each through an owed unbind.
 * A session's older duplicate is not in `pruned`: the service holds that
 * session on one tab only, so it names no binding the service can still hold.
 */
function parseSnapshot(raw: unknown): ParsedSnapshot {
  if (raw === undefined) {
    return { records: Object.freeze([]), dropped: 0, pruned: Object.freeze([]) };
  }
  if (!isRecord(raw)) {
    return { records: Object.freeze([]), dropped: 1, pruned: Object.freeze([]) };
  }
  const bySession = new Map<SessionId, TabBindingRecord>();
  let dropped = 0;
  for (const [key, value] of Object.entries(raw)) {
    const record = readStoredRecord(key, value);
    if (record === undefined) {
      dropped += 1;
      continue;
    }
    const rival = bySession.get(record.sessionId);
    if (rival === undefined) {
      bySession.set(record.sessionId, record);
      continue;
    }
    dropped += 1;
    if (compareBindingRecency(record, rival) > 0) {
      bySession.set(record.sessionId, record);
    }
  }
  const { kept, excess } = keepWithin(
    [...bySession.values()],
    compareBindingRecency,
    MAX_STORED_TAB_BINDINGS,
  );
  return {
    records: sortRecords(kept),
    dropped: dropped + excess.length,
    pruned: Object.freeze([...excess]),
  };
}

/** The JSON map form of a set of records, keyed by decimal tab id. */
function toSnapshot(records: Iterable<TabBindingRecord>): TabBindingSnapshot {
  const snapshot: Record<string, TabBindingRecord> = {};
  for (const record of sortRecords(records)) {
    snapshot[String(record.tabId)] = record;
  }
  return snapshot;
}

/** A delivery count: a non-negative safe integer. */
function isDeliveryCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A member of {@link UNBIND_TOMBSTONE_CAUSES}, checked without a cast. */
function isUnbindTombstoneCause(value: unknown): value is UnbindTombstoneCause {
  return UNBIND_TOMBSTONE_CAUSES.some((cause) => cause === value);
}

/** Every field of a {@link TabUnbindTombstone}, with `sessionId` spelled out. */
interface TombstoneFields {
  readonly tabId: TabId;
  readonly sessionId: SessionId | undefined;
  readonly cause: UnbindTombstoneCause;
  readonly createdAt: EpochMs;
  readonly deliveries: number;
}

/**
 * Build a frozen tombstone. `sessionId` is omitted rather than stored as
 * `undefined`, so the JSON written to storage has no empty keys.
 */
function makeTombstone(fields: TombstoneFields): TabUnbindTombstone {
  const { tabId, sessionId, cause, createdAt, deliveries } = fields;
  return Object.freeze(
    sessionId === undefined
      ? { tabId, cause, createdAt, deliveries }
      : { tabId, sessionId, cause, createdAt, deliveries },
  );
}

/** A tombstone's fields, for building an amended copy of it. */
function tombstoneFieldsOf(tombstone: TabUnbindTombstone): TombstoneFields {
  return {
    tabId: tombstone.tabId,
    sessionId: tombstone.sessionId,
    cause: tombstone.cause,
    createdAt: tombstone.createdAt,
    deliveries: tombstone.deliveries,
  };
}

/**
 * Order two tombstones oldest first: the earlier `createdAt`, then the lower
 * tab id. The order they are stored and flushed in, so unbinds reach the
 * service in the order they were decided.
 */
function compareTombstoneAge(left: TabUnbindTombstone, right: TabUnbindTombstone): number {
  return left.createdAt - right.createdAt || left.tabId - right.tabId;
}

/**
 * Whether a tombstone's unbind has never been handed to an open socket
 * (`deliveries: 0`) — an unbind still owed, which holds its tab's slot (see
 * "Capacity" in the module overview).
 */
function isUndelivered(tombstone: TabUnbindTombstone): boolean {
  return tombstone.deliveries === 0;
}

/**
 * Order two tombstones by which to give up first when the list would outgrow
 * {@link MAX_STORED_UNBIND_TOMBSTONES}: every delivered tombstone before any
 * undelivered one — a delivered unbind has reached the service's socket and
 * gives up only its retransmission, an undelivered one is still owed — and,
 * within each, the oldest first ({@link compareTombstoneAge}).
 */
function compareTombstoneRetention(left: TabUnbindTombstone, right: TabUnbindTombstone): number {
  return (
    Number(isUndelivered(left)) - Number(isUndelivered(right)) || compareTombstoneAge(left, right)
  );
}

/** Tombstones in {@link compareTombstoneAge} order, as a frozen array. */
function sortTombstones(tombstones: Iterable<TabUnbindTombstone>): readonly TabUnbindTombstone[] {
  return Object.freeze([...tombstones].sort(compareTombstoneAge));
}

/**
 * Validate one stored tombstone and rebuild it, or answer `undefined` for
 * anything malformed: the tab id must form a valid `session.unbind` payload —
 * the frame the tombstone re-sends — the session id be absent or a session id
 * the protocol admits (the rule a binding's is held to), the cause a member of
 * {@link UNBIND_TOMBSTONE_CAUSES}, `createdAt` a plausible stamp and
 * `deliveries` a non-negative integer. Unknown keys are not carried over.
 */
function readStoredTombstone(value: unknown): TabUnbindTombstone | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { tabId, sessionId, cause, createdAt, deliveries } = value;
  const unbind = parseSessionUnbindPayload({ tabId });
  if (!unbind.ok || !isUnbindTombstoneCause(cause)) {
    return undefined;
  }
  if (!isEpochMs(createdAt) || !isDeliveryCount(deliveries)) {
    return undefined;
  }
  if (sessionId !== undefined && !isSessionId(sessionId)) {
    return undefined;
  }
  return makeTombstone({ tabId: unbind.value.tabId, sessionId, cause, createdAt, deliveries });
}

/** The outcome of reading the stored tombstone list back. */
interface ParsedTombstones {
  /** Every tombstone kept, one per tab, oldest first. */
  readonly tombstones: readonly TabUnbindTombstone[];
  /**
   * How many stored entries were refused — malformed, a tab's older duplicate,
   * or beyond {@link MAX_STORED_UNBIND_TOMBSTONES} — or `1` when the whole
   * value was malformed.
   */
  readonly dropped: number;
  /** How many of `dropped` were valid but beyond {@link MAX_STORED_UNBIND_TOMBSTONES}. */
  readonly overLimit: number;
  /**
   * How many of `overLimit` were undelivered — owed unbinds, which only stored
   * data the registry did not write can bring beyond the limit.
   */
  readonly owedOverLimit: number;
}

/**
 * Read the stored tombstone list back into validated tombstones.
 *
 * Absent storage is no pending unbind. A value that is not an array is
 * dropped whole. Each entry is validated by {@link readStoredTombstone}; when
 * two valid entries name the same tab — which the registry never writes — the
 * later decision (the higher `createdAt`, the first entry on a tie) is kept
 * and the other dropped, restoring one tombstone per tab. Of what remains,
 * only {@link MAX_STORED_UNBIND_TOMBSTONES} are kept under
 * {@link compareTombstoneRetention} — undelivered ones before delivered ones,
 * and the newest within each — and the rest are counted in `dropped` (and
 * `overLimit`, with `owedOverLimit` of them undelivered), so the caller
 * rewrites storage without them.
 */
function parseTombstones(raw: unknown): ParsedTombstones {
  if (raw === undefined) {
    return { tombstones: Object.freeze([]), dropped: 0, overLimit: 0, owedOverLimit: 0 };
  }
  if (!Array.isArray(raw)) {
    return { tombstones: Object.freeze([]), dropped: 1, overLimit: 0, owedOverLimit: 0 };
  }
  const entries: readonly unknown[] = raw;
  const byTab = new Map<TabId, TabUnbindTombstone>();
  let dropped = 0;
  for (const entry of entries) {
    const tombstone = readStoredTombstone(entry);
    if (tombstone === undefined) {
      dropped += 1;
      continue;
    }
    const rival = byTab.get(tombstone.tabId);
    if (rival === undefined) {
      byTab.set(tombstone.tabId, tombstone);
      continue;
    }
    dropped += 1;
    if (tombstone.createdAt > rival.createdAt) {
      byTab.set(tombstone.tabId, tombstone);
    }
  }
  const { kept, excess } = keepWithin(
    [...byTab.values()],
    compareTombstoneRetention,
    MAX_STORED_UNBIND_TOMBSTONES,
  );
  return {
    tombstones: sortTombstones(kept),
    dropped: dropped + excess.length,
    overLimit: excess.length,
    owedOverLimit: excess.filter(isUndelivered).length,
  };
}

/** The panel state for a recorded binding. */
function boundState(record: TabBindingRecord): PanelBindingState {
  return Object.freeze({
    kind: 'bound',
    sessionId: record.sessionId,
    tabId: record.tabId,
    url: record.url,
  });
}

/** The panel state for a tab no session holds. */
const UNBOUND_STATE: PanelBindingState = Object.freeze({ kind: 'unbound' });

/**
 * The panel state for a tab that left its bound origin. `origin` is the origin
 * it **left**; the panel renders `formatTabLeftMessage(origin)` from it.
 */
function tabLeftState(
  origin: string,
  sessionId: SessionId,
  reason: BindingReason,
): PanelBindingState {
  return Object.freeze({ kind: 'tab-left', origin, sessionId, reason });
}

/** A `binding` push frame carrying one state, on the extension channel. */
function bindingPush(state: PanelBindingState): PortBindingPush {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'push',
    kind: 'binding',
    state,
  };
}
/*
 * ===========================================================================
 * Section E — the registry
 * ===========================================================================
 */

/**
 * Build a tab registry over the given storage area, transport and panel sink.
 *
 * Construction performs no I/O: the cache hydrates from storage on the first
 * operation (or on an explicit {@link TabRegistry.reload}), so building the
 * registry synchronously at the top of `service-worker.ts` costs nothing.
 *
 * @example
 * ```ts
 * const registry = createTabRegistry({
 *   storage: chrome.storage.session,
 *   send: (type, payload) => wsBridge.send(type, payload),
 *   notify: hub.pushToPanels,
 *   logger,
 * });
 * const decision = await registry.handleNavigated({ tabId, url });
 * agent.handleNavigationDecision(decision);
 * // A committed navigation to a URL with no form the service accepts:
 * agent.handleNavigationDecision(await registry.handleUnreportableNavigation(tabId));
 * // On every transition of the socket to open:
 * const resent = await registry.flushPendingUnbinds();
 * ```
 */
export function createTabRegistry(deps: TabRegistryDeps): TabRegistry {
  const { storage, send, notify } = deps;
  const logger = (deps.logger ?? noopLogger).child({ component: 'tab-registry' });
  const now = deps.now ?? nowEpochMs;

  /** The cache of the stored bindings, keyed by tab id. */
  const cache = new Map<TabId, TabBindingRecord>();
  /**
   * Whether the binding key was read in this worker generation. A read that
   * failed counts as read: the binding cache is never re-read after it (see
   * `hydrate`).
   */
  let bindingsHydrated = false;
  /** The cache of the pending unbind tombstones, keyed by tab id. */
  const tombstones = new Map<TabId, TabUnbindTombstone>();
  /**
   * Where the tombstone cache stands against storage in this generation:
   * `cold` before the first read, `failed` after a read that rejected (retried
   * at the start of every later operation), `hydrated` once a read succeeded
   * and was merged. Only when `hydrated` is the tombstone key ever written.
   */
  let tombstoneHydration: 'cold' | 'failed' | 'hydrated' = 'cold';
  /**
   * Whether `tombstones` holds changes storage does not: a write that failed,
   * or one withheld while the key is not hydrated. Written at the start of
   * every later queued operation (a flush included) until a write succeeds.
   */
  let tombstonesDirty = false;
  /**
   * Tabs whose tombstone this generation decided while the tombstone key was
   * not hydrated: it wrote a tombstone for the tab (whether still pending or
   * since retired), or recorded a new binding of it the service confirmed.
   * Either decision is newer than anything stored, so the merge ignores a
   * stored tombstone for such a tab. Emptied by the merge.
   */
  const decidedBeforeHydration = new Set<TabId>();
  /**
   * Tabs with a `session.bind` handed to the transport in this generation
   * that no `session.bound` has settled yet, over a tombstone the tab holds (or
   * may hold, while the tombstone key is not hydrated). A flush skips their
   * tombstones: its `session.unbind { tabId }` would follow the bind on the
   * FIFO transport and end it. Cleared when the tab's tombstone is retired or
   * replaced, or a binding of the tab is recorded; memory only, so an eviction
   * ends every mark and the next generation's flush re-sends the unbind.
   */
  const pendingBindTabs = new Set<TabId>();
  /**
   * Tabs with a bind in flight: a `session.bind` of the tab was handed to the
   * transport in this generation (outcome `sent` or `queued`), and no
   * confirmation has recorded it and no unbind of the tab has ended it since.
   * Each holds its tab's slot, so the confirmation always has room (see
   * "Capacity" in the module overview). A superset of the tabs in
   * `pendingBindTabs`; memory only, like the socket that would answer it.
   */
  const reservedBindTabs = new Set<TabId>();
  /**
   * Tabs whose tombstone has had a delivery counted in the current delivery
   * epoch — since the latest flush, which `service-worker.ts` runs once per
   * connection — so re-sends within one connection count once.
   */
  const countedThisEpoch = new Set<TabId>();
  /**
   * The `tab-left` state of tabs that navigated off their bound origin, kept
   * so a panel reopened on such a tab is told the tab left rather than merely
   * that it is unbound. Memory only (see `getPanelBindingState`).
   */
  const departures = new Map<TabId, PanelBindingState>();
  /** Change subscribers. */
  const listeners = new Set<TabBindingListener>();
  /** The tail of the operation queue; always settles, never rejects. */
  let tail: Promise<void> = Promise.resolve();

  /**
   * Run one operation after every operation queued before it, first retrying
   * the tombstone storage I/O an earlier operation left owed.
   *
   * This is the serialization every read-modify-write depends on: a
   * navigation handled while a `session.bound` is being written waits for the
   * write, so neither can overwrite the other with a stale map. The chain
   * itself swallows an operation's failure (its own caller observes it), so
   * one faulty operation cannot stall every later one. The retry is total —
   * each storage step answers rather than throws — and a defect in it is
   * logged, never allowed to fail the operation it precedes.
   */
  function exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const run = tail.then(async () => {
      try {
        await retryOwedTombstoneIo();
      } catch (cause) {
        logger.error('Owed unbind tombstone storage I/O could not be retried', {
          code: DebuggenError.from(cause, 'INTERNAL').code,
        });
      }
      return operation();
    });
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Read one key of the storage area. A read that rejects is answered as an
   * `err` (`STORE_ERROR`), so hydration decides per key what a failure means.
   */
  async function readStorageKey(key: string): Promise<Result<unknown, DebuggenError>> {
    try {
      const items: unknown = await storage.get(key);
      return ok(isRecord(items) ? items[key] : undefined);
    } catch (cause) {
      return err(DebuggenError.from(cause, 'STORE_ERROR'));
    }
  }

  /**
   * Load a read of the binding key into the binding cache, replacing it, and
   * mark the key read for this generation.
   *
   * A read that failed leaves the cache empty for this generation (logged)
   * and is never retried: the bindings then rebuild from what the service
   * confirms next, starting with the panel's next `session.bind`. Unlike the
   * tombstone key, a late read could not be merged safely: an unbind of a tab
   * the cache does not hold sends nothing, so the stored record of a tab that
   * closed or was unbound in the meantime would come back as live and route
   * its session's traffic to it, and a stored record could contradict a
   * binding the service confirmed in between.
   *
   * @returns `rewrite` — whether entries were dropped (malformed, or beyond
   * {@link MAX_STORED_TAB_BINDINGS}), so the cleaned map must be written back —
   * and `pruned`, the valid bindings beyond the limit, least recently bound
   * first, for {@link endPrunedBindings} to end once the tombstones are merged.
   */
  function loadBindings(stored: Result<unknown, DebuggenError>): {
    readonly rewrite: boolean;
    readonly pruned: readonly TabBindingRecord[];
  } {
    cache.clear();
    bindingsHydrated = true;
    if (!stored.ok) {
      logger.error('Tab bindings could not be read from session storage; starting empty', {
        code: stored.error.code,
      });
      return { rewrite: false, pruned: [] };
    }
    const parsed = parseSnapshot(stored.value);
    for (const record of parsed.records) {
      cache.set(record.tabId, record);
    }
    if (parsed.dropped === 0) {
      return { rewrite: false, pruned: [] };
    }
    logger.warn('Dropped malformed or excess tab bindings read back from session storage', {
      dropped: parsed.dropped,
      overLimit: parsed.pruned.length,
      kept: parsed.records.length,
      limit: MAX_STORED_TAB_BINDINGS,
    });
    return { rewrite: true, pruned: parsed.pruned };
  }

  /**
   * Merge a read of the tombstone key into the tombstone cache.
   *
   * A read that failed leaves the key `failed` (logged): nothing is written to
   * it, and the read is retried at the start of the next operation. A read
   * that succeeded is merged *under* what this generation decided — a tab
   * holding an in-memory tombstone, or listed in `decidedBeforeHydration`,
   * keeps that newer decision — and the key becomes `hydrated`. The list is
   * marked dirty when the stored copy must be rewritten: malformed or excess
   * entries were dropped, this generation's decisions override stored ones,
   * or the merged list outgrew {@link MAX_STORED_UNBIND_TOMBSTONES} and was
   * trimmed, delivered tombstones first ({@link enforceTombstoneLimit}). A
   * pending-bind mark on a tab the merge left without a tombstone is dropped,
   * since there is nothing for it to hold back; its bind is still in flight.
   * Stored undelivered tombstones beyond the limit — which only data the
   * registry did not write can hold — are logged as an error.
   */
  function mergeTombstones(stored: Result<unknown, DebuggenError>): void {
    if (!stored.ok) {
      tombstoneHydration = 'failed';
      logger.error(
        'Unbind tombstones could not be read from session storage; the read is retried on the next operation',
        { code: stored.error.code, inMemory: tombstones.size },
      );
      return;
    }
    const recovered = tombstoneHydration === 'failed';
    const parsed = parseTombstones(stored.value);
    let merged = 0;
    let overridden = 0;
    for (const tombstone of parsed.tombstones) {
      if (tombstones.has(tombstone.tabId) || decidedBeforeHydration.has(tombstone.tabId)) {
        overridden += 1;
        continue;
      }
      tombstones.set(tombstone.tabId, tombstone);
      merged += 1;
    }
    tombstoneHydration = 'hydrated';
    decidedBeforeHydration.clear();
    // This generation's tombstones and the stored ones are each within the
    // limit, but together they need not be.
    enforceTombstoneLimit();
    for (const tabId of [...pendingBindTabs]) {
      if (!tombstones.has(tabId)) {
        pendingBindTabs.delete(tabId);
      }
    }
    if (parsed.dropped > 0) {
      logger.warn('Dropped malformed or excess unbind tombstones read back from session storage', {
        dropped: parsed.dropped,
        overLimit: parsed.overLimit,
        kept: parsed.tombstones.length,
        limit: MAX_STORED_UNBIND_TOMBSTONES,
      });
    }
    if (parsed.owedOverLimit > 0) {
      logger.error(
        'Dropped undelivered unbind tombstones read back from session storage: it held more owed unbinds than the registry writes',
        { owed: parsed.owedOverLimit, limit: MAX_STORED_UNBIND_TOMBSTONES },
      );
    }
    if (parsed.dropped > 0 || overridden > 0) {
      tombstonesDirty = true;
    }
    if (recovered) {
      logger.info('Unbind tombstones read back after an earlier failed read; merged', {
        merged,
        overridden,
        pending: tombstones.size,
      });
    }
  }

  /** A record reconciliation ended, with the tombstone that ended it. */
  interface EndedByTombstone {
    readonly record: TabBindingRecord;
    readonly tombstone: TabUnbindTombstone;
  }

  /**
   * Resolve every tab holding both a record and a tombstone — possible only
   * when a worker died between writing the tombstone and dropping the record —
   * keeping whichever decision came last: a tombstone created at or after the
   * record's `boundAt` ends the record, an older one is stale and is dropped
   * (marking the list dirty). In memory only; the caller writes the bindings
   * through.
   *
   * @returns The records it ended, for the caller to announce when they had
   * already been in use.
   */
  function reconcile(): readonly EndedByTombstone[] {
    const ended: EndedByTombstone[] = [];
    let staleTombstones = 0;
    for (const tombstone of sortTombstones(tombstones.values())) {
      const record = cache.get(tombstone.tabId);
      if (record === undefined) {
        continue;
      }
      if (tombstone.createdAt >= record.boundAt) {
        cache.delete(record.tabId);
        ended.push({ record, tombstone });
      } else {
        forgetTombstone(tombstone.tabId);
        tombstonesDirty = true;
        staleTombstones += 1;
      }
    }
    if (ended.length + staleTombstones > 0) {
      logger.warn('Reconciled tabs holding both a binding and an unbind tombstone', {
        endedRecords: ended.length,
        staleTombstones,
      });
    }
    return ended;
  }

  /**
   * Push and announce the removal of a record that a late tombstone read
   * ended. The record had been in use in this generation, so its panel may be
   * showing it bound: a tab that navigated off its origin is shown as having
   * left it, as {@link leaveOrigin} shows it, and any other cause as unbound,
   * as {@link unbindLocked} does — a `binding-limit` one without a change
   * cause, as {@link endLeastRecentlyBound} announces it. The tombstone itself
   * stays to be flushed.
   */
  function announceEndedByTombstone({ record, tombstone }: EndedByTombstone): void {
    const { cause } = tombstone;
    logger.info('Tab binding ended by an unbind tombstone read back late', {
      tabId: record.tabId,
      sessionId: record.sessionId,
      cause,
    });
    if (cause === CAUSE_NAVIGATED_AWAY) {
      const state = tabLeftState(record.origin, record.sessionId, REASON_ORIGIN_CHANGED);
      departures.set(record.tabId, state);
      announce({
        kind: 'removed',
        tabId: record.tabId,
        previous: record,
        current: undefined,
        state,
        reason: REASON_ORIGIN_CHANGED,
        cause: undefined,
      });
      return;
    }
    departures.delete(record.tabId);
    announce({
      kind: 'removed',
      tabId: record.tabId,
      previous: record,
      current: undefined,
      state: UNBOUND_STATE,
      reason: REASON_UNBOUND,
      cause: cause === CAUSE_BINDING_LIMIT ? undefined : cause,
    });
  }

  /**
   * End the stored bindings hydration could not keep — the valid ones beyond
   * {@link MAX_STORED_TAB_BINDINGS}, least recently bound first — through owed
   * unbinds, so none is forgotten while the service may still hold it: the
   * service keeps a binding across a dropped socket, and a reconnect
   * re-announces only the records that remain.
   *
   * Each gets a write-ahead tombstone (cause `binding-limit`, naming its
   * session) unless a decision about the tab made at or after its `boundAt`
   * already stands, which carries the unbind itself; the list is written, then
   * each `session.unbind { tabId }` is handed to the transport and its delivery
   * counted. A tab with a bind in flight in this generation is held back
   * instead, as {@link TabRegistry.requestBind} holds one back: sent now, the
   * unbind would follow that bind and end it, and the bind's confirmation
   * supersedes the tombstone.
   *
   * At most {@link MAX_STORED_UNBIND_TOMBSTONES} — the most recently bound —
   * are ended, so corrupted storage cannot make the worker send more unbinds
   * than the list can hold; any beyond that are dropped and logged as an
   * error. Runs inside the queue, from {@link hydrate}, which writes the
   * bindings through and announces the removals.
   *
   * @returns The records ended, least recently bound first.
   */
  async function endPrunedBindings(
    pruned: readonly TabBindingRecord[],
  ): Promise<readonly TabBindingRecord[]> {
    if (pruned.length === 0) {
      return [];
    }
    const ending = pruned.slice(-MAX_STORED_UNBIND_TOMBSTONES);
    const abandoned = pruned.length - ending.length;
    const createdAt = now();
    const written: TabUnbindTombstone[] = [];
    for (const record of ending) {
      departures.delete(record.tabId);
      const standing = tombstones.get(record.tabId);
      if (standing !== undefined && standing.createdAt >= record.boundAt) {
        continue;
      }
      forgetTombstone(record.tabId);
      const tombstone = makeTombstone({
        tabId: record.tabId,
        sessionId: record.sessionId,
        cause: CAUSE_BINDING_LIMIT,
        createdAt,
        deliveries: 0,
      });
      tombstones.set(record.tabId, tombstone);
      noteDecidedBeforeHydration(record.tabId);
      written.push(tombstone);
    }
    enforceTombstoneLimit();
    if (written.length > 0) {
      await writeTombstones();
    }
    let handed = 0;
    let heldBack = 0;
    let counted = false;
    for (const tombstone of written) {
      if (tombstones.get(tombstone.tabId) !== tombstone) {
        continue;
      }
      if (reservedBindTabs.has(tombstone.tabId)) {
        pendingBindTabs.add(tombstone.tabId);
        heldBack += 1;
        continue;
      }
      const payload: SessionUnbindPayload = { tabId: tombstone.tabId };
      const outcome = report(MESSAGE_TYPE.SESSION_UNBIND, payload, {
        tabId: tombstone.tabId,
        sessionId: tombstone.sessionId,
        cause: tombstone.cause,
      });
      if (outcome.ok) {
        handed += 1;
      }
      if (countDelivery(tombstone, outcome) !== 'unchanged') {
        counted = true;
      }
    }
    if (counted) {
      await writeTombstones();
    }
    logger.warn('Ended stored tab bindings beyond the binding limit through owed unbinds', {
      ended: ending.length,
      tombstoned: written.length,
      handed,
      heldBack,
      limit: MAX_STORED_TAB_BINDINGS,
    });
    if (abandoned > 0) {
      logger.error(
        'Dropped stored tab bindings beyond what one hydration ends: storage held more than the registry writes',
        { dropped: abandoned, limit: MAX_STORED_UNBIND_TOMBSTONES },
      );
    }
    return ending;
  }

  /**
   * Bring the caches in line with storage for this worker generation.
   *
   * The binding key is read when this generation has not read it yet, or when
   * `rereadBindings` — an explicit {@link TabRegistry.reload} — asks; the
   * tombstone key is read until one read of it succeeds, and never again (see
   * `loadBindings` and `mergeTombstones` for what each failure means). Once
   * the tombstones are hydrated, the two caches are reconciled; the bindings
   * are written back when entries were dropped or ended, and the tombstone
   * list whenever it is dirty — including a write withheld while the key was
   * unreadable, which is performed right here, after the read succeeded.
   *
   * A record ended by a tombstone read back *late* — after the binding cache
   * was already in use — is then announced; at a generation's first
   * hydration, before anything was announced, ending one is silent.
   *
   * Stored bindings beyond {@link MAX_STORED_TAB_BINDINGS} are ended through
   * owed unbinds ({@link endPrunedBindings}) once the tombstones are merged —
   * their tombstones written ahead of the binding map that no longer names
   * them — and every one of them is announced, whichever hydration read it:
   * its panel may still show the binding an earlier generation pushed.
   */
  async function hydrate(rereadBindings: boolean): Promise<void> {
    const readBindings = rereadBindings || !bindingsHydrated;
    const readTombstones = tombstoneHydration !== 'hydrated';
    const [storedBindings, storedTombstones] = await Promise.all([
      readBindings ? readStorageKey(BINDING_STORAGE_KEY) : undefined,
      readTombstones ? readStorageKey(UNBIND_TOMBSTONE_STORAGE_KEY) : undefined,
    ]);
    const loaded = storedBindings === undefined ? undefined : loadBindings(storedBindings);
    let bindingsChanged = loaded?.rewrite ?? false;
    if (storedTombstones !== undefined) {
      mergeTombstones(storedTombstones);
    }
    // Reconciling needs both halves; while the tombstones are unreadable it
    // waits for the retry that hydrates them.
    const ended = tombstoneHydration === 'hydrated' ? reconcile() : [];
    if (ended.length > 0) {
      bindingsChanged = true;
    }
    const endedPruned = await endPrunedBindings(loaded?.pruned ?? []);
    if (bindingsChanged) {
      await persist();
    }
    if (tombstonesDirty) {
      await writeTombstones();
    }
    if (storedBindings === undefined) {
      for (const endedRecord of ended) {
        announceEndedByTombstone(endedRecord);
      }
    }
    for (const record of endedPruned) {
      announce({
        kind: 'removed',
        tabId: record.tabId,
        previous: record,
        current: undefined,
        state: UNBOUND_STATE,
        reason: REASON_UNBOUND,
        cause: undefined,
      });
    }
    logger.debug('Tab registry hydrated from session storage', {
      bindings: cache.size,
      tombstones: tombstones.size,
      tombstoneHydration,
    });
  }

  /**
   * Hydrate before the first use of the caches in this generation. After a
   * failed tombstone read it does not read again itself: that retry runs at
   * the start of every queued operation ({@link retryOwedTombstoneIo}),
   * before the operation reaches this.
   */
  async function ensureHydrated(): Promise<void> {
    if (!bindingsHydrated || tombstoneHydration === 'cold') {
      await hydrate(false);
    }
  }

  /**
   * Retry the tombstone storage I/O an earlier operation of this generation
   * could not complete: the read that failed (whose success also writes a
   * dirty list), or else the write of a dirty list. A registry that has done
   * no I/O owes none, so a fresh registry stays I/O-free until an operation
   * needs its caches.
   */
  async function retryOwedTombstoneIo(): Promise<void> {
    if (tombstoneHydration === 'failed') {
      await hydrate(false);
      return;
    }
    if (tombstonesDirty) {
      await writeTombstones();
    }
  }

  /**
   * Write the whole cache through to storage — or remove the key when no
   * binding remains, so an idle browser session holds no entry at all.
   *
   * A failed write is logged and answered `false`; the cache keeps the change,
   * because the cache holds what the service confirmed and the next successful
   * write stores the whole map again.
   */
  async function persist(): Promise<boolean> {
    try {
      if (cache.size === 0) {
        await storage.remove(BINDING_STORAGE_KEY);
      } else {
        await storage.set({ [BINDING_STORAGE_KEY]: toSnapshot(cache.values()) });
      }
      return true;
    } catch (cause) {
      logger.error('Tab bindings could not be written to session storage; kept in memory', {
        code: DebuggenError.from(cause, 'STORE_ERROR').code,
        bindings: cache.size,
      });
      return false;
    }
  }

  /**
   * Write every pending tombstone through to storage, oldest first — or remove
   * the key when none remains — and clear the dirty mark.
   *
   * Never while the tombstone key is not hydrated: storage may then hold
   * intents this generation has not read, and writing the in-memory list over
   * them would erase them. The write is withheld and the list marked dirty, to
   * be written right after a read succeeds. A write that fails is logged — its
   * code only — and marks the list dirty too: the in-memory list keeps the
   * change, so this generation still flushes it, and every later operation
   * retries the write first until one succeeds.
   */
  async function writeTombstones(): Promise<void> {
    if (tombstoneHydration !== 'hydrated') {
      tombstonesDirty = true;
      return;
    }
    try {
      if (tombstones.size === 0) {
        await storage.remove(UNBIND_TOMBSTONE_STORAGE_KEY);
      } else {
        await storage.set({ [UNBIND_TOMBSTONE_STORAGE_KEY]: sortTombstones(tombstones.values()) });
      }
      tombstonesDirty = false;
    } catch (cause) {
      tombstonesDirty = true;
      logger.error(
        'Unbind tombstones could not be written to session storage; kept in memory and retried on the next operation',
        { code: DebuggenError.from(cause, 'STORE_ERROR').code },
      );
    }
  }

  /**
   * Drop a tab's tombstone from memory together with the per-generation state
   * that belongs to it — its pending-bind mark and its delivery-epoch count.
   * The caller writes the list through.
   */
  function forgetTombstone(tabId: TabId): void {
    tombstones.delete(tabId);
    pendingBindTabs.delete(tabId);
    countedThisEpoch.delete(tabId);
  }

  /**
   * Keep the tombstone cache within {@link MAX_STORED_UNBIND_TOMBSTONES} by
   * evicting in {@link compareTombstoneRetention} order — delivered tombstones
   * first, oldest first — each with its per-generation state, and mark the
   * list dirty so the bounded list is what the next write stores. `keep` — the
   * tab whose tombstone was just written ahead of its unbind — is never
   * evicted: it is the decision being made, whatever the clock says of its age.
   *
   * The registry's own writes keep every undelivered tombstone within the slot
   * budget ({@link MAX_STORED_TAB_BINDINGS}, never above this limit), so they
   * always leave a delivered one to evict. Evicting an undelivered one — an
   * unbind still owed — takes state the registry did not write, and is logged
   * as an error rather than the warning an eviction of delivered ones gets. In
   * memory only; logged with counts alone.
   */
  function enforceTombstoneLimit(keep?: TabId): void {
    const excess = tombstones.size - MAX_STORED_UNBIND_TOMBSTONES;
    if (excess <= 0) {
      return;
    }
    const evicted = [...tombstones.values()]
      .filter((tombstone) => tombstone.tabId !== keep)
      .sort(compareTombstoneRetention)
      .slice(0, excess);
    for (const tombstone of evicted) {
      forgetTombstone(tombstone.tabId);
    }
    tombstonesDirty = true;
    const owed = evicted.filter(isUndelivered).length;
    const fields = {
      evicted: evicted.length,
      owed,
      pending: tombstones.size,
      limit: MAX_STORED_UNBIND_TOMBSTONES,
    };
    if (owed === 0) {
      logger.warn(
        'Evicted the oldest delivered unbind tombstones to stay within the stored limit',
        fields,
      );
    } else {
      logger.error(
        'Evicted undelivered unbind tombstones: the registry held more owed unbinds than it stores',
        fields,
      );
    }
  }

  /**
   * Whether a tab holds a slot (see "Capacity" in the module overview): it has
   * a record, a bind in flight, or an undelivered tombstone.
   */
  function holdsSlot(tabId: TabId): boolean {
    const tombstone = tombstones.get(tabId);
    return (
      cache.has(tabId) ||
      reservedBindTabs.has(tabId) ||
      (tombstone !== undefined && isUndelivered(tombstone))
    );
  }

  /** How many tabs hold a slot — each counted once, whatever holds it. */
  function slotsInUse(): number {
    const holders = new Set<TabId>(cache.keys());
    for (const tabId of reservedBindTabs) {
      holders.add(tabId);
    }
    for (const tombstone of tombstones.values()) {
      if (isUndelivered(tombstone)) {
        holders.add(tombstone.tabId);
      }
    }
    return holders.size;
  }

  /** Whether a tab that holds no slot can take one now. */
  function hasFreeSlot(): boolean {
    return slotsInUse() < MAX_STORED_TAB_BINDINGS;
  }

  /**
   * While the tombstone key is not hydrated, remember that this generation
   * decided the tab's tombstone, so a late merge keeps that decision (see
   * `decidedBeforeHydration`).
   */
  function noteDecidedBeforeHydration(tabId: TabId): void {
    if (tombstoneHydration !== 'hydrated') {
      decidedBeforeHydration.add(tabId);
    }
  }

  /**
   * Send one protocol frame and log the outcome by message type and code only.
   *
   * `ProtocolSend` does not throw for an expected condition; a throw from a
   * faulty transport is still converted into an `err`, so a registry
   * operation never rejects halfway through its bookkeeping.
   */
  function report<K extends MessageType>(
    type: K,
    payload: MessagePayload<K>,
    fields: LogFields,
  ): Result<SendOutcome, DebuggenError> {
    let outcome: Result<SendOutcome, DebuggenError>;
    try {
      outcome = send(type, payload);
    } catch (cause) {
      outcome = err(DebuggenError.from(cause, 'TRANSPORT_DISCONNECTED'));
    }
    if (outcome.ok) {
      logger.debug('Binding frame handed to the transport', {
        type,
        outcome: outcome.value,
        ...fields,
      });
    } else {
      logger.warn('Binding frame not sent', { type, code: outcome.error.code, ...fields });
    }
    return outcome;
  }

  /**
   * Announce one change that has already been written through: push its state
   * to the tab's panels (unless `push` is `false` — a capture change leaves the
   * panel's binding state as it was) and notify every listener. A sink or a
   * listener that throws is logged and does not stop the others.
   */
  function announce(change: TabBindingChange, push = true): void {
    if (push) {
      try {
        notify(change.tabId, bindingPush(change.state));
      } catch (cause) {
        logger.warn('Binding state could not be pushed to the panel', {
          tabId: change.tabId,
          code: DebuggenError.from(cause, 'INTERNAL').code,
        });
      }
    }
    for (const listener of [...listeners]) {
      try {
        listener(change);
      } catch (cause) {
        logger.error('A tab binding listener threw', {
          tabId: change.tabId,
          code: DebuggenError.from(cause, 'INTERNAL').code,
        });
      }
    }
  }

  /** The record holding a session, if any tab holds it. */
  function findBySession(sessionId: SessionId): TabBindingRecord | undefined {
    for (const record of cache.values()) {
      if (record.sessionId === sessionId) {
        return record;
      }
    }
    return undefined;
  }

  /*
   * ---- unbind tombstones: write-ahead, delivery accounting, retirement ----
   */

  /**
   * Account for one hand-off of a tombstone's `session.unbind`, in memory
   * only — the caller writes the list through. Only `sent` counts: a frame
   * `queued` while the socket reconnects dies with the worker, and a refused
   * one never left. It counts once per delivery epoch (see
   * {@link MAX_UNBIND_TOMBSTONE_DELIVERIES}): a second `sent` hand-off of the
   * same tombstone before the next flush — {@link TabRegistry.requestBind}
   * re-sending it ahead of another bind on the same connection — adds nothing.
   *
   * @returns `unchanged`, `counted` (the delivery count grew) or `exhausted`
   * (the count reached {@link MAX_UNBIND_TOMBSTONE_DELIVERIES} and the
   * tombstone was retired).
   */
  function countDelivery(
    tombstone: TabUnbindTombstone,
    outcome: Result<SendOutcome, DebuggenError>,
  ): 'unchanged' | 'counted' | 'exhausted' {
    if (!outcome.ok || outcome.value !== OUTCOME_SENT) {
      return 'unchanged';
    }
    if (countedThisEpoch.has(tombstone.tabId)) {
      return 'unchanged';
    }
    const deliveries = tombstone.deliveries + 1;
    if (deliveries >= MAX_UNBIND_TOMBSTONE_DELIVERIES) {
      forgetTombstone(tombstone.tabId);
      return 'exhausted';
    }
    countedThisEpoch.add(tombstone.tabId);
    tombstones.set(tombstone.tabId, makeTombstone({ ...tombstoneFieldsOf(tombstone), deliveries }));
    return 'counted';
  }

  /**
   * Report a tab's unbind under a write-ahead tombstone: write the tombstone
   * through (replacing any earlier one for the tab, with its pending-bind mark
   * and epoch count), then hand `session.unbind { tabId }` to the transport,
   * then write the delivery count through when a `sent` outcome changed it.
   * Runs inside the queue, and before the caller drops the record, so the
   * intent is durable before anything else of the unbind happens. A tombstone
   * that takes the list past {@link MAX_STORED_UNBIND_TOMBSTONES} evicts
   * another one before the write — a delivered one ({@link enforceTombstoneLimit})
   * — so storage never holds more than hydration keeps.
   *
   * When a write cannot be made — the key is unreadable, or storage refuses
   * it — the tombstone stays in memory, dirty, and the frame is still
   * reported: see "Storage failures" in the module overview for why the
   * caller then still drops the record.
   */
  async function reportUnbind(
    tabId: TabId,
    sessionId: SessionId | undefined,
    cause: UnbindTombstoneCause,
  ): Promise<Result<SendOutcome, DebuggenError>> {
    const tombstone = makeTombstone({ tabId, sessionId, cause, createdAt: now(), deliveries: 0 });
    forgetTombstone(tabId);
    tombstones.set(tabId, tombstone);
    enforceTombstoneLimit(tabId);
    noteDecidedBeforeHydration(tabId);
    await writeTombstones();
    const payload: SessionUnbindPayload = { tabId };
    const outcome = report(MESSAGE_TYPE.SESSION_UNBIND, payload, { tabId, sessionId, cause });
    if (countDelivery(tombstone, outcome) !== 'unchanged') {
      await writeTombstones();
    }
    return outcome;
  }

  /**
   * Retire a tab's tombstone because the service acknowledged it (a drop it
   * announced) or superseded it (a binding it confirmed and
   * {@link establish} recorded), and write the list through. Runs inside the
   * queue. Retiring also ends the tab's pending-bind mark.
   *
   * With `sessionId`, a tombstone naming a *different* session is kept: the
   * announcement is about another binding of the tab. A tombstone naming no
   * session matches any.
   *
   * @returns The retired tombstone, or `undefined` when none matched.
   */
  async function retireTombstone(
    tabId: TabId,
    retirement: 'acknowledged' | 'superseded',
    sessionId?: SessionId,
  ): Promise<TabUnbindTombstone | undefined> {
    const tombstone = tombstones.get(tabId);
    if (tombstone === undefined) {
      return undefined;
    }
    if (
      sessionId !== undefined &&
      tombstone.sessionId !== undefined &&
      tombstone.sessionId !== sessionId
    ) {
      logger.debug('Unbind tombstone kept: the announcement names another session', {
        tabId,
        sessionId: tombstone.sessionId,
        announcedSessionId: sessionId,
      });
      return undefined;
    }
    forgetTombstone(tabId);
    await writeTombstones();
    logger.debug('Unbind tombstone retired', {
      tabId,
      sessionId: tombstone.sessionId,
      cause: tombstone.cause,
      retirement,
      deliveries: tombstone.deliveries,
    });
    return tombstone;
  }

  /**
   * Open a new delivery epoch and re-send every pending tombstone, oldest
   * first, after retiring the delivered ones past the age limit and skipping
   * those a pending bind holds back; write the list through once when it
   * changed. (A write still owed from an earlier operation was retried by the
   * queue before this ran.) Runs inside the queue; see
   * {@link TabRegistry.flushPendingUnbinds}.
   *
   * @returns How many frames the transport accepted (`sent` or `queued`).
   */
  async function flushLocked(): Promise<number> {
    await ensureHydrated();
    // `service-worker.ts` flushes once per transition of the socket to
    // connected, so each flush begins the epoch of one connection.
    countedThisEpoch.clear();
    if (tombstones.size === 0) {
      logger.debug('No pending unbinds to flush');
      return 0;
    }
    const at = now();
    let handed = 0;
    let refused = 0;
    let expired = 0;
    let exhausted = 0;
    let heldBack = 0;
    let changed = false;
    for (const tombstone of sortTombstones(tombstones.values())) {
      // Age retires only a tombstone the service's socket has had at least
      // once; one only ever queued or refused has told the service nothing.
      if (tombstone.deliveries >= 1 && at - tombstone.createdAt >= UNBIND_TOMBSTONE_TTL_MS) {
        forgetTombstone(tombstone.tabId);
        expired += 1;
        changed = true;
        continue;
      }
      if (pendingBindTabs.has(tombstone.tabId)) {
        // A bind of this tab is still pending — its unbind went ahead of it,
        // or the tombstone was not yet readable when it left. Sent now, the
        // unbind would follow that bind and end it.
        heldBack += 1;
        continue;
      }
      const payload: SessionUnbindPayload = { tabId: tombstone.tabId };
      const outcome = report(MESSAGE_TYPE.SESSION_UNBIND, payload, {
        tabId: tombstone.tabId,
        sessionId: tombstone.sessionId,
        cause: tombstone.cause,
        deliveries: tombstone.deliveries,
      });
      if (!outcome.ok) {
        refused += 1;
        continue;
      }
      handed += 1;
      const counted = countDelivery(tombstone, outcome);
      if (counted !== 'unchanged') {
        changed = true;
      }
      if (counted === 'exhausted') {
        exhausted += 1;
      }
    }
    if (changed) {
      await writeTombstones();
    }
    logger.info('Pending unbinds flushed', {
      handed,
      refused,
      expired,
      exhausted,
      heldBack,
      pending: tombstones.size,
    });
    return handed;
  }

  /*
   * ---- session.bound: the authoritative writes ----
   */

  /**
   * End the least recently bound binding ({@link compareBindingRecency}) to
   * make room for a confirmation at {@link MAX_STORED_TAB_BINDINGS}, through
   * the ordinary unbind: its tombstone is written ahead (cause
   * `binding-limit`), its `session.unbind { tabId }` handed to the transport,
   * and its record dropped from the cache. Never a silent drop — a record
   * forgotten here but still bound at the service would keep the session's
   * `agent.config`, `telemetry.tail` and `panel.generated` routed to a tab
   * this worker no longer tracks. Runs inside the queue, from
   * {@link makeRoom}; {@link establish} writes the bindings through and
   * announces the removal.
   *
   * @returns The record that was ended, or `undefined` when none is held.
   */
  async function endLeastRecentlyBound(): Promise<TabBindingRecord | undefined> {
    const oldest = leastRecentlyBound(cache.values());
    if (oldest === undefined) {
      return undefined;
    }
    await reportUnbind(oldest.tabId, oldest.sessionId, CAUSE_BINDING_LIMIT);
    cache.delete(oldest.tabId);
    departures.delete(oldest.tabId);
    logger.warn('Ended the least recently bound tab binding to stay within the binding limit', {
      tabId: oldest.tabId,
      sessionId: oldest.sessionId,
      cause: CAUSE_BINDING_LIMIT,
      limit: MAX_STORED_TAB_BINDINGS,
    });
    return oldest;
  }

  /**
   * Make room to record a confirmed binding of a new tab `tabId`, without
   * forgetting any obligation (see "Capacity" in the module overview). Room is
   * needed when the binding map is full, or when the tab holds no slot and
   * every slot is held.
   *
   * A slot is freed first by delivering owed unbinds — the oldest undelivered
   * tombstones of other tabs with no bind in flight, which the next flush would
   * send anyway — and then by ending the least recently bound bindings through
   * the ordinary unbind ({@link endLeastRecentlyBound}), which also makes room
   * in the map. Only a delivery frees a slot, so once the socket takes no frame
   * no more bindings are ended for a slot: a binding ended whose unbind was not
   * sent still holds its slot, as an owed unbind. The tab's own tombstone is
   * never delivered here: sent after the bind the service just applied, it
   * would end it. Runs inside the queue, from {@link establish}.
   *
   * @param ended Receives every binding ended here, for the caller to announce.
   * @returns Whether the binding can now be recorded.
   */
  async function makeRoom(tabId: TabId, ended: TabBindingRecord[]): Promise<boolean> {
    const mapFull = (): boolean => cache.size >= MAX_STORED_TAB_BINDINGS;
    const slotsFull = (): boolean => !holdsSlot(tabId) && !hasFreeSlot();
    if (!mapFull() && !slotsFull()) {
      return true;
    }
    let socketTakesFrames = true;
    let delivered = 0;
    while (slotsFull()) {
      const owed = sortTombstones(tombstones.values()).find(
        (tombstone) =>
          tombstone.tabId !== tabId &&
          isUndelivered(tombstone) &&
          !reservedBindTabs.has(tombstone.tabId),
      );
      if (owed === undefined) {
        break;
      }
      const payload: SessionUnbindPayload = { tabId: owed.tabId };
      const outcome = report(MESSAGE_TYPE.SESSION_UNBIND, payload, {
        tabId: owed.tabId,
        sessionId: owed.sessionId,
        cause: owed.cause,
        deliveries: owed.deliveries,
      });
      if (countDelivery(owed, outcome) === 'unchanged') {
        socketTakesFrames = false;
        break;
      }
      delivered += 1;
    }
    if (delivered > 0) {
      await writeTombstones();
    }
    while (mapFull() || (socketTakesFrames && slotsFull())) {
      const endedRecord = await endLeastRecentlyBound();
      if (endedRecord === undefined) {
        break;
      }
      ended.push(endedRecord);
      const tombstone = tombstones.get(endedRecord.tabId);
      if (tombstone !== undefined && isUndelivered(tombstone)) {
        socketTakesFrames = false;
      }
    }
    const room = !mapFull() && !slotsFull();
    logger.info('Made room for a confirmed binding at the binding limit', {
      tabId,
      delivered,
      ended: ended.length,
      room,
      limit: MAX_STORED_TAB_BINDINGS,
    });
    return room;
  }

  /**
   * Announce the removals one confirmation caused, after they were written
   * through: the tabs the session was moved off (`replaced`), then the
   * bindings ended to make room for it — announced as `unbound` with no
   * worker cause, since the binding limit is not one of
   * {@link TAB_UNBIND_CAUSES} (see {@link TabBindingChange.cause}).
   */
  function announceRemovedForConfirmation(
    displaced: readonly TabBindingRecord[],
    endedAtLimit: readonly TabBindingRecord[],
  ): void {
    for (const other of displaced) {
      announce({
        kind: 'removed',
        tabId: other.tabId,
        previous: other,
        current: undefined,
        state: UNBOUND_STATE,
        reason: REASON_REPLACED,
        cause: undefined,
      });
    }
    for (const ended of endedAtLimit) {
      announce({
        kind: 'removed',
        tabId: ended.tabId,
        previous: ended,
        current: undefined,
        state: UNBOUND_STATE,
        reason: REASON_UNBOUND,
        cause: undefined,
      });
    }
  }

  /**
   * Record an established binding (`reason` absent or `bound`).
   *
   * The tab's previous record, if it named another session, is replaced; any
   * other tab holding the same session is displaced and its panel told it is
   * unbound, so a panel whose binding was taken never keeps claiming
   * "Connected". A re-announcement of the binding the tab already holds (after
   * a socket reconnect) keeps its `boundAt` and its running capture. A tab
   * that holds no slot, confirmed while every slot is held, first makes room
   * ({@link makeRoom}); a binding ended for it is announced after this one's.
   * When no room can be made, the confirmation is declined — not recorded,
   * answered `ignored` — and only the displacement is written and announced:
   * the service moved the session off those tabs either way.
   */
  async function establish(
    bound: SessionBoundPayload,
    reason: BindingReason,
  ): Promise<Result<ApplyBoundOutcome, DebuggenError>> {
    const origin = httpOriginOf(bound.url);
    if (origin === undefined) {
      logger.warn('Refused a session.bound for a document without an HTTP(S) origin', {
        tabId: bound.tabId,
        sessionId: bound.sessionId,
      });
      return err(
        workerError(
          'PROTOCOL_INVALID_MESSAGE',
          'A session.bound announcement named a document without an HTTP or HTTPS origin, so no binding was recorded.',
        ),
      );
    }

    const previous = cache.get(bound.tabId);
    // The service announces a kept same-origin navigation as the binding now
    // stands (`bound`) — only a new page-agent document proves a reload — so an
    // establishment may also be the late answer to a `tab.navigated` this
    // worker has since ended the binding over: a same-origin commit followed by
    // one off the origin before the service answered. Such a frame finds no
    // record, no bind of the tab in flight, and the unbind that navigation
    // wrote ahead still pending for the same session. Recording it would
    // resurrect the binding — and let the capture's re-arm reach the document
    // on the other origin — until the service's drop arrived, and would retire
    // that unbind as superseded; so it is ignored, as a late `navigated` frame
    // is (see `refreshNavigated`).
    if (previous === undefined && !reservedBindTabs.has(bound.tabId)) {
      const owed = tombstones.get(bound.tabId);
      if (owed?.cause === CAUSE_NAVIGATED_AWAY && owed.sessionId === bound.sessionId) {
        logger.debug('Ignored a late establishment of a binding this worker ended on navigation', {
          tabId: bound.tabId,
          sessionId: bound.sessionId,
        });
        return ok({ kind: 'ignored', reason });
      }
    }
    const sameBinding = previous !== undefined && previous.sessionId === bound.sessionId;
    const record = makeRecord({
      tabId: bound.tabId,
      sessionId: bound.sessionId,
      url: bound.url,
      origin,
      boundAt: sameBinding ? previous.boundAt : now(),
      captureId: sameBinding ? previous.captureId : undefined,
    });

    const displaced = [...cache.values()].filter(
      (other) => other.tabId !== bound.tabId && other.sessionId === bound.sessionId,
    );
    for (const other of displaced) {
      cache.delete(other.tabId);
      departures.delete(other.tabId);
    }
    // A new tab at the limit: room is made first, so the map written below —
    // and hydrated by the next generation — stays within
    // MAX_STORED_TAB_BINDINGS, and so do the slots. A binding ended for it has
    // its tombstone written ahead inside, before the bindings are.
    const endedAtLimit: TabBindingRecord[] = [];
    const hasRoom = cache.has(record.tabId) || (await makeRoom(record.tabId, endedAtLimit));
    if (!hasRoom) {
      await persist();
      announceRemovedForConfirmation(displaced, endedAtLimit);
      logger.error(
        'Declined to record a confirmed binding: every slot is held and the socket took no frame to free one',
        {
          tabId: record.tabId,
          sessionId: record.sessionId,
          slots: slotsInUse(),
          limit: MAX_STORED_TAB_BINDINGS,
          displacedTabs: displaced.map((other) => other.tabId),
          limitEndedTabs: endedAtLimit.map((ended) => ended.tabId),
        },
      );
      return ok({ kind: 'ignored', reason });
    }
    cache.set(record.tabId, record);
    reservedBindTabs.delete(record.tabId);
    departures.delete(record.tabId);
    await persist();
    // The service accepted a bind of this tab, replacing whatever it held, so
    // a pending unbind of the tab is superseded: flushed later, its
    // `{ tabId }` payload would end this binding. This confirmation — never
    // the request for it — is what retires the tombstone. Retired after the
    // record is stored, so a crash in between leaves a tombstone older than
    // `boundAt`, which hydration discards; the bind it answers is no longer
    // pending either.
    await retireTombstone(record.tabId, 'superseded');
    pendingBindTabs.delete(record.tabId);
    if (!sameBinding) {
      // A new binding is this generation's decision about the tab, newer than
      // any tombstone a not-yet-readable key may hold for it. A re-confirmed
      // binding is not: its `boundAt` is the stored one, and reconciliation
      // weighs a stored tombstone against that.
      noteDecidedBeforeHydration(record.tabId);
    }

    announce({
      kind: sameBinding ? 'updated' : 'recorded',
      tabId: record.tabId,
      previous,
      current: record,
      state: boundState(record),
      reason,
      cause: undefined,
    });
    announceRemovedForConfirmation(displaced, endedAtLimit);

    logger.info(sameBinding ? 'Tab binding re-confirmed' : 'Tab bound to session', {
      tabId: record.tabId,
      sessionId: record.sessionId,
      origin,
      replacedSession: previous !== undefined && !sameBinding ? previous.sessionId : undefined,
      displacedTabs: displaced.map((other) => other.tabId),
      limitEndedTabs: endedAtLimit.map((ended) => ended.tabId),
    });

    if (sameBinding) {
      return ok({ kind: 'updated', record, reason });
    }
    return ok({
      kind: 'recorded',
      record,
      previous,
      displaced: sortRecords(displaced),
      reason,
    });
  }

  /**
   * Apply the service's `navigated` announcement: the binding was kept across
   * a same-origin navigation, so the record takes the new document's URL.
   *
   * Only a record for the same tab **and** session is refreshed. A `navigated`
   * frame for a binding this worker no longer holds — one it already dropped
   * on a later cross-origin navigation, say — is late and is ignored, so it
   * cannot resurrect a binding.
   */
  async function refreshNavigated(
    bound: SessionBoundPayload,
    reason: BindingReason,
  ): Promise<ApplyBoundOutcome> {
    const current = cache.get(bound.tabId);
    const origin = httpOriginOf(bound.url);
    if (current === undefined || current.sessionId !== bound.sessionId || origin === undefined) {
      logger.debug('Ignored a navigated announcement for a binding this worker does not hold', {
        tabId: bound.tabId,
        sessionId: bound.sessionId,
      });
      return { kind: 'ignored', reason };
    }
    // The service compared the origin and kept the binding; it is the
    // authority, so its URL (and that URL's origin) is what is recorded.
    const record = makeRecord({ ...fieldsOf(current), url: bound.url, origin });
    cache.set(record.tabId, record);
    await persist();
    announce({
      kind: 'updated',
      tabId: record.tabId,
      previous: current,
      current: record,
      state: boundState(record),
      reason,
      cause: undefined,
    });
    return { kind: 'updated', record, reason };
  }

  /**
   * Apply an announcement that ends a binding: `replaced` (another bind took
   * it), `origin-changed` (the tab left the session's origin) or `unbound`
   * (DevTools closed, the tab closed or the session ended).
   *
   * Only a record naming the same tab **and** session is dropped: a frame
   * about an earlier binding of the tab — the displaced half of a replacement
   * that has already been recorded, for instance — must not undo the current
   * one. A tab that left its origin is shown `tab-left` with the origin it
   * left; the other two drops show `unbound`. (The service's own reason also
   * reaches the panel on the relayed `session.bound` frame itself.)
   *
   * Any of the three drops is also the service's acknowledgement of a pending
   * unbind of the tab, so the tab's tombstone is retired first — matched on
   * the tab, and on the session when the tombstone names one. That holds when
   * no record matches too: the record was dropped when the unbind was decided,
   * so the acknowledgement of a tombstone normally arrives as an `ignored`
   * frame.
   */
  async function dropAnnounced(
    bound: SessionBoundPayload,
    reason: typeof REASON_REPLACED | typeof REASON_ORIGIN_CHANGED | typeof REASON_UNBOUND,
  ): Promise<ApplyBoundOutcome> {
    await retireTombstone(bound.tabId, 'acknowledged', bound.sessionId);
    const current = cache.get(bound.tabId);
    if (current === undefined || current.sessionId !== bound.sessionId) {
      logger.debug('Ignored a binding drop for a binding this worker does not hold', {
        tabId: bound.tabId,
        sessionId: bound.sessionId,
        reason,
      });
      return { kind: 'ignored', reason };
    }
    cache.delete(current.tabId);
    const state =
      reason === REASON_ORIGIN_CHANGED
        ? tabLeftState(current.origin, current.sessionId, reason)
        : UNBOUND_STATE;
    if (state.kind === 'tab-left') {
      departures.set(current.tabId, state);
    } else {
      departures.delete(current.tabId);
    }
    await persist();
    announce({
      kind: 'removed',
      tabId: current.tabId,
      previous: current,
      current: undefined,
      state,
      reason,
      cause: undefined,
    });
    logger.info('Tab binding dropped by the service', {
      tabId: current.tabId,
      sessionId: current.sessionId,
      origin: current.origin,
      reason,
    });
    return { kind: 'removed', removed: current, reason };
  }

  /** Dispatch a validated `session.bound` on its reason. */
  async function applyValidatedBound(
    bound: SessionBoundPayload,
  ): Promise<Result<ApplyBoundOutcome, DebuggenError>> {
    await ensureHydrated();
    // An absent reason is an establishment (see `sessionBoundPayloadSchema`).
    const reason: BindingReason = bound.reason ?? REASON_BOUND;
    switch (reason) {
      case REASON_BOUND:
        return establish(bound, reason);
      case REASON_NAVIGATED:
        return ok(await refreshNavigated(bound, reason));
      case REASON_REPLACED:
      case REASON_ORIGIN_CHANGED:
      case REASON_UNBOUND:
        return ok(await dropAnnounced(bound, reason));
      default:
        return assertNever(reason, 'Unhandled binding reason');
    }
  }

  /*
   * ---- navigation ----
   */

  /**
   * Report one committed navigation and decide what it means for the tab's
   * binding. See {@link NavigationDecision} for the three outcomes.
   *
   * The comparison is between the new document's origin and the origin the
   * binding was recorded for, both serialized by the platform `URL` parser. A
   * URL that does not parse, or has no HTTP(S) origin, can never equal a bound
   * origin, so it is a cross-origin navigation: the tab has left the app.
   *
   * A navigation that is not a valid `tab.navigated` payload — its URL longer
   * than the protocol admits, or not absolute — can be neither reported nor
   * recorded (a record holding it would be refused by the next hydration), so
   * it takes {@link navigateUnreportable}'s path.
   */
  async function navigate(navigation: TabNavigation): Promise<NavigationDecision> {
    const { tabId, url } = navigation;
    if (!isTabId(tabId)) {
      logger.warn('Ignored a navigation report for an invalid tab id');
      return { kind: 'not-bound', tabId, reported: false };
    }
    if (!parseTabNavigatedPayload({ tabId, url }).ok) {
      logger.warn('Navigation not reportable as tab.navigated; handled as unreportable', { tabId });
      return navigateUnreportable(tabId);
    }

    const navigated: TabNavigatedPayload = { tabId, url };
    const reported = report(MESSAGE_TYPE.TAB_NAVIGATED, navigated, { tabId }).ok;

    await ensureHydrated();
    const current = cache.get(tabId);
    if (current === undefined) {
      return { kind: 'not-bound', tabId, reported };
    }

    const origin = httpOriginOf(url);
    if (origin !== undefined && origin === current.origin) {
      const record = makeRecord({ ...fieldsOf(current), url });
      cache.set(tabId, record);
      await persist();
      announce({
        kind: 'updated',
        tabId,
        previous: current,
        current: record,
        state: boundState(record),
        reason: REASON_NAVIGATED,
        cause: undefined,
      });
      logger.info('Bound tab navigated within its origin; binding kept', {
        tabId,
        sessionId: current.sessionId,
        origin,
        decision: 'kept-same-origin',
        capture: current.captureId !== undefined,
      });
      return {
        kind: 'kept-same-origin',
        tabId,
        sessionId: current.sessionId,
        captureId: current.captureId,
        url,
        origin,
        reported,
      };
    }

    return leaveOrigin(current, origin, reported);
  }

  /**
   * Decide a committed navigation the caller could not report because its URL
   * has no form the service accepts. See
   * {@link TabRegistry.handleUnreportableNavigation}.
   *
   * No `tab.navigated` is sent — there is no URL to send, and this module is
   * never handed one — so the service learns of the departure from the
   * `session.unbind` alone, under the same write-ahead tombstone as any other
   * unbind. An unbound tab is not an event: nothing is sent or stored.
   */
  async function navigateUnreportable(tabId: TabId): Promise<NavigationDecision> {
    if (!isTabId(tabId)) {
      logger.warn('Ignored an unreportable navigation for an invalid tab id');
      return { kind: 'not-bound', tabId, reported: false };
    }
    await ensureHydrated();
    const current = cache.get(tabId);
    if (current === undefined) {
      logger.debug('Unreportable navigation of a tab with no binding; nothing to send', {
        tabId,
      });
      return { kind: 'not-bound', tabId, reported: false };
    }
    return leaveOrigin(current, undefined, false);
  }

  /**
   * Withdraw the `tab-left` state of an unbound tab that navigated back to the
   * origin it left. See {@link TabRegistry.handleReturnedNavigation}. Runs
   * inside the queue.
   */
  async function returnToOrigin(tabId: TabId, origin: string | undefined): Promise<boolean> {
    if (!isTabId(tabId) || origin === undefined) {
      return false;
    }
    await ensureHydrated();
    if (cache.has(tabId)) {
      return false;
    }
    const departure = departures.get(tabId);
    if (departure?.kind !== 'tab-left' || departure.origin !== origin) {
      return false;
    }
    departures.delete(tabId);
    try {
      notify(tabId, bindingPush(UNBOUND_STATE));
    } catch (cause) {
      logger.warn('Binding state could not be pushed to the panel', {
        tabId,
        code: DebuggenError.from(cause, 'INTERNAL').code,
      });
    }
    logger.info('Tab returned to the origin it left; its tab-left notice was withdrawn', {
      tabId,
      sessionId: departure.sessionId,
      origin,
    });
    return true;
  }

  /**
   * End a binding because its tab committed a document off the bound origin:
   * write the unbind tombstone, hand `session.unbind { tabId }` to the
   * transport, drop the record, remember the `tab-left` state (with
   * `origin-changed`, the origin it left), write through, announce the
   * removal and answer the `unbound-cross-origin` decision. Runs inside the
   * queue.
   *
   * Shared by a reported cross-origin navigation (`origin` is the new
   * document's HTTP(S) origin, if it has one; `reported` whether its
   * `tab.navigated` was handed over) and an unreportable one (`origin`
   * `undefined`, `reported` `false`), so both leave the same trace.
   */
  async function leaveOrigin(
    current: TabBindingRecord,
    origin: string | undefined,
    reported: boolean,
  ): Promise<NavigationDecision> {
    const { tabId } = current;
    await reportUnbind(tabId, current.sessionId, CAUSE_NAVIGATED_AWAY);
    cache.delete(tabId);
    const state = tabLeftState(current.origin, current.sessionId, REASON_ORIGIN_CHANGED);
    departures.set(tabId, state);
    await persist();
    announce({
      kind: 'removed',
      tabId,
      previous: current,
      current: undefined,
      state,
      reason: REASON_ORIGIN_CHANGED,
      cause: undefined,
    });
    logger.info('Bound tab left its origin; binding dropped', {
      tabId,
      sessionId: current.sessionId,
      origin: current.origin,
      newOrigin: origin,
      navigationReported: reported,
      decision: 'unbound-cross-origin',
    });
    return {
      kind: 'unbound-cross-origin',
      tabId,
      sessionId: current.sessionId,
      captureId: current.captureId,
      previousOrigin: current.origin,
      origin,
      notice: formatTabLeftMessage(current.origin),
      reported,
    };
  }

  /*
   * ---- unbinding and session end ----
   */

  /**
   * End a tab's binding on the worker's own observation. Runs inside the
   * queue; the public `unbind` and `handleSessionEnded` both call it there,
   * never through `exclusive` again (which would wait on itself).
   *
   * The unbind is written ahead as a tombstone before it is reported and
   * before the record is dropped — without a record too, for a
   * `'devtools-closed'` report and for a tab a `session.bind` is still pending
   * over (the new tombstone replaces the one that bind held back, so it is
   * flushable, and the unbind leaves after the bind and ends it if the service
   * applies it); such a tombstone names no session. A reported unbind ends the
   * tab's bind in flight, whose slot its tombstone takes over; one of a tab
   * holding no slot while every slot is held is sent without a tombstone (see
   * "Capacity" in the module overview).
   */
  async function unbindLocked(
    tabId: TabId,
    cause: TabUnbindCause,
  ): Promise<TabBindingRecord | undefined> {
    await ensureHydrated();
    const current = cache.get(tabId);
    departures.delete(tabId);

    if (current === undefined && cause !== CAUSE_DEVTOOLS_CLOSED && !pendingBindTabs.has(tabId)) {
      // A bind still in flight keeps its slot: the DevTools page closing with
      // the tab reports that unbind itself, as `devtools-closed`, and writes
      // its tombstone into that slot.
      logger.debug('Unbind for a tab with no binding; nothing to report', { tabId, cause });
      return undefined;
    }

    if (current === undefined && !holdsSlot(tabId) && !hasFreeSlot()) {
      // DevTools closed on a tab with no binding, no bind in flight and no owed
      // unbind, while every slot is held: nothing this generation did can have
      // left the service a binding of it, so the unbind is sent as the race
      // closer it is, without a tombstone that would need a slot.
      const payload: SessionUnbindPayload = { tabId };
      report(MESSAGE_TYPE.SESSION_UNBIND, payload, { tabId, cause });
      logger.warn('Unbind sent without a tombstone: every slot is held and the tab holds none', {
        tabId,
        cause,
        slots: slotsInUse(),
        limit: MAX_STORED_TAB_BINDINGS,
      });
      return undefined;
    }

    await reportUnbind(tabId, current?.sessionId, cause);
    // The tombstone now carries whatever the bind in flight could leave bound:
    // it is flushable, and sent after that bind it ends it.
    reservedBindTabs.delete(tabId);
    if (current === undefined) {
      return undefined;
    }

    cache.delete(tabId);
    await persist();
    announce({
      kind: 'removed',
      tabId,
      previous: current,
      current: undefined,
      state: UNBOUND_STATE,
      reason: REASON_UNBOUND,
      cause,
    });
    logger.info('Tab unbound', { tabId, sessionId: current.sessionId, cause });
    return current;
  }

  /** Unbind the tab holding an ended session, and forget its departures. */
  async function endSessionLocked(sessionId: SessionId): Promise<TabBindingRecord | undefined> {
    if (!isNonEmptyString(sessionId)) {
      return undefined;
    }
    await ensureHydrated();
    for (const [tabId, state] of [...departures]) {
      if (state.kind === 'tab-left' && state.sessionId === sessionId) {
        departures.delete(tabId);
      }
    }
    const holder = findBySession(sessionId);
    if (holder === undefined) {
      logger.debug('Session ended with no bound tab', { sessionId });
      return undefined;
    }
    return unbindLocked(holder.tabId, CAUSE_SESSION_ENDED);
  }

  /*
   * ---- capture bookkeeping ----
   */

  /**
   * Store a capture id on a bound tab. Runs inside the queue. The id is held
   * to the `capture.started` schema hydration applies, so the record written
   * here is one the next generation accepts.
   */
  async function setCaptureLocked(tabId: TabId, captureId: CaptureId): Promise<boolean> {
    if (!isTabId(tabId) || !isCaptureId(captureId)) {
      logger.debug('Capture id not stored: not a valid tab id and capture id', {
        tabId: isTabId(tabId) ? tabId : undefined,
      });
      return false;
    }
    await ensureHydrated();
    const current = cache.get(tabId);
    if (current === undefined) {
      logger.debug('Capture id not stored: the tab is not bound', { tabId });
      return false;
    }
    if (current.captureId === captureId) {
      return true;
    }
    const record = makeRecord({ ...fieldsOf(current), captureId });
    cache.set(tabId, record);
    await persist();
    announce(
      {
        kind: 'updated',
        tabId,
        previous: current,
        current: record,
        state: boundState(record),
        reason: REASON_BOUND,
        cause: undefined,
      },
      false,
    );
    logger.debug('Capture id stored on the bound tab', {
      tabId,
      sessionId: record.sessionId,
      captureId,
    });
    return true;
  }

  /** Clear a bound tab's capture id (only `captureId`, when given). Runs inside the queue. */
  async function clearCaptureLocked(tabId: TabId, captureId?: CaptureId): Promise<boolean> {
    if (!isTabId(tabId)) {
      return false;
    }
    await ensureHydrated();
    const current = cache.get(tabId);
    if (current?.captureId === undefined) {
      return false;
    }
    if (captureId !== undefined && current.captureId !== captureId) {
      logger.debug('Capture id kept: a different capture is stored on the tab', { tabId });
      return false;
    }
    const record = makeRecord({ ...fieldsOf(current), captureId: undefined });
    cache.set(tabId, record);
    await persist();
    announce(
      {
        kind: 'updated',
        tabId,
        previous: current,
        current: record,
        state: boundState(record),
        reason: REASON_BOUND,
        cause: undefined,
      },
      false,
    );
    logger.debug('Capture id cleared from the bound tab', {
      tabId,
      sessionId: record.sessionId,
      captureId: current.captureId,
    });
    return true;
  }

  /*
   * ---- the public surface: every member runs on the queue ----
   */

  const reload = (): Promise<readonly TabBindingRecord[]> =>
    exclusive(async () => {
      await hydrate(true);
      return sortRecords(cache.values());
    });

  const requestBind = (request: TabBindRequest): Promise<Result<SendOutcome, DebuggenError>> =>
    exclusive(async (): Promise<Result<SendOutcome, DebuggenError>> => {
      const { tabId, url, origin, sessionId } = request;
      const candidate: SessionBindPayload =
        sessionId === undefined ? { tabId, url, origin } : { tabId, url, origin, sessionId };
      const parsed = parseSessionBindPayload(candidate);
      if (!parsed.ok) {
        logger.warn('Refused to request a binding: not a valid session.bind payload', {
          tabId: isTabId(tabId) ? tabId : undefined,
          code: parsed.error.code,
        });
        return err(parsed.error);
      }
      await ensureHydrated();
      const bindTabId = parsed.value.tabId;
      if (!holdsSlot(bindTabId) && !hasFreeSlot()) {
        // Refused before anything is sent: a bind the service may apply needs
        // a slot to land in, and making one here would mean forgetting an
        // obligation some other tab holds.
        logger.warn('Refused to request a binding: every slot is held', {
          tabId: bindTabId,
          slots: slotsInUse(),
          limit: MAX_STORED_TAB_BINDINGS,
        });
        return err(
          workerError(
            'RATE_LIMITED',
            `The worker already tracks ${String(MAX_STORED_TAB_BINDINGS)} tabs that are bound, or being bound or unbound, so no binding was requested for this one. Close DevTools on tabs no longer being debugged, then try again.`,
          ),
        );
      }
      const owed = tombstones.get(bindTabId);
      if (owed !== undefined) {
        // The owed unbind leaves first, so on the FIFO transport the service
        // ends the stale binding before it considers this bind. The tombstone
        // stays: only a confirmed bind (`establish`) supersedes it.
        const unbindPayload: SessionUnbindPayload = { tabId: bindTabId };
        const unbound = report(MESSAGE_TYPE.SESSION_UNBIND, unbindPayload, {
          tabId: bindTabId,
          sessionId: owed.sessionId,
          cause: owed.cause,
          deliveries: owed.deliveries,
          aheadOf: MESSAGE_TYPE.SESSION_BIND,
        });
        if (!unbound.ok) {
          // Sent alone, the bind would not be ordered behind the unbind. The
          // tombstone stays flushable, and the panel's next bind retries both.
          logger.debug('session.bind withheld: the unbind owed ahead of it was not sent', {
            tabId: bindTabId,
            code: unbound.error.code,
          });
          return unbound;
        }
        if (countDelivery(owed, unbound) !== 'unchanged') {
          await writeTombstones();
        }
      }
      const outcome = report(MESSAGE_TYPE.SESSION_BIND, parsed.value, {
        tabId: bindTabId,
        origin: parsed.value.origin,
        sessionId: parsed.value.sessionId,
      });
      if (outcome.ok) {
        // The bind is in flight: its tab holds a slot until the confirmation
        // lands in it or an unbind of the tab ends it.
        reservedBindTabs.add(bindTabId);
      }
      // A bind now pending holds back this generation's flushes of the tab's
      // tombstone — known, or possibly stored while the key is unreadable. A
      // refused bind is not pending, so nothing is held back.
      if (outcome.ok && (tombstones.has(bindTabId) || tombstoneHydration !== 'hydrated')) {
        pendingBindTabs.add(bindTabId);
        logger.debug('Unbind tombstone held back until the bind is settled', {
          tabId: bindTabId,
          outcome: outcome.value,
        });
      }
      return outcome;
    });

  const applyBound = (
    payload: SessionBoundPayload,
  ): Promise<Result<ApplyBoundOutcome, DebuggenError>> =>
    exclusive(() => {
      const parsed = parseSessionBoundPayload(payload);
      if (!parsed.ok) {
        logger.warn('Ignored an invalid session.bound payload', { code: parsed.error.code });
        return err(parsed.error);
      }
      return applyValidatedBound(parsed.value);
    });

  const handleNavigated = (navigation: TabNavigation): Promise<NavigationDecision> =>
    exclusive(() => navigate(navigation));

  const handleUnreportableNavigation = (tabId: TabId): Promise<NavigationDecision> =>
    exclusive(() => navigateUnreportable(tabId));

  const handleReturnedNavigation = (tabId: TabId, origin: string | undefined): Promise<boolean> =>
    exclusive(() => returnToOrigin(tabId, origin));

  const unbind = (tabId: TabId, cause: TabUnbindCause): Promise<TabBindingRecord | undefined> =>
    exclusive(() => {
      if (!isTabId(tabId)) {
        logger.warn('Ignored an unbind for an invalid tab id', { cause });
        return undefined;
      }
      return unbindLocked(tabId, cause);
    });

  const flushPendingUnbinds = (): Promise<number> =>
    exclusive(async () => {
      try {
        return await flushLocked();
      } catch (cause) {
        // Every step of a flush is total, so this is a defect; it is logged,
        // and the socket-open path that called it must not see a rejection.
        logger.error('Pending unbinds could not be flushed', {
          code: DebuggenError.from(cause, 'INTERNAL').code,
          pending: tombstones.size,
        });
        return 0;
      }
    });

  const handleSessionEnded = (sessionId: SessionId): Promise<TabBindingRecord | undefined> =>
    exclusive(() => endSessionLocked(sessionId));

  const handleSessionUpdated = (
    payload: SessionUpdatedPayload,
  ): Promise<TabBindingRecord | undefined> =>
    exclusive(() => {
      const session = payload.session;
      return session.status === SESSION_STATUS_ENDED ? endSessionLocked(session.id) : undefined;
    });

  const setCaptureId = (tabId: TabId, captureId: CaptureId): Promise<boolean> =>
    exclusive(() => setCaptureLocked(tabId, captureId));

  const clearCaptureId = (tabId: TabId, captureId?: CaptureId): Promise<boolean> =>
    exclusive(() => clearCaptureLocked(tabId, captureId));

  const handleCaptureStarted = (payload: CaptureStartedPayload): Promise<TabId | undefined> =>
    exclusive(async () => {
      await ensureHydrated();
      const holder = findBySession(payload.sessionId);
      if (holder === undefined) {
        logger.debug('capture.started for a session no tab holds', {
          sessionId: payload.sessionId,
        });
        return undefined;
      }
      return (await setCaptureLocked(holder.tabId, payload.captureId)) ? holder.tabId : undefined;
    });

  const handleCaptureStopped = (payload: CaptureStoppedPayload): Promise<TabId | undefined> =>
    exclusive(async () => {
      await ensureHydrated();
      const holder = findBySession(payload.sessionId);
      if (holder === undefined) {
        return undefined;
      }
      return (await clearCaptureLocked(holder.tabId, payload.captureId)) ? holder.tabId : undefined;
    });

  const getBinding = (tabId: TabId): Promise<TabBindingRecord | undefined> =>
    exclusive(async () => {
      await ensureHydrated();
      return cache.get(tabId);
    });

  const getTabForSession = (sessionId: SessionId): Promise<TabId | undefined> =>
    exclusive(async () => {
      await ensureHydrated();
      return findBySession(sessionId)?.tabId;
    });

  const listBindings = (): Promise<readonly TabBindingRecord[]> =>
    exclusive(async () => {
      await ensureHydrated();
      return sortRecords(cache.values());
    });

  const getPanelBindingState = (tabId: TabId): Promise<PanelBindingState> =>
    exclusive(async () => {
      await ensureHydrated();
      const record = cache.get(tabId);
      if (record !== undefined) {
        return boundState(record);
      }
      return departures.get(tabId) ?? UNBOUND_STATE;
    });

  const onChange = (listener: TabBindingListener): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return Object.freeze({
    reload,
    requestBind,
    applyBound,
    handleNavigated,
    handleUnreportableNavigation,
    handleReturnedNavigation,
    unbind,
    flushPendingUnbinds,
    handleSessionEnded,
    handleSessionUpdated,
    setCaptureId,
    clearCaptureId,
    handleCaptureStarted,
    handleCaptureStopped,
    getBinding,
    getTabForSession,
    listBindings,
    getPanelBindingState,
    onChange,
  });
}
