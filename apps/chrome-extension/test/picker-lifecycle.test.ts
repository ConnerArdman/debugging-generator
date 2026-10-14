/**
 * End-to-end spec, on the panel's side of the worker's port, for how picker
 * mode ends ("Pick element" toggles picker mode; the
 * service's `target.request` asks the panel to enter it; a failure is
 * never shown as success, and a success is never shown as a failure):
 *
 * - **The page's pick ends picker mode in the panel.** The worker arms one
 *   interactive pick in the inspected page and, when that pick ends — an
 *   element clicked, Escape pressed there, the page hidden or its document
 *   gone — pushes `picker { active: false }`. The panel's toggle releases
 *   (`aria-pressed="false"`), the "Picker on" badge goes, and no error is
 *   recorded, because a pick that ended is not a failure.
 * - **The panel does not answer the push.** Picker mode ended in the page, so
 *   the panel sends no `target.pick { enabled: false }` of its own.
 * - **The next request is a new activation.** After a push-driven end, the
 *   service's next `target.request` arms picker mode again, exactly once.
 * - **A push is idempotent and validated.** A `picker` push while picker mode
 *   is already off changes nothing; an unreadable one is dropped, leaves
 *   picker mode as it was and says an update was ignored.
 * - **A lost port ends picker mode.** When the worker's port closes, the
 *   worker generation that armed the page pick is gone or has lost this
 *   panel, and the page's pick ends either way — so the toggle releases at
 *   once, with nothing sent, instead of waiting for a push no port will carry.
 *
 * **Harness.** Collected into the `chrome-extension` Vitest project
 * (happy-dom). Unlike `./panel-picker.test.tsx`, nothing is mocked: `App` is
 * rendered whole against the real `../src/panel/state/connection` and the real
 * session store. The case starts the connection first with an injected fake
 * `chrome.runtime` whose one port records what the panel posts and delivers
 * what the worker would; `App`'s own `startPanelConnection()` then joins that
 * reference-counted connection. `chrome.devtools` is stubbed with the
 * inspected tab id, which "Pick element" requires. Written in `.ts`, so the
 * panel is rendered through `createElement`. Ids and URLs are neutral
 * synthetic values.
 */

import { createEnvelope } from '@debuggen/protocol';
import { noopLogger } from '@debuggen/shared';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { isPortRequestOfMethod, portOk } from '../src/background/messages';
import { App } from '../src/panel/App';
import { startPanelConnection } from '../src/panel/state/connection';
import type {
  PanelConnectionHandle,
  PanelPortEventLike,
  PanelPortLike,
} from '../src/panel/state/connection';
import { getPanelSnapshot, resetPanelStore } from '../src/panel/state/session-store';
import { EXTENSION_CHANNEL, PORT_PROTOCOL_VERSION, isPortRequest } from '../src/shared/messages';
import type { PanelBindingState, PortPush, PortRequestFrame } from '../src/shared/messages';

/*
 * ===========================================================================
 * Fixtures
 * ===========================================================================
 */

/** The session bound to the inspected tab. */
const SESSION = 'ses_7h3n5q2w8r4t6y1u';

/** The inspected tab. */
const TAB = 57;

/** The inspected document. */
const APP_URL = 'http://localhost:4100/workspace/overview';

/** The inspected tab's binding, as the worker answers and pushes it. */
const BOUND: PanelBindingState = Object.freeze({
  kind: 'bound',
  sessionId: SESSION,
  tabId: TAB,
  url: APP_URL,
});

/** The badge `TargetPicker` shows while picker mode is on. */
const PICKER_ON_BADGE = 'Picker on';

/** The worker's statement that the inspected page's pick ended. */
const PICKER_OFF: PortPush = Object.freeze({
  channel: EXTENSION_CHANNEL,
  version: PORT_PROTOCOL_VERSION,
  direction: 'push',
  kind: 'picker',
  state: Object.freeze({ active: false }),
});

/*
 * ===========================================================================
 * The fake worker port
 * ===========================================================================
 */

/** A `chrome.runtime.Port` stand-in: what the panel posts is recorded, what the worker sends is delivered. */
interface FakePort extends PanelPortLike {
  /** Every frame the panel posted, in order. */
  readonly post: Mock<(message: unknown) => void>;
  /** Deliver one frame from the worker to every `onMessage` listener. */
  readonly deliver: (message: unknown) => void;
  /** Close the port from the worker's end, as a suspended worker does: every `onDisconnect` listener fires. */
  readonly drop: () => void;
}

/** One `chrome.events.Event`-shaped listener set. */
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

/** A port that never fails a post and closes only when a case drops it. */
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

/** Every connection a case started, released in `afterEach`. */
const handles: PanelConnectionHandle[] = [];

/**
 * Start the panel's connection inside DevTools on {@link TAB}, with timers that
 * never fire (no request times out, no reconnect is scheduled), and answer its
 * hydration handshake with {@link BOUND}.
 *
 * @returns The one port the panel opened.
 */
async function connectBound(): Promise<FakePort> {
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
    }),
  );
  const port = ports[0];
  if (port === undefined) {
    throw new Error('the panel opened no port');
  }
  const handshake = requestsOf(port, 'session.snapshot')[0];
  if (handshake === undefined) {
    throw new Error('the panel posted no session.snapshot request');
  }
  await act(async () => {
    port.deliver(portOk(handshake, { connection: { status: 'connected' }, binding: BOUND }));
    await Promise.resolve();
  });
  expect(getPanelSnapshot().connection.binding).toEqual(BOUND);
  return port;
}

/** The requests of `kind` the panel posted on `port`, in order. */
function requestsOf<Kind extends 'session.snapshot' | 'target.pick'>(
  port: FakePort,
  kind: Kind,
): PortRequestFrame<Kind>[] {
  const found: PortRequestFrame<Kind>[] = [];
  for (const [frame] of port.post.mock.calls) {
    if (isPortRequest(frame) && isPortRequestOfMethod(frame, kind)) {
      found.push(frame as PortRequestFrame<Kind>);
    }
  }
  return found;
}

/** The `target.pick` requests the panel posted, as `enabled` flags in order. */
function pickFlags(port: FakePort): boolean[] {
  return requestsOf(port, 'target.pick').map((frame) => frame.payload.enabled);
}

/** Answer the latest `target.pick` the panel posted with the worker's `active`. */
async function answerLatestPick(port: FakePort, active: boolean): Promise<void> {
  const request = requestsOf(port, 'target.pick').at(-1);
  if (request === undefined) {
    throw new Error('the panel posted no target.pick request');
  }
  await act(async () => {
    port.deliver(portOk(request, { active }));
    await Promise.resolve();
  });
}

/** Deliver one worker push inside `act`, as the port would. */
async function deliverPush(port: FakePort, push: unknown): Promise<void> {
  await act(async () => {
    port.deliver(push);
    await Promise.resolve();
  });
}

/** The service's `target.request`, relayed by the worker as a protocol push. */
function serviceTargetRequest(): PortPush {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'push',
    kind: 'protocol',
    message: createEnvelope('target.request', { sessionId: SESSION }),
  };
}

/** Let every pending continuation — an answered request and its effects — run inside `act`. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

/** Render the whole panel; its connection joins the one {@link connectBound} started. */
function renderPanel(): void {
  render(createElement(App, { theme: 'dark' }));
}

/** The "Pick element" control. */
function pickButton(): HTMLElement {
  return screen.getByRole('button', { name: /Pick element/ });
}

/** Assert the panel shows picker mode on: pressed toggle, badge, no error. */
function expectPickerOn(): void {
  expect(pickButton().getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByText(PICKER_ON_BADGE)).not.toBeNull();
  expect(getPanelSnapshot().target.pickRequested).toBe(true);
  expect(getPanelSnapshot().lastError).toBeUndefined();
}

/** Assert the panel shows picker mode off: released toggle, no badge, no error. */
function expectPickerOff(): void {
  expect(pickButton().getAttribute('aria-pressed')).toBe('false');
  expect(screen.queryByText(PICKER_ON_BADGE)).toBeNull();
  expect(getPanelSnapshot().target.pickRequested).toBe(false);
  expect(getPanelSnapshot().lastError).toBeUndefined();
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
  // The last stop tears the connection down at the end of the microtask checkpoint.
  await Promise.resolve();
  await Promise.resolve();
  resetPanelStore({ includeConnection: true });
  vi.unstubAllGlobals();
});

describe('picker mode ends in the panel when the page pick ends', () => {
  it('releases the toggle and the badge on the worker’s picker push, recording no error and sending nothing back', async () => {
    const port = await connectBound();
    renderPanel();
    const user = userEvent.setup();

    // "Pick element": the panel arms picker mode; the worker answers it on.
    await user.click(pickButton());
    await answerLatestPick(port, true);
    await settle();
    expect(pickFlags(port)).toEqual([true]);
    expectPickerOn();

    // The developer clicked an element in the page (or pressed Escape there).
    await deliverPush(port, PICKER_OFF);
    await settle();

    expectPickerOff();
    // Picker mode ended in the page: the panel sends no `enabled: false` of its own.
    expect(pickFlags(port)).toEqual([true]);
  });

  it('arms the service’s next target.request as a new activation after a push-driven end', async () => {
    const port = await connectBound();
    renderPanel();

    // The service asks for a target: the panel arms picker mode once.
    await deliverPush(port, serviceTargetRequest());
    await settle();
    expect(pickFlags(port)).toEqual([true]);
    await answerLatestPick(port, true);
    await settle();
    expectPickerOn();

    // The page pick ends, and with it the activation on screen.
    await deliverPush(port, PICKER_OFF);
    await settle();
    expectPickerOff();

    // The next request is a new activation, armed exactly once.
    await deliverPush(port, serviceTargetRequest());
    await settle();
    expect(pickFlags(port)).toEqual([true, true]);
    await answerLatestPick(port, true);
    await settle();
    expectPickerOn();
  });

  it('changes nothing for a picker push while picker mode is already off', async () => {
    const port = await connectBound();
    renderPanel();
    expectPickerOff();

    await deliverPush(port, PICKER_OFF);
    await settle();

    expectPickerOff();
    expect(pickFlags(port)).toEqual([]);
  });

  it('drops an unreadable picker push, keeping picker mode on and saying an update was ignored', async () => {
    const port = await connectBound();
    renderPanel();
    const user = userEvent.setup();
    await user.click(pickButton());
    await answerLatestPick(port, true);
    await settle();
    expectPickerOn();

    await deliverPush(port, { ...PICKER_OFF, state: { active: 'no' } });
    await settle();

    expect(getPanelSnapshot().target.pickRequested).toBe(true);
    expect(pickButton().getAttribute('aria-pressed')).toBe('true');
    expect(getPanelSnapshot().lastError?.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(pickFlags(port)).toEqual([true]);
  });

  it('releases the toggle and the badge when the worker port is lost, sending nothing back', async () => {
    const port = await connectBound();
    renderPanel();
    const user = userEvent.setup();
    await user.click(pickButton());
    await answerLatestPick(port, true);
    await settle();
    expectPickerOn();

    // The worker is suspended, or dropped this panel: the port closes, and no
    // `picker` push for the page's pick can follow on the next port.
    await act(async () => {
      port.drop();
      await Promise.resolve();
    });
    await settle();

    expect(pickButton().getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByText(PICKER_ON_BADGE)).toBeNull();
    expect(getPanelSnapshot().target.pickRequested).toBe(false);
    // The page's pick ended with the worker's side of it: nothing is asked for.
    expect(pickFlags(port)).toEqual([true]);
  });
});
