/**
 * The **adapter contract** of `@debuggen/instrumentation`, and the
 * **injection seam** that keeps this package free of I/O policy.
 *
 * AAP §0.1.2 states the shape this file starts from — `canHandle`,
 * `createPlan`, `install`, `remove` — and AAP §0.2.3 states what it is extended
 * to: a `readiness` probe, an explicit context object, and an
 * {@link InstallResult} whose `applied` / `runtimeHooks` / `unavailable` triple
 * is exactly what the `instrumentation.ready` message carries (AAP §0.4.2).
 * Everything below is that contract, written once, so that AAP §0.4.2's promise
 * holds literally: **adding an adapter means implementing
 * {@link InstrumentationAdapter} and registering it — no orchestrator change.**
 *
 * ## Who implements this, and who calls it
 *
 * - The six built-in adapters under `./adapters/**` implement
 *   {@link InstrumentationAdapter}, and `./registry.ts` is the single place
 *   their identities are enumerated (see the capability note at the end of this
 *   file). A third-party adapter joins them at runtime through the registry's
 *   `registerAdapter()`, which is why no type here is keyed by a closed set of
 *   adapter ids.
 * - `./installer.ts` calls `install` on the adapters a plan resolved to,
 *   runtime-mode actions before patch-mode ones, and aggregates their
 *   {@link InstallResult}s. `./cleanup.ts` calls `remove`.
 * - `apps/local-service/src/instrumentation/service.ts` builds the
 *   {@link InstrumentationContext}, `.../readiness.ts` aggregates the
 *   per-adapter {@link Readiness} reports into the session's "Ready to capture"
 *   state, and `.../watcher.ts` watches the files an install reported in
 *   {@link InstallResult.applied}.
 * - `packages/protocol/src/messages/instrumentation.ts` embeds the results:
 *   `instrumentation.ready { applied, runtimeHooks, unavailable }` and
 *   `instrumentation.failed`. That package sits **above** this one, so nothing
 *   here imports it (AAP §0.2.2).
 *
 * ## Why the context is an argument and not an import
 *
 * Every fact an adapter needs about the machine it is running on arrives in
 * {@link InstrumentationContext}: the project root, the state directory, the
 * code graph and its queries, the journal port, the backup store, the clock,
 * the cancellation signal, and the readiness facts the service observed. This
 * module therefore reads **no environment variable**, opens **no database**,
 * touches **no filesystem** and makes **no network call** — and neither may an
 * adapter, except through the ports it is handed.
 *
 * That is not tidiness. An adapter that read `$DEBUGGEN_HOME` itself could file
 * a session's backups somewhere the journal does not point at, and a conflict
 * would then be reported for a file whose original the product could no longer
 * find; an adapter that consulted the real clock could not be asserted against;
 * an adapter that decided readiness from its own probe would contradict the
 * `agent.ready` frame the service actually received. Passing all of it in makes
 * every adapter a pure function of stated inputs, which is what lets
 * `./adapters/*.test.ts` exercise the real adapters with no dev server, no
 * browser and no working tree.
 *
 * ## Failure is reported, not thrown
 *
 * An {@link InstallResult} has two channels for what did not work, and the line
 * between them is the one AAP §0.5.5 and AAP §0.4.2 draw together:
 *
 * - **A gap is data.** An adapter that cannot enable a signal still returns a
 *   successful result describing the gap in {@link InstallResult.unavailable},
 *   and the capture proceeds with what is available — a dev-server preload
 *   that is absent or silent, a React hook installed after React loaded. Only
 *   "nothing could be enabled at all" turns gaps into an installer-level
 *   failure, and that judgement belongs to `./installer.ts`, which is the only
 *   party that can see every adapter's answer.
 * - **A failed action is fatal.** An action accepted for install that could
 *   not be completed — a patch refused or failed after the feasibility gate
 *   admitted it, a write-path failure, a cancellation part-way through the
 *   sequence — is reported in {@link InstallResult.failure}, beside the records
 *   that did land in {@link InstallResult.applied}. `./installer.ts` then
 *   reverse-restores every record the current install applied and fails the
 *   install, so a follow-up's delta is all-or-nothing and the session stays at
 *   its previous plan version. It is *returned* rather than thrown because a
 *   rejected promise cannot carry the records the rollback has to restore.
 *
 * A rejected promise remains the channel for an outcome that is unknowable,
 * such as a journal that could not be written: the installer still unwinds
 * what earlier adapters applied, but only a returned failure lets it restore
 * the failing adapter's own records.
 *
 * ## This is a type-only module
 *
 * It declares interfaces and type aliases and nothing else: no constant, no
 * function, no class, no side effect. `verbatimModuleSyntax` is on and every
 * import below is `import type`, so the emitted JavaScript is empty and
 * `package.json`'s `sideEffects: false` stays true through this file — a
 * consumer that imports one interface from the package's barrel pays for one
 * interface. The vocabularies these shapes are built from live in
 * `./schema/**`, where they are validated; nothing here re-derives a value that
 * `./schema/readiness.ts` already computes.
 */

import type {
  CodeGraph,
  CodeQueries,
  LoadedProject,
  ProjectSummary,
  RouteMap,
} from '@debuggen/code-analysis';
import type { DebuggenError, Logger } from '@debuggen/shared';

import type { BackupStore } from './patch/backup-store.js';
import type {
  ModificationConflict,
  ModificationJournal,
  ModificationRecord,
} from './schema/modification.js';
import type { InstrumentationAction } from './schema/plan.js';
import type {
  AgentHookConfig,
  CaptureSignal,
  Readiness,
  ServerAgentSignals,
} from './schema/readiness.js';
import type { ProblemUnderstanding } from './schema/target.js';

// ---------------------------------------------------------------------------
// Observed readiness inputs
//
// The facts the service has *actually observed* about the two telemetry
// producers, handed to every adapter so that readiness is a statement about
// evidence rather than a guess. An adapter makes its readiness decision from
// these fields and from the code graph, and from nothing else: it may not probe
// a port, spawn a process or read a pid file (AAP §0.2.3).
// ---------------------------------------------------------------------------

/**
 * What the service knows about the page agent in the tab bound to this
 * session.
 *
 * Relayed from the `agent.ready` frame the MAIN-world agent emits when it
 * initialises and after every reload (AAP §0.4.2): the Chrome service worker
 * forwards it under the tab's connection, and
 * `apps/local-service/src/instrumentation/readiness.ts` keeps the latest one
 * per bound tab and puts it here.
 *
 * Absent from {@link ObservedReadinessInputs} — rather than present with false
 * flags — when no `agent.ready` has arrived for the bound tab's current
 * document. The distinction matters to an adapter's wording: "no page agent has
 * reported yet" and "a page agent reported that React was not detected" call
 * for different hints, and only the first is fixed by opening the app.
 */
export interface ObservedBrowserAgent {
  /**
   * The random per-document id the agent generates, as carried on every event
   * it produces.
   *
   * Present whenever the frame carried one. An adapter uses it only to
   * correlate a log line with the producer it is talking about; it is never
   * parsed for meaning.
   */
  readonly producerId?: string | undefined;

  /**
   * The document the report is about, which is what makes the report
   * falsifiable across a reload.
   *
   * The service compares it with the tab's current document before trusting a
   * stale report, so an adapter may take a present value at face value.
   */
  readonly documentId?: string | undefined;

  /**
   * The page's URL as the agent saw it, query-redacted by the time it reaches
   * an adapter (AAP §0.5.2).
   *
   * Useful in a hint ("the page at ‹url› has no React on it"); never used to
   * decide which project a session belongs to — that is
   * {@link InstrumentationContext.projectRoot}, which the service resolved from
   * the workspace, not from a page.
   */
  readonly url?: string | undefined;

  /**
   * Whether the React DevTools hook existed **before** the page's React
   * loaded.
   *
   * The one fact that decides whether render and state signals can be collected
   * at all: the fiber hook has to be installed at `document_start` for React to
   * attach to it, so a page that was already open when the extension was
   * installed reports `false` and needs one reload (AAP §0.5.5). An adapter
   * that claims a React signal reports `'unavailable'` with a reload hint in
   * that case rather than arming a hook that would observe nothing.
   */
  readonly installedBeforeReact: boolean;

  /**
   * Whether the agent found React on the page at all.
   *
   * `false` is a legitimate answer about a legitimate page — a server-rendered
   * document, a page whose React has not mounted yet — and is a reason to
   * degrade a React signal, not to fail an install.
   */
  readonly reactDetected: boolean;

  /**
   * When the report was received, in epoch milliseconds.
   *
   * Readiness is a statement about a moment: a page can navigate away between a
   * check and a capture. Carried so an adapter can age a report out rather than
   * treat a stale observation as current, and so a {@link Readiness} row built
   * from it can be reproduced in a test with an injected clock.
   */
  readonly observedAt: number;
}

/**
 * What the service knows about the dev-server preload for this project.
 *
 * Derived from the `server-agent` connection the preload opens when it is
 * attached (AAP §0.4.2): the preload announces itself with its project root,
 * and the service records whether that connection is currently up.
 *
 * Absent from {@link ObservedReadinessInputs} when no preload has ever
 * connected for the project — which is the normal state of a dev server the
 * developer started themselves. Every server-tier signal (incoming requests,
 * route handlers, outgoing fetches, database queries, patched function spans)
 * depends on it, so the adapters that claim those signals turn this field into
 * an `'unavailable'` row whose hint carries the exact relaunch command,
 * composed from {@link InstrumentationContext.projectRoot}.
 */
export interface ObservedServerAgent {
  /**
   * Whether the preload's connection is up **now**.
   *
   * `false` for a preload that connected earlier and has since gone — a dev
   * server that was restarted without the preload, for instance — which is why
   * this is a boolean rather than the mere presence of this object.
   */
  readonly connected: boolean;

  /**
   * The project root the preload announced, absolute POSIX.
   *
   * An adapter compares it with {@link InstrumentationContext.projectRoot} and
   * treats a mismatch as "no preload for this project": a preload attached to a
   * sibling workspace package would otherwise be read as readiness for a
   * project whose spans it will never produce.
   */
  readonly projectRoot: string;

  /**
   * When the preload was last heard from, in epoch milliseconds.
   *
   * Present once a heartbeat or any frame has been received. Absent for a
   * connection that has not spoken yet, which is a different statement from a
   * connection that has gone quiet — and the reason this is optional rather
   * than zero.
   */
  readonly lastHeartbeatAt?: number | undefined;
}

/**
 * The observed state of both telemetry producers, as the service saw it.
 *
 * Handed to every adapter on the {@link InstrumentationContext}, and the **only
 * source** an adapter may use to decide whether a signal it claims can be
 * collected here. Both members are optional because "nothing has reported yet"
 * is the honest answer at the start of a session and must be representable
 * without inventing a false report.
 *
 * Aggregating these rows into the session's "Ready to capture" state is the
 * service's job (`apps/local-service/src/instrumentation/readiness.ts`), which
 * also adds the preconditions no adapter can see — a binding for the tab, a
 * plan version to install — and is why `./schema/readiness.ts`'s
 * `buildReadiness` derives a report's own `ready` flag but never combines two.
 */
export interface ObservedReadinessInputs {
  /** The page agent's latest report for the bound tab, when there is one. */
  readonly browserAgent?: ObservedBrowserAgent | undefined;

  /** The dev-server preload's connection for this project, when there is one. */
  readonly serverAgent?: ObservedServerAgent | undefined;
}

// ---------------------------------------------------------------------------
// The injection seam
//
// One object, assembled by `apps/local-service/src/instrumentation/service.ts`
// and passed to every adapter method. It is deliberately a structural SUPERSET
// of the two contexts `patch/**` declares — `ConflictDetectionContext` in
// `./patch/conflict.ts` and `PatchContext` in `./patch/patcher.ts` — so an
// adapter passes its own context straight through to the patch layer instead
// of assembling a second object. Those modules sit below this one and may not
// import it, which is why the relationship is structural rather than an
// `extends` clause: `projectRoot`, `backups`, `journal`, `logger`, `now` and
// `signal` carry the same meanings in all three. `canonicalProjectRoot` is the
// one member with no counterpart in either: the patch layer takes it as
// `PatcherOptions.canonicalRoot`, a construction option of the patcher rather
// than a member of a context, and a patcher given one hands the conflict
// detector that canonical path as its `projectRoot`. An adapter that builds a
// patcher therefore forwards it by name.
// ---------------------------------------------------------------------------

/**
 * Everything an adapter is allowed to know, and the only way it learns any of
 * it.
 *
 * Built fresh per session and per plan version by
 * `apps/local-service/src/instrumentation/service.ts`, and handed to
 * {@link InstrumentationAdapter.canHandle},
 * {@link InstrumentationAdapter.createPlan},
 * {@link InstrumentationAdapter.install},
 * {@link InstrumentationAdapter.remove} and
 * {@link InstrumentationAdapter.readiness} alike — one shape for all five, so
 * that an adapter has the same picture of the world whichever question it is
 * being asked.
 *
 * Every member is `readonly`, and an adapter treats the objects behind them as
 * borrowed: the code graph and its queries are shared by every adapter and by
 * the pipeline's investigation stage, so mutating one would corrupt another
 * caller's view of the project.
 */
export interface InstrumentationContext {
  /**
   * The session this work belongs to: the opaque `ses_`-prefixed id from
   * `@debuggen/shared`.
   *
   * Every {@link ModificationRecord} an adapter journals carries it, the backup
   * directory is scoped by it, and {@link BackupStore.sessionId} must equal
   * it — `./patch/conflict.ts` refuses a store belonging to another session
   * outright, because such a store would compose backup paths in the wrong
   * directory and report an intact original as missing.
   *
   * A plain string, not branded and not pattern-pinned: the id vocabulary
   * belongs to `@debuggen/shared`, and the session's existence is established
   * by the service against its store, which is the only check that can actually
   * establish it.
   */
  readonly sessionId: string;

  /**
   * The absolute POSIX path of the developer's project.
   *
   * The root every file path is resolved and contained inside — an adapter
   * never composes a path from anything else, and the patch layer independently
   * refuses a path that escapes it — and the value from which a
   * developer-facing relaunch command is composed
   * ({@link UnavailableSignal.hint}). Never read from the environment or
   * inferred from a page's URL.
   *
   * It stays the root **as the session records it**, links and all: an adapter
   * compares it with a preload's announced root
   * ({@link ObservedServerAgent.projectRoot}) and composes relaunch hints from
   * it, and both are about the spelling the developer and their dev server
   * use. Where files are actually resolved and written is
   * {@link InstrumentationContext.canonicalProjectRoot} when the service holds
   * one.
   */
  readonly projectRoot: string;

  /**
   * The canonical path {@link InstrumentationContext.projectRoot} was admitted
   * under — absolute POSIX, every symbolic link resolved — supplied by the
   * service when it holds one.
   *
   * The patch layer resolves, pins, reads and writes every patched file inside
   * this path rather than inside `projectRoot`, so a `projectRoot` that is a
   * link retargeted after admission cannot redirect a patch; and it refuses a
   * patch (`PATH_OUTSIDE_PROJECT`, `details.reason: 'project-root-moved'`) once
   * the path is no longer its own canonical form, because a directory on the
   * way to it was replaced by a link since admission. An adapter that patches
   * hands it to `./patch/patcher.ts` as `PatcherOptions.canonicalRoot` and uses
   * it for nothing else: preload matching and relaunch hints stay on
   * `projectRoot`.
   *
   * Absent when the service has no admitted canonical path for the root — a
   * suite's temporary directory, for one — in which case the patch layer
   * resolves `projectRoot` afresh on every attempt.
   */
  readonly canonicalProjectRoot?: string | undefined;

  /**
   * Which revision of this session's plan is being installed or removed,
   * counting from 1.
   *
   * A follow-up that needs more evidence produces version *n + 1* as the
   * previous plan plus additive actions, never removing an installed one
   * (AAP §0.4.2), and this value is what lets the installer apply only the
   * delta and what every record of this round is stamped with. It is therefore
   * also the scope of the "already applied" question in
   * {@link InstrumentationAdapter.install}: an adapter asked to install an
   * action whose record already exists at this version has nothing to do.
   */
  readonly planVersion: number;

  /**
   * The product's own state directory, absolute POSIX — `~/.debuggen` by
   * default, resolved by the service.
   *
   * Supplied rather than read from `$DEBUGGEN_HOME` here for the reason this
   * whole object exists: session data and file backups live **outside** the
   * developer's project so a session never pollutes their version-control
   * status (AAP §0.2.3), and one process deciding that location while another
   * re-derives it is how a backup becomes unfindable. Adapters normally have no
   * use for it — {@link InstrumentationContext.backups} already holds the
   * resolved backup tree — and it is present for the one that needs to name a
   * path in a log line or a hint.
   */
  readonly debuggenHome: string;

  /**
   * Where to log.
   *
   * Paths, digests, ids, counts, signal names and enumerated reasons only:
   * never a byte of a developer's file content, never a captured value, never a
   * credential (AAP §0.5.2). An adapter that wants its own prefix calls
   * `logger.child({ adapter: this.id })` rather than formatting one into every
   * message.
   *
   * Required here — an adapter always has somewhere to log, and the service
   * passes `noopLogger` from `@debuggen/shared` when it wants silence — while
   * the patch layer's contexts accept it optionally, which a required member
   * satisfies.
   */
  readonly logger: Logger;

  /**
   * The indexed code graph of the project: files, symbols, components, event
   * handlers, API call sites, API routes, server functions and database calls,
   * with the edges between them.
   *
   * The substrate for every capability decision an adapter makes. It is how
   * {@link InstrumentationAdapter.canHandle} answers "is there anything of my
   * kind in this project?" and how {@link InstrumentationAdapter.createPlan}
   * **selects** targets, which is the mechanism AAP §0.5.4 requires: a target
   * exists because the graph has a declaration for it, never because a name was
   * recognised.
   */
  readonly graph: CodeGraph;

  /**
   * The bounded, read-only query surface over {@link graph}, as returned by
   * `createCodeQueries` in `@debuggen/code-analysis`.
   *
   * Preferred over walking the graph directly: `findByName`, `findSymbol`,
   * `hasSymbol`, `whoCalls`, `routeForUrl`, `handlersFor`,
   * `componentsRendering`, `pathBetween` and `excerpt` are each bounded by that
   * package's own limits, so an adapter cannot accidentally turn a capability
   * probe into a repository traversal. `hasSymbol` in particular is the
   * existence check a `patch`-mode action must pass before anything is written.
   */
  readonly queries: CodeQueries;

  /**
   * The project's URL ↔ route-file mapping.
   *
   * What an adapter that claims a server-tier signal uses to turn a request
   * path into the handler file it would instrument, and the source of the
   * `route-map` source-resolution route. Carried separately from
   * {@link queries} because the service builds it once per index and shares it
   * with the source resolver.
   */
  readonly routeMap: RouteMap;

  /**
   * The project's summary: framework, router style, TypeScript configuration,
   * package manager, database access style, entry points, notable directories
   * and dependency references.
   *
   * The cheap facts a `canHandle` probe is built from — a database adapter asks
   * which driver the summary reports, a framework adapter asks which router
   * style it found — without opening a single file. `packageManager` is also
   * what makes a relaunch hint correct for *this* project instead of assuming
   * one.
   */
  readonly projectSummary: ProjectSummary;

  /**
   * The loaded ts-morph project, present **only** when AST work is possible.
   *
   * Absent when the target has no usable TypeScript configuration, or when the
   * service deliberately withheld it because no `patch`-mode action is in play:
   * loading a project is the most expensive thing this package does, and a
   * runtime-only plan must not pay for it. An adapter that needs it therefore
   * checks first and reports `'unavailable'` with a reason rather than
   * asserting — an absent project is a legitimate state of a legitimate
   * project, not a programming error.
   */
  readonly loaded?: LoadedProject | undefined;

  /**
   * The persistence port for the modification journal.
   *
   * The only way a record becomes durable, and the reason this package never
   * opens a database: `apps/local-service/src/store/modifications-repo.ts`
   * implements it over `node:sqlite`, and the suites implement it in memory. An
   * adapter that patches a file does so through `./patch/patcher.ts`, which
   * appends the record *before* the write and marks it applied *after* the
   * rename — so an adapter hands this port on rather than writing to it
   * directly.
   */
  readonly journal: ModificationJournal;

  /**
   * The content-addressed backup store for this session, rooted at
   * `<debuggenHome>/backups/<sessionId>`.
   *
   * Holds the original bytes while an edit stands over them, which is what
   * makes an edit reversible (AAP §0.5.1). Its own `sessionId` must equal
   * {@link sessionId}; the patch layer refuses the mismatch rather than
   * guessing.
   */
  readonly backups: BackupStore;

  /**
   * The observed state of the two telemetry producers.
   *
   * The sole basis for a readiness decision. See
   * {@link ObservedReadinessInputs}.
   */
  readonly readiness: ObservedReadinessInputs;

  /**
   * The clock, in epoch milliseconds. Defaults, where an adapter lets it, to
   * `nowEpochMs()` from `@debuggen/shared`.
   *
   * Injected so a suite can assert an exact {@link Readiness.checkedAt} or
   * {@link ModificationConflict.detectedAt} without freezing time globally —
   * the same seam `./schema/readiness.ts` and `./patch/conflict.ts` open. An
   * adapter that needs a timestamp reads it from here rather than calling
   * `Date.now()`, which is the difference between a reproducible report and one
   * that can only be asserted approximately.
   *
   * Spelled `| undefined` so the service may pass the key explicitly whether or
   * not it has a clock to inject. Forwarding it to a constructor whose own
   * `now` is declared without `| undefined` — `buildReadiness` in
   * `./schema/readiness.ts` is the one an adapter meets — means spreading the
   * key rather than assigning it, which `exactOptionalPropertyTypes` requires;
   * the example on {@link InstrumentationAdapter} shows the form.
   */
  readonly now?: (() => number) | undefined;

  /**
   * Cancellation, honoured **between** steps and never inside a write.
   *
   * The installer aborts a failing install between actions, and a session that
   * ends while a plan is being installed aborts the rest of it. An adapter
   * checks the signal at its own step boundaries — before starting an action,
   * between two files — and passes it down to `./patch/patcher.ts`, which
   * checks it at stage boundaries only: honouring it mid-rename would be the
   * one interruption capable of leaving a half-known state on disk
   * (AAP §0.5.1).
   */
  readonly signal?: AbortSignal | undefined;
}

// ---------------------------------------------------------------------------
// What an install and a removal report back
//
// Four shapes: the graceful-degradation channel of AAP §0.5.5, the fatal
// channel that keeps a follow-up's delta atomic (AAP §0.4.2), and the two
// results they travel in. `applied`, `runtimeHooks` and `unavailable` are
// exactly the three fields AAP §0.2.3 requires of an install result, and
// exactly what `instrumentation.ready` carries to both user interfaces;
// `failure` never reaches that message, because an install carrying one is
// unwound and reported as `instrumentation.failed` instead.
// ---------------------------------------------------------------------------

/**
 * One signal that could not be enabled, and what the developer can do about
 * it.
 *
 * **Both strings are rendered verbatim** into AAP §0.5.5's sentence — "Could
 * not enable ‹signal›: ‹reason›. Continuing with: ‹enabled list›." — by
 * `apps/local-service/src/instrumentation/service.ts`, and reach the developer
 * through `instrumentation.ready` in the editor's modification and progress
 * views and in the DevTools panel's session summary. Write them as the
 * developer will read them:
 *
 * - `reason` states **what was observed**, as a fragment that reads after the
 *   colon: "no dev-server preload is attached for this project", "the React
 *   hook was installed after React loaded". Not a sentence about the product,
 *   never an exception message and never a stack trace.
 * - `hint` states **one concrete action**. For a missing dev-server preload
 *   that is the exact relaunch command, composed by the adapter from
 *   {@link InstrumentationContext.projectRoot} and the package manager
 *   {@link InstrumentationContext.projectSummary} reports — never a path
 *   written into this repository, which is the AAP §0.5.4 line, and never a
 *   command for a project other than the one being debugged.
 *
 * Both are single-line: they are rendered into one-line rows and into log
 * lines, and `./schema/readiness.ts` refuses a multi-line `reason` or `hint` on
 * the {@link Readiness} row built from the same words.
 */
export interface UnavailableSignal {
  /**
   * Which signal is missing.
   *
   * A {@link CaptureSignal} wherever the gap is one of the product's twelve
   * known signals, which is what lets the service cross-reference it with the
   * plan and with the readiness rows. Widened to any string for the one case
   * the closed vocabulary cannot express: a third-party adapter reporting a
   * signal of its own, which must still reach the developer rather than being
   * dropped for not being in a union this package controls.
   *
   * The widening is written `(string & {})` rather than `string` so the twelve
   * known names survive in completion and in this declaration, instead of being
   * absorbed by the wider constituent — `CaptureSignal | string` collapses to
   * `string`, which is both a lie about the intent and a lint failure
   * (`no-redundant-type-constituents`). Any string is still accepted, which is
   * the whole point.
   */
  readonly signal: CaptureSignal | (string & {});

  /** What was observed. See this interface's note on wording. */
  readonly reason: string;

  /** The one thing the developer can do about it. */
  readonly hint: string;
}

/**
 * An action this adapter accepted for install and could not complete — the
 * payload of {@link InstallResult.failure}, the contract's fatal channel.
 *
 * The counterpart of {@link UnavailableSignal}, and the difference is whether
 * the capture can proceed without it. A gap the capture survives — no preload
 * attached, a silent preload, a hook installed after React — is an
 * {@link UnavailableSignal} and the install still succeeds. A patch the target
 * refused or that failed after the feasibility gate admitted it, a write-path
 * failure, and a cancellation part-way through the sequence are this: the
 * install as planned did not happen, so `./installer.ts` reverse-restores every
 * record the current `installPlan` call applied — the earlier adapters', this
 * adapter's {@link InstallResult.applied}, and {@link record} — and returns
 * `INSTRUMENTATION_INSTALL_FAILED`. A failed follow-up therefore leaves the
 * session at its previous plan version, byte for byte (AAP §0.4.2).
 *
 * Identifiers, a project-relative path and a coded error — never a byte of
 * file content — except {@link conflict}, which holds diffs and is therefore
 * never copied into an error's details or a log line (AAP §0.5.2).
 *
 * @example
 * A patch-mode adapter forwarding the batch `./patch/patcher.ts` stopped on:
 *
 * ```ts
 * const batch = await patcher.patchActions(ordered);
 * const applied = batch.applied.map((outcome) => outcome.record);
 *
 * if (batch.failure !== undefined) {
 *   const { error, actionId, file, symbol, record, conflict } = batch.failure;
 *
 *   return {
 *     adapterId: this.id,
 *     applied,
 *     runtimeHooks: [],
 *     unavailable: [],
 *     failure: { error, signal: 'functions', actionId, file, symbol, record, conflict },
 *   };
 * }
 * ```
 */
export interface InstallFailure {
  /**
   * Why the action could not be completed, coded.
   *
   * Its `message` and `hint` are written for the developer — an unsupported
   * declaration, a baseline conflict naming where the original is kept, a
   * cancelled install — and the installer quotes both rather than paraphrasing
   * them. It becomes the `cause` of the installer's own error.
   */
  readonly error: DebuggenError;

  /**
   * The signal the failed action would have supplied, named as
   * {@link UnavailableSignal.signal} names one and widened for the same reason.
   */
  readonly signal: CaptureSignal | (string & {});

  /** The failed action's id, when the failure is attributable to one action. */
  readonly actionId?: string | undefined;

  /** The failed target's file, project-relative POSIX, when there is one. */
  readonly file?: string | undefined;

  /** The symbol the failed action addressed, when there is one. */
  readonly symbol?: string | undefined;

  /**
   * The record journaled for the failed attempt, in its `pending` or `failed`
   * state, when the sequence got as far as journaling one.
   *
   * **Never also listed in {@link InstallResult.applied}.** The installer adds
   * it to the rollback set last, so it is the first record restored, and
   * `restoreModification` in `./cleanup.ts` settles it by the reconciliation
   * table of AAP §0.5.1: a file that still holds the original closes the record
   * without a write, a file that holds the patch is restored from the backup,
   * and anything else is a conflict the developer is shown. Omitting it would
   * leave an open journal row that blocks the next patch of that file and a
   * file that may hold bytes nobody restores.
   */
  readonly record?: ModificationRecord | undefined;

  /**
   * The conflict report, when the failure was a baseline conflict.
   *
   * Carried beside the error rather than inside its details because a report
   * holds three-way diffs — file content — and an error's details may be
   * logged and persisted. The installer records only that one exists.
   */
  readonly conflict?: ModificationConflict | undefined;
}

/**
 * What one adapter did when asked to install a set of actions.
 *
 * Returned for every call that reached an answer, **including a call that
 * enabled nothing and a call that failed part-way**, and the two are told apart
 * by {@link failure}:
 *
 * - **Without `failure`, the install is what it says.** A gap is data (see
 *   {@link unavailable}), and only `./installer.ts` — the one party that can
 *   see every adapter's answer — turns "nothing at all could be enabled" into
 *   the `instrumentation.failed` of AAP §0.5.5.
 * - **With `failure`, the install did not happen as planned.** {@link applied}
 *   lists the records that completed before it, and every other member is
 *   ignored; see {@link failure} for what the installer does next.
 *
 * An adapter rejects its promise only for a condition that makes the question
 * unanswerable, such as a journal that could not be written.
 *
 * The three array members are owned by the caller once returned: the installer
 * concatenates them across adapters, so an adapter must not retain and later
 * mutate an array it has handed over.
 */
export interface InstallResult {
  /**
   * The id of the adapter reporting, as registered.
   *
   * Carried on the result rather than inferred from the call site, so an
   * aggregated report, a log line and a stored session record all attribute a
   * gap or a modification to the same adapter without the installer having to
   * remember which promise it was holding. See
   * {@link InstrumentationAdapter.id} for why it is a string.
   */
  readonly adapterId: string;

  /**
   * The modification records this install produced, in the order they were
   * applied.
   *
   * Empty for a `runtime`-mode adapter, which is the common case: a record
   * exists only where bytes were written to a developer's file. Each record
   * carries both content hashes, the backup path and the unified diff, and is
   * already journaled — the record is appended before the write and marked
   * `applied` after the rename (AAP §0.5.1), so a record here has been
   * persisted, not merely constructed.
   *
   * The order is the order cleanup must reverse, and
   * `apps/local-service/src/instrumentation/watcher.ts` watches exactly these
   * files for a developer's own edits.
   *
   * Beside a {@link failure}, the records that completed before it — this
   * adapter's share of the rollback set — and never the failed attempt's own
   * record, which travels as {@link InstallFailure.record}.
   */
  readonly applied: ModificationRecord[];

  /**
   * The runtime hooks this adapter armed, named for a developer to read.
   *
   * The evidence behind the editor's "Preparing instrumentation" checklist
   * (AAP §0.1.2's Step 8 display) and behind `instrumentation.ready`'s
   * `runtimeHooks`. A hook is listed here when the adapter has actually
   * contributed the configuration that enables it — not when it merely intends
   * to — so a developer told a hook is on can rely on it.
   *
   * Strings rather than a closed union because a hook is a *description* at the
   * granularity the adapter owns, which may be finer than a
   * {@link CaptureSignal}: the machine-readable statement of what was enabled
   * is {@link agentHooks} and {@link serverSignals}, and this list is what the
   * product says about it.
   */
  readonly runtimeHooks: string[];

  /**
   * The signals this adapter claims but could not enable here.
   *
   * The graceful-degradation channel. An empty array means everything the
   * adapter claimed for these actions is on; a non-empty one means the capture
   * will be narrower and says so in the developer's own terms. It is never a
   * substitute for a rejected promise and never carries a condition the
   * developer can do nothing about.
   */
  readonly unavailable: UnavailableSignal[];

  /**
   * This adapter's contribution to the page agent's hook configuration.
   *
   * A `Partial` because an adapter speaks only for the hooks it claims: the
   * installer merges the contributions of every adapter with the deterministic
   * derivation in `./schema/readiness.ts` (`deriveAgentHookConfig`), which owns
   * the policy — including the rule that any enabled browser hook forces
   * `interactions` on, without which requests leave the page untraced and the
   * browser↔server correlation breaks silently.
   *
   * An adapter therefore reports what it enabled and does **not** re-derive
   * that policy here. Omitted, or `undefined`, when the adapter arms nothing in
   * the page; both mean "no contribution".
   */
  readonly agentHooks?: Partial<AgentHookConfig> | undefined;

  /**
   * This adapter's contribution to the dev-server preload's signal set.
   *
   * The counterpart of {@link agentHooks}, merged the same way by the same
   * module (`deriveServerAgentSignals`), which also owns the deterministic
   * ordering of the `functions` list so two identical plans produce
   * byte-identical frames. Omitted when the adapter arms nothing in the server
   * process.
   */
  readonly serverSignals?: Partial<ServerAgentSignals> | undefined;

  /**
   * The fatal channel: present when an action accepted for install could not
   * be completed.
   *
   * That covers a patch the target refused or that failed after the
   * feasibility gate admitted it, a failure anywhere on the write path, and a
   * cancellation that stopped the sequence part-way. {@link applied} then lists
   * the records that completed before it, which is this adapter's share of the
   * rollback set, and `./installer.ts` reverse-restores every record the
   * current `installPlan` call applied — earlier adapters', {@link applied} and
   * {@link InstallFailure.record}, latest first — and returns
   * `INSTRUMENTATION_INSTALL_FAILED`. Every other member of a result carrying
   * a failure is ignored: nothing it armed or contributed is aggregated,
   * because the install it describes is being unwound.
   *
   * Omitted, or `undefined`, for an install that ran as planned — which is
   * what keeps this member additive for an adapter written before it existed.
   * A gap the capture can proceed without is never reported here; it belongs
   * in {@link unavailable}, which never fails an install (AAP §0.5.5).
   */
  readonly failure?: InstallFailure | undefined;
}

/**
 * What one adapter did when asked to remove its instrumentation.
 *
 * Like {@link InstallResult}, a **successful** result even when it reports a
 * conflict: a file a developer edited while it was instrumented is left exactly
 * as they left it, its original kept in the backup tree, and the divergence
 * reported — never overwritten (AAP §0.5.1). `./cleanup.ts` aggregates these
 * into the session's `cleanup.status` (`clean`, `partial` or `conflict`) and
 * the `cleanup.completed` message.
 */
export interface RemoveResult {
  /** The id of the adapter reporting. See {@link InstallResult.adapterId}. */
  readonly adapterId: string;

  /**
   * The records whose files were restored, each already moved to `reverted` in
   * the journal.
   *
   * Restoration is verified before a record is closed: the file must hash to
   * the record's `instrumentedHash` before the backup is written over it, and
   * the restored content must hash to `originalHash` before the backup is
   * deleted. A record here has passed both checks, which is what makes "the
   * file is byte-identical to its pre-session content" a claim the end-to-end
   * suite can assert.
   */
  readonly restored: ModificationRecord[];

  /**
   * The records that could not be restored, and why.
   *
   * Each report names the expected and actual digests, the retained backup path
   * and a developer-facing message, and carries the three-way diff view where
   * there is one to show. A conflict keeps its backup until the developer
   * resolves it, and is re-reported on every reconnect and every service start
   * until then — an omission would be a cleanup that reported success over a
   * file it had abandoned.
   */
  readonly conflicts: ModificationConflict[];

  /**
   * The runtime hooks this adapter disabled, named as
   * {@link InstallResult.runtimeHooks} names them.
   *
   * Disabled, not idled (AAP §0.5.1): listeners detached, patched globals
   * restored, fiber handlers unsubscribed, instrumentations unwrapped. Listing
   * them is what lets the two user interfaces state what is no longer running,
   * and what lets `tests/e2e/cleanup.spec.ts` assert that a session leaves
   * nothing observing the developer's application.
   */
  readonly runtimeHooksDisabled: string[];
}

// ---------------------------------------------------------------------------
// The removal request
//
// AAP §0.1.2's example signature is `remove(session, context)`. An untyped
// `session` argument cannot say which records are in scope or why they are
// being removed, and both change what an implementation must do — so the
// argument is this named request, which satisfies that signature with a shape
// an implementer can act on.
// ---------------------------------------------------------------------------

/**
 * Why instrumentation is being removed.
 *
 * The three occasions AAP §0.5.1 names, and they differ in what an adapter
 * should expect rather than in what it should do:
 *
 * - `'session-end'` — the developer ended the session, or the editor
 *   deactivated. Every record of the session is in scope and the runtime hooks
 *   are returned to dormant.
 * - `'rollback'` — an install failed part-way through and the records applied
 *   so far are being reverse-restored, so that a failed follow-up leaves the
 *   session at its previous plan version. Scoped by
 *   {@link AdapterRemoveRequest.records}, and the files named there were
 *   written moments ago.
 * - `'reconcile'` — the service is starting up and is acting on records left
 *   open by a crashed or abandoned session, **whatever status that session
 *   ended in**. The runtime hooks of that session do not exist any more, so
 *   there is nothing to detach; a file that no longer hashes to its record's
 *   `instrumentedHash` is the expected finding here, not an anomaly.
 */
export type AdapterRemoveReason = 'session-end' | 'rollback' | 'reconcile';

/**
 * The request {@link InstrumentationAdapter.remove} is called with.
 *
 * This is the typed form of AAP §0.1.2's `remove(session, …)` argument: a
 * session id, optionally the plan version and the exact records in scope, and
 * the occasion. Passing the records rather than making the adapter look them up
 * is deliberate — the journal is the service's, cleanup already holds the chain
 * it intends to unwind, and an adapter that re-queried could disagree with the
 * order cleanup is walking, which is precisely the order that has to be
 * strictly reversed for a chained file to come back (AAP §0.4.2).
 */
export interface AdapterRemoveRequest {
  /** The session whose instrumentation is being removed. */
  readonly sessionId: string;

  /**
   * The plan version in scope, when the removal is scoped to one.
   *
   * Present for a `'rollback'` of one follow-up's delta; absent for a
   * `'session-end'` that removes every version, and normally absent for a
   * `'reconcile'`, where the records themselves define the scope.
   */
  readonly planVersion?: number | undefined;

  /**
   * The records to act on, in the order they were applied.
   *
   * An adapter unwinds them **in reverse**, verifying at each step that the
   * file hashes to that record's `instrumentedHash` before writing that
   * record's backup — which is how a file instrumented by two plan versions
   * returns to its original bytes rather than to an intermediate state.
   *
   * Absent means "every record you journaled for this session", which the
   * adapter obtains through {@link InstrumentationContext.journal}. A
   * runtime-mode adapter ignores the member entirely: it has no records, and
   * its work is to detach.
   */
  readonly records?: readonly ModificationRecord[] | undefined;

  /** The occasion. See {@link AdapterRemoveReason}. */
  readonly reason: AdapterRemoveReason;
}

// ---------------------------------------------------------------------------
// The contract itself
// ---------------------------------------------------------------------------

/**
 * What every instrumentation adapter implements.
 *
 * Five questions and one identity, and the division between them is the
 * product's extension point (AAP §0.4.2): the orchestrator knows this
 * interface and the registry, and nothing else about how a signal is
 * collected. A new tier, framework or driver is therefore a new implementation
 * of this interface plus a `registerAdapter()` call — the planner, the
 * installer, the readiness gate and cleanup are unchanged.
 *
 * ## The obligations an implementation takes on
 *
 * - **Nothing outside the context.** No environment variable, no filesystem
 *   access except through the ports on {@link InstrumentationContext}, no
 *   network call, no process spawn, no global mutation. An adapter is a pure
 *   function of what it was handed.
 * - **No knowledge of any particular project.** Targets are *selected from the
 *   code graph*; a name, route or component that appears as a literal in an
 *   adapter is the forbidden pattern of AAP §0.5.4, and
 *   `scripts/check-no-hardcoding.mjs` reads this package with ts-morph to say
 *   so.
 * - **Gaps are reported, not thrown.** See {@link InstallResult.unavailable}.
 * - **Failed actions are reported, not thrown — and not stepped over.** An
 *   action accepted for install that cannot be completed stops this adapter's
 *   install at that action and is returned in {@link InstallResult.failure}
 *   beside the records that did complete, so `./installer.ts` can
 *   reverse-restore all of them. Continuing past it would turn a failed
 *   follow-up into a partial one the session cannot be returned from.
 * - **Idempotence.** {@link install} and {@link remove} may be called again
 *   after a crash, a reconnect or a retry, and must converge rather than
 *   duplicate.
 *
 * @example
 * A runtime-mode adapter that claims one signal, reports the one gap it can
 * observe, and has nothing to restore. Every method answers from the context
 * it was handed:
 *
 * ```ts
 * const reactSignals = ['react'] as const satisfies readonly CaptureSignal[];
 *
 * class ExampleRenderAdapter implements InstrumentationAdapter {
 *   readonly id = 'example-render';
 *
 *   canHandle(context: InstrumentationContext): boolean {
 *     return context.projectSummary.counts.components > 0;
 *   }
 *
 *   createPlan(
 *     context: InstrumentationContext,
 *     understanding: ProblemUnderstanding,
 *   ): Promise<InstrumentationAction[]> {
 *     return Promise.resolve(
 *       understanding.signalsNeeded.includes('react')
 *         ? selectRenderTargets(context.queries, understanding)
 *         : [],
 *     );
 *   }
 *
 *   install(
 *     actions: readonly InstrumentationAction[],
 *     context: InstrumentationContext,
 *   ): Promise<InstallResult> {
 *     const hook = context.readiness.browserAgent?.installedBeforeReact === true;
 *
 *     return Promise.resolve({
 *       adapterId: this.id,
 *       applied: [],
 *       runtimeHooks: hook && actions.length > 0 ? ['React renders'] : [],
 *       unavailable: hook
 *         ? []
 *         : [{ signal: reactSignals[0], reason: '…', hint: '…' }],
 *       agentHooks: hook ? { react: true, componentTree: true } : {},
 *     });
 *   }
 *
 *   remove(
 *     session: AdapterRemoveRequest,
 *     context: InstrumentationContext,
 *   ): Promise<RemoveResult> {
 *     context.logger.debug('detaching render hooks', { reason: session.reason });
 *
 *     return Promise.resolve({
 *       adapterId: this.id,
 *       restored: [],
 *       conflicts: [],
 *       runtimeHooksDisabled: ['React renders'],
 *     });
 *   }
 *
 *   readiness(context: InstrumentationContext): Promise<Readiness> {
 *     const agent = context.readiness.browserAgent;
 *
 *     return Promise.resolve(
 *       buildReadiness({
 *         adapter: this.id,
 *         signals: [
 *           {
 *             signal: reactSignals[0],
 *             status: agent?.installedBeforeReact === true ? 'available' : 'unavailable',
 *           },
 *         ],
 *         // `BuildReadinessInput.now` is declared without `| undefined`, so
 *         // under `exactOptionalPropertyTypes` the key is spread, not passed.
 *         ...(context.now === undefined ? {} : { now: context.now }),
 *       }),
 *     );
 *   }
 * }
 * ```
 */
export interface InstrumentationAdapter {
  /**
   * This adapter's identity, as it is registered.
   *
   * The value that {@link InstallResult.adapterId}, {@link Readiness.adapter}
   * and every action's `adapter` field carry, and the key `./installer.ts`
   * looks an adapter back up by after a plan has been normalised. It must be a
   * single-line, non-blank string and must be stable across versions: a
   * modification record or a stored plan read back after an upgrade names the
   * adapter that produced it, and an id that moved would orphan it.
   *
   * **A `string`, not an enumeration.** AAP §0.1.2 writes the field as
   * `AdapterId | string`, and a `string` is what that union amounts to and the
   * only form this module can state: adapter identity belongs to
   * `./registry.ts`, which imports this file, so naming its ids here would
   * close a cycle — and a third-party adapter registered at runtime has an id
   * no union in this repository could contain. `./schema/plan.ts` and
   * `./schema/readiness.ts` type their own `adapter` fields as bounded strings
   * for exactly this reason, and the bounds are applied there, where the value
   * is validated.
   */
  readonly id: string;

  /**
   * Whether this adapter has anything to offer **this project**.
   *
   * A cheap, **synchronous**, graph-driven capability probe: it answers from
   * {@link InstrumentationContext.projectSummary},
   * {@link InstrumentationContext.graph} and
   * {@link InstrumentationContext.queries}, and from nothing else. It must not
   * touch the filesystem, open a socket, spawn a process or await anything —
   * the planner calls it once per candidate action type while a plan is being
   * normalised, and again while the capability catalog for the planning stage
   * is assembled, so its cost is paid many times per session while a developer
   * waits.
   *
   * It must also be free of side effects and stable within a session: two calls
   * with the same context give the same answer, because normalisation relies on
   * the resolution it returned not changing between the plan it validated and
   * the install it authorised.
   *
   * This is a question about *capability*, not about *readiness* or *intent*. A
   * database adapter answers `true` for a project whose graph contains database
   * call sites even when no dev-server preload is attached — that gap is
   * {@link readiness}'s to report and {@link InstallResult.unavailable}'s to
   * carry — and answers `false` for a project with no database access at all,
   * where it genuinely has nothing to contribute.
   *
   * @param context The session's context.
   * @returns `true` when this adapter claims work in this project.
   */
  canHandle(context: InstrumentationContext): boolean;

  /**
   * Proposes the actions this adapter would install for the question as it was
   * understood.
   *
   * Called by the planning stage while the plan's authoring form is being
   * assembled, and by the fallback path that builds a runtime-only default plan
   * from the adapters' own capabilities when a model's plan is rejected
   * (AAP §0.5.3). The proposal is advice: the actions returned are validated,
   * normalised and feasibility-checked before anything is installed, and an
   * action naming a file or symbol the graph does not have is rejected there.
   *
   * **Every target must be selected from the code graph**, using
   * `understanding`'s entities and search hints as seeds — a component
   * resolved through `queries.findByName`, a handler through
   * `queries.handlersFor`, a call site through `queries.whoCalls`. Selecting a
   * target because its name was recognised, rather than because the graph has a
   * declaration for it, is the AAP §0.5.4 failure this product exists to avoid.
   *
   * An adapter proposes only what it claims, proposes `patch`-mode actions only
   * for symbols that exist, and returns an empty array when the question needs
   * nothing of its kind — an empty proposal is an answer, not a failure.
   *
   * Asynchronous because a proposal may need a bounded excerpt or a reference
   * lookup that the query surface resolves lazily. It still performs no
   * installation and writes nothing: the model never applies instrumentation,
   * and neither does this method (AAP §0.5.3).
   *
   * @param context The session's context.
   * @param understanding The validated problem understanding of the pipeline's
   * first stage, whose `signalsNeeded` names the signals in the closed capture
   * vocabulary and whose `entities` are ordered most-relevant-first.
   * @returns The proposed actions, in the order they should be considered. Ids,
   * adapters and modes are supplied by normalisation, so a proposal may carry
   * the identity fields it already knows and leave the rest to the deterministic
   * step that owns them.
   */
  createPlan(
    context: InstrumentationContext,
    understanding: ProblemUnderstanding,
  ): Promise<InstrumentationAction[]>;

  /**
   * Installs the given actions and reports exactly what happened.
   *
   * Called by `./installer.ts` with the subset of a normalised plan's actions
   * that resolved to this adapter — runtime-mode adapters first, patch-mode
   * adapters second, so that a patch failure has strictly less to unwind and
   * the hooks are already listening when a patched file is picked up by the dev
   * server's hot reload (AAP §0.5.1).
   *
   * **Idempotent with respect to what is already applied.** An action whose
   * modification record already exists at
   * {@link InstrumentationContext.planVersion}, or whose runtime hook this
   * adapter has already contributed, is a no-op that is still reported: the
   * result describes the *state*, not the delta, so the installer can aggregate
   * a retry and a first attempt identically. A follow-up's delta arrives as a
   * new plan version, and a record for a file this session already instrumented
   * is chained to the previous record rather than layered blindly — which is
   * what lets cleanup unwind the chain in strict reverse order (AAP §0.4.2).
   *
   * Bytes reach a developer's file through `./patch/patcher.ts` and nowhere
   * else: its hash → backup → journal → atomic-rename sequence is what makes
   * the edit reversible, and an adapter that wrote directly would produce an
   * unrecorded change. Between actions, and before starting one, the adapter
   * honours {@link InstrumentationContext.signal}.
   *
   * @param actions The actions this adapter must install. `readonly`: the array
   * belongs to the installer, which also hands it to the derivations in
   * `./schema/readiness.ts`, and neither the array nor an action may be
   * modified.
   * @param context The session's context.
   * @returns What was applied, which hooks were armed, which claimed signals
   * could not be enabled, and this adapter's contribution to the two producer
   * configurations — or, when an accepted action could not be completed, the
   * records applied before it with the reason in {@link InstallResult.failure},
   * which the installer unwinds. A signal that merely turned out to be
   * unavailable is a gap in {@link InstallResult.unavailable}, never a failure.
   * Rejects **only** where the outcome is unknowable — a journal that could not
   * be written — because a rejection carries no records to restore.
   */
  install(
    actions: readonly InstrumentationAction[],
    context: InstrumentationContext,
  ): Promise<InstallResult>;

  /**
   * Removes this adapter's instrumentation and reports what came back.
   *
   * Called on session end, on a failed install's rollback, and on the
   * service-start reconciliation that acts on records left open by a crashed or
   * abandoned session — whatever status that session ended in (AAP §0.5.1). The
   * named request says which of those it is; see {@link AdapterRemoveRequest},
   * which is the typed form of AAP §0.1.2's `remove(session, context)` argument.
   *
   * **Idempotent with respect to what is already reverted.** A record already
   * `reverted`, a hook already detached and a file already restored are all
   * no-ops, because this method runs again after a crash and on every service
   * start until nothing is left open. Restoration is gated on evidence at each
   * step: a file that no longer hashes to its record's `instrumentedHash` is
   * **left untouched**, its backup retained, and the divergence reported in
   * {@link RemoveResult.conflicts} — the tool does not overwrite a developer's
   * edit, and a conflict is a successful outcome of this call.
   *
   * Runtime hooks are disabled rather than idled: the page agent is returned to
   * dormant and the dev-server instrumentations are unwrapped, so that what
   * remains is inert and the application keeps serving.
   *
   * @param session Which session, which plan version and which records are in
   * scope, and why. Named `session` so that AAP §0.1.2's signature is satisfied
   * as written.
   * @param context The session's context.
   * @returns What was restored, what conflicted and which hooks were disabled.
   * Rejects only where the outcome is unknowable; a file that may not be
   * restored is a conflict, not a rejection.
   */
  remove(session: AdapterRemoveRequest, context: InstrumentationContext): Promise<RemoveResult>;

  /**
   * Reports, per signal this adapter claims, whether it can be collected here.
   *
   * The rows that gate the session's "Ready to capture" state and the
   * "Reproduce the issue now." prompt: the service aggregates every claiming
   * adapter's report in
   * `apps/local-service/src/instrumentation/readiness.ts`, adds the
   * preconditions no adapter can see — a bound tab, a plan version to install
   * — and only then tells the developer to reproduce their problem. A
   * `'degraded'` row does not hold a capture back; an `'unavailable'` one does.
   *
   * **Decided only from {@link InstrumentationContext.readiness} and the code
   * graph.** An adapter does not probe a port, retry a connection or spawn
   * anything to answer this: the service holds the actual evidence — the
   * relayed `agent.ready` for the bound tab's current document, the
   * `server-agent` connection for this project — and an adapter that went
   * looking for its own could contradict it and tell a developer a signal is
   * ready when the frames the product needs are not arriving.
   *
   * Build the report with `buildReadiness` from `./schema/readiness.ts` so that
   * the `ready` derivation is stated in one place, name this adapter in it, and
   * give every row that is not `'available'` the same developer-facing `reason`
   * and `hint` an {@link UnavailableSignal} would carry — they are read in the
   * same sentence, and a readiness row that stayed silent about its recovery
   * action would make the failure honest but useless.
   *
   * @param context The session's context.
   * @returns One report for this adapter: `ready`, its rows and the moment the
   * report was taken. An adapter that claims nothing in this project is ready
   * with no rows, which is a different statement from an adapter whose signals
   * are all unavailable.
   */
  readiness(context: InstrumentationContext): Promise<Readiness>;
}

// ---------------------------------------------------------------------------
// Built-in adapter capabilities — prose only, deliberately
//
// As shipped (AAP §0.1.3), the six built-in adapters divide the eight action
// types of `./schema/plan.ts` as follows:
//
// - the React adapter claims `react-render-tracking` and `state-tracking`,
//   both runtime-mode, through the page agent's fiber hook;
// - the browser-performance adapter claims `interaction-tracking` and
//   `perf-tracking`, runtime-mode, through the capture-phase interaction
//   listener and the performance observers;
// - the fetch adapter claims `fetch-tracking`, runtime-mode, through the page
//   agent's request patch — which is also what injects the trace-context
//   header that makes browser and server spans one tree;
// - the framework adapter claims `server-span` and `function-timing`,
//   patch-mode, for the handlers and server functions the graph reports, and
//   requires the dev-server preload;
// - the two database adapters claim `db-query-tracking`, runtime-mode, through
//   the driver and ORM instrumentations inside that same preload.
//
// This block is a comment and not a declaration on purpose. Which adapter
// claims which type is a fact about the registry, and AAP §0.4.2 requires
// `./registry.ts` to be the single place adapter identity is enumerated — a
// table here would be a second source of truth that no third-party adapter
// registered at runtime could appear in, and that would drift from the registry
// the first time a claim moved. `./schema/plan.ts` and `./schema/readiness.ts`
// keep their `adapter` fields bounded strings for the same reason.
// ---------------------------------------------------------------------------
