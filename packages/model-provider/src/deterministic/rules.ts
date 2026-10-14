/**
 * The rules engine behind `../providers/deterministic.js` — the provider every
 * automated test and the whole continuous-integration end-to-end suite runs
 * against.
 *
 * ## Why a rules engine rather than recorded answers
 *
 * The product's offline provider has to answer six reasoning stages without a
 * network and without a model, and it has to do so without carrying a single
 * fact about the application under test. Recorded responses would satisfy the
 * first requirement and violate the second: a recording is an answer that was
 * right for one project, and replaying it would make the test suite prove
 * nothing about the pipeline it is supposed to exercise. Nothing is recorded,
 * nothing is pre-authored, and no fixture of a model's output exists anywhere
 * in this repository.
 *
 * So every answer here is **computed**, from structure, every time. A request
 * carries a rendered prompt *and* the structured context that prompt was
 * rendered from ({@link ModelRequest.input}); this module reads only the
 * structured half, and builds a schema-shaped answer out of what it finds:
 * pre-classified category values, code-graph candidates, an adapter capability
 * catalog, capture aggregates, a node catalog. Its answers vary because its
 * inputs vary.
 *
 * ## Three constraints that shape every decision below
 *
 * 1. **Wording-invariance by construction.** Nothing here inspects the prose of
 *    a developer's request. The dispatch in {@link buildDeterministicOutput}
 *    hands a per-stage builder the structured context *alone* — never the
 *    request — so a builder has no reach into the rendered prompt, the system
 *    instruction or the message history even if a future edit wanted one. Two
 *    requests that differ only in phrasing classify to the same category and
 *    therefore produce byte-identical output. Prose that reaches an output does
 *    so from `./templates.js`'s fixed frames, filled with values taken from the
 *    structured context.
 * 2. **No knowledge of any particular project.** Every project-specific name in
 *    an output is interpolated from the structured context at run time. The
 *    vocabularies written out below — the eight instrumentation action types,
 *    the fourteen computed metric ids, the data-source names, the capture
 *    signals, the code-graph node kinds — are the product's own, fixed by the
 *    packages that own those artifacts; this module never names a symbol, a
 *    file or a route of an application being debugged. The repository's
 *    no-hardcoding gate scans this file's whole text, comments included, and
 *    that is the intended constraint rather than an inconvenience.
 * 3. **Evidence discipline.** An observed fact may cite only evidence that the
 *    structured context actually carries. The set of available references is
 *    built first, every candidate's references are filtered against it, and a
 *    candidate left with none is dropped rather than emitted with an empty
 *    citation list. A fabricated reference would pass a unit test here and fail
 *    the panel package's semantic validation later, which is the worst possible
 *    place to find out.
 *
 * ## Determinism is the product feature
 *
 * No clock, no randomness, no input or output, no module-level mutable state,
 * no locale-sensitive formatting, and an explicit total ordering for every
 * array this module emits — each comparator ending in a key that is unique
 * among its candidates, so two runs cannot disagree. Object literals are built
 * with their keys in a fixed source order, so even the serialised bytes are
 * stable. Anything read out of an input object's key set is sorted before it is
 * iterated, because an input's insertion order is not this module's to trust.
 * Together those are what make the offline suite reproducible: this file *is*
 * the reproducibility guarantee for every run.
 *
 * ## What this module is not
 *
 * It validates nothing and imports no schema package. The provider receives the
 * caller's own authoring schema and validates this module's construction
 * against it before anything downstream sees it, so the job here is to produce
 * JSON that structurally matches that authoring shape — plain objects and
 * arrays, built by hand. The packages that own plans, panels, events and
 * messages are deliberately not dependencies of the model boundary, and the
 * repository's lint configuration fails the build on an import of them.
 *
 * Serialisation is not this module's concern either: builders return JSON
 * values, and the provider stringifies for a text call and wraps for a
 * structured one.
 *
 * @packageDocumentation
 */

import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  DebuggenError,
  SOURCE_RESOLVED_BY,
  assertNever,
  basenamePosix,
  clampNonNegative,
  err,
  extnamePosix,
  formatSourceLocation,
  isSafeRelativePath,
  isTraceId,
  normalizePosix,
  ok,
  parseSourceLocation,
  roundMs,
  toPosix,
  type Result,
  type SourceLocation,
  type SourceResolvedBy,
} from '@debuggen/shared';

import {
  PROMPT_STAGES,
  isPromptStage,
  type JsonArray,
  type JsonObject,
  type JsonValue,
  type ModelRequest,
  type PromptStage,
} from '../types.js';

import {
  CONTEXT_PROVIDER_LIST_MAX_ITEMS,
  EMPTY_CAPTURE_NOTICE,
  LABEL_MAX_LENGTH,
  METRIC_COUNT_NOUNS,
  UNNAMED_OPERATION_LABEL,
  captureSignalLabel,
  codeSymbolKindLabel,
  contextChangeRenderCause,
  contextTriggeredRenderFact,
  dominantSpanCause,
  duplicateRequestCause,
  duplicateRequestFact,
  errorCountFact,
  flowPathLabel,
  focusSubjectLabel,
  focusedDeclarationFact,
  formatDurationMs,
  codeRelevanceReason,
  instrumentationActionRationale,
  instrumentationActionTypeLabel,
  longTaskFact,
  metricCountNoun,
  panelSummaryHeadline,
  panelTitle,
  planObjective,
  problemCategoryLabel,
  renderCountFact,
  repeatedQueryShapeCause,
  repeatedQueryShapeFact,
  sanitizeLabel,
  sharedOriginFact,
  slowestSpanFact,
  telemetryTierLabel,
  tierTimeSplitFact,
  truncateLabel,
  unchangedInputRenderCause,
  unchangedInputRenderFact,
  unknownTriggerRenderFact,
  type CountedNoun,
  type EvidencePattern,
} from './templates.js';

/* -------------------------------------------------------------------------------------------------
 * exported vocabularies
 *
 * Two closed sets this module validates every emitted value against. Both are
 * product vocabulary — they are fixed by the packages that own instrumentation
 * plans and capture aggregates, not by any application being debugged — and
 * both are restated here rather than imported because the model boundary
 * depends on `@debuggen/shared` and on nothing else in the repository. They are
 * exported so the provider's own suite can assert against the same source the
 * implementation uses, and so nothing re-declares them a third time.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The eight instrumentation action types a plan may ask for.
 *
 * An emitted action is checked against this tuple and dropped when it is not a
 * member, because the plan normaliser rejects an action no adapter claims and
 * handing it one would turn a recoverable selection problem into a rejected
 * plan. The first two are applied by rewriting a named symbol; the remaining
 * six are runtime hooks, which is the order of preference
 * {@link RUNTIME_ACTION_TYPES} encodes.
 *
 * Declared `as const` so {@link ActionTypeId} derives from it: the values and
 * the type cannot drift apart.
 */
export const INSTRUMENTATION_ACTION_TYPES = [
  'function-timing',
  'server-span',
  'react-render-tracking',
  'fetch-tracking',
  'db-query-tracking',
  'state-tracking',
  'interaction-tracking',
  'perf-tracking',
] as const;

/** One of the action types in {@link INSTRUMENTATION_ACTION_TYPES}. */
export type ActionTypeId = (typeof INSTRUMENTATION_ACTION_TYPES)[number];

/**
 * The fourteen computed metric ids a capture can report, in the canonical
 * order: the total duration and its three per-tier parts, the three render
 * counts, the request and query counts, the two resource measures, then the
 * remaining counts.
 *
 * The **order** is part of the contract, not a tidy listing. A metric-card
 * selection is the reported ids intersected with this tuple, and preserving the
 * tuple's order is what makes two runs of the same capture lay their cards out
 * identically. The single definition of the vocabulary lives with the package
 * that computes the values; this restatement follows it, and a metric added
 * there and not here is simply never selected rather than a failure.
 *
 * `unchanged_render_count` counts renders whose props were shallow-equal, whose
 * own hook state did not change **and** whose consumed context values did not
 * change. A render whose trigger could not be determined is counted separately
 * as `render_trigger_unknown_count` and is never described as unchanged —
 * that distinction is why the two ids exist, and it is preserved by the two
 * separate frames this module calls for them.
 */
export const COMPUTED_METRIC_IDS = [
  'total_duration',
  'frontend_duration',
  'backend_duration',
  'database_duration',
  'render_count',
  'unchanged_render_count',
  'render_trigger_unknown_count',
  'request_count',
  'query_count',
  'transferred_bytes',
  'blocking_time',
  'duplicate_request_count',
  'long_task_count',
  'error_count',
] as const;

/** One of the metric ids in {@link COMPUTED_METRIC_IDS}. */
export type ComputedMetricId = (typeof COMPUTED_METRIC_IDS)[number];

/* -------------------------------------------------------------------------------------------------
 * bounds
 *
 * A capture of a busy page carries thousands of events, and an output bounded
 * only by its input is an output nobody can read and a prompt nobody can
 * afford. Every cap below is applied *after* sorting, so what survives is the
 * highest-ranked material rather than whichever items happened to arrive first.
 * ---------------------------------------------------------------------------------------------- */

/** Relevant files an investigation reports. */
const MAX_RELEVANT_FILES = 12;

/** Flow paths an investigation reports. */
const MAX_FLOWS = 6;

/**
 * Steps read from one reported flow path.
 *
 * The renderer in `./templates.js` cuts a path at its own node cap and appends
 * the number of dropped steps; this bound is applied to the *input* slice as
 * well, so a pathologically long path costs a bounded amount of work to read
 * before it is rendered.
 */
const MAX_FLOW_STEPS = 24;

/** Instrumentation targets one plan asks for. */
const MAX_INSTRUMENTATION_TARGETS = 8;

/** Signals one plan's capture list names. */
const MAX_CAPTURE_SIGNALS = 12;

/** Hypotheses a plan carries forward from its structured context. */
const MAX_PLAN_HYPOTHESES = 4;

/** Observed facts one analysis reports. */
const MAX_OBSERVED_FACTS = 8;

/** Likely causes one analysis reports. */
const MAX_LIKELY_CAUSES = 4;

/** Nodes one generated panel lays out. */
const MAX_LAYOUT_NODES = 10;

/** Metric cards one panel node names. */
const MAX_METRIC_CARDS = 6;

/** Event kinds one panel node's filter names. */
const MAX_FILTER_KINDS = 8;

/** Evidence references one fact or hypothesis cites. */
const MAX_EVIDENCE_PER_FACT = 5;

/** Named entities an understanding reports. */
const MAX_ENTITIES = 16;

/** Search hints an understanding reports. */
const MAX_SEARCH_HINTS = 16;

/** Additive actions one follow-up decision asks for. */
const MAX_ADDITIONAL_ACTIONS = 6;

/**
 * Items read from any one array in the structured context.
 *
 * Reading is bounded separately from emitting: a cap on the output alone would
 * still let a million-element array cost a million comparisons on the way to
 * producing twelve rows.
 */
const MAX_ARRAY_ITEMS = 2000;

/** Distinct evidence references harvested from one structured context. */
const MAX_EVIDENCE_IDS = 5000;

/**
 * Levels a nested structure is walked before the walk stops.
 *
 * The structured context is plain JSON as far as the type system is concerned,
 * but it arrives as a run-time object graph, so a walk without a depth bound is
 * a stack overflow waiting for a pathological trace tree. The bound is paired
 * with {@link MAX_TRAVERSAL_NODES} and with an identity set, which is what
 * makes a cyclic graph safe rather than merely unlikely.
 */
const MAX_TRAVERSAL_DEPTH = 8;

/** Nodes visited by one nested-structure walk. */
const MAX_TRAVERSAL_NODES = 2000;

/** Characters kept from any label this module interpolates into a frame. */
const MAX_LABEL_LENGTH = 120;

/* -------------------------------------------------------------------------------------------------
 * thresholds and numeric policy
 *
 * The named values that decide whether a pattern is present and how strongly.
 * They are constants rather than expressions so that the behaviour they govern
 * is tunable and reviewable in one place — in particular the materiality
 * thresholds, which are what make a latency capture and a render capture select
 * different panel nodes.
 * ---------------------------------------------------------------------------------------------- */

/** Occurrences in one request group before it counts as a duplicate group. */
const DUPLICATE_GROUP_MIN_COUNT = 2;

/** Renders with unchanged inputs before the pattern counts as present. */
const UNCHANGED_RENDER_MIN_COUNT = 2;

/**
 * Context-triggered renders per own-state update of one component before that
 * component is suggested as the publisher of the changing context value.
 *
 * Two is the smallest fan-out that is a cascade rather than a coincidence: each
 * of the component's own updates was followed, on average, by at least two
 * renders of consumers whose only changed input was a context value.
 */
const CONTEXT_PUBLISHER_MIN_FAN_OUT = 2;

/** Statements of one shape before the repetition counts as a pattern. */
const REPEATED_QUERY_MIN_COUNT = 2;

/** Renders recorded for one component before it is reported as an outlier. */
const RENDER_OUTLIER_MIN_COUNT = 2;

/** Renders with an undetermined trigger before they are reported at all. */
const UNKNOWN_TRIGGER_MIN_COUNT = 1;

/** Long tasks recorded before they are reported. */
const LONG_TASK_MIN_COUNT = 1;

/** Errors recorded before they are reported. */
const ERROR_MIN_COUNT = 1;

/**
 * Share of an interaction's measured total one operation must cover before it
 * counts as dominating it.
 */
const DOMINANT_SPAN_MIN_SHARE = 0.5;

/**
 * Share of its tier's measured time a repeated statement shape's summed time
 * must reach before its repetition can be stated above `low` confidence.
 *
 * Repetition alone is not a cause of slowness: twelve executions that took nine
 * milliseconds between them, beside a statement that took half a second, are a
 * pattern, but not the pattern the developer is looking for. The yardstick is
 * the database tier's measured time ({@link DATABASE_DURATION_METRIC}), because
 * a statement shape is database work and a capture window's idle time cannot
 * inflate that tier's total; only a capture that states no database time is
 * weighed against the interaction's total instead. A shape below this share
 * keeps its count-based strength for ranking against other shapes, and its
 * confidence is capped at `low` ({@link IMMATERIAL_MAX_STEPS}). A shape whose
 * summed time or whose yardstick is unknown is not capped, because nothing
 * measured says it is immaterial.
 */
const REPEATED_QUERY_MATERIAL_SHARE = 0.1;

/**
 * Items a data source must report before a panel node reading it is emitted.
 *
 * The default: one item is enough for most sources, because a table with one
 * row still answers a question a developer asked.
 */
const MATERIAL_MIN_ITEMS = 1;

/**
 * Sources that need more than {@link MATERIAL_MIN_ITEMS} to be worth a node.
 *
 * A trace with a single span is not a tree and a graph with a single node has
 * no edges, so both would render an empty frame around one label. Every other
 * source falls back to the default, and a source absent from this table is not
 * a source this module treats specially — the set of sources comes from the
 * catalog in the structured context, never from here.
 */
const MATERIAL_MIN_ITEMS_BY_SOURCE: Readonly<Record<string, number>> = Object.freeze({
  trace: 2,
  graph: 2,
});

/** Decimal places kept on a relevance score. */
const SCORE_DECIMALS = 3;

/** Decimal places kept on a resolver confidence of a suggested source location. */
const LOCATION_CONFIDENCE_DECIMALS = 2;

/** Decimal places kept on a metric value passed through to an analysis. */
const METRIC_DECIMALS = 3;

/** Score every computed candidate starts from, so a bare match still ranks. */
const SCORE_BASE = 0.1;

/** Added per needed signal a candidate declares. */
const SCORE_SIGNAL_MATCH = 0.2;

/** Added when a candidate's symbol or file stem is a named entity. */
const SCORE_ENTITY_MATCH = 0.3;

/** Added when a candidate's symbol appears in the selected target's chain. */
const SCORE_TARGET_CHAIN_MATCH = 0.3;

/** Added when a candidate declares a node kind the product has wording for. */
const SCORE_KNOWN_KIND = 0.1;

/**
 * Added when a candidate lies on a path an executed `pathBetween` query found.
 * A route or data-layer call the selected element's request reaches is named
 * by no entity and declares no signal, so without this it would rank with the
 * bare matches and could fall off the shortlist behind the components that
 * reach it.
 */
const SCORE_TRACED_PATH_MATCH = 0.3;

/** Upper bound on a computed score, so the scale stays comparable. */
const SCORE_MAX = 1;

/** Steps of evidence strength that still raise confidence. */
const CONFIDENCE_MAX_STEPS = 5;

/**
 * The analytical confidence vocabulary of a hypothesis, lowest first.
 *
 * Restated from `@debuggen/panel-schema`'s `CONFIDENCE_LEVELS`, which this
 * package sits below and cannot import. A hypothesis carries a **word**, not a
 * number: the analyze stage validates the answer against protocol's strict
 * `analysisFindingsSchema`, the summary header renders one badge per level, and
 * there is no calibration behind a decimal that a rules engine could honestly
 * claim.
 */
export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;

/** One member of {@link CONFIDENCE_LEVELS}. */
type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/**
 * The fewest whole steps of evidence strength each level needs, strongest
 * first; the first threshold a detection reaches names its level.
 *
 * `high` is reachable, deliberately: these are patterns matched against counts
 * and presented under the "Likely cause" heading, so even the strongest one is
 * still labelled an inference rather than a fact, which is what the separate
 * heading exists to say.
 */
const CONFIDENCE_LEVEL_THRESHOLDS: readonly (readonly [ConfidenceLevel, number])[] = [
  ['high', 4],
  ['medium', 2],
  ['low', 0],
];

/**
 * The most whole steps of evidence strength that still read as `low`: one
 * below the smallest threshold of any stronger level.
 *
 * Derived from {@link CONFIDENCE_LEVEL_THRESHOLDS} rather than written out, so
 * retuning a threshold cannot leave a capped detection reading as `medium`. A
 * detection judged immaterial ({@link REPEATED_QUERY_MATERIAL_SHARE}) has its
 * steps capped here.
 */
const IMMATERIAL_MAX_STEPS = Math.max(
  0,
  CONFIDENCE_LEVEL_THRESHOLDS.reduce(
    (lowest, [level, threshold]) => (level === 'low' ? lowest : Math.min(lowest, threshold)),
    CONFIDENCE_MAX_STEPS + 1,
  ) - 1,
);

/**
 * Multiplier turning a dominance share into whole steps of evidence strength.
 *
 * A share at the detection threshold yields no steps and a share of one yields
 * five, which is the same zero-to-five range the count-based patterns use, so
 * one confidence rule serves all four.
 */
const DOMINANT_SHARE_STEP_SCALE = 10;

/* -------------------------------------------------------------------------------------------------
 * narrowing helpers
 *
 * Every read of the structured context goes through one of these. They return
 * `T | undefined`, they never throw and they never cast: the context is plain
 * JSON that six different pipeline stages assemble, a degraded capture can
 * leave any field out, and `null` where an object was expected is an ordinary
 * outcome rather than an exceptional one. `noUncheckedIndexedAccess` makes the
 * discipline explicit — an indexed read is already `T | undefined`, and
 * resolving that with a check rather than with an assertion is what keeps a
 * missing field from reaching an output as the literal `undefined`.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether a JSON value is an array.
 *
 * A declared type predicate rather than a bare `Array.isArray` call, and the
 * reason is mechanical: `Array.isArray`'s built-in signature narrows to the
 * *mutable* `any[]`, and a `readonly` array is not assignable to that, so the
 * negative branch of a bare call leaves {@link JsonArray} in the union and the
 * object case below would not compile without an assertion. Naming the
 * predicate keeps both branches exact and keeps this file free of casts.
 *
 * @param value Any value from the structured context.
 * @returns `true` when `value` is a JSON array.
 */
function isJsonArray(value: JsonValue | undefined): value is JsonArray {
  return Array.isArray(value);
}

/**
 * Narrows a JSON value to an object, excluding `null` and arrays.
 *
 * @param value Any value from the structured context.
 * @returns The object, or `undefined` for anything else.
 */
function asObject(value: JsonValue | undefined): JsonObject | undefined {
  if (value === null || value === undefined || typeof value !== 'object' || isJsonArray(value)) {
    return undefined;
  }
  return value;
}

/**
 * Narrows a JSON value to an array, bounded by {@link MAX_ARRAY_ITEMS}.
 *
 * The bound is applied on the way in rather than on the way out, so a
 * pathologically large array costs a slice instead of a full scan.
 *
 * @param value Any value from the structured context.
 * @returns The array, truncated to the read bound, or `undefined`.
 */
function asArray(value: JsonValue | undefined): JsonArray | undefined {
  if (!isJsonArray(value)) {
    return undefined;
  }
  return value.length > MAX_ARRAY_ITEMS ? value.slice(0, MAX_ARRAY_ITEMS) : value;
}

/**
 * Narrows a JSON value to a non-blank string, collapsed to one line and
 * bounded.
 *
 * Blank is treated as absent throughout this module: a field present with an
 * empty string carries no more information than a missing field, and admitting
 * one would put a gap in a rendered sentence or an empty label on a panel.
 *
 * @param value Any value from the structured context.
 * @returns The cleaned string, or `undefined` when it carries no characters.
 */
function asString(value: JsonValue | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length === 0 ? undefined : truncateLabel(collapsed, MAX_LABEL_LENGTH);
}

/**
 * Narrows a JSON value to a finite number.
 *
 * `NaN` and both infinities are rejected rather than clamped: a caller that
 * wants a clamp asks for one, and a silent zero here would look like a measured
 * zero later.
 *
 * @param value Any value from the structured context.
 * @returns The number, or `undefined` when it is absent or not finite.
 */
function asFiniteNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Narrows a JSON value to a boolean.
 *
 * Deliberately strict: a string `'true'` and the number `1` are not booleans,
 * and coercing them would make a field's meaning depend on which producer
 * filled it in.
 *
 * @param value Any value from the structured context.
 * @returns The boolean, or `undefined`.
 */
function asBoolean(value: JsonValue | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Narrows a JSON value to an array of objects, dropping every member that is
 * not one.
 *
 * @param value Any value from the structured context.
 * @returns The objects, or `undefined` when the value is not an array.
 */
function asObjectArray(value: JsonValue | undefined): readonly JsonObject[] | undefined {
  const array = asArray(value);
  if (array === undefined) {
    return undefined;
  }
  const objects: JsonObject[] = [];
  for (const member of array) {
    const object = asObject(member);
    if (object !== undefined) {
      objects.push(object);
    }
  }
  return objects;
}

/**
 * Reads an array of non-blank strings, dropping everything else.
 *
 * Returns an empty array rather than `undefined` for a missing field, because
 * every caller of this helper goes on to iterate the result and an absent list
 * and an empty list mean the same thing to all of them.
 *
 * @param value Any value from the structured context.
 * @returns The cleaned strings, in the order they arrived.
 */
function asStringArray(value: JsonValue | undefined): readonly string[] {
  const array = asArray(value);
  if (array === undefined) {
    const single = asString(value);
    return single === undefined ? [] : [single];
  }
  const strings: string[] = [];
  for (const member of array) {
    const text = asString(member);
    if (text !== undefined) {
      strings.push(text);
    }
  }
  return strings;
}

/**
 * The first of several field names that carries a value, probed in the order
 * given.
 *
 * The stage modules that assemble these contexts are free to name a concept
 * more than one way — an aggregates bag reachable as `aggregates` or as
 * `summary`, an understanding as `understanding` or `problemUnderstanding` — so
 * every read in this module probes a small, fixed, documented list of
 * alternatives instead of insisting on one spelling. The order is the
 * precedence: the most specific name first, the more general fallback after it.
 *
 * @param source The object to read, or `undefined`.
 * @param names Field names in precedence order.
 * @returns The first defined, non-null value found, or `undefined`.
 */
function readField(
  source: JsonObject | undefined,
  ...names: readonly string[]
): JsonValue | undefined {
  if (source === undefined) {
    return undefined;
  }
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

/**
 * The first of several field names that carries an object.
 *
 * @param source The object to read, or `undefined`.
 * @param names Field names in precedence order.
 * @returns The first value that is an object, or `undefined`.
 */
function readObjectField(
  source: JsonObject | undefined,
  ...names: readonly string[]
): JsonObject | undefined {
  if (source === undefined) {
    return undefined;
  }
  for (const name of names) {
    const object = asObject(source[name]);
    if (object !== undefined) {
      return object;
    }
  }
  return undefined;
}

/**
 * The first of several field names that carries a non-empty array of objects.
 *
 * A present-but-empty array is skipped rather than returned, so a context that
 * carries `{ candidates: [], results: [...] }` still finds the populated one.
 *
 * @param source The object to read, or `undefined`.
 * @param names Field names in precedence order.
 * @returns The objects of the first populated array, or `undefined`.
 */
function readObjectArrayField(
  source: JsonObject | undefined,
  ...names: readonly string[]
): readonly JsonObject[] | undefined {
  if (source === undefined) {
    return undefined;
  }
  for (const name of names) {
    const objects = asObjectArray(source[name]);
    if (objects !== undefined && objects.length > 0) {
      return objects;
    }
  }
  return undefined;
}

/**
 * The union of every string list found under the given field names.
 *
 * Unlike {@link readObjectArrayField} this does not stop at the first hit:
 * signal lists in particular arrive split across a couple of spellings, and the
 * union of them is what the caller means. Duplicates are removed and the result
 * is ordered by plain string comparison, so the answer does not depend on which
 * field happened to be read first.
 *
 * @param source The object to read, or `undefined`.
 * @param names Field names to collect from.
 * @returns The distinct strings, in ascending order.
 */
function readStringSet(source: JsonObject | undefined, ...names: readonly string[]): string[] {
  if (source === undefined) {
    return [];
  }
  const found = new Set<string>();
  for (const name of names) {
    for (const text of asStringArray(source[name])) {
      found.add(text);
    }
  }
  return sortStrings([...found]);
}

/* -------------------------------------------------------------------------------------------------
 * ordering and numeric helpers
 *
 * Plain `<` and `>` comparison throughout, never `localeCompare`: a
 * locale-sensitive comparator makes the order of a generated panel depend on
 * the environment the service happens to run in, and two runs of the same
 * capture would then disagree about something a developer can see.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Compares two strings by code unit, ascending.
 *
 * @param left First string.
 * @param right Second string.
 * @returns A negative number, zero, or a positive number.
 */
function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/**
 * A copy of `values`, ordered by {@link compareStrings}.
 *
 * @param values The strings to order.
 * @returns A new, ordered array.
 */
function sortStrings(values: readonly string[]): string[] {
  return [...values].sort(compareStrings);
}

/**
 * The keys of an object, ordered by {@link compareStrings}.
 *
 * `Object.keys` preserves insertion order, which belongs to whoever built the
 * object rather than to this module, so every key iteration starts here.
 *
 * @param source The object whose keys are needed.
 * @returns The keys, in ascending order.
 */
function sortedKeys(source: JsonObject): string[] {
  return sortStrings(Object.keys(source));
}

/**
 * Rounds a non-negative measurement through the product's one rounding policy.
 *
 * Clamped before it is rounded, because the shared rounding helper returns a
 * non-finite value unchanged by design — rounding is a presentation concern and
 * must not be what decides the meaning of an unusable measurement. Every number
 * this module derives passes through here, so floating-point noise cannot make
 * two runs differ in their rendered text.
 *
 * @param value The measurement to normalise.
 * @param decimals Decimal places to keep.
 * @returns A non-negative, rounded number.
 */
function roundValue(value: number, decimals: number): number {
  return roundMs(clampNonNegative(value), decimals);
}

/**
 * Clamps a value into an inclusive range.
 *
 * @param value The value to clamp.
 * @param low Lower bound.
 * @param high Upper bound.
 * @returns `value` bounded by `low` and `high`.
 */
function clampRange(value: number, low: number, high: number): number {
  if (value < low) {
    return low;
  }
  return value > high ? high : value;
}

/**
 * Reads a count: a finite, non-negative integer, or `undefined`.
 *
 * Counts arrive from aggregates a degraded capture can leave incomplete, and a
 * fractional or negative count is a broken measurement rather than a small one,
 * so both are rejected here instead of being rendered.
 *
 * @param value Any value from the structured context.
 * @returns The count, or `undefined`.
 */
function asCount(value: JsonValue | undefined): number | undefined {
  const numeric = asFiniteNumber(value);
  if (numeric === undefined || numeric < 0) {
    return undefined;
  }
  return Math.floor(numeric);
}

/**
 * Reads a duration in milliseconds: finite and non-negative, rounded.
 *
 * @param value Any value from the structured context.
 * @returns The duration, or `undefined`.
 */
function asDurationMs(value: JsonValue | undefined): number | undefined {
  const numeric = asFiniteNumber(value);
  if (numeric === undefined || numeric < 0) {
    return undefined;
  }
  return roundValue(numeric, METRIC_DECIMALS);
}

/**
 * The whole steps of evidence strength a detection is ranked by.
 *
 * Negative values count as none and anything past {@link CONFIDENCE_MAX_STEPS}
 * as the maximum, so one very strong pattern cannot outrank another merely by
 * overflowing the scale.
 *
 * @param steps Whole steps of evidence strength, as a detector derived them.
 * @returns The bounded step count.
 */
function boundedSteps(steps: number): number {
  return clampRange(Math.floor(clampNonNegative(steps)), 0, CONFIDENCE_MAX_STEPS);
}

/**
 * The confidence level for a detected pattern, from the strength of its
 * evidence.
 *
 * One rule for all four patterns, and it is monotonic by construction: the
 * level rises with `steps` and with nothing else. `steps` is a whole number
 * each detector derives from its own counts — one duplicate beyond the first,
 * one unchanged-input render, a tenth of the interaction's total beyond the
 * dominance threshold — so a stronger pattern can never be reported less
 * confidently than a weaker one of the same class.
 *
 * @param steps Whole steps of evidence strength; negative values are treated as
 * none.
 * @returns A member of {@link CONFIDENCE_LEVELS}.
 */
function confidenceForSteps(steps: number): ConfidenceLevel {
  const bounded = boundedSteps(steps);
  for (const [level, threshold] of CONFIDENCE_LEVEL_THRESHOLDS) {
    if (bounded >= threshold) {
      return level;
    }
  }
  return 'low';
}

/* -------------------------------------------------------------------------------------------------
 * bounded traversal
 * ---------------------------------------------------------------------------------------------- */

/** Field names a nested node uses for its children, probed in this order. */
const CHILD_FIELDS: readonly string[] = ['children', 'spans', 'nodes', 'items'];

/**
 * Flattens a nested node structure into a bounded list, depth first.
 *
 * Trace trees arrive as nested objects, and the only safe way to read one is
 * with three bounds at once: a depth bound, a node budget, and an identity set
 * that stops a structure which refers back to itself. The type system says the
 * context is plain JSON and therefore acyclic, but the object graph this runs
 * over is a run-time value assembled by another process, and a walk that trusts
 * the declaration is a walk that can hang.
 *
 * Children are read from the first of {@link CHILD_FIELDS} that carries an
 * array, so one traversal serves a span tree, a component tree and a dependency
 * graph alike.
 *
 * @param root The structure to flatten; anything that is not an object or an
 * array yields an empty list.
 * @returns Every visited node, the root first, within the bounds.
 */
function flattenNodes(root: JsonValue | undefined): readonly JsonObject[] {
  const collected: JsonObject[] = [];
  const seen = new Set<JsonObject>();
  const pending: { node: JsonValue | undefined; depth: number }[] = [];

  const rootArray = asArray(root);
  if (rootArray === undefined) {
    pending.push({ node: root, depth: 0 });
  } else {
    for (const member of rootArray) {
      pending.push({ node: member, depth: 0 });
    }
  }

  while (pending.length > 0 && collected.length < MAX_TRAVERSAL_NODES) {
    const next = pending.shift();
    if (next === undefined) {
      break;
    }
    const node = asObject(next.node);
    if (node === undefined || seen.has(node)) {
      continue;
    }
    seen.add(node);
    collected.push(node);

    if (next.depth >= MAX_TRAVERSAL_DEPTH) {
      continue;
    }
    for (const field of CHILD_FIELDS) {
      const children = asArray(node[field]);
      if (children === undefined) {
        continue;
      }
      for (const child of children) {
        pending.push({ node: child, depth: next.depth + 1 });
      }
      // One child field per node: the first populated one is the structure's
      // own, and following the rest would visit the same subtree twice under a
      // producer that mirrors its children under a second name.
      break;
    }
  }

  return collected;
}

/* -------------------------------------------------------------------------------------------------
 * project paths
 * ---------------------------------------------------------------------------------------------- */

/**
 * Normalises a candidate path to a project-relative POSIX path, or rejects it.
 *
 * The rejection is the point. A path that leaves the project, carries a
 * backslash, names a drive or hides a control character must not travel
 * downstream, because the next thing that happens to it is that it becomes the
 * `file` of a source location — and a location is what the editor opens. The
 * containment rule is the base package's, so this module cannot disagree with
 * the gate that enforces it at every later boundary.
 *
 * @param value Any value believed to name a file in the project.
 * @returns The normalised project-relative path, or `undefined`.
 */
function asProjectPath(value: JsonValue | undefined): string | undefined {
  const raw = asString(value);
  if (raw === undefined) {
    return undefined;
  }
  const normalized = normalizePosix(toPosix(raw));
  return isSafeRelativePath(normalized) ? normalized : undefined;
}

/**
 * The searchable stems of a path: its final component, and that component
 * without its extension when it has one.
 *
 * Mechanical, and that is what makes it safe: the hints an investigation
 * searches with are derived from names the structured context already carried,
 * never from anything a developer wrote in prose.
 *
 * @param path A project-relative POSIX path.
 * @returns One or two stems, or an empty list when the path has no final
 * component.
 */
function pathStems(path: string): readonly string[] {
  const base = basenamePosix(path);
  if (base.length === 0) {
    return [];
  }
  const extension = extnamePosix(base);
  if (extension.length === 0) {
    return [base];
  }
  const stem = basenamePosix(base, extension);
  return stem === base ? [base] : [base, stem];
}

/* -------------------------------------------------------------------------------------------------
 * evidence
 *
 * An observed fact cites the events it was derived from, and the citation has
 * to resolve against the capture: the panel package's semantic validation
 * rejects a specification whose evidence does not exist, so a reference this
 * module invented would fail late and loudly rather than here. The set of
 * available references is therefore harvested from the structured context
 * first, and every candidate's references are filtered against it.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Fields that hold a list of evidence references, probed in this order.
 *
 * `occurrences` is last because it is a list of event *records* rather than of
 * references: the service's analysis input (`apps/local-service/src/analysis/
 * summarize.ts`) gives each render, request and query row its captured
 * executions as `occurrences[]`, every member carrying the `eventId` of the
 * persisted event it is, and no separate evidence list. Without it a pattern
 * detected on such a row could cite nothing and was dropped.
 */
const EVIDENCE_LIST_FIELDS: readonly string[] = [
  'evidence',
  'eventIds',
  'events',
  'ids',
  'occurrences',
];

/**
 * Fields that hold a single event reference on an aggregate.
 *
 * Deliberately **without** any span-identifier field, and without the
 * aggregate's own `id`: a span id lives in a different identifier space from
 * an event id, and so does the id of a request or query group, a component
 * tree node, a graph participant or a fact candidate. Citing one where an
 * event id is expected produces a reference that resolves to nothing, and the
 * analyze stage rejects the whole analysis for it.
 */
const EVIDENCE_SINGLE_FIELDS: readonly string[] = ['eventId'];

/**
 * Fields that name the event a **member of an evidence list** is.
 *
 * Wider than {@link EVIDENCE_SINGLE_FIELDS} on purpose: the list's own field —
 * `evidence`, `eventIds`, `events` — already says every member is an event,
 * so an event record spelled with a plain `id` is read as the event it is.
 */
const EVIDENCE_MEMBER_FIELDS: readonly string[] = ['eventId', 'id'];

/**
 * Fields that hold an aggregate's **individual occurrences**, each a record
 * naming its own event.
 *
 * The service's analysis input (`apps/local-service/src/analysis/summarize.ts`)
 * carries a request group's, a render statistic's and a query group's citable
 * events one level down — `occurrences: [{ eventId, … }]` — rather than as a
 * list on the aggregate itself. An aggregate that carries no list and no
 * single reference is therefore cited by its occurrences, which are exactly
 * the events it was computed from. Only the {@link EVIDENCE_SINGLE_FIELDS}
 * spelling is read from a member here, never a plain `id`: an occurrence
 * record's own `id` is not guaranteed to be an event id.
 */
const EVIDENCE_OCCURRENCE_FIELDS: readonly string[] = ['occurrences'];

/**
 * The key of the one spelling an emitted evidence reference has: `{ eventId }`,
 * followed by `kind` and `label` when the context describes the event
 * ({@link EvidenceDescriptor}).
 *
 * The context may spell its own references either way — a request group lists
 * bare `eventIds`, a fact candidate carries `{ eventId }` records — and both are
 * read. What is emitted is always the object form, because that is the only
 * form `@debuggen/panel-schema`'s `EventRef` accepts, and protocol's strict
 * findings schema validates every fact and cause with it.
 */
const EVIDENCE_OBJECT_KEY = 'eventId';

/**
 * The telemetry kinds an emitted evidence reference may name.
 *
 * Restated from `@debuggen/telemetry`'s `TELEMETRY_KINDS`, which this package
 * sits below and cannot import — the precedent is {@link CONFIDENCE_LEVELS}.
 * The restatement is load-bearing: `@debuggen/panel-schema`'s `EventRef`
 * validates `kind` as an enumeration over that vocabulary and protocol's strict
 * findings schema rejects the whole analysis for one unknown kind, so a kind is
 * emitted only when it is a member here, and a kind the telemetry package adds
 * later is simply left off the reference rather than failing the stage.
 */
const EVIDENCE_REF_KINDS: ReadonlySet<string> = new Set([
  'interaction',
  'render',
  'commit',
  'fetch',
  'xhr',
  'navigation',
  'perf.longtask',
  'perf.entry',
  'error',
  'state',
  'http.server',
  'route.handler',
  'function',
  'db.query',
  'http.client',
  'server.error',
  'log',
]);

/**
 * The display sugar an emitted reference carries: what kind of event it cites
 * and a short caption for its chip. Both optional; a reference without either
 * renders as its id.
 */
interface EvidenceDescriptor {
  /** A member of {@link EVIDENCE_REF_KINDS}. */
  readonly kind?: string;
  /** A caption of at most {@link LABEL_MAX_LENGTH} characters, never blank. */
  readonly label?: string;
}

/** The reference set of one structured context. */
interface EvidenceIndex {
  /** Every reference the context carries, within {@link MAX_EVIDENCE_IDS}. */
  readonly available: ReadonlySet<string>;
  /**
   * The kind and caption of each reference whose event the context describes
   * with a record of its own ({@link describeEvidence}); a reference known only
   * from a bare list is absent here.
   */
  readonly descriptors: ReadonlyMap<string, EvidenceDescriptor>;
}

/**
 * Reads one evidence reference, in either spelling.
 *
 * @param value A member of an evidence list.
 * @returns The reference, or `undefined` when the member carries none.
 */
function readEvidenceRef(value: JsonValue | undefined): string | undefined {
  const text = asString(value);
  if (text !== undefined) {
    return text;
  }
  const object = asObject(value);
  if (object === undefined) {
    return undefined;
  }
  for (const field of EVIDENCE_MEMBER_FIELDS) {
    const reference = asString(object[field]);
    if (reference !== undefined) {
      return reference;
    }
  }
  return undefined;
}

/**
 * The references one aggregate carries, in the order it carries them: its
 * own evidence list, else its single event, else the events of its
 * occurrences ({@link EVIDENCE_OCCURRENCE_FIELDS}).
 *
 * @param source An aggregate: a span, a render statistic, a request or query
 * group, a state transition.
 * @returns The references found, bounded per fact by the caller.
 */
function evidenceOf(source: JsonObject | undefined): readonly string[] {
  if (source === undefined) {
    return [];
  }
  const references: string[] = [];
  for (const field of EVIDENCE_LIST_FIELDS) {
    const list = asArray(source[field]);
    if (list === undefined) {
      continue;
    }
    for (const member of list) {
      const reference = readEvidenceRef(member);
      if (reference !== undefined) {
        references.push(reference);
      }
    }
    if (references.length > 0) {
      break;
    }
  }
  if (references.length === 0) {
    const reference = singleEvidenceOf(source);
    if (reference !== undefined) {
      references.push(reference);
    }
  }
  if (references.length === 0) {
    for (const field of EVIDENCE_OCCURRENCE_FIELDS) {
      for (const occurrence of asObjectArray(source[field]) ?? []) {
        const reference = singleEvidenceOf(occurrence);
        if (reference !== undefined) {
          references.push(reference);
        }
      }
      if (references.length > 0) {
        break;
      }
    }
  }
  return references;
}

/**
 * The one event a record names through {@link EVIDENCE_SINGLE_FIELDS}.
 *
 * @param record An occurrence or window record.
 * @returns The reference, or `undefined` when the record names none.
 */
function singleEvidenceOf(record: JsonObject): string | undefined {
  for (const field of EVIDENCE_SINGLE_FIELDS) {
    const reference = asString(record[field]);
    if (reference !== undefined) {
      return reference;
    }
  }
  return undefined;
}

/**
 * Harvests every evidence reference in a bag of aggregates.
 *
 * Deterministic because the walk is: bags are visited in the order the caller
 * lists them and nested nodes in the bounded depth-first order of
 * {@link flattenNodes}, so the {@link MAX_EVIDENCE_IDS} cap always keeps the
 * same references.
 *
 * @param bags Objects whose nested structures may carry references.
 * @param described The capture-aggregate bag whose event records describe the
 * events they are ({@link describeEvidence}); omitted, no reference is described.
 * @returns The available references and their descriptors.
 */
function indexEvidence(
  bags: readonly (JsonObject | undefined)[],
  described?: JsonObject,
): EvidenceIndex {
  const available = new Set<string>();

  for (const bag of bags) {
    if (bag === undefined) {
      continue;
    }
    for (const key of sortedKeys(bag)) {
      for (const node of flattenNodes(bag[key])) {
        for (const reference of evidenceOf(node)) {
          if (available.size >= MAX_EVIDENCE_IDS) {
            break;
          }
          available.add(reference);
        }
      }
    }
  }

  return {
    available,
    descriptors:
      described === undefined ? new Map<string, EvidenceDescriptor>() : describeEvidence(described),
  };
}

/**
 * The capture sections whose rows are events, keyed by their own `eventId`:
 * the flat operation lists and the trace sections (every node of a trace walk
 * is a span).
 */
const DESCRIBED_ROW_FIELDS: readonly string[] = [
  'spans',
  'topSpans',
  'slowestSpans',
  'trace',
  'traces',
  'traceTree',
  'traceTrees',
];

/**
 * The capture sections whose rows are **aggregates** of events, each listing
 * the events it was computed from as `occurrences[]` keyed by their own
 * `eventId`, with what an occurrence of that section is.
 *
 * `kind` is what an occurrence is when its row does not say: every execution
 * of a query group is a database query and every occurrence of a render
 * statistic is a render, while a request group's occurrences may be `fetch`,
 * `xhr` or `http.client` events and so name no kind here. `noun` names the
 * occurrence in its caption when the occurrence names no operation of its own,
 * `issuerFields` name the occurrence's own fields that say whose occurrence it
 * is — a render's component — and `subject` reads the same from the aggregate
 * when the occurrence does not say, so the caption tells the chip's reader
 * which statement, component or endpoint the event belongs to.
 *
 * A query occurrence is named by its statement's leading keyword rather than
 * by its `callerName`: that name is the span the execution ran inside, which is
 * as often the enclosing route handler as the function that issued the
 * statement, and under a fact about one statement shape a chip reading as the
 * route says nothing about which statement it cites.
 */
const DESCRIBED_OCCURRENCE_SECTIONS: readonly {
  readonly fields: readonly string[];
  readonly kind?: string;
  readonly noun: string;
  readonly issuerFields: readonly string[];
  readonly subject: (row: JsonObject) => string | undefined;
}[] = [
  {
    fields: ['queries', 'queryGroups'],
    kind: 'db.query',
    noun: 'query',
    issuerFields: [],
    subject: (row) =>
      statementKeyword(asString(readField(row, 'statement', 'db.statement', 'sql', 'text'))),
  },
  {
    fields: ['renders', 'renderStats'],
    kind: 'render',
    noun: 'render',
    issuerFields: ['component'],
    subject: (row) => asString(readField(row, 'component', 'displayName', 'name')),
  },
  {
    fields: ['requests', 'requestGroups', 'duplicateRequests'],
    noun: 'request',
    issuerFields: ['callerName', 'component'],
    subject: (row) => {
      const method = asString(readField(row, 'method', 'http.method'));
      const path = asString(readField(row, 'path', 'endpoint', 'url'));
      if (path === undefined) {
        return undefined;
      }
      return method === undefined ? path : `${method} ${path}`;
    },
  },
];

/** Characters of a statement's leading keyword kept in a caption. */
const MAX_STATEMENT_KEYWORD_LENGTH = 16;

/**
 * The leading SQL keyword of a parameterised statement, upper-cased —
 * `SELECT`, `UPDATE`, `WITH`, `BEGIN` — for a caption that has to say which
 * statement shape an execution belongs to without repeating the statement.
 *
 * @param statement The statement text, when the aggregate carried one.
 * @returns The keyword, or `undefined` when the text does not begin with one.
 */
function statementKeyword(statement: string | undefined): string | undefined {
  const match = /^[A-Za-z]+/.exec((statement ?? '').trimStart());
  const keyword = match?.[0];
  return keyword === undefined
    ? undefined
    : keyword.slice(0, MAX_STATEMENT_KEYWORD_LENGTH).toUpperCase();
}

/**
 * The kind and caption of every event the capture describes with a record of
 * its own.
 *
 * Only a record keyed by the event's **own** `eventId` describes it: an
 * operation row, a trace node, an occurrence of an aggregate. A reference
 * known only from a bare evidence list, or from a representative id on some
 * other aggregate (a graph participant, a tree node), carries no description
 * of the event it names, so it is emitted as its id alone. The first record
 * that describes an event wins, in the fixed order operation rows, trace
 * sections, then occurrence sections, each in the order the context carried
 * its rows, so two runs describe an event identically.
 *
 * @param aggregates The capture-aggregate bag.
 * @returns The descriptor of each described event, within {@link MAX_EVIDENCE_IDS}.
 */
function describeEvidence(aggregates: JsonObject): ReadonlyMap<string, EvidenceDescriptor> {
  const descriptors = new Map<string, EvidenceDescriptor>();
  const describeRecord = (record: JsonObject, context: OccurrenceContext | undefined): void => {
    const eventId = singleEvidenceOf(record);
    if (eventId === undefined || descriptors.has(eventId) || descriptors.size >= MAX_EVIDENCE_IDS) {
      return;
    }
    descriptors.set(eventId, eventDescriptor(record, context));
  };

  for (const field of DESCRIBED_ROW_FIELDS) {
    for (const node of flattenNodes(aggregates[field])) {
      describeRecord(node, undefined);
    }
  }
  for (const section of DESCRIBED_OCCURRENCE_SECTIONS) {
    for (const field of section.fields) {
      for (const row of asObjectArray(aggregates[field]) ?? []) {
        const context: OccurrenceContext = {
          ...(section.kind !== undefined ? { kind: section.kind } : {}),
          noun: section.noun,
          issuerFields: section.issuerFields,
          ...optionalSubject(section.subject(row)),
        };
        for (const occurrence of asObjectArray(row['occurrences']) ?? []) {
          describeRecord(occurrence, context);
        }
      }
    }
  }
  return descriptors;
}

/**
 * What an occurrence's aggregate says about it: the section's kind and noun,
 * which of the occurrence's own fields name its issuer, and whose occurrence
 * the aggregate says it is.
 */
interface OccurrenceContext {
  /** What an occurrence of the section is, when fixed. */
  readonly kind?: string;
  /** What the section calls one occurrence. */
  readonly noun: string;
  /** The occurrence fields that name whose occurrence it is. */
  readonly issuerFields: readonly string[];
  /** Whose occurrence the aggregate says it is. */
  readonly subject?: string;
}

/**
 * A subject as an optional property, so an absent one is omitted rather than
 * written as `undefined` under `exactOptionalPropertyTypes`.
 *
 * @param subject The subject, when the aggregate stated one.
 * @returns `{ subject }`, or an empty object.
 */
function optionalSubject(subject: string | undefined): { readonly subject?: string } {
  return subject === undefined ? {} : { subject };
}

/**
 * The descriptor of one event record.
 *
 * The kind is the record's own when it is one of {@link EVIDENCE_REF_KINDS},
 * else the section's. The caption names the operation — the record's own name;
 * failing that, for an occurrence, its issuer (the occurrence fields its
 * section names) or else its aggregate's subject, followed by the section's
 * noun — and appends the record's duration when it has one:
 * `‹operation› (‹n› ms)`. The operation part is cut first, so the duration
 * survives any truncation, and the whole stays within {@link LABEL_MAX_LENGTH}.
 *
 * @param record An event record keyed by its own `eventId`.
 * @param context What the record's aggregate says about it, for an occurrence;
 * `undefined` for an operation row or a trace node, which describe themselves.
 * @returns The descriptor; empty when the record says nothing displayable.
 */
function eventDescriptor(
  record: JsonObject,
  context: OccurrenceContext | undefined,
): EvidenceDescriptor {
  const ownKind = asString(record['kind']);
  const kind = ownKind !== undefined && EVIDENCE_REF_KINDS.has(ownKind) ? ownKind : context?.kind;

  let operation = asString(readField(record, 'name', 'operation', 'label'));
  if (operation === undefined) {
    if (context === undefined) {
      operation = asString(readField(record, 'callerName', 'component'));
    } else {
      const issuer = asString(readField(record, ...context.issuerFields)) ?? context.subject;
      operation = issuer === undefined ? context.noun : `${issuer} ${context.noun}`;
    }
  }
  if (operation === undefined) {
    return kind === undefined ? {} : { kind };
  }

  const durationMs = asDurationMs(readField(record, 'durationMs', 'duration', 'elapsedMs'));
  // The canonical duration text carries its own unit (`formatDurationMs`).
  const suffix = durationMs === undefined ? '' : ` (${formatDurationMs(durationMs)})`;
  const name = truncateLabel(
    sanitizeLabel(operation, UNNAMED_OPERATION_LABEL),
    LABEL_MAX_LENGTH - suffix.length,
  );
  return {
    ...(kind !== undefined ? { kind } : {}),
    label: `${name}${suffix}`,
  };
}

/**
 * The citable subset of a candidate's references, as `{ eventId }` records,
 * each with the `kind` and `label` its {@link EvidenceDescriptor} supplies.
 *
 * Filtered against the harvested set, de-duplicated, ordered, and capped. An
 * empty result is the caller's signal to **drop the candidate entirely**: a
 * fact carries at least one reference, and one that cannot cite anything is one
 * this module has no business asserting. Keys are emitted in the fixed order
 * `eventId`, `kind`, `label`.
 *
 * Described references are cited first, each group in id order: a candidate
 * with more references than {@link MAX_EVIDENCE_PER_FACT} — a duplicate window
 * of nine requests whose aggregate lists five occurrences, say — then cites the
 * events a reader can recognise by their caption rather than by a raw id,
 * while a candidate at or under the cap cites every reference it has.
 *
 * @param references The candidate's raw references.
 * @param index The context's reference set.
 * @returns The citable references as JSON values, possibly empty.
 */
function citeEvidence(references: readonly string[], index: EvidenceIndex): JsonValue[] {
  const citable = new Set<string>();
  for (const reference of references) {
    if (index.available.has(reference)) {
      citable.add(reference);
    }
  }
  const sorted = sortStrings([...citable]);
  const captioned = (reference: string): boolean =>
    index.descriptors.get(reference)?.label !== undefined;
  const ordered = [
    ...sorted.filter((reference) => captioned(reference)),
    ...sorted.filter((reference) => !captioned(reference)),
  ].slice(0, MAX_EVIDENCE_PER_FACT);
  return ordered.map((reference) => {
    const descriptor = index.descriptors.get(reference);
    return {
      [EVIDENCE_OBJECT_KEY]: reference,
      ...(descriptor?.kind !== undefined ? { kind: descriptor.kind } : {}),
      ...(descriptor?.label !== undefined ? { label: descriptor.label } : {}),
    };
  });
}

/* -------------------------------------------------------------------------------------------------
 * source locations
 * ---------------------------------------------------------------------------------------------- */

/** Fields that carry a source location on an aggregate, probed in this order. */
const LOCATION_FIELDS: readonly string[] = ['source', 'location', 'suggestedLocation', 'callSite'];

/**
 * Reads a source location from the structured context, or reports that there
 * is none.
 *
 * Validated with the base package's schema rather than field by field, so this
 * module cannot accept a location the rest of the product would reject: the
 * path must be project-relative and contained, the line and column must be
 * 1-based, the resolution route must be one the product knows, and the
 * confidence must be within range. A location that fails is **dropped** — a
 * suggested location is a convenience, and a wrong one sends a developer to the
 * wrong file.
 *
 * A context that supplies a route but no confidence is completed from the
 * product's per-route defaults; the indexed read of that table is
 * `number | undefined` and is resolved with a check rather than an assertion,
 * so a route the table does not carry leaves the location incomplete and the
 * schema rejects it.
 *
 * @param value A value believed to be, or to carry, a source location.
 * @returns The validated location, or `undefined`.
 */
function readSourceLocation(value: JsonValue | undefined): SourceLocation | undefined {
  const source = asObject(value);
  if (source === undefined) {
    return undefined;
  }

  const file = asProjectPath(source.file);
  const line = asCount(source.line);
  const column = asCount(source.column);
  const resolvedBy = asString(source.resolvedBy);
  if (
    file === undefined ||
    line === undefined ||
    column === undefined ||
    resolvedBy === undefined
  ) {
    return nestedSourceLocation(source);
  }

  const confidence = asFiniteNumber(source.confidence) ?? defaultConfidenceFor(resolvedBy);
  if (confidence === undefined) {
    return undefined;
  }

  const symbol = asString(source.symbol);
  const endLine = asCount(source.endLine);
  const candidate: JsonObject = {
    file,
    line,
    column,
    ...(symbol !== undefined ? { symbol } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
    resolvedBy,
    confidence: roundValue(clampRange(confidence, 0, 1), LOCATION_CONFIDENCE_DECIMALS),
  };

  const parsed = parseSourceLocation(candidate);
  return parsed.ok ? parsed.value : undefined;
}

/**
 * Looks for a location nested one level inside an aggregate.
 *
 * An aggregate usually carries its location under a field of its own rather
 * than being one, so the direct read above falls through to here before giving
 * up. One level only: deeper probing would start guessing at structures nobody
 * documented.
 *
 * @param source An aggregate that is not itself a location.
 * @returns The validated nested location, or `undefined`.
 */
function nestedSourceLocation(source: JsonObject): SourceLocation | undefined {
  for (const field of LOCATION_FIELDS) {
    const nested = asObject(source[field]);
    if (nested === undefined) {
      continue;
    }
    const location = readSourceLocation(nested);
    if (location !== undefined) {
      return location;
    }
  }
  return undefined;
}

/**
 * The product's default confidence for a resolution route.
 *
 * @param resolvedBy A route name from the structured context.
 * @returns The default, or `undefined` when the route is not one of the
 * product's.
 */
function defaultConfidenceFor(resolvedBy: string): number | undefined {
  for (const route of SOURCE_RESOLVED_BY) {
    if (route === resolvedBy) {
      const known: SourceResolvedBy = route;
      return DEFAULT_RESOLUTION_CONFIDENCE[known];
    }
  }
  return undefined;
}

/**
 * A `file:line:column` label for a location an aggregate was read with, for
 * the frames that name a call site.
 *
 * @param location The validated location, when the aggregate had one.
 * @returns The label, or the empty string so the frame applies its own
 * documented fallback wording.
 */
function callSiteLabel(location: SourceLocation | undefined): string {
  return location === undefined ? '' : formatSourceLocation(location);
}

/* -------------------------------------------------------------------------------------------------
 * product vocabulary tables
 *
 * Four tables keyed by vocabularies the product owns: the capture signals a
 * plan may ask for, the node kinds a code graph reports, and the data sources a
 * panel node may read. None of them names anything belonging to an application
 * under test, and every one of them degrades rather than fails for a key it
 * does not carry, because the layers that produce these values are free to grow
 * their vocabularies without this module being edited.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The action types collected by a runtime hook rather than by rewriting a
 * symbol.
 *
 * Runtime hooks are the product's default and a rewrite is the exception, so a
 * need that either kind could satisfy is satisfied by the runtime one: it
 * modifies no file, it is live immediately, and it survives a reload. The two
 * absent members — the function and server-span timings — are the signals no
 * runtime hook can supply, because timing an arbitrary application function
 * means wrapping it.
 */
const RUNTIME_ACTION_TYPES: readonly ActionTypeId[] = [
  'react-render-tracking',
  'fetch-tracking',
  'db-query-tracking',
  'state-tracking',
  'interaction-tracking',
  'perf-tracking',
];

/**
 * The capture-signal vocabulary every signal list in these rules is expressed in.
 *
 * Mirrors `CAPTURE_SIGNALS` of `@debuggen/instrumentation` (`schema/readiness.ts`):
 * the closed vocabulary `ProblemUnderstanding.signalsNeeded` is validated
 * against, the adapters' readiness catalog is keyed by, and the readiness gate
 * reports one row per member of. The package layering (docs/ARCHITECTURE.md,
 * "Workspace layout and dependency layering") keeps this package below
 * instrumentation, so the names are restated rather than imported; an
 * understanding built in any other vocabulary is one the product's own schema
 * rejects, which is a defect of this module, not of the caller.
 */
const CAPTURE_SIGNAL_NAMES: readonly string[] = Object.freeze([
  'interactions',
  'react',
  'state',
  'fetch',
  'perf',
  'errors',
  'componentTree',
  'http',
  'routeHandlers',
  'prisma',
  'pg',
  'functions',
]);

/** Membership view of {@link CAPTURE_SIGNAL_NAMES}. */
const CAPTURE_SIGNAL_SET: ReadonlySet<string> = new Set(CAPTURE_SIGNAL_NAMES);

/**
 * Telemetry-kind spellings of a capture signal, translated on read.
 *
 * A context may name what it recorded by event kind (`render`, `db.query`) —
 * a capture summary's natural vocabulary — rather than by capture signal. Each
 * kind is read as the signal(s) whose hook produces it, so a kind and its
 * signal can never both be counted, and a gap is never reported for a signal
 * the capture already holds under its kind name. `db.query` stands for both
 * drivers because one query span looks the same whichever of them issued it.
 */
const SIGNAL_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  interaction: ['interactions'],
  render: ['react'],
  commit: ['react'],
  xhr: ['fetch'],
  'http.client': ['fetch'],
  navigation: ['perf'],
  'perf.longtask': ['perf'],
  'perf.entry': ['perf'],
  error: ['errors'],
  'server.error': ['errors'],
  'http.server': ['http'],
  'route.handler': ['routeHandlers'],
  function: ['functions'],
  'db.query': ['prisma', 'pg'],
});

/**
 * Reads a list of signal names into the capture-signal vocabulary.
 *
 * Capture signals pass through, telemetry-kind spellings are translated by
 * {@link SIGNAL_ALIASES}, and any other name is dropped: a name that belongs to
 * neither vocabulary selects no hook and no action type, and carrying it
 * forward would make the understanding this module answers with invalid
 * against the closed vocabulary its caller validates.
 *
 * @param names The names as read from a context.
 * @returns The distinct capture signals, ascending.
 */
function canonicalSignals(names: Iterable<string>): string[] {
  const signals = new Set<string>();
  for (const name of names) {
    if (CAPTURE_SIGNAL_SET.has(name)) {
      signals.add(name);
      continue;
    }
    for (const signal of SIGNAL_ALIASES[name] ?? []) {
      signals.add(signal);
    }
  }
  return sortStrings([...signals]);
}

/**
 * The `file` and `symbol` of a targetless action.
 *
 * Mirror `TARGETLESS_FILE` and `TARGETLESS_SYMBOL` of `@debuggen/instrumentation`
 * (`schema/plan.ts`): the explicit marker a runtime action that observes the
 * whole page or process names instead of an invented declaration.
 */
const TARGETLESS_ACTION_FILE = '.';
const TARGETLESS_ACTION_SYMBOL = '*';

/**
 * The action types that wrap one named declaration and so are never targetless.
 *
 * Mirrors `TARGET_REQUIRED_ACTION_TYPES` of `@debuggen/instrumentation`.
 */
const TARGET_REQUIRED_TYPES: ReadonlySet<string> = new Set(['function-timing', 'server-span']);

/**
 * The action types that can supply each capture signal, in preference order.
 *
 * Keyed by {@link CAPTURE_SIGNAL_NAMES} and mirroring the hooks each action type
 * arms in `@debuggen/instrumentation`'s readiness derivation. Read in two
 * places: choosing what a plan must install for the signals an understanding
 * asked for, and deciding which additive actions a follow-up needs for a signal
 * the existing capture is missing. A signal with no entry here needs no action
 * at all — errors are collected by a hook that is either on or off for the
 * whole capture, never per symbol.
 */
const SIGNAL_ACTION_TYPES: Readonly<Record<string, readonly ActionTypeId[]>> = Object.freeze({
  interactions: ['interaction-tracking'],
  react: ['react-render-tracking'],
  componentTree: ['react-render-tracking'],
  state: ['state-tracking'],
  fetch: ['fetch-tracking'],
  perf: ['perf-tracking'],
  // One runtime hook set observes both: perf-tracking arms the performance
  // observers and the page-error listeners together.
  errors: ['perf-tracking'],
  http: ['server-span'],
  routeHandlers: ['server-span'],
  functions: ['function-timing'],
  prisma: ['db-query-tracking'],
  pg: ['db-query-tracking'],
});

/**
 * The action types worth installing at each kind of code-graph node, in
 * preference order — runtime first, wherever a runtime hook can answer.
 *
 * A candidate whose kind is absent from this table falls back to
 * {@link DEFAULT_CODE_KIND_ACTION_TYPES}: timing the named symbol is the one
 * measurement that applies to any function, whatever role the graph assigned
 * it.
 */
const CODE_KIND_ACTION_TYPES: Readonly<Record<string, readonly ActionTypeId[]>> = Object.freeze({
  component: ['react-render-tracking', 'function-timing'],
  'event-handler': ['interaction-tracking', 'function-timing'],
  handler: ['interaction-tracking', 'function-timing'],
  'api-call': ['fetch-tracking', 'function-timing'],
  'api-route': ['server-span', 'function-timing'],
  'server-function': ['function-timing'],
  'db-call': ['db-query-tracking', 'function-timing'],
  file: [],
  symbol: ['function-timing'],
});

/**
 * Whether a candidate's symbol spells a declaration a patch could wrap.
 *
 * A patch-mode action wraps one named declaration, so a candidate named by a
 * route path, a module path or any other non-identifier is offered only the
 * runtime action types its kind supports. `Owner.member` spellings are
 * declarations too.
 *
 * @param symbol The candidate's symbol.
 * @returns `true` for an identifier or a dotted chain of identifiers.
 */
function isDeclarationSpelling(symbol: string): boolean {
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(symbol);
}

/** The fallback preference for a code-graph node kind with no entry above. */
const DEFAULT_CODE_KIND_ACTION_TYPES: readonly ActionTypeId[] = ['function-timing'];

/**
 * The code-node kind an understanding's entity kind establishes, for a
 * candidate that carries no kind of its own.
 *
 * The planning context lists the investigation's relevant files, which name a
 * file and a symbol but not the graph node's kind, so every such candidate would
 * otherwise read as a plain function and be offered `function-timing`. A symbol
 * the understanding itself names as a component is a component — the owner
 * chain of a selected element is exactly that — and a timing wrapper cannot be
 * applied to a React component without moving its render and its hook calls
 * out of the function React analyses (the patch feasibility check refuses it).
 * Only the kind whose default would be wrong is mapped.
 */
const ENTITY_CODE_KINDS: Readonly<Record<string, string>> = Object.freeze({
  component: 'component',
});

/**
 * Where each panel data source's material lives in a capture-aggregate bag,
 * probed in the order given.
 *
 * This is **not** a list of panel node types — those come from the catalog in
 * the structured context and from nowhere else. It is the reverse index a
 * catalog entry needs: the entry declares the source it reads, and this table
 * says which aggregate fields carry that source's material, so a node is
 * emitted only when the capture actually has something for it to show.
 */
const DATA_SOURCE_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  trace: ['trace', 'traces', 'traceTree', 'traceTrees'],
  spans: ['spans', 'topSpans', 'slowestSpans'],
  events: ['events', 'eventLog'],
  renders: ['renders', 'renderStats'],
  componentTree: ['componentTree', 'componentTreeSnapshot'],
  requests: ['requests', 'requestGroups'],
  queries: ['queries', 'queryGroups'],
  stateTransitions: ['stateTransitions', 'stateChanges'],
  graph: ['graph', 'dependencyGraph'],
  metrics: ['metrics'],
});

/** The data source whose node carries metric ids instead of a query. */
const METRICS_SOURCE = 'metrics';

/** The tier each per-tier duration metric measures. */
const TIER_DURATION_METRICS: Readonly<Record<string, ComputedMetricId>> = Object.freeze({
  browser: 'frontend_duration',
  server: 'backend_duration',
  db: 'database_duration',
});

/**
 * The metric measuring the database tier's time: the yardstick a repeated
 * statement shape's summed time is weighed against
 * ({@link REPEATED_QUERY_MATERIAL_SHARE}).
 */
const DATABASE_DURATION_METRIC: ComputedMetricId = 'database_duration';

/* -------------------------------------------------------------------------------------------------
 * structured-context readers
 *
 * The six stages assemble their contexts independently, so each reader below
 * probes a documented, fixed list of field names and looks one level into the
 * artifact bags a later stage carries forward. Nothing here reads the text of a
 * developer's request: a `question` field, if one is present, is not read, and
 * the dispatch that calls these builders cannot hand them the rendered prompt
 * in the first place.
 * ---------------------------------------------------------------------------------------------- */

/** The selected element or component, as a stage carried it forward. */
interface TargetView {
  /** A label for the target, for the frames that name one. */
  readonly label?: string;
  /** The component chain the selection resolved to, nearest first. */
  readonly chain: readonly string[];
}

/** An understanding, as the stage that produced it carried it forward. */
interface UnderstandingView {
  /** The pre-classified category, when one was carried. */
  readonly category?: string;
  /** The signals the understanding asked for. */
  readonly signals: readonly string[];
  /** The named entities the understanding reported. */
  readonly entities: readonly string[];
  /** The entities a context carried in the `{ kind, name, file? }` shape, in carried order. */
  readonly entityRecords: readonly EntityRecord[];
  /** The selected target, when there was one. */
  readonly target?: TargetView;
}

/** One named entity in the shape `ProblemUnderstanding.entities` carries. */
interface EntityRecord {
  /** A member of {@link ENTITY_KINDS}. */
  readonly kind: string;
  /** The entity's name: single-line, at most {@link MAX_ENTITY_NAME_CHARS} characters. */
  readonly name: string;
  /** The project-relative file declaring it, when one was carried. */
  readonly file?: string;
}

/**
 * The entity-kind vocabulary an understanding is answered in.
 *
 * Mirrors `PROBLEM_ENTITY_KINDS` of `@debuggen/instrumentation`
 * (`schema/target.ts`); restated for the layering reason given at
 * {@link CAPTURE_SIGNAL_NAMES}. A carried kind outside it is read as `'other'`.
 */
const ENTITY_KINDS: ReadonlySet<string> = new Set([
  'component',
  'function',
  'hook',
  'route',
  'file',
  'symbol',
  'selector',
  'url',
  'query',
  'other',
]);

/** The longest entity name `ProblemUnderstanding` accepts. */
const MAX_ENTITY_NAME_CHARS = 200;

/** The longest search hint `ProblemUnderstanding` accepts. */
const MAX_SEARCH_HINT_CHARS = 120;

/**
 * Whether a string can be an entity name or search hint of at most `max` characters.
 *
 * @param text The candidate.
 * @param max The longest accepted length.
 * @returns `true` for a non-blank, single-line string within the bound.
 */
function isSingleLineWithin(text: string, max: number): boolean {
  return text.trim().length > 0 && text.length <= max && !/[\r\n]/u.test(text);
}

/**
 * Reads the `{ kind, name, file? }` entities a bag carries.
 *
 * @param source The bag to read.
 * @param names The candidate field names, first match per field unioned.
 * @returns The records, in carried order; members that name nothing are dropped.
 */
function readEntityRecords(
  source: JsonObject | undefined,
  ...names: readonly string[]
): EntityRecord[] {
  if (source === undefined) {
    return [];
  }
  const records: EntityRecord[] = [];
  for (const field of names) {
    for (const member of asArray(source[field]) ?? []) {
      const object = asObject(member);
      const name = object === undefined ? undefined : asString(object['name']);
      if (object === undefined || name === undefined) {
        continue;
      }
      const kind = asString(object['kind']);
      const file = asProjectPath(object['file']);
      records.push({
        kind: kind !== undefined && ENTITY_KINDS.has(kind) ? kind : 'other',
        name,
        ...(file !== undefined ? { file } : {}),
      });
    }
  }
  return records;
}

/**
 * The understanding bag of a context, wherever the stage put it.
 *
 * Probed as `understanding` then `problemUnderstanding`; a context that carries
 * its understanding's fields at the top level (the understand stage's own
 * input) is served by reading the root itself, which is why every field reader
 * below is given both objects.
 *
 * @param root The structured context.
 * @returns The nested understanding bag, or `undefined`.
 */
function understandingBag(root: JsonObject): JsonObject | undefined {
  return readObjectField(root, 'understanding', 'problemUnderstanding');
}

/**
 * The words of a component name, split at its camel-case boundaries: an
 * upper-case run standing before a capitalised word (an acronym), a
 * capitalised or lower-case word, a remaining upper-case run, or a digit run.
 * Unicode letter classes, so the split does not depend on a locale.
 */
const NAME_WORD_PATTERN = /\p{Lu}+(?=\p{Lu}\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lu}+|\p{N}+/gu;

/** A component name as a declaration spells it: a capitalised identifier, no namespace member. */
const COMPONENT_IDENTIFIER_PATTERN = /^\p{Lu}[\p{L}\p{N}]*$/u;

/** A word of a component name made of letters. */
const LETTER_WORD_PATTERN = /^\p{L}+$/u;

/** The fewest letters a word must have to qualify a component name. */
const MIN_QUALIFYING_WORD_LETTERS = 2;

/** The fewest qualifying words a domain-qualified component name has. */
const MIN_QUALIFIED_NAME_WORDS = 2;

/**
 * Whether a component name is domain-qualified: a capitalised identifier of
 * {@link MIN_QUALIFIED_NAME_WORDS} or more camel-case words of at least
 * {@link MIN_QUALIFYING_WORD_LETTERS} letters each — a noun qualified by what
 * it is for (`‹Domain›‹Widget›`) rather than a bare building block
 * (`‹Widget›`).
 *
 * Structure only, and deliberately so: no list of design-system, framework or
 * application names is consulted, so the rule reads every project the same
 * way. A namespaced member (`‹Namespace›.‹member›`, the spelling of context
 * providers and compound library parts) is not a declaration's own name, and a
 * minified name's single-letter words qualify nothing.
 *
 * @param name A member of a component chain.
 * @returns `true` when the name is domain-qualified.
 * @example
 * // isQualifiedComponentName('‹Widget›') === false
 * // isQualifiedComponentName('TallyTile') === true
 */
function isQualifiedComponentName(name: string): boolean {
  if (!COMPONENT_IDENTIFIER_PATTERN.test(name)) {
    return false;
  }
  const words = (name.match(NAME_WORD_PATTERN) ?? []).filter(
    (word) => LETTER_WORD_PATTERN.test(word) && word.length >= MIN_QUALIFYING_WORD_LETTERS,
  );
  return words.length >= MIN_QUALIFIED_NAME_WORDS;
}

/**
 * The component names a context reports the project declares — its
 * `declaredComponents`, at the top level, in the understanding or beside the
 * selected target's chain.
 *
 * The service derives the list from the project's code graph: the members of
 * the owner chain a `component` node of the project declares. It is the
 * structural fact that separates the application's own components from the
 * framework's and the libraries' in an owner chain, which a React tree
 * interleaves; names only, compared exactly.
 *
 * @param root The structured context.
 * @returns The declared names; empty when the context reports none.
 */
function readDeclaredComponents(root: JsonObject): ReadonlySet<string> {
  const target =
    readObjectField(root, 'target', 'selectedTarget') ??
    readObjectField(understandingBag(root), 'target', 'selectedTarget');
  return new Set([
    ...readStringSet(root, 'declaredComponents'),
    ...readStringSet(understandingBag(root), 'declaredComponents'),
    ...readStringSet(target, 'declaredComponents'),
  ]);
}

/**
 * The component a list of component names — an owner chain or an
 * understanding's `component` entities, nearest first — points at, for a
 * label: the first application component.
 *
 * The chain starts at the component that rendered the element, which in a
 * project built on a design system is usually a bare building block, and it
 * ends in the framework's own boundaries; the application component that
 * placed the element is the one a developer recognises. So the nearest name
 * the project declares ({@link readDeclaredComponents}) that is
 * domain-qualified ({@link isQualifiedComponentName}) comes first — the
 * application component rather than its building block — then the nearest
 * declared name — a single-word application component rather than a
 * framework boundary above it — and, when the context reports no declaration
 * among the names, the nearest domain-qualified name, then the nearest name.
 *
 * @param names The names, nearest first.
 * @param declared The names the project declares.
 * @returns The name, or `undefined` for an empty list.
 */
function pointedComponentName(
  names: readonly string[],
  declared: ReadonlySet<string>,
): string | undefined {
  return (
    names.find((name) => declared.has(name) && isQualifiedComponentName(name)) ??
    names.find((name) => declared.has(name)) ??
    names.find(isQualifiedComponentName) ??
    names[0]
  );
}

/**
 * The selected-target descriptor of a context.
 *
 * The label is the first application component of the resolved chain
 * ({@link pointedComponentName}). Without a chain it falls back to the
 * element's own accessible text, then its tag name, then its selector — in
 * that order, because that is the order of decreasing usefulness to a
 * developer reading a panel title. Every one of them comes from the
 * descriptor the DevTools surface built from the selection or from the
 * project's code graph; none comes from prose. The chain itself is kept as
 * carried, nearest first.
 *
 * @param root The structured context.
 * @returns The target view, or `undefined` when nothing was selected.
 */
function readTarget(root: JsonObject): TargetView | undefined {
  const bag =
    readObjectField(root, 'target', 'selectedTarget') ??
    readObjectField(understandingBag(root), 'target', 'selectedTarget');
  if (bag === undefined) {
    return undefined;
  }

  const chain = asStringArray(readField(bag, 'componentChain', 'components', 'owners')).slice(
    0,
    MAX_ENTITIES,
  );
  const label =
    pointedComponentName(chain, readDeclaredComponents(root)) ??
    asString(readField(bag, 'text', 'label', 'accessibleName')) ??
    asString(bag.tagName) ??
    asString(bag.selector);

  return {
    ...(label !== undefined ? { label } : {}),
    chain,
  };
}

/**
 * The label of the component a plan is about, for a context that carries the
 * validated understanding rather than the selected target — the plan
 * stage's.
 *
 * A context that carries its target keeps that target's label. Otherwise the
 * selected element's owner chain the context carries as `selectedComponents`
 * names it — the selection itself, which may have arrived after the
 * understanding was settled — and without one the understanding's
 * `component` entities do, which the understand rules list with the owner
 * chain first, nearest first. Either list is read with {@link readTarget}'s
 * rule ({@link pointedComponentName}) and the declarations the caller knows
 * of — the plan stage's are the symbols its investigation resolved in the
 * project's code graph.
 *
 * @param root The structured context.
 * @param understanding The context's understanding view.
 * @param declared The component names the project declares.
 * @returns The label, or `undefined` when no target, chain or component
 * entity was carried.
 */
function pointedComponentLabel(
  root: JsonObject,
  understanding: UnderstandingView,
  declared: ReadonlySet<string>,
): string | undefined {
  if (understanding.target?.label !== undefined) {
    return understanding.target.label;
  }
  const selected = asStringArray(root['selectedComponents']).slice(0, MAX_ENTITIES);
  if (selected.length > 0) {
    return pointedComponentName(selected, declared);
  }
  const components = understanding.entityRecords
    .filter((record) => record.kind === 'component')
    .map((record) => record.name);
  return pointedComponentName(components, declared);
}

/**
 * The pre-classified problem category of a context.
 *
 * Echoed, never derived: classification belongs to the understand stage, and a
 * category invented here would be a classification made without the evidence
 * that stage has. When the context also carries the permitted set, the answer
 * is the intersection's first member **in the permitted set's order**, so the
 * value cannot be one the stage would reject; with no permitted set, the first
 * hint in the documented probe order is echoed as it stands, and an unfamiliar
 * value simply renders with the generic wording its label accessor falls back
 * to.
 *
 * @param root The structured context.
 * @returns The category, or `undefined` when none was carried.
 */
function readCategory(root: JsonObject): string | undefined {
  const bag = understandingBag(root);
  const hints: string[] = [];
  for (const source of [root, bag]) {
    if (source === undefined) {
      continue;
    }
    for (const field of ['category', 'categoryHint', 'problemCategory', 'categoryHints']) {
      for (const hint of asStringArray(source[field])) {
        hints.push(hint);
      }
    }
  }

  const permitted: string[] = [];
  for (const source of [root, bag]) {
    if (source === undefined) {
      continue;
    }
    for (const field of ['categories', 'allowedCategories', 'categoryOptions']) {
      for (const value of asStringArray(source[field])) {
        permitted.push(value);
      }
    }
  }

  if (permitted.length > 0) {
    for (const value of permitted) {
      if (hints.includes(value)) {
        return value;
      }
    }
    return undefined;
  }

  return hints[0];
}

/**
 * The understanding a context carries, from wherever it carries it.
 *
 * @param root The structured context.
 * @returns The understanding view; its arrays are empty rather than absent when
 * nothing was carried.
 */
function readUnderstanding(root: JsonObject): UnderstandingView {
  const bag = understandingBag(root);
  const target = readTarget(root);
  const category = readCategory(root);

  const signals = new Set<string>(
    canonicalSignals([
      ...readStringSet(root, 'signalsNeeded', 'signals', 'requestedSignals'),
      ...readStringSet(bag, 'signalsNeeded', 'signals', 'requestedSignals'),
    ]),
  );

  // The project summary is read for entities as well as the understanding
  // itself: the names a summary reports are exactly the named entities an
  // understanding is expected to carry, and the understand stage's own context
  // has them there rather than beside its category hint.
  const entities = new Set<string>();
  const entityRecords: EntityRecord[] = [];
  for (const source of [root, bag, readObjectField(root, 'projectSummary', 'project')]) {
    for (const entity of readStringSet(source, 'entities', 'components', 'namedEntities')) {
      entities.add(entity);
    }
    for (const record of readEntityRecords(source, 'entities', 'namedEntities')) {
      entities.add(record.name);
      entityRecords.push(record);
    }
  }
  if (target !== undefined) {
    for (const component of target.chain) {
      entities.add(component);
    }
  }

  return {
    ...(category !== undefined ? { category } : {}),
    signals: sortStrings([...signals]).slice(0, MAX_CAPTURE_SIGNALS),
    entities: sortStrings([...entities]).slice(0, MAX_ENTITIES),
    entityRecords,
    ...(target !== undefined ? { target } : {}),
  };
}

/**
 * The capture-aggregate bag of a context, wherever the stage put it.
 *
 * `aggregates` first because it is the specific name, then `summary` and
 * `captureSummary`, then `capture`. A context whose aggregates sit at the top
 * level is served by the root, which every caller passes as the fallback.
 *
 * @param root The structured context.
 * @returns The aggregates bag, or the root when there is no nested one.
 */
function aggregatesBag(root: JsonObject): JsonObject {
  return readObjectField(root, 'aggregates', 'summary', 'captureSummary', 'capture') ?? root;
}

/**
 * The analysis bag of a context, wherever the stage put it.
 *
 * @param root The structured context.
 * @returns The analysis bag, or `undefined`.
 */
function analysisBag(root: JsonObject): JsonObject | undefined {
  return readObjectField(root, 'analysis', 'analysisResult', 'latestAnalysis');
}

/**
 * The trace identifier a context reports, when it reports a usable one.
 *
 * Validated as a trace identifier rather than accepted as any string: a filter
 * naming an identifier that cannot exist selects nothing, and an empty panel
 * node is worse than an unfiltered one.
 *
 * @param root The structured context.
 * @returns The trace identifier, or `undefined`.
 */
function readTraceId(root: JsonObject): string | undefined {
  const aggregates = aggregatesBag(root);
  for (const source of [aggregates, analysisBag(root), root]) {
    if (source === undefined) {
      continue;
    }
    const direct = asString(readField(source, 'traceId', 'rootTraceId'));
    if (direct !== undefined && isTraceId(direct)) {
      return direct;
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------------------------------
 * follow-up focus
 *
 * A follow-up that regenerates an analysis and a panel asks a narrower
 * question than the one the session started with, and the analyze and
 * generate-panel contexts say which, structurally, in one optional top-level
 * field the follow-up stage fills:
 *
 *     followUpFocus: {
 *       categoryHints: string[],                              // best supported first
 *       declarations: { file, symbol, kind }[],               // graph-resolved
 *     }
 *
 * The hints are problem categories in the understanding vocabulary, classified
 * by the stage from the follow-up's lexical hints; the declarations are the
 * ones the follow-up named, already resolved through the code graph. Neither
 * carries any of the follow-up's wording, so a focus is a function of what was
 * classified and resolved, and two phrasings that classify and resolve alike
 * build byte-identical answers. A context without the field — every first
 * question — is answered exactly as it always was: every use of the focus below
 * is gated on its presence.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The problem categories a follow-up focus may name: the understanding
 * vocabulary ({@link UNDERSTANDING_CATEGORIES}) less its unclassified member,
 * which focuses on nothing. A hint outside it is ignored rather than read as
 * `'other'`.
 */
const FOCUS_CATEGORIES: ReadonlySet<string> = new Set([
  'performance',
  'rendering',
  'network',
  'data',
  'state',
  'error',
  'correctness',
]);

/** Declarations one follow-up focus is read with, at most. */
const MAX_FOCUS_DECLARATIONS = 8;

/** One declaration a follow-up named, as the code graph resolved it. */
interface FocusDeclaration {
  /** The declaring file, project-relative and contained, when the focus carried one. */
  readonly file?: string;
  /** The declaration's name, as the graph reports it. */
  readonly symbol: string;
  /** The graph's node kind for it, or the empty string. */
  readonly kind: string;
}

/** What a follow-up asks the analysis and the panel to concentrate on. */
interface FollowUpFocusView {
  /** Members of {@link FOCUS_CATEGORIES}, best supported first, without repeats. */
  readonly categories: readonly string[];
  /** At most {@link MAX_FOCUS_DECLARATIONS} declarations, in carried order, without repeats. */
  readonly declarations: readonly FocusDeclaration[];
}

/**
 * Reads the follow-up focus of a context, tolerantly.
 *
 * Probed as `followUpFocus` on the root, then inside the understanding bag for
 * a stage that nests it there. Category hints outside {@link FOCUS_CATEGORIES}
 * are ignored and repeats dropped, keeping the carried order — the order is the
 * stage's "best supported first". A declaration needs a name; its file is kept
 * only when it is a contained project path, and a repeat of an earlier
 * `file|symbol` pair is dropped. A focus left with neither a category nor a
 * declaration focuses on nothing and reads as absent.
 *
 * @param root The structured context.
 * @returns The focus, or `undefined` when the context carries none.
 */
function readFollowUpFocus(root: JsonObject): FollowUpFocusView | undefined {
  const bag =
    readObjectField(root, 'followUpFocus') ??
    readObjectField(understandingBag(root), 'followUpFocus');
  if (bag === undefined) {
    return undefined;
  }

  const categories: string[] = [];
  for (const hint of asStringArray(readField(bag, 'categoryHints', 'categories'))) {
    if (FOCUS_CATEGORIES.has(hint) && !categories.includes(hint)) {
      categories.push(hint);
    }
  }

  const declarations: FocusDeclaration[] = [];
  const seen = new Set<string>();
  for (const record of asObjectArray(readField(bag, 'declarations', 'symbols')) ?? []) {
    if (declarations.length >= MAX_FOCUS_DECLARATIONS) {
      break;
    }
    const symbol = asString(readField(record, 'symbol', 'name'));
    if (symbol === undefined) {
      continue;
    }
    const file = asProjectPath(readField(record, 'file', 'path'));
    const key = `${file ?? ''}|${symbol}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    declarations.push({
      ...(file !== undefined ? { file } : {}),
      symbol,
      kind: asString(readField(record, 'kind', 'nodeKind')) ?? '',
    });
  }

  if (categories.length === 0 && declarations.length === 0) {
    return undefined;
  }
  return { categories, declarations };
}

/**
 * The category a focus leads with: its best-supported hint.
 *
 * @param focus The context's focus, if any.
 * @returns The first category hint, or `undefined` when there is no focus or
 * it names declarations only.
 */
function leadingFocusCategory(focus: FollowUpFocusView | undefined): string | undefined {
  return focus?.categories[0];
}

/**
 * Separators a qualified span name joins an owner and a member with: a dotted
 * member (`‹owner›.‹member›`) and the private-member spelling
 * (`‹owner›#‹member›`).
 */
const QUALIFIED_NAME_SEPARATORS: readonly string[] = Object.freeze(['.', '#']);

/**
 * Whether a recorded name names a declaration: equal to its symbol, or that
 * symbol qualified by an owner.
 *
 * @param name A span's name, or the symbol its source location records.
 * @param symbol The declaration's symbol.
 * @returns `true` when `name` names the declaration.
 */
function namesDeclaration(name: string, symbol: string): boolean {
  if (name === symbol) {
    return true;
  }
  return QUALIFIED_NAME_SEPARATORS.some((separator) => name.endsWith(`${separator}${symbol}`));
}

/**
 * Whether a source location lies in a focused declaration: in its file when
 * both name one, and at its symbol when the location records one. A location
 * that records no symbol lies in the declaration only by file, so a
 * declaration that carries no file matches no symbol-less location.
 *
 * @param location A validated location.
 * @param declaration A focused declaration.
 * @returns `true` when the location lies in the declaration.
 */
function locationInDeclaration(location: SourceLocation, declaration: FocusDeclaration): boolean {
  if (declaration.file !== undefined && location.file !== declaration.file) {
    return false;
  }
  if (location.symbol !== undefined) {
    return namesDeclaration(location.symbol, declaration.symbol);
  }
  return declaration.file !== undefined;
}

/* -------------------------------------------------------------------------------------------------
 * capture-aggregate readers
 *
 * One view type per class of deterministic fact candidate, each keeping the
 * aggregate object it came from so the fact built from it can cite that
 * aggregate's evidence and reuse its location.
 * ---------------------------------------------------------------------------------------------- */

/** One measured operation of a capture. */
interface SpanView {
  /** The aggregate this view was read from. */
  readonly node: JsonObject;
  /** The operation's name, or the empty string when it has none. */
  readonly name: string;
  /** How long it took, in milliseconds. */
  readonly duration: number;
  /** The tier it was recorded in, when the capture attributed one. */
  readonly tier?: string;
  /** The telemetry kind of the event it is, when the capture states one. */
  readonly kind?: string;
}

/** One component's render statistics for a capture. */
interface RenderView {
  /** The aggregate this view was read from. */
  readonly node: JsonObject;
  /** The component's display name, or the empty string. */
  readonly component: string;
  /** Renders recorded for it. */
  readonly count: number;
  /** Renders whose props, own hook state and consumed contexts all held. */
  readonly unchanged: number;
  /** Renders whose trigger could not be determined. */
  readonly unknownTrigger: number;
  /** Renders triggered by a change of the component's own hook state. */
  readonly stateTriggered: number;
  /** Renders triggered by a change of a context value the component consumes. */
  readonly contextTriggered: number;
  /**
   * Whether the project declares the component: `true` or `false` as the
   * context reports it, `undefined` when the context carries no such field —
   * unknown, which is not the same as "not declared".
   */
  readonly declared: boolean | undefined;
  /**
   * The components providing the contexts whose changes re-rendered this one,
   * most frequent first. Names only, as the capture attributed them.
   */
  readonly changedContexts: readonly string[];
  /** The component's individual renders the context carries, in carried order. */
  readonly occurrences: readonly RenderOccurrenceView[];
}

/** One individual render of a component, as the context carried it. */
interface RenderOccurrenceView {
  /** The event the render is, citable when the context carries it. */
  readonly reference: string;
  /** Its trigger classification, when the context reports one. */
  readonly trigger: string | undefined;
  /** The providers of the contexts that changed at this render. */
  readonly contexts: readonly string[];
}

/**
 * One group of byte-identical requests.
 *
 * `count`, `windowMs` and `references` always describe the **same** requests,
 * because a fact renders them into one sentence ("‹count› requests … within
 * ‹windowMs› ms") and cites `references` for it.
 */
interface RequestGroupView {
  /** The aggregate this view was read from. */
  readonly node: JsonObject;
  /** Requests the view describes. */
  readonly count: number;
  /** The window they occurred within, in milliseconds. */
  readonly windowMs: number;
  /** The endpoint they addressed, when the capture reported one. */
  readonly endpoint?: string;
  /** The events of those requests, before filtering against the context. */
  readonly references: readonly string[];
  /** The one call site every located request came from, when they agree. */
  readonly location?: SourceLocation;
}

/** One group of statements sharing a shape. */
interface QueryGroupView {
  /** The aggregate this view was read from. */
  readonly node: JsonObject;
  /** Executions of the shape. */
  readonly count: number;
  /** The parameterised statement text, or the empty string. */
  readonly statement: string;
  /** The summed time of those executions, in milliseconds, when the capture reported it. */
  readonly totalMs?: number;
  /** Where the executions were issued from, when the capture located them. */
  readonly location?: SourceLocation;
}

/**
 * The measured operations of a capture.
 *
 * A flat list is preferred where the context carries one; otherwise the trace
 * trees are flattened, bounded, so a context that carries only a tree is still
 * readable. Operations without a usable duration are dropped: a fact about how
 * long something took needs the measurement it is about.
 *
 * @param aggregates The capture-aggregate bag.
 * @returns The operations, in the order the context carried them.
 */
function readSpans(aggregates: JsonObject): readonly SpanView[] {
  const flat = readObjectArrayField(aggregates, 'spans', 'topSpans', 'slowestSpans');
  const nodes =
    flat ??
    DATA_SOURCE_FIELDS.trace?.flatMap((field) => [...flattenNodes(aggregates[field])]) ??
    [];

  const spans: SpanView[] = [];
  for (const node of nodes) {
    const span = readSpanView(node);
    if (span !== undefined) {
      spans.push(span);
    }
  }
  return spans;
}

/**
 * One measured operation, read from its aggregate node.
 *
 * @param node A span row or trace node.
 * @returns The view, or `undefined` when the node carries no usable duration.
 */
function readSpanView(node: JsonObject): SpanView | undefined {
  const duration = asDurationMs(readField(node, 'duration', 'durationMs', 'elapsedMs'));
  if (duration === undefined) {
    return undefined;
  }
  const name = asString(readField(node, 'name', 'operation', 'label')) ?? '';
  const tier = asString(node.tier);
  const kind = asString(node.kind);
  return {
    node,
    name,
    duration,
    ...(tier !== undefined ? { tier } : {}),
    ...(kind !== undefined ? { kind } : {}),
  };
}

/**
 * Every measured operation a capture carries anywhere: the flat span lists and
 * every trace tree, each operation once.
 *
 * {@link readSpans} reads the flat list *or* the trees, because a list of the
 * slowest operations is what the ranked facts want. A declaration a follow-up
 * named need not be among the slowest, so the operations that measure it are
 * looked for in both, and a row the flat list and a tree both carry — the same
 * event, the same span — is counted once: keyed by its event, else by its span
 * identifier. A row carrying neither is kept as it is, since nothing says it
 * repeats another.
 *
 * @param aggregates The capture-aggregate bag.
 * @returns The operations, flat lists first, each in carried order.
 */
function readAllSpans(aggregates: JsonObject): readonly SpanView[] {
  const nodes: JsonObject[] = [];
  for (const field of DATA_SOURCE_FIELDS.spans ?? []) {
    nodes.push(...(asObjectArray(aggregates[field]) ?? []));
  }
  for (const field of DATA_SOURCE_FIELDS.trace ?? []) {
    nodes.push(...flattenNodes(aggregates[field]));
  }

  const spans: SpanView[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const key = singleEvidenceOf(node) ?? asString(node['spanId']);
    if (key !== undefined) {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
    }
    const span = readSpanView(node);
    if (span !== undefined) {
      spans.push(span);
    }
  }
  return spans;
}

/**
 * What a capture measured of one focused declaration.
 *
 * `spans` are the operations that measure it, longest first; `count` is how
 * many there are, and `totalMs` the time they took, summed over the outermost
 * ones only — a run nested inside another run of the same declaration is
 * counted as a run but its time is already inside its caller's, so summing it
 * again would claim more time than was spent.
 */
interface FocusedMeasurement {
  /** The declaration measured. */
  readonly declaration: FocusDeclaration;
  /** The operations that measure it, ordered by {@link sortSpans}. */
  readonly spans: readonly SpanView[];
  /** How many operations measure it. */
  readonly count: number;
  /**
   * The time they took, in milliseconds: every operation's duration except one
   * whose parent span is itself one of these operations, which the capture
   * links by `parentSpanId`.
   */
  readonly totalMs: number;
}

/**
 * Whether an operation measures a focused declaration.
 *
 * A located operation outside the declaration's file never does. One whose
 * location records the symbol it measured is decided by that symbol, the
 * record a timing patch makes of what it wrapped; otherwise its own name
 * decides — the declaration's symbol, or that symbol qualified by an owner
 * ({@link namesDeclaration}).
 *
 * @param span A measured operation.
 * @param declaration A focused declaration.
 * @returns `true` when the operation measures the declaration.
 */
function spanMeasuresDeclaration(span: SpanView, declaration: FocusDeclaration): boolean {
  const location = readSourceLocation(span.node);
  if (
    location !== undefined &&
    declaration.file !== undefined &&
    location.file !== declaration.file
  ) {
    return false;
  }
  if (location?.symbol !== undefined) {
    return namesDeclaration(location.symbol, declaration.symbol);
  }
  return span.name.length > 0 && namesDeclaration(span.name, declaration.symbol);
}

/**
 * What the capture measured of each focused declaration, in the focus's order;
 * a declaration the capture holds no operation of is left out, because a
 * measurement nobody took is not one to report.
 *
 * @param focus The context's focus.
 * @param aggregates The capture-aggregate bag.
 * @returns One measurement per measured declaration.
 */
function focusedMeasurements(
  focus: FollowUpFocusView,
  aggregates: JsonObject,
): readonly FocusedMeasurement[] {
  if (focus.declarations.length === 0) {
    return [];
  }
  const spans = sortSpans(readAllSpans(aggregates));
  const measurements: FocusedMeasurement[] = [];
  for (const declaration of focus.declarations) {
    const matched = spans.filter((span) => spanMeasuresDeclaration(span, declaration));
    if (matched.length === 0) {
      continue;
    }
    const ids = new Set<string>();
    for (const span of matched) {
      const id = asString(span.node['spanId']);
      if (id !== undefined) {
        ids.add(id);
      }
    }
    let totalMs = 0;
    for (const span of matched) {
      const parent = asString(span.node['parentSpanId']);
      if (parent === undefined || !ids.has(parent)) {
        totalMs += span.duration;
      }
    }
    measurements.push({
      declaration,
      spans: matched,
      count: matched.length,
      totalMs: roundValue(totalMs, METRIC_DECIMALS),
    });
  }
  return measurements;
}

/**
 * The render statistics of a capture.
 *
 * The two qualified counts are read separately and never conflated: an
 * undetermined trigger means one of the three conditions could not be
 * evaluated, which is not the same as having evaluated all three and found
 * nothing changed. The `state` and `context` members of the trigger histogram
 * are read too, when the context carries one, because they are what tells a
 * component that changed its own state apart from the consumers that merely
 * re-rendered with it; a statistic without a histogram reads as zero for both.
 *
 * Context attribution is read alongside: which providers' contexts changed
 * ({@link readChangedContexts}), whether the project declares the component,
 * and the individual renders with their own triggers, so a context-triggered
 * render can be cited as exactly that.
 *
 * @param aggregates The capture-aggregate bag.
 * @returns The statistics, in the order the context carried them.
 */
function readRenders(aggregates: JsonObject): readonly RenderView[] {
  const nodes = readObjectArrayField(aggregates, 'renders', 'renderStats') ?? [];
  const renders: RenderView[] = [];
  for (const node of nodes) {
    const count = asCount(readField(node, 'renderCount', 'count', 'renders'));
    if (count === undefined) {
      continue;
    }
    const triggers = readObjectField(node, 'triggers', 'triggerCounts');
    renders.push({
      node,
      component: asString(readField(node, 'component', 'displayName', 'name')) ?? '',
      count,
      unchanged:
        asCount(readField(node, 'unchangedRenderCount', 'unchangedCount', 'unchanged')) ?? 0,
      unknownTrigger:
        asCount(
          readField(node, 'renderTriggerUnknownCount', 'unknownTriggerCount', 'triggerUnknown'),
        ) ?? 0,
      stateTriggered: asCount(triggers?.['state']) ?? 0,
      contextTriggered: asCount(triggers?.['context']) ?? 0,
      declared: asBoolean(readField(node, 'declaredInProject', 'declared')),
      changedContexts: readChangedContexts(node),
      occurrences: readRenderOccurrences(node),
    });
  }
  return renders;
}

/** Provider names read from one render statistic's context attribution. */
const MAX_CHANGED_CONTEXTS_READ = 16;

/**
 * The providers of the contexts whose changes re-rendered one component, most
 * frequent first.
 *
 * Accepts both carriers a stage may use: `[{ name, count }]` records (the
 * service's analysis input) and a plain list of names with an optional
 * `changedContextCounts` map beside it (the upstream aggregate). Names are
 * de-duplicated; a list with counts is ordered by count, descending, and a
 * tie — or a name with no count — keeps its carried position, which is
 * already most-frequent-first with ties by name in both carriers. The order
 * is therefore total and independent of how the counts were spelled.
 *
 * @param node One render statistic.
 * @returns The provider names, bounded by {@link MAX_CHANGED_CONTEXTS_READ}.
 */
function readChangedContexts(node: JsonObject): readonly string[] {
  const list = asArray(readField(node, 'changedContexts', 'contexts'));
  if (list === undefined) {
    return [];
  }
  const counts = readObjectField(node, 'changedContextCounts', 'contextCounts');
  const entries: { readonly name: string; readonly count: number; readonly index: number }[] = [];
  const seen = new Set<string>();
  for (const [index, member] of list.entries()) {
    const record = asObject(member);
    const name =
      record === undefined
        ? asString(member)
        : asString(readField(record, 'name', 'provider', 'component'));
    if (name === undefined || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const listed = record === undefined ? undefined : asCount(record.count);
    const mapped =
      counts !== undefined && Object.hasOwn(counts, name) ? asCount(counts[name]) : undefined;
    // An unknown count sorts after every known one without reordering the unknowns.
    entries.push({ name, count: listed ?? mapped ?? -1, index });
  }
  return entries
    .sort((left, right) =>
      left.count === right.count ? left.index - right.index : right.count - left.count,
    )
    .slice(0, MAX_CHANGED_CONTEXTS_READ)
    .map((entry) => entry.name);
}

/**
 * The individual renders one statistic carries, each with the event it is.
 *
 * A render record without an event reference cannot be cited and is skipped.
 * Its changed-context names are read from `changedContextNames` (the service's
 * spelling) or `changedContexts` (the upstream one).
 *
 * @param node One render statistic.
 * @returns The citable renders, in carried order.
 */
function readRenderOccurrences(node: JsonObject): readonly RenderOccurrenceView[] {
  const occurrences: RenderOccurrenceView[] = [];
  for (const record of asObjectArray(node.occurrences) ?? []) {
    const reference = singleEvidenceOf(record);
    if (reference === undefined) {
      continue;
    }
    occurrences.push({
      reference,
      trigger: asString(record.trigger),
      contexts: asStringArray(readField(record, 'changedContextNames', 'changedContexts')),
    });
  }
  return occurrences;
}

/**
 * The request groups of a capture.
 *
 * Grouping is the capture's own, computed from a keyed digest of the
 * unredacted request rather than from the redacted display URL, so a group
 * counts byte-identical requests rather than requests that merely share a path.
 * This reader only reads what that grouping produced.
 *
 * @param aggregates The capture-aggregate bag.
 * @returns The groups, in the order the context carried them.
 */
function readRequestGroups(aggregates: JsonObject): readonly RequestGroupView[] {
  const nodes =
    readObjectArrayField(aggregates, 'requests', 'requestGroups', 'duplicateRequests') ?? [];
  const groups: RequestGroupView[] = [];
  for (const node of nodes) {
    const total = asCount(readField(node, 'count', 'occurrenceCount', 'duplicateCount'));
    if (total === undefined) {
      continue;
    }
    const endpoint = asString(readField(node, 'endpoint', 'url', 'path'));
    const described = describedRequests(node, total);
    const location = readSourceLocation(node) ?? sharedOccurrenceLocation(node);
    groups.push({
      node,
      ...described,
      ...(endpoint !== undefined ? { endpoint } : {}),
      ...(location !== undefined ? { location } : {}),
    });
  }
  return groups;
}

/** The part of a {@link RequestGroupView} that says which requests it describes. */
type DescribedRequests = Pick<RequestGroupView, 'count' | 'windowMs' | 'references'>;

/**
 * Which requests of a group a fact about it describes.
 *
 * A group that states its own window (`windowMs`) is described whole, with its
 * own evidence. One that states none but carries the service's duplicate
 * windows (`duplicateWindows: [{ startTime, endTime, count, eventIds }]`) is
 * described by its **largest** window — the burst of identical requests the
 * product's duplicate rule found — so the count, the duration and the cited
 * events are that window's. Otherwise the group is described whole, over the
 * span between its first and last start.
 *
 * @param node The request-group aggregate.
 * @param total The requests in the whole group.
 * @returns The count, window and references to use.
 */
function describedRequests(node: JsonObject, total: number): DescribedRequests {
  const direct = evidenceOf(node);
  const explicit = asDurationMs(readField(node, 'windowMs', 'window', 'spanMs'));
  if (explicit !== undefined) {
    return { count: total, windowMs: explicit, references: direct };
  }

  let largest: DescribedRequests | undefined;
  for (const window of asObjectArray(node['duplicateWindows']) ?? []) {
    const count = asCount(window['count']);
    const start = asFiniteNumber(window['startTime']);
    const end = asFiniteNumber(window['endTime']);
    const references = evidenceOf(window);
    if (count === undefined || start === undefined || end === undefined || end < start) {
      continue;
    }
    if (largest === undefined || count > largest.count) {
      largest = {
        count,
        windowMs: asDurationMs(end - start) ?? 0,
        references: references.length > 0 ? references : direct,
      };
    }
  }
  if (largest !== undefined) {
    return largest;
  }

  const first = asFiniteNumber(readField(node, 'firstStartTime', 'startTime'));
  const last = asFiniteNumber(readField(node, 'lastStartTime', 'endTime'));
  const spanned = first !== undefined && last !== undefined && last >= first ? last - first : 0;
  return { count: total, windowMs: asDurationMs(spanned) ?? 0, references: direct };
}

/**
 * The call site every located occurrence of an aggregate came from, when they
 * all agree on one.
 *
 * The service locates each request of a group on its own (the source-map route
 * over its initiator), and a group spans one call site only when every
 * occurrence that was located names the same file, line and column. Disagreeing
 * occurrences yield nothing rather than the first one's site: "from a single
 * call site" is exactly what the frames that use this location assert.
 *
 * @param node The aggregate.
 * @returns The shared location, or `undefined` when there is none or they differ.
 */
function sharedOccurrenceLocation(node: JsonObject): SourceLocation | undefined {
  let shared: SourceLocation | undefined;
  for (const field of EVIDENCE_OCCURRENCE_FIELDS) {
    for (const occurrence of asObjectArray(node[field]) ?? []) {
      const location = readSourceLocation(occurrence);
      if (location === undefined) {
        continue;
      }
      if (shared === undefined) {
        shared = location;
      } else if (
        shared.file !== location.file ||
        shared.line !== location.line ||
        shared.column !== location.column
      ) {
        return undefined;
      }
    }
  }
  return shared;
}

/**
 * The query groups of a capture.
 *
 * A statement arrives parameterised and redacted — placeholders rather than
 * literals, and never row contents — and is bounded like any other label on the
 * way into a sentence.
 *
 * Three further readings make a group rankable by what it cost and locatable
 * where it was issued. The service's analysis input
 * (`apps/local-service/src/analysis/summarize.ts`) states a group's summed time
 * as `totalDurationMs`, its executions as `occurrences[]` each with its own call
 * site, and its issuers as `callers[]`, each with its own summed time and
 * location. The location is the one call site every located execution shares;
 * failing agreement, the costliest caller's own location
 * ({@link dominantQueryCaller}); failing that, a location the group carries
 * itself. A cause names the issuing code by that location's `file:line` label.
 *
 * @param aggregates The capture-aggregate bag.
 * @returns The groups, in the order the context carried them.
 */
function readQueryGroups(aggregates: JsonObject): readonly QueryGroupView[] {
  const nodes = readObjectArrayField(aggregates, 'queries', 'queryGroups') ?? [];
  const groups: QueryGroupView[] = [];
  for (const node of nodes) {
    const count = asCount(readField(node, 'count', 'executionCount', 'total'));
    if (count === undefined) {
      continue;
    }
    const totalMs = asDurationMs(readField(node, 'totalDurationMs', 'totalDuration', 'durationMs'));
    const dominant = dominantQueryCaller(node);
    const location =
      sharedOccurrenceLocation(node) ??
      (dominant === undefined ? undefined : readSourceLocation(dominant)) ??
      readSourceLocation(node);
    groups.push({
      node,
      count,
      statement: asString(readField(node, 'statement', 'db.statement', 'sql', 'text')) ?? '',
      ...(totalMs !== undefined ? { totalMs } : {}),
      ...(location !== undefined ? { location } : {}),
    });
  }
  return groups;
}

/**
 * The caller that issued the most of a query group's time.
 *
 * Ordered by summed time, then by executions, both descending, then by name,
 * so the choice is total: a group whose callers report no time is decided by
 * how often each issued the statement, and two indistinguishable callers by
 * name. A caller that reports neither measure ranks as zero on it.
 *
 * @param node The query-group aggregate.
 * @returns The costliest caller record, or `undefined` when the group lists none.
 */
function dominantQueryCaller(node: JsonObject): JsonObject | undefined {
  const callers = asObjectArray(node['callers']) ?? [];
  let best: JsonObject | undefined;
  let bestMs = 0;
  let bestCount = 0;
  let bestName = '';
  for (const caller of callers) {
    const ms =
      asDurationMs(readField(caller, 'totalDurationMs', 'totalDuration', 'durationMs')) ?? 0;
    const count = asCount(readField(caller, 'executionCount', 'count')) ?? 0;
    const name = asString(readField(caller, 'name', 'callerName')) ?? '';
    const better =
      best === undefined ||
      ms > bestMs ||
      (ms === bestMs &&
        (count > bestCount || (count === bestCount && compareStrings(name, bestName) < 0)));
    if (better) {
      best = caller;
      bestMs = ms;
      bestCount = count;
      bestName = name;
    }
  }
  return best;
}

/**
 * Orders query groups by what they cost: summed time, then executions, both
 * descending, then statement text and first reference ascending.
 *
 * Time first because a repeated statement matters to a developer in
 * proportion to the time it took, not to how often it ran: a cheap shape
 * executed as often as an expensive one must not outrank it. A group whose
 * time is unknown ranks as zero on that key, so among such groups the order is
 * the count-based one.
 *
 * @param left First group.
 * @param right Second group.
 * @returns A negative number, zero, or a positive number.
 */
function compareQueryGroups(left: QueryGroupView, right: QueryGroupView): number {
  const leftMs = left.totalMs ?? 0;
  const rightMs = right.totalMs ?? 0;
  if (leftMs !== rightMs) {
    return rightMs - leftMs;
  }
  if (left.count !== right.count) {
    return right.count - left.count;
  }
  const byStatement = compareStrings(left.statement, right.statement);
  if (byStatement !== 0) {
    return byStatement;
  }
  return compareStrings(evidenceOf(left.node)[0] ?? '', evidenceOf(right.node)[0] ?? '');
}

/**
 * The metric values a capture reported.
 *
 * Two carriers are read because both are natural: a map from id to value, and
 * a list of id-and-value records. Only ids in {@link COMPUTED_METRIC_IDS} are
 * kept; a value the context reports under any other name is not a metric this
 * product computes. The values ground the facts and causes an analysis states;
 * they are never echoed onto the analysis itself, whose metrics protocol's
 * `createAnalysisResult` computes deterministically rather than accepting them
 * from a provider.
 */
interface MetricReading {
  /** The reported values, keyed by metric id. */
  readonly values: ReadonlyMap<ComputedMetricId, number>;
}

/**
 * Reads the metric values of a context.
 *
 * @param root The structured context.
 * @returns The reported values; an empty map when none were reported.
 */
function readMetrics(root: JsonObject): MetricReading {
  const values = new Map<ComputedMetricId, number>();
  const candidates = [aggregatesBag(root), analysisBag(root), root];

  for (const bag of candidates) {
    if (bag === undefined) {
      continue;
    }
    const map = asObject(bag.metrics);
    if (map !== undefined) {
      for (const id of COMPUTED_METRIC_IDS) {
        const value = asFiniteNumber(map[id]);
        if (value !== undefined && !values.has(id)) {
          values.set(id, roundValue(value, METRIC_DECIMALS));
        }
      }
      if (values.size > 0) {
        return { values };
      }
    }

    const list = asObjectArray(bag.metrics);
    if (list !== undefined) {
      for (const entry of list) {
        const id = asString(readField(entry, 'id', 'metricId', 'name'));
        const value = asFiniteNumber(readField(entry, 'value', 'amount'));
        if (id === undefined || value === undefined) {
          continue;
        }
        for (const known of COMPUTED_METRIC_IDS) {
          if (known === id && !values.has(known)) {
            values.set(known, roundValue(value, METRIC_DECIMALS));
          }
        }
      }
      if (values.size > 0) {
        return { values };
      }
    }
  }

  return { values };
}

/**
 * The interaction's measured total, in milliseconds.
 *
 * The reported total metric is authoritative; a context that carries the span
 * of the capture under its own field is read next; failing both, the longest
 * single operation is used, which is the smallest total consistent with what
 * was measured.
 *
 * @param root The structured context.
 * @param reading The metric reading.
 * @param spans The measured operations.
 * @returns The total, or `undefined` when nothing was measured.
 */
function readTotalDuration(
  root: JsonObject,
  reading: MetricReading,
  spans: readonly SpanView[],
): number | undefined {
  const reported = reading.values.get('total_duration');
  if (reported !== undefined) {
    return reported;
  }
  const carried = asDurationMs(
    readField(aggregatesBag(root), 'totalDurationMs', 'totalDuration', 'durationMs'),
  );
  if (carried !== undefined) {
    return carried;
  }
  let longest: number | undefined;
  for (const span of spans) {
    if (longest === undefined || span.duration > longest) {
      longest = span.duration;
    }
  }
  return longest;
}

/**
 * How much material each panel data source has in this context.
 *
 * Two sources of truth, merged in a fixed order: the counts computed from the
 * aggregate fields of {@link DATA_SOURCE_FIELDS}, then any counts the context
 * reports explicitly, which win because a layer that names its own populated
 * sources knows better than a field probe. The metrics source is counted as the
 * number of reported metric ids, since that is what a card can show.
 *
 * @param root The structured context.
 * @param reading The metric reading.
 * @returns A count per source name; absent means nothing was found.
 */
function readSourceCounts(root: JsonObject, reading: MetricReading): ReadonlyMap<string, number> {
  const aggregates = aggregatesBag(root);
  const counts = new Map<string, number>();

  for (const source of sortStrings(Object.keys(DATA_SOURCE_FIELDS))) {
    if (source === METRICS_SOURCE) {
      counts.set(source, reading.values.size);
      continue;
    }
    const fields = DATA_SOURCE_FIELDS[source] ?? [];
    let total = 0;
    for (const field of fields) {
      total += countDataItems(aggregates[field]);
    }
    counts.set(source, total);
  }

  const declared = readObjectField(root, 'populatedSources', 'sourceCounts', 'dataSources');
  if (declared !== undefined) {
    for (const key of sortedKeys(declared)) {
      const value = asCount(declared[key]);
      if (value !== undefined) {
        counts.set(key, value);
      }
    }
  }

  const declaredList = readObjectArrayField(root, 'populatedSources', 'dataSources');
  if (declaredList !== undefined) {
    for (const entry of declaredList) {
      const name = asString(readField(entry, 'source', 'name', 'id'));
      const value = asCount(readField(entry, 'count', 'total', 'items'));
      if (name !== undefined && value !== undefined) {
        counts.set(name, value);
      }
    }
  }

  return counts;
}

/**
 * How many items a value carries, for materiality purposes.
 *
 * An array counts its members; a container counts the nodes of its bounded
 * walk; a map of numbers counts its numeric members; any other object counts as
 * one item, because a snapshot object is itself the material.
 *
 * @param value A candidate aggregate field.
 * @returns The item count; `0` when the field carries nothing.
 */
function countDataItems(value: JsonValue | undefined): number {
  const array = asArray(value);
  if (array !== undefined) {
    return array.length;
  }
  const object = asObject(value);
  if (object === undefined) {
    return 0;
  }
  for (const field of CHILD_FIELDS) {
    if (asArray(object[field]) !== undefined) {
      return flattenNodes(object).length;
    }
  }
  let numeric = 0;
  for (const key of sortedKeys(object)) {
    if (asFiniteNumber(object[key]) !== undefined) {
      numeric += 1;
    }
  }
  return numeric > 0 ? numeric : 1;
}

/**
 * Whether a data source has enough material for a panel node to be worth
 * emitting.
 *
 * @param source A data source name from a catalog entry.
 * @param counts The per-source counts of this context.
 * @returns `true` when the source meets its threshold.
 */
function isMaterialSource(source: string, counts: ReadonlyMap<string, number>): boolean {
  const threshold = MATERIAL_MIN_ITEMS_BY_SOURCE[source] ?? MATERIAL_MIN_ITEMS;
  return (counts.get(source) ?? 0) >= threshold;
}

/**
 * Whether any of several bags reports something under any of several fields.
 *
 * Presence, not content: a `true`, a positive count, a populated array and a
 * populated object all mean "the context says this exists", and that is the
 * only question the signal derivation below asks. It is a field-presence check
 * rather than an inspection of anything a developer wrote, which is what keeps
 * the derivation wording-invariant.
 *
 * @param bags Objects to probe, in any order — the answer is a disjunction.
 * @param fields Field names that would report the feature.
 * @returns `true` when one of them reports it.
 */
function reportsPresence(
  bags: readonly (JsonObject | undefined)[],
  ...fields: readonly string[]
): boolean {
  for (const bag of bags) {
    if (bag === undefined) {
      continue;
    }
    for (const field of fields) {
      const value = bag[field];
      if (asBoolean(value) === true) {
        return true;
      }
      const count = asFiniteNumber(value);
      if (count !== undefined && count > 0) {
        return true;
      }
      const array = asArray(value);
      if (array !== undefined && array.length > 0) {
        return true;
      }
      const object = asObject(value);
      if (object !== undefined && Object.keys(object).length > 0) {
        return true;
      }
    }
  }
  return false;
}

/* -------------------------------------------------------------------------------------------------
 * stage 1 — problem understanding
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds the problem understanding of a request from its structured context.
 *
 * The category is echoed rather than decided (see {@link readCategory}); the
 * signals are derived from **field presence** in the context — a selected
 * target implies the interaction and render signals, reported server routes
 * imply the server signals, reported database use implies the query signal,
 * reported request call sites imply the request signal — and carried signals
 * are unioned in so a later stage's understanding survives a round trip. The
 * echoed category's profile ({@link CATEGORY_PROFILES}) then adds the signals
 * its class of behaviour needs, drops for a page-observed class the
 * server-tier signals the project's shape implied, and keeps the interaction
 * signal only where the class is reproduced by input on a selected element
 * ({@link CategoryProfile.inputDriven}). The
 * entities are the selected target's component chain and whatever the project
 * summary named, de-duplicated and ordered; the search hints are derived
 * mechanically from those entities and their file stems.
 *
 * @param input The structured context of an understand-stage request.
 * @returns The understanding as plain JSON, or `undefined` when the context
 * carries no category, no signal and no entity — nothing to understand with.
 */
export function buildUnderstanding(input: JsonValue | undefined): JsonValue | undefined {
  const root = asObject(input);
  if (root === undefined) {
    return undefined;
  }

  const understanding = readUnderstanding(root);
  const projectSummary = readObjectField(root, 'projectSummary', 'project');
  // A code-analysis project summary reports its tallies under `counts`, so the
  // presence fields are read there as well as at the top level.
  const counts = readObjectField(projectSummary, 'counts');
  const bags: readonly (JsonObject | undefined)[] = [
    root,
    understandingBag(root),
    projectSummary,
    counts,
  ];
  // Tallies only: a summary's `components` list of names is an entity source,
  // not a count, so the render and interaction rules read the counts alone.
  const summaryCounts: readonly (JsonObject | undefined)[] = [counts];

  const signals = new Set<string>(understanding.signals);
  if (understanding.target !== undefined) {
    signals.add('interactions');
    signals.add('react');
  }
  if (
    reportsPresence(
      bags,
      'hasServerRoutes',
      'hasApiRoutes',
      'serverRoutes',
      'apiRoutes',
      'routes',
      'routeCount',
    )
  ) {
    signals.add('http');
    signals.add('routeHandlers');
  }
  const drivers = reportedDatabaseDrivers(projectSummary);
  if (
    drivers !== undefined ||
    reportsPresence(
      bags,
      'hasDatabase',
      'usesDatabase',
      'databaseClients',
      'databaseCalls',
      'dbCalls',
      'dbCallCount',
    )
  ) {
    for (const driver of drivers ?? DATABASE_DRIVER_SIGNALS) {
      signals.add(driver);
    }
  }
  if (reportsPresence(bags, 'hasClientRequests', 'apiCalls', 'apiCallCount', 'requestCallSites')) {
    signals.add('fetch');
  }
  // Reported components make renders worth capturing, and reported event
  // handlers make interactions worth capturing, as a selected target does.
  if (reportsPresence(summaryCounts, 'components', 'componentCount')) {
    signals.add('react');
  }
  if (reportsPresence(summaryCounts, 'handlers', 'eventHandlers', 'handlerCount')) {
    signals.add(INTERACTION_SIGNAL);
  }
  // The classified category shapes the list next: its own signals join; a
  // page-observed category sheds the server-tier signals the project's shape
  // implied; and the interaction stays a needed signal only for a class
  // reproduced by input about a selected element — a signal a later stage
  // reads as "this capture is empty without a click" (AAP §0.5.5). Nothing the
  // context carried is ever shed: an earlier stage chose it.
  const profile = categoryProfile(understanding.category);
  if (profile !== undefined) {
    const carried = new Set(understanding.signals);
    for (const signal of profile.signals) {
      signals.add(signal);
    }
    if (profile.pageOnly) {
      for (const signal of SERVER_TIER_SIGNALS) {
        if (!carried.has(signal)) {
          signals.delete(signal);
        }
      }
    }
    const pointedAtInput = profile.inputDriven && understanding.target !== undefined;
    if (!pointedAtInput && !carried.has(INTERACTION_SIGNAL)) {
      signals.delete(INTERACTION_SIGNAL);
    }
  }
  // A question observed in the page is also observed through its performance
  // entries: long tasks, resource timing and the navigation that framed the
  // document are the only source of the browser-tier measurements
  // (`blocking_time`, `long_task_count`, `transferred_bytes`), and a reload
  // during a capture is visible only as its navigation entry. The hook edits
  // no file, so it is collected whenever the page itself is.
  if (signals.has(INTERACTION_SIGNAL) || signals.has('react')) {
    signals.add('perf');
  }

  const entities = understandingEntities(root, understanding, projectSummary);
  const hints = new Set<string>();
  for (const entity of entities) {
    // A URL or a DOM locator names no declaration, so neither makes a name lookup.
    if (entity.kind === 'url' || entity.kind === 'selector') {
      continue;
    }
    for (const hint of [entity.name, ...pathStems(entity.name)]) {
      if (isSingleLineWithin(hint, MAX_SEARCH_HINT_CHARS)) {
        hints.add(hint);
      }
    }
  }

  const orderedSignals = sortStrings([...signals]).slice(0, MAX_CAPTURE_SIGNALS);
  const searchHints = sortStrings([...hints]).slice(0, MAX_SEARCH_HINTS);

  if (
    understanding.category === undefined &&
    orderedSignals.length === 0 &&
    entities.length === 0
  ) {
    return undefined;
  }

  return {
    category: understandingCategory(understanding.category),
    signalsNeeded: orderedSignals,
    entities: entities.map((entity) => ({ ...entity })),
    searchHints,
  };
}

/**
 * The named entities an understanding reports, most specific first.
 *
 * Every entity comes from a structured field of the context, never from the
 * question's prose: the selected target's component chain, entities carried in
 * record shape, bare names carried by an earlier stage or the project summary
 * (a path-shaped name is a `'file'`, any other a `'symbol'`), the identifier
 * candidates the stage's generic tokenizer extracted, the page the question was
 * asked on, and finally the routes the project summary reports — the seeds a
 * code investigation can start from when nothing more specific was given. Each
 * name appears once, under the first kind it was read with.
 *
 * @param root The structured context.
 * @param understanding The context's understanding view.
 * @param projectSummary The context's project summary, if any.
 * @returns At most {@link MAX_ENTITIES} records.
 */
function understandingEntities(
  root: JsonObject,
  understanding: UnderstandingView,
  projectSummary: JsonObject | undefined,
): EntityRecord[] {
  const records: EntityRecord[] = [];
  const seen = new Set<string>();
  const add = (kind: string, name: string, file?: string): void => {
    if (seen.has(name) || !isSingleLineWithin(name, MAX_ENTITY_NAME_CHARS)) {
      return;
    }
    seen.add(name);
    records.push({ kind, name, ...(file !== undefined ? { file } : {}) });
  };

  for (const component of understanding.target?.chain ?? []) {
    add('component', component);
  }
  for (const record of understanding.entityRecords) {
    add(record.kind, record.name, record.file);
  }
  for (const name of understanding.entities) {
    add(isPathShaped(name) ? 'file' : 'symbol', name);
  }
  for (const identifier of asStringArray(root['identifierCandidates'])) {
    add('symbol', identifier);
  }
  const currentUrl = asString(root['currentUrl']);
  if (currentUrl !== undefined) {
    add('url', currentUrl);
  }
  for (const route of asArray(projectSummary?.['routes']) ?? []) {
    const object = asObject(route);
    const path =
      object === undefined ? asString(route) : asString(readField(object, 'routePath', 'path'));
    if (path !== undefined) {
      add('route', path);
    }
  }

  return records.slice(0, MAX_ENTITIES);
}

/**
 * Whether a bare entity name reads as a module path rather than a declaration.
 *
 * @param name The name.
 * @returns `true` when it contains a separator or ends in a file extension.
 */
function isPathShaped(name: string): boolean {
  return name.includes('/') || extnamePosix(basenamePosix(name)).length > 0;
}

/**
 * The problem-category vocabulary an understanding is answered in.
 *
 * Mirrors `PROBLEM_CATEGORIES` of `@debuggen/instrumentation`
 * (`schema/target.ts`), which `ProblemUnderstanding.category` is validated
 * against; restated rather than imported for the layering reason given at
 * {@link CAPTURE_SIGNAL_NAMES}.
 */
const UNDERSTANDING_CATEGORIES: ReadonlySet<string> = new Set([
  'performance',
  'rendering',
  'network',
  'data',
  'state',
  'error',
  'correctness',
  'other',
]);

/**
 * The understanding category each of `../deterministic/templates.js`'s
 * symptom-level categories belongs to.
 *
 * A carried symptom is folded into the class of behaviour it is an instance
 * of, so a context phrased in either vocabulary yields the same valid value.
 */
const CATEGORY_CLASSES: Readonly<Record<string, string>> = Object.freeze({
  'slow-interaction': 'performance',
  'slow-request': 'performance',
  'slow-query': 'performance',
  'blocked-main-thread': 'performance',
  'excessive-renders': 'rendering',
  'duplicate-requests': 'network',
  'unexpected-state': 'state',
  'runtime-error': 'error',
});

/** The category of an understanding whose context classified nothing. */
const UNCLASSIFIED_CATEGORY = 'other';

/**
 * The category an understanding reports.
 *
 * Echoed, never decided: a carried category in the understanding vocabulary is
 * kept, a carried symptom-level category is read as its class, and anything
 * else — including no category at all — is reported as `'other'`, the member
 * the vocabulary keeps so that classification never has to lie.
 *
 * @param carried The category the context carried, if any.
 * @returns A member of {@link UNDERSTANDING_CATEGORIES}.
 */
function understandingCategory(carried: string | undefined): string {
  if (carried === undefined) {
    return UNCLASSIFIED_CATEGORY;
  }
  if (UNDERSTANDING_CATEGORIES.has(carried)) {
    return carried;
  }
  return CATEGORY_CLASSES[carried] ?? UNCLASSIFIED_CATEGORY;
}

/* -------------------------------------------------------------------------------------------------
 * category profiles
 *
 * What a classified problem category changes about the answers after it. The
 * category is echoed from the structured context, never derived here, and a
 * profile is keyed by the category value alone — a table lookup, so the answer
 * stays a function of structured input. Each profile is product vocabulary
 * only: capture signals, action types and a panel lens, nothing of any
 * application.
 *
 * Without a profile — `correctness`, `other`, or no category at all — every
 * stage answers from the project's shape and the capture's evidence alone,
 * exactly as it would with no classification.
 * ---------------------------------------------------------------------------------------------- */

/** What one problem category changes about the understanding, the plan and the panel. */
interface CategoryProfile {
  /**
   * Capture signals every understanding of the category asks for, beyond the
   * ones the project's shape implies: a rendering question needs the component
   * tree and hook-state transitions whether or not the summary counted them.
   */
  readonly signals: readonly string[];
  /**
   * Whether the behaviour is observed in the page alone, so the server and
   * database signals the project's shape would imply are left out: a question
   * about renders or client state is not answered by route or query timings,
   * and collecting them would arm the server-side hooks for nothing.
   */
  readonly pageOnly: boolean;
  /**
   * Whether the behaviour is reproduced by the developer's input, so a
   * question about a selected element needs the interaction signal — the
   * capture stage then calls a capture without an interaction empty (AAP
   * §0.5.5). A render, state or request problem shows while the page is idle:
   * such a question needs no interaction, whatever element it points at, and
   * no class needs one merely because the project has event handlers.
   */
  readonly inputDriven: boolean;
  /**
   * Signals a plan for the category observes whenever the page is observed,
   * without the understanding needing them: an interaction during a latency
   * capture roots the correlated trace it causes, so the hook is armed even
   * when the question does not demand a click.
   */
  readonly observedSignals: readonly string[];
  /**
   * The action types a plan may install at an investigated candidate, or
   * `undefined` for every type. A page-observed question installs only runtime
   * hooks, so no application file is rewritten to time a function the question
   * is not about (AAP §0.5.1 makes the rewrite the exception).
   */
  readonly candidateActionTypes?: ReadonlySet<ActionTypeId>;
  /** The evidence lens a panel for the category is composed through. */
  readonly lens: PanelLens;
}

/** The capture signal of a user's input. */
const INTERACTION_SIGNAL = 'interactions';

/** The signals that show a plan observes the page: renders, or its performance entries. */
const PAGE_OBSERVED_SIGNALS: readonly string[] = Object.freeze(['react', 'perf']);

/**
 * The signals collected on the server or in its database: the ones a
 * page-observed profile does not take from the project's shape.
 */
const SERVER_TIER_SIGNALS: ReadonlySet<string> = new Set([
  'http',
  'routeHandlers',
  'prisma',
  'pg',
  'functions',
]);

/**
 * The runtime hooks that observe the page — the only action types a
 * page-observed plan installs at an investigated candidate.
 */
const PAGE_RUNTIME_ACTION_TYPES: ReadonlySet<ActionTypeId> = new Set<ActionTypeId>([
  'react-render-tracking',
  'state-tracking',
  'interaction-tracking',
  'perf-tracking',
  'fetch-tracking',
]);

/**
 * The runtime hooks a request-shaped question installs at a candidate: the
 * page's hooks plus the query hook, which also installs nothing in a file.
 */
const REQUEST_RUNTIME_ACTION_TYPES: ReadonlySet<ActionTypeId> = new Set<ActionTypeId>([
  ...PAGE_RUNTIME_ACTION_TYPES,
  'db-query-tracking',
]);

/**
 * The profile of each understanding category that has one.
 *
 * - `performance`, `data` and `error` are latency-, query- and failure-shaped:
 *   every tier may hold the answer, so every signal and action type the
 *   project supports stays available and the panel reads the timing lens.
 *   They are reproduced by input: a selected element makes the interaction a
 *   needed signal, and the plan observes interactions in any case.
 *   `error` adds the page-error signal, which no project shape implies.
 * - `network` is about the requests themselves — how many, how often, issued
 *   by whom: it asks for the request signal, keeps the server and database
 *   signals the requests reach, needs no input, installs runtime hooks only,
 *   and reads the request lens.
 * - `rendering` and `state` are about the component tree: they ask for render,
 *   component-tree and hook-state signals, drop the server tier, need no
 *   input, install page hooks only, and read the component lens.
 */
const CATEGORY_PROFILES: Readonly<Record<string, CategoryProfile>> = Object.freeze({
  performance: {
    signals: [],
    pageOnly: false,
    inputDriven: true,
    observedSignals: [INTERACTION_SIGNAL],
    lens: 'timing',
  },
  data: {
    signals: [],
    pageOnly: false,
    inputDriven: true,
    observedSignals: [INTERACTION_SIGNAL],
    lens: 'timing',
  },
  error: {
    signals: ['errors'],
    pageOnly: false,
    inputDriven: true,
    observedSignals: [INTERACTION_SIGNAL],
    lens: 'timing',
  },
  network: {
    signals: ['fetch'],
    pageOnly: false,
    inputDriven: false,
    observedSignals: [],
    candidateActionTypes: REQUEST_RUNTIME_ACTION_TYPES,
    lens: 'requests',
  },
  rendering: {
    signals: ['react', 'componentTree', 'state'],
    pageOnly: true,
    inputDriven: false,
    observedSignals: [],
    candidateActionTypes: PAGE_RUNTIME_ACTION_TYPES,
    lens: 'component',
  },
  state: {
    signals: ['state', 'react', 'componentTree'],
    pageOnly: true,
    inputDriven: false,
    observedSignals: [],
    candidateActionTypes: PAGE_RUNTIME_ACTION_TYPES,
    lens: 'component',
  },
});

/**
 * The signals a plan reserves a runtime hook for: the understanding's own,
 * plus the ones its category observes ({@link CategoryProfile.observedSignals})
 * when the understanding observes the page at all.
 *
 * @param understanding The context's understanding view.
 * @returns The signals, unordered and without repeats.
 */
function plannedSignals(understanding: UnderstandingView): readonly string[] {
  const signals = new Set(understanding.signals);
  const observesPage = PAGE_OBSERVED_SIGNALS.some((signal) => signals.has(signal));
  if (observesPage) {
    for (const signal of categoryProfile(understanding.category)?.observedSignals ?? []) {
      signals.add(signal);
    }
  }
  return [...signals];
}

/**
 * The profile of a carried category, read into the understanding vocabulary
 * first so a symptom-level category shares its class's profile.
 *
 * @param category The category the context carried, if any.
 * @returns The profile, or `undefined` when the category has none.
 */
function categoryProfile(category: string | undefined): CategoryProfile | undefined {
  const understood = understandingCategory(category);
  return Object.hasOwn(CATEGORY_PROFILES, understood) ? CATEGORY_PROFILES[understood] : undefined;
}

/** The database signals, one per driver, for a project whose driver is not reported. */
const DATABASE_DRIVER_SIGNALS: readonly string[] = Object.freeze(['pg', 'prisma']);

/**
 * The database drivers a project summary reports, as capture signals.
 *
 * Read from the summary's `databaseAccess.style` — `'prisma'`, `'pg'`, `'both'`
 * or `'none'` — so an understanding asks for exactly the drivers the project
 * uses rather than for both whenever it touches a database.
 *
 * @param projectSummary The context's project summary, if any.
 * @returns The driver signals, an empty list for `'none'`, or `undefined` when
 * the summary reports no access style.
 */
function reportedDatabaseDrivers(
  projectSummary: JsonObject | undefined,
): readonly string[] | undefined {
  const style = asString(readObjectField(projectSummary, 'databaseAccess')?.['style']);
  switch (style) {
    case 'prisma':
    case 'pg':
      return [style];
    case 'both':
      return DATABASE_DRIVER_SIGNALS;
    case 'none':
      return [];
    default:
      return undefined;
  }
}

/* -------------------------------------------------------------------------------------------------
 * stage 2 — code investigation
 * ---------------------------------------------------------------------------------------------- */

/** One ranked code-graph candidate. */
interface CandidateView {
  /** The candidate's project-relative POSIX path. */
  readonly file: string;
  /** The symbol the graph named, or the file's final component. */
  readonly symbol: string;
  /** The node kind the graph reported, or the empty string. */
  readonly kind: string;
  /**
   * The node kind the relevance frame words the candidate as: {@link kind},
   * or, for a candidate reported without one, the kind of the code-graph node
   * the query log returned for the same file and symbol. Wording only — the
   * score, the action types and the shortlist read {@link kind} alone.
   */
  readonly reasonKind: string;
  /** The relevance score, either reported or computed. */
  readonly score: number;
  /** What the candidate matched, for the relevance frame. */
  readonly relatedLabel: string;
  /** The candidate's action-type preference, from its kind. */
  readonly actionTypes: readonly ActionTypeId[];
}

/**
 * The code-node kind the understanding's entities give `symbol`, when one of
 * them names it with a kind {@link ENTITY_CODE_KINDS} maps.
 *
 * @param understanding The understanding the context carries.
 * @param symbol The candidate's symbol.
 * @returns The code-node kind, or `undefined`.
 */
function entityCodeKind(understanding: UnderstandingView, symbol: string): string | undefined {
  for (const record of understanding.entityRecords) {
    const kind =
      record.name === symbol && Object.hasOwn(ENTITY_CODE_KINDS, record.kind)
        ? ENTITY_CODE_KINDS[record.kind]
        : undefined;
    if (kind !== undefined) {
      return kind;
    }
  }
  return undefined;
}

/**
 * The investigation bag of a context, wherever the stage put it.
 *
 * @param root The structured context.
 * @returns The investigation bag, or `undefined`.
 */
function investigationBag(root: JsonObject): JsonObject | undefined {
  return readObjectField(root, 'investigation', 'codeInvestigation');
}

/**
 * Reads and scores the code-graph candidates of a context.
 *
 * ## Scoring
 *
 * A candidate the context already scored is taken at its own number — the
 * graph knows more about its own ranking than a field probe does — clamped to
 * non-negative and rounded. Everything else is scored from structure alone:
 *
 * - {@link SCORE_BASE} for every candidate whose path survived validation;
 * - {@link SCORE_SIGNAL_MATCH} per needed signal the candidate declares;
 * - {@link SCORE_ENTITY_MATCH} when its symbol or a stem of its file is one of
 *   the understanding's named entities;
 * - {@link SCORE_TARGET_CHAIN_MATCH} when its symbol appears in the selected
 *   target's component chain;
 * - {@link SCORE_KNOWN_KIND} when its declared kind is one the product has an
 *   instrumentation preference for.
 *
 * The sum is clamped to {@link SCORE_MAX}. A candidate whose path fails the
 * project-relative containment rule is dropped rather than scored: a malformed
 * path must not travel downstream into a source location.
 *
 * @param root The structured context.
 * @param understanding The understanding the context carried.
 * @returns The candidates, unordered — the caller sorts and caps.
 */
function readCandidates(
  root: JsonObject,
  understanding: UnderstandingView,
): readonly CandidateView[] {
  const nodes =
    readObjectArrayField(
      root,
      'candidates',
      'codeGraphCandidates',
      'graphCandidates',
      'relevantFiles',
      'results',
    ) ??
    readObjectArrayField(
      investigationBag(root),
      'candidates',
      'codeGraphCandidates',
      'relevantFiles',
      'results',
    ) ??
    [];

  const neededSignals = new Set(understanding.signals);
  const entityNames = new Set(understanding.entities);
  const chain = new Set(understanding.target?.chain ?? []);
  const traced = tracedPathMembers(root);
  const hopSites = tracedHopSites(root);
  const queried = queriedFromMembers(root);
  const loggedKinds = loggedNodeKinds(root);

  const candidates: CandidateView[] = [];
  for (const node of nodes) {
    const file = asProjectPath(readField(node, 'file', 'path', 'filePath'));
    if (file === undefined) {
      continue;
    }

    const stems = pathStems(file);
    const symbol = asString(readField(node, 'symbol', 'symbolName', 'name')) ?? stems[0] ?? file;
    const kind =
      asString(readField(node, 'kind', 'nodeKind', 'type')) ??
      entityCodeKind(understanding, symbol) ??
      '';
    const declaredSignals = canonicalSignals(
      readStringSet(node, 'signals', 'captureSignals', 'provides'),
    );

    const matchedSignals = declaredSignals.filter((signal) => neededSignals.has(signal));
    const matchedEntities = sortStrings([symbol, ...stems].filter((name) => entityNames.has(name)));
    const inChain = chain.has(symbol);
    const memberKey = pathMemberKey(file, symbol);
    const onTracedPath = traced.has(memberKey);
    const tracedFrom = traced.get(memberKey) ?? hopSites.get(memberKey);
    const queriedFrom = queried.get(memberKey);
    const knownKind = Object.hasOwn(CODE_KIND_ACTION_TYPES, kind);

    const reported = asFiniteNumber(readField(node, 'score', 'relevance', 'weight'));
    const computed =
      SCORE_BASE +
      matchedSignals.length * SCORE_SIGNAL_MATCH +
      (matchedEntities.length > 0 ? SCORE_ENTITY_MATCH : 0) +
      (inChain ? SCORE_TARGET_CHAIN_MATCH : 0) +
      (onTracedPath ? SCORE_TRACED_PATH_MATCH : 0) +
      (knownKind ? SCORE_KNOWN_KIND : 0);
    const score =
      reported === undefined
        ? roundValue(clampRange(computed, 0, SCORE_MAX), SCORE_DECIMALS)
        : roundValue(reported, SCORE_DECIMALS);

    // What the relevance frame names, most specific first: a named entity, a
    // needed then a declared signal, the far end of a traced path (or, for a
    // declaration a traced hop is written in, the node the hop leaves), then
    // the entity the query that returned the candidate looked up. Blank only
    // for a candidate none of them relates to anything else, which the frame
    // words without an entity.
    const relatedLabel =
      matchedEntities[0] ??
      (matchedSignals[0] !== undefined
        ? captureSignalLabel(matchedSignals[0])
        : declaredSignals[0] !== undefined
          ? captureSignalLabel(declaredSignals[0])
          : (tracedFrom ?? queriedFrom ?? ''));

    candidates.push({
      file,
      symbol,
      kind,
      reasonKind: kind === '' ? (loggedKinds.get(memberKey) ?? '') : kind,
      score,
      relatedLabel,
      actionTypes: (CODE_KIND_ACTION_TYPES[kind] ?? DEFAULT_CODE_KIND_ACTION_TYPES).filter(
        (type) => !TARGET_REQUIRED_TYPES.has(type) || isDeclarationSpelling(symbol),
      ),
    });
  }

  return candidates;
}

/**
 * Orders candidates by score, then by path, then by symbol.
 *
 * The secondary keys are what make the order total rather than merely usually
 * right: two candidates with equal scores must not be able to swap places
 * between runs, and a sort that is stable only with respect to its input order
 * inherits whatever order the producer happened to use.
 *
 * @param candidates The candidates to order.
 * @returns A new, ordered array.
 */
function sortCandidates(candidates: readonly CandidateView[]): CandidateView[] {
  return [...candidates].sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    const byFile = compareStrings(left.file, right.file);
    return byFile === 0 ? compareStrings(left.symbol, right.symbol) : byFile;
  });
}

/**
 * The flow paths a context reports, rendered as one line each.
 *
 * A path arrives as a list of step labels, a list of step objects, or an object
 * carrying either under a field of its own; all three are read, and a path with
 * no readable step is dropped rather than rendered as the renderer's
 * "no recorded path" placeholder.
 *
 * @param root The structured context.
 * @returns The rendered paths, distinct, ordered and capped.
 */
function readFlows(root: JsonObject): readonly string[] {
  const rendered = new Set<string>();
  for (const bag of [root, investigationBag(root)]) {
    if (bag === undefined) {
      continue;
    }
    for (const field of ['flows', 'flowPaths', 'paths', 'graphPaths']) {
      const list = asArray(bag[field]);
      if (list === undefined) {
        continue;
      }
      for (const member of list) {
        const steps = readFlowSteps(member);
        if (steps.length > 0) {
          rendered.add(flowPathLabel(steps));
        }
      }
    }
  }
  return sortStrings([...rendered]).slice(0, MAX_FLOWS);
}

/**
 * The step labels of one reported flow path.
 *
 * @param value A flow path in any of the three accepted forms.
 * @returns The step labels, bounded by {@link MAX_FLOW_STEPS}.
 */
function readFlowSteps(value: JsonValue | undefined): readonly string[] {
  const single = asString(value);
  if (single !== undefined) {
    return [single];
  }

  const list = asArray(value);
  if (list !== undefined) {
    const steps: string[] = [];
    for (const member of list.slice(0, MAX_FLOW_STEPS)) {
      const label =
        asString(member) ??
        asString(readField(asObject(member), 'label', 'symbol', 'name', 'file'));
      if (label !== undefined) {
        steps.push(label);
      }
    }
    return steps;
  }

  const object = asObject(value);
  if (object === undefined) {
    return [];
  }
  return readFlowSteps(readField(object, 'steps', 'nodes', 'path'));
}

/* -------------------------------------------------------------------------------------------------
 * stage 2 — follow-up queries: from the selected element to the route and the data layer
 *
 * The seed queries resolve the entities of the understanding; what they cannot
 * say is where a click *goes*. The walk below follows the code graph from what
 * the log already resolved — the "found the component, traced the event
 * handler, found the route, found the database dependency" walk the session's
 * progress view reports (docs/ARCHITECTURE.md, "Progress from real findings").
 *
 * The followed components are the selected element's owner chain, innermost
 * first, or, when the understanding names no component the log found, the
 * components the log's name lookups returned by exactly the name looked up.
 *
 * 1. **Handler-issued request.** When the question is one the developer's input
 *    reproduces ({@link CategoryProfile.inputDriven}: a latency, data or error
 *    question), the request that matters is the one the interaction issues, and
 *    an interaction issues its request from an event handler. So the event
 *    handlers of each followed component's module are traced first, along
 *    their calls to the API route a call site reaches, one component per turn,
 *    until one reaches a route: that component's handler issues the
 *    interaction's request, and the path found holds the handler. Tracing the
 *    component's own calls first would instead follow a request its body
 *    issues as it renders — one the interaction never sends — to that
 *    request's route, and leave the interaction's route unfound. When none
 *    reaches a route — or the question is not input-driven, where the request
 *    a component issues as it renders is the one asked about — the walk
 *    proceeds with steps 2 to 5 exactly as it would without this step.
 * 2. **Request trace.** The followed components are traced along their calls
 *    to the API route a call site reaches, one component per turn, until one
 *    reaches a route: that component is the one whose own code issues the
 *    request.
 * 3. **Handler trace.** When no followed component's calls reach a route, each
 *    is traced again through the event handlers it binds, one per turn, so a
 *    click handler that issues the request itself lies on the path found.
 * 4. **Data layer.** Each route a trace of steps 1 to 3 reached is traced on to
 *    its data-layer call.
 * 5. **Handler binding.** When no path found so far holds an event handler,
 *    the handler the element's nearest owner binds is looked up, one owner per
 *    turn, nearest first, until one binds a handler: owners nearer the element
 *    than the component that issues the request (the handler of a control
 *    that delegates to its form), or every followed component when none
 *    issues one. The owner that issues the
 *    request is never asked: its request leaves from its own code, and the
 *    first of the many handlers such a component binds would be an arbitrary
 *    claim rather than a traced one. After a handler-issued request (step 1)
 *    this step never runs: that path already holds the handler.
 * 6. **Resolved routes.** When no component was followed at all — a question
 *    asked without a selected element — the API routes the log resolved are
 *    followed both ways instead: downstream to their data-layer call, and
 *    upstream, against the direction of every edge, to the component whose
 *    code issues the request — through the event handler that issues it, when
 *    a handler does.
 *
 * Every step is derived from the structured context alone (the
 * understanding, the candidates the log holds, the requests already run),
 * never from the question's wording. A query already in the log is never
 * proposed again, at most {@link MAX_PATH_QUERIES} path queries are proposed,
 * and none once the executor has refused one for budget, so the conversation
 * converges on the final investigation within the stage's allowance.
 * ---------------------------------------------------------------------------------------------- */

/** The context field holding the executed query log, and the field a query batch answers in. */
const QUERY_RESULTS_FIELD = 'queryResults';
const QUERY_BATCH_FIELD = 'queries';

/** The graph query every follow-up uses, and the two lookups whose results the walk starts from. */
const PATH_BETWEEN_TOOL = 'pathBetween';
const FIND_BY_NAME_TOOL = 'findByName';
const ROUTE_FOR_URL_TOOL = 'routeForUrl';

/**
 * The other lookups of the code tools' vocabulary whose request names what
 * they looked up, which {@link queriedEntityLabel} relates their results to.
 */
const FIND_SYMBOL_TOOL = 'findSymbol';
const WHO_CALLS_TOOL = 'whoCalls';
const COMPONENTS_RENDERING_TOOL = 'componentsRendering';
const HANDLERS_FOR_TOOL = 'handlersFor';

/**
 * The key the service's context builder never descends into while it projects
 * candidates from the query log: the request a result echoes, whose names were
 * asked for rather than found (`QUERY_REQUEST_KEY` of
 * `apps/local-service/src/pipeline/context-builder.ts`).
 */
const QUERY_REQUEST_KEY = 'request';

/**
 * The deepest {@link queriedFromMembers} walks into one payload: the context
 * builder's own projection bound (`maxDepth` of its default limits), restated
 * for the layering reason given at {@link MAX_PATH_QUERIES}. The builder counts
 * from the log above the payload, so every code node its projection reaches
 * lies within this bound; a node deeper than that is no candidate and needs no
 * relation.
 */
const MAX_PAYLOAD_DEPTH = 16;

/** The code-graph node kinds the walk moves between. */
const COMPONENT_NODE_KIND = 'component';
const HANDLER_NODE_KIND = 'handler';
const API_ROUTE_NODE_KIND = 'api-route';
const DB_CALL_NODE_KIND = 'db-call';

/**
 * The route-map kind a `routeForUrl` result reports for a request-handler
 * module; a page module reports `'page'`. Mirrors `API_ROUTE_KINDS` of
 * `@debuggen/code-analysis`, restated for the layering reason given at
 * {@link CAPTURE_SIGNAL_NAMES}.
 */
const REQUEST_HANDLER_ROUTE_KIND = 'route-handler';

/**
 * The three traversal directions of a path query: downstream only (the
 * engine's default, what an absent `direction` means), upstream only — incoming
 * edges alone, so every hop is travelled against its edge's direction — and
 * undirected, which may follow an edge either way.
 */
const DOWNSTREAM_DIRECTION = 'out';
const UPSTREAM_DIRECTION = 'in';
const UNDIRECTED_DIRECTION = 'both';

/**
 * The edge kinds a component-to-route trace follows first: calls, and the join
 * from a call site to the route it reaches. Rendering, handler and declaration
 * edges are left out on purpose — a component renders many children and binds
 * many handlers, and following those spends the path search's node budget
 * before the call that leaves the page is expanded.
 */
const REQUEST_TRACE_EDGE_KINDS: readonly string[] = Object.freeze(['calls', 'routes-to']);

/**
 * The edge kinds of the handler trace, the second attempt for components whose
 * calls reach no route: the handler bindings too, so a path that leaves the
 * page from inside a click handler — rather than from the component's own
 * code — is found, with that handler on it.
 */
const HANDLER_TRACE_EDGE_KINDS: readonly string[] = Object.freeze([
  'handles',
  'calls',
  'routes-to',
]);

/** The one edge kind of a handler-binding lookup: a component to the event handler it binds. */
const HANDLER_BINDING_EDGE_KINDS: readonly string[] = Object.freeze(['handles']);

/**
 * The edge kinds of a caller trace, from an API route back to the component
 * whose code issues its request: the call-site join, calls and handler
 * bindings, all followed against their direction.
 */
const CALLER_TRACE_EDGE_KINDS: readonly string[] = Object.freeze(['routes-to', 'calls', 'handles']);

/** Components a walk follows, innermost first. */
const MAX_TRACED_COMPONENTS = 4;

/** Routes reached by a component trace that are traced on to the data layer. */
const MAX_TRACED_ROUTES = 2;

/** API routes the log resolved that a walk following no component traces both ways. */
const MAX_RESOLVED_ROUTES = 3;

/**
 * The most path queries one walk proposes in a stage: the code tools'
 * allowance for a single tool (`CODE_TOOL_LIMITS.maxCallsPerTool` in
 * `apps/local-service/src/pipeline/tools/code-tools.ts`), restated because this
 * package sits below the service that defines it. A tighter allowance is
 * honoured as well: the walk proposes nothing more once the executor has
 * refused a path query with {@link BUDGET_REFUSAL_CODE}.
 */
const MAX_PATH_QUERIES = 6;

/** The code a query refused because its budget is spent carries (`CODE_TOOL_REJECTION_CODES.budget`). */
const BUDGET_REFUSAL_CODE = 'RATE_LIMITED';

/**
 * The components a follow-up traces, in the understanding's order.
 *
 * The selected element's owner chain, innermost first, when the context itself
 * carries the target (the understand stage's does). The investigate stage's
 * context carries the validated understanding instead of the target, and there
 * the chain survives as the understanding's `component` entities, which the
 * understand rules list first and innermost first; those are read in their
 * carried order.
 *
 * @param understanding The understanding the context carries.
 * @returns The component names, de-duplicated; empty when none is named.
 */
function tracedComponentNames(understanding: UnderstandingView): readonly string[] {
  const chain = understanding.target?.chain ?? [];
  if (chain.length > 0) {
    return chain;
  }
  const names: string[] = [];
  for (const record of understanding.entityRecords) {
    if (record.kind === COMPONENT_NODE_KIND && !names.includes(record.name)) {
      names.push(record.name);
    }
  }
  return names;
}

/** The identity of a code node on a traced path, as {@link tracedPathMembers} keys it. */
function pathMemberKey(file: string, symbol: string): string {
  return `${file}\u0000${symbol}`;
}

/**
 * Every code node on a path an executed `pathBetween` query found, mapped to
 * the name of the node at the path's other end — what the member was traced
 * against.
 *
 * Each path is read downstream ({@link executedPaths}). A member after the
 * first is mapped to the path's first node, the one it was traced from; the
 * first node itself is mapped to the path's last, the one it was traced to —
 * mapping it to its own name would relate it to itself. A name equal to the
 * member's own symbol or file relates it to nothing either (a one-node path, or
 * a path ending at a namesake), so such a member is kept without a relation:
 * it still lies on a traced path, which is what {@link readCandidates} scores,
 * and the relevance frame then takes its next source. The first path that
 * relates a member names it.
 *
 * @param root The structured context.
 * @returns The members, each with its relation or `undefined`; empty when the
 * context ran no path query.
 */
function tracedPathMembers(root: JsonObject): ReadonlyMap<string, string | undefined> {
  const members = new Map<string, string | undefined>();
  for (const path of executedPaths(root)) {
    const nodes = asObjectArray(asObject(path)?.nodes) ?? [];
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const origin = asString(first?.name) ?? asString(first?.symbol);
    if (origin === undefined) {
      continue;
    }
    const end = asString(last?.name) ?? asString(last?.symbol);
    for (const [position, node] of nodes.entries()) {
      const file = asProjectPath(node.file);
      const symbol = asString(node.symbol) ?? asString(node.name);
      if (file === undefined || symbol === undefined) {
        continue;
      }
      const counterpart = position === 0 ? end : origin;
      const related =
        counterpart === undefined || counterpart === symbol || counterpart === file
          ? undefined
          : counterpart;
      const key = pathMemberKey(file, symbol);
      if (!members.has(key) || (members.get(key) === undefined && related !== undefined)) {
        members.set(key, related);
      }
    }
  }
  return members;
}

/**
 * The declaration each hop of a traced flow is written in, mapped to the name
 * of the node the hop leaves — what that declaration was traced through.
 *
 * A hop's `location` is the site of its relationship, and the site belongs to
 * the relationship's own `from` node, whichever way the search travelled it: a
 * route's call into a service function is written inside the route module's
 * method handler, so that handler is related to the route although it is no
 * node of the path. Only paths {@link orientedPath} reads as flows are used,
 * as for {@link tracedPathMembers}, and a site naming its own hop's node
 * relates it to nothing. The first flow that relates a site names it. Unlike a
 * path member, a hop site earns no score: it is how a candidate is worded, not
 * whether it was traced.
 *
 * @param root The structured context.
 * @returns The sites, keyed as {@link pathMemberKey} keys them; empty when no
 * executed path query found a flow.
 */
function tracedHopSites(root: JsonObject): ReadonlyMap<string, string> {
  const sites = new Map<string, string>();
  for (const run of readExecutedRuns(root)) {
    if (pathQueryIdentity(run.request) === undefined || orientedPath(run.payload) === undefined) {
      continue;
    }
    const path = asObject(run.payload);
    const names = new Map<string, string>();
    for (const node of asObjectArray(path?.nodes) ?? []) {
      const id = asString(node.nodeId);
      const name = asString(node.name) ?? asString(node.symbol);
      if (id !== undefined && name !== undefined && !names.has(id)) {
        names.set(id, name);
      }
    }
    for (const hop of asObjectArray(path?.edges) ?? []) {
      const location = asObject(hop.location);
      const file = asProjectPath(location?.file);
      const symbol = asString(location?.symbol);
      const from = asString(hop.from);
      const owner = from === undefined ? undefined : names.get(from);
      if (
        file === undefined ||
        symbol === undefined ||
        owner === undefined ||
        owner === symbol ||
        owner === file
      ) {
        continue;
      }
      const key = pathMemberKey(file, symbol);
      if (!sites.has(key)) {
        sites.set(key, owner);
      }
    }
  }
  return sites;
}

/** One query of the log: its request, and the payload of a successful run or the code of a refused one. */
interface ExecutedRun {
  readonly request: JsonObject | undefined;
  readonly payload: JsonValue | undefined;
  /** The error code the parser or the executor refused the query with; absent for a successful run. */
  readonly refusal: string | undefined;
}

/**
 * The queries of an investigate-stage context, executed or refused, in log
 * order.
 *
 * @param root The structured context.
 * @returns The runs; empty when the context carries no log.
 */
function readExecutedRuns(root: JsonObject): readonly ExecutedRun[] {
  const runs: ExecutedRun[] = [];
  for (const run of asObjectArray(root[QUERY_RESULTS_FIELD]) ?? []) {
    const outcome = asObject(run.outcome);
    const succeeded = outcome?.ok === true;
    const value = succeeded ? asObject(outcome.value) : undefined;
    runs.push({
      request: asObject(run.request),
      payload: value?.payload,
      refusal: succeeded ? undefined : asString(asObject(outcome?.error)?.code),
    });
  }
  return runs;
}

/**
 * The entity one successful query looked up, as the relevance frame names it:
 * the name, symbol or component its request asked about, or, for a URL lookup,
 * the route path the route map resolved — the URL as asked when it resolved
 * none. A path query relates its nodes to one another, which
 * {@link tracedPathMembers} reads, and an excerpt looks nothing up, so neither
 * names an entity here; nor does a tool outside the code tools' vocabulary.
 *
 * @param run A run of the log.
 * @returns The label, or `undefined` when the run names no entity.
 */
function queriedEntityLabel(run: ExecutedRun): string | undefined {
  const request = run.request;
  switch (asString(request?.tool)) {
    case FIND_BY_NAME_TOOL:
      return asString(request?.name);
    case FIND_SYMBOL_TOOL:
      return asString(request?.symbol) ?? asString(request?.name);
    case WHO_CALLS_TOOL:
      return asString(request?.symbol);
    case COMPONENTS_RENDERING_TOOL:
      return asString(request?.component);
    case ROUTE_FOR_URL_TOOL:
      return asString(asObject(run.payload)?.routePath) ?? asString(request?.url);
    case HANDLERS_FOR_TOOL:
      return asString(request?.url);
    default:
      return undefined;
  }
}

/**
 * Calls `visit` for every code node `value` holds, walking nested lists and
 * objects the way the service's context builder projects the candidates of an
 * investigate turn (`candidatesFrom` in
 * `apps/local-service/src/pipeline/context-builder.ts`): every object with a
 * project-relative `file` and a `symbol`, or failing that a `name`, is a code
 * node — nested ones too, such as the `location` a URL lookup's route carries,
 * the `caller` of a call site or the `location` of a path's hop — no
 * {@link QUERY_REQUEST_KEY} is entered, and the walk stops at
 * {@link MAX_PAYLOAD_DEPTH}.
 *
 * @param value A payload, or a value nested in one.
 * @param depth How deep `value` sits in its payload.
 * @param visit Receives each code node with its normalised file and symbol.
 */
function forEachPayloadNode(
  value: JsonValue | undefined,
  depth: number,
  visit: (node: JsonObject, file: string, symbol: string) => void,
): void {
  if (depth > MAX_PAYLOAD_DEPTH) {
    return;
  }
  const list = asArray(value);
  if (list !== undefined) {
    for (const item of list) {
      forEachPayloadNode(item, depth + 1, visit);
    }
    return;
  }
  const node = asObject(value);
  if (node === undefined) {
    return;
  }
  const file = asProjectPath(node.file);
  const symbol = asString(node.symbol) ?? asString(node.name);
  if (file !== undefined && symbol !== undefined) {
    visit(node, file, symbol);
  }
  for (const [key, entry] of Object.entries(node)) {
    if (key !== QUERY_REQUEST_KEY) {
      forEachPayloadNode(entry, depth + 1, visit);
    }
  }
}

/**
 * Every code node an executed query returned, mapped to the entity the first
 * query that returned it looked up ({@link queriedEntityLabel}) — the one
 * relation a candidate that only a query result produced has.
 *
 * Payloads are walked by {@link forEachPayloadNode}, runs in log order, and
 * refused runs are skipped. A label equal to the node's own symbol or file
 * relates it to nothing (a route node found by its own route path), so the node
 * is left for a later query to name.
 *
 * @param root The structured context.
 * @returns The relations; empty when the context carries no query log.
 */
function queriedFromMembers(root: JsonObject): ReadonlyMap<string, string> {
  const members = new Map<string, string>();
  for (const run of readExecutedRuns(root)) {
    const label = run.payload === undefined ? undefined : queriedEntityLabel(run);
    if (label === undefined) {
      continue;
    }
    forEachPayloadNode(run.payload, 0, (_node, file, symbol) => {
      const key = pathMemberKey(file, symbol);
      if (label !== symbol && label !== file && !members.has(key)) {
        members.set(key, label);
      }
    });
  }
  return members;
}

/**
 * The kind of every code-graph node the executed queries returned, by file
 * and symbol: what words a candidate the context supplied without a kind.
 *
 * The context builder keeps the first object it meets for a file and symbol,
 * and a path's hop `location` — which names the declaration holding the hop's
 * site but carries no kind — can be met before the path's own node for that
 * declaration, so a traced handler or component can arrive kind-less although
 * the log holds its node. Only an object with a kind of its own is read here
 * (a graph node, never a location); runs are read in log order, refused runs
 * are skipped, and the first kind found for a file and symbol wins.
 *
 * @param root The structured context.
 * @returns The kinds; empty when the context carries no query log.
 */
function loggedNodeKinds(root: JsonObject): ReadonlyMap<string, string> {
  const kinds = new Map<string, string>();
  for (const run of readExecutedRuns(root)) {
    forEachPayloadNode(run.payload, 0, (node, file, symbol) => {
      const kind = asString(node.kind);
      const key = pathMemberKey(file, symbol);
      if (kind !== undefined && !kinds.has(key)) {
        kinds.set(key, kind);
      }
    });
  }
  return kinds;
}

/**
 * The identity of a path query: its tool, both endpoints' selector fields, its
 * edge filter and its direction — {@link UPSTREAM_DIRECTION} or
 * {@link UNDIRECTED_DIRECTION} as written, and downstream for anything else,
 * absence included, as the engine reads it. Two requests with the same identity
 * ask the same question.
 *
 * @param request A query request.
 * @returns The identity, or `undefined` for a query that is not a path query.
 */
function pathQueryIdentity(request: JsonObject | undefined): string | undefined {
  if (request === undefined || asString(request.tool) !== PATH_BETWEEN_TOOL) {
    return undefined;
  }
  const endpoint = (value: JsonValue | undefined): string => {
    const text = asString(value);
    if (text !== undefined) {
      return text;
    }
    const selector = asObject(value);
    return ['file', 'symbol', 'name', 'kind']
      .map((field) => asString(selector?.[field]) ?? '')
      .join('|');
  };
  const direction = asString(request.direction);
  return [
    endpoint(request.from),
    endpoint(request.to),
    sortStrings([...asStringArray(request.edgeKinds)]).join(','),
    direction === UPSTREAM_DIRECTION || direction === UNDIRECTED_DIRECTION
      ? direction
      : DOWNSTREAM_DIRECTION,
  ].join('>');
}

/**
 * The last node of an executed path, when the run found one.
 *
 * @param payload The run's payload.
 * @returns The path's final node, or `undefined`.
 */
function pathEndOf(payload: JsonValue | undefined): JsonObject | undefined {
  const nodes = asArray(asObject(payload)?.nodes);
  return nodes === undefined ? undefined : asObject(nodes[nodes.length - 1]);
}

/**
 * The file of the API route a downstream trace reached: the last node of its
 * path, when that node is an `api-route`.
 *
 * @param run The trace's run.
 * @returns The route's project-relative file, or `undefined` when the trace
 * found no path or its path ends elsewhere.
 */
function reachedRouteFile(run: ExecutedRun): string | undefined {
  const end = pathEndOf(run.payload);
  return asString(end?.kind) === API_ROUTE_NODE_KIND ? asProjectPath(end?.file) : undefined;
}

/**
 * Whether a path holds an event handler: one of its nodes is a `handler`.
 *
 * @param path A path payload.
 * @returns `true` when the path passes through a handler binding.
 */
function holdsHandler(path: JsonValue | undefined): boolean {
  return (asObjectArray(asObject(path)?.nodes) ?? []).some(
    (node) => asString(node.kind) === HANDLER_NODE_KIND,
  );
}

/**
 * The components the log's name lookups returned under exactly the name they
 * looked up, in log order — what a walk follows when the understanding names
 * no component the log found. A lookup's near matches are left out: they
 * resemble the name asked for, and following them would trace a component the
 * understanding never pointed at.
 *
 * @param runs The log's runs.
 * @returns The component names, de-duplicated.
 */
function componentsFoundByName(runs: readonly ExecutedRun[]): string[] {
  const names: string[] = [];
  for (const run of runs) {
    const looked = asString(run.request?.name);
    if (asString(run.request?.tool) !== FIND_BY_NAME_TOOL || looked === undefined) {
      continue;
    }
    for (const node of asObjectArray(run.payload) ?? []) {
      if (
        asString(node.kind) === COMPONENT_NODE_KIND &&
        asString(node.name) === looked &&
        !names.includes(looked)
      ) {
        names.push(looked);
      }
    }
  }
  return names;
}

/**
 * The request-handler routes the log's URL lookups resolved, by module file,
 * in log order. A page route is left out: a page is where a request starts,
 * not the handler that serves it.
 *
 * @param runs The log's runs.
 * @returns The route files, de-duplicated.
 */
function resolvedRouteFiles(runs: readonly ExecutedRun[]): string[] {
  const files: string[] = [];
  for (const run of runs) {
    if (asString(run.request?.tool) !== ROUTE_FOR_URL_TOOL) {
      continue;
    }
    const route = asObject(run.payload);
    const file = asProjectPath(route?.file);
    if (
      asString(route?.kind) === REQUEST_HANDLER_ROUTE_KIND &&
      file !== undefined &&
      !files.includes(file)
    ) {
      files.push(file);
    }
  }
  return files;
}

/**
 * A component-to-route trace along `edgeKinds`.
 *
 * @param component The component's name.
 * @param edgeKinds {@link REQUEST_TRACE_EDGE_KINDS} or {@link HANDLER_TRACE_EDGE_KINDS}.
 * @returns The path query.
 */
function requestTrace(component: string, edgeKinds: readonly string[]): JsonObject {
  return {
    tool: PATH_BETWEEN_TOOL,
    from: { name: component, kind: COMPONENT_NODE_KIND },
    to: { kind: API_ROUTE_NODE_KIND },
    edgeKinds: [...edgeKinds],
  };
}

/**
 * The lookup of the event handler a component binds.
 *
 * @param component The component's name.
 * @returns The path query.
 */
function handlerBinding(component: string): JsonObject {
  return {
    tool: PATH_BETWEEN_TOOL,
    from: { name: component, kind: COMPONENT_NODE_KIND },
    to: { kind: HANDLER_NODE_KIND },
    edgeKinds: [...HANDLER_BINDING_EDGE_KINDS],
  };
}

/**
 * The trace from an API route downstream to its data-layer call, along every
 * edge kind.
 *
 * @param file The route's module file.
 * @returns The path query.
 */
function dataLayerTrace(file: string): JsonObject {
  return {
    tool: PATH_BETWEEN_TOOL,
    from: { file, kind: API_ROUTE_NODE_KIND },
    to: { kind: DB_CALL_NODE_KIND },
  };
}

/**
 * The trace from an API route back to the component whose code issues its
 * request: upstream along {@link CALLER_TRACE_EDGE_KINDS}, so every hop follows
 * an edge into the node the walk stands on — the call site that reaches the
 * route, the function that makes the call, the event handler that calls it,
 * the component that binds the handler — and never out of it. The path it
 * finds lists the route first and is read downstream by {@link orientedPath}.
 *
 * Upstream rather than undirected on purpose: an undirected search from a route
 * expands the route's own downstream calls — services, helpers, data-layer
 * calls — before it reaches the callers, and exhausts the engine's node budget
 * there, whereas the upstream search expands only what leads to the route.
 *
 * @param file The route's module file.
 * @returns The path query.
 */
function callerTrace(file: string): JsonObject {
  return {
    tool: PATH_BETWEEN_TOOL,
    from: { file, kind: API_ROUTE_NODE_KIND },
    to: { kind: COMPONENT_NODE_KIND },
    edgeKinds: [...CALLER_TRACE_EDGE_KINDS],
    direction: UPSTREAM_DIRECTION,
  };
}

/**
 * The trace from the event handlers a component's module binds to the API
 * route a call site reaches, along {@link REQUEST_TRACE_EDGE_KINDS}: what finds
 * the request a control's interaction issues — the handler calls the function
 * that makes the request — rather than one the component's body issues while
 * it renders.
 *
 * The source is every `handler` node of the component's file, which is how the
 * code graph places the handlers a component binds; a handler is a binding
 * site, not a declaration a name selector could address.
 *
 * @param file The component's module file.
 * @returns The path query.
 */
function handlerRequestTrace(file: string): JsonObject {
  return {
    tool: PATH_BETWEEN_TOOL,
    from: { file, kind: HANDLER_NODE_KIND },
    to: { kind: API_ROUTE_NODE_KIND },
    edgeKinds: [...REQUEST_TRACE_EDGE_KINDS],
  };
}

/**
 * The follow-up queries the log still lacks, or none once the walk is done.
 *
 * The six steps of the walk described above this section, each proposed only
 * once the step before it has run: for a question reproduced by input, the
 * followed components' handler-issued requests; then, unless one of those
 * reached a route, request traces and handler traces; then data-layer traces
 * for the routes they reached; then the handler binding of the element's
 * nearest owner; then — when no component was followed — the resolved routes
 * both ways. Nothing is proposed without remaining budget, past
 * {@link MAX_PATH_QUERIES} path queries, after a path query was refused for
 * budget, or when every step already ran.
 *
 * @param root The structured context.
 * @param understanding The understanding the context carries.
 * @returns The queries to run next, possibly empty.
 */
function followUpQueries(root: JsonObject, understanding: UnderstandingView): JsonValue[] {
  const remaining = asFiniteNumber(root.remainingQueries);
  if (remaining === undefined || remaining < 1) {
    return [];
  }
  const runs = readExecutedRuns(root);
  const pathRuns = runs.filter((run) => pathQueryIdentity(run.request) !== undefined);
  if (pathRuns.some((run) => run.refusal === BUDGET_REFUSAL_CODE)) {
    return [];
  }
  const budget = Math.min(Math.floor(remaining), MAX_PATH_QUERIES - pathRuns.length);
  if (budget < 1) {
    return [];
  }

  // Every path query the log holds, by identity, with the first run that answered it.
  const answered = new Map<string, ExecutedRun>();
  for (const run of pathRuns) {
    const identity = pathQueryIdentity(run.request);
    if (identity !== undefined && !answered.has(identity)) {
      answered.set(identity, run);
    }
  }
  const runOf = (query: JsonObject): ExecutedRun | undefined => {
    const identity = pathQueryIdentity(query);
    return identity === undefined ? undefined : answered.get(identity);
  };
  const pending = (queries: readonly JsonObject[]): JsonValue[] =>
    queries.filter((query) => runOf(query) === undefined).slice(0, budget);

  // The followed components, innermost first: the owner chain the log found,
  // or the components the log's lookups returned by exactly the name asked for.
  // Each is kept with the file of its first candidate, where its handlers sit.
  const found = new Map<string, string>();
  for (const candidate of readCandidates(root, understanding)) {
    if (candidate.kind === COMPONENT_NODE_KIND && !found.has(candidate.symbol)) {
      found.set(candidate.symbol, candidate.file);
    }
  }
  const chain = tracedComponentNames(understanding).filter((component) => found.has(component));
  const components = (chain.length > 0 ? chain : componentsFoundByName(runs)).slice(
    0,
    MAX_TRACED_COMPONENTS,
  );

  // Step 1 — for a question reproduced by input, the request each followed
  // component's event handlers issue: one component file per turn, innermost
  // first, until one reaches a route.
  const handlerFiles =
    categoryProfile(understanding.category)?.inputDriven === true
      ? components.flatMap((component) => {
          const file = found.get(component);
          return file === undefined ? [] : [file];
        })
      : [];
  const handlerRequests = [...new Set(handlerFiles)].map(handlerRequestTrace);
  let handlerIssued = false;
  for (const query of handlerRequests) {
    const run = runOf(query);
    if (run === undefined) {
      return pending([query]);
    }
    if (reachedRouteFile(run) !== undefined) {
      handlerIssued = true;
      break;
    }
  }

  // Step 2 — request traces, one component per turn, until one reaches a route;
  // skipped once a handler issued the interaction's request.
  const requestTraces = handlerIssued
    ? []
    : components.map((component) => requestTrace(component, REQUEST_TRACE_EDGE_KINDS));
  let issuer = -1;
  for (const [index, query] of requestTraces.entries()) {
    const run = runOf(query);
    if (run === undefined) {
      return pending([query]);
    }
    if (reachedRouteFile(run) !== undefined) {
      issuer = index;
      break;
    }
  }

  // Step 3 — handler traces, only when no trace so far reached a route.
  const handlerTraces =
    !handlerIssued && issuer === -1
      ? components.map((component) => requestTrace(component, HANDLER_TRACE_EDGE_KINDS))
      : [];
  for (const query of handlerTraces) {
    const run = runOf(query);
    if (run === undefined) {
      return pending([query]);
    }
    if (reachedRouteFile(run) !== undefined) {
      break;
    }
  }

  // Step 4 — each route a trace reached, on to its data-layer call.
  const routeFiles: string[] = [];
  for (const query of [...handlerRequests, ...requestTraces, ...handlerTraces]) {
    const run = runOf(query);
    const file = run === undefined ? undefined : reachedRouteFile(run);
    if (file !== undefined && !routeFiles.includes(file)) {
      routeFiles.push(file);
    }
  }
  const dataLayer = pending(routeFiles.slice(0, MAX_TRACED_ROUTES).map(dataLayerTrace));
  if (dataLayer.length > 0) {
    return dataLayer;
  }

  // Step 5 — the handler the element's nearest owner binds, when no path holds
  // one yet: one owner per turn, nearest first, until one binds a handler. A
  // handler-issued request's path starts at its handler, so it never runs then.
  if (!handlerIssued && !executedPaths(root).some(holdsHandler)) {
    const owners = issuer === -1 ? components : components.slice(0, issuer);
    for (const owner of owners) {
      const query = handlerBinding(owner);
      const run = runOf(query);
      if (run === undefined) {
        return pending([query]);
      }
      if (holdsHandler(run.payload)) {
        break;
      }
    }
  }

  // Step 6 — without a followed component, the routes the log resolved, both ways.
  if (components.length > 0) {
    return [];
  }
  return pending(
    resolvedRouteFiles(runs)
      .slice(0, MAX_RESOLVED_ROUTES)
      .flatMap((file) => [dataLayerTrace(file), callerTrace(file)]),
  );
}

/**
 * An executed path as a flow: its nodes in the order the code runs them, or
 * `undefined` when the path is no flow.
 *
 * Decided by the hops the path reports, whichever direction its search took:
 *
 * - a path none of whose hops was travelled against its edge's direction — any
 *   downstream path, or an undirected one that happened to go with every edge —
 *   is a flow already and is returned as it is;
 * - a path every hop of which was travelled against its edge's direction — an
 *   upstream caller trace, found from a route back to the component whose code
 *   issues its request, or an undirected search that went the same way — is
 *   the flow read backwards, and is reversed so it reads from the component
 *   down to the route;
 * - a path that mixes the two relates its endpoints without either reaching the
 *   other through it (two functions joined through a helper both call), so
 *   rendering it as a chain of calls would assert a flow the code does not
 *   contain.
 *
 * @param payload The run's payload.
 * @returns The path, reoriented where needed, or `undefined`.
 */
function orientedPath(payload: JsonValue | undefined): JsonObject | undefined {
  const path = asObject(payload);
  const nodes = asArray(path?.nodes);
  if (path === undefined || nodes === undefined || nodes.length === 0) {
    return undefined;
  }
  const reversedHops = (asArray(path.edges) ?? []).map(
    (hop) => asBoolean(asObject(hop)?.traversedAgainstDirection) === true,
  );
  if (reversedHops.every((reversed) => !reversed)) {
    return path;
  }
  return reversedHops.every((reversed) => reversed)
    ? { nodes: [...nodes].reverse(), undirected: false }
    : undefined;
}

/**
 * The flows the executed path queries found, as graph paths `readFlows` renders:
 * each read downstream by {@link orientedPath}, and a path that is no flow left
 * out.
 *
 * @param root The structured context.
 * @returns One path per run that found a flow, in log order.
 */
function executedPaths(root: JsonObject): JsonValue[] {
  const paths: JsonValue[] = [];
  for (const run of readExecutedRuns(root)) {
    const flow =
      pathQueryIdentity(run.request) === undefined ? undefined : orientedPath(run.payload);
    if (flow !== undefined) {
      paths.push(flow);
    }
  }
  return paths;
}

/**
 * The graph node kinds that stand for a call expression rather than a
 * declaration: a request a component or a server function issues, and a
 * data-layer operation. Their name is the callee as written (`fetch`,
 * `pool.query`), which no editor jump or patch can address as a symbol.
 */
const CALL_SITE_NODE_KINDS: ReadonlySet<string> = new Set(['api-call', 'db-call']);

/**
 * The investigation's shortlist: the ranked candidates, capped at
 * {@link MAX_RELEVANT_FILES}, each entry adding a location the others do not.
 *
 * - A call site stands for its file: it is listed as a file-level entry (its
 *   symbol is the file itself), because the call expression is no symbol a
 *   relevant file can carry, while the file holding it is what the progress
 *   view's database and route findings read.
 * - A file-level entry is left out once the shortlist already names its file:
 *   it adds no location, and the slot goes to a declaration further down.
 * - A declaration of a file the shortlist names only by a file-level entry
 *   takes that entry's place — even once the shortlist is full — so the file
 *   stays listed, now with the declaration that locates it.
 * - An entry repeating the file and symbol of one already listed is left out.
 *
 * @param candidates The candidates, ranked by {@link sortCandidates}.
 * @returns The shortlist, ranked the same way.
 */
function shortlistCandidates(candidates: readonly CandidateView[]): CandidateView[] {
  const listed: CandidateView[] = [];
  const keys = new Set<string>();
  // Per listed file, the position of its file-level entry while it has no other.
  const fileLevel = new Map<string, number>();
  const files = new Set<string>();
  for (const ranked of candidates) {
    const candidate = CALL_SITE_NODE_KINDS.has(ranked.kind)
      ? { ...ranked, symbol: ranked.file }
      : ranked;
    const key = pathMemberKey(candidate.file, candidate.symbol);
    if (keys.has(key)) {
      continue;
    }
    if (candidate.symbol === candidate.file) {
      if (files.has(candidate.file) || listed.length >= MAX_RELEVANT_FILES) {
        continue;
      }
      fileLevel.set(candidate.file, listed.length);
    } else {
      const replaced = fileLevel.get(candidate.file);
      if (replaced !== undefined) {
        const previous = listed[replaced];
        if (previous !== undefined) {
          keys.delete(pathMemberKey(previous.file, previous.symbol));
        }
        fileLevel.delete(candidate.file);
        listed[replaced] = candidate;
        keys.add(key);
        continue;
      }
      if (listed.length >= MAX_RELEVANT_FILES) {
        continue;
      }
    }
    keys.add(key);
    files.add(candidate.file);
    listed.push(candidate);
  }
  return sortCandidates(listed);
}

/**
 * Builds the code investigation of a request from its structured context.
 *
 * Ranks the candidates the context supplies (see {@link readCandidates} for the
 * scoring), shortlists them (see {@link shortlistCandidates}), names each
 * one's relevance with the code-relevance frame, and renders whatever graph
 * paths the context reported. Every path is normalised to a project-relative
 * POSIX path, and a candidate whose path fails that check is dropped.
 *
 * @param input The structured context of an investigate-stage request.
 * @returns The investigation as plain JSON, or `undefined` when the context
 * supplies neither a candidate nor a path.
 */
export function buildInvestigation(input: JsonValue | undefined): JsonValue | undefined {
  const root = asObject(input);
  if (root === undefined) {
    return undefined;
  }

  const understanding = readUnderstanding(root);
  const followUps = followUpQueries(root, understanding);
  if (followUps.length > 0) {
    return { [QUERY_BATCH_FIELD]: followUps };
  }
  const candidates = shortlistCandidates(sortCandidates(readCandidates(root, understanding)));
  const paths = executedPaths(root);
  const flows = readFlows(paths.length > 0 ? { ...root, paths } : root);

  if (candidates.length === 0 && flows.length === 0) {
    return undefined;
  }

  const relevantFiles: JsonValue[] = candidates.map((candidate) => ({
    file: candidate.file,
    symbol: candidate.symbol,
    reason: codeRelevanceReason(codeSymbolKindLabel(candidate.reasonKind), candidate.relatedLabel),
    score: candidate.score,
  }));

  return { relevantFiles, flows: [...flows] };
}

/* -------------------------------------------------------------------------------------------------
 * stage 3 — instrumentation planning
 * ---------------------------------------------------------------------------------------------- */

/** What the adapter capability catalog of a context reports. */
interface AdapterCatalogView {
  /** Action types the catalog claims, restricted to the eight known ones. */
  readonly claimed: ReadonlySet<ActionTypeId>;
  /** Signals the catalog reports as collectable. */
  readonly signals: ReadonlySet<string>;
  /** The mode each claimed action type is installed in, where declared. */
  readonly modes: ReadonlyMap<ActionTypeId, string>;
}

/**
 * Reads the adapter capability catalog of a context.
 *
 * Three carriers are accepted, because the planning stage is free to send any
 * of them: a list of adapter entries, a map from adapter identifier to entry,
 * and a flat object that names the capabilities directly. Every claimed action
 * type is intersected with {@link INSTRUMENTATION_ACTION_TYPES}, so a name this
 * module does not know is reported by nobody and claimed by nothing.
 *
 * **A context that declares no action types at all leaves every one of the
 * eight claimable.** That is the tolerant reading, and it is the right one: an
 * absent catalog means the stage did not send one, not that no adapter exists,
 * and refusing to plan anything in that case would turn a missing field into a
 * plan with no targets. A context that *does* declare a catalog is honoured
 * strictly — an action type it omits is never emitted, because the plan
 * normaliser rejects an action no adapter claims.
 *
 * @param root The structured context.
 * @returns The catalog view.
 */
function readAdapterCatalog(root: JsonObject): AdapterCatalogView {
  const declaredTypes = new Set<string>();
  const declaredSignals = new Set<string>();
  const modes = new Map<ActionTypeId, string>();

  const entries: JsonObject[] = [];
  for (const field of ['adapterCatalog', 'adapters', 'adapterCapabilities', 'capabilities']) {
    const list = asObjectArray(root[field]);
    if (list !== undefined) {
      entries.push(...list);
      continue;
    }
    const bag = asObject(root[field]);
    if (bag === undefined) {
      continue;
    }
    entries.push(bag);
    for (const key of sortedKeys(bag)) {
      const nested = asObject(bag[key]);
      if (nested !== undefined) {
        entries.push(nested);
      }
    }
  }
  entries.push(root);

  for (const entry of entries) {
    const types = readStringSet(entry, 'actionTypes', 'types', 'supports', 'actions', 'actionType');
    const mode = asString(entry.mode);
    for (const type of types) {
      declaredTypes.add(type);
      for (const known of INSTRUMENTATION_ACTION_TYPES) {
        if (known === type && mode !== undefined && !modes.has(known)) {
          modes.set(known, mode);
        }
      }
    }
    for (const signal of canonicalSignals(
      readStringSet(entry, 'signals', 'availableSignals', 'captureSignals', 'provides'),
    )) {
      declaredSignals.add(signal);
    }
  }

  const claimed = new Set<ActionTypeId>();
  for (const known of INSTRUMENTATION_ACTION_TYPES) {
    if (declaredTypes.size === 0 || declaredTypes.has(known)) {
      claimed.add(known);
    }
  }

  return { claimed, signals: declaredSignals, modes };
}

/**
 * Whether an action type is installed as a runtime hook in this context.
 *
 * The catalog's own declaration wins where it has one; otherwise the product's
 * default split applies (see {@link RUNTIME_ACTION_TYPES}).
 *
 * @param type An action type.
 * @param catalog The catalog view.
 * @returns `true` when the type is a runtime hook.
 */
function isRuntimeActionType(type: ActionTypeId, catalog: AdapterCatalogView): boolean {
  const declared = catalog.modes.get(type);
  if (declared !== undefined) {
    return declared === 'runtime';
  }
  return RUNTIME_ACTION_TYPES.includes(type);
}

/**
 * Chooses the action type to install from a preference list.
 *
 * Runtime hooks first: a need that a runtime hook and a rewrite could both
 * satisfy is satisfied by the hook, because a hook modifies no file and a
 * rewrite has to be recorded, applied and reverted. A type the catalog does not
 * claim is skipped entirely.
 *
 * @param preference Candidate action types, most appropriate first.
 * @param catalog The catalog view.
 * @returns The chosen type, or `undefined` when the catalog claims none of
 * them.
 */
function chooseActionType(
  preference: readonly ActionTypeId[],
  catalog: AdapterCatalogView,
): ActionTypeId | undefined {
  for (const type of preference) {
    if (catalog.claimed.has(type) && isRuntimeActionType(type, catalog)) {
      return type;
    }
  }
  for (const type of preference) {
    if (catalog.claimed.has(type)) {
      return type;
    }
  }
  return undefined;
}

/**
 * The capture signals an action type contributes.
 *
 * The reverse of {@link SIGNAL_ACTION_TYPES}, computed rather than restated so
 * the two cannot disagree. It is what lets a plan's capture list stay coherent
 * with the targets it installs: a plan that wraps a database call asks for the
 * query signal whether or not the understanding thought to name it.
 *
 * @param type An action type.
 * @returns The signals it contributes, in ascending order.
 */
function signalsForActionType(type: ActionTypeId): readonly string[] {
  const signals: string[] = [];
  for (const signal of sortStrings(Object.keys(SIGNAL_ACTION_TYPES))) {
    const types = SIGNAL_ACTION_TYPES[signal];
    if (types !== undefined && types.includes(type)) {
      signals.push(signal);
    }
  }
  return signals;
}

/**
 * The hypotheses a context already carries, if any.
 *
 * Carried forward, never invented: a plan may record what an earlier stage
 * proposed, and a hypothesis this module made up would be an inference
 * presented as an input. The field is omitted from the output entirely when
 * there is nothing to carry.
 *
 * @param root The structured context.
 * @returns The distinct statements, ordered and capped.
 */
function readCarriedHypotheses(root: JsonObject): readonly string[] {
  const statements = new Set<string>();
  for (const bag of [root, understandingBag(root), investigationBag(root), analysisBag(root)]) {
    if (bag === undefined) {
      continue;
    }
    for (const statement of asStringArray(bag.hypotheses)) {
      statements.add(statement);
    }
    for (const entry of asObjectArray(bag.hypotheses) ?? []) {
      const statement = asString(readField(entry, 'statement', 'text', 'label'));
      if (statement !== undefined) {
        statements.add(statement);
      }
    }
    for (const entry of asObjectArray(readField(bag, 'likelyCauses', 'causes')) ?? []) {
      const statement = asString(readField(entry, 'statement', 'text', 'label'));
      if (statement !== undefined) {
        statements.add(statement);
      }
    }
  }
  return sortStrings([...statements]).slice(0, MAX_PLAN_HYPOTHESES);
}

/**
 * One instrumentation target in the plan's authoring shape.
 *
 * `adapter`, `mode` and the action's identifier are deliberately absent: the
 * plan normaliser assigns all three deterministically by asking the adapter
 * registry which adapter claims the action, and a value invented here would
 * either be overwritten or rejected.
 *
 * @param file The target's project-relative POSIX path.
 * @param symbol The target symbol.
 * @param type The action type, already validated against the eight.
 * @returns The target as plain JSON.
 */
function instrumentationTarget(file: string, symbol: string, type: ActionTypeId): JsonObject {
  return {
    file,
    symbol,
    type,
    rationale: instrumentationActionRationale(
      instrumentationActionTypeLabel(type),
      sanitizeLabel(symbol, file),
    ),
  };
}

/* -------------------------------------------------------------------------------------------------
 * The function-timing target filter
 *
 * A function-timing action rewrites one declaration, and the plan has only a
 * few slots for rewrites once the runtime hooks are reserved. The slots go
 * where no runtime hook can see: the server-side functions a request runs
 * between the route that answers it and the query it reaches. The page side of
 * a request is already observed by the interaction, render and request hooks,
 * the route by the server spans, and the query by the database hooks.
 *
 * The planning context carries the relevant files without their code-graph
 * kinds, but it carries the investigation's grounded flows, whose steps are the
 * names the graph walk returned in downstream order. A step naming a route (a
 * route path, optionally method-qualified — the one step shape the
 * investigation writes that is not a code name) splits a flow into its page
 * side and its server side. Only that structure is read: no name, path or
 * framework noun of any project is known here.
 * ---------------------------------------------------------------------------------------------- */

/** Splits one rendered flow into its steps, at the arrow the investigation writes, in either spelling. */
const PLAN_FLOW_STEP_SEPARATOR = /\s*(?:→|->)\s*/u;

/** A flow step that names a route: a route path, optionally preceded by an HTTP method. */
const ROUTE_STEP_PATTERN = /^(?:[A-Z]+\s+)?\//u;

/** Where a flow places a function-timing candidate, best slot first. */
const FLOW_PLACEMENT_RANKS = Object.freeze({
  /** After a route: server-side work no runtime hook times. */
  server: 0,
  /** On no flow that passes a route: nothing says which side it runs on. */
  unplaced: 1,
  /** Before a route: page-side work the interaction and request hooks already observe. */
  page: 2,
} as const);

/** Where the investigation's flows place each step name, for the function-timing filter. */
interface FlowPlacements {
  /**
   * Names a flow places after a route, each with its smallest distance from
   * that route in steps — the function the route calls first is 1.
   */
  readonly server: ReadonlyMap<string, number>;
  /** Names a flow places before the route it passes through. */
  readonly page: ReadonlySet<string>;
  /**
   * The last step of a flow that passed a route and ends past it: the
   * data-layer call site a database walk ends at. A call site is not a
   * declaration, and the database hooks already observe it.
   */
  readonly callSites: ReadonlySet<string>;
}

/**
 * The steps of every flow the planning context carries, in each flow's order.
 *
 * A flow arrives as the investigation rendered it — one line with an arrow
 * between steps — or as a list or object of steps; each is read as steps.
 *
 * @param root The structured context of a plan-stage request.
 * @returns One step list per flow, in the context's order.
 */
function planFlowSteps(root: JsonObject): readonly (readonly string[])[] {
  const flows: (readonly string[])[] = [];
  for (const bag of [root, investigationBag(root)]) {
    for (const member of asArray(bag?.flows) ?? []) {
      const line = asString(member);
      const steps =
        line === undefined
          ? readFlowSteps(member)
          : line.split(PLAN_FLOW_STEP_SEPARATOR).map((step) => step.trim());
      const kept = steps.filter((step) => step.length > 0).slice(0, MAX_FLOW_STEPS);
      if (kept.length > 0) {
        flows.push(kept);
      }
    }
  }
  return flows;
}

/**
 * The routes the context's flows pass through ({@link ROUTE_STEP_PATTERN}),
 * each once, in flow order and then step order — the server entry points the
 * plan objective names beside the selected target.
 *
 * @param root The structured context of a plan-stage request.
 * @returns The route steps; empty when no flow names a route.
 */
function tracedRoutes(root: JsonObject): readonly string[] {
  const routes: string[] = [];
  for (const steps of planFlowSteps(root)) {
    for (const step of steps) {
      if (ROUTE_STEP_PATTERN.test(step) && !routes.includes(step)) {
        routes.push(step);
      }
    }
  }
  return routes;
}

/**
 * Places every step name of the context's flows relative to the routes they
 * pass through (see {@link FlowPlacements}). A flow that names no route places
 * nothing: its steps are all neutral.
 *
 * @param root The structured context of a plan-stage request.
 * @returns The placements; empty when the context carries no flow.
 */
function readFlowPlacements(root: JsonObject): FlowPlacements {
  const server = new Map<string, number>();
  const page = new Set<string>();
  const callSites = new Set<string>();
  for (const steps of planFlowSteps(root)) {
    const route = steps.findIndex((step) => ROUTE_STEP_PATTERN.test(step));
    if (route === -1) {
      continue;
    }
    steps.forEach((step, index) => {
      if (index < route) {
        page.add(step);
      } else if (index > route && !ROUTE_STEP_PATTERN.test(step)) {
        const distance = index - route;
        server.set(step, Math.min(server.get(step) ?? distance, distance));
      }
    });
    const last = steps[steps.length - 1];
    if (last !== undefined && steps.length - 1 > route && !ROUTE_STEP_PATTERN.test(last)) {
      callSites.add(last);
    }
  }
  return { server, page, callSites };
}

/** One candidate with the action type the plan would install for it. */
interface TypedCandidate {
  readonly candidate: CandidateView;
  readonly type: ActionTypeId;
}

/**
 * Applies the function-timing target filter to the ranked candidates.
 *
 * - A candidate whose type is not `function-timing` keeps its place.
 * - A `function-timing` candidate that is a flow's data-layer call site is
 *   re-typed to the next action type its kind accepts that is not a rewrite —
 *   the database hook for a database call — and dropped when there is none.
 * - The remaining `function-timing` candidates are ordered server side first
 *   (nearest the route first), then those no flow places, then the page side;
 *   within one placement the candidates keep their ranked order.
 *
 * The sort is stable and the output depends only on the context, so the plan
 * stays identical for identical input.
 *
 * @param candidates The candidates, already ranked by score.
 * @param catalog The adapter catalog view.
 * @param placements Where the flows place each step name.
 * @returns The typed candidates in the order the plan considers them.
 */
function filterFunctionTimingTargets(
  candidates: readonly CandidateView[],
  catalog: AdapterCatalogView,
  placements: FlowPlacements,
): readonly TypedCandidate[] {
  const typed: { readonly entry: TypedCandidate; readonly rank: number; readonly order: number }[] =
    [];
  candidates.forEach((candidate, order) => {
    let type = chooseActionType(candidate.actionTypes, catalog);
    if (type === 'function-timing' && placements.callSites.has(candidate.symbol)) {
      type = chooseActionType(
        candidate.actionTypes.filter((option) => !TARGET_REQUIRED_TYPES.has(option)),
        catalog,
      );
    }
    if (type === undefined) {
      return;
    }
    let rank: number = FLOW_PLACEMENT_RANKS.server;
    let distance = 0;
    if (type === 'function-timing') {
      const serverDistance = placements.server.get(candidate.symbol);
      if (serverDistance !== undefined) {
        distance = serverDistance;
      } else {
        rank = placements.page.has(candidate.symbol)
          ? FLOW_PLACEMENT_RANKS.page
          : FLOW_PLACEMENT_RANKS.unplaced;
      }
    }
    typed.push({ entry: { candidate, type }, rank: rank * (MAX_FLOW_STEPS + 1) + distance, order });
  });
  typed.sort((left, right) =>
    left.rank === right.rank ? left.order - right.order : left.rank - right.rank,
  );
  return typed.map(({ entry }) => entry);
}

/**
 * A candidate narrowed to the action types its question's category admits.
 *
 * A page-observed or request-shaped category installs runtime hooks only
 * ({@link CategoryProfile.candidateActionTypes}), so a route handler or server
 * function the investigation related to such a question is not rewritten to
 * time it: its preference list is filtered, and a candidate left with none is
 * skipped by the plan like any candidate the catalog claims nothing for. A
 * category without a profile, or a profile that admits every type, leaves the
 * candidate as it is.
 *
 * @param candidate A ranked candidate.
 * @param category The category the context carried, if any.
 * @returns The candidate with its admitted preference list.
 */
function admittedByCategory(candidate: CandidateView, category: string | undefined): CandidateView {
  const admitted = categoryProfile(category)?.candidateActionTypes;
  if (admitted === undefined) {
    return candidate;
  }
  return { ...candidate, actionTypes: candidate.actionTypes.filter((type) => admitted.has(type)) };
}

/**
 * Builds the instrumentation plan of a request from its structured context.
 *
 * The objective comes from the plan-objective frame, filled with the category
 * label, the label of the component the plan is about — the selection's, else
 * the understanding's ({@link pointedComponentLabel}) — how the capture
 * reproduces the behaviour (an interaction for an input-driven category,
 * {@link CategoryProfile.inputDriven}, else observing the page) and the routes
 * the investigation's flows traced ({@link tracedRoutes}) — never with the
 * developer's wording.
 * The capture list is the signals the understanding asked for, the signals its
 * category observes whenever the page is observed ({@link plannedSignals}) and
 * the signals the chosen targets contribute, intersected with what the adapter
 * catalog reports as collectable. The targets are chosen from the investigation
 * candidates the context supplies, each one's action type taken from its node
 * kind, narrowed to what the question's category admits
 * ({@link admittedByCategory}) and filtered through the catalog's claims,
 * runtime hooks preferred over rewrites.
 *
 * @param input The structured context of a plan-stage request.
 * @returns The plan in its authoring shape, or `undefined` when the context
 * yields neither a signal to capture nor a target to instrument.
 */
export function buildPlanInput(input: JsonValue | undefined): JsonValue | undefined {
  const root = asObject(input);
  if (root === undefined) {
    return undefined;
  }

  const understanding = readUnderstanding(root);
  const catalog = readAdapterCatalog(root);
  const candidates = sortCandidates(readCandidates(root, understanding)).map((candidate) =>
    admittedByCategory(candidate, understanding.category),
  );

  // The page- and process-wide runtime action each needed signal would be
  // collected by. Their slots are reserved before candidates are considered, so
  // a long candidate list can never crowd out the hooks a capture depends on.
  const signalTypes: ActionTypeId[] = [];
  for (const signal of sortStrings(plannedSignals(understanding))) {
    const type = (SIGNAL_ACTION_TYPES[signal] ?? []).find(
      (candidate) =>
        catalog.claimed.has(candidate) &&
        isRuntimeActionType(candidate, catalog) &&
        !TARGET_REQUIRED_TYPES.has(candidate),
    );
    if (type !== undefined && !signalTypes.includes(type)) {
      signalTypes.push(type);
    }
  }
  const candidateBudget = Math.max(0, MAX_INSTRUMENTATION_TARGETS - signalTypes.length);

  const targets: JsonObject[] = [];
  const emitted = new Set<string>();
  const emittedTypes = new Set<ActionTypeId>();
  const contributed = new Set<string>();
  const considered = filterFunctionTimingTargets(candidates, catalog, readFlowPlacements(root));
  for (const { candidate, type } of considered) {
    if (targets.length >= candidateBudget) {
      break;
    }
    // A runtime hook the plan already reserves observes the whole page or
    // process, this candidate included: a second action of that type would
    // collect nothing new, so the slot goes to a candidate that needs its own.
    if (signalTypes.includes(type)) {
      continue;
    }
    const key = `${candidate.file}|${candidate.symbol}|${type}`;
    if (emitted.has(key)) {
      continue;
    }
    emitted.add(key);
    emittedTypes.add(type);
    targets.push(instrumentationTarget(candidate.file, candidate.symbol, type));
    for (const signal of signalsForActionType(type)) {
      contributed.add(signal);
    }
  }

  // A needed signal no candidate's action collects is collected by a
  // targetless runtime action: the hook that observes it everywhere.
  for (const type of signalTypes) {
    if (emittedTypes.has(type)) {
      continue;
    }
    emittedTypes.add(type);
    targets.push(instrumentationTarget(TARGETLESS_ACTION_FILE, TARGETLESS_ACTION_SYMBOL, type));
    for (const covered of signalsForActionType(type)) {
      contributed.add(covered);
    }
  }

  const wanted = new Set<string>([...understanding.signals, ...contributed]);
  const capture: string[] = [];
  for (const signal of sortStrings([...wanted])) {
    if (catalog.signals.size === 0 || catalog.signals.has(signal)) {
      capture.push(signal);
    }
  }

  if (capture.length === 0 && targets.length === 0) {
    return undefined;
  }

  const hypotheses = readCarriedHypotheses(root);
  // Reproduced by an interaction — with the component the understanding points
  // at, when it points at one — when the category's behaviour is input-driven,
  // or, for a category without a profile, when the understanding needs the
  // interaction signal; otherwise the capture observes the page. A symbol the
  // investigation resolved is one the project declares.
  const targetLabel = pointedComponentLabel(
    root,
    understanding,
    new Set([...readDeclaredComponents(root), ...candidates.map((candidate) => candidate.symbol)]),
  );
  const profile = categoryProfile(understanding.category);
  const interactive =
    profile === undefined
      ? understanding.signals.includes(INTERACTION_SIGNAL)
      : profile.inputDriven;
  return {
    objective: planObjective(
      problemCategoryLabel(understanding.category ?? ''),
      targetLabel,
      interactive ? 'interaction' : 'page',
      tracedRoutes(root),
    ),
    capture: capture.slice(0, MAX_CAPTURE_SIGNALS),
    instrumentationTargets: targets,
    ...(hypotheses.length > 0 ? { hypotheses: [...hypotheses] } : {}),
  };
}

/* -------------------------------------------------------------------------------------------------
 * stage 5 — analysis
 *
 * Observed facts and likely causes are produced by two separate passes and kept
 * structurally apart, because the product presents them apart: a fact restates
 * a measurement and cites the events it came from, while a cause names the
 * pattern those measurements form and carries a confidence. Nothing in the
 * first pass makes a causal claim, and nothing in the second is presented as
 * having been observed.
 * ---------------------------------------------------------------------------------------------- */

/** The classes of deterministic fact candidate, for ranking. */
type FactClass =
  | 'slowestSpan'
  | 'duplicateRequests'
  | 'contextRenders'
  | 'unchangedRenders'
  | 'repeatedQuery'
  | 'renderCount'
  | 'sharedOrigin'
  | 'unknownTrigger'
  | 'tierSplit'
  | 'longTask'
  | 'errors'
  | 'focusedDeclaration';

/**
 * How much each class of fact is worth on a crowded panel.
 *
 * Ranking rather than filtering: every class that has material produces its
 * candidates, and the cap keeps the highest-ranked ones. Which classes have
 * material is decided by the capture, which is why one capture's analysis reads
 * as a latency finding and another's as a rendering finding without either
 * outcome being written down anywhere.
 *
 * `contextRenders` sits just above `unchangedRenders`: in a capture of a
 * context cascade the consumers re-rendered by the changing value are the
 * finding and the unchanged-input renders are usually their children, so the
 * cascade's facts must survive {@link MAX_OBSERVED_FACTS} even when the
 * slowest operations and the unchanged-input facts fill most of it.
 *
 * `focusedDeclaration` — what the capture measured of a declaration a
 * follow-up named ({@link focusFactCandidates}) — outweighs every other class,
 * and exists only when a follow-up focus names a declaration the capture
 * measured, so it never displaces anything in a first question's analysis.
 */
const FACT_CLASS_WEIGHTS: Readonly<Record<FactClass, number>> = Object.freeze({
  slowestSpan: 95,
  duplicateRequests: 90,
  contextRenders: 88,
  unchangedRenders: 85,
  repeatedQuery: 80,
  renderCount: 70,
  sharedOrigin: 65,
  unknownTrigger: 60,
  tierSplit: 50,
  longTask: 40,
  errors: 30,
  focusedDeclaration: 100,
});

/**
 * The fact classes that answer each focus category, for the boost a follow-up
 * focus gives them ({@link factFocusBoost}).
 *
 * Keyed by {@link FOCUS_CATEGORIES}: a latency focus asks where the time went,
 * a query focus about the repeated statement shapes, a request focus about the
 * duplicated requests and where they came from, a render or state focus about
 * the renders and what triggered them, an error focus about the failures.
 * `correctness` names no class of measurement, so it boosts none.
 */
const FOCUS_FACT_CLASSES: Readonly<Record<string, readonly FactClass[]>> = Object.freeze({
  performance: ['slowestSpan', 'tierSplit', 'longTask'],
  data: ['repeatedQuery'],
  network: ['duplicateRequests', 'sharedOrigin'],
  rendering: ['contextRenders', 'unchangedRenders', 'renderCount', 'unknownTrigger'],
  state: ['contextRenders', 'unchangedRenders', 'renderCount', 'unknownTrigger'],
  error: ['errors'],
  correctness: [],
});

/**
 * The tier whose timing facts answer a focus category beyond its own classes:
 * a query focus also asks how long the database took, so the database tier's
 * share of the time and the slowest operations recorded there are boosted with
 * the repeated statement shapes.
 */
const FOCUS_TIMING_TIERS: Readonly<Record<string, string>> = Object.freeze({
  data: 'db',
});

/** The fact classes {@link FOCUS_TIMING_TIERS} reads a tier from. */
const TIERED_FACT_CLASSES: ReadonlySet<FactClass> = new Set<FactClass>([
  'slowestSpan',
  'tierSplit',
]);

/**
 * One rank step of a focus boost.
 *
 * Larger than the whole spread of {@link FACT_CLASS_WEIGHTS}, so a boosted
 * class outranks every unboosted one whatever their weights, while candidates
 * with the same boost keep their weighted order. Additive, and zero without a
 * focus, which is what keeps a first question's ranking exactly as it was.
 */
const FOCUS_RANK_STEP = 1000;

/** Facts about focused declarations one analysis reports, at most. */
const MAX_FOCUSED_DECLARATION_FACTS = 3;

/** Slowest operations reported as facts. */
const MAX_SLOWEST_SPAN_FACTS = 2;

/** Components reported as render outliers. */
const MAX_RENDER_OUTLIER_FACTS = 3;

/** Components reported for their context-triggered renders. */
const MAX_CONTEXT_RENDER_FACTS = 2;

/** Context-triggered renders of one component before they are reported or explained. */
const CONTEXT_RENDER_MIN_COUNT = 2;

/**
 * Providers followed upstream from the consumer's immediate provider.
 *
 * A provider whose own renders are mostly context-triggered is itself a
 * consumer of a context further up, so the chain is followed to the component
 * whose renders are state-triggered — the origin of the changing value. Real
 * provider nesting is a handful of levels deep; the bound, with the visited
 * set, is what makes a cyclic or pathological attribution terminate.
 */
const MAX_CONTEXT_CHAIN_HOPS = 4;

/**
 * Consumer renders a context-change cause cites, leaving room within
 * {@link MAX_EVIDENCE_PER_FACT} for one render of the provider and one of the
 * origin, so every link of the chain the sentence names is substantiated.
 */
const MAX_CONTEXT_CONSUMER_EVIDENCE = MAX_EVIDENCE_PER_FACT - 2;

/** Duplicate request groups reported as facts. */
const MAX_DUPLICATE_GROUP_FACTS = 3;

/** Query groups reported as facts. */
const MAX_QUERY_GROUP_FACTS = 3;

/** One observed-fact candidate, before evidence filtering and ranking. */
interface FactCandidate {
  /** The class this candidate belongs to. */
  readonly factClass: FactClass;
  /** The within-class rank: a duration, a count, whatever the class measures. */
  readonly magnitude: number;
  /** The rendered sentence. */
  readonly statement: string;
  /** The references this candidate would cite, before filtering. */
  readonly references: readonly string[];
  /** The tier a timing fact is about, for {@link FOCUS_TIMING_TIERS}; absent otherwise. */
  readonly tier?: string;
}

/** Fields shared by every evidence-pattern detection. */
interface CauseDetectionBase {
  /** Whole steps of evidence strength, for {@link confidenceForSteps}. */
  readonly steps: number;
  /**
   * The steps the detection is **ranked** by, when that differs from
   * {@link steps}. Confidence always comes from `steps`; this only lets a
   * detection that explains another rank with it without claiming more
   * confidence than its own evidence carries.
   */
  readonly rankingSteps?: number;
  /** The references the detection would cite, before filtering. */
  readonly references: readonly string[];
  /** A location to suggest, when the context supplied a usable one. */
  readonly location?: SourceLocation;
  /**
   * The measured time the detected pattern accounts for, in milliseconds: a
   * query group's summed time, a dominant operation's duration, a request
   * group's summed time. Orders two equally strong causes by what they cost; a
   * detection whose time the capture does not state omits it and ranks as zero.
   */
  readonly accountedMs?: number;
}

/**
 * One detected evidence pattern, with the values its frame needs.
 *
 * A discriminated union rather than a pre-rendered sentence, so
 * {@link causeStatement} can switch over the pattern exhaustively: adding a
 * pattern to the shared vocabulary without giving it a frame becomes a compile
 * error instead of a missing hypothesis at run time.
 */
type CauseDetection = CauseDetectionBase &
  (
    | {
        readonly pattern: Extract<EvidencePattern, 'duplicate-requests'>;
        readonly count: number;
        readonly windowMs: number;
        readonly callSite: string;
      }
    | {
        readonly pattern: Extract<EvidencePattern, 'unchanged-input-renders'>;
        readonly component: string;
        readonly unchanged: number;
      }
    | {
        readonly pattern: Extract<EvidencePattern, 'dominant-span'>;
        readonly operation: string;
        readonly durationMs: number;
        readonly totalMs: number;
        readonly tier?: string;
      }
    | {
        readonly pattern: Extract<EvidencePattern, 'repeated-query-shape'>;
        readonly count: number;
        readonly statement: string;
        readonly caller?: string;
      }
    | {
        readonly pattern: Extract<EvidencePattern, 'context-change-renders'>;
        readonly consumer: string;
        readonly contextRenders: number;
        readonly provider?: string;
        readonly origin?: string;
      }
  );

/**
 * How detections of equal ranking strength are ordered, lowest first, before
 * their statements break the tie.
 *
 * A context cascade explains the renders with unchanged inputs it leaves
 * behind — the children of the consumers it re-rendered — so at equal
 * strength it leads. Every other pattern shares one value, which keeps their
 * relative order exactly the statement order it has always been. Keyed by the
 * shared vocabulary, so a new pattern without an entry is a compile error.
 */
const CAUSE_PATTERN_PRECEDENCE: Readonly<Record<EvidencePattern, number>> = Object.freeze({
  'context-change-renders': 0,
  'duplicate-requests': 1,
  'unchanged-input-renders': 1,
  'dominant-span': 1,
  'repeated-query-shape': 1,
});

/**
 * The sentence for one detected pattern.
 *
 * The one place a pattern class becomes prose, and the mapping is one to one
 * with the vocabulary the frames are documented against.
 *
 * @param detection The detected pattern and its values.
 * @returns The rendered hypothesis statement.
 */
function causeStatement(detection: CauseDetection): string {
  switch (detection.pattern) {
    case 'duplicate-requests':
      return duplicateRequestCause(detection.count, detection.windowMs, detection.callSite);
    case 'unchanged-input-renders':
      return unchangedInputRenderCause(detection.component, detection.unchanged);
    case 'dominant-span':
      return dominantSpanCause(
        detection.operation,
        detection.durationMs,
        detection.totalMs,
        detection.tier,
      );
    case 'repeated-query-shape':
      return repeatedQueryShapeCause(detection.count, detection.statement, detection.caller);
    case 'context-change-renders':
      return contextChangeRenderCause(
        detection.consumer,
        detection.contextRenders,
        detection.provider,
        detection.origin,
      );
    default:
      return assertNever(
        detection,
        'every evidence pattern needs a likely-cause frame; this one has none.',
      );
  }
}

/**
 * A validated source location as plain JSON, with its keys in a fixed order.
 *
 * Rebuilt rather than passed through so the emitted key order is this module's
 * and not the validator's, which is what makes the serialised bytes of two runs
 * identical.
 *
 * @param location A validated location.
 * @returns The location as a JSON object.
 */
function locationToJson(location: SourceLocation): JsonObject {
  return {
    file: location.file,
    line: location.line,
    column: location.column,
    ...(location.symbol !== undefined ? { symbol: location.symbol } : {}),
    ...(location.endLine !== undefined ? { endLine: location.endLine } : {}),
    resolvedBy: location.resolvedBy,
    confidence: location.confidence,
  };
}

/**
 * Orders spans by duration, then by name, then by their first reference.
 *
 * @param spans The operations to order.
 * @returns A new, ordered array.
 */
function sortSpans(spans: readonly SpanView[]): SpanView[] {
  return [...spans].sort((left, right) => {
    if (left.duration !== right.duration) {
      return right.duration - left.duration;
    }
    const byName = compareStrings(left.name, right.name);
    if (byName !== 0) {
      return byName;
    }
    return compareStrings(evidenceOf(left.node)[0] ?? '', evidenceOf(right.node)[0] ?? '');
  });
}

/**
 * Telemetry kinds whose span is the envelope of a capture rather than work
 * inside it: a user interaction's root span and a page navigation each measure
 * the whole interval every other operation was recorded within.
 *
 * Product vocabulary, restated from `@debuggen/telemetry`'s kind list with the
 * others in {@link EVIDENCE_REF_KINDS}.
 */
const ENVELOPE_SPAN_KINDS: ReadonlySet<string> = new Set(['interaction', 'navigation']);

/**
 * Whether a span is the capture's envelope: of an {@link ENVELOPE_SPAN_KINDS}
 * kind, or at least as long as the interaction's measured total.
 *
 * Such a span covers the interaction by construction, so naming it as the
 * slowest operation or as the one that dominates the total restates the
 * total — "the interaction accounts for all of the interaction" — and hides
 * the operation that actually took the time.
 *
 * @param span A measured operation.
 * @param totalMs The interaction's measured total, when there is one.
 * @returns `true` when the span is the envelope.
 */
function isEnvelopeSpan(span: SpanView, totalMs: number | undefined): boolean {
  if (span.kind !== undefined && ENVELOPE_SPAN_KINDS.has(span.kind)) {
    return true;
  }
  return totalMs !== undefined && span.duration >= totalMs;
}

/**
 * The operations that took time inside the interaction, in the given order:
 * every span except the envelope ({@link isEnvelopeSpan}).
 *
 * @param spans The ordered operations of the capture.
 * @param totalMs The interaction's measured total, when there is one.
 * @returns The non-envelope operations.
 */
function contributingSpans(
  spans: readonly SpanView[],
  totalMs: number | undefined,
): readonly SpanView[] {
  return spans.filter((span) => !isEnvelopeSpan(span, totalMs));
}

/**
 * What an operation of a kind whose names are generic is, in words.
 *
 * The browser agent names a performance entry by its entry type (`resource`,
 * `paint`), a long task by its attribution and a navigation by its type, so
 * "resource took 1564.9 ms" says nothing about what kind of thing took the
 * time. A span of one of these kinds is named with its phrase appended. Fixed
 * product wording keyed by product kinds, never by anything a capture names.
 */
const SPAN_KIND_PHRASES: ReadonlyMap<string, string> = new Map([
  ['perf.entry', 'browser performance entry'],
  ['perf.longtask', 'browser long task'],
  ['navigation', 'page navigation'],
]);

/**
 * The name an operation is stated by: its own, qualified with its kind's
 * phrase when its kind names generically ({@link SPAN_KIND_PHRASES}), and the
 * phrase alone when it has no name.
 *
 * @param span A measured operation.
 * @returns The name to interpolate; empty when the span has neither, so the
 * frame applies its own fallback wording.
 */
function operationLabel(span: SpanView): string {
  const phrase = span.kind === undefined ? undefined : SPAN_KIND_PHRASES.get(span.kind);
  if (phrase === undefined) {
    return span.name;
  }
  return span.name.length === 0 ? phrase : `${span.name} (${phrase})`;
}

/**
 * Builds the observed-fact candidates of a capture.
 *
 * One pass per candidate class, each ordered and capped within its class, so a
 * capture with a thousand render statistics contributes a bounded number of
 * facts and the ones it contributes are its largest. Nothing is filtered by
 * evidence yet — that happens once, in {@link buildAnalysis}, so the rule is
 * applied in one place.
 *
 * @param root The structured context.
 * @param reading The metric reading.
 * @param spans The ordered operations of the capture.
 * @param totalMs The interaction's measured total, when there is one.
 * @returns The candidates, unordered across classes.
 */
function factCandidates(
  root: JsonObject,
  reading: MetricReading,
  spans: readonly SpanView[],
  totalMs: number | undefined,
): readonly FactCandidate[] {
  const aggregates = aggregatesBag(root);
  const candidates: FactCandidate[] = [];

  if (totalMs !== undefined && totalMs > 0) {
    // The envelope is excluded: "the interaction took all of the interaction's
    // time" is the total restated, not a fact about where the time went.
    for (const span of contributingSpans(spans, totalMs).slice(0, MAX_SLOWEST_SPAN_FACTS)) {
      if (span.duration <= 0) {
        continue;
      }
      candidates.push({
        factClass: 'slowestSpan',
        magnitude: span.duration,
        statement: slowestSpanFact(operationLabel(span), span.duration, totalMs),
        references: evidenceOf(span.node),
        ...(span.tier !== undefined ? { tier: span.tier } : {}),
      });
    }

    for (const tier of sortStrings(Object.keys(TIER_DURATION_METRICS))) {
      const metricId = TIER_DURATION_METRICS[tier];
      const elapsed = metricId === undefined ? undefined : reading.values.get(metricId);
      if (elapsed === undefined || elapsed <= 0) {
        continue;
      }
      const references: string[] = [];
      for (const span of spans) {
        if (span.tier !== tier) {
          continue;
        }
        for (const reference of evidenceOf(span.node)) {
          references.push(reference);
        }
      }
      candidates.push({
        factClass: 'tierSplit',
        magnitude: elapsed,
        statement: tierTimeSplitFact(telemetryTierLabel(tier), elapsed, totalMs),
        references,
        tier,
      });
    }
  }

  const requestGroups = [...readRequestGroups(aggregates)]
    .filter((group) => group.count >= DUPLICATE_GROUP_MIN_COUNT)
    .sort((left, right) =>
      left.count === right.count
        ? compareStrings(left.endpoint ?? '', right.endpoint ?? '')
        : right.count - left.count,
    )
    .slice(0, MAX_DUPLICATE_GROUP_FACTS);
  for (const group of requestGroups) {
    const { references } = group;
    candidates.push({
      factClass: 'duplicateRequests',
      magnitude: group.count,
      statement: duplicateRequestFact(group.count, group.windowMs, group.endpoint),
      references,
    });
    const callSite = group.location === undefined ? '' : formatSourceLocation(group.location);
    if (callSite.length > 0) {
      candidates.push({
        factClass: 'sharedOrigin',
        magnitude: group.count,
        statement: sharedOriginFact(group.count, callSite),
        references,
      });
    }
  }

  // The project's own components when the capture says which they are, so a
  // framework's internal components, however often they rendered, never take
  // the places of the components a developer can change.
  const projectOwned = projectRenders(readRenders(aggregates));
  const renders = [...projectOwned].sort((left, right) =>
    left.count === right.count
      ? compareStrings(left.component, right.component)
      : right.count - left.count,
  );
  for (const render of rankContextConsumers(projectOwned).slice(0, MAX_CONTEXT_RENDER_FACTS)) {
    candidates.push({
      factClass: 'contextRenders',
      magnitude: contextScore(render),
      statement: contextTriggeredRenderFact(
        render.component,
        render.contextTriggered,
        render.count,
        render.changedContexts.slice(0, CONTEXT_PROVIDER_LIST_MAX_ITEMS),
      ),
      references: triggerEvidence(render, 'context', render.changedContexts[0]),
    });
  }
  for (const render of renders.slice(0, MAX_RENDER_OUTLIER_FACTS)) {
    if (render.count < RENDER_OUTLIER_MIN_COUNT) {
      continue;
    }
    const references = evidenceOf(render.node);
    candidates.push({
      factClass: 'renderCount',
      magnitude: render.count,
      statement: renderCountFact(render.component, render.count),
      references,
    });
    // Each sentence names the component its counts belong to and cites that
    // component's renders of the trigger it describes, not its other renders.
    if (render.unchanged >= UNCHANGED_RENDER_MIN_COUNT) {
      candidates.push({
        factClass: 'unchangedRenders',
        magnitude: render.unchanged,
        statement: unchangedInputRenderFact(render.unchanged, render.count, render.component),
        references: triggerEvidence(render, 'unchanged'),
      });
    }
    if (render.unknownTrigger >= UNKNOWN_TRIGGER_MIN_COUNT) {
      candidates.push({
        factClass: 'unknownTrigger',
        magnitude: render.unknownTrigger,
        statement: unknownTriggerRenderFact(render.unknownTrigger, render.count, render.component),
        references: triggerEvidence(render, 'unknown'),
      });
    }
  }

  // Costliest first ({@link compareQueryGroups}), so the capped list keeps the
  // shapes that took the time rather than the ones that merely ran as often.
  // The magnitude is the rank itself, which keeps that order through the
  // cross-class sort in {@link buildAnalysis}.
  const queryGroups = [...readQueryGroups(aggregates)]
    .filter((group) => group.count >= REPEATED_QUERY_MIN_COUNT)
    .sort(compareQueryGroups)
    .slice(0, MAX_QUERY_GROUP_FACTS);
  for (const [position, group] of queryGroups.entries()) {
    candidates.push({
      factClass: 'repeatedQuery',
      magnitude: queryGroups.length - position,
      statement: repeatedQueryShapeFact(group.count, group.statement),
      references: evidenceOf(group.node),
    });
  }

  const longTasks = readObjectArrayField(aggregates, 'longTasks', 'longTaskEntries') ?? [];
  const longTaskCount = reading.values.get('long_task_count') ?? longTasks.length;
  if (longTaskCount >= LONG_TASK_MIN_COUNT) {
    const references: string[] = [];
    let longest: number | undefined;
    for (const task of longTasks) {
      for (const reference of evidenceOf(task)) {
        references.push(reference);
      }
      const duration = asDurationMs(readField(task, 'duration', 'durationMs'));
      if (duration !== undefined && (longest === undefined || duration > longest)) {
        longest = duration;
      }
    }
    candidates.push({
      factClass: 'longTask',
      magnitude: longTaskCount,
      statement: longTaskFact(longTaskCount, longest),
      references,
    });
  }

  const errorEntries = readObjectArrayField(aggregates, 'errors', 'errorEntries') ?? [];
  const errorCount = reading.values.get('error_count') ?? errorEntries.length;
  if (errorCount >= ERROR_MIN_COUNT) {
    const references: string[] = [];
    for (const entry of errorEntries) {
      for (const reference of evidenceOf(entry)) {
        references.push(reference);
      }
    }
    candidates.push({
      factClass: 'errors',
      magnitude: errorCount,
      statement: errorCountFact(errorCount),
      references,
    });
  }

  return candidates;
}

/**
 * The fact candidates a follow-up focus adds: for each focused declaration the
 * capture measured, in the focus's order, how often it ran and how long it
 * took, citing the operations that measured it.
 *
 * The share of the interaction is stated only when the runs fit inside the
 * interaction's measured total: runs spread over several interactions, or
 * overlapping one another, sum to more than any one of them took, and a share
 * above the whole would misstate both numbers. A declaration the capture holds
 * no operation of yields nothing — the absence of a measurement is not a
 * finding — and at most {@link MAX_FOCUSED_DECLARATION_FACTS} are reported.
 *
 * @param focus The context's focus, if any.
 * @param aggregates The capture-aggregate bag.
 * @param totalMs The interaction's measured total, when there is one.
 * @returns The candidates; empty without a focus.
 */
function focusFactCandidates(
  focus: FollowUpFocusView | undefined,
  aggregates: JsonObject,
  totalMs: number | undefined,
): readonly FactCandidate[] {
  if (focus === undefined) {
    return [];
  }
  const candidates: FactCandidate[] = [];
  for (const measurement of focusedMeasurements(focus, aggregates).slice(
    0,
    MAX_FOCUSED_DECLARATION_FACTS,
  )) {
    const references: string[] = [];
    for (const span of measurement.spans) {
      references.push(...evidenceOf(span.node));
    }
    const share =
      totalMs !== undefined && totalMs > 0 && measurement.totalMs <= totalMs ? totalMs : undefined;
    candidates.push({
      factClass: 'focusedDeclaration',
      magnitude: measurement.totalMs,
      statement: focusedDeclarationFact(
        measurement.declaration.symbol,
        measurement.count,
        measurement.totalMs,
        share,
      ),
      references,
    });
  }
  return candidates;
}

/**
 * Whether a fact candidate answers a focus category ({@link FOCUS_FACT_CLASSES},
 * {@link FOCUS_TIMING_TIERS}).
 *
 * @param candidate A fact candidate.
 * @param category A member of {@link FOCUS_CATEGORIES}.
 * @returns `true` when the candidate is of a class, or about a tier, the
 * category asks about.
 */
function factAnswersCategory(candidate: FactCandidate, category: string): boolean {
  const classes = Object.hasOwn(FOCUS_FACT_CLASSES, category)
    ? FOCUS_FACT_CLASSES[category]
    : undefined;
  if (classes?.includes(candidate.factClass) === true) {
    return true;
  }
  const tier = Object.hasOwn(FOCUS_TIMING_TIERS, category)
    ? FOCUS_TIMING_TIERS[category]
    : undefined;
  return (
    tier !== undefined && candidate.tier === tier && TIERED_FACT_CLASSES.has(candidate.factClass)
  );
}

/**
 * The boost a follow-up focus adds to a fact candidate's class weight.
 *
 * A fact about a focused declaration ranks above everything; a fact answering
 * a focus category ranks above every fact that answers none, and above one
 * answering a less-supported category — the hints arrive best supported first.
 * {@link FOCUS_RANK_STEP} per rank, so each rank dominates the class weights
 * beneath it, and zero without a focus.
 *
 * @param candidate A fact candidate.
 * @param focus The context's focus, if any.
 * @returns The boost; `0` when there is no focus or the candidate answers none of it.
 */
function factFocusBoost(candidate: FactCandidate, focus: FollowUpFocusView | undefined): number {
  if (focus === undefined) {
    return 0;
  }
  const ranks = focus.categories.length;
  if (candidate.factClass === 'focusedDeclaration') {
    return FOCUS_RANK_STEP * (ranks + 1);
  }
  const position = focus.categories.findIndex((category) =>
    factAnswersCategory(candidate, category),
  );
  return position === -1 ? 0 : FOCUS_RANK_STEP * (ranks - position);
}

/**
 * The render statistics a render fact or cause may be about.
 *
 * When the context marks any component as declared by the project, only those
 * are candidates: a framework or library component — often minified, placed
 * only through the project component that rendered it — is not a place a
 * developer can change, however often it rendered, and its count is usually
 * the downstream echo of a project component's renders. A context that says
 * nothing about ownership keeps every statistic.
 *
 * @param renders The capture's render statistics.
 * @returns The candidates, in carried order.
 */
function projectRenders(renders: readonly RenderView[]): readonly RenderView[] {
  const declared = renders.filter((render) => render.declared === true);
  return declared.length > 0 ? declared : renders;
}

/**
 * The share of a component's renders a count covers, bounded to one.
 *
 * @param count Renders of one classification.
 * @param total The component's renders.
 * @returns The share, `0` for a component with no renders.
 */
function renderShare(count: number, total: number): number {
  return total > 0 ? Math.min(1, count / total) : 0;
}

/**
 * How strongly a component's renders point at a changing context: its
 * context-triggered renders weighted by the share of its renders they are.
 *
 * A component that re-rendered thousands of times almost only because of a
 * context outranks both one that rendered as often for other reasons and one
 * whose every render was context-triggered but that rendered twice.
 *
 * @param render One render statistic.
 * @returns The score.
 */
function contextScore(render: RenderView): number {
  return render.contextTriggered * renderShare(render.contextTriggered, render.count);
}

/**
 * How strongly a component's renders point at inputs that did not change,
 * weighted the same way as {@link contextScore}.
 *
 * @param render One render statistic.
 * @returns The score.
 */
function unchangedScore(render: RenderView): number {
  return render.unchanged * renderShare(render.unchanged, render.count);
}

/**
 * The components with context-triggered renders worth reporting, strongest
 * first: {@link contextScore} descending, then the context-triggered count,
 * then the component name, so the order is total.
 *
 * @param renders The candidate statistics.
 * @returns A new, ordered array.
 */
function rankContextConsumers(renders: readonly RenderView[]): RenderView[] {
  return renders
    .filter((render) => render.contextTriggered >= CONTEXT_RENDER_MIN_COUNT)
    .sort((left, right) => {
      const byScore = contextScore(right) - contextScore(left);
      if (byScore !== 0) {
        return byScore;
      }
      if (left.contextTriggered !== right.contextTriggered) {
        return right.contextTriggered - left.contextTriggered;
      }
      return compareStrings(left.component, right.component);
    });
}

/**
 * Whether most of a component's renders were triggered by a changed context.
 *
 * @param render One render statistic.
 * @returns `true` when context-triggered renders are more than half of them.
 */
function isMostlyContextTriggered(render: RenderView): boolean {
  return render.contextTriggered * 2 > render.count;
}

/**
 * The statistic of the component a provider name refers to.
 *
 * Provider names are component display names, the same names the statistics
 * carry. Two statistics of one name (the same component mounted under two
 * identities) resolve to the busier one, then to the first carried, so the
 * answer is deterministic.
 *
 * @param renders Every render statistic of the capture.
 * @param component The display name to find.
 * @returns The statistic, or `undefined` when the capture carries none for it.
 */
function renderOfComponent(
  renders: readonly RenderView[],
  component: string,
): RenderView | undefined {
  let found: RenderView | undefined;
  for (const render of renders) {
    if (render.component === component && (found === undefined || render.count > found.count)) {
      found = render;
    }
  }
  return found;
}

/**
 * The events of a component's renders of one trigger, as references.
 *
 * Renders that name `provider` among their changed contexts come first when
 * any do, so a citation shows the change the sentence names.
 *
 * A render of another trigger never stands in: when the carried renders are
 * classified and none is of `trigger`, nothing is cited, and a sentence left
 * with no evidence is dropped rather than substantiated by renders that
 * contradict it. Only when no carried render reports a classification at all —
 * a context that cannot say which render had which trigger — does the
 * statistic's own evidence (the component's renders) stand in.
 *
 * @param render One render statistic.
 * @param trigger The trigger classification to cite.
 * @param provider A provider the cited renders should name, when there is one.
 * @returns The references, before filtering against the context.
 */
function triggerEvidence(
  render: RenderView,
  trigger: string,
  provider?: string,
): readonly string[] {
  const matching = render.occurrences.filter((occurrence) => occurrence.trigger === trigger);
  const naming =
    provider === undefined
      ? []
      : matching.filter((occurrence) => occurrence.contexts.includes(provider));
  const chosen = naming.length > 0 ? naming : matching;
  if (chosen.length > 0) {
    return chosen.map((occurrence) => occurrence.reference);
  }
  const classified = render.occurrences.some((occurrence) => occurrence.trigger !== undefined);
  return classified ? [] : evidenceOf(render.node);
}

/** The context cascade behind a capture's strongest context-triggered consumer. */
interface ContextCascade {
  /** The project component whose renders most followed a changed context. */
  readonly consumer: RenderView;
  /** The component providing that context, when the capture named it. */
  readonly provider: string | undefined;
  /** The provider's own statistic, when the capture carries one. */
  readonly providerRender: RenderView | undefined;
  /**
   * The component whose state updates the chain traces back to: the first
   * provider up the chain whose renders are state-triggered rather than
   * mostly context-triggered. May be the immediate provider itself.
   */
  readonly origin: RenderView | undefined;
}

/**
 * Follows a capture's strongest context-triggered consumer up its provider
 * chain.
 *
 * The consumer is the first of {@link rankContextConsumers} over the project's
 * components; its provider is the first of its changed contexts. A provider
 * whose renders are mostly context-triggered is itself re-rendered by a
 * context further up, so its own first changed context is followed — at most
 * {@link MAX_CONTEXT_CHAIN_HOPS} statistics, never one twice — until a
 * provider with state-triggered renders is reached. That one is the origin of
 * the changing value. The chain stops, with no origin, at a provider the
 * capture carries no statistic for or one it cannot attribute further.
 *
 * Names are compared only with the names other statistics carry; nothing here
 * knows what any component is called.
 *
 * @param candidates The statistics a consumer may be chosen from.
 * @param renders Every statistic of the capture, providers included.
 * @returns The cascade, or `undefined` when no component has enough
 * context-triggered renders.
 */
function contextCascade(
  candidates: readonly RenderView[],
  renders: readonly RenderView[],
): ContextCascade | undefined {
  const consumer = rankContextConsumers(candidates)[0];
  if (consumer === undefined) {
    return undefined;
  }
  const provider = consumer.changedContexts[0];
  const providerRender = provider === undefined ? undefined : renderOfComponent(renders, provider);
  const visited = new Set<string>([consumer.component]);
  let link = providerRender;
  let origin: RenderView | undefined;
  for (let hop = 0; link !== undefined && hop < MAX_CONTEXT_CHAIN_HOPS; hop += 1) {
    if (visited.has(link.component)) {
      break;
    }
    visited.add(link.component);
    const upstream = link.changedContexts[0];
    if (isMostlyContextTriggered(link) && upstream !== undefined) {
      link = renderOfComponent(renders, upstream);
      continue;
    }
    if (link.stateTriggered > 0) {
      origin = link;
    }
    break;
  }
  return { consumer, provider, providerRender, origin };
}

/** A render statistic and the validated location a cause would suggest for it. */
interface LocatedRender {
  /** The statistic. */
  readonly render: RenderView;
  /** Its declaration. */
  readonly location: SourceLocation;
}

/**
 * The statistic's validated location, paired with it.
 *
 * @param render A statistic, or `undefined`.
 * @returns The pair, or `undefined` when there is no statistic or it is not located.
 */
function locatedRender(render: RenderView | undefined): LocatedRender | undefined {
  const location = render === undefined ? undefined : readSourceLocation(render.node);
  return render === undefined || location === undefined ? undefined : { render, location };
}

/**
 * The location a cascade names: the immediate provider's declaration — where
 * the changing value is built — else the origin's.
 *
 * @param cascade The cascade, when there is one.
 * @returns The located link, or `undefined` when neither link is located.
 */
function cascadeLocation(cascade: ContextCascade | undefined): LocatedRender | undefined {
  return locatedRender(cascade?.providerRender) ?? locatedRender(cascade?.origin);
}

/**
 * The component a capture's context-triggered renders most likely came from.
 *
 * A context value changes only when the component providing it renders with a
 * new value, and a provider renders on its own schedule only when its own hook
 * state changes. So when consumers re-rendered because a consumed context value
 * changed, the component whose own-state updates were each followed by at
 * least {@link CONTEXT_PUBLISHER_MIN_FAN_OUT} such renders is the likely
 * publisher. Among several, the one with the most own-state updates wins, and
 * the component name breaks a tie; only a statistic the capture located can be
 * suggested, because the answer is a place to open, and only one of the
 * project's own components ({@link projectRenders}) when the capture says
 * which those are.
 *
 * Counts only, never names: this is the guess for a capture whose context
 * renders carry no provider names. When they do, {@link contextCascade}
 * follows the names instead and its answer is preferred.
 *
 * @param renders The capture's render statistics.
 * @returns The likely publisher, or `undefined` when the capture shows no
 * context-triggered cascade.
 */
function contextPublisher(renders: readonly RenderView[]): RenderView | undefined {
  const contextRenders = renders.reduce((total, render) => total + render.contextTriggered, 0);
  return [...projectRenders(renders)]
    .filter(
      (render) =>
        render.stateTriggered > 0 &&
        contextRenders >= render.stateTriggered * CONTEXT_PUBLISHER_MIN_FAN_OUT &&
        readSourceLocation(render.node) !== undefined,
    )
    .sort((left, right) =>
      left.stateTriggered === right.stateTriggered
        ? compareStrings(left.component, right.component)
        : right.stateTriggered - left.stateTriggered,
    )[0];
}

/**
 * {@link contextPublisher} with its location, which it always has.
 *
 * @param renders The capture's render statistics.
 * @returns The located publisher, or `undefined` when there is none.
 */
function publisherLocation(renders: readonly RenderView[]): LocatedRender | undefined {
  return locatedRender(contextPublisher(renders));
}

/**
 * Detects the evidence patterns a capture's numbers form.
 *
 * Every detection is numeric: a duplicate group above its threshold, an
 * unchanged-input render count materially above zero, a project component
 * whose renders mostly followed a changed context (with the provider chain the
 * capture attributed), one operation covering most of the measured total, a
 * statement shape repeated within one interaction. Each carries the whole
 * steps of strength its confidence is derived from, so the confidence rule
 * stays monotonic and shared.
 *
 * @param root The structured context.
 * @param reading The metric reading, for the tier totals a detection is weighed against.
 * @param spans The ordered operations of the capture.
 * @param totalMs The interaction's measured total, when there is one.
 * @returns The detections, unordered.
 */
function causeDetections(
  root: JsonObject,
  reading: MetricReading,
  spans: readonly SpanView[],
  totalMs: number | undefined,
): readonly CauseDetection[] {
  const aggregates = aggregatesBag(root);
  const detections: CauseDetection[] = [];

  const duplicate = [...readRequestGroups(aggregates)]
    .filter((group) => group.count >= DUPLICATE_GROUP_MIN_COUNT)
    .sort((left, right) =>
      left.count === right.count
        ? compareStrings(left.endpoint ?? '', right.endpoint ?? '')
        : right.count - left.count,
    )[0];
  if (duplicate !== undefined) {
    const { location } = duplicate;
    const accountedMs = asDurationMs(
      readField(duplicate.node, 'totalDurationMs', 'totalDuration', 'durationMs'),
    );
    detections.push({
      pattern: 'duplicate-requests',
      count: duplicate.count,
      windowMs: duplicate.windowMs,
      callSite: location === undefined ? '' : formatSourceLocation(location),
      steps: duplicate.count - 1,
      references: duplicate.references,
      ...(location !== undefined ? { location } : {}),
      ...(accountedMs !== undefined ? { accountedMs } : {}),
    });
  }

  const renders = readRenders(aggregates);
  const candidates = projectRenders(renders);
  // A cascade is a finding only when most of its consumer's renders followed
  // the context change; a component re-rendered by a context now and then is
  // not one, and its provider is no better a suggestion than the counts' guess.
  const traced = contextCascade(candidates, renders);
  const cascade =
    traced !== undefined && isMostlyContextTriggered(traced.consumer) ? traced : undefined;
  const named = cascadeLocation(cascade);

  const unchanged = [...candidates]
    .filter((render) => render.unchanged >= UNCHANGED_RENDER_MIN_COUNT)
    .sort((left, right) => {
      const byScore = unchangedScore(right) - unchangedScore(left);
      if (byScore !== 0) {
        return byScore;
      }
      return left.unchanged === right.unchanged
        ? compareStrings(left.component, right.component)
        : right.unchanged - left.unchanged;
    })[0];
  const unchangedSteps = unchanged === undefined ? undefined : unchanged.unchanged - 1;
  if (unchanged !== undefined && unchangedSteps !== undefined) {
    // The frame names the consumer whose inputs held; the location points at
    // where the change came from when the capture shows one: the provider the
    // capture named for the strongest context cascade — where the changing
    // value is built — else a component whose own state updates fanned out
    // into context-triggered renders elsewhere, the likely publisher. A
    // developer fixes the publisher, not the consumer.
    const source = named ?? publisherLocation(renders);
    const location = source?.location ?? readSourceLocation(unchanged.node);
    // The component's own renders first, with one render of the suggested
    // component beside them: citations are ordered by id and capped, so an
    // uncapped second list could crowd out every render the sentence counts.
    const references = [
      ...triggerEvidence(unchanged, 'unchanged').slice(
        0,
        source === undefined ? MAX_EVIDENCE_PER_FACT : MAX_EVIDENCE_PER_FACT - 1,
      ),
      ...(source === undefined ? [] : evidenceOf(source.render.node).slice(0, 1)),
    ];
    detections.push({
      pattern: 'unchanged-input-renders',
      component: unchanged.component,
      unchanged: unchanged.unchanged,
      steps: unchangedSteps,
      references: [...new Set(references)],
      ...(location !== undefined ? { location } : {}),
    });
  }

  if (cascade !== undefined) {
    // The consumer is where the renders were counted; the suggestion is the
    // immediate provider's declaration, where the value that keeps changing is
    // built, else the origin's, else the consumer's own. Every link the
    // sentence names cites one of its renders.
    const { consumer, provider, providerRender, origin } = cascade;
    const upstream = origin !== undefined && origin !== providerRender ? origin : undefined;
    const location = named?.location ?? readSourceLocation(consumer.node);
    const providerTrigger =
      providerRender !== undefined && isMostlyContextTriggered(providerRender)
        ? 'context'
        : 'state';
    const references = [
      ...triggerEvidence(consumer, 'context', provider).slice(0, MAX_CONTEXT_CONSUMER_EVIDENCE),
      ...(providerRender === undefined
        ? []
        : triggerEvidence(providerRender, providerTrigger).slice(0, 1)),
      ...(upstream === undefined ? [] : triggerEvidence(upstream, 'state').slice(0, 1)),
    ];
    const steps = consumer.contextTriggered - 1;
    detections.push({
      pattern: 'context-change-renders',
      consumer: consumer.component,
      contextRenders: consumer.contextTriggered,
      ...(provider !== undefined ? { provider } : {}),
      ...(upstream !== undefined ? { origin: upstream.component } : {}),
      steps,
      // The unchanged-input renders a cascade leaves behind are its own
      // downstream renders, so it ranks with them, and ahead of them by
      // precedence, while its confidence stays its own.
      ...(unchangedSteps !== undefined && unchangedSteps > steps
        ? { rankingSteps: unchangedSteps }
        : {}),
      references: [...new Set(references)],
      ...(location !== undefined ? { location } : {}),
    });
  }

  // The longest operation inside the interaction, never its envelope: the
  // interaction's root span or the navigation covers the whole total by
  // construction, and naming it would restate the total as its own cause.
  const dominant = contributingSpans(spans, totalMs)[0];
  if (dominant !== undefined && totalMs !== undefined && totalMs > 0) {
    const share = dominant.duration / totalMs;
    if (share >= DOMINANT_SPAN_MIN_SHARE) {
      const location = readSourceLocation(dominant.node);
      const steps =
        Math.floor(share * DOMINANT_SHARE_STEP_SCALE) -
        Math.floor(DOMINANT_SPAN_MIN_SHARE * DOMINANT_SHARE_STEP_SCALE);
      detections.push({
        pattern: 'dominant-span',
        operation: operationLabel(dominant),
        durationMs: dominant.duration,
        totalMs,
        ...(dominant.tier !== undefined ? { tier: telemetryTierLabel(dominant.tier) } : {}),
        steps,
        references: evidenceOf(dominant.node),
        ...(location !== undefined ? { location } : {}),
        accountedMs: dominant.duration,
      });
    }
  }

  // The costliest repeated shape ({@link compareQueryGroups}), carrying the call
  // site its executions share so the cause can be opened where it happens.
  const repeated = [...readQueryGroups(aggregates)]
    .filter((group) => group.count >= REPEATED_QUERY_MIN_COUNT)
    .sort(compareQueryGroups)[0];
  if (repeated !== undefined) {
    const { location, totalMs: groupMs } = repeated;
    // The frame names the issuing code by its `file:line` label, the contract of
    // `repeatedQueryShapeCause`: a caller record's name is the span the
    // executions ran inside, which need not be the code that issued them.
    const caller = callSiteLabel(location);
    const countSteps = repeated.count - 1;
    // Repetition that cost a negligible share of its tier's time is reported,
    // but never with more than `low` confidence. A statement shape is database
    // work, so it is weighed against the database tier's measured time; only
    // when the capture states none is the interaction's total the yardstick.
    const databaseMs = reading.values.get(DATABASE_DURATION_METRIC);
    const yardstickMs = databaseMs !== undefined && databaseMs > 0 ? databaseMs : totalMs;
    const immaterial =
      groupMs !== undefined &&
      yardstickMs !== undefined &&
      yardstickMs > 0 &&
      groupMs / yardstickMs < REPEATED_QUERY_MATERIAL_SHARE;
    detections.push({
      pattern: 'repeated-query-shape',
      count: repeated.count,
      statement: repeated.statement,
      ...(caller.length > 0 ? { caller } : {}),
      steps: immaterial ? Math.min(countSteps, IMMATERIAL_MAX_STEPS) : countSteps,
      references: evidenceOf(repeated.node),
      ...(location !== undefined ? { location } : {}),
      ...(groupMs !== undefined ? { accountedMs: groupMs } : {}),
    });
  }

  return detections;
}

/**
 * The evidence patterns that answer each focus category, for the order a
 * follow-up focus gives the likely causes ({@link causeFocusBoost}).
 *
 * Keyed by {@link FOCUS_CATEGORIES} and valued in the shared
 * {@link EvidencePattern} vocabulary: a query focus is answered by a repeated
 * statement shape, a request focus by duplicated requests, a render or state
 * focus by the two render patterns, a latency focus by one operation
 * dominating the time. The error and correctness categories name no pattern.
 */
const FOCUS_CAUSE_PATTERNS: Readonly<Record<string, readonly EvidencePattern[]>> = Object.freeze({
  performance: ['dominant-span'],
  data: ['repeated-query-shape'],
  network: ['duplicate-requests'],
  rendering: ['unchanged-input-renders', 'context-change-renders'],
  state: ['unchanged-input-renders', 'context-change-renders'],
  error: [],
  correctness: [],
});

/**
 * Whether a detection is about a focused declaration: suggested at a location
 * inside it ({@link locationInDeclaration}), or, for one operation dominating
 * the time, naming it.
 *
 * @param detection A detected pattern.
 * @param focus The context's focus.
 * @returns `true` when the detection is about one of the focus's declarations.
 */
function detectionInFocusedDeclaration(
  detection: CauseDetection,
  focus: FollowUpFocusView,
): boolean {
  const { location } = detection;
  return focus.declarations.some(
    (declaration) =>
      (location !== undefined && locationInDeclaration(location, declaration)) ||
      (detection.pattern === 'dominant-span' &&
        namesDeclaration(detection.operation, declaration.symbol)),
  );
}

/**
 * The rank a follow-up focus gives a likely cause, ahead of its strength: a
 * cause about a focused declaration first, then causes whose pattern answers a
 * focus category, best-supported category first, then the rest.
 *
 * @param detection A detected pattern.
 * @param focus The context's focus, if any.
 * @returns The rank, higher first; `0` when there is no focus or the cause
 * answers none of it.
 */
function causeFocusBoost(detection: CauseDetection, focus: FollowUpFocusView | undefined): number {
  if (focus === undefined) {
    return 0;
  }
  const ranks = focus.categories.length;
  if (detectionInFocusedDeclaration(detection, focus)) {
    return ranks + 1;
  }
  const position = focus.categories.findIndex((category) =>
    (Object.hasOwn(FOCUS_CAUSE_PATTERNS, category)
      ? (FOCUS_CAUSE_PATTERNS[category] ?? [])
      : []
    ).includes(detection.pattern),
  );
  return position === -1 ? 0 : ranks - position;
}

/**
 * Builds the analysis of a capture from its structured context.
 *
 * Facts first, causes second, and both filtered against the references the
 * context actually carries: a candidate whose references do not survive the
 * filter is dropped rather than emitted with an empty citation list, because a
 * claim nobody can check is exactly what the product's separation of observed
 * facts from inferred causes exists to prevent.
 *
 * A capture that recorded nothing yields a valid analysis with no facts and no
 * causes. That is the honest answer for the
 * "capture yielded nothing" path, and it is why this builder does not fall back
 * to `undefined` for an empty bag: the session has a result, and the result is
 * that there is nothing to report yet.
 *
 * A follow-up that regenerates the analysis carries its structured focus
 * ({@link readFollowUpFocus}). The focus adds one fact per declaration it names
 * that the capture measured, ranks the facts of the classes its categories ask
 * about ahead of the rest ({@link factFocusBoost}), and orders the causes that
 * answer it first ({@link causeFocusBoost}). Every fact still cites evidence
 * the capture carries, and the caps still apply.
 *
 * @param input The structured context of an analyze-stage request.
 * @returns The analysis as plain JSON, or `undefined` when the context is not
 * an object at all.
 */
export function buildAnalysis(input: JsonValue | undefined): JsonValue | undefined {
  const root = asObject(input);
  if (root === undefined) {
    return undefined;
  }

  const reading = readMetrics(root);
  const aggregates = aggregatesBag(root);
  const spans = sortSpans(readSpans(aggregates));
  const totalMs = readTotalDuration(root, reading, spans);
  // A follow-up's structured focus, when one governs this analysis: it adds the
  // facts about the declarations it named and ranks the facts and causes that
  // answer it first. Absent — every first question — it changes nothing.
  const focus = readFollowUpFocus(root);
  // References are harvested from the whole context, and described only from
  // the capture's own event records ({@link describeEvidence}).
  const index = indexEvidence([aggregates, root], aggregates);

  const observed: JsonValue[] = [];
  const ranked = [
    ...factCandidates(root, reading, spans, totalMs),
    ...focusFactCandidates(focus, aggregates, totalMs),
  ].sort((left, right) => {
    const leftWeight = FACT_CLASS_WEIGHTS[left.factClass] + factFocusBoost(left, focus);
    const rightWeight = FACT_CLASS_WEIGHTS[right.factClass] + factFocusBoost(right, focus);
    if (leftWeight !== rightWeight) {
      return rightWeight - leftWeight;
    }
    if (left.magnitude !== right.magnitude) {
      return right.magnitude - left.magnitude;
    }
    return compareStrings(left.statement, right.statement);
  });

  const seenStatements = new Set<string>();
  for (const candidate of ranked) {
    if (observed.length >= MAX_OBSERVED_FACTS) {
      break;
    }
    if (seenStatements.has(candidate.statement)) {
      continue;
    }
    const evidence = citeEvidence(candidate.references, index);
    if (evidence.length === 0) {
      continue;
    }
    seenStatements.add(candidate.statement);
    observed.push({ statement: candidate.statement, evidence });
  }

  // Under a follow-up focus, the causes that answer it lead ({@link
  // causeFocusBoost}); then strongest first; two equally strong causes by the
  // time each accounts for, so the one that cost the interaction more leads,
  // and then by the fixed precedence of their patterns; the statement last,
  // which is unique among the detections because each pattern yields at most
  // one. Without a focus every cause's focus rank is zero, so the order is
  // exactly the unfocused one.
  const likelyCauses: JsonValue[] = [];
  const causes = causeDetections(root, reading, spans, totalMs)
    .map((detection) => ({
      statement: causeStatement(detection),
      focusRank: causeFocusBoost(detection, focus),
      strength: boundedSteps(detection.rankingSteps ?? detection.steps),
      accountedMs: detection.accountedMs ?? 0,
      precedence: CAUSE_PATTERN_PRECEDENCE[detection.pattern],
      confidence: confidenceForSteps(detection.steps),
      evidence: citeEvidence(detection.references, index),
      location: detection.location,
    }))
    .filter((cause) => cause.evidence.length > 0)
    .sort((left, right) => {
      if (left.focusRank !== right.focusRank) {
        return right.focusRank - left.focusRank;
      }
      if (left.strength !== right.strength) {
        return right.strength - left.strength;
      }
      if (left.accountedMs !== right.accountedMs) {
        return right.accountedMs - left.accountedMs;
      }
      if (left.precedence !== right.precedence) {
        return left.precedence - right.precedence;
      }
      return compareStrings(left.statement, right.statement);
    })
    .slice(0, MAX_LIKELY_CAUSES);

  for (const cause of causes) {
    likelyCauses.push({
      statement: cause.statement,
      evidence: cause.evidence,
      confidence: cause.confidence,
      ...(cause.location !== undefined
        ? { suggestedLocation: locationToJson(cause.location) }
        : {}),
    });
  }

  return { observed, likelyCauses };
}

/* -------------------------------------------------------------------------------------------------
 * stage 6 — panel generation
 *
 * The node types of a generated panel come from the node catalog the context
 * carries and from nowhere else. A catalog entry becomes a candidate only when
 * the capture reports material for a source that entry declares.
 *
 * Materiality alone does not make two panels differ, because a real capture
 * populates nearly every source: every render event is also a span of the
 * event log, every commit opens a trace, and a page with a ticking provider
 * renders during a checkout as well as while idle. So the capture is read
 * through one of two **evidence lenses**, chosen from its own numbers
 * ({@link panelLens}):
 *
 * - the **timing** lens — traces, spans, requests and queries — for a capture
 *   whose evidence crossed the network (it holds requests or queries), or
 *   whose measured time is dominated by one operation while no render pattern
 *   was found;
 * - the **component** lens — renders, the component tree, state transitions,
 *   the dependency graph and the event log — for a capture that rendered
 *   without crossing the network.
 *
 * - the **request** lens — the request groups, the render statistics of the
 *   components that issued them, and the requests plotted against the page's
 *   commits on one time axis — for a question about the requests themselves.
 *
 * An entry is emitted only when its *primary* declared source belongs to the
 * active lens, so a latency capture and a rendering capture compose disjoint
 * visualization bodies and share only the metric cards and the source link,
 * whose content is lens-specific too. A detected pattern may admit one further
 * source into the timing lens: duplicated requests bring in the render
 * statistics of the components that issued them.
 *
 * **Which lens.** A classified problem category names its lens
 * ({@link CATEGORY_PROFILES}), so one question is read the same way whatever
 * else its capture happens to hold — a latency question over a capture that
 * rendered on its own schedule is still a latency panel. The category is
 * echoed from the structured context, never derived from prose. When there is
 * no profile, or the category's lens has no material at all in this capture,
 * the lens is chosen from the capture's own numbers ({@link panelLens}).
 * ---------------------------------------------------------------------------------------------- */

/** One node catalog entry, as the context declared it. */
interface CatalogEntryView {
  /** The entry's position in the catalog, which is the primary emission order. */
  readonly index: number;
  /** The node type. */
  readonly type: string;
  /** The data sources the entry declares, in its own preference order. */
  readonly sources: readonly string[];
  /** Whether the entry accepts a query filter. */
  readonly supportsFilter: boolean;
  /** Event kinds the entry declares as its default filter. */
  readonly kinds: readonly string[];
  /** The sort the entry declares, when it declares one. */
  readonly sort?: string;
  /** The result limit the entry declares, when it declares one. */
  readonly limit?: number;
  /** Metric ids the entry permits, when it constrains them. */
  readonly metrics: readonly string[];
  /** Whether the entry is a leaf that carries a location instead of a query. */
  readonly wantsLocation: boolean;
  /**
   * Whether the entry declares no telemetry kinds of its own — neither default
   * filter kinds nor the kinds it is designed around — so it ranks whatever
   * records its source holds. A follow-up focus on a declaration narrows such
   * a view over the flat span list to the work a declaration is measured as
   * ({@link FOCUS_DECLARATION_KINDS}); a view designed around kinds of its own
   * keeps them.
   */
  readonly kindIndifferent: boolean;
}

/**
 * Reads several fields as one list, preserving declaration order.
 *
 * Distinct from {@link readStringSet}, which sorts: a catalog entry's own order
 * *is* the preference this module honours, so it must not be re-ordered on the
 * way in.
 *
 * @param source The object to read.
 * @param fields Field names, in probe order.
 * @returns The distinct strings, first occurrence first.
 */
function readOrderedStrings(
  source: JsonObject | undefined,
  ...fields: readonly string[]
): readonly string[] {
  if (source === undefined) {
    return [];
  }
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    for (const value of asStringArray(source[field])) {
      if (!seen.has(value)) {
        seen.add(value);
        ordered.push(value);
      }
    }
  }
  return ordered;
}

/**
 * Reads the node catalog of a context.
 *
 * Both carriers are accepted: a list of entries, and a map from node type to
 * entry. The map's keys supply the type when an entry does not name itself, and
 * the keys are sorted before they are iterated so a map carrier yields a stable
 * order too.
 *
 * @param root The structured context.
 * @returns The entries, in catalog declaration order.
 */
function readNodeCatalog(root: JsonObject): readonly CatalogEntryView[] {
  const raw: { readonly type: string; readonly entry: JsonObject }[] = [];

  for (const field of ['nodeCatalog', 'catalog', 'nodes', 'nodeTypes']) {
    const list = asObjectArray(root[field]);
    if (list !== undefined && list.length > 0) {
      for (const entry of list) {
        const type = asString(readField(entry, 'type', 'nodeType', 'id', 'name'));
        if (type !== undefined) {
          raw.push({ type, entry });
        }
      }
      if (raw.length > 0) {
        break;
      }
    }

    const map = asObject(root[field]);
    if (map === undefined) {
      continue;
    }
    for (const key of sortedKeys(map)) {
      const entry = asObject(map[key]);
      if (entry === undefined) {
        continue;
      }
      raw.push({ type: asString(readField(entry, 'type', 'nodeType')) ?? key, entry });
    }
    if (raw.length > 0) {
      break;
    }
  }

  return raw.map(({ type, entry }, index) => {
    const sources = readOrderedStrings(entry, 'sources', 'allowedSources', 'dataSources', 'source');
    const filterKeys = readOrderedStrings(entry, 'filters', 'filterKeys', 'filterable');
    const sorts = readOrderedStrings(entry, 'sorts', 'sortOptions', 'allowedSorts');
    const sort = asString(readField(entry, 'defaultSort', 'sort')) ?? sorts[0];
    const limit = asCount(readField(entry, 'defaultLimit', 'limit'));
    const reads = readOrderedStrings(entry, 'reads');
    const declaredLocation = asBoolean(
      readField(entry, 'location', 'requiresLocation', 'carriesLocation'),
    );
    const kinds = readOrderedStrings(entry, 'defaultKinds', 'kinds', 'filterKinds');

    return {
      index,
      type,
      sources,
      supportsFilter: asBoolean(entry.supportsFilter) ?? filterKeys.length > 0,
      kinds,
      ...(sort !== undefined ? { sort } : {}),
      ...(limit !== undefined ? { limit } : {}),
      metrics: readOrderedStrings(entry, 'metrics', 'metricIds', 'allowedMetrics'),
      wantsLocation:
        declaredLocation === true ||
        (sources.length === 0 && (reads.includes('source') || reads.includes('location'))),
      kindIndifferent:
        kinds.length === 0 && readOrderedStrings(entry, 'telemetryKinds').length === 0,
    };
  });
}

/**
 * The evidence lens a panel is composed through; see the section comment.
 */
type PanelLens = 'timing' | 'component' | 'requests';

/**
 * The lenses each known data source belongs to.
 *
 * The metrics source belongs to none — the metric-card node is shared, and its
 * *content* is what the lens selects ({@link METRIC_LENSES}). The request
 * groups belong to the timing lens and the request lens alike, and the render
 * statistics to the component lens and the request lens, whose initiating
 * components they are. A source this table does not know belongs to every
 * lens, so a catalog that grows a source is still served by whichever lens is
 * active instead of being silently dropped.
 */
const SOURCE_LENSES: Readonly<Record<string, readonly PanelLens[]>> = Object.freeze({
  trace: ['timing'],
  spans: ['timing'],
  requests: ['timing', 'requests'],
  queries: ['timing'],
  renders: ['component', 'requests'],
  componentTree: ['component'],
  stateTransitions: ['component'],
  graph: ['component'],
  events: ['component'],
});

/**
 * The lenses each computed metric belongs to, so the cards of a timing panel
 * measure time and traffic, the cards of a component panel measure rendering
 * and main-thread work (the four duration cards against `render_count`,
 * `unchanged_render_count`, `render_trigger_unknown_count` and
 * `blocking_time`), and the cards of a request panel count the requests, their
 * duplicates, their bytes and their failures. Keyed by {@link ComputedMetricId}
 * and therefore total: a metric added to the computed tuple without a lens is a
 * compile error.
 */
const METRIC_LENSES: Readonly<Record<ComputedMetricId, readonly PanelLens[]>> = Object.freeze({
  total_duration: ['timing'],
  frontend_duration: ['timing'],
  backend_duration: ['timing'],
  database_duration: ['timing'],
  render_count: ['component'],
  unchanged_render_count: ['component'],
  render_trigger_unknown_count: ['component'],
  request_count: ['timing', 'requests'],
  query_count: ['timing'],
  transferred_bytes: ['timing', 'requests'],
  blocking_time: ['component'],
  duplicate_request_count: ['timing', 'requests'],
  long_task_count: ['component'],
  error_count: ['timing', 'requests'],
});

/**
 * Whether a computed metric is measured by the cards of a lens.
 *
 * @param id A computed metric id.
 * @param lens The active lens.
 * @returns `true` when the metric belongs to the lens.
 */
function metricInLens(id: ComputedMetricId, lens: PanelLens): boolean {
  return METRIC_LENSES[id].includes(lens);
}

/**
 * The event kinds a lens narrows a node over each source to, before the kinds
 * are narrowed again to what the capture reports.
 *
 * The component lens reads the event log as the render and state record the
 * render views summarise, so the log shows the evidence beneath them rather
 * than every request and paint of the capture. A source absent here is not
 * narrowed by the lens.
 */
const LENS_SOURCE_KINDS: Readonly<Record<PanelLens, Readonly<Record<string, readonly string[]>>>> =
  Object.freeze({
    timing: Object.freeze({}),
    component: Object.freeze({ events: ['render', 'state'] }),
    requests: Object.freeze({}),
  });

/**
 * The event kinds a lens draws a trace-shaped view over as one flat time axis,
 * for a lens whose evidence spans many traces.
 *
 * A request panel is about requests an interaction did *not* cause alone — a
 * refetch loop, a double mount — so no single correlated trace holds them, and
 * a view designed around one trace would show whichever trace happened to be
 * the capture's longest. Such a view is drawn instead over the flat span list
 * of the requests and the page's commits, in start order: the requests plotted
 * against the renders that issued them. Commits rather than component renders,
 * because one commit stands for every render of a pass and so keeps the axis
 * readable however many components re-rendered. Only a view that declares the
 * flat `spans` source as its alternative is drawn this way; one that can read
 * nothing but a trace tree is left out.
 */
const LENS_FLAT_TRACE_KINDS: Readonly<Partial<Record<PanelLens, readonly string[]>>> =
  Object.freeze({
    requests: ['fetch', 'xhr', 'commit'],
  });

/** The source a trace-shaped view reads when a lens flattens it. */
const FLAT_TRACE_SOURCE = 'spans';

/** The source whose unit is a correlated trace. */
const TRACE_SOURCE = 'trace';

/** The order a flattened trace view lists its spans in: start order, as on a time axis. */
const FLAT_TRACE_SORT = 'start_asc';

/**
 * Sources a detected pattern admits into the lens it is read through, beyond
 * the lens's own. Duplicated requests are issued by components, so their panel
 * also shows the render statistics of the initiators. Keyed by
 * {@link EvidencePattern}, so a new pattern without an entry is a compile
 * error.
 */
const PATTERN_ADMITTED_SOURCES: Readonly<Record<EvidencePattern, readonly string[]>> =
  Object.freeze({
    'duplicate-requests': ['renders'],
    'unchanged-input-renders': [],
    'dominant-span': [],
    'repeated-query-shape': [],
    'context-change-renders': [],
  });

/** The aggregate fields a leaf's location is read from under each lens, in probe order. */
const LENS_LOCATION_FIELDS: Readonly<Record<PanelLens, readonly string[]>> = Object.freeze({
  timing: ['spans', 'topSpans', 'queries', 'requests'],
  component: ['renders', 'stateTransitions'],
  requests: ['requests', 'renders'],
});

/**
 * The lens a capture is read through.
 *
 * The component lens when the capture rendered — its render, component-tree
 * or state-transition source is material — without crossing the network — no
 * request and no query is material — and without one operation dominating its
 * measured time while no render pattern was found; the timing lens otherwise,
 * including for a capture with no material at all.
 *
 * @param counts The per-source counts of the context.
 * @param patterns The evidence patterns the capture exhibits.
 * @returns The lens.
 */
function panelLens(
  counts: ReadonlyMap<string, number>,
  patterns: readonly EvidencePattern[],
): PanelLens {
  const crossedNetwork =
    isMaterialSource('requests', counts) || isMaterialSource('queries', counts);
  const rendered =
    isMaterialSource('renders', counts) ||
    isMaterialSource('componentTree', counts) ||
    isMaterialSource('stateTransitions', counts);
  const timingDominates =
    patterns.includes('dominant-span') &&
    !patterns.includes('unchanged-input-renders') &&
    !patterns.includes('context-change-renders');
  return rendered && !crossedNetwork && !timingDominates ? 'component' : 'timing';
}

/**
 * Whether a lens has anything of its own to show in this capture: a source
 * that belongs to it, other than the shared metrics, is material.
 *
 * @param lens A lens.
 * @param counts The per-source counts of the context.
 * @returns `true` when at least one of the lens's sources is material.
 */
function lensHasMaterial(lens: PanelLens, counts: ReadonlyMap<string, number>): boolean {
  for (const source of sortStrings(Object.keys(SOURCE_LENSES))) {
    if (SOURCE_LENSES[source]?.includes(lens) === true && isMaterialSource(source, counts)) {
      return true;
    }
  }
  return false;
}

/**
 * The lens a panel is composed through: the one its classified category names,
 * while that lens has material in the capture; otherwise the one the capture's
 * own numbers select ({@link panelLens}).
 *
 * @param category The category the context carried, if any.
 * @param counts The per-source counts of the context.
 * @param patterns The evidence patterns the capture exhibits.
 * @returns The lens.
 */
function composedLens(
  category: string | undefined,
  counts: ReadonlyMap<string, number>,
  patterns: readonly EvidencePattern[],
): PanelLens {
  const named = categoryProfile(category)?.lens;
  if (named !== undefined && lensHasMaterial(named, counts)) {
    return named;
  }
  return panelLens(counts, patterns);
}

/**
 * Whether a data source may feed a node under the active lens.
 *
 * @param source A data source name from a catalog entry.
 * @param lens The active lens.
 * @param admitted Sources the detected patterns admit in addition.
 * @returns `true` when the source is the lens's own, admitted, or unknown here.
 */
function lensAdmits(source: string, lens: PanelLens, admitted: ReadonlySet<string>): boolean {
  // An own-property read: a catalog is context data, and a source spelled like
  // an inherited member must read as unknown rather than reach the prototype.
  const owners = Object.hasOwn(SOURCE_LENSES, source) ? SOURCE_LENSES[source] : undefined;
  return owners === undefined || owners.includes(lens) || admitted.has(source);
}

/**
 * The key two locations share when they name the same line of the same file.
 *
 * @param location A validated location.
 * @returns `file:line`.
 */
function locationLineKey(location: SourceLocation): string {
  return `${location.file}:${String(location.line)}`;
}

/**
 * Event kinds that record component work rather than time spent elsewhere.
 *
 * A capture's slowest-operation list is kind-indifferent, so it can hold a
 * render — a provider's render measures its whole subtree and is often the
 * longest one. Such a row is evidence for the component lens, never timing
 * evidence, which is what {@link timingLocatedNodes} excludes it for.
 */
const COMPONENT_WORK_KINDS: ReadonlySet<string> = new Set(['render', 'commit', 'state']);

/**
 * Differently-named operations located at one line before that line counts as
 * a shared helper rather than the site of any one of them.
 *
 * A request helper that every call of an application routes through is where
 * each of those calls is located when a resolver stops at the innermost
 * project frame, so its line is shared by operations with different names —
 * different endpoints, different statements. Sending a developer there sends
 * them to plumbing, not to the operation that took the time.
 */
const SHARED_HELPER_MIN_OPERATIONS = 2;

/** One located node of the timing lens's aggregates. */
interface TimingLocatedNode {
  /** Where it is. */
  readonly location: SourceLocation;
  /** The operation it names: its name, statement or address; empty when it names none. */
  readonly name: string;
}

/**
 * The located nodes of the timing lens's aggregates, in probe order: every
 * operation, query and request the context carries a location for, except
 * operations of a {@link COMPONENT_WORK_KINDS} kind.
 *
 * @param aggregates The capture-aggregate bag.
 * @returns The located nodes, first probed first.
 */
function timingLocatedNodes(aggregates: JsonObject): readonly TimingLocatedNode[] {
  const located: TimingLocatedNode[] = [];
  for (const field of LENS_LOCATION_FIELDS.timing) {
    for (const node of asObjectArray(aggregates[field]) ?? []) {
      const kind = asString(node.kind);
      if (kind !== undefined && COMPONENT_WORK_KINDS.has(kind)) {
        continue;
      }
      const location = readSourceLocation(node);
      if (location !== undefined) {
        const name =
          asString(
            readField(node, 'name', 'operation', 'label', 'statement', 'url', 'endpoint', 'path'),
          ) ?? '';
        located.push({ location, name });
      }
    }
  }
  return located;
}

/**
 * The lines the capture's timing evidence is located at.
 *
 * @param aggregates The capture-aggregate bag.
 * @returns The `file:line` keys of {@link timingLocatedNodes}.
 */
function timingEvidenceLines(aggregates: JsonObject): ReadonlySet<string> {
  return new Set(timingLocatedNodes(aggregates).map((node) => locationLineKey(node.location)));
}

/**
 * The lines {@link SHARED_HELPER_MIN_OPERATIONS} or more differently-named
 * operations are located at. Unnamed nodes are not counted: nothing says they
 * are different operations.
 *
 * @param nodes The located nodes of the timing lens.
 * @returns The `file:line` keys of shared helpers.
 */
function sharedHelperLines(nodes: readonly TimingLocatedNode[]): ReadonlySet<string> {
  const namesByLine = new Map<string, Set<string>>();
  for (const node of nodes) {
    if (node.name.length === 0) {
      continue;
    }
    const key = locationLineKey(node.location);
    const names = namesByLine.get(key) ?? new Set<string>();
    names.add(node.name);
    namesByLine.set(key, names);
  }
  const shared = new Set<string>();
  for (const [key, names] of namesByLine) {
    if (names.size >= SHARED_HELPER_MIN_OPERATIONS) {
      shared.add(key);
    }
  }
  return shared;
}

/**
 * The location a timing panel falls back to when no cause supplied one: the
 * first located timing node that is not a shared helper
 * ({@link sharedHelperLines}), else the first located timing node.
 *
 * @param aggregates The capture-aggregate bag.
 * @returns The location, or `undefined` when no timing node is located.
 */
function timingFallbackLocation(aggregates: JsonObject): SourceLocation | undefined {
  const nodes = timingLocatedNodes(aggregates);
  const shared = sharedHelperLines(nodes);
  const own = nodes.find((node) => !shared.has(locationLineKey(node.location)));
  return (own ?? nodes[0])?.location;
}

/**
 * The lens a suggested location belongs to.
 *
 * A location the capture's timing evidence corroborates — a located
 * operation, query or request sits on the same line — is about timing; any
 * other suggestion is about what the capture rendered. Corroboration rather
 * than a name match, because the context lists only the most-rendered
 * components while a cause may point at a component that rendered rarely —
 * the publisher of a context value, for instance.
 *
 * @param location The suggested location.
 * @param timingLines The lines {@link timingEvidenceLines} reports.
 * @returns The lens.
 */
function locationLens(location: SourceLocation, timingLines: ReadonlySet<string>): PanelLens {
  return timingLines.has(locationLineKey(location)) ? 'timing' : 'component';
}

/**
 * The lens a likely cause belongs to.
 *
 * The kinds of the events it cites decide first, because they say what the
 * cause is about whatever the panel context happens to locate: a cause citing
 * a query, a request or a server span is about timing, and one citing only
 * renders, commits and state updates is about component work. The panel
 * context's query and request rows carry no location, so a cause located at a
 * statement's call site would find nothing to corroborate it and would read as
 * a component cause. A cause that cites no kind — the model path may omit one —
 * is classified by line corroboration ({@link locationLens}). Only kinds of the
 * product's vocabulary ({@link EVIDENCE_REF_KINDS}) count.
 *
 * @param cause The likely-cause record from the analysis.
 * @param location Its validated suggested location.
 * @param timingLines The lines {@link timingEvidenceLines} reports.
 * @returns The lens.
 */
function causeLens(
  cause: JsonObject,
  location: SourceLocation,
  timingLines: ReadonlySet<string>,
): PanelLens {
  const kinds: string[] = [];
  for (const reference of asObjectArray(cause['evidence']) ?? []) {
    const kind = asString(reference['kind']);
    if (kind !== undefined && EVIDENCE_REF_KINDS.has(kind)) {
      kinds.push(kind);
    }
  }
  if (kinds.length === 0) {
    return locationLens(location, timingLines);
  }
  return kinds.every((kind) => COMPONENT_WORK_KINDS.has(kind)) ? 'component' : 'timing';
}

/**
 * The location a leaf node would point at, when the context supplies a usable
 * one for the active lens.
 *
 * The analysis is asked first, because a location it suggested has already been
 * chosen as the most useful place to send a developer — but only a location of
 * the lens the panel is composed through, so a latency panel never sends the
 * developer to a component that merely re-rendered during the interaction and a
 * rendering panel never to a query. A cause's lens is read from the kinds of
 * the events it cites ({@link causeLens}), and the first cause in the
 * analysis's own order whose lens the panel admits supplies the location: the
 * active lens, or a lens whose sources a detected pattern admits
 * ({@link PATTERN_ADMITTED_SOURCES}) — repeated identical requests admit the
 * component work that initiates them, so the panel for that pattern follows
 * its own leading cause to the initiating code rather than passing it over for
 * a lesser one. Failing that, the lens's own aggregates are read in a fixed
 * order so the answer does not depend on which bag happened to be probed
 * first, and a timing panel passes over a shared helper's line for an
 * operation's own ({@link timingFallbackLocation}).
 *
 * @param root The structured context.
 * @param lens The active lens.
 * @param admitted Sources the detected patterns admit in addition to the lens's own.
 * @returns The validated location, or `undefined`.
 */
function readSuggestedLocation(
  root: JsonObject,
  lens: PanelLens,
  admitted: ReadonlySet<string>,
): SourceLocation | undefined {
  const aggregates = aggregatesBag(root);
  const timingLines = timingEvidenceLines(aggregates);
  const admittedLenses = new Set<PanelLens>([lens]);
  for (const source of admitted) {
    const owners = Object.hasOwn(SOURCE_LENSES, source) ? SOURCE_LENSES[source] : undefined;
    for (const owner of owners ?? []) {
      admittedLenses.add(owner);
    }
  }

  const analysis = analysisBag(root);
  for (const cause of asObjectArray(readField(analysis ?? root, 'likelyCauses', 'causes')) ?? []) {
    const location = readSourceLocation(cause);
    // A request panel spans both halves — the call site of a request and the
    // component that issued it — so any located cause is its own.
    if (
      location !== undefined &&
      (lens === 'requests' || admittedLenses.has(causeLens(cause, location, timingLines)))
    ) {
      return location;
    }
  }

  if (lens === 'timing') {
    return timingFallbackLocation(aggregates);
  }
  for (const field of LENS_LOCATION_FIELDS[lens]) {
    for (const node of asObjectArray(aggregates[field]) ?? []) {
      const location = readSourceLocation(node);
      if (location !== undefined) {
        return location;
      }
    }
  }
  return undefined;
}

/**
 * The metrics that quantify each evidence pattern, keyed by the pattern.
 *
 * A pattern the capture exhibits is shown on the cards by its own
 * measurements: repeated identical requests by the request and duplicate
 * counts, renders with unchanged inputs by the render counts that qualify them
 * (the undetermined-trigger count is the complement that keeps "unchanged"
 * honest), a repeated statement shape by the query count and database time,
 * a dominant operation by the total it dominates, and a context cascade by the
 * render count with its undetermined-trigger complement. Keyed by the shared
 * {@link EvidencePattern} vocabulary so a new pattern without an entry is a
 * compile error.
 */
const PATTERN_METRIC_IDS: Readonly<Record<EvidencePattern, readonly ComputedMetricId[]>> =
  Object.freeze({
    'duplicate-requests': ['request_count', 'duplicate_request_count'],
    'unchanged-input-renders': [
      'render_count',
      'unchanged_render_count',
      'render_trigger_unknown_count',
    ],
    'repeated-query-shape': ['query_count', 'database_duration'],
    'dominant-span': ['total_duration'],
    'context-change-renders': ['render_count', 'render_trigger_unknown_count'],
  });

/**
 * The metric ids a card node should name.
 *
 * Only the active lens's metrics ({@link METRIC_LENSES}) are candidates. The
 * first {@link MAX_METRIC_CARDS} reported ones of {@link COMPUTED_METRIC_IDS}
 * — intersected with the entry's own constraint where it declares one — are
 * the headline row, in the tuple's order. Every further reported candidate
 * that quantifies an evidence pattern the capture exhibits follows, still in
 * the tuple's order, so a finding is never crowded out of its own cards by the
 * headline: a capture of duplicated requests shows its request counts, one of
 * unchanged renders its render counts, whatever the tuple puts first. Identical
 * captures give identical rows, and a metric the capture did not report is
 * never named: an empty card is not evidence.
 *
 * Under a follow-up focus the metrics that measure it ({@link focusMetricIds})
 * lead the row, in the focus's order, and the headline row is chosen from that
 * reordered list, so a query focus opens on the query count and the database
 * time whatever the tuple puts first. Without one the row is the tuple's.
 *
 * @param entry The catalog entry for the card node.
 * @param reading The metric reading.
 * @param patterns The evidence patterns the capture exhibits.
 * @param lens The active lens.
 * @param focusMetrics The metrics a follow-up focus asks about, first; empty
 * without a focus.
 * @returns The metric ids.
 */
function metricCardIds(
  entry: CatalogEntryView,
  reading: MetricReading,
  patterns: readonly EvidencePattern[],
  lens: PanelLens,
  focusMetrics: readonly ComputedMetricId[] = [],
): readonly string[] {
  const permitted = new Set(entry.metrics);
  const reported = focusFirst(
    COMPUTED_METRIC_IDS.filter(
      (id) =>
        metricInLens(id, lens) &&
        reading.values.has(id) &&
        (permitted.size === 0 || permitted.has(id)),
    ),
    focusMetrics,
  );
  const chosen = new Set<string>(reported.slice(0, MAX_METRIC_CARDS));
  const quantifying = new Set<string>(patterns.flatMap((pattern) => PATTERN_METRIC_IDS[pattern]));
  return reported.filter((id) => chosen.has(id) || quantifying.has(id));
}

/**
 * A list reordered so the members a focus names come first, in the focus's
 * order, and every other member follows in its own order.
 *
 * @param items The list, in its own order.
 * @param focused The members to lead with, in their order; empty keeps `items` as it is.
 * @returns A new list holding exactly the members of `items`.
 */
function focusFirst<T>(items: readonly T[], focused: readonly T[]): T[] {
  if (focused.length === 0) {
    return [...items];
  }
  const leading = [...new Set(focused)].filter((item) => items.includes(item));
  return [...leading, ...items.filter((item) => !leading.includes(item))];
}

/**
 * The event kinds a node's filter should name.
 *
 * The entry's declared kinds, narrowed to the kinds the capture reports when it
 * reports them. Both halves come from the structured context: this module never
 * invents a kind, and a filter naming a kind the capture has none of would show
 * an empty view.
 *
 * @param entry The catalog entry.
 * @param root The structured context.
 * @returns The kinds, ordered and capped.
 */
function filterKindsFor(entry: CatalogEntryView, root: JsonObject): readonly string[] {
  return reportedKindsAmong(entry.kinds, root);
}

/**
 * The members of a list of event kinds the capture reports, in the list's
 * order and capped; the whole list when the capture reports no kinds at all,
 * because a context that tallies nothing has not said the kinds are absent.
 *
 * @param kinds Candidate kinds, in preference order.
 * @param root The structured context.
 * @returns The reported kinds, ordered and capped; empty for an empty list.
 */
function reportedKindsAmong(kinds: readonly string[], root: JsonObject): readonly string[] {
  if (kinds.length === 0) {
    return [];
  }
  const aggregates = aggregatesBag(root);
  const reported = new Set<string>(readStringSet(aggregates, 'kinds', 'eventKinds'));
  const kindCounts = readObjectField(aggregates, 'kindCounts', 'countsByKind');
  if (kindCounts !== undefined) {
    for (const key of sortedKeys(kindCounts)) {
      const count = asCount(kindCounts[key]);
      if (count !== undefined && count > 0) {
        reported.add(key);
      }
    }
  }

  const narrowed = reported.size === 0 ? kinds : kinds.filter((kind) => reported.has(kind));
  return narrowed.slice(0, MAX_FILTER_KINDS);
}

/**
 * The tiers a capture recorded nothing in, when it reports per-tier counts.
 *
 * Read from the aggregates' `tierCounts` tally — the one field that says a tier
 * is *absent* rather than merely unmentioned. A context without the tally
 * reports no silent tier, because silence about a tier is not evidence that it
 * was silent.
 *
 * @param root The structured context.
 * @returns The silent tiers, in {@link TIER_DURATION_METRICS} order.
 */
function silentTiers(root: JsonObject): readonly string[] {
  const tally = readObjectField(aggregatesBag(root), 'tierCounts', 'countsByTier');
  if (tally === undefined) {
    return [];
  }
  const silent: string[] = [];
  for (const tier of Object.keys(TIER_DURATION_METRICS)) {
    const count = asCount(tally[tier]);
    if (count !== undefined && count === 0) {
      silent.push(tier);
    }
  }
  return silent;
}

/**
 * The kinds a lens narrows a source to ({@link LENS_SOURCE_KINDS}).
 *
 * @param lens The active lens.
 * @param source A data source name from a catalog entry.
 * @returns The lens's kinds for the source; empty when the lens does not narrow it.
 */
function lensKindsFor(lens: PanelLens, source: string): readonly string[] {
  const bySource = LENS_SOURCE_KINDS[lens];
  // An own-property read, for the reason given at `lensAdmits`.
  return Object.hasOwn(bySource, source) ? (bySource[source] ?? []) : [];
}

/**
 * A trace-shaped view drawn over the flat span list of a lens's kinds, or
 * `undefined` when the entry cannot read the flat list or the capture holds
 * none of those kinds.
 *
 * The node carries the kinds the capture reports among the lens's own — never
 * a trace filter, since the point is to span every trace — and the start
 * order a time axis reads in, with the entry's declared limit when it has one.
 *
 * @param entry A catalog entry whose primary source is the trace.
 * @param kinds The lens's flat-axis kinds ({@link LENS_FLAT_TRACE_KINDS}).
 * @param counts The per-source counts of the context.
 * @param root The structured context.
 * @returns The authored node, or `undefined`.
 */
function flatTraceNode(
  entry: CatalogEntryView,
  kinds: readonly string[],
  counts: ReadonlyMap<string, number>,
  root: JsonObject,
): JsonObject | undefined {
  if (!entry.sources.includes(FLAT_TRACE_SOURCE) || !isMaterialSource(FLAT_TRACE_SOURCE, counts)) {
    return undefined;
  }
  const reported = reportedKindsAmong(kinds, root);
  if (reported.length === 0) {
    return undefined;
  }
  return {
    type: entry.type,
    source: FLAT_TRACE_SOURCE,
    filter: { kinds: [...reported] },
    sort: FLAT_TRACE_SORT,
    ...(entry.limit !== undefined ? { limit: entry.limit } : {}),
  };
}

/* -------------------------------------------------------------------------------------------------
 * stage 6 — a follow-up's focus composes the panel it regenerates
 *
 * A follow-up that regenerates a panel from a capture ({@link readFollowUpFocus})
 * asks something narrower than the session's question, so its panel is
 * composed for that: through the focus category's lens while that lens has
 * material; with the views over the focus's own sources first; with the
 * metrics that measure the focus leading the cards and the headline; titled by
 * the focus; and with the headline naming it. A focus on a declaration also
 * narrows the span ranking to the work a declaration is measured as, draws the
 * trace views over the interaction that holds its slowest run, and points the
 * source link at where that run was recorded. Everything is read from the
 * focus's structure and the capture — nothing from any wording.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The data sources whose views answer each focus category first, in order.
 *
 * Keyed by {@link FOCUS_CATEGORIES}: a query focus is answered by the query
 * groups, a request focus by the request groups, a render focus by the render
 * statistics and the component tree, a state focus by the state transitions,
 * a latency focus by the correlated trace and the span list. The error and
 * correctness categories name no source of their own.
 */
const FOCUS_CATEGORY_SOURCES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  performance: ['trace', 'spans'],
  data: ['queries'],
  network: ['requests'],
  rendering: ['renders', 'componentTree'],
  state: ['stateTransitions'],
  error: [],
  correctness: [],
});

/**
 * The data sources whose views answer a focus on declarations first: the span
 * list the declaration's runs are rows of, then the trace they sit in.
 */
const FOCUS_DECLARATION_SOURCES: readonly string[] = Object.freeze([
  FLAT_TRACE_SOURCE,
  TRACE_SOURCE,
]);

/**
 * The telemetry kinds a named declaration's work is recorded as: a timed
 * function, a route handler, and the statements it issues. Product vocabulary,
 * restated from `@debuggen/telemetry`'s kind list with the others in
 * {@link EVIDENCE_REF_KINDS}.
 */
const FOCUS_DECLARATION_KINDS: readonly string[] = Object.freeze([
  'function',
  'route.handler',
  'db.query',
]);

/** The order a span ranking focused on a declaration lists its rows in: longest first. */
const FOCUS_DECLARATION_SORT = 'duration_desc';

/**
 * The computed metrics that measure each focus category, in the order its
 * cards and headline lead with them.
 */
const FOCUS_METRIC_IDS: Readonly<Record<string, readonly ComputedMetricId[]>> = Object.freeze({
  performance: ['total_duration', 'frontend_duration', 'backend_duration', 'database_duration'],
  data: ['query_count', 'database_duration'],
  network: ['request_count', 'duplicate_request_count', 'transferred_bytes'],
  rendering: ['render_count', 'unchanged_render_count', 'render_trigger_unknown_count'],
  state: ['render_count', 'unchanged_render_count'],
  error: ['error_count'],
  correctness: [],
});

/**
 * An own-property read of a table keyed by {@link FOCUS_CATEGORIES}.
 *
 * @param table The table.
 * @param category A focus category.
 * @returns The category's entry, or an empty list.
 */
function focusTableEntry<T>(
  table: Readonly<Record<string, readonly T[]>>,
  category: string,
): readonly T[] {
  return Object.hasOwn(table, category) ? (table[category] ?? []) : [];
}

/**
 * The metrics a focus asks about, best-supported category first, without
 * repeats.
 *
 * @param focus The context's focus, if any.
 * @returns The metric ids; empty without a focus.
 */
function focusMetricIds(focus: FollowUpFocusView | undefined): readonly ComputedMetricId[] {
  const ids: ComputedMetricId[] = [];
  for (const category of focus?.categories ?? []) {
    for (const id of focusTableEntry(FOCUS_METRIC_IDS, category)) {
      if (!ids.includes(id)) {
        ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * The lens a panel is composed through under a follow-up focus: the leading
 * focus category's lens while the capture holds material for that category;
 * otherwise, and always without a focus category, the lens the session would
 * be composed through ({@link composedLens}).
 *
 * A category that names sources of its own ({@link FOCUS_CATEGORY_SOURCES})
 * has material when one of them does — a render focus over a capture that
 * rendered nothing has nothing to show through the component lens, however
 * many events and graph nodes that lens could otherwise draw, so the session's
 * lens is kept. A category that names none has material when its lens does.
 *
 * A focus identical in effect to the session — the same category — therefore
 * keeps the session's lens, which is the honest answer: the question is the
 * same class of question.
 *
 * @param focus The context's focus, if any.
 * @param category The session's classified category, if any.
 * @param counts The per-source counts of the context.
 * @param patterns The evidence patterns the capture exhibits.
 * @returns The lens.
 */
function focusedLens(
  focus: FollowUpFocusView | undefined,
  category: string | undefined,
  counts: ReadonlyMap<string, number>,
  patterns: readonly EvidencePattern[],
): PanelLens {
  const leading = leadingFocusCategory(focus);
  const named = leading === undefined ? undefined : categoryProfile(leading)?.lens;
  if (leading !== undefined && named !== undefined) {
    const own = focusTableEntry(FOCUS_CATEGORY_SOURCES, leading);
    const material =
      own.length > 0
        ? own.some((source) => isMaterialSource(source, counts))
        : lensHasMaterial(named, counts);
    if (material) {
      return named;
    }
  }
  return composedLens(category, counts, patterns);
}

/**
 * The catalog, reordered so the entries designed around the focus's own
 * sources come first.
 *
 * The sources a focus leads with are the declaration sources when it names a
 * declaration ({@link FOCUS_DECLARATION_SOURCES}), then each category's own
 * ({@link FOCUS_CATEGORY_SOURCES}), best-supported first. An entry ranks by
 * the position of its primary source — the one it is designed around — in
 * that list; entries of equal rank, and every entry the focus does not rank,
 * keep the catalog's order, so the reordering is stable and total.
 *
 * @param catalog The catalog, in its own order.
 * @param focus The context's focus, if any.
 * @returns The catalog in layout order; unchanged without a focus.
 */
function focusOrderedCatalog(
  catalog: readonly CatalogEntryView[],
  focus: FollowUpFocusView | undefined,
): readonly CatalogEntryView[] {
  if (focus === undefined) {
    return catalog;
  }
  const leading: string[] = [];
  for (const source of [
    ...(focus.declarations.length > 0 ? FOCUS_DECLARATION_SOURCES : []),
    ...focus.categories.flatMap((category) => focusTableEntry(FOCUS_CATEGORY_SOURCES, category)),
  ]) {
    if (!leading.includes(source)) {
      leading.push(source);
    }
  }
  const rankOf = (entry: CatalogEntryView): number => {
    const position = entry.sources[0] === undefined ? -1 : leading.indexOf(entry.sources[0]);
    return position === -1 ? leading.length : position;
  };
  return catalog
    .map((entry, order) => ({ entry, order, rank: rankOf(entry) }))
    .sort((left, right) =>
      left.rank === right.rank ? left.order - right.order : left.rank - right.rank,
    )
    .map(({ entry }) => entry);
}

/** What a panel reads from the declarations a follow-up focused on. */
interface DeclarationFocusView {
  /** Whether the focus names a declaration at all. */
  readonly named: boolean;
  /** Whether the capture measured any of them. */
  readonly measured: boolean;
  /** The trace holding the slowest measured run, when the capture names a usable one. */
  readonly traceId?: string;
  /** Where the slowest located run was recorded, when the capture located one. */
  readonly location?: SourceLocation;
}

/**
 * What the capture holds of the declarations a focus names, for the panel.
 *
 * The trace and the location are those of the first focused declaration, in
 * the focus's order, whose runs supply one — its longest run's first — so a
 * trace view narrowed to it shows the interaction where that declaration took
 * the most time. A trace identifier is used only when it is well formed
 * ({@link isTraceId}): a filter naming an identifier that cannot exist selects
 * nothing.
 *
 * @param focus The context's focus, if any.
 * @param aggregates The capture-aggregate bag.
 * @returns The view; nothing named without a focus on declarations.
 */
function declarationFocus(
  focus: FollowUpFocusView | undefined,
  aggregates: JsonObject,
): DeclarationFocusView {
  if (focus === undefined || focus.declarations.length === 0) {
    return { named: false, measured: false };
  }
  const measurements = focusedMeasurements(focus, aggregates);
  let traceId: string | undefined;
  let location: SourceLocation | undefined;
  for (const measurement of measurements) {
    for (const span of measurement.spans) {
      if (traceId === undefined) {
        const candidate = asString(span.node['traceId']);
        if (candidate !== undefined && isTraceId(candidate)) {
          traceId = candidate;
        }
      }
      location ??= readSourceLocation(span.node);
    }
  }
  return {
    named: true,
    measured: measurements.length > 0,
    ...(traceId !== undefined ? { traceId } : {}),
    ...(location !== undefined ? { location } : {}),
  };
}

/**
 * What a panel under a follow-up focus is titled and headlined by: the
 * declarations it names ({@link focusSubjectLabel}), else its leading category.
 *
 * @param focus The context's focus.
 * @returns The label, or `undefined` when the focus names neither.
 */
function focusHeadlineLabel(focus: FollowUpFocusView): string | undefined {
  if (focus.declarations.length > 0) {
    return focusSubjectLabel(focus.declarations.map((declaration) => declaration.symbol));
  }
  const leading = leadingFocusCategory(focus);
  return leading === undefined ? undefined : problemCategoryLabel(leading);
}

/**
 * Builds the panel specification of a capture from its structured context.
 *
 * The title comes from the panel-title frame and the summary from the
 * summary-headline frame, emitted as a **string**: a string summary is stored as
 * the panel's non-evidentiary headline, and a string can never become an
 * observed fact — the panel's facts and causes are copied by the panel
 * normaliser from the validated analysis, which is what keeps the evidence rule
 * intact across the boundary. The layout is the catalog entries of the panel's
 * lens ({@link composedLens}: the classified category's, else the capture's
 * evidence lens) whose declared sources the capture has material for, in the
 * catalog's own order; the headline of a timing panel also names any tier the
 * capture recorded nothing in.
 *
 * A follow-up that regenerates the panel carries its structured focus
 * ({@link readFollowUpFocus}), and the panel is composed for it: the focus
 * category's lens ({@link focusedLens}), the views over the focus's own sources
 * first ({@link focusOrderedCatalog}), the focus's metrics leading the cards and
 * the headline counts, a title naming the focus, and a closing headline
 * sentence naming it. A focus on a declaration also narrows the span ranking,
 * the trace views and the source link to what the capture measured of it
 * ({@link declarationFocus}). Without a focus the specification is exactly the
 * unfocused one.
 *
 * @param input The structured context of a panel-generation request.
 * @returns The specification in its authoring shape, or `undefined` when the
 * context is not an object at all.
 */
export function buildPanelSpecInput(input: JsonValue | undefined): JsonValue | undefined {
  const root = asObject(input);
  if (root === undefined) {
    return undefined;
  }

  const understanding = readUnderstanding(root);
  const reading = readMetrics(root);
  const counts = readSourceCounts(root, reading);
  const spans = sortSpans(readSpans(aggregatesBag(root)));
  const totalMs = readTotalDuration(root, reading, spans);
  const traceId = readTraceId(root);
  // The patterns the capture's numbers form, detected exactly as the analysis
  // detects them, so the metric cards quantify what the analysis explains.
  const patterns = causeDetections(root, reading, spans, totalMs).map(
    (detection) => detection.pattern,
  );
  // A follow-up's structured focus, when one governs this panel; absent — every
  // first question — each focus-driven choice below reduces to the unfocused one.
  const focus = readFollowUpFocus(root);
  const declared = declarationFocus(focus, aggregatesBag(root));
  const focusMetrics = focusMetricIds(focus);
  const lens = focusedLens(focus, understanding.category, counts, patterns);
  const admitted = new Set(patterns.flatMap((pattern) => PATTERN_ADMITTED_SOURCES[pattern]));
  // A measured focused declaration's runs are rows of the flat span list, so the
  // span views are admitted beside the lens's own, whatever the lens.
  const layoutAdmitted: ReadonlySet<string> = declared.measured
    ? new Set([...admitted, FLAT_TRACE_SOURCE])
    : admitted;
  const flatTraceKinds = LENS_FLAT_TRACE_KINDS[lens];

  const catalog = focusOrderedCatalog(
    [...readNodeCatalog(root)].sort((left, right) =>
      left.index === right.index ? compareStrings(left.type, right.type) : left.index - right.index,
    ),
    focus,
  );

  const layout: JsonValue[] = [];
  const emittedTypes = new Set<string>();
  for (const entry of catalog) {
    if (layout.length >= MAX_LAYOUT_NODES) {
      break;
    }
    if (emittedTypes.has(entry.type)) {
      continue;
    }

    // An entry belongs to the lens of the source it is designed around — its
    // first declared one — and reads only sources the lens admits, so a view
    // whose fallback source happens to be populated (a span table over the
    // event log, say) cannot cross into the other lens's panel.
    const primary = entry.sources[0];
    // A trace-shaped view under a lens that reads many traces at once is drawn
    // over the flat span list of that lens's kinds instead (see
    // `LENS_FLAT_TRACE_KINDS`), or left out when it can read nothing else.
    if (
      primary === TRACE_SOURCE &&
      flatTraceKinds !== undefined &&
      !lensAdmits(TRACE_SOURCE, lens, layoutAdmitted)
    ) {
      const node = flatTraceNode(entry, flatTraceKinds, counts, root);
      if (node !== undefined) {
        emittedTypes.add(entry.type);
        layout.push(node);
      }
      continue;
    }
    if (
      primary !== undefined &&
      primary !== METRICS_SOURCE &&
      !lensAdmits(primary, lens, layoutAdmitted)
    ) {
      continue;
    }
    const source = entry.sources.find(
      (candidate) =>
        isMaterialSource(candidate, counts) &&
        (candidate === METRICS_SOURCE || lensAdmits(candidate, lens, layoutAdmitted)),
    );

    if (source === METRICS_SOURCE) {
      const metrics = metricCardIds(entry, reading, patterns, lens, focusMetrics);
      if (metrics.length === 0) {
        continue;
      }
      emittedTypes.add(entry.type);
      layout.push({ type: entry.type, metrics: [...metrics] });
      continue;
    }

    if (source === undefined) {
      if (!entry.wantsLocation) {
        continue;
      }
      // A focused declaration's recorded run is where its source link points;
      // otherwise the lens's own suggestion.
      const location = declared.location ?? readSuggestedLocation(root, lens, admitted);
      if (location === undefined) {
        continue;
      }
      emittedTypes.add(entry.type);
      layout.push({ type: entry.type, location: locationToJson(location) });
      continue;
    }

    // A focus on a declaration turns a kind-indifferent ranking over the flat
    // span list into a ranking of the work a declaration is measured as, longest
    // first; a view designed around kinds of its own keeps them.
    const rankedForDeclaration =
      declared.named &&
      primary === FLAT_TRACE_SOURCE &&
      source === FLAT_TRACE_SOURCE &&
      entry.kindIndifferent;
    const declarationKinds = rankedForDeclaration
      ? reportedKindsAmong(FOCUS_DECLARATION_KINDS, root)
      : [];
    // The lens narrows a source it reads through a fixed kind set (the render
    // views' event log, say) whatever the catalog declares about filters, since
    // every query accepts a kinds filter; otherwise the entry's own declared
    // kinds and the capture's trace apply where the entry declares filters.
    const lensKinds = reportedKindsAmong(lensKindsFor(lens, source), root);
    const kinds =
      declarationKinds.length > 0
        ? declarationKinds
        : lensKinds.length > 0
          ? lensKinds
          : entry.supportsFilter
            ? filterKindsFor(entry, root)
            : [];
    // A trace view under a focus on a declaration shows the interaction holding
    // that declaration's slowest run, whatever the entry declares about filters.
    const narrowedTraceId =
      (source === TRACE_SOURCE ? declared.traceId : undefined) ??
      (entry.supportsFilter ? traceId : undefined);
    const filter: JsonObject = {
      ...(narrowedTraceId !== undefined ? { traceId: narrowedTraceId } : {}),
      ...(kinds.length > 0 ? { kinds: [...kinds] } : {}),
    };
    const hasFilter = Object.keys(filter).length > 0;
    const sort = rankedForDeclaration ? FOCUS_DECLARATION_SORT : entry.sort;

    emittedTypes.add(entry.type);
    layout.push({
      type: entry.type,
      source,
      ...(hasFilter ? { filter } : {}),
      ...(sort !== undefined ? { sort } : {}),
      ...(entry.limit !== undefined ? { limit: entry.limit } : {}),
    });
  }

  const material = [...counts.keys()].some((source) => isMaterialSource(source, counts));
  // The headline counts what the cards measure: the active lens's counts, the
  // ones a follow-up focus asks about first.
  const countedNouns: CountedNoun[] = [];
  for (const id of focusFirst(COMPUTED_METRIC_IDS, focusMetrics)) {
    const value = reading.values.get(id);
    if (value === undefined || !metricInLens(id, lens) || !Object.hasOwn(METRIC_COUNT_NOUNS, id)) {
      continue;
    }
    if (countedNouns.length >= MAX_METRIC_CARDS) {
      break;
    }
    countedNouns.push({ count: value, noun: metricCountNoun(id) });
  }

  // A timing panel's views cover every tier, so a tier the capture recorded
  // nothing in is named rather than left to read as a missing view.
  const silent = lens === 'timing' ? silentTiers(root).map(telemetryTierLabel) : [];
  const summary = material
    ? panelSummaryHeadline(
        countedNouns,
        totalMs,
        silent,
        focus === undefined ? undefined : focusHeadlineLabel(focus),
      )
    : EMPTY_CAPTURE_NOTICE;

  // Titled by what the panel answers: the focus's leading category, else the
  // session's; the declarations the focus names, else the selected target.
  const titleCategory = leadingFocusCategory(focus) ?? understanding.category ?? '';
  const titleSubject =
    focus !== undefined && focus.declarations.length > 0
      ? focusSubjectLabel(focus.declarations.map((declaration) => declaration.symbol))
      : understanding.target?.label;

  return {
    title: panelTitle(problemCategoryLabel(titleCategory), titleSubject),
    summary,
    layout,
  };
}

/* -------------------------------------------------------------------------------------------------
 * stage 7 — follow-up decision
 * ---------------------------------------------------------------------------------------------- */

/**
 * The capture signals a populated data source establishes coverage for.
 *
 * Deliberately conservative, and the asymmetry is the point: claiming coverage
 * the capture may not have would suppress a genuine gap and leave a follow-up
 * answering from evidence it does not hold, while claiming too little only
 * costs an additive action that turns out to have been unnecessary. A source
 * that could hold any of several signals therefore establishes none. The
 * `queries` source is not such a source: both drivers' spans land in it, and
 * the one action type that collects them arms both driver instrumentations
 * together, so a populated query aggregate establishes both driver signals.
 */
const SOURCE_CAPTURE_SIGNALS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  trace: ['interactions'],
  renders: ['react'],
  requests: ['fetch'],
  queries: ['pg', 'prisma'],
  stateTransitions: ['state'],
});

/**
 * Captured signals that never vouch for the sibling signals of their hook.
 *
 * A captured signal proves its hook was live only when that hook is the one
 * producer that reports it. Errors are reported both by the page-error
 * listeners perf-tracking arms and by the server preload (`error`,
 * `server.error`), and outbound requests both by the page's fetch/XHR patch and
 * by the server's HTTP-client instrumentation (`fetch`, `xhr`, `http.client`):
 * a recorded member of either proves no particular hook was armed, so neither
 * makes a sibling signal count as captured.
 */
const SHARED_PRODUCER_SIGNALS: ReadonlySet<string> = new Set(['errors', 'fetch']);

/**
 * The telemetry kinds a capture summary recorded at least one event of.
 *
 * Read from the summary's per-kind tally, `kindCounts`, which the telemetry
 * package's `computeCaptureSummary` zero-fills over the whole telemetry-kind
 * vocabulary: a kind counted zero times is a hook that recorded nothing, which
 * is exactly a gap, and a kind counted at least once is evidence the capture
 * holds. Keys are read in sorted order and counts through {@link asCount}, so a
 * negative, fractional-garbage or non-numeric tally reads as nothing recorded.
 *
 * @param bag The capture bag of the context, when it carried one.
 * @returns The recorded kinds, ascending; empty when no tally was carried.
 */
function readRecordedKinds(bag: JsonObject | undefined): string[] {
  const tally = readObjectField(bag, 'kindCounts');
  if (tally === undefined) {
    return [];
  }
  const kinds: string[] = [];
  for (const kind of sortedKeys(tally)) {
    const count = asCount(tally[kind]);
    if (count !== undefined && count > 0) {
      kinds.push(kind);
    }
  }
  return kinds;
}

/**
 * The signals the hooks that demonstrably recorded evidence also collected.
 *
 * One action type arms one hook set, and that hook set records every signal
 * {@link SIGNAL_ACTION_TYPES} lists for it: react-render-tracking both the
 * renders and the component tree, perf-tracking both the performance entries
 * and the page errors, server-span both the request span and the route-handler
 * spans one server tracer records beneath it, db-query-tracking both drivers. A
 * hook that recorded one of its signals was therefore live for the whole
 * capture, and a sibling signal it recorded nothing for was genuinely absent
 * from the interaction rather than unobserved — which is evidence the existing
 * capture already holds, not a gap.
 *
 * Still conservative, and deliberately so: liveness comes from events the
 * capture actually recorded, never from what the plan installed. A hook the
 * plan asked for that recorded nothing vouches for nothing, and a signal more
 * than one producer reports ({@link SHARED_PRODUCER_SIGNALS}) vouches for no
 * hook at all.
 *
 * @param captured The signals the capture recorded directly.
 * @returns Every signal a live hook covers, ascending; a superset of the
 * vouching members of `captured`.
 */
function liveHookSignals(captured: ReadonlySet<string>): string[] {
  const live = new Set<ActionTypeId>();
  for (const signal of sortStrings([...captured])) {
    if (SHARED_PRODUCER_SIGNALS.has(signal)) {
      continue;
    }
    for (const type of SIGNAL_ACTION_TYPES[signal] ?? []) {
      live.add(type);
    }
  }
  const covered: string[] = [];
  for (const signal of sortStrings(Object.keys(SIGNAL_ACTION_TYPES))) {
    if ((SIGNAL_ACTION_TYPES[signal] ?? []).some((type) => live.has(type))) {
      covered.push(signal);
    }
  }
  return covered;
}

/** What the installed plan already applies, in the views the follow-up decision reads. */
interface InstalledActionsView {
  /** `file|symbol|type` of every installed action. */
  readonly keys: ReadonlySet<string>;
  /** Every installed action type, whatever it targets. */
  readonly types: ReadonlySet<string>;
  /**
   * `file|symbol` of every declaration an installed action already wraps with
   * a timing ({@link TARGET_REQUIRED_TYPES}): a declaration is measured once,
   * whichever of the two timings measures it.
   */
  readonly timed: ReadonlySet<string>;
}

/**
 * Reads the actions the installed plan already applies.
 *
 * The plan bag is probed as `plan`, `latestPlan` then `currentPlan`, and the
 * root is read as well for a context that lists its installed actions beside
 * the plan rather than inside it. A targetless runtime action reads like any
 * other: its `.` file and `*` symbol are a valid project path and symbol.
 *
 * @param root The structured context.
 * @returns The installed keys, types and timed declarations; empty when no plan
 * was carried.
 */
function readInstalledActions(root: JsonObject): InstalledActionsView {
  const keys = new Set<string>();
  const types = new Set<string>();
  const timed = new Set<string>();
  for (const bag of [readObjectField(root, 'plan', 'latestPlan', 'currentPlan'), root]) {
    for (const action of readObjectArrayField(
      bag,
      'instrumentationTargets',
      'installedActions',
      'actions',
      'targets',
    ) ?? []) {
      const file = asProjectPath(readField(action, 'file', 'path'));
      const symbol = asString(readField(action, 'symbol', 'name'));
      const type = asString(readField(action, 'type', 'actionType'));
      if (file !== undefined && symbol !== undefined && type !== undefined) {
        keys.add(`${file}|${symbol}|${type}`);
        types.add(type);
        if (TARGET_REQUIRED_TYPES.has(type)) {
          timed.add(`${file}|${symbol}`);
        }
      }
    }
  }
  return { keys, types, timed };
}

/**
 * The timing a declaration named by the follow-up asks for, when it asks for
 * one.
 *
 * A follow-up context carries, as its `candidates`, the declarations its
 * wording named, already resolved through the code graph — the lexical lookup
 * happens in the stage, never here, so this reads structure only. A
 * declaration whose kind's **first** preference in
 * {@link CODE_KIND_ACTION_TYPES} is a timing (a plain function or a server
 * function: `function-timing`; a route handler: `server-span`) is one whose
 * evidence only a wrapper can collect, so naming it asks for that wrapper. A
 * kind whose first preference is a runtime hook — a component, an event
 * handler, an outbound call, a query site — asks for nothing here: its evidence
 * comes from the hook, which the gap rule arms when it is missing. A kind the
 * graph did not report, or a symbol that does not spell a declaration (see
 * {@link isDeclarationSpelling}, already applied to `actionTypes`), asks for
 * nothing either.
 *
 * @param candidate One graph-resolved declaration of the context.
 * @param catalog The catalog view; the timing must be one it claims.
 * @returns The timing action type, or `undefined`.
 */
function namedDeclarationTimingType(
  candidate: CandidateView,
  catalog: AdapterCatalogView,
): ActionTypeId | undefined {
  const preference = Object.hasOwn(CODE_KIND_ACTION_TYPES, candidate.kind)
    ? CODE_KIND_ACTION_TYPES[candidate.kind]
    : undefined;
  const first = preference?.[0];
  if (first === undefined || !TARGET_REQUIRED_TYPES.has(first)) {
    return undefined;
  }
  return candidate.actionTypes.find(
    (type) => TARGET_REQUIRED_TYPES.has(type) && catalog.claimed.has(type),
  );
}

/**
 * The page- or process-wide runtime action that collects a signal, when the
 * catalog claims one.
 *
 * The follow-up counterpart of the reservation {@link buildPlanInput} makes for
 * every needed signal: the first action type in the signal's preference list
 * the catalog claims, installs as a runtime hook and does not require a named
 * target.
 *
 * @param signal A capture signal.
 * @param catalog The catalog view.
 * @returns The runtime action type, or `undefined` when only a target-requiring
 * action (or none) collects the signal.
 */
function runtimeActionTypeFor(
  signal: string,
  catalog: AdapterCatalogView,
): ActionTypeId | undefined {
  return (SIGNAL_ACTION_TYPES[signal] ?? []).find(
    (candidate) =>
      catalog.claimed.has(candidate) &&
      isRuntimeActionType(candidate, catalog) &&
      !TARGET_REQUIRED_TYPES.has(candidate),
  );
}

/**
 * The candidates of a follow-up context, with the declarations its structured
 * focus names added as candidates of their own.
 *
 * A follow-up context may carry the declarations its wording named in its
 * `followUpFocus` as well as, or instead of, in its `candidates`; either way
 * they are graph-resolved declarations, and one named in either place is a
 * candidate. A focus declaration without a file cannot be instrumented and is
 * skipped, as is one the candidates already carry (`file|symbol`). An added
 * candidate is scored as a named entity of a known kind would be
 * ({@link readCandidates}' structure-only scoring), and its action-type
 * preference is its kind's, with the timings kept only for a symbol that
 * spells a declaration.
 *
 * @param candidates The candidates the context carries.
 * @param focus The context's focus, if any.
 * @returns The candidates, unordered; exactly `candidates` without a focus.
 */
function withFocusCandidates(
  candidates: readonly CandidateView[],
  focus: FollowUpFocusView | undefined,
): readonly CandidateView[] {
  if (focus === undefined || focus.declarations.length === 0) {
    return candidates;
  }
  const known = new Set(candidates.map((candidate) => `${candidate.file}|${candidate.symbol}`));
  const added: CandidateView[] = [];
  for (const declaration of focus.declarations) {
    const { file, symbol, kind } = declaration;
    if (file === undefined || known.has(`${file}|${symbol}`)) {
      continue;
    }
    known.add(`${file}|${symbol}`);
    const preference = Object.hasOwn(CODE_KIND_ACTION_TYPES, kind)
      ? CODE_KIND_ACTION_TYPES[kind]
      : undefined;
    const score =
      SCORE_BASE + SCORE_ENTITY_MATCH + (preference !== undefined ? SCORE_KNOWN_KIND : 0);
    added.push({
      file,
      symbol,
      kind,
      reasonKind: kind,
      score: roundValue(clampRange(score, 0, SCORE_MAX), SCORE_DECIMALS),
      relatedLabel: symbol,
      actionTypes: (preference ?? DEFAULT_CODE_KIND_ACTION_TYPES).filter(
        (type) => !TARGET_REQUIRED_TYPES.has(type) || isDeclarationSpelling(symbol),
      ),
    });
  }
  return [...candidates, ...added];
}

/**
 * Builds the follow-up decision of a request from its structured context.
 *
 * The decision is made from what the context reports about the **existing**
 * capture: the signals it asked for against the signals it recorded, the gaps
 * it names explicitly, and whether it recorded anything at all — and from the
 * declarations the context's `candidates` name, which the stage resolved
 * through the code graph before the request was built. The new request's
 * wording plays no part — it is not read, and the dispatch cannot supply it —
 * so two phrasings that name the same declaration answer identically.
 *
 * ## What counts as captured
 *
 * The union of the signal lists a context names explicitly, the signals of the
 * telemetry kinds the capture summary's `kindCounts` tally recorded at least
 * one event of (read through {@link SIGNAL_ALIASES}), the signals of the
 * populated aggregate sources ({@link SOURCE_CAPTURE_SIGNALS}), and the sibling
 * signals of every hook that demonstrably recorded evidence
 * ({@link liveHookSignals}). A capture whose summary reports zero events, or
 * whose context carries nothing material at all, is an empty capture.
 *
 * ## Two outcomes, both additive by construction
 *
 * - Nothing missing, so the existing evidence is re-analysed with no new
 *   instrumentation. That is the smallest safe answer, and it is the one an
 *   unknown context gets: asking for instrumentation on no information would
 *   modify a developer's project for nothing.
 * - A signal genuinely absent, an empty capture, or a named declaration only a
 *   wrapper can measure that no installed timing wraps, so a new capture is
 *   asked for along with the actions that would collect what is missing. A gap
 *   a runtime hook collects gets one targetless action of that hook's type —
 *   the hook observes the whole page or process — unless the plan already
 *   installs an action of that type, in which case the hook is already armed
 *   and nothing is added. A named declaration gets the timing its kind asks
 *   for ({@link namedDeclarationTimingType}). A gap only a target-requiring
 *   action collects is attached to the candidates the context names. Only
 *   actions the catalog claims, never one the plan already installs, never a
 *   second timing of a declaration already timed, at most
 *   {@link MAX_ADDITIONAL_ACTIONS}, and never a removal — a follow-up plan is
 *   the previous plan plus these.
 *
 * @param input The structured context of a follow-up request.
 * @returns The decision as plain JSON, or `undefined` when the context is not
 * an object at all.
 */
export function buildFollowUpDecision(input: JsonValue | undefined): JsonValue | undefined {
  const root = asObject(input);
  if (root === undefined) {
    return undefined;
  }

  const understanding = readUnderstanding(root);
  const catalog = readAdapterCatalog(root);
  const reading = readMetrics(root);
  const counts = readSourceCounts(root, reading);
  const captureBag = readObjectField(root, 'captureSummary', 'capture', 'latestCapture');
  const recordedKinds = readRecordedKinds(captureBag);

  const captured = new Set<string>(
    canonicalSignals([
      ...readStringSet(captureBag, 'capturedSignals', 'signals', 'kinds'),
      ...readStringSet(root, 'capturedSignals'),
      ...recordedKinds,
    ]),
  );
  for (const source of sortStrings(Object.keys(SOURCE_CAPTURE_SIGNALS))) {
    if (!isMaterialSource(source, counts)) {
      continue;
    }
    for (const signal of SOURCE_CAPTURE_SIGNALS[source] ?? []) {
      captured.add(signal);
    }
  }
  for (const signal of liveHookSignals(captured)) {
    captured.add(signal);
  }

  const wanted = new Set<string>(understanding.signals);
  for (const bag of [root, understandingBag(root), analysisBag(root), captureBag]) {
    for (const signal of canonicalSignals(
      readStringSet(
        bag,
        'missingSignals',
        'coverageGaps',
        'unavailableSignals',
        'additionalSignals',
      ),
    )) {
      wanted.add(signal);
    }
  }

  const gaps = sortStrings([...wanted].filter((signal) => !captured.has(signal)));

  // "Present but empty" is a finding; "absent" is not. Only a context that
  // carried a capture bag, and reports nothing material in it — or whose
  // summary counts no event at all — establishes that the capture itself
  // yielded nothing.
  const capturePresent = captureBag !== undefined || counts.size > 0;
  const material =
    recordedKinds.length > 0 ||
    [...counts.keys()].some((source) => isMaterialSource(source, counts));
  const reportedEvents = asCount(readField(captureBag, 'eventCount'));
  const emptyCapture = capturePresent && (reportedEvents === 0 || !material);

  const installed = readInstalledActions(root);
  const candidates = sortCandidates(
    withFocusCandidates(readCandidates(root, understanding), readFollowUpFocus(root)),
  );

  // A declaration the follow-up names that only a wrapper can measure, and
  // that no installed timing already wraps, is evidence the stored capture
  // cannot hold: its measurement is a new capture's.
  const namedTimings: { readonly candidate: CandidateView; readonly type: ActionTypeId }[] = [];
  for (const candidate of candidates) {
    const type = namedDeclarationTimingType(candidate, catalog);
    if (type !== undefined && !installed.timed.has(`${candidate.file}|${candidate.symbol}`)) {
      namedTimings.push({ candidate, type });
    }
  }

  const needsNewCapture = gaps.length > 0 || emptyCapture || namedTimings.length > 0;
  if (!needsNewCapture) {
    return { needsNewCapture: false, additionalActions: [] };
  }

  const additionalActions: JsonObject[] = [];
  const emitted = new Set<string>();
  const emittedTimed = new Set<string>();
  const propose = (file: string, symbol: string, type: ActionTypeId): void => {
    const key = `${file}|${symbol}|${type}`;
    const declaration = `${file}|${symbol}`;
    const timing = TARGET_REQUIRED_TYPES.has(type);
    if (
      additionalActions.length >= MAX_ADDITIONAL_ACTIONS ||
      installed.keys.has(key) ||
      emitted.has(key) ||
      (timing && (installed.timed.has(declaration) || emittedTimed.has(declaration)))
    ) {
      return;
    }
    emitted.add(key);
    if (timing) {
      emittedTimed.add(declaration);
    }
    additionalActions.push(instrumentationTarget(file, symbol, type));
  };

  // A gap a runtime hook collects: the hook observes the whole page or process,
  // so one targetless action arms it — and a hook the plan already installs an
  // action of is already armed, where a second action would collect nothing
  // new. Runtime gaps are served first, as the plan reserves its hooks first, so
  // a long candidate list can never crowd out the hooks a capture depends on.
  for (const gap of gaps) {
    const type = runtimeActionTypeFor(gap, catalog);
    if (type !== undefined && !installed.types.has(type)) {
      propose(TARGETLESS_ACTION_FILE, TARGETLESS_ACTION_SYMBOL, type);
    }
  }

  // Each named declaration gets the one timing its kind asks for, in candidate
  // order — a wrapped declaration's patch chains onto an earlier patch of the
  // same file when an earlier plan version instrumented it.
  for (const { candidate, type } of namedTimings) {
    propose(candidate.file, candidate.symbol, type);
  }

  // A gap only an action on a named declaration collects is attached to the
  // candidates the context names that support that action.
  for (const gap of gaps) {
    if (runtimeActionTypeFor(gap, catalog) !== undefined) {
      continue;
    }
    for (const type of SIGNAL_ACTION_TYPES[gap] ?? []) {
      if (!catalog.claimed.has(type)) {
        continue;
      }
      for (const candidate of candidates) {
        if (candidate.actionTypes.includes(type)) {
          propose(candidate.file, candidate.symbol, type);
        }
      }
    }
  }

  return { needsNewCapture: true, additionalActions };
}

/* -------------------------------------------------------------------------------------------------
 * dispatch
 * ---------------------------------------------------------------------------------------------- */

/**
 * A per-stage rule set: structured context in, JSON answer out.
 *
 * The signature is the compliance mechanism of this module. A builder receives
 * the structured context **and nothing else** — no request, no closure over
 * one, no channel that could carry the rendered prompt — so it has no way to
 * inspect the wording of a developer's request, and wording-invariance is
 * provable by inspection rather than by testing. If a future change is tempted
 * to widen this signature, that change is the bug.
 *
 * `undefined` in means "the stage sent nothing"; `undefined` out means "nothing
 * was derivable", which {@link buildDeterministicOutput} turns into a typed
 * failure rather than into an empty answer.
 */
export type DeterministicBuilder = (input: JsonValue | undefined) => JsonValue | undefined;

/**
 * The rule set for every stage, keyed by stage name.
 *
 * Total over the stage vocabulary by its declared type, and the totality is the
 * point: a stage added to the vocabulary makes this table a compile error until
 * it has a rule set, instead of a provider that silently answers nothing for
 * the new stage at run time.
 */
export const DETERMINISTIC_BUILDERS: Readonly<Record<PromptStage, DeterministicBuilder>> =
  Object.freeze({
    understand: buildUnderstanding,
    investigate: buildInvestigation,
    plan: buildPlanInput,
    analyze: buildAnalysis,
    'generate-panel': buildPanelSpecInput,
    followup: buildFollowUpDecision,
  });

/**
 * Answers one request from its structured context alone.
 *
 * The single entry point the rules-based provider calls. It reads exactly two
 * things — the stage from the request's metadata and the structured context —
 * validates the stage against the vocabulary, and hands the context to that
 * stage's rule set. The rendered prompt, the system instruction and the message
 * history are never read and are never passed on.
 *
 * Failure is returned, never thrown: a missing or unusable structured context
 * is an expected condition on a degraded capture, and the provider surfaces it
 * as a provider-level failure that the structured-output validator classifies
 * without spending any of its repair budget — re-prompting a rules engine that
 * had nothing to work from would produce the same answer twice. The error codes
 * come from the product's closed vocabulary, and each carries a hint naming the
 * missing input, because that is the part whoever debugs a degraded stage can
 * act on.
 *
 * @param request The request to answer; only `metadata.stage` and `input` are
 * read.
 * @returns The stage's answer as plain JSON, or a typed failure.
 */
export function buildDeterministicOutput(request: ModelRequest): Result<JsonValue, DebuggenError> {
  const stage: unknown = request.metadata.stage;
  if (!isPromptStage(stage)) {
    return err(
      new DebuggenError(
        'CONFIG_INVALID',
        'A request named a stage the deterministic rules do not implement.',
        {
          hint: `Set metadata.stage to one of: ${PROMPT_STAGES.join(', ')}.`,
          details: { stage: String(stage) },
        },
      ),
    );
  }

  const build = DETERMINISTIC_BUILDERS[stage];
  const output = build(request.input);
  if (output === undefined) {
    return err(
      new DebuggenError(
        'MODEL_UNAVAILABLE',
        `The deterministic rules could not derive a ${stage} result from the structured context of this request.`,
        {
          hint: 'The rules build their answer from the structured context only. Populate request.input for this stage — a classified category and a selected target for understanding, code-graph candidates for investigation, an adapter capability catalog for planning, capture aggregates for analysis and a node catalog for panel generation.',
          details: { stage },
        },
      ),
    );
  }

  return ok(output);
}
