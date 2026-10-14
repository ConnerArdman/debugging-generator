/**
 * `pipeline-deterministic` — the model-facing stages of the in-process service,
 * run end to end against a real indexed project (AAP §0.8.3, §0.5.3, §0.5.4).
 *
 * The service is booted through the shared harness with the rules-based
 * deterministic provider. Every session is created over HTTP, its pipeline runs
 * understand → investigate → plan → install exactly as a developer's would, and
 * every pipeline assertion is made against what the service announced,
 * persisted or logged — no stage is called directly. The product functions this
 * file does call itself (`checkPlanFeasibility`, `checkFeasibility`,
 * `normalizePlan`, the adapters' `createPlan`) are asked over the same real
 * index, to check what the service recorded rather than to stand in for it.
 *
 * ## What this suite proves that no unit suite can
 *
 * `src/pipeline/stages/plan.test.ts` already pins the four-step gate of AAP
 * §0.5.3 and the registry-derived adapter catalog against fakes. This suite's
 * value is the half fakes cannot supply:
 *
 * - **Feasibility against a real code graph.** Every plan the service records is
 *   re-checked here with `checkPlanFeasibility` over the copied corpus, indexed
 *   by the service's own code-index loader, with the product's built-in adapter
 *   registry — the registry `startService` constructs. Each rejection code the
 *   pipeline can meet (`symbol-not-found`, `file-not-indexed`,
 *   `duplicate-action`) is driven through a persisted session — whose recorded
 *   plan keeps only the feasible action, so no refusal reaches the installer
 *   or a degradation row — and the two it
 *   cannot meet through the pipeline because an earlier gate refuses first
 *   (`path-outside-project`, `no-adapter`) are driven through the gate itself
 *   against real graphs, next to the earlier gate that refuses them.
 * - **The recorded prompt versions on a real persisted session**, compared with
 *   the committed `prompts/manifest.json` the harness points
 *   `DEBUGGEN_PROMPTS_DIR` at.
 * - **The validation order on the wire**: a bounded repair loop, a normaliser
 *   failure that is never re-prompted, and a runtime-only fallback assembled from
 *   the live adapters' own proposals.
 *
 * ## Rules ruling
 *
 * No user rule governs this file: `review_rules` reports "No user rules
 * provided." (AAP §0.10), so the §0.10 enterprise baseline applies, and this
 * file honours it as follows.
 *
 * - **Gate membership.** Collected by the `local-service-integration` project,
 *   so it runs under `pnpm test:integration` inside `pnpm verify`, and it is part
 *   of `tsc -b`, `eslint --max-warnings 0` and `prettier --check .`.
 * - **No committed secret.** `DEBUGGEN_PROVIDER=deterministic` (the harness
 *   default and the Vitest project's hermetic environment): no
 *   `ANTHROPIC_API_KEY` is read or needed, nothing leaves the machine, and every
 *   credential is minted by the harness at run time.
 * - **Reversible, recorded file changes.** A deterministic plan patches a route
 *   handler, so installation is reached. It goes through the service's real
 *   installer and is removed through the real cleanup on `session.end`; every
 *   copied project is snapshotted before its first session and proven
 *   byte-identical with `assertTreeUnchanged` afterwards, and the committed
 *   corpus is proven untouched. Installation behaviour as such (conflicts,
 *   chains) belongs to `cleanup-conflict.test.ts`.
 * - **Closed dependency set.** Only `@debuggen/*` (never `panel-renderer`),
 *   `node:*` and the harness. No `zod`: every validation is `.safeParse` on a
 *   schema object the owning package exports.
 *
 * ## One harness, one provider seam
 *
 * `startService` takes one provider for the life of the process, and this file
 * boots one harness. It is handed a **provider switch** that answers with the
 * real deterministic provider unless a scenario has installed a scripted
 * provider from `createScriptedProvider` (whose own fallback is that same
 * deterministic provider), and that records every call it forwards. Scenarios
 * run one session at a time and release the script before the next begins, so a
 * scripted answer can only ever reach the session it was written for.
 *
 * ## Genericity (AAP §0.5.4)
 *
 * The static half of the no-hardcoding rule is `scripts/check-no-hardcoding.mjs`:
 * it fails the build when product source branches on the question text or names
 * the demo application. The tokenizer in `src/pipeline/stages/understand.ts` is
 * the only sanctioned analysis of the question's words. The behavioural half is
 * asserted here: reworded questions yield equivalent artifacts, names that exist
 * only in the question are never selected, and renaming a route in the corpus
 * moves the plan with it.
 */

import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CODE_NODE_KINDS } from '@debuggen/code-analysis';
import {
  ACTION_ID_PATTERN,
  AGENT_HOOK_KEYS,
  CAPTURE_SIGNALS,
  DORMANT_AGENT_HOOK_CONFIG,
  FEASIBILITY_REJECTION_CODES,
  INSTRUMENTATION_ACTION_TYPES,
  INSTRUMENTATION_MARKERS,
  INSTRUMENTATION_MODES,
  INSTRUMENTATION_PLAN_VERSION,
  MODIFICATION_STATUSES,
  POSTGRES_ADAPTER_ID,
  PRISMA_ADAPTER_ID,
  SERVER_AGENT_SIGNAL_KEYS,
  TARGETLESS_FILE,
  TARGETLESS_SYMBOL,
  actionIdentityKey,
  checkFeasibility,
  checkPlanFeasibility,
  createAdapterRegistry,
  deriveAgentHookConfig,
  deriveServerAgentSignals,
  instrumentationPlanInputSchema,
  instrumentationPlanSchema,
  isCaptureSignal,
  isFeasibilityRejectionCode,
  isTargetlessAction,
  normalizePlan,
} from '@debuggen/instrumentation';
import type {
  AdapterRegistry,
  CaptureSignal,
  FeasibilityRejectionCode,
  FeasibilityReport,
  InstrumentationAction,
  InstrumentationContext,
  InstrumentationPlan,
  InstrumentationPlanInput,
  InstrumentationTargetInput,
  ProblemUnderstanding,
} from '@debuggen/instrumentation';
import {
  DEFAULT_MAX_REPAIRS,
  PROMPT_STAGES,
  REPAIR_ASSISTANT_NOTICE,
  createDeterministicProvider,
  createPromptLoader,
  promptManifestSchema,
} from '@debuggen/model-provider';
import type { ModelProvider, ModelRequest, PromptStage } from '@debuggen/model-provider';
import {
  CLEANUP_STATUSES,
  PROGRESS_STAGES,
  PROGRESS_STATUSES,
  PROMPT_STAGE_KEYS,
  SESSION_STATUSES,
  instrumentationPlanPayloadSchema,
  instrumentationReadyPayloadSchema,
  isMessageOfType,
  relevantFileSchema,
  sessionRecordSchema,
} from '@debuggen/protocol';
import type {
  InstrumentationReadyPayload,
  RelevantFile,
  SessionRecord,
  SessionStatus,
} from '@debuggen/protocol';
import { isErr, noopLogger } from '@debuggen/shared';
import type { DebuggenError, Result } from '@debuggen/shared';

import type { PipelineCodeHandles } from '../../src/pipeline/context-builder.js';
import { PIPELINE_STAGE_ORDER, createCodeIndexLoader } from '../../src/pipeline/orchestrator.js';
import type { CodeIndexPort } from '../../src/pipeline/orchestrator.js';
import { contextBoundResolver } from '../../src/pipeline/stages/plan.js';
import type { PlanRejectionReason } from '../../src/pipeline/stages/plan.js';
import { tokenizeQuestion } from '../../src/pipeline/stages/understand.js';
import { CODE_TOOL_LIMITS } from '../../src/pipeline/tools/code-tools.js';
import {
  CAPTURE_SIGNAL_LABELS,
  PROGRESS_STAGE_GROUPS,
  buildInvestigationRows,
} from '../../src/sessions/progress.js';
import type { ProgressEntry } from '../../src/store/sessions-repo.js';
import {
  DEFAULT_FIXTURE_PROJECT,
  HARNESS_TIMEOUTS,
  PROMPTS_DIR,
  assertTreeUnchanged,
  createScriptedProvider,
  fixturePath,
  readFixtureJson,
  scriptedFixtureStep,
  snapshotTree,
  startHarness,
  waitFor,
  waitUntil,
} from './harness.js';
import type {
  CapturedLogRecord,
  FixtureProjectCopy,
  Harness,
  HarnessWsClient,
  ScriptedProvider,
  ScriptedStep,
  TreeSnapshot,
} from './harness.js';

/* -------------------------------------------------------------------------------------------------
 * The product vocabulary this suite names — every member drawn from the tuple that owns it
 * ---------------------------------------------------------------------------------------------- */

/**
 * The member of `tuple` equal to `value`, returned from the tuple itself.
 *
 * The compiler checks `value` against the tuple's union, and the lookup checks
 * it again when the module loads, so a vocabulary member renamed or removed
 * upstream fails this suite at once instead of leaving a stale copy of its
 * spelling behind.
 *
 * @throws Error When `value` is not a member of `tuple`.
 */
function member<const Tuple extends readonly string[], const Value extends Tuple[number]>(
  tuple: Tuple,
  value: Value,
): Value {
  const found = tuple.find((entry): entry is Value => entry === value);
  if (found === undefined) {
    throw new Error(`"${value}" is not a member of its owning vocabulary.`);
  }
  return found;
}

/** Stage 1's name in both vocabularies it reports under. */
const UNDERSTAND_STAGE = member(PROMPT_STAGE_KEYS, member(PROGRESS_STAGES, 'understand'));

/** Stage 2's name in both vocabularies it reports under. */
const INVESTIGATE_STAGE = member(PROMPT_STAGE_KEYS, member(PROGRESS_STAGES, 'investigate'));

/** Stage 3's name in both vocabularies it reports under. */
const PLAN_STAGE = member(PROMPT_STAGE_KEYS, member(PROGRESS_STAGES, 'plan'));

/** The installation step's progress stage, under which degradation rows are filed. */
const INSTRUMENT_STAGE = member(PROGRESS_STAGES, 'instrument');

/** Stage 4, which makes no model call and therefore owns no prompt version. */
const CAPTURE_STAGE = member(PROGRESS_STAGES, 'capture');

/** The stages the initial run asks the model, in the order it asks them. */
const INITIAL_MODEL_STAGES: readonly PromptStage[] = Object.freeze([
  UNDERSTAND_STAGE,
  INVESTIGATE_STAGE,
  PLAN_STAGE,
]);

/** The one action type no runtime hook can supply (AAP §0.5.1). */
const FUNCTION_TIMING = member(INSTRUMENTATION_ACTION_TYPES, 'function-timing');

/** The action type whose claimant is decided by the project's database driver. */
const DB_QUERY_TRACKING = member(INSTRUMENTATION_ACTION_TYPES, 'db-query-tracking');

/** The install mode that touches no file. */
const RUNTIME_MODE = member(INSTRUMENTATION_MODES, 'runtime');

/** The install mode that edits a file. */
const PATCH_MODE = member(INSTRUMENTATION_MODES, 'patch');

/** The status every stage failure is filed under. */
const FAILED_STATUS = member(SESSION_STATUSES, 'failed');

/** The status only a satisfied readiness gate admits. */
const READY_STATUS = member(SESSION_STATUSES, 'ready');

/** The status only a validated analysis and panel admit (AAP §0.5.5). */
const GENERATED_STATUS = member(SESSION_STATUSES, 'generated');

/** The statuses of a run that proceeded: installed, with or without a satisfied readiness gate. */
const INSTRUMENTING_STATUS = member(SESSION_STATUSES, 'instrumenting');
const PROCEEDING_STATUSES: readonly SessionStatus[] = Object.freeze([
  INSTRUMENTING_STATUS,
  READY_STATUS,
]);

/** A progress row of a stage that is still working. */
const RUNNING_ROW = member(PROGRESS_STATUSES, 'running');

/** A progress row of a stage that failed. */
const FAILED_ROW = member(PROGRESS_STATUSES, 'failed');

/** A progress row reporting something a stage did or found. */
const DONE_ROW = member(PROGRESS_STATUSES, 'done');

/** The code-graph node kind of an event handler. */
const HANDLER_NODE = member(CODE_NODE_KINDS, 'handler');

/** What `session.end` reports when every modification was restored. */
const CLEAN_CLEANUP = member(CLEANUP_STATUSES, 'clean');

/** A modification record whose patch is on disk. */
const APPLIED_MODIFICATION = member(MODIFICATION_STATUSES, 'applied');

/** The feasibility codes this suite drives, one per scenario. */
const REJECTION = Object.freeze({
  symbolNotFound: member(FEASIBILITY_REJECTION_CODES, 'symbol-not-found'),
  fileNotIndexed: member(FEASIBILITY_REJECTION_CODES, 'file-not-indexed'),
  pathOutsideProject: member(FEASIBILITY_REJECTION_CODES, 'path-outside-project'),
  noAdapter: member(FEASIBILITY_REJECTION_CODES, 'no-adapter'),
  duplicateAction: member(FEASIBILITY_REJECTION_CODES, 'duplicate-action'),
} satisfies Readonly<Record<string, FeasibilityRejectionCode>>);

/**
 * The plan stage's fallback reasons this suite provokes. The stage exports the
 * union but no tuple, so these two are checked by the compiler alone.
 */
const FALLBACK_REASON = Object.freeze({
  modelOutputInvalid: 'model-output-invalid',
  normalizationFailed: 'normalization-failed',
} as const satisfies Readonly<Record<string, PlanRejectionReason>>);

/* -------------------------------------------------------------------------------------------------
 * The service's observable contracts this suite reads, and the corpus it reads them against
 * ---------------------------------------------------------------------------------------------- */

/**
 * The client registry's debug record for an authenticated connection, and the
 * principal role of the dev-server preload. The launcher answers once the child
 * prints its address; the preload's socket completes on its own schedule, so a
 * scenario waits for this record before planning — which is what makes the
 * server-tier half of every readiness verdict deterministic here.
 */
const CLIENT_CONNECTED_LOG = 'Client connected';
const SERVER_AGENT_ROLE = 'server-agent';

/** The `step` field of the plan stage's product-defect record for a normaliser failure. */
const NORMALIZE_STEP = 'normalize';

/** The two fixed halves of the AAP §0.5.5 degradation sentence. */
const DEGRADATION_OPENING = 'Could not enable ';
const DEGRADATION_CONTINUATION = ' Continuing with: ';

/** The investigation's event-handler row, worded verbatim as prompt §11, Step 8 prints it. */
const TRACED_EVENT_HANDLER_LABEL = 'Traced event handler';

/** Separators of a class row's detail: `‹finding›, ‹finding› · ‹origin file›`. */
const DETAIL_PART_SEPARATOR = ' · ';
const DETAIL_LIST_SEPARATOR = ', ';

/** The authoring payload the fixture README marks for this suite: refused by the authoring schema. */
const INVALID_PLAN_FIXTURE = 'model-output-invalid-plan.json';

/**
 * Facts about the `sample-project` corpus (`test/fixtures/README.md`): a Next.js
 * App Router app reaching PostgreSQL through `pg` alone, with no ORM, so the
 * driver adapter — never the ORM adapter — is the one that may claim database
 * tracking. Paths are project-relative POSIX, as every plan names them.
 */
const CORPUS = Object.freeze({
  /** The App Router's root directory. */
  appDirectory: 'app',
  /** The service module the route handler calls into. */
  serviceFile: 'src/server/services/trail-report.service.ts',
  /** The service function the route handler awaits. */
  serviceSymbol: 'loadTrailReport',
  /** The data-access module: the corpus's only `pool.query` call sites. */
  dataAccessFile: 'src/server/db/pool.ts',
  /** The route handler's directory; its `route.ts` is the corpus's one API route. */
  routeDirectory: 'app/api/trail-report',
  /** The directory the rename scenario moves the route handler to. */
  renamedRouteDirectory: 'app/api/trail-digest',
  /** The component whose click issues the request. */
  clickSiteFile: 'src/components/TrailCard.tsx',
  /** The route handler's module name inside its directory. */
  routeModule: 'route.ts',
  /** A module path the corpus does not contain. */
  unindexedFile: 'src/server/services/not-in-the-index.ts',
  /** A symbol name the corpus does not declare. */
  absentSymbol: 'notDeclaredInCorpus',
  /** The PostgreSQL driver package the corpus depends on. */
  driverPackage: 'pg',
  /** The ORM client package the corpus deliberately omits. */
  ormPackage: '@prisma/client',
});

/** A generic question: it names no file, component, route or symbol of the corpus. */
const QUESTION = 'Why is the report slow to load after I click the button?';

/** The same question, differing only in word order, filler words, case and punctuation. */
const QUESTION_REWORDED = 'Really, after I CLICK the button the report is SO slow to load... why?';

/** Identifier-shaped names that exist only in a question, never in the corpus. */
const QUESTION_ONLY_IDENTIFIERS = Object.freeze(['renderInvoiceGrid', 'InvoiceSummaryCard']);

/** A question naming only {@link QUESTION_ONLY_IDENTIFIERS}. */
const QUESTION_NAMING_ABSENT_SYMBOLS = `Why is ${QUESTION_ONLY_IDENTIFIERS[0] ?? ''} slow to load after I click ${QUESTION_ONLY_IDENTIFIERS[1] ?? ''} in the report?`;

/* -------------------------------------------------------------------------------------------------
 * Small utilities
 * ---------------------------------------------------------------------------------------------- */

/** Whether a value is a plain, non-array object. */
function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value of an `Ok`, or a thrown error naming `what` and the failure's code. */
function unwrap<T>(result: Result<T, DebuggenError>, what: string): T {
  if (isErr(result)) {
    throw new Error(`${what} failed (${result.error.code}): ${result.error.message}`, {
      cause: result.error,
    });
  }
  return result.value;
}

/** Drops the punctuation a degradation sentence closes a reason with. */
function withoutTrailingPunctuation(text: string): string {
  return text.replace(/[\s.!?;:,]+$/u, '');
}

/** Whether a string is one non-blank line. */
function isSingleLine(text: string): boolean {
  return text.trim().length > 0 && !/[\r\n]/u.test(text);
}

/** Orders strings by UTF-16 code unit, independently of the host locale. */
function byCodeUnit(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/** The identity keys of a list of actions, in order. */
function identities(actions: readonly InstrumentationAction[]): string[] {
  return actions.map((action) => actionIdentityKey(action));
}

/** A plan without its per-session identity (ids and session id), for comparing two sessions. */
function planShape(plan: InstrumentationPlan): unknown {
  return {
    version: plan.version,
    planVersion: plan.planVersion,
    objective: plan.objective,
    hypotheses: plan.hypotheses,
    capture: plan.capture,
    instrumentationTargets: plan.instrumentationTargets.map(
      ({ file, symbol, type, adapter, mode, rationale }) => ({
        file,
        symbol,
        type,
        adapter,
        mode,
        rationale,
      }),
    ),
  };
}

/** The relevant files of a session as a sorted comparison key: file, symbol and score. */
function relevantFileKeys(files: readonly RelevantFile[]): string[] {
  return files
    .map((entry) => JSON.stringify([entry.file, entry.symbol ?? null, entry.score]))
    .sort(byCodeUnit);
}

/**
 * The capture signals a set of actions enables, derived through the product's
 * own `deriveAgentHookConfig` and `deriveServerAgentSignals` — the derivation
 * the installer reports an `UnavailableSignal` in.
 */
function signalsOf(actions: readonly InstrumentationAction[]): readonly CaptureSignal[] {
  const hooks = deriveAgentHookConfig(actions);
  const server = deriveServerAgentSignals(actions);
  const enabled = new Set<string>();
  for (const key of AGENT_HOOK_KEYS) {
    if (hooks[key]) {
      enabled.add(key);
    }
  }
  for (const key of SERVER_AGENT_SIGNAL_KEYS) {
    const value: unknown = server[key];
    if (value === true || (Array.isArray(value) && value.length > 0)) {
      enabled.add(key);
    }
  }
  return CAPTURE_SIGNALS.filter((signal) => enabled.has(signal));
}

/** Every regular file under `root`, as project-relative POSIX paths. */
async function listFiles(root: string, relative = ''): Promise<string[]> {
  const entries = await readdir(relative === '' ? root : join(root, relative), {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort(byCodeUnit);
}

/** The corpus text of every file under `root`, joined — the haystack for "appears nowhere". */
async function corpusText(root: string): Promise<string> {
  const files = await listFiles(root);
  const texts = await Promise.all(files.map((file) => readFile(join(root, file), 'utf8')));
  return texts.join('\n');
}

/* -------------------------------------------------------------------------------------------------
 * The provider switch
 * ---------------------------------------------------------------------------------------------- */

/** One call the switch forwarded, with the provenance the request carried. */
interface ForwardedCall {
  readonly method: 'generateText' | 'generateStructured' | 'callTools';
  readonly stage: PromptStage;
  readonly promptVersion: string;
  readonly sessionId: string | undefined;
  /** The tool names a `callTools` request offered; empty for the other methods. */
  readonly toolNames: readonly string[];
}

/** The provider handed to `startHarness`, and the controls a scenario uses. */
interface ProviderSwitch {
  readonly provider: ModelProvider;
  /** Every call forwarded, in order, across all scenarios. */
  readonly calls: readonly ForwardedCall[];
  /** Installs a scripted provider (falling back to the deterministic one) for the next session. */
  script(steps: readonly ScriptedStep[]): ScriptedProvider;
  /** Returns to the plain deterministic provider. */
  release(): void;
}

/**
 * Builds the {@link ProviderSwitch}. Every method forwards to the current
 * provider unchanged — one attempt per call, no retry, no repair — so the
 * product's own `generateStructuredWithRepair` remains the only repair loop.
 */
function createProviderSwitch(): ProviderSwitch {
  const deterministic = unwrap(createDeterministicProvider(), 'The deterministic provider');
  let current: ModelProvider = deterministic;
  const calls: ForwardedCall[] = [];

  const note = (
    method: ForwardedCall['method'],
    request: ModelRequest,
    toolNames: readonly string[] = [],
  ): void => {
    calls.push({
      method,
      stage: request.metadata.stage,
      promptVersion: request.metadata.promptVersion,
      sessionId: request.metadata.sessionId,
      toolNames,
    });
  };

  const generateStructured: ModelProvider['generateStructured'] = (schema, request) => {
    note('generateStructured', request);
    return current.generateStructured(schema, request);
  };

  const provider: ModelProvider = {
    id: deterministic.id,
    generateText: (request) => {
      note('generateText', request);
      return current.generateText(request);
    },
    generateStructured,
    callTools: (request, tools) => {
      note(
        'callTools',
        request,
        tools.map((tool) => tool.name),
      );
      return current.callTools(request, tools);
    },
  };

  return {
    provider,
    calls,
    script: (steps) => {
      const scripted = createScriptedProvider(steps, { fallback: deterministic });
      current = scripted.provider;
      return scripted;
    },
    release: () => {
      current = deterministic;
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * The suite's one harness, one provider switch and one adapter registry
 * ---------------------------------------------------------------------------------------------- */

/** The provider seam every session of this file runs through. */
const providers = createProviderSwitch();

/**
 * The product's built-in adapter registry, constructed exactly as `startService`
 * constructs the one its instrumentation service and orchestrator share. Its
 * `canHandle` answers are read against each copy's own index, so "the live
 * registry" here means the same adapters deciding over the same code graph.
 */
const registry: AdapterRegistry = createAdapterRegistry();

/** The directory, inside a copy's temporary container, this suite's own index cache lives in. */
const SUITE_INDEX_CACHE = 'suite-index-cache';

/**
 * How long a hook that runs `count` sessions may take: each session's boot
 * budget (dev-server launch, preload handshake) plus its pipeline budget.
 */
function sessionBudgetMs(count: number): number {
  return count * (HARNESS_TIMEOUTS.boot + HARNESS_TIMEOUTS.pipeline);
}

let harnessRef: Harness | undefined;

/** The running harness. @throws Error Before `beforeAll` has booted it. */
function harness(): Harness {
  if (harnessRef === undefined) {
    throw new Error('The service harness has not been started.');
  }
  return harnessRef;
}

/** Sessions created and not yet ended — ended by the file's `afterAll` if a scenario could not. */
const openSessions = new Set<string>();

beforeAll(async () => {
  harnessRef = await startHarness({ provider: providers.provider });
}, HARNESS_TIMEOUTS.boot * 2);

afterAll(async () => {
  const running = harnessRef;
  if (running === undefined) {
    return;
  }
  // A scenario whose hook failed part-way can leave a session instrumented;
  // its cleanup still runs through `session.end` before the leak check, so
  // the copy is restored by the product rather than merely deleted.
  for (const sessionId of [...openSessions]) {
    await running.endSession(sessionId);
    openSessions.delete(sessionId);
  }
  await running.assertNoLeaks();
}, HARNESS_TIMEOUTS.teardown * 2);

/* -------------------------------------------------------------------------------------------------
 * Indexing a copy the way the service does, before any session touches it
 * ---------------------------------------------------------------------------------------------- */

/** A copy, its byte snapshot and its code index — all taken before its first session. */
interface IndexedCopy {
  readonly copy: FixtureProjectCopy;
  /** The copy's tree as the session found it; `assertTreeUnchanged` compares against this. */
  readonly baseline: TreeSnapshot;
  /** The service's own code-index loader's handles over the pristine copy. */
  readonly code: PipelineCodeHandles;
}

/**
 * Snapshots and indexes a copy with the service's `createCodeIndexLoader`.
 *
 * The index is taken **before** the session so the graph never contains a
 * patched body, and it is cached inside the copy's own temporary container —
 * outside the project root, so neither the snapshot nor the service's cache
 * under `$DEBUGGEN_HOME/index` is affected by it.
 */
async function indexCopy(copy: FixtureProjectCopy): Promise<IndexedCopy> {
  const baseline = await snapshotTree(copy.root);
  const loader: CodeIndexPort = createCodeIndexLoader({
    config: { indexCacheDir: join(copy.container, SUITE_INDEX_CACHE) },
    logger: noopLogger,
  });
  const code = unwrap(await loader.load(copy.root, { refresh: true }), `Indexing ${copy.root}`);
  return { copy, baseline, code };
}

/**
 * A stand-in for the journal and the backup store that holds nothing and
 * records every property read. Planning and feasibility never write to the
 * project, so any read is a boundary violation the scenarios report.
 */
function tripwire<T>(name: string, reads: string[]): T {
  return new Proxy(
    {},
    {
      get: (_target, key) => {
        reads.push(`${name}.${String(key)}`);
        return undefined;
      },
    },
  ) as unknown as T;
}

/** A read-only instrumentation context over a pristine index, and the tripwire reads it saw. */
interface SuiteContext {
  readonly context: InstrumentationContext;
  readonly writeReads: readonly string[];
}

/** The instrumentation context the feasibility gate and the adapters are asked through. */
function contextFor(indexed: IndexedCopy, sessionId: string, planVersion = 1): SuiteContext {
  const writeReads: string[] = [];
  const { code, copy } = indexed;
  const context: InstrumentationContext = {
    sessionId,
    projectRoot: copy.root,
    planVersion,
    debuggenHome: harness().home,
    logger: noopLogger,
    graph: code.graph,
    queries: code.queries,
    routeMap: code.routeMap,
    projectSummary: code.projectSummary,
    loaded: code.loaded,
    journal: tripwire<InstrumentationContext['journal']>('journal', writeReads),
    backups: tripwire<InstrumentationContext['backups']>('backups', writeReads),
    readiness: {},
    now: harness().now,
  };
  return { context, writeReads };
}

/** The feasibility report of `plan` over `suite`, with the live registry as resolver. */
function feasibilityOf(plan: InstrumentationPlan, suite: SuiteContext): FeasibilityReport {
  return checkPlanFeasibility(plan, suite.context, {
    resolver: contextBoundResolver(registry, suite.context),
  });
}

/* -------------------------------------------------------------------------------------------------
 * Running one session over HTTP and reading back everything it produced
 * ---------------------------------------------------------------------------------------------- */

/** One session, run to its settled state, and every observable it produced. */
interface SessionRun {
  readonly indexed: IndexedCopy;
  readonly question: string;
  /** The editor connection announcing the copy, which receives the session's broadcasts. */
  readonly editor: HarnessWsClient;
  /** The editor transcript index at which this session's traffic begins. */
  readonly messageMark: number;
  /** The captured-log index at which this session's records begin. */
  readonly logMark: number;
  /** The record `session.create` answered with. */
  readonly created: SessionRecord;
  /** The record once the pipeline settled: failed, or installed with its prompt versions pinned. */
  readonly settled: SessionRecord;
  /** Every model call the session made, in order. */
  readonly calls: readonly ForwardedCall[];
  /** The scripted provider that answered this session, when it was scripted. */
  readonly scripted: ScriptedProvider | undefined;
  /** The session's stored progress lines. */
  readonly progress: readonly ProgressEntry[];
}

/**
 * Whether the pipeline's run has settled: it failed, or it installed and
 * recorded its prompt versions — the last write of a successful run.
 */
function hasSettled(record: SessionRecord): boolean {
  return (
    record.status === FAILED_STATUS ||
    (Object.keys(record.promptVersions).length > 0 && PROCEEDING_STATUSES.includes(record.status))
  );
}

/**
 * Waits until the dev-server preload of `projectRoot` has authenticated. The
 * launch answers once the child prints its address; the preload's socket
 * completes on its own schedule, and the server tier's readiness depends on it.
 */
async function waitForServerAgent(projectRoot: string, fromRecord: number): Promise<void> {
  const logger = harness().logger;
  await waitUntil(
    () =>
      logger.records
        .slice(fromRecord)
        .some(
          (record) =>
            record.message === CLIENT_CONNECTED_LOG &&
            record.fields['role'] === SERVER_AGENT_ROLE &&
            record.fields['projectRoot'] === projectRoot,
        )
        ? true
        : undefined,
    `the dev-server preload of ${projectRoot} has connected`,
    HARNESS_TIMEOUTS.boot,
  );
}

/**
 * Launches the copy's dev server, opens a session with `question`, and waits
 * for the pipeline to settle. A `script` is served to this session only and
 * released as soon as its run has settled.
 */
async function runSession(
  indexed: IndexedCopy,
  question: string,
  script?: readonly ScriptedStep[],
): Promise<SessionRun> {
  const service = harness();
  const { copy } = indexed;
  const logMark = service.logger.records.length;
  unwrap(await service.launchDevServer(copy.root), `Launching the dev server of ${copy.root}`);
  await waitForServerAgent(copy.root, logMark);

  const editor = await service.editor(copy.root);
  const messageMark = editor.received.length;
  const callMark = providers.calls.length;
  const scripted = script === undefined ? undefined : providers.script(script);

  let created: SessionRecord;
  let settled: SessionRecord;
  try {
    created = await service.createSession({ projectRoot: copy.root, question });
    openSessions.add(created.id);
    settled = await service.waitForSession(created.id, hasSettled);
  } finally {
    providers.release();
  }
  await editor.flush();

  const progress = unwrap(
    service.repos.sessions.listProgress(created.id),
    `Reading the stored progress of ${created.id}`,
  );
  return {
    indexed,
    question,
    editor,
    messageMark,
    logMark,
    created,
    settled,
    calls: providers.calls.slice(callMark),
    scripted,
    progress,
  };
}

/**
 * Ends a session through `session.end` — the real cleanup — and proves the
 * copy byte-identical to the tree the session found, with no instrumentation
 * marker anywhere in it.
 */
async function endRun(run: SessionRun): Promise<void> {
  const ended = unwrap(await harness().endSession(run.created.id), `Ending ${run.created.id}`);
  openSessions.delete(run.created.id);
  expect(ended.cleanup).toBe(CLEAN_CLEANUP);
  await assertTreeUnchanged(run.indexed.copy.root, run.indexed.baseline);
  const text = await corpusText(run.indexed.copy.root);
  for (const marker of INSTRUMENTATION_MARKERS) {
    expect(text).not.toContain(marker);
  }
}

/** The run a later scenario depends on. @throws Error When its hook did not produce it. */
function requireRun(run: SessionRun | undefined, what: string): SessionRun {
  if (run === undefined) {
    throw new Error(`${what} did not run; see the failure of the hook that starts it.`);
  }
  return run;
}

/** The latest plan a settled session recorded. @throws Error When it recorded none. */
function recordedPlan(run: SessionRun): InstrumentationPlan {
  const plan = run.settled.plans.at(-1);
  if (plan === undefined) {
    throw new Error(`Session ${run.created.id} recorded no plan.`);
  }
  return plan;
}

/** The model calls a run made for one stage. */
function callsFor(run: SessionRun, stage: PromptStage): readonly ForwardedCall[] {
  return run.calls.filter((call) => call.stage === stage);
}

/**
 * A sequence with each run of equal consecutive entries collapsed onto its
 * first: the stages a session asked the model, in order, however many turns
 * each took — the investigate stage is asked once per query turn and once for
 * its answer.
 */
function collapseRepeats<T>(values: readonly T[]): T[] {
  return values.filter((value, index) => index === 0 || values[index - 1] !== value);
}

/** The session's `instrumentation.ready` payloads, validated against protocol's schema. */
function readyPayloads(run: SessionRun): InstrumentationReadyPayload[] {
  const payloads: InstrumentationReadyPayload[] = [];
  for (const [index, message] of run.editor.received.entries()) {
    if (
      index >= run.messageMark &&
      isMessageOfType(message, 'instrumentation.ready') &&
      message.payload.sessionId === run.created.id
    ) {
      const parsed = instrumentationReadyPayloadSchema.safeParse(message.payload);
      expect(parsed.success, 'instrumentation.ready must parse against its schema').toBe(true);
      payloads.push(message.payload);
    }
  }
  return payloads;
}

/** The session records this session's `session.updated` broadcasts carried, in order. */
function broadcastRecords(run: SessionRun): SessionRecord[] {
  const records: SessionRecord[] = [];
  for (const [index, message] of run.editor.received.entries()) {
    if (
      index >= run.messageMark &&
      isMessageOfType(message, 'session.updated') &&
      message.payload.session.id === run.created.id
    ) {
      records.push(message.payload.session);
    }
  }
  return records;
}

/** The captured log records this session's run wrote that satisfy `predicate`. */
function logsOf(
  run: SessionRun,
  predicate: (record: CapturedLogRecord) => boolean,
): readonly CapturedLogRecord[] {
  return harness().logger.records.slice(run.logMark).filter(predicate);
}

/**
 * The runtime-mode actions the live registry's handling adapters propose for
 * a context and an understanding — the capabilities a genuine fallback is
 * assembled from — deduplicated by identity, as the plan stage deduplicates.
 */
async function runtimeProposals(
  context: InstrumentationContext,
  understanding: ProblemUnderstanding,
): Promise<InstrumentationAction[]> {
  const resolver = contextBoundResolver(registry, context);
  const seen = new Set<string>();
  const proposals: InstrumentationAction[] = [];
  for (const adapter of registry.handling(context)) {
    for (const action of await adapter.createPlan(context, understanding)) {
      const resolution = resolver.resolveActionType(action.type);
      const key = actionIdentityKey(action);
      if (action.mode === RUNTIME_MODE && resolution?.mode === RUNTIME_MODE && !seen.has(key)) {
        seen.add(key);
        proposals.push(action);
      }
    }
  }
  return proposals;
}

/**
 * Asserts every action of `plan` carries the adapter and mode the live
 * registry assigns its type in `context`, a product-shaped id and a rationale.
 */
function expectRegistryNormalized(
  plan: InstrumentationPlan,
  context: InstrumentationContext,
): void {
  const ids = new Set<string>();
  for (const action of plan.instrumentationTargets) {
    expect(action.id).toMatch(ACTION_ID_PATTERN);
    ids.add(action.id);
    expect(INSTRUMENTATION_ACTION_TYPES).toContain(action.type);
    expect(INSTRUMENTATION_MODES).toContain(action.mode);
    expect(registry.resolveActionType(action.type, context)).toEqual({
      adapter: action.adapter,
      mode: action.mode,
    });
    expect(
      registry.claimants(context, action.type).map((adapter) => adapter.id),
      `a registered adapter must claim ${action.type}`,
    ).toContain(action.adapter);
    expect(isSingleLine(action.rationale)).toBe(true);
  }
  expect(ids.size, 'action ids must be unique within a plan').toBe(
    plan.instrumentationTargets.length,
  );
}

/** The prompt selection of the committed `prompts/manifest.json`, cross-checked with the loader. */
async function manifestSelection(): Promise<Readonly<Record<string, string>>> {
  const loader = createPromptLoader({ promptsDir: PROMPTS_DIR, env: {} });
  const raw: unknown = JSON.parse(await readFile(loader.manifestPath, 'utf8'));
  const parsed = promptManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`The committed prompt manifest does not parse: ${parsed.error.message}`);
  }
  const selection = Object.fromEntries(
    Object.entries(parsed.data.stages).map(([stage, entry]) => [stage, entry.current]),
  );
  expect(unwrap(loader.versions(), 'Reading the manifest-selected prompt versions')).toEqual(
    selection,
  );
  return selection;
}

/** The `dependencies` of a project's `package.json`. */
async function dependenciesOf(root: string): Promise<Readonly<Record<string, unknown>>> {
  const manifest: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!isPlainObject(manifest) || !isPlainObject(manifest['dependencies'])) {
    throw new Error(`${root}/package.json declares no dependencies object.`);
  }
  return manifest['dependencies'];
}

/** Whether `file` is a regular file under `root`. */
async function isFileIn(root: string, file: string): Promise<boolean> {
  try {
    return (await stat(join(root, file))).isFile();
  } catch {
    return false;
  }
}

/**
 * Asserts one relevant file is grounded in the pristine index: the file is on
 * disk and indexed, and its `symbol` is one of the three things investigation
 * names — the route path the route map gives the file, the file itself (a
 * file-level finding), or a declaration the code graph resolves.
 */
async function expectGroundedRelevantFile(
  entry: RelevantFile,
  indexed: IndexedCopy,
): Promise<void> {
  const { graph, queries, routeMap } = indexed.code;
  expect(relevantFileSchema.safeParse(entry).success).toBe(true);
  expect(
    await isFileIn(indexed.copy.root, entry.file),
    `${entry.file} must exist in the copy`,
  ).toBe(true);
  expect(graph.nodesByFile(entry.file).length, `${entry.file} must be indexed`).toBeGreaterThan(0);
  expect(isSingleLine(entry.reason)).toBe(true);
  expect(entry.score).toBeGreaterThan(0);
  expect(entry.score).toBeLessThanOrEqual(1);
  const symbol = entry.symbol;
  if (symbol === undefined) {
    return;
  }
  const routePaths = routeMap.entries
    .filter((route) => route.file === entry.file)
    .map((route) => route.routePath);
  const grounded =
    symbol === entry.file || routePaths.includes(symbol) || queries.hasSymbol(entry.file, symbol);
  expect(grounded, `${entry.file} › ${symbol} must resolve in the code graph`).toBe(true);
}

/** The index of the first stored progress line of `stage`, or `-1`. */
function firstProgressIndex(run: SessionRun, stage: string): number {
  return run.progress.findIndex((entry) => entry.stage === stage);
}

/** The generic-question session, which the genericity scenarios compare against. */
let happyRun: SessionRun | undefined;

/* -------------------------------------------------------------------------------------------------
 * The committed invalid-plan fixture, read and taken apart with the product's own schemas
 * ---------------------------------------------------------------------------------------------- */

/** `model-output-invalid-plan.json`, with the parts the scenarios reuse picked out. */
interface InvalidPlanFixture {
  /** The payload exactly as committed, for the authoring schema to refuse. */
  readonly raw: unknown;
  readonly objective: string;
  readonly capture: readonly string[];
  readonly hypotheses: readonly string[];
  readonly targets: readonly unknown[];
  /** The one target whose `file` climbs out of the project root. */
  readonly escapingFile: string;
}

/** Whether a value is an array of strings. */
function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Reads the committed invalid authoring payload the fixture README marks for
 * this suite and picks out its objective, capture list, hypotheses, targets
 * and escaping path.
 */
function readInvalidPlanFixture(): InvalidPlanFixture {
  const raw = readFixtureJson(INVALID_PLAN_FIXTURE);
  if (!isPlainObject(raw)) {
    throw new Error(`${INVALID_PLAN_FIXTURE} is not a JSON object.`);
  }
  const { objective, capture, hypotheses, instrumentationTargets } = raw;
  if (
    typeof objective !== 'string' ||
    !isStringArray(capture) ||
    !isStringArray(hypotheses) ||
    !Array.isArray(instrumentationTargets)
  ) {
    throw new Error(`${INVALID_PLAN_FIXTURE} lacks an objective, capture, hypotheses or targets.`);
  }
  const targets: readonly unknown[] = instrumentationTargets;
  const escapingFile = targets
    .map((target) => (isPlainObject(target) ? target['file'] : undefined))
    .find((file): file is string => typeof file === 'string' && file.startsWith('../'));
  if (escapingFile === undefined) {
    throw new Error(`${INVALID_PLAN_FIXTURE} names no target outside the project root.`);
  }
  return { raw, objective, capture, hypotheses, targets, escapingFile };
}

/**
 * The fixture's one valid target: the only target that, alone in a plan,
 * passes the authoring schema.
 *
 * @throws Error When the fixture does not hold exactly one.
 */
function validTargetOf(fixture: InvalidPlanFixture): InstrumentationTargetInput {
  const valid = fixture.targets.flatMap((target) => {
    const parsed = instrumentationPlanInputSchema.safeParse({
      objective: fixture.objective,
      capture: fixture.capture,
      instrumentationTargets: [target],
    });
    return parsed.success ? parsed.data.instrumentationTargets : [];
  });
  const [only, ...rest] = valid;
  if (only === undefined || rest.length > 0) {
    throw new Error(`${INVALID_PLAN_FIXTURE} must hold exactly one valid target.`);
  }
  return only;
}

/** A schema-valid authoring payload asking only for targetless database-query tracking. */
function databaseOnlyInput(fixture: InvalidPlanFixture): InstrumentationPlanInput {
  return {
    objective: fixture.objective,
    capture: [...fixture.capture],
    instrumentationTargets: [
      { file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL, type: DB_QUERY_TRACKING },
    ],
  };
}

/* -------------------------------------------------------------------------------------------------
 * Derived copies: a corpus without its database driver, and one with its route renamed
 * ---------------------------------------------------------------------------------------------- */

/** The route path the App Router gives a route directory: the directory below `app`. */
function routePathOf(routeDirectory: string): string {
  if (!routeDirectory.startsWith(`${CORPUS.appDirectory}/`)) {
    throw new Error(`${routeDirectory} is not under ${CORPUS.appDirectory}/.`);
  }
  return routeDirectory.slice(CORPUS.appDirectory.length);
}

/** `value` with every occurrence of `from` in its JSON replaced by `to`. */
function substituted<T>(value: T, from: string, to: string): T {
  // The round trip only ever re-reads what `JSON.stringify` wrote for `value`.
  return JSON.parse(JSON.stringify(value).replaceAll(from, to)) as T;
}

let driverlessPromise: Promise<IndexedCopy> | undefined;

/**
 * A copy with the corpus's only database signal removed — the `pg` dependency
 * and the data-access module holding every `pool.query` call site — so no
 * registered adapter can claim database-query tracking. Built once and shared:
 * the feasibility scenario reads its index, and the validation-order scenario
 * runs a session on it.
 */
function driverlessCopy(): Promise<IndexedCopy> {
  driverlessPromise ??= (async () => {
    const copy = await harness().copyFixtureProject();
    await rm(join(copy.root, CORPUS.dataAccessFile));
    const manifestPath = join(copy.root, 'package.json');
    const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!isPlainObject(manifest)) {
      throw new Error(`${manifestPath} is not a JSON object.`);
    }
    const dependencies = await dependenciesOf(copy.root);
    const withoutDriver = Object.fromEntries(
      Object.entries(dependencies).filter(([name]) => name !== CORPUS.driverPackage),
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, dependencies: withoutDriver }, null, 2)}\n`,
    );
    return indexCopy(copy);
  })();
  return driverlessPromise;
}

/**
 * A copy whose API route is moved to {@link CORPUS.renamedRouteDirectory},
 * with the click site's request URL updated to match — a rename as a
 * developer would make it, touching nothing the pipeline could key on but the
 * code itself.
 */
async function renamedRouteCopy(): Promise<IndexedCopy> {
  const copy = await harness().copyFixtureProject();
  const from = routePathOf(CORPUS.routeDirectory);
  const to = routePathOf(CORPUS.renamedRouteDirectory);
  await rename(
    join(copy.root, CORPUS.routeDirectory),
    join(copy.root, CORPUS.renamedRouteDirectory),
  );
  const clickSite = join(copy.root, CORPUS.clickSiteFile);
  const source = await readFile(clickSite, 'utf8');
  if (!source.includes(from)) {
    throw new Error(`${CORPUS.clickSiteFile} no longer requests ${from}.`);
  }
  await writeFile(clickSite, source.replaceAll(from, to));
  return indexCopy(copy);
}

/* -------------------------------------------------------------------------------------------------
 * The degradation sentence of AAP §0.5.5
 * ---------------------------------------------------------------------------------------------- */

/** The three parts of "Could not enable ‹signal›: ‹reason›. Continuing with: ‹enabled›." */
interface DegradationSentence {
  readonly label: string;
  readonly reason: string;
  readonly continuation: string;
}

/**
 * Splits a degradation sentence into its parts.
 *
 * @throws Error When `message` does not have the sentence's fixed shape.
 */
function parseDegradation(message: string): DegradationSentence {
  const continuationAt = message.lastIndexOf(DEGRADATION_CONTINUATION);
  if (!message.startsWith(DEGRADATION_OPENING) || continuationAt < 0) {
    throw new Error(`Not a degradation sentence: ${message}`);
  }
  const head = message.slice(DEGRADATION_OPENING.length, continuationAt);
  const separatorAt = head.indexOf(': ');
  if (separatorAt <= 0) {
    throw new Error(`The degradation sentence names no signal: ${message}`);
  }
  return {
    label: head.slice(0, separatorAt),
    reason: withoutTrailingPunctuation(head.slice(separatorAt + 2)),
    continuation: withoutTrailingPunctuation(
      message.slice(continuationAt + DEGRADATION_CONTINUATION.length),
    ),
  };
}

/* -------------------------------------------------------------------------------------------------
 * The suite
 * ---------------------------------------------------------------------------------------------- */

describe('pipeline-deterministic', () => {
  it('names only members of the vocabularies the product owns', () => {
    for (const code of Object.values(REJECTION)) {
      expect(isFeasibilityRejectionCode(code)).toBe(true);
    }
    expect(PIPELINE_STAGE_ORDER).toEqual(expect.arrayContaining([...INITIAL_MODEL_STAGES]));
    expect(PIPELINE_STAGE_ORDER).toContain(CAPTURE_STAGE);
    const promptStageNames: readonly string[] = PROMPT_STAGES;
    expect(promptStageNames).not.toContain(CAPTURE_STAGE);
    expect(INITIAL_MODEL_STAGES.every((stage) => PROMPT_STAGES.includes(stage))).toBe(true);
    expect(DEFAULT_MAX_REPAIRS).toBeGreaterThanOrEqual(1);
  });

  /* -----------------------------------------------------------------------------------------------
   * Phase 2 — a generic question, end to end
   * -------------------------------------------------------------------------------------------- */

  describe('a generic question, end to end', () => {
    let happy: SessionRun | undefined;
    let happySuite: SuiteContext | undefined;

    beforeAll(async () => {
      const indexed = await indexCopy(harness().requireProject());
      happy = await runSession(indexed, QUESTION);
      happySuite = contextFor(indexed, happy.created.id, recordedPlan(happy).planVersion);
      happyRun = happy;
    }, sessionBudgetMs(1));

    /** The happy run and its read-only context. */
    function subject(): { readonly run: SessionRun; readonly suite: SuiteContext } {
      const run = requireRun(happy, 'The generic-question session');
      if (happySuite === undefined) {
        throw new Error('The generic-question session has no instrumentation context.');
      }
      return { run, suite: happySuite };
    }

    it('runs against the copied corpus, the committed prompts and a pg-only driver signal', async () => {
      const { run, suite } = subject();
      const service = harness();
      expect(run.indexed.copy.name).toBe(DEFAULT_FIXTURE_PROJECT);
      expect(run.indexed.copy.root.startsWith('/')).toBe(true);
      expect(run.indexed.copy.root).not.toContain('\\');
      expect(service.env['DEBUGGEN_PROMPTS_DIR']).toBe(PROMPTS_DIR);
      expect(service.config.promptsDir).toBe(PROMPTS_DIR);

      const dependencies = await dependenciesOf(run.indexed.copy.root);
      expect(Object.hasOwn(dependencies, CORPUS.driverPackage)).toBe(true);
      expect(Object.hasOwn(dependencies, CORPUS.ormPackage)).toBe(false);

      const routeFile = `${CORPUS.routeDirectory}/${CORPUS.routeModule}`;
      for (const file of [
        routeFile,
        CORPUS.serviceFile,
        CORPUS.dataAccessFile,
        CORPUS.clickSiteFile,
      ]) {
        expect(
          run.indexed.code.graph.nodesByFile(file).length,
          `${file} is indexed`,
        ).toBeGreaterThan(0);
      }

      const claimants = registry.claimants(suite.context, DB_QUERY_TRACKING).map((a) => a.id);
      expect(claimants).toContain(POSTGRES_ADAPTER_ID);
      expect(claimants).not.toContain(PRISMA_ADAPTER_ID);
      expect(registry.resolveActionType(DB_QUERY_TRACKING, suite.context)?.adapter).toBe(
        POSTGRES_ADAPTER_ID,
      );
    });

    it('runs understand → investigate → plan, asking understand and plan once and investigate once per turn, and installs', () => {
      const { run } = subject();
      expect(run.question).toBe(QUESTION);
      expect(sessionRecordSchema.safeParse(run.settled).success).toBe(true);
      expect(PROCEEDING_STATUSES).toContain(run.settled.status);
      // The stages in order, each asked in one stretch. The investigate stage's
      // turns follow the code graph from what its seeds resolved — at least one,
      // and never more than its query allowance plus the answering turn.
      expect(collapseRepeats(run.calls.map((call) => call.stage))).toEqual([
        ...INITIAL_MODEL_STAGES,
      ]);
      expect(callsFor(run, UNDERSTAND_STAGE)).toHaveLength(1);
      expect(callsFor(run, PLAN_STAGE)).toHaveLength(1);
      expect(callsFor(run, INVESTIGATE_STAGE).length).toBeGreaterThanOrEqual(1);
      expect(callsFor(run, INVESTIGATE_STAGE).length).toBeLessThanOrEqual(
        CODE_TOOL_LIMITS.maxCallsPerStage + 1,
      );
      for (const call of run.calls) {
        expect(call.sessionId).toBe(run.created.id);
      }

      // Every stage reported progress inside its Step-8 group, in order: the investigation within
      // "Understanding problem" and planning within "Preparing instrumentation", so the wire
      // carries each of those two groups as one run of rows.
      const order = [...INITIAL_MODEL_STAGES, INSTRUMENT_STAGE].map((stage) =>
        firstProgressIndex(run, PROGRESS_STAGE_GROUPS[stage]),
      );
      expect(
        order.every((index) => index >= 0),
        'every stage reported progress',
      ).toBe(true);
      expect([...order].sort((left, right) => left - right)).toEqual(order);
      expect(collapseRepeats(run.progress.map((entry) => entry.stage)).slice(0, 2)).toEqual([
        UNDERSTAND_STAGE,
        INSTRUMENT_STAGE,
      ]);

      // No model stage failed. The only failed rows are the installer's
      // per-signal readiness sentences for the browser tier — no page agent
      // reports in this suite — each carrying the hint that clears it: the
      // degraded-but-proceeding outcome of AAP §0.5.5, never a stage failure.
      const failedRows = run.progress.filter((entry) => entry.status === FAILED_ROW);
      for (const stage of INITIAL_MODEL_STAGES) {
        expect(failedRows.map((entry) => entry.stage)).not.toContain(stage);
      }
      for (const entry of failedRows) {
        expect(entry.stage).toBe(INSTRUMENT_STAGE);
        expect(entry.message.startsWith(DEGRADATION_OPENING), entry.message).toBe(true);
        expect(typeof entry.detail === 'string' && isSingleLine(entry.detail), entry.message).toBe(
          true,
        );
      }
    });

    it('words the event-handler class as one "Traced event handler" row whose detail is its evidence', async () => {
      const { run } = subject();
      const { graph } = run.indexed.code;
      const corpusFiles = await listFiles(run.indexed.copy.root);
      const handlerNodes = corpusFiles.flatMap((file) =>
        graph.nodesByFile(file).filter((node) => node.kind === HANDLER_NODE),
      );
      const handlerNames = handlerNodes.map((node) => node.name);

      /** A handler row's detail, `‹symbols› · ‹file›`: declared handlers, and a file declaring one. */
      const expectHandlerEvidence = (detail: unknown): void => {
        expect(
          typeof detail === 'string' && isSingleLine(detail),
          'the row carries its evidence',
        ).toBe(true);
        const parts = typeof detail === 'string' ? detail.split(DETAIL_PART_SEPARATOR) : [];
        expect(parts).toHaveLength(2);
        const [symbols = '', file = ''] = parts;
        const named = symbols.split(DETAIL_LIST_SEPARATOR);
        for (const symbol of named) {
          expect(handlerNames).toContain(symbol);
        }
        expect(corpusFiles).toContain(file);
        expect(
          handlerNodes.some((node) => node.file === file && named.includes(node.name)),
          `${file} declares a traced handler`,
        ).toBe(true);
      };

      // The real pipeline: the class is at most one row, worded exactly as Step 8 prints it —
      // never a handler symbol folded into the message — with its evidence in the detail, and
      // listed under "Understanding problem", the group the investigation reports in.
      const traced = run.progress.filter((entry) => entry.message.startsWith('Traced'));
      for (const entry of traced) {
        expect(entry.stage).toBe(PROGRESS_STAGE_GROUPS[INVESTIGATE_STAGE]);
      }
      expect(traced.length).toBeLessThanOrEqual(1);
      for (const entry of traced) {
        expect(entry.message).toBe(TRACED_EVENT_HANDLER_LABEL);
        expect(entry.status).toBe(DONE_ROW);
        expectHandlerEvidence(entry.detail);
      }

      // The corpus's own handler: the click site declares one, and the service's row builder
      // turns it into exactly one such row, whose detail is that handler's symbol and file.
      const clickSite = handlerNodes.filter((node) => node.file === CORPUS.clickSiteFile);
      expect(clickSite.length, `${CORPUS.clickSiteFile} declares an event handler`).toBeGreaterThan(
        0,
      );
      const rows = buildInvestigationRows({
        eventHandlers: clickSite.map((node) => node.name),
        relevantFiles: clickSite.map((node) =>
          relevantFileSchema.parse({
            file: node.file,
            symbol: node.name,
            reason: 'The code graph declares this event handler.',
            score: 1,
          }),
        ),
      });
      expect(rows).toEqual([
        {
          stage: PROGRESS_STAGE_GROUPS[INVESTIGATE_STAGE],
          status: DONE_ROW,
          message: TRACED_EVENT_HANDLER_LABEL,
          detail: `${clickSite.map((node) => node.name).join(DETAIL_LIST_SEPARATOR)}${DETAIL_PART_SEPARATOR}${CORPUS.clickSiteFile}`,
        },
      ]);
      expectHandlerEvidence(rows[0]?.detail);
    });

    it('announces the normalized plan on instrumentation.plan, parsing against protocol’s schema', async () => {
      const { run } = subject();
      const message = await waitFor(
        run.editor,
        'instrumentation.plan',
        (candidate, index) =>
          index >= run.messageMark && candidate.payload.sessionId === run.created.id,
      );
      expect(instrumentationPlanPayloadSchema.safeParse(message.payload).success).toBe(true);

      const plan = message.payload.plan;
      expect(plan).toEqual(recordedPlan(run));
      expect(
        unwrap(
          harness().repos.sessions.getPlan(run.created.id, plan.planVersion),
          'Reading the plan',
        ),
      ).toEqual(plan);
      expect(Object.keys(plan).sort(byCodeUnit)).toEqual(
        [
          'capture',
          'hypotheses',
          'instrumentationTargets',
          'objective',
          'planVersion',
          'sessionId',
          'version',
        ].sort(byCodeUnit),
      );
      expect(plan.version).toBe(INSTRUMENTATION_PLAN_VERSION);
      expect(plan.planVersion).toBe(1);
      expect(plan.sessionId).toBe(run.created.id);
      expect(isSingleLine(plan.objective)).toBe(true);
      expect(Array.isArray(plan.hypotheses)).toBe(true);
      expect(plan.capture.length).toBeGreaterThan(0);
      expect(plan.instrumentationTargets.length).toBeGreaterThan(0);
    });

    it('carries only actions the live registry normalized: ids, adapters, modes and rationales', () => {
      const { run, suite } = subject();
      const plan = recordedPlan(run);
      expectRegistryNormalized(plan, suite.context);

      const unclaimed = INSTRUMENTATION_ACTION_TYPES.filter(
        (type) => registry.resolveActionType(type, suite.context) === undefined,
      );
      for (const action of plan.instrumentationTargets) {
        expect(unclaimed, 'a type no adapter claims must never reach a plan').not.toContain(
          action.type,
        );
      }

      const database = plan.instrumentationTargets.filter((a) => a.type === DB_QUERY_TRACKING);
      expect(database.length).toBeGreaterThan(0);
      for (const action of database) {
        expect(action.adapter).toBe(POSTGRES_ADAPTER_ID);
      }
      expect(plan.instrumentationTargets.map((action) => action.adapter)).not.toContain(
        PRISMA_ADAPTER_ID,
      );

      const modes = new Set(plan.instrumentationTargets.map((action) => action.mode));
      expect(modes).toEqual(new Set([RUNTIME_MODE, PATCH_MODE]));
      for (const action of plan.instrumentationTargets) {
        if (action.mode === PATCH_MODE) {
          expect(isTargetlessAction(action), 'a patch always names its file and symbol').toBe(
            false,
          );
        }
      }
    });

    it('is accepted by the internal schema and feasible against the copied corpus’s code graph', async () => {
      const { run, suite } = subject();
      const plan = recordedPlan(run);
      expect(instrumentationPlanSchema.safeParse(plan).success).toBe(true);

      const report = feasibilityOf(plan, suite);
      expect(report.rejected).toEqual([]);
      expect(identities(report.feasible)).toEqual(identities(plan.instrumentationTargets));
      for (const action of plan.instrumentationTargets) {
        if (!isTargetlessAction(action)) {
          expect(await isFileIn(run.indexed.copy.root, action.file)).toBe(true);
          expect(
            run.indexed.code.queries.hasSymbol(action.file, action.symbol),
            `${action.file} › ${action.symbol} resolves`,
          ).toBe(true);
        }
      }
      expect(suite.writeReads, 'feasibility never touches the journal or backups').toEqual([]);
    });

    it('installs through the real installer: every patch applied, recorded and announced', async () => {
      const { run } = subject();
      const plan = recordedPlan(run);
      const patchedFiles = [
        ...new Set(
          plan.instrumentationTargets
            .filter((action) => action.mode === PATCH_MODE)
            .map((action) => action.file),
        ),
      ].sort(byCodeUnit);
      expect(patchedFiles.length).toBeGreaterThan(0);

      const modifications = run.settled.modifications;
      expect(modifications.map((record) => record.file).sort(byCodeUnit)).toEqual(patchedFiles);
      for (const record of modifications) {
        expect(record.status).toBe(APPLIED_MODIFICATION);
        const text = await readFile(join(run.indexed.copy.root, record.file), 'utf8');
        expect(INSTRUMENTATION_MARKERS.some((marker) => text.includes(marker))).toBe(true);
      }

      const ready = readyPayloads(run).at(-1);
      expect(ready, 'instrumentation.ready was announced').toBeDefined();
      expect(ready?.applied.map((record) => record.file).sort(byCodeUnit)).toEqual(patchedFiles);
      expect(ready?.runtimeHooks.length).toBeGreaterThan(0);
    });

    it('persists relevant files that name real paths and symbols of the corpus', async () => {
      const { run } = subject();
      const relevant = run.settled.relevantFiles;
      expect(relevant.length).toBeGreaterThan(0);
      for (const entry of relevant) {
        await expectGroundedRelevantFile(entry, run.indexed);
      }
      const routeFile = `${CORPUS.routeDirectory}/${CORPUS.routeModule}`;
      expect(relevant.map((entry) => entry.file)).toContain(routeFile);

      const stored = unwrap(harness().repos.sessions.get(run.created.id), 'Reading the session');
      expect(stored?.relevantFiles).toEqual(relevant);
      expect(broadcastRecords(run).at(-1)?.relevantFiles).toEqual(relevant);
    });

    it('pins one prompt version per model stage — the manifest’s selection — and none for capture', async () => {
      const { run } = subject();
      const selection = await manifestSelection();
      const versions = run.settled.promptVersions;

      expect(versions).toEqual(selection);
      expect(Object.keys(versions).sort(byCodeUnit)).toEqual([...PROMPT_STAGES].sort(byCodeUnit));
      for (const stage of PIPELINE_STAGE_ORDER) {
        const callsTheModel = PROMPT_STAGES.some((promptStage) => promptStage === stage);
        expect(Object.hasOwn(versions, stage), `${stage} owns a prompt version`).toBe(
          callsTheModel,
        );
      }
      expect(Object.hasOwn(versions, CAPTURE_STAGE)).toBe(false);
      for (const call of run.calls) {
        expect(call.promptVersion).toBe(selection[call.stage]);
      }

      const stored = unwrap(harness().repos.sessions.get(run.created.id), 'Reading the session');
      expect(stored?.promptVersions).toEqual(versions);
    });

    it('ends through the real cleanup, restoring the copy and leaving the committed corpus untouched', async () => {
      const { run } = subject();
      await endRun(run);
      await assertTreeUnchanged(fixturePath(DEFAULT_FIXTURE_PROJECT), run.indexed.copy.snapshot);
    });
  });

  /* -----------------------------------------------------------------------------------------------
   * Phase 3 — feasibility rejections, returned as data
   * -------------------------------------------------------------------------------------------- */

  describe('feasibility rejections against the real code graph', () => {
    let fixture: InvalidPlanFixture | undefined;
    let valid: InstrumentationTargetInput | undefined;
    let authored: InstrumentationPlanInput | undefined;
    let rejecting: SessionRun | undefined;
    let rejectingSuite: SuiteContext | undefined;

    beforeAll(async () => {
      fixture = readInvalidPlanFixture();
      valid = validTargetOf(fixture);
      authored = {
        objective: fixture.objective,
        capture: [...fixture.capture],
        instrumentationTargets: [
          valid,
          { file: CORPUS.serviceFile, symbol: CORPUS.absentSymbol, type: FUNCTION_TIMING },
          { file: CORPUS.unindexedFile, symbol: CORPUS.serviceSymbol, type: FUNCTION_TIMING },
          valid,
        ],
      };
      const indexed = await indexCopy(await harness().copyFixtureProject());
      rejecting = await runSession(indexed, QUESTION, [{ stage: PLAN_STAGE, raw: authored }]);
      rejectingSuite = contextFor(
        indexed,
        rejecting.created.id,
        recordedPlan(rejecting).planVersion,
      );
    }, sessionBudgetMs(1));

    /** Everything the scenario built. */
    function subject(): {
      readonly fixture: InvalidPlanFixture;
      readonly valid: InstrumentationTargetInput;
      readonly authored: InstrumentationPlanInput;
      readonly run: SessionRun;
      readonly suite: SuiteContext;
    } {
      const run = requireRun(rejecting, 'The feasibility-rejection session');
      if (
        fixture === undefined ||
        valid === undefined ||
        authored === undefined ||
        rejectingSuite === undefined
      ) {
        throw new Error('The feasibility-rejection scenario was not prepared.');
      }
      return { fixture, valid, authored, run, suite: rejectingSuite };
    }

    it('drives an authored plan the authoring schema accepts, with three infeasible targets beside one feasible one', () => {
      const { valid, authored, run } = subject();
      const { graph, queries } = run.indexed.code;

      expect(instrumentationPlanInputSchema.safeParse(authored).success).toBe(true);
      expect(valid.rationale, 'the fixture target omits its rationale').toBeUndefined();
      expect(queries.hasSymbol(valid.file, valid.symbol ?? '')).toBe(true);
      expect(queries.hasSymbol(CORPUS.serviceFile, CORPUS.serviceSymbol)).toBe(true);
      expect(queries.hasSymbol(CORPUS.serviceFile, CORPUS.absentSymbol)).toBe(false);
      expect(graph.nodesByFile(CORPUS.unindexedFile)).toEqual([]);

      const scripted = run.scripted;
      expect(scripted, 'the session was scripted').toBeDefined();
      const scriptedCalls = scripted?.calls ?? [];
      // Understand and investigate run unscripted, investigate over as many turns as its walk
      // takes; the plan request, asked once, is the one scripted call.
      expect(collapseRepeats(scriptedCalls.map((call) => call.stage))).toEqual([
        ...INITIAL_MODEL_STAGES,
      ]);
      expect(scriptedCalls.filter((call) => call.scripted).map((call) => call.stage)).toEqual([
        PLAN_STAGE,
      ]);
      expect(scriptedCalls.filter((call) => call.stage === PLAN_STAGE)).toHaveLength(1);
      expect(() => {
        scripted?.assertConsumed();
      }).not.toThrow();
    });

    /**
     * The authored plan as the plan stage normalized it, before the feasibility
     * gate narrowed it: every authored target, through the same live registry.
     */
    function normalizedAuthored(): InstrumentationPlan {
      const { authored, run, suite } = subject();
      return unwrap(
        normalizePlan(authored, {
          sessionId: run.created.id,
          planVersion: recordedPlan(run).planVersion,
          resolver: contextBoundResolver(registry, suite.context),
        }),
        'Normalizing the authored plan',
      );
    }

    it('normalizes every action through the live registry and fills each omitted rationale from the objective', () => {
      const { authored, run, suite } = subject();
      const normalized = normalizedAuthored();
      expect(identities(normalized.instrumentationTargets)).toEqual(
        authored.instrumentationTargets.map((target) =>
          actionIdentityKey({ file: target.file, symbol: target.symbol ?? '', type: target.type }),
        ),
      );
      expectRegistryNormalized(normalized, suite.context);

      // The recorded plan is that plan narrowed to what the gate accepted
      // (AAP §0.4.2 "adapter feasibility check"): the one feasible target, once.
      const plan = recordedPlan(run);
      expect(plan.objective).toBe(authored.objective);
      expect(plan.hypotheses).toEqual([]);
      expect(identities(plan.instrumentationTargets)).toEqual(
        identities(normalized.instrumentationTargets.slice(0, 1)),
      );
      expectRegistryNormalized(plan, suite.context);
      for (const action of [...normalized.instrumentationTargets, ...plan.instrumentationTargets]) {
        expect(action.rationale).toBe(authored.objective);
      }
    });

    it('returns each rejection as data — code, reason and hint — and never throws', () => {
      const { run, suite } = subject();
      const normalized = normalizedAuthored();
      const [feasibleAction, absentSymbol, unindexedFile, duplicate] =
        normalized.instrumentationTargets;

      // The recorded plan holds nothing the gate refuses.
      const recorded = feasibilityOf(recordedPlan(run), suite);
      expect(recorded.rejected).toEqual([]);
      expect(identities(recorded.feasible)).toEqual(
        identities(feasibleAction ? [feasibleAction] : []),
      );

      const report = feasibilityOf(normalized, suite);
      expect(report.rejected.map((rejection) => rejection.code)).toEqual([
        REJECTION.symbolNotFound,
        REJECTION.fileNotIndexed,
        REJECTION.duplicateAction,
      ]);
      expect(report.rejected.map((rejection) => rejection.action)).toEqual([
        absentSymbol,
        unindexedFile,
        duplicate,
      ]);
      expect(report.feasible).toEqual([feasibleAction]);
      for (const rejection of report.rejected) {
        expect(isFeasibilityRejectionCode(rejection.code)).toBe(true);
        expect(FEASIBILITY_REJECTION_CODES).toContain(rejection.code);
        expect(isSingleLine(rejection.reason)).toBe(true);
        expect(isSingleLine(rejection.hint)).toBe(true);
      }
      expect(report.rejected[0]?.reason).toContain(CORPUS.absentSymbol);
      expect(report.rejected[1]?.reason).toContain(CORPUS.unindexedFile);
      expect(suite.writeReads).toEqual([]);
    });

    it('keeps every planning refusal away from the installer and proceeds with the feasible action', () => {
      const { valid, run, suite } = subject();
      const report = feasibilityOf(normalizedAuthored(), suite);
      expect(report.rejected).toHaveLength(3);

      expect(PROCEEDING_STATUSES).toContain(run.settled.status);
      const ready = readyPayloads(run).at(-1);
      expect(ready, 'instrumentation.ready was announced').toBeDefined();
      const unavailable = ready?.unavailable ?? [];
      for (const entry of unavailable) {
        expect(isCaptureSignal(entry.signal)).toBe(true);
      }
      for (const rejection of report.rejected) {
        expect(
          unavailable.some((entry) => entry.reason === rejection.reason),
          `the refused plan action "${rejection.reason}" never reaches the installer`,
        ).toBe(false);
      }
      // What the recorded plan enables is exactly what its one feasible action enables.
      expect(signalsOf(recordedPlan(run).instrumentationTargets)).toEqual(
        signalsOf(report.feasible),
      );

      expect(run.settled.modifications.map((record) => [record.file, record.status])).toEqual([
        [valid.file, APPLIED_MODIFICATION],
      ]);
      expect(ready?.applied.map((record) => record.file)).toEqual([valid.file]);
    });

    it('shows no AAP §0.5.5 degradation sentence for an action the planning gate refused', () => {
      const { run, suite } = subject();
      const report = feasibilityOf(normalizedAuthored(), suite);
      const rows = run.progress.filter(
        (entry) =>
          entry.stage === INSTRUMENT_STAGE && entry.message.startsWith(DEGRADATION_OPENING),
      );
      expect(report.rejected.length).toBeGreaterThan(0);
      // Each degradation is one terminal ✗ row: no `running` twin a client
      // merging rows by stage and message would leave spinning beside it.
      expect(rows.filter((entry) => entry.status === RUNNING_ROW)).toEqual([]);
      const refused = new Set(
        report.rejected.map((rejection) => withoutTrailingPunctuation(rejection.reason)),
      );
      // Any degradation row the run did show is a well-formed sentence about an
      // install-time gap, never about an action the planning gate refused.
      for (const row of rows) {
        const sentence = parseDegradation(row.message);
        expect(row.status).toBe(FAILED_ROW);
        expect(refused.has(sentence.reason), `"${sentence.reason}" is a planning refusal`).toBe(
          false,
        );
      }
      for (const reason of refused) {
        expect(
          rows.some((entry) => entry.message.includes(`: ${reason}`)),
          `no degradation row names the planning refusal "${reason}"`,
        ).toBe(false);
      }
    });

    it('refuses an escaping path at the authoring schema, and the feasibility gate still reports it as data', () => {
      const { fixture, valid, authored, run, suite } = subject();
      const escaping = instrumentationPlanInputSchema.safeParse({
        ...authored,
        instrumentationTargets: [{ ...valid, file: fixture.escapingFile }],
      });
      expect(escaping.success).toBe(false);
      expect(escaping.error?.issues.some((issue) => issue.path.includes('file'))).toBe(true);

      const [feasibleAction] = recordedPlan(run).instrumentationTargets;
      if (feasibleAction === undefined) {
        throw new Error('The rejection session recorded an empty plan.');
      }
      const outside: InstrumentationAction = { ...feasibleAction, file: fixture.escapingFile };
      const report = checkFeasibility([outside], suite.context, {
        resolver: contextBoundResolver(registry, suite.context),
      });
      expect(report.feasible).toEqual([]);
      expect(report.rejected.map((rejection) => rejection.code)).toEqual([
        REJECTION.pathOutsideProject,
      ]);
      expect(isSingleLine(report.rejected[0]?.hint ?? '')).toBe(true);
    });

    it('refuses an unclaimed type at normalization, and the feasibility gate still reports no-adapter as data', async () => {
      const { fixture, run, suite } = subject();
      const driverless = await driverlessCopy();
      const bare = contextFor(driverless, run.created.id);
      expect(await dependenciesOf(driverless.copy.root)).not.toHaveProperty(CORPUS.driverPackage);
      expect(registry.claimants(bare.context, DB_QUERY_TRACKING)).toEqual([]);
      expect(registry.resolveActionType(DB_QUERY_TRACKING, bare.context)).toBeUndefined();

      const input = databaseOnlyInput(fixture);
      const normalizeIn = (target: SuiteContext): Result<InstrumentationPlan, DebuggenError> =>
        normalizePlan(input, {
          sessionId: run.created.id,
          planVersion: 1,
          resolver: contextBoundResolver(registry, target.context),
        });
      expect(isErr(normalizeIn(bare)), 'no adapter claims the type, so normalization refuses').toBe(
        true,
      );
      const claimed = unwrap(normalizeIn(suite), 'Normalizing in the pg corpus');
      expect(claimed.instrumentationTargets.map((action) => action.adapter)).toEqual([
        POSTGRES_ADAPTER_ID,
      ]);

      const refused = checkFeasibility(claimed.instrumentationTargets, bare.context, {
        resolver: contextBoundResolver(registry, bare.context),
      });
      expect(refused.feasible).toEqual([]);
      expect(refused.rejected.map((rejection) => rejection.code)).toEqual([REJECTION.noAdapter]);
      expect(isSingleLine(refused.rejected[0]?.hint ?? '')).toBe(true);

      const accepted = checkFeasibility(claimed.instrumentationTargets, suite.context, {
        resolver: contextBoundResolver(registry, suite.context),
      });
      expect(accepted.rejected).toEqual([]);
      expect(bare.writeReads).toEqual([]);
    });

    it('ends through the real cleanup and restores the copy byte for byte', async () => {
      await endRun(subject().run);
    });
  });

  /* -----------------------------------------------------------------------------------------------
   * Phase 4 — the AAP §0.5.3 validation order and the runtime-only fallback
   * -------------------------------------------------------------------------------------------- */

  describe('the validation order and the runtime-only fallback', () => {
    let fixture: InvalidPlanFixture | undefined;
    let invalid: SessionRun | undefined;
    let invalidSuite: SuiteContext | undefined;
    let normalizer: SessionRun | undefined;

    beforeAll(async () => {
      fixture = readInvalidPlanFixture();

      // One more invalid answer than the repair budget allows the stage to ask for:
      // the surplus step proves no fourth request is ever made.
      const invalidSteps = Array.from({ length: DEFAULT_MAX_REPAIRS + 2 }, () =>
        scriptedFixtureStep(PLAN_STAGE, INVALID_PLAN_FIXTURE),
      );
      const indexed = await indexCopy(await harness().copyFixtureProject());
      invalid = await runSession(indexed, QUESTION, invalidSteps);
      invalidSuite = contextFor(indexed, invalid.created.id, recordedPlan(invalid).planVersion);

      // A schema-valid answer the driverless copy's registry cannot normalise,
      // followed by a step that must never be served: a re-prompt would take it.
      normalizer = await runSession(await driverlessCopy(), QUESTION, [
        { stage: PLAN_STAGE, raw: databaseOnlyInput(fixture) },
        scriptedFixtureStep(PLAN_STAGE, INVALID_PLAN_FIXTURE),
      ]);
    }, sessionBudgetMs(2));

    /** The prepared fixture. */
    function theFixture(): InvalidPlanFixture {
      if (fixture === undefined) {
        throw new Error('The invalid-plan fixture was not read.');
      }
      return fixture;
    }

    /** The invalid-answer session and its read-only context. */
    function invalidSubject(): { readonly run: SessionRun; readonly suite: SuiteContext } {
      const run = requireRun(invalid, 'The invalid-answer session');
      if (invalidSuite === undefined) {
        throw new Error('The invalid-answer session has no instrumentation context.');
      }
      return { run, suite: invalidSuite };
    }

    it('reads a committed payload the authoring schema refuses at exactly its three bad targets', () => {
      const current = theFixture();
      const parsed = instrumentationPlanInputSchema.safeParse(current.raw);
      expect(parsed.success).toBe(false);
      const badTargets = new Set(
        (parsed.error?.issues ?? [])
          .filter((issue) => issue.path[0] === 'instrumentationTargets')
          .map((issue) => issue.path[1]),
      );
      expect(badTargets).toEqual(new Set([1, 2, 3]));
      expect(
        current.targets.some(
          (target) =>
            isPlainObject(target) &&
            typeof target['type'] === 'string' &&
            !INSTRUMENTATION_ACTION_TYPES.some((type) => type === target['type']),
        ),
        'one target names a type outside the action-type vocabulary',
      ).toBe(true);
    });

    it(`repairs at most DEFAULT_MAX_REPAIRS times: ${String(DEFAULT_MAX_REPAIRS + 1)} plan requests, never another`, () => {
      const { run } = invalidSubject();
      expect(callsFor(run, UNDERSTAND_STAGE)).toHaveLength(1);
      // A plan repair never re-asks an earlier stage: the investigate stage takes exactly the
      // turns the unscripted session over the same corpus and question took.
      expect(callsFor(run, INVESTIGATE_STAGE)).toHaveLength(
        callsFor(requireRun(happyRun, 'The generic-question session'), INVESTIGATE_STAGE).length,
      );
      expect(callsFor(run, PLAN_STAGE)).toHaveLength(DEFAULT_MAX_REPAIRS + 1);

      const scripted = run.scripted;
      expect(scripted?.remaining()).toBe(1);
      const attempts = (scripted?.calls ?? []).filter((call) => call.stage === PLAN_STAGE);
      expect(attempts).toHaveLength(DEFAULT_MAX_REPAIRS + 1);
      for (const [index, attempt] of attempts.entries()) {
        expect(attempt.scripted).toBe(true);
        const repairing = (attempt.request.messages ?? []).some(
          (message) =>
            message.role === 'assistant' && message.content.includes(REPAIR_ASSISTANT_NOTICE),
        );
        expect(repairing, `attempt ${String(index + 1)} is a repair`).toBe(index > 0);
        expect(attempt.promptVersion).toBe(attempts[0]?.promptVersion);
        expect(attempt.request.input).toEqual(attempts[0]?.request.input);
      }
    });

    it('falls back to the runtime-only plan the live adapters propose, which validates and is feasible', async () => {
      const { run, suite } = invalidSubject();
      const current = theFixture();
      const plan = recordedPlan(run);
      const understanding = run.settled.understanding;
      if (understanding === undefined) {
        throw new Error('The invalid-answer session recorded no understanding.');
      }

      expect(instrumentationPlanSchema.safeParse(plan).success).toBe(true);
      expect(plan.instrumentationTargets.length).toBeGreaterThan(0);
      for (const action of plan.instrumentationTargets) {
        expect(action.mode).toBe(RUNTIME_MODE);
      }
      expectRegistryNormalized(plan, suite.context);
      expect(feasibilityOf(plan, suite).rejected).toEqual([]);

      const proposals = await runtimeProposals(suite.context, understanding);
      const feasibleProposals = checkFeasibility(proposals, suite.context, {
        resolver: contextBoundResolver(registry, suite.context),
      }).feasible;
      expect(identities(plan.instrumentationTargets).sort(byCodeUnit)).toEqual(
        identities(feasibleProposals).sort(byCodeUnit),
      );

      const text = JSON.stringify(plan);
      expect(plan.objective).not.toBe(current.objective);
      for (const hypothesis of current.hypotheses) {
        expect(text).not.toContain(hypothesis);
      }
      expect(text).not.toContain(current.escapingFile);
      expect(suite.writeReads).toEqual([]);
    });

    it('reports the rejection, proceeds degraded, and writes nothing to the project', async () => {
      const { run } = invalidSubject();
      expect(PROCEEDING_STATUSES).toContain(run.settled.status);
      expect(run.settled.modifications).toEqual([]);
      await assertTreeUnchanged(run.indexed.copy.root, run.indexed.baseline);

      const fallbacks = logsOf(
        run,
        (record) =>
          record.level === 'warn' &&
          record.fields['stage'] === PLAN_STAGE &&
          record.fields['reason'] === FALLBACK_REASON.modelOutputInvalid,
      );
      expect(fallbacks).toHaveLength(1);
      expect(fallbacks[0]?.fields['repairs']).toBe(DEFAULT_MAX_REPAIRS);

      // Planning reports inside "Preparing instrumentation"; a planning failure would keep the
      // plan stage on its row, and none does — no row carries that stage at all.
      const planningGroup = run.progress.filter(
        (entry) => entry.stage === PROGRESS_STAGE_GROUPS[PLAN_STAGE],
      );
      const refusalRows = planningGroup.filter((entry) =>
        entry.message.includes('instrumentationTargets['),
      );
      for (const badTarget of [1, 2, 3]) {
        expect(
          refusalRows.some((entry) =>
            entry.message.includes(`instrumentationTargets[${String(badTarget)}]`),
          ),
          `the developer is shown why target ${String(badTarget)} was refused`,
        ).toBe(true);
      }
      expect(refusalRows.some((entry) => entry.status === FAILED_ROW)).toBe(false);
      expect(run.progress.some((entry) => entry.stage === PLAN_STAGE)).toBe(false);
    });

    it('rejects a normaliser failure without a re-prompt, logging the closed input shape as a product defect', () => {
      const run = requireRun(normalizer, 'The normaliser-failure session');
      expect(callsFor(run, PLAN_STAGE)).toHaveLength(1);
      expect(run.scripted?.remaining()).toBe(1);

      const defects = logsOf(
        run,
        (record) =>
          record.level === 'error' &&
          record.fields['stage'] === PLAN_STAGE &&
          record.fields['step'] === NORMALIZE_STEP,
      );
      expect(defects).toHaveLength(1);
      // The defect is described by the authored plan's closed shape, never by the plan itself.
      expect(Object.keys(defects[0]?.fields ?? {})).not.toContain('input');
      expect(defects[0]?.fields).toMatchObject({
        captureCount: databaseOnlyInput(theFixture()).capture.length,
        targetCount: 1,
        hypothesisCount: 0,
        targetTypes: { [DB_QUERY_TRACKING]: 1 },
      });

      const fallbacks = logsOf(
        run,
        (record) =>
          record.level === 'warn' &&
          record.fields['stage'] === PLAN_STAGE &&
          record.fields['reason'] === FALLBACK_REASON.normalizationFailed,
      );
      expect(fallbacks).toHaveLength(1);
      expect(fallbacks[0]?.fields['repairs']).toBe(0);
    });

    it('holds a fallback of page hooks at the readiness gate until a tab binds, and never reports success', () => {
      const run = requireRun(normalizer, 'The normaliser-failure session');
      // The runtime-only fallback's page hooks are armed pending the bound tab's
      // agent — a session's plan installs before its panel binds the tab, so
      // that absence is a wait, not a refusal. The session stays at the gate,
      // which lists each such hook as a waiting instrumentation row (its ✓ row
      // replaces it once the page reports) and never as ✗ (AAP §0.5.5,
      // §0.7.1), and no `instrumentation.failed` is sent for a plan nothing
      // refused.
      expect(run.settled.status).toBe(INSTRUMENTING_STATUS);
      const pageLabels = new Set<string>(
        Object.keys(DORMANT_AGENT_HOOK_CONFIG)
          .filter(isCaptureSignal)
          .map((signal) => CAPTURE_SIGNAL_LABELS[signal]),
      );
      const instrumentRows = run.progress.filter((entry) => entry.stage === INSTRUMENT_STAGE);
      expect(
        instrumentRows.some(
          (entry) => entry.status === RUNNING_ROW && pageLabels.has(entry.message),
        ),
      ).toBe(true);
      expect(instrumentRows.filter((entry) => entry.status === FAILED_ROW)).toEqual([]);

      const failures = run.editor.received.filter(
        (message, index) =>
          index >= run.messageMark &&
          isMessageOfType(message, 'instrumentation.failed') &&
          message.payload.sessionId === run.created.id,
      );
      expect(failures).toEqual([]);

      const statuses = broadcastRecords(run).map((record) => record.status);
      expect(statuses.at(-1)).toBe(INSTRUMENTING_STATUS);
      for (const successful of [READY_STATUS, GENERATED_STATUS, FAILED_STATUS]) {
        expect(statuses).not.toContain(successful);
      }
      expect(run.settled.modifications).toEqual([]);
    });

    it('ends both sessions through the real cleanup and restores both copies', async () => {
      await endRun(invalidSubject().run);
      await endRun(requireRun(normalizer, 'The normaliser-failure session'));
    });
  });

  /* -----------------------------------------------------------------------------------------------
   * Phase 5 — genericity (AAP §0.5.4)
   *
   * The static half of this rule is `scripts/check-no-hardcoding.mjs`, which fails the build when
   * product source or a prompt names the demo application or branches on the question text. The
   * tokenizer in `src/pipeline/stages/understand.ts` is the only sanctioned analysis of the
   * question's words; everything these scenarios compare is derived from the code graph.
   * -------------------------------------------------------------------------------------------- */

  describe('genericity: the question’s wording never drives selection', () => {
    let reworded: SessionRun | undefined;
    let questionOnly: SessionRun | undefined;
    let questionOnlySuite: SuiteContext | undefined;
    let renamed: SessionRun | undefined;
    let renamedSuite: SuiteContext | undefined;

    beforeAll(async () => {
      reworded = await runSession(
        await indexCopy(await harness().copyFixtureProject()),
        QUESTION_REWORDED,
      );

      const questionOnlyCopy = await indexCopy(await harness().copyFixtureProject());
      questionOnly = await runSession(questionOnlyCopy, QUESTION_NAMING_ABSENT_SYMBOLS);
      questionOnlySuite = contextFor(questionOnlyCopy, questionOnly.created.id);

      const renamedCopy = await renamedRouteCopy();
      renamed = await runSession(renamedCopy, QUESTION);
      renamedSuite = contextFor(renamedCopy, renamed.created.id);
    }, sessionBudgetMs(3));

    it('reads both wordings alike through the one sanctioned tokenizer', () => {
      const original = tokenizeQuestion(QUESTION);
      const rewritten = tokenizeQuestion(QUESTION_REWORDED);
      expect(QUESTION_REWORDED).not.toBe(QUESTION);
      expect([...rewritten.tokens].sort(byCodeUnit)).toEqual([...original.tokens].sort(byCodeUnit));
      expect([...rewritten.signalTerms].sort(byCodeUnit)).toEqual(
        [...original.signalTerms].sort(byCodeUnit),
      );
    });

    it('yields an equivalent plan, understanding and relevant-file set for a reworded question', () => {
      const baseline = requireRun(happyRun, 'The generic-question session');
      const run = requireRun(reworded, 'The reworded-question session');
      expect(run.settled.status).toBe(baseline.settled.status);
      expect(run.settled.understanding).toEqual(baseline.settled.understanding);
      expect(planShape(recordedPlan(run))).toEqual(planShape(recordedPlan(baseline)));
      expect(relevantFileKeys(run.settled.relevantFiles)).toEqual(
        relevantFileKeys(baseline.settled.relevantFiles),
      );
      expect(run.settled.promptVersions).toEqual(baseline.settled.promptVersions);
    });

    it('selects nothing named only in the question', async () => {
      const run = requireRun(questionOnly, 'The question-only-names session');
      if (questionOnlySuite === undefined) {
        throw new Error('The question-only-names session has no instrumentation context.');
      }
      const corpus = await corpusText(run.indexed.copy.root);
      const candidates = tokenizeQuestion(QUESTION_NAMING_ABSENT_SYMBOLS).identifierCandidates;
      for (const name of QUESTION_ONLY_IDENTIFIERS) {
        expect(corpus, `${name} exists only in the question`).not.toContain(name);
        expect(candidates, `the tokenizer surfaces ${name}`).toContain(name);
      }

      // Stage 1 records what the question names, as an understanding must…
      const named = (run.settled.understanding?.entities ?? [])
        .map((entity) => entity.name)
        .filter((name) => QUESTION_ONLY_IDENTIFIERS.includes(name));
      expect(named.sort(byCodeUnit)).toEqual([...QUESTION_ONLY_IDENTIFIERS].sort(byCodeUnit));
      // …the code graph resolves none of those names…
      for (const name of QUESTION_ONLY_IDENTIFIERS) {
        expect(run.indexed.code.queries.findByName(name), `${name} is not in the graph`).toEqual(
          [],
        );
      }
      // …so nothing selected downstream of the graph carries them.
      const selected = JSON.stringify({
        plans: run.settled.plans,
        relevantFiles: run.settled.relevantFiles,
        modifications: run.settled.modifications,
      });
      for (const name of QUESTION_ONLY_IDENTIFIERS) {
        expect(selected, `${name} drove no selection`).not.toContain(name);
      }
      for (const entry of run.settled.relevantFiles) {
        await expectGroundedRelevantFile(entry, run.indexed);
      }

      // Every target the plan names is a declaration the code graph holds. One
      // the gate refuses (this wording can select a render function for
      // timing) is reported as an UnavailableSignal and never patched.
      const plan = recordedPlan(run);
      for (const action of plan.instrumentationTargets) {
        if (!isTargetlessAction(action)) {
          expect(
            run.indexed.code.queries.hasSymbol(action.file, action.symbol),
            `${action.file} › ${action.symbol} resolves`,
          ).toBe(true);
        }
      }
      const report = feasibilityOf(plan, questionOnlySuite);
      const unavailable = (readyPayloads(run).at(-1)?.unavailable ?? []).map(
        (entry) => entry.reason,
      );
      for (const rejection of report.rejected) {
        expect(unavailable).toContain(rejection.reason);
      }
      const patchedFiles = new Set(
        report.feasible.filter((action) => action.mode === PATCH_MODE).map((action) => action.file),
      );
      for (const record of run.settled.modifications) {
        expect(
          patchedFiles.has(record.file),
          `${record.file} was patched for a feasible action`,
        ).toBe(true);
      }
      expect(PROCEEDING_STATUSES).toContain(run.settled.status);
    });

    it('moves the plan with a route renamed in the corpus: selection follows the code graph', async () => {
      const baseline = requireRun(happyRun, 'The generic-question session');
      const run = requireRun(renamed, 'The renamed-route session');
      if (renamedSuite === undefined) {
        throw new Error('The renamed-route session has no instrumentation context.');
      }
      const from = routePathOf(CORPUS.routeDirectory);
      const to = routePathOf(CORPUS.renamedRouteDirectory);
      const root = run.indexed.copy.root;
      expect(await isFileIn(root, `${CORPUS.renamedRouteDirectory}/${CORPUS.routeModule}`)).toBe(
        true,
      );
      expect(await isFileIn(root, `${CORPUS.routeDirectory}/${CORPUS.routeModule}`)).toBe(false);
      const routePaths = run.indexed.code.routeMap.entries.map((route) => route.routePath);
      expect(routePaths).toContain(to);
      expect(routePaths).not.toContain(from);

      const plan = recordedPlan(run);
      expect(planShape(plan)).toEqual(substituted(planShape(recordedPlan(baseline)), from, to));
      expect(relevantFileKeys(run.settled.relevantFiles)).toEqual(
        relevantFileKeys(substituted(baseline.settled.relevantFiles, from, to)),
      );
      expect(
        plan.instrumentationTargets
          .filter((action) => action.mode === PATCH_MODE)
          .map((action) => action.file),
      ).toContain(`${CORPUS.renamedRouteDirectory}/${CORPUS.routeModule}`);
      expect(JSON.stringify({ plan, files: run.settled.relevantFiles })).not.toContain(
        `${CORPUS.routeDirectory}/`,
      );
      expect(run.settled.relevantFiles.map((entry) => entry.symbol)).toContain(to);
      expect(feasibilityOf(plan, renamedSuite).rejected).toEqual([]);
    });

    it('ends all three sessions through the real cleanup and restores every copy', async () => {
      await endRun(requireRun(reworded, 'The reworded-question session'));
      await endRun(requireRun(questionOnly, 'The question-only-names session'));
      await endRun(requireRun(renamed, 'The renamed-route session'));
      expect(openSessions.size, 'every session this file opened has ended').toBe(0);
    });
  });
});
