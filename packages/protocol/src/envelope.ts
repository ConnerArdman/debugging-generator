/**
 * The WebSocket transport contract of the whole product: the message envelope,
 * the one discriminated union of every frame, and the four functions that turn
 * bytes into a typed message and back.
 *
 * ## The envelope
 *
 * This module is the only statement of the frame shape:
 *
 * ```text
 * { id, type, sessionId?, tabId?, ts, payload }
 * ```
 *
 * The optional acting `tabId` is the one field beyond the base shape
 * `{ id, type, sessionId?, ts, payload }`. It is additive — absent on every
 * frame that does not act for a tab, so such a frame is byte-identical to the
 * base shape — and it exists because the DevTools tab rule cannot be enforced
 * without it (see "One frame, one tab" below).
 *
 * - `id` — a per-frame identifier, minted by {@link createEnvelope}. It exists
 *   because frames are re-sent routinely rather than exceptionally: the MV3
 *   service worker suspends after roughly thirty seconds of idleness, so
 *   `client/ws-client.ts` reconnects with backoff and a receiver needs a stable
 *   handle to correlate a reply with a request (`error.ref`) or to notice a
 *   duplicate.
 * - `type` — the discriminant, one of the twenty-six names `./messages/index.ts`
 *   declares in `MESSAGE_TYPES`.
 * - `sessionId` — the service's **routing** key, present when the frame belongs
 *   to a session. Optional because a handshake (`client.hello`) and a tab-level
 *   frame (`tab.navigated`) precede any session. When the payload names the
 *   session it is about — its own `sessionId`, or the record `id` a
 *   `session.created` / `session.updated` broadcast carries — a present routing
 *   key must be that same session, and a frame where the two disagree is
 *   refused (see "One frame, one session" below).
 * - `tabId` — the **acting tab**: the inspected Chrome tab a DevTools frame acts
 *   for, a non-negative safe-integer tab id (`tabIdSchema` from
 *   `./messages/binding.ts`). Set by the Chrome service worker, which
 *   multiplexes every inspected tab over one connection, on the frames it sends
 *   for a tab; absent on every other frame. When the payload carries a `tabId`
 *   of its own, a present acting tab must be that same tab (see "One frame, one
 *   tab" below).
 * - `ts` — the moment the sender stamped the frame, on the product's one time
 *   base: Unix epoch **milliseconds** as a double, sub-millisecond precision
 *   preserved. The schema is `epochMsSchema` from `./version.ts`,
 *   whose bounds come from `@debuggen/telemetry`, so a producer that sent
 *   seconds, microseconds or a relative `performance.now()` reading is refused
 *   here exactly as it would be at the telemetry layer.
 * - `payload` — the message's own body, validated by the schema its domain
 *   module owns.
 *
 * ## One union, derived rather than written
 *
 * {@link protocolMessageSchema} is the **only** `z.discriminatedUnion` over
 * message types in this monorepo, and it is built by mapping over
 * `MESSAGE_TYPES` and looking each payload schema up in
 * `MESSAGE_PAYLOAD_SCHEMAS`. Nothing here lists a message by hand, so a message
 * added to `messages/**` cannot be forgotten in the union: it arrives through
 * the registry, and `messages/index.ts` proves at compile time that the registry
 * and the tuple name the same twenty-six types.
 *
 * The direction of that dependency is load bearing and runs one way only:
 * **`messages/*.ts` must never import this file** — this file imports them.
 * Each domain module exports its own frozen `type → payload schema` map,
 * `messages/index.ts` merges those maps, and the union is assembled here. An
 * upward import from a domain module would close a cycle through the envelope
 * and leave the payload schemas the union needs first unreachable. For the same
 * reason nothing here imports `./http.js` (it sits above this module) or
 * `./client/*` (above that again).
 *
 * ## Validation happens on receive, never on send
 *
 * {@link parseMessage} and {@link decodeMessage} validate; {@link createEnvelope}
 * and {@link encodeMessage} deliberately do not. The send path is already
 * type-safe — `createEnvelope('telemetry.event', payload)` will not compile with
 * the wrong payload — and validating there would double the cost of the hottest
 * path in the product: a `telemetry.event` frame carries up to a few thousand
 * events, and the browser agent emits batches continuously while a capture runs.
 * A receiver validates what arrived because that is where the value came from
 * another process; a sender validating its own typed literal only pays twice.
 *
 * The checks the send path does make are not payload validation: they are the
 * constant-time comparisons below, of identifiers the caller supplied — the
 * routing key against the payload's session, and the acting tab against the
 * payload's tab, after a scalar check that the acting tab is a tab id at all —
 * and they exist because the type system cannot express them.
 *
 * ## One frame, one session
 *
 * A frame can name a session twice: the envelope's `sessionId`, which the
 * service routes and authorizes by, and the payload's own subject — its
 * `sessionId`, or the `session.id` of a `session.created` / `session.updated`
 * record — which is what a handler acts on. The service authorizes a devtools
 * principal only for the session bound to its tab, so a frame whose two answers
 * differ is a confused-deputy request: one field passes the authorization check
 * and the other names the session that is changed. Neither field may be trusted
 * over the other, so such a frame is refused rather than repaired.
 *
 * - {@link protocolMessageSchema} attaches the rule to every member of the
 *   union: when both are present they must be equal, and the rejection is a
 *   `custom` issue at path `sessionId` with the label
 *   `routing-matches-payload` — never either identifier.
 * - {@link createEnvelope} refuses to build such a frame, because every
 *   receiver would refuse it: an explicit routing key that contradicts the
 *   payload's subject throws `PROTOCOL_INVALID_MESSAGE` at the call site that
 *   made the mistake instead of surfacing as an `error` frame from another
 *   process.
 *
 * An absent routing key stays valid, and so does a routing key on a payload that
 * names no session of its own (`client.hello`, `agent.ready`, `tab.navigated`,
 * `session.unbind`, `telemetry.event`, `error`): there is nothing to contradict.
 *
 * ## One frame, one tab
 *
 * One paired DevTools credential and one MV3 service-worker WebSocket carry
 * every inspected tab, so neither the credential nor the connection says which
 * tab a frame is for — and the service allows a DevTools principal to act only
 * for the session bound to *its* tab. The envelope's acting `tabId` is that
 * missing statement. The service worker fills it from Chrome's own port
 * metadata on every frame it sends for a tab — `telemetry.event`,
 * `target.selected` and `source.open`, and optionally `agent.ready` and the
 * binding frames — and the service authorizes a DevTools frame for a session
 * only when that session's live binding is this tab's. Every other frame, and
 * every frame the service or an editor sends, carries no `tabId` key at all.
 *
 * A frame can name a tab twice as well: the acting `tabId`, and the payload's
 * own `tabId` (`agent.ready`, `session.bind`, `session.bound`, `tab.navigated`,
 * `session.unbind`, and a DevTools `client.hello`). The same confused-deputy
 * argument applies — one field would pass the tab check while the other names
 * the tab that is changed — so the same rule does:
 *
 * - {@link protocolMessageSchema} refuses a frame whose two tabs differ, as a
 *   `custom` issue at path `tabId` with the label `acting-tab-matches-payload`
 *   and never either tab id;
 * - {@link createEnvelope} throws `PROTOCOL_INVALID_MESSAGE` for a `tabId`
 *   option that is not a tab id or that contradicts the payload's own, and it
 *   never lifts a payload's `tabId` into the envelope, so a service push such
 *   as `session.bound` stays exactly as it was.
 *
 * An absent acting tab stays valid on every frame — whether one is *required*
 * is the service's authorization decision, not a shape rule — and so does an
 * acting tab on a payload with no `tabId` of its own.
 *
 * ## A rejected frame is never echoed
 *
 * A frame that fails validation is unvalidated data from another process, and it
 * routinely carries exactly what the privacy model protects:
 * telemetry attributes, a redacted-but-still-sensitive URL, a database
 * statement, a React prop preview, or the bearer credential of a `client.hello`.
 * The service logs parse failures, both user interfaces display them and a
 * session may persist them, and none of those paths passes through the redaction
 * layer. So every failure below is built by `protocolParseError` from
 * `./version.ts`, whose message and `details` come from Zod issue paths, issue
 * codes and schema-declared metadata alone — and the one failure not built from
 * issues, a frame that is not JSON at all, carries a constant sentence rather
 * than the `SyntaxError`'s message, because V8 quotes the offending input in it.
 *
 * ## Environment-neutral, JSON-only
 *
 * An envelope crosses a WebSocket, a `window.postMessage` hop (page agent →
 * isolated-world bridge) and a `chrome.runtime` port, so everything in it is
 * plain JSON: no `Date`, no `Map`, no class instance, and an absent optional key
 * rather than an explicit `undefined`. This module holds no Node or DOM
 * dependency — `packages/protocol/tsconfig.json` declares `types: []` and
 * `tsup.config.ts` builds with `platform: 'neutral'` — and it has no import-time
 * side effect beyond constructing pure schema objects.
 *
 * Every export is named; there is no default export.
 */

import { z } from 'zod';

import { DebuggenError, assertNever, err, newMessageId, nowEpochMs, ok } from '@debuggen/shared';
import type { MessageId, Result, SessionId } from '@debuggen/shared';

// Imported from its own module rather than through the messages barrel, which
// forwards message payloads and their vocabularies only; `./messages/binding.ts`
// imports nothing from this file, so the dependency still runs one way.
import { tabIdSchema } from './messages/binding.js';
import { MESSAGE_PAYLOAD_SCHEMAS, MESSAGE_TYPES } from './messages/index.js';
import type { MessageType } from './messages/index.js';
import { epochMsSchema, isPlainRecord, protocolParseError } from './version.js';

// ---------------------------------------------------------------------------
// Section A — the envelope's own field primitives
// ---------------------------------------------------------------------------

/**
 * The longest `id` or `sessionId` the envelope will consider.
 *
 * Generous on purpose. The ids this product mints are twenty characters
 * (`msg_` plus a sixteen-character suffix), and each payload that carries a
 * `sessionId` of its own bounds it more tightly in its domain module. The
 * envelope's job is different: it is the outermost gate, so it refuses a frame
 * whose identifier arrived with a kilobyte in it on a cheap length check,
 * without pretending to know how any particular producer spells its ids.
 */
const MAX_IDENTIFIER_LENGTH = 128;

/**
 * The transport-level identifier primitive: a bounded, non-empty string.
 *
 * Used for both `id` and `sessionId`. It is deliberately **not** derived from
 * `packages/shared/src/ids.ts`'s `ses_` / `msg_` prefix grammar: `SessionId` and
 * `MessageId` are plain unbranded string aliases upstream precisely so that the
 * wire format does not depend on how one generator happens to spell a suffix.
 * Re-deriving that grammar here would make a future change to the id helper a
 * breaking protocol change, and would refuse a perfectly routable id minted by
 * a client this package does not own.
 *
 * A bounded non-empty string is a primitive rather than a shape, which is why
 * declaring it here restates nothing that another module owns.
 */
const identifierSchema = z
  .string()
  .min(1, { error: 'expected a non-empty id' })
  .max(MAX_IDENTIFIER_LENGTH, {
    error: `expected an id of at most ${String(MAX_IDENTIFIER_LENGTH)} characters`,
  });

/**
 * The four envelope fields every message shares, as a Zod shape record.
 *
 * Written once and spread into all twenty-six union members, so the envelope
 * cannot end up meaning something slightly different for one message type. It
 * is exported for the same reason: `apps/local-service/src/server/ws.ts` and the
 * two extension transports occasionally need to describe an envelope without
 * committing to a `type` — a diagnostic that reports which frame failed, for
 * instance — and they must do that from this record rather than from a private
 * copy.
 *
 * Frozen, because it is module-level shared state: a consumer that mutated it
 * would change the meaning of a union that has already been built.
 *
 * `type` and `payload` are not here. They are the two fields that differ per
 * member, and adding a placeholder for them would invite a caller to build an
 * envelope schema that accepts any type with any payload — the one thing the
 * discriminated union exists to prevent.
 */
export const envelopeBaseShape = Object.freeze({
  /** The per-frame identifier. See {@link identifierSchema}. */
  id: identifierSchema,
  /**
   * The routing key, absent on a frame that precedes or outlives a session.
   * Optional in the schema and therefore an *absent key* in a valid frame, never
   * a present `undefined` — which is also the only spelling that survives a JSON
   * round trip unchanged. Its agreement with the payload's own subject is a
   * cross-field rule, so it is enforced per union member by
   * {@link requireFrameSubjectsAgree} rather than by this field schema.
   */
  sessionId: identifierSchema.optional(),
  /**
   * The acting tab: the inspected Chrome tab a DevTools frame acts for.
   *
   * Set by the Chrome service worker — which multiplexes every inspected tab
   * over one connection and one paired credential — on the frames it sends for
   * a tab (`telemetry.event`, `target.selected`, `source.open`; optionally
   * `agent.ready` and the binding frames), and absent on every other frame. The
   * service authorizes a DevTools frame for a session only when that session's
   * live binding is this tab's, so this field is a claim the
   * service verifies, never a capability.
   *
   * The same schema a payload's `tabId` uses (`./messages/binding.ts`):
   * `-1` (`chrome.tabs.TAB_ID_NONE`), a fraction, a string and anything beyond
   * the safe-integer range are refused. Optional, and therefore an absent key
   * rather than a present `undefined`, exactly like `sessionId`; its agreement
   * with the payload's own `tabId` is enforced by
   * {@link requireFrameSubjectsAgree}.
   */
  tabId: tabIdSchema.optional(),
  /** The sender's timestamp, in epoch milliseconds. See `./version.ts`. */
  ts: epochMsSchema,
});

// ---------------------------------------------------------------------------
// Section B — the envelope type and the types derived from the registry
// ---------------------------------------------------------------------------

/**
 * One frame of this protocol, as a type.
 *
 * Generic in both halves so that the discriminant and the payload stay tied
 * together: `Envelope<'panel.generated', PanelGeneratedPayload>` is a different
 * type from `Envelope<'source.open', PanelGeneratedPayload>`, and only the
 * former can be produced for that type name. Consumers normally reach for
 * {@link MessageByType} or {@link ProtocolMessage} instead of naming both
 * parameters themselves.
 *
 * `sessionId` is declared `?: SessionId | undefined` rather than `?: SessionId`
 * for one precise reason: `exactOptionalPropertyTypes` is on, Zod infers an
 * `.optional()` member as `sessionId?: string | undefined`, and the two
 * spellings are not mutually assignable under that flag. Matching Zod's
 * inference is what lets {@link ProtocolMessageMatchesSchema} prove — by the
 * compiler, not by a comment — that this hand-written type and
 * {@link protocolMessageSchema}'s inferred type describe the same frames.
 * {@link createEnvelope} still omits the key entirely when there is no session,
 * so no envelope this package builds carries an explicit `undefined`. `tabId`
 * is spelled `?: number | undefined` for the same reason, and is likewise
 * omitted when a frame acts for no tab.
 *
 * Every field is `readonly`: a frame is a value that has been sent or received,
 * not a mutable buffer. Readonly-ness is not part of structural assignability,
 * so this costs the union proof nothing.
 */
export interface Envelope<K extends MessageType, P> {
  /** The per-frame identifier, minted by {@link createEnvelope}. */
  readonly id: MessageId;
  /** The discriminant: which message this frame is. */
  readonly type: K;
  /** The session this frame routes to, where it belongs to one. */
  readonly sessionId?: SessionId | undefined;
  /**
   * The inspected Chrome tab a DevTools frame acts for, where it acts for one:
   * set by the service worker, verified by the service against its live
   * tab-to-session binding, absent on every other frame.
   */
  readonly tabId?: number | undefined;
  /** When the sender stamped the frame, in epoch milliseconds. */
  readonly ts: number;
  /** The message's body, as its domain module's schema defines it. */
  readonly payload: P;
}

/**
 * The payload type of one message, read out of the registry.
 *
 * The indirection matters: the payload type is never restated here, it is
 * `z.infer` of the schema the owning domain module declared and
 * `MESSAGE_PAYLOAD_SCHEMAS` registered. So `MessagePayload<'telemetry.event'>`
 * is the ingress batch type `messages/telemetry.ts` owns, and a change there is
 * a compile error at every call site here rather than a silent mismatch on the
 * wire.
 *
 * Consumers: `client/ws-client.ts` for the argument of a typed `send`, and every
 * app that builds a frame — `apps/local-service/src/server/clients.ts`,
 * `apps/vscode-extension/src/service/client.ts`,
 * `apps/chrome-extension/src/background/ws-bridge.ts`.
 */
export type MessagePayload<K extends MessageType> = z.infer<(typeof MESSAGE_PAYLOAD_SCHEMAS)[K]>;

/**
 * The envelope type of one message: the pairing of a `type` with its payload.
 *
 * This is the type a typed subscription resolves a handler's argument to —
 * `client.on('panel.generated', (message) => …)` gives the handler a
 * `MessageByType<'panel.generated'>`, so `message.payload.panel` is a
 * `PanelSpec` with no narrowing, no cast and no optional chaining.
 *
 * Consumers: `client/ws-client.ts` (`on`, `send`), `index.ts`,
 * `apps/local-service/src/server/{ws,clients}.ts`,
 * `apps/vscode-extension/src/service/client.ts` and
 * `apps/chrome-extension/src/background/ws-bridge.ts`.
 */
export type MessageByType<K extends MessageType> = Envelope<K, MessagePayload<K>>;

/**
 * Every message type mapped to its envelope type.
 *
 * Useful where a consumer needs the whole table rather than one member: a
 * handler registry keyed by message type (`{ [K in MessageType]?: (m:
 * ProtocolMessageMap[K]) => void }`), which is how both extension clients and
 * the service's router type their dispatch tables.
 */
export type ProtocolMessageMap = { readonly [K in MessageType]: MessageByType<K> };

/**
 * Any frame of this protocol: the union of all twenty-six envelope types.
 *
 * The return type of {@link parseMessage} and {@link decodeMessage}, the
 * argument type of {@link encodeMessage}, and the type a transport hands to its
 * router. Because it is a discriminated union on `type`, a `switch` over
 * `message.type` narrows `message.payload` in each arm, and
 * {@link assertExhaustiveMessage} in the `default` arm turns a forgotten message
 * type into a compile error.
 */
export type ProtocolMessage = ProtocolMessageMap[MessageType];

/**
 * The discriminant of a given frame type.
 *
 * A small convenience for app code that is generic over a message —
 * `function route<M extends ProtocolMessage>(m: M): MessageTypeOf<M>` — so it
 * does not have to spell `M['type']` and risk widening it to `MessageType`.
 */
export type MessageTypeOf<M extends ProtocolMessage> = M['type'];

// ---------------------------------------------------------------------------
// Section C — the one discriminated union, assembled from the registry
// ---------------------------------------------------------------------------

/**
 * Looks one payload schema up in the registry.
 *
 * The lookup is total by construction, and that is proved one file away rather
 * than assumed here: `messages/index.ts` asserts with
 * `MessageRegistryIsComplete` that `MESSAGE_PAYLOAD_SCHEMAS`'s key set and
 * `MessageType` are mutually assignable, so TypeScript types this indexed access
 * as a schema and not as `schema | undefined` even under
 * `noUncheckedIndexedAccess`.
 *
 * The runtime check is still here, and it earns its place. The registry is a
 * frozen object merged from eleven modules that are compiled, bundled and
 * tree-shaken separately from this one; a build that paired a newer
 * `MESSAGE_TYPES` with an older registry — a stale `dist/`, a hand-edited
 * bundle, a mis-resolved workspace link — would otherwise hand `undefined` to
 * `z.strictObject` and surface as an opaque Zod failure about a union option at
 * import time, in every process at once. Naming the missing type in a
 * `DebuggenError` turns that into a diagnosable fault. It cannot fire for a
 * correct registry, so this module still has no import-time side effect worth
 * the name and `package.json`'s `sideEffects: false` stays honest.
 *
 * @param type The message type whose payload schema is wanted.
 * @returns The schema the owning domain module declared for that type.
 * @throws DebuggenError With code `'INTERNAL'` when the registry has no entry
 * for `type`, which means the registry and `MESSAGE_TYPES` disagree.
 */
function payloadSchemaFor<K extends MessageType>(type: K): (typeof MESSAGE_PAYLOAD_SCHEMAS)[K] {
  // The annotation admits `undefined` so the guard below is a real check rather
  // than a comparison the compiler has already ruled out.
  const schema: (typeof MESSAGE_PAYLOAD_SCHEMAS)[K] | undefined = MESSAGE_PAYLOAD_SCHEMAS[type];

  if (schema === undefined) {
    throw new DebuggenError(
      'INTERNAL',
      `No payload schema is registered for message type "${type}"`,
      {
        hint: 'MESSAGE_PAYLOAD_SCHEMAS and MESSAGE_TYPES in packages/protocol/src/messages/index.ts have diverged; rebuild @debuggen/protocol.',
        details: { type },
      },
    );
  }

  return schema;
}

/**
 * The label a routing contradiction is reported under.
 *
 * Rendered by `describeZodIssues` as `sessionId (custom label=routing-matches-payload)`,
 * so the rejection says which rule failed and nothing about the identifiers that
 * failed it. It satisfies the renderer's name gate (`[A-Za-z0-9_$.-]`, at most
 * forty characters rendered), so it is shown verbatim rather than redacted.
 */
const ROUTING_MISMATCH_LABEL = 'routing-matches-payload';

/**
 * The issue message of a routing contradiction.
 *
 * Constant, like every rejection text in this module: it names the two fields
 * and never their values. `protocolParseError` does not render
 * issue messages at all; this one is stated for a caller that inspects the raw
 * `safeParse` result of {@link protocolMessageSchema}.
 */
const ROUTING_MISMATCH_RULE =
  'expected the routing sessionId to equal the session the payload names';

/**
 * The label an acting-tab contradiction is reported under.
 *
 * Rendered by `describeZodIssues` as
 * `tabId (custom label=acting-tab-matches-payload)`: the rule that failed, and
 * neither tab id. Like {@link ROUTING_MISMATCH_LABEL} it passes the renderer's
 * name gate, so it is shown verbatim.
 */
const ACTING_TAB_MISMATCH_LABEL = 'acting-tab-matches-payload';

/**
 * The issue message of an acting-tab contradiction.
 *
 * Constant for the reason {@link ROUTING_MISMATCH_RULE} is: it names the two
 * fields and never their values.
 */
const ACTING_TAB_MISMATCH_RULE = 'expected the acting tabId to equal the tab the payload names';

/**
 * The session a payload is *about*, read structurally, if it names one.
 *
 * Two spellings exist in the registry, and both are read:
 *
 * 1. the payload's own `sessionId` — the field most payloads carry, and the one
 *    {@link sessionIdFromPayload} lifts into the routing key;
 * 2. otherwise `payload.session.id` — the `SessionRecord` id of a
 *    `session.created` / `session.updated` broadcast, whose payload is
 *    `{ session }` and has no top-level `sessionId`.
 *
 * Structural for the reason {@link sessionIdFromPayload} is: the payload schemas
 * belong to eleven modules, and asking the value keeps this correct for every
 * message — including one added later under either spelling — without a
 * per-type table beside the registry. A payload with neither (`client.hello`,
 * `tab.navigated`, `telemetry.event`, …) has no subject, and this answers
 * `undefined`.
 *
 * Deliberately distinct from the lifting rule: `createEnvelope` still lifts only
 * the payload's own `sessionId`, so which frames receive a routing key is
 * unchanged; this function only decides what a present routing key must agree
 * with.
 *
 * @param payload A frame's payload, validated or not.
 * @returns The session the payload names, or `undefined` when it names none.
 */
function payloadSubjectSessionId(payload: unknown): SessionId | undefined {
  const own = sessionIdFromPayload(payload);

  if (own !== undefined || !isPlainRecord(payload)) {
    return own;
  }

  const record = payload.session;

  if (!isPlainRecord(record)) {
    return undefined;
  }

  const recordId = record.id;

  return typeof recordId === 'string' ? recordId : undefined;
}

/**
 * Whether a routing key names a different session than its payload does.
 *
 * The single statement of the rule, shared by the receive path
 * ({@link requireFrameSubjectsAgree}) and the send path
 * ({@link createEnvelope}), so a frame this package builds and a frame it
 * accepts cannot disagree about it. A payload with no subject contradicts
 * nothing.
 *
 * @param routingKey The envelope's `sessionId`.
 * @param payload The frame's payload.
 * @returns `true` only when the payload names a session and it is not
 * `routingKey`.
 */
function routingKeyContradictsPayload(routingKey: string, payload: unknown): boolean {
  const subject = payloadSubjectSessionId(payload);

  return subject !== undefined && subject !== routingKey;
}

/**
 * Reads the payload's own numeric `tabId`, if it has one.
 *
 * Structural, for the reason {@link sessionIdFromPayload} is: six payloads in
 * the registry carry a top-level `tabId` — `agent.ready`, `session.bind`,
 * `session.bound`, `tab.navigated`, `session.unbind`, and `client.hello` for a
 * DevTools connection — and asking the value keeps the acting-tab rule correct
 * for every one of them, and for a payload added later, without a per-type
 * table beside the registry. Only a number counts: a payload whose `tabId` is
 * a string is refused by its own schema on receive, and naming no tab here
 * keeps that refusal the only issue it is reported for.
 *
 * Deliberately never used to *fill* the envelope's `tabId`:
 * {@link createEnvelope} does not lift it, so a service push such as
 * `session.bound`, whose payload names a tab, keeps the §0.2.3 shape exactly.
 *
 * @param payload A frame's payload, validated or not.
 * @returns The tab the payload names, or `undefined` when it names none.
 */
function payloadTabId(payload: unknown): number | undefined {
  if (!isPlainRecord(payload)) {
    return undefined;
  }

  const candidate = payload.tabId;

  return typeof candidate === 'number' ? candidate : undefined;
}

/**
 * Whether an acting tab names a different tab than its payload does.
 *
 * The single statement of the "one frame, one tab" rule, shared by the receive
 * path ({@link requireFrameSubjectsAgree}) and the send path
 * ({@link createEnvelope}) exactly as {@link routingKeyContradictsPayload} is. A
 * payload with no `tabId` of its own contradicts nothing.
 *
 * @param actingTab The envelope's `tabId`.
 * @param payload The frame's payload.
 * @returns `true` only when the payload names a tab and it is not `actingTab`.
 */
function actingTabContradictsPayload(actingTab: number, payload: unknown): boolean {
  const own = payloadTabId(payload);

  return own !== undefined && own !== actingTab;
}

/**
 * Refuses a frame that names two different sessions or two different tabs: the
 * one object-level check every union member carries.
 *
 * Two cross-field rules, evaluated together so a frame that breaks both is
 * reported for both:
 *
 * - **One frame, one session.** The service routes and authorizes by the
 *   envelope's `sessionId`, while a handler acts on the payload's own subject.
 *   A routing key that contradicts the subject is reported on the `sessionId`
 *   path with {@link ROUTING_MISMATCH_LABEL}.
 * - **One frame, one tab.** The service authorizes a DevTools frame by its
 *   acting `tabId`, while a binding handler acts on the payload's own `tabId`.
 *   An acting tab that contradicts it is reported on the `tabId` path with
 *   {@link ACTING_TAB_MISMATCH_LABEL}.
 *
 * The service authorizes a devtools principal only for the session bound to
 * its tab, so a frame that satisfied the check with one field while naming
 * another session or tab in the other would make the service a confused deputy.
 * Refusing it here, at the one validator every receiver shares, closes that
 * without each handler having to remember which field it authorized. Each issue
 * leaves `input` empty, exactly as `../analysis.ts`'s object check does: the
 * rejection names the rule, never an identifier.
 *
 * Both comparisons are made only on an otherwise valid frame. Zod skips an
 * object check after an *aborting* issue, but a string-length bound is not one —
 * an empty payload `sessionId` still reaches this function — so the guard is
 * explicit and taken once, before either rule: a frame that already has a field
 * issue is already refused, and comparing an envelope field with a malformed
 * payload value would add noise rather than information. A frame whose payload
 * is wrong is therefore reported by its payload issues alone.
 *
 * `payload` is declared optional in the parameter type for the compiler's sake
 * alone. {@link envelopeSchemaFor} is generic in `K`, and while `K` is
 * unresolved Zod's output type cannot say whether the registry's payload schema
 * for it yields a required or an optional key; an optional `unknown` is the
 * spelling every instantiation is assignable to. At run time the key is always
 * present, because this check runs only after the member's fields have parsed.
 *
 * @param parsed The member's parse state, whose `value` is the parsed frame.
 */
function requireFrameSubjectsAgree(
  parsed: z.core.ParsePayload<{
    readonly sessionId?: string | undefined;
    readonly tabId?: number | undefined;
    readonly payload?: unknown;
  }>,
): void {
  if (parsed.issues.length > 0) {
    return;
  }

  const { sessionId: routingKey, tabId: actingTab, payload } = parsed.value;

  if (routingKey !== undefined && routingKeyContradictsPayload(routingKey, payload)) {
    parsed.issues.push({
      code: 'custom',
      path: ['sessionId'],
      message: ROUTING_MISMATCH_RULE,
      params: { label: ROUTING_MISMATCH_LABEL },
      // Left empty on purpose: a failure here never carries the identifiers
      // that caused it.
      input: undefined,
    });
  }

  if (actingTab !== undefined && actingTabContradictsPayload(actingTab, payload)) {
    parsed.issues.push({
      code: 'custom',
      path: ['tabId'],
      message: ACTING_TAB_MISMATCH_RULE,
      params: { label: ACTING_TAB_MISMATCH_LABEL },
      // Left empty for the same reason: neither tab id is echoed.
      input: undefined,
    });
  }
}

/**
 * Builds the envelope schema for exactly one message type.
 *
 * Generic in `K` on purpose: that is what keeps `z.literal(type)` a
 * `ZodLiteral<K>` and the payload the registry's schema *for that same `K`*, so
 * the member's inferred type is `{ …, type: K, payload: MessagePayload<K> }`
 * rather than a blurred object whose `type` is the whole union and whose
 * `payload` is the union of all payloads.
 *
 * `z.strictObject` rather than `z.object`: a frame carrying a top-level key
 * beyond the six declared is a protocol violation, not a message with extra
 * information. Tolerating it would let a producer's typo (`sessionID` beside a
 * dropped `sessionId`, `tabID` beside a dropped `tabId`) look like a valid
 * session-less or tab-less frame and quietly break routing or authorization,
 * and it would let an unknown field ride through a boundary this package exists
 * to define.
 *
 * `.check(requireFrameSubjectsAgree)` adds the envelope's two cross-field rules
 * (see "One frame, one session" and "One frame, one tab" in the module
 * documentation). A check returns the same `ZodObject` type, so the member keeps
 * its `.shape`, the union still discriminates on `type`, and
 * {@link ProtocolMessageMatchesSchema} is unaffected: the rules narrow which
 * values are accepted, not their type.
 */
function envelopeSchemaFor<K extends MessageType>(type: K) {
  return z
    .strictObject({
      ...envelopeBaseShape,
      type: z.literal(type),
      payload: payloadSchemaFor(type),
    })
    .check(requireFrameSubjectsAgree);
}

/**
 * The envelope schema type for one message type.
 *
 * Read off {@link envelopeSchemaFor} rather than spelled out, so the tuple type
 * below and the values in it are described by the same declaration. Writing the
 * `ZodObject<…>` type by hand would work until the day it drifted from what
 * `z.strictObject` actually returns, and the drift would show up as an
 * unexplained cast failure rather than as a mismatch anyone could read.
 */
type EnvelopeSchemaFor<K extends MessageType> = ReturnType<typeof envelopeSchemaFor<K>>;

/**
 * Maps a tuple of message types to the tuple of their envelope schemas.
 *
 * Generic in `T` for a reason that is easy to get wrong: a mapped type is
 * applied element-wise to a tuple only when it is *homomorphic over a type
 * parameter*. Written directly against the concrete tuple —
 * `{ [I in keyof typeof MESSAGE_TYPES]: … }` — TypeScript 6.0.3 maps `length`
 * and the array methods too, producing an object whose `length` is `never`,
 * which Zod then refuses because it is not a non-empty tuple of schemas.
 */
type EnvelopeSchemaTuple<T extends readonly MessageType[]> = {
  -readonly [I in keyof T]: EnvelopeSchemaFor<T[I]>;
};

/**
 * The union members, in `MESSAGE_TYPES` order.
 *
 * Mapped over the tuple rather than over `Object.keys(MESSAGE_PAYLOAD_SCHEMAS)`
 * so the member order is the documented protocol order and is identical in every
 * build — `Object.keys` would agree today and is not a contract.
 *
 * The assertion is the one unavoidable cast in this module: `Array.prototype.map`
 * yields an array, and no runtime expression can produce a twenty-six-element
 * tuple type. It is not taken on trust, and the two halves of the guarantee are
 * checked in two different places, deliberately:
 *
 * - **What each member is** — its discriminant literal, its payload schema and
 *   the four envelope fields — is proved by the compiler.
 *   `EnvelopeSchemaTuple` is derived from the same tuple this expression maps and
 *   the same registry it reads, and {@link ProtocolMessageMatchesSchema} then
 *   checks that what the cast claims and what {@link ProtocolMessage} says are
 *   the same set of frames. Pair a member with the wrong payload schema and
 *   `tsc -b` stops at that assertion.
 * - **How many members there are** is proved by the suite, because a cast cannot
 *   police the length of the array it describes: hand this expression a shorter
 *   array and the declared type is unchanged, so only a run-time check notices.
 *   `src/__tests__/envelope.test.ts` therefore asserts the option count, the
 *   exact set of discriminator literals and their order, and round-trips a real
 *   frame of every type through the union.
 */
const envelopeSchemas = MESSAGE_TYPES.map((type) => envelopeSchemaFor(type)) as EnvelopeSchemaTuple<
  typeof MESSAGE_TYPES
>;

/**
 * The **one** discriminated union of every WebSocket message this product
 * carries, discriminated on `type`.
 *
 * There is no second one anywhere in the monorepo, and there must not be: the
 * service, both extension surfaces and the Node preload all validate arriving
 * frames against this schema, so a private copy in an app would be a second
 * opinion about what a valid frame is — the failure mode AAP §0.9.1 names a
 * defect. Adding a message means adding its payload schema to its domain module
 * and its name to `MESSAGE_TYPES`; this union then contains it with no edit
 * here.
 *
 * Zod compiles the discriminator into a lookup, so a frame is matched to its one
 * candidate member by its `type` and validated only against that member — which
 * is why {@link parseMessage} stays cheap enough for a transport that re-sends
 * frames after every service-worker suspension.
 *
 * Consumers: {@link parseMessage} (the only caller that needs it in normal use),
 * `client/ws-client.ts`, `apps/local-service/src/server/ws.ts`,
 * `apps/vscode-extension/src/service/client.ts` and
 * `apps/chrome-extension/src/background/ws-bridge.ts`. Tests additionally read
 * `.options` to prove the union covers the vocabulary exactly.
 */
export const protocolMessageSchema = z.discriminatedUnion('type', envelopeSchemas);

/**
 * The type of {@link protocolMessageSchema}.
 *
 * Exported so a consumer can name the schema in a signature — a test helper, or
 * a transport that takes its validator by injection — without writing
 * `typeof protocolMessageSchema` and without importing Zod's internal generics.
 */
export type ProtocolMessageSchema = typeof protocolMessageSchema;

/**
 * `true` when `A` and `B` are mutually assignable, `false` otherwise.
 *
 * The tuple wrappers stop a union from distributing, so this answers about the
 * two types as written rather than about their members — which is the point
 * here, since both operands are unions of twenty-six object types.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Accepts `true` and nothing else: instantiating it with `false` is a compile
 * error (TS2344), which is what turns a type comparison into an assertion.
 */
type AssertTrue<T extends true> = T;

/**
 * Compile-time proof that {@link protocolMessageSchema} validates exactly the
 * frames {@link ProtocolMessage} describes.
 *
 * This is what makes the cast in {@link envelopeSchemas} safe, and it is the
 * assertion the rest of the package leans on: `parseMessage` returns the
 * hand-written {@link ProtocolMessage} while Zod produces the inferred one, and
 * every typed subscription resolves handler arguments through
 * {@link MessageByType}. If the two ever disagreed — a member built from the
 * wrong payload schema, an envelope field added to the interface and not to
 * `envelopeBaseShape`, an optional key spelled in a way
 * `exactOptionalPropertyTypes` distinguishes — one direction of the assignability
 * below fails and `tsc -b` stops here, naming this line, instead of a consumer
 * discovering it as a type error three packages away.
 *
 * It resolves to `true`, and it is the assertion rather than the value that
 * matters. Exported because a type alias nothing references is a compile error
 * under this repository's `noUnusedLocals`, and because a reader of the emitted
 * declarations can then see the guarantee stated; it has no runtime
 * representation, so there is nothing to consume.
 *
 * @internal
 */
export type ProtocolMessageMatchesSchema = AssertTrue<
  MutuallyAssignable<z.infer<ProtocolMessageSchema>, ProtocolMessage>
>;

// ---------------------------------------------------------------------------
// Section D — receiving: decode, then validate
// ---------------------------------------------------------------------------

/**
 * The error code every rejection in this module carries.
 *
 * Stated once, as a `DebuggenErrorCode`, so the transport-level failure is one
 * value both user interfaces and the service's router can switch on. A
 * rejected frame is a transport fault regardless of which field failed: the
 * receiver cannot act on the message and answers with an `error` frame.
 */
const INVALID_MESSAGE_CODE = 'PROTOCOL_INVALID_MESSAGE';

/** What {@link parseMessage} says failed, before the issue description. */
const INVALID_MESSAGE_PREFIX = 'Invalid protocol message';

/**
 * The constant next step attached to a rejected frame.
 *
 * A sentence about the *schema*, never about the value: it is forwarded verbatim
 * by `DebuggenError.toPayload()` and therefore crosses a process boundary, so it
 * is held to the same rule as the message (AAP §0.5.2).
 */
const INVALID_MESSAGE_HINT =
  'A protocol frame is { id, type, sessionId?, tabId?, ts, payload } with no other top-level key: `type` must be one of the declared message types, `ts` a Unix epoch timestamp in milliseconds, `payload` must match that type’s schema, a routing `sessionId` must equal the session the payload names (its own `sessionId`, or `session.id`) when both are present, and an acting `tabId` must be a non-negative integer Chrome tab id equal to the payload’s own `tabId` when both are present.';

/**
 * What {@link createEnvelope} throws when an explicit routing key contradicts
 * the session its payload names.
 *
 * Constant for the reason every rejection text here is: neither identifier is
 * interpolated. The message type travels in `details`, because it
 * is a name from this package's own vocabulary rather than a value.
 */
const ROUTING_CONTRADICTION_MESSAGE =
  'Cannot build a protocol frame: options.sessionId names a different session than the payload does';

/** The constant next step for {@link ROUTING_CONTRADICTION_MESSAGE}. */
const ROUTING_CONTRADICTION_HINT =
  'Omit options.sessionId so the routing key is taken from the payload, or build the payload for the session the frame is routed to; every receiver refuses a frame whose two sessions disagree.';

/**
 * What {@link createEnvelope} throws when `options.tabId` is not a Chrome tab
 * id: a negative number (`-1` is `chrome.tabs.TAB_ID_NONE`), a fraction, a
 * non-finite number, a value beyond the safe-integer range, or not a number.
 *
 * Constant, so the rejected value is never interpolated; `details`
 * carries only the message type.
 */
const ACTING_TAB_INVALID_MESSAGE =
  'Cannot build a protocol frame: options.tabId is not a non-negative safe-integer Chrome tab id';

/** The constant next step for {@link ACTING_TAB_INVALID_MESSAGE}. */
const ACTING_TAB_INVALID_HINT =
  'Pass the inspected tab’s id as Chrome reports it (a port sender’s tab.id, or chrome.devtools.inspectedWindow.tabId), or omit options.tabId for a frame that acts for no tab.';

/**
 * What {@link createEnvelope} throws when `options.tabId` names a different tab
 * than the payload's own `tabId` does.
 *
 * Constant for the reason {@link ROUTING_CONTRADICTION_MESSAGE} is: neither tab
 * id is interpolated, and `details` carries only the message type.
 */
const ACTING_TAB_CONTRADICTION_MESSAGE =
  'Cannot build a protocol frame: options.tabId names a different tab than the payload does';

/** The constant next step for {@link ACTING_TAB_CONTRADICTION_MESSAGE}. */
const ACTING_TAB_CONTRADICTION_HINT =
  'Set options.tabId to the tab the payload names, or build the payload for the tab the frame acts for; every receiver refuses a frame whose two tabs disagree.';

/**
 * What a frame that is not JSON at all is reported as.
 *
 * Deliberately constant. `JSON.parse`'s `SyntaxError` quotes a slice of its
 * input in `message` — `Unexpected token 'x', "…" is not valid JSON` — so
 * neither that message nor the error itself (as a `cause`) may travel with the
 * rejection: the text it quotes is the frame this product refuses to echo.
 */
const NOT_JSON_MESSAGE = 'Invalid protocol message: the frame is not valid JSON';

/** The constant next step for a frame that is not JSON. */
const NOT_JSON_HINT =
  'A protocol frame is sent as a JSON text frame; encode it with encodeMessage.';

/**
 * Validates an unknown value as a protocol frame, without throwing.
 *
 * The receiving half of this package's contract. Everything that arrives from
 * another process passes through here before anything reads it: the service's
 * socket handler, the VS Code extension's client, the Chrome service worker's
 * bridge, and the panel's port listener.
 *
 * ## How it fails, and what that buys
 *
 * - A frame whose `type` is not a declared message type produces an
 *   `invalid_union_discriminator`-class issue and a plain rejection. That is
 *   exactly how a newer client talking to an older service degrades: the
 *   unrecognised frame is refused and answered with an `error` message, and
 *   neither side crashes or acts on a message it does not understand.
 * - A frame whose `type` is known but whose payload is wrong is validated
 *   against that one member, so the issue paths name the offending payload
 *   fields rather than reporting twenty-six failed branches.
 * - Either way the failure is a value, not an exception. This function never
 *   throws, never logs and never echoes its input: the message and `details`
 *   come from `protocolParseError`, which renders issue paths, issue codes and
 *   schema-declared metadata only (AAP §0.5.2). That matters most here, because
 *   the service logs every parse failure and a rejected frame may carry
 *   telemetry attributes, a database statement, a URL or a bearer credential.
 *
 * @param value Any value believed to be a protocol frame — a parsed WebSocket
 * text frame, a `window.postMessage` payload, a `chrome.runtime` port message.
 * @returns `ok(message)` with the frame narrowed to its one member of
 * {@link ProtocolMessage}, or `err(error)` describing the shape of the failure.
 *
 * @example
 * ```ts
 * const parsed = parseMessage(incoming);
 * if (!parsed.ok) {
 *   socket.send(encodeMessage(createEnvelope('error', toErrorPayload(parsed.error))));
 *   return;
 * }
 * route(parsed.value);
 * ```
 */
export function parseMessage(value: unknown): Result<ProtocolMessage, DebuggenError> {
  const parsed = protocolMessageSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      INVALID_MESSAGE_CODE,
      INVALID_MESSAGE_PREFIX,
      parsed.error.issues,
      INVALID_MESSAGE_HINT,
    ),
  );
}

/**
 * Decodes a raw transport value into a validated protocol frame.
 *
 * The three transports an envelope crosses hand their payload over in two
 * shapes, so this function accepts both and exists so none of them writes its
 * own `try`/`catch`:
 *
 * - a **string** — a WebSocket text frame (`ws` in the service,
 *   `MessageEvent.data` in the service worker) — is `JSON.parse`d and then
 *   validated;
 * - anything **else** is passed straight to {@link parseMessage}, which is the
 *   right behaviour for a structured-clone hop: `window.postMessage` between the
 *   page agent and the isolated-world bridge, and a `chrome.runtime` port
 *   between the bridge, the panel and the service worker, both deliver an object
 *   that was never serialised to text.
 *
 * A binary frame is therefore rejected rather than decoded. Nothing in this
 * product sends one, and this package cannot see a `Buffer` or a `TextDecoder`
 * type — it is built environment-neutral — so a caller that somehow has binary
 * data converts it to a string first.
 *
 * @param raw The value the transport delivered.
 * @returns `ok(message)`, or `err(error)` with code
 * `'PROTOCOL_INVALID_MESSAGE'` for text that is not JSON as well as for JSON
 * that is not a valid frame.
 */
export function decodeMessage(raw: unknown): Result<ProtocolMessage, DebuggenError> {
  if (typeof raw !== 'string') {
    return parseMessage(raw);
  }

  let decoded: unknown;

  try {
    decoded = JSON.parse(raw);
  } catch {
    // The caught SyntaxError is deliberately dropped rather than attached as a
    // `cause`: V8 quotes the offending input in its message. See
    // {@link NOT_JSON_MESSAGE}.
    return err(new DebuggenError(INVALID_MESSAGE_CODE, NOT_JSON_MESSAGE, { hint: NOT_JSON_HINT }));
  }

  return parseMessage(decoded);
}

/**
 * Serialises a frame for a text transport.
 *
 * Trivial by design, and exported anyway so the send path is symmetrical with
 * {@link decodeMessage}, so a transport does not reach for `JSON.stringify`
 * itself, and so the round trip is testable in one place.
 *
 * It does **not** validate. The argument is already a {@link ProtocolMessage},
 * which is only constructible through {@link createEnvelope} or through a
 * successful parse, and validating here would pay the cost of the whole
 * `telemetry.event` batch a second time on the hottest path in the product.
 * Validation is a receiver's job (see the module documentation).
 *
 * Consumers: `client/ws-client.ts`, `apps/local-service/src/server/clients.ts`,
 * `apps/chrome-extension/src/background/ws-bridge.ts`.
 *
 * @param message The frame to serialise.
 * @returns The JSON text to put on the wire.
 */
export function encodeMessage(message: ProtocolMessage): string {
  return JSON.stringify(message);
}

// ---------------------------------------------------------------------------
// Section E — sending: building an envelope around a payload
// ---------------------------------------------------------------------------

/**
 * The injectable parts of {@link createEnvelope}.
 *
 * The fields exist so a caller can be explicit where it matters and a test can
 * be deterministic: with `id` and `ts` supplied, `createEnvelope` is a pure
 * function of its arguments and two runs produce byte-identical frames. An
 * explicit `undefined` means the same as an absent key for every field.
 *
 * `client/ws-client.ts` forwards these options to {@link createEnvelope}
 * unchanged, so a `send` with `{ tabId }` stamps the acting tab without the
 * client knowing anything about it.
 */
export interface CreateEnvelopeOptions {
  /**
   * The session this frame routes to.
   *
   * Supply it when the payload carries no `sessionId` of its own but the frame
   * still belongs to a session. When omitted, {@link createEnvelope} lifts the
   * payload's own `sessionId` if it has one.
   *
   * It may restate the session the payload names, but never contradict it:
   * when the payload names a session — its own `sessionId`, or the `session.id`
   * of a `session.created` / `session.updated` record — a different value here
   * makes {@link createEnvelope} throw `PROTOCOL_INVALID_MESSAGE`, because every
   * receiver would refuse the frame it built.
   */
  readonly sessionId?: SessionId | undefined;
  /**
   * The acting tab: the inspected Chrome tab this frame acts for.
   *
   * Supplied by the Chrome service worker, from Chrome's own port metadata, on
   * every frame it sends for a tab; the service authorizes a DevTools frame for
   * a session only when that session's live binding is this tab's. When
   * omitted the frame carries no `tabId` key at all —
   * {@link createEnvelope} **never** lifts one from the payload, so a service
   * push such as `session.bound`, whose payload names a tab, is unchanged.
   *
   * It must be a Chrome tab id (`tabIdSchema` from `./messages/binding.ts`) and
   * may restate the payload's own `tabId` but never contradict it; either
   * mistake makes {@link createEnvelope} throw `PROTOCOL_INVALID_MESSAGE`,
   * because every receiver would refuse the frame it built.
   */
  readonly tabId?: number | undefined;
  /** The frame identifier. Defaults to a freshly minted `newMessageId()`. */
  readonly id?: MessageId | undefined;
  /**
   * The send timestamp, in epoch milliseconds. Defaults to `nowEpochMs()`.
   * Bounded by `epochMsSchema` at the receiver, so a value on another time base
   * is refused there rather than silently carried.
   */
  readonly ts?: number | undefined;
}

/**
 * Reads a routable `sessionId` off a payload, if it has one.
 *
 * Structural rather than type-driven on purpose: the twenty-six payload schemas
 * are owned by eleven separate modules and most, but not all, carry a
 * `sessionId`. Asking the value — is it a plain record, is its `sessionId` a
 * string — keeps this one function correct for every payload without a
 * per-message table that would have to be maintained beside the registry.
 *
 * `isPlainRecord` (from `./version.ts`) is what rejects an array, a `null` and a
 * class instance, so only an object literal's own `sessionId` can be lifted.
 */
function sessionIdFromPayload(payload: unknown): SessionId | undefined {
  if (!isPlainRecord(payload)) {
    return undefined;
  }

  const candidate = payload.sessionId;

  return typeof candidate === 'string' ? candidate : undefined;
}

/**
 * Builds a frame around a payload: the sending half of this package's contract.
 *
 * ```ts
 * const frame = createEnvelope('session.progress', {
 *   sessionId,
 *   stage: 'investigate',
 *   status: 'done',
 *   message: 'Traced event handler',
 * });
 * ```
 *
 * ## The `sessionId` rule, which is behaviour rather than schema
 *
 * The envelope's `sessionId` is the service's **routing** key — the field
 * `apps/local-service/src/server/clients.ts` broadcasts and authorizes by —
 * while the payload's own subject (its `sessionId`, or the `session.id` of a
 * `session.created` / `session.updated` record) stays the authoritative
 * statement of which session the message is *about*. Those are two jobs, and a
 * frame that carries the second without the first parses perfectly and reaches
 * nobody.
 *
 * So the routing key is resolved here, in this order:
 *
 * 1. `options.sessionId`, when given — and only when it does not contradict the
 *    payload's subject. A payload with no subject (`tab.navigated`, say) may be
 *    routed by the option alone, and an option equal to the subject is merely
 *    explicit; an option naming a *different* session throws
 *    `PROTOCOL_INVALID_MESSAGE`, because {@link protocolMessageSchema} refuses
 *    such a frame on every receiver (see "One frame, one session" in the module
 *    documentation) and a frame nobody accepts is a bug at this call site;
 * 2. otherwise the payload's own `sessionId`, when it has one as a string;
 * 3. otherwise the key is **omitted entirely** — not set to `undefined` — so a
 *    session-less frame such as `client.hello` reaches the receiver with no
 *    `sessionId` key at all rather than with a key `JSON.stringify` would have
 *    dropped anyway, and the two ends agree about which frames are session-less.
 *
 * Lifting in step 2 is what makes it impossible for a call site to forget and
 * silently break routing. It lifts the payload's own `sessionId` only: a
 * `session.created` / `session.updated` frame is routed when its caller supplies
 * the record's id as the option, and is otherwise session-less. It happens in a
 * function rather than in a schema because this package's schemas validate and
 * never rewrite: no `.transform()`, no `.default()`, no `.coerce` appears
 * anywhere in it.
 *
 * ## The `tabId` rule, which is never lifted
 *
 * The envelope's `tabId` is the **acting tab** (see "One frame, one tab" in the
 * module documentation), and it is taken from `options.tabId` alone:
 *
 * 1. a value that is not a Chrome tab id — negative, fractional, non-finite,
 *    beyond the safe-integer range, not a number — throws
 *    `PROTOCOL_INVALID_MESSAGE`;
 * 2. a value that contradicts the payload's own `tabId` throws
 *    `PROTOCOL_INVALID_MESSAGE`, and one equal to it is merely explicit;
 * 3. an absent option leaves the key **omitted entirely**.
 *
 * Unlike the routing key it is never lifted from the payload. The acting tab is
 * the service worker's statement of which tab a frame is for, made from
 * Chrome's port metadata; a payload's `tabId` is data, and every service push
 * whose payload names a tab (`session.bound`) must keep the shape it had.
 *
 * ## What it deliberately does not do
 *
 * It does not validate the payload. The signature is already type-safe — the
 * payload type is resolved from the registry for the `type` given, so the wrong
 * payload is a compile error — and validating every send would double the cost
 * of the `telemetry.event` path, which carries up to a few thousand events per
 * frame while a capture runs. Validation happens on receive
 * ({@link parseMessage}). The two comparisons above are not validation in that
 * sense: each reads at most two fields of the payload, costs the same for a
 * batch of one event as for five thousand, and guards a mistake the compiler
 * cannot see, because the identifiers are plain strings and numbers. The
 * acting-tab check is a scalar check of one option, not of the payload.
 *
 * It does not mutate or copy the payload either: the returned frame holds the
 * caller's own payload reference, which is what keeps a large telemetry batch a
 * single allocation. A caller that intends to keep mutating a payload after
 * sending it should hand over its own copy.
 *
 * Consumers: `client/ws-client.ts` (`send`),
 * `apps/local-service/src/server/clients.ts`,
 * `apps/vscode-extension/src/service/client.ts` and
 * `apps/chrome-extension/src/background/ws-bridge.ts` — which is also the
 * process that wraps the page agent's raw event batches into `telemetry.event`
 * frames, since `@debuggen/telemetry` sits below this package in the layering
 * and the agent bundle never imports protocol.
 *
 * @param type The message being sent.
 * @param payload That message's payload, as its domain module defines it.
 * @param options Optional overrides for the routing key, the acting tab, the
 * frame id and the timestamp.
 * @returns A plain JSON-safe frame, typed as that message's envelope.
 * @throws DebuggenError With code `'PROTOCOL_INVALID_MESSAGE'` when
 * `options.sessionId` names a different session than the payload does, when
 * `options.tabId` is not a Chrome tab id, or when it names a different tab than
 * the payload does. Each message and hint is constant and `details` carries
 * only `type`, so no identifier is echoed. `client/ws-client.ts`
 * calls this inside `tryCatch`, so its `send` answers that error as an `err`
 * rather than throwing.
 *
 * @example
 * ```ts
 * // The service worker relaying a page agent's batch, with `tabId` read from
 * // the relaying runtime port's `sender.tab.id` rather than from the page:
 * const frame = createEnvelope('telemetry.event', { events }, { tabId });
 * ```
 */
export function createEnvelope<K extends MessageType>(
  type: K,
  payload: MessagePayload<K>,
  options?: CreateEnvelopeOptions,
): MessageByType<K> {
  const id = options?.id ?? newMessageId();
  const ts = options?.ts ?? nowEpochMs();
  const explicitSessionId = options?.sessionId;
  const tabId = options?.tabId;

  // The same rule `protocolMessageSchema` applies on receive, checked here so
  // the mistake is reported at the call site that made it rather than as an
  // `error` frame from whichever process refuses the result.
  if (explicitSessionId !== undefined && routingKeyContradictsPayload(explicitSessionId, payload)) {
    throw new DebuggenError(INVALID_MESSAGE_CODE, ROUTING_CONTRADICTION_MESSAGE, {
      hint: ROUTING_CONTRADICTION_HINT,
      details: { type },
    });
  }

  if (tabId !== undefined) {
    // The field schema every receiver applies, on one scalar: a frame carrying
    // `-1` or `7.5` would be refused on arrival, so it is refused here instead.
    if (!tabIdSchema.safeParse(tabId).success) {
      throw new DebuggenError(INVALID_MESSAGE_CODE, ACTING_TAB_INVALID_MESSAGE, {
        hint: ACTING_TAB_INVALID_HINT,
        details: { type },
      });
    }

    if (actingTabContradictsPayload(tabId, payload)) {
      throw new DebuggenError(INVALID_MESSAGE_CODE, ACTING_TAB_CONTRADICTION_MESSAGE, {
        hint: ACTING_TAB_CONTRADICTION_HINT,
        details: { type },
      });
    }
  }

  const sessionId = explicitSessionId ?? sessionIdFromPayload(payload);

  // Literals rather than spreads, so the key order matches the documented shape
  // and an absent routing key or acting tab is an absent key rather than a
  // present `undefined` (`exactOptionalPropertyTypes` makes that distinction
  // real, and JSON.stringify makes it observable). The tab-less pair comes
  // first: it is every frame but the service worker's, and it is exactly the
  // shape this function built before the acting tab existed.
  if (tabId === undefined) {
    return sessionId === undefined
      ? { id, type, ts, payload }
      : { id, type, sessionId, ts, payload };
  }

  return sessionId === undefined
    ? { id, type, tabId, ts, payload }
    : { id, type, sessionId, tabId, ts, payload };
}

// ---------------------------------------------------------------------------
// Section F — narrowing and exhaustiveness
// ---------------------------------------------------------------------------

/**
 * Narrows a frame to one message type.
 *
 * The guard a typed subscription dispatches through: `client/ws-client.ts` holds
 * handlers keyed by message type and uses this to hand each one a
 * {@link MessageByType} for *its* type, so a handler for `'panel.generated'`
 * reads `message.payload.panel` with no cast. It is equally the readable way for
 * app code to test a single type without a `switch`.
 *
 * The narrowed type is written as `Extract<ProtocolMessage, { type: K }>`, which
 * for any concrete `K` *is* {@link MessageByType}`<K>` — `Extract` selects the
 * one union member whose discriminant is `K`, and that member was built from
 * {@link MessageByType} in the first place. The spelling is the compiler's
 * requirement rather than a distinction: a type predicate's type must be
 * assignable to the parameter's type, and TypeScript cannot see that for an
 * unresolved `MessageByType<K>` (it would have to distribute `K` first), whereas
 * a filter over the union is assignable to the union by construction.
 *
 * @param message Any validated frame.
 * @param type The message type to test for.
 * @returns `true` when `message` is of that type, narrowing it for the compiler.
 *
 * @example
 * ```ts
 * if (isMessageOfType(message, 'session.progress')) {
 *   view.appendProgress(message.payload.stage, message.payload.message);
 * }
 * ```
 */
export function isMessageOfType<K extends MessageType>(
  message: ProtocolMessage,
  type: K,
): message is Extract<ProtocolMessage, { type: K }> {
  return message.type === type;
}

/**
 * Fails on a message type a `switch` did not handle.
 *
 * Call it in the `default` arm of an exhaustive `switch` over `message.type`: in
 * a complete switch the parameter is `never`, so the call compiles; add a
 * twenty-seventh message type and the arm receives a real frame, the parameter
 * stops being `never`, and `tsc -b` reports the unhandled case at the router
 * rather than letting a frame fall through it at run time.
 *
 * Built on `assertNever` from `@debuggen/shared`, which is this package's one
 * exhaustiveness tool, so the thrown `DebuggenError` looks like every other
 * internal fault in the product.
 *
 * @param message The frame the switch did not handle — `never` in correct code.
 * @returns Never; it always throws.
 *
 * @example
 * ```ts
 * switch (message.type) {
 *   case 'session.progress':
 *     return onProgress(message.payload);
 *   // … every other type …
 *   default:
 *     return assertExhaustiveMessage(message);
 * }
 * ```
 */
export function assertExhaustiveMessage(message: never): never {
  return assertNever(message, 'Unhandled protocol message type');
}
