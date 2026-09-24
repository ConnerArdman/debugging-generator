/**
 * Semantic validation of a normalized panel specification **against the capture
 * it claims to describe**: the last step of the panel pipeline, and the second
 * checkpoint on analysis integrity.
 *
 * ## Where this sits
 *
 * A generated panel reaches the screen through a fixed sequence, and nothing
 * skips a step (AAP 0.2.3, AAP 0.5.3):
 *
 * 1. a model's structured output is parsed against the **authoring** schema in
 *    `./input.ts`, with a bounded repair loop on failure;
 * 2. the parsed authoring form is converted by the **deterministic** normaliser
 *    in `./normalize.ts`;
 * 3. the result is validated **syntactically** by `./spec.ts`'s schema and
 *    `./validate.ts`'s whole-document rules;
 * 4. **this module** validates it *against the capture* — "additionally rejects
 *    specs whose evidence references or trace filters do not exist in the
 *    capture" (AAP 0.2.3), which is AAP 0.8.4's re-check of the rule that an
 *    observed fact must cite evidence the capture actually holds. The service's
 *    `apps/local-service/src/analysis/facts.ts` applies that rule first, on the
 *    analysis; this module applies it again on the document built from it,
 *    because a panel is stored, replayed and rendered long after the analysis
 *    that produced it.
 *
 * A document that passed step 3 is *well-formed*. It becomes **true** only
 * here.
 *
 * ## The bounded-summary problem, and why `unverifiable` exists
 *
 * The evidence this module is given is a {@link CaptureSummary} — a **rollup,
 * not an index**. It carries the capture's identity and window, the event and
 * trace counts, per-tier and per-kind tallies, the producer ids, the primary
 * trace, all fourteen metric values, and **bounded top-N sections** (`topSpans`,
 * `topRenders`, `topRequests`, `topQueries`, `errors`), each of which reports
 * its own truncation. It does **not** enumerate every event id in the capture,
 * and it never could: the object is broadcast over a WebSocket and put in front
 * of a model.
 *
 * So an evidence id that does not appear in a top-N section cannot be checked
 * from the summary alone. Three behaviours are available, and only one of them
 * is honest:
 *
 * - answering *valid* would be a **false pass** — a fabricated citation would
 *   reach the screen with the product's authority behind it, which is precisely
 *   the failure this checkpoint exists to prevent;
 * - answering *invalid* would be a **false failure** — every genuine panel
 *   whose facts cite a mid-ranked span would be rejected, and a rejection here
 *   degrades a real run to the deterministic fallback panel
 *   (`apps/local-service/src/panels/fallback.ts`, `meta.fallback = true`), so
 *   an over-strict validator quietly replaces good answers with summaries;
 * - reporting **`unverifiable`** says what is true: everything checkable
 *   passed, and these references could not be checked.
 *
 * That is why {@link SemanticValidationOutcome} has three statuses rather than
 * two, and why a future reader must not collapse it into a boolean. A caller
 * that can do better supplies {@link SemanticValidationOptions.resolveEventIds}
 * — the authoritative lookup the service backs with its `telemetry_events`
 * table — and every reference then resolves to verified or rejected. A caller
 * that demands full verification sets
 * {@link SemanticResultOptions.requireVerifiable}.
 *
 * Two refutations *are* available from the summary alone, and this module takes
 * both, because a check that can be decided should not be deferred:
 *
 * - a capture with `eventCount === 0` holds no events at all, so **any** cited
 *   event id is unknown;
 * - a capture whose published `traceIds` list is complete — `traceIds.length
 *   === traceCount`, the list having not been clipped — refutes a trace id that
 *   is not in it.
 *
 * ## Severity is calibrated against what a rejection costs
 *
 * Four severities, mapped from the closed reason vocabulary by
 * {@link SEMANTIC_ISSUE_SEVERITY_BY_REASON}:
 *
 * - `fatal` — a citation or filter the capture refutes. The panel must not be
 *   shown as an answer.
 * - `unverifiable` — a reference that could not be checked (above).
 * - `advisory` — the capture holds no evidence of the kind a node draws, or
 *   holds records of that kind none of which carries a field the node cannot
 *   draw a record without (its catalog `requiredReads`). **Not fatal by
 *   default**: the node renders its `EmptyState` with a node-specific message,
 *   which is the designed behaviour for "No renders were captured for this
 *   interaction" (AAP 0.6.2). Escalated only under `requireVerifiable`. A
 *   missing *optional* read — a resolved source location, resource timing
 *   behind a request's size — raises nothing at all: the view still draws, and
 *   renders that value as unavailable.
 * - `informational` — a metric the capture could not measure. **Never fatal,
 *   under any option**: `MetricValue.available === false` exists so that an
 *   unobservable metric such as `transferred_bytes` renders as "n/a"
 *   (AAP 0.6.6), and failing a panel for one would fail real panels.
 *
 * ## Privacy: an issue carries shape, never content
 *
 * A panel specification is model-authored prose *about* captured runtime data,
 * and an error built here is logged, may be persisted with the session and
 * travels to both user interfaces through the protocol's `error` payload —
 * passing through neither the redaction layer nor the outbound model guard on
 * the way (AAP 0.5.2). Every issue this module reports is therefore a **path, a
 * code, a reason and — where the issue is about a catalogued node — that node's
 * type**. No rejected value enters one: not an event id, not a trace id, not a
 * metric id, not a fact's statement, not a node's title. A caller that wants
 * the offending value for debugging recomputes it from the path against the
 * specification it already holds.
 *
 * ## Never throws, and never reaches outside itself
 *
 * This runs on a reporting path, where an exception would replace the failure
 * being reported with a crash in the reporter, so every field an issue is about
 * is read at runtime rather than trusted — a specification may have been
 * asserted rather than parsed, and a summary may have arrived over a transport.
 * The resolvers are **caller-supplied callbacks**: this module performs no
 * query, no fetch and no file access, and a resolver that throws or answers
 * with the wrong shape is treated as one that declined to answer.
 *
 * ## Environment-neutral
 *
 * Pure data and pure functions, no platform builtin, no browser global and no
 * import-time side effect: the coordination service validates a generated panel
 * in a Node process, and the DevTools panel and the editor webview validate a
 * stored one in a page.
 *
 * @example
 * ```ts
 * const outcome = validateAgainstCapture(spec, summary, {
 *   resolveEventIds: (ids) => telemetryRepo.partitionKnownEventIds(sessionId, ids),
 * });
 *
 * if (outcome.status === 'invalid') {
 *   log.warn({ issues: outcome.issues }, 'panel cites evidence the capture does not hold');
 *   return fallbackPanelFor(summary);
 * }
 *
 * return spec;
 * ```
 */

import { DebuggenError, err, ok } from '@debuggen/shared';
import type { EventId, Result, SpanId, TraceId } from '@debuggen/shared';
import {
  METRIC_IDS,
  TELEMETRY_KINDS,
  attributeKeysFor,
  isMetricId,
  isTelemetryKind,
  isTelemetryTier,
} from '@debuggen/telemetry';
import type {
  CaptureSummary,
  ErrorSummary,
  MetricId,
  MetricValue,
  QueryGroup,
  QueryOccurrence,
  RenderOccurrence,
  RenderStat,
  RequestGroup,
  RequestOccurrence,
  SpanSummary,
  TelemetryEvent,
  TelemetryKind,
  TelemetryTier,
} from '@debuggen/telemetry';

import { catalogEntryFor, isKnownPanelNodeType } from './catalog.js';
import { isDataQuerySource } from './nodes/query.js';
import type { DataQuery, DataQueryFilter, DataQuerySource } from './nodes/query.js';
import type { MetricCardsNode, QueryBackedNode } from './nodes/viz.js';
import { PANEL_LAYOUT_FIELD, walkPanelNodes } from './spec.js';
import type { PanelNode, PanelNodePath, PanelNodeType, PanelSpec } from './spec.js';
import type { EventRef, Fact, PanelSummary } from './summary.js';
import type { PanelValidationIssueCode } from './validate.js';

/*
 * ---------------------------------------------------------------------------
 * Field names
 *
 * Every path segment this module reports is a `keyof` of the shape it names, so
 * a field renamed in `./spec.ts`, `./summary.ts`, `./nodes/query.ts` or
 * `./nodes/viz.ts` fails the build here instead of silently producing a path
 * that points at nothing.
 * ---------------------------------------------------------------------------
 */

/** The specification field the summary sits in. */
const SUMMARY_FIELD: keyof PanelSpec = 'summary';

/** The specification field that records how a panel came to exist. */
const META_FIELD: keyof PanelSpec = 'meta';

/** The summary field holding the observed facts. */
const OBSERVED_FIELD: keyof PanelSummary = 'observed';

/** The summary field holding the likely causes. */
const LIKELY_CAUSES_FIELD: keyof PanelSummary = 'likelyCauses';

/** The citation list of a fact or a hypothesis. */
const EVIDENCE_FIELD: keyof Fact = 'evidence';

/** The only field of a citation that carries meaning. */
const EVENT_ID_FIELD: keyof EventRef = 'eventId';

/** The trace coordinate a citation may record. */
const EVENT_REF_TRACE_ID_FIELD: keyof EventRef = 'traceId';

/** The span coordinate a citation may record. */
const EVENT_REF_SPAN_ID_FIELD: keyof EventRef = 'spanId';

/** The data request of a query-backed node. */
const NODE_QUERY_FIELD: keyof QueryBackedNode = 'query';

/** The prepared view a query names. */
const QUERY_SOURCE_FIELD: keyof DataQuery = 'source';

/** The narrowing half of a query. */
const QUERY_FILTER_FIELD: keyof DataQuery = 'filter';

/** The filter field that restricts a view to one correlated interaction. */
const FILTER_TRACE_ID_FIELD: keyof DataQueryFilter = 'traceId';

/** The filter field that restricts a view to certain telemetry kinds. */
const FILTER_KINDS_FIELD: keyof DataQueryFilter = 'kinds';

/** The filter field that restricts a view to one tier of the stack. */
const FILTER_TIER_FIELD: keyof DataQueryFilter = 'tier';

/** The discriminator every panel node carries. */
const NODE_TYPE_FIELD: keyof PanelNode = 'type';

/** The metric-tile node's own option: which computed values to show. */
const METRICS_FIELD: keyof MetricCardsNode = 'metrics';

/** The metadata flag that marks a deterministically assembled fallback panel. */
const FALLBACK_FIELD = 'fallback';

/** The source a metric-tile node reads, which needs no per-kind evidence. */
const METRICS_SOURCE: DataQuerySource = 'metrics';

/** The source that resolves to one correlated trace tree. */
const TRACE_SOURCE: DataQuerySource = 'trace';

/*
 * ---------------------------------------------------------------------------
 * Bounds and rendering constants
 * ---------------------------------------------------------------------------
 */

/**
 * How many issues a rejection's `message` names before it counts the rest:
 * **5**, the same bound `./validate.ts` applies.
 *
 * The message is one line in a log and in two user interfaces; the complete
 * list travels in the error's `details`, which `toPayload` does not forward.
 */
const MAX_REPORTED_ISSUES = 5;

/** How an issue about the document itself is rendered in a message. */
const ROOT_PATH_LABEL = '(panel)';

/** The separator that joins a path into the dotted form issues are read in. */
const PATH_SEPARATOR = '.';

/*
 * ---------------------------------------------------------------------------
 * The reason vocabulary
 *
 * Closed, frozen and exported, for the reason `./validate.ts`'s issue codes are:
 * a reason is read by the service that logs a rejection, by the user interface
 * that explains one and by the tests that assert one, and a reason invented at a
 * call site is a reason nobody can switch on.
 *
 * Kebab case, because a reason is a classification a human reads, while the
 * `code` beside it is snake case — the wire form `./validate.ts` and the schema
 * library both use, so a reader of one `issues` array meets one code style
 * whichever validator produced it.
 * ---------------------------------------------------------------------------
 */

/**
 * Every way a well-formed panel can still be untrue of its capture, as a closed
 * readonly tuple.
 *
 * Ordered by what each says about the panel: the citations first, then the trace
 * a view is scoped to, then the computed values a tile row asks for, then the
 * evidence a node needs to draw anything — the records of its kinds, then the
 * fields those records must carry — then the two defensive checks on the
 * summary's own lists.
 */
export const SEMANTIC_ISSUE_REASONS = Object.freeze([
  /** A cited event is not in the capture. Refuted, not merely unproven. */
  'unknown-event-id',
  /** A cited event could not be checked: see this module's documentation. */
  'unverifiable-event-id',
  /**
   * A citation's recorded `traceId` or `spanId` contradicts the coordinates the
   * capture holds for the event it cites.
   */
  'event-ref-mismatch',
  /** A trace named by a filter or a citation is not in the capture. */
  'unknown-trace-id',
  /** A trace named by a filter could not be checked. */
  'unverifiable-trace-id',
  /**
   * A metric id the capture's metric set does not carry — an id outside the
   * fixed vocabulary, or one missing from a summary that should hold all of
   * them.
   */
  'absent-metric',
  /**
   * A metric the capture could not measure. **Informational**: the tile renders
   * as unavailable, which is the designed behaviour (AAP 0.6.6).
   */
  'unavailable-metric',
  /**
   * The capture holds no evidence of the kind this node draws. **Advisory**: the
   * node renders its empty state (AAP 0.6.2).
   */
  'unavailable-source',
  /**
   * The capture holds records of the kind this node draws, but none of them
   * carries an attribute the node cannot draw a record without — the node's
   * catalog `requiredReads` (`./catalog.ts`) — so the view will be empty
   * although its source is not. **Advisory**, like an unavailable source: the
   * node renders its empty state. Never raised for an *optional* read, whose
   * absence renders as unavailable inside a view that still draws.
   */
  'unavailable-field',
  /**
   * A fact or hypothesis with no citation at all. Defensive: `factSchema` bounds
   * `evidence` below by one, so this is unreachable for a specification that
   * passed `./validate.ts`.
   */
  'unevidenced-fact',
  /**
   * The observed list is empty where the caller required findings. Emitted only
   * when {@link SemanticValidationOptions.allowEmptyObserved} is `false`.
   */
  'empty-observed',
] as const);

/**
 * One member of {@link SEMANTIC_ISSUE_REASONS}.
 *
 * Derived from the tuple, so the runtime vocabulary and the static type cannot
 * disagree.
 */
export type SemanticIssueReason = (typeof SEMANTIC_ISSUE_REASONS)[number];

/** Widened view of the tuple, used by {@link isSemanticIssueReason}. */
const REASON_VALUES: readonly string[] = SEMANTIC_ISSUE_REASONS;

/**
 * Whether a value is one of this module's reasons.
 *
 * For the places that classify a reason without a schema at hand: a stored
 * rejection read back out of a session row, a `details` object arriving over the
 * transport, a test narrowing a reason before switching on it.
 *
 * @param value Any value believed to name a semantic validation reason.
 * @returns `true` when `value` is a member of the closed vocabulary.
 */
export function isSemanticIssueReason(value: unknown): value is SemanticIssueReason {
  return typeof value === 'string' && REASON_VALUES.includes(value);
}

/**
 * How much each reason matters. See this module's documentation for the
 * calibration and for why `informational` can never be escalated.
 */
export const SEMANTIC_ISSUE_SEVERITIES = Object.freeze([
  'fatal',
  'unverifiable',
  'advisory',
  'informational',
] as const);

/** One member of {@link SEMANTIC_ISSUE_SEVERITIES}. */
export type SemanticIssueSeverity = (typeof SEMANTIC_ISSUE_SEVERITIES)[number];

/**
 * The severity of each reason, as data rather than as branches.
 *
 * A record over the closed vocabulary, so a reason added above without a
 * severity decision here does not compile — which is the point: the decision
 * "does this fail a panel?" is the one decision in this module a developer must
 * not be able to forget to make.
 */
export const SEMANTIC_ISSUE_SEVERITY_BY_REASON: Readonly<
  Record<SemanticIssueReason, SemanticIssueSeverity>
> = Object.freeze({
  'unknown-event-id': 'fatal',
  'unverifiable-event-id': 'unverifiable',
  'event-ref-mismatch': 'fatal',
  'unknown-trace-id': 'fatal',
  'unverifiable-trace-id': 'unverifiable',
  'absent-metric': 'fatal',
  'unavailable-metric': 'informational',
  'unavailable-source': 'advisory',
  'unavailable-field': 'advisory',
  'unevidenced-fact': 'fatal',
  'empty-observed': 'fatal',
});

/**
 * The code `./validate.ts` already reports for a statement with no citation.
 *
 * Typed as that module's closed code type, so this spelling is checked against
 * its vocabulary by the compiler: **one condition, one code, across both
 * validators**. A reader who greps a log for it finds both checkpoints rather
 * than half of them.
 */
const EVIDENCE_EMPTY_CODE: PanelValidationIssueCode = 'panel_fact_evidence_empty';

/**
 * The snake-case code reported beside each reason.
 *
 * Declared as a map rather than written at each call site so that the two
 * vocabularies cannot drift, and so that the one condition this module shares
 * with `./validate.ts` is reported under the code that module already owns (see
 * {@link EVIDENCE_EMPTY_CODE}).
 */
export const SEMANTIC_ISSUE_CODE_BY_REASON: Readonly<Record<SemanticIssueReason, string>> =
  Object.freeze({
    'unknown-event-id': 'panel_evidence_event_unknown',
    'unverifiable-event-id': 'panel_evidence_event_unverifiable',
    'event-ref-mismatch': 'panel_evidence_ref_mismatch',
    'unknown-trace-id': 'panel_trace_unknown',
    'unverifiable-trace-id': 'panel_trace_unverifiable',
    'absent-metric': 'panel_node_metric_absent',
    'unavailable-metric': 'panel_node_metric_unavailable',
    'unavailable-source': 'panel_node_source_unavailable',
    'unavailable-field': 'panel_node_field_unavailable',
    'unevidenced-fact': EVIDENCE_EMPTY_CODE,
    'empty-observed': 'panel_summary_observed_empty',
  });

/**
 * Every code this module may report, derived from the reason vocabulary in
 * reason order.
 *
 * Exported for the same audience the reasons are: a reader of a stored rejection
 * that holds codes rather than reasons.
 */
export const SEMANTIC_ISSUE_CODES: readonly string[] = Object.freeze(
  SEMANTIC_ISSUE_REASONS.map((reason) => SEMANTIC_ISSUE_CODE_BY_REASON[reason]),
);

/*
 * ---------------------------------------------------------------------------
 * The issue
 * ---------------------------------------------------------------------------
 */

/**
 * One thing a panel says that its capture does not support, reduced to its
 * **structure**.
 *
 * Four fields, and deliberately no fifth: there is no `value`, no `message` and
 * no `expected`, because a panel's content — or the capture's — must not be
 * recoverable from a report about it (AAP 0.5.2, and this module's
 * documentation above).
 */
export interface SemanticIssue {
  /**
   * Where the problem is, as the sequence of property keys and array indices
   * that reaches it.
   *
   * The same {@link PanelNodePath} form `./spec.ts`'s traversal reports, the
   * normaliser derives node ids from and `./validate.ts` reports issues at:
   * `['summary', 'observed', 0, 'evidence', 1, 'eventId']`,
   * `['layout', 0, 'query', 'filter', 'traceId']`, `['layout', 2, 'metrics',
   * 0]`. Joined with `.` it is the dotted path the schema library's own issues
   * use, which is what lets both kinds share one `issues` array.
   */
  readonly path: PanelNodePath;

  /**
   * What is wrong, as the snake-case code
   * {@link SEMANTIC_ISSUE_CODE_BY_REASON} maps {@link reason} to.
   *
   * Typed as `string` so that a consumer reading a rejection back out of a log
   * or a stored row does not have to prove membership before it can hold the
   * value, exactly as `./validate.ts` types its own.
   */
  readonly code: string;

  /**
   * What is wrong, as a member of the closed {@link SEMANTIC_ISSUE_REASONS}
   * vocabulary.
   *
   * This is the field to switch on. It is also the field
   * {@link SEMANTIC_ISSUE_SEVERITY_BY_REASON} is keyed by, so a caller can
   * re-derive how much an issue mattered without consulting which array it was
   * returned in.
   */
  readonly reason: SemanticIssueReason;

  /**
   * The catalogued type of the node the issue is about, where it is about a
   * node.
   *
   * Absent for an issue about the summary, and absent for a node whose type is
   * not in the catalog at all — an unrecognised type string is a rejected
   * *value*, and `./validate.ts` is the checkpoint that rejects it. Present
   * values are members of the closed node-type vocabulary, which is why this
   * field is safe to log and to show.
   */
  readonly nodeType?: PanelNodeType;
}

/*
 * ---------------------------------------------------------------------------
 * Resolvers and options
 * ---------------------------------------------------------------------------
 */

/**
 * What a resolver answers: which of the ids it was asked about exist, and which
 * do not.
 *
 * **Both sets are answers, and an id in neither is a third answer.** A resolver
 * that cannot speak for some ids — a store that paged them out, a lookup that
 * timed out, a caller that resolved only the ids it had cached — simply omits
 * them, and this module reports those as unverifiable rather than inventing a
 * verdict. That is why this is a partition report rather than a predicate.
 */
export interface IdResolution {
  /** The ids the resolver confirmed exist in the capture. */
  readonly known: ReadonlySet<string>;
  /** The ids the resolver confirmed do **not** exist in the capture. */
  readonly unknown: ReadonlySet<string>;
}

/**
 * Resolves event ids against the capture's stored events.
 *
 * Called **once** per validation with every distinct id the specification
 * cites, so a caller backs it with one query rather than one per citation.
 *
 * **Synchronous on purpose.** An asynchronous signature would make this module
 * impure, force every caller and every test into promises, and make a
 * validator's result depend on a clock — for no benefit, because the only
 * caller that has an authoritative index is the coordination service, which
 * holds the capture in a local synchronous store and can pre-resolve in any
 * case. A caller whose lookup *is* asynchronous resolves the ids first (the
 * paths and citations are in the specification it already holds) and hands in a
 * closure over the answer.
 */
export type EventIdResolver = (ids: readonly string[]) => IdResolution;

/** Resolves trace ids against the capture; see {@link EventIdResolver}. */
export type TraceIdResolver = (ids: readonly string[]) => IdResolution;

/**
 * How the capture's records of one kind carry their attribute keys: how many
 * records of the kind there are, and how many of them carry each key with a
 * value.
 *
 * Counts only. A key names a field the telemetry vocabulary declares and a
 * count is a number, so a tally holds the *shape* of a capture and none of its
 * content — the same bound this module's issues are held to.
 */
export interface KindFieldPresence {
  /** How many records of this kind the capture holds. */
  readonly events: number;
  /**
   * For each attribute key carried by at least one record of this kind, how
   * many records carry it with a value — one that is not `undefined`, not
   * `null` and not the empty string. A key absent from this record is carried
   * by none of them.
   */
  readonly attributes: Readonly<Record<string, number>>;
  /**
   * For each attribute key carried *as text* by at least one record of this
   * kind, how many records carry it as a string of at least one character.
   *
   * This is the count a required attribute key is checked against, because it
   * is the predicate the aggregates that refuse a record apply: the query
   * aggregate groups a database span only by a `db.statement` that is a string
   * of positive length, so a numeric value under that key is carried in
   * {@link attributes} and still forms no row, while a whitespace-only string
   * does form one. A key absent from this record is carried as text by none of
   * them.
   */
  readonly text: Readonly<Record<string, number>>;
}

/**
 * Per-kind attribute presence over a capture's records, as
 * {@link tallyFieldPresence} computes it. A kind absent from the record is one
 * the capture holds no record of.
 *
 * This is what a {@link CaptureSummary} does not publish: the rollup counts
 * records per kind but not which of their attributes are populated, so only a
 * caller that holds the records — the coordination service, over its stored
 * events — can supply it. The field-availability check consults it only where
 * the summary's own aggregate results leave the question open: an aggregate's
 * published verdict on the records it formed rows from is the more direct
 * answer, and a tally never overrides it.
 */
export type CaptureFieldPresence = Readonly<Partial<Record<TelemetryKind, KindFieldPresence>>>;

/**
 * How an outcome is mapped onto a {@link Result}.
 *
 * Declared separately from {@link SemanticValidationOptions}, which extends it,
 * so that {@link toResult} can be handed either the full options object the
 * collection used or just this one decision.
 */
export interface SemanticResultOptions {
  /**
   * Whether an unverifiable reference is treated as a failure. Defaults to
   * **`false`**.
   *
   * Who sets it: a strict service configuration that supplies a resolver and
   * therefore expects every reference to be decided, and an integration test
   * that asserts a panel is fully substantiated. Leaving it `false` is the
   * production default, because an unverifiable reference is a limit of the
   * bounded summary rather than a defect in the panel (see this module's
   * documentation), and failing on one would degrade real runs to the fallback
   * panel.
   *
   * Escalation covers the `unverifiable` and `advisory` severities. It never
   * covers `informational`: a metric the capture could not measure is not a
   * defect under any configuration.
   */
  readonly requireVerifiable?: boolean;
}

/** How {@link validateAgainstCapture} and {@link collectSemanticIssues} behave. */
export interface SemanticValidationOptions extends SemanticResultOptions {
  /**
   * The authoritative lookup for cited event ids. Optional; see
   * {@link EventIdResolver}.
   *
   * Supplied, every citation resolves to verified or rejected. Omitted, a
   * citation the bounded summary cannot attest to is reported as unverifiable.
   */
  readonly resolveEventIds?: EventIdResolver;

  /**
   * The authoritative lookup for trace ids named by a node's filter or a
   * citation. Optional; see {@link TraceIdResolver}.
   */
  readonly resolveTraceIds?: TraceIdResolver;

  /**
   * Whether a panel with no observed facts is acceptable. Defaults to
   * **`true`**.
   *
   * `true` by default because an empty observed list is legitimate: the
   * deterministic fallback panel of AAP 0.5.5 carries prose and views with no
   * model-derived facts at all, and `panelSummarySchema` admits one. A caller
   * validating a *model-authored* panel may set it to `false` to require
   * findings.
   *
   * Even then, a panel whose `meta.fallback` is `true` is exempt: such a
   * document is defined by the fallback path to have no model-derived facts, so
   * requiring them of it would reject the very panel that exists to be shown
   * when nothing else could be.
   */
  readonly allowEmptyObserved?: boolean;

  /**
   * Which attribute keys the capture's records actually carry, per kind.
   * Optional; build it with {@link tallyFieldPresence} over the capture's
   * events.
   *
   * The summary answers the field-availability question first, from the
   * aggregate results it publishes (see {@link collectSemanticIssues}); where
   * those leave it open, a supplied tally decides it: a node whose kinds are
   * present but none of whose records carries a key in the node's catalog
   * `requiredReads` as text is reported as `unavailable-field`. Omitted, a
   * question the summary leaves open stays open.
   */
  readonly fieldPresence?: CaptureFieldPresence;
}

/*
 * ---------------------------------------------------------------------------
 * The outcome
 * ---------------------------------------------------------------------------
 */

/** The three answers this module can give; see {@link SemanticValidationOutcome}. */
export const SEMANTIC_VALIDATION_STATUSES = Object.freeze([
  'valid',
  'unverifiable',
  'invalid',
] as const);

/** One member of {@link SEMANTIC_VALIDATION_STATUSES}. */
export type SemanticValidationStatus = (typeof SEMANTIC_VALIDATION_STATUSES)[number];

/**
 * Everything the panel claims is supported by the capture.
 *
 * Carries no issue list: advisory and informational notes are available from
 * {@link collectSemanticIssues} for a caller that wants them, and a valid
 * outcome deliberately has nothing a caller must inspect.
 */
export interface SemanticValidationValid {
  readonly status: 'valid';
}

/**
 * Nothing the capture can speak to is wrong, but some references could not be
 * checked.
 *
 * **Not a failure.** The panel may be shown; the listed references are the ones
 * a resolver would decide. See this module's documentation for why this status
 * exists at all.
 */
export interface SemanticValidationUnverifiable {
  readonly status: 'unverifiable';
  /** The references that could not be checked. Never empty. */
  readonly unverifiable: readonly SemanticIssue[];
}

/**
 * The panel says something its capture refutes. It must not be shown as an
 * answer (AAP 0.5.5): the caller logs the issues and shows the deterministic
 * fallback panel instead.
 */
export interface SemanticValidationInvalid {
  readonly status: 'invalid';
  /** Why the panel was rejected. Never empty. */
  readonly issues: readonly SemanticIssue[];
  /**
   * The references that could not be checked, reported alongside the rejection
   * rather than folded into it — unless `requireVerifiable` escalated them, in
   * which case they appear in both arrays and `issues` is what rejected the
   * panel.
   */
  readonly unverifiable: readonly SemanticIssue[];
}

/**
 * What {@link validateAgainstCapture} answers: a discriminated union on
 * `status`, so a `switch` over it is exhaustively checkable and no caller can
 * read `issues` off an outcome that has none.
 */
export type SemanticValidationOutcome =
  SemanticValidationValid | SemanticValidationUnverifiable | SemanticValidationInvalid;

/**
 * Every issue found, partitioned by severity.
 *
 * One array per severity rather than one flat list with a severity field,
 * because the boundary decision — which issues reject a panel — is then a
 * concatenation rather than a filter, and a reader of {@link
 * validateAgainstCapture} can see the whole rule at a glance. Each array is
 * sorted deterministically (see {@link collectSemanticIssues}).
 */
export interface SemanticIssueSets {
  /** Refutations: the capture contradicts what the panel says. */
  readonly issues: readonly SemanticIssue[];
  /** References the bounded summary could not check. */
  readonly unverifiable: readonly SemanticIssue[];
  /**
   * Nodes whose evidence the capture does not hold. Non-fatal by default,
   * escalated under `requireVerifiable`.
   */
  readonly advisory: readonly SemanticIssue[];
  /** Notes that never fail a panel, under any option. */
  readonly informational: readonly SemanticIssue[];
}

/*
 * ---------------------------------------------------------------------------
 * Internal helpers
 *
 * Two of them exist because this module cannot trust the static type of what it
 * is given. It accepts a {@link PanelSpec} and a {@link CaptureSummary}, but a
 * caller may hold either as a value that was asserted rather than parsed — a row
 * read out of a JSON column, a fixture built by hand, a payload cast on arrival
 * — and the checks below are precisely the ones that are meaningless if a
 * field's presence is taken on trust. So every field an issue is *about* is read
 * as `unknown` and classified at runtime, which is also what lets this module
 * promise never to throw.
 * ---------------------------------------------------------------------------
 */

/**
 * Whether a value is an array, narrowing to an array of `unknown`.
 *
 * A type predicate rather than a bare `Array.isArray` call, because that call
 * narrows an `unknown` to `any[]` and every element read from it would then be
 * an `any` flowing into a typed parameter — both unsafe and a lint failure.
 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Whether a value is a non-null object, narrowing it for {@link ownField}. */
function isObjectLike(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads one **own** property of an object as an untyped value.
 *
 * Own rather than inherited, so nothing reaches a check through
 * `Object.prototype`: a specification or a summary that arrived as JSON can
 * carry a `"constructor"` key, and a prototype hit would let a node look as
 * though it carried a `query` it never declared.
 *
 * @param value The object to read from.
 * @param key The property name.
 * @returns That own property's value, or `undefined` when it is not declared.
 */
function ownField(value: object, key: string): unknown {
  const record = value as unknown as Record<string, unknown>;

  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Reads an own property of a value that may not be an object at all. */
function fieldOf(value: unknown, key: string): unknown {
  return isObjectLike(value) ? ownField(value, key) : undefined;
}

/**
 * Reads an own property as a **non-blank** string, or `undefined`.
 *
 * Blank is treated as absent deliberately: an identifier of whitespace cannot
 * be looked up, and carrying it forward would produce a rejection about a value
 * that names nothing.
 */
function stringFieldOf(value: unknown, key: string): string | undefined {
  const read = fieldOf(value, key);

  if (typeof read !== 'string' || read.trim().length === 0) {
    return undefined;
  }

  return read;
}

/** Reads an own property as a finite number, or `undefined`. */
function numberFieldOf(value: unknown, key: string): number | undefined {
  const read = fieldOf(value, key);

  return typeof read === 'number' && Number.isFinite(read) ? read : undefined;
}

/**
 * Joins a path into the dotted form the schema library's own issues use, so
 * both kinds of report read the same way.
 *
 * Returns the empty string for an empty path, exactly as `./summary.ts`'s
 * `describeIssues` does for an issue about the document itself.
 */
function joinPath(path: PanelNodePath): string {
  return path.map((segment) => String(segment)).join(PATH_SEPARATOR);
}

/**
 * Builds one issue.
 *
 * The `reason` parameter is typed to the closed vocabulary, so every issue this
 * module raises is checked against {@link SEMANTIC_ISSUE_REASONS} at compile
 * time and the code beside it is looked up rather than spelled. The node type is
 * attached only when there is one, rather than set to `undefined`: the package
 * compiles under `exactOptionalPropertyTypes`, and an absent key is what a JSON
 * round-trip of a stored rejection preserves.
 */
function issueAt(
  reason: SemanticIssueReason,
  path: PanelNodePath,
  nodeType?: PanelNodeType,
): SemanticIssue {
  const code = SEMANTIC_ISSUE_CODE_BY_REASON[reason];

  return nodeType === undefined ? { path, code, reason } : { path, code, reason, nodeType };
}

/**
 * Orders two path segments totally: numbers before strings, then by value.
 *
 * A total order is what makes the sort deterministic across runs, which is the
 * property the issue arrays promise — a report that reordered itself between two
 * runs over the same input could not be asserted on, diffed or deduplicated.
 */
function compareSegments(left: string | number, right: string | number): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }

  if (typeof left === 'number') {
    return -1;
  }

  if (typeof right === 'number') {
    return 1;
  }

  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Orders two issues by path, then by code, then by reason: a total order over
 * everything an issue carries that is not derived.
 */
function compareIssues(left: SemanticIssue, right: SemanticIssue): number {
  const shared = Math.min(left.path.length, right.path.length);

  for (let index = 0; index < shared; index += 1) {
    const leftSegment = left.path[index];
    const rightSegment = right.path[index];

    // Unreachable while `index < shared`; indexed reads are typed as possibly
    // absent under `noUncheckedIndexedAccess` and this is how that is honoured
    // without an assertion.
    if (leftSegment === undefined || rightSegment === undefined) {
      break;
    }

    const bySegment = compareSegments(leftSegment, rightSegment);

    if (bySegment !== 0) {
      return bySegment;
    }
  }

  if (left.path.length !== right.path.length) {
    return left.path.length - right.path.length;
  }

  if (left.code !== right.code) {
    return left.code < right.code ? -1 : 1;
  }

  return left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0;
}

/** Sorts a list of issues into the deterministic order above. Never mutates. */
function sortIssues(issues: readonly SemanticIssue[]): readonly SemanticIssue[] {
  return [...issues].sort(compareIssues);
}

/*
 * ---------------------------------------------------------------------------
 * The capture, as this module can read it
 *
 * Every field name below is a `keyof` of the telemetry package's own declared
 * shape, so a field renamed there fails the build here rather than turning this
 * module into one that quietly attests to nothing.
 * ---------------------------------------------------------------------------
 */

/** `traceIds` on the summary: the distinct traces, clipped and flagged. */
const SUMMARY_TRACE_IDS_FIELD: keyof CaptureSummary = 'traceIds';

/** `traceCount` on the summary: how many traces the capture holds. */
const SUMMARY_TRACE_COUNT_FIELD: keyof CaptureSummary = 'traceCount';

/** `primaryTraceId` on the summary: the trace a single-interaction view scopes to. */
const SUMMARY_PRIMARY_TRACE_ID_FIELD: keyof CaptureSummary = 'primaryTraceId';

/** `eventCount` on the summary: how many events it was computed from. */
const SUMMARY_EVENT_COUNT_FIELD: keyof CaptureSummary = 'eventCount';

/** `kindCounts` on the summary: events per kind, zero-filled. */
const SUMMARY_KIND_COUNTS_FIELD: keyof CaptureSummary = 'kindCounts';

/** `tierCounts` on the summary: events per tier, zero-filled. */
const SUMMARY_TIER_COUNTS_FIELD: keyof CaptureSummary = 'tierCounts';

/** `metrics` on the summary: all fourteen values, in vocabulary order. */
const SUMMARY_METRICS_FIELD: keyof CaptureSummary = 'metrics';

/** The five bounded sections whose records name events the capture holds. */
const SUMMARY_TOP_SPANS_FIELD: keyof CaptureSummary = 'topSpans';

/** See {@link SUMMARY_TOP_SPANS_FIELD}. */
const SUMMARY_ERRORS_FIELD: keyof CaptureSummary = 'errors';

/** See {@link SUMMARY_TOP_SPANS_FIELD}. */
const SUMMARY_TOP_RENDERS_FIELD: keyof CaptureSummary = 'topRenders';

/** See {@link SUMMARY_TOP_SPANS_FIELD}. */
const SUMMARY_TOP_REQUESTS_FIELD: keyof CaptureSummary = 'topRequests';

/** See {@link SUMMARY_TOP_SPANS_FIELD}. */
const SUMMARY_TOP_QUERIES_FIELD: keyof CaptureSummary = 'topQueries';

/**
 * `truncated` on the summary: whether any bounded section — or the published
 * trace list — was clipped. `false` is what lets an empty section be read as
 * "the aggregate formed no group at all" rather than as "none made the cut".
 */
const SUMMARY_TRUNCATED_FIELD: keyof CaptureSummary = 'truncated';

/**
 * What a summary publishes about the result of the aggregate behind one
 * record-grouping source.
 *
 * Both halves are that aggregate's own output, computed over **every** record
 * of the capture, which is what makes them the authoritative answer to "did the
 * aggregate form a row from any record": the aggregate applies its own
 * usable-record predicate — the query aggregate forms no group for a database
 * span without a statement string — and the summary publishes what it formed.
 */
interface SummaryAggregateEvidence {
  /**
   * The bounded section holding the aggregate's leading groups. Non-empty
   * proves a group formed; empty proves none did only while the summary reports
   * that nothing it published was clipped.
   */
  readonly section: keyof CaptureSummary;
  /**
   * The metric that counts what the aggregate's groups account for, over the
   * whole capture and whatever the sections clipped. Present only where the
   * metric is defined as exactly that sum — `query_count` is the executions the
   * query groups account for (`packages/telemetry/src/aggregate/summary.ts`), so
   * an available `0` beside a non-zero `db.query` tally says the aggregate
   * formed no group at all, in a capture whose clipped `topSpans` set the
   * summary's global `truncated` flag. Typed as the telemetry package's metric
   * vocabulary, so a renamed id fails the build here.
   */
  readonly groupCountMetric?: MetricId;
}

/**
 * The summary evidence each record-grouping source is summarised into, as data.
 *
 * A source absent here has no summary section, and the field-availability
 * question for it is left to {@link SemanticValidationOptions.fieldPresence}.
 * `renders` and `requests` carry no group-count metric: their metrics count
 * records or occurrences rather than exactly what their groups account for, and
 * neither node requires an attribute key today, so their sections alone are
 * recorded.
 */
const SUMMARY_EVIDENCE_BY_SOURCE: Readonly<
  Partial<Record<DataQuerySource, SummaryAggregateEvidence>>
> = Object.freeze({
  renders: Object.freeze({ section: SUMMARY_TOP_RENDERS_FIELD }),
  requests: Object.freeze({ section: SUMMARY_TOP_REQUESTS_FIELD }),
  queries: Object.freeze({ section: SUMMARY_TOP_QUERIES_FIELD, groupCountMetric: 'query_count' }),
});

/** `kind` on a telemetry event, the key a presence tally is grouped by. */
const EVENT_KIND_FIELD: keyof TelemetryEvent = 'kind';

/** `attributes` on a telemetry event, the bag a presence tally counts keys in. */
const EVENT_ATTRIBUTES_FIELD: keyof TelemetryEvent = 'attributes';

/** `events` on one kind's presence tally. */
const PRESENCE_EVENTS_FIELD: keyof KindFieldPresence = 'events';

/** `text` on one kind's presence tally: the carriers a required key is checked against. */
const PRESENCE_TEXT_FIELD: keyof KindFieldPresence = 'text';

/** `id` on a metric value, matched against a tile row's requested ids. */
const METRIC_VALUE_ID_FIELD: keyof MetricValue = 'id';

/** `available` on a metric value: whether the capture could measure it at all. */
const METRIC_VALUE_AVAILABLE_FIELD: keyof MetricValue = 'available';

/** `value` on a metric value: the measurement, present when it is available. */
const METRIC_VALUE_VALUE_FIELD: keyof MetricValue = 'value';

/**
 * `id` on a summarised span or failure — which *is* the event's id, and
 * therefore the reference a fact cites.
 *
 * Deliberately **not** read off a group: `RenderStat.id`, `RequestGroup.id` and
 * `QueryGroup.id` are group identities (`'render:<component>'` and the like),
 * and attesting to one as an event id would verify a citation the capture never
 * held. Groups are read through their `occurrences` only.
 */
const RECORD_ID_FIELD: keyof SpanSummary & keyof ErrorSummary = 'id';

/** `eventId` on a bounded occurrence of a render, request or query group. */
const RECORD_EVENT_ID_FIELD: keyof RenderOccurrence &
  keyof RequestOccurrence &
  keyof QueryOccurrence = 'eventId';

/** `traceId` on a summarised span, failure or occurrence. */
const RECORD_TRACE_ID_FIELD: keyof SpanSummary &
  keyof ErrorSummary &
  keyof RenderOccurrence &
  keyof RequestOccurrence &
  keyof QueryOccurrence = 'traceId';

/** `spanId` on a summarised span, failure or occurrence. */
const RECORD_SPAN_ID_FIELD: keyof SpanSummary &
  keyof ErrorSummary &
  keyof RenderOccurrence &
  keyof RequestOccurrence &
  keyof QueryOccurrence = 'spanId';

/**
 * `transferEventId` on a request occurrence: the resource-timing event a byte
 * figure was read from, which is an event of this capture like any other.
 */
const RECORD_TRANSFER_EVENT_ID_FIELD: keyof RequestOccurrence = 'transferEventId';

/** `occurrences` on a render, request or query group. */
const GROUP_OCCURRENCES_FIELD: keyof RenderStat & keyof RequestGroup & keyof QueryGroup =
  'occurrences';

/** `traceIds` on a query group: the traces the statement ran in. */
const GROUP_TRACE_IDS_FIELD: keyof QueryGroup = 'traceIds';

/** Where the capture places an event, as far as the summary records it. */
interface EventCoordinates {
  /** The trace the event belongs to, when the summary recorded it. */
  readonly traceId?: TraceId;
  /** The span the event is, when the summary recorded it. */
  readonly spanId?: SpanId;
}

/**
 * What a {@link CaptureSummary} can attest to, extracted once per validation.
 *
 * Built in a single pass so that a specification citing fifty events costs one
 * traversal of the summary rather than fifty.
 */
interface CaptureIndex {
  /**
   * The events the summary names, mapped to the coordinates it recorded for
   * them.
   *
   * **A bounded set, and its absence proves nothing** — see this module's
   * documentation. In an ordinary summary this holds the slowest spans, the
   * failures and the sampled occurrences of the published groups. Render
   * occurrences are normally *not* among them: `computeCaptureSummary`
   * aggregates renders counts-only, because the per-render lists belong to the
   * `renders` panel-data source rather than to a payload that crosses a socket.
   * A fact citing a render is therefore unverifiable without a resolver, which
   * is exactly the case this module refuses to guess about.
   */
  readonly events: ReadonlyMap<EventId, EventCoordinates>;

  /** Every trace id the summary names, from its list and from its records. */
  readonly traceIds: ReadonlySet<string>;

  /**
   * Whether {@link traceIds} is the capture's **complete** trace list, so a
   * trace id absent from it is genuinely absent from the capture.
   *
   * True when the summary published as many distinct trace ids as it counted
   * and named no further trace in its records. The published list is clipped at
   * `DEFAULT_MAX_TRACE_IDS`, so this is false for a capture with more traces
   * than that — and then a trace id can only be refuted by a resolver.
   */
  readonly traceListComplete: boolean;

  /**
   * Whether the capture holds any events at all.
   *
   * `false` refutes **every** citation without a resolver, and it is the one
   * event-level refutation the summary supports on its own. Requires both a
   * zero count and an empty attested set, so a self-contradictory summary
   * produces no rejection rather than a spurious one.
   */
  readonly hasEvents: boolean;
}

/**
 * Absorbs one list of records that name events — a bounded section's rows, or
 * one group's sampled occurrences.
 *
 * Reads `eventId` first and falls back to `id`, which is how one code path
 * serves `SpanSummary` and `ErrorSummary` (whose `id` is the event's) and the
 * three occurrence shapes (whose `eventId` and `id` are equal by construction).
 */
function absorbRecords(
  records: unknown,
  events: Map<string, EventCoordinates>,
  traceIds: Set<string>,
): void {
  if (!isUnknownArray(records)) {
    return;
  }

  for (const record of records) {
    if (!isObjectLike(record)) {
      continue;
    }

    const traceId = stringFieldOf(record, RECORD_TRACE_ID_FIELD);
    const spanId = stringFieldOf(record, RECORD_SPAN_ID_FIELD);

    if (traceId !== undefined) {
      traceIds.add(traceId);
    }

    const eventId =
      stringFieldOf(record, RECORD_EVENT_ID_FIELD) ?? stringFieldOf(record, RECORD_ID_FIELD);

    if (eventId !== undefined) {
      events.set(eventId, {
        ...(traceId !== undefined ? { traceId } : {}),
        ...(spanId !== undefined ? { spanId } : {}),
      });
    }

    // The joined resource-timing entry is an event of this capture, but its
    // coordinates are the *request's*, not its own, so none are recorded for it:
    // attesting to an existence is safe, attesting to a position would not be.
    const transferEventId = stringFieldOf(record, RECORD_TRANSFER_EVENT_ID_FIELD);

    if (transferEventId !== undefined && !events.has(transferEventId)) {
      events.set(transferEventId, {});
    }
  }
}

/** Absorbs a bounded section of groups through their occurrences and traces. */
function absorbGroups(
  groups: unknown,
  events: Map<string, EventCoordinates>,
  traceIds: Set<string>,
): void {
  if (!isUnknownArray(groups)) {
    return;
  }

  for (const group of groups) {
    if (!isObjectLike(group)) {
      continue;
    }

    absorbRecords(ownField(group, GROUP_OCCURRENCES_FIELD), events, traceIds);

    const groupTraceIds = ownField(group, GROUP_TRACE_IDS_FIELD);

    if (!isUnknownArray(groupTraceIds)) {
      continue;
    }

    for (const candidate of groupTraceIds) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        traceIds.add(candidate);
      }
    }
  }
}

/** Builds the {@link CaptureIndex} for one summary. Never throws. */
function indexCapture(summary: CaptureSummary): CaptureIndex {
  const events = new Map<string, EventCoordinates>();
  const traceIds = new Set<string>();
  const published = new Set<string>();

  const publishedList = fieldOf(summary, SUMMARY_TRACE_IDS_FIELD);

  if (isUnknownArray(publishedList)) {
    for (const candidate of publishedList) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        published.add(candidate);
        traceIds.add(candidate);
      }
    }
  }

  const primaryTraceId = stringFieldOf(summary, SUMMARY_PRIMARY_TRACE_ID_FIELD);

  if (primaryTraceId !== undefined) {
    traceIds.add(primaryTraceId);
  }

  absorbRecords(fieldOf(summary, SUMMARY_TOP_SPANS_FIELD), events, traceIds);
  absorbRecords(fieldOf(summary, SUMMARY_ERRORS_FIELD), events, traceIds);
  absorbGroups(fieldOf(summary, SUMMARY_TOP_RENDERS_FIELD), events, traceIds);
  absorbGroups(fieldOf(summary, SUMMARY_TOP_REQUESTS_FIELD), events, traceIds);
  absorbGroups(fieldOf(summary, SUMMARY_TOP_QUERIES_FIELD), events, traceIds);

  const traceCount = numberFieldOf(summary, SUMMARY_TRACE_COUNT_FIELD);
  const eventCount = numberFieldOf(summary, SUMMARY_EVENT_COUNT_FIELD);

  // Complete only if the published list accounts for every trace the summary
  // counted *and* nothing in its records named a trace the list omits. The
  // second half is what keeps a clipped or inconsistent summary from refuting a
  // trace it simply did not publish.
  const traceListComplete =
    traceCount !== undefined && published.size === traceCount && traceIds.size === published.size;

  return {
    events,
    traceIds,
    traceListComplete,
    hasEvents: eventCount === undefined || eventCount > 0 || events.size > 0,
  };
}

/*
 * ---------------------------------------------------------------------------
 * Resolvers, defensively
 * ---------------------------------------------------------------------------
 */

/** The `known` half of a resolution, as a field name the compiler checks. */
const RESOLUTION_KNOWN_FIELD: keyof IdResolution = 'known';

/** The `unknown` half of a resolution, as a field name the compiler checks. */
const RESOLUTION_UNKNOWN_FIELD: keyof IdResolution = 'unknown';

/** The answer used when no resolver was supplied, or when one declined. */
const EMPTY_RESOLUTION: IdResolution = Object.freeze({
  known: new Set<string>(),
  unknown: new Set<string>(),
});

/**
 * Copies a set-like answer into this module's own `Set` of strings.
 *
 * Copying rather than holding the caller's object is deliberate on two counts:
 * a resolver cannot mutate the answer after the verdicts have been drawn from
 * it, and every membership test afterwards runs against a native `Set` rather
 * than a foreign `has` that could throw halfway through a report.
 *
 * @returns The copied set, or `undefined` when the value is not iterable — a
 * resolver that answered with the wrong shape is one that declined to answer.
 */
function copyIdSet(value: unknown): Set<string> | undefined {
  if (!isObjectLike(value)) {
    return undefined;
  }

  const iterator = (value as Partial<Iterable<unknown>>)[Symbol.iterator];

  if (typeof iterator !== 'function') {
    return undefined;
  }

  const copied = new Set<string>();

  for (const member of value as Iterable<unknown>) {
    if (typeof member === 'string') {
      copied.add(member);
    }
  }

  return copied;
}

/**
 * Asks a resolver about every gathered id at once, tolerating any answer.
 *
 * A resolver that throws, returns a non-object, or returns neither half in a
 * readable shape is treated as one that declined: the ids stay unresolved and
 * are reported as unverifiable. This module is on a reporting path and must not
 * turn a caller's bug into a crash inside the reporter.
 */
function resolveIds(
  resolver: ((ids: readonly string[]) => IdResolution) | undefined,
  ids: readonly string[],
): IdResolution {
  if (resolver === undefined || ids.length === 0) {
    return EMPTY_RESOLUTION;
  }

  let answer: unknown;

  try {
    answer = resolver(ids);
  } catch {
    return EMPTY_RESOLUTION;
  }

  const known = copyIdSet(fieldOf(answer, RESOLUTION_KNOWN_FIELD));
  const resolvedUnknown = copyIdSet(fieldOf(answer, RESOLUTION_UNKNOWN_FIELD));

  if (known === undefined && resolvedUnknown === undefined) {
    return EMPTY_RESOLUTION;
  }

  return { known: known ?? new Set<string>(), unknown: resolvedUnknown ?? new Set<string>() };
}

/** What a resolution says about one id. */
type ResolvedVerdict = 'known' | 'unknown' | 'unresolved';

/**
 * Reads one id's verdict out of a resolution.
 *
 * An id in **both** halves is a resolver contradicting itself, and the honest
 * reading of a contradiction is that the id was not decided — reporting it as
 * either verified or rejected would pick one of two answers at random.
 */
function verdictFor(resolution: IdResolution, id: string): ResolvedVerdict {
  const confirmed = resolution.known.has(id);
  const refuted = resolution.unknown.has(id);

  if (confirmed && refuted) {
    return 'unresolved';
  }

  if (confirmed) {
    return 'known';
  }

  return refuted ? 'unknown' : 'unresolved';
}

/*
 * ---------------------------------------------------------------------------
 * Gathering: what the specification claims
 *
 * Two passes, and the split is not incidental. The resolvers are called **once**
 * with every distinct id a specification names, so everything that has to be
 * asked about is gathered before anything is decided. A per-citation lookup
 * would turn one query into fifty on the only path where a store is involved.
 * ---------------------------------------------------------------------------
 */

/** One citation, as gathered from a fact or a hypothesis. */
interface Citation {
  /** Path of the reference object itself, without a field appended. */
  readonly path: PanelNodePath;
  /** The cited event's id. Absent when the reference carried none readable. */
  readonly eventId?: string;
  /** The trace coordinate the reference recorded, when it did. */
  readonly traceId?: string;
  /** The span coordinate the reference recorded, when it did. */
  readonly spanId?: string;
}

/** One trace id a node's filter scopes its view to. */
interface TraceFilterUse {
  /** Path of the `filter.traceId` field. */
  readonly path: PanelNodePath;
  /** The node whose filter named it, for the issue's `nodeType`. */
  readonly nodeType: PanelNodeType;
  /** The trace id named. */
  readonly traceId: string;
}

/**
 * The issues decidable without a resolver: the summary's own two defensive
 * checks, the metric ids a tile row asks for, and per-node evidence
 * availability.
 */
interface DecidedWhileGathering {
  /** Refutations found without consulting a resolver. */
  readonly fatal: readonly SemanticIssue[];
  /** Nodes whose evidence the capture does not hold. */
  readonly advisory: readonly SemanticIssue[];
  /** Metrics the capture could not measure. */
  readonly informational: readonly SemanticIssue[];
}

/** Everything gathered from a specification before any resolver is consulted. */
interface GatheredClaims {
  /** Every citation in the summary's two lists, observed first. */
  readonly citations: readonly Citation[];
  /** Every trace id a node's filter scopes to. */
  readonly traceFilters: readonly TraceFilterUse[];
  /** What could already be decided; see {@link DecidedWhileGathering}. */
  readonly decided: DecidedWhileGathering;
}

/**
 * Gathers the citations of one statement list, and the statements that have
 * none.
 *
 * Read entirely through the untyped helpers, for the reason this module's helper
 * section records: a statement that is not an object at all, or an `evidence`
 * that is not an array, is a *shape* failure `./spec.ts`'s schema owns, and
 * reporting a semantic verdict about it would describe the wrong problem. Such a
 * statement is skipped rather than rejected — except for the one case that *is*
 * this module's business, an evidence list that is absent or empty.
 */
function gatherCitations(
  statements: unknown,
  basePath: PanelNodePath,
  citations: Citation[],
  unevidenced: PanelNodePath[],
): void {
  if (!isUnknownArray(statements)) {
    return;
  }

  for (const [statementIndex, statement] of statements.entries()) {
    if (!isObjectLike(statement)) {
      continue;
    }

    const evidencePath: PanelNodePath = [...basePath, statementIndex, EVIDENCE_FIELD];
    const evidence = ownField(statement, EVIDENCE_FIELD);

    if (!isUnknownArray(evidence) || evidence.length === 0) {
      unevidenced.push(evidencePath);
      continue;
    }

    for (const [refIndex, ref] of evidence.entries()) {
      if (!isObjectLike(ref)) {
        continue;
      }

      const eventId = stringFieldOf(ref, EVENT_ID_FIELD);
      const traceId = stringFieldOf(ref, EVENT_REF_TRACE_ID_FIELD);
      const spanId = stringFieldOf(ref, EVENT_REF_SPAN_ID_FIELD);

      citations.push({
        path: [...evidencePath, refIndex],
        ...(eventId !== undefined ? { eventId } : {}),
        ...(traceId !== undefined ? { traceId } : {}),
        ...(spanId !== undefined ? { spanId } : {}),
      });
    }
  }
}

/*
 * ---------------------------------------------------------------------------
 * Node-level checks that need no resolver
 * ---------------------------------------------------------------------------
 */

/** Reads one per-kind tally, or `undefined` when the summary has none. */
function kindCountOf(summary: CaptureSummary, kind: TelemetryKind): number | undefined {
  return numberFieldOf(fieldOf(summary, SUMMARY_KIND_COUNTS_FIELD), kind);
}

/** Reads one per-tier tally, or `undefined` when the summary has none. */
function tierCountOf(summary: CaptureSummary, tier: TelemetryTier): number | undefined {
  return numberFieldOf(fieldOf(summary, SUMMARY_TIER_COUNTS_FIELD), tier);
}

/**
 * Whether the capture holds at least one event of any of these kinds.
 *
 * `undefined` means "the summary does not say", which is never treated as an
 * absence: a partial summary must not produce advisories about evidence it
 * simply did not publish.
 */
function holdsAnyKind(
  summary: CaptureSummary,
  kinds: readonly TelemetryKind[],
): boolean | undefined {
  let total = 0;
  let known = false;

  for (const kind of kinds) {
    const count = kindCountOf(summary, kind);

    if (count !== undefined) {
      known = true;
      total += count;
    }
  }

  return known ? total > 0 : undefined;
}

/**
 * Checks that the capture holds the evidence a node needs — records of its
 * kinds, carrying the fields it cannot draw a record without — and that its
 * filter does not narrow to nothing.
 *
 * This is AAP 0.7.1's "catalog `reads` fields available", answered in two
 * steps against the catalog entry for the node's type:
 *
 * 1. **Records.** The *kinds* the entry declares, which that module documents
 *    as the set a capture-aware validator checks a capture's per-kind tallies
 *    against. A capture holding none of them is `unavailable-source`, and that
 *    is the whole finding: an empty capture is reported once, never also as a
 *    missing field.
 * 2. **Required fields.** The attribute keys in the entry's `requiredReads` —
 *    the keys the aggregate behind the node refuses a record without, the query
 *    table's statement being the one the catalog holds today. Records of the
 *    node's kinds that all lack such a key make a view as empty as no records
 *    at all, so that is `unavailable-field`, at the same `query.source` path.
 *    Answered first from what the summary publishes about the aggregate behind
 *    the node's source — its unbounded group-count metric, then its bounded
 *    section — because that is the aggregate's own verdict, reached with its
 *    own usable-record predicate over every record; then, where the summary
 *    leaves it open, from {@link SemanticValidationOptions.fieldPresence}.
 *    Every other case is left open rather than guessed. The entry's *optional*
 *    reads are never checked: a missing source location or resource-timing
 *    entry renders as unavailable inside a view that still draws.
 *
 * Only a node that requires a query is asked either question: a container or a
 * source-link leaf reads no captured data, so there is nothing to be
 * unavailable. The kind groups and field names are never spelled here — they
 * arrive through the catalog entry, which takes them from `@debuggen/telemetry`
 * (AAP 0.2.3).
 *
 * **Advisory, not fatal.** A node whose evidence the capture lacks renders its
 * empty state with a node-specific message — "No renders were captured for this
 * interaction" — and that is the designed behaviour (AAP 0.6.2), not a reason to
 * replace a whole panel with a fallback. Only `requireVerifiable` escalates it.
 */
function collectAvailabilityIssues(
  node: PanelNode,
  path: PanelNodePath,
  type: PanelNodeType,
  summary: CaptureSummary,
  index: CaptureIndex,
  fieldPresence: unknown,
): readonly SemanticIssue[] {
  const entry = catalogEntryFor(type);

  if (!entry.requiresQuery) {
    return [];
  }

  const query = ownField(node, NODE_QUERY_FIELD);
  const source = fieldOf(query, QUERY_SOURCE_FIELD);

  // A missing query or an unrecognised source is `./validate.ts`'s rejection,
  // reported there as a structural issue. Nothing is added here, and — on a
  // reporting path — nothing is read off it either.
  if (!isObjectLike(query) || !isDataQuerySource(source)) {
    return [];
  }

  const sourcePath: PanelNodePath = [...path, NODE_QUERY_FIELD, QUERY_SOURCE_FIELD];
  const unavailable = sourceEvidenceMissing(entry.telemetryKinds, source, summary, index);

  if (unavailable) {
    return [issueAt('unavailable-source', sourcePath, type)];
  }

  const filterIssues = collectFilterAvailabilityIssues(query, path, type, summary);

  if (
    requiredFieldsMissing(entry.telemetryKinds, entry.requiredReads, source, summary, fieldPresence)
  ) {
    return [issueAt('unavailable-field', sourcePath, type), ...filterIssues];
  }

  return filterIssues;
}

/**
 * The required reads of a node that are attribute keys, each with the node's
 * kinds that declare it.
 *
 * A required read no declared kind carries is an event field — every stored
 * record has one, so there is nothing to check — and is skipped; `catalog.test.ts`
 * pins that no required *attribute* key sits outside the entry's own kinds, so
 * nothing checkable is lost that way.
 */
function requiredAttributeKeysByKind(
  telemetryKinds: readonly TelemetryKind[],
  requiredReads: readonly string[],
): readonly { readonly key: string; readonly kinds: readonly TelemetryKind[] }[] {
  const required: { readonly key: string; readonly kinds: readonly TelemetryKind[] }[] = [];

  for (const key of requiredReads) {
    const kinds = telemetryKinds.filter((kind) => attributeKeysFor(kind).includes(key));

    if (kinds.length > 0) {
      required.push({ key, kinds });
    }
  }

  return required;
}

/**
 * Whether the capture's records of a node's kinds lack a key the node cannot
 * draw a record without.
 *
 * Each required attribute key is decided on its own, first from the summary's
 * published aggregate result and then, where that leaves it open, from the
 * caller's presence tally; a key both leave open contributes nothing.
 *
 * The order is the point. The aggregate that serves the node decides what it
 * draws, with its own predicate for a usable record, and the summary publishes
 * that decision; a tally counts key presence, which can only approximate the
 * predicate. So a tally never overrides a verdict the summary already reached —
 * in either direction — and is consulted only for a summary that published no
 * decisive aggregate result.
 */
function requiredFieldsMissing(
  telemetryKinds: readonly TelemetryKind[],
  requiredReads: readonly string[],
  source: DataQuerySource,
  summary: CaptureSummary,
  fieldPresence: unknown,
): boolean {
  for (const { key, kinds } of requiredAttributeKeysByKind(telemetryKinds, requiredReads)) {
    const verdict =
      requiredKeyMissingFromSummary(summary, source, kinds) ??
      requiredKeyMissingFromPresence(fieldPresence, kinds, key);

    if (verdict === true) {
      return true;
    }
  }

  return false;
}

/**
 * Whether a presence tally shows records of these kinds, none of which carries
 * `key` as text.
 *
 * Read from the tally's {@link KindFieldPresence.text} counts rather than its
 * generic `attributes` counts, because a required attribute key is one its
 * aggregate refuses a record without, and the refusal is a text predicate: the
 * query aggregate keys a group on a `db.statement` string of positive length,
 * so a number under that key forms no row and a whitespace-only string forms
 * one.
 *
 * `true` when the readable tallies hold at least one record and not one
 * carrier; `false` when any record carries the key; `undefined` when no tally
 * for these kinds is readable — absent, malformed or negative — so the question
 * stays open rather than being answered from bad input. A readable tally whose
 * `text` record lacks the key is a count of zero carriers, exactly as
 * {@link tallyFieldPresence} writes it.
 */
function requiredKeyMissingFromPresence(
  fieldPresence: unknown,
  kinds: readonly TelemetryKind[],
  key: string,
): boolean | undefined {
  if (!isObjectLike(fieldPresence)) {
    return undefined;
  }

  try {
    return readPresenceVerdict(fieldPresence, kinds, key);
  } catch {
    // A tally whose fields throw on read — a revoked proxy, a throwing trap —
    // is treated as a tally that declined to answer, exactly as a throwing
    // resolver is: the question stays open, and the walk over the remaining
    // nodes is not cut short by it.
    return undefined;
  }
}

/** The body of {@link requiredKeyMissingFromPresence}, over a tally known to be an object. */
function readPresenceVerdict(
  fieldPresence: object,
  kinds: readonly TelemetryKind[],
  key: string,
): boolean | undefined {
  let records = 0;
  let carriers = 0;
  let readable = false;

  for (const kind of kinds) {
    const tally = ownField(fieldPresence, kind);
    const events = numberFieldOf(tally, PRESENCE_EVENTS_FIELD);
    const textCarriers = fieldOf(tally, PRESENCE_TEXT_FIELD);

    if (
      events === undefined ||
      events < 0 ||
      !isObjectLike(textCarriers) ||
      isUnknownArray(textCarriers)
    ) {
      continue;
    }

    const carried = ownField(textCarriers, key);
    const count = carried === undefined ? 0 : carried;

    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
      continue;
    }

    readable = true;
    records += events;
    carriers += count;
  }

  if (!readable) {
    return undefined;
  }

  return records > 0 && carriers === 0;
}

/**
 * Reads one metric's measured count off a summary, or `undefined` when the
 * summary does not publish it as an available, finite, non-negative number.
 *
 * An unavailable metric, a missing value or a malformed entry is "the summary
 * does not say", never a zero: reading a zero into a metric that was not
 * measured would manufacture the very refutation this module refuses to guess.
 */
function availableMetricCountOf(summary: CaptureSummary, metricId: MetricId): number | undefined {
  const published = fieldOf(summary, SUMMARY_METRICS_FIELD);

  if (!isUnknownArray(published)) {
    return undefined;
  }

  const metric = published.find(
    (candidate) => stringFieldOf(candidate, METRIC_VALUE_ID_FIELD) === metricId,
  );

  if (metric === undefined || fieldOf(metric, METRIC_VALUE_AVAILABLE_FIELD) !== true) {
    return undefined;
  }

  const count = numberFieldOf(metric, METRIC_VALUE_VALUE_FIELD);

  return count !== undefined && count >= 0 ? count : undefined;
}

/**
 * Whether the summary shows records of these kinds that the node's aggregate
 * formed no group from — the aggregate's own verdict, as the summary publishes
 * it.
 *
 * Decided only where the capture holds records of the kinds, by the strongest
 * evidence the summary carries, in this order:
 *
 * 1. a **non-empty section** proves the aggregate formed a group: `false`;
 * 2. an available **group-count metric**, computed over the whole capture
 *    whatever the sections clipped, answers exactly: `0` is `true`, anything
 *    more is `false`. This is what decides an ordinary capture, whose slowest
 *    spans outnumber the section bound and so set the summary's global
 *    `truncated` flag although no query group exists at all;
 * 3. an **empty section** in a summary that reports nothing clipped: `true`.
 *
 * Every other case — an unreadable section, an unavailable metric beside a
 * clipped summary, per-kind tallies that do not say, a source the summary has
 * no section for — is `undefined`, left open, because a rollup that did not
 * publish something is not evidence that it is absent.
 */
function requiredKeyMissingFromSummary(
  summary: CaptureSummary,
  source: DataQuerySource,
  kinds: readonly TelemetryKind[],
): boolean | undefined {
  const evidence = SUMMARY_EVIDENCE_BY_SOURCE[source];

  if (evidence === undefined || holdsAnyKind(summary, kinds) !== true) {
    return undefined;
  }

  const section = fieldOf(summary, evidence.section);

  if (isUnknownArray(section) && section.length > 0) {
    return false;
  }

  const groupCount =
    evidence.groupCountMetric === undefined
      ? undefined
      : availableMetricCountOf(summary, evidence.groupCountMetric);

  if (groupCount !== undefined) {
    return groupCount === 0;
  }

  if (isUnknownArray(section) && fieldOf(summary, SUMMARY_TRUNCATED_FIELD) === false) {
    return true;
  }

  return undefined;
}

/**
 * Whether the capture holds nothing a node of this type could draw from this
 * source.
 *
 * Three questions, in order of how specifically they can be answered: the kinds
 * the node declares, then the one source whose unit is a trace rather than a
 * record, then the capture as a whole. `metrics` is exempt — all fourteen values
 * are computed for every capture, and an unmeasurable one is reported through
 * its own `available` flag rather than as a missing source.
 */
function sourceEvidenceMissing(
  telemetryKinds: readonly TelemetryKind[],
  source: DataQuerySource,
  summary: CaptureSummary,
  index: CaptureIndex,
): boolean {
  if (source === METRICS_SOURCE) {
    return false;
  }

  if (telemetryKinds.length > 0) {
    return holdsAnyKind(summary, telemetryKinds) === false;
  }

  if (source === TRACE_SOURCE) {
    return index.traceIds.size === 0 && numberFieldOf(summary, SUMMARY_TRACE_COUNT_FIELD) === 0;
  }

  return !index.hasEvents;
}

/**
 * Checks that a node's filter does not narrow its source to nothing.
 *
 * The same advisory severity and the same reason as an unavailable source, at
 * the filter field that caused it: a `kinds` list the capture has no events for,
 * or a `tier` that produced none, is a view that will render empty however much
 * the source holds. Reported at most once per filter, because two ways of saying
 * "this narrowing matches nothing" are one finding.
 */
function collectFilterAvailabilityIssues(
  query: object,
  path: PanelNodePath,
  type: PanelNodeType,
  summary: CaptureSummary,
): readonly SemanticIssue[] {
  const filter = ownField(query, QUERY_FILTER_FIELD);

  if (!isObjectLike(filter)) {
    return [];
  }

  const filterPath: PanelNodePath = [...path, NODE_QUERY_FIELD, QUERY_FILTER_FIELD];
  const kinds = ownField(filter, FILTER_KINDS_FIELD);

  if (isUnknownArray(kinds) && kinds.length > 0) {
    const named = kinds.filter((candidate): candidate is TelemetryKind =>
      isTelemetryKind(candidate),
    );

    if (named.length > 0 && holdsAnyKind(summary, named) === false) {
      return [issueAt('unavailable-source', [...filterPath, FILTER_KINDS_FIELD], type)];
    }
  }

  const tier = ownField(filter, FILTER_TIER_FIELD);

  if (isTelemetryTier(tier) && tierCountOf(summary, tier) === 0) {
    return [issueAt('unavailable-source', [...filterPath, FILTER_TIER_FIELD], type)];
  }

  return [];
}

/**
 * Checks a metric-tile node's requested ids against the capture's metric set.
 *
 * Two different findings, with deliberately different severities:
 *
 * - an id the capture's metric set does not carry is **fatal**: the tile has
 *   nothing to render, and the refutation is sound because a
 *   {@link CaptureSummary} publishes all {@link METRIC_IDS} by invariant. An id
 *   outside the vocabulary altogether is caught here as well as by
 *   `./validate.ts`, which asks the *syntactic* half of the same question;
 * - a metric whose `available` flag is `false` is **informational and never
 *   fails a panel**. That flag exists precisely so an unobservable metric such
 *   as transferred bytes renders as "n/a" (AAP 0.6.6), and rejecting a panel for
 *   one would reject real panels for telling the truth about a limitation.
 *
 * When the summary publishes no readable metric list at all, the presence half
 * is skipped rather than turned into fourteen rejections: such a summary is
 * malformed rather than informative, and this module does not manufacture
 * refutations out of missing input.
 */
function collectMetricIssues(
  node: PanelNode,
  path: PanelNodePath,
  type: PanelNodeType,
  summary: CaptureSummary,
): { readonly fatal: readonly SemanticIssue[]; readonly informational: readonly SemanticIssue[] } {
  const requested = ownField(node, METRICS_FIELD);

  if (!isUnknownArray(requested)) {
    return { fatal: [], informational: [] };
  }

  const published = fieldOf(summary, SUMMARY_METRICS_FIELD);
  const values = isUnknownArray(published) ? published : undefined;
  const fatal: SemanticIssue[] = [];
  const informational: SemanticIssue[] = [];

  for (const [metricIndex, candidate] of requested.entries()) {
    const metricPath: PanelNodePath = [...path, METRICS_FIELD, metricIndex];

    if (!isMetricId(candidate)) {
      fatal.push(issueAt('absent-metric', metricPath, type));
      continue;
    }

    if (values === undefined) {
      continue;
    }

    const value = values.find((entry) => stringFieldOf(entry, METRIC_VALUE_ID_FIELD) === candidate);

    if (value === undefined) {
      fatal.push(issueAt('absent-metric', metricPath, type));
      continue;
    }

    if (fieldOf(value, METRIC_VALUE_AVAILABLE_FIELD) === false) {
      informational.push(issueAt('unavailable-metric', metricPath, type));
    }
  }

  return { fatal, informational };
}

/**
 * Gathers one node's claims and decides the checks that need no resolver.
 *
 * A node whose type the catalog does not know ends here: an unrecognised type is
 * `./validate.ts`'s rejection, and asking the catalog about it would reach a
 * lookup that has no entry.
 */
function gatherFromNode(
  node: PanelNode,
  path: PanelNodePath,
  summary: CaptureSummary,
  index: CaptureIndex,
  fieldPresence: unknown,
  traceFilters: TraceFilterUse[],
  fatal: SemanticIssue[],
  advisory: SemanticIssue[],
  informational: SemanticIssue[],
): void {
  const type: unknown = ownField(node, NODE_TYPE_FIELD);

  if (!isKnownPanelNodeType(type)) {
    return;
  }

  const query = ownField(node, NODE_QUERY_FIELD);
  const traceId = stringFieldOf(fieldOf(query, QUERY_FILTER_FIELD), FILTER_TRACE_ID_FIELD);

  if (traceId !== undefined) {
    traceFilters.push({
      path: [...path, NODE_QUERY_FIELD, QUERY_FILTER_FIELD, FILTER_TRACE_ID_FIELD],
      nodeType: type,
      traceId,
    });
  }

  const metrics = collectMetricIssues(node, path, type, summary);

  fatal.push(...metrics.fatal);
  informational.push(...metrics.informational);
  advisory.push(...collectAvailabilityIssues(node, path, type, summary, index, fieldPresence));
}

/**
 * Reads a specification once, gathering what has to be asked about and deciding
 * what does not.
 *
 * Everything here is read through the untyped helpers, so a specification that
 * was asserted rather than parsed is checked as far as it can be and never
 * throws.
 *
 * @param spec The specification to read.
 * @param summary The capture, for the checks that need no resolver.
 * @param index The capture's index, for per-node availability.
 * @param options The caller's strictness, for the empty-observed decision, and
 *   its field-presence tally, for per-node field availability.
 * @returns The citations and trace filters to decide, plus what was decided.
 */
function gatherClaims(
  spec: PanelSpec,
  summary: CaptureSummary,
  index: CaptureIndex,
  options: SemanticValidationOptions | undefined,
): GatheredClaims {
  const citations: Citation[] = [];
  const unevidenced: PanelNodePath[] = [];
  const traceFilters: TraceFilterUse[] = [];
  const fatal: SemanticIssue[] = [];
  const advisory: SemanticIssue[] = [];
  const informational: SemanticIssue[] = [];

  const summaryValue = fieldOf(spec, SUMMARY_FIELD);
  const observed = fieldOf(summaryValue, OBSERVED_FIELD);

  gatherCitations(observed, [SUMMARY_FIELD, OBSERVED_FIELD], citations, unevidenced);
  gatherCitations(
    fieldOf(summaryValue, LIKELY_CAUSES_FIELD),
    [SUMMARY_FIELD, LIKELY_CAUSES_FIELD],
    citations,
    unevidenced,
  );

  for (const path of unevidenced) {
    fatal.push(issueAt('unevidenced-fact', path));
  }

  // A panel with no findings. Legitimate by default — the deterministic fallback
  // panel of AAP 0.5.5 carries no model-derived facts — and a fallback panel is
  // exempt even when a caller demands findings, because requiring them of the
  // document that exists *because* nothing else could be shown would reject the
  // only panel available.
  if (
    options?.allowEmptyObserved === false &&
    fieldOf(fieldOf(spec, META_FIELD), FALLBACK_FIELD) !== true &&
    isUnknownArray(observed) &&
    observed.length === 0
  ) {
    fatal.push(issueAt('empty-observed', [SUMMARY_FIELD, OBSERVED_FIELD]));
  }

  if (isUnknownArray(fieldOf(spec, PANEL_LAYOUT_FIELD))) {
    // Read once, as `unknown`: the tally is caller-supplied input, and every
    // field of it is classified at runtime where it is used.
    const fieldPresence: unknown = options?.fieldPresence;

    try {
      walkPanelNodes(spec.layout, (node, path) => {
        gatherFromNode(
          node,
          path,
          summary,
          index,
          fieldPresence,
          traceFilters,
          fatal,
          advisory,
          informational,
        );
      });
    } catch {
      // `./spec.ts`'s traversal ends its children lookup in `assertNever`, which
      // throws for a node whose type is outside the node *union* — a document
      // that never passed `panelSpecSchema`, whose discriminated union rejects
      // one, and which `./validate.ts` rejects with a structural issue. The
      // nodes after it go ungathered; this module reports what it reached rather
      // than replacing a report about a panel with a crash inside the reporter.
    }
  }

  return { citations, traceFilters, decided: { fatal, advisory, informational } };
}

/*
 * ---------------------------------------------------------------------------
 * Deciding: what the capture says back
 * ---------------------------------------------------------------------------
 */

/** Whether the capture **refutes** a trace id, as opposed to not knowing it. */
function traceRefuted(traceId: string, index: CaptureIndex, resolution: IdResolution): boolean {
  const verdict = verdictFor(resolution, traceId);

  if (verdict === 'unknown') {
    return true;
  }

  if (verdict === 'known' || index.traceIds.has(traceId)) {
    return false;
  }

  return index.traceListComplete;
}

/** The two arrays a decision step contributes. */
interface DecidedIssues {
  readonly fatal: readonly SemanticIssue[];
  readonly unverifiable: readonly SemanticIssue[];
}

/**
 * Resolves every citation against the capture.
 *
 * The order of the four answers is the order of their authority, and it is the
 * whole substance of this checkpoint:
 *
 * 1. the caller's resolver, which reads the stored events and is the only
 *    authority that can *refute* an id the summary simply never published;
 * 2. the summary's bounded sections, which attest to the ids they name;
 * 3. an empty capture, which refutes every citation on its own;
 * 4. otherwise unverifiable — reported, never guessed (see this module's
 *    documentation).
 *
 * A citation that resolves to a real event is additionally cross-checked against
 * the coordinates the capture recorded for it, which catches the plausible
 * failure a resolver cannot: an id that exists paired with a trace or span it
 * does not belong to.
 *
 * A reference whose `eventId` is not a readable string is skipped rather than
 * reported. `eventRefSchema` requires it, so its absence is a shape failure
 * `./spec.ts` owns, and a semantic verdict about a citation that names nothing
 * would describe the wrong problem.
 */
function decideCitations(
  citations: readonly Citation[],
  index: CaptureIndex,
  events: IdResolution,
  traces: IdResolution,
): DecidedIssues {
  const fatal: SemanticIssue[] = [];
  const unverifiable: SemanticIssue[] = [];

  for (const citation of citations) {
    const { eventId } = citation;

    if (eventId === undefined) {
      continue;
    }

    const eventIdPath: PanelNodePath = [...citation.path, EVENT_ID_FIELD];
    const verdict = verdictFor(events, eventId);

    if (verdict === 'unknown') {
      fatal.push(issueAt('unknown-event-id', eventIdPath));
      continue;
    }

    const attested = index.events.get(eventId);

    if (verdict !== 'known' && attested === undefined) {
      // Nothing can attest to it. An empty capture refutes it; anything else
      // leaves it undecided, and saying so is the honest answer.
      if (index.hasEvents) {
        unverifiable.push(issueAt('unverifiable-event-id', eventIdPath));
      } else {
        fatal.push(issueAt('unknown-event-id', eventIdPath));
      }

      continue;
    }

    const tracePath: PanelNodePath = [...citation.path, EVENT_REF_TRACE_ID_FIELD];
    const traceMismatch =
      citation.traceId !== undefined &&
      attested?.traceId !== undefined &&
      citation.traceId !== attested.traceId;

    if (traceMismatch) {
      fatal.push(issueAt('event-ref-mismatch', tracePath));
    } else if (citation.traceId !== undefined && traceRefuted(citation.traceId, index, traces)) {
      // The trace is refutable in its own right — the capture's trace list is
      // complete, or the resolver rejected it — so the citation names a trace
      // that is not in this capture whatever its event id resolved to.
      fatal.push(issueAt('unknown-trace-id', tracePath));
    }

    if (
      citation.spanId !== undefined &&
      attested?.spanId !== undefined &&
      citation.spanId !== attested.spanId
    ) {
      fatal.push(issueAt('event-ref-mismatch', [...citation.path, EVENT_REF_SPAN_ID_FIELD]));
    }
  }

  return { fatal, unverifiable };
}

/**
 * Resolves every node's trace filter against the capture.
 *
 * **A deliberate consequence, recorded here because it looks like a bug
 * otherwise.** The authoring example a model is shown carries the placeholder
 * `"..."` in this position (AAP 0.1.2), because a trace id cannot be known while
 * a panel is being authored, and both the authoring schema and the normaliser
 * pass it through verbatim. A specification normalised straight from that
 * example is therefore **not** semantically valid against a real capture: the
 * placeholder names no trace, and this function says so. That is correct — the
 * panel-generation stage substitutes the capture's `primaryTraceId` before
 * validating, and a panel that still carries the placeholder is one nothing
 * filled in.
 *
 * Without a resolver, a placeholder is refuted only when the capture's trace
 * list is complete; otherwise it is reported as unverifiable, for the reason
 * every other unverifiable reference is.
 */
function decideTraceFilters(
  uses: readonly TraceFilterUse[],
  index: CaptureIndex,
  traces: IdResolution,
): DecidedIssues {
  const fatal: SemanticIssue[] = [];
  const unverifiable: SemanticIssue[] = [];

  for (const use of uses) {
    const verdict = verdictFor(traces, use.traceId);

    if (verdict === 'unknown') {
      fatal.push(issueAt('unknown-trace-id', use.path, use.nodeType));
      continue;
    }

    if (verdict === 'known' || index.traceIds.has(use.traceId)) {
      continue;
    }

    if (index.traceListComplete) {
      fatal.push(issueAt('unknown-trace-id', use.path, use.nodeType));
      continue;
    }

    unverifiable.push(issueAt('unverifiable-trace-id', use.path, use.nodeType));
  }

  return { fatal, unverifiable };
}

/*
 * ---------------------------------------------------------------------------
 * The public checks
 * ---------------------------------------------------------------------------
 */

/** Collects the distinct, defined values of a sequence, in first-seen order. */
function distinct(values: Iterable<string | undefined>): readonly string[] {
  const seen = new Set<string>();

  for (const value of values) {
    if (value !== undefined) {
      seen.add(value);
    }
  }

  return [...seen];
}

/*
 * ---------------------------------------------------------------------------
 * Field presence: what the records themselves carry
 * ---------------------------------------------------------------------------
 */

/** One kind's tally while it is being counted, before it is frozen. */
interface PresenceCounter {
  events: number;
  readonly attributes: Map<string, number>;
  readonly text: Map<string, number>;
}

/**
 * Whether an attribute value counts as carried text: a string of at least one
 * character.
 *
 * Exactly the predicate the telemetry aggregates apply to the attribute they
 * key a record on — `aggregateQueries` reads `db.statement` through
 * `readNonEmptyString`, `typeof value === 'string' && value.length > 0` — and
 * deliberately not a trimmed test: a whitespace-only statement still forms a
 * query group there, so counting it as absent here would report a field missing
 * from a table that draws a row for it.
 */
function isCarriedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Whether an attribute value counts as carried at all: anything but
 * `undefined`, `null` and the empty string.
 *
 * A `false` flag or a `0` count *is* a value, and so is a string of whitespace,
 * by the same rule {@link isCarriedText} applies to text.
 */
function isCarriedValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }

  return typeof value !== 'string' || isCarriedText(value);
}

/**
 * Counts one event into the per-kind counters, or leaves them untouched.
 *
 * The event is read as `unknown`. A record whose kind is outside the telemetry
 * vocabulary cannot be attributed to a kind's vocabulary and is not counted; a
 * record of a known kind whose `attributes` is missing or is not a bag is
 * counted as a record of that kind carrying no key — which is exactly what it
 * is to a view that reads one. The keys are gathered before anything is
 * committed, so an event whose attribute bag throws while being read
 * contributes nothing rather than half a record.
 */
function countEventPresence(event: unknown, counters: Map<TelemetryKind, PresenceCounter>): void {
  const kind = fieldOf(event, EVENT_KIND_FIELD);

  if (!isTelemetryKind(kind)) {
    return;
  }

  const attributes = fieldOf(event, EVENT_ATTRIBUTES_FIELD);
  const carried: string[] = [];
  const carriedAsText: string[] = [];

  if (isObjectLike(attributes) && !isUnknownArray(attributes)) {
    for (const key of Object.keys(attributes)) {
      const value = ownField(attributes, key);

      if (isCarriedValue(value)) {
        carried.push(key);
      }

      if (isCarriedText(value)) {
        carriedAsText.push(key);
      }
    }
  }

  const counter = counters.get(kind) ?? {
    events: 0,
    attributes: new Map<string, number>(),
    text: new Map<string, number>(),
  };

  counter.events += 1;

  for (const key of carried) {
    counter.attributes.set(key, (counter.attributes.get(key) ?? 0) + 1);
  }

  for (const key of carriedAsText) {
    counter.text.set(key, (counter.text.get(key) ?? 0) + 1);
  }

  counters.set(kind, counter);
}

/**
 * Freezes one counter map into the sorted, plain record a tally publishes.
 *
 * Keys in code-unit order, so two tallies of the same records serialise to the
 * same bytes whatever order the records arrived in.
 */
function freezeCounts(counts: ReadonlyMap<string, number>): Readonly<Record<string, number>> {
  const keys = [...counts.keys()].sort(compareKeys);

  return Object.freeze(Object.fromEntries(keys.map((key) => [key, counts.get(key) ?? 0])));
}

/** Orders two attribute keys by code unit, so a tally serialises identically everywhere. */
function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Tallies which attribute keys a capture's records carry, per kind — the input
 * {@link SemanticValidationOptions.fieldPresence} expects.
 *
 * One pass over the events: for each kind, how many records there are and, for
 * each attribute key, how many of them carry it with a value and how many carry
 * it as text (see {@link KindFieldPresence}). The result is frozen throughout, lists kinds in
 * the telemetry vocabulary's order and keys in code-unit order, and holds counts
 * only — no attribute value, no id and no name leaves the events.
 *
 * **Pure and never throws.** A value that is not an array tallies to an empty
 * record; an element that is not a record of a known kind is skipped; and an
 * element whose fields throw while being read — a revoked proxy, a throwing
 * trap — is skipped as well, so one malformed record costs its own count and
 * nothing more.
 *
 * @example
 * ```ts
 * // `captureEvents` are the stored events `summary` was computed from.
 * const outcome = validateAgainstCapture(spec, summary, {
 *   fieldPresence: tallyFieldPresence(captureEvents),
 * });
 * ```
 *
 * @param events The capture's stored events.
 * @returns Per-kind record and carrier counts.
 */
export function tallyFieldPresence(events: readonly TelemetryEvent[]): CaptureFieldPresence {
  const counters = new Map<TelemetryKind, PresenceCounter>();
  const candidates: unknown = events;

  if (isUnknownArray(candidates)) {
    for (const event of candidates) {
      try {
        countEventPresence(event, counters);
      } catch {
        // An element whose fields throw on read is not a record this tally can
        // attribute to a kind. `countEventPresence` commits nothing until every
        // read has succeeded, so skipping it leaves the other counts exact.
      }
    }
  }

  const presence: Partial<Record<TelemetryKind, KindFieldPresence>> = {};

  for (const kind of TELEMETRY_KINDS) {
    const counter = counters.get(kind);

    if (counter === undefined) {
      continue;
    }

    presence[kind] = Object.freeze({
      events: counter.events,
      attributes: freezeCounts(counter.attributes),
      text: freezeCounts(counter.text),
    });
  }

  return Object.freeze(presence);
}

/**
 * Collects **every** way `spec` is unsupported by `summary`, partitioned by
 * severity.
 *
 * Exported so that a caller can report all of a panel's problems at once rather
 * than the first one, and so that a caller interested in the advisory and
 * informational notes — which {@link validateAgainstCapture}'s outcome does not
 * carry — can read them. {@link validateAgainstCapture} composes this, exactly
 * as `./validate.ts`'s `validatePanelSpec` composes its `collectPanelSpecIssues`.
 *
 * The order of work, which is also the order issues are found in:
 *
 * 1. the capture is indexed once (bounded sections, trace list, event count);
 * 2. the summary's two statement lists are gathered into citations, and any
 *    statement with no citation at all is recorded;
 * 3. every node is walked once — trace filters are gathered, metric ids and
 *    per-node evidence availability are decided on the spot. Availability asks
 *    first whether the capture holds records of the kinds the node's catalog
 *    entry declares (`unavailable-source` if not), then whether those records
 *    carry the attribute keys in the entry's `requiredReads`
 *    (`unavailable-field` if none does). The second question is answered first
 *    from what the summary publishes about the aggregate behind the node's
 *    source (renders, requests, queries): a non-empty section proves a group
 *    formed; an available group-count metric — `query_count`, the executions
 *    the query groups account for over the whole capture — decides exactly,
 *    however the sections were clipped; an empty section decides only in a
 *    summary that clipped nothing. Where the summary leaves it open,
 *    {@link SemanticValidationOptions.fieldPresence} decides it when supplied,
 *    counting only carriers of the key as text. Every other case is left open;
 * 4. the two resolvers are each called **once** with every distinct id gathered;
 * 5. citations and trace filters are decided against index and resolutions;
 * 6. each array is sorted into a deterministic order, so two runs over the same
 *    input produce byte-identical reports.
 *
 * **Never throws**, including on a specification or a summary that was asserted
 * rather than parsed, and including when a caller's resolver throws.
 *
 * **Reports shape, never content**: every issue is a path, a code, a reason and
 * — for a node — its catalogued type (AAP 0.5.2).
 *
 * @param spec The normalized specification to check. Pass one that has already
 * passed `./validate.ts`; a document that has not is checked as far as it can
 * be, and its structural problems are that module's to report.
 * @param summary The capture the specification claims to describe.
 * @param options Resolvers, strictness and the field-presence tally; see
 *   {@link SemanticValidationOptions}.
 * @returns Every issue found, partitioned by severity and sorted by path.
 */
export function collectSemanticIssues(
  spec: PanelSpec,
  summary: CaptureSummary,
  options?: SemanticValidationOptions,
): SemanticIssueSets {
  const index = indexCapture(summary);
  const claims = gatherClaims(spec, summary, index, options);
  const { citations, traceFilters, decided } = claims;

  const eventResolution = resolveIds(
    options?.resolveEventIds,
    distinct(citations.map((citation) => citation.eventId)),
  );
  const traceResolution = resolveIds(
    options?.resolveTraceIds,
    distinct([
      ...citations.map((citation) => citation.traceId),
      ...traceFilters.map((use) => use.traceId),
    ]),
  );

  const decidedCitations = decideCitations(citations, index, eventResolution, traceResolution);
  const decidedFilters = decideTraceFilters(traceFilters, index, traceResolution);

  return {
    issues: sortIssues([...decided.fatal, ...decidedCitations.fatal, ...decidedFilters.fatal]),
    unverifiable: sortIssues([...decidedCitations.unverifiable, ...decidedFilters.unverifiable]),
    advisory: sortIssues(decided.advisory),
    informational: sortIssues(decided.informational),
  };
}

/**
 * Validates a normalized panel specification against the capture it claims to
 * describe: **step 4 of the panel pipeline**, and the answer the service acts
 * on.
 *
 * The composition rule, in one place:
 *
 * - any refutation ⇒ `invalid`, with the unverifiable references reported
 *   alongside;
 * - no refutation but some reference undecided ⇒ `unverifiable`, which is **not
 *   a failure**: the panel may be shown, and a caller that wants certainty
 *   supplies {@link SemanticValidationOptions.resolveEventIds};
 * - nothing at all ⇒ `valid`.
 *
 * Under {@link SemanticResultOptions.requireVerifiable}, the unverifiable and
 * advisory issues join the refutations, so an undecided reference or a node with
 * no evidence rejects the panel. Informational notes never do.
 *
 * The two-argument form is the documented call (AAP 0.7.1) and stays valid: with
 * no options, no resolver is consulted, an unverifiable reference is reported as
 * such, an empty observed list is accepted, and nothing is escalated.
 *
 * @param spec The normalized specification to validate.
 * @param summary The capture the specification claims to describe.
 * @param options Resolvers and strictness; see {@link SemanticValidationOptions}.
 * @returns One of the three outcomes, discriminated on `status`.
 */
export function validateAgainstCapture(
  spec: PanelSpec,
  summary: CaptureSummary,
  options?: SemanticValidationOptions,
): SemanticValidationOutcome {
  const sets = collectSemanticIssues(spec, summary, options);
  const issues =
    options?.requireVerifiable === true
      ? sortIssues([...sets.issues, ...sets.unverifiable, ...sets.advisory])
      : sets.issues;

  if (issues.length > 0) {
    return { status: 'invalid', issues, unverifiable: sets.unverifiable };
  }

  if (sets.unverifiable.length > 0) {
    return { status: 'unverifiable', unverifiable: sets.unverifiable };
  }

  return { status: 'valid' };
}

/*
 * ---------------------------------------------------------------------------
 * Mapping an outcome onto the package's Result vocabulary
 * ---------------------------------------------------------------------------
 */

/** The name this module reports for the schema a rejection was measured against. */
const PANEL_SPEC_SCHEMA_NAME = 'panelSpec';

/** The check this module reports as, distinguishing it from the schema's and the invariants'. */
const SEMANTIC_CHECK_NAME = 'semantic';

/**
 * The developer-facing recovery instruction attached to a rejection.
 *
 * States the rules rather than the values that broke them, and says plainly what
 * a failure here means and what to do about it. The metric count is derived from
 * the telemetry package's vocabulary so the sentence cannot go stale.
 */
const SEMANTIC_HINT = `Every observed fact and likely cause must cite events this capture holds, a view filtered to a trace must name a trace the capture holds, and a metric tile must name one of the fixed set of ${String(METRIC_IDS.length)} ids. A failure here means the panel describes something the capture does not support: show the deterministic fallback panel for this capture rather than retrying the model, and use the issue paths in this error's details to locate the citations at fault. A reference reported as unverifiable was not refuted — supply an event-id resolver to decide it.`;

/** One reported issue as it appears in an error's `details`. */
interface SemanticIssueDetail {
  /** The dotted path of the offending field. */
  readonly path: string;
  /** The snake-case code. */
  readonly code: string;
  /** The closed reason. */
  readonly reason: SemanticIssueReason;
  /** The catalogued node type, where the issue is about a node. */
  readonly nodeType?: PanelNodeType;
}

/** Renders issues for an error's `details`: paths, codes, reasons, node types. */
function describeIssuesForDetails(
  issues: readonly SemanticIssue[],
): readonly SemanticIssueDetail[] {
  return issues.map((issue) => {
    const described: SemanticIssueDetail = {
      path: joinPath(issue.path),
      code: issue.code,
      reason: issue.reason,
    };

    return issue.nodeType === undefined ? described : { ...described, nodeType: issue.nodeType };
  });
}

/**
 * Renders the first few issues for an error's `message`.
 *
 * Bounded by {@link MAX_REPORTED_ISSUES} with a count of the remainder, because
 * the message is one line in a log and in two user interfaces while the complete
 * list travels in `details`.
 */
function renderIssueList(issues: readonly SemanticIssue[]): string {
  const rendered = issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const joined = joinPath(issue.path);

    return `${joined.length === 0 ? ROOT_PATH_LABEL : joined} (${issue.code})`;
  });

  const omitted = issues.length - rendered.length;
  const listed = rendered.join(', ');

  return omitted > 0 ? `${listed} and ${String(omitted)} more` : listed;
}

/**
 * Builds the rejection for a specification the capture does not support.
 *
 * The code is `'PANEL_SEMANTIC_INVALID'`: `@debuggen/shared`'s `errors.ts` owns a
 * closed code vocabulary and a new code is never invented here. It is
 * deliberately **not** `'PANEL_INVALID'`, which `./spec.ts`, `./summary.ts` and
 * `./validate.ts` use for a document that is malformed — a caller that must tell
 * "this panel is not well-formed" from "this panel is not true of its capture"
 * can, because only the second is a statement about evidence. It is equally not
 * `'MODEL_OUTPUT_INVALID'`: a caller at a stage boundary that wants that
 * vocabulary maps this one with the shared `mapErr`.
 *
 * The complete issue list goes in `details`, which `toPayload` does not forward,
 * and a bounded path-and-code summary goes in `message`, which it does. Neither
 * carries a rejected value.
 */
function semanticRejection(
  issues: readonly SemanticIssue[],
  unverifiableCount: number,
  escalated: boolean,
): DebuggenError {
  const checks = issues.length === 1 ? 'check' : 'checks';
  const subject = escalated
    ? 'could not be fully verified against its capture'
    : 'failed semantic validation against its capture';

  return new DebuggenError(
    'PANEL_SEMANTIC_INVALID',
    `A panel specification ${subject} in ${String(issues.length)} ${checks}: ${renderIssueList(issues)}.`,
    {
      hint: SEMANTIC_HINT,
      details: {
        schema: PANEL_SPEC_SCHEMA_NAME,
        check: SEMANTIC_CHECK_NAME,
        issueCount: issues.length,
        unverifiableCount,
        issues: describeIssuesForDetails(issues),
      },
    },
  );
}

/**
 * Maps an outcome onto the package's `Result` vocabulary, for callers that
 * prefer it to a status switch.
 *
 * - `valid` ⇒ `ok(spec)`;
 * - `unverifiable` ⇒ `ok(spec)`, or `err` when
 *   {@link SemanticResultOptions.requireVerifiable} is set — the one decision
 *   this mapping takes, and the reason the options are accepted here as well as
 *   during collection;
 * - `invalid` ⇒ `err` with a `'PANEL_SEMANTIC_INVALID'` {@link DebuggenError}
 *   carrying every issue by path, code and reason.
 *
 * **The specification is a parameter because the `ok` branch has to carry it**,
 * and an outcome deliberately does not: a valid outcome is `{ status: 'valid' }`
 * and nothing else, so that no caller can read a panel back out of a validator
 * that never owned one. Pass the very specification that was validated —
 * `toResult(validateAgainstCapture(spec, summary), spec)` — since nothing here
 * can check that two arguments describe the same document.
 *
 * @param outcome The outcome to map.
 * @param spec The specification the outcome is about, returned on success.
 * @param options Whether an unverifiable outcome is a failure.
 * @returns `ok(spec)` or `err(error)`.
 */
export function toResult(
  outcome: SemanticValidationOutcome,
  spec: PanelSpec,
  options?: SemanticResultOptions,
): Result<PanelSpec, DebuggenError> {
  if (outcome.status === 'valid') {
    return ok(spec);
  }

  if (outcome.status === 'unverifiable') {
    if (options?.requireVerifiable !== true) {
      return ok(spec);
    }

    return err(semanticRejection(outcome.unverifiable, outcome.unverifiable.length, true));
  }

  return err(semanticRejection(outcome.issues, outcome.unverifiable.length, false));
}
