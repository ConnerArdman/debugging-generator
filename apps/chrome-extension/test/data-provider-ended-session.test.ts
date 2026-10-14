/**
 * Unit spec for the ended-session refusal of `../src/panel/data-provider.ts`
 * (`PanelDataProviderOptions.isSessionEnded`).
 *
 * Ending a session unbinds its tab, and the panel's store keeps the ended
 * session's final state on screen, rendered views included. A read those
 * views make afterwards — another page, an event lookup — cannot succeed: a
 * devtools client reads panel data only for the session bound to its tab (AAP
 * §0.5.6), and an ended session accepts no binding. The guarantee held here is
 * that such a read is refused **before anything is sent**, with the code the
 * service refuses an ended session with and copy that says the views on screen
 * stay — never a round trip whose refusal tells the reader to reopen the panel
 * and so discard them. A predicate that is missing, answers anything but
 * `true` or throws leaves the query to the worker and service, as before.
 *
 * **Harness.** Collected into the `chrome-extension` Vitest project. The
 * request function is a recording fake answering an empty `events` page; ids
 * are neutral synthetic values (AAP §0.5.4).
 */

import { describe, expect, it } from 'vitest';

import type { DataQuery } from '@debuggen/panel-schema';
import { DebuggenError } from '@debuggen/shared';
import type { LogFields, Logger, LogLevel } from '@debuggen/shared';

import { createPanelDataProvider } from '../src/panel/data-provider';
import type { PanelDataRequestFunction } from '../src/panel/data-provider';

const SESSION_ID = 'session-ended-a';
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const QUERY: DataQuery = { source: 'events', filter: { traceId: TRACE_ID }, limit: 50 };

interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

function createRecordingLogger(entries: LogEntry[]): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields: { ...fields } });
    };
  const logger: Logger = {
    level: 'trace',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: () => logger,
  };
  return logger;
}

/** A provider whose store shows {@link SESSION_ID}, with `isSessionEnded` as given. */
function createWorld(isSessionEnded?: (sessionId: string) => boolean) {
  const sent: unknown[] = [];
  const logs: LogEntry[] = [];
  const request: PanelDataRequestFunction = (_kind, payload) => {
    sent.push(payload);
    return Promise.resolve({
      source: 'events',
      events: [],
      total: 0,
      limit: 50,
      offset: 0,
      nextOffset: null,
    });
  };
  const provider = createPanelDataProvider({
    request,
    getSessionId: () => SESSION_ID,
    ...(isSessionEnded === undefined ? {} : { isSessionEnded }),
    logger: createRecordingLogger(logs),
  });
  return { provider, sent, logs };
}

async function rejectionOf(promise: Promise<unknown>): Promise<DebuggenError> {
  try {
    await promise;
  } catch (cause: unknown) {
    expect(DebuggenError.is(cause)).toBe(true);
    return DebuggenError.from(cause);
  }
  throw new Error('Expected the promise to reject.');
}

describe('createPanelDataProvider — an ended session', () => {
  it('refuses a query of the ended session before sending it, saying the views stay', async () => {
    const world = createWorld((sessionId) => sessionId === SESSION_ID);

    const failure = await rejectionOf(world.provider.query(SESSION_ID, QUERY));

    expect(world.sent).toEqual([]);
    expect(failure.code).toBe('SESSION_INVALID_STATE');
    expect(failure.message).toContain('the session has ended');
    expect(failure.hint).toContain('stays on screen');
    expect(failure.details).toEqual({ source: 'events', session: 'ended' });
  });

  it('refuses the event lookup of the ended session the same way', async () => {
    const world = createWorld(() => true);

    const failure = await rejectionOf(
      world.provider.resolveEvent(SESSION_ID, {
        eventId: 'evt_ended0lookup0001',
        traceId: TRACE_ID,
      }),
    );

    expect(world.sent).toEqual([]);
    expect(failure.code).toBe('SESSION_INVALID_STATE');
  });

  it('sends the query while the session has not ended', async () => {
    const world = createWorld(() => false);

    await world.provider.query(SESSION_ID, QUERY);

    expect(world.sent).toHaveLength(1);
  });

  it('sends the query when no predicate is injected', async () => {
    const world = createWorld();

    await world.provider.query(SESSION_ID, QUERY);

    expect(world.sent).toHaveLength(1);
  });

  it('sends the query when the predicate throws, logging only the error name', async () => {
    const world = createWorld(() => {
      throw new TypeError('sentinel-store-failure');
    });

    await world.provider.query(SESSION_ID, QUERY);

    expect(world.sent).toHaveLength(1);
    expect(world.logs).toContainEqual(
      expect.objectContaining({ level: 'warn', fields: { error: 'TypeError' } }),
    );
    expect(JSON.stringify(world.logs)).not.toContain('sentinel-store-failure');
  });
});
