/**
 * The four messages that bind an inspected Chrome tab to a debugging session:
 * `session.bind`, `session.bound`, `tab.navigated` and `session.unbind`
 * (AAP §0.4.2).
 *
 * ## Why a binding exists at all
 *
 * Three of this product's four processes can be running several things at once —
 * the developer may have two projects open in VS Code, several localhost tabs
 * open in Chrome and a session per project in the service — so "send this to the
 * DevTools panel" is not a routable instruction on its own. The binding is what
 * makes delivery deterministic (AAP §0.2.3): once a tab is bound to a session,
 * that pairing is the single recipient of
 *
 * - `agent.config`, which arms or disarms the dormant MAIN-world telemetry agent
 *   in that tab's page,
 * - `target.request`, which asks that panel to enter element-picker mode,
 * - `telemetry.tail`, the redacted live event stream during a capture, and
 * - `panel.generated`, the validated panel specification the panel renders,
 *
 * and it is where the problem-understanding stage reads the "current URL" from
 * when the developer selected no element (AAP §0.4.2, Stage 1 inputs).
 *
 * ## The four messages, and who sends each
 *
 * | Message | Sender → receiver | Payload |
 * | --- | --- | --- |
 * | `session.bind` | DevTools panel → service | {@link sessionBindPayloadSchema} |
 * | `session.bound` | service → DevTools panel and VS Code | {@link sessionBoundPayloadSchema} |
 * | `tab.navigated` | Chrome service worker → service | {@link tabNavigatedPayloadSchema} |
 * | `session.unbind` | DevTools panel or service worker → service | {@link sessionUnbindPayloadSchema} |
 *
 * All four travel over the WebSocket transport inside the message envelope; the
 * envelope's own schema, and the discriminated union that dispatches on `type`,
 * live in `../envelope.ts`, which imports {@link BINDING_MESSAGE_PAYLOADS} from
 * here. The dependency runs that way and only that way: this module knows
 * nothing about the envelope, the HTTP routes or the client SDK.
 *
 * ## The rules this module describes but deliberately does not enforce
 *
 * The binding rules are the service's to apply — `apps/local-service`'s
 * `src/server/routes/binding.ts` and `src/sessions/manager.ts` own them — and
 * they are written out here because these payloads are meaningless without them:
 *
 * - **One tab binds to at most one session, and one session accepts one bound
 *   tab at a time.** A second `session.bind` for a session that already has a
 *   bound tab replaces the first binding, and the replacement is announced
 *   rather than applied silently: the displaced tab's panel receives a
 *   `session.bound` carrying `reason: 'replaced'` (AAP §0.2.3).
 * - **Matching.** A `session.bind` that omits `sessionId` asks the service to
 *   find the session whose dev-server origin equals the payload's `origin`; one
 *   that names a `sessionId` asks for that session, still subject to the same
 *   origin check (AAP §0.2.3).
 * - **Navigation.** On every committed navigation of a bound tab the service
 *   worker sends `tab.navigated`. Same origin keeps the binding and re-arms the
 *   statically declared `document_start` agent in the new document; a different
 *   origin drops the binding, and the panel says the tab left the origin
 *   (AAP §0.5.5). The comparison is the service's; **no schema in this module
 *   compares `url` against `origin` or against a session's dev-server origin.**
 * - **Teardown.** `session.unbind` covers the three ways a binding ends without
 *   a navigation: DevTools closed, the tab closed, or the session ended.
 * - **Authorization is expressed elsewhere.** A `devtools` credential may bind
 *   only its own tab and act only on the session bound to it, and the service
 *   records a binding against the connection's principal rather than against
 *   anything a payload claims (AAP §0.5.6). Nothing in this file grants,
 *   describes or carries a permission — a `tabId` in a payload is an identifier,
 *   never a capability.
 *
 * ## Shape of the code below
 *
 * The payloads are pure transport identifiers: a tab id, a URL, an origin, a
 * session id. They embed no upstream schema at all, which is why this module has
 * the smallest import surface in the folder — `zod`, `../version.js` for the one
 * leak-free error constructor, and `@debuggen/shared` for the `Result` pair.
 * There is nothing here to reach for a session record, a telemetry event, a plan
 * or a panel specification for, and pulling one in would put a heavyweight
 * schema behind a message whose whole job is to name a tab.
 *
 * Three package-wide disciplines apply and are visible in every declaration:
 *
 * - **Validate, never rewrite.** No `.transform()`, no `.coerce`, no
 *   `.default()` and no `.catch()`. What a producer sent is what a consumer
 *   reads, so a tab id of `'7'` is a producer bug rather than a `7` this layer
 *   invented.
 * - **Leak-free failures.** Every parse helper reports through
 *   {@link protocolParseError}, which renders a rejection from issue paths,
 *   issue codes and schema-declared metadata alone. It matters here as much as
 *   anywhere in the package: a URL carries query parameters, and a redacted URL
 *   still carries a path, so the rejected string never reaches the message, the
 *   hint or the details (AAP §0.5.2).
 * - **Environment-neutral.** No `node:*` builtin, no `@debuggen/shared/node`
 *   entry, no `ws`. The `URL` constructor used by the origin check is a global
 *   in every runtime that loads this package — Node 24, the MV3 service worker,
 *   the DevTools panel and the VS Code webview.
 *
 * Every export is named; there is no default export.
 */

import { z } from 'zod';

import { err, ok } from '@debuggen/shared';
import type { DebuggenError, Result } from '@debuggen/shared';

import { protocolParseError } from '../version.js';

// ---------------------------------------------------------------------------
// Section A — module-local bounds and field primitives
// ---------------------------------------------------------------------------

/**
 * The longest identifier these payloads accept.
 *
 * A session id minted by `newSessionId()` in `@debuggen/shared` is twenty
 * characters (`ses_` plus sixteen), so sixty-four is deliberate headroom rather
 * than a measured limit: it refuses a field carrying a document instead of an
 * id, while leaving room for an id restored from a store row written by an
 * earlier version and for the longer spellings a test fixture may use.
 */
const MAX_ID_LENGTH = 64;

/**
 * The longest URL these payloads accept.
 *
 * Two thousand and forty-eight characters is the practical ceiling browsers and
 * intermediaries have converged on, and no page URL of a local dev server comes
 * close. The bound is declared so that a malformed frame is refused on a length
 * check — and so a rejected frame cannot become a two-megabyte log line — rather
 * than because a longer URL would be meaningless.
 */
const MAX_URL_LENGTH = 2048;

/**
 * The longest serialized origin these payloads accept.
 *
 * An origin is a scheme, a host and an optional port, so it is far shorter than
 * a URL; the ceiling exists for the same reason as {@link MAX_URL_LENGTH} and is
 * checked *before* {@link isSerializedHttpOrigin} parses anything, because a
 * string check that has already failed short-circuits the refinement that
 * follows it.
 */
const MAX_ORIGIN_LENGTH = 512;

/**
 * A Chrome tab id.
 *
 * `chrome.tabs.Tab.id` is a non-negative integer for a real tab, and the
 * DevTools page reads the one it is attached to from
 * `chrome.devtools.inspectedWindow.tabId`. Three values are refused on purpose:
 *
 * - **`-1`** — `chrome.tabs.TAB_ID_NONE`, which Chrome uses for a tab that does
 *   not exist (a prerender, a devtools-only target). A binding to it could never
 *   receive `agent.config`, so it is rejected at the schema rather than stored
 *   and puzzled over later.
 * - **A non-integer**, including `1.5` and `NaN`: a tab id is a discrete handle,
 *   and a fractional one is a producer bug.
 * - **A string**, including `'7'`. Nothing in this package coerces, so a JSON
 *   producer that stringified its numbers is told so.
 *
 * The upper bound is `Number.MAX_SAFE_INTEGER` because beyond it two distinct
 * ids can compare equal as doubles, and a registry keyed by tab id would then
 * route one tab's telemetry to another's panel.
 *
 * ## One schema for every spelling of "the tab" on the wire
 *
 * Exported because this is also the schema of the **acting tab**: the inspected
 * tab a DevTools frame or request acts for. The Chrome service worker carries
 * every inspected tab over one paired credential and one WebSocket, so the
 * service can hold a DevTools principal to "only the session bound to that tab"
 * (AAP §0.5.6) only when each frame and request says which tab it is for:
 *
 * - `../envelope.ts` declares the envelope's optional `tabId` with it, and
 *   `createEnvelope` validates its `tabId` option against it;
 * - `../http.ts` parses and formats the `x-debuggen-tab` request header
 *   (`ACTING_TAB_HEADER`) with it, so a header value is held to exactly the
 *   rules a payload's `tabId` is.
 *
 * Both import it from this module directly; the messages barrel does not
 * forward it, because it is a field primitive rather than a message payload.
 * Like every `tabId` here, the acting tab is an identifier the service checks
 * against its own live binding table, never a capability.
 */
export const tabIdSchema = z
  .number()
  .int()
  .min(0, {
    error: 'expected a non-negative Chrome tab id (-1 is chrome.tabs.TAB_ID_NONE, not a tab)',
  })
  .max(Number.MAX_SAFE_INTEGER, {
    error: 'expected a Chrome tab id within the safe-integer range',
  });

/**
 * An absolute URL, bounded in length.
 *
 * What a producer puts here is the inspected tab's **current document URL**, and
 * it arrives query-redacted: the browser agent and the service worker replace
 * each query parameter's value before a URL leaves the page, keeping the key and
 * the path (AAP §0.5.2). A redacted URL is still a valid absolute URL, which is
 * why the check is on shape alone.
 *
 * Deliberately **not** restricted to `http:` and `https:`, unlike
 * {@link originSchema}. A `tab.navigated` frame has to be able to report that
 * the tab left the application — to `about:blank`, to a `chrome://` page, to a
 * `file://` document — because that report is precisely what makes the service
 * drop the binding (AAP §0.5.5). Refusing those schemes here would turn a
 * navigation that must unbind into a frame that never validates, and the
 * binding would linger. The service reaches the same verdict either way: a URL
 * with an opaque origin cannot equal a session's dev-server origin.
 *
 * One WHATWG nuance is worth knowing before reading a rejection: a scheme-less
 * `host:port` string is a valid *absolute* URL, because the parser reads the
 * host as the scheme — so a producer that sent a URL without its scheme is
 * accepted here and resolves to an opaque origin downstream, where the
 * service's comparison answers "different origin". That is the same verdict a
 * rejection would have produced for a binding, and it is why the shape check is
 * not tightened into a scheme allow-list that would then have to enumerate
 * every scheme a tab can navigate to.
 *
 * Consumers treat this value as text — a status line, an event-log entry, the
 * input the service parses an origin out of — and never as something to
 * navigate to.
 */
const urlSchema = z
  .url({
    error: 'expected an absolute URL',
  })
  .max(MAX_URL_LENGTH, {
    error: 'expected an absolute URL of at most 2048 characters',
  });

/**
 * Whether a string is a **serialized origin** over HTTP or HTTPS.
 *
 * The WHATWG serialization of a tuple origin is `scheme://host[:port]` with no
 * path, no query, no fragment, no credentials and no trailing slash, and with
 * the scheme and host lowercased and a default port omitted. Comparing the
 * parsed value's own `origin` with the input is what enforces every one of those
 * properties at once, without a regular expression that would have to
 * re-implement host and IPv6 parsing:
 *
 * ```text
 * accepted   http://localhost:3000        https://dev.example.test
 *            http://[::1]:5173            http://example.test
 * rejected   http://localhost:3000/       (trailing slash)
 *            http://localhost:3000/app    (path)
 *            http://localhost:3000?x=1    (query)
 *            HTTP://Example.test          (not the canonical spelling)
 *            https://example.test:443     (default port is not serialized)
 *            ws://example.test:1234       (not an HTTP origin)
 *            about:blank, file:///x       (opaque origin)
 * ```
 *
 * A URL carrying credentials in its authority — a `userinfo@` prefix before the
 * host — is refused by the same rule, because the parser drops the credentials
 * from the serialized origin and the result no longer equals the input. No
 * example of that spelling is written here: this repository's secret scanner
 * treats any committed URL with an embedded password as a finding, and a
 * documentation example is not worth an exception in the gate.
 *
 * Requiring the canonical spelling is what lets the service decide a binding
 * with a string comparison: an origin that has exactly one spelling can be
 * matched against a session's dev-server origin without normalising either side,
 * and `chrome.runtime`'s and `URL`'s own serializations already produce it —
 * every producer of this field computes it as `new URL(tabUrl).origin`.
 *
 * The scheme restriction is a **generic** constraint on documents, not on any
 * project: a page that a session can bind to is served over HTTP or HTTPS,
 * whatever host and port the developer's dev server listens on. No host, port or
 * route of any particular application appears anywhere in this module
 * (AAP §0.5.4); the examples above name reserved test domains and nothing else.
 *
 * Total by construction: the `URL` constructor is the only thing here that can
 * throw, and its rejection is the answer this predicate returns.
 */
function isSerializedHttpOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);

    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === value;
  } catch {
    return false;
  }
}

/**
 * A serialized HTTP or HTTPS origin, bounded in length.
 *
 * The length bound is checked first and short-circuits the refinement, so an
 * oversized string is refused without being parsed. The refinement's failure is
 * a `custom` issue carrying `label: 'serialized-origin'`, which
 * `describeZodIssues` renders as `origin (custom label=serialized-origin)` — the
 * shape that was expected, never the string that arrived.
 *
 * @see {@link isSerializedHttpOrigin} for what the shape is, and why the
 * canonical spelling is required.
 */
const originSchema = z
  .string()
  .max(MAX_ORIGIN_LENGTH, {
    error: 'expected a serialized origin of at most 512 characters',
  })
  .refine(isSerializedHttpOrigin, {
    error:
      'expected a serialized HTTP or HTTPS origin: scheme, host and optional non-default port, with no path, query, fragment, credentials or trailing slash',
    params: { label: 'serialized-origin' },
  });

/**
 * An opaque identifier as it appears on the wire: non-empty and bounded.
 *
 * Shape only, and that is the point. `@debuggen/shared` owns how an id is
 * *minted* — `newSessionId()` and the three-letter `ID_PREFIXES` vocabulary
 * behind it — and its pattern is deliberately **not** restated here: a transport
 * schema that demanded `ses_[0-9a-z]{16}` would refuse an id read back from a
 * store row written before that vocabulary existed, an id from a fixture, and an
 * id a future prefix admits, turning a naming decision in one package into a
 * wire-compatibility break in another. What the transport genuinely needs is
 * that the field is a usable key: present, non-empty, and short enough to be a
 * store key and a log token.
 *
 * Whether a named session *exists* is the service's answer, not a schema's; a
 * syntactically valid id for a session that ended is a `SESSION_NOT_FOUND`, not
 * a `PROTOCOL_INVALID_MESSAGE`.
 */
const idSchema = z
  .string()
  .min(1, {
    error: 'expected a non-empty id',
  })
  .max(MAX_ID_LENGTH, {
    error: 'expected an id of at most 64 characters',
  });

// ---------------------------------------------------------------------------
// Section B — the binding-reason vocabulary
// ---------------------------------------------------------------------------

/**
 * Why a `session.bound` frame was sent: the closed vocabulary of binding
 * transitions.
 *
 * `session.bound` does triple duty — it announces that a binding was
 * established, that one was replaced, and that one was dropped (AAP §0.4.2:
 * "also emitted when a binding is replaced or dropped with `reason`") — because
 * both user interfaces render **one** status line from it: the DevTools panel's
 * connection pill and the VS Code view's session header. A single message type
 * with a closed reason is what lets each of them switch exhaustively over the
 * possibilities instead of parsing prose, and what makes a new transition a
 * compile error in both surfaces rather than an unhandled string.
 *
 * Each member and the cause the AAP gives it:
 *
 * - **`bound`** — a new binding was established: the panel sent `session.bind`
 *   and the service matched the tab to a session, by the payload's `sessionId`
 *   or by dev-server origin (AAP §0.2.3).
 * - **`replaced`** — a second bind took this session's place as the bound tab.
 *   One session accepts one bound tab at a time and "a second bind replaces the
 *   first and is announced" (AAP §0.2.3), so the displaced panel is told rather
 *   than left showing a binding it no longer has.
 * - **`navigated`** — the bound tab committed a **same-origin** navigation. The
 *   binding was kept and the statically declared `document_start` agent in the
 *   new document was re-armed (AAP §0.5.5); the `url` on the frame is the new
 *   document's.
 * - **`origin-changed`** — the bound tab navigated to a **different** origin, so
 *   the binding was dropped and the panel reports that the tab left the origin
 *   (AAP §0.5.5).
 * - **`unbound`** — the binding ended without a navigation: DevTools closed, the
 *   tab closed, or the session ended (AAP §0.4.2, the three causes of
 *   `session.unbind`).
 *
 * The order is the lifecycle's — establish, replace, keep, drop, end — and is
 * preserved rather than sorted, so the tuple reads as the state transitions it
 * enumerates. Frozen because it is a module-level table consulted on every
 * validation: mutating it would widen or narrow what every process accepts.
 */
export const BINDING_REASONS = Object.freeze([
  'bound',
  'replaced',
  'navigated',
  'origin-changed',
  'unbound',
] as const);

/**
 * One member of the closed {@link BINDING_REASONS} vocabulary.
 *
 * Derived from the tuple rather than declared beside it, so values and type
 * cannot drift: adding a reason widens this union in the same edit, and every
 * consumer that switches exhaustively over it — the panel's status pill, the VS
 * Code session header, the service's binding registry — stops compiling until it
 * says something about the new case.
 */
export type BindingReason = (typeof BINDING_REASONS)[number];

/**
 * The validator for a single {@link BindingReason}.
 *
 * Built from {@link BINDING_REASONS}, so the accepted set and the documented set
 * are the same set. Exported on its own because a consumer occasionally needs
 * the field validator without the whole payload — a binding state read back out
 * of the Chrome service worker's `chrome.storage.session` registry, for
 * instance, where anything that outlived a worker suspension has to be
 * re-validated before it is trusted.
 */
export const bindingReasonSchema = z.enum(BINDING_REASONS);

// ---------------------------------------------------------------------------
// Section C — payload schemas
// ---------------------------------------------------------------------------

/**
 * `session.bind` — the DevTools panel asks the service to bind its inspected tab
 * to a session (AAP §0.4.2).
 *
 * Sent when the panel opens, and again after the panel reconnects to a service
 * that restarted. The panel knows its tab from
 * `chrome.devtools.inspectedWindow.tabId` and the document from an
 * `inspectedWindow.eval`, so every field here is something the panel observed
 * rather than something it chose.
 *
 * `sessionId` is what distinguishes the two ways of asking, and the difference
 * is the developer's intent rather than a fallback:
 *
 * - **omitted** — "bind me to whichever session belongs to this origin". The
 *   service matches the payload's `origin` against each session's dev-server
 *   origin (AAP §0.2.3). This is the ordinary path: the developer started a
 *   session in VS Code and then opened DevTools on the app.
 * - **present** — "bind me to this session". The service still checks the origin
 *   before accepting, so naming a session does not override the match; it
 *   disambiguates when several sessions could claim the tab, which is what the
 *   Sessions tree's reopen flow needs (AAP §0.2.3).
 *
 * Strict: an unrecognised key is a rejection, never a field to ignore. A
 * misspelled `sessionID` has to fail loudly, because silently dropping it turns
 * "bind me to this session" into "bind me to any session on this origin" — a
 * different request with a plausible-looking outcome.
 */
export const sessionBindPayloadSchema = z.strictObject({
  /** The inspected tab, from `chrome.devtools.inspectedWindow.tabId`. */
  tabId: tabIdSchema,
  /** The tab's current document URL, query-redacted (AAP §0.5.2). */
  url: urlSchema,
  /**
   * That URL's serialized origin, which the service matches against each
   * session's dev-server origin. Carried explicitly rather than derived from
   * `url` by the service so that the producer's own notion of the tab's origin
   * is what is matched, and so a disagreement between the two is visible to the
   * service instead of being smoothed over.
   */
  origin: originSchema,
  /**
   * The session the panel is asking for, when it is asking for one in
   * particular. Absent means "match by origin".
   */
  sessionId: idSchema.optional(),
});

/**
 * A validated `session.bind` payload.
 *
 * `sessionId` is optional in the inferred type exactly as it is in the schema,
 * and under `exactOptionalPropertyTypes` that distinction is real: a producer
 * that means "match by origin" omits the key rather than sending `undefined`.
 */
export type SessionBindPayload = z.infer<typeof sessionBindPayloadSchema>;

/**
 * `session.bound` — the service announces the state of a binding to the DevTools
 * panel and to VS Code (AAP §0.4.2).
 *
 * The one frame that reports every binding transition, distinguished by
 * {@link BindingReason}: establishment, replacement of a previous binding, a
 * same-origin navigation that kept it, an origin change that dropped it, and an
 * unbind. The fields mean the same thing in all five cases — the session the tab
 * is (or was) bound to, the tab, and the document URL the announcement is about
 * — so both surfaces render one status line from one handler.
 *
 * `sessionId` is on the payload even though the envelope already carries a
 * `sessionId` for routing, and that is deliberate: the envelope's copy tells the
 * transport where to deliver the frame, while this one is the value the panel
 * **stores** as the session it is now bound to, and the value VS Code matches
 * against the session it is showing. A panel that read its identity out of an
 * envelope field would have nothing to keep once the frame was dispatched.
 *
 * `reason` is optional because AAP §0.4.2's base payload is
 * `{ sessionId, tabId, url }` and the reason is what it adds for a replacement
 * or a drop: a frame without one is an establishment. A consumer therefore reads
 * an absent reason as `'bound'`, and it does so where the value is used rather
 * than here — this package validates without rewriting, so no `.default()`
 * invents a field the producer did not send.
 */
export const sessionBoundPayloadSchema = z.strictObject({
  /** The session the tab is, or was, bound to. */
  sessionId: idSchema,
  /** The bound tab. */
  tabId: tabIdSchema,
  /**
   * The document URL this announcement is about: the bound document for
   * `'bound'` and `'replaced'`, the new document for `'navigated'` and
   * `'origin-changed'`, and the last known document for `'unbound'`.
   */
  url: urlSchema,
  /**
   * Which transition is being announced. Absent means an establishment; see
   * {@link BINDING_REASONS} for what each member means.
   */
  reason: bindingReasonSchema.optional(),
});

/**
 * A validated `session.bound` payload.
 *
 * The shape both user interfaces render their binding status from, and the shape
 * the DevTools panel persists as its own session identity.
 */
export type SessionBoundPayload = z.infer<typeof sessionBoundPayloadSchema>;

/**
 * `tab.navigated` — the Chrome service worker reports a committed navigation of
 * a tab it is tracking (AAP §0.4.2).
 *
 * Sent on **committed** navigations, not on requested ones, so the URL is the
 * document that actually loaded. What the service does with it is a comparison
 * this module does not perform: it reads the origin of `url`, compares it with
 * the bound session's dev-server origin, and either keeps the binding and
 * re-sends `agent.config` to re-arm the agent in the new document, or drops the
 * binding and tells the panel the tab left the origin (AAP §0.5.5). Both
 * outcomes are announced with a `session.bound` frame carrying `'navigated'` or
 * `'origin-changed'`.
 *
 * No `origin` field, and no `sessionId`. The origin is derivable from `url` by
 * the party that owns the comparison, and adding a second copy would create a
 * disagreement to arbitrate; the session is the one the service already has
 * bound to `tabId`, and a service worker reporting a navigation is in no
 * position to assert which session that is. A navigation of a tab that is not
 * bound is not an error — the service worker reports what it observes, and the
 * service ignores what it does not track.
 */
export const tabNavigatedPayloadSchema = z.strictObject({
  /** The tab that navigated. */
  tabId: tabIdSchema,
  /**
   * The URL of the document that committed, query-redacted. Any absolute URL,
   * including one with an opaque origin: a navigation away from the application
   * is exactly what has to be reportable here (see {@link urlSchema}).
   */
  url: urlSchema,
});

/**
 * A validated `tab.navigated` payload.
 *
 * Consumed by the service's binding route, which turns it into either a re-arm
 * or an unbind.
 */
export type TabNavigatedPayload = z.infer<typeof tabNavigatedPayloadSchema>;

/**
 * `session.unbind` — the DevTools panel or the Chrome service worker reports
 * that a binding has ended (AAP §0.4.2).
 *
 * Three causes, one message: DevTools closed, the tab closed, or the session
 * ended. The tab id alone is enough for all three, because the service holds the
 * tab → session mapping and both senders are reporting a fact about a tab rather
 * than making a request about a session. Keeping the payload this narrow also
 * keeps the frame sendable from a service worker that is being torn down, where
 * reading anything more is a race.
 *
 * Idempotent by design: unbinding a tab that is not bound is a no-op, not an
 * error, so the panel and the service worker may both report the same closure
 * without coordinating. Whether the announcement that follows carries
 * `reason: 'unbound'` is the service's call — the sender of this frame does not
 * assert a reason, because "DevTools closed" and "the session ended" are the
 * same observation from a tab's point of view.
 */
export const sessionUnbindPayloadSchema = z.strictObject({
  /** The tab whose binding has ended. */
  tabId: tabIdSchema,
});

/**
 * A validated `session.unbind` payload.
 *
 * A single tab id; the service resolves it to the binding it holds.
 */
export type SessionUnbindPayload = z.infer<typeof sessionUnbindPayloadSchema>;

// ---------------------------------------------------------------------------
// Section D — parse helpers
// ---------------------------------------------------------------------------

/**
 * The developer-facing next step attached to a rejected `session.bind`.
 *
 * Each hint below is a constant sentence about the **schema**, never about the
 * value that failed it, so a hint is safe to log, to persist with a session and
 * to forward to another process: `DebuggenError.toPayload()` carries `hint`
 * verbatim across the wire (AAP §0.5.2).
 */
const BIND_HINT =
  'A session.bind payload carries the inspected tab id, its current document URL, that URL’s serialized origin (scheme, host and optional non-default port), and optionally the session id to bind to.';

/** The hint attached to a rejected `session.bound`. See {@link BIND_HINT}. */
const BOUND_HINT =
  'A session.bound payload carries the session id, the bound tab id, the document URL, and optionally the reason for the announcement (bound, replaced, navigated, origin-changed or unbound).';

/** The hint attached to a rejected `tab.navigated`. See {@link BIND_HINT}. */
const NAVIGATED_HINT =
  'A tab.navigated payload carries the tab id and the absolute URL of the document that committed.';

/** The hint attached to a rejected `session.unbind`. See {@link BIND_HINT}. */
const UNBIND_HINT = 'A session.unbind payload carries the tab id whose binding has ended.';

/**
 * Validates an unknown value as a {@link SessionBindPayload}, without throwing.
 *
 * This is how a frame that arrived from the DevTools panel becomes a typed
 * value in the service's binding route. The failure is a `DebuggenError` with
 * code `'PROTOCOL_INVALID_MESSAGE'`, built by {@link protocolParseError}: the
 * message names the field paths and the issue codes, and the rejected URL,
 * origin, tab id or session id appears in none of the message, the hint or the
 * details.
 *
 * @param value Any value believed to be a `session.bind` payload.
 * @returns `ok(payload)` with the validated payload, or `err(error)` describing
 * the shape of every issue found.
 *
 * @example
 * ```ts
 * const parsed = parseSessionBindPayload(frame.payload);
 * if (!parsed.ok) {
 *   send(errorMessage(parsed.error));
 *   return;
 * }
 * bindTab(principal, parsed.value);
 * ```
 */
export function parseSessionBindPayload(value: unknown): Result<SessionBindPayload, DebuggenError> {
  const parsed = sessionBindPayloadSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid session.bind payload',
      parsed.error.issues,
      BIND_HINT,
    ),
  );
}

/**
 * Validates an unknown value as a {@link SessionBoundPayload}, without throwing.
 *
 * Used on the receiving side rather than the sending one: the DevTools panel and
 * the VS Code webview both validate what arrived before they store a session
 * identity or redraw a status line, so a service that regressed cannot put an
 * unparseable binding into a user interface's state. The same privacy
 * discipline as {@link parseSessionBindPayload} applies to the error it returns.
 *
 * @param value Any value believed to be a `session.bound` payload.
 * @returns `ok(payload)` with the validated payload, or `err(error)` describing
 * the shape of every issue found.
 */
export function parseSessionBoundPayload(
  value: unknown,
): Result<SessionBoundPayload, DebuggenError> {
  const parsed = sessionBoundPayloadSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid session.bound payload',
      parsed.error.issues,
      BOUND_HINT,
    ),
  );
}

/**
 * Validates an unknown value as a {@link TabNavigatedPayload}, without throwing.
 *
 * Applied to every navigation report the Chrome service worker sends. A
 * rejection here is worth surfacing rather than swallowing: a navigation that
 * cannot be parsed is a navigation whose origin was never compared, which means
 * a binding that was neither re-armed nor dropped.
 *
 * @param value Any value believed to be a `tab.navigated` payload.
 * @returns `ok(payload)` with the validated payload, or `err(error)` describing
 * the shape of every issue found.
 */
export function parseTabNavigatedPayload(
  value: unknown,
): Result<TabNavigatedPayload, DebuggenError> {
  const parsed = tabNavigatedPayloadSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid tab.navigated payload',
      parsed.error.issues,
      NAVIGATED_HINT,
    ),
  );
}

/**
 * Validates an unknown value as a {@link SessionUnbindPayload}, without
 * throwing.
 *
 * The narrowest of the four, and the one most likely to arrive from a context
 * that is shutting down — a DevTools window closing, a service worker
 * suspending — which is why it is validated like the rest instead of being
 * trusted for its simplicity.
 *
 * @param value Any value believed to be a `session.unbind` payload.
 * @returns `ok(payload)` with the validated payload, or `err(error)` describing
 * the shape of every issue found.
 */
export function parseSessionUnbindPayload(
  value: unknown,
): Result<SessionUnbindPayload, DebuggenError> {
  const parsed = sessionUnbindPayloadSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid session.unbind payload',
      parsed.error.issues,
      UNBIND_HINT,
    ),
  );
}

// ---------------------------------------------------------------------------
// Section E — the registry this module contributes to the envelope
// ---------------------------------------------------------------------------

/**
 * The binding messages, keyed by the message `type` that carries each payload.
 *
 * The keys are the protocol's own names, verbatim from AAP §0.4.2:
 * `session.bind`, `session.bound`, `tab.navigated` and `session.unbind`. They
 * are the strings on the wire, so they are written out here rather than
 * assembled from parts — a name a reader can grep for across the four processes
 * is worth more than a clever construction.
 *
 * `../envelope.ts` composes this object with the equivalent registry from every
 * other module in this folder to build the discriminated union that dispatches
 * on `type`; nothing in this module knows how that composition works, which is
 * what keeps the dependency one-directional. A consumer that already knows which
 * message it is holding reaches for the schema or the parse helper directly —
 * this registry is for the dispatcher, not a substitute for the named exports.
 *
 * Frozen, and `as const` so each key maps to its own schema type rather than to
 * a union of the four: a lookup on a literal key gives the exact schema, and the
 * object cannot be extended at runtime by a consumer that would rather add a
 * message than declare one.
 */
export const BINDING_MESSAGE_PAYLOADS = Object.freeze({
  'session.bind': sessionBindPayloadSchema,
  'session.bound': sessionBoundPayloadSchema,
  'tab.navigated': tabNavigatedPayloadSchema,
  'session.unbind': sessionUnbindPayloadSchema,
} as const);
