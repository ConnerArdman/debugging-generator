/**
 * Colocated tests for `./input.ts` — the **authoring schema**, the one form of
 * a panel a language model may produce — and for `./json-schema.ts`, which is
 * that same schema rendered for the model to read.
 *
 * ## Why two modules in one suite
 *
 * AAP §0.8.3 gives this package five test files (`input`, `normalize`,
 * `validate`, `semantic`, `catalog`) and none of them is named for
 * `json-schema.ts`. That module is a *projection* of the authoring schema: it
 * imports `./input.js`, imports nothing else of this package, and emits what
 * `./input.ts` declares. The file that pins the schema is therefore the natural
 * home for the assertions that the schema survives rendering, and
 * `./json-schema.ts` says so in its own documentation. The second `describe`
 * block below states the split again at the point a reader arrives at it.
 *
 * ## What this file is for
 *
 * A generated panel reaches the screen through three steps — validate the
 * authored form, normalise deterministically, validate the internal form — and
 * only the first one judges a model's output directly. A failure there is
 * *recoverable*: `packages/model-provider/src/structured.ts` re-prompts with the
 * validation errors, at most twice, and exhausting those attempts costs the
 * developer a deterministic fallback panel instead of the panel they asked for
 * (AAP §0.5.3, §0.5.5). Every assertion below follows from that asymmetry:
 *
 * 1. **The authored example must parse exactly as written.** AAP §0.1.2 fixes
 *    the shape a panel may be authored in, and the panel-generation prompt
 *    demonstrates it. {@link PANEL_EXAMPLE} is that example, verbatim, and the
 *    first block asserts the four properties that make it non-trivial.
 * 2. **The vocabularies are closed, and imported rather than restated.** A node
 *    type, a source, a sort, a metric id, a telemetry kind and a tier each have
 *    exactly one owning module; this file iterates those tuples so that a value
 *    added to one is covered here without an edit, and so that a value invented
 *    here would have nowhere to come from.
 * 3. **Strictness holds where the design depends on it.** An authored node id,
 *    an invented dimension and a query field on the source-link leaf are
 *    rejected rather than dropped, because each of them would otherwise reach
 *    `./normalize.ts` as a field it must decide what to do with.
 * 4. **A rejection carries the shape of the failure and none of the data that
 *    caused it** (AAP §0.5.2). The sentinel block is the mechanical form of that
 *    rule, checked on the error's message, hint, serialised details *and*
 *    `toPayload()` — the last because `@debuggen/protocol` maps that exact
 *    object onto its WebSocket `error` payload, so it reaches both interfaces.
 * 5. **The rendered schema is deterministic, complete and free of anything
 *    application-shaped**, because it is embedded in an immutable versioned
 *    prompt file and `scripts/check-no-hardcoding.mjs` scans prompt text
 *    (AAP §0.5.3, §0.5.4).
 *
 * ## Deliberate boundaries, so a later reader does not look for the wrong test
 *
 * - **Acceptance, not interpretation.** A node may carry both a nested `query`
 *   and the same fields flat; this file asserts only that such a node *parses*.
 *   The precedence between the two spellings, the derivation of node ids, the
 *   implicit metrics source and the discarding of an authored summary's
 *   purported facts are all normalisation behaviours, asserted in
 *   `./normalize.test.ts`.
 * - **Well-formed, not true.** Which sources a node type may read, and whether
 *   it must name one, is the node catalog's statement; the authoring schema
 *   derives both rules from it and this file asserts them at step 1, iterating
 *   the catalog rather than restating it. Whether the evidence a panel points
 *   at exists in the capture is `./semantic.ts`'s question, and deliberately
 *   absent here.
 * - **No fixture file.** AAP §0.2.5 grants fixture directories to the
 *   telemetry, instrumentation and code-analysis packages only, so every input
 *   below is an in-file literal or is built by one of the small helpers. The
 *   example literal is duplicated in `./normalize.test.ts` rather than shared
 *   through a helper module, for the same reason.
 * - **This file is itself scanned** by `scripts/check-no-hardcoding.mjs`, so
 *   every identifier, path and route in it is invented and belongs to no
 *   application in this repository. The panel example is safe to reproduce
 *   because its title and summary are prose and its metric ids are
 *   product-owned; the instrumentation-plan example of AAP §0.1.2 names real
 *   project paths and belongs to `packages/instrumentation`, never here.
 *
 * Node environment, no DOM, no network, no `node:` builtin: this package's
 * compiler project declares no ambient types and the schemas under test are
 * pure data.
 */

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  DEBUGGEN_ERROR_CODES,
  DEFAULT_RESOLUTION_CONFIDENCE,
  SOURCE_RESOLVED_BY,
  type SourceLocation,
  type SourceResolvedBy,
} from '@debuggen/shared';
import { METRIC_IDS, TELEMETRY_KINDS, TELEMETRY_TIERS } from '@debuggen/telemetry';

import { PANEL_NODE_CATALOG, isKnownPanelNodeType } from './catalog.js';
import { PANEL_INPUT_MAX_NODE_COUNT as ENTRY_MAX_NODE_COUNT } from './index.js';
import {
  PANEL_INPUT_MAX_NODE_COUNT,
  PANEL_INPUT_MAX_PREFLIGHT_ISSUES,
  panelNodeInputSchema,
  panelSpecInputSchema,
  parsePanelSpecInput,
  type PanelNodeInput,
  type PanelSpecInput,
} from './input.js';
import {
  PANEL_SPEC_INPUT_JSON_SCHEMA_ID,
  PANEL_SPEC_INPUT_SCHEMA_TARGETS,
  panelSpecInputJsonSchema,
  panelSpecInputJsonSchemaText,
  type PanelSpecInputSchemaTarget,
} from './json-schema.js';
import { LAYOUT_NODE_MAX_CHILDREN, LAYOUT_NODE_TYPES } from './nodes/layout.js';
import {
  DATA_QUERY_FLAT_FIELD_KEYS,
  DATA_QUERY_MAX_LIMIT,
  DATA_QUERY_SORTS,
  DATA_QUERY_SOURCES,
  type DataQuerySource,
} from './nodes/query.js';
import { VISUALIZATION_NODE_TYPES } from './nodes/viz.js';
import { PANEL_LAYOUT_MAX_NODES, PANEL_NODE_TYPES, type PanelNodeType } from './spec.js';
import { PANEL_MAX_NODE_DEPTH, isPanelValidationIssueCode } from './validate.js';

/*
 * ---------------------------------------------------------------------------
 * The authored example of AAP §0.1.2
 * ---------------------------------------------------------------------------
 */

/**
 * The panel example AAP §0.1.2 fixes as the authoring shape, **verbatim**.
 *
 * Reproduced character for character rather than assembled from builders,
 * because this literal *is* the assertion: a suite that constructed a
 * conveniently-shaped document would keep passing through exactly the
 * tightening this example exists to forbid. `./normalize.test.ts` needs the same
 * literal and duplicates it there — AAP §0.2.5 gives this package no fixtures
 * file, and a shared helper module for one object would be a worse trade than
 * two copies that each fail loudly when the contract moves.
 *
 * Not typed as {@link PanelSpecInput}: the point is that an *untrusted* value of
 * this shape passes the schema, so it is handed to `safeParse` as the `unknown`
 * a model's reply is.
 */
const PANEL_EXAMPLE = {
  title: 'Checkout Latency',
  summary: 'Most latency occurs in the inventory database query.',
  layout: [
    { type: 'timeline', source: 'trace', filter: { traceId: '...' } },
    {
      type: 'metricCards',
      metrics: ['total_duration', 'frontend_duration', 'backend_duration', 'database_duration'],
    },
    { type: 'table', title: 'Slowest Operations', source: 'spans', sort: 'duration_desc' },
  ],
};

/** The example's three nodes, for the per-node assertions of the first block. */
const [EXAMPLE_TIMELINE_NODE, EXAMPLE_METRIC_CARDS_NODE, EXAMPLE_TABLE_NODE] = PANEL_EXAMPLE.layout;

/*
 * ---------------------------------------------------------------------------
 * Helpers
 *
 * Each one either returns the parsed value or returns the *locations* of the
 * issues a rejection reported, so a failing assertion names the field and the
 * kind of mistake rather than reporting that something, somewhere, is false.
 * `path: code` is also exactly what `parsePanelSpecInput` puts in its message,
 * which keeps the expectations below readable against a real rejection.
 * ---------------------------------------------------------------------------
 */

/**
 * Renders issue locations the way the module under test renders them: a dotted
 * field path, or `''` for the document itself, and the issue code.
 *
 * Typed against zod's own issue type — the type-only import this package's
 * `./summary.ts` uses for the same purpose — so no local restatement of the
 * issue shape can drift from the library's.
 *
 * @param issues The issues of a failed parse, in report order.
 * @returns One `path: code` string per issue, in the same order.
 */
function issueLocations(issues: readonly z.core.$ZodIssue[]): readonly string[] {
  return issues.map(
    (issue) => `${issue.path.map((segment) => String(segment)).join('.')}: ${issue.code}`,
  );
}

/**
 * Parses a document that is expected to be accepted, and fails the test with the
 * rejection's locations if it is not.
 *
 * @param value The document to parse.
 * @returns The parsed authored panel.
 */
function parsePanelOrFail(value: unknown): PanelSpecInput {
  const parsed = panelSpecInputSchema.safeParse(value);

  if (!parsed.success) {
    throw new Error(
      `the authoring schema rejected a document this test expects it to accept: ${issueLocations(
        parsed.error.issues,
      ).join('; ')}`,
    );
  }

  return parsed.data;
}

/**
 * Parses one node that is expected to be accepted, through the exported node
 * union rather than through a surrounding document, so an issue path names the
 * node's own field instead of `layout.0.…`.
 *
 * @param value The node to parse.
 * @returns The parsed authored node.
 */
function parseNodeOrFail(value: unknown): PanelNodeInput {
  const parsed = panelNodeInputSchema.safeParse(value);

  if (!parsed.success) {
    throw new Error(
      `the authoring schema rejected a node this test expects it to accept: ${issueLocations(
        parsed.error.issues,
      ).join('; ')}`,
    );
  }

  return parsed.data;
}

/**
 * The locations of the issues a rejected document reported, failing the test if
 * the document was accepted instead.
 *
 * @param value The document expected to be rejected.
 * @returns One `path: code` string per issue.
 */
function rejectionLocations(value: unknown): readonly string[] {
  const parsed = panelSpecInputSchema.safeParse(value);

  if (parsed.success) {
    throw new Error('the authoring schema accepted a document this test expects it to reject.');
  }

  return issueLocations(parsed.error.issues);
}

/**
 * The messages of the issues a rejected document reported, as `path: message`
 * — the lines the model provider's repair loop shows the author — failing the
 * test if the document was accepted instead.
 *
 * @param value The document expected to be rejected.
 * @returns One `path: message` string per issue, in report order.
 */
function schemaMessages(value: unknown): readonly string[] {
  const parsed = panelSpecInputSchema.safeParse(value);

  if (parsed.success) {
    throw new Error('the authoring schema accepted a document this test expects it to reject.');
  }

  return parsed.error.issues.map(
    (issue) => `${issue.path.map((segment) => String(segment)).join('.')}: ${issue.message}`,
  );
}

/**
 * The longest `path: message` line the model provider's repair loop passes on
 * uncut — `MAX_ISSUE_LINE_LENGTH` in `packages/model-provider/src/structured.ts`.
 * Restated rather than imported because this package sits below the model
 * provider in the package graph; the messages that list a vocabulary are
 * measured against it.
 */
const REPAIR_LINE_BUDGET = 200;

/** Whether a document is accepted, for the membership loops over a vocabulary. */
function accepts(value: unknown): boolean {
  return panelSpecInputSchema.safeParse(value).success;
}

/**
 * A minimal authored document around a layout, so each test states only the part
 * it is about.
 *
 * The title and summary are generic prose: they are not the subject of any
 * assertion outside the example block, and this file may name nothing from an
 * application (AAP §0.5.4).
 *
 * @param layout The layout to wrap.
 * @returns A document of that layout with a valid title and summary.
 */
function panelOf(layout: readonly unknown[]): Record<string, unknown> {
  return {
    title: 'Interaction latency',
    summary: 'One sentence about the capture.',
    layout: [...layout],
  };
}

/**
 * A valid {@link SourceLocation} for the source-link leaf.
 *
 * Built from `@debuggen/shared`'s own resolution-route tuple and its default
 * confidence table rather than from numbers typed here, so the leaf is exercised
 * with locations the package that owns the contract vouches for. The path is
 * project-relative and POSIX, as that contract requires, and names no file in
 * this repository.
 *
 * @param resolvedBy Which resolution route produced the location.
 * @returns A location that satisfies `sourceLocationSchema`.
 */
function locationFor(resolvedBy: SourceResolvedBy): SourceLocation {
  return {
    file: 'src/module/unit.ts',
    line: 12,
    column: 5,
    symbol: 'handleSomething',
    resolvedBy,
    confidence: DEFAULT_RESOLUTION_CONFIDENCE[resolvedBy],
  };
}

/** The first resolution route, for the cases that need one valid location. */
const SAMPLE_RESOLVED_BY: SourceResolvedBy = SOURCE_RESOLVED_BY[0];

/** A source-link node carrying a valid location and nothing else. */
function sourceLinkNode(extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'sourceLink',
    location: locationFor(SAMPLE_RESOLVED_BY),
    ...extra,
  };
}

/** Widened view of the container vocabulary, for membership tests on strings. */
const LAYOUT_TYPE_NAMES: readonly string[] = LAYOUT_NODE_TYPES;

/** Widened view of the metric-id vocabulary `@debuggen/telemetry` owns. */
const METRIC_ID_NAMES: readonly string[] = METRIC_IDS;

/**
 * The sources the node catalog lets a node type read, in catalog order, or
 * none for a string that is not a catalogued type.
 *
 * Every source-bearing fixture below takes its source from here rather than
 * naming one, so a catalog entry that gains or loses a source moves the
 * fixtures with it.
 *
 * @param type Any node type string.
 * @returns The catalogued sources of that type.
 */
function catalogSourcesOf(type: string): readonly DataQuerySource[] {
  return isKnownPanelNodeType(type) ? PANEL_NODE_CATALOG[type].sources : [];
}

/**
 * The first source the catalog lists for a query-backed node type — the one the
 * type was designed around — failing the test for a type that reads none.
 *
 * @param type A query-backed node type.
 * @returns Its first catalogued source.
 */
function firstSourceOf(type: string): DataQuerySource {
  const [first] = catalogSourcesOf(type);

  if (first === undefined) {
    throw new Error(`the node catalog lists no source for ${type}.`);
  }

  return first;
}

/**
 * The query-backed node types: every type whose catalog entry requires a query,
 * in vocabulary order.
 */
const QUERY_BACKED_TYPES: readonly PanelNodeType[] = PANEL_NODE_TYPES.filter(
  (type) => PANEL_NODE_CATALOG[type].requiresQuery,
);

/**
 * The query-backed node types that must name a source: those whose catalog
 * entry implies none.
 */
const SOURCE_REQUIRED_TYPES: readonly PanelNodeType[] = QUERY_BACKED_TYPES.filter(
  (type) => PANEL_NODE_CATALOG[type].defaultSource === undefined,
);

/**
 * The smallest authored node of a given type that the schema accepts.
 *
 * One builder rather than sixteen literals, driven by the vocabulary itself, so
 * the completeness loop below covers a node type added to `./nodes/layout.ts` or
 * `./nodes/viz.ts` without an edit here. Two children are given to every
 * container, which satisfies the section and stack minimum of one and the split
 * minimum of two at once, and every query-backed leaf names the first source
 * its catalog entry lists.
 *
 * @param type One member of the panel node vocabulary.
 * @returns A minimal node of that type.
 */
function minimalNode(type: string): Record<string, unknown> {
  if (LAYOUT_TYPE_NAMES.includes(type)) {
    return {
      type,
      children: [
        { type: 'table', source: 'spans' },
        { type: 'eventLog', source: 'events' },
      ],
    };
  }

  if (type === 'metricCards') {
    return { type, metrics: [METRIC_IDS[0]] };
  }

  if (type === 'sourceLink') {
    return sourceLinkNode();
  }

  return { type, source: firstSourceOf(type) };
}

/*
 * ---------------------------------------------------------------------------
 * 1. The authored example, verbatim
 *
 * The single most important block in this file. Each of the four properties AAP
 * §0.1.2's example depends on is asserted on its own, so a failure names which
 * one of them a schema change broke rather than reporting that "the example no
 * longer parses".
 * ---------------------------------------------------------------------------
 */

describe('the authored panel example of AAP §0.1.2', () => {
  it('parses exactly as written, field for field', () => {
    // Equality with the input, not merely acceptance: nothing may be dropped,
    // renamed, defaulted or moved at this layer. A field this schema quietly
    // filled in would hide from `./normalize.test.ts` whether the normaliser
    // lifted an authored value or invented one.
    expect(parsePanelOrFail(PANEL_EXAMPLE)).toEqual(PANEL_EXAMPLE);
  });

  it('is accepted by the non-throwing parser as well as by the schema', () => {
    // `packages/model-provider/src/structured.ts` calls the parser, never the
    // schema, so the parser is what the pipeline's behaviour actually depends
    // on.
    const result = parsePanelSpecInput(PANEL_EXAMPLE);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(PANEL_EXAMPLE);
    }
  });

  it('accepts a summary written as a bare string', () => {
    // The `string | { … }` union's string branch, which is the ordinary form and
    // the one the panel-generation prompt demonstrates. It becomes the panel
    // summary's non-evidentiary headline and never an observed fact.
    const parsed = parsePanelOrFail(PANEL_EXAMPLE);

    expect(typeof parsed.summary).toBe('string');
    expect(parsed.summary).toBe(PANEL_EXAMPLE.summary);
  });

  it('accepts source, filter and sort written flat on a node, with no query wrapper', () => {
    // The authored spelling puts the query fields on the node; the internal one
    // puts them inside `node.query`. This layer must accept the former as
    // written and must not perform the move itself — that is `./normalize.ts`'s
    // single responsibility.
    const timeline = parseNodeOrFail(EXAMPLE_TIMELINE_NODE);
    const table = parseNodeOrFail(EXAMPLE_TABLE_NODE);

    expect(timeline).toEqual(EXAMPLE_TIMELINE_NODE);
    expect(table).toEqual(EXAMPLE_TABLE_NODE);
    expect(Object.hasOwn(timeline, 'query')).toBe(false);
    expect(Object.hasOwn(table, 'query')).toBe(false);
  });

  it('accepts a metricCards node that names no source at all', () => {
    // A metric-tile row's source is implied, and normalisation supplies it from
    // the node catalog, so requiring one here would reject the example and cost
    // a repair attempt on a field an author has no reason to write.
    const node = parseNodeOrFail(EXAMPLE_METRIC_CARDS_NODE);

    expect(Object.hasOwn(node, 'source')).toBe(false);
    expect(Object.hasOwn(node, 'query')).toBe(false);

    // The four ids the example names are members of the vocabulary the
    // telemetry package owns — imported, so a renamed metric fails here.
    const unknownIds =
      node.type === 'metricCards'
        ? node.metrics.filter((id) => !METRIC_ID_NAMES.includes(id))
        : ['the example node did not parse as a metricCards node'];

    expect(unknownIds).toEqual([]);
  });

  it('accepts a trace-id placeholder rather than a resolved trace id', () => {
    // THE DEFENCE, stated explicitly because this is the assertion a future
    // "tightening" will break: the authoring schema deliberately does NOT
    // constrain `filter.traceId` to 32 hex characters. A trace id names one
    // correlated interaction of a capture that has not happened yet when a panel
    // is authored, so `'...'` is the honest value and the example carries it.
    //
    // Three layers, one job each: this layer checks the value is a non-empty
    // bounded string; `./normalize.ts` passes it through unchanged (its test
    // asserts an exact normalised object, so a normaliser that padded or
    // invented a trace id would fail it — and would be inventing evidence);
    // `./semantic.ts` is the single checkpoint that resolves a trace id against
    // the capture and rejects one the capture does not hold, which is the only
    // layer able to tell *present* from *well-formed*. A hex pattern here would
    // move that rejection to the wrong layer, burning one of two repair
    // attempts on a value the author could not have known.
    expect(parseNodeOrFail(EXAMPLE_TIMELINE_NODE)).toEqual(EXAMPLE_TIMELINE_NODE);

    // A resolved-looking id is equally acceptable: the field is a string, and
    // both shapes reach semantic validation identically.
    expect(
      accepts(
        panelOf([{ type: 'timeline', source: 'trace', filter: { traceId: 'a'.repeat(32) } }]),
      ),
    ).toBe(true);

    // An empty trace id is still a rejection: "unconstrained format" is not
    // "unconstrained".
    expect(
      rejectionLocations(panelOf([{ type: 'timeline', source: 'trace', filter: { traceId: '' } }])),
    ).toEqual(['layout.0.filter.traceId: too_small']);
  });
});

/*
 * ---------------------------------------------------------------------------
 * 2. The closed vocabularies
 *
 * Every acceptance loop iterates the tuple its owning module exports and every
 * rejection names an invented value. Nothing in this block writes out a source,
 * sort, kind, tier, metric id or node type of its own: a vocabulary restated in
 * a test is a vocabulary that keeps passing after it moves.
 * ---------------------------------------------------------------------------
 */

describe('the closed authoring vocabularies', () => {
  it('accepts on each query-backed node type exactly the sources its catalog entry lists', () => {
    // Every type crossed with every declared source, so a source the catalog
    // withholds from a type is proven refused, not merely a listed one accepted.
    const mismatches: string[] = [];

    for (const type of QUERY_BACKED_TYPES) {
      for (const source of DATA_QUERY_SOURCES) {
        const node = { ...minimalNode(type), source };

        if (accepts(panelOf([node])) !== catalogSourcesOf(type).includes(source)) {
          mismatches.push(`${type} + ${source}`);
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('lets some node type read every data source the query module declares', () => {
    const unreadable = DATA_QUERY_SOURCES.filter(
      (source) => !QUERY_BACKED_TYPES.some((type) => catalogSourcesOf(type).includes(source)),
    );

    expect(unreadable).toEqual([]);
  });

  it('rejects a source the node type cannot read, naming the sources it can', () => {
    const document = panelOf([{ type: 'table', source: 'metrics' }]);

    expect(rejectionLocations(document)).toEqual(['layout.0.source: invalid_union']);
    expect(schemaMessages(document)).toEqual([
      `layout.0.source: Not a source a table node can read; use one of: ${catalogSourcesOf('table').join(', ')}.`,
    ]);
    expect(reportedIssues(document)).toEqual([
      {
        path: 'layout.0.source',
        code: 'panel_node_query_source_not_allowed',
        expected: catalogSourcesOf('table').join(' | '),
      },
    ]);
  });

  it('rejects a source outside that vocabulary, without repeating it', () => {
    const document = panelOf([{ type: 'table', source: 'somewhereElse' }]);

    expect(rejectionLocations(document)).toEqual(['layout.0.source: invalid_union']);
    expect(reportedIssues(document)).toEqual([
      {
        path: 'layout.0.source',
        code: 'panel_node_query_source_unknown',
        expected: catalogSourcesOf('table').join(' | '),
      },
    ]);
    expect(schemaMessages(document).join('\n')).not.toContain('somewhereElse');
    expect(rejectionSurfaces(document)).not.toContain('somewhereElse');
  });

  it('accepts every sort the query module declares', () => {
    const rejected = DATA_QUERY_SORTS.filter(
      (sort) => !accepts(panelOf([{ type: 'table', source: 'spans', sort }])),
    );

    expect(rejected).toEqual([]);
  });

  it('rejects a sort outside that vocabulary', () => {
    expect(
      rejectionLocations(panelOf([{ type: 'table', source: 'spans', sort: 'size_desc' }])),
    ).toEqual(['layout.0.sort: invalid_value']);
  });

  it('accepts every metric id @debuggen/telemetry declares, one at a time and all at once', () => {
    const rejected = METRIC_IDS.filter(
      (metric) => !accepts(panelOf([{ type: 'metricCards', metrics: [metric] }])),
    );

    expect(rejected).toEqual([]);
    // The whole vocabulary is also the cardinality ceiling, so a node naming
    // every id is the largest legitimate tile row rather than an overflow.
    expect(accepts(panelOf([{ type: 'metricCards', metrics: [...METRIC_IDS] }]))).toBe(true);
  });

  it('rejects a metric id outside that vocabulary', () => {
    expect(
      rejectionLocations(panelOf([{ type: 'metricCards', metrics: ['elapsed_seconds'] }])),
    ).toEqual(['layout.0.metrics.0: invalid_value']);
  });

  it('rejects a metric list that is empty or longer than the vocabulary', () => {
    expect(rejectionLocations(panelOf([{ type: 'metricCards', metrics: [] }]))).toEqual([
      'layout.0.metrics: too_small',
    ]);
    expect(
      rejectionLocations(
        panelOf([{ type: 'metricCards', metrics: [...METRIC_IDS, METRIC_IDS[0]] }]),
      ),
    ).toEqual(['layout.0.metrics: too_big']);
  });

  it('requires a metricCards node to name its metrics', () => {
    // Omission is refused deliberately: normalisation has no basis on which to
    // choose an id, so a node without metrics would pass step 1 and fail the
    // internal schema as a product bug instead of a repair prompt.
    expect(rejectionLocations(panelOf([{ type: 'metricCards' }]))).toEqual([
      'layout.0.metrics: invalid_type',
    ]);
  });

  it('accepts every telemetry kind in a filter, and the whole kind list', () => {
    const rejected = TELEMETRY_KINDS.filter(
      (kind) =>
        !accepts(panelOf([{ type: 'eventLog', source: 'events', filter: { kinds: [kind] } }])),
    );

    expect(rejected).toEqual([]);
    expect(
      accepts(
        panelOf([{ type: 'eventLog', source: 'events', filter: { kinds: [...TELEMETRY_KINDS] } }]),
      ),
    ).toBe(true);
  });

  it('rejects a kind outside the telemetry vocabulary', () => {
    expect(
      rejectionLocations(
        panelOf([{ type: 'eventLog', source: 'events', filter: { kinds: ['timer.tick'] } }]),
      ),
    ).toEqual(['layout.0.filter.kinds.0: invalid_value']);
  });

  it('accepts every tier the telemetry package declares', () => {
    const rejected = TELEMETRY_TIERS.filter(
      (tier) => !accepts(panelOf([{ type: 'eventLog', source: 'events', filter: { tier } }])),
    );

    expect(rejected).toEqual([]);
  });

  it('rejects a tier outside that vocabulary', () => {
    expect(
      rejectionLocations(
        panelOf([{ type: 'eventLog', source: 'events', filter: { tier: 'edge' } }]),
      ),
    ).toEqual(['layout.0.filter.tier: invalid_value']);
  });

  it('accepts a minimal node of every type in the panel node vocabulary', () => {
    const rejected = PANEL_NODE_TYPES.filter((type) => !accepts(panelOf([minimalNode(type)])));

    expect(rejected).toEqual([]);
    // The vocabulary this loop covers is the union of the two owning modules',
    // so a node type added to either is covered here rather than forgotten.
    expect([...PANEL_NODE_TYPES]).toEqual([...LAYOUT_NODE_TYPES, ...VISUALIZATION_NODE_TYPES]);
  });

  it('rejects an unknown node type with one issue on the node’s own type path', () => {
    // The union is discriminated on `type`, which is what makes this failure
    // usable: one issue naming the node and its discriminator, rather than
    // sixteen branches' worth of issues for a repair prompt to wade through.
    expect(rejectionLocations(panelOf([{ type: 'scatterPlot', source: 'spans' }]))).toEqual([
      'layout.0.type: invalid_union',
    ]);
  });

  it.each(['gauge', 'scatterPlot'])(
    'tells the author the node types for the unknown type %s, and reports the catalog code',
    (type) => {
      // The repair loop quotes the schema's message, so it must say the type
      // is unknown and list the types there are; the parser reports the
      // validator's code, with the vocabulary as `expected`.
      const document = panelOf([{ type, source: 'spans' }]);

      expect(schemaMessages(document)).toEqual([
        `layout.0.type: Unknown node type: ${PANEL_NODE_TYPES.join('|')}`,
      ]);
      // The repair loop cuts a `path: message` line past its budget, so the
      // whole vocabulary must fit at a top-level node, where the type is
      // usually written (see `MAX_ISSUE_LINE_LENGTH` in
      // packages/model-provider/src/structured.ts).
      for (const line of schemaMessages(panelOf([...tableLeaves(63), { type }]))) {
        expect(line.length).toBeLessThanOrEqual(REPAIR_LINE_BUDGET);
      }
      expect(reportedIssues(document)).toEqual([
        {
          path: 'layout.0.type',
          code: 'panel_node_type_unknown',
          expected: PANEL_NODE_TYPES.join(' | '),
        },
      ]);
      expect(isPanelValidationIssueCode('panel_node_type_unknown')).toBe(true);
      expect(rejectionSurfaces(document)).not.toContain(type);
      expect(schemaMessages(document).join('\n')).not.toContain(type);
    },
  );

  it('rejects a node with no type at all, at the same path and with the same vocabulary', () => {
    expect(rejectionLocations(panelOf([{ source: 'spans' }]))).toEqual([
      'layout.0.type: invalid_union',
    ]);
    expect(reportedIssues(panelOf([{ source: 'spans' }]))).toEqual([
      {
        path: 'layout.0.type',
        code: 'panel_node_type_unknown',
        expected: PANEL_NODE_TYPES.join(' | '),
      },
    ]);
  });

  it('reports an unknown type inside a container at the nested node’s own path', () => {
    const document = panelOf([{ type: 'stack', children: [{ type: 'gauge' }] }]);

    expect(schemaMessages(document)).toEqual([
      `layout.0.children.0.type: Unknown node type: ${PANEL_NODE_TYPES.join('|')}`,
    ]);
    expect(reportedIssues(document)).toEqual([
      {
        path: 'layout.0.children.0.type',
        code: 'panel_node_type_unknown',
        expected: PANEL_NODE_TYPES.join(' | '),
      },
    ]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * 3. Strictness
 *
 * Every object in the authored form is strict, and three consequences of that
 * are load-bearing rather than incidental: an authored node id is refused, an
 * invented dimension is refused, and the derived document fields cannot be
 * written by an author. Each is asserted at the level it applies to.
 * ---------------------------------------------------------------------------
 */

describe('strictness of the authored form', () => {
  it('rejects an unrecognised key on a visualization node', () => {
    // A visual property this package does not admit is the motivating case: all
    // presentation is the renderer's design tokens (AAP §0.6.2), so a node that
    // carried one would claim a control that nothing honours.
    expect(
      rejectionLocations(panelOf([{ type: 'table', source: 'spans', rowHeight: 24 }])),
    ).toEqual(['layout.0: unrecognized_keys']);
  });

  it('rejects an unrecognised key on a layout node', () => {
    expect(
      rejectionLocations(
        panelOf([
          { type: 'stack', children: [{ type: 'table', source: 'spans' }], columnCount: 2 },
        ]),
      ),
    ).toEqual(['layout.0: unrecognized_keys']);
  });

  it('rejects an authored node id', () => {
    // Ids are derived from a node's position in the layout by `./normalize.ts`.
    // Accepting an authored one would make the normaliser's exact-object
    // assertion depend on what a model chose to write, and would give two
    // regenerations of one panel node identities that differ — which breaks a
    // selection, a scroll position and a deep link across a regeneration.
    expect(
      rejectionLocations(panelOf([{ type: 'table', id: 'layout.0', source: 'spans' }])),
    ).toEqual(['layout.0: unrecognized_keys']);
  });

  it('rejects an authored id on a nested node too', () => {
    expect(
      rejectionLocations(
        panelOf([
          {
            type: 'section',
            children: [{ type: 'table', id: 'layout.0.children.0', source: 'spans' }],
          },
        ]),
      ),
    ).toEqual(['layout.0.children.0: unrecognized_keys']);
  });

  it('rejects an unrecognised key at the document level', () => {
    // Every field the internal specification adds beyond these three is
    // derived from the normalisation context (`version`, `id`, `sessionId`,
    // `panelVersion`, `supersedes`, `meta`), so an authored one is refused here
    // rather than silently overwritten there. The document itself has no path,
    // which the parser renders as `<document>` in its message.
    expect(rejectionLocations({ ...panelOf([]), sessionId: 'abc' })).toEqual([
      ': unrecognized_keys',
    ]);
  });

  it('rejects an unrecognised key inside a nested query and inside a filter', () => {
    expect(
      rejectionLocations(panelOf([{ type: 'table', query: { source: 'spans', groupBy: 'tier' } }])),
    ).toEqual(['layout.0.query: unrecognized_keys']);
    expect(
      rejectionLocations(panelOf([{ type: 'table', source: 'spans', filter: { warehouse: 1 } }])),
    ).toEqual(['layout.0.filter: unrecognized_keys']);
  });

  it('rejects a blank title and a blank summary at their own paths', () => {
    expect(rejectionLocations({ ...panelOf([]), title: '   ' })).toEqual(['title: invalid_format']);
    expect(rejectionLocations({ ...panelOf([]), summary: '  ' })).toEqual([
      'summary: invalid_format',
    ]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * 4. Paging bounds
 *
 * `limit` and `offset` are the internal query's own fields, imported, so the
 * ceiling an author is told about is the ceiling the service's resolver
 * enforces. The case that matters is the falsy one.
 * ---------------------------------------------------------------------------
 */

describe('limit and offset', () => {
  it('keeps a falsy-but-valid limit of zero', () => {
    // `limit: 0` is an explicit request for no items — a node may legitimately
    // want a total without rows — and only the *absence* of the field means
    // unset. A schema that dropped it, or a default that filled it in, would
    // make the two indistinguishable downstream.
    const node = parseNodeOrFail({ type: 'table', source: 'spans', limit: 0 });

    expect(Object.hasOwn(node, 'limit')).toBe(true);
    expect(node).toEqual({ type: 'table', source: 'spans', limit: 0 });
  });

  it('keeps a falsy-but-valid offset of zero', () => {
    const node = parseNodeOrFail({ type: 'table', source: 'spans', offset: 0 });

    expect(Object.hasOwn(node, 'offset')).toBe(true);
    expect(node).toEqual({ type: 'table', source: 'spans', offset: 0 });
  });

  it('accepts the declared maximum limit and rejects one item beyond it', () => {
    expect(
      accepts(panelOf([{ type: 'table', source: 'spans', limit: DATA_QUERY_MAX_LIMIT }])),
    ).toBe(true);
    expect(
      rejectionLocations(
        panelOf([{ type: 'table', source: 'spans', limit: DATA_QUERY_MAX_LIMIT + 1 }]),
      ),
    ).toEqual(['layout.0.limit: too_big']);
  });

  it('rejects a negative or fractional limit', () => {
    expect(rejectionLocations(panelOf([{ type: 'table', source: 'spans', limit: -1 }]))).toEqual([
      'layout.0.limit: too_small',
    ]);
    expect(rejectionLocations(panelOf([{ type: 'table', source: 'spans', limit: 1.5 }]))).toEqual([
      'layout.0.limit: invalid_type',
    ]);
  });

  it('rejects a negative or fractional offset, and bounds it nowhere above', () => {
    expect(rejectionLocations(panelOf([{ type: 'table', source: 'spans', offset: -1 }]))).toEqual([
      'layout.0.offset: too_small',
    ]);
    expect(rejectionLocations(panelOf([{ type: 'table', source: 'spans', offset: 0.5 }]))).toEqual([
      'layout.0.offset: invalid_type',
    ]);
    // No ceiling: how many items a source holds is the service's knowledge, and
    // an offset past the end is an empty page rather than an error.
    expect(
      accepts(panelOf([{ type: 'table', source: 'spans', offset: DATA_QUERY_MAX_LIMIT * 10 }])),
    ).toBe(true);
  });

  it('accepts a zero minimum duration in a filter', () => {
    // The same rule one level down: zero means "no floor applies" and must
    // survive parsing rather than reading as an absent field.
    const node = parseNodeOrFail({ type: 'table', source: 'spans', filter: { minDuration: 0 } });

    expect(node).toEqual({ type: 'table', source: 'spans', filter: { minDuration: 0 } });
  });
});

/*
 * ---------------------------------------------------------------------------
 * 5. The source-link leaf
 *
 * The one visualization node that reads no captured data, and the one place
 * where strictness is the entire feature: because the object declares no query
 * field, a specification cannot half-describe this node as a data view and
 * leave a resolver to guess which half it meant.
 * ---------------------------------------------------------------------------
 */

describe('the source-link leaf', () => {
  it('accepts a node carrying a valid resolved location', () => {
    const node = sourceLinkNode();

    expect(parseNodeOrFail(node)).toEqual(node);
  });

  it('accepts a location from every resolution route the shared package declares', () => {
    const rejected = SOURCE_RESOLVED_BY.filter(
      (resolvedBy) => !accepts(panelOf([sourceLinkNode({ location: locationFor(resolvedBy) })])),
    );

    expect(rejected).toEqual([]);
  });

  it('rejects every query field on the leaf', () => {
    // All five flat query fields plus the nested query object and the
    // metric-tile option, each on its own so a failure names the field that
    // started being tolerated.
    const offenders: string[] = [];

    for (const field of [...DATA_QUERY_FLAT_FIELD_KEYS, 'query', 'metrics']) {
      const locations = rejectionLocations(panelOf([sourceLinkNode({ [field]: 'spans' })]));
      if (!locations.includes('layout.0: unrecognized_keys')) {
        offenders.push(`${field}: ${locations.join('; ')}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('rejects a source and a filter on the leaf individually', () => {
    // Stated again as two explicit assertions, because the loop above would
    // still pass if the whole vocabulary tuple were emptied.
    expect(rejectionLocations(panelOf([sourceLinkNode({ source: 'spans' })]))).toEqual([
      'layout.0: unrecognized_keys',
    ]);
    expect(
      rejectionLocations(panelOf([sourceLinkNode({ filter: { traceId: 'a'.repeat(32) } })])),
    ).toEqual(['layout.0: unrecognized_keys']);
  });

  it('requires the location', () => {
    expect(rejectionLocations(panelOf([{ type: 'sourceLink' }]))).toEqual([
      'layout.0.location: invalid_type',
    ]);
  });

  it('delegates the location contract to @debuggen/shared, which refuses an absolute path', () => {
    // The refinement is the shared package's, not this one's: the same schema is
    // parsed at every hop of the click path from this chip to the editor, so one
    // definition is what makes the path trustworthy end to end. Two independent
    // violations in one location, to prove the delegated checks really run.
    const locations = rejectionLocations(
      panelOf([
        sourceLinkNode({
          location: { ...locationFor(SAMPLE_RESOLVED_BY), file: '/etc/hosts', line: 0 },
        }),
      ]),
    );

    expect(locations).toContain('layout.0.location.file: custom');
    expect(locations).toContain('layout.0.location.line: too_small');
  });

  it('refuses a confidence outside zero to one and an unknown resolution route', () => {
    expect(
      rejectionLocations(
        panelOf([
          sourceLinkNode({ location: { ...locationFor(SAMPLE_RESOLVED_BY), confidence: 2 } }),
        ]),
      ),
    ).toEqual(['layout.0.location.confidence: too_big']);
    expect(
      rejectionLocations(
        panelOf([
          sourceLinkNode({ location: { ...locationFor(SAMPLE_RESOLVED_BY), resolvedBy: 'guess' } }),
        ]),
      ),
    ).toEqual(['layout.0.location.resolvedBy: invalid_value']);
  });
});

/*
 * ---------------------------------------------------------------------------
 * 6. Input that is not a document at all
 *
 * A model's reply arrives as `unknown`, and a rejection has a defined outcome:
 * the provider re-prompts. Anything that threw instead would abort the
 * generating stage rather than degrade it.
 * ---------------------------------------------------------------------------
 */

describe('input that is not an object', () => {
  it('rejects null, a string, an array and a number without throwing', () => {
    const unexpected: string[] = [];

    for (const value of [null, undefined, 'a panel', [], 42, true]) {
      const parsed = panelSpecInputSchema.safeParse(value);
      if (parsed.success) {
        unexpected.push(`accepted ${String(value)}`);
        continue;
      }
      const locations = issueLocations(parsed.error.issues);
      if (!locations.includes(': invalid_type')) {
        unexpected.push(`${String(value)} → ${locations.join('; ')}`);
      }
    }

    expect(unexpected).toEqual([]);
  });

  it('returns a failed result rather than throwing, through the parser too', () => {
    const result = parsePanelSpecInput('a panel');

    expect(result.ok).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * 7. The dual query form
 *
 * Both spellings are accepted because both are natural to write. This block
 * asserts acceptance and nothing else: what a node carrying both spellings
 * *means* — the nested `query` wins for the keys it declares and the flat fields
 * fill the gaps — is a normalisation behaviour, asserted in
 * `./normalize.test.ts`. Keeping the split explicit is what stops the two files
 * from both half-testing the move.
 * ---------------------------------------------------------------------------
 */

describe('the dual query form', () => {
  it('accepts every flat query field, one field at a time', () => {
    // Driven by the authoritative flat-field tuple, which is the same list the
    // normaliser lifts by, so a field added there is covered here. The source
    // an event log must name is written flat when it is the field under test,
    // and nested otherwise, so each other field is the only one written flat.
    const values: Readonly<Record<string, unknown>> = {
      source: firstSourceOf('eventLog'),
      filter: { minDuration: 1 },
      sort: 'duration_desc',
      limit: 10,
      offset: 2,
    };
    const rejected = DATA_QUERY_FLAT_FIELD_KEYS.filter((field) => {
      const node =
        field === 'source'
          ? { type: 'eventLog', source: values[field] }
          : {
              type: 'eventLog',
              query: { source: firstSourceOf('eventLog') },
              [field]: values[field],
            };

      return !accepts(panelOf([node]));
    });

    expect(rejected).toEqual([]);
  });

  it('accepts the flat form on a second node type, with every field at once', () => {
    const node = {
      type: 'requestTable',
      title: 'Grouped requests',
      description: 'One row per identical request.',
      source: 'requests',
      filter: { minDuration: 0.25, tier: TELEMETRY_TIERS[0] },
      sort: 'count_desc',
      limit: 25,
      offset: 0,
    };

    expect(parseNodeOrFail(node)).toEqual(node);
  });

  it('accepts the nested query form with every field inside the object', () => {
    const node = {
      type: 'requestTable',
      query: {
        source: 'requests',
        filter: { kinds: [TELEMETRY_KINDS[0]], component: 'SomeComponent' },
        sort: 'count_desc',
        limit: 25,
        offset: 5,
      },
    };

    expect(parseNodeOrFail(node)).toEqual(node);
  });

  it('accepts a node carrying both spellings, and leaves both in place', () => {
    // Acceptance only. The documented precedence is `./normalize.ts`'s, and its
    // test is where the winner is asserted; this layer must not resolve, drop or
    // merge either side, because a schema that did would hide from that test
    // whether the normaliser was doing its job.
    const node = {
      type: 'table',
      source: 'spans',
      sort: 'duration_desc',
      limit: 5,
      query: { source: 'events', sort: 'start_asc' },
    };

    expect(parseNodeOrFail(node)).toEqual(node);
  });

  it('accepts the source written only inside the nested query', () => {
    expect(parseNodeOrFail({ type: 'timeline', query: { source: 'trace' } })).toEqual({
      type: 'timeline',
      query: { source: 'trace' },
    });
    // `null` is the nested spelling's explicit "not on the node", and means
    // what leaving the key out means.
    expect(parseNodeOrFail({ type: 'timeline', source: null, query: { source: 'trace' } })).toEqual(
      { type: 'timeline', source: null, query: { source: 'trace' } },
    );
  });

  it.each(SOURCE_REQUIRED_TYPES)(
    'refuses a %s node that names no source, at step 1, with its sources and both spellings',
    (type) => {
      // A repairable omission must fail the authoring schema — the step the
      // repair loop re-prompts on — rather than pass it and fail the internal
      // schema, where a failure is a product bug and is never retried.
      const document = panelOf([{ type }]);
      const listed = catalogSourcesOf(type);

      expect(rejectionLocations(document)).toEqual(['layout.0.query: invalid_type']);
      expect(schemaMessages(document)).toEqual([
        `layout.0.query: A ${type} node needs a source (one of: ${listed.join(', ')}), written as "source" on the node or inside its "query" object.`,
      ]);
      for (const line of schemaMessages(document)) {
        expect(line.length).toBeLessThanOrEqual(REPAIR_LINE_BUDGET);
      }
      expect(reportedIssues(document)).toEqual([
        {
          path: 'layout.0.source',
          code: 'panel_node_query_source_missing',
          expected: listed.join(' | '),
        },
      ]);
    },
  );

  it('covers every query-backed type but the one whose catalog entry implies a source', () => {
    expect(SOURCE_REQUIRED_TYPES).toHaveLength(QUERY_BACKED_TYPES.length - 1);
    expect(QUERY_BACKED_TYPES.filter((type) => !SOURCE_REQUIRED_TYPES.includes(type))).toEqual([
      'metricCards',
    ]);
  });

  it('refuses the source missing from a nested query, a null flat source and a query that is no object', () => {
    const missing = {
      path: 'layout.0.source',
      code: 'panel_node_query_source_missing',
      expected: catalogSourcesOf('table').join(' | '),
    };

    expect(rejectionLocations(panelOf([{ type: 'table', query: {} }]))).toEqual([
      'layout.0.query.source: invalid_value',
    ]);
    expect(reportedIssues(panelOf([{ type: 'table', query: {} }]))).toEqual([missing]);
    expect(reportedIssues(panelOf([{ type: 'table', source: null }]))).toEqual([missing]);
    expect(reportedIssues(panelOf([{ type: 'table', filter: { minDuration: 1 } }]))).toEqual([
      missing,
    ]);

    // A query that is present but not an object is a shape fault, not a missing
    // source: the schema's own code, with a message that says so.
    expect(rejectionLocations(panelOf([{ type: 'table', query: 'spans' }]))).toEqual([
      'layout.0.query: invalid_type',
    ]);
    expect(schemaMessages(panelOf([{ type: 'table', query: 'spans' }]))).toEqual([
      `layout.0.query: The "query" of a table node must be an object of query fields, and its source one of: ${catalogSourcesOf('table').join(', ')}.`,
    ]);
  });

  it('refuses a nested source the node type cannot read, at the path it was written', () => {
    const document = panelOf([{ type: 'requestTable', query: { source: 'spans' } }]);

    expect(rejectionLocations(document)).toEqual(['layout.0.query.source: invalid_value']);
    expect(schemaMessages(document)).toEqual([
      `layout.0.query.source: Not a source a requestTable node can read; use one of: ${catalogSourcesOf('requestTable').join(', ')}.`,
    ]);
    expect(reportedIssues(document)).toEqual([
      {
        path: 'layout.0.query.source',
        code: 'panel_node_query_source_not_allowed',
        expected: catalogSourcesOf('requestTable').join(' | '),
      },
    ]);
  });

  it('refuses the QA reproductions of a flat source the node type cannot read', () => {
    const cases: readonly { readonly node: Record<string, unknown>; readonly type: string }[] = [
      { node: { type: 'timeline', source: 'metrics' }, type: 'timeline' },
      { node: { type: 'requestTable', source: 'spans' }, type: 'requestTable' },
      {
        node: { type: 'metricCards', source: 'spans', metrics: [METRIC_IDS[0]] },
        type: 'metricCards',
      },
    ];

    for (const { node, type } of cases) {
      expect(reportedIssues(panelOf([node]))).toEqual([
        {
          path: 'layout.0.source',
          code: 'panel_node_query_source_not_allowed',
          expected: catalogSourcesOf(type).join(' | '),
        },
      ]);
    }
  });

  it('accepts a metric-tile row with no source, and with the source its catalog implies', () => {
    const tiles = { type: 'metricCards', metrics: [METRIC_IDS[0]] };
    const implied = PANEL_NODE_CATALOG.metricCards.defaultSource;

    expect(parseNodeOrFail(tiles)).toEqual(tiles);
    expect(parseNodeOrFail({ ...tiles, source: implied })).toEqual({ ...tiles, source: implied });
    expect(parseNodeOrFail({ ...tiles, query: { source: implied } })).toEqual({
      ...tiles,
      query: { source: implied },
    });
  });

  it('accepts an empty filter and an empty query object beside a named source', () => {
    // Every filter field narrows, so an empty filter means "the whole source"
    // rather than "nothing", and an empty query object is the same statement one
    // level up.
    expect(parseNodeOrFail({ type: 'table', source: 'spans', filter: {} })).toEqual({
      type: 'table',
      source: 'spans',
      filter: {},
    });
    expect(parseNodeOrFail({ type: 'table', source: 'spans', query: {} })).toEqual({
      type: 'table',
      source: 'spans',
      query: {},
    });
  });

  it('accepts the two node labels and rejects a blank one', () => {
    expect(
      parseNodeOrFail({ type: 'table', source: 'spans', title: 'Slowest operations' }),
    ).toEqual({
      type: 'table',
      source: 'spans',
      title: 'Slowest operations',
    });
    expect(rejectionLocations(panelOf([{ type: 'table', source: 'spans', title: '' }]))).toEqual([
      'layout.0.title: too_small',
    ]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * 8. The authored summary
 *
 * Both branches of `string | { … }` parse. The object branch is accepted as a
 * spelling and given no authority: a panel's observed facts and likely causes
 * are copied from the validated analysis and from nowhere else, which is why an
 * authored statement cannot even represent an evidence reference.
 * ---------------------------------------------------------------------------
 */

describe('the authored summary', () => {
  it('accepts the bare-string branch', () => {
    const parsed = parsePanelOrFail({ ...panelOf([]), summary: 'One sentence about the capture.' });

    expect(parsed.summary).toBe('One sentence about the capture.');
  });

  it('accepts the object branch, in all three registers', () => {
    const summary = {
      headline: 'One sentence about the capture.',
      observed: [{ statement: 'A statement about the capture.', detail: 'A second sentence.' }],
      likelyCauses: [{ statement: 'A statement about what might explain it.' }],
    };
    const parsed = parsePanelOrFail({ ...panelOf([]), summary });

    expect(parsed.summary).toEqual(summary);
  });

  it('strips evidence and confidence from an authored statement rather than rejecting them', () => {
    // The guarantee is mechanical, not documentary: the parsed value provably
    // cannot carry an authored evidence reference or confidence, so no later step
    // has to remember to discard one. Rejecting instead would spend one of two
    // repair attempts on content that was never going to be read.
    //
    // That the *normaliser* then promotes none of this prose into an observed
    // fact — only the headline, and only as non-evidentiary prose — is asserted
    // in `./normalize.test.ts`, which is the layer that does the copying.
    const parsed = parsePanelOrFail({
      ...panelOf([]),
      summary: {
        headline: 'One sentence about the capture.',
        observed: [
          {
            statement: 'A statement about the capture.',
            evidence: [{ id: 'evt-1', label: 'An event' }],
            confidence: 'high',
            suggestedLocation: locationFor(SAMPLE_RESOLVED_BY),
          },
        ],
      },
    });

    expect(parsed.summary).toEqual({
      headline: 'One sentence about the capture.',
      observed: [{ statement: 'A statement about the capture.' }],
    });
  });

  it('accepts an object summary with no fields at all', () => {
    expect(parsePanelOrFail({ ...panelOf([]), summary: {} }).summary).toEqual({});
  });

  it('rejects a summary that is neither a sentence nor an object', () => {
    const locations = rejectionLocations({ ...panelOf([]), summary: 42 });

    expect(locations.every((location) => location.startsWith('summary'))).toBe(true);
    expect(locations.length).toBeGreaterThan(0);
  });

  it('rejects a blank statement inside the object branch', () => {
    expect(
      rejectionLocations({ ...panelOf([]), summary: { observed: [{ statement: '  ' }] } }),
    ).toEqual(['summary.observed.0.statement: invalid_format']);
  });
});

/*
 * ---------------------------------------------------------------------------
 * 9. Nesting and the layout bounds
 *
 * A panel is a forest, and the authoring schema parses it through an unrolled
 * chain of node unions, one per nesting level. The bounds are the internal
 * ones, imported by the module under test, so a layout that passes here is a
 * layout the internal schema accepts.
 * ---------------------------------------------------------------------------
 */

describe('recursion and layout bounds', () => {
  it('accepts a section containing a split containing a stack containing a view', () => {
    // Three containers deep, which is one more level than any single container
    // can prove on its own: each level has to hand its children to the union
    // of the level below, or the innermost node is never reached.
    const layout = [
      {
        type: 'section',
        title: 'Outer section',
        children: [
          {
            type: 'split',
            direction: 'vertical',
            children: [
              { type: 'stack', children: [{ type: 'flame', source: 'trace' }] },
              { type: 'stack', children: [sourceLinkNode()] },
            ],
          },
        ],
      },
    ];

    expect(parsePanelOrFail(panelOf(layout)).layout).toEqual(layout);
  });

  it('reports an issue at the full path of a malformed deeply nested node', () => {
    // The path is what a repair prompt navigates by, so it has to survive the
    // recursion intact.
    expect(
      rejectionLocations(
        panelOf([
          {
            type: 'section',
            children: [
              {
                type: 'stack',
                children: [{ type: 'table', source: 'spans', sort: 'size_desc' }],
              },
            ],
          },
        ]),
      ),
    ).toEqual(['layout.0.children.0.children.0.sort: invalid_value']);
  });

  it('accepts an empty layout', () => {
    // Deliberate, and documented by the module under test: a capture with
    // nothing to draw is a legitimate answer, the internal specification accepts
    // an empty layout for the same reason, and rejecting one would spend a
    // repair attempt asking an author to invent views over evidence that does
    // not exist.
    expect(parsePanelOrFail(panelOf([])).layout).toEqual([]);
  });

  it('requires a section and a stack to hold at least one child, and a split at least two', () => {
    const offenders: string[] = [];

    for (const type of LAYOUT_NODE_TYPES) {
      if (accepts(panelOf([{ type, children: [] }]))) {
        offenders.push(`${type} accepted no children`);
      }
    }
    expect(offenders).toEqual([]);

    // A division with one pane is just that pane, so the split's minimum is two
    // while the other two containers are content with one.
    const table = minimalNode('table');

    expect(accepts(panelOf([{ type: 'stack', children: [table] }]))).toBe(true);
    expect(accepts(panelOf([{ type: 'section', children: [table] }]))).toBe(true);
    expect(rejectionLocations(panelOf([{ type: 'split', children: [table] }]))).toEqual([
      'layout.0.children: too_small',
    ]);
  });

  it('accepts a split direction from the declared axes and rejects another', () => {
    const panes = [minimalNode('table'), minimalNode('flame')];

    expect(accepts(panelOf([{ type: 'split', direction: 'horizontal', children: panes }]))).toBe(
      true,
    );
    expect(
      rejectionLocations(panelOf([{ type: 'split', direction: 'diagonal', children: panes }])),
    ).toEqual(['layout.0.direction: invalid_value']);
  });
});

/*
 * ---------------------------------------------------------------------------
 * 9a. The nesting-depth bound
 *
 * The authoring schema admits exactly `PANEL_MAX_NODE_DEPTH` levels, counting a
 * top-level node as level 1, the same bound `validatePanelSpec` applies at step
 * 3. It is a property of the schema itself — the deepest level's union accepts
 * no container — so the schema library never descends past it, and no depth of
 * input can exhaust the call stack of either `safeParse` or the non-throwing
 * parser. The parser additionally reports the validator's own code for a
 * too-deep document, found by an iterative preflight before the schema runs,
 * and turns an exception raised while reading the value into a rejection.
 * ---------------------------------------------------------------------------
 */

/**
 * A top-level node at the top of a chain of containers, with `leaf` at level
 * `depth`.
 *
 * Built iteratively, from the leaf up, so a chain a hundred thousand levels deep
 * costs this helper no call stack either. The containers alternate between
 * `section` and `stack` — the two that accept a single child — so more than one
 * container schema of the chain is exercised.
 *
 * @param depth The level of the leaf, a top-level node being level 1.
 * @param leaf The node at that level.
 * @returns The top-level node of the chain.
 */
function nestedNode(depth: number, leaf: unknown = { type: 'table', source: 'spans' }): unknown {
  let node: unknown = leaf;

  for (let level = depth - 1; level >= 1; level -= 1) {
    node = { type: level % 2 === 0 ? 'section' : 'stack', children: [node] };
  }

  return node;
}

/**
 * A document whose single top-level node is a {@link nestedNode} chain.
 *
 * @param depth The level of the leaf, a top-level node being level 1.
 * @param leaf The node at that level.
 * @returns A document of that nesting.
 */
function nestedPanel(depth: number, leaf?: unknown): Record<string, unknown> {
  return panelOf([nestedNode(depth, leaf)]);
}

/**
 * The dotted path of the node at a level of a {@link nestedPanel} chain: the
 * top-level node, followed by one `children.0` hop per level below it.
 *
 * @param level The node's level, 1 for the top-level node.
 * @returns For instance `layout.0.children.0` for level 2.
 */
function chainPathAt(level: number): string {
  return `layout.0${'.children.0'.repeat(level - 1)}`;
}

/**
 * A run of distinct, well-formed leaves, for the arrays whose length is what a
 * test is about.
 *
 * @param count How many leaves.
 * @returns A fresh array of that many fresh leaf objects.
 */
function tableLeaves(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, () => ({ type: 'table', source: 'spans' }));
}

/**
 * The message the deepest level's union reports for a container placed at it.
 *
 * Restated here as the literal a model is shown, so a change to the wording is
 * a deliberate edit to this suite rather than an unnoticed change to the repair
 * prompt. Built from the depth constant, as the module under test builds it.
 */
const DEEPEST_LEVEL_MESSAGE = `Only a visualization node is accepted here: this position is at the deepest nesting level a panel allows (${String(PANEL_MAX_NODE_DEPTH)}), so no section, split or stack may be placed at it.`;

/** A sentinel planted in content a depth rejection must not echo. */
const DEPTH_SENTINEL = 'QQ-DEPTH-SENTINEL-QQ';

/**
 * Every surface of a rejection a leaked value could appear on, as text.
 *
 * The same four surfaces the privacy block below checks: the message, the hint,
 * the serialised details and the wire payload.
 */
function rejectionSurfaces(value: unknown): string {
  const result = parsePanelSpecInput(value);

  if (result.ok) {
    throw new Error('the parser accepted a value this test expects it to reject.');
  }

  return [
    result.error.message,
    result.error.hint ?? '',
    JSON.stringify(result.error.details ?? {}),
    JSON.stringify(result.error.toPayload()),
  ].join('\n');
}

/** The issues a rejected value's error carries in its details. */
function reportedIssues(value: unknown): readonly unknown[] {
  const result = parsePanelSpecInput(value);

  if (result.ok) {
    throw new Error('the parser accepted a value this test expects it to reject.');
  }

  expect(result.error.code).toBe('PANEL_INVALID');

  const issues = (result.error.details ?? {})['issues'];

  return Array.isArray(issues) ? (issues as readonly unknown[]) : [];
}

describe('the nesting-depth bound', () => {
  it('bounds nesting at the validator’s depth, which leaves room for containers', () => {
    // The chain needs a level below every container level; the module under
    // test guards the same invariant when it builds the chain.
    expect(Number.isInteger(PANEL_MAX_NODE_DEPTH)).toBe(true);
    expect(PANEL_MAX_NODE_DEPTH).toBeGreaterThanOrEqual(2);
  });

  it('accepts a leaf at the deepest level, below a container at every level above it', () => {
    const document = nestedPanel(PANEL_MAX_NODE_DEPTH);

    expect(parsePanelOrFail(document)).toEqual(document);
    expect(parsePanelSpecInput(document).ok).toBe(true);
  });

  it('accepts a split at the last container level, with leaves below it', () => {
    // The split is the one container with a minimum of two children, so it is
    // checked at the level where the chain hands over to the leaf-only union.
    const document = nestedPanel(PANEL_MAX_NODE_DEPTH - 1, {
      type: 'split',
      direction: 'horizontal',
      children: [
        { type: 'table', source: 'spans' },
        { type: 'flame', source: 'trace' },
      ],
    });

    expect(parsePanelOrFail(document)).toEqual(document);
  });

  it('rejects a container at the deepest level with one issue at its type, and the fixed message', () => {
    // One level too many: the container at the deepest level has nowhere to put
    // its children, and nothing below it is parsed.
    const document = nestedPanel(PANEL_MAX_NODE_DEPTH + 1);
    const parsed = panelSpecInputSchema.safeParse(document);

    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }

    expect(
      parsed.error.issues.map((issue) => ({
        path: issue.path.map((segment) => String(segment)).join('.'),
        code: issue.code,
        message: issue.message,
      })),
    ).toEqual([
      {
        path: `${chainPathAt(PANEL_MAX_NODE_DEPTH)}.type`,
        code: 'invalid_union',
        message: DEEPEST_LEVEL_MESSAGE,
      },
    ]);
  });

  it('rejects every container type at the deepest level, and quotes no value of it', () => {
    for (const type of LAYOUT_NODE_TYPES) {
      const document = nestedPanel(PANEL_MAX_NODE_DEPTH, {
        type,
        title: DEPTH_SENTINEL,
        children: [
          { type: 'table', source: 'spans' },
          { type: 'eventLog', source: 'events' },
        ],
      });
      const parsed = panelSpecInputSchema.safeParse(document);

      expect(parsed.success).toBe(false);
      if (parsed.success) {
        continue;
      }

      expect(issueLocations(parsed.error.issues)).toEqual([
        `${chainPathAt(PANEL_MAX_NODE_DEPTH)}.type: invalid_union`,
      ]);
      expect(parsed.error.issues.map((issue) => issue.message)).toEqual([DEEPEST_LEVEL_MESSAGE]);
      expect(JSON.stringify(parsed.error.issues.map((issue) => issue.message))).not.toContain(
        DEPTH_SENTINEL,
      );
    }
  });

  it('lists the visualization node types for an unknown type at the deepest level', () => {
    // Not a container placed too deep, so not the depth message: the position
    // accepts leaves only, and those are what the author is told about.
    const document = nestedPanel(PANEL_MAX_NODE_DEPTH, { type: 'gauge', title: DEPTH_SENTINEL });
    const typePath = `${chainPathAt(PANEL_MAX_NODE_DEPTH)}.type`;

    expect(schemaMessages(document)).toEqual([
      `${typePath}: Unknown node type; at the deepest nesting level (${String(PANEL_MAX_NODE_DEPTH)}) use a visualization node: ${VISUALIZATION_NODE_TYPES.join('|')}`,
    ]);
    expect(reportedIssues(document)).toEqual([
      {
        path: typePath,
        code: 'panel_node_type_unknown',
        expected: VISUALIZATION_NODE_TYPES.join(' | '),
      },
    ]);
    expect(rejectionSurfaces(document)).not.toContain(DEPTH_SENTINEL);
  });

  it('keeps the ordinary message for a malformed leaf at the deepest level', () => {
    // The deepest level's custom message belongs to its own no-matching-type
    // issue only. A leaf that matched reports its field's own issue, word for
    // word as it would at the top of the layout.
    const badLeaf = { type: 'table', source: 'spans', sort: 'size_desc' };
    const shallow = panelSpecInputSchema.safeParse(nestedPanel(1, badLeaf));
    const deepest = panelSpecInputSchema.safeParse(nestedPanel(PANEL_MAX_NODE_DEPTH, badLeaf));

    expect(shallow.success).toBe(false);
    expect(deepest.success).toBe(false);
    if (shallow.success || deepest.success) {
      return;
    }

    expect(issueLocations(deepest.error.issues)).toEqual([
      `${chainPathAt(PANEL_MAX_NODE_DEPTH)}.sort: invalid_value`,
    ]);
    expect(deepest.error.issues.map((issue) => issue.message)).toEqual(
      shallow.error.issues.map((issue) => issue.message),
    );
    expect(deepest.error.issues.map((issue) => issue.message)).not.toContain(DEEPEST_LEVEL_MESSAGE);
  });

  it('keeps the ordinary message for a value at the deepest level that is not an object', () => {
    const shallow = panelSpecInputSchema.safeParse(nestedPanel(1, 'not a node'));
    const deepest = panelSpecInputSchema.safeParse(nestedPanel(PANEL_MAX_NODE_DEPTH, 'not a node'));

    expect(shallow.success).toBe(false);
    expect(deepest.success).toBe(false);
    if (shallow.success || deepest.success) {
      return;
    }

    expect(issueLocations(deepest.error.issues)).toEqual([
      `${chainPathAt(PANEL_MAX_NODE_DEPTH)}: invalid_type`,
    ]);
    expect(deepest.error.issues.map((issue) => issue.message)).toEqual(
      shallow.error.issues.map((issue) => issue.message),
    );
  });

  it('parses a document of any depth without throwing, through the schema and the parser', () => {
    for (const depth of [PANEL_MAX_NODE_DEPTH + 1, 1_000, 100_000]) {
      const document = nestedPanel(depth);

      expect(() => panelSpecInputSchema.safeParse(document)).not.toThrow();
      expect(() => parsePanelSpecInput(document)).not.toThrow();
      expect(panelSpecInputSchema.safeParse(document).success).toBe(false);
      expect(parsePanelSpecInput(document).ok).toBe(false);
    }
  });

  it('reports the validator’s depth code at the first node beyond the bound', () => {
    // The first node beyond the bound sits one level below the deepest level,
    // with one `children` hop per level above it — the path convention
    // `validatePanelSpec` reports in — whatever lies further down.
    const expected = [
      { path: chainPathAt(PANEL_MAX_NODE_DEPTH + 1), code: 'panel_node_depth_exceeded' },
    ];

    for (const depth of [PANEL_MAX_NODE_DEPTH + 1, 1_000, 100_000]) {
      expect(reportedIssues(nestedPanel(depth))).toEqual(expected);
    }

    expect(isPanelValidationIssueCode('panel_node_depth_exceeded')).toBe(true);

    const result = parsePanelSpecInput(nestedPanel(1_000));

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.message).toContain(
      `${chainPathAt(PANEL_MAX_NODE_DEPTH + 1)}: panel_node_depth_exceeded`,
    );
    expect(result.error.hint).toContain(String(PANEL_MAX_NODE_DEPTH));
  });

  it('reports every too-deep node, in reading order, with the count of those not listed', () => {
    // Twelve leaves under one container at the deepest level: every one of them
    // is a node beyond the bound, and the message lists the first eight.
    const tooDeep = Array.from({ length: 12 }, () => ({ type: 'table', source: 'spans' }));
    const document = nestedPanel(PANEL_MAX_NODE_DEPTH, { type: 'stack', children: tooDeep });
    const issues = reportedIssues(document);
    const deepestContainer = chainPathAt(PANEL_MAX_NODE_DEPTH);

    expect(issues).toEqual(
      tooDeep.map((_, index) => ({
        path: `${deepestContainer}.children.${String(index)}`,
        code: 'panel_node_depth_exceeded',
      })),
    );

    const result = parsePanelSpecInput(document);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('and 4 more');
    }
  });

  it('rejects through the schema every value the preflight rejects, except by the node count', () => {
    // The preflight's width and depth rules only ever change which issues a
    // document is reported with, never whether it is accepted. The one rule
    // outside this invariant is the node count: the schema cannot express a
    // total, so a document over it and within every other bound is accepted by
    // the schema — asserted where the budget is, in the block below. No value in
    // this corpus is rejected by that rule, which the loop checks as well.
    const cyclic: { type: string; children: unknown[] } = { type: 'section', children: [] };
    cyclic.children.push(cyclic);

    const tooDeepContainer = {
      type: 'split',
      children: [
        { type: 'table', source: 'spans' },
        { type: 'flame', source: 'trace' },
      ],
    };
    const sparseTooDeep: unknown[] = [];
    sparseTooDeep[2] = { type: 'table', source: 'spans' };

    const corpus: readonly (readonly [string, unknown, string])[] = [
      ['one level too deep', nestedPanel(PANEL_MAX_NODE_DEPTH + 1), 'panel_node_depth_exceeded'],
      ['far too deep', nestedPanel(1_000), 'panel_node_depth_exceeded'],
      [
        'a split one level too deep',
        nestedPanel(PANEL_MAX_NODE_DEPTH, tooDeepContainer),
        'panel_node_depth_exceeded',
      ],
      ['a self-containing section', panelOf([cyclic]), 'panel_node_depth_exceeded'],
      [
        'too deep below a well-formed first node',
        panelOf([{ type: 'table', source: 'spans' }, nestedNode(PANEL_MAX_NODE_DEPTH + 2)]),
        'panel_node_depth_exceeded',
      ],
      [
        'too deep below a malformed leaf',
        nestedPanel(PANEL_MAX_NODE_DEPTH + 1, { type: 'table', source: 'spans', extra: true }),
        'panel_node_depth_exceeded',
      ],
      [
        'a sparse array of children at the deepest level',
        nestedPanel(PANEL_MAX_NODE_DEPTH, { type: 'stack', children: sparseTooDeep }),
        'panel_node_depth_exceeded',
      ],
      ['a layout over its bound', panelOf(tableLeaves(PANEL_LAYOUT_MAX_NODES + 1)), 'too_big'],
      [
        'a top-level container over its bound',
        nestedPanel(1, { type: 'section', children: tableLeaves(LAYOUT_NODE_MAX_CHILDREN + 1) }),
        'too_big',
      ],
      [
        'a container over its bound at the deepest level',
        nestedPanel(PANEL_MAX_NODE_DEPTH, {
          type: 'stack',
          children: tableLeaves(LAYOUT_NODE_MAX_CHILDREN + 1),
        }),
        'too_big',
      ],
      [
        'five thousand children at the deepest level',
        nestedPanel(PANEL_MAX_NODE_DEPTH, { type: 'stack', children: tableLeaves(5_000) }),
        'too_big',
      ],
    ];
    const disagreements: string[] = [];

    for (const [label, value, expectedCode] of corpus) {
      const codes = reportedIssues(value).map((issue) =>
        typeof issue === 'object' && issue !== null ? (issue as { code?: unknown }).code : issue,
      );
      const schemaAccepted = panelSpecInputSchema.safeParse(value).success;

      if (!codes.includes(expectedCode)) {
        disagreements.push(`${label}: the preflight did not report ${expectedCode}`);
      }
      if (codes.includes('panel_node_count_exceeded')) {
        disagreements.push(`${label}: rejected by the node count, which this invariant excludes`);
      }
      if (schemaAccepted) {
        disagreements.push(`${label}: the schema accepted a value the preflight rejects`);
      }
    }

    expect(disagreements).toEqual([]);
  });

  it('rejects a self-containing node without throwing and without echoing its content', () => {
    const cyclic: { type: string; title: string; children: unknown[] } = {
      type: 'stack',
      title: DEPTH_SENTINEL,
      children: [],
    };
    cyclic.children.push(cyclic);
    const document = panelOf([cyclic]);

    expect(() => panelSpecInputSchema.safeParse(document)).not.toThrow();
    expect(() => parsePanelSpecInput(document)).not.toThrow();
    expect(reportedIssues(document)).toEqual([
      { path: chainPathAt(PANEL_MAX_NODE_DEPTH + 1), code: 'panel_node_depth_exceeded' },
    ]);
    expect(rejectionSurfaces(document)).not.toContain(DEPTH_SENTINEL);
  });

  it('turns a throwing getter into a rejection that carries nothing of the exception', () => {
    // Once on the document, where the preflight reads first, and once on a
    // node's field, which only the schema reads.
    const onDocument = {
      title: 'Interaction latency',
      summary: 'One sentence about the capture.',
      get layout(): never {
        throw new Error(DEPTH_SENTINEL);
      },
    };
    const onNodeField = panelOf([
      {
        type: 'table',
        source: 'spans',
        get sort(): never {
          throw new Error(DEPTH_SENTINEL);
        },
      },
    ]);

    for (const value of [onDocument, onNodeField]) {
      expect(() => parsePanelSpecInput(value)).not.toThrow();

      const result = parsePanelSpecInput(value);

      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }

      expect(result.error.code).toBe('PANEL_INVALID');
      expect(result.error.cause).toBeUndefined();
      expect(result.error.message).toContain('<document>: panel_input_unreadable');
      expect(reportedIssues(value)).toEqual([{ path: '', code: 'panel_input_unreadable' }]);
      expect(rejectionSurfaces(value)).not.toContain(DEPTH_SENTINEL);
    }
  });

  it('turns a throwing proxy trap into the same rejection', () => {
    const hostile = new Proxy(
      {},
      {
        get(): never {
          throw new Error(DEPTH_SENTINEL);
        },
        ownKeys(): never {
          throw new Error(DEPTH_SENTINEL);
        },
      },
    );

    expect(() => parsePanelSpecInput(hostile)).not.toThrow();
    expect(reportedIssues(hostile)).toEqual([{ path: '', code: 'panel_input_unreadable' }]);
    expect(rejectionSurfaces(hostile)).not.toContain(DEPTH_SENTINEL);
  });
});

/*
 * ---------------------------------------------------------------------------
 * 9b. The width, total and issue bounds of the node preflight
 *
 * The chain bounds how deep the schema parses; nothing in a schema bounds how
 * wide an array is before its elements are parsed, and nothing in any one
 * node's schema can see how many nodes a document holds in all. The preflight
 * does both before anything is parsed: a node array longer than its position
 * allows is rejected from its `length` alone, a document of more than
 * `PANEL_INPUT_MAX_NODE_COUNT` positions is rejected at its root, and at most
 * `PANEL_INPUT_MAX_PREFLIGHT_ISSUES` issues are collected — an early stop
 * being said so rather than left to look like a complete count.
 *
 * The proofs that an array was never read are counts of the reads themselves,
 * taken through a proxy or a getter, rather than timings: a count cannot pass on
 * a fast machine and fail on a slow one.
 * ---------------------------------------------------------------------------
 */

/** The clause a truncated rejection's message ends with, as the module writes it. */
const TRUNCATED_CLAUSE = '; the document was not examined further.';

/**
 * A document around a layout, taking the layout **as given**.
 *
 * {@link panelOf} copies its layout, which reads every entry and turns every
 * hole into `undefined`; the tests below need the parser to receive the very
 * array they built — a counting proxy, a sparse array, a ten-million-slot one.
 *
 * @param layout The value to place at `layout`, uncopied.
 * @returns A document of that layout with a valid title and summary.
 */
function documentWithLayout(layout: unknown): Record<string, unknown> {
  return {
    title: 'Interaction latency',
    summary: 'One sentence about the capture.',
    layout,
  };
}

/**
 * An array wrapped so that every read of one of its entries is counted.
 *
 * `Array.isArray` sees through the proxy, so the parser treats it as the array
 * it wraps; only reads of index keys are counted, so reading `length` is free.
 *
 * @param entries The array to wrap. Holes stay holes.
 * @returns The wrapped array, and a function answering how many entry reads it
 * has served.
 */
function countingArray(entries: unknown[]): {
  readonly array: unknown[];
  readonly entryReads: () => number;
} {
  let reads = 0;
  const array = new Proxy(entries, {
    get(target, key, receiver): unknown {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        reads += 1;
      }

      return Reflect.get(target, key, receiver);
    },
  });

  return { array, entryReads: () => reads };
}

/**
 * What a rejected value's error says, for the assertions about truncation.
 *
 * @param value The value expected to be rejected.
 * @returns The message, the reported issues and the `truncated` detail.
 */
function rejectionSummary(value: unknown): {
  readonly message: string;
  readonly issues: readonly unknown[];
  readonly truncated: unknown;
} {
  const result = parsePanelSpecInput(value);

  if (result.ok) {
    throw new Error('the parser accepted a value this test expects it to reject.');
  }

  expect(result.error.code).toBe('PANEL_INVALID');

  const details = result.error.details ?? {};
  const issues = details['issues'];

  return {
    message: result.error.message,
    issues: Array.isArray(issues) ? (issues as readonly unknown[]) : [],
    truncated: details['truncated'],
  };
}

/**
 * The issues the parser reports for a value, as `path: code` strings, or `[]`
 * when it accepts the value — the form {@link issueLocations} renders the
 * schema's issues in, so the two verdicts can be compared directly.
 *
 * @param value Any value.
 * @returns One `path: code` string per reported issue.
 */
function parserLocations(value: unknown): readonly string[] {
  const result = parsePanelSpecInput(value);

  if (result.ok) {
    return [];
  }

  const issues = (result.error.details ?? {})['issues'];

  return (Array.isArray(issues) ? (issues as readonly { path: string; code: string }[]) : []).map(
    (issue) => `${issue.path}: ${issue.code}`,
  );
}

/**
 * A layout of `sections` sections of `leavesEach` leaves each: two levels,
 * `sections × (1 + leavesEach)` node positions.
 *
 * @param sections How many top-level sections.
 * @param leavesEach How many leaves in each.
 * @returns The layout.
 */
function sectionsOfLeaves(sections: number, leavesEach: number): Record<string, unknown>[] {
  return Array.from({ length: sections }, () => ({
    type: 'section',
    children: tableLeaves(leavesEach),
  }));
}

describe('the width, total and issue bounds of the node preflight', () => {
  it('derives the node budget from the two width bounds, and exports it from the package entry', () => {
    // The widest document two levels deep: every top-level position a
    // container, every container full.
    expect(PANEL_INPUT_MAX_NODE_COUNT).toBe(
      PANEL_LAYOUT_MAX_NODES * (1 + LAYOUT_NODE_MAX_CHILDREN),
    );
    expect(ENTRY_MAX_NODE_COUNT).toBe(PANEL_INPUT_MAX_NODE_COUNT);
    expect(Number.isSafeInteger(PANEL_INPUT_MAX_PREFLIGHT_ISSUES)).toBe(true);
    expect(PANEL_INPUT_MAX_PREFLIGHT_ISSUES).toBeGreaterThan(0);
  });

  it('rejects a layout over its bound with too_big at layout, reading none of its entries', () => {
    const over = countingArray(tableLeaves(PANEL_LAYOUT_MAX_NODES + 1));
    const rejection = rejectionSummary(documentWithLayout(over.array));

    expect(rejection.issues).toEqual([{ path: 'layout', code: 'too_big' }]);
    expect(rejection.truncated).toBeUndefined();
    expect(rejection.message).toContain('layout: too_big');
    expect(over.entryReads()).toBe(0);

    // The schema's own diagnosis at the same path: the preflight reports what
    // the schema would, without letting it read the array.
    expect(rejectionLocations(panelOf(tableLeaves(PANEL_LAYOUT_MAX_NODES + 1)))).toContain(
      'layout: too_big',
    );
  });

  it('sizes a ten-million-slot array from its length alone, at the root and in a container', () => {
    const hugeLayout: unknown[] = [];
    hugeLayout.length = 10_000_000;
    const layout = countingArray(hugeLayout);

    const hugeChildren: unknown[] = [];
    hugeChildren.length = 10_000_000;
    const children = countingArray(hugeChildren);

    expect(reportedIssues(documentWithLayout(layout.array))).toEqual([
      { path: 'layout', code: 'too_big' },
    ]);
    expect(reportedIssues(nestedPanel(1, { type: 'stack', children: children.array }))).toEqual([
      { path: 'layout.0.children', code: 'too_big' },
    ]);
    expect(layout.entryReads()).toBe(0);
    expect(children.entryReads()).toBe(0);
  });

  it('rejects children over their bound at level 1 and at the deepest level, as the schema does', () => {
    for (const level of [1, PANEL_MAX_NODE_DEPTH]) {
      const children = countingArray(tableLeaves(LAYOUT_NODE_MAX_CHILDREN + 1));

      expect(
        reportedIssues(nestedPanel(level, { type: 'stack', children: children.array })),
      ).toEqual([{ path: `${chainPathAt(level)}.children`, code: 'too_big' }]);
      expect(children.entryReads()).toBe(0);

      // The schema rejects the same document: with the same issue at level 1,
      // and at the deepest level by refusing the container outright.
      const plain = nestedPanel(level, {
        type: 'stack',
        children: tableLeaves(LAYOUT_NODE_MAX_CHILDREN + 1),
      });

      expect(rejectionLocations(plain)).toContain(
        level === PANEL_MAX_NODE_DEPTH
          ? `${chainPathAt(level)}.type: invalid_union`
          : `${chainPathAt(level)}.children: too_big`,
      );
    }
  });

  it('answers five thousand children at the deepest level with one bounded issue', () => {
    // The case that once produced one issue per child: the array is refused
    // from its length, so the rejection is one issue whatever the length.
    const rejection = rejectionSummary(
      nestedPanel(PANEL_MAX_NODE_DEPTH, { type: 'stack', children: tableLeaves(5_000) }),
    );

    expect(rejection.issues).toEqual([
      { path: `${chainPathAt(PANEL_MAX_NODE_DEPTH)}.children`, code: 'too_big' },
    ]);
    expect(rejection.issues.length).toBeLessThanOrEqual(PANEL_INPUT_MAX_PREFLIGHT_ISSUES);
    // Nothing admitted was left unexamined, so the rejection is not truncated.
    expect(rejection.truncated).toBeUndefined();
    expect(rejection.message).not.toContain(TRUNCATED_CLAUSE);
  });

  it('stops at the issue cap and says the document was not examined further', () => {
    // A full container at the deepest level: one too-deep position per child,
    // more of them than the cap.
    expect(LAYOUT_NODE_MAX_CHILDREN).toBeGreaterThan(PANEL_INPUT_MAX_PREFLIGHT_ISSUES);

    const deepestContainer = chainPathAt(PANEL_MAX_NODE_DEPTH);
    const rejection = rejectionSummary(
      nestedPanel(PANEL_MAX_NODE_DEPTH, {
        type: 'stack',
        children: tableLeaves(LAYOUT_NODE_MAX_CHILDREN),
      }),
    );

    expect(rejection.issues).toEqual(
      Array.from({ length: PANEL_INPUT_MAX_PREFLIGHT_ISSUES }, (_, index) => ({
        path: `${deepestContainer}.children.${String(index)}`,
        code: 'panel_node_depth_exceeded',
      })),
    );
    expect(rejection.truncated).toBe(true);
    expect(rejection.message.endsWith(TRUNCATED_CLAUSE)).toBe(true);
    // The message lists eight and counts the rest of what was collected; the
    // closing clause is what stops that count being read as complete.
    expect(rejection.message).toContain(`and ${String(PANEL_INPUT_MAX_PREFLIGHT_ISSUES - 8)} more`);
  });

  it('does not call a walk truncated when its last position brings the issues to the cap', () => {
    const rejection = rejectionSummary(
      nestedPanel(PANEL_MAX_NODE_DEPTH, {
        type: 'stack',
        children: tableLeaves(PANEL_INPUT_MAX_PREFLIGHT_ISSUES),
      }),
    );

    expect(rejection.issues).toHaveLength(PANEL_INPUT_MAX_PREFLIGHT_ISSUES);
    expect(rejection.truncated).toBeUndefined();
    expect(rejection.message).not.toContain(TRUNCATED_CLAUSE);
  });

  it('bounds the issues of a self-containing container at the cap', () => {
    // One container placed in every one of its own child positions: sixty-four
    // positions per level, cut off at the depth bound and then at the cap.
    const cyclic: { type: string; children: unknown[] } = { type: 'stack', children: [] };
    for (let index = 0; index < LAYOUT_NODE_MAX_CHILDREN; index += 1) {
      cyclic.children.push(cyclic);
    }

    const rejection = rejectionSummary(panelOf([cyclic]));

    expect(rejection.issues).toHaveLength(PANEL_INPUT_MAX_PREFLIGHT_ISSUES);
    expect(rejection.truncated).toBe(true);
  });

  it('reads the holes of a sparse node array as absent nodes, and leaves the verdict to the schema', () => {
    const sparseLayout: unknown[] = [];
    sparseLayout[0] = { type: 'table', source: 'spans' };
    sparseLayout[2] = { type: 'flame', source: 'trace' };

    const sparseChildren: unknown[] = [];
    sparseChildren[1] = { type: 'table', source: 'spans' };

    const corpus: readonly (readonly [string, unknown])[] = [
      ['a sparse layout', documentWithLayout(sparseLayout)],
      ['sparse children at level 1', nestedPanel(1, { type: 'stack', children: sparseChildren })],
      [
        'sparse children of the last container level',
        nestedPanel(PANEL_MAX_NODE_DEPTH - 1, { type: 'section', children: sparseChildren }),
      ],
      ['a layout of holes only', documentWithLayout(new Array<unknown>(3))],
    ];

    for (const [label, value] of corpus) {
      expect(() => parsePanelSpecInput(value), label).not.toThrow();

      const schema = panelSpecInputSchema.safeParse(value);

      expect(parsePanelSpecInput(value).ok, label).toBe(schema.success);
      expect(parserLocations(value), label).toEqual(
        schema.success ? [] : issueLocations(schema.error.issues),
      );
    }
  });

  it('rejects a document over the node budget at its root, though every array is within its bound', () => {
    // At the budget exactly, plus one position a level further down.
    const layout = sectionsOfLeaves(PANEL_LAYOUT_MAX_NODES, LAYOUT_NODE_MAX_CHILDREN);
    const [firstSection] = layout;
    if (firstSection === undefined) {
      throw new Error('the layout has no first section.');
    }
    firstSection['children'] = [
      { type: 'stack', children: tableLeaves(1) },
      ...tableLeaves(LAYOUT_NODE_MAX_CHILDREN - 1),
    ];
    const document = panelOf(layout);

    expect(() => parsePanelSpecInput(document)).not.toThrow();

    const rejection = rejectionSummary(document);

    expect(rejection.issues).toEqual([{ path: '', code: 'panel_node_count_exceeded' }]);
    expect(rejection.truncated).toBe(true);
    expect(rejection.message).toContain('<document>: panel_node_count_exceeded');
    expect(rejection.message.endsWith(TRUNCATED_CLAUSE)).toBe(true);

    // The documented exception to "the schema rejects it too": a total is the
    // one rule the schema cannot express, so the schema alone accepts this.
    expect(panelSpecInputSchema.safeParse(document).success).toBe(true);
  });

  it('reports the node count first, ahead of what the walk found before it stopped', () => {
    const layout = sectionsOfLeaves(PANEL_LAYOUT_MAX_NODES, LAYOUT_NODE_MAX_CHILDREN);
    const [firstSection] = layout;
    if (firstSection === undefined) {
      throw new Error('the layout has no first section.');
    }
    // One extra position below the first child, and an over-long container as
    // the second child, whose entries are refused and so never counted.
    firstSection['children'] = [
      { type: 'stack', children: tableLeaves(1) },
      { type: 'stack', children: tableLeaves(LAYOUT_NODE_MAX_CHILDREN + 1) },
      ...tableLeaves(LAYOUT_NODE_MAX_CHILDREN - 2),
    ];

    expect(reportedIssues(panelOf(layout))).toEqual([
      { path: '', code: 'panel_node_count_exceeded' },
      { path: 'layout.0.children.1.children', code: 'too_big' },
    ]);
  });

  it('stops a graph that shares one subtree in every position, visiting no more than the budget', () => {
    // Every container holds the one container of the level below in each of
    // its sixty-four positions, down to a leaf at the deepest level: a few
    // objects that present 64 + 64² + … + 64⁸ positions to a walk that follows
    // references. Each container's `children` is a getter, so every visit is
    // counted.
    let childrenReads = 0;
    let node: unknown = { type: 'table', source: 'spans' };

    for (let level = PANEL_MAX_NODE_DEPTH - 1; level >= 1; level -= 1) {
      const children: readonly unknown[] = Array.from(
        { length: LAYOUT_NODE_MAX_CHILDREN },
        () => node,
      );

      node = {
        type: 'stack',
        get children(): readonly unknown[] {
          childrenReads += 1;

          // A tripwire rather than a hang: a walk without a budget would follow
          // these references for longer than any test runs, so one past the
          // budget is stopped here, and fails the assertions below instead.
          if (childrenReads > PANEL_INPUT_MAX_NODE_COUNT) {
            throw new Error('the walk visited more positions than the budget allows.');
          }

          return children;
        },
      };
    }

    const shared = node;
    const document = documentWithLayout(
      Array.from({ length: PANEL_LAYOUT_MAX_NODES }, () => shared),
    );
    const rejection = rejectionSummary(document);

    expect(rejection.issues).toEqual([{ path: '', code: 'panel_node_count_exceeded' }]);
    expect(rejection.truncated).toBe(true);
    expect(childrenReads).toBeGreaterThan(0);
    expect(childrenReads).toBeLessThanOrEqual(PANEL_INPUT_MAX_NODE_COUNT);
  });

  it('admits a document exactly at the budget, so the schema decides', () => {
    const layout = sectionsOfLeaves(PANEL_LAYOUT_MAX_NODES, LAYOUT_NODE_MAX_CHILDREN);
    const positions = layout.length * (1 + LAYOUT_NODE_MAX_CHILDREN);

    expect(positions).toBe(PANEL_INPUT_MAX_NODE_COUNT);
    expect(parsePanelSpecInput(panelOf(layout)).ok).toBe(true);

    // With one malformed leaf, the rejection is the schema's, issue for issue.
    const malformed = sectionsOfLeaves(PANEL_LAYOUT_MAX_NODES, LAYOUT_NODE_MAX_CHILDREN);
    const lastSection = malformed[malformed.length - 1];
    if (lastSection === undefined) {
      throw new Error('the layout has no last section.');
    }
    lastSection['children'] = [
      ...tableLeaves(LAYOUT_NODE_MAX_CHILDREN - 1),
      { type: 'table', source: 'spans', sort: 'size_desc' },
    ];
    const document = panelOf(malformed);
    const expected = `layout.${String(PANEL_LAYOUT_MAX_NODES - 1)}.children.${String(
      LAYOUT_NODE_MAX_CHILDREN - 1,
    )}.sort: invalid_value`;

    expect(rejectionLocations(document)).toEqual([expected]);
    expect(parserLocations(document)).toEqual([expected]);
    expect(rejectionSummary(document).truncated).toBeUndefined();
  });

  it('treats a node array that misreports its length as unreadable', () => {
    // Only a proxy can answer `length` with something no array has; its size
    // and entries cannot be trusted, so it takes the unreadable path.
    for (const lie of [Number.NaN, -1, Number.POSITIVE_INFINITY, 2 ** 53, '3']) {
      const lying = new Proxy<unknown[]>([], {
        get(target, key, receiver): unknown {
          return key === 'length' ? lie : Reflect.get(target, key, receiver);
        },
      });

      for (const document of [
        documentWithLayout(lying),
        nestedPanel(1, { type: 'stack', children: lying }),
      ]) {
        expect(() => parsePanelSpecInput(document)).not.toThrow();
        expect(reportedIssues(document)).toEqual([{ path: '', code: 'panel_input_unreadable' }]);
      }
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * 10. A rejection carries the shape of the failure and none of the data
 *
 * The privacy requirement of AAP §0.5.2, applied to a validation error, and the
 * reason it is not optional here: the error built by `parsePanelSpecInput` is
 * logged, may be persisted with the session, travels to both user interfaces
 * over the transport's error message, and is quoted back to the model by the
 * repair loop — passing through neither the redaction layer nor the outbound
 * guard on the way. What an authored panel holds is prose about captured runtime
 * data: a component name, a redacted URL, a trace id, a statement fragment. So
 * the offending value must never enter the error in the first place.
 *
 * The sentinels are distinctive strings that occur nowhere else in this
 * repository, planted in every field of the document that carries authored
 * content, with two independent mistakes to force the rejection. One of those
 * mistakes is an unrecognised *key* whose name is itself a sentinel, which is
 * the sharper half of the test: the schema library reports the offending key
 * names on the issue, and this module must not pass them on.
 * ---------------------------------------------------------------------------
 */

/** Strings that must not survive into a rejection, one per authored field. */
const SENTINELS = Object.freeze({
  panelTitle: 'QQ-PANEL-TITLE-SENTINEL-QQ',
  summary: 'QQ-SUMMARY-SENTINEL-QQ',
  nodeTitle: 'QQ-NODE-TITLE-SENTINEL-QQ',
  nodeDescription: 'QQ-NODE-DESCRIPTION-SENTINEL-QQ',
  traceId: 'QQ-TRACE-ID-SENTINEL-QQ',
  component: 'QQ-COMPONENT-SENTINEL-QQ',
  sortValue: 'QQ-SORT-VALUE-SENTINEL-QQ',
  unknownKey: 'QQ_UNKNOWN_KEY_SENTINEL_QQ',
});

/** Every sentinel value, for the loop that proves none of them escapes. */
const SENTINEL_VALUES: readonly string[] = Object.values(SENTINELS);

/**
 * An authored document carrying a sentinel in every content-bearing field, plus
 * two mistakes that force a rejection: a sort value outside the closed
 * vocabulary, and an unrecognised key.
 */
const SENTINEL_DOCUMENT = {
  title: SENTINELS.panelTitle,
  summary: SENTINELS.summary,
  layout: [
    {
      type: 'table',
      title: SENTINELS.nodeTitle,
      description: SENTINELS.nodeDescription,
      source: 'spans',
      filter: { traceId: SENTINELS.traceId, component: SENTINELS.component },
      sort: SENTINELS.sortValue,
      [SENTINELS.unknownKey]: SENTINELS.nodeTitle,
    },
  ],
};

describe('a rejected authored panel leaks nothing it rejected', () => {
  it('is rejected, so the assertions below are about a real error', () => {
    expect(parsePanelSpecInput(SENTINEL_DOCUMENT).ok).toBe(false);
  });

  it('names the failing paths and codes, so the repair loop has something actionable', () => {
    // A message that leaks nothing and also says nothing is not the goal:
    // `packages/model-provider/src/structured.ts` re-prompts from this message
    // and has nothing else to work from, so a field path and an issue code have
    // to be in it.
    const result = parsePanelSpecInput(SENTINEL_DOCUMENT);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.message).toContain('layout.0');
    expect(result.error.message).toContain('unrecognized_keys');
    expect(result.error.message).toContain('panelSpecInput');
  });

  it('keeps every sentinel out of the message, the hint, the details and the wire payload', () => {
    const result = parsePanelSpecInput(SENTINEL_DOCUMENT);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    // `toPayload()` is checked as well as the message because
    // `@debuggen/protocol` maps that exact object onto its WebSocket `error`
    // payload, which is what both user interfaces render.
    const message = result.error.message;
    const hint = result.error.hint ?? '';
    const details = JSON.stringify(result.error.details ?? {});
    const payload = JSON.stringify(result.error.toPayload());
    const surfaces: readonly (readonly [string, string])[] = [
      ['message', message],
      ['hint', hint],
      ['details', details],
      ['payload', payload],
    ];
    const leaks: string[] = [];

    for (const [surface, text] of surfaces) {
      for (const sentinel of SENTINEL_VALUES) {
        if (text.includes(sentinel)) {
          leaks.push(`${surface} carries ${sentinel}`);
        }
      }
    }

    expect(leaks).toEqual([]);
    // Each surface is genuinely populated, so the loop above is not passing on
    // empty strings.
    expect(message.length).toBeGreaterThan(0);
    expect(hint.length).toBeGreaterThan(0);
    expect(details.length).toBeGreaterThan(0);
    expect(payload.length).toBeGreaterThan(0);
  });

  it('describes each issue by path, code and expected type only', () => {
    // The structural form of the same rule: whatever the schema library reports
    // on an issue — the rejected value, the offending key names, the list of
    // permitted values — only these three fields may be carried across.
    const result = parsePanelSpecInput(SENTINEL_DOCUMENT);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    const reported = (result.error.details ?? {})['issues'];
    const issues: readonly unknown[] = Array.isArray(reported)
      ? (reported as readonly unknown[])
      : [];
    const unexpectedFields: string[] = [];

    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      if (typeof issue !== 'object' || issue === null) {
        unexpectedFields.push(`issue is not an object: ${typeof issue}`);
        continue;
      }
      for (const field of Object.keys(issue)) {
        if (field !== 'path' && field !== 'code' && field !== 'expected') {
          unexpectedFields.push(field);
        }
      }
    }

    expect(unexpectedFields).toEqual([]);
  });

  it('reports a code from the shared closed vocabulary', () => {
    // Proof that no code was invented: the value has to be a member of the
    // tuple `@debuggen/shared` owns, which is the type `@debuggen/protocol`
    // embeds in its error payload schema.
    const result = parsePanelSpecInput(SENTINEL_DOCUMENT);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect([...DEBUGGEN_ERROR_CODES]).toContain(result.error.code);
    expect([...DEBUGGEN_ERROR_CODES]).toContain(result.error.toPayload().code);
  });
});

/*
 * ---------------------------------------------------------------------------
 * 11. The authoring schema rendered as JSON Schema
 *
 * `./json-schema.ts` has no test file of its own: AAP §0.8.3 gives this package
 * five suites and none of them is named for it, and the document it emits is a
 * projection of the schema this file already pins — it imports `./input.js` and
 * deliberately does not import `./spec.js` at all. Its assertions therefore
 * live here.
 *
 * What is at stake: the rendered document is substituted into
 * `apps/local-service/prompts/generate-panel/vNNN.md`, a prompt file that is
 * immutable once committed and whose version is recorded on the session
 * (AAP §0.5.3). It is the only form of this contract a model is ever shown, and
 * the provider strips keywords it does not support, so the document is guidance
 * and `parsePanelSpecInput` remains the only gate.
 *
 * Everything below is located *structurally* rather than by definition name: the
 * emitter names its definitions `__schemaN` by position, so a suite that keyed
 * on those names would break on an unrelated edit to `./input.ts` while proving
 * nothing about the contract.
 * ---------------------------------------------------------------------------
 */

/** A JSON object, as the emitted document's nodes are. */
type JsonRecord = Readonly<Record<string, unknown>>;

/** Narrows an emitted value to an object, failing the test if it is not one. */
function asRecord(value: unknown, what: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`the emitted schema's ${what} is not a JSON object.`);
  }

  return value as JsonRecord;
}

/**
 * The document's definition map, under either dialect's spelling.
 *
 * 2020-12 writes `$defs` and draft-07 writes `definitions`; both are read here
 * so the reference checks below can run against either rendering.
 */
function definitionsOf(document: JsonRecord): JsonRecord {
  const defs = document['$defs'] ?? document['definitions'];

  return asRecord(defs, 'definition map');
}

/** Follows `$ref` hops until a value that is not a bare reference is reached. */
function deref(document: JsonRecord, value: unknown, what: string): JsonRecord {
  const definitions = definitionsOf(document);
  let current = asRecord(value, what);

  for (let hop = 0; hop < 16; hop += 1) {
    const ref = current['$ref'];
    if (typeof ref !== 'string') {
      return current;
    }
    current = asRecord(definitions[definitionKeyOf(ref)], `reference target ${ref}`);
  }

  throw new Error(`the emitted schema's ${what} nests references more than 16 deep.`);
}

/** The definition name a `#/$defs/x` or `#/definitions/x` pointer names. */
function definitionKeyOf(ref: string): string {
  return ref.replace('#/$defs/', '').replace('#/definitions/', '');
}

/** Every `$ref` pointer anywhere inside a value, in encounter order. */
function refPointers(value: unknown, found: string[] = []): readonly string[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      refPointers(entry, found);
    }
    return found;
  }

  if (typeof value !== 'object' || value === null) {
    return found;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (key === '$ref' && typeof entry === 'string') {
      found.push(entry);
    }
    refPointers(entry, found);
  }

  return found;
}

/** Every string value of a given keyword anywhere inside a value. */
function keywordStrings(value: unknown, keyword: string, found: string[] = []): readonly string[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      keywordStrings(entry, keyword, found);
    }
    return found;
  }

  if (typeof value !== 'object' || value === null) {
    return found;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (key === keyword && typeof entry === 'string') {
      found.push(entry);
    }
    keywordStrings(entry, keyword, found);
  }

  return found;
}

/**
 * The node type one rendered spelling pins, failing the test if it pins none.
 *
 * @param document The emitted document.
 * @param spelling One object option, dereferenced.
 * @param what How to name the union in a failure.
 * @returns The `type` constant.
 */
function pinnedTypeOf(document: JsonRecord, spelling: JsonRecord, what: string): string {
  const properties = asRecord(spelling['properties'], `properties of a branch of ${what}`);
  const constant = deref(document, properties['type'], `type of a branch of ${what}`)['const'];

  if (typeof constant !== 'string') {
    throw new Error(`a branch of the emitted schema's ${what} pins no node type.`);
  }

  return constant;
}

/**
 * The options of one rendered node union, keyed by the node type each option
 * pins: for every node type, its **spellings**, each dereferenced.
 *
 * Each branch is followed through its references, because a leaf is one shared
 * schema at every nesting level and therefore renders as a definition each
 * level's union refers to. A branch is either one object — a node type with a
 * single spelling — or a union of objects that all pin the same node type: a
 * node type that must name its source renders as its two spellings, source on
 * the node or inside `query`. A branch that resolves to neither fails the
 * test: that is the assertion that the union survived rendering as a
 * discriminated set of branches rather than collapsing into a permissive
 * object.
 *
 * @param document The emitted document.
 * @param union The rendered union, already dereferenced.
 * @param what How to name the union in a failure.
 * @returns The union's spellings by node type, in branch order.
 */
function unionOptionsOf(
  document: JsonRecord,
  union: JsonRecord,
  what: string,
): Map<string, readonly JsonRecord[]> {
  const branches = union['oneOf'] ?? union['anyOf'];

  if (!Array.isArray(branches)) {
    throw new Error(`the emitted schema's ${what} is not a union.`);
  }

  const optionsByType = new Map<string, readonly JsonRecord[]>();

  for (const branch of branches) {
    const option = deref(document, branch, `branch of ${what}`);
    const nested = option['oneOf'] ?? option['anyOf'];
    const spellings =
      option['properties'] === undefined && Array.isArray(nested)
        ? nested.map((spelling) => deref(document, spelling, `spelling of a branch of ${what}`))
        : [option];
    const types = new Set(spellings.map((spelling) => pinnedTypeOf(document, spelling, what)));
    const [constant] = types;

    if (types.size !== 1 || constant === undefined) {
      throw new Error(`a branch of the emitted schema's ${what} pins more than one node type.`);
    }
    optionsByType.set(constant, spellings);
  }

  return optionsByType;
}

/**
 * The one spelling a node type renders as, failing the test for a type that
 * renders several.
 *
 * @param optionsByType A union's spellings by node type.
 * @param type The node type.
 * @param what How to name the option in a failure.
 * @returns Its only spelling.
 */
function onlySpellingOf(
  optionsByType: ReadonlyMap<string, readonly JsonRecord[]>,
  type: string,
  what: string,
): JsonRecord {
  const spellings = optionsByType.get(type) ?? [];
  const [only] = spellings;

  if (spellings.length !== 1 || only === undefined) {
    throw new Error(`the emitted ${what} renders ${String(spellings.length)} spellings, not one.`);
  }

  return only;
}

/**
 * The top-level node union — level 1 of the nesting chain — and its options.
 *
 * Located structurally, through `layout.items`, rather than by searching the
 * definitions for a union of the right size: every level above the deepest
 * renders a union with one branch per node type, so a size-based search would
 * find whichever level the emitter happened to list first.
 *
 * @param document The emitted document.
 * @returns The level-1 union, dereferenced, and its options by node type.
 */
function nodeUnionOf(document: JsonRecord): {
  union: JsonRecord;
  optionsByType: Map<string, readonly JsonRecord[]>;
} {
  const properties = asRecord(document['properties'], 'properties');
  const layout = deref(document, properties['layout'], 'layout');
  const union = deref(document, layout['items'], 'layout items');

  return { union, optionsByType: unionOptionsOf(document, union, 'top-level node union') };
}

/**
 * The definition a container option's `children` items refer to: the union of
 * the level below that container.
 *
 * @param document The emitted document.
 * @param option A container's rendered option.
 * @param what How to name the container in a failure.
 * @returns The `$ref` pointer of the child union.
 */
function childUnionPointerOf(document: JsonRecord, option: JsonRecord, what: string): string {
  const properties = asRecord(option['properties'], `properties of ${what}`);
  const children = deref(document, properties['children'], `children of ${what}`);
  const pointer = asRecord(children['items'], `children items of ${what}`)['$ref'];

  if (typeof pointer !== 'string') {
    throw new Error(`the children of ${what} do not refer to a shared child union.`);
  }

  return pointer;
}

/** Parses emitted text back to a value, without widening anything to `any`. */
function parseJsonText(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/**
 * The canonicalisation rule `./json-schema.ts` documents, implemented
 * independently here: object keys sorted by the default comparison at every
 * level, array order untouched.
 *
 * Independently, and that is the point — comparing the module's output against
 * its own sorter would prove nothing.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortKeysDeep(entry));
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = sortKeysDeep(source[key]);
  }

  return sorted;
}

/** `someIdentifier` — a lower-camel token, which in prose can only be code. */
const CAMEL_CASE_TOKEN = /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g;

/** `SomeIdentifier` — a compound capitalised token: a component or type name. */
const PASCAL_CASE_TOKEN = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g;

/** `/segment/segment` — a route or file path of at least two segments. */
const PATH_TOKEN = /\/[A-Za-z0-9_[\]$.-]+(?:\/[A-Za-z0-9_[\]$.-]+)+/g;

/** `name.tsx` — a source file name, in any of the extensions this repo uses. */
const SOURCE_FILE_TOKEN = /\b[A-Za-z0-9_[\]$-]+\.(?:tsx?|jsx?|[cm][jt]s|sql|prisma)\b/g;

/** The route prefix every handler of a Next.js application shares. */
const ROUTE_PREFIX = '/api/';

/**
 * The identifiers the emitted prose may legitimately contain: every closed
 * vocabulary this package and its two dependencies own, and nothing else.
 *
 * Imported rather than listed, so the allowance widens only when a vocabulary
 * does.
 */
const SCHEMA_VOCABULARY: ReadonlySet<string> = new Set<string>([
  ...PANEL_NODE_TYPES,
  ...DATA_QUERY_SOURCES,
  ...DATA_QUERY_SORTS,
  ...DATA_QUERY_FLAT_FIELD_KEYS,
  ...METRIC_IDS,
  ...TELEMETRY_KINDS,
  ...TELEMETRY_TIERS,
  ...SOURCE_RESOLVED_BY,
]);

/**
 * Every application-shaped token in a piece of emitted prose.
 *
 * The inverted form of the AAP §0.5.4 check, the same device
 * `./catalog.test.ts` applies to the rendered node catalog: rather than
 * scanning for a list of words someone thought of, it requires every
 * *code-shaped* token to be a member of a vocabulary this repository owns. A
 * component name, a hook name, a route, a file name or a domain identifier is
 * code-shaped and outside those vocabularies, so all of them are reported
 * without this file naming any of them.
 *
 * @param text Prose destined for a prompt file.
 * @returns One finding per offending token.
 */
function applicationShapedTokens(text: string): readonly string[] {
  const findings: string[] = [];

  if (text.includes(ROUTE_PREFIX)) {
    findings.push(`route prefix: ${ROUTE_PREFIX}`);
  }
  for (const match of text.matchAll(PATH_TOKEN)) {
    findings.push(`path: ${match[0]}`);
  }
  for (const match of text.matchAll(SOURCE_FILE_TOKEN)) {
    findings.push(`file name: ${match[0]}`);
  }
  for (const match of text.matchAll(CAMEL_CASE_TOKEN)) {
    if (!SCHEMA_VOCABULARY.has(match[0])) {
      findings.push(`identifier: ${match[0]}`);
    }
  }
  for (const match of text.matchAll(PASCAL_CASE_TOKEN)) {
    if (!SCHEMA_VOCABULARY.has(match[0])) {
      findings.push(`identifier: ${match[0]}`);
    }
  }

  return findings;
}

/**
 * A prompt line of the shape the guard must reject, built from invented tokens.
 *
 * Invented rather than borrowed: a real application symbol pasted in as a
 * negative example would plant the very thing AAP §0.5.4 forbids. These tokens
 * belong to no application in this repository.
 */
const SYNTHETIC_APPLICATION_LINE =
  'Rank the WidgetPanel rows served by /api/widgets, loaded in widgetLoader.ts by fooBarBaz.';

/**
 * The emitted text with the values of its three schema-identity keywords
 * blanked: `$ref` (an internal pointer such as `#/$defs/…`), `$schema` (the
 * dialect's well-known URI) and `$id` (this package's own URN).
 *
 * Blanked before the path scan below, because none of the three is a path into
 * anyone's project, and all three would otherwise read as one. The values
 * themselves are asserted on their own elsewhere in this block, so nothing is
 * hidden by removing them here.
 */
function withoutSchemaIdentity(text: string): string {
  return text.replaceAll(/"\$(?:ref|schema|id)": "[^"]*"/g, '"blanked": ""');
}

describe('the authoring schema rendered as JSON Schema', () => {
  it('renders without throwing, in every dialect this module will emit', () => {
    // The emission is configured to throw on a construct JSON Schema cannot
    // express, which makes this one assertion the guard that keeps `./input.ts`
    // representable: a stray `.transform()`, `.preprocess()` or `z.custom`
    // reaching the authoring schema fails here the moment it lands, instead of
    // vanishing from the document and leaving an author told about a looser
    // contract than the one it is judged by.
    expect(() => panelSpecInputJsonSchema()).not.toThrow();
    expect(() => panelSpecInputJsonSchemaText()).not.toThrow();

    for (const target of PANEL_SPEC_INPUT_SCHEMA_TARGETS) {
      expect(() => panelSpecInputJsonSchema({ target })).not.toThrow();
      expect(() => panelSpecInputJsonSchemaText({ target })).not.toThrow();
    }
  });

  it('describes an object of the three authored fields and nothing else', () => {
    const document = panelSpecInputJsonSchema();

    expect(document['type']).toBe('object');
    expect(document['additionalProperties']).toBe(false);
    expect(Object.keys(asRecord(document['properties'], 'properties')).sort()).toEqual([
      'layout',
      'summary',
      'title',
    ]);
    expect(document['required']).toEqual(['title', 'summary', 'layout']);
  });

  it('enumerates every authoring node type as a branch discriminator', () => {
    // The expected list is derived from the two owning modules' tuples, so a
    // node type added to either must appear in the emitted document or fail
    // here.
    const expected = [...LAYOUT_NODE_TYPES, ...VISUALIZATION_NODE_TYPES];
    const { optionsByType } = nodeUnionOf(panelSpecInputJsonSchema());

    expect([...optionsByType.keys()].sort()).toEqual([...expected].sort());
    expect(optionsByType.size).toBe(PANEL_NODE_TYPES.length);
  });

  it('renders the metric ids as an enumeration, not as a bare string', () => {
    // A plain string here would pass every invented id through to a panel that
    // renders nothing, so the surviving `enum` is what tells the author which
    // ids exist at all.
    const document = panelSpecInputJsonSchema();
    const { optionsByType } = nodeUnionOf(document);
    const option = onlySpellingOf(optionsByType, 'metricCards', 'metricCards option');
    const properties = asRecord(option['properties'], 'properties');
    const metrics = deref(document, properties['metrics'], 'metrics');
    const items = deref(document, metrics['items'], 'metrics items');

    expect(metrics['type']).toBe('array');
    expect(metrics['minItems']).toBe(1);
    expect(metrics['maxItems']).toBe(METRIC_IDS.length);
    expect(items['enum']).toEqual([...METRIC_IDS]);
  });

  it('renders both spellings of a node’s query, and the closed source and sort enumerations', () => {
    // Per query-backed type, from the catalog: every spelling carries the five
    // flat fields and a nested query object holding the same five, and each
    // `source` — flat and nested — is exactly the type's catalog sources.
    const document = panelSpecInputJsonSchema();
    const { optionsByType } = nodeUnionOf(document);

    for (const type of QUERY_BACKED_TYPES) {
      const spellings = optionsByType.get(type) ?? [];
      const sources = [...catalogSourcesOf(type)];

      expect(spellings.length, type).toBe(SOURCE_REQUIRED_TYPES.includes(type) ? 2 : 1);

      for (const [index, spelling] of spellings.entries()) {
        const what = `${type} spelling ${String(index)}`;
        const properties = asRecord(spelling['properties'], `properties of ${what}`);
        const query = deref(document, properties['query'], `query of ${what}`);
        const queryProperties = asRecord(query['properties'], `query properties of ${what}`);

        expect(
          DATA_QUERY_FLAT_FIELD_KEYS.filter((field) => !(field in properties)),
          what,
        ).toEqual([]);
        expect(
          DATA_QUERY_FLAT_FIELD_KEYS.filter((field) => !(field in queryProperties)),
          what,
        ).toEqual([]);
        expect(deref(document, queryProperties['source'], what)['enum'], what).toEqual(sources);
        expect(deref(document, properties['sort'], what)['enum'], what).toEqual([
          ...DATA_QUERY_SORTS,
        ]);
      }

      // The first spelling names the source on the node: an enumeration of the
      // catalog's sources, required unless the catalog implies one.
      const [flat, nested] = spellings;
      const flatProperties = asRecord(flat?.['properties'], `flat ${type} properties`);

      expect(deref(document, flatProperties['source'], type)['enum'], type).toEqual(sources);
      expect(flat?.['required'], type).toEqual(
        SOURCE_REQUIRED_TYPES.includes(type) ? ['type', 'source'] : ['type', 'metrics'],
      );

      // The second names it inside `query`, which that spelling requires, and
      // leaves the flat source out (or null).
      if (nested !== undefined) {
        const nestedProperties = asRecord(nested['properties'], `nested ${type} properties`);
        const query = deref(document, nestedProperties['query'], `nested ${type} query`);

        expect(nested['required'], type).toEqual(['type', 'query']);
        expect(query['required'], type).toEqual(['source']);
        expect(deref(document, nestedProperties['source'], type)['type'], type).toBe('null');
      }
    }
  });

  it('renders the summary as a union of both authored branches', () => {
    const document = panelSpecInputJsonSchema();
    const properties = asRecord(document['properties'], 'properties');
    const summary = deref(document, properties['summary'], 'summary');
    const branches = summary['anyOf'] ?? summary['oneOf'];

    expect(Array.isArray(branches)).toBe(true);
    expect(Array.isArray(branches) ? branches.length : 0).toBe(2);

    const resolved = (Array.isArray(branches) ? branches : []).map((branch) =>
      deref(document, branch, 'summary branch'),
    );
    const kinds = resolved.map((branch) => branch['type']);

    expect([...kinds].sort()).toEqual(['object', 'string']);

    const objectBranch = resolved.find((branch) => branch['type'] === 'object');
    const objectKeys = Object.keys(
      asRecord(asRecord(objectBranch, 'object branch')['properties'], 'object branch properties'),
    );

    expect(objectKeys.sort()).toEqual(['headline', 'likelyCauses', 'observed']);
  });

  it('resolves every reference it emits, in every dialect', () => {
    // A dangling `$ref` is an invalid schema handed to a provider, and it would
    // be invisible until the model produced something strange.
    for (const target of PANEL_SPEC_INPUT_SCHEMA_TARGETS) {
      const document = panelSpecInputJsonSchema({ target });
      const definitions = definitionsOf(document);
      const dangling = refPointers(document).filter(
        (pointer) => !Object.hasOwn(definitions, definitionKeyOf(pointer)),
      );

      expect(dangling).toEqual([]);
    }
  });

  it('expresses the nesting bound as a finite chain that ends in a leaf-only union', () => {
    // The authoring schema is unrolled rather than recursive: each level's
    // containers refer to the union of the level below, and the deepest level
    // names no container at all. So the model is shown the depth bound as
    // structure, one level at a time, down to a union it cannot nest below.
    const containers: readonly string[] = LAYOUT_NODE_TYPES;
    const everyType = [...PANEL_NODE_TYPES].sort();

    for (const target of PANEL_SPEC_INPUT_SCHEMA_TARGETS) {
      const document = panelSpecInputJsonSchema({ target });
      let { union, optionsByType } = nodeUnionOf(document);

      for (let level = 1; level < PANEL_MAX_NODE_DEPTH; level += 1) {
        expect([...optionsByType.keys()].sort()).toEqual(everyType);

        // The three containers of one level share one child union.
        const pointers = new Set(
          containers.map((type) =>
            childUnionPointerOf(
              document,
              onlySpellingOf(optionsByType, type, `${type} at level ${String(level)}`),
              `${type} at level ${String(level)} (${target})`,
            ),
          ),
        );
        const [pointer] = pointers;

        expect(pointers.size).toBe(1);
        if (pointer === undefined) {
          throw new Error(`the containers at level ${String(level)} have no child union.`);
        }

        const next = `union at level ${String(level + 1)} (${target})`;

        union = deref(document, { $ref: pointer }, next);
        optionsByType = unionOptionsOf(document, union, next);
      }

      // The deepest level: every visualization node and no container.
      expect([...optionsByType.keys()]).toEqual([...VISUALIZATION_NODE_TYPES]);
      expect([...optionsByType.keys()].filter((type) => containers.includes(type))).toEqual([]);
      expect(String(union['description'])).toContain(String(PANEL_MAX_NODE_DEPTH));
    }
  });

  it('holds no reference cycle, so it can be read without following a loop', () => {
    // Walks the definition-level reference graph depth first and requires that
    // no definition reaches itself. The recursive schema this chain replaced
    // rendered exactly such a cycle, through the node union.
    for (const target of PANEL_SPEC_INPUT_SCHEMA_TARGETS) {
      const document = panelSpecInputJsonSchema({ target });
      const definitions = definitionsOf(document);
      const edges = new Map<string, readonly string[]>();

      for (const [key, value] of Object.entries(definitions)) {
        edges.set(key, refPointers(value).map(definitionKeyOf));
      }

      const cyclic: string[] = [];

      for (const start of edges.keys()) {
        const reached = new Set<string>();
        const pending = [...(edges.get(start) ?? [])];

        while (pending.length > 0) {
          const next = pending.pop();
          if (next === undefined || reached.has(next)) {
            continue;
          }
          reached.add(next);
          for (const onward of edges.get(next) ?? []) {
            pending.push(onward);
          }
        }

        if (reached.has(start)) {
          cyclic.push(start);
        }
      }

      expect(cyclic).toEqual([]);
    }
  });

  it('carries the package’s stable identity, and omits it when asked', () => {
    const document = panelSpecInputJsonSchema();

    expect(document['$id']).toBe(PANEL_SPEC_INPUT_JSON_SCHEMA_ID);
    // A URN rather than a URL, deliberately: nothing resolves this identifier,
    // and an `https://` id invites a reader, a validator or a model to fetch
    // something that was never published.
    expect(PANEL_SPEC_INPUT_JSON_SCHEMA_ID.startsWith('urn:')).toBe(true);
    // The dialect keyword, by contrast, is a well-known URI and is the one URL
    // the document legitimately carries.
    expect(String(document['$schema']).startsWith('https://json-schema.org/')).toBe(true);

    // What a consumer accepting a bare schema object wants — a tool's
    // `input_schema`, for instance.
    const bare = panelSpecInputJsonSchema({ id: null, includeDialect: false });

    expect(Object.hasOwn(bare, '$id')).toBe(false);
    expect(Object.hasOwn(bare, '$schema')).toBe(false);
  });

  it('refuses a dialect it has not verified and a blank identity', () => {
    // The type parameter already constrains a TypeScript caller; these are the
    // boundaries the types do not cover — a value that arrived as data or from a
    // JavaScript consumer of the built package — where emitting an unverified
    // dialect silently is the failure worth preventing.
    const unverified = 'draft-04' as PanelSpecInputSchemaTarget;

    expect(() => panelSpecInputJsonSchema({ target: unverified })).toThrow();
    expect(() => panelSpecInputJsonSchema({ id: '   ' })).toThrow();
  });

  it('returns a fresh, mutable document on every call', () => {
    // The `input_schema` path adapts the document, so it must not be a shared
    // frozen instance whose adaptation becomes another consumer's surprise.
    const first = panelSpecInputJsonSchema();
    const second = panelSpecInputJsonSchema();

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it('renders byte-identical text on two calls', () => {
    // A prompt file is immutable once committed, so a rendering that varied
    // between calls or processes would make the committed prompt drift from a
    // regenerated one and defeat any check comparing the two.
    expect(panelSpecInputJsonSchemaText()).toBe(panelSpecInputJsonSchemaText());
    expect(panelSpecInputJsonSchemaText({ target: 'draft-07' })).toBe(
      panelSpecInputJsonSchemaText({ target: 'draft-07' }),
    );
  });

  it('serialises exactly the document it returns, modulo key order', () => {
    expect(parseJsonText(panelSpecInputJsonSchemaText())).toEqual(panelSpecInputJsonSchema());
  });

  it('orders every object’s keys by the documented canonical rule', () => {
    // Re-serialised through an independent implementation of the same rule: keys
    // sorted by the default comparison at every level, array order untouched,
    // two-space indentation, no trailing newline.
    const text = panelSpecInputJsonSchemaText();

    expect(JSON.stringify(sortKeysDeep(parseJsonText(text)), null, 2)).toBe(text);
    expect(text.endsWith('\n')).toBe(false);
  });

  it('reports application-shaped tokens in a synthetic line', () => {
    // The guard is proved able to fail before it is trusted to pass: a safety
    // check that cannot fail is worse than none.
    const findings = applicationShapedTokens(SYNTHETIC_APPLICATION_LINE);
    const report = findings.join(' | ');

    expect(findings.length).toBeGreaterThan(0);
    expect(report).toContain(ROUTE_PREFIX);
    expect(report).toContain('WidgetPanel');
    expect(report).toContain('fooBarBaz');
    expect(report).toContain('widgetLoader.ts');
  });

  it('accepts the vocabulary the schema legitimately renders', () => {
    // The same guard must not report the node types, sources, sorts and metric
    // ids the prompt exists to teach, or it would be unusable rather than
    // strict.
    expect(applicationShapedTokens([...SCHEMA_VOCABULARY].join(' '))).toEqual([]);
  });

  it('names nothing from an application in the prose it contributes to a prompt', () => {
    // Every `description` in the rendered document becomes prompt content, and
    // `scripts/check-no-hardcoding.mjs` reads prompt files as structured text
    // and fails the build on an application identifier or a route path found in
    // one (AAP §0.5.4).
    const document = panelSpecInputJsonSchema();
    const descriptions = keywordStrings(document, 'description');
    const offenders: string[] = [];

    expect(descriptions.length).toBeGreaterThan(0);
    for (const description of descriptions) {
      for (const finding of applicationShapedTokens(description)) {
        offenders.push(finding);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('carries no route path and no source file name anywhere in the emitted text', () => {
    // Stated over the whole text as well as over the prose, because a route and
    // a file name are the specific shapes that guard scans prompt text for. The
    // document's own identity keywords are blanked first: an internal pointer,
    // a dialect URI and a URN are not paths into anyone's project.
    for (const target of PANEL_SPEC_INPUT_SCHEMA_TARGETS) {
      const text = panelSpecInputJsonSchemaText({ target });
      const scannable = withoutSchemaIdentity(text);

      expect(text).not.toContain(ROUTE_PREFIX);
      expect([...scannable.matchAll(PATH_TOKEN)].map((match) => match[0])).toEqual([]);
      expect([...scannable.matchAll(SOURCE_FILE_TOKEN)].map((match) => match[0])).toEqual([]);
    }
  });

  it('adds no examples to the document', () => {
    // An example panel emitted from here would be pre-authored output smuggled
    // into a prompt; a generic example belongs in the prompt file, which is
    // reviewed as prose.
    const text = panelSpecInputJsonSchemaText();

    expect(text).not.toContain('"examples"');
    expect(text).not.toContain('"default"');
  });
});
