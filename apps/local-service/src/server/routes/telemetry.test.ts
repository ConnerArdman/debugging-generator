/**
 * Unit tests for the relayed-frame admission and the diagnostics bounds of
 * `./telemetry.ts` (OBS-F19, CWE-400).
 *
 * The frame handler is driven directly with a fake ingest entry, a live
 * binding view in which each relaying tab is bound — by the connection's own
 * credential — to a session of its own (the relayed-tab rule admits a frame of
 * no other tab), a stepped clock and a capturing logger. No HTTP server and no
 * socket is opened.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvelope } from '@debuggen/protocol';
import { DebuggenError, err, isErr, ok } from '@debuggen/shared';
import type { LogFields, Logger, Result } from '@debuggen/shared';

import { LOG_THROTTLE_INTERVAL_MS } from '../../telemetry/ingest.js';
import type { IngestReport, TelemetryIngest } from '../../telemetry/ingest.js';
import type { TabBindingView } from '../clients.js';

import {
  MALFORMED_FRAME_LIMIT,
  MALFORMED_FRAME_WINDOW_MS,
  createTelemetryRoutes,
} from './telemetry.js';
import type { TelemetryEventFrame, TelemetryFrameConnection } from './telemetry.js';

const FIXED_NOW = 1_768_000_000_000;
const TAB = 7;
const OTHER_TAB = 8;

/** The `tokenHash` of the paired DevTools credential every frame's connection carries. */
const TOKEN_HASH = 'f'.repeat(64);

/** The session each relaying tab is bound to; both bindings are live. */
const SESSION_OF_TAB: ReadonlyMap<number, string> = new Map([
  [TAB, 'ses_relaytabseven'],
  [OTHER_TAB, 'ses_relaytabeight'],
]);

/** The live binding of `tabId`, made by the connection's credential, if the tab is bound. */
function liveBinding(tabId: number): TabBindingView | undefined {
  const sessionId = SESSION_OF_TAB.get(tabId);
  return sessionId === undefined
    ? undefined
    : {
        tabId,
        sessionId,
        url: 'http://127.0.0.1:3100/',
        boundBy: TOKEN_HASH,
        boundAt: FIXED_NOW,
        recipientId: 'cli_relay',
        online: true,
      };
}

/** One captured log record. */
interface Entry {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields;
}

/** A logger that keeps every record it is handed. */
function capturingLogger(entries: Entry[]): Logger {
  const record =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields: fields ?? {} });
    };
  const logger: Logger = {
    level: 'trace',
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    child: () => logger,
  };
  return logger;
}

/** A clock the test moves by hand. */
function steppedClock(): { readonly now: () => number; advance(ms: number): void } {
  let reading = FIXED_NOW;
  return {
    now: () => reading,
    advance(ms: number): void {
      reading += ms;
    },
  };
}

/** A report with only the counts the frame handler reads set to something meaningful. */
function reportOf(counts: { persisted: number; invalid: number }): IngestReport {
  const report: Partial<IngestReport> = {
    received: counts.persisted + counts.invalid,
    parsed: counts.persisted,
    invalid: counts.invalid,
    persisted: counts.persisted,
    skipped: 0,
    requestKeysComputed: 0,
    tracesTouched: [],
  };
  return report as IngestReport;
}

/** The DevTools connection every frame arrives on, announcing `tabId`. */
function connection(tabId: number): TelemetryFrameConnection {
  return {
    id: 'cli_relay',
    kind: 'devtools',
    tabId,
    principal: {
      role: 'devtools',
      tokenHash: TOKEN_HASH,
      scope: { kind: 'extension', extensionId: 'abcdefghijklmnopabcdefghijklmnop' },
      issuedAt: 0,
    },
  };
}

/** A `telemetry.event` frame carrying `events` on the connection for `tabId`. */
function frame(events: unknown, tabId: number = TAB): TelemetryEventFrame {
  const message = createEnvelope('telemetry.event', { events: [] });
  return {
    message: { ...message, payload: { events } } as TelemetryEventFrame['message'],
    client: connection(tabId),
  };
}

/** The routes over a fake ingest entry, a stepped clock and a capturing logger. */
function harness(answer: (events: readonly unknown[]) => Result<IngestReport, DebuggenError>) {
  const clock = steppedClock();
  const entries: Entry[] = [];
  const ingestFromAgent = vi.fn<TelemetryIngest['ingestFromAgent']>((input) =>
    Promise.resolve(answer(input.events as readonly unknown[])),
  );
  const routes = createTelemetryRoutes({
    ingest: {
      ingestFromAgent,
      ingestFromServerAgent: () => Promise.resolve(ok(reportOf({ persisted: 0, invalid: 0 }))),
    },
    bindings: {
      bindingForTab: liveBinding,
      bindingForSession: (sessionId) =>
        [...SESSION_OF_TAB.keys()]
          .map(liveBinding)
          .find((binding) => binding?.sessionId === sessionId),
    },
    logger: capturingLogger(entries),
    now: clock.now,
  });
  return { routes, clock, entries, ingestFromAgent };
}

/** Every element malformed: stored nothing. */
const MALFORMED = (): Result<IngestReport, DebuggenError> =>
  ok(reportOf({ persisted: 0, invalid: 1 }));

afterEach(() => {
  vi.useRealTimers();
});

describe('relayed-frame admission', () => {
  it('refuses a tab’s frames unread once it relayed the malformed-frame limit, for the window', async () => {
    const h = harness(MALFORMED);

    for (let index = 0; index < MALFORMED_FRAME_LIMIT; index += 1) {
      const outcome = await h.routes.handleTelemetryEventFrame(frame([null]));
      expect(outcome.ok).toBe(true);
    }
    expect(h.ingestFromAgent).toHaveBeenCalledTimes(MALFORMED_FRAME_LIMIT);

    // Hundreds more: none reaches ingest, none has its payload read.
    let payloadReads = 0;
    const watched = new Proxy([null], {
      get(target, property, receiver) {
        payloadReads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    for (let index = 0; index < 300; index += 1) {
      const refused = await h.routes.handleTelemetryEventFrame(frame(watched));
      expect(isErr(refused) && refused.error.code).toBe('RATE_LIMITED');
    }
    expect(h.ingestFromAgent).toHaveBeenCalledTimes(MALFORMED_FRAME_LIMIT);
    expect(payloadReads, 'a refused frame is not read').toBe(0);

    const closed = h.entries.filter((entry) => entry.level === 'warn');
    expect(closed).toHaveLength(1);
    expect(closed[0]?.fields).toMatchObject({ tabId: TAB, malformed: MALFORMED_FRAME_LIMIT });
    expect(
      h.entries.filter((entry) => entry.level === 'debug'),
      'the per-frame refusal debug record is throttled',
    ).toHaveLength(1);

    // The window passes: the tab's frames are admitted again.
    h.clock.advance(MALFORMED_FRAME_WINDOW_MS);
    expect((await h.routes.handleTelemetryEventFrame(frame([null]))).ok).toBe(true);
    expect(h.ingestFromAgent).toHaveBeenCalledTimes(MALFORMED_FRAME_LIMIT + 1);
  });

  it('never counts well-formed frames, and closes only the flooding tab', async () => {
    const h = harness((events) =>
      events[0] === 'good' ? ok(reportOf({ persisted: 1, invalid: 0 })) : MALFORMED(),
    );

    for (let index = 0; index < MALFORMED_FRAME_LIMIT * 5; index += 1) {
      expect((await h.routes.handleTelemetryEventFrame(frame(['good']))).ok).toBe(true);
    }
    for (let index = 0; index < MALFORMED_FRAME_LIMIT; index += 1) {
      await h.routes.handleTelemetryEventFrame(frame([null], OTHER_TAB));
    }

    const flooding = await h.routes.handleTelemetryEventFrame(frame(['good'], OTHER_TAB));
    expect(isErr(flooding) && flooding.error.code).toBe('RATE_LIMITED');
    const neighbour = await h.routes.handleTelemetryEventFrame(frame(['good']));
    expect(neighbour.ok, 'the other tab on the same connection is unaffected').toBe(true);
  });

  it('counts frames that are not arrays or are refused as malformed, but not service faults', async () => {
    let answer: Result<IngestReport, DebuggenError> = err(
      new DebuggenError('STORE_ERROR', 'The store is unavailable.'),
    );
    const h = harness(() => answer);

    for (let index = 0; index < MALFORMED_FRAME_LIMIT * 2; index += 1) {
      const outcome = await h.routes.handleTelemetryEventFrame(frame([{}]));
      expect(isErr(outcome) && outcome.error.code, 'a store outage is never the tab’s doing').toBe(
        'STORE_ERROR',
      );
    }

    answer = err(new DebuggenError('PROTOCOL_INVALID_MESSAGE', 'Not a batch.'));
    for (let index = 0; index < MALFORMED_FRAME_LIMIT / 2; index += 1) {
      await h.routes.handleTelemetryEventFrame(frame('not-an-array'));
      await h.routes.handleTelemetryEventFrame(frame([{}]));
    }
    const refused = await h.routes.handleTelemetryEventFrame(frame([{}]));
    expect(isErr(refused) && refused.error.code).toBe('RATE_LIMITED');
    expect(isErr(refused) && refused.error.details?.['retryAfterMs']).toBe(
      MALFORMED_FRAME_WINDOW_MS,
    );
  });

  it('reports a refused flood that stops with a trailing summary', async () => {
    vi.useFakeTimers();
    const h = harness(MALFORMED);

    for (let index = 0; index < MALFORMED_FRAME_LIMIT + 50; index += 1) {
      await h.routes.handleTelemetryEventFrame(frame([null]));
    }
    const debugBefore = h.entries.filter((entry) => entry.level === 'debug');
    expect(debugBefore).toHaveLength(1);

    h.clock.advance(LOG_THROTTLE_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(LOG_THROTTLE_INTERVAL_MS);

    const debugAfter = h.entries.filter((entry) => entry.level === 'debug');
    expect(debugAfter).toHaveLength(2);
    expect(debugAfter[1]?.fields).toMatchObject({
      tabId: TAB,
      suppressed: 49,
      trailingSummary: true,
    });
    const serialised = JSON.stringify(h.entries);
    expect(serialised, 'throttle keys are never written').not.toContain('\\u0000');
  });
});
