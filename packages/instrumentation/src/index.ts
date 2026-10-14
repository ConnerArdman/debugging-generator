/**
 * `@debuggen/instrumentation` — the reversible-instrumentation layer of the
 * Debug Generator.
 *
 * ## This file is the package's full public door, and `./schema` its browser-safe half
 *
 * `package.json` offers two export conditions: `"."`, mapped to
 * `dist/index.d.ts` and `dist/index.js` and seeded from this file, and
 * `"./schema"`, mapped to `dist/schema/index.d.ts` and `dist/schema/index.js`
 * and seeded from `./schema/index.ts` — the four contract vocabularies and the
 * `UnavailableSignal` type, with no Node-only module in their graph.
 * `tsup.config.ts` builds exactly those two entries. Both consumers resolve the
 * package through that map, so neither can reach a module path inside `src/`
 * and a symbol absent from the re-exports of the entry they import simply does
 * not exist for them:
 *
 * - `@debuggen/protocol` sits directly above this package in the layering of
 *   AAP §0.2.2 and embeds these shapes in its message schemas — the
 *   instrumentation plan and its actions in `instrumentation.plan`, the
 *   modification records and the `runtimeHooks` / `unavailable` triple in
 *   `instrumentation.ready`, the two producer configurations in `agent.config`
 *   and `server-agent.config`, the selected target in `target.selected`, and
 *   the conflict report in `cleanup.completed` (AAP §0.4.2). It imports
 *   **only** `@debuggen/instrumentation/schema`, because the protocol is
 *   bundled into the Chrome service worker, the DevTools panel and the VS Code
 *   webview, and this entry's graph reaches ts-morph, `node:fs` and
 *   `@debuggen/shared/node`.
 * - `apps/local-service` parses and persists those shapes and drives every
 *   operation behind this entry from them:
 *   `src/instrumentation/service.ts` builds the
 *   {@link InstrumentationContext}, creates the registry and calls
 *   {@link installPlan}; `src/instrumentation/readiness.ts` aggregates the
 *   adapters' {@link Readiness} reports into the session's "Ready to capture"
 *   state; `src/instrumentation/watcher.ts` watches the files an install
 *   reported in {@link InstallResult.applied} and marks a record `conflict`
 *   when one changes underneath it; `src/cleanup/cleanup.ts` calls
 *   {@link cleanupSession} on `session.end` and on editor deactivation, and
 *   {@link reconcileModifications} on service start; and
 *   `src/pipeline/stages/plan.ts` walks a model's proposal through
 *   {@link instrumentationPlanInputSchema}, {@link normalizePlan} — with the
 *   registry as its resolver — and {@link checkPlanFeasibility}.
 *
 * Because the packages below this one cannot import it back, this entry is also
 * the boundary at which the plan, action, modification and capture-signal
 * vocabularies become single definitions for the whole product (AAP §0.9.1): a
 * second declaration of any of them in an app is a defect.
 *
 * ## What this package may import, and what it may not
 *
 * The layering of AAP §0.2.2 is acyclic, and this package sits in the middle of
 * it. Three packages are below it and may be imported by any module here:
 * `@debuggen/shared` together with its Node-only `./node` condition (ids,
 * hashing, POSIX path containment, source locations, `Result`, the logger
 * port), `@debuggen/telemetry` (the telemetry-kind vocabulary that the capture
 * signals of `./schema/readiness.ts` map onto) and `@debuggen/code-analysis`
 * (the code graph and its queries — the authority every target is *selected*
 * from rather than recognised by name, AAP §0.5.4).
 *
 * Three packages are above it and are imported by no module here, under any
 * condition: `@debuggen/protocol`, `@debuggen/panel-schema` and
 * `@debuggen/panel-renderer`. The first is a consumer, so importing it would
 * close a cycle around the definitions this package is the single home of; the
 * other two describe how a finding is *displayed*, which is no business of the
 * layer that edits a developer's working tree. The rule is checked rather than
 * merely written down: `eslint`'s per-package `no-restricted-imports` layer
 * rejects the specifier, and the adapter suites assert it on the source text.
 *
 * ## What lives behind this entry
 *
 * Every non-test module under `src/` is re-exported here, in four groups that
 * follow the path one question travels: the four vocabularies of `schema/**`
 * that every other module is written in, taken through `./schema/index.ts` so
 * that this entry and the `./schema` subpath publish one module list; the
 * adapter contract, the six built-in adapters and the registry that resolves an
 * action type to one of them; the three drivers that gate, apply and take back
 * a plan; and the five modules of `patch/**` the patch-mode half of that work
 * is built from.
 *
 * - `schema/target` — {@link SelectedTarget}, the descriptor of the element a
 *   developer picked in the inspected page, and {@link ProblemUnderstanding},
 *   the validated output of the pipeline's problem-understanding stage, with
 *   their parsers and the problem category and entity vocabularies.
 * - `schema/plan` — the two halves of the plan contract: the authoring
 *   {@link InstrumentationPlanInput} a model produces, the internal
 *   {@link InstrumentationPlan} the rest of the product consumes, the
 *   {@link InstrumentationAction} and action-type/mode vocabularies, and
 *   {@link normalizePlan}, the deterministic step between them that resolves
 *   every action to an adapter and an install mode.
 * - `schema/modification` — {@link ModificationRecord}, the journal entry that
 *   makes an edit reversible (both content hashes, the backup path, the unified
 *   diff and the status machine), its {@link ModificationJournal} contract, and
 *   {@link ModificationConflict}, the report produced when a file may not be
 *   restored.
 * - `schema/readiness` — the {@link CaptureSignal} vocabulary and its
 *   signal-to-telemetry-kind table, the {@link Readiness} report that gates
 *   "Ready to capture", and the two runtime configurations derived from the
 *   actions actually installed — {@link AgentHookConfig} for the page agent and
 *   {@link ServerAgentSignals} for the dev-server preload.
 * - `adapter` — the {@link InstrumentationAdapter} contract of AAP §0.1.2
 *   extended per AAP §0.2.3 (`canHandle`, `createPlan`, `install`, `remove`,
 *   `readiness`), the {@link InstrumentationContext} that hands an adapter
 *   every port it is allowed to reach, and the {@link InstallResult},
 *   {@link RemoveResult} and {@link UnavailableSignal} shapes a result is
 *   reported in. Types only: adding an adapter means implementing this
 *   interface and registering it, with no change to any orchestrator.
 * - `adapters/**` — the six built-ins, each published as one type and one
 *   factory: {@link ReactAdapter} / {@link createReactAdapter},
 *   {@link BrowserPerformanceAdapter} /
 *   {@link createBrowserPerformanceAdapter}, {@link FetchAdapter} /
 *   {@link createFetchAdapter}, {@link NextJsAdapter} /
 *   {@link createNextJsAdapter}, {@link PrismaAdapter} /
 *   {@link createPrismaAdapter} and {@link PostgresAdapter} /
 *   {@link createPostgresAdapter}. Five of them arm runtime hooks and write
 *   nothing; only the framework adapter installs `patch`-mode actions, which is
 *   AAP §0.5.1's "runtime hooks by default, an edit only where a signal
 *   requires one" expressed as code rather than as a convention.
 * - `registry` — {@link createAdapterRegistry}, {@link AdapterRegistry},
 *   {@link registerAdapter} and {@link ADAPTER_IDS}: the only enumeration of
 *   adapter identity in the repository, and the resolver `normalizePlan`
 *   satisfies its structural `PlanAdapterResolver` requirement with. The
 *   registry constructs its adapters inside the factory, so importing this
 *   entry registers nothing.
 * - `feasibility` — {@link checkFeasibility} and
 *   {@link checkPlanFeasibility}, the cheap pre-install gate that refuses an
 *   action whose file, symbol or shape the project cannot support, and reports
 *   each refusal as data ({@link InfeasibleAction}) rather than as an
 *   exception.
 * - `installer` — {@link installPlan}, which turns one validated plan into
 *   armed hooks and recorded patches, runtime-mode groups strictly before
 *   patch-mode ones, unwinds only what a failed call itself applied, and
 *   returns the {@link AggregateInstallResult} the `instrumentation.ready`,
 *   `agent.config` and `server-agent.config` messages are built from. "Nothing
 *   at all could be enabled" is its single hard failure; every narrower gap is
 *   a reported unavailability and the capture proceeds.
 * - `cleanup` — the inverse of the patch layer: {@link restoreModification}
 *   for one record, {@link restoreChain} for a file several plan versions
 *   patched (strictly last-applied-first), {@link cleanupSession} for AAP
 *   §0.5.1's end-of-session guarantee and {@link reconcileModifications} for
 *   the start-up reconciliation of records no session closed. A file that no
 *   longer hashes to what this product wrote is never written: the divergence
 *   is reported and the original stays recoverable.
 * - `patch/wrap-template` — the exact text a patch writes into a developer's
 *   file: the span-helper global and inserted type alias literals, the
 *   marker list `scripts/check-no-residual-instrumentation.mjs` greps for, and
 *   {@link buildWrapperBody}.
 * - `patch/function-timing` — {@link FunctionTimingPatcher} and
 *   {@link patchFunctionTiming}, the ts-morph transform that rewrites one named
 *   symbol so its execution is timed and records the source position the
 *   resulting span carries. It performs no I/O: it returns patched text.
 * - `patch/backup-store` — {@link createBackupStore}, the content-addressed
 *   store under `$DEBUGGEN_HOME/backups/<sessionId>/<originalHash>` that holds
 *   the original bytes while an edit stands over them.
 * - `patch/conflict` — {@link detectConflict} and {@link buildConflictReport},
 *   which decide whether an instrumented file may be restored and describe the
 *   divergence when it may not. A mismatch authorises no write.
 * - `patch/patcher` — {@link createPatcher}, the crash-safe
 *   hash → backup → journal → atomic-rename sequence of AAP §0.5.1, and the
 *   only code path here that puts bytes into a working tree.
 *
 * The re-exports are flat `export *` declarations on purpose. No name declared
 * by one of these modules is declared by another, so nothing is ambiguous and
 * no alias is needed; keeping the form wildcard also means a symbol added to a
 * module is published without a second edit here, which is the failure mode an
 * explicit list invites. The one name reached twice — `UnavailableSignal`,
 * through `./schema/index.js` and through `./adapter.js` — is the same
 * declaration both times, which TypeScript resolves to one symbol rather than
 * an ambiguity (TS2308); being a type, it has no run-time binding at all. The
 * declaration build and the typecheck gate both confirm it. A future collision
 * between two *different* declarations is not silent — it is a compile error
 * at this file and in the declaration build — and the fix is to convert the two
 * colliding modules to explicit named re-export lists.
 *
 * ## Node-only here, browser-safe under `./schema`
 *
 * This entry cannot run in a page: the patch layer loads a target project
 * through `ts-morph`, hashes and replaces files through `node:fs` and the
 * `./node` entry of `@debuggen/shared`, and keeps the original bytes under the
 * product's own state directory on disk (`$DEBUGGEN_HOME/backups`, supplied by
 * the caller rather than read from the environment). `tsup` therefore builds
 * both entries with `platform: 'node'`, keeping every `node:` specifier
 * external. The schema layer is the exception the `./schema` subpath exists
 * for: its four modules import only `zod`, the browser-safe root of
 * `@debuggen/shared` and erased types, so it is split into its own entry that
 * `@debuggen/protocol` — and through it three browser bundles — can import
 * without inheriting anything above. `packages/protocol/tsup.config.ts` proves
 * that on every build by bundling the protocol for a browser target. The
 * signals the schemas describe for the browser tier are installed by the page
 * agent in `@debuggen/telemetry`; this package only declares them.
 *
 * ## Importing this module has no side effect
 *
 * `package.json` declares `sideEffects: false`, and this file keeps that true:
 * it contains nothing but this comment and `export` declarations. Nothing here
 * reads an environment variable, touches the filesystem, mutates a global,
 * starts a timer or writes to the console at load time, so a consumer that
 * imports one type pays for one type.
 *
 * That holds through the modules as well, which is what makes the claim safe
 * for a bundler to act on: no adapter is constructed at load time — every one
 * of them is built inside {@link createAdapterRegistry} — nothing installs
 * itself into a global registry on import, and the two default ports
 * ({@link defaultPatchFileSystem}, {@link defaultCleanupFileSystem}) are frozen
 * records of function references that open nothing until they are called.
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// schema — the single definitions of the target, plan, journal and readiness
// contracts that cross every process boundary in the product, through the same
// barrel the browser-safe `./schema` subpath publishes, so the two entries can
// never list different modules
// ---------------------------------------------------------------------------
export * from './schema/index.js';

// ---------------------------------------------------------------------------
// adapter — the capability contract every adapter implements and the context
// object that hands one every port it is permitted to reach (types only)
// ---------------------------------------------------------------------------
export * from './adapter.js';

// ---------------------------------------------------------------------------
// adapters — the six built-ins, in the order AAP 0.1.3 names them: the three
// browser-tier adapters that arm page-agent hooks, then the framework adapter
// (the only installer of patch-mode actions), then the two database adapters
// that claim one action type and are disambiguated by their own canHandle
// ---------------------------------------------------------------------------
export * from './adapters/react.js';
export * from './adapters/browser-performance.js';
export * from './adapters/fetch.js';
export * from './adapters/nextjs.js';
export * from './adapters/prisma.js';
export * from './adapters/postgres.js';

// ---------------------------------------------------------------------------
// registry — the one enumeration of adapter identity, the action-type resolver
// normalizePlan is given, and the extension point a seventh adapter joins
// through; constructing a registry is the only thing that constructs adapters
// ---------------------------------------------------------------------------
export * from './registry.js';

// ---------------------------------------------------------------------------
// drivers — what a validated plan is run through, in the order it travels:
// the pre-install feasibility gate, the installer (runtime hooks before
// patches, with delta rollback), and cleanup (per record, per file chain, per
// session, and the start-up reconciliation of records no session closed)
// ---------------------------------------------------------------------------
export * from './feasibility.js';
export * from './installer.js';
export * from './cleanup.js';

// ---------------------------------------------------------------------------
// patch — the reversible AST patch layer: the only writer of a developer's
// working tree, and the template, transform, backup store and conflict
// detector the write sequence is built from
// ---------------------------------------------------------------------------
export * from './patch/wrap-template.js';
export * from './patch/function-timing.js';
export * from './patch/backup-store.js';
export * from './patch/conflict.js';
export * from './patch/patcher.js';
