/**
 * `@debuggen/instrumentation` — the reversible-instrumentation layer of the
 * Debug Generator.
 *
 * ## This file is the package's only public door
 *
 * `package.json` offers exactly one export condition — `"."`, mapped to
 * `dist/index.d.ts` and `dist/index.js` — and `tsup.config.ts` seeds its build
 * from this file and nothing else. Both consumers resolve the package through
 * that map, so neither can reach a module path inside `src/` and a symbol
 * absent from the re-exports below simply does not exist for them:
 *
 * - `@debuggen/protocol` sits directly above this package in the layering of
 *   AAP §0.2.2 and embeds these shapes in its message schemas — the
 *   instrumentation plan and its actions in `instrumentation.plan`, the
 *   modification records in `instrumentation.ready`, the two producer
 *   configurations in `agent.config` and `server-agent.config`, the selected
 *   target in `target.selected`, and the conflict report in `cleanup.completed`
 *   (AAP §0.4.2).
 * - `apps/local-service` parses and persists those shapes, drives the patch
 *   layer from a validated plan, and reconciles the journal at start-up.
 *
 * Because the packages below this one cannot import it back, this entry is also
 * the boundary at which the plan, action, modification and capture-signal
 * vocabularies become single definitions for the whole product (AAP §0.9.1): a
 * second declaration of any of them in an app is a defect.
 *
 * ## What lives behind this entry
 *
 * Every non-test module under `src/` is re-exported here, in two groups — the
 * four contract modules of `schema/**` first, then the five modules of
 * `patch/**`, which import from them:
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
 * explicit list invites. A future name collision is not silent — it is a
 * compile error at this file and in the declaration build — and the fix is to
 * convert the two colliding modules to explicit named re-export lists.
 *
 * ## Node-only, by construction
 *
 * Unlike `@debuggen/shared` and `@debuggen/telemetry`, this package splits off
 * no browser-safe entry, because none of it can run in a page: the patch layer
 * loads a target project through `ts-morph`, hashes and replaces files through
 * `node:fs` and the `./node` entry of `@debuggen/shared`, and keeps the
 * original bytes under the product's own state directory on disk
 * (`$DEBUGGEN_HOME/backups`, supplied by the caller rather than read from the
 * environment). `tsup` therefore builds this entry with `platform: 'node'`,
 * keeping every `node:` specifier external. The signals the schemas describe
 * for the browser tier are installed by the page agent in
 * `@debuggen/telemetry`; this package only declares them.
 *
 * ## Importing this module has no side effect
 *
 * `package.json` declares `sideEffects: false`, and this file keeps that true:
 * it contains nothing but this comment and `export` declarations. Nothing here
 * reads an environment variable, touches the filesystem, mutates a global,
 * starts a timer or writes to the console at load time, so a consumer that
 * imports one type pays for one type.
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// schema — the single definitions of the target, plan, journal and readiness
// contracts that cross every process boundary in the product
// ---------------------------------------------------------------------------
export * from './schema/target.js';
export * from './schema/plan.js';
export * from './schema/modification.js';
export * from './schema/readiness.js';

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
