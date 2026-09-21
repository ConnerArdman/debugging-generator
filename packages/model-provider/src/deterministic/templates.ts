/**
 * The prose layer of the deterministic provider — every sentence a deterministic
 * run can put in front of a developer, as a named frame with the
 * project-specific nouns left out.
 *
 * `DEBUGGEN_PROVIDER=deterministic` is what every automated test and the whole
 * end-to-end suite runs against (AAP §0.5.3, §0.7.1 Group 0), and AAP §0.2.5
 * ships **no recorded model responses**. So nothing a deterministic run displays
 * can be a recording: each sentence is *computed*, from a frame declared here,
 * filled with values `./rules.ts` took from the structured stage input. This
 * module is therefore product copy, not a test stub — it is read by a developer
 * in every offline run and in the scripted walkthrough of `docs/DEMO.md`.
 *
 * ## The split with `./rules.ts`
 *
 * The folder holds exactly two modules and the division between them is what
 * makes AAP §0.5.4's anti-hardcoding guarantee satisfiable by construction:
 *
 * - `./rules.ts` decides **what** to say. It reads the structured input, ranks
 *   candidates, detects evidence patterns numerically and attaches the
 *   `confidence` value of a hypothesis. It never sees the developer's wording,
 *   because the provider hands each per-stage builder the structured input
 *   alone.
 * - this module decides **how it reads**. It never sees a project's nouns,
 *   because they arrive as arguments. It holds no branch on captured telemetry,
 *   no input parsing, no schema knowledge and no data access.
 *
 * Both halves have to stay true. A comparison against captured data written
 * here belongs in `./rules.ts`; a sentence assembled from string fragments in
 * `./rules.ts` belongs here.
 *
 * ## Three constraints every frame below obeys
 *
 * 1. **No project knowledge.** `scripts/check-no-hardcoding.mjs` lists
 *    `packages/model-provider/src/deterministic` in its `STRUCTURED_TREES`, so
 *    this file is matched twice: once as a TypeScript AST and once as raw text,
 *    comments and documentation examples included. A single identifier drawn
 *    from the corpus in `scripts/no-hardcoding.policy.json` — in a string, an
 *    identifier or a `@example` — fails the gate. Every example here therefore
 *    uses placeholder tokens (`‹symbol›`, `‹component›`, `‹route›`, `‹n›`) and
 *    the prose stays in ordinary lowercase words that no camel-case policy
 *    entry can match.
 * 2. **Wording invariance.** No frame receives, inspects or echoes the
 *    developer's prose. Every parameter is an enum-ish value, a count, a
 *    duration or a label, and wording is selected by table lookup keyed on a
 *    fixed value — never by a string comparison over free text. That is what
 *    lets `providers/deterministic.test.ts` assert that two requests differing
 *    only in wording produce byte-identical output.
 * 3. **No conclusions.** AAP §0.8.4 keeps observed facts and inferred causes
 *    structurally apart, and `packages/panel-schema`'s semantic validation
 *    enforces it downstream. So the observed-fact frames below restate a count
 *    or a measurement and stop; the likely-cause frames name an evidence
 *    pattern and the standard, mechanically-true explanation for that *class*
 *    of pattern, with every noun interpolated. No frame asserts a verdict about
 *    a particular project, subsystem or file, and no frame carries confidence
 *    wording — `./rules.ts` attaches the numeric `confidence` field.
 *
 * ## Purity contract
 *
 * Determinism here is a product feature, so this module performs no I/O, reads
 * no environment, holds no mutable module state and caches nothing. It reads no
 * clock and draws no randomness: {@link roundMs} and {@link clampNonNegative}
 * are imported from `@debuggen/shared` because both are pure, while that same
 * barrel's clock readers (`nowEpochMs`, `nowEpochMsPrecise`) and id generators
 * (`newId`, `newTraceId` and siblings, all of which draw on Web Crypto) are
 * deliberately not imported. Importing this module has no observable effect,
 * and every exported function is referentially transparent: the same arguments
 * produce a byte-identical string, forever.
 *
 * ## Totality
 *
 * Every accessor answers an unrecognised key with a documented generic
 * fallback, and every frame answers any in-range argument with one complete,
 * grammatical sentence. That matters twice over: `noUncheckedIndexedAccess`
 * makes each table read `string | undefined` and this module resolves that with
 * a fallback rather than an assertion, and an enumeration extended in another
 * package degrades to plain prose here instead of printing `undefined` into a
 * sentence. Blank and over-long labels are handled the same way, by
 * {@link sanitizeLabel} and {@link truncateLabel}, so no frame can emit an
 * empty interpolation slot or an unbounded string.
 *
 * @module
 */
import { clampNonNegative, roundMs } from '@debuggen/shared';

/* -------------------------------------------------------------------------------------------------
 * shapes
 * ---------------------------------------------------------------------------------------------- */

/**
 * The two English forms of a countable noun, so that pluralisation is decided
 * once here rather than at each frame.
 *
 * Both forms are required. An optional plural would mean a caller could omit
 * the irregular case that needed it, and the frames below are the only place
 * the forms are read.
 */
export interface NounForms {
  /** The form used for exactly one, as in `1 ‹singular›`. */
  readonly singular: string;
  /** The form used for every other count, including zero. */
  readonly plural: string;
}

/**
 * A count and the noun it counts, as {@link panelSummaryHeadline} consumes it.
 *
 * `./rules.ts` builds one of these per metric the capture actually reports,
 * taking the noun from {@link metricCountNoun} so the prose stays in this
 * module and the selection stays in that one.
 */
export interface CountedNoun {
  /** How many. Non-finite, negative and fractional values are normalised by {@link formatCount}. */
  readonly count: number;
  /** The noun to render in the form the count requires. */
  readonly noun: NounForms;
}

/* -------------------------------------------------------------------------------------------------
 * formatting policy
 * ---------------------------------------------------------------------------------------------- */

/**
 * Decimal places kept when a duration is rendered as text.
 *
 * AAP §0.2.3 fixes the product's time base at epoch milliseconds with
 * millisecond durations, and `roundMs`'s own documented floor for a *stored*
 * value is three decimals. Prose is a narrower problem than storage: a tenth of
 * a millisecond is the smallest difference worth reading in a sentence, and
 * three decimals would put floating-point noise in front of the developer. One
 * decimal is therefore the presentation policy, applied by
 * {@link formatDurationMs} and by nothing else, so every duration in every
 * deterministic sentence carries the same digits.
 */
export const DURATION_DECIMALS = 1;

/**
 * Longest interpolated label a frame will emit, in characters.
 *
 * AAP §0.5.2 caps a captured preview at 120 characters and this matches it: a
 * statement, a URL or an owner chain arrives as a label of unknown length, and
 * a template must never be the thing that makes an output unbounded.
 * {@link truncateLabel} applies the cap, {@link TRUNCATION_MARKER} shows where
 * it fell.
 */
export const LABEL_MAX_LENGTH = 120;

/** Fixed marker appended by {@link truncateLabel} when it shortens a label. */
export const TRUNCATION_MARKER = '…';

/** Separator between two steps of a rendered flow path. */
export const FLOW_PATH_SEPARATOR = ' → ';

/**
 * Steps {@link flowPathLabel} renders before it summarises the remainder.
 *
 * A code-graph path can be arbitrarily long; a readable one is not. Beyond this
 * many steps the path is cut and the count of the dropped steps is appended, so
 * the rendered length stays bounded without losing the fact that more existed.
 */
export const FLOW_PATH_MAX_NODES = 12;

/** Longest rendered flow path in characters, applied after the step cap. */
export const FLOW_PATH_MAX_LENGTH = 240;

/** Separator between list items that are not the last pair. */
export const LIST_SEPARATOR = ', ';

/** Conjunction joining the final pair of a rendered list. */
export const LIST_CONJUNCTION = ' and ';

/** Items {@link joinWithConjunction} renders before it summarises the remainder. */
export const LIST_MAX_ITEMS = 6;

/** Word closing the overflow item {@link joinWithConjunction} appends, as in `‹n› more`. */
export const LIST_OVERFLOW_WORD = 'more';

/** Rendered for a step of a flow path whose label arrived blank. */
export const UNNAMED_FLOW_STEP_LABEL = 'an unnamed step';

/** Rendered by {@link flowPathLabel} when it is given no steps at all. */
export const EMPTY_FLOW_PATH_LABEL = 'no recorded path';

/** Rendered in place of an operation or span name that arrived blank. */
export const UNNAMED_OPERATION_LABEL = 'an unnamed operation';

/** Rendered in place of a component name that arrived blank. */
export const UNNAMED_COMPONENT_LABEL = 'an unnamed component';

/** Rendered in place of a symbol name that arrived blank. */
export const UNNAMED_SYMBOL_LABEL = 'an unnamed symbol';

/** Rendered in place of a related signal or entity name that arrived blank. */
export const UNNAMED_ENTITY_LABEL = 'an unnamed entity';

/** Rendered in place of a `file:line` call-site label that arrived blank. */
export const UNRESOLVED_CALL_SITE_LABEL = 'an unresolved call site';

/** Rendered in place of a database statement that arrived blank. */
export const UNNAMED_STATEMENT_LABEL = 'an unnamed statement';

/**
 * Stands in for an endpoint nobody named.
 *
 * The duplicate-request frames keep the endpoint itself out of their fixed
 * text — `./rules.ts` interpolates it — and fall back to this generic phrase
 * when no endpoint label is available, which is the shape AAP's own wording
 * uses: `‹n› requests to the same endpoint occurred within ‹window› ms`.
 */
export const SAME_ENDPOINT_LABEL = 'the same endpoint';

/** Rendered by {@link panelSummaryHeadline} when no count and no duration were reported. */
export const NO_MEASURED_ACTIVITY_LABEL = 'no measured activity';

/**
 * The wording for AAP §0.5.5's "capture yielded nothing" path.
 *
 * A capture that recorded nothing is not a finding and must never be presented
 * as one, so this notice says only what happened and what to do next. It is
 * non-evidentiary prose by construction: it states no count, cites no evidence
 * and makes no claim that would need substantiating, which is what lets
 * `./rules.ts` return it as the smallest valid output for an empty capture.
 */
export const EMPTY_CAPTURE_NOTICE =
  'No telemetry was recorded for this capture, so there is nothing to summarise yet. Reproduce the behaviour with a capture running, then capture again.';

/* -------------------------------------------------------------------------------------------------
 * formatting helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Reduces a label to one line, bounded, and substitutes `fallback` when nothing
 * is left.
 *
 * Every frame runs its interpolated labels through this, which is what makes
 * them total: a missing value, an empty string, a value that is only
 * whitespace, and a multi-line value are all answered with something that reads
 * as a sentence rather than with a hole in one. Whitespace runs — spaces, tabs
 * and newlines alike — collapse to a single space so a symbol chain or a
 * statement cannot break the line, and the result is capped by
 * {@link truncateLabel}.
 *
 * @param value The label to clean, or `undefined` when the caller has none.
 * @param fallback What to render instead when `value` carries no characters.
 * Pass one of this module's `UNNAMED_*` constants; a blank fallback would
 * defeat the purpose and is returned as given.
 * @returns A non-empty single-line label, unless `fallback` itself was blank.
 * @example
 * // sanitizeLabel(undefined, UNNAMED_SYMBOL_LABEL) === 'an unnamed symbol'
 * // sanitizeLabel('  ‹symbol›\n', UNNAMED_SYMBOL_LABEL) === '‹symbol›'
 */
export function sanitizeLabel(value: string | undefined, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length === 0 ? fallback : truncateLabel(collapsed);
}

/**
 * Caps a label's length, marking the cut with {@link TRUNCATION_MARKER}.
 *
 * This is the truncation helper `./rules.ts` uses for any string it
 * interpolates, so one policy bounds every rendered label. A value already
 * within the cap is returned unchanged, character for character.
 *
 * @param value The label to bound.
 * @param maxLength Characters to keep, marker included; defaults to
 * {@link LABEL_MAX_LENGTH}. A non-finite value falls back to that default and a
 * value below the marker's own length yields the marker alone.
 * @returns A string of at most `maxLength` characters.
 */
export function truncateLabel(value: string, maxLength: number = LABEL_MAX_LENGTH): string {
  const cap = Number.isFinite(maxLength)
    ? Math.floor(clampNonNegative(maxLength))
    : LABEL_MAX_LENGTH;
  if (value.length <= cap) {
    return value;
  }
  const keep = Math.max(0, cap - TRUNCATION_MARKER.length);
  return `${value.slice(0, keep).trimEnd()}${TRUNCATION_MARKER}`;
}

/**
 * Renders a millisecond measurement as text, without a unit.
 *
 * The rounding runs through `@debuggen/shared`'s {@link roundMs} so a duration
 * reads the same here as it does in a stored event or a panel-data response,
 * and the value is clamped first, because a sentence must never contain
 * `NaN`, `Infinity` or a negative duration. Locale-sensitive formatting is
 * forbidden throughout this module — no `toLocaleString`, no `Intl` — because
 * the output would then depend on the environment the service happens to run
 * in, and two runs of the same capture would disagree.
 *
 * @param value A duration in milliseconds. Non-finite and negative values are
 * rendered as `0`.
 * @returns The rounded value as digits, with no unit and no separators.
 */
export function formatDurationMs(value: number): string {
  const safe = Number.isFinite(value) ? clampNonNegative(value) : 0;
  return String(roundMs(safe, DURATION_DECIMALS));
}

/**
 * Renders a count as a non-negative integer.
 *
 * Counts arrive from aggregates that a degraded capture can leave incomplete,
 * so this normalises rather than trusts: a fraction is floored, a negative
 * value and a non-finite value both become `0`. No frame can print `NaN` as a
 * quantity as a result.
 *
 * @param value The count to render.
 * @returns The normalised count as digits.
 */
export function formatCount(value: number): string {
  return String(normalizeCount(value));
}

/**
 * Chooses the form of `noun` that `count` requires.
 *
 * Zero takes the plural, as English does: `0 ‹plural›`. The count is normalised
 * by the same rule {@link formatCount} applies, so a fractional or unusable
 * input cannot select a form the rendered number contradicts.
 *
 * @param count How many.
 * @param noun The noun's two forms.
 * @returns `noun.singular` when the normalised count is exactly one, otherwise
 * `noun.plural`.
 */
export function pluralizeNoun(count: number, noun: NounForms): string {
  return normalizeCount(count) === 1 ? noun.singular : noun.plural;
}

/**
 * Renders a count and its noun together, agreeing in number.
 *
 * The one place `1 ‹singular›` versus `‹n› ‹plural›` is decided, so no frame
 * repeats the rule.
 *
 * @param count How many.
 * @param noun The noun's two forms.
 * @returns The count followed by a single space and the appropriate form.
 * @example
 * // countLabel(1, { singular: 'render', plural: 'renders' }) === '1 render'
 * // countLabel(4, { singular: 'render', plural: 'renders' }) === '4 renders'
 */
export function countLabel(count: number, noun: NounForms): string {
  return `${formatCount(count)} ${pluralizeNoun(count, noun)}`;
}

/**
 * Joins labels into one readable list, bounded in length.
 *
 * Blank entries are dropped rather than rendered as gaps, the list is cut at
 * {@link LIST_MAX_ITEMS} with the number of dropped entries appended as a final
 * item, and an empty result is answered with `emptyFallback` so a caller's
 * sentence still reads. Ordering is the caller's: `./rules.ts` sorts before it
 * renders, and this helper preserves what it is given.
 *
 * @param items The labels to join, already in their intended order.
 * @param emptyFallback What to render when no item carries characters.
 * @returns A single string, never empty unless `emptyFallback` was.
 * @example
 * // joinWithConjunction(['‹a›', '‹b›', '‹c›'], NO_MEASURED_ACTIVITY_LABEL)
 * //   === '‹a›, ‹b› and ‹c›'
 */
export function joinWithConjunction(items: readonly string[], emptyFallback: string): string {
  const cleaned: string[] = [];
  for (const item of items) {
    const collapsed = item.replace(/\s+/g, ' ').trim();
    if (collapsed.length > 0) {
      cleaned.push(truncateLabel(collapsed));
    }
  }
  if (cleaned.length === 0) {
    return emptyFallback;
  }

  const rendered =
    cleaned.length > LIST_MAX_ITEMS
      ? [
          ...cleaned.slice(0, LIST_MAX_ITEMS),
          `${formatCount(cleaned.length - LIST_MAX_ITEMS)} ${LIST_OVERFLOW_WORD}`,
        ]
      : cleaned;

  const last = rendered[rendered.length - 1];
  if (rendered.length === 1 || last === undefined) {
    return rendered.join(LIST_SEPARATOR);
  }
  return `${rendered.slice(0, -1).join(LIST_SEPARATOR)}${LIST_CONJUNCTION}${last}`;
}

/**
 * Normalises a count to a non-negative integer, the rule every count-rendering
 * helper in this module shares.
 *
 * @param value The count to normalise.
 * @returns A non-negative integer; `0` for a non-finite input.
 */
function normalizeCount(value: number): number {
  return Number.isFinite(value) ? Math.floor(clampNonNegative(value)) : 0;
}

/**
 * Upper-cases the first character of a label, leaving the rest untouched.
 *
 * `toUpperCase` is deliberate: `toLocaleUpperCase` would make a title depend on
 * the environment's locale, which this module's purity contract forbids.
 *
 * @param value The label to capitalise.
 * @returns The label with its first character upper-cased.
 */
function capitalizeFirst(value: string): string {
  const first = value.charAt(0);
  return first.length === 0 ? value : `${first.toUpperCase()}${value.slice(1)}`;
}

/**
 * Reads a label table, applying `fallback` for a key the table does not carry.
 *
 * The single answer to `noUncheckedIndexedAccess` for every table in this
 * module: an indexed read is `string | undefined`, and resolving that with a
 * fallback — never with `!` and never with a cast — is what keeps an
 * enumeration extended elsewhere from printing `undefined` into a sentence. An
 * entry present but blank is treated as absent for the same reason.
 *
 * @param table The label table to read.
 * @param key The value to look up, accepted as a plain string so a vocabulary
 * that grows in another package still resolves here.
 * @param fallback The documented generic label for an unrecognised key.
 * @returns The table's label, or `fallback`.
 */
function lookupLabel(
  table: Readonly<Record<string, string>>,
  key: string,
  fallback: string,
): string {
  const label = table[key];
  return label === undefined || label.length === 0 ? fallback : label;
}

/**
 * {@link lookupLabel} for a table of noun forms rather than of single labels.
 *
 * Two accessors exist rather than one generic because the fallback types differ
 * and a shared signature would have to be generic over the value type for no
 * gain: the union-keyed tables widen to a string-keyed parameter here exactly
 * as they do above, which is what makes the indexed read expressible without a
 * cast.
 *
 * @param table The noun table to read.
 * @param key The value to look up, accepted as a plain string.
 * @param fallback The documented generic noun for an unrecognised key.
 * @returns The table's noun forms, or `fallback`.
 */
function lookupNoun(
  table: Readonly<Record<string, NounForms>>,
  key: string,
  fallback: NounForms,
): NounForms {
  const noun = table[key];
  return noun === undefined ? fallback : noun;
}

/* -------------------------------------------------------------------------------------------------
 * label vocabularies
 *
 * Five tables, each keyed by a value another layer of the product fixes, and
 * each read through an accessor that takes a plain `string`. The widened
 * parameter is deliberate: the stage modules that produce these values are
 * free to grow their vocabularies, and a value this module has no entry for
 * must degrade to plain prose rather than reach a sentence as `undefined`.
 *
 * Every table is frozen. They are module-level and read on every render, so a
 * mutation would silently rewrite the wording of every later run in the
 * process.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The problem categories this module has wording for.
 *
 * The category is *pre-classified* upstream — `./rules.ts` echoes what the
 * structured input carries and never derives one from prose — so this union is
 * a vocabulary of display wording, not a closed enumeration this folder owns.
 * {@link problemCategoryLabel} accepts any string for exactly that reason.
 *
 * The entries cover the classes of behaviour the product is built to
 * investigate: time spent in one interaction across tiers, work repeated more
 * often than the developer expected, and outright failures.
 */
export type ProblemCategory =
  | 'slow-interaction'
  | 'slow-request'
  | 'slow-query'
  | 'excessive-renders'
  | 'duplicate-requests'
  | 'unexpected-state'
  | 'blocked-main-thread'
  | 'runtime-error';

/** Display wording per {@link ProblemCategory}, lower-case so a frame can embed or capitalise it. */
export const PROBLEM_CATEGORY_LABELS: Readonly<Record<ProblemCategory, string>> = Object.freeze({
  'slow-interaction': 'slow interaction',
  'slow-request': 'slow request',
  'slow-query': 'slow database query',
  'excessive-renders': 'excessive rendering',
  'duplicate-requests': 'duplicate requests',
  'unexpected-state': 'unexpected state change',
  'blocked-main-thread': 'blocked main thread',
  'runtime-error': 'runtime error',
});

/**
 * Wording for a category this module has no entry for.
 *
 * Deliberately colourless: an unrecognised category means the classification is
 * newer than this table, and the honest rendering says that the behaviour is
 * the subject without implying anything about its nature.
 */
export const PROBLEM_CATEGORY_FALLBACK_LABEL = 'reported behaviour';

/**
 * The eight instrumentation action types AAP §0.2.3 fixes.
 *
 * These are product vocabulary, defined by `@debuggen/instrumentation`'s plan
 * schema rather than by any target project, which is why naming them here is
 * correct and carries no project knowledge. `./rules.ts` owns the tuple it
 * validates emitted actions against; this table owns how each one reads.
 */
export type InstrumentationActionType =
  | 'function-timing'
  | 'server-span'
  | 'react-render-tracking'
  | 'fetch-tracking'
  | 'db-query-tracking'
  | 'state-tracking'
  | 'interaction-tracking'
  | 'perf-tracking';

/** Display wording per {@link InstrumentationActionType}, phrased as the signal it collects. */
export const INSTRUMENTATION_ACTION_TYPE_LABELS: Readonly<
  Record<InstrumentationActionType, string>
> = Object.freeze({
  'function-timing': 'function timing',
  'server-span': 'server span timing',
  'react-render-tracking': 'render tracking',
  'fetch-tracking': 'request tracking',
  'db-query-tracking': 'database query tracking',
  'state-tracking': 'state transition tracking',
  'interaction-tracking': 'interaction timing',
  'perf-tracking': 'performance entry tracking',
});

/** Wording for an action type this module has no entry for. */
export const INSTRUMENTATION_ACTION_TYPE_FALLBACK_LABEL = 'runtime measurement';

/** The three telemetry tiers AAP §0.2.3 fixes. */
export type TelemetryTier = 'browser' | 'server' | 'db';

/**
 * Display wording per {@link TelemetryTier}.
 *
 * `db` reads as `database` because the abbreviation is a field name, not
 * something to put in a sentence; the other two already read as themselves.
 */
export const TELEMETRY_TIER_LABELS: Readonly<Record<TelemetryTier, string>> = Object.freeze({
  browser: 'browser',
  server: 'server',
  db: 'database',
});

/**
 * Wording for a tier this module has no entry for, and for a span whose tier
 * never arrived — correlation attaches such a span to the trace root with a
 * flag rather than dropping it, so a sentence may still have to name it.
 */
export const TELEMETRY_TIER_FALLBACK_LABEL = 'unattributed';

/**
 * The capture signals a plan's `capture[]` may carry.
 *
 * One entry per telemetry event kind AAP §0.2.3 fixes, because the kinds are
 * precisely the signals a capture can be asked for: the browser agent's
 * interaction, render, commit, state, request, navigation, performance and
 * error kinds, and the Node preload's incoming-request, route-handler,
 * function, query, outgoing-request, error and log kinds.
 */
export type CaptureSignal =
  | 'interaction'
  | 'render'
  | 'commit'
  | 'fetch'
  | 'xhr'
  | 'navigation'
  | 'perf.longtask'
  | 'perf.entry'
  | 'error'
  | 'state'
  | 'http.server'
  | 'route.handler'
  | 'function'
  | 'db.query'
  | 'http.client'
  | 'server.error'
  | 'log';

/** Display wording per {@link CaptureSignal}, phrased as the plural a capture list reads with. */
export const CAPTURE_SIGNAL_LABELS: Readonly<Record<CaptureSignal, string>> = Object.freeze({
  interaction: 'interaction timing',
  render: 'renders',
  commit: 'render commits',
  fetch: 'browser requests',
  xhr: 'legacy browser requests',
  navigation: 'navigations',
  'perf.longtask': 'long tasks',
  'perf.entry': 'performance entries',
  error: 'browser errors',
  state: 'state transitions',
  'http.server': 'incoming server requests',
  'route.handler': 'route handler timing',
  function: 'function timing',
  'db.query': 'database queries',
  'http.client': 'outgoing server requests',
  'server.error': 'server errors',
  log: 'log records',
});

/** Wording for a capture signal this module has no entry for. */
export const CAPTURE_SIGNAL_FALLBACK_LABEL = 'runtime signals';

/**
 * The kinds of node a code graph reports.
 *
 * `@debuggen/code-analysis` builds these from its extractors — files, symbols,
 * components, event handlers, request call sites, route handlers, server
 * functions and database call sites — so, like the action types, they are
 * product vocabulary rather than anything a target project names.
 */
export type CodeSymbolKind =
  | 'file'
  | 'symbol'
  | 'component'
  | 'event-handler'
  | 'api-call'
  | 'api-route'
  | 'server-function'
  | 'db-call';

/** Display wording per {@link CodeSymbolKind}, phrased to sit after `this` in a sentence. */
export const CODE_SYMBOL_KIND_LABELS: Readonly<Record<CodeSymbolKind, string>> = Object.freeze({
  file: 'file',
  symbol: 'symbol',
  component: 'component',
  'event-handler': 'event handler',
  'api-call': 'request call site',
  'api-route': 'route handler',
  'server-function': 'server function',
  'db-call': 'database call site',
});

/** Wording for a code-graph node kind this module has no entry for. */
export const CODE_SYMBOL_KIND_FALLBACK_LABEL = 'symbol';

/**
 * The evidence-pattern classes the likely-cause frames cover.
 *
 * `./rules.ts` detects a pattern numerically from the aggregates — a duplicate
 * group above one, an unchanged-input render count materially above zero, one
 * span covering most of an interaction's total, a statement repeated within one
 * interaction — and then calls the frame for that class. The mapping is fixed
 * and one-to-one:
 *
 * | Pattern                     | Frame                                 |
 * | --------------------------- | ------------------------------------- |
 * | `duplicate-requests`        | {@link duplicateRequestCause}         |
 * | `unchanged-input-renders`   | {@link unchangedInputRenderCause}     |
 * | `dominant-span`             | {@link dominantSpanCause}             |
 * | `repeated-query-shape`      | {@link repeatedQueryShapeCause}       |
 *
 * The union exists so that adding a pattern in `./rules.ts` without a frame
 * here is a compile-time question rather than a runtime surprise, and so both
 * modules name the classes identically.
 */
export type EvidencePattern =
  'duplicate-requests' | 'unchanged-input-renders' | 'dominant-span' | 'repeated-query-shape';

/**
 * Short display wording per {@link EvidencePattern}, for a caller that needs to
 * name the pattern outside a full sentence — a grouping label above a set of
 * hypotheses, for instance.
 */
export const EVIDENCE_PATTERN_LABELS: Readonly<Record<EvidencePattern, string>> = Object.freeze({
  'duplicate-requests': 'identical requests repeated from one call site',
  'unchanged-input-renders': 'renders with unchanged inputs',
  'dominant-span': 'one operation covering most of the interaction',
  'repeated-query-shape': 'one statement repeated within an interaction',
});

/** Wording for an evidence pattern this module has no entry for. */
export const EVIDENCE_PATTERN_FALLBACK_LABEL = 'a repeated pattern in the captured evidence';

/* -------------------------------------------------------------------------------------------------
 * countable nouns
 * ---------------------------------------------------------------------------------------------- */

/**
 * The computed metric ids of AAP §0.2.3 that count things rather than measure
 * them, in the order that plan fixes.
 *
 * **A deliberate restatement of a vocabulary another package owns**, like the
 * action-type and tier keys above it. The single definition is `METRIC_IDS` in
 * `packages/telemetry/src/schema/attributes.ts`, whose `COUNT_METRIC_IDS`
 * group is exactly these eight ids in exactly this order, and that module's
 * documentation names this file as the consumer restating them. Deriving the
 * union from there is not available: AAP §0.2.2's edge list gives this package
 * one `@debuggen` dependency, `@debuggen/shared`, and AAP §0.5.3 is the reason
 * — the provider boundary stays free of telemetry, plan and panel types so
 * that nothing can be sent to a model implicitly. `eslint.config.js` enforces
 * it per workspace, so an import of `@debuggen/telemetry` here, even a
 * type-only one in a test, fails `pnpm lint`.
 *
 * What the restatement is allowed to cost is bounded in three ways, and a
 * maintainer changing the canonical group should know all three:
 *
 * 1. **Mirror a change here, in canonical order.** The telemetry group is the
 *    authority; this list follows it, and
 *    `packages/telemetry/src/schema/attributes.test.ts` enforces that by
 *    reading *this declaration and the table below out of this file* and
 *    comparing them with `COUNT_METRIC_IDS`. A divergence fails that suite; so
 *    does renaming this type or moving this file, which is deliberate — the
 *    check must break loudly rather than quietly stop checking.
 * 2. **An unmirrored addition degrades, it does not break.**
 *    {@link metricCountNoun} takes a plain `string` and falls back to
 *    {@link FALLBACK_COUNT_NOUN}, so a metric added there and not here reads
 *    as `‹n› recorded items` — plain, grammatical, and never `undefined`.
 * 3. **A half-mirrored change is a compile error.**
 *    {@link METRIC_COUNT_NOUNS} is keyed by this union and must be total, so a
 *    member removed here leaves its noun behind as an excess property and a
 *    member added here without one is a missing key. The union and its table
 *    can drift from the authority; they cannot drift from each other.
 */
export type CountMetricId =
  | 'render_count'
  | 'unchanged_render_count'
  | 'render_trigger_unknown_count'
  | 'request_count'
  | 'query_count'
  | 'duplicate_request_count'
  | 'long_task_count'
  | 'error_count';

/**
 * The noun each counting metric reads with.
 *
 * `./rules.ts` selects which metrics a headline mentions — it knows which ones
 * the capture reported — and takes the wording from here through
 * {@link metricCountNoun}, so the prose stays in this module and the selection
 * stays in that one.
 *
 * Keyed by {@link CountMetricId} and therefore total — every member has a noun
 * — and written in that union's canonical order, so the two read as one list
 * and a mirrored change to either is a one-line diff in both.
 *
 * `unchanged_render_count` is worded to AAP §0.2.3's precise meaning: props
 * shallow-equal, own hook state unchanged **and** no consumed context value
 * changed. A render whose trigger could not be determined is counted separately
 * as `render_trigger_unknown_count` and is never described as unchanged, which
 * is why the two have distinct nouns here and distinct frames below.
 */
export const METRIC_COUNT_NOUNS: Readonly<Record<CountMetricId, NounForms>> = Object.freeze({
  render_count: Object.freeze({ singular: 'render', plural: 'renders' }),
  unchanged_render_count: Object.freeze({
    singular: 'render with unchanged inputs',
    plural: 'renders with unchanged inputs',
  }),
  render_trigger_unknown_count: Object.freeze({
    singular: 'render with an undetermined trigger',
    plural: 'renders with an undetermined trigger',
  }),
  request_count: Object.freeze({ singular: 'request', plural: 'requests' }),
  query_count: Object.freeze({ singular: 'database query', plural: 'database queries' }),
  duplicate_request_count: Object.freeze({
    singular: 'duplicate request',
    plural: 'duplicate requests',
  }),
  long_task_count: Object.freeze({ singular: 'long task', plural: 'long tasks' }),
  error_count: Object.freeze({ singular: 'error', plural: 'errors' }),
});

/**
 * The noun for a counting metric this module has no entry for.
 *
 * AAP §0.2.3's metric set is fixed today, but it is computed in another package
 * and may grow; a metric with no noun here still has to read as English.
 */
export const FALLBACK_COUNT_NOUN: NounForms = Object.freeze({
  singular: 'recorded item',
  plural: 'recorded items',
});

/** `1 time` / `‹n› times`, for frames that count repetitions of an event. */
const TIME_NOUN: NounForms = Object.freeze({ singular: 'time', plural: 'times' });

/** `1 occurrence` / `‹n› occurrences`, for frames that count members of a group. */
const OCCURRENCE_NOUN: NounForms = Object.freeze({
  singular: 'occurrence',
  plural: 'occurrences',
});

/** `1 identical request` / `‹n› identical requests`, for the duplicate-request cause frame. */
const IDENTICAL_REQUEST_NOUN: NounForms = Object.freeze({
  singular: 'identical request',
  plural: 'identical requests',
});

/** `1 step` / `‹n› steps`, for the overflow tail of a rendered flow path. */
const STEP_NOUN: NounForms = Object.freeze({ singular: 'step', plural: 'steps' });

/* -------------------------------------------------------------------------------------------------
 * label accessors
 * ---------------------------------------------------------------------------------------------- */

/**
 * Display wording for a pre-classified problem category.
 *
 * @param category The category value the structured input carried.
 * @returns The table's wording, or {@link PROBLEM_CATEGORY_FALLBACK_LABEL}.
 */
export function problemCategoryLabel(category: string): string {
  return lookupLabel(PROBLEM_CATEGORY_LABELS, category, PROBLEM_CATEGORY_FALLBACK_LABEL);
}

/**
 * Display wording for an instrumentation action type.
 *
 * @param actionType One of the eight values AAP §0.2.3 fixes.
 * @returns The table's wording, or
 * {@link INSTRUMENTATION_ACTION_TYPE_FALLBACK_LABEL}.
 */
export function instrumentationActionTypeLabel(actionType: string): string {
  return lookupLabel(
    INSTRUMENTATION_ACTION_TYPE_LABELS,
    actionType,
    INSTRUMENTATION_ACTION_TYPE_FALLBACK_LABEL,
  );
}

/**
 * Display wording for a telemetry tier.
 *
 * @param tier One of the three tiers AAP §0.2.3 fixes.
 * @returns The table's wording, or {@link TELEMETRY_TIER_FALLBACK_LABEL}.
 */
export function telemetryTierLabel(tier: string): string {
  return lookupLabel(TELEMETRY_TIER_LABELS, tier, TELEMETRY_TIER_FALLBACK_LABEL);
}

/**
 * Display wording for a capture signal.
 *
 * @param signal A signal name a plan's `capture[]` carries.
 * @returns The table's wording, or {@link CAPTURE_SIGNAL_FALLBACK_LABEL}.
 */
export function captureSignalLabel(signal: string): string {
  return lookupLabel(CAPTURE_SIGNAL_LABELS, signal, CAPTURE_SIGNAL_FALLBACK_LABEL);
}

/**
 * Display wording for the kind of a code-graph node.
 *
 * @param kind A node kind the code graph reported.
 * @returns The table's wording, or {@link CODE_SYMBOL_KIND_FALLBACK_LABEL}.
 */
export function codeSymbolKindLabel(kind: string): string {
  return lookupLabel(CODE_SYMBOL_KIND_LABELS, kind, CODE_SYMBOL_KIND_FALLBACK_LABEL);
}

/**
 * Short display wording for an evidence-pattern class.
 *
 * @param pattern One of the {@link EvidencePattern} values.
 * @returns The table's wording, or {@link EVIDENCE_PATTERN_FALLBACK_LABEL}.
 */
export function evidencePatternLabel(pattern: string): string {
  return lookupLabel(EVIDENCE_PATTERN_LABELS, pattern, EVIDENCE_PATTERN_FALLBACK_LABEL);
}

/**
 * The noun a counting metric reads with.
 *
 * @param metricId A computed metric id from AAP §0.2.3's fixed set.
 * @returns The metric's noun forms, or {@link FALLBACK_COUNT_NOUN}.
 */
export function metricCountNoun(metricId: string): NounForms {
  return lookupNoun(METRIC_COUNT_NOUNS, metricId, FALLBACK_COUNT_NOUN);
}

/* -------------------------------------------------------------------------------------------------
 * planning frames
 * ---------------------------------------------------------------------------------------------- */

/**
 * The plan's objective sentence.
 *
 * This stands in for the prose objective a model would write, and it is built
 * from a category label plus an optional target label — never from the
 * developer's wording, which is the whole point: two requests that differ only
 * in phrasing classify to the same category and therefore produce the same
 * objective, character for character.
 *
 * The absent-target case is a separate branch rather than an interpolated empty
 * string, so both readings are complete sentences instead of one sentence with
 * a gap where a target would have been.
 *
 * @param categoryLabel Wording from {@link problemCategoryLabel}.
 * @param targetLabel Wording for the selected element or component, when one
 * was selected. A blank value is treated as absent.
 * @returns One sentence stating what the capture is meant to settle.
 * @example
 * // planObjective(problemCategoryLabel('slow-interaction'), '‹component›')
 * // planObjective(problemCategoryLabel('slow-interaction'))
 */
export function planObjective(categoryLabel: string, targetLabel?: string): string {
  const category = sanitizeLabel(categoryLabel, PROBLEM_CATEGORY_FALLBACK_LABEL);
  const target = optionalLabel(targetLabel);
  if (target === undefined) {
    return `Determine what accounts for the ${category} recorded while the reported behaviour is reproduced.`;
  }
  return `Determine what accounts for the ${category} recorded at ${target} while the reported behaviour is reproduced.`;
}

/**
 * Why one instrumentation action is part of the plan.
 *
 * Mechanical by design: it states which signal is being collected and where,
 * and that collecting it is what puts a measurement in the capture instead of
 * leaving that step to be guessed from the timings around it. It makes no claim
 * about what the measurement will show.
 *
 * @param actionTypeLabel Wording from {@link instrumentationActionTypeLabel}.
 * @param targetLabel The symbol or file the action applies to. A blank value
 * falls back to {@link UNNAMED_SYMBOL_LABEL}.
 * @returns One sentence suitable for an action's `rationale` field.
 */
export function instrumentationActionRationale(
  actionTypeLabel: string,
  targetLabel: string,
): string {
  const signal = sanitizeLabel(actionTypeLabel, INSTRUMENTATION_ACTION_TYPE_FALLBACK_LABEL);
  const target = sanitizeLabel(targetLabel, UNNAMED_SYMBOL_LABEL);
  return `Collect ${signal} at ${target}, so that this step is measured in the capture rather than inferred from the timings around it.`;
}

/* -------------------------------------------------------------------------------------------------
 * investigation frames
 * ---------------------------------------------------------------------------------------------- */

/**
 * Why the code investigation surfaced one symbol.
 *
 * The sentence is about the graph, not about the project's behaviour: the
 * relationship it states is the one the index recorded, and nothing follows
 * from it about what the capture will show. `./rules.ts` supplies the second
 * label from whatever produced the match — a needed signal or a named entity.
 *
 * @param symbolKindLabel Wording from {@link codeSymbolKindLabel}.
 * @param relatedLabel The signal or entity this symbol was matched against. A
 * blank value falls back to {@link UNNAMED_ENTITY_LABEL}.
 * @returns One sentence suitable for a relevant file's `reason` field.
 */
export function codeRelevanceReason(symbolKindLabel: string, relatedLabel: string): string {
  const kind = sanitizeLabel(symbolKindLabel, CODE_SYMBOL_KIND_FALLBACK_LABEL);
  const related = sanitizeLabel(relatedLabel, UNNAMED_ENTITY_LABEL);
  return `The code graph associates this ${kind} with ${related}.`;
}

/**
 * An ordered path through the code graph, as one readable line.
 *
 * Total for every input: no steps reads as {@link EMPTY_FLOW_PATH_LABEL}, one
 * step reads as that step alone, and a path longer than
 * {@link FLOW_PATH_MAX_NODES} is cut with the number of dropped steps appended
 * so the line stays bounded without hiding that more existed. The whole result
 * is then capped at {@link FLOW_PATH_MAX_LENGTH}, because the individual step
 * labels are project nouns of unknown length.
 *
 * @param stepLabels The steps in the order they should read. Blank entries are
 * rendered as {@link UNNAMED_FLOW_STEP_LABEL} rather than dropped, so a path's
 * length still reflects the graph.
 * @returns One line with {@link FLOW_PATH_SEPARATOR} between steps.
 * @example
 * // flowPathLabel(['‹a›', '‹b›', '‹c›']) === '‹a› → ‹b› → ‹c›'
 */
export function flowPathLabel(stepLabels: readonly string[]): string {
  if (stepLabels.length === 0) {
    return EMPTY_FLOW_PATH_LABEL;
  }

  const steps = stepLabels
    .slice(0, FLOW_PATH_MAX_NODES)
    .map((step) => sanitizeLabel(step, UNNAMED_FLOW_STEP_LABEL));
  const dropped = stepLabels.length - steps.length;
  if (dropped > 0) {
    steps.push(`${countLabel(dropped, STEP_NOUN)} ${LIST_OVERFLOW_WORD}`);
  }

  return truncateLabel(steps.join(FLOW_PATH_SEPARATOR), FLOW_PATH_MAX_LENGTH);
}

/* -------------------------------------------------------------------------------------------------
 * observed-fact frames
 *
 * One frame per deterministic fact-candidate class. Every one of them restates
 * a count or a measurement and stops: no causal language, no comparison the
 * numbers do not already carry, nothing that would need substantiating beyond
 * the evidence `./rules.ts` cites alongside it. Interpretation is the job of
 * the likely-cause frames further down, which are always paired with a
 * confidence value.
 * ---------------------------------------------------------------------------------------------- */

/**
 * One operation's share of an interaction's measured time.
 *
 * @param operationLabel The operation or span name. A blank value falls back to
 * {@link UNNAMED_OPERATION_LABEL}.
 * @param durationMs How long that operation took, in milliseconds.
 * @param totalDurationMs The interaction's total, in milliseconds.
 * @returns One descriptive sentence.
 * @example
 * // slowestSpanFact('‹operation›', 640, 1175) === '‹operation› took 640 ms of the 1175 ms recorded for the interaction.'
 */
export function slowestSpanFact(
  operationLabel: string,
  durationMs: number,
  totalDurationMs: number,
): string {
  const operation = sanitizeLabel(operationLabel, UNNAMED_OPERATION_LABEL);
  return `${operation} took ${formatDurationMs(durationMs)} ms of the ${formatDurationMs(totalDurationMs)} ms recorded for the interaction.`;
}

/**
 * How much of an interaction's measured time was recorded in one tier.
 *
 * @param tierLabel Wording from {@link telemetryTierLabel}.
 * @param elapsedMs Time recorded in that tier, in milliseconds.
 * @param totalDurationMs The interaction's total, in milliseconds.
 * @returns One descriptive sentence.
 */
export function tierTimeSplitFact(
  tierLabel: string,
  elapsedMs: number,
  totalDurationMs: number,
): string {
  const tier = sanitizeLabel(tierLabel, TELEMETRY_TIER_FALLBACK_LABEL);
  return `Time recorded in the ${tier} tier was ${formatDurationMs(elapsedMs)} ms of the ${formatDurationMs(totalDurationMs)} ms total.`;
}

/**
 * Identical requests grouped inside a window.
 *
 * The endpoint stays out of the frame's fixed text: `./rules.ts` interpolates
 * it from the capture, and when it has no label the sentence falls back to
 * {@link SAME_ENDPOINT_LABEL} — the generic shape `‹n› requests to the same
 * endpoint occurred within ‹window› ms`.
 *
 * Grouping is by the pre-redaction request key of AAP §0.5.2, so this frame
 * counts byte-identical requests rather than requests that merely share a path.
 * It says only that they occurred.
 *
 * @param count How many requests were in the group.
 * @param windowMs The window they occurred within, in milliseconds.
 * @param endpointLabel The endpoint they addressed, when available. A blank
 * value is treated as absent.
 * @returns One descriptive sentence.
 */
export function duplicateRequestFact(
  count: number,
  windowMs: number,
  endpointLabel?: string,
): string {
  const endpoint = optionalLabel(endpointLabel) ?? SAME_ENDPOINT_LABEL;
  return `${countLabel(count, METRIC_COUNT_NOUNS.request_count)} to ${endpoint} occurred within ${formatDurationMs(windowMs)} ms.`;
}

/**
 * That every member of a group came from one call site.
 *
 * @param count How many occurrences the group held.
 * @param callSiteLabel A `file:line` label for the originating call site. A
 * blank value falls back to {@link UNRESOLVED_CALL_SITE_LABEL}.
 * @returns One descriptive sentence.
 * @example
 * // sharedOriginFact(4, '‹file›:‹line›') === 'All 4 occurrences originated from ‹file›:‹line›.'
 */
export function sharedOriginFact(count: number, callSiteLabel: string): string {
  const callSite = sanitizeLabel(callSiteLabel, UNRESOLVED_CALL_SITE_LABEL);
  return `All ${countLabel(count, OCCURRENCE_NOUN)} originated from ${callSite}.`;
}

/**
 * How many times one component rendered during the interaction.
 *
 * @param componentLabel The component's display name. A blank value falls back
 * to {@link UNNAMED_COMPONENT_LABEL}.
 * @param count How many renders were recorded for it.
 * @returns One descriptive sentence.
 */
export function renderCountFact(componentLabel: string, count: number): string {
  const component = sanitizeLabel(componentLabel, UNNAMED_COMPONENT_LABEL);
  return `${component} rendered ${countLabel(count, TIME_NOUN)} during the interaction.`;
}

/**
 * How many recorded renders ran with unchanged inputs.
 *
 * The wording states AAP §0.2.3's definition in full — props shallow-equal,
 * own hook state unchanged **and** no consumed context value changed — because
 * an abbreviated version ("nothing changed") would be a stronger claim than the
 * measurement supports. A render whose trigger could not be determined is
 * **not** counted here; {@link unknownTriggerRenderFact} reports those
 * separately, which is the distinction the two metric ids exist to preserve.
 *
 * @param unchangedCount Renders that met all three conditions.
 * @param totalRenderCount Renders recorded in total.
 * @returns One descriptive sentence.
 */
export function unchangedInputRenderFact(unchangedCount: number, totalRenderCount: number): string {
  return `${formatCount(unchangedCount)} of ${countLabel(totalRenderCount, METRIC_COUNT_NOUNS.render_count)} had shallow-equal props, unchanged own hook state and no changed consumed context value.`;
}

/**
 * How many recorded renders could not have a trigger determined.
 *
 * Kept deliberately separate from {@link unchangedInputRenderFact}: an
 * undetermined trigger means one of the three conditions could not be
 * evaluated, which is not the same as having evaluated all three and found
 * nothing changed. Describing these as unchanged would overstate the evidence.
 *
 * @param unknownCount Renders whose trigger could not be determined.
 * @param totalRenderCount Renders recorded in total.
 * @returns One descriptive sentence.
 */
export function unknownTriggerRenderFact(unknownCount: number, totalRenderCount: number): string {
  return `The trigger could not be determined for ${formatCount(unknownCount)} of ${countLabel(totalRenderCount, METRIC_COUNT_NOUNS.render_count)}.`;
}

/**
 * How many statements of one shape ran during the interaction.
 *
 * The statement arrives already parameterised and redacted — AAP §0.5.2 stores
 * `db.statement` with placeholders and never row contents — and is bounded here
 * like any other label.
 *
 * @param count How many statements shared the shape.
 * @param statementLabel The parameterised statement text. A blank value falls
 * back to {@link UNNAMED_STATEMENT_LABEL}.
 * @returns One descriptive sentence.
 */
export function repeatedQueryShapeFact(count: number, statementLabel: string): string {
  const statement = sanitizeLabel(statementLabel, UNNAMED_STATEMENT_LABEL);
  return `${countLabel(count, METRIC_COUNT_NOUNS.query_count)} of the same statement shape ran during the interaction (${statement}).`;
}

/**
 * How many long tasks the capture recorded.
 *
 * @param count How many long tasks were recorded.
 * @param longestDurationMs The longest one, in milliseconds, when the capture
 * reported it. Omitted leaves the sentence at the count alone.
 * @returns One descriptive sentence.
 */
export function longTaskFact(count: number, longestDurationMs?: number): string {
  const counted = countLabel(count, METRIC_COUNT_NOUNS.long_task_count);
  if (longestDurationMs === undefined) {
    return `The capture recorded ${counted} during the interaction.`;
  }
  return `The capture recorded ${counted} during the interaction, the longest lasting ${formatDurationMs(longestDurationMs)} ms.`;
}

/**
 * How many errors the capture recorded.
 *
 * @param count How many errors were recorded, across every tier the capture
 * covered.
 * @returns One descriptive sentence.
 */
export function errorCountFact(count: number): string {
  return `The capture recorded ${countLabel(count, METRIC_COUNT_NOUNS.error_count)} during the interaction.`;
}

/* -------------------------------------------------------------------------------------------------
 * likely-cause frames
 *
 * One frame per evidence-pattern class of {@link EvidencePattern}. Each names
 * the pattern the numbers form and the standard, mechanically-true explanation
 * for that class of pattern, with every project noun interpolated. None of them
 * asserts a verdict about a particular project or file, and none carries
 * confidence wording — `./rules.ts` attaches the numeric `confidence` to the
 * hypothesis, and the renderer displays these sentences under a separate
 * "likely cause" heading from the observed facts above.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The standard explanation for identical requests repeated from one call site.
 *
 * @param count How many identical requests were grouped.
 * @param windowMs The window they occurred within, in milliseconds.
 * @param callSiteLabel A `file:line` label for the call site they came from. A
 * blank value falls back to {@link UNRESOLVED_CALL_SITE_LABEL}.
 * @returns One sentence suitable for a hypothesis `statement`.
 */
export function duplicateRequestCause(
  count: number,
  windowMs: number,
  callSiteLabel: string,
): string {
  const callSite = sanitizeLabel(callSiteLabel, UNRESOLVED_CALL_SITE_LABEL);
  const counted = countLabel(count, IDENTICAL_REQUEST_NOUN);
  return `Repeated identical requests from a single call site — ${counted} from ${callSite} within ${formatDurationMs(windowMs)} ms — match the pattern of an effect that re-runs after each render, which is what happens when a value in its dependency list is rebuilt on every render instead of being reused.`;
}

/**
 * The standard explanation for renders whose inputs did not change.
 *
 * Both mechanisms are named because the evidence pattern is the same for each
 * and choosing between them needs more than counts: a context value that
 * changes on its own schedule re-renders every consumer, and a callback whose
 * identity is rebuilt each render defeats the memoisation of the child it is
 * passed to. `./rules.ts` narrows this further only when the capture carries a
 * state-transition or context attribution to narrow it with.
 *
 * @param componentLabel The component the renders were recorded for. A blank
 * value falls back to {@link UNNAMED_COMPONENT_LABEL}.
 * @param unchangedCount How many of its renders had unchanged inputs — the
 * subset the opening clause has already qualified, which is why the count is
 * rendered with the plain render noun rather than restating the condition.
 * @returns One sentence suitable for a hypothesis `statement`.
 */
export function unchangedInputRenderCause(componentLabel: string, unchangedCount: number): string {
  const component = sanitizeLabel(componentLabel, UNNAMED_COMPONENT_LABEL);
  const counted = countLabel(unchangedCount, METRIC_COUNT_NOUNS.render_count);
  return `Renders with unchanged inputs — ${counted} of ${component} — match the pattern of a context value that changes on its own schedule, or of a callback whose identity is rebuilt on each render, either of which re-renders a consumer whose own props and state did not change.`;
}

/**
 * The standard explanation for one operation covering most of an interaction.
 *
 * It says where the measured time is concentrated and nothing about why that
 * operation takes as long as it does — that would be a verdict about a
 * particular subsystem, which no frame in this module is allowed to reach.
 *
 * @param operationLabel The dominant operation's name. A blank value falls back
 * to {@link UNNAMED_OPERATION_LABEL}.
 * @param durationMs How long it took, in milliseconds.
 * @param totalDurationMs The interaction's total, in milliseconds.
 * @param tierLabel Wording from {@link telemetryTierLabel} for the tier the
 * operation was recorded in, when the capture attributed one. A blank value is
 * treated as absent.
 * @returns One sentence suitable for a hypothesis `statement`.
 */
export function dominantSpanCause(
  operationLabel: string,
  durationMs: number,
  totalDurationMs: number,
  tierLabel?: string,
): string {
  const operation = sanitizeLabel(operationLabel, UNNAMED_OPERATION_LABEL);
  const tier = optionalLabel(tierLabel);
  const subject = tier === undefined ? operation : `${operation}, recorded in the ${tier} tier,`;
  return `One operation covers most of the interaction: ${subject} accounts for ${formatDurationMs(durationMs)} ms of the ${formatDurationMs(totalDurationMs)} ms total, which concentrates the measured time in a single step rather than spreading it across the tiers the trace spans.`;
}

/**
 * The standard explanation for one statement repeated inside an interaction.
 *
 * @param count How many statements shared the shape.
 * @param statementLabel The parameterised statement text. A blank value falls
 * back to {@link UNNAMED_STATEMENT_LABEL}.
 * @param callerLabel A `file:line` label for the code that issued them, when
 * resolved. A blank value is treated as absent.
 * @returns One sentence suitable for a hypothesis `statement`.
 */
export function repeatedQueryShapeCause(
  count: number,
  statementLabel: string,
  callerLabel?: string,
): string {
  const statement = sanitizeLabel(statementLabel, UNNAMED_STATEMENT_LABEL);
  const caller = optionalLabel(callerLabel);
  const counted = `${countLabel(count, METRIC_COUNT_NOUNS.query_count)} of the same shape`;
  const origin = caller === undefined ? counted : `${counted} from ${caller}`;
  return `A statement repeated inside one interaction — ${origin} (${statement}) — matches the pattern of a lookup made once per item rather than once for the whole set.`;
}

/* -------------------------------------------------------------------------------------------------
 * panel frames
 * ---------------------------------------------------------------------------------------------- */

/**
 * The generated panel's title.
 *
 * Built from the category and, when one was selected, the target — never from
 * the developer's wording, so the title of a panel is a function of what was
 * classified and captured rather than of how the request was phrased.
 *
 * @param categoryLabel Wording from {@link problemCategoryLabel}.
 * @param targetLabel Wording for the selected element or component, when one
 * was selected. A blank value is treated as absent.
 * @returns A short title, capitalised.
 * @example
 * // panelTitle(problemCategoryLabel('excessive-renders'), '‹component›')
 * // panelTitle(problemCategoryLabel('excessive-renders'))
 */
export function panelTitle(categoryLabel: string, targetLabel?: string): string {
  const category = capitalizeFirst(sanitizeLabel(categoryLabel, PROBLEM_CATEGORY_FALLBACK_LABEL));
  const target = optionalLabel(targetLabel);
  return target === undefined ? category : `${category} — ${target}`;
}

/**
 * The panel's summary headline.
 *
 * AAP §0.2.3 routes a string `summary` to the non-evidentiary
 * `summary.headline` and states that a string can never become a `Fact` — the
 * panel's observed facts and likely causes are copied only from the validated
 * analysis. This sentence is written to be safe in that slot: it restates the
 * counts the capture reported and the time they were recorded across, and
 * claims nothing that would need citing.
 *
 * Total for every input. No counts and no duration reads as
 * {@link NO_MEASURED_ACTIVITY_LABEL}; more counts than {@link LIST_MAX_ITEMS}
 * are summarised by {@link joinWithConjunction} rather than listed in full.
 *
 * @param counts One entry per metric the capture reported, in the order they
 * should read, each pairing a value with the noun {@link metricCountNoun}
 * supplies.
 * @param totalDurationMs The span of the capture or interaction in
 * milliseconds, when one was measured. Omitted leaves the sentence at the
 * counts alone.
 * @returns One descriptive sentence.
 * @example
 * // panelSummaryHeadline([{ count: 4, noun: metricCountNoun('request_count') }], 1175)
 * //   === 'The capture recorded 4 requests across 1175 ms.'
 */
export function panelSummaryHeadline(
  counts: readonly CountedNoun[],
  totalDurationMs?: number,
): string {
  const rendered = counts.map((entry) => countLabel(entry.count, entry.noun));
  const list = joinWithConjunction(rendered, NO_MEASURED_ACTIVITY_LABEL);
  if (totalDurationMs === undefined) {
    return `The capture recorded ${list}.`;
  }
  return `The capture recorded ${list} across ${formatDurationMs(totalDurationMs)} ms.`;
}

/**
 * Cleans an optional label, reporting "nothing usable" as `undefined` so a
 * frame can take its deliberately-worded absent branch.
 *
 * A blank string and a missing value are the same thing to a sentence, and
 * collapsing them here is what keeps each frame's branch a question about
 * meaning rather than about which falsy value arrived.
 *
 * @param value The label to clean, when the caller has one.
 * @returns A non-empty single-line label, or `undefined`.
 */
function optionalLabel(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length === 0 ? undefined : truncateLabel(collapsed);
}
