/**
 * The DevTools panel store's capture notices (`src/panel/state/session-store.ts`).
 *
 * AAP §0.5.5 requires that an application reloading mid-session leaves an event-log entry "Page
 * reloaded during capture" while the same capture continues. The service announces a kept
 * same-origin navigation of the bound tab with a `session.bound` frame whose reason is
 * `'navigated'`; the store turns that frame into a capture-scoped `page-reloaded` notice in its
 * `tailNotices` slice — only for this panel's binding, only while a capture runs, and exactly once
 * per announcement.
 *
 * The store is driven exactly as `src/panel/state/connection.ts` drives it: protocol envelopes
 * minted by the protocol's own `createEnvelope` go through `applyRelayedMessage`, the binding line
 * through `setBindingState`, and a `session.snapshot` answer through `applySessionSnapshot`.
 * Every case starts from the pristine store (`resetPanelStore({ includeConnection: true })`), so
 * no case depends on another's leftovers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEnvelope, parseSessionRecord } from '@debuggen/protocol';
import type { MessageByType, MessagePayload, SessionRecord } from '@debuggen/protocol';
import { newCaptureId, newMessageId, newSessionId } from '@debuggen/shared';
import type { CaptureId, MessageId, SessionId } from '@debuggen/shared';
import { computeCaptureSummary } from '@debuggen/telemetry';

import {
  LIVE_TAIL_MAX_NOTICES,
  applyRelayedMessage,
  applySessionSnapshot,
  getPanelSnapshot,
  resetPanelStore,
  setBindingState,
} from '../src/panel/state/session-store';
import type { PanelSnapshot } from '../src/panel/state/session-store';
import type { PanelBindingState } from '../src/shared/messages';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The inspected tab. */
const TAB_ID = 7;

/** Another tab of the same browser. */
const OTHER_TAB_ID = 8;

/** The session's dev-server origin. */
const ORIGIN = 'http://127.0.0.1:20131';

/** The document the tab was bound on. */
const BOUND_URL = `${ORIGIN}/products`;

/** A second page of the same application, reached by a same-origin navigation. */
const NEXT_URL = `${ORIGIN}/cart?coupon=?`;

/** A plausible epoch-millisecond clock origin, so every timestamp passes `epochMsSchema`. */
const T0 = Date.UTC(2026, 0, 15, 10, 0, 0);

/** The session under test and a second one. */
let sessionId: SessionId;
let otherSessionId: SessionId;

/** The capture under test and a second one. */
let captureId: CaptureId;
let nextCaptureId: CaptureId;

/** A `bound` binding of `tabId` to `session`. */
function bound(session: SessionId, tabId: number, url: string): PanelBindingState {
  return { kind: 'bound', sessionId: session, tabId, url };
}

/** Relay a `session.bound` frame and return the envelope, so a case can redeliver it verbatim. */
function relayBound(
  payload: MessagePayload<'session.bound'>,
  ts: number,
  id: MessageId = newMessageId(),
): MessageByType<'session.bound'> {
  const envelope = createEnvelope('session.bound', payload, { ts, id });
  applyRelayedMessage(envelope);
  return envelope;
}

/** Relay `capture.started` for `capture` of the session under test. */
function relayCaptureStarted(capture: CaptureId, ts: number): void {
  applyRelayedMessage(createEnvelope('capture.started', { sessionId, captureId: capture }, { ts }));
}

/** Relay `capture.stopped` for `capture` of the session under test, with a real empty summary. */
function relayCaptureStopped(capture: CaptureId, ts: number): void {
  const summary = computeCaptureSummary([], { captureId: capture, sessionId });
  applyRelayedMessage(
    createEnvelope('capture.stopped', { sessionId, captureId: capture, summary }, { ts }),
  );
}

/**
 * A validated session record whose latest capture is `capture`, still running — built through the
 * protocol's own `parseSessionRecord`, so the fixture is a record the service could have sent.
 */
function sessionRecord(capture: CaptureId): SessionRecord {
  const parsed = parseSessionRecord({
    id: sessionId,
    projectRoot: '/workspace/app',
    projectName: 'app',
    devServerUrl: `${ORIGIN}/`,
    boundTab: { tabId: TAB_ID, url: BOUND_URL },
    createdAt: T0,
    updatedAt: T0,
    status: 'capturing',
    question: 'Why is this button slow?',
    followUps: [],
    relevantFiles: [],
    plans: [],
    modifications: [],
    captures: [{ id: capture, planVersion: 1, startedAt: T0 }],
    panelIds: [],
    analyses: [],
    cleanup: { status: 'pending', conflicts: [] },
    promptVersions: {},
    provider: { id: 'deterministic' },
  });
  if (!parsed.ok) {
    throw new Error(`The session record fixture is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
}

/** Bind the tab to the session under test and start `captureId`: the state a reload happens in. */
function bindAndCapture(): void {
  setBindingState(bound(sessionId, TAB_ID, BOUND_URL));
  relayCaptureStarted(captureId, T0 + 1_000);
}

/** The store's notices right now. */
function notices(): PanelSnapshot['tailNotices'] {
  return getPanelSnapshot().tailNotices;
}

beforeEach(() => {
  resetPanelStore({ includeConnection: true });
  sessionId = newSessionId();
  otherSessionId = newSessionId();
  captureId = newCaptureId();
  nextCaptureId = newCaptureId();
});

afterEach(() => {
  resetPanelStore({ includeConnection: true });
});

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

describe('session.bound navigated → page-reloaded notice', () => {
  it('records nothing for an ordinary navigation outside a capture, but still moves the binding', () => {
    setBindingState(bound(sessionId, TAB_ID, BOUND_URL));

    relayBound({ sessionId, tabId: TAB_ID, url: NEXT_URL, reason: 'navigated' }, T0 + 2_000);

    expect(notices()).toEqual([]);
    expect(getPanelSnapshot().connection.binding).toEqual(bound(sessionId, TAB_ID, NEXT_URL));
  });

  it('records exactly one notice carrying the running capture id during a capture', () => {
    bindAndCapture();

    const envelope = relayBound(
      { sessionId, tabId: TAB_ID, url: NEXT_URL, reason: 'navigated' },
      T0 + 2_000,
    );

    expect(notices()).toEqual([
      {
        id: envelope.id,
        kind: 'page-reloaded',
        captureId,
        tabId: TAB_ID,
        url: NEXT_URL,
        ts: T0 + 2_000,
      },
    ]);
    // The same capture continues: nothing about the capture window changed.
    expect(getPanelSnapshot().capture.active).toBe(true);
    expect(getPanelSnapshot().capture.captureId).toBe(captureId);
    // The binding moved to the new document in the same commit.
    expect(getPanelSnapshot().connection.binding).toEqual(bound(sessionId, TAB_ID, NEXT_URL));
  });

  it('records a reload of the same document, whose binding does not change', () => {
    bindAndCapture();
    const before = getPanelSnapshot();

    relayBound({ sessionId, tabId: TAB_ID, url: BOUND_URL, reason: 'navigated' }, T0 + 2_000);

    const after = getPanelSnapshot();
    expect(after.tailNotices).toHaveLength(1);
    expect(after.tailNotices[0]?.url).toBe(BOUND_URL);
    // Only the notices slice changed: every other slice keeps its reference.
    expect(after.connection).toBe(before.connection);
    expect(after.capture).toBe(before.capture);
    expect(after.liveTail).toBe(before.liveTail);
    expect(after.progress).toBe(before.progress);
  });

  it('adds nothing when the identical frame is delivered again, and keeps the snapshot', () => {
    bindAndCapture();
    const envelope = relayBound(
      { sessionId, tabId: TAB_ID, url: NEXT_URL, reason: 'navigated' },
      T0 + 2_000,
    );
    const before = getPanelSnapshot();

    applyRelayedMessage(envelope);

    expect(notices()).toHaveLength(1);
    expect(getPanelSnapshot()).toBe(before);
  });

  it('adds nothing for a redelivery under a new frame id with identical content', () => {
    bindAndCapture();
    relayBound({ sessionId, tabId: TAB_ID, url: NEXT_URL, reason: 'navigated' }, T0 + 2_000);
    const before = getPanelSnapshot();

    relayBound({ sessionId, tabId: TAB_ID, url: NEXT_URL, reason: 'navigated' }, T0 + 2_000);

    expect(notices()).toHaveLength(1);
    expect(getPanelSnapshot()).toBe(before);
  });

  it('records a second reload as a second notice, oldest first', () => {
    bindAndCapture();

    relayBound({ sessionId, tabId: TAB_ID, url: NEXT_URL, reason: 'navigated' }, T0 + 2_000);
    relayBound({ sessionId, tabId: TAB_ID, url: NEXT_URL, reason: 'navigated' }, T0 + 3_000);

    expect(notices().map((notice) => notice.ts)).toEqual([T0 + 2_000, T0 + 3_000]);
    expect(notices().every((notice) => notice.captureId === captureId)).toBe(true);
  });

  it('keeps only the newest LIVE_TAIL_MAX_NOTICES notices', () => {
    bindAndCapture();

    for (let index = 0; index <= LIVE_TAIL_MAX_NOTICES; index += 1) {
      relayBound(
        { sessionId, tabId: TAB_ID, url: NEXT_URL, reason: 'navigated' },
        T0 + 2_000 + index,
      );
    }

    expect(notices()).toHaveLength(LIVE_TAIL_MAX_NOTICES);
    expect(notices()[0]?.ts).toBe(T0 + 2_001);
    expect(notices().at(-1)?.ts).toBe(T0 + 2_000 + LIVE_TAIL_MAX_NOTICES);
    expect(Object.isFrozen(notices())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What is not a reload of this panel's capture
// ---------------------------------------------------------------------------

describe('announcements that record no notice', () => {
  it.each([['bound' as const], [undefined]])(
    'records nothing for an establishment or re-announcement (reason %s)',
    (reason) => {
      bindAndCapture();

      relayBound(
        reason === undefined
          ? { sessionId, tabId: TAB_ID, url: NEXT_URL }
          : { sessionId, tabId: TAB_ID, url: NEXT_URL, reason },
        T0 + 2_000,
      );

      expect(notices()).toEqual([]);
      expect(getPanelSnapshot().connection.binding).toEqual(bound(sessionId, TAB_ID, NEXT_URL));
    },
  );

  it.each([['replaced' as const], ['origin-changed' as const], ['unbound' as const]])(
    'records nothing when the binding ends (reason %s)',
    (reason) => {
      bindAndCapture();

      relayBound({ sessionId, tabId: TAB_ID, url: NEXT_URL, reason }, T0 + 2_000);

      expect(notices()).toEqual([]);
    },
  );

  it('records nothing once the capture has stopped', () => {
    bindAndCapture();
    relayCaptureStopped(captureId, T0 + 1_500);

    relayBound({ sessionId, tabId: TAB_ID, url: NEXT_URL, reason: 'navigated' }, T0 + 2_000);

    expect(notices()).toEqual([]);
  });

  it("records nothing for another tab's navigation, and leaves the snapshot alone", () => {
    bindAndCapture();
    const before = getPanelSnapshot();

    relayBound({ sessionId, tabId: OTHER_TAB_ID, url: NEXT_URL, reason: 'navigated' }, T0 + 2_000);

    expect(getPanelSnapshot()).toBe(before);
    expect(notices()).toEqual([]);
  });

  it("records nothing for another session's navigation of this tab: the session changed", () => {
    bindAndCapture();

    relayBound(
      { sessionId: otherSessionId, tabId: TAB_ID, url: NEXT_URL, reason: 'navigated' },
      T0 + 2_000,
    );

    const snapshot = getPanelSnapshot();
    expect(snapshot.tailNotices).toEqual([]);
    // The change of session identity reset the previous session's capture.
    expect(snapshot.capture.active).toBe(false);
    expect(snapshot.connection.binding).toEqual(bound(otherSessionId, TAB_ID, NEXT_URL));
  });
});

// ---------------------------------------------------------------------------
// The notices' lifetime: capture-scoped, like the tail
// ---------------------------------------------------------------------------

describe('notice lifetime', () => {
  it('clears the notices when a new capture starts, and keeps them on a replayed start', () => {
    bindAndCapture();
    relayBound({ sessionId, tabId: TAB_ID, url: NEXT_URL, reason: 'navigated' }, T0 + 2_000);

    relayCaptureStarted(captureId, T0 + 2_500);
    expect(notices()).toHaveLength(1);

    relayCaptureStopped(captureId, T0 + 3_000);
    relayCaptureStarted(nextCaptureId, T0 + 4_000);
    expect(notices()).toEqual([]);
  });

  it('keeps the notices when the capture stops', () => {
    bindAndCapture();
    relayBound({ sessionId, tabId: TAB_ID, url: NEXT_URL, reason: 'navigated' }, T0 + 2_000);

    relayCaptureStopped(captureId, T0 + 3_000);

    expect(getPanelSnapshot().capture.active).toBe(false);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]?.captureId).toBe(captureId);
  });

  it('clears the notices on resetPanelStore, with or without the connection slice', () => {
    bindAndCapture();
    relayBound({ sessionId, tabId: TAB_ID, url: NEXT_URL, reason: 'navigated' }, T0 + 2_000);

    resetPanelStore();
    expect(notices()).toEqual([]);

    bindAndCapture();
    relayBound({ sessionId, tabId: TAB_ID, url: NEXT_URL, reason: 'navigated' }, T0 + 3_000);
    resetPanelStore({ includeConnection: true });
    expect(notices()).toEqual([]);
  });

  it('clears the notices when the binding moves to another session', () => {
    bindAndCapture();
    relayBound({ sessionId, tabId: TAB_ID, url: NEXT_URL, reason: 'navigated' }, T0 + 2_000);

    setBindingState(bound(otherSessionId, TAB_ID, NEXT_URL));

    expect(notices()).toEqual([]);
  });

  it('keeps the notices across a hydration of the same capture and clears them for another', () => {
    bindAndCapture();
    relayBound({ sessionId, tabId: TAB_ID, url: NEXT_URL, reason: 'navigated' }, T0 + 2_000);
    const connection = { status: 'connected' as const };
    const binding = bound(sessionId, TAB_ID, NEXT_URL);

    applySessionSnapshot({ session: sessionRecord(captureId), connection, binding });
    expect(notices()).toHaveLength(1);

    applySessionSnapshot({ session: sessionRecord(nextCaptureId), connection, binding });
    expect(getPanelSnapshot().capture.captureId).toBe(nextCaptureId);
    expect(notices()).toEqual([]);
  });

  it('notifies nobody and keeps the snapshot for a reset of an already pristine store', () => {
    const before = getPanelSnapshot();

    resetPanelStore({ includeConnection: true });

    expect(getPanelSnapshot()).toBe(before);
    expect(before.tailNotices).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A binding answers the refusal that no session served the origin
// ---------------------------------------------------------------------------

/** Relay a session-less `error` frame, as the service answers a refused bind. */
function relayError(code: MessagePayload<'error'>['code'], ts: number): void {
  applyRelayedMessage(
    createEnvelope('error', { code, message: 'The request was refused.' }, { ts }),
  );
}

describe('a binding answers the refusal that no session served the origin', () => {
  it('clears the no-session refusal once the tab binds, as when the open panel is sent its new session', () => {
    relayError('SESSION_NOT_FOUND', T0);
    expect(getPanelSnapshot().lastError?.code).toBe('SESSION_NOT_FOUND');

    setBindingState(bound(sessionId, TAB_ID, BOUND_URL));

    expect(getPanelSnapshot().connection.binding).toEqual(bound(sessionId, TAB_ID, BOUND_URL));
    expect(getPanelSnapshot().lastError).toBeUndefined();
  });

  it('keeps any other failure across the binding', () => {
    relayError('TRANSPORT_DISCONNECTED', T0);

    setBindingState(bound(sessionId, TAB_ID, BOUND_URL));

    expect(getPanelSnapshot().lastError?.code).toBe('TRANSPORT_DISCONNECTED');
  });

  it('keeps the refusal while the tab stays unbound or away', () => {
    relayError('SESSION_NOT_FOUND', T0);

    setBindingState({ kind: 'unbound' });
    expect(getPanelSnapshot().lastError?.code).toBe('SESSION_NOT_FOUND');

    setBindingState({ kind: 'tab-left', origin: ORIGIN, sessionId });
    expect(getPanelSnapshot().lastError?.code).toBe('SESSION_NOT_FOUND');
  });
});
