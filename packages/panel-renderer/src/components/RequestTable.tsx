/**
 * `RequestTable` — the component behind the node catalog's `requestTable` type:
 * network calls grouped so that repeats collide, each group badged with its
 * duplicate evidence and expandable to every occurrence with the code that
 * issued it (AAP 0.6.2).
 *
 * This is the body of the product's third demonstrated question — "why are
 * these requests duplicated?" (AAP 0.6.5) — and the view an end-to-end
 * assertion about a duplicate group reads. Everything it needs to answer that
 * question arrives in the rows: how many times one logical request occurred,
 * how many of those were redundant, how tightly they clustered, and which
 * distinct callers issued them.
 *
 * ## Grouping is upstream, and that is the whole design
 *
 * **Nothing in this file groups, de-duplicates, counts duplicates or compares
 * one URL with another.** The reason is a privacy constraint rather than a
 * division of labour (AAP 0.5.2): a URL's query-parameter *values* are replaced
 * per key before anything is stored, broadcast or shown, so two requests that
 * differ only in a parameter arrive here with byte-identical display text. The
 * distinction is preserved instead by a key the service computes from the
 * request *as it was actually made* — an HMAC over the method, the path and the
 * sorted query pairs of the unredacted URL — and the telemetry aggregate groups
 * by that key.
 *
 * A client-side grouping pass therefore could not reproduce the answer: it
 * would merge two differently parameterized calls into one "duplicate" group
 * and state it confidently. So `count`, `duplicateCount`, `hasDuplicates` and
 * `duplicateWindows` are rendered exactly as received, and the only per-row
 * reasoning this file does is presentational — picking the largest cluster to
 * describe in a tooltip, and looking up which of a group's own occurrences
 * carries a source location for one of its own initiator labels.
 *
 * ## `groupedBy` is shown, always
 *
 * A group is formed either from that authoritative key (`request-key`) or, when
 * no key was available, from the method and path alone (`method-path`). The
 * second is coarser: two parameterisations may have merged into one row. Each
 * row therefore carries its grouping as a badge with the consequence spelled
 * out in its tooltip, and the toolbar says so at page level when any row used
 * the fallback — including when a page mixes the two. A duplicate claim is only
 * evidence-backed if the reader can see which grouping produced it.
 *
 * ## What the catalog entry fixes
 *
 * `catalogEntryFor('requestTable')` is the single registry this component is
 * written against. It permits exactly one query source, `requests`, and its
 * `reads` list — the span identity, timing, taxonomy, status and source fields
 * plus the attribute keys of the request kinds — is the set of telemetry fields
 * the columns below draw from: method, redacted URL and path, occurrence
 * counts, status codes, timing aggregates, transferred bytes, initiators and
 * per-occurrence source locations. No field outside that list is read, and the
 * entry's `label` is the table's accessible name when the node carries no
 * title of its own.
 *
 * ## Data, interaction and paging
 *
 * Data arrives only through the node's `DataQuery`, resolved by `useQuery`
 * against the ambient `DataProvider`; interactions leave only through
 * `PanelActions`. There is no socket, no `fetch` and no message name in this
 * file (AAP 0.1.2), and no transport detail reaches a column.
 *
 * Ordering and paging belong to the side that owns the capture (AAP 0.4.2): a
 * sort change is a **re-query** in the closed `DataQuerySort` vocabulary, never
 * a local re-order, and "load more" advances `offset` to the `nextOffset` the
 * response reported, keeping the pages already received. Two things are local
 * and are labelled as such wherever they are visible: the disclosure state of a
 * row, and the "duplicates only" toggle, which can only filter the groups
 * loaded so far because the query contract cannot express "duplicates only".
 *
 * ## Colour and spacing
 *
 * No colour value and no spacing value is written here. Status and grouping
 * tones resolve through `Badge` tones and the `.dg-request-table__status--*`
 * rules committed in `../styles/components.css`; duration emphasis is
 * `DurationCell`'s `severity="auto"`; every gap comes from `Stack` or
 * `Toolbar`; and there is no inline `style` at all (AAP 0.6.4).
 *
 * The pending state adds no class name of its own. A request still in flight
 * when the capture ended is drawn as the base status chip with the `Badge`'s
 * own token-backed `info` tone and `outline` fill (`dg-badge--info`,
 * `dg-badge--outline`), an hourglass icon and the visible word "Pending" — the
 * same way a code of the `unknown` class has no stylesheet modifier and is
 * carried by the chip and its tone alone. So the stylesheet needs no rule for
 * it, and every class this file emits is still one the stylesheet defines.
 */

import clsx from 'clsx';
import { ChevronDown, ChevronRight, Copy, Hourglass } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import {
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
  DATA_QUERY_SORTS,
  catalogEntryFor,
  isDataQuerySort,
} from '@debuggen/panel-schema';
import type {
  DataQuery,
  DataQuerySort,
  DataQuerySource,
  RequestTableNode,
} from '@debuggen/panel-schema';
import type { SourceLocation } from '@debuggen/shared';
import type {
  DuplicateWindow,
  RequestGroup,
  RequestGroupedBy,
  RequestOccurrence,
  TelemetryStatus,
} from '@debuggen/telemetry';

import { usePanelActions } from '../host/PanelActions';
import { useQuery } from '../host/useQuery';
import { Stack } from '../layout/Stack';
import { Toolbar } from '../layout/Toolbar';
import type { ToolbarAction, ToolbarSelect, ToolbarStatus } from '../layout/Toolbar';
import { Badge } from '../primitives/Badge';
import type { BadgeTone, BadgeVariant } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { Code } from '../primitives/Code';
import { DataTable } from '../primitives/DataTable';
import type { DataTableColumn, DataTableSort } from '../primitives/DataTable';
import { DurationCell } from '../primitives/DurationCell';
import { EmptyState } from '../primitives/EmptyState';
import { ErrorState } from '../primitives/ErrorState';
import { LoadingState } from '../primitives/LoadingState';
import { Text } from '../primitives/Text';
import { Tooltip } from '../primitives/Tooltip';
import {
  NOT_AVAILABLE_LABEL,
  formatBytes,
  formatCount,
  formatDuration,
  formatOffset,
  formatStatusLabel,
  humanizeLabel,
  oneLinePreview,
} from '../utils/format';
import { SourceLink } from './SourceLink';

/*
 * ---------------------------------------------------------------------------
 * The catalog entry and the query this view is built from
 * ---------------------------------------------------------------------------
 */

/**
 * The node catalog's registry entry for this component's node type.
 *
 * Read once at module scope, because it is a frozen declaration rather than
 * state. Two of its members are used below — `sources`, which pins the query
 * source, and `label`, which names the table when the node has no title — and
 * its `reads` list is the field set the columns are written against.
 *
 * Every column maps onto that list, field for field, through the aggregate that
 * projects it: the method badge to `http.method`; the row header to `url` and
 * `path`; the status badges to `http.status_code` and `status`; the Pending
 * badges to `inFlight`, which the aggregate projects as the occurrence's
 * `pending` flag and the group's `pendingCount`; the occurrence,
 * duplicate and cluster counts to the `request_key` grouping over `startTime`;
 * the three duration cells to `duration`; the transfer cell to `transferSize`;
 * the caller chips to `initiator` and `source`; and an occurrence's selection to
 * `id`, `spanId` and `traceId`. Nothing outside the entry's `reads` is drawn,
 * and the entry's `telemetryKinds` (the request kinds) is what bounds the rows
 * to network calls.
 */
const CATALOG_ENTRY = catalogEntryFor('requestTable');

/**
 * The one source the catalog permits for a `requestTable` node.
 *
 * Pinned as a literal rather than read off the node, for two reasons. The
 * catalog allows exactly one source here and the syntactic validator rejects a
 * node that names another, so a spec that reaches a renderer cannot disagree
 * with this constant; and writing it as a literal is what gives `useQuery` its
 * precise result type — `readonly RequestGroup[]` — instead of the union of
 * every source's result, which no column could read.
 *
 * `satisfies` rather than an annotation: membership in the source vocabulary is
 * checked, and the literal type survives for the hook to infer from.
 */
const REQUESTS_SOURCE = 'requests' satisfies DataQuerySource;

/**
 * The ordering a request table opens with when its node authored none.
 *
 * Largest group first: this view exists to make repetition visible, and a page
 * ordered by anything else buries the finding it was chosen to show. An
 * authored `sort` always wins — this is the default of the control, applied to
 * the request exactly as the toolbar's own selection is.
 */
const DEFAULT_SORT: DataQuerySort = 'count_desc';

/** Smallest `limit` the paging contract accepts (AAP 0.4.2). */
const MIN_QUERY_LIMIT = 1;

/**
 * How many distinct status codes a row shows individually before the rest are
 * summarised into one overflow badge.
 *
 * Three fits the dense row without wrapping; a group that saw more codes than
 * that is unusual enough that the overflow badge's tooltip is the right place
 * for the full list.
 */
const MAX_STATUS_BADGES = 3;

/*
 * ---------------------------------------------------------------------------
 * Fixed label and tone vocabularies
 *
 * Every mapping below is a `Readonly<Record<…>>` over a closed vocabulary, so
 * adding a member to that vocabulary upstream fails this file's typecheck
 * instead of silently rendering an unmapped value.
 * ---------------------------------------------------------------------------
 */

/** The authoritative grouping: formed from the service's pre-redaction key. */
const KEYED_GROUPING: RequestGroupedBy = 'request-key';

/** The coarser grouping: formed from the method and path when no key existed. */
const FALLBACK_GROUPING: RequestGroupedBy = 'method-path';

/** Badge tone per grouping: the fallback is called out, the key is not. */
const GROUPING_TONES: Readonly<Record<RequestGroupedBy, BadgeTone>> = {
  'request-key': 'neutral',
  'method-path': 'warning',
};

/**
 * What each grouping means for the reader, shown in the badge's tooltip.
 *
 * The fallback's note states the consequence rather than the mechanism: rows
 * may have merged, so a duplicate count on such a row is an upper bound.
 */
const GROUPING_NOTES: Readonly<Record<RequestGroupedBy, string>> = {
  'request-key':
    'Grouped by the key computed from the request as it was made, before its query values were redacted. Identical requests collide; requests that differ only in a parameter stay apart.',
  'method-path':
    'Fallback grouping: no request key was available, so occurrences were grouped by method and path alone. Requests that differ only in a query parameter may have merged into this row, so its counts are an upper bound.',
};

/** Toolbar note when every fallback-grouped row shares the page with keyed rows. */
const MIXED_GROUPING_LABEL = 'Mixed grouping';

/** Toolbar note when the loaded rows are all fallback-grouped. */
const FALLBACK_GROUPING_LABEL = 'Fallback grouping';

/**
 * The classes of HTTP response status this view distinguishes.
 *
 * A class describes a status code that was **reported**; it never stands for
 * the absence of one. An occurrence without a code is one of two different
 * things, and they are kept apart because only one of them is still waiting:
 *
 *   - **Pending** — the producer marked the request as an in-flight snapshot
 *     (`RequestOccurrence.pending`, counted per group as `pendingCount`): it
 *     had started and had not settled when the capture ended. It is drawn as
 *     the textual "Pending" badge of {@link PENDING_TONE} and
 *     {@link PENDING_VARIANT}, at group and occurrence level alike.
 *   - **Settled without a code** — a network error, an abort or a refused
 *     cross-origin response. It is drawn as the unavailable label at group
 *     level and as its span status at occurrence level, and is never read as
 *     pending: only the producer's flag makes a request pending.
 */
type StatusClass = 'ok' | 'redirect' | 'client-error' | 'server-error' | 'unknown';

/** Lowest status code of each class, and the ceiling of the last one. */
const STATUS_CLASS_FLOORS = Object.freeze({
  ok: 200,
  redirect: 300,
  clientError: 400,
  serverError: 500,
  ceiling: 600,
});

/**
 * Badge tone per status class.
 *
 * Four classes rather than three: the committed `.dg-request-table__status--*`
 * rules in `../styles/components.css` distinguish a client error from a server
 * error, and the design system's own stylesheet is the authority on the tone a
 * status badge carries (AAP 0.6.4). A code outside every class — which the
 * producer would have to have reported as a non-integer or out-of-range value —
 * is neutral, exactly as an absent code is.
 */
const STATUS_CLASS_TONES: Readonly<Record<StatusClass, BadgeTone>> = {
  ok: 'success',
  redirect: 'info',
  'client-error': 'warning',
  'server-error': 'danger',
  unknown: 'neutral',
};

/**
 * The stylesheet's modifier class per status class, spelled out so every class
 * name this component can emit is greppable in this file.
 *
 * `unknown` has no modifier: the stylesheet defines none for it, and the base
 * chip class plus the neutral tone is the correct rendering. The pending state
 * is not a status class and has no modifier either, for the same reason: see
 * {@link PENDING_TONE}.
 */
const STATUS_CLASS_MODIFIERS: Readonly<Record<StatusClass, string | undefined>> = {
  ok: 'dg-request-table__status--ok',
  redirect: 'dg-request-table__status--redirect',
  'client-error': 'dg-request-table__status--client-error',
  'server-error': 'dg-request-table__status--server-error',
  unknown: undefined,
};

/**
 * Badge tone per span status, for a **settled** occurrence that reported no
 * status code. A pending occurrence also reports span status `unset`, but it is
 * drawn as the Pending badge instead, so `unset` here always means a request
 * that settled without the producer observing a code.
 */
const SPAN_STATUS_TONES: Readonly<Record<TelemetryStatus, BadgeTone>> = {
  unset: 'neutral',
  ok: 'success',
  error: 'danger',
};

/**
 * The tone of the Pending badge: informational, because an in-flight request
 * is neither a success nor a failure — the capture simply ended first.
 *
 * Tone, fill, the hourglass icon and the visible word are the whole modifier.
 * No `dg-request-table__status--pending` class exists or is emitted: the
 * `Badge`'s own `dg-badge--info` and `dg-badge--outline` classes are backed by
 * the design tokens already, and a class of this file's own would need a rule
 * in `../styles/components.css` that nothing else requires.
 */
const PENDING_TONE: BadgeTone = 'info';

/** The fill of the Pending badge; see {@link PENDING_TONE}. */
const PENDING_VARIANT: BadgeVariant = 'outline';

/**
 * The label of each ordering the query contract offers, in the vocabulary's own
 * order.
 *
 * Generic wording: a panel's rows are whatever the capture held, so no label
 * here may name a column that only some data has.
 */
const SORT_LABELS: Readonly<Record<DataQuerySort, string>> = {
  count_desc: 'Most occurrences first',
  duration_desc: 'Longest duration first',
  start_asc: 'Earliest first',
};

/**
 * The ordering options of the toolbar's select, derived from the vocabulary so
 * the control offers exactly the orderings the contract can resolve.
 *
 * Typed as the toolbar's own option list (`ToolbarSelect['options']`) rather
 * than by naming the option type again: the shape belongs to the control, and
 * borrowing it keeps this file from carrying a second spelling of it.
 */
const SORT_OPTIONS: ToolbarSelect['options'] = DATA_QUERY_SORTS.map((sort) => ({
  value: sort,
  label: SORT_LABELS[sort],
}));

/*
 * ---------------------------------------------------------------------------
 * Column identities
 *
 * Only the occurrence-count column maps to an ordering the contract can
 * express, so it is the only sortable header; see `TABLE_SORTS` below.
 * ---------------------------------------------------------------------------
 */

const COLUMN_KEY_REQUEST = 'request';
const COLUMN_KEY_STATUS = 'status';
const COLUMN_KEY_COUNT = 'count';
const COLUMN_KEY_DUPLICATES = 'duplicates';
const COLUMN_KEY_AVERAGE = 'averageDuration';
const COLUMN_KEY_SLOWEST = 'maxDuration';
const COLUMN_KEY_TOTAL = 'totalDuration';
const COLUMN_KEY_TRANSFERRED = 'transferred';
const COLUMN_KEY_INITIATORS = 'initiators';

/**
 * Which column, if any, the current ordering belongs to — the value the grid
 * reports as `aria-sort`.
 *
 * `duration_desc` and `start_asc` map to `null` deliberately. A group carries
 * three durations (average, slowest, total) and two timestamps, and the
 * contract does not say which one its duration ordering ranks by; claiming one
 * of them in `aria-sort` would state something this component cannot know. The
 * toolbar's select names the ordering instead, in the contract's own wording.
 */
const TABLE_SORTS: Readonly<Record<DataQuerySort, DataTableSort | null>> = {
  count_desc: { key: COLUMN_KEY_COUNT, direction: 'desc' },
  duration_desc: null,
  start_asc: null,
};

/** The contract ordering a sortable column's header activates. */
const COLUMN_SORTS: Readonly<Record<string, DataQuerySort | undefined>> = {
  [COLUMN_KEY_COUNT]: 'count_desc',
};

/*
 * ---------------------------------------------------------------------------
 * Stable empty values
 *
 * Shared frozen instances, so an absent page, an empty disclosure set or an
 * empty toolbar note keeps a stable identity across renders and cannot
 * invalidate a memo on its own.
 * ---------------------------------------------------------------------------
 */

const EMPTY_GROUPS: readonly RequestGroup[] = Object.freeze([]);
const EMPTY_IDS: readonly string[] = Object.freeze([]);
const EMPTY_STATUSES: readonly ToolbarStatus[] = Object.freeze([]);

/*
 * ---------------------------------------------------------------------------
 * Copy
 *
 * Generic throughout: no route, no URL, no component name and no framework
 * term appears in this file's wording (AAP 0.5.4). Every path, method and
 * caller a reader sees comes from the data.
 * ---------------------------------------------------------------------------
 */

const EMPTY_MESSAGE = 'No network requests were captured for this interaction.';
const EMPTY_TITLE = 'No requests';
const FILTERED_EMPTY_MESSAGE = 'None of the groups loaded so far has a duplicate occurrence.';
const LOADING_LABEL = 'Loading requests…';
const ERROR_TITLE = 'Requests could not be loaded';
const ERROR_MESSAGE =
  'The grouped requests for this panel could not be resolved. The capture is unchanged; retrying resolves the same query again.';
const DUPLICATES_ONLY_LABEL = 'Duplicates only';
const DUPLICATES_ONLY_SCOPE_NOTE =
  'The duplicates filter applies to the groups loaded so far, not to the whole capture.';
const TRANSFER_UNAVAILABLE_NOTE =
  'No transfer size was exposed for this request, so none is shown rather than a misleading zero.';
const ERROR_COUNT_LABEL = 'Occurrences that failed:';
const ALL_STATUS_CODES_LABEL = 'All status codes observed:';
const PENDING_LABEL = 'Pending';
const PENDING_SINGLE_GROUP_NOTE =
  'This request was still in flight when the capture ended. No response had arrived, so it reports no status code, and the durations in this row are the time elapsed until then, so each is a lower bound.';
const PENDING_GROUP_LABEL = 'Still in flight when the capture ended:';
const PENDING_GROUP_NOTE =
  'No response had arrived for these, so they report no status code. The durations in this row include their elapsed time, so each is a lower bound.';
const PENDING_SETTLED_ONLY_NOTE =
  'The status codes and failures shown describe the settled occurrences only.';
const PENDING_OCCURRENCE_NOTE =
  'This request was still in flight when the capture ended, so no response and no status code were observed. The duration shown is the time elapsed until then, a lower bound on how long it took.';
const LOAD_MORE_LABEL = 'Load more';
const LOAD_MORE_BUSY_LABEL = 'Loading…';
const EXPAND_LABEL = 'Show occurrences';
const COLLAPSE_LABEL = 'Hide occurrences';
const NO_OCCURRENCES_NOTE = 'No individual occurrences were returned for this group.';
const SELECT_OCCURRENCE_LABEL = 'Select the occurrence at';
const OCCURRENCES_SHOWN_LABEL = 'Occurrences shown:';
const GROUPS_LOADED_LABEL = 'Groups loaded:';
const DUPLICATES_MATCHED_LABEL = 'Matching the duplicates filter:';
const TOOLBAR_LABEL = 'Request ordering and filters';
const SORT_CONTROL_LABEL = 'Order';

/*
 * ---------------------------------------------------------------------------
 * Pure helpers
 *
 * Every function below is a total function of its arguments: no grouping, no
 * de-duplication, no keyed set over the returned data, and no comparison of one
 * request's URL with another's.
 * ---------------------------------------------------------------------------
 */

/**
 * Classify one response status code.
 *
 * @param code - The status code an occurrence reported.
 * @returns The class whose tone and stylesheet modifier the badge carries.
 */
function classifyStatusCode(code: number): StatusClass {
  if (!Number.isInteger(code)) {
    return 'unknown';
  }

  if (code >= STATUS_CLASS_FLOORS.ok && code < STATUS_CLASS_FLOORS.redirect) {
    return 'ok';
  }

  if (code >= STATUS_CLASS_FLOORS.redirect && code < STATUS_CLASS_FLOORS.clientError) {
    return 'redirect';
  }

  if (code >= STATUS_CLASS_FLOORS.clientError && code < STATUS_CLASS_FLOORS.serverError) {
    return 'client-error';
  }

  if (code >= STATUS_CLASS_FLOORS.serverError && code < STATUS_CLASS_FLOORS.ceiling) {
    return 'server-error';
  }

  return 'unknown';
}

/**
 * The cluster with the most occurrences, or `undefined` for a group with none.
 *
 * A selection, not an aggregation: the windows were computed upstream and are
 * rendered as received. Written as a loop rather than `reduce` so the empty
 * case is explicit under `noUncheckedIndexedAccess` instead of relying on
 * `reduce`'s runtime throw.
 *
 * @param windows - The group's duplicate windows, in time order.
 * @returns The largest window, with the earliest winning a tie.
 */
function largestDuplicateWindow(windows: readonly DuplicateWindow[]): DuplicateWindow | undefined {
  let largest: DuplicateWindow | undefined;

  for (const window of windows) {
    if (largest === undefined || window.count > largest.count) {
      largest = window;
    }
  }

  return largest;
}

/**
 * Describe a group's duplicate evidence for the badge's tooltip, entirely from
 * the group's own numbers.
 *
 * No window length is assumed and no default is named: the span shown is the
 * measured distance between the first and last issuance inside the largest
 * cluster, which is what makes the sentence a statement about this capture
 * rather than about the detector's configuration.
 *
 * @param group - The group whose duplicates are being described.
 * @returns One or more sentences, safe to show as plain text.
 */
function describeDuplicates(group: RequestGroup): string {
  const sentences: string[] = [
    `Redundant occurrences: ${formatCount(group.duplicateCount)} of ${formatCount(group.count)}.`,
    `Clusters: ${formatCount(group.duplicateWindows.length)}.`,
  ];

  const largest = largestDuplicateWindow(group.duplicateWindows);

  if (largest !== undefined) {
    sentences.push(
      `Largest cluster: ${formatCount(largest.count)} occurrences within ${formatDuration(
        largest.endTime - largest.startTime,
      )}.`,
    );
  }

  return sentences.join(' ');
}

/**
 * How many of a group's occurrences were still in flight when the capture
 * ended, as a count safe to print and compare.
 *
 * `pendingCount` is present only when at least one occurrence was pending, so
 * its absence reads as zero. A value that is not a positive integer cannot come
 * from the aggregate and is also read as zero rather than printed: a row says a
 * request is pending only when the producer's own count says so, never because
 * a status code happens to be missing.
 *
 * @param group - The group whose pending occurrences are counted.
 * @returns The pending count, or `0` when none was reported.
 */
function pendingCountOf(group: RequestGroup): number {
  const { pendingCount } = group;

  return pendingCount !== undefined && Number.isInteger(pendingCount) && pendingCount > 0
    ? pendingCount
    : 0;
}

/**
 * Describe a group's pending occurrences for the Pending badge's tooltip,
 * entirely from the group's own numbers.
 *
 * Three facts, each of which the contract fixes: how many occurrences had not
 * settled, that they therefore carry no status code, and that the row's
 * durations include their elapsed time and are lower bounds. When the row also
 * shows codes or a failure count, a last sentence says those describe the
 * settled occurrences only.
 *
 * @param group - The group whose pending occurrences are described.
 * @param pendingCount - Its {@link pendingCountOf}, already computed and above zero.
 * @returns One or more sentences, safe to show as plain text.
 */
function describePending(group: RequestGroup, pendingCount: number): string {
  const sentences: string[] =
    group.count > 1
      ? [
          `${PENDING_GROUP_LABEL} ${formatCount(pendingCount)} of ${formatCount(group.count)} occurrences.`,
          PENDING_GROUP_NOTE,
        ]
      : [PENDING_SINGLE_GROUP_NOTE];

  if (group.statusCodes.length > 0 || group.errorCount > 0) {
    sentences.push(PENDING_SETTLED_ONLY_NOTE);
  }

  return sentences.join(' ');
}

/**
 * The source location observed for one of a group's own initiator labels.
 *
 * A presentational lookup inside a single group, and explicitly **not** a
 * grouping pass: the group's membership, its ordering and its counts were all
 * decided upstream and are untouched here. The label set is already distinct
 * and sorted when it arrives, so nothing de-duplicates it either; this only
 * answers "did any occurrence attributed to this caller resolve to a place in
 * the project?", which is what turns the caller column into a link.
 *
 * Returns `undefined` when no occurrence for that label carried a location —
 * including when the occurrence list was truncated below the one that did — and
 * the caller then renders the label as plain text rather than a dead link.
 *
 * @param group - The group whose occurrences are searched.
 * @param initiator - One entry of that group's `initiators`.
 * @returns The first location found for the label, or `undefined`.
 */
function locationForInitiator(group: RequestGroup, initiator: string): SourceLocation | undefined {
  for (const occurrence of group.occurrences) {
    if (occurrence.initiator === initiator && occurrence.source !== undefined) {
      return occurrence.source;
    }
  }

  return undefined;
}

/**
 * Clamp an authored `limit` into the range the paging contract accepts.
 *
 * An omitted limit stays omitted: the query is replayed as it was authored and
 * the side that resolves it applies the contract's default, which is the only
 * way the page size the service uses and the page size a panel asked for stay
 * the same number. A non-finite value cannot survive the schema, and is also
 * treated as omitted rather than forwarded as arithmetic that would reach the
 * wire.
 *
 * @param limit - The node's authored limit, if any.
 * @returns A limit within `[1, DATA_QUERY_MAX_LIMIT]`, or `undefined`.
 */
function clampAuthoredLimit(limit: number | undefined): number | undefined {
  if (limit === undefined || !Number.isFinite(limit)) {
    return undefined;
  }

  return Math.min(Math.max(Math.trunc(limit), MIN_QUERY_LIMIT), DATA_QUERY_MAX_LIMIT);
}

/*
 * ---------------------------------------------------------------------------
 * Cell renderers
 *
 * Module-level and pure: each takes a group (and, for an occurrence, its
 * handler) and returns nodes built from library primitives. They are outside
 * the component because they close over nothing, which keeps the column memo
 * below dependent only on the state that actually changes a cell.
 * ---------------------------------------------------------------------------
 */

/**
 * The tab index every tooltip-only trigger in this file carries.
 *
 * A `Tooltip` opens on keyboard focus, and a badge, a text run or an inline
 * code element cannot receive focus by itself — so without this a keyboard
 * reader could never reach the full URL, the complete status list, the failure
 * and duplicate explanations, the grouping note, the unavailable-size reason or
 * what "Pending" means (AAP 0.6.2). The stop is a plain tab stop and nothing
 * more: no `role="button"` and no click handler, because nothing happens on
 * activation, and no `aria-label`, because the visible text is the name and the
 * tooltip merges its bubble into the trigger's `aria-describedby`. The focus
 * indicator is the global `:focus-visible` ring from `../styles/base.css`.
 *
 * These stops sit inside `DataTable` rows. The grid's roving focus reads the row
 * index off the focused element itself, so focus on a descendant is never taken
 * for a row, arrow keys pressed there are not consumed, and Escape reaches the
 * tooltip first.
 */
const TOOLTIP_TRIGGER_TAB_INDEX = 0;

/**
 * The Pending badge, shared by the group row and the occurrence row so the two
 * levels cannot drift apart.
 *
 * The state is carried by the visible word — never by colour or the icon
 * alone — on the base status chip with {@link PENDING_TONE} and
 * {@link PENDING_VARIANT}; the icon is decorative (`Badge` hides its icon slot
 * from assistive technology). The tooltip says what "pending" means for the
 * figures beside it.
 *
 * @param label - The visible text: the word "Pending", with a count when useful.
 * @param note - The tooltip's explanation, safe to show as plain text.
 * @returns The badge in its tooltip.
 */
function renderPendingBadge(label: string, note: string): ReactNode {
  return (
    <Tooltip content={note}>
      <Badge
        tone={PENDING_TONE}
        variant={PENDING_VARIANT}
        className="dg-request-table__status"
        icon={<Hourglass className="dg-icon" />}
        tabIndex={TOOLTIP_TRIGGER_TAB_INDEX}
      >
        {label}
      </Badge>
    </Tooltip>
  );
}

/**
 * The status cell: one badge per distinct code the group observed, with the
 * remainder summarised, a Pending badge when any occurrence was still in
 * flight, and a failure count when any occurrence failed.
 *
 * The codes arrive distinct and ascending; nothing here re-derives them. An
 * absent code list is rendered as the unavailable label on a neutral badge,
 * never as a zero or a blank cell — except when every occurrence is pending,
 * where the Pending badge alone explains the missing codes and the unavailable
 * label beside it would claim a settled occurrence that reported none. When
 * only some occurrences are pending and no settled one reported a code either,
 * both badges are shown, because both things were observed.
 *
 * The Pending badge shows the pending count when the group holds more than one
 * occurrence, so "Pending 2" on a row of five reads without the tooltip.
 *
 * @param group - The group whose statuses are shown.
 * @returns The cell's content.
 */
function renderStatusCell(group: RequestGroup): ReactNode {
  const shown = group.statusCodes.slice(0, MAX_STATUS_BADGES);
  const overflow = group.statusCodes.length - shown.length;
  const pendingCount = pendingCountOf(group);
  const everyOccurrencePending = pendingCount > 0 && pendingCount >= group.count;

  let codeBadges: ReactNode;

  if (group.statusCodes.length > 0) {
    codeBadges = shown.map((code) => {
      const statusClass = classifyStatusCode(code);

      return (
        <Badge
          key={code}
          tone={STATUS_CLASS_TONES[statusClass]}
          variant="outline"
          className={clsx('dg-request-table__status', STATUS_CLASS_MODIFIERS[statusClass])}
        >
          {String(code)}
        </Badge>
      );
    });
  } else if (everyOccurrencePending) {
    codeBadges = null;
  } else {
    codeBadges = (
      <Badge tone="neutral" variant="outline" className="dg-request-table__status">
        {NOT_AVAILABLE_LABEL}
      </Badge>
    );
  }

  return (
    <Stack direction="horizontal" gap={1} align="center" wrap>
      {codeBadges}
      {overflow > 0 ? (
        <Tooltip
          content={`${ALL_STATUS_CODES_LABEL} ${group.statusCodes
            .map((code) => String(code))
            .join(', ')}.`}
        >
          <Badge
            tone="neutral"
            variant="soft"
            className="dg-request-table__status"
            tabIndex={TOOLTIP_TRIGGER_TAB_INDEX}
          >
            {`+${formatCount(overflow)}`}
          </Badge>
        </Tooltip>
      ) : null}
      {pendingCount > 0
        ? renderPendingBadge(
            group.count > 1 ? `${PENDING_LABEL} ${formatCount(pendingCount)}` : PENDING_LABEL,
            describePending(group, pendingCount),
          )
        : null}
      {group.errorCount > 0 ? (
        <Tooltip
          content={`${ERROR_COUNT_LABEL} ${formatCount(group.errorCount)} of ${formatCount(
            group.count,
          )}.`}
        >
          <Badge tone="danger" variant="soft" tabIndex={TOOLTIP_TRIGGER_TAB_INDEX}>
            {formatCount(group.errorCount)}
          </Badge>
        </Tooltip>
      ) : null}
    </Stack>
  );
}

/**
 * The duplicates cell: the badged redundant count when the group has
 * duplicates, and the plain count when it does not.
 *
 * Both numbers come from the group as received. The badge's tooltip describes
 * the clusters the detector found, in that capture's own measurements.
 *
 * @param group - The group whose duplicate evidence is shown.
 * @returns The cell's content.
 */
function renderDuplicatesCell(group: RequestGroup): ReactNode {
  return (
    <Stack
      direction="horizontal"
      gap={1}
      align="center"
      justify="end"
      className="dg-request-table__duplicates"
    >
      {group.hasDuplicates ? (
        <Tooltip content={describeDuplicates(group)}>
          <Badge
            tone="warning"
            variant="outline"
            className="dg-request-table__duplicate-badge"
            icon={<Copy className="dg-icon" />}
            tabIndex={TOOLTIP_TRIGGER_TAB_INDEX}
          >
            {formatCount(group.duplicateCount)}
          </Badge>
        </Tooltip>
      ) : (
        <Text size="sm" tone="muted" numeric>
          {formatCount(group.duplicateCount)}
        </Text>
      )}
    </Stack>
  );
}

/**
 * The transferred-bytes cell.
 *
 * A same-origin response is the only kind whose size the browser exposes
 * (AAP 0.6.6 records the gap), so an absent figure is the ordinary case and is
 * shown as the unavailable label with the reason in a tooltip — never as `0`,
 * which would read as a response that carried nothing.
 *
 * @param group - The group whose transfer size is shown.
 * @returns The cell's content.
 */
function renderTransferredCell(group: RequestGroup): ReactNode {
  return group.transferredBytes === undefined ? (
    <Tooltip content={TRANSFER_UNAVAILABLE_NOTE}>
      <Text size="sm" tone="muted" tabIndex={TOOLTIP_TRIGGER_TAB_INDEX}>
        {NOT_AVAILABLE_LABEL}
      </Text>
    </Tooltip>
  ) : (
    <Text size="sm" numeric>
      {formatBytes(group.transferredBytes)}
    </Text>
  );
}

/**
 * The initiators cell: every distinct caller the group recorded, linked to
 * source wherever one of that caller's occurrences resolved to a location.
 *
 * This is the column that makes the third demonstrated question legible — a
 * duplicate group with *two* callers is a different finding from one caller
 * firing twice — so the labels are never collapsed to the first entry, and a
 * label that has a location is always a link.
 *
 * @param group - The group whose callers are shown.
 * @returns The cell's content.
 */
function renderInitiatorsCell(group: RequestGroup): ReactNode {
  return (
    <Stack
      direction="horizontal"
      gap={1}
      align="center"
      wrap
      className="dg-request-table__initiators"
    >
      {group.initiators.length === 0 ? (
        <Text size="sm" tone="muted">
          {NOT_AVAILABLE_LABEL}
        </Text>
      ) : (
        group.initiators.map((initiator) => {
          const location = locationForInitiator(group, initiator);
          const label = oneLinePreview(initiator);

          return location === undefined ? (
            <Code key={initiator} size="sm" className="dg-request-table__initiator">
              {label}
            </Code>
          ) : (
            <SourceLink
              key={initiator}
              location={location}
              label={label}
              className="dg-request-table__initiator"
            />
          );
        })
      )}
    </Stack>
  );
}

/**
 * One occurrence of a group, inside the expanded detail row.
 *
 * The time shown is the occurrence's start relative to the group's first
 * issuance, which is what makes a cluster readable as a cluster; the absolute
 * epoch value it is derived from is on the datum and is never reformatted into
 * a clock reading here. The occurrence's own `SourceLocation` is passed to the
 * source chip **by reference and unmodified** — no path rewriting and no line
 * arithmetic — because that object is what the click-to-source chain forwards.
 *
 * When no host is available to receive a selection the time renders as text
 * rather than as a control that would do nothing.
 *
 * The status slot has three forms. An occurrence the producer flagged as
 * pending shows the Pending badge — the flag is the producer's explicit
 * statement that no response had arrived, so it wins over every other field —
 * and its duration is the elapsed time until the capture ended, which the
 * badge's tooltip says. A settled occurrence with a code shows the code; one
 * without a code keeps its span status (`Unreported`, `OK` or `Error`), which is
 * never presented as pending.
 *
 * @param group - The group the occurrence belongs to, for its time origin.
 * @param occurrence - The occurrence to render.
 * @param onSelect - Selection handler, or `undefined` for the inert form.
 * @returns One occurrence row.
 */
function renderOccurrence(
  group: RequestGroup,
  occurrence: RequestOccurrence,
  onSelect: ((occurrence: RequestOccurrence) => void) | undefined,
): ReactNode {
  const offsetText = formatOffset(occurrence.startTime, group.firstStartTime);
  const statusClass =
    occurrence.statusCode === undefined ? undefined : classifyStatusCode(occurrence.statusCode);

  let statusBadge: ReactNode;

  if (occurrence.pending === true) {
    statusBadge = renderPendingBadge(PENDING_LABEL, PENDING_OCCURRENCE_NOTE);
  } else if (statusClass === undefined || occurrence.statusCode === undefined) {
    statusBadge = (
      <Badge tone={SPAN_STATUS_TONES[occurrence.status]} variant="soft">
        {formatStatusLabel(occurrence.status)}
      </Badge>
    );
  } else {
    statusBadge = (
      <Badge
        tone={STATUS_CLASS_TONES[statusClass]}
        variant="outline"
        className={clsx('dg-request-table__status', STATUS_CLASS_MODIFIERS[statusClass])}
      >
        {String(occurrence.statusCode)}
      </Badge>
    );
  }

  return (
    <Stack
      key={occurrence.id}
      direction="horizontal"
      gap={2}
      align="center"
      wrap
      className="dg-request-table__occurrence-row"
    >
      {onSelect === undefined ? (
        <Code size="sm" numeric>
          {offsetText}
        </Code>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${SELECT_OCCURRENCE_LABEL} ${offsetText}`}
          onClick={() => {
            onSelect(occurrence);
          }}
        >
          {offsetText}
        </Button>
      )}
      <DurationCell ms={occurrence.durationMs} severity="auto" size="sm" />
      {statusBadge}
      {occurrence.initiator === undefined ? null : (
        <Code size="sm">{oneLinePreview(occurrence.initiator)}</Code>
      )}
      {occurrence.source === undefined ? null : (
        <SourceLink location={occurrence.source} compact className="dg-request-table__initiator" />
      )}
    </Stack>
  );
}

/*
 * ---------------------------------------------------------------------------
 * Local view state
 * ---------------------------------------------------------------------------
 */

/**
 * Everything this view owns, held as one value so the page it renders, the
 * offset it asked for and the rows it carried forward can never disagree.
 *
 * Four of the five members change what is requested or what is shown, and the
 * fifth — `identity` — is what makes a stale set detectable: a node whose query
 * changed under the same node id gets a fresh view rather than an offset into a
 * result that no longer exists.
 */
interface RequestTableView {
  /** The identity of the node query this state belongs to. */
  readonly identity: string;

  /** The ordering currently requested, in the contract's vocabulary. */
  readonly sort: DataQuerySort;

  /** The offset currently requested. */
  readonly offset: number;

  /**
   * The pages already received, in the order the service returned them.
   *
   * Appended to only by an explicit "load more": the hook resolves one page and
   * replaces it, so carrying the earlier pages is the view's own decision and
   * happens exactly when the developer asks for more. Nothing is re-ordered
   * while carrying — the service's ordering is stable and its paging is
   * consistent, so page *n + 1* continues page *n*.
   */
  readonly carried: readonly RequestGroup[];

  /** The ids of the expanded groups. */
  readonly expanded: readonly string[];

  /** Whether the local duplicates-only filter is engaged. */
  readonly duplicatesOnly: boolean;
}

/**
 * The identity of a node's query: its id plus every field of the query that
 * decides what a page contains.
 *
 * Compared by value rather than by object identity, because a host that
 * re-creates the spec object each render would otherwise reset the view on
 * every render, and a host that mutates a stored spec in place would never
 * reset it.
 *
 * @param node - The node being rendered.
 * @returns A string that is equal for equal node queries.
 */
function viewIdentityOf(node: RequestTableNode): string {
  const { source, filter, sort, limit, offset } = node.query;

  return JSON.stringify({
    id: node.id,
    source,
    filter: filter ?? null,
    sort: sort ?? null,
    limit: limit ?? null,
    offset: offset ?? null,
  });
}

/**
 * The view state a node opens with: the authored ordering and offset, nothing
 * carried, nothing expanded and no filter.
 *
 * @param node - The node being rendered.
 * @param identity - Its {@link viewIdentityOf}, already computed by the caller.
 * @returns The initial state for that node.
 */
function initialView(node: RequestTableNode, identity: string): RequestTableView {
  return {
    identity,
    sort: node.query.sort ?? DEFAULT_SORT,
    offset: node.query.offset ?? DATA_QUERY_DEFAULT_OFFSET,
    carried: EMPTY_GROUPS,
    expanded: EMPTY_IDS,
    duplicatesOnly: false,
  };
}

/*
 * ---------------------------------------------------------------------------
 * The component
 * ---------------------------------------------------------------------------
 */

/**
 * Props of {@link RequestTable}.
 *
 * Two members, and no data prop: a query-backed view is configured by its node
 * and fed by the ambient provider, so handing it rows would let a caller draw
 * something the capture never said (AAP 0.6.2).
 */
export interface RequestTableProps {
  /**
   * The validated `requestTable` node to render.
   *
   * Its `query` is the request, and its `id` is the identity reported to
   * {@link PanelActions} for every disclosure and filter change, so a host with
   * several request tables in one panel can tell them apart.
   */
  node: RequestTableNode;

  /** Extra class names, composed after this component's own. */
  className?: string | undefined;
}

/**
 * Render the `requestTable` node: grouped network calls with their duplicate
 * evidence, their callers and their occurrences.
 *
 * Three states, in the precedence the library fixes: a first page that has not
 * settled renders the loading skeleton; a failure renders the error state with
 * the serialised query and a working retry, and never rows beneath a banner; a
 * settled page with no groups renders the empty state. A later page that is
 * still resolving keeps the groups already received on screen and disables the
 * paging control, which is neither a stale page nor an invented one — those
 * rows were received, and the footer says how many of the source they cover.
 *
 * @param props - See {@link RequestTableProps}.
 * @returns The node's rendering.
 */
export function RequestTable(props: RequestTableProps): ReactElement {
  const { node, className } = props;

  const actions = usePanelActions();

  // Hoisted out of the callbacks below so their dependency lists name the one
  // member each of them uses, rather than the whole host object.
  const selectEvent = actions?.onSelectEvent;
  const reportExpand = actions?.onExpand;
  const reportFilter = actions?.onFilterChange;

  const identity = useMemo(() => viewIdentityOf(node), [node]);
  const [view, setView] = useState<RequestTableView>(() => initialView(node, identity));

  // Adjusting state during render, the documented pattern for a component whose
  // local state describes a prop that changed. The reset value is used by THIS
  // render as well as being written back, so no render draws the previous
  // query's offset, disclosure set or filter.
  const active = view.identity === identity ? view : initialView(node, identity);

  if (view.identity !== identity) {
    setView(active);
  }

  const baseOffset = node.query.offset ?? DATA_QUERY_DEFAULT_OFFSET;
  const limit = clampAuthoredLimit(node.query.limit);
  const { filter } = node.query;

  // Rebuilt on every render deliberately: `useQuery` keys on the query's
  // contents, so an object with the same fields resolves nothing again, and the
  // fields that do change — the ordering and the offset the developer chose —
  // are exactly the changes that should re-query.
  const query: DataQuery & { source: typeof REQUESTS_SOURCE } = {
    source: REQUESTS_SOURCE,
    ...(filter === undefined ? {} : { filter }),
    sort: active.sort,
    ...(limit === undefined ? {} : { limit }),
    offset: active.offset,
  };

  const { status, data, error, total, nextOffset, retry } = useQuery(query);

  const page = data ?? EMPTY_GROUPS;

  // The pages received so far, in service order. Concatenation only — no
  // sorting, no merging by any key, and no de-duplication: a group's identity
  // and its membership were decided by the aggregate that produced it.
  const loaded = useMemo(
    () => (active.carried.length === 0 ? page : [...active.carried, ...page]),
    [active.carried, page],
  );

  // The one local narrowing, and the reason the footer states its scope: the
  // query contract cannot express "duplicates only", so this predicate runs
  // over the groups loaded so far and nothing else. It reads `hasDuplicates`
  // as received; it never compares two rows.
  const rows = useMemo(
    () => (active.duplicatesOnly ? loaded.filter((group) => group.hasDuplicates) : loaded),
    [active.duplicatesOnly, loaded],
  );

  const applySort = useCallback(
    (sort: DataQuerySort): void => {
      // A new ordering is a new result: the carried pages and the disclosure
      // set describe positions in the old one, so both are dropped and paging
      // restarts at the authored offset.
      setView((current) => ({
        ...current,
        sort,
        offset: baseOffset,
        carried: EMPTY_GROUPS,
        expanded: EMPTY_IDS,
      }));
      reportFilter?.(node.id, { sort, duplicatesOnly: String(active.duplicatesOnly) });
    },
    [active.duplicatesOnly, baseOffset, node.id, reportFilter],
  );

  const handleSortSelect = useCallback(
    (next: string): void => {
      // The control's values come from the contract's own vocabulary, so this
      // narrowing always succeeds; it is here because the select speaks strings
      // and the query speaks the vocabulary.
      if (isDataQuerySort(next)) {
        applySort(next);
      }
    },
    [applySort],
  );

  const handleTableSortChange = useCallback(
    (next: DataTableSort): void => {
      const mapped = COLUMN_SORTS[next.key];

      // Only a column that maps to an ordering the contract can express asks
      // for one. The contract has a single direction per ordering, so
      // re-activating the active column's header requests the same ordering
      // rather than an inverse the service could not resolve.
      if (mapped !== undefined) {
        applySort(mapped);
      }
    },
    [applySort],
  );

  const handleDuplicatesToggle = useCallback((): void => {
    const duplicatesOnly = !active.duplicatesOnly;

    setView({ ...active, duplicatesOnly });
    reportFilter?.(node.id, { sort: active.sort, duplicatesOnly: String(duplicatesOnly) });
  }, [active, node.id, reportFilter]);

  const handleLoadMore = useCallback((): void => {
    // Only the offset the service reported is ever requested; an offset derived
    // from the number of rows on screen would drift the moment a limit was
    // clamped (AAP 0.4.2).
    if (nextOffset === undefined) {
      return;
    }

    setView({ ...active, carried: loaded, offset: nextOffset });
  }, [active, loaded, nextOffset]);

  const handleRowToggle = useCallback(
    (group: RequestGroup): void => {
      const wasExpanded = active.expanded.includes(group.id);
      const expanded = wasExpanded
        ? active.expanded.filter((id) => id !== group.id)
        : [...active.expanded, group.id];

      setView({ ...active, expanded });

      // The state AFTER the gesture, as the interface specifies, so a host can
      // persist disclosure without tracking a parity.
      reportExpand?.(node.id, group.id, !wasExpanded);
    },
    [active, node.id, reportExpand],
  );

  const handleOccurrenceSelect = useCallback(
    (occurrence: RequestOccurrence): void => {
      // An occurrence is one captured event, so it can name one. The aggregate
      // row above it is not, and never fabricates a coordinate to stand in.
      selectEvent?.({
        eventId: occurrence.eventId,
        spanId: occurrence.spanId,
        traceId: occurrence.traceId,
      });
    },
    [selectEvent],
  );

  const columns = useMemo<readonly DataTableColumn<RequestGroup>[]>(
    () => [
      {
        key: COLUMN_KEY_REQUEST,
        header: 'Request',
        // The identity column: a reader hears the row named by its method and
        // path as they move across it.
        rowHeader: true,
        cell: (group) => {
          const expanded = active.expanded.includes(group.id);
          // Display only. The URL arrives redacted — query values replaced per
          // key, path retained — and is shown as it arrived, shortened for the
          // row with the full redacted value in the tooltip. Nothing here
          // parses, rewrites or reconstructs it.
          const displayUrl = oneLinePreview(group.url);
          // The URL is a tooltip trigger only when the row shortened it; a URL
          // shown in full has nothing more to disclose, so it stays out of the
          // tab order rather than adding a stop that opens nothing.
          const urlAbbreviated = displayUrl !== group.url;

          return (
            <Stack
              direction="horizontal"
              gap={2}
              align="center"
              className={clsx(
                'dg-request-table__group-row',
                group.hasDuplicates && 'dg-is-duplicate',
                expanded && 'dg-is-expanded',
              )}
            >
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={
                  expanded ? (
                    <ChevronDown className="dg-icon" />
                  ) : (
                    <ChevronRight className="dg-icon" />
                  )
                }
                aria-label={`${expanded ? COLLAPSE_LABEL : EXPAND_LABEL}: ${group.method} ${group.path}`}
                onClick={() => {
                  handleRowToggle(group);
                }}
              />
              <Badge tone="neutral" variant="outline" className="dg-request-table__method">
                {group.method}
              </Badge>
              <Tooltip content={group.url} disabled={!urlAbbreviated}>
                <Code
                  className="dg-request-table__url"
                  tabIndex={urlAbbreviated ? TOOLTIP_TRIGGER_TAB_INDEX : undefined}
                >
                  {displayUrl}
                </Code>
              </Tooltip>
              <Tooltip content={GROUPING_NOTES[group.groupedBy]}>
                <Badge
                  tone={GROUPING_TONES[group.groupedBy]}
                  variant="soft"
                  tabIndex={TOOLTIP_TRIGGER_TAB_INDEX}
                >
                  {humanizeLabel(group.groupedBy)}
                </Badge>
              </Tooltip>
            </Stack>
          );
        },
      },
      {
        key: COLUMN_KEY_STATUS,
        header: 'Status',
        cell: (group) => renderStatusCell(group),
      },
      {
        key: COLUMN_KEY_COUNT,
        header: 'Occurrences',
        align: 'end',
        // The one column whose ordering the contract can express.
        sortable: true,
        defaultSortDirection: 'desc',
        cell: (group) => (
          <Text size="sm" numeric>
            {formatCount(group.count)}
          </Text>
        ),
      },
      {
        key: COLUMN_KEY_DUPLICATES,
        header: 'Duplicates',
        align: 'end',
        cell: (group) => renderDuplicatesCell(group),
      },
      {
        key: COLUMN_KEY_AVERAGE,
        header: 'Average',
        align: 'end',
        cell: (group) => <DurationCell ms={group.averageDurationMs} severity="auto" size="sm" />,
      },
      {
        key: COLUMN_KEY_SLOWEST,
        header: 'Slowest',
        align: 'end',
        cell: (group) => <DurationCell ms={group.maxDurationMs} severity="auto" size="sm" />,
      },
      {
        key: COLUMN_KEY_TOTAL,
        header: 'Total',
        align: 'end',
        cell: (group) => <DurationCell ms={group.totalDurationMs} severity="auto" size="sm" />,
      },
      {
        key: COLUMN_KEY_TRANSFERRED,
        header: 'Transferred',
        align: 'end',
        cell: (group) => renderTransferredCell(group),
      },
      {
        key: COLUMN_KEY_INITIATORS,
        header: 'Initiated by',
        cell: (group) => renderInitiatorsCell(group),
      },
    ],
    [active.expanded, handleRowToggle],
  );

  const renderExpandedRow = useCallback(
    (group: RequestGroup): ReactNode => (
      <Stack direction="vertical" gap={1} className="dg-request-table__occurrences">
        {group.occurrencesTruncated ? (
          <Text size="xs" tone="muted">
            {`${OCCURRENCES_SHOWN_LABEL} ${formatCount(group.occurrences.length)} of ${formatCount(
              group.count,
            )}.`}
          </Text>
        ) : null}
        {group.occurrences.length === 0 ? (
          <Text size="xs" tone="muted">
            {NO_OCCURRENCES_NOTE}
          </Text>
        ) : (
          group.occurrences.map((occurrence) =>
            renderOccurrence(
              group,
              occurrence,
              selectEvent === undefined ? undefined : handleOccurrenceSelect,
            ),
          )
        )}
      </Stack>
    ),
    [handleOccurrenceSelect, selectEvent],
  );

  const selects = useMemo<readonly ToolbarSelect[]>(
    () => [
      {
        id: `${node.id}:sort`,
        label: SORT_CONTROL_LABEL,
        labelHidden: true,
        value: active.sort,
        options: SORT_OPTIONS,
        onValueChange: handleSortSelect,
      },
    ],
    [active.sort, handleSortSelect, node.id],
  );

  const toolbarActions = useMemo<readonly ToolbarAction[]>(
    () => [
      {
        id: `${node.id}:duplicates-only`,
        label: DUPLICATES_ONLY_LABEL,
        onSelect: handleDuplicatesToggle,
        icon: <Copy className="dg-icon" />,
        variant: 'ghost',
        pressed: active.duplicatesOnly,
        disabled: loaded.length === 0,
      },
    ],
    [active.duplicatesOnly, handleDuplicatesToggle, loaded.length, node.id],
  );

  // Page-level honesty about grouping: a fallback-grouped row is coarser than a
  // keyed one, so a page that contains any of them says so, and a page that
  // contains both says that instead of implying one grouping throughout. Two
  // membership tests over a flag, and no grouping of anything.
  const groupingStatuses = useMemo<readonly ToolbarStatus[]>(() => {
    if (!rows.some((group) => group.groupedBy === FALLBACK_GROUPING)) {
      return EMPTY_STATUSES;
    }

    const hasKeyed = rows.some((group) => group.groupedBy === KEYED_GROUPING);

    return [
      {
        label: hasKeyed ? MIXED_GROUPING_LABEL : FALLBACK_GROUPING_LABEL,
        tone: 'warning',
        variant: 'outline',
      },
    ];
  }, [rows]);

  // Phrased as labelled counts rather than as sentences about "groups", so the
  // wording is correct for one group and for a thousand, and so the footer
  // never implies the whole source when it is describing the pages in hand.
  const footerNote = useMemo(() => {
    const loadedNote =
      total === undefined
        ? `${GROUPS_LOADED_LABEL} ${formatCount(loaded.length)}.`
        : `${GROUPS_LOADED_LABEL} ${formatCount(loaded.length)} of ${formatCount(total)}.`;

    return active.duplicatesOnly
      ? [
          loadedNote,
          `${DUPLICATES_MATCHED_LABEL} ${formatCount(rows.length)} of ${formatCount(
            loaded.length,
          )}.`,
          DUPLICATES_ONLY_SCOPE_NOTE,
        ].join(' ')
      : loadedNote;
  }, [active.duplicatesOnly, loaded.length, rows.length, total]);

  let body: ReactNode;

  if (status === 'loading' && loaded.length === 0) {
    body = (
      <LoadingState variant="rows" label={LOADING_LABEL} className="dg-request-table__loading" />
    );
  } else if (status === 'error') {
    body = (
      <ErrorState
        title={ERROR_TITLE}
        message={ERROR_MESSAGE}
        {...(error === undefined ? {} : { code: error.code })}
        query={JSON.stringify(query)}
        onRetry={retry}
        className="dg-request-table__error"
      />
    );
  } else if (loaded.length === 0) {
    body = (
      <EmptyState title={EMPTY_TITLE} message={EMPTY_MESSAGE} className="dg-request-table__empty" />
    );
  } else {
    body = (
      <>
        {/* `virtualize` is deliberately omitted: the grid renders a page of
            groups whole and windows a large one on its own policy, and a
            request table's rows vary in height (wrapped caller chips, an
            expanded detail row), which is exactly the case its automatic
            policy is tuned for. */}
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(group) => group.id}
          caption={node.title ?? CATALOG_ENTRY.label}
          compact
          sort={TABLE_SORTS[active.sort]}
          onSortChange={handleTableSortChange}
          expandedRowKeys={active.expanded}
          onRowToggle={handleRowToggle}
          renderExpandedRow={renderExpandedRow}
          // Reached only when groups were loaded and the local filter excluded
          // every one of them, so it says that rather than claiming the capture
          // held no requests.
          empty={<EmptyState message={FILTERED_EMPTY_MESSAGE} />}
        />
        <Stack
          direction="horizontal"
          gap={2}
          align="center"
          justify="between"
          wrap
          className="dg-request-table__footer"
        >
          <Text size="xs" tone="muted">
            {footerNote}
          </Text>
          {nextOffset === undefined ? null : (
            <Button
              variant="secondary"
              size="sm"
              disabled={status === 'loading'}
              onClick={handleLoadMore}
            >
              {status === 'loading' ? LOAD_MORE_BUSY_LABEL : LOAD_MORE_LABEL}
            </Button>
          )}
        </Stack>
      </>
    );
  }

  return (
    <div className={clsx('dg-request-table', className)}>
      <Toolbar
        label={TOOLBAR_LABEL}
        className="dg-request-table__toolbar"
        compact
        wrap
        selects={selects}
        actions={toolbarActions}
        status={groupingStatuses}
      />
      {body}
    </div>
  );
}
