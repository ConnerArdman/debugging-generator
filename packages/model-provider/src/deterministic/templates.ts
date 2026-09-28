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

/** The unit symbols a duration in a sentence can carry. */
export type DurationUnit = 'µs' | 'ms' | 's';

/**
 * Decimal places kept when a duration is rendered as text, per unit.
 *
 * AAP §0.2.3 fixes the product's time base at epoch milliseconds with
 * millisecond durations. A sentence states a duration in exactly the text the
 * panels print for the same measurement — the precise rule of
 * `packages/panel-renderer`'s `formatDuration`, which every table cell, tooltip
 * and bar label uses — so a summary never reads "1564.9 ms" beside a table row
 * that reads "1.565 s": whole microseconds below a millisecond (a fractional
 * microsecond is below the stored resolution), hundredths of a millisecond
 * below a second, and thousandths of a second from there on, which keeps a
 * seconds figure loss-free against the millisecond it came from. The policy is
 * applied by {@link formatDurationMs} and by nothing else, so every duration in
 * every deterministic sentence carries the same digits. This package depends on
 * `@debuggen/shared` alone, so the rule is restated here rather than imported,
 * and the cases in `./templates.test.ts` pin it to the renderer's.
 */
export const DURATION_DECIMALS: Readonly<Record<DurationUnit, number>> = Object.freeze({
  µs: 0,
  ms: 2,
  s: 3,
});

/** Milliseconds in one second: the boundary at which a duration reads in seconds. */
const MS_PER_SECOND = 1000;

/** Microseconds in one millisecond. */
const US_PER_MS = 1000;

/**
 * The magnitude at which JavaScript's fixed notation degenerates into an
 * exponent (`(1e21).toFixed(3) === '1e+21'`), past which no digit grouping
 * applies.
 */
const MAX_FIXED_MAGNITUDE = 1e21;

/** Digits per thousands group. */
const DIGIT_GROUP_SIZE = 3;

/** The thousands separator, fixed rather than taken from a host locale. */
const DIGIT_GROUP_SEPARATOR = ',';

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

/**
 * Longest sentence a likely-cause frame emits, in characters: **300**.
 *
 * It is the bound `@debuggen/panel-schema` puts on every `Fact.statement` and
 * `Hypothesis.statement` (`MAX_STATEMENT_LENGTH`), which the analyze stage's
 * schema enforces on this provider's output. This package depends on
 * `@debuggen/shared` alone, so the number is restated here rather
 * than imported; `apps/local-service/src/analysis/deterministic-statements.test.ts`
 * validates this provider's analysis against the real schema and fails if a
 * statement built to this bound is ever refused by it.
 *
 * The cap is what {@link fitStatement} fits a frame's labels to: a cause frame's
 * fixed wording is long enough that labels at {@link LABEL_MAX_LENGTH} alone
 * would push it past the schema, and a statement the schema rejects fails the
 * whole analyze stage rather than just the one sentence.
 */
export const STATEMENT_MAX_LENGTH = 300;

/**
 * Longest plan objective {@link planObjective} emits, in characters: **500**.
 *
 * The bound `@debuggen/instrumentation`'s plan schemas put on `objective`
 * (`MAX_OBJECTIVE_LENGTH`), restated here for the same layering reason as
 * {@link STATEMENT_MAX_LENGTH}. An objective names the selected target twice
 * and the routes the investigation traced, each a label of up to
 * {@link LABEL_MAX_LENGTH} characters, so a pathological set of labels would
 * otherwise push it past the schema and fail the plan stage over its wording.
 */
export const OBJECTIVE_MAX_LENGTH = 500;

/**
 * Longest panel headline {@link panelSummaryHeadline} emits once a follow-up's
 * focus sentence closes it, in characters: **500**.
 *
 * The bound `@debuggen/panel-schema` puts on a string summary
 * (`MAX_HEADLINE_LENGTH`), restated here for the same layering reason as
 * {@link STATEMENT_MAX_LENGTH}: the focus sentence names up to
 * {@link FOCUS_SUBJECT_MAX_ITEMS} declarations, so its label is shortened
 * rather than let a long focus push the headline past the schema.
 */
export const HEADLINE_MAX_LENGTH = 500;

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
 * uses: `‹n› requests to the same endpoint occurred within ‹window›`, where
 * `‹window›` is the whole duration phrase {@link formatDurationMs} renders.
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
 * Renders a frame whose interpolated labels are shortened, all to one shared
 * cap, just enough for the sentence to fit {@link STATEMENT_MAX_LENGTH}.
 *
 * Labels arrive already cleaned and capped at {@link LABEL_MAX_LENGTH}. A frame
 * that fits as it stands is returned byte for byte, so the common case reads
 * exactly as before. Otherwise the longest labels are cut first: the shared
 * cap falls from the longest label's length by the overflow divided among the
 * labels still at the cap, and every label longer than the cap is truncated
 * with {@link TRUNCATION_MARKER}, so what remains of each is its beginning —
 * the directory of a call site, the start of a statement. The cap strictly
 * decreases on every pass, so the loop ends; should the fixed wording alone
 * ever outgrow the bound, the sentence itself is truncated as the last resort,
 * which keeps the output within the schema instead of failing the stage.
 *
 * @param labels Every cleaned label the frame interpolates.
 * @param frame Builds the sentence, passing each of those labels through the
 * `fit` it is handed.
 * @param maxLength The bound the sentence must fit; {@link STATEMENT_MAX_LENGTH}
 * by default, the bound of every fact and hypothesis. A frame whose output lands
 * in a field with a bound of its own — the plan objective's
 * {@link OBJECTIVE_MAX_LENGTH} — passes that bound instead.
 * @returns One sentence of at most `maxLength` characters.
 */
function fitStatement(
  labels: readonly string[],
  frame: (fit: (label: string) => string) => string,
  maxLength: number = STATEMENT_MAX_LENGTH,
): string {
  let sentence = frame((label) => label);
  let cap = labels.reduce((longest, label) => Math.max(longest, label.length), 0);
  while (sentence.length > maxLength && cap > TRUNCATION_MARKER.length) {
    const overflow = sentence.length - maxLength;
    const current = cap;
    const atCap = Math.max(1, labels.filter((label) => label.length >= current).length);
    cap = Math.max(TRUNCATION_MARKER.length, cap - Math.ceil(overflow / atCap));
    const limit = cap;
    sentence = frame((label) => truncateLabel(label, limit));
  }
  return truncateLabel(sentence, maxLength);
}

/**
 * Inserts thousands separators into the integer part of a fixed-notation
 * digit string, leaving the fraction — and so its digit count — untouched.
 *
 * String arithmetic rather than `Intl.NumberFormat`, for the same reason the
 * renderer groups this way: a locale would make two runs disagree.
 */
function groupIntegerDigits(text: string): string {
  const point = text.indexOf('.');
  const integer = point < 0 ? text : text.slice(0, point);
  const fraction = point < 0 ? '' : text.slice(point);
  const groups: string[] = [];
  for (let end = integer.length; end > 0; end -= DIGIT_GROUP_SIZE) {
    groups.push(integer.slice(Math.max(0, end - DIGIT_GROUP_SIZE), end));
  }
  return `${groups.reverse().join(DIGIT_GROUP_SEPARATOR)}${fraction}`;
}

/**
 * Renders a millisecond measurement as text, with its unit.
 *
 * The canonical duration text of the product (see {@link DURATION_DECIMALS}):
 * the unit is chosen from the measured value — below 1 ms `µs`, below 1 000 ms
 * `ms`, otherwise `s`, the boundary belonging to the larger unit — and kept
 * even when rounding reaches the next unit's magnitude (`999.999` reads
 * `1,000.00 ms`), exactly as the renderer does, so the unit never depends on
 * the digits. An exact zero reads `0.00 ms`, in the canonical unit.
 *
 * The rounding runs through `@debuggen/shared`'s {@link roundMs} so a duration
 * reads the same here as it does in a stored event or a panel-data response,
 * and the value is clamped first, because a sentence must never contain
 * `NaN`, `Infinity` or a negative duration. Locale-sensitive formatting is
 * forbidden throughout this module — no `toLocaleString`, no `Intl` — because
 * the output would then depend on the environment the service happens to run
 * in, and two runs of the same capture would disagree. A magnitude too large
 * for fixed notation keeps JavaScript's own exponent form, which is still one
 * finite, deterministic token.
 *
 * @param value A duration in milliseconds. Non-finite and negative values are
 * rendered as `0.00 ms`.
 * @returns The rounded value, grouped with `,`, followed by a space and its
 * unit — the whole duration phrase, so no frame appends a unit of its own.
 * @example
 * // formatDurationMs(0.4) === '400 µs'
 * // formatDurationMs(22) === '22.00 ms'
 * // formatDurationMs(1564.94) === '1.565 s'
 * // formatDurationMs(44722.6) === '44.723 s'
 */
export function formatDurationMs(value: number): string {
  const safe = Number.isFinite(value) ? clampNonNegative(value) : 0;
  const unit = durationUnitOf(safe);
  const decimals = DURATION_DECIMALS[unit];
  const rounded = roundMs(durationMagnitude(safe, unit), decimals);
  const digits =
    Number.isFinite(rounded) && rounded < MAX_FIXED_MAGNITUDE
      ? groupIntegerDigits(rounded.toFixed(decimals))
      : String(durationMagnitude(safe, unit));
  return `${digits} ${unit}`;
}

/**
 * The unit a non-negative millisecond value reads in, chosen from the value
 * itself: an exact zero in the canonical `ms`, below 1 ms in `µs`, below
 * 1 000 ms in `ms`, and from 1 000 ms in `s`.
 */
function durationUnitOf(ms: number): DurationUnit {
  if (ms === 0) {
    return 'ms';
  }
  if (ms < 1) {
    return 'µs';
  }
  return ms < MS_PER_SECOND ? 'ms' : 's';
}

/** A millisecond value expressed in `unit`. */
function durationMagnitude(ms: number, unit: DurationUnit): number {
  if (unit === 'µs') {
    return ms * US_PER_MS;
  }
  return unit === 's' ? ms / MS_PER_SECOND : ms;
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
 * often than the developer expected, and outright failures. Two vocabularies
 * are worded: the symptom-level categories a context may carry, and the
 * understanding categories `ProblemUnderstanding.category` is answered in —
 * the value every later stage reads back — so a panel title or plan objective
 * names the class of behaviour the understanding settled on. The
 * understanding's `other` has no entry on purpose: it reads with
 * {@link PROBLEM_CATEGORY_FALLBACK_LABEL}.
 */
export type ProblemCategory =
  | 'slow-interaction'
  | 'slow-request'
  | 'slow-query'
  | 'excessive-renders'
  | 'duplicate-requests'
  | 'unexpected-state'
  | 'blocked-main-thread'
  | 'runtime-error'
  | 'performance'
  | 'rendering'
  | 'network'
  | 'data'
  | 'state'
  | 'error'
  | 'correctness';

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
  performance: 'latency',
  rendering: 'render activity',
  network: 'network requests',
  data: 'database queries',
  state: 'state changes',
  error: 'runtime errors',
  correctness: 'incorrect behaviour',
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
  | 'log'
  | 'interactions'
  | 'react'
  | 'perf'
  | 'errors'
  | 'componentTree'
  | 'http'
  | 'routeHandlers'
  | 'prisma'
  | 'pg'
  | 'functions';

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
  interactions: 'interaction timing',
  react: 'renders',
  perf: 'performance entries',
  errors: 'page errors',
  componentTree: 'component tree snapshots',
  http: 'incoming server requests',
  routeHandlers: 'route handler timing',
  prisma: 'database queries',
  pg: 'database queries',
  functions: 'function timing',
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
 *
 * An event handler arrives under two spellings: `handler`, the node kind the
 * code graph's event-handler extractor emits, and `event-handler`, the
 * spelled-out form a structured context may carry. Both read the same.
 */
export type CodeSymbolKind =
  | 'file'
  | 'symbol'
  | 'component'
  | 'handler'
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
  handler: 'event handler',
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
 * | `context-change-renders`    | {@link contextChangeRenderCause}      |
 *
 * `context-change-renders` is the one pattern detected from trigger
 * attribution rather than from a count alone: a project component whose renders
 * mostly followed a changed consumed context value, named by the component
 * that provides that context.
 *
 * The union exists so that adding a pattern in `./rules.ts` without a frame
 * here is a compile-time question rather than a runtime surprise, and so both
 * modules name the classes identically.
 */
export type EvidencePattern =
  | 'duplicate-requests'
  | 'unchanged-input-renders'
  | 'dominant-span'
  | 'repeated-query-shape'
  | 'context-change-renders';

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
  'context-change-renders': 'renders following a changed context value',
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

/** Traced routes {@link planObjective} names before it counts the remainder. */
export const OBJECTIVE_MAX_ROUTES = 3;

/**
 * How the behaviour a plan is for is reproduced while its capture runs, for
 * the closing clause of {@link planObjective}:
 *
 * - `interaction` — by the developer's input: the category's behaviour is
 *   reproduced by an interaction, with the selected target when there is one;
 * - `page` — by observing the page: the behaviour shows without input.
 */
export type ObjectiveReproduction = 'interaction' | 'page';

/**
 * The plan's objective sentence.
 *
 * This stands in for the prose objective a model would write, and it is built
 * from structured facts only — the category label, the selected target's
 * label, how the behaviour is reproduced and the routes the investigation
 * traced — never from the developer's wording, which is the whole point: two
 * requests that differ only in phrasing classify to the same category, select
 * the same target and trace the same flows, and therefore produce the same
 * objective, character for character.
 *
 * The sentence names where the time or the behaviour is recorded — the target
 * first, then up to {@link OBJECTIVE_MAX_ROUTES} traced routes with the rest
 * counted — and how the capture reproduces it. With nothing to name, the
 * location is left out rather than interpolated as an empty string, and an
 * interaction without a target to name reads as "the interaction", so every
 * reading is a complete sentence. The labels are shortened, never the
 * wording, when the sentence would exceed {@link OBJECTIVE_MAX_LENGTH}.
 *
 * @param categoryLabel Wording from {@link problemCategoryLabel}.
 * @param targetLabel Wording for the selected element or component, when one
 * was selected. A blank value is treated as absent.
 * @param reproduction How the behaviour is reproduced; `page` by default.
 * @param routeLabels The routes the investigation's flows traced, in their
 * order. Blank ones, repeats and one equal to the target are dropped.
 * @returns One sentence stating what the capture is meant to settle.
 * @example
 * // planObjective(problemCategoryLabel('performance'), '‹component›', 'interaction', ['POST /‹route›'])
 * //   === 'Determine what accounts for the latency recorded at ‹component› and POST /‹route› while an interaction with ‹component› is reproduced.'
 * // planObjective(problemCategoryLabel('rendering'), '‹component›')
 * //   === 'Determine what accounts for the render activity recorded at ‹component› while the page is observed.'
 */
export function planObjective(
  categoryLabel: string,
  targetLabel?: string,
  reproduction: ObjectiveReproduction = 'page',
  routeLabels: readonly string[] = [],
): string {
  const category = sanitizeLabel(categoryLabel, PROBLEM_CATEGORY_FALLBACK_LABEL);
  const target = optionalLabel(targetLabel);

  const routes: string[] = [];
  for (const label of routeLabels) {
    const route = optionalLabel(label);
    if (route !== undefined && route !== target && !routes.includes(route)) {
      routes.push(route);
    }
  }
  const shownRoutes = routes.slice(0, OBJECTIVE_MAX_ROUTES);
  const hiddenRoutes = routes.length - shownRoutes.length;
  const places = target === undefined ? shownRoutes : [target, ...shownRoutes];

  return fitStatement(
    places,
    (fit) => {
      const named = places.map(fit);
      const listed =
        hiddenRoutes > 0 ? [...named, `${formatCount(hiddenRoutes)} ${LIST_OVERFLOW_WORD}`] : named;
      // Every listed place is a cleaned, non-blank label, so the list's fallback
      // wording is never reached; it is the target's, the first place named.
      const where =
        listed.length === 0 ? '' : ` at ${joinWithConjunction(listed, UNNAMED_COMPONENT_LABEL)}`;
      const how =
        reproduction === 'page'
          ? 'while the page is observed'
          : target === undefined
            ? 'while the interaction is reproduced'
            : `while an interaction with ${fit(target)} is reproduced`;
      return `Determine what accounts for the ${category} recorded${where} ${how}.`;
    },
    OBJECTIVE_MAX_LENGTH,
  );
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
 * label from whatever produced the match — a named entity, a needed or
 * declared signal, the far end of a traced path, or the entity an executed
 * query looked up.
 *
 * A candidate nothing named — a code node a query result carried without any
 * of those relations — takes the separate, entity-free branch rather than an
 * interpolated placeholder: a sentence asserting an association with "an
 * unnamed" something states a relation the graph never recorded, while the
 * entity-free sentence states exactly what is known, that the graph returned
 * the node while the investigation queried it.
 *
 * @param symbolKindLabel Wording from {@link codeSymbolKindLabel}.
 * @param relatedLabel The signal or entity this symbol was matched against. A
 * blank or absent value takes the entity-free branch.
 * @returns One sentence suitable for a relevant file's `reason` field.
 * @example
 * // codeRelevanceReason(codeSymbolKindLabel('component'), '‹route›')
 * //   === 'The code graph associates this component with ‹route›.'
 * // codeRelevanceReason(codeSymbolKindLabel('file'), '  ')
 * //   === "The code graph returned this file in the investigation's query results."
 */
export function codeRelevanceReason(symbolKindLabel: string, relatedLabel?: string): string {
  const kind = sanitizeLabel(symbolKindLabel, CODE_SYMBOL_KIND_FALLBACK_LABEL);
  const related = optionalLabel(relatedLabel);
  if (related === undefined) {
    return `The code graph returned this ${kind} in the investigation's query results.`;
  }
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
 * // slowestSpanFact('‹operation›', 640, 1175) === '‹operation› took 640.00 ms of the 1.175 s recorded for the interaction.'
 */
export function slowestSpanFact(
  operationLabel: string,
  durationMs: number,
  totalDurationMs: number,
): string {
  const operation = sanitizeLabel(operationLabel, UNNAMED_OPERATION_LABEL);
  return `${operation} took ${formatDurationMs(durationMs)} of the ${formatDurationMs(totalDurationMs)} recorded for the interaction.`;
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
  return `Time recorded in the ${tier} tier was ${formatDurationMs(elapsedMs)} of the ${formatDurationMs(totalDurationMs)} total.`;
}

/**
 * Identical requests grouped inside a window.
 *
 * The endpoint stays out of the frame's fixed text: `./rules.ts` interpolates
 * it from the capture, and when it has no label the sentence falls back to
 * {@link SAME_ENDPOINT_LABEL} — the generic shape `‹n› requests to the same
 * endpoint occurred within ‹window›`, the window carrying its own unit.
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
  return `${countLabel(count, METRIC_COUNT_NOUNS.request_count)} to ${endpoint} occurred within ${formatDurationMs(windowMs)}.`;
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
 * When the counts are one component's, `componentLabel` names it — "… of
 * 4 977 renders of ‹component› had …" — so the sentence says whose renders
 * these were; without it the counts read as the whole capture's.
 *
 * @param unchangedCount Renders that met all three conditions.
 * @param totalRenderCount Renders recorded in total.
 * @param componentLabel The component the counts belong to, when they are one component's.
 * @returns One descriptive sentence.
 */
export function unchangedInputRenderFact(
  unchangedCount: number,
  totalRenderCount: number,
  componentLabel?: string,
): string {
  const counted = `${formatCount(unchangedCount)} of ${countLabel(totalRenderCount, METRIC_COUNT_NOUNS.render_count)}`;
  const tail =
    'had shallow-equal props, unchanged own hook state and no changed consumed context value.';
  const component = componentLabel === undefined ? undefined : optionalLabel(componentLabel);
  if (component === undefined) {
    return `${counted} ${tail}`;
  }
  return fitStatement([component], (fit) => `${counted} of ${fit(component)} ${tail}`);
}

/**
 * How many recorded renders could not have a trigger determined.
 *
 * Kept deliberately separate from {@link unchangedInputRenderFact}: an
 * undetermined trigger means one of the three conditions could not be
 * evaluated, which is not the same as having evaluated all three and found
 * nothing changed. Describing these as unchanged would overstate the evidence.
 *
 * `componentLabel` names the component the counts belong to, as in
 * {@link unchangedInputRenderFact}.
 *
 * @param unknownCount Renders whose trigger could not be determined.
 * @param totalRenderCount Renders recorded in total.
 * @param componentLabel The component the counts belong to, when they are one component's.
 * @returns One descriptive sentence.
 */
export function unknownTriggerRenderFact(
  unknownCount: number,
  totalRenderCount: number,
  componentLabel?: string,
): string {
  const counted = `${formatCount(unknownCount)} of ${countLabel(totalRenderCount, METRIC_COUNT_NOUNS.render_count)}`;
  const component = componentLabel === undefined ? undefined : optionalLabel(componentLabel);
  if (component === undefined) {
    return `The trigger could not be determined for ${counted}.`;
  }
  return fitStatement(
    [component],
    (fit) => `The trigger could not be determined for ${counted} of ${fit(component)}.`,
  );
}

/**
 * Most provider names {@link contextTriggeredRenderFact} lists. The first names
 * are the providers behind most of the component's context renders, and a
 * longer list would crowd the component's own name out of the sentence bound.
 */
export const CONTEXT_PROVIDER_LIST_MAX_ITEMS = 3;

/** Conjunction joining the final pair of a list of alternatives, as in `‹a› or ‹b›`. */
const ALTERNATIVE_CONJUNCTION = ' or ';

/**
 * Joins labels as alternatives — `‹a›`, `‹a› or ‹b›`, `‹a›, ‹b› or ‹c›` — in
 * the order given. The caller has already cleaned and bounded every label.
 *
 * @param items The labels, at least one.
 * @returns The joined list.
 */
function alternativesLabel(items: readonly string[]): string {
  const last = items[items.length - 1];
  if (items.length <= 1 || last === undefined) {
    return items.join(LIST_SEPARATOR);
  }
  return `${items.slice(0, -1).join(LIST_SEPARATOR)}${ALTERNATIVE_CONJUNCTION}${last}`;
}

/**
 * How many of one component's renders followed a change in a consumed context,
 * and which components provide the contexts that changed.
 *
 * It restates the capture's trigger attribution and stops: every counted
 * render was classified as context-triggered, and the providers are the ones
 * the capture named for those renders, most frequent first. Several providers
 * are joined as alternatives ("‹a› or ‹b›"), because each render followed a
 * change in at least one of them rather than in all. Rendered through
 * {@link fitStatement}, so long names are shortened rather than pushing the
 * sentence past {@link STATEMENT_MAX_LENGTH}.
 *
 * @param componentLabel The consuming component. A blank value falls back to
 * {@link UNNAMED_COMPONENT_LABEL}.
 * @param contextCount Its renders triggered by a changed consumed context.
 * @param totalRenderCount Its renders in total.
 * @param providerLabels The components providing the contexts that changed,
 * most frequent first. Blank entries are dropped, at most
 * {@link CONTEXT_PROVIDER_LIST_MAX_ITEMS} are named, and an empty list leaves
 * the context unnamed.
 * @returns One descriptive sentence of at most {@link STATEMENT_MAX_LENGTH}
 * characters.
 * @example
 * // contextTriggeredRenderFact('‹component›', 40, 42, ['‹provider›'])
 * //   === '40 of 42 renders of ‹component› followed a change in the context provided by ‹provider›.'
 */
export function contextTriggeredRenderFact(
  componentLabel: string,
  contextCount: number,
  totalRenderCount: number,
  providerLabels: readonly string[] = [],
): string {
  const component = sanitizeLabel(componentLabel, UNNAMED_COMPONENT_LABEL);
  const providers: string[] = [];
  for (const label of providerLabels) {
    const provider = optionalLabel(label);
    if (provider !== undefined && !providers.includes(provider)) {
      providers.push(provider);
    }
    if (providers.length >= CONTEXT_PROVIDER_LIST_MAX_ITEMS) {
      break;
    }
  }
  const counted = `${formatCount(contextCount)} of ${countLabel(totalRenderCount, METRIC_COUNT_NOUNS.render_count)}`;
  return fitStatement([component, ...providers], (fit) => {
    let context = 'a consumed context value';
    if (providers.length === 1) {
      context = `the context provided by ${alternativesLabel(providers.map(fit))}`;
    } else if (providers.length > 1) {
      context = `a context provided by ${alternativesLabel(providers.map(fit))}`;
    }
    return `${counted} of ${fit(component)} followed a change in ${context}.`;
  });
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
  return `The capture recorded ${counted} during the interaction, the longest lasting ${formatDurationMs(longestDurationMs)}.`;
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

/** The whole-percent multiplier of a share. */
const PERCENT_SCALE = 100;

/** Rendered for a positive share that rounds to no whole percent. */
const UNDER_ONE_PERCENT_LABEL = 'less than 1%';

/**
 * Renders the share one measurement is of another as a whole percentage.
 *
 * Rounded to the nearest whole percent with `Math.round` — no locale, no
 * `Intl` — and bounded to `[0, 100]`, so a sentence never claims more than all
 * of a total. A positive share that rounds to zero reads as
 * {@link UNDER_ONE_PERCENT_LABEL} rather than as `0%`, which would contradict
 * the measured time the same sentence states.
 *
 * @param partMs The measured part, in milliseconds.
 * @param wholeMs The total it is a share of, in milliseconds; a non-positive
 * total yields `0%`.
 * @returns The share, as `‹n›%`.
 */
function formatShare(partMs: number, wholeMs: number): string {
  const part = Number.isFinite(partMs) ? clampNonNegative(partMs) : 0;
  const whole = Number.isFinite(wholeMs) ? clampNonNegative(wholeMs) : 0;
  if (whole === 0) {
    return '0%';
  }
  const percent = Math.min(PERCENT_SCALE, Math.round((part / whole) * PERCENT_SCALE));
  return percent === 0 && part > 0 ? UNDER_ONE_PERCENT_LABEL : `${formatCount(percent)}%`;
}

/**
 * How often a declaration a follow-up named ran, and how long it took, as the
 * capture measured it.
 *
 * `./rules.ts` calls this only for a declaration the follow-up's structured
 * focus names and the capture holds spans of — the spans a timing of that
 * declaration recorded — and cites exactly those spans. It restates the count
 * and the summed time and stops: whether that time is too much is the
 * likely-cause frames' question, not this one's.
 *
 * @param symbolLabel The declaration's name. A blank value falls back to
 * {@link UNNAMED_SYMBOL_LABEL}.
 * @param count How many times the capture recorded it running.
 * @param measuredMs The time those runs took, summed, in milliseconds.
 * @param interactionMs The interaction's measured total, when the runs fit
 * inside it; omitted leaves the sentence without a share.
 * @returns One descriptive sentence, at most {@link STATEMENT_MAX_LENGTH}
 * characters.
 * @example
 * // focusedDeclarationFact('‹symbol›', 3, 900, 1200)
 * //   === '‹symbol› ran 3 times for 900.00 ms in total (75% of the 1.200 s recorded for the interaction).'
 */
export function focusedDeclarationFact(
  symbolLabel: string,
  count: number,
  measuredMs: number,
  interactionMs?: number,
): string {
  const symbol = sanitizeLabel(symbolLabel, UNNAMED_SYMBOL_LABEL);
  const ran = `ran ${countLabel(count, TIME_NOUN)} for ${formatDurationMs(measuredMs)} in total`;
  return fitStatement([symbol], (fit) =>
    interactionMs === undefined
      ? `${fit(symbol)} ${ran}.`
      : `${fit(symbol)} ${ran} (${formatShare(measuredMs, interactionMs)} of the ${formatDurationMs(interactionMs)} recorded for the interaction).`,
  );
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
 *
 * Their fixed wording is long, so each is rendered through
 * {@link fitStatement}: its labels are shortened just enough for the sentence
 * to stay within {@link STATEMENT_MAX_LENGTH}, the bound the analyze stage's
 * schema enforces on a hypothesis statement.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The standard explanation for identical requests repeated from one call site.
 *
 * @param count How many identical requests were grouped.
 * @param windowMs The window they occurred within, in milliseconds.
 * @param callSiteLabel A `file:line` label for the call site they came from. A
 * blank value falls back to {@link UNRESOLVED_CALL_SITE_LABEL}.
 * @returns One sentence suitable for a hypothesis `statement`, at most
 * {@link STATEMENT_MAX_LENGTH} characters.
 */
export function duplicateRequestCause(
  count: number,
  windowMs: number,
  callSiteLabel: string,
): string {
  const callSite = sanitizeLabel(callSiteLabel, UNRESOLVED_CALL_SITE_LABEL);
  const counted = countLabel(count, IDENTICAL_REQUEST_NOUN);
  return fitStatement(
    [callSite],
    (fit) =>
      `Repeated identical requests from a single call site — ${counted} from ${fit(callSite)} within ${formatDurationMs(windowMs)} — match the pattern of an effect that re-runs after each render, which is what happens when a value in its dependency list is rebuilt on every render instead of being reused.`,
  );
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
 * @returns One sentence suitable for a hypothesis `statement`, at most
 * {@link STATEMENT_MAX_LENGTH} characters.
 */
export function unchangedInputRenderCause(componentLabel: string, unchangedCount: number): string {
  const component = sanitizeLabel(componentLabel, UNNAMED_COMPONENT_LABEL);
  const counted = countLabel(unchangedCount, METRIC_COUNT_NOUNS.render_count);
  return fitStatement(
    [component],
    (fit) =>
      `Renders with unchanged inputs — ${counted} of ${fit(component)} — match the pattern of a context value that changes on its own schedule, or of a callback whose identity is rebuilt on each render, either of which re-renders a consumer whose own props and state did not change.`,
  );
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
 * @returns One sentence suitable for a hypothesis `statement`, at most
 * {@link STATEMENT_MAX_LENGTH} characters.
 */
export function dominantSpanCause(
  operationLabel: string,
  durationMs: number,
  totalDurationMs: number,
  tierLabel?: string,
): string {
  const operation = sanitizeLabel(operationLabel, UNNAMED_OPERATION_LABEL);
  const tier = optionalLabel(tierLabel);
  return fitStatement(tier === undefined ? [operation] : [operation, tier], (fit) => {
    const subject =
      tier === undefined ? fit(operation) : `${fit(operation)}, recorded in the ${fit(tier)} tier,`;
    return `One operation covers most of the interaction: ${subject} accounts for ${formatDurationMs(durationMs)} of the ${formatDurationMs(totalDurationMs)} total, which concentrates the measured time in a single step rather than spreading it across the tiers the trace spans.`;
  });
}

/**
 * The standard explanation for one statement repeated inside an interaction.
 *
 * @param count How many statements shared the shape.
 * @param statementLabel The parameterised statement text. A blank value falls
 * back to {@link UNNAMED_STATEMENT_LABEL}.
 * @param callerLabel A `file:line` label for the code that issued them, when
 * resolved. A blank value is treated as absent.
 * @returns One sentence suitable for a hypothesis `statement`, at most
 * {@link STATEMENT_MAX_LENGTH} characters.
 */
export function repeatedQueryShapeCause(
  count: number,
  statementLabel: string,
  callerLabel?: string,
): string {
  const statement = sanitizeLabel(statementLabel, UNNAMED_STATEMENT_LABEL);
  const caller = optionalLabel(callerLabel);
  const counted = `${countLabel(count, METRIC_COUNT_NOUNS.query_count)} of the same shape`;
  return fitStatement(caller === undefined ? [statement] : [statement, caller], (fit) => {
    const origin = caller === undefined ? counted : `${counted} from ${fit(caller)}`;
    return `A statement repeated inside one interaction — ${origin} (${fit(statement)}) — matches the pattern of a lookup made once per item rather than once for the whole set.`;
  });
}

/**
 * The standard explanation for a component re-rendered by a changing context.
 *
 * A consumer re-renders whenever the value its provider passes changes
 * identity, memoised or not, so a provider that builds a new value object on
 * each of its renders re-renders every consumer each time it renders — and it
 * renders whenever what it depends on changes. The frame names the three
 * places a developer walks: the consumer whose renders were counted, the
 * provider whose value changed (where that value is built) and, when the
 * capture traced it, the component whose own state updates the provider
 * follows. `./rules.ts` derives all three from the capture's trigger
 * attribution; none is inferred from a name.
 *
 * @param consumerLabel The component whose context-triggered renders were
 * counted. A blank value falls back to {@link UNNAMED_COMPONENT_LABEL}.
 * @param contextCount How many of its renders followed a context change.
 * @param providerLabel The component providing the context that changed, when
 * the capture named it. A blank value is treated as absent and leaves the
 * context unnamed.
 * @param originLabel The component whose state updates the provider's renders
 * trace back to, when the capture traced them. A blank value, or one equal to
 * `providerLabel`, is treated as absent.
 * @returns One sentence suitable for a hypothesis `statement`, at most
 * {@link STATEMENT_MAX_LENGTH} characters.
 * @example
 * // contextChangeRenderCause('‹consumer›', 40, '‹provider›', '‹origin›')
 */
export function contextChangeRenderCause(
  consumerLabel: string,
  contextCount: number,
  providerLabel?: string,
  originLabel?: string,
): string {
  const consumer = sanitizeLabel(consumerLabel, UNNAMED_COMPONENT_LABEL);
  const provider = optionalLabel(providerLabel);
  const named = optionalLabel(originLabel);
  const origin = named === undefined || named === provider ? undefined : named;
  const counted = countLabel(contextCount, METRIC_COUNT_NOUNS.render_count);
  const labels = [consumer];
  if (provider !== undefined) {
    labels.push(provider);
  }
  if (origin !== undefined) {
    labels.push(origin);
  }
  return fitStatement(labels, (fit) => {
    const change =
      provider === undefined
        ? 'a change in a consumed context value'
        : `a new value from the context of ${fit(provider)}`;
    const upstream = origin === undefined ? '' : `, driven by state updates in ${fit(origin)}`;
    return `Renders after a context change — ${counted} of ${fit(consumer)} followed ${change}${upstream} — match a provider that builds a new value on each render, which re-renders all its consumers, memoised or not.`;
  });
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

/** Declarations a focus subject names before it counts the rest. */
export const FOCUS_SUBJECT_MAX_ITEMS = 3;

/**
 * The declarations a follow-up focused on, as one short list for a panel title
 * or headline.
 *
 * The names come from the follow-up's structured focus — declarations the code
 * graph resolved — never from its wording. At most
 * {@link FOCUS_SUBJECT_MAX_ITEMS} are named, in the order given, and any
 * further ones are counted as `‹n› more`, so a title stays short however many
 * declarations a follow-up named. Blank names are dropped.
 *
 * @param symbolLabels The declarations' names, in the focus's order.
 * @returns The list, or {@link UNNAMED_SYMBOL_LABEL} when no name is usable.
 * @example
 * // focusSubjectLabel(['‹a›', '‹b›']) === '‹a› and ‹b›'
 * // focusSubjectLabel(['‹a›', '‹b›', '‹c›', '‹d›']) === '‹a›, ‹b›, ‹c› and 1 more'
 */
export function focusSubjectLabel(symbolLabels: readonly string[]): string {
  const named: string[] = [];
  for (const label of symbolLabels) {
    const cleaned = optionalLabel(label);
    if (cleaned !== undefined) {
      named.push(cleaned);
    }
  }
  const shown = named.slice(0, FOCUS_SUBJECT_MAX_ITEMS);
  const hidden = named.length - shown.length;
  return joinWithConjunction(
    hidden > 0 ? [...shown, `${formatCount(hidden)} ${LIST_OVERFLOW_WORD}`] : shown,
    UNNAMED_SYMBOL_LABEL,
  );
}

/**
 * The headline sentence that names what a follow-up's panel concentrates on.
 *
 * Non-evidentiary by construction, like the rest of the headline: it names the
 * focus — a class of behaviour from {@link problemCategoryLabel}, or the
 * declarations from {@link focusSubjectLabel} — and claims nothing that would
 * need citing.
 *
 * @param focusLabel What the panel is focused on. A blank value falls back to
 * {@link PROBLEM_CATEGORY_FALLBACK_LABEL}.
 * @returns One sentence.
 * @example
 * // panelFocusSentence(problemCategoryLabel('data')) === 'Focused on database queries.'
 */
export function panelFocusSentence(focusLabel: string): string {
  return `Focused on ${sanitizeLabel(focusLabel, PROBLEM_CATEGORY_FALLBACK_LABEL)}.`;
}

/** The most silent tiers a headline names: there are three tiers. */
const SILENT_TIER_MAX_ITEMS = 3;

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
 * A panel composed to show where time went across the browser, server and
 * database tiers draws nothing for a tier that recorded no telemetry, and a
 * missing lane or row reads as an oversight unless the headline says why. The
 * silent tiers, when the caller names them, are therefore stated in a second
 * sentence — a statement about what the capture *lacks*, which needs no
 * citation either.
 *
 * @param counts One entry per metric the capture reported, in the order they
 * should read, each pairing a value with the noun {@link metricCountNoun}
 * supplies.
 * @param totalDurationMs The span of the capture or interaction in
 * milliseconds, when one was measured. Omitted leaves the sentence at the
 * counts alone.
 * @param silentTierLabels Wording from {@link telemetryTierLabel} for each tier
 * the panel's views cover but the capture recorded nothing in, in tier order.
 * Omitted or empty adds no second sentence.
 * @param focusLabel What a follow-up's panel concentrates on, when a follow-up
 * governs it: stated last, as {@link panelFocusSentence}, its label shortened
 * should the headline otherwise exceed {@link HEADLINE_MAX_LENGTH}. Omitted or
 * blank adds no sentence, so a first question's headline is unchanged.
 * @returns One to three descriptive sentences.
 * @example
 * // panelSummaryHeadline([{ count: 4, noun: metricCountNoun('request_count') }], 1175)
 * //   === 'The capture recorded 4 requests across 1.175 s.'
 * // panelSummaryHeadline([{ count: 4, noun: metricCountNoun('request_count') }], 1175, ['database'])
 * //   === 'The capture recorded 4 requests across 1.175 s. No database telemetry was recorded, so the views show no work in that tier.'
 * // panelSummaryHeadline([{ count: 4, noun: metricCountNoun('request_count') }], 1175, [], '‹symbol›')
 * //   === 'The capture recorded 4 requests across 1.175 s. Focused on ‹symbol›.'
 */
export function panelSummaryHeadline(
  counts: readonly CountedNoun[],
  totalDurationMs?: number,
  silentTierLabels: readonly string[] = [],
  focusLabel?: string,
): string {
  const rendered = counts.map((entry) => countLabel(entry.count, entry.noun));
  const list = joinWithConjunction(rendered, NO_MEASURED_ACTIVITY_LABEL);
  const counted =
    totalDurationMs === undefined
      ? `The capture recorded ${list}.`
      : `The capture recorded ${list} across ${formatDurationMs(totalDurationMs)}.`;
  const silent = silentTierLabels
    .slice(0, SILENT_TIER_MAX_ITEMS)
    .map((label) => sanitizeLabel(label, TELEMETRY_TIER_FALLBACK_LABEL));
  const tiers = silent.length === 0 ? '' : alternativesLabel(silent);
  const referent = silent.length === 1 ? 'that tier' : 'those tiers';
  const unfocused =
    silent.length === 0
      ? counted
      : `${counted} No ${tiers} telemetry was recorded, so the views show no work in ${referent}.`;
  const focus = optionalLabel(focusLabel);
  if (focus === undefined) {
    return unfocused;
  }
  // The focus sentence is the one part of the headline whose length a label
  // decides, so it is the part shortened should the whole outgrow the bound.
  return fitStatement(
    [focus],
    (fit) => `${unfocused} ${panelFocusSentence(fit(focus))}`,
    HEADLINE_MAX_LENGTH,
  );
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
