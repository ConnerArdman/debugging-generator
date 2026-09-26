/**
 * Tests for `ExtensionState.applyProgress` in `./state.ts`: how the host folds
 * `session.progress` frames into the progress list the editor view renders.
 *
 * The list must stay exactly what the service sent, in the order it sent it
 * (AAP §0.5.4), while a stage that reports again is handled per **episode**: a
 * follow-up that needs a new capture runs `plan`, `instrument` and `capture` a
 * second time after `followup` (AAP §0.4.2), and those rows must land after the
 * follow-up that caused them instead of overwriting the first run's rows.
 * Pinned here, through the store's public API only:
 *
 *   - a stage header moving from `running` to `done` is replaced in place;
 *   - a follow-up's second episode is appended chronologically and leaves the
 *     first episode's rows untouched;
 *   - a `done` row re-announced for a run that is no longer the tail replaces
 *     its row rather than duplicating it;
 *   - every row carries a unique receipt time that survives its replacement,
 *     which is the identity the view keys it by;
 *   - the list is bounded without losing any episode's summary: past the
 *     bound the oldest episodes shrink to their header and failed rows, whole
 *     episodes leave from the front only once every older one is a summary,
 *     and the newest episodes keep every row;
 *   - progress of any session other than the active one is ignored.
 *
 * ## The `vscode` substitute
 *
 * The editor supplies the `vscode` module at runtime and no installable package
 * provides it, so `vi.mock` registers a factory for the bare specifier. The
 * store reaches only `EventEmitter` (its change event) and the `Disposable`
 * contract, so the substitute carries exactly those two.
 *
 * Every payload and the session record are validated by `@debuggen/protocol`'s
 * own parsers before use, so no case can pass on a shape the service could
 * never send. Fixture strings are the product's own stage titles and neutral
 * vocabulary written for this suite; no inspected project's names appear.
 */

import { describe, expect, it, vi } from 'vitest';

import { parseSessionProgressPayload, parseSessionRecord } from '@debuggen/protocol';
import type {
  ProgressStage,
  ProgressStatus,
  SessionProgressPayload,
  SessionRecord,
} from '@debuggen/protocol';

import { ExtensionState } from './state';
import type { ProgressEntry } from './webview-messages';

vi.mock('vscode', () => {
  /** The change-event emitter the store fires one snapshot per burst through. */
  class EventEmitter<T> {
    private listeners: ((value: T) => void)[] = [];

    readonly event = (listener: (value: T) => void): { dispose: () => void } => {
      this.listeners.push(listener);
      return {
        dispose: () => {
          this.listeners = this.listeners.filter((held) => held !== listener);
        },
      };
    };

    fire(value: T): void {
      for (const listener of [...this.listeners]) {
        listener(value);
      }
    }

    dispose(): void {
      this.listeners = [];
    }
  }

  /** The editor's disposable, for any consumer that constructs one. */
  class Disposable {
    constructor(private readonly onDispose: () => void) {}

    dispose(): void {
      this.onDispose();
    }
  }

  return { EventEmitter, Disposable };
});

/** The session every case activates. */
const SESSION_ID = 'ses_progress_state_0001';

/** The service base URL the store is configured with, which owns the adopted session. */
const SERVICE_URL = 'http://127.0.0.1:43117';

/** A session the store is not showing. */
const OTHER_SESSION_ID = 'ses_progress_state_0002';

/** A fixed clock, so receipt times are deterministic. */
const FIXED_NOW = 1_760_000_000_000;

/** The bound `state.ts` enforces (`MAX_PROGRESS_ENTRIES`). */
const MAX_PROGRESS_ENTRIES = 1_000;

/**
 * A stored session, validated by the protocol's own schema.
 *
 * @param id The session id.
 * @returns The record.
 */
function sessionRecord(id: string): SessionRecord {
  const parsed = parseSessionRecord({
    id,
    projectRoot: '/workspace/sample-project',
    projectName: 'sample-project',
    devServerUrl: 'http://127.0.0.1:3000/',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    status: 'understanding',
    question: 'Why is this interaction slow?',
    followUps: [],
    relevantFiles: [],
    plans: [],
    modifications: [],
    captures: [],
    panelIds: [],
    analyses: [],
    cleanup: { status: 'pending', conflicts: [] },
    promptVersions: {},
    provider: { id: 'deterministic' },
  });
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

/**
 * One `session.progress` payload, validated by the protocol's own parser.
 *
 * @param stage The reporting stage.
 * @param status Its status.
 * @param message The line the service composed.
 * @param sessionId The session it belongs to; the active one by default.
 * @returns The payload.
 */
function progress(
  stage: ProgressStage,
  status: ProgressStatus,
  message: string,
  sessionId: string = SESSION_ID,
): SessionProgressPayload {
  const parsed = parseSessionProgressPayload({ sessionId, stage, status, message });
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

/**
 * A store with the fixture session active and no progress yet.
 *
 * The session is made active the only way the store allows —
 * `adoptSession`, as the commands do with the service's answer — because a
 * pushed record never becomes the active session on its own.
 *
 * @param now The store's clock; a fixed instant by default.
 * @returns The store; each case disposes it.
 */
function activeState(now: () => number = () => FIXED_NOW): ExtensionState {
  const state = new ExtensionState({
    serviceUrl: SERVICE_URL,
    provider: 'deterministic',
    now,
  });
  state.adoptSession(sessionRecord(SESSION_ID), SERVICE_URL);
  return state;
}

/**
 * A clock that advances one millisecond per reading, so every receipt time is
 * distinct and the first-arrival time of a row is observable.
 *
 * @returns The clock.
 */
function tickingClock(): () => number {
  let tick = FIXED_NOW;
  return () => {
    tick += 1;
    return tick;
  };
}

/**
 * The frames of one follow-up answered from stored evidence: the follow-up's
 * group, then an analysis episode with its header, ten findings and, when
 * asked, a failed row.
 *
 * @param cycle Which follow-up this is; it numbers the findings.
 * @param withFailure Whether the analysis episode reports a failed row too.
 * @returns The frames, in arrival order.
 */
function evidenceFollowUp(cycle: number, withFailure = false): SessionProgressPayload[] {
  return [
    progress('followup', 'running', 'Evaluating follow-up question'),
    progress('followup', 'done', 'Evaluating follow-up question'),
    progress('analyze', 'running', 'Analyzing captured evidence'),
    ...Array.from({ length: 10 }, (_, index) =>
      progress('analyze', 'done', `Observation ${String(cycle)}.${String(index)}`),
    ),
    ...(withFailure
      ? [progress('analyze', 'failed', `Summary ${String(cycle)} was rejected`)]
      : []),
    progress('analyze', 'done', 'Analyzing captured evidence'),
  ];
}

/**
 * The first row of every episode (contiguous run of one stage), in order.
 *
 * @param entries The store's progress list.
 * @returns Each episode's first row as a `stage status message` line.
 */
function episodeHeads(entries: readonly ProgressEntry[]): string[] {
  return lines(entries).filter((_, index) => entries[index - 1]?.stage !== entries[index]?.stage);
}

/**
 * Applies payloads in order.
 *
 * @param state The store.
 * @param payloads The frames, in arrival order.
 */
function applyAll(state: ExtensionState, payloads: readonly SessionProgressPayload[]): void {
  for (const payload of payloads) {
    state.applyProgress(payload);
  }
}

/**
 * The rows as `stage status message` lines — what the view renders, in order.
 *
 * @param entries The store's progress list.
 * @returns One line per row.
 */
function lines(entries: readonly ProgressEntry[]): string[] {
  return entries.map((entry) => `${entry.stage} ${entry.status} ${entry.message}`);
}

/** The frames of a first run, from the question to the generated panel. */
const FIRST_RUN: readonly SessionProgressPayload[] = [
  progress('understand', 'running', 'Understanding problem'),
  progress('understand', 'done', 'Understanding problem'),
  progress('investigate', 'running', 'Investigating code'),
  progress('investigate', 'done', 'Found SampleComponent'),
  progress('investigate', 'done', 'Traced event handler'),
  progress('investigate', 'done', 'Found /sample/route'),
  progress('investigate', 'done', 'Found database dependency'),
  progress('investigate', 'done', 'Investigating code'),
  progress('plan', 'running', 'Planning instrumentation'),
  progress('plan', 'done', 'Planning instrumentation'),
  progress('instrument', 'running', 'Preparing instrumentation'),
  progress('instrument', 'done', 'Browser performance'),
  progress('instrument', 'done', 'Network tracing'),
  progress('instrument', 'done', 'Ready to capture'),
  progress('instrument', 'done', 'Preparing instrumentation'),
  progress('capture', 'running', 'Capturing runtime evidence'),
  progress('capture', 'done', 'Capturing runtime evidence'),
  progress('analyze', 'running', 'Analyzing captured evidence'),
  progress('analyze', 'done', 'Analyzing captured evidence'),
  progress('generate-panel', 'running', 'Generating debugging panel'),
  progress('generate-panel', 'done', 'Generating debugging panel'),
];

/** What the first run leaves in the list: every header settled in place. */
const FIRST_RUN_LINES: readonly string[] = [
  'understand done Understanding problem',
  'investigate done Investigating code',
  'investigate done Found SampleComponent',
  'investigate done Traced event handler',
  'investigate done Found /sample/route',
  'investigate done Found database dependency',
  'plan done Planning instrumentation',
  'instrument done Preparing instrumentation',
  'instrument done Browser performance',
  'instrument done Network tracing',
  'instrument done Ready to capture',
  'capture done Capturing runtime evidence',
  'analyze done Analyzing captured evidence',
  'generate-panel done Generating debugging panel',
];

/** A follow-up that needs a new capture: followup, then plan and instrument again. */
const NEW_CAPTURE_FOLLOW_UP: readonly SessionProgressPayload[] = [
  progress('followup', 'running', 'Evaluating follow-up question'),
  progress('followup', 'done', 'Evaluating follow-up question'),
  progress('plan', 'running', 'Planning instrumentation'),
  progress('plan', 'done', 'Planning instrumentation'),
  progress('instrument', 'running', 'Preparing instrumentation'),
  progress('instrument', 'done', 'Server spans'),
  progress('instrument', 'done', 'Ready to capture'),
];

describe('ExtensionState.applyProgress', () => {
  it('replaces a stage header in place when it moves from running to done', () => {
    const state = activeState();

    state.applyProgress(progress('understand', 'running', 'Understanding problem'));
    expect(lines(state.progress)).toEqual(['understand running Understanding problem']);

    state.applyProgress(progress('understand', 'done', 'Understanding problem'));
    expect(lines(state.progress)).toEqual(['understand done Understanding problem']);

    // A later row of another stage, then the header re-announced: still one row, still first.
    state.applyProgress(progress('investigate', 'running', 'Investigating code'));
    state.applyProgress(progress('investigate', 'done', 'Investigating code'));
    expect(lines(state.progress)).toEqual([
      'understand done Understanding problem',
      'investigate done Investigating code',
    ]);
    state.dispose();
  });

  it('appends a failed row beside its stage header instead of overwriting it', () => {
    const state = activeState();

    applyAll(state, [
      progress('plan', 'running', 'Planning instrumentation'),
      progress('plan', 'failed', 'No adapter accepted the plan'),
    ]);

    expect(lines(state.progress)).toEqual([
      'plan running Planning instrumentation',
      'plan failed No adapter accepted the plan',
    ]);
    state.dispose();
  });

  it('settles the first run into one row per step, in arrival order', () => {
    const state = activeState();

    applyAll(state, FIRST_RUN);

    expect(lines(state.progress)).toEqual(FIRST_RUN_LINES);
    state.dispose();
  });

  it('appends a follow-up episode after the follow-up and leaves the first episode untouched', () => {
    const state = activeState();
    applyAll(state, FIRST_RUN);
    const firstEpisode = state.progress;

    applyAll(state, NEW_CAPTURE_FOLLOW_UP);

    expect(lines(state.progress)).toEqual([
      ...FIRST_RUN_LINES,
      'followup done Evaluating follow-up question',
      'plan done Planning instrumentation',
      'instrument running Preparing instrumentation',
      'instrument done Server spans',
      'instrument done Ready to capture',
    ]);
    // The first run's rows are the very same entries, at the very same positions.
    firstEpisode.forEach((entry, index) => {
      expect(state.progress[index]).toBe(entry);
    });
    // The snapshot the webview receives carries the same chronological order.
    expect(lines(state.toWebviewState().progress)).toEqual(lines(state.progress));

    // The second episode's header settles in place, inside its own episode.
    state.applyProgress(progress('instrument', 'done', 'Preparing instrumentation'));
    expect(lines(state.progress).slice(-3)).toEqual([
      'instrument done Preparing instrumentation',
      'instrument done Server spans',
      'instrument done Ready to capture',
    ]);
    expect(state.progress).toHaveLength(FIRST_RUN_LINES.length + 5);
    state.dispose();
  });

  it('replaces a done row re-announced for a run that is no longer the tail', () => {
    const state = activeState();
    applyAll(state, [
      progress('capture', 'running', 'Capturing runtime evidence'),
      progress('capture', 'done', 'Capturing runtime evidence'),
      progress('analyze', 'running', 'Analyzing captured evidence'),
    ]);
    const before = state.progress;

    state.applyProgress(progress('capture', 'done', 'Capturing runtime evidence'));

    expect(lines(state.progress)).toEqual([
      'capture done Capturing runtime evidence',
      'analyze running Analyzing captured evidence',
    ]);
    expect(state.progress[1]).toBe(before[1]);
    state.dispose();
  });

  it('appends a done row that matches nothing in its latest run', () => {
    const state = activeState();
    applyAll(state, [
      progress('capture', 'running', 'Capturing runtime evidence'),
      progress('analyze', 'running', 'Analyzing captured evidence'),
      progress('capture', 'done', 'No telemetry was captured.'),
    ]);

    expect(lines(state.progress)).toEqual([
      'capture running Capturing runtime evidence',
      'analyze running Analyzing captured evidence',
      'capture done No telemetry was captured.',
    ]);
    state.dispose();
  });

  it('keeps the time a row first arrived when the row is replaced in place', () => {
    const state = activeState(tickingClock());

    state.applyProgress(progress('understand', 'running', 'Understanding problem'));
    const firstArrival = state.progress[0]?.ts;
    state.applyProgress(progress('investigate', 'running', 'Investigating code'));
    state.applyProgress(progress('understand', 'done', 'Understanding problem'));
    state.applyProgress(progress('investigate', 'done', 'Investigating code'));

    expect(lines(state.progress)).toEqual([
      'understand done Understanding problem',
      'investigate done Investigating code',
    ]);
    expect(firstArrival).toBeDefined();
    expect(state.progress[0]?.ts).toBe(firstArrival);
    expect(state.progress[1]?.ts).toBeGreaterThan(firstArrival ?? Number.POSITIVE_INFINITY);
    state.dispose();
  });

  it('stamps rows of one millisecond, or after the clock steps back, with distinct increasing times', () => {
    let clock = FIXED_NOW;
    const state = activeState(() => clock);

    // Three frames within one millisecond.
    applyAll(state, [
      progress('understand', 'running', 'Understanding problem'),
      progress('investigate', 'running', 'Investigating code'),
      progress('investigate', 'done', 'Found SampleComponent'),
    ]);
    // The wall clock steps back a minute, then moves on past the stamped times.
    clock = FIXED_NOW - 60_000;
    state.applyProgress(progress('investigate', 'done', 'Traced event handler'));
    clock = FIXED_NOW + 10;
    state.applyProgress(progress('plan', 'running', 'Planning instrumentation'));

    expect(state.progress.map((entry) => entry.ts)).toEqual([
      FIXED_NOW,
      FIXED_NOW + 1,
      FIXED_NOW + 2,
      FIXED_NOW + 3,
      FIXED_NOW + 10,
    ]);
    state.dispose();
  });

  it('holds every row of a long session while it fits the bound', () => {
    const state = activeState(tickingClock());
    applyAll(state, FIRST_RUN);
    applyAll(state, NEW_CAPTURE_FOLLOW_UP);
    for (let cycle = 0; cycle < 50; cycle += 1) {
      applyAll(state, evidenceFollowUp(cycle));
    }

    // 14 + 5 rows, then 12 per follow-up answered from evidence: nothing is compacted.
    expect(state.progress).toHaveLength(FIRST_RUN_LINES.length + 5 + 50 * 12);
    expect(state.progress.length).toBeLessThan(MAX_PROGRESS_ENTRIES);
    expect(lines(state.progress).slice(0, FIRST_RUN_LINES.length)).toEqual(FIRST_RUN_LINES);
    expect(lines(state.progress)).toContain('analyze done Observation 0.0');
    state.dispose();
  });

  it('past the bound, compacts the oldest episodes to their header and failed rows', () => {
    const state = activeState(tickingClock());
    applyAll(state, FIRST_RUN);
    const cycles = 90;
    const failing = (cycle: number): boolean => cycle % 10 === 3;
    const tracked = new Map<number, ProgressEntry>();
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      applyAll(state, evidenceFollowUp(cycle, failing(cycle)));
      // The follow-up's analysis header, as it stood when its episode settled.
      const header = state.progress.findLast(
        (entry) => entry.stage === 'analyze' && entry.message === 'Analyzing captured evidence',
      );
      if (header !== undefined) {
        tracked.set(cycle, header);
      }
    }
    const kept = state.progress;
    const keptLines = lines(kept);

    expect(kept.length).toBeLessThanOrEqual(MAX_PROGRESS_ENTRIES);
    expect(Object.isFrozen(kept)).toBe(true);

    // Every episode keeps its service header, settled, in arrival order.
    const expectedHeads = [
      'understand done Understanding problem',
      'investigate done Investigating code',
      'plan done Planning instrumentation',
      'instrument done Preparing instrumentation',
      'capture done Capturing runtime evidence',
      'analyze done Analyzing captured evidence',
      'generate-panel done Generating debugging panel',
      ...Array.from({ length: cycles }, () => [
        'followup done Evaluating follow-up question',
        'analyze done Analyzing captured evidence',
      ]).flat(),
    ];
    expect(episodeHeads(kept)).toEqual(expectedHeads);

    // Every failure survives, wherever its episode was compacted.
    const failedMessages = kept
      .filter((entry) => entry.status === 'failed')
      .map((entry) => entry.message);
    expect(failedMessages).toEqual(
      Array.from({ length: cycles }, (_, cycle) => cycle)
        .filter(failing)
        .map((cycle) => `Summary ${String(cycle)} was rejected`),
    );

    // The oldest detail rows went first; the newest follow-ups keep every row.
    expect(keptLines).not.toContain('investigate done Found SampleComponent');
    const detailKept = Array.from({ length: cycles }, (_, cycle) =>
      Array.from({ length: 10 }, (_, index) =>
        keptLines.includes(`analyze done Observation ${String(cycle)}.${String(index)}`),
      ),
    );
    detailKept.forEach((cycleRows) => {
      expect(new Set(cycleRows).size).toBe(1);
    });
    const firstWhole = detailKept.findIndex((cycleRows) => cycleRows[0] === true);
    expect(firstWhole).toBeGreaterThan(0);
    expect(detailKept.slice(firstWhole).every((cycleRows) => cycleRows[0] === true)).toBe(true);
    expect(detailKept.slice(0, firstWhole).every((cycleRows) => cycleRows[0] === false)).toBe(true);

    // A surviving header is the very row it was, with the time it first arrived.
    for (const header of tracked.values()) {
      expect(kept).toContain(header);
    }
    const times = kept.map((entry) => entry.ts);
    expect(times).toEqual([...times].sort((left, right) => left - right));
    expect(new Set(times).size).toBe(times.length);

    // What the webview receives is the same bounded list.
    expect(lines(state.toWebviewState().progress)).toEqual(keptLines);
    state.dispose();
  });

  it('drops whole episodes from the front only once every older episode is a summary', () => {
    const state = activeState(tickingClock());
    const total = MAX_PROGRESS_ENTRIES + 5;
    for (let index = 0; index < total; index += 1) {
      const stage = index % 2 === 0 ? 'capture' : 'analyze';
      state.applyProgress(progress(stage, 'done', `Attempt ${String(index)}`));
    }

    const kept = state.progress;
    expect(kept).toHaveLength(MAX_PROGRESS_ENTRIES);
    expect(kept[0]?.message).toBe('Attempt 5');
    expect(kept.at(-1)?.message).toBe(`Attempt ${String(total - 1)}`);
    // Whole one-row episodes left; no episode was cut, so stages still alternate.
    kept.forEach((entry, index) => {
      expect(entry.stage).not.toBe(kept[index - 1]?.stage);
    });
    state.dispose();
  });

  it('keeps the header, failed rows and newest rows of one episode longer than the bound', () => {
    const state = activeState(tickingClock());
    state.applyProgress(progress('analyze', 'running', 'Analyzing captured evidence'));
    const total = MAX_PROGRESS_ENTRIES + 4;
    for (let index = 0; index < total; index += 1) {
      state.applyProgress(
        index === 3
          ? progress('analyze', 'failed', 'Observation 3 was rejected')
          : progress('analyze', 'done', `Observation ${String(index)}`),
      );
    }

    const kept = state.progress;
    expect(kept).toHaveLength(MAX_PROGRESS_ENTRIES);
    expect(lines(kept).slice(0, 2)).toEqual([
      'analyze running Analyzing captured evidence',
      'analyze failed Observation 3 was rejected',
    ]);
    expect(kept.at(-1)?.message).toBe(`Observation ${String(total - 1)}`);
    expect(lines(kept)).not.toContain('analyze done Observation 0');
    // The detail rows kept are the newest ones, in arrival order.
    const numbers = kept.slice(2).map((entry) => Number(entry.message.replace('Observation ', '')));
    expect(numbers).toEqual(
      Array.from({ length: numbers.length }, (_, index) => total - numbers.length + index),
    );

    // An in-place replacement at the bound neither grows nor shrinks the list.
    const newest = kept.at(-1);
    state.applyProgress(progress('analyze', 'done', `Observation ${String(total - 1)}`));
    expect(state.progress).toHaveLength(MAX_PROGRESS_ENTRIES);
    expect(state.progress.at(-1)?.ts).toBe(newest?.ts);
    // The header settles in place and stays first.
    state.applyProgress(progress('analyze', 'done', 'Analyzing captured evidence'));
    expect(lines(state.progress)[0]).toBe('analyze done Analyzing captured evidence');
    expect(state.progress).toHaveLength(MAX_PROGRESS_ENTRIES);
    state.dispose();
  });

  it('ignores progress of any session other than the active one', () => {
    const state = activeState();
    state.applyProgress(progress('understand', 'running', 'Understanding problem'));
    const before = state.progress;

    state.applyProgress(progress('understand', 'done', 'Understanding problem', OTHER_SESSION_ID));
    state.applyProgress(progress('plan', 'running', 'Planning instrumentation', OTHER_SESSION_ID));

    expect(state.progress).toBe(before);
    expect(lines(state.progress)).toEqual(['understand running Understanding problem']);
    state.dispose();
  });

  it('ignores progress when no session is active', () => {
    const state = new ExtensionState({
      serviceUrl: 'http://127.0.0.1:43117',
      provider: 'deterministic',
      now: () => FIXED_NOW,
    });

    state.applyProgress(progress('understand', 'running', 'Understanding problem'));

    expect(state.progress).toEqual([]);
    state.dispose();
  });
});
