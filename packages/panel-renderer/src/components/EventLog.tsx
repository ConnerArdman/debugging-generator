/**
 * `EventLog` — every captured record in sequence, as a filterable, virtualized
 * list (AAP 0.6.2).
 *
 * This module is the component behind the node catalog's `eventLog` type. It is
 * the view with no opinion: no grouping, no ranking, no aggregation, no
 * inference — the unaggregated evidence the summarising views above it are
 * computed from, and what a developer falls back to when those views agree and
 * the explanation is still missing. It is also the view whose row selection
 * drives the host surface's record-detail drawer, which is why activating a row
 * reports the record's identifiers and nothing else: the drawer reads the whole
 * record from the capture, this list never has to render it.
 *
 * ## THE FIELDS IT READS ARE THE CATALOG'S, NOT THIS FILE'S
 *
 * The catalog entry `catalogEntryFor('eventLog')` (in `@debuggen/panel-schema`)
 * declares the one source this node may draw from — `events`, the only source
 * that offers every record of any kind in capture order — and the telemetry
 * fields it is allowed to read: `id`, `traceId`, `spanId`, `parentSpanId`,
 * `seq`, `startTime`, `duration`, `kind`, `tier`, `name`, `status`,
 * `attributes` and `source`. Every field touched below is a member of that
 * `reads` set, and the set is never restated here — semantic validation checks
 * a panel against the same entry, so a field list written out in this file
 * would be a second authority that could disagree with the one the service
 * validated against.
 *
 * ## IT ASKS FOR DATA ONE WAY, AND IT IS NOT A TRANSPORT
 *
 * The node's `DataQuery` goes to `../host/useQuery`, which resolves it through
 * whatever `DataProvider` the host mounted. There is no `fetch`, no socket, no
 * message port and no host API in this file (AAP 0.1.2, 0.4.2): the DevTools
 * panel proxies the query through its service worker and the editor webview
 * through host messaging, and this component cannot tell the difference.
 * Interactions leave the same way — through the `PanelActions` of the nearest
 * host, resolved with `?.` because that context is legitimately absent in a
 * surface that only displays.
 *
 * ## WHAT IT SHOWS IS ONE PAGE, AND IT SAYS SO
 *
 * The panel-data contract pages every array-valued source (AAP 0.4.2): a
 * request carries `limit` (200 by default, 5 000 at most) and `offset`, and the
 * response carries `total` and `nextOffset`. A log that quietly showed 200 of
 * 4 000 records would misrepresent the capture, so this component states two
 * ratios and offers the one control that changes them:
 *
 *   - **loaded against total**, in the footer, beside a "load more" control
 *     that advances the offset and appends the next page to what is already on
 *     screen. The next offset is copied from the response, never computed from
 *     the length of a page or from `total`, which would drift the moment the
 *     resolver clamped a limit; and it is followed only when it moves forward,
 *     so a response that points back at the page just drawn cannot loop.
 *     The page sequence starts at the node's own authored `offset`, and when
 *     that is past the first record the footer counts from there — "of N" is
 *     how many records the source holds from that position on, and the
 *     position itself is stated.
 *   - **matching against loaded**, in the toolbar, whenever the text filter is
 *     active — plus an explicit note that the text filter reaches the loaded
 *     records only, because `DataQueryFilter` has no free-text field and this
 *     is the one view where a reader might reasonably expect "search
 *     everything". The counts are the feature, not decoration.
 *
 * The kind filter is the opposite case: `kinds` IS a field of the query's
 * filter, so choosing a kind narrows the request and re-queries. The picker's
 * options are discovered from the records that have actually arrived (plus any
 * kinds the panel's author already named, plus those seen before a narrowing),
 * because the kind vocabulary is a runtime value of `@debuggen/telemetry`,
 * which this package depends on for types only.
 *
 * ## REDACTION AND TRUNCATION ARE UPSTREAM GUARANTEES, HONOURED HERE
 *
 * Attribute values arrive already redacted and already bounded to 120
 * characters with key-name-plus-summary semantics (AAP 0.5.2). This component
 * displays them as given: it never expands, re-parses, pretty-prints, joins or
 * reconstructs a value, offers no "show raw" affordance, and passes every
 * string through this package's own truncation helper so that the rendered text
 * can only ever be shorter than what the producer was permitted to capture.
 * The compact attribute column shows at most {@link MAX_ATTRIBUTE_PAIRS}
 * primitive pairs and counts everything else — a structured summary, an
 * overflowing pair — as "more", so a reader knows the record carries more
 * without this view unpacking it.
 *
 * ## VIRTUALIZATION, GRID SEMANTICS AND KEYBOARD OPERATION BELONG TO DataTable
 *
 * `../primitives/DataTable` owns the windowing (and the shared
 * `dg-virtual-*` class contract behind it), the `grid`/`rowgroup`/`row`/
 * `gridcell` roles, the roving tab stop and the arrow/Home/End/Enter handling.
 * This file therefore imports no virtualizer of its own — a second one would
 * put two windows over one list and break that shared contract — and writes no
 * key handler, no `tabIndex` and no `role`. What it owns is the grid's
 * accessible name, the toolbar's control labels, and the fact that a click on a
 * row's source chip is the chip's alone: the table excludes clicks that
 * originated in an interactive descendant from row activation, so opening a
 * file never also selects a row.
 *
 * ## THREE STATES, IN ONE FIXED ORDER
 *
 * Loading, then error, then empty, then the table — the precedence AAP 0.6.2
 * requires of a query-backed view, each in its own `__loading`, `__error` and
 * `__empty` box. An empty page and a failed request are kept apart:
 * `useQuery`'s `"success"` with no rows reads as an empty state, while a
 * rejection carries the failure, its code and the serialised query into an
 * error state with a working retry (AAP 0.5.5 — a failure is never presented as
 * a result). An empty page is not always an empty capture, and the empty state
 * says which one it is, from the counters the same response carried:
 *
 *   - a count-only query (`limit: 0`) asked for a total and no rows, and states
 *     that total — or that none was reported;
 *   - a total of zero, or no total for a sequence that started at the first
 *     record, is a capture that holds nothing for this query;
 *   - a positive total with nothing on the page is a page past the end of the
 *     matches (an authored offset beyond them) or one the service left empty,
 *     and states the total, and the page's position when it is past the end;
 *   - no total for a page past the first record states that page's position.
 *
 * An empty page the service still reports a forward `nextOffset` for keeps its
 * paging footer, so the next page stays reachable. A further absence is
 * distinguished from all of these: a text filter that matches none of the
 * loaded records is the filter's doing, not the capture's, and says so in the
 * table's own empty slot.
 *
 * ## APPEARANCE IS A CLASS CONTRACT, NEVER AN INLINE STYLE (AAP 0.6.4)
 *
 * This file declares class names and nothing else: no inline style object, no
 * colour, no length, no literal CSS value. The kind chip's colour arrives as a
 * `var(--dg-kind-*)` reference from `../utils/color`; every spacing decision is
 * a `Stack`, a `Toolbar` or the table cell's own row gap; and every declaration
 * behind the names below lives in `../styles/components.css`:
 *
 *   `dg-event-log`            the block: a column that may shrink below its
 *                             content
 *   `dg-event-log__toolbar`   the filter row, which never takes free space
 *   `dg-event-log__loading`   the busy box
 *   `dg-event-log__error`     the failure box
 *   `dg-event-log__empty`     the absence box
 *   `dg-event-log__seq`       the sequence cell, muted and tabular
 *   `dg-event-log__time`      the offset cell, secondary and tabular
 *   `dg-event-log__name`      the record's own label, truncating
 *   `dg-event-log__attrs`     the compact attribute strip, truncating
 *   `dg-data-table__footer`   the paging counts below the grid — the
 *                             stylesheet's own class for exactly this, since
 *                             the table renders no footer itself
 *
 * The caller's `className` is composed last. `dg-icon` is the global utility of
 * `../styles/base.css` that gives every glyph its font-relative square and its
 * `currentColor`, and is never redefined here.
 *
 * @see ../host/useQuery for the loading/error/success state machine.
 * @see ../host/DataProvider for what resolves a query, and its paging counters.
 * @see ../host/PanelActions for the selection and source-open contracts.
 * @see ../styles/components.css for the implementation of the classes above.
 */

import type {
  DataQuery,
  DataQueryFilter,
  DataQuerySource,
  EventLogNode,
} from '@debuggen/panel-schema';
import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
  catalogEntryFor,
} from '@debuggen/panel-schema';
import type { TelemetryEvent, TelemetryKind } from '@debuggen/telemetry';
import clsx from 'clsx';
import { ChevronDown, ListX, ScrollText, TriangleAlert } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import type { PanelEventRef } from '../host/PanelActions';
import { usePanelActions } from '../host/PanelActions';
import { useQuery } from '../host/useQuery';
import { Stack } from '../layout/Stack';
import { Toolbar } from '../layout/Toolbar';
import type { ToolbarSelect, ToolbarStatus } from '../layout/Toolbar';
import { Badge } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { Code } from '../primitives/Code';
import { DataTable } from '../primitives/DataTable';
import type { DataTableColumn } from '../primitives/DataTable';
import { EmptyState } from '../primitives/EmptyState';
import { ErrorState } from '../primitives/ErrorState';
import { LoadingState } from '../primitives/LoadingState';
import type { SelectOption } from '../primitives/Select';
import { Text } from '../primitives/Text';
import { kindColorVar } from '../utils/color';
import {
  NOT_AVAILABLE_LABEL,
  formatCount,
  formatKindLabel,
  formatOffset,
  formatStatusLabel,
  oneLinePreview,
} from '../utils/format';
import { SourceLink } from './SourceLink';

/*
 * ---------------------------------------------------------------------------
 * The node's own contract
 * ---------------------------------------------------------------------------
 */

/** The catalog type this component implements. */
const EVENT_LOG_NODE_TYPE = 'eventLog';

/**
 * This node's catalog entry — the authority for the source it may read, the
 * telemetry fields it may touch (`reads`, enumerated in this module's header)
 * and the label it names itself with.
 *
 * Read once at module scope, which is a pure lookup in a frozen record: the
 * entry cannot change at runtime, and resolving it per render would repeat the
 * lookup for no gain. Its `label` is what keeps the grid's accessible name and
 * the toolbar's group name out of this file's own vocabulary.
 */
const EVENT_LOG_CATALOG_ENTRY = catalogEntryFor(EVENT_LOG_NODE_TYPE);

/**
 * The one source this node draws from.
 *
 * `catalogEntryFor('eventLog').sources` is `['events']` and the panel
 * validator rejects any other source before a panel reaches a renderer, so the
 * literal is written here rather than read from that array — a query typed
 * `DataQuery & { source: 'events' }` is what gives `useQuery` the precise
 * result type `readonly TelemetryEvent[]` instead of the union of every
 * source's shape. `satisfies` keeps it inside the closed source vocabulary.
 */
const EVENT_LOG_SOURCE = 'events' as const satisfies DataQuerySource;

/*
 * ---------------------------------------------------------------------------
 * Bounds and vocabulary
 *
 * Counts and copy only. Nothing here is a length, a colour or any other visual
 * value (AAP 0.6.4), and no string names a symbol, component, route or table of
 * an inspected project (AAP 0.5.4).
 * ---------------------------------------------------------------------------
 */

/**
 * How many attribute pairs one row shows before the rest are counted instead.
 *
 * A count of pairs, not a width: the column is compact because a row is one
 * line, and the full attribute bag of a selected record belongs to the host's
 * detail drawer, which this list's row selection drives.
 */
const MAX_ATTRIBUTE_PAIRS = 3;

/** What separates an attribute's key from its already-bounded value preview. */
const ATTRIBUTE_PAIR_SEPARATOR = '=';

/** What joins the rendered runs of a row into the text the filter searches. */
const SEARCH_INDEX_SEPARATOR = ' ';

/** The kind-picker value that applies no kind narrowing of its own. */
const ALL_KINDS_VALUE = '';

/** The kind picker's "no narrowing" option. */
const ALL_KINDS_LABEL = 'All kinds';

/** The kind picker's identity within the toolbar, and its accessible name. */
const KIND_SELECT_ID = 'kind';

/** The kind picker's label. */
const KIND_SELECT_LABEL = 'Kind';

/** The text field's accessible name. It is a label element, never an attribute. */
const SEARCH_LABEL = 'Filter loaded records';

/** The text field's hint, which never substitutes for its label. */
const SEARCH_PLACEHOLDER = 'Filter text';

/** The toolbar's group name, derived from the catalog's own label for this node. */
const TOOLBAR_LABEL = `${EVENT_LOG_CATALOG_ENTRY.label} filters`;

/** Column headers. Generic product vocabulary, read off no project. */
const COLUMN_HEADER_SEQ = 'Seq';
const COLUMN_HEADER_OFFSET = 'Offset';
const COLUMN_HEADER_KIND = 'Kind';
const COLUMN_HEADER_NAME = 'Name';
const COLUMN_HEADER_ATTRIBUTES = 'Attributes';

/** What is announced while the first page resolves. */
const LOADING_LABEL = 'Loading captured records…';

/** What a capture that holds no record for this query says. */
const EMPTY_MESSAGE =
  'No records were captured for this query. Start a capture, reproduce the behaviour, then look again.';

/** The heading of the state a count-only (`limit: 0`) query resolves to. */
const COUNT_ONLY_TITLE = 'Count only';

/** What a count-only query says when the service reported no total for it. */
const COUNT_ONLY_UNKNOWN_TOTAL_MESSAGE =
  'This view requests a count without rows, and no total was reported for its query.';

/**
 * The heading of an empty page that is not an empty capture: records matched
 * the query, or may have, and none of them are on this page.
 */
const EMPTY_PAGE_TITLE = 'Nothing on this page';

/** The record noun of the empty-page copy, for a count of exactly one. */
const EVENT_NOUN_SINGULAR = 'event';

/** The record noun of the empty-page copy, for any other count. */
const EVENT_NOUN_PLURAL = 'events';

/** What a text filter that matches none of the loaded records says. */
const FILTERED_EMPTY_MESSAGE =
  'No loaded records match this text filter. Clear the filter to see the whole loaded page.';

/** What a failed query says when the provider rejected without a message. */
const ERROR_MESSAGE_FALLBACK = 'The captured records for this view could not be loaded.';

/** The paging control's label. */
const LOAD_MORE_LABEL = 'Load more';

/** The trailing word of the hidden-attribute count. */
const MORE_ATTRIBUTES_SUFFIX = 'more';

/**
 * The note that keeps the text filter honest.
 *
 * Shown only while the filter is active and the loaded page is known to be
 * shorter than the source, because that is exactly when a reader could mistake
 * "nothing matched" for "nothing exists".
 */
const PARTIAL_SEARCH_NOTE = 'Text filter applies to loaded records only';

/** The empty page an unmatched paging state resolves to, allocated once. */
const EMPTY_EVENTS: readonly TelemetryEvent[] = Object.freeze([]);

/** The empty kind set a component starts with, allocated once. */
const EMPTY_KINDS: readonly TelemetryKind[] = Object.freeze([]);

/** The empty picker list a toolbar with nothing to pick from receives. */
const EMPTY_SELECTS: readonly ToolbarSelect[] = Object.freeze([]);

/*
 * ---------------------------------------------------------------------------
 * The row model
 *
 * One value per record, with every rendered string already derived. Building it
 * once per page rather than per cell keeps the column definitions free of
 * closures — they are module constants below — and makes the text filter search
 * exactly what the reader can see.
 * ---------------------------------------------------------------------------
 */

/** One attribute of a record, as a key and an already-bounded value preview. */
interface EventLogAttributePair {
  /** The attribute's key, exactly as the producer named it. */
  readonly key: string;

  /** The value's preview: primitive, one line, and within the 120-character bound. */
  readonly text: string;
}

/** What one row of the log renders from. */
interface EventLogRow {
  /** The record itself, for the identifiers a selection reports and its location. */
  readonly event: TelemetryEvent;

  /** The producer's sequence number, formatted. */
  readonly seqLabel: string;

  /** The record's start, as an offset from the earliest loaded record. */
  readonly offsetLabel: string;

  /** The attribute pairs this row shows, at most {@link MAX_ATTRIBUTE_PAIRS}. */
  readonly pairs: readonly EventLogAttributePair[];

  /** How many further attributes the record carries and this row does not show. */
  readonly hiddenAttributeCount: number;

  /** The lower-cased text of every run this row renders, for the text filter. */
  readonly searchIndex: string;
}

/** What the attribute summariser answers with. */
interface AttributeSummary {
  /** The pairs to render, in the producer's own key order. */
  readonly pairs: readonly EventLogAttributePair[];

  /** How many attributes were left out, whether by kind or by the pair bound. */
  readonly hiddenCount: number;
}

/**
 * One page boundary, held as a single value so that the offset and the records
 * carried into it cannot disagree.
 *
 * `identity` stamps the request those records answered. A paging state whose
 * stamp no longer matches the derived query is simply not read — which is how
 * the accumulator resets when the kind filter, the authored filter, the sort,
 * the page size or the authored starting offset changes, with no state written
 * during a render and none written from an effect.
 */
interface EventLogPageState {
  /** The base query these records were loaded for; see {@link baseQueryIdentity}. */
  readonly identity: string;

  /**
   * The offset of the page currently being requested: a `nextOffset` the
   * service reported, and never less than the authored starting offset the
   * sequence began at. The authored offset itself is not stored here — it is
   * part of `identity`, and an unmatched state reads it from the node.
   */
  readonly offset: number;

  /** Every record loaded by the earlier pages of that same request. */
  readonly carried: readonly TelemetryEvent[];
}

/**
 * The paging state before anything has been paged.
 *
 * Its identity matches no derived query — a serialised query always begins with
 * its source — so the first render reads the node's authored starting offset
 * through the same path every reset does, and there is no separate
 * initialisation branch. Its own `offset` is therefore never read.
 */
const INITIAL_PAGE_STATE: EventLogPageState = Object.freeze({
  identity: '',
  offset: DATA_QUERY_DEFAULT_OFFSET,
  carried: EMPTY_EVENTS,
});

/*
 * ---------------------------------------------------------------------------
 * Pure helpers
 * ---------------------------------------------------------------------------
 */

/**
 * The page size to request: the authored limit clamped into the contract's
 * range, or the contract's default when none was authored.
 *
 * An explicit `limit: 0` is preserved and sent as zero. The query schema
 * accepts it as a deliberate request for a total with no rows, and the page
 * echo reports it back (`nodes/query.ts`, `protocol/src/http.ts`); raising it
 * would fetch a row the node never asked for and misstate what it asked. This
 * view answers such a node with a count-only state, and never pages it — a page
 * of zero rows cannot advance a sequence. Only the absence of the field means
 * "unset", and only that takes the default.
 *
 * Total over the shape rather than over the schema: a validated query carries
 * an integer within range, and this also holds for the objects that reach a
 * renderer without passing that schema — a fixture, a value cast in a consumer
 * — where a fractional, negative, enormous or non-finite limit must still
 * produce a request the resolver can answer.
 *
 * @param limit The authored `limit`, or `undefined` when the node omitted one.
 * @returns A whole number in `[0, DATA_QUERY_MAX_LIMIT]`, or
 * `DATA_QUERY_DEFAULT_LIMIT` for an omitted or non-finite limit.
 */
function clampPageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DATA_QUERY_DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 0), DATA_QUERY_MAX_LIMIT);
}

/**
 * The offset the page sequence starts at: the authored offset as a whole,
 * non-negative number, or the contract's default when none was authored.
 *
 * The authored offset is honoured exactly (AAP 0.4.2): a node that asks for the
 * records from position 201 onwards must be shown those, not the first page,
 * and an offset past the end of the source is an empty page the service
 * answers, never an error this view invents. It has no upper bound in the
 * schema — only the service knows how many records exist — so the only ceiling
 * applied is the largest integer a number represents exactly, which keeps an
 * unvalidated, enormous value from turning into a request the resolver cannot
 * echo back. Like {@link clampPageLimit}, total over the shape: a fractional,
 * negative or non-finite value still yields a request that can be answered.
 *
 * @param offset The authored `offset`, or `undefined` when the node omitted one.
 * @returns A whole number in `[DATA_QUERY_DEFAULT_OFFSET, Number.MAX_SAFE_INTEGER]`.
 */
function clampPageOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) {
    return DATA_QUERY_DEFAULT_OFFSET;
  }

  return Math.min(Math.max(Math.trunc(offset), DATA_QUERY_DEFAULT_OFFSET), Number.MAX_SAFE_INTEGER);
}

/**
 * The offset "load more" may request next, or `undefined` when there is none.
 *
 * Only the service's own `nextOffset` qualifies, and only when it moves forward
 * from the page it answered: a value equal to or behind that page's offset
 * would re-request records already on screen and append them twice, and a
 * value that is not an exact integer is not an offset at all. Nothing is ever
 * derived from the page's length or from `total` — `nextOffset` absent (the
 * wire's `null`) is the end of the data even when a total suggests otherwise,
 * because the service applied the paging and this view did not.
 *
 * @param nextOffset The `nextOffset` of the page that just resolved, if any.
 * @param resolvedOffset The `offset` that page was requested at.
 * @returns The offset to request next, or `undefined` when paging is over.
 */
function forwardNextOffset(
  nextOffset: number | undefined,
  resolvedOffset: number,
): number | undefined {
  if (nextOffset === undefined || !Number.isSafeInteger(nextOffset)) {
    return undefined;
  }

  return nextOffset > resolvedOffset ? nextOffset : undefined;
}

/**
 * The service's `total` when it is a count this view can state, otherwise
 * `undefined`.
 *
 * The contract reports a non-negative whole number, and `useQuery` passes it
 * through verbatim. Anything else — a fraction, a negative, a non-finite value
 * from a provider that did not validate its answer — is treated as no total at
 * all, so the footer and the empty state say "no total was reported" rather
 * than printing a number that is not a count.
 *
 * @param total The reported total, if any.
 * @returns That total, or `undefined` when it is absent or not a count.
 */
function reportedTotal(total: number | undefined): number | undefined {
  return total !== undefined && Number.isSafeInteger(total) && total >= 0 ? total : undefined;
}

/**
 * The authored filter with the locally chosen kind folded into `kinds`.
 *
 * Narrowing only, which is what makes it safe: the picker's options are
 * discovered from records that already satisfied the authored filter, so a
 * chosen kind is always one the authored query admitted, and replacing `kinds`
 * with that single kind can never widen what the node asked for.
 *
 * @param filter The node's own filter, or `undefined` for the whole source.
 * @param kind The chosen kind, or {@link ALL_KINDS_VALUE} for no narrowing.
 * @returns The filter to send, or `undefined` when there is nothing to narrow.
 */
function mergeKindFilter(
  filter: DataQueryFilter | undefined,
  kind: TelemetryKind | typeof ALL_KINDS_VALUE,
): DataQueryFilter | undefined {
  if (kind === ALL_KINDS_VALUE) {
    return filter;
  }

  return { ...filter, kinds: [kind] };
}

/**
 * A string that is equal for two requests of one page sequence, whatever page
 * of it they ask for.
 *
 * It is the accumulator's reset key, and deliberately not the whole query: the
 * current offset is what "load more" advances, so including it would discard
 * the earlier pages on every advance. The offset the sequence STARTED at is
 * included, because it is authored rather than advanced: a node that asks for
 * the records from another position is a different sequence, and pages carried
 * from the old one would be shown under the new one's counts. Everything else
 * — the source, the filter, the ordering and the page size — changes what the
 * pages mean, and any change to one of them must start the accumulation again.
 *
 * `JSON.stringify` is sound here because a `DataQuery` holds JSON values only
 * (strings, finite numbers, arrays of strings, plain objects) and because both
 * objects are built field by field in this module, in one order, on every
 * render: the serialisation is therefore stable for equal contents without a
 * key-sorting pass.
 *
 * @param filter The merged filter being sent.
 * @param sort The authored ordering, or `undefined` for the source's own.
 * @param limit The clamped page size.
 * @param baseOffset The clamped authored offset the sequence starts at.
 * @returns The identity of that sequence, ignoring the offset it has reached.
 */
function baseQueryIdentity(
  filter: DataQueryFilter | undefined,
  sort: DataQuery['sort'],
  limit: number,
  baseOffset: number,
): string {
  return JSON.stringify({ source: EVENT_LOG_SOURCE, filter, sort, limit, baseOffset });
}

/**
 * The paging footer's coverage statement.
 *
 * From the first record it reads as it always has — "3 of 40 records loaded",
 * or "3 records loaded" when no total was reported. From an authored starting
 * offset it is relative to that position, because the records before it were
 * never asked for: "of N" counts the records from the starting position to the
 * end of the source (never below zero), and the position is stated as the
 * 1-based ordinal of the first record requested, so the ratio cannot be read as
 * coverage of the whole capture.
 *
 * @param loadedCount How many records are on screen.
 * @param total The reported total, already vetted by {@link reportedTotal}.
 * @param baseOffset The offset the page sequence started at.
 * @returns The footer's text.
 */
function coverageLabel(loadedCount: number, total: number | undefined, baseOffset: number): string {
  const loaded = formatCount(loadedCount);

  if (baseOffset === DATA_QUERY_DEFAULT_OFFSET) {
    return total === undefined
      ? `${loaded} records loaded`
      : `${loaded} of ${formatCount(total)} records loaded`;
  }

  const position = formatCount(baseOffset + 1);

  return total === undefined
    ? `${loaded} records loaded, from position ${position}`
    : `${loaded} of ${formatCount(Math.max(total - baseOffset, 0))} records loaded, from position ${position}`;
}

/** The copy of the empty state a settled page with no records resolves to. */
interface EmptyPageCopy {
  /** The state's heading, or `undefined` for the plain empty-capture message. */
  readonly title: string | undefined;

  /** The state's sentence. */
  readonly message: string;
}

/**
 * The record noun for a count: singular for exactly one, plural otherwise.
 *
 * @param count The count the noun follows.
 * @returns `"event"` or `"events"`.
 */
function eventNoun(count: number): string {
  return count === 1 ? EVENT_NOUN_SINGULAR : EVENT_NOUN_PLURAL;
}

/**
 * What an empty page says, chosen from the counters the response carried so
 * that an empty page is never presented as an empty capture it may not be.
 *
 * Called only for a settled success that loaded no record at all — nothing on
 * this page and nothing carried from an earlier one. The cases, in order:
 *
 *   1. **count-only** — the node asked for `limit: 0`, a total without rows,
 *      so the state reports that total, or that none was reported;
 *   2. **empty capture** — the total is zero, or no total was reported for a
 *      sequence that started at the first record and has no further page: the
 *      capture holds nothing for this query, which is the one case the
 *      node's plain empty message describes;
 *   3. **past the end** — records matched, and this page starts at or beyond
 *      the last of them (an authored offset past the end is an empty page, not
 *      an error), so the state gives the page's 1-based position and the total;
 *   4. **empty within range** — records matched and this page starts before
 *      the last of them, yet the service returned none; the total is stated
 *      and nothing is invented to fill the page;
 *   5. **no total, past the first record** — the page's position is all that
 *      is known, and the state says so rather than guessing at a count.
 *
 * A page the service reports a forward `nextOffset` for never takes case 2
 * without a total of zero: more records may follow, so "nothing was captured"
 * would be a claim this page cannot make, and case 5 states its position
 * instead.
 *
 * @param limit The clamped page size that was requested.
 * @param total The reported total, already vetted by {@link reportedTotal}.
 * @param baseOffset The offset the page sequence started at.
 * @param offset The offset of the page that just resolved.
 * @param hasForwardPage Whether the service reported a forward `nextOffset`.
 * @returns The empty state's heading and sentence.
 */
function describeEmptyPage(
  limit: number,
  total: number | undefined,
  baseOffset: number,
  offset: number,
  hasForwardPage: boolean,
): EmptyPageCopy {
  if (limit === 0) {
    return {
      title: COUNT_ONLY_TITLE,
      message:
        total === undefined
          ? COUNT_ONLY_UNKNOWN_TOTAL_MESSAGE
          : `This view requests a count without rows: ${formatCount(total)} ${eventNoun(total)} matched its query.`,
    };
  }

  if (
    total === 0 ||
    (total === undefined && baseOffset === DATA_QUERY_DEFAULT_OFFSET && !hasForwardPage)
  ) {
    return { title: undefined, message: EMPTY_MESSAGE };
  }

  const position = formatCount(offset + 1);

  if (total === undefined) {
    return {
      title: EMPTY_PAGE_TITLE,
      message: `This page starts at position ${position} and holds no ${EVENT_NOUN_PLURAL}; no total was reported for this query.`,
    };
  }

  const matched = `${formatCount(total)} ${eventNoun(total)}`;

  return {
    title: EMPTY_PAGE_TITLE,
    message:
      offset >= total
        ? `This page starts at position ${position}, past the end of the ${matched} that matched this query.`
        : `${matched} matched this query, but none are shown on this page.`,
  };
}

/**
 * The failed query, serialised for the error state.
 *
 * Pretty-printed JSON is the form that state documents: a developer has to be
 * able to read what was asked for, not only that asking failed. The query holds
 * no captured data — a source, a narrowing filter and paging numbers — so
 * nothing redacted passes through here.
 *
 * @param query The request that failed.
 * @returns The request as indented JSON.
 */
function serialiseQuery(query: DataQuery): string {
  return JSON.stringify(query, null, 2);
}

/**
 * The preview of one attribute value, or `undefined` when this view will not
 * show it.
 *
 * Primitive values only, and that is a privacy decision rather than a
 * convenience: a structured value — a captured prop summary, a changed-key list
 * — is already a bounded summary produced upstream (AAP 0.5.2), and unpacking
 * one into a row would be this renderer expanding what a producer deliberately
 * collapsed. Those values are counted as "more" instead, and the host's detail
 * drawer is where a reader opens the record in full.
 *
 * Strings go through this package's truncation helper, whose default budget is
 * the 120-character bound the producer was held to, so the rendered text can
 * only ever be shorter than what was captured.
 *
 * @param value One attribute value, as the open attribute bag holds it.
 * @returns A one-line preview, or `undefined` for a value not shown here.
 */
function primitiveAttributeText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return oneLinePreview(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : NOT_AVAILABLE_LABEL;
  }
  if (typeof value === 'boolean') {
    return String(value);
  }

  return undefined;
}

/**
 * The pairs one row shows, and how many attributes it leaves for the drawer.
 *
 * Key order is the producer's own, never re-sorted: the order a record carries
 * its attributes in is part of what the producer recorded, and re-ordering it
 * would make two views of one record disagree.
 *
 * @param attributes The record's open attribute bag.
 * @returns The bounded pair list and the count of everything omitted.
 */
function summariseAttributes(attributes: Record<string, unknown>): AttributeSummary {
  const pairs: EventLogAttributePair[] = [];
  let hiddenCount = 0;

  for (const [key, value] of Object.entries(attributes)) {
    const text = primitiveAttributeText(value);

    if (text === undefined || pairs.length >= MAX_ATTRIBUTE_PAIRS) {
      hiddenCount += 1;
      continue;
    }

    pairs.push({ key, text });
  }

  return { pairs, hiddenCount };
}

/**
 * The text the row's filter searches: exactly the runs the row renders, lower
 * cased.
 *
 * Built from the rendered strings rather than from the record, which is what
 * makes the filter honest in the small: a match always corresponds to something
 * the reader can see on the row, and a field the row does not show — the tier,
 * the duration, an unshown attribute — cannot produce a match that appears to
 * come from nowhere. The status word is included only when the row renders it.
 *
 * Lower-cased with `toLowerCase`, not its locale-sensitive sibling, so the same
 * capture filters identically on every machine.
 *
 * @param event The record.
 * @param seqLabel The formatted sequence number, as rendered.
 * @param offsetLabel The formatted offset, as rendered.
 * @param pairs The attribute pairs this row renders.
 * @returns The row's lower-cased search index.
 */
function buildSearchIndex(
  event: TelemetryEvent,
  seqLabel: string,
  offsetLabel: string,
  pairs: readonly EventLogAttributePair[],
): string {
  const parts: string[] = [seqLabel, offsetLabel, formatKindLabel(event.kind), event.name];

  if (event.status === 'error') {
    parts.push(formatStatusLabel(event.status));
  }

  for (const pair of pairs) {
    parts.push(pair.key, pair.text);
  }

  const { source } = event;
  if (source !== undefined) {
    parts.push(source.file);

    if (source.symbol !== undefined) {
      parts.push(source.symbol);
    }
  }

  return parts.join(SEARCH_INDEX_SEPARATOR).toLowerCase();
}

/**
 * The earliest start among the loaded records, which every offset is measured
 * from.
 *
 * The canonical time base is epoch milliseconds as a double (AAP 0.2.3), and
 * epoch text beside an interaction would be noise, so the log shows offsets.
 * The origin is the earliest record this view has loaded — which is the
 * capture's own start whenever the first page arrived in ascending order, and
 * is in every case an origin the reader can see on the first row, since that
 * row's offset is zero.
 *
 * Non-finite when there are no records, which is what makes every offset read
 * as the package's "not available" label rather than as a measured zero.
 *
 * @param events Every record loaded so far.
 * @returns The earliest `startTime`, or positive infinity for no records.
 */
function loadedOrigin(events: readonly TelemetryEvent[]): number {
  let origin = Number.POSITIVE_INFINITY;

  for (const event of events) {
    if (event.startTime < origin) {
      origin = event.startTime;
    }
  }

  return origin;
}

/**
 * One row model from one record.
 *
 * @param event The record.
 * @param originEpochMs The origin every offset in this page is measured from.
 * @returns The row model the columns below render.
 */
function buildRowModel(event: TelemetryEvent, originEpochMs: number): EventLogRow {
  const seqLabel = formatCount(event.seq);
  const offsetLabel = formatOffset(event.startTime, originEpochMs);
  const { pairs, hiddenCount } = summariseAttributes(event.attributes);

  return {
    event,
    seqLabel,
    offsetLabel,
    pairs,
    hiddenAttributeCount: hiddenCount,
    searchIndex: buildSearchIndex(event, seqLabel, offsetLabel, pairs),
  };
}

/**
 * The row models for a page, in the order the resolver returned it.
 *
 * The order is never touched: the data layer applied the filter, the ordering
 * and the paging (AAP 0.4.2), and a client that re-sorted a page would disagree
 * with the `total` and `nextOffset` it was handed.
 *
 * @param events Every record loaded so far, earlier pages first.
 * @returns One row model per record, in that same order.
 */
function buildRowModels(events: readonly TelemetryEvent[]): readonly EventLogRow[] {
  const origin = loadedOrigin(events);

  return events.map((event) => buildRowModel(event, origin));
}

/**
 * Whether a row's rendered text contains the needle.
 *
 * @param row The row model.
 * @param needle An already trimmed, already lower-cased search string.
 * @returns `true` when the row shows that text.
 */
function rowMatches(row: EventLogRow, needle: string): boolean {
  return row.searchIndex.includes(needle);
}

/** A total order on kinds that does not depend on a locale. */
function compareKinds(left: TelemetryKind, right: TelemetryKind): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

/**
 * The kinds the picker offers.
 *
 * The kind vocabulary is a runtime value of `@debuggen/telemetry`, which this
 * package may use for types only (AAP 0.2.2), so the option set is discovered
 * rather than enumerated, from four sources whose union is what a reader needs:
 *
 *   1. the kinds present in the loaded records — the ones this capture can
 *      prove exist;
 *   2. the kinds the panel's author already named in the node's filter, which
 *      remain meaningful even before a record of that kind has arrived;
 *   3. the kinds seen before the last narrowing, remembered at the moment the
 *      reader narrowed, so choosing one kind does not empty the picker of the
 *      others;
 *   4. the chosen kind itself, so the control can always show its own value.
 *
 * @param rows The loaded rows.
 * @param authored The kinds the node's own filter names, if any.
 * @param remembered The kinds seen before the reader last narrowed.
 * @param selected The chosen kind, or {@link ALL_KINDS_VALUE}.
 * @returns The kinds to offer, in a stable order.
 */
function collectKinds(
  rows: readonly EventLogRow[],
  authored: readonly TelemetryKind[] | undefined,
  remembered: readonly TelemetryKind[],
  selected: TelemetryKind | typeof ALL_KINDS_VALUE,
): readonly TelemetryKind[] {
  const kinds = new Set<TelemetryKind>(remembered);

  if (authored !== undefined) {
    for (const kind of authored) {
      kinds.add(kind);
    }
  }

  for (const row of rows) {
    kinds.add(row.event.kind);
  }

  if (selected !== ALL_KINDS_VALUE) {
    kinds.add(selected);
  }

  return [...kinds].sort(compareKinds);
}

/**
 * The picker's options: the "no narrowing" choice, then one per kind.
 *
 * @param kinds The kinds to offer, already ordered.
 * @returns The options, "all kinds" first.
 */
function buildKindOptions(kinds: readonly TelemetryKind[]): readonly SelectOption[] {
  return [
    { value: ALL_KINDS_VALUE, label: ALL_KINDS_LABEL },
    ...kinds.map((kind) => ({ value: kind, label: formatKindLabel(kind) })),
  ];
}

/**
 * The identifiers a selected row reports to the host.
 *
 * Three ids and nothing else: the host's detail drawer reads the record from
 * the capture the panel was generated against, so a selection that carried a
 * copy of the record would let the two disagree. The trace and span ids travel
 * with it because a drawer routinely offers "show this record's trace", which
 * needs no second lookup to be able to.
 *
 * @param event The activated record.
 * @returns The event reference `PanelActions.onSelectEvent` takes.
 */
function toEventRef(event: TelemetryEvent): PanelEventRef {
  return { eventId: event.id, spanId: event.spanId, traceId: event.traceId };
}

/**
 * The failure sentence the error state shows.
 *
 * The provider's own message where it has one — it is the failure as the layer
 * that observed it understands it — followed by its hint when one was supplied,
 * because a hint is the only actionable part of most transport failures. Never
 * an inference about a cause: that belongs to a validated analysis, not to an
 * error box (AAP 0.5.5).
 *
 * @param message The rejected query's message, when the provider gave one.
 * @param hint The rejection's hint, when it carried one.
 * @returns One sentence, or the generic fallback.
 */
function errorSentence(message: string | undefined, hint: string | undefined): string {
  const parts = [message, hint].filter((part): part is string => part !== undefined && part !== '');

  return parts.length === 0 ? ERROR_MESSAGE_FALLBACK : parts.join(' ');
}

/** The React key, selection identity and measurement key of a row. */
function eventLogRowKey(row: EventLogRow): string {
  return row.event.id;
}

/*
 * ---------------------------------------------------------------------------
 * The columns
 *
 * Module constants, and pure functions of one row model. They close over
 * nothing from a render, so the column list has one identity for the life of
 * the module and a row's cells depend on the row alone.
 *
 * Every track is relational or a `ch` measure that resolves identically in
 * every row: the header row and each data row are separate grid containers, so
 * an intrinsic track would size itself from one row's own content and stop
 * sitting under its own header (see `../primitives/DataTable`). No track is a
 * literal length (AAP 0.6.4).
 * ---------------------------------------------------------------------------
 */

/** The producer's sequence number: capture order, as the producer recorded it. */
function renderSeqCell(row: EventLogRow): ReactNode {
  return (
    <Text size="xs" tone="muted" numeric className="dg-event-log__seq">
      {row.seqLabel}
    </Text>
  );
}

/** The record's start, as an offset from the earliest loaded record. */
function renderOffsetCell(row: EventLogRow): ReactNode {
  return (
    <Text size="xs" tone="secondary" numeric className="dg-event-log__time">
      {row.offsetLabel}
    </Text>
  );
}

/**
 * The record's kind, as a chip in the kind colour.
 *
 * The colour arrives as a `var(--dg-kind-*)` reference from `../utils/color`
 * and lands on the chip's fill, while the chip's own label carries the meaning
 * — which is what keeps the kind readable in the high-contrast theme and to a
 * reader who cannot distinguish the hues (AAP 0.6.3, 0.6.4).
 */
function renderKindCell(row: EventLogRow): ReactNode {
  const { kind } = row.event;

  return <Badge color={kindColorVar(kind)}>{formatKindLabel(kind)}</Badge>;
}

/**
 * The record's own label, and the two things that qualify it.
 *
 * A failed record is marked by a chip with the danger tone and the status word
 * in it, never by a colour alone, and the vocabulary is the captured status's —
 * no severity is invented beyond the status and the kind the producer reported.
 * A record that resolved to a project location carries the dense source chip,
 * whose click is its own: the table excludes clicks from interactive
 * descendants from row activation, so opening a file never also selects a row.
 *
 * The cell is itself a flex row with the design system's own gap, so the runs
 * below need no spacing of their own.
 */
function renderNameCell(row: EventLogRow): ReactNode {
  const { event } = row;

  return (
    <>
      {event.status === 'error' ? (
        <Badge tone="danger">{formatStatusLabel(event.status)}</Badge>
      ) : null}
      <Text size="sm" truncate title={event.name} className="dg-event-log__name">
        {event.name}
      </Text>
      {event.source === undefined ? null : <SourceLink location={event.source} compact />}
    </>
  );
}

/**
 * A compact strip of the record's attributes, and an honest count of the rest.
 *
 * Values are shown exactly as they arrived — already redacted, already bounded
 * — and nothing here expands, re-parses or reconstructs one (AAP 0.5.2). What
 * is not shown is counted rather than dropped, so the strip never implies that
 * a record carries less than it does.
 */
function renderAttributesCell(row: EventLogRow): ReactNode {
  if (row.pairs.length === 0 && row.hiddenAttributeCount === 0) {
    return (
      <Text size="xs" tone="muted">
        {NOT_AVAILABLE_LABEL}
      </Text>
    );
  }

  return (
    <Stack direction="horizontal" gap={1} align="center" className="dg-event-log__attrs">
      {row.pairs.map((pair) => (
        <Code key={pair.key} size="sm">
          {`${pair.key}${ATTRIBUTE_PAIR_SEPARATOR}${pair.text}`}
        </Code>
      ))}
      {row.hiddenAttributeCount > 0 ? (
        <Text size="xs" tone="muted">
          {`+${formatCount(row.hiddenAttributeCount)} ${MORE_ATTRIBUTES_SUFFIX}`}
        </Text>
      ) : null}
    </Stack>
  );
}

/**
 * The five columns of the log, left to right.
 *
 * No column is sortable and no `onSortChange` is offered: the ordering is the
 * one the node's query asked the resolver for, and a control that re-ordered
 * the loaded page locally would disagree with the paging counters the same
 * response carried (AAP 0.4.2).
 */
const EVENT_LOG_COLUMNS: readonly DataTableColumn<EventLogRow>[] = Object.freeze([
  { key: 'seq', header: COLUMN_HEADER_SEQ, align: 'end', width: '8ch', cell: renderSeqCell },
  {
    key: 'startTime',
    header: COLUMN_HEADER_OFFSET,
    align: 'end',
    width: '11ch',
    cell: renderOffsetCell,
  },
  { key: 'kind', header: COLUMN_HEADER_KIND, width: '18ch', cell: renderKindCell },
  {
    key: 'name',
    header: COLUMN_HEADER_NAME,
    width: 'minmax(0, 1fr)',
    rowHeader: true,
    cell: renderNameCell,
  },
  {
    key: 'attributes',
    header: COLUMN_HEADER_ATTRIBUTES,
    width: 'minmax(0, 2fr)',
    cell: renderAttributesCell,
  },
]);

/*
 * ---------------------------------------------------------------------------
 * The component
 * ---------------------------------------------------------------------------
 */

/** The props of {@link EventLog}. */
export interface EventLogProps {
  /**
   * The normalized `eventLog` node this component renders: its identity, its
   * optional labels and the `DataQuery` it draws from.
   *
   * `node.id` is the node identity every `PanelActions` callback reports, so a
   * host with two logs in one panel can tell which one spoke.
   */
  node: EventLogNode;

  /**
   * Extra classes composed after `dg-event-log`, for the layout the surrounding
   * node owns.
   *
   * It is composition, never an escape hatch for visual values: any class named
   * here is defined in `../styles/components.css` against `--dg-*` tokens, like
   * every other class in this package.
   */
  className?: string | undefined;
}

/**
 * Renders the captured records of one query as a filterable, virtualized log.
 *
 * @param props The props, as documented on {@link EventLogProps}.
 * @returns The block: a filter row, one of the four bodies (busy, failed,
 * empty, or the grid) and — once anything has loaded, or while the service
 * reports a further page — the paging footer.
 *
 * @example A node straight from a validated panel specification.
 * ```tsx
 * <EventLog node={node} />
 * ```
 */
export function EventLog(props: EventLogProps): ReactElement {
  const { node, className } = props;

  // The host's callbacks, legitimately absent in a surface that only displays;
  // reading the context is unconditional, as a hook must be, and safe outside a
  // provider by that module's documented contract.
  const actions = usePanelActions();

  const [selectedKind, setSelectedKind] = useState<TelemetryKind | typeof ALL_KINDS_VALUE>(
    ALL_KINDS_VALUE,
  );
  const [rememberedKinds, setRememberedKinds] = useState<readonly TelemetryKind[]>(EMPTY_KINDS);
  const [searchValue, setSearchValue] = useState('');
  const [page, setPage] = useState<EventLogPageState>(INITIAL_PAGE_STATE);

  const authoredQuery = node.query;
  const authoredKinds = authoredQuery.filter?.kinds;
  const limit = clampPageLimit(authoredQuery.limit);
  const baseOffset = clampPageOffset(authoredQuery.offset);
  const filter = mergeKindFilter(authoredQuery.filter, selectedKind);
  const identity = baseQueryIdentity(filter, authoredQuery.sort, limit, baseOffset);

  // A paging state whose stamp no longer matches the request is not read, which
  // is the whole of the accumulator's reset: no state is written during this
  // render and none is written from an effect, so a changed filter, ordering,
  // page size or authored starting offset returns the view to the first page
  // of its sequence — the node's own `offset` — in the very render that
  // changed it.
  const paging = page.identity === identity ? page : undefined;
  const carried = paging?.carried ?? EMPTY_EVENTS;
  const offset = paging?.offset ?? baseOffset;

  // Rebuilt every render on purpose: `useQuery` compares a query's CONTENTS and
  // not its identity, so memoizing this would need the very key that hook
  // already computes.
  const query: DataQuery & { source: typeof EVENT_LOG_SOURCE } = {
    source: EVENT_LOG_SOURCE,
    filter,
    sort: authoredQuery.sort,
    limit,
    offset,
  };

  const { status, data, error, total, nextOffset, retry } = useQuery(query);

  // Earlier pages first, then the page that just resolved. While a further page
  // is in flight `data` is absent and the carried records stand alone, so the
  // counts below never overstate what has arrived.
  const events = useMemo(
    () => (data === undefined ? carried : carried.concat(data)),
    [carried, data],
  );
  const rows = useMemo(() => buildRowModels(events), [events]);

  const needle = searchValue.trim().toLowerCase();
  const visibleRows = useMemo(
    () => (needle === '' ? rows : rows.filter((row) => rowMatches(row, needle))),
    [needle, rows],
  );

  const availableKinds = useMemo(
    () => collectKinds(rows, authoredKinds, rememberedKinds, selectedKind),
    [authoredKinds, rememberedKinds, rows, selectedKind],
  );
  const kindOptions = useMemo(() => buildKindOptions(availableKinds), [availableKinds]);

  const handleSearchChange = useCallback((next: string): void => {
    setSearchValue(next);
  }, []);

  // Choosing a kind is a RE-QUERY, not a local filter: the kind goes into the
  // request's `filter.kinds`, the accumulator resets with the new request
  // identity, and the host is told which narrowing the reader asked for. The
  // options in hand are remembered first, so narrowing to one kind does not
  // empty the picker of the others.
  const handleKindChange = useCallback(
    (next: string): void => {
      const resolved = availableKinds.find((kind) => kind === next) ?? ALL_KINDS_VALUE;

      setRememberedKinds(availableKinds);
      setSelectedKind(resolved);
      actions?.onFilterChange?.(node.id, { kinds: resolved });
    },
    [actions, availableKinds, node.id],
  );

  // What the page that just resolved says about the sequence. Derived here,
  // BEFORE the callbacks below, on purpose: every helper that reads the
  // sequence's numbers (`offset`, `baseOffset`, `limit`) is called ahead of the
  // `useCallback` that closes over `identity`, which is derived from those same
  // numbers. The React Compiler cannot see that they are primitives, so a
  // helper call after that callback would read to it as a later mutation of a
  // memoized dependency and make it skip this component.
  const loadedCount = rows.length;
  const knownTotal = reportedTotal(total);

  // The next offset is the response's own, copied rather than derived from the
  // length of a page or from the total, which would drift the moment the
  // resolver clamped a limit — and followed only when it moves past the page it
  // answered, so a response pointing back at that page cannot re-append it.
  // Read only off a settled success: `data` belongs to the request at `offset`
  // exactly when `useQuery` reports it. A count-only request (`limit: 0`) is
  // never paged, whatever `nextOffset` it is answered with: a page of zero rows
  // cannot advance, so a second request would only repeat the first.
  const loadMoreOffset =
    status === 'success' && data !== undefined && limit > 0
      ? forwardNextOffset(nextOffset, offset)
      : undefined;
  const hasMore = loadMoreOffset !== undefined;

  const footerLabel = coverageLabel(loadedCount, knownTotal, baseOffset);

  // Present exactly when a settled success loaded no record at all — nothing on
  // this page and nothing carried from an earlier one — which is when the empty
  // body is drawn, and phrased from that response's own counters.
  const emptyPage =
    status === 'success' && loadedCount === 0
      ? describeEmptyPage(limit, knownTotal, baseOffset, offset, hasMore)
      : undefined;

  const handleLoadMore = useCallback((): void => {
    if (loadMoreOffset === undefined || data === undefined) {
      return;
    }

    setPage({ identity, offset: loadMoreOffset, carried: carried.concat(data) });
  }, [carried, data, identity, loadMoreOffset]);

  const selectEvent = actions?.onSelectEvent;
  const handleRowActivate = useCallback(
    (row: EventLogRow): void => {
      selectEvent?.(toEventRef(row.event));
    },
    [selectEvent],
  );

  const visibleCount = visibleRows.length;
  const filtering = needle !== '';
  // Measured against the WHOLE source, not the part after the authored offset:
  // the text filter never reached the records before that position either.
  const partialSource = knownTotal === undefined || loadedCount < knownTotal;

  // Two statements, both about what the reader is looking at rather than what
  // exists: how much of the loaded page the text filter kept, and — while that
  // filter is narrowing a page shorter than the source — that it never reached
  // the rest of the capture at all.
  const toolbarStatus: readonly ToolbarStatus[] = [
    ...(filtering
      ? [
          {
            label: `${formatCount(visibleCount)} of ${formatCount(loadedCount)} loaded records match`,
          },
        ]
      : []),
    ...(filtering && partialSource
      ? [{ label: PARTIAL_SEARCH_NOTE, tone: 'warning' as const }]
      : []),
  ];

  // Offered only when there is something to choose: a picker holding nothing
  // but "all kinds" is a control that cannot act.
  const kindSelects: readonly ToolbarSelect[] =
    kindOptions.length > 1
      ? [
          {
            id: KIND_SELECT_ID,
            label: KIND_SELECT_LABEL,
            value: selectedKind,
            options: kindOptions,
            onValueChange: handleKindChange,
          },
        ]
      : EMPTY_SELECTS;

  // The four bodies, in the order AAP 0.6.2 fixes: busy, failed, absent, then
  // the grid. An empty page and a failed request are different answers and are
  // never merged - `"success"` with no rows is an absence phrased from the
  // response's own counters (see `describeEmptyPage`), while a rejection is a
  // failure with a retry (AAP 0.5.5).
  let body: ReactNode;

  if (status === 'loading') {
    body = (
      <div className="dg-event-log__loading">
        <LoadingState variant="rows" label={LOADING_LABEL} />
      </div>
    );
  } else if (status === 'error') {
    body = (
      <div className="dg-event-log__error">
        <ErrorState
          message={errorSentence(error?.message, error?.hint)}
          code={error?.code}
          query={serialiseQuery(query)}
          onRetry={retry}
          icon={<TriangleAlert className="dg-icon" />}
        />
      </div>
    );
  } else if (emptyPage !== undefined) {
    body = (
      <div className="dg-event-log__empty">
        <EmptyState
          title={emptyPage.title}
          message={emptyPage.message}
          icon={<ScrollText className="dg-icon" />}
        />
      </div>
    );
  } else {
    body = (
      <DataTable
        rows={visibleRows}
        columns={EVENT_LOG_COLUMNS}
        rowKey={eventLogRowKey}
        caption={node.title ?? EVENT_LOG_CATALOG_ENTRY.label}
        onRowActivate={selectEvent === undefined ? undefined : handleRowActivate}
        empty={<EmptyState message={FILTERED_EMPTY_MESSAGE} icon={<ListX className="dg-icon" />} />}
      />
    );
  }

  return (
    <div className={clsx('dg-event-log', className)}>
      <Toolbar
        className="dg-event-log__toolbar"
        label={TOOLBAR_LABEL}
        search={{
          value: searchValue,
          onValueChange: handleSearchChange,
          label: SEARCH_LABEL,
          placeholder: SEARCH_PLACEHOLDER,
          labelHidden: true,
        }}
        selects={kindSelects}
        status={toolbarStatus}
        compact
        wrap
      />
      {body}
      {/* The footer follows what has loaded, and also an empty page the service
          reports a forward `nextOffset` for: that page ends nothing, and the
          next one must stay reachable. */}
      {loadedCount > 0 || hasMore ? (
        <Stack
          direction="horizontal"
          align="center"
          justify="between"
          gap={2}
          wrap
          className="dg-data-table__footer"
        >
          <Text size="xs" tone="muted">
            {footerLabel}
          </Text>
          {hasMore ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<ChevronDown className="dg-icon" />}
              onClick={handleLoadMore}
            >
              {LOAD_MORE_LABEL}
            </Button>
          ) : null}
        </Stack>
      ) : null}
    </div>
  );
}
