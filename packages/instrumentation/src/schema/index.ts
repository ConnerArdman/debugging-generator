/**
 * `@debuggen/instrumentation/schema` — the browser-safe half of this package:
 * the four contract vocabularies, and nothing that edits a working tree.
 *
 * ## What this entry is
 *
 * The package's second public door, next to the `"."` barrel in
 * `../index.ts`. `package.json` maps the `"./schema"` export condition to
 * `dist/schema/index.js` and `dist/schema/index.d.ts`, and `tsup.config.ts`
 * seeds a second entry from this file, so what is re-exported below is the
 * whole of what a consumer of the subpath can reach:
 *
 * - `./target.js` — `SelectedTarget`, `ProblemUnderstanding`, their schemas,
 *   parsers and the problem category and entity vocabularies;
 * - `./plan.js` — the authoring `InstrumentationPlanInput`, the normalised
 *   `InstrumentationPlan`, the `InstrumentationAction` and action-type/mode
 *   vocabularies, and `normalizePlan`, a pure function over its inputs;
 * - `./modification.js` — `ModificationRecord`, `MODIFICATION_STATUSES`, the
 *   `ModificationJournal` port (a type) and `ModificationConflict`;
 * - `./readiness.js` — the `CaptureSignal` vocabulary, `Readiness`, and the
 *   `AgentHookConfig` / `ServerAgentSignals` runtime configurations;
 * - `UnavailableSignal`, re-exported as a **type** from `../adapter.js`, because
 *   `instrumentation.ready` carries it and the protocol has to name it. The
 *   `export type` form is erased by the compiler, so it adds no run-time edge to
 *   the adapter module — whose own imports are themselves type-only. At the type
 *   level the interface references nothing but `CaptureSignal`; the declaration
 *   build places the adapter module's declarations in the declaration chunk both
 *   entries share, so a type-checker reading `dist/schema/index.d.ts` also
 *   resolves the `@debuggen/code-analysis` types that chunk names. That is a
 *   declaration-only edge, which no bundle ever follows.
 *
 * `../index.ts` re-exports this barrel in full, so every symbol here is also
 * reachable through `"."`, and the local service — which loads both entries in
 * one process, the root directly and this subpath through `@debuggen/protocol`
 * — sees one module for each. `tsup.config.ts` builds the two entries with code
 * splitting, which places these four modules in a single shared chunk that both
 * `dist/index.js` and `dist/schema/index.js` import: one instance of every Zod
 * schema per process, so a value validated through one entry is recognised by
 * the other and `===` holds between their exports.
 *
 * ## Who consumes it
 *
 * `@debuggen/protocol`, and through it every surface that bundles the protocol
 * for a page: the Chrome MV3 service worker, the DevTools panel and the VS Code
 * webview. The protocol's message, route and session-record schemas embed these
 * schemas at run time (`instrumentation.plan`, `instrumentation.ready`,
 * `agent.config`, `server-agent.config`, `target.selected`,
 * `cleanup.completed`, `GET /sessions/:id/modifications`, `SessionRecord`), so
 * this graph is inlined into three browser bundles. Before this entry existed
 * the protocol imported the `"."` barrel, whose single bundle fuses these
 * schemas with the ts-morph and `node:fs` patch layer; a browser build of the
 * protocol then failed to resolve `node:fs`, `node:fs/promises`, `node:os`,
 * `node:path` and `node:crypto` through `@debuggen/code-analysis` and
 * `@debuggen/shared/node`.
 *
 * ## The invariant this file exists to keep
 *
 * The module graph rooted here may reach **only** `zod` and the browser-safe
 * `"."` entry of `@debuggen/shared` at run time, plus type-only imports that the
 * compiler erases (`@debuggen/telemetry`'s `TelemetryKind` in
 * `./readiness.ts`, this package's `../adapter.js` below). It must never reach a
 * `node:*` builtin, `@debuggen/shared/node`, `@debuggen/code-analysis`,
 * `ts-morph`, `diff`, or any adapter, registry, feasibility, installer, cleanup
 * or `patch/**` module. The boundary is enforced mechanically downstream:
 * `packages/protocol/tsup.config.ts` bundles the freshly built protocol for a
 * browser target after every build and fails that build — naming the
 * unresolved specifier and its importer — if anything added here, or anything a
 * schema module starts importing, pulls a Node-only module into the graph.
 *
 * A schema that needs a Node capability therefore does not belong in
 * `schema/**`: it belongs beside the code that owns the capability, behind the
 * `"."` entry, with the schema layer keeping only the shape it validates.
 *
 * ## Importing this module has no side effect
 *
 * `package.json` declares `sideEffects: false`, and this file contains nothing
 * but this comment and `export` declarations; the four modules behind it build
 * Zod schemas, frozen tuples and constant tables at load time and nothing else —
 * no environment read, no global mutation, no timer, no I/O. Every export is named;
 * there is no default export.
 *
 * @example
 * ```ts
 * // Browser-safe: resolves to dist/schema/index.js, never to the patch layer.
 * import { modificationRecordSchema, MODIFICATION_STATUSES } from '@debuggen/instrumentation/schema';
 * import type { ModificationRecord, UnavailableSignal } from '@debuggen/instrumentation/schema';
 * ```
 *
 * @packageDocumentation
 */

// The four vocabularies, in the order `../index.ts` has always listed them.
// Flat wildcards for the reason that barrel gives: no name is declared by two
// of these modules, so nothing is ambiguous, and a symbol added to one is
// published through both entries without a second edit.
export * from './target.js';
export * from './plan.js';
export * from './modification.js';
export * from './readiness.js';

// The one adapter-contract shape a protocol message carries. Type-only on
// purpose: a value export here would give this browser-safe graph a run-time
// edge into `../adapter.js`, the first step towards the patch layer.
export type { UnavailableSignal } from '../adapter.js';
