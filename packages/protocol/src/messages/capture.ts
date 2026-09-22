/**
 * The capture window: the two WebSocket broadcasts that open and close it, and
 * the two HTTP operations that drive it.
 *
 * A *capture* is the interval during which the armed telemetry producers — the
 * MAIN-world browser agent in the developer's page and the Node preload inside
 * the target project's dev server — are allowed to report. Nothing in this
 * product records continuously: the session's instrumentation plan is installed
 * first, the developer is asked to reproduce the issue, and only the events that
 * arrive between `capture.start` and `capture.stop` become the evidence the
 * analysis stage may cite (AAP §0.4.2).
 *
 * ## The request/broadcast split, which is why four names describe two events
 *
 * The four names in this module are two pairs, and the difference between them
 * is the transport rather than the meaning:
 *
 * ```text
 * capture.start    HTTP  VS Code or DevTools → service   {} → { captureId }
 * capture.stop     HTTP  VS Code or DevTools → service   {} → { summary }
 * capture.started  WS    service → every client of the session
 *                                                  { sessionId, captureId }
 * capture.stopped  WS    service → every client of the session
 *                                         { sessionId, captureId, summary }
 * ```
 *
 * The caller that pressed the button learns the outcome synchronously, in the
 * HTTP response: the new capture's id, or the summary of the one that just
 * closed. Every *other* client of that session — the editor webview when the
 * DevTools panel started the capture, the panel when the editor did, a second
 * surface that reopened the session — learns by broadcast, and the broadcast
 * carries the `sessionId` the HTTP response does not need because the caller
 * named it in the route. That asymmetry is deliberate: a client never has to
 * poll to discover a capture it did not start, and no client has to reconcile
 * two copies of the same fact arriving by two routes.
 *
 * ## Semantics this module documents and does not implement
 *
 * Shapes are all this file owns. The behaviour below belongs to the service's
 * session manager and state machine, and is recorded here because a reader of
 * these schemas needs it to use them correctly:
 *
 * - **One capture owner per project at a time.** At most one session may hold a
 *   capture on a project, because both producers report to a single
 *   `server-agent.config` recipient. A `capture.start` for a project whose dev
 *   server is already captured by another session is refused with HTTP 409 and a
 *   body naming the `owningSessionId` — a shape that belongs to `../http.ts`
 *   with the rest of the route's error envelope, and is deliberately **not**
 *   defined here (AAP §0.4.2).
 * - **A capture that produced nothing still stops normally.** An empty capture
 *   is a success on this contract: {@link captureStopResponseSchema} and
 *   {@link captureStoppedPayloadSchema} carry a perfectly valid `CaptureSummary`
 *   whose `eventCount` is zero, and it is the service — not this schema — that
 *   then skips analysis, returns the session to `ready` and asks the developer
 *   to interact with the page before capturing again (AAP §0.5.5). Refusing the
 *   payload would turn a recoverable, expected outcome into a transport error.
 * - **The same `captureId` continues across a same-origin page reload.** The
 *   statically declared agent runs again at `document_start`, the Chrome service
 *   worker re-sends `agent.config` for the tab's session, and the capture that
 *   was already open keeps its id, so a reload appears in the evidence as a
 *   navigation rather than as a boundary. A reload therefore produces no second
 *   `capture.started`; a different origin unbinds the tab instead (AAP §0.5.5).
 * - **Route paths, HTTP methods, status codes and authentication are
 *   `../http.ts`'s business.** `POST /sessions/:id/capture/start` and its
 *   sibling, the bearer credential and role scoping of AAP §0.5.6, and the 409
 *   above are declared there, against the schemas below.
 *
 * ## `capture.start` and `capture.stop` are HTTP operations, not message types
 *
 * Five names in this folder are **HTTP-only**: `session.create`,
 * `session.question`, `session.end`, `capture.start` and `capture.stop`. They
 * are the user's own names for these operations (prompt §16) and are preserved
 * character for character, but they must never enter `MESSAGE_TYPES`, never key
 * `MESSAGE_PAYLOAD_SCHEMAS`, and never appear as a `type` in the envelope's
 * discriminated union — a client that sent `{ type: 'capture.start' }` over the
 * WebSocket would be rejected by `parseMessage`, which is the intended answer.
 * This module keeps the two families in separate frozen maps,
 * {@link CAPTURE_MESSAGE_PAYLOADS} and {@link CAPTURE_HTTP_PAYLOADS}, so
 * `./index.ts` can merge each into the right registry without having to know
 * which name belongs where.
 *
 * ## Constraints this file inherits from the package
 *
 * - **Nothing in `packages/protocol/src` may be imported except `../version.ts`.**
 *   `../envelope.js`, `../http.js`, `../client/**` and every sibling in this
 *   folder sit *above* the payload modules; importing one would close a cycle
 *   through the envelope. `../http.ts` imports this file, not the reverse, and
 *   the two response schemas it surfaces —
 *   {@link captureStartResponseSchema} and {@link captureStopResponseSchema} —
 *   are **defined here once and re-exported there**. A second declaration of
 *   either in `../http.ts` is the duplicated definition AAP §0.9.1 forbids.
 * - **Environment-neutral.** No `node:*` builtin, no `@debuggen/shared/node`
 *   entry, no `ws`: this bundle is loaded by the service, by the MV3 service
 *   worker, by the DevTools panel and by the editor webview alike.
 * - **Byte-faithful parsing.** No `.transform()`, no `.coerce`, no `.default()`
 *   and no `.catch()`. A schema here validates and never rewrites, so what a
 *   producer sent is what a consumer reads.
 * - **Leak-free failures.** Every parse helper reports through
 *   {@link protocolParseError}, which renders only issue paths, issue codes and
 *   schema-declared metadata. A `CaptureSummary` carries redacted URLs, SQL
 *   statements, component names and file paths; none of it may reach a log line
 *   or a user-interface banner through an error message (AAP §0.5.2).
 *
 * Every export is named; there is no default export, and importing this module
 * has no side effect.
 */

import { z } from 'zod';

import { err, ok } from '@debuggen/shared';
import type { DebuggenError, Result } from '@debuggen/shared';
import type { CaptureSummary } from '@debuggen/telemetry';

import { opaqueSchema, protocolParseError } from '../version.js';

// ---------------------------------------------------------------------------
// Section A — module-local primitives
// ---------------------------------------------------------------------------

/**
 * The longest identifier any payload in this module will consider.
 *
 * The folder-canonical bound, repeated as a module-local constant in each
 * `messages/*.ts` file rather than exported from one of them: a payload module
 * is re-exported wholesale by `./index.ts`, and a name exported from several of
 * them would be an ambiguous re-export rather than a shared constant.
 *
 * The ids this product mints are twenty characters — a three-letter kind prefix,
 * an underscore and sixteen random characters (`@debuggen/shared`'s `newId`) —
 * so sixty-four is generous room for an id from an older build or a longer
 * prefix, while still refusing a frame that arrived with a megabyte where a
 * session id belonged, on a length check rather than on a pattern match.
 */
const MAX_ID_LENGTH = 64;

/**
 * An opaque identifier as a payload field: a non-empty string of at most
 * {@link MAX_ID_LENGTH} characters.
 *
 * Deliberately **not** the `ses_`/`cap_` prefix patterns. The prefix vocabulary
 * and the id grammar belong to `@debuggen/shared`'s `ids` module, which mints
 * every id in the product and guards the ones read back out of the store;
 * re-deriving either here would be a second definition of a shape this package
 * does not own, and it would reject a stored session from a build whose prefixes
 * differed. The transport's job is the one check the transport can make — that
 * the field is a string of plausible length — and identity is resolved where the
 * id is looked up.
 *
 * Module-local for the same reason {@link MAX_ID_LENGTH} is.
 */
const idSchema = z
  .string()
  .min(1, { error: 'expected a non-empty identifier' })
  .max(MAX_ID_LENGTH, {
    error: `expected an identifier of at most ${String(MAX_ID_LENGTH)} characters`,
  });

// ---------------------------------------------------------------------------
// Section B — the embedded capture summary
// ---------------------------------------------------------------------------

/**
 * The capture summary as a payload field: the upstream `CaptureSummary` **type**
 * from `@debuggen/telemetry`, checked shallowly and named in the failure.
 *
 * ## Why this is opaque, and why that is the right answer
 *
 * `CaptureSummary` is owned by `packages/telemetry/src/aggregate/summary.ts` —
 * the one place the fixed metric set is computed — and its owner publishes it as
 * a TypeScript interface with no Zod schema. Hand-writing a structural schema
 * for it here would restate a twenty-one-field shape this package does not own,
 * across `metrics`, `topSpans`, `topRenders`, `topRequests`, `topQueries`,
 * `errors` and an optional component tree, each with its own nested member
 * types. That is exactly the second definition AAP §0.2.3 and §0.9.1 forbid:
 * every shape crossing a process boundary is defined once, and a copy here would
 * drift the moment an aggregate gained a field — silently rejecting, at the
 * transport, a summary the producer had just computed correctly.
 *
 * So the **type** keeps coming from its owner through an `import type`, and
 * {@link opaqueSchema} supplies the runtime check: `z.custom<CaptureSummary>`
 * with the default plain-record guard. The check is never omitted, which is
 * load-bearing — a bare `z.custom<T>()` accepts `undefined`, and an absent
 * summary would then flow into a panel as a valid value and fail far from its
 * cause. No key guard is layered on top of the record check: the identifying
 * fields of the aggregate are the aggregate's business, and listing a few of them
 * here would start the same restatement on a smaller scale.
 *
 * ## What it therefore does and does not guarantee
 *
 * It rejects `undefined`, `null`, an array and every primitive — the failure
 * modes a transport boundary actually sees, including a JSON round trip that
 * dropped the field. It does **not** verify that `metrics` holds fourteen
 * entries or that `durationMs` is a number: a malformed summary is not caught
 * here. That is an accepted trade rather than an oversight. The summary is
 * computed inside this machine's own trusted service process by the package that
 * defines the type, so the service is the validating party; the protocol layer
 * names the field, types it for the consumer and checks that something object
 * shaped arrived.
 *
 * `z.infer<typeof captureSummarySchema>` is `CaptureSummary`, not `unknown` —
 * see {@link CaptureSummaryTypePreserved} for the compile-time proof.
 */
export const captureSummarySchema = opaqueSchema<CaptureSummary>('CaptureSummary');

// ---------------------------------------------------------------------------
// Section C — the WebSocket broadcasts
// ---------------------------------------------------------------------------

/**
 * `capture.started` — the service tells every client of a session that a capture
 * window is open.
 *
 * Sent once when `capture.start` succeeds, to the editor client, the bound tab's
 * DevTools panel and any other client of that session, the caller included: a
 * client that started the capture over HTTP and also receives the broadcast sees
 * one fact twice by design, keyed by the same `captureId`, which is what lets
 * every surface render "Capturing…" from the broadcast alone without knowing who
 * pressed the button.
 *
 * Both fields are required. `sessionId` is what makes the frame routable by a
 * client that holds several sessions open, and `captureId` is the key every
 * subsequent telemetry event, the stop broadcast, the capture row in the store
 * and the generated panel's provenance all carry.
 *
 * `strictObject`, like every payload in this folder: an unrecognised key is a
 * producer that disagrees with this contract, and refusing it is how that
 * disagreement is found in development rather than inferred from a missing value
 * in production.
 */
export const captureStartedPayloadSchema = z.strictObject({
  /** The session whose capture opened. */
  sessionId: idSchema,
  /** The capture window that opened; the key every event of it carries. */
  captureId: idSchema,
});

/** The validated payload of a `capture.started` broadcast. */
export type CaptureStartedPayload = z.infer<typeof captureStartedPayloadSchema>;

/**
 * `capture.stopped` — the service tells every client of a session that the
 * capture window closed, and hands them the summary of what it collected.
 *
 * The summary is the whole point of the frame: a client that receives it can
 * render metric cards, counts and top-N lists without issuing a single
 * `panel-data` query, which is what keeps the "Stop capture" transition instant
 * in both surfaces. A capture that collected nothing still arrives here with a
 * valid summary whose `eventCount` is zero (AAP §0.5.5); the emptiness is a fact
 * about the capture, not a fault in the message.
 */
export const captureStoppedPayloadSchema = z.strictObject({
  /** The session whose capture closed. */
  sessionId: idSchema,
  /** The capture window that closed. */
  captureId: idSchema,
  /** What the capture collected, computed by `@debuggen/telemetry`. */
  summary: captureSummarySchema,
});

/** The validated payload of a `capture.stopped` broadcast. */
export type CaptureStoppedPayload = z.infer<typeof captureStoppedPayloadSchema>;

/**
 * The WebSocket message types this module contributes, with their payload
 * schemas.
 *
 * Merged by `./index.ts` into `MESSAGE_PAYLOAD_SCHEMAS`, from which
 * `MESSAGE_TYPES` and the envelope's discriminated union are derived. **Exactly
 * two keys**, and neither is `capture.start` or `capture.stop`: those are HTTP
 * operations and live in {@link CAPTURE_HTTP_PAYLOADS} instead, for the reason
 * the module header states.
 *
 * Frozen so a consumer cannot add a type to the protocol at runtime, and
 * `as const` so the keys survive as literal types — which is what lets the
 * envelope's union be derived from this object rather than declared beside it.
 */
export const CAPTURE_MESSAGE_PAYLOADS = Object.freeze({
  'capture.started': captureStartedPayloadSchema,
  'capture.stopped': captureStoppedPayloadSchema,
} as const);

// ---------------------------------------------------------------------------
// Section D — the HTTP operations
//
// `capture.start` and `capture.stop` are the user's own operation names
// (prompt §16), preserved character for character. They are **HTTP operations,
// not WebSocket message types**: nothing below may enter `MESSAGE_TYPES`,
// `MESSAGE_PAYLOAD_SCHEMAS` or the envelope's discriminated union, and the same
// holds for the other three HTTP-only names of this folder — `session.create`,
// `session.question` and `session.end`.
//
// The four schemas below are the SINGLE definition of these bodies.
// `../http.ts` binds them to `POST /sessions/:id/capture/start` and
// `POST /sessions/:id/capture/stop`, adds the route's status codes — including
// the 409 whose `owningSessionId` body belongs there, not here — and re-exports
// `captureStartResponseSchema` and `captureStopResponseSchema` under those exact
// names. It must not redeclare them.
// ---------------------------------------------------------------------------

/**
 * The `capture.start` request body: empty.
 *
 * Everything the service needs is already in scope when the route runs. The
 * session comes from the path, the installed plan and the armed hooks come from
 * the session record, and the capture's id is minted by the service rather than
 * proposed by the caller — a client that chose its own id could collide with a
 * stored capture or attribute events to someone else's window.
 *
 * `strictObject` over an empty shape, so the body is `{}` and *any* key is
 * refused. That strictness is the point of declaring a schema for an empty body
 * at all: a client that sent `{ sessionId }`, `{ captureId }` or
 * `{ hooks: … }` is working from a contract this one replaced, and a silent
 * acceptance would leave it believing the field had an effect.
 */
export const captureStartRequestSchema = z.strictObject({});

/** The validated `capture.start` request body. */
export type CaptureStartRequest = z.infer<typeof captureStartRequestSchema>;

/**
 * The `capture.start` response body: the id of the window that just opened.
 *
 * This is the synchronous half of the request/broadcast split. The caller gets
 * the `captureId` in its own response — so it can label its progress row, poll
 * `panel-data` for a live tail, or stop precisely the window it started — while
 * every other client of the session learns the same fact from
 * {@link captureStartedPayloadSchema}.
 *
 * No `sessionId`: the caller named the session in the route it called, and
 * echoing it back would invite a client to trust the echo over the path.
 *
 * Defined here and re-exported by `../http.ts`.
 */
export const captureStartResponseSchema = z.strictObject({
  /** The capture window that opened. */
  captureId: idSchema,
});

/** The validated `capture.start` response body. */
export type CaptureStartResponse = z.infer<typeof captureStartResponseSchema>;

/**
 * The `capture.stop` request body: empty.
 *
 * The session's open capture is the one that stops; there is at most one, so
 * naming it would add a way for a caller to be wrong rather than a way for it to
 * be precise. Stopping a session that holds no open capture is a state error the
 * service answers from its state machine, not a shape this body can express.
 *
 * Strict for the same reason {@link captureStartRequestSchema} is.
 */
export const captureStopRequestSchema = z.strictObject({});

/** The validated `capture.stop` request body. */
export type CaptureStopRequest = z.infer<typeof captureStopRequestSchema>;

/**
 * The `capture.stop` response body: the summary of the capture that just closed.
 *
 * The same object the `capture.stopped` broadcast carries, minus the ids the
 * caller already holds. A capture that collected nothing answers here too, with
 * a valid summary whose `eventCount` is zero: the service then skips analysis and
 * returns the session to `ready` (AAP §0.5.5), and a client reads the emptiness
 * off the summary rather than off an error.
 *
 * Defined here and re-exported by `../http.ts`.
 */
export const captureStopResponseSchema = z.strictObject({
  /** What the capture collected, computed by `@debuggen/telemetry`. */
  summary: captureSummarySchema,
});

/** The validated `capture.stop` response body. */
export type CaptureStopResponse = z.infer<typeof captureStopResponseSchema>;

/**
 * The HTTP operations this module contributes, with their request and response
 * schemas.
 *
 * Merged by `./index.ts` into `HTTP_ONLY_PAYLOAD_SCHEMAS`, the registry that
 * exists precisely so these names have a home that is *not* the message union.
 * The keys are the operation names verbatim — `capture.start`, `capture.stop` —
 * because they are what the user named these operations, what `docs/ARCHITECTURE.md`
 * tabulates and what a session's progress record refers to.
 *
 * Frozen and `as const`, like {@link CAPTURE_MESSAGE_PAYLOADS}, so the operation
 * names survive as literal types and no consumer can extend the set at runtime.
 */
export const CAPTURE_HTTP_PAYLOADS = Object.freeze({
  'capture.start': {
    request: captureStartRequestSchema,
    response: captureStartResponseSchema,
  },
  'capture.stop': {
    request: captureStopRequestSchema,
    response: captureStopResponseSchema,
  },
} as const);

// ---------------------------------------------------------------------------
// Section E — parse helpers
//
// One per payload, and each one total: a helper validates, never throws, and
// never repairs. A caller inspects `result.ok` and either uses the typed value
// or reports the error, which is what keeps a malformed frame from becoming an
// exception four stack frames above the socket that delivered it.
//
// The failure is always a `DebuggenError` with code 'PROTOCOL_INVALID_MESSAGE',
// built by `protocolParseError` — which renders the issues through
// `describeZodIssues`, so the message holds issue paths, issue codes and
// schema-declared metadata and never the rejected value. That matters most on
// exactly these payloads: a `CaptureSummary` carries redacted URLs, SQL
// statements, component names and project-relative paths, and a validation error
// is raised far below the redaction layer that would otherwise protect them
// (AAP §0.5.2).
// ---------------------------------------------------------------------------

/**
 * Validates `value` against `schema`, reporting a rejection the way this package
 * always reports one.
 *
 * Module-private, and the single place the `safeParse` → `protocolParseError`
 * sequence is written: the six exported helpers below differ only in the schema
 * they apply and the sentence they prefix the issues with, and spelling that
 * sequence out six times would be six chances for one of them to attach a
 * `ZodError`, forward an issue message or throw.
 *
 * @param value Any value believed to hold the payload.
 * @param schema The payload schema to validate against.
 * @param prefix A short statement of what failed to validate, with no trailing
 * punctuation.
 * @param hint A developer-facing next step, forwarded verbatim by
 * `DebuggenError.toPayload()` and therefore as free of rejected data as the
 * message is.
 * @returns `ok(payload)` with the validated value, or `err(error)` describing
 * the shape of the failure.
 */
function parsePayload<T>(
  value: unknown,
  schema: z.ZodType<T>,
  prefix: string,
  hint: string,
): Result<T, DebuggenError> {
  const parsed = schema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(protocolParseError('PROTOCOL_INVALID_MESSAGE', prefix, parsed.error.issues, hint));
}

/**
 * Validates an unknown value as a {@link CaptureStartedPayload}.
 *
 * Applied by every client that receives the broadcast — the editor's service
 * client and the Chrome service worker's WebSocket bridge — before it sets a
 * surface to "Capturing…".
 *
 * @param value The `payload` field of a received `capture.started` frame.
 * @returns `ok(payload)`, or `err(error)` when the frame does not match.
 *
 * @example
 * ```ts
 * const parsed = parseCaptureStartedPayload(frame.payload);
 * if (parsed.ok) {
 *   store.captureOpened(parsed.value.sessionId, parsed.value.captureId);
 * }
 * ```
 */
export function parseCaptureStartedPayload(
  value: unknown,
): Result<CaptureStartedPayload, DebuggenError> {
  return parsePayload(
    value,
    captureStartedPayloadSchema,
    'Invalid capture.started payload',
    'A capture.started payload carries exactly sessionId and captureId.',
  );
}

/**
 * Validates an unknown value as a {@link CaptureStoppedPayload}.
 *
 * The summary is checked shallowly, for the reason
 * {@link captureSummarySchema} documents: a present, object-shaped summary
 * passes and is typed as `CaptureSummary`, while an absent or primitive one is
 * refused before a consumer reads a field off it.
 *
 * @param value The `payload` field of a received `capture.stopped` frame.
 * @returns `ok(payload)`, or `err(error)` when the frame does not match.
 */
export function parseCaptureStoppedPayload(
  value: unknown,
): Result<CaptureStoppedPayload, DebuggenError> {
  return parsePayload(
    value,
    captureStoppedPayloadSchema,
    'Invalid capture.stopped payload',
    'A capture.stopped payload carries exactly sessionId, captureId and the capture summary.',
  );
}

/**
 * Validates an unknown value as a {@link CaptureStartRequest}.
 *
 * Applied by the service to the request body of `capture.start` before the
 * session manager opens a window. The body is empty, so this helper's job is to
 * refuse a client that believed it could parameterise the capture.
 *
 * @param value The parsed JSON request body.
 * @returns `ok({})`, or `err(error)` when the body carries anything at all.
 */
export function parseCaptureStartRequest(
  value: unknown,
): Result<CaptureStartRequest, DebuggenError> {
  return parsePayload(
    value,
    captureStartRequestSchema,
    'Invalid capture.start request',
    'The capture.start request body is empty: send {} and name the session in the route.',
  );
}

/**
 * Validates an unknown value as a {@link CaptureStartResponse}.
 *
 * Applied by a client to the response it read back, so that a proxy, a stale
 * service build or an error page rendered as JSON cannot become a `captureId`
 * the client then quotes in a stop request.
 *
 * @param value The parsed JSON response body.
 * @returns `ok(response)`, or `err(error)` when the body does not match.
 */
export function parseCaptureStartResponse(
  value: unknown,
): Result<CaptureStartResponse, DebuggenError> {
  return parsePayload(
    value,
    captureStartResponseSchema,
    'Invalid capture.start response',
    'A capture.start response carries exactly captureId.',
  );
}

/**
 * Validates an unknown value as a {@link CaptureStopRequest}.
 *
 * @param value The parsed JSON request body.
 * @returns `ok({})`, or `err(error)` when the body carries anything at all.
 */
export function parseCaptureStopRequest(value: unknown): Result<CaptureStopRequest, DebuggenError> {
  return parsePayload(
    value,
    captureStopRequestSchema,
    'Invalid capture.stop request',
    'The capture.stop request body is empty: send {} and name the session in the route.',
  );
}

/**
 * Validates an unknown value as a {@link CaptureStopResponse}.
 *
 * An empty capture is a success here: a summary reporting `eventCount: 0` is a
 * valid response, and it is the service that decides to skip analysis and return
 * the session to `ready` (AAP §0.5.5).
 *
 * @param value The parsed JSON response body.
 * @returns `ok(response)`, or `err(error)` when the body does not match.
 */
export function parseCaptureStopResponse(
  value: unknown,
): Result<CaptureStopResponse, DebuggenError> {
  return parsePayload(
    value,
    captureStopResponseSchema,
    'Invalid capture.stop response',
    'A capture.stop response carries exactly the capture summary.',
  );
}

// ---------------------------------------------------------------------------
// Section F — the opaque summary keeps its type, proved at compile time
// ---------------------------------------------------------------------------

/**
 * `true` when `A` and `B` are mutually assignable, `false` otherwise.
 *
 * The tuple wrappers stop a naked `never` or a union from distributing, so this
 * answers about the types as written rather than about their members.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Accepts `true` and nothing else: instantiating it with `false` is a compile
 * error (TS2344), which is what turns a type comparison into an assertion.
 */
type AssertTrue<T extends true> = T;

/**
 * Whether both `summary` fields of this module infer as exactly
 * `CaptureSummary`.
 */
type SummaryFieldsPreserveCaptureSummary =
  MutuallyAssignable<CaptureStoppedPayload['summary'], CaptureSummary> extends true
    ? MutuallyAssignable<CaptureStopResponse['summary'], CaptureSummary>
    : false;

/**
 * Compile-time proof that {@link opaqueSchema} preserved the imported type:
 * `z.infer<typeof captureStoppedPayloadSchema>['summary']` and
 * `z.infer<typeof captureStopResponseSchema>['summary']` are both exactly
 * `CaptureSummary` — not `unknown`, not `any`, not a structural copy.
 *
 * This resolves to `true`, and it is the assertion rather than the value that
 * matters: if a future edit replaced the opaque wrapper with something that
 * widened the field, {@link AssertTrue} would be instantiated with `false` and
 * this line would fail to compile — here, in the module that made the mistake,
 * instead of at the first consumer that reads a metric off the summary.
 *
 * It is exported because a type alias that nothing references is a compile error
 * under this repository's `noUnusedLocals`, and because a reader of the emitted
 * declarations can see the guarantee stated. Nothing consumes it at runtime;
 * there is nothing to consume.
 *
 * @internal
 */
export type CaptureSummaryTypePreserved = AssertTrue<SummaryFieldsPreserveCaptureSummary>;
