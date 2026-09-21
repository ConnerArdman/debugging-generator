/**
 * Colocated tests for the computed-metric vocabulary of `./attributes.ts`:
 * `METRIC_IDS`, the unit each id carries, and the three semantic groups
 * derived from it.
 *
 * **Why this vocabulary gets its own suite.** The metric ids are the one part
 * of this module whose *membership and order* are the contract rather than a
 * consequence of it. AAP §0.2.3 fixes a closed set of fourteen ids, and four
 * layers agree on it without a shared runtime path between them:
 * `../aggregate/summary.ts` publishes values under these names,
 * `packages/panel-schema` validates a `metricCards` node's `metrics` against
 * them, `packages/panel-renderer` renders a card per id, and
 * `packages/model-provider` names the counting ones in a sentence while being
 * forbidden — by AAP §0.2.2's edge list and §0.5.3's provider boundary — from
 * importing this package at all. A drift between any two of them is silent: a
 * card reads `n/a` beside a number the capture did record, and nothing throws.
 *
 * Two kinds of assertion follow from that, and the difference between them is
 * the point:
 *
 * - **Against the plan, the list is written out as data.** AAP §0.2.3 is a
 *   document, so the only way to check the code against it is to restate its
 *   fourteen ids here, in its order, and compare. A suite that asserted
 *   `METRIC_IDS.length === 14`, or compared the vocabulary with itself, would
 *   keep passing through exactly the drift it exists to catch.
 * - **Against the consumer, the declaration is read from its source.** The
 *   restatement in `packages/model-provider` is *code*, so nothing is copied
 *   into this file: the checks parse that module's own `CountMetricId` union
 *   and noun table and compare them as declared. Editing either side alone
 *   fails here.
 *
 * **What the compiler already guarantees, and is therefore not tested here.**
 * `METRIC_ID_UNITS` is annotated `Readonly<Record<MetricId, MetricUnit>>`, so
 * a missing or invented entry is a compile error, and each group's list is
 * annotated with its `Extract`-derived union, so a misspelled member is one
 * too. What the compiler cannot see is whether the groups *cover* the
 * vocabulary exactly once, and whether the units are assigned to the right
 * ids; both are asserted below.
 *
 * The rest of the module — the per-kind key registry, the value vocabularies
 * and the two privacy bounds — is guarded by `./event.test.ts` alongside the
 * event schema those declarations are validated through.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BYTE_METRIC_IDS,
  COUNT_METRIC_IDS,
  DURATION_METRIC_IDS,
  METRIC_ID_UNITS,
  METRIC_IDS,
  METRIC_UNITS,
  isMetricId,
  metricUnitFor,
  type MetricId,
  type MetricUnit,
} from './attributes.js';

/**
 * The fourteen ids of AAP §0.2.3, in the order that section lists them.
 *
 * Written out rather than imported: this array *is* the assertion. It is the
 * one place in the repository that restates the plan's list on purpose, so
 * that every other place can derive it.
 */
const CANONICAL_METRIC_IDS = [
  'total_duration',
  'frontend_duration',
  'backend_duration',
  'database_duration',
  'render_count',
  'unchanged_render_count',
  'render_trigger_unknown_count',
  'request_count',
  'query_count',
  'transferred_bytes',
  'blocking_time',
  'duplicate_request_count',
  'long_task_count',
  'error_count',
] as const;

/**
 * The module that restates the counting ids: the deterministic prose layer's
 * `CountMetricId` union and the noun table keyed by it.
 *
 * `packages/model-provider` may import `@debuggen/shared` and nothing else of
 * the monorepo (AAP §0.2.2's edge list, AAP §0.5.3's provider boundary,
 * enforced per workspace by `eslint.config.js`), so neither package can import
 * the other and no compiler check spans the two files. The checks below span
 * them the only way left: they **read that module's source** and compare the
 * declarations as written against {@link COUNT_METRIC_IDS}. A copy of the list
 * kept in this file would be a third restatement and would pass while the
 * consumer drifted, which is precisely the failure being guarded.
 *
 * A move or a rename on either side makes these checks fail loudly rather than
 * silently pass — see {@link declarationBlock}.
 *
 * Resolved with `fileURLToPath` and `path.resolve` rather than with
 * `new URL(relative, import.meta.url)`: this package's Vitest project runs
 * under happy-dom, whose global `URL` resolves a relative specifier against
 * the document's base (`http://localhost:3000/`) instead of against the
 * `file:` URL it was handed, which yields an unreadable http URL. Converting
 * the module URL to a path first keeps the resolution pure path arithmetic and
 * independent of the environment.
 */
const CONSUMER_SOURCE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../model-provider/src/deterministic/templates.ts',
);

/** The consumer module's source text, read at the moment a check needs it. */
function readConsumerSource(): string {
  try {
    return readFileSync(CONSUMER_SOURCE_PATH, 'utf8');
  } catch (cause) {
    throw new Error(
      `the consumer module could not be read at ${CONSUMER_SOURCE_PATH}. ` +
        'The count-metric restatement documented in ./attributes.ts lives there; if it has ' +
        'moved, point this check at its new path rather than deleting the check.',
      { cause },
    );
  }
}

/**
 * The source text of one declaration, from `anchor` up to `terminator`.
 *
 * Throws when either end cannot be found, so a renamed or restructured
 * declaration fails the suite instead of yielding an empty member list that
 * would compare equal to nothing and pass.
 */
function declarationBlock(source: string, anchor: string, terminator: string): string {
  const start = source.indexOf(anchor);
  if (start === -1) {
    throw new Error(
      `\`${anchor}\` was not found in ${CONSUMER_SOURCE_PATH}. That declaration is the ` +
        'restatement this check compares against; update the anchor if it was renamed.',
    );
  }

  const end = source.indexOf(terminator, start + anchor.length);
  if (end === -1) {
    throw new Error(
      `\`${anchor}\` in ${CONSUMER_SOURCE_PATH} is not terminated by ` +
        `\`${terminator.trim()}\`, so its members cannot be read.`,
    );
  }

  return source.slice(start, end);
}

/** Every single-quoted string literal of `block`, in source order. */
function stringLiteralsOf(block: string): string[] {
  return [...block.matchAll(/'([^']*)'/g)]
    .map((match) => match[1])
    .filter((literal): literal is string => literal !== undefined);
}

/**
 * The members of the consumer's `CountMetricId` union, as that file declares
 * them, in declaration order.
 */
function consumerUnionMembers(): string[] {
  const source = readConsumerSource();
  return stringLiteralsOf(declarationBlock(source, 'export type CountMetricId =', ';'));
}

/**
 * The keys of the consumer's noun table, as that file declares them, in
 * declaration order.
 *
 * The table is keyed by the union above and is total over it, so its keys are
 * the second place the consumer names the vocabulary — and the one a reader of
 * the generated prose actually depends on.
 */
function consumerNounTableKeys(): string[] {
  const source = readConsumerSource();
  const block = declarationBlock(source, 'export const METRIC_COUNT_NOUNS', '\n});');

  // Entry keys sit at exactly two spaces of indentation; the `singular` and
  // `plural` keys of each entry's value are inline or indented further.
  return [...block.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*):/gm)]
    .map((match) => match[1])
    .filter((key): key is string => key !== undefined);
}

/** The expected unit of every id, keyed to make a wrong pairing readable in a diff. */
const CANONICAL_METRIC_UNITS: Readonly<Record<MetricId, MetricUnit>> = {
  total_duration: 'milliseconds',
  frontend_duration: 'milliseconds',
  backend_duration: 'milliseconds',
  database_duration: 'milliseconds',
  render_count: 'count',
  unchanged_render_count: 'count',
  render_trigger_unknown_count: 'count',
  request_count: 'count',
  query_count: 'count',
  transferred_bytes: 'bytes',
  blocking_time: 'milliseconds',
  duplicate_request_count: 'count',
  long_task_count: 'count',
  error_count: 'count',
};

describe('METRIC_IDS', () => {
  it('declares exactly the metric ids of the plan, in the plan order', () => {
    expect([...METRIC_IDS]).toEqual([...CANONICAL_METRIC_IDS]);
  });

  it('declares each id once', () => {
    expect(new Set(METRIC_IDS).size).toBe(METRIC_IDS.length);
  });

  it('is frozen, so a consumer cannot extend the closed set in place', () => {
    expect(Object.isFrozen(METRIC_IDS)).toBe(true);
  });

  it('uses snake_case ids throughout, the spelling every consumer reads', () => {
    for (const id of METRIC_IDS) {
      expect(id).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
    }
  });
});

describe('isMetricId', () => {
  it('accepts every declared id', () => {
    for (const id of METRIC_IDS) {
      expect(isMetricId(id)).toBe(true);
    }
  });

  it('rejects a near miss rather than narrowing it', () => {
    // A plural, a casing change, a stray space and a plausible-but-absent id:
    // the four ways a hand-written metrics list goes wrong.
    for (const candidate of [
      'total_durations',
      'TOTAL_DURATION',
      'total duration',
      'commit_count',
      '',
    ]) {
      expect(isMetricId(candidate)).toBe(false);
    }
  });

  it('rejects a non-string without inspecting it', () => {
    for (const candidate of [undefined, null, 0, {}, ['render_count']]) {
      expect(isMetricId(candidate)).toBe(false);
    }
  });
});

describe('metric units', () => {
  it('declares the three units a metric value can carry', () => {
    expect([...METRIC_UNITS]).toEqual(['milliseconds', 'count', 'bytes']);
  });

  it('assigns every id the unit its definition implies', () => {
    expect({ ...METRIC_ID_UNITS }).toEqual(CANONICAL_METRIC_UNITS);
  });

  it('covers the whole vocabulary and nothing outside it', () => {
    expect(Object.keys(METRIC_ID_UNITS).sort()).toEqual([...METRIC_IDS].sort());
  });

  it('resolves through the accessor for every id', () => {
    for (const id of METRIC_IDS) {
      expect(metricUnitFor(id)).toBe(CANONICAL_METRIC_UNITS[id]);
    }
  });

  it('counts blocking_time as a duration and transferred_bytes as a size', () => {
    // The two ids whose name does not carry its unit, and therefore the two a
    // consumer is most likely to format as a bare count.
    expect(metricUnitFor('blocking_time')).toBe('milliseconds');
    expect(metricUnitFor('transferred_bytes')).toBe('bytes');
  });
});

describe('semantic groups', () => {
  it('partitions the vocabulary: every id in exactly one group', () => {
    const grouped = [...DURATION_METRIC_IDS, ...COUNT_METRIC_IDS, ...BYTE_METRIC_IDS];

    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...METRIC_IDS].sort());
  });

  it('keeps each group in the canonical order of the whole vocabulary', () => {
    const position = (id: MetricId): number => METRIC_IDS.indexOf(id);

    for (const group of [DURATION_METRIC_IDS, COUNT_METRIC_IDS, BYTE_METRIC_IDS]) {
      expect(group.map(position)).toEqual([...group.map(position)].sort((a, b) => a - b));
    }
  });

  it('groups by the unit each member carries', () => {
    for (const id of DURATION_METRIC_IDS) {
      expect(metricUnitFor(id)).toBe('milliseconds');
    }
    for (const id of COUNT_METRIC_IDS) {
      expect(metricUnitFor(id)).toBe('count');
    }
    for (const id of BYTE_METRIC_IDS) {
      expect(metricUnitFor(id)).toBe('bytes');
    }
  });

  it('is frozen group by group', () => {
    for (const group of [DURATION_METRIC_IDS, COUNT_METRIC_IDS, BYTE_METRIC_IDS]) {
      expect(Object.isFrozen(group)).toBe(true);
    }
  });
});

describe('consumer assignability', () => {
  it('matches the union the deterministic prose layer declares, as it declares it', () => {
    expect(consumerUnionMembers()).toEqual([...COUNT_METRIC_IDS]);
  });

  it("matches the keys of that layer's noun table, as it declares them", () => {
    expect(consumerNounTableKeys()).toEqual([...COUNT_METRIC_IDS]);
  });

  it('reads that module rather than a copy of its list', () => {
    // The guard on the guard: both checks above compare against text parsed
    // out of the consumer's source, so a declaration that cannot be located
    // has to fail rather than yield an empty list that matches nothing.
    const source = readConsumerSource();

    expect(source).toContain('export type CountMetricId =');
    expect(() => declarationBlock(source, 'export type NotDeclaredHere =', ';')).toThrow(
      /was not found in/,
    );
  });

  it('offers every group as a list of ids the whole vocabulary accepts', () => {
    // What a consumer holding `readonly MetricId[]` — the panel schema's
    // metrics list, an aggregate iterating a subset — can do with a group
    // without narrowing it first.
    const asMetricIds: readonly MetricId[] = [
      ...DURATION_METRIC_IDS,
      ...COUNT_METRIC_IDS,
      ...BYTE_METRIC_IDS,
    ];

    for (const id of asMetricIds) {
      expect(isMetricId(id)).toBe(true);
    }
  });

  it('exposes the vocabulary as a literal tuple a schema can enumerate', () => {
    // `packages/panel-schema` builds its metric enum from this value, the way
    // `./event.ts` builds its tier enum from the tier vocabulary, so the
    // exported shape has to be an array of string literals rather than a
    // widened `string[]`.
    const [first] = METRIC_IDS;
    const firstId: MetricId = first;

    expect(firstId).toBe('total_duration');
    expect(Array.isArray(METRIC_IDS)).toBe(true);
  });
});
