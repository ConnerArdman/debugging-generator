/**
 * @file Unit tests: a connected dev-server preload across its credential's
 * lease, over the real access boundary, store and client registry.
 *
 * A launched child's `server-agent` credential is a lease the launcher renews
 * while the child runs (AAP §0.5.6). Its WebSocket authenticated once, at
 * `client.hello`, and the registry's expiry sweep closes it with `4401` once
 * its principal's expiry passes — which the preload treats as terminal. So:
 *
 * - a renewal must reach the connected socket: the principal reads its expiry
 *   from the credential row, and the sweep past the first lease leaves it open;
 * - a revocation must reach it too, at once: exactly the revoked credential's
 *   sockets are closed through `connectionRevokerOf`, never another
 *   credential's of the same project.
 *
 * `serverAgentConnectionsOf` — the launcher's view of which credentials have an
 * online preload — is exercised over the same registry.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION, WS_CLOSE_UNAUTHORIZED } from '@debuggen/protocol';
import { isErr, isOk, noopLogger } from '@debuggen/shared';
import type { DebuggenError, Result } from '@debuggen/shared';
import { sha256Hex } from '@debuggen/shared/node';

import { loadServiceConfig } from './config.js';
import { connectionRevokerOf, serverAgentConnectionsOf } from './main.js';
import { createAuthService } from './server/auth.js';
import type { AuthService, Principal } from './server/auth.js';
import { createClientRegistry } from './server/clients.js';
import type { ClientRegistry, ClientSocket } from './server/clients.js';
import { openStore } from './store/db.js';

/** A fixed clock reading, so every timestamp is exact. */
const FIXED_NOW = 1_760_000_000_000;

/** Everything a test opened, closed after it in reverse order. */
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) {
    close();
  }
});

/** The value of an `Ok`, or a test failure naming the error. */
function expectOk<T>(result: Result<T, DebuggenError>): T {
  if (isErr(result)) {
    throw new Error(`expected Ok, received Err(${result.error.code}): ${result.error.message}`);
  }
  return result.value;
}

/** A socket double recording how it was closed. */
interface RecordingSocket extends ClientSocket {
  readonly closes: { readonly code: number | undefined; readonly reason: string | undefined }[];
}

function recordingSocket(): RecordingSocket {
  const closes: { code: number | undefined; reason: string | undefined }[] = [];
  return {
    closes,
    send: () => undefined,
    close: (code?: number, reason?: string) => {
      closes.push({ code, reason });
    },
  };
}

/** A real access boundary whose revoker is the client registry, on a controllable clock. */
function openBoundary(): {
  readonly auth: AuthService;
  readonly clients: ClientRegistry;
  readonly projectRoot: string;
  readonly advance: (ms: number) => number;
} {
  const home = mkdtempSync(join(tmpdir(), 'debuggen-lease-home-'));
  const projectRoot = mkdtempSync(join(tmpdir(), 'debuggen-lease-project-'));
  cleanups.push(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });
  let now = FIXED_NOW;
  const clock = (): number => now;
  const config = expectOk(loadServiceConfig({}, { homeDir: home, debuggenHome: home }));
  const store = expectOk(openStore({ config }));
  // No interval: each test sweeps explicitly, at the clock it set.
  const clients = createClientRegistry({ now: clock, sweepIntervalMs: 0 });
  const auth = expectOk(
    createAuthService({
      store,
      config,
      logger: noopLogger,
      now: clock,
      revoker: connectionRevokerOf(clients),
    }),
  );
  cleanups.push(() => {
    auth.close();
    clients.closeAll();
    store.close();
  });
  return {
    auth,
    clients,
    projectRoot,
    advance: (ms) => {
      now += ms;
      return now;
    },
  };
}

/** Authenticates a server-agent hello with `token` and registers its socket. */
function connect(
  auth: AuthService,
  clients: ClientRegistry,
  token: string,
  projectRoot: string,
): { readonly principal: Principal; readonly socket: RecordingSocket } {
  const principal = expectOk(
    auth.authorizeHello({
      payload: { client: 'server-agent', version: PROTOCOL_VERSION, token, projectRoot },
      origin: undefined,
    }),
  );
  const socket = recordingSocket();
  expectOk(clients.register({ kind: 'server-agent', principal, socket, projectRoot }));
  return { principal, socket };
}

describe('a connected preload across its credential lease', () => {
  it('stays connected past its first lease once renewed, and is closed at once when revoked', () => {
    const { auth, clients, projectRoot, advance } = openBoundary();
    const leased = expectOk(
      auth.issueServerAgentCredential({ projectRoot, expiresAt: FIXED_NOW + 1_000, lease: true }),
    );
    // An independent dev server of the same project, with its own credential.
    const independent = expectOk(auth.issueServerAgentCredential({ projectRoot }));
    const child = connect(auth, clients, leased.token, projectRoot);
    const other = connect(auth, clients, independent.token, projectRoot);

    // The launcher renews the lease; the sweep past the first lease keeps the socket.
    expect(expectOk(auth.renewServerAgentCredential(leased.token, FIXED_NOW + 10_000))).toBe(true);
    clients.sweep(advance(2_000));
    expect(child.socket.closes).toEqual([]);
    expect(child.principal.expiresAt).toBe(FIXED_NOW + 10_000);

    // Revoked: exactly its socket is closed, immediately.
    expect(expectOk(auth.revokeServerAgentCredential(leased.token))).toBe(true);
    expect(child.socket.closes).toHaveLength(1);
    expect(child.socket.closes[0]?.code).toBe(WS_CLOSE_UNAUTHORIZED);
    expect(other.socket.closes).toEqual([]);
    expect(clients.serverAgentsForProject(projectRoot)).toHaveLength(1);

    // The independent credential keeps its connection through later sweeps.
    clients.sweep(advance(60_000));
    expect(other.socket.closes).toEqual([]);
  });

  it('is closed by the sweep once a lease is left to lapse', () => {
    const { auth, clients, projectRoot, advance } = openBoundary();
    const leased = expectOk(
      auth.issueServerAgentCredential({ projectRoot, expiresAt: FIXED_NOW + 1_000, lease: true }),
    );
    const child = connect(auth, clients, leased.token, projectRoot);

    clients.sweep(advance(1_500));

    expect(child.socket.closes.map((close) => close.code)).toEqual([WS_CLOSE_UNAUTHORIZED]);
  });
});

describe('serverAgentConnectionsOf', () => {
  it('answers whether a credential has an online preload, by digest', () => {
    const { auth, clients, projectRoot } = openBoundary();
    const leased = expectOk(
      auth.issueServerAgentCredential({ projectRoot, expiresAt: FIXED_NOW + 9_000, lease: true }),
    );
    const connections = serverAgentConnectionsOf(clients);

    expect(connections.isCredentialConnected(sha256Hex(leased.token))).toBe(false);
    connect(auth, clients, leased.token, projectRoot);
    expect(connections.isCredentialConnected(sha256Hex(leased.token))).toBe(true);
    expect(connections.isCredentialConnected(sha256Hex('another-token'))).toBe(false);
    expect(isOk(auth.revokeServerAgentCredential(leased.token))).toBe(true);
    expect(connections.isCredentialConnected(sha256Hex(leased.token))).toBe(false);
  });
});
