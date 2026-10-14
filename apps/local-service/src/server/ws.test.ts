/**
 * Colocated tests for `./ws.ts`: the **flow control** of an authenticated
 * connection — read backpressure, and the backlog close kept behind it as the
 * last resort.
 *
 * The frame queue of a connection is only observable from outside through
 * what the server reads and answers, so every case drives a real
 * `createWsServer` on a loopback listener from a **raw** RFC 6455 peer built
 * on `node:net`: a peer that controls exactly which frames share one TCP
 * write (and so arrive in one read), answers the server's heartbeat pings only
 * when told to, and echoes a close frame the way a browser does. A library
 * client would hide all three.
 *
 * What the cases prove:
 *
 * 1. **The high-water marks pause reading.** Once the frames queued or running
 *    on a connection reach the frame mark or the byte mark, frames written
 *    afterwards stay in TCP — the server counts none of them — until the
 *    queue drains to both low-water marks; then they are read, in order.
 * 2. **Order and ping semantics are untouched.** A `client.ping` written
 *    behind a paused queue is answered after every frame before it, with its
 *    own id as the pong's `ref`.
 * 3. **The heartbeat judges only what it can hear.** A paused connection's
 *    unread pong does not get it terminated; once reading resumes, a peer
 *    that stops answering is terminated as before.
 * 4. **The backlog close is the last resort.** Frames `ws` had already read
 *    when reading paused still count against `maxPendingFrames`, past which
 *    the connection is closed with 1013 — and a closing connection is read
 *    again, so the closing handshake completes rather than timing out.
 * 5. **The marks are validated** against each other and against the cap, and
 *    the defaults keep a ping read behind a full queue inside the pong
 *    timeout at the measured ingest cost.
 *
 * The telemetry route is a double whose every call is held until the case
 * releases it, which is what makes a queue build deterministically; the
 * access boundary is a double that authenticates any hello as a DevTools
 * principal, since credentials are `./auth.ts`'s concern and are covered by
 * `apps/local-service/test/integration/ws-protocol.test.ts`.
 */

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import type { Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MESSAGE_TYPE,
  PROTOCOL_VERSION,
  SERVICE_PONG_TIMEOUT_MS,
  WS_PATH,
  createEnvelope,
  encodeMessage,
} from '@debuggen/protocol';
import { DebuggenError, err, isErr, ok } from '@debuggen/shared';
import type { LogFields, LogLevel, Logger, Result } from '@debuggen/shared';

import { DROP_REASONS } from '../telemetry/attribute.js';
import type { DropReason } from '../telemetry/attribute.js';
import type { IngestReport } from '../telemetry/ingest.js';

import type { DevtoolsPrincipal } from './auth.js';
import { WS_CLOSE_TRY_AGAIN_LATER, createClientRegistry } from './clients.js';
import type { ClientRegistry } from './clients.js';
import type { TelemetryEventFrame } from './routes/telemetry.js';
import {
  CLOSE_HANDSHAKE_GRACE_MS,
  DEFAULT_MAX_PENDING_FRAMES,
  DEFAULT_READ_PAUSE_BYTES,
  DEFAULT_READ_PAUSE_FRAMES,
  DEFAULT_READ_RESUME_BYTES,
  DEFAULT_READ_RESUME_FRAMES,
  createWsServer,
} from './ws.js';
import type { WsServer, WsServerDeps, WsServerStats } from './ws.js';

/* -------------------------------------------------------------------------------------------------
 * Fixture constants
 * ---------------------------------------------------------------------------------------------- */

/** The loopback host every rig listens on. */
const HOST = '127.0.0.1';

/** The tab the peer's hello claims. */
const TAB_ID = 7;

/** How long a wait for the server's counters may take before the case fails. */
const WAIT_TIMEOUT_MS = 5_000;

/** How often a wait re-reads the counters. */
const POLL_INTERVAL_MS = 5;

/**
 * How long a case lets a paused connection sit to show that nothing more is
 * read: long enough for loopback TCP to have delivered a written frame many
 * times over.
 */
const SETTLE_MS = 150;

/** The WebSocket opcodes the raw peer speaks (RFC 6455 §5.2). */
const OPCODE = Object.freeze({ text: 0x1, close: 0x8, ping: 0x9, pong: 0xa });

/** The reason text of the backlog close, as `./ws.ts` sends it. */
const BACKLOG_REASON = 'Too many unprocessed frames on this connection';

/** The DevTools principal the access-boundary double authenticates every hello as. */
const PRINCIPAL: DevtoolsPrincipal = Object.freeze({
  role: 'devtools',
  scope: Object.freeze({ kind: 'extension', extensionId: 'abcdefghijklmnopabcdefghijklmnop' }),
  tokenHash: '0'.repeat(64),
  issuedAt: 1_700_000_000_000,
});

/** The hello's credential, assembled so no credential-shaped literal is in the file. */
const HELLO_TOKEN = ['unit', 'test', 'hello'].join('-');

/* -------------------------------------------------------------------------------------------------
 * The raw RFC 6455 peer
 * ---------------------------------------------------------------------------------------------- */

/** One frame the server sent. Server frames are never masked, fragmented or compressed here. */
interface ServerFrame {
  readonly opcode: number;
  readonly payload: Buffer;
}

/** A masked client frame (RFC 6455 §5.3) carrying `payload` under `opcode`. */
function clientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length < 0x1_00_00) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  return Buffer.concat([header, mask, masked]);
}

/** Splits complete server frames off the front of `buffer`. */
function takeServerFrames(buffer: Buffer): { frames: ServerFrame[]; rest: Buffer } {
  const frames: ServerFrame[] = [];
  let rest = buffer;
  while (rest.length >= 2) {
    const opcode = (rest[0] ?? 0) & 0x0f;
    let length = (rest[1] ?? 0) & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (rest.length < 4) {
        break;
      }
      length = rest.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (rest.length < 10) {
        break;
      }
      length = Number(rest.readBigUInt64BE(2));
      offset = 10;
    }
    if (rest.length < offset + length) {
      break;
    }
    frames.push({ opcode, payload: Buffer.from(rest.subarray(offset, offset + length)) });
    rest = rest.subarray(offset + length);
  }
  return { frames, rest };
}

/** A connected, upgraded peer. */
interface RawPeer {
  /** Writes every text frame in **one** TCP write, so the server reads them together. */
  sendText(...texts: string[]): void;
  /** Every frame the server has sent so far, in order. */
  readonly received: ServerFrame[];
  /** Whether a server heartbeat ping is answered with a pong; on by default. */
  answerPings: boolean;
  /** Settles when the TCP connection has closed. */
  readonly ended: Promise<void>;
  /** Whether the TCP connection has closed. */
  readonly isEnded: () => boolean;
  /** Destroys the TCP connection. */
  destroy(): void;
}

/** Opens a TCP connection, performs the upgrade, and returns the peer once it is a WebSocket. */
async function openPeer(port: number): Promise<RawPeer> {
  const socket: Socket = connect({ host: HOST, port });
  socket.setNoDelay(true);
  let upgraded = false;
  let pending: Buffer = Buffer.alloc(0);
  let endedFlag = false;
  const received: ServerFrame[] = [];
  const ended = new Promise<void>((resolve) => {
    socket.once('close', () => {
      endedFlag = true;
      resolve();
    });
  });

  const peer: RawPeer = {
    sendText(...texts) {
      socket.write(Buffer.concat(texts.map((text) => clientFrame(OPCODE.text, Buffer.from(text)))));
    },
    received,
    answerPings: true,
    ended,
    isEnded: () => endedFlag,
    destroy() {
      socket.destroy();
    },
  };

  const opened = new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (!upgraded) {
        const end = pending.indexOf('\r\n\r\n');
        if (end < 0) {
          return;
        }
        const head = pending.subarray(0, end).toString('latin1');
        if (!head.startsWith('HTTP/1.1 101')) {
          reject(new Error(`The upgrade was refused: ${head.split('\r\n')[0] ?? ''}`));
          return;
        }
        upgraded = true;
        pending = pending.subarray(end + 4);
        resolve();
      }
      const { frames, rest } = takeServerFrames(pending);
      pending = rest;
      for (const frame of frames) {
        received.push(frame);
        if (frame.opcode === OPCODE.ping && peer.answerPings && !socket.destroyed) {
          socket.write(clientFrame(OPCODE.pong, frame.payload));
        } else if (frame.opcode === OPCODE.close && !socket.destroyed) {
          // A browser echoes the close code and then waits for the server to end TCP.
          socket.write(clientFrame(OPCODE.close, frame.payload.subarray(0, 2)));
        }
      }
    });
  });

  socket.write(
    [
      `GET ${WS_PATH} HTTP/1.1`,
      `Host: ${HOST}:${String(port)}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'),
  );
  await opened;
  return peer;
}

/* -------------------------------------------------------------------------------------------------
 * Frames
 * ---------------------------------------------------------------------------------------------- */

/** The encoded hello every peer opens with. */
function helloText(): string {
  return encodeMessage(
    createEnvelope(MESSAGE_TYPE.CLIENT_HELLO, {
      client: 'devtools',
      tabId: TAB_ID,
      version: PROTOCOL_VERSION,
      token: HELLO_TOKEN,
    }),
  );
}

/** One encoded `telemetry.event` frame and its id: a loss-only batch, the smallest valid one. */
function telemetryText(): { readonly id: string; readonly text: string } {
  const message = createEnvelope(MESSAGE_TYPE.TELEMETRY_EVENT, { events: [], droppedCount: 1 });
  return { id: message.id, text: encodeMessage(message) };
}

/** `count` encoded `telemetry.event` frames. */
function telemetryTexts(count: number): { readonly id: string; readonly text: string }[] {
  return Array.from({ length: count }, () => telemetryText());
}

/** The texts of `frames`. */
function textsOf(frames: readonly { readonly text: string }[]): string[] {
  return frames.map((frame) => frame.text);
}

/** The ids of `frames`. */
function idsOf(frames: readonly { readonly id: string }[]): string[] {
  return frames.map((frame) => frame.id);
}

/** The JSON bodies of the text frames the server sent. */
function textBodies(peer: RawPeer): Record<string, unknown>[] {
  return peer.received
    .filter((frame) => frame.opcode === OPCODE.text)
    .map((frame) => JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>);
}

/* -------------------------------------------------------------------------------------------------
 * Doubles
 * ---------------------------------------------------------------------------------------------- */

/** An ingest report of a loss-only batch; `./ws.ts` sends nothing back for an `ok` one. */
function lossOnlyReport(): IngestReport {
  const dropped = Object.fromEntries(DROP_REASONS.map((reason) => [reason, 0])) as Record<
    DropReason,
    number
  >;
  return {
    received: 0,
    parsed: 0,
    invalid: 0,
    dropped,
    persisted: 0,
    inserted: 0,
    skipped: 0,
    requestKeysComputed: 0,
    sourcesLocated: 0,
    sourcesUnplacedByBudget: 0,
    sourcesRefused: 0,
    serviceKeysStripped: 0,
    clockOffsetsReported: 0,
    failures: { requestKey: 0, redaction: 0, attribution: 0, location: 0, correlation: 0, tail: 0 },
    tracesTouched: [],
  };
}

/** A port the flow-control cases never reach. */
function unrouted(): Promise<Result<never, DebuggenError>> {
  return Promise.resolve(err(new DebuggenError('INTERNAL', 'Not routed in this suite.')));
}

/** One record the logger received. */
interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/** A `Logger` that records every message and fields object, children included. */
function recordingLogger(): { readonly logger: Logger; readonly entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  function make(bindings: LogFields): Logger {
    const writer =
      (level: LogLevel) =>
      (message: string, fields?: LogFields): void => {
        entries.push({ level, message, fields: { ...bindings, ...fields } });
      };
    return {
      level: 'trace',
      trace: writer('trace'),
      debug: writer('debug'),
      info: writer('info'),
      warn: writer('warn'),
      error: writer('error'),
      fatal: writer('fatal'),
      child: (extra) => make({ ...bindings, ...extra }),
    };
  }
  return { logger: make({}), entries };
}

/* -------------------------------------------------------------------------------------------------
 * The rig
 * ---------------------------------------------------------------------------------------------- */

/** The tuning a case builds its server with. */
type RigOptions = Pick<
  WsServerDeps,
  | 'maxPendingFrames'
  | 'readPauseBytes'
  | 'readResumeBytes'
  | 'readPauseFrames'
  | 'readResumeFrames'
  | 'heartbeatIntervalMs'
>;

/** A WebSocket server over held telemetry handlers, on a loopback listener of its own. */
interface Rig {
  readonly ws: WsServer;
  /** The ids of the `telemetry.event` frames the route has been handed, in order. */
  readonly handled: string[];
  readonly logs: LogEntry[];
  /**
   * Lets the next `count` handler calls answer: the one held now, if any, and
   * the calls after it as they come — frames run one at a time, so a queue of
   * `count` drains by `count` only this way.
   */
  release(count: number): void;
  /** Answers the held call and every later one at once, for the rest of the case. */
  releaseAll(): void;
  /** Opens a peer and authenticates it. */
  authenticatedPeer(): Promise<RawPeer>;
  /** Waits until the server's counters satisfy `predicate`. */
  until(predicate: (stats: WsServerStats) => boolean, description: string): Promise<WsServerStats>;
  /** Releases every held call, closes the server and the listener, and ends every peer. */
  close(): Promise<void>;
}

/** Resolves after `ms` of real time. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const openRigs = new Set<Rig>();

afterEach(async () => {
  const rigs = [...openRigs];
  openRigs.clear();
  await Promise.all(rigs.map((rig) => rig.close()));
});

async function startRig(options: RigOptions = {}): Promise<Rig> {
  const { logger, entries } = recordingLogger();
  const clients: ClientRegistry = createClientRegistry({ logger });
  const handled: string[] = [];
  const held: (() => void)[] = [];
  let credits = 0;

  const telemetry: WsServerDeps['telemetry'] = {
    handleTelemetryEventFrame: (frame: TelemetryEventFrame) =>
      new Promise((resolve) => {
        handled.push(frame.message.id);
        const answer = (): void => {
          resolve(ok(lossOnlyReport()));
        };
        if (credits > 0) {
          credits -= 1;
          answer();
        } else {
          held.push(answer);
        }
      }),
  };
  const created = createWsServer({
    auth: {
      authorizeHello: () => ok(PRINCIPAL),
      announceWorkspace: () => err(new DebuggenError('INTERNAL', 'Not an editor in this suite.')),
    },
    clients,
    binding: {
      handleSessionBind: unrouted,
      handleTabNavigated: unrouted,
      handleSessionUnbind: unrouted,
    },
    telemetry,
    readiness: { agentReady: unrouted },
    targets: { selected: unrouted },
    sourceOpen: { handle: unrouted, acceptEditorResult: unrouted, close: () => undefined },
    logger,
    heartbeatIntervalMs: 0,
    offlineGraceMs: 0,
    ...options,
  });
  if (isErr(created)) {
    throw created.error;
  }
  const ws = created.value;
  const listener: Server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  const attached = ws.attach(listener);
  if (isErr(attached)) {
    throw attached.error;
  }
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, HOST, () => {
      resolve();
    });
  });
  const address = listener.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The rig listener has no TCP port.');
  }
  const peers: RawPeer[] = [];

  const until = async (
    predicate: (stats: WsServerStats) => boolean,
    description: string,
  ): Promise<WsServerStats> => {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    for (;;) {
      const stats = ws.stats();
      if (predicate(stats)) {
        return stats;
      }
      if (Date.now() > deadline) {
        throw new Error(`${description}; last counters ${JSON.stringify(stats)}`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  };

  const release = (count: number): void => {
    credits += count;
    while (credits > 0 && held.length > 0) {
      credits -= 1;
      held.shift()?.();
    }
  };

  const rig: Rig = {
    ws,
    handled,
    logs: entries,
    release,
    releaseAll: () => {
      release(Number.POSITIVE_INFINITY);
    },
    async authenticatedPeer() {
      const before = ws.stats().authenticated;
      const peer = await openPeer(address.port);
      peers.push(peer);
      peer.sendText(helloText());
      await until((stats) => stats.authenticated === before + 1, 'the hello authenticated');
      return peer;
    },
    until,
    async close() {
      openRigs.delete(rig);
      release(Number.POSITIVE_INFINITY);
      await ws.close();
      clients.closeAll();
      for (const peer of peers) {
        peer.destroy();
      }
      listener.closeAllConnections();
      await new Promise<void>((resolve) => {
        listener.close(() => {
          resolve();
        });
      });
      expect(ws.stats()).toMatchObject({
        open: 0,
        pendingFrames: 0,
        pendingBytes: 0,
        readPaused: 0,
      });
    },
  };
  openRigs.add(rig);
  return rig;
}

/* -------------------------------------------------------------------------------------------------
 * Read backpressure
 * ---------------------------------------------------------------------------------------------- */

describe('read backpressure', () => {
  it('stops reading at the frame high-water mark and reads again at the low-water mark', async () => {
    const rig = await startRig({ readPauseFrames: 4, readResumeFrames: 1 });
    const peer = await rig.authenticatedPeer();
    const first = telemetryTexts(4);
    const second = telemetryTexts(6);

    peer.sendText(...textsOf(first));
    const paused = await rig.until(
      (stats) => stats.readPaused === 1,
      'the connection paused at four frames',
    );
    expect(paused).toMatchObject({ pendingFrames: 4, readPauses: 1 });
    expect(rig.handled, 'the frames run one at a time, in order').toEqual(idsOf(first).slice(0, 1));

    peer.sendText(...textsOf(second));
    await sleep(SETTLE_MS);
    expect(rig.ws.stats(), 'frames written while paused stay in TCP').toMatchObject({
      pendingFrames: 4,
      readPaused: 1,
    });

    rig.release(2);
    await sleep(SETTLE_MS);
    expect(rig.ws.stats(), 'two frames queued is above the low-water mark').toMatchObject({
      pendingFrames: 2,
      readPaused: 1,
      readPauses: 1,
    });

    rig.release(1);
    await rig.until(
      (stats) => stats.readPauses === 2 && stats.pendingFrames === 7,
      'the connection resumed at one frame, read the six held in TCP and paused again',
    );

    rig.releaseAll();
    await rig.until(
      (stats) => stats.pendingFrames === 0 && rig.handled.length === 10,
      'every frame was handled',
    );
    expect(rig.handled, 'nothing was dropped or reordered').toEqual([
      ...idsOf(first),
      ...idsOf(second),
    ]);
    expect(rig.ws.stats()).toMatchObject({ pendingFrames: 0, pendingBytes: 0, readPaused: 0 });
    expect(peer.isEnded()).toBe(false);
    expect(textBodies(peer), 'no frame was refused').toEqual([]);
  });

  it('stops reading at the byte high-water mark, whatever the frame count', async () => {
    const frames = telemetryTexts(3);
    const frameBytes = Buffer.byteLength(frames[0]?.text ?? '');
    const rig = await startRig({ readPauseBytes: 2 * frameBytes, readResumeBytes: 0 });
    const peer = await rig.authenticatedPeer();

    peer.sendText(...textsOf(frames.slice(0, 2)));
    expect(
      await rig.until((stats) => stats.readPaused === 1, 'the connection paused at two frames'),
    ).toMatchObject({ pendingFrames: 2, pendingBytes: 2 * frameBytes });

    peer.sendText(...textsOf(frames.slice(2)));
    await sleep(SETTLE_MS);
    expect(rig.ws.stats()).toMatchObject({ pendingFrames: 2, readPaused: 1 });

    rig.release(1);
    await sleep(SETTLE_MS);
    expect(rig.ws.stats(), 'one frame is still above a zero-byte low-water mark').toMatchObject({
      pendingFrames: 1,
      pendingBytes: frameBytes,
      readPaused: 1,
    });

    rig.release(1);
    await rig.until(
      (stats) => stats.readPaused === 0 && rig.handled.length === 3,
      'the drained connection was read again',
    );
    rig.releaseAll();
    await rig.until((stats) => stats.pendingFrames === 0, 'the last frame was handled');
    expect(rig.handled).toEqual(idsOf(frames));
    expect(rig.ws.stats()).toMatchObject({ pendingBytes: 0, readPauses: 1 });
  });

  it('answers a client.ping written behind a paused queue after every frame before it', async () => {
    const rig = await startRig({ readPauseFrames: 2, readResumeFrames: 0 });
    const peer = await rig.authenticatedPeer();
    const ahead = telemetryTexts(2);
    const ping = createEnvelope(MESSAGE_TYPE.CLIENT_PING, {});

    peer.sendText(...textsOf(ahead));
    await rig.until((stats) => stats.readPaused === 1, 'the connection paused');
    peer.sendText(encodeMessage(ping));
    await sleep(SETTLE_MS);
    expect(textBodies(peer), 'the ping is not read while the queue is full').toEqual([]);

    rig.release(1);
    await sleep(SETTLE_MS);
    expect(textBodies(peer)).toEqual([]);
    rig.release(1);
    for (let round = 0; textBodies(peer).length === 0; round += 1) {
      expect(round, 'the pong arrives').toBeLessThan(WAIT_TIMEOUT_MS / POLL_INTERVAL_MS);
      await sleep(POLL_INTERVAL_MS);
    }
    const handledAtPong = rig.handled.length;

    expect(textBodies(peer)).toEqual([
      expect.objectContaining({ type: MESSAGE_TYPE.SERVICE_PONG, payload: { ref: ping.id } }),
    ]);
    expect(handledAtPong, 'both frames ahead were handled first').toBe(2);
    expect(rig.handled).toEqual(idsOf(ahead));
  });

  it('does not judge the heartbeat of a paused connection, and judges it again once resumed', async () => {
    const heartbeatIntervalMs = 40;
    const rig = await startRig({ readPauseFrames: 1, readResumeFrames: 0, heartbeatIntervalMs });
    const peer = await rig.authenticatedPeer();

    peer.sendText(telemetryText().text);
    await rig.until((stats) => stats.readPaused === 1, 'the connection paused');
    // Ten intervals paused: every pong the peer sends meanwhile sits unread in TCP.
    await sleep(10 * heartbeatIntervalMs);
    expect(rig.ws.stats(), 'a paused connection is not terminated').toMatchObject({
      authenticated: 1,
      readPaused: 1,
    });
    expect(peer.isEnded()).toBe(false);

    rig.releaseAll();
    await rig.until((stats) => stats.readPaused === 0, 'the connection resumed');
    await sleep(5 * heartbeatIntervalMs);
    expect(rig.ws.stats(), 'the pongs read after resuming keep it alive').toMatchObject({
      authenticated: 1,
    });
    expect(
      peer.received.filter((frame) => frame.opcode === OPCODE.ping).length,
      'the heartbeat kept pinging',
    ).toBeGreaterThan(0);

    peer.answerPings = false;
    await rig.until(
      (stats) => stats.authenticated === 0,
      'a peer that stops answering is terminated',
    );
    await peer.ended;
    expect(
      rig.logs.filter(
        (entry) => entry.message === 'terminated a connection that missed a heartbeat',
      ),
    ).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The backlog close, the last resort
 * ---------------------------------------------------------------------------------------------- */

describe('the backlog close behind read backpressure', () => {
  it('closes with 1013 once frames already read overflow the cap, and completes the handshake', async () => {
    const rig = await startRig({ maxPendingFrames: 4, readPauseFrames: 2, readResumeFrames: 0 });
    const peer = await rig.authenticatedPeer();

    const running = telemetryText();
    peer.sendText(running.text);
    await rig.until(() => rig.handled.length === 1, 'the first frame is running, and held');

    // One TCP write: `ws` parses all five from one read, pause or no pause —
    // the second frame reaches the pause mark, the fourth the cap, and the
    // fifth closes the connection while the first is still running. Only the
    // resume a closing connection gets lets the peer's echoed close be read
    // at once; without it the handshake waits out the terminate fallback.
    const closingAt = Date.now();
    peer.sendText(...textsOf(telemetryTexts(5)));
    await peer.ended;
    expect(
      Date.now() - closingAt,
      'the closing handshake completed rather than waiting for the terminate fallback',
    ).toBeLessThan(CLOSE_HANDSHAKE_GRACE_MS);
    await rig.until((stats) => stats.open === 0, 'the server saw the connection close');
    expect(rig.handled, 'the frames behind the running one were never handled').toEqual([
      running.id,
    ]);

    const close = peer.received.find((frame) => frame.opcode === OPCODE.close);
    expect(close?.payload.readUInt16BE(0)).toBe(WS_CLOSE_TRY_AGAIN_LATER);
    expect(close?.payload.subarray(2).toString('utf8')).toBe(BACKLOG_REASON);
    expect(
      rig.logs.filter(
        (entry) => entry.message === 'closed a connection whose frame backlog overflowed',
      ),
    ).toHaveLength(1);
    const closedRecord = rig.logs.find(
      (entry) => entry.message === 'a WebSocket connection closed',
    );
    expect(closedRecord?.fields.code, 'the close code the peer echoed').toBe(
      WS_CLOSE_TRY_AGAIN_LATER,
    );
    expect(rig.ws.stats()).toMatchObject({ readPauses: 1, readPaused: 0 });
  });

  it('counts frames one read carried past the mark, and stays open while they are under the cap', async () => {
    const rig = await startRig({ maxPendingFrames: 16, readPauseFrames: 2, readResumeFrames: 0 });
    const peer = await rig.authenticatedPeer();
    const burst = telemetryTexts(6);
    const later = telemetryTexts(6);

    // One TCP write: the pause at two cannot stop `ws` emitting the other four.
    peer.sendText(...textsOf(burst));
    expect(
      await rig.until((stats) => stats.pendingFrames === 6, 'the whole burst was queued'),
    ).toMatchObject({ readPaused: 1, readPauses: 1 });

    // Separate writes while paused arrive as separate reads, so on resuming
    // the queue is read a read at a time and pauses again at the mark.
    for (const frame of later) {
      peer.sendText(frame.text);
      await sleep(POLL_INTERVAL_MS);
    }
    expect(rig.ws.stats().pendingFrames).toBe(6);
    rig.release(6);
    const repaused = await rig.until(
      (stats) => stats.readPauses === 2,
      'the drained connection resumed and paused again',
    );
    expect(repaused.pendingFrames).toBeGreaterThanOrEqual(2);
    expect(repaused.pendingFrames).toBeLessThan(16);

    rig.releaseAll();
    await rig.until(
      (stats) => stats.pendingFrames === 0 && rig.handled.length === 12,
      'every frame was handled',
    );
    expect(rig.handled).toEqual([...idsOf(burst), ...idsOf(later)]);
    expect(peer.isEnded()).toBe(false);
    expect(
      rig.logs.filter(
        (entry) => entry.message === 'closed a connection whose frame backlog overflowed',
      ),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The marks
 * ---------------------------------------------------------------------------------------------- */

describe('the read-backpressure marks', () => {
  it('refuses marks that do not nest, and lets the defaults follow a smaller cap down', () => {
    const base = (options: RigOptions): Result<WsServer, DebuggenError> =>
      createWsServer({
        auth: {
          authorizeHello: () => ok(PRINCIPAL),
          announceWorkspace: () => err(new DebuggenError('INTERNAL', 'Not an editor.')),
        },
        clients: createClientRegistry(),
        binding: {
          handleSessionBind: unrouted,
          handleTabNavigated: unrouted,
          handleSessionUnbind: unrouted,
        },
        telemetry: { handleTelemetryEventFrame: unrouted },
        readiness: { agentReady: unrouted },
        targets: { selected: unrouted },
        sourceOpen: { handle: unrouted, acceptEditorResult: unrouted, close: () => undefined },
        heartbeatIntervalMs: 0,
        ...options,
      });

    for (const invalid of [
      { readPauseFrames: 0 },
      { maxPendingFrames: 8, readPauseFrames: 9 },
      { readPauseFrames: 4, readResumeFrames: 4 },
      { readResumeFrames: -1 },
      { readPauseBytes: 0 },
      { readPauseBytes: 1_024, readResumeBytes: 1_024 },
      { readPauseBytes: 1.5 },
    ] satisfies RigOptions[]) {
      const created = base(invalid);
      expect(isErr(created) && created.error.code, JSON.stringify(invalid)).toBe('CONFIG_INVALID');
    }

    for (const valid of [
      { maxPendingFrames: 8 },
      { maxPendingFrames: 1 },
      { readPauseFrames: 1 },
      { readPauseBytes: 1 },
      { readPauseBytes: 1_024, readResumeBytes: 0 },
    ] satisfies RigOptions[]) {
      const created = base(valid);
      expect(isErr(created), JSON.stringify(valid)).toBe(false);
      if (!isErr(created)) {
        void created.value.close();
      }
    }
  });

  it('keeps its defaults nested under the cap and a full queue inside the pong timeout', () => {
    expect(DEFAULT_READ_RESUME_FRAMES).toBeLessThan(DEFAULT_READ_PAUSE_FRAMES);
    expect(DEFAULT_READ_PAUSE_FRAMES).toBeLessThanOrEqual(DEFAULT_MAX_PENDING_FRAMES / 4);
    expect(DEFAULT_READ_RESUME_BYTES).toBeLessThan(DEFAULT_READ_PAUSE_BYTES);

    // The measured cost the marks are chosen against: about a millisecond to
    // store an event, and a few hundred bytes of JSON per event. Even at a
    // small event, a full queue is well under half the pong timeout.
    const smallEventBytes = 250;
    const storeMsPerEvent = 1.1;
    const fullQueueMs = (DEFAULT_READ_PAUSE_BYTES / smallEventBytes) * storeMsPerEvent;
    expect(fullQueueMs).toBeLessThan(SERVICE_PONG_TIMEOUT_MS / 2);
  });
});
