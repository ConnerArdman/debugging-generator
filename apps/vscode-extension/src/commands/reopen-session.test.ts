/**
 * Tests for `./reopen-session.ts`: `debuggen.reopenSession` sends exactly one
 * `GET /sessions/:id` per reopen and announces nothing itself, however the
 * service's replay of the stored session interleaves with its answer.
 *
 * The command runs against a fake {@link CommandContext} whose store is the
 * real `ExtensionState`, so what is asserted is what the view renders. The
 * fake client answers `getSession` and, while the request is in flight,
 * delivers what the service pushes for a re-read session — the record, every
 * stored progress row under the envelope time it was first sent with, and the
 * latest `panel.generated` — through the store's own mutators, exactly where
 * `src/extension.ts` applies them. Every UI call is a spy. `vi.mock`
 * substitutes the `vscode` module, of which the store needs only its
 * `EventEmitter`.
 *
 * What is pinned:
 *
 * - a reopen of a stored ended session sends one request, adopts the record,
 *   applies the replay the creation window held — the panel summary and the
 *   settled rows, no spinner — reveals the view and shows no notice;
 * - reopening the same session again sends one more request and its replay
 *   adds no progress row, so neither path duplicates what the view shows.
 */

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import type {
  PanelGeneratedPayload,
  SessionProgressPayload,
  SessionRecord,
} from '@debuggen/protocol';
import { ok } from '@debuggen/shared';
import type { LogFields, Logger, Result, DebuggenError } from '@debuggen/shared';

import type { SessionEndpointCallOptions } from '../service/client';
import { ExtensionState } from '../state';

import type { CommandContext, CommandNotice } from './index';
import { reopenSession } from './reopen-session';

vi.mock('vscode', () => {
  /** The part of `vscode.EventEmitter` `ExtensionState` uses, delivering synchronously. */
  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();

    readonly event = (listener: (value: T) => void): { dispose(): void } => {
      this.listeners.add(listener);
      return {
        dispose: () => {
          this.listeners.delete(listener);
        },
      };
    };

    fire(value: T): void {
      for (const listener of [...this.listeners]) {
        listener(value);
      }
    }

    dispose(): void {
      this.listeners.clear();
    }
  }
  return { EventEmitter, workspace: {} };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;

/** The stored session every case reopens. */
const SESSION_ID = 'ses_reopen_session_0001';

/** The service that owns it, and the address the client is configured with. */
const OWNER = 'http://127.0.0.1:43118';

/** The panel the service replays for it. */
const PANEL_ID = 'pnl_reopen_session_0001';

/** The generated focus command of the `debuggen.session` view. */
const SESSION_VIEW_FOCUS = 'debuggen.session.focus';

/** The stored session: ended, its instrumentation removed. */
function endedRecord(): SessionRecord {
  return {
    id: SESSION_ID,
    projectRoot: '/workspace/reopen-session',
    projectName: 'reopen-session',
    devServerUrl: 'http://127.0.0.1:3100',
    createdAt: T0,
    updatedAt: T0 + 5_000,
    status: 'ended',
    question: 'Why does the list render twice?',
    followUps: [],
    relevantFiles: [],
    plans: [],
    modifications: [],
    captures: [],
    panelIds: [PANEL_ID],
    analyses: [],
    cleanup: { status: 'clean', completedAt: T0 + 5_000, conflicts: [] },
    promptVersions: {},
    provider: { id: 'deterministic' },
  };
}

/** One stored progress row of the session. */
function row(
  stage: SessionProgressPayload['stage'],
  status: SessionProgressPayload['status'],
  message: string,
): SessionProgressPayload {
  return { sessionId: SESSION_ID, stage, status, message };
}

/**
 * The session's stored progress, each row with the envelope time it was first
 * sent with — which the service's replay carries unchanged.
 */
const STORED_PROGRESS: readonly (readonly [SessionProgressPayload, number])[] = [
  [row('understand', 'running', 'Understanding problem'), T0 + 1],
  [row('understand', 'done', 'Understanding problem'), T0 + 2],
  [row('capture', 'running', 'Capturing runtime evidence'), T0 + 3],
  [row('capture', 'done', 'Capturing runtime evidence'), T0 + 4],
  [row('generate-panel', 'running', 'Generating debugging panel'), T0 + 5],
  [row('generate-panel', 'done', 'Generating debugging panel'), T0 + 6],
];

/** The latest `panel.generated` the service replays, with the members the store reads. */
const STORED_PANEL = {
  sessionId: SESSION_ID,
  panelId: PANEL_ID,
  panel: { id: PANEL_ID, title: 'Render counts', panelVersion: 1 },
} as unknown as PanelGeneratedPayload;

/** What the view shows once the replay is applied: every step settled, once. */
const SETTLED_LINES: readonly string[] = [
  'understand done Understanding problem',
  'capture done Capturing runtime evidence',
  'generate-panel done Generating debugging panel',
];

/** One log call, as a recording logger captured it. */
interface LogRecord {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

/** A logger that records every call, so no case needs a real sink. */
function recordingLogger(logs: LogRecord[]): Logger {
  const write =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      logs.push({ level, message, fields });
    };
  const logger: Logger = {
    level: 'trace',
    trace: write('trace'),
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    fatal: write('fatal'),
    child: () => logger,
  };
  return logger;
}

/** The fake context and every spy a case asserts on. */
interface Harness {
  readonly ctx: CommandContext;
  readonly state: ExtensionState;
  readonly getSession: Mock<
    (
      sessionId: string,
      options?: SessionEndpointCallOptions,
    ) => Promise<Result<SessionRecord, DebuggenError>>
  >;
  readonly notify: Mock<(notice: CommandNotice) => Promise<string | undefined>>;
  readonly notifyFailure: Mock<(error: DebuggenError) => Promise<string | undefined>>;
  readonly confirmDestructive: Mock<() => Promise<boolean>>;
  readonly executed: string[];
}

/** Every store a case created, disposed after it. */
const stores: ExtensionState[] = [];

afterEach(() => {
  for (const state of stores.splice(0)) {
    state.dispose();
  }
});

/**
 * Builds the fake context. `getSession` delivers the service's replay of the
 * stored session to the store before it answers — the order in which a
 * socket that is open receives the pushes and the HTTP answer.
 */
function createHarness(): Harness {
  const state = new ExtensionState({ serviceUrl: OWNER, provider: 'deterministic' });
  stores.push(state);
  const executed: string[] = [];

  const getSession = vi.fn((sessionId: string, options?: SessionEndpointCallOptions) => {
    expect(sessionId).toBe(SESSION_ID);
    expect(options?.endpoint).toBe(OWNER);
    const stored = endedRecord();
    state.applySessionRecord(stored);
    for (const [payload, sentAt] of STORED_PROGRESS) {
      state.applyProgress(payload, sentAt);
    }
    state.applyPanelGenerated(STORED_PANEL);
    return Promise.resolve<Result<SessionRecord, DebuggenError>>(ok(stored));
  });
  const notify = vi.fn((notice: CommandNotice) => {
    void notice;
    return Promise.resolve<string | undefined>(undefined);
  });
  const notifyFailure = vi.fn((error: DebuggenError) => {
    void error;
    return Promise.resolve<string | undefined>(undefined);
  });
  const confirmDestructive = vi.fn(() => Promise.resolve(false));

  const logs: LogRecord[] = [];
  const ctx = {
    state,
    client: {
      baseUrl: OWNER,
      state: 'open',
      configurationError: undefined,
      getSession,
    },
    sessionsTree: {
      refresh: () => Promise.resolve(),
    },
    logger: recordingLogger(logs),
    ui: {
      notify,
      notifyFailure,
      confirmDestructive,
      pick: () => Promise.resolve(undefined),
      executeCommand: (command: string) => {
        executed.push(command);
        return Promise.resolve(undefined);
      },
    },
  } as unknown as CommandContext;

  return { ctx, state, getSession, notify, notifyFailure, confirmDestructive, executed };
}

/** The rows as `stage status message` lines, in the order the view draws them. */
function lines(state: ExtensionState): string[] {
  return state.progress.map((entry) => `${entry.stage} ${entry.status} ${entry.message}`);
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('debuggen.reopenSession', () => {
  it('sends one request, applies the held replay and announces nothing', async () => {
    const harness = createHarness();

    await reopenSession(harness.ctx, SESSION_ID);

    expect(harness.getSession).toHaveBeenCalledTimes(1);
    expect(harness.state.activeSessionId).toBe(SESSION_ID);
    expect(harness.state.activeSession?.status).toBe('ended');
    // The replay beat the answer, was held, and was applied on adoption.
    expect(harness.state.latestPanel?.id).toBe(PANEL_ID);
    expect(lines(harness.state)).toEqual(SETTLED_LINES);
    // The reopen itself says nothing: no notice, no failure, no confirmation.
    expect(harness.notify).not.toHaveBeenCalled();
    expect(harness.notifyFailure).not.toHaveBeenCalled();
    expect(harness.confirmDestructive).not.toHaveBeenCalled();
    expect(harness.executed).toEqual([SESSION_VIEW_FOCUS]);
  });

  it('reopening the session in view again sends one more request, and its replay adds nothing', async () => {
    const harness = createHarness();
    await reopenSession(harness.ctx, SESSION_ID);
    const shown = harness.state.progress;

    await reopenSession(harness.ctx, SESSION_ID);

    expect(harness.getSession).toHaveBeenCalledTimes(2);
    expect(harness.state.progress).toBe(shown);
    expect(lines(harness.state)).toEqual(SETTLED_LINES);
    expect(harness.notify).not.toHaveBeenCalled();
    expect(harness.notifyFailure).not.toHaveBeenCalled();
    expect(harness.executed).toEqual([SESSION_VIEW_FOCUS, SESSION_VIEW_FOCUS]);
  });
});
