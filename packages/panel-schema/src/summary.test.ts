/**
 * Colocated tests for `./summary.ts` — the module that makes the boundary
 * between what a capture **shows** and what an analysis **infers** a matter of
 * types rather than of convention.
 *
 * ## What this suite pins
 *
 * 1. **The two parsers accept exactly the documented shapes.** `parseFact`
 *    admits a non-blank statement with between one and
 *    {@link MAX_EVIDENCE_REFS} citations and nothing else; `parseHypothesis`
 *    admits the same plus a confidence from the closed vocabulary and,
 *    optionally, a source location that passes `@debuggen/shared`'s definition.
 *    Every bound is exercised on both sides: the largest accepted value and the
 *    smallest rejected one.
 * 2. **A rejection has one shape, and it is structural.** Code `PANEL_INVALID`,
 *    a message naming the schema, the schema's own hint, and
 *    `details: { schema, issues }` where every issue is a dotted `path` and a
 *    `code`, plus `expected` on a type mismatch and never otherwise.
 * 3. **A rejection never carries the rejected value.** Sentinel strings are
 *    placed in every field a caller can put text into — a statement, a key
 *    name, an event id, a label, a trace id, a location file, a confidence —
 *    and none of them may reach the error's message, hint, details, stack or
 *    serialised form, because a rejected value can carry developer data.
 *    `describeIssues` is exercised directly on issues whose message and input
 *    *are* the sentinel, so the rule is proved at the one place it is
 *    implemented.
 * 4. **Confidence is ordered, and only three strings are confidences.**
 *    `compareConfidence` is a total, antisymmetric comparator over
 *    `low < medium < high` that reports zero for equal levels, and
 *    `isConfidenceLevel` narrows exactly the three members.
 * 5. **The summary keeps the registers apart.** `panelSummarySchema` defaults
 *    both lists to `[]`, bounds them, rejects a fourth register, and refuses to
 *    let a fact stand in the likely-cause list or a hypothesis in the observed
 *    list.
 *
 * Everything here is synchronous and pure; nothing reaches the filesystem, the
 * network or `$DEBUGGEN_HOME`. Identifiers are generic, because
 * `scripts/check-no-hardcoding.mjs` scans this package and because a test that
 * knew an application's vocabulary would be evidence of the coupling to one
 * application that script forbids.
 */

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { DebuggenError, SOURCE_RESOLVED_BY, isErr, isOk } from '@debuggen/shared';
import type { Result, SourceLocation } from '@debuggen/shared';
import { TELEMETRY_KINDS } from '@debuggen/telemetry';

import {
  CONFIDENCE_LEVELS,
  MAX_EVENT_REF_ID_LENGTH,
  MAX_EVENT_REF_LABEL_LENGTH,
  MAX_EVIDENCE_REFS,
  MAX_HEADLINE_LENGTH,
  MAX_STATEMENT_LENGTH,
  MAX_SUMMARY_FACTS,
  MAX_SUMMARY_HYPOTHESES,
  compareConfidence,
  describeIssues,
  eventRefSchema,
  factSchema,
  isConfidenceLevel,
  panelSummarySchema,
  parseFact,
  parseHypothesis,
} from './summary.js';
import type { ConfidenceLevel, EventRef, Fact, Hypothesis, SchemaIssueSummary } from './summary.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/** The hint `parseFact` offers, restated so a reworded hint is a visible change. */
const FACT_HINT =
  'A fact needs a non-empty statement and at least one evidence reference, each naming the id of a captured event.';

/** The hint `parseHypothesis` offers, restated for the same reason. */
const HYPOTHESIS_HINT =
  'A hypothesis needs everything a fact needs plus a confidence of low, medium or high; suggestedLocation is optional and, when present, needs a project-relative POSIX file with a 1-based line and column.';

/**
 * A credential-shaped sentinel, assembled at run time so that no literal in
 * this file looks like a secret to a scanner, while a leak of it into an error
 * would be unmistakable.
 */
const SENTINEL = ['sk', 'sentinel', '9f8e7d6c5b4a39281706f5e4d3c2b1a0'].join('-');

/** A citation with only the field that carries meaning. */
const MINIMAL_REF: EventRef = Object.freeze({ eventId: 'evt_first' });

/** A citation with every optional coordinate present and valid. */
const FULL_REF: EventRef = Object.freeze({
  eventId: 'evt_second',
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  kind: firstTelemetryKind(),
  label: 'Slowest span',
});

/** The smallest valid fact. */
const MINIMAL_FACT: Fact = Object.freeze({
  statement: 'The traced request took longer than every sibling.',
  evidence: [MINIMAL_REF],
});

/** A valid source location, resolved through the code graph. */
const LOCATION: SourceLocation = Object.freeze({
  file: 'src/lib/example.ts',
  line: 12,
  column: 3,
  resolvedBy: 'code-graph',
  confidence: 0.75,
});

/** The smallest valid hypothesis. */
const MINIMAL_HYPOTHESIS: Hypothesis = Object.freeze({
  ...MINIMAL_FACT,
  confidence: 'medium',
});

/**
 * The first member of the telemetry kind vocabulary, read from its single
 * definition rather than spelled here.
 *
 * @returns A valid telemetry kind.
 */
function firstTelemetryKind(): (typeof TELEMETRY_KINDS)[number] {
  const [first] = TELEMETRY_KINDS;

  if (first === undefined) {
    throw new Error('the telemetry kind vocabulary must not be empty');
  }

  return first;
}

/**
 * `count` distinct citations.
 *
 * @param count How many.
 * @returns The citations.
 */
function citations(count: number): EventRef[] {
  return Array.from({ length: count }, (_, index) => ({ eventId: `evt_${String(index)}` }));
}

/**
 * The value of an accepted parse, or a failure naming the error.
 *
 * @param result A parse result.
 * @returns The parsed value.
 */
function accepted<T>(result: Result<T, DebuggenError>): T {
  if (!isOk(result)) {
    throw new Error(`expected an accepted parse, got ${JSON.stringify(result.error.details)}`);
  }

  return result.value;
}

/**
 * The error of a rejected parse, or a failure.
 *
 * @param result A parse result.
 * @returns The rejection.
 */
function rejected<T>(result: Result<T, DebuggenError>): DebuggenError {
  if (!isErr(result)) {
    throw new Error(`expected a rejection, got ${JSON.stringify(result.value)}`);
  }

  return result.error;
}

/**
 * The issue summaries a rejection carries.
 *
 * @param error The rejection.
 * @returns Its `details.issues`.
 */
function issuesOf(error: DebuggenError): unknown {
  return error.details?.['issues'];
}

/**
 * Every text a rejection exposes to a log line, a user interface or a store:
 * its message, hint, stack, details and serialised form.
 *
 * @param error The rejection.
 * @returns The texts.
 */
function exposedTexts(error: DebuggenError): readonly string[] {
  return [
    error.message,
    error.hint ?? '',
    error.stack ?? '',
    JSON.stringify(error.details),
    JSON.stringify(error),
    String(error),
  ];
}

/**
 * Asserts the one shape every rejection has.
 *
 * @param error The rejection.
 * @param schema The schema it names.
 * @param issues The exact issue summaries expected, in reported order.
 */
function expectRejection(
  error: DebuggenError,
  schema: 'fact' | 'hypothesis',
  issues: readonly SchemaIssueSummary[],
): void {
  expect(error).toBeInstanceOf(DebuggenError);
  expect(error.code).toBe('PANEL_INVALID');
  expect(error.message).toBe(`A value did not match the ${schema} schema.`);
  expect(error.hint).toBe(schema === 'fact' ? FACT_HINT : HYPOTHESIS_HINT);
  expect(error.details).toStrictEqual({ schema, issues });
}

/* -------------------------------------------------------------------------------------------------
 * parseFact
 * ---------------------------------------------------------------------------------------------- */

describe('parseFact: what it accepts', () => {
  it('accepts the smallest valid fact and returns an equal value without touching its input', () => {
    const input = { statement: MINIMAL_FACT.statement, evidence: [{ eventId: 'evt_first' }] };
    const snapshot = JSON.stringify(input);
    const fact = accepted(parseFact(input));

    expect(fact).toStrictEqual(input);
    expect(fact).not.toBe(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('accepts a citation carrying every optional coordinate', () => {
    expect(accepted(parseFact({ ...MINIMAL_FACT, evidence: [FULL_REF] }))).toStrictEqual({
      ...MINIMAL_FACT,
      evidence: [FULL_REF],
    });
  });

  it('accepts a statement at exactly its length bound and the maximum number of citations', () => {
    const statement = 's'.repeat(MAX_STATEMENT_LENGTH);
    const evidence = citations(MAX_EVIDENCE_REFS);

    expect(accepted(parseFact({ statement, evidence }))).toStrictEqual({ statement, evidence });
  });

  it.each(TELEMETRY_KINDS.map((kind) => [kind]))('accepts a citation of kind %s', (kind) => {
    expect(
      accepted(parseFact({ ...MINIMAL_FACT, evidence: [{ eventId: 'evt_k', kind }] })).evidence,
    ).toStrictEqual([{ eventId: 'evt_k', kind }]);
  });

  it('accepts an event id and a label at exactly their length bounds', () => {
    const ref = {
      eventId: 'e'.repeat(MAX_EVENT_REF_ID_LENGTH),
      label: 'l'.repeat(MAX_EVENT_REF_LABEL_LENGTH),
    };

    expect(accepted(parseFact({ ...MINIMAL_FACT, evidence: [ref] })).evidence).toStrictEqual([ref]);
  });
});

describe('parseFact: what it rejects, by path and code', () => {
  it.each<[string, unknown, readonly SchemaIssueSummary[]]>([
    [
      'an empty evidence list',
      { ...MINIMAL_FACT, evidence: [] },
      [{ path: 'evidence', code: 'too_small' }],
    ],
    [
      'a missing evidence list',
      { statement: MINIMAL_FACT.statement },
      [{ path: 'evidence', code: 'invalid_type', expected: 'array' }],
    ],
    [
      'a blank statement',
      { ...MINIMAL_FACT, statement: '   ' },
      [{ path: 'statement', code: 'invalid_format' }],
    ],
    [
      'an empty statement',
      { ...MINIMAL_FACT, statement: '' },
      [
        { path: 'statement', code: 'too_small' },
        { path: 'statement', code: 'invalid_format' },
      ],
    ],
    [
      'a missing statement',
      { evidence: [MINIMAL_REF] },
      [{ path: 'statement', code: 'invalid_type', expected: 'string' }],
    ],
    [
      'a statement that is not a string',
      { ...MINIMAL_FACT, statement: 7 },
      [{ path: 'statement', code: 'invalid_type', expected: 'string' }],
    ],
    [
      'a statement one character over its bound',
      { ...MINIMAL_FACT, statement: 's'.repeat(MAX_STATEMENT_LENGTH + 1) },
      [{ path: 'statement', code: 'too_big' }],
    ],
    [
      'one citation too many',
      { ...MINIMAL_FACT, evidence: citations(MAX_EVIDENCE_REFS + 1) },
      [{ path: 'evidence', code: 'too_big' }],
    ],
    [
      'an unknown key',
      { ...MINIMAL_FACT, confidence: 'high' },
      [{ path: '', code: 'unrecognized_keys' }],
    ],
    ['null', null, [{ path: '', code: 'invalid_type', expected: 'object' }]],
    [
      'a bare string',
      'The traced request was slow.',
      [{ path: '', code: 'invalid_type', expected: 'object' }],
    ],
    ['an array', [MINIMAL_FACT], [{ path: '', code: 'invalid_type', expected: 'object' }]],
    [
      'a citation with an unknown key',
      { ...MINIMAL_FACT, evidence: [{ eventId: 'evt_x', note: 'extra' }] },
      [{ path: 'evidence.0', code: 'unrecognized_keys' }],
    ],
    [
      'a citation without an event id',
      { ...MINIMAL_FACT, evidence: [{ label: 'Slowest span' }] },
      [{ path: 'evidence.0.eventId', code: 'invalid_type', expected: 'string' }],
    ],
    [
      'a blank event id',
      { ...MINIMAL_FACT, evidence: [{ eventId: ' ' }] },
      [{ path: 'evidence.0.eventId', code: 'invalid_format' }],
    ],
    [
      'an event id one character over its bound',
      { ...MINIMAL_FACT, evidence: [{ eventId: 'e'.repeat(MAX_EVENT_REF_ID_LENGTH + 1) }] },
      [{ path: 'evidence.0.eventId', code: 'too_big' }],
    ],
    [
      'an uppercase trace id',
      {
        ...MINIMAL_FACT,
        evidence: [{ eventId: 'evt_x', traceId: '0AF7651916CD43DD8448EB211C80319C' }],
      },
      [{ path: 'evidence.0.traceId', code: 'invalid_format' }],
    ],
    [
      'a short span id',
      { ...MINIMAL_FACT, evidence: [{ eventId: 'evt_x', spanId: 'b7ad6b71' }] },
      [{ path: 'evidence.0.spanId', code: 'invalid_format' }],
    ],
    [
      'a kind outside the vocabulary',
      { ...MINIMAL_FACT, evidence: [{ eventId: 'evt_x', kind: 'not-a-kind' }] },
      [{ path: 'evidence.0.kind', code: 'invalid_value' }],
    ],
    [
      'a blank label',
      { ...MINIMAL_FACT, evidence: [{ eventId: 'evt_x', label: '\t' }] },
      [{ path: 'evidence.0.label', code: 'invalid_format' }],
    ],
    [
      'a label one character over its bound',
      {
        ...MINIMAL_FACT,
        evidence: [{ eventId: 'evt_x', label: 'l'.repeat(MAX_EVENT_REF_LABEL_LENGTH + 1) }],
      },
      [{ path: 'evidence.0.label', code: 'too_big' }],
    ],
    [
      'a bad second citation',
      { ...MINIMAL_FACT, evidence: [MINIMAL_REF, { eventId: '' }] },
      [
        { path: 'evidence.1.eventId', code: 'too_small' },
        { path: 'evidence.1.eventId', code: 'invalid_format' },
      ],
    ],
  ])('rejects %s', (_label, value, issues) => {
    expectRejection(rejected(parseFact(value)), 'fact', issues);
  });

  it('rejects a hypothesis offered as a fact, because a confidence is not an observation', () => {
    expectRejection(rejected(parseFact(MINIMAL_HYPOTHESIS)), 'fact', [
      { path: '', code: 'unrecognized_keys' },
    ]);
  });

  it('reports every issue of one value, in the order the schema found them', () => {
    expectRejection(rejected(parseFact({ statement: '', evidence: [], extra: true })), 'fact', [
      { path: 'statement', code: 'too_small' },
      { path: 'statement', code: 'invalid_format' },
      { path: 'evidence', code: 'too_small' },
      { path: '', code: 'unrecognized_keys' },
    ]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * parseHypothesis
 * ---------------------------------------------------------------------------------------------- */

describe('parseHypothesis: what it accepts', () => {
  it.each(CONFIDENCE_LEVELS.map((level) => [level]))(
    'accepts a hypothesis offered with %s confidence and no location',
    (confidence) => {
      const hypothesis = accepted(parseHypothesis({ ...MINIMAL_FACT, confidence }));

      expect(hypothesis).toStrictEqual({ ...MINIMAL_FACT, confidence });
      expect('suggestedLocation' in hypothesis).toBe(false);
    },
  );

  it.each(SOURCE_RESOLVED_BY.map((resolvedBy) => [resolvedBy]))(
    'accepts a suggested location resolved by %s',
    (resolvedBy) => {
      const suggestedLocation = { ...LOCATION, resolvedBy };

      expect(
        accepted(parseHypothesis({ ...MINIMAL_HYPOTHESIS, suggestedLocation })).suggestedLocation,
      ).toStrictEqual(suggestedLocation);
    },
  );

  it('accepts a location with a symbol, an end line equal to its line, and both confidence bounds', () => {
    for (const confidence of [0, 1]) {
      const suggestedLocation = {
        ...LOCATION,
        symbol: 'exampleFunction',
        endLine: LOCATION.line,
        confidence,
      };

      expect(
        accepted(parseHypothesis({ ...MINIMAL_HYPOTHESIS, suggestedLocation })).suggestedLocation,
      ).toStrictEqual(suggestedLocation);
    }
  });

  it('keeps only the defined fields of a suggested location, dropping an unknown one', () => {
    // `@debuggen/shared`'s location schema is not strict, so an extra field is
    // stripped rather than rejected — and, stripped, it cannot reach a store.
    const hypothesis = accepted(
      parseHypothesis({
        ...MINIMAL_HYPOTHESIS,
        suggestedLocation: { ...LOCATION, note: SENTINEL },
      }),
    );

    expect(hypothesis.suggestedLocation).toStrictEqual(LOCATION);
    expect(JSON.stringify(hypothesis)).not.toContain(SENTINEL);
  });

  it('parses a hypothesis that is still readable as the fact it cites', () => {
    const hypothesis = accepted(parseHypothesis(MINIMAL_HYPOTHESIS));
    const asFact: Fact = { statement: hypothesis.statement, evidence: hypothesis.evidence };

    expect(accepted(parseFact(asFact))).toStrictEqual(MINIMAL_FACT);
  });
});

describe('parseHypothesis: what it rejects, by path and code', () => {
  it.each<[string, unknown, readonly SchemaIssueSummary[]]>([
    ['a missing confidence', MINIMAL_FACT, [{ path: 'confidence', code: 'invalid_value' }]],
    [
      'a confidence outside the vocabulary',
      { ...MINIMAL_HYPOTHESIS, confidence: 'certain' },
      [{ path: 'confidence', code: 'invalid_value' }],
    ],
    [
      'a capitalised confidence',
      { ...MINIMAL_HYPOTHESIS, confidence: 'High' },
      [{ path: 'confidence', code: 'invalid_value' }],
    ],
    [
      'a numeric confidence',
      { ...MINIMAL_HYPOTHESIS, confidence: 2 },
      [{ path: 'confidence', code: 'invalid_value' }],
    ],
    [
      'an empty evidence list',
      { ...MINIMAL_HYPOTHESIS, evidence: [] },
      [{ path: 'evidence', code: 'too_small' }],
    ],
    [
      'a blank statement',
      { ...MINIMAL_HYPOTHESIS, statement: '\n' },
      [{ path: 'statement', code: 'invalid_format' }],
    ],
    [
      'an unknown key',
      { ...MINIMAL_HYPOTHESIS, rank: 1 },
      [{ path: '', code: 'unrecognized_keys' }],
    ],
    [
      'an absolute location file',
      { ...MINIMAL_HYPOTHESIS, suggestedLocation: { ...LOCATION, file: '/etc/hosts' } },
      [{ path: 'suggestedLocation.file', code: 'custom' }],
    ],
    [
      'a location file that climbs out of the project',
      { ...MINIMAL_HYPOTHESIS, suggestedLocation: { ...LOCATION, file: '../outside.ts' } },
      [{ path: 'suggestedLocation.file', code: 'custom' }],
    ],
    [
      'a location file with a backslash',
      { ...MINIMAL_HYPOTHESIS, suggestedLocation: { ...LOCATION, file: 'src\\lib\\example.ts' } },
      [{ path: 'suggestedLocation.file', code: 'custom' }],
    ],
    [
      'a drive-letter location file',
      { ...MINIMAL_HYPOTHESIS, suggestedLocation: { ...LOCATION, file: 'C:/project/example.ts' } },
      [{ path: 'suggestedLocation.file', code: 'custom' }],
    ],
    [
      'a missing location file',
      {
        ...MINIMAL_HYPOTHESIS,
        suggestedLocation: { line: 1, column: 1, resolvedBy: 'patch', confidence: 1 },
      },
      [{ path: 'suggestedLocation.file', code: 'invalid_type', expected: 'string' }],
    ],
    [
      'line 0',
      { ...MINIMAL_HYPOTHESIS, suggestedLocation: { ...LOCATION, line: 0 } },
      [{ path: 'suggestedLocation.line', code: 'too_small' }],
    ],
    [
      'a fractional line',
      { ...MINIMAL_HYPOTHESIS, suggestedLocation: { ...LOCATION, line: 1.5 } },
      [{ path: 'suggestedLocation.line', code: 'invalid_type', expected: 'int' }],
    ],
    [
      'column 0',
      { ...MINIMAL_HYPOTHESIS, suggestedLocation: { ...LOCATION, column: 0 } },
      [{ path: 'suggestedLocation.column', code: 'too_small' }],
    ],
    [
      'an end line before the line',
      { ...MINIMAL_HYPOTHESIS, suggestedLocation: { ...LOCATION, line: 5, endLine: 4 } },
      [{ path: 'suggestedLocation.endLine', code: 'custom' }],
    ],
    [
      'a resolver outside the vocabulary',
      { ...MINIMAL_HYPOTHESIS, suggestedLocation: { ...LOCATION, resolvedBy: 'guess' } },
      [{ path: 'suggestedLocation.resolvedBy', code: 'invalid_value' }],
    ],
    [
      'a resolver confidence above 1',
      { ...MINIMAL_HYPOTHESIS, suggestedLocation: { ...LOCATION, confidence: 1.5 } },
      [{ path: 'suggestedLocation.confidence', code: 'too_big' }],
    ],
    [
      'a resolver confidence below 0',
      { ...MINIMAL_HYPOTHESIS, suggestedLocation: { ...LOCATION, confidence: -0.1 } },
      [{ path: 'suggestedLocation.confidence', code: 'too_small' }],
    ],
    [
      'a location that is a string',
      { ...MINIMAL_HYPOTHESIS, suggestedLocation: 'src/lib/example.ts:12' },
      [{ path: 'suggestedLocation', code: 'invalid_type', expected: 'object' }],
    ],
  ])('rejects %s', (_label, value, issues) => {
    expectRejection(rejected(parseHypothesis(value)), 'hypothesis', issues);
  });

  it('reports every issue of one value, in the order the schema found them', () => {
    const value = {
      statement: '',
      evidence: [],
      extra: 1,
      confidence: 'certain',
      suggestedLocation: { file: '/abs', line: 0, column: 0, resolvedBy: 'guess', confidence: 2 },
    };

    expectRejection(rejected(parseHypothesis(value)), 'hypothesis', [
      { path: 'statement', code: 'too_small' },
      { path: 'statement', code: 'invalid_format' },
      { path: 'evidence', code: 'too_small' },
      { path: 'confidence', code: 'invalid_value' },
      { path: 'suggestedLocation.file', code: 'custom' },
      { path: 'suggestedLocation.line', code: 'too_small' },
      { path: 'suggestedLocation.column', code: 'too_small' },
      { path: 'suggestedLocation.resolvedBy', code: 'invalid_value' },
      { path: 'suggestedLocation.confidence', code: 'too_big' },
      { path: '', code: 'unrecognized_keys' },
    ]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Privacy
 * ---------------------------------------------------------------------------------------------- */

describe('parseFact and parseHypothesis: a rejection never carries the rejected value', () => {
  it.each<[string, (value: unknown) => Result<unknown, DebuggenError>, unknown]>([
    ['a statement over its bound', parseFact, { ...MINIMAL_FACT, statement: SENTINEL.repeat(20) }],
    ['a key name and its value', parseFact, { ...MINIMAL_FACT, [SENTINEL]: SENTINEL }],
    [
      'an event id over its bound',
      parseFact,
      { ...MINIMAL_FACT, evidence: [{ eventId: SENTINEL.repeat(5) }] },
    ],
    [
      'a trace id of the wrong shape',
      parseFact,
      { ...MINIMAL_FACT, evidence: [{ eventId: 'evt_x', traceId: SENTINEL }] },
    ],
    [
      'a label over its bound',
      parseFact,
      { ...MINIMAL_FACT, evidence: [{ eventId: 'evt_x', label: SENTINEL.repeat(5) }] },
    ],
    [
      'a kind outside the vocabulary',
      parseFact,
      { ...MINIMAL_FACT, evidence: [{ eventId: 'evt_x', kind: SENTINEL }] },
    ],
    ['a value that is not an object', parseFact, SENTINEL],
    [
      'a confidence outside the vocabulary',
      parseHypothesis,
      { ...MINIMAL_HYPOTHESIS, confidence: SENTINEL },
    ],
    [
      'an absolute location file',
      parseHypothesis,
      { ...MINIMAL_HYPOTHESIS, suggestedLocation: { ...LOCATION, file: `/${SENTINEL}.ts` } },
    ],
    [
      'a resolver outside the vocabulary',
      parseHypothesis,
      { ...MINIMAL_HYPOTHESIS, suggestedLocation: { ...LOCATION, resolvedBy: SENTINEL } },
    ],
  ])('keeps %s out of every text the error exposes', (_label, parse, value) => {
    const error = rejected(parse(value));

    for (const text of exposedTexts(error)) {
      expect(text).not.toContain(SENTINEL);
    }

    // The failure is still actionable: it names where and what, just not the value.
    const issues = issuesOf(error);

    expect(Array.isArray(issues) && issues.length > 0).toBe(true);
  });

  it('carries only path, code and, for a type mismatch, expected on every issue', () => {
    const error = rejected(
      parseHypothesis({
        statement: 5,
        evidence: [{ eventId: SENTINEL.repeat(5), label: '' }],
        confidence: SENTINEL,
        [SENTINEL]: true,
      }),
    );
    const issues = issuesOf(error) as readonly Record<string, unknown>[];

    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(Object.keys(issue).sort()).toStrictEqual(
        issue['code'] === 'invalid_type' ? ['code', 'expected', 'path'] : ['code', 'path'],
      );
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * describeIssues
 * ---------------------------------------------------------------------------------------------- */

describe('describeIssues', () => {
  it('joins every path segment with dots, stringifying indices and symbols', () => {
    const issues: z.core.$ZodIssue[] = [
      {
        code: 'custom',
        path: [Symbol.for('segment'), 2, 'field'],
        message: SENTINEL,
        input: SENTINEL,
      },
      { code: 'invalid_type', expected: 'string', path: [], message: SENTINEL, input: 5 },
    ];

    expect(describeIssues(issues)).toStrictEqual([
      { path: 'Symbol(segment).2.field', code: 'custom' },
      { path: '', code: 'invalid_type', expected: 'string' },
    ]);
  });

  it('drops the message and the input of every issue, whatever the library put there', () => {
    const issues: z.core.$ZodIssue[] = [
      { code: 'custom', path: ['statement'], message: SENTINEL, input: SENTINEL },
      { code: 'invalid_type', expected: 'object', path: [], message: SENTINEL, input: SENTINEL },
    ];

    expect(JSON.stringify(describeIssues(issues))).not.toContain(SENTINEL);
  });

  it('reports the issues of a real parse one to one, in order', () => {
    const parsed = factSchema.safeParse({ statement: SENTINEL.repeat(20), evidence: [] });

    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }

    const summaries = describeIssues(parsed.error.issues);

    expect(summaries).toHaveLength(parsed.error.issues.length);
    expect(summaries).toStrictEqual([
      { path: 'statement', code: 'too_big' },
      { path: 'evidence', code: 'too_small' },
    ]);
  });

  it('returns an empty list for no issues', () => {
    expect(describeIssues([])).toStrictEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The confidence vocabulary
 * ---------------------------------------------------------------------------------------------- */

describe('compareConfidence', () => {
  it('orders the vocabulary low < medium < high', () => {
    expect(compareConfidence('low', 'medium')).toBeLessThan(0);
    expect(compareConfidence('medium', 'high')).toBeLessThan(0);
    expect(compareConfidence('low', 'high')).toBeLessThan(0);
    expect(compareConfidence('high', 'low')).toBeGreaterThan(0);
  });

  it('reports zero for every level compared with itself', () => {
    for (const level of CONFIDENCE_LEVELS) {
      expect(compareConfidence(level, level)).toBe(0);
    }
  });

  it('is antisymmetric and transitive over every pair and triple', () => {
    for (const a of CONFIDENCE_LEVELS) {
      for (const b of CONFIDENCE_LEVELS) {
        // Summed rather than negated: `-Math.sign(0)` is `-0`, which `toBe`
        // distinguishes from `0`.
        expect(Math.sign(compareConfidence(a, b)) + Math.sign(compareConfidence(b, a))).toBe(0);

        for (const c of CONFIDENCE_LEVELS) {
          if (compareConfidence(a, b) < 0 && compareConfidence(b, c) < 0) {
            expect(compareConfidence(a, c)).toBeLessThan(0);
          }
        }
      }
    }
  });

  it('sorts a list ascending, and most confident first with the arguments reversed', () => {
    const levels: ConfidenceLevel[] = ['high', 'low', 'medium', 'low', 'high'];

    expect([...levels].sort(compareConfidence)).toStrictEqual([
      'low',
      'low',
      'medium',
      'high',
      'high',
    ]);
    expect([...levels].sort((a, b) => compareConfidence(b, a))).toStrictEqual([
      'high',
      'high',
      'medium',
      'low',
      'low',
    ]);
  });

  it('ranks hypotheses by confidence, keeping equal levels in their authored order', () => {
    const causes: Hypothesis[] = [
      { ...MINIMAL_FACT, statement: 'First low guess.', confidence: 'low' },
      { ...MINIMAL_FACT, statement: 'Only high guess.', confidence: 'high' },
      { ...MINIMAL_FACT, statement: 'Second low guess.', confidence: 'low' },
    ];

    expect(
      [...causes]
        .sort((a, b) => compareConfidence(b.confidence, a.confidence))
        .map((cause) => cause.statement),
    ).toStrictEqual(['Only high guess.', 'First low guess.', 'Second low guess.']);
  });

  it('exposes the vocabulary frozen, in ascending order', () => {
    expect(CONFIDENCE_LEVELS).toStrictEqual(['low', 'medium', 'high']);
    expect(Object.isFrozen(CONFIDENCE_LEVELS)).toBe(true);
    expect([...CONFIDENCE_LEVELS].sort(compareConfidence)).toStrictEqual([...CONFIDENCE_LEVELS]);
  });
});

describe('isConfidenceLevel', () => {
  it.each(CONFIDENCE_LEVELS.map((level) => [level]))('accepts %s', (level) => {
    expect(isConfidenceLevel(level)).toBe(true);
  });

  it.each([['Low'], ['HIGH'], [' low'], ['medium '], ['certain'], ['']])(
    'refuses the string %j',
    (value) => {
      expect(isConfidenceLevel(value)).toBe(false);
    },
  );

  it.each<[string, unknown]>([
    ['a number', 1],
    ['zero', 0],
    ['null', null],
    ['undefined', undefined],
    ['a boolean', true],
    ['an object', { level: 'low' }],
    ['an array holding a level', ['low']],
    ['a boxed string', Object('low')],
  ])('refuses %s', (_label, value) => {
    expect(isConfidenceLevel(value)).toBe(false);
  });

  it('narrows an unknown value so it can be compared', () => {
    const stored: unknown = 'high';

    expect(
      isConfidenceLevel(stored) ? compareConfidence(stored, 'medium') : undefined,
    ).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------------------------------
 * eventRefSchema and panelSummarySchema
 * ---------------------------------------------------------------------------------------------- */

describe('eventRefSchema', () => {
  it('accepts a citation with only an event id and one with every coordinate', () => {
    expect(eventRefSchema.parse(MINIMAL_REF)).toStrictEqual(MINIMAL_REF);
    expect(eventRefSchema.parse(FULL_REF)).toStrictEqual(FULL_REF);
  });

  it('rejects an unknown key rather than stripping it', () => {
    const parsed = eventRefSchema.safeParse({ ...MINIMAL_REF, value: 'captured' });

    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : describeIssues(parsed.error.issues)).toStrictEqual([
      { path: '', code: 'unrecognized_keys' },
    ]);
  });
});

describe('panelSummarySchema', () => {
  it('defaults both lists to empty, so a consumer never branches on undefined', () => {
    expect(panelSummarySchema.parse({})).toStrictEqual({ observed: [], likelyCauses: [] });
    expect(panelSummarySchema.parse({ headline: 'Nothing stood out.' })).toStrictEqual({
      headline: 'Nothing stood out.',
      observed: [],
      likelyCauses: [],
    });
  });

  it('accepts a full summary with both lists at their bounds and a headline at its bound', () => {
    const summary = {
      headline: 'h'.repeat(MAX_HEADLINE_LENGTH),
      observed: Array.from({ length: MAX_SUMMARY_FACTS }, () => MINIMAL_FACT),
      likelyCauses: Array.from({ length: MAX_SUMMARY_HYPOTHESES }, () => ({
        ...MINIMAL_HYPOTHESIS,
        suggestedLocation: LOCATION,
      })),
    };

    expect(panelSummarySchema.parse(summary)).toStrictEqual(summary);
  });

  it.each<[string, unknown, readonly SchemaIssueSummary[]]>([
    [
      'a headline one character over its bound',
      { headline: 'h'.repeat(MAX_HEADLINE_LENGTH + 1) },
      [{ path: 'headline', code: 'too_big' }],
    ],
    ['a blank headline', { headline: ' ' }, [{ path: 'headline', code: 'invalid_format' }]],
    [
      'one observed fact too many',
      { observed: Array.from({ length: MAX_SUMMARY_FACTS + 1 }, () => MINIMAL_FACT) },
      [{ path: 'observed', code: 'too_big' }],
    ],
    [
      'one likely cause too many',
      {
        likelyCauses: Array.from({ length: MAX_SUMMARY_HYPOTHESES + 1 }, () => MINIMAL_HYPOTHESIS),
      },
      [{ path: 'likelyCauses', code: 'too_big' }],
    ],
    ['a fourth register', { notes: ['prose'] }, [{ path: '', code: 'unrecognized_keys' }]],
    [
      'a fact promoted into the likely causes',
      { likelyCauses: [MINIMAL_FACT] },
      [{ path: 'likelyCauses.0.confidence', code: 'invalid_value' }],
    ],
    [
      'a hypothesis moved into the observed list',
      { observed: [MINIMAL_HYPOTHESIS] },
      [{ path: 'observed.0', code: 'unrecognized_keys' }],
    ],
    [
      'an unevidenced observed fact',
      { observed: [{ statement: 'Prose with nothing to cite.', evidence: [] }] },
      [{ path: 'observed.0.evidence', code: 'too_small' }],
    ],
    [
      'a bare string summary',
      'Everything is slow.',
      [{ path: '', code: 'invalid_type', expected: 'object' }],
    ],
  ])('rejects %s', (_label, value, issues) => {
    const parsed = panelSummarySchema.safeParse(value);

    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : describeIssues(parsed.error.issues)).toStrictEqual(issues);
  });
});
