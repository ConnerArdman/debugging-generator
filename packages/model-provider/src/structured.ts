/**
 * The validation order that makes model output safe.
 *
 * AAP §0.5.3: *"Every structured output is validated before it can affect
 * anything, in a fixed sequence."* Nothing a model produces reaches the
 * developer's project (an instrumentation plan) or the screen (a panel
 * specification) except through {@link generateStructuredWithRepair}, and the
 * order of its steps — not merely their presence — is the product's safety
 * property:
 *
 * 1. **One provider attempt.** `provider.generateStructured(schema, request)`.
 * 2. **A provider failure short-circuits.** Transport, credential, timeout,
 *    quota, cancellation: returned immediately, reason `'provider'`, and it
 *    **does not consume a repair**. A repair exists to correct the *model's*
 *    output; a call that produced no output has nothing to correct, and
 *    spending the budget on one would make the "at most two repairs" guarantee
 *    meaningless. A transport retry is the provider's own concern, bounded by
 *    `ModelProviderConfig.maxRetries`, and is counted nowhere near this budget.
 * 3. **The authoritative parse** of the attempt's raw output against the
 *    caller's authoring schema — performed **even when the provider already
 *    parsed it**. See {@link classifyAttempt} for why that re-parse is the real
 *    gate rather than a belt-and-braces duplicate.
 * 4. **A schema failure earns a bounded repair.** The validation issues — paths
 *    and the schema's own messages, never the rejected values — go back as a
 *    new turn, at most {@link DEFAULT_MAX_REPAIRS} times. That figure is a
 *    **ceiling, not a default**: AAP §0.5.3's *"at most two repairs"* bounds how
 *    much of a developer's project leaves their machine and what the stage
 *    costs, so a caller may ask for fewer repairs — `0` disables them — while a
 *    caller that asks for more is refused before the first request is sent.
 * 5. **An exhausted budget is a typed rejection**, never a fabricated
 *    substitute. This module reports; the caller decides. AAP §0.5.3 puts the
 *    fallbacks there: a rejected plan falls back to a runtime-only default plan
 *    (`apps/local-service/src/pipeline/stages/plan.ts`) and a rejected panel to
 *    a deterministic panel carrying `meta.fallback = true`
 *    (`apps/local-service/src/panels/fallback.ts`), which the renderer shows
 *    under a visible "fallback view" banner.
 * 6. **Normalisation runs once, guarded.** A normaliser throw is *"a product
 *    bug, logged with the input, never retried against the model"* (AAP
 *    §0.5.3): the normaliser received input the authoring schema had already
 *    accepted, so a second identical answer would fail identically and hide a
 *    deterministic defect.
 * 7. **Cancellation is honoured before every call**, so an abandoned session
 *    never spends a request.
 *
 * ## The boundary this module does not cross
 *
 * The caller owns the schema **and** the normaliser, and that is what keeps
 * this package ignorant of what it validates. The authoring schemas and their
 * deterministic normalisers live in the packages that own the artifacts —
 * instrumentation plans in one, panel specifications in another — and neither
 * is a dependency here (the repository's lint configuration fails the build on
 * an import of either, and `package.json` declares only `@debuggen/shared` and
 * `zod`). A new artifact type therefore needs no change in this file.
 *
 * The step *after* normalisation — validating the normalised value against the
 * artifact's **internal** schema — belongs to the caller for the same reason:
 * this module has no internal schema to validate against. AAP §0.5.3 requires
 * that failure to be treated as a rejection too, so a caller that normalises
 * through this module still validates the result and still reports a failure
 * rather than proceeding. This module's responsibility ends at reporting that
 * the normaliser threw.
 *
 * ## The repair policy lives here and only here
 *
 * `./provider.js` forbids an implementation from looping: one call in, at most
 * one model answer out. If a provider also retried a schema failure, three
 * attempts here over three there would be up to nine model calls for one stage
 * and neither layer could say how many the other had spent. One counter, in one
 * place, is what makes the bound assertable — which `./structured.test.ts` does
 * by counting the calls a scripted provider receives.
 *
 * No I/O happens in this file: no network call of its own, no filesystem, no
 * environment read, no global mutation. It orchestrates a `ModelProvider` it
 * was handed and returns a value.
 */

import type { ZodError, ZodType } from 'zod';

import { assert, DebuggenError, err, noopLogger, ok, tryCatch } from '@debuggen/shared';
import type { DebuggenErrorCode, LogFields, Logger, Result } from '@debuggen/shared';

import type { ModelProvider } from './provider.js';
import { DEFAULT_MAX_REPAIRS } from './types.js';
import type {
  ModelMessage,
  ModelRequest,
  StructuredAttempt,
  StructuredOptions,
  StructuredRejectionReason,
  TokenUsage,
} from './types.js';

/**
 * The rejection vocabulary, re-exported beside the function whose failures are
 * classified with it.
 *
 * `./types.js` holds the **one** declaration — this module adds no second
 * definition of it — because the vocabulary is shared by this loop, its test
 * and the callers that decide what to do next. The re-export exists so that a
 * consumer importing {@link generateStructuredWithRepair} can name the reason
 * its `Err` carries without a second import, and so the package barrel reaches
 * the same symbol whichever module it re-exports it through.
 */
export type { StructuredRejectionReason } from './types.js';

// ---------------------------------------------------------------------------
// Bounds and vocabulary
//
// Every string this module produces is bounded, and none of it carries a
// rejected value. Two audiences read what is below — a model, on a repair
// attempt, and a developer, through a log record or a rejection's details — and
// both are reached by text that has passed no redaction checkpoint of its own
// (AAP §0.5.2 puts the checkpoints at telemetry ingest and on the outbound
// prompt payload; an error raised here goes through neither).
// ---------------------------------------------------------------------------

/**
 * How many validation issues {@link formatZodIssues} reports in full by
 * default, before it truncates with a count.
 *
 * Ten, matching the sibling manifest validator in this package. It is enough
 * for a model to see the *shape* of what it got wrong — a missing required
 * field, a bound it exceeded, an enum member it invented — while keeping the
 * feedback a bounded addition to a prompt rather than a proportional one: a
 * badly shaped array can produce an issue per element, and a hundred of them
 * say nothing the first ten did not.
 */
export const DEFAULT_MAX_ISSUES = 10;

/**
 * How an issue on the value itself, rather than on one of its properties, is
 * addressed.
 *
 * A stable marker rather than an empty string, so a root-level failure reads as
 * a location in both the model's feedback and a log record instead of looking
 * like a formatting bug. Parenthesised, which no property path can collide
 * with.
 */
export const ISSUE_ROOT_MARKER = '(root)';

/**
 * The longest single issue line kept, in characters, before it is truncated
 * with an ellipsis.
 *
 * A Zod message names expected types, bounds and permitted options, which is
 * short by nature; the cap exists for the one message kind that quotes part of
 * the input — an unrecognised *key* — and for a custom refinement whose author
 * wrote a paragraph. Generous enough that no ordinary message is cut.
 */
export const MAX_ISSUE_LINE_LENGTH = 200;

/** How issue lines are joined into the text a repair attempt carries. */
export const ISSUE_LINE_SEPARATOR = '\n';

/**
 * What {@link formatZodIssues} reports for an output that never decoded as
 * JSON.
 *
 * An attempt whose raw output is absent while its undecoded text is present is
 * a decode failure (`./types.js` says so on `StructuredAttempt`), and there are
 * no Zod issues to render for it — the schema was never reached. This states
 * the fact instead, and deliberately **does not quote the text**: undecoded
 * model output is unbounded and has passed no redaction checkpoint, so quoting
 * it into a prompt, a log record and a persisted rejection would put three
 * copies of an unvetted string where the payload rules of AAP §0.5.2 apply.
 */
export const NON_JSON_ISSUE_MESSAGE =
  'the response was not valid JSON, so it could not be validated; reply with a single JSON value and no surrounding prose';

/**
 * What {@link formatZodIssues} reports for a rejection that carries no issues
 * at all.
 *
 * A `ZodError` with an empty issue list should not occur; producing a stable
 * line for it keeps a rejection legible rather than silently empty, which is
 * the difference between a puzzling report and an actionable one.
 */
export const EMPTY_ISSUE_MESSAGE = 'the output did not satisfy the schema';

/**
 * The assistant turn a repair attempt prepends to its correction.
 *
 * Two roles exist (`./types.js` on `ModelMessage`), and a correction has to
 * arrive as a *user* turn after an *assistant* one for a conversation to
 * alternate, so the rejected answer's position in the exchange is held by this
 * statement of fact. The rejected output itself is **not** reproduced — see
 * {@link buildRepairRequest} for why issues-only is the default — and saying so
 * here keeps the model from trying to reconcile a summary with an answer it can
 * no longer see.
 */
export const REPAIR_ASSISTANT_NOTICE =
  'My previous answer did not satisfy the required schema. Its content is omitted here; only the validation errors follow.';

/**
 * Replacement for a control character in a reported line.
 *
 * Issue text reaches a log, a rejection's details and both user interfaces. A
 * C0 or C1 character in any of those is at best unreadable and at worst a
 * terminal escape sequence, so it is replaced rather than passed through.
 */
const REPLACEMENT_CHARACTER = '\uFFFD';

/** A property name that can be written after a dot without quoting. */
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// ---------------------------------------------------------------------------
// Public result shape
// ---------------------------------------------------------------------------

/**
 * What a validated structured call produces.
 *
 * Both values are kept, and the distinction is load-bearing:
 *
 * - {@link StructuredSuccess.value} is what the product runs on — the internal
 *   shape, when the caller supplied a normaliser, and the authoring shape when
 *   it did not.
 * - {@link StructuredSuccess.parsed} is the **pre-normalisation** authoring
 *   value. The service persists it with the session as the artifact's
 *   provenance: it is the answer the model actually gave, which is what a
 *   later reader has to see to judge whether a normaliser or a prompt is at
 *   fault.
 *
 * The attempt and repair counts are part of the result rather than a log line
 * because they are the *observable* form of the bound this module guarantees.
 *
 * @typeParam TInput The caller's authoring type, inferred from its schema.
 * @typeParam TOutput The internal type its normaliser produces. Defaults to
 * `TInput` for a stage whose output needs no normalisation.
 */
export interface StructuredSuccess<TInput, TOutput = TInput> {
  /** The value the caller asked for: normalised, or the parsed input. */
  readonly value: TOutput;

  /** The authoring value exactly as it validated, before normalisation. */
  readonly parsed: TInput;

  /** How many provider attempts were made, including the successful one. */
  readonly attempts: number;

  /** How many of those attempts were repairs. `0` on a first-time success. */
  readonly repairs: number;

  /**
   * Token accounting for the **accepted** attempt, when the provider reported
   * it.
   *
   * Not a sum across attempts: `TokenUsage` is a provider's report for one
   * call, and adding several together would present a total no provider ever
   * produced. A caller that needs the whole cost of a repaired call has
   * {@link StructuredSuccess.attempts} to tell it how many calls there were.
   */
  readonly usage?: TokenUsage;

  /** The model that produced the accepted answer, as the provider reports it. */
  readonly model: string;

  /** The provider implementation that answered, by its own id. */
  readonly providerId: string;
}

/** Options for {@link formatZodIssues}. */
export interface FormatZodIssuesOptions {
  /**
   * How many issues to report in full before truncating with a count.
   * Defaults to {@link DEFAULT_MAX_ISSUES}. Must be a positive integer.
   */
  readonly maxIssues?: number;
}

// ---------------------------------------------------------------------------
// Issue formatting
// ---------------------------------------------------------------------------

/**
 * One issue list, rendered for a model and for a rejection's details.
 *
 * Both forms are kept because both are consumed: `text` is what a repair turn
 * carries, and `lines` is what a `DebuggenError`'s details carry, where an
 * array survives a JSON round-trip as a list rather than as one long string.
 */
interface IssueSummary {
  /** One `path: message` line per reported issue, already bounded. */
  readonly lines: readonly string[];

  /**
   * The reported issues' paths alone, in the same order.
   *
   * What a log record gets: AAP §0.5.3's logging rule for this loop is the
   * stage, the schema name, the attempt number and the issue **paths** — never
   * the messages, which can quote a key, and never the values.
   */
  readonly paths: readonly string[];

  /** Every line joined, with a count tail when the list was truncated. */
  readonly text: string;

  /** How many issues the error carried in total, truncation included. */
  readonly total: number;
}

/**
 * Renders a Zod path as a property path a reader can follow.
 *
 * Numeric segments become `[0]`, ordinary names become `.name`, and anything
 * else — a name with a space, a symbol key — becomes a quoted subscript, so the
 * result is unambiguous for every path Zod can produce. An empty path is the
 * value itself and renders as {@link ISSUE_ROOT_MARKER}.
 *
 * Every segment goes through `String` individually rather than through
 * `Array.prototype.join`: a Zod path segment is a `PropertyKey`, and joining
 * an array containing a symbol throws.
 */
function formatIssuePath(path: readonly PropertyKey[]): string {
  let rendered = '';

  for (const segment of path) {
    if (typeof segment === 'number') {
      rendered += `[${String(segment)}]`;
      continue;
    }

    const name = String(segment);
    if (IDENTIFIER_PATTERN.test(name)) {
      rendered += rendered.length === 0 ? name : `.${name}`;
      continue;
    }

    rendered += `[${JSON.stringify(name)}]`;
  }

  return rendered.length === 0 ? ISSUE_ROOT_MARKER : rendered;
}

/**
 * Bounds one line and strips what must not travel in it.
 *
 * Truncation first, then character replacement, so the cost is proportional to
 * the kept length rather than to whatever arrived.
 */
function reportableLine(value: string): string {
  const truncated =
    value.length > MAX_ISSUE_LINE_LENGTH ? `${value.slice(0, MAX_ISSUE_LINE_LENGTH)}\u2026` : value;

  let safe = '';
  for (let index = 0; index < truncated.length; index += 1) {
    const code = truncated.charCodeAt(index);
    // C0 (NUL through US), DELETE and C1. Surrogates are far above this range,
    // so non-ASCII text passes through untouched.
    safe +=
      code <= 0x1f || (code >= 0x7f && code <= 0x9f)
        ? REPLACEMENT_CHARACTER
        : truncated.charAt(index);
  }
  return safe;
}

/**
 * Joins reported lines and appends a count when the list was truncated.
 *
 * The tail is what keeps a truncated list from reading as a complete one, which
 * matters equally to a model deciding what to fix and to an engineer deciding
 * whether the schema or the prompt is wrong.
 */
function joinIssueLines(lines: readonly string[], total: number): string {
  const text = lines.join(ISSUE_LINE_SEPARATOR);
  const hidden = total - lines.length;
  return hidden > 0 ? `${text}${ISSUE_LINE_SEPARATOR}\u2026and ${String(hidden)} more` : text;
}

/**
 * Summarises a Zod rejection into bounded, value-free lines.
 *
 * ## What goes in, and what is deliberately left out
 *
 * Each line is `path: message` — the location of the failure and the schema's
 * own statement of the rule it broke. A Zod issue also carries the **input that
 * failed** (`issue.input`), and this function never reads it. That is the whole
 * privacy property of this module: the text produced here is appended to a
 * prompt and sent to a provider, attached to a `DebuggenError`, written to a
 * log and persisted with a session, and a rejected value can be a bounded
 * source excerpt, a redacted-but-not-quite attribute or a developer's own
 * prose. Paths and rule statements are enough to fix a shape; the value that
 * broke it is not needed anywhere along that path.
 *
 * ## Why the order is imposed rather than inherited
 *
 * Issues are sorted by path and then by message before truncation, so two
 * runs that fail the same way produce byte-identical feedback regardless of the
 * order the schema happened to report them in — and so the *same* issues
 * survive truncation both times. A repair attempt is a prompt: an input that
 * varies between identical runs makes the flow irreproducible, which is
 * precisely what the deterministic provider and the offline test suite exist to
 * avoid.
 */
function summarizeZodIssues(error: ZodError, maxIssues: number): IssueSummary {
  const total = error.issues.length;
  if (total === 0) {
    const line = reportableLine(`${ISSUE_ROOT_MARKER}: ${EMPTY_ISSUE_MESSAGE}`);
    return { lines: [line], paths: [ISSUE_ROOT_MARKER], text: line, total: 1 };
  }

  const rendered = error.issues.map((issue) => ({
    path: formatIssuePath(issue.path),
    message: issue.message,
  }));

  rendered.sort((left, right) => {
    if (left.path !== right.path) {
      return left.path < right.path ? -1 : 1;
    }
    if (left.message !== right.message) {
      return left.message < right.message ? -1 : 1;
    }
    return 0;
  });

  const reported = rendered.slice(0, maxIssues);
  const lines = reported.map((issue) => reportableLine(`${issue.path}: ${issue.message}`));
  const paths = reported.map((issue) => reportableLine(issue.path));

  return { lines, paths, text: joinIssueLines(lines, total), total };
}

/**
 * The summary a decode failure reports, in the shape a schema failure reports.
 *
 * A response that never became JSON has no issues to render, but it fails for
 * the same reason a badly shaped one does — the model did not produce what was
 * asked for — so it takes the same route: one line stating the fact, fed back
 * as a correction.
 */
function nonJsonIssueSummary(): IssueSummary {
  const line = reportableLine(`${ISSUE_ROOT_MARKER}: ${NON_JSON_ISSUE_MESSAGE}`);
  return { lines: [line], paths: [ISSUE_ROOT_MARKER], text: line, total: 1 };
}

/**
 * Formats a Zod rejection as compact, model-readable feedback.
 *
 * One `path: message` line per issue, ordered deterministically, bounded in
 * count and in line length, and **carrying none of the rejected values** — see
 * {@link summarizeZodIssues} for the reasoning behind each of those four
 * properties, all of which this function's callers depend on.
 *
 * Reads `error.issues`, which is Zod 4's issue list; the legacy `.errors`
 * accessor of Zod 3 is not used.
 *
 * @param error The rejection a `safeParse` produced.
 * @param options Optional cap on how many issues are reported in full.
 * @returns The feedback text, with an `…and N more` tail when the list was
 * truncated.
 * @throws A `DebuggenError` with code `INTERNAL` when `options.maxIssues` is
 * not a positive integer, which is a programmer error rather than a runtime
 * condition.
 *
 * @example
 * ```ts
 * const parsed = schema.safeParse(raw);
 * if (!parsed.success) {
 *   logger.debug('output rejected', { issues: formatZodIssues(parsed.error) });
 * }
 * ```
 */
export function formatZodIssues(error: ZodError, options?: FormatZodIssuesOptions): string {
  const maxIssues = options?.maxIssues ?? DEFAULT_MAX_ISSUES;
  assert(
    Number.isInteger(maxIssues) && maxIssues >= 1,
    `formatZodIssues requires a positive integer maxIssues; received ${String(maxIssues)}.`,
  );

  return summarizeZodIssues(error, maxIssues).text;
}

// ---------------------------------------------------------------------------
// Repair requests
// ---------------------------------------------------------------------------

/**
 * The correction a repair attempt carries, as a user turn.
 *
 * Generic and schema-agnostic on purpose: this module does not know what
 * artifact it is validating, so the instruction talks about *the schema* and
 * *these errors* and never about plans, panels or any other shape. It names the
 * attempt that failed, which is how the model learns it is being corrected
 * rather than asked afresh, and it says what the lines are so a path list is
 * read as locations rather than as prose.
 */
function repairInstruction(issues: string, attempt: number): string {
  return [
    `Attempt ${String(attempt)} did not satisfy the required schema.`,
    'Each line below is a field path followed by the rule that was broken:',
    issues,
    'Correct exactly those problems, keep everything else your previous answer got right, and reply with a single value that satisfies the schema and nothing else.',
  ].join(ISSUE_LINE_SEPARATOR);
}

/**
 * Builds the request for one repair attempt.
 *
 * ## A new request, never a mutated one
 *
 * The caller's request is a value it may still hold, log or reuse; every field
 * is carried across by a spread and only `messages` is replaced, so `system`,
 * `prompt`, `input`, `metadata` and `signal` arrive at the provider exactly as
 * they were. Two of those matter more than they look:
 *
 * - **`input` must survive.** It is the structured half of the payload
 *   (`./types.js` on `ModelRequest`), and the rules-based provider answers from
 *   it alone. A repair request that dropped it would hand that provider nothing
 *   to reason from, and the repair would fail for a reason that has nothing to
 *   do with the model.
 * - **`metadata` is untouched.** The prompt version is a property of the prompt
 *   file, and nothing about the text changed; the attempt count is
 *   orchestration state, and it belongs to the loop rather than to the
 *   artifact's provenance.
 *
 * ## Issues only, never the rejected output
 *
 * The turn pair states that the previous answer failed and lists the validation
 * issues. It does **not** reproduce the rejected output. The output is model
 * text assembled from a payload that was redacted upstream, but a rejected
 * answer is exactly the case where an upstream assumption did not hold, and
 * appending it here would put it into a second outbound request, a log record
 * and a persisted session. The provider with a transport re-runs the outbound
 * guard (`./redact-guard.js`) on a repair request, so the guard is still the
 * backstop — but the safer default is to send what is needed to fix the shape
 * and nothing else, and the issue list is that.
 *
 * @param original The request whose answer failed validation.
 * @param issues Formatted feedback, as {@link formatZodIssues} produces.
 * @param attempt Which attempt failed, counting the first one as `1`.
 * @returns A new request whose `messages` end with the correction turn pair.
 * @throws A `DebuggenError` with code `INTERNAL` when `attempt` is not a
 * positive integer, which is a programmer error in the caller's own counter.
 */
export function buildRepairRequest(
  original: ModelRequest,
  issues: string,
  attempt: number,
): ModelRequest {
  assert(
    Number.isInteger(attempt) && attempt >= 1,
    `buildRepairRequest requires a positive integer attempt number; received ${String(attempt)}.`,
  );

  const priorTurns: readonly ModelMessage[] = original.messages ?? [];
  const correction: readonly ModelMessage[] = [
    { role: 'assistant', content: REPAIR_ASSISTANT_NOTICE },
    { role: 'user', content: repairInstruction(issues, attempt) },
  ];

  return { ...original, messages: [...priorTurns, ...correction] };
}

// ---------------------------------------------------------------------------
// Attempt classification
// ---------------------------------------------------------------------------

/** What one attempt turned out to be, once the schema has had its say. */
type AttemptClassification<T> =
  | { readonly kind: 'valid'; readonly parsed: T }
  | { readonly kind: 'invalid'; readonly issues: IssueSummary }
  | { readonly kind: 'empty' };

/**
 * Parses one attempt against the caller's schema and says which of three
 * things it was.
 *
 * ## The raw output is parsed even when the provider already parsed it
 *
 * `StructuredAttempt.value` is present whenever the provider's own transport
 * parsed the answer with this very schema, and it is **still not used here**.
 * That is not redundancy, and it is the single most likely thing in this file
 * for a later contributor to "optimise away", so the reason is stated in full:
 * AAP §0.2.4's structured-output row records that the provider's schema helpers
 * **strip the JSON-Schema keywords the service-side format does not support**.
 * A numeric bound, a string format and a custom refinement can therefore all
 * survive the provider's parse unchecked. An artifact admitted on the strength
 * of that pre-parsed value would have skipped exactly the constraints a model
 * is most likely to get wrong — a count that must be at least one, a confidence
 * that must be between zero and one, an identifier that must match a pattern —
 * and it would have skipped them silently. Re-parsing the raw output here is
 * what makes post-parse numeric validation real rather than aspirational, and
 * `./structured.test.ts` scripts an attempt whose pre-parsed value violates a
 * numeric bound precisely to keep it that way.
 *
 * ## Absent output is not offered to the schema
 *
 * `raw` of `undefined` means the provider decoded nothing (`./types.js` says so
 * on `StructuredAttempt`): with text alongside it, the response was not JSON;
 * with nothing alongside it, the response was empty. Neither is handed to
 * `safeParse`, because a schema that happened to accept `undefined` would turn
 * "the model said nothing" into a valid artifact.
 *
 * @typeParam T The caller's authoring type.
 * @param schema The authoring schema, the only arbiter of validity here.
 * @param attempt The provider's unvalidated attempt.
 * @param maxIssues How many issues a rejection reports in full.
 * @returns The classification, carrying the parsed value or the feedback.
 */
function classifyAttempt<T>(
  schema: ZodType<T>,
  attempt: StructuredAttempt<T>,
  maxIssues: number,
): AttemptClassification<T> {
  if (attempt.raw === undefined) {
    if (attempt.text === undefined) {
      return { kind: 'empty' };
    }
    return { kind: 'invalid', issues: nonJsonIssueSummary() };
  }

  const parsed = schema.safeParse(attempt.raw);
  if (parsed.success) {
    return { kind: 'valid', parsed: parsed.data };
  }

  return { kind: 'invalid', issues: summarizeZodIssues(parsed.error, maxIssues) };
}

// ---------------------------------------------------------------------------
// Typed rejections
//
// Every error below takes its `code` from the CLOSED vocabulary in
// `@debuggen/shared`; none is invented, and none is added for a reason. The
// reason travels in `details.reason` instead, which is what lets a caller
// branch on the classification while a user interface still branches on the
// code (AAP §0.5.5 renders the code and the hint).
// ---------------------------------------------------------------------------

/**
 * How an artifact is named in a rejection message when the caller did not name
 * it.
 *
 * `StructuredOptions.schemaName` is how a rejection says *which* artifact
 * failed without this package knowing what that artifact is. Absent, the
 * message describes the failure without naming a shape — which is honest, and
 * better than a guess.
 */
export const DEFAULT_ARTIFACT_LABEL = 'structured';

/** The two counters a rejection and a success both report. */
interface AttemptCounts {
  /** Provider attempts made, including the one that failed or succeeded. */
  readonly attempts: number;

  /** How many of those attempts were repairs. */
  readonly repairs: number;
}

/**
 * Builds the diagnostic details every rejection from this module carries.
 *
 * ## What is in here, and why each field is safe
 *
 * The classification, the two counters, the stage and prompt version the call
 * belonged to, the session it belonged to when there was one, the caller's name
 * for the artifact, and — for an output-level failure — the issue paths, lines
 * and total. `DebuggenErrorOptions.details` is logged, persisted with a session
 * and rendered in two user interfaces, and it passes through neither redaction
 * checkpoint (AAP §0.5.2), so nothing that could carry payload content goes in:
 * no rejected value, no undecoded response text, no prompt and no `input`.
 *
 * The issue list appears in **both** an array (`issues`) and a joined string
 * (`issueSummary`) form. That is deliberate rather than redundant: a JSON
 * round-trip through the protocol and the store keeps an array a list, which is
 * what a user interface iterates, while a single string is what a log line and
 * a message quote.
 */
function rejectionDetails(
  reason: StructuredRejectionReason,
  counts: AttemptCounts,
  request: ModelRequest,
  schemaName: string | undefined,
  issues: IssueSummary | undefined,
): Readonly<Record<string, unknown>> {
  const details: Record<string, unknown> = {
    reason,
    attempts: counts.attempts,
    repairs: counts.repairs,
    stage: request.metadata.stage,
    promptVersion: request.metadata.promptVersion,
  };

  if (request.metadata.sessionId !== undefined) {
    details.sessionId = request.metadata.sessionId;
  }
  if (schemaName !== undefined) {
    details.schemaName = schemaName;
  }
  if (issues !== undefined) {
    details.issues = issues.lines;
    details.issueCount = issues.total;
    details.issueSummary = issues.text;
  }

  return details;
}

/**
 * The fields a log record from this loop carries: identifiers and counts, never
 * content.
 *
 * Built from the same inputs as {@link rejectionDetails} and subject to the
 * same rule — a logger redacts nothing, so what is safe to persist is the
 * measure of what is safe to log. The one record that deliberately carries a
 * value is the normaliser failure, which attaches the parsed input because
 * whoever has to fix that defect needs the input that provoked it; that field
 * is added at the call site rather than here, so it cannot arrive by accident.
 */
function logFields(
  reason: StructuredRejectionReason,
  counts: AttemptCounts,
  request: ModelRequest,
  schemaName: string | undefined,
  issues: IssueSummary | undefined,
): LogFields {
  const fields: LogFields = {
    reason,
    attempts: counts.attempts,
    repairs: counts.repairs,
    stage: request.metadata.stage,
    promptVersion: request.metadata.promptVersion,
  };

  if (request.metadata.sessionId !== undefined) {
    fields.sessionId = request.metadata.sessionId;
  }
  if (schemaName !== undefined) {
    fields.schemaName = schemaName;
  }
  if (issues !== undefined) {
    // Paths only. A Zod message can quote an unrecognised key, and AAP §0.5.3's
    // logging rule for this loop names the paths and nothing else.
    fields.issuePaths = issues.paths;
    fields.issueCount = issues.total;
  }

  return fields;
}

/**
 * Re-reports a provider's own failure as this module's rejection.
 *
 * The provider's `code`, `message` and `hint` are preserved **verbatim** and
 * the original error becomes the `cause`. That is what keeps AAP §0.5.5's
 * developer-facing message intact — "Model provider unavailable (‹code›). Check
 * ANTHROPIC_API_KEY or switch DEBUGGEN_PROVIDER." is rendered from the code and
 * the hint, and re-coding a transport failure as an output failure would send a
 * caller down the wrong recovery path. Only the classification details are
 * added, with this module's fields winning a key collision because they
 * describe this call rather than the transport's view of it.
 */
function providerRejection(
  error: DebuggenError,
  counts: AttemptCounts,
  request: ModelRequest,
  schemaName: string | undefined,
): DebuggenError {
  const details: Readonly<Record<string, unknown>> = {
    ...(error.details ?? {}),
    ...rejectionDetails('provider', counts, request, schemaName, undefined),
  };

  return new DebuggenError(error.code, error.message, {
    details,
    cause: error,
    ...(error.hint !== undefined ? { hint: error.hint } : {}),
  });
}

/**
 * Builds one of this module's own rejections, with its code and hint.
 *
 * ## Which codes this module uses, and why those
 *
 * The vocabulary in `@debuggen/shared` is closed, so the code is chosen from it
 * rather than extended:
 *
 * - `MODEL_OUTPUT_INVALID` for an output-level failure — a shape that never
 *   satisfied the authoring schema, or an answer that was empty. That is what
 *   the code is defined for: *"output failed its authoring schema after the
 *   permitted repair attempts"*, and `./provider.js` reserves it for this
 *   module precisely so a provider cannot claim it.
 * - `MODEL_UNAVAILABLE` for a call that never happened because the caller had
 *   already abandoned it. A cancelled call belongs to that code's family.
 * - `INTERNAL` for a normaliser throw. `PLAN_INVALID` and `PANEL_INVALID` are
 *   the codes for a *normalised artifact* failing its internal schema, and they
 *   are deliberately not used here: this module does not know whether it is
 *   holding a plan, a panel or a stage's own shape, and guessing would put a
 *   plan's code on a panel's defect. The caller, which does know, re-codes with
 *   `mapErr` when it wants the specific code; `details.reason` is `'normalize'`
 *   either way, which is the field a caller branches on.
 */
function rejection(
  code: DebuggenErrorCode,
  message: string,
  hint: string,
  reason: StructuredRejectionReason,
  counts: AttemptCounts,
  request: ModelRequest,
  schemaName: string | undefined,
  issues: IssueSummary | undefined,
  cause?: unknown,
): DebuggenError {
  return new DebuggenError(code, message, {
    hint,
    details: rejectionDetails(reason, counts, request, schemaName, issues),
    ...(cause !== undefined ? { cause } : {}),
  });
}

/**
 * Assembles the success value from the accepted attempt.
 *
 * `usage` is copied only when the provider reported it: under
 * `exactOptionalPropertyTypes` an explicit `undefined` is not the same as an
 * absent property, and a consumer must be able to tell "the provider reported
 * nothing" from "the provider reported zero" (`./types.js` on `TokenUsage`).
 */
function successFrom<TInput, TOutput>(
  attempt: StructuredAttempt<TInput>,
  value: TOutput,
  parsed: TInput,
  counts: AttemptCounts,
): StructuredSuccess<TInput, TOutput> {
  return {
    value,
    parsed,
    attempts: counts.attempts,
    repairs: counts.repairs,
    model: attempt.model,
    providerId: attempt.providerId,
    ...(attempt.usage !== undefined ? { usage: attempt.usage } : {}),
  };
}

/**
 * Renders a count with its noun, so a message reads correctly at one.
 *
 * Local rather than borrowed: this package depends on `@debuggen/shared` and on
 * nothing else in the repository, and one helper is a smaller price than a
 * dependency edge the layering rules forbid.
 */
function countOf(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** The next step for a call abandoned before it was sent. */
const ABORT_HINT =
  'The work that asked for this answer was abandoned. Start the stage again if the answer is still wanted.';

/** The next step for a provider that answered with nothing. */
const EMPTY_OUTPUT_HINT =
  'The model produced nothing to validate. Retry the stage; if it repeats, check the configured model and the stage prompt.';

/** The next step for output that never satisfied its authoring schema. */
const SCHEMA_REJECTION_HINT =
  "Retry the stage, or continue with the deterministic artifact assembled from the captured evidence. The validation issues are in this error's details.";

/** The next step for a normaliser that threw on valid input. */
const NORMALIZE_REJECTION_HINT =
  'This is a product defect rather than a model failure: fix the normaliser, or the authoring schema that accepted its input. Re-prompting cannot help.';

// ---------------------------------------------------------------------------
// The validation sequence
// ---------------------------------------------------------------------------

/**
 * Asks a provider for a schema-shaped answer, validates it, repairs it within a
 * bounded budget, and normalises it once — in that order.
 *
 * This is the only path by which a model's answer becomes product data. The
 * order of the steps is the specification (see this module's own
 * documentation), and the branch semantics are the part that cannot be relaxed
 * without changing what the product guarantees:
 *
 * | Outcome | `details.reason` | Provider calls spent | Repair consumed |
 * | --- | --- | --- | --- |
 * | Answer validated | — | 1 + repairs used | — |
 * | Already-aborted signal | `'provider'` | 0 | no |
 * | Provider returned `Err` | `'provider'` | the one that failed | **no** |
 * | Answer empty | `'empty'` | 1 | no |
 * | Answer failed the schema | `'schema'` | 1 + `maxRepairs`, never past the ceiling below | yes, each time |
 * | Normaliser threw | `'normalize'` | 1 | **no** |
 *
 * Total provider calls never exceed `1 + maxRepairs`, and `maxRepairs` itself
 * never exceeds {@link DEFAULT_MAX_REPAIRS} — so `1 + DEFAULT_MAX_REPAIRS` is
 * the ceiling on *every* call this function serves, not merely the figure a
 * caller happens to get by leaving the budget unset. AAP §0.5.3 states the
 * bound as *"at most two repairs"*: it limits how much of a developer's project
 * leaves their machine and what a stage costs, so it is not a tunable, and a
 * larger budget is rejected outright rather than honoured (see `@throws`) while
 * a smaller one, `0` included, is always allowed. The bound holds because this
 * is the only counter: `./provider.js` forbids an implementation from looping,
 * so nothing multiplies it.
 *
 * ## What this function will not do
 *
 * It never fabricates a substitute for a rejected answer, never re-prompts a
 * product bug, and never reports a failure as a success. AAP §0.5.3 places the
 * fallbacks in the caller — a runtime-only default plan, or a deterministic
 * panel flagged `meta.fallback` and rendered under a visible banner — so that a
 * developer is never shown a model's conclusion that no model reached.
 *
 * It also does not validate the **normalised** value against the artifact's
 * internal schema: this module has no internal schema, only the caller does.
 * AAP §0.5.3 requires that failure to be treated as a rejection too, so a
 * caller that passes a normaliser validates its output and reports a failure of
 * its own; this function's responsibility ends at reporting that the normaliser
 * threw.
 *
 * @typeParam TInput The authoring type, inferred from `schema`.
 * @typeParam TOutput The internal type, inferred from `options.normalize`.
 * Defaults to `TInput` when no normaliser is supplied.
 * @param provider The provider to ask. Handed in rather than constructed, which
 * is what lets the offline rules-based implementation and the network-backed one
 * travel the identical path — and what lets a test count the calls.
 * @param schema The caller's authoring schema: the only arbiter of validity.
 * @param request The prompt, its structured context and its provenance, already
 * redacted by the caller.
 * @param options Repair budget, normaliser, artifact name and logger.
 * @returns `Ok` with the validated — and, where a normaliser was given,
 * normalised — value, or `Err` with a coded rejection whose `details.reason` is
 * one of {@link StructuredRejectionReason}.
 * @throws A `DebuggenError` with code `INTERNAL` when `options.maxRepairs` is
 * not an integer from `0` to {@link DEFAULT_MAX_REPAIRS} inclusive. A negative,
 * fractional or over-ceiling budget is a programmer error, not a runtime
 * condition: it cannot be recovered from and must not be silently rounded or
 * clamped into a different guarantee, because a caller that asked for four
 * repairs and quietly received two would go on believing a bound the product
 * does not enforce. The ceiling is AAP §0.5.3's *"at most two repairs"* — a
 * privacy and cost bound on what leaves the developer's machine rather than a
 * tunable — and it is checked ahead of the first provider call, so an
 * over-budget request sends nothing at all.
 *
 * @example Validating and normalising in one call
 * ```ts
 * const result = await generateStructuredWithRepair(provider, planInputSchema, request, {
 *   normalize: (input) => normalizePlan(input, context),
 *   schemaName: 'instrumentation plan',
 *   logger,
 * });
 * if (!result.ok) {
 *   // `result.error.details.reason` says whether the model, the transport or
 *   // the product is at fault; the caller falls back deterministically.
 *   return fallbackPlan(context);
 * }
 * ```
 */
export async function generateStructuredWithRepair<TInput, TOutput = TInput>(
  provider: ModelProvider,
  schema: ZodType<TInput>,
  request: ModelRequest,
  options?: StructuredOptions<TInput, TOutput>,
): Promise<Result<StructuredSuccess<TInput, TOutput>, DebuggenError>> {
  // --- Step 0: the budget, fixed before anything is asked of the provider. ---
  // One guard, covering shape and magnitude, and it sits above the loop so an
  // unusable budget cannot cost a single request. `DEFAULT_MAX_REPAIRS` is the
  // inclusive ceiling as well as the default: AAP §0.5.3 allows "at most two
  // repairs", which bounds what leaves the developer's machine, so a caller
  // asking for more is a programmer error to report — not a number to clamp,
  // since a call silently granted fewer repairs than it requested would behave
  // differently from what its author wrote. The cap is read from the constant
  // rather than restated, so the message and the check cannot drift from it.
  const maxRepairs = options?.maxRepairs ?? DEFAULT_MAX_REPAIRS;
  assert(
    Number.isInteger(maxRepairs) && maxRepairs >= 0 && maxRepairs <= DEFAULT_MAX_REPAIRS,
    `generateStructuredWithRepair requires an integer maxRepairs from 0 to ${String(DEFAULT_MAX_REPAIRS)} inclusive; received ${String(maxRepairs)}.`,
  );

  const logger: Logger = options?.logger ?? noopLogger;
  const schemaName = options?.schemaName;
  const label = schemaName ?? DEFAULT_ARTIFACT_LABEL;
  const normalize = options?.normalize;

  let attempts = 0;
  let repairs = 0;
  // Every repair is derived from the CALLER'S request rather than from the
  // previous repair. Two consequences, both wanted: the payload cannot grow
  // with each attempt, and the model is never shown a stale issue list that a
  // later attempt already addressed. The attempt number in the correction turn
  // is what carries the history instead.
  let currentRequest = request;

  for (;;) {
    // --- Step 7: cancellation, checked before every call. ---------------------
    // Ahead of the call rather than after it: a session that has ended, a
    // capture that was discarded or a follow-up that superseded this stage has
    // no use for the answer, and a request spent on abandoned work is a request
    // a developer waits for.
    if (currentRequest.signal?.aborted === true) {
      const counts: AttemptCounts = { attempts, repairs };
      logger.debug(
        'Structured call abandoned before its request was sent',
        logFields('provider', counts, request, schemaName, undefined),
      );
      return err(
        rejection(
          'MODEL_UNAVAILABLE',
          `The ${label} request was cancelled before it was sent.`,
          ABORT_HINT,
          'provider',
          counts,
          request,
          schemaName,
          undefined,
        ),
      );
    }

    // --- Step 1: exactly one provider attempt. -------------------------------
    attempts += 1;
    const attempt = await provider.generateStructured(schema, currentRequest);

    // --- Step 2: a provider failure short-circuits, spending no repair. ------
    // Transport, credential, timeout, quota, cancellation: no output was
    // produced, so there is nothing for a repair to correct. Spending the budget
    // here would mean a stage that hit two rate limits had already lost the
    // repairs it needed for the one badly shaped answer that followed — which is
    // how an "at most two repairs" guarantee stops meaning anything. Retrying
    // the transport is the provider's own concern (`ModelProviderConfig
    // .maxRetries`) and is counted nowhere near this budget.
    if (!attempt.ok) {
      const counts: AttemptCounts = { attempts, repairs };
      logger.debug(
        'Structured call failed at the provider',
        logFields('provider', counts, request, schemaName, undefined),
      );
      return err(providerRejection(attempt.error, counts, request, schemaName));
    }

    // --- Step 3: the authoritative parse of the raw output. ------------------
    const classification = classifyAttempt(schema, attempt.value, DEFAULT_MAX_ISSUES);

    if (classification.kind === 'empty') {
      // No decoded output and no text to quote back. The call succeeded and the
      // model said nothing, which `./types.js` classifies as its own reason
      // rather than as a schema failure: there is no output to correct, and it
      // is not the shape that was wrong. Reported at once, budget untouched.
      const counts: AttemptCounts = { attempts, repairs };
      logger.warn(
        'Structured call produced no output',
        logFields('empty', counts, request, schemaName, undefined),
      );
      return err(
        rejection(
          'MODEL_OUTPUT_INVALID',
          `The provider returned no ${label} output to validate.`,
          EMPTY_OUTPUT_HINT,
          'empty',
          counts,
          request,
          schemaName,
          undefined,
        ),
      );
    }

    if (classification.kind === 'invalid') {
      const issues = classification.issues;
      const counts: AttemptCounts = { attempts, repairs };

      // --- Step 4: a schema failure earns a repair, while the budget lasts. --
      if (repairs < maxRepairs) {
        logger.debug(
          'Structured output failed validation; repairing',
          logFields('schema', counts, request, schemaName, issues),
        );
        currentRequest = buildRepairRequest(request, issues.text, attempts);
        repairs += 1;
        continue;
      }

      // --- Step 5: the budget is spent, so this is a typed rejection. -------
      logger.warn(
        'Structured output failed validation and the repair budget is spent',
        logFields('schema', counts, request, schemaName, issues),
      );
      return err(
        rejection(
          'MODEL_OUTPUT_INVALID',
          `The model's ${label} output failed validation after ${countOf(attempts, 'attempt')} including ${countOf(repairs, 'repair')}; unresolved at ${reportableLine(issues.paths.join(', '))}.`,
          SCHEMA_REJECTION_HINT,
          'schema',
          counts,
          request,
          schemaName,
          issues,
        ),
      );
    }

    // --- Step 6: normalise once, guarded. -----------------------------------
    const parsed = classification.parsed;
    const counts: AttemptCounts = { attempts, repairs };

    if (normalize === undefined) {
      // No normaliser means the authoring shape *is* the internal shape:
      // `StructuredOptions` defaults `TOutput` to `TInput`, and `normalize` is
      // the only place a caller can introduce a different `TOutput`. The
      // compiler cannot see that identity from inside the generic body, so the
      // conversion is stated here, once, instead of being pushed on to every
      // caller as an explicit type argument.
      return ok(successFrom(attempt.value, parsed as unknown as TOutput, parsed, counts));
    }

    const normalized = tryCatch(() => normalize(parsed));
    if (!normalized.ok) {
      // A normaliser throw is "a product bug, logged with the input, never
      // retried against the model" (AAP §0.5.3). Its input had already been
      // accepted by the authoring schema, so the defect is in the normaliser or
      // in that schema, and an identical second answer would fail identically —
      // re-prompting would spend a developer's time to hide a deterministic
      // defect. Hence: logged at error level with the offending input, rejected
      // immediately, and no further call.
      logger.error('The structured output normaliser threw; rejecting without a repair', {
        ...logFields('normalize', counts, request, schemaName, undefined),
        // The one value this loop ever logs. Whoever fixes the normaliser needs
        // the input that provoked it, and that input is an artifact the caller
        // assembled from an already-redacted payload.
        input: parsed,
        error: normalized.error.message,
      });
      return err(
        rejection(
          'INTERNAL',
          `The ${label} output satisfied its authoring schema, but the caller's normaliser threw.`,
          NORMALIZE_REJECTION_HINT,
          'normalize',
          counts,
          request,
          schemaName,
          undefined,
          normalized.error,
        ),
      );
    }

    return ok(successFrom(attempt.value, normalized.value, parsed, counts));
  }
}
