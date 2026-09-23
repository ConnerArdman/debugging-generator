/**
 * `@debuggen/protocol` — the single cross-process contract of the Debug
 * Generator, and the one door into it.
 *
 * Four processes cooperate in this product, and they agree on nothing except
 * what this package defines (AAP §0.4.2):
 *
 * - the **local service** on `127.0.0.1`, which owns every session, the store,
 *   the pipeline and cleanup;
 * - the **VS Code extension** — its host, which opens source locations and
 *   manages the service lifecycle, and its webview;
 * - the **Chrome MV3 extension** — its service worker, which owns tab binding,
 *   agent injection and transport, and its DevTools panel, which renders;
 * - the **Node preload** inside the target project's dev server, which reports
 *   server and database spans.
 *
 * The service and both extensions import this package — and, to reach each
 * other, only this package: an extension never touches a service internal, and
 * the service never hand-writes a frame an extension will parse (AAP §0.4.2).
 * That rule is what makes a wire change a compile error in every process at
 * once instead of a mismatch discovered at runtime, and `eslint.config.js`
 * enforces the import edges that express it.
 *
 * The two telemetry producers are the deliberate exception, in one direction
 * only. Both sit *below* this package in the layering (AAP §0.2.2) and neither
 * imports it: the MAIN-world browser agent posts raw event batches that the
 * Chrome service worker wraps into the frames below, and the Node preload
 * reports its spans to the service over HTTP with `@debuggen/telemetry`'s own
 * ingress schema (AAP §0.2.3). What they send is still validated against the
 * schemas here, at the process that receives it.
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
 * ## Each cross-boundary shape is defined once, and not all of them here
 *
 * AAP §0.2.3 and §0.9.1 place each shape that crosses a process boundary in
 * exactly one module, and name any second definition in an app a defect:
 *
 * | Shape | Single definition |
 * | --- | --- |
 * | `SourceLocation`, `Result`, `DebuggenError`, the error codes | `@debuggen/shared` |
 * | `TelemetryEventIngress`, `TelemetryEvent`, the aggregates | `@debuggen/telemetry` |
 * | `InstrumentationPlan`, `InstrumentationAction`, the records | `@debuggen/instrumentation` |
 * | `PanelSpec`, `DataQuery`, the node catalog | `@debuggen/panel-schema` |
 * | the messages those shapes travel inside | **this package** |
 *
 * Which is why this barrel re-exports the message layer and nothing else. The
 * modules behind it *embed* the upstream schemas — `source.open` carries
 * `@debuggen/shared`'s `sourceLocationSchema`, `telemetry.event` and
 * `telemetry.tail` carry `@debuggen/telemetry`'s ingress and persisted event
 * schemas, `capture.stopped` carries its `CaptureSummary` — and a consumer that
 * needs one of those shapes, or the `Result`/`DebuggenError` pair every parse
 * helper below returns, imports it from its owner directly. Re-exporting a
 * borrowed shape from here would give it a second import path, which is how two
 * layers start disagreeing about what a valid event is; it would also make this
 * package's published surface grow whenever a package below it grows.
 *
 * ## The layering inside this package, of which this file is the bottom
 *
 * The module graph runs strictly one way (`src/version.ts` states it in full):
 *
 * ```text
 * @debuggen/{shared,telemetry,instrumentation,panel-schema}
 *   → version.ts
 *   → analysis.ts → session-record.ts
 *   → messages/*.ts → messages/index.ts
 *   → envelope.ts → http.ts → client/*.ts → index.ts
 * ```
 *
 * That graph is the package's plan of record (AAP §0.7.1). What `src/` holds
 * today is `version.ts`, `analysis.ts` and the `messages/*` modules that have
 * landed, and the groups below re-export exactly those: tsup resolves every
 * specifier in this file when it builds `dist/index.js`, so a barrel can only
 * ever name a module that is there.
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
 * The direction that costs the most to get wrong is the one between the
 * messages and the envelope: a `messages/*` module never imports the envelope.
 * Each one exports its own frozen `type → payload schema` map instead, and
 * combining those maps into the single registry the envelope's discriminated
 * union dispatches on belongs to `messages/index.ts` one level up. **This
 * barrel assembles no registry and validates nothing** — it re-exports, so that
 * the surface stays reviewable in one file and so that no consumer can be
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
 * roots; each would fail the build here rather than surface as an unresolved
 * builtin in the panel's Vite build.
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
// messages/error — the generic `error` frame (AAP §0.4.2): the failure reply any
// request or subscription can receive, over the closed error-code vocabulary
// `@debuggen/shared` defines, with the correlation reference this protocol adds
// so a receiver can say which of its frames failed.
// ---------------------------------------------------------------------------
export * from './messages/error.js';

// ---------------------------------------------------------------------------
// messages/agent — the client handshake and the two runtime agents' lifecycle:
// `client.hello`, the first frame every connection sends and the one that names
// its kind and carries its credential, `agent.ready`, the browser agent's report
// that it is installed in a document, and the two arming messages,
// `agent.config` for the page agent and `server-agent.config` for the Node
// preload, whose cleared form returns each of them to dormant.
// ---------------------------------------------------------------------------
export * from './messages/agent.js';

// ---------------------------------------------------------------------------
// messages/binding — the four messages that pair an inspected Chrome tab with a
// session (`session.bind`, `session.bound`, `tab.navigated`, `session.unbind`),
// which is what makes delivery of the agent config, the element-picker request,
// the live tail and a generated panel a routable instruction.
// ---------------------------------------------------------------------------
export * from './messages/binding.js';

// ---------------------------------------------------------------------------
// messages/capture — the capture window: the `capture.started` / `capture.stopped`
// broadcasts every client of a session receives, and the `capture.start` /
// `capture.stop` HTTP request and response bodies the caller that pressed the
// button gets its answer from.
// ---------------------------------------------------------------------------
export * from './messages/capture.js';

// ---------------------------------------------------------------------------
// messages/instrumentation — what the tool is about to do to the developer's
// working tree and what it managed to do: `instrumentation.plan` carrying the
// normalised plan, `instrumentation.ready` carrying the applied modification
// records, the runtime hooks that came up and the signals that did not, and
// `instrumentation.failed` for the one case where nothing at all could be
// enabled.
// ---------------------------------------------------------------------------
export * from './messages/instrumentation.js';

// ---------------------------------------------------------------------------
// messages/panel — `panel.generated`, the frame that hands a validated panel
// specification to the DevTools panel and the editor once analysis has produced
// one, carrying the spec exactly as `@debuggen/panel-schema` defines it.
// ---------------------------------------------------------------------------
export * from './messages/panel.js';

// ---------------------------------------------------------------------------
// messages/source — `source.open`, the hop that carries an already-resolved
// project location from the DevTools panel to the editor and makes every
// runtime item in a generated panel clickable.
// ---------------------------------------------------------------------------
export * from './messages/source.js';

// ---------------------------------------------------------------------------
// messages/target — the element-selection round trip: `target.request`, the
// service asking the bound panel to enter picker mode, and `target.selected`,
// the panel answering with the selected element's descriptor and component
// chain.
// ---------------------------------------------------------------------------
export * from './messages/target.js';

// ---------------------------------------------------------------------------
// messages/telemetry — the two directions of the event stream: `telemetry.event`,
// the batch a producer sends inward carrying the ingress schema that cannot
// claim a session, and `telemetry.tail`, the already-redacted replay the service
// sends outward to the DevTools panel.
// ---------------------------------------------------------------------------
export * from './messages/telemetry.js';
