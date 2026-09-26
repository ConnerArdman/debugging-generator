/**
 * `panel-fallback` — the end-to-end rejection path of generated panels
 * (AAP §0.5.3, §0.5.5, §0.8.3 "`panel-fallback` (invalid model output →
 * fallback panel with `meta.fallback`, status not `generated` until valid)").
 *
 * ## What this suite proves that no unit suite can
 *
 * `src/panels/fallback.test.ts` pins the fallback builder in isolation and
 * `packages/model-provider/src/structured.test.ts` pins the repair policy.
 * This suite drives the whole path through the service booted by
 * `startService`: a real session over a copied fixture project, a bound tab, a
 * capture fed by both producers, the real deterministic analysis, the real
 * panels store and the real evidence resolvers over the `telemetry_events`
 * table. Only the answer of the `generate-panel` stage is scripted.
 *
 * - **Order of AAP §0.5.3.** An authoring-schema failure earns at most
 *   `DEFAULT_MAX_REPAIRS` repairs, each carrying the formatted Zod issues and
 *   none of the rejected values, and then yields the deterministic fallback
 *   panel (`meta.fallback === true`). A semantic rejection and a normaliser
 *   defect never earn a repair. Every claim is made by **counting provider
 *   calls**, with an unserved tripwire step proving that no further call was
 *   made.
 * - **The fallback is a real panel.** It is persisted with its version,
 *   broadcast as `panel.generated`, passes `validatePanelSpec`, is composed of
 *   catalogued nodes only, and carries exactly the validated analysis's facts
 *   and causes — never a candidate from `analysis/facts.ts`, never a string the
 *   model wrote.
 * - **The raw error is never analysis.** The rejected payload's values and the
 *   formatted issues appear in no stored panel, analysis, session record,
 *   progress row or broadcast payload; only the captured logs hold the
 *   rejection. A terminal provider failure's own hint — unproven text quoting
 *   a URL query value, a SQL literal and a path — reaches neither the stored
 *   rows nor the editor's or the DevTools panel's frames nor any default-level
 *   log record: the `failed` row shows the code's copy, and the failure's
 *   `debug` diagnostic under the row's reference is the one place it goes.
 * - **No log record carries the model's prose (CWE-532).** A normaliser defect
 *   is logged by closed fields only — provenance, counts, the thrown error's
 *   code and class — and a private sentinel written into a schema-valid answer
 *   and into what the defective normaliser throws appears in no record the
 *   service writes, while the validated fallback panel is still stored.
 * - **Resolvers decide, both ways.** A panel citing a trace the capture does
 *   not hold is `invalid` — not `unverifiable` — because the service hands
 *   `createEvidenceResolvers` to `SemanticValidationOptions`; and the genuine
 *   panel, citing the capture's real `evt_ct…` ids, is **not** downgraded,
 *   because those same resolvers confirm what a bounded summary alone cannot.
 * - **`generated` is guarded.** The status reaches `generated` only after a
 *   validated panel (a fallback included) and a validated analysis are both
 *   stored; a terminal rejection leaves the session `failed` at
 *   `generate-panel`; and `failed` has no edge to `generated`.
 *
 * ## How the suite is built
 *
 * - **One harness per file.** The service is booted once with a routing
 *   {@link ModelProvider}: every call goes to the current scenario's scripted
 *   provider (`createScriptedProvider`), whose unscripted stages fall through to
 *   the real deterministic provider. Each scenario therefore has its own call
 *   record, and the panel stage is the only place a scripted answer is served.
 * - **One project, dev server, tab and capture per scenario.** Scenarios never
 *   share a capture window, a binding or a project copy.
 * - **One batch, re-identified per scenario.** The store refuses an event id
 *   already stored under another session, so every scenario but the positive
 *   control ingests an in-memory copy of `telemetry-trace-cross-tier.json`
 *   whose event ids carry a scenario tag; trace ids, span ids and every other
 *   byte are kept. The control ingests the committed ids unchanged.
 * - **Authored inputs, not recordings.** The three `model-output-*.json` files
 *   are bare authoring payloads (AAP §0.2.5 ships no recorded model response),
 *   read through `readFixtureJson`, which holds each one to its accepted or
 *   refused contract so no rejection here can pass vacuously.
 *
 * ## Rules ruling
 *
 * `review_rules` returns "No user rules provided." (AAP §0.10), so the §0.10
 * baseline governs: this file belongs to `pnpm test:integration` inside
 * `pnpm verify` and passes `tsc -b`, `eslint --max-warnings 0` and
 * `prettier --check`; it holds no secret-shaped literal (credentials are minted
 * by the harness through the real auth service); and it imports only
 * `@debuggen/*` packages other than `@debuggen/panel-renderer` — panel validity
 * is asserted structurally, never by rendering — plus `vitest`. It imports no
 * `zod`: schemas are exercised through `.safeParse` on the exported objects.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_REPAIRS,
  REPAIR_ASSISTANT_NOTICE,
  createPromptLoader,
  formatZodIssues,
} from '@debuggen/model-provider';
import type { ModelProvider } from '@debuggen/model-provider';
import {
  PANEL_NODE_CATALOG,
  isSourceAllowedForNode,
  normalizePanel,
  panelSpecInputSchema,
  validateAgainstCapture,
  validatePanelSpec,
  walkPanelNodes,
} from '@debuggen/panel-schema';
import type { PanelNode, PanelNodePath, PanelSpec, PanelSpecInput } from '@debuggen/panel-schema';
import {
  isMessageOfType,
  panelGeneratedPayloadSchema,
  parseAnalysisResult,
} from '@debuggen/protocol';
import type { AnalysisResult, SessionRecord, SessionStatus } from '@debuggen/protocol';
import { DebuggenError, newPanelId } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';
import type { CaptureSummary, TelemetryEventIngress } from '@debuggen/telemetry';

import { createAnalysisFacts, toSemanticValidationOptions } from '../../src/analysis/facts.js';
import { createAnalysisSummarizer } from '../../src/analysis/summarize.js';
import {
  FALLBACK_BANNER_MESSAGE,
  FALLBACK_HEADLINES,
  FALLBACK_SECTION_TITLES,
  FALLBACK_TITLE,
  createFallbackPanelBuilder,
} from '../../src/panels/fallback.js';
import { PANEL_PROMPT_STAGE, createPanelGenerator } from '../../src/panels/generate.js';
import type { PanelGenerationResult } from '../../src/panels/generate.js';
import {
  PANEL_FAILURE_CLASSES,
  PANEL_FAILURE_POLICY,
  createPanelValidator,
} from '../../src/panels/validate.js';
import type { PanelStructuredNormalizer, PanelValidator } from '../../src/panels/validate.js';
import { GENERATE_PANEL_STAGE } from '../../src/pipeline/stages/generate-panel.js';
import { LOG_ERROR_FIELD_KEY } from '../../src/logging.js';
import {
  FAILURE_COPY_BY_CODE,
  STAGE_FAILURE_DIAGNOSTIC_MESSAGE,
  STAGE_FAILURE_LOG_MESSAGE,
  publicFailureCopy,
} from '../../src/sessions/progress.js';
import {
  STAGE_STATUS,
  allowedTransitions,
  canTransition,
  transition,
} from '../../src/sessions/state-machine.js';
import {
  FIXTURE_DIR,
  PROMPTS_DIR,
  assertTreeUnchanged,
  createScriptedProvider,
  readFixtureJson,
  readTelemetryBatch,
  scriptedFixtureStep,
  snapshotTree,
  startHarness,
} from './harness.js';
import type {
  CapturedLogRecord,
  Harness,
  HarnessMessage,
  HarnessWsClient,
  ScriptedProvider,
  ScriptedProviderCall,
  ScriptedStep,
  TreeSnapshot,
} from './harness.js';

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/** The developer's question every scenario asks; the pipeline never branches on it (AAP §0.5.4). */
const QUESTION = 'Why does the trail report take so long to appear after the click?';

/** The one telemetry batch every capture of this suite is fed from. */
const CROSS_TIER_BATCH = 'telemetry-trace-cross-tier.json';

/** The three authored panel payloads: refused by the authoring schema, valid, semantically refuted. */
const INVALID_PANEL = 'model-output-invalid-panel.json';
const VALID_PANEL = 'model-output-valid-panel.json';
const SEMANTIC_INVALID_PANEL = 'model-output-panel-semantic-invalid.json';

/** The batch tag of the committed event ids (`evt_` + tag + 14 digits, per the fixture README). */
const COMMITTED_EVENT_PREFIX = 'evt_ct';

/** How a re-identified event id is spelled: the same shape with a scenario's own tag. */
const EVENT_ID_PREFIX = 'evt_';

/** Boot and teardown of the one harness. */
const HARNESS_HOOK_TIMEOUT_MS = 30_000;

/** One scenario end to end — project copy, pipeline, capture, analysis, panel — with headroom. */
const SCENARIO_TIMEOUT_MS = 60_000;

/** The statuses a new session settles in once its install has run. */
const INSTALLED_STATUSES: readonly SessionStatus[] = Object.freeze([
  'instrumenting',
  'ready',
  'failed',
]);

/** The statuses a completed capture settles in once analysis and panel generation have run. */
const SETTLED_STATUSES: readonly SessionStatus[] = Object.freeze(['generated', 'failed']);

/**
 * The provider failure the terminal scenario scripts. Its code is passed
 * through (AAP §0.5.5); its own text stays in the service log, and the
 * `failed` row shows the public copy of that code instead (CWE-209).
 */
const PROVIDER_OUTAGE_MESSAGE = 'The scripted panel provider is unavailable for this capture.';

/**
 * The private fragments of the provider's own recovery hint in the terminal
 * scenario: a URL query value, an inline SQL literal and an absolute path —
 * what a hint propagated from a dependency can quote.
 */
const PROVIDER_OUTAGE_HINT_FRAGMENTS: readonly string[] = Object.freeze([
  'zz-outage-query-value',
  'zz-outage-sql-literal',
  '/home/dev/zz-outage-project/src/billing.ts',
]);

/**
 * That hint. It reads like a recovery step, and no product builder registered
 * it, so the `failed` row shows the code's own hint instead (CWE-209) and only
 * the failure's `debug` diagnostic carries it.
 */
const PROVIDER_OUTAGE_HINT =
  'Retry after https://provider.test/v1/status?account=zz-outage-query-value answers, ' +
  "once SELECT plan FROM billing WHERE owner = 'zz-outage-sql-literal' succeeds " +
  'in /home/dev/zz-outage-project/src/billing.ts.';

/** The diagnostic reference at the end of a `failed` row's detail. */
const FAILED_ROW_REF_PATTERN = /\(error code: [A-Z][A-Z_]+, ref: ([A-Za-z0-9][A-Za-z0-9_-]*)\)$/u;

/**
 * A node type outside the catalog: the one state a parsed authoring payload can
 * never hold, injected past the authoring schema to simulate a normaliser defect.
 */
const UNCATALOGUED_NODE_TYPE = 'uncatalogued-node-type';

/**
 * A private marker standing in for developer source or personal data a model
 * echoed into its panel prose (CWE-532): planted in a schema-valid answer's
 * title and summary, and in what a defective normaliser throws, then required
 * to appear in no log record at any level.
 *
 * Assembled from fragments, lower-case and hyphenated, so
 * `scripts/check-secrets.mjs` — which scans this tracked file — cannot read it
 * as credential material and the service logger's content scrub has no pattern
 * to redact it by: its absence is evidence of the sink being closed, never of a
 * scrub having masked it. It also has the shape of a node type name, so the
 * real `normalizePanel` quotes it verbatim in the error it throws for an
 * uncatalogued node — which is how the thrown message comes to carry it.
 */
const PRIVATE_SENTINEL = ['zzq', 'unlogged', 'panel', 'marker'].join('-');

/**
 * The service's log messages this suite reads its evidence from. None is
 * exported by its module; each is quoted from the module that writes it.
 */
const LOG = Object.freeze({
  /** `panels/generate.ts` — every stored panel, model or fallback, with its provenance. */
  stored: 'Stored a generated panel for the capture.',
  /** `panels/generate.ts` — a rejection that is not a product defect, answered with the fallback. */
  rejected:
    'A generated panel was rejected; showing the deterministic fallback panel built from captured data.',
  /** `panels/generate.ts` — a product-defect rejection, never re-prompted. */
  productDefect:
    'A generated panel was rejected by a product defect and was not re-prompted; showing the deterministic fallback panel.',
  /** `panels/validate.ts` — a semantic refusal with its outcome and resolver provenance. */
  semanticRejected: 'A generated panel was rejected by semantic validation.',
  /** `panels/validate.ts` — a semantic acceptance with the resolver tallies. */
  semanticPassed: 'A generated panel passed semantic validation.',
  /** `model-provider/structured.ts` — the repair budget spent on an authoring-schema failure. */
  budgetSpent: 'Structured output failed validation and the repair budget is spent',
  /**
   * `model-provider/structured.ts` — a normaliser throw, logged with closed
   * fields only: provenance, counts, the thrown error's code and class, never
   * the parsed input or the thrown message.
   */
  normaliserThrew: 'The structured output normaliser threw; rejecting without a repair',
});

/* -------------------------------------------------------------------------------------------------
 * The routing provider
 * ---------------------------------------------------------------------------------------------- */

/** The provider the harness boots with, and the switch that points it at a scenario's script. */
interface ProviderRouter {
  /** Handed to `startHarness`; every call is forwarded to the current scripted provider. */
  readonly provider: ModelProvider;
  /** Starts a new scenario: a fresh scripted provider over `script`, with its own call record. */
  use(script: readonly ScriptedStep[]): ScriptedProvider;
}

/**
 * Builds the routing provider. It adds no behaviour of its own — one attempt
 * per call, never a throw, no repair loop — so the service sees exactly the
 * `ModelProvider` contract, and every scenario's calls are counted by the
 * scripted provider that answered them.
 */
function createProviderRouter(): ProviderRouter {
  let current: ScriptedProvider = createScriptedProvider([]);
  const provider: ModelProvider = {
    id: 'panel-fallback-router',
    generateText: (request) => current.provider.generateText(request),
    generateStructured: (schema, request) => current.provider.generateStructured(schema, request),
    callTools: (request, tools) => current.provider.callTools(request, tools),
  };
  return Object.freeze({
    provider,
    use: (script: readonly ScriptedStep[]): ScriptedProvider => {
      current = createScriptedProvider(script);
      return current;
    },
  });
}

/* -------------------------------------------------------------------------------------------------
 * Value helpers
 * ---------------------------------------------------------------------------------------------- */

/** The value of an `Ok`, or a failure naming the step that refused. */
function unwrap<T>(result: Result<T, DebuggenError>, step: string): T {
  if (!result.ok) {
    throw new Error(`${step} was refused (${result.error.code}): ${result.error.message}`, {
      cause: result.error,
    });
  }
  return result.value;
}

/** The only element of a list, or a failure naming what was expected once. */
function single<T>(items: readonly T[], what: string): T {
  const [only, ...rest] = items;
  if (only === undefined || rest.length > 0) {
    throw new Error(`Expected exactly one ${what}; found ${String(items.length)}.`);
  }
  return only;
}

/** Whether a value is a plain, non-array object. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads one value out of a parsed JSON fixture by path, failing loudly on a
 * missing step — so an expectation derived from a fixture can never silently
 * become `undefined` and pass.
 */
function pick(value: unknown, ...path: readonly (string | number)[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (typeof segment === 'number') {
      current = Array.isArray(current) ? (current as readonly unknown[])[segment] : undefined;
    } else {
      current = isRecord(current) ? current[segment] : undefined;
    }
    if (current === undefined) {
      throw new Error(`The fixture has no value at ${path.map(String).join('.')}.`);
    }
  }
  return current;
}

/** {@link pick}, for a value that must be a string. */
function pickText(value: unknown, ...path: readonly (string | number)[]): string {
  const found = pick(value, ...path);
  if (typeof found !== 'string') {
    throw new Error(`The fixture value at ${path.map(String).join('.')} is not a string.`);
  }
  return found;
}

/** Every string anywhere inside a JSON value, depth first. */
function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const element of value as readonly unknown[]) {
      collectStrings(element, into);
    }
  } else if (isRecord(value)) {
    for (const element of Object.values(value)) {
      collectStrings(element, into);
    }
  }
  return into;
}

/**
 * A JSON value with the `id` of every panel node removed, so a normalised
 * layout can be compared with the authored one field for field. Node ids are
 * asserted separately against their positions.
 */
function withoutNodeIds(value: unknown): unknown {
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).map(withoutNodeIds);
  }
  if (!isRecord(value)) {
    return value;
  }
  const isNode = typeof value['type'] === 'string';
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !(isNode && key === 'id'))
      .map(([key, element]) => [key, withoutNodeIds(element)]),
  );
}

/** Serialises every value a leak search runs over into one haystack. */
function haystackOf(...values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join('\n');
}

/** Consecutive duplicates collapsed: the transcripts carry replays of the current record. */
function collapseRepeats<T>(items: readonly T[]): T[] {
  const collapsed: T[] = [];
  for (const item of items) {
    if (collapsed.at(-1) !== item) {
      collapsed.push(item);
    }
  }
  return collapsed;
}

/* -------------------------------------------------------------------------------------------------
 * Panels, as the store holds them
 * ---------------------------------------------------------------------------------------------- */

/** One panel node and the path `walkPanelNodes` reports for it. */
interface LocatedNode {
  readonly node: PanelNode;
  readonly path: PanelNodePath;
}

/** Every node of a panel, containers included, in document order. */
function nodesOf(panel: PanelSpec): readonly LocatedNode[] {
  const nodes: LocatedNode[] = [];
  walkPanelNodes(panel.layout, (node, path) => {
    nodes.push({ node, path });
  });
  return nodes;
}

/** The data source a node reads, or `undefined` for a container or the source-link leaf. */
function sourceOf(node: PanelNode): string | undefined {
  return 'query' in node ? node.query.source : undefined;
}

/** Every event id a panel's summary cites, without repeats. */
function citedEventIds(panel: PanelSpec): readonly string[] {
  const cited = [...panel.summary.observed, ...panel.summary.likelyCauses].flatMap((finding) =>
    finding.evidence.map((ref) => ref.eventId),
  );
  return [...new Set(cited)];
}

/** Every trace id a panel's nodes filter on, without repeats. */
function filteredTraceIds(panel: PanelSpec): readonly string[] {
  const traced = nodesOf(panel).flatMap(({ node }) => {
    const traceId = 'query' in node ? node.query.filter?.traceId : undefined;
    return traceId === undefined ? [] : [traceId];
  });
  return [...new Set(traced)];
}

/**
 * A capture summary with its bounded top-N sections emptied: the shape of a
 * capture whose cited events all rank outside those sections, which is exactly
 * the case a summary alone cannot decide and only the store can.
 */
function boundedSummary(summary: CaptureSummary): CaptureSummary {
  return {
    ...summary,
    topSpans: [],
    topRenders: [],
    topRequests: [],
    topQueries: [],
    errors: [],
  };
}

/**
 * A parsed authoring payload whose first node claims a type outside the
 * catalog — a state `panelSpecInputSchema` can never produce. Handing it to the
 * real normaliser is how the suite reproduces a normaliser defect through the
 * `StructuredOptions.normalize` seam without any fake normaliser logic.
 *
 * @param input The parsed authoring payload; copied, never mutated.
 * @param type The uncatalogued type the first node is given.
 */
function withUncataloguedFirstNode(
  input: PanelSpecInput,
  type: string = UNCATALOGUED_NODE_TYPE,
): PanelSpecInput {
  const corrupted: unknown = JSON.parse(JSON.stringify(input));
  const layout = isRecord(corrupted) ? corrupted['layout'] : undefined;
  const first: unknown = Array.isArray(layout) ? (layout as readonly unknown[])[0] : undefined;
  if (!isRecord(first)) {
    throw new Error('The authoring payload has no first layout node to corrupt.');
  }
  Object.assign(first, { type });
  // The one deliberate lie in this suite: the value no longer satisfies the
  // type it claims, which is precisely the product defect being simulated.
  return corrupted as PanelSpecInput;
}

/* -------------------------------------------------------------------------------------------------
 * The harness and its scenarios
 * ---------------------------------------------------------------------------------------------- */

let harness: Harness;
const router = createProviderRouter();
let committedFixtures: TreeSnapshot;

beforeAll(async () => {
  committedFixtures = await snapshotTree(FIXTURE_DIR);
  harness = await startHarness({ provider: router.provider, fixtureProject: false });
}, HARNESS_HOOK_TIMEOUT_MS);

afterAll(async () => {
  try {
    await assertTreeUnchanged(FIXTURE_DIR, committedFixtures);
  } finally {
    await harness.assertNoLeaks();
  }
}, HARNESS_HOOK_TIMEOUT_MS);

/** One scenario: which script answers the panel stage, and whose capture it answers for. */
interface ScenarioSpec {
  /** A short label for failure messages. */
  readonly label: string;
  /** The inspected tab the scenario's DevTools client speaks for; unique per scenario. */
  readonly tabId: number;
  /**
   * The two-letter batch tag the scenario's event ids carry, or `undefined` to
   * ingest the committed `evt_ct…` ids unchanged (the positive control).
   */
  readonly eventTag: string | undefined;
  /** The scripted answers; every one names the panel stage, so no other stage is scripted. */
  readonly script: readonly ScriptedStep[];
}

/** Everything a scenario left behind for its assertions. */
interface ScenarioRun {
  readonly label: string;
  /** The scenario's own provider record: every call the service made while it ran. */
  readonly scripted: ScriptedProvider;
  readonly sessionId: string;
  readonly captureId: string;
  readonly projectRoot: string;
  /** The editor connection announcing the scenario's project. */
  readonly editor: HarnessWsClient;
  /** The DevTools connection bound to the scenario's tab. */
  readonly devtools: HarnessWsClient;
  /** The batch the capture was fed, as ingested. */
  readonly events: readonly TelemetryEventIngress[];
  /** The capture summary `capture.stop` answered with. */
  readonly summary: CaptureSummary;
  /** The session once analysis and panel generation settled. */
  readonly final: SessionRecord;
}

/**
 * The cross-tier batch for one scenario: the committed events, or an in-memory
 * copy whose event ids carry `tag` in place of the committed batch tag. Only the
 * ids change — trace ids, span ids, timing and attributes are the committed
 * bytes — so every scenario's capture holds the same trace.
 */
function scenarioEvents(tag: string | undefined): readonly TelemetryEventIngress[] {
  const committed = readTelemetryBatch(CROSS_TIER_BATCH);
  if (tag === undefined) {
    return committed;
  }
  return committed.map((event) => {
    if (!event.id.startsWith(COMMITTED_EVENT_PREFIX)) {
      throw new Error(`The committed event ${event.id} does not carry the batch tag.`);
    }
    return {
      ...event,
      id: `${EVENT_ID_PREFIX}${tag}${event.id.slice(COMMITTED_EVENT_PREFIX.length)}`,
    };
  });
}

/**
 * Runs one scenario through the real service: a fresh project copy and dev
 * server, a session whose pipeline installs its plan, a bound tab whose agent
 * reports in, a capture fed by both producers — the page agent's relay for the
 * browser tier and the preload's ingest route for the server and database
 * tiers — and the analysis and panel stages that `capture.stop` sets off.
 *
 * Only the panel stage meets a scripted answer; understand, investigate, plan
 * and analyze run on the real deterministic provider, so the analysis every
 * panel is judged against is a validated `AnalysisResult` of this capture.
 */
async function runScenario(spec: ScenarioSpec): Promise<ScenarioRun> {
  const scripted = router.use(spec.script);
  const project = await harness.copyFixtureProject();
  const launched = unwrap(
    await harness.launchDevServer(project.root),
    `${spec.label}: devServer.launch`,
  );
  const editor = await harness.editor(project.root);
  const created = await harness.createSession({ projectRoot: project.root, question: QUESTION });
  const installed = await harness.waitForSession(created.id, (record) =>
    INSTALLED_STATUSES.includes(record.status),
  );
  if (installed.status === 'failed') {
    throw new Error(`${spec.label}: the session failed before it could be captured.`);
  }

  const { client: devtools } = await harness.connectDevtools({ tabId: spec.tabId });
  const pageUrl = launched.devServerUrl;
  const bound = await harness.bindTab(devtools, {
    tabId: spec.tabId,
    url: pageUrl,
    origin: new URL(pageUrl).origin,
    sessionId: created.id,
  });
  if (!bound.ok) {
    throw new Error(`${spec.label}: session.bind was refused (${bound.error.code}).`);
  }

  const events = scenarioEvents(spec.eventTag);
  const browserEvents = events.filter((event) => event.tier === 'browser');
  const serverEvents = events.filter((event) => event.tier !== 'browser');
  const browserProducer = single([...new Set(browserEvents.map((e) => e.producerId))], 'producer');

  // The service worker's relay of the page agent's report for the bound tab:
  // installed before React, so the readiness gate admits `ready`.
  const report = devtools.send('agent.ready', {
    tabId: spec.tabId,
    documentId: `document-${spec.label}`,
    producerId: browserProducer,
    url: pageUrl,
    installedBeforeReact: true,
    reactDetected: true,
  });
  await devtools.flush();
  if (devtools.errorsFor(report.id).length > 0) {
    throw new Error(`${spec.label}: agent.ready was refused.`);
  }

  const { captureId } = unwrap(
    await harness.startCapture(created.id),
    `${spec.label}: capture.start`,
  );
  const relayed = await harness.ingestFromAgent(devtools, browserEvents);
  if (!relayed.settled || relayed.errors.length > 0) {
    throw new Error(`${spec.label}: the relayed browser batch was refused.`);
  }
  const credential = harness.issueServerAgentCredential(project.root);
  const ingested = unwrap(
    await harness.ingestFromServerAgent({
      token: credential.token,
      projectRoot: project.root,
      events: serverEvents,
    }),
    `${spec.label}: telemetry ingest`,
  );
  if (ingested.accepted !== serverEvents.length) {
    throw new Error(`${spec.label}: the server batch was only partly stored.`);
  }

  const { summary } = unwrap(await harness.stopCapture(created.id), `${spec.label}: capture.stop`);
  const final = await harness.waitForSession(created.id, (record) =>
    SETTLED_STATUSES.includes(record.status),
  );

  return Object.freeze({
    label: spec.label,
    scripted,
    sessionId: created.id,
    captureId,
    projectRoot: project.root,
    editor,
    devtools,
    events,
    summary,
    final,
  });
}

/** `1 + DEFAULT_MAX_REPAIRS` copies of one step: exactly the attempts the budget allows. */
function everyAttempt(fixture: string): readonly ScriptedStep[] {
  return Array.from({ length: 1 + DEFAULT_MAX_REPAIRS }, () =>
    scriptedFixtureStep(PANEL_PROMPT_STAGE, fixture),
  );
}

/**
 * A step that must never be served. Scripted after the attempts a scenario is
 * allowed, it would answer one call too many — and turn a rejection into an
 * acceptance — so `remaining() === 1` proves no further call was made.
 */
function tripwire(fixture: string): ScriptedStep {
  return scriptedFixtureStep(PANEL_PROMPT_STAGE, fixture);
}

/* -------------------------------------------------------------------------------------------------
 * What a scenario observed
 * ---------------------------------------------------------------------------------------------- */

/** The panel-stage calls a scenario's provider received, in order. */
function panelCalls(scripted: ScriptedProvider): readonly ScriptedProviderCall[] {
  return scripted.calls.filter((call) => call.stage === PANEL_PROMPT_STAGE);
}

/** A received message together with its position in the client's transcript. */
interface Indexed<T> {
  readonly index: number;
  readonly message: T;
}

/** The `session.updated` frames a client received for one session. */
function sessionUpdates(
  client: HarnessWsClient,
  sessionId: string,
): readonly Indexed<HarnessMessage<'session.updated'>>[] {
  const found: Indexed<HarnessMessage<'session.updated'>>[] = [];
  client.received.forEach((message, index) => {
    if (isMessageOfType(message, 'session.updated') && message.payload.session.id === sessionId) {
      found.push({ index, message });
    }
  });
  return found;
}

/** The `panel.generated` frames a client received for one session. */
function panelBroadcasts(
  client: HarnessWsClient,
  sessionId: string,
): readonly Indexed<HarnessMessage<'panel.generated'>>[] {
  const found: Indexed<HarnessMessage<'panel.generated'>>[] = [];
  client.received.forEach((message, index) => {
    if (isMessageOfType(message, 'panel.generated') && message.payload.sessionId === sessionId) {
      found.push({ index, message });
    }
  });
  return found;
}

/** The `analysis.completed` frames a client received for one session. */
function analysisBroadcasts(
  client: HarnessWsClient,
  sessionId: string,
): readonly Indexed<HarnessMessage<'analysis.completed'>>[] {
  const found: Indexed<HarnessMessage<'analysis.completed'>>[] = [];
  client.received.forEach((message, index) => {
    if (isMessageOfType(message, 'analysis.completed') && message.payload.sessionId === sessionId) {
      found.push({ index, message });
    }
  });
  return found;
}

/** The `session.progress` rows a client received for one session. */
function progressRows(
  client: HarnessWsClient,
  sessionId: string,
): readonly HarnessMessage<'session.progress'>['payload'][] {
  return client.received.flatMap((message) =>
    isMessageOfType(message, 'session.progress') && message.payload.sessionId === sessionId
      ? [message.payload]
      : [],
  );
}

/** The ordered statuses the editor saw the session move through, replays collapsed. */
function statusTrail(run: ScenarioRun): readonly SessionStatus[] {
  return collapseRepeats(
    sessionUpdates(run.editor, run.sessionId).map(({ message }) => message.payload.session.status),
  );
}

/** The service's log records with `message` for one session. */
function logsFor(sessionId: string, message: string): readonly CapturedLogRecord[] {
  return harness.logger
    .withMessage(message)
    .filter((record) => record.fields['sessionId'] === sessionId);
}

/** The one log record with `message` for one session. */
function logFor(sessionId: string, message: string): CapturedLogRecord {
  return single(logsFor(sessionId, message), `"${message}" record for ${sessionId}`);
}

/** Every panel the store holds for a session, oldest version first. */
function storedPanels(sessionId: string): readonly PanelSpec[] {
  return unwrap(harness.repos.panels.listPanels(sessionId), 'panels.listPanels');
}

/** Every analysis the store holds for a session, oldest version first. */
function storedAnalyses(sessionId: string): readonly AnalysisResult[] {
  return unwrap(harness.repos.panels.listAnalyses(sessionId), 'panels.listAnalyses');
}

/** The session's one stored analysis: the validated artifact every panel is judged against. */
function storedAnalysis(sessionId: string): AnalysisResult {
  return single(storedAnalyses(sessionId), `stored analysis of ${sessionId}`);
}

/** The store-backed evidence resolvers of one capture, exactly as the service builds them. */
function storeResolvers(run: ScenarioRun): ReturnType<typeof toSemanticValidationOptions> {
  const facts = createAnalysisFacts({
    evidence: harness.repos.telemetry,
    store: harness.repos.panels,
  });
  return toSemanticValidationOptions(facts.createEvidenceResolvers(run.sessionId, run.captureId));
}

/**
 * Asserts the headline guarantee of AAP §0.5.5 for a settled scenario: the
 * session reached `generated` last, straight from `analyzing`, and only after
 * the validated analysis and the stored panel were both announced — and the
 * record that first carried `generated` already names both.
 */
function expectGeneratedOnlyAfterArtifacts(run: ScenarioRun, panel: PanelSpec): void {
  const trail = statusTrail(run);
  expect(trail.at(-1)).toBe('generated');
  expect(trail.indexOf('generated')).toBe(trail.length - 1);
  expect(trail.at(-2)).toBe(STAGE_STATUS[GENERATE_PANEL_STAGE]);

  const updates = sessionUpdates(run.editor, run.sessionId);
  const firstGenerated = updates.find(
    ({ message }) => message.payload.session.status === 'generated',
  );
  if (firstGenerated === undefined) {
    throw new Error(`${run.label}: no session.updated carried "generated".`);
  }
  const analysis = storedAnalysis(run.sessionId);
  const announcedPanel = panelBroadcasts(run.editor, run.sessionId)[0];
  const announcedAnalysis = analysisBroadcasts(run.editor, run.sessionId)[0];
  expect(announcedPanel?.message.payload.panelId).toBe(panel.id);
  expect(announcedAnalysis?.message.payload.analysis.id).toBe(analysis.id);
  expect(announcedPanel?.index ?? Number.POSITIVE_INFINITY).toBeLessThan(firstGenerated.index);
  expect(announcedAnalysis?.index ?? Number.POSITIVE_INFINITY).toBeLessThan(firstGenerated.index);

  const record = firstGenerated.message.payload.session;
  expect(record.panelIds).toContain(panel.id);
  expect(record.analyses.map((entry) => entry.id)).toContain(analysis.id);
  expect(canTransition('analyzing', 'generated', { analysis, panel })).toBe(true);
}

/* -------------------------------------------------------------------------------------------------
 * The normaliser-defect generation
 * ---------------------------------------------------------------------------------------------- */

/** What one generation through a defective normaliser produced. */
interface DefectRun {
  /** The generator's answer. */
  readonly result: Result<PanelGenerationResult, DebuggenError>;
  /** The provider record of the generation: one scripted, valid authoring answer. */
  readonly scripted: ScriptedProvider;
  /** How many times the structured-output loop invoked the normaliser. */
  readonly normaliserCalls: number;
  /** Every value the defective normaliser threw, in order, exactly as thrown. */
  readonly thrown: readonly unknown[];
  /** The validated analysis the generation was handed. */
  readonly analysis: AnalysisResult;
}

/** How one defective generation is provoked. */
interface NormaliserDefect {
  /** The panel stage's one scripted answer: a schema-valid authoring payload. */
  readonly answer: ScriptedStep;
  /**
   * The defective normaliser. It is handed the parsed answer and the
   * validator's real normalise-then-validate callback, and must throw.
   */
  readonly normalize: (input: PanelSpecInput, real: PanelStructuredNormalizer) => PanelSpec;
}

/**
 * The default defect: the valid authored payload, whose first node the real
 * normaliser is then handed under a type the catalog does not know.
 */
function uncataloguedDefect(): NormaliserDefect {
  return {
    answer: scriptedFixtureStep(PANEL_PROMPT_STAGE, VALID_PANEL),
    normalize: (input, real) => real(withUncataloguedFirstNode(input)),
  };
}

/**
 * Generates one panel for a scenario's stored capture through the panel
 * subsystem composed exactly as `startService` composes it — the same store,
 * evidence resolvers, capture summaries, validator, fallback builder and
 * prompts — except that the validator's normaliser callback is replaced by
 * `defect.normalize`. By default that hands the real `normalizePanel` an input
 * whose first node the catalog does not know, and the normaliser throws its own
 * exhaustiveness error on input the authoring schema had accepted: the product
 * defect AAP §0.5.3 says is logged and never retried against the model. The
 * record it is logged with carries closed fields only — never the parsed input,
 * whose prose can echo developer source (CWE-532).
 *
 * @param run The scenario whose stored capture and validated analysis the panel answers for.
 * @param defect The answer and the defect; {@link uncataloguedDefect} when omitted.
 */
async function runNormaliserDefect(
  run: ScenarioRun,
  defect: NormaliserDefect = uncataloguedDefect(),
): Promise<DefectRun> {
  const logger = harness.logger.root;
  const facts = createAnalysisFacts({
    evidence: harness.repos.telemetry,
    store: harness.repos.panels,
    logger,
  });
  const summarizer = createAnalysisSummarizer({
    telemetry: harness.repos.telemetry,
    sessions: harness.repos.sessions,
    panels: harness.repos.panels,
    logger,
  });
  const validator = createPanelValidator({ evidence: facts, captures: summarizer, logger });

  let normaliserCalls = 0;
  const thrown: unknown[] = [];
  const defective: PanelValidator = {
    ...validator,
    buildStructuredOptionsNormalizer: (analysis, context) => {
      const real = validator.buildStructuredOptionsNormalizer(analysis, context);
      return (input: PanelSpecInput): PanelSpec => {
        normaliserCalls += 1;
        try {
          return defect.normalize(input, real);
        } catch (failure) {
          // Recorded, then rethrown unchanged: the structured-output loop must
          // see exactly what the defect threw.
          thrown.push(failure);
          throw failure;
        }
      };
    },
  };

  const scripted = createScriptedProvider([defect.answer]);
  const generator = createPanelGenerator({
    provider: scripted.provider,
    prompts: createPromptLoader({ promptsDir: PROMPTS_DIR, env: {}, logger }),
    validator: defective,
    fallback: createFallbackPanelBuilder({ validator, captures: summarizer, logger }),
    panels: harness.repos.panels,
    captures: summarizer,
    logger,
  });

  const analysis = storedAnalysis(run.sessionId);
  const result = await generator.generate({
    sessionId: run.sessionId,
    captureId: run.captureId,
    question: QUESTION,
    analysis,
  });
  return Object.freeze({ result, scripted, normaliserCalls, thrown, analysis });
}

/* -------------------------------------------------------------------------------------------------
 * The authored payloads, read once and held to their contracts by the harness
 * ---------------------------------------------------------------------------------------------- */

/** Refused by the authoring schema: unknown node type, unknown source, unknown metric, … */
const INVALID_AUTHORED: unknown = readFixtureJson(INVALID_PANEL);

/** Accepted everywhere against a capture of the cross-tier batch. */
const VALID_AUTHORED: unknown = readFixtureJson(VALID_PANEL);

/** Accepted by both schemas, refuted by the capture: an absent trace and fabricated evidence. */
const SEMANTIC_AUTHORED: unknown = readFixtureJson(SEMANTIC_INVALID_PANEL);

/** The authoring schema's parse of the valid payload: the input the normaliser is handed. */
function parsedValidPanel(): PanelSpecInput {
  const parsed = panelSpecInputSchema.safeParse(VALID_AUTHORED);
  if (!parsed.success) {
    throw new Error(`${VALID_PANEL} no longer parses through the authoring schema.`);
  }
  return parsed.data;
}

/**
 * The valid payload with {@link PRIVATE_SENTINEL} written into its free prose —
 * the panel title, a string summary and every node title — and parsed again,
 * so the answer is one the authoring schema accepts and the normaliser is
 * handed: the model echoing private text into a panel it otherwise got right.
 */
function privateAnswer(): PanelSpecInput {
  const withSentinel = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return (value as readonly unknown[]).map(withSentinel);
    }
    if (!isRecord(value)) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, element]) => [
        key,
        key === 'title' && typeof element === 'string'
          ? `${element} (${PRIVATE_SENTINEL})`
          : withSentinel(element),
      ]),
    );
  };
  const authored = withSentinel({
    ...parsedValidPanel(),
    summary: `Most of the interaction time is spent reading ${PRIVATE_SENTINEL}.`,
  });
  const parsed = panelSpecInputSchema.safeParse(authored);
  if (!parsed.success) {
    throw new Error('The private answer no longer parses through the authoring schema.');
  }
  return parsed.data;
}

/** The messages along a thrown value's `cause` chain, outermost first. */
function causeMessages(thrown: unknown): readonly string[] {
  const messages: string[] = [];
  let current: unknown = thrown;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages;
}

/** The statements an authored summary writes in its fact and cause lists. */
function authoredStatements(authored: unknown): readonly string[] {
  return ['observed', 'likelyCauses'].flatMap((list) => {
    const entries = pick(authored, 'summary', list);
    if (!Array.isArray(entries)) {
      throw new Error(`The authored summary's ${list} is not a list.`);
    }
    return (entries as readonly unknown[]).map((entry) => pickText(entry, 'statement'));
  });
}

/**
 * The formatted Zod issues of the invalid payload, exactly as the structured
 * output loop formats them for a repair turn: the same schema, the same
 * formatter, the same default bound.
 */
function invalidPanelIssues(): string {
  const parsed = panelSpecInputSchema.safeParse(INVALID_AUTHORED);
  if (parsed.success) {
    throw new Error(`${INVALID_PANEL} unexpectedly parses through the authoring schema.`);
  }
  return formatZodIssues(parsed.error);
}

/**
 * The values of the invalid payload that the authoring schema refused and that
 * no catalog, prompt or analysis vocabulary contains: the unknown node type,
 * the unknown metric and the authored summary sentence. Read from the fixture,
 * never restated.
 */
function refusedValues(): readonly string[] {
  return [
    pickText(INVALID_AUTHORED, 'layout', 0, 'type'),
    pickText(INVALID_AUTHORED, 'layout', 2, 'metrics', 0),
    pickText(INVALID_AUTHORED, 'summary'),
  ];
}

/** The refused data source of the invalid payload's table: a short word, matched as a whole value. */
function refusedSource(): string {
  return pickText(INVALID_AUTHORED, 'layout', 1, 'source');
}

/**
 * The fact candidates `analysis/facts.ts` offers for a scenario's capture —
 * the list the analysis stage chose from. A fallback panel may carry only what
 * the validated analysis adopted, never a candidate it left out.
 */
async function factCandidateStatements(run: ScenarioRun): Promise<readonly string[]> {
  const summarizer = createAnalysisSummarizer({
    telemetry: harness.repos.telemetry,
    sessions: harness.repos.sessions,
    panels: harness.repos.panels,
  });
  const facts = createAnalysisFacts({
    evidence: harness.repos.telemetry,
    store: harness.repos.panels,
  });
  const built = unwrap(
    await summarizer.buildStageInput({
      sessionId: run.sessionId,
      captureId: run.captureId,
      question: QUESTION,
    }),
    `${run.label}: analysis stage input`,
  );
  return facts
    .candidatesFor({ input: built.input, summary: run.summary })
    .map((candidate) => candidate.statement);
}

/** The findings of an analysis or a panel summary, as one comparable value. */
function findingsOf(document: {
  readonly observed: AnalysisResult['observed'];
  readonly likelyCauses: AnalysisResult['likelyCauses'];
}): unknown {
  return { observed: document.observed, likelyCauses: document.likelyCauses };
}

/** Every event id a scenario ingested. */
function ingestedEventIds(run: ScenarioRun): ReadonlySet<string> {
  return new Set(run.events.map((event) => event.id));
}

/** One progress line, as the store and a `session.progress` frame both describe it. */
interface ProgressLine {
  readonly stage: string;
  readonly status: string;
  readonly message: string;
  readonly detail?: unknown;
}

/**
 * The progress lines the store holds for a session, each exactly once. The
 * clients' transcripts cannot be counted: the service replays a session's
 * progress history to its clients, so a transcript repeats lines it has
 * already carried. The store is the authoritative, de-duplicated record.
 */
function storedProgress(sessionId: string): readonly ProgressLine[] {
  return unwrap(harness.repos.sessions.listProgress(sessionId), 'sessions.listProgress');
}

/** Whether a progress line is the given stage's line with that status and, optionally, that message. */
function isLine(stage: string, status: string, message?: string): (line: ProgressLine) => boolean {
  return (line) =>
    line.stage === stage &&
    line.status === status &&
    (message === undefined || line.message === message);
}

/** Whether a progress line is the fallback banner row (AAP §0.5.5), compared against its constant. */
const isBannerLine = isLine(GENERATE_PANEL_STAGE, 'done', FALLBACK_BANNER_MESSAGE);

/** The stored banner rows of a session; exactly one for a fallback panel, none otherwise. */
function bannerRows(run: ScenarioRun): readonly ProgressLine[] {
  return storedProgress(run.sessionId).filter(isBannerLine);
}

/**
 * The `panel.generated` frames a client received for a session, asserted to
 * be the live broadcast and its replays of one stored panel: at least one
 * frame, each a valid payload carrying exactly that panel.
 */
function expectPanelBroadcasts(client: HarnessWsClient, run: ScenarioRun, panel: PanelSpec): void {
  const frames = panelBroadcasts(client, run.sessionId);
  expect(frames.length).toBeGreaterThan(0);
  for (const { message } of frames) {
    expect(panelGeneratedPayloadSchema.safeParse(message.payload).success).toBe(true);
    expect(message.payload.panelId).toBe(panel.id);
    expect(message.payload.panel).toEqual(panel);
  }
}

/**
 * Everything a surface could present about a scenario: the stored panels,
 * analyses, session record and progress rows, and every `panel.generated`,
 * `analysis.completed` and `session.progress` frame either client received.
 */
function presentedArtifacts(run: ScenarioRun): readonly unknown[] {
  const frames = [run.editor, run.devtools].flatMap((client) => [
    ...panelBroadcasts(client, run.sessionId).map(({ message }) => message.payload),
    ...analysisBroadcasts(client, run.sessionId).map(({ message }) => message.payload),
    ...progressRows(client, run.sessionId),
  ]);
  return [
    storedPanels(run.sessionId),
    storedAnalyses(run.sessionId),
    unwrap(harness.repos.sessions.get(run.sessionId), 'sessions.get'),
    unwrap(harness.repos.sessions.listProgress(run.sessionId), 'sessions.listProgress'),
    run.final,
    frames,
  ];
}

/**
 * Asserts a stored panel is the deterministic fallback of AAP §0.5.3: flagged,
 * titled, headed and composed exactly as `panels/fallback.ts` builds it,
 * carrying the validated analysis's findings and nothing else.
 */
function expectFallbackPanel(panel: PanelSpec, analysis: AnalysisResult): void {
  expect(panel.meta?.fallback).toBe(true);
  expect(panel.title).toBe(FALLBACK_TITLE);
  const hasFindings = analysis.observed.length + analysis.likelyCauses.length > 0;
  expect(panel.summary.headline).toBe(
    hasFindings ? FALLBACK_HEADLINES.withFindings : FALLBACK_HEADLINES.withoutFindings,
  );
  expect(findingsOf(panel.summary)).toEqual(findingsOf(analysis));
  expect(validatePanelSpec(panel).ok).toBe(true);

  const sectionTitles: readonly string[] = Object.values(FALLBACK_SECTION_TITLES);
  expect(panel.layout.length).toBeGreaterThan(0);
  for (const node of panel.layout) {
    expect(node.type).toBe('section');
    if (node.type === 'section') {
      expect(sectionTitles).toContain(node.title);
      expect(node.children).toHaveLength(1);
    }
  }
  for (const { node } of nodesOf(panel)) {
    expect(Object.hasOwn(PANEL_NODE_CATALOG, node.type)).toBe(true);
    if ('query' in node) {
      expect(isSourceAllowedForNode(node.type, node.query.source)).toBe(true);
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * The authored triple: an authoring-schema failure, a successful repair, a semantic refutation
 * ---------------------------------------------------------------------------------------------- */

describe('the three authored panel payloads, each answered for a real capture', () => {
  let rejected: ScenarioRun;
  let repaired: ScenarioRun;
  let refuted: ScenarioRun;

  beforeAll(async () => {
    rejected = await runScenario({
      label: 'authoring-schema',
      tabId: 11,
      eventTag: 'pa',
      script: [...everyAttempt(INVALID_PANEL), tripwire(VALID_PANEL)],
    });
    repaired = await runScenario({
      label: 'repaired',
      tabId: 12,
      eventTag: undefined,
      script: [
        scriptedFixtureStep(PANEL_PROMPT_STAGE, INVALID_PANEL),
        scriptedFixtureStep(PANEL_PROMPT_STAGE, VALID_PANEL),
        tripwire(INVALID_PANEL),
      ],
    });
    refuted = await runScenario({
      label: 'semantic',
      tabId: 13,
      eventTag: 'pc',
      script: [
        scriptedFixtureStep(PANEL_PROMPT_STAGE, SEMANTIC_INVALID_PANEL),
        tripwire(VALID_PANEL),
      ],
    });
  }, 3 * SCENARIO_TIMEOUT_MS);

  it('drives the three fixtures to three distinguishable outcomes', () => {
    const outcomeOf = (run: ScenarioRun): unknown => {
      const stored = logFor(run.sessionId, LOG.stored);
      return stored.fields['fallback'] === true ? stored.fields['fallbackReason'] : 'accepted';
    };
    const outcomes = [rejected, repaired, refuted].map(outcomeOf);

    expect(outcomes).toEqual(['authoring-schema', 'accepted', 'semantic']);
    expect(new Set(outcomes).size).toBe(3);
    expect(PANEL_FAILURE_CLASSES).toContain(outcomes[0]);
    expect(PANEL_FAILURE_CLASSES).toContain(outcomes[2]);

    // The panel stage is the only one a script answered; every earlier stage,
    // analysis included, ran on the real deterministic provider.
    for (const run of [rejected, repaired, refuted]) {
      const earlier = run.scripted.calls.filter((call) => call.stage !== PANEL_PROMPT_STAGE);
      expect(earlier.map((call) => call.stage)).toContain('analyze');
      expect(earlier.every((call) => !call.scripted)).toBe(true);
      expect(panelCalls(run.scripted).every((call) => call.scripted)).toBe(true);
      expect(parseAnalysisResult(storedAnalysis(run.sessionId)).ok).toBe(true);
    }
    // A fallback is a success: every one of the three sessions reached `generated`.
    expect([rejected, repaired, refuted].map((run) => run.final.status)).toEqual([
      'generated',
      'generated',
      'generated',
    ]);
  });

  describe('an authoring-schema failure', () => {
    it('spends exactly 1 + DEFAULT_MAX_REPAIRS provider calls and never a fourth', () => {
      const calls = panelCalls(rejected.scripted);

      expect(DEFAULT_MAX_REPAIRS).toBe(2);
      expect(calls).toHaveLength(1 + DEFAULT_MAX_REPAIRS);
      expect(calls.every((call) => call.scripted && call.method === 'generateStructured')).toBe(
        true,
      );
      // The tripwire — a valid answer that would have ended the rejection — was never served.
      expect(rejected.scripted.remaining()).toBe(1);
      expect(PANEL_FAILURE_POLICY['authoring-schema'].repairable).toBe(true);

      const spent = logFor(rejected.sessionId, LOG.budgetSpent);
      expect(spent.fields['attempts']).toBe(1 + DEFAULT_MAX_REPAIRS);
      expect(spent.fields['repairs']).toBe(DEFAULT_MAX_REPAIRS);
      const substituted = logFor(rejected.sessionId, LOG.rejected);
      expect(substituted.fields['failureClass']).toBe('authoring-schema');
      expect(substituted.fields['attempts']).toBe(1 + DEFAULT_MAX_REPAIRS);
      expect(substituted.fields['repairs']).toBe(DEFAULT_MAX_REPAIRS);
    });

    it('carries the formatted Zod issues, and none of the rejected values, in every repair', () => {
      const [first, ...repairs] = panelCalls(rejected.scripted);
      if (first === undefined) {
        throw new Error('The rejected scenario made no panel call.');
      }
      const original = first.request.messages ?? [];
      expect(original.some((turn) => turn.content === REPAIR_ASSISTANT_NOTICE)).toBe(false);

      const issues = invalidPanelIssues();
      expect(issues.length).toBeGreaterThan(0);
      expect(repairs).toHaveLength(DEFAULT_MAX_REPAIRS);

      repairs.forEach((call, index) => {
        const messages = call.request.messages ?? [];
        // A repair re-sends the original turns plus one correction — never the rejected answer.
        expect(messages.slice(0, -2)).toEqual(original);
        const [notice, correction] = messages.slice(-2);
        expect(notice).toEqual({ role: 'assistant', content: REPAIR_ASSISTANT_NOTICE });
        expect(correction?.role).toBe('user');
        const content = correction?.content ?? '';
        expect(content).toContain(`Attempt ${String(index + 1)}`);
        expect(content).toContain(issues);
        for (const value of refusedValues()) {
          expect(content).not.toContain(value);
        }
        expect(content.split(/\W+/u)).not.toContain(refusedSource());
        // The structured half of the request is carried across unchanged.
        expect(call.request.input).toEqual(first.request.input);
      });
    });

    it('stores, broadcasts and validates the deterministic fallback panel', () => {
      const panel = single(storedPanels(rejected.sessionId), 'stored panel');
      const analysis = storedAnalysis(rejected.sessionId);

      expect(panel.panelVersion).toBe(1);
      expect(panel.sessionId).toBe(rejected.sessionId);
      expectFallbackPanel(panel, analysis);

      const stored = logFor(rejected.sessionId, LOG.stored);
      expect(stored.fields).toMatchObject({
        panelId: panel.id,
        panelVersion: panel.panelVersion,
        fallback: true,
        fallbackReason: 'authoring-schema',
        attempts: 1 + DEFAULT_MAX_REPAIRS,
        repairs: DEFAULT_MAX_REPAIRS,
        broadcast: true,
      });

      for (const client of [rejected.editor, rejected.devtools]) {
        expectPanelBroadcasts(client, rejected, panel);
      }
      expect(rejected.final.panelIds).toEqual([panel.id]);
      // The banner is the AAP §0.5.5 sentence, stored once and pushed to both surfaces.
      expect(bannerRows(rejected)).toHaveLength(1);
      for (const client of [rejected.editor, rejected.devtools]) {
        expect(progressRows(client, rejected.sessionId).some(isBannerLine)).toBe(true);
      }
    });

    it('composes the fallback from catalogued nodes and the validated analysis alone', async () => {
      const panel = single(storedPanels(rejected.sessionId), 'stored panel');
      const analysis = storedAnalysis(rejected.sessionId);

      expect(parseAnalysisResult(analysis).ok).toBe(true);
      expect(findingsOf(panel.summary)).toEqual(findingsOf(analysis));
      const ingested = ingestedEventIds(rejected);
      expect(citedEventIds(panel).length).toBeGreaterThan(0);
      for (const eventId of citedEventIds(panel)) {
        expect(ingested.has(eventId)).toBe(true);
      }

      const adopted = new Set(
        [...analysis.observed, ...analysis.likelyCauses].map((finding) => finding.statement),
      );
      const offered = await factCandidateStatements(rejected);
      expect(offered.length).toBeGreaterThan(0);
      const panelText = haystackOf(panel);
      for (const statement of offered.filter((candidate) => !adopted.has(candidate))) {
        expect(panelText).not.toContain(statement);
      }
    });

    it('never presents the raw rejection as analysis; only the logs hold it', () => {
      const artifacts = presentedArtifacts(rejected);
      const presented = haystackOf(...artifacts);
      const issueLines = invalidPanelIssues()
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      expect(issueLines.length).toBeGreaterThan(0);
      for (const line of issueLines) {
        expect(presented).not.toContain(line);
      }
      expect(presented).not.toContain('failed validation after');
      for (const value of refusedValues()) {
        expect(presented).not.toContain(value);
      }
      expect(collectStrings(artifacts)).not.toContain(refusedSource());

      // The logs are where the rejection lives: its paths, bounded, with the class.
      const spent = logFor(rejected.sessionId, LOG.budgetSpent);
      const paths = spent.fields['issuePaths'];
      if (!Array.isArray(paths)) {
        throw new Error('The budget-spent record carries no issue paths.');
      }
      expect(paths.length).toBeGreaterThan(0);
      const issues = invalidPanelIssues();
      for (const path of paths as readonly unknown[]) {
        expect(issues).toContain(String(path));
      }
      expect(logFor(rejected.sessionId, LOG.rejected).fields['code']).toBe('MODEL_OUTPUT_INVALID');
    });
  });

  describe('a repair that succeeds', () => {
    it('accepts the corrected answer on the second call, with one repair and no fallback', () => {
      expect(panelCalls(repaired.scripted)).toHaveLength(2);
      // The tripwire — another invalid answer — was never requested.
      expect(repaired.scripted.remaining()).toBe(1);

      const panel = single(storedPanels(repaired.sessionId), 'stored panel');
      expect(panel.meta?.fallback ?? false).toBe(false);
      expect(validatePanelSpec(panel).ok).toBe(true);
      expect(validateAgainstCapture(panel, repaired.summary, storeResolvers(repaired)).status).toBe(
        'valid',
      );

      expect(logFor(repaired.sessionId, LOG.stored).fields).toMatchObject({
        panelId: panel.id,
        fallback: false,
        attempts: 2,
        repairs: 1,
        broadcast: true,
      });
      expect(logsFor(repaired.sessionId, LOG.rejected)).toHaveLength(0);
      expect(bannerRows(repaired)).toHaveLength(0);
      for (const client of [repaired.editor, repaired.devtools]) {
        expectPanelBroadcasts(client, repaired, panel);
        expect(progressRows(client, repaired.sessionId).some(isBannerLine)).toBe(false);
      }
    });

    it('normalises the authoring form into the internal panel', () => {
      const panel = single(storedPanels(repaired.sessionId), 'stored panel');
      const analysis = storedAnalysis(repaired.sessionId);
      const authored = (...path: readonly (string | number)[]): unknown =>
        pick(VALID_AUTHORED, 'layout', ...path);
      const typeAt = (...path: readonly (string | number)[]): string =>
        pickText(VALID_AUTHORED, 'layout', ...path, 'type');

      expect(withoutNodeIds(panel.layout)).toEqual([
        // A metric-card node with no source receives the implicit metrics query; `metrics` stays an option.
        { type: typeAt(0), metrics: authored(0, 'metrics'), query: { source: 'metrics' } },
        // Flat `source` and `filter` are lifted into the node's query.
        {
          type: typeAt(1),
          query: { source: authored(1, 'source'), filter: authored(1, 'filter') },
        },
        // The nested section is preserved, its children lifted in turn.
        {
          type: typeAt(2),
          title: authored(2, 'title'),
          children: [
            {
              type: typeAt(2, 'children', 0),
              title: authored(2, 'children', 0, 'title'),
              query: {
                source: authored(2, 'children', 0, 'source'),
                sort: authored(2, 'children', 0, 'sort'),
                limit: authored(2, 'children', 0, 'limit'),
              },
            },
            {
              type: typeAt(2, 'children', 1),
              query: {
                source: authored(2, 'children', 1, 'source'),
                sort: authored(2, 'children', 1, 'sort'),
              },
            },
          ],
        },
        // The source-link leaf carries a direct location and no query.
        { type: typeAt(3), location: authored(3, 'location') },
      ]);

      const nodes = nodesOf(panel);
      const ids = nodes.map(({ node }) => node.id);
      expect(new Set(ids).size).toBe(nodes.length);
      const link = single(
        nodes.filter(({ node }) => node.type === 'sourceLink'),
        'source link',
      ).node;
      expect('query' in link).toBe(false);
      expect(sourceOf(link)).toBeUndefined();

      // A plain-string summary becomes the non-evidentiary headline, never a fact.
      const headline = pickText(VALID_AUTHORED, 'summary');
      expect(panel.summary.headline).toBe(headline);
      expect(panel.summary.observed.map((fact) => fact.statement)).not.toContain(headline);
      expect(findingsOf(panel.summary)).toEqual(findingsOf(analysis));
    });
  });

  describe('the evidence resolvers', () => {
    it('keep the genuine panel: the store confirms what a bounded summary cannot', () => {
      const panel = single(storedPanels(repaired.sessionId), 'stored panel');
      const cited = citedEventIds(panel);

      // The control cites the committed ids and filters on the capture's real trace.
      expect(cited.length).toBeGreaterThan(0);
      expect(cited.every((id) => id.startsWith(COMMITTED_EVENT_PREFIX))).toBe(true);
      expect(filteredTraceIds(panel)).toEqual([
        pickText(VALID_AUTHORED, 'layout', 1, 'filter', 'traceId'),
      ]);
      expect(repaired.summary.traceIds).toEqual(filteredTraceIds(panel));

      // A summary that cannot see the cited events leaves the honest verdict open…
      const bounded = boundedSummary(repaired.summary);
      expect(validateAgainstCapture(panel, bounded).status).toBe('unverifiable');
      // …and the resolvers the service builds close it in the panel's favour.
      expect(validateAgainstCapture(panel, bounded, storeResolvers(repaired)).status).toBe('valid');

      // The service asked the store too, and was answered for every citation and trace.
      expect(logFor(repaired.sessionId, LOG.semanticPassed).fields).toMatchObject({
        resolversSupplied: true,
        resolvedEventIds: cited.length,
        resolvedTraceIds: filteredTraceIds(panel).length,
      });
      expect(
        storedPanels(repaired.sessionId).every((stored) => stored.meta?.fallback !== true),
      ).toBe(true);
    });

    it('refute a panel citing an absent trace as invalid, not unverifiable, without a repair', () => {
      expect(panelCalls(refuted.scripted)).toHaveLength(1);
      // The tripwire — a valid answer a repair would have received — was never requested.
      expect(refuted.scripted.remaining()).toBe(1);
      expect(PANEL_FAILURE_POLICY.semantic.repairable).toBe(false);

      expect(logFor(refuted.sessionId, LOG.semanticRejected).fields).toMatchObject({
        outcome: 'invalid',
        resolversSupplied: true,
      });
      expect(logFor(refuted.sessionId, LOG.rejected).fields).toMatchObject({
        failureClass: 'semantic',
        outcome: 'invalid',
        resolversSupplied: true,
        attempts: 1,
        repairs: 0,
      });

      const absentTrace = pickText(SEMANTIC_AUTHORED, 'layout', 1, 'filter', 'traceId');
      const resolvers = storeResolvers(refuted);
      const resolution = resolvers.resolveTraceIds?.([absentTrace]);
      expect(resolution?.unknown.has(absentTrace)).toBe(true);

      const panel = single(storedPanels(refuted.sessionId), 'stored panel');
      expectFallbackPanel(panel, storedAnalysis(refuted.sessionId));
      expect(logFor(refuted.sessionId, LOG.stored).fields['fallbackReason']).toBe('semantic');
      expect(bannerRows(refuted)).toHaveLength(1);
    });

    it('let no fabricated evidence or absent trace into the normalised or stored panel', () => {
      const parsed = panelSpecInputSchema.safeParse(SEMANTIC_AUTHORED);
      if (!parsed.success) {
        throw new Error(`${SEMANTIC_INVALID_PANEL} no longer parses through the authoring schema.`);
      }
      const analysis = storedAnalysis(refuted.sessionId);
      const normalized = normalizePanel(parsed.data, analysis, {
        id: newPanelId(),
        sessionId: refuted.sessionId,
        panelVersion: storedPanels(refuted.sessionId).length + 1,
      });
      expect(validatePanelSpec(normalized).ok).toBe(true);

      const absentTrace = pickText(SEMANTIC_AUTHORED, 'layout', 1, 'filter', 'traceId');
      const fabricated = collectStrings(pick(SEMANTIC_AUTHORED, 'summary')).filter((value) =>
        value.startsWith(EVENT_ID_PREFIX),
      );
      const statements = authoredStatements(SEMANTIC_AUTHORED);
      expect(fabricated.length).toBeGreaterThan(0);
      expect(statements.length).toBeGreaterThan(0);

      // The normaliser discards authored findings: a string never becomes a Fact.
      expect(findingsOf(normalized.summary)).toEqual(findingsOf(analysis));
      const normalizedText = haystackOf(normalized);
      for (const value of [...fabricated, ...statements]) {
        expect(normalizedText).not.toContain(value);
      }
      // The authored trace filters survive normalisation, which is why the capture must refute them.
      expect(filteredTraceIds(normalized)).toEqual([absentTrace]);
      const verdict = validateAgainstCapture(normalized, refuted.summary, storeResolvers(refuted));
      expect(verdict.status).toBe('invalid');
      if (verdict.status === 'invalid') {
        const unknownTraces = verdict.issues
          .filter((issue) => issue.code === 'panel_trace_unknown')
          .map((issue) => issue.path.map(String).join('.'));
        expect(unknownTraces).toHaveLength(2);
        expect(unknownTraces.every((path) => path.endsWith('query.filter.traceId'))).toBe(true);
      }

      // Nothing a surface presents carries the fabricated ids, the authored claims or the absent trace.
      const presented = haystackOf(...presentedArtifacts(refuted));
      for (const value of [...fabricated, ...statements, absentTrace]) {
        expect(presented).not.toContain(value);
      }
    });
  });

  it('reaches generated only after a validated analysis and a validated panel, fallbacks included', () => {
    for (const run of [rejected, repaired, refuted]) {
      const panel = single(storedPanels(run.sessionId), `${run.label} stored panel`);
      expectGeneratedOnlyAfterArtifacts(run, panel);
    }
    // `meta.fallback` is a legitimate success: the guard admits the fallback exactly as a model panel.
    const fallback = single(storedPanels(rejected.sessionId), 'fallback panel');
    expect(fallback.meta?.fallback).toBe(true);
    expect(
      transition('analyzing', 'generated', {
        analysis: storedAnalysis(rejected.sessionId),
        panel: fallback,
      }).ok,
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * A terminal rejection, a normaliser defect, and the edges of the state machine
 * ---------------------------------------------------------------------------------------------- */

/**
 * A provider outage at the panel stage: the one rejection with no panel to show
 * (AAP §0.5.5). It carries a private hint of its own, which no surface may show.
 */
function providerOutage(): ScriptedStep {
  return {
    stage: PANEL_PROMPT_STAGE,
    failure: new DebuggenError('MODEL_UNAVAILABLE', PROVIDER_OUTAGE_MESSAGE, {
      hint: PROVIDER_OUTAGE_HINT,
    }),
  };
}

/**
 * The private answer, whose first node the real normaliser is then handed
 * under the sentinel as its type: `normalizePanel` quotes a type-shaped name
 * verbatim, so the error it throws — which the validator keeps as the cause of
 * its own `DebuggenError` — carries the sentinel.
 */
function quotingDefect(): NormaliserDefect {
  return {
    answer: { stage: PANEL_PROMPT_STAGE, raw: privateAnswer() },
    normalize: (input, real) => real(withUncataloguedFirstNode(input, PRIVATE_SENTINEL)),
  };
}

/**
 * The private answer, and a normaliser whose defect echoes the model's own
 * title into the message of the native error it throws.
 */
function echoingDefect(): NormaliserDefect {
  return {
    answer: { stage: PANEL_PROMPT_STAGE, raw: privateAnswer() },
    normalize: (input) => {
      throw new Error(`The panel normaliser could not place "${input.title}".`);
    },
  };
}

/** A record's fields without its error field: the part no serializer rewrites. */
function outsideErrorField(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => key !== LOG_ERROR_FIELD_KEY));
}

/** The error field of a captured record, as the service's serializer wrote it. */
function errorFieldOf(record: CapturedLogRecord): Readonly<Record<string, unknown>> {
  const value = record.fields[LOG_ERROR_FIELD_KEY];
  if (!isRecord(value)) {
    throw new Error(`The "${record.message}" record has no error field.`);
  }
  return value;
}

describe('a terminal rejection and a normaliser defect', () => {
  let outage: ScenarioRun;
  /** The outage session's stored panels, read before anything else touches the session. */
  let outagePanels: readonly PanelSpec[];
  let defective: ScenarioRun;
  let defect: DefectRun;
  /** A third outage session, answered by the two defects that carry the private sentinel. */
  let privately: ScenarioRun;
  let quoted: DefectRun;
  let echoed: DefectRun;

  beforeAll(async () => {
    outage = await runScenario({
      label: 'provider',
      tabId: 14,
      eventTag: 'pe',
      script: [providerOutage(), tripwire(VALID_PANEL)],
    });
    outagePanels = storedPanels(outage.sessionId);

    // A second outage leaves a stored capture and a validated analysis with no
    // panel, which the defective normaliser then answers for directly.
    defective = await runScenario({
      label: 'normalize',
      tabId: 15,
      eventTag: 'pd',
      script: [providerOutage()],
    });
    defect = await runNormaliserDefect(defective);

    // A third, so the private defects' panels never share a session with the
    // assertions above that expect exactly one.
    privately = await runScenario({
      label: 'private',
      tabId: 16,
      eventTag: 'pp',
      script: [providerOutage()],
    });
    quoted = await runNormaliserDefect(privately, quotingDefect());
    echoed = await runNormaliserDefect(privately, echoingDefect());
  }, 3 * SCENARIO_TIMEOUT_MS);

  it('leaves the session failed at generate-panel, with no panel and never generated', () => {
    expect(outage.final.status).toBe('failed');
    const trail = statusTrail(outage);
    expect(trail).not.toContain('generated');
    expect(trail.slice(-2)).toEqual([STAGE_STATUS[GENERATE_PANEL_STAGE], 'failed']);

    // A provider failure passes through: one call, no repair, the tripwire unserved.
    expect(panelCalls(outage.scripted)).toHaveLength(1);
    expect(outage.scripted.remaining()).toBe(1);
    expect(PANEL_FAILURE_POLICY.provider.repairable).toBe(false);

    // The validated analysis was stored; no panel was, so `generated` could not be reached.
    expect(parseAnalysisResult(storedAnalysis(outage.sessionId)).ok).toBe(true);
    expect(outagePanels).toHaveLength(0);
    expect(outage.final.panelIds).toEqual([]);
    expect(panelBroadcasts(outage.editor, outage.sessionId)).toHaveLength(0);
    expect(bannerRows(outage)).toHaveLength(0);

    // The failure names its stage: stored once, and pushed to both surfaces.
    // Its row is the public copy of its stage and code, never the provider's
    // own text, and its detail names the code and a diagnostic reference that
    // the one local log record of the failure carries too.
    const isPanelFailure = isLine(GENERATE_PANEL_STAGE, 'failed');
    const failedRow = single(
      storedProgress(outage.sessionId).filter(isPanelFailure),
      'failed generate-panel progress row',
    );
    expect(failedRow.message).toBe(
      publicFailureCopy(GENERATE_PANEL_STAGE, 'MODEL_UNAVAILABLE').message,
    );
    expect(failedRow.message).not.toContain(PROVIDER_OUTAGE_MESSAGE);
    const detail = typeof failedRow.detail === 'string' ? failedRow.detail : '';
    expect(detail).not.toContain(PROVIDER_OUTAGE_MESSAGE);
    expect(detail).toContain('error code: MODEL_UNAVAILABLE');
    const ref = FAILED_ROW_REF_PATTERN.exec(detail)?.[1];
    expect(ref, detail).toBeDefined();
    // The provider's own hint is unproven, so the row's next step is the code's copy.
    expect(detail).toBe(
      `${FAILURE_COPY_BY_CODE.MODEL_UNAVAILABLE.hint} (error code: MODEL_UNAVAILABLE, ref: ${String(ref)})`,
    );
    const failureLog = logFor(outage.sessionId, STAGE_FAILURE_LOG_MESSAGE);
    expect(failureLog.level).toBe('warn');
    expect(failureLog.fields['ref']).toBe(ref);
    expect(failureLog.fields['code']).toBe('MODEL_UNAVAILABLE');
    expect(failureLog.fields['stage']).toBe(GENERATE_PANEL_STAGE);
    expect(failureLog.fields['hintSource']).toBe('code');
    for (const client of [outage.editor, outage.devtools]) {
      expect(
        progressRows(client, outage.sessionId).some(
          (row) =>
            isPanelFailure(row) && row.message === failedRow.message && row.detail === detail,
        ),
      ).toBe(true);
    }
  });

  it("keeps the provider's private hint off both surfaces and the default-level log, under a debug diagnostic", () => {
    // Every surface: the persisted rows and record, and every frame the editor
    // and the DevTools panel received for the session.
    const presented = haystackOf(...presentedArtifacts(outage));
    const updates = haystackOf(
      ...[outage.editor, outage.devtools].flatMap((client) =>
        sessionUpdates(client, outage.sessionId).map(({ message }) => message.payload),
      ),
    );
    for (const fragment of [PROVIDER_OUTAGE_HINT, ...PROVIDER_OUTAGE_HINT_FRAGMENTS]) {
      expect(presented, `a presented artifact carries ${fragment}`).not.toContain(fragment);
      expect(updates, `a session.updated frame carries ${fragment}`).not.toContain(fragment);
    }
    expect(
      progressRows(outage.devtools, outage.sessionId).some(isLine(GENERATE_PANEL_STAGE, 'failed')),
    ).toBe(true);

    // The warn record is written at the default level: neither its fields nor
    // its error carry the hint, and its line quotes none of it.
    const failureLog = logFor(outage.sessionId, STAGE_FAILURE_LOG_MESSAGE);
    expect(errorFieldOf(failureLog)['hint']).toBeUndefined();
    for (const fragment of PROVIDER_OUTAGE_HINT_FRAGMENTS) {
      expect(failureLog.line).not.toContain(fragment);
    }

    // No record of the session, at any level, carries the hint outside its error field.
    const sessionRecords = harness.logger.records.filter(
      (record) => record.fields['sessionId'] === outage.sessionId,
    );
    expect(sessionRecords.length).toBeGreaterThan(0);
    for (const record of sessionRecords) {
      const outside = JSON.stringify(outsideErrorField(record.fields));
      for (const fragment of PROVIDER_OUTAGE_HINT_FRAGMENTS) {
        expect(outside, `the "${record.message}" record carries ${fragment}`).not.toContain(
          fragment,
        );
      }
    }

    // The reference the row shows leads to the debug diagnostic, which holds
    // the failure's own message and hint as the serializer emits them there.
    const twin = logFor(outage.sessionId, STAGE_FAILURE_DIAGNOSTIC_MESSAGE);
    expect(twin.level).toBe('debug');
    expect(twin.fields).toMatchObject({
      ref: failureLog.fields['ref'],
      code: 'MODEL_UNAVAILABLE',
      stage: GENERATE_PANEL_STAGE,
    });
    const diagnostic = errorFieldOf(twin);
    expect(diagnostic).toMatchObject({ type: 'DebuggenError', code: 'MODEL_UNAVAILABLE' });
    expect(String(diagnostic['message'])).toContain('scripted panel provider is unavailable');
    expect(typeof diagnostic['hint']).toBe('string');
  });

  it('refuses every path to generated that lacks a validated panel', () => {
    const analysis = storedAnalysis(outage.sessionId);

    const withoutPanel = transition('analyzing', 'generated', { analysis });
    expect(withoutPanel.ok).toBe(false);
    if (!withoutPanel.ok) {
      expect(withoutPanel.error.details?.['reason']).toBe('artifacts-missing');
      expect(withoutPanel.error.details?.['missing']).toEqual(['panel']);
    }

    // `failed` is terminal for this capture: there is no edge to `generated`, whatever is supplied.
    expect(allowedTransitions('failed')).not.toContain('generated');
    const fromFailed = transition('failed', 'generated', {
      analysis,
      panel: defect.result.ok ? defect.result.value.panel : undefined,
    });
    expect(fromFailed.ok).toBe(false);
    if (!fromFailed.ok) {
      expect(fromFailed.error.details?.['reason']).toBe('not-permitted');
    }
  });

  it('rejects a normaliser defect without a re-prompt, logs closed fields and never its input, and falls back', () => {
    const generated = unwrap(defect.result, 'the defective generation');

    expect(generated.fallback).toBe(true);
    expect(generated.fallbackReason).toBe('normalize');
    expect(generated.attempts).toBe(1);
    expect(generated.repairs).toBe(0);
    // One provider call, one normaliser call, no repair: the defect is the product's, not the model's.
    expect(panelCalls(defect.scripted)).toHaveLength(1);
    expect(defect.scripted.remaining()).toBe(0);
    expect(defect.normaliserCalls).toBe(1);
    expect(PANEL_FAILURE_POLICY.normalize).toMatchObject({ productBug: true, repairable: false });

    const threw = logFor(defective.sessionId, LOG.normaliserThrew);
    expect(threw.level).toBe('error');
    expect(threw.fields).toMatchObject({ reason: 'normalize', attempts: 1, repairs: 0 });
    // Closed fields only: the thrown error's own code and the class the
    // validator recorded on it. Never the authoring payload the schema had
    // accepted, whose prose can echo developer source (CWE-532), and never the
    // thrown message.
    expect(threw.fields).toMatchObject({ code: 'INTERNAL', failureClass: 'normalize' });
    expect(Object.hasOwn(threw.fields, 'input')).toBe(false);
    expect(Object.hasOwn(threw.fields, 'error')).toBe(false);
    expect(logFor(defective.sessionId, LOG.productDefect).fields).toMatchObject({
      failureClass: 'normalize',
      productBug: true,
    });
    expect(logsFor(defective.sessionId, LOG.budgetSpent)).toHaveLength(0);

    const panel = single(storedPanels(defective.sessionId), 'stored panel');
    expect(panel).toEqual(generated.panel);
    expectFallbackPanel(panel, defect.analysis);
    const drawnTypes: readonly string[] = nodesOf(panel).map(({ node }) => node.type);
    expect(drawnTypes).not.toContain(UNCATALOGUED_NODE_TYPE);
  });

  it('keeps a private sentinel in the panel answer and the thrown message out of every log record, and still falls back', () => {
    // Not vacuous: each defect was handed the schema-valid private answer after
    // one provider call, and threw the sentinel — the quoting defect on the
    // cause chain of the validator's error, the echoing one in its own message.
    for (const run of [quoted, echoed]) {
      expect(panelCalls(run.scripted)).toHaveLength(1);
      expect(run.scripted.remaining()).toBe(0);
      expect(run.normaliserCalls).toBe(1);
      expect(run.thrown).toHaveLength(1);
      expect(causeMessages(run.thrown[0]).some((line) => line.includes(PRIVATE_SENTINEL))).toBe(
        true,
      );
    }
    expect(DebuggenError.is(quoted.thrown[0])).toBe(true);
    expect(causeMessages(echoed.thrown[0])[0]).toContain(PRIVATE_SENTINEL);

    // Every record the service wrote, at every level it emits (the harness runs
    // it at `debug`, its lowest), searched as the exact line pino wrote.
    expect(harness.logger.records.length).toBeGreaterThan(0);
    const leaking = harness.logger.records
      .filter((record) => record.line.includes(PRIVATE_SENTINEL))
      .map((record) => `${record.level}: ${record.message}`);
    expect(leaking).toEqual([]);

    // The two normaliser records are still written, at error, closed: the
    // validator's `DebuggenError` by its code and class, the native error as
    // `INTERNAL` with no class.
    const threw = logsFor(privately.sessionId, LOG.normaliserThrew);
    expect(threw.map((record) => record.level)).toEqual(['error', 'error']);
    for (const record of threw) {
      expect(record.fields).toMatchObject({ reason: 'normalize', attempts: 1, repairs: 0 });
      expect(record.fields['code']).toBe('INTERNAL');
      expect(Object.hasOwn(record.fields, 'input')).toBe(false);
      expect(Object.hasOwn(record.fields, 'error')).toBe(false);
    }
    expect(threw.map((record) => record.fields['failureClass'])).toEqual(['normalize', undefined]);
    expect(logsFor(privately.sessionId, LOG.productDefect)).toHaveLength(2);

    // What the developer sees is unchanged: the visible, validated fallback,
    // stored once per generation and free of the sentinel.
    const panels = storedPanels(privately.sessionId);
    expect(panels).toEqual([
      unwrap(quoted.result, 'the quoting defect').panel,
      unwrap(echoed.result, 'the echoing defect').panel,
    ]);
    for (const run of [quoted, echoed]) {
      const generated = unwrap(run.result, `the ${run === quoted ? 'quoting' : 'echoing'} defect`);
      expect(generated.fallback).toBe(true);
      expect(generated.fallbackReason).toBe('normalize');
      expect(generated.attempts).toBe(1);
      expect(generated.repairs).toBe(0);
    }
    for (const panel of panels) {
      expectFallbackPanel(panel, quoted.analysis);
      expect(haystackOf(panel)).not.toContain(PRIVATE_SENTINEL);
    }
  });

  it('admits the fallback of a normaliser defect through the generated guard', () => {
    const panel = unwrap(defect.result, 'the defective generation').panel;

    expect(panel.meta?.fallback).toBe(true);
    expect(canTransition('analyzing', 'generated', { analysis: defect.analysis, panel })).toBe(
      true,
    );
  });
});
