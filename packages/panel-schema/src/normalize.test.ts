/**
 * Colocated tests for `./normalize.ts` — step 2 of panel generation, and the
 * integrity boundary that keeps authored prose out of a panel's findings.
 *
 * ## The two assertions this file exists for
 *
 * AAP §0.2.3 names them, and everything else below supports them:
 *
 * 1. **The authoring example normalizes to an exact expected object.** The
 *    panel example of AAP §0.1.2 is parsed through the authoring schema and the
 *    normalised document is compared against a complete literal — not against
 *    a partial `objectContaining`, which would pass over a stray extra key, a
 *    silently dropped field or a query the normaliser assembled differently
 *    from the way it documents. The literal also pins the *shape* of the
 *    translation the AAP specifies: flat `source`/`filter`/`sort` lifted into
 *    `query`, the metric-tile node's implicit `{ source: 'metrics' }` supplied
 *    from the catalog while `metrics` stays the node's own option, and the
 *    authored string summary stored as the non-evidentiary `summary.headline`.
 * 2. **Unrelated event ids cannot substantiate a headline.** An authored
 *    summary is handed everything it would need to manufacture evidence —
 *    confident statements, evidence arrays of ids that appear nowhere in the
 *    capture, confidences, suggested locations — and the normalised document
 *    must carry none of it. The property, stated plainly: *a headline is
 *    non-evidentiary prose, and a panel's facts come only from the validated
 *    analysis*, so an authored evidence reference substantiates nothing because
 *    the prose it was attached to arrives as prose and leaves as one line of
 *    text. That is what makes "a string can never become a `Fact`" true rather
 *    than merely intended.
 *
 * ## Why the supporting assertions are here too
 *
 * `normalizePanel` sits between a model and two things that must not be
 * surprised by it: the internal schema at step 3, and the store that persists
 * the document as JSON. So this suite also holds the normaliser to the
 * properties its own documentation promises, each of which is a real failure
 * mode rather than a restatement of the code:
 *
 * - **The pipeline joint.** Every well-formed input in this file is normalised
 *   *and* validated through {@link normalizeValid}. AAP §0.5.3 makes a step-3
 *   failure on a well-formed authored panel a product bug that sends a real run
 *   down the deterministic fallback path — a worse answer to the developer's
 *   question than the panel that was almost generated — so the joint is
 *   asserted on every input rather than once.
 * - **Determinism and purity.** Equal arguments produce equal documents, and
 *   equal documents serialise byte-identically; nothing is read from a clock or
 *   a random source (asserted mechanically, by making both throw); no argument
 *   is mutated and no mutable structure is shared with the input. A panel is
 *   regenerated as the next version of the same session, so an id or an order
 *   that moved between two runs would make two stored panels incomparable.
 * - **Query lifting precedence.** The two authored spellings of a data request
 *   complete each other per key, and the checks are presence-based rather than
 *   truthiness-based: `limit: 0`, `offset: 0` and `filter.minDuration: 0` are
 *   meaningful requests that a `||` would silently discard.
 * - **Node identity.** Ids are the node's path, which is also the path the
 *   walker and every validation issue report, so they are asserted as the
 *   literal strings the implementation documents.
 *
 * ## Conventions
 *
 * Node environment, `globals: false` (the root `vitest.config.ts` project
 * `panel-schema`), no DOM, no `node:` builtin and **no fixture file**
 * (AAP §0.2.5): every input, analysis and context below is a literal or a small
 * builder in this file, and the authoring example is written out here rather
 * than imported from a sibling suite, because this package has no fixtures
 * module and test files do not import one another.
 *
 * One deliberate structural point, so that a later reader does not "fix" it:
 * the analyses below are plain objects satisfying
 * {@link NormalizeAnalysis} — `{ observed: Fact[]; likelyCauses: Hypothesis[] }`
 * — and **not** `AnalysisResult`. That type belongs to `@debuggen/protocol`,
 * which sits *above* this package in the acyclic package graph (AAP §0.2.2) and
 * composes this package's `Fact` and `Hypothesis` into its own analysis and
 * message types. An import in the other direction would close a cycle; the
 * structural compatibility is the design, not an omission.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DebuggenError } from '@debuggen/shared';

import { PANEL_NODE_CATALOG } from './catalog.js';
import { parsePanelSpecInput } from './input.js';
import type { PanelNodeInput, PanelSpecInput, StackNodeInput } from './input.js';
import { normalizePanel } from './normalize.js';
import type { NormalizeAnalysis, NormalizeContext } from './normalize.js';
import { PANEL_NODE_ID_MAX_LENGTH } from './nodes/query.js';
import { PANEL_SPEC_VERSION, parsePanelSpec } from './spec.js';
import type { PanelNode, PanelSpec } from './spec.js';
import { MAX_HEADLINE_LENGTH } from './summary.js';
import type { Fact, Hypothesis } from './summary.js';
import { PANEL_MAX_NODE_DEPTH, validatePanelSpec } from './validate.js';

/*
 * ---------------------------------------------------------------------------
 * The fixed context and analysis
 *
 * Both are literals, and that is a requirement rather than a convenience:
 * `newPanelId()` would make the exact-object assertion impossible, and an
 * analysis assembled from a generator would let a drift in the generator pass
 * for a drift in the normaliser. The ids are written in the shape
 * `@debuggen/shared`'s factories produce — `/^[a-z]{3}_[0-9a-z]{16}$/` with the
 * `pnl_` and `ses_` prefixes — so they read as real identifiers while staying
 * fixed.
 * ---------------------------------------------------------------------------
 */

/** The panel identity every assertion in this file expects to see carried through. */
const PANEL_ID = 'pnl_3f8k2q7m1z0x9c4v';

/** The session the panels below belong to. */
const SESSION_ID = 'ses_7m2q9k4x1z8c0v3f';

/** The id of an earlier panel, for the regeneration case. */
const SUPERSEDED_PANEL_ID = 'pnl_1z0x9c4v3f8k2q7m';

/** The context of a session's first generated panel: no `supersedes`, no fallback. */
const CONTEXT: NormalizeContext = {
  id: PANEL_ID,
  sessionId: SESSION_ID,
  panelVersion: 1,
};

/**
 * The first observed fact of the analysis.
 *
 * Generic prose and generic event ids throughout this file: nothing here names
 * a component, a route or a symbol of any application, because a test is also
 * product source as far as AAP §0.5.4's rule against embedded demo knowledge is
 * concerned, and a statement that named one would read as knowledge the
 * pipeline is supposed to discover.
 */
const FACT_ONE: Fact = {
  statement: 'One span accounted for most of the recorded duration of the interaction.',
  evidence: [
    { eventId: 'evt_9x4k1m7q2z0c8v3f', kind: 'interaction' },
    { eventId: 'evt_2z0c8v3f9x4k1m7q', kind: 'db.query' },
  ],
};

/** The second observed fact, with a single citation. */
const FACT_TWO: Fact = {
  statement: 'Four records of the same kind were captured inside one interaction window.',
  evidence: [{ eventId: 'evt_7q2z0c8v3f9x4k1m' }],
};

/** The one likely cause of the analysis, ranked and pointing at a location. */
const HYPOTHESIS_ONE: Hypothesis = {
  statement: 'The work was performed one step at a time although the steps are independent.',
  evidence: [{ eventId: 'evt_9x4k1m7q2z0c8v3f', label: 'the interaction record' }],
  confidence: 'medium',
  suggestedLocation: {
    file: 'src/module/example.ts',
    line: 42,
    column: 3,
    symbol: 'exampleSymbol',
    resolvedBy: 'code-graph',
    confidence: 0.6,
  },
};

/** The validated analysis every assertion measures a summary against. */
const ANALYSIS: NormalizeAnalysis = {
  observed: [FACT_ONE, FACT_TWO],
  likelyCauses: [HYPOTHESIS_ONE],
};

/**
 * An analysis that found nothing.
 *
 * The degenerate direction of the integrity boundary: where the analysis holds
 * no findings, a panel holds no findings, however much an author wrote.
 */
const EMPTY_ANALYSIS: NormalizeAnalysis = {
  observed: [],
  likelyCauses: [],
};

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

/**
 * Parse an authored value through the real step-1 schema, failing the test with
 * the schema's own message if it does not pass.
 *
 * Every case that can go through the parser does, so the suite exercises the
 * step-1 → step-2 joint rather than a hand-built input object that no model
 * output could produce.
 */
function parseInput(value: unknown): PanelSpecInput {
  const parsed = parsePanelSpecInput(value);

  if (!parsed.ok) {
    throw new Error(`the authored panel did not parse: ${parsed.error.message}`);
  }

  return parsed.value;
}

/**
 * Normalize, then assert the pipeline joint, then return **the normalised
 * value** — not the validator's parsed copy, so every assertion afterwards sees
 * exactly what `normalizePanel` produced, keys, order and all.
 */
function normalizeValid(
  input: PanelSpecInput,
  analysis: NormalizeAnalysis = ANALYSIS,
  context: NormalizeContext = CONTEXT,
): PanelSpec {
  const spec = normalizePanel(input, analysis, context);
  const validated = validatePanelSpec(spec);

  if (!validated.ok) {
    throw new Error(
      `normalisation produced a document step 3 rejected: ${validated.error.message}`,
    );
  }

  return spec;
}

/** Wrap a layout in the two other authored fields, so a case states only its nodes. */
function inputWith(layout: readonly PanelNodeInput[]): PanelSpecInput {
  return {
    title: 'Interaction latency',
    summary: 'One step of the interaction held most of the recorded time.',
    layout: [...layout],
  };
}

/** The node at one top-level position, without an unchecked index access. */
function nodeAt(spec: PanelSpec, index: number): PanelNode {
  const node = spec.layout[index];

  if (node === undefined) {
    throw new Error(`the layout has no node at index ${String(index)}`);
  }

  return node;
}

/** The children of a container node, or a failure naming the node that had none. */
function childrenOf(node: PanelNode): readonly PanelNode[] {
  if (!('children' in node)) {
    throw new Error(`node ${node.id} is a ${node.type}, which has no children`);
  }

  return node.children;
}

/** One child of a container, without an unchecked index access. */
function childAt(node: PanelNode, index: number): PanelNode {
  const child = childrenOf(node)[index];

  if (child === undefined) {
    throw new Error(`node ${node.id} has no child at index ${String(index)}`);
  }

  return child;
}

/**
 * Narrow a node to one type, failing the test rather than the compiler when the
 * normaliser emitted something else.
 *
 * The assertion is the narrowing TypeScript cannot perform through a generic
 * comparison; the runtime check above it is what makes it sound.
 */
function nodeOfType<TType extends PanelNode['type']>(
  node: PanelNode,
  type: TType,
): Extract<PanelNode, { type: TType }> {
  if (node.type !== type) {
    throw new Error(`expected a ${type} node at ${node.id}, found a ${node.type}`);
  }

  return node as Extract<PanelNode, { type: TType }>;
}

/**
 * A deep copy, for the purity assertions.
 *
 * `JSON` rather than `structuredClone`: this package's compiler project sets no
 * ambient `types`, so no platform global is in scope — and every value cloned
 * here is JSON-safe by construction, which the round-trip assertion proves
 * independently.
 */
function deepClone<TValue>(value: TValue): TValue {
  return JSON.parse(JSON.stringify(value)) as TValue;
}

/** Restores the clock and randomness spies of the determinism block. */
afterEach(() => {
  vi.restoreAllMocks();
});

/*
 * ---------------------------------------------------------------------------
 * Assertion 1 — the authoring example of AAP §0.1.2
 * ---------------------------------------------------------------------------
 */

/**
 * The trace-id placeholder the AAP's example carries.
 *
 * An author writes a panel before the capture it describes exists, so the
 * placeholder is the realistic value, and the normaliser must pass it through
 * untouched: rewriting, padding or inventing a trace id would be inventing
 * evidence. `./semantic.ts` is the layer that resolves it against a capture.
 */
const EXAMPLE_TRACE_PLACEHOLDER = '...';

/** The four metric ids the example asks for, in the order it lists them. */
const EXAMPLE_METRICS = [
  'total_duration',
  'frontend_duration',
  'backend_duration',
  'database_duration',
] as const;

/** The authored title of the example. */
const EXAMPLE_TITLE = 'Checkout Latency';

/** The authored summary of the example: one sentence, the ordinary form. */
const EXAMPLE_SUMMARY = 'Most latency occurs in the inventory database query.';

/**
 * The panel example of AAP §0.1.2, written out verbatim as `unknown`.
 *
 * Typed `unknown` on purpose: it goes through {@link parseInput} exactly as a
 * model's structured output would, so the assertion below covers the authoring
 * schema's acceptance of this shape *and* the normaliser's reading of it.
 */
const AUTHORING_EXAMPLE: unknown = {
  title: EXAMPLE_TITLE,
  summary: EXAMPLE_SUMMARY,
  layout: [
    {
      type: 'timeline',
      source: 'trace',
      filter: {
        traceId: EXAMPLE_TRACE_PLACEHOLDER,
      },
    },
    {
      type: 'metricCards',
      metrics: [...EXAMPLE_METRICS],
    },
    {
      type: 'table',
      title: 'Slowest Operations',
      source: 'spans',
      sort: 'duration_desc',
    },
  ],
};

/**
 * What the example must normalize to, in full.
 *
 * Written out as one literal because that is the assertion: a complete document
 * catches an extra key, a dropped field and a moved value, where a partial
 * check catches none of the three. Every value in it is traceable — the
 * identifiers come from {@link CONTEXT}, the findings from {@link ANALYSIS}, the
 * title, headline, metrics, sources and sort from the authored example, and the
 * node ids from each node's position in the layout.
 */
const EXPECTED_EXAMPLE_SPEC: PanelSpec = {
  version: 1,
  id: PANEL_ID,
  sessionId: SESSION_ID,
  panelVersion: 1,
  title: EXAMPLE_TITLE,
  summary: {
    headline: EXAMPLE_SUMMARY,
    observed: [FACT_ONE, FACT_TWO],
    likelyCauses: [HYPOTHESIS_ONE],
  },
  layout: [
    {
      type: 'timeline',
      id: 'layout.0',
      query: {
        source: 'trace',
        filter: { traceId: EXAMPLE_TRACE_PLACEHOLDER },
      },
    },
    {
      type: 'metricCards',
      id: 'layout.1',
      query: { source: 'metrics' },
      metrics: [...EXAMPLE_METRICS],
    },
    {
      type: 'table',
      id: 'layout.2',
      title: 'Slowest Operations',
      query: {
        source: 'spans',
        sort: 'duration_desc',
      },
    },
  ],
};

describe('normalizePanel with the AAP §0.1.2 authoring example', () => {
  it('accepts the example through the authoring schema unchanged', () => {
    const parsed = parsePanelSpecInput(AUTHORING_EXAMPLE);

    // Asserted separately from the normalisation so that a step-1 regression
    // reports itself as one rather than as a mysterious normalisation failure.
    expect(parsed.ok).toBe(true);
  });

  it('normalizes the example to the exact expected document', () => {
    const spec = normalizeValid(parseInput(AUTHORING_EXAMPLE));

    expect(spec).toEqual(EXPECTED_EXAMPLE_SPEC);

    // `toEqual` passes over a key whose value is `undefined`; `toStrictEqual`
    // does not. Both run, so neither a missing field nor a present-but-undefined
    // one can survive this test.
    expect(spec).toStrictEqual(EXPECTED_EXAMPLE_SPEC);
  });

  it('carries the document format version and the context identifiers', () => {
    const spec = normalizeValid(parseInput(AUTHORING_EXAMPLE));

    expect(spec.version).toBe(PANEL_SPEC_VERSION);
    expect(spec.id).toBe(PANEL_ID);
    expect(spec.sessionId).toBe(SESSION_ID);
    expect(spec.panelVersion).toBe(CONTEXT.panelVersion);
  });

  it('adds neither a supersedes nor a meta key to a first, non-fallback panel', () => {
    const spec = normalizeValid(parseInput(AUTHORING_EXAMPLE));

    // Absence, not `undefined`: a stored document must read back exactly as it
    // was written, and `'supersedes' in spec` is the only form that tells the
    // two apart.
    expect('supersedes' in spec).toBe(false);
    expect('meta' in spec).toBe(false);
  });

  it('writes the document and its summary in the documented field order', () => {
    const spec = normalizeValid(parseInput(AUTHORING_EXAMPLE));

    // Field order is a documented property of the normaliser, not an accident:
    // it is what makes two panels with equal content serialise identically
    // however the author ordered their keys.
    expect(Object.keys(spec)).toEqual([
      'version',
      'id',
      'sessionId',
      'panelVersion',
      'title',
      'summary',
      'layout',
    ]);
    expect(Object.keys(spec.summary)).toEqual(['headline', 'observed', 'likelyCauses']);
  });

  it('derives every node id from the node position in the layout', () => {
    const spec = normalizeValid(parseInput(AUTHORING_EXAMPLE));

    expect(spec.layout.map((node) => node.id)).toEqual(['layout.0', 'layout.1', 'layout.2']);
  });

  it('lifts the flat source and filter of the timeline node into its query', () => {
    const spec = normalizeValid(parseInput(AUTHORING_EXAMPLE));
    const timeline = nodeOfType(nodeAt(spec, 0), 'timeline');

    expect(timeline.query).toStrictEqual({
      source: 'trace',
      filter: { traceId: EXAMPLE_TRACE_PLACEHOLDER },
    });
    expect(Object.keys(timeline)).toEqual(['type', 'id', 'query']);
  });

  it('keeps metrics as the node option and never moves it into the query', () => {
    const spec = normalizeValid(parseInput(AUTHORING_EXAMPLE));
    const cards = nodeOfType(nodeAt(spec, 1), 'metricCards');

    // The single most likely implementation slip: the ids to show are what the
    // node draws, not which evidence it reads, so they stay on the node.
    expect(cards.metrics).toEqual([...EXAMPLE_METRICS]);
    expect(cards.query).toStrictEqual({ source: 'metrics' });
    expect('metrics' in cards.query).toBe(false);
    expect(Object.keys(cards.query)).toEqual(['source']);
  });

  it('takes the implicit metrics source from the catalog rather than a node-type branch', () => {
    // The datum that supplies the implicit source. If this entry ever loses its
    // default the metric-tile node must stop acquiring a query — and if the
    // node keeps one anyway, the normaliser has grown a branch on the node type
    // that AAP §0.5.4 forbids, whether or not the output happens to be right.
    expect(PANEL_NODE_CATALOG.metricCards.defaultSource).toBe('metrics');

    // Every other query-backed node type has no default, which is why the
    // timeline and table nodes above had to name their own source.
    expect(PANEL_NODE_CATALOG.timeline.defaultSource).toBeUndefined();
    expect(PANEL_NODE_CATALOG.table.defaultSource).toBeUndefined();
  });

  it('preserves the authored title of a node and lifts its sort', () => {
    const spec = normalizeValid(parseInput(AUTHORING_EXAMPLE));
    const table = nodeOfType(nodeAt(spec, 2), 'table');

    expect(table.title).toBe('Slowest Operations');
    expect(table.query).toStrictEqual({ source: 'spans', sort: 'duration_desc' });
    expect(Object.keys(table)).toEqual(['type', 'id', 'title', 'query']);
  });

  it('stores the authored string summary as the headline and takes the findings from the analysis', () => {
    const spec = normalizeValid(parseInput(AUTHORING_EXAMPLE));

    expect(spec.summary.headline).toBe(EXAMPLE_SUMMARY);
    expect(spec.summary.observed).toEqual(ANALYSIS.observed);
    expect(spec.summary.likelyCauses).toEqual(ANALYSIS.likelyCauses);

    // Fresh arrays: the document owns its structure, so a later consumer that
    // sorts a panel's likely causes cannot reorder the stored analysis.
    expect(spec.summary.observed).not.toBe(ANALYSIS.observed);
    expect(spec.summary.likelyCauses).not.toBe(ANALYSIS.likelyCauses);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Assertion 2 — unrelated event ids cannot substantiate a headline
 *
 * The property, in this suite's own words: a headline is **non-evidentiary
 * prose**, and a panel's observed facts and likely causes come **only from the
 * validated analysis** (AAP §0.2.3). That is precisely what makes an authored
 * evidence reference unable to substantiate anything — the prose it was
 * attached to reaches the normaliser without it, and leaves as one line of
 * text. There is no filter to get past and no list to be promoted into: the one
 * function that reads an authored summary returns `string | undefined`.
 *
 * The values below are sentinels rather than plausible content, so that a
 * single `JSON.stringify` check can prove none of them survived anywhere in the
 * document — including somewhere unexpected, such as a node filter or the
 * headline itself.
 * ---------------------------------------------------------------------------
 */

/** The one authored value a panel may keep, and only as `summary.headline`. */
const SENTINEL_HEADLINE = 'Sentinel prose zero nine, the one authored value a panel may keep.';

/** Authored statements dressed as observations. None may reach the document. */
const SENTINEL_OBSERVED_STATEMENTS = [
  'Sentinel observed claim zero one.',
  'Sentinel observed claim zero two.',
] as const;

/** The second sentence of an authored observation. */
const SENTINEL_OBSERVED_DETAIL = 'Sentinel observed detail zero three.';

/** Authored statements dressed as explanations. */
const SENTINEL_CAUSE_STATEMENTS = [
  'Sentinel likely cause zero four.',
  'Sentinel likely cause zero five.',
] as const;

/**
 * Event ids that exist in no capture and in no analysis.
 *
 * The distinctive shape is the point: if one of these appears anywhere in a
 * normalised document, an authored citation has been treated as evidence.
 */
const SENTINEL_EVENT_IDS = [
  'evt_unrelated_0001',
  'evt_unrelated_0002',
  'evt_unrelated_0003',
] as const;

/** An authored confidence. Not a member of the confidence vocabulary, and unused either way. */
const SENTINEL_CONFIDENCE = 'sentinel_confidence_0006';

/** An authored source location, pointing at a file this repository does not contain. */
const SENTINEL_LOCATION_FILE = 'sentinel/unrelated-location-0007.ts';

/** An authored evidence label. */
const SENTINEL_EVENT_LABEL = 'Sentinel evidence label zero eight.';

/** Every sentinel except the headline: the values that must not survive at all. */
const DISCARDED_SENTINELS: readonly string[] = [
  ...SENTINEL_OBSERVED_STATEMENTS,
  SENTINEL_OBSERVED_DETAIL,
  ...SENTINEL_CAUSE_STATEMENTS,
  ...SENTINEL_EVENT_IDS,
  SENTINEL_CONFIDENCE,
  SENTINEL_LOCATION_FILE,
  SENTINEL_EVENT_LABEL,
];

/**
 * An authored summary written as the object branch and stuffed with everything
 * it would need to manufacture findings.
 *
 * `unknown`, because most of these keys are not fields of the authoring schema
 * at all — there is no `evidence`, `confidence` or `suggestedLocation` on an
 * authored statement, which is the first half of the guarantee. The second half
 * is asserted separately, by handing this same object to the normaliser
 * unparsed.
 */
const ADVERSARIAL_SUMMARY: unknown = {
  headline: SENTINEL_HEADLINE,
  observed: [
    {
      statement: SENTINEL_OBSERVED_STATEMENTS[0],
      detail: SENTINEL_OBSERVED_DETAIL,
      evidence: [
        { eventId: SENTINEL_EVENT_IDS[0], label: SENTINEL_EVENT_LABEL },
        { eventId: SENTINEL_EVENT_IDS[1] },
      ],
      confidence: SENTINEL_CONFIDENCE,
    },
    {
      statement: SENTINEL_OBSERVED_STATEMENTS[1],
      evidence: [{ eventId: SENTINEL_EVENT_IDS[2] }],
    },
  ],
  likelyCauses: [
    {
      statement: SENTINEL_CAUSE_STATEMENTS[0],
      confidence: SENTINEL_CONFIDENCE,
      evidence: [{ eventId: SENTINEL_EVENT_IDS[0] }],
      suggestedLocation: {
        file: SENTINEL_LOCATION_FILE,
        line: 7,
        column: 1,
        resolvedBy: 'patch',
        confidence: 1,
      },
    },
    {
      statement: SENTINEL_CAUSE_STATEMENTS[1],
      confidence: SENTINEL_CONFIDENCE,
      evidence: [{ eventId: SENTINEL_EVENT_IDS[1] }],
    },
  ],
};

/** The adversarial summary inside an otherwise ordinary authored panel. */
const ADVERSARIAL_DOCUMENT: unknown = {
  title: 'Interaction latency',
  summary: ADVERSARIAL_SUMMARY,
  layout: [
    { type: 'eventLog', source: 'events' },
    { type: 'metricCards', metrics: ['total_duration'] },
  ],
};

describe('normalizePanel and the integrity boundary', () => {
  it('takes the findings from the analysis when the author supplied their own', () => {
    const spec = normalizeValid(parseInput(ADVERSARIAL_DOCUMENT));

    expect(spec.summary.observed).toHaveLength(ANALYSIS.observed.length);
    expect(spec.summary.observed).toEqual(ANALYSIS.observed);
    expect(spec.summary.likelyCauses).toHaveLength(ANALYSIS.likelyCauses.length);
    expect(spec.summary.likelyCauses).toEqual(ANALYSIS.likelyCauses);
  });

  it('carries no authored statement, citation, confidence or location anywhere in the document', () => {
    const spec = normalizeValid(parseInput(ADVERSARIAL_DOCUMENT));
    const serialised = JSON.stringify(spec);

    // The strongest form of the assertion: the whole document, not just the
    // summary, so an id smuggled into a node filter, a node title or the
    // headline fails this too.
    for (const sentinel of DISCARDED_SENTINELS) {
      expect(serialised).not.toContain(sentinel);
    }
  });

  it('keeps the authored prose only as the headline', () => {
    const spec = normalizeValid(parseInput(ADVERSARIAL_DOCUMENT));

    expect(spec.summary.headline).toBe(SENTINEL_HEADLINE);

    // One occurrence, and it is that one: removing the headline's own
    // serialisation leaves no second copy of the prose behind.
    const serialised = JSON.stringify(spec);
    const withoutHeadline = serialised.replace(JSON.stringify(SENTINEL_HEADLINE), '""');

    expect(withoutHeadline).not.toContain(SENTINEL_HEADLINE);
  });

  it('discards the same authored findings when handed the value unparsed', () => {
    // Step 1 strips the unrecognised keys, which is one guarantee; this is the
    // other, and the one this module owns: even with every field present, the
    // normaliser reads an authored summary for prose and for nothing else.
    const spec = normalizePanel(ADVERSARIAL_DOCUMENT as PanelSpecInput, ANALYSIS, CONTEXT);

    expect(validatePanelSpec(spec).ok).toBe(true);
    expect(spec.summary.observed).toEqual(ANALYSIS.observed);
    expect(spec.summary.likelyCauses).toEqual(ANALYSIS.likelyCauses);
    expect(spec.summary.headline).toBe(SENTINEL_HEADLINE);

    const serialised = JSON.stringify(spec);

    for (const sentinel of DISCARDED_SENTINELS) {
      expect(serialised).not.toContain(sentinel);
    }
  });

  it('never turns an authored string summary into a fact', () => {
    const authored = 'A string summary, which is prose and can never be an observation.';
    const spec = normalizeValid(
      parseInput({
        title: 'Interaction latency',
        summary: authored,
        layout: [{ type: 'eventLog', source: 'events' }],
      }),
    );

    expect(spec.summary.headline).toBe(authored);
    expect(spec.summary.observed.map((fact) => fact.statement)).not.toContain(authored);
    expect(spec.summary.likelyCauses.map((cause) => cause.statement)).not.toContain(authored);

    // And the prose appears exactly once, in the field that holds prose.
    const serialised = JSON.stringify(spec);
    const withoutHeadline = serialised.replace(JSON.stringify(authored), '""');

    expect(withoutHeadline).not.toContain(authored);
  });

  it('yields no findings where the analysis found none, whatever the author wrote', () => {
    const spec = normalizeValid(parseInput(ADVERSARIAL_DOCUMENT), EMPTY_ANALYSIS);

    // A model must not be able to manufacture evidence where the analysis has
    // none: the lists are empty and the prose is still just prose.
    expect(spec.summary.observed).toEqual([]);
    expect(spec.summary.likelyCauses).toEqual([]);
    expect(spec.summary.headline).toBe(SENTINEL_HEADLINE);
  });

  it('omits the headline entirely when an authored summary object carries no prose', () => {
    const spec = normalizeValid(
      parseInput({
        title: 'Interaction latency',
        summary: { observed: [{ statement: SENTINEL_OBSERVED_STATEMENTS[0] }] },
        layout: [{ type: 'eventLog', source: 'events' }],
      }),
    );

    expect('headline' in spec.summary).toBe(false);
    expect(Object.keys(spec.summary)).toEqual(['observed', 'likelyCauses']);
    expect(JSON.stringify(spec)).not.toContain(SENTINEL_OBSERVED_STATEMENTS[0]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Query lifting and precedence
 *
 * The authoring schema accepts a node's data request in two spellings and
 * states the precedence between them: the nested `query` object wins for the
 * keys it declares, and the fields written flat on the node fill the gaps. The
 * internal schema has one spelling, so these cases are the whole of the
 * translation — including the two failure modes a plausible implementation
 * walks into, a whole-object filter replacement and a truthiness check that
 * discards a meaningful zero.
 * ---------------------------------------------------------------------------
 */

describe('normalizePanel query lifting', () => {
  it('lifts a flat-only data request into the query, in the schema field order', () => {
    const spec = normalizeValid(
      parseInput(
        inputWith([
          {
            type: 'table',
            source: 'spans',
            filter: { traceId: 'trace-placeholder-a', tier: 'server' },
            sort: 'start_asc',
            limit: 10,
            offset: 5,
          },
        ]),
      ),
    );
    const table = nodeOfType(nodeAt(spec, 0), 'table');

    expect(table.query).toStrictEqual({
      source: 'spans',
      filter: { traceId: 'trace-placeholder-a', tier: 'server' },
      sort: 'start_asc',
      limit: 10,
      offset: 5,
    });
    expect(Object.keys(table.query)).toEqual(['source', 'filter', 'sort', 'limit', 'offset']);
    expect(Object.keys(table.query.filter ?? {})).toEqual(['traceId', 'tier']);
  });

  it('passes a nested-only data request through unchanged', () => {
    const query = {
      source: 'spans',
      filter: { minDuration: 25.5 },
      sort: 'duration_desc',
      limit: 3,
    } as const;
    const spec = normalizeValid(parseInput(inputWith([{ type: 'table', query: { ...query } }])));
    const table = nodeOfType(nodeAt(spec, 0), 'table');

    expect(table.query).toStrictEqual({ ...query });
  });

  it('prefers the nested query per key and fills the gaps from the flat fields', () => {
    const spec = normalizeValid(
      parseInput(
        inputWith([
          {
            type: 'table',
            // Flat: the source and offset are also declared in the query below
            // and must lose; the limit is declared only here and must survive.
            source: 'events',
            limit: 7,
            offset: 1,
            filter: { traceId: 'trace-placeholder-flat', minDuration: 5 },
            query: {
              source: 'spans',
              sort: 'duration_desc',
              offset: 4,
              filter: { traceId: 'trace-placeholder-query', tier: 'browser' },
            },
          },
        ]),
      ),
    );
    const table = nodeOfType(nodeAt(spec, 0), 'table');

    expect(table.query).toStrictEqual({
      // Declared in both spellings: the query object wins.
      source: 'spans',
      filter: {
        // Declared in both: the query object wins.
        traceId: 'trace-placeholder-query',
        // Declared only inside the query object.
        tier: 'browser',
        // Declared only flat: kept, which is what makes the merge per key
        // rather than a replacement of the whole filter object.
        minDuration: 5,
      },
      // Declared only inside the query object.
      sort: 'duration_desc',
      // Declared only flat.
      limit: 7,
      // Declared in both: the query object wins.
      offset: 4,
    });
  });

  it('treats an explicit undefined inside the query as absent rather than as a blanking', () => {
    // A hand-built input, because this is the shape a caller assembling a panel
    // without the parser can produce — the deterministic fallback path is one.
    const input: PanelSpecInput = inputWith([
      {
        type: 'table',
        source: 'spans',
        sort: 'count_desc',
        limit: 12,
        query: { sort: undefined, limit: undefined },
      },
    ]);
    const spec = normalizeValid(input);
    const table = nodeOfType(nodeAt(spec, 0), 'table');

    expect(table.query).toStrictEqual({ source: 'spans', sort: 'count_desc', limit: 12 });
  });

  it('keeps falsy but valid values through the merge', () => {
    const spec = normalizeValid(
      parseInput(
        inputWith([
          {
            type: 'table',
            source: 'spans',
            limit: 0,
            offset: 0,
            filter: { minDuration: 0 },
          },
          {
            type: 'table',
            source: 'spans',
            limit: 5,
            offset: 9,
            filter: { minDuration: 100 },
            // Zero declared inside the query must beat a non-zero flat value: a
            // truthiness check would keep the flat one and silently widen the
            // page and the duration floor the author asked for.
            query: { limit: 0, offset: 0, filter: { minDuration: 0 } },
          },
        ]),
      ),
    );

    expect(nodeOfType(nodeAt(spec, 0), 'table').query).toStrictEqual({
      source: 'spans',
      filter: { minDuration: 0 },
      limit: 0,
      offset: 0,
    });
    expect(nodeOfType(nodeAt(spec, 1), 'table').query).toStrictEqual({
      source: 'spans',
      filter: { minDuration: 0 },
      limit: 0,
      offset: 0,
    });
  });

  it('drops a filter that narrows nothing instead of storing an empty object', () => {
    const spec = normalizeValid(
      parseInput(inputWith([{ type: 'eventLog', source: 'events', filter: {} }])),
    );
    const log = nodeOfType(nodeAt(spec, 0), 'eventLog');

    // `filter: {}` and no filter at all mean the same thing, so only one of
    // them is ever stored.
    expect(log.query).toStrictEqual({ source: 'events' });
    expect('filter' in log.query).toBe(false);
  });

  it('copies a kinds list rather than sharing the authored array', () => {
    const input: PanelSpecInput = inputWith([
      { type: 'eventLog', source: 'events', filter: { kinds: ['interaction', 'render'] } },
    ]);
    const spec = normalizeValid(input);
    const log = nodeOfType(nodeAt(spec, 0), 'eventLog');
    const authored = input.layout[0];
    const authoredKinds =
      authored !== undefined && 'filter' in authored ? authored.filter?.kinds : undefined;

    expect(log.query.filter?.kinds).toEqual(['interaction', 'render']);
    expect(authoredKinds).toBeDefined();
    expect(log.query.filter?.kinds).not.toBe(authoredKinds);
  });

  it('carries a source-link location through whole and gives the node no query', () => {
    const location = {
      file: 'src/module/example.ts',
      line: 128,
      column: 7,
      symbol: 'exampleSymbol',
      endLine: 140,
      resolvedBy: 'source-map',
      confidence: 0.4,
    } as const;
    const spec = normalizeValid(
      parseInput(
        inputWith([
          { type: 'sourceLink', title: 'Where this resolved', location: { ...location } },
        ]),
      ),
    );
    const link = nodeOfType(nodeAt(spec, 0), 'sourceLink');

    // A rewritten path, line or resolution route would be an invented location,
    // and a location is the one thing a source link must not invent.
    expect(link.location).toStrictEqual({ ...location });
    expect('query' in link).toBe(false);
    expect(Object.keys(link)).toEqual(['type', 'id', 'title', 'location']);
  });

  it('emits no query when no source can be resolved, and step 3 rejects that node', () => {
    // The documented decision: normalisation is not a second validator, so a
    // query-backed node the authoring schema chose not to reject for having no
    // source at all is emitted without a query and reported once, at step 3.
    const input = parseInput(inputWith([{ type: 'eventLog', sort: 'start_asc', limit: 5 }]));

    const spec = normalizePanel(input, ANALYSIS, CONTEXT);
    const log = nodeOfType(nodeAt(spec, 0), 'eventLog');

    expect('query' in log).toBe(false);
    // The sort and limit written beside it are dropped with it rather than
    // scattered onto the node.
    expect(Object.keys(log)).toEqual(['type', 'id']);

    const validated = validatePanelSpec(spec);

    expect(validated.ok).toBe(false);

    if (!validated.ok) {
      expect(validated.error.code).toBe('PANEL_INVALID');
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Layout recursion
 * ---------------------------------------------------------------------------
 */

describe('normalizePanel layout recursion', () => {
  it('derives nested ids from each child path, three containers deep', () => {
    const spec = normalizeValid(
      parseInput(
        inputWith([
          {
            type: 'section',
            title: 'Where the time went',
            children: [
              {
                type: 'split',
                direction: 'vertical',
                children: [
                  {
                    type: 'stack',
                    children: [{ type: 'eventLog', source: 'events' }],
                  },
                  { type: 'table', source: 'spans', sort: 'duration_desc' },
                ],
              },
            ],
          },
        ]),
      ),
    );

    const section = nodeOfType(nodeAt(spec, 0), 'section');
    const split = nodeOfType(childAt(section, 0), 'split');
    const stack = nodeOfType(childAt(split, 0), 'stack');
    const log = nodeOfType(childAt(stack, 0), 'eventLog');
    const table = nodeOfType(childAt(split, 1), 'table');

    // The ids are the paths the walker reports and a validation issue names, so
    // an error at `layout.0.children.0.children.1` can be followed to a node
    // without a lookup table.
    expect(section.id).toBe('layout.0');
    expect(split.id).toBe('layout.0.children.0');
    expect(stack.id).toBe('layout.0.children.0.children.0');
    expect(log.id).toBe('layout.0.children.0.children.0.children.0');
    expect(table.id).toBe('layout.0.children.0.children.1');

    // Every id in the document is distinct, which is what step 3 requires of a
    // path-derived scheme.
    const ids = [section.id, split.id, stack.id, log.id, table.id];

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('preserves a section title and an authored split direction', () => {
    const spec = normalizeValid(
      parseInput(
        inputWith([
          {
            type: 'section',
            title: 'Where the time went',
            description: 'The recorded spans of one interaction.',
            children: [
              {
                type: 'split',
                direction: 'horizontal',
                children: [
                  { type: 'table', source: 'spans' },
                  { type: 'eventLog', source: 'events' },
                ],
              },
            ],
          },
        ]),
      ),
    );
    const section = nodeOfType(nodeAt(spec, 0), 'section');
    const split = nodeOfType(childAt(section, 0), 'split');

    expect(section.title).toBe('Where the time went');
    expect(section.description).toBe('The recorded spans of one interaction.');
    expect(Object.keys(section)).toEqual(['type', 'id', 'title', 'description', 'children']);
    expect(split.direction).toBe('horizontal');
    expect(Object.keys(split)).toEqual(['type', 'id', 'direction', 'children']);
  });

  it('leaves an unauthored split direction absent rather than materialising the default', () => {
    const spec = normalizeValid(
      parseInput(
        inputWith([
          {
            type: 'split',
            children: [
              { type: 'table', source: 'spans' },
              { type: 'eventLog', source: 'events' },
            ],
          },
        ]),
      ),
    );
    const split = nodeOfType(nodeAt(spec, 0), 'split');

    // Storing today's default in every document would make a later change to it
    // invisible to every panel already on disk.
    expect('direction' in split).toBe(false);
    expect(Object.keys(split)).toEqual(['type', 'id', 'children']);
  });

  it('normalizes an empty layout to an empty layout', () => {
    // A capture with nothing worth drawing is a legitimate answer, and both the
    // authoring and the internal schema accept one.
    const spec = normalizeValid(parseInput(inputWith([])));

    expect(spec.layout).toEqual([]);
  });

  it('normalizes the deepest nesting the authoring schema accepts into a document step 3 accepts', () => {
    // The authoring schema and the validator share one depth bound, so the
    // deepest parsed document is one the internal gate must accept too.
    let node: PanelNodeInput = { type: 'table', source: 'spans' };

    for (let level = PANEL_MAX_NODE_DEPTH - 1; level >= 1; level -= 1) {
      node = { type: 'stack', children: [node] };
    }

    const spec = normalizeValid(parseInput(inputWith([node])));
    const [top] = preorderIds(spec.layout);

    expect(top).toBe('layout.0');
    expect(preorderIds(spec.layout)).toHaveLength(PANEL_MAX_NODE_DEPTH);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Layouts no parse produces: deep, cyclic and shared
 *
 * `normalizePanel` accepts a hand-assembled input as well as a parsed one, and
 * nothing bounds the depth of the first kind. These cases hold the walk to its
 * documented contract on inputs the authoring schema would never hand it: any
 * depth normalizes without exhausting the call stack, with the ids a recursive
 * walk would mint; a node inside its own subtree is a defect reported as
 * `INTERNAL`; a node merely shared between positions is normalized once per
 * position.
 * ---------------------------------------------------------------------------
 */

/**
 * The ids of a normalized layout in depth-first pre-order, collected without
 * recursion so the helper itself survives a ten-thousand-level layout.
 */
function preorderIds(layout: readonly PanelNode[]): readonly string[] {
  const ids: string[] = [];
  const pending: PanelNode[] = [...layout].reverse();

  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    ids.push(node.id);

    if ('children' in node) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        const child = node.children[index];

        if (child !== undefined) {
          pending.push(child);
        }
      }
    }
  }

  return ids;
}

/** The fallback form of an id, as `./normalize.ts` documents it. */
function fallbackId(ordinal: number): string {
  return `layout.node-${String(ordinal)}`;
}

/**
 * The id a node takes under the documented rule: its path joined with `.` when
 * that fits the internal id bound, otherwise the fallback form with its
 * pre-order ordinal.
 *
 * Takes the length of the joined path separately so a caller can decide the
 * rule for a node thousands of levels deep without building a path that long.
 */
function expectedId(joinedLength: number, joined: () => string, ordinal: number): string {
  return joinedLength <= PANEL_NODE_ID_MAX_LENGTH ? joined() : fallbackId(ordinal);
}

describe('normalizePanel on layouts no parse produces', () => {
  it('normalizes a ten-thousand-level layout without throwing, with pre-order ids', () => {
    // Every container holds the next container first and a leaf second, so the
    // pre-order visits the whole chain of containers before the first leaf, and
    // the ordinal of each leaf therefore counts the entire chain below it. The
    // expected ids are computed here independently of the implementation: a
    // `.children.0` hop is eleven characters, so the joined path of a chain
    // node at level L is 8 + 11 × (L − 1) long.
    const depth = 10_000;
    let node: PanelNodeInput = { type: 'table', source: 'spans' };

    for (let level = depth - 1; level >= 1; level -= 1) {
      node = { type: 'stack', children: [node, { type: 'eventLog', source: 'events' }] };
    }

    const hop = '.children.0';
    const joinedLengthAt = (level: number): number => 'layout.0'.length + hop.length * (level - 1);
    const expected: string[] = [];

    // The chain, levels 1 to depth, is visited first: ordinals 0 to depth − 1.
    for (let level = 1; level <= depth; level += 1) {
      expected.push(
        expectedId(joinedLengthAt(level), () => `layout.0${hop.repeat(level - 1)}`, level - 1),
      );
    }

    // Then the leaves, deepest first, each the second child of the container
    // one level above it: its joined path is as long as its chain sibling's.
    for (let level = depth; level >= 2; level -= 1) {
      const ordinal = depth + (depth - level);

      expected.push(
        expectedId(
          joinedLengthAt(level),
          () => `layout.0${hop.repeat(level - 2)}.children.1`,
          ordinal,
        ),
      );
    }

    const input = inputWith([node]);
    const normalize = (): PanelSpec => normalizePanel(input, ANALYSIS, CONTEXT);

    expect(normalize).not.toThrow();

    const ids = preorderIds(normalize().layout);

    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.length <= PANEL_NODE_ID_MAX_LENGTH)).toBe(true);
    // Both forms occur, so the assertion above covers the switch between them.
    expect(ids).toContain('layout.0.children.0');
    expect(ids).toContain(fallbackId(depth - 1));
  });

  it('writes every node of a deep layout in the documented field order', () => {
    let node: PanelNodeInput = { type: 'flame', title: 'Innermost', source: 'trace' };

    for (let level = 40; level >= 1; level -= 1) {
      node =
        level % 2 === 0
          ? { type: 'split', direction: 'vertical', children: [node, { type: 'table' }] }
          : { type: 'section', title: 'Level heading', children: [node] };
    }

    const spec = normalizePanel(inputWith([node]), ANALYSIS, CONTEXT);
    const pending: PanelNode[] = [...spec.layout];
    const unexpected: string[] = [];

    for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
      const keys = Object.keys(current).join(',');
      const expected =
        current.type === 'section'
          ? 'type,id,title,children'
          : current.type === 'split'
            ? 'type,id,direction,children'
            : current.type === 'flame'
              ? 'type,id,title,query'
              : 'type,id';

      if (keys !== expected) {
        unexpected.push(`${current.id}: ${keys}`);
      }
      if ('children' in current) {
        pending.push(...current.children);
      }
    }

    expect(unexpected).toEqual([]);
  });

  it('throws an INTERNAL DebuggenError for a node inside its own subtree, never a RangeError', () => {
    // A direct self-reference, and one closed two levels further down.
    const selfChildren: PanelNodeInput[] = [];
    const selfContaining: StackNodeInput = { type: 'stack', children: selfChildren };
    selfChildren.push(selfContaining);

    const outerChildren: PanelNodeInput[] = [{ type: 'table', source: 'spans' }];
    const outer: StackNodeInput = { type: 'stack', children: outerChildren };
    outerChildren.push({
      type: 'section',
      children: [{ type: 'split', children: [{ type: 'table', source: 'spans' }, outer] }],
    });

    for (const [layout, level] of [
      [[selfContaining], 2],
      [[{ type: 'table', source: 'spans' }, outer], 4],
    ] as const) {
      let thrown: unknown;

      try {
        normalizePanel(inputWith(layout), ANALYSIS, CONTEXT);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(DebuggenError);
      expect(thrown).not.toBeInstanceOf(RangeError);
      expect(DebuggenError.is(thrown) ? thrown.code : undefined).toBe('INTERNAL');
      expect(DebuggenError.is(thrown) ? thrown.details : undefined).toEqual({ level });
    }
  });

  it('normalizes a shared subtree once per position, with path-distinct ids', () => {
    // The same authored object at three positions, none of them inside another:
    // not a cycle, so each position is normalized on its own.
    const shared: PanelNodeInput = {
      type: 'section',
      title: 'Shared group',
      children: [{ type: 'table', source: 'spans' }],
    };
    const spec = normalizeValid(inputWith([shared, { type: 'stack', children: [shared, shared] }]));

    expect(preorderIds(spec.layout)).toEqual([
      'layout.0',
      'layout.0.children.0',
      'layout.1',
      'layout.1.children.0',
      'layout.1.children.0.children.0',
      'layout.1.children.1',
      'layout.1.children.1.children.0',
    ]);

    const stack = nodeOfType(nodeAt(spec, 1), 'stack');
    const first = childAt(stack, 0);
    const second = childAt(stack, 1);

    // Two positions, two distinct output objects: the document shares no
    // structure between them, whatever the input shared.
    expect(first).not.toBe(second);
    expect(first).not.toBe(nodeAt(spec, 0));
    expect({ ...first, id: '', children: [] }).toEqual({ ...second, id: '', children: [] });
  });
});

/*
 * ---------------------------------------------------------------------------
 * Determinism, purity and the pipeline joint
 * ---------------------------------------------------------------------------
 */

describe('normalizePanel determinism and purity', () => {
  it('produces equal documents from equal arguments', () => {
    const input = parseInput(AUTHORING_EXAMPLE);

    const first = normalizeValid(input);
    const second = normalizeValid(input);

    expect(first).toEqual(second);
    expect(first).toStrictEqual(second);
  });

  it('serialises byte-identically across calls', () => {
    const input = parseInput(AUTHORING_EXAMPLE);

    // Equality of content is not enough for a document that is stored as JSON
    // and compared between versions: the key order has to be stable too.
    expect(JSON.stringify(normalizeValid(input))).toBe(JSON.stringify(normalizeValid(input)));
  });

  it('serialises identically however the author ordered their keys', () => {
    const asWritten = normalizeValid(
      parseInput(
        inputWith([
          {
            type: 'table',
            source: 'spans',
            sort: 'duration_desc',
            filter: { traceId: 'trace-placeholder-a', tier: 'server' },
          },
        ]),
      ),
    );
    const reordered = normalizeValid(
      parseInput(
        inputWith([
          {
            type: 'table',
            filter: { tier: 'server', traceId: 'trace-placeholder-a' },
            sort: 'duration_desc',
            source: 'spans',
          },
        ]),
      ),
    );

    expect(JSON.stringify(asWritten)).toBe(JSON.stringify(reordered));
  });

  it('reads no clock and no source of randomness', () => {
    const input = parseInput(AUTHORING_EXAMPLE);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('normalizePanel must not read the clock');
    });
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('normalizePanel must not use randomness');
    });

    // Restored before the assertions run, so a failure message can be rendered
    // by a runner that is itself allowed to read the clock.
    let spec: PanelSpec;

    try {
      spec = normalizePanel(input, ANALYSIS, CONTEXT);
    } finally {
      clock.mockRestore();
      random.mockRestore();
    }

    // Turning the promise into a mechanical guarantee: had either been touched,
    // the call above would have thrown instead of reaching this line.
    expect(clock).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    expect(spec).toStrictEqual(EXPECTED_EXAMPLE_SPEC);
  });

  it('mutates none of its three arguments', () => {
    const input = parseInput(AUTHORING_EXAMPLE);
    const inputBefore = deepClone(input);
    const analysisBefore = deepClone(ANALYSIS);
    const contextBefore = deepClone(CONTEXT);

    const spec = normalizeValid(input);

    expect(input).toEqual(inputBefore);
    expect(ANALYSIS).toEqual(analysisBefore);
    expect(CONTEXT).toEqual(contextBefore);
    expect(spec.title).toBe(EXAMPLE_TITLE);
  });

  it('shares no mutable structure with the authored input', () => {
    const input = parseInput(AUTHORING_EXAMPLE);
    const spec = normalizeValid(input);
    const cards = nodeOfType(nodeAt(spec, 1), 'metricCards');
    const authored = input.layout[1];
    const authoredMetrics =
      authored !== undefined && 'metrics' in authored ? authored.metrics : undefined;

    expect(spec.layout).not.toBe(input.layout);
    expect(authoredMetrics).toEqual([...EXAMPLE_METRICS]);
    expect(cards.metrics).not.toBe(authoredMetrics);

    // The readonly cast is the test's, not the product's: a document is
    // readonly by declaration, and this is how the declaration is shown to be
    // backed by a structure the input does not observe.
    (spec.layout as PanelNode[]).length = 0;

    expect(input.layout).toHaveLength(3);
  });

  it('round-trips through JSON and back through the internal schema', () => {
    const spec = normalizeValid(parseInput(AUTHORING_EXAMPLE));
    const revived: unknown = JSON.parse(JSON.stringify(spec));
    const reparsed = parsePanelSpec(revived);

    // The service persists a panel as JSON in the `panels` table, so a value
    // that did not survive a round trip would corrupt a stored session.
    expect(reparsed.ok).toBe(true);

    if (reparsed.ok) {
      expect(reparsed.value).toEqual(spec);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Document identity and provenance
 *
 * Four fields the author never writes and the normaliser never computes:
 * `id`, `panelVersion`, `supersedes` and `meta` are all the caller's, because
 * version bookkeeping belongs to the service that owns the store.
 * ---------------------------------------------------------------------------
 */

describe('normalizePanel document identity and provenance', () => {
  it('omits meta when the caller states the panel is not a fallback', () => {
    const spec = normalizeValid(parseInput(AUTHORING_EXAMPLE), ANALYSIS, {
      ...CONTEXT,
      fallback: false,
    });

    // Anything other than `true` leaves the key off the document entirely, so
    // an ordinary panel's JSON carries no `meta` at all.
    expect('meta' in spec).toBe(false);
  });

  it('marks a fallback panel, so the renderer can show its banner', () => {
    const spec = normalizeValid(parseInput(AUTHORING_EXAMPLE), ANALYSIS, {
      ...CONTEXT,
      fallback: true,
    });

    expect(spec.meta).toStrictEqual({ fallback: true });
    expect(Object.keys(spec)).toEqual([
      'version',
      'id',
      'sessionId',
      'panelVersion',
      'title',
      'summary',
      'layout',
      'meta',
    ]);
  });

  it('carries supersedes when given, with the panel version exactly as supplied', () => {
    const spec = normalizeValid(parseInput(AUTHORING_EXAMPLE), ANALYSIS, {
      id: PANEL_ID,
      sessionId: SESSION_ID,
      panelVersion: 3,
      supersedes: SUPERSEDED_PANEL_ID,
    });

    expect(spec.supersedes).toBe(SUPERSEDED_PANEL_ID);
    // Normalisation does not compute a version: a follow-up that regenerated
    // this panel supplied the number, and this step does not second-guess it.
    expect(spec.panelVersion).toBe(3);
    expect(Object.keys(spec)).toEqual([
      'version',
      'id',
      'sessionId',
      'panelVersion',
      'supersedes',
      'title',
      'summary',
      'layout',
    ]);
  });

  it('trims the whitespace around authored prose', () => {
    const spec = normalizeValid(
      parseInput({
        title: 'Interaction latency',
        summary: '   Prose with surrounding padding.   ',
        layout: [],
      }),
    );

    expect(spec.summary.headline).toBe('Prose with surrounding padding.');
  });

  it('shortens authored prose that exceeds the internal headline bound', () => {
    const long = 'Prose beyond the internal bound. '.repeat(40);
    // Hand-built: the authoring schema bounds a summary at the same length, so
    // this case reaches the normaliser only from a caller that assembled a
    // panel without parsing one — the deterministic fallback path (AAP §0.5.5).
    const spec = normalizeValid({
      title: 'Interaction latency',
      summary: long,
      layout: [],
    });
    const headline = spec.summary.headline ?? '';

    expect(headline.length).toBeLessThanOrEqual(MAX_HEADLINE_LENGTH);
    expect(headline.endsWith('…')).toBe(true);
    expect(headline).not.toBe(long);
    // Shortened, never rewritten: what remains is the opening of the prose the
    // author wrote.
    expect(long.trim().startsWith(headline.slice(0, -1))).toBe(true);
  });

  it('drops authored prose that is blank once trimmed', () => {
    // Unreachable through the parser, which requires a non-blank summary, and
    // therefore exactly the case a hand-assembled panel can present.
    const spec = normalizeValid({ title: 'Interaction latency', summary: '   ', layout: [] });

    expect('headline' in spec.summary).toBe(false);
  });
});
