/**
 * @file Unit tests: ending a session releases the dev servers launched for it.
 *
 * AAP §0.7.1 Group 2 ties a launched dev server's lifecycle to its session, so
 * `SessionManager.end` asks the injected `SessionDevServerRelease` port (the
 * launcher's `stopForSession`) to stop them — after cleanup has restored the
 * project's files, before the cleanup report is recorded. The release never
 * undoes the end, and it never hides an incomplete release: a refusal or a
 * rejection reaches both user interfaces as a `failed` cleanup progress row,
 * and the cleanup is reported `partial` — in the end response and in the store
 * — until the release port confirms the credential no longer authenticates,
 * or until the next start settles it (`settleIncompleteCleanups`). A `failed`
 * session keeps its dev server: `failed` is retryable.
 *
 * The manager runs over a real `node:sqlite` store and real progress module in
 * a private sandbox; only the broadcaster, the cleanup runner and the release
 * port are doubles.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProtocolMessage } from '@debuggen/protocol';
import { DebuggenError, err, isErr, ok } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';

import { loadServiceConfig } from '../config.js';
import { openStore } from '../store/db.js';
import { createSessionsRepo } from '../store/sessions-repo.js';
import type { SessionsRepo } from '../store/sessions-repo.js';
import { createSessionManager } from './manager.js';
import type {
  SessionBroadcaster,
  SessionCleanupRunner,
  SessionDevServerRelease,
  SessionManager,
} from './manager.js';
import { createSessionProgress, publicFailureCopy } from './progress.js';

/** A fixed clock reading, so every timestamp is exact. */
const FIXED_NOW = 1_760_000_000_000;

/** The question every session asks; nothing may branch on it (AAP §0.5.4). */
const QUESTION = 'Why does the summary panel take so long to refresh?';

/** The recorded dev-server URL; nothing is ever dialled. */
const DEV_SERVER_URL = 'http://127.0.0.1:4173/';

/** What the release port answers when a stopped child's credential is still being revoked. */
const PENDING_REVOCATION = new DebuggenError(
  'CLEANUP_PARTIAL',
  'The dev server was stopped, but its ingest credential could not be revoked yet.',
  {
    hint: 'Debug Generator keeps retrying the revocation.',
    details: { reason: 'credential-revocation-pending' },
  },
);

/** Everything a test opened, closed after it in reverse order. */
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) {
    close();
  }
});

/** A private sandbox directory, removed after the test. */
function sandbox(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `debuggen-manager-${label}-`));
  cleanups.push(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** The value of an `Ok`, or a test failure naming the error. */
function expectOk<T>(result: Result<T, DebuggenError>): T {
  if (isErr(result)) {
    throw new Error(`expected Ok, received Err(${result.error.code}): ${result.error.message}`);
  }
  return result.value;
}

/** Options of {@link createManager}. */
interface ManagerOptions {
  /** The state root to open, to reopen the store a previous manager used. */
  readonly home?: string;
  /** The cleanup runner's verdict for a session. Default: `clean`. */
  readonly verdict?: (sessionId: string) => 'clean' | 'partial' | 'conflict';
}

/** A manager over a real store, with the release port and a clean cleanup runner. */
function createManager(
  release: SessionDevServerRelease | undefined,
  options: ManagerOptions = {},
): {
  readonly manager: SessionManager;
  readonly sessions: SessionsRepo;
  readonly messages: ProtocolMessage[];
  readonly calls: string[];
  readonly home: string;
} {
  const home = options.home ?? sandbox('home');
  const config = expectOk(loadServiceConfig({}, { homeDir: home, debuggenHome: home }));
  const store = expectOk(openStore({ config }));
  cleanups.push(() => {
    store.close();
  });
  const sessions = createSessionsRepo({ store, now: () => FIXED_NOW });
  const messages: ProtocolMessage[] = [];
  const broadcaster: SessionBroadcaster = {
    broadcast: (_sessionId, message) => {
      messages.push(message);
    },
    broadcastToKinds: (_sessionId, _kinds, message) => {
      messages.push(message);
    },
  };
  const calls: string[] = [];
  const cleanup: SessionCleanupRunner = {
    run: (sessionId) => {
      calls.push(`cleanup:${sessionId}`);
      const status = options.verdict?.(sessionId) ?? 'clean';
      return Promise.resolve(ok({ status, conflicts: [], completedAt: FIXED_NOW }));
    },
  };
  const progress = createSessionProgress({ sessions, broadcaster, now: () => FIXED_NOW });
  const manager = createSessionManager({
    sessions,
    broadcaster,
    progress,
    cleanup,
    ...(release === undefined ? {} : { devServers: release }),
    // The deterministic provider every automated test uses (AAP §0.8.3).
    config,
    now: () => FIXED_NOW,
  });
  return { manager, sessions, messages, calls, home };
}

/** Every `cleanup.completed` status broadcast so far, in order. */
function completedStatuses(messages: readonly ProtocolMessage[]): string[] {
  return messages.flatMap((message) =>
    message.type === 'cleanup.completed' ? [message.payload.status] : [],
  );
}

/** Creates a session of a fresh project. */
async function createSession(manager: SessionManager): Promise<string> {
  const created = await manager.create({
    projectRoot: sandbox('project'),
    question: QUESTION,
    devServerUrl: DEV_SERVER_URL,
  });
  return expectOk(created).id;
}

/** Every `failed` cleanup-stage progress payload broadcast so far. */
function failedCleanupRows(
  messages: readonly ProtocolMessage[],
): { readonly message: string; readonly detail?: string | undefined }[] {
  return messages.flatMap((message) =>
    message.type === 'session.progress' &&
    message.payload.stage === 'cleanup' &&
    message.payload.status === 'failed'
      ? [{ message: message.payload.message, detail: message.payload.detail }]
      : [],
  );
}

describe('SessionManager.end releases the dev servers launched for the session', () => {
  it('asks the release port once, after cleanup, and ends the session', async () => {
    const released: string[] = [];
    const release = {
      stopForSession: vi.fn((id: string) => {
        released.push(id);
        return Promise.resolve(ok({ stopped: 1 }));
      }),
    };
    const { manager, messages, calls } = createManager({
      stopForSession: (id) => {
        calls.push(`release:${id}`);
        return release.stopForSession(id);
      },
    });
    const sessionId = await createSession(manager);

    const ended = expectOk(await manager.end(sessionId));

    expect(ended.session.status).toBe('ended');
    expect(ended.cleanup.status).toBe('clean');
    expect(calls).toEqual([`cleanup:${sessionId}`, `release:${sessionId}`]);
    expect(failedCleanupRows(messages)).toEqual([]);

    // A repeated end is answered from the stored record and releases nothing again.
    expectOk(await manager.end(sessionId));
    expect(release.stopForSession).toHaveBeenCalledTimes(1);
    expect(released).toEqual([sessionId]);
  });

  it('reports an incomplete release as a failed cleanup row without undoing the end', async () => {
    const release = {
      stopForSession: vi.fn(() => Promise.resolve(err(PENDING_REVOCATION))),
    };
    const { manager, sessions, messages } = createManager(release);
    const sessionId = await createSession(manager);

    const ended = expectOk(await manager.end(sessionId));

    expect(ended.session.status).toBe('ended');
    // Not reported clean while the credential still authenticates.
    expect(ended.cleanup.status).toBe('partial');
    expect(expectOk(sessions.get(sessionId))?.cleanup.status).toBe('partial');
    expect(completedStatuses(messages)).toEqual(['partial']);
    const rows = failedCleanupRows(messages);
    expect(rows).toHaveLength(1);
    // The row shows the public copy of the release's code, never the port's
    // own sentence (`./progress.ts`, CWE-209); the code rides in its detail.
    const shown = publicFailureCopy('cleanup', PENDING_REVOCATION.code).message;
    expect(rows[0]?.message).toBe(shown);
    expect(rows[0]?.message).not.toContain(PENDING_REVOCATION.message);
    expect(rows[0]?.detail).toContain(`error code: ${PENDING_REVOCATION.code}`);
    // Persisted too, so a reopened session shows it.
    const progress = expectOk(sessions.listProgress(sessionId));
    expect(
      progress.some(
        (row) => row.stage === 'cleanup' && row.status === 'failed' && row.message === shown,
      ),
    ).toBe(true);
  });

  it('survives a release port that rejects, reporting it the same way', async () => {
    const release = {
      stopForSession: vi.fn(() => Promise.reject(new Error('launcher crashed'))),
    };
    const { manager, messages } = createManager(release);
    const sessionId = await createSession(manager);

    const ended = expectOk(await manager.end(sessionId));

    expect(ended.session.status).toBe('ended');
    expect(failedCleanupRows(messages)).toHaveLength(1);
  });

  it('completes the cleanup report once the release port confirms the credential is gone', async () => {
    let confirm: () => void = () => undefined;
    const confirmed = new Promise<void>((resolve) => {
      confirm = resolve;
    });
    const { manager, sessions, messages } = createManager({
      stopForSession: () => Promise.resolve(err(PENDING_REVOCATION)),
      whenReleased: () => confirmed,
    });
    const sessionId = await createSession(manager);

    expect(expectOk(await manager.end(sessionId)).cleanup.status).toBe('partial');

    confirm();
    await vi.waitFor(() => {
      expect(expectOk(sessions.get(sessionId))?.cleanup.status).toBe('clean');
    });
    expect(completedStatuses(messages)).toEqual(['partial', 'clean']);
    // The ended session stays ended; the repeated end answers the completed report.
    expect(expectOk(await manager.end(sessionId)).cleanup.status).toBe('clean');
  });

  it('keeps a conflict a conflict when the release is also incomplete', async () => {
    const { manager } = createManager(
      { stopForSession: () => Promise.resolve(err(PENDING_REVOCATION)) },
      { verdict: () => 'conflict' },
    );
    const sessionId = await createSession(manager);

    expect(expectOk(await manager.end(sessionId)).cleanup.status).toBe('conflict');
  });

  it('keeps the dev server of a failed session, which stays retryable, and releases it at its end', async () => {
    const release = { stopForSession: vi.fn(() => Promise.resolve(ok({ stopped: 1 }))) };
    const { manager } = createManager(release);
    const sessionId = await createSession(manager);

    expectOk(
      await manager.fail(sessionId, {
        stage: 'investigate',
        code: 'MODEL_UNAVAILABLE',
        message: 'The model provider did not answer.',
      }),
    );
    expect(release.stopForSession).not.toHaveBeenCalled();

    expectOk(await manager.end(sessionId));
    expect(release.stopForSession).toHaveBeenCalledTimes(1);
  });

  it('ends a session without a release port, as a unit context does', async () => {
    const { manager, messages } = createManager(undefined);
    const sessionId = await createSession(manager);

    expect(expectOk(await manager.end(sessionId)).session.status).toBe('ended');
    expect(failedCleanupRows(messages)).toEqual([]);
  });
});

describe('SessionManager.settleIncompleteCleanups', () => {
  it('settles at the next start a report a stopped service left partial', async () => {
    // The first service ends the session while the credential is still pending, then stops.
    const first = createManager({ stopForSession: () => Promise.resolve(err(PENDING_REVOCATION)) });
    const sessionId = await createSession(first.manager);
    expect(expectOk(await first.manager.end(sessionId)).cleanup.status).toBe('partial');

    // The next start: same store, the leases of the previous service already revoked.
    const next = createManager(undefined, { home: first.home });
    expect(expectOk(await next.manager.settleIncompleteCleanups())).toBe(1);

    expect(expectOk(next.sessions.get(sessionId))?.cleanup.status).toBe('clean');
    expect(next.calls).toEqual([`cleanup:${sessionId}`]);
    expect(completedStatuses(next.messages)).toEqual(['clean']);
    // Idempotent: nothing is partial any more.
    expect(expectOk(await next.manager.settleIncompleteCleanups())).toBe(0);
  });

  it('leaves a report partial when a later pass still cannot settle it, and never touches a clean one', async () => {
    const first = createManager({ stopForSession: () => Promise.resolve(err(PENDING_REVOCATION)) });
    const stuck = await createSession(first.manager);
    expectOk(await first.manager.end(stuck));
    const clean = createManager(undefined, { home: first.home });
    const settledSession = await createSession(clean.manager);
    expect(expectOk(await clean.manager.end(settledSession)).cleanup.status).toBe('clean');

    const next = createManager(undefined, { home: first.home, verdict: () => 'partial' });
    expect(expectOk(await next.manager.settleIncompleteCleanups())).toBe(0);

    expect(expectOk(next.sessions.get(stuck))?.cleanup.status).toBe('partial');
    expect(expectOk(next.sessions.get(settledSession))?.cleanup.status).toBe('clean');
    // Only the partial session's cleanup ran again.
    expect(next.calls).toEqual([`cleanup:${stuck}`]);
  });
});
