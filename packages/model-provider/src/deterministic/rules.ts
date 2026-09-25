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
  EMPTY_CAPTURE_NOTICE,
  METRIC_COUNT_NOUNS,
  captureSignalLabel,
  codeSymbolKindLabel,
  dominantSpanCause,
  duplicateRequestCause,
  duplicateRequestFact,
  errorCountFact,
  flowPathLabel,
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

/** Fields that hold a list of evidence references, probed in this order. */
const EVIDENCE_LIST_FIELDS: readonly string[] = ['evidence', 'eventIds', 'events', 'ids'];

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
 * The key of the one spelling an emitted evidence reference has: `{ eventId }`.
 *
 * The context may spell its own references either way — a request group lists
 * bare `eventIds`, a fact candidate carries `{ eventId }` records — and both are
 * read. What is emitted is always the object form, because that is the only
 * form `@debuggen/panel-schema`'s `EventRef` accepts, and protocol's strict
 * findings schema validates every fact and cause with it.
 */
const EVIDENCE_OBJECT_KEY = 'eventId';

/** The reference set of one structured context. */
interface EvidenceIndex {
  /** Every reference the context carries, within {@link MAX_EVIDENCE_IDS}. */
  readonly available: ReadonlySet<string>;
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
 * The references one aggregate carries, in the order it carries them.
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
    for (const field of EVIDENCE_SINGLE_FIELDS) {
      const reference = asString(source[field]);
      if (reference !== undefined) {
        references.push(reference);
        break;
      }
    }
  }
  return references;
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
 * @returns The available references.
 */
function indexEvidence(bags: readonly (JsonObject | undefined)[]): EvidenceIndex {
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

  return { available };
}

/**
 * The citable subset of a candidate's references, as `{ eventId }` records.
 *
 * Filtered against the harvested set, de-duplicated, ordered, and capped. An
 * empty result is the caller's signal to **drop the candidate entirely**: a
 * fact carries at least one reference, and one that cannot cite anything is one
 * this module has no business asserting.
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
  const ordered = sortStrings([...citable]).slice(0, MAX_EVIDENCE_PER_FACT);
  return ordered.map((reference) => ({ [EVIDENCE_OBJECT_KEY]: reference }));
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
 * A `file:line:column` label for an aggregate's location, for the frames that
 * name a call site.
 *
 * @param source An aggregate that may carry a location.
 * @returns The label, or the empty string so the frame applies its own
 * documented fallback wording.
 */
function callSiteLabel(source: JsonObject | undefined): string {
  if (source === undefined) {
    return '';
  }
  const location = readSourceLocation(source);
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
 * reports one row per member of. The package layering of AAP §0.2.2 keeps this
 * package below instrumentation, so the names are restated rather than
 * imported; an understanding built in any other vocabulary is one the product's
 * own schema rejects, which is a defect of this module, not of the caller.
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
 * The selected-target descriptor of a context.
 *
 * The label prefers the nearest component of the resolved chain, then the
 * element's own accessible text, then its tag name, then its selector — in that
 * order, because that is the order of decreasing usefulness to a developer
 * reading a panel title. Every one of them comes from the descriptor the
 * DevTools surface built from the selection; none comes from prose.
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
    chain[0] ??
    asString(readField(bag, 'text', 'label', 'accessibleName')) ??
    asString(bag.tagName) ??
    asString(bag.selector);

  return {
    ...(label !== undefined ? { label } : {}),
    chain,
  };
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
}

/** One group of byte-identical requests. */
interface RequestGroupView {
  /** The aggregate this view was read from. */
  readonly node: JsonObject;
  /** Occurrences in the group. */
  readonly count: number;
  /** The window they occurred within, in milliseconds. */
  readonly windowMs: number;
  /** The endpoint they addressed, when the capture reported one. */
  readonly endpoint?: string;
}

/** One group of statements sharing a shape. */
interface QueryGroupView {
  /** The aggregate this view was read from. */
  readonly node: JsonObject;
  /** Executions of the shape. */
  readonly count: number;
  /** The parameterised statement text, or the empty string. */
  readonly statement: string;
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
    const duration = asDurationMs(readField(node, 'duration', 'durationMs', 'elapsedMs'));
    if (duration === undefined) {
      continue;
    }
    const name = asString(readField(node, 'name', 'operation', 'label')) ?? '';
    const tier = asString(node.tier);
    spans.push({ node, name, duration, ...(tier !== undefined ? { tier } : {}) });
  }
  return spans;
}

/**
 * The render statistics of a capture.
 *
 * The two qualified counts are read separately and never conflated: an
 * undetermined trigger means one of the three conditions could not be
 * evaluated, which is not the same as having evaluated all three and found
 * nothing changed.
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
    });
  }
  return renders;
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
    const count = asCount(readField(node, 'count', 'occurrenceCount', 'duplicateCount'));
    if (count === undefined) {
      continue;
    }
    const endpoint = asString(readField(node, 'endpoint', 'url', 'path'));
    groups.push({
      node,
      count,
      windowMs: asDurationMs(readField(node, 'windowMs', 'window', 'spanMs')) ?? 0,
      ...(endpoint !== undefined ? { endpoint } : {}),
    });
  }
  return groups;
}

/**
 * The query groups of a capture.
 *
 * A statement arrives parameterised and redacted — placeholders rather than
 * literals, and never row contents — and is bounded like any other label on the
 * way into a sentence.
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
    groups.push({
      node,
      count,
      statement: asString(readField(node, 'statement', 'db.statement', 'sql', 'text')) ?? '',
    });
  }
  return groups;
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
    signals.add('interactions');
  }
  // A question observed in the page is also observed through its performance
  // entries: long tasks, resource timing and the navigation that framed the
  // document are the only source of the browser-tier measurements
  // (`blocking_time`, `long_task_count`, `transferred_bytes`), and a reload
  // during a capture is visible only as its navigation entry. The hook edits
  // no file, so it is collected whenever the page itself is.
  if (signals.has('interactions') || signals.has('react')) {
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
  /** The relevance score, either reported or computed. */
  readonly score: number;
  /** What the candidate matched, for the relevance frame. */
  readonly relatedLabel: string;
  /** The candidate's action-type preference, from its kind. */
  readonly actionTypes: readonly ActionTypeId[];
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

  const candidates: CandidateView[] = [];
  for (const node of nodes) {
    const file = asProjectPath(readField(node, 'file', 'path', 'filePath'));
    if (file === undefined) {
      continue;
    }

    const stems = pathStems(file);
    const symbol = asString(readField(node, 'symbol', 'symbolName', 'name')) ?? stems[0] ?? file;
    const kind = asString(readField(node, 'kind', 'nodeKind', 'type')) ?? '';
    const declaredSignals = canonicalSignals(
      readStringSet(node, 'signals', 'captureSignals', 'provides'),
    );

    const matchedSignals = declaredSignals.filter((signal) => neededSignals.has(signal));
    const matchedEntities = sortStrings([symbol, ...stems].filter((name) => entityNames.has(name)));
    const inChain = chain.has(symbol);
    const knownKind = Object.hasOwn(CODE_KIND_ACTION_TYPES, kind);

    const reported = asFiniteNumber(readField(node, 'score', 'relevance', 'weight'));
    const computed =
      SCORE_BASE +
      matchedSignals.length * SCORE_SIGNAL_MATCH +
      (matchedEntities.length > 0 ? SCORE_ENTITY_MATCH : 0) +
      (inChain ? SCORE_TARGET_CHAIN_MATCH : 0) +
      (knownKind ? SCORE_KNOWN_KIND : 0);
    const score =
      reported === undefined
        ? roundValue(clampRange(computed, 0, SCORE_MAX), SCORE_DECIMALS)
        : roundValue(reported, SCORE_DECIMALS);

    const relatedLabel =
      matchedEntities[0] ??
      (matchedSignals[0] !== undefined
        ? captureSignalLabel(matchedSignals[0])
        : declaredSignals[0] !== undefined
          ? captureSignalLabel(declaredSignals[0])
          : '');

    candidates.push({
      file,
      symbol,
      kind,
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

/**
 * Builds the code investigation of a request from its structured context.
 *
 * Ranks the candidates the context supplies (see {@link readCandidates} for the
 * scoring), names each one's relevance with the code-relevance frame, and
 * renders whatever graph paths the context reported. Every path is normalised
 * to a project-relative POSIX path, and a candidate whose path fails that check
 * is dropped.
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
  const candidates = sortCandidates(readCandidates(root, understanding)).slice(
    0,
    MAX_RELEVANT_FILES,
  );
  const flows = readFlows(root);

  if (candidates.length === 0 && flows.length === 0) {
    return undefined;
  }

  const relevantFiles: JsonValue[] = candidates.map((candidate) => ({
    file: candidate.file,
    symbol: candidate.symbol,
    reason: codeRelevanceReason(codeSymbolKindLabel(candidate.kind), candidate.relatedLabel),
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

/**
 * Builds the instrumentation plan of a request from its structured context.
 *
 * The objective comes from the plan-objective frame, filled with the category
 * label and the selected target's label — never with the developer's wording.
 * The capture list is the signals the understanding asked for plus the signals
 * the chosen targets contribute, intersected with what the adapter catalog
 * reports as collectable. The targets are chosen from the investigation
 * candidates the context supplies, each one's action type taken from its node
 * kind and filtered through the catalog's claims, runtime hooks preferred over
 * rewrites.
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
  const candidates = sortCandidates(readCandidates(root, understanding));

  // The page- and process-wide runtime action each needed signal would be
  // collected by. Their slots are reserved before candidates are considered, so
  // a long candidate list can never crowd out the hooks a capture depends on.
  const signalTypes: ActionTypeId[] = [];
  for (const signal of sortStrings([...understanding.signals])) {
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
  for (const candidate of candidates) {
    if (targets.length >= candidateBudget) {
      break;
    }
    const type = chooseActionType(candidate.actionTypes, catalog);
    if (type === undefined) {
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
  return {
    objective: planObjective(
      problemCategoryLabel(understanding.category ?? ''),
      understanding.target?.label,
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
  | 'unchangedRenders'
  | 'repeatedQuery'
  | 'renderCount'
  | 'sharedOrigin'
  | 'unknownTrigger'
  | 'tierSplit'
  | 'longTask'
  | 'errors';

/**
 * How much each class of fact is worth on a crowded panel.
 *
 * Ranking rather than filtering: every class that has material produces its
 * candidates, and the cap keeps the highest-ranked ones. Which classes have
 * material is decided by the capture, which is why one capture's analysis reads
 * as a latency finding and another's as a rendering finding without either
 * outcome being written down anywhere.
 */
const FACT_CLASS_WEIGHTS: Readonly<Record<FactClass, number>> = Object.freeze({
  slowestSpan: 95,
  duplicateRequests: 90,
  unchangedRenders: 85,
  repeatedQuery: 80,
  renderCount: 70,
  sharedOrigin: 65,
  unknownTrigger: 60,
  tierSplit: 50,
  longTask: 40,
  errors: 30,
});

/** Slowest operations reported as facts. */
const MAX_SLOWEST_SPAN_FACTS = 2;

/** Components reported as render outliers. */
const MAX_RENDER_OUTLIER_FACTS = 3;

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
}

/** Fields shared by every evidence-pattern detection. */
interface CauseDetectionBase {
  /** Whole steps of evidence strength, for {@link confidenceForSteps}. */
  readonly steps: number;
  /** The references the detection would cite, before filtering. */
  readonly references: readonly string[];
  /** A location to suggest, when the context supplied a usable one. */
  readonly location?: SourceLocation;
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
  );

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
    for (const span of spans.slice(0, MAX_SLOWEST_SPAN_FACTS)) {
      if (span.duration <= 0) {
        continue;
      }
      candidates.push({
        factClass: 'slowestSpan',
        magnitude: span.duration,
        statement: slowestSpanFact(span.name, span.duration, totalMs),
        references: evidenceOf(span.node),
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
    const references = evidenceOf(group.node);
    candidates.push({
      factClass: 'duplicateRequests',
      magnitude: group.count,
      statement: duplicateRequestFact(group.count, group.windowMs, group.endpoint),
      references,
    });
    const callSite = callSiteLabel(group.node);
    if (callSite.length > 0) {
      candidates.push({
        factClass: 'sharedOrigin',
        magnitude: group.count,
        statement: sharedOriginFact(group.count, callSite),
        references,
      });
    }
  }

  const renders = [...readRenders(aggregates)].sort((left, right) =>
    left.count === right.count
      ? compareStrings(left.component, right.component)
      : right.count - left.count,
  );
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
    if (render.unchanged >= UNCHANGED_RENDER_MIN_COUNT) {
      candidates.push({
        factClass: 'unchangedRenders',
        magnitude: render.unchanged,
        statement: unchangedInputRenderFact(render.unchanged, render.count),
        references,
      });
    }
    if (render.unknownTrigger >= UNKNOWN_TRIGGER_MIN_COUNT) {
      candidates.push({
        factClass: 'unknownTrigger',
        magnitude: render.unknownTrigger,
        statement: unknownTriggerRenderFact(render.unknownTrigger, render.count),
        references,
      });
    }
  }

  const queryGroups = [...readQueryGroups(aggregates)]
    .filter((group) => group.count >= REPEATED_QUERY_MIN_COUNT)
    .sort((left, right) =>
      left.count === right.count
        ? compareStrings(left.statement, right.statement)
        : right.count - left.count,
    )
    .slice(0, MAX_QUERY_GROUP_FACTS);
  for (const group of queryGroups) {
    candidates.push({
      factClass: 'repeatedQuery',
      magnitude: group.count,
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
 * Detects the evidence patterns a capture's numbers form.
 *
 * Every detection is numeric: a duplicate group above its threshold, an
 * unchanged-input render count materially above zero, one operation covering
 * most of the measured total, a statement shape repeated within one
 * interaction. Each carries the whole steps of strength its confidence is
 * derived from, so the confidence rule stays monotonic and shared.
 *
 * @param root The structured context.
 * @param spans The ordered operations of the capture.
 * @param totalMs The interaction's measured total, when there is one.
 * @returns The detections, unordered.
 */
function causeDetections(
  root: JsonObject,
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
    const location = readSourceLocation(duplicate.node);
    detections.push({
      pattern: 'duplicate-requests',
      count: duplicate.count,
      windowMs: duplicate.windowMs,
      callSite: callSiteLabel(duplicate.node),
      steps: duplicate.count - 1,
      references: evidenceOf(duplicate.node),
      ...(location !== undefined ? { location } : {}),
    });
  }

  const unchanged = [...readRenders(aggregates)]
    .filter((render) => render.unchanged >= UNCHANGED_RENDER_MIN_COUNT)
    .sort((left, right) =>
      left.unchanged === right.unchanged
        ? compareStrings(left.component, right.component)
        : right.unchanged - left.unchanged,
    )[0];
  if (unchanged !== undefined) {
    const location = readSourceLocation(unchanged.node);
    detections.push({
      pattern: 'unchanged-input-renders',
      component: unchanged.component,
      unchanged: unchanged.unchanged,
      steps: unchanged.unchanged - 1,
      references: evidenceOf(unchanged.node),
      ...(location !== undefined ? { location } : {}),
    });
  }

  const dominant = spans[0];
  if (dominant !== undefined && totalMs !== undefined && totalMs > 0) {
    const share = dominant.duration / totalMs;
    if (share >= DOMINANT_SPAN_MIN_SHARE) {
      const location = readSourceLocation(dominant.node);
      const steps =
        Math.floor(share * DOMINANT_SHARE_STEP_SCALE) -
        Math.floor(DOMINANT_SPAN_MIN_SHARE * DOMINANT_SHARE_STEP_SCALE);
      detections.push({
        pattern: 'dominant-span',
        operation: dominant.name,
        durationMs: dominant.duration,
        totalMs,
        ...(dominant.tier !== undefined ? { tier: telemetryTierLabel(dominant.tier) } : {}),
        steps,
        references: evidenceOf(dominant.node),
        ...(location !== undefined ? { location } : {}),
      });
    }
  }

  const repeated = [...readQueryGroups(aggregates)]
    .filter((group) => group.count >= REPEATED_QUERY_MIN_COUNT)
    .sort((left, right) =>
      left.count === right.count
        ? compareStrings(left.statement, right.statement)
        : right.count - left.count,
    )[0];
  if (repeated !== undefined) {
    const location = readSourceLocation(repeated.node);
    const caller = callSiteLabel(repeated.node);
    detections.push({
      pattern: 'repeated-query-shape',
      count: repeated.count,
      statement: repeated.statement,
      ...(caller.length > 0 ? { caller } : {}),
      steps: repeated.count - 1,
      references: evidenceOf(repeated.node),
      ...(location !== undefined ? { location } : {}),
    });
  }

  return detections;
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
  const index = indexEvidence([aggregates, root]);

  const observed: JsonValue[] = [];
  const ranked = [...factCandidates(root, reading, spans, totalMs)].sort((left, right) => {
    const leftWeight = FACT_CLASS_WEIGHTS[left.factClass];
    const rightWeight = FACT_CLASS_WEIGHTS[right.factClass];
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

  const likelyCauses: JsonValue[] = [];
  const causes = causeDetections(root, spans, totalMs)
    .map((detection) => ({
      statement: causeStatement(detection),
      strength: boundedSteps(detection.steps),
      confidence: confidenceForSteps(detection.steps),
      evidence: citeEvidence(detection.references, index),
      location: detection.location,
    }))
    .filter((cause) => cause.evidence.length > 0)
    .sort((left, right) =>
      left.strength === right.strength
        ? compareStrings(left.statement, right.statement)
        : right.strength - left.strength,
    )
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
 * the capture reports material for a source that entry declares, which is what
 * makes two materially different captures produce materially different panels:
 * a latency capture populates the trace, span and query sources while a
 * rendering capture populates the render, component-tree and state-transition
 * ones, so the emitted node-type sets diverge without this module knowing
 * anything about either question.
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

    return {
      index,
      type,
      sources,
      supportsFilter: asBoolean(entry.supportsFilter) ?? filterKeys.length > 0,
      kinds: readOrderedStrings(entry, 'defaultKinds', 'kinds', 'filterKinds'),
      ...(sort !== undefined ? { sort } : {}),
      ...(limit !== undefined ? { limit } : {}),
      metrics: readOrderedStrings(entry, 'metrics', 'metricIds', 'allowedMetrics'),
      wantsLocation:
        declaredLocation === true ||
        (sources.length === 0 && (reads.includes('source') || reads.includes('location'))),
    };
  });
}

/**
 * The location a leaf node would point at, when the context supplies a usable
 * one.
 *
 * The analysis is asked first, because a location it suggested has already been
 * chosen as the most useful place to send a developer; failing that, the
 * aggregates are read in a fixed order so the answer does not depend on which
 * bag happened to be probed first.
 *
 * @param root The structured context.
 * @returns The validated location, or `undefined`.
 */
function readSuggestedLocation(root: JsonObject): SourceLocation | undefined {
  const analysis = analysisBag(root);
  for (const cause of asObjectArray(readField(analysis ?? root, 'likelyCauses', 'causes')) ?? []) {
    const location = readSourceLocation(cause);
    if (location !== undefined) {
      return location;
    }
  }

  const aggregates = aggregatesBag(root);
  for (const field of ['spans', 'topSpans', 'renders', 'requests', 'queries', 'stateTransitions']) {
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
 * The metric ids a card node should name.
 *
 * The reported ids intersected with {@link COMPUTED_METRIC_IDS} — and with the
 * entry's own constraint where it declares one — in the tuple's order, so a
 * card row is laid out identically for identical captures. A metric the capture
 * did not report is never named: an empty card is not evidence.
 *
 * @param entry The catalog entry for the card node.
 * @param reading The metric reading.
 * @returns The metric ids, capped.
 */
function metricCardIds(entry: CatalogEntryView, reading: MetricReading): readonly string[] {
  const permitted = new Set(entry.metrics);
  const chosen: string[] = [];
  for (const id of COMPUTED_METRIC_IDS) {
    if (!reading.values.has(id)) {
      continue;
    }
    if (permitted.size > 0 && !permitted.has(id)) {
      continue;
    }
    chosen.push(id);
  }
  return chosen.slice(0, MAX_METRIC_CARDS);
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
  if (entry.kinds.length === 0) {
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

  const kinds =
    reported.size === 0 ? entry.kinds : entry.kinds.filter((kind) => reported.has(kind));
  return kinds.slice(0, MAX_FILTER_KINDS);
}

/**
 * Builds the panel specification of a capture from its structured context.
 *
 * The title comes from the panel-title frame and the summary from the
 * summary-headline frame, emitted as a **string**: a string summary is stored as
 * the panel's non-evidentiary headline, and a string can never become an
 * observed fact — the panel's facts and causes are copied by the panel
 * normaliser from the validated analysis, which is what keeps the evidence rule
 * intact across the boundary. The layout is the catalog entries whose declared
 * sources the capture has material for, in the catalog's own order.
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

  const catalog = [...readNodeCatalog(root)].sort((left, right) =>
    left.index === right.index ? compareStrings(left.type, right.type) : left.index - right.index,
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

    const source = entry.sources.find((candidate) => isMaterialSource(candidate, counts));

    if (source === METRICS_SOURCE) {
      const metrics = metricCardIds(entry, reading);
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
      const location = readSuggestedLocation(root);
      if (location === undefined) {
        continue;
      }
      emittedTypes.add(entry.type);
      layout.push({ type: entry.type, location: locationToJson(location) });
      continue;
    }

    const kinds = filterKindsFor(entry, root);
    const filter: JsonObject = {
      ...(traceId !== undefined ? { traceId } : {}),
      ...(kinds.length > 0 ? { kinds: [...kinds] } : {}),
    };
    const hasFilter = entry.supportsFilter && Object.keys(filter).length > 0;

    emittedTypes.add(entry.type);
    layout.push({
      type: entry.type,
      source,
      ...(hasFilter ? { filter } : {}),
      ...(entry.sort !== undefined ? { sort: entry.sort } : {}),
      ...(entry.limit !== undefined ? { limit: entry.limit } : {}),
    });
  }

  const material = [...counts.keys()].some((source) => isMaterialSource(source, counts));
  const countedNouns: CountedNoun[] = [];
  for (const id of COMPUTED_METRIC_IDS) {
    const value = reading.values.get(id);
    if (value === undefined || !Object.hasOwn(METRIC_COUNT_NOUNS, id)) {
      continue;
    }
    if (countedNouns.length >= MAX_METRIC_CARDS) {
      break;
    }
    countedNouns.push({ count: value, noun: metricCountNoun(id) });
  }

  const summary = material ? panelSummaryHeadline(countedNouns, totalMs) : EMPTY_CAPTURE_NOTICE;

  return {
    title: panelTitle(
      problemCategoryLabel(understanding.category ?? ''),
      understanding.target?.label,
    ),
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
 * Builds the follow-up decision of a request from its structured context.
 *
 * The decision is made from what the context reports about the **existing**
 * capture: the signals it asked for against the signals it recorded, the gaps
 * it names explicitly, and whether its aggregates carry anything at all. The
 * new request's wording plays no part — it is not read, and the dispatch cannot
 * supply it.
 *
 * Two outcomes, both additive by construction:
 *
 * - Nothing missing, so the existing evidence is re-analysed with no new
 *   instrumentation. That is the smallest safe answer, and it is the one an
 *   unknown context gets: a context that carries no capture bag at all reports
 *   no gap, and asking for instrumentation on no information would modify a
 *   developer's project for nothing.
 * - A signal genuinely absent, so a new capture is asked for along with the
 *   actions that would collect it. Only actions the catalog claims, only
 *   actions the context does not report as already installed, and never a
 *   removal — a follow-up plan is the previous plan plus these.
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

  const captured = new Set<string>(
    canonicalSignals([
      ...readStringSet(captureBag, 'capturedSignals', 'signals', 'kinds'),
      ...readStringSet(root, 'capturedSignals'),
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
  // carried a capture bag, and reports nothing material in it, establishes that
  // the capture itself yielded nothing.
  const capturePresent = captureBag !== undefined || counts.size > 0;
  const material = [...counts.keys()].some((source) => isMaterialSource(source, counts));
  const emptyCapture = capturePresent && !material;

  const needsNewCapture = gaps.length > 0 || emptyCapture;
  if (!needsNewCapture) {
    return { needsNewCapture: false, additionalActions: [] };
  }

  const installed = new Set<string>();
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
        installed.add(`${file}|${symbol}|${type}`);
      }
    }
  }

  const candidates = sortCandidates(readCandidates(root, understanding));
  const additionalActions: JsonObject[] = [];
  const emitted = new Set<string>();
  for (const gap of gaps) {
    if (additionalActions.length >= MAX_ADDITIONAL_ACTIONS) {
      break;
    }
    for (const type of SIGNAL_ACTION_TYPES[gap] ?? []) {
      if (!catalog.claimed.has(type)) {
        continue;
      }
      for (const candidate of candidates) {
        if (additionalActions.length >= MAX_ADDITIONAL_ACTIONS) {
          break;
        }
        if (!candidate.actionTypes.includes(type)) {
          continue;
        }
        const key = `${candidate.file}|${candidate.symbol}|${type}`;
        if (installed.has(key) || emitted.has(key)) {
          continue;
        }
        emitted.add(key);
        additionalActions.push(instrumentationTarget(candidate.file, candidate.symbol, type));
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
