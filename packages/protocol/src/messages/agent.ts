/**
 * The handshake, the connection's liveness pair, the page agent's lifecycle and
 * the two arming frames: `client.hello`, `client.ping`, `service.pong`,
 * `agent.ready`, `agent.config` and `server-agent.config`,
 * together with the WebSocket transport constants of the local service's access
 * boundary.
 *
 * ## Why these six messages share a module
 *
 * They are the frames that turn a socket into a participant and keep it one.
 * Everything else in this folder assumes a connection that has already
 * announced itself, is still answering, and a runtime that has already been
 * armed; these six establish exactly that, in order:
 *
 * | Message | Sender → receiver | Payload |
 * | --- | --- | --- |
 * | `client.hello` | any client → service | {@link clientHelloPayloadSchema} |
 * | `client.ping` | any authenticated client → service | {@link clientPingPayloadSchema} |
 * | `service.pong` | service → the pinging client alone | {@link servicePongPayloadSchema} |
 * | `agent.ready` | page agent → bridge → service worker → service | {@link agentReadyPayloadSchema} |
 * | `agent.config` | service → page agent, via the service worker | {@link agentConfigPayloadSchema} |
 * | `server-agent.config` | service → dev-server Node preload | {@link serverAgentConfigPayloadSchema} |
 *
 * All six travel over the WebSocket transport inside the message envelope,
 * whose schema and `type`-discriminated union live in `../envelope.ts` — that
 * module imports {@link AGENT_MESSAGE_PAYLOADS} from here, and the dependency
 * runs that way and only that way. This module knows nothing about the
 * envelope, the HTTP routes or the client SDK.
 *
 * ## The one module that carries a credential
 *
 * `client.hello` carries the bearer token every connection is authenticated by
 * (AAP §0.5.6), which makes the package-wide privacy rule (AAP §0.5.2) sharper
 * here than anywhere else in this folder. Three consequences are visible in the
 * code below and are not negotiable:
 *
 * - **Nothing echoes the token.** Every failure is reported through
 *   {@link protocolParseError}, which renders a rejection from issue paths,
 *   issue codes and schema-declared metadata alone. No `error` option in this
 *   module is a function of the rejected input; each is a constant sentence
 *   about the schema, so Zod has nothing to interpolate. A rejected
 *   `client.hello` therefore says `token (too_big origin=string max=512)` and
 *   never what arrived.
 * - **No helper here reads, compares, hashes or logs a credential.** Resolving
 *   a presented token to a role and a scope is `apps/local-service`'s
 *   (`src/server/auth.ts`), against the `credentials` table that stores only
 *   hashes.
 * - **The token is bounded, not patterned.** {@link tokenSchema} checks length
 *   and nothing else: guessing at a credential's spelling would refuse a
 *   rotated format while rejecting nothing an attacker could not adjust.
 *
 * ## What this module documents but deliberately does not implement
 *
 * These payloads are meaningless without the rules that surround them, and the
 * rules belong to the processes that apply them:
 *
 * - **The handshake deadline.** `client.hello` is the **first** frame after the
 *   upgrade and must arrive within {@link CLIENT_HELLO_TIMEOUT_MS}; a
 *   connection that is late, silent or refused is closed with
 *   {@link WS_CLOSE_UNAUTHORIZED} (AAP §0.4.2, §0.5.6). The timer and the close
 *   are the service's; a producer may hold itself to a tighter send deadline
 *   than the service's close window, and several do.
 * - **`client` is a claim, never a capability.** The service derives role and
 *   scope from the presented credential and never from a client's
 *   self-description (AAP §0.5.6), so {@link ClientKind} shapes routing and
 *   attribution only. **No field in this module grants, describes or carries a
 *   permission**, and no authorization decision is expressed here.
 * - **Version compatibility.** The `version` field is validated for shape by
 *   `protocolVersionSchema`; whether a claimed version may talk to this build
 *   is `isCompatibleProtocolVersion`'s answer, applied by the service on the
 *   handshake path. Both live in `../version.js`.
 * - **Dormancy.** An `agent.config` whose hooks are all false returns the
 *   browser agent to dormant — listeners detached, the `fetch`/`XMLHttpRequest`
 *   patch restored, fiber-hook handlers unsubscribed — and a
 *   `server-agent.config` without a `captureId` makes the Node preload disable
 *   its instrumentations and drop the global tracer provider, leaving the module
 *   loaded but inert (AAP §0.5.1). Those are behaviours of
 *   `packages/telemetry`, described here because the frames are how they are
 *   asked for. `DORMANT_AGENT_HOOK_CONFIG` and `DISABLED_SERVER_AGENT_SIGNALS`
 *   in `@debuggen/instrumentation` are the canonical values, so no caller
 *   hand-writes one.
 * - **Readiness and the consented reload.** `agent.ready`'s
 *   `installedBeforeReact` is what the readiness gate reads
 *   (`apps/local-service/src/instrumentation/readiness.ts`); when it is false
 *   the Chrome service worker offers a consented `chrome.tabs.reload`
 *   (AAP §0.5.5). The boolean is reported here; the decision is made there.
 * - **Binding.** Which tab is bound to which session, and what a navigation
 *   does to that binding, is `./binding.ts`'s vocabulary. This module names a
 *   tab; it never compares an origin.
 * - **Liveness.** `client.ping` is the one client frame with no effect: the
 *   service answers it, on arrival and in the connection's own frame order,
 *   with a `service.pong` to the sender alone whose `ref` is the ping's
 *   envelope `id`, whatever the sender's role. It exists because the
 *   WebSocket protocol's own ping and pong are control frames a browser
 *   script never sees, so a client whose platform hides them — the MV3
 *   service worker — has no other way to prove that *this socket* still
 *   reaches a live service. How long a client waits for the answer is
 *   {@link SERVICE_PONG_TIMEOUT_MS}; what it does about a missed one is the
 *   client's decision.
 *
 * ## The two embedded configuration schemas
 *
 * `agent.config.hooks` and `server-agent.config.signals` are **imported**, from
 * `@debuggen/instrumentation` — which is where the hook and signal vocabularies
 * live, next to the derivations that build them from an installed plan, and
 * *not* in `@debuggen/telemetry`, which is the natural but wrong guess. Neither
 * shape is restated here, for the reason AAP §0.2.3 gives: "Types that cross a
 * process boundary are defined exactly once… Any second definition of these
 * shapes in an app is a defect." The practical stake is desynchronisation — a
 * hook added upstream propagates into this message for free, whereas a restated
 * copy would keep validating the old seven keys while the agent attached eight.
 *
 * ## Package-wide disciplines, visible in every declaration below
 *
 * - **Validate, never rewrite.** No `.transform()`, no `.coerce`, no
 *   `.default()`, no `.catch()`. What a producer sent is what a consumer reads,
 *   so a tab id of `'7'` is a producer bug rather than a `7` this layer
 *   invented, and an omitted `captureId` stays omitted rather than becoming a
 *   plausible-looking value.
 * - **Strict objects.** Every payload is a `z.strictObject`: an unrecognised key
 *   is a rejection, never a field to ignore. A misspelled `captureID` that was
 *   silently dropped would turn "arm this capture" into "disable the preload",
 *   which is a different instruction with a plausible outcome.
 * - **Environment-neutral.** No `node:*` builtin, no `@debuggen/shared/node`
 *   entry, no `ws`. This module is loaded by the local service, the MV3 service
 *   worker, the DevTools panel, the VS Code extension host and its webview
 *   alike, and `packages/protocol/tsconfig.json` (`types: []`) plus
 *   `tsup.config.ts` (`platform: 'neutral'`) enforce it mechanically.
 * - **No import-time side effects.** Every export is a declaration; nothing
 *   reads an environment variable, mutates a global or performs I/O when the
 *   module loads.
 *
 * Parse helpers follow this folder's naming convention,
 * `parse<Message>Payload` — {@link parseClientHelloPayload},
 * {@link parseClientPingPayload}, {@link parseServicePongPayload},
 * {@link parseAgentReadyPayload}, {@link parseAgentConfigPayload},
 * {@link parseServerAgentConfigPayload} — and none of them throws. Every export
 * is named; there is no default export.
 */

import { z } from 'zod';

import { err, ok } from '@debuggen/shared';
import type { DebuggenError, Result } from '@debuggen/shared';
import { agentHookConfigSchema, serverAgentSignalsSchema } from '@debuggen/instrumentation/schema';

import { protocolParseError, protocolVersionSchema } from '../version.js';

// ---------------------------------------------------------------------------
// Section A — module-local bounds and field primitives
// ---------------------------------------------------------------------------

/**
 * The longest identifier these payloads accept.
 *
 * Sixty-four is the canonical figure across this folder's payload modules, so a
 * session id is bounded identically wherever it appears on the wire. A session
 * id minted by `newSessionId()` in `@debuggen/shared` is twenty characters
 * (`ses_` plus sixteen) and a capture id the same, which makes this headroom
 * rather than a measured limit: it refuses a field carrying a document instead
 * of an id, while leaving room for an id read back from a store row written by
 * an earlier build, an id from a fixture, and Chrome's own longer per-document
 * identifier.
 */
const MAX_ID_LENGTH = 64;

/**
 * The longest URL these payloads accept.
 *
 * Two thousand and forty-eight characters is the ceiling browsers and
 * intermediaries have converged on, and no page URL of a local dev server comes
 * close. The bound is declared so a malformed frame is refused on a length check
 * — and so a rejected frame cannot become a two-megabyte log line — rather than
 * because a longer URL would be meaningless.
 */
const MAX_URL_LENGTH = 2048;

/**
 * The longest project root these payloads accept.
 *
 * Four thousand and ninety-six is POSIX `PATH_MAX` on Linux, the most generous
 * of the platforms this product runs on, so a legitimately deep working tree on
 * any of them fits. What the bound is for is the other case: a `projectRoot`
 * field that arrived carrying a file's contents is refused on a length check,
 * before anything reads it.
 */
const MAX_PATH_LENGTH = 4096;

/**
 * The longest credential these payloads accept.
 *
 * A credential the service mints is a 32-byte random value rendered as text
 * (AAP §0.5.6), so five hundred and twelve characters is deliberate headroom for
 * a future encoding rather than a description of today's. It is a **length check
 * and nothing more**: see {@link tokenSchema} for why this module declines to
 * describe a credential's spelling at all.
 */
const MAX_TOKEN_LENGTH = 512;

/**
 * An opaque identifier as it appears on the wire: non-empty and bounded.
 *
 * Shape only, and that is the point. `@debuggen/shared` owns how an id is
 * *minted* — `newSessionId()`, `newCaptureId()`, `newProducerId()` and the
 * three-letter `ID_PREFIXES` vocabulary behind them — and that pattern is
 * deliberately **not** restated here: a transport schema demanding
 * `ses_[0-9a-z]{16}` would refuse an id restored from an older store row, an id
 * from a fixture and an id a future prefix admits, turning a naming decision in
 * one package into a wire-compatibility break in another. What the transport
 * genuinely needs is that the field is a usable key: present, non-empty, and
 * short enough to be a store key and a log token.
 *
 * Whether a named session or capture *exists* is the service's answer, not a
 * schema's; a syntactically valid id for a capture that has stopped is a
 * `CAPTURE_NOT_ACTIVE`, not a `PROTOCOL_INVALID_MESSAGE`.
 */
const idSchema = z
  .string()
  .min(1, {
    error: 'expected a non-empty id',
  })
  .max(MAX_ID_LENGTH, {
    error: 'expected an id of at most 64 characters',
  });

/**
 * A Chrome tab id.
 *
 * `chrome.tabs.Tab.id` is a non-negative integer for a real tab, and the
 * DevTools page reads the one it is attached to from
 * `chrome.devtools.inspectedWindow.tabId`. Three values are refused on purpose:
 *
 * - **`-1`** — `chrome.tabs.TAB_ID_NONE`, the value Chrome uses for a target
 *   that is not a tab. A connection or an agent that claims a tab must name a
 *   real one: a `client.hello` carrying `-1` could never be routed a config
 *   frame, and an `agent.ready` carrying it describes a document no session can
 *   arm.
 * - **A non-integer**, including `1.5` and `NaN`: a tab id is a discrete handle,
 *   and a fractional one is a producer bug.
 * - **A string**, including `'7'`. Nothing in this package coerces, so a JSON
 *   producer that stringified its numbers is told so rather than accommodated.
 *
 * The upper bound is `Number.MAX_SAFE_INTEGER` because beyond it two distinct
 * ids can compare equal as doubles, and a registry keyed by tab id would then
 * route one tab's configuration to another's page.
 */
const tabIdSchema = z
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
 * What a producer puts here is the document URL the page agent installed into,
 * and it arrives **query-redacted**: each query parameter's value is replaced
 * before a URL leaves the page, keeping the key and the path (AAP §0.5.2). A
 * redacted URL is still a valid absolute URL, which is why the check is on shape
 * alone.
 *
 * Deliberately not narrowed to `http:` and `https:`. The scheme a session can
 * bind to is the binding module's concern and the service's decision; refusing
 * other schemes here would turn a report about an unexpected document into a
 * frame that never validates, and a page whose agent installed somewhere
 * surprising is something the service should be told about rather than deaf to.
 *
 * Consumers treat this value as text — a status line, an event-log entry, the
 * input an origin is parsed out of — and never as something to navigate to.
 */
const urlSchema = z
  .url({
    error: 'expected an absolute URL',
  })
  .max(MAX_URL_LENGTH, {
    error: 'expected an absolute URL of at most 2048 characters',
  });

/**
 * An absolute path to a project root, bounded in length.
 *
 * Shape only: non-empty and bounded. No containment or project-relative
 * refinement belongs here, and its absence is deliberate rather than an
 * oversight — this is an absolute path on the developer's own machine, so there
 * is nothing on the wire to contain it against. Containment is checked where it
 * means something: the service resolves a path and requires the result to sit
 * inside the session's `projectRoot` before it opens a file
 * (`apps/local-service/src/source/open.ts`), and the extension's URI handler
 * repeats the check against its open workspace folders independently
 * (AAP §0.2.3).
 *
 * This is the field through which a `vscode` client announces the workspace
 * scope it is acting for. AAP §0.5.6 describes the editor as announcing "the
 * workspace folders it announced in `client.hello`", and the authoritative
 * payload of AAP §0.4.2 carries a single optional `projectRoot` — so one
 * project root is what the wire contract is, and no `workspaceFolders` array is
 * invented here. The service combines what a client announces with the scope of
 * the credential it presented; the announcement alone authorises nothing.
 */
const projectRootSchema = z
  .string()
  .min(1, {
    error: 'expected a non-empty absolute project root path',
  })
  .max(MAX_PATH_LENGTH, {
    error: 'expected a project root path of at most 4096 characters',
  });

/**
 * The bearer credential a connection authenticates with.
 *
 * ⚠️ **Secret.** Never log it, never echo it, never put it in an error message,
 * a hint, a `details` field or a user-interface string (AAP §0.5.2). The whole
 * reporting path of this module is built so that following the rule takes no
 * discipline at the call site: the `error` options here are constant sentences
 * rather than functions of the input, {@link protocolParseError} renders a
 * failure from issue paths and codes, and `DebuggenError.toPayload()` carries
 * only `{ code, message, hint? }` across the wire.
 *
 * **Length and nothing else.** No prefix, no character class, no entropy test,
 * no expiry claim. Three reasons, in order of weight: the service resolves a
 * presented credential by hashing it and looking the hash up in its
 * `credentials` table (AAP §0.5.6), so a schema cannot improve on that answer; a
 * pattern here would refuse a rotated or re-encoded credential format and turn a
 * security improvement into a wire break; and a syntactic check rejects nothing
 * an attacker could not trivially satisfy, while giving a reader the false
 * impression that this schema is an authorization step. It is not — it is a
 * bound on how much text the service will consider.
 *
 * `min(1)` is still worth having: an empty string is an unauthenticated
 * connection that meant to be authenticated, and saying so at the schema is
 * clearer than a credential lookup that misses.
 */
const tokenSchema = z
  .string()
  .min(1, {
    error: 'expected a non-empty credential',
  })
  .max(MAX_TOKEN_LENGTH, {
    error: 'expected a credential of at most 512 characters',
  });

// ---------------------------------------------------------------------------
// Section B — the client vocabulary and the transport constants of the
// access boundary
// ---------------------------------------------------------------------------

/**
 * The four kinds of client that can announce themselves to the local service
 * (AAP §0.4.2, §0.5.6).
 *
 * A **claim about which process is speaking**, used for routing shape and for
 * attribution — nothing more. The service resolves what a connection may *do*
 * from the credential it presented, never from this field (AAP §0.5.6), so a
 * frame that names a kind it has no credential for is refused by the
 * authorization layer and not by this vocabulary.
 *
 * Each member and the process behind it:
 *
 * - **`vscode`** — the VS Code extension host. Announces the workspace scope it
 *   is acting for in `projectRoot`, and is the connection that receives
 *   editor-bound frames: a `source.open` to act on, progress, plans,
 *   modifications, analyses and cleanup results.
 * - **`devtools`** — the DevTools panel's side of the Chrome extension, which
 *   in practice means the MV3 service worker holding the socket on the panel's
 *   behalf. It binds its inspected tab (`./binding.ts`), relays the page
 *   agent's frames under that connection, and receives the config, the live
 *   tail and the generated panel.
 * - **`agent`** — the MAIN-world page agent. It owns no socket of its own: its
 *   frames reach the service through the isolated-world bridge and the service
 *   worker, which is why {@link agentReadyPayloadSchema} names a tab rather
 *   than relying on a connection's identity. The kind exists so a producer that
 *   *does* connect on its own behalf can say what it is, and so attribution can
 *   name the page agent as the origin of a relayed frame.
 * - **`server-agent`** — the Node preload inside the target project's dev
 *   server. Its credential is minted per launch and scoped to one project root
 *   (AAP §0.5.6), so it announces that root and nothing else; it posts telemetry
 *   and receives {@link serverAgentConfigPayloadSchema}.
 *
 * The order is the AAP's. It is preserved rather than sorted, because it is the
 * order the four processes enter the picture — editor, browser surface, page,
 * dev server — and a reader comparing this tuple against AAP §0.4.2 should find
 * the same sequence.
 */
export const CLIENT_KINDS = ['vscode', 'devtools', 'agent', 'server-agent'] as const;

/**
 * One member of the closed {@link CLIENT_KINDS} vocabulary.
 *
 * Derived from the tuple rather than declared beside it, so values and type
 * cannot drift: adding a kind widens this union in the same edit, and every
 * consumer that switches exhaustively over it — the service's client registry,
 * the panel's connection state, a test asserting what announced itself — stops
 * compiling until it says something about the new case.
 */
export type ClientKind = (typeof CLIENT_KINDS)[number];

/**
 * The validator for a single {@link ClientKind}.
 *
 * Built from {@link CLIENT_KINDS}, so the accepted set and the documented set
 * are the same set. Exported on its own because a consumer occasionally needs
 * the field validator without the whole payload — the Chrome service worker
 * re-validating a client kind it persisted in `chrome.storage.session` and read
 * back after a worker suspension, for instance.
 */
export const clientKindSchema = z.enum(CLIENT_KINDS);

/**
 * The WebSocket close code for a connection that is not, or is no longer,
 * authenticated (AAP §0.4.2, §0.5.6).
 *
 * `4401` sits in the **4000–4999 application range** the WebSocket protocol
 * reserves for private use, so it cannot collide with a protocol-defined code
 * such as `1000` (normal closure) or `1011` (internal error); the digits echo
 * HTTP's `401` deliberately, because the situations are the same one.
 *
 * The service closes with it in four situations, and all four are the same
 * refusal from a client's point of view:
 *
 * - no `client.hello` arrived within {@link CLIENT_HELLO_TIMEOUT_MS} of the
 *   upgrade,
 * - the first frame was not a well-formed `client.hello`,
 * - the credential it carried resolved to nothing, was scoped elsewhere or had
 *   expired,
 * - the credential was revoked while the connection was open — rotation closes
 *   every socket with this code (AAP §0.5.6).
 *
 * How a client should react depends on whether its credential can ever start
 * being accepted, and that is the client's judgement rather than this
 * constant's: the DevTools extension prompts the developer to pair again, while
 * a dev-server preload whose per-launch credential was refused stops instead of
 * reconnecting into a loop.
 */
export const WS_CLOSE_UNAUTHORIZED = 4401;

/**
 * How long the service waits, after the upgrade, for the `client.hello` frame
 * (AAP §0.5.6).
 *
 * Three seconds. A connection that has not announced itself by then is closed
 * with {@link WS_CLOSE_UNAUTHORIZED} — long enough that a service worker waking
 * from suspension, or a dev-server process still loading its preload, can send
 * its first frame, and short enough that an unauthenticated socket cannot sit
 * open on the developer's machine.
 *
 * This is the **service's** deadline, and it is the number a client should treat
 * as its budget rather than its target: a producer that sends its hello only as
 * this window closes has nothing left for a slow event loop, so the preload and
 * the service worker each hold themselves to a tighter send deadline of their
 * own. Neither this constant nor anything else in this module starts a timer —
 * it is declared here, with the frame it governs, so the service and every
 * client read the same figure instead of each choosing one.
 */
export const CLIENT_HELLO_TIMEOUT_MS = 3000;

/**
 * How long a client waits for the `service.pong` that answers one of its
 * `client.ping` frames before it treats the connection as dead: five seconds.
 *
 * A **client's budget**, not a service deadline. The service answers a ping as
 * soon as it reaches the head of the connection's frame queue — frames are
 * handled strictly in arrival order per connection — so the only thing between
 * a ping and its pong is the frames the same client sent before it and the
 * round trip itself. On a loopback connection to a local process both are
 * milliseconds; five seconds absorbs a service busy with a large telemetry
 * batch or a garbage-collection pause, while staying short enough that a peer
 * which vanished without a close frame (a killed process, a suspended laptop)
 * is noticed within one heartbeat interval plus this budget.
 *
 * An `error` whose `ref` names the ping is an answer too: a service built
 * before this frame existed refuses it as an unknown type under the ping's own
 * id, which proves the peer alive just as well. Nothing here starts a timer;
 * the constant is declared with the frame it governs so every client reads the
 * same figure.
 */
export const SERVICE_PONG_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Section C — payload schemas
// ---------------------------------------------------------------------------

/**
 * `client.hello` — the first frame after the WebSocket upgrade, by which a
 * client announces what it is and authenticates (AAP §0.4.2).
 *
 * Exactly five keys, strictly: the kind of client, the workspace scope it is
 * acting for where it has one, the tab it is attached to where it has one, the
 * protocol version it speaks, and its credential. A sixth key is a rejection.
 *
 * The two optional fields are optional because they are meaningful for some
 * clients and meaningless for others, not because they are best-effort:
 *
 * - `projectRoot` is what a `vscode` client and a `server-agent` credential's
 *   process announce; a DevTools connection has no project root to name, and its
 *   session's root reaches it through the binding instead.
 * - `tabId` is what a `devtools` connection announces; nothing else has a tab.
 *
 * Neither field is a permission. The service pairs what was announced with the
 * scope of the presented credential and acts on the intersection — an editor
 * credential cannot act on a project outside the workspace it announced, and
 * announcing a project it holds no credential for gains it nothing
 * (AAP §0.5.6).
 *
 * Strict for a specific reason here. A hello frame is the one frame a client
 * sends before it is known, so a misspelled field must fail loudly rather than
 * be dropped: a `projectroot` silently ignored would leave an editor connection
 * announcing no scope at all, which is a different claim with a plausible
 * outcome, and a stray key beside a credential is exactly the shape a confused
 * or hostile producer sends.
 */
export const clientHelloPayloadSchema = z.strictObject({
  /**
   * Which process is speaking. A claim used for routing shape and attribution;
   * the credential decides what it may do (AAP §0.5.6).
   */
  client: clientKindSchema,
  /**
   * The absolute path of the project this client is acting for, where it is
   * acting for one. See {@link projectRootSchema} for why no containment check
   * belongs here and why there is one root rather than a list.
   */
  projectRoot: projectRootSchema.optional(),
  /**
   * The Chrome tab this connection is attached to, where it is attached to one
   * — `chrome.devtools.inspectedWindow.tabId` for a DevTools connection.
   * `chrome.tabs.TAB_ID_NONE` (`-1`) is rejected: a connection claiming a tab
   * must name a real one.
   */
  tabId: tabIdSchema.optional(),
  /**
   * The **protocol** version this client speaks, never an npm package version.
   * Validated for shape by the schema `../version.js` owns; whether the claimed
   * version may talk to this build is `isCompatibleProtocolVersion`'s answer,
   * applied by the service on the handshake path.
   */
  version: protocolVersionSchema,
  /**
   * The bearer credential. ⚠️ Secret: never logged, never echoed, never part of
   * an error message, a hint or a `details` field (AAP §0.5.2). See
   * {@link tokenSchema}.
   */
  token: tokenSchema,
});

/**
 * A validated `client.hello` payload.
 *
 * `projectRoot` and `tabId` are optional in the inferred type exactly as they
 * are in the schema, and under `exactOptionalPropertyTypes` that distinction is
 * real: a client with no project root omits the key rather than sending
 * `undefined`.
 *
 * ⚠️ A value of this type **holds a live credential**. Treat it the way the
 * service does: read `token` once, hand it to the credential resolver, and never
 * put the object itself into a log line, a store row, a telemetry attribute or a
 * message payload. The session record persists which version and kind announced
 * themselves, never the token.
 */
export type ClientHelloPayload = z.infer<typeof clientHelloPayloadSchema>;

/**
 * `client.ping` — an authenticated client asks the service to prove that this
 * connection still reaches it.
 *
 * The payload is **empty, strictly**: the frame's envelope `id` is the
 * correlation key the answer carries back, and nothing else is needed or
 * accepted. The frame names no session, no tab and no project, so it cannot be
 * mistaken for an instruction and cannot be refused for a binding or a scope;
 * it has no effect on the service beyond the answer (the arrival of any frame
 * already refreshes the connection's last-seen time in the service's client
 * registry). Any authenticated role may send it — the editor, the DevTools
 * service worker and the dev-server preload alike — and the service answers the
 * sender alone with {@link servicePongPayloadSchema}.
 *
 * Why an application frame rather than the WebSocket protocol's own ping: the
 * service already pings every connection at the transport level, but those
 * control frames are answered by the platform and never surface to a browser
 * script, so a Manifest V3 service worker holding a socket cannot tell a live
 * connection from one whose peer vanished without a close frame. This frame is
 * the one it can see answered.
 *
 * An envelope `id` longer than a pong's `ref` may be (the envelope accepts 128
 * characters, a `ref` {@link MAX_ID_LENGTH}) cannot be answered, and the
 * service refuses such a ping with an `error` rather than leave it unanswered;
 * every id `newMessageId()` mints fits.
 */
export const clientPingPayloadSchema = z.strictObject({});

/**
 * A validated `client.ping` payload: always `{}`.
 */
export type ClientPingPayload = z.infer<typeof clientPingPayloadSchema>;

/**
 * `service.pong` — the service's answer to one `client.ping`, sent to the
 * pinging connection alone.
 *
 * One key, strictly: `ref`, the envelope `id` of the ping it answers. Required,
 * because a pong that cannot be tied to a ping settles nothing, and non-empty
 * and bounded exactly as the generic `error` frame's `ref` and the
 * `source.result` `ref` are, so one correlation rule serves every answer a
 * client may receive. The frame names no session, so no session filter holds it
 * back from the one connection it answers, whatever that connection's role, and
 * it carries nothing a client could act on beyond "the service read your ping
 * on this socket".
 *
 * A client that sends pings on a schedule settles the outstanding one on a
 * matching `ref` and ignores any other — a pong for a ping it has already
 * given up on is not evidence about the current one.
 */
export const servicePongPayloadSchema = z.strictObject({
  /**
   * The envelope `id` of the `client.ping` this answers. Bounded like every
   * correlation reference in this folder; see {@link idSchema}.
   */
  ref: z
    .string({ error: 'expected a ref string' })
    .min(1, { error: 'expected a non-empty ref' })
    .max(MAX_ID_LENGTH, {
      error: 'expected a ref of at most 64 characters',
    }),
});

/**
 * A validated `service.pong` payload.
 */
export type ServicePongPayload = z.infer<typeof servicePongPayloadSchema>;

/**
 * `agent.ready` — the MAIN-world page agent reports that it has initialised in
 * a document (AAP §0.4.2).
 *
 * Sent when the agent installs and **again after every reload**, because a
 * reload is a new document: the statically declared `document_start` content
 * script runs again, a fresh `producerId` is generated, and the sequence
 * counters that scope telemetry to a producer start over. The service uses each
 * arrival to re-arm a still-bound tab (AAP §0.5.5).
 *
 * The page agent owns no socket, so this frame is **relayed**: the agent posts
 * it to the isolated-world bridge, the bridge forwards it over its runtime port,
 * and the Chrome service worker sends it under the tab's connection
 * (AAP §0.4.2). That is why `tabId` is on the payload rather than inferred from
 * a connection — the connection belongs to the service worker, which may relay
 * for more than one document over its lifetime.
 *
 * `installedBeforeReact` and `reactDetected` are two different questions and are
 * carried separately on purpose:
 *
 * - **`installedBeforeReact`** answers "could this agent have seen the first
 *   commit?". It is what the readiness gate reads before a capture is offered,
 *   and when it is false the service worker offers a consented
 *   `chrome.tabs.reload` — a page that was already open when the extension was
 *   installed has a React runtime that loaded without the fiber hook, and no
 *   amount of waiting will produce the commits the session needs
 *   (AAP §0.5.5).
 * - **`reactDetected`** answers "is there a React runtime here at all?". False
 *   is not a failure: a page without React is a page whose interaction, network
 *   and performance signals are still worth capturing, and the difference
 *   between "no React" and "React we arrived too late for" is precisely what
 *   stops the service from asking for a reload that would change nothing.
 */
export const agentReadyPayloadSchema = z.strictObject({
  /**
   * The tab whose document the agent installed into. Carried explicitly because
   * the frame is relayed by the service worker rather than sent by the page.
   */
  tabId: tabIdSchema,
  /**
   * Chrome's per-document identifier for that document, as the service worker
   * observed it. It distinguishes two loads of the same URL in the same tab,
   * which is what makes "the agent re-installed after a reload" and "a duplicate
   * frame for the document already known" tellable apart.
   */
  documentId: idSchema,
  /**
   * The producer identity this agent will stamp on every telemetry event and
   * scope its monotonic `seq` counter to — one per page document, minted fresh
   * on each load. Structurally the bounded id shape above, which is assignable
   * without friction to the unbranded `ProducerId` alias `@debuggen/shared`
   * declares for it.
   */
  producerId: idSchema,
  /**
   * The document's URL, query-redacted before it left the page (AAP §0.5.2).
   * The service reads it to decide whether the document is still the one the
   * binding was made for.
   */
  url: urlSchema,
  /**
   * Whether the fiber hook was installed before the page's React runtime loaded
   * — the readiness signal behind the consented reload (AAP §0.5.5).
   */
  installedBeforeReact: z.boolean(),
  /** Whether a React runtime was detected in the document at all. */
  reactDetected: z.boolean(),
});

/**
 * A validated `agent.ready` payload.
 *
 * Everything on it is an observation the agent made about its own document, so a
 * consumer reads it as a report rather than as a request: the service decides
 * what to do about a late hook, and the panel decides what to display.
 */
export type AgentReadyPayload = z.infer<typeof agentReadyPayloadSchema>;

/**
 * `agent.config` — the service arms or disarms the page agent for a capture
 * (AAP §0.4.2).
 *
 * The frame travels to the bound tab and no other: service → the tab's
 * connection → the isolated-world bridge → the MAIN-world agent, which attaches
 * exactly the hooks the configuration names and detaches the rest.
 *
 * **Both ids are required, and that is the design.** Dormancy is signalled by
 * all-false hooks, never by omitting the capture (AAP §0.4.2): every frame the
 * agent receives therefore says which session and which capture window it is
 * about, so an event the agent emits can be attributed without the agent having
 * to remember a previous frame, and a stale config that arrived after a capture
 * stopped is recognisable rather than ambiguous. `DORMANT_AGENT_HOOK_CONFIG` in
 * `@debuggen/instrumentation` is the canonical all-false value the service sends
 * when a capture stops, a session ends or cleanup runs (AAP §0.5.1), so nobody
 * hand-writes one.
 *
 * `sessionId` is on the payload even though the envelope carries a `sessionId`
 * for routing, and the duplication is deliberate: the envelope's copy tells the
 * transport where to deliver the frame, while this one survives the hop through
 * the service worker and the bridge, which forward a payload and not an
 * envelope. An agent that read its session from an envelope field would have
 * nothing to stamp on the events it is about to emit.
 *
 * `hooks` is the **imported** {@link agentHookConfigSchema}. Its seven flags are
 * not restated here; adding one upstream propagates into this message without an
 * edit, while a restated copy would keep validating the old set
 * (AAP §0.2.3).
 */
export const agentConfigPayloadSchema = z.strictObject({
  /**
   * The session this configuration belongs to. Required: it is what the agent
   * stamps on the events it emits, and it reaches the page outside the
   * envelope.
   */
  sessionId: idSchema,
  /**
   * The capture window the events belong to. Required even when every hook is
   * false — an agent returning to dormant still knows which capture it is
   * leaving.
   */
  captureId: idSchema,
  /**
   * Which signals to observe, as `@debuggen/instrumentation` defines them.
   * All-false is the dormancy instruction (AAP §0.5.1).
   */
  hooks: agentHookConfigSchema,
});

/**
 * A validated `agent.config` payload.
 *
 * `hooks` is `AgentHookConfig` — the type `@debuggen/instrumentation` owns,
 * carried through by inference rather than redeclared, so the agent's attach
 * functions and this message can never disagree about the set of flags.
 */
export type AgentConfigPayload = z.infer<typeof agentConfigPayloadSchema>;

/**
 * `server-agent.config` — the service arms or disarms the Node preload inside
 * the target project's dev server (AAP §0.4.2).
 *
 * The server-tier counterpart of {@link agentConfigPayloadSchema}, and
 * deliberately shaped differently in one respect: **an absent `captureId` is the
 * disable signal.** Receiving a frame without one makes the preload call
 * `disable()` on its instrumentations and remove the global tracer provider, so
 * the framework's own spans become no-ops; the module stays loaded but inert,
 * the application keeps serving, and the next capture re-enables the
 * instrumentations and re-registers the provider (AAP §0.5.1). The
 * `DISABLED_SERVER_AGENT_SIGNALS` constant in `@debuggen/instrumentation` is the
 * signal set that accompanies that frame.
 *
 * Why the two arming frames differ here, when consistency would be tidier: the
 * browser agent is a page-lifetime object that stays attached and merely stops
 * observing, so it is always *in* some capture's context, while the preload
 * holds process-wide global state — a registered tracer provider and wrapped
 * driver methods — whose absence is the very thing being requested. "No capture"
 * is a real state for the server tier and is spelled as one.
 *
 * `sessionId` is optional for the same reason: a disable frame is not about a
 * session, and the preload is scoped to a project root by its credential rather
 * than to a session by a payload (AAP §0.5.6). At most one session may hold a
 * capture on a project at a time, which the service enforces, so a frame that
 * does name a session names the single owner (AAP §0.4.2).
 *
 * `signals` is the **imported** {@link serverAgentSignalsSchema}. Its six keys
 * are not restated here: `packages/telemetry`'s preload reads them structurally
 * from the parsed frame, so their names are a wire contract, and a second copy
 * of them in this package would be free to drift from the one the preload
 * actually reads.
 */
export const serverAgentConfigPayloadSchema = z.strictObject({
  /**
   * The session that owns the capture, where the frame is about one. Absent on a
   * disable frame, which is about a process rather than a session.
   */
  sessionId: idSchema.optional(),
  /**
   * The active capture window. **Absent means disable** — the preload drops its
   * instrumentations and its tracer provider (AAP §0.5.1).
   */
  captureId: idSchema.optional(),
  /**
   * Which server-tier signals the capture wants, as
   * `@debuggen/instrumentation` defines them, including the named symbols whose
   * patched bodies emit function spans.
   */
  signals: serverAgentSignalsSchema,
});

/**
 * A validated `server-agent.config` payload.
 *
 * Read the two optional ids together with `signals`: a frame with a `captureId`
 * arms the named signals for that capture, and a frame without one disables the
 * tier whatever the signals say. The preload applies that precedence; this
 * schema only guarantees the shape both cases share.
 */
export type ServerAgentConfigPayload = z.infer<typeof serverAgentConfigPayloadSchema>;

// ---------------------------------------------------------------------------
// Section D — parse helpers
//
// One per payload, all six built the same way: `safeParse`, then either `ok`
// with the parsed value or `err` with the error `protocolParseError` builds
// from the issue list. None of them throws, and none of them can echo a
// rejected value — the hints below are constant sentences about the schema,
// and the message and details come from issue paths and codes alone
// (AAP §0.5.2).
// ---------------------------------------------------------------------------

/**
 * The developer-facing next step attached to a rejected `client.hello`.
 *
 * Read this hint as the template for the five that follow: it describes the
 * **schema**, never the value that failed it, because `DebuggenError.toPayload()`
 * forwards `hint` verbatim across the wire and into whatever log or banner
 * receives it (AAP §0.5.2).
 *
 * It names the credential field without saying anything about what a credential
 * looks like, and it deliberately does not suggest where to find one: a hint
 * that told a caller which file holds the editor credential would be a
 * discovery aid attached to the failure of an unauthenticated connection.
 */
const CLIENT_HELLO_HINT =
  'A client.hello payload carries the client kind (vscode, devtools, agent or server-agent), the protocol version as major.minor.patch, a credential, and optionally the project root it is acting for and the Chrome tab it is attached to. It must be the first frame after the upgrade.';

/** The hint attached to a rejected `client.ping`. See {@link CLIENT_HELLO_HINT}. */
const CLIENT_PING_HINT =
  'A client.ping payload is an empty object; the frame id is what its service.pong answer references.';

/** The hint attached to a rejected `service.pong`. See {@link CLIENT_HELLO_HINT}. */
const SERVICE_PONG_HINT =
  'A service.pong payload carries exactly one field, ref: the id of the client.ping it answers, of at most 64 characters.';

/** The hint attached to a rejected `agent.ready`. See {@link CLIENT_HELLO_HINT}. */
const AGENT_READY_HINT =
  'An agent.ready payload carries the tab id, the document id, the producer id, the document URL, and the two booleans installedBeforeReact and reactDetected.';

/** The hint attached to a rejected `agent.config`. See {@link CLIENT_HELLO_HINT}. */
const AGENT_CONFIG_HINT =
  'An agent.config payload carries the session id, the capture id and the full hook configuration; every hook flag must be present, and all of them false is how the agent is returned to dormant.';

/** The hint attached to a rejected `server-agent.config`. See {@link CLIENT_HELLO_HINT}. */
const SERVER_AGENT_CONFIG_HINT =
  'A server-agent.config payload carries the full signal set, optionally the session id and optionally the capture id; omitting the capture id is how the dev-server preload is disabled.';

/**
 * Validates an unknown value as a {@link ClientHelloPayload}, without throwing.
 *
 * This is the first thing the service does with a new connection's first frame
 * (`apps/local-service/src/server/auth.ts`), before it looks at a credential,
 * compares a version or records a client. A rejection closes the socket with
 * {@link WS_CLOSE_UNAUTHORIZED}.
 *
 * ## The leak-free guarantee, walked through
 *
 * This helper handles a credential, so the claim that its failure cannot echo
 * one is worth substantiating rather than asserting. There are exactly four
 * routes a value could take into the returned error, and all four are closed:
 *
 * 1. **The message.** It is `` `${prefix}: ${describeZodIssues(issues)}` ``.
 *    `describeZodIssues` builds each entry from the issue's path, its code and
 *    schema-declared metadata — the expected type, a declared bound, the
 *    permitted literals of an enum — and never from `issue.input`,
 *    `issue.message` or any received value.
 * 2. **The `error` options on the schemas.** Every one in this module is a
 *    constant string, so Zod has no input to interpolate into a custom message
 *    that `describeZodIssues` would then have to defend against.
 * 3. **The hint.** {@link CLIENT_HELLO_HINT} is a module constant that never
 *    sees the payload.
 * 4. **The details.** `protocolParseError` attaches `{ issueCount, issues:
 *    [{ path, code }] }`, built by the same path renderer as the message.
 *
 * One nuance is worth stating because this is the module where it matters.
 * `z.strictObject` reports an extra field as an `unrecognized_keys` issue, and
 * `describeZodIssues` renders the **key names** it carries — the one
 * payload-derived datum AAP §0.5.2 sanctions, on the same principle by which the
 * redaction layer keeps a header's name and replaces its value, and what makes a
 * misspelled field diagnosable at all. Each name is gated by a
 * field-name pattern and length-bounded, so a key that is not identifier-shaped
 * is replaced rather than echoed. The consequence for producers: a secret
 * belongs in the `token` **value**, never in a key position.
 *
 * @param value Any value believed to be a `client.hello` payload.
 * @returns `ok(payload)` with the validated payload, or `err(error)` describing
 * the shape of every issue found.
 *
 * @example
 * ```ts
 * const parsed = parseClientHelloPayload(frame.payload);
 * if (!parsed.ok) {
 *   socket.close(WS_CLOSE_UNAUTHORIZED, parsed.error.code);
 *   return;
 * }
 * const principal = resolveCredential(parsed.value.token);
 * ```
 */
export function parseClientHelloPayload(value: unknown): Result<ClientHelloPayload, DebuggenError> {
  const parsed = clientHelloPayloadSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid client.hello payload',
      parsed.error.issues,
      CLIENT_HELLO_HINT,
    ),
  );
}

/**
 * Validates an unknown value as a {@link ClientPingPayload}, without throwing.
 *
 * The payload has no field to get wrong, so the only rejection is a value that
 * is not an object or one carrying a key: the service answers either with an
 * `error` under the frame's ref rather than a pong, which a pinging client
 * reads as an answer from a live peer, never as a dead connection.
 *
 * @param value Any value believed to be a `client.ping` payload.
 * @returns `ok(payload)` with the validated (empty) payload, or `err(error)`
 * describing the shape of every issue found.
 */
export function parseClientPingPayload(value: unknown): Result<ClientPingPayload, DebuggenError> {
  const parsed = clientPingPayloadSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid client.ping payload',
      parsed.error.issues,
      CLIENT_PING_HINT,
    ),
  );
}

/**
 * Validates an unknown value as a {@link ServicePongPayload}, without throwing.
 *
 * Applied by a client to what arrived before it compares the `ref` with its
 * outstanding ping, and by the service to the answer it built before it sends
 * it, so a ping whose id could never be referenced is refused rather than
 * answered with a frame its sender would reject.
 *
 * @param value Any value believed to be a `service.pong` payload.
 * @returns `ok(payload)` with the validated payload, or `err(error)` describing
 * the shape of every issue found.
 */
export function parseServicePongPayload(value: unknown): Result<ServicePongPayload, DebuggenError> {
  const parsed = servicePongPayloadSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid service.pong payload',
      parsed.error.issues,
      SERVICE_PONG_HINT,
    ),
  );
}

/**
 * Validates an unknown value as an {@link AgentReadyPayload}, without throwing.
 *
 * Applied where the frame lands after its two relays: the Chrome service worker
 * checks what the bridge handed it before sending it on, and the service checks
 * what arrived before it updates readiness for a bound tab. A rejection is worth
 * reporting rather than swallowing — an unparseable `agent.ready` is a document
 * whose readiness was never recorded, which surfaces later as a session that
 * never reaches "Ready to capture" for no visible reason.
 *
 * @param value Any value believed to be an `agent.ready` payload.
 * @returns `ok(payload)` with the validated payload, or `err(error)` describing
 * the shape of every issue found.
 */
export function parseAgentReadyPayload(value: unknown): Result<AgentReadyPayload, DebuggenError> {
  const parsed = agentReadyPayloadSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid agent.ready payload',
      parsed.error.issues,
      AGENT_READY_HINT,
    ),
  );
}

/**
 * Validates an unknown value as an {@link AgentConfigPayload}, without throwing.
 *
 * Used on the receiving side of the relay rather than the sending one: the
 * service worker validates a configuration before forwarding it to a page, and a
 * test asserts against what the service sent. The page agent itself reads the
 * frame defensively with its own structural mirror — it sits below this package
 * and may not import it — so this helper is what keeps the two readings honest.
 *
 * A configuration missing a hook flag, or carrying one this build does not know,
 * fails here. That strictness is the point: a partially specified configuration
 * would leave the agent guessing at the flags it was not told about, and
 * guessing means either observing something the developer did not ask for or
 * missing the evidence their question needed.
 *
 * @param value Any value believed to be an `agent.config` payload.
 * @returns `ok(payload)` with the validated payload, or `err(error)` describing
 * the shape of every issue found.
 */
export function parseAgentConfigPayload(value: unknown): Result<AgentConfigPayload, DebuggenError> {
  const parsed = agentConfigPayloadSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid agent.config payload',
      parsed.error.issues,
      AGENT_CONFIG_HINT,
    ),
  );
}

/**
 * Validates an unknown value as a {@link ServerAgentConfigPayload}, without
 * throwing.
 *
 * The frame the dev-server preload's control socket acts on, and the one whose
 * rejection has the quietest failure mode: a preload that could not read its
 * configuration collects nothing, and a capture then produces browser evidence
 * with no server or database spans behind it. Validating it — rather than
 * reading the fields optimistically — is what turns that into a reported
 * `PROTOCOL_INVALID_MESSAGE` instead of a puzzling gap in a timeline.
 *
 * @param value Any value believed to be a `server-agent.config` payload.
 * @returns `ok(payload)` with the validated payload, or `err(error)` describing
 * the shape of every issue found.
 */
export function parseServerAgentConfigPayload(
  value: unknown,
): Result<ServerAgentConfigPayload, DebuggenError> {
  const parsed = serverAgentConfigPayloadSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid server-agent.config payload',
      parsed.error.issues,
      SERVER_AGENT_CONFIG_HINT,
    ),
  );
}

// ---------------------------------------------------------------------------
// Section E — the registry this module contributes to the envelope
// ---------------------------------------------------------------------------

/**
 * The handshake, liveness, lifecycle and arming messages, keyed by the message
 * `type` that carries each payload.
 *
 * The keys are the protocol's own names, verbatim from AAP §0.4.2 — including
 * the hyphen in `server-agent.config`, which is the spelling on the wire and in
 * the preload's own dispatch table — plus the `client.ping` / `service.pong`
 * liveness pair, which sits directly after the handshake it keeps alive. They
 * are written out rather than assembled from parts: a name a reader can grep
 * for across the four processes is worth more than a clever construction.
 *
 * `../envelope.ts` composes this object with the equivalent registry from every
 * other module in this folder to build the discriminated union that dispatches
 * on `type`; nothing here knows how that composition works, which is what keeps
 * the dependency one-directional. A consumer that already knows which message it
 * is holding reaches for the schema or the parse helper directly — this registry
 * is for the dispatcher, not a substitute for the named exports.
 *
 * Frozen, and `as const` so each key maps to its own schema type rather than to
 * a union of the six: a lookup on a literal key gives the exact schema, and the
 * object cannot be extended at runtime by a consumer that would rather add a
 * message than declare one.
 */
export const AGENT_MESSAGE_PAYLOADS = Object.freeze({
  'client.hello': clientHelloPayloadSchema,
  'client.ping': clientPingPayloadSchema,
  'service.pong': servicePongPayloadSchema,
  'agent.ready': agentReadyPayloadSchema,
  'agent.config': agentConfigPayloadSchema,
  'server-agent.config': serverAgentConfigPayloadSchema,
} as const);
