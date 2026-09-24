/**
 * `@debuggen/protocol` — the single cross-process contract of the Debug
 * Generator, and the one door into it.
 *
 * ## Who reads this file
 *
 * Four processes cooperate in this product, and they agree on nothing except
 * what this package defines (AAP §0.4.2):
 *
 * - the **local service** on `127.0.0.1`, which owns every session, the store,
 *   the pipeline and cleanup;
 * - the **VS Code extension** — its host, which opens source locations and
 *   manages the service lifecycle, and its React webview, which asks the
 *   question and renders progress, modifications and the analysis;
 * - the **Chrome MV3 extension** — its service worker, which owns tab binding,
 *   agent injection and transport, and its DevTools panel, which renders the
 *   generated debugger;
 * - the **Node preload** inside the target project's dev server, which reports
 *   server and database spans.
 *
 * Each of them imports this package — and, to reach one another, only this
 * package: an extension never touches a service internal, and the service never
 * hand-writes a frame an extension will parse (AAP §0.4.2). That rule is what
 * makes a wire change a compile error in every process at once instead of a
 * mismatch discovered at runtime, and `eslint.config.js` enforces the import
 * edges that express it.
 *
 * The MAIN-world browser agent is the deliberate exception, in one direction
 * only. It sits *below* this package in the layering (AAP §0.2.2) and does not
 * import it: it posts raw event batches that the Chrome service worker wraps
 * into the frames below, using `@debuggen/telemetry`'s own ingress schema (AAP
 * §0.2.3). What it sends is still validated against the schemas here, at the
 * process that receives it.
 *
 * ## One door, and what that means for a symbol that is not below
 *
 * `package.json` declares exactly one export condition, `"."`, mapping to
 * `dist/index.js` and `dist/index.d.ts`, and `tsup.config.ts` declares exactly
 * one entry — this file. So **a symbol that is not re-exported below does not
 * exist for a consumer**: Node's ESM resolver refuses any subpath the `exports`
 * map does not name, which rules out `@debuggen/protocol/dist/…` and
 * `…/src/messages/source.js` alike for the Node consumers, and the bundlers on
 * the browser side resolve through that same map. Adding a contract to this
 * package therefore ends here, with a line in one of the groups below.
 *
 * Every specifier carries an explicit `.js` extension because this project is
 * type-checked under NodeNext resolution (`tsconfig.json`), where an
 * extensionless relative import is a compile error by design — `dist/index.js`
 * is loaded as real Node ESM by the service and the extension host. tsup and
 * esbuild resolve a `'./x.js'` specifier from a TypeScript importer back to
 * `./x.ts`, and the bundlers that consume this package on the browser side pass
 * such specifiers through unchanged, so the stricter flavour costs them nothing.
 *
 * ## Each cross-boundary shape is defined once, and four of them are defined
 * elsewhere
 *
 * AAP §0.2.3 and §0.9.1 place each shape that crosses a process boundary in
 * exactly one module, and name any second definition in an app a defect:
 *
 * | Shape | Single definition |
 * | --- | --- |
 * | `SourceLocation`, `Result`, `DebuggenError`, the error codes | `@debuggen/shared` |
 * | `TelemetryEventIngress`, `TelemetryEvent`, the aggregates | `@debuggen/telemetry` |
 * | `InstrumentationPlan`, `InstrumentationAction`, the modification records | `@debuggen/instrumentation` (imported through its browser-safe `./schema` entry) |
 * | `PanelSpec`, `DataQuery`, the node catalog | `@debuggen/panel-schema` |
 * | the messages, the session record and the analysis result | **this package** |
 *
 * The modules behind this barrel *embed* the upstream schemas rather than
 * restating them — `source.open` carries `@debuggen/shared`'s
 * `sourceLocationSchema`, `telemetry.event` and `telemetry.tail` carry
 * `@debuggen/telemetry`'s ingress and persisted event schemas,
 * `instrumentation.ready` carries `@debuggen/instrumentation`'s modification
 * records, `panel.generated` carries `@debuggen/panel-schema`'s `panelSpecSchema`
 * — so a message and the artifact inside it can never disagree about what a
 * valid value is.
 *
 * Which is why the last two groups below exist, and why they are shaped the way
 * they are. Two of the three consuming apps declare **no** dependency on the
 * packages that own those embedded shapes: `apps/vscode-extension` depends on
 * `@debuggen/protocol`, `@debuggen/panel-renderer` and `@debuggen/shared` alone,
 * and `apps/chrome-extension` adds only `@debuggen/panel-schema` (AAP §0.2.2) —
 * yet the editor's webview has to render a modification list, a plan, an
 * analysis's facts and hypotheses, a capture's counts and a selected-element
 * badge. Those **types** reach it only through this file, so this file names
 * them, and the rule that keeps that honest has two halves:
 *
 * - a **type** is re-exported freely. `export type` is erased by the compiler,
 *   so naming `ModificationRecord` here adds no runtime edge to any bundle and
 *   no entry to any app's dependency list — it only lets a consumer spell the
 *   shape it already receives on the wire.
 * - a **function** is never re-exported. `normalizePlan`, `normalizePanel`,
 *   `validatePanelSpec`, `validateAgainstCapture`, the correlator and the
 *   aggregate builders stay behind their own packages' front doors, which the
 *   local service (the one consumer that declares those dependencies) imports
 *   directly. Re-exporting one would make this package a second front door to a
 *   package it merely layers above, and would put that package's runtime inside
 *   three browser bundles. `src/__tests__/envelope.test.ts` asserts the
 *   absence of those five names mechanically, so the rule outlives this comment.
 *
 * The one exception to "types only" is a closed `as const` vocabulary a user
 * interface has to iterate or render — the telemetry kinds and tiers, the metric
 * ids, the modification statuses, the data-query sources and sorts, the
 * confidence levels and the query paging bounds. Each is a frozen tuple or a
 * number with no behaviour to smuggle, and each is re-exported by name so that
 * an unused one is dropped by the consumer's tree-shaker. They add no new edge
 * either: the message schemas above already import Zod schemas from all four
 * packages at runtime, which is what `tsup.config.ts` keeps external.
 *
 * ## The layering inside this package, of which this file is the bottom
 *
 * The module graph runs strictly one way (`src/version.ts` states it in full):
 *
 * ```text
 * @debuggen/{shared,telemetry,instrumentation/schema,panel-schema}
 *   → version.ts
 *   → analysis.ts → session-record.ts
 *   → messages/*.ts → messages/index.ts
 *   → envelope.ts → http.ts → client/*.ts → index.ts
 * ```
 *
 * `version.ts` is at the top because every other module imports it and none of
 * them may import anything from this package in return — the wire version the
 * handshake compares, the epoch-millisecond timestamp every message carries and
 * the leak-free issue renderer every parse helper calls have to be reachable
 * before anything that needs them exists. This file is at the bottom, is
 * imported by nothing inside `src/`, and holds no logic of its own: the groups
 * below are in that same order, so reading them top to bottom is reading the
 * package's dependency order.
 *
 * Two directions cost the most to get wrong, and both are structural rather than
 * advisory:
 *
 * - a `messages/*` module **never imports `envelope.ts`**. Each one exports its
 *   own frozen `type → payload schema` map instead, and combining those maps
 *   into the single registry the envelope's discriminated union dispatches on
 *   belongs to `messages/index.ts` one level up.
 * - **only this file imports `client/*`**. The two transport wrappers sit above
 *   every schema module, so nothing in `src/**` may reach down into them; a
 *   schema that needed a client would be a cycle, and a client that a schema
 *   could call would be a way for validation to perform I/O.
 *
 * This barrel assembles no registry and validates nothing — it re-exports, so
 * that the surface stays reviewable in one file and so that no consumer can be
 * broken by a change to how the registry is built.
 *
 * ## Environment-neutral, by construction rather than by care
 *
 * This bundle is loaded by a Node process *and* by three page-side bundles — the
 * MV3 service worker, the DevTools panel page and the VS Code webview — so
 * `tsconfig.json` declares `types: []` (making `process`, `Buffer`, `__dirname`
 * and `require` type errors rather than code that compiles here and breaks in a
 * browser) and `tsup.config.ts` builds with `platform: 'neutral'` and
 * `removeNodeProtocol: false`, which leaves esbuild no builtin list to
 * externalise a stray `node:*` import into. No `node:` builtin, no
 * `@debuggen/shared/node` entry and no `ws` import may enter the graph this file
 * roots — neither directly nor **transitively**, through a dependency's own
 * imports — and each would fail the build here rather than surface as an
 * unresolved builtin in the panel's Vite build.
 *
 * The transitive half is the one a per-file rule cannot see, so it is checked
 * on the built artefact. After every build `tsup.config.ts` bundles the fresh
 * `dist/index.js` for `platform: 'browser'` *with* its dependencies resolved
 * through their `exports` maps, as the extensions' bundlers resolve them, and
 * fails the build naming each specifier that does not resolve and the module
 * that imported it. What keeps that check green is the import discipline of
 * `src/**`: from `@debuggen/shared` only the browser-safe `"."` entry, and from
 * `@debuggen/instrumentation` only the `./schema` entry — the schema layer
 * split from that package's ts-morph and `node:fs` patch layer — and never the
 * package root, whose graph reaches `node:fs`, `node:os`, `node:path` and
 * `node:crypto` through `@debuggen/code-analysis` and `@debuggen/shared/node`.
 *
 * `ReconnectingWsClient` is the shape of that guarantee where it would otherwise
 * be hardest to keep: it takes an **injected** WebSocket constructor, typed by
 * this package's own minimal structural interface, so the service passes `ws`
 * 8.21.3 while the service worker and the webview pass the platform global, and
 * neither dependency is named here. `HttpClient` likewise uses web-standard
 * `fetch`, `Headers` and `AbortController`, which exist in Node 24 and in every
 * supported browser.
 *
 * Importing this module has no side effect. `package.json` declares
 * `sideEffects: false`, every export below is a declaration, and nothing reached
 * from here reads an environment variable, mutates a global, starts a timer,
 * performs I/O or holds mutable module-scope state at load time — which matters
 * because the service imports this package during start-up and three browser
 * bundles inline it. Every export is named; there is no default export.
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// version — the package's cycle-breaker: the wire version and its handshake
// predicate, the one epoch-millisecond timestamp primitive, the leak-free Zod
// issue renderer and error constructor every parse helper below calls, and the
// sanctioned wrappers for embedding an upstream type that owns no Zod schema.
// ---------------------------------------------------------------------------
export * from './version.js';

// ---------------------------------------------------------------------------
// analysis — the analysis artifact: the model-authored findings (`observed`
// facts and `likelyCauses`, each evidence-backed by construction) and the
// stored, broadcast `AnalysisResult` that adds identity, provenance, timestamp
// and the capture's metric values, plus the deterministic assembler that turns
// the first into the second.
// ---------------------------------------------------------------------------
export * from './analysis.js';

// ---------------------------------------------------------------------------
// session-record — the state of one debugging session, defined exactly once for
// the whole product (AAP §0.9.1): the eleven-status and four-cleanup-status
// vocabularies, the relevant-file, bound-tab, capture, follow-up, cleanup,
// prompt-version and provider sub-records, and the `SessionRecord` the service
// persists as its `sessions.record` JSON column, broadcasts on
// `session.created`/`session.updated` and returns from every session route —
// which both user interfaces render directly.
// ---------------------------------------------------------------------------
export * from './session-record.js';

// ---------------------------------------------------------------------------
// messages — every WebSocket payload of AAP §0.4.2 and the two HTTP-only
// payload families, as one module. `messages/index.ts` re-exports all eleven
// domain modules in full (`error`, `agent`, `binding`, `session`, `capture`,
// `instrumentation`, `telemetry`, `panel`, `source`, `target`, `cleanup`), so
// this single line carries every payload schema, every inferred payload type
// and every parse helper, together with the registry they compose into —
// `MESSAGE_PAYLOAD_SCHEMAS` and the `MESSAGE_TYPES` tuple the envelope below
// dispatches on — and the transport constants the handshake needs,
// `WS_CLOSE_UNAUTHORIZED` (4401) and `CLIENT_HELLO_TIMEOUT_MS` (3000).
// ---------------------------------------------------------------------------
export * from './messages/index.js';

// ---------------------------------------------------------------------------
// envelope — the frame itself: the four shared fields (`id`, `type`, `ts`,
// optional `sessionId`) declared once in `envelopeBaseShape`, the
// `ProtocolMessage` discriminated union over the registry above, the schema
// that validates it, and the four functions every transport uses —
// `createEnvelope` to mint a routable frame, `encodeMessage` and
// `decodeMessage` for the text hop, `parseMessage` for a value that arrived
// some other way — plus the `isMessageOfType` narrowing guard and the
// exhaustiveness helper a receiver's switch ends with.
// ---------------------------------------------------------------------------
export * from './envelope.js';

// ---------------------------------------------------------------------------
// http — the conventional-request half of the transport: the `HTTP_ROUTES`
// table with a request and response schema per operation, the `HTTP_OPERATIONS`
// tuple, the `HttpOperationId` union derived from it (the key type of the
// service's `Record<HttpOperationId, RouteHandler>` handler map, also spelled
// `HttpOperation`) and the `HttpRequestBody`/`HttpResponseBody` lookups over
// it, the `AUTH_EXEMPT_OPERATIONS` pair and the bearer-header helpers that
// express the access boundary of AAP §0.5.6, `WS_PATH` for the upgrade, the
// typed path builders a caller uses instead of concatenating a URL, the paged
// `DataResult` union the panel-data route answers with, and the two parse
// helpers that validate a body against the operation that received it.
// ---------------------------------------------------------------------------
export * from './http.js';

// ---------------------------------------------------------------------------
// client/ws-client — the reconnecting WebSocket SDK the VS Code extension host
// and the Chrome service worker share: the `client.hello` handshake, bounded
// exponential backoff, a send queue across a drop, and typed per-type
// subscription. The WebSocket constructor and the timer API are injected, which
// is what lets one implementation serve Node and both page contexts.
//
// This is the transport, and it belongs to the two background layers. A panel
// or webview component receives data and callbacks from its host instead
// (AAP §0.1.2, "avoid tightly coupling UI components directly to WebSocket
// implementation details"), so no convenience wrapper is added here that would
// invite a React component to open a socket.
// ---------------------------------------------------------------------------
export * from './client/ws-client.js';

// ---------------------------------------------------------------------------
// client/http-client — the request half of the same SDK: a small `fetch`
// wrapper that attaches the bearer credential, validates each response against
// the operation's schema and returns this repository's `Result` rather than
// throwing, over an injected `fetch` and token provider.
// ---------------------------------------------------------------------------
export * from './client/http-client.js';

// ===========================================================================
// The embedded upstream shapes, as types
//
// Everything above is this package's own. Everything below is borrowed, and
// borrowed in one direction only: these are the shapes the message, route and
// session schemas above already carry, named here so that a consumer can spell
// what it receives.
//
// The reason is not convenience. Per AAP §0.2.2, `apps/vscode-extension`
// declares `@debuggen/protocol`, `@debuggen/panel-renderer` and
// `@debuggen/shared` and nothing else, and `apps/chrome-extension` adds only
// `@debuggen/panel-schema` — neither can import `@debuggen/telemetry` or
// `@debuggen/instrumentation` at all. Without the four groups below, the
// editor's webview could receive an `instrumentation.ready` frame and be unable
// to name the `ModificationRecord[]` inside it, and the DevTools panel could
// receive a `telemetry.tail` frame and be unable to name a `TelemetryEvent`.
//
// Each group is `export type`, which the compiler erases: the declarations in
// `dist/index.d.ts` point a type-checker at the owning package, while
// `dist/index.js` gains nothing at all, so no app's bundle acquires a runtime
// edge and no app's dependency list becomes a lie. That erasure is the whole
// mechanism, and it is why this block must never be "tidied" into a wildcard or
// promoted to value re-exports: a wildcard would re-export the owners' runtime
// helpers (their normalisers, validators, correlator and aggregate builders)
// and turn this package into a second front door to packages it merely layers
// above. Only the local service declares those dependencies, and it imports
// each owner directly.
//
// A shape reaches this list by appearing in a public signature above. Nothing
// is listed speculatively, and a shape defined here instead of being borrowed
// would be the duplicate definition AAP §0.2.3 calls a defect.
// ===========================================================================

// The one source location, from `@debuggen/shared`: carried by `source.open`,
// by `Hypothesis.suggestedLocation` inside an analysis and a panel summary, by
// every located runtime item, and by the editor command that opens a file at a
// line. `SourceResolvedBy` is the provenance of the four resolution routes
// (patch metadata, code graph, source map, React owner chain, route map), which
// a user interface renders as a confidence hint rather than hiding.
export type { SourceLocation, SourceResolvedBy } from '@debuggen/shared';

// The telemetry model, from `@debuggen/telemetry`. The two event schemas are
// what `telemetry.event` (ingress, no session) and `telemetry.tail` (persisted,
// redacted) carry; `CaptureSummary` and `MetricValue`/`MetricId` are what
// `capture.stopped` and an analysis's metrics carry; the remaining eight are the
// aggregate shapes the panel-data route answers with, one per `DataQuery`
// source, plus the correlated trace tree a timeline and a flame view read.
export type {
  CaptureSummary,
  ComponentTreeSnapshot,
  DependencyGraphData,
  MetricId,
  MetricValue,
  QueryGroup,
  RenderStat,
  RequestGroup,
  StateTransition,
  TelemetryEvent,
  TelemetryEventIngress,
  TelemetryKind,
  TelemetryTier,
  TraceNode,
  TraceTree,
} from '@debuggen/telemetry';

// The instrumentation model, from `@debuggen/instrumentation/schema` — the
// browser-safe entry of `@debuggen/instrumentation`, and the only one this
// package imports. `instrumentation.plan` carries the normalised plan and its
// actions; `instrumentation.ready` carries the modification records, the
// runtime hooks that came up and the signals that did not; `cleanup.completed`
// carries the conflicts; `target.selected` carries the selected element;
// `agent.config` and `server-agent.config` carry the two hook configurations;
// and `Readiness` is what gates the "Ready to capture" state both user
// interfaces show. `ProblemUnderstanding` is the first pipeline artifact a
// session record holds.
export type {
  AgentHookConfig,
  CaptureSignal,
  InstrumentationAction,
  InstrumentationActionType,
  InstrumentationPlan,
  ModificationConflict,
  ModificationRecord,
  ModificationStatus,
  ProblemUnderstanding,
  Readiness,
  SelectedTarget,
  ServerAgentSignals,
  UnavailableSignal,
} from '@debuggen/instrumentation/schema';

// The panel model, from `@debuggen/panel-schema`. `panel.generated` carries the
// validated specification and its layout nodes; the panel-data request body *is*
// a `DataQuery`; and `Fact`, `Hypothesis`, `EventRef` and `ConfidenceLevel` are
// the evidence-separated summary shapes an analysis and a panel share, which
// both user interfaces render under their own "Observed" and "Likely cause"
// headings (AAP §0.8.4).
export type {
  ConfidenceLevel,
  DataQuery,
  DataQueryFilter,
  DataQuerySort,
  DataQuerySource,
  EventRef,
  Fact,
  Hypothesis,
  PanelNode,
  PanelNodeType,
  PanelSpec,
} from '@debuggen/panel-schema';

// ===========================================================================
// The embedded upstream vocabularies, as values
//
// The narrow, deliberate exception to "types only" above: a closed `as const`
// tuple (or a bound derived from one) that a user interface has to iterate or
// render rather than merely name — a filter row over the telemetry kinds, a
// metric-card picker, a status badge legend, a data-source selector, a
// confidence badge, a paging control that must agree with the service about its
// limits. A type cannot be iterated, so for these the value is the contract.
//
// Every entry qualifies on three counts: it is frozen data with no behaviour,
// it is named rather than wildcarded, so a consumer's tree-shaker drops the
// statement for one it never touches, and it adds no edge this package does not
// already have — the message and route schemas above import Zod schemas from
// all four owners at run time (`selectedTargetSchema`,
// `modificationConflictSchema`, `agentHookConfigSchema`,
// `serverAgentSignalsSchema`, `modificationRecordSchema`,
// `telemetryEventSchema`, `panelSpecSchema`, `sourceLocationSchema`), which is
// exactly what `tsup.config.ts` keeps external.
//
// What each of those edges costs a browser bundle was measured rather than
// assumed. `MODIFICATION_STATUSES` and the instrumentation schemas above come
// from `@debuggen/instrumentation/schema`, whose `dist/schema/index.js` imports
// only the chunk holding that package's four schema modules, and that chunk
// imports nothing but `zod` and `@debuggen/shared` — tens of kilobytes, not the
// ts-morph and `node:fs` patch layer the package root fuses them with, which
// this package never imports. The telemetry and panel-schema vocabularies cost
// the same kind of thing: their owners' bundles import nothing but `zod` and
// `@debuggen/shared`. `tsup.config.ts` re-proves all of it on every build by
// bundling `dist/index.js` for a browser target, so a regression in any owner
// fails this package's build rather than an extension's.
//
// Nothing else joins this block. A function, a Zod schema, a class or a mutable
// object here would hand an upstream package's runtime to three browser bundles
// through a package that is meant to be a contract, and the guard in
// `src/__tests__/envelope.test.ts` fails the build if one appears.
// ===========================================================================

// The span kinds and the three tiers an event can belong to: the vocabulary a
// live tail's filter, an event-log column and a timeline lane legend are built
// from, and the metric ids a metric-card node may name.
export { METRIC_IDS, TELEMETRY_KINDS, TELEMETRY_TIERS } from '@debuggen/telemetry';

// The five states a recorded file modification moves through
// (`pending → applied → reverted`, or `conflict`/`failed`): the legend the
// editor's modification list and the panel's session summary render, and the
// set a status badge must handle exhaustively.
export { MODIFICATION_STATUSES } from '@debuggen/instrumentation/schema';

// The panel-data query vocabulary: the ten sources, the three sort orders, the
// three confidence levels a hypothesis badge renders, and the paging bounds a
// caller must respect so that a request the service would reject is a compile
// error or a clamped value rather than a failed round trip.
export {
  CONFIDENCE_LEVELS,
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
  DATA_QUERY_SORTS,
  DATA_QUERY_SOURCES,
} from '@debuggen/panel-schema';
