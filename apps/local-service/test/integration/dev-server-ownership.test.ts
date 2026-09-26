/**
 * @file Integration suite: who owns a launched dev server, and where a new
 * session's dev-server URL comes from.
 *
 * An in-process service on an ephemeral port with the deterministic provider
 * and a temporary `$DEBUGGEN_HOME` (AAP §0.8.3), driven only over HTTP and
 * WebSocket through the shared harness. Every dev server the service launches
 * is the harness's stand-in (`standInDevServerCommand`), so no fixture code
 * runs; the "external" dev servers the editor points a session at are plain
 * `node:http` servers this suite starts on loopback. Each answers with the
 * `X-Powered-By: Next.js` header a plain `next dev` sends, because detection
 * identifies a dev server only by its framework's response signature; one
 * started without it stands for an unidentified process holding the address.
 *
 * What it pins:
 *
 * - **Session-owned children** (AAP §0.7.1 Group 2, "child lifecycle tied to
 *   the session"): a `devServer.launch` that names a session spawns a child
 *   whose lifetime is that session's. Ending the session stops the child and
 *   revokes exactly its `server-agent` credential; a second session created
 *   against the child joins its owners, so the child lives until the last one
 *   ends.
 * - **Developer-owned children** (AAP §0.5.1): a launch that names no session
 *   is the developer's dev server, and it keeps serving after every session
 *   ends — the cleanup end-to-end run depends on exactly that.
 * - **Launch refusals**: a launch may not name an unknown session, a session
 *   of another project or an ended one.
 * - **The address a launch probes** (AAP §0.5.5): the configured URL the editor
 *   sends, else the one the named session recorded. A dev server already
 *   answering there that the service did not launch is refused with the exact
 *   relaunch command — even while a preload of another dev server of the same
 *   project is connected, because a connected agent of the project says
 *   nothing about the process at that address — and never duplicated on
 *   another port. An answer there without a framework signature is no dev
 *   server of the project at all: it is refused as an occupied address
 *   (`DEV_SERVER_UNAVAILABLE`), again minting and spawning nothing. A launch
 *   the session named records where its child serves.
 * - **The editor's dev-server URL** (AAP §0.2.3, "probed or launched"):
 *   `session.create` records a loopback URL the service's own probe got an
 *   answer at, refuses one nothing answers at (`DEV_SERVER_UNAVAILABLE`) or
 *   that names another host (`PROTOCOL_INVALID_MESSAGE`), and prefers a dev
 *   server the service launched for the project.
 */

import { createServer } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SessionRecord } from '@debuggen/protocol';
import { isErr, newSessionId } from '@debuggen/shared';
import type { DebuggenError, Result } from '@debuggen/shared';

import { HARNESS_TIMEOUTS, standInDevServerCommand, startHarness } from './harness.js';
import type { Harness } from './harness.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/** The question every session asks; nothing in the service may branch on it (AAP §0.5.4). */
const QUESTION = 'Why does the report page take so long to appear after a click?';

/** The statuses a freshly created session settles in before a page is bound. */
const SETTLED_STATUSES: ReadonlySet<SessionRecord['status']> = new Set([
  'instrumenting',
  'ready',
  'failed',
]);

/** A loopback HTTP server standing in for a dev server the developer started. */
interface ExternalDevServer {
  /** Where it answers, in the `origin/` form the service's probe renders. */
  readonly url: string;
  /** Stops it and drops every connection. Idempotent. */
  close(): Promise<void>;
}

/** Every external server a test started, closed after the suite. */
const externalServers: ExternalDevServer[] = [];

/** The `X-Powered-By` value a `next dev` server answers with: its framework signature. */
const NEXT_POWERED_BY = 'Next.js';

/**
 * Starts an {@link ExternalDevServer} on an ephemeral loopback port.
 *
 * @param signed Whether it answers with the Next.js response signature, as a
 *   plain `next dev` does (the default); `false` stands for a process that is
 *   not identifiable as this project's dev server.
 */
async function startExternalDevServer(signed = true): Promise<ExternalDevServer> {
  const server = createServer((_request, response) => {
    if (signed) {
      response.setHeader('X-Powered-By', NEXT_POWERED_BY);
    }
    response.end('external dev server');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The external dev server did not bind a TCP port.');
  }
  let closing: Promise<void> | undefined;
  const external: ExternalDevServer = {
    url: `http://127.0.0.1:${String(address.port)}/`,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      });
      return closing;
    },
  };
  externalServers.push(external);
  return external;
}

/** Whether anything answers at `url` right now. */
async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    await response.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

/** The error code of a refusal, or `undefined` for a success. */
function codeOf(result: Result<unknown, DebuggenError>): string | undefined {
  return isErr(result) ? result.error.code : undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Suite
 * ---------------------------------------------------------------------------------------------- */

describe('dev-server ownership and the dev-server URL of a new session', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ fixtureProject: false });
  }, HARNESS_TIMEOUTS.boot);

  afterAll(async () => {
    await Promise.all(externalServers.splice(0).map((server) => server.close()));
    await h.assertNoLeaks();
  }, HARNESS_TIMEOUTS.teardown);

  /** How many `server-agent` credentials the access boundary holds. */
  function serverAgentCredentialCount(): number {
    const row: unknown = h.store
      .statement("SELECT count(*) AS n FROM credentials WHERE role = 'server-agent'")
      .get();
    if (typeof row !== 'object' || row === null || !('n' in row) || typeof row.n !== 'number') {
      throw new Error('The credential count could not be read.');
    }
    return row.n;
  }

  /** A fresh fixture project copy, announced by the editor. */
  async function freshProject(): Promise<string> {
    const copy = await h.copyFixtureProject();
    await h.editor(copy.root);
    return copy.root;
  }

  /**
   * `devServer.launch` for `projectRoot`, tied to `sessionId` and probing
   * `devServerUrl` first when they are given.
   */
  function launchFor(
    projectRoot: string,
    sessionId?: string,
    devServerUrl?: string,
  ): ReturnType<Harness['launchDevServer']> {
    return h.http().request('devServer.launch', {
      body: {
        projectRoot,
        command: standInDevServerCommand(),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(devServerUrl === undefined ? {} : { devServerUrl }),
      },
      timeoutMs: HARNESS_TIMEOUTS.request,
    });
  }

  /** The stored session, or a test failure. */
  function storedSession(sessionId: string): SessionRecord {
    const loaded = h.repos.sessions.get(sessionId);
    if (isErr(loaded) || loaded.value === undefined) {
      throw new Error(`The session ${sessionId} could not be read.`);
    }
    return loaded.value;
  }

  /** Creates a session and waits until its pipeline has settled. */
  async function settledSession(
    projectRoot: string,
    devServerUrl?: string,
  ): Promise<SessionRecord> {
    const created = await h.createSession({
      projectRoot,
      question: QUESTION,
      ...(devServerUrl === undefined ? {} : { devServerUrl }),
    });
    return h.waitForSession(created.id, (record) => SETTLED_STATUSES.has(record.status));
  }

  /** Ends a session, asserting the end itself succeeded. */
  async function end(sessionId: string): Promise<void> {
    const ended = await h.endSession(sessionId, { timeoutMs: HARNESS_TIMEOUTS.teardown });
    expect(codeOf(ended)).toBeUndefined();
  }

  it(
    'records the dev-server URL the editor sent once the service’s own probe got an answer',
    async () => {
      const projectRoot = await freshProject();
      const external = await startExternalDevServer();

      const session = await settledSession(projectRoot, external.url);

      expect(session.devServerUrl).toBe(external.url);
      await end(session.id);
      // The developer's own server is nobody's to stop.
      expect(await answers(external.url)).toBe(true);
    },
    HARNESS_TIMEOUTS.pipeline * 2,
  );

  it('refuses a sent URL nothing answers at, and one that names another host', async () => {
    const projectRoot = await freshProject();
    const external = await startExternalDevServer();
    await external.close();

    const unreachable = await h.http().request('session.create', {
      body: { projectRoot, question: QUESTION, devServerUrl: external.url },
    });
    expect(codeOf(unreachable)).toBe('DEV_SERVER_UNAVAILABLE');

    const remote = await h.http().request('session.create', {
      body: { projectRoot, question: QUESTION, devServerUrl: 'http://example.com:3000/' },
    });
    expect(codeOf(remote)).toBe('PROTOCOL_INVALID_MESSAGE');

    // Assembled, so no URL with user info is ever written out in the tree.
    const withUserInfo = ['http://dev', 'pw@127.0.0.1:3000/'].join(':');
    const withCredentials = await h.http().request('session.create', {
      body: { projectRoot, question: QUESTION, devServerUrl: withUserInfo },
    });
    expect(codeOf(withCredentials)).toBe('PROTOCOL_INVALID_MESSAGE');
  });

  it(
    'prefers a dev server the service launched over the URL the editor sent',
    async () => {
      const projectRoot = await freshProject();
      const external = await startExternalDevServer();
      const launched = await launchFor(projectRoot);
      if (isErr(launched)) {
        throw new Error(`The dev server could not be launched: ${launched.error.message}`);
      }

      const session = await settledSession(projectRoot, external.url);

      expect(session.devServerUrl).toBe(launched.value.devServerUrl);
      await end(session.id);
    },
    HARNESS_TIMEOUTS.pipeline * 2,
  );

  it(
    'keeps a dev server launched without a session serving after the session ends',
    async () => {
      const projectRoot = await freshProject();
      const launched = await launchFor(projectRoot);
      if (isErr(launched)) {
        throw new Error(`The dev server could not be launched: ${launched.error.message}`);
      }
      const credentials = serverAgentCredentialCount();

      const session = await settledSession(projectRoot);
      expect(session.devServerUrl).toBe(launched.value.devServerUrl);
      await end(session.id);

      expect(await answers(launched.value.devServerUrl)).toBe(true);
      expect(serverAgentCredentialCount()).toBe(credentials);
    },
    HARNESS_TIMEOUTS.pipeline * 2,
  );

  it(
    'stops a dev server launched for a session when its last owning session ends, revoking only its credential',
    async () => {
      const projectRoot = await freshProject();
      const external = await startExternalDevServer();
      const first = await settledSession(projectRoot, external.url);
      // A credential of another dev server of the same project must survive the child's end.
      const bystander = h.issueServerAgentCredential(projectRoot);
      const before = serverAgentCredentialCount();

      // The session's own address is answered by a plain `next dev` the service
      // did not launch: it is not duplicated on another port, and the refusal
      // carries the relaunch command.
      const refused = await launchFor(projectRoot, first.id);
      expect(codeOf(refused)).toBe('SERVER_AGENT_NOT_READY');
      // The route answers the relaunch command in the message (AAP §0.5.5).
      expect(isErr(refused) ? refused.error.message : '').toContain('--import');
      expect(serverAgentCredentialCount()).toBe(before);

      // The developer stops it; the launch now starts the session's child, and
      // the session records where that child serves.
      await external.close();
      const launched = await launchFor(projectRoot, first.id);
      if (isErr(launched)) {
        throw new Error(`The dev server could not be launched: ${launched.error.message}`);
      }
      const childUrl = launched.value.devServerUrl;
      expect(serverAgentCredentialCount()).toBe(before + 1);
      expect(new URL(storedSession(first.id).devServerUrl).origin).toBe(new URL(childUrl).origin);

      // A second session created against the child joins its owners.
      const second = await settledSession(projectRoot);
      expect(second.devServerUrl).toBe(childUrl);

      await end(first.id);
      expect(await answers(childUrl)).toBe(true);
      expect(serverAgentCredentialCount()).toBe(before + 1);

      await end(second.id);
      expect(await answers(childUrl)).toBe(false);
      expect(serverAgentCredentialCount()).toBe(before);
      // The bystander was still live: revoking it now finds and deletes it.
      const bystanderRevoked = h.auth.revokeServerAgentCredential(bystander.token);
      expect(isErr(bystanderRevoked) ? undefined : bystanderRevoked.value).toBe(true);
    },
    HARNESS_TIMEOUTS.pipeline * 3,
  );

  it(
    'refuses to launch over a plain dev server at the configured address, even while another preload of the project is connected',
    async () => {
      const projectRoot = await freshProject();
      const external = await startExternalDevServer();
      // A preload of some other dev server of this project is connected.
      const bystander = h.issueServerAgentCredential(projectRoot);
      const agent = await h.ws({ client: 'server-agent', projectRoot, token: bystander.token });
      const before = serverAgentCredentialCount();

      const refused = await launchFor(projectRoot, undefined, external.url);

      expect(codeOf(refused)).toBe('SERVER_AGENT_NOT_READY');
      // The route answers the relaunch command in the message (AAP §0.5.5).
      expect(isErr(refused) ? refused.error.message : '').toContain('--import');
      // Nothing was minted or spawned, and the developer's server keeps serving.
      expect(serverAgentCredentialCount()).toBe(before);
      expect(await answers(external.url)).toBe(true);
      await agent.close();
    },
    HARNESS_TIMEOUTS.pipeline,
  );

  it(
    'refuses to launch over an unidentified process at the configured address as an occupied address',
    async () => {
      const projectRoot = await freshProject();
      const occupant = await startExternalDevServer(false);
      const before = serverAgentCredentialCount();

      const refused = await launchFor(projectRoot, undefined, occupant.url);

      // No framework signature: not this project's dev server, so no preload
      // question arises — the address is simply held by another process.
      expect(codeOf(refused)).toBe('DEV_SERVER_UNAVAILABLE');
      expect(serverAgentCredentialCount()).toBe(before);
      expect(await answers(occupant.url)).toBe(true);
    },
    HARNESS_TIMEOUTS.pipeline,
  );

  it(
    'reuses the dev server it launched when the configured address is that server’s',
    async () => {
      const projectRoot = await freshProject();
      const launched = await launchFor(projectRoot);
      if (isErr(launched)) {
        throw new Error(`The dev server could not be launched: ${launched.error.message}`);
      }
      const credentials = serverAgentCredentialCount();

      const again = await launchFor(projectRoot, undefined, launched.value.devServerUrl);

      expect(isErr(again) ? again.error.code : again.value.pid).toBe(launched.value.pid);
      expect(serverAgentCredentialCount()).toBe(credentials);
    },
    HARNESS_TIMEOUTS.pipeline,
  );

  it(
    'refuses a launch naming an unknown session, one of another project, or an ended one',
    async () => {
      const projectRoot = await freshProject();
      const otherRoot = await freshProject();
      const external = await startExternalDevServer();
      const session = await settledSession(projectRoot, external.url);

      expect(codeOf(await launchFor(projectRoot, newSessionId()))).toBe('SESSION_NOT_FOUND');
      expect(codeOf(await launchFor(otherRoot, session.id))).toBe('SESSION_INVALID_STATE');

      await end(session.id);
      expect(codeOf(await launchFor(projectRoot, session.id))).toBe('SESSION_INVALID_STATE');
    },
    HARNESS_TIMEOUTS.pipeline * 2,
  );
});
