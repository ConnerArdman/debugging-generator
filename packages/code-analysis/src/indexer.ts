/**
 * The indexing pipeline: a target project in, a queryable code graph out.
 *
 * ## What this module is
 *
 * Everything else in this package is one stage of an index or one view of it;
 * this module is the orchestrator that runs the stages in order and hands back
 * the result the rest of the product reasons over. The pipeline's output is
 * what Stage 2's read-only investigation tools query, what the `code-graph`
 * source-resolution route resolves a runtime item against, what
 * `packages/instrumentation`'s feasibility check consults before it agrees to
 * patch a symbol, and what the local service turns into the "Found ‹file›"
 * progress lines a developer watches (AAP 0.4.2, 0.7.1 Group 1).
 *
 * ## The stages
 *
 * ```text
 * ./project.ts        discoverProjectFiles → the screened path set; no program, nothing read
 * this module         prepareFingerprints  → one fingerprint per path — the cache key's input
 * ./cache.ts          load                 → a hit ends the pipeline here, with no program built
 * ./project.ts        openProject          → a ts-morph program over the discovered files
 * this module         prepareFiles         → the indexable set, capped, with one fingerprint each
 * ./extractors/*.ts   extract(ctx)         → nodes, edges and diagnostics, per file
 * this module         assemble             → the CodeIndex envelope
 * this module         link                 → the derived `routes-to` edges
 * ./graph/graph.ts    CodeGraph.fromIndex  → validation, de-duplication, canonical order
 * ./route-map.ts      buildRouteMap        → the URL→module map that rides along
 * ./cache.ts          save                 → best effort, never load-bearing
 * ```
 *
 * The first three stages exist so that the fourth can be skipped: constructing
 * the program is what indexing a real application actually costs, so the cache
 * is consulted from a *discovery* — a directory walk and one `stat` per file —
 * rather than from a loaded project. A caller that supplies its own
 * {@link IndexProjectOptions.loaded} handle has already paid for the program
 * and skips the first stage instead, fingerprinting the handle's file set with
 * `prepareFiles`; both orders derive the key through one function, so an entry
 * saved by either is found by either.
 *
 * The envelope this module returns is `graph.toIndex()` rather than the one it
 * assembled, which is the contract `./graph/graph.ts` documents: construction
 * is where a duplicate id, a dangling edge or an unknown kind is found, so
 * taking the graph's own view back out is how those findings — and the removals
 * they describe — reach the returned and cached index instead of being
 * rediscovered on every load.
 *
 * ## Degrade, never abort
 *
 * A project is indexed as far as it can be. One extractor throwing on one file
 * costs that contribution and nothing else: the failure becomes an
 * `extractor-failed` diagnostic and the run continues through the remaining
 * extractors and files. A file that vanished between the program being built
 * and its metadata being read is skipped with a `file-skipped` diagnostic. A
 * project with no indexable file at all is an empty index, not a failure. The
 * only failures this module reports are the ones that leave nothing to index:
 * the project could not be opened, or the caller cancelled the run
 * (AAP 0.5.5's graceful-failure rule applied to indexing).
 *
 * ## Determinism
 *
 * Two runs over an unchanged project produce byte-identical
 * `JSON.stringify(index)` output but for {@link CodeIndex.generatedAt}, which
 * is a clock reading and the single time-varying field. Everything else is
 * fixed: the file set is sorted by project-relative path, extractors run in
 * {@link DEFAULT_EXTRACTORS} order, node and edge identities come from
 * `./graph/graph.ts`'s deterministic id functions, and the graph sorts both
 * arrays canonically. That is what makes an index cacheable and comparable at
 * all, so nothing here may depend on a `Map`'s insertion order, on a locale, on
 * a hash seed or on the wall clock beyond that one field.
 *
 * ## The cache is an optimisation and nothing more
 *
 * A hit returns an index equal to the one a build would have produced; a miss,
 * an unreadable entry, a stale entry or a failed write costs time and never
 * correctness. {@link IndexCache.save} returning an error is logged at `warn`
 * and discarded: failing to cache an index is not failing to build one.
 *
 * ## Laziness
 *
 * The build **never** asks the type checker for a symbol's references.
 * `findReferences` forces type resolution across the whole program and is the
 * most expensive operation ts-morph offers, so the static `calls` and
 * `references` edges the extractors record while walking the syntax tree are
 * the primary signal, and {@link createReferenceResolver} is the on-demand
 * deepening `./graph/query.ts`'s `whoCalls` reaches for when those edges are
 * inconclusive. The whole pipeline is syntax-tree-first for the same reason a
 * target project's dependencies are never installed: a specifier that resolves
 * to nothing must cost an edge, never a crash.
 *
 * ## Linking: the one edge no extractor can emit
 *
 * `routes-to` joins a client `api-call` node to the `api-route` node it
 * addresses, and `./graph/types.ts` fixes it as *"a call's URL matched against
 * the route map … produced after both endpoints exist, which is why it is the
 * one edge kind an extractor cannot emit on its own"*. An extractor sees one
 * file, and the two endpoints of this edge are in different files by
 * construction — the call site in a component or a client helper, the handler
 * in a route module — so `./extractors/api-calls.ts`,
 * `./extractors/server-functions.ts` and `./extractors/db-calls.ts` each state
 * that they do not produce it and defer to graph assembly.
 * {@link deriveRoutesToEdges} is that deferral discharged: it runs once, after
 * extraction, over the assembled envelope, and delegates every URL decision to
 * `./route-map.ts` so no second matching algorithm exists.
 *
 * It is the hop that makes a cross-tier flow a single traversal — a click, the
 * handler it triggers, the request that handler issues, the route that answers
 * it, the service function behind it, the query that function runs — which is
 * what `./graph/query.ts`'s `pathBetween` walks for Stage 2 and what the
 * dependency-graph panel node draws (AAP 0.4.2, 0.6.2). Without it the browser
 * half and the server half of a project are two disconnected components of one
 * graph and no path spans them.
 *
 * ## Privacy
 *
 * **File contents never leave this module.** What crosses its boundary is
 * metadata: fingerprints (path, modification time, size, optional digest),
 * nodes and edges built from identifiers and positions, counts and durations.
 * No log line and no diagnostic carries source text, a thrown message (which a
 * syntax-tree library routinely fills with the text it choked on), an absolute
 * host path from an untrusted node, or a full file list at `info`
 * (AAP 0.5.2).
 *
 * @packageDocumentation
 */

import { stat } from 'node:fs/promises';

import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  DebuggenError,
  err,
  isErr,
  isSafeRelativePath,
  noopLogger,
  normalizePosix,
  nowEpochMs,
  ok,
  roundMs,
  toPosix,
} from '@debuggen/shared';
import { sha256OfFile } from '@debuggen/shared/node';
import { Node } from 'ts-morph';

import { computeIndexCacheKey } from './cache.js';
import { apiCallsExtractor } from './extractors/api-calls.js';
import { apiRoutesExtractor } from './extractors/api-routes.js';
import { dbCallsExtractor } from './extractors/db-calls.js';
import { eventHandlersExtractor } from './extractors/event-handlers.js';
import { importsExtractor } from './extractors/imports.js';
import { reactComponentsExtractor } from './extractors/react-components.js';
import { serverFunctionsExtractor } from './extractors/server-functions.js';
import { symbolsExtractor } from './extractors/symbols.js';
import { CodeGraph, makeEdgeId } from './graph/graph.js';
import { CODE_INDEX_SCHEMA_VERSION } from './graph/types.js';
import { discoverProjectFiles, openProject } from './project.js';
import { buildRouteMap, routeMapFromIndex } from './route-map.js';

import type { Logger, Result, SourceLocation } from '@debuggen/shared';
import type { SourceFile } from 'ts-morph';
import type { IndexCache } from './cache.js';
import type {
  CodeEdge,
  CodeIndex,
  CodeNode,
  Extractor,
  ExtractorContext,
  ExtractorResult,
  FileFingerprint,
  IndexDiagnostic,
  ReferenceQuery,
  ReferenceResolver,
} from './graph/types.js';
import type { DiscoveredProject, LoadedProject } from './project.js';
import type { RouteMap } from './route-map.js';

/* -------------------------------------------------------------------------------------------------
 * Version and vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * The version of this pipeline's *output*, and part of every cache key.
 *
 * ## Bump it whenever extractor output changes shape or meaning
 *
 * That obligation is the whole point of the constant, and it is wider than it
 * looks. A new extractor, a removed one, a changed identity function, a
 * corrected classification, a different traversal order, an attribute that
 * starts being recorded or stops being recorded — every one of those makes an
 * index built by the previous version a *different answer* over the same
 * source, and every one of them requires a bump.
 *
 * `./cache.ts` folds this value into {@link computeIndexCacheKey}'s input, so a
 * bump makes every entry written by an earlier version unreachable rather than
 * merely rejected: the cheapest correct form of invalidation, and the reason
 * nothing else has to be done to retire a stale index. Forgetting the bump is
 * the one mistake here that produces silently wrong results — a cached index
 * from yesterday's extractors served to today's queries — so a change to any
 * file under `./extractors/` should be read as a change to this line as well.
 *
 * The vocabulary version — the node, edge and envelope *types* — is separate
 * and lives in `./graph/types.ts` as `CODE_INDEX_SCHEMA_VERSION`; the key
 * covers both, so a change confined to the shape of the envelope needs that
 * one instead.
 *
 * Typed `string` rather than left to infer its literal type, deliberately: a
 * consumer that narrowed against whatever literal this happens to hold would
 * break on the very bump the constant exists to make cheap, and nothing
 * downstream should compare an index's version against anything but this
 * value.
 *
 * History, so the obligation above is visible as having been met rather than
 * merely stated: `indexer/1.1.0` is the bump for `./extractors/symbols.ts`
 * recording named function-valued declarations *nested* inside another
 * declaration (with their enclosing chain) and for `./extractors/event-handlers.ts`
 * no longer recording a `symbol` on a handler whose reference resolves to a
 * parameter or a destructured binding. Both change the answer over unchanged
 * source, so every index written by `indexer/1.0.0` has to become unreachable —
 * without the bump, a cached index would answer "this file declares no such
 * symbol" for a declaration the patcher can now wrap.
 */
export const INDEXER_VERSION: string = 'indexer/1.1.0';

/**
 * The extractors an index is built from, in the fixed order they run in.
 *
 * The order is imports, symbols, React components, event handlers, API routes,
 * API calls, server functions, database calls — modules first, then the
 * declarations inside them, then the framework-shaped facts about those
 * declarations. It is deliberate but not load-bearing for *content*: **no
 * extractor may depend on another's output**, because each one derives
 * everything it reports from the abstract syntax tree of the file it is handed,
 * and nothing is passed between them. What the order does decide is the order
 * nodes, edges and diagnostics are appended in, and therefore which claimant of
 * a duplicate id graph construction keeps — so two runs over unchanged source
 * agree, which is the determinism guarantee this module's test asserts.
 *
 * Joins across extractors — an `imports` edge whose target is another file's
 * `file` node, a `calls` edge from a handler to a server function — are not
 * done here either. They happen in graph assembly, because they are identity
 * agreements: `./graph/graph.ts`'s `makeNodeId` computes the same id for the
 * same declaration whichever extractor mints it, so an edge one extractor
 * emitted finds the node another emitted without either knowing the other ran.
 *
 * Frozen, and safe to pass as {@link IndexProjectOptions.extractors}: a caller
 * that wants a narrower run passes a subset, and one that wants an extra
 * extractor passes this array spread with its own.
 */
export const DEFAULT_EXTRACTORS: readonly Extractor[] = Object.freeze([
  importsExtractor,
  symbolsExtractor,
  reactComponentsExtractor,
  eventHandlersExtractor,
  apiRoutesExtractor,
  apiCallsExtractor,
  serverFunctionsExtractor,
  dbCallsExtractor,
]);

/* -------------------------------------------------------------------------------------------------
 * Shared empties and bounds
 * ---------------------------------------------------------------------------------------------- */

/** The diagnostics list of a run that found nothing to report. Shared, frozen. */
const EMPTY_DIAGNOSTICS: readonly IndexDiagnostic[] = Object.freeze([]);

/** The fingerprint list of a project with no indexable file. Shared, frozen. */
const EMPTY_FINGERPRINTS: readonly FileFingerprint[] = Object.freeze([]);

/**
 * The per-extractor timings of a run in which no extractor ran — a cache hit.
 *
 * Empty rather than a record of zeros, so that "no extractor ran" and "every
 * extractor ran and took no measurable time" stay different answers.
 */
const EMPTY_DURATIONS: Readonly<Record<string, number>> = Object.freeze({});

/** The answer to a reference lookup that found nothing. Shared, frozen. */
const EMPTY_LOCATIONS: readonly SourceLocation[] = Object.freeze([]);

/**
 * The derived-edge list of a project whose call sites reached no route. Shared,
 * frozen.
 */
const EMPTY_EDGES: readonly CodeEdge[] = Object.freeze([]);

/**
 * How many declarations of one name {@link createReferenceResolver} will search
 * from in a single file.
 *
 * A name is normally declared once per module; more than a handful means
 * shadowed locals, overloads or a merged declaration, and searching every one
 * of them multiplies the most expensive operation in the package for answers
 * that converge. The bound keeps an unanswerable question cheap instead of
 * turning it into a stall.
 */
const MAX_DECLARATION_CANDIDATES = 8;

/**
 * How many distinct reference sites one lookup will return.
 *
 * `./graph/query.ts` caps what it presents far below this; the bound here is
 * the backstop for a symbol referenced pervasively — a utility imported by
 * every module — where the cost is in collecting the list rather than in
 * showing it.
 */
const MAX_REFERENCE_SITES = 500;

/** What a developer can do when a run was cancelled. */
const ABORT_HINT = 'Start the session again to index the project.';

/** The separator used to key a memo or a de-duplication map on a tuple of strings. */
const KEY_SEPARATOR = '\u0000';

/* -------------------------------------------------------------------------------------------------
 * Public options and results
 * ---------------------------------------------------------------------------------------------- */

/**
 * How {@link indexProject} runs.
 *
 * Every field but `projectRoot` is optional, and the defaults are the ones the
 * local service uses: this package's own extractors, no content hashing, no
 * cache, no bound on the file count and a silent logger.
 */
export interface IndexProjectOptions {
  /**
   * The project to index: an absolute path to the directory the developer
   * opened.
   *
   * Required even when {@link IndexProjectOptions.loaded} is supplied, because
   * it is what a caller's own configuration names. The value that reaches the
   * index and the cache key is never this string but always the one
   * `./project.ts` normalised — `LoadedProject.projectRoot`, or the identical
   * `DiscoveredProject.projectRoot` on the path that consults the cache before
   * opening anything.
   */
  readonly projectRoot: string;

  /**
   * The TypeScript configuration to take compiler options from, when the
   * project's own `tsconfig.json` is not the one in force.
   *
   * Passed through to `./project.ts` — to `discoverProjectFiles` and to
   * `openProject`, which resolve it identically — and part of the cache key,
   * because it decides which specifiers resolve (`paths` aliases above all) and
   * therefore which edges the graph ends up holding.
   */
  readonly tsConfigFilePath?: string | undefined;

  /**
   * An already-opened project to index, instead of opening one here.
   *
   * The path a caller takes when it holds a project for other reasons — a
   * reference resolver, a route map, a second index with different options —
   * because constructing the ts-morph program is the expensive part of an
   * index and there is no reason to pay for it twice.
   *
   * Supplying a handle also decides the order of the stages: the program exists
   * already, so its file set is prepared first and the cache is consulted from
   * that, rather than from a discovery taken before anything is parsed. The key
   * is the same either way; see {@link indexProject}.
   */
  readonly loaded?: LoadedProject | undefined;

  /**
   * The cache to consult and write to, or `false` to build unconditionally.
   *
   * `undefined` and `false` mean the same thing — no caching — and are both
   * spelled because `false` is what an explicit "do not use the cache here"
   * looks like at a call site.
   */
  readonly cache?: IndexCache | false | undefined;

  /**
   * Whether to hash every file's contents into its fingerprint. Defaults to
   * `false`.
   *
   * Modification time and size are the normal invalidation key and they answer
   * the question for ordinary editing. Hashing is the opt-in for a checkout
   * whose modification times are not trustworthy — a fresh clone, a restore
   * from a backup, a build system that writes fixed timestamps — and it costs a
   * full read of every indexable file, which on a large project dominates the
   * rest of the preparation stage.
   */
  readonly hashContents?: boolean | undefined;

  /**
   * The extractors to run. Defaults to {@link DEFAULT_EXTRACTORS}.
   *
   * A subset narrows an index deliberately; an extra entry extends it. The
   * identities of this set — every {@link Extractor.id}, in the order given —
   * are **part of the cache key**, so a narrowed or extended run has its own
   * cache entry and can neither be served to a request that wanted the full
   * index nor be displaced by one. Caching a deliberately narrow run is
   * therefore safe and needs no `cache: false` alongside it.
   *
   * Two consequences worth knowing. The *order* counts, for the reason given
   * on {@link DEFAULT_EXTRACTORS}: it decides which claimant of a duplicate id
   * graph construction keeps, so the same extractors in another order are
   * another index and another key. And an `id` is an identity contract — a
   * caller's own extractor that reuses an id from this package shares that
   * package's key space, which {@link INDEXER_VERSION} only covers for
   * extractors that ship here.
   */
  readonly extractors?: readonly Extractor[] | undefined;

  /**
   * The greatest number of files to index, for a project large enough that a
   * full index is not worth waiting for.
   *
   * The first `maxFiles` files in project-relative path order are indexed, the
   * rest are counted in {@link IndexStats.skippedFiles} and reported as a
   * `limit-reached` diagnostic, and the result is **never written to the
   * cache**: a truncated index must not be served to a later request that
   * wanted a whole one.
   */
  readonly maxFiles?: number | undefined;

  /**
   * A signal that cancels the run.
   *
   * Checked when preparation and extraction begin and between files, so a
   * cancelled run stops within one file's work rather than at the end. An
   * aborted signal makes this function answer `Err` with code
   * `CODE_INDEX_FAILED` and `details.reason` of `'aborted'` — a cancelled index
   * is not a partial index, because a caller that asked for one and then
   * changed its mind must not be handed half a graph as if it were whole.
   */
  readonly signal?: AbortSignal | undefined;

  /**
   * Where this module's counts and durations go. Defaults to `noopLogger`.
   *
   * Passed on to `openProject`, to every {@link ExtractorContext}, to graph
   * construction and to the route map, so one injected logger covers the whole
   * pipeline.
   */
  readonly logger?: Logger | undefined;
}

/**
 * How {@link buildIndex} runs: {@link IndexProjectOptions} without the parts
 * that only mean something when this module owns the project and the cache.
 */
export interface BuildIndexOptions {
  /** The extractors to run. Defaults to {@link DEFAULT_EXTRACTORS}. */
  readonly extractors?: readonly Extractor[] | undefined;

  /**
   * Whether to hash file contents into their fingerprints. Defaults to
   * `false`; see {@link IndexProjectOptions.hashContents}.
   */
  readonly hashContents?: boolean | undefined;

  /** A signal that cancels the build; see {@link IndexProjectOptions.signal}. */
  readonly signal?: AbortSignal | undefined;

  /** Where counts and durations go. Defaults to `noopLogger`. */
  readonly logger?: Logger | undefined;
}

/**
 * What one indexing run cost and what it found out about itself.
 *
 * Magnitudes and findings, never contents: this is what a progress view shows a
 * developer and what a log line records, so it says how much was indexed and
 * what could not be, and nothing about what the code says.
 */
export interface IndexStats {
  /**
   * How many files the index covers — the length of {@link CodeIndex.files}.
   *
   * Files that were skipped are not counted here; they are in
   * {@link IndexStats.skippedFiles}.
   */
  readonly fileCount: number;

  /** How many nodes the graph holds, after construction's removals. */
  readonly nodeCount: number;

  /** How many edges the graph holds, after construction's removals. */
  readonly edgeCount: number;

  /**
   * How long the run took, in milliseconds, measured on a monotonic clock:
   * project loading where this module did it, preparation, the cache lookup,
   * extraction, graph construction, the route map and the cache write.
   */
  readonly durationMs: number;

  /**
   * How long each extractor spent, in milliseconds, keyed by
   * {@link Extractor.id} and summed across every file.
   *
   * The measurement that tells a maintainer which extractor a slow index is
   * paying for. Empty on a cache hit, where no extractor ran.
   */
  readonly extractorDurations: Readonly<Record<string, number>>;

  /**
   * How many files the run did not index: those the `maxFiles` bound excluded,
   * and those whose metadata could not be read or whose path could not be
   * expressed relative to the project.
   */
  readonly skippedFiles: number;

  /**
   * Everything the run found out that a consumer should know — from
   * preparation, from the extractors and from graph construction, in that
   * order.
   *
   * Never empty when part of the index is missing, which is what makes a
   * partial index honest rather than merely smaller.
   */
  readonly diagnostics: readonly IndexDiagnostic[];
}

/**
 * The result of a successful {@link indexProject} run: the index, the two views
 * built from it, and what the run cost.
 *
 * The graph and the route map are handed back rather than left to the caller to
 * derive because both were built here anyway — the graph because construction
 * is where the index is validated, the route map because it needs the same
 * program — and rebuilding either would repeat work this run has already paid
 * for.
 */
export interface IndexResult {
  /**
   * The index: plain JSON, canonically ordered, safe to serialise and to cache.
   *
   * Always `graph.toIndex()` rather than the envelope this module assembled, so
   * what a caller holds is what construction validated.
   */
  readonly index: CodeIndex;

  /** The graph over {@link IndexResult.index}, ready for `./graph/query.ts`. */
  readonly graph: CodeGraph;

  /**
   * The project's routes, for matching a captured request's URL to the module
   * that served it.
   *
   * Built with the compiler on a fresh index — so it carries per-method
   * positions — and rebuilt from the index alone on a cache hit, where there is
   * no program to ask.
   */
  readonly routeMap: RouteMap;

  /**
   * Whether the index came from the cache.
   *
   * `true` means no file was parsed and no extractor ran, which is worth
   * knowing when a result is surprising: a stale-looking index with
   * `fromCache: true` and an unchanged fingerprint set is a correct answer
   * about an unchanged project.
   */
  readonly fromCache: boolean;

  /** What the run cost and found out; see {@link IndexStats}. */
  readonly stats: IndexStats;
}

/* -------------------------------------------------------------------------------------------------
 * Internal pipeline shapes
 * ---------------------------------------------------------------------------------------------- */

/**
 * The resolved form of a caller's options: every default applied exactly once,
 * so no stage has to re-decide what a missing option meant.
 */
interface PipelineOptions {
  /** The extractors to run, in order. */
  readonly extractors: readonly Extractor[];

  /** Whether a fingerprint carries a content digest. */
  readonly hashContents: boolean;

  /** The file-count bound, or `undefined` for none. */
  readonly maxFiles: number | undefined;

  /** The cancellation signal, or `undefined` for none. */
  readonly signal: AbortSignal | undefined;

  /** The resolved logger; never `undefined`. */
  readonly logger: Logger;
}

/** One file the run will index, with everything the later stages need about it. */
interface PreparedFile {
  /** The compiler's view of the file, for the extractors. */
  readonly sourceFile: SourceFile;

  /** Its project-relative POSIX path, as every node, edge and fingerprint spells it. */
  readonly file: string;

  /** Its metadata, for the cache key and for {@link CodeIndex.files}. */
  readonly fingerprint: FileFingerprint;
}

/**
 * What deciding the indexable set produced, without reference to whether those
 * files have been parsed: the cache key's input, and the diagnostics that
 * describe how the set was arrived at.
 *
 * Both of {@link indexProject}'s cache paths hold one of these — the cache-first
 * path from {@link prepareFingerprints} over a discovery, the
 * already-opened-project path from {@link prepareFiles} over a program — which
 * is what lets the key derivation, the hit result and the statistics be written
 * once instead of once per path.
 */
interface PreparedFingerprints {
  /**
   * One fingerprint per file of the indexable set, sorted ascending by
   * project-relative path — the cache key's input.
   */
  readonly fingerprints: readonly FileFingerprint[];

  /** What preparation found out; carried into the index's diagnostics. */
  readonly diagnostics: readonly IndexDiagnostic[];

  /** How many files preparation excluded, for {@link IndexStats.skippedFiles}. */
  readonly skippedFiles: number;

  /**
   * Whether the `maxFiles` bound excluded anything.
   *
   * The reason a truncated index is never written to the cache.
   */
  readonly truncated: boolean;
}

/**
 * The outcome of the preparation stage: the indexable set and what deciding it
 * cost.
 *
 * Preparation is what *defines* the indexable set — a file whose metadata could
 * not be read is dropped from both the fingerprint list and the extraction
 * loop, because an index that claimed to cover a file it could not even stat
 * would key a cache entry against a state that no longer exists.
 */
interface PreparedFiles extends PreparedFingerprints {
  /**
   * The files to index, sorted ascending by project-relative path and in the
   * same order as {@link PreparedFingerprints.fingerprints}.
   */
  readonly entries: readonly PreparedFile[];
}

/** The outcome of the extraction and assembly stages. */
interface BuildOutcome {
  /** The canonical envelope: `graph.toIndex()`. */
  readonly index: CodeIndex;

  /** The graph the envelope came out of. */
  readonly graph: CodeGraph;

  /** Per-extractor timings, summed across files and keyed by extractor id. */
  readonly extractorDurations: Readonly<Record<string, number>>;

  /** How many files were excluded, propagated from preparation. */
  readonly skippedFiles: number;
}

/* -------------------------------------------------------------------------------------------------
 * Diagnostics and failures
 * ---------------------------------------------------------------------------------------------- */

/**
 * What can safely be said about a thrown value.
 *
 * A filesystem error's `code` — `ENOENT`, `EACCES` — is a fixed vocabulary word
 * and the single most useful thing to record, so it is preferred where there is
 * one. Failing that, only the error's *type* name is reported and never its
 * message: a syntax-tree library routinely embeds the text of the node it
 * choked on in the message, and that text is the developer's source, which a
 * diagnostic must never carry (see the privacy constraint on
 * `INDEX_DIAGNOSTIC_CODES` in `./graph/types.ts`).
 *
 * @param cause Whatever was thrown.
 * @returns A short, quote-free description.
 */
function failureDetail(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null) {
    const code: unknown = Reflect.get(cause, 'code');
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
  }

  if (cause instanceof Error) {
    return `threw ${cause.name.length > 0 ? cause.name : 'Error'}`;
  }

  return `threw a non-error value of type ${typeof cause}`;
}

/**
 * The diagnostic for a file the run did not index.
 *
 * `info` rather than `warning`: a file excluded from an index is a fact about
 * the file set, and the reason is always something the developer's tree says
 * rather than something the indexer got wrong.
 *
 * @param file The file, project-relative, or `undefined` when the path could
 * not be expressed relative to the project — in which case it is deliberately
 * left out rather than reported absolute, because an absolute path is a host
 * detail this module does not export.
 * @param detail Why it was skipped: a filesystem error code, or a fixed reason.
 * @returns The diagnostic.
 */
function fileSkipped(file: string | undefined, detail: string): IndexDiagnostic {
  const message =
    file === undefined
      ? 'A file was skipped: its path could not be expressed relative to the project root'
      : 'This file was skipped: its metadata could not be read';

  return file === undefined
    ? { severity: 'info', code: 'file-skipped', message, detail }
    : { severity: 'info', code: 'file-skipped', message, file, detail };
}

/**
 * The diagnostic for the `maxFiles` bound excluding part of the project.
 *
 * @param total How many indexable files the project holds.
 * @param indexed How many of them were indexed.
 * @returns The diagnostic.
 */
function limitReached(total: number, indexed: number): IndexDiagnostic {
  return {
    severity: 'warning',
    code: 'limit-reached',
    message: `Only ${indexed} of ${total} indexable files were indexed because a file limit was set; the index and every count taken from it are partial`,
    detail: `maxFiles=${indexed}`,
  };
}

/**
 * The diagnostic for an extractor that threw while visiting a file.
 *
 * `error`, because a part of the index is simply missing: whatever that
 * extractor would have contributed for that file is absent. The run continues
 * regardless — the remaining extractors and files are indexed and the graph
 * stays usable.
 *
 * @param extractorId The extractor that threw.
 * @param file The file it was visiting, project-relative.
 * @param cause Whatever it threw.
 * @returns The diagnostic.
 */
function extractorThrew(extractorId: string, file: string, cause: unknown): IndexDiagnostic {
  return {
    severity: 'error',
    code: 'extractor-failed',
    message: `${extractorId} threw while indexing this file; its contribution for the file was dropped and the run continued`,
    file,
    extractorId,
    detail: failureDetail(cause),
  };
}

/**
 * The diagnostic for a contribution dropped because it breaks the invariant
 * every node and edge field shares: a `file` must be a safe project-relative
 * POSIX path.
 *
 * Kept at `warning` rather than `error` because the extractor otherwise
 * succeeded, and reported under `extractor-failed` because the finding is
 * attributable to the extractor rather than to the project. **The offending
 * path is never echoed**: it is by definition not a project-relative path, so
 * repeating it would put an absolute host path — or worse, something outside
 * the project entirely — into a log line, a persisted session and possibly a
 * prompt.
 *
 * @param extractorId The extractor that produced it.
 * @param file The file being visited, project-relative.
 * @param what Which kind of contribution was dropped.
 * @param kind The node or edge kind, a fixed vocabulary word.
 * @returns The diagnostic.
 */
function unsafeContribution(
  extractorId: string,
  file: string,
  what: 'node' | 'edge',
  kind: string,
): IndexDiagnostic {
  return {
    severity: 'warning',
    code: 'extractor-failed',
    message: `${extractorId} produced a ${kind} ${what} whose file is not a safe project-relative path; the ${what} was dropped`,
    file,
    extractorId,
    detail: `${what}Kind=${kind}`,
  };
}

/**
 * The error a cancelled run answers with, or `undefined` while the run may
 * continue.
 *
 * Returned rather than thrown so that every call site is a plain `if`, and
 * carrying `details.reason` so a caller can tell cancellation from the other
 * things `CODE_INDEX_FAILED` covers without matching on a message.
 *
 * @param signal The caller's signal, if any.
 * @returns The error, or `undefined` when there is no signal or it has not
 * been aborted.
 */
function abortedError(signal: AbortSignal | undefined): DebuggenError | undefined {
  if (signal === undefined || !signal.aborted) {
    return undefined;
  }

  return new DebuggenError('CODE_INDEX_FAILED', 'Indexing was cancelled before it finished.', {
    hint: ABORT_HINT,
    details: { reason: 'aborted' },
  });
}

/* -------------------------------------------------------------------------------------------------
 * Stage 1: preparation
 * ---------------------------------------------------------------------------------------------- */

/**
 * Byte-wise lexicographic comparison, for every ordering this module defines.
 *
 * **Never `localeCompare`**: a locale-aware comparison depends on the machine's
 * collation settings, which would make two developers' indexes over the same
 * source differ in order and invalidate a shared cache entry for no reason —
 * the same reason `./graph/graph.ts` compares this way.
 *
 * @param left The first string.
 * @param right The second string.
 * @returns A negative number, zero, or a positive number.
 */
function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}

/**
 * Reads one file's metadata, and its digest when the run asked for one.
 *
 * Deliberately total: every failure comes back as a reason string rather than a
 * rejection, because a file that vanished between the program being built and
 * this call is an ordinary thing to happen in a working tree and must cost one
 * diagnostic rather than the whole index.
 *
 * The digest is read *after* the metadata and its failure skips the file too: a
 * file whose contents could not be read is a file this run cannot describe, and
 * a fingerprint that silently dropped its `hash` would be indistinguishable
 * from one taken in metadata-only mode and would collide with it in a cache
 * key.
 *
 * @param absolutePath The file's absolute POSIX path.
 * @param file Its project-relative POSIX path.
 * @param hashContents Whether to compute a digest.
 * @returns The fingerprint, or the reason it could not be taken.
 */
async function fingerprintOf(
  absolutePath: string,
  file: string,
  hashContents: boolean,
): Promise<Result<FileFingerprint, string>> {
  let mtimeMs: number;
  let size: number;

  try {
    const stats = await stat(absolutePath);
    if (!stats.isFile()) {
      return err('not-a-regular-file');
    }
    mtimeMs = stats.mtimeMs;
    size = stats.size;
  } catch (cause) {
    return err(failureDetail(cause));
  }

  if (!hashContents) {
    return ok({ file, mtimeMs, size });
  }

  try {
    const hash = await sha256OfFile(absolutePath);
    return ok({ file, mtimeMs, size, hash });
  } catch (cause) {
    return err(failureDetail(cause));
  }
}

/**
 * Decides the indexable set and fingerprints it.
 *
 * Three steps: the project's files are taken in their documented order (sorted
 * ascending by project-relative path), the `maxFiles` bound is applied to that
 * order so a truncated run is a deterministic prefix rather than an arbitrary
 * subset, and each survivor is reduced to a project-relative path plus
 * metadata. The result is sorted again on the project-relative path, so the
 * ordering holds even for a `LoadedProject` a caller built itself.
 *
 * No file is read here unless `hashContents` was asked for, and no abstract
 * syntax tree is walked: this stage exists to produce the cache key's input
 * before the expensive stage begins, which is what lets a hit skip extraction
 * entirely.
 *
 * @param loaded The opened project.
 * @param options The resolved pipeline options.
 * @returns The indexable set, or `Err` when the run was cancelled.
 */
async function prepareFiles(
  loaded: LoadedProject,
  options: PipelineOptions,
): Promise<Result<PreparedFiles>> {
  const cancelled = abortedError(options.signal);
  if (cancelled !== undefined) {
    return err(cancelled);
  }

  const all = loaded.sourceFiles();
  const limit =
    options.maxFiles === undefined ? undefined : Math.max(Math.trunc(options.maxFiles), 0);
  const truncated = limit !== undefined && all.length > limit;
  const selected = limit === undefined ? all : all.slice(0, limit);

  const diagnostics: IndexDiagnostic[] = [];
  const entries: PreparedFile[] = [];
  let skippedFiles = 0;

  if (truncated) {
    skippedFiles += all.length - selected.length;
    diagnostics.push(limitReached(all.length, selected.length));
    options.logger.warn('the code index was truncated by a file limit', {
      total: all.length,
      indexed: selected.length,
    });
  }

  for (const sourceFile of selected) {
    const aborted = abortedError(options.signal);
    if (aborted !== undefined) {
      return err(aborted);
    }

    const absolutePath = toPosix(sourceFile.getFilePath());
    const file = loaded.projectRelative(absolutePath);

    if (file === undefined || !isSafeRelativePath(file)) {
      skippedFiles += 1;
      diagnostics.push(fileSkipped(undefined, 'outside-project'));
      continue;
    }

    const fingerprint = await fingerprintOf(absolutePath, file, options.hashContents);

    if (isErr(fingerprint)) {
      skippedFiles += 1;
      diagnostics.push(fileSkipped(file, fingerprint.error));
      continue;
    }

    entries.push({ sourceFile, file, fingerprint: fingerprint.value });
  }

  entries.sort((left, right) => compareStrings(left.file, right.file));

  return ok({
    entries: Object.freeze(entries),
    fingerprints:
      entries.length === 0
        ? EMPTY_FINGERPRINTS
        : Object.freeze(entries.map((entry) => entry.fingerprint)),
    diagnostics: diagnostics.length === 0 ? EMPTY_DIAGNOSTICS : Object.freeze(diagnostics),
    skippedFiles,
    truncated,
  });
}

/**
 * Fingerprints a *discovered* file set — the same decision {@link prepareFiles}
 * makes, taken before there is a program to make it from.
 *
 * This is what lets the cache be consulted first. `./project.ts`'s
 * `discoverProjectFiles` establishes which files the indexer is willing to read
 * without constructing a ts-morph program, and this function reduces that list
 * to the fingerprints the cache key is derived from, so a hit costs a directory
 * walk and one `stat` per file instead of a full parse of the project.
 *
 * It mirrors {@link prepareFiles} deliberately and in every detail that can
 * affect the key: the `maxFiles` bound is applied as a prefix of the same
 * sorted order, the same {@link fingerprintOf} takes the same metadata (and the
 * same optional digest), a file whose path is unusable or whose metadata cannot
 * be read produces the same {@link fileSkipped} diagnostic and increments the
 * same counter, truncation produces the same {@link limitReached} diagnostic
 * and the same `warn`, and cancellation is checked at the same two places. Any
 * divergence between the two would show up as a cache that never hits — one
 * path would save under a key the other never computes — which is why they are
 * written against the same helpers rather than merely to the same description.
 *
 * No abstract syntax tree is walked and no file is opened unless
 * `hashContents` was asked for.
 *
 * @param discovered The screened file set from `discoverProjectFiles`.
 * @param options The resolved pipeline options.
 * @returns The fingerprints and what deciding them found out, or `Err` when the
 * run was cancelled.
 */
async function prepareFingerprints(
  discovered: DiscoveredProject,
  options: PipelineOptions,
): Promise<Result<PreparedFingerprints>> {
  const cancelled = abortedError(options.signal);
  if (cancelled !== undefined) {
    return err(cancelled);
  }

  const all = discovered.files;
  const limit =
    options.maxFiles === undefined ? undefined : Math.max(Math.trunc(options.maxFiles), 0);
  const truncated = limit !== undefined && all.length > limit;
  const selected = limit === undefined ? all : all.slice(0, limit);

  const diagnostics: IndexDiagnostic[] = [];
  const fingerprints: FileFingerprint[] = [];
  let skippedFiles = 0;

  if (truncated) {
    skippedFiles += all.length - selected.length;
    diagnostics.push(limitReached(all.length, selected.length));
    options.logger.warn('the code index was truncated by a file limit', {
      total: all.length,
      indexed: selected.length,
    });
  }

  for (const [index, absolutePath] of selected.entries()) {
    const aborted = abortedError(options.signal);
    if (aborted !== undefined) {
      return err(aborted);
    }

    // The discovery states that the two lists are the same length and in the
    // same order; reading the relative path by index rather than deriving it
    // again keeps this function free of path arithmetic, and the `undefined`
    // case — which a hand-built discovery could produce — is the same "no
    // usable project-relative path" outcome `prepareFiles` reports.
    const file = discovered.relativeFiles[index];

    if (file === undefined || !isSafeRelativePath(file)) {
      skippedFiles += 1;
      diagnostics.push(fileSkipped(undefined, 'outside-project'));
      continue;
    }

    const fingerprint = await fingerprintOf(absolutePath, file, options.hashContents);

    if (isErr(fingerprint)) {
      skippedFiles += 1;
      diagnostics.push(fileSkipped(file, fingerprint.error));
      continue;
    }

    fingerprints.push(fingerprint.value);
  }

  // Sorted here as well as in the discovery, for the reason `prepareFiles`
  // sorts its own entries: the order is part of what the key is derived from
  // and of what a built index records, so it is established by this module
  // rather than trusted from its input.
  fingerprints.sort((left, right) => compareStrings(left.file, right.file));

  return ok({
    fingerprints: fingerprints.length === 0 ? EMPTY_FINGERPRINTS : Object.freeze(fingerprints),
    diagnostics: diagnostics.length === 0 ? EMPTY_DIAGNOSTICS : Object.freeze(diagnostics),
    skippedFiles,
    truncated,
  });
}

/* -------------------------------------------------------------------------------------------------
 * Stage 2: extraction and assembly
 * ---------------------------------------------------------------------------------------------- */

/**
 * The accumulator one extraction pass fills.
 *
 * Mutable by design and owned by {@link extractAll} alone: the arrays are the
 * envelope's arrays, appended to in extractor order so that the order is the
 * documented one, and the two id sets exist only so a repeated identity can be
 * logged with the extractor that produced it — attribution graph construction
 * cannot provide, because by then nobody knows which extractor an entry came
 * from.
 */
interface Collector {
  /** Nodes in contribution order. */
  readonly nodes: CodeNode[];

  /** Edges in contribution order. */
  readonly edges: CodeEdge[];

  /** Diagnostics from preparation, then from extraction. */
  readonly diagnostics: IndexDiagnostic[];

  /** Node ids seen so far. */
  readonly nodeIds: Set<string>;

  /** Edge ids seen so far. */
  readonly edgeIds: Set<string>;
}

/**
 * Takes one extractor's result for one file into the accumulator.
 *
 * Two things happen per entry, and neither of them is validation of the
 * *graph*: that belongs to `./graph/graph.ts`, which is the single place an
 * index is checked, and duplicating it here would move the diagnostics that
 * describe a removal away from the module that performs it.
 *
 * - **The path invariant is enforced.** A node's `file`, and an edge's when it
 *   carries one, must be a safe project-relative POSIX path. This is the one
 *   check that cannot wait for construction, because an unsafe path is a
 *   privacy problem as well as a correctness one — it is how an absolute host
 *   path would reach a persisted session — and because construction has no
 *   vocabulary for it. The entry is dropped and reported.
 * - **A repeated id is logged at `debug`.** It is *not* dropped here: graph
 *   construction keeps the first claimant, drops the rest and records
 *   `duplicate-node-id` or `duplicate-edge-id` when the claimants differ, which
 *   is the documented behaviour and the reason this module returns
 *   `graph.toIndex()`. The log line adds what construction cannot: which
 *   extractor produced the repeat.
 *
 * @param collector The accumulator to append to.
 * @param result What the extractor returned.
 * @param extractorId The extractor that returned it.
 * @param file The file it was visiting, project-relative.
 * @param logger Where the duplicate-identity lines go.
 */
function collectContribution(
  collector: Collector,
  result: ExtractorResult,
  extractorId: string,
  file: string,
  logger: Logger,
): void {
  for (const node of result.nodes) {
    if (!isSafeRelativePath(node.file)) {
      collector.diagnostics.push(unsafeContribution(extractorId, file, 'node', node.kind));
      continue;
    }

    if (collector.nodeIds.has(node.id)) {
      logger.debug('a node id was claimed twice; graph construction keeps the first claimant', {
        extractorId,
        file,
        kind: node.kind,
        id: node.id,
      });
    } else {
      collector.nodeIds.add(node.id);
    }

    collector.nodes.push(node);
  }

  for (const edge of result.edges) {
    if (edge.file !== undefined && !isSafeRelativePath(edge.file)) {
      collector.diagnostics.push(unsafeContribution(extractorId, file, 'edge', edge.kind));
      continue;
    }

    if (collector.edgeIds.has(edge.id)) {
      logger.debug('an edge id was claimed twice; graph construction keeps the first claimant', {
        extractorId,
        file,
        kind: edge.kind,
        id: edge.id,
      });
    } else {
      collector.edgeIds.add(edge.id);
    }

    collector.edges.push(edge);
  }

  if (result.diagnostics !== undefined) {
    collector.diagnostics.push(...result.diagnostics);
  }
}

/**
 * Runs every extractor over every prepared file, assembles the envelope and
 * builds the graph.
 *
 * ## Why this is synchronous work in an asynchronous pipeline
 *
 * {@link Extractor.extract} is synchronous — it walks a tree that is already in
 * memory — so there is nothing to await between files and no benefit in
 * pretending otherwise. Cancellation is therefore cooperative and checked
 * between files, which bounds the delay at one file's extraction rather than at
 * the whole run.
 *
 * ## Failure is per extractor, per file
 *
 * Each call is guarded. An extractor that throws costs its contribution for
 * that one file: the failure becomes an `extractor-failed` diagnostic naming
 * the extractor and the file, and the loop continues with the next extractor.
 * Its timing is still recorded, because the time was still spent, and an
 * extractor that fails slowly is worth seeing.
 *
 * @param loaded The opened project.
 * @param prepared The indexable set from {@link prepareFiles}.
 * @param options The resolved pipeline options.
 * @returns The index, the graph and the timings, or `Err` when the run was
 * cancelled.
 */
function extractAll(
  loaded: LoadedProject,
  prepared: PreparedFiles,
  options: PipelineOptions,
): Result<BuildOutcome> {
  const cancelled = abortedError(options.signal);
  if (cancelled !== undefined) {
    return err(cancelled);
  }

  const collector: Collector = {
    nodes: [],
    edges: [],
    diagnostics: [...prepared.diagnostics],
    nodeIds: new Set<string>(),
    edgeIds: new Set<string>(),
  };

  // Seeded with every extractor so the key set of the reported timings is the
  // extractor set rather than "whichever extractors happened to contribute",
  // which keeps two runs' stats comparable.
  const durations = new Map<string, number>();
  for (const extractor of options.extractors) {
    durations.set(extractor.id, 0);
  }

  for (const entry of prepared.entries) {
    const aborted = abortedError(options.signal);
    if (aborted !== undefined) {
      return err(aborted);
    }

    const ctx: ExtractorContext = {
      loaded,
      sourceFile: entry.sourceFile,
      file: entry.file,
      projectRoot: loaded.projectRoot,
      logger: options.logger,
    };

    for (const extractor of options.extractors) {
      const startedAt = performance.now();
      let result: ExtractorResult | undefined;

      try {
        result = extractor.extract(ctx);
      } catch (cause) {
        collector.diagnostics.push(extractorThrew(extractor.id, entry.file, cause));
      } finally {
        durations.set(
          extractor.id,
          (durations.get(extractor.id) ?? 0) + (performance.now() - startedAt),
        );
      }

      if (result !== undefined) {
        collectContribution(collector, result, extractor.id, entry.file, options.logger);
      }
    }
  }

  // Linking runs between assembly and construction: it needs every node of the
  // project, and the edges it derives have to pass through the graph's own
  // validation and canonical ordering like any other.
  const assembled = assembleIndex(loaded, prepared, collector);
  const routesTo = deriveRoutesToEdges(assembled);
  if (routesTo.length > 0) {
    options.logger.debug('derived route edges from call sites with literal URLs', {
      edges: routesTo.length,
    });
  }

  const graph = CodeGraph.fromIndex(
    routesTo.length === 0 ? assembled : { ...assembled, edges: [...assembled.edges, ...routesTo] },
    { logger: options.logger },
  );

  const extractorDurations: Record<string, number> = {};
  for (const extractor of options.extractors) {
    extractorDurations[extractor.id] = roundMs(durations.get(extractor.id) ?? 0, 3);
  }

  return ok({
    index: graph.toIndex(),
    graph,
    extractorDurations: Object.freeze(extractorDurations),
    skippedFiles: prepared.skippedFiles,
  });
}

/**
 * Assembles the {@link CodeIndex} envelope from what the run collected.
 *
 * The envelope's field order matches the declaration order of `CodeIndex`, and
 * `diagnostics` is omitted entirely when there are none — both so that
 * `JSON.stringify` of this value and of the graph's own
 * `toIndex()` view are byte-identical for a clean run, which is what makes the
 * round trip through construction a fixed point rather than a reformatting.
 *
 * {@link CodeIndex.generatedAt} is the only field here that differs between two
 * runs over unchanged source. It is a clock reading in epoch milliseconds,
 * deliberately taken once per index rather than per file, so an index describes
 * one moment.
 *
 * @param loaded The opened project, for the normalised root.
 * @param prepared The indexable set, for the fingerprints.
 * @param collector What extraction produced.
 * @returns The envelope, ready for {@link CodeGraph.fromIndex}.
 */
function assembleIndex(
  loaded: LoadedProject,
  prepared: PreparedFiles,
  collector: Collector,
): CodeIndex {
  const envelope = {
    schemaVersion: CODE_INDEX_SCHEMA_VERSION,
    projectRoot: loaded.projectRoot,
    indexerVersion: INDEXER_VERSION,
    generatedAt: nowEpochMs(),
    nodes: collector.nodes,
    edges: collector.edges,
    files: prepared.fingerprints,
  };

  if (collector.diagnostics.length === 0) {
    return envelope;
  }

  return { ...envelope, diagnostics: collector.diagnostics };
}

/**
 * Derives the `routes-to` edges of an assembled envelope: one per call site
 * whose literal URL a route of this project answers.
 *
 * The linking stage described on this module, and the only place in the package
 * that produces this edge kind. Three properties make it safe to run over every
 * index:
 *
 * - **It decides nothing about URLs.** Matching, percent-decoding, route
 *   groups, dynamic and catch-all segments, specificity and the origin policy
 *   all belong to `./route-map.ts`, which is asked through the same
 *   {@link RouteMap.resolve} a query uses. A call to an absolute URL on another
 *   origin therefore resolves to nothing and contributes no edge, rather than
 *   being joined to a local route whose path happens to coincide.
 * - **It only joins what was written.** Only an `api-call` node carrying a
 *   literal, non-dynamic `url` is considered: `./extractors/api-calls.ts`
 *   records a target *exactly as written or not at all*, and a template
 *   literal whose interpolation is unknown must not acquire an edge to whatever
 *   route its prefix resembles. The method is deliberately not part of the
 *   match — the edge states that a call site addresses a route module, which is
 *   a fact about the URL, and a route whose handler exports could not be
 *   located reports no methods at all.
 * - **It is derived, so it has no site.** `./graph/graph.ts` documents a
 *   `routes-to` edge as the canonical example of an edge *"computed from two
 *   nodes rather than read off a line of source"*, so it carries no
 *   `file`/`line`/`column` and its id is position-free. The call site a
 *   developer opens is the `api-call` node's own position, which
 *   `./graph/query.ts` mints from the node.
 *
 * Deterministic: candidates are walked in the envelope's node order and the
 * route node for a file is chosen by lowest `id`, so a module with more than
 * one `api-route` node resolves to the same one on every run, and duplicate
 * ids — two call sites of the same URL in one function, an id an extractor
 * already claimed — are dropped here rather than reported by graph
 * construction.
 *
 * @param index The assembled envelope, before graph construction.
 * @returns The derived edges, or {@link EMPTY_EDGES} when nothing matched.
 */
function deriveRoutesToEdges(index: CodeIndex): readonly CodeEdge[] {
  const routes = routeMapFromIndex(index);
  if (routes.entries.length === 0) {
    return EMPTY_EDGES;
  }

  // Lowest id per file, so the choice does not depend on extractor order.
  const routeNodeByFile = new Map<string, CodeNode>();
  for (const node of index.nodes) {
    if (node.kind !== 'api-route') {
      continue;
    }
    const held = routeNodeByFile.get(node.file);
    if (held === undefined || node.id < held.id) {
      routeNodeByFile.set(node.file, node);
    }
  }

  if (routeNodeByFile.size === 0) {
    return EMPTY_EDGES;
  }

  const claimed = new Set<string>(index.edges.map((edge) => edge.id));
  const derived: CodeEdge[] = [];

  for (const node of index.nodes) {
    if (node.kind !== 'api-call' || node.data.dynamic || node.data.url === undefined) {
      continue;
    }

    const match = routes.resolve(node.data.url);
    if (match === undefined) {
      continue;
    }

    const routeNode = routeNodeByFile.get(match.entry.file);
    if (routeNode === undefined) {
      continue;
    }

    const id = makeEdgeId({ kind: 'routes-to', from: node.id, to: routeNode.id });
    if (claimed.has(id)) {
      continue;
    }
    claimed.add(id);
    derived.push({ id, kind: 'routes-to', from: node.id, to: routeNode.id });
  }

  return derived.length === 0 ? EMPTY_EDGES : derived;
}

/**
 * Runs preparation and extraction in sequence — the cache-free core both public
 * build entry points share.
 *
 * @param loaded The opened project.
 * @param options The resolved pipeline options.
 * @returns The build outcome, or the first stage's `Err`.
 */
async function runPipeline(
  loaded: LoadedProject,
  options: PipelineOptions,
): Promise<Result<BuildOutcome>> {
  const prepared = await prepareFiles(loaded, options);
  if (isErr(prepared)) {
    return prepared;
  }

  return extractAll(loaded, prepared.value, options);
}

/* -------------------------------------------------------------------------------------------------
 * Stage 3: the cache
 * ---------------------------------------------------------------------------------------------- */

/**
 * The cache key for one run: the single definition both of
 * {@link indexProject}'s cache paths use.
 *
 * It exists as a function rather than as two call sites because the two paths
 * reach the key from different places — one from the discovered path set
 * before any file is parsed, the other from an already-opened project's
 * prepared file set — and a key computed two ways is a key that can drift, at
 * which point a save and the next run's lookup stop agreeing and the cache
 * never hits. Everything the key covers is passed here and nothing is decided
 * here, so the two paths differ only in the values they hold.
 *
 * The extractor identities are contributed **in run order** and are not
 * sorted; `./cache.ts` explains why on `IndexCacheKeyInput.extractors`, and
 * {@link DEFAULT_EXTRACTORS} explains what the order decides.
 *
 * @param projectRoot The project root as `./project.ts` normalised it.
 * @param tsConfigFilePath The configuration in force, or `undefined`.
 * @param extractors The extractors this run will use, in order.
 * @param files The fingerprints of the file set the run covers.
 * @returns The key, 64 lowercase hexadecimal characters.
 */
function indexCacheKeyFor(
  projectRoot: string,
  tsConfigFilePath: string | undefined,
  extractors: readonly Extractor[],
  files: readonly FileFingerprint[],
): string {
  return computeIndexCacheKey({
    projectRoot,
    tsConfigFilePath,
    indexerVersion: INDEXER_VERSION,
    extractors: extractors.map((extractor) => extractor.id),
    files,
  });
}

/**
 * Reads a cache entry, or `undefined` for anything that is not a usable hit.
 *
 * `./cache.ts` already treats an absent, unparsable, stale or unsafe entry as a
 * miss and removes it, so the work here is the defensive half: an entry is only
 * accepted when it describes *this* project and *this* indexer version. The key
 * covers both, so a mismatch means a key collision or a hand-edited file rather
 * than ordinary staleness — either way, indexing the project is the right
 * answer and is cheaper than reasoning about how the entry got there.
 *
 * Never rejects: `IndexCache.load` only rejects for a malformed key, which
 * cannot happen for a key this module computed, and the guard is here so that a
 * future cache implementation cannot turn a failed optimisation into a failed
 * index.
 *
 * Log fields are counts, the key digest and booleans — never a project path,
 * for the reason `IndexCacheOptions.logger` gives.
 *
 * The project is identified by its **root** rather than by an opened handle,
 * because the whole point of consulting the cache is to find out whether a
 * handle has to be built at all: on the cache-first path there is no
 * `LoadedProject` yet, only the normalised root the discovery established — and
 * that is the one field the check below ever needed.
 *
 * @param cache The cache to read.
 * @param key The key from {@link computeIndexCacheKey}.
 * @param projectRoot The normalised project root the entry must describe.
 * @param logger Where the hit and miss lines go.
 * @returns The cached index, or `undefined`.
 */
async function loadFromCache(
  cache: IndexCache,
  key: string,
  projectRoot: string,
  logger: Logger,
): Promise<CodeIndex | undefined> {
  let entry: CodeIndex | undefined;

  try {
    entry = await cache.load(key);
  } catch (cause) {
    logger.warn('the code index cache could not be read; the project will be indexed', {
      reason: failureDetail(cause),
    });
    return undefined;
  }

  if (entry === undefined) {
    logger.debug('code index cache miss', { key });
    return undefined;
  }

  if (entry.projectRoot !== projectRoot || entry.indexerVersion !== INDEXER_VERSION) {
    logger.warn(
      'a cached code index described a different project or indexer version; ignoring it',
      {
        key,
        sameProjectRoot: entry.projectRoot === projectRoot,
        sameIndexerVersion: entry.indexerVersion === INDEXER_VERSION,
      },
    );
    return undefined;
  }

  logger.debug('code index cache hit', {
    key,
    files: entry.files.length,
    nodes: entry.nodes.length,
    edges: entry.edges.length,
  });

  return entry;
}

/**
 * The {@link IndexResult} of a cache hit: the stored index, the two views
 * rebuilt from it, and this run's statistics.
 *
 * One definition for both of {@link indexProject}'s cache paths, so a hit is
 * the same answer whether the caller supplied a project handle or not — and so
 * that the invariant this function embodies cannot be broken on one path only:
 * **nothing here needs a program.** The graph comes from the stored envelope,
 * the route map comes from the graph's index (`buildRouteMap` is the
 * compiler-backed variant and is not reachable from here), and
 * {@link IndexStats.extractorDurations} is {@link EMPTY_DURATIONS} because no
 * extractor ran.
 *
 * The returned index is `graph.toIndex()` rather than the stored envelope, for
 * the reason the module documentation gives: construction is where a duplicate
 * id, a dangling edge or an unknown kind is found, and a caller must hold what
 * construction validated rather than what was on disk.
 *
 * @param entry The index the cache returned.
 * @param preparation This run's own preparation outcome, for the diagnostics
 * and the skipped-file count.
 * @param startedAt The `performance.now()` reading the run began at.
 * @param logger Where the one `info` line goes.
 * @returns The result to hand back with `fromCache: true`.
 */
function cacheHitResult(
  entry: CodeIndex,
  preparation: PreparedFingerprints,
  startedAt: number,
  logger: Logger,
): IndexResult {
  const graph = CodeGraph.fromIndex(entry, { logger });
  const index = graph.toIndex();

  // This run's own preparation findings are not in the stored envelope — they
  // describe the state of the tree now — so they lead, followed by everything
  // the cached index and its construction reported.
  const diagnostics =
    preparation.diagnostics.length === 0
      ? graph.diagnostics
      : Object.freeze([...preparation.diagnostics, ...graph.diagnostics]);

  const stats: IndexStats = {
    fileCount: index.files.length,
    nodeCount: graph.size.nodes,
    edgeCount: graph.size.edges,
    durationMs: roundMs(performance.now() - startedAt, 3),
    extractorDurations: EMPTY_DURATIONS,
    skippedFiles: preparation.skippedFiles,
    diagnostics,
  };

  logger.info('code index served from cache', {
    files: stats.fileCount,
    nodes: stats.nodeCount,
    edges: stats.edgeCount,
    durationMs: stats.durationMs,
  });

  return { index, graph, routeMap: routeMapFromIndex(index), fromCache: true, stats };
}

/**
 * Writes an index to the cache, treating every failure as advisory.
 *
 * A truncated index is never written: it describes a prefix of the project, and
 * a later run that wanted the whole thing must not be served it. Otherwise the
 * write is attempted and its outcome is logged at `warn` and discarded —
 * failing to cache an index is not failing to build one, which is why
 * `IndexCache.save` returns a `Result` a caller may ignore deliberately rather
 * than throwing.
 *
 * @param cache The cache to write to.
 * @param key The key from {@link computeIndexCacheKey}.
 * @param index The index to store.
 * @param truncated Whether the `maxFiles` bound excluded part of the project.
 * @param logger Where a failed write is reported.
 */
async function saveToCache(
  cache: IndexCache,
  key: string,
  index: CodeIndex,
  truncated: boolean,
  logger: Logger,
): Promise<void> {
  if (truncated) {
    logger.debug('a truncated code index was not cached', { key });
    return;
  }

  try {
    const saved = await cache.save(key, index);
    if (isErr(saved)) {
      logger.warn('the code index could not be cached; it will be rebuilt next time', {
        key,
        reason: saved.error.code,
      });
    }
  } catch (cause) {
    logger.warn('the code index could not be cached; it will be rebuilt next time', {
      key,
      reason: failureDetail(cause),
    });
  }
}

/* -------------------------------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------------------------- */

/**
 * Fingerprints every indexable file of a project, sorted ascending by
 * project-relative path.
 *
 * The cache key's input, exposed because a caller that manages its own caching
 * — the local service deciding whether a session's index is still current, a
 * test proving that a changed file changes the key — needs the same list this
 * module would compute, from the same rules, without building an index.
 *
 * `hashContents` defaults to `false`: modification time and size are the normal
 * invalidation pair and cost one `stat` per file, while a digest costs a full
 * read of every file. Turn it on for a checkout whose modification times cannot
 * be trusted; see {@link IndexProjectOptions.hashContents}.
 *
 * A file whose metadata cannot be read — deleted since the project was opened,
 * unreadable, no longer a regular file — is **left out** rather than reported
 * as an error, which is the same decision the pipeline makes about the
 * indexable set. Total: it never rejects.
 *
 * @param loaded The opened project, from `openProject`.
 * @param options `hashContents` to include a content digest.
 * @returns One fingerprint per indexable file, sorted and frozen.
 *
 * @example
 * ```ts
 * const files = await computeFileFingerprints(loaded);
 * const key = computeIndexCacheKey({
 *   projectRoot: loaded.projectRoot,
 *   tsConfigFilePath: loaded.tsConfigFilePath,
 *   indexerVersion: INDEXER_VERSION,
 *   extractors: DEFAULT_EXTRACTORS.map((extractor) => extractor.id),
 *   files,
 * });
 * ```
 */
export async function computeFileFingerprints(
  loaded: LoadedProject,
  options?: { readonly hashContents?: boolean | undefined },
): Promise<readonly FileFingerprint[]> {
  const prepared = await prepareFiles(loaded, {
    extractors: DEFAULT_EXTRACTORS,
    hashContents: options?.hashContents ?? false,
    maxFiles: undefined,
    signal: undefined,
    logger: noopLogger,
  });

  // Preparation only fails for a cancelled run, and no signal was passed, so
  // this branch is unreachable; it is written out rather than asserted because
  // an unreachable `Err` is not worth throwing over in a total function.
  return isErr(prepared) ? EMPTY_FINGERPRINTS : prepared.value.fingerprints;
}

/**
 * Builds an index over an already-opened project, with no cache involved.
 *
 * The cache-free core, for a caller that owns the caching decision itself and
 * for tests that must be certain no entry on disk can influence a result. It is
 * exactly what {@link indexProject} runs on a miss, minus the key computation
 * and the write, so a behaviour proved here holds there.
 *
 * The returned index is `graph.toIndex()`: canonically ordered, de-duplicated,
 * with every dangling edge removed and every removal described in
 * {@link CodeIndex.diagnostics}. Build the graph from it with
 * `CodeGraph.fromIndex` when the caller needs one — construction is idempotent
 * over a canonical index.
 *
 * @param loaded The opened project, from `openProject`.
 * @param options The extractors, hashing, cancellation and logger; see
 * {@link BuildIndexOptions}.
 * @returns `Ok` with the index — including an empty one for a project with no
 * indexable file — or `Err` with code `CODE_INDEX_FAILED` when the run was
 * cancelled.
 *
 * @example
 * ```ts
 * const built = await buildIndex(loaded, { logger });
 * if (isOk(built)) {
 *   const graph = CodeGraph.fromIndex(built.value, { logger });
 * }
 * ```
 */
export async function buildIndex(
  loaded: LoadedProject,
  options?: BuildIndexOptions,
): Promise<Result<CodeIndex>> {
  const outcome = await runPipeline(loaded, {
    extractors: options?.extractors ?? DEFAULT_EXTRACTORS,
    hashContents: options?.hashContents ?? false,
    maxFiles: undefined,
    signal: options?.signal,
    logger: options?.logger ?? noopLogger,
  });

  return isErr(outcome) ? outcome : ok(outcome.value.index);
}

/**
 * Indexes a project: the whole pipeline, cache included.
 *
 * ## What it does, in order
 *
 * **With a cache and no supplied handle** — the local service's path — the
 * project's files are *discovered*: the tree is walked, every candidate is
 * screened, each survivor is fingerprinted, the key is computed and the cache
 * is consulted. All of that is `readdir`, `realpath` and `stat`; no ts-morph
 * program exists yet. A hit rebuilds the graph and the route map from the
 * stored index and returns with `fromCache: true`, having **constructed no
 * program, parsed nothing and run no extractor**. A miss opens the project —
 * handing over the discovery, so the tree is not walked twice — prepares the
 * file set from the program, runs every extractor over every prepared file,
 * assembles the envelope, builds the graph, derives the route map with the
 * compiler and writes the entry back under the key already computed.
 *
 * **With a supplied {@link IndexProjectOptions.loaded} handle** the program is
 * already paid for, so there is nothing to defer: the file set is prepared from
 * the handle, then the key is computed and looked up, then a hit or a build
 * follows exactly as above. **With no cache** the lookup is simply absent.
 *
 * Every path derives its key through the same function over the project's
 * identity, the extractor identities and the fingerprints of the file set it
 * holds, so an entry one path saved is an entry the next run finds from the
 * other.
 *
 * ## What it reports as a failure
 *
 * Two things only: the project could not be opened, or the run was cancelled
 * through {@link IndexProjectOptions.signal}. The first is propagated unchanged
 * — from `discoverProjectFiles` on the cache-first path and from `openProject`
 * otherwise, and the two report the same codes, hints and `details.reason`
 * values for the same bad path, so which one answered is not observable.
 * Everything else degrades — a file that cannot be read, an extractor that
 * throws, a cache that cannot be read or written, a project with nothing
 * indexable in it — and is reported in {@link IndexStats.diagnostics} rather
 * than as an error, because a partial graph is what an investigation can still
 * work with and an error is not (AAP 0.5.5).
 *
 * One consequence of consulting the cache first is worth stating: a
 * configuration file that *exists but cannot be parsed* is a failure of
 * building the program, so it is reported on a miss and not on a hit. A hit is
 * an answer about a tree whose files are unchanged since an index was built
 * from them, and the module's contract is that a hit ends the pipeline — the
 * key covers the configuration's path, and an entry can only have been written
 * by a run that parsed it successfully.
 *
 * ## Re-indexing
 *
 * A single changed file changes that file's fingerprint, which changes the key,
 * which is a miss and therefore a **full rebuild**. Incremental per-file reuse
 * is deliberately out of scope for this version: it would require the graph to
 * know which nodes and edges came from which file and to re-run the joins after
 * a swap, and a half-built mechanism for that is worse than the honest full
 * rebuild — so there is none, rather than a partial one to be discovered later.
 *
 * @param options What to index and how; see {@link IndexProjectOptions}.
 * @returns `Ok` with the index, the graph, the route map and the run's
 * statistics, or `Err` with a `DebuggenError`.
 *
 * @example
 * ```ts
 * const indexed = await indexProject({
 *   projectRoot,
 *   cache: createIndexCache({ cacheDir: resolveIndexCacheDir({ debuggenHome }) }),
 *   logger,
 * });
 * if (isErr(indexed)) {
 *   return indexed;
 * }
 * const { graph, routeMap, stats } = indexed.value;
 * ```
 */
export async function indexProject(options: IndexProjectOptions): Promise<Result<IndexResult>> {
  const startedAt = performance.now();
  const logger = options.logger ?? noopLogger;

  const pipeline: PipelineOptions = {
    extractors: options.extractors ?? DEFAULT_EXTRACTORS,
    hashContents: options.hashContents ?? false,
    maxFiles: options.maxFiles,
    signal: options.signal,
    logger,
  };

  const cache = options.cache === false || options.cache === undefined ? undefined : options.cache;

  // ── The cache-first path ──────────────────────────────────────────────────
  // A cache to consult and no project handle to reuse: the only situation in
  // which building the program *might* be avoidable, and therefore the only one
  // that discovers and fingerprints before it decides.
  if (cache !== undefined && options.loaded === undefined) {
    const discovered = discoverProjectFiles({
      projectRoot: options.projectRoot,
      tsConfigFilePath: options.tsConfigFilePath,
      logger,
    });
    if (isErr(discovered)) {
      // Propagated unchanged: `discoverProjectFiles` reports exactly the
      // failures `openProject` reports for the same inputs, so consulting the
      // cache first cannot change what a caller is told about a bad path.
      return discovered;
    }

    const fingerprinted = await prepareFingerprints(discovered.value, pipeline);
    if (isErr(fingerprinted)) {
      return fingerprinted;
    }

    const key = indexCacheKeyFor(
      discovered.value.projectRoot,
      discovered.value.tsConfigFilePath,
      pipeline.extractors,
      fingerprinted.value.fingerprints,
    );

    const entry = await loadFromCache(cache, key, discovered.value.projectRoot, logger);
    if (entry !== undefined) {
      // No `Project` has been constructed and no file has been parsed, which is
      // the whole point of this path.
      return ok(cacheHitResult(entry, fingerprinted.value, startedAt, logger));
    }

    // A miss: the program has to be built after all. The discovery already made
    // is handed to `openProject`, so the tree is walked once per run rather
    // than once per stage, and the entry is written under the key computed
    // above — the same key the next run's discovery will compute for an
    // unchanged tree.
    const opened = resolveProject(options, logger, discovered.value);
    if (isErr(opened)) {
      return opened;
    }

    const prepared = await prepareFiles(opened.value, pipeline);
    if (isErr(prepared)) {
      return prepared;
    }

    return buildAndReport(opened.value, prepared.value, pipeline, { cache, key }, startedAt);
  }

  // ── The program-first path ────────────────────────────────────────────────
  // Either the caller supplied the handle — the expensive stage is already paid
  // for, so there is nothing to save by deferring it — or there is no cache to
  // consult at all. Both keep the straight-line order: open, prepare, and
  // (where there is a cache) look up.
  const resolved = resolveProject(options, logger, undefined);
  if (isErr(resolved)) {
    return resolved;
  }
  const loaded = resolved.value;

  const prepared = await prepareFiles(loaded, pipeline);
  if (isErr(prepared)) {
    return prepared;
  }

  if (cache === undefined) {
    return buildAndReport(loaded, prepared.value, pipeline, undefined, startedAt);
  }

  // The same key definition as the cache-first path, over the file set this
  // path holds: `indexCacheKeyFor` is what keeps a save here reachable from a
  // lookup there.
  const key = indexCacheKeyFor(
    loaded.projectRoot,
    loaded.tsConfigFilePath,
    pipeline.extractors,
    prepared.value.fingerprints,
  );

  const entry = await loadFromCache(cache, key, loaded.projectRoot, logger);
  if (entry !== undefined) {
    return ok(cacheHitResult(entry, prepared.value, startedAt, logger));
  }

  return buildAndReport(loaded, prepared.value, pipeline, { cache, key }, startedAt);
}

/** Where a completed build should be written, when it should be written at all. */
interface CacheWrite {
  /** The cache to write to. */
  readonly cache: IndexCache;

  /** The key the entry belongs under — always one {@link indexCacheKeyFor} produced. */
  readonly key: string;
}

/**
 * Runs extraction over a prepared file set, derives the route map, writes the
 * cache entry and reports the run: the tail both of {@link indexProject}'s
 * paths finish through.
 *
 * One definition rather than one per path, so that a fresh index is the same
 * answer however the run reached it — the same `graph.toIndex()` envelope, the
 * same compiler-backed {@link buildRouteMap} (which is what gives a fresh route
 * map its per-method positions), the same best-effort save, the same statistics
 * and the same two log lines.
 *
 * @param loaded The opened project.
 * @param prepared The indexable set from {@link prepareFiles}.
 * @param pipeline The resolved pipeline options, including the logger.
 * @param write The cache and key to store the index under, or `undefined` when
 * the run is not caching.
 * @param startedAt The `performance.now()` reading the run began at.
 * @returns `Ok` with the built result, or extraction's `Err` for a cancelled
 * run.
 */
async function buildAndReport(
  loaded: LoadedProject,
  prepared: PreparedFiles,
  pipeline: PipelineOptions,
  write: CacheWrite | undefined,
  startedAt: number,
): Promise<Result<IndexResult>> {
  const { logger } = pipeline;

  const built = extractAll(loaded, prepared, pipeline);
  if (isErr(built)) {
    return built;
  }

  const { index, graph, extractorDurations, skippedFiles } = built.value;
  const routeMap = buildRouteMap(loaded, { logger });

  if (write !== undefined) {
    await saveToCache(write.cache, write.key, index, prepared.truncated, logger);
  }

  const stats: IndexStats = {
    fileCount: index.files.length,
    nodeCount: graph.size.nodes,
    edgeCount: graph.size.edges,
    durationMs: roundMs(performance.now() - startedAt, 3),
    extractorDurations,
    skippedFiles,
    diagnostics: graph.diagnostics,
  };

  logger.info('code index built', {
    files: stats.fileCount,
    nodes: stats.nodeCount,
    edges: stats.edgeCount,
    routes: routeMap.entries.length,
    skippedFiles: stats.skippedFiles,
    diagnostics: stats.diagnostics.length,
    durationMs: stats.durationMs,
  });

  logger.debug('code index extractor timings', stats.extractorDurations);

  return ok({ index, graph, routeMap, fromCache: false, stats });
}

/**
 * Uses the caller's project handle, or opens one.
 *
 * `openProject`'s `Err` is propagated unchanged rather than re-wrapped: it
 * already carries the code, the `details.reason` and the developer-facing hint
 * that say what is wrong with the path, and re-describing it here would only
 * lose that.
 *
 * @param options The caller's options.
 * @param logger The resolved logger, passed on to `openProject`.
 * @param discovered The discovery this run has already made, when it has made
 * one, so `openProject` does not repeat the directory walk. `openProject`
 * screens every path in it regardless and ignores a discovery that does not
 * describe the project being opened.
 * @returns The handle, or `openProject`'s failure.
 */
function resolveProject(
  options: IndexProjectOptions,
  logger: Logger,
  discovered: DiscoveredProject | undefined,
): Result<LoadedProject> {
  const { loaded } = options;

  if (loaded !== undefined) {
    if (loaded.projectRoot !== normalizePosix(toPosix(options.projectRoot))) {
      // Not a failure: a caller may legitimately hold a handle to a parent or a
      // sibling directory and know what it is doing. The handle's root is what
      // every path, every fingerprint and the cache key are computed from, so
      // the disagreement is worth one line and no more.
      logger.warn(
        'the supplied project handle describes a different root than the requested one; the handle is authoritative',
      );
    }

    return ok(loaded);
  }

  return openProject({
    projectRoot: options.projectRoot,
    tsConfigFilePath: options.tsConfigFilePath,
    discovered,
    logger,
  });
}

/* -------------------------------------------------------------------------------------------------
 * The lazy reference path
 * ---------------------------------------------------------------------------------------------- */

/**
 * The declarations of one name in one file, bounded.
 *
 * Found syntactically: every descendant that has a name, whose name matches,
 * contributes its name node where that node can be searched from and itself
 * otherwise. No type information is consulted to *find* the declarations —
 * only to search from them — which keeps a project whose dependencies are not
 * installed as answerable as one whose are.
 *
 * Bounded by {@link MAX_DECLARATION_CANDIDATES}, and the traversal stops as
 * soon as the bound is reached rather than walking the rest of the file.
 *
 * @param sourceFile The declaring file.
 * @param symbol The name to look for.
 * @returns The candidate declarations, in source order.
 */
function declarationsNamed(sourceFile: SourceFile, symbol: string): readonly Node[] {
  const found: Node[] = [];

  sourceFile.forEachDescendant((node, traversal) => {
    if (found.length >= MAX_DECLARATION_CANDIDATES) {
      traversal.stop();
      return;
    }

    if (!Node.hasName(node) || node.getName() !== symbol) {
      return;
    }

    const nameNode = node.getNameNode();
    found.push(Node.isReferenceFindable(nameNode) ? nameNode : node);
  });

  return found;
}

/**
 * The project-relative location of one reference site, or `undefined` when it
 * cannot be expressed as one.
 *
 * Minted as a `'code-graph'` location with this package's default confidence,
 * so a caller can hand it straight to the source-open path; `./graph/query.ts`
 * re-anchors it to the enclosing declaration when it needs a caller rather than
 * a position, which is a judgement that belongs there and not here.
 *
 * @param loaded The opened project, for the path reduction.
 * @param reference The referencing node.
 * @param symbol The symbol the lookup was about.
 * @returns The location, or `undefined` for a reference outside the project.
 */
function locationOf(
  loaded: LoadedProject,
  reference: Node,
  symbol: string,
): SourceLocation | undefined {
  const sourceFile = reference.getSourceFile();
  const file = loaded.projectRelative(toPosix(sourceFile.getFilePath()));

  if (file === undefined || !isSafeRelativePath(file)) {
    return undefined;
  }

  const { line, column } = sourceFile.getLineAndColumnAtPos(reference.getStart());

  return {
    file,
    line,
    column,
    symbol,
    resolvedBy: 'code-graph',
    confidence: DEFAULT_RESOLUTION_CONFIDENCE['code-graph'],
  };
}

/**
 * Canonical ordering for reference sites: by file, then line, then column.
 *
 * @param left The first location.
 * @param right The second location.
 * @returns A negative number, zero, or a positive number.
 */
function compareLocations(left: SourceLocation, right: SourceLocation): number {
  const byFile = compareStrings(left.file, right.file);
  if (byFile !== 0) {
    return byFile;
  }

  return left.line === right.line ? left.column - right.column : left.line - right.line;
}

/**
 * Answers one reference lookup against the opened project.
 *
 * Total by contract: a symbol that is not there, a file that is not part of the
 * project, a declaration the language service cannot search from, or a failure
 * inside the search itself all produce an empty list. An unanswerable lookup
 * must not fail an investigation — `./graph/query.ts` keeps its static answer
 * when this returns nothing, which is a smaller loss than a failed stage.
 *
 * @param loaded The opened project.
 * @param files The project-relative path index built by the resolver.
 * @param query The declaring file and symbol name.
 * @returns The reference sites, de-duplicated by position, sorted and frozen.
 */
function resolveReferences(
  loaded: LoadedProject,
  files: ReadonlyMap<string, SourceFile>,
  query: ReferenceQuery,
): readonly SourceLocation[] {
  if (query.file.length === 0 || query.symbol.length === 0) {
    return EMPTY_LOCATIONS;
  }

  const sourceFile = files.get(query.file);
  if (sourceFile === undefined) {
    return EMPTY_LOCATIONS;
  }

  const collected = new Map<string, SourceLocation>();

  try {
    for (const declaration of declarationsNamed(sourceFile, query.symbol)) {
      if (collected.size >= MAX_REFERENCE_SITES) {
        break;
      }

      if (!Node.isReferenceFindable(declaration)) {
        continue;
      }

      for (const reference of declaration.findReferencesAsNodes()) {
        if (collected.size >= MAX_REFERENCE_SITES) {
          break;
        }

        const location = locationOf(loaded, reference, query.symbol);
        if (location === undefined) {
          continue;
        }

        collected.set(
          `${location.file}${KEY_SEPARATOR}${String(location.line)}${KEY_SEPARATOR}${String(location.column)}`,
          location,
        );
      }
    }
  } catch {
    // The language service failed on this symbol — a partially typed project,
    // a declaration it cannot resolve. Reporting nothing is the contract; the
    // cause is deliberately not logged because this function has no logger and
    // a thrown message may carry source text.
    return EMPTY_LOCATIONS;
  }

  if (collected.size === 0) {
    return EMPTY_LOCATIONS;
  }

  return Object.freeze([...collected.values()].sort(compareLocations));
}

/**
 * Creates the on-demand reference lookup over an opened project.
 *
 * ## Why this is not part of the index
 *
 * Finding every reference to a symbol means asking the type checker, and the
 * checker is the expensive part of ts-morph: running it for every declaration
 * of a real project at index time would dominate the entire indexing cost, for
 * answers all but a handful of lookups never need. So **the build never calls
 * it** — the static `calls` and `references` edges the extractors record while
 * they are already walking the tree are the cheap primary signal — and this
 * resolver is the deepening `./graph/query.ts`'s `whoCalls` reaches for when
 * those edges are inconclusive, one `(file, symbol)` at a time, only when a
 * caller actually asked.
 *
 * Nothing happens when the resolver is created: the project-relative path index
 * is built on the first lookup and the language service is not touched until
 * then, so holding a resolver that is never queried costs one object.
 *
 * ## Memoisation
 *
 * Answers are memoised per `(file, symbol)` for the resolver's lifetime,
 * including empty ones — "this symbol has no references" is as expensive to
 * discover as the opposite and just as stable. The memo is therefore a
 * *snapshot*: a resolver outlives no edit of the project it was built over, and
 * a caller that has reloaded the project must create a new one. That is the
 * same lifetime the `CodeGraph` it accompanies has.
 *
 * @param loaded The opened project to search, from `openProject`.
 * @returns The resolver, frozen.
 *
 * @example
 * ```ts
 * const queries = createCodeQueries(graph, {
 *   loaded,
 *   references: createReferenceResolver(loaded),
 *   logger,
 * });
 * ```
 */
export function createReferenceResolver(loaded: LoadedProject): ReferenceResolver {
  const memo = new Map<string, readonly SourceLocation[]>();
  let byFile: Map<string, SourceFile> | undefined;

  /**
   * The project-relative path index, built once on first use.
   *
   * Cheap — it reads each file's path and nothing else — but pointless for a
   * resolver that is never queried, which is why it is not built in the
   * factory.
   */
  const filesByPath = (): ReadonlyMap<string, SourceFile> => {
    if (byFile === undefined) {
      const index = new Map<string, SourceFile>();

      for (const sourceFile of loaded.sourceFiles()) {
        const file = loaded.projectRelative(toPosix(sourceFile.getFilePath()));
        if (file !== undefined) {
          index.set(file, sourceFile);
        }
      }

      byFile = index;
    }

    return byFile;
  };

  return Object.freeze({
    referencesTo(query: ReferenceQuery): readonly SourceLocation[] {
      const key = `${query.file}${KEY_SEPARATOR}${query.symbol}`;
      const memoised = memo.get(key);

      if (memoised !== undefined) {
        return memoised;
      }

      const found = resolveReferences(loaded, filesByPath(), query);
      memo.set(key, found);

      return found;
    },
  });
}
