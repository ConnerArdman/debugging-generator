/**
 * The fact/hypothesis separation: `EventRef`, `Fact`, `Hypothesis` and the
 * `PanelSummary` that carries them.
 *
 * This module is the **single definition** of the boundary between what was
 * *observed* during a capture and what is merely *inferred* from it (AAP 0.8.4:
 * "Observed facts and inferred causes are kept apart structurally"). The
 * separation is expressed here as types rather than as a convention, because a
 * convention cannot fail a build:
 *
 * - A {@link Fact} cannot exist without at least one {@link EventRef}. The
 *   `.min(1)` on {@link Fact.evidence} is what AAP 0.2.3's "requires at least
 *   one evidence reference" compiles down to, and what makes AAP 0.8.4's
 *   "the analysis prompt forbids unevidenced statements in the observed list"
 *   enforceable rather than aspirational — a statement with nothing to cite is
 *   rejected by the schema, not caught in review.
 * - A {@link Hypothesis} is a {@link Fact} plus a {@link ConfidenceLevel} and an
 *   optional location to look at. It is a *separate type*, so no code path can
 *   move a guess into the observed list by assignment, and both user interfaces
 *   render it under its own heading.
 * - Free prose has exactly one home, {@link PanelSummary.headline}, and that
 *   field is not an array element of either list. A model that authors a string
 *   summary lands there and **can never become a `Fact`** (AAP 0.2.3: "a string
 *   can never become a Fact — facts come only from the validated analysis").
 *   `./normalize.ts` performs that placement; this file is the type shape that
 *   makes any other placement impossible to express.
 *
 * ## Direction of composition
 *
 * These shapes are the bottom of the analysis stack, and everything above
 * composes them:
 *
 * - `./spec.ts` embeds {@link panelSummarySchema} as the normalized panel's
 *   `summary`, which is what the shared component library's summary header
 *   renders: the title, the observed facts with per-item evidence chips, and the
 *   likely causes with confidence badges and a source chip (AAP 0.6.2).
 * - `./semantic.ts` resolves every {@link EventRef.eventId} against the capture
 *   and rejects a specification whose evidence does not exist (AAP 0.8.4).
 * - `@debuggen/protocol`'s `AnalysisResult` is
 *   `{ observed: Fact[], likelyCauses: Hypothesis[], metrics }`, composed from
 *   these exact types — **never the reverse**. `protocol` sits above this
 *   package in the acyclic package graph of AAP 0.2.2, so nothing here may
 *   import it, and `./normalize.ts` therefore takes a *structural* analysis
 *   parameter rather than a protocol type.
 *
 * ## Constraints this module works under
 *
 * - **Environment-neutral.** The sibling `tsup.config.ts` builds with
 *   `platform: 'neutral'` because this package is loaded by the local service,
 *   the DevTools panel and the editor webview alike. No `node:` builtin, no DOM
 *   global, no platform-only API — a single one of them fails the build rather
 *   than shipping a barrel that breaks two of the three consumers.
 * - **JSON-Schema-representable.** `./json-schema.ts` renders the authoring
 *   schemas into the versioned prompt files with `z.toJSONSchema`, and
 *   `./input.ts` reuses the vocabulary declared here. Every constraint below is
 *   therefore expressible in JSON Schema — `min`, `max`, `regex`, `enum` — and
 *   this module deliberately contains no `z.custom`, no `.transform()`, no
 *   `.preprocess()` and no cross-field refinement. A check that needs to see
 *   two fields at once belongs in `./validate.ts`, where nothing renders it
 *   into a prompt.
 * - **Privacy.** A parse failure here is reported with the *shape* of the
 *   failure and none of the data that caused it (AAP 0.5.2). See
 *   {@link describeIssues}, which is exported so that `./validate.ts` and
 *   `./semantic.ts` share one implementation of that rule instead of three.
 *
 * @example
 * ```ts
 * const fact = parseFact({
 *   statement: 'The interaction spent most of its time in one operation.',
 *   evidence: [{ eventId, traceId, kind: 'interaction' }],
 * });
 *
 * if (fact.ok) {
 *   summary.observed.push(fact.value);
 * }
 * ```
 */

import { z } from 'zod';

import {
  DebuggenError,
  SPAN_ID_PATTERN,
  TRACE_ID_PATTERN,
  err,
  ok,
  sourceLocationSchema,
} from '@debuggen/shared';
import type { Result } from '@debuggen/shared';
import { TELEMETRY_KINDS } from '@debuggen/telemetry';

/*
 * ---------------------------------------------------------------------------
 * Bounds
 *
 * Every string and array below is bounded, and the bounds are exported rather
 * than inlined. Two reasons, and neither is style:
 *
 * - A model authors most of these values. An unbounded string or array is an
 *   unbounded payload to store, broadcast to two user interfaces and render,
 *   so the schema states a ceiling and rejects above it (AAP 0.5.3: every
 *   structured output is validated before it can affect anything).
 * - The numbers reach the model as part of the rendered JSON Schema, and they
 *   reach `./normalize.ts`, which has to fit a value into them. Exporting the
 *   constants is what keeps the prompt, the normaliser and the validator
 *   agreeing on one set of limits.
 *
 * The values are generous for legitimate content and hostile to a runaway
 * generation: a sentence, not an essay; a handful of citations, not a capture
 * dump.
 * ---------------------------------------------------------------------------
 */

/**
 * Longest accepted {@link Fact.statement} or {@link Hypothesis.statement}, in
 * characters: **300**.
 *
 * A statement is one sentence a developer reads in a summary header. Three
 * hundred characters is roughly three lines at the panel's text size — enough
 * for a precise observation with numbers in it, and short enough that a model
 * cannot answer with a paragraph where a finding was asked for.
 */
export const MAX_STATEMENT_LENGTH = 300;

/**
 * Longest accepted {@link PanelSummary.headline}, in characters: **500**.
 *
 * Longer than a statement because the headline is the one place prose is
 * allowed, and shorter than a screen because it is a headline. It is
 * non-evidentiary by construction (see {@link PanelSummary.headline}), so its
 * only cost is vertical space.
 */
export const MAX_HEADLINE_LENGTH = 500;

/**
 * Longest accepted {@link EventRef.label}, in characters: **200**.
 *
 * The label is a chip caption, not a description. Two hundred characters lets a
 * redacted operation name or a duration phrase through and truncates nothing a
 * chip could have displayed anyway.
 */
export const MAX_EVENT_REF_LABEL_LENGTH = 200;

/**
 * Longest accepted {@link EventRef.eventId}, in characters: **128**.
 *
 * Event ids are the prefixed identifiers `@debuggen/shared`'s `ids` module
 * generates, an order of magnitude shorter than this. The bound exists so that
 * an identifier field cannot be used as a smuggling channel for a long string,
 * which is the same reason the object is strict.
 */
export const MAX_EVENT_REF_ID_LENGTH = 128;

/**
 * Most evidence references one {@link Fact} may cite: **50**.
 *
 * A finding that needs more than fifty citations is a finding stated at the
 * wrong granularity — the aggregate sources (`renders`, `requests`, `queries`)
 * exist precisely so that "this happened 400 times" is one fact about a group
 * rather than four hundred references. Fifty leaves ample room for citing every
 * occurrence of a genuinely small group.
 */
export const MAX_EVIDENCE_REFS = 50;

/**
 * Most facts one {@link PanelSummary} may list: **20**.
 *
 * The summary header is read before anything else in a panel; twenty
 * evidence-backed observations is already more than a developer scans. The
 * visualization nodes, not the summary, are where a long tail belongs.
 */
export const MAX_SUMMARY_FACTS = 20;

/**
 * Most hypotheses one {@link PanelSummary} may list: **10**.
 *
 * Deliberately lower than {@link MAX_SUMMARY_FACTS}. Facts accumulate
 * harmlessly, but a long list of competing guesses is worse than a short one:
 * it reads as certainty spread thin, and the developer has to rank it. Ten is a
 * ceiling, not a target.
 */
export const MAX_SUMMARY_HYPOTHESES = 10;

/**
 * Requires at least one non-whitespace character.
 *
 * Paired with `.min(1)` on every free-text field here, because `.min(1)` alone
 * accepts `' '` and a whitespace-only statement is an unevidenced claim with a
 * blank label: it passes validation, renders as an empty row and cites real
 * events for nothing. Deliberately *unanchored* and deliberately not `.trim()`
 * — a transform would be unrepresentable in JSON Schema and would silently
 * rewrite a model's output, whereas a `pattern` survives `z.toJSONSchema` and
 * rejects instead of repairing (AAP 0.5.3).
 */
const NON_BLANK_PATTERN = /\S/;

/*
 * ---------------------------------------------------------------------------
 * EventRef — a pointer into the capture
 * ---------------------------------------------------------------------------
 */

/**
 * A reference to one captured telemetry event, and the definition of
 * {@link EventRef}.
 *
 * This is the citation a {@link Fact} carries: the mechanism by which "what the
 * analysis says" stays attached to "what the capture holds". `./semantic.ts`
 * resolves every reference against the capture and rejects a panel whose
 * evidence does not exist (AAP 0.8.4), and the shared component library turns
 * each one into an evidence chip that selects the underlying event (AAP 0.6.2)
 * — which is why evidence is addressable *per item* rather than as one blob of
 * text per fact.
 *
 * **Deliberate non-goal: this is a pointer, and it must not restate the
 * `TelemetryEvent` shape.** That shape is defined exactly once, in
 * `@debuggen/telemetry`'s `schema/event.ts` (AAP 0.2.3; AAP 0.9.1 lists it
 * among the single-definition schema sources, and "any second definition of
 * these shapes in an app is a defect"). Copying a duration, an attribute bag or
 * a source location into a citation would create a second, unredacted,
 * never-refreshed copy of the evidence inside the artifact that cites it.
 * Resolution is the job of `./semantic.ts` and of the service's panel-data
 * route, both of which read the stored event.
 *
 * Strict: an unrecognised key is a rejection rather than a silently stripped
 * field, so a model cannot attach extra data to a citation and have it
 * persisted with the panel.
 */
export const eventRefSchema = z.strictObject({
  /**
   * The id of the cited event — **the only field that carries meaning**.
   *
   * Everything else on this object is either a redundant coordinate that makes
   * a stored reference readable without a lookup (`traceId`, `spanId`, `kind`)
   * or display sugar (`label`). A resolver needs this field and nothing else.
   *
   * Validated as a bounded, non-blank string rather than against an id pattern:
   * `@debuggen/shared` exports patterns for the two hexadecimal identifiers the
   * W3C trace-context header fixes, and none for the prefixed identifiers it
   * generates, because their format is this product's own and re-asserting it
   * here would make a citation's validity depend on an id's spelling. Existence
   * is checked where it can actually be checked — against the capture, in
   * `./semantic.ts`.
   */
  eventId: z
    .string()
    .min(1)
    .max(MAX_EVENT_REF_ID_LENGTH)
    .regex(NON_BLANK_PATTERN, { error: 'eventId must contain a non-whitespace character.' }),

  /**
   * The trace the cited event belongs to, when the citation records it.
   *
   * Optional and redundant — the stored event carries it — but worth keeping on
   * the reference: a panel's trace-scoped visualizations are filtered by trace
   * id, and a citation that names its trace can be checked for consistency with
   * the node it sits beside without resolving it first.
   *
   * Validated with `TRACE_ID_PATTERN` from `@debuggen/shared` (32 lowercase hex
   * characters), imported rather than restated so the format is asserted in one
   * place across every package that handles a trace id.
   */
  traceId: z
    .string()
    .regex(TRACE_ID_PATTERN, { error: 'traceId must be 32 lowercase hexadecimal characters.' })
    .optional(),

  /**
   * The span the cited event is, when the citation records it.
   *
   * Optional for the same reason as `traceId`, and validated with
   * `SPAN_ID_PATTERN` from `@debuggen/shared` (16 hexadecimal characters) for
   * the same reason: one definition of the format, imported.
   */
  spanId: z
    .string()
    .regex(SPAN_ID_PATTERN, { error: 'spanId must be 16 hexadecimal characters.' })
    .optional(),

  /**
   * What kind of event is being cited, when the citation records it.
   *
   * Built as an enumeration over `TELEMETRY_KINDS`, **imported** from
   * `@debuggen/telemetry`. That module is the single definition of the kind
   * vocabulary and states that no other module may hard-code a list of kind
   * strings; a copy here would drift the moment a kind is added and would
   * mis-render every citation of the new kind.
   *
   * Its value is in the user interface: a chip can carry the kind's colour and
   * icon before the event itself has been fetched.
   */
  kind: z.enum(TELEMETRY_KINDS).optional(),

  /**
   * A short caption for the chip, when the citation supplies one.
   *
   * Display sugar, and the only free text on a citation. Bounded by
   * {@link MAX_EVENT_REF_LABEL_LENGTH} and required to be non-blank, so a
   * present label always renders as something.
   *
   * **Privacy:** a label is authored from already-redacted aggregates
   * (AAP 0.5.2) and must never carry a raw captured value — a query string, a
   * header value, SQL literals or a prop value. No schema can detect that, so
   * it is stated here as the contract every producer of an `EventRef` is held
   * to; the redaction layer in `@debuggen/telemetry` and the outbound guard in
   * `@debuggen/model-provider` are what enforce it on the paths that carry
   * captured data.
   */
  label: z
    .string()
    .min(1)
    .max(MAX_EVENT_REF_LABEL_LENGTH)
    .regex(NON_BLANK_PATTERN, { error: 'label must contain a non-whitespace character.' })
    .optional(),
});

/**
 * A citation: which captured event substantiates a statement.
 *
 * Inferred from {@link eventRefSchema} rather than declared beside it, so the
 * validator and the type are one statement and a field added to the schema
 * appears here in the same edit.
 */
export type EventRef = z.infer<typeof eventRefSchema>;

/*
 * ---------------------------------------------------------------------------
 * The confidence vocabulary
 * ---------------------------------------------------------------------------
 */

/**
 * How much confidence a {@link Hypothesis} is stated with, lowest first.
 *
 * **A closed vocabulary of three, and deliberately not a number.** Three
 * consumers have to agree on it: the analysis prompt, which instructs a model
 * to pick one of these words; the summary header, which renders a confidence
 * badge per hypothesis (AAP 0.6.2) and needs a finite set of badge styles to do
 * it; and the deterministic provider and fallback path, which must produce
 * something valid without a model. A free number would give all three a
 * precision the analysis does not have — there is no calibration behind "0.67"
 * — and a free string would let a model invent a fourth level that no badge
 * exists for.
 *
 * Declaration order is ascending severity, and it is load-bearing:
 * {@link compareConfidence} is derived from it, so the ordering is stated once
 * here and nowhere else.
 *
 * Frozen, matching the vocabulary convention of the sibling schema packages: it
 * is a shared module-level constant, and a mutation would re-rank every
 * hypothesis in the process.
 */
export const CONFIDENCE_LEVELS = Object.freeze(['low', 'medium', 'high'] as const);

/**
 * One member of the closed confidence vocabulary.
 *
 * Derived from {@link CONFIDENCE_LEVELS} rather than declared beside it, so the
 * values and the type cannot drift: a level added to the tuple widens this
 * union in the same edit, and every consumer that switches exhaustively over it
 * — the badge in the summary header above all — stops compiling until it says
 * what the new level looks like.
 */
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** The validator for a single {@link ConfidenceLevel}. */
export const confidenceLevelSchema = z.enum(CONFIDENCE_LEVELS);

/**
 * Ascending rank per level, the numeric form of {@link CONFIDENCE_LEVELS}'
 * declaration order.
 *
 * Module-private on purpose: {@link compareConfidence} is the supported way to
 * ask about ordering, and exporting the table as well would invite a second
 * implementation of the comparison that could disagree with the first. Total by
 * construction — the key type is the closed union, so the lookup is exact and
 * never `undefined`, even under `noUncheckedIndexedAccess`.
 */
const CONFIDENCE_RANK: Readonly<Record<ConfidenceLevel, number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
});

/**
 * Widened view of {@link CONFIDENCE_LEVELS} for {@link isConfidenceLevel}.
 *
 * The tuple's own type is a union of three literals, which `includes` refuses
 * for an arbitrary string; this annotation is what lets the guard test an
 * unknown value without a cast, and it is the same device the telemetry
 * package's vocabularies use.
 */
const CONFIDENCE_VALUES: readonly string[] = CONFIDENCE_LEVELS;

/**
 * Whether `value` is one of the three {@link CONFIDENCE_LEVELS}.
 *
 * Exported for the same reason `@debuggen/telemetry` exports a guard for its
 * kind vocabulary: a value read back out of the store, or arriving in a
 * structural parameter that was typed loosely to avoid an upward import, has to
 * be narrowed somewhere, and every call site doing that with its own inline
 * list of three strings is how a vocabulary drifts.
 *
 * @param value Any value.
 * @returns `true` when `value` is a member of the vocabulary, narrowing it to
 * {@link ConfidenceLevel}.
 */
export function isConfidenceLevel(value: unknown): value is ConfidenceLevel {
  return typeof value === 'string' && CONFIDENCE_VALUES.includes(value);
}

/**
 * Compares two confidence levels by ascending severity: `low < medium < high`.
 *
 * A comparator in the shape `Array.prototype.sort` expects, so the service and
 * the renderer can order hypotheses deterministically without either of them
 * restating which level outranks which. Ascending is the primitive; a user
 * interface that wants the most confident cause first reverses the arguments:
 *
 * ```ts
 * const mostConfidentFirst = [...summary.likelyCauses].sort((a, b) =>
 *   compareConfidence(b.confidence, a.confidence),
 * );
 * ```
 *
 * Determinism matters beyond tidiness: two panels generated from one capture
 * are compared in the end-to-end suites, and a list whose order depends on
 * insertion sequence makes a real difference indistinguishable from a reshuffle.
 * Callers that need a total order sort on a stable secondary key of their own,
 * since this function reports `0` for two hypotheses at the same level.
 *
 * @param a The left level.
 * @param b The right level.
 * @returns A negative number when `a` is less confident than `b`, `0` when they
 * are equal, and a positive number when `a` is more confident.
 */
export function compareConfidence(a: ConfidenceLevel, b: ConfidenceLevel): number {
  return CONFIDENCE_RANK[a] - CONFIDENCE_RANK[b];
}

/*
 * ---------------------------------------------------------------------------
 * Fact and Hypothesis
 * ---------------------------------------------------------------------------
 */

/**
 * The fields every observed statement has, as a reusable shape.
 *
 * Declared as a plain object of field schemas — the device the sibling schema
 * packages use — so that {@link hypothesisSchema} can be built by *spreading*
 * it rather than by retyping `statement` and `evidence`. Retyping is how two
 * shapes drift: a bound tightened on one and not the other would let a
 * hypothesis carry a statement a fact could not, and the two lists in a summary
 * header would start validating differently.
 */
const factShape = {
  /**
   * What was observed, in one sentence.
   *
   * Non-blank and bounded by {@link MAX_STATEMENT_LENGTH}. The statement is
   * prose, but — unlike {@link PanelSummary.headline} — it is prose that only
   * exists attached to the `evidence` beside it, which is the whole point of
   * this object: there is no way to express a statement in the observed list
   * without citing something for it.
   */
  statement: z
    .string()
    .min(1)
    .max(MAX_STATEMENT_LENGTH)
    .regex(NON_BLANK_PATTERN, { error: 'statement must contain a non-whitespace character.' }),

  /**
   * The captured events that substantiate the statement. **At least one.**
   *
   * `.min(1)` is the mechanical expression of AAP 0.2.3 — "`Fact { statement,
   * evidence: EventRef[] }` requires at least one evidence reference" — and of
   * AAP 0.8.4's rule that the analysis prompt forbids unevidenced statements in
   * the observed list. It is what makes the separation structural: an assertion
   * with nothing to cite cannot be parsed into a {@link Fact} at all, so it
   * cannot reach the store, a panel or a user interface as one. A model that
   * wants to say something unevidenced has exactly one place to put it, and it
   * is not here.
   *
   * `.max(MAX_EVIDENCE_REFS)` bounds the other end, so a generation cannot
   * substitute volume for precision.
   */
  evidence: z.array(eventRefSchema).min(1).max(MAX_EVIDENCE_REFS),
};

/**
 * An observed fact, and the definition of {@link Fact}.
 *
 * Strict: an unrecognised key is a rejection. A fact is the product's evidence
 * record, and an extra field on it would be prose, a confidence or a location
 * that arrived without passing any of the checks those things have — the three
 * mistakes this module exists to prevent.
 */
export const factSchema = z.strictObject(factShape);

/**
 * Something the capture shows, with the evidence that shows it.
 *
 * Inferred from {@link factSchema}, so the validator and the type are one
 * statement. This is the element type of {@link PanelSummary.observed} and of
 * `AnalysisResult.observed` in `@debuggen/protocol`.
 */
export type Fact = z.infer<typeof factSchema>;

/**
 * A possible explanation, and the definition of {@link Hypothesis}.
 *
 * The {@link factSchema} shape — a statement and at least one citation — plus
 * two fields, built by spreading {@link factShape} so the common part can never
 * drift from the fact's. A hypothesis is still evidence-backed: a guess is
 * allowed to be wrong, but it is not allowed to be about nothing.
 *
 * Strict, for the same reason {@link factSchema} is.
 */
export const hypothesisSchema = z.strictObject({
  ...factShape,

  /**
   * How much confidence the explanation is offered with.
   *
   * Required: an unranked hypothesis is one the developer has to rank, and the
   * summary header has no badge to draw for it (AAP 0.8.4 — "`likelyCauses`
   * carry a confidence level").
   *
   * **Not to be confused with `SourceLocation.confidence`.** The two share a
   * word and measure unrelated things, which is a genuine trap when reading a
   * hypothesis that carries both:
   *
   * - *This* field is the **analytical** confidence in the explanation, one of
   *   the three {@link CONFIDENCE_LEVELS}.
   * - `suggestedLocation.confidence` is a **resolver** confidence, a number from
   *   0 to 1 reporting how sure the mechanism that produced the location is
   *   that it points at the right line (`@debuggen/shared`'s
   *   `source-location.ts`).
   *
   * A high-confidence explanation can carry a weakly resolved location, and a
   * precisely resolved location can support a low-confidence explanation.
   * Neither value may be derived from the other.
   */
  confidence: confidenceLevelSchema,

  /**
   * Where in the project to look, when the analysis can name a place.
   *
   * Optional: an explanation is frequently better supported by its evidence
   * than by any single line of code, and a guessed location is worse than none
   * — it sends the developer to the wrong file with the product's authority
   * behind it.
   *
   * When present, this is what the summary header renders as a source chip
   * under the "likely cause" heading, and clicking it opens the editor at the
   * file, line and column (AAP 0.6.2, 0.6.5).
   *
   * {@link sourceLocationSchema} is **imported, never restated**: it is the
   * single definition of the shape (AAP 0.9.1), and importing it is what makes
   * its two guarantees apply here — that `file` is a safe project-relative
   * POSIX path with no absolute prefix and no `'..'` segment, and that `line`
   * and `column` are 1-based — at the moment a model-authored location is
   * parsed, before it can reach a store, a prompt or a filesystem call.
   */
  suggestedLocation: sourceLocationSchema.optional(),
});

/**
 * A possible explanation of the observed facts: evidence-backed, ranked by
 * confidence, and optionally pointing at a place in the code.
 *
 * Inferred from {@link hypothesisSchema}. Structurally a {@link Fact} with two
 * fields added, but a **distinct type**, which is the property that matters:
 * `Hypothesis` is assignable to `Fact`, and a `Fact` is not assignable to
 * `Hypothesis`, so a guess can be read as the observation it cites while an
 * observation can never be silently promoted into the likely-cause list.
 */
export type Hypothesis = z.infer<typeof hypothesisSchema>;

/*
 * ---------------------------------------------------------------------------
 * PanelSummary
 * ---------------------------------------------------------------------------
 */

/**
 * The normalized summary of a generated panel, and the definition of
 * {@link PanelSummary}.
 *
 * `./spec.ts` embeds this as the panel's `summary`, and the shared component
 * library's summary header renders it in three registers that the type keeps
 * apart: optional prose, observed facts with evidence chips, and likely causes
 * with confidence badges and source chips (AAP 0.6.2).
 *
 * Strict: the three fields below are the only registers there are. A fourth key
 * would be a fourth register nothing renders — or, worse, one that renders
 * beside the facts without their guarantees.
 */
export const panelSummarySchema = z.strictObject({
  /**
   * Non-evidentiary prose. **Never a fact.**
   *
   * This is where a string summary goes. The panel authoring schema accepts
   * `summary` as either a string or an object, and when a model writes a bare
   * string, `./normalize.ts` places it here — as a headline, unattached to any
   * evidence — and fills `observed` and `likelyCauses` only from the validated
   * analysis (AAP 0.2.3: "stores a string `summary` as the non-evidentiary
   * `summary.headline` (never as an observed fact — facts come only from the
   * validated analysis)", and "a string can never become a `Fact`").
   *
   * The type shape is what makes that enforceable rather than merely
   * documented. A `string` is not a {@link Fact} and cannot be pushed into
   * `observed`; building one would require inventing an `evidence` array, which
   * `./semantic.ts` then resolves against the capture and rejects. There is no
   * field on this object into which prose can be promoted, and that absence is
   * the guarantee.
   *
   * Optional, because a deterministic panel assembled from capture aggregates
   * has no prose to offer, and a headline is not worth inventing.
   */
  headline: z
    .string()
    .min(1)
    .max(MAX_HEADLINE_LENGTH)
    .regex(NON_BLANK_PATTERN, { error: 'headline must contain a non-whitespace character.' })
    .optional(),

  /**
   * What the capture shows, each item evidence-backed by construction.
   *
   * **Defaulted to an empty array rather than made optional**, so that every
   * consumer — the summary header, the service, a stored row read back — can
   * iterate without branching on `undefined`. Parsing a summary that omits the
   * key yields `[]`.
   *
   * An empty list is legitimate: the fallback panel of AAP 0.5.5, assembled
   * deterministically when a model's output cannot be validated, may carry
   * prose and visualizations with no model-derived facts at all, and it renders
   * under a visible fallback banner rather than pretending to have findings. A
   * **non-empty** list, on the other hand, is always evidence-backed, because
   * {@link factSchema} admits no member that is not.
   *
   * Bounded by {@link MAX_SUMMARY_FACTS}.
   */
  observed: z.array(factSchema).max(MAX_SUMMARY_FACTS).default([]),

  /**
   * What might explain the observed facts, each ranked and evidence-backed.
   *
   * Defaulted and bounded exactly as `observed` is, and kept in its own field
   * for the reason this whole module exists: a hypothesis is rendered under a
   * separate "likely cause" heading, and no code path may move an item between
   * the two lists without changing its type (AAP 0.8.4).
   *
   * Order is the author's; a consumer that wants it ranked sorts with
   * {@link compareConfidence}.
   */
  likelyCauses: z.array(hypothesisSchema).max(MAX_SUMMARY_HYPOTHESES).default([]),
});

/**
 * A generated panel's summary: optional prose, observed facts, likely causes.
 *
 * Inferred from {@link panelSummarySchema}. Because both arrays carry a default,
 * this type has them as required properties — `observed: Fact[]`,
 * `likelyCauses: Hypothesis[]` — while a value being parsed may omit either.
 */
export type PanelSummary = z.infer<typeof panelSummarySchema>;

/*
 * ---------------------------------------------------------------------------
 * Validation failures: structure only, and non-throwing parsers
 * ---------------------------------------------------------------------------
 */

/**
 * One validation failure, reduced to its **structure**.
 *
 * `path` is the dotted path of the offending field — `'evidence.0.eventId'`, or
 * the empty string for an issue on the object itself, which is what an
 * unrecognised top-level key produces. `code` is the issue code the schema
 * library reported. `expected` is present only where that library supplies it,
 * which is on a type mismatch.
 */
export interface SchemaIssueSummary {
  /** Dotted path of the offending field, or `''` for the object itself. */
  readonly path: string;
  /** The issue code, for example `'too_small'` or `'invalid_type'`. */
  readonly code: string;
  /** The type that was expected, where one is reported. */
  readonly expected?: string;
}

/**
 * Reduces validation issues to {@link SchemaIssueSummary} values — **paths and
 * codes only, never the rejected value**.
 *
 * This is AAP 0.5.2's privacy rule applied to validation failures, and it is
 * not theoretical here: the values rejected by the schemas above are
 * model-authored panel content and citations of captured data, and the error
 * built from them is logged, may be persisted with the session and is shown in
 * both user interfaces. An error raised this deep in a call stack passes
 * through neither the redaction layer nor the outbound model guard, so the only
 * safe rule is that the offending data never enters it.
 *
 * Kept: the field path, the issue code, and the expected type on a type
 * mismatch. Deliberately dropped:
 *
 * - the offending value itself, under any of its names;
 * - the issue's own `message`, which is the library's formatting decision and
 *   can embed what it received — the field schemas above state their
 *   expectations without reference to it, so nothing is lost;
 * - every other member, including an unrecognised-keys list: a key name is
 *   usually authored code, but it *can* be computed, and the path with the code
 *   already identifies the problem.
 *
 * The library's own error formatters are unusable for the same reason and are
 * not used.
 *
 * **Exported deliberately.** `./validate.ts` and `./semantic.ts` report
 * failures of the same kind about the same content, and leak prevention that
 * exists in three copies is leak prevention that will exist in two once one of
 * them is edited. They import this function; this module is where the rule
 * lives.
 *
 * @param issues The issues from a failed parse.
 * @returns One summary per issue, in the order they were reported.
 */
export function describeIssues(issues: readonly z.core.$ZodIssue[]): SchemaIssueSummary[] {
  return issues.map((issue) => {
    // Path segments are property keys, which may be array indices or symbols,
    // so each is stringified before joining.
    const path = issue.path.map((segment) => String(segment)).join('.');

    if (issue.code === 'invalid_type') {
      return { path, code: issue.code, expected: issue.expected };
    }

    return { path, code: issue.code };
  });
}

/** The hint offered when an observed fact fails validation. */
const FACT_HINT =
  'A fact needs a non-empty statement and at least one evidence reference, each naming the id of a captured event.';

/** The hint offered when a hypothesis fails validation. */
const HYPOTHESIS_HINT =
  'A hypothesis needs everything a fact needs plus a confidence of low, medium or high; suggestedLocation is optional and, when present, needs a project-relative POSIX file with a 1-based line and column.';

/**
 * Builds the rejection for a failed parse: a coded {@link DebuggenError}
 * carrying the shape of the failure and none of the data that caused it.
 *
 * The code is `'PANEL_INVALID'`. `@debuggen/shared`'s `errors.ts` owns a closed
 * code vocabulary and a new code is never invented here; of the codes it
 * offers, this is the panel-validation one, and these shapes are parsed on the
 * panel path — which makes it more specific than the `'PROTOCOL_INVALID_MESSAGE'`
 * the sibling schema packages use for values a transport delivered.
 * Deliberately not `'PANEL_SEMANTIC_INVALID'`, which `./semantic.ts` uses for a
 * specification that is well-formed but cites evidence the capture does not
 * hold; a caller at a stage boundary that wants the model-output vocabulary
 * maps this one with `mapErr` to `'MODEL_OUTPUT_INVALID'`.
 */
function rejection(
  schemaName: string,
  hint: string,
  issues: readonly z.core.$ZodIssue[],
): DebuggenError {
  return new DebuggenError('PANEL_INVALID', `A value did not match the ${schemaName} schema.`, {
    hint,
    details: { schema: schemaName, issues: describeIssues(issues) },
  });
}

/**
 * Validates an unknown value as a {@link Fact}, without throwing.
 *
 * This is how a statement that arrived from somewhere else — a model's
 * structured output, a stored analysis, a WebSocket payload — becomes a typed
 * fact. Non-throwing is a requirement rather than a preference: a rejected fact
 * must degrade the panel it was destined for (AAP 0.5.5's fallback path), not
 * abort the pipeline stage that produced it, so the caller inspects the result
 * and continues.
 *
 * A value with an empty `evidence` array is rejected here, which is the whole
 * guarantee of this module reduced to a single call.
 *
 * @param value Any value believed to be an observed fact.
 * @returns `ok(fact)` with the parsed value, or `err(error)` describing every
 * issue found, by path and code only.
 */
export function parseFact(value: unknown): Result<Fact, DebuggenError> {
  const parsed = factSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(rejection('fact', FACT_HINT, parsed.error.issues));
}

/**
 * Validates an unknown value as a {@link Hypothesis}, without throwing.
 *
 * The counterpart of {@link parseFact}, over {@link hypothesisSchema}: the same
 * evidence requirement, plus a confidence from the closed vocabulary and, when
 * one is offered, a source location that has passed every check
 * `@debuggen/shared`'s definition applies. The same privacy rule governs the
 * error it returns.
 *
 * @param value Any value believed to be a hypothesis.
 * @returns `ok(hypothesis)` with the parsed value, or `err(error)` describing
 * every issue found, by path and code only.
 */
export function parseHypothesis(value: unknown): Result<Hypothesis, DebuggenError> {
  const parsed = hypothesisSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(rejection('hypothesis', HYPOTHESIS_HINT, parsed.error.issues));
}
