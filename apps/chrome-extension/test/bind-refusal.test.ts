/**
 * Unit spec for the worker's handling of the service's refusals of its own
 * `session.bind` frames (`createBindRefLedger`, `createBindRefusalRelayFilter`
 * and `BIND_EMPTY_STATE_CODES` in `../src/background/service-worker.ts`).
 *
 * The product guarantee held here: a tab no session serves is simply unbound,
 * and its panel shows the neutral empty state ("No session yet — start one
 * from the Debug Generator view in VS Code"). The service answers such a bind
 * with a session-less `error` whose `ref` is the bind's envelope id, which the
 * port hub would otherwise broadcast to every panel as a failed request —
 * after pairing, after every reconnect and after every service restart, since
 * the worker re-requests the binding of every announced tab whenever its
 * socket opens. So the spec asserts that
 *
 * - the ledger hands back the tab a recorded bind asked for exactly once, and
 *   stays bounded by forgetting its oldest id;
 * - a `SESSION_NOT_FOUND` refusal of a recorded bind reaches no panel;
 * - any other refusal of a recorded bind reaches only the asking tab's panels;
 * - every other frame, an `error` answering anything else included, is
 *   relayed unchanged, in order;
 * - nothing the service wrote reaches a log line.
 *
 * The last block drives the real port hub (`../src/background/ports.ts`) with
 * two panels on two tabs.
 *
 * **Harness.** Collected by the root `vitest.config.ts` into the
 * `chrome-extension` project (happy-dom). Importing the worker module composes
 * nothing — its bootstrap finds no `chrome` global. Ids are neutral synthetic
 * values (AAP §0.5.4).
 */

import { describe, expect, it } from 'vitest';

import { createEnvelope } from '@debuggen/protocol';
import type { ProtocolMessage } from '@debuggen/protocol';
import { DebuggenError, err } from '@debuggen/shared';
import type { LogFields, Logger, LogLevel, Result } from '@debuggen/shared';

import { workerError } from '../src/background/messages';
import type { WorkerTimerApi } from '../src/background/messages';
import { createPortHub } from '../src/background/ports';
import type { PortRequestHandlers } from '../src/background/ports';
import {
  BIND_EMPTY_STATE_CODES,
  BIND_REF_LEDGER_CAPACITY,
  createBindRefLedger,
  createBindRefusalRelayFilter,
} from '../src/background/service-worker';
import { isPortPush, PORT_PANEL } from '../src/shared/messages';

/*
 * ===========================================================================
 * Fixtures and fakes
 * ===========================================================================
 */

const TAB_A = 101;
const TAB_B = 202;
const SESSION_ID = 'ses_bind_refusal_a';
const BIND_ID = 'msg_bind_refusal_1';

/** The sentence the service answers a bind for an origin no session serves with. */
const NO_SESSION_SENTENCE = 'No active session is debugging the application at this origin.';

/** A sentence no log line may ever contain. */
const PRIVATE_SENTENCE = 'sentinel-private-refusal-text';

interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

function createRecordingLogger(entries: LogEntry[], bindings: LogFields = {}): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields: { ...bindings, ...fields } });
    };
  return {
    level: 'trace',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: (more) => createRecordingLogger(entries, { ...bindings, ...more }),
  };
}

/** The service's refusal of the bind `ref`. */
function bindRefusal(ref: string, code: 'SESSION_NOT_FOUND' | 'RATE_LIMITED' | 'UNAUTHORIZED') {
  return createEnvelope('error', {
    code,
    message: code === 'SESSION_NOT_FOUND' ? NO_SESSION_SENTENCE : PRIVATE_SENTENCE,
    ref,
  });
}

interface Relayed {
  readonly message: ProtocolMessage;
  readonly tabId: number | undefined;
}

function createSink(): {
  readonly relayed: Relayed[];
  readonly logs: LogEntry[];
  readonly ledger: ReturnType<typeof createBindRefLedger>;
  readonly push: ReturnType<typeof createBindRefusalRelayFilter>;
} {
  const relayed: Relayed[] = [];
  const logs: LogEntry[] = [];
  const ledger = createBindRefLedger();
  const push = createBindRefusalRelayFilter(
    ledger,
    (message, tabId) => {
      relayed.push({ message, tabId });
    },
    createRecordingLogger(logs),
  );
  return { relayed, logs, ledger, push };
}

/*
 * ===========================================================================
 * The ledger
 * ===========================================================================
 */

describe('createBindRefLedger', () => {
  it('hands back the tab a recorded bind asked for exactly once', () => {
    const ledger = createBindRefLedger();
    ledger.record(BIND_ID, TAB_A);

    expect(ledger.size).toBe(1);
    expect(ledger.take(BIND_ID)).toBe(TAB_A);
    expect(ledger.take(BIND_ID)).toBeUndefined();
    expect(ledger.size).toBe(0);
  });

  it('answers undefined for an id it never recorded', () => {
    expect(createBindRefLedger().take('msg_never_sent')).toBeUndefined();
  });

  it('forgets an id whose frame was never sent', () => {
    const ledger = createBindRefLedger();
    ledger.record(BIND_ID, TAB_A);
    ledger.forget(BIND_ID);
    ledger.forget('msg_unknown');

    expect(ledger.take(BIND_ID)).toBeUndefined();
    expect(ledger.size).toBe(0);
  });

  it('stays bounded by forgetting its oldest id first', () => {
    const ledger = createBindRefLedger(2);
    ledger.record('msg_first', TAB_A);
    ledger.record('msg_second', TAB_B);
    ledger.record('msg_third', TAB_A);

    expect(ledger.size).toBe(2);
    expect(ledger.take('msg_first')).toBeUndefined();
    expect(ledger.take('msg_second')).toBe(TAB_B);
    expect(ledger.take('msg_third')).toBe(TAB_A);
  });

  it('treats a repeated record as the newest, so it outlives the ids recorded before it', () => {
    const ledger = createBindRefLedger(2);
    ledger.record('msg_first', TAB_A);
    ledger.record('msg_second', TAB_B);
    ledger.record('msg_first', TAB_B);
    ledger.record('msg_third', TAB_A);

    expect(ledger.take('msg_second')).toBeUndefined();
    expect(ledger.take('msg_first')).toBe(TAB_B);
  });

  it('falls back to the default capacity for one that is not a positive integer', () => {
    for (const capacity of [0, -3, 1.5, Number.NaN]) {
      const ledger = createBindRefLedger(capacity);
      for (let index = 0; index <= BIND_REF_LEDGER_CAPACITY; index += 1) {
        ledger.record(`msg_bind_${String(index)}`, TAB_A);
      }
      expect(ledger.size).toBe(BIND_REF_LEDGER_CAPACITY);
    }
  });
});

/*
 * ===========================================================================
 * The relay filter
 * ===========================================================================
 */

describe('createBindRefusalRelayFilter', () => {
  it('names SESSION_NOT_FOUND, and only it, as the empty state', () => {
    expect([...BIND_EMPTY_STATE_CODES]).toEqual(['SESSION_NOT_FOUND']);
  });

  it('withholds the refusal saying no session serves the tab, and forgets the bind', () => {
    const sink = createSink();
    sink.ledger.record(BIND_ID, TAB_A);

    sink.push(bindRefusal(BIND_ID, 'SESSION_NOT_FOUND'), undefined);

    expect(sink.relayed).toEqual([]);
    expect(sink.ledger.size).toBe(0);
    expect(
      sink.logs.some(
        (entry) =>
          entry.level === 'debug' &&
          entry.fields.tabId === TAB_A &&
          entry.fields.errorCode === 'SESSION_NOT_FOUND',
      ),
    ).toBe(true);
    expect(JSON.stringify(sink.logs)).not.toContain(NO_SESSION_SENTENCE);
  });

  it("relays any other refusal of the bind to the asking tab's panels only", () => {
    const sink = createSink();
    sink.ledger.record(BIND_ID, TAB_B);
    const refusal = bindRefusal(BIND_ID, 'RATE_LIMITED');

    sink.push(refusal, undefined);

    expect(sink.relayed).toEqual([{ message: refusal, tabId: TAB_B }]);
    expect(sink.ledger.size).toBe(0);
    expect(JSON.stringify(sink.logs)).not.toContain(PRIVATE_SENTENCE);
  });

  it('relays an error answering no recorded bind, and every other frame, unchanged and in order', () => {
    const sink = createSink();
    sink.ledger.record(BIND_ID, TAB_A);
    const unrelated = bindRefusal('msg_other_request', 'SESSION_NOT_FOUND');
    const bare = createEnvelope('error', { code: 'INTERNAL', message: 'x' });
    const request = createEnvelope('target.request', { sessionId: SESSION_ID });

    sink.push(unrelated, undefined);
    sink.push(bare, undefined);
    sink.push(request, TAB_A);

    expect(sink.relayed).toEqual([
      { message: unrelated, tabId: undefined },
      { message: bare, tabId: undefined },
      { message: request, tabId: TAB_A },
    ]);
    expect(sink.ledger.take(BIND_ID), 'still awaiting its own answer').toBe(TAB_A);
  });

  it('treats a second refusal naming an answered bind as any other frame', () => {
    const sink = createSink();
    sink.ledger.record(BIND_ID, TAB_A);
    const refusal = bindRefusal(BIND_ID, 'SESSION_NOT_FOUND');

    sink.push(refusal, undefined);
    sink.push(refusal, undefined);

    expect(sink.relayed).toEqual([{ message: refusal, tabId: undefined }]);
  });
});

/*
 * ===========================================================================
 * Two panels on two tabs — through the port hub
 * ===========================================================================
 */

describe('bind refusals across two panels', () => {
  const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

  interface PanelPort {
    readonly posted: unknown[];
    readonly port: chrome.runtime.Port;
  }

  function createPanelPort(): PanelPort {
    const posted: unknown[] = [];
    const event = <Listener>(set: Set<Listener>) => ({
      addListener: (listener: Listener): void => {
        set.add(listener);
      },
      removeListener: (listener: Listener): void => {
        set.delete(listener);
      },
    });
    const fake = {
      name: PORT_PANEL,
      sender: { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/src/panel/panel.html` },
      postMessage: (message: unknown): void => {
        posted.push(message);
      },
      disconnect: (): void => undefined,
      onMessage: event(new Set<(message: unknown) => void>()),
      onDisconnect: event(new Set<() => void>()),
    };
    // The hub reads only the members above; the rest of the type is Chrome's.
    return { posted, port: fake as unknown as chrome.runtime.Port };
  }

  /** The protocol envelopes a panel received — what its session store records. */
  function protocolMessagesOf(panel: PanelPort): unknown[] {
    return panel.posted
      .filter(isPortPush)
      .flatMap((push) => (push.kind === 'protocol' ? [push.message] : []));
  }

  function createWorld() {
    const timers: WorkerTimerApi = {
      setTimeout: (handler, ms) => Number(setTimeout(handler, ms)),
      clearTimeout: (handle) => {
        clearTimeout(handle);
      },
    };
    const unused = (): Promise<Result<never, DebuggenError>> =>
      Promise.resolve(err(workerError('INTERNAL', 'Not used by this suite.')));
    const handlers: PortRequestHandlers = {
      'panelData.query': unused,
      'source.open': unused,
      'capture.start': unused,
      'capture.stop': unused,
      'target.pick': unused,
      'target.selected': unused,
      'pair.complete': unused,
      'session.snapshot': unused,
      'page.reload': unused,
    };
    const hub = createPortHub({
      runtime: { id: EXTENSION_ID },
      timers,
      handlers,
      bridgeHandlers: {
        'agent.ready': () => undefined,
        'telemetry.batch': () => undefined,
        'target.described': () => undefined,
        'agent.error': () => undefined,
      },
      resolveTabForSession: () => undefined,
    });
    const ledger = createBindRefLedger();
    const relay = createBindRefusalRelayFilter(ledger, hub.relayPush);
    const panelA = createPanelPort();
    const panelB = createPanelPort();
    hub.handleConnect(panelA.port);
    hub.handleConnect(panelB.port);
    const [first, second] = hub.listConnections();
    if (first === undefined || second === undefined) {
      throw new Error('two panel connections');
    }
    expect(hub.bindPanelTab(first.connectionId, TAB_A)).toBe(true);
    expect(hub.bindPanelTab(second.connectionId, TAB_B)).toBe(true);
    return { ledger, relay, panelA, panelB };
  }

  it('shows neither panel a failure when no session serves the asking tab', () => {
    const world = createWorld();
    world.ledger.record(BIND_ID, TAB_A);

    world.relay(bindRefusal(BIND_ID, 'SESSION_NOT_FOUND'));

    expect(protocolMessagesOf(world.panelA)).toEqual([]);
    expect(protocolMessagesOf(world.panelB)).toEqual([]);
  });

  it("delivers another refusal of one tab's bind to that tab's panel alone", () => {
    const world = createWorld();
    world.ledger.record(BIND_ID, TAB_B);
    const refusal = bindRefusal(BIND_ID, 'UNAUTHORIZED');

    world.relay(refusal);

    expect(protocolMessagesOf(world.panelA)).toEqual([]);
    expect(protocolMessagesOf(world.panelB)).toEqual([refusal]);
  });

  it('still broadcasts a session-less error that answers no bind', () => {
    const world = createWorld();
    const bare = createEnvelope('error', { code: 'INTERNAL', message: 'x' });

    world.relay(bare);

    expect(protocolMessagesOf(world.panelA)).toEqual([bare]);
    expect(protocolMessagesOf(world.panelB)).toEqual([bare]);
  });
});
