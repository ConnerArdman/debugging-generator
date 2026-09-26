/**
 * The message folder's registry: the complete `type → payload schema` map the
 * envelope's discriminated union is built from, the ordered vocabulary of
 * WebSocket message types and the named constant every application boundary
 * uses for each of them ({@link MESSAGE_TYPE}), the separate map of the five
 * HTTP operation names this folder also owns, and the whole folder's public
 * surface in one place.
 *
 * Eleven domain modules sit beside this one, each holding the payload schemas
 * of one part of the protocol (AAP §0.2.5). Each of them also exports a small
 * frozen map from its own message type names to its own schemas —
 * {@link AGENT_MESSAGE_PAYLOADS}, {@link BINDING_MESSAGE_PAYLOADS} and the nine
 * others — and this file merges those eleven maps into
 * {@link MESSAGE_PAYLOAD_SCHEMAS}, the single registry the rest of the package
 * reads. Nothing is re-declared on the way through: a schema appears in exactly
 * one module, is named in exactly one per-domain map, and reaches the registry
 * by a spread (AAP §0.9.1).
 *
 * ## What this file deliberately does not do
 *
 * **It assembles no union.** There is no `z.discriminatedUnion` here, no
 * envelope shape — `{ id, type, sessionId?, ts, payload }` (AAP §0.2.3) — and no
 * `ProtocolMessage` type. `../envelope.ts` owns all three: it maps over
 * {@link MESSAGE_TYPES}, looks each name up in {@link MESSAGE_PAYLOAD_SCHEMAS},
 * and produces the one discriminated union every connection validates against.
 * `../http.ts` reads {@link HTTP_ONLY_PAYLOAD_SCHEMAS} for the request bodies
 * of the five operations that travel over HTTP instead. Keeping both
 * consumptions *out* of this file is what keeps the folder acyclic, and the
 * direction is the one edge in this package that costs the most to get wrong:
 *
 * ```text
 * messages/error.ts            ← the folder's leaf: imports no sibling
 * messages/{agent,binding,session,capture,instrumentation,telemetry,
 *           panel,source,target,cleanup}.ts
 *                              ← may import ./error.js, and nothing else here
 * messages/index.ts            ← this file: imports all eleven, imported by none
 * ../envelope.ts               ← imports this file; this file must never import it
 * ../http.ts → ../client/*.ts → ../index.ts
 * ```
 *
 * A module below that reached up for the envelope would close a cycle through
 * the very file the envelope is built from. That is why each domain module
 * publishes a map rather than a union member, and why the merge lives here, one
 * level up, where every map is already in scope and nothing else is.
 *
 * ## Why the registry exists at all
 *
 * So that adding a message is two lines in one domain module — the schema and
 * its entry in that module's map — plus two lines here, the named constant in
 * {@link MESSAGE_TYPE} and its place in {@link MESSAGE_TYPES}; and so that
 * **forgetting any of them is a compile error**
 * ({@link MessageTypeConstantsAreComplete} covers the pair here).
 * {@link MessageRegistryIsComplete} asserts that the registry's key set
 * and {@link MessageType} are mutually assignable, so a schema with no type name
 * and a type name with no schema each fail `tsc -b` in this file. Without that
 * assertion the mistake would surface as a frame the envelope silently refuses
 * to parse at runtime, on one connection, in one direction, long after the edit.
 *
 * {@link HttpOnlyNamesAreNotMessageTypes} asserts the complementary property in
 * the other direction: none of the five HTTP operation names may leak into the
 * union.
 *
 * ## Why this file re-exports the whole folder
 *
 * `../index.ts` is the package's only build entry (`package.json` declares one
 * export condition, `tsup.config.ts` one entry), so a symbol it does not
 * forward does not exist for `apps/local-service`, `apps/vscode-extension` or
 * `apps/chrome-extension`. This barrel is what it forwards the message layer
 * from, so everything the three surfaces need arrives here first: the handshake
 * constants ({@link WS_CLOSE_UNAUTHORIZED}, {@link CLIENT_HELLO_TIMEOUT_MS}),
 * the closed vocabularies ({@link CLIENT_KINDS}, {@link PROGRESS_STAGES},
 * {@link PROGRESS_STATUSES}, {@link BINDING_REASONS},
 * {@link SOURCE_RESULT_STATUSES}), every payload schema, every inferred payload
 * type and every total `parse…` helper.
 *
 * The names are enumerated rather than forwarded with `export *`, for the
 * reason `packages/model-provider/src/providers/index.ts` enumerates its own:
 * the surface stays reviewable in one file, and a name that two modules came to
 * export would be a compile error here instead of an ambiguous star export that
 * silently resolves to neither. No symbol is renamed on the way through.
 *
 * ## Shape of this module
 *
 * Declarations and re-exports only. Importing it reads no environment variable,
 * touches no global, performs no I/O and holds no mutable state: the manifest
 * declares `sideEffects: false`, the two registries are frozen literals built
 * from frozen literals, and the type-level assertions have no runtime
 * representation at all. Values and types travel in separate statements because
 * `verbatimModuleSyntax` and `isolatedModules` require it, and every relative
 * specifier carries an explicit `.js` extension, as this package's NodeNext
 * resolution demands. Named exports only; there is no default export.
 */

import { AGENT_MESSAGE_PAYLOADS } from './agent.js';
import { BINDING_MESSAGE_PAYLOADS } from './binding.js';
import { CAPTURE_HTTP_PAYLOADS, CAPTURE_MESSAGE_PAYLOADS } from './capture.js';
import { CLEANUP_MESSAGE_PAYLOADS } from './cleanup.js';
import { ERROR_MESSAGE_PAYLOADS } from './error.js';
import { INSTRUMENTATION_MESSAGE_PAYLOADS } from './instrumentation.js';
import { PANEL_MESSAGE_PAYLOADS } from './panel.js';
import { SESSION_HTTP_PAYLOADS, SESSION_MESSAGE_PAYLOADS } from './session.js';
import { SOURCE_MESSAGE_PAYLOADS } from './source.js';
import { TARGET_MESSAGE_PAYLOADS } from './target.js';
import { TELEMETRY_MESSAGE_PAYLOADS } from './telemetry.js';
import type { ZodType } from 'zod';

/* -------------------------------------------------------------------------------------------------
 * messages/error — the folder's leaf
 * ---------------------------------------------------------------------------------------------- */

/**
 * The generic `error` frame and its constructor: see `./error.js`.
 *
 * The failure reply any request or subscription can receive, over the closed
 * error-code vocabulary `@debuggen/shared` owns, plus the correlation reference
 * this protocol adds so a receiver can say which of its frames failed.
 * `toErrorPayload` is the one sanctioned conversion from a `DebuggenError` to a
 * frame, and it is what keeps a rejected value from travelling with the report.
 */
export {
  ERROR_MESSAGE_PAYLOADS,
  errorCodeSchema,
  errorPayloadSchema,
  toErrorPayload,
} from './error.js';

/** The `error` frame's parse helper: see `./error.js`. */
export { parseErrorPayload } from './error.js';

/**
 * The `error` frame's inferred type, and its compile-time drift assertion.
 *
 * `ErrorPayloadDriftAssertions` has no runtime representation; it is forwarded
 * so that a reader of the emitted declarations can see the guarantee stated.
 *
 * @internal `ErrorPayloadDriftAssertions`
 */
export type { ErrorPayload, ErrorPayloadDriftAssertions } from './error.js';

/* -------------------------------------------------------------------------------------------------
 * messages/agent — the handshake and the two runtime agents' lifecycle
 * ---------------------------------------------------------------------------------------------- */

/**
 * The client-kind vocabulary and the two handshake constants: see `./agent.js`.
 *
 * {@link CLIENT_KINDS} is the closed set of connection kinds — the editor, the
 * DevTools panel, the page agent and the Node preload — that `client.hello`
 * announces; {@link WS_CLOSE_UNAUTHORIZED} is the close code a connection that
 * fails to authenticate receives, and {@link CLIENT_HELLO_TIMEOUT_MS} the
 * window it has to send that first frame in (AAP §0.5.6). All three are read by
 * the service's socket server and by both extension clients, so they are
 * declared once and forwarded rather than restated at either end.
 */
export {
  CLIENT_HELLO_TIMEOUT_MS,
  CLIENT_KINDS,
  WS_CLOSE_UNAUTHORIZED,
  clientKindSchema,
} from './agent.js';

/**
 * The agent-domain payload schemas and this domain's registry entry: see
 * `./agent.js`.
 *
 * `client.hello` is the first frame of every connection, `agent.ready` the
 * browser agent's report that it is installed in a document, and
 * `agent.config` / `server-agent.config` the two arming messages whose cleared
 * form returns each producer to dormant (AAP §0.5.1).
 */
export {
  AGENT_MESSAGE_PAYLOADS,
  agentConfigPayloadSchema,
  agentReadyPayloadSchema,
  clientHelloPayloadSchema,
  serverAgentConfigPayloadSchema,
} from './agent.js';

/** The agent-domain parse helpers: see `./agent.js`. */
export {
  parseAgentConfigPayload,
  parseAgentReadyPayload,
  parseClientHelloPayload,
  parseServerAgentConfigPayload,
} from './agent.js';

/** The agent-domain inferred types: see `./agent.js`. */
export type {
  AgentConfigPayload,
  AgentReadyPayload,
  ClientHelloPayload,
  ClientKind,
  ServerAgentConfigPayload,
} from './agent.js';

/* -------------------------------------------------------------------------------------------------
 * messages/binding — pairing an inspected Chrome tab with a session
 * ---------------------------------------------------------------------------------------------- */

/**
 * The binding-reason vocabulary: see `./binding.js`.
 *
 * Why a binding was established, replaced or dropped — the distinction both
 * user interfaces render when a tab leaves the session's origin (AAP §0.4.2).
 */
export { BINDING_REASONS, bindingReasonSchema } from './binding.js';

/**
 * The binding-domain payload schemas and this domain's registry entry: see
 * `./binding.js`.
 *
 * The four messages that make delivery of an agent config, a picker request, a
 * live tail or a generated panel a routable instruction: `session.bind`,
 * `session.bound`, `tab.navigated` and `session.unbind`.
 */
export {
  BINDING_MESSAGE_PAYLOADS,
  sessionBindPayloadSchema,
  sessionBoundPayloadSchema,
  sessionUnbindPayloadSchema,
  tabNavigatedPayloadSchema,
} from './binding.js';

/** The binding-domain parse helpers: see `./binding.js`. */
export {
  parseSessionBindPayload,
  parseSessionBoundPayload,
  parseSessionUnbindPayload,
  parseTabNavigatedPayload,
} from './binding.js';

/** The binding-domain inferred types: see `./binding.js`. */
export type {
  BindingReason,
  SessionBindPayload,
  SessionBoundPayload,
  SessionUnbindPayload,
  TabNavigatedPayload,
} from './binding.js';

/* -------------------------------------------------------------------------------------------------
 * messages/session — session lifecycle, staged progress, the analysis frame and
 * the three session HTTP operations
 * ---------------------------------------------------------------------------------------------- */

/**
 * The progress vocabularies: see `./session.js`.
 *
 * {@link PROGRESS_STAGES} is the ordered set of pipeline stages a session moves
 * through and {@link PROGRESS_STATUSES} the three states a stage can report
 * (AAP §0.4.2). Both user interfaces group and order their progress rows from
 * these, so the tuples' membership *and order* are user-visible.
 */
export {
  PROGRESS_STAGES,
  PROGRESS_STATUSES,
  progressStageSchema,
  progressStatusSchema,
} from './session.js';

/**
 * The session-domain payload schemas and this domain's registry entry: see
 * `./session.js`.
 *
 * `session.created` and `session.updated` carry the whole `SessionRecord`,
 * `session.progress` one stage transition, and `analysis.completed` the
 * validated analysis artifact — which is why this folder has no `analysis`
 * module: the frame that carries the artifact belongs to the session domain,
 * and the artifact itself is `../analysis.ts`'s (AAP §0.2.5).
 */
export {
  SESSION_MESSAGE_PAYLOADS,
  analysisCompletedPayloadSchema,
  sessionCreatedPayloadSchema,
  sessionProgressPayloadSchema,
  sessionUpdatedPayloadSchema,
} from './session.js';

/**
 * The three session HTTP request schemas and this domain's HTTP map: see
 * `./session.js`.
 *
 * `session.create`, `session.question` and `session.end` are HTTP operations,
 * not WebSocket message types — see {@link HTTP_ONLY_PAYLOAD_SCHEMAS}, which is
 * where this map is merged, and why.
 */
export {
  SESSION_HTTP_PAYLOADS,
  sessionCreateRequestSchema,
  sessionEndRequestSchema,
  sessionQuestionRequestSchema,
} from './session.js';

/** The session-domain parse helpers, for both the frames and the requests: see `./session.js`. */
export {
  parseAnalysisCompletedPayload,
  parseSessionCreateRequest,
  parseSessionCreatedPayload,
  parseSessionEndRequest,
  parseSessionProgressPayload,
  parseSessionQuestionRequest,
  parseSessionUpdatedPayload,
} from './session.js';

/**
 * The session-domain inferred types, and this module's compile-time drift
 * assertions.
 *
 * The two assertion aliases have no runtime representation; they are forwarded
 * so that a reader of the emitted declarations can see the guarantees stated.
 *
 * @internal `SessionMessageEmbeddedShapesPreserved`, `SessionIdEdgePreserved`
 */
export type {
  AnalysisCompletedPayload,
  ProgressStage,
  ProgressStatus,
  SessionCreateRequest,
  SessionCreatedPayload,
  SessionEndRequest,
  SessionIdEdgePreserved,
  SessionMessageEmbeddedShapesPreserved,
  SessionProgressPayload,
  SessionQuestionRequest,
  SessionUpdatedPayload,
} from './session.js';

/* -------------------------------------------------------------------------------------------------
 * messages/capture — the capture window and the two capture HTTP operations
 * ---------------------------------------------------------------------------------------------- */

/**
 * The capture summary schema: see `./capture.js`.
 *
 * The aggregate `@debuggen/telemetry` computes for one capture, embedded by
 * `capture.stopped` and by the stop response. Forwarded because both user
 * interfaces render it and the service stores it, and declared once because a
 * second definition of an aggregate shape is the defect AAP §0.9.1 names.
 */
export { captureSummarySchema } from './capture.js';

/**
 * The capture-domain payload schemas and this domain's registry entry: see
 * `./capture.js`.
 *
 * `capture.started` and `capture.stopped` are the broadcasts every client of a
 * session receives when a capture window opens and closes.
 */
export {
  CAPTURE_MESSAGE_PAYLOADS,
  captureStartedPayloadSchema,
  captureStoppedPayloadSchema,
} from './capture.js';

/**
 * The two capture HTTP request and response schemas and this domain's HTTP map:
 * see `./capture.js`.
 *
 * `capture.start` and `capture.stop` are HTTP operations, not WebSocket message
 * types: the caller that pressed the button gets its answer from the response,
 * while every other client of the session learns from the broadcast above. See
 * {@link HTTP_ONLY_PAYLOAD_SCHEMAS}.
 */
export {
  CAPTURE_HTTP_PAYLOADS,
  captureStartRequestSchema,
  captureStartResponseSchema,
  captureStopRequestSchema,
  captureStopResponseSchema,
} from './capture.js';

/** The capture-domain parse helpers, for both the frames and the HTTP bodies: see `./capture.js`. */
export {
  parseCaptureStartRequest,
  parseCaptureStartResponse,
  parseCaptureStartedPayload,
  parseCaptureStopRequest,
  parseCaptureStopResponse,
  parseCaptureStoppedPayload,
} from './capture.js';

/**
 * The capture-domain inferred types, and this module's compile-time drift
 * assertion.
 *
 * @internal `CaptureSummaryTypePreserved`
 */
export type {
  CaptureStartRequest,
  CaptureStartResponse,
  CaptureStartedPayload,
  CaptureStopRequest,
  CaptureStopResponse,
  CaptureStoppedPayload,
  CaptureSummaryTypePreserved,
} from './capture.js';

/* -------------------------------------------------------------------------------------------------
 * messages/instrumentation — what the tool is about to do to the working tree,
 * and what it managed to do
 * ---------------------------------------------------------------------------------------------- */

/**
 * The unavailable-signal schema: see `./instrumentation.js`.
 *
 * One signal that could not be enabled, with its reason and the developer-facing
 * hint that says what to do about it — the shape AAP §0.5.5 requires a partial
 * install to report rather than swallow. Carried by `instrumentation.ready` and
 * rendered by both user interfaces, which is why it is forwarded on its own.
 */
export { unavailableSignalSchema } from './instrumentation.js';

/**
 * The instrumentation-domain payload schemas and this domain's registry entry:
 * see `./instrumentation.js`.
 *
 * `instrumentation.plan` carries the normalised plan, `instrumentation.ready`
 * the applied modification records together with the runtime hooks that came up
 * and the signals that did not, and `instrumentation.failed` the one case where
 * nothing at all could be enabled. `instrumentationFailedErrorSchema` is the
 * error frame that last message extends, declared beside it.
 */
export {
  INSTRUMENTATION_MESSAGE_PAYLOADS,
  instrumentationFailedErrorSchema,
  instrumentationFailedPayloadSchema,
  instrumentationPlanPayloadSchema,
  instrumentationReadyPayloadSchema,
} from './instrumentation.js';

/** The instrumentation-domain parse helpers: see `./instrumentation.js`. */
export {
  parseInstrumentationFailedPayload,
  parseInstrumentationPlanPayload,
  parseInstrumentationReadyPayload,
} from './instrumentation.js';

/**
 * The instrumentation-domain inferred types, and this module's compile-time
 * drift assertion.
 *
 * @internal `UnavailableSignalDriftAssertions`
 */
export type {
  InstrumentationFailedError,
  InstrumentationFailedPayload,
  InstrumentationPlanPayload,
  InstrumentationReadyPayload,
  UnavailableSignalDriftAssertions,
  UnavailableSignalPayload,
} from './instrumentation.js';

/* -------------------------------------------------------------------------------------------------
 * messages/telemetry — the two directions of the event stream
 * ---------------------------------------------------------------------------------------------- */

/**
 * The telemetry-domain payload schemas and this domain's registry entry: see
 * `./telemetry.js`.
 *
 * `telemetry.event` is the batch a producer sends inward, carrying the ingress
 * schema that cannot claim a session or a capture — attribution happens in the
 * service, for every producer — and `telemetry.tail` the already-redacted replay
 * the service sends outward to the DevTools panel (AAP §0.5.2).
 */
export {
  TELEMETRY_MESSAGE_PAYLOADS,
  telemetryEventPayloadSchema,
  telemetryTailPayloadSchema,
} from './telemetry.js';

/** The telemetry-domain parse helpers: see `./telemetry.js`. */
export { parseTelemetryEventPayload, parseTelemetryTailPayload } from './telemetry.js';

/** The telemetry-domain inferred types: see `./telemetry.js`. */
export type { TelemetryEventPayload, TelemetryTailPayload } from './telemetry.js';

/* -------------------------------------------------------------------------------------------------
 * messages/panel — handing a validated panel specification to the surfaces
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `panel.generated` payload schema and this domain's registry entry: see
 * `./panel.js`.
 *
 * The frame that hands a validated panel specification to the DevTools panel and
 * the editor once analysis has produced one, carrying the specification exactly
 * as `@debuggen/panel-schema` defines it — including `meta.fallback`, which the
 * renderer banners rather than hides (AAP §0.5.5).
 */
export { PANEL_MESSAGE_PAYLOADS, panelGeneratedPayloadSchema } from './panel.js';

/** The `panel.generated` parse helper: see `./panel.js`. */
export { parsePanelGeneratedPayload } from './panel.js';

/**
 * The `panel.generated` inferred type, and this module's compile-time drift
 * assertion.
 *
 * @internal `PanelSpecTypePreserved`
 */
export type { PanelGeneratedPayload, PanelSpecTypePreserved } from './panel.js';

/* -------------------------------------------------------------------------------------------------
 * messages/source — the hop that makes every runtime item clickable, and its answer
 * ---------------------------------------------------------------------------------------------- */

/**
 * The source-navigation vocabulary and deadlines: see `./source.js`.
 *
 * {@link SOURCE_RESULT_STATUSES} is the closed set of outcomes a `source.open`
 * can have — `opened`, `no-editor`, `failed` — and the two timeouts are the
 * service's wait for an editor's answer ({@link SOURCE_OPEN_EDITOR_TIMEOUT_MS})
 * and the DevTools side's wait for the service's
 * ({@link SOURCE_OPEN_RESULT_TIMEOUT_MS}), declared together because the second
 * must exceed the first.
 */
export {
  SOURCE_OPEN_EDITOR_TIMEOUT_MS,
  SOURCE_OPEN_RESULT_TIMEOUT_MS,
  SOURCE_RESULT_STATUSES,
} from './source.js';

/**
 * The source-navigation payload schemas and this domain's registry entry: see
 * `./source.js`.
 *
 * `source.open` is an already-resolved project location travelling from the
 * DevTools panel to the editor; `source.result` is the answer, correlated by
 * `ref` to the `source.open` it settles, from the editor to the service and
 * from the service to the panel. Containment is decided by the service and
 * again, independently, by the editor's URI handler — never here, because this
 * package has no project root and no filesystem (AAP §0.2.3, §0.5.6).
 */
export {
  SOURCE_MESSAGE_PAYLOADS,
  sourceOpenPayloadSchema,
  sourceResultPayloadSchema,
} from './source.js';

/** The source-navigation parse helpers: see `./source.js`. */
export { parseSourceOpenPayload, parseSourceResultPayload } from './source.js';

/**
 * The editor-open URI, the fallback for a `no-editor` answer: see `./source.js`.
 *
 * {@link EDITOR_OPEN_URI} names its scheme, authority, path and parameters once
 * for the panel that opens it and the extension handler that receives it, and
 * {@link buildEditorOpenUri} builds it from a validated location.
 */
export { EDITOR_OPEN_URI, buildEditorOpenUri } from './source.js';

/**
 * The source-navigation inferred types, and this module's compile-time drift
 * assertion.
 *
 * @internal `SourceResultDriftAssertions`
 */
export type {
  SourceOpenPayload,
  SourceResultDriftAssertions,
  SourceResultPayload,
  SourceResultStatus,
} from './source.js';

/* -------------------------------------------------------------------------------------------------
 * messages/target — the element-selection round trip
 * ---------------------------------------------------------------------------------------------- */

/**
 * The target-domain payload schemas and this domain's registry entry: see
 * `./target.js`.
 *
 * `target.request` is the service asking the bound panel to enter picker mode,
 * and `target.selected` the panel answering with the selected element's
 * descriptor and React component chain — the optional target a session's first
 * stage reasons from when the developer picked one.
 */
export {
  TARGET_MESSAGE_PAYLOADS,
  targetRequestPayloadSchema,
  targetSelectedPayloadSchema,
} from './target.js';

/** The target-domain parse helpers: see `./target.js`. */
export { parseTargetRequestPayload, parseTargetSelectedPayload } from './target.js';

/**
 * The target-domain verdict helpers and their vocabulary: see `./target.js`.
 *
 * The two questions the service's verdict on a `target.selected` frame turns
 * on, answered once for the service that refuses or records a selection and
 * the panel that waits for the outcome: whether a session's recorded target is
 * the descriptor that was sent (`sameSelectedTarget`), and whether a
 * descriptor is of the bound tab's current document
 * (`compareSelectionDocument`, answering in `SELECTION_DOCUMENT_VERDICTS`).
 */
export {
  SELECTION_DOCUMENT_VERDICTS,
  compareSelectionDocument,
  sameSelectedTarget,
} from './target.js';

/** The target-domain inferred types: see `./target.js`. */
export type {
  SelectionDocumentVerdict,
  TargetRequestPayload,
  TargetSelectedPayload,
} from './target.js';

/* -------------------------------------------------------------------------------------------------
 * messages/cleanup — the end-of-session guarantee, reported
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `cleanup.completed` payload schema and this domain's registry entry: see
 * `./cleanup.js`.
 *
 * What the end of a session did to the developer's working tree: the cleanup
 * status and every conflict a file edited while instrumented produced, which is
 * reported rather than overwritten (AAP §0.5.1).
 */
export { CLEANUP_MESSAGE_PAYLOADS, cleanupCompletedPayloadSchema } from './cleanup.js';

/** The `cleanup.completed` parse helper: see `./cleanup.js`. */
export { parseCleanupCompletedPayload } from './cleanup.js';

/**
 * The `cleanup.completed` inferred type, and this module's compile-time drift
 * assertion.
 *
 * @internal `CleanupCompletedEmbeddedShapesPreserved`
 */
export type {
  CleanupCompletedEmbeddedShapesPreserved,
  CleanupCompletedPayload,
} from './cleanup.js';

/* -------------------------------------------------------------------------------------------------
 * The WebSocket registry
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every WebSocket message type of this protocol, mapped to the schema of its
 * payload — the single registry `../envelope.ts` builds its discriminated union
 * from.
 *
 * The merge of the eleven per-domain maps and nothing else. No schema is listed
 * here by hand: each one is named exactly once, in the module that declares it
 * (`./agent.js` names its four, `./error.js` its one), and arrives here through
 * a spread. Re-listing one would be the second definition AAP §0.9.1 forbids,
 * and would eventually name a different schema than its module does.
 *
 * The spread order is the domain order of AAP §0.4.2 — handshake and agents,
 * binding, session, capture, instrumentation, telemetry, panel, source, target,
 * cleanup, error — and it is observable: `Object.keys` answers in it, so a
 * generated diagnostic or documentation table derived from this object reads in
 * the order the protocol is documented in. Insertion order is *not* a contract
 * the envelope depends on, though: {@link MESSAGE_TYPES} fixes the discriminant
 * order the union is built in, and the two agree by assertion rather than by
 * coincidence — see {@link MessageRegistryIsComplete}.
 *
 * The eleven source maps are disjoint by construction: each key is a message
 * type name owned by one domain, so no spread overwrites an earlier one. The
 * completeness assertion below would catch a rename that produced a duplicate,
 * because the merged key set would then be one name short of
 * {@link MessageType}.
 *
 * Frozen, like every map it is built from, so no consumer can add a type at
 * runtime — an extension that registered its own message would be validated by
 * an envelope that never learned about it.
 *
 * The `satisfies Readonly<Record<MessageType, ZodType>>` clause is the second
 * half of the completeness guard, and `satisfies` rather than an annotation is
 * what makes it free: the constant keeps its inferred type, so each value's
 * *specific* schema type — and therefore each payload's inferred type — stays
 * available to the envelope, while the clause still proves at this line that
 * every entry is a Zod schema and that no message type is missing an entry. It
 * fails first, and with the two key sets spelled out, when a name is added to
 * {@link MESSAGE_TYPES} and nowhere else; {@link MessageRegistryIsComplete}
 * catches the opposite mistake, an entry no type name covers.
 *
 * @example Validating a payload the way the envelope does
 * ```ts
 * const schema = MESSAGE_PAYLOAD_SCHEMAS[type];
 * const parsed = schema.safeParse(frame.payload);
 * ```
 */
export const MESSAGE_PAYLOAD_SCHEMAS = Object.freeze({
  ...AGENT_MESSAGE_PAYLOADS,
  ...BINDING_MESSAGE_PAYLOADS,
  ...SESSION_MESSAGE_PAYLOADS,
  ...CAPTURE_MESSAGE_PAYLOADS,
  ...INSTRUMENTATION_MESSAGE_PAYLOADS,
  ...TELEMETRY_MESSAGE_PAYLOADS,
  ...PANEL_MESSAGE_PAYLOADS,
  ...SOURCE_MESSAGE_PAYLOADS,
  ...TARGET_MESSAGE_PAYLOADS,
  ...CLEANUP_MESSAGE_PAYLOADS,
  ...ERROR_MESSAGE_PAYLOADS,
} as const) satisfies Readonly<Record<MessageType, ZodType>>;

/**
 * The twenty-six WebSocket message types of this protocol, each under a named
 * constant: the identifiers the three runnable surfaces send, subscribe to,
 * build envelopes with and switch on, instead of repeating the wire string at
 * every boundary.
 *
 * This object is where each name is spelled, once. Twenty-five names are
 * verbatim from AAP §0.4.2 — the dot spellings, and the hyphen in
 * `'server-agent.config'` — and ten of them are the user's own names for these
 * messages. The twenty-sixth, `'source.result'`, is the answer to
 * `'source.open'`, named in that message's domain so a click on a source link
 * is acknowledged end to end instead of being reported done when a frame was
 * merely queued. A single character of drift is a frame one process sends and
 * another refuses, so every other statement of the vocabulary is derived from
 * here: {@link MESSAGE_TYPES} lists these constants in discriminant order,
 * {@link MessageType} is derived from that tuple, and the envelope's union from
 * both.
 *
 * A key is its wire name in upper snake case — `.` and `-` become `_` — so the
 * identifier is predictable from the name (`'server-agent.config'` is
 * `SERVER_AGENT_CONFIG`) and a reader can go from a frame in a log to the
 * constant without a lookup table. `../__tests__/messages.test.ts` checks that
 * correspondence for every entry, which is also what stops two keys from naming
 * one message; {@link MessageTypeConstantsAreComplete} proves the values are
 * exactly {@link MessageType}.
 *
 * `as const` inside `Object.freeze` keeps every value's literal type, so a
 * constant types exactly as its string would: `send(MESSAGE_TYPE.SOURCE_OPEN,
 * payload)` checks `payload` against `source.open`'s schema,
 * `case MESSAGE_TYPE.AGENT_READY:` narrows a `ProtocolMessage` to
 * `MessageByType<'agent.ready'>`, and a switch with a case for every constant
 * still reaches `assertNever` exhaustively. Frozen, so no consumer can rename a
 * message at run time.
 *
 * @example Sending, subscribing and dispatching by name
 * ```ts
 * import { MESSAGE_TYPE } from '@debuggen/protocol';
 *
 * client.send(MESSAGE_TYPE.SESSION_BIND, { tabId, url, origin });
 * client.on(MESSAGE_TYPE.SESSION_UPDATED, (message) => render(message.payload.session));
 *
 * switch (message.type) {
 *   case MESSAGE_TYPE.TELEMETRY_EVENT:
 *     return ingest(message.payload.events);
 *   // …
 * }
 * ```
 */
export const MESSAGE_TYPE = Object.freeze({
  CLIENT_HELLO: 'client.hello',
  AGENT_READY: 'agent.ready',
  AGENT_CONFIG: 'agent.config',
  SERVER_AGENT_CONFIG: 'server-agent.config',
  SESSION_BIND: 'session.bind',
  SESSION_BOUND: 'session.bound',
  TAB_NAVIGATED: 'tab.navigated',
  SESSION_UNBIND: 'session.unbind',
  SESSION_CREATED: 'session.created',
  SESSION_UPDATED: 'session.updated',
  SESSION_PROGRESS: 'session.progress',
  ANALYSIS_COMPLETED: 'analysis.completed',
  CAPTURE_STARTED: 'capture.started',
  CAPTURE_STOPPED: 'capture.stopped',
  INSTRUMENTATION_PLAN: 'instrumentation.plan',
  INSTRUMENTATION_READY: 'instrumentation.ready',
  INSTRUMENTATION_FAILED: 'instrumentation.failed',
  TELEMETRY_EVENT: 'telemetry.event',
  TELEMETRY_TAIL: 'telemetry.tail',
  PANEL_GENERATED: 'panel.generated',
  SOURCE_OPEN: 'source.open',
  SOURCE_RESULT: 'source.result',
  TARGET_REQUEST: 'target.request',
  TARGET_SELECTED: 'target.selected',
  CLEANUP_COMPLETED: 'cleanup.completed',
  ERROR: 'error',
} as const);

/**
 * The twenty-six WebSocket message types of this protocol, in the order
 * `../envelope.ts` builds its discriminated union in.
 *
 * Built from {@link MESSAGE_TYPE}'s constants rather than from strings, so the
 * tuple fixes the *order* of the vocabulary and the constants its *spelling*:
 * no name is written twice in this package. Every other statement of it in the
 * product is derived from these two: the union's discriminant,
 * {@link MessageType}, the service's client router and both extension clients'
 * typed `on(type, handler)` subscriptions.
 *
 * The order is the domain order of the registry above, read top to bottom:
 *
 * 1. the handshake and the two runtime agents — `client.hello`, `agent.ready`,
 *    `agent.config`, `server-agent.config`;
 * 2. tab binding — `session.bind`, `session.bound`, `tab.navigated`,
 *    `session.unbind`;
 * 3. the session — `session.created`, `session.updated`, `session.progress`,
 *    `analysis.completed`;
 * 4. the capture window — `capture.started`, `capture.stopped`;
 * 5. instrumentation — `instrumentation.plan`, `instrumentation.ready`,
 *    `instrumentation.failed`;
 * 6. telemetry — `telemetry.event`, `telemetry.tail`;
 * 7. the generated panel — `panel.generated`;
 * 8. source navigation — `source.open`, `source.result`;
 * 9. element selection — `target.request`, `target.selected`;
 * 10. cleanup — `cleanup.completed`;
 * 11. the generic failure reply — `error`.
 *
 * Note what is **not** here: `session.create`, `session.question`,
 * `session.end`, `capture.start` and `capture.stop`. Those five are HTTP
 * operations whose names this folder also owns — see
 * {@link HTTP_ONLY_PAYLOAD_NAMES} — and {@link HttpOnlyNamesAreNotMessageTypes}
 * is the assertion that keeps them out of this tuple.
 *
 * `as const` is load-bearing rather than stylistic: it is what makes this a
 * readonly tuple of string literals, which is what lets {@link MessageType} be
 * derived from it instead of hand-written, and what lets the envelope map over
 * it to build a union whose members are known at compile time.
 */
export const MESSAGE_TYPES = [
  MESSAGE_TYPE.CLIENT_HELLO,
  MESSAGE_TYPE.AGENT_READY,
  MESSAGE_TYPE.AGENT_CONFIG,
  MESSAGE_TYPE.SERVER_AGENT_CONFIG,
  MESSAGE_TYPE.SESSION_BIND,
  MESSAGE_TYPE.SESSION_BOUND,
  MESSAGE_TYPE.TAB_NAVIGATED,
  MESSAGE_TYPE.SESSION_UNBIND,
  MESSAGE_TYPE.SESSION_CREATED,
  MESSAGE_TYPE.SESSION_UPDATED,
  MESSAGE_TYPE.SESSION_PROGRESS,
  MESSAGE_TYPE.ANALYSIS_COMPLETED,
  MESSAGE_TYPE.CAPTURE_STARTED,
  MESSAGE_TYPE.CAPTURE_STOPPED,
  MESSAGE_TYPE.INSTRUMENTATION_PLAN,
  MESSAGE_TYPE.INSTRUMENTATION_READY,
  MESSAGE_TYPE.INSTRUMENTATION_FAILED,
  MESSAGE_TYPE.TELEMETRY_EVENT,
  MESSAGE_TYPE.TELEMETRY_TAIL,
  MESSAGE_TYPE.PANEL_GENERATED,
  MESSAGE_TYPE.SOURCE_OPEN,
  MESSAGE_TYPE.SOURCE_RESULT,
  MESSAGE_TYPE.TARGET_REQUEST,
  MESSAGE_TYPE.TARGET_SELECTED,
  MESSAGE_TYPE.CLEANUP_COMPLETED,
  MESSAGE_TYPE.ERROR,
] as const;

/**
 * One of the twenty-six names in {@link MESSAGE_TYPES}: the discriminant of
 * every frame this protocol carries.
 *
 * Derived from the tuple rather than written out, so the type and the runtime
 * list cannot drift apart, and equal — by assertion, see
 * {@link MessageRegistryIsComplete} — to the key set of
 * {@link MESSAGE_PAYLOAD_SCHEMAS}. That equality is what makes
 * `MESSAGE_PAYLOAD_SCHEMAS[type]` a total lookup for a `MessageType`, with no
 * `undefined` branch to handle, under `noUncheckedIndexedAccess`.
 */
export type MessageType = (typeof MESSAGE_TYPES)[number];

/* -------------------------------------------------------------------------------------------------
 * The HTTP-only registry — the five names that must stay out of the union
 * ---------------------------------------------------------------------------------------------- */

/**
 * The five HTTP operations whose names this folder owns, mapped to their request
 * (and, where this folder owns it, response) schemas — the map `../http.ts`
 * reads.
 *
 * These are **HTTP operations, not WebSocket message types** (AAP §0.4.2).
 * `session.create` is `POST /sessions`, `session.question` is
 * `POST /sessions/:id/question`, `session.end` is `POST /sessions/:id/end`, and
 * `capture.start` / `capture.stop` are the two capture routes. They live in this
 * folder because the names are the user's own and this is where the protocol's
 * names are defined once; they live in a *separate* map because a request body
 * is not a frame. Letting one into {@link MESSAGE_PAYLOAD_SCHEMAS} would put a
 * request body on the wire as a message — a socket client could then send
 * `session.end` as a frame and expect the effect of the route, which nothing on
 * the receiving side implements. {@link HttpOnlyNamesAreNotMessageTypes} makes
 * that mistake a compile error rather than a protocol ambiguity.
 *
 * The entry shapes differ deliberately and are not normalised here. Each is
 * `{ request }` or `{ request, response }` exactly as its module declares it:
 * `./capture.js` owns both halves of its two operations, while the three
 * session operations answer with shapes this folder does not own — a
 * `SessionRecord` from `../session-record.ts` for two of them, and
 * `{ cleanup: CleanupStatus }` assembled in `../http.ts` for the third — so
 * their responses are deliberately absent rather than restated (AAP §0.9.1).
 *
 * One name legitimately exists in both worlds, and it is not in this map:
 * `telemetry.event` is a WebSocket message type (the batch the page agent's
 * relay sends inward) *and* the operation id of `POST /telemetry/ingest`, whose
 * request body — `{ projectRoot, events }`, the Node preload's envelope-free
 * form — is defined in `../http.ts` beside the route constant. It stays in
 * {@link MESSAGE_TYPES} and must never be added here: the same payload schema
 * serves both, and the difference is only which transport carries it.
 *
 * Frozen and `as const`, so the operation names survive as literal types and no
 * consumer can extend the set at runtime.
 */
export const HTTP_ONLY_PAYLOAD_SCHEMAS = Object.freeze({
  ...SESSION_HTTP_PAYLOADS,
  ...CAPTURE_HTTP_PAYLOADS,
} as const);

/**
 * The five HTTP operation names of {@link HTTP_ONLY_PAYLOAD_SCHEMAS}, in the
 * order that map spreads them: the three session operations, then the two
 * capture operations.
 *
 * The iterable counterpart of that map, for the same reason
 * {@link MESSAGE_TYPES} accompanies {@link MESSAGE_PAYLOAD_SCHEMAS}: a tuple can
 * be mapped over to build a type, joined into a diagnostic, or checked against
 * the route table `../http.ts` declares, none of which a frozen object's key
 * type can do as directly. {@link HttpOnlyNamesMatchTheirSchemas} asserts that
 * this tuple and that map name exactly the same five operations.
 */
export const HTTP_ONLY_PAYLOAD_NAMES = [
  'session.create',
  'session.question',
  'session.end',
  'capture.start',
  'capture.stop',
] as const;

/**
 * One of the five names in {@link HTTP_ONLY_PAYLOAD_NAMES}.
 *
 * Disjoint from {@link MessageType} by assertion — see
 * {@link HttpOnlyNamesAreNotMessageTypes} — so a function that accepts one of
 * these cannot be handed a message type, and vice versa.
 */
export type HttpOnlyPayloadName = (typeof HTTP_ONLY_PAYLOAD_NAMES)[number];

/* -------------------------------------------------------------------------------------------------
 * The compile-time guards
 *
 * Four properties of the registries above are proved here, by the compiler, at
 * the point the registries are assembled: the WebSocket registry covers exactly
 * the twenty-six message types, the named constants are exactly those types,
 * the HTTP-only names overlap the message types nowhere, and the HTTP-only tuple
 * and map name the same five operations.
 * Each is a type-level assertion with no runtime representation — the runtime
 * half of the same guarantees, over `Object.keys`, belongs to
 * `../__tests__/messages.test.ts`.
 * ---------------------------------------------------------------------------------------------- */

/**
 * `true` when `A` and `B` are mutually assignable, `false` otherwise.
 *
 * The tuple wrappers stop a naked `never` or a union from distributing, so this
 * answers about the types as written rather than about their members — which is
 * the whole point here, since both operands *are* unions of string literals.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Accepts `true` and nothing else: instantiating it with `false` is a compile
 * error (TS2344), which is what turns a type comparison into an assertion.
 */
type AssertTrue<T extends true> = T;

/**
 * Compile-time proof that {@link MESSAGE_PAYLOAD_SCHEMAS} holds a schema for
 * every name in {@link MESSAGE_TYPES} and for no other name.
 *
 * This is the assertion the registry pattern exists for. Adding a message is two
 * lines in one domain module plus one line in {@link MESSAGE_TYPES}, and the
 * mutual assignability below is what makes forgetting either half fail `tsc -b`
 * **here**, in the file that merges them, rather than at runtime on one
 * connection:
 *
 * - a schema whose module map names it but whose type name is missing from the
 *   tuple makes the key set wider than {@link MessageType}, so
 *   `[keyof …] extends [MessageType]` fails — and that message would otherwise
 *   be absent from the envelope's union, so the sender would emit a frame no
 *   receiver could parse;
 * - a type name in the tuple with no entry in any module map makes it narrower,
 *   so the reverse assignability fails — and the envelope would otherwise map
 *   over a name whose schema lookup is `undefined`, which
 *   `noUncheckedIndexedAccess` would surface as a nullability error inside the
 *   envelope, one file away from the mistake;
 * - a misspelling breaks both directions at once, and the compiler names the
 *   two key sets in its message, so the typo is visible in the diagnostic.
 *
 * It resolves to `true`, and it is the assertion rather than the value that
 * matters. Exported because a type alias nothing references is a compile error
 * under this repository's `noUnusedLocals`, and because a reader of the emitted
 * declarations can then see the guarantee stated; it has no runtime
 * representation, so there is nothing to consume.
 *
 * @internal
 */
export type MessageRegistryIsComplete = AssertTrue<
  MutuallyAssignable<keyof typeof MESSAGE_PAYLOAD_SCHEMAS, MessageType>
>;

/**
 * Compile-time proof that {@link MESSAGE_TYPES} still lists twenty-six names —
 * the one property {@link MessageRegistryIsComplete} cannot see.
 *
 * That assertion compares a *key set* with a *union*, and both are blind to a
 * repeated element: duplicating `'error'` in the tuple leaves
 * {@link MessageType} unchanged, so the registry still matches and the mistake
 * travels one file onward, where `../envelope.ts` maps the tuple to union
 * members and Zod rejects a discriminated union with two members claiming the
 * same discriminant value — at module load, in every process at once, with a
 * message about the union rather than about the tuple. A dropped name that
 * happened to be a duplicate would hide the same way.
 *
 * So the count is asserted here: the twenty-five messages AAP §0.4.2 specifies,
 * plus `source.result`, the answer to `source.open`. It is the one figure in
 * this file not derived from something else, which makes it the one that has to
 * be maintained: adding a twenty-seventh message means updating this literal in
 * the same edit as the tuple, and the failure is a compile error in this file,
 * naming this line. The runtime half — twenty-six distinct keys in
 * {@link MESSAGE_PAYLOAD_SCHEMAS}, in this order — belongs to
 * `../__tests__/messages.test.ts`.
 *
 * Exported for the reason {@link MessageRegistryIsComplete} is.
 *
 * @internal
 */
export type MessageTypeCountIsTwentySix = AssertTrue<
  (typeof MESSAGE_TYPES)['length'] extends 26 ? true : false
>;

/**
 * Compile-time proof that the values of {@link MESSAGE_TYPE} are exactly the
 * names of {@link MessageType} — every message has a named constant, and every
 * named constant is a message.
 *
 * {@link MESSAGE_TYPES} is built from the constants, so a constant cannot name a
 * message the tuple lacks unless someone adds it to the object and forgets the
 * tuple. That constant would still type-check at every `send` and `case` that
 * used it — its value is a string literal — while the envelope's union had no
 * member for it, and the frame would be refused at run time by the peer. The
 * mutual assignability below turns that forgotten tuple line into a compile
 * error in this file.
 *
 * Two keys naming one message is invisible to this assertion (the value union
 * is unchanged); the key-equals-upper-snake-name check in
 * `../__tests__/messages.test.ts` is what rules that out.
 *
 * Exported for the reason {@link MessageRegistryIsComplete} is.
 *
 * @internal
 */
export type MessageTypeConstantsAreComplete = AssertTrue<
  MutuallyAssignable<(typeof MESSAGE_TYPE)[keyof typeof MESSAGE_TYPE], MessageType>
>;

/**
 * Compile-time proof that no HTTP operation name is also a WebSocket message
 * type.
 *
 * The two registries above are deliberately separate, and this is what keeps
 * them so. `Extract` collects the names present in both; `[…] extends [never]`
 * asserts that collection is empty, with the tuple wrapper stopping `never` from
 * distributing to a vacuous `true`.
 *
 * The failure mode it rules out is quiet and expensive: an HTTP request body
 * that reached {@link MESSAGE_PAYLOAD_SCHEMAS} would become a member of the
 * envelope's union, so a socket client could send `session.end` or
 * `capture.start` as a *frame* — validated, routed, and then handled by nothing,
 * because those operations are implemented as routes with responses a frame has
 * no way to deliver. The reverse leak is just as bad: a message type added to
 * the HTTP-only map would appear in `../http.ts`'s route table as an operation
 * with no route.
 *
 * `telemetry.event` is the one name that legitimately belongs to both worlds,
 * and it does not violate this assertion because it is not in the HTTP-only map
 * — `../http.ts` declares its ingest route's body itself. See
 * {@link HTTP_ONLY_PAYLOAD_SCHEMAS}.
 *
 * Exported for the reason {@link MessageRegistryIsComplete} is.
 *
 * @internal
 */
export type HttpOnlyNamesAreNotMessageTypes = AssertTrue<
  [Extract<keyof typeof HTTP_ONLY_PAYLOAD_SCHEMAS, MessageType>] extends [never] ? true : false
>;

/**
 * Compile-time proof that {@link HTTP_ONLY_PAYLOAD_NAMES} and
 * {@link HTTP_ONLY_PAYLOAD_SCHEMAS} name exactly the same five operations.
 *
 * The tuple is written out — it is the one list in this file that is not derived
 * from a map, because a tuple's *order* cannot be recovered from an object type
 * — so it is the one list that could fall behind. This assertion is what stops
 * it: a sixth operation added to `./session.js` or `./capture.js` and not to the
 * tuple, or a name misspelled in either place, fails `tsc -b` here.
 *
 * Exported for the reason {@link MessageRegistryIsComplete} is.
 *
 * @internal
 */
export type HttpOnlyNamesMatchTheirSchemas = AssertTrue<
  MutuallyAssignable<HttpOnlyPayloadName, keyof typeof HTTP_ONLY_PAYLOAD_SCHEMAS>
>;
