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
 * Fixtures are synthetic and generic: the analysis and panel are the smallest
 * artifacts the owning schemas accept, built through their real validators so
 * that "validated" means what the service means by it. Nothing here names a
 * symbol or route of any real project (AAP §0.5.4), reads a clock or touches
 * the filesystem; statuses, stages and codes are taken from the imported
 * vocabularies rather than restated wherever the test is not the oracle.
 */

import { describe, expect, it } from 'vitest';

import {
  PROGRESS_STAGES,
  SESSION_STATUSES,
  createAnalysisResult,
  parseAnalysisResult,
  type AnalysisResult,
  type PanelSpec,
  type ProgressStage,
  type SessionStatus,
} from '@debuggen/protocol';
import { PANEL_SPEC_VERSION, validatePanelSpec } from '@debuggen/panel-schema';
import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  newCaptureId,
  newPanelId,
  newSessionId,
  type Result,
} from '@debuggen/shared';

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

const SESSION_ID = newSessionId();

/** The smallest analysis the protocol accepts, validated by its own parser. */
function validatedAnalysis(): AnalysisResult {
  const parsed = parseAnalysisResult(
    createAnalysisResult(
      { observed: [], likelyCauses: [] },
      {
        sessionId: SESSION_ID,
        captureId: newCaptureId(),
        analysisVersion: 1,
        createdAt: 1_700_000_000_000,
        metrics: [],
      },
    ),
  );
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

/** The smallest panel the panel schema accepts, optionally marked as a fallback. */
function validatedPanel(fallback = false): PanelSpec {
  const candidate = {
    version: PANEL_SPEC_VERSION,
    id: newPanelId(),
    sessionId: SESSION_ID,
    panelVersion: 1,
    title: 'Interaction overview',
    summary: { observed: [], likelyCauses: [] },
    layout: [],
    ...(fallback ? { meta: { fallback: true } } : {}),
  };
  const validated = validatePanelSpec(candidate);
  if (!validated.ok) {
    throw validated.error;
  }
  return validated.value;
}

const ANALYSIS = validatedAnalysis();
const PANEL = validatedPanel();
const FALLBACK_PANEL = validatedPanel(true);

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

/** Narrows a result to its error, failing the test when it succeeded. */
function expectRefusal(result: Result<SessionStatus, DebuggenError>): DebuggenError {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error(`expected a refusal, got ok(${result.value})`);
  }
  return result.error;
}

/** Walks a path of statuses, asserting every step succeeds with its context. */
function walk(
  start: SessionStatus,
  steps: readonly (readonly [SessionStatus, SessionTransitionContext?])[],
): SessionStatus {
  let current = start;
  for (const [to, context] of steps) {
    const result = transition(current, to, context);
    expect(result).toEqual({ ok: true, value: to });
    if (result.ok) {
      current = result.value;
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

describe('SESSION_TRANSITIONS', () => {
  it('is keyed by exactly the protocol status vocabulary', () => {
    expect([...Object.keys(SESSION_TRANSITIONS)].sort()).toEqual([...SESSION_STATUSES].sort());
    expect(Object.keys(SESSION_TRANSITIONS)).toHaveLength(SESSION_STATUSES.length);
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

  it('never permits a status to transition to itself', () => {
    for (const status of SESSION_STATUSES) {
      expect(allowedTransitions(status)).not.toContain(status);
    }
  });
});

describe('allowedTransitions', () => {
  it('returns the table row for every status', () => {
    for (const from of SESSION_STATUSES) {
      expect(allowedTransitions(from)).toEqual(SESSION_TRANSITIONS[from]);
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

  it('isTerminalSessionStatus agrees with the table for every status', () => {
    for (const status of SESSION_STATUSES) {
      expect(isTerminalSessionStatus(status)).toBe(allowedTransitions(status).length === 0);
    }
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
      expect(transition(from, 'ended')).toEqual({ ok: true, value: 'ended' });
      expect(canTransition(from, 'ended')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Every pair, and the shape of every refusal
// ---------------------------------------------------------------------------

describe('transition over every ordered pair', () => {
  it('succeeds exactly on the specified edges when every guard is satisfied', () => {
    for (const [from, to] of ALL_PAIRS) {
      const result = transition(from, to, FULL_CONTEXT);
      expect(result.ok, edgeOf(from, to)).toBe(EXPECTED_EDGES.includes(edgeOf(from, to)));
      expect(canTransition(from, to, FULL_CONTEXT)).toBe(result.ok);
    }
  });

  it('refuses every illegal pair with a typed, coded, fully described error and never throws', () => {
    for (const [from, to] of ALL_PAIRS) {
      if (EXPECTED_EDGES.includes(edgeOf(from, to))) {
        continue;
      }
      const error = expectRefusal(transition(from, to, FULL_CONTEXT));
      expect(error).toBeInstanceOf(DebuggenError);
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

  it('never mutates the context it is given', () => {
    const context: SessionTransitionContext = {
      analysis: ANALYSIS,
      panel: PANEL,
      readinessSatisfied: false,
      failure: failureAt('plan'),
    };
    const snapshot = structuredClone(context);
    for (const [from, to] of ALL_PAIRS) {
      transition(from, to, context);
    }
    expect(context).toEqual(snapshot);
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
        if (!result.ok) {
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

describe('guard A: analyzing → generated', () => {
  it('admits the transition only when both validated artifacts are present', () => {
    const cases: readonly [SessionTransitionContext, readonly string[] | null][] = [
      [{}, ['analysis', 'panel']],
      [{ analysis: ANALYSIS }, ['panel']],
      [{ panel: PANEL }, ['analysis']],
      [{ analysis: ANALYSIS, panel: PANEL }, null],
    ];
    for (const [context, missing] of cases) {
      const result = transition('analyzing', 'generated', context);
      if (missing === null) {
        expect(result).toEqual({ ok: true, value: 'generated' });
        continue;
      }
      const error = expectRefusal(result);
      expect(error.code).toBe(SESSION_TRANSITION_ERROR_CODE);
      expect(error.details).toMatchObject({
        from: 'analyzing',
        to: 'generated',
        allowed: [...allowedTransitions('analyzing')],
        reason: 'artifacts-missing',
        missing,
      });
      for (const artifact of missing) {
        expect(error.message).toContain(`validated ${artifact}`);
      }
    }
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
    expect(
      transition('analyzing', 'generated', { analysis: ANALYSIS, panel: FALLBACK_PANEL }),
    ).toEqual({ ok: true, value: 'generated' });
  });

  it('is reachable from analyzing and from no other status, whatever the evidence', () => {
    for (const from of SESSION_STATUSES) {
      const result = transition(from, 'generated', FULL_CONTEXT);
      expect(result.ok, from).toBe(from === 'analyzing');
      if (!result.ok) {
        expect(result.error.details).toMatchObject({ reason: 'not-permitted' });
      }
    }
  });

  it('has no failed → generated edge: a failure is never dressed up as success (AAP §0.5.5)', () => {
    expect(allowedTransitions('failed')).not.toContain('generated');
    expect(Object.keys(SESSION_TRANSITION_GUARDS)).not.toContain('failed->generated');
    const error = expectRefusal(
      transition('failed', 'generated', { analysis: ANALYSIS, panel: FALLBACK_PANEL }),
    );
    expect(error.details).toMatchObject({
      from: 'failed',
      to: 'generated',
      reason: 'not-permitted',
    });
  });
});

// ---------------------------------------------------------------------------
// Guard B — readiness
// ---------------------------------------------------------------------------

describe('guard B: instrumenting → ready', () => {
  it('requires the readiness verdict to be exactly true', () => {
    for (const context of [{}, { readinessSatisfied: false }, { readinessSatisfied: undefined }]) {
      const error = expectRefusal(transition('instrumenting', 'ready', context));
      expect(error.details).toMatchObject({
        from: 'instrumenting',
        to: 'ready',
        reason: 'readiness-unsatisfied',
      });
    }
    expect(transition('instrumenting', 'ready', { readinessSatisfied: true })).toEqual({
      ok: true,
      value: 'ready',
    });
  });

  it('does not guard the empty-capture edge capturing → ready (AAP §0.5.5)', () => {
    expect(transition('capturing', 'ready')).toEqual({ ok: true, value: 'ready' });
    expect(transition('capturing', 'ready', { readinessSatisfied: false })).toEqual({
      ok: true,
      value: 'ready',
    });
  });

  it('lets a re-armed session capture again after an empty capture', () => {
    const end = walk('ready', [['capturing'], ['ready'], ['capturing'], ['analyzing']]);
    expect(end).toBe('analyzing');
  });
});

// ---------------------------------------------------------------------------
// Guard C — failed
// ---------------------------------------------------------------------------

describe('guard C: * → failed', () => {
  const sources = SESSION_STATUSES.filter((from) => allowedTransitions(from).includes('failed'));

  it('applies to every status that can fail — every status except ended and failed', () => {
    expect([...sources].sort()).toEqual(
      SESSION_STATUSES.filter((status) => status !== 'ended' && status !== 'failed').sort(),
    );
  });

  it('refuses a transition that names no failure', () => {
    for (const from of sources) {
      const error = expectRefusal(transition(from, 'failed', {}));
      expect(error.details).toMatchObject({ from, to: 'failed', reason: 'failure-missing' });
    }
  });

  it('admits a failure at every known stage', () => {
    for (const from of sources) {
      for (const stage of PROGRESS_STAGES) {
        expect(transition(from, 'failed', { failure: failureAt(stage) })).toEqual({
          ok: true,
          value: 'failed',
        });
      }
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
  it('walks the first pass from created to generated', () => {
    const end = walk('created', [
      ['understanding'],
      ['investigating'],
      ['planning'],
      ['instrumenting'],
      ['ready', { readinessSatisfied: true }],
      ['capturing'],
      ['analyzing'],
      ['generated', { analysis: ANALYSIS, panel: PANEL }],
    ]);
    expect(end).toBe('generated');
  });

  it('walks the follow-up existing-evidence path: generated → analyzing → generated', () => {
    const next = validatedAnalysis();
    const end = walk('generated', [
      ['analyzing'],
      ['generated', { analysis: next, panel: validatedPanel() }],
    ]);
    expect(end).toBe('generated');
    expect(
      expectRefusal(transition('analyzing', 'generated', { analysis: next })).details,
    ).toMatchObject({
      missing: ['panel'],
    });
  });

  it('walks the follow-up new-capture path: generated → planning → … → generated', () => {
    const end = walk('generated', [
      ['planning'],
      ['instrumenting'],
      ['ready', { readinessSatisfied: true }],
      ['capturing'],
      ['analyzing'],
      ['generated', { analysis: validatedAnalysis(), panel: validatedPanel() }],
    ]);
    expect(end).toBe('generated');
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
  it('maps all nine stages explicitly', () => {
    expect(Object.keys(STAGE_STATUS).sort()).toEqual([...PROGRESS_STAGES].sort());
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
