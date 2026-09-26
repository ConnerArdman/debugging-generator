/**
 * `POST /sessions/:id/panel-data` over the real route, the real store and the
 * real aggregates (AAP §0.8.3 `panel-data`, §0.4.2).
 *
 * `src/panels/data.test.ts` already pins the resolver's paging arithmetic
 * against fake ports. This suite proves the same contract end to end: one
 * in-process service booted through `startService`, sessions created over a
 * copied fixture project, a DevTools tab bound to each, a capture opened, and
 * every committed telemetry batch ingested through the producers that really
 * send it — browser-tier events as `telemetry.event` frames on the DevTools
 * connection, server- and database-tier events on `POST /telemetry/ingest`
 * under a project-scoped server-agent credential — so every stored row carries
 * a real `sessionId`, `captureId` and `ingestSeq`.
 *
 * ## What is asserted, and where the expectations live
 *
 * - **Table-driven source coverage.** `test/fixtures/panel-data-cases.json`
 *   holds the expectations; the closed-vocabulary interpreter lives here. The
 *   ten `DATA_QUERY_SOURCES` must each have a case, derived from the constant.
 * - **The trace tree.** `test/fixtures/panel-data-expected-trace-tree.json`
 *   holds the canonical pre-order, the nested shape and the flagged orphan.
 * - **Paging and ordering.** A multi-page walk over the 220-event volume batch
 *   under every `DataQuerySort`, the stable `id` tie-breaker over the batch's
 *   identical-`startTime`-and-`duration` block, the clamp at
 *   `DATA_QUERY_MAX_LIMIT`, and filters narrowing `total` itself.
 * - **Structural renderability.** Every entry's permitted source answers a
 *   real, non-empty `DataResult`; every field in the entry's `requiredReads` is
 *   carried by every record the component draws; the entry's `reads` is
 *   exactly `requiredReads` then `optionalReads`, so no read escapes that
 *   per-record check unless the entry itself declares it an absent-tolerant
 *   enrichment (an orphan flag, a lineage mark, a transfer size the browser
 *   withheld); and a minimal `PanelSpec` holding the node passes
 *   `validatePanelSpec` and `validateAgainstCapture` with the store's
 *   authoritative id resolvers.
 * - **Live-response rendering.** The structural proof is necessary, not
 *   sufficient: a real answer shaped in a way the components cannot draw would
 *   still pass it. So one normalized `PanelSpec` holding every catalog node
 *   type — the three containers wrapping the thirteen views, each view's query
 *   chosen from its entry's permitted sources and a trace its real answer has
 *   something for — is mounted through the renderer's `PanelHost`, over the
 *   renderer's own `createPanelDataProvider` whose every answer is a real
 *   `POST /sessions/:id/panel-data` response, and every node must settle in its
 *   populated state (AAP §0.4.2, §0.8.3). A control mounts the same panel over
 *   an unknown trace and without a credential: each view must settle empty or
 *   in error exactly where its real answer says so, which is what shows the
 *   populated verdict is read from the document rather than assumed. The
 *   capture it reads holds the case table's fixtures — the paging corpus
 *   aside — once more under fresh event ids, because no single case capture
 *   holds every kind the views draw and a panel's queries may only be
 *   addressed to its own session. The service itself still renders nothing
 *   (AAP §0.2.2): the renderer, React and happy-dom are devDependencies, and
 *   `./render/live-panel-host.ts` is the one file that imports them — the
 *   exception `eslint.config.js` and `tsconfig.json` scope to
 *   `test/integration/render/**`. That helper installs happy-dom's DOM globals
 *   only for the duration of the mount, so the in-process service keeps Node's
 *   globals throughout. `packages/panel-renderer/src/host/registry.test.ts`
 *   and `tests/browser/panel-render.spec.ts` keep the per-component and
 *   in-browser rendering over recorded answers.
 * - **Panel-bound reads.** A panel the real pipeline generated from one
 *   capture keeps reading that capture once a newer capture of its session is
 *   open: a body naming the panel (`panelId`) is answered, for every source,
 *   exactly as the panel's own capture is; the same query without it reads the
 *   newer capture; and a panel the session does not hold is refused `409`.
 * - **Authorization and privacy**, thinly: the full access matrix belongs to
 *   `auth.test.ts` and the full redaction matrix to `telemetry-ingest.test.ts`.
 *
 * ## Two contract readings stated here once
 *
 * - The last page carries `nextOffset: null`, never an absent key: protocol's
 *   `dataPageShape` declares the field required and nullable, and the fixture
 *   README states the same rule.
 * - A `request_key` digest is part of the persisted event and of the request
 *   aggregate by design — the catalog lists it among the reads of the request
 *   views — so the privacy assertion is that the digest is opaque, never
 *   logged, and that neither the per-session key it is computed with nor the
 *   unredacted URL it is computed from ever reaches a response or a log.
 *
 * Nothing secret-shaped is written here: the one redaction probe is assembled
 * at run time by the harness's `randomSecretLike`.
 */

import { isDeepStrictEqual } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
  DATA_QUERY_SORTS,
  DATA_QUERY_SOURCES,
  DEFAULT_SPLIT_DIRECTION,
  LAYOUT_NODE_MIN_CHILDREN,
  PANEL_CHILDREN_FIELD,
  PANEL_LAYOUT_FIELD,
  PANEL_NODE_CATALOG,
  PANEL_SPEC_VERSION,
  isLayoutNodeType,
  validateAgainstCapture,
  validatePanelSpec,
} from '@debuggen/panel-schema';
import type {
  DataQuery,
  DataQueryFilter,
  DataQuerySort,
  DataQuerySource,
  EventRef,
  IdResolution,
  PanelNodeCatalogEntry,
  PanelSpec,
  SemanticValidationOutcome,
} from '@debuggen/panel-schema';
import {
  ACTING_TAB_HEADER,
  HTTP_ROUTES,
  dataResultSchema,
  panelDataRequestSchema,
} from '@debuggen/protocol';
import type { DataResult, HttpClient, PanelDataRequest } from '@debuggen/protocol';
import { ID_PREFIXES, assertNever, isErr, newEventId, newId, newTraceId } from '@debuggen/shared';
import type { CaptureId, DebuggenError, Result, SessionId } from '@debuggen/shared';
import {
  CORRELATION_ATTRIBUTE_KEYS,
  DEPENDENCY_NODE_KINDS,
  METRIC_IDS,
  ORPHAN_REASONS,
  flattenTrace,
  parseTelemetryEventIngress,
} from '@debuggen/telemetry';
import type {
  CaptureSummary,
  TelemetryEvent,
  TelemetryEventIngress,
  TraceNode,
  TraceTree,
} from '@debuggen/telemetry';

import { createAnalysisSummarizer } from '../../src/analysis/summarize.js';
import type { AnalysisSummarizer } from '../../src/analysis/summarize.js';
import {
  DEFAULT_SORT_BY_SOURCE,
  SPAN_SOURCE_KINDS,
  createPanelDataResolver,
} from '../../src/panels/data.js';
import type { PanelDataResolver, SortedDataSource } from '../../src/panels/data.js';
import { PANEL_DATA_OPERATION } from '../../src/server/routes/panel-data.js';
import type { TelemetryRepo } from '../../src/store/telemetry-repo.js';
import { createTraceCorrelator } from '../../src/telemetry/correlate.js';

import {
  HARNESS_TIMEOUTS,
  randomSecretLike,
  readFixtureJson,
  readTelemetryBatch,
  startHarness,
  waitUntil,
} from './harness.js';
import type { DevtoolsConnection, Harness } from './harness.js';
import { mountLivePanel } from './render/live-panel-host.js';
import type { LivePanelReport } from './render/live-panel-host.js';

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/** The table of cases this suite interprets. */
const CASES_FIXTURE = 'panel-data-cases.json';

/** The paging corpus: one interaction root and 219 `perf.entry` children. */
const VOLUME_FIXTURE = 'telemetry-volume-paging.json';

/** The cross-tier trace the trace-tree expectation describes. */
const CROSS_TIER_FIXTURE = 'telemetry-trace-cross-tier.json';

/** The request and query corpus, whose `url` attributes carry query strings. */
const REQUESTS_FIXTURE = 'telemetry-requests-queries.json';

/** The render and state-transition corpus. */
const RENDERS_FIXTURE = 'telemetry-renders-state.json';

/**
 * The fixture whose first interaction carries the run-time redaction probe (see
 * {@link REDACTION_PROBE_ATTRIBUTE}). The paging corpus is chosen because no
 * case reads its attributes: substituting one text attribute in the in-memory
 * copy changes no expected number.
 */
const REDACTION_PROBE_FIXTURE = VOLUME_FIXTURE;

/**
 * The interaction attribute the probe is written under: free text a page
 * supplies, which the deny-list rules must judge like any other value
 * (AAP §0.5.2).
 */
const REDACTION_PROBE_ATTRIBUTE = 'target.text';

/** The question every session is created with; the panel-data route never reads it. */
const SESSION_QUESTION = 'Why does this view take so long to settle after the click?';

/** The first DevTools tab id; each capture group binds the next one. */
const FIRST_TAB_ID = 7100;

/** The operation's session-id path parameter, read from protocol's route table. */
const SESSION_PARAM = HTTP_ROUTES[PANEL_DATA_OPERATION].params[0];

/** The closed `expect` vocabulary this file interprets, in the fixture's own order. */
const EXPECT_KEYS = Object.freeze([
  'paged',
  'total',
  'count',
  'hasNextOffset',
  'nextOffset',
  'firstId',
  'lastId',
  'orderedIds',
  'groups',
  'values',
  'nodeCount',
  'maxDepth',
  'origin',
  'nodeKinds',
  'deferTo',
] as const);

/** One key of {@link EXPECT_KEYS}. */
type ExpectKey = (typeof EXPECT_KEYS)[number];

/** The four keys of protocol's `DataPage` echo, present on paged results and absent otherwise. */
const PAGE_ECHO_KEYS = Object.freeze(['total', 'limit', 'offset', 'nextOffset'] as const);

/** The error code a body refused by the request schema carries, locally and over HTTP. */
const INVALID_BODY_CODE = 'PROTOCOL_INVALID_MESSAGE';

/** The error code the resolver answers a paging value outside its domain with. */
const PAGING_REFUSAL_CODE = 'PANEL_INVALID';

/** The HTTP status of a body the request schema refuses. */
const BAD_REQUEST_STATUS = 400;

/** The HTTP status of a principal the route refuses. */
const FORBIDDEN_STATUS = 403;

/** The shape of a `request_key`: an HMAC-SHA256 digest as 64 lowercase hex characters. */
const REQUEST_KEY_PATTERN = /^[0-9a-f]{64}$/u;

/** How long one capture group's setup may take: the pipeline to `ready` plus ingest. */
const GROUP_SETUP_TIMEOUT_MS = HARNESS_TIMEOUTS.pipeline + HARNESS_TIMEOUTS.capture;

/* -------------------------------------------------------------------------------------------------
 * Fixture shapes, checked at run time rather than cast
 * ---------------------------------------------------------------------------------------------- */

/** One row of `panel-data-cases.json`. */
interface PanelDataCase {
  readonly name: string;
  readonly ingest: readonly string[];
  readonly query: unknown;
  readonly surface?: 'resolver';
  readonly expect: Readonly<Record<string, unknown>>;
  readonly derivation: string;
}

/** `panel-data-cases.json` as a whole. */
interface PanelDataCaseFile {
  readonly description: string;
  readonly constants: {
    readonly defaultLimit: number;
    readonly maxLimit: number;
    readonly defaultOffset: number;
  };
  readonly caseFields: Readonly<Record<string, string>>;
  readonly vocabulary: Readonly<Record<string, string>>;
  readonly cases: readonly PanelDataCase[];
}

/** One node of the expected nested trace. */
interface ExpectedTraceNode {
  readonly spanId: string;
  readonly eventId: string;
  readonly kind: string;
  readonly tier: string;
  readonly depth: number;
  readonly orphaned: boolean;
  readonly orphanReason?: string;
  readonly missingParentSpanId?: string;
  readonly lineage?: unknown;
  readonly children: readonly ExpectedTraceNode[];
}

/** One expected orphan placement. */
interface ExpectedOrphan {
  readonly spanId: string;
  readonly eventId: string;
  readonly missingParentSpanId: string;
  readonly attachedTo: string;
  readonly attachedToSpanId: string;
  readonly childIndex: number;
  readonly depth: number;
  readonly orphanReason: string;
  readonly flagAttribute: string;
}

/** `panel-data-expected-trace-tree.json` as a whole. */
interface ExpectedTraceTreeFile {
  readonly description: string;
  readonly fixture: string;
  readonly traceId: string;
  readonly query: unknown;
  readonly paged: boolean;
  readonly expectedResultKeys: readonly string[];
  readonly expectedNodeCount: number;
  readonly expectedRootCount: number;
  readonly expectedRootSpanId: string;
  readonly expectedTreeAggregates: Readonly<Record<string, unknown>>;
  readonly expectedPreOrderSpanIds: readonly string[];
  readonly expectedTree: ExpectedTraceNode;
  readonly expectedOrphans: readonly ExpectedOrphan[];
}

/** Whether a value is a plain, non-array object. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a value is an array of strings. */
function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((element) => typeof element === 'string');
}

/** The problems that keep `value` from being a {@link PanelDataCase}, by field. */
function caseProblems(value: unknown, index: number): string[] {
  const at = `cases[${String(index)}]`;
  if (!isRecord(value)) {
    return [`${at} is not an object`];
  }
  const problems: string[] = [];
  if (typeof value['name'] !== 'string' || value['name'].length === 0) {
    problems.push(`${at}.name is not a non-empty string`);
  }
  if (!isStringArray(value['ingest']) || value['ingest'].length === 0) {
    problems.push(`${at}.ingest is not a non-empty list of fixture names`);
  }
  if (!isRecord(value['query'])) {
    problems.push(`${at}.query is not an object`);
  }
  if (value['surface'] !== undefined && value['surface'] !== 'resolver') {
    problems.push(`${at}.surface is neither absent nor "resolver"`);
  }
  if (!isRecord(value['expect'])) {
    problems.push(`${at}.expect is not an object`);
  }
  if (typeof value['derivation'] !== 'string' || value['derivation'].trim().length === 0) {
    problems.push(`${at}.derivation is not a non-empty sentence`);
  }
  return problems;
}

/**
 * Reads `panel-data-cases.json` through the harness (which holds it to its
 * wrapper contract) and checks every case's shape, failing with every problem
 * at once rather than the first.
 */
function loadCaseFile(): PanelDataCaseFile {
  const file = readFixtureJson<unknown>(CASES_FIXTURE);
  if (!isRecord(file)) {
    throw new Error(`${CASES_FIXTURE} is not an object.`);
  }
  const problems: string[] = [];
  const constants = file['constants'];
  if (
    !isRecord(constants) ||
    typeof constants['defaultLimit'] !== 'number' ||
    typeof constants['maxLimit'] !== 'number' ||
    typeof constants['defaultOffset'] !== 'number'
  ) {
    problems.push('constants must hold numeric defaultLimit, maxLimit and defaultOffset');
  }
  if (!isRecord(file['caseFields']) || !isRecord(file['vocabulary'])) {
    problems.push('caseFields and vocabulary must be objects');
  }
  const cases = file['cases'];
  if (!Array.isArray(cases) || cases.length === 0) {
    problems.push('cases must be a non-empty array');
  } else {
    cases.forEach((element: unknown, index) => {
      problems.push(...caseProblems(element, index));
    });
  }
  if (problems.length > 0) {
    throw new Error(`${CASES_FIXTURE} drifted from its contract:\n${problems.join('\n')}`);
  }
  return file as unknown as PanelDataCaseFile;
}

/**
 * Reads `panel-data-expected-trace-tree.json` through the harness and checks
 * the fields this suite relies on.
 */
function loadExpectedTraceTree(name: string): ExpectedTraceTreeFile {
  const file = readFixtureJson<unknown>(name);
  if (
    !isRecord(file) ||
    typeof file['traceId'] !== 'string' ||
    typeof file['expectedNodeCount'] !== 'number' ||
    typeof file['expectedRootSpanId'] !== 'string' ||
    !isStringArray(file['expectedResultKeys']) ||
    !isStringArray(file['expectedPreOrderSpanIds']) ||
    !isRecord(file['expectedTree']) ||
    !isRecord(file['expectedTreeAggregates']) ||
    !Array.isArray(file['expectedOrphans'])
  ) {
    throw new Error(`${name} drifted from the trace-tree expectation contract.`);
  }
  return file as unknown as ExpectedTraceTreeFile;
}

/* -------------------------------------------------------------------------------------------------
 * Small utilities
 * ---------------------------------------------------------------------------------------------- */

/** Unwraps a `Result`, failing with the operation's name and the error's code. */
function expectOk<T>(result: Result<T, DebuggenError>, what: string): T {
  if (isErr(result)) {
    throw new Error(`${what} failed (${result.error.code}): ${result.error.message}`);
  }
  return result.value;
}

/** One field of an opaque row, or `undefined` when the row is not an object. */
function fieldOf(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** The `id` of every row, in order; a row without a string id fails the suite. */
function idsOf(rows: readonly unknown[]): string[] {
  return rows.map((row, index) => {
    const id = fieldOf(row, 'id');
    if (typeof id !== 'string') {
      throw new Error(`Row ${String(index)} of a panel-data payload carries no string id.`);
    }
    return id;
  });
}

/** Code-unit string order — the order the store and the resolver both use for `id`. */
function compareIds(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** Whether `ids` is strictly ascending in code-unit order. */
function isAscending(ids: readonly string[]): boolean {
  return ids.every((id, index) => index === 0 || compareIds(ids[index - 1] ?? '', id) < 0);
}

/** Whether a value is a key of the closed `expect` vocabulary. */
function isExpectKey(value: string): value is ExpectKey {
  return (EXPECT_KEYS as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------------------------------
 * Result accessors
 * ---------------------------------------------------------------------------------------------- */

/** The array-valued members of the result union: exactly those that carry a page echo. */
type PagedDataResult = Extract<DataResult, { readonly nextOffset: unknown }>;

/** Whether a result is one of the array-valued members. */
function isPagedResult(result: DataResult): result is PagedDataResult {
  return 'nextOffset' in result;
}

/** A result that must be paged, or a failure naming the case. */
function pagedOf(result: DataResult, name: string): PagedDataResult {
  if (!isPagedResult(result)) {
    throw new Error(`${name}: the ${result.source} result carries no page echo.`);
  }
  return result;
}

/** The payload rows of a paged result — the array named after its source — or `undefined`. */
function rowsOf(result: DataResult): readonly unknown[] | undefined {
  switch (result.source) {
    case 'spans':
      return result.spans;
    case 'events':
      return result.events;
    case 'renders':
      return result.renders;
    case 'requests':
      return result.requests;
    case 'queries':
      return result.queries;
    case 'stateTransitions':
      return result.stateTransitions;
    case 'metrics':
      return result.metrics;
    case 'trace':
    case 'componentTree':
    case 'graph':
      return undefined;
    default:
      return assertNever(result, 'Unhandled panel data result');
  }
}

/** The payload rows of a result that must be paged. */
function requireRows(result: DataResult, name: string): readonly unknown[] {
  const rows = rowsOf(result);
  if (rows === undefined) {
    throw new Error(`${name}: the ${result.source} result carries no payload array.`);
  }
  return rows;
}

/** The flat event rows of a `spans` or `events` result. */
function eventRowsOf(result: DataResult, name: string): readonly TelemetryEvent[] {
  if (result.source === 'spans') {
    return result.spans;
  }
  if (result.source === 'events') {
    return result.events;
  }
  throw new Error(`${name}: expected a flat event source, got ${result.source}.`);
}

/** The correlated tree of a `trace` result. */
function traceOf(result: DataResult, name: string): TraceTree | null {
  if (result.source !== 'trace') {
    throw new Error(`${name}: expected a trace result, got ${result.source}.`);
  }
  return result.trace;
}

/**
 * Whether a result holds something a component would draw: rows, trace nodes,
 * component-tree nodes or graph participants.
 */
function hasContent(result: DataResult): boolean {
  switch (result.source) {
    case 'trace':
      return result.trace !== null && result.trace.nodeCount > 0;
    case 'componentTree':
      return result.componentTree !== null && result.componentTree.nodeCount > 0;
    case 'graph':
      return result.graph.nodes.length > 0;
    default:
      return (rowsOf(result) ?? []).length > 0;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Capture groups: one session, one bound tab and one open capture per distinct ingest list
 * ---------------------------------------------------------------------------------------------- */

/** One session whose single capture holds exactly the fixtures of one ingest list. */
interface CaptureGroup {
  /** The ingest list, joined: the identity of the group. */
  readonly key: string;
  /** The fixtures ingested, in order. */
  readonly fixtures: readonly string[];
  readonly sessionId: SessionId;
  readonly captureId: CaptureId;
  readonly projectRoot: string;
  readonly tabId: number;
  /** The DevTools connection the browser-tier events were relayed on, bound to the session. */
  readonly devtools: DevtoolsConnection;
  /** The server-agent credential the server- and database-tier events were posted with. */
  readonly serverAgentToken: string;
  /** Every event ingested, exactly as sent (the redaction probe included). */
  readonly events: readonly TelemetryEventIngress[];
}

/** The identity of an ingest list. */
function groupKeyOf(fixtures: readonly string[]): string {
  return JSON.stringify(fixtures);
}

/**
 * The events of an ingest list in the order they are sent, with the redaction
 * probe written into the first interaction of {@link REDACTION_PROBE_FIXTURE}
 * — an in-memory copy; the committed bytes are only read.
 */
function batchFor(fixtures: readonly string[], probe: string): TelemetryEventIngress[] {
  const events: TelemetryEventIngress[] = [];
  for (const fixture of fixtures) {
    const batch = readTelemetryBatch(fixture);
    if (fixture === REDACTION_PROBE_FIXTURE) {
      const index = batch.findIndex((event) => event.kind === 'interaction');
      const carrier = batch[index];
      if (carrier === undefined) {
        throw new Error(`${fixture} holds no interaction to carry the redaction probe.`);
      }
      batch[index] = {
        ...carrier,
        attributes: { ...carrier.attributes, [REDACTION_PROBE_ATTRIBUTE]: probe },
      };
    }
    events.push(...batch);
  }
  return events;
}

/**
 * Opens one capture group through the real producers.
 *
 * The session is created over its own copy of the fixture project (the first
 * group reuses the harness's default copy), so each project has exactly one
 * capture owner and each server-agent credential is scoped to one project. The
 * page gate is satisfied the way the Chrome service worker satisfies it — a
 * bound tab and a relayed `agent.ready` whose hook was installed before React —
 * and only then is the capture opened and the batch ingested. Every ingested
 * event must be stored: attribution drops are answered 202-style, so the store
 * count is the evidence, not the transport's acknowledgement.
 *
 * `events` defaults to the fixtures' own batch; a caller that ingests the same
 * fixtures a second time passes a re-identified copy instead, because the
 * store refuses an event id already stored under another session.
 */
async function openCaptureGroup(
  harness: Harness,
  fixtures: readonly string[],
  ordinal: number,
  probe: string,
  events: readonly TelemetryEventIngress[] = batchFor(fixtures, probe),
): Promise<CaptureGroup> {
  const project = ordinal === 0 ? harness.requireProject() : await harness.copyFixtureProject();
  const launched = expectOk(await harness.launchDevServer(project.root), 'devServer.launch');
  const session = await harness.createSession({
    projectRoot: project.root,
    question: SESSION_QUESTION,
  });
  const tabId = FIRST_TAB_ID + ordinal;
  const devtools = await harness.connectDevtools({ tabId });
  const url = launched.devServerUrl;
  const bound = await harness.bindTab(devtools.client, {
    tabId,
    url,
    origin: new URL(url).origin,
    sessionId: session.id,
  });
  if (isErr(bound)) {
    throw new Error(`session.bind was refused (${bound.error.code}): ${bound.error.message}`);
  }

  const browserEvents = events.filter((event) => event.tier === 'browser');
  const serverEvents = events.filter((event) => event.tier !== 'browser');
  const producerId = browserEvents[0]?.producerId;
  if (producerId === undefined) {
    throw new Error(`The ingest list ${fixtures.join(', ')} holds no browser event.`);
  }
  const announced = devtools.client.send('agent.ready', {
    tabId,
    documentId: newId('doc'),
    producerId,
    url,
    installedBeforeReact: true,
    reactDetected: true,
  });
  expectOk(announced.result, 'agent.ready');
  expect(await devtools.client.flush()).toBe(true);
  expect(devtools.client.errorsFor(announced.id)).toEqual([]);

  const ready = await harness.waitForSession(
    session.id,
    (record) => record.status === 'ready' || record.status === 'failed',
  );
  expect(ready.status, `session for ${fixtures.join(', ')} reached ready`).toBe('ready');
  const { captureId } = expectOk(await harness.startCapture(session.id), 'capture.start');

  const relayed = await harness.ingestFromAgent(devtools.client, browserEvents);
  expectOk(relayed.sent, 'telemetry.event');
  expect(relayed.settled).toBe(true);
  expect(relayed.errors).toEqual([]);

  const credential = harness.issueServerAgentCredential(project.root);
  if (serverEvents.length > 0) {
    const posted = expectOk(
      await harness.ingestFromServerAgent({
        token: credential.token,
        projectRoot: project.root,
        events: serverEvents,
      }),
      'POST /telemetry/ingest',
    );
    expect(posted.accepted).toBe(serverEvents.length);
  }

  await waitUntil(
    () => {
      const stored = harness.repos.telemetry.countBySession(session.id);
      return !isErr(stored) && stored.value === events.length ? stored.value : undefined;
    },
    `all ${String(events.length)} events of ${fixtures.join(', ')} are stored`,
    HARNESS_TIMEOUTS.capture,
  );

  return Object.freeze({
    key: groupKeyOf(fixtures),
    fixtures,
    sessionId: session.id,
    captureId,
    projectRoot: project.root,
    tabId,
    devtools,
    serverAgentToken: credential.token,
    events,
  });
}

/* -------------------------------------------------------------------------------------------------
 * Suite state
 * ---------------------------------------------------------------------------------------------- */

/** The cases, read and shape-checked at collection time so each one is its own test. */
const caseFile = loadCaseFile();

/** The one harness of this file. */
let harness: Harness;

/**
 * A resolver wired exactly as `src/main.ts` wires the service's own — the same
 * repositories over the same store, a trace correlator and the capture
 * summarizer — for the one case the request schema refuses over HTTP and for
 * the paging refusals only the resolver can express.
 */
let resolver: PanelDataResolver;

/** The capture-summary reader `validateAgainstCapture` is fed from, as `panels/validate.ts` is. */
let summarizer: AnalysisSummarizer;

/** The redaction probe, assembled at run time; see {@link REDACTION_PROBE_ATTRIBUTE}. */
let redactionProbe: string;

/** Every capture group, keyed by {@link groupKeyOf}, in the order the cases first name them. */
const groups = new Map<string, CaptureGroup>();

/** Every response body this suite received, serialized — the haystack of the privacy sweep. */
const observedResponses: string[] = [];

/** The capture group of an ingest list, failing when setup did not open one. */
function groupFor(fixtures: readonly string[]): CaptureGroup {
  const group = groups.get(groupKeyOf(fixtures));
  if (group === undefined) {
    throw new Error(`No capture group holds ${fixtures.join(', ')}.`);
  }
  return group;
}

/** The one capture group whose ingest list names `fixture`. */
function groupHolding(fixture: string): CaptureGroup {
  const found = [...groups.values()].filter((group) => group.fixtures.includes(fixture));
  const group = found[0];
  if (found.length !== 1 || group === undefined) {
    throw new Error(`Expected exactly one capture group holding ${fixture}.`);
  }
  return group;
}

/** The distinct ingest lists of the case table, in first-mention order. */
function distinctIngestLists(): readonly (readonly string[])[] {
  const lists = new Map<string, readonly string[]>();
  for (const testCase of caseFile.cases) {
    const key = groupKeyOf(testCase.ingest);
    if (!lists.has(key)) {
      lists.set(key, testCase.ingest);
    }
  }
  return [...lists.values()];
}

/* -------------------------------------------------------------------------------------------------
 * Issuing queries
 * ---------------------------------------------------------------------------------------------- */

/**
 * One `panel.data` request through protocol's `HttpClient` — the path built
 * from `HTTP_ROUTES`, the body validated on the way out and the response on
 * the way in — recording every successful body for the privacy sweep. The body
 * is a `DataQuery`, with the rendered panel's id when the read is bound to one.
 * A DevTools client passes the inspected tab it acts for as `tabId`, which the
 * client sends as protocol's acting-tab header.
 */
async function requestPanelData(
  client: HttpClient,
  sessionId: SessionId,
  query: PanelDataRequest,
  tabId?: number,
): Promise<Result<DataResult, DebuggenError>> {
  const answered = await client.request(PANEL_DATA_OPERATION, {
    params: { [SESSION_PARAM]: sessionId },
    body: query,
    tabId,
  });
  if (!isErr(answered)) {
    observedResponses.push(JSON.stringify(answered.value));
  }
  return answered;
}

/**
 * Holds a result to protocol's `DataResult` union with the query's source as
 * its discriminant, and to the envelope rule: a result carries the four page
 * echo keys exactly when it is one of the array-valued members.
 */
function assertResultShape(result: DataResult, source: DataQuerySource): void {
  const reparsed = dataResultSchema.safeParse(result);
  expect(reparsed.success, `the ${source} result satisfies protocol's DataResult union`).toBe(true);
  expect(result.source).toBe(source);
  const arrayValued = rowsOf(result) !== undefined;
  expect(isPagedResult(result)).toBe(arrayValued);
  for (const key of PAGE_ECHO_KEYS) {
    expect(key in result, `the ${source} result ${arrayValued ? 'carries' : 'omits'} ${key}`).toBe(
      arrayValued,
    );
  }
  if (isPagedResult(result)) {
    const returned = requireRows(result, source).length;
    const remain = returned > 0 && result.offset + returned < result.total;
    expect(result.nextOffset).toBe(remain ? result.offset + returned : null);
  }
}

/** Queries a session as the editor and returns the shape-checked result. */
async function panelData(sessionId: SessionId, query: DataQuery): Promise<DataResult> {
  const result = expectOk(
    await requestPanelData(harness.http(), sessionId, query),
    `panel.data (${query.source})`,
  );
  assertResultShape(result, query.source);
  return result;
}

/** Calls the resolver directly, recording and shape-checking what it answers. */
async function resolveDirectly(group: CaptureGroup, query: DataQuery): Promise<DataResult> {
  const result = expectOk(
    await resolver.resolve({ sessionId: group.sessionId }, query),
    `PanelDataResolver.resolve (${query.source})`,
  );
  observedResponses.push(JSON.stringify(result));
  assertResultShape(result, query.source);
  return result;
}

/** A body schema-parsed into a `DataQuery`, failing when the schema refuses it. */
function typedQuery(value: unknown, what: string): DataQuery {
  const parsed = panelDataRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${what}: the request schema refuses the query.`);
  }
  return parsed.data;
}

/**
 * The typed form of a query the request schema refuses only for its paging
 * values: the schema parses the query with those values brought in bounds —
 * proving nothing else is wrong with it — and the original values are put
 * back, which is exactly what reaches a resolver called without the schema.
 */
function outOfBoundsQuery(value: unknown, what: string): DataQuery {
  if (!isRecord(value)) {
    throw new Error(`${what}: the query is not an object.`);
  }
  const { limit, offset } = value;
  if (
    (limit !== undefined && typeof limit !== 'number') ||
    (offset !== undefined && typeof offset !== 'number')
  ) {
    throw new Error(`${what}: limit and offset must be numbers when present.`);
  }
  const bounded = typedQuery(
    {
      ...value,
      ...(limit === undefined ? {} : { limit: DATA_QUERY_DEFAULT_LIMIT }),
      ...(offset === undefined ? {} : { offset: DATA_QUERY_DEFAULT_OFFSET }),
    },
    what,
  );
  return {
    ...bounded,
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  };
}

/** Every stored event of a group's capture, walked page by page through the `events` source. */
async function storedEvents(
  group: CaptureGroup,
  filter?: DataQueryFilter,
): Promise<TelemetryEvent[]> {
  const events: TelemetryEvent[] = [];
  let offset: number | null = DATA_QUERY_DEFAULT_OFFSET;
  while (offset !== null) {
    const result = await panelData(group.sessionId, {
      source: 'events',
      sort: 'start_asc',
      limit: DATA_QUERY_MAX_LIMIT,
      offset,
      ...(filter === undefined ? {} : { filter }),
    });
    events.push(...eventRowsOf(result, 'events walk'));
    offset = pagedOf(result, 'events walk').nextOffset;
  }
  return events;
}

/* -------------------------------------------------------------------------------------------------
 * Independent derivation of the flat sources, from the fixture bytes and the documented contract
 * ---------------------------------------------------------------------------------------------- */

/** The two sources whose rows are persisted events, filtered, ordered and paged by the store. */
const FLAT_EVENT_SOURCES = Object.freeze([
  'spans',
  'events',
] as const satisfies readonly SortedDataSource[]);

/** One of {@link FLAT_EVENT_SOURCES}. */
type FlatEventSource = (typeof FLAT_EVENT_SOURCES)[number];

/** Whether a source is one of {@link FLAT_EVENT_SOURCES}. */
function isFlatEventSource(source: DataQuerySource): source is FlatEventSource {
  return (FLAT_EVENT_SOURCES as readonly DataQuerySource[]).includes(source);
}

/** What the store must answer for a flat query, computed without the service. */
interface FlatPageDerivation {
  readonly total: number;
  readonly ids: readonly string[];
  readonly nextOffset: number | null;
}

/** Whether an ingested event satisfies a filter, field by field as AAP §0.4.2 defines them. */
function matchesFilter(event: TelemetryEventIngress, filter: DataQueryFilter | undefined): boolean {
  if (filter === undefined) {
    return true;
  }
  return (
    (filter.traceId === undefined || event.traceId === filter.traceId) &&
    (filter.kinds === undefined || filter.kinds.includes(event.kind)) &&
    (filter.tier === undefined || event.tier === filter.tier) &&
    (filter.minDuration === undefined || event.duration >= filter.minDuration) &&
    (filter.component === undefined || event.attributes['component'] === filter.component)
  );
}

/**
 * The sort a flat source is answered in: the requested one when it orders a
 * flat record list (`duration_desc`, `start_asc`), and the source's documented
 * default otherwise — `count_desc` counts groups, which a record list has none of.
 */
function appliedFlatSort(
  source: FlatEventSource,
  requested: DataQuerySort | undefined,
): DataQuerySort {
  return requested === undefined || requested === 'count_desc'
    ? DEFAULT_SORT_BY_SOURCE[source]
    : requested;
}

/** The comparator of a flat sort: its key, then `id` ascending as the stable secondary key. */
function flatComparator(
  sort: DataQuerySort,
): (left: TelemetryEventIngress, right: TelemetryEventIngress) => number {
  switch (sort) {
    case 'duration_desc':
      return (left, right) => right.duration - left.duration || compareIds(left.id, right.id);
    case 'start_asc':
      return (left, right) => left.startTime - right.startTime || compareIds(left.id, right.id);
    case 'count_desc':
      throw new Error('count_desc does not order a flat record list.');
    default:
      return assertNever(sort, 'Unhandled data query sort');
  }
}

/**
 * The page a flat query must answer: the `spans` source excludes the instant
 * kinds (`SPAN_SOURCE_KINDS`), the filter narrows before counting, the sort
 * ends in `id`, the limit defaults and clamps, and `nextOffset` advances only
 * while the page returned rows and rows remain.
 */
function deriveFlatPage(
  events: readonly TelemetryEventIngress[],
  source: FlatEventSource,
  query: DataQuery,
): FlatPageDerivation {
  const selected = events.filter(
    (event) =>
      (source === 'events' || SPAN_SOURCE_KINDS.includes(event.kind)) &&
      matchesFilter(event, query.filter),
  );
  const ordered = [...selected].sort(flatComparator(appliedFlatSort(source, query.sort)));
  const limit = Math.min(query.limit ?? DATA_QUERY_DEFAULT_LIMIT, DATA_QUERY_MAX_LIMIT);
  const offset = query.offset ?? DATA_QUERY_DEFAULT_OFFSET;
  const page = ordered.slice(offset, offset + limit);
  const following = offset + page.length;
  return {
    total: ordered.length,
    ids: page.map((event) => event.id),
    nextOffset: page.length > 0 && following < ordered.length ? following : null,
  };
}

/**
 * Holds a case's flat-source expectations to the independent derivation: a
 * wrong number in the fixture shows up here as a mismatch with the fixture's
 * own bytes, before it is ever compared with the service.
 */
function assertCaseAgreesWithDerivation(
  testCase: PanelDataCase,
  derived: FlatPageDerivation,
): void {
  const expected = testCase.expect;
  const at = (key: string): string => `${testCase.name}: expect.${key} follows from the fixture`;
  if ('total' in expected) {
    expect(expected['total'], at('total')).toBe(derived.total);
  }
  if ('count' in expected) {
    expect(expected['count'], at('count')).toBe(derived.ids.length);
  }
  if ('hasNextOffset' in expected) {
    expect(expected['hasNextOffset'], at('hasNextOffset')).toBe(derived.nextOffset !== null);
  }
  if ('nextOffset' in expected) {
    expect(expected['nextOffset'], at('nextOffset')).toBe(derived.nextOffset);
  }
  if ('firstId' in expected) {
    expect(expected['firstId'], at('firstId')).toBe(derived.ids[0]);
  }
  if ('lastId' in expected) {
    expect(expected['lastId'], at('lastId')).toBe(derived.ids.at(-1));
  }
  if ('orderedIds' in expected) {
    expect(expected['orderedIds'], at('orderedIds')).toEqual(derived.ids);
  }
}

/* -------------------------------------------------------------------------------------------------
 * The `expect` interpreter
 * ---------------------------------------------------------------------------------------------- */

/**
 * Assigns every descriptor a distinct row it matches, or answers `undefined`
 * when no such assignment exists — "each descriptor matches exactly one
 * distinct row", decided exactly rather than greedily.
 */
function assignDistinct(
  candidates: readonly (readonly number[])[],
  taken: ReadonlySet<number> = new Set(),
  index = 0,
): number[] | undefined {
  const options = candidates[index];
  if (options === undefined) {
    return [];
  }
  for (const row of options) {
    if (!taken.has(row)) {
      const rest = assignDistinct(candidates, new Set([...taken, row]), index + 1);
      if (rest !== undefined) {
        return [row, ...rest];
      }
    }
  }
  return undefined;
}

/**
 * Whether a row satisfies a partial descriptor: each key by deep equality,
 * except `occurrenceIds`, compared with the ids of the row's occurrences in
 * order.
 */
function descriptorMatches(descriptor: Readonly<Record<string, unknown>>, row: unknown): boolean {
  return Object.entries(descriptor).every(([key, expected]) => {
    if (key === 'occurrenceIds') {
      const occurrences = fieldOf(row, 'occurrences');
      return Array.isArray(occurrences) && isDeepStrictEqual(idsOf(occurrences), expected);
    }
    return isDeepStrictEqual(fieldOf(row, key), expected);
  });
}

/** `groups`: the descriptors match the rows as a set, one distinct row each. */
function assertGroups(name: string, rows: readonly unknown[], expected: unknown): void {
  if (!Array.isArray(expected) || !expected.every(isRecord)) {
    throw new Error(`${name}: expect.groups is not a list of descriptors.`);
  }
  expect(expected.length, `${name}: groups.length equals count`).toBe(rows.length);
  const candidates = expected.map((descriptor) =>
    rows.flatMap((row, index) => (descriptorMatches(descriptor, row) ? [index] : [])),
  );
  const unmatched = candidates
    .map((options, index) => (options.length === 0 ? index : -1))
    .filter((index) => index !== -1);
  expect(unmatched, `${name}: descriptors that match no row`).toEqual([]);
  expect(
    assignDistinct(candidates),
    `${name}: every descriptor matches its own distinct row`,
  ).toBeDefined();
}

/**
 * `values`: one entry per metric in response order — which must be
 * `METRIC_IDS` order — with `available` exact, `value` exact when given, and
 * no `value` key at all on an unavailable metric.
 */
function assertMetricValues(name: string, result: DataResult, expected: unknown): void {
  if (result.source !== 'metrics') {
    throw new Error(`${name}: expect.values applies to metrics only, not ${result.source}.`);
  }
  if (!Array.isArray(expected) || !expected.every(isRecord)) {
    throw new Error(`${name}: expect.values is not a list of metric entries.`);
  }
  expect(result.metrics.map((metric) => metric.id)).toEqual(expected.map((entry) => entry['id']));
  expect(result.metrics.map((metric) => metric.id)).toEqual(
    METRIC_IDS.slice(0, result.metrics.length),
  );
  expected.forEach((entry, index) => {
    const actual = result.metrics[index];
    if (actual === undefined) {
      throw new Error(`${name}: no metric at position ${String(index)}.`);
    }
    expect(actual.available, `${name}: ${actual.id}.available`).toBe(entry['available']);
    if ('value' in entry) {
      expect(actual.value, `${name}: ${actual.id}.value`).toBe(entry['value']);
    }
    if (entry['available'] === false) {
      expect('value' in actual, `${name}: an unavailable ${actual.id} publishes no value`).toBe(
        false,
      );
    }
  });
}

/** Projects a trace node onto the expectation vocabulary: optional keys only where set. */
function projectTraceNode(node: TraceNode): ExpectedTraceNode {
  return {
    spanId: node.event.spanId,
    eventId: node.event.id,
    kind: node.event.kind,
    tier: node.event.tier,
    depth: node.depth,
    orphaned: node.orphaned,
    ...(node.orphanReason === undefined ? {} : { orphanReason: node.orphanReason }),
    ...(node.missingParentSpanId === undefined
      ? {}
      : { missingParentSpanId: node.missingParentSpanId }),
    ...(node.lineage === undefined ? {} : { lineage: node.lineage }),
    children: node.children.map(projectTraceNode),
  };
}

/** A depth-first pre-order of span ids, walked here rather than by the package helper. */
function preOrderSpanIds(nodes: readonly TraceNode[]): string[] {
  return nodes.flatMap((node) => [node.event.spanId, ...preOrderSpanIds(node.children)]);
}

/**
 * The whole `trace` expectation: result keys, no page echo, root, node count,
 * the tree's own aggregates, the canonical pre-order (by the package's
 * `flattenTrace` and by an independent walk), the nested shape, and every
 * flagged orphan kept at its placement — never dropped.
 */
function assertTraceTree(name: string, result: DataResult, expected: ExpectedTraceTreeFile): void {
  expect(Object.keys(result).sort(), `${name}: result keys`).toEqual(
    [...expected.expectedResultKeys].sort(),
  );
  expect(isPagedResult(result), `${name}: paged`).toBe(expected.paged);
  const tree = traceOf(result, name);
  if (tree === null) {
    throw new Error(`${name}: the trace ${expected.traceId} resolved to no tree.`);
  }
  expect(tree.traceId).toBe(expected.traceId);
  expect(tree.nodeCount).toBe(expected.expectedNodeCount);
  expect(tree.roots).toHaveLength(expected.expectedRootCount);
  expect(tree.roots[0]?.event.spanId).toBe(expected.expectedRootSpanId);
  for (const [key, value] of Object.entries(expected.expectedTreeAggregates)) {
    expect(fieldOf(tree, key), `${name}: trace.${key}`).toEqual(value);
  }
  expect(flattenTrace(tree).map((node) => node.event.spanId)).toEqual(
    expected.expectedPreOrderSpanIds,
  );
  expect(preOrderSpanIds(tree.roots)).toEqual(expected.expectedPreOrderSpanIds);
  expect(tree.roots.map(projectTraceNode)).toEqual([expected.expectedTree]);

  for (const orphan of expected.expectedOrphans) {
    expect(orphan.attachedTo, `${name}: orphans attach to the trace root`).toBe('root');
    const root = tree.roots.find((node) => node.event.spanId === orphan.attachedToSpanId);
    const placed = root?.children[orphan.childIndex];
    if (placed === undefined) {
      throw new Error(`${name}: the orphan ${orphan.spanId} is not at its placement.`);
    }
    expect(placed.event.spanId).toBe(orphan.spanId);
    expect(placed.event.id).toBe(orphan.eventId);
    expect(placed.depth).toBe(orphan.depth);
    expect(placed.orphaned).toBe(true);
    expect(placed.orphanReason).toBe(orphan.orphanReason);
    expect(placed.missingParentSpanId).toBe(orphan.missingParentSpanId);
    expect(orphan.flagAttribute).toBe(CORRELATION_ATTRIBUTE_KEYS[0]);
    // The event still names the parent that never arrived: nothing was rewritten.
    expect(placed.event.parentSpanId).toBe(orphan.missingParentSpanId);
    expect(preOrderSpanIds(tree.roots)).not.toContain(orphan.missingParentSpanId);
  }
}

/** One `expect` key, interpreted against the result. */
function assertExpectation(
  name: string,
  key: ExpectKey,
  expected: unknown,
  result: DataResult,
): void {
  switch (key) {
    case 'paged':
      expect(isPagedResult(result), `${name}: paged`).toBe(expected);
      for (const echo of PAGE_ECHO_KEYS) {
        expect(echo in result, `${name}: page echo ${echo}`).toBe(expected === true);
      }
      return;
    case 'total':
      expect(pagedOf(result, name).total, `${name}: total`).toBe(expected);
      return;
    case 'count':
      expect(requireRows(result, name), `${name}: count`).toHaveLength(Number(expected));
      return;
    case 'hasNextOffset': {
      const next = pagedOf(result, name).nextOffset;
      if (expected === true) {
        expect(Number.isInteger(next), `${name}: nextOffset is an integer`).toBe(true);
      } else {
        expect('nextOffset' in result, `${name}: nextOffset is present`).toBe(true);
        expect(next, `${name}: nextOffset is null on the last page`).toBeNull();
      }
      return;
    }
    case 'nextOffset':
      expect(pagedOf(result, name).nextOffset, `${name}: nextOffset`).toBe(expected);
      return;
    case 'firstId':
      expect(idsOf(requireRows(result, name))[0], `${name}: firstId`).toBe(expected);
      return;
    case 'lastId':
      expect(idsOf(requireRows(result, name)).at(-1), `${name}: lastId`).toBe(expected);
      return;
    case 'orderedIds':
      expect(idsOf(requireRows(result, name)), `${name}: orderedIds`).toEqual(expected);
      return;
    case 'groups':
      assertGroups(name, requireRows(result, name), expected);
      return;
    case 'values':
      assertMetricValues(name, result, expected);
      return;
    case 'nodeCount':
      if (result.source === 'componentTree') {
        expect(result.componentTree?.nodeCount, `${name}: nodeCount`).toBe(expected);
      } else if (result.source === 'graph') {
        expect(result.graph.nodes, `${name}: nodeCount`).toHaveLength(Number(expected));
      } else {
        throw new Error(`${name}: nodeCount applies to componentTree and graph only.`);
      }
      return;
    case 'maxDepth':
      if (result.source !== 'componentTree') {
        throw new Error(`${name}: maxDepth applies to componentTree only.`);
      }
      expect(result.componentTree?.maxDepth, `${name}: maxDepth`).toBe(expected);
      return;
    case 'origin':
      if (result.source !== 'componentTree') {
        throw new Error(`${name}: origin applies to componentTree only.`);
      }
      expect(result.componentTree?.origin, `${name}: origin`).toBe(expected);
      return;
    case 'nodeKinds': {
      if (result.source !== 'graph') {
        throw new Error(`${name}: nodeKinds applies to graph only.`);
      }
      const present = new Set<string>(result.graph.nodes.map((node) => node.kind));
      expect(
        [...present].every((kind) => (DEPENDENCY_NODE_KINDS as readonly string[]).includes(kind)),
        `${name}: every node kind is in the dependency vocabulary`,
      ).toBe(true);
      expect(
        DEPENDENCY_NODE_KINDS.filter((kind) => present.has(kind)),
        `${name}: nodeKinds`,
      ).toEqual(expected);
      return;
    }
    case 'deferTo':
      if (typeof expected !== 'string') {
        throw new Error(`${name}: deferTo must name a fixture.`);
      }
      assertTraceTree(name, result, loadExpectedTraceTree(expected));
      return;
    default:
      assertNever(key, 'Unhandled expect key');
  }
}

/** Every `expect` key of a case, each through {@link assertExpectation}. */
function assertCaseExpectations(testCase: PanelDataCase, result: DataResult): void {
  for (const [key, expected] of Object.entries(testCase.expect)) {
    if (!isExpectKey(key)) {
      throw new Error(`${testCase.name}: expect.${key} is outside the closed vocabulary.`);
    }
    assertExpectation(testCase.name, key, expected, result);
  }
}

/**
 * Runs one case: the query over HTTP — or, for a `surface: "resolver"` case,
 * the observed `400` over HTTP followed by the resolver itself — then the
 * independent derivation for a flat source, then the case's own expectations.
 */
async function runCase(testCase: PanelDataCase): Promise<void> {
  const group = groupFor(testCase.ingest);
  let query: DataQuery;
  let result: DataResult;

  if (testCase.surface === 'resolver') {
    expect(panelDataRequestSchema.safeParse(testCase.query).success).toBe(false);
    query = outOfBoundsQuery(testCase.query, testCase.name);
    const refused = await harness.rawFetch(
      { operation: PANEL_DATA_OPERATION, params: { [SESSION_PARAM]: group.sessionId } },
      { body: testCase.query },
    );
    expect(refused.status, `${testCase.name}: refused over HTTP`).toBe(BAD_REQUEST_STATUS);
    expect(fieldOf(refused.json, 'code')).toBe(INVALID_BODY_CODE);
    const local = await requestPanelData(harness.http(), group.sessionId, query);
    expect(isErr(local) ? local.error.code : 'accepted').toBe(INVALID_BODY_CODE);
    result = await resolveDirectly(group, query);
    expect(pagedOf(result, testCase.name).limit, `${testCase.name}: the limit is clamped`).toBe(
      DATA_QUERY_MAX_LIMIT,
    );
  } else {
    query = typedQuery(testCase.query, testCase.name);
    result = await panelData(group.sessionId, query);
  }

  if (isFlatEventSource(query.source)) {
    const derived = deriveFlatPage(group.events, query.source, query);
    assertCaseAgreesWithDerivation(testCase, derived);
    expect(idsOf(eventRowsOf(result, testCase.name))).toEqual(derived.ids);
    expect(pagedOf(result, testCase.name).total).toBe(derived.total);
    expect(pagedOf(result, testCase.name).nextOffset).toBe(derived.nextOffset);
  }
  assertCaseExpectations(testCase, result);
}

/* -------------------------------------------------------------------------------------------------
 * Lifecycle
 * ---------------------------------------------------------------------------------------------- */

beforeAll(
  async () => {
    harness = await startHarness();
    const logger = harness.logger.root;
    const correlator = createTraceCorrelator({ telemetry: harness.repos.telemetry, logger });
    summarizer = createAnalysisSummarizer({
      telemetry: harness.repos.telemetry,
      sessions: harness.repos.sessions,
      panels: harness.repos.panels,
      correlator,
      logger,
    });
    resolver = createPanelDataResolver({
      telemetry: harness.repos.telemetry,
      correlator,
      sessions: harness.repos.sessions,
      captures: summarizer,
      logger,
    });
    redactionProbe = randomSecretLike('jwt');
    for (const [ordinal, fixtures] of distinctIngestLists().entries()) {
      const group = await openCaptureGroup(harness, fixtures, ordinal, redactionProbe);
      groups.set(group.key, group);
    }
  },
  HARNESS_TIMEOUTS.boot + distinctIngestLists().length * GROUP_SETUP_TIMEOUT_MS,
);

afterAll(async () => {
  // `harness` is unset only when `startHarness` itself threw, and it releases
  // everything it acquired before rethrowing.
  await harness?.assertNoLeaks();
}, HARNESS_TIMEOUTS.teardown + HARNESS_TIMEOUTS.socketClose);

/* -------------------------------------------------------------------------------------------------
 * The case table, its constants and the stored corpus
 * ---------------------------------------------------------------------------------------------- */

describe('the case table', () => {
  it('mirrors the paging constants of @debuggen/panel-schema exactly', () => {
    expect(caseFile.constants).toEqual({
      defaultLimit: DATA_QUERY_DEFAULT_LIMIT,
      maxLimit: DATA_QUERY_MAX_LIMIT,
      defaultOffset: DATA_QUERY_DEFAULT_OFFSET,
    });
  });

  it('closes its vocabulary over exactly the keys this suite interprets', () => {
    expect(Object.keys(caseFile.vocabulary)).toEqual([...EXPECT_KEYS]);
    const caseFields = Object.keys(caseFile.caseFields);
    for (const testCase of caseFile.cases) {
      for (const field of Object.keys(testCase)) {
        expect(caseFields, `${testCase.name}: case field ${field}`).toContain(field);
      }
      for (const key of Object.keys(testCase.expect)) {
        expect(isExpectKey(key), `${testCase.name}: expect.${key} is in the vocabulary`).toBe(true);
      }
    }
    const names = caseFile.cases.map((testCase) => testCase.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('has a case for every DATA_QUERY_SOURCES member and names only declared sorts', () => {
    const covered = new Set<unknown>(
      caseFile.cases.map((testCase) => fieldOf(testCase.query, 'source')),
    );
    const missing = DATA_QUERY_SOURCES.filter((source) => !covered.has(source));
    expect(missing, 'sources without a case').toEqual([]);
    expect(
      [...covered].filter((source) => !(DATA_QUERY_SOURCES as readonly unknown[]).includes(source)),
    ).toEqual([]);
    for (const testCase of caseFile.cases) {
      const sort = fieldOf(testCase.query, 'sort');
      if (sort !== undefined) {
        expect(DATA_QUERY_SORTS as readonly unknown[], `${testCase.name}: sort`).toContain(sort);
      }
    }
  });

  it('keeps any two ingest lists either identical or disjoint', () => {
    const lists = distinctIngestLists();
    lists.forEach((left, index) => {
      for (const right of lists.slice(index + 1)) {
        expect(left.filter((fixture) => right.includes(fixture))).toEqual([]);
      }
    });
  });

  it('holds every HTTP query to the request schema and refuses exactly the resolver-surface ones', () => {
    for (const testCase of caseFile.cases) {
      expect(
        panelDataRequestSchema.safeParse(testCase.query).success,
        `${testCase.name}: accepted by panelDataRequestSchema`,
      ).toBe(testCase.surface !== 'resolver');
    }
  });

  it('stores every ingested event once, under its capture, with service-assigned identity', async () => {
    for (const group of groups.values()) {
      const stored = await storedEvents(group);
      expect(stored.map((event) => event.id).sort()).toEqual(
        group.events.map((event) => event.id).sort(),
      );
      for (const event of stored) {
        expect(event.sessionId).toBe(group.sessionId);
        expect(event.captureId).toBe(group.captureId);
        expect(Number.isSafeInteger(event.ingestSeq)).toBe(true);
      }
      expect(new Set(stored.map((event) => event.ingestSeq)).size).toBe(stored.length);
    }
  });
});

describe('table-driven source coverage', () => {
  it.each(caseFile.cases.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    async (_name, testCase) => {
      await runCase(testCase);
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * Envelopes, metrics and empty results
 * ---------------------------------------------------------------------------------------------- */

/** The single-value sources AAP §0.4.2 serves without a page: a tree, a snapshot, a graph. */
const OBJECT_VALUED_SOURCES: readonly DataQuerySource[] = Object.freeze([
  'trace',
  'componentTree',
  'graph',
]);

describe('result envelopes', () => {
  it('pages exactly the array-valued sources, in every capture', async () => {
    const unpaged = new Set<DataQuerySource>();
    for (const group of groups.values()) {
      for (const source of DATA_QUERY_SOURCES) {
        const result = await panelData(group.sessionId, { source });
        if (!isPagedResult(result)) {
          unpaged.add(source);
          for (const key of PAGE_ECHO_KEYS) {
            expect(key in result, `${source} carries no ${key}`).toBe(false);
          }
        } else {
          expect(Number.isInteger(result.total)).toBe(true);
          expect('nextOffset' in result).toBe(true);
        }
      }
    }
    expect([...unpaged].sort()).toEqual([...OBJECT_VALUED_SOURCES].sort());
  });

  it('answers metrics as one value per METRIC_IDS member, in order, available only when measured', async () => {
    const availability = new Set<boolean>();
    for (const group of groups.values()) {
      const result = await panelData(group.sessionId, { source: 'metrics' });
      if (result.source !== 'metrics') {
        throw new Error('a metrics query answered another source');
      }
      expect(result.metrics.map((metric) => metric.id)).toEqual([...METRIC_IDS]);
      expect(result.total).toBe(METRIC_IDS.length);
      for (const metric of result.metrics) {
        expect('value' in metric, `${metric.id}: a value exactly when available`).toBe(
          metric.available,
        );
      }
      // AAP §0.6.6: bytes are measurable only where some record reported a transfer size.
      const measured = group.events.some(
        (event) => typeof event.attributes['transferSize'] === 'number',
      );
      const transferred = result.metrics.find((metric) => metric.id === 'transferred_bytes');
      expect(transferred?.available, `transferred_bytes for ${group.key}`).toBe(measured);
      availability.add(measured);
    }
    expect([...availability].sort()).toEqual([false, true]);
  });

  it.each([...DATA_QUERY_SOURCES])(
    '%s answers a query that matches nothing with a successful empty result',
    async (source) => {
      const unknownTrace = newTraceId();
      for (const group of groups.values()) {
        const result = await panelData(group.sessionId, {
          source,
          filter: { traceId: unknownTrace },
        });
        if (result.source === 'metrics') {
          // A fixed vocabulary: every id is still answered, none measured from nothing.
          expect(result.metrics.map((metric) => metric.id)).toEqual([...METRIC_IDS]);
          continue;
        }
        expect(hasContent(result), `${source} over an unknown trace is empty`).toBe(false);
        if (isPagedResult(result)) {
          expect(result.total).toBe(0);
          expect(result.nextOffset).toBeNull();
        }
      }
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * The correlated trace
 * ---------------------------------------------------------------------------------------------- */

/** The expected trace of the cross-tier batch. */
const EXPECTED_TRACE_FIXTURE = 'panel-data-expected-trace-tree.json';

/**
 * The nesting one click must resolve to (AAP §0.8.3): the interaction, the
 * request it issued, the server request, its route handler, the service
 * function and the query that function ran.
 */
const CROSS_TIER_CHAIN = Object.freeze([
  'interaction',
  'fetch',
  'http.server',
  'route.handler',
  'function',
  'db.query',
] as const);

describe('the correlated trace', () => {
  it('resolves the cross-tier capture to the expected canonical tree', async () => {
    const expected = loadExpectedTraceTree(EXPECTED_TRACE_FIXTURE);
    expect(expected.fixture).toBe(CROSS_TIER_FIXTURE);
    const group = groupHolding(CROSS_TIER_FIXTURE);
    const result = await panelData(
      group.sessionId,
      typedQuery(expected.query, EXPECTED_TRACE_FIXTURE),
    );
    assertTraceTree(EXPECTED_TRACE_FIXTURE, result, expected);

    const tree = traceOf(result, EXPECTED_TRACE_FIXTURE);
    const ingested = group.events.filter((event) => event.traceId === expected.traceId);
    expect(tree?.nodeCount, 'no event of the trace is dropped').toBe(ingested.length);
  });

  it('nests interaction ⊃ fetch ⊃ http.server ⊃ route.handler ⊃ function ⊃ db.query, with the continuation render under the settled fetch', async () => {
    const expected = loadExpectedTraceTree(EXPECTED_TRACE_FIXTURE);
    const group = groupHolding(CROSS_TIER_FIXTURE);
    const tree = traceOf(
      await panelData(group.sessionId, typedQuery(expected.query, EXPECTED_TRACE_FIXTURE)),
      EXPECTED_TRACE_FIXTURE,
    );
    const [rootKind, ...descendantKinds] = CROSS_TIER_CHAIN;
    let node = tree?.roots[0];
    expect(node?.event.kind).toBe(rootKind);
    const chain: TraceNode[] = [];
    for (const kind of descendantKinds) {
      node = node?.children.find((child) => child.event.kind === kind);
      if (node === undefined) {
        throw new Error(`The chain breaks before a ${kind} span.`);
      }
      expect(node.event.parentSpanId).toBe(
        chain.at(-1)?.event.spanId ?? tree?.roots[0]?.event.spanId,
      );
      chain.push(node);
    }
    const settledFetch = chain[0];
    const render = settledFetch?.children.find((child) => child.event.kind === 'render');
    expect(render?.lineage?.value).toBe('async-continuation');
    expect(render?.event.parentSpanId).toBe(settledFetch?.event.spanId);
  });

  it('keeps the event whose parent never arrived, flagged, under the trace root', async () => {
    const expected = loadExpectedTraceTree(EXPECTED_TRACE_FIXTURE);
    const group = groupHolding(CROSS_TIER_FIXTURE);
    const batch = readTelemetryBatch(CROSS_TIER_FIXTURE);
    const spanIds = new Set(batch.map((event) => event.spanId));
    const orphans = batch.filter(
      (event) => event.parentSpanId !== undefined && !spanIds.has(event.parentSpanId),
    );
    expect(orphans.map((event) => event.id)).toEqual(
      expected.expectedOrphans.map((orphan) => orphan.eventId),
    );
    const tree = traceOf(
      await panelData(group.sessionId, typedQuery(expected.query, EXPECTED_TRACE_FIXTURE)),
      EXPECTED_TRACE_FIXTURE,
    );
    const root = tree?.roots[0];
    for (const orphan of orphans) {
      const placed = root?.children.find((child) => child.event.id === orphan.id);
      expect(placed, `${orphan.id} is attached to the root, not dropped`).toBeDefined();
      expect(placed?.orphaned).toBe(true);
      expect(ORPHAN_REASONS as readonly unknown[]).toContain(placed?.orphanReason);
      expect(placed?.missingParentSpanId).toBe(orphan.parentSpanId);
      expect(placed?.depth).toBe(1);
    }
    expect(tree?.orphanCount).toBe(orphans.length);
  });

  it('answers an unknown trace id with an empty result, not an error', async () => {
    const group = groupHolding(CROSS_TIER_FIXTURE);
    const answered = await requestPanelData(harness.http(), group.sessionId, {
      source: 'trace',
      filter: { traceId: newTraceId() },
    });
    const result = expectOk(answered, 'panel.data (trace, unknown trace id)');
    assertResultShape(result, 'trace');
    const tree = traceOf(result, 'unknown trace');
    expect(tree === null || tree.nodeCount === 0).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Paging and ordering over the volume batch
 * ---------------------------------------------------------------------------------------------- */

/** The rows of a full walk, and the pages it took. */
interface PageWalk {
  readonly pages: readonly PagedDataResult[];
  readonly ids: readonly string[];
}

/**
 * Follows `nextOffset` from the first page until it is `null`, asserting on
 * every page that it advances by exactly the rows it returned. Bounded by the
 * page count the first page's `total` implies, so a pager that never ends
 * fails instead of spinning.
 */
async function walkPages(sessionId: SessionId, base: DataQuery): Promise<PageWalk> {
  const pages: PagedDataResult[] = [];
  const ids: string[] = [];
  let offset: number | null = DATA_QUERY_DEFAULT_OFFSET;
  let bound = Number.POSITIVE_INFINITY;
  while (offset !== null) {
    if (pages.length > bound) {
      throw new Error('The page walk did not terminate within the pages its total implies.');
    }
    const page = pagedOf(await panelData(sessionId, { ...base, offset }), 'page walk');
    const rows = requireRows(page, 'page walk');
    expect(page.offset).toBe(offset);
    if (page.nextOffset !== null) {
      expect(page.nextOffset).toBe(offset + rows.length);
    }
    bound = Math.ceil(page.total / Math.max(page.limit, 1)) + 1;
    pages.push(page);
    ids.push(...idsOf(rows));
    offset = page.nextOffset;
  }
  return { pages, ids };
}

/**
 * The events of the paging batch that share both `startTime` and `duration`
 * with another: the block only the stable `id` key can order.
 */
function tieBlockOf(events: readonly TelemetryEventIngress[]): readonly string[] {
  const byKey = new Map<string, string[]>();
  for (const event of events) {
    const key = `${String(event.startTime)}|${String(event.duration)}`;
    byKey.set(key, [...(byKey.get(key) ?? []), event.id]);
  }
  const blocks = [...byKey.values()].filter((ids) => ids.length > 1);
  const block = blocks[0];
  if (blocks.length !== 1 || block === undefined) {
    throw new Error(
      `Expected exactly one identical-start-and-duration block, found ${String(blocks.length)}.`,
    );
  }
  return block;
}

/** Every (flat source, sort) pair, so each permitted sort is walked on both flat sources. */
const WALKS = FLAT_EVENT_SOURCES.flatMap((source) =>
  DATA_QUERY_SORTS.map((sort) => [source, sort] as const),
);

/** Paging values the request schema refuses and the resolver answers `PANEL_INVALID`. */
const INVALID_PAGING = Object.freeze([
  ['a negative limit', { limit: -1 }],
  ['a fractional limit', { limit: DATA_QUERY_DEFAULT_LIMIT / 3 }],
  ['a negative offset', { offset: -1 }],
  ['a fractional offset', { offset: 0.5 }],
] as const);

describe('paging and ordering', () => {
  it('pages a batch larger than one default page, holding one identical-start-and-duration block', () => {
    const group = groupHolding(VOLUME_FIXTURE);
    expect(group.events.length).toBeGreaterThan(DATA_QUERY_DEFAULT_LIMIT);
    expect(group.events.length).toBeLessThan(DATA_QUERY_DEFAULT_LIMIT * 2);
    const block = tieBlockOf(group.events);
    expect(block.length).toBeGreaterThan(1);
    expect(isAscending(block), 'the block is written in id order').toBe(true);
  });

  it.each(WALKS)('walks every %s row exactly once under %s', async (source, sort) => {
    const group = groupHolding(VOLUME_FIXTURE);
    const everything = group.events.map((event) => event.id);
    const walk = await walkPages(group.sessionId, { source, sort });

    // Two pages: a full default page that points at the second, and a short last one.
    expect(walk.pages).toHaveLength(2);
    const [first, last] = walk.pages;
    if (first === undefined || last === undefined) {
      throw new Error('The walk returned fewer than two pages.');
    }
    expect(first.total).toBe(everything.length);
    expect(first.limit).toBe(DATA_QUERY_DEFAULT_LIMIT);
    expect(requireRows(first, 'first page')).toHaveLength(DATA_QUERY_DEFAULT_LIMIT);
    expect(first.nextOffset).toBe(DATA_QUERY_DEFAULT_LIMIT);
    expect(last.total).toBe(everything.length);
    expect(requireRows(last, 'last page')).toHaveLength(
      everything.length - DATA_QUERY_DEFAULT_LIMIT,
    );
    expect('nextOffset' in last).toBe(true);
    expect(last.nextOffset).toBeNull();

    // No row duplicated, none skipped.
    expect(new Set(walk.ids).size).toBe(walk.ids.length);
    expect([...walk.ids].sort()).toEqual([...everything].sort());

    // The order is the documented chain, ending in id — derived without the service.
    const derived = deriveFlatPage(group.events, source, {
      source,
      sort,
      limit: everything.length,
    });
    expect(walk.ids).toEqual(derived.ids);

    // Inside the tie block only the secondary key discriminates: contiguous, id ascending.
    const block = tieBlockOf(group.events);
    const positions = block.map((id) => walk.ids.indexOf(id));
    const firstPosition = Math.min(...positions);
    expect(walk.ids.slice(firstPosition, firstPosition + block.length)).toEqual(
      [...block].sort(compareIds),
    );

    // Deterministic: an identical walk answers identically.
    const again = await walkPages(group.sessionId, { source, sort });
    expect(again.ids).toEqual(walk.ids);
  });

  it('refuses a limit above DATA_QUERY_MAX_LIMIT at the body schema and clamps it in the resolver', async () => {
    const group = groupHolding(VOLUME_FIXTURE);
    const raw = { source: 'events', sort: 'start_asc', limit: DATA_QUERY_MAX_LIMIT + 1 };
    expect(panelDataRequestSchema.safeParse(raw).success).toBe(false);

    const refused = await harness.rawFetch(
      { operation: PANEL_DATA_OPERATION, params: { [SESSION_PARAM]: group.sessionId } },
      { body: raw },
    );
    expect(refused.status).toBe(BAD_REQUEST_STATUS);
    expect(fieldOf(refused.json, 'code')).toBe(INVALID_BODY_CODE);

    const clamped = pagedOf(
      await resolveDirectly(group, outOfBoundsQuery(raw, 'over-limit query')),
      'over-limit query',
    );
    expect(clamped.limit).toBe(DATA_QUERY_MAX_LIMIT);
    expect(clamped.total).toBe(group.events.length);
    expect(requireRows(clamped, 'over-limit query')).toHaveLength(group.events.length);
    expect(clamped.nextOffset).toBeNull();
  });

  it('answers an offset past the total with an empty last page that still reports the total', async () => {
    const group = groupHolding(VOLUME_FIXTURE);
    for (const source of FLAT_EVENT_SOURCES) {
      const beyond = group.events.length + DATA_QUERY_DEFAULT_LIMIT;
      const page = pagedOf(await panelData(group.sessionId, { source, offset: beyond }), source);
      expect(requireRows(page, source)).toEqual([]);
      expect(page.offset).toBe(beyond);
      expect(page.total).toBe(deriveFlatPage(group.events, source, { source }).total);
      expect(page.nextOffset).toBeNull();
    }
  });

  it.each(INVALID_PAGING)('refuses %s as a typed validation failure', async (_label, paging) => {
    const group = groupHolding(VOLUME_FIXTURE);
    const raw = { source: 'events', ...paging };
    expect(panelDataRequestSchema.safeParse(raw).success).toBe(false);
    const query = outOfBoundsQuery(raw, 'invalid paging');

    // Protocol's client refuses it before sending: no status, the schema's code.
    const local = await requestPanelData(harness.http(), group.sessionId, query);
    expect(isErr(local) ? local.error.code : 'sent').toBe(INVALID_BODY_CODE);
    expect(isErr(local) ? fieldOf(local.error.details, 'status') : 'sent').toBeUndefined();

    // The service refuses it at its body schema.
    const refused = await harness.rawFetch(
      { operation: PANEL_DATA_OPERATION, params: { [SESSION_PARAM]: group.sessionId } },
      { body: raw },
    );
    expect(refused.status).toBe(BAD_REQUEST_STATUS);
    expect(fieldOf(refused.json, 'code')).toBe(INVALID_BODY_CODE);

    // A caller that bypasses the schema meets the resolver's own typed refusal.
    const direct = await resolver.resolve({ sessionId: group.sessionId }, query);
    expect(isErr(direct) ? direct.error.code : 'resolved').toBe(PAGING_REFUSAL_CODE);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Filters are pushed into the read: they narrow `total`, not merely the page
 * ---------------------------------------------------------------------------------------------- */

/** The first event of a batch satisfying `predicate`, failing when the batch holds none. */
function firstEventWhere(
  fixture: string,
  predicate: (event: TelemetryEventIngress) => boolean,
): TelemetryEventIngress {
  const found = readTelemetryBatch(fixture).find(predicate);
  if (found === undefined) {
    throw new Error(`${fixture} holds no event the filter probe needs.`);
  }
  return found;
}

/**
 * One probe per `DataQueryFilter` field, each built from the bytes of the
 * fixture it runs against so that no filter value is a free-standing literal
 * the fixture could drift away from.
 */
const FILTER_PROBES = Object.freeze([
  [
    'traceId',
    CROSS_TIER_FIXTURE,
    (): DataQueryFilter => ({ traceId: firstEventWhere(CROSS_TIER_FIXTURE, () => true).traceId }),
  ],
  [
    'kinds',
    CROSS_TIER_FIXTURE,
    (): DataQueryFilter => ({
      kinds: [firstEventWhere(CROSS_TIER_FIXTURE, (event) => event.tier === 'db').kind],
    }),
  ],
  ['tier', CROSS_TIER_FIXTURE, (): DataQueryFilter => ({ tier: 'server' })],
  [
    'minDuration',
    CROSS_TIER_FIXTURE,
    (): DataQueryFilter => ({
      minDuration: firstEventWhere(CROSS_TIER_FIXTURE, (event) => event.tier === 'server').duration,
    }),
  ],
  [
    'component',
    RENDERS_FIXTURE,
    (): DataQueryFilter => {
      const component = firstEventWhere(
        RENDERS_FIXTURE,
        (event) => typeof event.attributes['component'] === 'string',
      ).attributes['component'];
      if (typeof component !== 'string') {
        throw new Error(`${RENDERS_FIXTURE} names no component.`);
      }
      return { component };
    },
  ],
] as const);

describe('filters narrow the total itself', () => {
  it.each(FILTER_PROBES)('a %s filter over %s', async (_field, fixture, build) => {
    const group = groupHolding(fixture);
    const filter = build();
    for (const source of FLAT_EVENT_SOURCES) {
      const unfiltered = deriveFlatPage(group.events, source, { source }).total;
      const expected = deriveFlatPage(group.events, source, {
        source,
        sort: 'start_asc',
        filter,
        limit: 1,
      });
      expect(expected.total, `${source}: the probe selects something`).toBeGreaterThan(0);
      expect(expected.total, `${source}: the probe excludes something`).toBeLessThan(unfiltered);

      const page = pagedOf(
        await panelData(group.sessionId, { source, sort: 'start_asc', filter, limit: 1 }),
        source,
      );
      // A one-row page whose total is the whole filtered set: the filter ran in the read.
      expect(page.total, `${source}: total counts the filtered set`).toBe(expected.total);
      expect(idsOf(requireRows(page, source))).toEqual(expected.ids);
      expect(page.nextOffset).toBe(expected.nextOffset);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Structural renderability: the panel-renderer substitute
 * ---------------------------------------------------------------------------------------------- */

/** Every catalog entry, derived from the constant rather than listed. */
const CATALOG_ENTRIES: readonly PanelNodeCatalogEntry[] = Object.freeze(
  Object.values(PANEL_NODE_CATALOG),
);

/** Every (query-backed entry, permitted source) pair. */
const READ_PAIRS = CATALOG_ENTRIES.flatMap((entry) =>
  entry.sources.map((source) => [entry.type, source, entry] as const),
);

/** The containers: they arrange nodes and read nothing. */
const LAYOUT_ENTRIES = CATALOG_ENTRIES.filter((entry) => entry.kind === 'layout');

/**
 * Whether a record carries a field the catalog names: an event field with a
 * value, or an attribute whose value is neither absent, `null` nor empty text —
 * the predicate the aggregates apply before forming a row from a record.
 */
function carries(record: TelemetryEvent, key: string): boolean {
  const own = fieldOf(record, key);
  if (own !== undefined && own !== null) {
    return true;
  }
  const attribute = record.attributes[key];
  return attribute !== undefined && attribute !== null && attribute !== '';
}

/**
 * Whether a record is one of the entry's subjects. An empty `telemetryKinds`
 * means the node is indifferent to kind (catalog.ts), so every record is.
 */
function isSubjectOf(entry: PanelNodeCatalogEntry, record: { readonly kind: string }): boolean {
  return (
    entry.telemetryKinds.length === 0 ||
    (entry.telemetryKinds as readonly string[]).includes(record.kind)
  );
}

/**
 * The records a node's component draws for a result.
 *
 * A flat source's rows and a trace's nodes are those records directly, narrowed
 * to the entry's subject kinds (a waterfall draws the request, server and
 * database spans of a span list, not its paint entries). An aggregate declares,
 * by the catalog's own rule, the fields of the records it is computed from
 * rather than its own property names, so for an aggregate the records are the
 * capture's events of the entry's subject kinds — read through the real
 * `events` source, not from the fixture.
 */
async function drawnRecords(
  entry: PanelNodeCatalogEntry,
  group: CaptureGroup,
  result: DataResult,
): Promise<readonly TelemetryEvent[]> {
  switch (result.source) {
    case 'spans':
    case 'events':
      return eventRowsOf(result, entry.type).filter((record) => isSubjectOf(entry, record));
    case 'trace': {
      const tree = traceOf(result, entry.type);
      return tree === null
        ? []
        : flattenTrace(tree)
            .map((node) => node.event)
            .filter((record) => isSubjectOf(entry, record));
    }
    default:
      return storedEvents(
        group,
        entry.telemetryKinds.length > 0 ? { kinds: [...entry.telemetryKinds] } : undefined,
      );
  }
}

/**
 * The first capture group that holds a record of the entry's subject kinds and
 * whose answer to `{ source }` holds something to draw.
 */
async function groupWithContent(
  entry: PanelNodeCatalogEntry,
  source: DataQuerySource,
): Promise<{ readonly group: CaptureGroup; readonly result: DataResult } | undefined> {
  for (const group of groups.values()) {
    if (group.events.some((event) => isSubjectOf(entry, event))) {
      const result = await panelData(group.sessionId, { source });
      if (hasContent(result)) {
        return { group, result };
      }
    }
  }
  return undefined;
}

/** A value for one of a catalog entry's own option fields, taken from the capture. */
function optionValue(option: string, evidence: TelemetryEvent): unknown {
  switch (option) {
    case 'metrics':
      return [...METRIC_IDS];
    case 'location':
      return evidence.source;
    case 'direction':
      return DEFAULT_SPLIT_DIRECTION;
    default:
      throw new Error(`No value is known for the catalog option ${option}; extend this suite.`);
  }
}

/** A source location a captured event resolved to, for the source-link leaf. */
async function capturedLocation(): Promise<TelemetryEvent> {
  for (const group of groups.values()) {
    const located = (await storedEvents(group)).find((event) => event.source !== undefined);
    if (located !== undefined) {
      return located;
    }
  }
  throw new Error('No stored event resolved to a source location.');
}

/** A leaf node that reads nothing: a source link to where the evidence resolved. */
function sourceLinkNode(id: string, evidence: TelemetryEvent): Record<string, unknown> {
  return { type: 'sourceLink', id, location: optionValue('location', evidence) };
}

/**
 * The smallest specification that holds `node`: one observed fact citing
 * `citedEventId` (by default the evidence record itself), no likely cause.
 */
function minimalSpec(
  group: CaptureGroup,
  title: string,
  node: Record<string, unknown>,
  evidence: TelemetryEvent,
  citedEventId: string = evidence.id,
): unknown {
  return panelDocument(group, title, [node], evidence, citedEventId);
}

/**
 * A specification document holding `layout` as given, with the summary
 * {@link minimalSpec} uses: one observed fact citing `citedEventId` (by default
 * the evidence record itself), no likely cause.
 */
function panelDocument(
  group: CaptureGroup,
  title: string,
  layout: readonly Record<string, unknown>[],
  evidence: TelemetryEvent,
  citedEventId: string = evidence.id,
): unknown {
  const reference: EventRef = {
    eventId: citedEventId,
    traceId: evidence.traceId,
    spanId: evidence.spanId,
    kind: evidence.kind,
  };
  return {
    version: PANEL_SPEC_VERSION,
    id: newId(ID_PREFIXES.panel),
    sessionId: group.sessionId,
    panelVersion: 1,
    title,
    summary: {
      observed: [
        {
          statement: `The capture holds the ${evidence.kind} record this view draws.`,
          evidence: [reference],
        },
      ],
      likelyCauses: [],
    },
    layout,
  };
}

/** The store's authoritative id resolvers for one capture, as `panels/validate.ts` supplies them. */
function resolversFor(
  repo: TelemetryRepo,
  group: CaptureGroup,
): {
  readonly resolveEventIds: (ids: readonly string[]) => IdResolution;
  readonly resolveTraceIds: (ids: readonly string[]) => IdResolution;
} {
  return {
    resolveEventIds: (ids) =>
      expectOk(
        repo.partitionKnownEventIds(group.sessionId, ids, group.captureId),
        'partitionKnownEventIds',
      ),
    resolveTraceIds: (ids) =>
      expectOk(
        repo.partitionKnownTraceIds(group.sessionId, ids, group.captureId),
        'partitionKnownTraceIds',
      ),
  };
}

/** A semantic outcome in one line, for an assertion message. */
function describeOutcome(outcome: SemanticValidationOutcome): string {
  switch (outcome.status) {
    case 'valid':
      return 'valid';
    case 'unverifiable':
      return `unverifiable: ${JSON.stringify(outcome.unverifiable)}`;
    case 'invalid':
      return `invalid: ${JSON.stringify(outcome.issues)}`;
    default:
      return assertNever(outcome, 'Unhandled semantic outcome');
  }
}

/**
 * Validates a specification syntactically and against the capture with the
 * store's resolvers and `requireVerifiable`, so the verdict is decided rather
 * than `unverifiable`; then proves the resolvers were consulted by citing an
 * id the store never held, which must be refuted.
 */
async function assertSpecValidates(
  group: CaptureGroup,
  build: (citedEventId?: string) => unknown,
  what: string,
): Promise<void> {
  const summary: CaptureSummary = expectOk(
    await summarizer.loadCaptureSummary(group.sessionId, group.captureId),
    'loadCaptureSummary',
  );
  const options = { ...resolversFor(harness.repos.telemetry, group), requireVerifiable: true };
  const spec: PanelSpec = expectOk(validatePanelSpec(build()), `validatePanelSpec (${what})`);
  const outcome = validateAgainstCapture(spec, summary, options);
  expect(outcome.status, `${what}: ${describeOutcome(outcome)}`).toBe('valid');

  const fabricated: PanelSpec = expectOk(
    validatePanelSpec(build(newEventId())),
    `validatePanelSpec (${what}, fabricated evidence)`,
  );
  expect(validateAgainstCapture(fabricated, summary, options).status).toBe('invalid');
}

describe('structural renderability of every catalog entry', () => {
  it('reads at least one source exactly where a query is required, and nothing elsewhere', () => {
    for (const entry of CATALOG_ENTRIES) {
      expect(entry.requiresQuery, `${entry.type}: requiresQuery`).toBe(entry.sources.length > 0);
      if (!entry.requiresQuery) {
        expect(entry.reads, `${entry.type} reads no telemetry`).toEqual([]);
      }
      // `reads` is exactly the required reads then the optional enrichments,
      // deduplicated in that order: no read escapes the per-record check below
      // except one the entry itself declares optional.
      const partition = [...new Set([...entry.requiredReads, ...entry.optionalReads])];
      expect(entry.reads, `${entry.type}: reads = requiredReads ∪ optionalReads`).toEqual(
        partition,
      );
    }
    const readNothing = CATALOG_ENTRIES.filter(
      (entry) => entry.kind !== 'layout' && entry.sources.length === 0,
    ).map((entry) => entry.type);
    // The documented exception: the source-link leaf carries a location, not a query.
    expect(readNothing).toEqual(['sourceLink']);
    expect(READ_PAIRS.length).toBeGreaterThan(0);
  });

  it.each(READ_PAIRS)(
    '%s reading %s draws from a real result and validates against the capture',
    async (type, source, entry) => {
      const found = await groupWithContent(entry, source);
      if (found === undefined) {
        throw new Error(`No real ${source} result has anything for a ${type} node to draw.`);
      }
      const { group, result } = found;
      const records = await drawnRecords(entry, group, result);
      expect(records.length, `${type}: records to draw`).toBeGreaterThan(0);

      const missing = records.flatMap((record) =>
        entry.requiredReads
          .filter((read) => !carries(record, read))
          .map((read) => `${record.id} lacks ${read}`),
      );
      expect(missing, `${type}: every drawn record carries every required read`).toEqual([]);

      const evidence = records[0];
      if (evidence === undefined) {
        throw new Error(`${type}: no evidence record.`);
      }
      const node: Record<string, unknown> = {
        type,
        id: 'layout.0',
        title: entry.label,
        query: { source, filter: { traceId: evidence.traceId } },
      };
      for (const option of entry.options ?? []) {
        node[option] = optionValue(option, evidence);
      }
      await assertSpecValidates(
        group,
        (cited) => minimalSpec(group, entry.label, node, evidence, cited),
        `${type} over ${source}`,
      );
    },
  );

  it('accepts the source-link leaf with a captured location and refuses it a query', async () => {
    const entry = PANEL_NODE_CATALOG.sourceLink;
    expect(entry.requiresQuery).toBe(false);
    expect(entry.sources).toEqual([]);
    expect(entry.options).toContain('location');

    const evidence = await capturedLocation();
    const group = [...groups.values()].find(
      (candidate) => candidate.sessionId === evidence.sessionId,
    );
    if (group === undefined) {
      throw new Error('The located event belongs to no capture group.');
    }
    const leaf = sourceLinkNode('layout.0', evidence);
    await assertSpecValidates(
      group,
      (cited) => minimalSpec(group, entry.label, leaf, evidence, cited),
      'sourceLink',
    );
    const queried = minimalSpec(
      group,
      entry.label,
      { ...leaf, query: { source: 'events' } },
      evidence,
    );
    expect(isErr(validatePanelSpec(queried)), 'a source link carrying a query is refused').toBe(
      true,
    );
  });

  it.each(LAYOUT_ENTRIES.map((entry) => [entry.type, entry] as const))(
    'accepts the %s container holding its minimum of leaves',
    async (type, entry) => {
      expect(entry.sources).toEqual([]);
      const evidence = await capturedLocation();
      const group = [...groups.values()].find(
        (candidate) => candidate.sessionId === evidence.sessionId,
      );
      if (group === undefined) {
        throw new Error('The located event belongs to no capture group.');
      }
      if (!isLayoutNodeType(type)) {
        throw new Error(`${type} is catalogued as a container but is not a layout node type.`);
      }
      const children = Array.from({ length: LAYOUT_NODE_MIN_CHILDREN[type] }, (_, index) =>
        sourceLinkNode(`layout.0.children.${String(index)}`, evidence),
      );
      const container: Record<string, unknown> = {
        type,
        id: 'layout.0',
        title: entry.label,
        children,
      };
      for (const option of entry.options ?? []) {
        container[option] = optionValue(option, evidence);
      }
      await assertSpecValidates(
        group,
        (cited) => minimalSpec(group, entry.label, container, evidence, cited),
        type,
      );
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * Live-response rendering: every catalog component mounted against real answers
 * ---------------------------------------------------------------------------------------------- */

/** The title of the one panel the live-response oracle mounts. */
const ORACLE_PANEL_TITLE = 'Every catalog view over one real capture';

/** Every catalog entry that draws a view — the source-link leaf included — in catalog order. */
const VIEW_ENTRIES = CATALOG_ENTRIES.filter((entry) => entry.kind !== 'layout');

/**
 * The bound of each oracle test: up to two mounts, each given one request
 * budget to settle in, and one teardown budget for unmounting and closing them.
 */
const ORACLE_TEST_TIMEOUT_MS = HARNESS_TIMEOUTS.request * 2 + HARNESS_TIMEOUTS.teardown;

/**
 * The fixtures the oracle capture holds: every fixture the case table ingests
 * except the paging corpus, whose 219 `perf.entry` rows give no view anything
 * the other fixtures do not and would only multiply the rows the mount lays out.
 */
function oracleFixtures(): readonly string[] {
  return distinctIngestLists()
    .flat()
    .filter((fixture) => fixture !== VOLUME_FIXTURE);
}

/**
 * A copy of `events` under fresh event ids, held to the ingress schema again.
 *
 * The event id is the one identity the store keeps unique across sessions
 * (`telemetry_events.id`), so it is the one re-minted: trace, span and producer
 * ids keep their values, which the store and the correlator only ever read
 * within one session. Every other string equal to an original id — a state
 * transition's `triggerEventId`, say — is rewritten to the same fresh id, so the
 * copy references itself exactly as the original does.
 */
function reidentified(events: readonly TelemetryEventIngress[]): TelemetryEventIngress[] {
  const fresh = new Map<string, string>(events.map((event) => [event.id, newEventId()]));
  const remap = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return fresh.get(value) ?? value;
    }
    if (Array.isArray(value)) {
      return value.map((element: unknown) => remap(element));
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [key, remap(nested)] as const),
      );
    }
    return value;
  };
  return events.map((event, index) => {
    const copy = parseTelemetryEventIngress(remap(event));
    if (isErr(copy)) {
      throw new Error(
        `Re-identified event ${String(index)} left the ingress schema (${copy.error.code}).`,
      );
    }
    return copy.value;
  });
}

/** The sources a node of this entry may read, its catalogued default first. */
function sourcesInPreference(entry: PanelNodeCatalogEntry): readonly DataQuerySource[] {
  return [
    ...new Set([
      ...(entry.defaultSource === undefined ? [] : [entry.defaultSource]),
      ...entry.sources,
    ]),
  ];
}

/** The trace ids of a group's events, in the order they were ingested. */
function traceIdsOf(group: CaptureGroup): readonly string[] {
  return [...new Set(group.events.map((event) => event.traceId))];
}

/**
 * The query a node of `entry` is mounted with: the first permitted source and
 * trace, in preference order, whose real answer holds something the entry's
 * component draws — the rule the structural block proves every pair by.
 */
async function drawableQuery(
  entry: PanelNodeCatalogEntry,
  group: CaptureGroup,
): Promise<DataQuery> {
  for (const source of sourcesInPreference(entry)) {
    for (const traceId of traceIdsOf(group)) {
      const query = typedQuery({ source, filter: { traceId } }, `${entry.type} over ${source}`);
      const result = await panelData(group.sessionId, query);
      if (hasContent(result) && (await drawnRecords(entry, group, result)).length > 0) {
        return query;
      }
    }
  }
  throw new Error(`No real answer of the oracle capture has anything for a ${entry.type} node.`);
}

/**
 * The oracle's layout: one node per catalog entry. The containers, in catalog
 * order, are the top-level nodes and the views are dealt among them in turn,
 * so every view sits inside a container — as a generated panel's views do —
 * and every container holds at least its minimum of children. Ids follow the
 * normaliser's positional scheme (`layout.0`, `layout.0.children.1`), which is
 * also the path the renderer writes onto each node's frame.
 */
async function oracleLayout(
  group: CaptureGroup,
  located: TelemetryEvent,
): Promise<Record<string, unknown>[]> {
  const shares = LAYOUT_ENTRIES.map((): PanelNodeCatalogEntry[] => []);
  VIEW_ENTRIES.forEach((entry, index) => {
    shares[index % shares.length]?.push(entry);
  });
  const layout: Record<string, unknown>[] = [];
  for (const [position, container] of LAYOUT_ENTRIES.entries()) {
    const { type } = container;
    if (!isLayoutNodeType(type)) {
      throw new Error(`${type} is catalogued as a container but is not a layout node type.`);
    }
    const share = shares[position] ?? [];
    if (share.length < LAYOUT_NODE_MIN_CHILDREN[type]) {
      throw new Error(`The ${type} container is dealt fewer views than its minimum.`);
    }
    const id = `${PANEL_LAYOUT_FIELD}.${String(position)}`;
    const children: Record<string, unknown>[] = [];
    for (const [index, entry] of share.entries()) {
      const leaf: Record<string, unknown> = {
        type: entry.type,
        id: `${id}.${PANEL_CHILDREN_FIELD}.${String(index)}`,
        title: entry.label,
      };
      if (entry.requiresQuery) {
        leaf['query'] = await drawableQuery(entry, group);
      }
      for (const option of entry.options ?? []) {
        leaf[option] = optionValue(option, located);
      }
      children.push(leaf);
    }
    const node: Record<string, unknown> = { type, id, title: container.label, children };
    for (const option of container.options ?? []) {
      node[option] = optionValue(option, located);
    }
    layout.push(node);
  }
  return layout;
}

/**
 * Every successful answer a mount recorded for `query` — same source, same
 * filter — in the order the requests settled.
 */
function answersFor(report: LivePanelReport, query: DataQuery): DataResult[] {
  return report.exchanges.flatMap((exchange) =>
    exchange.outcome.ok &&
    exchange.query.source === query.source &&
    isDeepStrictEqual(exchange.query.filter, query.filter)
      ? [exchange.outcome.result]
      : [],
  );
}

/** Adds every successful answer a mount recorded to the privacy sweep's haystack. */
function recordAnswers(report: LivePanelReport): void {
  for (const exchange of report.exchanges) {
    if (exchange.outcome.ok) {
      observedResponses.push(JSON.stringify(exchange.outcome.result));
    }
  }
}

/** A copy of `nodes` whose every query is narrowed to `traceId` instead. */
function retraced(
  nodes: readonly Readonly<Record<string, unknown>>[],
  traceId: string,
): Record<string, unknown>[] {
  return nodes.map((node) => {
    const { query, children } = node;
    return {
      ...node,
      ...(isRecord(query) ? { query: { ...query, filter: { traceId } } } : {}),
      ...(Array.isArray(children)
        ? { children: retraced(children.filter(isRecord), traceId) }
        : {}),
    };
  });
}

describe('live-response rendering of every catalog component', () => {
  /** The capture the oracle reads: the case fixtures again, under fresh event ids, in one session. */
  let oracle: CaptureGroup;

  /** A stored event of the oracle capture that resolved to a source location. */
  let located: TelemetryEvent;

  /** The layout of every catalog node type, each view's query chosen over HTTP. */
  let layout: Record<string, unknown>[];

  beforeAll(async () => {
    const fixtures = oracleFixtures();
    oracle = await openCaptureGroup(
      harness,
      fixtures,
      distinctIngestLists().length,
      redactionProbe,
      reidentified(batchFor(fixtures, redactionProbe)),
    );
    const found = (await storedEvents(oracle)).find((event) => event.source !== undefined);
    if (found === undefined) {
      throw new Error('No event of the oracle capture resolved to a source location.');
    }
    located = found;
    layout = await oracleLayout(oracle, located);
  }, GROUP_SETUP_TIMEOUT_MS + HARNESS_TIMEOUTS.request);

  it(
    'mounts one normalized PanelSpec holding every catalog node type through PanelHost, each view settled in its populated state over a real /panel-data answer',
    async () => {
      const build = (cited?: string): unknown =>
        panelDocument(oracle, ORACLE_PANEL_TITLE, layout, located, cited);
      await assertSpecValidates(oracle, build, 'the live-response oracle panel');
      const spec = expectOk(validatePanelSpec(build()), 'validatePanelSpec (live-response oracle)');
      const catalogTypes = new Set(CATALOG_ENTRIES.map((entry) => entry.type));

      const globalsBefore = Reflect.ownKeys(globalThis);
      const report = await mountLivePanel({
        spec,
        client: harness.http(),
        documentUrl: harness.url,
        settleTimeoutMs: HARNESS_TIMEOUTS.request,
      });
      recordAnswers(report);

      // The DOM existed for the mount only: every global it installed is gone.
      expect(report.installedGlobals).toBeGreaterThan(0);
      expect(Reflect.ownKeys(globalThis), 'globals left behind by the mount').toEqual(
        globalsBefore,
      );

      // One node per catalog type, every one of them drawn in its populated state:
      // no loading, empty or error state, no registry miss, no missing frame.
      expect(report.settled, 'the panel settled within its bound').toBe(true);
      expect(report.nodes.map((node) => node.id)).toEqual(report.nodes.map((node) => node.path));
      expect(report.nodes).toHaveLength(catalogTypes.size);
      expect(new Set(report.nodes.map((node) => node.type))).toEqual(catalogTypes);
      expect(
        report.nodes
          .filter((node) => node.state !== 'populated')
          .map((node) => `${node.id} (${node.type}): ${node.state}`),
        'nodes that did not render their populated state',
      ).toEqual([]);
      const rendered = new Set(
        report.nodes.filter((node) => node.state === 'populated').map((node) => node.type),
      );
      expect(rendered, 'the node types rendered').toEqual(catalogTypes);
      for (const node of report.nodes) {
        expect(node.renderedChildCount, `${node.id}: child frames rendered`).toBe(node.childCount);
      }

      // Exactly the query-backed entries carried a query, and each one's view was
      // drawn from a real answer: addressed to the panel's own session, accepted by
      // protocol's DataResult union with the node's source, and holding content.
      expect(
        report.nodes.filter((node) => node.query !== undefined).map((node) => node.type),
      ).toEqual(
        report.nodes
          .filter((node) => PANEL_NODE_CATALOG[node.type].requiresQuery)
          .map((node) => node.type),
      );
      expect(
        report.exchanges
          .filter((exchange) => !exchange.outcome.ok || exchange.sessionId !== spec.sessionId)
          .map((exchange) => exchange.query.source),
        'requests refused or addressed to another session',
      ).toEqual([]);
      for (const node of report.nodes) {
        const { query } = node;
        if (query === undefined) {
          continue;
        }
        const answers = answersFor(report, query);
        expect(answers.length, `${node.id}: real answers to its query`).toBeGreaterThan(0);
        for (const answer of answers) {
          expect(
            dataResultSchema.safeParse(answer).success,
            `${node.id}: the answer satisfies DataResult`,
          ).toBe(true);
          expect(answer.source, `${node.id}: the answer's source`).toBe(query.source);
          expect(hasContent(answer), `${node.id}: the answer holds content`).toBe(true);
        }
      }
      expect(report.interactions, 'interactions reported while nothing was clicked').toBe(0);
    },
    ORACLE_TEST_TIMEOUT_MS,
  );

  it(
    'tells the populated state from the empty and error states: over an unknown trace a view settles empty exactly where its real answer holds nothing, and a refused request settles as an error',
    async () => {
      const unknownTrace = newTraceId();
      const emptied = expectOk(
        validatePanelSpec(
          panelDocument(oracle, ORACLE_PANEL_TITLE, retraced(layout, unknownTrace), located),
        ),
        'validatePanelSpec (live-response control, unknown trace)',
      );
      const overNothing = await mountLivePanel({
        spec: emptied,
        client: harness.http(),
        documentUrl: harness.url,
        settleTimeoutMs: HARNESS_TIMEOUTS.request,
      });
      recordAnswers(overNothing);
      expect(overNothing.settled, 'the control panel settled within its bound').toBe(true);
      for (const node of overNothing.nodes) {
        const { query } = node;
        if (query === undefined) {
          expect(node.state, `${node.id}: a node without a query is unaffected`).toBe('populated');
          continue;
        }
        const answers = answersFor(overNothing, query);
        expect(answers.length, `${node.id}: real answers to its query`).toBeGreaterThan(0);
        expect(node.state, `${node.id} (${node.type}): the state follows its answer`).toBe(
          answers.some(hasContent) ? 'populated' : 'empty',
        );
      }
      expect(
        overNothing.nodes.filter((node) => node.state === 'empty').length,
        'views the unknown trace emptied',
      ).toBeGreaterThan(0);

      const spec = expectOk(
        validatePanelSpec(panelDocument(oracle, ORACLE_PANEL_TITLE, layout, located)),
        'validatePanelSpec (live-response control, refused)',
      );
      const refused = await mountLivePanel({
        spec,
        client: harness.http(null),
        documentUrl: harness.url,
        settleTimeoutMs: HARNESS_TIMEOUTS.request,
      });
      expect(refused.settled, 'the refused panel settled within its bound').toBe(true);
      expect(refused.exchanges.length).toBeGreaterThan(0);
      expect(
        refused.exchanges
          .filter((exchange) => exchange.outcome.ok)
          .map((exchange) => exchange.query.source),
        'requests answered without a credential',
      ).toEqual([]);
      for (const node of refused.nodes) {
        expect(node.state, `${node.id} (${node.type}): the state follows the refusal`).toBe(
          node.query === undefined ? 'populated' : 'error',
        );
      }
    },
    ORACLE_TEST_TIMEOUT_MS,
  );
});

/* -------------------------------------------------------------------------------------------------
 * Authorization — one assertion per role; the full matrix belongs to auth.test.ts
 * ---------------------------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------------------------------
 * Panel-bound reads — a rendered panel keeps reading the capture it was generated from
 * ---------------------------------------------------------------------------------------------- */

/** The status a request answers with when its scope contradicts the session's state. */
const CONFLICT_STATUS = 409;

/** The code of that answer. */
const INVALID_STATE_CODE = 'SESSION_INVALID_STATE';

describe('panel-bound reads', () => {
  /** The session whose first capture the real pipeline generated a panel from. */
  let group: CaptureGroup;

  /** The capture the panel was generated from, and the newer one opened after it. */
  let panelCapture: CaptureId;
  let newerCapture: CaptureId;

  /** The generated panel, as the store holds it. */
  let panelId: string;

  beforeAll(
    async () => {
      // Capture one, through the real producers, then the real pipeline:
      // stopping it analyses the capture and stores a panel linked to it.
      group = await openCaptureGroup(
        harness,
        [CROSS_TIER_FIXTURE],
        distinctIngestLists().length + 1,
        redactionProbe,
        reidentified(batchFor([CROSS_TIER_FIXTURE], redactionProbe)),
      );
      panelCapture = group.captureId;
      expectOk(await harness.stopCapture(group.sessionId), 'capture.stop');
      const generated = await harness.waitForSession(
        group.sessionId,
        (record) => record.status === 'generated' || record.status === 'failed',
        { timeoutMs: HARNESS_TIMEOUTS.pipeline },
      );
      expect(generated.status, 'the first capture generated a panel').toBe('generated');
      const panel = expectOk(
        harness.repos.panels.getLatestPanel(group.sessionId),
        'getLatestPanel',
      );
      if (panel === undefined) {
        throw new Error('The pipeline stored no panel for the first capture.');
      }
      panelId = panel.id;

      // Capture two: a newer capture of the same session holding other evidence,
      // opened and filled at the store — what every resolver lookup reads.
      const opened = expectOk(
        harness.repos.sessions.startCapture({
          sessionId: group.sessionId,
          planVersion: generated.plans.at(-1)?.planVersion ?? 1,
        }),
        'sessions.startCapture',
      );
      newerCapture = opened.capture.id;
      const evidence = reidentified(readTelemetryBatch(RENDERS_FIXTURE)).map((event) => ({
        ...event,
        sessionId: group.sessionId,
        captureId: newerCapture,
      }));
      expectOk(harness.repos.telemetry.insertMany(evidence), 'telemetry.insertMany');
    },
    GROUP_SETUP_TIMEOUT_MS + HARNESS_TIMEOUTS.pipeline + HARNESS_TIMEOUTS.request,
  );

  it('stores the panel linked to the capture it was generated from', () => {
    const lookup = expectOk(
      harness.repos.sessions.getPanelCapture(group.sessionId, panelId),
      'getPanelCapture',
    );
    expect(lookup.panel).toBe('found');
    expect(lookup.panel === 'found' ? lookup.capture?.capture.id : undefined).toBe(panelCapture);
    expect(
      expectOk(harness.repos.sessions.getActiveCapture(group.sessionId), 'getActiveCapture')
        ?.capture.id,
    ).toBe(newerCapture);
  });

  it('answers every source of a panel-bound read from the panel’s capture while a newer one is open', async () => {
    for (const source of DATA_QUERY_SOURCES) {
      const query: DataQuery = { source, limit: DATA_QUERY_MAX_LIMIT };
      const bound = expectOk(
        await requestPanelData(harness.http(), group.sessionId, { ...query, panelId }),
        `panel.data (${source}, panel-bound)`,
      );
      assertResultShape(bound, source);
      const own = expectOk(
        await resolver.resolve({ sessionId: group.sessionId, captureId: panelCapture }, query),
        `resolve (${source}, the panel's capture)`,
      );
      expect(bound, `${source} is read from the panel's capture`).toStrictEqual(own);
    }
  });

  it('keeps live reads separate: without a panel id the newer capture is read', async () => {
    const query: DataQuery = { source: 'renders', limit: DATA_QUERY_MAX_LIMIT };
    const live = await panelData(group.sessionId, query);
    const bound = expectOk(
      await requestPanelData(harness.http(), group.sessionId, { ...query, panelId }),
      'panel.data (renders, panel-bound)',
    );
    const newer = expectOk(
      await resolver.resolve({ sessionId: group.sessionId, captureId: newerCapture }, query),
      'resolve (renders, the newer capture)',
    );
    const older = expectOk(
      await resolver.resolve({ sessionId: group.sessionId, captureId: panelCapture }, query),
      "resolve (renders, the panel's capture)",
    );
    expect(live).toStrictEqual(newer);
    expect(bound).toStrictEqual(older);
    expect(newer).not.toStrictEqual(older);
  });

  it('refuses a panel the session does not hold with 409, reading nothing on its behalf', async () => {
    const [other] = [...groups.values()];
    if (other === undefined) {
      throw new Error('A second session is needed.');
    }
    const query: PanelDataRequest = { source: 'renders' };
    for (const [sessionId, foreignPanel] of [
      // A panel of this session, asked about under another session.
      [other.sessionId, panelId],
      // A panel id no session holds.
      [group.sessionId, newId('pnl')],
    ] as const) {
      const refused = await requestPanelData(harness.http(), sessionId, {
        ...query,
        panelId: foreignPanel,
      });
      expect(refusalStatus(refused)).toBe(CONFLICT_STATUS);
      expect(isErr(refused) ? refused.error.code : 'answered').toBe(INVALID_STATE_CODE);
    }
  });
});

/** The service's code for a DevTools principal acting on a session its tab is not bound to. */
const TAB_NOT_BOUND_CODE = 'TAB_NOT_BOUND';

/** The service's code for a principal whose role may not use a session route. */
const UNAUTHORIZED_CODE = 'UNAUTHORIZED';

/** The status a refusal carries in its details. */
function refusalStatus(result: Result<DataResult, DebuggenError>): unknown {
  return isErr(result) ? fieldOf(result.error.details, 'status') : 'answered';
}

describe('authorization', () => {
  it('lets a DevTools principal read only the session its own tab is bound to', async () => {
    const [own, other] = [...groups.values()];
    if (own === undefined || other === undefined) {
      throw new Error('Two capture groups are needed.');
    }
    const { token, origin } = own.devtools.credential;
    const devtools = harness.http(token, { origin });
    const query = typedQuery({ source: 'events', limit: 1 }, 'devtools probe');

    const bound = pagedOf(
      expectOk(
        await requestPanelData(devtools, own.sessionId, query, own.tabId),
        'panel.data (bound tab)',
      ),
      'bound tab',
    );
    expect(bound.total).toBe(own.events.length);

    expect(refusalStatus(await requestPanelData(devtools, other.sessionId, query, own.tabId))).toBe(
      FORBIDDEN_STATUS,
    );
    const refused = await harness.rawFetch(
      { operation: PANEL_DATA_OPERATION, params: { [SESSION_PARAM]: other.sessionId } },
      { token, origin, body: query, headers: { [ACTING_TAB_HEADER]: String(own.tabId) } },
    );
    expect(refused.status).toBe(FORBIDDEN_STATUS);
    expect(fieldOf(refused.json, 'code')).toBe(TAB_NOT_BOUND_CODE);
  });

  it('refuses a server-agent principal every panel-data read', async () => {
    const [group] = [...groups.values()];
    if (group === undefined) {
      throw new Error('A capture group is needed.');
    }
    const query = typedQuery({ source: 'events', limit: 1 }, 'server-agent probe');
    const refused = await requestPanelData(
      harness.http(group.serverAgentToken),
      group.sessionId,
      query,
    );
    expect(refusalStatus(refused)).toBe(FORBIDDEN_STATUS);
    expect(isErr(refused) ? refused.error.code : 'answered').toBe(UNAUTHORIZED_CODE);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Privacy — thin: the full redaction matrix belongs to telemetry-ingest.test.ts
 * ---------------------------------------------------------------------------------------------- */

/** The response keys a `request_key` digest travels under: the event attribute and the group field. */
const REQUEST_KEY_FIELDS: ReadonlySet<string> = new Set(['request_key', 'requestKey']);

/** The attribute a database statement travels under. */
const STATEMENT_FIELDS: ReadonlySet<string> = new Set(['db.statement']);

/** Every string value found under one of `keys`, at any depth of `value`. */
function collectStrings(value: unknown, keys: ReadonlySet<string>, into: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const element of value) {
      collectStrings(element, keys, into);
    }
  } else if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (keys.has(key) && typeof nested === 'string') {
        into.add(nested);
      }
      collectStrings(nested, keys, into);
    }
  }
  return into;
}

/**
 * The literal `name=value` pairs of every query string the ingested events
 * carried before redaction — what a masked URL must never give back.
 */
function unredactedQueryPairs(events: readonly TelemetryEventIngress[]): Set<string> {
  const pairs = new Set<string>();
  for (const event of events) {
    for (const value of Object.values(event.attributes)) {
      const query = typeof value === 'string' ? value.split('?')[1] : undefined;
      for (const pair of query?.split('&') ?? []) {
        const [name, parameter] = pair.split('=');
        if (
          name !== undefined &&
          name !== '' &&
          parameter !== undefined &&
          parameter !== '' &&
          parameter !== '?'
        ) {
          pairs.add(`${name}=${parameter}`);
        }
      }
    }
  }
  return pairs;
}

describe('privacy', () => {
  it('never answers or logs an unredacted URL, the request-key secret, a raw statement or a masked value', async () => {
    // A self-sufficient sweep: every source of every capture, whatever ran before.
    for (const group of groups.values()) {
      for (const source of DATA_QUERY_SOURCES) {
        await panelData(group.sessionId, { source, limit: DATA_QUERY_MAX_LIMIT });
      }
    }
    const responses = observedResponses.join('\n');
    const logs = harness.logger.text();
    const parsed = observedResponses.map((text): unknown => JSON.parse(text));
    const ingested = [...groups.values()].flatMap((group) => group.events);

    // 1. URLs: every ingested query value is masked in every answer and every record.
    const pairs = unredactedQueryPairs(ingested);
    expect(pairs.size, 'the corpus carries query strings to mask').toBeGreaterThan(0);
    for (const pair of pairs) {
      expect(responses.includes(pair), `a response carries ${pair}`).toBe(false);
      expect(logs.includes(pair), `a log record carries ${pair}`).toBe(false);
    }

    // 2. Request keys: opaque digests the renderer may group by, never logged.
    const digests = collectStrings(parsed, REQUEST_KEY_FIELDS, new Set());
    expect(digests.size, 'the request views carry request_key digests').toBeGreaterThan(0);
    for (const digest of digests) {
      expect(digest).toMatch(REQUEST_KEY_PATTERN);
      expect(logs.includes(digest), 'a log record carries a request_key').toBe(false);
    }

    // 3. The per-session key those digests are computed with stays in the store.
    const keyed = [...groups.values()].filter((group) =>
      expectOk(harness.repos.sessions.hasRequestKeySecret(group.sessionId), 'hasRequestKeySecret'),
    );
    expect(keyed.map((group) => group.key)).toContain(groupHolding(REQUESTS_FIXTURE).key);
    for (const group of keyed) {
      const secret = expectOk(
        harness.repos.sessions.getOrCreateRequestKeySecret(group.sessionId),
        'getOrCreateRequestKeySecret',
      );
      expect(responses.includes(secret), 'a response carries the request-key secret').toBe(false);
      expect(logs.includes(secret), 'a log record carries the request-key secret').toBe(false);
    }

    // 4. SQL: only the parameterized statements that were ingested, and none in a log record.
    const ingestedStatements = collectStrings(
      ingested.map((event) => event.attributes),
      STATEMENT_FIELDS,
      new Set(),
    );
    expect(ingestedStatements.size).toBeGreaterThan(0);
    for (const statement of collectStrings(parsed, STATEMENT_FIELDS, new Set())) {
      expect(
        ingestedStatements.has(statement),
        'a response statement was rewritten or invented',
      ).toBe(true);
      expect(statement.includes("'"), 'a response statement carries a quoted literal').toBe(false);
    }
    for (const statement of ingestedStatements) {
      expect(logs.includes(statement), 'a log record carries a statement').toBe(false);
    }

    // 5. The run-time probe was masked at ingest, while the record carrying it was kept.
    const signature = redactionProbe.split('.').at(-1) ?? redactionProbe;
    for (const needle of [redactionProbe, signature]) {
      expect(responses.includes(needle), 'a response carries the redaction probe').toBe(false);
      expect(logs.includes(needle), 'a log record carries the redaction probe').toBe(false);
    }
    const carrierGroup = groupHolding(REDACTION_PROBE_FIXTURE);
    const carrier = carrierGroup.events.find(
      (event) => event.attributes[REDACTION_PROBE_ATTRIBUTE] === redactionProbe,
    );
    const stored = (await storedEvents(carrierGroup)).find((event) => event.id === carrier?.id);
    expect(stored, 'the record carrying the probe is stored').toBeDefined();
    expect(stored?.attributes[REDACTION_PROBE_ATTRIBUTE]).not.toBe(redactionProbe);
  });
});
