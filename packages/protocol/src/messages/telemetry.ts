/**
 * The two telemetry payloads of the WebSocket protocol: `telemetry.event`, the
 * batch a producer sends *inward*, and `telemetry.tail`, the redacted replay
 * the service sends *outward* to the DevTools panel (AAP §0.4.2).
 *
 * ## The one distinction this module exists to keep
 *
 * `@debuggen/telemetry` defines two schemas for the same observation, and which
 * one a payload embeds is a correctness *and* a privacy decision:
 *
 * - **`TelemetryEventIngress`** — what a producer sends. Every core field and
 *   none of the three the service assigns. A producer is *told* which session
 *   and capture it is serving (`agent.config`, `server-agent.config`), but that
 *   is context for its own hooks and never authority over attribution: the
 *   service decides which session an event belongs to from the connection it
 *   arrived on (`apps/local-service/src/telemetry/attribute.ts`), and `ingestSeq`
 *   is assigned by the store, so no producer could supply it at all. The ingress
 *   schema is strict, which means a producer that sent `sessionId`, `captureId`
 *   or `ingestSeq` is *rejected* rather than believed. That rejection is the
 *   contract: embedding the persisted schema here would let a page — any page,
 *   since the agent runs inside the inspected document — attribute its own
 *   events to a session it was never bound to.
 * - **`TelemetryEvent`** — what the store holds: the ingress shape plus
 *   `sessionId`, `captureId` and the store-assigned `ingestSeq`. By the time an
 *   event carries those, it has been through `telemetry/ingest.ts`, which means
 *   it has been through the redaction layer
 *   (`packages/telemetry/src/redaction/**`, AAP §0.5.2) — header values,
 *   credential-shaped strings, URL query values, SQL literals and prop previews
 *   all already replaced. The live tail therefore carries redacted data *by
 *   construction*, never because this module checked: it validates shape, and
 *   the redaction guarantee comes from the one place that can give it.
 *
 * Embedding the wrong schema in either direction is the whole failure mode:
 * unattributed events into the store one way, unredacted events onto a screen
 * the other. Both schemas are therefore **imported**, never restated — AAP
 * §0.2.3 and §0.9.1 make `packages/telemetry/src/schema/event.ts` the single
 * definition, and a hand-written shape here would inherit none of its
 * guarantees (32/16-hex correlation ids, kind↔tier agreement, epoch-millisecond
 * bounds, JSON-serialisable attributes) while looking as though it had.
 *
 * ## How a batch reaches this payload
 *
 * The page agent has **no socket of its own**. It posts raw event batches over
 * `window.postMessage` to the isolated-world bridge
 * (`apps/chrome-extension/src/content/bridge.ts`), which forwards them over a
 * runtime port to the MV3 service worker, which is what wraps them in a
 * protocol envelope and sends the `telemetry.event` frame. The agent bundle
 * never imports `@debuggen/protocol` (AAP §0.2.3) — which is exactly why this
 * payload is a bare `{ events }` and why the envelope, not the payload, carries
 * routing.
 *
 * ## What this module does not own
 *
 * So that nobody adds it here:
 *
 * - **The event shape.** `@debuggen/telemetry` owns it, including the
 *   `TelemetryEventIngress`/`TelemetryEvent` split this module depends on.
 * - **The HTTP ingest body.** `POST /telemetry/ingest` takes
 *   `{ projectRoot, events: TelemetryEventIngress[] }` — the Node preload's
 *   route, which needs a project root because a launched dev server is scoped to
 *   one (AAP §0.4.2, §0.5.6). That schema is `telemetryIngestRequestSchema` and
 *   it belongs to `../http.ts`, which imports the ingress schema from
 *   `@debuggen/telemetry` directly. This module defines no HTTP body at all.
 * - **Redaction.** `packages/telemetry/src/redaction/**`, applied by
 *   `apps/local-service/src/telemetry/ingest.ts` before anything is persisted or
 *   broadcast (AAP §0.5.2).
 * - **The time base.** `startTime` is Unix epoch **milliseconds** as a double
 *   with sub-millisecond precision and `duration` is milliseconds; both are
 *   enforced by the event schema upstream and are not re-validated here.
 * - **Ordering.** Canonical ordering within a trace is parent before child, then
 *   `startTime`, then `(producerId, seq)`, then `ingestSeq` as the final,
 *   always-distinct tie-breaker (AAP §0.2.3). The comparator lives in
 *   `packages/telemetry/src/correlation/correlator.ts`; a payload is a
 *   transport, so nothing here sorts, groups or deduplicates.
 * - **The envelope, routing and attribution.** `../envelope.ts` wraps a payload
 *   in `{ id, type, sessionId?, ts, payload }` and the service decides which
 *   clients a frame reaches.
 *
 * ## Import rules this module obeys
 *
 * Only `zod`, `../version.js` and the packages below `protocol` in the layering
 * (AAP §0.2.2) appear in the import block. No sibling in `./`, no `../envelope.js`
 * and no `../http.ts`: every one of those imports *this* file, directly or
 * through `./index.js`, so an import back would close a cycle. No `node:*` and no
 * `@debuggen/shared/node` either — this package is environment-neutral
 * (`types: []`, `platform: 'neutral'`) because the DevTools panel, the editor
 * webview and the MV3 service worker load it alongside the local service.
 *
 * Every export is named; there is no default export.
 */

import { z } from 'zod';

import { err, ok } from '@debuggen/shared';
import type { DebuggenError, Result } from '@debuggen/shared';
import { telemetryEventIngressSchema, telemetryEventSchema } from '@debuggen/telemetry';

import { protocolParseError } from '../version.js';

// ---------------------------------------------------------------------------
// Section A — bounds and primitives
// ---------------------------------------------------------------------------

/**
 * The most events one payload in this module may carry.
 *
 * Derived from the producers' own memory bounds rather than chosen: the browser
 * agent buffers at most 5 000 completed events while the bridge is away
 * (AAP §0.5.5, `MAX_BUFFERED_EVENTS` in
 * `packages/telemetry/src/browser/transport.ts`) and the Node preload's exporter
 * caps its buffer at the same number. No honest producer can therefore assemble
 * a larger batch, which makes this a ceiling on a malformed or hostile frame and
 * not a quota a working capture can hit: in practice the agent flushes at most
 * 200 events per bridge frame and the preload posts 256 per request, both far
 * below this bound.
 *
 * Why it is a *hard* bound rather than advice: a payload is parsed before it is
 * persisted, and the parse walks every element. An unbounded array turns one
 * frame into unbounded work in the service's ingest loop and unbounded rows in
 * `telemetry_events`, which is the one place a capture can hurt the machine it
 * is observing.
 *
 * **Module-local on purpose, two reasons.** `@debuggen/telemetry` already
 * exports the identifier `MAX_EVENTS_PER_BATCH` for the agent's 200-event flush
 * trigger, so exporting a second one with the value 5 000 would put two
 * different numbers under one name in the same consumer's scope; and no consumer
 * needs this one — the service worker forwards batches a producer sized, and the
 * correct response to an oversized frame is the rejection below, not a caller's
 * arithmetic.
 */
const MAX_EVENTS_PER_BATCH = 5000;

/**
 * The longest an identifier field on a payload in this module may be.
 *
 * Matches the bound the event schema applies to `sessionId`, `captureId` and
 * `producerId`: every identifier the product generates is 20 characters
 * (`<three letters>_<sixteen alphanumerics>`, `ID_PREFIXES` in
 * `@debuggen/shared`), so 64 leaves room for a future scheme while keeping a
 * stray blob of page data out of a field the service uses as a store key.
 *
 * Deliberately **no format check**. `@debuggen/shared` publishes patterns for
 * trace and span ids only; the prefixed-id shape is asserted in that package's
 * own tests and is not exported as a regular expression, so there is nothing to
 * import — and re-deriving one here is precisely the duplicate definition the
 * single-source rule forbids.
 */
const MAX_ID_LENGTH = 64;

/**
 * The failure message every identifier field in this module reports.
 *
 * One string for all three checks (non-empty, bounded, already trimmed): the
 * producer reading it needs to know what an identifier must look like, not which
 * bound it missed, and one message means a received value can never be echoed
 * back by accident.
 */
const IDENTIFIER_EXPECTATION = `expected a non-empty identifier of at most ${String(
  MAX_ID_LENGTH,
)} characters with no leading or trailing whitespace`;

/**
 * An opaque identifier field: non-empty, bounded, and free of surrounding
 * whitespace.
 *
 * Whitespace is rejected rather than trimmed, because trimming is a transform
 * and no schema in this package transforms: what a producer sent is what a
 * consumer reads, so a padded id is a bug that gets reported instead of quietly
 * repaired.
 *
 * @returns A string schema for an opaque product identifier.
 */
function identifierSchema(): z.ZodString {
  return z
    .string()
    .min(1, { error: IDENTIFIER_EXPECTATION })
    .max(MAX_ID_LENGTH, { error: IDENTIFIER_EXPECTATION })
    .refine((value) => value.trim().length === value.length, {
      error: IDENTIFIER_EXPECTATION,
    });
}

/**
 * What an empty batch is answered with.
 *
 * An empty array carries no information and costs a round trip, an envelope, a
 * parse and a log line to say nothing, so it is a producer bug rather than a
 * quiet no-op — and it is worth naming as one, because a transport that flushes
 * on a timer is exactly the code that drifts into posting empty frames. Both
 * producers already avoid it (`packages/telemetry/src/browser/transport.ts` and
 * `../node/exporter.ts` flush only a non-empty buffer); this is the check that
 * keeps them honest.
 */
const EVENTS_MIN_EXPECTATION = 'expected at least one telemetry event: an empty batch is a no-op';

/** What an oversized batch is answered with. */
const EVENTS_MAX_EXPECTATION = `expected at most ${String(
  MAX_EVENTS_PER_BATCH,
)} telemetry events in one batch`;

/**
 * The array schema shared by both payloads, over whichever event schema the
 * direction calls for.
 *
 * A factory rather than two literals, so the two payloads cannot drift apart on
 * their bounds or their messages while still differing — as they must — on the
 * element schema.
 *
 * @typeParam S The element schema: the ingress schema inbound, the persisted
 * schema outbound. Never a locally written event shape.
 * @param element The event schema imported from `@debuggen/telemetry`.
 * @returns A bounded, non-empty array schema over `element`.
 */
function eventBatchSchema<S extends z.ZodType>(element: S): z.ZodArray<S> {
  return z
    .array(element)
    .min(1, { error: EVENTS_MIN_EXPECTATION })
    .max(MAX_EVENTS_PER_BATCH, { error: EVENTS_MAX_EXPECTATION });
}

// ---------------------------------------------------------------------------
// Section B — the two payload schemas
// ---------------------------------------------------------------------------

/**
 * `telemetry.event` — a batch of events exactly as a producer sent them.
 *
 * Sent by the Chrome service worker on behalf of the page agent, which has no
 * socket of its own; consumed by `apps/local-service/src/telemetry/ingest.ts`,
 * which validates, keys, redacts, attributes and stores each element. It is the
 * browser path only: the Node preload holds a WebSocket for its
 * `server-agent.config` control frames but posts its spans to
 * `POST /telemetry/ingest` instead, under the `{ projectRoot, events }` body
 * `../http.ts` owns — the project root is how a server producer's events are
 * attributed at all, and a credential scoped to one project is what makes that
 * claim trustworthy (AAP §0.4.2, §0.5.6).
 *
 * **This payload has no `sessionId`, and that is deliberate — do not "fix" it.**
 * It is the only payload in this folder without one, for three independent
 * reasons, each of which is sufficient on its own:
 *
 * 1. **Routing already happened.** The envelope (`../envelope.ts`) carries
 *    `sessionId` for the frames that need it, and the service resolves a
 *    telemetry frame to a session from the *connection* — the tab binding for a
 *    browser producer, the credential's scoped `projectRoot` and the active
 *    capture window for a server producer (AAP §0.4.2, §0.5.6).
 * 2. **A producer must not self-attribute.** The agent *is* told a session id
 *    when it is armed, and its bridge frame carries that id as context for the
 *    service worker — but a value that originates page-side must never become
 *    the store key. Accepting one here would let a document nominate the session,
 *    and therefore the stored capture and the generated panel, its events land
 *    in. Attribution is the service's job alone, which is what the strict
 *    ingress schema enforces element by element by rejecting `sessionId`,
 *    `captureId` and `ingestSeq`.
 * 3. **One rule for every producer.** A browser batch arrives over this
 *    WebSocket payload and a server batch over the HTTP ingest body, and both
 *    are attributed by the same code from the same evidence. A `sessionId` here
 *    would be a second, weaker path to the same field — present on one transport,
 *    absent on the other, authoritative on neither.
 */
export const telemetryEventPayloadSchema = z.strictObject({
  /**
   * The batch, each element validated against the **ingress** schema — never
   * the persisted one, so an element carrying attribution is rejected here at
   * the transport boundary rather than reaching the store.
   */
  events: eventBatchSchema(telemetryEventIngressSchema),
});

/**
 * A batch of producer events as it crosses the WebSocket boundary inbound.
 *
 * Inferred from {@link telemetryEventPayloadSchema}, so the validator and the
 * type are one statement and `events` is exactly `TelemetryEventIngress[]`.
 */
export type TelemetryEventPayload = z.infer<typeof telemetryEventPayloadSchema>;

/**
 * `telemetry.tail` — the redacted live tail the service streams to the DevTools
 * panel during a capture (AAP §0.4.2).
 *
 * Embeds the **persisted** event schema, because the tail replays events that
 * have already been ingested: redacted by
 * `apps/local-service/src/telemetry/ingest.ts` before anything was broadcast
 * (AAP §0.5.2), attributed to a session and a capture, and stamped with the
 * store's `ingestSeq`. That last field is what lets the panel's event log show a
 * stable order and reconcile a streamed event with the same event fetched later
 * through `POST /sessions/:id/panel-data`, so accepting an unattributed event
 * here would produce a log that cannot be reconciled with anything.
 *
 * `sessionId` *is* present on this payload, and for the mirror image of the
 * reason it is absent above: the service is the sender, the panel may hold more
 * than one session in view across a rebind, and a tail frame has to say which
 * session it belongs to without the receiver inspecting its elements.
 */
export const telemetryTailPayloadSchema = z.strictObject({
  /** The session whose capture these events belong to. */
  sessionId: identifierSchema(),

  /**
   * The events, each validated against the **persisted** schema: already
   * redacted, already attributed, already stamped with `ingestSeq`.
   */
  events: eventBatchSchema(telemetryEventSchema),
});

/**
 * A redacted live-tail frame as it crosses the WebSocket boundary outbound.
 *
 * `events` is exactly `TelemetryEvent[]` — the store's shape, which is what the
 * panel's event log, detail drawer and source links are written against.
 */
export type TelemetryTailPayload = z.infer<typeof telemetryTailPayloadSchema>;

// ---------------------------------------------------------------------------
// Section C — parsing
//
// Non-throwing, `Result`-returning, and deliberately silent about *what*
// arrived: a rejected telemetry batch is the highest-risk leak surface in this
// folder after a credential, because its elements carry request URLs with query
// parameters, database statements, header values and React prop previews. An
// error raised here is logged by the service, may be persisted with the session
// and may be shown in both user interfaces, and it passes through neither the
// redaction layer nor the outbound model guard — so the rejected value is not
// read at all, not even to count its elements.
// ---------------------------------------------------------------------------

/** The hint offered when an inbound producer batch fails validation. */
const EVENT_HINT =
  'A telemetry.event payload is exactly { events }: between 1 and ' +
  `${String(MAX_EVENTS_PER_BATCH)} producer events, each carrying an id and producerId, a 32-hex ` +
  'traceId, a 16-hex spanId, a kind and tier that agree, a name, a Unix epoch millisecond ' +
  'startTime, a non-negative duration, a status, an attributes object and a zero-based seq. It ' +
  'carries no sessionId: the envelope carries routing, and sessionId, captureId and ingestSeq are ' +
  'assigned by the service at ingest and must not be sent by a producer.';

/** The hint offered when an outbound live-tail frame fails validation. */
const TAIL_HINT =
  'A telemetry.tail payload is { sessionId, events }: an identifier and between 1 and ' +
  `${String(MAX_EVENTS_PER_BATCH)} persisted events, each carrying every field a producer sends ` +
  'plus the attribution the service assigns — sessionId, captureId and a one-based ingestSeq. An ' +
  'event that has not been through ingest belongs in a telemetry.event payload instead.';

/**
 * Validates an unknown value as a {@link TelemetryEventPayload}, without
 * throwing.
 *
 * This is how a `telemetry.event` frame's payload becomes a typed batch. The
 * batch is rejected or accepted as a whole, which is the right granularity for a
 * transport: a frame whose shape is wrong is not a frame with one bad element,
 * and the service's ingest loop re-validates element by element with
 * `parseTelemetryEventIngress` so that one malformed event can be dropped
 * without losing the capture (AAP §0.5.5).
 *
 * The returned error is built by `protocolParseError`, which renders the issues
 * through `describeZodIssues`: issue paths, issue codes and schema-declared
 * metadata only, never a received value. The path is what makes a failure
 * actionable — `events[3].startTime (too_small min=1577836800000)` names the
 * offending element and field — and `details.issueCount` carries how many issues
 * there were, so a log line is useful without echoing anything captured.
 *
 * @param value Any value believed to be a `telemetry.event` payload.
 * @returns `ok(payload)` with the parsed batch, or `err(error)` describing the
 * shape of the failure and nothing of the data that caused it.
 *
 * @example
 * ```ts
 * const parsed = parseTelemetryEventPayload(envelope.payload);
 * if (!parsed.ok) {
 *   logger.warn('rejected a telemetry batch', parsed.error.details);
 *   return;
 * }
 * for (const event of parsed.value.events) {
 *   ingest(event);
 * }
 * ```
 */
export function parseTelemetryEventPayload(
  value: unknown,
): Result<TelemetryEventPayload, DebuggenError> {
  const parsed = telemetryEventPayloadSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid telemetry.event payload',
      parsed.error.issues,
      EVENT_HINT,
    ),
  );
}

/**
 * Validates an unknown value as a {@link TelemetryTailPayload}, without
 * throwing.
 *
 * Used by the DevTools panel on every tail frame it receives, and by the service
 * where it asserts its own outbound shape. A failure here is a product bug
 * rather than a producer's mistake — the sender is the service — so the hint
 * names the attribution the payload was missing, which is the mistake this
 * schema exists to catch: broadcasting an event that has not been through
 * ingest, and therefore has not been redacted.
 *
 * The same privacy discipline as {@link parseTelemetryEventPayload} applies to
 * the error it returns.
 *
 * @param value Any value believed to be a `telemetry.tail` payload.
 * @returns `ok(payload)` with the parsed frame, or `err(error)` describing the
 * shape of the failure.
 */
export function parseTelemetryTailPayload(
  value: unknown,
): Result<TelemetryTailPayload, DebuggenError> {
  const parsed = telemetryTailPayloadSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid telemetry.tail payload',
      parsed.error.issues,
      TAIL_HINT,
    ),
  );
}

// ---------------------------------------------------------------------------
// Section D — the registry
// ---------------------------------------------------------------------------

/**
 * This module's contribution to the protocol's message catalog: each message
 * type it owns, mapped to the schema that validates that message's payload.
 *
 * `../envelope.ts` assembles the discriminated union `parseMessage` switches on
 * from the registries the `messages/*.ts` modules export, so a message type
 * reaches the wire only by appearing here. The keys are the wire names verbatim
 * (AAP §0.4.2) — `'telemetry.event'` and `'telemetry.tail'`, dotted and
 * lower-case — because they are compared against the `type` field of a frame a
 * different process wrote, where a rename is a protocol break rather than a
 * refactor.
 *
 * Frozen, and `as const` so the key set is a literal union rather than `string`:
 * the union is what lets the envelope map a `type` to its payload schema without
 * a cast, and the freeze means a consumer that reaches for the catalog cannot
 * substitute a laxer schema for a message type at runtime — the one edit that
 * would silently disable a validation boundary everywhere at once.
 */
export const TELEMETRY_MESSAGE_PAYLOADS = Object.freeze({
  'telemetry.event': telemetryEventPayloadSchema,
  'telemetry.tail': telemetryTailPayloadSchema,
} as const);
