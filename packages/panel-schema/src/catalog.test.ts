/**
 * Colocated tests for `./catalog.ts` — the single registry of the node types a
 * generated panel may contain.
 *
 * **Why this suite carries more weight than a typical unit test.** The catalog
 * has three consumers, and each is held to it differently. The syntactic and
 * semantic validators (`./validate.ts`, `./semantic.ts`) read it and are
 * covered by their own suites. The renderer's component registry
 * (`packages/panel-renderer/src/host/registry.ts`) is keyed by the catalog's
 * node-type vocabulary, and its record's `satisfies` clause makes a missing or
 * an extra entry a compile error; its colocated `registry.test.ts` is what AAP
 * §0.8.3 means by "every catalog type must have a renderer component" — it
 * pairs every catalogued node type with a component in both directions, finds
 * no component for a type outside the catalog, and renders every catalogued
 * component against a recorded panel-data response. The generate-panel prompt
 * (`apps/local-service/prompts/generate-panel/vNNN.md`), however, is a
 * versioned text file that no compiler reads.
 *
 * The invariant is therefore enforced from two sides. The renderer's suite
 * holds the registry to the catalog, so it is only as sound as the catalog is,
 * and the schema side lives here: **the catalog's key set equals the node-type
 * union exactly**, alongside the structure, provenance and prompt safety of
 * every entry. `./validate.test.ts` completes that side by proving the
 * validator accepts every catalogued node type with its declared sources and
 * rejects an unknown one before rendering. The key-set equality is what keeps
 * the validator, the prompt and the renderer's registry in step, and a drift in
 * it is silent in every direction — a node type with no entry renders as a
 * blank region, an entry with no node type puts a node in the prompt that
 * nothing can produce.
 *
 * ## What the compiler already guarantees, and is therefore not re-asserted
 *
 * `PANEL_NODE_CATALOG` is annotated `Readonly<Record<PanelNodeType, …>>` *and*
 * carries a `satisfies` clause on the object literal, so a missing entry and an
 * invented key are both compile errors, and every `reads` group in that module
 * is annotated with `keyof TelemetryEvent` or with a node type's own option
 * keys. The runtime assertions below exist for the cases the build cannot see:
 * a stored panel read back in a process that was never type-checked against
 * this build, an attribute key spelled by hand rather than imported, and the
 * rendered prompt text, which is data rather than code.
 *
 * ## The four questions this suite answers
 *
 * 1. **Completeness** — does the catalog cover exactly the vocabulary, with
 *    every entry naming itself and every accessor total over it?
 * 2. **Structure** — is each entry internally coherent (a container that takes
 *    children and no query, a leaf that takes a location and no query, a
 *    query-backed view whose sources are real and whose default is one of
 *    them)?
 * 3. **Provenance** — does every `reads` field trace back to a declaration in
 *    `@debuggen/telemetry`, rather than to a string typed here or there? This
 *    is the reason AAP §0.6.2 puts `reads` in the schema package and has the
 *    renderer import it, and it is also where the privacy bound of AAP §0.5.2
 *    is checked: a node claiming to read a request body, a full prop value or a
 *    database row would be a specification error, because nothing in the
 *    product ever captures one.
 * 4. **Prompt safety** — is the rendered catalog deterministic, complete,
 *    ordered by the declared vocabulary, and free of anything application-
 *    shaped? `describeCatalogForPrompt()`'s output *becomes* prompt text, and a
 *    prompt that names a route or a component is a hardcoded answer wearing a
 *    pipeline's clothes (AAP §0.5.4).
 *
 * ## Two deliberate decisions, so a later reader does not have to guess
 *
 * **Aggregate reads are expressed against event fields, with no exemption
 * set.** Several nodes read a prepared aggregate (`renders`, `requests`,
 * `queries`, `stateTransitions`, `componentTree`, `graph`, `metrics`) whose
 * result types are TypeScript interfaces with no runtime key list, so an
 * aggregate's property names cannot be checked against anything. Rather than
 * loosening the provenance check to accommodate them, this suite requires what
 * `./catalog.ts` already documents: a node that reads an aggregated source
 * declares the *event* fields the aggregate is computed from, never the
 * aggregate's own property names. The legitimate set is therefore exactly the
 * telemetry event's own field names plus the attribute keys the telemetry
 * package declares, {@link EXEMPT_READS} is empty, and the suite asserts it is
 * empty — so adding an exemption is a visible edit with a reason attached
 * rather than a quiet widening. Metric ids are excluded from that set for the
 * same reason: a metric id is a value of the metric-tile node's `metrics`
 * *option*, not a telemetry field. The catalog's reliance on the metric and
 * participant vocabularies is asserted instead through the text it renders from
 * them, which is what proves those lists are imported rather than restated.
 *
 * **The vocabulary is restated literally, once.** {@link
 * CANONICAL_PANEL_NODE_TYPES} writes out the sixteen names AAP §0.2.3 fixes.
 * Deriving that list from the tuple under test would compare the vocabulary
 * with itself and pass through exactly the drift the suite exists to catch.
 * Everything else is imported from the module that owns it.
 *
 * Node environment, no fixture file, no network, no `node:` builtin: this
 * package's compiler project sets no ambient `types`, and every input below is
 * either imported from a sibling module or built as a literal in this file.
 */

import { describe, expect, it } from 'vitest';

import {
  COMPONENT_TREE_ATTRIBUTE_KEYS,
  DB_QUERY_ATTRIBUTE_KEYS,
  DEPENDENCY_NODE_KINDS,
  FETCH_ATTRIBUTE_KEYS,
  METRIC_IDS,
  QUERY_KINDS,
  RENDER_ATTRIBUTE_KEYS,
  RENDER_KINDS,
  REQUEST_KINDS,
  SERVICE_ASSIGNED_ATTRIBUTE_KEYS,
  STATE_ATTRIBUTE_KEYS,
  STATE_KINDS,
  TELEMETRY_KINDS,
  WATERFALL_KINDS,
  attributeKeysFor,
  telemetryEventSchema,
} from '@debuggen/telemetry';

import {
  DEFAULT_CATALOG_PROMPT_BULLET,
  PANEL_NODE_CATALOG,
  PANEL_NODE_CATALOG_ENTRIES,
  PANEL_NODE_CATALOG_KINDS,
  catalogEntryFor,
  describeCatalogForPrompt,
  isKnownPanelNodeType,
  isSourceAllowedForNode,
  type PanelNodeCatalogEntry,
} from './catalog.js';
import { LAYOUT_NODE_TYPES } from './nodes/layout.js';
import { DATA_QUERY_SOURCES } from './nodes/query.js';
import { QUERY_BACKED_NODE_TYPES, VISUALIZATION_NODE_TYPES } from './nodes/viz.js';
import { PANEL_NODE_TYPES, type PanelNodeType } from './spec.js';

/*
 * ---------------------------------------------------------------------------
 * The one restatement, and the widened views
 * ---------------------------------------------------------------------------
 */

/**
 * The sixteen node types of AAP §0.2.3, in the order that section lists them:
 * the three containers, the twelve query-backed visualizations, then the
 * source-link leaf.
 *
 * Written out rather than imported: this array *is* the assertion. A suite that
 * derived the expected names from {@link PANEL_NODE_TYPES} would compare the
 * vocabulary with itself and keep passing through a renamed, added or removed
 * node type — the drift that silently desynchronises the validator, the prompt
 * and the renderer's registry.
 */
const CANONICAL_PANEL_NODE_TYPES = [
  'section',
  'split',
  'stack',
  'timeline',
  'waterfall',
  'eventLog',
  'metricCards',
  'flame',
  'table',
  'renderTable',
  'componentTree',
  'requestTable',
  'queryTable',
  'stateTransitions',
  'dependencyGraph',
  'sourceLink',
] as const;

/** The two entry kinds, restated for the same reason as the node types. */
const CANONICAL_CATALOG_KINDS = ['layout', 'visualization'] as const;

/**
 * The counts AAP §0.2.3 fixes, named so that an accidental addition or removal
 * fails against a number a reader can check against the plan rather than
 * against whatever the catalog happens to hold.
 */
const EXPECTED_TOTAL_ENTRIES = 16;

/** Three containers: `section`, `split`, `stack`. */
const EXPECTED_LAYOUT_ENTRIES = 3;

/**
 * Thirteen visualizations: the twelve query-backed views plus the source-link
 * leaf, which AAP §0.2.3 counts among them ("thirteen visualization
 * components") even though it reads no captured data.
 */
const EXPECTED_VISUALIZATION_ENTRIES = 13;

/** Widened view of the node vocabulary, for membership tests against strings. */
const NODE_TYPE_NAMES: readonly string[] = PANEL_NODE_TYPES;

/** Widened view of the container vocabulary its owning module declares. */
const LAYOUT_TYPE_NAMES: readonly string[] = LAYOUT_NODE_TYPES;

/** Widened view of the visualization vocabulary its owning module declares. */
const VISUALIZATION_TYPE_NAMES: readonly string[] = VISUALIZATION_NODE_TYPES;

/** Widened view of the twelve query-backed types its owning module declares. */
const QUERY_BACKED_TYPE_NAMES: readonly string[] = QUERY_BACKED_NODE_TYPES;

/** Widened view of the closed data-source vocabulary. */
const DATA_SOURCE_NAMES: readonly string[] = DATA_QUERY_SOURCES;

/**
 * The catalog's keys as the runtime sees them, which is the side of the
 * completeness invariant the compiler cannot check for a stored panel.
 */
const CATALOG_KEYS: readonly string[] = Object.keys(PANEL_NODE_CATALOG);

/*
 * ---------------------------------------------------------------------------
 * Provenance vocabulary
 * ---------------------------------------------------------------------------
 */

/**
 * The telemetry event's own field names, read from the schema that defines
 * them.
 *
 * Derived from `.shape` rather than typed out, exactly as
 * `packages/telemetry/src/schema/event.test.ts` derives the same set: a field
 * renamed there must fail here rather than leave a `reads` entry pointing at a
 * field no event carries. The persisted schema is used rather than the ingress
 * one because the panel data sources serve stored events, so the attribution
 * fields are legitimately readable.
 */
const EVENT_FIELD_NAMES: readonly string[] = Object.keys(telemetryEventSchema.shape);

/**
 * Every attribute key the telemetry package declares, for every kind, plus the
 * cross-kind lineage, correlation and service-assigned keys.
 *
 * Built through `attributeKeysFor(kind, { includeCommon: true })` over the kind
 * vocabulary — the accessor that module documents for a consumer wanting both
 * sets — so this file names no kind and no key of its own. `packages/telemetry`
 * describes its per-kind registry as "the object `packages/panel-schema/src/
 * catalog.ts` consults when it declares each node's `reads` list", which makes
 * it the authority this check measures the catalog against.
 */
const DECLARED_ATTRIBUTE_KEYS: readonly string[] = TELEMETRY_KINDS.flatMap((kind) =>
  attributeKeysFor(kind, { includeCommon: true }),
);

/**
 * Field names a catalog entry may legitimately declare in `reads`: a telemetry
 * event field, or an attribute key the telemetry package declares.
 *
 * Deliberately **not** widened with metric ids or aggregate property names —
 * see this file's documentation for the reasoning and for why {@link
 * EXEMPT_READS} is empty.
 */
const LEGITIMATE_READS: ReadonlySet<string> = new Set([
  ...EVENT_FIELD_NAMES,
  ...DECLARED_ATTRIBUTE_KEYS,
]);

/**
 * Reads the provenance check tolerates without a telemetry declaration behind
 * them.
 *
 * Empty, and asserted to be empty. It exists so that a future entry that
 * genuinely cannot express itself against event fields has one obvious place to
 * be recorded, with the reason beside it, instead of the check being relaxed.
 */
const EXEMPT_READS: readonly string[] = [];

/**
 * Substrings that must never appear in a `reads` field name, because the data
 * they would name is structurally never captured (AAP §0.5.2): request and
 * response bodies, database row contents, and credential-shaped values.
 *
 * Note what is *not* on this list and why. `value` is absent: the state
 * vocabulary legitimately reads `previousValue` and `nextValue`, which are
 * bounded, truncated *summaries* rather than captured values — the suite pins
 * that exception mechanically below rather than leaving it to a comment. And
 * `row` is absent while `rows` is present: a row *count* is a number the
 * product does capture, whereas row contents are not.
 */
const FORBIDDEN_READ_SUBSTRINGS = [
  'body',
  'rows',
  'payload',
  'password',
  'token',
  'cookie',
  'authorization',
] as const;

/*
 * ---------------------------------------------------------------------------
 * Helpers
 *
 * Each returns a list of offenders rather than a boolean, so a failure names
 * the entry and the field instead of reporting that something, somewhere, is
 * false.
 * ---------------------------------------------------------------------------
 */

/**
 * Every catalog entry, as the array the per-entry checks iterate.
 *
 * Taken from the record's own values rather than from {@link
 * PANEL_NODE_CATALOG_ENTRIES}, and the difference matters precisely when this
 * suite is doing its job. The ordered list is built by mapping the node-type
 * vocabulary through the record, so a node type with no entry leaves an
 * `undefined` *hole* in it — and a hole dereferenced while this file is being
 * loaded would fail the whole suite with a property-access error before a
 * single assertion ran, hiding the missing type instead of naming it. The
 * record's values are never holed, so every per-entry check below runs on a
 * broken catalog and reports what it finds; the ordered list's own integrity is
 * asserted separately, and defensively, above.
 */
const ENTRIES: readonly PanelNodeCatalogEntry[] = Object.values(PANEL_NODE_CATALOG);

/** The entries of one kind. */
function entriesOfKind(kind: PanelNodeCatalogEntry['kind']): readonly PanelNodeCatalogEntry[] {
  return ENTRIES.filter((entry) => entry.kind === kind);
}

/** The entry for a node type, by lookup rather than by search. */
function entryFor(type: PanelNodeType): PanelNodeCatalogEntry {
  return PANEL_NODE_CATALOG[type];
}

/** The members of `expected` that `actual` does not contain, in order. */
function missingFrom(actual: readonly string[], expected: readonly string[]): readonly string[] {
  return expected.filter((name) => !actual.includes(name));
}

/** The members of `values` that occur more than once, each reported once. */
function duplicatesIn(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      repeated.add(value);
    }
    seen.add(value);
  }
  return [...repeated];
}

/*
 * ---------------------------------------------------------------------------
 * 1. Completeness — the invariant this file exists for
 * ---------------------------------------------------------------------------
 */

describe('PANEL_NODE_CATALOG completeness', () => {
  it('declares the sixteen node types of AAP §0.2.3, in that order', () => {
    expect([...PANEL_NODE_TYPES]).toEqual([...CANONICAL_PANEL_NODE_TYPES]);
  });

  it('holds no key the node-type union does not declare', () => {
    // The direction the `satisfies` clause covers at compile time, asserted
    // again for a build that never saw this source: an extra key would put a
    // node in the prompt and in the renderer's registry that nothing produces.
    expect(CATALOG_KEYS.filter((key) => !NODE_TYPE_NAMES.includes(key))).toEqual([]);
  });

  it('holds an entry for every member of the node-type union', () => {
    // The opposite direction, which is the one that renders a blank region: a
    // node type the validator accepts and the catalog cannot describe.
    expect(missingFrom(CATALOG_KEYS, NODE_TYPE_NAMES)).toEqual([]);
  });

  it('has a key set equal to the union as a set', () => {
    expect([...CATALOG_KEYS].sort()).toEqual([...NODE_TYPE_NAMES].sort());
  });

  it('holds an entry for each of the sixteen names written out in this file', () => {
    expect(missingFrom(CATALOG_KEYS, CANONICAL_PANEL_NODE_TYPES)).toEqual([]);
  });

  it('holds sixteen entries in total', () => {
    expect(ENTRIES).toHaveLength(EXPECTED_TOTAL_ENTRIES);
    expect(CATALOG_KEYS).toHaveLength(EXPECTED_TOTAL_ENTRIES);
  });

  it('holds three container entries', () => {
    expect(entriesOfKind('layout')).toHaveLength(EXPECTED_LAYOUT_ENTRIES);
  });

  it('holds thirteen visualization entries, the source-link leaf included', () => {
    expect(entriesOfKind('visualization')).toHaveLength(EXPECTED_VISUALIZATION_ENTRIES);
  });

  it('gives every entry the type it is stored under', () => {
    const mismatched = Object.entries(PANEL_NODE_CATALOG)
      .filter(([key, entry]) => entry.type !== key)
      .map(([key, entry]) => `${key} names itself ${entry.type}`);

    expect(mismatched).toEqual([]);
  });

  it('classes every entry by the module that owns its type', () => {
    // The kind is not free: `./nodes/layout.ts` owns the containers and
    // `./nodes/viz.ts` owns the leaves, so an entry's kind is a fact about
    // which module declared its type rather than a field an author chooses.
    const misclassed: string[] = [];
    for (const entry of ENTRIES) {
      const ownedByLayout = LAYOUT_TYPE_NAMES.includes(entry.type);
      const ownedByViz = VISUALIZATION_TYPE_NAMES.includes(entry.type);

      if (ownedByLayout === ownedByViz) {
        misclassed.push(`${entry.type} is owned by neither module, or by both`);
        continue;
      }

      const expected = ownedByLayout ? 'layout' : 'visualization';
      if (entry.kind !== expected) {
        misclassed.push(`${entry.type} is ${entry.kind}, expected ${expected}`);
      }
    }

    expect(misclassed).toEqual([]);
  });

  it('uses only the two declared entry kinds', () => {
    expect([...PANEL_NODE_CATALOG_KINDS]).toEqual([...CANONICAL_CATALOG_KINDS]);

    const kindNames: readonly string[] = PANEL_NODE_CATALOG_KINDS;
    expect(ENTRIES.filter((entry) => !kindNames.includes(entry.kind)).map((e) => e.type)).toEqual(
      [],
    );
  });

  it('lists the entries in vocabulary order, sharing the record’s own objects', () => {
    // The ordered list is what the prompt renderer iterates, and the package
    // exports it for any consumer that walks the catalog in order, so its order
    // must come from the declared vocabulary rather than from property
    // enumeration, and its members must be the very entries the record holds
    // rather than copies a consumer could compare unequal.
    //
    // Widened before it is read: the list is built by mapping the vocabulary
    // through the record, so a node type with no entry leaves a hole here, and
    // this check must name that hole rather than throw on it.
    const listed: readonly (PanelNodeCatalogEntry | undefined)[] = PANEL_NODE_CATALOG_ENTRIES;

    expect(
      listed.map(
        (entry, index) => entry?.type ?? `<no entry for ${PANEL_NODE_TYPES[index] ?? ''}>`,
      ),
    ).toEqual([...PANEL_NODE_TYPES]);

    const copied = PANEL_NODE_TYPES.filter((type, index) => listed[index] !== entryFor(type));
    expect(copied).toEqual([]);
  });

  it('is frozen, as is every array inside every entry', () => {
    // `Object.freeze` on the record is shallow, so the entry objects themselves
    // stay mutable at runtime; their read-only-ness is carried by the type,
    // which is why only the record, the ordered list and the arrays — the
    // values a consumer could plausibly mutate in place while iterating — are
    // asserted here.
    expect(Object.isFrozen(PANEL_NODE_CATALOG)).toBe(true);
    expect(Object.isFrozen(PANEL_NODE_CATALOG_ENTRIES)).toBe(true);

    const thawed: string[] = [];
    for (const entry of ENTRIES) {
      if (!Object.isFrozen(entry.sources)) {
        thawed.push(`${entry.type}.sources`);
      }
      if (!Object.isFrozen(entry.telemetryKinds)) {
        thawed.push(`${entry.type}.telemetryKinds`);
      }
      if (!Object.isFrozen(entry.reads)) {
        thawed.push(`${entry.type}.reads`);
      }
      if (entry.options !== undefined && !Object.isFrozen(entry.options)) {
        thawed.push(`${entry.type}.options`);
      }
    }

    expect(thawed).toEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * 2. Accessors — total over the vocabulary, closed to everything else
 * ---------------------------------------------------------------------------
 */

describe('catalog accessors', () => {
  it('returns the shared entry for every node type', () => {
    const broken: string[] = [];
    for (const type of PANEL_NODE_TYPES) {
      // Widened on purpose: the accessor's signature promises an entry for
      // every node type, and this is the check that the promise holds at
      // runtime for a name that arrived from another process.
      const entry: PanelNodeCatalogEntry | undefined = catalogEntryFor(type);
      if (entry === undefined) {
        broken.push(`${type}: no entry`);
        continue;
      }
      if (entry !== PANEL_NODE_CATALOG[type]) {
        broken.push(`${type}: copied rather than shared`);
      }
      if (entry.type !== type) {
        broken.push(`${type}: entry names ${entry.type}`);
      }
    }

    expect(broken).toEqual([]);
  });

  it('recognises every node type', () => {
    const unrecognised = PANEL_NODE_TYPES.filter((type) => !isKnownPanelNodeType(type));
    expect(unrecognised).toEqual([]);
  });

  it('rejects names that look like node types but are not', () => {
    // Plausible-but-wrong shapes: an invented view, the right name in the wrong
    // case, a singular where the vocabulary is plural, the empty string, and
    // the two inherited property names a record lookup would otherwise answer
    // for. `__proto__` is here deliberately: the catalog is a record, and a
    // prototype-pollution-shaped key must not resolve to an entry.
    const rejected = [
      'chart',
      'Timeline',
      'metricCard',
      'sourcelink',
      'source-link',
      '',
      ' timeline',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
    ];

    const accepted = rejected.filter((value) => isKnownPanelNodeType(value));
    expect(accepted).toEqual([]);
  });

  it('rejects values that are not strings at all', () => {
    const accepted = [undefined, null, 0, 1, true, {}, [], Symbol('timeline')].filter((value) =>
      isKnownPanelNodeType(value),
    );

    expect(accepted).toEqual([]);
  });

  it('carries no inherited key as an own entry', () => {
    expect(Object.hasOwn(PANEL_NODE_CATALOG, '__proto__')).toBe(false);
    expect(Object.hasOwn(PANEL_NODE_CATALOG, 'constructor')).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * 3. Entry structure — each entry coherent with what its node type is
 * ---------------------------------------------------------------------------
 */

describe('container entries', () => {
  it('read no source, require no query and take children', () => {
    const wrong: string[] = [];
    for (const entry of entriesOfKind('layout')) {
      if (entry.sources.length !== 0) {
        wrong.push(`${entry.type}.sources is not empty`);
      }
      if (entry.requiresQuery) {
        wrong.push(`${entry.type}.requiresQuery is true`);
      }
      if (!entry.supportsChildren) {
        wrong.push(`${entry.type}.supportsChildren is false`);
      }
      if (entry.telemetryKinds.length !== 0) {
        wrong.push(`${entry.type}.telemetryKinds is not empty`);
      }
      if (entry.reads.length !== 0) {
        wrong.push(`${entry.type}.reads is not empty`);
      }
      if (entry.defaultSource !== undefined) {
        wrong.push(`${entry.type}.defaultSource is set`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it('covers exactly the three container types', () => {
    expect(entriesOfKind('layout').map((entry) => entry.type)).toEqual([...LAYOUT_NODE_TYPES]);
  });
});

describe('the source-link leaf', () => {
  // Asserted apart from the containers, and that separation is the point: this
  // is a *visualization* that reads no captured data, so conflating "takes no
  // query" with "takes children" is exactly the mistake that would put a
  // container's behaviour on a leaf.
  const sourceLink = entryFor('sourceLink');

  it('is a visualization rather than a container', () => {
    expect(sourceLink.kind).toBe('visualization');
    expect(sourceLink.supportsChildren).toBe(false);
  });

  it('reads no source and requires no query', () => {
    expect([...sourceLink.sources]).toEqual([]);
    expect(sourceLink.requiresQuery).toBe(false);
    expect(sourceLink.defaultSource).toBeUndefined();
  });

  it('reads no telemetry: its content is a location resolved before the panel', () => {
    expect([...sourceLink.telemetryKinds]).toEqual([]);
    expect([...sourceLink.reads]).toEqual([]);
  });

  it('is the one visualization type outside the query-backed vocabulary', () => {
    expect(QUERY_BACKED_TYPE_NAMES).not.toContain(sourceLink.type);
    expect(VISUALIZATION_TYPE_NAMES).toContain(sourceLink.type);
  });
});

describe('query-backed visualization entries', () => {
  /** The twelve entries the owning module declares as query-backed. */
  const queryBacked = ENTRIES.filter((entry) => QUERY_BACKED_TYPE_NAMES.includes(entry.type));

  it('are exactly the twelve types the visualization module declares', () => {
    expect(queryBacked.map((entry) => entry.type)).toEqual([...QUERY_BACKED_NODE_TYPES]);
  });

  it('agree with the owning module about which types require a query', () => {
    // `requiresQuery` is the authoring-form statement of the rule the
    // normalized node schemas already enforce, so the two vocabularies must
    // partition the catalog identically.
    const disagreeing = ENTRIES.filter(
      (entry) => entry.requiresQuery !== QUERY_BACKED_TYPE_NAMES.includes(entry.type),
    ).map((entry) => `${entry.type}.requiresQuery is ${String(entry.requiresQuery)}`);

    expect(disagreeing).toEqual([]);
  });

  it('declare at least one source, take no children and read something', () => {
    const wrong: string[] = [];
    for (const entry of queryBacked) {
      if (entry.sources.length === 0) {
        wrong.push(`${entry.type}.sources is empty`);
      }
      if (!entry.requiresQuery) {
        wrong.push(`${entry.type}.requiresQuery is false`);
      }
      if (entry.supportsChildren) {
        wrong.push(`${entry.type}.supportsChildren is true`);
      }
      if (entry.reads.length === 0) {
        wrong.push(`${entry.type}.reads is empty`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it('name only sources the data-query vocabulary declares', () => {
    // The ten source names are the discriminants of the panel-data result
    // union, so a source outside them is not a cosmetic error: the service's
    // resolver has no branch for it.
    const strays: string[] = [];
    for (const entry of ENTRIES) {
      for (const source of entry.sources) {
        if (!DATA_SOURCE_NAMES.includes(source)) {
          strays.push(`${entry.type}.sources: ${source}`);
        }
      }
    }

    expect(strays).toEqual([]);
  });

  it('name each source at most once', () => {
    const repeated = ENTRIES.flatMap((entry) =>
      duplicatesIn(entry.sources).map((source) => `${entry.type}.sources: ${source}`),
    );

    expect(repeated).toEqual([]);
  });

  it('gives the metric-tile node the implicit metrics source as its default', () => {
    // Load-bearing rather than cosmetic: `./normalize.ts` reads this field for
    // every node type to supply the implicit `query: { source: "metrics" }` of
    // AAP §0.2.3, instead of branching on this one node type.
    expect(PANEL_NODE_CATALOG.metricCards.defaultSource).toBe('metrics');
    expect(PANEL_NODE_CATALOG.metricCards.sources).toContain('metrics');
  });

  it('declares a default source only from that entry’s own sources', () => {
    const invalid: string[] = [];
    for (const entry of ENTRIES) {
      const { defaultSource } = entry;
      if (defaultSource !== undefined && !entry.sources.includes(defaultSource)) {
        invalid.push(`${entry.type}.defaultSource: ${defaultSource}`);
      }
    }

    expect(invalid).toEqual([]);
  });
});

describe('entry prose and vocabularies', () => {
  it('gives every entry a non-empty label and description', () => {
    const missing: string[] = [];
    for (const entry of ENTRIES) {
      if (entry.label.trim().length === 0) {
        missing.push(`${entry.type}.label`);
      }
      if (entry.description.trim().length === 0) {
        missing.push(`${entry.type}.description`);
      }
    }

    expect(missing).toEqual([]);
  });

  it('writes every label in sentence case, distinct from the node type', () => {
    // The label is prose for a heading, not an identifier: it must not double
    // as the node type a panel author has to reproduce exactly, and it must not
    // read as a component name.
    const wrong: string[] = [];
    for (const entry of ENTRIES) {
      if (!/^[A-Z]/.test(entry.label)) {
        wrong.push(`${entry.type}.label does not start with a capital: ${entry.label}`);
      }
      if (entry.label !== entry.label.trim()) {
        wrong.push(`${entry.type}.label is padded: ${entry.label}`);
      }
      if (entry.label === entry.type) {
        wrong.push(`${entry.type}.label repeats the node type`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it('ends every description as a sentence, since it is rendered into prose', () => {
    const unterminated = ENTRIES.filter((entry) => !entry.description.trimEnd().endsWith('.')).map(
      (entry) => `${entry.type}.description`,
    );

    expect(unterminated).toEqual([]);
  });

  it('names only real telemetry kinds, each at most once', () => {
    const kindNames: readonly string[] = TELEMETRY_KINDS;
    const wrong: string[] = [];
    for (const entry of ENTRIES) {
      for (const kind of entry.telemetryKinds) {
        if (!kindNames.includes(kind)) {
          wrong.push(`${entry.type}.telemetryKinds: ${kind}`);
        }
      }
      for (const kind of duplicatesIn(entry.telemetryKinds)) {
        wrong.push(`${entry.type}.telemetryKinds repeats ${kind}`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it('declares each option at most once', () => {
    const repeated = ENTRIES.flatMap((entry) =>
      duplicatesIn(entry.options ?? []).map((option) => `${entry.type}.options: ${option}`),
    );

    expect(repeated).toEqual([]);
  });
});

describe('isSourceAllowedForNode', () => {
  it('answers exactly what each entry declares, for every node and source pair', () => {
    // Exhaustive over the sixteen types and the ten sources rather than
    // sampled: the predicate is the per-node half of query validation, so a
    // pair it answers wrongly either rejects a legitimate panel or lets a node
    // reach a component that cannot render the result it resolves to.
    const wrong: string[] = [];
    for (const type of PANEL_NODE_TYPES) {
      const entry = entryFor(type);
      for (const source of DATA_QUERY_SOURCES) {
        const allowed = isSourceAllowedForNode(type, source);
        const declared = entry.sources.includes(source);
        if (allowed !== declared) {
          wrong.push(
            `${type} + ${source}: answered ${String(allowed)}, declared ${String(declared)}`,
          );
        }
      }
    }

    expect(wrong).toEqual([]);
  });

  it('allows a statement view its own source and refuses an unrelated one', () => {
    expect(isSourceAllowedForNode('queryTable', 'queries')).toBe(true);
    expect(isSourceAllowedForNode('queryTable', 'renders')).toBe(false);
    expect(isSourceAllowedForNode('renderTable', 'renders')).toBe(true);
    expect(isSourceAllowedForNode('renderTable', 'queries')).toBe(false);
  });

  it('refuses every source for a container and for the source-link leaf', () => {
    // Not a special case but the correct answer: a node that reads nothing must
    // carry no query, so no source is allowed for it.
    const readNothing: readonly PanelNodeType[] = [...LAYOUT_NODE_TYPES, 'sourceLink'];

    const allowed: string[] = [];
    for (const type of readNothing) {
      for (const source of DATA_QUERY_SOURCES) {
        if (isSourceAllowedForNode(type, source)) {
          allowed.push(`${type} + ${source}`);
        }
      }
    }

    expect(allowed).toEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * 4. Provenance — every `reads` field traces back to @debuggen/telemetry
 *
 * This is the section that stops `reads` from drifting into hand-typed
 * strings, which is the whole reason AAP §0.6.2 puts `reads` in the schema
 * package and has the renderer import it from here. A misspelled field does
 * not throw anywhere: it renders an empty column.
 * ---------------------------------------------------------------------------
 */

describe('reads provenance', () => {
  it('derives the legitimate vocabulary from the owning package', () => {
    // A guard on the guard: if either source of truth came back empty — a
    // renamed export, a schema whose shape is no longer reachable — every
    // membership check below would pass vacuously.
    expect(EVENT_FIELD_NAMES.length).toBeGreaterThan(0);
    expect(DECLARED_ATTRIBUTE_KEYS.length).toBeGreaterThan(0);
    expect(LEGITIMATE_READS.size).toBeGreaterThanOrEqual(EVENT_FIELD_NAMES.length);

    // Spot-checks that the two halves really are the halves they claim to be,
    // each named through the owning module rather than as a literal.
    const identityField = EVENT_FIELD_NAMES.find((field) => field === 'traceId');
    expect(identityField).toBe('traceId');
    for (const key of RENDER_ATTRIBUTE_KEYS) {
      expect(DECLARED_ATTRIBUTE_KEYS).toContain(key);
    }
  });

  it('tolerates no exemption', () => {
    // Empty by decision (see this file's documentation): a node reading an
    // aggregated source declares the event fields the aggregate is computed
    // from, so nothing needs an exemption. Adding one must be a visible edit.
    expect(EXEMPT_READS).toEqual([]);
  });

  it('names only telemetry event fields and declared attribute keys', () => {
    const strays: string[] = [];
    for (const entry of ENTRIES) {
      for (const field of entry.reads) {
        if (!LEGITIMATE_READS.has(field) && !EXEMPT_READS.includes(field)) {
          strays.push(`${entry.type}.reads: ${field}`);
        }
      }
    }

    expect(strays).toEqual([]);
  });

  it('names each field at most once per entry', () => {
    const repeated = ENTRIES.flatMap((entry) =>
      duplicatesIn(entry.reads).map((field) => `${entry.type}.reads: ${field}`),
    );

    expect(repeated).toEqual([]);
  });

  it('names no metric id, because a metric id is an option value not a field', () => {
    // The enforceable half of this file's provenance decision. A metric is a
    // value computed from the capture and addressed by id; the id is a member
    // of the metric-tile node's `metrics` *option*, never a telemetry field, so
    // an entry reading one would be declaring a dependency on a computation
    // rather than on captured data — and would pass a provenance check that had
    // been widened with the metric vocabulary to accommodate it.
    const metricIds: readonly string[] = METRIC_IDS;
    const offenders: string[] = [];
    for (const entry of ENTRIES) {
      for (const field of entry.reads) {
        if (metricIds.includes(field)) {
          offenders.push(`${entry.type}.reads: ${field}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('reads every attribute key of every kind it declares', () => {
    // The bridge between the two fields: an entry's `telemetryKinds` is what a
    // filter may narrow to, so a key those kinds carry and the entry does not
    // read is a column the component was never given.
    const missing: string[] = [];
    for (const entry of ENTRIES) {
      for (const kind of entry.telemetryKinds) {
        for (const key of attributeKeysFor(kind)) {
          if (!entry.reads.includes(key)) {
            missing.push(`${entry.type}.reads is missing ${key} (declared by kind ${kind})`);
          }
        }
      }
    }

    expect(missing).toEqual([]);
  });
});

describe('the reads mappings AAP §0.6.2 states', () => {
  // Each check pairs a literal restatement of the plan's wording with the
  // derived key group, so the table in the specification and the code cannot
  // diverge in either direction: the literals catch a key the plan names and
  // the catalog dropped, the groups catch a key the telemetry package added and
  // the catalog never picked up.

  it('gives the render table the render attribute keys', () => {
    const { reads } = entryFor('renderTable');

    // The four the plan names: component, render count, trigger, changed props.
    expect(reads).toContain('component');
    expect(reads).toContain('renderCount');
    expect(reads).toContain('trigger');
    expect(reads).toContain('changedProps');

    expect(missingFrom(reads, RENDER_ATTRIBUTE_KEYS)).toEqual([]);
    expect([...entryFor('renderTable').telemetryKinds]).toEqual([...RENDER_KINDS]);
  });

  it('gives the request table the fetch attribute keys and the grouping key', () => {
    const { reads } = entryFor('requestTable');

    // The four the plan names: method, url, status, initiator.
    expect(reads).toContain('http.method');
    expect(reads).toContain('url');
    expect(reads).toContain('http.status_code');
    expect(reads).toContain('initiator');

    expect(missingFrom(reads, FETCH_ATTRIBUTE_KEYS)).toEqual([]);

    // The plan's "duplicate count" is an aggregate's output rather than a
    // captured field, so what the entry must declare is the *event* field the
    // count is computed from — the service-assigned grouping key of AAP §0.5.2,
    // named here through the group that owns it.
    expect(missingFrom(reads, SERVICE_ASSIGNED_ATTRIBUTE_KEYS)).toEqual([]);
    expect([...entryFor('requestTable').telemetryKinds]).toEqual([...REQUEST_KINDS]);
  });

  it('gives the query table the statement keys and no row contents', () => {
    const { reads } = entryFor('queryTable');

    // The three the plan names, none of which is a value or a returned row.
    expect(reads).toContain('db.system');
    expect(reads).toContain('db.statement');
    expect(reads).toContain('db.rowCount');

    expect(missingFrom(reads, DB_QUERY_ATTRIBUTE_KEYS)).toEqual([]);
    expect([...entryFor('queryTable').telemetryKinds]).toEqual([...QUERY_KINDS]);

    // Row contents are structurally never captured, so a statement view
    // claiming to read one would be a specification error rather than a bug.
    const rowShaped = reads.filter((field) => {
      const lowered = field.toLowerCase();
      return (
        lowered.includes('rows') ||
        lowered.includes('value') ||
        lowered.includes('result') ||
        lowered.includes('binding')
      );
    });

    expect(rowShaped).toEqual([]);
  });

  it('gives the timeline the cross-tier positioning fields', () => {
    // The six the plan names, which are what places a record in a lane on a
    // shared axis and makes its row clickable.
    const { reads } = entryFor('timeline');

    expect(
      missingFrom(reads, ['startTime', 'duration', 'tier', 'kind', 'parentSpanId', 'source']),
    ).toEqual([]);
  });

  it('gives the component tree the render keys and the snapshot keys', () => {
    const { reads } = entryFor('componentTree');

    expect(missingFrom(reads, RENDER_ATTRIBUTE_KEYS)).toEqual([]);
    expect(missingFrom(reads, COMPONENT_TREE_ATTRIBUTE_KEYS)).toEqual([]);
  });

  it('gives the state-transition view the transition keys', () => {
    const { reads } = entryFor('stateTransitions');

    expect(missingFrom(reads, STATE_ATTRIBUTE_KEYS)).toEqual([]);
    expect([...entryFor('stateTransitions').telemetryKinds]).toEqual([...STATE_KINDS]);
  });

  it('gives the waterfall the request and dependency kinds it draws', () => {
    const { reads, telemetryKinds } = entryFor('waterfall');

    expect([...telemetryKinds]).toEqual([...WATERFALL_KINDS]);
    expect(missingFrom(reads, FETCH_ATTRIBUTE_KEYS)).toEqual([]);
    expect(missingFrom(reads, DB_QUERY_ATTRIBUTE_KEYS)).toEqual([]);
  });
});

describe('the privacy bound of AAP §0.5.2', () => {
  it('claims no field the product never captures', () => {
    // Request and response bodies, database row contents and credential-shaped
    // values are not redacted late — they are never captured at all — so an
    // entry naming one could only be a specification error.
    const offenders: string[] = [];
    for (const entry of ENTRIES) {
      for (const field of entry.reads) {
        const lowered = field.toLowerCase();
        for (const forbidden of FORBIDDEN_READ_SUBSTRINGS) {
          if (lowered.includes(forbidden)) {
            offenders.push(`${entry.type}.reads: ${field} contains "${forbidden}"`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('confines value-shaped reads to the bounded state-transition summaries', () => {
    // The one documented exception, pinned mechanically rather than left to a
    // comment: a hook transition legitimately reads a summary of the value
    // before and after, and those summaries are bounded and truncated by the
    // producer. Any *other* entry acquiring a value-shaped read is a finding.
    const stateKeys: readonly string[] = STATE_ATTRIBUTE_KEYS;
    const unexpected: string[] = [];
    for (const entry of ENTRIES) {
      for (const field of entry.reads) {
        if (field.toLowerCase().includes('value') && !stateKeys.includes(field)) {
          unexpected.push(`${entry.type}.reads: ${field}`);
        }
      }
    }

    expect(unexpected).toEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * 5. Prompt rendering — deterministic, complete, ordered and application-free
 *
 * `describeCatalogForPrompt()`'s output *becomes* the node vocabulary section
 * of `apps/local-service/prompts/generate-panel/vNNN.md`, a file that is
 * versioned and immutable once committed and whose version is recorded on the
 * session (AAP §0.5.3). Two properties follow: the rendering must be stable, or
 * the committed prompt drifts from what the code produces; and the text must
 * name nothing from an application, or a panel decided in a prompt becomes a
 * hardcoded answer that the pipeline appears to have derived (AAP §0.5.4).
 * ---------------------------------------------------------------------------
 */

/**
 * The identifiers a prompt line may legitimately contain: the node types a
 * panel author must reproduce exactly, and the data sources a query may name.
 *
 * Both imported, so the allowance widens only when a vocabulary does.
 */
const PROMPT_IDENTIFIER_VOCABULARY: ReadonlySet<string> = new Set<string>([
  ...PANEL_NODE_TYPES,
  ...DATA_QUERY_SOURCES,
]);

/** The labels the catalog renders as prose, likewise imported. */
const PROMPT_LABEL_VOCABULARY: ReadonlySet<string> = new Set(ENTRIES.map((entry) => entry.label));

/** `someIdentifier` — a lower-camel token, which in prose can only be code. */
const CAMEL_CASE_TOKEN = /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g;

/** `SomeIdentifier` — a compound capitalised token: a component or type name. */
const PASCAL_CASE_TOKEN = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g;

/** `/segment/segment` — a route or file path of at least two segments. */
const PATH_TOKEN = /\/[A-Za-z0-9_[\]$.-]+(?:\/[A-Za-z0-9_[\]$.-]+)+/g;

/** `name.tsx` — a source file name, in any of the extensions this repo uses. */
const SOURCE_FILE_TOKEN = /\b[A-Za-z0-9_[\]$-]+\.(?:tsx?|jsx?|[cm][jt]s|sql|prisma)\b/g;

/** The route prefix every handler in a Next.js application shares. */
const ROUTE_PREFIX = '/api/';

/**
 * Every application-shaped token in a piece of prompt text.
 *
 * The strongest form of the AAP §0.5.4 check that can be applied to text
 * mechanically: rather than scanning for a list of words someone thought of,
 * it inverts the question and requires every *code-shaped* token in the output
 * to be a member of a vocabulary this package owns. A component name, a type
 * name, a hook name, a route, a file name or a domain identifier is
 * code-shaped and outside those vocabularies, so all of them are reported
 * without any of them being enumerated here — which also keeps this test file
 * free of the demo symbols it is guarding against.
 *
 * @param text Rendered prompt text.
 * @returns One finding per offending token, each naming what it found.
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
    if (!PROMPT_IDENTIFIER_VOCABULARY.has(match[0])) {
      findings.push(`identifier: ${match[0]}`);
    }
  }
  for (const match of text.matchAll(PASCAL_CASE_TOKEN)) {
    if (!PROMPT_LABEL_VOCABULARY.has(match[0])) {
      findings.push(`identifier: ${match[0]}`);
    }
  }

  return findings;
}

/**
 * A prompt line of the shape the guard must reject, built from invented tokens.
 *
 * Deliberately invented rather than borrowed: this file is product source, and
 * pasting a real application symbol in as a negative example would plant the
 * very thing AAP §0.5.4 forbids. The tokens below belong to no application in
 * this repository, which is what lets the guard be proved to fail without the
 * file naming anything.
 */
const SYNTHETIC_APPLICATION_LINE =
  '- `table` (Span table) — sources: spans. Rank the WidgetPanel rows served by ' +
  '/api/widgets, loaded in widgetLoader.ts by fooBarBaz.';

describe('describeCatalogForPrompt determinism', () => {
  it('returns identical text for two consecutive calls', () => {
    const first = describeCatalogForPrompt();
    const second = describeCatalogForPrompt();

    expect(second).toBe(first);
  });

  it('returns identical text for two calls with equal options', () => {
    expect(describeCatalogForPrompt({ kind: 'visualization', bullet: '* ' })).toBe(
      describeCatalogForPrompt({ kind: 'visualization', bullet: '* ' }),
    );
  });

  it('renders one line per node type, with no trailing newline', () => {
    const rendered = describeCatalogForPrompt();
    const lines = rendered.split('\n');

    expect(lines).toHaveLength(EXPECTED_TOTAL_ENTRIES);
    expect(rendered.endsWith('\n')).toBe(false);
    expect(lines.every((line) => line.startsWith(DEFAULT_CATALOG_PROMPT_BULLET))).toBe(true);
  });

  it('mentions every node type in the catalog', () => {
    const rendered = describeCatalogForPrompt();
    const unmentioned = PANEL_NODE_TYPES.filter((type) => !rendered.includes(`\`${type}\``));

    expect(unmentioned).toEqual([]);
  });

  it('orders the lines by the declared vocabulary rather than by enumeration', () => {
    // Property enumeration order is an implementation detail of how the record
    // happened to be written; the vocabulary's order is a contract. Ascending
    // positions prove the renderer iterates the latter.
    const rendered = describeCatalogForPrompt();
    const positions = PANEL_NODE_TYPES.map((type) => rendered.indexOf(`\`${type}\``));

    expect(positions.filter((position) => position < 0)).toEqual([]);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  it('carries each entry’s label and description on its own line', () => {
    const lines = describeCatalogForPrompt().split('\n');
    const wrong: string[] = [];

    for (const [index, entry] of ENTRIES.entries()) {
      const line = lines[index] ?? '';
      if (!line.includes(`\`${entry.type}\``)) {
        wrong.push(`line ${index} does not name ${entry.type}`);
      }
      if (!line.includes(entry.label)) {
        wrong.push(`line ${index} does not carry the label of ${entry.type}`);
      }
      if (!line.includes(entry.description)) {
        wrong.push(`line ${index} does not carry the description of ${entry.type}`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it('states the source allowance, the default and the options it renders', () => {
    const rendered = describeCatalogForPrompt();

    // The metric-tile node is the one entry with a default, and the prompt has
    // to say so or an author will spell a query the normaliser would supply.
    expect(rendered).toContain('metrics (default)');
    // Its own option is named as an option rather than as part of its query.
    expect(rendered).toContain('options: metrics');
    // The containers say they take children instead of a query.
    expect(rendered).toContain('no data query; contains other nodes');
    // The source-link leaf says it takes neither.
    expect(rendered).toContain('no data query; options: location');
  });

  it('honours the kind filter and the bullet option', () => {
    const containers = describeCatalogForPrompt({ kind: 'layout' }).split('\n');
    const visualizations = describeCatalogForPrompt({ kind: 'visualization' }).split('\n');

    expect(containers).toHaveLength(EXPECTED_LAYOUT_ENTRIES);
    expect(visualizations).toHaveLength(EXPECTED_VISUALIZATION_ENTRIES);

    const bare = describeCatalogForPrompt({ bullet: '' });
    expect(bare.startsWith(DEFAULT_CATALOG_PROMPT_BULLET)).toBe(false);
    expect(bare.split('\n')).toHaveLength(EXPECTED_TOTAL_ENTRIES);
  });

  it('draws the metric and participant vocabularies from the owning package', () => {
    // Neither list may be restated in a description. The rendered text is
    // therefore checked against the imported vocabularies: the tile row names
    // how many ids exist, and the graph names the participant classes, so a
    // hand-typed copy of either would fail here as soon as the real list moved.
    const rendered = describeCatalogForPrompt();

    expect(rendered).toContain(`${String(METRIC_IDS.length)} available ids`);
    expect(rendered).toContain(DEPENDENCY_NODE_KINDS.join(', '));
  });
});

describe('describeCatalogForPrompt names nothing from an application', () => {
  it('reports the application-shaped tokens of a line that has them', () => {
    // The guard is proved able to fail before it is trusted to pass: a
    // completeness or safety check that cannot fail is worse than none.
    const findings = applicationShapedTokens(SYNTHETIC_APPLICATION_LINE);
    const report = findings.join(' | ');

    expect(findings.length).toBeGreaterThan(0);
    expect(report).toContain(ROUTE_PREFIX);
    expect(report).toContain('WidgetPanel');
    expect(report).toContain('fooBarBaz');
    expect(report).toContain('widgetLoader.ts');
  });

  it('accepts the vocabulary the catalog legitimately renders', () => {
    // The same guard must not report the node types, sources and labels the
    // prompt exists to teach, or it would be unusable rather than strict.
    const legitimate = ENTRIES.map(
      (entry) => `\`${entry.type}\` (${entry.label}) — sources: ${entry.sources.join(', ')}.`,
    ).join('\n');

    expect(applicationShapedTokens(legitimate)).toEqual([]);
  });

  it('finds nothing in the rendered catalog', () => {
    expect(applicationShapedTokens(describeCatalogForPrompt())).toEqual([]);
    expect(applicationShapedTokens(describeCatalogForPrompt({ kind: 'layout' }))).toEqual([]);
    expect(applicationShapedTokens(describeCatalogForPrompt({ kind: 'visualization' }))).toEqual(
      [],
    );
  });

  it('finds nothing in any single entry’s label or description', () => {
    // Per entry as well as over the whole rendering, so a failure names the
    // entry whose description would have to be rewritten.
    const offenders: string[] = [];
    for (const entry of ENTRIES) {
      for (const finding of applicationShapedTokens(`${entry.label}. ${entry.description}`)) {
        offenders.push(`${entry.type}: ${finding}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('contains no route path in any form', () => {
    // Stated separately from the token guard because it is the specific shape
    // `scripts/check-no-hardcoding.mjs` scans prompt text for.
    const rendered = describeCatalogForPrompt();

    expect(rendered).not.toContain(ROUTE_PREFIX);
    expect(rendered.match(PATH_TOKEN)).toBeNull();
  });
});
