/**
 * The deterministic fallback panel of the coordination service.
 *
 * AAP 0.5.3: "a rejected panel falls back to a deterministic panel assembled
 * from the capture aggregates … with `meta.fallback = true`, which `PanelHost`
 * renders under a visible 'fallback view' banner". AAP 0.5.5 adds the
 * structural guarantee this module exists for: a failure is never presented as
 * a successful analysis — and, equally, never as a dead end. A fallback panel
 * is a legitimate answer built from real captured data that is honest about
 * its provenance, and the session still reaches `generated` on this path once
 * a validated analysis and this validated panel both exist.
 *
 * ## One pipeline, not a second one
 *
 * Nothing here hand-writes a `PanelSpec`. The builder assembles an *authoring*
 * input ({@link buildFallbackInput}) and sends it through the very sequence a
 * model's output goes through:
 *
 * 1. `parsePanelSpecInput` — the authoring schema the model is measured against;
 * 2. `normalizePanel` — the deterministic normaliser, with
 *    `NormalizeContext.fallback = true`, which is the **only** way `meta.fallback`
 *    is set (the normaliser owns `meta`, and omits it unless told otherwise);
 * 3. `PanelValidator.validateSpec` — the internal schema and whole-document
 *    rules from `./validate.ts`.
 *
 * The fallback therefore obeys every rule the node catalog and the schemas
 * impose, by construction. Output that fails any of the three gates is a
 * product defect in this module: it is logged at `error` with its issue paths
 * and returned as a typed `Err` — an unvalidated specification never leaves.
 *
 * ## Evidence-gated, never assumed
 *
 * {@link selectFallbackNodes} decides which catalogued views the capture can
 * actually fill, from the `CaptureSummary`'s own counts and sections: a render
 * table only when renders were captured, a query table only when statements
 * were, a timeline only when the summary names a real trace, and so on. The
 * data source every node reads is taken from its `PANEL_NODE_CATALOG` entry and
 * checked with `isSourceAllowedForNode`, never guessed. Because the selection is
 * driven by the capture's shape alone — no question text, no project knowledge,
 * no demo identifier (AAP 0.5.4) — it generalises to any project.
 *
 * ## The integrity rule
 *
 * A string can never become a `Fact`, and a fallback panel invents nothing. The
 * panel's `summary.observed` and `summary.likelyCauses` are copied by
 * `normalizePanel` from the validated `AnalysisResult` handed in, unchanged;
 * this module supplies only the non-evidentiary headline and the layout. It
 * deliberately does not use the fact candidates of `../analysis/facts.ts`: a
 * deterministic *panel* is legitimate, a deterministic *finding* would be
 * fabrication.
 *
 * ## Privacy: logs and errors carry shape, never content
 *
 * Every log field and every error detail built here is fixed text, a count, a
 * closed-vocabulary code, a catalogued node type or a dotted issue path. No
 * fact statement, trace id, attribute value or rejected specification is ever
 * logged or returned (AAP 0.5.2).
 *
 * ## Scope
 *
 * This module neither reads nor writes the store and broadcasts nothing:
 * `./generate.ts` supplies `panelVersion`/`supersedes` from the panels
 * repository and owns persistence and the `panel.generated` broadcast.
 *
 * @example
 * ```ts
 * const fallback = createFallbackPanelBuilder({ validator, captures: summarizer, logger });
 * const built = await fallback.build({
 *   sessionId,
 *   captureId,
 *   analysis,
 *   panelVersion,
 *   ...(previous === undefined ? {} : { supersedes: previous.id }),
 *   reason: rejection.class,
 * });
 * if (built.ok) {
 *   // built.value.meta?.fallback === true — store it and broadcast it.
 * }
 * ```
 *
 * @module
 */

import {
  catalogEntryFor,
  isSourceAllowedForNode,
  normalizePanel,
  parsePanelSpecInput,
} from '@debuggen/panel-schema';
import type {
  DataQuery,
  DataQuerySort,
  DataQuerySource,
  NormalizeAnalysis,
  NormalizeContext,
  PanelNodeInput,
  PanelSpec,
  PanelSpecInput,
  QueryBackedNodeType,
} from '@debuggen/panel-schema';
import type { AnalysisResult } from '@debuggen/protocol';
import {
  DebuggenError,
  assertNever,
  err,
  isTraceId,
  newPanelId,
  noopLogger,
  ok,
} from '@debuggen/shared';
import type {
  CaptureId,
  DebuggenErrorCode,
  LogFields,
  Logger,
  PanelId,
  Result,
  SessionId,
} from '@debuggen/shared';
import { DEFAULT_TOP_N, METRIC_IDS } from '@debuggen/telemetry';
import type { CaptureSummary, MetricId } from '@debuggen/telemetry';

import type { AnalysisSummarizer } from '../analysis/summarize.js';
import { sessionLogger, subsystemLogger } from '../logging.js';
import {
  PANEL_FAILURE_CLASSES,
  PANEL_FAILURE_POLICY,
  classifyFailure,
  isPanelFailureClass,
} from './validate.js';
import type {
  CaptureSummaryPort,
  PanelFailureClass,
  PanelRejectionIssue,
  PanelValidationRejection,
  PanelValidator,
} from './validate.js';

/* -------------------------------------------------------------------------------------------------
 * Vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * The developer-facing sentence of AAP 0.5.5, verbatim: what both user
 * interfaces show above a panel whose `meta.fallback` is `true`.
 *
 * Exported so no other module re-types it. It is product copy about the
 * panel's provenance, never a statement about the capture, which is what keeps
 * it out of the summary's fact register.
 */
export const FALLBACK_BANNER_MESSAGE =
  'Generated panel failed validation; showing a fallback view built from captured data.';

/**
 * The title of every fallback panel.
 *
 * Capture-neutral on purpose: it is not derived from the session question, it
 * names no component, route or function of any project, and it makes no claim
 * about what the capture shows.
 */
export const FALLBACK_TITLE = 'Captured evidence';

/**
 * Why a fallback panel was built: exactly the failure taxonomy of
 * `./validate.ts`, re-exported rather than restated, so the reason a caller
 * passes and the class the validator reports can never drift apart.
 */
export const FALLBACK_REASONS = PANEL_FAILURE_CLASSES;

/** One member of {@link FALLBACK_REASONS}; an alias of `PanelFailureClass`. */
export type FallbackReason = PanelFailureClass;

/**
 * Whether a value names a {@link FallbackReason}: for a reason read back from a
 * stored row, a transport frame or an untyped caller.
 *
 * @param value Any value believed to name a fallback reason.
 * @returns `true` when `value` is a member of {@link FALLBACK_REASONS}.
 */
export function isFallbackReason(value: unknown): value is FallbackReason {
  return isPanelFailureClass(value);
}

/**
 * The generic heading of each section a fallback panel may contain, keyed by
 * the concern the section covers, in the order sections appear.
 *
 * Every heading names a kind of evidence, never a project's code: the same
 * words are right for any application a capture was taken from.
 */
export const FALLBACK_SECTION_TITLES = Object.freeze({
  overview: 'Capture overview',
  trace: 'Longest trace',
  operations: 'Slowest operations',
  renders: 'Component renders',
  requests: 'Network requests',
  queries: 'Database queries',
  state: 'State transitions',
  events: 'Captured events',
} as const);

/** One section of a fallback panel; a key of {@link FALLBACK_SECTION_TITLES}. */
export type FallbackSectionKey = keyof typeof FALLBACK_SECTION_TITLES;

/**
 * The two non-evidentiary headlines a fallback panel may carry, chosen only by
 * whether the validated analysis established any findings.
 *
 * Neither describes the capture: each says where the panel's parts came from.
 * `normalizePanel` stores the chosen one as `summary.headline`, the one field of
 * a panel summary that holds prose and can never hold a fact.
 */
export const FALLBACK_HEADLINES = Object.freeze({
  withFindings:
    'The observed facts and likely causes come from the validated analysis of this capture; the views were assembled directly from the captured data.',
  withoutFindings:
    'The validated analysis established no findings for this capture; the views were assembled directly from the captured data.',
} as const);

/**
 * The catalogued node types a fallback panel may draw.
 *
 * An `Extract` over the catalog's own query-backed vocabulary rather than a
 * free-standing list, so a node type renamed or removed from the catalog fails
 * to compile here instead of leaving the fallback emitting a node nothing can
 * render.
 */
export type FallbackNodeType = Extract<
  QueryBackedNodeType,
  | 'metricCards'
  | 'timeline'
  | 'table'
  | 'renderTable'
  | 'requestTable'
  | 'queryTable'
  | 'stateTransitions'
  | 'eventLog'
>;

/**
 * The stages at which {@link FallbackPanelBuilder.build} can fail, as a closed
 * tuple recorded in each error's `details.fallbackStage`.
 *
 * - `request` — the call itself was malformed (an unrecognised reason).
 * - `scope` — the summary or analysis belongs to another session or capture.
 * - `summary` — no capture summary was supplied and none could be loaded.
 * - `panel-id` — the injected id factory failed.
 * - `authoring-schema`, `normalize`, `internal-schema` — this module's own
 *   output failed one of the gates a model's output is held to: a product
 *   defect, logged at `error`.
 * - `unexpected` — something threw that no stage anticipated; also a defect.
 */
export const FALLBACK_BUILD_STAGES = Object.freeze([
  'request',
  'scope',
  'summary',
  'panel-id',
  'authoring-schema',
  'normalize',
  'internal-schema',
  'unexpected',
] as const);

/** One member of {@link FALLBACK_BUILD_STAGES}. */
export type FallbackBuildStage = (typeof FALLBACK_BUILD_STAGES)[number];

/* -------------------------------------------------------------------------------------------------
 * Evidence-driven node selection
 * ---------------------------------------------------------------------------------------------- */

/** One view the capture's evidence supports, with the data request it will carry. */
export interface FallbackNodeChoice {
  /** The catalogued node type to draw. */
  readonly type: FallbackNodeType;
  /** The section the node is placed in. */
  readonly section: FallbackSectionKey;
  /**
   * The node's data request. Its `source` is always one the node type's catalog
   * entry allows; a trace filter, where present, names a trace the summary
   * holds.
   */
  readonly query: DataQuery;
}

/** The outcome of {@link selectFallbackNodes}: which views to draw, in order. */
export interface FallbackSelection {
  /** The capture the selection was made for. */
  readonly captureId: CaptureId;
  /** Whether the capture held no events at all. */
  readonly empty: boolean;
  /** The supported views, in the order their sections appear. */
  readonly nodes: readonly FallbackNodeChoice[];
}

/** The query fields other than `source`, as a node may refine its request. */
type QueryRefinement = Omit<DataQuery, 'source'>;

/** The sort of the generic "slowest operations" ranking. */
const SLOWEST_FIRST: DataQuerySort = 'duration_desc';

/**
 * The source a fallback node reads: the preferred one when the node type's
 * catalog entry allows it, otherwise the entry's implied default, otherwise the
 * source the entry lists first (the one the node was designed around).
 *
 * `undefined` when the catalog offers the node type no readable source at all,
 * in which case the node is left out rather than drawn over nothing.
 */
function catalogSourceFor(
  type: FallbackNodeType,
  preferred?: DataQuerySource,
): DataQuerySource | undefined {
  if (preferred !== undefined && isSourceAllowedForNode(type, preferred)) {
    return preferred;
  }
  const entry = catalogEntryFor(type);
  const source = entry.defaultSource ?? entry.sources[0];
  return source !== undefined && isSourceAllowedForNode(type, source) ? source : undefined;
}

/**
 * A choice for one node, or `undefined` when its catalog entry offers no
 * readable source.
 */
function choiceFor(
  type: FallbackNodeType,
  section: FallbackSectionKey,
  options: { readonly preferredSource?: DataQuerySource; readonly refine?: QueryRefinement } = {},
): FallbackNodeChoice | undefined {
  const source = catalogSourceFor(type, options.preferredSource);
  if (source === undefined) {
    return undefined;
  }
  const query: DataQuery = { source, ...(options.refine ?? {}) };
  return Object.freeze({ type, section, query: Object.freeze(query) });
}

/**
 * A count read defensively: a positive finite number, otherwise zero. A
 * summary read back from the store is typed but not trusted to be well formed.
 */
function positiveCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * How many captured events are of the kinds a node type draws, per the
 * `telemetryKinds` of its catalog entry — the catalog owns which kinds a view
 * is about, so no kind list is restated here.
 */
function kindTally(summary: CaptureSummary, type: FallbackNodeType): number {
  let total = 0;
  for (const kind of catalogEntryFor(type).telemetryKinds) {
    total += positiveCount(summary.kindCounts[kind]);
  }
  return total;
}

/**
 * Whether the capture holds evidence for a per-concern view: its bounded
 * summary section has rows, or events of the kinds the view draws were
 * counted (a section can be empty because it was clipped to zero rows).
 */
function hasEvidence(
  section: readonly unknown[],
  summary: CaptureSummary,
  type: FallbackNodeType,
): boolean {
  return section.length > 0 || kindTally(summary, type) > 0;
}

/**
 * Decides which catalogued views a capture's evidence supports, in the order a
 * fallback panel shows them. Pure: no I/O, no clock, no randomness and no
 * logging, so equal summaries produce deep-equal selections.
 *
 * Driven by the summary's own counts and sections only:
 *
 * - **always** a `metricCards` overview — every summary carries one value per
 *   metric id, some possibly unavailable;
 * - for an **empty capture** (no events) nothing else, so the panel is a single
 *   valid section rather than a blank layout — AAP 0.5.5 handles "no telemetry
 *   was captured" on its own path before any panel is generated;
 * - a `timeline` only when the summary names a real trace (`primaryTraceId`),
 *   filtered to that trace — never to a placeholder;
 * - a `table` over spans, slowest first and bounded to the summary's top-N:
 *   the generic "slowest operations" ranking;
 * - a `renderTable`, `requestTable` or `queryTable` only when renders, requests
 *   or database statements were captured;
 * - a `stateTransitions` view only when state transitions were captured;
 * - an `eventLog` whenever the capture holds any events.
 *
 * @param summary The capture's summary.
 * @returns The frozen selection.
 */
export function selectFallbackNodes(summary: CaptureSummary): FallbackSelection {
  const nodes: FallbackNodeChoice[] = [];
  const add = (choice: FallbackNodeChoice | undefined): void => {
    if (choice !== undefined) {
      nodes.push(choice);
    }
  };

  const empty = positiveCount(summary.eventCount) === 0;

  add(choiceFor('metricCards', 'overview'));

  if (!empty) {
    const traceId = summary.primaryTraceId;
    if (traceId !== undefined && isTraceId(traceId)) {
      add(
        choiceFor('timeline', 'trace', {
          preferredSource: 'trace',
          refine: { filter: { traceId } },
        }),
      );
    }

    add(
      choiceFor('table', 'operations', {
        preferredSource: 'spans',
        refine: { sort: SLOWEST_FIRST, limit: DEFAULT_TOP_N },
      }),
    );

    if (hasEvidence(summary.topRenders, summary, 'renderTable')) {
      add(choiceFor('renderTable', 'renders'));
    }
    if (hasEvidence(summary.topRequests, summary, 'requestTable')) {
      add(choiceFor('requestTable', 'requests'));
    }
    if (hasEvidence(summary.topQueries, summary, 'queryTable')) {
      add(choiceFor('queryTable', 'queries'));
    }
    if (kindTally(summary, 'stateTransitions') > 0) {
      add(choiceFor('stateTransitions', 'state'));
    }

    add(choiceFor('eventLog', 'events'));
  }

  return Object.freeze({
    captureId: summary.captureId,
    empty,
    nodes: Object.freeze(nodes),
  });
}

/* -------------------------------------------------------------------------------------------------
 * Authoring input assembly
 * ---------------------------------------------------------------------------------------------- */

/** Input of {@link buildFallbackInput}. */
export interface FallbackInputRequest {
  /** The views to draw, from {@link selectFallbackNodes}. */
  readonly selection: FallbackSelection;
  /**
   * The validated analysis. Read only to choose between the two fixed
   * {@link FALLBACK_HEADLINES}; its findings reach the panel through
   * `normalizePanel`, never through the authored input.
   */
  readonly analysis: NormalizeAnalysis;
  /** The capture's summary: which metric values it could measure. */
  readonly summary: CaptureSummary;
}

/**
 * The metric ids a fallback overview shows: every id the capture could
 * measure, in `METRIC_IDS` order. When the summary reports none measurable, the
 * whole vocabulary — each tile then renders as unavailable, which is the honest
 * picture of such a capture.
 *
 * @param summary The capture's summary.
 * @returns At least one id, each a member of `METRIC_IDS`, without repeats.
 */
export function fallbackMetricIds(summary: CaptureSummary): readonly MetricId[] {
  const measured = new Set<MetricId>();
  for (const metric of summary.metrics) {
    if (metric.available) {
      measured.add(metric.id);
    }
  }
  const ids = METRIC_IDS.filter((id) => measured.has(id));
  return Object.freeze(ids.length > 0 ? ids : [...METRIC_IDS]);
}

/** The headline for an analysis: which of the two fixed sentences applies. */
function headlineFor(analysis: NormalizeAnalysis): string {
  return analysis.observed.length > 0 || analysis.likelyCauses.length > 0
    ? FALLBACK_HEADLINES.withFindings
    : FALLBACK_HEADLINES.withoutFindings;
}

/**
 * The authored form of one selected view, in the nested spelling: the data
 * request as the node's `query` object.
 *
 * An exhaustive switch closed by `assertNever`, so a node type added to
 * {@link FallbackNodeType} fails to compile here until its authored form is
 * written.
 */
function nodeInputFor(choice: FallbackNodeChoice, metrics: readonly MetricId[]): PanelNodeInput {
  const query: DataQuery = { ...choice.query };
  const type = choice.type;
  switch (type) {
    case 'metricCards':
      // `metrics` is the node's own option, never part of its query (AAP 0.2.3).
      return { type, query, metrics: [...metrics] };
    case 'timeline':
      return { type, query };
    case 'table':
      return { type, query };
    case 'renderTable':
      return { type, query };
    case 'requestTable':
      return { type, query };
    case 'queryTable':
      return { type, query };
    case 'stateTransitions':
      return { type, query };
    case 'eventLog':
      return { type, query };
    default:
      return assertNever(type, 'Unhandled fallback node type');
  }
}

/**
 * Assembles the authoring input of a fallback panel: {@link FALLBACK_TITLE}, a
 * fixed non-evidentiary headline, and one titled `section` per selected view.
 *
 * Pure and deterministic. The result is a `PanelSpecInput` — the shape a
 * model's structured output is parsed into — so it goes through the same
 * normaliser and validators as a generated panel. It carries no ids, versions
 * or metadata: those are the normaliser's to derive from its context.
 *
 * @param request The selection, the validated analysis and the capture summary.
 * @returns The authored panel.
 */
export function buildFallbackInput(request: FallbackInputRequest): PanelSpecInput {
  const metrics = fallbackMetricIds(request.summary);
  const layout: PanelNodeInput[] = request.selection.nodes.map((choice): PanelNodeInput => ({
    type: 'section',
    title: FALLBACK_SECTION_TITLES[choice.section],
    children: [nodeInputFor(choice, metrics)],
  }));
  return {
    title: FALLBACK_TITLE,
    summary: headlineFor(request.analysis),
    layout,
  };
}

/* -------------------------------------------------------------------------------------------------
 * The builder
 * ---------------------------------------------------------------------------------------------- */

/** Injected dependencies of {@link createFallbackPanelBuilder}. */
export interface FallbackPanelBuilderDeps {
  /**
   * The panel validation boundary of `./validate.ts`. The fallback's own output
   * passes the same internal-schema gate a generated panel does.
   */
  readonly validator: Pick<PanelValidator, 'validateSpec'>;
  /**
   * Loads a capture's summary when a call does not supply one: the service's
   * `AnalysisSummarizer`, which owns the stored-first, computed-otherwise rule.
   */
  readonly captures?: CaptureSummaryPort | undefined;
  /** Logger; records are bound to the `panels` subsystem, the session and the capture. */
  readonly logger?: Logger | undefined;
  /** Mints the panel id. Defaults to `newPanelId`; injected for deterministic tests. */
  readonly newId?: (() => PanelId) | undefined;
}

/** Input of {@link FallbackPanelBuilder.build}. */
export interface FallbackBuildRequest {
  /** The session the panel is built for. */
  readonly sessionId: SessionId;
  /** The capture the panel shows. */
  readonly captureId: CaptureId;
  /**
   * The validated analysis of that capture: the sole source of the panel's
   * observed facts and likely causes, copied unchanged.
   */
  readonly analysis: AnalysisResult;
  /** The capture's summary; loaded through {@link FallbackPanelBuilderDeps.captures} when absent. */
  readonly summary?: CaptureSummary | undefined;
  /** Which generation of the session's panel this is, from `PanelsRepo.nextPanelVersion`. */
  readonly panelVersion: number;
  /** The id of the panel this one replaces, from `PanelsRepo.getLatestPanel`. */
  readonly supersedes?: PanelId | undefined;
  /**
   * Why the generated panel was rejected. Logged and recorded in error details;
   * it never becomes part of the panel's findings.
   */
  readonly reason: FallbackReason;
}

/** The deterministic fallback panel builder. See the module documentation. */
export interface FallbackPanelBuilder {
  /**
   * Builds, normalises and validates the fallback panel for one capture.
   *
   * Never throws. Resolves to `ok` with a validated specification whose
   * `meta.fallback` is `true`, or to `err` with a `DebuggenError` whose code is
   * from the closed vocabulary and whose `details.fallbackStage` names the
   * failing {@link FallbackBuildStage}.
   *
   * @param request The session, capture, analysis, versioning and reason.
   * @returns The validated fallback panel, or why none could be built.
   */
  build(request: FallbackBuildRequest): Promise<Result<PanelSpec, DebuggenError>>;
}

/** The `subsystem` binding of this module's logger, shared with `./validate.ts`. */
const SUBSYSTEM = 'panels';

/** How many issue paths or codes one log record or error names. */
const MAX_REPORTED_ISSUES = 20;

/** The `details` and log key recording the failing build stage. */
const STAGE_DETAIL_KEY = 'fallbackStage';

/**
 * The `details` and log key recording why the fallback was requested.
 *
 * Deliberately not `reason` or `failureClass`: `classifyFailure` in
 * `./validate.ts` reads those two keys as the structured-output loop's
 * rejection reason and as a failure-class marker, and a fallback reason such as
 * `provider` or `normalize` stored under either would make an error of this
 * module be re-classified as the failure it was built in response to.
 */
const REASON_DETAIL_KEY = 'fallbackReason';

/** The next step for a defect in this module's own output. */
const PRODUCT_DEFECT_HINT =
  'This is a product defect in the fallback panel builder, not a model failure: the capture is intact and no panel was shown from this attempt. The service log records the failing stage and issue paths.';

/** The next step when no summary was supplied and no port was injected. */
const MISSING_SUMMARY_PORT_HINT =
  'Pass the capture summary to the fallback builder, or inject `captures` (a CaptureSummaryPort, such as the service AnalysisSummarizer) into createFallbackPanelBuilder.';

/** The next step when the capture summary could not be loaded. */
const SUMMARY_UNAVAILABLE_HINT =
  'Check that the capture belongs to this session and that the session store is readable, then regenerate the panel.';

/** The next step when the documents handed in describe another session or capture. */
const SCOPE_MISMATCH_HINT =
  'A fallback panel is built from the summary and analysis of the capture it shows. Pass the session and capture ids those documents carry; this is a defect in the caller.';

/** The next step for a call naming a reason outside the failure taxonomy. */
const INVALID_REASON_HINT =
  'Pass one of the failure classes of panels/validate.ts, normally the `class` of the rejection that caused the fallback.';

/** The next step when the injected panel-id factory failed. */
const PANEL_ID_HINT =
  'The panel id factory failed, so no panel could be identified. This is a defect in the service wiring; regenerate the panel once it is fixed.';

/**
 * The three gates this module's own output is held to. Their names are the
 * failure classes of `./validate.ts` for the same three steps.
 */
type OwnOutputGate = Extract<
  FallbackBuildStage,
  'authoring-schema' | 'normalize' | 'internal-schema'
>;

/** A fixed message per own-output gate: what failed, never what was in it. */
const GATE_MESSAGES: Readonly<Record<OwnOutputGate, string>> = Object.freeze({
  'authoring-schema':
    'The deterministic fallback panel failed the panel authoring schema, so it was not shown.',
  normalize:
    'The panel normaliser failed on the deterministic fallback panel, so it was not shown.',
  'internal-schema':
    'The deterministic fallback panel failed internal panel validation, so it was not shown.',
});

/** What one own-output gate reported: its issues by path and code, and the typed error behind them. */
interface GateFailure {
  /** Every problem the gate found, by dotted path and code only. */
  readonly issues: readonly PanelRejectionIssue[];
  /** The typed error the gate raised, kept as the `cause` of the returned error. */
  readonly cause: DebuggenError;
}

/** The gate failure a validator rejection describes. */
function gateFailureOf(rejection: PanelValidationRejection): GateFailure {
  return { issues: rejection.issues ?? [], cause: rejection.error };
}

/** The node types a selection holds, in order: safe to log, being catalog vocabulary. */
function nodeTypesOf(selection: FallbackSelection): readonly FallbackNodeType[] {
  return selection.nodes.map((choice) => choice.type);
}

/** Issue paths and codes, bounded, for a log record or error details. */
function issueFields(issues: readonly PanelRejectionIssue[]): LogFields {
  return {
    issueCount: issues.length,
    issuePaths: issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => issue.path),
    issueCodes: [...new Set(issues.map((issue) => issue.code))].slice(0, MAX_REPORTED_ISSUES),
  };
}

/**
 * The fields of the request that name a different session or capture than the
 * documents handed in, by field name only — never by value.
 */
function scopeMismatches(request: FallbackBuildRequest, summary: CaptureSummary): string[] {
  const mismatches: string[] = [];
  if (summary.captureId !== request.captureId) {
    mismatches.push('summary.captureId');
  }
  if (summary.sessionId !== undefined && summary.sessionId !== request.sessionId) {
    mismatches.push('summary.sessionId');
  }
  if (request.analysis.captureId !== request.captureId) {
    mismatches.push('analysis.captureId');
  }
  if (request.analysis.sessionId !== request.sessionId) {
    mismatches.push('analysis.sessionId');
  }
  return mismatches;
}

/** How a failed build is reported: once to the log and once to the caller, from the same facts. */
interface BuildFailure {
  /** The stage that failed. */
  readonly stage: FallbackBuildStage;
  /** The closed-vocabulary code of the returned error. */
  readonly code: DebuggenErrorCode;
  /** Fixed text naming what failed; the log message and the error message alike. */
  readonly message: string;
  /** The developer's next step. */
  readonly hint: string;
  /** `warn` for an environmental failure, `error` for a defect in the product or its wiring. */
  readonly level: 'warn' | 'error';
  /** Further shape-only fields: counts, codes, paths, catalogued node types, field names. */
  readonly fields?: LogFields;
  /** The typed error behind the failure, kept as the returned error's `cause`. */
  readonly cause?: DebuggenError;
}

/**
 * Logs a failed build and returns its error. Both carry the same shape-only
 * fields: the stage, the fallback reason when it is a recognised one, the
 * cause's code, and whatever {@link BuildFailure.fields} adds. Never a value
 * taken from the capture, the analysis or a rejected document.
 */
function reportFailure(
  sessionLog: Logger,
  reason: unknown,
  failure: BuildFailure,
): Result<never, DebuggenError> {
  const details: LogFields = {
    [STAGE_DETAIL_KEY]: failure.stage,
    ...(isFallbackReason(reason) ? { [REASON_DETAIL_KEY]: reason } : {}),
    ...(failure.fields ?? {}),
    ...(failure.cause === undefined ? {} : { causeCode: failure.cause.code }),
  };
  sessionLog[failure.level](failure.message, { code: failure.code, ...details });
  return err(
    new DebuggenError(failure.code, failure.message, {
      hint: failure.hint,
      details,
      ...(failure.cause === undefined ? {} : { cause: failure.cause }),
    }),
  );
}

/**
 * The failure of one own-output gate: a product defect, reported at `error`
 * with the gate's issue paths and codes and the node types that were selected.
 */
function gateFailure(
  gate: OwnOutputGate,
  code: DebuggenErrorCode,
  failed: GateFailure,
  selection: FallbackSelection,
  panelVersion: number,
): BuildFailure {
  return {
    stage: gate,
    code,
    message: GATE_MESSAGES[gate],
    hint: PRODUCT_DEFECT_HINT,
    level: 'error',
    fields: {
      ...issueFields(failed.issues),
      nodeTypes: nodeTypesOf(selection),
      panelVersion,
    },
    cause: failed.cause,
  };
}

/**
 * Creates the deterministic fallback panel builder over its injected ports.
 *
 * Holds no state between calls: every build reads the summary through the
 * injected port (or takes the one supplied), and mints its id through the
 * injected factory, so the builder runs in-process with the deterministic
 * provider in the integration suites.
 *
 * @param deps The validator, the capture-summary port, a logger and an id factory.
 * @returns The builder.
 */
export function createFallbackPanelBuilder(deps: FallbackPanelBuilderDeps): FallbackPanelBuilder {
  const log = subsystemLogger(deps.logger ?? noopLogger, SUBSYSTEM);
  const mintId = deps.newId ?? newPanelId;

  /** The summary to build from: the one supplied, or the one the port loads. */
  const summaryFor = async (
    request: FallbackBuildRequest,
    sessionLog: Logger,
  ): Promise<Result<CaptureSummary, DebuggenError>> => {
    if (request.summary !== undefined) {
      return ok(request.summary);
    }

    const captures = deps.captures;
    if (captures === undefined) {
      return reportFailure(sessionLog, request.reason, {
        stage: 'summary',
        code: 'INTERNAL',
        message:
          'A fallback panel was requested without a capture summary, and no summary port is configured.',
        hint: MISSING_SUMMARY_PORT_HINT,
        level: 'error',
      });
    }

    let loaded: Result<CaptureSummary, DebuggenError>;
    try {
      loaded = await captures.loadCaptureSummary(request.sessionId, request.captureId);
    } catch (thrown) {
      loaded = err(DebuggenError.from(thrown, 'STORE_ERROR'));
    }
    if (loaded.ok) {
      return ok(loaded.value);
    }

    return reportFailure(sessionLog, request.reason, {
      stage: 'summary',
      code: loaded.error.code,
      message: 'The capture summary a fallback panel is assembled from could not be loaded.',
      hint: loaded.error.hint ?? SUMMARY_UNAVAILABLE_HINT,
      level: 'warn',
      cause: loaded.error,
    });
  };

  /** The body of a build; {@link FallbackPanelBuilder.build} turns an unexpected throw into an `Err`. */
  const run = async (
    request: FallbackBuildRequest,
    sessionLog: Logger,
  ): Promise<Result<PanelSpec, DebuggenError>> => {
    const { reason } = request;
    // An unrecognised reason is caller-controlled data: it is refused, never echoed.
    if (!isFallbackReason(reason)) {
      return reportFailure(sessionLog, reason, {
        stage: 'request',
        code: 'INTERNAL',
        message: 'A fallback panel was requested with an unrecognised failure reason.',
        hint: INVALID_REASON_HINT,
        level: 'error',
      });
    }

    const summary = await summaryFor(request, sessionLog);
    if (!summary.ok) {
      return summary;
    }

    const mismatches = scopeMismatches(request, summary.value);
    if (mismatches.length > 0) {
      return reportFailure(sessionLog, reason, {
        stage: 'scope',
        code: 'INTERNAL',
        message:
          'A fallback panel was requested with a summary or analysis of a different session or capture.',
        hint: SCOPE_MISMATCH_HINT,
        level: 'error',
        fields: { mismatches },
      });
    }

    const selection = selectFallbackNodes(summary.value);
    const authored = buildFallbackInput({
      selection,
      analysis: request.analysis,
      summary: summary.value,
    });

    // Gate 1: the authoring schema a model's output is parsed against.
    const parsed = parsePanelSpecInput(authored);
    if (!parsed.ok) {
      return reportFailure(
        sessionLog,
        reason,
        gateFailure(
          'authoring-schema',
          'PANEL_INVALID',
          gateFailureOf(classifyFailure(parsed.error)),
          selection,
          request.panelVersion,
        ),
      );
    }

    let id: PanelId;
    try {
      id = mintId();
    } catch (thrown) {
      return reportFailure(sessionLog, reason, {
        stage: 'panel-id',
        code: 'INTERNAL',
        message: 'The panel id factory failed while building a fallback panel.',
        hint: PANEL_ID_HINT,
        level: 'error',
        cause: DebuggenError.from(thrown),
      });
    }

    // `fallback: true` is what sets `meta.fallback`: the normaliser owns `meta`.
    const context: NormalizeContext = {
      id,
      sessionId: request.sessionId,
      panelVersion: request.panelVersion,
      ...(request.supersedes === undefined ? {} : { supersedes: request.supersedes }),
      fallback: true,
    };

    // Gate 2: the deterministic normaliser. It throws only for input no parse
    // produces, which would be a product defect here.
    let normalized: PanelSpec;
    try {
      normalized = normalizePanel(parsed.value, request.analysis, context);
    } catch (thrown) {
      return reportFailure(
        sessionLog,
        reason,
        gateFailure(
          'normalize',
          'INTERNAL',
          gateFailureOf(classifyFailure(thrown)),
          selection,
          request.panelVersion,
        ),
      );
    }

    // Gate 3: the internal schema and whole-document rules of ./validate.ts.
    const validated = deps.validator.validateSpec(normalized, {
      sessionId: request.sessionId,
      captureId: request.captureId,
    });
    if (!validated.ok) {
      return reportFailure(
        sessionLog,
        reason,
        gateFailure(
          'internal-schema',
          validated.error.code,
          gateFailureOf(validated.error),
          selection,
          request.panelVersion,
        ),
      );
    }

    const spec = validated.value;
    if (spec.meta?.fallback !== true) {
      // Unreachable while the normaliser honours its context. Checked because a
      // fallback panel shown without its banner would present a failure as an
      // answer (AAP 0.5.5).
      return reportFailure(
        sessionLog,
        reason,
        gateFailure(
          'internal-schema',
          'PANEL_INVALID',
          {
            issues: [{ path: 'meta.fallback', code: 'fallback_flag_missing' }],
            cause: new DebuggenError('PANEL_INVALID', 'A fallback panel lacks its fallback flag.'),
          },
          selection,
          request.panelVersion,
        ),
      );
    }

    sessionLog.info('Assembled a deterministic fallback panel from the captured data.', {
      [REASON_DETAIL_KEY]: reason,
      disposition: PANEL_FAILURE_POLICY[reason].disposition,
      panelVersion: spec.panelVersion,
      emptyCapture: selection.empty,
      nodeTypes: nodeTypesOf(selection),
      observedCount: spec.summary.observed.length,
      likelyCauseCount: spec.summary.likelyCauses.length,
    });
    return ok(spec);
  };

  const build = async (
    request: FallbackBuildRequest,
  ): Promise<Result<PanelSpec, DebuggenError>> => {
    const sessionLog = sessionLogger(log, request.sessionId, request.captureId);
    try {
      return await run(request, sessionLog);
    } catch (thrown) {
      return reportFailure(sessionLog, request.reason, {
        stage: 'unexpected',
        code: 'INTERNAL',
        message: 'Building a fallback panel failed unexpectedly; no panel was emitted.',
        hint: PRODUCT_DEFECT_HINT,
        level: 'error',
        cause: DebuggenError.from(thrown),
      });
    }
  };

  return Object.freeze({ build });
}

/* -------------------------------------------------------------------------------------------------
 * Compile-time contract assertions
 * ---------------------------------------------------------------------------------------------- */

/** Fails to compile unless `T` is exactly `true`. */
type AssertTrue<T extends true> = T;

/** The service's `AnalysisSummarizer` still satisfies the summary port this builder reads. */
export type AnalysisSummarizerSatisfiesFallbackSummaryPort = AssertTrue<
  AnalysisSummarizer extends CaptureSummaryPort ? true : false
>;

/** A validated `AnalysisResult` is still an analysis `normalizePanel` accepts. */
export type FallbackAnalysisSatisfiesNormalizeAnalysis = AssertTrue<
  AnalysisResult extends NormalizeAnalysis ? true : false
>;
