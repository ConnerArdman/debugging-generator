/**
 * The evidence rule of the analysis stage. Four jobs:
 *
 * 1. **Fact candidates** ({@link buildFactCandidates}): deterministic
 *    statements from fixed, value-substituting templates over the bounded
 *    analysis input, each citing persisted event ids. Kinds name measurement
 *    mechanisms and the developer's question is never read. Candidates are
 *    offered to the model; nothing here promotes one into an observed fact.
 * 2. **Verification** ({@link AnalysisFacts.verifyFindings}) of every citation
 *    and every suggested location the model returned. Accepted findings are
 *    returned exactly as parsed — never moved, rewritten, re-ranked, padded or
 *    dropped.
 * 3. **Assembly and persistence** ({@link AnalysisFacts.acceptFindings}): the
 *    protocol's constructor builds the `AnalysisResult`, it is re-validated and
 *    stored as the session's next version, `supersedes` naming the latest one;
 *    a version collision is reported, never retried or overwritten.
 * 4. **Evidence resolvers** ({@link AnalysisFacts.createEvidenceResolvers}) for
 *    `panels/validate.ts`, backed by the same lookups.
 *
 * ## Capture-scoped evidence
 *
 * Every evidence reference of every observed fact and likely cause must resolve
 * to *one* event of this capture: its event id exists in the capture, a cited
 * trace id is that event's trace there, and a cited span id is that event's own
 * span. Existence is asked of the store through {@link EvidenceLookupPort} —
 * never of the bounded summary — and a span the port cannot look up fails
 * closed (`span-unverifiable`). A suggested location must name a regular file
 * inside the session project once every symbolic link is resolved. One failed
 * check rejects the whole analysis as a typed `Err`; there is no fallback
 * analysis.
 *
 * ## Privacy
 *
 * Candidates are built from already-redacted evidence: labels are scrubbed,
 * long tokens shortened, request groups named by method and path (never by
 * digest), and every candidate passes the outbound guard's inspector before it
 * is offered. The location check reads filesystem metadata only, through the
 * injectable {@link LocationFilePort}. Errors and logs carry JSON paths, codes,
 * counts and product-minted ids only — never a statement, an attribute value,
 * SQL, a source excerpt, a filesystem path or an errno.
 *
 * Ports, logger, clock and id generator are injected; nothing reads the
 * environment, the network or a timer, and nothing throws for an expected
 * failure — a throwing port arrives as `Err`.
 *
 * @module
 */

import { lstatSync, realpathSync } from 'node:fs';

import {
  DebuggenError,
  clampNonNegative,
  err,
  isSafeRelativePath,
  isSpanId,
  isTraceId,
  isWithin,
  newAnalysisId,
  noopLogger,
  normalizePosix,
  nowEpochMs,
  ok,
  parseSourceLocation,
  resolveRealPathWithinProject,
  resolveWithinProject,
  roundMs,
  toPosix,
  type AnalysisId,
  type CaptureId,
  type Logger,
  type RealPathResolver,
  type Result,
  type SessionId,
  type SourceLocation,
} from '@debuggen/shared';
import {
  METRIC_IDS,
  isMetricId,
  scrub,
  type CaptureSummary,
  type MetricId,
  type MetricValue,
  type RenderTrigger,
  type TelemetryEvent,
  type TelemetryKind,
  type TelemetryTier,
} from '@debuggen/telemetry';
import {
  CONFIDENCE_LEVELS,
  DATA_QUERY_MAX_LIMIT,
  MAX_EVENT_REF_LABEL_LENGTH,
  MAX_EVIDENCE_REFS,
  MAX_STATEMENT_LENGTH,
  MAX_SUMMARY_FACTS,
  MAX_SUMMARY_HYPOTHESES,
  eventRefSchema,
  isConfidenceLevel,
  type EventIdResolver,
  type EventRef,
  type Fact,
  type IdResolution,
  type SemanticValidationOptions,
  type TraceIdResolver,
} from '@debuggen/panel-schema';
import {
  ANALYSIS_VERSION_START,
  createAnalysisResult,
  parseAnalysisFindings,
  parseAnalysisResult,
  type AnalysisFindings,
  type AnalysisResult,
} from '@debuggen/protocol';
import { ENTROPY_MIN_LENGTH, inspectPayloadReport } from '@debuggen/model-provider';

import { LOG_BINDING_KEYS } from '../logging.js';
import type { PanelsRepo } from '../store/panels-repo.js';
import type { TelemetryRepo } from '../store/telemetry-repo.js';
import {
  ANALYSIS_INPUT_LIMITS,
  toQueryRow,
  toRenderRow,
  toRequestRow,
  type AnalysisErrorRow,
  type AnalysisFactCandidateRef,
  type AnalysisQueryRow,
  type AnalysisRenderRow,
  type AnalysisRequestRow,
  type AnalysisStageInput,
  type AnalysisStateRow,
} from './summarize.js';

/* -------------------------------------------------------------------------------------------------
 * Candidate vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * The closed vocabulary of fact-candidate kinds, in offering priority order.
 *
 * Every member names a *measurement mechanism*, never a domain: which kinds a
 * capture yields is decided by what the capture measured, so one capture's
 * candidates read as a latency finding and another's as a rendering finding
 * without either outcome being written down anywhere (AAP 0.5.4).
 *
 * - `slowest-span` — the slowest span of each tier.
 * - `self-time-hotspot` — the spans with the most time not covered by children.
 * - `tier-duration` — the per-tier duration metrics against the capture total.
 * - `duplicate-requests` — the largest duplicate window of a request group.
 * - `request-initiators` — how many initiators a duplicated request group has.
 * - `repeated-query` — one parameterised statement shape executed repeatedly.
 * - `render-outlier` — the components that rendered most often.
 * - `unchanged-render-burst` — renders with shallow-equal props, unchanged own
 *   state and no changed consumed context.
 * - `dominant-render-trigger` — the input change behind most of a component's
 *   renders, naming the providers of the context when that change was one.
 * - `unknown-render-trigger` — renders whose trigger could not be determined,
 *   counted apart from unchanged renders and never folded into them.
 *
 * The four render kinds are drawn from the project's own components whenever
 * the capture marks any as declared by the project, so a framework's
 * internal components cannot take their places.
 * - `state-transition-burst` — one state hook changing value repeatedly.
 * - `long-task` — long tasks and total blocking time.
 * - `captured-error` — failures the capture recorded.
 *
 * Frozen: it is shared module-level data, and the declaration order is the
 * round-robin order of {@link buildFactCandidates}.
 */
export const FACT_CANDIDATE_KINDS = Object.freeze([
  'slowest-span',
  'self-time-hotspot',
  'tier-duration',
  'duplicate-requests',
  'request-initiators',
  'repeated-query',
  'render-outlier',
  'unchanged-render-burst',
  'dominant-render-trigger',
  'unknown-render-trigger',
  'state-transition-burst',
  'long-task',
  'captured-error',
] as const);

/** One member of {@link FACT_CANDIDATE_KINDS}. */
export type FactCandidateKind = (typeof FACT_CANDIDATE_KINDS)[number];

/** Widened view of {@link FACT_CANDIDATE_KINDS} so an unknown value can be tested without a cast. */
const FACT_CANDIDATE_KIND_VALUES: readonly string[] = FACT_CANDIDATE_KINDS;

/**
 * Whether `value` is a member of {@link FACT_CANDIDATE_KINDS}.
 *
 * @param value Any value, typically a candidate kind read back from a prompt
 * payload or a stored document.
 * @returns `true` when `value` is a known kind, narrowing it to
 * {@link FactCandidateKind}.
 */
export function isFactCandidateKind(value: unknown): value is FactCandidateKind {
  return typeof value === 'string' && FACT_CANDIDATE_KIND_VALUES.includes(value);
}

/* -------------------------------------------------------------------------------------------------
 * Limits and thresholds
 * ---------------------------------------------------------------------------------------------- */

/** The caps that bound a fact-candidate list. See {@link FACT_CANDIDATE_LIMITS}. */
export type FactCandidateLimits = {
  /** Candidates offered in total. */
  readonly maxCandidates: number;
  /** Candidates offered per kind. */
  readonly maxPerKind: number;
  /** Evidence references per candidate. */
  readonly maxEvidencePerCandidate: number;
  /** Characters per candidate statement. */
  readonly maxStatementLength: number;
};

/**
 * The default, and maximum, fact-candidate caps.
 *
 * Tied to the analysis input's own caps so `summarize.ts` never has to cut a
 * candidate this module offered: `maxCandidates` and `maxEvidencePerCandidate`
 * equal the input's `maxFactCandidates` and `maxEvidencePerCandidate`, and the
 * statement bound is the smaller of the input's candidate-statement cap and the
 * panel schema's `MAX_STATEMENT_LENGTH`, so a model may copy a candidate
 * statement into a `Fact` verbatim. `maxPerKind` keeps a render-heavy capture
 * from crowding latency candidates out of the list.
 */
export const FACT_CANDIDATE_LIMITS: FactCandidateLimits = Object.freeze({
  maxCandidates: ANALYSIS_INPUT_LIMITS.maxFactCandidates,
  maxPerKind: 4,
  maxEvidencePerCandidate: Math.min(
    ANALYSIS_INPUT_LIMITS.maxEvidencePerCandidate,
    MAX_EVIDENCE_REFS,
  ),
  maxStatementLength: Math.min(
    ANALYSIS_INPUT_LIMITS.maxCandidateStatementLength,
    MAX_STATEMENT_LENGTH,
  ),
});

/**
 * The smallest measurements that make a candidate worth offering.
 *
 * Counts, not judgements: a component that rendered twice is reported as having
 * rendered twice; whether that matters is the analysis's call. A threshold only
 * keeps a candidate from restating a single, unremarkable occurrence.
 */
export const FACT_CANDIDATE_THRESHOLDS = Object.freeze({
  /** Renders of one component before `render-outlier` applies. */
  minRenders: 2,
  /** Unchanged-input renders before `unchanged-render-burst` applies. */
  minUnchangedRenders: 2,
  /** Renders sharing one trigger before `dominant-render-trigger` applies. */
  minTriggerRenders: 2,
  /** Undetermined-trigger renders before `unknown-render-trigger` applies. */
  minUnknownTriggerRenders: 1,
  /** Executions of one statement shape before `repeated-query` applies. */
  minQueryExecutions: 2,
  /** Value changes of one state hook before `state-transition-burst` applies. */
  minStateChanges: 3,
});

/**
 * One deterministic fact candidate: a value-substituted statement about the
 * capture and the persisted events that substantiate it.
 *
 * Assignable to `summarize.ts`'s structural `AnalysisFactCandidateRef` slot
 * ({@link FactCandidateSatisfiesSlot}), which is how candidates enter the
 * analyze prompt's input without that module importing this one.
 */
export type FactCandidate = {
  /** Stable id: `fc-<kind>-<ordinal within kind>`. */
  readonly id: string;
  readonly kind: FactCandidateKind;
  readonly statement: string;
  /** At least one reference to a persisted event of the capture. */
  readonly evidence: readonly EventRef[];
  readonly metricId?: MetricId;
  /** The measured value the statement leads with. */
  readonly value?: number;
  readonly unit?: string;
  /** A validated project-relative location the evidence points at, when one is known. */
  readonly suggestedLocation?: SourceLocation;
  /** 1-based position in the offered list. */
  readonly rank: number;
};

/** The evidence view candidates are built from: the bounded analysis input and the capture summary. */
export type FactCandidateSource = {
  /** The analyze prompt's structured input, as `summarize.ts` built it. */
  readonly input: AnalysisStageInput;
  /**
   * The capture's summary. Its metrics are preferred, and its sections stand in
   * for input sections the byte budget dropped — only when it describes the
   * same capture as {@link FactCandidateSource.input}.
   */
  readonly summary: CaptureSummary;
};

/** Options of {@link buildFactCandidates}. */
export type FactCandidateOptions = {
  /**
   * Lower any cap of {@link FACT_CANDIDATE_LIMITS}. A value above the default,
   * or one that is not a finite number, leaves the default in place; the caps
   * are the privacy and cost boundary of the prompt and are never raised.
   */
  readonly limits?: Partial<FactCandidateLimits> | undefined;
};

/** What {@link buildFactCandidateReport} built, and what it had to leave out. */
export type FactCandidateReport = {
  /** The offered candidates, in rank order. */
  readonly candidates: readonly FactCandidate[];
  /** Candidates the evidence produced before any cap. */
  readonly considered: number;
  /** Candidates cut by `maxPerKind`. */
  readonly droppedByKindLimit: number;
  /** Candidates cut by `maxCandidates`. */
  readonly droppedByTotalLimit: number;
  /** Candidates withheld: no citable evidence survived, or the outbound check refused them. */
  readonly withheld: number;
  /** Offered candidates whose evidence list was capped. */
  readonly evidenceTrimmed: number;
  /** Offered candidates whose statement was capped. */
  readonly statementsTrimmed: number;
  /** Whether any of the five counters above is non-zero. */
  readonly truncated: boolean;
  /** Whether the capture summary contributed metrics or sections. */
  readonly summaryUsed: boolean;
  /** Offered candidates per kind, zero-filled. */
  readonly kindCounts: Readonly<Record<FactCandidateKind, number>>;
};

/* -------------------------------------------------------------------------------------------------
 * Verification shapes
 * ---------------------------------------------------------------------------------------------- */

/**
 * The closed vocabulary of verification issues. Each code has one fixed reason
 * ({@link FACT_VERIFICATION_ISSUE_REASONS}), so an issue never carries data.
 *
 * `span-unverifiable` is the fail-closed code: a citation carrying a span id is
 * rejected when the {@link EvidenceLookupPort} offers no span lookup, because
 * a span that was never compared with the cited event is not evidence.
 */
export const FACT_VERIFICATION_ISSUE_CODES = Object.freeze([
  'event-unresolved',
  'trace-unresolved',
  'span-unresolved',
  'span-unverifiable',
  'span-outside-capture',
  'span-trace-mismatch',
  'span-event-mismatch',
  'event-trace-mismatch',
  'location-invalid',
  'location-outside-project',
  'statement-bounds',
  'evidence-bounds',
  'list-bounds',
  'confidence-invalid',
] as const);

/** One member of {@link FACT_VERIFICATION_ISSUE_CODES}. */
export type FactVerificationIssueCode = (typeof FACT_VERIFICATION_ISSUE_CODES)[number];

/** The fixed, data-free reason of each {@link FactVerificationIssueCode}. */
export const FACT_VERIFICATION_ISSUE_REASONS: Readonly<Record<FactVerificationIssueCode, string>> =
  Object.freeze({
    'event-unresolved': 'The cited event id does not exist among the events of this capture.',
    'trace-unresolved': 'The cited trace id does not exist among the events of this capture.',
    'span-unresolved': 'The cited span id does not exist among the events of this session.',
    'span-unverifiable':
      'The cited span id could not be checked: the evidence store offers no span lookup.',
    'span-outside-capture': 'The cited span id belongs to an event of another capture.',
    'span-trace-mismatch': 'The cited span id belongs to a different trace than the one cited.',
    'span-event-mismatch': 'The cited span id belongs to a different event than the one cited.',
    'event-trace-mismatch':
      'The cited event is not one of the events of the cited trace in this capture.',
    'location-invalid': 'The suggested location is not a valid source location.',
    'location-outside-project':
      'The suggested location does not name a file inside the session project.',
    'statement-bounds': `A statement must be non-blank and at most ${String(MAX_STATEMENT_LENGTH)} characters.`,
    'evidence-bounds': `A statement must cite between 1 and ${String(MAX_EVIDENCE_REFS)} events.`,
    'list-bounds': `An analysis holds at most ${String(MAX_SUMMARY_FACTS)} observed facts and ${String(MAX_SUMMARY_HYPOTHESES)} likely causes.`,
    'confidence-invalid': `A likely cause must carry one of the confidence levels ${CONFIDENCE_LEVELS.join(', ')}.`,
  });

/** One failed check, located by its JSON path inside the findings. */
export type FactVerificationIssue = {
  /** JSON path, for example `observed[2].evidence[0].eventId`. */
  readonly path: string;
  /** What failed. */
  readonly code: FactVerificationIssueCode;
  /** The fixed reason for {@link FactVerificationIssue.code}; never a cited value. */
  readonly reason: string;
};

/**
 * The detail of one verification run.
 *
 * The id lists hold ids exactly as the findings cite them, sorted and
 * de-duplicated. They are in-process values for assertions and progress
 * reporting; a caller that logs or broadcasts a report sends the counts, as the
 * rejection error of {@link AnalysisFacts.verifyFindings} does.
 */
export type FactVerificationReport = {
  /** Distinct event ids checked. */
  readonly checkedEventIds: readonly string[];
  /** Distinct event ids the capture does not hold. */
  readonly unresolvedEventIds: readonly string[];
  /** Distinct trace ids checked. */
  readonly checkedTraceIds: readonly string[];
  /** Distinct trace ids the capture does not hold. */
  readonly unresolvedTraceIds: readonly string[];
  /** Distinct span ids checked; empty when the lookup port offers no span lookup. */
  readonly checkedSpanIds: readonly string[];
  /** Distinct span ids the session does not hold. */
  readonly unresolvedSpanIds: readonly string[];
  /**
   * Whether span ids could be checked at all. `unavailable` never lets a span
   * pass unchecked: every citation carrying a span id then fails with
   * `span-unverifiable`, so the report is invalid. Only citations without a
   * span id can verify against a port that offers no span lookup.
   */
  readonly spanCheck: 'performed' | 'unavailable';
  /** Suggested locations checked. */
  readonly checkedLocations: number;
  /** Every failed check, in findings order. */
  readonly issues: readonly FactVerificationIssue[];
  /** `issues.length === 0`. */
  readonly valid: boolean;
};

/** Which session, capture and project a set of findings is verified against. */
export type FactVerificationContext = {
  /** The session the findings belong to. */
  readonly sessionId: SessionId;
  /** The capture every citation must resolve in. */
  readonly captureId: CaptureId;
  /**
   * Absolute path of the session's project root; a suggested location must name
   * a regular file inside it once every symbolic link is resolved.
   */
  readonly projectRoot: string;
};

/** {@link FactVerificationContext} plus what assembly needs. */
export type AcceptFindingsContext = FactVerificationContext & {
  /** The capture's metric values, normally `CaptureSummary.metrics`. */
  readonly metrics: readonly MetricValue[];
  /** When the analysis was produced (epoch ms); defaults to the injected clock. */
  readonly createdAt?: number | undefined;
};

/** Input of {@link AnalysisFacts.assembleResult}. */
export type AssembleAnalysisInput = {
  /** Verified findings. */
  readonly findings: AnalysisFindings;
  /** The session the analysis belongs to. */
  readonly sessionId: SessionId;
  /** The capture the findings were drawn from. */
  readonly captureId: CaptureId;
  /** The capture's metric values; each id at most once, stored in `METRIC_IDS` order. */
  readonly metrics: readonly MetricValue[];
  /** Which generation this is; defaults to `ANALYSIS_VERSION_START`. */
  readonly analysisVersion?: number | undefined;
  /** The previous version's id, on the follow-up path. */
  readonly supersedes?: AnalysisId | undefined;
  /** When the analysis was produced (epoch ms); defaults to the injected clock. */
  readonly createdAt?: number | undefined;
};

/**
 * The two resolvers `panels/validate.ts` passes to `validateAgainstCapture`,
 * typed exactly as `SemanticValidationOptions` declares them
 * ({@link EvidenceResolversSatisfySemanticOptions}).
 */
export type EvidenceResolvers = {
  /** Partitions cited event ids into known and unknown. */
  readonly resolveEventIds: EventIdResolver;
  /** Partitions cited trace ids into known and unknown. */
  readonly resolveTraceIds: TraceIdResolver;
};

/* -------------------------------------------------------------------------------------------------
 * Ports and dependencies
 * ---------------------------------------------------------------------------------------------- */

/** The fields of a stored event the span check reads. */
export type EvidenceSpanRecord = Pick<TelemetryEvent, 'id' | 'traceId' | 'captureId'>;

/** The fields of a stored event the trace-membership check reads. */
export type EvidenceTraceRecord = Pick<TelemetryEvent, 'id' | 'traceId' | 'captureId'>;

/**
 * The narrowing and paging {@link EvidenceLookupPort.listByTrace} accepts: a
 * subset of `TelemetryRepo`'s `TelemetryReadOptions`, so the repository's own
 * reader satisfies the port unchanged.
 */
export type EvidenceTracePageOptions = {
  /** Only this capture's events of the trace; absent means every capture's. */
  readonly captureId?: CaptureId | undefined;
  /** Rows per page; the store clamps it to its own maximum page. */
  readonly limit?: number | undefined;
  /** Rows to skip. */
  readonly offset?: number | undefined;
};

/**
 * One page of a trace's events, as {@link EvidenceLookupPort.listByTrace}
 * returns it: `TelemetryRepo`'s `TelemetryPage` viewed through the fields the
 * membership check reads.
 */
export type EvidenceTracePage = {
  /** The page's events, in the store's stable trace order. */
  readonly rows: readonly EvidenceTraceRecord[];
  /**
   * The offset of the next page, strictly greater than this page's offset, or
   * absent when this page is the last one.
   */
  readonly nextOffset?: number | undefined;
};

/**
 * The evidence lookups this module asks of the telemetry store (satisfied by
 * `TelemetryRepo`, asserted by {@link TelemetryRepoSatisfiesEvidenceLookupPort}).
 *
 * They are the single implementation of existence and of citation
 * consistency: verification and the semantic-validation resolvers both call
 * them, and nothing here scans a summary or writes SQL instead. Verification
 * calls them once for the distinct cited event ids, once for the distinct
 * cited trace ids, once per distinct cited span id and once per page of each
 * distinct cited trace whose membership still has to be established.
 */
export interface EvidenceLookupPort {
  /** Which of `ids` the session holds as event ids, narrowed to `captureId` when given. */
  existingEventIds(
    sessionId: SessionId,
    ids: readonly string[],
    captureId?: CaptureId,
  ): Result<ReadonlySet<string>, DebuggenError>;
  /** Which of `ids` the session holds as trace ids, narrowed to `captureId` when given. */
  existingTraceIds(
    sessionId: SessionId,
    ids: readonly string[],
    captureId?: CaptureId,
  ): Result<ReadonlySet<string>, DebuggenError>;
  /**
   * One stored event by span id, session-wide. Optional, and fail-closed when
   * absent: a port without it still verifies event and trace citations, but
   * every citation that carries a span id is rejected with
   * `span-unverifiable` (the report's `spanCheck` is `unavailable`), so an
   * unchecked span can never reach the store.
   */
  readonly getBySpanId?: (
    sessionId: SessionId,
    spanId: string,
  ) => Result<EvidenceSpanRecord | undefined, DebuggenError>;
  /**
   * One page of the events of `traceId` in the session, narrowed to
   * `options.captureId` when given. Required: it is how verification proves
   * that a cited event belongs to the trace the citation names, which no
   * existence lookup can answer. Pages must advance — a present `nextOffset`
   * is strictly greater than the page's own offset — as `TelemetryRepo`
   * guarantees.
   */
  listByTrace(
    sessionId: SessionId,
    traceId: string,
    options?: EvidenceTracePageOptions,
  ): Result<EvidenceTracePage, DebuggenError>;
}

/**
 * The analysis history this module reads and appends to (satisfied by
 * `PanelsRepo`, asserted by {@link PanelsRepoSatisfiesAnalysisStorePort}).
 */
export interface AnalysisStorePort {
  /** Validates and stores one analysis as its session's next version; never replaces a row. */
  insertAnalysis(result: AnalysisResult): Result<AnalysisResult, DebuggenError>;
  /** The newest stored analysis of a session. */
  getLatestAnalysis(sessionId: SessionId): Result<AnalysisResult | undefined, DebuggenError>;
  /** The version the session's next analysis must carry. */
  nextAnalysisVersion(sessionId: SessionId): Result<number, DebuggenError>;
  /** Every stored analysis of a session, oldest version first. */
  listAnalyses(sessionId: SessionId): Result<readonly AnalysisResult[], DebuggenError>;
}

/**
 * The filesystem metadata reads that verify a suggested location: two
 * synchronous questions about absolute paths, never a read of file content.
 * Defaults to `node:fs` (`realpathSync`, `lstatSync`); a test injects its own.
 */
export interface LocationFilePort {
  /**
   * The canonical absolute path of `absolutePath`, every symbolic link
   * resolved, final component included. Throws when it cannot be resolved; a
   * throw rejects the location, it never escapes verification.
   */
  realpath(absolutePath: string): string;
  /**
   * Whether `absolutePath` itself — not followed — is a regular file. `false`
   * for a directory, a link, a device or a path that cannot be examined.
   */
  isRegularFile(absolutePath: string): boolean;
}

/** The production {@link LocationFilePort}: `realpathSync`, and `lstatSync` for the file type. */
const NODE_LOCATION_FILES: LocationFilePort = Object.freeze({
  realpath: (absolutePath: string): string => realpathSync(absolutePath),
  isRegularFile: (absolutePath: string): boolean => {
    try {
      return lstatSync(absolutePath).isFile();
    } catch {
      // Missing, unreadable or refused: whatever the errno, it is not a file
      // this analysis may point the developer at, and the errno is not kept.
      return false;
    }
  },
});

/** Injected dependencies of {@link createAnalysisFacts}. */
export type AnalysisFactsDeps = {
  /** Existence lookups over the capture's persisted events. */
  readonly evidence: EvidenceLookupPort;
  /** The analysis history. */
  readonly store: AnalysisStorePort;
  /** Filesystem metadata for suggested-location checks; defaults to `node:fs`. */
  readonly files?: LocationFilePort | undefined;
  /** Logger; a child bound to the `analysis` subsystem is derived from it. */
  readonly logger?: Logger | undefined;
  /** Clock (epoch ms) for `createdAt` defaults and timing logs. */
  readonly now?: (() => number) | undefined;
  /** Analysis id generator; defaults to `newAnalysisId`. */
  readonly newId?: (() => AnalysisId) | undefined;
};

/** The analysis-facts subsystem. See the module documentation. */
export interface AnalysisFacts {
  /**
   * The deterministic fact candidates for one analysis input: a logged wrapper
   * over {@link buildFactCandidates}.
   */
  candidatesFor(source: FactCandidateSource, options?: FactCandidateOptions): FactCandidate[];

  /**
   * Checkpoint one of two: parses `findings` with the protocol's findings
   * schema and resolves every citation to one event of the capture — its event,
   * trace and span ids must exist there and name that same event — and every
   * suggested location against the project. Any failed check rejects the whole
   * analysis; on success the parsed findings are returned unchanged.
   */
  verifyFindings(
    findings: unknown,
    context: FactVerificationContext,
  ): Promise<Result<AnalysisFindings, DebuggenError>>;

  /**
   * Builds an `AnalysisResult` from verified findings with the protocol's
   * `createAnalysisResult`, then re-validates it with `parseAnalysisResult`.
   */
  assembleResult(input: AssembleAnalysisInput): Result<AnalysisResult, DebuggenError>;

  /** Stores an assembled analysis as a new version; a version collision is a typed error. */
  storeResult(result: AnalysisResult): Promise<Result<AnalysisResult, DebuggenError>>;

  /**
   * The composed path the analyze and follow-up stages use: verify, take the
   * next version and the superseded id from the store, assemble, store.
   */
  acceptFindings(
    findings: unknown,
    context: AcceptFindingsContext,
  ): Promise<Result<AnalysisResult, DebuggenError>>;

  /**
   * The `resolveEventIds`/`resolveTraceIds` pair for `validateAgainstCapture`,
   * backed by the same lookups as {@link AnalysisFacts.verifyFindings}. A lookup
   * that fails makes a resolver decline (both sets empty), which the semantic
   * validator reports as unverifiable rather than as a verdict.
   */
  createEvidenceResolvers(sessionId: SessionId, captureId?: CaptureId): EvidenceResolvers;

  /** The verification detail without the accept/reject decision. */
  verificationReportFor(
    findings: unknown,
    context: FactVerificationContext,
  ): Promise<Result<FactVerificationReport, DebuggenError>>;

  /** The session's stored analyses, oldest version first. */
  history(sessionId: SessionId): Result<readonly AnalysisResult[], DebuggenError>;
}

/* -------------------------------------------------------------------------------------------------
 * Compile-time contract assertions
 * ---------------------------------------------------------------------------------------------- */

/** Fails to compile unless `T` is exactly `true`. */
type AssertTrue<T extends true> = T;

/** {@link FactCandidate} fits `summarize.ts`'s structural candidate slot. */
export type FactCandidateSatisfiesSlot = AssertTrue<
  FactCandidate extends AnalysisFactCandidateRef ? true : false
>;

/** `TelemetryRepo` still satisfies {@link EvidenceLookupPort}. */
export type TelemetryRepoSatisfiesEvidenceLookupPort = AssertTrue<
  TelemetryRepo extends EvidenceLookupPort ? true : false
>;

/** `PanelsRepo` still satisfies {@link AnalysisStorePort}. */
export type PanelsRepoSatisfiesAnalysisStorePort = AssertTrue<
  PanelsRepo extends AnalysisStorePort ? true : false
>;

/** {@link EvidenceResolvers} fits the two resolver options of `SemanticValidationOptions`. */
export type EvidenceResolversSatisfySemanticOptions = AssertTrue<
  EvidenceResolvers extends Required<
    Pick<SemanticValidationOptions, 'resolveEventIds' | 'resolveTraceIds'>
  >
    ? true
    : false
>;

/**
 * `SemanticValidationOptions` carrying `resolvers`, merged over the other
 * validation options — the object `panels/validate.ts` hands to
 * `validateAgainstCapture`. Building it as a literal of the declared options
 * type is the value-level proof that the resolvers fit.
 *
 * @param resolvers From {@link AnalysisFacts.createEvidenceResolvers}.
 * @param options The remaining semantic-validation options.
 * @returns The complete options object.
 */
export function toSemanticValidationOptions(
  resolvers: EvidenceResolvers,
  options?: Omit<SemanticValidationOptions, 'resolveEventIds' | 'resolveTraceIds'>,
): SemanticValidationOptions {
  const merged: SemanticValidationOptions = {
    ...options,
    resolveEventIds: resolvers.resolveEventIds,
    resolveTraceIds: resolvers.resolveTraceIds,
  };
  return merged;
}

/* -------------------------------------------------------------------------------------------------
 * Internal value helpers
 * ---------------------------------------------------------------------------------------------- */

/** The `subsystem` binding of this module's logger. */
const SUBSYSTEM = 'analysis';

/** The ellipsis appended to text cut by {@link capText}. */
const ELLIPSIS = '\u2026';

/** Characters kept of a runtime name interpolated into a statement. */
const MAX_LABEL_LENGTH = 80;

/** Characters kept of an evidence chip label. */
const MAX_REF_LABEL_LENGTH = Math.min(120, MAX_EVENT_REF_LABEL_LENGTH);

/** Characters kept of an unbroken token of `ENTROPY_MIN_LENGTH` or more characters. */
const LONG_TOKEN_KEEP = 12;

/** Tier order: the order per-tier candidates are built in. */
const TIER_ORDER: readonly TelemetryTier[] = Object.freeze(['browser', 'server', 'db'] as const);

/** How each tier is named in a statement. */
const TIER_LABELS: Readonly<Record<TelemetryTier, string>> = Object.freeze({
  browser: 'browser',
  server: 'server',
  db: 'database',
});

/** The per-tier duration metrics and the tier whose spans substantiate each. */
const TIER_DURATION_METRICS: readonly {
  readonly metricId: MetricId;
  readonly tier: TelemetryTier;
}[] = Object.freeze([
  { metricId: 'frontend_duration', tier: 'browser' },
  { metricId: 'backend_duration', tier: 'server' },
  { metricId: 'database_duration', tier: 'db' },
] as const);

/** The render triggers that name an input change, in tie-break order, with their wording. */
const INPUT_TRIGGER_PHRASES: readonly {
  readonly trigger: RenderTrigger;
  readonly phrase: string;
}[] = Object.freeze([
  { trigger: 'props', phrase: 'changed props' },
  { trigger: 'state', phrase: 'a change in its own state' },
  { trigger: 'context', phrase: 'a changed consumed context value' },
] as const);

/** Whitespace and control characters, collapsed to one space in labels. */
const LABEL_SEPARATORS = /[\p{Cc}\s]+/gu;

/**
 * The shape of an id this product mints (`@debuggen/shared`'s `newId`): the
 * only cited ids an error may quote. Anything else is counted, never echoed.
 */
const REPORTABLE_ID_PATTERN = /^[a-z]{3}_[0-9a-z]{16}$/;

/** Most ids and paths a rejection error lists. */
const MAX_REPORTED_ITEMS = 20;

/**
 * Rows asked for per page of a trace-membership walk: the panel-data surface's
 * maximum page, which `TelemetryRepo` clamps every reader to, so a trace of up
 * to that many events in the capture is answered by one read.
 */
const TRACE_MEMBERSHIP_PAGE_SIZE = DATA_QUERY_MAX_LIMIT;

/** Locale-independent string order. */
function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/**
 * `text` cut to at most `max` characters, ending in an ellipsis when cut. Never
 * splits a surrogate pair.
 */
function capText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  if (max <= 1) {
    return max === 1 ? ELLIPSIS : '';
  }
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return `${text.slice(0, end)}${ELLIPSIS}`;
}

/** A finite, non-negative whole count. */
function wholeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** A finite, non-negative duration; `0` for anything else. */
function durationOf(value: number): number {
  return Number.isFinite(value) ? clampNonNegative(value) : 0;
}

/**
 * A duration as statement text: whole milliseconds from 100 ms up, one decimal
 * below. Deterministic and locale-independent.
 */
function formatMs(value: number): string {
  const duration = durationOf(value);
  if (duration >= 100) {
    return String(Math.round(duration));
  }
  return String(Math.round(duration * 10) / 10);
}

/** `count` with the singular or plural noun. */
function plural(count: number, singular: string, pluralForm: string): string {
  return `${String(count)} ${count === 1 ? singular : pluralForm}`;
}

/**
 * A runtime name made safe to interpolate: passed through the telemetry
 * scrubber, whitespace and control characters collapsed, every unbroken token
 * of `ENTROPY_MIN_LENGTH` characters or more shortened (so no digest or other
 * high-entropy string reaches a statement), and bounded. A name that is blank
 * afterwards is replaced by `fallback`.
 */
function safeLabel(raw: string, fallback: string, max: number = MAX_LABEL_LENGTH): string {
  const collapsed = scrub(raw).replace(LABEL_SEPARATORS, ' ').trim();
  const shortened = collapsed
    .split(' ')
    .map((token) =>
      token.length >= ENTROPY_MIN_LENGTH ? `${token.slice(0, LONG_TOKEN_KEEP)}${ELLIPSIS}` : token,
    )
    .join(' ');
  const capped = capText(shortened, max).trim();
  return capped.length === 0 ? fallback : capped;
}

/** The first `count` items of `items`. */
function sample<T>(items: readonly T[], count: number): T[] {
  return items.slice(0, Math.max(0, count));
}

/** The effective caps: {@link FACT_CANDIDATE_LIMITS}, lowered by `overrides`. */
function resolveCandidateLimits(overrides?: Partial<FactCandidateLimits>): FactCandidateLimits {
  if (overrides === undefined) {
    return FACT_CANDIDATE_LIMITS;
  }
  const pick = (key: keyof FactCandidateLimits): number => {
    const requested = overrides[key];
    const fallback = FACT_CANDIDATE_LIMITS[key];
    if (requested === undefined || !Number.isFinite(requested)) {
      return fallback;
    }
    return Math.min(fallback, Math.max(0, Math.floor(requested)));
  };
  return Object.freeze({
    maxCandidates: pick('maxCandidates'),
    maxPerKind: pick('maxPerKind'),
    maxEvidencePerCandidate: pick('maxEvidencePerCandidate'),
    maxStatementLength: pick('maxStatementLength'),
  });
}

/* -------------------------------------------------------------------------------------------------
 * Evidence view
 * ---------------------------------------------------------------------------------------------- */

/** One citable span, merged from the input's slowest spans and trace rows. */
type SpanView = {
  readonly eventId: string;
  readonly spanId: string;
  readonly traceId: string;
  readonly kind: TelemetryKind;
  readonly tier: TelemetryTier;
  readonly name: string;
  readonly startTime: number;
  readonly durationMs: number;
  readonly selfTimeMs: number | undefined;
  readonly source: SourceLocation | undefined;
};

/** Everything the candidate builders read, gathered once. */
type EvidenceView = {
  readonly metrics: ReadonlyMap<MetricId, number>;
  /** Spans by duration, longest first. */
  readonly spans: readonly SpanView[];
  readonly renders: readonly AnalysisRenderRow[];
  readonly requests: readonly AnalysisRequestRow[];
  readonly queries: readonly AnalysisQueryRow[];
  readonly errors: readonly AnalysisErrorRow[];
  readonly states: readonly AnalysisStateRow[];
  /** Whether the state-transition rows were capped, so counts are lower bounds. */
  readonly statesTruncated: boolean;
  readonly summaryUsed: boolean;
};

/** A reference a candidate would cite, before it is validated as an `EventRef`. */
type EvidenceSeed = {
  readonly eventId: string;
  readonly traceId?: string | undefined;
  readonly spanId?: string | undefined;
  readonly kind?: TelemetryKind | undefined;
  readonly label?: string | undefined;
};

/** A candidate before ranking, capping and validation. */
type CandidateDraft = {
  readonly kind: FactCandidateKind;
  /** Primary within-kind rank, descending. */
  readonly magnitude: number;
  /** Secondary within-kind rank, descending. */
  readonly secondary: number;
  /** Final within-kind tie-break, ascending. */
  readonly tieBreak: string;
  readonly statement: string;
  readonly evidence: readonly EvidenceSeed[];
  readonly metricId?: MetricId | undefined;
  readonly value?: number | undefined;
  readonly unit?: string | undefined;
  readonly location?: SourceLocation | undefined;
};

/** Orders spans longest first, then earliest, then by event id. */
function compareSpans(left: SpanView, right: SpanView): number {
  if (left.durationMs !== right.durationMs) {
    return right.durationMs - left.durationMs;
  }
  if (left.startTime !== right.startTime) {
    return left.startTime - right.startTime;
  }
  return compareStrings(left.eventId, right.eventId);
}

/**
 * The evidence view of one source. Input sections are preferred, because they
 * hold exactly the numbers the analyze prompt shows; a section the input lacks
 * (the byte budget dropped it) is taken from the summary, and so are the metrics
 * when the input carries none — both only when the summary describes the same
 * capture. Nothing in either object is mutated.
 */
function buildEvidenceView(source: FactCandidateSource): EvidenceView {
  const { input, summary } = source;
  const sameCapture = summary.captureId === input.captureId;
  let summaryUsed = false;

  const metricRows: readonly Pick<MetricValue, 'id' | 'available' | 'value'>[] =
    input.metrics.length === 0 && sameCapture ? summary.metrics : input.metrics;
  if (input.metrics.length === 0 && sameCapture && summary.metrics.length > 0) {
    summaryUsed = true;
  }
  const metrics = new Map<MetricId, number>();
  for (const metric of metricRows) {
    if (
      isMetricId(metric.id) &&
      metric.available &&
      metric.value !== undefined &&
      Number.isFinite(metric.value) &&
      !metrics.has(metric.id)
    ) {
      metrics.set(metric.id, clampNonNegative(metric.value));
    }
  }

  const spansById = new Map<string, SpanView>();
  const addSpan = (span: SpanView): void => {
    if (span.eventId.length === 0 || !Number.isFinite(span.durationMs)) {
      return;
    }
    const existing = spansById.get(span.eventId);
    if (existing === undefined) {
      spansById.set(span.eventId, span);
      return;
    }
    spansById.set(span.eventId, {
      ...existing,
      selfTimeMs: existing.selfTimeMs ?? span.selfTimeMs,
      source: existing.source ?? span.source,
    });
  };
  for (const row of input.topSpans) {
    addSpan({
      eventId: row.eventId,
      spanId: row.spanId,
      traceId: row.traceId,
      kind: row.kind,
      tier: row.tier,
      name: row.name,
      startTime: row.startTime,
      durationMs: durationOf(row.durationMs),
      selfTimeMs: row.selfTimeMs,
      source: row.source,
    });
  }
  for (const trace of input.traces) {
    for (const span of trace.spans) {
      addSpan({
        eventId: span.eventId,
        spanId: span.spanId,
        traceId: trace.traceId,
        kind: span.kind,
        tier: span.tier,
        name: span.name,
        startTime: span.startTime,
        durationMs: durationOf(span.durationMs),
        selfTimeMs: span.selfTimeMs,
        source: span.source,
      });
    }
  }
  if (spansById.size === 0 && sameCapture && summary.topSpans.length > 0) {
    summaryUsed = true;
    for (const span of summary.topSpans) {
      addSpan({
        eventId: span.id,
        spanId: span.spanId,
        traceId: span.traceId,
        kind: span.kind,
        tier: span.tier,
        name: span.name,
        startTime: span.startTime,
        durationMs: durationOf(span.durationMs),
        selfTimeMs: span.selfTimeMs,
        source: span.source,
      });
    }
  }
  const spans = [...spansById.values()].sort(compareSpans);

  const fromSummary = <T>(own: readonly T[], fallback: () => readonly T[]): readonly T[] => {
    if (own.length > 0 || !sameCapture) {
      return own;
    }
    const rows = fallback();
    if (rows.length > 0) {
      summaryUsed = true;
    }
    return rows;
  };
  const renders = fromSummary(input.renders, () =>
    summary.topRenders.map((stat) => toRenderRow(stat)),
  );
  const requests = fromSummary(input.requests, () =>
    summary.topRequests.map((group, index) => toRequestRow(group, index + 1)),
  );
  const queries = fromSummary(input.queries, () =>
    summary.topQueries.map((group) => toQueryRow(group)),
  );
  const errors = fromSummary<AnalysisErrorRow>(input.errors, () =>
    summary.errors.map((error) => ({
      eventId: error.id,
      spanId: error.spanId,
      traceId: error.traceId,
      kind: error.kind,
      tier: error.tier,
      name: error.name,
      startTime: error.startTime,
      ...(error.source === undefined ? {} : { source: error.source }),
    })),
  );

  return {
    metrics,
    spans,
    renders,
    requests,
    queries,
    errors,
    states: input.stateTransitions,
    statesTruncated: input.truncated.sections.includes('stateTransitions'),
    summaryUsed,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Candidate builders — one fixed, value-substituting template per kind
 * ---------------------------------------------------------------------------------------------- */

/** The evidence seed of one span, with a duration chip label. */
function spanSeed(span: SpanView): EvidenceSeed {
  return {
    eventId: span.eventId,
    traceId: span.traceId,
    spanId: span.spanId,
    kind: span.kind,
    label: `${safeLabel(span.name, 'span', 60)} (${formatMs(span.durationMs)} ms)`,
  };
}

/** ` of the T ms captured` when the total duration is known, else nothing. */
function ofTotal(view: EvidenceView): string {
  const total = view.metrics.get('total_duration');
  return total !== undefined && total > 0 ? ` of the ${formatMs(total)} ms captured` : '';
}

/** The first location among `locations`, in the order given. */
function firstLocation(
  locations: readonly (SourceLocation | undefined)[],
): SourceLocation | undefined {
  for (const location of locations) {
    if (location !== undefined) {
      return location;
    }
  }
  return undefined;
}

/**
 * The location every located item shares (same file and line), when at least
 * one item is located and they all agree; `undefined` otherwise.
 */
function sharedLocation(
  locations: readonly (SourceLocation | undefined)[],
): SourceLocation | undefined {
  let shared: SourceLocation | undefined;
  for (const location of locations) {
    if (location === undefined) {
      continue;
    }
    if (shared === undefined) {
      shared = location;
    } else if (shared.file !== location.file || shared.line !== location.line) {
      return undefined;
    }
  }
  return shared;
}

/** `slowest-span`: the slowest span of each tier. */
function slowestSpanDrafts(view: EvidenceView): CandidateDraft[] {
  const drafts: CandidateDraft[] = [];
  for (const tier of TIER_ORDER) {
    const span = view.spans.find(
      (candidate) => candidate.tier === tier && candidate.durationMs > 0,
    );
    if (span === undefined) {
      continue;
    }
    const name = safeLabel(span.name, 'an unnamed span');
    drafts.push({
      kind: 'slowest-span',
      magnitude: span.durationMs,
      secondary: 0,
      tieBreak: span.eventId,
      statement: `The slowest ${TIER_LABELS[tier]}-tier span was ${name} (${span.kind}), taking ${formatMs(span.durationMs)} ms${ofTotal(view)}.`,
      evidence: [spanSeed(span)],
      value: span.durationMs,
      unit: 'ms',
      location: span.source,
    });
  }
  return drafts;
}

/** `self-time-hotspot`: spans by time not covered by their child spans. */
function selfTimeDrafts(view: EvidenceView): CandidateDraft[] {
  const drafts: CandidateDraft[] = [];
  for (const span of view.spans) {
    const self = span.selfTimeMs === undefined ? 0 : durationOf(span.selfTimeMs);
    if (self <= 0) {
      continue;
    }
    const name = safeLabel(span.name, 'An unnamed span');
    drafts.push({
      kind: 'self-time-hotspot',
      magnitude: self,
      secondary: span.durationMs,
      tieBreak: span.eventId,
      statement: `${name} (${span.kind}, ${TIER_LABELS[span.tier]} tier) spent ${formatMs(self)} ms in its own work, outside the time covered by its child spans.`,
      evidence: [spanSeed(span)],
      value: self,
      unit: 'ms',
      location: span.source,
    });
  }
  return drafts;
}

/** `tier-duration`: the per-tier duration metrics, substantiated by the tier's longest spans. */
function tierDurationDrafts(view: EvidenceView, maxEvidence: number): CandidateDraft[] {
  const drafts: CandidateDraft[] = [];
  for (const { metricId, tier } of TIER_DURATION_METRICS) {
    const value = view.metrics.get(metricId);
    if (value === undefined || value <= 0) {
      continue;
    }
    const spans = sample(
      view.spans.filter((span) => span.tier === tier),
      maxEvidence,
    );
    const first = spans[0];
    if (first === undefined) {
      continue;
    }
    drafts.push({
      kind: 'tier-duration',
      magnitude: value,
      secondary: 0,
      tieBreak: first.eventId,
      statement: `Time attributed to the ${TIER_LABELS[tier]} tier was ${formatMs(value)} ms${ofTotal(view)}.`,
      evidence: spans.map(spanSeed),
      metricId,
      value,
      unit: 'ms',
    });
  }
  return drafts;
}

/** The method and path of a request row, made safe for a statement. */
function requestLabel(row: AnalysisRequestRow): string {
  return `${safeLabel(row.method, 'UNKNOWN', 16)} ${safeLabel(row.path, 'an unnamed path')}`;
}

/** `duplicate-requests`: the largest duplicate window of each duplicated request group. */
function duplicateRequestDrafts(view: EvidenceView): CandidateDraft[] {
  const drafts: CandidateDraft[] = [];
  for (const row of view.requests) {
    if (!row.hasDuplicates) {
      continue;
    }
    let largest: AnalysisRequestRow['duplicateWindows'][number] | undefined;
    for (const window of row.duplicateWindows) {
      if (
        largest === undefined ||
        window.count > largest.count ||
        (window.count === largest.count && window.startTime < largest.startTime)
      ) {
        largest = window;
      }
    }
    const firstId = largest?.eventIds[0];
    if (largest === undefined || largest.count < 2 || firstId === undefined) {
      continue;
    }
    const occurrences = new Map(
      row.occurrences.map((occurrence) => [occurrence.eventId, occurrence]),
    );
    const label = requestLabel(row);
    const identical = row.groupedBy === 'request-key' ? 'identical ' : '';
    const count = wholeCount(largest.count);
    drafts.push({
      kind: 'duplicate-requests',
      magnitude: wholeCount(row.duplicateCount),
      secondary: count,
      tieBreak: firstId,
      statement: `${String(count)} ${identical}${label} requests were issued within ${formatMs(largest.endTime - largest.startTime)} ms; the capture holds ${plural(wholeCount(row.count), 'such request', 'such requests')}, ${String(wholeCount(row.duplicateCount))} of them redundant.`,
      evidence: largest.eventIds.map((eventId) => {
        const occurrence = occurrences.get(eventId);
        return {
          eventId,
          traceId: occurrence?.traceId,
          spanId: occurrence?.spanId,
          label,
        };
      }),
      value: count,
      unit: 'requests',
      location: firstLocation(largest.eventIds.map((eventId) => occurrences.get(eventId)?.source)),
    });
  }
  return drafts;
}

/** `request-initiators`: how many distinct initiators a duplicated request group has. */
function requestInitiatorDrafts(view: EvidenceView, maxEvidence: number): CandidateDraft[] {
  const drafts: CandidateDraft[] = [];
  for (const row of view.requests) {
    const initiators = row.initiators.length;
    const first = row.occurrences[0];
    if (!row.hasDuplicates || initiators === 0 || first === undefined) {
      continue;
    }
    const label = requestLabel(row);
    const atLeast = initiators >= ANALYSIS_INPUT_LIMITS.maxInitiatorsPerGroup ? 'at least ' : '';
    const statement =
      initiators === 1
        ? `The ${String(wholeCount(row.count))} ${label} requests share a single initiator.`
        : `The ${String(wholeCount(row.count))} ${label} requests came from ${atLeast}${String(initiators)} distinct initiators.`;
    drafts.push({
      kind: 'request-initiators',
      magnitude: initiators,
      secondary: wholeCount(row.count),
      tieBreak: first.eventId,
      statement,
      evidence: sample(row.occurrences, maxEvidence).map((occurrence) => ({
        eventId: occurrence.eventId,
        traceId: occurrence.traceId,
        spanId: occurrence.spanId,
        label,
      })),
      value: initiators,
      unit: 'initiators',
      location: sharedLocation(row.occurrences.map((occurrence) => occurrence.source)),
    });
  }
  return drafts;
}

/**
 * The caller that issued the most of a query group's time: summed duration,
 * then executions (both descending), then name, so the choice is total.
 */
function dominantCaller(
  callers: AnalysisQueryRow['callers'],
): AnalysisQueryRow['callers'][number] | undefined {
  let best: AnalysisQueryRow['callers'][number] | undefined;
  for (const caller of callers) {
    if (best === undefined) {
      best = caller;
      continue;
    }
    const ms = durationOf(caller.totalDurationMs);
    const bestMs = durationOf(best.totalDurationMs);
    const count = wholeCount(caller.executionCount);
    const bestCount = wholeCount(best.executionCount);
    if (
      ms > bestMs ||
      (ms === bestMs &&
        (count > bestCount || (count === bestCount && compareStrings(caller.name, best.name) < 0)))
    ) {
      best = caller;
    }
  }
  return best;
}

/**
 * `repeated-query`: one parameterised statement shape executed repeatedly.
 *
 * Ranked by the time the shape took (`magnitude`), then by how often it ran
 * (`secondary`): a statement run as often as another but costing a fraction of
 * its time is the lesser finding, and a count-first order would let it crowd
 * the costly one out of the `maxPerKind` cap. Located at the one call site its
 * located executions share, else at its costliest caller, else at its first
 * located execution.
 */
function repeatedQueryDrafts(view: EvidenceView, maxEvidence: number): CandidateDraft[] {
  const drafts: CandidateDraft[] = [];
  for (const row of view.queries) {
    const executions = wholeCount(row.executionCount);
    const first = row.occurrences[0];
    if (executions < FACT_CANDIDATE_THRESHOLDS.minQueryExecutions || first === undefined) {
      continue;
    }
    const occurrenceSources = row.occurrences.map((occurrence) => occurrence.source);
    const onlyCaller = row.callers.length === 1 ? row.callers[0] : undefined;
    let callerPart = '';
    if (onlyCaller !== undefined) {
      callerPart = `, all from ${safeLabel(onlyCaller.name, 'one caller', 60)}`;
    } else if (row.callers.length > 1) {
      callerPart = `, from ${plural(row.callers.length, 'caller', 'callers')}`;
    }
    const shape = safeLabel(row.statement, 'an unnamed statement');
    drafts.push({
      kind: 'repeated-query',
      magnitude: durationOf(row.totalDurationMs),
      secondary: executions,
      tieBreak: first.eventId,
      statement: `One statement shape ran ${String(executions)} times, taking ${formatMs(row.totalDurationMs)} ms in total (longest ${formatMs(row.maxDurationMs)} ms)${callerPart}: ${shape}`,
      evidence: sample(row.occurrences, maxEvidence).map((occurrence) => ({
        eventId: occurrence.eventId,
        traceId: occurrence.traceId,
        spanId: occurrence.spanId,
        kind: 'db.query',
        label: `statement (${formatMs(occurrence.durationMs)} ms)`,
      })),
      value: executions,
      unit: 'executions',
      location:
        sharedLocation(occurrenceSources) ??
        dominantCaller(row.callers)?.source ??
        firstLocation(occurrenceSources),
    });
  }
  return drafts;
}

/**
 * The render rows a render candidate may be about: the project's own
 * components when any row is marked as declared by the project, every row
 * otherwise.
 *
 * A framework or library component — often minified, placed only through the
 * project component that rendered it — cannot be changed by the developer, and
 * its count is usually the downstream echo of a project component's renders;
 * offering it would crowd out the component the question is about. A capture
 * whose rows carry no ownership (every row `false`, as a statistic persisted
 * before the field existed reads) keeps every row.
 */
function candidateRenderRows(rows: readonly AnalysisRenderRow[]): readonly AnalysisRenderRow[] {
  const declared = rows.filter((row) => row.declaredInProject);
  return declared.length > 0 ? declared : rows;
}

/** Provider names a `dominant-render-trigger` statement lists for a context trigger. */
const MAX_TRIGGER_PROVIDER_NAMES = 3;

/** Characters kept of each provider name in a candidate statement. */
const MAX_PROVIDER_LABEL_LENGTH = 60;

/**
 * The `dominant-render-trigger` statement of one row.
 *
 * For a context trigger with named providers, the trigger phrase is followed
 * by the providers of the contexts that changed, most frequent first — "a
 * changed consumed context value (provided by ‹a›, ‹b›)" — so the statement
 * says which context changed, not only that one did. Providers are dropped
 * from the end until the sentence fits the candidate statement bound, so a
 * long list costs names rather than a cut sentence.
 */
function dominantTriggerStatement(
  row: AnalysisRenderRow,
  entry: (typeof INPUT_TRIGGER_PHRASES)[number],
  dominantCount: number,
): string {
  const component = safeLabel(row.component, 'an unnamed component');
  const sentence = (phrase: string): string =>
    `${String(dominantCount)} of the ${plural(wholeCount(row.renderCount), 'render', 'renders')} of ${component} were triggered by ${phrase}.`;
  if (entry.trigger !== 'context') {
    return sentence(entry.phrase);
  }
  const providers = row.changedContexts
    .slice(0, MAX_TRIGGER_PROVIDER_NAMES)
    .map((context) => safeLabel(context.name, '', MAX_PROVIDER_LABEL_LENGTH))
    .filter((label) => label.length > 0);
  for (let kept = providers.length; kept > 0; kept -= 1) {
    const named = sentence(`${entry.phrase} (provided by ${providers.slice(0, kept).join(', ')})`);
    if (named.length <= FACT_CANDIDATE_LIMITS.maxStatementLength) {
      return named;
    }
  }
  return sentence(entry.phrase);
}

/**
 * Render occurrences as evidence seeds.
 *
 * With no `trigger`, any of the row's renders substantiates a statement about
 * how often the component rendered. With one, only renders **of that trigger**
 * are cited: a sentence counting a component's unchanged-input (or unknown, or
 * context-triggered) renders is never evidenced by renders that had another
 * trigger. When the row carries none of that trigger the seeds are empty and
 * the candidate is withheld rather than cited by contradicting renders; the
 * analysis row's occurrence selection (`selectRenderOccurrences`) keeps one
 * render of every trigger it can, so that only happens when the capture's
 * carried renders include none.
 */
function renderSeeds(
  row: AnalysisRenderRow,
  maxEvidence: number,
  trigger?: RenderTrigger,
): EvidenceSeed[] {
  const chosen =
    trigger === undefined
      ? row.occurrences
      : row.occurrences.filter((occurrence) => occurrence.trigger === trigger);
  const component = safeLabel(row.component, 'component', 60);
  return sample(chosen, maxEvidence).map((occurrence) => ({
    eventId: occurrence.eventId,
    traceId: occurrence.traceId,
    spanId: occurrence.spanId,
    kind: 'render',
    // A coalesced event stands for several renders in one commit and its
    // duration is their total; the chip says so rather than reading as one.
    label:
      occurrence.instanceCount === undefined
        ? `${component} render (${occurrence.trigger}, ${formatMs(occurrence.durationMs)} ms)`
        : `${component} ×${String(occurrence.instanceCount)} renders in one commit (${occurrence.trigger}, ${formatMs(occurrence.durationMs)} ms total)`,
  }));
}

/** `render-outlier`: the components that rendered most often. */
function renderOutlierDrafts(view: EvidenceView, maxEvidence: number): CandidateDraft[] {
  const drafts: CandidateDraft[] = [];
  for (const row of candidateRenderRows(view.renders)) {
    const renders = wholeCount(row.renderCount);
    const first = row.occurrences[0];
    if (renders < FACT_CANDIDATE_THRESHOLDS.minRenders || first === undefined) {
      continue;
    }
    const component = safeLabel(row.component, 'An unnamed component');
    drafts.push({
      kind: 'render-outlier',
      magnitude: renders,
      secondary: durationOf(row.totalDurationMs),
      tieBreak: first.eventId,
      statement: `${component} rendered ${String(renders)} times during the capture, taking ${formatMs(row.totalDurationMs)} ms in total (average ${formatMs(row.averageDurationMs)} ms).`,
      evidence: renderSeeds(row, maxEvidence),
      value: renders,
      unit: 'renders',
      location: row.source,
    });
  }
  return drafts;
}

/** `unchanged-render-burst`: renders with unchanged props, own state and consumed context. */
function unchangedRenderDrafts(view: EvidenceView, maxEvidence: number): CandidateDraft[] {
  const drafts: CandidateDraft[] = [];
  for (const row of candidateRenderRows(view.renders)) {
    const unchanged = wholeCount(row.unchangedRenderCount);
    const first = row.occurrences[0];
    if (unchanged < FACT_CANDIDATE_THRESHOLDS.minUnchangedRenders || first === undefined) {
      continue;
    }
    const component = safeLabel(row.component, 'An unnamed component');
    drafts.push({
      kind: 'unchanged-render-burst',
      magnitude: unchanged,
      secondary: wholeCount(row.renderCount),
      tieBreak: first.eventId,
      statement: `${component} rendered ${String(wholeCount(row.renderCount))} times; ${String(unchanged)} of those renders had shallow-equal props, unchanged own state and no changed consumed context value.`,
      evidence: renderSeeds(row, maxEvidence, 'unchanged'),
      value: unchanged,
      unit: 'renders',
      location: row.source,
    });
  }
  return drafts;
}

/** `dominant-render-trigger`: the input change behind most of a component's renders. */
function dominantTriggerDrafts(view: EvidenceView, maxEvidence: number): CandidateDraft[] {
  const drafts: CandidateDraft[] = [];
  for (const row of candidateRenderRows(view.renders)) {
    const first = row.occurrences[0];
    if (first === undefined) {
      continue;
    }
    let dominant: (typeof INPUT_TRIGGER_PHRASES)[number] | undefined;
    let dominantCount = 0;
    for (const entry of INPUT_TRIGGER_PHRASES) {
      const count = wholeCount(row.triggers[entry.trigger]);
      if (count > dominantCount) {
        dominant = entry;
        dominantCount = count;
      }
    }
    if (dominant === undefined || dominantCount < FACT_CANDIDATE_THRESHOLDS.minTriggerRenders) {
      continue;
    }
    drafts.push({
      kind: 'dominant-render-trigger',
      magnitude: dominantCount,
      secondary: wholeCount(row.renderCount),
      tieBreak: first.eventId,
      statement: dominantTriggerStatement(row, dominant, dominantCount),
      evidence: renderSeeds(row, maxEvidence, dominant.trigger),
      value: dominantCount,
      unit: 'renders',
      location: row.source,
    });
  }
  return drafts;
}

/** `unknown-render-trigger`: renders whose trigger could not be determined. */
function unknownTriggerDrafts(view: EvidenceView, maxEvidence: number): CandidateDraft[] {
  const drafts: CandidateDraft[] = [];
  for (const row of candidateRenderRows(view.renders)) {
    const unknown = wholeCount(row.unknownTriggerCount);
    const first = row.occurrences[0];
    if (unknown < FACT_CANDIDATE_THRESHOLDS.minUnknownTriggerRenders || first === undefined) {
      continue;
    }
    const component = safeLabel(row.component, 'an unnamed component');
    drafts.push({
      kind: 'unknown-render-trigger',
      magnitude: unknown,
      secondary: wholeCount(row.renderCount),
      tieBreak: first.eventId,
      statement: `The trigger could not be determined for ${String(unknown)} of the ${plural(wholeCount(row.renderCount), 'render', 'renders')} of ${component}.`,
      evidence: renderSeeds(row, maxEvidence, 'unknown'),
      value: unknown,
      unit: 'renders',
      location: row.source,
    });
  }
  return drafts;
}

/** `state-transition-burst`: one state hook changing value repeatedly. */
function stateBurstDrafts(view: EvidenceView, maxEvidence: number): CandidateDraft[] {
  const groups = new Map<string, AnalysisStateRow[]>();
  for (const row of view.states) {
    if (!row.changed || row.eventId.length === 0) {
      continue;
    }
    const key = [row.component ?? '', String(row.hookIndex ?? -1), row.hookLabel ?? ''].join(
      '\u0000',
    );
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [row]);
    } else {
      group.push(row);
    }
  }
  const drafts: CandidateDraft[] = [];
  for (const rows of groups.values()) {
    const first = rows[0];
    if (first === undefined || rows.length < FACT_CANDIDATE_THRESHOLDS.minStateChanges) {
      continue;
    }
    const component = safeLabel(first.component ?? '', 'an unnamed component');
    let hook = 'an unlabelled hook';
    if (first.hookLabel !== undefined) {
      hook = safeLabel(first.hookLabel, hook, 60);
    } else if (first.hookIndex !== undefined) {
      hook = `hook #${String(first.hookIndex)}`;
    }
    const atLeast = view.statesTruncated ? 'at least ' : '';
    drafts.push({
      kind: 'state-transition-burst',
      magnitude: rows.length,
      secondary: 0,
      tieBreak: first.eventId,
      statement: `A state hook of ${component} (${hook}) changed value ${atLeast}${String(rows.length)} times during the capture.`,
      evidence: sample(rows, maxEvidence).map((row) => ({
        eventId: row.eventId,
        traceId: row.traceId,
        spanId: row.spanId,
        label: `${component} state change`,
      })),
      value: rows.length,
      unit: 'transitions',
      location: firstLocation(rows.map((row) => row.source)),
    });
  }
  return drafts;
}

/** `long-task`: long tasks and total blocking time, substantiated by the long-task spans. */
function longTaskDrafts(view: EvidenceView, maxEvidence: number): CandidateDraft[] {
  const tasks = view.spans.filter((span) => span.kind === 'perf.longtask');
  const longest = tasks[0];
  const measured = view.metrics.get('long_task_count');
  const count = measured === undefined ? tasks.length : wholeCount(measured);
  if (longest === undefined || count === 0) {
    return [];
  }
  const blocking = view.metrics.get('blocking_time');
  const blockingPart =
    blocking === undefined ? '' : `, and total blocking time was ${formatMs(blocking)} ms`;
  return [
    {
      kind: 'long-task',
      magnitude: count,
      secondary: longest.durationMs,
      tieBreak: longest.eventId,
      statement: `The capture recorded ${plural(count, 'long task', 'long tasks')}; the longest observed took ${formatMs(longest.durationMs)} ms${blockingPart}.`,
      evidence: sample(tasks, maxEvidence).map(spanSeed),
      metricId: 'long_task_count',
      value: count,
      unit: 'tasks',
      location: firstLocation(tasks.map((task) => task.source)),
    },
  ];
}

/** `captured-error`: the failures the capture recorded, earliest first. */
function capturedErrorDrafts(view: EvidenceView, maxEvidence: number): CandidateDraft[] {
  const rows = [...view.errors].sort((left, right) =>
    left.startTime === right.startTime
      ? compareStrings(left.eventId, right.eventId)
      : left.startTime - right.startTime,
  );
  const earliest = rows[0];
  if (earliest === undefined) {
    return [];
  }
  const measured = view.metrics.get('error_count');
  const count = Math.max(measured === undefined ? 0 : wholeCount(measured), rows.length);
  const name = safeLabel(earliest.name, 'an unnamed error');
  return [
    {
      kind: 'captured-error',
      magnitude: count,
      secondary: 0,
      tieBreak: earliest.eventId,
      statement: `The capture recorded ${plural(count, 'error', 'errors')}; the earliest was ${name} (${earliest.kind}, ${TIER_LABELS[earliest.tier]} tier).`,
      evidence: sample(rows, maxEvidence).map((row) => ({
        eventId: row.eventId,
        traceId: row.traceId,
        spanId: row.spanId,
        kind: row.kind,
        label: safeLabel(row.name, 'error', 60),
      })),
      metricId: 'error_count',
      value: count,
      unit: 'errors',
      location: earliest.source,
    },
  ];
}

/* -------------------------------------------------------------------------------------------------
 * Ranking and finalisation
 * ---------------------------------------------------------------------------------------------- */

/** Within-kind order: magnitude, then secondary (both descending), then the tie-break. */
function compareDrafts(left: CandidateDraft, right: CandidateDraft): number {
  if (left.magnitude !== right.magnitude) {
    return right.magnitude - left.magnitude;
  }
  if (left.secondary !== right.secondary) {
    return right.secondary - left.secondary;
  }
  const byTieBreak = compareStrings(left.tieBreak, right.tieBreak);
  return byTieBreak !== 0 ? byTieBreak : compareStrings(left.statement, right.statement);
}

/** A zero-filled per-kind counter. Exhaustive by its annotation. */
function zeroKindCounts(): Record<FactCandidateKind, number> {
  return {
    'slowest-span': 0,
    'self-time-hotspot': 0,
    'tier-duration': 0,
    'duplicate-requests': 0,
    'request-initiators': 0,
    'repeated-query': 0,
    'render-outlier': 0,
    'unchanged-render-burst': 0,
    'dominant-render-trigger': 0,
    'unknown-render-trigger': 0,
    'state-transition-burst': 0,
    'long-task': 0,
    'captured-error': 0,
  };
}

/**
 * One evidence seed as a validated `EventRef`: the display-only coordinates are
 * attached only when they match the trace-context formats, and the result is
 * parsed with the panel schema's own `eventRefSchema`. A seed whose optional
 * fields do not validate is retried with its id alone; one whose id does not
 * validate cannot be cited and yields `undefined`.
 */
function toEventRef(seed: EvidenceSeed): EventRef | undefined {
  const label =
    seed.label === undefined ? '' : capText(seed.label.trim(), MAX_REF_LABEL_LENGTH).trim();
  const full = eventRefSchema.safeParse({
    eventId: seed.eventId,
    ...(seed.traceId !== undefined && isTraceId(seed.traceId) ? { traceId: seed.traceId } : {}),
    ...(seed.spanId !== undefined && isSpanId(seed.spanId) ? { spanId: seed.spanId } : {}),
    ...(seed.kind === undefined ? {} : { kind: seed.kind }),
    ...(label.length === 0 ? {} : { label }),
  });
  if (full.success) {
    return full.data;
  }
  const bare = eventRefSchema.safeParse({ eventId: seed.eventId });
  return bare.success ? bare.data : undefined;
}

/** The outcome of finalising one draft. */
type FinalizedCandidate = {
  readonly candidate: FactCandidate | undefined;
  readonly evidenceTrimmed: boolean;
  readonly statementTrimmed: boolean;
};

/** A finalisation that produced nothing citable. */
const WITHHELD: FinalizedCandidate = Object.freeze({
  candidate: undefined,
  evidenceTrimmed: false,
  statementTrimmed: false,
});

/**
 * A draft as an offered candidate: statement bounded, evidence de-duplicated,
 * validated and capped, location validated, value rounded — then checked with
 * the outbound guard's inspector, so a candidate that would trip the guard is
 * withheld here rather than refused later with the whole prompt.
 */
function finalizeCandidate(
  draft: CandidateDraft,
  id: string,
  rank: number,
  limits: FactCandidateLimits,
): FinalizedCandidate {
  const text = draft.statement.trim();
  const statement = capText(text, limits.maxStatementLength).trim();
  if (statement.length === 0) {
    return WITHHELD;
  }

  const seen = new Set<string>();
  const evidence: EventRef[] = [];
  let citable = 0;
  for (const seed of draft.evidence) {
    if (seen.has(seed.eventId)) {
      continue;
    }
    const ref = toEventRef(seed);
    if (ref === undefined) {
      continue;
    }
    seen.add(seed.eventId);
    citable += 1;
    if (evidence.length < limits.maxEvidencePerCandidate) {
      evidence.push(Object.freeze(ref));
    }
  }
  if (evidence.length === 0) {
    return WITHHELD;
  }

  let location: SourceLocation | undefined;
  if (draft.location !== undefined) {
    const parsed = parseSourceLocation(draft.location);
    location = parsed.ok ? parsed.value : undefined;
  }
  const value =
    draft.value !== undefined && Number.isFinite(draft.value)
      ? roundMs(clampNonNegative(draft.value))
      : undefined;

  const candidate: FactCandidate = Object.freeze({
    id,
    kind: draft.kind,
    statement,
    evidence: Object.freeze(evidence),
    ...(draft.metricId === undefined ? {} : { metricId: draft.metricId }),
    ...(value === undefined ? {} : { value }),
    ...(draft.unit === undefined ? {} : { unit: draft.unit }),
    ...(location === undefined ? {} : { suggestedLocation: Object.freeze(location) }),
    rank,
  });

  const inspection = inspectPayloadReport(candidate);
  if (!inspection.complete || inspection.findings.length > 0) {
    return WITHHELD;
  }
  return {
    candidate,
    evidenceTrimmed: citable > evidence.length,
    statementTrimmed: statement.length < text.length,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Fact candidates
 * ---------------------------------------------------------------------------------------------- */

/**
 * The deterministic fact candidates of one analysis input, with a report of
 * everything the caps and checks left out.
 *
 * Pure: a function of `source` and `options` only, never mutating either,
 * reading no clock and minting no random id, so the same capture yields
 * byte-identical JSON on every run. The developer's question is not read.
 *
 * How the list is formed:
 *
 * 1. Every kind of {@link FACT_CANDIDATE_KINDS} builds its drafts from measured
 *    values of the evidence view, each citing the persisted event ids the
 *    aggregates themselves carry (span rows, render, request and query
 *    occurrences, duplicate windows, state rows, error rows).
 * 2. Each kind is ordered by magnitude with a stable tie-break and capped at
 *    `maxPerKind`.
 * 3. Kinds are interleaved round-robin in vocabulary order — every kind's best
 *    candidate first, then every kind's second — so one heavily populated kind
 *    cannot crowd the others out, and the list is capped at `maxCandidates`.
 * 4. Each candidate's evidence is validated as `EventRef`s and capped, its
 *    statement bounded, and the whole candidate checked with the outbound
 *    guard; a candidate with nothing citable left, or one the guard would
 *    refuse, is withheld.
 *
 * @param source The analysis input and the capture summary.
 * @param options Lower caps, if any.
 * @returns The candidates and the counts of what was cut and why.
 */
export function buildFactCandidateReport(
  source: FactCandidateSource,
  options?: FactCandidateOptions,
): FactCandidateReport {
  const limits = resolveCandidateLimits(options?.limits);
  const view = buildEvidenceView(source);
  const maxEvidence = limits.maxEvidencePerCandidate;

  const drafts: readonly CandidateDraft[] = [
    ...slowestSpanDrafts(view),
    ...selfTimeDrafts(view),
    ...tierDurationDrafts(view, maxEvidence),
    ...duplicateRequestDrafts(view),
    ...requestInitiatorDrafts(view, maxEvidence),
    ...repeatedQueryDrafts(view, maxEvidence),
    ...renderOutlierDrafts(view, maxEvidence),
    ...unchangedRenderDrafts(view, maxEvidence),
    ...dominantTriggerDrafts(view, maxEvidence),
    ...unknownTriggerDrafts(view, maxEvidence),
    ...stateBurstDrafts(view, maxEvidence),
    ...longTaskDrafts(view, maxEvidence),
    ...capturedErrorDrafts(view, maxEvidence),
  ];

  const ranked = new Map<FactCandidateKind, readonly CandidateDraft[]>();
  let droppedByKindLimit = 0;
  let rounds = 0;
  for (const kind of FACT_CANDIDATE_KINDS) {
    const ordered = drafts.filter((draft) => draft.kind === kind).sort(compareDrafts);
    const kept = ordered.slice(0, limits.maxPerKind);
    droppedByKindLimit += ordered.length - kept.length;
    rounds = Math.max(rounds, kept.length);
    ranked.set(kind, kept);
  }

  const candidates: FactCandidate[] = [];
  const kindCounts = zeroKindCounts();
  let droppedByTotalLimit = 0;
  let withheld = 0;
  let evidenceTrimmed = 0;
  let statementsTrimmed = 0;
  for (let round = 0; round < rounds; round += 1) {
    for (const kind of FACT_CANDIDATE_KINDS) {
      const draft = ranked.get(kind)?.[round];
      if (draft === undefined) {
        continue;
      }
      if (candidates.length >= limits.maxCandidates) {
        droppedByTotalLimit += 1;
        continue;
      }
      const finalized = finalizeCandidate(
        draft,
        `fc-${kind}-${String(round + 1)}`,
        candidates.length + 1,
        limits,
      );
      if (finalized.candidate === undefined) {
        withheld += 1;
        continue;
      }
      if (finalized.evidenceTrimmed) {
        evidenceTrimmed += 1;
      }
      if (finalized.statementTrimmed) {
        statementsTrimmed += 1;
      }
      candidates.push(finalized.candidate);
      kindCounts[kind] += 1;
    }
  }

  return Object.freeze({
    candidates: Object.freeze(candidates),
    considered: drafts.length,
    droppedByKindLimit,
    droppedByTotalLimit,
    withheld,
    evidenceTrimmed,
    statementsTrimmed,
    truncated:
      droppedByKindLimit + droppedByTotalLimit + withheld + evidenceTrimmed + statementsTrimmed > 0,
    summaryUsed: view.summaryUsed,
    kindCounts: Object.freeze(kindCounts),
  });
}

/**
 * The deterministic fact candidates the analyze prompt offers the model: the
 * candidate list of {@link buildFactCandidateReport}, as a fresh array.
 *
 * Candidates are inputs, never findings: a model may cite them, and
 * {@link AnalysisFacts.verifyFindings} still resolves every citation it makes.
 *
 * @param source The analysis input and the capture summary.
 * @param options Lower caps, if any.
 * @returns The candidates in rank order.
 */
export function buildFactCandidates(
  source: FactCandidateSource,
  options?: FactCandidateOptions,
): FactCandidate[] {
  return [...buildFactCandidateReport(source, options).candidates];
}

/* -------------------------------------------------------------------------------------------------
 * Verification
 * ---------------------------------------------------------------------------------------------- */

/** One cited reference and the JSON path it sits at. */
type CitedRef = {
  readonly path: string;
  readonly ref: EventRef;
};

/** The identifiers an error or log line may carry about a lookup. */
type LookupScope = {
  readonly sessionId: string;
  readonly captureId?: string | undefined;
};

/** One issue with its fixed reason. */
function issueAt(path: string, code: FactVerificationIssueCode): FactVerificationIssue {
  return Object.freeze({ path, code, reason: FACT_VERIFICATION_ISSUE_REASONS[code] });
}

/** The distinct values, in ascending order. */
function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStrings);
}

/** The session and capture ids, each only when it has the shape of a product-minted id. */
function reportableScope(scope: LookupScope): Record<string, string> {
  return {
    ...(REPORTABLE_ID_PATTERN.test(scope.sessionId) ? { sessionId: scope.sessionId } : {}),
    ...(scope.captureId !== undefined && REPORTABLE_ID_PATTERN.test(scope.captureId)
      ? { captureId: scope.captureId }
      : {}),
  };
}

/**
 * Calls one store port method, turning a throw — a failure the port did not
 * report as a `Result` — and a reported failure alike into a `STORE_ERROR`
 * naming the operation. The caught value is kept as `cause` and never echoed.
 */
function callPort<T>(
  operation: string,
  scope: LookupScope,
  call: () => Result<T, DebuggenError>,
): Result<T, DebuggenError> {
  let result: Result<T, DebuggenError>;
  try {
    result = call();
  } catch (cause) {
    return err(portFailure(operation, scope, cause));
  }
  return result.ok ? result : err(portFailure(operation, scope, result.error));
}

/** The error of a failed store port call. */
function portFailure(operation: string, scope: LookupScope, cause: unknown): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'The session store could not answer an analysis lookup, so nothing was verified or stored.',
    {
      hint: 'Retry the analysis once the session store is available.',
      details: { reason: 'lookup-failed', operation, ...reportableScope(scope) },
      cause,
    },
  );
}

/** Bounds and vocabulary checks the schema also enforces, re-asserted as defence in depth. */
function structuralIssues(findings: AnalysisFindings): FactVerificationIssue[] {
  const issues: FactVerificationIssue[] = [];
  if (findings.observed.length > MAX_SUMMARY_FACTS) {
    issues.push(issueAt('observed', 'list-bounds'));
  }
  if (findings.likelyCauses.length > MAX_SUMMARY_HYPOTHESES) {
    issues.push(issueAt('likelyCauses', 'list-bounds'));
  }
  const checkItem = (item: Pick<Fact, 'statement' | 'evidence'>, path: string): void => {
    if (item.statement.trim().length === 0 || item.statement.length > MAX_STATEMENT_LENGTH) {
      issues.push(issueAt(`${path}.statement`, 'statement-bounds'));
    }
    if (item.evidence.length < 1 || item.evidence.length > MAX_EVIDENCE_REFS) {
      issues.push(issueAt(`${path}.evidence`, 'evidence-bounds'));
    }
  };
  for (const [index, fact] of findings.observed.entries()) {
    checkItem(fact, `observed[${String(index)}]`);
  }
  for (const [index, cause] of findings.likelyCauses.entries()) {
    const path = `likelyCauses[${String(index)}]`;
    checkItem(cause, path);
    if (!isConfidenceLevel(cause.confidence)) {
      issues.push(issueAt(`${path}.confidence`, 'confidence-invalid'));
    }
  }
  return issues;
}

/** Every evidence reference of every observed fact and likely cause, with its path. */
function citedRefs(findings: AnalysisFindings): CitedRef[] {
  const refs: CitedRef[] = [];
  for (const [index, fact] of findings.observed.entries()) {
    for (const [position, ref] of fact.evidence.entries()) {
      refs.push({ path: `observed[${String(index)}].evidence[${String(position)}]`, ref });
    }
  }
  for (const [index, cause] of findings.likelyCauses.entries()) {
    for (const [position, ref] of cause.evidence.entries()) {
      refs.push({ path: `likelyCauses[${String(index)}].evidence[${String(position)}]`, ref });
    }
  }
  return refs;
}

/** An absolute path in the form {@link isWithin} compares, so equality means the same path. */
function comparablePath(absolutePath: string): string {
  return normalizePosix(toPosix(absolutePath));
}

/**
 * Whether the project-relative `file` names a regular file inside
 * `projectRoot` on disk, every symbolic link resolved.
 *
 * Text cannot see a link: `src/link/passwd` passes the lexical gate and opens
 * `/etc/passwd` when `src/link` points at `/etc`. So the root and the target's
 * directory chain are canonicalised with {@link resolveRealPathWithinProject},
 * the target is then canonicalised in full — the editor follows a link at the
 * final component too — and the canonical target must be strictly inside the
 * canonical root and, examined without following, a regular file. A link that
 * stays inside the project is accepted: it names a project file either way.
 *
 * Total: a failed resolution, a throwing or ill-typed port answer and every
 * other failure is `false`. Nothing about the answer — no path, no target, no
 * errno — is kept.
 */
function isProjectFileOnDisk(projectRoot: string, file: string, files: LocationFilePort): boolean {
  try {
    const resolveRealPath: RealPathResolver = (absolutePath) => files.realpath(absolutePath);
    const resolved = resolveRealPathWithinProject(projectRoot, file, resolveRealPath);
    if (!resolved.ok) {
      return false;
    }
    const canonicalTarget: unknown = files.realpath(resolved.value.path);
    if (typeof canonicalTarget !== 'string') {
      return false;
    }
    const root = comparablePath(resolved.value.projectRoot);
    const target = comparablePath(canonicalTarget);
    if (target === root || !isWithin(root, target)) {
      return false;
    }
    const regularFile: unknown = files.isRegularFile(target);
    return regularFile === true;
  } catch {
    // A port that threw is a location that could not be verified, and an
    // unverified location is refused like an escaping one.
    return false;
  }
}

/**
 * Checks every suggested location: a valid `SourceLocation` whose file is a
 * safe project-relative path inside `projectRoot` as text *and* on disk
 * ({@link isProjectFileOnDisk}). The filesystem check runs only once the
 * lexical one passed, reads metadata only, and every failure of either is one
 * `location-outside-project` issue at the location's `file` path.
 */
function locationIssues(
  findings: AnalysisFindings,
  projectRoot: string,
  files: LocationFilePort,
): { readonly issues: FactVerificationIssue[]; readonly checked: number } {
  const issues: FactVerificationIssue[] = [];
  let checked = 0;
  for (const [index, cause] of findings.likelyCauses.entries()) {
    if (cause.suggestedLocation === undefined) {
      continue;
    }
    checked += 1;
    const path = `likelyCauses[${String(index)}].suggestedLocation`;
    const parsed = parseSourceLocation(cause.suggestedLocation);
    if (!parsed.ok) {
      issues.push(issueAt(path, 'location-invalid'));
      continue;
    }
    const file = parsed.value.file;
    const resolved = isSafeRelativePath(file) ? resolveWithinProject(projectRoot, file) : undefined;
    if (
      resolved === undefined ||
      !resolved.ok ||
      !isWithin(projectRoot, resolved.value) ||
      !isProjectFileOnDisk(projectRoot, file, files)
    ) {
      issues.push(issueAt(`${path}.file`, 'location-outside-project'));
    }
  }
  return { issues, checked };
}

/** The refusal of a trace page whose `nextOffset` does not move the walk forward. */
function pageNotAdvancingError(scope: LookupScope): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'The session store returned a trace page that does not advance, so nothing was verified or stored.',
    {
      hint: 'Retry the analysis once the session store is available.',
      details: {
        reason: 'page-not-advancing',
        operation: 'listByTrace',
        ...reportableScope(scope),
      },
    },
  );
}

/**
 * Which of `wanted` are events of `traceId` in the context's capture.
 *
 * Reads the trace page by page through {@link EvidenceLookupPort.listByTrace},
 * narrowed to the capture, from offset zero in the store's stable trace order.
 * The walk is bounded by the trace's own size in the capture: it stops as soon
 * as every wanted id has been seen or at the last page (no `nextOffset`), so a
 * trace of at most {@link TRACE_MEMBERSHIP_PAGE_SIZE} events costs one read. A row
 * counts only when it names both the cited trace and the capture, so a port
 * that ignored the narrowing can cause a rejection, never an acceptance.
 *
 * @param lookup The evidence lookups.
 * @param context The session and capture the findings are verified against.
 * @param scope The reportable identifiers of a failure.
 * @param traceId A cited trace id the capture holds.
 * @param wanted The cited event ids, each already known to exist in the
 * capture, that cite `traceId`.
 * @returns The subset of `wanted` that belongs to the trace, or `Err` when a
 * page could not be read or did not advance: an incomplete walk proves nothing
 * either way.
 */
function traceMembersOf(
  lookup: EvidenceLookupPort,
  context: FactVerificationContext,
  scope: LookupScope,
  traceId: string,
  wanted: ReadonlySet<string>,
): Result<ReadonlySet<string>, DebuggenError> {
  const found = new Set<string>();
  let offset: number | undefined = 0;
  while (offset !== undefined && found.size < wanted.size) {
    const pageOffset: number = offset;
    const page = callPort('listByTrace', scope, () =>
      lookup.listByTrace(context.sessionId, traceId, {
        captureId: context.captureId,
        limit: TRACE_MEMBERSHIP_PAGE_SIZE,
        offset: pageOffset,
      }),
    );
    if (!page.ok) {
      return err(page.error);
    }
    for (const row of page.value.rows) {
      if (row.traceId === traceId && row.captureId === context.captureId && wanted.has(row.id)) {
        found.add(row.id);
      }
    }
    const next = page.value.nextOffset;
    if (next !== undefined && (!Number.isSafeInteger(next) || next <= pageOffset)) {
      return err(pageNotAdvancingError(scope));
    }
    offset = next;
  }
  return ok(found);
}

/**
 * The verification core: every check of {@link AnalysisFacts.verifyFindings}
 * over already-parsed findings, as a report.
 *
 * Each citation is resolved to one captured event and its ids are compared
 * together, not only one by one: the event id must exist in the capture; a
 * cited trace id must exist in the capture *and* the event must be one of that
 * trace's events there (`event-trace-mismatch`); a cited span id must be the
 * cited event's own span (`span-event-mismatch`), recorded in this capture and,
 * when a trace is cited, in that trace. A span record that is the cited event,
 * in this capture and in the cited trace, already proves trace membership, so
 * only citations it does not confirm cost a trace read; a citation whose event
 * or trace does not resolve is reported as unresolved and not also as a
 * mismatch.
 *
 * The span check fails closed. When the port offers no `getBySpanId`
 * (`spanCheck: 'unavailable'`), every citation that carries a span id is
 * reported as `span-unverifiable` at its `spanId` path, so the report is
 * invalid and nothing downstream stores it; its event and trace ids are still
 * checked as usual. Citations without a span id are unaffected.
 *
 * Synchronous and deterministic for a deterministic port; the port is called
 * once for the distinct event ids, once for the distinct trace ids, once per
 * distinct span id, and once per page of each distinct cited trace whose
 * membership still has to be established (see {@link traceMembersOf}).
 * Suggested locations are checked on disk through `files`
 * ({@link locationIssues}).
 *
 * @param findings Findings that passed `parseAnalysisFindings`.
 * @param context The session, capture and project to verify against.
 * @param lookup The evidence lookups.
 * @param files Filesystem metadata for suggested locations; defaults to `node:fs`.
 * @returns The report — valid or not — or `Err` when a lookup failed or a trace
 * page did not advance, in which case nothing can be concluded.
 */
export function collectFactVerificationReport(
  findings: AnalysisFindings,
  context: FactVerificationContext,
  lookup: EvidenceLookupPort,
  files: LocationFilePort = NODE_LOCATION_FILES,
): Result<FactVerificationReport, DebuggenError> {
  const issues = structuralIssues(findings);
  const refs = citedRefs(findings);
  const scope: LookupScope = { sessionId: context.sessionId, captureId: context.captureId };

  const checkedEventIds = sortedUnique(refs.map((cited) => cited.ref.eventId));
  const events =
    checkedEventIds.length === 0
      ? ok<ReadonlySet<string>>(new Set<string>())
      : callPort('existingEventIds', scope, () =>
          lookup.existingEventIds(context.sessionId, checkedEventIds, context.captureId),
        );
  if (!events.ok) {
    return err(events.error);
  }

  const checkedTraceIds = sortedUnique(
    refs.flatMap((cited) => (cited.ref.traceId === undefined ? [] : [cited.ref.traceId])),
  );
  const traces =
    checkedTraceIds.length === 0
      ? ok<ReadonlySet<string>>(new Set<string>())
      : callPort('existingTraceIds', scope, () =>
          lookup.existingTraceIds(context.sessionId, checkedTraceIds, context.captureId),
        );
  if (!traces.ok) {
    return err(traces.error);
  }

  const spanCheck = lookup.getBySpanId === undefined ? 'unavailable' : 'performed';
  const checkedSpanIds =
    spanCheck === 'unavailable'
      ? []
      : sortedUnique(
          refs.flatMap((cited) => (cited.ref.spanId === undefined ? [] : [cited.ref.spanId])),
        );
  const spanRecords = new Map<string, EvidenceSpanRecord | undefined>();
  for (const spanId of checkedSpanIds) {
    const found = callPort('getBySpanId', scope, () =>
      lookup.getBySpanId === undefined
        ? ok<EvidenceSpanRecord | undefined>(undefined)
        : lookup.getBySpanId(context.sessionId, spanId),
    );
    if (!found.ok) {
      return err(found.error);
    }
    spanRecords.set(spanId, found.value);
  }

  /** Whether the span lookup found the cited event itself, in this capture and in the cited trace. */
  const spanConfirmsTrace = (ref: EventRef): boolean => {
    if (ref.spanId === undefined || ref.traceId === undefined) {
      return false;
    }
    const record = spanRecords.get(ref.spanId);
    return (
      record !== undefined &&
      record.id === ref.eventId &&
      record.captureId === context.captureId &&
      record.traceId === ref.traceId
    );
  };

  // Trace membership still to establish: resolved events citing a resolved
  // trace, grouped by trace so each distinct trace is walked once.
  const wantedByTrace = new Map<string, Set<string>>();
  for (const { ref } of refs) {
    if (
      ref.traceId === undefined ||
      !events.value.has(ref.eventId) ||
      !traces.value.has(ref.traceId) ||
      spanConfirmsTrace(ref)
    ) {
      continue;
    }
    const wanted = wantedByTrace.get(ref.traceId) ?? new Set<string>();
    wanted.add(ref.eventId);
    wantedByTrace.set(ref.traceId, wanted);
  }
  const membersByTrace = new Map<string, ReadonlySet<string>>();
  const pendingTraces = [...wantedByTrace.entries()].sort(([left], [right]) =>
    compareStrings(left, right),
  );
  for (const [traceId, wanted] of pendingTraces) {
    const members = traceMembersOf(lookup, context, scope, traceId, wanted);
    if (!members.ok) {
      return err(members.error);
    }
    membersByTrace.set(traceId, members.value);
  }

  for (const { path, ref } of refs) {
    const eventResolved = events.value.has(ref.eventId);
    if (!eventResolved) {
      issues.push(issueAt(`${path}.eventId`, 'event-unresolved'));
    }
    if (ref.traceId !== undefined) {
      if (!traces.value.has(ref.traceId)) {
        issues.push(issueAt(`${path}.traceId`, 'trace-unresolved'));
      } else if (
        eventResolved &&
        !spanConfirmsTrace(ref) &&
        membersByTrace.get(ref.traceId)?.has(ref.eventId) !== true
      ) {
        issues.push(issueAt(`${path}.traceId`, 'event-trace-mismatch'));
      }
    }
    if (ref.spanId !== undefined && spanCheck === 'unavailable') {
      // Fail closed: a span never compared with the cited event is not evidence.
      issues.push(issueAt(`${path}.spanId`, 'span-unverifiable'));
    } else if (ref.spanId !== undefined) {
      const record = spanRecords.get(ref.spanId);
      if (record === undefined) {
        issues.push(issueAt(`${path}.spanId`, 'span-unresolved'));
      } else {
        if (record.captureId !== context.captureId) {
          issues.push(issueAt(`${path}.spanId`, 'span-outside-capture'));
        }
        if (ref.traceId !== undefined && record.traceId !== ref.traceId) {
          issues.push(issueAt(`${path}.spanId`, 'span-trace-mismatch'));
        }
        if (record.id !== ref.eventId) {
          issues.push(issueAt(`${path}.spanId`, 'span-event-mismatch'));
        }
      }
    }
  }

  const locations = locationIssues(findings, context.projectRoot, files);
  issues.push(...locations.issues);

  return ok(
    Object.freeze({
      checkedEventIds: Object.freeze(checkedEventIds),
      unresolvedEventIds: Object.freeze(checkedEventIds.filter((id) => !events.value.has(id))),
      checkedTraceIds: Object.freeze(checkedTraceIds),
      unresolvedTraceIds: Object.freeze(checkedTraceIds.filter((id) => !traces.value.has(id))),
      checkedSpanIds: Object.freeze(checkedSpanIds),
      unresolvedSpanIds: Object.freeze(
        checkedSpanIds.filter((id) => spanRecords.get(id) === undefined),
      ),
      spanCheck,
      checkedLocations: locations.checked,
      issues: Object.freeze(issues),
      valid: issues.length === 0,
    }),
  );
}

/**
 * The rejection of an analysis whose evidence did not verify. Carries JSON
 * paths, issue codes, counts and — only when they have a product-minted or
 * trace-context shape — the unresolved ids; never a statement or a label.
 */
function rejectionError(report: FactVerificationReport, scope: LookupScope): DebuggenError {
  const events = report.unresolvedEventIds.filter((id) => REPORTABLE_ID_PATTERN.test(id));
  const traces = report.unresolvedTraceIds.filter((id) => isTraceId(id));
  const spans = report.unresolvedSpanIds.filter((id) => isSpanId(id));
  const unreportable =
    report.unresolvedEventIds.length -
    events.length +
    (report.unresolvedTraceIds.length - traces.length) +
    (report.unresolvedSpanIds.length - spans.length);
  return new DebuggenError(
    'MODEL_OUTPUT_INVALID',
    `The analysis was rejected: ${plural(report.issues.length, 'evidence check', 'evidence checks')} failed, so no part of it was stored.`,
    {
      hint: "Observed facts and likely causes must cite events present in the capture, with each citation's trace and span ids being those of the cited event, and a suggested location must name a file inside the project. Run the analysis again.",
      details: {
        reason: 'evidence-unverified',
        ...reportableScope(scope),
        issueCount: report.issues.length,
        issueCodes: sortedUnique(report.issues.map((issue) => issue.code)),
        paths: report.issues.slice(0, MAX_REPORTED_ITEMS).map((issue) => issue.path),
        pathsTruncated: report.issues.length > MAX_REPORTED_ITEMS,
        unresolvedEventIdCount: report.unresolvedEventIds.length,
        unresolvedEventIds: events.slice(0, MAX_REPORTED_ITEMS),
        unresolvedTraceIdCount: report.unresolvedTraceIds.length,
        unresolvedTraceIds: traces.slice(0, MAX_REPORTED_ITEMS),
        unresolvedSpanIdCount: report.unresolvedSpanIds.length,
        unresolvedSpanIds: spans.slice(0, MAX_REPORTED_ITEMS),
        unreportableIdCount: unreportable,
      },
    },
  );
}

/** The refusal of a verification context that names no session or no capture. */
function contextError(context: FactVerificationContext): DebuggenError | undefined {
  if (typeof context.sessionId !== 'string' || context.sessionId.trim().length === 0) {
    return new DebuggenError('SESSION_NOT_FOUND', 'No session was named for the analysis.', {
      hint: 'Verify findings against the session whose capture they were drawn from.',
      details: { reason: 'blank-session-id' },
    });
  }
  if (typeof context.captureId !== 'string' || context.captureId.trim().length === 0) {
    return new DebuggenError('SESSION_INVALID_STATE', 'No capture was named for the analysis.', {
      hint: 'Run and stop a capture in this session before analysing it.',
      details: { reason: 'blank-capture-id', ...reportableScope({ sessionId: context.sessionId }) },
    });
  }
  return undefined;
}

/**
 * `metrics` in `METRIC_IDS` order, refusing an id outside the vocabulary or an
 * id given twice — a product defect, since metrics are computed, never
 * proposed. A subset is accepted, as the protocol schema accepts it.
 */
function orderMetrics(metrics: readonly MetricValue[]): Result<MetricValue[], DebuggenError> {
  const byId = new Map<MetricId, MetricValue>();
  for (const metric of metrics) {
    if (!isMetricId(metric.id)) {
      return err(
        new DebuggenError('INTERNAL', 'A metric outside the metric vocabulary was supplied.', {
          details: { reason: 'unknown-metric' },
        }),
      );
    }
    if (byId.has(metric.id)) {
      return err(
        new DebuggenError('INTERNAL', 'A metric was supplied more than once.', {
          details: { reason: 'duplicate-metric', metricId: metric.id },
        }),
      );
    }
    byId.set(metric.id, metric);
  }
  return ok(
    METRIC_IDS.flatMap((id) => {
      const metric = byId.get(id);
      return metric === undefined ? [] : [metric];
    }),
  );
}

/** A version collision on insert, reported as what it is: nothing was overwritten. */
function versionTakenError(result: AnalysisResult, cause: DebuggenError): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'Another analysis was stored for this session at the same version, so this one was not stored.',
    {
      hint: 'Accept the findings again: the next version is always taken from the store, and a stored analysis is never overwritten.',
      details: {
        reason: 'version-taken',
        ...reportableScope({ sessionId: result.sessionId, captureId: result.captureId }),
        analysisVersion: result.analysisVersion,
      },
      cause,
    },
  );
}

/* -------------------------------------------------------------------------------------------------
 * Factory
 * ---------------------------------------------------------------------------------------------- */

/**
 * Creates the analysis-facts subsystem over its injected ports.
 *
 * No state is kept between calls: every method reads what it needs from the
 * ports when it runs, so the object can be shared by the analyze stage, the
 * follow-up stage and panel validation.
 *
 * @param deps The evidence lookups, the analysis store, and optional
 * filesystem port, logger, clock and id generator.
 * @returns The subsystem.
 */
export function createAnalysisFacts(deps: AnalysisFactsDeps): AnalysisFacts {
  const log = (deps.logger ?? noopLogger).child({ [LOG_BINDING_KEYS.subsystem]: SUBSYSTEM });
  const now = (): number => (deps.now === undefined ? nowEpochMs() : deps.now());
  const mintId = (): AnalysisId => (deps.newId === undefined ? newAnalysisId() : deps.newId());

  /** Log fields naming a scope by its reportable ids. */
  const scopeFields = (scope: LookupScope): Record<string, string> => {
    const ids = reportableScope(scope);
    return {
      ...(ids['sessionId'] === undefined ? {} : { [LOG_BINDING_KEYS.sessionId]: ids['sessionId'] }),
      ...(ids['captureId'] === undefined ? {} : { [LOG_BINDING_KEYS.captureId]: ids['captureId'] }),
    };
  };

  const candidatesFor = (
    source: FactCandidateSource,
    options?: FactCandidateOptions,
  ): FactCandidate[] => {
    const report = buildFactCandidateReport(source, options);
    const fields = {
      ...scopeFields({ sessionId: source.input.sessionId, captureId: source.input.captureId }),
      candidates: report.candidates.length,
      considered: report.considered,
      droppedByKindLimit: report.droppedByKindLimit,
      droppedByTotalLimit: report.droppedByTotalLimit,
      withheld: report.withheld,
      evidenceTrimmed: report.evidenceTrimmed,
      statementsTrimmed: report.statementsTrimmed,
      summaryUsed: report.summaryUsed,
    };
    if (report.withheld > 0) {
      log.warn(
        'Fact candidates were withheld: no citable evidence survived validation, or the outbound check refused them.',
        fields,
      );
    } else {
      log.debug('Fact candidates built.', fields);
    }
    return [...report.candidates];
  };

  /** Parse, check the context, and verify: the shared first half of every verifying method. */
  const reportFor = (
    findings: unknown,
    context: FactVerificationContext,
  ): Result<
    { readonly findings: AnalysisFindings; readonly report: FactVerificationReport },
    DebuggenError
  > => {
    const parsed = parseAnalysisFindings(findings);
    if (!parsed.ok) {
      return err(parsed.error);
    }
    const invalidContext = contextError(context);
    if (invalidContext !== undefined) {
      return err(invalidContext);
    }
    const report = collectFactVerificationReport(
      parsed.value,
      context,
      deps.evidence,
      deps.files ?? NODE_LOCATION_FILES,
    );
    if (!report.ok) {
      return err(report.error);
    }
    return ok({ findings: parsed.value, report: report.value });
  };

  const verifyFindings = (
    findings: unknown,
    context: FactVerificationContext,
  ): Promise<Result<AnalysisFindings, DebuggenError>> => {
    const scope: LookupScope = { sessionId: context.sessionId, captureId: context.captureId };
    const outcome = reportFor(findings, context);
    if (!outcome.ok) {
      log.warn('Analysis findings could not be verified.', {
        ...scopeFields(scope),
        code: outcome.error.code,
      });
      return Promise.resolve(err(outcome.error));
    }
    const { report } = outcome.value;
    if (!report.valid) {
      const error = rejectionError(report, scope);
      log.warn('Analysis findings rejected: their evidence did not verify against the capture.', {
        ...scopeFields(scope),
        issueCount: report.issues.length,
        issueCodes: sortedUnique(report.issues.map((issue) => issue.code)),
        unresolvedEventIds: report.unresolvedEventIds.length,
        unresolvedTraceIds: report.unresolvedTraceIds.length,
        unresolvedSpanIds: report.unresolvedSpanIds.length,
      });
      return Promise.resolve(err(error));
    }
    log.debug('Analysis findings verified.', {
      ...scopeFields(scope),
      observed: outcome.value.findings.observed.length,
      likelyCauses: outcome.value.findings.likelyCauses.length,
      checkedEventIds: report.checkedEventIds.length,
      checkedTraceIds: report.checkedTraceIds.length,
      checkedSpanIds: report.checkedSpanIds.length,
      spanCheck: report.spanCheck,
      checkedLocations: report.checkedLocations,
    });
    return Promise.resolve(ok(outcome.value.findings));
  };

  const assembleResult = (input: AssembleAnalysisInput): Result<AnalysisResult, DebuggenError> => {
    const metrics = orderMetrics(input.metrics);
    if (!metrics.ok) {
      return err(metrics.error);
    }
    let assembled: AnalysisResult;
    try {
      assembled = createAnalysisResult(input.findings, {
        id: mintId(),
        sessionId: input.sessionId,
        captureId: input.captureId,
        analysisVersion: input.analysisVersion ?? ANALYSIS_VERSION_START,
        supersedes: input.supersedes,
        createdAt: input.createdAt ?? now(),
        metrics: metrics.value,
      });
    } catch (cause) {
      return err(
        new DebuggenError('INTERNAL', 'The analysis could not be assembled.', {
          details: { reason: 'assembly-failed' },
          cause,
        }),
      );
    }
    const validated = parseAnalysisResult(assembled);
    if (!validated.ok) {
      return err(
        new DebuggenError(
          'INTERNAL',
          'The assembled analysis failed its schema, so it was not stored.',
          {
            hint: 'This is a product defect in the analysis identity or metrics, not in the findings; it is not retried against the model.',
            details: { ...validated.error.details, reason: 'assembled-result-invalid' },
            cause: validated.error,
          },
        ),
      );
    }
    return ok(validated.value);
  };

  const storeResult = (result: AnalysisResult): Promise<Result<AnalysisResult, DebuggenError>> => {
    const scope: LookupScope = { sessionId: result.sessionId, captureId: result.captureId };
    let stored: Result<AnalysisResult, DebuggenError>;
    try {
      stored = deps.store.insertAnalysis(result);
    } catch (cause) {
      return Promise.resolve(err(portFailure('insertAnalysis', scope, cause)));
    }
    if (!stored.ok) {
      const error =
        stored.error.details?.['reason'] === 'version-taken'
          ? versionTakenError(result, stored.error)
          : stored.error;
      log.warn('The analysis was not stored.', {
        ...scopeFields(scope),
        code: error.code,
        analysisVersion: result.analysisVersion,
      });
      return Promise.resolve(err(error));
    }
    log.info('Analysis stored.', {
      ...scopeFields(scope),
      analysisVersion: stored.value.analysisVersion,
      superseding: stored.value.supersedes !== undefined,
      observed: stored.value.observed.length,
      likelyCauses: stored.value.likelyCauses.length,
    });
    return Promise.resolve(ok(stored.value));
  };

  const acceptFindings = async (
    findings: unknown,
    context: AcceptFindingsContext,
  ): Promise<Result<AnalysisResult, DebuggenError>> => {
    const verified = await verifyFindings(findings, context);
    if (!verified.ok) {
      return err(verified.error);
    }
    const scope: LookupScope = { sessionId: context.sessionId, captureId: context.captureId };
    const version = callPort('nextAnalysisVersion', scope, () =>
      deps.store.nextAnalysisVersion(context.sessionId),
    );
    if (!version.ok) {
      return err(version.error);
    }
    if (!Number.isSafeInteger(version.value) || version.value < ANALYSIS_VERSION_START) {
      return err(
        new DebuggenError(
          'STORE_ERROR',
          'The session store reported an unusable analysis version.',
          {
            details: { reason: 'invalid-version', ...reportableScope(scope) },
          },
        ),
      );
    }
    const latest = callPort('getLatestAnalysis', scope, () =>
      deps.store.getLatestAnalysis(context.sessionId),
    );
    if (!latest.ok) {
      return err(latest.error);
    }
    const previous = latest.value;
    if (
      previous !== undefined &&
      (previous.sessionId !== context.sessionId || previous.analysisVersion >= version.value)
    ) {
      return err(
        new DebuggenError(
          'STORE_ERROR',
          "The session's analysis history is inconsistent with its next version, so nothing was stored.",
          { details: { reason: 'history-inconsistent', ...reportableScope(scope) } },
        ),
      );
    }
    const assembled = assembleResult({
      findings: verified.value,
      sessionId: context.sessionId,
      captureId: context.captureId,
      metrics: context.metrics,
      analysisVersion: version.value,
      supersedes: previous?.id,
      createdAt: context.createdAt,
    });
    if (!assembled.ok) {
      log.error('The verified analysis could not be assembled.', {
        ...scopeFields(scope),
        code: assembled.error.code,
      });
      return err(assembled.error);
    }
    return storeResult(assembled.value);
  };

  const createEvidenceResolvers = (
    sessionId: SessionId,
    captureId?: CaptureId,
  ): EvidenceResolvers => {
    const scope: LookupScope = { sessionId, captureId };
    const partition = (
      operation: 'existingEventIds' | 'existingTraceIds',
      ids: readonly string[],
    ): IdResolution => {
      const distinct = sortedUnique(ids);
      if (distinct.length === 0) {
        return { known: new Set<string>(), unknown: new Set<string>() };
      }
      const found = callPort(operation, scope, () =>
        operation === 'existingEventIds'
          ? deps.evidence.existingEventIds(sessionId, distinct, captureId)
          : deps.evidence.existingTraceIds(sessionId, distinct, captureId),
      );
      if (!found.ok) {
        log.warn('An evidence resolver declined to answer: the lookup failed.', {
          ...scopeFields(scope),
          operation,
          code: found.error.code,
        });
        return { known: new Set<string>(), unknown: new Set<string>() };
      }
      const known = new Set<string>();
      const unknown = new Set<string>();
      for (const id of distinct) {
        if (found.value.has(id)) {
          known.add(id);
        } else {
          unknown.add(id);
        }
      }
      return { known, unknown };
    };
    return Object.freeze({
      resolveEventIds: (ids: readonly string[]): IdResolution => partition('existingEventIds', ids),
      resolveTraceIds: (ids: readonly string[]): IdResolution => partition('existingTraceIds', ids),
    });
  };

  const verificationReportFor = (
    findings: unknown,
    context: FactVerificationContext,
  ): Promise<Result<FactVerificationReport, DebuggenError>> => {
    const outcome = reportFor(findings, context);
    return Promise.resolve(outcome.ok ? ok(outcome.value.report) : err(outcome.error));
  };

  const history = (sessionId: SessionId): Result<readonly AnalysisResult[], DebuggenError> =>
    callPort('listAnalyses', { sessionId }, () => deps.store.listAnalyses(sessionId));

  return Object.freeze({
    candidatesFor,
    verifyFindings,
    assembleResult,
    storeResult,
    acceptFindings,
    createEvidenceResolvers,
    verificationReportFor,
    history,
  });
}
