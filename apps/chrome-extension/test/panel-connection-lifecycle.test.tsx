/**
 * The panel connection's two lifecycle guarantees that only the real
 * `../src/panel/state/connection` over a worker port can show:
 *
 * - **Nothing is presented as reported before it is.** Until the worker has
 *   said anything — or the panel has seen for itself that no worker answers —
 *   the connection counts as unobserved: the pill reads a neutral
 *   "Connecting…" rather than the store's assumed "Reconnecting…", and
 *   nothing renders below the header. The first report then brings the
 *   pairing dialog and the body in the same commit, so the dialog is never
 *   inserted above a body already on screen (no layout shift). A first
 *   report that equals the initial state still counts, and so do a lost port
 *   and a document with no extension runtime.
 * - **A handshake the service refused is read again once the binding is
 *   confirmed.** After a re-pairing, the panel's snapshot can reach the service
 *   before the worker has re-bound the tab, and the session reads are refused.
 *   The relayed `session.bound` that confirms this panel's binding re-runs the
 *   handshake — also when it arrives while the refused handshake is still in
 *   flight — and the completed handshake dismisses the notice the refused one
 *   raised, leaving any other notice alone. A handshake that completed is not
 *   re-run by a later confirmation. Rendered in `App`, the whole re-pairing
 *   ends with the pill connected and Start capture available for a ready
 *   session, without the panel being reopened.
 *
 * **Harness.** Collected into the `chrome-extension` Vitest project
 * (happy-dom). Nothing is mocked: the connection is started with an injected
 * fake `chrome.runtime` whose ports record what the panel posts and deliver
 * what the worker would, with timers that never fire; `App` joins that
 * reference-counted connection. Ids and URLs are neutral synthetic values.
 */

import { createEnvelope, parseSessionRecord } from '@debuggen/protocol';
import type { SessionRecord } from '@debuggen/protocol';
import { DebuggenError, noopLogger } from '@debuggen/shared';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { isPortRequestOfMethod, portErr, portOk } from '../src/background/messages';
import { App } from '../src/panel/App';
import {
  getPanelConnection,
  getPanelConnectionObserved,
  startPanelConnection,
} from '../src/panel/state/connection';
import type {
  PanelConnectionDeps,
  PanelConnectionHandle,
  PanelPortEventLike,
  PanelPortLike,
} from '../src/panel/state/connection';
import { getPanelSnapshot, resetPanelStore, setLastError } from '../src/panel/state/session-store';
import {
  EXTENSION_CHANNEL,
  PANEL_CONNECTION_LABELS,
  PORT_PROTOCOL_VERSION,
  isPortRequest,
} from '../src/shared/messages';
import type { PanelBindingState, PortPush, PortRequestFrame } from '../src/shared/messages';

/*
 * ===========================================================================
 * Fixtures
 * ===========================================================================
 */

const SESSION = 'ses_2k7m4p9q1w3e5r8t';
const TAB = 63;
const APP_URL = 'http://localhost:4100/workspace/overview';

const BOUND: PanelBindingState = Object.freeze({
  kind: 'bound',
  sessionId: SESSION,
  tabId: TAB,
  url: APP_URL,
});

/** The pill's neutral label before anything has been observed. */
const PENDING_LABEL = 'Connecting…';

/** The heading of the pairing dialog. */
const PAIR_DIALOG_NAME = 'Pair this panel with VS Code';

/** The no-session body. */
const EMPTY_PANEL_TEXT = /No session yet/;

/** The capture control's accessible name. */
const START_CAPTURE_LABEL = 'Start capture';

/** A bound session waiting for its first capture. */
const READY_SESSION: SessionRecord = {
  id: SESSION,
  projectRoot: '/workspace/sample-project',
  projectName: 'sample-project',
  devServerUrl: 'http://localhost:4100',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  status: 'ready',
  question: 'Why does the overview take long to appear?',
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
};

/** The refusal a session read gets before the worker has re-bound the tab. */
function readRefusal(): DebuggenError {
  return new DebuggenError(
    'TAB_NOT_BOUND',
    'This tab is not bound to the session on this connection.',
  );
}

/*
 * ===========================================================================
 * The fake worker port
 * ===========================================================================
 */

interface FakePort extends PanelPortLike {
  readonly post: Mock<(message: unknown) => void>;
  readonly deliver: (message: unknown) => void;
  readonly drop: () => void;
}

function createPortEvent<Listener>(): PanelPortEventLike<Listener> & {
  readonly listeners: Set<Listener>;
} {
  const listeners = new Set<Listener>();
  return {
    listeners,
    addListener: (listener: Listener): void => {
      listeners.add(listener);
    },
    removeListener: (listener: Listener): void => {
      listeners.delete(listener);
    },
  };
}

function createFakePort(): FakePort {
  const onMessage = createPortEvent<(message: unknown) => void>();
  const onDisconnect = createPortEvent<(port: unknown) => void>();
  const post = vi.fn<(message: unknown) => void>();
  const port: FakePort = {
    post,
    postMessage: post,
    disconnect: (): void => undefined,
    onMessage,
    onDisconnect,
    deliver: (message: unknown): void => {
      for (const listener of [...onMessage.listeners]) {
        listener(message);
      }
    },
    drop: (): void => {
      for (const listener of [...onDisconnect.listeners]) {
        listener(port);
      }
    },
  };
  return port;
}

const handles: PanelConnectionHandle[] = [];

/** Start the connection inside DevTools on {@link TAB}; timers never fire. */
function start(overrides: Partial<PanelConnectionDeps> = {}): FakePort[] {
  const ports: FakePort[] = [];
  handles.push(
    startPanelConnection({
      runtime: {
        connect: (): FakePort => {
          const port = createFakePort();
          ports.push(port);
          return port;
        },
      },
      readDevtools: () => ({ inspectedWindow: { tabId: TAB } }),
      setTimeout: (): unknown => undefined,
      clearTimeout: (): void => undefined,
      random: (): number => 0,
      logger: noopLogger,
      ...overrides,
    }),
  );
  return ports;
}

/** The only port the connection opened. */
function onlyPort(ports: readonly FakePort[]): FakePort {
  const port = ports[0];
  if (port === undefined || ports.length !== 1) {
    throw new Error(`expected exactly one panel port, found ${String(ports.length)}`);
  }
  return port;
}

/** The `session.snapshot` requests the panel posted on `port`, in order. */
function snapshotRequests(port: FakePort): PortRequestFrame<'session.snapshot'>[] {
  const found: PortRequestFrame<'session.snapshot'>[] = [];
  for (const [frame] of port.post.mock.calls) {
    if (isPortRequest(frame) && isPortRequestOfMethod(frame, 'session.snapshot')) {
      found.push(frame);
    }
  }
  return found;
}

/** The latest `session.snapshot` request, which must exist. */
function latestSnapshotRequest(port: FakePort): PortRequestFrame<'session.snapshot'> {
  const request = snapshotRequests(port).at(-1);
  if (request === undefined) {
    throw new Error('the panel posted no session.snapshot request');
  }
  return request;
}

/** Deliver one worker frame inside `act` and let its continuations run. */
async function deliver(port: FakePort, frame: unknown): Promise<void> {
  await act(async () => {
    port.deliver(frame);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

/** A worker `connection` push. */
function connectionPush(status: 'connected' | 'reconnecting' | 'not-paired'): PortPush {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'push',
    kind: 'connection',
    state: { status },
  };
}

/** The service's `session.bound` for {@link TAB}, relayed by the worker. */
function sessionBoundPush(tabId: number = TAB): PortPush {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'push',
    kind: 'protocol',
    message: createEnvelope('session.bound', { sessionId: SESSION, tabId, url: APP_URL }),
  };
}

/** The text of the pill's live region. */
function pillText(): string {
  return (screen.getByRole('status', { name: /./ }).textContent ?? '').replace(/\s+/g, ' ').trim();
}

/*
 * ===========================================================================
 * Suite
 * ===========================================================================
 */

beforeEach(() => {
  resetPanelStore({ includeConnection: true });
  vi.stubGlobal('chrome', { devtools: { inspectedWindow: { tabId: TAB } } });
});

afterEach(async () => {
  cleanup();
  for (const handle of handles.splice(0)) {
    handle.stop();
  }
  await Promise.resolve();
  await Promise.resolve();
  resetPanelStore({ includeConnection: true });
  vi.unstubAllGlobals();
});

describe('fixtures', () => {
  it('uses a valid SessionRecord', () => {
    expect(parseSessionRecord(READY_SESSION).ok).toBe(true);
  });
});

describe('before the connection state is observed', () => {
  it('reads "Connecting…" and renders nothing below the header, then brings the dialog and the body in one commit', async () => {
    const ports = start();
    const port = onlyPort(ports);
    render(createElement(App, { theme: 'dark' }));

    expect(getPanelConnectionObserved()).toBe(false);
    expect(pillText()).toBe(PENDING_LABEL);
    expect(pillText()).not.toContain(PANEL_CONNECTION_LABELS.reconnecting);
    expect(screen.queryByText(EMPTY_PANEL_TEXT)).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('main')).toBeNull();

    // Every DOM state between here and the end: the body is never on screen
    // without the dialog above it, which is what an inserted dialog would do.
    let bodyWithoutDialog = false;
    const observer = new MutationObserver(() => {
      const bodyShown = document.querySelector('main') !== null;
      const dialogShown = document.querySelector('[role="dialog"]') !== null;
      if (bodyShown && !dialogShown) {
        bodyWithoutDialog = true;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    await deliver(
      port,
      portOk(latestSnapshotRequest(port), {
        connection: { status: 'not-paired' },
        binding: { kind: 'unbound' },
      }),
    );
    observer.disconnect();

    expect(getPanelConnectionObserved()).toBe(true);
    expect(pillText()).toBe(PANEL_CONNECTION_LABELS['not-paired']);
    expect(screen.getByRole('dialog', { name: PAIR_DIALOG_NAME })).toBeDefined();
    expect(screen.getByText(EMPTY_PANEL_TEXT)).toBeDefined();
    expect(bodyWithoutDialog).toBe(false);
  });

  it('counts a first report that equals the initial state as observed', async () => {
    const port = onlyPort(start());
    render(createElement(App, { theme: 'dark' }));
    expect(getPanelSnapshot().connection.status).toBe('reconnecting');

    await deliver(port, connectionPush('reconnecting'));

    // The store's slice did not change, yet the report was heard.
    expect(getPanelSnapshot().connection.lastChangeAt).toBe(0);
    expect(getPanelConnectionObserved()).toBe(true);
    expect(pillText()).toBe(PANEL_CONNECTION_LABELS.reconnecting);
    expect(screen.getByText(EMPTY_PANEL_TEXT)).toBeDefined();
  });

  it('counts a lost port as observed: the panel saw no worker answer', async () => {
    const port = onlyPort(start());
    render(createElement(App, { theme: 'dark' }));
    expect(getPanelConnectionObserved()).toBe(false);

    await act(async () => {
      port.drop();
      await Promise.resolve();
    });

    expect(getPanelConnectionObserved()).toBe(true);
    expect(pillText()).toBe(PANEL_CONNECTION_LABELS.reconnecting);
    expect(screen.getByText(EMPTY_PANEL_TEXT)).toBeDefined();
  });

  it('counts a settled handshake as observed even when the worker refused it', async () => {
    const port = onlyPort(start());

    await deliver(port, portErr(latestSnapshotRequest(port), readRefusal()));

    expect(getPanelConnectionObserved()).toBe(true);
  });

  it('is observed at once where no extension runtime exists, since nothing will ever report', () => {
    handles.push(
      startPanelConnection({
        runtime: undefined,
        readDevtools: () => undefined,
        setTimeout: (): unknown => undefined,
        clearTimeout: (): void => undefined,
        logger: noopLogger,
      }),
    );

    expect(getPanelConnectionObserved()).toBe(true);
  });
});

describe('a handshake refused before the binding was confirmed', () => {
  it('is read again when the service confirms the binding, and the completed read dismisses its notice', async () => {
    const port = onlyPort(start());
    await deliver(port, portErr(latestSnapshotRequest(port), readRefusal()));
    expect(getPanelSnapshot().lastError?.code).toBe('TAB_NOT_BOUND');
    expect(snapshotRequests(port)).toHaveLength(1);

    // The socket connected meanwhile; the worker says so.
    await deliver(port, connectionPush('connected'));
    expect(snapshotRequests(port)).toHaveLength(1);

    // The service confirms the re-binding: the reads can succeed now.
    await deliver(port, sessionBoundPush());
    expect(snapshotRequests(port)).toHaveLength(2);

    await deliver(
      port,
      portOk(latestSnapshotRequest(port), { connection: { status: 'connected' }, binding: BOUND }),
    );

    expect(getPanelSnapshot().connection.status).toBe('connected');
    expect(getPanelSnapshot().connection.binding).toEqual(BOUND);
    expect(getPanelSnapshot().lastError).toBeUndefined();

    // A completed handshake is not re-run by a later confirmation.
    await deliver(port, sessionBoundPush());
    expect(snapshotRequests(port)).toHaveLength(2);
  });

  it('is run once more when the confirmation arrives while the refused handshake is in flight', async () => {
    const port = onlyPort(start());
    const first = latestSnapshotRequest(port);

    await deliver(port, sessionBoundPush());
    expect(snapshotRequests(port)).toHaveLength(1);

    await deliver(port, portErr(first, readRefusal()));
    expect(snapshotRequests(port)).toHaveLength(2);

    await deliver(
      port,
      portOk(latestSnapshotRequest(port), { connection: { status: 'connected' }, binding: BOUND }),
    );
    expect(getPanelSnapshot().lastError).toBeUndefined();
    expect(snapshotRequests(port)).toHaveLength(2);
  });

  it('is not re-run by a confirmation for another tab', async () => {
    const port = onlyPort(start());
    await deliver(port, portErr(latestSnapshotRequest(port), readRefusal()));

    await deliver(port, sessionBoundPush(TAB + 1));

    expect(snapshotRequests(port)).toHaveLength(1);
  });

  it('leaves a notice another request raised meanwhile on screen', async () => {
    const port = onlyPort(start());
    await deliver(port, portErr(latestSnapshotRequest(port), readRefusal()));
    const other = {
      code: 'CAPTURE_ALREADY_ACTIVE',
      message: 'Another session holds the capture.',
    } as const;
    act(() => {
      setLastError(other);
    });

    await deliver(port, sessionBoundPush());
    await deliver(
      port,
      portOk(latestSnapshotRequest(port), { connection: { status: 'connected' }, binding: BOUND }),
    );

    expect(getPanelSnapshot().lastError).toEqual(other);
  });

  it('makes Start capture available after a re-pairing, without reopening the panel', async () => {
    const port = onlyPort(start());
    render(createElement(App, { theme: 'dark' }));

    // Token rotation left the panel unpaired, with its dialog open.
    await deliver(
      port,
      portOk(latestSnapshotRequest(port), {
        connection: { status: 'not-paired' },
        binding: { kind: 'unbound' },
      }),
    );
    expect(screen.getByRole('dialog', { name: PAIR_DIALOG_NAME })).toBeDefined();

    // Pairing succeeded: the worker pushes its live state to this panel, and the
    // panel re-reads its session — before the worker has re-bound the tab.
    await deliver(port, connectionPush('connected'));
    expect(pillText()).toBe(PANEL_CONNECTION_LABELS.connected);
    await act(async () => {
      getPanelConnection().resync();
      await Promise.resolve();
    });
    await deliver(port, portErr(latestSnapshotRequest(port), readRefusal()));
    expect(pillText()).toBe(PANEL_CONNECTION_LABELS.connected);

    // The service confirms the binding; the re-read now returns the ready session.
    await deliver(port, sessionBoundPush());
    await deliver(
      port,
      portOk(latestSnapshotRequest(port), {
        connection: { status: 'connected' },
        binding: BOUND,
        session: READY_SESSION,
      }),
    );

    expect(pillText()).toBe(PANEL_CONNECTION_LABELS.connected);
    expect(getPanelSnapshot().lastError).toBeUndefined();
    const startCapture = screen.getByRole('button', { name: START_CAPTURE_LABEL });
    expect(startCapture.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('is not re-run when the first handshake completed', async () => {
    const port = onlyPort(start());
    await deliver(
      port,
      portOk(latestSnapshotRequest(port), { connection: { status: 'connected' }, binding: BOUND }),
    );

    await deliver(port, sessionBoundPush());

    expect(snapshotRequests(port)).toHaveLength(1);
  });
});
