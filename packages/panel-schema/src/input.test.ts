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
 * - **Well-formed, not true.** Whether a node type may read the source it names
 *   is the node catalog's statement, applied by `./validate.ts`; whether the
 *   evidence a panel points at exists in the capture is `./semantic.ts`'s. Both
 *   are deliberately absent here.
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

import {
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
import { LAYOUT_NODE_TYPES } from './nodes/layout.js';
import {
  DATA_QUERY_FLAT_FIELD_KEYS,
  DATA_QUERY_MAX_LIMIT,
  DATA_QUERY_SORTS,
  DATA_QUERY_SOURCES,
} from './nodes/query.js';
import { VISUALIZATION_NODE_TYPES } from './nodes/viz.js';
import { PANEL_NODE_TYPES } from './spec.js';

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
 * The smallest authored node of a given type that the schema accepts.
 *
 * One builder rather than sixteen literals, driven by the vocabulary itself, so
 * the completeness loop below covers a node type added to `./nodes/layout.ts` or
 * `./nodes/viz.ts` without an edit here. Two children are given to every
 * container, which satisfies the section and stack minimum of one and the split
 * minimum of two at once.
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

  return { type, source: 'spans' };
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
  it('accepts every data source the query module declares', () => {
    const rejected = DATA_QUERY_SOURCES.filter(
      (source) => !accepts(panelOf([{ type: 'table', source }])),
    );

    expect(rejected).toEqual([]);
  });

  it('rejects a source outside that vocabulary', () => {
    expect(rejectionLocations(panelOf([{ type: 'table', source: 'somewhereElse' }]))).toEqual([
      'layout.0.source: invalid_value',
    ]);
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

  it('rejects a node with no type at all, at the same path', () => {
    expect(rejectionLocations(panelOf([{ source: 'spans' }]))).toEqual([
      'layout.0.type: invalid_union',
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
    // normaliser lifts by, so a field added there is covered here.
    const values: Readonly<Record<string, unknown>> = {
      source: 'spans',
      filter: { minDuration: 1 },
      sort: 'duration_desc',
      limit: 10,
      offset: 2,
    };
    const rejected = DATA_QUERY_FLAT_FIELD_KEYS.filter(
      (field) => !accepts(panelOf([{ type: 'eventLog', [field]: values[field] }])),
    );

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

  it('accepts a node with no query information at all', () => {
    // A node whose source is implied, or whose query the normaliser completes
    // from the catalog: whether a source was ultimately supplied is
    // `./validate.ts`'s question, asked after normalisation.
    expect(parseNodeOrFail({ type: 'timeline' })).toEqual({ type: 'timeline' });
  });

  it('accepts an empty filter and an empty query object', () => {
    // Every filter field narrows, so an empty filter means "the whole source"
    // rather than "nothing", and an empty query object is the same statement one
    // level up.
    expect(parseNodeOrFail({ type: 'table', filter: {} })).toEqual({ type: 'table', filter: {} });
    expect(parseNodeOrFail({ type: 'table', query: {} })).toEqual({ type: 'table', query: {} });
  });

  it('accepts the two node labels and rejects a blank one', () => {
    expect(parseNodeOrFail({ type: 'table', title: 'Slowest operations' })).toEqual({
      type: 'table',
      title: 'Slowest operations',
    });
    expect(rejectionLocations(panelOf([{ type: 'table', title: '' }]))).toEqual([
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
 * 9. Recursion and the layout bounds
 *
 * A panel is a forest, and the recursion is closed once, by the deferred child
 * position of the three containers. The bounds are the internal ones, imported
 * by the module under test, so a layout that passes here is a layout the
 * internal schema accepts.
 * ---------------------------------------------------------------------------
 */

describe('recursion and layout bounds', () => {
  it('accepts a section containing a split containing a stack containing a view', () => {
    // Three containers deep, which is one more level than any single container
    // can prove on its own: the deferred reference has to resolve at each step
    // or the innermost node is never reached.
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
    expect(accepts(panelOf([{ type: 'stack', children: [{ type: 'table' }] }]))).toBe(true);
    expect(accepts(panelOf([{ type: 'section', children: [{ type: 'table' }] }]))).toBe(true);
    expect(rejectionLocations(panelOf([{ type: 'split', children: [{ type: 'table' }] }]))).toEqual(
      ['layout.0.children: too_small'],
    );
  });

  it('accepts a split direction from the declared axes and rejects another', () => {
    expect(
      accepts(
        panelOf([
          {
            type: 'split',
            direction: 'horizontal',
            children: [{ type: 'table' }, { type: 'flame' }],
          },
        ]),
      ),
    ).toBe(true);
    expect(
      rejectionLocations(
        panelOf([
          {
            type: 'split',
            direction: 'diagonal',
            children: [{ type: 'table' }, { type: 'flame' }],
          },
        ]),
      ),
    ).toEqual(['layout.0.direction: invalid_value']);
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
 * The node-union definition and its options, keyed by the node type each option
 * pins.
 *
 * Found by content: the one definition whose branch list resolves to a set of
 * `type` constants matching the node vocabulary. That is also, in itself, the
 * assertion that the union survived rendering as a discriminated set of
 * branches rather than collapsing into a permissive object.
 */
function nodeUnionOf(document: JsonRecord): {
  key: string;
  optionsByType: Map<string, JsonRecord>;
} {
  const definitions = definitionsOf(document);

  for (const [key, value] of Object.entries(definitions)) {
    const entry = asRecord(value, `definition ${key}`);
    const branches = entry['oneOf'] ?? entry['anyOf'];
    if (!Array.isArray(branches) || branches.length !== PANEL_NODE_TYPES.length) {
      continue;
    }

    const optionsByType = new Map<string, JsonRecord>();
    for (const branch of branches) {
      const option = asRecord(branch, `branch of definition ${key}`);
      const properties = option['properties'];
      if (typeof properties !== 'object' || properties === null) {
        break;
      }
      const discriminator = deref(document, asRecord(properties, 'properties')['type'], 'type');
      const constant = discriminator['const'];
      if (typeof constant !== 'string') {
        break;
      }
      optionsByType.set(constant, option);
    }

    if (optionsByType.size === PANEL_NODE_TYPES.length) {
      return { key, optionsByType };
    }
  }

  throw new Error('the emitted schema holds no definition enumerating the panel node types.');
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
    const option = optionsByType.get('metricCards');
    const properties = asRecord(asRecord(option, 'metricCards option')['properties'], 'properties');
    const metrics = deref(document, properties['metrics'], 'metrics');
    const items = deref(document, metrics['items'], 'metrics items');

    expect(metrics['type']).toBe('array');
    expect(metrics['minItems']).toBe(1);
    expect(metrics['maxItems']).toBe(METRIC_IDS.length);
    expect(items['enum']).toEqual([...METRIC_IDS]);
  });

  it('renders both spellings of a node’s query, and the closed source and sort enumerations', () => {
    const document = panelSpecInputJsonSchema();
    const { optionsByType } = nodeUnionOf(document);
    const option = asRecord(optionsByType.get('table'), 'table option');
    const properties = asRecord(option['properties'], 'properties');

    // Both spellings: the five flat fields, and the nested query object holding
    // the same five.
    const missingFlat = DATA_QUERY_FLAT_FIELD_KEYS.filter((field) => !(field in properties));
    expect(missingFlat).toEqual([]);

    const query = deref(document, properties['query'], 'query');
    const queryProperties = asRecord(query['properties'], 'query properties');
    const missingNested = DATA_QUERY_FLAT_FIELD_KEYS.filter((field) => !(field in queryProperties));
    expect(missingNested).toEqual([]);

    expect(deref(document, properties['source'], 'source')['enum']).toEqual([
      ...DATA_QUERY_SOURCES,
    ]);
    expect(deref(document, properties['sort'], 'sort')['enum']).toEqual([...DATA_QUERY_SORTS]);
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

  it('expresses the recursion as a reference that leads back to the node union', () => {
    // A container holds child nodes, so the union is recursive and can only be
    // expressed with a reference. This walks the definition-level reference
    // graph and requires the node union to be reachable from itself, which is
    // both the proof that the cycle is present and the proof that it resolves.
    const document = panelSpecInputJsonSchema();
    const definitions = definitionsOf(document);
    const { key: unionKey } = nodeUnionOf(document);
    const edges = new Map<string, readonly string[]>();

    for (const [key, value] of Object.entries(definitions)) {
      edges.set(key, refPointers(value).map(definitionKeyOf));
    }

    const reached = new Set<string>();
    const pending = [...(edges.get(unionKey) ?? [])];
    while (pending.length > 0) {
      const next = pending.pop();
      if (next === undefined || reached.has(next)) {
        continue;
      }
      reached.add(next);
      pending.push(...(edges.get(next) ?? []));
    }

    expect(reached.has(unionKey)).toBe(true);
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
