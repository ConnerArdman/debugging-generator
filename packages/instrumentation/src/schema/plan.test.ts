/**
 * Tests for `./plan.ts`: the instrumentation plan contract, and the identity
 * key the whole reversible-instrumentation path is addressed by.
 *
 * Three contracts are on trial here, and each one fails silently in production
 * if it fails at all.
 *
 * 1. **The authoring schema is the agreement with the author.** AAP §0.1.2's
 *    example is what a model — and a human writing a plan by hand — produces,
 *    and it must parse *as written*, with no field the example omits becoming
 *    required and no value rewritten on the way through. A schema that drifted
 *    stricter would turn every planning stage into two wasted repair rounds
 *    followed by a fallback plan, with nothing in the logs but "the model got
 *    it wrong".
 *
 * 2. **Normalisation is deterministic and never throws.** AAP §0.5.3 puts a
 *    normalisation failure on the *product bug* side of the line: it is logged
 *    with its input and never retried against the model. A thrown exception
 *    would be that same unretryable failure expressed as control flow in a call
 *    the service cannot usefully wrap, so every failure has to come back as a
 *    value — and the same input with the same injected id factory has to
 *    produce the same plan, which is what makes a stored plan reproducible.
 *
 * 3. **`actionIdentityKey` is injective.** This is the assertion that earns
 *    this file its length. The key answers "is this the same action as the one
 *    already installed?" for three consumers — id reuse here, the installer's
 *    delta match, the feasibility gate's duplicate report — and the schemas
 *    above permit `'|'`, `':'` and every other printable character inside both
 *    `file` and `symbol`. Joining the components with a separator therefore
 *    gives two genuinely different actions one key, and every consumer
 *    mis-associates: an action that survived a follow-up loses its id and gets
 *    patched a second time on a file the journal already records as
 *    instrumented, or a brand-new action inherits an installed action's id and
 *    is skipped. AAP §0.4.2's modification chain — the one cleanup restores in
 *    strictly reverse order, verifying a hash at each step — hangs off those
 *    ids, so a collision is a developer's file that does not come back. The
 *    suites below pin the property (distinct triples ⇒ distinct keys) *and*
 *    keep a local copy of the separator-joined encoding that used to be here,
 *    so each regression states the collision it prevents rather than merely
 *    asserting two strings differ.
 *
 * Two conventions in here are deliberate.
 *
 * - **Nothing is asserted about a message's prose.** A failure is checked by
 *   its code, its field path and the presence of a hint — the parts AAP §0.5.5
 *   makes contractual — so rewording an error does not fail a test, while
 *   losing its recovery path does.
 * - **Every adapter id and every path outside the §0.1.2 example is invented.**
 *   Real adapter ids live in `../registry.ts` and are not this file's business,
 *   and a neutral path keeps the collision tables readable.
 *
 * One AAP §0.5.4 nuance: the §0.1.2 example carries identifiers and a route
 * path that also exist in the demo application. `scripts/check-no-hardcoding.mjs`
 * scans product source *excluding test suites*, which is what makes those
 * strings acceptable in this file and nowhere else in the package. They appear
 * exactly once, in {@link AUTHORING_EXAMPLE}.
 */

import { describe, expect, it } from 'vitest';

import { DebuggenError, DEBUGGEN_ERROR_CODES } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';

import {
  ACTION_ID_PATTERN,
  INSTRUMENTATION_ACTION_TYPES,
  INSTRUMENTATION_PLAN_VERSION,
  actionIdentityKey,
  instrumentationPlanInputSchema,
  instrumentationPlanSchema,
  normalizePlan,
  parseInstrumentationPlanInput,
} from './plan.js';
import type {
  AdapterActionResolution,
  InstrumentationAction,
  InstrumentationActionType,
  InstrumentationPlan,
  NormalizePlanContext,
  PlanAdapterResolver,
} from './plan.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * AAP §0.1.2's authoring example, reproduced exactly as the plan states it.
 *
 * Typed `unknown` on purpose: the schema is what must accept this object, not
 * the compiler. It is the one place in this package where a demo-overlapping
 * identifier may appear (see the file comment's §0.5.4 note).
 */
const AUTHORING_EXAMPLE: unknown = {
  objective: 'Determine why clicking Checkout takes more than 2 seconds',
  capture: [
    'click event timing',
    'React renders',
    'fetch calls',
    'server request spans',
    'database query spans',
  ],
  instrumentationTargets: [
    {
      file: 'components/CheckoutButton.tsx',
      symbol: 'handleCheckout',
      type: 'function-timing',
    },
    {
      file: 'app/api/checkout/route.ts',
      symbol: 'POST',
      type: 'server-span',
    },
  ],
};

/** A session id of the shape `@debuggen/shared` mints, used by every context. */
const SESSION_ID = 'ses_0123456789abcdef';

/**
 * What the fake resolver answers for each action type.
 *
 * Both install modes are represented, because normalisation copies the mode
 * through untouched and a table covering only one of them would not notice a
 * transcription that dropped it. The ids are invented: the registry owns
 * adapter identity, and a third-party adapter may register at runtime, which is
 * exactly why the schema keeps `adapter` a bounded string.
 */
const ADAPTER_TABLE: Readonly<Record<InstrumentationActionType, AdapterActionResolution>> = {
  'function-timing': { adapter: 'fake-timing-adapter', mode: 'patch' },
  'server-span': { adapter: 'fake-server-adapter', mode: 'patch' },
  'react-render-tracking': { adapter: 'fake-render-adapter', mode: 'runtime' },
  'fetch-tracking': { adapter: 'fake-request-adapter', mode: 'runtime' },
  'db-query-tracking': { adapter: 'fake-query-adapter', mode: 'runtime' },
  'state-tracking': { adapter: 'fake-state-adapter', mode: 'runtime' },
  'interaction-tracking': { adapter: 'fake-interaction-adapter', mode: 'runtime' },
  'perf-tracking': { adapter: 'fake-perf-adapter', mode: 'runtime' },
};

/**
 * A structural {@link PlanAdapterResolver} over {@link ADAPTER_TABLE}.
 *
 * Structural is the point of the interface: nothing imports `../registry.ts`
 * here, so this suite exercises the same seam production does without the
 * module cycle that importing the registry into `schema/` would create.
 *
 * @param unclaimed Types the fake claims *not* to handle, so the
 * whole-plan-rejection path can be driven.
 */
function fakeResolver(unclaimed: readonly InstrumentationActionType[] = []): PlanAdapterResolver {
  return {
    resolveActionType(type: InstrumentationActionType): AdapterActionResolution | undefined {
      return unclaimed.includes(type) ? undefined : ADAPTER_TABLE[type];
    },
  };
}

/**
 * A deterministic id factory whose output matches {@link ACTION_ID_PATTERN}.
 *
 * Injected so an expected plan can be asserted exactly. Every call produces a
 * distinct id, which is the contract `normalizePlan` documents for the factory.
 */
function sequentialActionIds(): () => string {
  let minted = 0;

  return () => {
    minted += 1;
    return `act_${String(minted).padStart(16, '0')}`;
  };
}

/** The first `count` ids {@link sequentialActionIds} produces, in order. */
function mintedIds(count: number): string[] {
  const next = sequentialActionIds();
  return Array.from({ length: count }, () => next());
}

/**
 * A {@link NormalizePlanContext} with every field defaulted, so a test names
 * only the part it is about.
 */
function planContext(
  overrides: {
    readonly sessionId?: string;
    readonly planVersion?: number;
    readonly resolver?: PlanAdapterResolver;
    readonly previousActions?: readonly InstrumentationAction[];
    readonly newActionId?: (() => string) | undefined;
  } = {},
): NormalizePlanContext {
  return {
    sessionId: overrides.sessionId ?? SESSION_ID,
    planVersion: overrides.planVersion ?? 1,
    resolver: overrides.resolver ?? fakeResolver(),
    previousActions: overrides.previousActions,
    newActionId: 'newActionId' in overrides ? overrides.newActionId : sequentialActionIds(),
  };
}

/** An authored plan carrying exactly the given targets. */
function planInputWith(
  targets: readonly unknown[],
  objective = 'Find where the time goes',
): unknown {
  return {
    objective,
    capture: ['interaction timing'],
    instrumentationTargets: targets,
  };
}

/** A resolved action, for use as a previous plan version's entry. */
function previousAction(
  id: string,
  file: string,
  symbol: string,
  type: InstrumentationActionType = 'function-timing',
): InstrumentationAction {
  return {
    id,
    file,
    symbol,
    type,
    adapter: ADAPTER_TABLE[type].adapter,
    mode: ADAPTER_TABLE[type].mode,
    rationale: 'Carried over from the previous plan version.',
  };
}

/**
 * The value of a successful `Result`, or a failure naming the error that
 * arrived instead.
 */
function okValue<T>(result: Result<T, DebuggenError>, what: string): T {
  if (!result.ok) {
    throw new Error(
      `${what} was expected to succeed, but failed with ${result.error.code}: ${result.error.message}`,
    );
  }

  return result.value;
}

/**
 * The `Result` an outcome carries, or a failure reporting that the call threw.
 *
 * Separating "threw" from "returned a failure" is the point: both look like a
 * red test, and only one of them is the AAP §0.5.3 violation.
 */
function notThrown<T>(
  outcome: Result<T, DebuggenError> | 'threw',
  what: string,
): Result<T, DebuggenError> {
  if (outcome === 'threw') {
    throw new Error(`${what} threw instead of returning a failure value.`);
  }

  return outcome;
}

/** The error of a failed `Result`, or a failure saying the call succeeded. */
function errValue<T>(result: Result<T, DebuggenError>, what: string): DebuggenError {
  if (result.ok) {
    throw new Error(`${what} was expected to fail, but succeeded.`);
  }

  return result.error;
}

/**
 * Whether a string carries a control character.
 *
 * Spelled with char codes rather than a regular expression because a literal
 * control character inside a pattern is itself a lint error — and because this
 * is the same test the module under test applies to a path and a symbol.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }

  return false;
}

/** The ids of a normalised plan's actions, in order. */
function actionIds(plan: InstrumentationPlan): string[] {
  return plan.instrumentationTargets.map((action) => action.id);
}

/**
 * The outcome of a normalisation, with a thrown exception turned into a
 * distinct value.
 *
 * AAP §0.5.3 makes a normalisation failure unretryable, so the service has to
 * receive it as a value it can log and fall back from. That makes "did it
 * throw?" a contractual question, and this helper is how the suites below ask
 * it without a mutable binding the compiler cannot prove was assigned.
 */
function normalizeOutcome(
  input: unknown,
  context: NormalizePlanContext,
): Result<InstrumentationPlan, DebuggenError> | 'threw' {
  try {
    return normalizePlan(input, context);
  } catch {
    return 'threw';
  }
}

/**
 * The separator-joined encoding `actionIdentityKey` used to have.
 *
 * Kept here, and only here, so every collision case below can state what it
 * protects: the pairs in {@link COLLIDING_PAIRS} are exactly the pairs this
 * function maps onto one string. It is never the expected value of anything.
 */
function separatorJoinedKey(target: {
  readonly file: string;
  readonly symbol: string;
  readonly type: InstrumentationActionType;
}): string {
  return `${target.file}|${target.symbol}|${target.type}`;
}

/** One identity triple, as the key helper accepts it. */
interface IdentityTriple {
  readonly file: string;
  readonly symbol: string;
  readonly type: InstrumentationActionType;
}

/**
 * Pairs of distinct, schema-valid triples that the separator-joined encoding
 * collapsed onto a single key.
 *
 * Every pair moves a `'|'` across a component boundary, which is the whole
 * family of collisions a single-character separator admits: the type is drawn
 * from a closed vocabulary that contains no `'|'`, so a colliding pair always
 * shares its type and differs only in where the `file`/`symbol` boundary falls.
 */
const COLLIDING_PAIRS: readonly {
  readonly label: string;
  readonly left: IdentityTriple;
  readonly right: IdentityTriple;
}[] = [
  {
    label: 'the boundary moves one segment into the symbol',
    left: { file: 'src/a|b.ts', symbol: 'x', type: 'function-timing' },
    right: { file: 'src/a', symbol: 'b.ts|x', type: 'function-timing' },
  },
  {
    label: 'a directory separator in one path is a pipe in the other',
    left: { file: 'src|a.ts', symbol: 'x', type: 'server-span' },
    right: { file: 'src', symbol: 'a.ts|x', type: 'server-span' },
  },
  {
    label: 'the whole file name migrates into the symbol',
    left: { file: 'a|b|c.ts', symbol: 'run', type: 'db-query-tracking' },
    right: { file: 'a', symbol: 'b|c.ts|run', type: 'db-query-tracking' },
  },
  {
    label: 'the components carry digits and colons of their own',
    left: { file: '12:a.ts|handler', symbol: '7', type: 'perf-tracking' },
    right: { file: '12:a.ts', symbol: 'handler|7', type: 'perf-tracking' },
  },
];

/**
 * Components chosen to stress the encoding, for the injectivity sweep.
 *
 * `'src'`, `'src/a'`, `'src/a|b.ts'` and `'src|a.ts'` are in here together on
 * purpose: combined with the symbols below they give the corpus two families of
 * separator-joined collision (`('src/a|b.ts', 'x')` against
 * `('src/a', 'b.ts|x')`, and `('src|a.ts', 'x')` against `('src', 'a.ts|x')`),
 * which is what {@link SWEEP_SEPARATOR_COLLISION_FAMILIES} counts.
 */
const SWEEP_FILES: readonly string[] = [
  'a',
  'a.ts',
  'src',
  'src/a',
  'src/a.ts',
  'src/a|b.ts',
  'src|a.ts',
  'a|b|c.ts',
  '1:a.ts',
  '12',
  '12:a',
  'src/1:2',
  'caf\u00e9|x.ts',
  // A path carrying a surrogate pair, so the length prefix's unit — UTF-16
  // code units, which is what `String.prototype.length` counts and what a
  // slice of the same string would take — is exercised rather than assumed.
  '\ud834\udd1e|x.ts',
];

/** Symbols chosen to stress the encoding, for the injectivity sweep. */
const SWEEP_SYMBOLS: readonly string[] = [
  'x',
  'x|y',
  'a.ts|x',
  'b.ts|x',
  '5:x',
  '12',
  'POST',
  'handle|Click',
];

/**
 * How many `(file, symbol)` boundary-shift pairs the sweep corpus contains.
 *
 * Each family collides once per action type under a separator-joined encoding,
 * so the corpus is expected to lose exactly
 * `families × INSTRUMENTATION_ACTION_TYPES.length` keys to that encoding — and
 * none at all to the one in use. Stated as a number rather than derived, so
 * adding or removing a colliding component to the corpus fails the sweep and
 * has to be accounted for here.
 */
const SWEEP_SEPARATOR_COLLISION_FAMILIES = 2;

/**
 * Authored plans the schema must refuse, each labelled with the rule it breaks.
 *
 * Typed rather than inferred so the table can hold values of unrelated shapes —
 * which is the point of it — without the case parameter widening into a union
 * the schema call cannot accept.
 */
const REJECTED_INPUTS: readonly (readonly [string, unknown])[] = [
  ['an unknown action type', planInputWith([{ file: 'a.ts', symbol: 'x', type: 'guesswork' }])],
  ['a blank symbol', planInputWith([{ file: 'a.ts', symbol: '   ', type: 'function-timing' }])],
  [
    'a symbol carrying a line break',
    planInputWith([{ file: 'a.ts', symbol: 'x\ny', type: 'function-timing' }]),
  ],
  ['an empty objective', planInputWith([{ file: 'a.ts', symbol: 'x', type: 'perf-tracking' }], '')],
  [
    'an over-long capture phrase',
    {
      objective: 'Find where the time goes',
      capture: ['c'.repeat(161)],
      instrumentationTargets: [],
    },
  ],
  [
    'an over-long hypothesis',
    {
      objective: 'Find where the time goes',
      capture: [],
      instrumentationTargets: [],
      hypotheses: ['h'.repeat(501)],
    },
  ],
  [
    'an unknown key at the top level',
    {
      objective: 'Find where the time goes',
      capture: [],
      instrumentationTargets: [],
      budgetMs: 1000,
    },
  ],
  [
    'an unknown key inside a target',
    planInputWith([{ file: 'a.ts', symbol: 'x', type: 'function-timing', adapter: 'chosen' }]),
  ],
  [
    'capture given as a string',
    { objective: 'Find where the time goes', capture: 'everything', instrumentationTargets: [] },
  ],
  [
    'instrumentationTargets given as an object',
    {
      objective: 'Find where the time goes',
      capture: [],
      instrumentationTargets: { file: 'a.ts', symbol: 'x', type: 'function-timing' },
    },
  ],
];

/** Inputs normalisation must refuse as a value, without throwing. */
const HOSTILE_INPUTS: readonly (readonly [string, unknown])[] = [
  ['undefined', undefined],
  ['null', null],
  ['a string', 'instrument everything'],
  ['an array', []],
  ['an object with no plan fields', { note: 'nothing here' }],
  ['a plan whose targets are not objects', planInputWith(['src/a.ts'])],
];

/** Contexts normalisation must refuse, each labelled with the field at fault. */
const INVALID_CONTEXTS: readonly (readonly [
  string,
  { readonly sessionId?: string; readonly planVersion?: number },
])[] = [
  ['an empty sessionId', { sessionId: '' }],
  ['a whitespace sessionId', { sessionId: '   ' }],
  ['a planVersion of 0', { planVersion: 0 }],
  ['a negative planVersion', { planVersion: -1 }],
  ['a fractional planVersion', { planVersion: 1.5 }],
];

// ---------------------------------------------------------------------------
// The authoring schema
// ---------------------------------------------------------------------------

describe('instrumentationPlanInputSchema', () => {
  it('accepts the AAP authoring example verbatim, and returns it unchanged', () => {
    const parsed = instrumentationPlanInputSchema.safeParse(AUTHORING_EXAMPLE);

    expect(parsed.success).toBe(true);
    // Deep equality with the input is the assertion that no `.transform()`,
    // `.default()` or coercion crept in: normalisation is `normalizePlan`'s
    // job, and a schema that rewrote a value would make a repair prompt quote
    // a field the author never wrote.
    expect(parsed.success ? parsed.data : undefined).toEqual(AUTHORING_EXAMPLE);
  });

  it('accepts the authoring example through the Result-returning parser', () => {
    const plan = okValue(parseInstrumentationPlanInput(AUTHORING_EXAMPLE), 'the authoring example');

    expect(plan.instrumentationTargets).toHaveLength(2);
    // The example omits both optional fields, so their absence is part of the
    // contract rather than an accident of how it was written.
    expect(plan.hypotheses).toBeUndefined();
    expect(plan.instrumentationTargets.map((target) => target.rationale)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('declares the eight action types in the order the AAP states them', () => {
    expect(INSTRUMENTATION_ACTION_TYPES).toEqual([
      'function-timing',
      'server-span',
      'react-render-tracking',
      'fetch-tracking',
      'db-query-tracking',
      'state-tracking',
      'interaction-tracking',
      'perf-tracking',
    ]);
  });

  it.each(INSTRUMENTATION_ACTION_TYPES)('accepts a target of type %s', (type) => {
    const parsed = instrumentationPlanInputSchema.safeParse(
      planInputWith([{ file: 'src/module.ts', symbol: 'run', type }]),
    );

    expect(parsed.success).toBe(true);
  });

  it.each(REJECTED_INPUTS)('rejects %s', (_label, input) => {
    expect(instrumentationPlanInputSchema.safeParse(input).success).toBe(false);
    expect(parseInstrumentationPlanInput(input).ok).toBe(false);
  });

  it.each([
    ['a cosmetic leading "./"', './src/module.ts'],
    ['Windows-flavoured separators', 'src\\lib\\module.ts'],
    ['a nested directory path', 'src/lib/nested/deep/module.ts'],
    ['a non-ASCII file name', 'src/caf\u00e9.ts'],
    ['the project root itself', '.'],
    ['an interior ".." that resolves back inside', 'src/lib/../module.ts'],
  ])('accepts %s as an authored path', (_label, file) => {
    expect(
      instrumentationPlanInputSchema.safeParse(
        planInputWith([{ file, symbol: 'run', type: 'function-timing' }]),
      ).success,
    ).toBe(true);
  });

  it.each([
    ['a POSIX-absolute path', '/etc/module.ts'],
    ['a Windows drive path', 'C:\\project\\module.ts'],
    ['a UNC path', '\\\\host\\share\\module.ts'],
    ['a path escaping the project', '../outside/module.ts'],
    ['an empty path', ''],
    ['a path carrying NUL', 'src/mod\u0000ule.ts'],
  ])('rejects %s as an authored path', (_label, file) => {
    expect(
      instrumentationPlanInputSchema.safeParse(
        planInputWith([{ file, symbol: 'run', type: 'function-timing' }]),
      ).success,
    ).toBe(false);
  });

  it('reports a rejection without echoing the rejected value', () => {
    // Assembled at runtime so the token cannot be matched by a reader of this
    // file, and so a secret-shaped literal never appears in the source.
    const token = ['zq', 'x', '7', 'tk'].join('');
    const error = errValue(
      parseInstrumentationPlanInput({
        objective: token.repeat(200),
        capture: [],
        instrumentationTargets: [],
      }),
      'an over-long objective',
    );

    expect(error.code).toBe('MODEL_OUTPUT_INVALID');
    expect(error.message).not.toContain(token);
    expect(JSON.stringify(error.toPayload())).not.toContain(token);
    expect(error.message).toContain('objective');
    expect(error.hint).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// actionIdentityKey — the property the three consumers depend on
// ---------------------------------------------------------------------------

describe('actionIdentityKey', () => {
  it('gives one triple one key, however many times it is asked', () => {
    const triple: IdentityTriple = {
      file: 'src/module.ts',
      symbol: 'run',
      type: 'function-timing',
    };

    expect(actionIdentityKey(triple)).toBe(actionIdentityKey({ ...triple }));
    expect(actionIdentityKey(triple)).toBe(actionIdentityKey(triple));
  });

  it('reads the identity from exactly the three components, and nothing else', () => {
    const base = previousAction('act_0000000000000001', 'src/module.ts', 'run');
    const reworded: InstrumentationAction = {
      ...base,
      id: 'act_0000000000000002',
      rationale: 'Reworded during a follow-up, which must not change identity.',
    };

    // A follow-up may legitimately re-explain an action, and the adapter and
    // mode are derived from the type: an action that was merely re-explained
    // must not look new, or the installer patches an instrumented file again.
    expect(actionIdentityKey(reworded)).toBe(actionIdentityKey(base));
  });

  it('distinguishes a change in any one component', () => {
    const base: IdentityTriple = { file: 'src/module.ts', symbol: 'run', type: 'function-timing' };
    const keys = new Set([
      actionIdentityKey(base),
      actionIdentityKey({ ...base, file: 'src/other.ts' }),
      actionIdentityKey({ ...base, symbol: 'runOther' }),
      actionIdentityKey({ ...base, type: 'server-span' }),
    ]);

    expect(keys.size).toBe(4);
  });

  it.each(COLLIDING_PAIRS)('keeps two distinct actions distinct when $label', ({ left, right }) => {
    // The regression stated twice: the separator-joined encoding produced one
    // key for these two actions, and the encoding in use must not.
    expect(separatorJoinedKey(left)).toBe(separatorJoinedKey(right));
    expect(actionIdentityKey(left)).not.toBe(actionIdentityKey(right));
  });

  it.each(COLLIDING_PAIRS)(
    'accepts both halves of the $label pair as valid plans',
    ({ left, right }) => {
      // The collision matters because both triples are representable: each half
      // passes the authoring schema and survives normalisation into a plan the
      // internal schema accepts. A pair that could not exist would not be worth
      // a regression.
      for (const triple of [left, right]) {
        const plan = okValue(
          normalizePlan(planInputWith([triple]), planContext()),
          `a plan targeting ${triple.symbol}`,
        );

        expect(plan.instrumentationTargets.map((action) => [action.file, action.symbol])).toEqual([
          [triple.file, triple.symbol],
        ]);
      }
    },
  );

  it('maps every distinct triple of a delimiter-heavy corpus to a distinct key', () => {
    const triples: IdentityTriple[] = [];
    for (const file of SWEEP_FILES) {
      for (const symbol of SWEEP_SYMBOLS) {
        for (const type of INSTRUMENTATION_ACTION_TYPES) {
          triples.push({ file, symbol, type });
        }
      }
    }

    const keys = new Set(triples.map((triple) => actionIdentityKey(triple)));

    expect(triples).toHaveLength(
      SWEEP_FILES.length * SWEEP_SYMBOLS.length * INSTRUMENTATION_ACTION_TYPES.length,
    );
    expect(keys.size).toBe(triples.length);

    // And the same corpus under the separator-joined encoding, so the sweep
    // records that this property genuinely failed before rather than asserting
    // something that was always true.
    const joined = new Set(triples.map((triple) => separatorJoinedKey(triple)));
    expect(joined.size).toBe(
      triples.length - SWEEP_SEPARATOR_COLLISION_FAMILIES * INSTRUMENTATION_ACTION_TYPES.length,
    );
  });

  it('produces a non-empty key that is safe to name in a log line', () => {
    const keys = COLLIDING_PAIRS.flatMap(({ left, right }) => [
      actionIdentityKey(left),
      actionIdentityKey(right),
    ]);

    expect(keys.filter((key) => key.length === 0)).toEqual([]);
    // Both schemas refuse control characters in a path and in a symbol, so no
    // key built from a validated action can carry one either — which is what
    // makes a key safe to name in a log line or an error detail.
    expect(keys.filter(hasControlCharacter)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizePlan — adapters, modes, rationales and identity
// ---------------------------------------------------------------------------

describe('normalizePlan', () => {
  it('assigns the adapter and mode the resolver reports, per target, in authored order', () => {
    const plan = okValue(normalizePlan(AUTHORING_EXAMPLE, planContext()), 'the authoring example');

    expect(plan.instrumentationTargets).toEqual([
      {
        id: 'act_0000000000000001',
        file: 'components/CheckoutButton.tsx',
        symbol: 'handleCheckout',
        type: 'function-timing',
        adapter: 'fake-timing-adapter',
        mode: 'patch',
        rationale: 'Determine why clicking Checkout takes more than 2 seconds',
      },
      {
        id: 'act_0000000000000002',
        file: 'app/api/checkout/route.ts',
        symbol: 'POST',
        type: 'server-span',
        adapter: 'fake-server-adapter',
        mode: 'patch',
        rationale: 'Determine why clicking Checkout takes more than 2 seconds',
      },
    ]);
  });

  it('carries a runtime-mode resolution through as well', () => {
    const plan = okValue(
      normalizePlan(
        planInputWith([{ file: '.', symbol: 'document', type: 'react-render-tracking' }]),
        planContext(),
      ),
      'a runtime-mode plan',
    );

    expect(plan.instrumentationTargets.map((action) => [action.adapter, action.mode])).toEqual([
      ['fake-render-adapter', 'runtime'],
    ]);
  });

  it('normalises each path into its own normal form before anything reads it', () => {
    const plan = okValue(
      normalizePlan(
        planInputWith([
          { file: './src/./lib/module.ts', symbol: 'run', type: 'function-timing' },
          { file: 'src\\lib\\other.ts', symbol: 'run', type: 'function-timing' },
        ]),
        planContext(),
      ),
      'a plan with cosmetic paths',
    );

    expect(plan.instrumentationTargets.map((action) => action.file)).toEqual([
      'src/lib/module.ts',
      'src/lib/other.ts',
    ]);
  });

  it('fills a missing rationale from the objective and keeps a stated one, trimmed', () => {
    const plan = okValue(
      normalizePlan(
        {
          objective: '  Find where the time goes  ',
          capture: [],
          instrumentationTargets: [
            { file: 'src/a.ts', symbol: 'run', type: 'function-timing' },
            {
              file: 'src/b.ts',
              symbol: 'run',
              type: 'function-timing',
              rationale: '  Times the slowest step.  ',
            },
          ],
        },
        planContext(),
      ),
      'a plan with one stated rationale',
    );

    expect(plan.instrumentationTargets.map((action) => action.rationale)).toEqual([
      'Find where the time goes',
      'Times the slowest step.',
    ]);
    // The objective itself is carried through byte-faithfully; only the
    // rationale derived from it is trimmed.
    expect(plan.objective).toBe('  Find where the time goes  ');
  });

  it('mints ids of the shape the store keys records by when no factory is injected', () => {
    const plan = okValue(
      normalizePlan(AUTHORING_EXAMPLE, planContext({ newActionId: undefined })),
      'the authoring example with the default id factory',
    );
    const ids = actionIds(plan);

    expect(ids.filter((id) => !ACTION_ID_PATTERN.test(id))).toEqual([]);
    expect(ids.filter((id) => !id.startsWith('act_'))).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe('identity-based id reuse across plan versions', () => {
    it("reuses a surviving action's id, matching on the normalised path", () => {
      const plan = okValue(
        normalizePlan(
          planInputWith([{ file: './src/module.ts', symbol: 'run', type: 'function-timing' }]),
          planContext({
            planVersion: 2,
            previousActions: [previousAction('act_prevaction000001', 'src/module.ts', 'run')],
          }),
        ),
        'a follow-up plan',
      );

      // AAP §0.4.2: a follow-up delta addresses actions by id, so an action
      // that survives keeps the id the installer, the store and every
      // modification record already know it by.
      expect(actionIds(plan)).toEqual(['act_prevaction000001']);
      expect(plan.planVersion).toBe(2);
    });

    it('matches one previous action to one new action, so duplicates do not collapse', () => {
      const target = { file: 'src/module.ts', symbol: 'run', type: 'function-timing' };
      const plan = okValue(
        normalizePlan(
          planInputWith([target, target]),
          planContext({
            planVersion: 2,
            previousActions: [
              previousAction('act_prevaction000001', 'src/module.ts', 'run'),
              previousAction('act_prevaction000002', 'src/module.ts', 'run'),
            ],
          }),
        ),
        'a follow-up plan with two identical targets',
      );

      expect(actionIds(plan)).toEqual(['act_prevaction000001', 'act_prevaction000002']);
    });

    it('mints a fresh id for the duplicate a previous version cannot account for', () => {
      const target = { file: 'src/module.ts', symbol: 'run', type: 'function-timing' };
      const plan = okValue(
        normalizePlan(
          planInputWith([target, target]),
          planContext({
            planVersion: 2,
            previousActions: [previousAction('act_prevaction000001', 'src/module.ts', 'run')],
          }),
        ),
        'a follow-up plan with one previous action',
      );

      expect(actionIds(plan)).toEqual(['act_prevaction000001', mintedIds(1)[0]]);
    });

    it('does not hand a previous id to an action that merely collides with it', () => {
      const previous = previousAction('act_prevaction000001', 'src/a|b.ts', 'x');
      const plan = okValue(
        normalizePlan(
          // A different action: the same characters, split differently across
          // the file/symbol boundary. The separator-joined encoding gave the
          // two one key, so this target used to inherit the installed action's
          // id — and the installer, reading it as already applied, would have
          // skipped instrumenting it entirely.
          planInputWith([{ file: 'src/a', symbol: 'b.ts|x', type: 'function-timing' }]),
          planContext({ planVersion: 2, previousActions: [previous] }),
        ),
        'a follow-up plan naming a colliding action',
      );

      expect(separatorJoinedKey(previous)).toBe(
        separatorJoinedKey({ file: 'src/a', symbol: 'b.ts|x', type: 'function-timing' }),
      );
      expect(actionIds(plan)).toEqual(mintedIds(1));
      expect(actionIds(plan)).not.toContain(previous.id);
    });

    it('keeps each of two colliding actions with the id it was installed under', () => {
      const previousLeft = previousAction('act_prevaction000001', 'src/a', 'b.ts|x');
      const previousRight = previousAction('act_prevaction000002', 'src/a|b.ts', 'x');

      const plan = okValue(
        normalizePlan(
          planInputWith([
            { file: 'src/a|b.ts', symbol: 'x', type: 'function-timing' },
            { file: 'src/a', symbol: 'b.ts|x', type: 'function-timing' },
          ]),
          planContext({
            planVersion: 2,
            previousActions: [previousLeft, previousRight],
          }),
        ),
        'a follow-up plan carrying both halves of a colliding pair',
      );

      // Under the separator-joined encoding both previous actions landed in one
      // queue and were consumed in arrival order, so each target inherited the
      // *other* action's id — and cleanup would then have restored two
      // modification chains against the wrong files.
      expect(actionIds(plan)).toEqual([previousRight.id, previousLeft.id]);
      expect(actionIds(plan)).not.toEqual([previousLeft.id, previousRight.id]);
    });

    it('does not reuse an id across a change of action type', () => {
      const plan = okValue(
        normalizePlan(
          planInputWith([{ file: 'src/module.ts', symbol: 'run', type: 'server-span' }]),
          planContext({
            planVersion: 2,
            previousActions: [
              previousAction('act_prevaction000001', 'src/module.ts', 'run', 'function-timing'),
            ],
          }),
        ),
        'a follow-up plan changing the action type',
      );

      expect(actionIds(plan)).toEqual(mintedIds(1));
    });

    it('refuses a malformed previous action rather than losing its id silently', () => {
      const error = errValue(
        normalizePlan(
          planInputWith([{ file: 'src/module.ts', symbol: 'run', type: 'function-timing' }]),
          planContext({
            planVersion: 2,
            previousActions: [
              { file: 'src/module.ts', symbol: 'run', type: 'function-timing' },
            ] as unknown as readonly InstrumentationAction[],
          }),
        ),
        'a follow-up plan with an id-less previous action',
      );

      expect(error.code).toBe('INTERNAL');
      expect(error.message).toContain('index 0');
      expect(error.hint).toBeDefined();
    });
  });

  it('neither deduplicates nor reorders targets', () => {
    const plan = okValue(
      normalizePlan(
        planInputWith([
          { file: 'src/b.ts', symbol: 'second', type: 'server-span' },
          { file: 'src/a.ts', symbol: 'first', type: 'function-timing' },
          { file: 'src/b.ts', symbol: 'second', type: 'server-span' },
        ]),
        planContext(),
      ),
      'a plan with a duplicate target',
    );

    // `../feasibility.ts` owns the duplicate-action rejection, so it has to be
    // able to see the duplicate; the installer relies on the authored order.
    expect(plan.instrumentationTargets.map((action) => action.symbol)).toEqual([
      'second',
      'first',
      'second',
    ]);
  });

  it('rejects the whole plan when no adapter claims an action type', () => {
    const error = errValue(
      normalizePlan(
        planInputWith([
          { file: 'src/a.ts', symbol: 'first', type: 'function-timing' },
          { file: 'src/b.ts', symbol: 'second', type: 'state-tracking' },
        ]),
        planContext({ resolver: fakeResolver(['state-tracking']) }),
      ),
      'a plan naming an unclaimed action type',
    );

    expect(DebuggenError.is(error)).toBe(true);
    expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
    expect(error.code).toBe('INSTRUMENTATION_UNAVAILABLE');
    expect(error.message).toContain('state-tracking');
    expect(error.message).toContain('target 1');
    expect(error.hint).toBeDefined();
    expect(error.details?.['targetIndex']).toBe(1);
  });

  it.each(HOSTILE_INPUTS)('returns a failure rather than throwing for %s', (label, input) => {
    // A throw and a returned failure both read as a red test, so the two are
    // distinguished: only the throw is the §0.5.3 violation, and only the
    // returned failure is something the service can log and fall back from.
    const outcome = notThrown(normalizeOutcome(input, planContext()), `normalising ${label}`);

    expect(outcome.ok).toBe(false);
  });

  it('returns a failure for an own __proto__ key instead of polluting anything', () => {
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":true},"objective":"Find where the time goes","capture":[],"instrumentationTargets":[]}',
    ) as unknown;

    const outcome = notThrown(
      normalizeOutcome(hostile, planContext()),
      'normalising a plan carrying an own __proto__ key',
    );
    const error = errValue(outcome, 'a plan carrying an own __proto__ key');

    expect(DebuggenError.is(error)).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('returns a failure when the caller-supplied resolver throws', () => {
    const error = errValue(
      normalizePlan(
        planInputWith([{ file: 'src/a.ts', symbol: 'run', type: 'function-timing' }]),
        planContext({
          resolver: {
            resolveActionType(): AdapterActionResolution | undefined {
              throw new Error('the registry is not available');
            },
          },
        }),
      ),
      'a plan normalised with a throwing resolver',
    );

    expect(error.code).toBe('INTERNAL');
    expect(error.hint).toBeDefined();
  });

  it.each(INVALID_CONTEXTS)('rejects a context with %s', (_label, overrides) => {
    const error = errValue(
      normalizePlan(AUTHORING_EXAMPLE, planContext(overrides)),
      'a plan normalised with an invalid context',
    );

    expect(error.code).toBe('INTERNAL');
    expect(error.hint).toBeDefined();
  });

  it('rejects a context with no adapter resolver', () => {
    const error = errValue(
      normalizePlan(AUTHORING_EXAMPLE, {
        sessionId: SESSION_ID,
        planVersion: 1,
      } as unknown as NormalizePlanContext),
      'a plan normalised without a resolver',
    );

    expect(error.code).toBe('INTERNAL');
  });

  it('stamps the plan shape, the session and the version, and carries prose through', () => {
    const plan = okValue(
      normalizePlan(
        {
          objective: 'Find where the time goes',
          capture: ['click event timing', 'server request spans'],
          instrumentationTargets: [{ file: 'src/a.ts', symbol: 'run', type: 'function-timing' }],
          hypotheses: ['The server call dominates.'],
        },
        planContext({ planVersion: 3 }),
      ),
      'a plan with hypotheses',
    );

    expect(instrumentationPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.version).toBe(INSTRUMENTATION_PLAN_VERSION);
    expect(plan.planVersion).toBe(3);
    expect(plan.sessionId).toBe(SESSION_ID);
    expect(plan.hypotheses).toEqual(['The server call dominates.']);
    // Capture phrases are prose for display: normalisation must not translate
    // them into signals, drop them or reorder them.
    expect(plan.capture).toEqual(['click event timing', 'server request spans']);
  });

  it('defaults an omitted hypothesis list to an empty array', () => {
    const plan = okValue(normalizePlan(AUTHORING_EXAMPLE, planContext()), 'the authoring example');

    expect(plan.hypotheses).toEqual([]);
  });

  it('is deterministic, leaves its input untouched, and survives a JSON round trip', () => {
    const input = Object.freeze({
      objective: 'Find where the time goes',
      capture: Object.freeze(['click event timing']),
      instrumentationTargets: Object.freeze([
        Object.freeze({ file: 'src/a.ts', symbol: 'run', type: 'function-timing' }),
      ]),
    });
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;

    const first = okValue(normalizePlan(input, planContext()), 'the first normalisation');
    const second = okValue(normalizePlan(input, planContext()), 'the second normalisation');
    const roundTripped = JSON.parse(JSON.stringify(first)) as unknown;

    expect(second).toEqual(first);
    expect(input).toEqual(snapshot);
    // The plan travels over a WebSocket and into a SQLite column, so nothing in
    // it may be a value JSON cannot carry.
    expect(roundTripped).toEqual(first);
  });
});
