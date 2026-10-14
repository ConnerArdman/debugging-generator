/**
 * The **analysis artifact** of the Debug Generator: what a capture showed, what
 * may explain it, and the measurements both statements were drawn from.
 *
 * This is the one definition of that shape in the monorepo (AAP §0.9.1 lists
 * this file among the single-definition schema sources), and it has four
 * consumers that never see each other:
 *
 * - `./session-record.ts` embeds it as `SessionRecord.analyses[]`, so a reopened
 *   session renders its findings from the store rather than from a model.
 * - `./messages/session.ts` carries it as the `analysis.completed` payload
 *   `{ sessionId, analysis: AnalysisResult }` (AAP §0.4.2), which is what puts
 *   the same "Observed" / "Likely cause" text in the VS Code view and in the
 *   DevTools panel.
 * - `./http.ts` returns it from the session routes that hand a client the
 *   findings it missed while disconnected.
 * - `apps/local-service/src/analysis/{summarize,facts}.ts` produce it, and
 *   `apps/local-service/src/panels/generate.ts` passes it to `normalizePanel`,
 *   which copies its two lists into the generated panel's summary.
 *
 * A second definition of any of this in an app is a defect, not a convenience.
 *
 * ## Two schemas, and why they are two
 *
 * {@link analysisFindingsSchema} is the **model-authored** half: exactly
 * `{ observed, likelyCauses }`, and exactly what
 * `apps/local-service/src/pipeline/stages/analyze.ts` validates as the analyze
 * stage's structured output before anything else happens to it (AAP §0.4.2).
 * {@link analysisResultSchema} is the **persisted and broadcast** artifact: the
 * findings plus the identity, version, provenance, timestamp and metric values
 * that deterministic service code supplies. The model never proposes an `id`, a
 * `sessionId`, a `captureId`, an `analysisVersion`, a `createdAt` or a metric —
 * identity is not a thing to be guessed, and a measurement it invented would be
 * indistinguishable from one the capture produced.
 *
 * That split is the same authoring-versus-normalized discipline
 * `@debuggen/instrumentation` applies to plans and `@debuggen/panel-schema`
 * applies to panel specifications (AAP §0.5.3): a model's output is validated
 * against the authoring schema first, deterministic code then assembles the
 * internal document, and the internal schema is checked separately. Keeping the
 * halves in one module — with the result built by spreading the findings shape —
 * is what stops them from drifting apart.
 *
 * ## Every observation is evidenced, structurally
 *
 * `Fact` and `Hypothesis` are **imported** from `@debuggen/panel-schema`, never
 * restated. Importing them is not a style choice: a `Fact` requires at least one
 * `EventRef`, so an assertion that cites nothing cannot be parsed into this
 * artifact at all, which is precisely what makes AAP §0.8.4's separation of
 * observed facts from inferred causes true of the product rather than merely
 * requested of the model. Prose with nothing to cite has exactly one place to
 * go, and it is not here: `normalizePanel` puts an authored string summary in the
 * panel's non-evidentiary `summary.headline` and fills `summary.observed` and
 * `summary.likelyCauses` **only** from a validated analysis (AAP §0.2.3). So the
 * facts a panel displays provably originate in this schema.
 *
 * Evidence references are *not* resolved here. An `EventRef` requires only an
 * `eventId`; whether that id exists in the capture is decided by
 * `packages/panel-schema/src/semantic.ts` and, authoritatively, by the service
 * against its `telemetry_events` table. This module validates shape, and shape
 * only.
 *
 * ## The structural edge to panel-schema
 *
 * `packages/panel-schema` sits **below** this package in the layering (AAP
 * §0.2.2) and therefore cannot import it, so `normalizePanel(input, analysis,
 * context)` accepts its analysis through the structural parameter type
 * `NormalizeAnalysis`. Keeping {@link AnalysisResult} assignable to it is this
 * module's job, and {@link AnalysisEdgePreserved} makes the compiler do the
 * keeping.
 *
 * ## Failure reporting
 *
 * Both parsers are non-throwing and return a `Result`, because
 * `apps/local-service/src/sessions/state-machine.ts` branches on the outcome: a
 * session reaches `generated` only once a validated `AnalysisResult` *and* a
 * validated `PanelSpec` exist, so a rejection has to be a value the state
 * machine can route to `failed` rather than an exception unwinding through a
 * stage (AAP §0.5.5 — a failure is never presented as a successful analysis).
 *
 * Every failure message is built by `protocolParseError` from `./version.js`,
 * which renders issue paths and codes and never a rejected value. An analysis
 * carries statements, redacted URLs, SQL text and file paths; none of it may
 * reach a log line, a persisted row or a user-interface banner through an error
 * string (AAP §0.5.2).
 *
 * Every export is named; there is no default export, no `.transform()`, no
 * `.coerce`, no `.default()` and no `.catch()` in this package — a schema here
 * validates, it never rewrites — and importing this module has no side effect.
 */

import { z } from 'zod';

import { err, newAnalysisId, nowEpochMs, ok } from '@debuggen/shared';
import type { AnalysisId, CaptureId, DebuggenError, Result, SessionId } from '@debuggen/shared';
import { METRIC_IDS, isMetricId } from '@debuggen/telemetry';
import type { MetricValue } from '@debuggen/telemetry';
import {
  MAX_SUMMARY_FACTS,
  MAX_SUMMARY_HYPOTHESES,
  factSchema,
  hypothesisSchema,
} from '@debuggen/panel-schema';
import type { Fact, Hypothesis, NormalizeAnalysis } from '@debuggen/panel-schema';

import { epochMsSchema, isPlainRecord, opaqueArraySchema, protocolParseError } from './version.js';

// ---------------------------------------------------------------------------
// Section A — module-local primitives
// ---------------------------------------------------------------------------

/**
 * The first {@link AnalysisResult.analysisVersion}: **1**.
 *
 * Exported so the service, the store and the suites agree on where versioning
 * begins instead of each writing a literal. A follow-up answered from the stored
 * capture is saved as version *n + 1* with `supersedes` naming its predecessor
 * (AAP §0.4.2), so the counter is also the length of the session's analysis
 * history.
 *
 * Declared here rather than after {@link analysisResultSchema}, where the
 * file's reading order would otherwise put it: the schema's lower bound *is*
 * this constant, and a `const` referenced during another declaration's
 * initialisation has to be initialised first.
 */
export const ANALYSIS_VERSION_START = 1;

/**
 * The longest identifier any field in this module will consider.
 *
 * The folder-canonical bound, module-local like its counterparts in
 * `./messages/*.ts`. The ids this product mints are twenty characters — a
 * three-letter kind prefix, an underscore and sixteen random characters
 * (`@debuggen/shared`'s `newId`) — so sixty-four leaves room for an id from an
 * older build or a longer prefix while still refusing a value that arrived with
 * a megabyte where an analysis id belonged.
 */
const MAX_ID_LENGTH = 64;

/**
 * An opaque identifier as a field: a non-empty string of at most
 * {@link MAX_ID_LENGTH} characters.
 *
 * Deliberately **not** the `ana_`/`ses_`/`cap_` prefix patterns. The prefix
 * vocabulary and the id grammar belong to `packages/shared/src/ids.ts`, which
 * mints every id in the product; re-deriving either here would be a second
 * definition of a shape this package does not own, and it would reject a stored
 * analysis from a build whose prefixes differed. `AnalysisId`, `SessionId` and
 * `CaptureId` are plain unbranded string aliases, so a value validated by this
 * schema satisfies all three, and identity is resolved where the id is looked
 * up.
 */
const idSchema = z
  .string()
  .min(1, { error: 'expected a non-empty identifier' })
  .max(MAX_ID_LENGTH, {
    error: `expected an identifier of at most ${String(MAX_ID_LENGTH)} characters`,
  });

/**
 * The statement of the `supersedes` rule, kept beside the check that enforces it.
 *
 * It names the two fields and no value, which is the failure policy of this
 * package (AAP §0.5.2).
 */
const SUPERSEDES_RULE =
  'supersedes must name a different analysis than id: an analysis version cannot supersede itself.';

/**
 * Rejects an analysis whose `supersedes` names its own `id`.
 *
 * A self-superseding record is not harmless. `supersedes` is the backward link
 * of the follow-up chain (AAP §0.4.2), so a row pointing at itself makes any
 * consumer that walks the history — the Sessions view listing what a follow-up
 * replaced, a retention pass deciding what is still reachable — loop or report
 * the current version as its own predecessor. Refusing it at the schema costs a
 * rejection; accepting it costs a cycle in stored data that nothing later can
 * distinguish from a genuine link.
 *
 * Reported on the `supersedes` path, because that is the field a producer has to
 * change. Zod runs an object's checks only after its fields have parsed, so both
 * values are strings by the time this comparison runs.
 */
function checkSupersedesIsNotSelf(
  payload: z.core.ParsePayload<{ id: string; supersedes?: string | undefined }>,
): void {
  if (payload.value.supersedes === undefined) {
    return;
  }

  if (payload.value.supersedes === payload.value.id) {
    payload.issues.push({
      code: 'custom',
      path: ['supersedes'],
      message: SUPERSEDES_RULE,
      // Left empty on purpose: zod strips a finalized issue's `input` unless a
      // parse context asks for it, and a failure here never carries the value
      // that caused it (AAP §0.5.2).
      input: undefined,
    });
  }
}

/**
 * Validates `value` against `schema`, reporting a rejection as a `Result`.
 *
 * The one rejection path of this module, so that both parsers below produce the
 * same error shape and obey the same privacy rule without each remembering to.
 *
 * @typeParam T The schema's output type.
 * @param value The unvalidated value — a model's structured output, a frame's
 * payload or a row read back from the session store.
 * @param schema The schema to apply.
 * @param code The failure being reported, chosen by the caller because the code
 * is what a user interface switches on.
 * @param prefix A short statement of what failed to validate.
 * @param hint A developer-facing next step, forwarded verbatim by
 * `DebuggenError.toPayload()` and therefore as free of rejected data as the
 * message.
 * @returns `ok(parsed)`, or `err(error)` describing the offending paths.
 */
function parseWith<T>(
  value: unknown,
  schema: z.ZodType<T>,
  code: Parameters<typeof protocolParseError>[0],
  prefix: string,
  hint: string,
): Result<T, DebuggenError> {
  const parsed = schema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(protocolParseError(code, prefix, parsed.error.issues, hint));
}

// ---------------------------------------------------------------------------
// Section B — AnalysisFindings: the model-authored artifact
// ---------------------------------------------------------------------------

/**
 * The analyze stage's structured output: what the capture showed, and what may
 * explain it.
 *
 * This is **exactly** what a model is asked for and exactly what
 * `apps/local-service/src/pipeline/stages/analyze.ts` validates before the
 * result is assembled (AAP §0.4.2's stage table names the artifact
 * `AnalysisResult { observed, likelyCauses, metrics }`; the metrics are the
 * deterministic third of it and are supplied by
 * {@link createAnalysisResult} rather than proposed). Nothing here is
 * identity, provenance or measurement, which is why this schema and
 * {@link analysisResultSchema} are two schemas rather than one with optional
 * fields.
 *
 * `z.strictObject`, like every schema in this package: this is a model's output,
 * so an invented key is either a misunderstanding the repair loop should report
 * (AAP §0.5.3) or an instruction the product would silently ignore. A model that
 * wants to add a field must fail, not succeed quietly.
 *
 * **Both lists may be empty.** A capture that collected nothing skips analysis
 * entirely and returns the session to `ready` (AAP §0.5.5), and the fallback
 * path assembles a panel with no model-derived facts at all, so an analysis that
 * arrives here with zero facts is a legitimate — if weak — result rather than a
 * shape error. What is *not* legitimate is an unevidenced one: the analyze
 * prompt forbids a statement without evidence in the observed list, the
 * deterministic provider never emits one, and {@link factSchema} could not parse
 * one if either did.
 */
export const analysisFindingsSchema = z.strictObject({
  /**
   * What the capture shows, each statement carrying the events that substantiate
   * it.
   *
   * Element schema imported from `@debuggen/panel-schema`, so `statement` is
   * bounded non-blank prose and `evidence` holds between one and
   * `MAX_EVIDENCE_REFS` references — the minimum of one being the mechanical
   * form of AAP §0.8.4.
   *
   * Bounded by the imported `MAX_SUMMARY_FACTS` (**20**) rather than by a local
   * number, and that choice is load-bearing rather than cosmetic:
   * `normalizePanel` copies this list **verbatim** into a panel summary whose
   * own schema enforces exactly that maximum. A more generous bound here would
   * validate an analysis that then made every panel generated from it fail
   * validation and fall back — a failure whose cause is invisible at the layer
   * that reports it. Sharing the upstream bound is the same discipline
   * `./version.js` applies by importing the telemetry package's epoch bounds.
   */
  observed: z.array(factSchema).max(MAX_SUMMARY_FACTS, {
    error: `expected at most ${String(MAX_SUMMARY_FACTS)} observed facts`,
  }),

  /**
   * What may explain the observed facts, each ranked by confidence and, where one
   * resolved, pointing at a place in the code.
   *
   * Kept in its own field and its own type for the reason this artifact exists:
   * a hypothesis renders under a separate "Likely cause" heading, and no code
   * path may move an item between the two lists without changing its type (AAP
   * §0.8.4). A `Hypothesis` is still evidence-backed — a guess may be wrong, but
   * it may not be about nothing.
   *
   * Bounded by the imported `MAX_SUMMARY_HYPOTHESES` (**10**), for the reason
   * `observed` is bounded by `MAX_SUMMARY_FACTS`. The lower ceiling is upstream's
   * product decision: a long list of competing guesses reads as certainty spread
   * thin and leaves the developer to do the ranking.
   */
  likelyCauses: z.array(hypothesisSchema).max(MAX_SUMMARY_HYPOTHESES, {
    error: `expected at most ${String(MAX_SUMMARY_HYPOTHESES)} likely causes`,
  }),
});

/**
 * The validated analyze-stage output: observed facts and likely causes, with no
 * identity of its own.
 *
 * Inferred from {@link analysisFindingsSchema}, so the validator and the type are
 * one statement. Produced by `apps/local-service/src/analysis/summarize.ts` and
 * consumed by {@link createAnalysisResult}, which is the only sanctioned way to
 * turn it into a stored, broadcastable {@link AnalysisResult}.
 */
export type AnalysisFindings = z.infer<typeof analysisFindingsSchema>;

/**
 * Validates an unknown value as {@link AnalysisFindings}.
 *
 * Applied by the analyze stage to the model's structured output, inside the
 * repair loop of AAP §0.5.3: a rejection is re-prompted with the validation
 * errors at most twice and then becomes a typed refusal, so the failure code is
 * the one a user interface and the repair loop both switch on.
 *
 * `'MODEL_OUTPUT_INVALID'` rather than this package's usual
 * `'PROTOCOL_INVALID_MESSAGE'`, and the difference matters: nothing has crossed
 * a transport when this fails. What failed is a stage's artifact, which is the
 * condition `@debuggen/shared`'s vocabulary has that code for, and mislabelling
 * it as a transport fault would send the service's error handling — and the
 * developer reading it — after the wrong thing entirely.
 *
 * @param value The model's parsed structured output.
 * @returns `ok(findings)`, or `err(error)` naming the offending field paths and
 * no rejected value.
 *
 * @example
 * ```ts
 * const parsed = parseAnalysisFindings(await provider.generateStructured(schema, request));
 * if (!parsed.ok) {
 *   return repairOrFail(parsed.error);
 * }
 * const analysis = createAnalysisResult(parsed.value, { sessionId, captureId, analysisVersion, metrics });
 * ```
 */
export function parseAnalysisFindings(value: unknown): Result<AnalysisFindings, DebuggenError> {
  return parseWith(
    value,
    analysisFindingsSchema,
    'MODEL_OUTPUT_INVALID',
    'Invalid analysis findings',
    'Analysis findings carry exactly observed and likelyCauses; every statement in either list needs at least one evidence reference.',
  );
}

// ---------------------------------------------------------------------------
// Section C — AnalysisResult: the persisted and broadcast artifact
// ---------------------------------------------------------------------------

/**
 * Whether a value looks like a `MetricValue`: a plain record whose `id` is a
 * member of the closed metric vocabulary and whose `available` is a boolean.
 *
 * Shallow on purpose, and the two keys it does check are the two that decide how
 * the value is read. `id` is validated with the **upstream** predicate
 * `isMetricId`, so the fourteen ids of AAP §0.2.3 stay defined in one place and
 * a metric this product does not compute is refused here rather than rendered as
 * an unknown card. `available` is required because it is the discriminator: a
 * metric the capture could not measure — `transferred_bytes` where no response
 * reported a transfer size (AAP §0.6.6) — is reported as `available: false` and
 * renders "n/a", which is a different statement from a measured zero.
 *
 * `value` is deliberately **not** required: it is present if and only if
 * `available` is `true`, and requiring it would refuse exactly the unavailable
 * metrics the product is designed to report honestly.
 *
 * Nothing deeper is asserted, for the reason `opaqueSchema` documents: these
 * values are computed inside this machine's own service process by the package
 * that owns the type, whose aggregate code is the validating party, while the
 * failure a transport boundary actually sees is a missing field, an `undefined`
 * or a JSON round trip that dropped the value.
 */
function isMetricValueShape(value: unknown): boolean {
  return isPlainRecord(value) && isMetricId(value['id']) && typeof value['available'] === 'boolean';
}

/**
 * The measured values behind the findings: the upstream `MetricValue` **type**
 * from `@debuggen/telemetry`, checked shallowly per element.
 *
 * `@debuggen/telemetry` publishes `MetricValue` as a TypeScript interface with no
 * Zod schema, so the type keeps coming from its owner through an `import type`
 * and {@link opaqueArraySchema} supplies the runtime check — the alternative
 * being a hand-written copy of a shape this package does not own, which is the
 * second definition AAP §0.2.3 forbids. Built per element rather than as one
 * check over the array so a rejection reads `metrics[3] (custom
 * label=MetricValue)` instead of "the metrics array is wrong".
 *
 * Bounded by the size of the closed metric vocabulary. The service computes one
 * value per id in `METRIC_IDS` order, so fourteen is not a guess about a
 * reasonable length but the exact number of distinct metrics that exist; a
 * longer array is a producer repeating itself. A **shorter** one is accepted:
 * the fallback path and a partially observed capture legitimately carry a subset.
 */
const metricsSchema = opaqueArraySchema<MetricValue>('MetricValue', isMetricValueShape).max(
  METRIC_IDS.length,
  { error: `expected at most ${String(METRIC_IDS.length)} metric values` },
);

/**
 * The stored, broadcast analysis: the model's findings plus the identity,
 * provenance, timestamp and measurements deterministic code supplies.
 *
 * Built by spreading {@link analysisFindingsSchema}'s shape rather than by
 * re-typing `observed` and `likelyCauses`, so the authored half and the stored
 * half cannot drift: a bound changed on one is changed on both, in one edit.
 *
 * `z.strictObject` and one object-level check ({@link checkSupersedesIsNotSelf}).
 * Strictness matters as much here as on the authoring schema, for a different
 * reason: this value crosses a WebSocket as the `analysis.completed` payload and
 * is read back out of the `analyses` table, so an unrecognised key is a producer
 * or a stored row that disagrees with this contract, and refusing it is how that
 * disagreement is found in development rather than inferred from a field nothing
 * rendered.
 */
export const analysisResultSchema = z
  .strictObject({
    /**
     * This analysis's own id, minted by the service (`newAnalysisId()`), never
     * proposed by a model.
     *
     * Analyses accumulate across follow-ups rather than being overwritten, so
     * this id is what a stored panel's evidence stays reachable through and what
     * the next version names in its `supersedes`.
     */
    id: idSchema,

    /** The session the analysis belongs to; what makes a frame routable. */
    sessionId: idSchema,

    /**
     * The capture whose evidence this analysis is drawn from.
     *
     * Load-bearing on the follow-up path: the existing-evidence branch (AAP
     * §0.4.2) regenerates an analysis from the **stored** capture without asking
     * the developer to reproduce anything, and this field is what ties version
     * *n + 1* to the same `captureId` as version *n*. It is also what every
     * `EventRef` in `observed` is resolvable against — an evidence id means
     * nothing without the capture it was ingested into.
     */
    captureId: idSchema,

    /**
     * Which generation of this session's analysis this is, counting from
     * {@link ANALYSIS_VERSION_START}.
     *
     * `z.int()` refuses `1.5` as a type issue and the lower bound refuses `0`
     * and `-1`, so a producer that treated the field as an index rather than as
     * a count fails here instead of storing a version the history cannot order.
     * No upper bound beyond the integer domain: a long-running session may hold
     * as many follow-ups as the developer asks questions.
     */
    analysisVersion: z.int().min(ANALYSIS_VERSION_START, {
      error: `expected an analysis version of at least ${String(ANALYSIS_VERSION_START)}`,
    }),

    /**
     * The id of the analysis this one replaces, on a follow-up.
     *
     * **Optional, not nullable.** An absent key is how a first analysis says it
     * supersedes nothing; a `null` would be a second spelling of the same fact
     * that every consumer would have to handle, and it does not survive a JSON
     * round trip as an absent key. Checked against `id` by
     * {@link checkSupersedesIsNotSelf}.
     */
    supersedes: idSchema.optional(),

    /**
     * When the analysis was produced, in Unix epoch milliseconds
     * (`./version.js`'s one timestamp primitive, over the product's single time
     * base of AAP §0.2.3).
     *
     * Supplied by the service, never by a model: it is a fact about the run, and
     * it is what orders the versions of a session's analysis history against the
     * captures and panels beside them.
     */
    createdAt: epochMsSchema,

    // `observed` and `likelyCauses`, with their element schemas and their bounds,
    // exactly as the authoring schema declares them.
    ...analysisFindingsSchema.shape,

    /**
     * The measurements the findings were drawn from: the fourteen metric values
     * of AAP §0.2.3, as `@debuggen/telemetry` computed them.
     *
     * Deterministic, which is why they are here and not in
     * {@link analysisFindingsSchema}: a metric a model proposed would be
     * indistinguishable, once stored, from one the capture measured. The panel's
     * `metricCards` node is resolved from this same set through the
     * `panel-data` route (AAP §0.4.2).
     */
    metrics: metricsSchema,
  })
  .check(checkSupersedesIsNotSelf);

/**
 * A complete analysis: findings, identity, provenance and measurements.
 *
 * Inferred from {@link analysisResultSchema}. This is the type
 * `./session-record.ts` lists as `SessionRecord.analyses[]`,
 * `./messages/session.ts` carries as the `analysis.completed` payload's
 * `analysis`, `./http.ts` returns from the session routes, and
 * `apps/local-service/src/panels/generate.ts` hands to `normalizePanel` — see
 * {@link AnalysisEdgePreserved} for the compile-time guarantee that the last of
 * those keeps working.
 */
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

/**
 * Validates an unknown value as an {@link AnalysisResult}.
 *
 * Applied at all three boundaries the artifact crosses: by a client to the
 * `analysis.completed` payload and to a session route's response body, by the
 * service to a row read back from the `analyses` table, and by the state machine
 * before a session may reach `generated` — which it may only once a validated
 * analysis *and* a validated panel specification exist (AAP §0.5.5). Returning a
 * `Result` rather than throwing is what lets that gate branch instead of unwind.
 *
 * `'PROTOCOL_INVALID_MESSAGE'` is this package's default code, and it is the
 * accurate one for a value that arrived from somewhere: unlike
 * {@link parseAnalysisFindings}, the producer here is another process or the
 * store, not a model. A caller that knows better — the store, reading its own
 * row — is free to re-code the returned error as `'STORE_ERROR'` before
 * reporting it; the `details` and message are code-independent.
 *
 * @param value The `analysis` field of a received frame, a parsed response body
 * or a deserialised store row.
 * @returns `ok(analysis)`, or `err(error)` naming the offending field paths and
 * no rejected value.
 *
 * @example
 * ```ts
 * const parsed = parseAnalysisResult(frame.payload.analysis);
 * if (parsed.ok) {
 *   view.renderFindings(parsed.value.observed, parsed.value.likelyCauses);
 * }
 * ```
 */
export function parseAnalysisResult(value: unknown): Result<AnalysisResult, DebuggenError> {
  return parseWith(
    value,
    analysisResultSchema,
    'PROTOCOL_INVALID_MESSAGE',
    'Invalid analysis result',
    'An analysis result carries id, sessionId, captureId, analysisVersion, createdAt, observed, likelyCauses, metrics and an optional supersedes naming a different analysis.',
  );
}

// ---------------------------------------------------------------------------
// Section D — assembling a result from findings
// ---------------------------------------------------------------------------

/**
 * Everything {@link createAnalysisResult} cannot derive from the findings it is
 * given.
 *
 * Every member is `readonly`, and the assembler never mutates the object it
 * receives — the caller may pass a frozen value, and the service does.
 *
 * `id` and `createdAt` are optional **and** injectable, which is the same device
 * `@debuggen/instrumentation`'s modification-record constructor uses: the
 * ordinary caller omits both and gets a fresh id and the current clock reading,
 * while a suite or a fixture supplies both and gets a value it can compare
 * exactly, with no fake timers and no module mocking.
 */
export interface CreateAnalysisResultContext {
  /**
   * This analysis's id. Defaults to a fresh `newAnalysisId()` (`ana_…`).
   *
   * Pass one to keep the result deterministic, or when the id was minted earlier
   * in a sequence that has already been journalled.
   */
  readonly id?: AnalysisId | undefined;

  /** The session the analysis belongs to. */
  readonly sessionId: SessionId;

  /** The capture whose stored evidence the findings were drawn from. */
  readonly captureId: CaptureId;

  /**
   * Which generation this is, counting from {@link ANALYSIS_VERSION_START}.
   *
   * Taken from the caller rather than computed here: only the store knows how
   * many analyses a session already holds, and a counter kept in this function
   * would be shared state in a module that has none.
   */
  readonly analysisVersion: number;

  /**
   * The previous version's id, on the follow-up path. Omit it for a first
   * analysis, and never pass this analysis's own `id` — the schema refuses a
   * record that supersedes itself.
   */
  readonly supersedes?: AnalysisId | undefined;

  /**
   * When the analysis was produced, in epoch milliseconds. Defaults to
   * `nowEpochMs()`.
   */
  readonly createdAt?: number | undefined;

  /**
   * The metric values computed for the capture, accepted as a `readonly` array so
   * a caller can hand over a `CaptureSummary.metrics` without copying first.
   */
  readonly metrics: readonly MetricValue[];
}

/**
 * Assembles an {@link AnalysisResult} from validated {@link AnalysisFindings} and
 * the deterministic context around them.
 *
 * The one constructor for this shape, so that the authoring-to-stored transition
 * — the point at which identity, provenance and measurements are attached to a
 * model's output — happens in a single place rather than being re-implemented by
 * the analyze stage, the follow-up path and every fixture. It is the analysis
 * counterpart of `normalizePanel`, and it is deterministic for the same reason
 * that function is: the follow-up flow stores a regenerated analysis as the next
 * version of the same session, and the suites compare exact objects.
 *
 * Pure and total. Nothing here reads a clock or mints an id unless the caller
 * omitted the value, nothing performs I/O, nothing is mutated — including the
 * two arrays it is given, which are copied so that a later push by the caller
 * cannot change a stored analysis — and it never throws.
 *
 * It deliberately does **not** validate. Its inputs have already been through
 * {@link parseAnalysisFindings}, and a caller that wants the assembled value
 * checked calls {@link parseAnalysisResult} on it — which the service's store
 * does on the way in, and every consumer does on the way out. Validating here as
 * well would put a second, differently coded rejection path in front of the same
 * data.
 *
 * @param findings The validated analyze-stage output.
 * @param context The identity, version, provenance, timestamp and metrics; see
 * {@link CreateAnalysisResultContext}.
 * @returns A complete analysis satisfying {@link analysisResultSchema}, provided
 * the context's own values do (a blank `sessionId` or a zero `analysisVersion`
 * is reported by that schema, at the one checkpoint, rather than by two
 * mechanisms).
 *
 * @example
 * ```ts
 * const analysis = createAnalysisResult(findings, {
 *   sessionId: session.id,
 *   captureId: capture.id,
 *   analysisVersion: previous === undefined ? ANALYSIS_VERSION_START : previous.analysisVersion + 1,
 *   ...(previous === undefined ? {} : { supersedes: previous.id }),
 *   metrics: summary.metrics,
 * });
 * ```
 */
export function createAnalysisResult(
  findings: AnalysisFindings,
  context: CreateAnalysisResultContext,
): AnalysisResult {
  const assembled = {
    id: context.id ?? newAnalysisId(),
    sessionId: context.sessionId,
    captureId: context.captureId,
    analysisVersion: context.analysisVersion,
    createdAt: context.createdAt ?? nowEpochMs(),
    // Copied rather than aliased: the caller keeps its own arrays, and a stored
    // or broadcast analysis is not a live view of somebody else's list.
    observed: [...findings.observed],
    likelyCauses: [...findings.likelyCauses],
    metrics: [...context.metrics],
  };

  // `exactOptionalPropertyTypes` is on and the field is declared
  // `supersedes?: string`, so an omitted predecessor stays an absent key rather
  // than a present `undefined` — which is also the only spelling that survives
  // a JSON round trip unchanged.
  return context.supersedes === undefined
    ? assembled
    : { ...assembled, supersedes: context.supersedes };
}

// ---------------------------------------------------------------------------
// Section E — the structural edge to panel-schema, proved at compile time
// ---------------------------------------------------------------------------

/**
 * The element type of a readonly array type.
 *
 * Written with `infer` rather than as `T[number]` so it is unaffected by
 * `noUncheckedIndexedAccess`, which widens an indexed access with `| undefined`
 * and would make the comparisons below answer about `Fact | undefined`.
 */
type ElementOf<T extends readonly unknown[]> = T extends readonly (infer E)[] ? E : never;

/**
 * `true` when `A` and `B` are mutually assignable, `false` otherwise.
 *
 * The tuple wrappers stop a naked `never` or a union from distributing, so this
 * answers about the types as written rather than about their members.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Accepts `true` and nothing else: instantiating it with `false` is a compile
 * error (TS2344), which is what turns a type comparison into an assertion.
 */
type AssertTrue<T extends true> = T;

/**
 * Whether {@link AnalysisResult} is still consumable by `normalizePanel`:
 * assignable to `NormalizeAnalysis`, and carrying the **imported** `Fact` and
 * `Hypothesis` in its two lists rather than a structural look-alike.
 */
type AnalysisEdgeHolds = [AnalysisResult] extends [NormalizeAnalysis]
  ? MutuallyAssignable<ElementOf<AnalysisResult['observed']>, Fact> extends true
    ? MutuallyAssignable<ElementOf<AnalysisResult['likelyCauses']>, Hypothesis>
    : false
  : false;

/**
 * Compile-time proof of the one invariant this module owes a package below it:
 * an {@link AnalysisResult} can be passed to
 * `normalizePanel(input, analysis, context)` as its `analysis` argument.
 *
 * `packages/panel-schema` sits **below** `packages/protocol` in the layering
 * (AAP §0.2.2), so it cannot import this package and cannot name this type. Its
 * normaliser therefore declares a structural parameter type,
 * `NormalizeAnalysis` — `{ readonly observed: readonly Fact[]; readonly
 * likelyCauses: readonly Hypothesis[] }` — and `packages/panel-schema/src/
 * summary.ts` records this file as its upward consumer. Keeping the two
 * compatible is consequently *this* module's responsibility, and there is no
 * import anywhere that would fail if the compatibility lapsed: renaming
 * `observed`, widening an element type or dropping a list would leave every file
 * compiling and break panel generation at run time, in a process that would then
 * fall back to a deterministic panel and report nothing about why.
 *
 * Hence the assertion. It resolves to `true`, and it is the assertion rather
 * than the value that matters: any edit that breaks the edge instantiates
 * {@link AssertTrue} with `false` and fails `tsc -b` here, in the module that
 * made the mistake.
 *
 * The integrity consequence is worth stating beside it (AAP §0.2.3):
 * `normalizePanel` copies `summary.observed` and `summary.likelyCauses`
 * **exclusively** from the analysis it is handed, and an authored string summary
 * can only become the non-evidentiary `summary.headline`. So every fact a panel
 * displays originates in this schema — where a `Fact` cannot exist without at
 * least one `EventRef`.
 *
 * Exported because a type alias that nothing references is a compile error under
 * this repository's `noUnusedLocals`, and because a reader of the emitted
 * declarations can then see the guarantee stated. It has no runtime
 * representation; there is nothing to consume.
 *
 * @internal
 */
export type AnalysisEdgePreserved = AssertTrue<AnalysisEdgeHolds>;
