/**
 * `src/panel/state/session-store.ts` — how the DevTools panel applies the whole
 * session record every `session.created` / `session.updated` frame carries
 * (AAP §0.4.2).
 *
 * Every frame is the complete record, so the store's job on receipt is to keep
 * the newest one and notify subscribers only when something changed. These
 * cases pin that rule: a newer record replaces the held one; an older record of
 * the same session — the service worker's stored snapshot racing a live push —
 * and the very object already held are dropped without a notification; a record
 * with an equal `updatedAt` is applied, because two writes can share a
 * millisecond.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEnvelope } from '@debuggen/protocol';
import type { SessionRecord } from '@debuggen/protocol';

import {
  applyRelayedMessage,
  getPanelSnapshot,
  resetPanelStore,
  subscribePanelStore,
} from '../src/panel/state/session-store';

/** The session every case applies records of. */
const SESSION_ID = 'ses_4k2p9dq7m1zx0c3v';

/** A second session, for the identity-change case. */
const OTHER_SESSION_ID = 'ses_9m3q7w1e5r2t8y4u';

/** A fixed point in time, so no assertion depends on the clock. */
const START_TIME = 1_758_000_000_000;

/** A minimal valid session record, updated at `updatedAt`. */
function record(updatedAt: number, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SESSION_ID,
    projectRoot: '/home/example/workspace/site',
    projectName: 'site',
    devServerUrl: 'http://localhost:3000',
    createdAt: START_TIME,
    updatedAt,
    status: 'planning',
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
    ...overrides,
  };
}

/** Relays one `session.updated` frame carrying `session` into the store. */
function relayUpdated(session: SessionRecord): void {
  applyRelayedMessage(createEnvelope('session.updated', { session }));
}

/** Subscribes a counter to the store and returns it with its unsubscriber. */
function countNotifications(): { readonly count: () => number; readonly stop: () => void } {
  let notified = 0;
  const stop = subscribePanelStore(() => {
    notified += 1;
  });
  return { count: () => notified, stop };
}

describe('session-store — applying whole session records', () => {
  beforeEach(() => {
    resetPanelStore({ includeConnection: true });
  });

  afterEach(() => {
    resetPanelStore({ includeConnection: true });
  });

  it('replaces the held record with a newer one and notifies once', () => {
    relayUpdated(record(START_TIME + 10));
    const counter = countNotifications();

    relayUpdated(record(START_TIME + 20, { status: 'ready' }));

    expect(getPanelSnapshot().session?.status).toBe('ready');
    expect(getPanelSnapshot().session?.updatedAt).toBe(START_TIME + 20);
    expect(counter.count()).toBe(1);
    counter.stop();
  });

  it('drops an older record of the session on screen without notifying', () => {
    relayUpdated(record(START_TIME + 20, { status: 'ready' }));
    const before = getPanelSnapshot();
    const counter = countNotifications();

    relayUpdated(record(START_TIME + 10, { status: 'planning' }));

    expect(getPanelSnapshot()).toBe(before);
    expect(getPanelSnapshot().session?.status).toBe('ready');
    expect(counter.count()).toBe(0);
    counter.stop();
  });

  it('drops a frame that carries the very record already held', () => {
    const held = record(START_TIME + 20);
    relayUpdated(held);
    const before = getPanelSnapshot();
    const counter = countNotifications();

    relayUpdated(held);

    expect(getPanelSnapshot()).toBe(before);
    expect(counter.count()).toBe(0);
    counter.stop();
  });

  it('applies a record whose updatedAt equals the held one: the later frame is the later write', () => {
    relayUpdated(record(START_TIME + 20, { status: 'instrumenting' }));

    relayUpdated(record(START_TIME + 20, { status: 'ready' }));

    expect(getPanelSnapshot().session?.status).toBe('ready');
  });

  it('applies a record of another session whatever its timestamp: identity changed', () => {
    relayUpdated(record(START_TIME + 20));

    relayUpdated(record(START_TIME + 5, { id: OTHER_SESSION_ID }));

    expect(getPanelSnapshot().session?.id).toBe(OTHER_SESSION_ID);
  });
});
