/**
 * @file Unit tests: how `session.create` ties a new session to the dev server
 * it is created against.
 *
 * Two pieces of `./sessions.ts` decide it, and both are exercised here over a
 * real session manager on a real `node:sqlite` store in a private sandbox:
 *
 * - {@link joinLaunchedDevServer}: the hold taken — together with the URL —
 *   before the session was created is handed over after. A session-owned child
 *   counts the new session among its owners; a developer-owned one needs no
 *   owner; a child that exited meanwhile is replaced by the project's relaunched
 *   dev server when there is one (and the session records its address), and is
 *   reported lost otherwise; a session ended meanwhile owns nothing.
 * - {@link devServerLookupFromLaunches}'s verification of a URL the editor
 *   sent: the service's own probe must get an answer, and the preload is
 *   attributed to the process there only through the launcher's own evidence
 *   (`preloadServesAt`) — never through some connected agent of the project.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type { SessionRecord } from '@debuggen/protocol';
import { DebuggenError, isErr, noopLogger, ok } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';

import { loadServiceConfig } from '../../config.js';
import type { DevServerProbeResult } from '../../dev-server/detect.js';
import { createSessionManager } from '../../sessions/manager.js';
import type { SessionBroadcaster, SessionManager } from '../../sessions/manager.js';
import { createSessionProgress } from '../../sessions/progress.js';
import { openStore } from '../../store/db.js';
import { createSessionsRepo } from '../../store/sessions-repo.js';
import { devServerLookupFromLaunches, joinLaunchedDevServer } from './sessions.js';
import type {
  SessionDevServerHold,
  SessionDevServerLookup,
  VerifiedDevServerUrl,
} from './sessions.js';

/** A fixed clock reading, so every timestamp is exact. */
const FIXED_NOW = 1_760_000_000_000;

/** The question every session asks; nothing may branch on it (AAP §0.5.4). */
const QUESTION = 'Why does the order history list take so long to load?';

/** Where the held dev server serves; nothing is ever dialled. */
const HELD_URL = 'http://127.0.0.1:4173/';

/** Where a relaunched dev server of the same project serves. */
const RELAUNCHED_URL = 'http://127.0.0.1:4174/';

/** The operation label the join logs under. */
const OPERATION = 'session.create';

/** Everything a test opened, closed after it in reverse order. */
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) {
    close();
  }
});

/** A private sandbox directory, removed after the test. */
function sandbox(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `debuggen-session-routes-${label}-`));
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

/** A session manager over a real store, with a silent broadcaster and no cleanup runner. */
function createManager(): SessionManager {
  const home = sandbox('home');
  const config = expectOk(loadServiceConfig({}, { homeDir: home, debuggenHome: home }));
  const store = expectOk(openStore({ config }));
  cleanups.push(() => {
    store.close();
  });
  const sessions = createSessionsRepo({ store, now: () => FIXED_NOW });
  const broadcaster: SessionBroadcaster = {
    broadcast: () => undefined,
    broadcastToKinds: () => undefined,
  };
  const progress = createSessionProgress({ sessions, broadcaster, now: () => FIXED_NOW });
  return createSessionManager({ sessions, broadcaster, progress, config, now: () => FIXED_NOW });
}

/** A session created against {@link HELD_URL}. */
async function createSession(manager: SessionManager): Promise<SessionRecord> {
  return expectOk(
    await manager.create({
      projectRoot: sandbox('project'),
      question: QUESTION,
      devServerUrl: HELD_URL,
    }),
  );
}

/** A hold double whose `commit` answers `joined` (or throws), and that commit's mock. */
function hold(options: {
  readonly devServerUrl?: string;
  readonly sessionOwned: boolean;
  readonly joined: boolean | 'throws';
}): SessionDevServerHold & { readonly commits: Mock<(sessionId: string) => boolean> } {
  const commits = vi.fn<(sessionId: string) => boolean>(() => {
    if (options.joined === 'throws') {
      throw new Error('the launcher failed');
    }
    return options.joined;
  });
  return {
    devServerUrl: options.devServerUrl ?? HELD_URL,
    sessionOwned: options.sessionOwned,
    commit: (sessionId) => commits(sessionId),
    release: () => Promise.resolve(),
    commits,
  };
}

describe('joinLaunchedDevServer', () => {
  it('joins a session-owned child the session was created against', async () => {
    const manager = createManager();
    const session = await createSession(manager);
    const held = hold({ sessionOwned: true, joined: true });

    const outcome = await joinLaunchedDevServer(held, session, {
      manager,
      log: noopLogger,
      operation: OPERATION,
    });

    expect(outcome).toBe('joined');
    expect(held.commits).toHaveBeenCalledWith(session.id);
  });

  it('needs no owner for a developer-owned child', async () => {
    const manager = createManager();
    const session = await createSession(manager);

    const outcome = await joinLaunchedDevServer(
      hold({ sessionOwned: false, joined: false }),
      session,
      { manager, log: noopLogger, operation: OPERATION },
    );

    expect(outcome).toBe('developer-owned');
  });

  it('joins the relaunched dev server of the project when the held one exited, recording its address', async () => {
    const manager = createManager();
    const session = await createSession(manager);
    const relaunched = hold({ devServerUrl: RELAUNCHED_URL, sessionOwned: true, joined: true });
    const acquireLaunched = vi.fn(() => relaunched);

    const outcome = await joinLaunchedDevServer(
      hold({ sessionOwned: true, joined: false }),
      session,
      { manager, devServers: { acquireLaunched }, log: noopLogger, operation: OPERATION },
    );

    expect(outcome).toBe('rejoined');
    expect(acquireLaunched).toHaveBeenCalledWith(session.projectRoot);
    expect(relaunched.commits).toHaveBeenCalledWith(session.id);
    expect(expectOk(manager.get(session.id))?.devServerUrl).toBe(RELAUNCHED_URL);
  });

  it('reports the join lost when the held child exited and nothing serves the project now', async () => {
    const manager = createManager();
    const session = await createSession(manager);

    const outcome = await joinLaunchedDevServer(
      hold({ sessionOwned: true, joined: 'throws' }),
      session,
      {
        manager,
        devServers: { acquireLaunched: () => undefined },
        log: noopLogger,
        operation: OPERATION,
      },
    );

    expect(outcome).toBe('lost');
    // The session keeps the address it was created with; readiness reports the stopped server.
    expect(expectOk(manager.get(session.id))?.devServerUrl).toBe(HELD_URL);
  });

  it('owns nothing for a session a concurrent request already ended', async () => {
    const manager = createManager();
    const session = await createSession(manager);
    expectOk(await manager.end(session.id));
    const acquireLaunched = vi.fn(() => hold({ sessionOwned: true, joined: true }));

    const outcome = await joinLaunchedDevServer(
      hold({ sessionOwned: true, joined: false }),
      session,
      { manager, devServers: { acquireLaunched }, log: noopLogger, operation: OPERATION },
    );

    expect(outcome).toBe('session-ended');
    expect(acquireLaunched).not.toHaveBeenCalled();
  });
});

describe('devServerLookupFromLaunches: a URL the editor sent', () => {
  /** A probe that answers `reachable` for every URL. */
  function probeAnswering(
    reachable: boolean,
  ): (url: string) => Promise<Result<DevServerProbeResult, DebuggenError>> {
    return (url) =>
      Promise.resolve(
        ok(
          reachable
            ? { url, reachable: true, status: 200, durationMs: 2 }
            : {
                url,
                reachable: false,
                durationMs: 1,
                error: { code: 'ECONNREFUSED', message: 'Connection refused.' },
              },
        ),
      );
  }

  const PROJECT = '/work/storefront';

  /** The lookup's verification of `url`, which every lookup built with a probe has. */
  async function verify(
    lookup: SessionDevServerLookup,
    url: string,
  ): Promise<Result<VerifiedDevServerUrl, DebuggenError>> {
    const check = lookup.verifyRequestedUrl?.bind(lookup);
    if (check === undefined) {
      throw new Error('expected a lookup that verifies requested URLs');
    }
    return check(PROJECT, url);
  }

  it('attributes the preload only when the launcher serves the answering address itself', async () => {
    const preloadServesAt = vi.fn(
      (projectRoot: string, url: string) => projectRoot === PROJECT && url === HELD_URL,
    );
    const lookup = devServerLookupFromLaunches(
      { list: () => [], preloadServesAt },
      { probe: probeAnswering(true) },
    );

    const attributed = expectOk(await verify(lookup, HELD_URL));
    const plain = expectOk(await verify(lookup, RELAUNCHED_URL));

    expect(attributed).toStrictEqual({ url: HELD_URL, preloadAttributed: true });
    expect(plain).toStrictEqual({ url: RELAUNCHED_URL, preloadAttributed: false });
  });

  it('records an answering address untraced without launcher evidence, or when it fails', async () => {
    const withoutEvidence = devServerLookupFromLaunches(
      { list: () => [] },
      { probe: probeAnswering(true) },
    );
    const failing = devServerLookupFromLaunches(
      {
        list: () => [],
        preloadServesAt: () => {
          throw new Error('registry unavailable');
        },
      },
      { probe: probeAnswering(true) },
    );

    expect(expectOk(await verify(withoutEvidence, HELD_URL))).toMatchObject({
      preloadAttributed: false,
    });
    expect(expectOk(await verify(failing, HELD_URL))).toMatchObject({ preloadAttributed: false });
  });

  it('refuses an address nothing answers at', async () => {
    const lookup = devServerLookupFromLaunches(
      { list: () => [], preloadServesAt: () => true },
      { probe: probeAnswering(false) },
    );

    const refused = await verify(lookup, HELD_URL);

    expect(isErr(refused) ? refused.error.code : undefined).toBe('DEV_SERVER_UNAVAILABLE');
  });

  it('acquires the launched dev server through the registry’s hold', () => {
    const held = hold({ sessionOwned: true, joined: true });
    const acquireForSession = vi.fn(() => held);
    const lookup = devServerLookupFromLaunches({ list: () => [], acquireForSession });

    expect(lookup.acquireLaunched?.(PROJECT)).toBe(held);
    expect(acquireForSession).toHaveBeenCalledWith(PROJECT);
  });
});
