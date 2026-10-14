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
 *
 * A `POST /dev-server/credential` credential belongs to a dev server the
 * developer started (`scripts/dev-instrumented.mjs --spawn-local`), whose exit
 * this service never observes. The launcher supervises it as a lease over
 * that same view: renewed while the preload's control connection is online,
 * revoked once that connection has been gone for the disconnect grace. The
 * last suite drives the real launcher, access boundary and registry through
 * that exit on Vitest's fake clock and timers.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AUTHORIZATION_HEADER,
  PROTOCOL_VERSION,
  WS_CLOSE_UNAUTHORIZED,
  formatBearer,
} from '@debuggen/protocol';
import { isErr, isOk, noopLogger } from '@debuggen/shared';
import type { DebuggenError, Result } from '@debuggen/shared';
import { sha256Hex } from '@debuggen/shared/node';

import { loadServiceConfig } from './config.js';
import {
  CLI_CREDENTIAL_CHECK_INTERVAL_MS,
  CLI_CREDENTIAL_DISCONNECT_GRACE_MS,
  DEFAULT_CLI_CREDENTIAL_LEASE_MS,
  createDevServerLauncher,
  serverAgentCredentialIssuer,
} from './dev-server/launcher.js';
import { connectionRevokerOf, serverAgentConnectionsOf } from './main.js';
import { authFailureReasonOf, createAuthService } from './server/auth.js';
import type {
  AuthService,
  HelloAuthorizationRequest,
  HttpAuthorizationRequest,
  Principal,
} from './server/auth.js';
import { createClientRegistry } from './server/clients.js';
import type { ClientRegistry, ClientSocket } from './server/clients.js';
import { openStore } from './store/db.js';

/** A fixed clock reading, so every timestamp is exact. */
const FIXED_NOW = 1_760_000_000_000;

/** Everything a test opened, closed after it in reverse order. */
const cleanups: (() => void)[] = [];

afterEach(() => {
  vi.useRealTimers();
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

/**
 * A real access boundary whose revoker is the client registry, on a
 * controllable clock: its own, moved by `advance`, or `externalClock` when
 * given (Vitest's fake `Date.now`, which `advance` does not move).
 */
function openBoundary(externalClock?: () => number): {
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
  const clock = externalClock ?? ((): number => now);
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

/** A preload's `client.hello` authorization request with `token`. */
function helloWith(token: string, projectRoot: string): HelloAuthorizationRequest {
  return {
    payload: { client: 'server-agent', version: PROTOCOL_VERSION, token, projectRoot },
    origin: undefined,
  };
}

/** A preload's `POST /telemetry/ingest` authorization request with `Bearer <token>`. */
function ingestWith(token: string): HttpAuthorizationRequest {
  return {
    headers: { [AUTHORIZATION_HEADER]: formatBearer(token) },
    origin: undefined,
    operation: 'telemetry.event',
  };
}

/** Authenticates a server-agent hello with `token` and registers its socket. */
function connect(
  auth: AuthService,
  clients: ClientRegistry,
  token: string,
  projectRoot: string,
): {
  readonly principal: Principal;
  readonly socket: RecordingSocket;
  /** The registry's id of the connection, what a socket close unregisters. */
  readonly clientId: string;
} {
  const principal = expectOk(auth.authorizeHello(helloWith(token, projectRoot)));
  const socket = recordingSocket();
  const registered = expectOk(
    clients.register({ kind: 'server-agent', principal, socket, projectRoot }),
  );
  return { principal, socket, clientId: registered.id };
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

describe('a POST /dev-server/credential lease across its dev server exit', () => {
  it('authenticates past its first lease while the preload is connected, and is refused once the preload has been gone for the grace', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const clock = (): number => Date.now();
    const { auth, clients, projectRoot } = openBoundary(clock);
    const launcher = createDevServerLauncher({
      config: { host: '127.0.0.1', port: 43_117 },
      logger: noopLogger,
      credentials: serverAgentCredentialIssuer(auth),
      serverAgentConnections: serverAgentConnectionsOf(clients),
      now: clock,
    });
    try {
      const minted = expectOk(await launcher.issueCredential({ projectRoot }));
      expect(minted.expiresAt).toBe(FIXED_NOW + DEFAULT_CLI_CREDENTIAL_LEASE_MS);
      // Another credential of the same project: a second dev server's.
      const independent = expectOk(auth.issueServerAgentCredential({ projectRoot }));
      const preload = connect(auth, clients, minted.token, projectRoot);
      const other = connect(auth, clients, independent.token, projectRoot);

      // Past the first lease with the checks running: renewed through the
      // real store, so the expiry sweep keeps the socket and both surfaces
      // still accept the token.
      await vi.advanceTimersByTimeAsync(
        DEFAULT_CLI_CREDENTIAL_LEASE_MS + CLI_CREDENTIAL_CHECK_INTERVAL_MS,
      );
      clients.sweep();
      expect(preload.socket.closes).toEqual([]);
      expect(preload.principal.expiresAt).toBeGreaterThan(Date.now());
      expect(isOk(auth.authorizeHello(helloWith(minted.token, projectRoot)))).toBe(true);
      expect(isOk(auth.authorizeHttpRequest(ingestWith(minted.token)))).toBe(true);

      // The dev server exits (Ctrl-C): its preload's socket closes and the
      // registry forgets it. Within the grace the token still authenticates.
      clients.unregister(preload.clientId);
      await vi.advanceTimersByTimeAsync(
        CLI_CREDENTIAL_DISCONNECT_GRACE_MS - CLI_CREDENTIAL_CHECK_INTERVAL_MS,
      );
      expect(isOk(auth.authorizeHttpRequest(ingestWith(minted.token)))).toBe(true);

      // Past the grace: revoked, so a copy of the token neither opens a
      // control connection nor ingests.
      await vi.advanceTimersByTimeAsync(2 * CLI_CREDENTIAL_CHECK_INTERVAL_MS);
      const hello = auth.authorizeHello(helloWith(minted.token, projectRoot));
      const ingest = auth.authorizeHttpRequest(ingestWith(minted.token));
      if (isOk(hello) || isOk(ingest)) {
        throw new Error('expected the exited dev server credential to be refused');
      }
      expect(authFailureReasonOf(hello.error)).toBe('unknown-credential');
      expect(authFailureReasonOf(ingest.error)).toBe('unknown-credential');

      // The project's other credential and its connection are untouched.
      expect(other.socket.closes).toEqual([]);
      expect(isOk(auth.authorizeHttpRequest(ingestWith(independent.token)))).toBe(true);
      expect(isOk(auth.authorizeHello(helloWith(independent.token, projectRoot)))).toBe(true);
    } finally {
      await launcher.dispose();
    }
  });
});
