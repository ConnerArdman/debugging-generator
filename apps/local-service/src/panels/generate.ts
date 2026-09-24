/**
 * Stage 6 of the reasoning pipeline — UI generation — and the top of the panel
 * subsystem: the one module through which a panel reaches the store and the two
 * user interfaces.
 *
 * AAP 0.5.3 fixes what may happen to a model's panel before it can affect the
 * screen, and this module is where that sequence is driven. The order never
 * varies:
 *
 * 1. **authoring schema** — the model's structured output is parsed against
 *    `panelSpecInputSchema` by `@debuggen/model-provider`'s
 *    `generateStructuredWithRepair`, with the bounded repair of
 *    `DEFAULT_MAX_REPAIRS`. That helper is the product's single repair policy;
 *    this module calls it exactly once per generation and never loops around it;
 * 2. **deterministic normaliser** — `normalizePanel`, run once through the
 *    callback `./validate.js` builds (`buildStructuredOptionsNormalizer`);
 * 3. **internal schema** — `validatePanelSpec`, inside that same callback. The
 *    callback *throws* on a normaliser or internal-schema failure, and that
 *    inversion is load-bearing: `structured.ts` treats a throwing normaliser as
 *    a product bug, logs it with the input and rejects it after exactly one
 *    provider call, without re-prompting (AAP 0.5.3). Only an authoring-schema
 *    failure ever earns a repair;
 * 4. **semantic validation** — `./validate.js`'s `validateGenerated`, against
 *    the capture the panel claims to describe.
 *
 * A panel that fails any step is never shown as an answer and never leaves the
 * developer at a dead end: the rejection is classified by `./validate.js`,
 * logged with its class and issue paths (never as analysis, AAP 0.5.5), and —
 * where `PANEL_FAILURE_POLICY` says so — replaced by the deterministic fallback
 * of `./fallback.js`, which carries `meta.fallback = true` and is stored and
 * broadcast through exactly the same path. A provider failure is not a panel
 * problem: its error passes through unchanged, so the developer reads "Model
 * provider unavailable (‹code›)" and the session fails at this stage.
 *
 * ## Ownership boundary with `pipeline/stages/generate-panel.ts`
 *
 * **This module owns**: prompt selection (the manifest's current version, or
 * the version a session recorded) and rendering; the provider call with its
 * bounded repair; normalisation and validation; fallback substitution;
 * persistence through `PanelsRepo`; and the `panel.generated` broadcast.
 *
 * **The stage owns**: gathering the stage inputs (the validated analysis and
 * the capture id), emitting the `session.progress` rows of `generate-panel`
 * (which `sessions/progress.ts` owns), and asking `SessionManager` for the
 * status transition. This module writes no session status and emits no
 * progress row: `state-machine.ts` permits `generated` only once a validated
 * analysis and a validated panel both exist, and the stage supplies that guard
 * context from the {@link PanelGenerationResult} returned here.
 *
 * ## The prompt lives in a file, never here
 *
 * The instructions are `apps/local-service/prompts/generate-panel/vNNN.md`,
 * loaded through the injected `PromptLoader`. This module contributes data
 * only: the five placeholder values of {@link PANEL_PROMPT_PLACEHOLDERS} — the
 * developer's question, the validated analysis, the node catalog as
 * `describeCatalogForPrompt` renders it, a bounded capture overview, and the
 * authoring schema as `panelSpecInputJsonSchemaText` renders it.
 *
 * ## The dual payload
 *
 * Every request carries the rendered prompt and the structured context it was
 * rendered from ({@link buildPanelStageContext}): the rules-based deterministic
 * provider builds its answer from that context alone, and the outbound
 * redaction guard walks it field by field. Following the pipeline convention of
 * `pipeline/context-builder.ts`, the developer's question travels in the prompt
 * only — never in the structured context — so two questions that differ only in
 * wording give the same structured input (AAP 0.5.4). Nothing here compares,
 * searches or switches on the question text.
 *
 * ## Privacy
 *
 * No log record or error built here carries a prompt, a model output, a fact
 * statement or a captured value: only ids, versions, counts, closed-vocabulary
 * codes, catalogued node types and dotted issue paths (AAP 0.5.2).
 *
 * @example
 * ```ts
 * const generator = createPanelGenerator({
 *   provider,
 *   prompts,
 *   validator,
 *   fallback,
 *   panels,
 *   captures: summarizer,
 *   broadcaster: clients,
 *   logger,
 * });
 * const generated = await generator.generate({ sessionId, captureId, question, analysis });
 * if (generated.ok) {
 *   // generated.value.panel is stored and broadcast; hand it to SessionManager.transitionTo.
 * }
 * ```
 *
 * @module
 */

import {
  DEFAULT_MAX_REPAIRS,
  assertOutboundSafe,
  generateStructuredWithRepair,
  renderPrompt,
} from '@debuggen/model-provider';
import type {
  JsonObject,
  JsonValue,
  ModelProvider,
  ModelRequest,
  PromptFile,
  PromptLoader,
  PromptStage,
  PromptVersion,
  StructuredSuccess,
} from '@debuggen/model-provider';
import {
  DATA_QUERY_SOURCES,
  PANEL_NODE_CATALOG_ENTRIES,
  describeCatalogForPrompt,
  panelSpecInputJsonSchemaText,
  panelSpecInputSchema,
  walkPanelNodes,
} from '@debuggen/panel-schema';
import type {
  DataQuerySource,
  NormalizeContext,
  PanelNodeCatalogEntry,
  PanelNodeType,
  PanelSpec,
  PanelSpecInput,
} from '@debuggen/panel-schema';
import {
  createEnvelope,
  panelGeneratedPayloadSchema,
  parseAnalysisResult,
} from '@debuggen/protocol';
import type { AnalysisResult, ClientKind, ProgressStage } from '@debuggen/protocol';
import { DebuggenError, err, newPanelId, noopLogger, ok, tryCatch } from '@debuggen/shared';
import type {
  CaptureId,
  DebuggenErrorCode,
  LogFields,
  Logger,
  PanelId,
  Result,
  SessionId,
} from '@debuggen/shared';
import { DEFAULT_TOP_N, TELEMETRY_KINDS, TELEMETRY_TIERS } from '@debuggen/telemetry';
import type {
  CaptureSummary,
  ErrorSummary,
  MetricValue,
  QueryGroup,
  RenderStat,
  RequestGroup,
  SpanSummary,
  TelemetryKind,
} from '@debuggen/telemetry';

import { sessionLogger, subsystemLogger } from '../logging.js';
import type { SessionBroadcaster } from '../sessions/manager.js';
import type { PanelsRepo } from '../store/panels-repo.js';
import type { FallbackPanelBuilder } from './fallback.js';
import { PANEL_FAILURE_POLICY } from './validate.js';
import type {
  CaptureSummaryPort,
  PanelFailureClass,
  PanelSemanticReport,
  PanelValidationRejection,
  PanelValidator,
} from './validate.js';

/* -------------------------------------------------------------------------------------------------
 * Vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * The prompt stage this module renders, and the progress stage the calling
 * pipeline stage reports under.
 *
 * The `satisfies` clause proves membership of both closed vocabularies —
 * `PROMPT_STAGES` (the prompt file and the recorded prompt version) and
 * protocol's `PROGRESS_STAGES` — so a rename in either fails to compile here
 * rather than loading no prompt at run time. No other line of this module
 * spells the stage.
 */
export const PANEL_PROMPT_STAGE = 'generate-panel' as const satisfies PromptStage & ProgressStage;

/**
 * The placeholder keys of the generate-panel prompt, exactly as the `## Inputs`
 * section of `prompts/generate-panel/v001.md` declares them — no more and no
 * fewer.
 *
 * `renderPrompt` fails naming every placeholder that has no value, so the
 * values object is built as a `Record` over this tuple
 * ({@link PanelPromptValues}): a key added here without a value, or a value
 * whose key is not here, is a compile error, and a key the prompt file names
 * that is absent here is a typed render failure rather than a silently blank
 * section.
 */
export const PANEL_PROMPT_PLACEHOLDERS = Object.freeze([
  'question',
  'analysis',
  'nodeCatalog',
  'captureOverview',
  'outputSchema',
] as const);

/** One member of {@link PANEL_PROMPT_PLACEHOLDERS}. */
export type PanelPromptPlaceholder = (typeof PANEL_PROMPT_PLACEHOLDERS)[number];

/** The rendered value of every placeholder, keyed by the closed placeholder set. */
export type PanelPromptValues = Readonly<Record<PanelPromptPlaceholder, string>>;

/**
 * The user-interface kinds `panel.generated` is delivered to: the DevTools
 * panel, which renders it, and the editor view, which mirrors its summary
 * (AAP 0.4.2: service → DevTools, VS Code).
 */
export const PANEL_BROADCAST_KINDS: readonly ClientKind[] = Object.freeze(['devtools', 'vscode']);

/**
 * The artifact name `generateStructuredWithRepair` quotes in its rejection
 * messages and log records. A label for diagnostics, never sent to a model.
 */
const PANEL_SCHEMA_NAME = 'panel specification';

/** The `subsystem` binding of this module's logger, shared with `./validate.ts` and `./fallback.ts`. */
const SUBSYSTEM = 'panels';

/**
 * How the questions of a regeneration are joined inside `{{question}}`: the
 * session's question first, then the follow-up, in the order they were asked,
 * separated by a blank line. A separator, not prose — nothing is added to the
 * developer's own words.
 */
const QUESTION_SEPARATOR = '\n\n';

/**
 * Characters of one question rendered into the prompt. Protocol already bounds
 * a session question to this length; the cut is a defence for a caller that
 * reached this module around that schema.
 */
const MAX_QUESTION_CHARS = 2_000;

/** Characters kept from any single string of the capture overview. */
const MAX_OVERVIEW_TEXT_CHARS = 240;

/** Items kept from any list nested inside one overview row (prop keys, status codes, initiators). */
const MAX_OVERVIEW_ROW_LIST_ITEMS = 10;

/**
 * Rows kept from each section of the capture overview: the summary's own
 * top-N, so the overview never claims to be more complete than the summary.
 */
const MAX_OVERVIEW_ROWS = DEFAULT_TOP_N;

/** Nesting levels {@link toJsonValue} follows before it drops a branch. */
const MAX_JSON_DEPTH = 16;

/** The marker a truncated overview string ends with. */
const TRUNCATION_MARKER = '\u2026';

/** How the prompt's JSON sections are indented. */
const PROMPT_JSON_INDENT = 2;

/** How many issue paths one log record names. */
const MAX_LOGGED_ISSUES = 20;

/** The data source whose unit is a trace rather than a record. */
const TRACE_SOURCE: DataQuerySource = 'trace';

/** The data source of the computed metric tiles, measured by its available values. */
const METRICS_SOURCE: DataQuerySource = 'metrics';

/* -------------------------------------------------------------------------------------------------
 * Ports and public types
 * ---------------------------------------------------------------------------------------------- */

/** The prompt loader, as this module uses it: the current version, or a recorded one. */
export type PanelPromptPort = Pick<PromptLoader, 'load' | 'loadVersion'>;

/** The validation boundary of `./validate.ts`, as this module uses it. */
export type PanelValidationPort = Pick<
  PanelValidator,
  'buildStructuredOptionsNormalizer' | 'validateGenerated' | 'classifyFailure'
>;

/** The deterministic fallback builder of `./fallback.ts`. */
export type PanelFallbackPort = Pick<FallbackPanelBuilder, 'build'>;

/** The panel ladder of the session store, as this module uses it. */
export type PanelStorePort = Pick<
  PanelsRepo,
  'getLatestPanel' | 'nextPanelVersion' | 'insertPanel'
>;

/** Where `panel.generated` frames go: the client registry in production. */
export type PanelBroadcastPort = Pick<SessionBroadcaster, 'broadcastToKinds'>;

/** Everything {@link createPanelGenerator} is given; every collaborator is injected. */
export interface PanelGeneratorDeps {
  /** The model boundary: the network-backed provider, or the rules-based one in every test. */
  readonly provider: ModelProvider;
  /** Reads `prompts/generate-panel/vNNN.md`. */
  readonly prompts: PanelPromptPort;
  /** Steps 2–4 of the validation order, and the classification of every failure. */
  readonly validator: PanelValidationPort;
  /** The deterministic fallback panel, assembled from the capture aggregates. */
  readonly fallback: PanelFallbackPort;
  /** The panel ladder: next version, predecessor and the insert. */
  readonly panels: PanelStorePort;
  /**
   * Loads a capture's summary when a request does not carry one: the service's
   * `AnalysisSummarizer`. Without it every request must carry its summary.
   */
  readonly captures?: CaptureSummaryPort | undefined;
  /** Delivers `panel.generated`. Absent in unit contexts, where nothing is sent. */
  readonly broadcaster?: PanelBroadcastPort | undefined;
  /** The service logger; records are bound to `subsystem: "panels"`, the session and the capture. */
  readonly logger?: Logger | undefined;
  /** Mints the panel id; defaults to `newPanelId`. Injected for deterministic tests. */
  readonly newId?: (() => PanelId) | undefined;
}

/** One panel generation for a capture. */
export interface PanelGenerationRequest {
  /** The session the panel answers. */
  readonly sessionId: SessionId;
  /** The capture whose evidence the panel draws. */
  readonly captureId: CaptureId;
  /** The session's question, verbatim. Rendered into `{{question}}` only. */
  readonly question: string;
  /**
   * The validated analysis of that capture: the sole source of the panel's
   * observed facts and likely causes. Re-parsed here; it must name the same
   * session and capture.
   */
  readonly analysis: AnalysisResult;
  /** The capture's summary; loaded through {@link PanelGeneratorDeps.captures} when absent. */
  readonly summary?: CaptureSummary | undefined;
  /**
   * The generate-panel prompt version the session recorded. When present that
   * exact version is loaded — committed prompts are immutable and superseded
   * versions keep resolving — otherwise the manifest's current one.
   */
  readonly promptVersion?: PromptVersion | undefined;
  /** Cancels the generation; nothing is stored or broadcast once it aborts. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * A regeneration on the existing-evidence follow-up path (AAP 0.4.2:
 * `generated → analyzing → generated`): the same pipeline over the stored
 * capture, answering the follow-up question as the next panel version.
 */
export interface PanelRegenerationRequest extends PanelGenerationRequest {
  /** The follow-up question, verbatim; appended to `{{question}}` after the session's question. */
  readonly followUpQuestion: string;
}

/** A stored, broadcast panel and how it came to be. */
export interface PanelGenerationResult {
  /** The panel exactly as the store holds it: validated, and what the stage hands the state machine. */
  readonly panel: PanelSpec;
  /** Whether this is the deterministic fallback panel (`panel.meta.fallback === true`). */
  readonly fallback: boolean;
  /** Why the generated panel was replaced, on the fallback path. */
  readonly fallbackReason?: PanelFailureClass;
  /** The prompt version actually rendered, for the session record's prompt-version map. */
  readonly promptVersion: PromptVersion;
  /** Provider calls made, including the accepted one. */
  readonly attempts: number;
  /** How many of those were repairs; never more than `DEFAULT_MAX_REPAIRS`. */
  readonly repairs: number;
  /** The provider implementation that answered, when a model panel was accepted. */
  readonly providerId?: string;
  /** The model that answered, as the provider reports it, when a model panel was accepted. */
  readonly model?: string;
  /** Semantic validation's report for an accepted model panel, including its non-fatal warnings. */
  readonly report?: PanelSemanticReport;
  /** Whether `panel.generated` was handed to the broadcaster. */
  readonly broadcast: boolean;
}

/** Stage 6: see the module documentation. */
export interface PanelGenerator {
  /**
   * Generates, validates, stores and broadcasts the panel of one capture.
   *
   * Never throws. Resolves to `ok` with a stored panel — a model panel that
   * passed all four gates, or the deterministic fallback — or to `err` with a
   * typed error: the provider's own error, a prompt configuration error, a
   * store failure, or a fallback that could not be built.
   *
   * When the session already holds a panel, the new one is its next version
   * and names it in `supersedes` (the new-capture follow-up path replaces the
   * panel on screen just as the existing-evidence path does).
   */
  generate(request: PanelGenerationRequest): Promise<Result<PanelGenerationResult, DebuggenError>>;

  /**
   * The existing-evidence follow-up: the same pipeline with the follow-up
   * question appended to `{{question}}`, stored as `panelVersion n + 1` with
   * `supersedes` naming panel `n`. The previous row is never touched. Refused
   * with `SESSION_INVALID_STATE` when the session holds no panel to supersede.
   */
  regenerate(
    request: PanelRegenerationRequest,
  ): Promise<Result<PanelGenerationResult, DebuggenError>>;
}

/* -------------------------------------------------------------------------------------------------
 * JSON projection
 * ---------------------------------------------------------------------------------------------- */

/** Code-unit order: locale-free, so every process sorts keys identically. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Whether a value is an array, narrowing to `unknown` elements rather than `any`. */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Whether a value is a plain record: an object literal, a parsed JSON object, a schema output. */
function isPlainRecord(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Converts a value into plain JSON in canonical form: object keys in code-unit
 * order, `undefined` members and non-finite numbers dropped, anything that is
 * not plain data (a function, a symbol, a class instance, a cycle, a branch
 * deeper than {@link MAX_JSON_DEPTH}) left out rather than stringified.
 *
 * This is what makes the structured context both walkable by the outbound
 * guard and deterministic: equal data serialises to byte-identical prompt text
 * whatever order its producer happened to write the keys in.
 */
function toJsonValue(value: unknown, depth: number, ancestors: Set<object>): JsonValue | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'object' || depth >= MAX_JSON_DEPTH || ancestors.has(value)) {
    return undefined;
  }

  ancestors.add(value);
  try {
    if (isUnknownArray(value)) {
      const items: JsonValue[] = [];
      for (const item of value) {
        const converted = toJsonValue(item, depth + 1, ancestors);
        if (converted !== undefined) {
          items.push(converted);
        }
      }
      return items;
    }

    if (!isPlainRecord(value)) {
      return undefined;
    }

    const record: Record<string, JsonValue> = {};
    const entries: [string, unknown][] = Object.entries(value);
    entries.sort(([left], [right]) => compareCodeUnits(left, right));
    for (const [key, member] of entries) {
      const converted = toJsonValue(member, depth + 1, ancestors);
      if (converted !== undefined) {
        record[key] = converted;
      }
    }
    return record;
  } finally {
    ancestors.delete(value);
  }
}

/** {@link toJsonValue} for a value that must come out as an object. */
function toJsonObject(value: Readonly<Record<string, unknown>>): JsonObject {
  const converted = toJsonValue(value, 0, new Set<object>());
  return converted !== null && typeof converted === 'object' && !isUnknownArray(converted)
    ? converted
    : {};
}

/** Prompt text for one structured section: the canonical JSON, indented. */
function promptJson(value: JsonValue): string {
  return JSON.stringify(value, null, PROMPT_JSON_INDENT);
}

/** One overview string, bounded, with a visible marker when cut. */
function boundedText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.length > MAX_OVERVIEW_TEXT_CHARS
    ? `${value.slice(0, MAX_OVERVIEW_TEXT_CHARS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`
    : value;
}

/** A list read defensively: a stored summary is typed, not trusted, so a missing list reads as empty. */
function listOf<T>(items: readonly T[] | undefined): readonly T[] {
  return isUnknownArray(items) ? items : [];
}

/** The first `max` items of a list, read defensively. */
function leading<T>(items: readonly T[] | undefined, max: number): readonly T[] {
  return listOf(items).slice(0, max);
}

/** A count read defensively: a positive finite number, otherwise zero. */
function positiveCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/* -------------------------------------------------------------------------------------------------
 * The structured context: node catalog, analysis and capture overview
 * ---------------------------------------------------------------------------------------------- */

/**
 * One catalog entry as structured context: the same registry
 * `describeCatalogForPrompt` renders into `{{nodeCatalog}}`, as data.
 *
 * Field names are the catalog's own. `carriesLocation` is derived, not
 * restated: a leaf that takes neither children nor a query is the node that
 * carries a source location of its own (the catalog's source-link leaf).
 */
function catalogEntryContext(entry: PanelNodeCatalogEntry): Readonly<Record<string, unknown>> {
  return {
    type: entry.type,
    kind: entry.kind,
    label: entry.label,
    description: entry.description,
    sources: [...entry.sources],
    defaultSource: entry.defaultSource,
    requiresQuery: entry.requiresQuery,
    supportsChildren: entry.supportsChildren,
    carriesLocation: !entry.supportsChildren && !entry.requiresQuery,
    telemetryKinds: [...entry.telemetryKinds],
    options: entry.options === undefined ? undefined : [...entry.options],
  };
}

/** What one data source's records are: any event, or events of the listed kinds. */
interface SourceSubject {
  readonly anyKind: boolean;
  readonly kinds: readonly TelemetryKind[];
}

/**
 * The records one data source serves, derived from the catalog: the kinds of
 * the node types designed around that source (those that list it first). A
 * source whose designed-for node types are indifferent to kind serves any
 * event. Nothing about a kind is restated here — the catalog owns which kinds a
 * view is about.
 */
function subjectOfSource(source: DataQuerySource): SourceSubject {
  const designed = PANEL_NODE_CATALOG_ENTRIES.filter((entry) => entry.sources[0] === source);
  if (designed.length === 0 || designed.some((entry) => entry.telemetryKinds.length === 0)) {
    return { anyKind: true, kinds: [] };
  }
  const kinds = TELEMETRY_KINDS.filter((kind) =>
    designed.some((entry) => entry.telemetryKinds.includes(kind)),
  );
  return { anyKind: false, kinds };
}

/**
 * How much each data source holds for this capture, in `DATA_QUERY_SOURCES`
 * order: the traces a trace view can draw, the metric values the capture could
 * measure, and otherwise the events of the kinds the source serves.
 *
 * Every source is listed, zeros included, so "this source holds nothing" is a
 * stated fact rather than an absent key — the prompt asks the author to omit a
 * node whose source is empty, and a rules-based author reads the same counts.
 */
function populatedSourceCounts(summary: CaptureSummary): Readonly<Record<string, number>> {
  const eventCount = positiveCount(summary.eventCount);
  const counts: Record<string, number> = {};
  for (const source of DATA_QUERY_SOURCES) {
    if (source === METRICS_SOURCE) {
      counts[source] = listOf(summary.metrics).filter((metric) => metric.available).length;
      continue;
    }
    if (source === TRACE_SOURCE) {
      counts[source] = positiveCount(summary.traceCount);
      continue;
    }
    const subject = subjectOfSource(source);
    counts[source] = subject.anyKind
      ? eventCount
      : subject.kinds.reduce((total, kind) => total + positiveCount(summary.kindCounts[kind]), 0);
  }
  return counts;
}

/** A measured metric, as the overview lists it: the tiles a metric-card node may name. */
function metricContext(metric: MetricValue): Readonly<Record<string, unknown>> {
  return {
    id: metric.id,
    label: boundedText(metric.label),
    unit: metric.unit,
    value: metric.value,
    note: boundedText(metric.note),
  };
}

/** One of the slowest spans. The attribute bag is never carried. */
function spanContext(span: SpanSummary): Readonly<Record<string, unknown>> {
  return {
    traceId: span.traceId,
    kind: span.kind,
    tier: span.tier,
    name: boundedText(span.name),
    durationMs: span.durationMs,
    selfTimeMs: span.selfTimeMs,
    status: span.status,
    source: span.source,
  };
}

/** One component's render statistics: counts, timing, trigger classification and prop names. */
function renderContext(render: RenderStat): Readonly<Record<string, unknown>> {
  return {
    component: boundedText(render.component),
    renderCount: render.renderCount,
    unchangedRenderCount: render.unchangedRenderCount,
    unknownTriggerCount: render.unknownTriggerCount,
    totalDurationMs: render.totalDurationMs,
    averageDurationMs: render.averageDurationMs,
    maxDurationMs: render.maxDurationMs,
    triggers: render.triggers,
    changedPropKeys: leading(render.changedPropKeys, MAX_OVERVIEW_ROW_LIST_ITEMS).map(boundedText),
  };
}

/**
 * One request group. The redacted URL and the counts only: the group's
 * request key is a keyed hash that identifies byte-identical requests inside
 * the store and has no business leaving it.
 */
function requestContext(group: RequestGroup): Readonly<Record<string, unknown>> {
  return {
    method: boundedText(group.method),
    url: boundedText(group.url),
    count: group.count,
    duplicateCount: group.duplicateCount,
    hasDuplicates: group.hasDuplicates,
    totalDurationMs: group.totalDurationMs,
    averageDurationMs: group.averageDurationMs,
    maxDurationMs: group.maxDurationMs,
    statusCodes: leading(group.statusCodes, MAX_OVERVIEW_ROW_LIST_ITEMS),
    errorCount: group.errorCount,
    initiators: leading(group.initiators, MAX_OVERVIEW_ROW_LIST_ITEMS).map(boundedText),
  };
}

/** One statement shape: the parameterised text (literals were replaced at ingest) and its timing. */
function queryContext(group: QueryGroup): Readonly<Record<string, unknown>> {
  return {
    statement: boundedText(group.statement),
    system: boundedText(group.system),
    executionCount: group.executionCount,
    totalDurationMs: group.totalDurationMs,
    averageDurationMs: group.averageDurationMs,
    maxDurationMs: group.maxDurationMs,
  };
}

/** One failure: identity and the redacted span name. No message body, no stack. */
function errorContext(failure: ErrorSummary): Readonly<Record<string, unknown>> {
  return {
    traceId: failure.traceId,
    kind: failure.kind,
    tier: failure.tier,
    name: boundedText(failure.name),
  };
}

/**
 * The capture overview's inventory half: what the capture holds, by tier, by
 * kind and by section, bounded by the summary's own top-N.
 *
 * The primary trace is named `primaryTraceId`, the summary's own field, so it
 * reads as the trace a trace view defaults to — a view over it needs no filter,
 * and an author that wants to narrow another view to it names it explicitly.
 */
function captureContext(summary: CaptureSummary): Readonly<Record<string, unknown>> {
  const metrics = listOf(summary.metrics);
  return {
    captureId: summary.captureId,
    durationMs: summary.durationMs,
    eventCount: summary.eventCount,
    traceCount: summary.traceCount,
    primaryTraceId: summary.primaryTraceId,
    traceIds: leading(summary.traceIds, MAX_OVERVIEW_ROWS),
    truncated: summary.truncated,
    tierCounts: Object.fromEntries(
      TELEMETRY_TIERS.map((tier) => [tier, positiveCount(summary.tierCounts[tier])]),
    ),
    kindCounts: Object.fromEntries(
      TELEMETRY_KINDS.filter((kind) => positiveCount(summary.kindCounts[kind]) > 0).map((kind) => [
        kind,
        positiveCount(summary.kindCounts[kind]),
      ]),
    ),
    metrics: metrics
      .filter((metric) => metric.available && typeof metric.value === 'number')
      .map(metricContext),
    unavailableMetrics: metrics.filter((metric) => !metric.available).map((metric) => metric.id),
    spans: leading(summary.topSpans, MAX_OVERVIEW_ROWS).map(spanContext),
    renders: leading(summary.topRenders, MAX_OVERVIEW_ROWS).map(renderContext),
    requests: leading(summary.topRequests, MAX_OVERVIEW_ROWS).map(requestContext),
    queries: leading(summary.topQueries, MAX_OVERVIEW_ROWS).map(queryContext),
    errors: leading(summary.errors, MAX_OVERVIEW_ROWS).map(errorContext),
  };
}

/**
 * The structured context of one generate-panel request, and the source of
 * every data placeholder:
 *
 * - `analysis` → `{{analysis}}`: the validated analysis's `observed`,
 *   `likelyCauses` and `metrics`, nothing else;
 * - `nodeCatalog` → the registry `{{nodeCatalog}}` renders as text through
 *   `describeCatalogForPrompt`;
 * - `populatedSources` and `capture` → `{{captureOverview}}`, the two halves of
 *   the overview: how much each data source holds, and the bounded sections.
 *
 * The question and the output schema are prompt-only and never appear here.
 */
export interface PanelStageContext {
  /** The structured `input` of the model request. */
  readonly input: JsonObject;
  /** The `{{analysis}}` text. */
  readonly analysisText: string;
  /** The `{{captureOverview}}` text. */
  readonly captureOverviewText: string;
}

/**
 * Builds the structured context of one generate-panel request from the
 * validated analysis and the capture summary. Pure and deterministic: equal
 * arguments give byte-identical texts and a deep-equal input.
 *
 * @param analysis The validated analysis of the capture.
 * @param summary The capture's summary.
 * @returns The structured input and the two data sections rendered from it.
 */
export function buildPanelStageContext(
  analysis: AnalysisResult,
  summary: CaptureSummary,
): PanelStageContext {
  const analysisSection = toJsonObject({
    observed: analysis.observed,
    likelyCauses: analysis.likelyCauses,
    metrics: analysis.metrics,
  });
  const nodeCatalog = toJsonValue(
    PANEL_NODE_CATALOG_ENTRIES.map(catalogEntryContext),
    0,
    new Set<object>(),
  );
  const populatedSources = toJsonObject(populatedSourceCounts(summary));
  const capture = toJsonObject(captureContext(summary));

  return {
    input: {
      analysis: analysisSection,
      nodeCatalog: nodeCatalog ?? [],
      populatedSources,
      capture,
    },
    analysisText: promptJson(analysisSection),
    captureOverviewText: promptJson({ populatedSources, capture }),
  };
}

/**
 * The text of `{{question}}`: the session's question, and on a regeneration
 * the follow-up after it, each bounded. The words are passed through as data;
 * nothing inspects them.
 */
function questionTextFor(question: string, followUpQuestion: string | undefined): string {
  const asked = question.slice(0, MAX_QUESTION_CHARS);
  return followUpQuestion === undefined
    ? asked
    : `${asked}${QUESTION_SEPARATOR}${followUpQuestion.slice(0, MAX_QUESTION_CHARS)}`;
}

/**
 * The values `renderPrompt` receives, built key by key from
 * {@link PANEL_PROMPT_PLACEHOLDERS}, so exactly those five keys are supplied.
 */
function promptValuesFrom(values: PanelPromptValues): Readonly<Record<string, string>> {
  const rendered: Record<string, string> = {};
  for (const key of PANEL_PROMPT_PLACEHOLDERS) {
    rendered[key] = values[key];
  }
  return rendered;
}

/* -------------------------------------------------------------------------------------------------
 * Failure vocabulary
 * ---------------------------------------------------------------------------------------------- */

/** The next step when the request itself is inconsistent: a defect in the calling stage. */
const REQUEST_DEFECT_HINT =
  'Panel generation is given the validated analysis and the capture it was computed from, for the session they belong to. Pass the analysis, capture and session ids the analyze stage produced; this is a defect in the caller, not in the model output.';

/** The next step when a regeneration finds no panel to supersede. */
const NOTHING_TO_REGENERATE_HINT =
  'A follow-up regenerates the panel a session already holds. Generate the first panel for the capture, or take the new-capture follow-up path.';

/** The next step when no summary was supplied and no summary port is configured. */
const MISSING_SUMMARY_PORT_HINT =
  'Pass the capture summary to panel generation, or inject `captures` (a CaptureSummaryPort, such as the service AnalysisSummarizer) into createPanelGenerator.';

/** The next step when a generation is abandoned. */
const CANCELLED_HINT =
  'The work that asked for this panel was abandoned. Generate the panel again if it is still wanted.';

/** The next step when the injected panel-id factory failed. */
const PANEL_ID_HINT =
  'The panel id factory failed, so no panel could be identified. This is a defect in the service wiring; regenerate the panel once it is fixed.';

/** The next step when the authoring schema cannot be rendered for the prompt. */
const OUTPUT_SCHEMA_HINT =
  'The panel authoring schema could not be rendered as JSON Schema for the generate-panel prompt. This is a product defect in @debuggen/panel-schema; no model call was made.';

/** The next step when something no step anticipated interrupted generation. */
const UNEXPECTED_HINT =
  'This is a product defect: no panel was stored or broadcast for this attempt. The service log records the failing step; regenerate the panel once it is fixed.';

/** A typed error of this module: fixed message, closed code, shape-only details. */
function panelError(
  code: DebuggenErrorCode,
  message: string,
  hint: string,
  details: LogFields = {},
  cause?: DebuggenError,
): DebuggenError {
  return new DebuggenError(code, message, {
    hint,
    details: {
      stage: PANEL_PROMPT_STAGE,
      ...details,
      ...(cause === undefined ? {} : { causeCode: cause.code }),
    },
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Whether a generation has been abandoned. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** A non-negative integer read out of an error's details, for the attempt counts. */
function detailCount(details: Readonly<Record<string, unknown>> | undefined, key: string): number {
  const value = details?.[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** The catalogued node types a panel draws, in document order, without repeats: safe to log. */
function nodeTypesOf(spec: PanelSpec): readonly PanelNodeType[] {
  const types: PanelNodeType[] = [];
  walkPanelNodes(spec.layout, (node) => {
    if (!types.includes(node.type)) {
      types.push(node.type);
    }
  });
  return types;
}

/** The fields a rejection is logged with: its class, code, policy and issue paths — never content. */
function rejectionLogFields(rejection: PanelValidationRejection): LogFields {
  const policy = PANEL_FAILURE_POLICY[rejection.class];
  const issues = rejection.issues ?? [];
  return {
    failureClass: rejection.class,
    code: rejection.code,
    disposition: policy.disposition,
    productBug: policy.productBug,
    repairable: policy.repairable,
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
 * The generator
 * ---------------------------------------------------------------------------------------------- */

/** How a panel came to be: provider calls spent and, for an accepted model panel, who answered. */
interface Provenance {
  readonly attempts: number;
  readonly repairs: number;
  readonly providerId?: string;
  readonly model?: string;
}

/** Everything one generation settled before the model was asked. */
interface GenerationScope {
  readonly sessionId: SessionId;
  readonly captureId: CaptureId;
  readonly analysis: AnalysisResult;
  readonly summary: CaptureSummary;
  readonly panelVersion: number;
  readonly supersedes: PanelId | undefined;
  readonly promptVersion: PromptVersion;
  readonly signal: AbortSignal | undefined;
  readonly log: Logger;
}

/** How a stored panel is reported: model panel or fallback, with what it carries. */
interface Outcome {
  readonly provenance: Provenance;
  readonly fallbackReason?: PanelFailureClass;
  readonly report?: PanelSemanticReport;
}

/** The request fields of a session and capture that disagree with the documents handed in, by name. */
function scopeMismatches(
  sessionId: SessionId,
  captureId: CaptureId,
  analysis: AnalysisResult,
  summary: CaptureSummary,
): readonly string[] {
  const mismatches: string[] = [];
  if (analysis.sessionId !== sessionId) {
    mismatches.push('analysis.sessionId');
  }
  if (analysis.captureId !== captureId) {
    mismatches.push('analysis.captureId');
  }
  if (summary.captureId !== captureId) {
    mismatches.push('summary.captureId');
  }
  if (summary.sessionId !== undefined && summary.sessionId !== sessionId) {
    mismatches.push('summary.sessionId');
  }
  return mismatches;
}

/** Settles a promise without a value or a rejection: the tail of the per-session queue. */
function settle(): void {
  return undefined;
}

/**
 * Creates the panel generator over its injected collaborators.
 *
 * Holds no state between generations beyond two constant texts rendered once
 * (the catalog and the authoring schema) and a per-session queue: generations
 * for one session run one after another, so the version read from the ladder
 * and the insert that uses it cannot interleave with another generation of the
 * same session — `UNIQUE(session_id, panel_version)` stays an invariant the
 * store enforces rather than a race this module loses. Different sessions run
 * concurrently.
 *
 * @param deps The provider, prompt loader, validator, fallback builder, panel
 * store and the optional summary port, broadcaster, logger and id factory.
 * @returns The generator.
 */
export function createPanelGenerator(deps: PanelGeneratorDeps): PanelGenerator {
  const log = subsystemLogger(deps.logger ?? noopLogger, SUBSYSTEM);
  const mintId = deps.newId ?? newPanelId;
  const queues = new Map<SessionId, Promise<void>>();
  const catalogText = describeCatalogForPrompt();
  let outputSchemaText: string | undefined;

  /** Runs one generation after every earlier generation of the same session has settled. */
  const serialized = <T>(sessionId: SessionId, task: () => Promise<T>): Promise<T> => {
    const previous = queues.get(sessionId) ?? Promise.resolve();
    const current = previous.then(task);
    const tail = current.then(settle, settle);
    queues.set(sessionId, tail);
    void tail.then(() => {
      if (queues.get(sessionId) === tail) {
        queues.delete(sessionId);
      }
    });
    return current;
  };

  /** `{{outputSchema}}`: the authoring schema's canonical JSON Schema text, rendered once. */
  const outputSchema = (): Result<string, DebuggenError> => {
    if (outputSchemaText !== undefined) {
      return ok(outputSchemaText);
    }
    const rendered = tryCatch(() => panelSpecInputJsonSchemaText(), 'INTERNAL');
    if (!rendered.ok) {
      return err(
        panelError(
          'INTERNAL',
          'The panel authoring schema could not be rendered for the generate-panel prompt.',
          OUTPUT_SCHEMA_HINT,
          {},
          rendered.error,
        ),
      );
    }
    outputSchemaText = rendered.value;
    return ok(rendered.value);
  };

  /** The recorded prompt version when the session has one, otherwise the manifest's current version. */
  const loadPrompt = (version: PromptVersion | undefined): Result<PromptFile, DebuggenError> =>
    version === undefined
      ? deps.prompts.load(PANEL_PROMPT_STAGE)
      : deps.prompts.loadVersion(PANEL_PROMPT_STAGE, version);

  /** The summary the panel is generated from: the one supplied, or the one the port loads. */
  const summaryFor = async (
    request: PanelGenerationRequest,
  ): Promise<Result<CaptureSummary, DebuggenError>> => {
    if (request.summary !== undefined) {
      return ok(request.summary);
    }
    const captures = deps.captures;
    if (captures === undefined) {
      return err(
        panelError(
          'INTERNAL',
          'Panel generation received no capture summary and has no port to load one.',
          MISSING_SUMMARY_PORT_HINT,
        ),
      );
    }
    try {
      return await captures.loadCaptureSummary(request.sessionId, request.captureId);
    } catch (thrown) {
      return err(DebuggenError.from(thrown, 'STORE_ERROR'));
    }
  };

  /** A cancelled generation: nothing stored, nothing broadcast. */
  const cancelled = (sessionLog: Logger): Result<never, DebuggenError> => {
    sessionLog.debug('Panel generation was cancelled; nothing was stored or broadcast.', {
      stage: PANEL_PROMPT_STAGE,
    });
    return err(
      panelError(
        'MODEL_UNAVAILABLE',
        'Panel generation was cancelled; no panel was stored or broadcast.',
        CANCELLED_HINT,
        { cancelled: true },
      ),
    );
  };

  /**
   * Steps 1–3 of the validation order in one bounded call: the authoring schema
   * with at most `DEFAULT_MAX_REPAIRS` repairs, then the validator's
   * normalise-then-validate callback, whose throw is the no-retry signal. A
   * throw out of the loop itself is returned as the failure it is.
   */
  const callModel = async (
    request: ModelRequest,
    scope: GenerationScope,
    context: NormalizeContext,
  ): Promise<Result<StructuredSuccess<PanelSpecInput, PanelSpec>, DebuggenError>> => {
    try {
      return await generateStructuredWithRepair<PanelSpecInput, PanelSpec>(
        deps.provider,
        panelSpecInputSchema,
        request,
        {
          maxRepairs: DEFAULT_MAX_REPAIRS,
          normalize: deps.validator.buildStructuredOptionsNormalizer(scope.analysis, context),
          schemaName: PANEL_SCHEMA_NAME,
          logger: scope.log,
        },
      );
    } catch (thrown) {
      return err(DebuggenError.from(thrown));
    }
  };

  /**
   * Hands `panel.generated` to the broadcaster: exactly `{ sessionId, panelId,
   * panel }`, validated against protocol's payload schema, enveloped with
   * `createEnvelope`. Delivery is best effort — the panel is already stored, and
   * a client that missed the frame recovers it through the reopen replay — so a
   * failure here is logged and reported, never turned into a failed generation.
   */
  const announce = (panel: PanelSpec, sessionLog: Logger): boolean => {
    const broadcaster = deps.broadcaster;
    if (broadcaster === undefined) {
      return false;
    }

    const payload = panelGeneratedPayloadSchema.safeParse({
      sessionId: panel.sessionId,
      panelId: panel.id,
      panel,
    });
    if (!payload.success) {
      sessionLog.error(
        'A stored panel failed the panel.generated payload schema; it was not broadcast.',
        {
          panelId: panel.id,
          issueCount: payload.error.issues.length,
          issuePaths: payload.error.issues
            .slice(0, MAX_LOGGED_ISSUES)
            .map((issue) => issue.path.map((segment) => String(segment)).join('.')),
        },
      );
      return false;
    }

    const envelope = tryCatch(
      () => createEnvelope('panel.generated', payload.data),
      'PROTOCOL_INVALID_MESSAGE',
    );
    if (!envelope.ok) {
      sessionLog.error(
        'The panel.generated frame could not be built; the panel was not broadcast.',
        {
          panelId: panel.id,
          code: envelope.error.code,
        },
      );
      return false;
    }

    try {
      broadcaster.broadcastToKinds(panel.sessionId, PANEL_BROADCAST_KINDS, envelope.value);
    } catch (thrown) {
      sessionLog.warn('Broadcasting panel.generated failed; clients recover the panel on reopen.', {
        panelId: panel.id,
        code: DebuggenError.from(thrown, 'TRANSPORT_DISCONNECTED').code,
      });
      return false;
    }
    return true;
  };

  /** Broadcasts a stored panel and reports it: the one exit shared by model and fallback panels. */
  const finish = (
    scope: GenerationScope,
    stored: PanelSpec,
    outcome: Outcome,
  ): PanelGenerationResult => {
    const broadcast = announce(stored, scope.log);
    const fallback = stored.meta?.fallback === true;
    const { provenance } = outcome;

    scope.log.info('Stored a generated panel for the capture.', {
      stage: PANEL_PROMPT_STAGE,
      panelId: stored.id,
      panelVersion: stored.panelVersion,
      ...(stored.supersedes === undefined ? {} : { supersedes: stored.supersedes }),
      fallback,
      ...(outcome.fallbackReason === undefined ? {} : { fallbackReason: outcome.fallbackReason }),
      promptVersion: scope.promptVersion,
      attempts: provenance.attempts,
      repairs: provenance.repairs,
      ...(provenance.providerId === undefined ? {} : { providerId: provenance.providerId }),
      ...(provenance.model === undefined ? {} : { model: provenance.model }),
      nodeTypes: nodeTypesOf(stored),
      ...(outcome.report === undefined ? {} : { warningCount: outcome.report.warnings.length }),
      broadcast,
    });

    return {
      panel: stored,
      fallback,
      ...(outcome.fallbackReason === undefined ? {} : { fallbackReason: outcome.fallbackReason }),
      promptVersion: scope.promptVersion,
      attempts: provenance.attempts,
      repairs: provenance.repairs,
      ...(provenance.providerId === undefined ? {} : { providerId: provenance.providerId }),
      ...(provenance.model === undefined ? {} : { model: provenance.model }),
      ...(outcome.report === undefined ? {} : { report: outcome.report }),
      broadcast,
    };
  };

  /**
   * Replaces a rejected panel with the deterministic fallback of `./fallback.ts`
   * and stores and broadcasts it through the same path as a model panel.
   *
   * The raw rejection is logged — class, code, policy and issue paths, at
   * `error` for a product defect and `warn` otherwise — and never shown as
   * analysis (AAP 0.5.5). A fallback that cannot be built, or that does not
   * carry its fallback flag, is a hard error: no unvalidated or unflagged panel
   * ever leaves this module.
   */
  const substituteFallback = async (
    scope: GenerationScope,
    rejection: PanelValidationRejection,
    provenance: Provenance,
  ): Promise<Result<PanelGenerationResult, DebuggenError>> => {
    const policy = PANEL_FAILURE_POLICY[rejection.class];
    const fields: LogFields = {
      stage: PANEL_PROMPT_STAGE,
      ...rejectionLogFields(rejection),
      attempts: provenance.attempts,
      repairs: provenance.repairs,
      panelVersion: scope.panelVersion,
      promptVersion: scope.promptVersion,
    };
    if (policy.productBug) {
      scope.log.error(
        'A generated panel was rejected by a product defect and was not re-prompted; showing the deterministic fallback panel.',
        fields,
      );
    } else {
      scope.log.warn(
        'A generated panel was rejected; showing the deterministic fallback panel built from captured data.',
        fields,
      );
    }

    if (isAborted(scope.signal)) {
      return cancelled(scope.log);
    }

    const built = await deps.fallback.build({
      sessionId: scope.sessionId,
      captureId: scope.captureId,
      analysis: scope.analysis,
      summary: scope.summary,
      panelVersion: scope.panelVersion,
      ...(scope.supersedes === undefined ? {} : { supersedes: scope.supersedes }),
      reason: rejection.class,
    });
    if (!built.ok) {
      scope.log.error(
        'The deterministic fallback panel could not be built; no panel was stored or broadcast.',
        { stage: PANEL_PROMPT_STAGE, code: built.error.code, failureClass: rejection.class },
      );
      return err(built.error);
    }
    if (built.value.meta?.fallback !== true) {
      const error = panelError(
        'PANEL_INVALID',
        'The fallback panel builder returned a panel without its fallback flag; it was not stored.',
        UNEXPECTED_HINT,
        { failureClass: rejection.class },
      );
      scope.log.error(error.message, { stage: PANEL_PROMPT_STAGE, code: error.code });
      return err(error);
    }

    const stored = deps.panels.insertPanel(built.value, { captureId: scope.captureId });
    if (!stored.ok) {
      scope.log.error('The deterministic fallback panel could not be stored.', {
        stage: PANEL_PROMPT_STAGE,
        code: stored.error.code,
        panelVersion: scope.panelVersion,
      });
      return err(stored.error);
    }

    return ok(
      finish(scope, stored.value, {
        provenance: { attempts: provenance.attempts, repairs: provenance.repairs },
        fallbackReason: rejection.class,
      }),
    );
  };

  /** One generation, start to finish, inside its session's queue. */
  const produce = async (
    request: PanelGenerationRequest,
    followUpQuestion: string | undefined,
    requirePredecessor: boolean,
  ): Promise<Result<PanelGenerationResult, DebuggenError>> => {
    const { sessionId, captureId, signal } = request;
    const sessionLog = sessionLogger(log, sessionId, captureId);
    if (isAborted(signal)) {
      return cancelled(sessionLog);
    }

    // The analysis is the sole source of the panel's facts: parsed again here,
    // so nothing that bypassed the analyze stage's validation reaches a panel.
    const analysis = parseAnalysisResult(request.analysis);
    if (!analysis.ok) {
      const error = panelError(
        'INTERNAL',
        'Panel generation was handed an analysis that is not a valid analysis result.',
        REQUEST_DEFECT_HINT,
        {},
        analysis.error,
      );
      sessionLog.error(error.message, { stage: PANEL_PROMPT_STAGE, code: analysis.error.code });
      return err(error);
    }

    const summary = await summaryFor(request);
    if (!summary.ok) {
      sessionLog.warn('The capture summary a panel is generated from could not be loaded.', {
        stage: PANEL_PROMPT_STAGE,
        code: summary.error.code,
      });
      return err(summary.error);
    }

    const mismatches = scopeMismatches(sessionId, captureId, analysis.value, summary.value);
    if (mismatches.length > 0) {
      const error = panelError(
        'SESSION_INVALID_STATE',
        'Panel generation was handed an analysis or summary of a different session or capture.',
        REQUEST_DEFECT_HINT,
        { mismatches: [...mismatches] },
      );
      sessionLog.error(error.message, { stage: PANEL_PROMPT_STAGE, mismatches: [...mismatches] });
      return err(error);
    }

    // The version ladder: read inside this session's queue, so the insert
    // below takes exactly this rung.
    const latest = deps.panels.getLatestPanel(sessionId);
    if (!latest.ok) {
      sessionLog.warn('The latest panel of the session could not be read.', {
        stage: PANEL_PROMPT_STAGE,
        code: latest.error.code,
      });
      return err(latest.error);
    }
    if (requirePredecessor && latest.value === undefined) {
      const error = panelError(
        'SESSION_INVALID_STATE',
        'A follow-up asked to regenerate a panel, but the session holds no panel to supersede.',
        NOTHING_TO_REGENERATE_HINT,
      );
      sessionLog.warn(error.message, { stage: PANEL_PROMPT_STAGE });
      return err(error);
    }
    const version = deps.panels.nextPanelVersion(sessionId);
    if (!version.ok) {
      sessionLog.warn('The next panel version of the session could not be read.', {
        stage: PANEL_PROMPT_STAGE,
        code: version.error.code,
      });
      return err(version.error);
    }
    const supersedes = latest.value?.id;

    const id = tryCatch(() => mintId(), 'INTERNAL');
    if (!id.ok) {
      const error = panelError(
        'INTERNAL',
        'The panel id factory failed while generating a panel.',
        PANEL_ID_HINT,
        {},
        id.error,
      );
      sessionLog.error(error.message, { stage: PANEL_PROMPT_STAGE, code: id.error.code });
      return err(error);
    }

    // Identity comes only from here: the model authors none of it.
    const context: NormalizeContext = {
      id: id.value,
      sessionId,
      panelVersion: version.value,
      ...(supersedes === undefined ? {} : { supersedes }),
    };

    const prompt = loadPrompt(request.promptVersion);
    if (!prompt.ok) {
      sessionLog.warn('The generate-panel prompt could not be loaded.', {
        stage: PANEL_PROMPT_STAGE,
        code: prompt.error.code,
        ...(request.promptVersion === undefined ? {} : { promptVersion: request.promptVersion }),
      });
      return err(prompt.error);
    }

    const schemaText = outputSchema();
    if (!schemaText.ok) {
      sessionLog.error(schemaText.error.message, {
        stage: PANEL_PROMPT_STAGE,
        code: schemaText.error.code,
      });
      return err(schemaText.error);
    }

    const stageContext = buildPanelStageContext(analysis.value, summary.value);
    const values: PanelPromptValues = {
      question: questionTextFor(request.question, followUpQuestion),
      analysis: stageContext.analysisText,
      nodeCatalog: catalogText,
      captureOverview: stageContext.captureOverviewText,
      outputSchema: schemaText.value,
    };
    const rendered = renderPrompt(prompt.value.text, promptValuesFrom(values), sessionLog);
    if (!rendered.ok) {
      sessionLog.error('The generate-panel prompt could not be rendered.', {
        stage: PANEL_PROMPT_STAGE,
        code: rendered.error.code,
        promptVersion: prompt.value.version,
      });
      return err(rendered.error);
    }

    const modelRequest: ModelRequest = {
      prompt: rendered.value,
      input: stageContext.input,
      metadata: { stage: PANEL_PROMPT_STAGE, promptVersion: prompt.value.version, sessionId },
      ...(signal === undefined ? {} : { signal }),
    };

    // Defence in depth: the provider runs the same guard before its transport.
    // Refused here, the payload never reaches any provider at all.
    const cleared = assertOutboundSafe(modelRequest, { logger: sessionLog });
    if (!cleared.ok) {
      sessionLog.warn('The generate-panel request was refused by the outbound redaction guard.', {
        stage: PANEL_PROMPT_STAGE,
        code: cleared.error.code,
        promptVersion: prompt.value.version,
      });
      return err(cleared.error);
    }

    const scope: GenerationScope = {
      sessionId,
      captureId,
      analysis: analysis.value,
      summary: summary.value,
      panelVersion: version.value,
      supersedes,
      promptVersion: prompt.value.version,
      signal,
      log: sessionLog,
    };

    const generated = await callModel(modelRequest, scope, context);
    if (!generated.ok) {
      const rejection = deps.validator.classifyFailure(generated.error);
      const provenance: Provenance = {
        attempts: detailCount(generated.error.details, 'attempts'),
        repairs: detailCount(generated.error.details, 'repairs'),
      };
      if (PANEL_FAILURE_POLICY[rejection.class].disposition === 'passthrough') {
        sessionLog.warn('The model provider failed; panel generation fails with its error.', {
          stage: PANEL_PROMPT_STAGE,
          ...rejectionLogFields(rejection),
          attempts: provenance.attempts,
          repairs: provenance.repairs,
          promptVersion: scope.promptVersion,
        });
        return err(rejection.error);
      }
      return substituteFallback(scope, rejection, provenance);
    }

    const success = generated.value;
    if (isAborted(signal)) {
      return cancelled(sessionLog);
    }

    // Step 4: the normalised, internally valid panel against its capture.
    const checked = await deps.validator.validateGenerated({
      spec: success.value,
      sessionId,
      captureId,
      summary: summary.value,
    });
    const spent: Provenance = { attempts: success.attempts, repairs: success.repairs };
    if (!checked.ok) {
      return substituteFallback(scope, checked.error, spent);
    }

    if (isAborted(signal)) {
      return cancelled(sessionLog);
    }

    const stored = deps.panels.insertPanel(checked.value.spec, { captureId });
    if (!stored.ok) {
      // The store re-parses every panel; a refusal of the document itself is a
      // rejection like any other, answered with the fallback. Anything else is
      // the store's own failure and passes through.
      if (stored.error.code === 'PANEL_INVALID') {
        return substituteFallback(scope, deps.validator.classifyFailure(stored.error), spent);
      }
      sessionLog.warn('A generated panel could not be stored.', {
        stage: PANEL_PROMPT_STAGE,
        code: stored.error.code,
        panelVersion: scope.panelVersion,
      });
      return err(stored.error);
    }

    return ok(
      finish(scope, stored.value, {
        provenance: {
          attempts: success.attempts,
          repairs: success.repairs,
          providerId: success.providerId,
          model: success.model,
        },
        report: checked.value.report,
      }),
    );
  };

  /** Runs one generation in its session's queue, turning anything unanticipated into a typed error. */
  const execute = async (
    request: PanelGenerationRequest,
    followUpQuestion: string | undefined,
    requirePredecessor: boolean,
  ): Promise<Result<PanelGenerationResult, DebuggenError>> => {
    try {
      return await serialized(request.sessionId, () =>
        produce(request, followUpQuestion, requirePredecessor),
      );
    } catch (thrown) {
      const cause = DebuggenError.from(thrown);
      const error = panelError(
        'INTERNAL',
        'Panel generation failed unexpectedly; no panel was stored or broadcast.',
        UNEXPECTED_HINT,
        {},
        cause,
      );
      sessionLogger(log, request.sessionId, request.captureId).error(error.message, {
        stage: PANEL_PROMPT_STAGE,
        code: cause.code,
      });
      return err(error);
    }
  };

  return Object.freeze({
    generate: (request: PanelGenerationRequest) => execute(request, undefined, false),
    regenerate: (request: PanelRegenerationRequest) =>
      execute(request, request.followUpQuestion, true),
  });
}
