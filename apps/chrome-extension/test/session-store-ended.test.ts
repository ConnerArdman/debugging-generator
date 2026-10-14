/**
 * `src/panel/state/session-store.ts` — what the DevTools panel keeps when the
 * session it shows ends.
 *
 * Ending a session unbinds its tab (AAP §0.2.3), and `./connection.ts` resets
 * the store's session scope whenever the tab's binding is lost. What the
 * developer asked for at that moment is the session's outcome — its "Ended"
 * status, its cleanup result (`cleanup.completed` is addressed to DevTools,
 * AAP §0.4.2) and the panel it generated — so these cases pin that
 *
 * - the default reset after a lost binding keeps an ended session's final
 *   state (record, progress, panel, capture, cleanup outcome) and clears only
 *   what needs a live binding: the selection, the pending pick and the last
 *   failure;
 * - a binding loss that overtakes the ended record still keeps it once the
 *   cleanup outcome has arrived, and the ended record applies afterwards;
 * - a live session is still reset on a lost binding, exactly as before;
 * - a hydration answer for the unbound tab, which knows no session, keeps the
 *   ended session and takes only the connection slice;
 * - another session — its binding or its record — replaces the ended one;
 * - the explicit options still discard it, and a repeated release notifies
 *   nobody.
 *
 * Every fixture passes the protocol's own schemas where one exists; ids and
 * copy are neutral synthetic values (AAP §0.5.4).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PANEL_SPEC_VERSION } from '@debuggen/panel-schema';
import { createEnvelope, parseSessionRecord } from '@debuggen/protocol';
import type { MessagePayload, SessionRecord, SessionStatus } from '@debuggen/protocol';

import {
  applyRelayedMessage,
  applySessionSnapshot,
  getPanelSnapshot,
  getSessionId,
  isEndedSessionShown,
  resetPanelStore,
  selectEvent,
  setBindingState,
  setLastError,
  setPendingTarget,
  subscribePanelStore,
} from '../src/panel/state/session-store';
import type { PanelBindingState } from '../src/shared/messages';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAB_ID = 7;
const ORIGIN = 'http://127.0.0.1:20131';
const BOUND_URL = `${ORIGIN}/workspace`;
const SESSION_ID = 'ses_ended0session01';
const OTHER_SESSION_ID = 'ses_next00session02';
const CAPTURE_ID = 'cap_ended0capture01';
const PANEL_ID = 'pnl_ended0panel0001';
const T0 = Date.UTC(2026, 0, 15, 10, 0, 0);

const UNBOUND: PanelBindingState = { kind: 'unbound' };

function bound(sessionId: string): PanelBindingState {
  return { kind: 'bound', sessionId, tabId: TAB_ID, url: BOUND_URL };
}

/** A validated record of `id` in `status`, updated at `updatedAt`. */
function sessionRecord(status: SessionStatus, updatedAt: number, id = SESSION_ID): SessionRecord {
  const parsed = parseSessionRecord({
    id,
    projectRoot: '/workspace/app',
    projectName: 'app',
    devServerUrl: `${ORIGIN}/`,
    createdAt: T0,
    updatedAt,
    status,
    question: 'Why does this view take so long?',
    followUps: [],
    relevantFiles: [],
    plans: [],
    modifications: [],
    captures: [{ id: CAPTURE_ID, planVersion: 1, startedAt: T0, stoppedAt: T0 + 5_000 }],
    panelIds: id === SESSION_ID ? [PANEL_ID] : [],
    analyses: [],
    cleanup:
      status === 'ended'
        ? { status: 'clean', completedAt: updatedAt, conflicts: [] }
        : { status: 'pending', conflicts: [] },
    promptVersions: {},
    provider: { id: 'deterministic' },
  });
  if (!parsed.ok) {
    throw new Error(`The session record fixture is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
}

/** The generated panel of the session under test, as `panel.generated` carries it. */
const PANEL: MessagePayload<'panel.generated'>['panel'] = {
  version: PANEL_SPEC_VERSION,
  id: PANEL_ID,
  sessionId: SESSION_ID,
  panelVersion: 1,
  title: 'Where the view spends its time',
  summary: { observed: [], likelyCauses: [] },
  layout: [],
};

function relayUpdated(session: SessionRecord): void {
  applyRelayedMessage(createEnvelope('session.updated', { session }));
}

function relayCleanup(): void {
  applyRelayedMessage(
    createEnvelope('cleanup.completed', { sessionId: SESSION_ID, status: 'clean', conflicts: [] }),
  );
}

/**
 * The session under test bound, generated, with a progress row, its panel, a
 * selected event, a pending pick and a last failure — everything a panel holds
 * the moment its session is ended.
 */
function generatedAndBound(): void {
  setBindingState(bound(SESSION_ID));
  relayUpdated(sessionRecord('generated', T0 + 10_000));
  applyRelayedMessage(
    createEnvelope('session.progress', {
      sessionId: SESSION_ID,
      stage: 'understand',
      status: 'done',
      message: 'Understanding problem',
    }),
  );
  applyRelayedMessage(
    createEnvelope('panel.generated', { sessionId: SESSION_ID, panelId: PANEL_ID, panel: PANEL }),
  );
  selectEvent({ eventId: 'evt_selected00000001' });
  setPendingTarget({
    selector: 'main > button',
    tagName: 'button',
    componentChain: [],
    url: BOUND_URL,
  });
  setLastError({ code: 'TRANSPORT_DISCONNECTED', message: 'A request did not complete.' });
}

/** The session end as the panel receives it: cleanup, the ended record, then the lost binding. */
function endSession(): void {
  relayCleanup();
  relayUpdated(sessionRecord('ended', T0 + 20_000));
  loseBinding();
}

/** What `./connection.ts` does when the binding moves to a non-bound kind. */
function loseBinding(): void {
  setBindingState(UNBOUND);
  resetPanelStore();
}

beforeEach(() => {
  resetPanelStore({ includeConnection: true });
});

afterEach(() => {
  resetPanelStore({ includeConnection: true });
});

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('session-store — an ended session stays on screen', () => {
  it('keeps the final state after the lost binding, clearing only what needs a binding', () => {
    generatedAndBound();
    const before = getPanelSnapshot();

    endSession();

    const after = getPanelSnapshot();
    expect(after.connection.binding).toEqual(UNBOUND);
    expect(after.session?.id).toBe(SESSION_ID);
    expect(after.session?.status).toBe('ended');
    expect(after.panel?.spec).toBe(PANEL);
    expect(after.progress).toBe(before.progress);
    expect(after.capture).toBe(before.capture);
    expect(after.instrumentation).toBe(before.instrumentation);
    expect(after.cleanup).toEqual({ status: 'clean', conflicts: [] });
    expect(after.selectedEvent).toBeUndefined();
    expect(after.target).toEqual({ pending: undefined, pickRequested: false });
    expect(after.lastError).toBeUndefined();
    expect(getSessionId()).toBe(SESSION_ID);
  });

  it('keeps it when the lost binding overtakes the ended record, once cleanup was reported', () => {
    generatedAndBound();
    relayCleanup();

    loseBinding();
    expect(getPanelSnapshot().session?.status).toBe('generated');
    expect(getPanelSnapshot().panel?.spec).toBe(PANEL);

    relayUpdated(sessionRecord('ended', T0 + 20_000));
    expect(getPanelSnapshot().session?.status).toBe('ended');
    expect(getPanelSnapshot().panel?.spec).toBe(PANEL);
  });

  it('still resets a live session when its binding is lost', () => {
    generatedAndBound();

    loseBinding();

    const after = getPanelSnapshot();
    expect(after.session).toBeUndefined();
    expect(after.panel).toBeUndefined();
    expect(after.progress).toEqual([]);
    expect(getSessionId()).toBeUndefined();
  });

  it('keeps it across a hydration answer that knows no session, taking the connection slice', () => {
    generatedAndBound();
    endSession();
    const before = getPanelSnapshot();

    applySessionSnapshot({
      connection: { status: 'connected', serviceUrl: 'http://127.0.0.1:43117' },
      binding: UNBOUND,
    });

    const after = getPanelSnapshot();
    expect(after.connection.status).toBe('connected');
    expect(after.session).toBe(before.session);
    expect(after.panel).toBe(before.panel);
    expect(after.cleanup).toBe(before.cleanup);
    expect(after.progress).toBe(before.progress);
  });

  it('is replaced by a binding to another session', () => {
    generatedAndBound();
    endSession();

    setBindingState(bound(OTHER_SESSION_ID));

    const after = getPanelSnapshot();
    expect(after.session).toBeUndefined();
    expect(after.panel).toBeUndefined();
    expect(after.cleanup).toBeUndefined();
    expect(getSessionId()).toBe(OTHER_SESSION_ID);
  });

  it("is replaced by another session's record while the tab is unbound", () => {
    generatedAndBound();
    endSession();

    relayUpdated(sessionRecord('ready', T0 + 30_000, OTHER_SESSION_ID));

    const after = getPanelSnapshot();
    expect(after.session?.id).toBe(OTHER_SESSION_ID);
    expect(after.panel).toBeUndefined();
    expect(after.cleanup).toBeUndefined();
  });

  it("drops another session's panel while the ended one is shown", () => {
    generatedAndBound();
    endSession();
    const before = getPanelSnapshot();

    applyRelayedMessage(
      createEnvelope('panel.generated', {
        sessionId: OTHER_SESSION_ID,
        panelId: 'pnl_next00panel00002',
        panel: { ...PANEL, id: 'pnl_next00panel00002', sessionId: OTHER_SESSION_ID },
      }),
    );

    expect(getPanelSnapshot()).toBe(before);
  });

  it('notifies nobody for a repeated release of the ended session', () => {
    generatedAndBound();
    endSession();
    const before = getPanelSnapshot();
    let notified = 0;
    const stop = subscribePanelStore(() => {
      notified += 1;
    });

    loseBinding();

    expect(getPanelSnapshot()).toBe(before);
    expect(notified).toBe(0);
    stop();
  });

  it('is discarded by discardEndedSession, and by the pristine reset', () => {
    generatedAndBound();
    endSession();

    resetPanelStore({ discardEndedSession: true });
    expect(getPanelSnapshot().session).toBeUndefined();
    expect(getPanelSnapshot().panel).toBeUndefined();
    expect(getPanelSnapshot().connection.binding).toEqual(UNBOUND);

    generatedAndBound();
    endSession();
    resetPanelStore({ includeConnection: true });
    expect(getPanelSnapshot().session).toBeUndefined();
    expect(getPanelSnapshot().connection.status).toBe('reconnecting');
    expect(getPanelSnapshot().connection.binding).toEqual(UNBOUND);
  });
});

describe('session-store — isEndedSessionShown', () => {
  it('is false for a live, bound session and for an unknown session', () => {
    generatedAndBound();

    expect(isEndedSessionShown(SESSION_ID)).toBe(false);
    expect(isEndedSessionShown(OTHER_SESSION_ID)).toBe(false);
  });

  it('is false while the ended session is still bound', () => {
    generatedAndBound();
    relayCleanup();
    relayUpdated(sessionRecord('ended', T0 + 20_000));

    expect(getPanelSnapshot().connection.binding.kind).toBe('bound');
    expect(isEndedSessionShown(SESSION_ID)).toBe(false);
  });

  it('is true for the ended session on screen once its binding is lost, and only for it', () => {
    generatedAndBound();
    endSession();

    expect(isEndedSessionShown(SESSION_ID)).toBe(true);
    expect(isEndedSessionShown(OTHER_SESSION_ID)).toBe(false);
  });

  it('is true when the lost binding overtakes the ended record, once cleanup was reported', () => {
    generatedAndBound();
    relayCleanup();
    loseBinding();

    expect(getPanelSnapshot().session?.status).toBe('generated');
    expect(isEndedSessionShown(SESSION_ID)).toBe(true);
  });

  it('is false again once another session replaces the ended one', () => {
    generatedAndBound();
    endSession();

    setBindingState(bound(OTHER_SESSION_ID));

    expect(isEndedSessionShown(SESSION_ID)).toBe(false);
    expect(isEndedSessionShown(OTHER_SESSION_ID)).toBe(false);
  });
});
