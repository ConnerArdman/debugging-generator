/**
 * @file Unit tests: the client registry's connection bound and its frame-drop
 * diagnostics, over a fake socket, a controllable clock and a capturing logger.
 *
 * The connection bound (`DEFAULT_MAX_CLIENTS`) exists so a runaway reconnect
 * loop cannot exhaust memory; it must never refuse ordinary reconnect churn.
 * `ws.ts` retains a closed connection's registration offline for the offline
 * grace period (`DEFAULT_OFFLINE_GRACE_MS`), and such a registration can never
 * carry a frame again, so:
 *
 * - it holds no slot: a registration past the bound releases the
 *   longest-offline closed registrations first, and churn inside the grace
 *   period keeps being accepted;
 * - live connections — online, or offline over a socket that is still open —
 *   still fill the bound, and the next registration is refused `RATE_LIMITED`;
 * - releasing a registration never drops a binding: the binding belongs to the
 *   credential, and the credential's next connection carries it.
 *
 * A socket closing is simulated exactly as `ws.ts` observes it: the transport
 * reports `readyState` CLOSED, and `ws.ts`'s close handler marks the
 * registration offline.
 *
 * A delivery that drops a frame for anyone writes one debug record that says
 * which session the frame belonged to and which connections missed it, of
 * which kind and why — directly for one recipient, as parallel arrays for
 * several — and never a principal or its digest.
 */

import { describe, expect, it } from 'vitest';

import { createEnvelope, parseSessionRecord } from '@debuggen/protocol';
import type { ProtocolMessage, SessionRecord } from '@debuggen/protocol';
import { createConsoleLogger, isErr } from '@debuggen/shared';
import type { DebuggenError, LogRecord, Result } from '@debuggen/shared';

import type { DevtoolsPrincipal, EditorPrincipal, Principal } from './auth.js';
import {
  DEFAULT_MAX_BUFFERED_BYTES,
  SOCKET_READY_STATE_OPEN,
  createClientRegistry,
} from './clients.js';
import type { ClientRegistry, ClientSocket, RegisteredClient } from './clients.js';

/** A fixed clock reading, so every timestamp is exact. */
const FIXED_NOW = 1_760_000_000_000;

/** The WHATWG `WebSocket.CLOSED` ready state, which `ws` shares. */
const SOCKET_READY_STATE_CLOSED = 3;

/** A small bound, so a test can fill it by hand. */
const MAX_CLIENTS = 3;

/** The workspace folder every editor principal announces. */
const PROJECT_ROOT = '/work/lumen';

/** The message of the debug record a released slot is logged under. */
const RELEASED_SLOT_MESSAGE =
  'Released the connection slot of a closed connection retained offline';

/** The message of the warn record a refusal at the bound is logged under. */
const REFUSED_MESSAGE = 'Refused a connection past the connection bound';

/** The value of an `Ok`, or a test failure naming the error. */
function expectOk<T>(result: Result<T, DebuggenError>): T {
  if (isErr(result)) {
    throw new Error(`expected Ok, received Err(${result.error.code}): ${result.error.message}`);
  }
  return result.value;
}

/** The error of an `Err`, or a test failure. */
function expectErr<T>(result: Result<T, DebuggenError>): DebuggenError {
  if (!isErr(result)) {
    throw new Error('expected Err, received Ok');
  }
  return result.error;
}

/** A socket double whose ready state moves the way a `ws` socket's does. */
interface FakeSocket extends ClientSocket {
  readyState: number;
  bufferedAmount: number;
  /** Every frame written, verbatim. */
  readonly sent: string[];
  /** Every close the registry started. */
  readonly closes: { readonly code: number | undefined; readonly reason: string | undefined }[];
  /** When set, `send` throws the way a socket closed between lookup and write does. */
  failSends: boolean;
  /** Runs synchronously after each successful write, inside the registry's delivery loop. */
  onSend: (() => void) | undefined;
}

function fakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    readyState: SOCKET_READY_STATE_OPEN,
    bufferedAmount: 0,
    sent: [],
    closes: [],
    failSends: false,
    onSend: undefined,
    send: (data: string) => {
      if (socket.failSends) {
        throw new Error('WebSocket is not open');
      }
      socket.sent.push(data);
      socket.onSend?.();
    },
    close: (code?: number, reason?: string) => {
      socket.closes.push({ code, reason });
      socket.readyState = SOCKET_READY_STATE_CLOSED;
    },
  };
  return socket;
}

/** A distinct, credential-digest-shaped token hash per call. */
let hashCounter = 0;
function nextTokenHash(): string {
  hashCounter += 1;
  return hashCounter.toString(16).padStart(64, '0');
}

function editorPrincipal(): EditorPrincipal {
  return {
    role: 'vscode',
    scope: { kind: 'machine-user', workspaceFolders: [PROJECT_ROOT] },
    tokenHash: nextTokenHash(),
    issuedAt: FIXED_NOW,
  };
}

function devtoolsPrincipal(): DevtoolsPrincipal {
  return {
    role: 'devtools',
    scope: { kind: 'extension', extensionId: 'abcdefghijklmnopabcdefghijklmnop' },
    tokenHash: nextTokenHash(),
    issuedAt: FIXED_NOW,
  };
}

/** A registry on a controllable clock whose log records are captured at debug. */
function openRegistry(maxClients: number = MAX_CLIENTS): {
  readonly clients: ClientRegistry;
  readonly records: LogRecord[];
  readonly advance: (ms: number) => number;
} {
  let now = FIXED_NOW;
  const records: LogRecord[] = [];
  const logger = createConsoleLogger({
    level: 'debug',
    sink: (record) => {
      records.push(record);
    },
  });
  const clients = createClientRegistry({
    logger,
    now: () => now,
    sweepIntervalMs: 0,
    maxClients,
  });
  return {
    clients,
    records,
    advance: (ms) => {
      now += ms;
      return now;
    },
  };
}

/** A registered connection and its socket. */
interface Connection {
  readonly client: RegisteredClient;
  readonly socket: FakeSocket;
}

function connectEditor(clients: ClientRegistry, principal = editorPrincipal()): Connection {
  const socket = fakeSocket();
  const client = expectOk(clients.register({ kind: 'vscode', principal, socket }));
  return { client, socket };
}

function connectDevtools(clients: ClientRegistry, principal: DevtoolsPrincipal): Connection {
  const socket = fakeSocket();
  const client = expectOk(clients.register({ kind: 'devtools', principal, socket }));
  return { client, socket };
}

/**
 * What `ws.ts` observes when a peer closes cleanly: the transport reports the
 * socket CLOSED and the close handler marks the registration offline, keeping
 * it for the offline grace period.
 */
function peerClosed(clients: ClientRegistry, connection: Connection): void {
  connection.socket.readyState = SOCKET_READY_STATE_CLOSED;
  expect(clients.markOffline(connection.client.id)).toBe(true);
}

/** The records logged under `message`. */
function recordsWith(records: readonly LogRecord[], message: string): LogRecord[] {
  return records.filter((record) => record.message === message);
}

/** A `session.progress` frame for `sessionId`, its envelope routing key lifted from the payload. */
function progressFrame(sessionId: string): ProtocolMessage {
  return createEnvelope('session.progress', {
    sessionId,
    stage: 'capture',
    status: 'running',
    message: 'Capturing telemetry',
  });
}

/** The same `session.progress` frame with no envelope routing key: the session is named by the payload alone. */
function unroutedProgressFrame(sessionId: string): ProtocolMessage {
  const routed = createEnvelope('session.progress', {
    sessionId,
    stage: 'analyze',
    status: 'done',
    message: 'Analysis finished',
  });
  return { id: routed.id, type: routed.type, ts: routed.ts, payload: routed.payload };
}

/** A valid session record, validated by protocol's own schema. */
function sessionRecordFor(sessionId: string): SessionRecord {
  const parsed = parseSessionRecord({
    id: sessionId,
    projectRoot: PROJECT_ROOT,
    projectName: 'lumen',
    devServerUrl: 'http://127.0.0.1:3000/',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    status: 'ready',
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

describe('the connection bound counts only live connections', () => {
  it('releases a closed registration retained offline, the longest-offline first', () => {
    const { clients, records, advance } = openRegistry();
    const first = connectEditor(clients);
    const second = connectEditor(clients);
    const third = connectEditor(clients);

    // Closed in the order second, first, third: second has been offline longest.
    peerClosed(clients, second);
    advance(1_000);
    peerClosed(clients, first);
    advance(1_000);
    peerClosed(clients, third);
    advance(1_000);

    const next = connectEditor(clients);
    expect(clients.get(next.client.id)?.online).toBe(true);
    expect(clients.get(second.client.id)).toBeUndefined();
    expect(clients.get(first.client.id)).toBeDefined();
    expect(clients.get(third.client.id)).toBeDefined();
    expect(clients.stats().clients).toBe(MAX_CLIENTS);

    // Only as many slots as the new connection needed were released, and each
    // release is logged at debug with the connection's identity and no digest.
    const released = recordsWith(records, RELEASED_SLOT_MESSAGE);
    expect(released).toHaveLength(1);
    expect(released[0]?.level).toBe('debug');
    expect(released[0]?.fields).toMatchObject({
      clientId: second.client.id,
      client: 'vscode',
      role: 'vscode',
      offlineForMs: 3_000,
    });
    expect(JSON.stringify(released[0]?.fields)).not.toContain(second.client.principal.tokenHash);
    expect(recordsWith(records, REFUSED_MESSAGE)).toHaveLength(0);

    // `ws.ts`'s offline-grace timer later unregisters the released id: a no-op.
    expect(clients.unregister(second.client.id)).toBeUndefined();
    expect(clients.stats().clients).toBe(MAX_CLIENTS);
  });

  it('keeps accepting open-and-close churn inside the offline grace period', () => {
    const { clients, records, advance } = openRegistry();
    for (let round = 0; round < 5; round += 1) {
      const wave = Array.from({ length: MAX_CLIENTS }, () => connectEditor(clients));
      expect(clients.stats().online).toBe(MAX_CLIENTS);
      for (const connection of wave) {
        advance(10);
        peerClosed(clients, connection);
      }
      // Every registration of the wave is retained offline, holding no slot.
      expect(clients.stats().clients).toBe(MAX_CLIENTS);
      expect(clients.stats().online).toBe(0);
    }
    // Four later waves each released the previous wave's three registrations.
    expect(recordsWith(records, RELEASED_SLOT_MESSAGE)).toHaveLength(4 * MAX_CLIENTS);
    expect(recordsWith(records, REFUSED_MESSAGE)).toHaveLength(0);
  });

  it('still refuses RATE_LIMITED when online connections fill the bound', () => {
    const { clients, records } = openRegistry();
    const live = Array.from({ length: MAX_CLIENTS }, () => connectEditor(clients));

    const refused = expectErr(
      clients.register({ kind: 'vscode', principal: editorPrincipal(), socket: fakeSocket() }),
    );
    expect(refused.code).toBe('RATE_LIMITED');
    for (const connection of live) {
      expect(clients.get(connection.client.id)?.online).toBe(true);
    }
    expect(clients.stats().clients).toBe(MAX_CLIENTS);
    const warned = recordsWith(records, REFUSED_MESSAGE);
    expect(warned).toHaveLength(1);
    expect(warned[0]?.level).toBe('warn');
    expect(recordsWith(records, RELEASED_SLOT_MESSAGE)).toHaveLength(0);
  });

  it('does not release an offline registration whose socket is still open', () => {
    const { clients, records } = openRegistry();
    const suspended = connectEditor(clients);
    connectEditor(clients);
    connectEditor(clients);
    // Marked offline while the transport still reports the socket open.
    expect(clients.markOffline(suspended.client.id)).toBe(true);
    expect(suspended.socket.readyState).toBe(SOCKET_READY_STATE_OPEN);

    const refused = expectErr(
      clients.register({ kind: 'vscode', principal: editorPrincipal(), socket: fakeSocket() }),
    );
    expect(refused.code).toBe('RATE_LIMITED');
    expect(clients.get(suspended.client.id)?.online).toBe(false);
    expect(recordsWith(records, RELEASED_SLOT_MESSAGE)).toHaveLength(0);

    // A frame on the open socket brings it back online, in its kept slot.
    expect(clients.touch(suspended.client.id)).toBe(true);
    expect(clients.get(suspended.client.id)?.online).toBe(true);
  });

  it('releases only the closed registration when an open offline one sits beside it', () => {
    const { clients } = openRegistry();
    const suspended = connectEditor(clients);
    const closed = connectEditor(clients);
    connectEditor(clients);
    expect(clients.markOffline(suspended.client.id)).toBe(true);
    peerClosed(clients, closed);

    const next = connectEditor(clients);
    expect(clients.get(next.client.id)?.online).toBe(true);
    expect(clients.get(closed.client.id)).toBeUndefined();
    expect(clients.get(suspended.client.id)?.online).toBe(false);

    // With the closed registration gone, the bound is full of live connections.
    const refused = expectErr(
      clients.register({ kind: 'vscode', principal: editorPrincipal(), socket: fakeSocket() }),
    );
    expect(refused.code).toBe('RATE_LIMITED');
  });
});

describe('releasing a slot keeps the credential’s tab binding', () => {
  const TAB_ID = 7;
  const SESSION_ID = 'ses_0123456789abcdef';
  const BOUND_URL = 'http://127.0.0.1:3000/products';

  /** A full registry whose bound tab's DevTools connection has just closed. */
  function boundThenClosed(): {
    readonly clients: ClientRegistry;
    readonly principal: DevtoolsPrincipal;
    readonly closedDevtools: Connection;
  } {
    const { clients } = openRegistry();
    const principal = devtoolsPrincipal();
    const closedDevtools = connectDevtools(clients, principal);
    expectOk(
      clients.bindTab({
        tabId: TAB_ID,
        sessionId: SESSION_ID,
        url: BOUND_URL,
        principal,
        clientId: closedDevtools.client.id,
      }),
    );
    connectEditor(clients);
    connectEditor(clients);
    peerClosed(clients, closedDevtools);
    return { clients, principal, closedDevtools };
  }

  it('routes the binding to the credential’s next connection once its old slot is released', () => {
    const { clients, principal, closedDevtools } = boundThenClosed();

    // The service worker reconnects with the same credential: the bound is
    // reached, and the closed DevTools registration is the one released.
    const reconnected = connectDevtools(clients, principal);
    expect(clients.get(closedDevtools.client.id)).toBeUndefined();

    const binding = clients.bindingForTab(TAB_ID);
    expect(binding).toMatchObject({
      tabId: TAB_ID,
      sessionId: SESSION_ID,
      url: BOUND_URL,
      boundBy: principal.tokenHash,
      recipientId: reconnected.client.id,
      online: true,
    });
    expect(clients.bindingForSession(SESSION_ID)?.tabId).toBe(TAB_ID);

    // The session's tab traffic reaches the new socket without a re-bind.
    const receipt = expectOk(clients.sendToBoundTab(SESSION_ID, progressFrame(SESSION_ID)));
    expect(receipt.recipients).toEqual([reconnected.client.id]);
    expect(reconnected.socket.sent).toHaveLength(1);
    expect(closedDevtools.socket.sent).toHaveLength(0);
  });

  it('keeps the binding when another client takes the released slot', () => {
    const { clients, principal, closedDevtools } = boundThenClosed();

    connectEditor(clients);
    expect(clients.get(closedDevtools.client.id)).toBeUndefined();

    const binding = clients.bindingForTab(TAB_ID);
    expect(binding).toMatchObject({
      tabId: TAB_ID,
      sessionId: SESSION_ID,
      boundBy: principal.tokenHash,
      online: false,
    });
    expect(binding?.recipientId).toBeUndefined();
    expect(clients.stats().bindings).toBe(1);
  });
});

describe('the frame-drop record names who missed the frame and why', () => {
  const SESSION_ID = 'ses_fedcba9876543210';
  const DROP_MESSAGE = 'Frames dropped for clients that could not take them';

  function dropRecords(records: readonly LogRecord[]): LogRecord[] {
    return recordsWith(records, DROP_MESSAGE);
  }

  /** The module's privacy rule: a record never carries a principal or a credential digest. */
  function expectNoCredential(
    record: LogRecord | undefined,
    principals: readonly Principal[],
  ): void {
    expect(record?.fields).not.toHaveProperty('principal');
    const text = JSON.stringify(record?.fields);
    for (const principal of principals) {
      expect(text).not.toContain(principal.tokenHash);
    }
  }

  it('names one dropped recipient directly, with its kind, its reason and the session', () => {
    const { clients, records } = openRegistry(8);
    const reached = connectEditor(clients);
    const away = connectEditor(clients);
    expectOk(clients.attachSession(reached.client.id, SESSION_ID));
    expectOk(clients.attachSession(away.client.id, SESSION_ID));
    expect(clients.markOffline(away.client.id)).toBe(true);

    expect(clients.broadcast(SESSION_ID, progressFrame(SESSION_ID))).toBe(1);

    const dropped = dropRecords(records);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.level).toBe('debug');
    expect(dropped[0]?.fields).toMatchObject({
      subsystem: 'clients',
      type: 'session.progress',
      sessionId: SESSION_ID,
      dropped: 1,
      delivered: 1,
      clientId: away.client.id,
      client: 'vscode',
      reason: 'offline',
    });
    expect(dropped[0]?.fields).not.toHaveProperty('clientIds');
    expect(dropped[0]?.fields).not.toHaveProperty('clients');
    expect(dropped[0]?.fields).not.toHaveProperty('reasons');
    expectNoCredential(dropped[0], [reached.client.principal, away.client.principal]);
  });

  it('names several dropped recipients as parallel arrays in delivery order, in one record', () => {
    const { clients, records } = openRegistry(8);
    const closedEditor = connectEditor(clients);
    const reached = connectEditor(clients);
    const principal = devtoolsPrincipal();
    const failing = connectDevtools(clients, principal);
    expectOk(clients.attachSession(closedEditor.client.id, SESSION_ID));
    expectOk(clients.attachSession(reached.client.id, SESSION_ID));
    expectOk(
      clients.bindTab({
        tabId: 11,
        sessionId: SESSION_ID,
        url: 'http://127.0.0.1:3000/cart',
        principal,
        clientId: failing.client.id,
      }),
    );
    // The editor's socket closed before its close event marked it offline, and
    // the DevTools socket's write throws.
    closedEditor.socket.readyState = SOCKET_READY_STATE_CLOSED;
    failing.socket.failSends = true;

    expect(clients.broadcast(SESSION_ID, progressFrame(SESSION_ID))).toBe(1);

    const dropped = dropRecords(records);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.level).toBe('debug');
    expect(dropped[0]?.fields).toMatchObject({
      type: 'session.progress',
      sessionId: SESSION_ID,
      dropped: 2,
      delivered: 1,
      clientIds: [closedEditor.client.id, failing.client.id],
      clients: ['vscode', 'devtools'],
      reasons: ['closed', 'send-failed'],
    });
    expect(dropped[0]?.fields).not.toHaveProperty('clientId');
    expect(dropped[0]?.fields).not.toHaveProperty('client');
    expect(dropped[0]?.fields).not.toHaveProperty('reason');
    expectNoCredential(dropped[0], [
      closedEditor.client.principal,
      reached.client.principal,
      principal,
    ]);
    expect(clients.get(closedEditor.client.id)?.online).toBe(false);
    expect(clients.get(failing.client.id)?.online).toBe(false);
  });

  it('names every reason a recipient can miss a frame for', () => {
    const { clients, records, advance } = openRegistry(8);
    const expiring = connectEditor(clients, { ...editorPrincipal(), expiresAt: FIXED_NOW + 10 });
    const backlogged = connectEditor(clients);
    const reached = connectEditor(clients);
    const removed = connectEditor(clients);
    const away = connectEditor(clients);
    for (const connection of [expiring, backlogged, reached, removed, away]) {
      expectOk(clients.attachSession(connection.client.id, SESSION_ID));
    }
    backlogged.socket.bufferedAmount = DEFAULT_MAX_BUFFERED_BYTES + 1;
    // A write whose side effect removes a later recipient mid-delivery.
    reached.socket.onSend = () => {
      clients.unregister(removed.client.id);
    };
    expect(clients.markOffline(away.client.id)).toBe(true);
    advance(20);

    expect(clients.broadcast(SESSION_ID, progressFrame(SESSION_ID))).toBe(1);

    const dropped = dropRecords(records);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.fields).toMatchObject({
      sessionId: SESSION_ID,
      dropped: 4,
      delivered: 1,
      clientIds: [expiring.client.id, backlogged.client.id, removed.client.id, away.client.id],
      clients: ['vscode', 'vscode', 'vscode', 'vscode'],
      reasons: ['expired', 'backpressure', 'unregistered', 'offline'],
    });
    expect(expiring.socket.closes).toHaveLength(1);
    expect(backlogged.socket.closes).toHaveLength(1);
  });

  it('takes the session from the payload when the envelope carries no routing key', () => {
    const { clients, records } = openRegistry(8);
    const away = connectEditor(clients);
    expect(clients.markOffline(away.client.id)).toBe(true);
    const frame = unroutedProgressFrame(SESSION_ID);
    expect(frame.sessionId).toBeUndefined();

    expect(expectErr(clients.sendToClient(away.client.id, frame)).code).toBe(
      'TRANSPORT_DISCONNECTED',
    );

    const dropped = dropRecords(records);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.fields).toMatchObject({
      type: 'session.progress',
      sessionId: SESSION_ID,
      dropped: 1,
      delivered: 0,
      clientId: away.client.id,
      client: 'vscode',
      reason: 'offline',
    });
  });

  it('takes the session from an embedded session record', () => {
    const { clients, records } = openRegistry(8);
    const away = connectEditor(clients);
    expect(clients.markOffline(away.client.id)).toBe(true);
    const frame = createEnvelope('session.updated', { session: sessionRecordFor(SESSION_ID) });
    expect(frame.sessionId).toBeUndefined();

    expectErr(clients.sendToClient(away.client.id, frame));

    expect(dropRecords(records)[0]?.fields).toMatchObject({
      type: 'session.updated',
      sessionId: SESSION_ID,
      clientId: away.client.id,
      reason: 'offline',
    });
  });

  it('carries no session for a session-less frame', () => {
    const { clients, records } = openRegistry(8);
    const away = connectEditor(clients);
    expect(clients.markOffline(away.client.id)).toBe(true);

    expectErr(
      clients.sendToClient(
        away.client.id,
        createEnvelope('service.pong', { ref: 'msg_0123456789abcdef' }),
      ),
    );

    const dropped = dropRecords(records);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.fields).toMatchObject({
      type: 'service.pong',
      clientId: away.client.id,
      client: 'vscode',
      reason: 'offline',
    });
    expect(dropped[0]?.fields).not.toHaveProperty('sessionId');
  });

  it('writes no drop record when every recipient took the frame', () => {
    const { clients, records } = openRegistry(8);
    const first = connectEditor(clients);
    const second = connectEditor(clients);
    expectOk(clients.attachSession(first.client.id, SESSION_ID));
    expectOk(clients.attachSession(second.client.id, SESSION_ID));

    expect(clients.broadcast(SESSION_ID, progressFrame(SESSION_ID))).toBe(2);
    expect(dropRecords(records)).toHaveLength(0);
  });
});
