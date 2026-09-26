/**
 * `panel/App` — the mounted DevTools panel, for the states only its composition
 * root produces.
 *
 * What this suite protects:
 *
 *   - "Service not running" (AAP 0.7.3): the mounted panel shows, beside the
 *     pill, both the VS Code "Debug Generator: Start Local Service" action and
 *     the shell command that starts the service — the command reaching
 *     `ConnectionStatus` from the composition root, not only from a unit fixture;
 *   - the drawer's parent chain: a parent the whole stored trace does not hold
 *     is stated as missing (never an omitted section), an ancestor kept on a
 *     later page of the trace is fetched and shown as a complete chain, a
 *     lookup that reaches its page budget is stated as incomplete with the
 *     count read and continues from where it stopped, and a failed lookup
 *     offers a retry that reads the trace again;
 *   - the drawer reads the rendered panel's evidence: a selection absent from
 *     the live tail is looked up with the rendered specification's `id`, so the
 *     service answers from the capture that panel was generated from;
 *   - an unexpected exception's text never reaches the screen, the store or the
 *     console: a command that fails with one is presented as fixed copy under
 *     its fallback code, and the panel logs that closed code alone.
 *
 * Harness: the panel connection module is replaced with one whose port
 * requests this suite answers (`harness.handler`), so the real store, data
 * provider, actions and components run unchanged. The session store is the
 * real module and is reset around every case. Fixture strings are generic
 * product vocabulary written for this suite; no inspected project's names or
 * routes appear in it (AAP 0.5.4).
 */
import { PANEL_SPEC_VERSION } from '@debuggen/panel-schema';
import type { PanelSpec } from '@debuggen/panel-schema';
import type { SessionRecord, TelemetryEvent } from '@debuggen/protocol';
import { createEnvelope, parseSessionRecord } from '@debuggen/protocol';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { App } from '../src/panel/App';
import { EVENT_RESOLUTION_PAGE_BUDGET } from '../src/panel/data-provider';
import type * as ConnectionModule from '../src/panel/state/connection';
import {
  applyRelayedMessage,
  applySessionSnapshot,
  getPanelSnapshot,
  resetPanelStore,
  selectEvent,
  setConnectionStatus,
} from '../src/panel/state/session-store';
import { PANEL_CONNECTION_LABELS } from '../src/shared/messages';

/** Answers one port request the panel sends, in place of the service worker. */
type PortRequestHandler = (kind: string, payload: unknown) => Promise<unknown>;

/** One port request the panel sent. */
interface RecordedRequest {
  readonly kind: string;
  readonly payload: unknown;
}

const harness = vi.hoisted(() => ({
  handler: undefined as PortRequestHandler | undefined,
  requests: [] as RecordedRequest[],
}));

vi.mock('../src/panel/state/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionModule>();
  return {
    ...actual,
    // No runtime port in a unit document: the connection's lifetime is a no-op
    // and every request is answered by the case's handler.
    startPanelConnection: () => ({ ...actual.getPanelConnection(), stop: () => undefined }),
    onPortDisconnect: () => () => undefined,
    panelRequest: (kind: string, payload: unknown): Promise<unknown> => {
      harness.requests.push({ kind, payload });
      const handler = harness.handler;
      return handler === undefined
        ? Promise.reject(new Error('This suite answers no port request here.'))
        : handler(kind, payload);
    },
  };
});

// ---------------------------------------------------------------------------
// Copy the assertions read
// ---------------------------------------------------------------------------

const START_SERVICE_ACTION = 'Debug Generator: Start Local Service';
const START_SERVICE_COMMAND = 'node apps/local-service/dist/main.js';
const REPOSITORY_ROOT_WORDING = /from the Debug Generator repository root/;
const MISSING_PARENT_MESSAGE =
  'This event names a parent span that is not part of the capture, so its ancestors are unknown.';
const MISSING_SPAN_LABEL = 'Missing span ID';
const LOOKUP_ERROR_TITLE = 'Could not load this event';
const RETRY_LABEL = 'Retry';
const CONTINUE_LABEL = 'Continue the ancestry search';

/**
 * The drawer's statement that the lookup stopped at its page budget before
 * the selected event's parent span turned up, naming how many stored events
 * of the trace it read — the count grouped as the drawer groups it.
 */
function incompleteWording(eventsRead: number): string {
  const count = new Intl.NumberFormat(undefined, {
    useGrouping: true,
    maximumFractionDigits: 0,
  }).format(eventsRead);
  return `The parent span of this event was not among the ${count} stored events of this trace that were read, so the chain above it is not shown.`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-app-0001';
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const ROOT_SPAN = 'b7ad6b7169203331';
const LEAF_SPAN = '00f067aa0ba902b7';
const UNRELATED_SPAN = '53995c3f42cd8ad8';

/** The service's page ceiling, which the drawer's queries ask for. */
const PAGE_LIMIT = 5000;

const SESSION: SessionRecord = {
  id: SESSION_ID,
  projectRoot: '/workspace/sample-project',
  projectName: 'sample-project',
  devServerUrl: 'http://127.0.0.1:3100',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  status: 'generated',
  question: 'Why does the item list take long to appear?',
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

/** Every field a stored event carries apart from its identity and lineage. */
const BASE_EVENT = {
  traceId: TRACE_ID,
  duration: 12.5,
  status: 'ok',
  producerId: 'producer-browser-1',
  sessionId: SESSION_ID,
  captureId: 'capture-app-0001',
  attributes: {},
} as const;

/** The trace root: a browser interaction. */
const ROOT_EVENT: TelemetryEvent = {
  ...BASE_EVENT,
  attributes: {},
  id: 'event-root',
  spanId: ROOT_SPAN,
  kind: 'interaction',
  tier: 'browser',
  name: 'click primary action',
  startTime: 1_700_000_000_000,
  seq: 1,
  ingestSeq: 1,
};

/** The selected event: a request whose parent is the root. */
const LEAF_EVENT: TelemetryEvent = {
  ...BASE_EVENT,
  attributes: {},
  id: 'event-leaf',
  spanId: LEAF_SPAN,
  parentSpanId: ROOT_SPAN,
  kind: 'fetch',
  tier: 'browser',
  name: 'request item list',
  startTime: 1_700_000_000_010,
  seq: 2,
  ingestSeq: 2,
};

/** An event of the same trace that is not an ancestor of the selection. */
function unrelatedEvent(index: number): TelemetryEvent {
  return {
    ...BASE_EVENT,
    attributes: {},
    id: `event-unrelated-${String(index)}`,
    spanId: `${UNRELATED_SPAN.slice(0, 12)}${String(1000 + index)}`,
    parentSpanId: LEAF_SPAN,
    kind: 'render',
    tier: 'browser',
    name: `render item row ${String(index)}`,
    startTime: 1_700_000_000_020 + index,
    seq: 3 + index,
    ingestSeq: 3 + index,
  };
}

/** The wire `DataResult` for one page of `events`, with consistent paging counters. */
function eventsPage(events: readonly TelemetryEvent[], offset: number, total: number): unknown {
  const next = offset + events.length;
  return {
    source: 'events',
    events,
    total,
    limit: PAGE_LIMIT,
    offset,
    nextOffset: next < total ? next : null,
  };
}

/** Whether a value is a plain object whose members can be read. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `offset` of a `panelData.query` request's query, `0` when it names none. */
function queryOffset(payload: unknown): number {
  if (!isRecord(payload) || !isRecord(payload.query)) {
    throw new Error('A panel-data request without a query reached the suite.');
  }
  const offset = payload.query.offset;
  return typeof offset === 'number' ? offset : 0;
}

/** The panel-data requests the panel sent, in order. */
function panelDataRequests(): readonly RecordedRequest[] {
  return harness.requests.filter((request) => request.kind === 'panelData.query');
}

/** The id of the generated panel {@link PANEL} renders. */
const PANEL_ID = 'panel-app-0001';

/**
 * A validated specification of the session's panel. Its layout holds no
 * query-backed view, so the only `panelData.query` requests are the drawer's.
 */
const PANEL: PanelSpec = {
  version: PANEL_SPEC_VERSION,
  id: PANEL_ID,
  sessionId: SESSION_ID,
  panelVersion: 1,
  title: 'Where the item list spends its time',
  summary: { observed: [], likelyCauses: [] },
  layout: [],
};

/**
 * Show `SESSION` as the bound, connected session — with `panel` as its current
 * panel when one is given — and select the leaf event.
 */
function showSessionWithLeafSelected(panel?: PanelSpec): void {
  applySessionSnapshot({
    session: SESSION,
    panel,
    connection: { status: 'connected', serviceUrl: 'http://127.0.0.1:43117' },
    binding: { kind: 'bound', sessionId: SESSION_ID, tabId: 7, url: 'http://127.0.0.1:3100/' },
  });
  selectEvent({ eventId: LEAF_EVENT.id, traceId: TRACE_ID, spanId: LEAF_SPAN });
}

/** Answer `panelData.query` with `pageAt(offset)`; every other request is refused. */
function answerPanelData(pageAt: (offset: number) => Promise<unknown>): void {
  harness.handler = (kind, payload) =>
    kind === 'panelData.query'
      ? pageAt(queryOffset(payload))
      : Promise.reject(new Error(`This suite does not answer ${kind}.`));
}

let consoleError: MockInstance;
let consoleWarn: MockInstance;

beforeEach(() => {
  resetPanelStore({ includeConnection: true });
  harness.handler = undefined;
  harness.requests.length = 0;
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  resetPanelStore({ includeConnection: true });
  expect(consoleError).not.toHaveBeenCalled();
  expect(consoleWarn).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe('the session fixture', () => {
  it('is a valid SessionRecord', () => {
    expect(parseSessionRecord(SESSION).ok).toBe(true);
  });
});

describe('App — service not running', () => {
  it('shows the VS Code action and the start command beside the pill', () => {
    setConnectionStatus({ status: 'service-not-running', serviceUrl: 'http://127.0.0.1:43117' });

    render(<App theme="dark" />);

    expect(screen.getByText(PANEL_CONNECTION_LABELS['service-not-running'])).toBeTruthy();
    expect(screen.getByText(START_SERVICE_ACTION)).toBeTruthy();
    const command = screen.getByText(START_SERVICE_COMMAND);
    expect(command.tagName).toBe('CODE');
    expect(command.closest('[role="status"]')).toBeNull();
    expect(command.parentElement?.textContent).toMatch(REPOSITORY_ROOT_WORDING);
  });

  it('shows no start instructions once the service answers', () => {
    setConnectionStatus({ status: 'connected', serviceUrl: 'http://127.0.0.1:43117' });

    render(<App theme="dark" />);

    expect(screen.getByText(PANEL_CONNECTION_LABELS.connected)).toBeTruthy();
    expect(screen.queryByText(START_SERVICE_COMMAND)).toBeNull();
    expect(screen.queryByText(START_SERVICE_ACTION)).toBeNull();
  });
});

describe('App — the drawer parent chain', () => {
  it('states a parent the whole stored trace does not hold as missing', async () => {
    answerPanelData((offset) => Promise.resolve(eventsPage([LEAF_EVENT], offset, 1)));
    showSessionWithLeafSelected();

    render(<App theme="dark" />);

    expect(await screen.findByText(MISSING_PARENT_MESSAGE)).toBeTruthy();
    // The span the chain stops at is stated beside its label, not only in the identity block.
    expect(screen.getByText(MISSING_SPAN_LABEL).parentElement?.textContent).toContain(ROOT_SPAN);
    // The first page was the whole trace, so nothing further was read.
    expect(panelDataRequests()).toHaveLength(1);
  });

  it('fetches an ancestor kept on a later page of the trace and shows the complete chain', async () => {
    answerPanelData((offset) =>
      Promise.resolve(
        offset === 0 ? eventsPage([LEAF_EVENT], 0, 2) : eventsPage([ROOT_EVENT], offset, 2),
      ),
    );
    showSessionWithLeafSelected();

    render(<App theme="dark" />);

    const ancestor = await screen.findByRole('button', { name: /click primary action/ });
    expect(ancestor).toBeTruthy();
    expect(screen.queryByText(MISSING_PARENT_MESSAGE)).toBeNull();
    expect(panelDataRequests().map((request) => queryOffset(request.payload))).toEqual([0, 1]);
  });

  it('states a lookup that reached its page budget as incomplete, with the count read, and continues it', async () => {
    // One event per page: the selection on the first, the root on the last,
    // which lies beyond one ancestry pass's budget and within the next one's.
    const rootOffset = 2 * EVENT_RESOLUTION_PAGE_BUDGET;
    const total = rootOffset + 1;
    answerPanelData((offset) => {
      if (offset === 0) {
        return Promise.resolve(eventsPage([LEAF_EVENT], 0, total));
      }
      return Promise.resolve(
        eventsPage([offset === rootOffset ? ROOT_EVENT : unrelatedEvent(offset)], offset, total),
      );
    });
    showSessionWithLeafSelected();
    const user = userEvent.setup();

    render(<App theme="dark" />);

    // The resolving page, then one full ancestry budget of further pages.
    expect(
      await screen.findByText(incompleteWording(EVENT_RESOLUTION_PAGE_BUDGET + 1)),
    ).toBeTruthy();
    expect(screen.getByText(MISSING_SPAN_LABEL).parentElement?.textContent).toContain(ROOT_SPAN);
    expect(screen.queryByText(MISSING_PARENT_MESSAGE)).toBeNull();
    const firstPass = Array.from({ length: EVENT_RESOLUTION_PAGE_BUDGET + 1 }, (_, page) => page);
    expect(panelDataRequests().map((request) => queryOffset(request.payload))).toEqual(firstPass);

    // Continuing reads on from the first page the search did not read.
    await user.click(screen.getByRole('button', { name: CONTINUE_LABEL }));

    expect(await screen.findByRole('button', { name: /click primary action/ })).toBeTruthy();
    expect(screen.queryByText(incompleteWording(EVENT_RESOLUTION_PAGE_BUDGET + 1))).toBeNull();
    expect(screen.queryByRole('button', { name: CONTINUE_LABEL })).toBeNull();
    const continued = Array.from(
      { length: EVENT_RESOLUTION_PAGE_BUDGET },
      (_, page) => firstPass.length + page,
    );
    expect(panelDataRequests().map((request) => queryOffset(request.payload))).toEqual([
      ...firstPass,
      ...continued,
    ]);
  });

  it('offers a retry after a failed lookup, and the retry reads the trace again', async () => {
    let failLookup = true;
    answerPanelData((offset) => {
      if (offset === 0) {
        return Promise.resolve(eventsPage([LEAF_EVENT], 0, 2));
      }
      if (failLookup) {
        return Promise.reject(new Error('The lookup page could not be read.'));
      }
      return Promise.resolve(eventsPage([ROOT_EVENT], offset, 2));
    });
    showSessionWithLeafSelected();
    const user = userEvent.setup();

    render(<App theme="dark" />);

    // The lookup failed on the ancestor's page: its failure is stated, never an empty drawer.
    expect(await screen.findByText(LOOKUP_ERROR_TITLE)).toBeTruthy();
    expect(panelDataRequests().map((request) => queryOffset(request.payload))).toEqual([0, 1]);
    failLookup = false;
    await user.click(screen.getByRole('button', { name: RETRY_LABEL }));

    expect(await screen.findByRole('button', { name: /click primary action/ })).toBeTruthy();
    expect(screen.queryByText(LOOKUP_ERROR_TITLE)).toBeNull();
    // The failed lookup kept nothing: the retry reads the trace again from its first event.
    expect(panelDataRequests().map((request) => queryOffset(request.payload))).toEqual([
      0, 1, 0, 1,
    ]);
  });
});

describe('App — an unexpected failure is presented without its text', () => {
  /**
   * A credential-shaped value: a token prefix and a run of the length that
   * prefix is followed by. Assembled from pieces so that the repository's
   * secret scan does not read this fixture as a committed credential.
   */
  const CREDENTIAL_SHAPED = ['gh', 'p_', 'x'.repeat(36)].join('');
  /** The private parts an unexpected exception's message might carry. */
  const PRIVATE_PATH = '/home/dev/.env';
  const PRIVATE_SQL = 'SELECT password FROM users';
  const PRIVATE_TEXT = `${PRIVATE_PATH}: ${PRIVATE_SQL} WHERE token='${CREDENTIAL_SHAPED}'`;
  const START_CAPTURE_LABEL = 'Start capture';
  const LAST_ERROR_TITLE = 'A Debug Generator request did not complete';
  const FIXED_COPY =
    'Could not start the capture: an unexpected error stopped the request in the Debug Generator panel. Try again; if it keeps failing, reopen Chrome DevTools.';

  /** Whether `text` holds any part of {@link PRIVATE_TEXT}. */
  function leaksPrivateText(text: string): boolean {
    return [PRIVATE_TEXT, PRIVATE_PATH, PRIVATE_SQL, CREDENTIAL_SHAPED].some((part) =>
      text.includes(part),
    );
  }

  it('shows fixed copy for a capture.start that rejects with a plain Error, and logs only its code', async () => {
    harness.handler = (kind) =>
      Promise.reject(
        kind === 'capture.start'
          ? new Error(PRIVATE_TEXT)
          : new Error(`This suite does not answer ${kind}.`),
      );
    // A session ready to capture, bound to this tab over a connected panel.
    applySessionSnapshot({
      session: { ...SESSION, status: 'ready' },
      connection: { status: 'connected', serviceUrl: 'http://127.0.0.1:43117' },
      binding: { kind: 'bound', sessionId: SESSION_ID, tabId: 7, url: 'http://127.0.0.1:3100/' },
    });
    const user = userEvent.setup();

    render(<App theme="dark" />);
    await user.click(screen.getByRole('button', { name: START_CAPTURE_LABEL }));

    expect(await screen.findByText(LAST_ERROR_TITLE)).toBeTruthy();
    expect(screen.getByText(FIXED_COPY)).toBeTruthy();
    expect(harness.requests.map((request) => request.kind)).toEqual(['capture.start']);
    // Nothing of the exception's text anywhere in the document or the store.
    expect(leaksPrivateText(document.body.textContent)).toBe(false);
    expect(getPanelSnapshot().lastError).toEqual({
      code: 'TRANSPORT_DISCONNECTED',
      message: FIXED_COPY,
    });
    expect(leaksPrivateText(JSON.stringify(getPanelSnapshot().lastError))).toBe(false);

    // The panel's log records the closed code, and nothing of the cause.
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringMatching(/^\[panel\] /u), {
      code: 'TRANSPORT_DISCONNECTED',
    });
    expect(leaksPrivateText(JSON.stringify(consoleWarn.mock.calls))).toBe(false);
    // Asserted above; `afterEach` holds every other case to a silent console.
    consoleWarn.mockClear();
  });
});

/** The capture every fixture event belongs to, streamed by the live tail below. */
const CAPTURE_ID = BASE_EVENT.captureId;

/** The chip caption of {@link PANEL_WITH_EVIDENCE}'s one citation. */
const EVIDENCE_CHIP_LABEL = 'cited item request';

/** {@link PANEL}, with an observed fact citing the leaf event. */
const PANEL_WITH_EVIDENCE: PanelSpec = {
  ...PANEL,
  summary: {
    observed: [
      {
        statement: 'The item list request started after the click.',
        evidence: [
          {
            eventId: LEAF_EVENT.id,
            traceId: TRACE_ID,
            spanId: LEAF_SPAN,
            kind: 'fetch',
            label: EVIDENCE_CHIP_LABEL,
          },
        ],
      },
    ],
    likelyCauses: [],
  },
};

/**
 * Show `SESSION` with `panel` rendered while {@link CAPTURE_ID} runs and the
 * live tail holds `tail` — nothing selected yet.
 */
function showSessionStreaming(panel: PanelSpec, tail: TelemetryEvent[]): void {
  applySessionSnapshot({
    session: SESSION,
    panel,
    connection: { status: 'connected', serviceUrl: 'http://127.0.0.1:43117' },
    binding: { kind: 'bound', sessionId: SESSION_ID, tabId: 7, url: 'http://127.0.0.1:3100/' },
  });
  applyRelayedMessage(
    createEnvelope(
      'capture.started',
      { sessionId: SESSION_ID, captureId: CAPTURE_ID },
      { ts: 1_700_000_000_000 },
    ),
  );
  applyRelayedMessage(
    createEnvelope(
      'telemetry.tail',
      { sessionId: SESSION_ID, events: tail },
      { ts: 1_700_000_000_050 },
    ),
  );
}

/** Whether a recorded `panelData.query` request named a panel. */
function namesPanel(request: RecordedRequest): boolean {
  return (
    isRecord(request.payload) &&
    isRecord(request.payload.query) &&
    'panelId' in request.payload.query
  );
}

/** The drawer's complementary landmark. */
function drawerRegion(): HTMLElement {
  return screen.getByRole('complementary', { name: 'Selected event' });
}

describe('App — whose evidence the drawer reads follows where the selection was raised', () => {
  it('reads a live-tail row live while a panel is rendered, and so its ancestor too', async () => {
    // The tail holds the leaf but not its root, so the drawer sends a stored lookup.
    answerPanelData((offset) => Promise.resolve(eventsPage([ROOT_EVENT, LEAF_EVENT], offset, 2)));
    showSessionStreaming(PANEL, [LEAF_EVENT]);
    const user = userEvent.setup();

    const view = render(<App theme="dark" />);
    const tail = screen.getByRole('region', { name: 'Live event tail' });
    const row = tail.querySelector('[data-row-index="0"]');
    if (!(row instanceof HTMLElement)) {
      throw new Error('The live tail rendered no row for the streamed event.');
    }
    await user.click(row);

    const ancestor = await within(drawerRegion()).findByRole('button', {
      name: /click primary action/,
    });
    const requests = panelDataRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.payload).toMatchObject({
      sessionId: SESSION_ID,
      query: { source: 'events', filter: { traceId: TRACE_ID } },
    });
    expect(requests.some(namesPanel)).toBe(false);

    // The ancestor, selected from the drawer, is evidence of the same capture:
    // it is read live as well, never as the rendered panel's.
    await user.click(ancestor);
    expect(
      await within(drawerRegion()).findByText('click primary action', { selector: 'p' }),
    ).toBeTruthy();
    expect(panelDataRequests().some(namesPanel)).toBe(false);
    view.unmount();
  });

  it('binds a panel evidence chip to the panel even when the live tail holds the same event', async () => {
    answerPanelData((offset) => Promise.resolve(eventsPage([ROOT_EVENT, LEAF_EVENT], offset, 2)));
    showSessionStreaming(PANEL_WITH_EVIDENCE, [LEAF_EVENT]);
    const user = userEvent.setup();

    render(<App theme="dark" />);
    await user.click(screen.getByRole('button', { name: EVIDENCE_CHIP_LABEL }));

    expect(
      await within(drawerRegion()).findByRole('button', { name: /click primary action/ }),
    ).toBeTruthy();
    const requests = panelDataRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.payload).toMatchObject({
      sessionId: SESSION_ID,
      query: { source: 'events', filter: { traceId: TRACE_ID }, panelId: PANEL_ID },
    });
  });

  it('rebinds the same event when it is raised again from the other place', async () => {
    answerPanelData((offset) => Promise.resolve(eventsPage([ROOT_EVENT, LEAF_EVENT], offset, 2)));
    showSessionStreaming(PANEL_WITH_EVIDENCE, [LEAF_EVENT]);
    const user = userEvent.setup();

    render(<App theme="dark" />);
    const row = screen
      .getByRole('region', { name: 'Live event tail' })
      .querySelector('[data-row-index="0"]');
    if (!(row instanceof HTMLElement)) {
      throw new Error('The live tail rendered no row for the streamed event.');
    }

    // Raised by the tail first: a live read.
    await user.click(row);
    await within(drawerRegion()).findByRole('button', { name: /click primary action/ });
    expect(panelDataRequests().map(namesPanel)).toEqual([false]);

    // The same event, raised by the panel's evidence chip: the panel's evidence.
    await user.click(screen.getByRole('button', { name: EVIDENCE_CHIP_LABEL }));
    await within(drawerRegion()).findByRole('button', { name: /click primary action/ });
    const requests = panelDataRequests();
    expect(requests.map(namesPanel)).toEqual([false, true]);
    expect(requests[1]?.payload).toMatchObject({ query: { panelId: PANEL_ID } });
  });
});

describe('App — the drawer reads the rendered panel’s evidence', () => {
  it('binds the lookup of a selection absent from the live tail to the rendered panel', async () => {
    // The trace's one page holds the selection and its root.
    answerPanelData((offset) => Promise.resolve(eventsPage([ROOT_EVENT, LEAF_EVENT], offset, 2)));
    showSessionWithLeafSelected(PANEL);

    render(<App theme="dark" />);

    expect(await screen.findByRole('button', { name: /click primary action/ })).toBeTruthy();
    const requests = panelDataRequests();
    expect(requests).toHaveLength(1);
    for (const request of requests) {
      expect(request.payload).toMatchObject({
        sessionId: SESSION_ID,
        query: { source: 'events', filter: { traceId: TRACE_ID }, panelId: PANEL_ID },
      });
    }
  });
});
