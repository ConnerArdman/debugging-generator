/**
 * Tests for `./state.ts`: the rules that let the editor track at most one live
 * session and hand it over without losing a frame.
 *
 * - **Explicit adoption.** A record of a session that is not the active one
 *   never becomes active on its own — not even while no session is active —
 *   and {@link ExtensionState.adoptSession} replaces the active session in one
 *   batch, or merges when it names the active session.
 * - **The creation window.** While one is open, every session-scoped mutator
 *   holds a frame for a session other than the active one; adoption replays the
 *   adopted session's frames in arrival order and discards the rest; the buffer
 *   is bounded and counts what it dropped; windows are independent, idempotent
 *   to close, and closed by disposal.
 * - **`applySessionEnded`.** The HTTP answer to `session.end` marks the active
 *   session ended without regressing a finished cleanup, and a later record
 *   from the service supersedes it.
 * - **`pendingTarget`.** Only an element selected while no session was active
 *   is the next question's target.
 *
 * ## The `vscode` substitute
 *
 * The store uses one runtime member of the `vscode` module, `EventEmitter`, so
 * `vi.mock` supplies a minimal synchronous one. Nothing else of the editor is
 * reached.
 *
 * ## Payload fixtures
 *
 * The store validates nothing — the protocol client does, before a frame
 * reaches it — and reads only a few members of the larger payloads (a plan's
 * version, an analysis's version, a panel's title and version). Those are
 * built by {@link payload} with exactly the members the store reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toSessionListItem } from '@debuggen/protocol';
import type {
  AnalysisResult,
  CaptureStoppedPayload,
  CleanupCompletedPayload,
  InstrumentationFailedPayload,
  InstrumentationPlanPayload,
  InstrumentationReadyPayload,
  ModificationRecord,
  PanelGeneratedPayload,
  SessionProgressPayload,
  SessionRecord,
  TargetSelectedPayload,
} from '@debuggen/protocol';

import { ExtensionState, MAX_ACKNOWLEDGED_ENDS, MAX_HELD_FRAMES } from './state';
import type { SessionListPage } from './state';
import type { WebviewState } from './webview-messages';

vi.mock('vscode', () => {
  /** A synchronous stand-in for `vscode.EventEmitter`. */
  class EventEmitter<T> {
    private readonly listeners = new Set<(event: T) => void>();

    readonly event = (listener: (event: T) => void): { dispose(): void } => {
      this.listeners.add(listener);
      return {
        dispose: () => {
          this.listeners.delete(listener);
        },
      };
    };

    fire(event: T): void {
      for (const listener of [...this.listeners]) {
        listener(event);
      }
    }

    dispose(): void {
      this.listeners.clear();
    }
  }
  return { EventEmitter };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;

/** The service base URL every adoption in this file is answered by, unless a case says otherwise. */
const ENDPOINT = 'http://127.0.0.1:9';

/** A second service, for the cases where `debuggen.serviceUrl` points elsewhere. */
const OTHER_ENDPOINT = 'http://127.0.0.1:10';

/** A complete, schema-shaped session record with the given id. */
function sessionRecord(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    projectRoot: '/workspace/state-fixture',
    projectName: 'state-fixture',
    devServerUrl: 'http://127.0.0.1:3100',
    createdAt: T0,
    updatedAt: T0,
    status: 'ready',
    question: 'Why does the list render twice?',
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
  };
}

/**
 * The Sessions tree's answer for `records`, as `ExtensionState.setSessionList`
 * takes it: each record's `toSessionListItem` row — what `GET /sessions` lists
 * — and a `total` of exactly those rows.
 */
function listPage(...records: readonly SessionRecord[]): SessionListPage {
  return { sessions: records.map((record) => toSessionListItem(record)), total: records.length };
}

/** One applied patch of `sessionId`. */
function appliedPatch(sessionId: string, id = `${sessionId}-mod-1`): ModificationRecord {
  return {
    id,
    sessionId,
    planVersion: 1,
    file: 'src/lib/timing.ts',
    originalHash: 'a'.repeat(64),
    backupPath: `/tmp/debuggen-home/backups/${sessionId}/${'a'.repeat(64)}`,
    instrumentedHash: 'b'.repeat(64),
    appliedAt: T0,
    status: 'applied',
    diff: '',
  };
}

/** One `session.progress` row. */
function progressRow(sessionId: string, message: string): SessionProgressPayload {
  return { sessionId, stage: 'understand', status: 'running', message };
}

/** A payload carrying exactly the members the store reads; see the module documentation. */
function payload<T>(members: Readonly<Record<string, unknown>>): T {
  return members as unknown as T;
}

/** The DevTools selection of an element, for `target.selected`. */
function targetSelected(sessionId: string, selector: string): TargetSelectedPayload {
  return {
    sessionId,
    target: {
      selector,
      tagName: 'button',
      componentChain: ['Toolbar'],
      url: 'http://127.0.0.1:3100/',
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let state: ExtensionState;
let now: number;

beforeEach(() => {
  now = T0 + 1_000;
  state = new ExtensionState({
    serviceUrl: 'http://127.0.0.1:9',
    provider: 'deterministic',
    now: () => now,
  });
});

afterEach(() => {
  state.dispose();
});

/** Lets the store's queued microtask flush run. */
async function flushed(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Explicit adoption
// ---------------------------------------------------------------------------

describe('explicit adoption', () => {
  it('never makes a pushed record active on its own, even with no session active', () => {
    state.setSessionList(listPage(sessionRecord('S1', { status: 'created' })));

    state.applySessionRecord(sessionRecord('S1', { status: 'understanding', updatedAt: T0 + 5 }));

    expect(state.activeSessionId).toBeUndefined();
    expect(state.sessionList.map((listed) => listed.status)).toEqual(['understanding']);
  });

  it('keeps the active session when a record of another session arrives', () => {
    state.adoptSession(sessionRecord('S1'), ENDPOINT);

    state.applySessionRecord(sessionRecord('S2', { status: 'generated', updatedAt: T0 + 9 }));

    expect(state.activeSessionId).toBe('S1');
  });

  it('replaces a different active session in one batch, keeping nothing of it', async () => {
    const events: WebviewState[] = [];
    state.onDidChange((snapshot) => events.push(snapshot));
    state.adoptSession(sessionRecord('S1', { modifications: [appliedPatch('S1')] }), ENDPOINT);
    state.applyProgress(progressRow('S1', 'Reading the question'));
    await flushed();
    events.length = 0;

    state.adoptSession(sessionRecord('S2', { status: 'created' }), ENDPOINT);
    await flushed();

    expect(state.activeSessionId).toBe('S2');
    expect(state.progress).toEqual([]);
    expect(state.modifications).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]?.session?.id).toBe('S2');
  });

  it('merges a record of the active session and resets nothing', () => {
    state.adoptSession(sessionRecord('S1'), ENDPOINT);
    state.applyProgress(progressRow('S1', 'Reading the question'));

    state.adoptSession(sessionRecord('S1', { status: 'capturing', updatedAt: T0 + 3 }), ENDPOINT);

    expect(state.activeSession?.status).toBe('capturing');
    expect(state.progress).toHaveLength(1);
  });

  it('drops frames of a non-active session when no creation window is open', () => {
    state.adoptSession(sessionRecord('S1'), ENDPOINT);
    state.applyProgress(progressRow('S2', 'Row of another session'));

    state.adoptSession(sessionRecord('S2'), ENDPOINT);

    expect(state.progress).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The owning endpoint
// ---------------------------------------------------------------------------

describe('the owning endpoint', () => {
  it('is the endpoint the adopted session was answered by, and a reset clears it', () => {
    expect(state.activeSessionEndpoint).toBeUndefined();

    state.adoptSession(sessionRecord('S1'), ENDPOINT);
    expect(state.activeSessionEndpoint).toBe(ENDPOINT);

    state.resetSession();
    expect(state.activeSessionEndpoint).toBeUndefined();
  });

  it('is replaced when a different session becomes active', () => {
    state.adoptSession(sessionRecord('S1'), ENDPOINT);

    state.adoptSession(sessionRecord('S2'), OTHER_ENDPOINT);

    expect(state.activeSessionId).toBe('S2');
    expect(state.activeSessionEndpoint).toBe(OTHER_ENDPOINT);
  });

  it('is kept by a merge of the active session, which has not moved', () => {
    state.adoptSession(sessionRecord('S1'), ENDPOINT);

    state.adoptSession(sessionRecord('S1', { updatedAt: T0 + 1 }), OTHER_ENDPOINT);
    state.applySessionRecord(sessionRecord('S1', { updatedAt: T0 + 2 }));

    expect(state.activeSessionEndpoint).toBe(ENDPOINT);
  });

  it('is set by a creation window from the endpoint captured before the request', () => {
    const creation = state.beginSessionCreation();

    creation.adopt(sessionRecord('S2'), OTHER_ENDPOINT);

    expect(state.activeSessionEndpoint).toBe(OTHER_ENDPOINT);
  });

  it('is not changed by debuggen.serviceUrl changing', () => {
    state.adoptSession(sessionRecord('S1'), ENDPOINT);

    state.setServiceUrl(OTHER_ENDPOINT);

    expect(state.serviceUrl).toBe(OTHER_ENDPOINT);
    expect(state.activeSessionEndpoint).toBe(ENDPOINT);
  });
});

// ---------------------------------------------------------------------------
// The creation window
// ---------------------------------------------------------------------------

describe('the creation window', () => {
  it('holds every session-scoped frame of the session being created and replays them in arrival order', () => {
    const creation = state.beginSessionCreation();
    expect(state.sessionCreationPending).toBe(true);

    state.applySessionRecord(sessionRecord('S2', { status: 'instrumenting', updatedAt: T0 + 2 }));
    state.applyProgress(progressRow('S2', 'Understanding the question'));
    state.applyInstrumentationPlan(
      payload<InstrumentationPlanPayload>({ sessionId: 'S2', plan: { planVersion: 1 } }),
    );
    state.applyInstrumentationFailed(
      payload<InstrumentationFailedPayload>({
        sessionId: 'S2',
        error: { code: 'INSTRUMENTATION_INSTALL_FAILED', message: 'first attempt failed' },
      }),
    );
    state.applyInstrumentationReady(
      payload<InstrumentationReadyPayload>({
        sessionId: 'S2',
        applied: [appliedPatch('S2')],
        runtimeHooks: ['fetch'],
        unavailable: [],
      }),
    );
    state.applyCaptureStarted({ sessionId: 'S2', captureId: 'C1' });
    state.applyCaptureStopped(
      payload<CaptureStoppedPayload>({
        sessionId: 'S2',
        captureId: 'C1',
        summary: { eventCount: 7 },
      }),
    );
    state.applyAnalysis(payload<AnalysisResult>({ sessionId: 'S2', analysisVersion: 1 }));
    state.applyPanelGenerated(
      payload<PanelGeneratedPayload>({
        sessionId: 'S2',
        panelId: 'P1',
        panel: { title: 'Render timing', panelVersion: 1 },
      }),
    );
    state.applyTargetSelected(targetSelected('S2', '#save'));
    state.applyCleanupCompleted(
      payload<CleanupCompletedPayload>({ sessionId: 'S2', status: 'clean', conflicts: [] }),
    );
    expect(state.activeSessionId).toBeUndefined();

    creation.adopt(sessionRecord('S2', { status: 'created' }), ENDPOINT);

    expect(creation.isOpen).toBe(false);
    expect(state.sessionCreationPending).toBe(false);
    expect(state.activeSessionId).toBe('S2');
    expect(state.activeSession?.status).toBe('instrumenting');
    expect(state.activeSession?.plans.map((plan) => plan.planVersion)).toEqual([1]);
    expect(state.progress.map((row) => row.message)).toEqual(['Understanding the question']);
    expect(state.failure).toBeUndefined();
    expect(state.modifications.map((modification) => modification.id)).toEqual(['S2-mod-1']);
    expect(state.runtimeHooks).toEqual(['fetch']);
    expect(state.captureState).toEqual({ active: false, captureId: 'C1', eventCount: 7 });
    expect(state.latestAnalysis?.analysisVersion).toBe(1);
    expect(state.latestPanel).toEqual({
      id: 'P1',
      title: 'Render timing',
      panelVersion: 1,
      fallback: false,
    });
    expect(state.target?.selector).toBe('#save');
    expect(state.pendingTarget).toBeUndefined();
    expect(state.cleanup.status).toBe('clean');
  });

  it('discards the frames of every other session on adoption', () => {
    const creation = state.beginSessionCreation();
    state.applyProgress(progressRow('S3', 'Row of another window'));
    state.applyProgress(progressRow('S2', 'Row of the new session'));
    state.applySessionRecord(sessionRecord('S3', { status: 'generated', updatedAt: T0 + 50 }));

    creation.adopt(sessionRecord('S2'), ENDPOINT);

    expect(state.activeSessionId).toBe('S2');
    expect(state.progress.map((row) => row.message)).toEqual(['Row of the new session']);
  });

  it('applies frames of the active session immediately while a window is open', () => {
    state.adoptSession(sessionRecord('S1'), ENDPOINT);
    const creation = state.beginSessionCreation();

    state.applyProgress(progressRow('S1', 'Still S1'));

    expect(state.progress.map((row) => row.message)).toEqual(['Still S1']);
    creation.abandon();
  });

  it('abandon discards the held frames and is idempotent; adopt afterwards does nothing', () => {
    state.adoptSession(sessionRecord('S1'), ENDPOINT);
    const creation = state.beginSessionCreation();
    state.applyProgress(progressRow('S2', 'Held'));

    creation.abandon();
    creation.abandon();
    creation.adopt(sessionRecord('S2'), ENDPOINT);

    expect(creation.isOpen).toBe(false);
    expect(state.activeSessionId).toBe('S1');
    expect(state.sessionCreationPending).toBe(false);
  });

  it('adopt is idempotent: a second adopt of another record changes nothing', () => {
    const creation = state.beginSessionCreation();
    creation.adopt(sessionRecord('S2'), ENDPOINT);
    creation.adopt(sessionRecord('S3'), ENDPOINT);

    expect(state.activeSessionId).toBe('S2');
  });

  it(`holds at most ${String(MAX_HELD_FRAMES)} frames and counts the ones it dropped`, () => {
    const creation = state.beginSessionCreation();
    const extra = 3;
    for (let index = 0; index < MAX_HELD_FRAMES + extra; index += 1) {
      state.applyProgress(progressRow('S2', `row ${String(index)}`));
    }

    expect(creation.droppedFrames).toBe(extra);
    creation.adopt(sessionRecord('S2'), ENDPOINT);
    expect(state.progress).toHaveLength(MAX_HELD_FRAMES);
    expect(state.progress.at(-1)?.message).toBe(`row ${String(MAX_HELD_FRAMES - 1)}`);
  });

  it('keeps several windows independent', () => {
    const first = state.beginSessionCreation();
    const second = state.beginSessionCreation();
    state.applyProgress(progressRow('S2', 'Held by both'));

    first.abandon();
    expect(state.sessionCreationPending).toBe(true);
    second.adopt(sessionRecord('S2'), ENDPOINT);

    expect(state.progress.map((row) => row.message)).toEqual(['Held by both']);
    expect(state.sessionCreationPending).toBe(false);
  });

  it('replays what was received, not what the caller changed afterwards', () => {
    const creation = state.beginSessionCreation();
    const row = { ...progressRow('S2', 'As received') };
    state.applyProgress(row);
    row.message = 'Changed by the caller';

    creation.adopt(sessionRecord('S2'), ENDPOINT);

    expect(state.progress.map((held) => held.message)).toEqual(['As received']);
  });

  it('delivers the adoption and its replay as one change event', async () => {
    const events: WebviewState[] = [];
    state.onDidChange((snapshot) => events.push(snapshot));
    const creation = state.beginSessionCreation();
    state.applyProgress(progressRow('S2', 'One'));
    state.applyProgress(progressRow('S2', 'Two'));

    creation.adopt(sessionRecord('S2'), ENDPOINT);
    await flushed();

    expect(events).toHaveLength(1);
    expect(events[0]?.progress.map((row) => row.message)).toEqual(['One', 'Two']);
  });

  it('is closed by disposal and born closed on a disposed store', () => {
    const creation = state.beginSessionCreation();
    state.applyProgress(progressRow('S2', 'Held'));

    state.dispose();
    creation.adopt(sessionRecord('S2'), ENDPOINT);

    expect(creation.isOpen).toBe(false);
    expect(state.sessionCreationPending).toBe(false);
    expect(state.activeSessionId).toBeUndefined();
    expect(state.beginSessionCreation().isOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applySessionEnded
// ---------------------------------------------------------------------------

describe('applySessionEnded', () => {
  it('marks the active session ended, unbound and uncapturing, with updatedAt unchanged', () => {
    state.setSessionList(listPage(sessionRecord('S1', { status: 'capturing' })));
    state.adoptSession(
      sessionRecord('S1', {
        status: 'capturing',
        boundTab: { tabId: 7, url: 'http://127.0.0.1:3100/' },
      }),
      ENDPOINT,
    );
    state.applyCaptureStarted({ sessionId: 'S1', captureId: 'C1' });

    state.applySessionEnded('S1', { cleanup: 'conflict' });

    const ended = state.activeSession;
    expect(ended?.status).toBe('ended');
    expect(ended !== undefined && 'boundTab' in ended).toBe(false);
    expect(ended?.updatedAt).toBe(T0);
    expect(Object.isFrozen(ended)).toBe(true);
    expect(state.captureState.active).toBe(false);
    expect(state.cleanup).toEqual({ status: 'conflict', completedAt: now, conflicts: [] });
    expect(state.sessionList.map((listed) => listed.status)).toEqual(['ended']);
  });

  it('keeps the conflicts and completion time cleanup.completed already reported', () => {
    state.adoptSession(sessionRecord('S1'), ENDPOINT);
    const conflict = {
      recordId: 'S1-mod-1',
      sessionId: 'S1',
      file: 'src/lib/timing.ts',
      reason: 'content-changed',
      expectedHash: 'b'.repeat(64),
      backupPath: `/tmp/debuggen-home/backups/S1/${'a'.repeat(64)}`,
      detectedAt: T0 + 1,
      message: 'The file changed while it was instrumented.',
    } as const;
    state.applyCleanupCompleted({ sessionId: 'S1', status: 'conflict', conflicts: [conflict] });
    const reported = state.cleanup;
    now += 500;

    state.applySessionEnded('S1', { cleanup: 'conflict' });

    expect(state.cleanup).toBe(reported);
    expect(state.cleanup.conflicts).toHaveLength(1);
  });

  it('never regresses a finished cleanup to pending', () => {
    state.adoptSession(sessionRecord('S1'), ENDPOINT);
    state.applyCleanupCompleted({ sessionId: 'S1', status: 'clean', conflicts: [] });

    state.applySessionEnded('S1', { cleanup: 'pending' });

    expect(state.cleanup.status).toBe('clean');
    expect(state.activeSession?.status).toBe('ended');
  });

  it('records a pending answer without a completion time', () => {
    state.adoptSession(sessionRecord('S1'), ENDPOINT);

    state.applySessionEnded('S1', { cleanup: 'pending' });

    expect(state.cleanup).toEqual({ status: 'pending', conflicts: [] });
  });

  it('ignores an answer about any other session', () => {
    state.adoptSession(sessionRecord('S1'), ENDPOINT);

    state.applySessionEnded('S2', { cleanup: 'clean' });

    expect(state.activeSession?.status).toBe('ready');
    expect(state.cleanup.status).toBe('pending');
  });

  it("is superseded by the service's next record", () => {
    state.adoptSession(sessionRecord('S1'), ENDPOINT);
    state.applySessionEnded('S1', { cleanup: 'clean' });

    state.applySessionRecord(
      sessionRecord('S1', {
        status: 'ended',
        updatedAt: T0 + 10,
        cleanup: { status: 'clean', completedAt: T0 + 9, conflicts: [] },
      }),
    );

    expect(state.activeSession?.updatedAt).toBe(T0 + 10);
    expect(state.cleanup.completedAt).toBe(T0 + 9);
  });
});

// ---------------------------------------------------------------------------
// Terminal stickiness of `ended`
// ---------------------------------------------------------------------------

/** One content-changed conflict of `sessionId`'s patch, as cleanup reports it. */
function contentConflict(sessionId: string, detectedAt: number) {
  return {
    recordId: `${sessionId}-mod-1`,
    sessionId,
    file: 'src/lib/timing.ts',
    reason: 'content-changed',
    expectedHash: 'b'.repeat(64),
    backupPath: `/tmp/debuggen-home/backups/${sessionId}/${'a'.repeat(64)}`,
    detectedAt,
    message: 'The file changed while it was instrumented.',
  } as const;
}

describe('terminal stickiness of ended sessions', () => {
  it('after the HTTP end answer, a delayed intermediate record with a NEWER updatedAt changes neither the view nor the list', () => {
    state.setSessionList(listPage(sessionRecord('S1', { status: 'capturing' })));
    state.adoptSession(sessionRecord('S1', { status: 'capturing' }), ENDPOINT);
    state.applySessionEnded('S1', { cleanup: 'clean' });

    // The service records cleanup on the session before it moves it to `ended`
    // and broadcasts that intermediate record; here it arrives late.
    state.applySessionRecord(
      sessionRecord('S1', {
        status: 'ready',
        updatedAt: T0 + 50,
        cleanup: { status: 'clean', completedAt: T0 + 49, conflicts: [] },
      }),
    );

    expect(state.hasAcknowledgedEnd('S1')).toBe(true);
    expect(state.activeSession?.status).toBe('ended');
    expect(state.activeSession?.updatedAt).toBe(T0);
    expect(state.sessionList.map((listed) => listed.status)).toEqual(['ended']);
  });

  it('an equal-timestamp record that is not ended, arriving after an ended one, changes nothing', () => {
    state.setSessionList(listPage(sessionRecord('S1')));
    state.adoptSession(sessionRecord('S1'), ENDPOINT);
    state.applySessionRecord(sessionRecord('S1', { status: 'ended', updatedAt: T0 + 10 }));

    state.applySessionRecord(sessionRecord('S1', { status: 'ready', updatedAt: T0 + 10 }));

    expect(state.activeSession?.status).toBe('ended');
    expect(state.sessionList.map((listed) => listed.status)).toEqual(['ended']);
  });

  it('the final authoritative ended record is still applied, and brings its cleanup conflicts', () => {
    state.setSessionList(listPage(sessionRecord('S1')));
    state.adoptSession(
      sessionRecord('S1', { status: 'capturing', modifications: [appliedPatch('S1')] }),
      ENDPOINT,
    );
    state.applySessionEnded('S1', { cleanup: 'conflict' });
    state.applySessionRecord(
      sessionRecord('S1', {
        status: 'capturing',
        updatedAt: T0 + 5,
        cleanup: {
          status: 'conflict',
          completedAt: T0 + 5,
          conflicts: [contentConflict('S1', T0 + 4)],
        },
      }),
    );
    expect(state.activeSession?.status).toBe('ended');

    state.applySessionRecord(
      sessionRecord('S1', {
        status: 'ended',
        updatedAt: T0 + 6,
        cleanup: {
          status: 'conflict',
          completedAt: T0 + 6,
          conflicts: [contentConflict('S1', T0 + 4)],
        },
      }),
    );

    expect(state.activeSession?.updatedAt).toBe(T0 + 6);
    expect(state.cleanup.status).toBe('conflict');
    expect(state.cleanup.completedAt).toBe(T0 + 6);
    expect(state.cleanup.conflicts.map((conflict) => conflict.backupPath)).toEqual([
      `/tmp/debuggen-home/backups/S1/${'a'.repeat(64)}`,
    ]);
    expect(state.sessionList[0]?.updatedAt).toBe(T0 + 6);
  });

  it('an ended record replaces a live one even when its updatedAt is older', () => {
    state.adoptSession(sessionRecord('S1', { status: 'capturing', updatedAt: T0 + 20 }), ENDPOINT);

    state.applySessionRecord(sessionRecord('S1', { status: 'ended', updatedAt: T0 + 10 }));

    expect(state.activeSession?.status).toBe('ended');
  });

  it('frames crossing the HTTP create answer with equal timestamps end in the latest state', () => {
    const creation = state.beginSessionCreation();
    // Pushed before the answer arrives, all stamped in the same millisecond.
    state.applySessionRecord(sessionRecord('S2', { status: 'created' }));
    state.applySessionRecord(sessionRecord('S2', { status: 'understanding' }));

    creation.adopt(sessionRecord('S2', { status: 'created' }), ENDPOINT);
    expect(state.activeSession?.status).toBe('understanding');

    // Pushed after the answer, still in the same millisecond.
    state.applySessionRecord(sessionRecord('S2', { status: 'investigating' }));
    expect(state.activeSession?.status).toBe('investigating');

    state.applySessionRecord(sessionRecord('S2', { status: 'ended' }));
    state.applySessionRecord(sessionRecord('S2', { status: 'planning' }));
    expect(state.activeSession?.status).toBe('ended');
  });

  it('a creation window replaying held frames cannot reopen a session adopted as ended', () => {
    const creation = state.beginSessionCreation();
    state.applySessionRecord(sessionRecord('S1', { status: 'capturing', updatedAt: T0 + 20 }));
    state.applyProgress(progressRow('S1', 'Capturing'));
    state.applyCaptureStarted({ sessionId: 'S1', captureId: 'C1' });

    creation.adopt(sessionRecord('S1', { status: 'ended', updatedAt: T0 + 10 }), ENDPOINT);

    expect(state.activeSession?.status).toBe('ended');
    expect(state.progress).toEqual([]);
    expect(state.captureState.active).toBe(false);
  });

  it('delayed live frames of an acknowledged-ended session are ignored; completing frames still apply', () => {
    state.adoptSession(sessionRecord('S1', { status: 'capturing' }), ENDPOINT);
    state.applySessionEnded('S1', { cleanup: 'pending' });

    state.applyCaptureStarted({ sessionId: 'S1', captureId: 'C9' });
    state.applyInstrumentationPlan(
      payload<InstrumentationPlanPayload>({ sessionId: 'S1', plan: { planVersion: 2 } }),
    );
    state.applyInstrumentationReady(
      payload<InstrumentationReadyPayload>({
        sessionId: 'S1',
        applied: [appliedPatch('S1')],
        runtimeHooks: ['fetch'],
        unavailable: [],
      }),
    );
    state.applyInstrumentationFailed(
      payload<InstrumentationFailedPayload>({
        sessionId: 'S1',
        error: { code: 'INSTRUMENTATION_INSTALL_FAILED', message: 'late failure' },
      }),
    );
    state.applyProgress(progressRow('S1', 'Still working'));
    state.applyTargetSelected(targetSelected('S1', '#late'));

    expect(state.captureState.active).toBe(false);
    expect(state.activeSession?.plans).toEqual([]);
    expect(state.modifications).toEqual([]);
    expect(state.runtimeHooks).toEqual([]);
    expect(state.failure).toBeUndefined();
    expect(state.progress).toEqual([]);
    expect(state.target).toBeUndefined();

    state.applyProgress({
      ...progressRow('S1', 'Cleanup finished'),
      stage: 'cleanup',
      status: 'done',
    });
    state.applyCaptureStopped(
      payload<CaptureStoppedPayload>({
        sessionId: 'S1',
        captureId: 'C1',
        summary: { eventCount: 3 },
      }),
    );
    state.applyAnalysis(payload<AnalysisResult>({ sessionId: 'S1', analysisVersion: 1 }));
    state.applyCleanupCompleted({
      sessionId: 'S1',
      status: 'conflict',
      conflicts: [contentConflict('S1', T0 + 2)],
    });

    expect(state.progress.map((row) => row.status)).toEqual(['done']);
    expect(state.captureState).toEqual({ active: false, captureId: 'C1', eventCount: 3 });
    expect(state.latestAnalysis?.analysisVersion).toBe(1);
    expect(state.cleanup.status).toBe('conflict');
    expect(state.cleanup.conflicts).toHaveLength(1);
  });

  it('a list answer computed before the end never shows the session live again', () => {
    state.adoptSession(sessionRecord('S1', { status: 'capturing' }), ENDPOINT);
    state.applySessionEnded('S1', { cleanup: 'clean' });
    state.adoptSession(sessionRecord('S2'), ENDPOINT);

    state.setSessionList(
      listPage(
        sessionRecord('S1', { status: 'capturing', updatedAt: T0 + 30 }),
        sessionRecord('S2'),
      ),
    );

    expect(state.sessionList.map((listed) => `${listed.id}:${listed.status}`)).toEqual([
      'S1:ended',
      'S2:ready',
    ]);

    // The next list keeps an entry the previous one showed ended.
    state.setSessionList(listPage(sessionRecord('S1', { status: 'ready', updatedAt: T0 + 31 })));
    expect(state.sessionList.map((listed) => listed.status)).toEqual(['ended']);
  });

  it('adopting a stale live answer of an acknowledged-ended session adopts it as ended', () => {
    state.adoptSession(sessionRecord('S1', { status: 'capturing' }), ENDPOINT);
    state.applySessionEnded('S1', { cleanup: 'clean' });
    state.adoptSession(sessionRecord('S2'), ENDPOINT);

    state.adoptSession(sessionRecord('S1', { status: 'ready', updatedAt: T0 + 40 }), ENDPOINT);

    expect(state.activeSessionId).toBe('S1');
    expect(state.activeSession?.status).toBe('ended');
  });

  it(`remembers at most ${String(MAX_ACKNOWLEDGED_ENDS)} ends beyond the view and the list`, () => {
    for (let index = 0; index <= MAX_ACKNOWLEDGED_ENDS; index += 1) {
      state.applySessionRecord(sessionRecord(`E${String(index)}`, { status: 'ended' }));
    }

    expect(state.hasAcknowledgedEnd('E0')).toBe(false);
    expect(state.hasAcknowledgedEnd('E1')).toBe(true);
    expect(state.hasAcknowledgedEnd(`E${String(MAX_ACKNOWLEDGED_ENDS)}`)).toBe(true);
    expect(state.hasAcknowledgedEnd('never-seen')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The shutdown gate and the create ledger
// ---------------------------------------------------------------------------

describe('the shutdown gate and the create ledger', () => {
  it('isShuttingDown is false until beginShutdown or dispose, and beginShutdown is idempotent', () => {
    expect(state.isShuttingDown).toBe(false);

    state.beginShutdown();
    state.beginShutdown();

    expect(state.isShuttingDown).toBe(true);

    const other = new ExtensionState({ serviceUrl: ENDPOINT, provider: 'deterministic' });
    other.dispose();
    expect(other.isShuttingDown).toBe(true);
  });

  it('beginShutdown closes every creation window, births new ones closed, and makes adoption inert', () => {
    state.adoptSession(sessionRecord('S1', { status: 'capturing' }), ENDPOINT);
    const creation = state.beginSessionCreation();
    state.applyProgress(progressRow('S2', 'Held for S2'));

    state.beginShutdown();

    expect(creation.isOpen).toBe(false);
    expect(state.sessionCreationPending).toBe(false);
    creation.adopt(sessionRecord('S2', { status: 'created' }), ENDPOINT);
    expect(state.activeSessionId).toBe('S1');

    const late = state.beginSessionCreation();
    expect(late.isOpen).toBe(false);
    state.adoptSession(sessionRecord('S3', { status: 'created' }), OTHER_ENDPOINT);
    state.adoptSession(sessionRecord('S1', { status: 'ended', updatedAt: T0 + 9 }), ENDPOINT);

    expect(state.activeSessionId).toBe('S1');
    expect(state.activeSession?.status).toBe('capturing');
    expect(state.activeSessionEndpoint).toBe(ENDPOINT);
    expect(state.progress).toEqual([]);
  });

  it('frames of the active session still apply once shutdown began', () => {
    state.adoptSession(sessionRecord('S1', { status: 'capturing' }), ENDPOINT);
    state.beginShutdown();

    state.applySessionRecord(sessionRecord('S1', { status: 'ended', updatedAt: T0 + 9 }));

    expect(state.activeSession?.status).toBe('ended');
  });

  it('a ticket is in flight until it settles, and the first of adopted, orphaned and none wins', async () => {
    const adopted = state.trackSessionCreate(ENDPOINT);
    const nothing = state.trackSessionCreate(OTHER_ENDPOINT);

    expect(adopted.endpoint).toBe(ENDPOINT);
    expect(state.sessionCreatesInFlight).toEqual([adopted.settled, nothing.settled]);

    adopted.adopted('S1');
    adopted.none();
    expect(adopted.orphaned('S1')).toBe(false);
    nothing.none();
    nothing.adopted('S9');

    await expect(adopted.settled).resolves.toEqual({ sessionId: 'S1', endpoint: ENDPOINT });
    await expect(nothing.settled).resolves.toBeUndefined();
    expect(state.sessionCreatesInFlight).toEqual([]);
    expect(state.claimOrphanedSessions()).toEqual([]);
  });

  it('orphaned hands the session over only after beginShutdown, and before it is recorded as settled', async () => {
    const before = state.trackSessionCreate(ENDPOINT);
    expect(before.orphaned('S1')).toBe(false);
    await expect(before.settled).resolves.toEqual({ sessionId: 'S1', endpoint: ENDPOINT });

    const during = state.trackSessionCreate(OTHER_ENDPOINT);
    state.beginShutdown();
    const claimedOnSettle = during.settled.then(() => state.claimOrphanedSessions());
    expect(during.orphaned('S2')).toBe(true);
    expect(during.orphaned('S2')).toBe(true);

    await expect(claimedOnSettle).resolves.toEqual([{ sessionId: 'S2', endpoint: OTHER_ENDPOINT }]);
  });

  it('claiming seals the hand-over: a ticket orphaned afterwards must be ended by its creator', () => {
    const late = state.trackSessionCreate(ENDPOINT);
    state.beginShutdown();

    expect(state.claimOrphanedSessions()).toEqual([]);
    expect(late.orphaned('S3')).toBe(false);
    expect(state.claimOrphanedSessions()).toEqual([]);
  });

  it('the ledger and the gate survive dispose, as VS Code disposes the store before deactivate settles', async () => {
    const ticket = state.trackSessionCreate(ENDPOINT);
    state.beginShutdown();

    state.dispose();

    expect(state.isShuttingDown).toBe(true);
    expect(state.sessionCreatesInFlight).toEqual([ticket.settled]);
    expect(ticket.orphaned('S4')).toBe(true);
    await expect(ticket.settled).resolves.toEqual({ sessionId: 'S4', endpoint: ENDPOINT });
    expect(state.sessionCreatesInFlight).toEqual([]);
    expect(state.claimOrphanedSessions()).toEqual([{ sessionId: 'S4', endpoint: ENDPOINT }]);
  });
});

// ---------------------------------------------------------------------------
// applyModificationJournal
// ---------------------------------------------------------------------------

describe('applyModificationJournal', () => {
  it("records the active session's journal in its order, keeping held records it does not list yet", async () => {
    const events: WebviewState[] = [];
    state.onDidChange((snapshot) => events.push(snapshot));
    state.adoptSession(sessionRecord('S1', { status: 'capturing' }), ENDPOINT);
    state.applyInstrumentationReady({
      sessionId: 'S1',
      applied: [appliedPatch('S1', 'S1-mod-9')],
      runtimeHooks: [],
      unavailable: [],
    });
    await flushed();
    events.length = 0;

    const applied = state.applyModificationJournal('S1', [
      appliedPatch('S1', 'S1-mod-1'),
      appliedPatch('S1', 'S1-mod-2'),
    ]);
    await flushed();

    expect(applied).toBe(true);
    expect(state.modifications.map((record) => record.id)).toEqual([
      'S1-mod-1',
      'S1-mod-2',
      'S1-mod-9',
    ]);
    expect(events).toHaveLength(1);
  });

  it("never moves a held record's status back, takes a record further along, and ignores other sessions' records", () => {
    state.adoptSession(
      sessionRecord('S1', {
        status: 'ended',
        modifications: [
          { ...appliedPatch('S1', 'S1-mod-1'), status: 'reverted' },
          appliedPatch('S1', 'S1-mod-2'),
        ],
      }),
      ENDPOINT,
    );

    state.applyModificationJournal('S1', [
      appliedPatch('S1', 'S1-mod-1'),
      { ...appliedPatch('S1', 'S1-mod-2'), status: 'conflict' },
      appliedPatch('S2', 'S2-mod-1'),
    ]);

    expect(state.modifications.map((record) => [record.id, record.status])).toEqual([
      ['S1-mod-1', 'reverted'],
      ['S1-mod-2', 'conflict'],
    ]);
  });

  it('applies to a session acknowledged as ended, and to no session but the active one', () => {
    state.adoptSession(sessionRecord('S1', { status: 'capturing' }), ENDPOINT);
    state.applySessionEnded('S1', { cleanup: 'conflict' });

    expect(
      state.applyModificationJournal('S1', [{ ...appliedPatch('S1'), status: 'conflict' }]),
    ).toBe(true);
    expect(state.modifications.map((record) => record.status)).toEqual(['conflict']);

    expect(state.applyModificationJournal('S2', [appliedPatch('S2')])).toBe(false);
    expect(state.modifications.map((record) => record.sessionId)).toEqual(['S1']);
  });

  it('changes nothing on a disposed store', () => {
    state.adoptSession(sessionRecord('S1'), ENDPOINT);
    state.dispose();

    expect(state.applyModificationJournal('S1', [appliedPatch('S1')])).toBe(false);
    expect(state.modifications).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// pendingTarget
// ---------------------------------------------------------------------------

describe('pendingTarget', () => {
  it('is the element selected while no session is active', () => {
    state.applyTargetSelected(targetSelected('S0', '#pick'));

    expect(state.pendingTarget?.selector).toBe('#pick');
  });

  it("is never the active session's own target", () => {
    state.adoptSession(sessionRecord('S1'), ENDPOINT);
    state.applyTargetSelected(targetSelected('S1', '#own'));

    expect(state.target?.selector).toBe('#own');
    expect(state.pendingTarget).toBeUndefined();
  });

  it('is superseded once a session is adopted', () => {
    state.applyTargetSelected(targetSelected('S0', '#pick'));

    state.adoptSession(sessionRecord('S1'), ENDPOINT);

    expect(state.pendingTarget).toBeUndefined();
  });
});
