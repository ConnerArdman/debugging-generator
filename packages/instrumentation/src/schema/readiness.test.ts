/**
 * Tests for `./readiness.ts`: the signal vocabulary, the two runtime
 * configuration shapes and the derivations that build them.
 *
 * Almost everything on trial here fails **silently** in production if it fails
 * at all, which is what this suite exists for.
 *
 * 1. **Key-name fidelity is a wire contract.** Neither consumer of these two
 *    configurations can import the module that defines them: the page agent is
 *    bundled into an IIFE injected into the developer's page and parses
 *    `agent.config` structurally and permissively, and the dev-server preload
 *    sits below this package in the layering and keeps its own structural
 *    mirror of the signal set. So a renamed key compiles, passes review, and
 *    disables a signal — the developer reproduces their problem exactly as
 *    asked and the capture comes back missing the evidence. The key sets and
 *    the five server rows of the signal→kind table are therefore asserted
 *    mechanically, against a transcript of `control.ts`'s own table.
 *
 * 2. **The derivations encode prerequisites that no schema can express.**
 *    `interactions` is a prerequisite for correlated network capture (the fetch
 *    patch injects `traceparent` only inside an interaction context, and the
 *    interaction listener mints the trace root) and `react` is a prerequisite
 *    for state capture (transitions are recorded from inside a commit). Both
 *    follow from how the agent's modules are wired rather than from any prose,
 *    and a capture that lost either would still look successful.
 *
 * 3. **Conservative server gating is a promise, not an optimisation.** A plan
 *    that does not ask for the server tier collects no backend or database
 *    telemetry, so a purely browser-side plan must produce the disabled signal
 *    set — the purely browser-side plan case of `deriveServerAgentSignals`
 *    below is the assertion that keeps that promise.
 *
 * Two conventions in here are deliberate.
 *
 * - **Nothing is asserted about a message's prose.** A rejection is checked by
 *   its code, its field paths and the presence of a hint — the contractual
 *   parts — so rewording an error does not fail a test while losing its
 *   recovery path does.
 * - **Every adapter id, file, symbol and rationale is invented.** Real adapter
 *   ids live in `../registry.ts` and are not this file's business, and neutral
 *   names keep the derivation tables readable.
 */

import { describe, expect, it } from 'vitest';

import { DebuggenError } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';
import { TELEMETRY_KINDS } from '@debuggen/telemetry';
import type { TelemetryKind } from '@debuggen/telemetry';

import { INSTRUMENTATION_ACTION_TYPES, instrumentationActionSchema } from './plan.js';
import type { InstrumentationAction, InstrumentationActionType } from './plan.js';

import {
  AGENT_HOOK_KEYS,
  BROWSER_CAPTURE_SIGNALS,
  CAPTURE_SIGNALS,
  CAPTURE_SIGNAL_TO_TELEMETRY_KIND,
  DISABLED_SERVER_AGENT_SIGNALS,
  DORMANT_AGENT_HOOK_CONFIG,
  READINESS_HINT_MAX_LENGTH,
  READINESS_REASON_MAX_LENGTH,
  READINESS_STATUSES,
  SERVER_AGENT_SIGNAL_KEYS,
  SERVER_CAPTURE_SIGNALS,
  agentHookConfigSchema,
  buildReadiness,
  captureSignalSchema,
  deriveAgentHookConfig,
  deriveServerAgentSignals,
  isCaptureSignal,
  parseAgentHookConfig,
  parseReadiness,
  parseServerAgentSignals,
  readinessSchema,
  readinessSignalSchema,
  serverAgentSignalsSchema,
  telemetryKindsForSignal,
} from './readiness.js';
import type {
  ActionTier,
  ActionTierResolver,
  AgentHookConfig,
  AgentHookKey,
  CaptureSignal,
  Readiness,
  ReadinessSignal,
  ServerAgentSignals,
} from './readiness.js';

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------
 */

/**
 * `packages/telemetry/src/node/control.ts`'s `SIGNAL_KINDS`, transcribed.
 *
 * A copy rather than an import, and the copy is the assertion: that module is
 * the gate that actually drops a span whose kind no enabled signal admits, it
 * sits *below* this package (so it may not import the table it mirrors), and
 * its import graph carries the OpenTelemetry SDK, so the telemetry barrel
 * deliberately does not re-export it. Transcribing it here is what turns
 * "the two tables agree" from a comment into a failing test.
 */
const CONTROL_SIGNAL_KINDS: Readonly<Record<string, readonly TelemetryKind[]>> = {
  http: ['http.server'],
  routeHandlers: ['route.handler'],
  fetch: ['http.client'],
  prisma: ['db.query'],
  pg: ['db.query'],
  functions: ['function'],
};

/** The five rows whose equality with `control.ts` is contractual. */
const MIRRORED_SERVER_SIGNALS = ['http', 'routeHandlers', 'prisma', 'pg', 'functions'] as const;

/** Monotonic source of distinct, pattern-valid action ids. */
let actionSequence = 0;

/**
 * Builds a valid {@link InstrumentationAction}, overriding only what a case
 * cares about.
 *
 * Every fixture is a *real* action — `./plan.ts`'s schema accepts it (asserted
 * below) — so a derivation is never exercised against a shape the installer
 * could not hand it.
 */
function action(overrides: Partial<InstrumentationAction> = {}): InstrumentationAction {
  actionSequence += 1;

  return {
    id: `act_${String(actionSequence).padStart(16, '0')}`,
    file: 'src/feature/module.ts',
    symbol: 'someSymbol',
    type: 'interaction-tracking',
    adapter: 'adapter-under-test',
    mode: 'runtime',
    rationale: 'exercise the derivation',
    ...overrides,
  };
}

/** A resolver that answers from a map of action id to tier. */
function tierResolver(tiers: Readonly<Record<string, ActionTier>>): ActionTierResolver {
  return {
    tierOf: (candidate) => tiers[candidate.id] ?? 'unknown',
  };
}

/**
 * Freezes an action list and every action in it.
 *
 * Purity is asserted by *preventing* mutation rather than by noticing it
 * afterwards: these modules are ESM and therefore strict, so a write into a
 * frozen object throws, and a derivation that ever reached for one of its
 * inputs fails as an error at the call rather than as a diff a reader has to
 * spot. The installer hands the same action objects to several adapters and
 * keeps them on the plan it stores, so a derivation that wrote into one would
 * corrupt a record two user interfaces render.
 */
function deepFrozen(actions: InstrumentationAction[]): readonly InstrumentationAction[] {
  for (const item of actions) {
    Object.freeze(item);
  }

  return Object.freeze(actions);
}

/** The hook keys that are `true` in a configuration, in declaration order. */
function enabledHooks(config: AgentHookConfig): readonly AgentHookKey[] {
  return AGENT_HOOK_KEYS.filter((key) => config[key]);
}

/** Unwraps a successful {@link Result}, failing the test when it is an error. */
function expectOk<T>(result: Result<T>): T {
  if (!result.ok) {
    expect.fail(`expected ok, got ${result.error.code}: ${result.error.message}`);
  }

  return result.value;
}

/** Unwraps a failed {@link Result}, failing the test when it succeeded. */
function expectErr<T>(result: Result<T>): DebuggenError {
  if (result.ok) {
    expect.fail('expected a rejection, got a value');
  }

  expect(result.error).toBeInstanceOf(DebuggenError);
  return result.error;
}

/** The dotted field paths a rejection reported. */
function issuePaths(error: DebuggenError): readonly string[] {
  const issues = error.details?.['issues'];
  expect(Array.isArray(issues)).toBe(true);

  return (issues as ReadonlyArray<{ path: string; message: string }>).map((issue) => issue.path);
}

/** A valid readiness row. */
function readinessRow(overrides: Partial<ReadinessSignal> = {}): ReadinessSignal {
  return { signal: 'react', status: 'available', ...overrides };
}

/*
 * ---------------------------------------------------------------------------
 * Fixture sanity
 * ---------------------------------------------------------------------------
 */

describe('fixtures', () => {
  it('builds actions the plan schema accepts', () => {
    for (const type of INSTRUMENTATION_ACTION_TYPES) {
      const parsed = instrumentationActionSchema.safeParse(action({ type, mode: 'patch' }));
      expect(parsed.success, `action of type ${type}`).toBe(true);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * The capture-signal vocabulary
 * ---------------------------------------------------------------------------
 */

describe('CAPTURE_SIGNALS', () => {
  it('declares the twelve signals, browser tier first', () => {
    expect([...CAPTURE_SIGNALS]).toEqual([
      'interactions',
      'react',
      'state',
      'fetch',
      'perf',
      'errors',
      'componentTree',
      'http',
      'routeHandlers',
      'prisma',
      'pg',
      'functions',
    ]);
  });

  it('names each signal once', () => {
    expect(new Set(CAPTURE_SIGNALS).size).toBe(CAPTURE_SIGNALS.length);
  });

  it('is a readonly tuple of literal members rather than a mutable string array', () => {
    // The vocabulary is immutable by `as const`, not by `Object.freeze`, so its
    // immutability is a compile-time guarantee and the annotation below *is*
    // the assertion: widening the export to `string[]`, or dropping the
    // readonly modifier, fails `pnpm typecheck` here. The runtime check keeps
    // the binding in use so the annotation cannot be dropped as dead code.
    const literalTuple: readonly ['interactions', ...CaptureSignal[]] = CAPTURE_SIGNALS;
    expect(literalTuple).toBe(CAPTURE_SIGNALS);
  });

  it('accepts every member through the schema and the predicate', () => {
    for (const signal of CAPTURE_SIGNALS) {
      expect(captureSignalSchema.safeParse(signal).success, signal).toBe(true);
      expect(isCaptureSignal(signal), signal).toBe(true);
    }
  });

  it('refuses a plausible name that is not in the vocabulary', () => {
    // 'renders' is one of the page agent's accepted aliases, which is exactly
    // the kind of near-miss this vocabulary must not silently absorb.
    expect(isCaptureSignal('renders')).toBe(false);
    expect(captureSignalSchema.safeParse('renders').success).toBe(false);
  });

  it('refuses a value that is not a string', () => {
    for (const value of [undefined, null, 7, {}, ['react']]) {
      expect(isCaptureSignal(value)).toBe(false);
    }
  });
});

describe('the per-tier signal lists', () => {
  it('splits the vocabulary into the browser seven and the server six', () => {
    expect([...BROWSER_CAPTURE_SIGNALS]).toEqual([...CAPTURE_SIGNALS].slice(0, 7));
    expect([...SERVER_CAPTURE_SIGNALS]).toEqual([
      'http',
      'routeHandlers',
      'fetch',
      'prisma',
      'pg',
      'functions',
    ]);
  });

  it('covers every signal between the two lists', () => {
    const covered = new Set<CaptureSignal>([...BROWSER_CAPTURE_SIGNALS, ...SERVER_CAPTURE_SIGNALS]);
    expect([...covered].sort()).toEqual([...CAPTURE_SIGNALS].sort());
  });

  it('shares exactly one signal between the tiers, and it is fetch', () => {
    const browser = new Set<CaptureSignal>(BROWSER_CAPTURE_SIGNALS);
    const shared = SERVER_CAPTURE_SIGNALS.filter((signal) => browser.has(signal));
    expect(shared).toEqual(['fetch']);
  });

  it('matches the key set of each configuration shape', () => {
    expect([...BROWSER_CAPTURE_SIGNALS]).toEqual([...AGENT_HOOK_KEYS]);
    expect([...SERVER_CAPTURE_SIGNALS]).toEqual([...SERVER_AGENT_SIGNAL_KEYS]);
  });
});

describe('CAPTURE_SIGNAL_TO_TELEMETRY_KIND', () => {
  it('has one non-empty array row per signal, and no row for anything else', () => {
    expect(Object.keys(CAPTURE_SIGNAL_TO_TELEMETRY_KIND).sort()).toEqual(
      [...CAPTURE_SIGNALS].sort(),
    );

    for (const signal of CAPTURE_SIGNALS) {
      const kinds = telemetryKindsForSignal(signal);

      expect(Array.isArray(kinds), signal).toBe(true);
      expect(kinds.length, signal).toBeGreaterThan(0);
      // A row that named a kind twice would double-count nothing, but it would
      // mean two readers of the table disagree about what the row says.
      expect(new Set(kinds).size, signal).toBe(kinds.length);
    }
  });

  it('answers telemetryKindsForSignal from the table, for every signal', () => {
    for (const signal of CAPTURE_SIGNALS) {
      expect([...telemetryKindsForSignal(signal)], signal).toEqual([
        ...CAPTURE_SIGNAL_TO_TELEMETRY_KIND[signal],
      ]);
    }
  });

  it('maps only kinds the telemetry vocabulary declares', () => {
    const known = new Set<string>(TELEMETRY_KINDS);

    for (const signal of CAPTURE_SIGNALS) {
      for (const kind of telemetryKindsForSignal(signal)) {
        expect(known.has(kind), `${signal} → ${kind}`).toBe(true);
      }
    }
  });

  it('mirrors the preload gate exactly on the five server-only rows', () => {
    for (const signal of MIRRORED_SERVER_SIGNALS) {
      expect([...telemetryKindsForSignal(signal)], signal).toEqual([
        ...(CONTROL_SIGNAL_KINDS[signal] ?? []),
      ]);
    }
  });

  it('extends the preload gate on the one row shared by both tiers', () => {
    const kinds = telemetryKindsForSignal('fetch');

    // A superset, not a disagreement: the preload never sees the browser's own
    // request kinds, so it never had to name them.
    for (const kind of CONTROL_SIGNAL_KINDS['fetch'] ?? []) {
      expect(kinds).toContain(kind);
    }

    expect(kinds).toContain('fetch');
    expect(kinds).toContain('xhr');
  });

  it('maps each browser row to the kinds that tier actually produces', () => {
    // Asserted literally, row by row, for the same reason the five server rows
    // are: the service's readiness module explains a missing signal from this
    // table and the analysis stage decides from it whether the evidence a
    // question needs was collected, so a row quietly widened or narrowed
    // changes what a capture is believed to hold.
    expect([...telemetryKindsForSignal('interactions')]).toEqual(['interaction']);

    const react = telemetryKindsForSignal('react');
    expect(react).toContain('render');
    expect(react).toContain('commit');

    expect([...telemetryKindsForSignal('state')]).toEqual(['state']);

    const perf = telemetryKindsForSignal('perf');
    expect(perf).toContain('perf.longtask');
    expect(perf).toContain('perf.entry');

    expect([...telemetryKindsForSignal('errors')]).toEqual(['error']);
  });

  it('reconstructs the component tree from commit and render events', () => {
    // `componentTree` names no kind of its own: the snapshot arrives as a
    // commit-time event and the per-node render counts come from `render`
    // events of the same capture, so the row must consist of exactly those two
    // and nothing the tree is not built from.
    expect([...telemetryKindsForSignal('componentTree')].sort()).toEqual(['commit', 'render']);
  });

  it('returns the table row itself, so a caller cannot see a copied stale row', () => {
    expect(telemetryKindsForSignal('prisma')).toBe(CAPTURE_SIGNAL_TO_TELEMETRY_KIND.prisma);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The readiness report
 * ---------------------------------------------------------------------------
 */

describe('readinessSignalSchema', () => {
  it('declares the three statuses, from fully ready to not collected at all', () => {
    // The three-way split is what lets readiness gate a capture without
    // blocking it for a partial signal: `degraded` still captures, with a
    // stated limitation, and only `unavailable` is reported as the
    // developer-facing "Could not enable ‹signal›: ‹reason›." message.
    expect([...READINESS_STATUSES]).toEqual(['available', 'degraded', 'unavailable']);
  });

  it('accepts a row with only a signal and a status', () => {
    expect(readinessSignalSchema.safeParse(readinessRow()).success).toBe(true);
  });

  it('accepts every declared status', () => {
    for (const status of READINESS_STATUSES) {
      expect(readinessSignalSchema.safeParse(readinessRow({ status })).success, status).toBe(true);
    }
  });

  it('accepts an explanation and a recovery hint', () => {
    const parsed = readinessSignalSchema.safeParse({
      signal: 'prisma',
      status: 'unavailable',
      reason: 'no server-side producer is attached for this project',
      hint: 'relaunch the dev server through the extension',
    });

    expect(parsed.success).toBe(true);
  });

  it('refuses an unknown signal, an unknown status and an unknown key', () => {
    expect(readinessSignalSchema.safeParse({ signal: 'sql', status: 'available' }).success).toBe(
      false,
    );
    expect(readinessSignalSchema.safeParse({ signal: 'react', status: 'ready' }).success).toBe(
      false,
    );
    expect(
      readinessSignalSchema.safeParse({ signal: 'react', status: 'available', level: 1 }).success,
    ).toBe(false);
  });

  it('refuses prose that would not render as one line', () => {
    for (const reason of ['', '   ', 'first line\nsecond line', 'tab\tseparated']) {
      expect(readinessSignalSchema.safeParse(readinessRow({ reason })).success, reason).toBe(false);
    }
  });

  it('bounds the explanation and the hint', () => {
    // Asserted through the exported constants, which is how an adapter fits a
    // composed string to them: a bound that moved here without moving there
    // would be a refusal at the boundary rather than a failing test.
    expect(READINESS_REASON_MAX_LENGTH).toBe(500);
    expect(READINESS_HINT_MAX_LENGTH).toBe(1000);

    const reasonAt = 'x'.repeat(READINESS_REASON_MAX_LENGTH);
    const reasonOver = 'x'.repeat(READINESS_REASON_MAX_LENGTH + 1);
    const hintAt = 'x'.repeat(READINESS_HINT_MAX_LENGTH);
    const hintOver = 'x'.repeat(READINESS_HINT_MAX_LENGTH + 1);

    expect(readinessSignalSchema.safeParse(readinessRow({ reason: reasonAt })).success).toBe(true);
    expect(readinessSignalSchema.safeParse(readinessRow({ reason: reasonOver })).success).toBe(
      false,
    );
    expect(readinessSignalSchema.safeParse(readinessRow({ hint: hintAt })).success).toBe(true);
    expect(readinessSignalSchema.safeParse(readinessRow({ hint: hintOver })).success).toBe(false);

    // A hint is wider than a reason because it carries a command — the exact
    // relaunch command when the dev server was started without the preload —
    // so a hint past the reason's bound is still a hint.
    expect(readinessSignalSchema.safeParse(readinessRow({ hint: reasonOver })).success).toBe(true);
  });
});

describe('readinessSchema', () => {
  const report: Readiness = {
    ready: true,
    adapter: 'adapter-under-test',
    signals: [readinessRow()],
    checkedAt: 1_700_000_000_000,
  };

  it('accepts a full report and one with no adapter and no rows', () => {
    expect(readinessSchema.safeParse(report).success).toBe(true);
    expect(readinessSchema.safeParse({ ready: true, signals: [], checkedAt: 1 }).success).toBe(
      true,
    );
  });

  it('refuses an unknown key', () => {
    expect(readinessSchema.safeParse({ ...report, stale: false }).success).toBe(false);
  });

  it('requires ready, signals and checkedAt', () => {
    for (const key of ['ready', 'signals', 'checkedAt'] as const) {
      const partial: Record<string, unknown> = { ...report };
      delete partial[key];
      expect(readinessSchema.safeParse(partial).success, key).toBe(false);
    }
  });

  it('refuses a report whose row names an unknown signal or an unknown status', () => {
    expect(
      readinessSchema.safeParse({ ...report, signals: [{ signal: 'sql', status: 'available' }] })
        .success,
    ).toBe(false);
    expect(
      readinessSchema.safeParse({ ...report, signals: [{ signal: 'react', status: 'ready' }] })
        .success,
    ).toBe(false);
  });

  it('refuses a clock reading that is not a positive finite millisecond', () => {
    for (const checkedAt of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1700000000000']) {
      expect(readinessSchema.safeParse({ ...report, checkedAt }).success, String(checkedAt)).toBe(
        false,
      );
    }
  });

  it('refuses a blank adapter id but allows an absent one', () => {
    expect(readinessSchema.safeParse({ ...report, adapter: '  ' }).success).toBe(false);
    expect(readinessSchema.safeParse({ ready: true, signals: [], checkedAt: 1 }).success).toBe(
      true,
    );
  });

  it('bounds the row list at thirty-two', () => {
    const rows = (count: number): ReadinessSignal[] =>
      Array.from({ length: count }, () => readinessRow());

    expect(readinessSchema.safeParse({ ...report, signals: rows(32) }).success).toBe(true);
    expect(readinessSchema.safeParse({ ...report, signals: rows(33) }).success).toBe(false);
  });
});

describe('parseReadiness', () => {
  it('returns the parsed report', () => {
    const parsed = expectOk(
      parseReadiness({
        ready: false,
        signals: [readinessRow({ status: 'unavailable' })],
        checkedAt: 5,
      }),
    );

    expect(parsed.ready).toBe(false);
    expect(parsed.signals[0]?.signal).toBe('react');
  });

  it('reports a transport-coded rejection with field paths and a recovery hint', () => {
    const error = expectErr(parseReadiness({ ready: 'yes', signals: [], checkedAt: 1 }));

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(error.hint).toBeTypeOf('string');
    expect(issuePaths(error)).toContain('ready');
  });

  it('names the offending row by index', () => {
    const error = expectErr(
      parseReadiness({
        ready: true,
        signals: [{ signal: 'nope', status: 'available' }],
        checkedAt: 1,
      }),
    );

    expect(issuePaths(error)).toContain('signals.0.signal');
  });

  it('never echoes the rejected value', () => {
    const marker = 'MARKER-VALUE-MUST-NOT-APPEAR';
    const error = expectErr(
      parseReadiness({ ready: true, signals: [], checkedAt: 1, adapter: marker.repeat(4) }),
    );

    const rendered = JSON.stringify({
      message: error.message,
      hint: error.hint,
      details: error.details,
    });

    expect(rendered).not.toContain(marker);
  });

  it('refuses a value that is not an object at all', () => {
    for (const value of [undefined, null, 'ready', 7, []]) {
      expect(parseReadiness(value).ok).toBe(false);
    }
  });
});

describe('buildReadiness', () => {
  const clock = (value: number) => () => value;

  it('is ready when nothing is unavailable, including with no rows at all', () => {
    // An empty report is ready because an adapter that claims nothing in this
    // project cannot hold a capture back. The preconditions no adapter can see
    // — a relayed `agent.ready` for the bound tab's current document with
    // `installedBeforeReact = true`, and a connected `server-agent` for the
    // project whenever server signals are planned — are added by
    // `apps/local-service/src/instrumentation/readiness.ts` when it aggregates
    // these reports into the "Ready to capture" state, never here.
    expect(buildReadiness({ signals: [], now: clock(1) }).ready).toBe(true);
    expect(
      buildReadiness({
        signals: [readinessRow(), readinessRow({ signal: 'perf', status: 'degraded' })],
        now: clock(1),
      }).ready,
    ).toBe(true);
  });

  it('is not ready when any row is unavailable', () => {
    expect(
      buildReadiness({
        signals: [readinessRow(), readinessRow({ signal: 'prisma', status: 'unavailable' })],
        now: clock(1),
      }).ready,
    ).toBe(false);
  });

  it('stamps the injected clock, and a real one by default', () => {
    expect(buildReadiness({ signals: [], now: clock(1_234) }).checkedAt).toBe(1_234);

    // The default path is pinned between two real readings rather than with
    // fake timers: every clock in this module is injectable, so no suite here
    // has to take the global one over.
    const before = Date.now();
    const stamped = buildReadiness({ signals: [] }).checkedAt;
    const after = Date.now();

    expect(Number.isInteger(stamped)).toBe(true);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it('carries an adapter id when given one and omits the key when not', () => {
    const named = buildReadiness({ adapter: 'adapter-under-test', signals: [], now: clock(1) });
    expect(named.adapter).toBe('adapter-under-test');

    const anonymous = buildReadiness({ signals: [], now: clock(1) });
    expect(Object.hasOwn(anonymous, 'adapter')).toBe(false);
  });

  it('copies the rows, so a later mutation cannot change a report already handed out', () => {
    const rows: ReadinessSignal[] = [readinessRow()];
    const built = buildReadiness({ signals: rows, now: clock(1) });

    rows.push(readinessRow({ signal: 'perf', status: 'unavailable' }));
    const firstRow = rows[0];
    if (firstRow !== undefined) {
      firstRow.status = 'unavailable';
    }

    expect(built.signals).toHaveLength(1);
    expect(built.signals[0]?.status).toBe('available');
    expect(built.signals[0]).not.toBe(firstRow);
  });

  it('produces a report that parses and survives a JSON round trip', () => {
    const built = buildReadiness({
      adapter: 'adapter-under-test',
      signals: [readinessRow({ signal: 'pg', status: 'degraded', reason: 'sampling only' })],
      now: clock(9),
    });

    expect(expectOk(parseReadiness(built))).toEqual(built);
    expect(JSON.parse(JSON.stringify(built))).toEqual(built);
  });
});

/*
 * ---------------------------------------------------------------------------
 * `AgentHookConfig`
 * ---------------------------------------------------------------------------
 */

describe('agentHookConfigSchema', () => {
  it('declares exactly the seven keys the page agent attaches hooks for', () => {
    // One key per attach point in `packages/telemetry/src/browser/agent.ts`:
    //
    //   interactions  → attachInteractions()
    //   react         → attachReact()
    //   state         → attachState()
    //   fetch         → attachFetch()
    //   perf          → attachPerf()
    //   errors        → attachErrors()
    //   componentTree → snapshotComponentTree(), at the capture's last commit
    //
    // The agent parses an inbound frame permissively and cannot import this
    // schema, so a key renamed on either side compiles: the hook is simply
    // never attached and the capture comes back missing that evidence.
    expect(Object.keys(agentHookConfigSchema.shape)).toEqual([
      'interactions',
      'react',
      'state',
      'fetch',
      'perf',
      'errors',
      'componentTree',
    ]);
    expect([...AGENT_HOOK_KEYS]).toEqual(Object.keys(agentHookConfigSchema.shape));
  });

  it('parses a configuration into exactly those keys, in that order', () => {
    const parsed = expectOk(
      parseAgentHookConfig({
        componentTree: true,
        errors: false,
        perf: true,
        fetch: false,
        state: false,
        react: true,
        interactions: true,
      }),
    );

    // Key order survives the parse whatever order the sender wrote them in, so
    // two producers of the same configuration serialise to the same frame.
    expect(Object.keys(parsed)).toEqual([...AGENT_HOOK_KEYS]);
  });

  it('requires every flag, so "all false" is always explicit', () => {
    for (const key of AGENT_HOOK_KEYS) {
      const partial: Record<string, unknown> = { ...DORMANT_AGENT_HOOK_CONFIG };
      delete partial[key];
      expect(agentHookConfigSchema.safeParse(partial).success, key).toBe(false);
    }
  });

  it('refuses a non-boolean flag and an unknown key', () => {
    expect(
      agentHookConfigSchema.safeParse({ ...DORMANT_AGENT_HOOK_CONFIG, react: 'true' }).success,
    ).toBe(false);
    expect(
      agentHookConfigSchema.safeParse({ ...DORMANT_AGENT_HOOK_CONFIG, renders: true }).success,
    ).toBe(false);
  });

  it('accepts the dormant configuration, which is frozen and entirely false', () => {
    expect(Object.isFrozen(DORMANT_AGENT_HOOK_CONFIG)).toBe(true);
    expect(Object.values(DORMANT_AGENT_HOOK_CONFIG)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(expectOk(parseAgentHookConfig(DORMANT_AGENT_HOOK_CONFIG))).toEqual(
      DORMANT_AGENT_HOOK_CONFIG,
    );
  });

  it('survives the JSON round trip it makes on the way to the page', () => {
    // This exact value is the `agent.config` hooks payload that returns the
    // agent to dormant — listeners detached, `fetch`/`XMLHttpRequest`
    // restored, fiber handlers unsubscribed — and it reaches the agent over a
    // WebSocket and a `window.postMessage` hop, so it has to be JSON-clean.
    expect(JSON.parse(JSON.stringify(DORMANT_AGENT_HOOK_CONFIG))).toEqual(
      DORMANT_AGENT_HOOK_CONFIG,
    );
  });

  it('reports a rejection by code, path and hint', () => {
    const error = expectErr(parseAgentHookConfig({ ...DORMANT_AGENT_HOOK_CONFIG, perf: 1 }));

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(error.hint).toBeTypeOf('string');
    expect(issuePaths(error)).toContain('perf');
  });
});

/*
 * ---------------------------------------------------------------------------
 * `ServerAgentSignals`
 * ---------------------------------------------------------------------------
 */

describe('serverAgentSignalsSchema', () => {
  it('declares exactly the six key names the preload reads', () => {
    expect(Object.keys(serverAgentSignalsSchema.shape)).toEqual([
      'http',
      'routeHandlers',
      'fetch',
      'prisma',
      'pg',
      'functions',
    ]);
    expect([...SERVER_AGENT_SIGNAL_KEYS]).toEqual(Object.keys(serverAgentSignalsSchema.shape));

    // The same six names the transcribed gate table is keyed by: a rename on
    // either side disables a signal without failing a build.
    expect(Object.keys(serverAgentSignalsSchema.shape).sort()).toEqual(
      Object.keys(CONTROL_SIGNAL_KINDS).sort(),
    );
  });

  it('parses a signal set into exactly those keys, in that order', () => {
    const parsed = expectOk(
      parseServerAgentSignals({
        functions: ['handleRequest'],
        pg: true,
        prisma: true,
        fetch: false,
        routeHandlers: true,
        http: true,
      }),
    );

    expect(Object.keys(parsed)).toEqual([...SERVER_AGENT_SIGNAL_KEYS]);
  });

  it('requires every key', () => {
    for (const key of SERVER_AGENT_SIGNAL_KEYS) {
      const partial: Record<string, unknown> = { ...DISABLED_SERVER_AGENT_SIGNALS };
      delete partial[key];
      expect(serverAgentSignalsSchema.safeParse(partial).success, key).toBe(false);
    }
  });

  it('accepts named functions and refuses names that are not usable', () => {
    expect(
      serverAgentSignalsSchema.safeParse({
        ...DISABLED_SERVER_AGENT_SIGNALS,
        functions: ['loadThings', 'quoteSomething'],
      }).success,
    ).toBe(true);

    // A bare string, a nested array and a non-string element are all shapes a
    // hand-built frame reaches for; none of them is a list of symbol names.
    for (const functions of [
      'handleRequest',
      [''],
      ['  '],
      ['two\nlines'],
      ['x'.repeat(201)],
      [42],
      [['handleRequest']],
    ]) {
      expect(
        serverAgentSignalsSchema.safeParse({ ...DISABLED_SERVER_AGENT_SIGNALS, functions }).success,
        JSON.stringify(functions),
      ).toBe(false);
    }
  });

  it('bounds the function list at twice the plan target ceiling', () => {
    const names = (count: number): string[] =>
      Array.from({ length: count }, (_unused, index) => `symbol${String(index)}`);

    expect(
      serverAgentSignalsSchema.safeParse({
        ...DISABLED_SERVER_AGENT_SIGNALS,
        functions: names(128),
      }).success,
    ).toBe(true);
    expect(
      serverAgentSignalsSchema.safeParse({
        ...DISABLED_SERVER_AGENT_SIGNALS,
        functions: names(129),
      }).success,
    ).toBe(false);
  });

  it('refuses an unknown key', () => {
    expect(
      serverAgentSignalsSchema.safeParse({ ...DISABLED_SERVER_AGENT_SIGNALS, postgres: true })
        .success,
    ).toBe(false);
  });

  it('accepts the disabled set, which is frozen, entirely false and names no symbol', () => {
    expect(Object.isFrozen(DISABLED_SERVER_AGENT_SIGNALS)).toBe(true);
    expect(DISABLED_SERVER_AGENT_SIGNALS).toEqual({
      http: false,
      routeHandlers: false,
      fetch: false,
      prisma: false,
      pg: false,
      functions: [],
    });
    expect(expectOk(parseServerAgentSignals(DISABLED_SERVER_AGENT_SIGNALS))).toEqual(
      DISABLED_SERVER_AGENT_SIGNALS,
    );
  });

  it('survives the JSON round trip it makes on the way to the preload', () => {
    // `server-agent.config` with no `captureId` carries this set, and the
    // preload disables its instrumentations and drops its tracer provider on
    // receiving it. It crosses a WebSocket, so an empty array and five
    // booleans is all it may contain.
    expect(JSON.parse(JSON.stringify(DISABLED_SERVER_AGENT_SIGNALS))).toEqual(
      DISABLED_SERVER_AGENT_SIGNALS,
    );
  });

  it('reports a rejection by code, path and hint', () => {
    const error = expectErr(
      parseServerAgentSignals({ ...DISABLED_SERVER_AGENT_SIGNALS, functions: 'loadThings' }),
    );

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(error.hint).toBeTypeOf('string');
    expect(issuePaths(error)).toContain('functions');
  });
});

/*
 * ---------------------------------------------------------------------------
 * `deriveAgentHookConfig`
 * ---------------------------------------------------------------------------
 */

describe('deriveAgentHookConfig', () => {
  /** Which hooks each action type is expected to arm, before the forced flag. */
  const HOOKS_PER_TYPE: Readonly<Record<InstrumentationActionType, readonly AgentHookKey[]>> = {
    'interaction-tracking': ['interactions'],
    'react-render-tracking': ['react', 'componentTree'],
    'state-tracking': ['state', 'react'],
    'fetch-tracking': ['fetch'],
    'perf-tracking': ['perf', 'errors'],
    'function-timing': [],
    'server-span': [],
    'db-query-tracking': [],
  };

  it('returns the dormant configuration for an empty plan, as a fresh object', () => {
    const derived = deriveAgentHookConfig([]);

    expect(derived).toEqual(DORMANT_AGENT_HOOK_CONFIG);
    expect(derived).not.toBe(DORMANT_AGENT_HOOK_CONFIG);
    expect(Object.isFrozen(derived)).toBe(false);
  });

  it('arms the hooks each action type is responsible for, and nothing else', () => {
    for (const type of INSTRUMENTATION_ACTION_TYPES) {
      const expected = HOOKS_PER_TYPE[type];
      const derived = deriveAgentHookConfig([action({ type })]);

      // The interaction listener is forced on whenever anything else is armed.
      const withForced =
        expected.length > 0 ? new Set<AgentHookKey>([...expected, 'interactions']) : new Set();

      expect(new Set(enabledHooks(derived)), type).toEqual(withForced);
      expect(expectOk(parseAgentHookConfig(derived)), type).toEqual(derived);
    }
  });

  it('treats the react hook as a hard prerequisite for state capture', () => {
    const derived = deriveAgentHookConfig([action({ type: 'state-tracking' })]);

    expect(derived.state).toBe(true);
    expect(derived.react).toBe(true);
  });

  it('arms the component-tree snapshot alongside render tracking', () => {
    const derived = deriveAgentHookConfig([action({ type: 'react-render-tracking' })]);

    expect(derived.react).toBe(true);
    expect(derived.componentTree).toBe(true);
  });

  it('forces the interaction listener on, because correlation depends on it', () => {
    // A plan that asked only for network tracing. The mechanism, not a
    // preference: `packages/telemetry/src/browser/fetch.ts` injects the
    // `traceparent` header only while `isTracedContext()` holds, and
    // `.../browser/interaction.ts` is what opens that context and mints the
    // trace root. Without the interaction hook the requests go out untraced,
    // the server's spans start a trace of their own, and the browser↔server
    // correlation the cross-tier timeline is built on breaks *silently* — the
    // capture still fills with events and the timeline still renders, as two
    // unrelated trees.
    const derived = deriveAgentHookConfig([action({ type: 'fetch-tracking' })]);

    expect(derived.fetch).toBe(true);
    expect(derived.interactions).toBe(true);
  });

  it('leaves the agent dormant for a purely patch-based plan', () => {
    const derived = deriveAgentHookConfig([
      action({ type: 'function-timing', mode: 'patch', symbol: 'loadThings' }),
      action({ type: 'server-span', mode: 'patch', symbol: 'handleRequest' }),
      action({ type: 'db-query-tracking' }),
    ]);

    expect(derived).toEqual(DORMANT_AGENT_HOOK_CONFIG);
  });

  it('unions the hooks of a mixed plan', () => {
    const derived = deriveAgentHookConfig([
      action({ type: 'react-render-tracking' }),
      action({ type: 'state-tracking' }),
      action({ type: 'perf-tracking' }),
      action({ type: 'fetch-tracking' }),
      action({ type: 'function-timing', mode: 'patch', symbol: 'loadThings' }),
    ]);

    expect(derived).toEqual({
      interactions: true,
      react: true,
      state: true,
      fetch: true,
      perf: true,
      errors: true,
      componentTree: true,
    });
  });

  it('does not depend on the order the actions arrive in', () => {
    const actions = [
      action({ type: 'perf-tracking' }),
      action({ type: 'state-tracking' }),
      action({ type: 'fetch-tracking' }),
    ];

    expect(deriveAgentHookConfig([...actions].reverse())).toEqual(deriveAgentHookConfig(actions));
  });

  it('skips an action the caller classifies as server work', () => {
    const serverSide = action({ type: 'fetch-tracking' });
    const browserSide = action({ type: 'perf-tracking' });

    const derived = deriveAgentHookConfig([serverSide, browserSide], {
      tiers: tierResolver({ [serverSide.id]: 'server', [browserSide.id]: 'browser' }),
    });

    expect(derived.fetch).toBe(false);
    expect(derived.perf).toBe(true);
    expect(derived.errors).toBe(true);
  });

  it('returns the dormant configuration when every action is server work', () => {
    const only = action({ type: 'fetch-tracking' });

    expect(deriveAgentHookConfig([only], { tiers: tierResolver({ [only.id]: 'server' }) })).toEqual(
      DORMANT_AGENT_HOOK_CONFIG,
    );
  });

  it('treats an unclassified or misbehaving resolver answer as unknown, not as server', () => {
    const unclassified = action({ type: 'react-render-tracking' });
    const nonsense: ActionTierResolver = {
      tierOf: () => 'sideways' as unknown as ActionTier,
    };
    const throwing: ActionTierResolver = {
      tierOf: () => {
        throw new Error('resolver failed');
      },
    };

    for (const tiers of [nonsense, throwing]) {
      const derived = deriveAgentHookConfig([unclassified], { tiers });
      expect(derived.react).toBe(true);
      expect(derived.interactions).toBe(true);
    }
  });

  it('leaves a frozen input untouched', () => {
    const actions = deepFrozen([
      action({ type: 'react-render-tracking' }),
      action({ type: 'fetch-tracking' }),
      action({ type: 'function-timing', mode: 'patch', symbol: 'timedStep' }),
    ]);
    const snapshot = JSON.parse(JSON.stringify(actions)) as unknown;

    expect(deriveAgentHookConfig(actions).react).toBe(true);
    expect(JSON.parse(JSON.stringify(actions))).toEqual(snapshot);
  });
});

/*
 * ---------------------------------------------------------------------------
 * `deriveServerAgentSignals`
 * ---------------------------------------------------------------------------
 */

describe('deriveServerAgentSignals', () => {
  it('collects nothing on the server tier for a purely browser-side plan', () => {
    // A plan that does not ask for the server tier collects no backend or
    // database telemetry. A render question must not read anyone's SQL, and
    // this is the assertion that keeps the promise: the preload gate in
    // `packages/telemetry/src/node/control.ts` resolves this set into the kinds
    // it will admit and drops every span outside them, so an all-false set is
    // what makes it collect nothing rather than collect quietly.
    const derived = deriveServerAgentSignals([
      action({ type: 'react-render-tracking' }),
      action({ type: 'state-tracking' }),
      action({ type: 'fetch-tracking' }),
      action({ type: 'interaction-tracking' }),
      action({ type: 'perf-tracking' }),
    ]);

    expect(derived).toEqual(DISABLED_SERVER_AGENT_SIGNALS);
    expect(derived.functions).toEqual([]);
  });

  it('never hands out the shared disabled constant or its array', () => {
    const derived = deriveServerAgentSignals([]);

    expect(derived).toEqual(DISABLED_SERVER_AGENT_SIGNALS);
    expect(derived).not.toBe(DISABLED_SERVER_AGENT_SIGNALS);
    expect(derived.functions).not.toBe(DISABLED_SERVER_AGENT_SIGNALS.functions);

    derived.functions.push('appended');
    expect(DISABLED_SERVER_AGENT_SIGNALS.functions).toEqual([]);
  });

  it('switches the request and route-handler spine on for any server work', () => {
    const derived = deriveServerAgentSignals([
      action({ type: 'server-span', mode: 'patch', symbol: 'handleRequest' }),
    ]);

    expect(derived.http).toBe(true);
    expect(derived.routeHandlers).toBe(true);
    expect(derived.functions).toEqual(['handleRequest']);
    expect(derived.prisma).toBe(false);
    expect(derived.pg).toBe(false);
    expect(derived.fetch).toBe(false);
  });

  it('enables both database flags for a query-tracking action', () => {
    const derived = deriveServerAgentSignals([action({ type: 'db-query-tracking' })]);

    expect(derived.prisma).toBe(true);
    expect(derived.pg).toBe(true);
    // The spine comes with them: the incoming-request span is where the
    // browser's `traceparent` is extracted and the route-handler span is what
    // parents the rest, so a database span collected without them arrives as a
    // flagged orphan instead of a row in a tree.
    expect(derived.http).toBe(true);
    expect(derived.routeHandlers).toBe(true);
    expect(derived.functions).toEqual([]);
  });

  it('switches the spine on for a patched symbol alone', () => {
    // The documented presence rule: a non-empty `functions` list is by itself
    // enough to request this tier, because a `function` span without the
    // request and route-handler spans it hangs off is an orphan too.
    const derived = deriveServerAgentSignals([
      action({ type: 'function-timing', mode: 'patch', symbol: 'timedStep' }),
    ]);

    expect(derived.functions).toEqual(['timedStep']);
    expect(derived.http).toBe(true);
    expect(derived.routeHandlers).toBe(true);
    expect(derived.prisma).toBe(false);
    expect(derived.pg).toBe(false);
    expect(derived.fetch).toBe(false);
  });

  it('enables outgoing request spans only when request tracing was planned', () => {
    const withFetch = deriveServerAgentSignals([
      action({ type: 'db-query-tracking' }),
      action({ type: 'fetch-tracking' }),
    ]);
    expect(withFetch.fetch).toBe(true);

    const withoutFetch = deriveServerAgentSignals([action({ type: 'db-query-tracking' })]);
    expect(withoutFetch.fetch).toBe(false);
  });

  it('does not let a browser-only request plan arm the server tier', () => {
    expect(deriveServerAgentSignals([action({ type: 'fetch-tracking' })])).toEqual(
      DISABLED_SERVER_AGENT_SIGNALS,
    );
  });

  it('names the patched symbols, deduplicated and sorted, whatever order they arrive in', () => {
    const actions = [
      action({ type: 'function-timing', mode: 'patch', symbol: 'zetaStep' }),
      action({ type: 'server-span', mode: 'patch', symbol: 'alphaStep' }),
      action({ type: 'function-timing', mode: 'patch', symbol: 'alphaStep' }),
      action({ type: 'function-timing', mode: 'patch', symbol: 'middleStep' }),
    ];

    const derived = deriveServerAgentSignals(actions);
    expect(derived.functions).toEqual(['alphaStep', 'middleStep', 'zetaStep']);
    expect(deriveServerAgentSignals([...actions].reverse())).toEqual(derived);
  });

  it('names only patch-mode symbols', () => {
    const derived = deriveServerAgentSignals([
      action({ type: 'function-timing', mode: 'runtime', symbol: 'notPatched' }),
      action({ type: 'server-span', mode: 'patch', symbol: 'patched' }),
    ]);

    expect(derived.functions).toEqual(['patched']);
  });

  it('excludes a symbol the caller classifies as browser work', () => {
    const inPage = action({ type: 'function-timing', mode: 'patch', symbol: 'inPageCallback' });
    const onServer = action({ type: 'function-timing', mode: 'patch', symbol: 'onServerCall' });

    const derived = deriveServerAgentSignals([inPage, onServer], {
      tiers: tierResolver({ [inPage.id]: 'browser', [onServer.id]: 'server' }),
    });

    expect(derived.functions).toEqual(['onServerCall']);
  });

  it('collects nothing when the only patched symbol lives in the page', () => {
    const inPage = action({ type: 'function-timing', mode: 'patch', symbol: 'inPageCallback' });

    expect(
      deriveServerAgentSignals([inPage], { tiers: tierResolver({ [inPage.id]: 'browser' }) }),
    ).toEqual(DISABLED_SERVER_AGENT_SIGNALS);
  });

  it('honours a server classification even when the action type does not imply one', () => {
    const relayed = action({ type: 'fetch-tracking' });

    const derived = deriveServerAgentSignals([relayed], {
      tiers: tierResolver({ [relayed.id]: 'server' }),
    });

    expect(derived.http).toBe(true);
    expect(derived.routeHandlers).toBe(true);
    expect(derived.fetch).toBe(true);
  });

  it('tolerates a resolver that throws, deriving from the action types alone', () => {
    const throwing: ActionTierResolver = {
      tierOf: () => {
        throw new Error('resolver failed');
      },
    };

    const derived = deriveServerAgentSignals(
      [action({ type: 'server-span', mode: 'patch', symbol: 'handleRequest' })],
      { tiers: throwing },
    );

    expect(derived.functions).toEqual(['handleRequest']);
    expect(derived.http).toBe(true);
  });

  it('derives a schema-valid set, keyed in wire order, for every representative plan', () => {
    const plans: readonly InstrumentationAction[][] = [
      [],
      [action({ type: 'react-render-tracking' }), action({ type: 'perf-tracking' })],
      [action({ type: 'db-query-tracking' }), action({ type: 'fetch-tracking' })],
      [action({ type: 'server-span', mode: 'patch', symbol: 'handleRequest' })],
      [
        action({ type: 'function-timing', mode: 'patch', symbol: 'timedStep' }),
        action({ type: 'db-query-tracking' }),
        action({ type: 'interaction-tracking' }),
      ],
    ];

    for (const plan of plans) {
      const derived = deriveServerAgentSignals(plan);
      const description = plan.map((item) => item.type).join('+') || 'empty plan';

      expect(expectOk(parseServerAgentSignals(derived)), description).toEqual(derived);
      expect(Object.keys(derived), description).toEqual([...SERVER_AGENT_SIGNAL_KEYS]);
    }
  });

  it('produces a set that parses and survives a JSON round trip, leaving its frozen input untouched', () => {
    const actions = deepFrozen([
      action({ type: 'db-query-tracking' }),
      action({ type: 'server-span', mode: 'patch', symbol: 'handleRequest' }),
      action({ type: 'fetch-tracking' }),
    ]);
    const snapshot = JSON.parse(JSON.stringify(actions)) as unknown;

    const derived: ServerAgentSignals = deriveServerAgentSignals(actions);

    expect(expectOk(parseServerAgentSignals(derived))).toEqual(derived);
    expect(JSON.parse(JSON.stringify(derived))).toEqual(derived);
    expect(JSON.parse(JSON.stringify(actions))).toEqual(snapshot);
  });
});
