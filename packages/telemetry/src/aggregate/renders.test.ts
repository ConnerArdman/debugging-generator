/**
 * Tests for `./renders.ts` — the `renders` and `componentTree` panel-data
 * sources.
 *
 * ## What is on trial
 *
 * Two of the rows of the panel-data table (AAP 0.4.2) are computed by the
 * module under test, and three separate consumers read the result without
 * sharing a runtime with it: the service's panel-data route, the render-table
 * and component-tree components of the renderer, and `./summary.ts`, which
 * turns these numbers into the `render_count`, `unchanged_render_count` and
 * `render_trigger_unknown_count` metric cards that `packages/panel-schema`
 * validates a panel's `metricCards.metrics` against. A disagreement about any
 * of it is therefore never a crash — it is a plausible-looking wrong number in
 * a generated panel, which is the one failure this product cannot afford.
 *
 * Four specific failures are what the cases below exist to prevent:
 *
 * 1. **An `unknown` render counted as `unchanged`.** `unchanged` means all
 *    three dimensions were evaluated and none changed — shallow-equal props,
 *    unchanged own hook state *and* no changed consumed context value —
 *    whereas `unknown` means at least one of them could not be evaluated
 *    (`../schema/attributes.ts`, `RENDER_TRIGGERS`). "We checked and nothing
 *    changed" and "we could not check" support completely different
 *    conclusions, so the two buckets are disjoint and the malformed-input
 *    table below drives every way a trigger can fail to be readable through
 *    the classifier to prove it lands in `unknown` and never in `unchanged`.
 * 2. **A structure that is not the page's, presented as though it were.** A
 *    component tree is built from the **last commit of the capture** while the
 *    per-node numbers are cumulative over the whole capture, and `origin` and
 *    `degraded` are part of the answer rather than diagnostics. The tree cases
 *    pin the commit selection, the three construction routes and both caveat
 *    flags.
 * 3. **A value escaping with the evidence.** Only changed-prop *key names*
 *    travel (AAP 0.5.2). The privacy case feeds a credential-shaped preview
 *    through a `ChangedPropEntry` and asserts the serialized statistic carries
 *    the key name and no fragment of the preview.
 * 4. **An unstable result set.** The panel-data contract pages on `id` with a
 *    stable total order, so two pages of one query must not show the same row
 *    twice. The identity and ordering cases assert determinism under
 *    reordering of the input.
 *
 * ## Habits in here, each deliberate
 *
 * - **No literal borrowed from a schema.** Every kind, tier, status, trigger,
 *   phase, attribute key and bound is bound from the tuple that declares it
 *   (`../schema/kinds.ts`, `../schema/attributes.ts`) exactly as the module
 *   under test binds them, and the two render-group kinds are resolved the way
 *   the implementation resolves them — by asking which kind declares which key
 *   set — so a reordering upstream fails here rather than silently changing
 *   what is being tested. The histogram cases iterate the vocabularies, so a
 *   member added upstream is covered without an edit to this file.
 * - **Fixtures are valid persisted events.** The builders return
 *   {@link TelemetryEvent} literals and the first suite runs them through
 *   `isTelemetryEvent`, so a fixture can never pass this file while being
 *   something the store would reject.
 * - **Identity is explicit, never ambient.** Each builder takes an ordinal, so
 *   no module-level counter can make one test's ids depend on whether another
 *   ran. That is what makes the ordering and tie-break assertions meaningful.
 * - **Generic vocabulary only.** Every component name here is invented
 *   (`ComponentA`, `ListRow`, `PanelBody`, `ParentView`, …):
 *   `scripts/check-no-hardcoding.mjs` keeps knowledge of the demo application
 *   out of `packages/**` (AAP 0.5.4), and a fixture is no place to start
 *   leaking it.
 * - **Credential-shaped fixtures are assembled at run time** from fragments,
 *   because this tracked file is itself scanned by
 *   `scripts/check-secrets.mjs` (AAP 0.3.4).
 *
 * ## The two committed corpora
 *
 * The inline builders above state one fact per case. The last two suites in
 * this file state the same behaviour over the repository's own captures, read
 * from `packages/telemetry/test/fixtures/**` at run time:
 *
 * - `capture-batch.json` — one complete 35-event capture across all three
 *   tiers, of which six are renders, two are commits and two are state
 *   changes. It is what the render grouping, the trigger histogram, the two
 *   headline counts of AAP 0.6.5' render panel and the commit-snapshot tree
 *   are driven from, and the twenty other events in it are the proof that the
 *   kinds this module does not read contribute nothing.
 * - `redaction-props-state.json` — the props/state corpus the redaction layer
 *   is held to, in both its `before` and its already-redacted `after` form. It
 *   carries captured prop and state *previews*, which is exactly what must not
 *   survive aggregation, so it is the corpus AAP 0.5.2' privacy bound is
 *   asserted against here.
 *
 * Three decisions about how they are consumed:
 *
 * - **Every element is parsed through the event schema**, persisted elements
 *   through `telemetryEventSchema` and ingress elements through
 *   `telemetryEventIngressSchema`. That parse *is* the fixture-contract
 *   assertion: a corpus that drifted into a shape the store would reject fails
 *   these suites instead of quietly feeding an aggregate something no producer
 *   could send. Each file is read once, at module scope, and re-parsed per
 *   call, so every case receives a fresh structure that no earlier case can
 *   have mutated.
 * - **The props/state events are attributed in-test.** They are ingress
 *   records — no `sessionId`, `captureId` or `ingestSeq`, because a producer
 *   never sends those — and attribution at ingest is the service's job
 *   (AAP 0.2.3, `apps/local-service/src/telemetry/attribute.ts`). The
 *   aggregates work on persisted events, so the suite adds exactly those three
 *   fields and re-parses through the persisted schema, which is the same
 *   transition the real path makes and the only one it makes.
 * - **They are repository data, not a live capture.** The files are tracked,
 *   every timestamp and identifier in them is a literal, and nothing is
 *   generated at run time, so a corpus-driven case is as reproducible as an
 *   inline one.
 *
 * Hermetic by construction: no network, no timers and no clock — every
 * timestamp in here is a fixture, because the module under test reads no clock
 * either. The only filesystem access is the synchronous read of those two
 * tracked fixtures.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  SPAN_ID_PATTERN,
  TRACE_ID_PATTERN,
  roundMs,
  type EventId,
  type SourceLocation,
  type SpanId,
  type TraceId,
} from '@debuggen/shared';
import { describe, expect, it } from 'vitest';

import { redactEvent } from '../redaction/redactor.js';
import {
  ALL_ATTRIBUTE_KEYS,
  ATTRIBUTE_VALUE_TYPES,
  COMMIT_ATTRIBUTE_KEYS,
  COMPONENT_TREE_ATTRIBUTE_KEYS,
  COMPONENT_TREE_EVENT_NAME,
  LOG_ATTRIBUTE_KEYS,
  MAX_PREVIEW_LENGTH,
  MAX_TRACKED_KEYS,
  RENDER_ATTRIBUTE_KEYS,
  RENDER_PHASES,
  RENDER_TRIGGERS,
  attributeKeysFor,
  type AttributeValueSummary,
  type ChangedPropEntry,
  type RenderTrigger,
} from '../schema/attributes.js';
import {
  isTelemetryEvent,
  telemetryEventIngressSchema,
  telemetryEventSchema,
  type TelemetryEvent,
  type TelemetryEventIngress,
} from '../schema/event.js';
import {
  RENDER_KINDS,
  TELEMETRY_KINDS,
  TELEMETRY_STATUSES,
  allowedTiersFor,
  type TelemetryKind,
  type TelemetryTier,
} from '../schema/kinds.js';
import {
  COMPONENT_TREE_NODE_ID_PREFIX,
  COMPONENT_TREE_ORIGINS,
  DEFAULT_COMPONENT_TREE_MAX_DEPTH,
  DEFAULT_COMPONENT_TREE_MAX_NODES,
  DEFAULT_MAX_OCCURRENCES_PER_COMPONENT,
  RENDER_STAT_ID_PREFIX,
  UNKNOWN_COMPONENT_LABEL,
  aggregateRenders,
  buildComponentTreeSnapshot,
  summarizeRenderTriggers,
  type ComponentTreeNode,
  type ComponentTreeOptions,
  type ComponentTreeOrigin,
  type ComponentTreeSnapshot,
  type RenderAggregateOptions,
  type RenderOccurrence,
  type RenderPhaseCounts,
  type RenderStat,
  type RenderTriggerHistogram,
  type RenderTriggerSummary,
} from './renders.js';

/*
 * ---------------------------------------------------------------------------
 * Vocabulary bindings
 *
 * Bound positionally from the declaring tuples, which is what the module under
 * test does. The coupling is to declaration order rather than to a spelling
 * repeated here, so this file cannot be the place a key name drifts.
 * ---------------------------------------------------------------------------
 */

/** The five trigger members, in the order `RENDER_TRIGGERS` declares them. */
const [PROPS_TRIGGER, STATE_TRIGGER, CONTEXT_TRIGGER, UNCHANGED_TRIGGER, UNKNOWN_TRIGGER] =
  RENDER_TRIGGERS;

/** The two commit phases. */
const [MOUNT_PHASE, UPDATE_PHASE] = RENDER_PHASES;

/**
 * The render event's attribute keys. The eighth (`selfTime`) is not read by
 * the module under test, so it is deliberately left unbound.
 */
const [
  COMPONENT_KEY,
  PHASE_KEY,
  REPORTED_RENDER_COUNT_KEY,
  CHANGED_PROPS_KEY,
  TRIGGER_KEY,
  ACTUAL_DURATION_KEY,
  OWNER_CHAIN_KEY,
] = RENDER_ATTRIBUTE_KEYS;

/** The commit event's three declared attribute keys. */
const [COMMIT_PHASE_KEY, COMMIT_FIBER_COUNT_KEY, COMMIT_ROOT_NAME_KEY] = COMMIT_ATTRIBUTE_KEYS;

/**
 * The log kind's own three keys. The component-tree keys are spread into the
 * same tuple by the catalog and are bound from their own tuple below, so the
 * snapshot fixture names each key exactly once.
 */
const [LOG_LEVEL_KEY, LOG_MESSAGE_KEY, LOGGER_NAME_KEY] = LOG_ATTRIBUTE_KEYS;

/** The component-tree snapshot's three attribute keys. */
const [SNAPSHOT_TREE_KEY, SNAPSHOT_NODE_COUNT_KEY, SNAPSHOT_TRUNCATED_KEY] =
  COMPONENT_TREE_ATTRIBUTE_KEYS;

/** The value category a summarised string prop reports. */
const [STRING_VALUE_TYPE] = ATTRIBUTE_VALUE_TYPES;

/** The status a fixture event reports: nothing here asserts success. */
const [FIXTURE_STATUS] = TELEMETRY_STATUSES;

/** The three snapshot origins, best first. */
const [COMMIT_SNAPSHOT_ORIGIN, OWNER_CHAINS_ORIGIN, FLAT_ORIGIN] = COMPONENT_TREE_ORIGINS;

/**
 * Narrows away an `undefined` that the vocabularies and fixtures make
 * impossible, with a message that names what was missing.
 *
 * Used instead of a non-null assertion so that a genuinely absent value fails
 * as a readable test error rather than as a `TypeError` several frames later.
 *
 * @param value The value to require.
 * @param what What it was, for the failure message.
 * @returns `value`, narrowed.
 */
function requireDefined<Value>(value: Value | undefined, what: string): Value {
  if (value === undefined) {
    throw new Error(`fixture invariant broken: expected ${what} to be present`);
  }
  return value;
}

/**
 * The member of the render kind group that declares `keys`.
 *
 * Resolved the way `./renders.ts` resolves it — the attribute registry hands
 * back the very tuple each kind declares, so reference identity is exact —
 * rather than by indexing the group positionally. A reordering of
 * `RENDER_KINDS` therefore leaves this file testing the same two kinds.
 *
 * @param keys The declaring tuple, `RENDER_ATTRIBUTE_KEYS` or
 * `COMMIT_ATTRIBUTE_KEYS`.
 * @returns The kind that declares them.
 */
function kindDeclaring(keys: readonly string[]): TelemetryKind {
  return requireDefined(
    RENDER_KINDS.find((candidate) => attributeKeysFor(candidate) === keys),
    'a render-group kind declaring the given attribute keys',
  );
}

/** The kind whose declared keys are the render keys. */
const RENDER_KIND = kindDeclaring(RENDER_ATTRIBUTE_KEYS);

/** The kind whose declared keys are the commit keys. */
const COMMIT_KIND = kindDeclaring(COMMIT_ATTRIBUTE_KEYS);

/**
 * The kind a component-tree snapshot travels as: the one whose declared keys
 * are the log keys.
 *
 * Resolved from the whole kind vocabulary the way `./renders.ts` resolves it —
 * by reference identity against the declaring tuple — rather than named, so a
 * catalog change moves this file's fixtures with it.
 */
const SNAPSHOT_KIND = requireDefined(
  TELEMETRY_KINDS.find((candidate) => attributeKeysFor(candidate) === LOG_ATTRIBUTE_KEYS),
  'the telemetry kind declaring the log attribute keys',
);

/** A kind outside the render group, for the "ignores everything else" case. */
const UNRELATED_KIND = requireDefined(
  TELEMETRY_KINDS.find((kind) => !RENDER_KINDS.includes(kind) && kind !== SNAPSHOT_KIND),
  'a telemetry kind outside the render group',
);

/**
 * The first tier `kind` may be reported in.
 *
 * Taken from `KIND_ALLOWED_TIERS` through its accessor, so a fixture can never
 * carry a kind/tier pair the event schema forbids — which is also why the
 * fixture-validity suite below can assert every builder output parses.
 *
 * @param kind The kind the event reports.
 * @returns A tier that kind is allowed on.
 */
function tierFor(kind: TelemetryKind): TelemetryTier {
  const [tier] = allowedTiersFor(kind);
  return requireDefined(tier, `an allowed tier for kind "${kind}"`);
}

/*
 * ---------------------------------------------------------------------------
 * Fixture identity and constants
 * ---------------------------------------------------------------------------
 */

/** Epoch milliseconds every fixture's timeline is anchored at. */
const EPOCH_BASE = 1_758_000_000_000;

/** Width of a trace id, asserted against `TRACE_ID_PATTERN` below. */
const TRACE_ID_WIDTH = 32;

/** Width of a span id, asserted against `SPAN_ID_PATTERN` below. */
const SPAN_ID_WIDTH = 16;

/** Seed of the trace every fixture shares unless it names another. */
const DEFAULT_TRACE_SEED = 0xa11ce;

/** Seed offset for span ids, so no span id is all-zero. */
const SPAN_SEED_BASE = 0x5e00;

/** Duration a render fixture reports unless it names another, in ms. */
const DEFAULT_RENDER_DURATION_MS = 1;

/** The component a render fixture names unless it names another. */
const DEFAULT_COMPONENT = 'ComponentA';

/** A second component, for the grouping and ordering cases. */
const OTHER_COMPONENT = 'ComponentB';

/** The root name a commit fixture reports. */
const ROOT_NAME = 'RootShell';

/** Fixture producer id: stable, so a rerun produces the same events. */
const PRODUCER_ID = 'prd_fixture_producer';

/** Fixture session id. */
const SESSION_ID = 'ses_fixture_session';

/** Fixture capture id. */
const CAPTURE_ID = 'cap_fixture_capture';

/**
 * The attribute key a commit fixture carries its serialized tree under: the
 * catalogued component-tree key.
 *
 * Annotated with the catalog tuple's member union rather than spelled loosely,
 * because this is the contract's spelling: `./renders.ts` reads this exact key
 * off a commit before it falls back to scanning the commit's *undeclared*
 * attributes, so a producer that attaches the document to its commit and one
 * that emits a snapshot event write the same key. The commit kind does not
 * *declare* it — the suite below asserts that, since a declared key would also
 * be filtered out of the discovery scan {@link UNDECLARED_TREE_KEY} covers.
 */
const SERIALIZED_TREE_KEY: (typeof COMPONENT_TREE_ATTRIBUTE_KEYS)[number] = 'componentTree';

/**
 * A key no kind declares, for the discovery scan.
 *
 * The event schema leaves the attribute bag open so a new signal can ship
 * without a schema change, and `./renders.ts` offers every attribute the
 * catalog does not declare for the kind to its structural parser. The suite
 * below asserts this key really is undeclared, so the case stays meaningful if
 * the catalog grows.
 */
const UNDECLARED_TREE_KEY = 'fiberForest';

/**
 * A credential-shaped string that must never reach an aggregate's output.
 *
 * Assembled at run time from fragments: this file is tracked, and
 * `scripts/check-secrets.mjs` (AAP 0.3.4) scans tracked content for exactly the
 * provider prefix the joined value forms. No fragment below matches a provider
 * pattern on its own, and the value is synthetic — it authenticates nothing.
 */
const CREDENTIAL_SHAPED_PREVIEW = ['sk', '-ant', '-api03', '-', 'A1b2C3d4'.repeat(6)].join('');

/**
 * A fragment of {@link CREDENTIAL_SHAPED_PREVIEW} long enough that finding it
 * in an output could not be a coincidence.
 *
 * Asserted separately so that a partial leak — a truncated preview, a value cut
 * to a bound — fails the privacy case as loudly as a whole one.
 */
const CREDENTIAL_FRAGMENT = CREDENTIAL_SHAPED_PREVIEW.slice(-24);

/**
 * A location resolved by the code graph: what a component's declaration
 * normally resolves through.
 */
const CODE_GRAPH_LOCATION: SourceLocation = {
  file: 'src/lib/component-a.tsx',
  line: 12,
  column: 3,
  symbol: DEFAULT_COMPONENT,
  resolvedBy: 'code-graph',
  confidence: DEFAULT_RESOLUTION_CONFIDENCE['code-graph'],
};

/**
 * A second code-graph location for the same component.
 *
 * The same resolution route and therefore the same confidence as
 * {@link CODE_GRAPH_LOCATION}, at a different position: the pair the
 * equal-confidence tie-break is asserted with.
 */
const RIVAL_CODE_GRAPH_LOCATION: SourceLocation = {
  file: 'src/lib/component-a.tsx',
  line: 90,
  column: 7,
  symbol: DEFAULT_COMPONENT,
  resolvedBy: 'code-graph',
  confidence: DEFAULT_RESOLUTION_CONFIDENCE['code-graph'],
};

/**
 * A location resolved by a patch: the most confident route there is, used to
 * prove the most confident location wins when a component's renders disagree.
 */
const PATCH_LOCATION: SourceLocation = {
  file: 'src/lib/component-a.tsx',
  line: 40,
  column: 1,
  symbol: DEFAULT_COMPONENT,
  endLine: 52,
  resolvedBy: 'patch',
  confidence: DEFAULT_RESOLUTION_CONFIDENCE.patch,
};

/*
 * ---------------------------------------------------------------------------
 * Fixture builders
 *
 * Each builder takes an ordinal, which fixes the event id, the span id, the
 * emission sequence, the ingest sequence and — unless the caller names one —
 * the start time. Nothing is drawn from a module-level counter, so a test's
 * fixtures are identical whether it runs alone or after every other case.
 * ---------------------------------------------------------------------------
 */

/** Zero-padded hexadecimal of `seed`, `width` characters wide. */
function hexId(seed: number, width: number): string {
  return seed.toString(16).padStart(width, '0');
}

/** The trace id for a seed. */
function traceIdFor(seed: number): TraceId {
  return hexId(seed, TRACE_ID_WIDTH);
}

/** The span id an ordinal maps to. */
function spanIdFor(at: number): SpanId {
  return hexId(SPAN_SEED_BASE + at, SPAN_ID_WIDTH);
}

/** The event id an ordinal maps to, ordered by code unit for the tie-breaks. */
function eventIdFor(at: number): EventId {
  return `evt_${String(at).padStart(4, '0')}`;
}

/** Ordinals `1..count`, the deterministic stand-in for a sequence counter. */
function ordinals(count: number): readonly number[] {
  return Array.from({ length: count }, (_unused, index) => index + 1);
}

/** Fields every fixture event accepts. */
interface EventSpec {
  /** The fixture's ordinal: its identity and, by default, its start time. */
  readonly at: number;
  /** Epoch milliseconds; defaults to {@link EPOCH_BASE} plus the ordinal. */
  readonly startTime?: number;
  /** Milliseconds; defaults to {@link DEFAULT_RENDER_DURATION_MS}. */
  readonly duration?: number;
  /** Trace; defaults to the fixture trace every event shares. */
  readonly traceId?: TraceId;
  /** Store-assigned arrival number; defaults to the ordinal. */
  readonly ingestSeq?: number;
  /** Replaces the whole attribute bag, malformed values included. */
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** Fields only a render fixture accepts. */
interface RenderEventSpec extends EventSpec {
  /** The commit that rendered this fiber, when the fixture links them. */
  readonly parentSpanId?: SpanId;
  /** The location a resolver supplied for this render. */
  readonly source?: SourceLocation;
}

/** Fields only a commit fixture accepts. */
interface CommitEventSpec extends EventSpec {
  /**
   * A structure to carry under {@link SERIALIZED_TREE_KEY}, of any shape: the
   * hostile-payload cases pass values no producer would send.
   */
  readonly serializedTree?: unknown;
}

/** The render attributes a fixture may populate, each omitted when absent. */
interface RenderAttributeParts {
  readonly component?: string;
  readonly trigger?: unknown;
  readonly phase?: unknown;
  readonly reportedRenderCount?: unknown;
  readonly changedProps?: unknown;
  readonly ownerChain?: unknown;
  readonly actualDuration?: unknown;
}

/**
 * Builds a render event's attribute bag through the declared keys.
 *
 * A part the caller omits leaves its key **absent**, which is how the
 * "attribute missing" cases are expressed; a malformed value is passed through
 * untouched, because the reader under test is what should be rejecting it.
 *
 * @param parts The attributes to populate.
 * @returns A fresh bag.
 */
function renderAttributes(parts: RenderAttributeParts): Record<string, unknown> {
  const bag: Record<string, unknown> = {};
  if (parts.component !== undefined) {
    bag[COMPONENT_KEY] = parts.component;
  }
  if (parts.trigger !== undefined) {
    bag[TRIGGER_KEY] = parts.trigger;
  }
  if (parts.phase !== undefined) {
    bag[PHASE_KEY] = parts.phase;
  }
  if (parts.reportedRenderCount !== undefined) {
    bag[REPORTED_RENDER_COUNT_KEY] = parts.reportedRenderCount;
  }
  if (parts.changedProps !== undefined) {
    bag[CHANGED_PROPS_KEY] = parts.changedProps;
  }
  if (parts.ownerChain !== undefined) {
    bag[OWNER_CHAIN_KEY] = parts.ownerChain;
  }
  if (parts.actualDuration !== undefined) {
    bag[ACTUAL_DURATION_KEY] = parts.actualDuration;
  }
  return bag;
}

/**
 * A commit's attribute bag: the three keys the catalog declares for the kind,
 * and nothing else.
 *
 * Populating all three matters for the owner-chain and flat routes: every key
 * here is declared, so the tree parser is offered no candidate and the fixture
 * genuinely has no serialized structure to find.
 */
function commitAttributes(): Record<string, unknown> {
  return {
    [COMMIT_PHASE_KEY]: UPDATE_PHASE,
    [COMMIT_FIBER_COUNT_KEY]: 2,
    [COMMIT_ROOT_NAME_KEY]: ROOT_NAME,
  };
}

/**
 * A persisted render event.
 *
 * @param spec Ordinal, timing, lineage and attributes. Attributes default to
 * the component and trigger the grouping cases expect.
 * @returns A fresh event.
 */
function makeRenderEvent(spec: RenderEventSpec): TelemetryEvent {
  return {
    id: eventIdFor(spec.at),
    traceId: spec.traceId ?? traceIdFor(DEFAULT_TRACE_SEED),
    spanId: spanIdFor(spec.at),
    ...(spec.parentSpanId === undefined ? {} : { parentSpanId: spec.parentSpanId }),
    kind: RENDER_KIND,
    name: `${RENDER_KIND} ${DEFAULT_COMPONENT}`,
    startTime: spec.startTime ?? EPOCH_BASE + spec.at,
    duration: spec.duration ?? DEFAULT_RENDER_DURATION_MS,
    tier: tierFor(RENDER_KIND),
    attributes: {
      ...(spec.attributes ??
        renderAttributes({ component: DEFAULT_COMPONENT, trigger: PROPS_TRIGGER })),
    },
    status: FIXTURE_STATUS,
    producerId: PRODUCER_ID,
    seq: spec.at - 1,
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    ingestSeq: spec.ingestSeq ?? spec.at,
    ...(spec.source === undefined ? {} : { source: spec.source }),
  };
}

/**
 * A persisted commit event.
 *
 * @param spec Ordinal, timing and optionally a serialized structure.
 * @returns A fresh event.
 */
function makeCommitEvent(spec: CommitEventSpec): TelemetryEvent {
  const attributes: Record<string, unknown> = { ...(spec.attributes ?? commitAttributes()) };
  if (spec.serializedTree !== undefined) {
    attributes[SERIALIZED_TREE_KEY] = spec.serializedTree;
  }
  return {
    id: eventIdFor(spec.at),
    traceId: spec.traceId ?? traceIdFor(DEFAULT_TRACE_SEED),
    spanId: spanIdFor(spec.at),
    kind: COMMIT_KIND,
    name: `${COMMIT_KIND} ${ROOT_NAME}`,
    startTime: spec.startTime ?? EPOCH_BASE + spec.at,
    duration: spec.duration ?? DEFAULT_RENDER_DURATION_MS,
    tier: tierFor(COMMIT_KIND),
    attributes,
    status: FIXTURE_STATUS,
    producerId: PRODUCER_ID,
    seq: spec.at - 1,
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    ingestSeq: spec.ingestSeq ?? spec.at,
  };
}

/**
 * A node as `../browser/react.ts` serialises one.
 *
 * It names itself `name` rather than `component`, carries the fiber's identity
 * and the component's capture-wide count, and admits `null` for an element
 * with no React key — which is what a fiber holds and what survives a JSON
 * round trip. Declared here so the snapshot fixtures are the producer's shape
 * and not a convenient approximation of it.
 */
interface AgentTreeNode {
  readonly name: string;
  readonly fiberId?: number;
  readonly key?: string | null;
  readonly renderCount: number;
  readonly children: readonly AgentTreeNode[];
}

/**
 * The document the page agent posts at capture stop: one root, a keyed child
 * that rendered, and a child that did not.
 *
 * The second child is the reason the snapshot route exists: a component that
 * was mounted before the capture began renders nothing, so no owner chain
 * mentions it and only the producer's own structure knows it is there.
 */
function agentShapedTree(): AgentTreeNode {
  return {
    name: 'ParentView',
    fiberId: 1,
    key: null,
    renderCount: 1,
    children: [
      { name: 'ListRow', fiberId: 2, key: 'row-1', renderCount: 2, children: [] },
      { name: 'Sleeper', fiberId: 3, renderCount: 0, children: [] },
    ],
  };
}

/** Fields only a component-tree snapshot fixture accepts. */
interface SnapshotEventSpec extends EventSpec {
  /**
   * The document to carry under the catalogued tree key, of any shape: the
   * fixtures pass JSON text, structures and values no producer would send.
   */
  readonly tree?: unknown;
  /** The producer's `componentTreeTruncated` flag; defaults to `false`. */
  readonly reduced?: boolean;
  /**
   * The kind to report, for the case that proves the kind gate. Defaults to
   * {@link SNAPSHOT_KIND}, the kind the catalog declares the tree keys under.
   */
  readonly kind?: TelemetryKind;
}

/**
 * A persisted component-tree snapshot event, shaped exactly as
 * `../browser/agent.ts` emits it: the catalogued event name, the log kind, the
 * three log attributes and the three component-tree attributes.
 *
 * @param spec Ordinal, timing, the document and the producer's reduced flag.
 * @returns A fresh event.
 */
function makeSnapshotEvent(spec: SnapshotEventSpec): TelemetryEvent {
  const kind = spec.kind ?? SNAPSHOT_KIND;
  const attributes: Record<string, unknown> = {
    ...(spec.attributes ?? {
      [LOG_LEVEL_KEY]: 'info',
      [LOG_MESSAGE_KEY]: 'component tree at capture stop',
      [LOGGER_NAME_KEY]: 'debuggen.agent',
    }),
  };
  if (spec.tree !== undefined) {
    attributes[SNAPSHOT_TREE_KEY] = spec.tree;
    attributes[SNAPSHOT_NODE_COUNT_KEY] = 1;
    attributes[SNAPSHOT_TRUNCATED_KEY] = spec.reduced === true;
  }
  return {
    id: eventIdFor(spec.at),
    traceId: spec.traceId ?? traceIdFor(DEFAULT_TRACE_SEED),
    spanId: spanIdFor(spec.at),
    kind,
    name: COMPONENT_TREE_EVENT_NAME,
    startTime: spec.startTime ?? EPOCH_BASE + spec.at,
    duration: 0,
    tier: tierFor(kind),
    attributes,
    status: FIXTURE_STATUS,
    producerId: PRODUCER_ID,
    seq: spec.at - 1,
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    ingestSeq: spec.ingestSeq ?? spec.at,
  };
}

/**
 * An event of a kind outside the render group, carrying render-shaped
 * attributes on purpose: a kind this module does not read must contribute
 * nothing even when its bag looks familiar.
 */
function makeUnrelatedEvent(spec: EventSpec): TelemetryEvent {
  return {
    id: eventIdFor(spec.at),
    traceId: spec.traceId ?? traceIdFor(DEFAULT_TRACE_SEED),
    spanId: spanIdFor(spec.at),
    kind: UNRELATED_KIND,
    name: `${UNRELATED_KIND} fixture`,
    startTime: spec.startTime ?? EPOCH_BASE + spec.at,
    duration: spec.duration ?? DEFAULT_RENDER_DURATION_MS,
    tier: tierFor(UNRELATED_KIND),
    attributes: {
      ...(spec.attributes ??
        renderAttributes({ component: DEFAULT_COMPONENT, trigger: PROPS_TRIGGER })),
    },
    status: FIXTURE_STATUS,
    producerId: PRODUCER_ID,
    seq: spec.at - 1,
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    ingestSeq: spec.ingestSeq ?? spec.at,
  };
}

/*
 * ---------------------------------------------------------------------------
 * Assertion helpers
 * ---------------------------------------------------------------------------
 */

/** The statistic for one component, or a readable failure. */
function statFor(stats: readonly RenderStat[], component: string): RenderStat {
  return requireDefined(
    stats.find((stat) => stat.component === component),
    `a render statistic for "${component}"`,
  );
}

/** The one statistic a single-component fixture must produce. */
function onlyStat(stats: readonly RenderStat[]): RenderStat {
  expect(stats).toHaveLength(1);
  return requireDefined(stats[0], 'the only render statistic');
}

/** The one occurrence a single-render fixture must produce. */
function onlyOccurrence(stat: RenderStat): RenderOccurrence {
  expect(stat.occurrences).toHaveLength(1);
  return requireDefined(stat.occurrences[0], 'the only render occurrence');
}

/** A snapshot the fixture guarantees, or a readable failure. */
function requireSnapshot(snapshot: ComponentTreeSnapshot | undefined): ComponentTreeSnapshot {
  return requireDefined(snapshot, 'a component tree snapshot');
}

/** Every node of a forest, parents before children. */
function flattenNodes(nodes: readonly ComponentTreeNode[]): readonly ComponentTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children)]);
}

/** Every node of a snapshot. */
function allNodes(snapshot: ComponentTreeSnapshot): readonly ComponentTreeNode[] {
  return flattenNodes(snapshot.roots);
}

/** The nodes of a snapshot naming one component, in emission order. */
function nodesFor(
  snapshot: ComponentTreeSnapshot,
  component: string,
): readonly ComponentTreeNode[] {
  return allNodes(snapshot).filter((node) => node.component === component);
}

/** The single node of a snapshot naming one component. */
function nodeFor(snapshot: ComponentTreeSnapshot, component: string): ComponentTreeNode {
  const matches = nodesFor(snapshot, component);
  expect(matches).toHaveLength(1);
  return requireDefined(matches[0], `a tree node for "${component}"`);
}

/**
 * Whether a value is an object this file may walk.
 *
 * A predicate rather than a cast: `Object.entries` and `Reflect.get` both hand
 * back `any`, which the repository's type-checked lint rules reject, and an
 * index read through this narrowing yields `unknown` — so every walked value
 * still has to be validated by whatever consumes it.
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

/**
 * Freezes a value and everything reachable from it.
 *
 * The non-mutation case hands frozen events to the module under test, so a
 * stray in-place `sort`, `push` or attribute write throws in strict-mode code
 * instead of being missed by a comparison. Arrays are objects here, so they are
 * frozen too, and an already-frozen value short-circuits, which is what makes
 * the walk safe on a structure that shares references.
 *
 * @param value The value to freeze in place.
 */
function deepFreeze(value: unknown): void {
  if (!isRecord(value) || Object.isFrozen(value)) {
    return;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
}

/**
 * A deterministic reordering of an array: reversed, then rotated by one.
 *
 * Deterministic on purpose. A shuffle seeded from a clock would make a failure
 * of the order-independence cases unreproducible, which is the one property a
 * regression test must have.
 *
 * @param items The array to reorder.
 * @returns A fresh array holding the same items in a different order.
 */
function reordered<Item>(items: readonly Item[]): readonly Item[] {
  const reversed = [...items].reverse();
  const head = reversed.shift();
  return head === undefined ? reversed : [...reversed, head];
}

/*
 * ---------------------------------------------------------------------------
 * The suite's own premises
 *
 * A fixture that the store would reject, or a serialized tree hidden under a
 * key the parser never visits, would make every case below vacuous. These
 * assertions are what keep that from happening silently.
 * ---------------------------------------------------------------------------
 */

describe('fixtures', () => {
  it('builds events the persisted schema accepts', () => {
    const events = [
      makeRenderEvent({
        at: 1,
        parentSpanId: spanIdFor(9),
        source: CODE_GRAPH_LOCATION,
        attributes: renderAttributes({
          component: DEFAULT_COMPONENT,
          trigger: UNCHANGED_TRIGGER,
          phase: MOUNT_PHASE,
          reportedRenderCount: 3,
          changedProps: ['alpha'],
          ownerChain: ['ParentView'],
        }),
      }),
      makeCommitEvent({ at: 2, serializedTree: [{ component: ROOT_NAME, children: [] }] }),
      makeUnrelatedEvent({ at: 3 }),
      makeSnapshotEvent({
        at: 4,
        tree: JSON.stringify(agentShapedTree()),
        reduced: true,
      }),
    ];

    for (const event of events) {
      expect(isTelemetryEvent(event)).toBe(true);
    }
  });

  it('generates identifiers of the shapes the shared patterns define', () => {
    const event = makeRenderEvent({ at: 7 });

    expect(event.traceId).toMatch(TRACE_ID_PATTERN);
    expect(event.spanId).toMatch(SPAN_ID_PATTERN);
    expect(event.traceId).toHaveLength(TRACE_ID_WIDTH);
    expect(event.spanId).toHaveLength(SPAN_ID_WIDTH);
  });

  it('is reproducible: one ordinal always yields one event', () => {
    expect(makeRenderEvent({ at: 4 })).toStrictEqual(makeRenderEvent({ at: 4 }));
    expect(makeRenderEvent({ at: 4 }).id).not.toBe(makeRenderEvent({ at: 5 }).id);
  });

  it('carries its serialized tree under a key the commit kind does not declare', () => {
    // The discovery path in `./renders.ts` offers only UNDECLARED attributes to
    // its structural parser. The catalogued tree key is read off a commit
    // explicitly, ahead of that scan, and is not declared for the commit kind —
    // so both routes stay reachable and neither tree case is vacuous.
    expect(attributeKeysFor(COMMIT_KIND, { includeCommon: true })).not.toContain(
      SERIALIZED_TREE_KEY,
    );
    expect(attributeKeysFor(SNAPSHOT_KIND)).toContain(SERIALIZED_TREE_KEY);
    expect(ALL_ATTRIBUTE_KEYS).not.toContain(UNDECLARED_TREE_KEY);
  });

  it('builds a snapshot event under the catalogued name, kind and keys', () => {
    // The producer's contract, asserted on the fixture rather than assumed:
    // every tree case below is only as meaningful as this event's fidelity to
    // what `../browser/agent.ts` emits.
    const event = makeSnapshotEvent({ at: 1, tree: JSON.stringify(agentShapedTree()) });

    expect(event.name).toBe(COMPONENT_TREE_EVENT_NAME);
    expect(event.kind).toBe(SNAPSHOT_KIND);
    expect(Object.keys(event.attributes)).toStrictEqual([
      LOG_LEVEL_KEY,
      LOG_MESSAGE_KEY,
      LOGGER_NAME_KEY,
      ...COMPONENT_TREE_ATTRIBUTE_KEYS,
    ]);
    expect(RENDER_KINDS).not.toContain(SNAPSHOT_KIND);
  });

  it('resolves the two render-group kinds distinctly', () => {
    expect(RENDER_KIND).not.toBe(COMMIT_KIND);
    expect(RENDER_KINDS).toContain(RENDER_KIND);
    expect(RENDER_KINDS).toContain(COMMIT_KIND);
    expect(RENDER_KINDS).not.toContain(UNRELATED_KIND);
  });

  it('assembles a credential-shaped preview that is never written literally', () => {
    // Assembled from fragments so the tracked bytes of this file carry no
    // provider-prefixed literal for `scripts/check-secrets.mjs` to report,
    // while the value the privacy case feeds through the aggregate stays
    // unmistakable in an output.
    expect(CREDENTIAL_SHAPED_PREVIEW.length).toBeGreaterThan(MAX_TRACKED_KEYS);
    expect(CREDENTIAL_SHAPED_PREVIEW).toContain(CREDENTIAL_FRAGMENT);
  });
});

/*
 * ---------------------------------------------------------------------------
 * `aggregateRenders`: grouping, timing and the honesty of the result set
 * ---------------------------------------------------------------------------
 */

describe('aggregateRenders', () => {
  describe('grouping', () => {
    it('produces one statistic per component that rendered', () => {
      const events = [
        makeRenderEvent({
          at: 1,
          attributes: renderAttributes({ component: DEFAULT_COMPONENT, trigger: PROPS_TRIGGER }),
        }),
        makeRenderEvent({
          at: 2,
          attributes: renderAttributes({ component: DEFAULT_COMPONENT, trigger: STATE_TRIGGER }),
        }),
        makeRenderEvent({
          at: 3,
          attributes: renderAttributes({ component: OTHER_COMPONENT, trigger: PROPS_TRIGGER }),
        }),
      ];

      const stats = aggregateRenders(events);

      expect(stats).toHaveLength(2);
      expect(statFor(stats, DEFAULT_COMPONENT).renderCount).toBe(2);
      expect(statFor(stats, OTHER_COMPONENT).renderCount).toBe(1);
    });

    it('does not let commit events inflate a render count', () => {
      // A commit is the parent of the renders it performed, so counting one
      // here would break the identity `render_count` = the sum of this field,
      // which `./summary.ts` and the metric cards depend on.
      const events = [
        makeRenderEvent({ at: 1 }),
        makeCommitEvent({ at: 2 }),
        makeCommitEvent({ at: 3 }),
        makeCommitEvent({ at: 4 }),
      ];

      const stat = onlyStat(aggregateRenders(events));

      expect(stat.renderCount).toBe(1);
      expect(summarizeRenderTriggers(events).renderCount).toBe(1);
    });

    it('ignores kinds outside the render group, however familiar their attributes', () => {
      const events = [makeUnrelatedEvent({ at: 1 }), makeUnrelatedEvent({ at: 2 })];

      expect(aggregateRenders(events)).toStrictEqual([]);
      expect(summarizeRenderTriggers(events).renderCount).toBe(0);
    });

    it('groups a render with no usable component name under the unknown label', () => {
      const events = [
        // The attribute is absent.
        makeRenderEvent({ at: 1, attributes: renderAttributes({ trigger: PROPS_TRIGGER }) }),
        // The attribute is present but empty.
        makeRenderEvent({
          at: 2,
          attributes: renderAttributes({ component: '', trigger: STATE_TRIGGER }),
        }),
        // The attribute is present but is not a string.
        makeRenderEvent({
          at: 3,
          attributes: { [COMPONENT_KEY]: 42, [TRIGGER_KEY]: PROPS_TRIGGER },
        }),
      ];

      const stats = aggregateRenders(events);
      const unattributed = statFor(stats, UNKNOWN_COMPONENT_LABEL);

      // Evidence is never silently discarded: three renders arrived and three
      // renders are reported, under a label no component can be called.
      expect(unattributed.renderCount).toBe(3);
      expect(stats.reduce((total, stat) => total + stat.renderCount, 0)).toBe(events.length);
      expect(unattributed.id).toBe(`${RENDER_STAT_ID_PREFIX}${UNKNOWN_COMPONENT_LABEL}`);
    });

    it('excludes a render that cannot be placed on a timeline', () => {
      // A non-finite start time would poison every minimum, maximum and sort it
      // took part in, so such an event is rejected rather than admitted.
      const events = [makeRenderEvent({ at: 1, startTime: Number.NaN })];

      expect(aggregateRenders(events)).toStrictEqual([]);
      expect(buildComponentTreeSnapshot(events)).toBeUndefined();
    });
  });

  describe('timing', () => {
    it('sums, averages and maximises the observed durations', () => {
      const events = [
        makeRenderEvent({ at: 1, duration: 3.5 }),
        makeRenderEvent({ at: 2, duration: 1.25 }),
      ];

      const stat = onlyStat(aggregateRenders(events));

      expect(stat.totalDurationMs).toBe(4.75);
      expect(stat.averageDurationMs).toBe(2.375);
      expect(stat.maxDurationMs).toBe(3.5);
    });

    it('derives the average from the two numbers it publishes', () => {
      // A consumer that re-derives the mean from this row must get the answer
      // the row states, so the division is over the ROUNDED total.
      const events = [
        makeRenderEvent({ at: 1, duration: 1 }),
        makeRenderEvent({ at: 2, duration: 1 }),
        makeRenderEvent({ at: 3, duration: 1.001 }),
      ];

      const stat = onlyStat(aggregateRenders(events));

      expect(stat.totalDurationMs).toBe(roundMs(3.001));
      expect(stat.averageDurationMs).toBe(roundMs(stat.totalDurationMs / stat.renderCount));
    });

    it('brackets its occurrences with the first and last start time', () => {
      const events = ordinals(4).map((at) =>
        makeRenderEvent({ at, startTime: EPOCH_BASE + at * 10 }),
      );

      const stat = onlyStat(aggregateRenders(reordered(events)));

      expect(stat.firstStartTime).toBe(EPOCH_BASE + 10);
      expect(stat.lastStartTime).toBe(EPOCH_BASE + 40);
      for (const occurrence of stat.occurrences) {
        expect(occurrence.startTime).toBeGreaterThanOrEqual(stat.firstStartTime);
        expect(occurrence.startTime).toBeLessThanOrEqual(stat.lastStartTime);
      }
    });

    it('clamps a negative duration instead of inverting a bar', () => {
      const stat = onlyStat(aggregateRenders([makeRenderEvent({ at: 1, duration: -3 })]));

      expect(stat.totalDurationMs).toBe(0);
      expect(stat.maxDurationMs).toBe(0);
      expect(onlyOccurrence(stat).durationMs).toBe(0);
    });

    it('falls back to the recorded actual duration when the event carries none', () => {
      const stat = onlyStat(
        aggregateRenders([
          makeRenderEvent({
            at: 1,
            duration: Number.NaN,
            attributes: renderAttributes({
              component: DEFAULT_COMPONENT,
              trigger: PROPS_TRIGGER,
              actualDuration: 5,
            }),
          }),
        ]),
      );

      expect(stat.totalDurationMs).toBe(5);
    });

    it('counts phases over the whole vocabulary and leaves unreadable ones out', () => {
      const events = [
        makeRenderEvent({
          at: 1,
          attributes: renderAttributes({
            component: DEFAULT_COMPONENT,
            trigger: PROPS_TRIGGER,
            phase: MOUNT_PHASE,
          }),
        }),
        makeRenderEvent({
          at: 2,
          attributes: renderAttributes({
            component: DEFAULT_COMPONENT,
            trigger: PROPS_TRIGGER,
            phase: UPDATE_PHASE,
          }),
        }),
        makeRenderEvent({
          at: 3,
          attributes: renderAttributes({
            component: DEFAULT_COMPONENT,
            trigger: PROPS_TRIGGER,
            phase: 'neither',
          }),
        }),
      ];

      const stat = onlyStat(aggregateRenders(events));
      const phaseCounts: RenderPhaseCounts = stat.phaseCounts;

      expect(Object.keys(phaseCounts).sort()).toStrictEqual([...RENDER_PHASES].sort());
      expect(phaseCounts[MOUNT_PHASE]).toBe(1);
      expect(phaseCounts[UPDATE_PHASE]).toBe(1);
      // A phase nobody observed is not a mount and not an update, so these
      // counts may legitimately sum to less than the render count.
      const phaseTotal = RENDER_PHASES.reduce((total, phase) => total + phaseCounts[phase], 0);
      expect(phaseTotal).toBe(2);
      expect(phaseTotal).toBeLessThan(stat.renderCount);
    });
  });

  describe('identity and order', () => {
    it('derives a stable id from the component rather than minting one', () => {
      const stat = onlyStat(aggregateRenders([makeRenderEvent({ at: 1 })]));

      expect(stat.id).toBe(`${RENDER_STAT_ID_PREFIX}${DEFAULT_COMPONENT}`);
    });

    it('returns the same result for the same input, twice', () => {
      const events = [
        makeRenderEvent({ at: 1, source: CODE_GRAPH_LOCATION }),
        makeRenderEvent({
          at: 2,
          attributes: renderAttributes({ component: OTHER_COMPONENT, trigger: CONTEXT_TRIGGER }),
        }),
      ];

      expect(aggregateRenders(events)).toStrictEqual(aggregateRenders(events));
    });

    it('does not depend on the order the caller handed the events over in', () => {
      const events = [
        makeRenderEvent({ at: 1, source: CODE_GRAPH_LOCATION }),
        makeRenderEvent({ at: 2, source: PATCH_LOCATION }),
        makeRenderEvent({
          at: 3,
          attributes: renderAttributes({ component: OTHER_COMPONENT, trigger: UNCHANGED_TRIGGER }),
        }),
      ];

      expect(aggregateRenders(reordered(events))).toStrictEqual(aggregateRenders(events));
    });

    it('orders by render count descending, then component, then id', () => {
      const events = [
        makeRenderEvent({
          at: 1,
          attributes: renderAttributes({ component: 'WidgetHost', trigger: PROPS_TRIGGER }),
        }),
        makeRenderEvent({
          at: 2,
          attributes: renderAttributes({ component: OTHER_COMPONENT, trigger: PROPS_TRIGGER }),
        }),
        makeRenderEvent({ at: 3 }),
        makeRenderEvent({ at: 4 }),
      ];

      const stats = aggregateRenders(reordered(events), { includeOccurrences: false });

      expect(stats.map((stat) => [stat.component, stat.renderCount])).toStrictEqual([
        [DEFAULT_COMPONENT, 2],
        [OTHER_COMPONENT, 1],
        ['WidgetHost', 1],
      ]);
      // The tie is broken by component and then by id, both ascending by code
      // unit, which is what makes paging over this result set honest.
      expect(stats.map((stat) => stat.id).slice(1)).toStrictEqual([
        `${RENDER_STAT_ID_PREFIX}${OTHER_COMPONENT}`,
        `${RENDER_STAT_ID_PREFIX}WidgetHost`,
      ]);
    });

    it('keeps the most confident location a component reported', () => {
      const events = [
        makeRenderEvent({ at: 1, source: CODE_GRAPH_LOCATION }),
        makeRenderEvent({ at: 2, source: PATCH_LOCATION }),
      ];

      expect(onlyStat(aggregateRenders(events)).source).toStrictEqual(PATCH_LOCATION);
      expect(onlyStat(aggregateRenders(reordered(events))).source).toStrictEqual(PATCH_LOCATION);
    });

    it('breaks a tie between equally confident locations by the locations themselves', () => {
      const events = [
        makeRenderEvent({ at: 1, source: RIVAL_CODE_GRAPH_LOCATION }),
        makeRenderEvent({ at: 2, source: CODE_GRAPH_LOCATION }),
      ];
      // Same resolution route, so neither is the more trustworthy answer and
      // the confidence precedence cannot decide between them.
      expect(RIVAL_CODE_GRAPH_LOCATION.confidence).toBe(CODE_GRAPH_LOCATION.confidence);

      // The lesser location by file, line, column, symbol and route wins, so a
      // developer is sent to the same line whichever order the renders were
      // folded in — reversed explicitly, because `reordered` leaves a pair as
      // it found it.
      expect(onlyStat(aggregateRenders(events)).source).toStrictEqual(CODE_GRAPH_LOCATION);
      expect(onlyStat(aggregateRenders([...events].reverse())).source).toStrictEqual(
        CODE_GRAPH_LOCATION,
      );
      expect(onlyStat(aggregateRenders([...events].reverse()))).toStrictEqual(
        onlyStat(aggregateRenders(events)),
      );
    });
  });

  describe('purity and transport', () => {
    it('leaves the input array and every event in it untouched', () => {
      const events = [
        makeRenderEvent({
          at: 1,
          attributes: renderAttributes({
            component: DEFAULT_COMPONENT,
            trigger: PROPS_TRIGGER,
            changedProps: ['beta', 'alpha'],
            ownerChain: ['ParentView'],
          }),
          source: CODE_GRAPH_LOCATION,
        }),
        makeCommitEvent({ at: 2, serializedTree: [{ component: 'ParentView', children: [] }] }),
      ];
      const pristine = JSON.parse(JSON.stringify(events)) as unknown;
      deepFreeze(events);

      aggregateRenders(events);
      summarizeRenderTriggers(events);
      buildComponentTreeSnapshot(events);

      expect(JSON.parse(JSON.stringify(events))).toStrictEqual(pristine);
    });

    it('survives a JSON round trip with no map, set or undefined hole', () => {
      const events = [
        makeRenderEvent({
          at: 1,
          source: CODE_GRAPH_LOCATION,
          attributes: renderAttributes({
            component: DEFAULT_COMPONENT,
            trigger: UNCHANGED_TRIGGER,
            phase: UPDATE_PHASE,
            reportedRenderCount: 9,
            changedProps: ['alpha'],
          }),
        }),
        makeRenderEvent({
          at: 2,
          attributes: renderAttributes({ component: OTHER_COMPONENT, trigger: UNKNOWN_TRIGGER }),
        }),
      ];

      const stats = aggregateRenders(events);

      expect(JSON.parse(JSON.stringify(stats))).toStrictEqual(stats);
    });
  });
});

/*
 * ---------------------------------------------------------------------------
 * Render triggers: the one semantic that lives in the module under test
 *
 * The rule, from `../schema/attributes.ts`' `RENDER_TRIGGERS` and AAP 0.2.3:
 * `unchanged` requires that ALL THREE dimensions were evaluated and none
 * changed — props shallow-equal, own hook state unchanged AND no consumed
 * context value changed — a judgement only the producer's fiber diff can make.
 * `unknown` means at least one of the three could not be evaluated. The two are
 * disjoint and are never merged: "we checked and nothing changed" and "we could
 * not check" support different conclusions, so an undeterminable trigger counts
 * into `render_trigger_unknown_count` and never into `unchanged_render_count`.
 * ---------------------------------------------------------------------------
 */

/**
 * Asserts that every render of `stat` fell into one bucket and that every other
 * bucket of the vocabulary reads zero.
 *
 * @param stat The statistic to check.
 * @param trigger The bucket every render is expected in.
 */
function expectSoleTrigger(stat: RenderStat, trigger: RenderTrigger): void {
  for (const candidate of RENDER_TRIGGERS) {
    expect(stat.triggers[candidate]).toBe(candidate === trigger ? stat.renderCount : 0);
  }
}

/** One way a trigger attribute can fail to be readable. */
interface MalformedTriggerCase {
  /** What is wrong with it, for the test name. */
  readonly label: string;
  /** The whole attribute bag, so a missing key really is missing. */
  readonly attributes: Readonly<Record<string, unknown>>;
}

/**
 * Every shape an unreadable trigger arrives in.
 *
 * The attribute bag has crossed a page boundary, a WebSocket and a store before
 * it reaches the aggregate, so each of these is a value a real producer bug or
 * a replayed fixture can deliver — and each must be classified `unknown`.
 */
const MALFORMED_TRIGGER_CASES: readonly MalformedTriggerCase[] = [
  {
    label: 'the attribute is missing',
    attributes: renderAttributes({ component: DEFAULT_COMPONENT }),
  },
  {
    label: 'the attribute is present but undefined',
    attributes: { [COMPONENT_KEY]: DEFAULT_COMPONENT, [TRIGGER_KEY]: undefined },
  },
  {
    label: 'an empty string',
    attributes: { [COMPONENT_KEY]: DEFAULT_COMPONENT, [TRIGGER_KEY]: '' },
  },
  {
    label: 'a string outside the vocabulary',
    // The upper-cased spelling of a real member: membership is exact, so a
    // case-insensitive comparison creeping in would fail here.
    attributes: { [COMPONENT_KEY]: DEFAULT_COMPONENT, [TRIGGER_KEY]: PROPS_TRIGGER.toUpperCase() },
  },
  {
    label: 'a number',
    attributes: { [COMPONENT_KEY]: DEFAULT_COMPONENT, [TRIGGER_KEY]: 42 },
  },
  {
    label: 'null',
    attributes: { [COMPONENT_KEY]: DEFAULT_COMPONENT, [TRIGGER_KEY]: null },
  },
  {
    label: 'an object that names a member inside itself',
    attributes: {
      [COMPONENT_KEY]: DEFAULT_COMPONENT,
      [TRIGGER_KEY]: { [TRIGGER_KEY]: UNCHANGED_TRIGGER },
    },
  },
  {
    label: 'an array holding a member',
    attributes: { [COMPONENT_KEY]: DEFAULT_COMPONENT, [TRIGGER_KEY]: [UNCHANGED_TRIGGER] },
  },
];

describe('render triggers', () => {
  it('fills the histogram over the whole vocabulary, with no hole to index into', () => {
    const events = [
      makeRenderEvent({ at: 1 }),
      makeRenderEvent({
        at: 2,
        attributes: renderAttributes({ component: OTHER_COMPONENT, trigger: CONTEXT_TRIGGER }),
      }),
    ];

    const stats = aggregateRenders(events);

    expect(stats).toHaveLength(2);
    for (const stat of stats) {
      const histogram: RenderTriggerHistogram = stat.triggers;
      expect(Object.keys(histogram).sort()).toStrictEqual([...RENDER_TRIGGERS].sort());
      for (const trigger of RENDER_TRIGGERS) {
        expect(typeof histogram[trigger]).toBe('number');
        expect(histogram[trigger]).toBeGreaterThanOrEqual(0);
      }
      const bucketTotal = RENDER_TRIGGERS.reduce((total, trigger) => total + histogram[trigger], 0);
      expect(bucketTotal).toBe(stat.renderCount);
    }
  });

  it('counts an observed stable-input render as unchanged and not as unknown', () => {
    const stat = onlyStat(
      aggregateRenders([
        makeRenderEvent({
          at: 1,
          attributes: renderAttributes({
            component: DEFAULT_COMPONENT,
            trigger: UNCHANGED_TRIGGER,
          }),
        }),
      ]),
    );

    expect(stat.unchangedRenderCount).toBe(1);
    expect(stat.triggers[UNCHANGED_TRIGGER]).toBe(1);
    expect(stat.unknownTriggerCount).toBe(0);
    expectSoleTrigger(stat, UNCHANGED_TRIGGER);
  });

  it('counts an undeterminable render as unknown and not as unchanged', () => {
    const stat = onlyStat(
      aggregateRenders([
        makeRenderEvent({
          at: 1,
          attributes: renderAttributes({ component: DEFAULT_COMPONENT, trigger: UNKNOWN_TRIGGER }),
        }),
      ]),
    );

    expect(stat.unknownTriggerCount).toBe(1);
    expect(stat.triggers[UNKNOWN_TRIGGER]).toBe(1);
    expect(stat.unchangedRenderCount).toBe(0);
    expectSoleTrigger(stat, UNKNOWN_TRIGGER);
  });

  it('keeps the two buckets disjoint across a mixed capture', () => {
    const events = [
      makeRenderEvent({
        at: 1,
        attributes: renderAttributes({ component: DEFAULT_COMPONENT, trigger: UNCHANGED_TRIGGER }),
      }),
      makeRenderEvent({
        at: 2,
        attributes: renderAttributes({ component: DEFAULT_COMPONENT, trigger: UNKNOWN_TRIGGER }),
      }),
      makeRenderEvent({
        at: 3,
        attributes: renderAttributes({ component: DEFAULT_COMPONENT, trigger: PROPS_TRIGGER }),
      }),
    ];

    const stat = onlyStat(aggregateRenders(events));

    expect(stat.renderCount).toBe(3);
    expect(stat.unchangedRenderCount).toBe(1);
    expect(stat.unknownTriggerCount).toBe(1);
    expect(stat.unchangedRenderCount + stat.unknownTriggerCount).toBeLessThanOrEqual(
      stat.renderCount,
    );
  });

  it.each(MALFORMED_TRIGGER_CASES)(
    'classifies a render as unknown when the trigger is $label',
    ({ attributes }: MalformedTriggerCase) => {
      const stat = onlyStat(aggregateRenders([makeRenderEvent({ at: 1, attributes })]));

      expect(stat.unknownTriggerCount).toBe(1);
      expect(stat.unchangedRenderCount).toBe(0);
      expectSoleTrigger(stat, UNKNOWN_TRIGGER);
      expect(onlyOccurrence(stat).trigger).toBe(UNKNOWN_TRIGGER);
    },
  );

  it('reports every vocabulary member a capture actually observed', () => {
    const events = RENDER_TRIGGERS.map((trigger, index) =>
      makeRenderEvent({
        at: index + 1,
        attributes: renderAttributes({ component: DEFAULT_COMPONENT, trigger }),
      }),
    );

    const stat = onlyStat(aggregateRenders(events));

    for (const trigger of RENDER_TRIGGERS) {
      expect(stat.triggers[trigger]).toBe(1);
    }
    expect(stat.renderCount).toBe(RENDER_TRIGGERS.length);
  });
});

/*
 * ---------------------------------------------------------------------------
 * `summarizeRenderTriggers`: the single computation behind three metric cards
 * ---------------------------------------------------------------------------
 */

describe('summarizeRenderTriggers', () => {
  /** A capture spanning three components and four trigger buckets. */
  function mixedCapture(): readonly TelemetryEvent[] {
    return [
      makeRenderEvent({
        at: 1,
        attributes: renderAttributes({ component: DEFAULT_COMPONENT, trigger: UNCHANGED_TRIGGER }),
      }),
      makeRenderEvent({
        at: 2,
        attributes: renderAttributes({ component: DEFAULT_COMPONENT, trigger: UNKNOWN_TRIGGER }),
      }),
      makeRenderEvent({
        at: 3,
        attributes: renderAttributes({ component: OTHER_COMPONENT, trigger: CONTEXT_TRIGGER }),
      }),
      makeRenderEvent({
        at: 4,
        attributes: renderAttributes({ component: 'ListRow', trigger: STATE_TRIGGER }),
      }),
      makeRenderEvent({
        at: 5,
        attributes: renderAttributes({ component: 'ListRow', trigger: UNCHANGED_TRIGGER }),
      }),
    ];
  }

  it('totals the statistics it is handed', () => {
    const events = mixedCapture();
    const stats = aggregateRenders(events);
    const summary: RenderTriggerSummary = summarizeRenderTriggers(stats);

    expect(summary.renderCount).toBe(stats.reduce((total, stat) => total + stat.renderCount, 0));
    expect(summary.componentCount).toBe(stats.length);
    for (const trigger of RENDER_TRIGGERS) {
      expect(summary.byTrigger[trigger]).toBe(
        stats.reduce((total, stat) => total + stat.triggers[trigger], 0),
      );
    }
  });

  it('reaches the same answer from raw events as from statistics', () => {
    const events = mixedCapture();

    expect(summarizeRenderTriggers(events)).toStrictEqual(
      summarizeRenderTriggers(aggregateRenders(events)),
    );
  });

  it('calls out the two special buckets and keeps them disjoint', () => {
    const summary = summarizeRenderTriggers(mixedCapture());

    expect(summary.unchangedRenderCount).toBe(summary.byTrigger[UNCHANGED_TRIGGER]);
    expect(summary.unknownTriggerCount).toBe(summary.byTrigger[UNKNOWN_TRIGGER]);
    expect(summary.unchangedRenderCount).toBe(2);
    expect(summary.unknownTriggerCount).toBe(1);
    expect(summary.unchangedRenderCount + summary.unknownTriggerCount).toBeLessThanOrEqual(
      summary.renderCount,
    );
    expect(summary.renderCount).toBe(5);
    expect(summary.componentCount).toBe(3);
  });

  it('answers an empty capture with zeros over a zero-filled histogram', () => {
    const summary = summarizeRenderTriggers([]);

    expect(summary.renderCount).toBe(0);
    expect(summary.unchangedRenderCount).toBe(0);
    expect(summary.unknownTriggerCount).toBe(0);
    expect(summary.componentCount).toBe(0);
    expect(Object.keys(summary.byTrigger).sort()).toStrictEqual([...RENDER_TRIGGERS].sort());
    for (const trigger of RENDER_TRIGGERS) {
      expect(summary.byTrigger[trigger]).toBe(0);
    }
  });

  it('is unaffected by whether occurrences were requested', () => {
    const events = mixedCapture();

    expect(
      summarizeRenderTriggers(aggregateRenders(events, { includeOccurrences: false })),
    ).toStrictEqual(summarizeRenderTriggers(aggregateRenders(events)));
  });
});

/*
 * ---------------------------------------------------------------------------
 * Changed props: key names, and nothing else
 *
 * AAP 0.5.2: a prop VALUE never travels. The producer's diff carries a bounded,
 * scrubbed preview so a panel can say that a callback prop changed identity;
 * this module copies the NAME and leaves the preview where it found it.
 * ---------------------------------------------------------------------------
 */

/** A zero-padded prop name, so a sorted expectation is readable. */
function propKey(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(2, '0')}`;
}

/** `count` prop names from `prefix`, starting at `from`. */
function propKeys(prefix: string, from: number, count: number): readonly string[] {
  return Array.from({ length: count }, (_unused, index) => propKey(prefix, from + index));
}

/** One way a changed-prop attribute can fail to name anything. */
interface MalformedChangedPropsCase {
  readonly label: string;
  readonly changedProps: unknown;
}

/** Values that name no prop and must therefore report none. */
const MALFORMED_CHANGED_PROPS_CASES: readonly MalformedChangedPropsCase[] = [
  { label: 'a string instead of a list', changedProps: 'alpha' },
  { label: 'a number', changedProps: 7 },
  { label: 'an object', changedProps: { alpha: true } },
  { label: 'an empty list', changedProps: [] },
  { label: 'a list of numbers', changedProps: [1, 2] },
  { label: 'a list holding null', changedProps: [null] },
  { label: 'entries with no key field', changedProps: [{ previous: undefined }] },
  { label: 'entries whose key is empty', changedProps: [{ key: '' }] },
];

describe('changed props', () => {
  it('accepts plain names and diff entries, and reports the same sorted keys', () => {
    const entries: readonly ChangedPropEntry[] = [
      { key: 'beta', next: { type: STRING_VALUE_TYPE, preview: 'second', truncated: false } },
      { key: 'alpha' },
    ];
    const events = [
      makeRenderEvent({
        at: 1,
        attributes: renderAttributes({
          component: DEFAULT_COMPONENT,
          trigger: PROPS_TRIGGER,
          changedProps: ['beta', 'alpha'],
        }),
      }),
      makeRenderEvent({
        at: 2,
        attributes: renderAttributes({
          component: OTHER_COMPONENT,
          trigger: PROPS_TRIGGER,
          changedProps: entries,
        }),
      }),
    ];

    const stats = aggregateRenders(events);
    const fromNames = statFor(stats, DEFAULT_COMPONENT);
    const fromEntries = statFor(stats, OTHER_COMPONENT);

    expect(fromNames.changedPropKeys).toStrictEqual(['alpha', 'beta']);
    expect(fromEntries.changedPropKeys).toStrictEqual(fromNames.changedPropKeys);
    expect(fromEntries.changedPropCounts).toStrictEqual({ alpha: 1, beta: 1 });
  });

  it('carries the key name of a prop whose preview is credential-shaped, and nothing else', () => {
    const preview: AttributeValueSummary = {
      type: STRING_VALUE_TYPE,
      preview: CREDENTIAL_SHAPED_PREVIEW,
      truncated: false,
    };
    const entry: ChangedPropEntry = { key: 'alpha', previous: preview, next: preview };

    const stat = onlyStat(
      aggregateRenders([
        makeRenderEvent({
          at: 1,
          attributes: renderAttributes({
            component: DEFAULT_COMPONENT,
            trigger: PROPS_TRIGGER,
            changedProps: [entry],
          }),
        }),
      ]),
    );
    const serialized = JSON.stringify(stat);

    // The name is the evidence a panel needs; the preview is not this module's
    // to copy. `RenderStat` declares no preview field at all, so the correct
    // assertion is total absence rather than containment in one place.
    expect(stat.changedPropKeys).toStrictEqual([entry.key]);
    expect(onlyOccurrence(stat).changedPropKeys).toStrictEqual([entry.key]);
    expect(serialized).toContain(entry.key);
    expect(serialized).not.toContain(CREDENTIAL_SHAPED_PREVIEW);
    expect(serialized).not.toContain(CREDENTIAL_FRAGMENT);
    expect(serialized).not.toContain(preview.type);
  });

  it('counts how many renders each reported key changed at', () => {
    const events = [
      makeRenderEvent({
        at: 1,
        attributes: renderAttributes({
          component: DEFAULT_COMPONENT,
          trigger: PROPS_TRIGGER,
          changedProps: ['alpha', 'beta'],
        }),
      }),
      makeRenderEvent({
        at: 2,
        attributes: renderAttributes({
          component: DEFAULT_COMPONENT,
          trigger: PROPS_TRIGGER,
          changedProps: ['alpha'],
        }),
      }),
      makeRenderEvent({
        at: 3,
        attributes: renderAttributes({
          component: DEFAULT_COMPONENT,
          trigger: PROPS_TRIGGER,
          // A repeated name is one changed prop, not two.
          changedProps: ['alpha', 'alpha'],
        }),
      }),
    ];

    const stat = onlyStat(aggregateRenders(events));

    expect(stat.changedPropKeys).toStrictEqual(['alpha', 'beta']);
    expect(stat.changedPropCounts).toStrictEqual({ alpha: 3, beta: 1 });
    // The two fields report the same keys, so they cannot disagree about which
    // props this row is about.
    expect(Object.keys(stat.changedPropCounts).sort()).toStrictEqual(
      [...stat.changedPropKeys].sort(),
    );
  });

  it('caps the distinct keys of one render at the producer-side bound', () => {
    const stat = onlyStat(
      aggregateRenders([
        makeRenderEvent({
          at: 1,
          attributes: renderAttributes({
            component: DEFAULT_COMPONENT,
            trigger: PROPS_TRIGGER,
            changedProps: propKeys('prop', 0, MAX_TRACKED_KEYS + 8),
          }),
        }),
      ]),
    );

    expect(stat.changedPropKeys).toHaveLength(MAX_TRACKED_KEYS);
    expect(Object.keys(stat.changedPropCounts)).toHaveLength(MAX_TRACKED_KEYS);
  });

  it('caps the distinct keys of a whole capture at the same bound', () => {
    const half = MAX_TRACKED_KEYS / 2;
    const events = [
      makeRenderEvent({
        at: 1,
        attributes: renderAttributes({
          component: DEFAULT_COMPONENT,
          trigger: PROPS_TRIGGER,
          changedProps: propKeys('prop', 0, MAX_TRACKED_KEYS - half),
        }),
      }),
      makeRenderEvent({
        at: 2,
        attributes: renderAttributes({
          component: DEFAULT_COMPONENT,
          trigger: PROPS_TRIGGER,
          changedProps: propKeys('prop', MAX_TRACKED_KEYS - half, MAX_TRACKED_KEYS),
        }),
      }),
    ];

    const stat = onlyStat(aggregateRenders(events));

    expect(stat.changedPropKeys).toHaveLength(MAX_TRACKED_KEYS);
    expect(stat.changedPropKeys).toStrictEqual(propKeys('prop', 0, MAX_TRACKED_KEYS));
    expect(Object.keys(stat.changedPropCounts).sort()).toStrictEqual(
      [...stat.changedPropKeys].sort(),
    );
  });

  it.each(MALFORMED_CHANGED_PROPS_CASES)(
    'reports no changed prop for $label',
    ({ changedProps }: MalformedChangedPropsCase) => {
      const stat = onlyStat(
        aggregateRenders([
          makeRenderEvent({
            at: 1,
            attributes: renderAttributes({
              component: DEFAULT_COMPONENT,
              trigger: PROPS_TRIGGER,
              changedProps,
            }),
          }),
        ]),
      );

      expect(stat.changedPropKeys).toStrictEqual([]);
      expect(stat.changedPropCounts).toStrictEqual({});
      expect(onlyOccurrence(stat).changedPropKeys).toStrictEqual([]);
    },
  );
});

/*
 * ---------------------------------------------------------------------------
 * Occurrences: the expanded render-table row, and its bound
 * ---------------------------------------------------------------------------
 */

/** Fields of an occurrence that are present only when they were recorded. */
const OCCURRENCE_PHASE_FIELD: keyof RenderOccurrence = 'phase';
const OCCURRENCE_PARENT_SPAN_FIELD: keyof RenderOccurrence = 'parentSpanId';
const OCCURRENCE_REPORTED_COUNT_FIELD: keyof RenderOccurrence = 'renderCount';
const OCCURRENCE_SOURCE_FIELD: keyof RenderOccurrence = 'source';

describe('render occurrences', () => {
  /** Five renders of one component, one every ten milliseconds. */
  function fiveRenders(): readonly TelemetryEvent[] {
    return ordinals(5).map((at) =>
      makeRenderEvent({ at, startTime: EPOCH_BASE + at * 10, duration: at }),
    );
  }

  it('lists every render when the bound is not reached', () => {
    const stat = onlyStat(aggregateRenders(fiveRenders()));

    expect(stat.occurrences).toHaveLength(5);
    expect(stat.occurrencesTruncated).toBe(false);
  });

  it('keeps the earliest renders in canonical order when the bound is reached', () => {
    const options: RenderAggregateOptions = { maxOccurrencesPerComponent: 2 };

    const stat = onlyStat(aggregateRenders(reordered(fiveRenders()), options));

    expect(stat.occurrences.map((occurrence) => occurrence.eventId)).toStrictEqual([
      eventIdFor(1),
      eventIdFor(2),
    ]);
    expect(stat.occurrencesTruncated).toBe(true);
    // The counts describe every render, not only the listed ones.
    expect(stat.renderCount).toBe(5);
    expect(stat.totalDurationMs).toBe(15);
  });

  it('breaks a start-time tie by event id, so the kept set is stable', () => {
    const events = ordinals(3).map((at) => makeRenderEvent({ at, startTime: EPOCH_BASE }));

    const stat = onlyStat(aggregateRenders(reordered(events), { maxOccurrencesPerComponent: 2 }));

    expect(stat.occurrences.map((occurrence) => occurrence.eventId)).toStrictEqual([
      eventIdFor(1),
      eventIdFor(2),
    ]);
  });

  it('reports a bound of zero as truncation rather than as "there were none"', () => {
    const stat = onlyStat(aggregateRenders(fiveRenders(), { maxOccurrencesPerComponent: 0 }));

    expect(stat.occurrences).toStrictEqual([]);
    expect(stat.occurrencesTruncated).toBe(true);
    expect(stat.renderCount).toBe(5);
  });

  it('keeps the counts exact when occurrences are switched off', () => {
    const events = fiveRenders();

    const withCounts = onlyStat(aggregateRenders(events, { includeOccurrences: false }));
    const withDetail = onlyStat(aggregateRenders(events));

    expect(withCounts.occurrences).toStrictEqual([]);
    expect(withCounts.occurrencesTruncated).toBe(true);
    expect(withCounts.renderCount).toBe(withDetail.renderCount);
    expect(withCounts.totalDurationMs).toBe(withDetail.totalDurationMs);
    expect(withCounts.triggers).toStrictEqual(withDetail.triggers);
    expect(withCounts.changedPropCounts).toStrictEqual(withDetail.changedPropCounts);
  });

  it('applies the documented default when the caller names no bound', () => {
    const events = fiveRenders();

    expect(aggregateRenders(events)).toStrictEqual(
      aggregateRenders(events, {
        maxOccurrencesPerComponent: DEFAULT_MAX_OCCURRENCES_PER_COMPONENT,
      }),
    );
  });

  it.each([-3, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to the default bound rather than throwing on %s',
    (maxOccurrencesPerComponent: number) => {
      const events = fiveRenders();

      expect(aggregateRenders(events, { maxOccurrencesPerComponent })).toStrictEqual(
        aggregateRenders(events),
      );
    },
  );

  it('preserves every identifier and annotation a render carried', () => {
    const parentSpanId = spanIdFor(99);
    const event = makeRenderEvent({
      at: 1,
      duration: 7.25,
      parentSpanId,
      source: CODE_GRAPH_LOCATION,
      attributes: renderAttributes({
        component: DEFAULT_COMPONENT,
        trigger: STATE_TRIGGER,
        phase: UPDATE_PHASE,
        reportedRenderCount: 12,
        changedProps: ['alpha'],
      }),
    });

    const occurrence = onlyOccurrence(onlyStat(aggregateRenders([event])));

    expect(occurrence).toStrictEqual({
      id: event.id,
      eventId: event.id,
      spanId: event.spanId,
      traceId: event.traceId,
      parentSpanId,
      startTime: event.startTime,
      durationMs: 7.25,
      phase: UPDATE_PHASE,
      trigger: STATE_TRIGGER,
      renderCount: 12,
      changedPropKeys: ['alpha'],
      source: CODE_GRAPH_LOCATION,
    });
  });

  it('omits the fields a render did not record instead of holding undefined', () => {
    const occurrence = onlyOccurrence(onlyStat(aggregateRenders([makeRenderEvent({ at: 1 })])));

    for (const field of [
      OCCURRENCE_PHASE_FIELD,
      OCCURRENCE_PARENT_SPAN_FIELD,
      OCCURRENCE_REPORTED_COUNT_FIELD,
      OCCURRENCE_SOURCE_FIELD,
    ]) {
      expect(Object.hasOwn(occurrence, field)).toBe(false);
    }
    expect(occurrence.trigger).toBe(PROPS_TRIGGER);
  });

  it.each([-2, 1.5, 'many', null])(
    'omits a producer render count that is not a counting number: %s',
    (reportedRenderCount: unknown) => {
      const occurrence = onlyOccurrence(
        onlyStat(
          aggregateRenders([
            makeRenderEvent({
              at: 1,
              attributes: renderAttributes({
                component: DEFAULT_COMPONENT,
                trigger: PROPS_TRIGGER,
                reportedRenderCount,
              }),
            }),
          ]),
        ),
      );

      expect(Object.hasOwn(occurrence, OCCURRENCE_REPORTED_COUNT_FIELD)).toBe(false);
    },
  );
});

/*
 * ---------------------------------------------------------------------------
 * `buildComponentTreeSnapshot`: structure from the last commit, numbers from
 * the whole capture
 * ---------------------------------------------------------------------------
 */

/** A node of a structure a producer serialised into a commit's attributes. */
interface SerializedNode {
  readonly component?: string;
  readonly key?: string;
  readonly children?: readonly unknown[];
}

/** A node that names itself the way a fiber does, under an alternate field. */
interface AlternatelyNamedNode {
  readonly name: string;
  readonly children?: readonly unknown[];
}

/** A structure with a reference back to itself: the one shape a walk cannot survive. */
interface CyclicNode {
  readonly component: string;
  readonly children: unknown[];
}

/** Builds a chain of `depth` nested nodes, innermost named `LeafNode`. */
function nestedNodes(depth: number): SerializedNode {
  let node: SerializedNode = { component: 'LeafNode', children: [] };
  for (let level = depth; level > 0; level -= 1) {
    node = { component: `Level${String(level)}`, children: [node] };
  }
  return node;
}

/** Builds `count` sibling roots, each a leaf. */
function siblingNodes(count: number): readonly SerializedNode[] {
  return Array.from({ length: count }, (_unused, index) => ({
    component: `ItemRow${String(index)}`,
    children: [],
  }));
}

/** A structure that refers to itself. */
function cyclicNode(): CyclicNode {
  const node: CyclicNode = { component: 'ParentView', children: [] };
  node.children.push(node);
  return node;
}

/**
 * A capture with two commits, the earlier one describing a component the later
 * one no longer holds.
 *
 * The shape every last-commit assertion is made against: `ListRow` rendered
 * under both commits, `LegacyPane` only under the first, and only the later
 * commit's structure is the shape the page ended the capture in.
 */
function twoCommitCapture(): {
  readonly events: readonly TelemetryEvent[];
  readonly earlierCommit: TelemetryEvent;
  readonly laterCommit: TelemetryEvent;
} {
  const earlierCommit = makeCommitEvent({
    at: 1,
    serializedTree: [
      {
        component: 'ParentView',
        children: [
          { component: 'ListRow', children: [] },
          { component: 'LegacyPane', children: [] },
        ],
      },
    ],
  });
  const laterCommit = makeCommitEvent({
    at: 4,
    serializedTree: [
      { component: 'ParentView', children: [{ component: 'ListRow', children: [] }] },
    ],
  });
  const events = [
    earlierCommit,
    makeRenderEvent({
      at: 2,
      duration: 2,
      parentSpanId: earlierCommit.spanId,
      attributes: renderAttributes({ component: 'ListRow', trigger: PROPS_TRIGGER }),
    }),
    makeRenderEvent({
      at: 3,
      duration: 4,
      parentSpanId: earlierCommit.spanId,
      attributes: renderAttributes({ component: 'LegacyPane', trigger: UNCHANGED_TRIGGER }),
    }),
    laterCommit,
    makeRenderEvent({
      at: 5,
      duration: 1.5,
      parentSpanId: laterCommit.spanId,
      attributes: renderAttributes({ component: 'ListRow', trigger: CONTEXT_TRIGGER }),
    }),
  ];
  return { events, earlierCommit, laterCommit };
}

/**
 * A capture the page agent would produce: renders, the commit they happened
 * under, and the snapshot event taken as the capture stopped.
 *
 * `ListRow` rendered twice and `ParentView` once; `Sleeper` is in the
 * structure and rendered not at all.
 */
function agentSnapshotCapture(): {
  readonly events: readonly TelemetryEvent[];
  readonly commit: TelemetryEvent;
  readonly snapshot: TelemetryEvent;
} {
  const commit = makeCommitEvent({ at: 1 });
  const snapshot = makeSnapshotEvent({ at: 5, tree: JSON.stringify(agentShapedTree()) });
  const events = [
    commit,
    makeRenderEvent({
      at: 2,
      duration: 2,
      parentSpanId: commit.spanId,
      attributes: renderAttributes({ component: 'ListRow', trigger: PROPS_TRIGGER }),
    }),
    makeRenderEvent({
      at: 3,
      duration: 1,
      parentSpanId: commit.spanId,
      attributes: renderAttributes({ component: 'ListRow', trigger: CONTEXT_TRIGGER }),
    }),
    makeRenderEvent({
      at: 4,
      duration: 4,
      parentSpanId: commit.spanId,
      attributes: renderAttributes({ component: 'ParentView', trigger: STATE_TRIGGER }),
    }),
    snapshot,
  ];
  return { events, commit, snapshot };
}

describe('buildComponentTreeSnapshot', () => {
  describe("the producer's snapshot event", () => {
    it('builds the structure from the snapshot event the agent emits', () => {
      const { events, commit, snapshot } = agentSnapshotCapture();

      const built = requireSnapshot(buildComponentTreeSnapshot(reordered(events)));

      expect(built.origin).toBe(COMMIT_SNAPSHOT_ORIGIN);
      // The snapshot is taken as the capture stops, so it dates the structure;
      // the commit is what the structure belongs to, so it identifies it.
      expect(built.capturedAt).toBe(snapshot.startTime);
      expect(built.commitEventId).toBe(commit.id);
      expect(built.commitSpanId).toBe(commit.spanId);
      expect(built.traceId).toBe(commit.traceId);
      expect(built.degraded).toBe(false);
      expect(built.truncated).toBe(false);
      expect(allNodes(built).map((node) => node.component)).toStrictEqual([
        'ParentView',
        'ListRow',
        'Sleeper',
      ]);
      expect(nodeFor(built, 'ListRow').key).toBe('row-1');
      expect(built.nodeCount).toBe(3);
      expect(built.maxDepth).toBe(1);
    });

    it('annotates the producer structure with counts from the whole capture', () => {
      const { events } = agentSnapshotCapture();

      const built = requireSnapshot(buildComponentTreeSnapshot(events));
      const stats = aggregateRenders(events);

      expect(nodeFor(built, 'ListRow').renderCount).toBe(statFor(stats, 'ListRow').renderCount);
      expect(nodeFor(built, 'ListRow').renderCount).toBe(2);
      expect(nodeFor(built, 'ListRow').totalDurationMs).toBe(3);
      expect(nodeFor(built, 'ParentView').renderCount).toBe(1);
      // In the structure and never rendered: the count is this module's, not
      // the producer's, so it is zero rather than whatever the document said.
      expect(nodeFor(built, 'Sleeper').renderCount).toBe(0);
      expect(summarizeRenderTriggers(stats).renderCount).toBe(3);
    });

    it('takes the latest snapshot event whatever order the events arrived in', () => {
      const earlier = makeSnapshotEvent({
        at: 1,
        tree: JSON.stringify({ name: 'EarlierRoot', renderCount: 0, children: [] }),
      });
      const later = makeSnapshotEvent({
        at: 2,
        tree: JSON.stringify({ name: 'LaterRoot', renderCount: 0, children: [] }),
      });
      const events = [earlier, later, makeRenderEvent({ at: 3 })];

      for (const order of [events, [...events].reverse(), reordered(events)]) {
        const built = requireSnapshot(buildComponentTreeSnapshot(order));

        expect(built.roots.map((node) => node.component)).toStrictEqual(['LaterRoot']);
        expect(built.capturedAt).toBe(later.startTime);
      }
    });

    it('breaks a start-time tie between snapshot events by ingest sequence', () => {
      const sharedStart = EPOCH_BASE + 9;
      const events = [
        makeSnapshotEvent({
          at: 1,
          startTime: sharedStart,
          ingestSeq: 1,
          tree: JSON.stringify({ name: 'FirstArrival', renderCount: 0, children: [] }),
        }),
        makeSnapshotEvent({
          at: 2,
          startTime: sharedStart,
          ingestSeq: 2,
          tree: JSON.stringify({ name: 'SecondArrival', renderCount: 0, children: [] }),
        }),
        makeRenderEvent({ at: 3 }),
      ];

      const built = requireSnapshot(buildComponentTreeSnapshot(reordered(events)));

      expect(built.roots.map((node) => node.component)).toStrictEqual(['SecondArrival']);
    });

    it('presents a tree the producer reduced as reduced', () => {
      const events = [
        makeSnapshotEvent({ at: 1, tree: JSON.stringify(agentShapedTree()), reduced: true }),
        makeCommitEvent({ at: 2 }),
        makeRenderEvent({ at: 3, parentSpanId: spanIdFor(2) }),
      ];

      const built = requireSnapshot(buildComponentTreeSnapshot(events));

      // The producer fell back to a smaller bound than it was asked for, so
      // nodes are missing from the document itself: a consumer must caveat the
      // tree rather than present it as the page's whole structure.
      expect(built.origin).toBe(COMMIT_SNAPSHOT_ORIGIN);
      expect(built.truncated).toBe(true);
      expect(built.degraded).toBe(true);
      expect(built.nodeCount).toBe(3);
    });

    it('prefers the snapshot event to a structure attached to the commit', () => {
      const commit = makeCommitEvent({
        at: 1,
        serializedTree: [{ component: 'FromCommit', children: [] }],
      });
      const events = [
        commit,
        makeRenderEvent({ at: 2, parentSpanId: commit.spanId }),
        makeSnapshotEvent({ at: 3, tree: JSON.stringify(agentShapedTree()) }),
      ];

      const built = requireSnapshot(buildComponentTreeSnapshot(events));

      // Both are the producer's own structure, but only the snapshot is taken
      // at capture stop with the whole retained root still reachable.
      expect(nodesFor(built, 'FromCommit')).toStrictEqual([]);
      expect(nodesFor(built, 'Sleeper')).toHaveLength(1);
    });

    it('falls back to the commit structure when the snapshot document is unreadable', () => {
      const commit = makeCommitEvent({
        at: 1,
        serializedTree: [{ component: 'FromCommit', children: [] }],
      });
      const events = [
        commit,
        makeRenderEvent({ at: 2, parentSpanId: commit.spanId }),
        makeSnapshotEvent({ at: 3, tree: 'a structure, honestly' }),
      ];

      const built = requireSnapshot(buildComponentTreeSnapshot(events));

      expect(built.origin).toBe(COMMIT_SNAPSHOT_ORIGIN);
      expect(built.roots.map((node) => node.component)).toStrictEqual(['FromCommit']);
      expect(built.capturedAt).toBe(commit.startTime);
    });

    it('ignores an event of another kind carrying the snapshot name and keys', () => {
      // The kind is part of the contract: the snapshot travels as the kind the
      // catalog declares the tree keys under, and nothing else may claim it.
      const events = [
        makeSnapshotEvent({
          at: 1,
          kind: UNRELATED_KIND,
          tree: JSON.stringify({ name: 'Impostor', renderCount: 0, children: [] }),
        }),
        makeCommitEvent({ at: 2 }),
        makeRenderEvent({ at: 3, parentSpanId: spanIdFor(2) }),
      ];

      const built = requireSnapshot(buildComponentTreeSnapshot(events));

      expect(nodesFor(built, 'Impostor')).toStrictEqual([]);
      expect(built.origin).toBe(FLAT_ORIGIN);
    });

    it('answers a capture holding only a snapshot event, caveated', () => {
      const events = [makeSnapshotEvent({ at: 1, tree: JSON.stringify(agentShapedTree()) })];

      const built = requireSnapshot(buildComponentTreeSnapshot(events));

      // A snapshot IS evidence, so the structure is reported — with no commit
      // to anchor it and no render to count, which is what `degraded` says.
      expect(built.origin).toBe(COMMIT_SNAPSHOT_ORIGIN);
      expect(built.nodeCount).toBe(3);
      expect(built.degraded).toBe(true);
      expect(Object.hasOwn(built, 'commitEventId')).toBe(false);
      expect(allNodes(built).every((node) => node.renderCount === 0)).toBe(true);
    });

    it('ignores a snapshot event with no tree attribute at all', () => {
      const events = [
        makeSnapshotEvent({ at: 1 }),
        makeCommitEvent({ at: 2 }),
        makeRenderEvent({ at: 3, parentSpanId: spanIdFor(2) }),
      ];

      const built = requireSnapshot(buildComponentTreeSnapshot(events));

      expect(built.origin).toBe(FLAT_ORIGIN);
      expect(built.roots.map((node) => node.component)).toStrictEqual([DEFAULT_COMPONENT]);
    });
  });

  describe('the last commit of the capture', () => {
    it('builds the structure from the later commit and identifies it', () => {
      const { events, laterCommit } = twoCommitCapture();

      const snapshot = requireSnapshot(buildComponentTreeSnapshot(reordered(events)));

      expect(snapshot.commitEventId).toBe(laterCommit.id);
      expect(snapshot.commitSpanId).toBe(laterCommit.spanId);
      expect(snapshot.capturedAt).toBe(laterCommit.startTime);
      expect(snapshot.traceId).toBe(laterCommit.traceId);
      expect(snapshot.origin).toBe(COMMIT_SNAPSHOT_ORIGIN);
      expect(snapshot.degraded).toBe(false);
    });

    it('leaves out a component only the earlier structure held, and still counts it', () => {
      const { events } = twoCommitCapture();

      const snapshot = requireSnapshot(buildComponentTreeSnapshot(events));
      const stats = aggregateRenders(events);

      // The page no longer holds it, so it is not part of the structure...
      expect(nodesFor(snapshot, 'LegacyPane')).toStrictEqual([]);
      // ...but its render is evidence, and the cumulative totals keep it.
      expect(statFor(stats, 'LegacyPane').renderCount).toBe(1);
      expect(summarizeRenderTriggers(stats).renderCount).toBe(3);
    });

    it('breaks a start-time tie between commits by ingest sequence', () => {
      const sharedStart = EPOCH_BASE + 5;
      const events = [
        makeCommitEvent({
          at: 1,
          startTime: sharedStart,
          ingestSeq: 1,
          serializedTree: [{ component: 'SidePane', children: [] }],
        }),
        makeCommitEvent({
          at: 2,
          startTime: sharedStart,
          ingestSeq: 2,
          serializedTree: [{ component: 'ContentArea', children: [] }],
        }),
        makeRenderEvent({ at: 3 }),
      ];

      const snapshot = requireSnapshot(buildComponentTreeSnapshot(reordered(events)));

      expect(snapshot.commitEventId).toBe(eventIdFor(2));
      expect(nodesFor(snapshot, 'ContentArea')).toHaveLength(1);
      expect(nodesFor(snapshot, 'SidePane')).toStrictEqual([]);
    });
  });

  describe('per-node annotation', () => {
    it('reports counts cumulative over the capture, not over the last commit', () => {
      const { events } = twoCommitCapture();

      const snapshot = requireSnapshot(buildComponentTreeSnapshot(events));
      const listRow = nodeFor(snapshot, 'ListRow');
      const stat = statFor(aggregateRenders(events), 'ListRow');

      // Two renders, one under each commit: the node and the render-table row
      // are annotated from the same accumulation pass and cannot disagree.
      expect(listRow.renderCount).toBe(2);
      expect(listRow.totalDurationMs).toBe(3.5);
      expect(listRow.renderCount).toBe(stat.renderCount);
      expect(listRow.totalDurationMs).toBe(stat.totalDurationMs);
      // The latest render in canonical order owns the trigger.
      expect(listRow.lastTrigger).toBe(CONTEXT_TRIGGER);
    });

    it('reports zeroes for a structural node that never rendered itself', () => {
      const { events } = twoCommitCapture();

      const parent = nodeFor(requireSnapshot(buildComponentTreeSnapshot(events)), 'ParentView');

      expect(parent.renderCount).toBe(0);
      expect(parent.totalDurationMs).toBe(0);
      expect(Object.hasOwn(parent, 'lastTrigger')).toBe(false);
      expect(parent.depth).toBe(0);
    });

    it('carries the component location a resolver supplied', () => {
      const commit = makeCommitEvent({
        at: 1,
        serializedTree: [{ component: DEFAULT_COMPONENT, children: [] }],
      });
      const events = [
        commit,
        makeRenderEvent({ at: 2, parentSpanId: commit.spanId, source: CODE_GRAPH_LOCATION }),
      ];

      const node = nodeFor(requireSnapshot(buildComponentTreeSnapshot(events)), DEFAULT_COMPONENT);

      expect(node.source).toStrictEqual(CODE_GRAPH_LOCATION);
    });

    it('identifies nodes by their root-first path, encoded and ordinal-suffixed', () => {
      const commit = makeCommitEvent({
        at: 1,
        serializedTree: [
          {
            component: 'Parent View',
            children: [
              { component: 'ItemRow', key: 'k1', children: [] },
              { component: 'ItemRow', children: [] },
              { component: 'ItemRow', children: [] },
            ],
          },
        ],
      });

      const snapshot = requireSnapshot(
        buildComponentTreeSnapshot([commit, makeRenderEvent({ at: 2 })]),
      );
      const rootPath = `${COMPONENT_TREE_NODE_ID_PREFIX}${encodeURIComponent('Parent View')}`;

      expect(allNodes(snapshot).map((node) => node.id)).toStrictEqual([
        rootPath,
        `${rootPath}/ItemRow[k1]`,
        `${rootPath}/ItemRow`,
        // Two keyless siblings of one component are told apart by an ordinal
        // rather than by identity the page never had.
        `${rootPath}/ItemRow#2`,
      ]);
    });
  });

  describe('construction routes', () => {
    it('uses the commit structure when the commit carries one', () => {
      const { events } = twoCommitCapture();

      const snapshot = requireSnapshot(buildComponentTreeSnapshot(events));

      expect(snapshot.origin).toBe(COMMIT_SNAPSHOT_ORIGIN);
      expect(snapshot.nodeCount).toBe(2);
      expect(snapshot.maxDepth).toBe(1);
      expect(snapshot.truncated).toBe(false);
    });

    it('discovers a structure under a key the catalog declares for no kind', () => {
      // The bag is open so a new signal can ship without a schema change, so
      // every undeclared attribute is offered to the structural parser once the
      // catalogued key has been tried and found absent.
      const commit = makeCommitEvent({
        at: 1,
        attributes: {
          ...commitAttributes(),
          [UNDECLARED_TREE_KEY]: [{ component: 'FromScan', children: [] }],
        },
      });

      const snapshot = requireSnapshot(
        buildComponentTreeSnapshot([commit, makeRenderEvent({ at: 2 })]),
      );

      expect(snapshot.origin).toBe(COMMIT_SNAPSHOT_ORIGIN);
      expect(snapshot.roots.map((node) => node.component)).toStrictEqual(['FromScan']);
    });

    it('accepts a structure serialised as JSON text and an alternate name field', () => {
      const alternately: AlternatelyNamedNode = { name: 'LeafNode', children: [] };
      const commit = makeCommitEvent({
        at: 1,
        serializedTree: JSON.stringify([{ component: ROOT_NAME, children: [alternately] }]),
      });

      const snapshot = requireSnapshot(
        buildComponentTreeSnapshot([commit, makeRenderEvent({ at: 2 })]),
      );

      expect(snapshot.origin).toBe(COMMIT_SNAPSHOT_ORIGIN);
      expect(allNodes(snapshot).map((node) => node.component)).toStrictEqual([
        ROOT_NAME,
        alternately.name,
      ]);
    });

    it('reconstructs from owner chains when the commit carries no structure', () => {
      const commit = makeCommitEvent({ at: 1 });
      const events = [
        commit,
        makeRenderEvent({
          at: 2,
          parentSpanId: commit.spanId,
          attributes: renderAttributes({
            component: 'ListRow',
            trigger: PROPS_TRIGGER,
            // Nearest first, which is the producer's convention for a chain.
            ownerChain: ['PanelBody', 'ParentView'],
          }),
        }),
        makeRenderEvent({
          at: 3,
          parentSpanId: commit.spanId,
          attributes: renderAttributes({
            component: 'PanelBody',
            trigger: STATE_TRIGGER,
            ownerChain: ['ParentView'],
          }),
        }),
      ];

      const snapshot = requireSnapshot(buildComponentTreeSnapshot(reordered(events)));

      expect(snapshot.origin).toBe(OWNER_CHAINS_ORIGIN);
      // Every render of an exactly matched commit carried a whole chain, so the
      // reconstruction is complete and needs no caveat.
      expect(snapshot.degraded).toBe(false);
      expect(snapshot.nodeCount).toBe(3);
      expect(snapshot.maxDepth).toBe(2);
      expect(allNodes(snapshot).map((node) => node.id)).toStrictEqual([
        `${COMPONENT_TREE_NODE_ID_PREFIX}ParentView`,
        `${COMPONENT_TREE_NODE_ID_PREFIX}ParentView/PanelBody`,
        `${COMPONENT_TREE_NODE_ID_PREFIX}ParentView/PanelBody/ListRow`,
      ]);
    });

    it('caveats a reconstruction in which a render carried no chain', () => {
      const commit = makeCommitEvent({ at: 1 });
      const events = [
        commit,
        makeRenderEvent({
          at: 2,
          parentSpanId: commit.spanId,
          attributes: renderAttributes({
            component: 'ListRow',
            trigger: PROPS_TRIGGER,
            ownerChain: ['ParentView'],
          }),
        }),
        makeRenderEvent({ at: 3, parentSpanId: commit.spanId }),
      ];

      const snapshot = requireSnapshot(buildComponentTreeSnapshot(events));

      expect(snapshot.origin).toBe(OWNER_CHAINS_ORIGIN);
      expect(snapshot.degraded).toBe(true);
      expect(snapshot.truncated).toBe(false);
    });

    it('caveats a reconstruction with no commit to anchor it', () => {
      const events = [
        makeRenderEvent({
          at: 1,
          attributes: renderAttributes({
            component: 'ListRow',
            trigger: PROPS_TRIGGER,
            ownerChain: ['ParentView'],
          }),
        }),
      ];

      const snapshot = requireSnapshot(buildComponentTreeSnapshot(events));

      expect(snapshot.origin).toBe(OWNER_CHAINS_ORIGIN);
      expect(snapshot.degraded).toBe(true);
      expect(Object.hasOwn(snapshot, 'commitEventId')).toBe(false);
      expect(Object.hasOwn(snapshot, 'commitSpanId')).toBe(false);
      expect(Object.hasOwn(snapshot, 'traceId')).toBe(false);
      // With no commit to date the structure, the latest render dates it.
      expect(snapshot.capturedAt).toBe(EPOCH_BASE + 1);
    });

    it('associates renders with a commit by its time window when no span links them', () => {
      const commit = makeCommitEvent({ at: 1, startTime: EPOCH_BASE + 10, duration: 5 });
      const events = [
        commit,
        makeRenderEvent({
          at: 2,
          startTime: EPOCH_BASE + 11,
          attributes: renderAttributes({
            component: 'ListRow',
            trigger: PROPS_TRIGGER,
            ownerChain: ['ParentView'],
          }),
        }),
      ];

      const snapshot = requireSnapshot(buildComponentTreeSnapshot(events));

      expect(snapshot.origin).toBe(OWNER_CHAINS_ORIGIN);
      // A window match is an association, not the span relationship, so the
      // result says so rather than presenting a guess as the page's structure.
      expect(snapshot.degraded).toBe(true);
      expect(nodesFor(snapshot, 'ListRow')).toHaveLength(1);
    });

    it('lists the observed components flat, busiest first, when nothing else is available', () => {
      const commit = makeCommitEvent({ at: 1 });
      const events = [
        commit,
        makeRenderEvent({ at: 2, parentSpanId: commit.spanId }),
        makeRenderEvent({ at: 3, parentSpanId: commit.spanId }),
        makeRenderEvent({
          at: 4,
          parentSpanId: commit.spanId,
          attributes: renderAttributes({ component: OTHER_COMPONENT, trigger: PROPS_TRIGGER }),
        }),
      ];

      const snapshot = requireSnapshot(buildComponentTreeSnapshot(events));

      expect(snapshot.origin).toBe(FLAT_ORIGIN);
      // A flat listing is always caveated: it is not a structure.
      expect(snapshot.degraded).toBe(true);
      expect(snapshot.maxDepth).toBe(0);
      expect(snapshot.roots.map((node) => node.component)).toStrictEqual([
        DEFAULT_COMPONENT,
        OTHER_COMPONENT,
      ]);
      expect(snapshot.roots.every((node) => node.children.length === 0)).toBe(true);
    });

    it('produces every origin of the vocabulary across the three routes', () => {
      const commit = makeCommitEvent({ at: 1 });
      const observed: readonly ComponentTreeOrigin[] = [
        requireSnapshot(buildComponentTreeSnapshot(twoCommitCapture().events)).origin,
        requireSnapshot(
          buildComponentTreeSnapshot([
            commit,
            makeRenderEvent({
              at: 2,
              parentSpanId: commit.spanId,
              attributes: renderAttributes({
                component: 'ListRow',
                trigger: PROPS_TRIGGER,
                ownerChain: ['ParentView'],
              }),
            }),
          ]),
        ).origin,
        requireSnapshot(
          buildComponentTreeSnapshot([
            commit,
            makeRenderEvent({ at: 2, parentSpanId: commit.spanId }),
          ]),
        ).origin,
      ];

      expect(new Set(observed)).toStrictEqual(new Set(COMPONENT_TREE_ORIGINS));
    });
  });

  describe('truncation inside the producer document', () => {
    /**
     * The document a producer whose own walk hit a bound posts: the node where
     * it stopped carries the marker, and nothing else about the node says so —
     * an empty `children` list is what a leaf and a cut branch both look like.
     */
    function boundedTree(): Record<string, unknown> {
      return {
        name: 'ParentView',
        renderCount: 1,
        children: [
          { name: 'ListRow', renderCount: 2, children: [] },
          { name: 'DeepBranch', renderCount: 0, truncated: true, children: [] },
        ],
      };
    }

    it('reports a node-level truncation marker as a truncated, degraded tree', () => {
      const commit = makeCommitEvent({ at: 1 });
      const snapshot = makeSnapshotEvent({ at: 2, tree: JSON.stringify(boundedTree()) });

      const built = requireSnapshot(buildComponentTreeSnapshot([commit, snapshot]));

      expect(built.origin).toBe(COMMIT_SNAPSHOT_ORIGIN);
      expect(built.truncated).toBe(true);
      // Descendants are missing, so the structure is not the page's: a
      // consumer must caveat it rather than present it as complete.
      expect(built.degraded).toBe(true);
      expect(allNodes(built).map((node) => node.component)).toStrictEqual([
        'ParentView',
        'ListRow',
        'DeepBranch',
      ]);
    });

    it('keeps the marker through the redaction boundary', () => {
      const commit = makeCommitEvent({ at: 1 });
      const snapshot = redactEvent(
        makeSnapshotEvent({ at: 2, tree: JSON.stringify(boundedTree()) }),
      );

      const built = requireSnapshot(buildComponentTreeSnapshot([commit, snapshot]));

      expect(built.truncated).toBe(true);
      expect(built.degraded).toBe(true);
      expect(nodeFor(built, 'DeepBranch').component).toBe('DeepBranch');
    });

    it('discloses a child the reader could not use', () => {
      const commit = makeCommitEvent({ at: 1 });
      const snapshot = makeSnapshotEvent({
        at: 2,
        tree: JSON.stringify({
          name: 'ParentView',
          children: [{ name: 'ListRow', children: [] }, 'not-a-node'],
        }),
      });

      const built = requireSnapshot(buildComponentTreeSnapshot([commit, snapshot]));

      expect(allNodes(built).map((node) => node.component)).toStrictEqual([
        'ParentView',
        'ListRow',
      ]);
      expect(built.truncated).toBe(true);
      expect(built.degraded).toBe(true);
    });

    it('leaves a document with no omissions undegraded', () => {
      const { events } = agentSnapshotCapture();

      const built = requireSnapshot(buildComponentTreeSnapshot(events));

      expect(built.truncated).toBe(false);
      expect(built.degraded).toBe(false);
    });
  });

  describe('a snapshot taken before the last commit', () => {
    /**
     * The capture the service's mid-capture snapshot request produces: a
     * document at one instant, and a commit after it with no further snapshot.
     * The page committed again, so what the document shows is a shape the page
     * has since left.
     */
    function staleSnapshotCapture(): {
      readonly events: readonly TelemetryEvent[];
      readonly commit: TelemetryEvent;
      readonly snapshot: TelemetryEvent;
    } {
      const snapshot = makeSnapshotEvent({ at: 2, tree: JSON.stringify(agentShapedTree()) });
      const commit = makeCommitEvent({ at: 6 });
      const events = [
        snapshot,
        commit,
        makeRenderEvent({
          at: 7,
          parentSpanId: commit.spanId,
          attributes: renderAttributes({ component: 'ListRow', trigger: PROPS_TRIGGER }),
        }),
      ];
      return { events, commit, snapshot };
    }

    it('reports the structure without attributing it to the later commit', () => {
      const { events, commit, snapshot } = staleSnapshotCapture();

      const built = requireSnapshot(buildComponentTreeSnapshot(reordered(events)));

      expect(built.origin).toBe(COMMIT_SNAPSHOT_ORIGIN);
      expect(built.capturedAt).toBe(snapshot.startTime);
      // The three commit fields would claim this is that commit's structure.
      expect(built.commitEventId).toBeUndefined();
      expect(built.commitSpanId).toBeUndefined();
      expect(built.traceId).toBeUndefined();
      expect(built.commitEventId).not.toBe(commit.id);
      expect(built.degraded).toBe(true);
      // The document itself is intact; it is its currency that is in doubt.
      expect(allNodes(built).map((node) => node.component)).toStrictEqual([
        'ParentView',
        'ListRow',
        'Sleeper',
      ]);
    });

    it('prefers a snapshot taken at or after the last commit', () => {
      const { events, commit } = staleSnapshotCapture();
      const current = makeSnapshotEvent({
        at: 9,
        tree: JSON.stringify({ name: 'ParentView', renderCount: 1, children: [] }),
      });

      const built = requireSnapshot(buildComponentTreeSnapshot(reordered([...events, current])));

      expect(built.capturedAt).toBe(current.startTime);
      expect(built.commitEventId).toBe(commit.id);
      expect(built.degraded).toBe(false);
      expect(allNodes(built).map((node) => node.component)).toStrictEqual(['ParentView']);
    });

    it('prefers a document the last commit carries itself', () => {
      const { events, commit } = staleSnapshotCapture();
      const commitWithTree = makeCommitEvent({
        at: 6,
        attributes: {
          ...commitAttributes(),
          [SERIALIZED_TREE_KEY]: JSON.stringify({
            name: 'ParentView',
            children: [{ name: 'Replacement', children: [] }],
          }),
        },
      });
      const withEmbedded = events.map((event) => (event.id === commit.id ? commitWithTree : event));

      const built = requireSnapshot(buildComponentTreeSnapshot(reordered(withEmbedded)));

      expect(built.commitEventId).toBe(commitWithTree.id);
      expect(built.degraded).toBe(false);
      expect(allNodes(built).map((node) => node.component)).toStrictEqual([
        'ParentView',
        'Replacement',
      ]);
    });

    it('beats a reconstruction from owner chains', () => {
      const { events } = staleSnapshotCapture();

      const built = requireSnapshot(buildComponentTreeSnapshot(events));

      expect(built.origin).toBe(COMMIT_SNAPSHOT_ORIGIN);
      // The reconstruction would have known only the component that rendered.
      expect(nodeFor(built, 'Sleeper').renderCount).toBe(0);
    });

    it('treats every snapshot as current when the capture holds no commit', () => {
      const snapshot = makeSnapshotEvent({ at: 2, tree: JSON.stringify(agentShapedTree()) });

      const built = requireSnapshot(buildComponentTreeSnapshot([snapshot]));

      expect(built.origin).toBe(COMMIT_SNAPSHOT_ORIGIN);
      expect(built.capturedAt).toBe(snapshot.startTime);
      // Degraded because no commit anchors it, not because it is stale.
      expect(built.degraded).toBe(true);
      expect(built.truncated).toBe(false);
    });
  });
});

/*
 * ---------------------------------------------------------------------------
 * Tree bounds, hostile structures and the empty answer
 *
 * A snapshot travels as JSON inside the capture summary and from there into a
 * prompt payload, so both bounds are part of the contract rather than tuning:
 * every result says whether it hit one, and no input — however hostile — may
 * turn a panel-data request into a thrown error.
 * ---------------------------------------------------------------------------
 */

/** One structure no producer would send. */
interface HostileTreeCase {
  readonly label: string;
  readonly serializedTree: unknown;
}

/** Fields a component-tree node may carry, and no others. */
const TREE_NODE_FIELDS: readonly (keyof ComponentTreeNode)[] = [
  'id',
  'component',
  'key',
  'depth',
  'renderCount',
  'totalDurationMs',
  'lastTrigger',
  'source',
  'children',
];

/**
 * The field a node must never carry.
 *
 * `ComponentTreeNode` knows its children and its depth, never its parent — a
 * cycle cannot be serialised, and a consumer that walks down never needs to
 * walk up. Written as a plain string because the shape deliberately has no such
 * field to key off.
 */
const PARENT_BACK_REFERENCE_FIELD = 'parent';

/** Structures that must degrade rather than throw. */
const HOSTILE_TREE_CASES: readonly HostileTreeCase[] = [
  { label: 'a number', serializedTree: 42 },
  { label: 'a boolean', serializedTree: true },
  { label: 'text that is not JSON', serializedTree: 'a structure, honestly' },
  { label: 'JSON text holding a scalar', serializedTree: '42' },
  { label: 'an empty list', serializedTree: [] },
  { label: 'a list of scalars', serializedTree: [1, 'two', null] },
  { label: 'a node with no usable name', serializedTree: [{ children: [] }] },
  { label: 'a structure that refers to itself', serializedTree: cyclicNode() },
  {
    label: 'a structure nested far past the depth bound',
    serializedTree: nestedNodes(DEFAULT_COMPONENT_TREE_MAX_DEPTH * 3),
  },
  {
    label: 'text larger than the parser will read',
    serializedTree: JSON.stringify([
      { component: ROOT_NAME, children: [], pad: 'x'.repeat(600_000) },
    ]),
  },
];

describe('component tree bounds', () => {
  /** A capture whose commit carries a three-level structure. */
  function nestedCapture(depth: number): readonly TelemetryEvent[] {
    const commit = makeCommitEvent({ at: 1, serializedTree: nestedNodes(depth) });
    return [commit, makeRenderEvent({ at: 2, parentSpanId: commit.spanId })];
  }

  it('clips the tree at the node bound and says so', () => {
    const snapshot = requireSnapshot(buildComponentTreeSnapshot(nestedCapture(2), { maxNodes: 2 }));

    expect(snapshot.nodeCount).toBe(2);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.degraded).toBe(true);
  });

  it('clips the tree at the depth bound and says so', () => {
    const snapshot = requireSnapshot(buildComponentTreeSnapshot(nestedCapture(3), { maxDepth: 0 }));

    expect(snapshot.roots).toHaveLength(1);
    expect(snapshot.nodeCount).toBe(1);
    expect(snapshot.maxDepth).toBe(0);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.degraded).toBe(true);
  });

  it('describes what it actually emitted rather than what it was asked for', () => {
    const snapshot = requireSnapshot(
      buildComponentTreeSnapshot(nestedCapture(4), { maxNodes: 3, maxDepth: 2 }),
    );
    const nodes = allNodes(snapshot);

    expect(snapshot.nodeCount).toBe(nodes.length);
    expect(snapshot.maxDepth).toBe(Math.max(...nodes.map((node) => node.depth)));
    expect(snapshot.nodeCount).toBeLessThanOrEqual(3);
    expect(snapshot.maxDepth).toBeLessThanOrEqual(2);
  });

  it('applies the documented default depth to a structure deeper than it', () => {
    const snapshot = requireSnapshot(
      buildComponentTreeSnapshot(nestedCapture(DEFAULT_COMPONENT_TREE_MAX_DEPTH + 10)),
    );

    expect(snapshot.maxDepth).toBe(DEFAULT_COMPONENT_TREE_MAX_DEPTH);
    expect(snapshot.nodeCount).toBe(DEFAULT_COMPONENT_TREE_MAX_DEPTH + 1);
    expect(snapshot.truncated).toBe(true);
  });

  it('applies the documented default node bound to a structure wider than it', () => {
    const commit = makeCommitEvent({
      at: 1,
      serializedTree: siblingNodes(DEFAULT_COMPONENT_TREE_MAX_NODES + 5),
    });

    const snapshot = requireSnapshot(
      buildComponentTreeSnapshot([commit, makeRenderEvent({ at: 2, parentSpanId: commit.spanId })]),
    );

    expect(snapshot.nodeCount).toBe(DEFAULT_COMPONENT_TREE_MAX_NODES);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.degraded).toBe(true);
  });

  it.each([
    { label: 'a negative node bound', options: { maxNodes: -1 } },
    { label: 'a fractional depth bound', options: { maxDepth: 2.5 } },
    { label: 'both bounds unusable', options: { maxNodes: Number.NaN, maxDepth: -0.5 } },
  ])(
    'falls back to the defaults rather than throwing on $label',
    ({ options }: { readonly label: string; readonly options: ComponentTreeOptions }) => {
      const events = nestedCapture(2);

      expect(buildComponentTreeSnapshot(events, options)).toStrictEqual(
        buildComponentTreeSnapshot(events),
      );
    },
  );
});

describe('hostile component-tree payloads', () => {
  it.each(HOSTILE_TREE_CASES)(
    'degrades rather than throwing on $label',
    ({ serializedTree }: HostileTreeCase) => {
      const events = [makeCommitEvent({ at: 1, serializedTree }), makeRenderEvent({ at: 2 })];

      const snapshot = requireSnapshot(buildComponentTreeSnapshot(events));

      expect(COMPONENT_TREE_ORIGINS).toContain(snapshot.origin);
      expect(snapshot.degraded).toBe(true);
      expect(() => JSON.stringify(snapshot)).not.toThrow();
    },
  );

  it('stops at a self-reference, reports truncation and emits no cycle', () => {
    const events = [
      makeCommitEvent({ at: 1, serializedTree: cyclicNode() }),
      makeRenderEvent({ at: 2 }),
    ];

    const snapshot = requireSnapshot(buildComponentTreeSnapshot(events));

    expect(snapshot.origin).toBe(COMMIT_SNAPSHOT_ORIGIN);
    expect(snapshot.nodeCount).toBe(1);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.degraded).toBe(true);
    expect(nodeFor(snapshot, 'ParentView').children).toStrictEqual([]);
  });

  it('keeps reading a capture whose events are hostile one by one', () => {
    // One unreadable event costs itself and nothing else: the capture's other
    // evidence must still reach the panel.
    const events = [
      makeRenderEvent({ at: 1, attributes: { [COMPONENT_KEY]: { nested: true } } }),
      makeRenderEvent({ at: 2 }),
      makeCommitEvent({ at: 3, serializedTree: cyclicNode() }),
    ];

    const stats = aggregateRenders(events);

    expect(statFor(stats, DEFAULT_COMPONENT).renderCount).toBe(1);
    expect(statFor(stats, UNKNOWN_COMPONENT_LABEL).renderCount).toBe(1);
    expect(requireSnapshot(buildComponentTreeSnapshot(events)).origin).toBe(COMMIT_SNAPSHOT_ORIGIN);
  });
});

describe('component tree without rendering evidence', () => {
  it('answers an empty capture with no snapshot at all', () => {
    // `undefined` rather than an empty tree, so the service can serve an empty
    // `componentTree` result and the renderer shows its empty state instead of
    // an invented root.
    expect(buildComponentTreeSnapshot([])).toBeUndefined();
  });

  it('answers a capture of unrelated kinds with no snapshot', () => {
    expect(
      buildComponentTreeSnapshot([makeUnrelatedEvent({ at: 1 }), makeUnrelatedEvent({ at: 2 })]),
    ).toBeUndefined();
  });

  it('answers a commit with no renders with an empty, caveated snapshot', () => {
    // A commit IS rendering evidence, so the answer is a snapshot that admits
    // it has no components rather than the absence of one.
    const snapshot = requireSnapshot(buildComponentTreeSnapshot([makeCommitEvent({ at: 1 })]));

    expect(snapshot.roots).toStrictEqual([]);
    expect(snapshot.nodeCount).toBe(0);
    expect(snapshot.maxDepth).toBe(0);
    expect(snapshot.origin).toBe(FLAT_ORIGIN);
    expect(snapshot.degraded).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The component tree across the redaction boundary
 *
 * Every event reaching an aggregate has been through `../redaction/redactor.ts`
 * first (AAP 0.5.2): ingest redacts before anything is persisted or broadcast.
 * A snapshot document is the one attribute value that is a *document*, so the
 * two modules have to agree — a redactor that treated it as an ordinary string
 * would hand this module 120 code points of a JSON file, and the structure
 * would be lost with no error anywhere. These cases run the producer's own
 * event through the real redactor and then through the real aggregate.
 * ---------------------------------------------------------------------------
 */

describe('component tree through the redaction boundary', () => {
  /** A document carrying application data and a credential in its interior. */
  function documentWithInterior(): Readonly<Record<string, unknown>> {
    return {
      name: 'ParentView',
      renderCount: 1,
      // Neither field is structure: a page could hide anything in a node, and
      // only the structural allowlist travels.
      memoizedProps: { authorization: CREDENTIAL_SHAPED_PREVIEW },
      hookState: CREDENTIAL_SHAPED_PREVIEW,
      children: [
        { name: 'ListRow', key: 'row-1', renderCount: 2, children: [] },
        { name: CREDENTIAL_SHAPED_PREVIEW, renderCount: 0, children: [] },
      ],
    };
  }

  it('keeps a redacted snapshot parseable and reads the same structure from it', () => {
    const events = [
      makeCommitEvent({ at: 1 }),
      makeRenderEvent({
        at: 2,
        parentSpanId: spanIdFor(1),
        attributes: renderAttributes({ component: 'ListRow', trigger: PROPS_TRIGGER }),
      }),
      makeSnapshotEvent({ at: 3, tree: JSON.stringify(documentWithInterior()) }),
    ];

    const redacted = events.map((event) => redactEvent(event));
    const built = requireSnapshot(buildComponentTreeSnapshot(redacted));

    // The document survived as a document: the aggregate parsed it, so the
    // redactor cannot have cut it to a preview.
    expect(built.origin).toBe(COMMIT_SNAPSHOT_ORIGIN);
    expect(nodesFor(built, 'ParentView')).toHaveLength(1);
    expect(nodeFor(built, 'ListRow').key).toBe('row-1');
    expect(nodeFor(built, 'ListRow').renderCount).toBe(1);
    expect(built.nodeCount).toBe(3);
  });

  it('drops the non-structural interior and every fragment of a credential', () => {
    const snapshot = redactEvent(
      makeSnapshotEvent({ at: 1, tree: JSON.stringify(documentWithInterior()) }),
    );
    const text = snapshot.attributes[SNAPSHOT_TREE_KEY];

    expect(typeof text).toBe('string');
    const document: unknown = JSON.parse(typeof text === 'string' ? text : '');
    const serialized = JSON.stringify(document);

    // Structure kept...
    expect(serialized).toContain('ParentView');
    expect(serialized).toContain('row-1');
    // ...interior dropped, whatever it held, and no fragment of the
    // credential-shaped value survives anywhere in the document.
    expect(serialized).not.toContain('memoizedProps');
    expect(serialized).not.toContain('hookState');
    expect(serialized).not.toContain(CREDENTIAL_FRAGMENT);
    expect(serialized).not.toContain(CREDENTIAL_SHAPED_PREVIEW);
  });

  it('is unchanged by a second pass, so ingest may redact an event twice', () => {
    const once = redactEvent(
      makeSnapshotEvent({ at: 1, tree: JSON.stringify(documentWithInterior()) }),
    );

    expect(redactEvent(once)).toStrictEqual(once);
    expect(buildComponentTreeSnapshot([redactEvent(once)])).toStrictEqual(
      buildComponentTreeSnapshot([once]),
    );
  });

  it('bounds a component name in the document to the preview length', () => {
    const longName = 'Wrapper'.repeat(MAX_TRACKED_KEYS);
    const redacted = redactEvent(
      makeSnapshotEvent({
        at: 1,
        tree: JSON.stringify({ name: longName, renderCount: 0, children: [] }),
      }),
    );

    const built = requireSnapshot(buildComponentTreeSnapshot([redacted]));
    const [root] = built.roots;

    expect(longName.length).toBeGreaterThan(MAX_PREVIEW_LENGTH);
    expect([...requireDefined(root, 'the only root node').component]).toHaveLength(
      MAX_PREVIEW_LENGTH,
    );
  });
});

describe('component tree transport', () => {
  it('survives a JSON round trip unchanged', () => {
    const { events } = twoCommitCapture();
    const withLocation = [
      ...events,
      makeRenderEvent({
        at: 6,
        parentSpanId: spanIdFor(4),
        source: PATCH_LOCATION,
        attributes: renderAttributes({ component: 'ListRow', trigger: UNCHANGED_TRIGGER }),
      }),
    ];

    const snapshot = requireSnapshot(buildComponentTreeSnapshot(withLocation));

    expect(JSON.parse(JSON.stringify(snapshot))).toStrictEqual(snapshot);
  });

  it('carries no parent back-reference and no undeclared field', () => {
    const { events } = twoCommitCapture();

    const snapshot = requireSnapshot(buildComponentTreeSnapshot(events));
    const nodes = allNodes(snapshot);

    expect(nodes.length).toBeGreaterThan(1);
    for (const node of nodes) {
      expect(Object.hasOwn(node, PARENT_BACK_REFERENCE_FIELD)).toBe(false);
      for (const field of Object.keys(node)) {
        expect(TREE_NODE_FIELDS).toContain(field);
      }
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * The exported labels, prefixes and bounds
 *
 * Each of these is part of the contract rather than a tuning knob: a consumer
 * re-deriving a stat id, or paging a result set, derives it from these
 * constants, so their shapes are asserted here alongside the behaviour that
 * depends on them.
 * ---------------------------------------------------------------------------
 */

describe('exported labels, prefixes and bounds', () => {
  it('labels an unattributable render so it cannot be mistaken for a component', () => {
    // Parenthesised, so no component that is actually called this could collide
    // with the group — a React display name cannot contain parentheses.
    expect(UNKNOWN_COMPONENT_LABEL.startsWith('(')).toBe(true);
    expect(UNKNOWN_COMPONENT_LABEL.endsWith(')')).toBe(true);
  });

  it('prefixes statistic and node identifiers distinctly', () => {
    const { events } = twoCommitCapture();

    const stats = aggregateRenders(events);
    const snapshot = requireSnapshot(buildComponentTreeSnapshot(events));

    expect(RENDER_STAT_ID_PREFIX).not.toBe(COMPONENT_TREE_NODE_ID_PREFIX);
    expect(stats.length).toBeGreaterThan(0);
    for (const stat of stats) {
      expect(stat.id.startsWith(RENDER_STAT_ID_PREFIX)).toBe(true);
      expect(stat.id).toBe(`${RENDER_STAT_ID_PREFIX}${stat.component}`);
    }
    for (const node of allNodes(snapshot)) {
      expect(node.id.startsWith(COMPONENT_TREE_NODE_ID_PREFIX)).toBe(true);
    }
  });

  it('publishes bounds a caller can raise or lower deliberately', () => {
    for (const bound of [
      DEFAULT_MAX_OCCURRENCES_PER_COMPONENT,
      DEFAULT_COMPONENT_TREE_MAX_NODES,
      DEFAULT_COMPONENT_TREE_MAX_DEPTH,
    ]) {
      expect(Number.isInteger(bound)).toBe(true);
      expect(bound).toBeGreaterThan(0);
    }
  });

  it('declares three distinct snapshot origins, best first', () => {
    expect(COMPONENT_TREE_ORIGINS).toHaveLength(3);
    expect(new Set(COMPONENT_TREE_ORIGINS).size).toBe(COMPONENT_TREE_ORIGINS.length);
    expect([COMMIT_SNAPSHOT_ORIGIN, OWNER_CHAINS_ORIGIN, FLAT_ORIGIN]).toStrictEqual([
      ...COMPONENT_TREE_ORIGINS,
    ]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The committed corpora
 *
 * Everything above states one fact per case from a builder that this file
 * controls end to end. That is the right shape for a boundary — a malformed
 * trigger, a cyclic tree, a bound reached — and the wrong shape for the
 * question the corpora answer: does this module still compute the render panel
 * of AAP 0.6.5 from a capture the repository actually ships?
 *
 * Two committed files are read here, and nothing else in the repository reads
 * them as executable input:
 *
 * - `test/fixtures/capture-batch.json` — a whole 35-event capture of one
 *   interaction across the browser, server and database tiers, six of whose
 *   events are renders and two of whose events are commits. Every number the
 *   render panel shows is asserted against it exactly, and the twenty-seven
 *   events of other kinds are the standing proof that nothing outside the
 *   render group can reach a row or a count.
 * - `test/fixtures/redaction-props-state.json` — the props/state corpus built
 *   to exercise the redaction layer, in both its `before` and its
 *   already-redacted `after` form. It is full of captured prop and state
 *   previews, which makes it the one corpus worth asserting AAP 0.5.2' privacy
 *   bound against: only key names may travel, and a preview must not survive
 *   aggregation in either form.
 *
 * The parse is the contract. Each element goes through the very schema its
 * position in the pipeline implies — `telemetryEventSchema` for a persisted
 * event, `telemetryEventIngressSchema` for one still in flight — so a corpus
 * that drifts into a shape the store would reject fails here instead of
 * quietly feeding these aggregates something no producer could have sent.
 * ---------------------------------------------------------------------------
 */

/**
 * `packages/telemetry/test/fixtures`, resolved from this module's location.
 *
 * `fileURLToPath` **then** `join`, deliberately not
 * `new URL('../../test/fixtures/…', import.meta.url)`: this package's Vitest
 * project runs under happy-dom, whose global `URL` resolves a relative
 * specifier against the document's `http://localhost` origin instead of
 * against the `file:` URL it was handed, so the tidier one-liner yields an
 * `http:` URL and `readFileSync` rejects it ("The URL must be of scheme
 * file"). Converting the module URL to a path first keeps the resolution pure
 * path arithmetic and independent of the DOM environment — the same choice,
 * for the same reason, as `../redaction/rules.test.ts` and
 * `../schema/attributes.test.ts`.
 *
 * Resolving from `import.meta.url` rather than from the working directory also
 * makes the suite behave identically whether Vitest is invoked on this one
 * file or on the whole repository.
 */
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');

/**
 * The text of one committed fixture.
 *
 * Reads eagerly and fails with the path it tried: these cases are the only
 * executable consumers of the two corpora, so a fixture that has moved must
 * stop the suite loudly rather than leave the corpus unasserted.
 *
 * @param fileName The fixture's name inside {@link FIXTURES_DIR}.
 * @returns The file's UTF-8 contents.
 */
function readFixture(fileName: string): string {
  const path = join(FIXTURES_DIR, fileName);
  try {
    return readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(
      `the committed fixture "${fileName}" could not be read at ${path}. The cases below are ` +
        'its only executable consumers; if it has moved, point this loader at the new location ' +
        'rather than dropping the cases.',
      { cause },
    );
  }
}

/** The whole-capture corpus, read once. Parsed per case; see {@link corpusEvents}. */
const CAPTURE_BATCH_SOURCE = readFixture('capture-batch.json');

/** The props/state corpus, read once. Parsed per case; see {@link propsStateEvents}. */
const PROPS_STATE_SOURCE = readFixture('redaction-props-state.json');

/**
 * Whether a parsed JSON value is an array this file may walk.
 *
 * A hand-written predicate rather than a bare `Array.isArray` call, because
 * `Array.isArray` narrows an `unknown` to `any[]` — which the repository's
 * type-aware lint rules reject on assignment and on return. Narrowing to
 * `readonly unknown[]` instead keeps every element `unknown` until a schema
 * has validated it.
 *
 * @param value The value to test.
 * @returns `true` when it is an array.
 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * One element of a corpus, validated as a persisted event.
 *
 * @param element The raw JSON element.
 * @param where Which element it was, for the failure message.
 * @returns The element as a {@link TelemetryEvent}.
 */
function parsePersistedEvent(element: unknown, where: string): TelemetryEvent {
  try {
    return telemetryEventSchema.parse(element);
  } catch (cause) {
    throw new Error(
      `fixture invariant broken: ${where} is not a persisted telemetry event. The corpora are ` +
        'tracked repository data and must stay valid against ../schema/event.ts.',
      { cause },
    );
  }
}

/**
 * One element of a corpus, validated as an event still in flight.
 *
 * @param element The raw JSON element.
 * @param where Which element it was, for the failure message.
 * @returns The element as a {@link TelemetryEventIngress}.
 */
function parseIngressEvent(element: unknown, where: string): TelemetryEventIngress {
  try {
    return telemetryEventIngressSchema.parse(element);
  } catch (cause) {
    throw new Error(
      `fixture invariant broken: ${where} is not an ingress telemetry event. The corpora are ` +
        'tracked repository data and must stay valid against ../schema/event.ts.',
      { cause },
    );
  }
}

/**
 * The whole capture, as persisted events.
 *
 * The file is read once at module scope and re-parsed here on every call, so
 * each case receives a structure no earlier case can have mutated — the same
 * guarantee the ordinal-taking builders above give, extended to repository
 * data.
 *
 * @returns The corpus' 30 events, in the order the file lists them.
 */
function corpusEvents(): TelemetryEvent[] {
  const elements: unknown = JSON.parse(CAPTURE_BATCH_SOURCE);
  if (!isUnknownArray(elements)) {
    throw new Error('fixture invariant broken: capture-batch.json must hold a JSON array');
  }
  return elements.map((element, index) =>
    parsePersistedEvent(element, `capture-batch.json[${index}]`),
  );
}

/**
 * One phase of the props/state corpus, as events still in flight.
 *
 * @param phase `before` for the captured previews, `after` for the copies the
 * redactor has already rewritten.
 * @returns That phase's two events, in file order.
 */
function propsStateIngress(phase: 'before' | 'after'): TelemetryEventIngress[] {
  const phases: unknown = JSON.parse(PROPS_STATE_SOURCE);
  if (!isRecord(phases)) {
    throw new Error('fixture invariant broken: redaction-props-state.json must hold a JSON object');
  }
  const elements = phases[phase];
  if (!isUnknownArray(elements)) {
    throw new Error(
      `fixture invariant broken: redaction-props-state.json must hold a "${phase}" array`,
    );
  }
  return elements.map((element, index) =>
    parseIngressEvent(element, `redaction-props-state.json ${phase}[${index}]`),
  );
}

/**
 * One phase of the props/state corpus, attributed and persisted.
 *
 * The corpus holds **ingress** events: no `sessionId`, `captureId` or
 * `ingestSeq`, because a producer never sends those — the browser agent is
 * armed per tab and knows no session, so attribution at ingest is the
 * service's job (AAP 0.2.3, `apps/local-service/src/telemetry/attribute.ts`).
 * The aggregates work on persisted events, so this function performs exactly
 * that transition, adding the three fields and re-parsing through the
 * persisted schema; the session and capture ids are this suite's own, because
 * the values are the service's to choose and nothing here depends on them.
 *
 * `ingestSeq` is one-based and follows file order, which is what the store
 * assigns to a batch it receives in that order.
 *
 * @param phase Which phase of the corpus to attribute.
 * @returns That phase's events, as the store would hold them.
 */
function propsStateEvents(phase: 'before' | 'after'): TelemetryEvent[] {
  return propsStateIngress(phase).map((event, index) =>
    parsePersistedEvent(
      {
        ...event,
        sessionId: SESSION_ID,
        captureId: CAPTURE_ID,
        ingestSeq: index + 1,
      },
      `attributed redaction-props-state.json ${phase}[${index}]`,
    ),
  );
}

/*
 * ---------------------------------------------------------------------------
 * What the corpora hold
 *
 * Restated here on purpose, exactly and in full: these constants *are* the
 * assertions, so an edit to a tracked corpus that changes what the render
 * panel would show fails this file rather than passing silently. Identifiers
 * are quoted because a fixture id is data, not a vocabulary member — the
 * vocabularies are still bound from their declaring tuples above.
 * ---------------------------------------------------------------------------
 */

/** Events in `capture-batch.json`. */
const CORPUS_EVENT_COUNT = 35;

/** The one trace every event of the corpus belongs to. */
const CORPUS_TRACE_ID = '7b1e4d92c0a53f86d24b9e017c35af68';

/** The session the corpus was attributed to at ingest. */
const CORPUS_SESSION_ID = 'ses_t3m8q1v5y9c2f6hk';

/** The capture window the corpus was recorded in. */
const CORPUS_CAPTURE_ID = 'cap_b7d1g4j8m2p5r9tw';

/** The corpus' two producers: the page agent and the Node preload. */
const CORPUS_PRODUCER_IDS = ['prd_n4q8t2w6z0c3f7jm', 'prd_v5y9b3e7h1k4n8qs'] as const;

/** Render events in the corpus — the number `render_count` must report. */
const CORPUS_RENDER_EVENT_COUNT = 6;

/** Commit events in the corpus: two, of which only the second carries a tree. */
const CORPUS_COMMIT_EVENT_COUNT = 2;

/**
 * Events of the corpus outside the render group — interactions, fetches,
 * server spans, database queries, state changes, a long task and an error.
 *
 * They are the reason this corpus is worth aggregating rather than a
 * six-event one: every kind the module does not read is present, and two of
 * them name the very components that do have rows.
 */
const CORPUS_UNRELATED_EVENT_COUNT =
  CORPUS_EVENT_COUNT - CORPUS_RENDER_EVENT_COUNT - CORPUS_COMMIT_EVENT_COUNT;

/**
 * Renders of the corpus whose inputs were all evaluated and none had changed:
 * the `unchanged_render_count` card of AAP 0.6.5' render panel.
 *
 * Both are update renders that reported the `unchanged` trigger; the corpus'
 * mount render is deliberately not one of them.
 */
const CORPUS_UNCHANGED_RENDER_COUNT = 2;

/**
 * Renders of the corpus whose trigger could not be determined: the
 * `render_trigger_unknown_count` card of the same panel.
 *
 * Exactly one — the row component's mount — which is what makes this corpus
 * able to tell the two cards apart at all.
 */
const CORPUS_UNKNOWN_TRIGGER_COUNT = 1;

/** The root name both commits report, which must never become a render row. */
const CORPUS_COMMIT_ROOT_NAME = '#app-root';

/** Span id of the first commit: the parent of the first three renders. */
const CORPUS_FIRST_COMMIT_SPAN_ID = '37a2e9d5c081b6f4';

/** Span id of the last commit: the parent of the last three renders. */
const CORPUS_LAST_COMMIT_SPAN_ID = '4fa07be6152d93c8';

/** Event id of the last commit — the one a snapshot must be anchored to. */
const CORPUS_LAST_COMMIT_EVENT_ID = 'evt_n6t0v4y8c2f6h0jq';

/** Event id of the first commit, which carries no serialized structure. */
const CORPUS_FIRST_COMMIT_EVENT_ID = 'evt_c8h2k6n0s4t8x2yd';

/** Start of the last commit, in epoch ms: the snapshot's `capturedAt`. */
const CORPUS_LAST_COMMIT_START_TIME = 1_789_812_901_218.06;

/** The list component of the corpus. */
const CORPUS_LIST_COMPONENT = 'ItemList';

/** The row component of the corpus, rendered inside the list. */
const CORPUS_ROW_COMPONENT = 'ItemRow';

/** The panel component of the corpus, the root of its structure. */
const CORPUS_PANEL_COMPONENT = 'WidgetPanel';

/** Where the corpus' list and row components are declared. */
const CORPUS_LIST_SOURCE_FILE = 'src/components/ItemList.tsx';

/** Where the corpus' panel component is declared. */
const CORPUS_PANEL_SOURCE_FILE = 'src/components/WidgetPanel.tsx';

/**
 * How the corpus' locations were resolved.
 *
 * Spelled out because it is corpus data, but not unchecked: it indexes
 * `DEFAULT_RESOLUTION_CONFIDENCE` below, so the compiler rejects a resolver
 * `@debuggen/shared` does not declare, and the confidence the corpus states is
 * asserted to be the one that package assigns to this route rather than a
 * number copied into this file.
 */
const CORPUS_RESOLVED_BY = 'react-owner';

/** Everything one component's rows and counts must read, from the corpus. */
interface CorpusStatExpectation {
  /** The component the statistic is for. */
  readonly component: string;
  /** Renders this module must count for it. */
  readonly renderCount: number;
  /** Summed, rounded render time in ms. */
  readonly totalDurationMs: number;
  /** Mean render time in ms, as the row states it. */
  readonly averageDurationMs: number;
  /** Longest single render in ms. */
  readonly maxDurationMs: number;
  /** Start of its first render, epoch ms. */
  readonly firstStartTime: number;
  /** Start of its last render, epoch ms. */
  readonly lastStartTime: number;
  /** Non-zero trigger buckets; every other bucket must read zero. */
  readonly triggers: Readonly<Record<string, number>>;
  /** Non-zero phase buckets; every other bucket must read zero. */
  readonly phaseCounts: Readonly<Record<string, number>>;
  /** `triggers.unchanged`, surfaced as the `unchanged_render_count` input. */
  readonly unchangedRenderCount: number;
  /** `triggers.unknown`, surfaced as the `render_trigger_unknown_count` input. */
  readonly unknownTriggerCount: number;
  /** Changed prop names, ascending — names only, never values. */
  readonly changedPropKeys: readonly string[];
  /** How many renders each of those names changed at. */
  readonly changedPropCounts: Readonly<Record<string, number>>;
  /** The file the component's source link must point at. */
  readonly sourceFile: string;
  /** Its renders' event ids, earliest first. */
  readonly occurrenceEventIds: readonly string[];
  /** The commits those renders happened inside, earliest first. */
  readonly occurrenceParentSpanIds: readonly string[];
  /** Their triggers, earliest first. */
  readonly occurrenceTriggers: readonly RenderTrigger[];
}

/**
 * The corpus' three components, in the order `aggregateRenders` must emit them.
 *
 * All three rendered exactly twice, so `renderCount` ties and the component
 * name decides — which makes this table simultaneously the counts assertion
 * and the canonical-order assertion (busiest first, then name, then id).
 */
const CORPUS_STAT_EXPECTATIONS: readonly CorpusStatExpectation[] = [
  {
    component: CORPUS_LIST_COMPONENT,
    renderCount: 2,
    totalDurationMs: 9.322,
    averageDurationMs: 4.661,
    maxDurationMs: 6.118,
    firstStartTime: 1_789_812_900_710.5,
    lastStartTime: 1_789_812_901_227.8,
    triggers: { [PROPS_TRIGGER]: 1, [UNCHANGED_TRIGGER]: 1 },
    phaseCounts: { [UPDATE_PHASE]: 2 },
    unchangedRenderCount: 1,
    unknownTriggerCount: 0,
    changedPropKeys: ['items', 'onSelect'],
    changedPropCounts: { items: 1, onSelect: 1 },
    sourceFile: CORPUS_LIST_SOURCE_FILE,
    occurrenceEventIds: ['evt_f0k4n8q2v6w0z4bg', 'evt_q8w2x6b9f4h8k2ms'],
    occurrenceParentSpanIds: [CORPUS_FIRST_COMMIT_SPAN_ID, CORPUS_LAST_COMMIT_SPAN_ID],
    occurrenceTriggers: [PROPS_TRIGGER, UNCHANGED_TRIGGER],
  },
  {
    component: CORPUS_ROW_COMPONENT,
    renderCount: 2,
    totalDurationMs: 4.802,
    averageDurationMs: 2.401,
    maxDurationMs: 2.884,
    firstStartTime: 1_789_812_900_717.3,
    lastStartTime: 1_789_812_901_231.5,
    // The mount is reported with an undeterminable trigger, which is the
    // corpus' own instance of the distinction this whole file guards: it
    // counts as `unknown` and must never be folded into `unchanged`.
    triggers: { [UNCHANGED_TRIGGER]: 1, [UNKNOWN_TRIGGER]: 1 },
    phaseCounts: { [MOUNT_PHASE]: 1, [UPDATE_PHASE]: 1 },
    unchangedRenderCount: 1,
    unknownTriggerCount: 1,
    changedPropKeys: [],
    changedPropCounts: {},
    sourceFile: CORPUS_LIST_SOURCE_FILE,
    occurrenceEventIds: ['evt_g1m5p9r3w7x1b5ch', 'evt_r9x3y7c0g5j9m3nt'],
    occurrenceParentSpanIds: [CORPUS_FIRST_COMMIT_SPAN_ID, CORPUS_LAST_COMMIT_SPAN_ID],
    occurrenceTriggers: [UNKNOWN_TRIGGER, UNCHANGED_TRIGGER],
  },
  {
    component: CORPUS_PANEL_COMPONENT,
    renderCount: 2,
    totalDurationMs: 15.814,
    averageDurationMs: 7.907,
    maxDurationMs: 8.204,
    firstStartTime: 1_789_812_900_701.2,
    lastStartTime: 1_789_812_901_219.4,
    triggers: { [STATE_TRIGGER]: 1, [CONTEXT_TRIGGER]: 1 },
    phaseCounts: { [UPDATE_PHASE]: 2 },
    unchangedRenderCount: 0,
    unknownTriggerCount: 0,
    changedPropKeys: [],
    changedPropCounts: {},
    sourceFile: CORPUS_PANEL_SOURCE_FILE,
    occurrenceEventIds: ['evt_d9j3m7p1t5v9y3zf', 'evt_p7v1w5z8d3g7j1kr'],
    occurrenceParentSpanIds: [CORPUS_FIRST_COMMIT_SPAN_ID, CORPUS_LAST_COMMIT_SPAN_ID],
    occurrenceTriggers: [STATE_TRIGGER, CONTEXT_TRIGGER],
  },
];

/** One node of the structure the corpus' last commit serialized. */
interface CorpusTreeNodeExpectation {
  /** The component at this position. */
  readonly component: string;
  /** The React key the structure carried for it. */
  readonly key: string;
  /** Distance from the root. */
  readonly depth: number;
  /** The component's cumulative render count over the whole capture. */
  readonly renderCount: number;
  /** Its cumulative render time in ms. */
  readonly totalDurationMs: number;
  /** The trigger of its most recent observed render. */
  readonly lastTrigger: RenderTrigger;
  /** The file its source link must point at. */
  readonly sourceFile: string;
}

/**
 * The corpus' structure, root first: one chain of three, keyed at every level.
 *
 * Cumulative counts, not the last commit's: each component rendered twice
 * across the capture's two commits, which is the number a tree node must
 * report (see {@link ComponentTreeNode.renderCount}).
 */
const CORPUS_TREE_EXPECTATIONS: readonly CorpusTreeNodeExpectation[] = [
  {
    component: CORPUS_PANEL_COMPONENT,
    key: 'widget-panel',
    depth: 0,
    renderCount: 2,
    totalDurationMs: 15.814,
    lastTrigger: CONTEXT_TRIGGER,
    sourceFile: CORPUS_PANEL_SOURCE_FILE,
  },
  {
    component: CORPUS_LIST_COMPONENT,
    key: 'item-list',
    depth: 1,
    renderCount: 2,
    totalDurationMs: 9.322,
    lastTrigger: UNCHANGED_TRIGGER,
    sourceFile: CORPUS_LIST_SOURCE_FILE,
  },
  {
    component: CORPUS_ROW_COMPONENT,
    key: 'row-0',
    depth: 2,
    renderCount: 2,
    totalDurationMs: 4.802,
    lastTrigger: UNCHANGED_TRIGGER,
    sourceFile: CORPUS_LIST_SOURCE_FILE,
  },
];

/** The props the props/state corpus' render reports as changed, ascending. */
const PROPS_STATE_CHANGED_PROP_KEYS = [
  'headingText',
  'itemSummary',
  'onItemSelect',
  'visibleItemCount',
] as const;

/** The component whose render the props/state corpus carries. */
const PROPS_STATE_RENDER_COMPONENT = 'WidgetPanel';

/** The component whose hook state the props/state corpus carries. */
const PROPS_STATE_STATE_COMPONENT = 'ItemList';

/** The attribute paths the redactor rewrote in the corpus' `after` render. */
const PROPS_STATE_RENDER_REDACTED_PATHS = [
  'changedProps[0].next.preview',
  'changedProps[1].next.preview',
] as const;

/** The attribute paths the redactor rewrote in the corpus' `after` state event. */
const PROPS_STATE_STATE_REDACTED_PATHS = ['previousValue.preview', 'nextValue.preview'] as const;

/** Value previews each phase of the props/state corpus carries. */
const PROPS_STATE_PREVIEW_COUNT = 10;

/** Value previews `capture-batch.json` carries, across its renders and state events. */
const CORPUS_PREVIEW_COUNT = 8;

/**
 * Shortest preview whose appearance in an output could not be a coincidence.
 *
 * The corpora carry previews as short as `18`, and a two-character digit run
 * occurs inside epoch timestamps and durations by chance — asserting on one
 * would be a flake rather than a privacy check. Previews at least this long
 * are unmistakable, and the bound is small enough that every prose, object and
 * function preview in both corpora is still asserted.
 */
const MIN_UNMISTAKABLE_PREVIEW_LENGTH = 8;

/**
 * Field names that carry a captured value, and must therefore never appear
 * anywhere in this module's output.
 *
 * `changedProps` is the producer's entry list, whose entries hold previews;
 * this module publishes `changedPropKeys` and `changedPropCounts` instead, so
 * the presence of the original name in an output would itself mean a value
 * escaped (AAP 0.5.2).
 */
const VALUE_CARRYING_FIELD_NAMES = [
  'changedProps',
  'preview',
  'previous',
  'next',
  'previousValue',
  'nextValue',
] as const;

/**
 * Asserts a histogram over the whole trigger vocabulary.
 *
 * Iterates `RENDER_TRIGGERS` rather than comparing object literals, so a
 * member added upstream is checked here without an edit, and asserts the key
 * set as well — a bucket this file does not know about is as much a contract
 * change as a wrong count.
 *
 * @param actual The histogram under test.
 * @param expected The non-zero buckets; every other bucket must read zero.
 */
function expectTriggerHistogram(
  actual: RenderTriggerHistogram,
  expected: Readonly<Record<string, number>>,
): void {
  for (const trigger of RENDER_TRIGGERS) {
    expect(actual[trigger], `trigger bucket "${trigger}"`).toBe(expected[trigger] ?? 0);
  }
  expect([...Object.keys(actual)].sort()).toStrictEqual([...RENDER_TRIGGERS].sort());
}

/**
 * Asserts phase counts over the whole phase vocabulary.
 *
 * @param actual The counts under test.
 * @param expected The non-zero buckets; every other bucket must read zero.
 */
function expectPhaseCounts(
  actual: RenderPhaseCounts,
  expected: Readonly<Record<string, number>>,
): void {
  for (const phase of RENDER_PHASES) {
    expect(actual[phase], `phase bucket "${phase}"`).toBe(expected[phase] ?? 0);
  }
  expect([...Object.keys(actual)].sort()).toStrictEqual([...RENDER_PHASES].sort());
}

/**
 * Every captured value preview reachable from a corpus.
 *
 * Walks the raw fixture rather than a list written here, so a preview added to
 * a corpus is automatically one more string the privacy case forbids.
 *
 * @param value Any part of a parsed corpus.
 * @returns The strings it carries under a `preview` key, in walk order.
 */
function capturedPreviews(value: unknown): readonly string[] {
  if (isUnknownArray(value)) {
    return value.flatMap((element) => capturedPreviews(element));
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, nested]) =>
    key === 'preview' && typeof nested === 'string' ? [nested] : capturedPreviews(nested),
  );
}

/**
 * Every field name reachable from a value, at any depth.
 *
 * @param value The structure to walk.
 * @returns Its field names, with duplicates, in walk order.
 */
function fieldNames(value: unknown): readonly string[] {
  if (isUnknownArray(value)) {
    return value.flatMap((element) => fieldNames(element));
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, nested]) => [key, ...fieldNames(nested)]);
}

/**
 * Asserts that nothing this module returned carries a captured value.
 *
 * Two independent checks, because either alone can pass while a value leaks: a
 * structural one — no field that holds a value exists anywhere in the payload,
 * at any depth — and a textual one over the serialized form, which catches a
 * preview that travelled under some other field name, or a fragment of one cut
 * to a bound.
 *
 * @param payload Everything the module returned, as one JSON-serializable value.
 * @param previews The previews the corpus carries; see {@link capturedPreviews}.
 */
function expectNoCapturedValueEscapes(payload: unknown, previews: readonly string[]): void {
  const names = fieldNames(payload);
  for (const forbidden of VALUE_CARRYING_FIELD_NAMES) {
    expect(names, `field "${forbidden}" must not appear in panel output`).not.toContain(forbidden);
  }

  const serialized = JSON.stringify(payload);
  const unmistakable = previews.filter(
    (preview) => preview.length >= MIN_UNMISTAKABLE_PREVIEW_LENGTH,
  );
  expect(unmistakable.length).toBeGreaterThan(0);
  for (const preview of unmistakable) {
    expect(serialized, `captured preview "${preview}" escaped into panel output`).not.toContain(
      preview,
    );
  }
}

describe('the committed capture corpus', () => {
  it('parses every event of the batch through the persisted schema', () => {
    // The parse IS the contract: this case fails the moment the tracked corpus
    // stops being something the store would accept, before any aggregate has
    // been asked a question about it.
    const events = corpusEvents();

    expect(events).toHaveLength(CORPUS_EVENT_COUNT);
    for (const event of events) {
      expect(isTelemetryEvent(event)).toBe(true);
      expect(event.traceId).toBe(CORPUS_TRACE_ID);
      expect(event.sessionId).toBe(CORPUS_SESSION_ID);
      expect(event.captureId).toBe(CORPUS_CAPTURE_ID);
    }
    expect(events.map((event) => event.ingestSeq)).toStrictEqual(
      Array.from({ length: CORPUS_EVENT_COUNT }, (_unused, index) => index + 1),
    );
    expect([...new Set(events.map((event) => event.producerId))].sort()).toStrictEqual(
      [...CORPUS_PRODUCER_IDS].sort(),
    );
  });

  it('holds the render, commit and unrelated evidence these cases depend on', () => {
    const events = corpusEvents();

    const byKind = (kind: TelemetryKind): readonly TelemetryEvent[] =>
      events.filter((event) => event.kind === kind);
    const commits = byKind(COMMIT_KIND);

    expect(byKind(RENDER_KIND)).toHaveLength(CORPUS_RENDER_EVENT_COUNT);
    expect(commits).toHaveLength(CORPUS_COMMIT_EVENT_COUNT);
    expect(events.filter((event) => !RENDER_KINDS.includes(event.kind))).toHaveLength(
      CORPUS_UNRELATED_EVENT_COUNT,
    );
    expect(commits.map((event) => event.id)).toStrictEqual([
      CORPUS_FIRST_COMMIT_EVENT_ID,
      CORPUS_LAST_COMMIT_EVENT_ID,
    ]);
    expect(commits.map((event) => event.spanId)).toStrictEqual([
      CORPUS_FIRST_COMMIT_SPAN_ID,
      CORPUS_LAST_COMMIT_SPAN_ID,
    ]);
    // Only the last commit serialized a structure, which is what makes the
    // commit-snapshot route reachable from this corpus at all — and what makes
    // the last-commit selection assertion below more than a coincidence.
    const firstCommit = requireDefined(commits[0], 'the first commit of the corpus');
    const lastCommit = requireDefined(commits[1], 'the last commit of the corpus');
    expect(Object.hasOwn(firstCommit.attributes, SERIALIZED_TREE_KEY)).toBe(false);
    expect(Object.hasOwn(lastCommit.attributes, SERIALIZED_TREE_KEY)).toBe(true);
    expect(lastCommit.startTime).toBe(CORPUS_LAST_COMMIT_START_TIME);
    expect(lastCommit.startTime).toBeGreaterThan(firstCommit.startTime);
  });

  it('groups the capture into one statistic per component, in canonical order', () => {
    const stats = aggregateRenders(corpusEvents());

    expect(stats.map((stat) => stat.component)).toStrictEqual(
      CORPUS_STAT_EXPECTATIONS.map((expectation) => expectation.component),
    );
    expect(stats.map((stat) => stat.id)).toStrictEqual(
      CORPUS_STAT_EXPECTATIONS.map(
        (expectation) => `${RENDER_STAT_ID_PREFIX}${expectation.component}`,
      ),
    );
    // Neither commit becomes a row: the structure a commit describes is not a
    // component that rendered, and `render_count` counts renders only.
    expect(stats.map((stat) => stat.component)).not.toContain(CORPUS_COMMIT_ROOT_NAME);
    expect(stats.map((stat) => stat.component)).not.toContain(UNKNOWN_COMPONENT_LABEL);
    expect(stats.reduce((total, stat) => total + stat.renderCount, 0)).toBe(
      CORPUS_RENDER_EVENT_COUNT,
    );
  });

  it('reaches the same order from a reordered corpus', () => {
    // The corpus arrives in ingest order in the file; a capture read back out
    // of the store, or merged from two producers, need not. The base order is
    // a property of the result, not of the input.
    const inFileOrder = aggregateRenders(corpusEvents());
    const shuffled = aggregateRenders(reordered(corpusEvents()));

    expect(shuffled).toStrictEqual(inFileOrder);
  });

  it.each(CORPUS_STAT_EXPECTATIONS)(
    'counts and times $component exactly as the corpus records it',
    (expectation) => {
      const stat = statFor(aggregateRenders(corpusEvents()), expectation.component);

      expect(stat.renderCount).toBe(expectation.renderCount);
      expect(stat.totalDurationMs).toBe(expectation.totalDurationMs);
      expect(stat.averageDurationMs).toBe(expectation.averageDurationMs);
      expect(stat.averageDurationMs).toBe(
        roundMs(expectation.totalDurationMs / expectation.renderCount),
      );
      expect(stat.maxDurationMs).toBe(expectation.maxDurationMs);
      expect(stat.firstStartTime).toBe(expectation.firstStartTime);
      expect(stat.lastStartTime).toBe(expectation.lastStartTime);
    },
  );

  it.each(CORPUS_STAT_EXPECTATIONS)(
    'attributes every render of $component to a trigger and a phase',
    (expectation) => {
      const stat = statFor(aggregateRenders(corpusEvents()), expectation.component);

      expectTriggerHistogram(stat.triggers, expectation.triggers);
      expectPhaseCounts(stat.phaseCounts, expectation.phaseCounts);
      expect(stat.unchangedRenderCount).toBe(expectation.unchangedRenderCount);
      expect(stat.unknownTriggerCount).toBe(expectation.unknownTriggerCount);
      // Each headline field reads exactly one bucket and never a sum of two —
      // which on this corpus is a live distinction, because the row component
      // contributes one render to each of them.
      expect(stat.unchangedRenderCount).toBe(stat.triggers[UNCHANGED_TRIGGER]);
      expect(stat.unknownTriggerCount).toBe(stat.triggers[UNKNOWN_TRIGGER]);
    },
  );

  it.each(CORPUS_STAT_EXPECTATIONS)(
    'reports the changed prop names of $component, and only the names',
    (expectation) => {
      const stat = statFor(aggregateRenders(corpusEvents()), expectation.component);

      expect(stat.changedPropKeys).toStrictEqual([...expectation.changedPropKeys]);
      expect(stat.changedPropCounts).toStrictEqual({ ...expectation.changedPropCounts });
      expect([...Object.keys(stat.changedPropCounts)].sort()).toStrictEqual(
        [...expectation.changedPropKeys].sort(),
      );
    },
  );

  it.each(CORPUS_STAT_EXPECTATIONS)(
    'resolves the declaration of $component from its own renders',
    (expectation) => {
      const stat = statFor(aggregateRenders(corpusEvents()), expectation.component);

      const source = requireDefined(stat.source, `a source location for ${expectation.component}`);
      expect(source.file).toBe(expectation.sourceFile);
      expect(source.symbol).toBe(expectation.component);
      expect(source.resolvedBy).toBe(CORPUS_RESOLVED_BY);
      expect(source.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE[CORPUS_RESOLVED_BY]);
    },
  );

  it.each(CORPUS_STAT_EXPECTATIONS)(
    'lists the individual renders of $component, earliest first',
    (expectation) => {
      const stat = statFor(aggregateRenders(corpusEvents()), expectation.component);

      expect(stat.occurrences).toHaveLength(expectation.occurrenceEventIds.length);
      expect(stat.occurrencesTruncated).toBe(false);
      expect(stat.occurrences.map((occurrence) => occurrence.eventId)).toStrictEqual([
        ...expectation.occurrenceEventIds,
      ]);
      expect(stat.occurrences.map((occurrence) => occurrence.id)).toStrictEqual([
        ...expectation.occurrenceEventIds,
      ]);
      // Each render's parent is the commit that performed it, which is how a
      // panel jumps from a render row to the commit on the timeline.
      expect(stat.occurrences.map((occurrence) => occurrence.parentSpanId)).toStrictEqual([
        ...expectation.occurrenceParentSpanIds,
      ]);
      expect(stat.occurrences.map((occurrence) => occurrence.trigger)).toStrictEqual([
        ...expectation.occurrenceTriggers,
      ]);
      expect(stat.occurrences.map((occurrence) => occurrence.startTime)).toStrictEqual([
        expectation.firstStartTime,
        expectation.lastStartTime,
      ]);
      for (const occurrence of stat.occurrences) {
        expect(occurrence.traceId).toBe(CORPUS_TRACE_ID);
      }
    },
  );

  it('summarizes the whole capture into the three render metrics', () => {
    const events = corpusEvents();

    const summary = summarizeRenderTriggers(events);

    // The `render_count`, `unchanged_render_count` and
    // `render_trigger_unknown_count` cards of AAP 0.6.5' render panel, over a
    // capture the repository ships rather than over a builder's output.
    expect(summary.renderCount).toBe(CORPUS_RENDER_EVENT_COUNT);
    expect(summary.unchangedRenderCount).toBe(CORPUS_UNCHANGED_RENDER_COUNT);
    expect(summary.unknownTriggerCount).toBe(CORPUS_UNKNOWN_TRIGGER_COUNT);
    expect(summary.componentCount).toBe(CORPUS_STAT_EXPECTATIONS.length);
    expectTriggerHistogram(summary.byTrigger, {
      [PROPS_TRIGGER]: 1,
      [STATE_TRIGGER]: 1,
      [CONTEXT_TRIGGER]: 1,
      [UNCHANGED_TRIGGER]: CORPUS_UNCHANGED_RENDER_COUNT,
      [UNKNOWN_TRIGGER]: CORPUS_UNKNOWN_TRIGGER_COUNT,
    });
    // The histogram accounts for every render, with nothing double-counted.
    expect(RENDER_TRIGGERS.reduce((total, trigger) => total + summary.byTrigger[trigger], 0)).toBe(
      summary.renderCount,
    );
  });

  it('summarizes the capture identically from events and from statistics', () => {
    const events = corpusEvents();

    const fromEvents = summarizeRenderTriggers(events);
    const fromStats = summarizeRenderTriggers(aggregateRenders(events));

    expect(fromStats).toStrictEqual(fromEvents);
    expect(
      CORPUS_STAT_EXPECTATIONS.reduce(
        (total, expectation) => total + expectation.unchangedRenderCount,
        0,
      ),
    ).toBe(fromEvents.unchangedRenderCount);
    expect(
      CORPUS_STAT_EXPECTATIONS.reduce(
        (total, expectation) => total + expectation.unknownTriggerCount,
        0,
      ),
    ).toBe(fromEvents.unknownTriggerCount);
  });

  it('builds the component tree from the last commit of the corpus', () => {
    const snapshot = requireSnapshot(buildComponentTreeSnapshot(corpusEvents()));

    expect(snapshot.origin).toBe(COMMIT_SNAPSHOT_ORIGIN);
    expect(snapshot.degraded).toBe(false);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.capturedAt).toBe(CORPUS_LAST_COMMIT_START_TIME);
    expect(snapshot.commitEventId).toBe(CORPUS_LAST_COMMIT_EVENT_ID);
    expect(snapshot.commitSpanId).toBe(CORPUS_LAST_COMMIT_SPAN_ID);
    expect(snapshot.traceId).toBe(CORPUS_TRACE_ID);
    expect(snapshot.nodeCount).toBe(CORPUS_TREE_EXPECTATIONS.length);
    expect(snapshot.maxDepth).toBe(CORPUS_TREE_EXPECTATIONS.length - 1);
  });

  it('emits the corpus structure as one keyed chain, parents before children', () => {
    const snapshot = requireSnapshot(buildComponentTreeSnapshot(corpusEvents()));

    const nodes = allNodes(snapshot);
    expect(nodes.map((node) => node.component)).toStrictEqual(
      CORPUS_TREE_EXPECTATIONS.map((expectation) => expectation.component),
    );
    expect(nodes.map((node) => node.key)).toStrictEqual(
      CORPUS_TREE_EXPECTATIONS.map((expectation) => expectation.key),
    );
    expect(nodes.map((node) => node.depth)).toStrictEqual(
      CORPUS_TREE_EXPECTATIONS.map((expectation) => expectation.depth),
    );
    // A node's id is its root-first path, each segment carrying the key the
    // structure supplied. The corpus' structure is one chain, so every id
    // extends its parent's — derived here rather than restated, so the
    // expectation follows the corpus if a level is added to it.
    const expectedIds: string[] = [];
    for (const expectation of CORPUS_TREE_EXPECTATIONS) {
      const segment = `${expectation.component}[${expectation.key}]`;
      const parentId = expectedIds[expectedIds.length - 1];
      expectedIds.push(
        parentId === undefined
          ? `${COMPONENT_TREE_NODE_ID_PREFIX}${segment}`
          : `${parentId}/${segment}`,
      );
    }
    expect(nodes.map((node) => node.id)).toStrictEqual(expectedIds);
    expect(requireDefined(snapshot.roots[0], 'the root node').children).toHaveLength(1);
  });

  it.each(CORPUS_TREE_EXPECTATIONS)(
    'annotates $component with its cumulative evidence from the whole capture',
    (expectation) => {
      const snapshot = requireSnapshot(buildComponentTreeSnapshot(corpusEvents()));
      const stats = aggregateRenders(corpusEvents());

      const node = nodeFor(snapshot, expectation.component);
      expect(node.renderCount).toBe(expectation.renderCount);
      expect(node.totalDurationMs).toBe(expectation.totalDurationMs);
      expect(node.lastTrigger).toBe(expectation.lastTrigger);
      expect(requireDefined(node.source, `a source for ${expectation.component}`).file).toBe(
        expectation.sourceFile,
      );
      // A node's numbers are that component's row, not the last commit's slice
      // of it: the two views of one capture cannot disagree.
      const stat = statFor(stats, expectation.component);
      expect(node.renderCount).toBe(stat.renderCount);
      expect(node.totalDurationMs).toBe(stat.totalDurationMs);
    },
  );

  it('leaves the corpus untouched, so no case can depend on another having run', () => {
    const events = corpusEvents();
    deepFreeze(events);

    const stats = aggregateRenders(events);
    const snapshot = requireSnapshot(buildComponentTreeSnapshot(events));

    expect(stats).toHaveLength(CORPUS_STAT_EXPECTATIONS.length);
    expect(snapshot.nodeCount).toBe(CORPUS_TREE_EXPECTATIONS.length);
    expect(corpusEvents()).toStrictEqual(corpusEvents());
  });

  it('answers the whole capture without carrying one captured value', () => {
    const events = corpusEvents();
    const previews = capturedPreviews(events.map((event) => event.attributes));

    expect(previews).toHaveLength(CORPUS_PREVIEW_COUNT);
    expectNoCapturedValueEscapes(
      {
        stats: aggregateRenders(events),
        summary: summarizeRenderTriggers(events),
        tree: buildComponentTreeSnapshot(events),
      },
      previews,
    );
  });
});

/*
 * ---------------------------------------------------------------------------
 * The committed props and state corpus
 *
 * `redaction-props-state.json` exists because a captured prop and a captured
 * hook value are the two places a real user's data can enter telemetry. AAP
 * 0.5.2 bounds what a producer may keep — key names plus a type and a summary
 * truncated to 120 characters, never a full value — and bounds this module
 * more tightly still: only the *names* travel, because a render statistic is
 * evidence about identity churn and needs no value to make its point.
 *
 * Both phases of the corpus are aggregated here. `before` is what the producer
 * sent, previews and all; `after` is what the redactor left behind. The two
 * must produce the same statistic, because every fact this module publishes is
 * a key-level fact — and neither phase's previews may appear in it.
 * ---------------------------------------------------------------------------
 */

describe('the committed props and state corpus', () => {
  it.each(['before', 'after'] as const)(
    'parses the %s phase through the ingress schema',
    (phase) => {
      const ingress = propsStateIngress(phase);

      expect(ingress).toHaveLength(2);
      // A render, then a hook-state change. The second kind is resolved the
      // way this file resolves every vocabulary member — by its membership,
      // not by its spelling: what matters is that it is a declared kind the
      // render group does not contain, because that is what obliges the
      // aggregate to ignore it and its two captured values.
      const [renderEvent, stateEvent] = ingress;
      expect(requireDefined(renderEvent, 'the corpus render event').kind).toBe(RENDER_KIND);
      const stateKind = requireDefined(stateEvent, 'the corpus state event').kind;
      expect(TELEMETRY_KINDS).toContain(stateKind);
      expect(RENDER_KINDS).not.toContain(stateKind);
      // Ingress, not persisted: a producer sends none of the three attribution
      // fields, and the strict ingress schema is what enforces that.
      for (const event of ingress) {
        expect(Object.hasOwn(event, 'sessionId')).toBe(false);
        expect(Object.hasOwn(event, 'captureId')).toBe(false);
        expect(Object.hasOwn(event, 'ingestSeq')).toBe(false);
      }
      expect(capturedPreviews(ingress.map((event) => event.attributes))).toHaveLength(
        PROPS_STATE_PREVIEW_COUNT,
      );
    },
  );

  it('records in the after phase exactly which attribute paths were rewritten', () => {
    const [render, state] = propsStateIngress('after');

    expect(requireDefined(render, 'the redacted render event').redacted).toStrictEqual([
      ...PROPS_STATE_RENDER_REDACTED_PATHS,
    ]);
    expect(requireDefined(state, 'the redacted state event').redacted).toStrictEqual([
      ...PROPS_STATE_STATE_REDACTED_PATHS,
    ]);
    for (const event of propsStateIngress('before')) {
      expect(event.redacted).toBeUndefined();
    }
  });

  it('attributes the corpus the way the service does at ingest', () => {
    const events = propsStateEvents('before');

    // AAP 0.2.3: `sessionId`, `captureId` and `ingestSeq` are added by
    // attribution at ingest and by nothing else, so the suite adds them here
    // and re-validates against the persisted schema rather than teaching the
    // aggregate to accept an unattributed event.
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(isTelemetryEvent(event)).toBe(true);
      expect(event.sessionId).toBe(SESSION_ID);
      expect(event.captureId).toBe(CAPTURE_ID);
    }
    expect(events.map((event) => event.ingestSeq)).toStrictEqual([1, 2]);
  });

  it.each(['before', 'after'] as const)(
    'reports the changed prop names and counts of the %s phase',
    (phase) => {
      const stat = onlyStat(aggregateRenders(propsStateEvents(phase)));

      expect(stat.component).toBe(PROPS_STATE_RENDER_COMPONENT);
      expect(stat.renderCount).toBe(1);
      expect(stat.changedPropKeys).toStrictEqual([...PROPS_STATE_CHANGED_PROP_KEYS]);
      expect(stat.changedPropCounts).toStrictEqual(
        Object.fromEntries(PROPS_STATE_CHANGED_PROP_KEYS.map((key) => [key, 1] as const)),
      );
      expect(onlyOccurrence(stat).changedPropKeys).toStrictEqual([
        ...PROPS_STATE_CHANGED_PROP_KEYS,
      ]);
      expectSoleTrigger(stat, PROPS_TRIGGER);
    },
  );

  it('counts the state event towards nothing, so no hook value can reach a row', () => {
    const events = propsStateEvents('before');

    const stats = aggregateRenders(events);
    const summary = summarizeRenderTriggers(events);

    // The corpus' state event names a different component from its render. A
    // row for it would mean this module had started reading state events —
    // which carry a previous and a next value — into the render panel.
    expect(stats.map((stat) => stat.component)).toStrictEqual([PROPS_STATE_RENDER_COMPONENT]);
    expect(stats.map((stat) => stat.component)).not.toContain(PROPS_STATE_STATE_COMPONENT);
    expect(summary.componentCount).toBe(1);
    expect(summary.renderCount).toBe(1);
  });

  it.each(['before', 'after'] as const)(
    'lets no captured prop or state value out of the %s phase',
    (phase) => {
      const events = propsStateEvents(phase);
      const previews = capturedPreviews(events.map((event) => event.attributes));

      expect(previews).toHaveLength(PROPS_STATE_PREVIEW_COUNT);
      expectNoCapturedValueEscapes(
        {
          stats: aggregateRenders(events),
          summary: summarizeRenderTriggers(events),
          tree: buildComponentTreeSnapshot(events),
        },
        previews,
      );
      // Non-vacuous: every key-level fact really is published, which is what
      // makes the absence of the values above meaningful rather than empty.
      const serializedStats = JSON.stringify(aggregateRenders(events));
      for (const key of PROPS_STATE_CHANGED_PROP_KEYS) {
        expect(serializedStats, `changed prop name "${key}" must be reported`).toContain(key);
      }
    },
  );

  it('aggregates the redacted copies to the same statistic as the originals', () => {
    // Every fact this module publishes about a changed prop is its name, and
    // the redactor rewrote only previews — so the two phases are one answer.
    // A difference here would mean a value had been load-bearing.
    const before = propsStateEvents('before');
    const after = propsStateEvents('after');

    expect(aggregateRenders(after)).toStrictEqual(aggregateRenders(before));
    expect(summarizeRenderTriggers(after)).toStrictEqual(summarizeRenderTriggers(before));
    expect(buildComponentTreeSnapshot(after)).toStrictEqual(buildComponentTreeSnapshot(before));
  });
});
