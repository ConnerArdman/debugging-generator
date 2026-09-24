/**
 * The panel validation and rejection boundary of the coordination service.
 *
 * AAP 0.5.3 requires that every model output be validated before it can affect
 * the screen, and AAP 0.5.5 that an invalid panel become a banner over a
 * deterministic fallback — never a broken panel, and never a failure presented
 * as an analysis. This module owns that decision. A generated panel reaches the
 * developer through one fixed sequence, and nothing skips, reorders or adds a
 * step:
 *
 * 1. **authoring schema** — the model's structured output is parsed against
 *    `panelSpecInputSchema` by `@debuggen/model-provider`'s
 *    `generateStructuredWithRepair`, which alone owns the bounded repair loop;
 * 2. **deterministic normaliser** — `normalizePanel`, run once through the
 *    callback {@link buildStructuredOptionsNormalizer} builds;
 * 3. **internal schema** — {@link validateSpec}, delegating to
 *    `validatePanelSpec` and `collectPanelSpecIssues`;
 * 4. **semantic validation** — {@link PanelValidator.validateSemantics},
 *    delegating to `validateAgainstCapture` with the store-backed evidence
 *    resolvers, so every citation is decided against the capture.
 *
 * `panels/generate.ts` drives the sequence. This file owns the last two steps
 * and the classification of whatever went wrong anywhere in it, through the
 * closed {@link PANEL_FAILURE_CLASSES} taxonomy that `generate.ts`,
 * `fallback.ts` and `data.ts` all defer to.
 *
 * ## The `unverifiable` outcome, and why this module exists
 *
 * A `CaptureSummary` is a rollup with bounded top-N sections and no exhaustive
 * event-id set, so an evidence id that is genuinely in the capture but ranked
 * outside those sections cannot be checked from the summary alone, and the
 * semantic validator honestly answers `unverifiable`. Accepting that would let
 * a fabricated citation reach the screen; rejecting it outright would push a
 * genuine panel onto the fallback path. This module resolves it
 * authoritatively instead: it always hands `validateAgainstCapture` the
 * resolvers of the injected {@link PanelEvidenceResolverPort} — satisfied by
 * `AnalysisFacts.createEvidenceResolvers`, backed by the `telemetry_events`
 * table — so every reference is decided. An `unverifiable` answer is then
 * reachable only when no resolver port was injected, or when the store declined
 * to answer; both are rejected, and the second is logged as the
 * product-integrity signal it is.
 *
 * Two outcomes the semantic validator reports are deliberately **not**
 * rejections: an `unavailable-source` or `unavailable-field` note (the node
 * renders its `EmptyState`, AAP 0.6.2) and an `unavailable-metric` note (a
 * `MetricValue` with `available: false`, such as `transferred_bytes`, renders
 * as "n/a", AAP 0.6.6). Both are returned as {@link PanelSemanticReport.warnings}
 * and the panel passes.
 *
 * ## Privacy: failures carry shape, never content
 *
 * A rejection is logged, may be persisted with a session and travels to both
 * user interfaces, passing through neither the redaction layer nor the
 * outbound model guard (AAP 0.5.2). Every message, hint, detail and log field
 * built here is therefore made of fixed text, counts, closed-vocabulary codes,
 * catalogued node types and dotted issue paths — never a rejected value, a
 * fact's statement, a trace id or a model output.
 *
 * ## Never throws for an expected failure
 *
 * Every public function answers with a `Result`. The one deliberate exception
 * is the normaliser callback of {@link buildStructuredOptionsNormalizer},
 * whose throw is the documented product-bug signal the structured-output loop
 * routes down its no-retry path.
 *
 * @example
 * ```ts
 * const validator = createPanelValidator({ evidence: analysisFacts, captures: summarizer, logger });
 * const generated = await generateStructuredWithRepair(provider, panelSpecInputSchema, request, {
 *   normalize: validator.buildStructuredOptionsNormalizer(analysis, context),
 *   schemaName: 'panel specification',
 *   logger,
 * });
 * if (!generated.ok) {
 *   const rejection = validator.classifyFailure(generated.error);
 *   // rejection.class says whether to fall back or to surface the provider's error.
 * } else {
 *   const checked = await validator.validateGenerated({
 *     spec: generated.value.value,
 *     sessionId,
 *     captureId,
 *   });
 *   // checked.ok → store and broadcast; otherwise the deterministic fallback panel.
 * }
 * ```
 *
 * @module
 */

import {
  collectPanelSpecIssues,
  collectSemanticIssues,
  isKnownPanelNodeType,
  normalizePanel,
  parsePanelSpec,
  toResult,
  validateAgainstCapture,
  validatePanelSpec,
} from '@debuggen/panel-schema';
import type {
  IdResolution,
  NormalizeAnalysis,
  NormalizeContext,
  PanelNodePath,
  PanelNodeType,
  PanelSpec,
  PanelSpecInput,
  PanelValidationIssue,
  SemanticIssue,
  SemanticIssueReason,
  SemanticValidationOptions,
  SemanticValidationOutcome,
  SemanticValidationStatus,
} from '@debuggen/panel-schema';
import type { StructuredOptions, StructuredRejectionReason } from '@debuggen/model-provider';
import type { AnalysisResult } from '@debuggen/protocol';
import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  assertNever,
  err,
  noopLogger,
  ok,
} from '@debuggen/shared';
import type {
  CaptureId,
  DebuggenErrorCode,
  LogFields,
  Logger,
  Result,
  SessionId,
} from '@debuggen/shared';
import type { CaptureSummary } from '@debuggen/telemetry';

import { toSemanticValidationOptions } from '../analysis/facts.js';
import type { AnalysisFacts } from '../analysis/facts.js';
import type { AnalysisSummarizer } from '../analysis/summarize.js';
import { sessionLogger, subsystemLogger } from '../logging.js';

/* -------------------------------------------------------------------------------------------------
 * The failure taxonomy
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every way a generated panel can fail to reach the screen as an answer, as a
 * closed readonly tuple, in pipeline order.
 *
 * - `authoring-schema` — the model's output failed `panelSpecInputSchema`.
 * - `normalize` — `normalizePanel` threw, or produced something that is not a
 *   document at all.
 * - `internal-schema` — the normalised document failed `panelSpecSchema` or
 *   the whole-document rules of `validatePanelSpec`.
 * - `semantic` — the document cites evidence, or scopes a view to a trace,
 *   that the capture does not hold; or its citations could not be decided.
 * - `provider` — the model provider itself failed: transport, credential,
 *   quota, cancellation, or an empty answer.
 *
 * {@link PANEL_FAILURE_POLICY} records what each one means for the pipeline.
 */
export const PANEL_FAILURE_CLASSES = Object.freeze([
  'authoring-schema',
  'normalize',
  'internal-schema',
  'semantic',
  'provider',
] as const);

/** One member of {@link PANEL_FAILURE_CLASSES}, derived from the tuple. */
export type PanelFailureClass = (typeof PANEL_FAILURE_CLASSES)[number];

/** Widened view of the tuple, used by {@link isPanelFailureClass}. */
const FAILURE_CLASS_VALUES: readonly string[] = PANEL_FAILURE_CLASSES;

/**
 * Whether a value names one of the failure classes: for a class read back out
 * of an error's `details`, a stored row or a transport frame.
 *
 * @param value Any value believed to name a failure class.
 * @returns `true` when `value` is a member of {@link PANEL_FAILURE_CLASSES}.
 */
export function isPanelFailureClass(value: unknown): value is PanelFailureClass {
  return typeof value === 'string' && FAILURE_CLASS_VALUES.includes(value);
}

/**
 * Whether a failure of this class earns a bounded repair against the model.
 *
 * `true` **only** for `authoring-schema` (AAP 0.5.3): a shape the model got
 * wrong is something a model can correct when shown the validation issues.
 * Every other class is final — a normaliser or internal-schema failure is a
 * product bug that an identical second answer would reproduce, a semantic
 * failure is a panel describing evidence the capture does not hold, and a
 * provider failure produced no output to correct.
 *
 * Written as an exhaustive switch closed by `assertNever`, so a class added to
 * {@link PANEL_FAILURE_CLASSES} fails to compile here until someone decides
 * whether it is repairable.
 *
 * @param failureClass The class to decide.
 * @returns Whether the structured-output loop may re-prompt for it.
 */
export function isRepairableFailure(failureClass: PanelFailureClass): boolean {
  switch (failureClass) {
    case 'authoring-schema':
      return true;
    case 'normalize':
    case 'internal-schema':
    case 'semantic':
    case 'provider':
      return false;
    default:
      return assertNever(failureClass, 'Unhandled panel failure class');
  }
}

/** What the pipeline does with a failure of one class. */
export const PANEL_FAILURE_DISPOSITIONS = Object.freeze([
  'repair-then-fallback',
  'fallback',
  'passthrough',
] as const);

/**
 * One member of {@link PANEL_FAILURE_DISPOSITIONS}.
 *
 * - `repair-then-fallback` — re-prompted within the structured-output loop's
 *   bounded budget; once that is spent, the deterministic fallback panel is
 *   shown under its banner.
 * - `fallback` — never re-prompted; the deterministic fallback panel is shown
 *   under its banner (AAP 0.5.5).
 * - `passthrough` — not a panel problem: the provider's own code, message and
 *   hint are surfaced unchanged, so the developer sees "Model provider
 *   unavailable (‹code›)" rather than a panel error.
 */
export type PanelFailureDisposition = (typeof PANEL_FAILURE_DISPOSITIONS)[number];

/** The recorded policy of one failure class. */
export interface PanelFailurePolicy {
  /** The class this policy describes. */
  readonly failureClass: PanelFailureClass;
  /** What a failure of this class means, in one sentence. */
  readonly meaning: string;
  /** Whether it earns a bounded repair; always {@link isRepairableFailure}. */
  readonly repairable: boolean;
  /**
   * Whether it is a defect in the product rather than in the model's answer or
   * the environment. Product bugs are logged and rejected, never re-prompted.
   */
  readonly productBug: boolean;
  /** What the pipeline does with it. */
  readonly disposition: PanelFailureDisposition;
  /**
   * The code a rejection of this class carries when the failure arrives with
   * no code of its own.
   */
  readonly defaultCode: DebuggenErrorCode;
}

/**
 * Builds one frozen policy entry, deriving `repairable` from
 * {@link isRepairableFailure} so the two can never disagree.
 */
function policyFor(
  failureClass: PanelFailureClass,
  fields: Omit<PanelFailurePolicy, 'failureClass' | 'repairable'>,
): PanelFailurePolicy {
  return Object.freeze({
    failureClass,
    repairable: isRepairableFailure(failureClass),
    ...fields,
  });
}

/**
 * The policy of every failure class, as data.
 *
 * A record over the closed class union, so a class added to
 * {@link PANEL_FAILURE_CLASSES} without a policy here does not compile.
 */
export const PANEL_FAILURE_POLICY: Readonly<Record<PanelFailureClass, PanelFailurePolicy>> =
  Object.freeze({
    'authoring-schema': policyFor('authoring-schema', {
      meaning:
        "The model's output failed the panel authoring schema; it earns the structured-output loop's bounded repair (AAP 0.5.3).",
      productBug: false,
      disposition: 'repair-then-fallback',
      defaultCode: 'MODEL_OUTPUT_INVALID',
    }),
    normalize: policyFor('normalize', {
      meaning:
        'The deterministic normaliser threw, or produced something that is not a panel document, on input the authoring schema had accepted. A product bug: the structured-output loop logs it with the parsed input and rejects it without re-prompting.',
      productBug: true,
      disposition: 'fallback',
      defaultCode: 'INTERNAL',
    }),
    'internal-schema': policyFor('internal-schema', {
      meaning:
        'The normalised panel failed the internal panel schema or its whole-document rules. A product bug: logged and rejected, never re-prompted.',
      productBug: true,
      disposition: 'fallback',
      defaultCode: 'PANEL_INVALID',
    }),
    semantic: policyFor('semantic', {
      meaning:
        'The panel cites evidence or names a trace the capture does not hold, or its citations could not be decided against the stored capture. Rejected in favour of the deterministic fallback panel.',
      productBug: false,
      disposition: 'fallback',
      defaultCode: 'PANEL_SEMANTIC_INVALID',
    }),
    provider: policyFor('provider', {
      meaning:
        "The model provider failed or answered with nothing. Not repairable, and not a panel problem: the provider's code, message and hint pass through unchanged.",
      productBug: false,
      disposition: 'passthrough',
      defaultCode: 'MODEL_UNAVAILABLE',
    }),
  });

/**
 * Runtime membership of `@debuggen/model-provider`'s rejection vocabulary.
 *
 * That package publishes the vocabulary as a type only, so this record is the
 * value-level mirror: keyed by `StructuredRejectionReason`, it fails to compile
 * when a reason is added upstream (missing key) or removed (excess key).
 */
const STRUCTURED_REJECTION_REASON_KEYS: Readonly<Record<StructuredRejectionReason, true>> =
  Object.freeze({ provider: true, schema: true, normalize: true, empty: true });

/** Whether a value, read from an error's `details.reason`, is a structured rejection reason. */
function isStructuredRejectionReason(value: unknown): value is StructuredRejectionReason {
  return typeof value === 'string' && Object.hasOwn(STRUCTURED_REJECTION_REASON_KEYS, value);
}

/**
 * Maps the structured-output loop's rejection reason onto this taxonomy. This
 * is the one place the mapping exists.
 *
 * - `schema` → `authoring-schema`: the repair budget was spent on a shape the
 *   model kept getting wrong.
 * - `normalize` → `normalize`: the normaliser threw. {@link classifyFailure}
 *   refines this to `internal-schema` when the throw was the internal-schema
 *   signal of {@link buildStructuredOptionsNormalizer}.
 * - `provider` → `provider`.
 * - `empty` → `provider`: the call succeeded and the model said nothing, so
 *   there was no output whose shape could be wrong.
 *
 * @param reason The `details.reason` of a `generateStructuredWithRepair` rejection.
 * @returns The failure class.
 */
export function classifyStructuredRejection(reason: StructuredRejectionReason): PanelFailureClass {
  switch (reason) {
    case 'schema':
      return 'authoring-schema';
    case 'normalize':
      return 'normalize';
    case 'provider':
    case 'empty':
      return 'provider';
    default:
      return assertNever(reason, 'Unhandled structured rejection reason');
  }
}

/* -------------------------------------------------------------------------------------------------
 * Rejections
 * ---------------------------------------------------------------------------------------------- */

/**
 * One reported problem with a panel, reduced to its structure: the shape both
 * upstream validators report, flattened to a dotted path so a log line, a
 * stored row and a user interface all read one form.
 */
export interface PanelRejectionIssue {
  /** Dotted path of the offending field (`layout.0.query.source`); `''` for the document. */
  readonly path: string;
  /** The snake-case issue code the reporting validator assigned. */
  readonly code: string;
  /** The closed semantic reason, for an issue the semantic validator raised. */
  readonly reason?: SemanticIssueReason;
  /** The catalogued type of the node the issue is about; never an unrecognised type string. */
  readonly nodeType?: PanelNodeType;
}

/**
 * Why a generated panel was not accepted: the value every step of this module
 * and {@link classifyFailure} answer with on failure.
 *
 * `code`, `message` and `hint` are those of {@link PanelValidationRejection.error},
 * so `rejection.error.toPayload()` is the protocol `error` payload for it.
 */
export interface PanelValidationRejection {
  /** The failure class; see {@link PANEL_FAILURE_POLICY} for what to do with it. */
  readonly class: PanelFailureClass;
  /** The product error code, from the closed `DEBUGGEN_ERROR_CODES` vocabulary. */
  readonly code: DebuggenErrorCode;
  /** One sentence naming what failed, by path and code only. */
  readonly message: string;
  /** The developer's next step, when one applies. */
  readonly hint?: string;
  /** Every problem found, by path and code, where the failing step reported them. */
  readonly issues?: readonly PanelRejectionIssue[];
  /** The semantic report, for a rejection raised by semantic validation. */
  readonly report?: PanelSemanticReport;
  /** The typed error behind this rejection, carrying the same code, message and hint. */
  readonly error: DebuggenError;
}

/**
 * The outcome of semantic validation, in terms a caller can log without the
 * specification's contents.
 */
export interface PanelSemanticReport {
  /** The semantic validator's answer. Always `'valid'` on an accepted panel. */
  readonly outcome: SemanticValidationStatus;
  /**
   * What rejected the panel: the refutations of an `invalid` outcome, or the
   * undecided references of an `unverifiable` one. Empty on an accepted panel.
   */
  readonly issues: readonly SemanticIssue[];
  /**
   * Non-fatal notes: nodes whose evidence the capture does not hold, which
   * render their empty state, and metrics the capture could not measure, which
   * render as unavailable. Never a reason to reject a panel.
   */
  readonly warnings: readonly SemanticIssue[];
  /** Whether authoritative evidence resolvers were supplied to the check. */
  readonly resolversSupplied: boolean;
  /** How many distinct cited event ids the evidence store decided, when resolvers were supplied. */
  readonly resolvedEventIds?: number;
  /** How many distinct trace ids the evidence store decided, when resolvers were supplied. */
  readonly resolvedTraceIds?: number;
}

/** The `details` key that records which failure class an error belongs to. */
const FAILURE_CLASS_DETAIL_KEY = 'failureClass';

/** The `details` key holding the issue list of an error raised by the panel validators. */
const ISSUES_DETAIL_KEY = 'issues';

/** The `details` key the structured-output loop records its rejection reason under. */
const REASON_DETAIL_KEY = 'reason';

/** How deep {@link markedCause} follows an error's `cause` chain. */
const MAX_CAUSE_DEPTH = 4;

/** The dotted-path separator both upstream validators use. */
const PATH_SEPARATOR = '.';

/** The closed error-code vocabulary as a membership set. */
const ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(DEBUGGEN_ERROR_CODES);

/**
 * The failure class a code implies, for an error that carries neither a
 * structured-loop reason nor a class marker. Codes absent here imply nothing.
 */
const FAILURE_CLASS_BY_CODE: Readonly<Partial<Record<DebuggenErrorCode, PanelFailureClass>>> =
  Object.freeze({
    MODEL_OUTPUT_INVALID: 'authoring-schema',
    MODEL_UNAVAILABLE: 'provider',
    PANEL_INVALID: 'internal-schema',
    PANEL_SEMANTIC_INVALID: 'semantic',
  });

/** The next step for a normaliser that threw or produced no document. */
const NORMALIZE_HINT =
  "This is a product defect in the panel normaliser, not a model failure: the model's output had already satisfied the authoring schema, so re-prompting cannot help. Show the deterministic fallback panel for this capture and fix the normaliser.";

/** The next step for a failure nothing in the pipeline classified. */
const UNCLASSIFIED_HINT =
  'Treat this as a product defect: show the deterministic fallback panel for this capture and consult the service log for the underlying error.';

/** The next step when semantic validation ran without a resolver port. */
const MISSING_RESOLVER_HINT =
  "Semantic validation ran without an evidence resolver, so citations outside the capture summary's top-N sections could not be decided. Inject `evidence` (a PanelEvidenceResolverPort, such as the service's AnalysisFacts) into createPanelValidator. Until then the deterministic fallback panel is shown instead of a panel with unproven citations.";

/** The next step when the store was asked and left references undecided. */
const RESOLVER_DECLINED_HINT =
  'The evidence store was asked about every cited event and trace but left some undecided, which means its lookup failed; the service log records the resolver warning. The deterministic fallback panel is shown instead of a panel with unproven citations. Check that the session store is readable, then regenerate the panel.';

/** The next step when no summary was supplied and no summary port was injected. */
const MISSING_SUMMARY_PORT_HINT =
  'Pass the capture summary to semantic validation, or inject `captures` (a CaptureSummaryPort, such as the service AnalysisSummarizer) into createPanelValidator.';

/** The next step when the capture summary could not be loaded. */
const SUMMARY_UNAVAILABLE_HINT =
  'Check that the capture belongs to this session and that the session store is readable, then regenerate the panel.';

/** The next step when a panel, a summary and the requested scope disagree. */
const SCOPE_MISMATCH_HINT =
  'A generated panel is validated against the session and capture it was generated from. Pass the session and capture ids that normalisation used; this is a defect in the caller, not in the model output.';

/** The next step when the evidence resolvers could not be created. */
const RESOLVER_UNAVAILABLE_HINT =
  'The evidence store could not provide its resolvers, so no citation could be decided. Check that the session store is readable, then regenerate the panel.';

/** The next step when semantic validation itself failed unexpectedly. */
const SEMANTIC_FAILURE_HINT =
  'Semantic validation could not complete, so the panel is not shown as an answer. Show the deterministic fallback panel for this capture and consult the service log.';

/**
 * The issue codes this module raises itself, for a mismatch between the
 * requested scope and the documents under check. Closed, like every upstream
 * issue vocabulary.
 */
export const PANEL_SCOPE_ISSUE_CODES = Object.freeze([
  'panel_session_mismatch',
  'panel_capture_mismatch',
] as const);

/** One member of {@link PANEL_SCOPE_ISSUE_CODES}. */
export type PanelScopeIssueCode = (typeof PANEL_SCOPE_ISSUE_CODES)[number];

/** Joins a structured path into the dotted form every rejection issue uses. */
function joinPath(path: PanelNodePath): string {
  return path.map((segment) => String(segment)).join(PATH_SEPARATOR);
}

/**
 * Whether a value is an array, narrowing to `unknown` elements rather than the
 * `any[]` a bare `Array.isArray` yields.
 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Reads one own property of a value that may not be an object at all. */
function ownField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return Object.hasOwn(value, key) ? (value as Readonly<Record<string, unknown>>)[key] : undefined;
}

/** A `validate.ts` issue, flattened. */
function fromValidationIssue(issue: PanelValidationIssue): PanelRejectionIssue {
  return {
    path: joinPath(issue.path),
    code: issue.code,
    ...(issue.nodeType === undefined ? {} : { nodeType: issue.nodeType }),
  };
}

/** A `semantic.ts` issue, flattened. */
function fromSemanticIssue(issue: SemanticIssue): PanelRejectionIssue {
  return {
    path: joinPath(issue.path),
    code: issue.code,
    reason: issue.reason,
    ...(issue.nodeType === undefined ? {} : { nodeType: issue.nodeType }),
  };
}

/**
 * Reads the issue list an upstream panel error carries in `details.issues`,
 * keeping only well-formed `{ path, code }` entries and only catalogued node
 * types. Anything else is dropped rather than echoed.
 */
function issuesFromDetails(
  details: Readonly<Record<string, unknown>> | undefined,
): readonly PanelRejectionIssue[] {
  const reported = details?.[ISSUES_DETAIL_KEY];
  if (!isUnknownArray(reported)) {
    return [];
  }

  const issues: PanelRejectionIssue[] = [];
  for (const entry of reported) {
    const path = ownField(entry, 'path');
    const code = ownField(entry, 'code');
    if (typeof path !== 'string' || typeof code !== 'string') {
      continue;
    }
    const nodeType = ownField(entry, 'nodeType');
    issues.push({ path, code, ...(isKnownPanelNodeType(nodeType) ? { nodeType } : {}) });
  }
  return issues;
}

/** Issues rendered for an error's `details`: the flattened form, unchanged. */
function detailIssues(issues: readonly PanelRejectionIssue[]): readonly PanelRejectionIssue[] {
  return issues.map((issue) => ({ ...issue }));
}

/**
 * Re-raises an upstream error under a failure class: same code and message,
 * the class recorded in `details` beside the flattened issues, and the
 * original kept as `cause`.
 */
function markedError(
  failureClass: PanelFailureClass,
  error: DebuggenError,
  issues: readonly PanelRejectionIssue[],
  options?: {
    readonly hint?: string | undefined;
    readonly details?: Readonly<Record<string, unknown>> | undefined;
  },
): DebuggenError {
  const hint = options?.hint ?? error.hint;
  return new DebuggenError(error.code, error.message, {
    ...(hint === undefined ? {} : { hint }),
    details: {
      ...(error.details ?? {}),
      ...(options?.details ?? {}),
      [FAILURE_CLASS_DETAIL_KEY]: failureClass,
      issueCount: issues.length,
      [ISSUES_DETAIL_KEY]: detailIssues(issues),
    },
    cause: error,
  });
}

/** Assembles a rejection from the error behind it. */
function makeRejection(
  failureClass: PanelFailureClass,
  error: DebuggenError,
  extras?: {
    readonly issues?: readonly PanelRejectionIssue[];
    readonly report?: PanelSemanticReport;
  },
): PanelValidationRejection {
  const issues = extras?.issues;
  const report = extras?.report;
  return Object.freeze({
    class: failureClass,
    code: error.code,
    message: error.message,
    ...(error.hint === undefined ? {} : { hint: error.hint }),
    ...(issues === undefined || issues.length === 0 ? {} : { issues }),
    ...(report === undefined ? {} : { report }),
    error,
  });
}

/**
 * Whether a value is already a {@link PanelValidationRejection}, so
 * {@link classifyFailure} returns it unchanged rather than re-classifying it.
 */
function isPanelValidationRejection(value: unknown): value is PanelValidationRejection {
  const code = ownField(value, 'code');
  return (
    isPanelFailureClass(ownField(value, 'class')) &&
    typeof code === 'string' &&
    ERROR_CODE_SET.has(code) &&
    typeof ownField(value, 'message') === 'string' &&
    DebuggenError.is(ownField(value, 'error'))
  );
}

/* -------------------------------------------------------------------------------------------------
 * Step 3: syntactic validation
 * ---------------------------------------------------------------------------------------------- */

/**
 * The issues of a rejected document, by path and code.
 *
 * A document that parses against the internal schema but breaks its
 * whole-document rules is re-checked with `collectPanelSpecIssues`, which
 * reports every issue at once with its structured path and catalogued node
 * type. A document that does not parse cannot be walked, so the schema issues
 * `validatePanelSpec` already reduced to paths and codes are read from its
 * error instead.
 */
function specIssuesFor(value: unknown, error: DebuggenError): readonly PanelRejectionIssue[] {
  const parsed = parsePanelSpec(value);
  if (parsed.ok) {
    const collected = collectPanelSpecIssues(parsed.value);
    if (collected.length > 0) {
      return collected.map(fromValidationIssue);
    }
  }
  return issuesFromDetails(error.details);
}

/**
 * Validates a normalised panel document syntactically: step 3 of the pipeline.
 *
 * Delegates entirely to `@debuggen/panel-schema`'s `validatePanelSpec`, which
 * already enforces the node catalog — uncatalogued node types, query presence
 * and allowed sources per node type, metric ids from the fixed vocabulary,
 * children only on containers, unique node ids and the `supersedes` rules.
 * Nothing about node types, sources or metric ids is restated here.
 *
 * A failure is classified `internal-schema`: whatever reaches this step came
 * out of the deterministic normaliser, so it is a product bug, never retried
 * against the model (AAP 0.5.3).
 *
 * @param value The value believed to be a normalised panel specification.
 * @returns `ok` with the parsed specification, or the `internal-schema`
 * rejection carrying every issue by path and code.
 */
export function validateSpec(value: unknown): Result<PanelSpec, PanelValidationRejection> {
  const validated = validatePanelSpec(value);
  if (validated.ok) {
    return ok(validated.value);
  }

  const issues = specIssuesFor(value, validated.error);
  return err(
    makeRejection('internal-schema', markedError('internal-schema', validated.error, issues), {
      issues,
    }),
  );
}

/* -------------------------------------------------------------------------------------------------
 * Step 2 → 3: the normaliser callback of the structured-output loop
 * ---------------------------------------------------------------------------------------------- */

/**
 * The callback `generate.ts` passes as `StructuredOptions.normalize` to
 * `generateStructuredWithRepair`, typed from that contract.
 */
export type PanelStructuredNormalizer = NonNullable<
  StructuredOptions<PanelSpecInput, PanelSpec>['normalize']
>;

/** How a normalisation failed before its output could be validated. */
type NormalizeFailure =
  { readonly kind: 'threw'; readonly thrown: unknown } | { readonly kind: 'no-document' };

/**
 * The error thrown for a normaliser that threw or produced no document. The
 * normaliser's own error is kept only as the `cause`: its message is never
 * repeated in this one.
 */
function normalizeFailureError(failure: NormalizeFailure): DebuggenError {
  if (failure.kind === 'no-document') {
    return new DebuggenError(
      'INTERNAL',
      'The panel normaliser returned a value that is not a panel document.',
      { hint: NORMALIZE_HINT, details: { [FAILURE_CLASS_DETAIL_KEY]: 'normalize' } },
    );
  }

  const cause = DebuggenError.from(failure.thrown);
  return new DebuggenError(
    'INTERNAL',
    'The panel normaliser threw on input the authoring schema had accepted.',
    {
      hint: NORMALIZE_HINT,
      details: { [FAILURE_CLASS_DETAIL_KEY]: 'normalize', causeCode: cause.code },
      cause,
    },
  );
}

/**
 * Builds the normalise-then-validate callback for one generation: it runs
 * `normalizePanel(input, analysis, context)` and then {@link validateSpec}, and
 * returns the parsed internal document.
 *
 * ## Why a failure here is a throw, not a returned `Result`
 *
 * This is the one deliberate exception to this module's never-throw rule, and
 * the inversion is load-bearing. `generateStructuredWithRepair` treats a
 * `normalize` callback that **throws** as a product bug: it logs the parsed
 * input, rejects with `details.reason = 'normalize'` after exactly one provider
 * call, and **never re-prompts** — which is what AAP 0.5.3 requires of a
 * normaliser or internal-schema failure, since an identical second answer would
 * fail identically. A callback that instead *returned* a failure value would be
 * accepted as a successful normalisation. Do not "fix" this into a `Result`:
 * doing so either ships an invalid panel or, once someone adds a retry around
 * it, silently re-prompts the model for a product bug.
 *
 * The thrown `DebuggenError` records its failure class in
 * `details.failureClass` — `normalize` when `normalizePanel` threw or produced
 * no document, `internal-schema` (code `PANEL_INVALID`, with every issue by
 * path and code) when the document failed {@link validateSpec} — and
 * {@link classifyFailure} reads that marker back off the loop's rejection
 * `cause` to report the precise class.
 *
 * @param analysis The validated analysis: the sole source of the panel's
 * observed facts and likely causes. `AnalysisResult` satisfies it.
 * @param context The panel's identifiers and provenance.
 * @returns The callback for `StructuredOptions.normalize`.
 */
export function buildStructuredOptionsNormalizer(
  analysis: NormalizeAnalysis,
  context: NormalizeContext,
): PanelStructuredNormalizer {
  return createNormalizer(analysis, context, undefined);
}

/**
 * The normaliser callback, with an optional observer told about each rejection
 * before it is thrown (the validator's logging hook).
 */
function createNormalizer(
  analysis: NormalizeAnalysis,
  context: NormalizeContext,
  onRejected: ((rejection: PanelValidationRejection) => void) | undefined,
): PanelStructuredNormalizer {
  return (input: PanelSpecInput): PanelSpec => {
    let produced: unknown;
    try {
      produced = normalizePanel(input, analysis, context);
    } catch (thrown) {
      const error = normalizeFailureError({ kind: 'threw', thrown });
      onRejected?.(makeRejection('normalize', error));
      throw error;
    }

    if (typeof produced !== 'object' || produced === null) {
      const error = normalizeFailureError({ kind: 'no-document' });
      onRejected?.(makeRejection('normalize', error));
      throw error;
    }

    const validated = validateSpec(produced);
    if (!validated.ok) {
      onRejected?.(validated.error);
      // Thrown, not returned: see this function's documentation.
      throw validated.error.error;
    }
    return validated.value;
  };
}

/* -------------------------------------------------------------------------------------------------
 * Classification of anything the pipeline catches
 * ---------------------------------------------------------------------------------------------- */

/**
 * The first error along a `cause` chain that records its own failure class —
 * the thrown signal of the normaliser callback, inside the structured loop's
 * rejection.
 */
function markedCause(
  error: DebuggenError,
): { readonly error: DebuggenError; readonly failureClass: PanelFailureClass } | undefined {
  let current: unknown = error.cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && DebuggenError.is(current); depth += 1) {
    const marker = current.details?.[FAILURE_CLASS_DETAIL_KEY];
    if (isPanelFailureClass(marker)) {
      return { error: current, failureClass: marker };
    }
    current = current.cause;
  }
  return undefined;
}

/**
 * Normalises anything the panel pipeline catches into a
 * {@link PanelValidationRejection}. Never throws.
 *
 * In order of authority:
 *
 * 1. a value that is already a rejection is returned unchanged;
 * 2. a `generateStructuredWithRepair` rejection is classified by its
 *    `details.reason` through {@link classifyStructuredRejection}. A
 *    `normalize` reason is refined by the class marker the normaliser callback
 *    recorded on the thrown `cause`, so a document that failed the internal
 *    schema reports `internal-schema` with its issues. A `provider` rejection
 *    passes through verbatim: its code, message and hint are the provider's;
 * 3. an error recording its own class in `details.failureClass` keeps it;
 * 4. an error whose code implies a class — `MODEL_OUTPUT_INVALID`,
 *    `MODEL_UNAVAILABLE`, `PANEL_INVALID`, `PANEL_SEMANTIC_INVALID` — takes it;
 * 5. anything else is a defect no step claims, classified `normalize` (a
 *    product bug, never repairable) under a fixed message: a foreign error's
 *    own message is kept only as the `cause`, never repeated.
 *
 * @param failure Whatever was caught: a `DebuggenError`, a rejection, a
 * native error or any thrown value.
 * @returns The rejection, whose `code` is always a member of `DEBUGGEN_ERROR_CODES`.
 */
export function classifyFailure(failure: unknown): PanelValidationRejection {
  if (isPanelValidationRejection(failure)) {
    return failure;
  }

  const error = DebuggenError.from(failure);
  const reason = error.details?.[REASON_DETAIL_KEY];

  if (isStructuredRejectionReason(reason)) {
    const failureClass = classifyStructuredRejection(reason);
    if (failureClass === 'provider') {
      return makeRejection('provider', error);
    }
    if (failureClass === 'normalize') {
      const refined = markedCause(error);
      if (refined !== undefined) {
        return makeRejection(refined.failureClass, refined.error, {
          issues: issuesFromDetails(refined.error.details),
        });
      }
    }
    return makeRejection(failureClass, error);
  }

  const marker = error.details?.[FAILURE_CLASS_DETAIL_KEY];
  if (isPanelFailureClass(marker)) {
    return makeRejection(marker, error, { issues: issuesFromDetails(error.details) });
  }

  const implied = FAILURE_CLASS_BY_CODE[error.code];
  if (implied !== undefined) {
    const issues = issuesFromDetails(error.details);
    return makeRejection(implied, markedError(implied, error, issues), { issues });
  }

  return makeRejection(
    'normalize',
    new DebuggenError(error.code, 'An unclassified failure interrupted panel generation.', {
      hint: UNCLASSIFIED_HINT,
      details: { [FAILURE_CLASS_DETAIL_KEY]: 'normalize', causeCode: error.code },
      cause: error,
    }),
  );
}

/* -------------------------------------------------------------------------------------------------
 * Ports and dependencies
 * ---------------------------------------------------------------------------------------------- */

/**
 * The evidence lookups semantic validation needs, declared on the consumer
 * side so this module depends on nothing more.
 *
 * Satisfied structurally by the service's `AnalysisFacts`
 * ({@link AnalysisFactsSatisfiesEvidenceResolverPort}), whose resolvers are
 * backed by `TelemetryRepo.existingEventIds`/`existingTraceIds` over the
 * `telemetry_events` table. Existence is never re-implemented here: that one
 * lookup is the product's single definition of "does this event exist".
 */
export interface PanelEvidenceResolverPort {
  /**
   * The resolver pair for one session's capture, shaped for
   * `SemanticValidationOptions`.
   */
  createEvidenceResolvers(
    sessionId: SessionId,
    captureId?: CaptureId,
  ): {
    readonly resolveEventIds: NonNullable<SemanticValidationOptions['resolveEventIds']>;
    readonly resolveTraceIds: NonNullable<SemanticValidationOptions['resolveTraceIds']>;
  };
}

/**
 * The capture-summary loader semantic validation reads when a caller does not
 * supply the summary: the service's `AnalysisSummarizer`, which answers with
 * the stored `CaptureRecord.summary` first and a recomputed one otherwise.
 */
export type CaptureSummaryPort = Pick<AnalysisSummarizer, 'loadCaptureSummary'>;

/** Injected dependencies of {@link createPanelValidator}. Every one is optional. */
export interface PanelValidatorDeps {
  /**
   * Authoritative evidence lookups. Without them a citation outside the
   * summary's top-N sections cannot be decided, and such a panel is rejected.
   */
  readonly evidence?: PanelEvidenceResolverPort | undefined;
  /** Loads a capture's summary when a call does not supply one. */
  readonly captures?: CaptureSummaryPort | undefined;
  /** Logger; records are bound to the `panels` subsystem and the session. */
  readonly logger?: Logger | undefined;
  /**
   * Whether a node whose evidence the capture does not hold rejects a panel,
   * as `SemanticValidationOptions.requireVerifiable` escalates it. Defaults to
   * `false`: such a node renders its empty state, which is designed behaviour
   * (AAP 0.6.2). An unmeasured metric never rejects a panel under any setting,
   * and an undecided reference always does.
   */
  readonly requireVerifiable?: boolean | undefined;
}

/** The session, and optionally the capture, a validation belongs to (for logging). */
export interface PanelValidationScope {
  /** The session the panel was generated for. */
  readonly sessionId: SessionId;
  /** The capture it was generated from. */
  readonly captureId?: CaptureId | undefined;
}

/** Input of {@link PanelValidator.validateSemantics}. */
export interface ValidateSemanticsInput {
  /** A specification that passed {@link validateSpec}. */
  readonly spec: PanelSpec;
  /** The session the panel was generated for; the panel must name it. */
  readonly sessionId: SessionId;
  /** The capture the panel describes. */
  readonly captureId: CaptureId;
  /** The capture's summary; loaded through {@link PanelValidatorDeps.captures} when absent. */
  readonly summary?: CaptureSummary | undefined;
  /** Overrides {@link PanelValidatorDeps.requireVerifiable} for this call. */
  readonly requireVerifiable?: boolean | undefined;
}

/** Input of {@link PanelValidator.validateGenerated}. */
export interface ValidateGeneratedInput extends Omit<ValidateSemanticsInput, 'spec'> {
  /** The normalised document, not yet validated. */
  readonly spec: unknown;
}

/** An accepted panel: the parsed document and the report of the check it passed. */
export interface ValidatedPanel {
  /** The parsed, validated specification — the one to store and broadcast. */
  readonly spec: PanelSpec;
  /** What semantic validation found, including its non-fatal warnings. */
  readonly report: PanelSemanticReport;
}

/** The panel validation boundary. See the module documentation. */
export interface PanelValidator {
  /**
   * Step 3: {@link validateSpec}, logging a rejection under `scope`.
   */
  validateSpec(
    value: unknown,
    scope?: PanelValidationScope,
  ): Result<PanelSpec, PanelValidationRejection>;

  /**
   * Step 4: validates a specification against the capture it describes, with
   * the store-backed resolvers, and decides the outcome: `valid` is accepted;
   * `invalid` and `unverifiable` are rejected, classified `semantic`. Warnings
   * never reject.
   */
  validateSemantics(
    input: ValidateSemanticsInput,
  ): Promise<Result<PanelSemanticReport, PanelValidationRejection>>;

  /**
   * Steps 3 and 4 together, short-circuiting on the first failure: the single
   * call `generate.ts` makes after normalisation.
   */
  validateGenerated(
    input: ValidateGeneratedInput,
  ): Promise<Result<ValidatedPanel, PanelValidationRejection>>;

  /**
   * {@link buildStructuredOptionsNormalizer}, logging each rejection before it
   * is thrown. The callback throws by design; see that function.
   */
  buildStructuredOptionsNormalizer(
    analysis: NormalizeAnalysis,
    context: NormalizeContext,
  ): PanelStructuredNormalizer;

  /** {@link classifyFailure}. */
  classifyFailure(failure: unknown): PanelValidationRejection;
}

/* -------------------------------------------------------------------------------------------------
 * Semantic validation internals
 * ---------------------------------------------------------------------------------------------- */

/** The `subsystem` binding of this module's logger. */
const SUBSYSTEM = 'panels';

/** How many issue paths one log record names. */
const MAX_LOGGED_ISSUES = 20;

/** An id resolver, as `SemanticValidationOptions` declares both of them. */
type IdResolver = (ids: readonly string[]) => IdResolution;

/** How many distinct ids one resolver decided. Mutable, per validation. */
interface ResolverTally {
  decided: number;
}

/** The resolver pair of one validation, memoised and counted. */
interface InstrumentedResolvers {
  readonly resolveEventIds: IdResolver;
  readonly resolveTraceIds: IdResolver;
  readonly events: ResolverTally;
  readonly traces: ResolverTally;
}

/** A resolver answer that decides nothing: how a lookup that failed is reported. */
function declinedResolution(): IdResolution {
  return { known: new Set<string>(), unknown: new Set<string>() };
}

/** The size of a set in a resolver answer, read defensively. */
function sizeOf(value: unknown): number {
  return value instanceof Set ? value.size : 0;
}

/**
 * Wraps a resolver so that one validation asks the store **once** per id list.
 *
 * The outcome (`validateAgainstCapture`) and the report's warnings
 * (`collectSemanticIssues`) are two upstream calls over the same specification
 * and summary, each of which consults the resolvers with the same distinct id
 * list. Memoising the answer keeps it to one lookup and — more importantly —
 * guarantees both calls see the same answer, so the outcome and its report
 * cannot disagree. A resolver that throws is recorded as having declined, which
 * is exactly how the semantic validator reads a throwing resolver.
 */
function memoizedResolver(resolve: IdResolver, tally: ResolverTally): IdResolver {
  let memo: { readonly key: string; readonly answer: IdResolution } | undefined;

  return (ids: readonly string[]): IdResolution => {
    const key = JSON.stringify(ids);
    if (memo !== undefined && memo.key === key) {
      return memo.answer;
    }

    let answer: IdResolution;
    try {
      answer = resolve(ids);
      tally.decided = sizeOf(answer.known) + sizeOf(answer.unknown);
    } catch {
      // Deliberately unbound: the failure is a declined answer, which the
      // semantic validator reports as undecided rather than as a verdict.
      answer = declinedResolution();
      tally.decided = 0;
    }
    memo = { key, answer };
    return answer;
  };
}

/** What one semantic evaluation produced. */
interface SemanticEvaluation {
  readonly outcome: SemanticValidationOutcome;
  readonly report: PanelSemanticReport;
}

/**
 * Runs the semantic validator and builds its report.
 *
 * The outcome is `validateAgainstCapture`'s, unchanged: the composition rule
 * lives upstream. The warnings are the `advisory` notes (a node with no
 * evidence, which renders its empty state) and the `informational` notes (a
 * metric the capture could not measure, which renders as unavailable) of
 * `collectSemanticIssues` — neither ever becomes a rejection here. Under
 * `requireVerifiable` the advisory notes are escalated upstream into the
 * outcome's issues, so only the informational ones remain warnings.
 */
function evaluateSemantics(
  spec: PanelSpec,
  summary: CaptureSummary,
  resolvers: InstrumentedResolvers | undefined,
  requireVerifiable: boolean,
): SemanticEvaluation {
  const options: SemanticValidationOptions =
    resolvers === undefined
      ? { requireVerifiable }
      : toSemanticValidationOptions(resolvers, { requireVerifiable });

  const outcome = validateAgainstCapture(spec, summary, options);
  const sets = collectSemanticIssues(spec, summary, options);

  const issues =
    outcome.status === 'invalid'
      ? outcome.issues
      : outcome.status === 'unverifiable'
        ? outcome.unverifiable
        : [];
  const warnings = requireVerifiable
    ? sets.informational
    : [...sets.advisory, ...sets.informational];

  const report: PanelSemanticReport = Object.freeze({
    outcome: outcome.status,
    issues,
    warnings,
    resolversSupplied: resolvers !== undefined,
    ...(resolvers === undefined
      ? {}
      : { resolvedEventIds: resolvers.events.decided, resolvedTraceIds: resolvers.traces.decided }),
  });

  return { outcome, report };
}

/**
 * The rejection for an outcome that is not `valid`.
 *
 * The message and the evidence hint are the semantic validator's own (through
 * `toResult`, which renders paths and codes only). An `unverifiable` outcome
 * gets the hint that names its actual cause instead: a missing resolver port,
 * or a store that declined to answer.
 */
function semanticRejectionFor(
  spec: PanelSpec,
  evaluation: SemanticEvaluation,
): PanelValidationRejection {
  const { outcome, report } = evaluation;
  const mapped = toResult(outcome, spec, { requireVerifiable: true });
  const base = mapped.ok
    ? new DebuggenError(
        PANEL_FAILURE_POLICY.semantic.defaultCode,
        'A generated panel failed semantic validation against its capture.',
      )
    : mapped.error;

  const hint =
    outcome.status === 'unverifiable'
      ? report.resolversSupplied
        ? RESOLVER_DECLINED_HINT
        : MISSING_RESOLVER_HINT
      : undefined;

  const issues = report.issues.map(fromSemanticIssue);
  const error = markedError('semantic', base, issues, {
    hint,
    details: {
      outcome: report.outcome,
      warningCount: report.warnings.length,
      resolversSupplied: report.resolversSupplied,
      ...(report.resolvedEventIds === undefined
        ? {}
        : { resolvedEventIds: report.resolvedEventIds }),
      ...(report.resolvedTraceIds === undefined
        ? {}
        : { resolvedTraceIds: report.resolvedTraceIds }),
    },
  });

  return makeRejection('semantic', error, { issues, report });
}

/** Renders issues for a message: dotted paths with their codes, bounded. */
function renderIssueList(issues: readonly PanelRejectionIssue[]): string {
  return issues
    .slice(0, MAX_LOGGED_ISSUES)
    .map((issue) => `${issue.path} (${issue.code})`)
    .join(', ');
}

/**
 * The `semantic` rejection for documents that disagree with the requested
 * scope: a panel naming another session, or a summary of another capture.
 */
function scopeRejection(issues: readonly PanelRejectionIssue[]): PanelValidationRejection {
  const error = new DebuggenError(
    'SESSION_INVALID_STATE',
    `A generated panel was checked against a scope it does not belong to: ${renderIssueList(issues)}.`,
    {
      hint: SCOPE_MISMATCH_HINT,
      details: {
        [FAILURE_CLASS_DETAIL_KEY]: 'semantic',
        issueCount: issues.length,
        [ISSUES_DETAIL_KEY]: detailIssues(issues),
      },
    },
  );
  return makeRejection('semantic', error, { issues });
}

/** One scope issue, at the field of the document that disagrees. */
function scopeIssue(path: string, code: PanelScopeIssueCode): PanelRejectionIssue {
  return { path, code };
}

/** The scope issues of a panel: it must name the session it is validated for. */
function specScopeIssues(spec: PanelSpec, sessionId: SessionId): readonly PanelRejectionIssue[] {
  return ownField(spec, 'sessionId') === sessionId
    ? []
    : [scopeIssue('sessionId', 'panel_session_mismatch')];
}

/** The scope issues of a summary: it must describe the requested capture of the session. */
function summaryScopeIssues(
  summary: CaptureSummary,
  sessionId: SessionId,
  captureId: CaptureId,
): readonly PanelRejectionIssue[] {
  const issues: PanelRejectionIssue[] = [];
  if (ownField(summary, 'captureId') !== captureId) {
    issues.push(scopeIssue('summary.captureId', 'panel_capture_mismatch'));
  }
  const summarySession = ownField(summary, 'sessionId');
  if (summarySession !== undefined && summarySession !== sessionId) {
    issues.push(scopeIssue('summary.sessionId', 'panel_session_mismatch'));
  }
  return issues;
}

/** The `semantic` rejection for a check that could not run to completion. */
function semanticFailure(
  code: DebuggenErrorCode,
  message: string,
  hint: string,
  cause: DebuggenError | undefined,
): PanelValidationRejection {
  return makeRejection(
    'semantic',
    new DebuggenError(code, message, {
      hint,
      details: {
        [FAILURE_CLASS_DETAIL_KEY]: 'semantic',
        ...(cause === undefined ? {} : { causeCode: cause.code }),
      },
      ...(cause === undefined ? {} : { cause }),
    }),
  );
}

/** The fields a rejection is logged with: class, code and issue paths and codes only. */
function rejectionFields(rejection: PanelValidationRejection): LogFields {
  const issues = rejection.issues ?? [];
  return {
    failureClass: rejection.class,
    code: rejection.code,
    issueCount: issues.length,
    issuePaths: issues.slice(0, MAX_LOGGED_ISSUES).map((issue) => issue.path),
    issueCodes: [...new Set(issues.map((issue) => issue.code))].slice(0, MAX_LOGGED_ISSUES),
    ...(rejection.report === undefined
      ? {}
      : {
          outcome: rejection.report.outcome,
          resolversSupplied: rejection.report.resolversSupplied,
        }),
  };
}

/* -------------------------------------------------------------------------------------------------
 * The validator
 * ---------------------------------------------------------------------------------------------- */

/**
 * Creates the panel validation boundary over its injected ports.
 *
 * Holds no state between calls and no module-level singleton: every call reads
 * the summary and the evidence through the injected ports, so the service can
 * run in-process with the deterministic provider in the integration suites.
 *
 * @param deps The evidence resolver port, the capture-summary port, a logger
 * and the strictness default. All optional.
 * @returns The validator.
 */
export function createPanelValidator(deps: PanelValidatorDeps = {}): PanelValidator {
  const log = subsystemLogger(deps.logger ?? noopLogger, SUBSYSTEM);
  const defaultRequireVerifiable = deps.requireVerifiable ?? false;

  const scopedLog = (scope: PanelValidationScope | undefined): Logger =>
    scope === undefined ? log : sessionLogger(log, scope.sessionId, scope.captureId);

  const validateSpecLogged = (
    value: unknown,
    scope?: PanelValidationScope,
  ): Result<PanelSpec, PanelValidationRejection> => {
    const validated = validateSpec(value);
    if (!validated.ok) {
      scopedLog(scope).warn(
        'A panel specification was rejected by internal validation; it is a product defect and is not retried against the model.',
        rejectionFields(validated.error),
      );
    }
    return validated;
  };

  /** The summary to check against: the one supplied, or the one the port loads. */
  const summaryFor = async (
    input: ValidateSemanticsInput,
  ): Promise<Result<CaptureSummary, PanelValidationRejection>> => {
    if (input.summary !== undefined) {
      return ok(input.summary);
    }

    const captures = deps.captures;
    if (captures === undefined) {
      return err(
        semanticFailure(
          'INTERNAL',
          'Semantic validation received no capture summary and has no port to load one.',
          MISSING_SUMMARY_PORT_HINT,
          undefined,
        ),
      );
    }

    let loaded: Result<CaptureSummary, DebuggenError>;
    try {
      loaded = await captures.loadCaptureSummary(input.sessionId, input.captureId);
    } catch (thrown) {
      loaded = err(DebuggenError.from(thrown, 'STORE_ERROR'));
    }
    if (loaded.ok) {
      return ok(loaded.value);
    }
    return err(
      semanticFailure(
        loaded.error.code,
        'The capture summary a generated panel is checked against could not be loaded.',
        loaded.error.hint ?? SUMMARY_UNAVAILABLE_HINT,
        loaded.error,
      ),
    );
  };

  /** The memoised, counted resolver pair, or `undefined` when no port was injected. */
  const resolversFor = (
    sessionId: SessionId,
    captureId: CaptureId,
  ): Result<InstrumentedResolvers | undefined, PanelValidationRejection> => {
    const evidence = deps.evidence;
    if (evidence === undefined) {
      return ok(undefined);
    }

    try {
      const created = evidence.createEvidenceResolvers(sessionId, captureId);
      const events: ResolverTally = { decided: 0 };
      const traces: ResolverTally = { decided: 0 };
      return ok({
        resolveEventIds: memoizedResolver(created.resolveEventIds, events),
        resolveTraceIds: memoizedResolver(created.resolveTraceIds, traces),
        events,
        traces,
      });
    } catch (thrown) {
      const cause = DebuggenError.from(thrown, 'STORE_ERROR');
      return err(
        semanticFailure(
          cause.code,
          'The evidence resolvers for semantic validation could not be created.',
          RESOLVER_UNAVAILABLE_HINT,
          cause,
        ),
      );
    }
  };

  /** The body of semantic validation; the caller converts a throw into a rejection. */
  const runSemantics = async (
    input: ValidateSemanticsInput,
    sessionLog: Logger,
  ): Promise<Result<PanelSemanticReport, PanelValidationRejection>> => {
    const { spec, sessionId, captureId } = input;
    const requireVerifiable = input.requireVerifiable ?? defaultRequireVerifiable;

    const reject = (
      message: string,
      rejection: PanelValidationRejection,
    ): Result<PanelSemanticReport, PanelValidationRejection> => {
      sessionLog.warn(message, rejectionFields(rejection));
      return err(rejection);
    };

    const specIssues = specScopeIssues(spec, sessionId);
    if (specIssues.length > 0) {
      return reject(
        'A generated panel names a different session than the one it is validated for.',
        scopeRejection(specIssues),
      );
    }

    const summary = await summaryFor(input);
    if (!summary.ok) {
      return reject(
        'A generated panel could not be checked: its capture summary is unavailable.',
        summary.error,
      );
    }

    const summaryIssues = summaryScopeIssues(summary.value, sessionId, captureId);
    if (summaryIssues.length > 0) {
      return reject(
        'A generated panel was checked against the summary of a different capture.',
        scopeRejection(summaryIssues),
      );
    }

    const resolvers = resolversFor(sessionId, captureId);
    if (!resolvers.ok) {
      return reject(
        'A generated panel could not be checked: the evidence resolvers are unavailable.',
        resolvers.error,
      );
    }

    const evaluation = evaluateSemantics(spec, summary.value, resolvers.value, requireVerifiable);
    const { report } = evaluation;

    if (report.outcome === 'valid') {
      sessionLog.debug('A generated panel passed semantic validation.', {
        warningCount: report.warnings.length,
        warningCodes: [...new Set(report.warnings.map((warning) => warning.code))],
        resolversSupplied: report.resolversSupplied,
        ...(report.resolvedEventIds === undefined
          ? {}
          : { resolvedEventIds: report.resolvedEventIds }),
        ...(report.resolvedTraceIds === undefined
          ? {}
          : { resolvedTraceIds: report.resolvedTraceIds }),
      });
      return ok(report);
    }

    const rejection = semanticRejectionFor(spec, evaluation);
    if (report.outcome === 'unverifiable' && report.resolversSupplied) {
      // With authoritative resolvers supplied, every reference should have been
      // decided. One that was not means a resolver declined — its lookup
      // failed — which is a product-integrity signal, not a routine outcome.
      return reject(
        'An evidence resolver left generated-panel references undecided; the panel is rejected rather than accepted with unproven citations.',
        rejection,
      );
    }
    return reject('A generated panel was rejected by semantic validation.', rejection);
  };

  const validateSemantics = async (
    input: ValidateSemanticsInput,
  ): Promise<Result<PanelSemanticReport, PanelValidationRejection>> => {
    const sessionLog = sessionLogger(log, input.sessionId, input.captureId);
    try {
      return await runSemantics(input, sessionLog);
    } catch (thrown) {
      const cause = DebuggenError.from(thrown);
      const rejection = semanticFailure(
        cause.code,
        'Semantic validation of a generated panel could not complete.',
        SEMANTIC_FAILURE_HINT,
        cause,
      );
      sessionLog.warn(
        'Semantic validation of a generated panel failed unexpectedly; the panel is rejected.',
        rejectionFields(rejection),
      );
      return err(rejection);
    }
  };

  const validateGenerated = async (
    input: ValidateGeneratedInput,
  ): Promise<Result<ValidatedPanel, PanelValidationRejection>> => {
    const validated = validateSpecLogged(input.spec, {
      sessionId: input.sessionId,
      captureId: input.captureId,
    });
    if (!validated.ok) {
      return err(validated.error);
    }

    const semantics = await validateSemantics({
      spec: validated.value,
      sessionId: input.sessionId,
      captureId: input.captureId,
      summary: input.summary,
      requireVerifiable: input.requireVerifiable,
    });
    if (!semantics.ok) {
      return err(semantics.error);
    }

    return ok(Object.freeze({ spec: validated.value, report: semantics.value }));
  };

  const buildNormalizerLogged = (
    analysis: NormalizeAnalysis,
    context: NormalizeContext,
  ): PanelStructuredNormalizer => {
    const sessionLog = sessionLogger(log, context.sessionId);
    return createNormalizer(analysis, context, (rejection) => {
      sessionLog.warn(
        'A generated panel failed normalisation or internal validation; it is rejected without re-prompting the model.',
        rejectionFields(rejection),
      );
    });
  };

  return Object.freeze({
    validateSpec: validateSpecLogged,
    validateSemantics,
    validateGenerated,
    buildStructuredOptionsNormalizer: buildNormalizerLogged,
    classifyFailure,
  });
}

/* -------------------------------------------------------------------------------------------------
 * Compile-time contract assertions
 * ---------------------------------------------------------------------------------------------- */

/** Fails to compile unless `T` is exactly `true`. */
type AssertTrue<T extends true> = T;

/** The service's `AnalysisFacts` still satisfies {@link PanelEvidenceResolverPort}. */
export type AnalysisFactsSatisfiesEvidenceResolverPort = AssertTrue<
  AnalysisFacts extends PanelEvidenceResolverPort ? true : false
>;

/** A validated `AnalysisResult` is still an analysis `normalizePanel` accepts. */
export type AnalysisResultSatisfiesNormalizeAnalysis = AssertTrue<
  AnalysisResult extends NormalizeAnalysis ? true : false
>;
