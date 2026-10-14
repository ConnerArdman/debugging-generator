/**
 * The DevTools panel store's progress rows (`src/panel/state/session-store.ts`, `mergeProgress`).
 *
 * AAP §0.7.3 draws the pipeline as ✓/spinner/✗ rows, and AAP §0.5.5 requires a failed session to
 * be shown with its failing stage — never beside a spinner that says the stage is still working.
 * The service opens each stage with a header row whose message is the stage title, settles it with
 * a `done` row of the same message, and files a stage failure as a differently worded
 * `‹title› failed: ‹summary›` row whose detail ends `(error code: ‹code›, ref: ‹ref›)`. Stored rows
 * are replayed on bind in stored order with their original timestamps.
 *
 * What this suite protects:
 *
 *   - a stage's header settling to `done` settles every other row of the stage still running (the
 *     readiness "Reload the page…" row closes once "Ready to capture" follows) — QA VIS-F03;
 *   - a stage failure replaces the running header in place and settles the stage's other running
 *     rows to `failed`, so no "Running understand" row stays above the failure — QA OBS-F14;
 *   - a replayed header, or a failure of an earlier run, never brings the spinner back, while a
 *     newer header (the stage running again) takes the row back;
 *   - a row that started after the settling report keeps running;
 *   - an input that changes nothing leaves the snapshot's identity untouched, and the row cap holds;
 *   - `isStageFailureEntry` tells the stage failure apart from an ordinary ✗ row.
 *
 * Driven exactly as `src/panel/state/connection.ts` drives the store: protocol envelopes minted by
 * the protocol's own `createEnvelope` go through `applyRelayedMessage`. Every case starts from the
 * pristine store. Fixture strings are the service's generic stage vocabulary; no inspected
 * project's names appear.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEnvelope } from '@debuggen/protocol';
import type { MessagePayload } from '@debuggen/protocol';
import { newSessionId } from '@debuggen/shared';
import type { SessionId } from '@debuggen/shared';

import {
  PANEL_PROGRESS_MAX_ENTRIES,
  applyRelayedMessage,
  getPanelSnapshot,
  isStageFailureEntry,
  resetPanelStore,
  setBindingState,
} from '../src/panel/state/session-store';
import type { PanelProgressEntry } from '../src/panel/state/session-store';

// ---------------------------------------------------------------------------
// Fixtures — the service's own row shapes
// ---------------------------------------------------------------------------

/** A plausible epoch-millisecond clock origin. */
const T0 = Date.UTC(2026, 0, 15, 10, 0, 0);

const INSTRUMENT_HEADER = 'Preparing instrumentation';
const UNDERSTAND_HEADER = 'Understanding problem';
const INVESTIGATE_HEADER = 'Investigating code';
const RELOAD_REQUEST =
  'Reload the page so the Debug Generator hook is in place before React loads.';
const READY_TO_CAPTURE = 'Ready to capture';
const SIGNAL_ROW = 'React renders';
const DEGRADATION_ROW =
  'Could not enable Server spans: the dev server was not started with the preload. Continuing with: React renders.';

const UNDERSTAND_FAILURE = `${UNDERSTAND_HEADER} failed: Model provider unavailable (MODEL_UNAVAILABLE).`;
const UNDERSTAND_FAILURE_DETAIL =
  'Check ANTHROPIC_API_KEY or switch DEBUGGEN_PROVIDER. (error code: MODEL_UNAVAILABLE, ref: ref-0001)';
const INSTRUMENT_FAILURE = `${INSTRUMENT_HEADER} failed: Instrumentation could not be installed.`;
const INSTRUMENT_FAILURE_DETAIL =
  'Start the dev server from the Debug Generator view, then try again. (error code: INSTRUMENTATION_INSTALL_FAILED, ref: ref-0002)';

let sessionId: SessionId;

type ProgressPayload = MessagePayload<'session.progress'>;

/** Relay one `session.progress` frame for the session under test. */
function relayProgress(
  stage: ProgressPayload['stage'],
  status: ProgressPayload['status'],
  message: string,
  ts: number,
  detail?: string,
): void {
  applyRelayedMessage(
    createEnvelope(
      'session.progress',
      { sessionId, stage, status, message, ...(detail === undefined ? {} : { detail }) },
      { ts },
    ),
  );
}

/** The progress rows as `[stage, status, message]` triples, for compact assertions. */
function rows(): readonly (readonly [string, string, string])[] {
  return getPanelSnapshot().progress.map((entry) => [entry.stage, entry.status, entry.message]);
}

/** The row whose message is `message`; throws when there is none. */
function row(message: string): PanelProgressEntry {
  const found = getPanelSnapshot().progress.find((entry) => entry.message === message);
  if (found === undefined) {
    throw new Error(`No progress row reads "${message}".`);
  }
  return found;
}

/** The instrumentation stage as the service reports it up to readiness, before it settles. */
function relayInstrumentationUpToReadiness(): void {
  relayProgress('instrument', 'running', INSTRUMENT_HEADER, T0 + 1);
  relayProgress('instrument', 'done', SIGNAL_ROW, T0 + 2);
  relayProgress('instrument', 'running', DEGRADATION_ROW, T0 + 3);
  relayProgress('instrument', 'running', RELOAD_REQUEST, T0 + 4);
}

/** The instrumentation stage's closing pair, as `readyToCapture` emits it. */
function relayReadyToCapture(ts: number): void {
  relayProgress('instrument', 'done', INSTRUMENT_HEADER, ts);
  relayProgress('instrument', 'done', READY_TO_CAPTURE, ts + 1);
}

beforeEach(() => {
  resetPanelStore({ includeConnection: true });
  sessionId = newSessionId();
  setBindingState({ kind: 'bound', sessionId, tabId: 7, url: 'http://127.0.0.1:20131/' });
});

afterEach(() => {
  resetPanelStore({ includeConnection: true });
});

// ---------------------------------------------------------------------------
// The header settles the stage
// ---------------------------------------------------------------------------

describe('a stage header settling to done', () => {
  it('closes the "Reload the page…" request and every other running row once Ready to capture follows', () => {
    relayInstrumentationUpToReadiness();
    relayReadyToCapture(T0 + 10);

    expect(rows()).toEqual([
      ['instrument', 'done', INSTRUMENT_HEADER],
      ['instrument', 'done', SIGNAL_ROW],
      ['instrument', 'done', DEGRADATION_ROW],
      ['instrument', 'done', RELOAD_REQUEST],
      ['instrument', 'done', READY_TO_CAPTURE],
    ]);
    expect(getPanelSnapshot().progress.some((entry) => entry.status === 'running')).toBe(false);
    // Settled at the header's stamp, so the replay of the original running row is stale.
    expect(row(RELOAD_REQUEST).ts).toBe(T0 + 10);
    // The already-finished row keeps its own stamp.
    expect(row(SIGNAL_ROW).ts).toBe(T0 + 2);
  });

  it('keeps the detail of a settled row', () => {
    relayProgress('instrument', 'running', INSTRUMENT_HEADER, T0 + 1);
    relayProgress('instrument', 'running', DEGRADATION_ROW, T0 + 2, 'node --import register.mjs');
    relayReadyToCapture(T0 + 5);

    expect(row(DEGRADATION_ROW)).toMatchObject({
      status: 'done',
      detail: 'node --import register.mjs',
      ts: T0 + 5,
    });
  });

  it('leaves the rows of other stages alone', () => {
    relayProgress('investigate', 'running', INVESTIGATE_HEADER, T0);
    relayInstrumentationUpToReadiness();
    relayReadyToCapture(T0 + 10);

    expect(row(INVESTIGATE_HEADER).status).toBe('running');
  });

  it('does not close a row that started after the settling report', () => {
    relayProgress('instrument', 'running', INSTRUMENT_HEADER, T0 + 1);
    relayProgress('instrument', 'running', RELOAD_REQUEST, T0 + 20);
    relayProgress('instrument', 'done', INSTRUMENT_HEADER, T0 + 10);

    expect(row(INSTRUMENT_HEADER).status).toBe('done');
    expect(row(RELOAD_REQUEST)).toMatchObject({ status: 'running', ts: T0 + 20 });
  });

  it('ignores the replay of the settled rows on bind, leaving the snapshot untouched', () => {
    relayInstrumentationUpToReadiness();
    relayReadyToCapture(T0 + 10);
    const before = getPanelSnapshot();

    relayInstrumentationUpToReadiness();
    relayReadyToCapture(T0 + 10);

    expect(getPanelSnapshot()).toBe(before);
  });

  it('never reopens a finished header with a running report of the same millisecond', () => {
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);
    relayProgress('understand', 'done', UNDERSTAND_HEADER, T0);
    const before = getPanelSnapshot();

    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);

    expect(getPanelSnapshot()).toBe(before);
    expect(row(UNDERSTAND_HEADER).status).toBe('done');
  });

  it('reopens a header the stage reports running again later, in place', () => {
    relayInstrumentationUpToReadiness();
    relayReadyToCapture(T0 + 10);

    relayProgress('instrument', 'running', INSTRUMENT_HEADER, T0 + 30);

    expect(rows()[0]).toEqual(['instrument', 'running', INSTRUMENT_HEADER]);
    expect(rows()).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// The stage fails
// ---------------------------------------------------------------------------

describe('a stage failure', () => {
  it('replaces the running header in place, so no "Running understand" row stays above it', () => {
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);
    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0 + 5, UNDERSTAND_FAILURE_DETAIL);

    expect(getPanelSnapshot().progress).toEqual([
      {
        stage: 'understand',
        status: 'failed',
        message: UNDERSTAND_FAILURE,
        detail: UNDERSTAND_FAILURE_DETAIL,
        ts: T0 + 5,
        supersedes: UNDERSTAND_HEADER,
      },
    ]);
  });

  it('settles the stage’s other running rows to failed and keeps earlier stages as they were', () => {
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);
    relayProgress('understand', 'done', UNDERSTAND_HEADER, T0 + 1);
    relayInstrumentationUpToReadiness();
    relayProgress('instrument', 'failed', INSTRUMENT_FAILURE, T0 + 8, INSTRUMENT_FAILURE_DETAIL);

    expect(rows()).toEqual([
      ['understand', 'done', UNDERSTAND_HEADER],
      ['instrument', 'failed', INSTRUMENT_FAILURE],
      ['instrument', 'done', SIGNAL_ROW],
      ['instrument', 'failed', DEGRADATION_ROW],
      ['instrument', 'failed', RELOAD_REQUEST],
    ]);
    expect(row(RELOAD_REQUEST).ts).toBe(T0 + 8);
    expect(row(INSTRUMENT_FAILURE).supersedes).toBe(INSTRUMENT_HEADER);
  });

  it('ignores the replayed header — even one stamped in the failure’s millisecond', () => {
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0 + 5);
    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0 + 5, UNDERSTAND_FAILURE_DETAIL);
    const before = getPanelSnapshot();

    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0 + 5);
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);

    expect(getPanelSnapshot()).toBe(before);
  });

  it('ignores a redelivery of the failure itself', () => {
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);
    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0 + 5, UNDERSTAND_FAILURE_DETAIL);
    const before = getPanelSnapshot();

    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0 + 5, UNDERSTAND_FAILURE_DETAIL);

    expect(getPanelSnapshot()).toBe(before);
  });

  it('builds the same rows from a bind replay in stored order as from live delivery', () => {
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);
    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0 + 5, UNDERSTAND_FAILURE_DETAIL);
    const live = getPanelSnapshot().progress;

    // Reconnect over the same store: the replay changes nothing.
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);
    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0 + 5, UNDERSTAND_FAILURE_DETAIL);
    expect(getPanelSnapshot().progress).toBe(live);

    // A fresh panel receiving the replay ends where the live panel did.
    resetPanelStore();
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);
    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0 + 5, UNDERSTAND_FAILURE_DETAIL);
    expect(getPanelSnapshot().progress).toEqual(live);
  });

  it('gives the row back to a newer header when a follow-up re-runs the stage, and fails it again in place', () => {
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);
    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0 + 5, UNDERSTAND_FAILURE_DETAIL);

    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0 + 50);
    expect(getPanelSnapshot().progress).toEqual([
      { stage: 'understand', status: 'running', message: UNDERSTAND_HEADER, ts: T0 + 50 },
    ]);

    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0 + 60, UNDERSTAND_FAILURE_DETAIL);
    expect(getPanelSnapshot().progress).toEqual([
      {
        stage: 'understand',
        status: 'failed',
        message: UNDERSTAND_FAILURE,
        detail: UNDERSTAND_FAILURE_DETAIL,
        ts: T0 + 60,
        supersedes: UNDERSTAND_HEADER,
      },
    ]);
  });

  it('ignores the failure of an earlier run once a newer header runs the stage again', () => {
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);
    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0 + 5, UNDERSTAND_FAILURE_DETAIL);
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0 + 50);
    const before = getPanelSnapshot();

    // A reconnect replays the stored rows: the old header is stale, the old failure superseded.
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);
    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0 + 5, UNDERSTAND_FAILURE_DETAIL);

    expect(getPanelSnapshot()).toBe(before);
  });

  it('is appended after a header that already settled, and still settles the stage’s running rows', () => {
    relayProgress('instrument', 'running', INSTRUMENT_HEADER, T0);
    relayProgress('instrument', 'done', INSTRUMENT_HEADER, T0 + 2);
    relayProgress('instrument', 'running', RELOAD_REQUEST, T0 + 3);
    relayProgress('instrument', 'failed', INSTRUMENT_FAILURE, T0 + 4, INSTRUMENT_FAILURE_DETAIL);

    expect(rows()).toEqual([
      ['instrument', 'done', INSTRUMENT_HEADER],
      ['instrument', 'failed', RELOAD_REQUEST],
      ['instrument', 'failed', INSTRUMENT_FAILURE],
    ]);
    expect(row(INSTRUMENT_FAILURE).supersedes).toBeUndefined();
  });

  it('is appended as it is when its stage reported no header', () => {
    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0, UNDERSTAND_FAILURE_DETAIL);

    expect(getPanelSnapshot().progress).toEqual([
      {
        stage: 'understand',
        status: 'failed',
        message: UNDERSTAND_FAILURE,
        detail: UNDERSTAND_FAILURE_DETAIL,
        ts: T0,
      },
    ]);
  });

  it('leaves an ordinary ✗ row beside a running header as a row of its own', () => {
    relayProgress('instrument', 'running', INSTRUMENT_HEADER, T0);
    relayProgress('instrument', 'failed', 'Could not enable Server spans: no preload.', T0 + 1);

    expect(rows()).toEqual([
      ['instrument', 'running', INSTRUMENT_HEADER],
      ['instrument', 'failed', 'Could not enable Server spans: no preload.'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Identity and bounds
// ---------------------------------------------------------------------------

describe('identity and bounds', () => {
  it('leaves every other slice’s reference untouched when a stage settles', () => {
    relayInstrumentationUpToReadiness();
    const before = getPanelSnapshot();

    relayReadyToCapture(T0 + 10);

    const after = getPanelSnapshot();
    expect(after).not.toBe(before);
    expect(after.connection).toBe(before.connection);
    expect(after.capture).toBe(before.capture);
    expect(after.instrumentation).toBe(before.instrumentation);
    expect(Object.isFrozen(after.progress)).toBe(true);
    expect(after.progress.every((entry) => Object.isFrozen(entry))).toBe(true);
  });

  it('keeps the rows unique by stage and message', () => {
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);
    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0 + 5, UNDERSTAND_FAILURE_DETAIL);
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0 + 50);
    relayProgress('understand', 'failed', UNDERSTAND_FAILURE, T0 + 60, UNDERSTAND_FAILURE_DETAIL);
    relayInstrumentationUpToReadiness();
    relayReadyToCapture(T0 + 70);

    const keys = getPanelSnapshot().progress.map((entry) => `${entry.stage}\u0000${entry.message}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('still drops the oldest rows past PANEL_PROGRESS_MAX_ENTRIES', () => {
    relayProgress('instrument', 'running', INSTRUMENT_HEADER, T0);
    for (let index = 0; index < PANEL_PROGRESS_MAX_ENTRIES + 5; index += 1) {
      relayProgress('analyze', 'done', `Finding ${String(index)}`, T0 + 1 + index);
    }

    const progress = getPanelSnapshot().progress;
    expect(progress).toHaveLength(PANEL_PROGRESS_MAX_ENTRIES);
    expect(progress[0]?.message).toBe('Finding 5');
    expect(progress.at(-1)?.message).toBe(`Finding ${String(PANEL_PROGRESS_MAX_ENTRIES + 4)}`);
  });

  it('ignores progress of another session', () => {
    relayProgress('understand', 'running', UNDERSTAND_HEADER, T0);
    const before = getPanelSnapshot();

    applyRelayedMessage(
      createEnvelope(
        'session.progress',
        {
          sessionId: newSessionId(),
          stage: 'understand',
          status: 'failed',
          message: UNDERSTAND_FAILURE,
          detail: UNDERSTAND_FAILURE_DETAIL,
        },
        { ts: T0 + 5 },
      ),
    );

    expect(getPanelSnapshot()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// isStageFailureEntry
// ---------------------------------------------------------------------------

describe('isStageFailureEntry', () => {
  const base = { stage: 'understand', ts: T0 } as const;

  it('recognises a failure row that superseded its header', () => {
    expect(
      isStageFailureEntry({
        ...base,
        status: 'failed',
        message: UNDERSTAND_FAILURE,
        supersedes: UNDERSTAND_HEADER,
      }),
    ).toBe(true);
  });

  it('recognises a failed row carrying the service’s error-code suffix', () => {
    expect(
      isStageFailureEntry({
        ...base,
        status: 'failed',
        message: UNDERSTAND_FAILURE,
        detail: UNDERSTAND_FAILURE_DETAIL,
      }),
    ).toBe(true);
    expect(
      isStageFailureEntry({
        ...base,
        status: 'failed',
        message: UNDERSTAND_FAILURE,
        detail: '(error code: MODEL_UNAVAILABLE, ref: ref-0001) ',
      }),
    ).toBe(true);
  });

  it('rejects an ordinary ✗ row and a row that did not fail', () => {
    expect(
      isStageFailureEntry({
        ...base,
        stage: 'instrument',
        status: 'failed',
        message: 'Could not enable Server spans: no preload.',
        detail: 'node --import register.mjs',
      }),
    ).toBe(false);
    expect(isStageFailureEntry({ ...base, status: 'failed', message: UNDERSTAND_FAILURE })).toBe(
      false,
    );
    expect(
      isStageFailureEntry({
        ...base,
        status: 'done',
        message: UNDERSTAND_HEADER,
        detail: UNDERSTAND_FAILURE_DETAIL,
      }),
    ).toBe(false);
  });
});
