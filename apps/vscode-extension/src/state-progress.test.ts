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
 *   - progress of any session other than the active one is ignored;
 *   - a replay of stored history — the same frames under the send times they
 *     were first sent with — adds nothing and notifies no one, also after
 *     compaction, after the same session is re-adopted and for frames a
 *     creation window held, while a frame only the replay delivers is applied
 *     once and a follow-up's new episode still opens;
 *   - a row settles its running row in place when the service words the two
 *     differently at a word boundary (a failed stage's header, a degradation
 *     notice and its ✕), and a corrected ✓ supersedes the ✕ it corrects;
 *   - ending the session drops the rows still running, so the live view of an
 *     ended session equals the same session reopened.
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

import { DEGRADATION_SENTENCE_LEAD, ExtensionState } from './state';
import type { ProgressEntry, WebviewState } from './webview-messages';

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
 * @param overrides Members that differ from the in-progress default, such as
 *   an `ended` status and a later `updatedAt`.
 * @returns The record.
 */
function sessionRecord(
  id: string,
  overrides: Readonly<Partial<Pick<SessionRecord, 'status' | 'updatedAt'>>> = {},
): SessionRecord {
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
    ...overrides,
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
 * One `session.progress` payload of the active session carrying a detail
 * line, validated by the protocol's own parser.
 *
 * @param stage The reporting stage.
 * @param status Its status.
 * @param message The line the service composed.
 * @param detail The detail the service attached.
 * @returns The payload.
 */
function detailed(
  stage: ProgressStage,
  status: ProgressStatus,
  message: string,
  detail: string,
): SessionProgressPayload {
  const parsed = parseSessionProgressPayload({
    sessionId: SESSION_ID,
    stage,
    status,
    message,
    detail,
  });
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

// ---------------------------------------------------------------------------
// Replays of stored history
// ---------------------------------------------------------------------------

/**
 * When the service first sent a transcript's frames: the service's own clock,
 * deliberately far from the editor's {@link FIXED_NOW}, because the envelope
 * `ts` and the receipt time the store stamps are different clocks.
 */
const SENT_T0 = 1_790_000_000_000;

/** One frame as the service sends it: the payload and its envelope `ts`. */
interface SentFrame {
  readonly payload: SessionProgressPayload;
  readonly sentAt: number;
}

/**
 * Stamps payloads with the send times their envelopes carry, one millisecond
 * apart, as the service's emitter does.
 *
 * @param payloads The frames, in the order the service sent them.
 * @param from The first frame's send time.
 * @returns The frames with their send times.
 */
function sent(payloads: readonly SessionProgressPayload[], from: number = SENT_T0): SentFrame[] {
  return payloads.map((payload, index) => ({ payload, sentAt: from + index }));
}

/**
 * Applies sent frames in order, each with its send time — what
 * `src/extension.ts` does with every `session.progress` envelope.
 *
 * @param state The store.
 * @param frames The frames, in arrival order.
 */
function applySent(state: ExtensionState, frames: readonly SentFrame[]): void {
  for (const { payload, sentAt } of frames) {
    state.applyProgress(payload, sentAt);
  }
}

/**
 * Records every snapshot the store notifies from now on.
 *
 * @param state The store.
 * @returns The live list of notified snapshots.
 */
function recordChanges(state: ExtensionState): WebviewState[] {
  const snapshots: WebviewState[] = [];
  state.onDidChange((snapshot) => {
    snapshots.push(snapshot);
  });
  return snapshots;
}

/** Lets every coalesced flush the store queued on the microtask queue run. */
async function flushed(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * The rows still drawn with a spinner.
 *
 * @param entries The store's progress list.
 * @returns The `running` rows.
 */
function runningRows(entries: readonly ProgressEntry[]): ProgressEntry[] {
  return entries.filter((entry) => entry.status === 'running');
}

/** The ✕ sentence of AAP §0.5.5 for one signal, as the service words it. */
const SERVER_SPANS_UNAVAILABLE = `${DEGRADATION_SENTENCE_LEAD} Server spans: the dev server runs without the preload.`;

/** The notice the service announces first for the same signal, still `running`. */
const SERVER_SPANS_NOTICE = `${SERVER_SPANS_UNAVAILABLE} Continuing with: Browser performance.`;

/** The hint the service attaches to the ✕ row as its detail. */
const RELAUNCH_HINT = 'Restart the dev server with the Debug Generator preload.';

describe('ExtensionState.applyProgress: replays of stored history', () => {
  it('adds nothing and notifies no one when the history is replayed with its send times', async () => {
    const state = activeState(tickingClock());
    const transcript = sent(FIRST_RUN);
    applySent(state, transcript);
    const settled = state.progress;
    expect(lines(settled)).toEqual(FIRST_RUN_LINES);
    await flushed();
    const changes = recordChanges(state);

    // Three re-reads of the session (a resync, a reopen, an end's detail read),
    // each replaying every stored row under a new envelope id.
    for (let replay = 0; replay < 3; replay += 1) {
      applySent(state, transcript);
    }
    await flushed();

    expect(state.progress).toBe(settled);
    expect(changes).toEqual([]);
    state.dispose();
  });

  it('still adds nothing once compaction has dropped the rows the replay names', () => {
    const state = activeState(tickingClock());
    const transcript = sent([
      ...FIRST_RUN,
      ...Array.from({ length: 90 }, (_, cycle) => evidenceFollowUp(cycle, cycle % 10 === 3)).flat(),
    ]);
    applySent(state, transcript);
    const kept = state.progress;
    expect(kept.length).toBeLessThanOrEqual(MAX_PROGRESS_ENTRIES);
    // The oldest detail rows were compacted away…
    expect(lines(kept)).not.toContain('investigate done Found SampleComponent');

    // …and neither the whole history nor the service's 500-row window brings them back.
    applySent(state, transcript);
    applySent(state, transcript.slice(-500));

    expect(state.progress).toBe(kept);
    state.dispose();
  });

  it('still adds nothing after the session in view is reopened and re-adopted', () => {
    const state = activeState(tickingClock());
    const transcript = sent(FIRST_RUN);
    applySent(state, transcript);
    const settled = state.progress;

    // Reopening the session already in view: its replay may beat the answer…
    const reopening = state.beginSessionCreation();
    applySent(state, transcript);
    reopening.adopt(sessionRecord(SESSION_ID, { updatedAt: FIXED_NOW + 5 }), SERVICE_URL);
    // …or follow it, and the record may be adopted again directly.
    state.adoptSession(sessionRecord(SESSION_ID, { updatedAt: FIXED_NOW + 6 }), SERVICE_URL);
    applySent(state, transcript);

    expect(state.activeSession?.updatedAt).toBe(FIXED_NOW + 6);
    expect(state.progress).toBe(settled);
    state.dispose();
  });

  it('keeps the send time of frames a creation window held, so a later replay adds nothing', () => {
    const state = new ExtensionState({
      serviceUrl: SERVICE_URL,
      provider: 'deterministic',
      now: tickingClock(),
    });
    const transcript = sent(FIRST_RUN);

    // Reopening a stored session: its replay arrives before the answer and is held.
    const reopening = state.beginSessionCreation();
    applySent(state, transcript);
    expect(state.progress).toEqual([]);
    reopening.adopt(sessionRecord(SESSION_ID), SERVICE_URL);
    const adopted = state.progress;
    expect(lines(adopted)).toEqual(FIRST_RUN_LINES);

    // A resync after a reconnect replays the same history.
    applySent(state, transcript);

    expect(state.progress).toBe(adopted);
    state.dispose();
  });

  it('forgets the applied frames when another session becomes active', () => {
    const state = activeState(tickingClock());
    const transcript = sent(FIRST_RUN);
    applySent(state, transcript);

    state.adoptSession(sessionRecord(OTHER_SESSION_ID), SERVICE_URL);
    expect(state.progress).toEqual([]);
    // Reopened later, the first session is replayed into an empty list, whole.
    state.adoptSession(sessionRecord(SESSION_ID), SERVICE_URL);
    applySent(state, transcript);

    expect(lines(state.progress)).toEqual(FIRST_RUN_LINES);
    state.dispose();
  });

  it('applies, once, the frames only the replay delivers', () => {
    const state = activeState(tickingClock());
    const transcript = sent(FIRST_RUN);
    const captureDone = transcript.findIndex(
      ({ payload }) => payload.stage === 'capture' && payload.status === 'done',
    );
    // Live, the socket lost the capture stage's closing row and the last two frames.
    applySent(state, transcript.filter((_, index) => index !== captureDone).slice(0, -2));
    expect(lines(state.progress)).toContain('capture running Capturing runtime evidence');
    expect(state.progress.some((entry) => entry.stage === 'generate-panel')).toBe(false);

    applySent(state, transcript);
    const repaired = state.progress;
    // The missed closing row settled its header in place; the missed tail was appended.
    expect(lines(repaired)).toEqual(FIRST_RUN_LINES);

    applySent(state, transcript);
    expect(state.progress).toBe(repaired);
    state.dispose();
  });

  it("opens a follow-up's genuinely new episode, which carries new send times", () => {
    const state = activeState(tickingClock());
    const firstRun = sent(FIRST_RUN);
    const followUp = sent(NEW_CAPTURE_FOLLOW_UP, SENT_T0 + 60_000);
    const expected = [
      ...FIRST_RUN_LINES,
      'followup done Evaluating follow-up question',
      'plan done Planning instrumentation',
      'instrument running Preparing instrumentation',
      'instrument done Server spans',
      'instrument done Ready to capture',
    ];

    applySent(state, firstRun);
    applySent(state, followUp);
    expect(lines(state.progress)).toEqual(expected);

    // The whole history replayed adds nothing to either episode.
    applySent(state, [...firstRun, ...followUp]);
    expect(lines(state.progress)).toEqual(expected);
    state.dispose();
  });

  it('applies a frame without a send time exactly as before, every time', async () => {
    const state = activeState(tickingClock());
    state.applyProgress(progress('understand', 'running', 'Understanding problem'));
    await flushed();
    const changes = recordChanges(state);

    state.applyProgress(progress('understand', 'running', 'Understanding problem'));
    await flushed();

    expect(lines(state.progress)).toEqual(['understand running Understanding problem']);
    expect(changes).toHaveLength(1);
    state.dispose();
  });

  it('forgets the oldest identities once it holds four times the row bound', () => {
    const state = activeState(tickingClock());
    const bound = 4 * MAX_PROGRESS_ENTRIES;
    const transcript = sent(
      Array.from({ length: bound + 1 }, (_, index) =>
        progress(index % 2 === 0 ? 'capture' : 'analyze', 'done', `Attempt ${String(index)}`),
      ),
    );
    applySent(state, transcript);
    const kept = state.progress;
    const [first, second] = transcript;
    if (first === undefined || second === undefined) {
      throw new Error('missing the oldest frames');
    }

    // The second-oldest identity is still held; the oldest was forgotten.
    applySent(state, [second]);
    expect(state.progress).toBe(kept);
    applySent(state, [first]);
    expect(state.progress.at(-1)?.message).toBe('Attempt 0');
    expect(state.progress.length).toBeLessThanOrEqual(MAX_PROGRESS_ENTRIES);
    state.dispose();
  });
});

// ---------------------------------------------------------------------------
// Settlement worded differently, and corrections
// ---------------------------------------------------------------------------

describe('ExtensionState.applyProgress: settlement and correction', () => {
  it("settles a failed stage's header in place, with its position and first receipt time", () => {
    const state = activeState(tickingClock());
    applyAll(state, FIRST_RUN.slice(0, 10));
    state.applyProgress(progress('instrument', 'running', 'Preparing instrumentation'));
    const header = state.progress.at(-1);
    state.applyProgress(progress('instrument', 'done', 'Browser performance'));

    state.applyProgress(
      detailed(
        'instrument',
        'failed',
        'Preparing instrumentation failed: The planned instrumentation is not available here.',
        RELAUNCH_HINT,
      ),
    );

    expect(lines(state.progress).slice(-2)).toEqual([
      'instrument failed Preparing instrumentation failed: The planned instrumentation is not available here.',
      'instrument done Browser performance',
    ]);
    const settled = state.progress.at(-2);
    expect(settled?.ts).toBe(header?.ts);
    expect(settled?.detail).toBe(RELAUNCH_HINT);
    expect(runningRows(state.progress)).toEqual([]);
    state.dispose();
  });

  it('settles only the latest episode of the stage, never an earlier one', () => {
    const state = activeState(tickingClock());
    applyAll(state, FIRST_RUN);
    const firstEpisodeHeader = state.progress.find(
      (entry) => entry.stage === 'instrument' && entry.message === 'Preparing instrumentation',
    );
    applyAll(state, NEW_CAPTURE_FOLLOW_UP.slice(0, 5));

    state.applyProgress(
      progress('instrument', 'failed', 'Preparing instrumentation failed: No adapter accepted it.'),
    );

    expect(firstEpisodeHeader).toBeDefined();
    expect(state.progress).toContain(firstEpisodeHeader);
    expect(lines(state.progress).slice(-1)).toEqual([
      'instrument failed Preparing instrumentation failed: No adapter accepted it.',
    ]);
    expect(runningRows(state.progress)).toEqual([]);
    state.dispose();
  });

  it('prefers an equal message over an extension', () => {
    const state = activeState(tickingClock());
    applyAll(state, [
      progress('capture', 'running', 'Capturing runtime evidence'),
      progress('capture', 'running', 'Capturing runtime evidence: second window'),
      progress('capture', 'done', 'Capturing runtime evidence'),
    ]);

    expect(lines(state.progress)).toEqual([
      'capture done Capturing runtime evidence',
      'capture running Capturing runtime evidence: second window',
    ]);
    state.dispose();
  });

  it('never settles a row whose message continues inside a word, in any script', () => {
    const state = activeState(tickingClock());
    applyAll(state, [
      progress('analyze', 'running', 'Analyse'),
      progress('analyze', 'done', 'Analyse2 complete'),
      progress('analyze', 'running', 'Überprüfung'),
      progress('analyze', 'failed', 'Überprüfungen fehlgeschlagen'),
      progress('analyze', 'running', 'Cafe'),
      progress('analyze', 'done', 'Cafe\u0301 closed'),
    ]);
    expect(state.progress).toHaveLength(6);
    expect(runningRows(state.progress)).toHaveLength(3);

    // At a word boundary the same script settles its row.
    state.applyProgress(progress('analyze', 'failed', 'Überprüfung — fehlgeschlagen'));

    expect(state.progress).toHaveLength(6);
    expect(lines(state.progress)[2]).toBe('analyze failed Überprüfung — fehlgeschlagen');
    state.dispose();
  });

  it('settles a degradation notice with its ✕ row: one row per signal', () => {
    const state = activeState(tickingClock());
    const databaseUnavailable = `${DEGRADATION_SENTENCE_LEAD} Database tracing: no database driver was found.`;
    applyAll(state, [
      progress('instrument', 'running', 'Preparing instrumentation'),
      progress('instrument', 'done', 'Browser performance'),
      progress('instrument', 'running', SERVER_SPANS_NOTICE),
      progress(
        'instrument',
        'running',
        `${databaseUnavailable} Continuing with: Browser performance.`,
      ),
    ]);
    const notice = state.progress[2];

    applyAll(state, [
      detailed('instrument', 'failed', SERVER_SPANS_UNAVAILABLE, RELAUNCH_HINT),
      progress('instrument', 'failed', databaseUnavailable),
      progress('instrument', 'done', 'Preparing instrumentation'),
    ]);

    expect(lines(state.progress)).toEqual([
      'instrument done Preparing instrumentation',
      'instrument done Browser performance',
      `instrument failed ${SERVER_SPANS_UNAVAILABLE}`,
      `instrument failed ${databaseUnavailable}`,
    ]);
    expect(state.progress[2]?.ts).toBe(notice?.ts);
    expect(state.progress[2]?.detail).toBe(RELAUNCH_HINT);
    state.dispose();
  });

  it('lets a corrected ✓ supersede the ✕ it corrects, in place', () => {
    const state = activeState(tickingClock());
    applyAll(state, [
      progress('instrument', 'running', 'Preparing instrumentation'),
      detailed('instrument', 'failed', SERVER_SPANS_UNAVAILABLE, RELAUNCH_HINT),
      progress('instrument', 'failed', `${DEGRADATION_SENTENCE_LEAD} Database tracing.`),
    ]);
    const stale = state.progress[1];

    // A label that only begins another signal's label corrects nothing.
    state.applyProgress(progress('instrument', 'done', 'Server'));
    expect(lines(state.progress)).toEqual([
      'instrument running Preparing instrumentation',
      `instrument failed ${SERVER_SPANS_UNAVAILABLE}`,
      `instrument failed ${DEGRADATION_SENTENCE_LEAD} Database tracing.`,
      'instrument done Server',
    ]);

    // The service corrected its readiness: each ✓ replaces its own ✕.
    state.applyProgress(progress('instrument', 'done', 'Server spans'));
    state.applyProgress(progress('instrument', 'done', 'Database tracing'));

    expect(lines(state.progress)).toEqual([
      'instrument running Preparing instrumentation',
      'instrument done Server spans',
      'instrument done Database tracing',
      'instrument done Server',
    ]);
    expect(state.progress[1]?.ts).toBe(stale?.ts);
    expect(state.progress[1]?.detail).toBeUndefined();
    state.dispose();
  });
});

// ---------------------------------------------------------------------------
// The end of a session
// ---------------------------------------------------------------------------

describe('ExtensionState progress at the end of a session', () => {
  /** A live run that ends with a header, a notice and a stage still running. */
  const UNFINISHED_RUN: readonly SessionProgressPayload[] = [
    progress('understand', 'running', 'Understanding problem'),
    progress('understand', 'done', 'Understanding problem'),
    progress('instrument', 'running', 'Preparing instrumentation'),
    progress('instrument', 'done', 'Browser performance'),
    progress('instrument', 'running', SERVER_SPANS_NOTICE),
    progress('capture', 'running', 'Capturing runtime evidence'),
    progress('cleanup', 'running', 'Removing instrumentation'),
    progress('cleanup', 'done', 'Removing instrumentation'),
  ];

  /** What remains of {@link UNFINISHED_RUN} once the session has ended. */
  const ENDED_LINES: readonly string[] = [
    'understand done Understanding problem',
    'instrument done Browser performance',
    'cleanup done Removing instrumentation',
  ];

  it('drops the rows still running when an ended record arrives, matching the reopened view', () => {
    const live = activeState(tickingClock());
    const transcript = sent(UNFINISHED_RUN);
    applySent(live, transcript);
    expect(runningRows(live.progress)).toHaveLength(3);

    live.applySessionRecord(
      sessionRecord(SESSION_ID, { status: 'ended', updatedAt: FIXED_NOW + 1 }),
    );

    expect(lines(live.progress)).toEqual(ENDED_LINES);
    // A delayed running frame brings no spinner back.
    live.applyProgress(progress('capture', 'running', 'Capturing runtime evidence'), SENT_T0 + 99);
    expect(lines(live.progress)).toEqual(ENDED_LINES);

    // The same session reopened later: adopted as ended, then its history replayed.
    const reopened = new ExtensionState({
      serviceUrl: SERVICE_URL,
      provider: 'deterministic',
      now: tickingClock(),
    });
    reopened.adoptSession(
      sessionRecord(SESSION_ID, { status: 'ended', updatedAt: FIXED_NOW + 1 }),
      SERVICE_URL,
    );
    applySent(reopened, transcript);

    expect(lines(reopened.progress)).toEqual(lines(live.progress));
    live.dispose();
    reopened.dispose();
  });

  it('drops them as well when the service answers session.end', () => {
    const state = activeState(tickingClock());
    applyAll(state, UNFINISHED_RUN);
    const kept = state.progress.filter((entry) => entry.status !== 'running');

    state.applySessionEnded(SESSION_ID, { cleanup: 'clean' });

    expect(lines(state.progress)).toEqual(ENDED_LINES);
    // The rows kept are the very rows that were held.
    kept.forEach((entry, index) => {
      expect(state.progress[index]).toBe(entry);
    });
    state.dispose();
  });

  it('keeps the list as it is when nothing is running at the end', () => {
    const state = activeState(tickingClock());
    applyAll(state, FIRST_RUN);
    const settled = state.progress;

    state.applySessionRecord(
      sessionRecord(SESSION_ID, { status: 'ended', updatedAt: FIXED_NOW + 1 }),
    );

    expect(state.progress).toBe(settled);
    state.dispose();
  });
});
