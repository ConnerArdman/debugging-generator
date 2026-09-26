/**
 * The webview's inbound channel (`src/webview/vscode-api.ts`), run in the
 * `vscode-extension-webview` Vitest project (happy-dom).
 *
 * The module installs its one `message` listener and its pre-subscription
 * buffer at evaluation, so every case evaluates a fresh copy:
 * `vi.resetModules()` followed by a dynamic import. A copy imported by an
 * earlier case keeps its own listener on the shared window, but nothing ever
 * subscribes to it again, so it can only buffer into its own, unreachable
 * array — it never delivers to a later case's handler.
 *
 * Frames are delivered exactly as the webview receives them from the host:
 * `window.dispatchEvent(new MessageEvent('message', { data }))`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostToWebviewMessage, WebviewState } from '../webview-messages';

/** Sender-controlled text: must never be delivered as, or inside, a message. */
const SENTINEL = 'https://example.invalid/private-sentinel?q=do-not-log';

/** A minimal valid snapshot — no session — distinguishable by its provider name. */
function snapshot(provider = 'deterministic'): WebviewState {
  return {
    connection: {
      status: 'open',
      serviceUrl: 'http://127.0.0.1:43117',
      serviceReachable: true,
      provider,
    },
    progress: [],
    relevantFiles: [],
    modifications: [],
    capture: { active: false, eventCount: 0 },
    cleanup: { status: 'pending', conflicts: [] },
  };
}

function stateFrame(provider?: string): HostToWebviewMessage {
  return { type: 'state', state: snapshot(provider) };
}

function noticeFrame(index: number): HostToWebviewMessage {
  return { type: 'notice', level: 'info', message: `notice ${String(index)}` };
}

/** Delivers one frame to every `message` listener on the window, synchronously. */
function post(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

/** A fresh evaluation of the module under test. */
async function freshApi(): Promise<typeof import('./vscode-api')> {
  vi.resetModules();
  return import('./vscode-api');
}

/** Subscribes a recording handler and returns what it received plus its unsubscribe. */
function record(api: Awaited<ReturnType<typeof freshApi>>): {
  readonly received: HostToWebviewMessage[];
  readonly unsubscribe: () => void;
} {
  const received: HostToWebviewMessage[] = [];
  const unsubscribe = api.subscribeToHost((message) => {
    received.push(message);
  });
  return { received, unsubscribe };
}

describe('vscode-api — the pre-subscription buffer', () => {
  let api: Awaited<ReturnType<typeof freshApi>>;

  beforeEach(async () => {
    api = await freshApi();
  });

  it('keeps the only snapshot through a burst of notices, then the newest notices, in arrival order', () => {
    post(stateFrame());
    for (let index = 1; index <= 20; index += 1) {
      post(noticeFrame(index));
    }

    const { received } = record(api);

    expect(received).toHaveLength(16);
    expect(received[0]).toStrictEqual(stateFrame());
    expect(received.slice(1)).toStrictEqual(
      Array.from({ length: 15 }, (_unused, offset) => noticeFrame(offset + 6)),
    );
  });

  it('keeps only the newest of two snapshots, in the newest one’s arrival position', () => {
    post(stateFrame('first'));
    post(noticeFrame(1));
    post(stateFrame('second'));

    const { received } = record(api);

    expect(received).toStrictEqual([noticeFrame(1), stateFrame('second')]);
  });

  it('keeps a snapshot that arrives after the buffer is already full of notices', () => {
    for (let index = 1; index <= 16; index += 1) {
      post(noticeFrame(index));
    }
    post(stateFrame());

    const { received } = record(api);

    expect(received).toHaveLength(16);
    expect(received.slice(0, 15)).toStrictEqual(
      Array.from({ length: 15 }, (_unused, offset) => noticeFrame(offset + 2)),
    );
    expect(received[15]).toStrictEqual(stateFrame());
  });

  it('empties the buffer into the first subscriber only', () => {
    post(stateFrame());
    const first = record(api);
    const second = record(api);

    expect(first.received).toStrictEqual([stateFrame()]);
    expect(second.received).toStrictEqual([]);
  });

  it('never buffers or delivers a malformed frame', () => {
    const malformed: unknown[] = [
      { type: 'state' },
      { type: 'state', state: {} },
      { type: 'state', state: { ...snapshot(), token: SENTINEL } },
      { type: SENTINEL },
      { type: 'notice', level: 'fatal', message: SENTINEL },
      { type: 'askQuestion', question: SENTINEL },
      null,
      SENTINEL,
      42,
      [stateFrame()],
    ];
    for (const data of malformed) {
      post(data);
    }

    const { received } = record(api);
    expect(received).toStrictEqual([]);

    for (const data of malformed) {
      post(data);
    }
    expect(received).toStrictEqual([]);
  });
});

describe('vscode-api — live delivery', () => {
  let api: Awaited<ReturnType<typeof freshApi>>;

  beforeEach(async () => {
    api = await freshApi();
  });

  it('delivers the validated copy immediately once subscribed', () => {
    const { received } = record(api);
    const frame = stateFrame();

    post(frame);

    expect(received).toStrictEqual([frame]);
    expect(received[0]).not.toBe(frame);
  });

  it('stops delivering to a handler once it unsubscribes, and buffers for the next subscriber', () => {
    const { received, unsubscribe } = record(api);
    post(noticeFrame(1));
    unsubscribe();
    post(noticeFrame(2));

    expect(received).toStrictEqual([noticeFrame(1)]);

    const next = record(api);
    expect(next.received).toStrictEqual([noticeFrame(2)]);
  });
});
