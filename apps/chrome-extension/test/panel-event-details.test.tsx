/**
 * Component spec for `../src/panel/components/EventDetails.tsx` — the DevTools
 * panel's right drawer — focused on its Parent chain section.
 *
 * The section renders for EVERY shown event and states exactly what the
 * composition root found when it looked the ancestors up (`EventAncestry`), so
 * "no parent", "parent not in the capture" and "not looked up yet" never read
 * alike. Pinned here, one `describe` per state:
 *
 *   1. a trace root states that it has no parent, whatever `ancestry` says;
 *   2. no `ancestry` is a neutral sentence that never claims a parent is
 *      missing;
 *   3. `loading` is a one-row, announced `LoadingState`;
 *   4. `complete` is the ordered chain — ancestors as buttons selecting them
 *      (plain text without a handler), the selected event last and
 *      `aria-current` — and an empty "complete" chain is shown as `missing`;
 *   5. `missing` names the gap (immediate parent or a higher ancestor), shows
 *      the missing span id as copyable text and the partial chain behind a
 *      muted marker item;
 *   6. `incomplete` states the grouped count of stored events read;
 *   7. `cycle` states the loop and the chain up to it;
 *   8. `error` is a polite `ErrorState` whose retry calls `onRetryAncestry`.
 *
 * Also pinned: activating an ancestor moves focus to the newly shown event's
 * name, and the Source chip still reaches `onOpenSource` with the location
 * unmodified. No case may write to `console.error` or `console.warn`.
 *
 * The Attributes section's privacy marking is pinned too: an attribute carries
 * the "redacted" badge, and the privacy-layer note stands above the table,
 * when its path is listed in `event.redacted` OR its value shows the redaction
 * marker a producer wrote before ingest — the exact marker, the marker inside
 * a longer string, a preview's cut of it, or any of those nested in a
 * structured value. Prose that merely uses the word, another casing, or a
 * shorter cut never does. The scan is cycle-safe, bounded and total, and every
 * value renders byte-for-byte whatever the verdict.
 *
 * **Harness.** Collected by the root `vitest.config.ts` into the
 * `chrome-extension` project (happy-dom). Every fixture value is neutral
 * vocabulary written for this suite (AAP 0.5.4).
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import type { TelemetryEvent } from '@debuggen/protocol';
import type { SourceLocation } from '@debuggen/shared';

import { EventDetails } from '../src/panel/components/EventDetails';
import type { EventAncestry, EventDetailsProps } from '../src/panel/components/EventDetails';

// ---------------------------------------------------------------------------
// Copy the drawer is held to
// ---------------------------------------------------------------------------

const TRACE_ROOT_MESSAGE = 'This event is the root of its trace; it has no parent span.';
const NOT_LOOKED_UP_MESSAGE =
  'This event has a parent span; its ancestors have not been looked up yet.';
const MISSING_PARENT_MESSAGE =
  'This event names a parent span that is not part of the capture, so its ancestors are unknown.';
const MISSING_ANCESTOR_MESSAGE =
  'An ancestor of this event names a parent span that is not part of the capture, so the chain above it is unknown.';
const CYCLE_MESSAGE =
  'The recorded parent links of this trace form a loop, so the full ancestry of this event cannot be stated.';
const MISSING_MARKER =
  'Ancestors above this point are unknown: a parent span is not part of the capture.';
const INCOMPLETE_MARKER =
  'Ancestors above this point are unknown: a parent span was not among the events read.';
const CYCLE_MARKER =
  'Ancestors above this point are unknown: the recorded parent links form a loop.';
const MISSING_SPAN_LABEL = 'Missing span ID';
const LOADING_ANNOUNCEMENT = 'Loading the parent chain…';
const ERROR_TITLE = 'Could not load the parent chain';
const ERROR_FALLBACK_MESSAGE = 'The ancestors of this event could not be looked up in the capture.';
const ATTRIBUTES_CAPTION = 'Attributes of the selected event';
const REDACTION_NOTE =
  'Values marked redacted were replaced by the privacy layer before the event was stored.';
const REDACTED_BADGE = 'redacted';
const UNSERIALISABLE_LABEL = 'Value could not be displayed';

/** The privacy layer's replacement marker, byte for byte. */
const MARKER = '[redacted]';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const ROOT_SPAN = '00f067aa0ba902b7';
const MIDDLE_SPAN = '53995c3f42cd8ad8';
const LEAF_SPAN = 'b7ad6b7169203331';
/** A span id no fixture carries: the gap above a partial chain. */
const ABSENT_SPAN = 'e457b5a2e4d86bd1';

/** Every field a stored event carries apart from its identity and lineage. */
const BASE_EVENT = {
  traceId: TRACE_ID,
  duration: 42.5,
  status: 'ok',
  producerId: 'producer-browser-1',
  sessionId: 'session-0001',
  captureId: 'capture-0001',
  attributes: { 'item.count': 3 },
} as const;

/** The trace root: a browser interaction with no parent span. */
const ROOT_EVENT: TelemetryEvent = {
  ...BASE_EVENT,
  attributes: { ...BASE_EVENT.attributes },
  id: 'event-root',
  spanId: ROOT_SPAN,
  kind: 'interaction',
  tier: 'browser',
  name: 'click primary action',
  startTime: 1_700_000_000_000,
  seq: 1,
  ingestSeq: 1,
};

/** The root's child: a browser request. */
const MIDDLE_EVENT: TelemetryEvent = {
  ...BASE_EVENT,
  attributes: { ...BASE_EVENT.attributes },
  id: 'event-middle',
  spanId: MIDDLE_SPAN,
  parentSpanId: ROOT_SPAN,
  kind: 'fetch',
  tier: 'browser',
  name: 'request item list',
  startTime: 1_700_000_000_010,
  seq: 2,
  ingestSeq: 2,
};

/** The selected event: the server span handling that request. */
const LEAF_EVENT: TelemetryEvent = {
  ...BASE_EVENT,
  attributes: { ...BASE_EVENT.attributes },
  id: 'event-leaf',
  spanId: LEAF_SPAN,
  parentSpanId: MIDDLE_SPAN,
  kind: 'http.server',
  tier: 'server',
  name: 'handle item list request',
  producerId: 'producer-server-1',
  startTime: 1_700_000_000_020,
  seq: 1,
  ingestSeq: 3,
};

/** A location the Source chip opens, in the shape the service resolves. */
const SOURCE: SourceLocation = {
  file: 'src/features/items/ItemList.tsx',
  line: 18,
  column: 5,
  symbol: 'ItemList',
  resolvedBy: 'patch',
  confidence: 0.9,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Renders the drawer with a no-op `onOpenSource` unless one is given.
 *
 * @param props Everything but the required handler, which may be overridden.
 * @returns The Testing Library render result.
 */
function renderDrawer(
  props: Omit<EventDetailsProps, 'onOpenSource'> & Partial<Pick<EventDetailsProps, 'onOpenSource'>>,
): ReturnType<typeof render> {
  return render(<EventDetails onOpenSource={vi.fn()} {...props} />);
}

/**
 * The Parent chain section: a level-3 heading naming a region. Throws when the
 * section is absent, which is itself the failure every state guards against.
 *
 * @returns The labelled region element.
 */
function parentChainRegion(): HTMLElement {
  expect(screen.getByRole('heading', { level: 3, name: 'Parent chain' })).toBeTruthy();
  return screen.getByRole('region', { name: 'Parent chain' });
}

/**
 * The items of the region's ordered list, in document order.
 *
 * @param region The Parent chain region.
 * @returns The `<li>` elements.
 */
function chainItems(region: HTMLElement): HTMLElement[] {
  const list = within(region).getByRole('list');
  expect(list.tagName).toBe('OL');
  return within(list).getAllByRole('listitem');
}

/**
 * Asserts that the region shows `spanId` as copyable `Code` behind the
 * "Missing span ID" label.
 *
 * @param region The Parent chain region.
 * @param spanId The span id expected.
 */
function expectMissingSpanId(region: HTMLElement, spanId: string): void {
  expect(within(region).getByText(MISSING_SPAN_LABEL)).toBeTruthy();
  const value = within(region).getByText(spanId);
  expect(value.closest('code')).not.toBeNull();
}

/**
 * Asserts that the last item is the selected event, marked `aria-current`.
 *
 * @param item The last list item.
 * @param event The selected event.
 */
function expectCurrentItem(item: HTMLElement | undefined, event: TelemetryEvent): void {
  expect(item).toBeDefined();
  if (item === undefined) {
    return;
  }
  expect(item.getAttribute('aria-current')).toBe('true');
  expect(item.textContent).toContain(event.name);
  expect(within(item).queryByRole('button')).toBeNull();
}

let consoleError: MockInstance;
let consoleWarn: MockInstance;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  expect(consoleError.mock.calls).toEqual([]);
  expect(consoleWarn.mock.calls).toEqual([]);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. A trace root
// ---------------------------------------------------------------------------

describe('EventDetails parent chain — a trace root', () => {
  it('states that the event is its trace root when no ancestry is supplied', () => {
    renderDrawer({ event: ROOT_EVENT });

    const region = parentChainRegion();
    expect(within(region).getByText(TRACE_ROOT_MESSAGE)).toBeTruthy();
    expect(within(region).queryByRole('list')).toBeNull();
  });

  it('ignores any supplied ancestry, including a failed lookup', () => {
    renderDrawer({
      event: ROOT_EVENT,
      ancestry: { state: 'error', error: { message: 'The lookup failed.' } },
      onRetryAncestry: vi.fn(),
    });

    const region = parentChainRegion();
    expect(within(region).getByText(TRACE_ROOT_MESSAGE)).toBeTruthy();
    expect(within(region).queryByText(ERROR_TITLE)).toBeNull();
    expect(within(region).queryByRole('button')).toBeNull();
  });

  it('ignores a supplied chain rather than listing ancestors for a root', () => {
    renderDrawer({ event: ROOT_EVENT, ancestry: { state: 'complete', ancestors: [MIDDLE_EVENT] } });

    const region = parentChainRegion();
    expect(within(region).getByText(TRACE_ROOT_MESSAGE)).toBeTruthy();
    expect(within(region).queryByText(MIDDLE_EVENT.name)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. No lookup outcome
// ---------------------------------------------------------------------------

describe('EventDetails parent chain — ancestry not supplied', () => {
  it('says the ancestors have not been looked up, never that they are missing', () => {
    renderDrawer({ event: LEAF_EVENT });

    const region = parentChainRegion();
    expect(within(region).getByText(NOT_LOOKED_UP_MESSAGE)).toBeTruthy();
    expect(region.textContent).not.toContain('not part of the capture');
    expect(within(region).queryByText(MISSING_SPAN_LABEL)).toBeNull();
    expect(within(region).queryByRole('list')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Loading
// ---------------------------------------------------------------------------

describe('EventDetails parent chain — loading', () => {
  it('renders one announced skeleton row inside the section', () => {
    renderDrawer({ event: LEAF_EVENT, ancestry: { state: 'loading' } });

    const region = parentChainRegion();
    const status = within(region).getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.textContent).toContain(LOADING_ANNOUNCEMENT);
    expect(status.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
    expect(within(region).queryByRole('list')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Complete
// ---------------------------------------------------------------------------

describe('EventDetails parent chain — complete', () => {
  it('lists the ancestors from the trace root down, then the selected event as current', () => {
    renderDrawer({
      event: LEAF_EVENT,
      ancestry: { state: 'complete', ancestors: [ROOT_EVENT, MIDDLE_EVENT] },
      onSelectEvent: vi.fn(),
    });

    const items = chainItems(parentChainRegion());
    expect(items).toHaveLength(3);
    expect(within(items[0] as HTMLElement).getByRole('button').textContent).toContain(
      ROOT_EVENT.name,
    );
    expect(within(items[1] as HTMLElement).getByRole('button').textContent).toContain(
      MIDDLE_EVENT.name,
    );
    expectCurrentItem(items[2], LEAF_EVENT);
  });

  it('selects an ancestor with its full reference', async () => {
    const user = userEvent.setup();
    const onSelectEvent = vi.fn();
    renderDrawer({
      event: LEAF_EVENT,
      ancestry: { state: 'complete', ancestors: [ROOT_EVENT, MIDDLE_EVENT] },
      onSelectEvent,
    });

    const region = parentChainRegion();
    await user.click(within(region).getByRole('button', { name: new RegExp(ROOT_EVENT.name) }));

    expect(onSelectEvent).toHaveBeenCalledTimes(1);
    expect(onSelectEvent).toHaveBeenCalledWith({
      eventId: ROOT_EVENT.id,
      traceId: TRACE_ID,
      spanId: ROOT_SPAN,
      kind: 'interaction',
    });
  });

  it('renders ancestors as plain text when no selection handler exists', () => {
    renderDrawer({
      event: LEAF_EVENT,
      ancestry: { state: 'complete', ancestors: [ROOT_EVENT, MIDDLE_EVENT] },
    });

    const region = parentChainRegion();
    const items = chainItems(region);
    expect(items).toHaveLength(3);
    expect(within(region).queryAllByRole('button')).toHaveLength(0);
    expect(items[0]?.textContent).toContain(ROOT_EVENT.name);
  });

  it("ignores an entry carrying the selected event's own id", () => {
    renderDrawer({
      event: LEAF_EVENT,
      ancestry: { state: 'complete', ancestors: [ROOT_EVENT, MIDDLE_EVENT, LEAF_EVENT] },
      onSelectEvent: vi.fn(),
    });

    const items = chainItems(parentChainRegion());
    expect(items).toHaveLength(3);
    expect(within(parentChainRegion()).queryAllByRole('button')).toHaveLength(2);
    expectCurrentItem(items[2], LEAF_EVENT);
  });

  it('shows an empty "complete" chain as a missing immediate parent, never as complete', () => {
    renderDrawer({ event: LEAF_EVENT, ancestry: { state: 'complete', ancestors: [] } });

    const region = parentChainRegion();
    expect(within(region).getByText(MISSING_PARENT_MESSAGE)).toBeTruthy();
    expectMissingSpanId(region, MIDDLE_SPAN);
    expect(within(region).queryByRole('list')).toBeNull();
  });

  it('shows a "complete" chain holding only the event itself as a missing immediate parent', () => {
    renderDrawer({ event: LEAF_EVENT, ancestry: { state: 'complete', ancestors: [LEAF_EVENT] } });

    const region = parentChainRegion();
    expect(within(region).getByText(MISSING_PARENT_MESSAGE)).toBeTruthy();
    expectMissingSpanId(region, MIDDLE_SPAN);
  });

  it('shows a "complete" chain whose top still names a parent as missing at that parent', () => {
    renderDrawer({ event: LEAF_EVENT, ancestry: { state: 'complete', ancestors: [MIDDLE_EVENT] } });

    const region = parentChainRegion();
    expect(within(region).getByText(MISSING_ANCESTOR_MESSAGE)).toBeTruthy();
    expectMissingSpanId(region, ROOT_SPAN);
    const items = chainItems(region);
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toBe(MISSING_MARKER);
  });
});

// ---------------------------------------------------------------------------
// 5. Missing
// ---------------------------------------------------------------------------

describe('EventDetails parent chain — missing', () => {
  it('states a missing immediate parent and shows its span id', () => {
    renderDrawer({
      event: LEAF_EVENT,
      ancestry: { state: 'missing', missingSpanId: MIDDLE_SPAN, ancestors: [] },
    });

    const region = parentChainRegion();
    expect(within(region).getByText(MISSING_PARENT_MESSAGE)).toBeTruthy();
    expectMissingSpanId(region, MIDDLE_SPAN);
    expect(within(region).queryByRole('list')).toBeNull();
  });

  it('drops ancestors supplied with a gap at the immediate parent', () => {
    renderDrawer({
      event: LEAF_EVENT,
      ancestry: { state: 'missing', missingSpanId: MIDDLE_SPAN, ancestors: [ROOT_EVENT] },
      onSelectEvent: vi.fn(),
    });

    const region = parentChainRegion();
    expect(within(region).getByText(MISSING_PARENT_MESSAGE)).toBeTruthy();
    expect(within(region).queryByRole('list')).toBeNull();
    expect(within(region).queryByText(ROOT_EVENT.name)).toBeNull();
  });

  it('states a missing higher ancestor with the partial chain behind a marker', async () => {
    const user = userEvent.setup();
    const onSelectEvent = vi.fn();
    renderDrawer({
      event: LEAF_EVENT,
      ancestry: { state: 'missing', missingSpanId: ROOT_SPAN, ancestors: [MIDDLE_EVENT] },
      onSelectEvent,
    });

    const region = parentChainRegion();
    expect(within(region).getByText(MISSING_ANCESTOR_MESSAGE)).toBeTruthy();
    expect(within(region).queryByText(MISSING_PARENT_MESSAGE)).toBeNull();
    expectMissingSpanId(region, ROOT_SPAN);

    const items = chainItems(region);
    expect(items).toHaveLength(3);
    const marker = items[0] as HTMLElement;
    expect(marker.textContent).toBe(MISSING_MARKER);
    expect(within(marker).queryByRole('button')).toBeNull();
    expect(marker.getAttribute('aria-current')).toBeNull();
    expectCurrentItem(items[2], LEAF_EVENT);

    await user.click(within(items[1] as HTMLElement).getByRole('button'));
    expect(onSelectEvent).toHaveBeenCalledTimes(1);
    expect(onSelectEvent).toHaveBeenCalledWith({
      eventId: MIDDLE_EVENT.id,
      traceId: TRACE_ID,
      spanId: MIDDLE_SPAN,
      kind: 'fetch',
    });
  });

  it('states a higher gap without a list when nothing below it was supplied', () => {
    renderDrawer({
      event: LEAF_EVENT,
      ancestry: { state: 'missing', missingSpanId: ABSENT_SPAN, ancestors: [] },
    });

    const region = parentChainRegion();
    expect(within(region).getByText(MISSING_ANCESTOR_MESSAGE)).toBeTruthy();
    expectMissingSpanId(region, ABSENT_SPAN);
    expect(within(region).queryByRole('list')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Incomplete
// ---------------------------------------------------------------------------

describe('EventDetails parent chain — incomplete', () => {
  /** The count as the component formats it: the reader's locale, grouped. */
  function grouped(count: number): string {
    return new Intl.NumberFormat(undefined, {
      useGrouping: true,
      maximumFractionDigits: 0,
    }).format(count);
  }

  it('states the grouped number of stored events read without finding the parent', () => {
    renderDrawer({
      event: LEAF_EVENT,
      ancestry: {
        state: 'incomplete',
        missingSpanId: MIDDLE_SPAN,
        ancestors: [],
        eventsRead: 12_500,
      },
    });

    const region = parentChainRegion();
    expect(
      within(region).getByText(
        `The parent span of this event was not among the ${grouped(12_500)} stored events of this trace that were read, so the chain above it is not shown.`,
      ),
    ).toBeTruthy();
    expectMissingSpanId(region, MIDDLE_SPAN);
    expect(within(region).queryByRole('list')).toBeNull();
  });

  it('states a higher gap with the partial chain behind its marker', () => {
    renderDrawer({
      event: LEAF_EVENT,
      ancestry: {
        state: 'incomplete',
        missingSpanId: ROOT_SPAN,
        ancestors: [MIDDLE_EVENT],
        eventsRead: 5_000,
      },
      onSelectEvent: vi.fn(),
    });

    const region = parentChainRegion();
    expect(
      within(region).getByText(
        `A parent span further up the chain was not among the ${grouped(5_000)} stored events of this trace that were read, so the chain above it is not shown.`,
      ),
    ).toBeTruthy();
    expectMissingSpanId(region, ROOT_SPAN);
    const items = chainItems(region);
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toBe(INCOMPLETE_MARKER);
    expect(within(items[1] as HTMLElement).getByRole('button').textContent).toContain(
      MIDDLE_EVENT.name,
    );
    expectCurrentItem(items[2], LEAF_EVENT);
  });

  it('uses the singular for one event read and omits an unusable count', () => {
    const { rerender } = renderDrawer({
      event: LEAF_EVENT,
      ancestry: { state: 'incomplete', missingSpanId: MIDDLE_SPAN, ancestors: [], eventsRead: 1 },
    });
    expect(
      within(parentChainRegion()).getByText(
        'The parent span of this event was not among the 1 stored event of this trace that was read, so the chain above it is not shown.',
      ),
    ).toBeTruthy();

    rerender(
      <EventDetails
        event={LEAF_EVENT}
        onOpenSource={vi.fn()}
        ancestry={{
          state: 'incomplete',
          missingSpanId: MIDDLE_SPAN,
          ancestors: [],
          eventsRead: Number.NaN,
        }}
      />,
    );
    expect(
      within(parentChainRegion()).getByText(
        'The parent span of this event was not among the stored events of this trace that were read, so the chain above it is not shown.',
      ),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 7. Cycle
// ---------------------------------------------------------------------------

describe('EventDetails parent chain — cycle', () => {
  it('states the loop and lists the chain up to it behind a marker', () => {
    renderDrawer({
      event: LEAF_EVENT,
      ancestry: { state: 'cycle', ancestors: [MIDDLE_EVENT] },
      onSelectEvent: vi.fn(),
    });

    const region = parentChainRegion();
    expect(within(region).getByText(CYCLE_MESSAGE)).toBeTruthy();
    expect(within(region).queryByText(MISSING_SPAN_LABEL)).toBeNull();
    const items = chainItems(region);
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toBe(CYCLE_MARKER);
    expect(within(items[0] as HTMLElement).queryByRole('button')).toBeNull();
    expectCurrentItem(items[2], LEAF_EVENT);
  });

  it('states the loop alone when nothing below it is known', () => {
    renderDrawer({ event: LEAF_EVENT, ancestry: { state: 'cycle', ancestors: [LEAF_EVENT] } });

    const region = parentChainRegion();
    expect(within(region).getByText(CYCLE_MESSAGE)).toBeTruthy();
    expect(within(region).queryByRole('list')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. Error
// ---------------------------------------------------------------------------

describe('EventDetails parent chain — error', () => {
  const failed: EventAncestry = {
    state: 'error',
    error: {
      message: 'The stored trace could not be read.',
      hint: 'Check that the local service is running, then retry.',
      code: 'SERVICE_UNAVAILABLE',
    },
  };

  it('renders a polite error with message, hint and code, and retries once per activation', async () => {
    const user = userEvent.setup();
    const onRetryAncestry = vi.fn();
    const onRetry = vi.fn();
    renderDrawer({ event: LEAF_EVENT, ancestry: failed, onRetryAncestry, onRetry });

    const region = parentChainRegion();
    expect(within(region).queryByRole('alert')).toBeNull();
    const status = within(region).getByRole('status');
    expect(within(status).getByText(ERROR_TITLE)).toBeTruthy();
    expect(within(status).getByText('The stored trace could not be read.')).toBeTruthy();
    expect(
      within(status).getByText('Check that the local service is running, then retry.'),
    ).toBeTruthy();
    expect(within(status).getByText('SERVICE_UNAVAILABLE')).toBeTruthy();

    await user.click(within(status).getByRole('button', { name: 'Retry' }));
    expect(onRetryAncestry).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('renders no retry control without onRetryAncestry', () => {
    renderDrawer({ event: LEAF_EVENT, ancestry: failed });

    const region = parentChainRegion();
    expect(within(region).getByText(ERROR_TITLE)).toBeTruthy();
    expect(within(region).queryByRole('button')).toBeNull();
  });

  it('falls back to a generic message when the reported one is blank', () => {
    renderDrawer({ event: LEAF_EVENT, ancestry: { state: 'error', error: { message: '  ' } } });

    expect(within(parentChainRegion()).getByText(ERROR_FALLBACK_MESSAGE)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Focus continuity and the Source chip
// ---------------------------------------------------------------------------

describe('EventDetails interactions beside the chain states', () => {
  it("moves focus to the newly shown event's name after an ancestor is activated", async () => {
    const user = userEvent.setup();
    const onSelectEvent = vi.fn();
    const onOpenSource = vi.fn();
    const { rerender } = render(
      <EventDetails
        event={LEAF_EVENT}
        ancestry={{ state: 'complete', ancestors: [ROOT_EVENT, MIDDLE_EVENT] }}
        onSelectEvent={onSelectEvent}
        onOpenSource={onOpenSource}
      />,
    );

    await user.click(
      within(parentChainRegion()).getByRole('button', { name: new RegExp(MIDDLE_EVENT.name) }),
    );
    expect(onSelectEvent).toHaveBeenCalledTimes(1);

    rerender(
      <EventDetails
        event={MIDDLE_EVENT}
        ancestry={{ state: 'loading' }}
        onSelectEvent={onSelectEvent}
        onOpenSource={onOpenSource}
      />,
    );

    const focused = document.activeElement;
    expect(focused?.tagName).toBe('P');
    expect(focused?.textContent).toBe(MIDDLE_EVENT.name);
  });

  it('opens the source location through onOpenSource, unmodified', async () => {
    const user = userEvent.setup();
    const onOpenSource = vi.fn();
    renderDrawer({
      event: { ...LEAF_EVENT, source: SOURCE },
      ancestry: { state: 'complete', ancestors: [ROOT_EVENT, MIDDLE_EVENT] },
      onOpenSource,
    });

    const sourceRegion = screen.getByRole('region', { name: 'Source' });
    await user.click(within(sourceRegion).getByRole('button', { name: /open/i }));

    expect(onOpenSource).toHaveBeenCalledTimes(1);
    expect(onOpenSource.mock.calls[0]?.[0]).toBe(SOURCE);
  });
});

// ---------------------------------------------------------------------------
// The Attributes section: marking what the privacy layer replaced
// ---------------------------------------------------------------------------

/**
 * The selected event with `attributes` and, only when given, a `redacted`
 * path list. Without one the event is exactly what the store holds for a value
 * a producer redacted before ingest: the service's redactor lists no path for
 * a value that arrived already replaced.
 *
 * @param attributes The attributes bag.
 * @param redacted The attribute paths the service's redactor replaced.
 * @returns A trace-root event carrying them.
 */
function eventWithAttributes(
  attributes: TelemetryEvent['attributes'],
  redacted?: readonly string[],
): TelemetryEvent {
  return {
    ...ROOT_EVENT,
    attributes,
    ...(redacted === undefined ? {} : { redacted: [...redacted] }),
  };
}

/**
 * The attributes table's data row for `key`: the row whose header cell is the
 * key. Fails the test when no such row renders.
 *
 * @param key The attribute key.
 * @returns The `role="row"` element.
 */
function attributeRow(key: string): HTMLElement {
  const grid = screen.getByRole('grid', { name: ATTRIBUTES_CAPTION });
  const header = within(grid)
    .getAllByRole('rowheader')
    .find((cell) => cell.textContent === key);
  const row = header?.closest('[role="row"]');
  if (!(row instanceof HTMLElement)) {
    throw new Error(`No attributes row renders for the key "${key}".`);
  }
  return row;
}

/**
 * The text of the `Code` element holding the value of `key`'s row, exactly as
 * rendered — what "byte-for-byte" is checked against.
 *
 * @param key The attribute key.
 * @returns The value's text content.
 */
function renderedValue(key: string): string | null {
  const codes = within(attributeRow(key)).getAllByText(
    (_content, element) => element?.tagName === 'CODE',
  );
  return codes.at(-1)?.textContent ?? null;
}

/**
 * The "redacted" badge of `key`'s row, or `null`. The captured value itself is
 * `Code`, which is ignored, so a value that is the word "redacted" is never
 * mistaken for the badge.
 *
 * @param key The attribute key.
 * @returns The badge's text element, or `null` when the row has none.
 */
function redactedBadge(key: string): HTMLElement | null {
  return within(attributeRow(key)).queryByText(REDACTED_BADGE, { ignore: 'code, script, style' });
}

/**
 * Asserts which attribute rows carry the "redacted" badge and which do not,
 * and that the privacy-layer note stands above the table exactly when any
 * does.
 *
 * @param marked Keys whose rows must carry the badge.
 * @param unmarked Keys whose rows must not.
 */
function expectRedactionMarking(marked: readonly string[], unmarked: readonly string[]): void {
  for (const key of marked) {
    expect(redactedBadge(key), key).not.toBeNull();
  }
  for (const key of unmarked) {
    expect(redactedBadge(key), key).toBeNull();
  }
  const region = screen.getByRole('region', { name: 'Attributes' });
  const note = within(region).queryByText(REDACTION_NOTE);
  if (marked.length === 0) {
    expect(note).toBeNull();
    return;
  }
  expect(note).not.toBeNull();
  const grid = within(region).getByRole('grid', { name: ATTRIBUTES_CAPTION });
  // The note precedes the table in document order: it is read first.
  expect(
    note === null ? 0 : note.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
}

describe('EventDetails attributes — values the privacy layer replaced', () => {
  it('marks a value that is exactly the marker although no path lists it, and shows the note', () => {
    renderDrawer({
      event: eventWithAttributes({
        method: 'GET',
        'http.status_code': 200,
        authorization: MARKER,
        note: 'plain value',
      }),
    });

    expectRedactionMarking(['authorization'], ['method', 'http.status_code', 'note']);
    expect(renderedValue('authorization')).toBe(MARKER);
  });

  it('marks a structured value with the marker nested at any depth, rendered as captured', () => {
    const props = { token: MARKER, count: 0 };
    const state = { form: { fields: [{ name: 'email' }, { name: 'secret', value: MARKER }] } };
    renderDrawer({
      event: eventWithAttributes({ props, state, sizes: [1, 2, 3], label: 'Save' }),
    });

    expectRedactionMarking(['props', 'state'], ['sizes', 'label']);
    expect(renderedValue('props')).toBe(JSON.stringify(props, null, 2));
    expect(renderedValue('state')).toBe(JSON.stringify(state, null, 2));
  });

  it('marks the marker in place of a credential inside a longer string', () => {
    renderDrawer({
      event: eventWithAttributes({
        header: 'Authorization: [redacted]',
        'db.connection': 'postgres://[redacted]@127.0.0.1:5432/items',
        message: 'retrying with Bearer [redacted]',
      }),
    });

    expectRedactionMarking(['header', 'db.connection', 'message'], []);
    expect(renderedValue('message')).toBe('retrying with Bearer [redacted]');
  });

  it('marks a preview whose bound cut through the marker, but not a shorter, ambiguous cut', () => {
    renderDrawer({
      event: eventWithAttributes({
        cutPreview: '"Bearer [redac\u2026',
        nestedCut: { preview: '{ token: "[red\u2026', truncated: true },
        ambiguousCut: 'items [re\u2026',
        arrayCut: 'Array(3) [\u2026',
      }),
    });

    expectRedactionMarking(['cutPreview', 'nestedCut'], ['ambiguousCut', 'arrayCut']);
    expect(renderedValue('cutPreview')).toBe('"Bearer [redac\u2026');
  });

  it('never marks prose that uses the word, another casing, or the word without brackets', () => {
    renderDrawer({
      event: eventWithAttributes({
        note: 'the token was not redacted',
        status: 'redacted',
        upper: '[REDACTED]',
        spaced: '[ redacted ]',
        nested: { reason: 'partially redacted upstream', list: ['redacted'] },
      }),
    });

    expectRedactionMarking([], ['note', 'status', 'upper', 'spaced', 'nested']);
  });

  it('never reads a key as a value: a key spelled as the marker marks nothing', () => {
    renderDrawer({ event: eventWithAttributes({ lookup: { [MARKER]: 'plain value' } }) });

    expectRedactionMarking([], ['lookup']);
  });

  it('still marks a value whose path the service redactor listed, and only that value', () => {
    renderDrawer({
      event: eventWithAttributes(
        { 'item.count': 3, 'user.email': 'hidden-by-policy', headers: { accept: 'text/html' } },
        ['user.email', 'headers.cookie'],
      ),
    });

    expectRedactionMarking(['user.email', 'headers'], ['item.count']);
    expect(renderedValue('user.email')).toBe('hidden-by-policy');
  });

  it('scans a cyclic value once without throwing, finding a marker behind the cycle', () => {
    const withMarker: Record<string, unknown> = { name: 'node' };
    withMarker.self = withMarker;
    withMarker.child = { back: withMarker, secret: MARKER };
    const withoutMarker: Record<string, unknown> = { name: 'node' };
    withoutMarker.self = withoutMarker;
    renderDrawer({ event: eventWithAttributes({ withMarker, withoutMarker }) });

    expectRedactionMarking(['withMarker'], ['withoutMarker']);
    expect(renderedValue('withoutMarker')).toContain('[Circular]');
  });

  it('finds a marker nested far deeper than any captured value goes', () => {
    let deep: unknown = { secret: MARKER };
    for (let depth = 0; depth < 200; depth += 1) {
      deep = { next: deep };
    }
    renderDrawer({ event: eventWithAttributes({ deep }) });

    expectRedactionMarking(['deep'], []);
  });

  it('bounds the scan: a marker beyond the values it reads is not claimed', () => {
    const withinBound = [...Array.from({ length: 100 }, () => 'plain value'), MARKER];
    const beyondBound = [...Array.from({ length: 5_000 }, () => 'plain value'), MARKER];
    renderDrawer({ event: eventWithAttributes({ withinBound, beyondBound }) });

    expectRedactionMarking(['withinBound'], ['beyondBound']);
  });

  it('degrades an unreadable value without a claim and without taking the drawer down', () => {
    const unreadable = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get(): never {
        throw new Error('This member cannot be read.');
      },
    });
    renderDrawer({ event: eventWithAttributes({ unreadable, header: MARKER }) });

    expectRedactionMarking(['header'], ['unreadable']);
    expect(within(attributeRow('unreadable')).getByText(UNSERIALISABLE_LABEL)).toBeTruthy();
  });
});
