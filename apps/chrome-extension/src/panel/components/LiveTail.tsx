/**
 * `LiveTail` — the collapsible bottom pane of the "Debug Generator" DevTools panel that streams
 * redacted telemetry events while a capture is running (AAP 0.7.3: "Collapsible bottom `LiveTail`
 * streams redacted events during capture").
 *
 * ## Where the data comes from, and where it does not
 *
 * The service pushes `telemetry.tail { sessionId, events }` frames (AAP 0.4.2); the service worker
 * relays them to the panel, `../state/connection` hands each one to the store, and the store keeps
 * the newest {@link LIVE_TAIL_MAX_EVENTS} events in its bounded `liveTail` buffer. The composition
 * root reads that buffer and passes it here as `events`.
 *
 * Beside the events the pane shows the capture's notices — the store's bounded `tailNotices`
 * slice, which records a same-origin navigation of the bound tab while a capture runs (AAP 0.5.5:
 * "Application reloads mid-session → event log entry 'Page reloaded during capture'; the same
 * captureId continues"). A root that has them passes them as `notices`; a root that does not is
 * served from the store through `usePanelStoreSelector`, a read-only subscription to that one
 * slice, so the entry appears wherever the pane is mounted.
 *
 * Those two slices are this component's only inputs: it never queries
 * `POST /sessions/:id/panel-data` (that is `PanelView`'s job, through `PanelHost` and the
 * `DataProvider`), never opens a port or a socket, and never writes the store.
 *
 * Two data paths exist in the panel and they must not be confused. A generated panel's nodes are
 * server-paged queries: the service filters, sorts and pages them, and `DataTable` renders a page
 * as given. The tail is a push-fed, in-memory, already-bounded buffer, so narrowing it by kind or
 * text is done here, locally — which is legitimate precisely because nothing beyond the buffer
 * exists for a filter to miss, and the truncation notice says so when the buffer did drop events.
 *
 * ## Privacy (AAP 0.5.2)
 *
 * Every event was redacted by the service before it was persisted and again before it was tailed
 * (`apps/local-service/src/telemetry/ingest.ts`). This component renders what arrived: it does not
 * re-redact, log, copy or forward an event anywhere. Its only outbound calls are the two explicit
 * actions, the collapse toggle and the retry.
 *
 * A capture notice is data, not wording: the store records its kind, capture, tab, document URL
 * and time, and this component words it ({@link NOTICE_LABELS}). Of the URL only the path is
 * shown — the origin is the session's own, since a notice is recorded for same-origin navigations
 * only, and the query and fragment are left out entirely, so a query value that reached the panel
 * unredacted is still never displayed (AAP 0.5.2 retains the path).
 *
 * ## Why `actions` is an explicit, required prop
 *
 * The pane renders OUTSIDE `PanelHost`, so no `PanelActionsContext` is mounted above it and
 * `usePanelActions()` would answer `undefined`. A `SourceLink` resolves its handler as
 * *explicit prop → context → inert chip*, so without an explicit handler every chip here would be a
 * dead label. The prop is typed from the renderer's view form, `PanelViewActions`, whose two
 * members are required: `Pick` over the `PanelActions` union would make both optional (each form
 * declares the other's members as `?: never`), which is exactly the dead-chip hole this closes.
 * `../actions`' `createPanelActions()` result satisfies it as it stands.
 *
 * ## Composition
 *
 *   Section (card)                      the pane's framed surface
 *   ├── Stack (horizontal)              the header bar, always rendered
 *   │   ├── Button                      the collapse control: aria-expanded + aria-controls
 *   │   └── Badge                       "Streaming", while a capture is running
 *   └── Stack#region                    the stream region, rendered only while expanded
 *       ├── ErrorState                  a stream failure, with retry when the root offers one
 *       ├── NoticeList                  the capture's notices, newest first, while there are any:
 *       │   └── Text[role=listitem]     time, the worded notice as a Badge, the document's path
 *       ├── LoadingState | EmptyState   while no event has arrived
 *       └── TailStream                  while the tail holds events:
 *           ├── Toolbar                 search + kind filter + result statements
 *           └── div (event boundary)    pauses the grid while the reader inspects it
 *               └── DataTable           the virtualized, keyboard-navigable grid of events
 *
 * ## Order, and pausing while the reader inspects
 *
 * Rows are presented newest first. The tail grows at its end many times a second and this pane
 * owns no scroll position — the grid's own virtual viewport is the only scroller, and reaching into
 * it would target the design system's internals — so newest-first is what keeps the latest event
 * visible without the reader scrolling. The order is fixed: no column is sortable, `DataTable`
 * never re-orders, and the order is stated in the grid's caption and in the toolbar.
 *
 * Rows arriving above the ones being read would move them away from the reader — out of a scrolled
 * viewport, and, because the grid's roving tab stop and virtual window follow row positions, out
 * of the DOM together with keyboard focus. So while the pointer is over the grid or focus is
 * inside it, the grid holds still on the tail as it stood when the inspection began, and says so
 * with a "Paused while you inspect" statement that counts what is waiting (see `InspectionHold`).
 * Leaving the grid resumes the live stream.
 *
 * ## Accessibility
 *
 * - The collapse control is a real `Button` with `aria-expanded`, and its name states what it
 *   toggles, how many events the tail holds and how many capture notices it shows, so the
 *   collapsed pane is still informative.
 * - The grid is `DataTable`'s: one Tab stop, roving focus, arrow keys, Enter/Space to select, exact
 *   row and column counts, and `aria-selected` on the row that matches the selected event. Every
 *   chip inside a cell carries `tabIndex={-1}`, as the grid pattern requires.
 * - Kinds and statuses are words on badges; colour only reinforces them.
 * - No live region is placed over the stream: it can change many times a second and would flood a
 *   screen reader. The count travels in the collapse control's name instead. `LoadingState` and
 *   `ErrorState` keep their own one-shot announcements.
 * - The capture notices are a labelled list (`role="list"` on the `Text` block, `role="listitem"`
 *   on each entry — no primitive renders a list, and the roles keep the count and order announced
 *   without the markers a raw list would draw). The list is not a live region either; how many
 *   notices exist is part of the collapse control's name, so a collapsed pane still says so.
 *
 * ## Design-system compliance (AAP 0.6.2, 0.6.4)
 *
 * Every visual value resolves through a renderer component — `Section`, `Stack`, `Button`,
 * `Badge`, `Toolbar`, `DataTable`, `Text`, `DurationCell`, `SourceLink`, `EmptyState`,
 * `LoadingState` and `ErrorState` — and so through the `--dg-*` tokens behind them. This file
 * writes no inline style, no length, no colour and no class name of its own; each grid column
 * declares a `DataTable` width role for its content, which the primitive resolves to a token-built
 * track.
 *
 * ## Boundaries
 *
 * No transport, no `chrome.*` API, no store writes and no validation — the one store read is the
 * `tailNotices` fallback described above, which yields an empty list in a fresh store — so the
 * pane renders unchanged when the panel document is opened directly as an extension page with
 * `chrome.devtools` undefined. The copy is generic product vocabulary and names nothing from any
 * inspected application (AAP 0.5.4).
 *
 * @module apps/chrome-extension/src/panel/components/LiveTail
 */
import {
  Badge,
  Button,
  DataTable,
  DurationCell,
  EmptyState,
  ErrorState,
  LoadingState,
  matchesPanelSelection,
  Section,
  SourceLink,
  Stack,
  Text,
  Toolbar,
} from '@debuggen/panel-renderer';
import type {
  BadgeTone,
  DataTableColumn,
  PanelEventRef,
  PanelViewActions,
  SelectOption,
  ToolbarSelect,
  ToolbarStatus,
} from '@debuggen/panel-renderer';
import type { EventRef } from '@debuggen/panel-schema';
import type { TelemetryEvent } from '@debuggen/protocol';
import { assertNever } from '@debuggen/shared';
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import type { FocusEvent as ReactFocusEvent, ReactElement, ReactNode } from 'react';

import { LIVE_TAIL_MAX_EVENTS, usePanelStoreSelector } from '../state/session-store';
import type { PanelSnapshot, PanelTailNotice, PanelTailNoticeKind } from '../state/session-store';

// ---------------------------------------------------------------------------
// Vocabulary reached through the wire type
// ---------------------------------------------------------------------------

/** An event kind, exactly as the tailed `TelemetryEvent` types it. */
type TelemetryKind = TelemetryEvent['kind'];

/** An event's span status, exactly as the tailed `TelemetryEvent` types it. */
type TelemetryStatus = TelemetryEvent['status'];

/** The kind filter's "no narrowing" value; never a kind, which are all non-empty. */
const ALL_KINDS_VALUE = '';

/** What the kind filter holds: one kind present in the tail, or no narrowing. */
type KindFilter = TelemetryKind | typeof ALL_KINDS_VALUE;

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/** The collapse control's verb while the stream is hidden. */
const SHOW_VERB = 'Show';

/** The collapse control's verb while the stream is shown. */
const HIDE_VERB = 'Hide';

/** What the collapse control toggles, after its verb. */
const PANE_SUBJECT = 'live events';

/** The header badge shown while a capture is running. */
const STREAMING_LABEL = 'Streaming';

/** The grid's accessible name; it states the fixed order too. */
const TABLE_CAPTION = 'Live events, newest first';

/** The toolbar statement of the fixed order. */
const ORDER_STATUS_LABEL = 'Newest first';

/** The filter bar's group name. */
const FILTER_GROUP_LABEL = 'Live event filters';

/** The search field's accessible name. */
const SEARCH_LABEL = 'Search live events';

/** The search field's hint text. */
const SEARCH_PLACEHOLDER = 'Filter by name or kind';

/** The kind filter's stable identity within the bar. */
const KIND_SELECT_ID = 'kind';

/** The kind filter's accessible name. */
const KIND_SELECT_LABEL = 'Event kind';

/** The kind filter's "no narrowing" option. */
const ALL_KINDS_LABEL = 'All kinds';

/** Announced while a capture runs and no event has arrived yet. */
const AWAITING_LABEL = 'Waiting for live events…';

/** The first line of the pane's empty state, outside a capture. */
const IDLE_TITLE = 'No live events yet';

/** The explanation of the pane's empty state, outside a capture. */
const IDLE_MESSAGE =
  'Events stream into this pane while a capture is running. Start one and reproduce the issue.';

/** The first line of the state shown when the filters match nothing. */
const NO_MATCH_TITLE = 'No matching events';

/** The second sentence of the no-match explanation: how to get the events back. */
const NO_MATCH_HINT = 'Clear the search or choose "All kinds" to see every event in the tail.';

/** The first line of a stream failure. */
const FAILURE_TITLE = 'The live event stream is unavailable';

/** A failure's explanation when the root supplied a blank message. */
const FAILURE_FALLBACK_MESSAGE = 'The panel stopped receiving live events from the service.';

/** The failure's retry control. */
const RETRY_LABEL = 'Try again';

/** The status badge a failed span carries beside its name. */
const FAILED_STATUS_LABEL = 'error';

/** Shown in the time column for a timestamp that cannot be formatted. */
const UNKNOWN_TIME_LABEL = 'unknown';

/** The capture notices' accessible name; it states their order too. */
const NOTICES_LABEL = 'Capture notices, newest first';

/**
 * The entry each capture notice kind renders — the developer-facing wording of AAP 0.5.5. Typed
 * `Record<PanelTailNoticeKind, string>`, so a kind the store adds is a compile error here rather
 * than an unworded entry.
 */
const NOTICE_LABELS: Readonly<Record<PanelTailNoticeKind, string>> = Object.freeze({
  'page-reloaded': 'Page reloaded during capture',
});

/** The column headers, left to right. */
const TIME_HEADER = 'Time';
const KIND_HEADER = 'Kind';
const NAME_HEADER = 'Name';
const DURATION_HEADER = 'Duration';
const SOURCE_HEADER = 'Source';

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Whole-number formatting with the viewer's locale grouping, for every count this pane shows. */
const COUNT_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/**
 * Wall-clock time of day with milliseconds, in the viewer's locale and on a 24-hour cycle, so
 * events a few milliseconds apart stay distinguishable and every row has the same width.
 * `startTime` is Unix epoch milliseconds on every tier (AAP 0.2.3), which `format` accepts as is.
 */
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  hourCycle: 'h23',
});

/** A count in the viewer's locale. */
function formatCount(count: number): string {
  return COUNT_FORMAT.format(count);
}

/**
 * An event's start as a time of day, or {@link UNKNOWN_TIME_LABEL} for a value no clock can show,
 * so a malformed timestamp renders as a word instead of throwing out of the render.
 */
function formatClockTime(epochMs: number): string {
  return Number.isFinite(epochMs) ? TIME_FORMAT.format(epochMs) : UNKNOWN_TIME_LABEL;
}

/**
 * The collapse control's name: what it toggles, how many events the tail holds and, when there
 * are any, how many capture notices it shows — so a collapsed pane still says a notice exists.
 */
function collapseLabel(collapsed: boolean, count: number, noticeCount: number): string {
  const notices =
    noticeCount <= 0
      ? ''
      : noticeCount === 1
        ? '; 1 notice'
        : `; ${formatCount(noticeCount)} notices`;
  return `${collapsed ? SHOW_VERB : HIDE_VERB} ${PANE_SUBJECT} (${formatCount(count)}${notices})`;
}

/**
 * The truncation statement, or `undefined` while the tail is complete.
 *
 * The store is the authority on what it dropped: with `droppedCount` supplied, the statement
 * appears exactly when something was dropped and says how much. Without it, reaching the store's
 * cap is the signal — the buffer never holds more than {@link LIVE_TAIL_MAX_EVENTS} events, so a
 * full buffer during a capture means the oldest ones are being evicted. Either way the cap is the
 * store's imported constant, so the wording stays true if the bound changes.
 */
function truncationLabel(
  bufferedCount: number,
  droppedCount: number | undefined,
): string | undefined {
  const newest = `Showing the newest ${formatCount(LIVE_TAIL_MAX_EVENTS)}`;
  if (droppedCount !== undefined) {
    if (droppedCount <= 0) {
      return undefined;
    }
    const dropped =
      droppedCount === 1 ? '1 older event was' : `${formatCount(droppedCount)} older events were`;
    return `${newest}; ${dropped} dropped`;
  }
  return bufferedCount >= LIVE_TAIL_MAX_EVENTS ? `${newest}; older events were dropped` : undefined;
}

/**
 * The no-match explanation, naming the filter that is in force so the reader knows what to undo.
 *
 * @param searchText The search field's text as typed; quoted trimmed, in the reader's own case.
 * @param kind The chosen kind, or {@link ALL_KINDS_VALUE}.
 */
function noMatchMessage(searchText: string, kind: KindFilter): string {
  const needle = searchText.trim();
  const subject = kind === ALL_KINDS_VALUE ? 'live events' : `"${kind}" events`;
  const lead =
    needle === ''
      ? `No ${subject} remain in the tail.`
      : `No ${subject} match the search "${needle}".`;
  return `${lead} ${NO_MATCH_HINT}`;
}

// ---------------------------------------------------------------------------
// Kind and status presentation
// ---------------------------------------------------------------------------

/**
 * The badge tone of every event kind — exhaustive by construction: the object literal is typed
 * `Record<TelemetryKind, BadgeTone>`, so a kind added to the telemetry vocabulary is a compile
 * error here rather than an unstyled chip, and a misspelled key is rejected too.
 *
 * Tones are the design system's semantic families, spent sparingly so the ones that matter stand
 * out: the interaction that roots a trace is `accent`; React's render, commit and state work is
 * `info`; a long task is `warning`; page and server errors are `danger`; everything else is
 * `neutral`. The badge's text always names the kind, so a tone only ever reinforces it.
 */
const KIND_TONE: Readonly<Record<TelemetryKind, BadgeTone>> = Object.freeze({
  interaction: 'accent',
  render: 'info',
  commit: 'info',
  fetch: 'neutral',
  xhr: 'neutral',
  navigation: 'neutral',
  'perf.longtask': 'warning',
  'perf.entry': 'neutral',
  error: 'danger',
  state: 'info',
  'http.server': 'neutral',
  'route.handler': 'neutral',
  function: 'neutral',
  'db.query': 'neutral',
  'http.client': 'neutral',
  'server.error': 'danger',
  log: 'neutral',
});

/**
 * The status marker a span carries beside its name: a worded `danger` badge for a span that ended
 * in error — a request answered with a failure status, a query that threw — and nothing for a span
 * that succeeded or never set a status. A kind that is itself an error already says so on its own
 * badge, so it gets no second marker.
 *
 * The switch is exhaustive over the status vocabulary; `assertNever` makes a status added to the
 * wire type a compile error at this line instead of a silently unmarked failure.
 */
function statusMarker(event: TelemetryEvent): ReactNode {
  const status: TelemetryStatus = event.status;
  switch (status) {
    case 'error':
      return KIND_TONE[event.kind] === 'danger' ? null : (
        <Badge tone="danger" variant="outline">
          {FAILED_STATUS_LABEL}
        </Badge>
      );
    case 'ok':
    case 'unset':
      return null;
    default:
      return assertNever(status, 'Unhandled telemetry span status in the live tail');
  }
}

// ---------------------------------------------------------------------------
// Row derivation
// ---------------------------------------------------------------------------

/**
 * The tail as the pane presents it: newest first, each event once.
 *
 * The store appends batches as they arrive and keeps them oldest first; walking it backwards gives
 * the presentation order in one pass. An event id seen twice — a batch replayed across a reconnect
 * — keeps its newest occurrence only, so the grid never renders two rows under one React key.
 * Returns `events` itself when it is empty, so an empty tail keeps a stable identity.
 */
function newestFirstUnique(events: readonly TelemetryEvent[]): readonly TelemetryEvent[] {
  if (events.length === 0) {
    return events;
  }
  const seen = new Set<string>();
  const ordered: TelemetryEvent[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && !seen.has(event.id)) {
      seen.add(event.id);
      ordered.push(event);
    }
  }
  return ordered;
}

/**
 * The events the filters keep, in presentation order.
 *
 * Local filtering is legitimate here, unlike in a query-backed table: this is the store's complete,
 * bounded tail buffer rather than one page of a paged `panel-data` response, so nothing beyond it
 * exists for the filter to miss. With no filter in force the tail is returned as is.
 *
 * The search is case-insensitive and ignores surrounding whitespace, and matches an event's name
 * or its kind.
 *
 * @param tail The tail, newest first.
 * @param searchText The search field's text as typed.
 * @param kind The chosen kind, or {@link ALL_KINDS_VALUE}.
 */
function filterTail(
  tail: readonly TelemetryEvent[],
  searchText: string,
  kind: KindFilter,
): readonly TelemetryEvent[] {
  const needle = searchText.trim().toLowerCase();
  if (needle === '' && kind === ALL_KINDS_VALUE) {
    return tail;
  }
  return tail.filter(
    (event) =>
      (kind === ALL_KINDS_VALUE || event.kind === kind) &&
      (needle === '' || event.name.toLowerCase().includes(needle) || event.kind.includes(needle)),
  );
}

/**
 * The kinds the kind filter offers: those present in the tail right now, plus the chosen one so
 * the control can always show its own value after the buffer evicted the last event of it. Taken
 * from the data rather than from a fixed list, so a capture that produced only browser events is
 * not offered server kinds it cannot match. Sorted for a stable order between batches.
 */
function offeredKinds(
  tail: readonly TelemetryEvent[],
  chosen: KindFilter,
): readonly TelemetryKind[] {
  const kinds = new Set<TelemetryKind>();
  for (const event of tail) {
    kinds.add(event.kind);
  }
  if (chosen !== ALL_KINDS_VALUE) {
    kinds.add(chosen);
  }
  return [...kinds].sort((left, right) => left.localeCompare(right, 'en'));
}

/** The kind filter's options: "all kinds" first, then one per offered kind, named by the kind. */
function kindOptions(kinds: readonly TelemetryKind[]): readonly SelectOption[] {
  return [
    { value: ALL_KINDS_VALUE, label: ALL_KINDS_LABEL },
    ...kinds.map((kind): SelectOption => ({ value: kind, label: kind })),
  ];
}

/**
 * The pointer a row reports when it is activated, with the schema's own `EventRef` field names.
 * A tailed event always carries its trace and span, so both coordinates travel with the id.
 */
function toEventRef(event: TelemetryEvent): PanelEventRef {
  return { eventId: event.id, traceId: event.traceId, spanId: event.spanId };
}

/**
 * A row's identity for the grid: the event's own id — unique within the presented tail, since
 * {@link newestFirstUnique} keeps each id once — so a row keeps its measured height and its
 * selection as newer events push it down. A module-level function, so its identity never changes.
 */
function eventRowKey(event: TelemetryEvent): string {
  return event.id;
}

/**
 * The grid's columns. Built once per source-open handler, so the virtualizer sees the same column
 * array across the many re-renders a streaming tail causes.
 *
 * No column is sortable: the tail's order is fixed (see the module note) and `DataTable` never
 * re-orders rows itself. Each width is the `DataTable` role for the column's content, never a
 * length: the clock time and the duration are formatted `quantity` measurements, the kind chip a
 * `label`, and the event name and source chip `name`s, which take the larger shares of the free
 * width. Every role has a non-zero floor, so a narrow pane scrolls inside the grid instead of
 * overlapping cells. Every chip rendered in a cell carries `tabIndex={-1}`: the grid is one Tab
 * stop and its arrow keys reach the chips.
 *
 * @param openSource The explicit click-to-source handler every `SourceLink` receives.
 */
function buildColumns(
  openSource: PanelViewActions['onOpenSource'],
): readonly DataTableColumn<TelemetryEvent>[] {
  return [
    {
      key: 'time',
      header: TIME_HEADER,
      width: 'quantity',
      rowHeader: true,
      sortable: false,
      cell: (event) => (
        <Text size="xs" numeric>
          {formatClockTime(event.startTime)}
        </Text>
      ),
    },
    {
      key: 'kind',
      header: KIND_HEADER,
      width: 'label',
      sortable: false,
      cell: (event) => <Badge tone={KIND_TONE[event.kind]}>{event.kind}</Badge>,
    },
    {
      key: 'name',
      header: NAME_HEADER,
      width: 'name',
      sortable: false,
      cell: (event) => (
        <>
          {statusMarker(event)}
          <Text size="xs" truncate title={event.name}>
            {event.name}
          </Text>
        </>
      ),
    },
    {
      key: 'duration',
      header: DURATION_HEADER,
      width: 'quantity',
      align: 'end',
      sortable: false,
      cell: (event) => <DurationCell ms={event.duration} severity="auto" size="sm" />,
    },
    {
      key: 'source',
      header: SOURCE_HEADER,
      width: 'name',
      sortable: false,
      cell: (event) =>
        event.source === undefined ? null : (
          <SourceLink location={event.source} compact tabIndex={-1} onOpenSource={openSource} />
        ),
    },
  ];
}

// ---------------------------------------------------------------------------
// Capture notices
// ---------------------------------------------------------------------------

/** The store's capture notices. A module-level selector, so its identity never changes. */
function selectTailNotices(snapshot: PanelSnapshot): readonly PanelTailNotice[] {
  return snapshot.tailNotices;
}

/**
 * The capture notices as the pane presents them: newest first, like the event rows. The store
 * keeps them in arrival order, so reversing it is the presentation order. Returns `notices` itself
 * when it is empty, so an empty list keeps a stable identity.
 */
function newestNoticesFirst(notices: readonly PanelTailNotice[]): readonly PanelTailNotice[] {
  return notices.length === 0 ? notices : notices.toReversed();
}

/**
 * The part of a notice's URL the pane shows: the path alone (see the module note on privacy), or
 * `undefined` for a value that does not parse as a URL, whose entry then shows no path.
 */
function noticePath(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

/** Props of {@link NoticeList}. */
interface NoticeListProps {
  /** The capture notices, newest first. */
  readonly notices: readonly PanelTailNotice[];
}

/**
 * The capture notices as a labelled list. Each entry reads, in order: the time the service
 * stamped it, on the same clock as the event rows; the worded notice, as an `info` badge whose text
 * carries the meaning; and the new document's path, truncated with its full value on hover.
 *
 * The entries are keyed by the notice's id — the reporting frame's own, unique within the list.
 * They are spaced by a vertical `Stack` at the scale's smallest step, so two consecutive badges
 * never touch; its wrappers carry no role, so each entry is still a list item of the list.
 */
function NoticeList(props: NoticeListProps): ReactElement {
  return (
    <Text as="div" size="xs" role="list" aria-label={NOTICES_LABEL}>
      <Stack gap={1}>
        {props.notices.map((notice) => {
          const path = noticePath(notice.url);
          return (
            <Text key={notice.id} as="div" size="xs" role="listitem">
              <Stack direction="horizontal" gap={2} align="center" wrap>
                <Text size="xs" numeric>
                  {formatClockTime(notice.ts)}
                </Text>
                <Badge tone="info" variant="soft">
                  {NOTICE_LABELS[notice.kind]}
                </Badge>
                {path === undefined ? null : (
                  <Text size="xs" tone="secondary" truncate title={path}>
                    {path}
                  </Text>
                )}
              </Stack>
            </Text>
          );
        })}
      </Stack>
    </Text>
  );
}

// ---------------------------------------------------------------------------
// The stream region's body
// ---------------------------------------------------------------------------

/**
 * What the stream region shows below any failure, decided from the tail and the capture window.
 *
 * - `events`   the tail holds events: the filter bar and the grid.
 * - `awaiting` a capture is running and nothing has arrived yet: a loading silhouette.
 * - `idle`     no capture is running and nothing was streamed: the empty state.
 * - `failed`   the stream failed and holds nothing: the failure alone, so an error is never
 *              presented as an empty or a pending stream.
 */
type StreamBody = 'events' | 'awaiting' | 'idle' | 'failed';

/**
 * Resolves {@link StreamBody}. Buffered events are always shown — below the failure when there is
 * one, since what already arrived is still valid evidence — and an empty tail resolves with the
 * precedence error > loading > empty.
 */
function resolveStreamBody(count: number, capturing: boolean, failed: boolean): StreamBody {
  if (count > 0) {
    return 'events';
  }
  if (failed) {
    return 'failed';
  }
  return capturing ? 'awaiting' : 'idle';
}

// ---------------------------------------------------------------------------
// Pausing the grid while the reader inspects it
// ---------------------------------------------------------------------------

/** Why the grid is held still: the pointer is over it, or keyboard focus is inside it. */
type HoldReason = 'pointer' | 'focus';

/**
 * The grid's frozen presentation while the reader inspects it.
 *
 * Newest-first rows are prepended many times a second, and `DataTable` keeps its roving tab stop
 * and its virtual window by row position: a stream moving under a focused row pushes it out of the
 * rendered window, unmounts it and drops focus to the document, and a scrolled viewport drifts as
 * rows arrive above it. So while the pointer is over the grid or keyboard focus is inside it, the
 * grid shows the tail as it stood when the inspection began — a reference to that array, never a
 * copy of an event — and a toolbar statement says the stream is paused and how much is waiting.
 * Both reasons are tracked, so the hold ends only when neither applies; the pane's own count keeps
 * rising meanwhile, and the next render after the hold ends shows the live tail again.
 *
 * Only KEYBOARD focus holds the grid (see {@link isKeyboardFocus}): a row a mouse user clicked
 * keeps focus after the pointer leaves, and holding on it would leave the stream paused for a
 * reader who has already moved on. The pointer reason covers that reader while they are over it.
 */
interface InspectionHold {
  /** The tail as it stood when the inspection began, newest first. */
  readonly tail: readonly TelemetryEvent[];
  /**
   * The store's arrival total (dropped plus buffered) when the inspection began, when the root
   * supplied the dropped count; what lets the waiting count stay exact past the store's bound.
   */
  readonly arrivedAtHold: number | undefined;
  /** Whether the pointer is over the grid. */
  readonly pointer: boolean;
  /** Whether keyboard focus is inside the grid. */
  readonly focus: boolean;
}

/**
 * Whether focus arrived from the keyboard, as the browser's own `:focus-visible` heuristic decides:
 * Tab and the grid's arrow keys match, a mouse click on a row or a chip does not. An engine that
 * cannot evaluate the selector is treated as keyboard focus, which errs on keeping a reader's row
 * in place.
 */
function isKeyboardFocus(target: EventTarget): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  try {
    return target.matches(':focus-visible');
  } catch {
    return true;
  }
}

/** Whether a hold's reason is in force. */
function holdsFor(hold: InspectionHold, reason: HoldReason): boolean {
  return reason === 'pointer' ? hold.pointer : hold.focus;
}

/**
 * The hold after one reason starts or stops applying. Starting takes a snapshot of the live tail
 * only when no hold exists; stopping the last reason ends the hold. A transition that changes
 * nothing returns `previous` itself, so React skips the re-render.
 *
 * @param previous The current hold, if any.
 * @param reason What started or stopped.
 * @param engaged `true` when it started, `false` when it stopped.
 * @param liveTail The live tail, newest first, for a new snapshot.
 * @param arrived The store's arrival total now, for a new snapshot, when known.
 */
function nextHold(
  previous: InspectionHold | undefined,
  reason: HoldReason,
  engaged: boolean,
  liveTail: readonly TelemetryEvent[],
  arrived: number | undefined,
): InspectionHold | undefined {
  if (previous === undefined) {
    return engaged
      ? {
          tail: liveTail,
          arrivedAtHold: arrived,
          pointer: reason === 'pointer',
          focus: reason === 'focus',
        }
      : undefined;
  }
  if (holdsFor(previous, reason) === engaged) {
    return previous;
  }
  const next: InspectionHold =
    reason === 'pointer' ? { ...previous, pointer: engaged } : { ...previous, focus: engaged };
  return next.pointer || next.focus ? next : undefined;
}

/**
 * Whether a held snapshot still belongs to the capture the live tail shows. A new capture replaces
 * the store's tail, and a snapshot of the previous capture must never be shown under it.
 */
function sameCapture(held: readonly TelemetryEvent[], live: readonly TelemetryEvent[]): boolean {
  const heldNewest = held[0];
  const liveNewest = live[0];
  return (
    heldNewest !== undefined &&
    liveNewest !== undefined &&
    heldNewest.captureId === liveNewest.captureId
  );
}

/**
 * How many events arrived after a held snapshot was taken.
 *
 * Exact when the store's arrival total is known at both ends: within one capture the store only
 * appends, so every event since the snapshot is either still buffered or was counted as dropped.
 * Otherwise the live tail itself is searched for the snapshot's newest event, which is exact until
 * the store evicts that event and a lower bound — the whole buffer — after it.
 *
 * @param live The live tail, newest first.
 * @param hold The hold whose snapshot is on screen.
 * @param arrived The store's arrival total now, when known.
 */
function countNewer(
  live: readonly TelemetryEvent[],
  hold: InspectionHold,
  arrived: number | undefined,
): number {
  if (arrived !== undefined && hold.arrivedAtHold !== undefined) {
    return Math.max(0, arrived - hold.arrivedAtHold);
  }
  const heldNewest = hold.tail[0];
  if (heldNewest === undefined) {
    return live.length;
  }
  const position = live.findIndex((event) => event.id === heldNewest.id);
  return position === -1 ? live.length : position;
}

/** The toolbar statement shown while the grid is held. */
function pausedLabel(newer: number): string {
  const waiting = newer === 1 ? '1 newer event' : `${formatCount(newer)} newer events`;
  return `Paused while you inspect; ${waiting}`;
}

/** Props of {@link TailStream}, the stream region's body while the tail holds events. */
interface TailStreamProps {
  /** The live tail, newest first, each event once. */
  readonly tail: readonly TelemetryEvent[];
  /** The search field's text, owned by {@link LiveTail} so it survives a collapse. */
  readonly searchText: string;
  /** Raised with the search field's next text. */
  readonly onSearchChange: (next: string) => void;
  /** The chosen kind, owned by {@link LiveTail} for the same reason. */
  readonly kindFilter: KindFilter;
  /** The kind filter control, built by {@link LiveTail} from the kinds in the tail. */
  readonly selects: readonly ToolbarSelect[];
  /** The grid's columns, memoized by {@link LiveTail}. */
  readonly columns: readonly DataTableColumn<TelemetryEvent>[];
  /** The event the drawer shows, if any. */
  readonly selected: EventRef | undefined;
  /** Reports a row's activation. */
  readonly onRowActivate: (event: TelemetryEvent) => void;
  /** The truncation statement, when the store dropped events. */
  readonly truncation: string | undefined;
  /**
   * The store's arrival total — dropped plus buffered — when the root supplied the dropped count;
   * `undefined` otherwise. Only differences between two readings are ever used.
   */
  readonly arrived: number | undefined;
}

/**
 * The filter bar and the grid, holding the grid still while the reader inspects it (see
 * {@link InspectionHold}).
 *
 * A component of its own so the hold lives exactly as long as the grid is mounted: collapsing the
 * pane, a new capture emptying the tail, or anything else that removes the grid discards the hold
 * with it, so no stale "the pointer is over the grid" can outlive the grid it described.
 *
 * The hold is observed on a plain `div` around the grid. It carries no class, no style and no role
 * — it lays nothing out and is not in the accessibility tree's structure — because no renderer
 * primitive exposes pointer or focus listeners; it is an event boundary and nothing else.
 */
function TailStream(props: TailStreamProps): ReactElement {
  const {
    tail,
    searchText,
    onSearchChange,
    kindFilter,
    selects,
    columns,
    selected,
    onRowActivate,
    truncation,
    arrived,
  } = props;

  const [hold, setHold] = useState<InspectionHold | undefined>(undefined);

  // A hold taken during another capture is ignored rather than shown under this one.
  const activeHold = hold !== undefined && sameCapture(hold.tail, tail) ? hold : undefined;
  const shown = activeHold === undefined ? tail : activeHold.tail;

  // Local filtering, legitimate for the reason `filterTail` records: this is the store's whole
  // bounded buffer, not a page of a server-side query.
  const visibleEvents = useMemo(
    () => filterTail(shown, searchText, kindFilter),
    [shown, searchText, kindFilter],
  );

  // The selected event's row, when the filters keep it. `null` rather than `undefined` keeps the
  // grid in selection mode, so every row reports `aria-selected` and the match reports `true`.
  const selectedRowKey = useMemo(() => {
    if (selected === undefined) {
      return null;
    }
    const match = visibleEvents.find((event) => matchesPanelSelection(selected, toEventRef(event)));
    return match === undefined ? null : match.id;
  }, [selected, visibleEvents]);

  const filtering = searchText.trim() !== '' || kindFilter !== ALL_KINDS_VALUE;
  const newer = activeHold === undefined ? 0 : countNewer(tail, activeHold, arrived);

  // What the bar states about the rows on screen: the fixed order always; how many of them the
  // filters kept while filters are in force; that the grid is paused, and how much is waiting,
  // while it is held; and that the tail is not the whole capture once the store evicted events.
  const statuses: readonly ToolbarStatus[] = [
    { label: ORDER_STATUS_LABEL, variant: 'outline' },
    ...(filtering
      ? [{ label: `${formatCount(visibleEvents.length)} of ${formatCount(shown.length)} match` }]
      : []),
    ...(activeHold === undefined ? [] : [{ label: pausedLabel(newer), tone: 'info' as const }]),
    ...(truncation === undefined ? [] : [{ label: truncation, tone: 'warning' as const }]),
  ];

  const engage = (reason: HoldReason): void => {
    setHold((previous) => nextHold(previous, reason, true, tail, arrived));
  };
  const release = (reason: HoldReason): void => {
    setHold((previous) => nextHold(previous, reason, false, tail, arrived));
  };
  const handleFocus = (event: ReactFocusEvent<HTMLDivElement>): void => {
    // Keyboard focus only: see `InspectionHold` for why a clicked row does not hold the grid.
    if (isKeyboardFocus(event.target)) {
      engage('focus');
    }
  };
  const handleBlur = (event: ReactFocusEvent<HTMLDivElement>): void => {
    // Focus moving between controls inside the grid is still an inspection.
    const next = event.relatedTarget;
    if (!(next instanceof Node && event.currentTarget.contains(next))) {
      release('focus');
    }
  };

  return (
    <>
      <Toolbar
        label={FILTER_GROUP_LABEL}
        compact
        wrap
        search={{
          value: searchText,
          onValueChange: onSearchChange,
          label: SEARCH_LABEL,
          placeholder: SEARCH_PLACEHOLDER,
          labelHidden: true,
        }}
        selects={selects}
        status={statuses}
      />
      <div
        onPointerEnter={() => {
          engage('pointer');
        }}
        onPointerLeave={() => {
          release('pointer');
        }}
        onFocus={handleFocus}
        onBlur={handleBlur}
      >
        <DataTable
          rows={visibleEvents}
          columns={columns}
          rowKey={eventRowKey}
          caption={TABLE_CAPTION}
          selectedRowKey={selectedRowKey}
          onRowActivate={onRowActivate}
          compact
          empty={
            <EmptyState title={NO_MATCH_TITLE} message={noMatchMessage(searchText, kindFilter)} />
          }
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

/**
 * Props of {@link LiveTail}.
 *
 * Everything arrives from the composition root: the store's tail buffer and capture flag, the
 * collapsed flag the root keeps as presentation-only state, the panel's actions and selection, the
 * capture notices (read from the store when the root omits them), and an optional stream failure
 * with its retry. Every optional member states `| undefined` explicitly because
 * `exactOptionalPropertyTypes` is on repository-wide and a root forwarding a value it may not have
 * must stay legal.
 */
export interface LiveTailProps {
  /**
   * The store's bounded tail buffer (`PanelSnapshot.liveTail`), oldest first, as the store keeps
   * it. Rendered newest first; never mutated.
   */
  events: readonly TelemetryEvent[];

  /** Whether a capture is running now (`PanelSnapshot.capture.active`). */
  capturing: boolean;

  /** Whether the stream region is hidden, leaving only the header bar. */
  collapsed: boolean;

  /** Raised by the collapse control; the root flips `collapsed`. */
  onToggleCollapsed: () => void;

  /**
   * The panel's actions, passed explicitly because this pane renders outside `PanelHost` (see the
   * module note). `onSelectEvent` opens a row's event in the `EventDetails` drawer; `onOpenSource`
   * is every source chip's handler. The object `createPanelActions()` returns satisfies this as is.
   */
  actions: Pick<PanelViewActions, 'onOpenSource' | 'onSelectEvent'>;

  /** The event the drawer shows (`PanelSnapshot.selectedEvent`); its row is marked selected. */
  selected?: EventRef | undefined;

  /**
   * How many events the store dropped to stay within its bound (`PanelSnapshot.liveTailDropped`).
   * Supplied, it makes the truncation notice exact; omitted, a full buffer is the signal.
   */
  droppedCount?: number | undefined;

  /**
   * The capture's notices (`PanelSnapshot.tailNotices`), oldest first, as the store keeps them.
   * Rendered newest first above the stream body; never mutated. Omitted, the pane reads the
   * store's `tailNotices` slice itself (see the module note).
   */
  notices?: readonly PanelTailNotice[] | undefined;

  /** A failure of the stream itself, rendered as an error state — never as an empty stream. */
  error?: { message: string } | undefined;

  /** Offered as the failure's retry control; omitted, the failure is informational only. */
  onRetry?: (() => void) | undefined;

  /** Extra classes for the pane's root, forwarded to its `Section`. Composition only. */
  className?: string | undefined;
}

/**
 * Renders the live tail: the always-visible header bar with the collapse control, and — while
 * expanded — the stream region with its failure, the capture notices, and its loading, empty or
 * filtered-grid body.
 *
 * @param props The props documented on {@link LiveTailProps}.
 * @returns The pane.
 *
 * @example
 * // The composition root, with the store's slices and the memoized panel actions:
 * <LiveTail
 *   events={snapshot.liveTail}
 *   droppedCount={snapshot.liveTailDropped}
 *   notices={snapshot.tailNotices}
 *   capturing={snapshot.capture.active}
 *   collapsed={tailCollapsed}
 *   onToggleCollapsed={toggleTail}
 *   actions={actions}
 *   selected={snapshot.selectedEvent}
 * />
 */
export function LiveTail(props: LiveTailProps): ReactElement {
  const {
    events,
    capturing,
    collapsed,
    onToggleCollapsed,
    actions,
    selected,
    droppedCount,
    notices,
    error,
    onRetry,
    className,
  } = props;

  // The root's notices when it passes them, the store's otherwise. The hook runs either way, as a
  // hook must; selecting the slice itself keeps its reference, so it re-renders the pane only when
  // the store's notices change.
  const storeNotices = usePanelStoreSelector(selectTailNotices);
  const shownNotices = notices ?? storeNotices;

  const regionId = useId();
  const [searchText, setSearchText] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>(ALL_KINDS_VALUE);

  const openSource = actions.onOpenSource;
  const selectEvent = actions.onSelectEvent;

  // The collapse control, which keeps focus inside the pane when a retry removes the control the
  // reader just activated.
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Every derivation below is memoized on its real inputs: the buffer changes identity with every
  // tailed batch, many times a second, and the grid's virtualizer should see a new row array only
  // when the rows actually changed — and a new column array never, while the handler is stable.
  const tail = useMemo(() => newestFirstUnique(events), [events]);
  const orderedNotices = useMemo(() => newestNoticesFirst(shownNotices), [shownNotices]);
  const offered = useMemo(() => offeredKinds(tail, kindFilter), [tail, kindFilter]);
  const options = useMemo(() => kindOptions(offered), [offered]);
  const columns = useMemo(() => buildColumns(openSource), [openSource]);

  // Derived before the callbacks that follow, so none of them closes over a value computed later.
  const count = tail.length;
  const truncation = truncationLabel(events.length, droppedCount);
  // Everything the store has appended this capture: what is buffered plus what it dropped.
  const arrived = droppedCount === undefined ? undefined : droppedCount + events.length;
  const body = resolveStreamBody(count, capturing, error !== undefined);

  const handleKindChange = useCallback(
    (next: string): void => {
      setKindFilter(offered.find((kind) => kind === next) ?? ALL_KINDS_VALUE);
    },
    [offered],
  );

  const handleRowActivate = useCallback(
    (event: TelemetryEvent): void => {
      selectEvent(toEventRef(event));
    },
    [selectEvent],
  );

  // A retry replaces the failure — and the retry control with it — so focus is returned to the
  // pane's collapse control rather than falling to the document.
  const retryAndKeepFocus =
    onRetry === undefined
      ? undefined
      : (): void => {
          onRetry();
          toggleRef.current?.focus();
        };

  const selects: readonly ToolbarSelect[] = [
    {
      id: KIND_SELECT_ID,
      label: KIND_SELECT_LABEL,
      labelHidden: true,
      value: kindFilter,
      options,
      onValueChange: handleKindChange,
    },
  ];

  const failure =
    error === undefined ? null : (
      <ErrorState
        title={FAILURE_TITLE}
        message={error.message.trim() === '' ? FAILURE_FALLBACK_MESSAGE : error.message}
        onRetry={retryAndKeepFocus}
        retryLabel={RETRY_LABEL}
      />
    );

  let content: ReactNode;
  switch (body) {
    case 'events':
      content = (
        <TailStream
          tail={tail}
          searchText={searchText}
          onSearchChange={setSearchText}
          kindFilter={kindFilter}
          selects={selects}
          columns={columns}
          selected={selected}
          onRowActivate={handleRowActivate}
          truncation={truncation}
          arrived={arrived}
        />
      );
      break;
    case 'awaiting':
      content = <LoadingState variant="rows" label={AWAITING_LABEL} />;
      break;
    case 'idle':
      content = <EmptyState title={IDLE_TITLE} message={IDLE_MESSAGE} />;
      break;
    case 'failed':
      content = null;
      break;
    default:
      content = assertNever(body, 'Unhandled live-tail body');
  }

  return (
    <Section variant="card" gap={2} className={className}>
      <Stack direction="horizontal" gap={2} align="center" wrap>
        {/*
         * `aria-controls` is written only while the stream region is rendered. Collapsed, the
         * region is unmounted rather than kept as an empty element — an empty box would still take
         * a gap of the card's flow — so the attribute is dropped with it and never names an
         * element that is not in the document; `aria-expanded` carries the state either way.
         */}
        <Button
          ref={toggleRef}
          variant="ghost"
          size="sm"
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : regionId}
          onClick={onToggleCollapsed}
        >
          {collapseLabel(collapsed, count, orderedNotices.length)}
        </Button>
        {capturing ? (
          <Badge tone="info" variant="soft">
            {STREAMING_LABEL}
          </Badge>
        ) : null}
      </Stack>
      {collapsed ? null : (
        <Stack id={regionId} gap={2}>
          {failure}
          {orderedNotices.length === 0 ? null : <NoticeList notices={orderedNotices} />}
          {content}
        </Stack>
      )}
    </Section>
  );
}
