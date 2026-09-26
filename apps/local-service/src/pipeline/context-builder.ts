/**
 * The context builder of the local service's six-stage reasoning pipeline: the
 * one place a {@link ModelRequest} is assembled.
 *
 * Every stage that talks to a model — understand, investigate, plan, analyze
 * and followup (AAP §0.4.2, "AI stage boundaries") — builds its request here,
 * and nowhere else in the pipeline is a prompt template rendered, a payload
 * size cap applied or the outbound privacy guard run. The sixth prompt stage,
 * `generate-panel`, is owned end to end by `../panels/generate.ts`; this module
 * records its placeholder contract and its output-schema source for the drift
 * tests and builds nothing for it. `capture` is not a prompt stage at all:
 * `stages/capture.ts` makes no model call.
 *
 * ## What happens to every request, in this order
 *
 * 1. **Redact and cap.** The structured context is built first, from typed
 *    upstream artifacts. The sections taken from the inspected page — the
 *    selected element's tag, selector, visible text and component names, and
 *    the bound tab's current URL — are redacted here with the telemetry layer's
 *    own rules *before* anything is cut ({@link redactAndCapText} runs `scrub`
 *    and then `redactTextUrls`, so every URL embedded in an element string —
 *    a link's own address, an `href` in a selector, a path quoted in a label —
 *    has its query values and fragment masked to `?`; {@link redactAndCapUrl}
 *    runs `redactUrl`: query values and a fragment become `?`, userinfo becomes
 *    `[redacted]`), because they come from the browser rather than from the
 *    ingest checkpoint, and a cut made first could split a credential or a
 *    query value out of reach of the rule that identifies it (AAP §0.5.2, "the
 *    current URL (redacted)"). Neither cap leaves a split query pair the guard
 *    would read as an unmasked value. Everything is then bounded by
 *    {@link CONTEXT_LIMITS}: text is cut with {@link capText}, lists with
 *    {@link capList}, source excerpts with {@link capExcerpt}, arbitrary
 *    artifacts with {@link toBoundedJson}, and the whole object by
 *    {@link applyPayloadBudget} (AAP §0.7.1, "context builder caps excerpt size
 *    and applies redaction"). Sections an upstream module has already bounded —
 *    the analysis stage input (`ANALYSIS_INPUT_LIMITS`), the project summary
 *    (`PROJECT_SUMMARY_LIMITS`), code excerpts (`CODE_QUERY_LIMITS`) — are
 *    serialised as they arrive, never re-truncated.
 * 2. **Derive.** Every prompt placeholder is derived from that same capped
 *    object with {@link toPromptJson}, so the rendered `prompt` and the
 *    structured `input` of the request can never disagree — the dual payload
 *    AAP §0.5.3 requires, which is what the rules-based deterministic provider
 *    reads and what the outbound guard inspects field by field.
 * 3. **Render.** The prompt text comes from a versioned repository file,
 *    `apps/local-service/prompts/<stage>/vNNN.md`, loaded through the injected
 *    {@link PromptLoader} and filled by `renderPrompt`. This module holds no
 *    instruction prose: the only text it contributes is data — serialised
 *    artifacts and the injected `{{outputSchema}}` JSON Schema documents.
 * 4. **Guard.** `assertOutboundSafe` is the second privacy checkpoint of AAP
 *    §0.5.2. A denied pattern that survived ingest-time redaction, or this
 *    builder's redaction of the page-derived sections, aborts the call here,
 *    before a stage spends a provider call on it; the provider runs the same
 *    guard again before transport, deliberately (defence in depth). Redacting
 *    in step 1 is what lets an ordinary page (`/products?sort=price`), or a
 *    selected link whose text is its own address, reach the model at all; the
 *    guard stays the backstop, never the redactor.
 *
 * ## The developer's question travels in the prompt only
 *
 * AAP §0.5.4 requires two questions that differ only in wording to produce the
 * same structured input. So the raw question — and a follow-up question — is
 * rendered into the prompt text (capped) and **never** placed in
 * {@link ModelRequest.input}. What the structured input may carry instead is a
 * wording-invariant projection: the sorted, de-duplicated lexical hints the
 * generic tokenizer of `stages/understand.ts` produces. This module never
 * compares, searches or switches on question text; it only measures and cuts
 * it.
 *
 * ## Import direction
 *
 * This module owns the shared stage contract ({@link PipelineStageContext},
 * {@link PipelineCodeHandles}, {@link ContextBuilder}); `stages/*.ts`,
 * `tools/code-tools.ts` and `orchestrator.ts` import from it, and it imports
 * none of them. No `zod` import, no `@debuggen/panel-renderer`, no filesystem
 * access other than through the injected prompt loader, no environment read.
 *
 * @module
 */

import { CODE_QUERY_LIMITS } from '@debuggen/code-analysis';
import type {
  CodeExcerpt,
  CodeGraph,
  CodeQueries,
  LoadedProject,
  ProjectSummary,
  RouteMap,
} from '@debuggen/code-analysis';
import {
  instrumentationPlanInputSchema,
  problemUnderstandingSchema,
} from '@debuggen/instrumentation';
import type {
  InstrumentationContext,
  InstrumentationPlan,
  ProblemUnderstanding,
  SelectedTarget,
} from '@debuggen/instrumentation';
import { assertOutboundSafe, renderPrompt } from '@debuggen/model-provider';
import type {
  JsonObject,
  JsonValue,
  ModelRequest,
  PromptFile,
  PromptLoader,
  PromptStage,
  RedactGuardOptions,
} from '@debuggen/model-provider';
import { panelSpecInputJsonSchemaText } from '@debuggen/panel-schema';
import type { PanelSpec } from '@debuggen/panel-schema';
import { analysisFindingsSchema, sessionRecordSchema } from '@debuggen/protocol';
import type {
  AnalysisResult,
  PromptStageKey,
  RelevantFile,
  SessionRecord,
} from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  isAbsolutePosix,
  isSafeRelativePath,
  noopLogger,
  normalizePosix,
  ok,
  tryCatch,
} from '@debuggen/shared';
import type { Logger, Result } from '@debuggen/shared';
import {
  formatUrlParts,
  parseUrlParts,
  redactQueryString,
  redactTextUrls,
  redactUrl,
  scrub,
} from '@debuggen/telemetry';
import type { CaptureSummary } from '@debuggen/telemetry';

import { ANALYSIS_INPUT_LIMITS, estimatePayloadBytes } from '../analysis/summarize.js';
import type { AnalysisStageInput } from '../analysis/summarize.js';
import type { ServiceConfig } from '../config.js';
import { sessionLogger, subsystemLogger } from '../logging.js';

/**
 * Re-exported from `../analysis/summarize.js` so the pipeline measures payloads
 * with the same rule the analysis input budget was fitted with: the UTF-8 byte
 * length of the compact `JSON.stringify` form, `0` for `undefined` and
 * `+Infinity` for a value that cannot be serialised. One measure, one
 * definition — a second implementation here could drift from the budget it is
 * checked against.
 */
export { estimatePayloadBytes };

/* -------------------------------------------------------------------------------------------------
 * Compile-time checks
 * ---------------------------------------------------------------------------------------------- */

/** Compiles only when `T` is exactly `true`; the repository's type-assertion idiom. */
type AssertTrue<T extends true> = T;

/**
 * `true` when each of `A` and `B` is assignable to the other. The tuple wrap
 * keeps a union from distributing, so the check is about the whole type.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/* -------------------------------------------------------------------------------------------------
 * Shared stage contract
 * ---------------------------------------------------------------------------------------------- */

/**
 * The code-analysis bundle a stage may use: the graph, its query engine, the
 * route map and the Stage 1 project summary, plus the loaded ts-morph project
 * when source excerpts are available for this session.
 *
 * Loaded **once per pipeline run** by the orchestrator's `CodeIndexPort` and
 * shared by every stage and by the install request, so no stage indexes a
 * project itself (AAP §0.4.2, "no repository dump"; `tools/code-tools.ts`
 * receives exactly this bundle).
 */
export interface PipelineCodeHandles {
  /** The code graph of the target project. */
  readonly graph: CodeGraph;
  /** The bounded, read-only query engine over {@link PipelineCodeHandles.graph}. */
  readonly queries: CodeQueries;
  /** The API route map of the target project. */
  readonly routeMap: RouteMap;
  /** The bounded project summary Stage 1 renders into `{{projectSummary}}`. */
  readonly projectSummary: ProjectSummary;
  /** The loaded ts-morph project, when excerpts and deep references are available. */
  readonly loaded?: LoadedProject | undefined;
}

/**
 * The same five handles as the instrumentation layer's own context declares
 * them. `packages/instrumentation/src/adapter.ts` is the canonical consumer of
 * this bundle — the install request populates an `InstrumentationContext`
 * from it — so that declaration is the one the pipeline's must never drift
 * from.
 */
type InstrumentationCodeHandles = Pick<
  InstrumentationContext,
  'graph' | 'queries' | 'routeMap' | 'projectSummary' | 'loaded'
>;

/**
 * Compile-time proof that {@link PipelineCodeHandles} and the code handles of
 * `InstrumentationContext` are the same shape, field for field, in both
 * directions. Renaming, retyping, adding or removing a handle on either side
 * fails `tsc -b` here rather than at the install boundary. Exported so
 * `noUnusedLocals` treats the assertion as used; it has no runtime existence.
 */
export type PipelineCodeHandlesMatchInstrumentationContext = AssertTrue<
  MutuallyAssignable<PipelineCodeHandles, InstrumentationCodeHandles>
>;

/**
 * Compile-time proof that the model boundary's prompt-stage vocabulary and the
 * session record's `promptVersions` keys are the same six names, so a version
 * recorded on a session always names a stage the prompt loader can load.
 */
export type PromptStageVocabulariesAgree = AssertTrue<
  MutuallyAssignable<PromptStage, PromptStageKey>
>;

/**
 * Everything a stage needs and nothing it does not. Built once per pipeline
 * run by {@link createPipelineStageContext} and threaded through every stage.
 *
 * The stored {@link SessionRecord} is the single source of truth: the
 * question, the selected target, the project root and the recorded prompt
 * versions are copied from it rather than passed in separately, so no stage
 * can act on a question the session does not hold.
 */
export interface PipelineStageContext {
  /** The session's id. */
  readonly sessionId: string;
  /** The stored session record the run was started from. */
  readonly session: SessionRecord;
  /** The project root: absolute, POSIX separators, normalised. */
  readonly projectRoot: string;
  /** The developer's question, verbatim. Rendered into prompts only, never into structured input. */
  readonly question: string;
  /** The follow-up question being answered, on the follow-up path. Prompt-only, like the question. */
  readonly followUpQuestion?: string | undefined;
  /** The element the developer selected, when there is one. */
  readonly target?: SelectedTarget | undefined;
  /**
   * The bound tab's current URL, as recorded. Page-derived, so never trusted
   * to be redacted: every builder that places it in a request passes it
   * through `redactUrl` first ({@link redactAndCapUrl}), which is idempotent on
   * an address that was already masked upstream.
   */
  readonly currentUrl?: string | undefined;
  /** The code-analysis handles, loaded once per run. */
  readonly code: PipelineCodeHandles;
  /**
   * The prompt versions recorded on the session. A builder with no explicit
   * version reuses the recorded one through `PromptLoader.loadVersion`, which
   * keeps a reopened session or a follow-up on the prompt it started with even
   * after that version has been superseded.
   */
  readonly promptVersions: Readonly<Partial<Record<PromptStage, string>>>;
  /** The capture being analysed, on the capture and analysis path. */
  readonly captureId?: string | undefined;
  /** The session-bound logger (session and capture ids already bound). */
  readonly logger: Logger;
  /** The clock. Stages use it for timings; no builder puts its value in a payload. */
  readonly now: () => number;
  /** Cancels the run. Threaded into every request built from this context. */
  readonly signal?: AbortSignal | undefined;
}

/** What {@link createPipelineStageContext} needs beyond the stored session record. */
export interface PipelineStageContextInit {
  /** The stored session record. */
  readonly session: SessionRecord;
  /** The code-analysis handles loaded for this run. */
  readonly code: PipelineCodeHandles;
  /** The parent logger; the context's logger is a session-bound child of it. */
  readonly logger: Logger;
  /** The follow-up question, on the follow-up path. */
  readonly followUpQuestion?: string | undefined;
  /**
   * The page address to use instead of the session's bound tab URL — for
   * instance the URL a `session.bind` just reported. Stored as given; the
   * context builder redacts it before it enters any request.
   */
  readonly currentUrl?: string | undefined;
  /** The capture being analysed, when there is one. */
  readonly captureId?: string | undefined;
  /** The clock; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** Cancels the run. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Builds the {@link PipelineStageContext} of one pipeline run from the stored
 * session record.
 *
 * The project root is normalised to POSIX form and must be absolute: every
 * containment check downstream (feasibility, source-open, excerpt privacy)
 * measures project-relative paths against it, so a relative root is refused
 * here rather than trusted there. The current URL defaults to the session's
 * bound tab. The logger is bound to the session (and capture) id with the
 * service's standard binding keys.
 *
 * @param init The session record, code handles and run-scoped collaborators.
 * @returns The context, or `PROJECT_NOT_FOUND` when the recorded project root
 * is not an absolute path.
 */
export function createPipelineStageContext(
  init: PipelineStageContextInit,
): Result<PipelineStageContext, DebuggenError> {
  const { session } = init;
  const projectRoot = normalizePosix(session.projectRoot);
  if (projectRoot.length === 0 || !isAbsolutePosix(projectRoot)) {
    return err(
      new DebuggenError(
        'PROJECT_NOT_FOUND',
        'The session does not record an absolute project root, so the pipeline cannot measure project-relative paths against it.',
        {
          hint: 'Start the session again from the workspace folder in VS Code.',
          details: { sessionId: session.id, field: 'projectRoot' },
        },
      ),
    );
  }

  const currentUrl = init.currentUrl ?? session.boundTab?.url;
  const context: PipelineStageContext = {
    sessionId: session.id,
    session,
    projectRoot,
    question: session.question,
    ...(init.followUpQuestion !== undefined ? { followUpQuestion: init.followUpQuestion } : {}),
    ...(session.target !== undefined ? { target: session.target } : {}),
    ...(currentUrl !== undefined ? { currentUrl } : {}),
    code: init.code,
    promptVersions: { ...session.promptVersions },
    ...(init.captureId !== undefined ? { captureId: init.captureId } : {}),
    logger: sessionLogger(init.logger, session.id, init.captureId),
    now: init.now ?? Date.now,
    ...(init.signal !== undefined ? { signal: init.signal } : {}),
  };
  return ok(context);
}

/* -------------------------------------------------------------------------------------------------
 * Caps
 * ---------------------------------------------------------------------------------------------- */

/**
 * The named caps every stage payload is held to (AAP §0.7.1, §0.5.2). Each is a
 * positive integer; see {@link CONTEXT_LIMITS} for the defaults and why each
 * value was chosen.
 */
export interface ContextLimits {
  /** Characters of the developer's question (and of a follow-up question) rendered into a prompt. */
  readonly maxQuestionChars: number;
  /** Characters of a selected element's visible text. */
  readonly maxTargetTextChars: number;
  /** Characters of any other free-text field inside a serialised section. */
  readonly maxStringChars: number;
  /** Characters of a page address. */
  readonly maxUrlChars: number;
  /** Characters of a catalog description handed in as text (tool or adapter catalog). */
  readonly maxCatalogChars: number;
  /** Lines of one source excerpt. */
  readonly maxExcerptLines: number;
  /** Characters of one source excerpt. */
  readonly maxExcerptChars: number;
  /** Source excerpts in one request. */
  readonly maxExcerpts: number;
  /** Entries of an investigation shortlist handed to a later stage. */
  readonly maxRelevantFiles: number;
  /** Items of any other list inside a serialised section. */
  readonly maxListItems: number;
  /** Executed code-query runs carried into one investigation turn. */
  readonly maxQueryResults: number;
  /** JSON nodes (values of any kind) of one serialised section. */
  readonly maxSectionNodes: number;
  /** UTF-8 bytes of the structured input of one request. */
  readonly maxPayloadBytes: number;
  /** Nesting depth of one serialised section. */
  readonly maxDepth: number;
}

/**
 * The default caps, and the ceilings {@link resolveContextLimits} clamps every
 * override to. Frozen: a mutation would silently re-budget every prompt the
 * service builds.
 */
export const CONTEXT_LIMITS: ContextLimits = Object.freeze({
  // A question is a sentence or a short paragraph; two thousand characters holds any honest one.
  maxQuestionChars: 2_000,
  // The 120-character preview rule of AAP §0.5.2 for values captured from the page.
  maxTargetTextChars: 120,
  // Long enough for a reason, a rationale or a redacted statement; short enough that no field dominates.
  maxStringChars: 1_000,
  // The route matcher's own URL ceiling, so an address the model sees is one it can query.
  maxUrlChars: CODE_QUERY_LIMITS.maxUrlLength,
  // A generated catalog is a few hundred words; sixteen thousand characters is several times that.
  maxCatalogChars: 16_000,
  // The query engine's excerpt line budget: an excerpt the engine returns is never cut here.
  maxExcerptLines: CODE_QUERY_LIMITS.maxExcerptLines,
  // The query engine's excerpt character budget, for the same reason.
  maxExcerptChars: CODE_QUERY_LIMITS.maxExcerptChars,
  // The analysis input's excerpt count, so every stage shows the model the same amount of source.
  maxExcerpts: ANALYSIS_INPUT_LIMITS.maxExcerpts,
  // The analysis input's shortlist length: a longer shortlist is noise to plan against.
  maxRelevantFiles: ANALYSIS_INPUT_LIMITS.maxRelevantFiles,
  // The query engine's result ceiling; past fifty entries a list stops being evidence.
  maxListItems: CODE_QUERY_LIMITS.maxResults,
  // Above any sane per-stage query budget, so the log is only ever cut by a runaway loop.
  maxQueryResults: 24,
  // Bounds the cost of walking one artifact; a stored panel or plan is a few hundred nodes.
  maxSectionNodes: 5_000,
  // The analysis input budget (192 KiB) plus room for the understanding: about 65k tokens at most.
  maxPayloadBytes: 262_144,
  // Half the outbound guard's default depth (32), so the guard's inspection always completes.
  maxDepth: 16,
});

/** The names of the caps, in declaration order. */
const CONTEXT_LIMIT_KEYS = Object.freeze(
  Object.keys(CONTEXT_LIMITS) as readonly (keyof ContextLimits)[],
);

/**
 * Resolves caller overrides against {@link CONTEXT_LIMITS}.
 *
 * Every override must be a positive integer and is clamped **down** to the
 * default: a caller — a test, or a future stage — may tighten a cap but can
 * never widen the privacy and cost boundary the defaults define. An override
 * that is not a positive finite number is ignored in favour of the default.
 *
 * @param overrides The caps to tighten.
 * @returns A frozen, complete set of caps.
 */
export function resolveContextLimits(overrides?: Partial<ContextLimits>): ContextLimits {
  const resolved: Record<keyof ContextLimits, number> = { ...CONTEXT_LIMITS };
  if (overrides !== undefined) {
    for (const key of CONTEXT_LIMIT_KEYS) {
      const value = overrides[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
        resolved[key] = Math.min(Math.floor(value), CONTEXT_LIMITS[key]);
      }
    }
  }
  return Object.freeze(resolved);
}

/* -------------------------------------------------------------------------------------------------
 * Pure capping helpers
 * ---------------------------------------------------------------------------------------------- */

/** The marker appended to text {@link capText} shortened: one character, never an instruction. */
export const TRUNCATION_MARKER = '\u2026';

/** The outcome of {@link capText}. */
export interface CappedText {
  /** The text, at most `max` characters long. */
  readonly text: string;
  /** Whether characters were removed. */
  readonly truncated: boolean;
}

/**
 * Whether the UTF-16 code unit at `index` of `value` is a high surrogate, i.e.
 * the first half of a character a cut at `index + 1` would split.
 */
function isHighSurrogateAt(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Cuts `value` to at most `max` UTF-16 code units (`max` counts the marker).
 * A shortened value ends in {@link TRUNCATION_MARKER}, and a cut never splits
 * a surrogate pair. A non-finite `max` means "no cap"; a `max` below one
 * yields the empty string. Pure and total.
 *
 * @param value The text to cap.
 * @param max The greatest length of the result.
 * @returns The capped text and whether anything was removed.
 */
export function capText(value: string, max: number): CappedText {
  if (!Number.isFinite(max) && max > 0) {
    return { text: value, truncated: false };
  }
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  if (value.length <= limit) {
    return { text: value, truncated: false };
  }
  if (limit === 0) {
    return { text: '', truncated: true };
  }
  let cut = limit - TRUNCATION_MARKER.length;
  if (cut > 0 && isHighSurrogateAt(value, cut - 1)) {
    cut -= 1;
  }
  return { text: `${value.slice(0, Math.max(0, cut))}${TRUNCATION_MARKER}`, truncated: true };
}

/** Any whitespace, by the same test the outbound guard's `url-query-value` rule applies. */
const WHITESPACE_PATTERN = /\s/;

/**
 * The single token `text` holds, or `undefined` when it is empty or holds
 * whitespace between two non-whitespace characters.
 *
 * Surrounding whitespace is ignored because the outbound guard ignores it: its
 * `url-query-value` rule trims a string and examines it only when what remains
 * is one whitespace-free run. `String.prototype.trim` and `\s` agree on what
 * whitespace is, so a string is a token here exactly when the guard reads it
 * as one; prose — anything else — is never examined by that rule.
 */
function soleToken(text: string): string | undefined {
  const token = text.trim();
  return token.length > 0 && !WHITESPACE_PATTERN.test(token) ? token : undefined;
}

/**
 * Whether the outbound guard parses `token` as a URL and checks its query
 * values: an absolute URL of any scheme the WHATWG parser accepts
 * (`http://…`, `mailto:…`), or an origin-relative reference (`/path?…`). A
 * protocol-relative `//host/…` is neither to the guard, and neither is a
 * selector or a component name, whose query-shaped part the guard never reads.
 */
function isGuardParsedUrl(token: string): boolean {
  return (token.startsWith('/') && !token.startsWith('//')) || URL.canParse(token);
}

/**
 * Keeps a query masked across a cut: the one post-redaction cap step shared by
 * {@link redactAndCapUrl} and {@link redactAndCapText}.
 *
 * `capped` is {@link capText}'s cut of text whose query values are already the
 * mask `?`. A cut that lands in a masked value turns `sort=?` into `sort=…` or
 * `sort=?…`, a value that is neither empty nor the mask, and the guard's
 * `url-query-value` rule would refuse the whole request for it. So when the
 * cut falls inside a value, the pair it split is dropped back to the preceding
 * `&` (or the `?`) and the marker becomes a bare trailing segment — the same
 * shape `redactUrl` itself gives a query it had to cut. A cut inside the
 * authority or path leaves no query; a cut inside a parameter name leaves a
 * bare name; a cut inside the fragment leaves every pair whole. Each of those,
 * and text that was not cut, is returned as {@link capText} produced it.
 *
 * The structure is read with the telemetry layer's `parseUrlParts`, which splits
 * at the first `#` and then the first `?` exactly as the WHATWG parser the
 * guard uses does, and written back with `formatUrlParts`, which round-trips
 * everything but the query verbatim. The result is never longer than `capped`.
 *
 * @param capped The cut of already-masked text.
 * @returns The cut with no split query pair left behind.
 */
function keepCutQueryMasked(capped: CappedText): CappedText {
  if (!capped.truncated) {
    return capped;
  }
  const parts = parseUrlParts(capped.text);
  const { query } = parts;
  if (query === undefined || parts.fragment !== undefined) {
    return capped;
  }
  const pairStart = query.lastIndexOf('&') + 1;
  if (!query.includes('=', pairStart)) {
    return capped;
  }
  return {
    text: formatUrlParts({ ...parts, query: `${query.slice(0, pairStart)}${TRUNCATION_MARKER}` }),
    truncated: true,
  };
}

/**
 * Re-masks the query of a single token the outbound guard parses as a URL, as
 * the guard's parser delimits it; any other text is returned unchanged.
 *
 * `redactTextUrls` ends an embedded URL at a quote or an angle bracket and
 * leaves trailing sentence punctuation outside it, which is right for a URL
 * inside a label or a selector but not for a token the guard reads whole: to
 * the WHATWG parser, `/reset?coupon=?.` carries the value `?.` and
 * `/a[@href="/p?id=?"]` the value `?"]`, and either would refuse the request.
 * So every pair of such a token's query is masked again with
 * `redactQueryString` — idempotent on a value that is already `?`, so the
 * common case comes back byte-identical — and the trailing characters the
 * parser would have read as part of the last value go with it. A masked value
 * is one character and every other part is kept as it was, so the result is
 * never longer, except for a query `redactQueryString` has to bound — more than
 * `MAX_QUERY_PAIRS` pairs, which takes over a thousand characters and so lies
 * beyond every cap of {@link CONTEXT_LIMITS} — where it ends the query with a
 * `[redacted]` segment; the caller re-caps that case.
 *
 * @param text Text whose embedded URLs are already masked and which is already cut.
 * @returns The text, with the query the guard would examine masked in the guard's own terms.
 */
function maskGuardParsedQuery(text: string): string {
  const token = soleToken(text);
  if (token === undefined || !token.includes('?') || !isGuardParsedUrl(token)) {
    return text;
  }
  const parts = parseUrlParts(text);
  if (parts.query === undefined) {
    return text;
  }
  return formatUrlParts({ ...parts, query: redactQueryString(parts.query) });
}

/**
 * Redacts page-derived free text with the telemetry layer's `scrub` and masks
 * every URL embedded in it with `redactTextUrls`, then caps the redacted form
 * without ever leaving a query value the outbound guard would read as unmasked.
 *
 * Used for every string of a selected element — tag name, selector, visible
 * text, component names — because the element is described by the browser,
 * not by the ingest checkpoint, and nothing upstream of this builder has run
 * the rules of AAP §0.5.2 over it. Two passes run over the whole value:
 *
 * 1. `scrub`: provider keys, bearer credentials, JWT-shaped strings,
 *    private-key blocks and credentialed connection strings become
 *    `[redacted]` wherever they sit in the text.
 * 2. `redactTextUrls`: every URL embedded in the text — a link whose visible
 *    text is its own address, an attribute selector such as
 *    `a[href="/p?id=…"]`, a sentence quoting `/reset?coupon=…`, a component
 *    label carrying `?x=…` — has each query value and a non-empty fragment
 *    replaced by `?`, the same rule the current URL gets ("query values become
 *    `?` per key"), while the parameter names and the text around it are kept.
 *
 * Everything else is kept verbatim, and both passes are idempotent, so
 * already-clean text comes back unchanged. The order is the point: both passes
 * see the whole value, so a credential or a query value that straddles the cap
 * is replaced whole instead of leaving its head behind, and cutting redacted
 * text exposes nothing new. A bare high-entropy run with no credential shape
 * is left alone, exactly as the first checkpoint leaves it: the entropy rule is
 * bound to key-like field names, and a selector or a label is not one.
 *
 * The cut is then made with {@link capText}. Prose — text with whitespace
 * inside it — keeps that plain cut: the guard does not examine prose, and its
 * values were masked before the cut. A result that is a single token is held
 * to the guard's reading of it: a cut inside a masked pair drops that pair and
 * ends with {@link TRUNCATION_MARKER}, as {@link redactAndCapUrl} does, and when
 * the guard parses the token as a URL, its query is masked in the parser's own
 * terms, so a standalone link such as `http://127.0.0.1:3000/reset?coupon=…`
 * builds instead of refusing Stage 1.
 *
 * @example
 * ```ts
 * redactAndCapText(`Bearer ${token}`, 120).text; // 'Bearer [redacted]'
 * redactAndCapText('Visit /reset?coupon=SPRING', 120).text; // 'Visit /reset?coupon=?'
 * ```
 *
 * @param value The page-derived text.
 * @param max The greatest length of the result, as {@link capText} counts it.
 * @returns The redacted, capped text and whether the cap removed characters.
 */
export function redactAndCapText(value: string, max: number): CappedText {
  const capped = capText(redactTextUrls(scrub(value)), max);
  if (soleToken(capped.text) === undefined) {
    return capped;
  }
  const kept = keepCutQueryMasked(capped);
  const text = maskGuardParsedQuery(kept.text);
  if (text.length <= max) {
    return { text, truncated: kept.truncated };
  }
  // Only a query past `MAX_QUERY_PAIRS` grows when re-masked. Every value in it
  // is now `?` or empty, so cutting it again cannot expose one.
  return keepCutQueryMasked(capText(text, max));
}

/**
 * Redacts a page address with the telemetry layer's `redactUrl`, then caps the
 * redacted form without ever leaving a query value the outbound guard would
 * read as unmasked.
 *
 * `redactUrl` keeps the scheme, host, port, path and every query parameter
 * name in order, replaces each non-empty query value and a non-empty fragment
 * with `?`, replaces userinfo with `[redacted]` and scrubs the path, so
 * `http://127.0.0.1:3000/products?sort=price&page=2#details` becomes
 * `http://127.0.0.1:3000/products?sort=?&page=?#?` — the route the model can
 * match, and none of the values AAP §0.5.2 forbids storing or sending. It is
 * idempotent, so an address that was masked upstream comes back unchanged.
 *
 * A plain {@link capText} of the redacted form is right everywhere except
 * inside the query, where a cut into a masked value would leave a value the
 * guard's `url-query-value` rule refuses; {@link keepCutQueryMasked} drops the
 * pair such a cut split, back to the preceding `&` (or the `?`), and ends the
 * query with the marker as a bare trailing segment.
 *
 * @example
 * ```ts
 * redactAndCapUrl('http://127.0.0.1:3000/products?sort=price', 2_048).text;
 * // 'http://127.0.0.1:3000/products?sort=?'
 * ```
 *
 * @param url The page address, as the browser reported it.
 * @param max The greatest length of the result, as {@link capText} counts it.
 * @returns The redacted, capped address and whether the cap removed characters.
 */
export function redactAndCapUrl(url: string, max: number): CappedText {
  return keepCutQueryMasked(capText(redactUrl(url), max));
}

/** The outcome of {@link capList}. */
export interface CappedList<T> {
  /** A new array holding the first `max` items. */
  readonly items: T[];
  /** Whether items were removed. */
  readonly truncated: boolean;
  /** How many items there were before capping. */
  readonly total: number;
}

/**
 * Keeps the first `max` items of `items`, in their original order, in a new
 * array. A non-finite `max` keeps everything. Pure and total.
 *
 * @param items The list to cap.
 * @param max The greatest number of items to keep.
 * @returns The kept items, whether any were removed and the original count.
 */
export function capList<T>(items: readonly T[], max: number): CappedList<T> {
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : items.length;
  const kept = items.slice(0, limit);
  return { items: kept, truncated: kept.length < items.length, total: items.length };
}

/**
 * The fields {@link capExcerpt} reads and writes. `CodeExcerpt` from
 * `@debuggen/code-analysis` and the excerpt rows of the analysis stage input
 * both have this shape.
 */
export interface ExcerptLike {
  /** The project-relative POSIX file the text came from. */
  readonly file: string;
  /** The 1-based first line. */
  readonly startLine: number;
  /** The 1-based last line. */
  readonly endLine: number;
  /** The lines, joined with `'\n'`. */
  readonly text: string;
  /** Whether the text was already clipped upstream. */
  readonly truncated: boolean;
}

/** The outcome of {@link capExcerpt}. */
export interface CappedExcerpt<E extends ExcerptLike> {
  /** The excerpt, capped; `file` and `startLine` are unchanged. */
  readonly excerpt: E;
  /** Whether this call removed lines or characters. */
  readonly truncated: boolean;
}

/**
 * Caps one source excerpt by lines, then by characters, keeping its source
 * location intact: `file` and `startLine` never change, and `endLine` is
 * recomputed from the lines actually kept, so the excerpt still points at
 * exactly the text it carries. The character cut prefers the last line break
 * inside the budget, so a capped excerpt ends on a whole line wherever one
 * fits. The returned excerpt's own `truncated` flag is set when either this
 * call or the upstream query clipped it.
 *
 * @param excerpt The excerpt to cap.
 * @param limits The line and character caps.
 * @returns A new excerpt and whether this call shortened it.
 */
export function capExcerpt<E extends ExcerptLike>(
  excerpt: E,
  limits: Pick<ContextLimits, 'maxExcerptLines' | 'maxExcerptChars'>,
): CappedExcerpt<E> {
  const maxLines = Math.max(1, Math.floor(limits.maxExcerptLines));
  const maxChars = Math.max(1, Math.floor(limits.maxExcerptChars));

  const lines = excerpt.text.split('\n');
  let text = lines.length > maxLines ? lines.slice(0, maxLines).join('\n') : excerpt.text;
  let changed = lines.length > maxLines;

  if (text.length > maxChars) {
    const lastBreak = text.lastIndexOf('\n', maxChars);
    if (lastBreak > 0) {
      text = text.slice(0, lastBreak);
    } else {
      let cut = maxChars;
      if (isHighSurrogateAt(text, cut - 1)) {
        cut -= 1;
      }
      text = text.slice(0, cut);
    }
    changed = true;
  }

  if (!changed) {
    return { excerpt: { ...excerpt }, truncated: false };
  }
  const keptLines = text.length === 0 ? 1 : text.split('\n').length;
  const endLine = Math.max(excerpt.startLine, excerpt.startLine + keptLines - 1);
  return { excerpt: { ...excerpt, text, endLine, truncated: true }, truncated: true };
}

/* -------------------------------------------------------------------------------------------------
 * Deterministic serialisation
 * ---------------------------------------------------------------------------------------------- */

/** Whether `value` is a non-null object that is not an array. */
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The prototype-polluting key. Never copied into a built object: assigning it
 * would replace the object's prototype instead of adding a property.
 */
const PROTO_KEY = '__proto__';

/**
 * The value `JSON.stringify` would serialise in place of `value`: the result of
 * its `toJSON` method when it has one (a `Date`, for instance), else `value`.
 * A throwing `toJSON` yields `undefined`, which drops the value.
 */
function jsonReplacement(value: object): unknown {
  const candidate: unknown = Reflect.get(value, 'toJSON');
  if (typeof candidate !== 'function') {
    return value;
  }
  try {
    return (candidate as (this: object) => unknown).call(value);
  } catch {
    return undefined;
  }
}

/**
 * Canonicalises `value` into plain JSON with every object's keys in sorted
 * order, following `JSON.stringify`'s rules for what survives: `undefined`,
 * functions and symbols are dropped from objects and become `null` in arrays,
 * non-finite numbers become `null`, and `toJSON` is honoured. A big integer
 * becomes its decimal string. A cyclic reference is dropped rather than
 * followed.
 */
function canonicalJson(value: unknown, ancestors: Set<object>): JsonValue | undefined {
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      return undefined;
  }

  const replaced = jsonReplacement(value);
  if (replaced !== value) {
    return canonicalJson(replaced, ancestors);
  }
  if (ancestors.has(value)) {
    return undefined;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: readonly unknown[] = value;
      return items.map((item) => canonicalJson(item, ancestors) ?? null);
    }
    const source = value as Record<string, unknown>;
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(source).sort()) {
      if (key === PROTO_KEY) {
        continue;
      }
      const entry = canonicalJson(source[key], ancestors);
      if (entry !== undefined) {
        out[key] = entry;
      }
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Serialises `value` as deterministic, compact JSON: object keys sorted by
 * UTF-16 code unit at every level (no locale collation), no whitespace, and
 * `JSON.stringify`'s rules for what survives. Two structurally identical
 * values render byte-identically whatever order their keys were inserted in —
 * the property the deterministic provider and the wording-invariance tests of
 * AAP §0.5.4 rely on. Compact rather than indented because the output is
 * prompt budget. Total: a value with nothing serialisable renders as `null`.
 *
 * @param value The value to serialise.
 * @returns The canonical JSON text.
 */
export function toPromptJson(value: unknown): string {
  try {
    return JSON.stringify(canonicalJson(value, new Set<object>()) ?? null);
  } catch {
    return 'null';
  }
}

/** The caps {@link toBoundedJson} applies. Omitted list and string caps mean "unbounded". */
export interface BoundedJsonOptions {
  /** Deepest container nesting kept; deeper containers are dropped. */
  readonly maxDepth: number;
  /** Values visited before the walk stops adding. */
  readonly maxNodes: number;
  /** Items kept per list, when lists are capped. */
  readonly maxListItems?: number | undefined;
  /** Characters kept per string, when strings are capped. */
  readonly maxStringChars?: number | undefined;
  /** Excerpt caps: an excerpt-shaped object is capped with {@link capExcerpt} instead of by string length. */
  readonly excerptLimits?: Pick<ContextLimits, 'maxExcerptLines' | 'maxExcerptChars'> | undefined;
}

/** The outcome of {@link toBoundedJson}. */
export interface BoundedJson {
  /** The bounded value, or `undefined` when nothing serialisable remained. */
  readonly value: JsonValue | undefined;
  /** Whether any cap removed something. */
  readonly truncated: boolean;
}

/** Whether `value` has the excerpt fields {@link capExcerpt} works on. */
function isExcerptLike(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ExcerptLike {
  return (
    typeof value['file'] === 'string' &&
    typeof value['text'] === 'string' &&
    typeof value['startLine'] === 'number' &&
    typeof value['endLine'] === 'number' &&
    typeof value['truncated'] === 'boolean'
  );
}

/** Mutable walk state of one {@link toBoundedJson} call. */
interface BoundedWalk {
  readonly options: BoundedJsonOptions;
  readonly ancestors: Set<object>;
  nodes: number;
  truncated: boolean;
}

/** One step of {@link toBoundedJson}. */
function boundedValue(value: unknown, depth: number, walk: BoundedWalk): JsonValue | undefined {
  walk.nodes += 1;
  if (walk.nodes > walk.options.maxNodes) {
    walk.truncated = true;
    return undefined;
  }
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case 'string': {
      if (walk.options.maxStringChars === undefined) {
        return value;
      }
      const capped = capText(value, walk.options.maxStringChars);
      walk.truncated ||= capped.truncated;
      return capped.text;
    }
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      return undefined;
  }

  const replaced = jsonReplacement(value);
  if (replaced !== value) {
    walk.nodes -= 1;
    return boundedValue(replaced, depth, walk);
  }
  if (depth >= walk.options.maxDepth || walk.ancestors.has(value)) {
    walk.truncated = true;
    return undefined;
  }

  walk.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const source: readonly unknown[] = value;
      const capped =
        walk.options.maxListItems === undefined
          ? { items: source.slice(), truncated: false }
          : capList(source, walk.options.maxListItems);
      walk.truncated ||= capped.truncated;
      const items: JsonValue[] = [];
      for (const item of capped.items) {
        const bounded = boundedValue(item, depth + 1, walk);
        if (bounded !== undefined) {
          items.push(bounded);
        }
      }
      return items;
    }

    let source = value as Record<string, unknown>;
    let excerptText: string | undefined;
    if (walk.options.excerptLimits !== undefined && isExcerptLike(source)) {
      const capped = capExcerpt(source, walk.options.excerptLimits);
      walk.truncated ||= capped.truncated;
      source = capped.excerpt;
      excerptText = capped.excerpt.text;
    }

    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(source).sort()) {
      if (key === PROTO_KEY) {
        continue;
      }
      if (key === 'text' && excerptText !== undefined) {
        walk.nodes += 1;
        out[key] = excerptText;
        continue;
      }
      const bounded = boundedValue(source[key], depth + 1, walk);
      if (bounded !== undefined) {
        out[key] = bounded;
      }
    }
    return out;
  } finally {
    walk.ancestors.delete(value);
  }
}

/**
 * Converts an arbitrary artifact into plain, bounded JSON: keys sorted,
 * strings and lists capped where the options say so, nesting cut at
 * `maxDepth`, the walk stopped after `maxNodes` values, cycles dropped, and
 * excerpt-shaped objects capped by {@link capExcerpt} rather than by string
 * length. It never mutates its input and always returns fresh objects.
 *
 * @param value The artifact to convert.
 * @param options The caps to apply.
 * @returns The bounded value and whether anything was removed.
 */
export function toBoundedJson(value: unknown, options: BoundedJsonOptions): BoundedJson {
  const walk: BoundedWalk = { options, ancestors: new Set<object>(), nodes: 0, truncated: false };
  try {
    const bounded = boundedValue(value, 0, walk);
    return { value: bounded, truncated: walk.truncated };
  } catch {
    return { value: undefined, truncated: true };
  }
}

/* -------------------------------------------------------------------------------------------------
 * Payload budget
 * ---------------------------------------------------------------------------------------------- */

/** Which end of a section's top-level list a budget step keeps when it halves that list. */
export type PayloadBudgetKeep = 'head' | 'tail';

/** One step of the payload budget: a section and the end of its top-level list to keep. */
export interface PayloadBudgetStep {
  /** The input section the step trims, then drops. */
  readonly section: string;
  /** The end of the section's own list that survives halving; nested lists always keep their head. */
  readonly keep: PayloadBudgetKeep;
}

/**
 * The fixed order in which {@link applyPayloadBudget} gives up input sections,
 * **lowest evidentiary value first**. Each step halves every list inside its
 * section until the payload fits or no list is longer than one item, and only
 * then drops the section. A section that is not listed is never touched.
 *
 * 1. `codeExcerpts` — bounded source text; the analysis cites events, not lines of code.
 * 2. `candidates` — a structural projection of `queryResults`, redundant with it.
 * 3. `panel` — a view over the analysis, which itself travels whole.
 * 4. `projectSummary` — orientation about the project, not evidence about the problem.
 * 5. `queryResults` — keeps the most recent runs; the oldest were read in earlier turns.
 * 6. `captureSummary` — evidence; trimmed only after everything cheaper is gone.
 * 7. `investigation` — the shortlist the plan is built on; the last thing to shrink.
 *
 * `question` never appears in structured input, and the sections in
 * {@link PROTECTED_PAYLOAD_SECTIONS} — the understanding, the analysis (every
 * evidence id) and the plan (every installed action id) — are never trimmed.
 */
export const PAYLOAD_BUDGET_STEPS: readonly PayloadBudgetStep[] = Object.freeze([
  Object.freeze({ section: 'codeExcerpts', keep: 'head' }),
  Object.freeze({ section: 'candidates', keep: 'head' }),
  Object.freeze({ section: 'panel', keep: 'head' }),
  Object.freeze({ section: 'projectSummary', keep: 'head' }),
  Object.freeze({ section: 'queryResults', keep: 'tail' }),
  Object.freeze({ section: 'captureSummary', keep: 'head' }),
  Object.freeze({ section: 'investigation', keep: 'head' }),
] as const satisfies readonly PayloadBudgetStep[]);

/**
 * Sections the payload budget never trims or drops, whatever the caller asks:
 * the understanding frames every stage's reasoning, the analysis carries every
 * evidence id an observed fact cites, and the plan carries every installed
 * action id the additive-only follow-up rule depends on.
 */
export const PROTECTED_PAYLOAD_SECTIONS: readonly string[] = Object.freeze([
  'understanding',
  'analysis',
  'plan',
]);

/** Options of {@link applyPayloadBudget}. */
export interface PayloadBudgetOptions {
  /** Further sections this request must not trim, in addition to {@link PROTECTED_PAYLOAD_SECTIONS}. */
  readonly protectedSections?: readonly string[] | undefined;
}

/** The outcome of {@link applyPayloadBudget}. */
export interface PayloadBudget {
  /** The budgeted payload: a new object; the caller's is never modified. */
  readonly payload: JsonObject;
  /** Sections removed entirely, in the order they were removed. */
  readonly dropped: readonly string[];
  /** Sections whose lists were halved, in the order they were first trimmed. */
  readonly trimmed: readonly string[];
  /** The payload's size after budgeting, measured by {@link estimatePayloadBytes}. */
  readonly bytes: number;
  /** Whether the payload now fits `maxPayloadBytes`. */
  readonly fits: boolean;
}

/**
 * Halves every list of length two or more inside `value`, keeping the head —
 * or, for the root list when `tailAtRoot` is set, the tail. Returns a new
 * value; `changed` reports whether any list shrank.
 */
function halveLists(
  value: JsonValue,
  tailAtRoot: boolean,
): { readonly value: JsonValue; readonly changed: boolean } {
  if (Array.isArray(value)) {
    const list: readonly JsonValue[] = value;
    let changed = false;
    let kept: readonly JsonValue[] = list;
    if (list.length >= 2) {
      const size = Math.ceil(list.length / 2);
      kept = tailAtRoot ? list.slice(list.length - size) : list.slice(0, size);
      changed = true;
    }
    const items = kept.map((item) => {
      const halved = halveLists(item, false);
      changed ||= halved.changed;
      return halved.value;
    });
    return { value: items, changed };
  }
  if (isObjectRecord(value)) {
    const source: JsonObject = value;
    const out: Record<string, JsonValue> = {};
    let changed = false;
    for (const key of Object.keys(source)) {
      const entry = source[key];
      if (entry === undefined) {
        continue;
      }
      const halved = halveLists(entry, false);
      changed ||= halved.changed;
      out[key] = halved.value;
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

/**
 * Fits `payload` into `maxPayloadBytes` by giving up sections in the fixed
 * order of {@link PAYLOAD_BUDGET_STEPS}. Each step first halves every list in
 * its section, repeatedly, and drops the section only when halving can shrink
 * it no further. A protected section is skipped. The caller's payload is never
 * modified. When even that is not enough, `fits` is `false` and the caller must
 * refuse the request rather than send it over budget.
 *
 * @param payload The structured input to budget.
 * @param limits The byte budget.
 * @param options Additional sections to protect.
 * @returns The budgeted payload and what was trimmed or dropped, by section name.
 */
export function applyPayloadBudget(
  payload: JsonObject,
  limits: Pick<ContextLimits, 'maxPayloadBytes'>,
  options?: PayloadBudgetOptions,
): PayloadBudget {
  const working = new Map<string, JsonValue>();
  for (const key of Object.keys(payload)) {
    const entry = payload[key];
    if (entry !== undefined && key !== PROTO_KEY) {
      working.set(key, entry);
    }
  }
  const snapshot = (): JsonObject => Object.fromEntries(working);

  const protectedSections = new Set<string>([
    ...PROTECTED_PAYLOAD_SECTIONS,
    ...(options?.protectedSections ?? []),
  ]);
  const dropped: string[] = [];
  const trimmed: string[] = [];
  let bytes = estimatePayloadBytes(snapshot());

  for (const step of PAYLOAD_BUDGET_STEPS) {
    if (bytes <= limits.maxPayloadBytes) {
      break;
    }
    let section = working.get(step.section);
    if (section === undefined || protectedSections.has(step.section)) {
      continue;
    }
    while (bytes > limits.maxPayloadBytes) {
      const halved = halveLists(section, step.keep === 'tail');
      if (!halved.changed) {
        break;
      }
      section = halved.value;
      working.set(step.section, section);
      if (!trimmed.includes(step.section)) {
        trimmed.push(step.section);
      }
      bytes = estimatePayloadBytes(snapshot());
    }
    if (bytes > limits.maxPayloadBytes) {
      working.delete(step.section);
      dropped.push(step.section);
      bytes = estimatePayloadBytes(snapshot());
    }
  }

  return {
    payload: snapshot(),
    dropped,
    trimmed,
    bytes,
    fits: bytes <= limits.maxPayloadBytes,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Placeholder contracts
 * ---------------------------------------------------------------------------------------------- */

/**
 * The placeholder keys each committed prompt file declares in its `## Inputs`
 * section, key for key. `renderPrompt` substitutes in a single pass and fails
 * listing every missing key, so a builder must supply exactly these;
 * `context-builder.test.ts` drift-tests this table against the `{{…}}` tokens
 * of every `prompts/<stage>/v001.md`.
 *
 * `generate-panel` is recorded for that drift test only: `../panels/generate.ts`
 * owns its prompt (`PANEL_PROMPT_PLACEHOLDERS`) and this module builds no
 * request for it.
 */
export const STAGE_PLACEHOLDERS = Object.freeze({
  understand: Object.freeze([
    'question',
    'target',
    'currentUrl',
    'projectSummary',
    'outputSchema',
  ] as const),
  investigate: Object.freeze([
    'question',
    'understanding',
    'toolCatalog',
    'queryResults',
    'remainingQueries',
    'outputSchema',
  ] as const),
  plan: Object.freeze([
    'understanding',
    'investigation',
    'adapterCatalog',
    'outputSchema',
  ] as const),
  analyze: Object.freeze([
    'question',
    'understanding',
    'captureSummary',
    'codeExcerpts',
    'outputSchema',
  ] as const),
  'generate-panel': Object.freeze([
    'question',
    'analysis',
    'nodeCatalog',
    'captureOverview',
    'outputSchema',
  ] as const),
  followup: Object.freeze([
    'followUpQuestion',
    'understanding',
    'plan',
    'captureSummary',
    'analysis',
    'panel',
    'outputSchema',
  ] as const),
}) satisfies Readonly<Record<PromptStage, readonly string[]>>;

/** The placeholder keys of one stage's prompt. */
export type StagePlaceholder<S extends PromptStage> = (typeof STAGE_PLACEHOLDERS)[S][number];

/**
 * The stages this module builds requests for, in pipeline order. The sixth
 * prompt stage, `generate-panel`, is deliberately absent (its prompt belongs to
 * `../panels/generate.ts`), and `capture` is not a prompt stage at all.
 */
export const CONTEXT_BUILDER_STAGES = Object.freeze([
  'understand',
  'investigate',
  'plan',
  'analyze',
  'followup',
] as const satisfies readonly PromptStage[]);

/** A stage this module builds requests for. */
export type ContextBuilderStage = (typeof CONTEXT_BUILDER_STAGES)[number];

/**
 * The value rendered for a context element that does not exist — no selected
 * element, no bound page. The understand prompt names this word as the marker
 * for "nothing selected"; it is data, not an instruction.
 */
export const ABSENT_VALUE = 'none';

/**
 * The field of an investigate reply that carries a batch of proposed code
 * queries, as the `{{outputSchema}}` document of that stage declares it.
 * Exported so `stages/investigate.ts` reads the same name the schema states.
 */
export const INVESTIGATE_QUERY_BATCH_FIELD = 'queries';

/* -------------------------------------------------------------------------------------------------
 * {{outputSchema}} documents
 * ---------------------------------------------------------------------------------------------- */

/** Where one stage's `{{outputSchema}}` document comes from. */
export type OutputSchemaSourceKind = 'upstream-schema' | 'assembled' | 'upstream-emitter';

/** The provenance of one stage's `{{outputSchema}}` document. */
export interface OutputSchemaSource {
  /**
   * `upstream-schema`: rendered from the owning package's authoring schema
   * object itself; `assembled`: composed here from upstream-rendered pieces
   * because the artifact is stage-local; `upstream-emitter`: produced by the
   * owning package's own text emitter.
   */
  readonly kind: OutputSchemaSourceKind;
  /** The upstream exports the document is rendered from, as `package#export`. */
  readonly sources: readonly string[];
  /** Why the document is built the way it is. */
  readonly note: string;
}

/**
 * The provenance of every stage's `{{outputSchema}}` document. The upstream
 * schema is always the single source of truth: wherever a package owns the
 * reply's schema, the document is rendered from that schema object through its
 * own `toJSONSchema` method (no `zod` import here), so a bound, an enumeration
 * or a field added upstream reaches the prompt with no edit to this file.
 */
export const STAGE_OUTPUT_SCHEMA_SOURCES: Readonly<Record<PromptStage, OutputSchemaSource>> =
  Object.freeze({
    understand: Object.freeze({
      kind: 'upstream-schema',
      sources: Object.freeze(['@debuggen/instrumentation#problemUnderstandingSchema']),
      note: 'The ProblemUnderstanding authoring schema; its category, signal and entity-kind enumerations are PROBLEM_CATEGORIES, CAPTURE_SIGNALS and PROBLEM_ENTITY_KINDS.',
    }),
    investigate: Object.freeze({
      kind: 'assembled',
      sources: Object.freeze(['@debuggen/protocol#sessionRecordSchema.shape.relevantFiles']),
      note: 'CodeInvestigation is stage-local (stages/investigate.ts), so the document is a oneOf of a query batch (tool names from the caller, normally CODE_TOOL_NAMES) and the final investigation, whose shortlist is the rendered SessionRecord.relevantFiles schema and whose flows are one line each.',
    }),
    plan: Object.freeze({
      kind: 'upstream-schema',
      sources: Object.freeze(['@debuggen/instrumentation#instrumentationPlanInputSchema']),
      note: 'The InstrumentationPlanInput authoring schema: the model writes objective, capture, instrumentationTargets and hypotheses only; normalizePlan assigns everything else. Custom refinements (the project-relative path rule) do not survive JSON Schema rendering and are enforced after parsing.',
    }),
    analyze: Object.freeze({
      kind: 'upstream-schema',
      sources: Object.freeze(['@debuggen/protocol#analysisFindingsSchema']),
      note: 'The AnalysisFindings schema: observed facts that each cite at least one EventRef, and likely causes carrying a CONFIDENCE_LEVELS confidence.',
    }),
    'generate-panel': Object.freeze({
      kind: 'upstream-emitter',
      sources: Object.freeze(['@debuggen/panel-schema#panelSpecInputJsonSchemaText']),
      note: 'Rendered by ../panels/generate.ts, which owns this prompt; recorded here for completeness and for the drift test.',
    }),
    followup: Object.freeze({
      kind: 'assembled',
      sources: Object.freeze([
        '@debuggen/instrumentation#instrumentationPlanInputSchema.shape.instrumentationTargets',
      ]),
      note: 'FollowUpDecision is stage-local (stages/followup.ts): needsNewCapture plus additionalActions written as authoring plan targets, whose ids, adapters and modes deterministic code assigns.',
    }),
  });

/** The JSON Schema rendering settings every upstream schema is rendered with. */
interface JsonSchemaRenderParams {
  /** The dialect: draft 2020-12, the dialect `@debuggen/panel-schema` emits. */
  readonly target: 'draft-2020-12';
  /** Render what the model writes (the schema's input side), not what parsing produces. */
  readonly io: 'input';
  /** A construct JSON Schema cannot express is a product bug, so it fails loudly. */
  readonly unrepresentable: 'throw';
  /** Inline reuse, so every document — and every piece embedded in another — is self-contained. */
  readonly reused: 'inline';
  /** A genuine cycle still renders, as a `$ref`. */
  readonly cycles: 'ref';
}

/** The frozen rendering settings. */
const JSON_SCHEMA_RENDER_PARAMS: JsonSchemaRenderParams = Object.freeze({
  target: 'draft-2020-12',
  io: 'input',
  unrepresentable: 'throw',
  reused: 'inline',
  cycles: 'ref',
});

/** Anything that renders itself as JSON Schema — every upstream schema object does. */
interface JsonSchemaEmitter {
  toJSONSchema(params?: JsonSchemaRenderParams): unknown;
}

/** The dialect keyword of a JSON Schema document. */
const DIALECT_KEYWORD = '$schema';

/**
 * Renders an upstream schema object as a canonical (key-sorted) JSON Schema
 * document.
 *
 * @throws DebuggenError `INTERNAL` when the schema cannot be rendered: there is
 * no input here, only a package's own schema, so a failure is a product bug.
 */
function renderUpstreamSchema(emitter: JsonSchemaEmitter, label: string): JsonObject {
  let rendered: unknown;
  try {
    rendered = emitter.toJSONSchema(JSON_SCHEMA_RENDER_PARAMS);
  } catch (cause) {
    throw new DebuggenError(
      'INTERNAL',
      `The ${label} output schema could not be rendered as JSON Schema.`,
      {
        hint: 'A construct reachable from the schema has no JSON Schema equivalent; express it with an enumeration, a bound or a pattern.',
        details: { schema: label },
        cause,
      },
    );
  }
  const canonical = canonicalJson(rendered, new Set<object>());
  if (!isObjectRecord(canonical)) {
    throw new DebuggenError('INTERNAL', `The ${label} output schema rendered as a non-object.`, {
      details: { schema: label },
    });
  }
  return canonical;
}

/** A rendered upstream schema with its dialect keyword split off, for embedding in another document. */
function embeddedSchema(
  emitter: JsonSchemaEmitter,
  label: string,
): { readonly dialect: JsonValue | undefined; readonly body: JsonObject } {
  const rendered = renderUpstreamSchema(emitter, label);
  const body: Record<string, JsonValue> = {};
  for (const key of Object.keys(rendered)) {
    const entry = rendered[key];
    if (key !== DIALECT_KEYWORD && entry !== undefined) {
      body[key] = entry;
    }
  }
  return { dialect: rendered[DIALECT_KEYWORD], body };
}

/** Options of {@link outputSchemaFor}. */
export interface OutputSchemaOptions {
  /**
   * The code-query tool names an investigate reply may request — normally
   * `CODE_TOOL_NAMES` from `tools/code-tools.ts`, passed by the stage because
   * this module does not import its siblings. Absent, the document accepts any
   * non-empty tool name and the catalog in `{{toolCatalog}}` states the set.
   * Ignored for every other stage.
   */
  readonly toolNames?: readonly string[] | undefined;
}

/** The investigate stage's reply document: a query batch, or the final investigation. */
function investigateOutputSchema(options: OutputSchemaOptions | undefined): string {
  const { dialect, body: relevantFiles } = embeddedSchema(
    sessionRecordSchema.shape.relevantFiles,
    'SessionRecord.relevantFiles',
  );
  const toolNames = [
    ...new Set((options?.toolNames ?? []).filter((name) => name.trim().length > 0)),
  ];
  const toolSchema: JsonObject =
    toolNames.length > 0 ? { type: 'string', enum: toolNames } : { type: 'string', minLength: 1 };

  const document: JsonObject = {
    ...(dialect !== undefined ? { [DIALECT_KEYWORD]: dialect } : {}),
    oneOf: [
      {
        type: 'object',
        properties: {
          [INVESTIGATE_QUERY_BATCH_FIELD]: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: { tool: toolSchema },
              required: ['tool'],
            },
          },
        },
        required: [INVESTIGATE_QUERY_BATCH_FIELD],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          relevantFiles,
          flows: {
            type: 'array',
            maxItems: CONTEXT_LIMITS.maxListItems,
            items: { type: 'string', minLength: 1, maxLength: CONTEXT_LIMITS.maxStringChars },
          },
        },
        required: ['relevantFiles', 'flows'],
        additionalProperties: false,
      },
    ],
  };
  return toPromptJson(document);
}

/** The followup stage's reply document: the decision and the additive targets. */
function followUpOutputSchema(): string {
  const { dialect, body: additionalActions } = embeddedSchema(
    instrumentationPlanInputSchema.shape.instrumentationTargets,
    'InstrumentationPlanInput.instrumentationTargets',
  );
  const document: JsonObject = {
    ...(dialect !== undefined ? { [DIALECT_KEYWORD]: dialect } : {}),
    type: 'object',
    properties: {
      needsNewCapture: { type: 'boolean' },
      additionalActions,
    },
    required: ['needsNewCapture', 'additionalActions'],
    additionalProperties: false,
  };
  return toPromptJson(document);
}

/** One renderer per prompt stage; a `Record` over the stage union makes the table exhaustive. */
const OUTPUT_SCHEMA_RENDERERS: Readonly<
  Record<PromptStage, (options: OutputSchemaOptions | undefined) => string>
> = Object.freeze({
  understand: () =>
    toPromptJson(renderUpstreamSchema(problemUnderstandingSchema, 'ProblemUnderstanding')),
  investigate: investigateOutputSchema,
  plan: () =>
    toPromptJson(renderUpstreamSchema(instrumentationPlanInputSchema, 'InstrumentationPlanInput')),
  analyze: () => toPromptJson(renderUpstreamSchema(analysisFindingsSchema, 'AnalysisFindings')),
  'generate-panel': () => panelSpecInputJsonSchemaText(),
  followup: followUpOutputSchema,
});

/**
 * The JSON Schema document a stage's prompt receives through
 * `{{outputSchema}}` — the only form in which a stage's output contract
 * reaches the model (see {@link STAGE_OUTPUT_SCHEMA_SOURCES} for where each
 * comes from). Deterministic and byte-stable: rendered from upstream schema
 * objects and serialised with {@link toPromptJson}, except `generate-panel`,
 * whose text is `panelSpecInputJsonSchemaText()` verbatim.
 *
 * @param stage The prompt stage.
 * @param options Stage-specific rendering options.
 * @returns The JSON Schema document as text.
 * @throws DebuggenError `INTERNAL` if an upstream schema cannot be rendered — a
 * product bug; {@link ContextBuilder} converts it into a typed `Err`.
 */
export function outputSchemaFor(stage: PromptStage, options?: OutputSchemaOptions): string {
  return OUTPUT_SCHEMA_RENDERERS[stage](options);
}

/* -------------------------------------------------------------------------------------------------
 * Builder contract
 * ---------------------------------------------------------------------------------------------- */

/** The generic input of {@link ContextBuilder.buildStageRequest}. */
export interface StageRequestSpec {
  /** The prompt stage. */
  readonly stage: PromptStage;
  /** One value per placeholder of the stage's prompt — exactly {@link STAGE_PLACEHOLDERS}`[stage]`. */
  readonly values: Readonly<Record<string, string>>;
  /** The structured context the values were derived from; already capped and redacted. */
  readonly input: JsonObject;
  /** The session the request belongs to; omitted from the metadata when absent. */
  readonly sessionId?: string | undefined;
  /** A recorded prompt version to reuse (`loadVersion`); absent, the manifest's current version (`load`). */
  readonly promptVersion?: string | undefined;
  /** A system instruction; stages normally have none, since prompt prose lives in prompt files. */
  readonly system?: string | undefined;
  /** Cancels the build and, once built, the provider call. */
  readonly signal?: AbortSignal | undefined;
  /** Section names the caller capped, reported on the build. */
  readonly truncated?: readonly string[] | undefined;
}

/** A request ready for `generateStructuredWithRepair`, with what building it cost. */
export interface StageRequestBuild {
  /** The request: rendered prompt, structured input, metadata and signal. Already guard-checked. */
  readonly request: ModelRequest;
  /** The prompt stage. */
  readonly stage: PromptStage;
  /** The prompt version actually loaded; the orchestrator records it on the session. */
  readonly promptVersion: string;
  /** Names of the sections that were capped, trimmed or dropped — names only, never values. */
  readonly truncated: readonly string[];
  /** UTF-8 bytes of the prompt, the system instruction and the compact structured input. */
  readonly bytes: number;
}

/** The fields every per-stage build request carries. */
export interface StageBuildOptions {
  /** The pipeline run's stage context. */
  readonly context: PipelineStageContext;
  /** A prompt version to use; absent, the version recorded on the session, else the current one. */
  readonly promptVersion?: string | undefined;
  /** Cancels the build; absent, the context's signal. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * A catalog handed to a prompt: either the generated, byte-stable text a
 * sibling module renders (`describeCodeTools()`), or a structured description
 * (an adapter capability list from the live registry), which travels as data.
 */
export type CatalogDescription = string | object;

/** Input of {@link ContextBuilder.buildUnderstandRequest}. */
export interface UnderstandRequestInput extends StageBuildOptions {
  /** The project summary to render; defaults to `context.code.projectSummary`. */
  readonly projectSummary?: ProjectSummary | undefined;
  /**
   * The wording-invariant lexical hints `stages/understand.ts`'s generic
   * tokenizer derived from the question: a plain object whose every own
   * property is a list of strings (for example `tokens`,
   * `identifierCandidates`, `signalTerms`). Each list is placed at the top
   * level of the structured input, beside `target`, `currentUrl` and
   * `projectSummary`, which it may not shadow; the raw question never is.
   */
  readonly questionHints?: object | undefined;
}

/** Input of {@link ContextBuilder.buildInvestigateRequest}; one call per investigation turn. */
export interface InvestigateRequestInput extends StageBuildOptions {
  /** The validated Stage 1 understanding. */
  readonly understanding: ProblemUnderstanding;
  /** The tool catalog, normally `describeCodeTools()` from `tools/code-tools.ts`. */
  readonly toolCatalog: CatalogDescription;
  /** Every query run executed so far, in execution order (`CodeToolRun` values). */
  readonly queryResults: readonly unknown[];
  /** Query turns still available, from the code tools' live budget. */
  readonly remainingQueries: number;
  /** The tool names a query batch may use, normally `CODE_TOOL_NAMES`; constrains `{{outputSchema}}`. */
  readonly toolNames?: readonly string[] | undefined;
}

/** The investigation a plan request is built on: the shape of `CodeInvestigation`. */
export interface InvestigationContextInput {
  /** The shortlist, most relevant first. */
  readonly relevantFiles: readonly RelevantFile[];
  /** The flows connecting the shortlist. */
  readonly flows: readonly unknown[];
}

/** Input of {@link ContextBuilder.buildPlanRequest}. */
export interface PlanRequestInput extends StageBuildOptions {
  /** The validated Stage 1 understanding. */
  readonly understanding: ProblemUnderstanding;
  /** The validated Stage 2 investigation. */
  readonly investigation: InvestigationContextInput;
  /** The adapter capability catalog, derived from the live `AdapterRegistry` by `stages/plan.ts`. */
  readonly adapterCatalog: CatalogDescription;
}

/** Input of {@link ContextBuilder.buildAnalyzeRequest}. */
export interface AnalyzeRequestInput extends StageBuildOptions {
  /** The validated Stage 1 understanding. */
  readonly understanding: ProblemUnderstanding;
  /** The bounded, redacted analysis input from `../analysis/summarize.js`. */
  readonly stageInput: AnalysisStageInput;
  /** Excerpts to render instead of the stage input's own; capped here with {@link capExcerpt}. */
  readonly excerpts?: readonly CodeExcerpt[] | undefined;
}

/** Input of {@link ContextBuilder.buildFollowUpRequest}. */
export interface FollowUpRequestInput extends StageBuildOptions {
  /** The follow-up question, verbatim. Rendered into the prompt only. */
  readonly followUpQuestion: string;
  /** The session's stored understanding. */
  readonly understanding?: ProblemUnderstanding | undefined;
  /** The installed plan; every action is carried, whatever else is capped. */
  readonly plan?: InstrumentationPlan | undefined;
  /** The latest capture's summary. */
  readonly captureSummary?: CaptureSummary | undefined;
  /** The latest analysis; carried with every evidence reference. */
  readonly analysis?: AnalysisResult | undefined;
  /** The latest panel specification. */
  readonly panel?: PanelSpec | undefined;
}

/** Collaborators of {@link createContextBuilder}; everything is injected. */
export interface ContextBuilderDeps {
  /** Loads and caches the versioned prompt files; the only source of prompt text. */
  readonly promptLoader: PromptLoader;
  /** The configured provider, recorded on build log records. */
  readonly config?: Pick<ServiceConfig, 'provider'> | undefined;
  /** The parent logger; defaults to a no-op logger. */
  readonly logger?: Logger | undefined;
  /** Caps to tighten; see {@link resolveContextLimits}. */
  readonly limits?: Partial<ContextLimits> | undefined;
  /** Options for the outbound guard. */
  readonly guardOptions?: RedactGuardOptions | undefined;
  /** The clock, used only to time builds for the debug log. */
  readonly now?: (() => number) | undefined;
}

/**
 * The pipeline's request builder. Every method is synchronous, never throws
 * for an expected failure and returns a request only after the outbound guard
 * has accepted it; an `Err` means the stage must not call the provider.
 */
export interface ContextBuilder {
  /** The effective caps. */
  readonly limits: ContextLimits;
  /** Builds a request from already-derived placeholder values: load, check keys, render, assemble, guard. */
  buildStageRequest(spec: StageRequestSpec): Result<StageRequestBuild, DebuggenError>;
  /** Stage 1: the question, the selected element, the page and the project summary. */
  buildUnderstandRequest(request: UnderstandRequestInput): Result<StageRequestBuild, DebuggenError>;
  /** Stage 2, one turn: the understanding, the tool catalog, the results so far and the budget. */
  buildInvestigateRequest(
    request: InvestigateRequestInput,
  ): Result<StageRequestBuild, DebuggenError>;
  /** Stage 3: the understanding, the investigation and the adapter catalog. */
  buildPlanRequest(request: PlanRequestInput): Result<StageRequestBuild, DebuggenError>;
  /** Stage 5: the understanding, the capture's analysis input and the code excerpts. */
  buildAnalyzeRequest(request: AnalyzeRequestInput): Result<StageRequestBuild, DebuggenError>;
  /** The follow-up decision: the new question against the stored plan, capture, analysis and panel. */
  buildFollowUpRequest(request: FollowUpRequestInput): Result<StageRequestBuild, DebuggenError>;
}

/* -------------------------------------------------------------------------------------------------
 * Builder internals
 * ---------------------------------------------------------------------------------------------- */

/** The logger subsystem this module binds. */
const CONTEXT_BUILDER_SUBSYSTEM = 'pipeline.context';

/** Log message of a successful build. Fields: stage, version, sizes and counts — never content. */
const BUILT_LOG = 'Built a stage request.';

/** Log message of a guard refusal. Fields: stage, version, rule ids and paths — never values. */
const GUARD_REFUSED_LOG =
  'The outbound guard refused a stage request; the stage must not call the provider.';

/** Keys the understand stage's question hints may not use: they name its context sections. */
const UNDERSTAND_RESERVED_KEYS: readonly string[] = Object.freeze([
  'target',
  'currentUrl',
  'projectSummary',
]);

/** Analysis-input fields that are prompt-only (the question) or rendered separately (excerpts). */
const ANALYZE_SEPARATED_KEYS: ReadonlySet<string> = new Set([
  'question',
  'followUpQuestion',
  'excerpts',
]);

/** Keys under which a query run nests the request that produced it, not its findings. */
const QUERY_REQUEST_KEY = 'request';

/**
 * Whether `signal` has been aborted. A function rather than an inline property
 * read, so every check observes the signal's current state.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/** The error of a build whose signal is already aborted. */
function abortedError(stage: PromptStage): DebuggenError {
  return new DebuggenError('INTERNAL', `The ${stage} request was cancelled before it was built.`, {
    details: { stage, reason: 'aborted' },
  });
}

/** The error of a build whose structured input cannot be fitted to the byte budget. */
function overBudgetError(
  stage: PromptStage,
  bytes: number,
  maxPayloadBytes: number,
  dropped: readonly string[],
): DebuggenError {
  return new DebuggenError(
    'INTERNAL',
    `The ${stage} request's structured input exceeds its byte budget, so it was not sent.`,
    {
      hint: 'An upstream section is larger than its own bounds allow; check the caps of the module that produced it.',
      details: {
        stage,
        reason: 'payload-budget',
        bytes: Number.isFinite(bytes) ? bytes : -1,
        maxPayloadBytes,
        dropped: [...dropped],
      },
    },
  );
}

/** Reads the string entries of an error-detail list, ignoring anything else. */
function detailStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const list: readonly unknown[] = value;
  return list.filter((entry): entry is string => typeof entry === 'string');
}

/** UTF-8 byte length of a string. */
function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Renders a serialised section: canonical JSON, or `null` for a section that is absent. */
function renderSection(value: JsonValue | undefined): string {
  return value === undefined ? 'null' : toPromptJson(value);
}

/**
 * Renders a section that may be plain text (a URL, a generated catalog): the
 * text itself, {@link ABSENT_VALUE} when absent, canonical JSON otherwise.
 */
function renderTextSection(value: JsonValue | undefined): string {
  if (value === undefined) {
    return ABSENT_VALUE;
  }
  return typeof value === 'string' ? value : toPromptJson(value);
}

/** A non-negative integer count, `0` for anything that is not a finite number. */
function toCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Creates the pipeline's {@link ContextBuilder}.
 *
 * Holds no state beyond the resolved caps and a per-instance cache of the
 * rendered `{{outputSchema}}` documents (which are constant for a process);
 * prompt caching is the prompt loader's alone.
 *
 * @param deps The prompt loader and the optional collaborators.
 * @returns The builder.
 */
export function createContextBuilder(deps: ContextBuilderDeps): ContextBuilder {
  const limits = resolveContextLimits(deps.limits);
  const baseLogger = subsystemLogger(deps.logger ?? noopLogger, CONTEXT_BUILDER_SUBSYSTEM);
  const now = deps.now ?? Date.now;
  const provider = deps.config?.provider;
  const schemaCache = new Map<string, string>();

  /** The permissive profile: artifacts an upstream module or schema already bounds. */
  const upstreamBounded: BoundedJsonOptions = {
    maxDepth: limits.maxDepth,
    maxNodes: limits.maxSectionNodes,
  };
  /** Text capped, lists whole: artifacts whose every list item must survive (ids, evidence). */
  const textCapped: BoundedJsonOptions = {
    ...upstreamBounded,
    maxStringChars: limits.maxStringChars,
  };
  /** Fully capped: artifacts whose lists may be cut (results, catalogs, summaries, panels). */
  const fullyCapped: BoundedJsonOptions = {
    ...textCapped,
    maxListItems: limits.maxListItems,
    excerptLimits: limits,
  };

  /** Bounds one section, recording its name when a cap removed something. */
  const boundSection = (
    value: unknown,
    section: string,
    options: BoundedJsonOptions,
    truncated: Set<string>,
  ): JsonValue | undefined => {
    const bounded = toBoundedJson(value, options);
    if (bounded.truncated) {
      truncated.add(section);
    }
    return bounded.value;
  };

  /** Caps one prompt-only text, recording its name when shortened. */
  const capSectionText = (
    value: string,
    max: number,
    section: string,
    truncated: Set<string>,
  ): string => {
    const capped = capText(value, max);
    if (capped.truncated) {
      truncated.add(section);
    }
    return capped.text;
  };

  /** A catalog: capped text when handed text, bounded data when handed structure. */
  const catalogSection = (
    catalog: CatalogDescription,
    section: string,
    truncated: Set<string>,
  ): JsonValue | undefined =>
    typeof catalog === 'string'
      ? capSectionText(catalog, limits.maxCatalogChars, section, truncated)
      : boundSection(catalog, section, fullyCapped, truncated);

  /** The rendered `{{outputSchema}}` document of a stage, cached per instance. */
  const schemaText = (
    stage: PromptStage,
    options?: OutputSchemaOptions,
  ): Result<string, DebuggenError> => {
    const names = options?.toolNames ?? [];
    const key = `${stage}\u0000${names.join('\u0000')}`;
    const cached = schemaCache.get(key);
    if (cached !== undefined) {
      return ok(cached);
    }
    const rendered = tryCatch(() => outputSchemaFor(stage, options), 'INTERNAL');
    if (rendered.ok) {
      schemaCache.set(key, rendered.value);
    }
    return rendered;
  };

  /** Loads the recorded version when one is named, else the manifest's current version. */
  const resolvePrompt = (
    stage: PromptStage,
    version: string | undefined,
  ): Result<PromptFile, DebuggenError> =>
    version === undefined
      ? deps.promptLoader.load(stage)
      : deps.promptLoader.loadVersion(stage, version);

  /** Checks the supplied placeholder keys against the stage's table before anything is rendered. */
  const checkPlaceholderKeys = (
    stage: PromptStage,
    values: Readonly<Record<string, string>>,
  ): Result<void, DebuggenError> => {
    const expected: readonly string[] = STAGE_PLACEHOLDERS[stage];
    const supplied = Object.keys(values);
    const missing = expected.filter((key) => !Object.hasOwn(values, key)).sort();
    const unexpected = supplied.filter((key) => !expected.includes(key)).sort();
    if (missing.length === 0 && unexpected.length === 0) {
      return ok(undefined);
    }
    return err(
      new DebuggenError(
        'CONFIG_INVALID',
        `The ${stage} prompt expects exactly the placeholders ${expected.join(', ')}; the request supplied ${String(missing.length)} missing and ${String(unexpected.length)} unexpected key(s).`,
        {
          hint: 'Build the request with the stage builder, or supply one value per key of STAGE_PLACEHOLDERS for this stage.',
          details: { stage, missingPlaceholders: missing, unexpectedPlaceholders: unexpected },
        },
      ),
    );
  };

  /** The fixed build sequence: abort check, load, key check, size check, render, assemble, guard. */
  const build = (spec: StageRequestSpec, log: Logger): Result<StageRequestBuild, DebuggenError> => {
    const started = now();
    const { stage } = spec;
    if (isAborted(spec.signal)) {
      return err(abortedError(stage));
    }

    const prompt = resolvePrompt(stage, spec.promptVersion);
    if (!prompt.ok) {
      return prompt;
    }

    const keys = checkPlaceholderKeys(stage, spec.values);
    if (!keys.ok) {
      return keys;
    }

    const inputBytes = estimatePayloadBytes(spec.input);
    if (inputBytes > limits.maxPayloadBytes) {
      return err(overBudgetError(stage, inputBytes, limits.maxPayloadBytes, []));
    }

    // Checked again: loading may have taken long enough for the run to be cancelled meanwhile.
    if (isAborted(spec.signal)) {
      return err(abortedError(stage));
    }
    const rendered = renderPrompt(prompt.value.text, spec.values, log);
    if (!rendered.ok) {
      return rendered;
    }

    const promptVersion = prompt.value.version;
    const system = spec.system !== undefined && spec.system.length > 0 ? spec.system : undefined;
    const sessionId =
      spec.sessionId !== undefined && spec.sessionId.length > 0 ? spec.sessionId : undefined;
    const request: ModelRequest = {
      ...(system !== undefined ? { system } : {}),
      prompt: rendered.value,
      input: spec.input,
      metadata: {
        stage,
        promptVersion,
        ...(sessionId !== undefined ? { sessionId } : {}),
      },
      ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
    };

    const guard = assertOutboundSafe(request, deps.guardOptions);
    if (!guard.ok) {
      log.warn(GUARD_REFUSED_LOG, {
        stage,
        promptVersion,
        code: guard.error.code,
        ruleIds: detailStrings(guard.error.details?.['ruleIds']),
        paths: detailStrings(guard.error.details?.['paths']),
      });
      return guard;
    }

    const truncated = [...new Set(spec.truncated ?? [])].sort();
    const bytes =
      utf8Bytes(rendered.value) + inputBytes + (system !== undefined ? utf8Bytes(system) : 0);
    log.debug(BUILT_LOG, {
      stage,
      promptVersion,
      bytes,
      truncatedSections: truncated.length,
      durationMs: Math.max(0, now() - started),
      ...(provider !== undefined ? { provider } : {}),
    });
    return ok({ request, stage, promptVersion, truncated, bytes });
  };

  /** What a per-stage builder hands to {@link finishStage}. */
  interface StageDraft {
    readonly stage: ContextBuilderStage;
    readonly request: StageBuildOptions;
    readonly input: JsonObject;
    readonly truncated: Set<string>;
    readonly protectedSections?: readonly string[];
    readonly schemaOptions?: OutputSchemaOptions;
    /** Derives every placeholder value from the budgeted input and the rendered schema. */
    readonly values: (input: JsonObject, outputSchema: string) => Readonly<Record<string, string>>;
  }

  /** Budgets a drafted input, renders its schema and values, and runs the fixed build sequence. */
  const finishStage = (draft: StageDraft): Result<StageRequestBuild, DebuggenError> => {
    const { stage, request, truncated } = draft;
    const { context } = request;
    const log = subsystemLogger(context.logger, CONTEXT_BUILDER_SUBSYSTEM);

    const budget = applyPayloadBudget(draft.input, limits, {
      protectedSections: draft.protectedSections,
    });
    if (!budget.fits) {
      return err(overBudgetError(stage, budget.bytes, limits.maxPayloadBytes, budget.dropped));
    }
    for (const section of [...budget.trimmed, ...budget.dropped]) {
      truncated.add(section);
    }

    const outputSchema = schemaText(stage, draft.schemaOptions);
    if (!outputSchema.ok) {
      return outputSchema;
    }

    return build(
      {
        stage,
        values: draft.values(budget.payload, outputSchema.value),
        input: budget.payload,
        sessionId: context.sessionId,
        promptVersion: request.promptVersion ?? context.promptVersions[stage],
        signal: request.signal ?? context.signal,
        truncated: [...truncated],
      },
      log,
    );
  };

  /** The signal a per-stage build honours: its own, else the context's. */
  const signalOf = (request: StageBuildOptions): AbortSignal | undefined =>
    request.signal ?? request.context.signal;

  /** Redacts and caps one page-derived text of `section`, recording its name when shortened. */
  const pageSectionText = (
    value: string,
    max: number,
    section: string,
    truncated: Set<string>,
  ): string => {
    const capped = redactAndCapText(value, max);
    if (capped.truncated) {
      truncated.add(section);
    }
    return capped.text;
  };

  /**
   * The selected element as data: tag, selector, visible text and component
   * chain, every string redacted before it is capped. The element was
   * described by the page, so each of its strings is page content that no
   * checkpoint has redacted yet.
   */
  const targetSection = (
    target: SelectedTarget | undefined,
    truncated: Set<string>,
  ): JsonValue | undefined => {
    if (target === undefined) {
      return undefined;
    }
    const chain = capList(target.componentChain, limits.maxListItems);
    if (chain.truncated) {
      truncated.add('target');
    }
    return {
      tagName: pageSectionText(target.tagName, limits.maxStringChars, 'target', truncated),
      selector: pageSectionText(target.selector, limits.maxStringChars, 'target', truncated),
      ...(target.text !== undefined
        ? {
            text: pageSectionText(target.text, limits.maxTargetTextChars, 'target', truncated),
          }
        : {}),
      componentChain: chain.items.map((name) =>
        pageSectionText(name, limits.maxStringChars, 'target', truncated),
      ),
    };
  };

  /** The bound tab's address, redacted and then capped, recording `currentUrl` when shortened. */
  const currentUrlSection = (
    url: string | undefined,
    truncated: Set<string>,
  ): string | undefined => {
    if (url === undefined) {
      return undefined;
    }
    const capped = redactAndCapUrl(url, limits.maxUrlChars);
    if (capped.truncated) {
      truncated.add('currentUrl');
    }
    return capped.text;
  };

  /** Reads the understand stage's question hints: every own property must be a list of strings. */
  const questionHintSections = (
    hints: object | undefined,
    truncated: Set<string>,
  ): Result<Record<string, JsonValue>, DebuggenError> => {
    const sections: Record<string, JsonValue> = {};
    if (hints === undefined) {
      return ok(sections);
    }
    const source = hints as Readonly<Record<string, unknown>>;
    const invalid: string[] = [];
    const reserved: string[] = [];
    for (const key of Object.keys(source).sort()) {
      const value = source[key];
      if (value === undefined) {
        continue;
      }
      if (UNDERSTAND_RESERVED_KEYS.includes(key) || key === PROTO_KEY) {
        reserved.push(key);
        continue;
      }
      if (!Array.isArray(value)) {
        invalid.push(key);
        continue;
      }
      const list: readonly unknown[] = value;
      if (!list.every((entry): entry is string => typeof entry === 'string')) {
        invalid.push(key);
        continue;
      }
      const capped = capList(list, limits.maxListItems);
      if (capped.truncated) {
        truncated.add('questionHints');
      }
      sections[key] = capped.items.map((entry) =>
        capSectionText(entry, limits.maxStringChars, 'questionHints', truncated),
      );
    }
    if (invalid.length > 0 || reserved.length > 0) {
      return err(
        new DebuggenError(
          'INTERNAL',
          'The question hints handed to the understand request are malformed: every hint must be a list of strings under a key that does not name a context section.',
          { details: { stage: 'understand', invalidKeys: invalid, reservedKeys: reserved } },
        ),
      );
    }
    return ok(sections);
  };

  /**
   * The structural projection of executed query results a rules-based
   * provider ranks: every code node a result named (an object with a
   * project-relative `file` and a `name` or `symbol`), de-duplicated by file
   * and symbol, in first-seen order. The request that produced a result is
   * skipped, so a symbol that was asked for but not found is never a
   * candidate. The same data is in `{{queryResults}}`; this only reshapes it.
   */
  const candidatesFrom = (results: JsonValue | undefined): JsonValue[] => {
    const candidates: JsonValue[] = [];
    const seen = new Set<string>();
    const visit = (value: JsonValue, depth: number): void => {
      if (candidates.length >= limits.maxListItems || depth > limits.maxDepth) {
        return;
      }
      if (Array.isArray(value)) {
        const list: readonly JsonValue[] = value;
        for (const item of list) {
          visit(item, depth + 1);
        }
        return;
      }
      if (!isObjectRecord(value)) {
        return;
      }
      const node: JsonObject = value;
      const file = node['file'];
      const symbol = node['symbol'] ?? node['name'];
      if (typeof file === 'string' && typeof symbol === 'string' && isSafeRelativePath(file)) {
        const identity = `${file}\u0000${symbol}`;
        if (!seen.has(identity)) {
          seen.add(identity);
          const kind = node['kind'];
          const score = node['score'];
          candidates.push({
            file,
            symbol,
            ...(typeof kind === 'string' ? { kind } : {}),
            ...(typeof score === 'number' ? { score } : {}),
          });
        }
      }
      for (const key of Object.keys(node).sort()) {
        const entry = node[key];
        if (key !== QUERY_REQUEST_KEY && entry !== undefined) {
          visit(entry, depth + 1);
        }
      }
    };
    if (results !== undefined) {
      visit(results, 0);
    }
    return candidates;
  };

  const buildStageRequest = (spec: StageRequestSpec): Result<StageRequestBuild, DebuggenError> =>
    build(spec, baseLogger);

  const buildUnderstandRequest = (
    request: UnderstandRequestInput,
  ): Result<StageRequestBuild, DebuggenError> => {
    const stage = 'understand';
    if (isAborted(signalOf(request))) {
      return err(abortedError(stage));
    }
    const { context } = request;
    const truncated = new Set<string>();

    const hints = questionHintSections(request.questionHints, truncated);
    if (!hints.ok) {
      return hints;
    }
    const target = targetSection(context.target, truncated);
    const currentUrl = currentUrlSection(context.currentUrl, truncated);
    const projectSummary = boundSection(
      request.projectSummary ?? context.code.projectSummary,
      'projectSummary',
      upstreamBounded,
      truncated,
    );
    const question = capSectionText(
      context.question,
      limits.maxQuestionChars,
      'question',
      truncated,
    );

    const input: JsonObject = {
      ...hints.value,
      ...(target !== undefined ? { target } : {}),
      ...(currentUrl !== undefined ? { currentUrl } : {}),
      ...(projectSummary !== undefined ? { projectSummary } : {}),
    };

    return finishStage({
      stage,
      request,
      input,
      truncated,
      values: (budgeted, outputSchema) => ({
        question,
        target: budgeted['target'] === undefined ? ABSENT_VALUE : toPromptJson(budgeted['target']),
        currentUrl: renderTextSection(budgeted['currentUrl']),
        projectSummary: renderSection(budgeted['projectSummary']),
        outputSchema,
      }),
    });
  };

  const buildInvestigateRequest = (
    request: InvestigateRequestInput,
  ): Result<StageRequestBuild, DebuggenError> => {
    const stage = 'investigate';
    if (isAborted(signalOf(request))) {
      return err(abortedError(stage));
    }
    const { context } = request;
    const truncated = new Set<string>();

    const understanding = boundSection(
      request.understanding,
      'understanding',
      upstreamBounded,
      truncated,
    );
    const toolCatalog = catalogSection(request.toolCatalog, 'toolCatalog', truncated);

    // The log keeps its most recent runs: the oldest were already read in earlier turns.
    const firstKept = Math.max(0, request.queryResults.length - limits.maxQueryResults);
    if (firstKept > 0) {
      truncated.add('queryResults');
    }
    const queryResults =
      boundSection(request.queryResults.slice(firstKept), 'queryResults', fullyCapped, truncated) ??
      [];
    const candidates = candidatesFrom(queryResults);
    const remainingQueries = toCount(request.remainingQueries);
    const question = capSectionText(
      context.question,
      limits.maxQuestionChars,
      'question',
      truncated,
    );

    const input: JsonObject = {
      ...(understanding !== undefined ? { understanding } : {}),
      ...(toolCatalog !== undefined ? { toolCatalog } : {}),
      queryResults,
      remainingQueries,
      ...(candidates.length > 0 ? { candidates } : {}),
    };

    return finishStage({
      stage,
      request,
      input,
      truncated,
      schemaOptions: { toolNames: request.toolNames },
      values: (budgeted, outputSchema) => {
        const remaining = budgeted['remainingQueries'];
        return {
          question,
          understanding: renderSection(budgeted['understanding']),
          toolCatalog: renderTextSection(budgeted['toolCatalog']),
          queryResults: renderSection(budgeted['queryResults']),
          remainingQueries: String(typeof remaining === 'number' ? remaining : 0),
          outputSchema,
        };
      },
    });
  };

  const buildPlanRequest = (
    request: PlanRequestInput,
  ): Result<StageRequestBuild, DebuggenError> => {
    const stage = 'plan';
    if (isAborted(signalOf(request))) {
      return err(abortedError(stage));
    }
    const truncated = new Set<string>();

    const understanding = boundSection(
      request.understanding,
      'understanding',
      upstreamBounded,
      truncated,
    );
    const files = capList(request.investigation.relevantFiles, limits.maxRelevantFiles);
    const flows = capList(request.investigation.flows, limits.maxListItems);
    if (files.truncated || flows.truncated) {
      truncated.add('investigation');
    }
    const investigation: JsonObject = {
      relevantFiles: boundSection(files.items, 'investigation', textCapped, truncated) ?? [],
      flows: boundSection(flows.items, 'investigation', fullyCapped, truncated) ?? [],
    };
    const adapterCatalog = catalogSection(request.adapterCatalog, 'adapterCatalog', truncated);

    const input: JsonObject = {
      ...(understanding !== undefined ? { understanding } : {}),
      investigation,
      ...(adapterCatalog !== undefined ? { adapterCatalog } : {}),
    };

    return finishStage({
      stage,
      request,
      input,
      truncated,
      values: (budgeted, outputSchema) => ({
        understanding: renderSection(budgeted['understanding']),
        investigation: renderSection(budgeted['investigation']),
        adapterCatalog: renderTextSection(budgeted['adapterCatalog']),
        outputSchema,
      }),
    });
  };

  const buildAnalyzeRequest = (
    request: AnalyzeRequestInput,
  ): Result<StageRequestBuild, DebuggenError> => {
    const stage = 'analyze';
    if (isAborted(signalOf(request))) {
      return err(abortedError(stage));
    }
    const { context } = request;
    const truncated = new Set<string>();

    const understanding = boundSection(
      request.understanding,
      'understanding',
      upstreamBounded,
      truncated,
    );

    // The analysis input is already bounded and redacted by ../analysis/summarize.js: it is
    // serialised as it arrives, minus the prompt-only question and the separately rendered excerpts.
    const stageInput: Readonly<Record<string, unknown>> = request.stageInput;
    const captureSections: Record<string, unknown> = {};
    for (const key of Object.keys(stageInput)) {
      if (!ANALYZE_SEPARATED_KEYS.has(key)) {
        captureSections[key] = stageInput[key];
      }
    }
    const captureSummary = canonicalJson(captureSections, new Set<object>()) ?? {};

    let codeExcerpts: JsonValue;
    if (request.excerpts !== undefined) {
      const kept = capList(request.excerpts, limits.maxExcerpts);
      if (kept.truncated) {
        truncated.add('codeExcerpts');
      }
      const capped = kept.items.map((excerpt) => {
        const result = capExcerpt(excerpt, limits);
        if (result.truncated) {
          truncated.add('codeExcerpts');
        }
        return result.excerpt;
      });
      codeExcerpts = canonicalJson(capped, new Set<object>()) ?? [];
    } else {
      codeExcerpts = canonicalJson(request.stageInput.excerpts, new Set<object>()) ?? [];
    }

    const question = capSectionText(
      context.followUpQuestion ?? context.question,
      limits.maxQuestionChars,
      'question',
      truncated,
    );

    const input: JsonObject = {
      ...(understanding !== undefined ? { understanding } : {}),
      captureSummary,
      codeExcerpts,
    };

    return finishStage({
      stage,
      request,
      input,
      truncated,
      // Every observed fact must cite an event id present in this section (AAP §0.8.4), so the
      // budget may shed excerpts but never the capture's evidence.
      protectedSections: ['captureSummary'],
      values: (budgeted, outputSchema) => ({
        question,
        understanding: renderSection(budgeted['understanding']),
        captureSummary: renderSection(budgeted['captureSummary']),
        codeExcerpts: renderSection(budgeted['codeExcerpts']),
        outputSchema,
      }),
    });
  };

  const buildFollowUpRequest = (
    request: FollowUpRequestInput,
  ): Result<StageRequestBuild, DebuggenError> => {
    const stage = 'followup';
    if (isAborted(signalOf(request))) {
      return err(abortedError(stage));
    }
    const truncated = new Set<string>();

    const understanding =
      request.understanding !== undefined
        ? boundSection(request.understanding, 'understanding', upstreamBounded, truncated)
        : undefined;
    // Every installed action travels, whatever is capped: the additive-only rule depends on it.
    const plan =
      request.plan !== undefined
        ? boundSection(request.plan, 'plan', textCapped, truncated)
        : undefined;
    const captureSummary =
      request.captureSummary !== undefined
        ? boundSection(request.captureSummary, 'captureSummary', fullyCapped, truncated)
        : undefined;
    // Every evidence reference travels: an observation is only as good as the ids it cites.
    const analysis =
      request.analysis !== undefined
        ? boundSection(request.analysis, 'analysis', textCapped, truncated)
        : undefined;
    const panel =
      request.panel !== undefined
        ? boundSection(request.panel, 'panel', fullyCapped, truncated)
        : undefined;
    const followUpQuestion = capSectionText(
      request.followUpQuestion,
      limits.maxQuestionChars,
      'followUpQuestion',
      truncated,
    );

    const input: JsonObject = {
      ...(understanding !== undefined ? { understanding } : {}),
      ...(plan !== undefined ? { plan } : {}),
      ...(captureSummary !== undefined ? { captureSummary } : {}),
      ...(analysis !== undefined ? { analysis } : {}),
      ...(panel !== undefined ? { panel } : {}),
    };

    return finishStage({
      stage,
      request,
      input,
      truncated,
      values: (budgeted, outputSchema) => ({
        followUpQuestion,
        understanding: renderSection(budgeted['understanding']),
        plan: renderSection(budgeted['plan']),
        captureSummary: renderSection(budgeted['captureSummary']),
        analysis: renderSection(budgeted['analysis']),
        panel: renderSection(budgeted['panel']),
        outputSchema,
      }),
    });
  };

  return Object.freeze({
    limits,
    buildStageRequest,
    buildUnderstandRequest,
    buildInvestigateRequest,
    buildPlanRequest,
    buildAnalyzeRequest,
    buildFollowUpRequest,
  });
}
