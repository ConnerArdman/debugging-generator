/**
 * Colocated tests for `./state-machine.ts`, the explicit session transition
 * table and its guards.
 *
 * The table is pinned edge for edge against the specification (AAP §0.4.2,
 * §0.5.1, §0.5.5): the expected edge list below is the oracle, and every one of
 * the 121 ordered status pairs is driven through `transition` so that an edge
 * added or removed by accident fails here. The guards are pinned in every
 * combination of the evidence they read, and the two follow-up paths are walked
 * end to end.
 *
 * The two headline guarantees of AAP §0.5.5 each have a test named after them:
 * "generated requires a validated analysis and panel" and "failed can never
 * reach generated".
 *
 * Fixtures are synthetic and generic. The module under test is pure — it reads
 * no clock, performs no I/O and holds no state — so the suite needs no mock, no
 * setup and no teardown, and it touches no filesystem, network, database,
 * timer or random source. Nothing here names a symbol or route of any real
 * project, and nothing branches on question text (AAP §0.5.4): statuses,
 * stages and codes only, taken from the imported vocabularies rather than
 * restated wherever the test is not the oracle.
 */

import { describe, expect, it } from 'vitest';

import {
  PROGRESS_STAGES,
  SESSION_STATUSES,
  type AnalysisResult,
  type PanelSpec,
  type ProgressStage,
  type SessionStatus,
} from '@debuggen/protocol';
import { DEBUGGEN_ERROR_CODES, DebuggenError, isErr, isOk, type Result } from '@debuggen/shared';

import {
  SESSION_TRANSITIONS,
  SESSION_TRANSITION_ERROR_CODE,
  SESSION_TRANSITION_GUARDS,
  SESSION_TRANSITION_REFUSAL_REASONS,
  STAGE_STATUS,
  TERMINAL_SESSION_STATUSES,
  allowedTransitions,
  canTransition,
  isTerminalSessionStatus,
  retryTargetFor,
  statusForStage,
  transition,
  type EndedIsTerminalAndUniversallyReachable,
  type EveryStageStatusIsARetryTarget,
  type FailedNeverReachesGenerated,
  type GeneratedOnlyFromAnalyzing,
  type GuardedEdgesCoverGeneratedAndFailed,
  type SessionFailure,
  type SessionTransitionContext,
} from './state-machine.js';

// ---------------------------------------------------------------------------
// The oracle: the specified edges, and the specified guarded edges
// ---------------------------------------------------------------------------

/** Every permitted edge, exactly as the specification's table lists them. */
const EXPECTED_EDGES: readonly string[] = [
  'created->understanding',
  'created->ended',
  'created->failed',
  'understanding->investigating',
  'understanding->ended',
  'understanding->failed',
  'investigating->planning',
  'investigating->ended',
  'investigating->failed',
  'planning->instrumenting',
  'planning->ended',
  'planning->failed',
  'instrumenting->ready',
  'instrumenting->ended',
  'instrumenting->failed',
  'ready->capturing',
  'ready->ended',
  'ready->failed',
  'capturing->analyzing',
  'capturing->ready',
  'capturing->ended',
  'capturing->failed',
  'analyzing->generated',
  'analyzing->ended',
  'analyzing->failed',
  'generated->analyzing',
  'generated->planning',
  'generated->ended',
  'generated->failed',
  'failed->understanding',
  'failed->investigating',
  'failed->planning',
  'failed->instrumenting',
  'failed->ready',
  'failed->capturing',
  'failed->analyzing',
  'failed->ended',
];

/** The edges that must carry a guard: A, B and every edge into `failed`. */
const EXPECTED_GUARDED_EDGES: readonly string[] = [
  'analyzing->generated',
  'instrumenting->ready',
  ...EXPECTED_EDGES.filter((edge) => edge.endsWith('->failed')),
];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The artifacts below are deliberately minimal cast test doubles, not real
// documents. The state machine asserts the *presence* of an already-validated
// `AnalysisResult` and `PanelSpec` (guard A); validating their internals is the
// job of the producers — `packages/protocol/src/analysis.ts` for the analysis,
// `packages/panel-schema/src/{validate,semantic}.ts` for the panel — and a
// second copy of those checks here would only be a place for the two to
// disagree. A double is therefore exactly as good as a real artifact for this
// suite, and it keeps the suite free of randomness and of any dependency the
// module under test does not have.

/** Stands in for a validated analysis: guard A only asks whether one exists. */
function analysisDouble(): AnalysisResult {
  return {} as AnalysisResult;
}

/** Stands in for a validated, ordinary (model-authored) panel. */
function panelDouble(): PanelSpec {
  return {} as PanelSpec;
}

/**
 * Stands in for the deterministic fallback panel of AAP §0.5.3: the one double
 * whose content matters, because `meta.fallback === true` must still count as a
 * validated panel.
 */
function fallbackPanelDouble(): PanelSpec {
  return { meta: { fallback: true } } as PanelSpec;
}

const ANALYSIS = analysisDouble();
const PANEL = panelDouble();
const FALLBACK_PANEL = fallbackPanelDouble();

/** A well-formed failure for guard C. */
function failureAt(stage: ProgressStage): SessionFailure {
  return {
    stage,
    code: 'MODEL_UNAVAILABLE',
    message: 'The model provider could not be reached.',
    hint: 'Check the provider configuration, then retry.',
  };
}

/** A context that satisfies every guard, for walking edges where only the table matters. */
const FULL_CONTEXT: SessionTransitionContext = Object.freeze({
  analysis: ANALYSIS,
  panel: PANEL,
  readinessSatisfied: true,
  failure: failureAt('analyze'),
});

function edgeOf(from: SessionStatus, to: SessionStatus): string {
  return `${from}->${to}`;
}

/** Every ordered pair of statuses, including a status paired with itself. */
const ALL_PAIRS: readonly (readonly [SessionStatus, SessionStatus])[] = SESSION_STATUSES.flatMap(
  (from) => SESSION_STATUSES.map((to) => [from, to] as const),
);

/** The edges the table itself lists, spelled `"from->to"`, read from the module under test. */
const TABLE_EDGES: readonly string[] = SESSION_STATUSES.flatMap((from) =>
  allowedTransitions(from).map((to) => edgeOf(from, to)),
);

/** The edges the guard registry covers, read from the module under test. */
const GUARDED_EDGES: ReadonlySet<string> = new Set(Object.keys(SESSION_TRANSITION_GUARDS));

/**
 * Narrows a result to its error, failing the test when it succeeded, and
 * asserts the refusal is a genuine `DebuggenError` carrying a code from the
 * closed vocabulary — checked with `DebuggenError.is`, the supported guard,
 * rather than `instanceof`.
 */
function expectRefusal(result: Result<SessionStatus, DebuggenError>): DebuggenError {
  expect(isErr(result)).toBe(true);
  if (isOk(result)) {
    throw new Error(`expected a refusal, got ok(${result.value})`);
  }
  expect(DebuggenError.is(result.error)).toBe(true);
  expect(DEBUGGEN_ERROR_CODES).toContain(result.error.code);
  return result.error;
}

/**
 * Walks a path of statuses, asserting every step succeeds with its context and
 * threading the returned status into the next call. Returns every status
 * visited, starting with `start`.
 */
function walkPath(
  start: SessionStatus,
  steps: readonly (readonly [SessionStatus, SessionTransitionContext?])[],
): readonly SessionStatus[] {
  const visited: SessionStatus[] = [start];
  let current = start;
  for (const [to, context] of steps) {
    const result = transition(current, to, context);
    expect(isOk(result), `${edgeOf(current, to)} should be admitted`).toBe(true);
    if (!isOk(result)) {
      break;
    }
    expect(result.value).toBe(to);
    current = result.value;
    visited.push(current);
  }
  return visited;
}

/** {@link walkPath}, returning only the status the walk ends in. */
function walk(
  start: SessionStatus,
  steps: readonly (readonly [SessionStatus, SessionTransitionContext?])[],
): SessionStatus | undefined {
  return walkPath(start, steps).at(-1);
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

describe('SESSION_TRANSITIONS', () => {
  it('is keyed by exactly the protocol status vocabulary — no extras, no omissions', () => {
    const keys = Object.keys(SESSION_TRANSITIONS);
    expect(keys).toHaveLength(SESSION_STATUSES.length);
    // Every status has a row …
    for (const status of SESSION_STATUSES) {
      expect(keys, status).toContain(status);
    }
    // … and every row is a status.
    for (const key of keys) {
      expect(SESSION_STATUSES, key).toContain(key);
    }
    expect([...keys].sort()).toEqual([...SESSION_STATUSES].sort());
  });

  it('lists only statuses from the vocabulary as targets, without duplicates', () => {
    for (const from of SESSION_STATUSES) {
      const targets = SESSION_TRANSITIONS[from];
      expect(new Set(targets).size).toBe(targets.length);
      for (const to of targets) {
        expect(SESSION_STATUSES).toContain(to);
      }
    }
  });

  it('contains exactly the specified edges', () => {
    const actual = SESSION_STATUSES.flatMap((from) =>
      SESSION_TRANSITIONS[from].map((to) => edgeOf(from, to)),
    );
    expect([...actual].sort()).toEqual([...EXPECTED_EDGES].sort());
  });

  it('is frozen, table and edge lists alike', () => {
    expect(Object.isFrozen(SESSION_TRANSITIONS)).toBe(true);
    for (const from of SESSION_STATUSES) {
      expect(Object.isFrozen(SESSION_TRANSITIONS[from])).toBe(true);
    }
  });

  it('cannot be widened by mutating an edge list a caller was handed', () => {
    for (const from of SESSION_STATUSES) {
      const before = [...allowedTransitions(from)];
      const handed = allowedTransitions(from) as SessionStatus[];
      // ES modules run in strict mode, so writing to a frozen array throws.
      expect(() => handed.push('generated')).toThrow(TypeError);
      expect(allowedTransitions(from)).toEqual(before);
      expect(SESSION_TRANSITIONS[from]).toEqual(before);
    }
  });

  it('never permits a status to transition to itself', () => {
    for (const status of SESSION_STATUSES) {
      expect(SESSION_TRANSITIONS[status]).not.toContain(status);
      expect(allowedTransitions(status)).not.toContain(status);
    }
  });

  it('lets failed retry into exactly the stage-owning statuses, or end — never generated', () => {
    expect(new Set(SESSION_TRANSITIONS.failed)).toEqual(
      new Set<SessionStatus>([
        'understanding',
        'investigating',
        'planning',
        'instrumenting',
        'ready',
        'capturing',
        'analyzing',
        'ended',
      ]),
    );
    expect(SESSION_TRANSITIONS.failed).toHaveLength(8);
  });
});

describe('allowedTransitions', () => {
  it('returns the table row for every status', () => {
    for (const from of SESSION_STATUSES) {
      expect(allowedTransitions(from)).toEqual(SESSION_TRANSITIONS[from]);
    }
  });

  it('is total over the vocabulary: always an array, never undefined', () => {
    for (const from of SESSION_STATUSES) {
      const allowed = allowedTransitions(from);
      expect(allowed, from).toBeDefined();
      expect(Array.isArray(allowed), from).toBe(true);
    }
  });

  it('is total: an unknown or prototype-named status yields an empty, frozen list', () => {
    for (const bogus of ['archived', 'toString', '__proto__', 'constructor']) {
      const allowed = allowedTransitions(bogus as SessionStatus);
      expect(allowed).toEqual([]);
      expect(Object.isFrozen(allowed)).toBe(true);
    }
  });
});

describe('terminal statuses', () => {
  it('are derived from the table: exactly the statuses with no outgoing edge', () => {
    const expected = SESSION_STATUSES.filter((status) => SESSION_TRANSITIONS[status].length === 0);
    expect(TERMINAL_SESSION_STATUSES).toEqual(expected);
    expect(TERMINAL_SESSION_STATUSES).toEqual(['ended']);
    expect(Object.isFrozen(TERMINAL_SESSION_STATUSES)).toBe(true);
  });

  it('isTerminalSessionStatus agrees with the table and the terminal list for every status', () => {
    for (const status of SESSION_STATUSES) {
      expect(isTerminalSessionStatus(status), status).toBe(allowedTransitions(status).length === 0);
      expect(isTerminalSessionStatus(status), status).toBe(
        TERMINAL_SESSION_STATUSES.includes(status),
      );
    }
  });

  it('ended is terminal: no edge out of it, not even ended → ended', () => {
    expect(allowedTransitions('ended')).toEqual([]);
    // The machine itself refuses a repeated end. What makes a second
    // `POST /sessions/:id/end` safe is the session manager's idempotent
    // short-circuit for an already-ended session, which runs before this module
    // is consulted — not a self-edge here.
    const error = expectRefusal(transition('ended', 'ended'));
    expect(error.details).toMatchObject({ from: 'ended', to: 'ended', allowed: [] });
  });

  it('ended has no way out, even with a context that satisfies every guard', () => {
    for (const to of SESSION_STATUSES) {
      const error = expectRefusal(transition('ended', to, FULL_CONTEXT));
      expect(error.details).toMatchObject({
        from: 'ended',
        to,
        allowed: [],
        reason: 'not-permitted',
      });
    }
  });

  it('ended is reachable from every other status without any evidence (AAP §0.5.1)', () => {
    for (const from of SESSION_STATUSES) {
      if (from === 'ended') {
        continue;
      }
      const result = transition(from, 'ended');
      expect(isOk(result), from).toBe(true);
      expect(result).toEqual({ ok: true, value: 'ended' });
      expect(canTransition(from, 'ended'), from).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Every pair, and the shape of every refusal
// ---------------------------------------------------------------------------

/**
 * Calls `transition` for one pair, asserting it neither throws nor returns
 * anything but a well-formed `Result`: an `Ok` holding the requested status, or
 * an `Err` holding a genuine `DebuggenError`. Returns the result.
 */
function transitionWithoutThrowing(
  from: SessionStatus,
  to: SessionStatus,
  context?: SessionTransitionContext,
): Result<SessionStatus, DebuggenError> {
  expect(() => transition(from, to, context), edgeOf(from, to)).not.toThrow();
  // The module is pure, so calling it a second time to keep the value is
  // exactly equivalent to keeping the first call's result.
  const result = transition(from, to, context);
  expect(result, edgeOf(from, to)).toBeTypeOf('object');
  expect(typeof result.ok, edgeOf(from, to)).toBe('boolean');
  if (isOk(result)) {
    expect(result.value, edgeOf(from, to)).toBe(to);
  } else {
    expect(DebuggenError.is(result.error), edgeOf(from, to)).toBe(true);
  }
  return result;
}

/** The pairs that `transition` admits under `context`, spelled `"from->to"`, sorted. */
function admittedEdges(context?: SessionTransitionContext): string[] {
  return ALL_PAIRS.filter(([from, to]) => isOk(transitionWithoutThrowing(from, to, context)))
    .map(([from, to]) => edgeOf(from, to))
    .sort();
}

describe('transition over every ordered pair', () => {
  it('never throws, and with every guard satisfied admits exactly the table edges — no silent no-op', () => {
    const admitted = admittedEdges(FULL_CONTEXT);
    expect(admitted).toEqual([...TABLE_EDGES].sort());
    expect(admitted).toEqual([...EXPECTED_EDGES].sort());
  });

  it('never throws, and with no evidence admits exactly the unguarded table edges', () => {
    const unguarded = TABLE_EDGES.filter((edge) => !GUARDED_EDGES.has(edge)).sort();
    expect(admittedEdges()).toEqual(unguarded);
    expect(admittedEdges({})).toEqual(unguarded);
  });

  it('canTransition agrees with transition for every pair and every kind of context', () => {
    const contexts: readonly (SessionTransitionContext | undefined)[] = [
      undefined,
      {},
      FULL_CONTEXT,
      { analysis: ANALYSIS },
      { panel: FALLBACK_PANEL },
      { analysis: ANALYSIS, panel: FALLBACK_PANEL },
      { readinessSatisfied: false },
      { readinessSatisfied: true },
      { failure: failureAt('instrument') },
    ];
    for (const context of contexts) {
      for (const [from, to] of ALL_PAIRS) {
        expect(canTransition(from, to, context), edgeOf(from, to)).toBe(
          isOk(transition(from, to, context)),
        );
      }
    }
  });

  it('refuses structurally different illegal edges with a typed, coded, described error', () => {
    const illegal: readonly (readonly [SessionStatus, SessionStatus, string])[] = [
      ['created', 'capturing', 'a skip forward past the pipeline'],
      ['generated', 'understanding', 'a backward jump'],
      ['ended', 'created', 'an edge out of a terminal status'],
      ['failed', 'generated', 'a failure promoted straight to success'],
    ];
    for (const [from, to, label] of illegal) {
      const error = expectRefusal(transition(from, to, FULL_CONTEXT));
      expect(DebuggenError.is(error), label).toBe(true);
      expect(DEBUGGEN_ERROR_CODES, label).toContain(error.code);
      expect(error.code, label).toBe(SESSION_TRANSITION_ERROR_CODE);
      expect(error.details, label).toMatchObject({
        from,
        to,
        allowed: [...allowedTransitions(from)],
      });
    }
  });

  it('refuses every illegal pair with a typed, coded, fully described error', () => {
    for (const [from, to] of ALL_PAIRS) {
      if (EXPECTED_EDGES.includes(edgeOf(from, to))) {
        continue;
      }
      const error = expectRefusal(transition(from, to, FULL_CONTEXT));
      expect(DebuggenError.is(error)).toBe(true);
      expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
      expect(error.code).toBe(SESSION_TRANSITION_ERROR_CODE);
      expect(error.message).toContain(`"${from}"`);
      expect(error.message).toContain(`"${to}"`);
      expect(error.hint).toEqual(expect.any(String));
      expect(error.details).toEqual({
        from,
        to,
        allowed: [...allowedTransitions(from)],
        reason: 'not-permitted',
      });
    }
  });

  it('uses the session-lifecycle code from the closed vocabulary', () => {
    expect(DEBUGGEN_ERROR_CODES).toContain(SESSION_TRANSITION_ERROR_CODE);
    expect(SESSION_TRANSITION_ERROR_CODE).toBe('SESSION_INVALID_STATE');
  });

  it('never mutates the context it is given, whether it admits or refuses', () => {
    const contexts: readonly SessionTransitionContext[] = [
      {
        analysis: ANALYSIS,
        panel: FALLBACK_PANEL,
        readinessSatisfied: false,
        failure: failureAt('plan'),
      },
      { analysis: ANALYSIS, panel: PANEL, readinessSatisfied: true, failure: failureAt('cleanup') },
      { panel: PANEL },
      {},
    ];
    for (const context of contexts) {
      const snapshot = structuredClone(context);
      const keys = Object.keys(context);
      for (const [from, to] of ALL_PAIRS) {
        transition(from, to, context);
        canTransition(from, to, context);
      }
      expect(context).toEqual(snapshot);
      expect(Object.keys(context)).toEqual(keys);
    }
  });

  it('refuses values outside the vocabulary without throwing or echoing them', () => {
    const bogus = 'archived <script>' as SessionStatus;
    for (const [from, to] of [
      [bogus, 'ended'],
      ['ready', bogus],
      [bogus, bogus],
    ] as const) {
      const error = expectRefusal(transition(from, to, FULL_CONTEXT));
      expect(error.code).toBe(SESSION_TRANSITION_ERROR_CODE);
      expect(error.message).not.toContain('archived');
      expect(error.details).toMatchObject({ reason: 'unknown-status' });
      expect(canTransition(from, to, FULL_CONTEXT)).toBe(false);
    }
  });

  it('reports only reasons from the published refusal vocabulary', () => {
    const contexts: readonly SessionTransitionContext[] = [{}, FULL_CONTEXT];
    for (const [from, to] of ALL_PAIRS) {
      for (const context of contexts) {
        const result = transition(from, to, context);
        if (isErr(result)) {
          expect(SESSION_TRANSITION_REFUSAL_REASONS).toContain(result.error.details?.['reason']);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The guard registry
// ---------------------------------------------------------------------------

describe('SESSION_TRANSITION_GUARDS', () => {
  it('guards exactly the specified edges', () => {
    expect(Object.keys(SESSION_TRANSITION_GUARDS).sort()).toEqual(
      [...EXPECTED_GUARDED_EDGES].sort(),
    );
  });

  it('guards only edges the table has', () => {
    for (const edge of Object.keys(SESSION_TRANSITION_GUARDS)) {
      expect(EXPECTED_EDGES).toContain(edge);
      expect(TABLE_EDGES).toContain(edge);
    }
  });

  it('guards every edge into generated and every edge into failed', () => {
    for (const edge of TABLE_EDGES) {
      if (edge.endsWith('->generated') || edge.endsWith('->failed')) {
        expect(GUARDED_EDGES.has(edge), edge).toBe(true);
      }
    }
  });

  it('leaves every unguarded edge open with no context at all', () => {
    for (const edge of EXPECTED_EDGES) {
      if (EXPECTED_GUARDED_EDGES.includes(edge)) {
        continue;
      }
      const [from, to] = edge.split('->') as [SessionStatus, SessionStatus];
      expect(transition(from, to), edge).toEqual({ ok: true, value: to });
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(SESSION_TRANSITION_GUARDS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard A — generated
// ---------------------------------------------------------------------------

describe('guard A: generated requires a validated analysis and panel (AAP §0.5.5)', () => {
  it('generated requires a validated analysis and panel: the full truth table from analyzing', () => {
    const artifacts = ['analysis', 'panel'] as const;
    const cases: readonly [SessionTransitionContext, readonly (typeof artifacts)[number][]][] = [
      [{ analysis: ANALYSIS, panel: PANEL }, []],
      [{ analysis: ANALYSIS }, ['panel']],
      [{ panel: PANEL }, ['analysis']],
      [{}, ['analysis', 'panel']],
    ];
    for (const [context, missing] of cases) {
      const label = missing.length === 0 ? 'both present' : `missing ${missing.join(' and ')}`;
      const result = transition('analyzing', 'generated', context);
      if (missing.length === 0) {
        expect(isOk(result), label).toBe(true);
        expect(result).toEqual({ ok: true, value: 'generated' });
        continue;
      }
      expect(isErr(result), label).toBe(true);
      const error = expectRefusal(result);
      expect(error.code, label).toBe(SESSION_TRANSITION_ERROR_CODE);
      expect(error.details, label).toMatchObject({
        from: 'analyzing',
        to: 'generated',
        allowed: [...allowedTransitions('analyzing')],
        reason: 'artifacts-missing',
        missing,
      });
      // The message names exactly what is missing, and nothing that is present.
      for (const artifact of artifacts) {
        if (missing.includes(artifact)) {
          expect(error.message, label).toContain(`validated ${artifact}`);
        } else {
          expect(error.message, label).not.toContain(`validated ${artifact}`);
        }
      }
    }
  });

  it('generated is refused when no context is supplied at all — absence is never satisfaction', () => {
    expect(canTransition('analyzing', 'generated')).toBe(false);
    const error = expectRefusal(transition('analyzing', 'generated'));
    expect(error.details).toMatchObject({
      reason: 'artifacts-missing',
      missing: ['analysis', 'panel'],
    });
  });

  it('treats explicitly undefined or null artifacts as missing', () => {
    const context = {
      analysis: undefined,
      panel: null,
    } as unknown as SessionTransitionContext;
    const error = expectRefusal(transition('analyzing', 'generated', context));
    expect(error.details).toMatchObject({ missing: ['analysis', 'panel'] });
  });

  it('accepts a validated fallback panel as a legitimate success (AAP §0.5.3)', () => {
    expect(FALLBACK_PANEL.meta?.fallback).toBe(true);
    const result = transition('analyzing', 'generated', {
      analysis: ANALYSIS,
      panel: FALLBACK_PANEL,
    });
    expect(isOk(result)).toBe(true);
    expect(result).toEqual({ ok: true, value: 'generated' });
  });

  it('generated is reachable from analyzing and from no other status, even with both artifacts', () => {
    for (const from of SESSION_STATUSES) {
      if (from === 'analyzing') {
        continue;
      }
      for (const panel of [PANEL, FALLBACK_PANEL]) {
        expect(canTransition(from, 'generated', { analysis: ANALYSIS, panel }), from).toBe(false);
      }
      const error = expectRefusal(transition(from, 'generated', FULL_CONTEXT));
      expect(error.details, from).toMatchObject({ reason: 'not-permitted' });
    }
    expect(canTransition('analyzing', 'generated', { analysis: ANALYSIS, panel: PANEL })).toBe(
      true,
    );
  });
});

describe('failed can never reach generated (AAP §0.5.5)', () => {
  it('failed can never reach generated: no edge, no guard, and a refusal even with both artifacts', () => {
    expect(SESSION_TRANSITIONS.failed).not.toContain('generated');
    expect(allowedTransitions('failed')).not.toContain('generated');
    expect(Object.keys(SESSION_TRANSITION_GUARDS)).not.toContain('failed->generated');
    for (const panel of [PANEL, FALLBACK_PANEL]) {
      expect(canTransition('failed', 'generated', { analysis: ANALYSIS, panel })).toBe(false);
      const error = expectRefusal(transition('failed', 'generated', { analysis: ANALYSIS, panel }));
      expect(error.details).toMatchObject({
        from: 'failed',
        to: 'generated',
        allowed: [...allowedTransitions('failed')],
        reason: 'not-permitted',
      });
    }
    expect(canTransition('failed', 'generated', FULL_CONTEXT)).toBe(false);
  });

  it('a failed session reaches generated only by re-entering analyzing and passing guard A again', () => {
    expect(isOk(transition('failed', 'analyzing'))).toBe(true);
    expect(isErr(transition('analyzing', 'generated', { analysis: ANALYSIS }))).toBe(true);
    expect(isOk(transition('analyzing', 'generated', { analysis: ANALYSIS, panel: PANEL }))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Guard B — readiness
// ---------------------------------------------------------------------------

describe('guard B: "Ready to capture" requires confirmed readiness', () => {
  it('requires the readiness verdict to be exactly true', () => {
    const refusedContexts: readonly (SessionTransitionContext | undefined)[] = [
      undefined,
      {},
      { readinessSatisfied: false },
      { readinessSatisfied: undefined },
    ];
    for (const context of refusedContexts) {
      const result = transition('instrumenting', 'ready', context);
      expect(isErr(result)).toBe(true);
      const error = expectRefusal(result);
      expect(error.details).toMatchObject({
        from: 'instrumenting',
        to: 'ready',
        reason: 'readiness-unsatisfied',
      });
      expect(canTransition('instrumenting', 'ready', context)).toBe(false);
    }
    const admitted = transition('instrumenting', 'ready', { readinessSatisfied: true });
    expect(isOk(admitted)).toBe(true);
    expect(admitted).toEqual({ ok: true, value: 'ready' });
  });

  it('does not guard the empty-capture edge capturing → ready (AAP §0.5.5)', () => {
    expect(transition('capturing', 'ready')).toEqual({ ok: true, value: 'ready' });
    expect(transition('capturing', 'ready', { readinessSatisfied: false })).toEqual({
      ok: true,
      value: 'ready',
    });
  });

  it('an empty capture returns to ready without ever entering analyzing (AAP §0.5.5)', () => {
    const visited = walkPath('ready', [['capturing'], ['ready']]);
    expect(visited).toEqual(['ready', 'capturing', 'ready']);
    expect(visited).not.toContain('analyzing');
  });

  it('lets a re-armed session capture again after an empty capture', () => {
    const end = walk('ready', [['capturing'], ['ready'], ['capturing'], ['analyzing']]);
    expect(end).toBe('analyzing');
  });
});

// ---------------------------------------------------------------------------
// Guard C — failed
// ---------------------------------------------------------------------------

describe('guard C: failed is a distinct status that always names the failing stage', () => {
  const sources = SESSION_STATUSES.filter((from) => allowedTransitions(from).includes('failed'));

  // Every non-terminal status may fail, except `failed` itself: the table has
  // no self-edges, so an already-failed session stays failed rather than
  // "failing again".
  const nonTerminalSources = SESSION_STATUSES.filter(
    (status) => !isTerminalSessionStatus(status) && status !== 'failed',
  );

  it('applies to every non-terminal status other than failed itself', () => {
    expect([...sources].sort()).toEqual([...nonTerminalSources].sort());
    expect(sources).not.toContain('ended');
    expect(sources).not.toContain('failed');
  });

  it('refuses a transition into failed that does not name the failing stage', () => {
    for (const from of nonTerminalSources) {
      for (const context of [undefined, {}] as const) {
        const result = transition(from, 'failed', context);
        expect(isErr(result), from).toBe(true);
        const error = expectRefusal(result);
        expect(error.details).toMatchObject({ from, to: 'failed', reason: 'failure-missing' });
        expect(canTransition(from, 'failed', context), from).toBe(false);
      }
    }
  });

  it('admits a failure at every known stage from every non-terminal status', () => {
    for (const from of nonTerminalSources) {
      for (const stage of PROGRESS_STAGES) {
        const result = transition(from, 'failed', { failure: failureAt(stage) });
        expect(isOk(result), `${from} at ${stage}`).toBe(true);
        expect(result).toEqual({ ok: true, value: 'failed' });
      }
    }
  });

  it('never lets artifacts or readiness stand in for a named failure', () => {
    for (const from of nonTerminalSources) {
      const error = expectRefusal(
        transition(from, 'failed', { analysis: ANALYSIS, panel: PANEL, readinessSatisfied: true }),
      );
      expect(error.details).toMatchObject({ reason: 'failure-missing' });
    }
  });

  it('admits a failure without a hint', () => {
    const failure: SessionFailure = {
      stage: 'capture',
      code: 'CAPTURE_EMPTY',
      message: 'Nothing was captured.',
    };
    expect(transition('capturing', 'failed', { failure })).toEqual({ ok: true, value: 'failed' });
  });

  it('refuses an unknown stage, an unknown code, a blank message or a non-string hint', () => {
    const invalid: readonly [unknown, readonly string[]][] = [
      [{ ...failureAt('plan'), stage: 'deploy' }, ['stage']],
      [{ ...failureAt('plan'), code: 'MADE_UP_CODE' }, ['code']],
      [{ ...failureAt('plan'), message: '   ' }, ['message']],
      [{ ...failureAt('plan'), message: 42 }, ['message']],
      [{ ...failureAt('plan'), hint: 7 }, ['hint']],
      [{ stage: 'deploy', code: 'MADE_UP_CODE', message: '' }, ['stage', 'code', 'message']],
    ];
    for (const [failure, fields] of invalid) {
      const context = { failure } as unknown as SessionTransitionContext;
      const error = expectRefusal(transition('planning', 'failed', context));
      expect(error.details).toMatchObject({ reason: 'failure-invalid', invalid: fields });
      expect(error.message).not.toContain('deploy');
      expect(error.message).not.toContain('MADE_UP_CODE');
    }
  });
});

// ---------------------------------------------------------------------------
// Paths through the machine
// ---------------------------------------------------------------------------

describe('paths', () => {
  it('walks the first pass from created to generated, one admitted step at a time', () => {
    const visited = walkPath('created', [
      ['understanding'],
      ['investigating'],
      ['planning'],
      ['instrumenting'],
      ['ready', { readinessSatisfied: true }],
      ['capturing'],
      ['analyzing'],
      ['generated', { analysis: ANALYSIS, panel: PANEL }],
    ]);
    expect(visited).toEqual([
      'created',
      'understanding',
      'investigating',
      'planning',
      'instrumenting',
      'ready',
      'capturing',
      'analyzing',
      'generated',
    ]);
  });

  it('walks the follow-up existing-evidence path: generated → analyzing → generated', () => {
    // Fresh artifacts: the regenerated analysis and panel versions n+1.
    const nextAnalysis = analysisDouble();
    const nextPanel = panelDouble();
    const end = walk('generated', [
      ['analyzing'],
      ['generated', { analysis: nextAnalysis, panel: nextPanel }],
    ]);
    expect(end).toBe('generated');
    // The follow-up returns to generated only through the same guarded edge.
    expect(
      expectRefusal(transition('analyzing', 'generated', { analysis: nextAnalysis })).details,
    ).toMatchObject({
      missing: ['panel'],
    });
  });

  it('walks the follow-up new-capture path: generated → planning → … → generated', () => {
    const visited = walkPath('generated', [
      ['planning'],
      ['instrumenting'],
      ['ready', { readinessSatisfied: true }],
      ['capturing'],
      ['analyzing'],
      ['generated', { analysis: analysisDouble(), panel: panelDouble() }],
    ]);
    expect(visited).toEqual([
      'generated',
      'planning',
      'instrumenting',
      'ready',
      'capturing',
      'analyzing',
      'generated',
    ]);
  });

  it('does not let a follow-up skip straight from generated to capturing or ready', () => {
    for (const to of ['capturing', 'ready', 'instrumenting'] as const) {
      expect(canTransition('generated', to, FULL_CONTEXT)).toBe(false);
    }
  });

  it('retries a failed stage by re-entering its owning status, then ends', () => {
    for (const stage of PROGRESS_STAGES) {
      const target = retryTargetFor(failureAt(stage));
      if (target === undefined) {
        continue;
      }
      expect(canTransition('failed', target), stage).toBe(true);
    }
    const end = walk('analyzing', [
      ['failed', { failure: failureAt('generate-panel') }],
      ['analyzing'],
      ['generated', { analysis: ANALYSIS, panel: FALLBACK_PANEL }],
      ['ended'],
    ]);
    expect(end).toBe('ended');
  });
});

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

describe('statusForStage', () => {
  it('maps every progress stage explicitly to the status it runs under', () => {
    expect(Object.keys(STAGE_STATUS).sort()).toEqual([...PROGRESS_STAGES].sort());
    for (const stage of PROGRESS_STAGES) {
      expect(Object.hasOwn(STAGE_STATUS, stage), stage).toBe(true);
    }
    const expected: Readonly<Record<ProgressStage, SessionStatus | undefined>> = {
      understand: 'understanding',
      investigate: 'investigating',
      plan: 'planning',
      instrument: 'instrumenting',
      capture: 'capturing',
      analyze: 'analyzing',
      'generate-panel': 'analyzing',
      followup: undefined,
      cleanup: undefined,
    };
    for (const stage of PROGRESS_STAGES) {
      expect(statusForStage(stage), stage).toBe(expected[stage]);
      expect(STAGE_STATUS[stage]).toBe(expected[stage]);
    }
  });

  it('only ever names a status that failed may retry into', () => {
    for (const stage of PROGRESS_STAGES) {
      const status = statusForStage(stage);
      if (status !== undefined) {
        expect(SESSION_STATUSES).toContain(status);
        expect(allowedTransitions('failed')).toContain(status);
      }
    }
  });

  it('is total: an unknown or prototype-named stage yields undefined', () => {
    for (const bogus of ['deploy', 'toString', '__proto__']) {
      expect(statusForStage(bogus as ProgressStage)).toBeUndefined();
    }
  });

  it('retryTargetFor is statusForStage of the failing stage', () => {
    for (const stage of PROGRESS_STAGES) {
      expect(retryTargetFor(failureAt(stage))).toBe(statusForStage(stage));
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(STAGE_STATUS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The compile-time half
// ---------------------------------------------------------------------------

describe('compile-time guarantees', () => {
  it('are exported as types that only `true` inhabits, so pnpm typecheck proves them too', () => {
    // Each alias is `true` when its guarantee holds and a compile error in the
    // module under test when it does not; binding them here also makes this
    // suite stop compiling if one is removed. The runtime assertions above
    // remain the primary guard, because Vitest strips types without checking.
    const proofs: readonly [
      FailedNeverReachesGenerated,
      GeneratedOnlyFromAnalyzing,
      EndedIsTerminalAndUniversallyReachable,
      GuardedEdgesCoverGeneratedAndFailed,
      EveryStageStatusIsARetryTarget,
    ] = [true, true, true, true, true];
    expect(proofs.every((proof) => proof)).toBe(true);
  });
});
