/**
 * Component spec for `../src/panel/App.tsx`'s picker mode — the half of the
 * element-selection contract the panel owns (AAP §0.4.2: the service's
 * `target.request` "asks the panel to enter picker mode"; §0.7.3: "Pick
 * element" toggles picker mode; §0.5.5: a failure is never shown as success):
 *
 * - **The panel is the one arming authority.** A relayed `target.request`
 *   raises the store's `target.pickRequested`, and the panel arms that picker
 *   mode exactly as "Pick element" does — one `target.pick { enabled: true }`
 *   per activation. The worker arms nothing on its own.
 * - **A request that armed nothing never looks armed.** When the worker
 *   refuses (`AGENT_NOT_READY`: no page agent), answers inactive, or the
 *   request is lost, the panel leaves picker mode again and records the reason
 *   as its `lastError` — but only while that activation is still the one on
 *   screen.
 * - **No double arming.** When the panel's own toggle turned picker mode on, a
 *   `target.request` arriving meanwhile sends no second `target.pick`; once
 *   picker mode is off, the next request is a new activation and is armed.
 * - **A pick awaiting confirmation holds both controls.** While the optimistic
 *   target the panel shows is not yet confirmed by a session record, "Pick
 *   element" and "Use selected element" are busy and ignore presses; the
 *   confirming record frees them.
 *
 * **Harness.** Collected into the `chrome-extension` Vitest project
 * (happy-dom). `App` is rendered whole, against the real session store, with
 * `../src/panel/state/connection` mocked by `vi.mock`: `panelRequest` is a
 * recording mock, and `startPanelConnection` / `getPanelConnection` /
 * `onPortDisconnect` are inert, so no runtime port exists. `chrome.devtools`
 * is stubbed with an inspected tab id only for the case that presses "Pick
 * element", which DevTools-less documents render unavailable. Ids and URLs
 * are neutral synthetic values (AAP §0.5.4).
 */

import { createEnvelope, parseSessionRecord } from '@debuggen/protocol';
import type { SelectedTarget, SessionRecord } from '@debuggen/protocol';
import { DebuggenError, isErr } from '@debuggen/shared';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/panel/App';
import type * as ConnectionModule from '../src/panel/state/connection';
import {
  applyRelayedMessage,
  getPanelSnapshot,
  resetPanelStore,
  setBindingState,
  setPendingTarget,
} from '../src/panel/state/session-store';
import type { PortRequestKind } from '../src/shared/messages';

/*
 * ===========================================================================
 * The mocked panel connection
 * ===========================================================================
 */

/** One request the panel made through `panelRequest`. */
interface RecordedRequest {
  readonly kind: PortRequestKind;
  readonly payload: unknown;
}

/** The recording stand-ins for the connection module's exports. */
const port = vi.hoisted(() => ({
  panelRequest: vi.fn<(kind: PortRequestKind, payload: unknown) => Promise<unknown>>(),
  resync: vi.fn<() => void>(),
  stop: vi.fn<() => void>(),
}));

vi.mock('../src/panel/state/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionModule>();
  const inert = (): void => undefined;
  return {
    ...actual,
    panelRequest: port.panelRequest,
    onPortDisconnect: () => inert,
    getPanelConnection: () => ({
      request: port.panelRequest,
      onPortDisconnect: () => inert,
      resync: port.resync,
      getInspectedTabId: () => undefined,
      isRunning: () => true,
    }),
    startPanelConnection: () => ({
      request: port.panelRequest,
      onPortDisconnect: () => inert,
      resync: port.resync,
      getInspectedTabId: () => undefined,
      isRunning: () => true,
      stop: port.stop,
    }),
  };
});

/*
 * ===========================================================================
 * Fixtures
 * ===========================================================================
 */

/** The session bound to the inspected tab. */
const SESSION = 'ses_4k2p9dq7m1zx0c3v';

/** The inspected tab. */
const TAB = 41;

/** The inspected document. */
const APP_URL = 'http://localhost:4100/workspace/overview';

/** What the worker answers `target.pick` with when no page agent is connected. */
const AGENT_MISSING = new DebuggenError(
  'AGENT_NOT_READY',
  'The Debug Generator page agent is not running on the inspected page, so picker mode is unavailable.',
);

/** An element the service confirms as the target while an arming is in flight. */
const CONFIRMED: SelectedTarget = Object.freeze({
  selector: 'main > section.toolbar > button.save',
  tagName: 'BUTTON',
  componentChain: ['SaveButton'],
  url: APP_URL,
});

/** A session record of {@link SESSION}, validated by the protocol's schema. */
function sessionRecord(target?: SelectedTarget): SessionRecord {
  const parsed = parseSessionRecord({
    id: SESSION,
    projectRoot: '/home/example/workspace/site',
    projectName: 'site',
    devServerUrl: 'http://localhost:4100',
    createdAt: 1_758_000_000_000,
    updatedAt: 1_758_000_001_000,
    status: 'created',
    question: 'Why does this action take so long?',
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
    ...(target === undefined ? {} : { target }),
  });
  if (isErr(parsed)) {
    throw new Error(`the session record fixture is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
}

/** A promise settled by the case, for an answer it releases at a chosen moment. */
function controlled<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((fulfil, fail) => {
    resolve = fulfil;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Whether a recorded `target.pick` payload turns picker mode on. */
function isEnabling(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'enabled' in payload &&
    payload.enabled === true
  );
}

/** The `target.pick` requests the panel made, in order. */
function pickRequests(): RecordedRequest[] {
  return port.panelRequest.mock.calls
    .map(([kind, payload]): RecordedRequest => ({ kind, payload }))
    .filter((request) => request.kind === 'target.pick');
}

/** Deliver the service's relayed `target.request` for {@link SESSION}, as the connection does. */
async function serviceRequestsTarget(): Promise<void> {
  await act(async () => {
    applyRelayedMessage(createEnvelope('target.request', { sessionId: SESSION }));
    await Promise.resolve();
  });
}

/** Let every pending continuation — an answered request and its effects — run inside `act`. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

/** Render the panel with the inspected tab bound to {@link SESSION}. */
function renderBoundPanel(): void {
  setBindingState({ kind: 'bound', sessionId: SESSION, tabId: TAB, url: APP_URL });
  render(<App theme="dark" />);
}

/** The "Pick element" control. */
function pickButton(): HTMLElement {
  return screen.getByRole('button', { name: /Pick element/ });
}

/** The "Use selected element" control. */
function useSelectedButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Use selected element' });
}

/*
 * ===========================================================================
 * Suite
 * ===========================================================================
 */

beforeEach(() => {
  resetPanelStore({ includeConnection: true });
  port.panelRequest.mockReset();
  port.resync.mockReset();
  port.stop.mockReset();
});

afterEach(() => {
  cleanup();
  resetPanelStore({ includeConnection: true });
  vi.unstubAllGlobals();
});

describe("the panel arms the service's picker request", () => {
  it('sends exactly one target.pick { enabled: true } for a relayed target.request', async () => {
    port.panelRequest.mockResolvedValue({ active: true });
    renderBoundPanel();
    expect(pickRequests()).toHaveLength(0);

    await serviceRequestsTarget();
    await settle();

    expect(pickRequests()).toEqual([
      { kind: 'target.pick', payload: { sessionId: SESSION, enabled: true } },
    ]);
    expect(getPanelSnapshot().target.pickRequested).toBe(true);
    expect(getPanelSnapshot().lastError).toBeUndefined();
    expect(pickButton().getAttribute('aria-pressed')).toBe('true');

    // A repeated request while picker mode is on is the same activation.
    await serviceRequestsTarget();
    await settle();
    expect(pickRequests()).toHaveLength(1);
  });

  it('leaves picker mode and records the failure when the worker answers AGENT_NOT_READY', async () => {
    port.panelRequest.mockRejectedValue(AGENT_MISSING);
    renderBoundPanel();

    await serviceRequestsTarget();
    await settle();

    expect(pickRequests()).toHaveLength(1);
    expect(getPanelSnapshot().target.pickRequested).toBe(false);
    expect(getPanelSnapshot().lastError).toEqual({
      code: 'AGENT_NOT_READY',
      message: `Could not change picker mode: ${AGENT_MISSING.message}`,
    });
    expect(pickButton().getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText(`Could not change picker mode: ${AGENT_MISSING.message}`)).toBeTruthy();
  });

  it('leaves picker mode when the worker answers it inactive, and says so', async () => {
    port.panelRequest.mockResolvedValue({ active: false });
    renderBoundPanel();

    await serviceRequestsTarget();
    await settle();

    expect(getPanelSnapshot().target.pickRequested).toBe(false);
    expect(getPanelSnapshot().lastError).toEqual({
      code: 'AGENT_NOT_READY',
      message:
        'Could not change picker mode: the inspected page did not enter picker mode. Reload the application page, or select the element in the Elements panel and press "Use selected element".',
    });
  });

  it('records a lost arming request under the fallback AGENT_NOT_READY code', async () => {
    port.panelRequest.mockRejectedValue(new Error('the port went away'));
    renderBoundPanel();

    await serviceRequestsTarget();
    await settle();

    expect(getPanelSnapshot().target.pickRequested).toBe(false);
    expect(getPanelSnapshot().lastError?.code).toBe('AGENT_NOT_READY');
  });

  it('changes nothing when the arming fails after picker mode already moved on', async () => {
    const answer = controlled<unknown>();
    port.panelRequest.mockReturnValue(answer.promise);
    renderBoundPanel();

    await serviceRequestsTarget();
    expect(pickRequests()).toHaveLength(1);

    // The service confirms a target meanwhile, which ends picker mode.
    await act(async () => {
      applyRelayedMessage(createEnvelope('session.updated', { session: sessionRecord(CONFIRMED) }));
      await Promise.resolve();
    });
    expect(getPanelSnapshot().target.pickRequested).toBe(false);

    await act(async () => {
      answer.reject(AGENT_MISSING);
      await answer.promise.catch(() => undefined);
    });
    await settle();

    expect(getPanelSnapshot().target.pickRequested).toBe(false);
    expect(getPanelSnapshot().lastError).toBeUndefined();
  });
});

describe('the panel never arms one activation twice', () => {
  it('sends no second target.pick when its own toggle turned picker mode on, and arms the next activation', async () => {
    vi.stubGlobal('chrome', { devtools: { inspectedWindow: { tabId: TAB } } });
    // The worker's answer to a toggle: picker mode as requested.
    port.panelRequest.mockImplementation((kind, payload) =>
      Promise.resolve(kind === 'target.pick' ? { active: isEnabling(payload) } : {}),
    );
    renderBoundPanel();
    const user = userEvent.setup();

    // "Pick element": the toggle arms its own activation.
    await user.click(pickButton());
    await settle();
    expect(pickRequests()).toEqual([
      { kind: 'target.pick', payload: { sessionId: SESSION, enabled: true } },
    ]);
    expect(getPanelSnapshot().target.pickRequested).toBe(true);

    // The service's request arrives while that activation is on: no second arm.
    await serviceRequestsTarget();
    await settle();
    expect(pickRequests()).toHaveLength(1);

    // Off again, through the toggle.
    await user.click(pickButton());
    await settle();
    expect(getPanelSnapshot().target.pickRequested).toBe(false);
    expect(pickRequests().at(-1)).toEqual({
      kind: 'target.pick',
      payload: { sessionId: SESSION, enabled: false },
    });

    // The next service request is a new activation, armed once.
    await serviceRequestsTarget();
    await settle();
    expect(pickRequests().filter((request) => isEnabling(request.payload))).toHaveLength(2);
    expect(getPanelSnapshot().target.pickRequested).toBe(true);
    expect(getPanelSnapshot().lastError).toBeUndefined();
  });
});

describe('a pick awaiting its confirming record', () => {
  it('holds both controls busy until the session record confirms it, then frees them', async () => {
    vi.stubGlobal('chrome', { devtools: { inspectedWindow: { tabId: TAB } } });
    port.panelRequest.mockImplementation((kind, payload) =>
      Promise.resolve(kind === 'target.pick' ? { active: isEnabling(payload) } : {}),
    );
    renderBoundPanel();
    const user = userEvent.setup();

    // The optimistic pick on screen: accepted, but not yet confirmed by a record.
    act(() => {
      setPendingTarget(CONFIRMED);
    });
    for (const control of [pickButton(), useSelectedButton()]) {
      expect(control.getAttribute('aria-busy')).toBe('true');
      expect(control.getAttribute('aria-disabled')).toBe('true');
    }
    expect(screen.getByText('Updating the session target.')).toBeTruthy();
    await user.click(pickButton());
    await settle();
    expect(pickRequests()).toHaveLength(0);

    // The record confirming the pick clears it, and with it the busy state.
    await act(async () => {
      applyRelayedMessage(createEnvelope('session.updated', { session: sessionRecord(CONFIRMED) }));
      await Promise.resolve();
    });
    expect(getPanelSnapshot().target.pending).toBeUndefined();
    for (const control of [pickButton(), useSelectedButton()]) {
      expect(control.getAttribute('aria-busy')).toBeNull();
      expect(control.getAttribute('aria-disabled')).toBeNull();
    }
    await user.click(pickButton());
    await settle();
    expect(pickRequests()).toEqual([
      { kind: 'target.pick', payload: { sessionId: SESSION, enabled: true } },
    ]);
  });
});
