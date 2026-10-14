/**
 * `RequestTable` — the component behind the node catalog's `requestTable` type:
 * network calls grouped so that repeats collide, each group badged with its
 * duplicate evidence and expandable to every occurrence with the code that
 * issued it.
 *
 * This is the body of the product's third demonstrated question — "why are
 * these requests duplicated?" — and the view an end-to-end assertion about a
 * duplicate group reads. Everything it needs to answer that question arrives in
 * the rows: how many times one logical request occurred, how many of those were
 * redundant, how tightly they clustered, and which distinct callers issued them.
 *
 * ## Grouping is upstream, and that is the whole design
 *
 * **Nothing in this file groups, de-duplicates, counts duplicates or compares
 * one URL with another.** The reason is a privacy constraint rather than a
 * division of labour: a URL's query-parameter *values* are replaced per key
 * before anything is stored, broadcast or shown, so two requests that differ
 * only in a parameter arrive here with byte-identical display text. The
 * distinction is preserved instead by a key the service computes from the
 * request *as it was actually made* — an HMAC over the method, the path and the
 * sorted query pairs of the unredacted URL — and the telemetry aggregate groups
 * by that key (`docs/SECURITY.md`, "The pre-redaction request key").
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
 * file, and no transport detail reaches a column.
 *
 * Ordering and paging belong to the side that owns the capture: an ordering
 * the service can apply is a **re-query** in the closed `DataQuerySort`
 * vocabulary, and "load more" advances `offset` to exactly the `nextOffset` the
 * response reported, keeping the pages already received. It is offered only
 * when that offset moves forward from the page it answered, and never for a
 * count-only `limit: 0` query, whose every page is empty by request. An
 * authored `limit: 0` is sent as zero, never raised to one row, so the view
 * states the query's total without drawing a group.
 *
 * The service orders groups in three ways, and each has a home the reader can
 * see: most occurrences first is the Occurrences header, longest total
 * duration first the Duration header (the service ranks that ordering by
 * `totalDurationMs`, the figure the Duration cell states as its total), and
 * earliest first — by a timestamp no column shows — the toolbar's select alone.
 * Every other order (Transferred, and the reverse of Occurrences and Duration)
 * is a **view order**: the groups already loaded are re-arranged here, stably,
 * with the service's own position as the tie-break, exactly as `SpanTable` does for
 * the orders its service cannot apply. Nothing is re-queried, and the page
 * sequence "load more" follows stays in the service's order. The select and
 * the header always name the same order — a view order appears in the select
 * as its own option — and while the loaded groups are not the whole result the
 * footer says the order covers only them. The request and caller columns are
 * never ordered locally: ordering redacted URLs or caller labels against each
 * other would be the very comparison this file refuses to make, and the status
 * column holds a set of codes rather than one value.
 *
 * Three more things are local and are labelled as such wherever they are
 * visible: the disclosure state of a row, the view order above, and the
 * "duplicates only" toggle, which can only filter the groups loaded so far
 * because the query contract cannot express "duplicates only". With no group
 * loaded it is disabled (`disabled` and `aria-disabled`), and a visible note it
 * names as its description says why.
 *
 * ## Selection and focus
 *
 * A group row takes part in the panel's one shared selection. Activating it —
 * a click, or Enter or Space on the row — selects the group's representative
 * occurrence, its canonically earliest issuance, which is one captured event
 * with its own id, trace and span; the row never fabricates a coordinate of its
 * own. The row that holds the panel's selected event, reported from this view
 * or any other, carries `dg-is-selected` and `aria-selected="true"`, and the
 * occurrence itself is marked inside the open detail as before. A group whose
 * occurrence list came back empty has nothing to select, so activating it
 * opens its detail, which says why.
 *
 * Once the reader has chosen an ordering the grid stays mounted through the
 * re-query that follows, with its loading, error or empty state in the grid's
 * empty slot, so the header control they used keeps its element and their
 * focus; the toolbar is kept throughout. A retry that succeeds hands focus to
 * the disclosure toggle of the first group the settled page brought, which
 * carries the error state's successor focus key
 * (`RETRY_SUCCESSOR_FOCUS_ATTRIBUTES`).
 *
 * ## Colour and spacing
 *
 * No colour value and no spacing value is written here. Status and grouping
 * tones resolve through `Badge` tones and the `.dg-request-table__status--*`
 * rules committed in `../styles/components.css`; which tone a response code or
 * a span status takes is the shared decision of `../utils/color.ts`, the one
 * the waterfall and the timeline read too; duration emphasis is
 * `DurationCell`'s `severity="auto"`; every gap comes from `Stack` or
 * `Toolbar`; and there is no inline `style` at all.
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
import { ChevronDown, ChevronRight, CircleSlash, Copy, Hourglass, Globe } from 'lucide-react';
import { useCallback, useId, useMemo, useState } from 'react';
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
} from '@debuggen/telemetry';

import { matchesPanelSelection, usePanelActions, useViewSelection } from '../host/PanelActions';
import type { PanelEventRef, PanelSelection } from '../host/PanelActions';
import { queryFailureProps, useQuery } from '../host/useQuery';
import { Stack } from '../layout/Stack';
import { Toolbar } from '../layout/Toolbar';
import type { ToolbarSelect, ToolbarStatus } from '../layout/Toolbar';
import { Badge } from '../primitives/Badge';
import type { BadgeTone, BadgeVariant } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { Code } from '../primitives/Code';
import { DataTable } from '../primitives/DataTable';
import type {
  DataTableColumn,
  DataTableColumnWidth,
  DataTableSort,
  DataTableSortDirection,
} from '../primitives/DataTable';
import { DurationCell } from '../primitives/DurationCell';
import { EmptyState } from '../primitives/EmptyState';
import {
  ErrorState,
  FOCUS_KEY_ATTRIBUTE,
  RETRY_SUCCESSOR_FOCUS_ATTRIBUTES,
} from '../primitives/ErrorState';
import { LoadingState } from '../primitives/LoadingState';
import { Text } from '../primitives/Text';
import { Tooltip } from '../primitives/Tooltip';
import { HTTP_STATUS_CLASS_TONES, httpStatusClass, statusTone } from '../utils/color';
import type { HttpStatusClass } from '../utils/color';
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
 * `pending` flag and the group's `pendingCount`; the "No status" badge to a
 * settled occurrence's missing `http.status_code`, which the aggregate counts
 * as the group's `noStatusCodeCount`; the occurrence,
 * duplicate and cluster counts to the `request_key` grouping over `startTime`;
 * the duration cell's figures to `duration`; the transfer cell to `transferSize`;
 * the caller chips to `source` and to the caller label the aggregate derives
 * from `initiator`, `initiatorComponent` and `initiatorOwners` (the component
 * that started the request and its owners); and an occurrence's selection to
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

/**
 * The smallest `limit` the paging contract accepts, and the one value of it
 * that asks for a count without rows.
 *
 * Zero is a legitimate request, never "unset": the query schema preserves it
 * exactly and the page echo reports it, so a node that authored it receives the
 * total of its query and no groups. Only an absent `limit` means unset.
 */
const COUNT_ONLY_LIMIT = 0;

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

/*
 * Response status classes
 *
 * The classification of a response code and the tone it reads in are NOT
 * decided here: `../utils/color.ts` owns them (`httpStatusClass`,
 * `HTTP_STATUS_CLASS_TONES`) for every view that prints a code — this table,
 * the waterfall's status chip and the timeline — so one 404 can never read as
 * a warning here and as a failure one view over. What stays here is the one
 * thing only this table has: its stylesheet modifiers.
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
 *   - **Settled without a code** — an abort, a network error, a refused
 *     cross-origin response or an opaque one. It is counted per group as
 *     `noStatusCodeCount` and drawn as the textual "No status" badge at group
 *     level (see {@link renderNoStatusBadge}), so a row whose codes are all
 *     successes and whose failure count is not zero shows, beside both, the
 *     occurrences that explain the difference. At occurrence level it is its
 *     span status. It is never read as pending: only the producer's flag
 *     makes a request pending. Which of these were aborts the table does not
 *     say: the producer's abort marker is not among the catalog's `reads`.
 */

/**
 * The stylesheet's modifier class per status class, spelled out so every class
 * name this component can emit is greppable in this file.
 *
 * Keyed by the shared {@link HttpStatusClass}, so the class a badge is drawn in
 * and the tone `Badge` receives come from the same classification. The four
 * outcome classes have a committed `.dg-request-table__status--*` rule in
 * `../styles/components.css`, which distinguishes a client error from a server
 * error exactly as the shared tone table does. `informational` and `unknown`
 * have no modifier: the stylesheet defines none for them, and the base chip
 * class plus their neutral tone is the correct rendering. The pending state is
 * not a status class and has no modifier either, for the same reason: see
 * {@link PENDING_TONE}.
 */
const STATUS_CLASS_MODIFIERS: Readonly<Record<HttpStatusClass, string | undefined>> = {
  informational: undefined,
  success: 'dg-request-table__status--ok',
  redirect: 'dg-request-table__status--redirect',
  'client-error': 'dg-request-table__status--client-error',
  'server-error': 'dg-request-table__status--server-error',
  unknown: undefined,
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
  duration_desc: 'Longest total duration first',
  start_asc: 'Earliest first',
};

/*
 * ---------------------------------------------------------------------------
 * Column identities, service orders and view orders
 *
 * Three figure columns are sortable. Two of their orders are the service's own
 * — Occurrences most first (`count_desc`) and Duration longest total first
 * (`duration_desc`) — and re-query; every other one is a view order over the
 * groups loaded (see this module's header, "Data, interaction and paging").
 * ---------------------------------------------------------------------------
 */

const COLUMN_KEY_REQUEST = 'request';
const COLUMN_KEY_STATUS = 'status';
const COLUMN_KEY_COUNT = 'count';
const COLUMN_KEY_DURATION = 'duration';
const COLUMN_KEY_TRANSFERRED = 'transferred';
const COLUMN_KEY_INITIATORS = 'initiators';

/**
 * The keys of the sortable columns: every figure column. Each orders by one
 * figure per group — Occurrences by the count its duplicate badge qualifies,
 * Duration by the total its cell states last, Transferred by the size.
 * Declared as a tuple so the key type below is derived from it and a lookup
 * keyed by it must name every sortable column.
 */
const ORDER_COLUMN_KEYS = [COLUMN_KEY_COUNT, COLUMN_KEY_DURATION, COLUMN_KEY_TRANSFERRED] as const;

/** The key of a sortable column. */
type OrderColumnKey = (typeof ORDER_COLUMN_KEYS)[number];

/**
 * One column and one direction: what a header activation asks for and, when
 * the service cannot apply it, the view order the loaded groups are arranged
 * in. Assignable to {@link DataTableSort}, which is how it reaches the header's
 * indicator and `aria-sort`.
 */
interface RequestOrder {
  /** The column the groups are ordered by. */
  readonly key: OrderColumnKey;

  /** The direction that ordering runs in. */
  readonly direction: DataTableSortDirection;
}

/**
 * The visible header of each sortable column, which is also its sort control's
 * accessible name and the first half of its view order's label in the select.
 */
const ORDER_COLUMN_HEADERS: Readonly<Record<OrderColumnKey, string>> = Object.freeze({
  [COLUMN_KEY_COUNT]: 'Occurrences',
  [COLUMN_KEY_DURATION]: 'Duration',
  [COLUMN_KEY_TRANSFERRED]: 'Transferred',
});

/**
 * How each column's two directions read, in the unit its figure is counted in:
 * tallies are most or fewest, durations longest or shortest, sizes largest or
 * smallest.
 */
const ORDER_DIRECTION_PHRASES: Readonly<
  Record<OrderColumnKey, Readonly<Record<DataTableSortDirection, string>>>
> = Object.freeze({
  [COLUMN_KEY_COUNT]: { desc: 'most first', asc: 'fewest first' },
  [COLUMN_KEY_DURATION]: { desc: 'longest total first', asc: 'shortest total first' },
  [COLUMN_KEY_TRANSFERRED]: { desc: 'largest first', asc: 'smallest first' },
});

/**
 * The name each column's order is reported under, as the first half of
 * `<column>_<direction>` — see {@link orderReportOf}.
 */
const ORDER_REPORT_NAMES: Readonly<Record<OrderColumnKey, string>> = Object.freeze({
  [COLUMN_KEY_COUNT]: 'count',
  [COLUMN_KEY_DURATION]: 'total',
  [COLUMN_KEY_TRANSFERRED]: 'transferred',
});

/**
 * The one figure of a group each sortable column shows and orders by.
 *
 * A group with no exposed transfer size reads as `NaN`, which
 * {@link compareFigures} places after every measured size in either direction:
 * the column shows the unavailable label there, and a reversal must not bring
 * the unmeasured groups to the top of a ranking of sizes.
 */
const ORDER_FIGURES: Readonly<Record<OrderColumnKey, (group: RequestGroup) => number>> =
  Object.freeze({
    [COLUMN_KEY_COUNT]: (group) => group.count,
    [COLUMN_KEY_DURATION]: (group) => group.totalDurationMs,
    [COLUMN_KEY_TRANSFERRED]: (group) => group.transferredBytes ?? Number.NaN,
  });

/**
 * Which column and direction each service ordering is shown on — the value the
 * grid reports as `aria-sort` while no view order is applied.
 *
 * `count_desc` ranks by the occurrence count and `duration_desc` by the summed
 * duration of every occurrence (the `requests` chains of the panel-data
 * resolver's `SOURCE_SORT_KEYS`), so each claims the column that shows the
 * figure it ranks by. `start_asc` ranks by the first occurrence's start, which
 * no column shows, so no header claims it and the select names it alone.
 */
const TABLE_SORTS: Readonly<Record<DataQuerySort, RequestOrder | null>> = Object.freeze({
  count_desc: { key: COLUMN_KEY_COUNT, direction: 'desc' },
  duration_desc: { key: COLUMN_KEY_DURATION, direction: 'desc' },
  start_asc: null,
});

/**
 * The value of the select's view-order option: outside the `DataQuerySort`
 * vocabulary by construction, so it can never be mistaken for, or sent as, a
 * service ordering.
 */
const VIEW_ORDER_OPTION_VALUE = 'view-order';

/**
 * The view-order option's label while no view order is applied, when it is
 * shown disabled: it tells the reader that the column headers order the loaded
 * groups, which the three service options cannot.
 */
const VIEW_ORDER_IDLE_LABEL = 'By a column header (loaded groups)';

/** Closes the view-order option's label while one is applied. */
const VIEW_ORDER_SCOPE_SUFFIX = '(loaded groups)';

/**
 * The three service orderings of the toolbar's select, derived from the
 * vocabulary so the control offers exactly the orderings the contract can
 * resolve.
 */
const SERVICE_SORT_OPTIONS = DATA_QUERY_SORTS.map((sort) => ({
  value: sort,
  label: SORT_LABELS[sort],
}));

/**
 * The toolbar select's options while no view order is applied: the three
 * service orderings, then the view-order option, disabled.
 *
 * The view-order option is always present so the set of choices is stable —
 * the `Select` primitive's rule for a choice the current state cannot
 * support — and so the select and the header always name the same order: a
 * header that arranges the loaded groups makes that option the select's value,
 * labelled with the order applied (see {@link sortOptionsFor}).
 *
 * Typed as the toolbar's own option list (`ToolbarSelect['options']`) rather
 * than by naming the option type again: the shape belongs to the control, and
 * borrowing it keeps this file from carrying a second spelling of it.
 */
const IDLE_SORT_OPTIONS: ToolbarSelect['options'] = Object.freeze([
  ...SERVICE_SORT_OPTIONS,
  { value: VIEW_ORDER_OPTION_VALUE, label: VIEW_ORDER_IDLE_LABEL, disabled: true },
]);

/**
 * The width ROLE of every column, handed to `DataTable` as each column's
 * `width`.
 *
 * A role names what a column holds, never how wide it is: `DataTable` resolves
 * each one through `DATA_TABLE_COLUMN_TRACKS` to a grid track built from the
 * `--dg-column-min-*` floor and `--dg-column-share-*` share tokens, so this
 * table agrees with every other table on both extension surfaces about how wide
 * a count or a duration is, and no length is chosen here. Each column takes the
 * smallest role whose floor keeps its content readable, in the vocabulary every
 * table shares:
 *
 *   - `request` is `text`: the identity column holds the disclosure toggle, the
 *     method badge, the grouping chip and a readable run of the URL, which
 *     ellipsizes beyond that with the full value in its tooltip. It takes the
 *     widest floor and the widest share of all the columns;
 *   - `status` is `status`: the code badges, the Pending badge and the failure
 *     count, which wrap onto another line rather than overflow;
 *   - `count` (Occurrences) is `count`: the integer tally with, for a group
 *     that has redundant occurrences, the compact duplicate badge beside it —
 *     the room that role keeps for exactly such a badge;
 *   - `duration` and `transferred` are `quantity`: a formatted measurement with
 *     its unit (`999.99 ms`, `123.456 s`, a byte size). The duration column
 *     states a group's average, slowest and total as one labelled figure per
 *     line, or the one figure a lone occurrence has (see
 *     {@link renderDurationCell});
 *   - `initiators` is `label`, a HOLDING role: the first caller's slot and the
 *     `+N` overflow badge beside it, on one line.
 *
 * Why the callers hold their floor rather than yield like the request. A caller
 * is identified by its leading word — the function or component that issued
 * the request — and the cell spends part of its width on the `+N` badge, which
 * keeps its own width so the count stays whole. A truncating role (`name`)
 * yields down to `--dg-column-yield` of its floor, and in a panel just too
 * narrow for every floor that left the caller a few characters beside the
 * badge (an `f…` no reader can place). The `label` floor keeps that leading
 * word readable beside the badge at every panel width, with the caller's full
 * text in its tooltip and every caller with a location a chip in the
 * occurrence list. The cell stays one line — wrapping the badge under the
 * caller would make multi-caller rows taller than their neighbours.
 *
 * Six columns, because the table is often drawn in one pane of a split. The
 * duplicate count shares the occurrence count's cell and the three durations
 * share one cell: separate, those four figures added four compact floors, and
 * the sum of the floors was wider than a split pane, so the columns beyond the
 * first few scrolled out of view and the request column — the only one allowed
 * to narrow — was cut to a few characters of its URL. Folded, every figure a
 * group carries is still in its row, the floors fit a split pane with the URL
 * and caller columns at or above their yielded minimums, and a wide panel
 * spends its spare width on the URL rather than on four columns of figures.
 *
 * Every role has a non-zero floor, because the floors are what the grid fits
 * or scrolls against: `DataTable` sums the columns' floors and minimums into
 * the grid's own width. A panel just too narrow for every floor narrows the
 * request (`text`) column alone, never below the `--dg-column-yield` fraction
 * of its floor, only as far as the table needs to fit: the URL ellipsizes and
 * the grouping chip moves under it, while every figure and the caller stay in
 * view. A panel too narrow even for that keeps every floor and scrolls
 * horizontally with every column readable, instead of squeezing the tracks
 * until one cell paints over the next.
 * Spare width goes mostly to the request, whose URL is text of unbounded
 * length, then to the callers, before any column of figures: a wide panel
 * shows URLs and caller chips in full rather than widening the tallies. A token
 * floor and a ratio resolve identically in the header row and in every data
 * row, which keeps each column under its own heading.
 */
const COLUMN_WIDTHS = Object.freeze({
  request: 'text',
  status: 'status',
  count: 'count',
  duration: 'quantity',
  transferred: 'quantity',
  initiators: 'label',
} satisfies Record<string, DataTableColumnWidth>);

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

/**
 * What a disclosure toggle that is not the retry successor spreads in place of
 * `RETRY_SUCCESSOR_FOCUS_ATTRIBUTES`: nothing.
 */
const NO_FOCUS_ATTRIBUTES: Readonly<Record<string, never>> = Object.freeze({});

/*
 * ---------------------------------------------------------------------------
 * Copy
 *
 * Generic throughout: no route, no URL, no component name and no framework
 * term appears in this file's wording. Every path, method and caller a reader
 * sees comes from the data.
 * ---------------------------------------------------------------------------
 */

const EMPTY_MESSAGE = 'No network requests were captured for this interaction.';
const EMPTY_TITLE = 'No requests';
const COUNT_ONLY_TITLE = 'Count only';
const COUNT_ONLY_UNKNOWN_TOTAL_MESSAGE =
  'This view requests a count without rows, and no total was reported for its query.';
const EMPTY_PAGE_TITLE = 'Nothing on this page';
const GROUP_NOUN_SINGULAR = 'request group';
const GROUP_NOUN_PLURAL = 'request groups';
const FILTERED_EMPTY_MESSAGE = 'None of the groups loaded so far has a duplicate occurrence.';
const LOADING_LABEL = 'Loading requests…';
const DUPLICATES_ONLY_LABEL = 'Duplicates only';
const DUPLICATES_ONLY_SCOPE_NOTE =
  'The duplicates filter applies to the groups loaded so far, not to the whole capture.';
const DUPLICATES_UNAVAILABLE_NOTE =
  'No request groups are loaded, so there are no duplicates to filter.';
const TRANSFER_UNAVAILABLE_NOTE =
  'No transfer size was exposed for this request, so none is shown rather than a misleading zero.';
/**
 * The labels of the duration cell's three figures for a group whose figures
 * differ. Short, conventional abbreviations, because each sits beside its
 * figure on one line of a `quantity` column; a reader hears them in the same
 * order, label then figure, as one run of the cell's text.
 */
const DURATION_AVERAGE_LABEL = 'avg';
const DURATION_SLOWEST_LABEL = 'max';
const DURATION_TOTAL_LABEL = 'total';
/** What the duplicate badge's figure counts, read after it and never drawn. */
const DUPLICATE_BADGE_HIDDEN_LABEL = 'redundant';
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
const NO_STATUS_LABEL = 'No status';
const NO_STATUS_GROUP_LABEL = 'Settled without a status code:';
const NO_STATUS_GROUP_NOTE =
  'An aborted request, a network error, a refused cross-origin response and an opaque one all settle without a code to report, so none of them appears among the status codes.';
const NO_STATUS_SINGLE_NOTE =
  'This request settled without a status code: it was aborted, failed on the network, or answered with a response the page could not read.';
const NO_STATUS_FAILURES_NOTE =
  'Any of them that failed is counted among the failures shown beside this badge.';
const NO_STATUS_SINGLE_FAILURE_NOTE = 'It failed, and it is the failure shown beside this badge.';
const LOAD_MORE_LABEL = 'Load more';
const LOAD_MORE_BUSY_LABEL = 'Loading more…';
const EXPAND_LABEL = 'Show occurrences';
const COLLAPSE_LABEL = 'Hide occurrences';
const NO_OCCURRENCES_NOTE = 'No individual occurrences were returned for this group.';
const SELECT_OCCURRENCE_LABEL = 'Select the occurrence at';
const OTHER_INITIATORS_LABEL = 'Also initiated by:';
/** Introduces, in a component caller's tooltip, the components that created it. */
const CREATED_BY_LABEL = 'Created by';
/**
 * Joins a creator chain in that tooltip, nearest first — the notation the
 * aggregate's component labels use (`Rail ‹ Header`).
 */
const CREATOR_CHAIN_SEPARATOR = ' ‹ ';
const OTHER_INITIATORS_SOURCE_NOTE =
  'Show the occurrences to open the source location recorded for each.';
const OCCURRENCES_SHOWN_LABEL = 'Occurrences shown:';
const GROUPS_LOADED_LABEL = 'Groups loaded:';
const DUPLICATES_MATCHED_LABEL = 'Matching the duplicates filter:';
const TOOLBAR_LABEL = 'Request ordering and filters';
/**
 * The ordering select's name. It says what it orders because a panel can hold
 * several tables with an ordering control each, and a reader moving between
 * form controls hears the names alone: three controls all called "Order"
 * cannot be told apart.
 */
const SORT_CONTROL_LABEL = 'Order requests';

/**
 * The attributes that mark the "load more" control as recognisable again after
 * a remount.
 *
 * The control keeps its own element while the page it asked for is in flight
 * (see the footer in {@link RequestTable}), so focus normally never leaves it.
 * The key is the fallback for the one path that does replace it — a failure,
 * which withdraws the control while the error state reports it, then a retry
 * that brings the control back — so the host's node frame can hand focus to the
 * equivalent control rather than to `<body>`. Keyed by the error state's
 * exported attribute name, so both halves of that contract spell it once.
 */
const LOAD_MORE_FOCUS_ATTRIBUTES = {
  [FOCUS_KEY_ATTRIBUTE]: 'request-table-load-more',
} as const;

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
 * The cluster with the most occurrences, or `undefined` for a group with none.
 *
 * A selection, not an aggregation: the windows were computed upstream and are
 * rendered as received. Written as a loop rather than `reduce` so the empty
 * case is explicit under `noUncheckedIndexedAccess` instead of relying on
 * `reduce`'s runtime throw.
 *
 * @param windows The group's duplicate windows, in time order.
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
 * @param group The group whose duplicates are being described.
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
 * @param group The group whose pending occurrences are counted.
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
 * @param group The group whose pending occurrences are described.
 * @param pendingCount Its {@link pendingCountOf}, already computed and above zero.
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
 * How many of a group's occurrences settled without reporting a status code,
 * as a count safe to print and compare.
 *
 * `noStatusCodeCount` is present only when at least one occurrence settled
 * without a code, so its absence reads as zero — which is also what a group
 * from an aggregate that predates the field reads as. A value that is not a
 * positive integer, or one larger than the group's own count, cannot come from
 * the aggregate and is read as zero rather than printed.
 *
 * @param group The group whose code-less occurrences are counted.
 * @returns The count, or `0` when none was reported.
 */
function noStatusCodeCountOf(group: RequestGroup): number {
  const { noStatusCodeCount } = group;

  return noStatusCodeCount !== undefined &&
    Number.isInteger(noStatusCodeCount) &&
    noStatusCodeCount > 0 &&
    noStatusCodeCount <= group.count
    ? noStatusCodeCount
    : 0;
}

/**
 * Describe a group's code-less occurrences for the "No status" badge's
 * tooltip, entirely from the group's own numbers: how many settled without a
 * code, why a settled request has none, and — when the row shows a failure
 * count — that those which failed are part of it, which is how the codes and
 * the failure count beside them reconcile.
 *
 * @param group The group whose code-less occurrences are described.
 * @param noStatusCount Its {@link noStatusCodeCountOf}, already computed and above zero.
 * @returns One or more sentences, safe to show as plain text.
 */
function describeNoStatus(group: RequestGroup, noStatusCount: number): string {
  if (group.count === 1) {
    return group.errorCount > 0
      ? `${NO_STATUS_SINGLE_NOTE} ${NO_STATUS_SINGLE_FAILURE_NOTE}`
      : NO_STATUS_SINGLE_NOTE;
  }

  const sentences = [
    `${NO_STATUS_GROUP_LABEL} ${formatCount(noStatusCount)} of ${formatCount(group.count)} occurrences.`,
    NO_STATUS_GROUP_NOTE,
  ];
  if (group.errorCount > 0) {
    sentences.push(NO_STATUS_FAILURES_NOTE);
  }

  return sentences.join(' ');
}

/**
 * The source location observed for one of a group's own initiator labels.
 *
 * A presentational lookup inside a single group, and explicitly **not** a
 * grouping pass: the group's membership, its ordering and its counts were all
 * decided upstream and are untouched here. The label set is already distinct
 * and sorted when it arrives; this only answers "did any occurrence attributed
 * to this caller resolve to a place in the project?", which is what turns the
 * caller column into a link. Two distinct LABELS can still resolve to one
 * location - a symbol name and the path it was declared at - and
 * {@link distinctInitiators} folds those together for display.
 *
 * Returns `undefined` when no occurrence for that label carried a location —
 * including when the occurrence list was truncated below the one that did — and
 * the caller then renders the label as plain text rather than a dead link.
 *
 * @param group The group whose occurrences are searched.
 * @param initiator One entry of that group's `initiators`.
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
 * The first occurrence a group attributes to one of its own initiator labels.
 *
 * The same presentational lookup as {@link locationForInitiator}: it answers
 * how the aggregate derived the label (`initiatorBasis`) and which captured
 * stack it was derived from (`initiatorStack`), both of which are the same for
 * every occurrence carrying that label. `undefined` when the occurrence list was
 * truncated below every occurrence carrying it.
 *
 * @param group The group whose occurrences are searched.
 * @param initiator One entry of that group's `initiators`.
 * @returns The first occurrence carrying the label, or `undefined`.
 */
function occurrenceForInitiator(
  group: RequestGroup,
  initiator: string,
): RequestOccurrence | undefined {
  return group.occurrences.find((occurrence) => occurrence.initiator === initiator);
}

/**
 * Whether a label names the React component that started a request (with its
 * owners), rather than a place in the code.
 *
 * Such a label is runtime evidence the source location cannot carry: two mounts
 * of one component run the same line under different owners, so they share a
 * location and are still two callers.
 */
function isComponentInitiator(group: RequestGroup, initiator: string): boolean {
  return occurrenceForInitiator(group, initiator)?.initiatorBasis === 'component';
}

/** The three coordinates the editor opens, as one comparable key. */
function locationKey(location: SourceLocation): string {
  return `${location.file}:${String(location.line)}:${String(location.column)}`;
}

/**
 * The group's callers as its row presents them: `initiators` in the order
 * received, less every caller whose resolved source location is one another
 * caller already names.
 *
 * Two labels for one place in the project - `fetchItemList` and
 * `src/hooks/useItemList.ts:42:18`, attributed by different occurrences - are
 * one caller to a reader: showing both counted a second initiator that does not
 * exist and offered the same location twice. The comparison is the location's
 * file, line and column, the three coordinates the editor opens; a caller with
 * no resolved location has nothing to compare and is always kept, since the
 * labels themselves are already distinct.
 *
 * A component caller ({@link isComponentInitiator}) is never folded: two mounts
 * of one component resolve to the same line and are two callers, which is the
 * very finding this column exists to show (AAP 0.8.2). The location it names
 * still counts as named, so a place-only label for that location — the same
 * code, observed where the renderer reported no component — is folded into it
 * wherever it appears in the order.
 *
 * Display only: the group's membership, counts and the `initiators` array
 * itself are untouched, and every occurrence still shows its own caller in the
 * detail row (see {@link renderOccurrenceInitiator}).
 *
 * @param group The group whose callers are listed.
 * @returns The callers to show, first one first.
 */
function distinctInitiators(group: RequestGroup): readonly string[] {
  const seenLocations = new Set<string>();

  for (const initiator of group.initiators) {
    const location = locationForInitiator(group, initiator);

    if (location !== undefined && isComponentInitiator(group, initiator)) {
      seenLocations.add(locationKey(location));
    }
  }

  const kept: string[] = [];

  for (const initiator of group.initiators) {
    if (isComponentInitiator(group, initiator)) {
      kept.push(initiator);
      continue;
    }

    const location = locationForInitiator(group, initiator);

    if (location !== undefined) {
      const key = locationKey(location);

      if (seenLocations.has(key)) {
        continue;
      }
      seenLocations.add(key);
    }
    kept.push(initiator);
  }

  return kept;
}

/**
 * Whether a caller label only spells the given location: its file alone,
 * `file:line`, or the full `file:line:column`.
 *
 * A producer that could not name a caller may record where it was instead, and
 * that label beside the chip for the same location printed one place twice.
 * The comparison is exact, after trimming surrounding whitespace, against the
 * location's own coordinates: a label that merely looks like a location — a
 * different file, line or column — is a different claim about the caller, and
 * is kept and shown. Display only, and within one occurrence: nothing is
 * compared across requests.
 *
 * @example
 * // location: src/example/widget.tsx:84:9
 * labelNamesLocation('src/example/widget.tsx:84:9', location); // true
 * labelNamesLocation('src/example/elsewhere.ts:1:1', location); // false
 *
 * @param label The caller label the occurrence recorded.
 * @param location The location the same occurrence resolved to.
 * @returns `true` when the label names that location and nothing else.
 */
function labelNamesLocation(label: string, location: SourceLocation): boolean {
  const text = label.trim();
  const fileAndLine = `${location.file}:${String(location.line)}`;

  return (
    text === location.file ||
    text === fileAndLine ||
    text === `${fileAndLine}:${String(location.column)}`
  );
}

/**
 * Clamp an authored `limit` into the range the paging contract accepts.
 *
 * An omitted limit stays omitted: the query is replayed as it was authored and
 * the side that resolves it applies the contract's default page size, which is
 * the only way the page size the service uses and the page size a panel asked
 * for stay the same number. A non-finite value cannot survive the schema, and is
 * also treated as omitted rather than forwarded as arithmetic that would reach
 * the wire.
 *
 * Every other value is truncated to a whole number and held within
 * `[COUNT_ONLY_LIMIT, DATA_QUERY_MAX_LIMIT]`. The floor is zero, not one: an
 * explicit `limit: 0` is a count-only request and is sent as exactly that, so
 * the service answers with the query's total and no groups rather than with a
 * single group nobody asked for. The ceiling keeps an over-sized authored value
 * inside the page bound the service enforces.
 *
 * @example
 * clampAuthoredLimit(undefined); // undefined — the resolver's default applies
 * clampAuthoredLimit(0); // 0 — a count without rows
 * clampAuthoredLimit(9000); // DATA_QUERY_MAX_LIMIT
 *
 * @param limit The node's authored limit, if any.
 * @returns A whole-number limit within `[0, DATA_QUERY_MAX_LIMIT]`, or `undefined`.
 */
function clampAuthoredLimit(limit: number | undefined): number | undefined {
  if (limit === undefined || !Number.isFinite(limit)) {
    return undefined;
  }

  return Math.min(Math.max(Math.trunc(limit), COUNT_ONLY_LIMIT), DATA_QUERY_MAX_LIMIT);
}

/**
 * The offset "load more" may request next, or `undefined` when no further page
 * can be asked for.
 *
 * Paging only ever moves forward, and only on the service's word.
 * A next page exists when all of the following hold:
 *
 *   - the page settled successfully — a page still resolving or a failure
 *     reports no counters worth following;
 *   - the effective limit asks for rows — an omitted limit does, since the
 *     resolver applies its default page size, while a count-only `limit: 0`
 *     never does: every page of it is empty, so a second request could only
 *     return the same answer;
 *   - the service reported a `nextOffset` that is a safe whole number strictly
 *     past the offset of the page it answered. An echo of that same offset, or
 *     one behind it, would re-request a page already on screen or step back
 *     into one, and neither is a next page.
 *
 * The value is returned as reported and never derived from the rows in hand,
 * which would drift the moment a limit was clamped.
 *
 * @param status The settled status of the current page.
 * @param limit The effective limit sent with the query, `undefined` when omitted.
 * @param offset The offset of the page the service answered.
 * @param nextOffset The next offset the service reported, if any.
 * @returns The offset to request next, or `undefined` when there is no next page.
 */
function forwardNextOffsetOf(
  status: 'loading' | 'error' | 'success',
  limit: number | undefined,
  offset: number,
  nextOffset: number | undefined,
): number | undefined {
  if (status !== 'success' || limit === COUNT_ONLY_LIMIT || nextOffset === undefined) {
    return undefined;
  }

  return Number.isSafeInteger(nextOffset) && nextOffset > offset ? nextOffset : undefined;
}

/** The title and message an empty settled page is described with. */
interface EmptyPageCopy {
  readonly title: string;
  readonly message: string;
}

/**
 * The copy of the empty capture: the one empty page that says nothing was
 * captured. A single frozen value, so the component recognises the case by
 * reference — it is the one empty state that carries the view's glyph and the
 * one drawn without a toolbar no control of which could reach anything.
 */
const NOTHING_CAPTURED_COPY: EmptyPageCopy = Object.freeze({
  title: EMPTY_TITLE,
  message: EMPTY_MESSAGE,
});

/** The facts that decide which kind of absence an empty settled page is. */
interface EmptyPageFacts {
  /** The effective limit sent with the query, `undefined` when omitted. */
  readonly limit: number | undefined;

  /** The offset of the page the service answered. */
  readonly offset: number;

  /** The total the service reported for the query, if any. */
  readonly total: number | undefined;

  /** Whether the service reported a forward next page (see {@link forwardNextOffsetOf}). */
  readonly hasNextPage: boolean;
}

/**
 * The noun for a number of request groups, agreeing with that number.
 *
 * @param count How many groups the sentence is about.
 * @returns `request group` for exactly one, `request groups` otherwise.
 */
function groupNounFor(count: number): string {
  return count === 1 ? GROUP_NOUN_SINGULAR : GROUP_NOUN_PLURAL;
}

/**
 * Describe a settled page that holds no groups, saying which absence it is.
 *
 * An empty page is not always an empty capture, and only one of the answers
 * below may say that nothing was captured. The contract admits four other ways
 * for a successful page to hold no rows — a count-only `limit: 0` query, an
 * authored offset past the end of the result, a page inside a positive total
 * that still came back empty, and a later page of a source that reported no
 * total — and each of them has rows or a count the reader should not be told
 * are absent. So the copy is chosen, first match wins:
 *
 *   1. **Count only** — the query asked for no rows. It states the total when
 *      one was reported and says that none was otherwise.
 *   2. **Nothing captured** — the reported total is zero, or no total was
 *      reported for a page at the start of the result with no page after it.
 *      The view's own empty message, unchanged.
 *   3. **Past the end** — a positive total and an offset at or beyond it. It
 *      names where the page starts and how many groups matched.
 *   4. **Empty within the total** — a positive total and an offset inside it.
 *      It states the total and that this page shows none of it.
 *   5. **No total** — any other page without a reported total: one that
 *      starts later than the first item, or one with a next page after it. It
 *      names where the page starts and that no total was reported.
 *
 * Positions are one-based, as a reader counts, while the offset is the number
 * of items skipped. A total that is not a non-negative safe whole number cannot
 * come from the page contract and is read as unreported rather than printed.
 * Every count goes through `formatCount`, and no wording names a route, a
 * component or a framework.
 *
 * @example
 * describeEmptyPage({ limit: 0, offset: 0, total: 42, hasNextPage: false });
 * // { title: 'Count only',
 * //   message: 'This view requests a count without rows: 42 request groups matched its query.' }
 *
 * @param facts The page's limit, offset, reported total and paging state.
 * @returns The empty state's title and message.
 */
function describeEmptyPage(facts: EmptyPageFacts): EmptyPageCopy {
  const { limit, offset, hasNextPage } = facts;
  const total =
    facts.total !== undefined && Number.isSafeInteger(facts.total) && facts.total >= 0
      ? facts.total
      : undefined;

  if (limit === COUNT_ONLY_LIMIT) {
    return {
      title: COUNT_ONLY_TITLE,
      message:
        total === undefined
          ? COUNT_ONLY_UNKNOWN_TOTAL_MESSAGE
          : `This view requests a count without rows: ${formatCount(total)} ${groupNounFor(
              total,
            )} matched its query.`,
    };
  }

  // A page at the start of the result with nothing after it is the whole
  // result, so an unreported total there still means nothing was captured.
  if (
    total === 0 ||
    (total === undefined && offset === DATA_QUERY_DEFAULT_OFFSET && !hasNextPage)
  ) {
    return NOTHING_CAPTURED_COPY;
  }

  const position = formatCount(offset + 1);

  if (total !== undefined && offset >= total) {
    return {
      title: EMPTY_PAGE_TITLE,
      message: `This page starts at position ${position}, past the end of the ${formatCount(
        total,
      )} ${groupNounFor(total)} that matched this query.`,
    };
  }

  if (total !== undefined) {
    return {
      title: EMPTY_PAGE_TITLE,
      message: `${formatCount(total)} ${groupNounFor(total)} matched this query, but none are shown on this page.`,
    };
  }

  return {
    title: EMPTY_PAGE_TITLE,
    message: `This page starts at position ${position} and holds no ${GROUP_NOUN_PLURAL}; no total was reported for this query.`,
  };
}

/*
 * ---------------------------------------------------------------------------
 * Orders, selection and the retry successor
 *
 * Every function below is pure. The arrangement is the one place rows are
 * re-ordered, and it compares one figure of each group — never a URL, a caller
 * label or anything that would amount to grouping two requests.
 * ---------------------------------------------------------------------------
 */

/**
 * Narrow a column key the grid reported back to a sortable column's key.
 *
 * @param key The key of the header that was activated.
 * @returns The sortable column's key, or `undefined` for any other column.
 */
function orderColumnKeyOf(key: string): OrderColumnKey | undefined {
  return ORDER_COLUMN_KEYS.find((candidate) => candidate === key);
}

/**
 * The service ordering that applies a requested order, when the service can
 * apply it.
 *
 * Exactly two column-and-direction pairs are service orders: Occurrences most
 * first and Duration longest total first. Every other pair — the reverse of either
 * included — yields `undefined` and becomes a view order over the groups
 * loaded, so re-activating the sorted Occurrences header, which the grid
 * proposes as a flip to ascending, arranges the loaded groups fewest first
 * rather than silently doing nothing or re-querying for the same order.
 *
 * @param order The column and direction the reader asked for.
 * @returns The ordering to request, or `undefined` when the service has none.
 */
function serviceSortFor(order: RequestOrder): DataQuerySort | undefined {
  if (order.direction !== 'desc') {
    return undefined;
  }

  if (order.key === COLUMN_KEY_COUNT) {
    return 'count_desc';
  }

  return order.key === COLUMN_KEY_DURATION ? 'duration_desc' : undefined;
}

/**
 * Whether an applied view order already is the order requested.
 *
 * @param applied The view order in force, or `null` for none.
 * @param requested The order asked for.
 * @returns `true` when both name the same column and direction.
 */
function isSameOrder(applied: RequestOrder | null, requested: RequestOrder): boolean {
  return (
    applied !== null && applied.key === requested.key && applied.direction === requested.direction
  );
}

/** `1` for ascending, `-1` for descending: the factor a comparison is scaled by. */
type OrderSign = 1 | -1;

/**
 * Compare two figures in the requested direction, with any value that is not a
 * finite number placed after every finite one in either direction: such a
 * value renders as the unavailable label, and a reversal must not bring the
 * unmeasured groups to the top.
 *
 * @param left The first figure.
 * @param right The second figure.
 * @param sign The direction factor.
 * @returns A negative number, zero or a positive number, as `Array#sort` expects.
 */
function compareFigures(left: number, right: number, sign: OrderSign): number {
  const leftFinite = Number.isFinite(left);
  const rightFinite = Number.isFinite(right);

  if (!leftFinite || !rightFinite) {
    if (leftFinite === rightFinite) {
      return 0;
    }

    return leftFinite ? -1 : 1;
  }

  return sign * (left - right);
}

/**
 * The groups arranged in a view order, as a new array.
 *
 * Stable by construction rather than by trusting the engine: groups that
 * compare equal keep the position the service gave them, in both directions,
 * so the service's own tie-break still decides among equals. The input is never
 * mutated — it is the service-ordered sequence "load more" appends to.
 *
 * @example
 * arrangeGroups(loaded, { key: 'averageDuration', direction: 'desc' });
 * // the loaded groups, longest average first
 *
 * @param groups The groups to arrange, in the service's order.
 * @param order The view order to arrange them in.
 * @returns The same groups, re-arranged.
 */
function arrangeGroups(
  groups: readonly RequestGroup[],
  order: RequestOrder,
): readonly RequestGroup[] {
  const figureOf = ORDER_FIGURES[order.key];
  const sign: OrderSign = order.direction === 'asc' ? 1 : -1;
  const positioned = groups.map((group, position) => ({
    group,
    position,
    figure: figureOf(group),
  }));

  positioned.sort((left, right) => {
    const primary = compareFigures(left.figure, right.figure, sign);

    return primary === 0 ? left.position - right.position : primary;
  });

  return positioned.map((entry) => entry.group);
}

/**
 * The select's label for an applied view order: the column, the direction in
 * that column's own unit, and the scope — "Duration: shortest total first
 * (loaded groups)".
 *
 * @param order The view order in force.
 * @returns The label.
 */
function viewOrderLabel(order: RequestOrder): string {
  return `${ORDER_COLUMN_HEADERS[order.key]}: ${
    ORDER_DIRECTION_PHRASES[order.key][order.direction]
  } ${VIEW_ORDER_SCOPE_SUFFIX}`;
}

/**
 * The toolbar select's options for the view order in force.
 *
 * The set is the same four choices in every state; only the last one's label
 * and availability follow the view order, so the select can name the order a
 * header applied while the list itself never reorders under the reader.
 *
 * @param viewOrder The view order in force, or `null` for none.
 * @returns The options.
 */
function sortOptionsFor(viewOrder: RequestOrder | null): ToolbarSelect['options'] {
  if (viewOrder === null) {
    return IDLE_SORT_OPTIONS;
  }

  return [
    ...SERVICE_SORT_OPTIONS,
    { value: VIEW_ORDER_OPTION_VALUE, label: viewOrderLabel(viewOrder) },
  ];
}

/**
 * What the order in force is reported to the host as, through
 * `PanelActions.onFilterChange(nodeId, { sort, … })`.
 *
 * A service ordering is reported in the data layer's own spelling
 * (`count_desc`, `duration_desc`, `start_asc`); a view order as
 * `<column>_<direction>` (`total_asc`, `count_asc`, …), the spelling
 * `SpanTable` reports its view orders in, so a name outside the `DataQuerySort`
 * vocabulary is, by construction, a view order.
 *
 * @param sort The service ordering the loaded groups were fetched in.
 * @param viewOrder The view order applied over them, or `null` for none.
 * @returns The report's `sort` value.
 */
function orderReportOf(sort: DataQuerySort, viewOrder: RequestOrder | null): string {
  return viewOrder === null ? sort : `${ORDER_REPORT_NAMES[viewOrder.key]}_${viewOrder.direction}`;
}

/**
 * The footer sentence added while a view order arranges groups that are not
 * the whole result: without it a reader would take the first row under
 * "Duration: longest total first" for the longest of the whole capture.
 *
 * @param loaded How many groups the view order arranged; positive.
 * @returns The scope sentence.
 */
function describeViewOrderScope(loaded: number): string {
  return `This order covers only the ${formatCount(loaded)} ${groupNounFor(
    loaded,
  )} loaded; the full result can be ordered only by occurrences, by total duration or by first start.`;
}

/**
 * The key of the loaded group that holds the panel's selected event.
 *
 * A group stands for the selection when one of its own occurrences does — the
 * one this view's row activation selects, one picked in the open detail, or the
 * same event selected in any other view — matched as `matchesPanelSelection`
 * matches everywhere. Only occurrences the group carries can match: a selection
 * among occurrences the aggregate truncated away marks no row rather than a
 * guessed one.
 *
 * @param groups The loaded groups, in the service's order: the first that
 *   matches keeps the mark whichever order arranges them.
 * @param selection The panel's selection, or `undefined` for none.
 * @returns The matching group's id, or `null` when no loaded group holds it.
 */
function selectedGroupKeyOf(
  groups: readonly RequestGroup[],
  selection: PanelSelection | undefined,
): string | null {
  if (selection === undefined) {
    return null;
  }

  const match = groups.find((group) =>
    group.occurrences.some((occurrence) => matchesPanelSelection(selection, occurrence)),
  );

  return match === undefined ? null : match.id;
}

/**
 * The occurrence a group row stands for when it is activated: its canonically
 * earliest issuance, the first of the occurrences the aggregate carries.
 *
 * A group is not an event and never fabricates a coordinate, so the row selects
 * a real captured occurrence — the one whose start is the group's
 * `firstStartTime` — with that occurrence's own id, trace and span.
 *
 * @param group The activated group.
 * @returns The occurrence, or `undefined` when the group carries none.
 */
function representativeOccurrenceOf(group: RequestGroup): RequestOccurrence | undefined {
  return group.occurrences[0];
}

/**
 * The group whose disclosure toggle takes over keyboard focus from a retry that
 * succeeded: the first group of the settled page that is on screen.
 *
 * The error state's successor contract (`RETRY_SUCCESSOR_FOCUS_ATTRIBUTES` in
 * `../primitives/ErrorState`), for both scopes this view retries in. After a
 * failed first page the settled page is the whole table; after a failed
 * further page it is the page appended below the groups already read, so
 * focus lands on the first group that arrived rather than jumping back to the
 * top. Only a page that settled successfully names one — while a page is in
 * flight or has failed nothing is recovered, and the failure's own Retry must
 * be the only keyed control in the node — and a group the duplicates filter
 * hides is passed over for the next one shown.
 *
 * @param status The status of the current page.
 * @param page The current page's groups.
 * @param rows The groups on screen.
 * @returns The id of the successor group, or `undefined` for none.
 */
function retrySuccessorKeyOf(
  status: 'loading' | 'error' | 'success',
  page: readonly RequestGroup[],
  rows: readonly RequestGroup[],
): string | undefined {
  if (status !== 'success' || page.length === 0) {
    return undefined;
  }

  const shown = new Set(rows.map((group) => group.id));

  return page.find((group) => shown.has(group.id))?.id;
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
 * The tab index of every focusable element this file renders inside the grid:
 * the disclosure toggle, the tooltip triggers, the caller and occurrence
 * source chips and the occurrence selection buttons.
 *
 * The grid is ONE Tab stop — its active row — and `DataTable`'s own keys reach
 * everything inside a row from there (see `../primitives/DataTable`): Arrow
 * Right from the row opens a collapsed group and then moves onto its first
 * control, Arrow Right/Left move across the row's controls and on into its open
 * occurrence list, Arrow Left from the first control and Escape return to the
 * row, and Arrow Up/Down leave for the neighbouring row. A control left at `0`
 * would add a Tab stop per control per rendered row, which is the tab sequence
 * the grid pattern exists to prevent. `-1` keeps each element focusable — by
 * those keys and by pointer — while taking it out of the Tab order. It is the
 * same in every row, whichever row the reader is on: the grid's roving row is
 * the only thing that moves.
 *
 * The tooltip triggers need focusability at all because a `Tooltip` opens on
 * focus, and a badge, a text run or an inline code element cannot receive focus
 * by itself: without it a keyboard reader could never reach the full URL, the
 * complete status list, the failure and duplicate explanations, the grouping
 * note, the unavailable-size reason, what "Pending" means, the full label of a
 * caller without a location or the callers a row counts rather than shows. Such
 * a trigger is focusable and nothing more: no `role="button"` and no click
 * handler, because nothing happens on activation, and no `aria-label`, because
 * the visible text is the name and the tooltip merges its bubble into the
 * trigger's `aria-describedby`. The first Escape on an open trigger closes the
 * bubble and the second returns to the row. The focus indicator is the global
 * `:focus-visible` ring from `../styles/base.css`.
 *
 * Typed as the literal `-1`, which is what `SourceLink`'s `tabIndex` accepts.
 */
const GRID_CONTROL_TAB_INDEX = -1;

/**
 * One reported response code as a status chip, shared by the group row and the
 * occurrence row so the two levels cannot drift apart.
 *
 * The code is classified once, by the shared `httpStatusClass`, and that one
 * class supplies both the `Badge` tone (`HTTP_STATUS_CLASS_TONES`, the table
 * the waterfall and the timeline read too) and this table's stylesheet
 * modifier, so the colour of a 301, a 404 or a 500 is the same in every view
 * of the panel.
 *
 * @param code The status code an occurrence reported.
 * @returns The chip, keyed by the code so a list of distinct codes can hold it.
 */
function renderStatusCodeBadge(code: number): ReactNode {
  const statusClass = httpStatusClass(code);

  return (
    <Badge
      key={code}
      tone={HTTP_STATUS_CLASS_TONES[statusClass]}
      variant="outline"
      className={clsx('dg-request-table__status', STATUS_CLASS_MODIFIERS[statusClass])}
    >
      {String(code)}
    </Badge>
  );
}

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
 * @param label The visible text: the word "Pending", with a count when useful.
 * @param note The tooltip's explanation, safe to show as plain text.
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
        tabIndex={GRID_CONTROL_TAB_INDEX}
      >
        {label}
      </Badge>
    </Tooltip>
  );
}

/**
 * The "No status" badge: the group's occurrences that settled without a status
 * code, on the base status chip in the neutral tone — reporting no code is not
 * itself a failure, and the failures among them are the failure count's to
 * show — with a glyph for "none" and the visible words carrying the state.
 * The count is shown when the group holds more than one occurrence, like the
 * Pending badge's, so "No status 2" beside a lone 200 and a failure count of 2
 * reads without the tooltip.
 *
 * @param group The group whose code-less occurrences are shown.
 * @param noStatusCount Its {@link noStatusCodeCountOf}, already computed and above zero.
 * @returns The badge in its tooltip.
 */
function renderNoStatusBadge(group: RequestGroup, noStatusCount: number): ReactNode {
  return (
    <Tooltip content={describeNoStatus(group, noStatusCount)}>
      <Badge
        tone="neutral"
        variant="outline"
        className="dg-request-table__status"
        icon={<CircleSlash className="dg-icon" />}
        tabIndex={GRID_CONTROL_TAB_INDEX}
      >
        {group.count > 1 ? `${NO_STATUS_LABEL} ${formatCount(noStatusCount)}` : NO_STATUS_LABEL}
      </Badge>
    </Tooltip>
  );
}

/**
 * The status cell: one badge per distinct code the group observed, with the
 * remainder summarised, a Pending badge when any occurrence was still in
 * flight, a "No status" badge when any settled without a code, and a failure
 * count when any occurrence failed.
 *
 * Together they account for every occurrence: each is pending, settled with
 * one of the codes shown, or settled without one — so a failure count larger
 * than the failing codes explain is never left unexplained beside them.
 *
 * The codes arrive distinct and ascending; nothing here re-derives them. An
 * absent code list is rendered as the unavailable label on a neutral badge,
 * never as a zero or a blank cell — except when the Pending and "No status"
 * badges between them already explain every missing code, where the
 * unavailable label beside them would claim an occurrence the aggregate
 * accounted for. A group from an aggregate that predates `noStatusCodeCount`
 * reports no code-less occurrence, and keeps the unavailable label.
 *
 * The Pending badge shows the pending count when the group holds more than one
 * occurrence, so "Pending 2" on a row of five reads without the tooltip.
 *
 * @param group The group whose statuses are shown.
 * @returns The cell's content.
 */
function renderStatusCell(group: RequestGroup): ReactNode {
  const shown = group.statusCodes.slice(0, MAX_STATUS_BADGES);
  const overflow = group.statusCodes.length - shown.length;
  const pendingCount = pendingCountOf(group);
  const noStatusCount = noStatusCodeCountOf(group);
  const everyMissingCodeExplained =
    (pendingCount > 0 || noStatusCount > 0) && pendingCount + noStatusCount >= group.count;

  let codeBadges: ReactNode;

  if (group.statusCodes.length > 0) {
    codeBadges = shown.map((code) => renderStatusCodeBadge(code));
  } else if (everyMissingCodeExplained) {
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
            tabIndex={GRID_CONTROL_TAB_INDEX}
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
      {noStatusCount > 0 ? renderNoStatusBadge(group, noStatusCount) : null}
      {group.errorCount > 0 ? (
        <Tooltip
          content={`${ERROR_COUNT_LABEL} ${formatCount(group.errorCount)} of ${formatCount(
            group.count,
          )}.`}
        >
          <Badge tone="danger" variant="soft" tabIndex={GRID_CONTROL_TAB_INDEX}>
            {formatCount(group.errorCount)}
          </Badge>
        </Tooltip>
      ) : null}
    </Stack>
  );
}

/**
 * The occurrences cell: how many times the request occurred and, for a group
 * with redundant occurrences, the duplicate badge beside that count.
 *
 * Both numbers come from the group as received. The badge carries the
 * redundant count, the duplicate glyph and the warning tone the row's edge
 * shares, and its tooltip names the figure and describes the clusters the
 * detector found, in that capture's own measurements. A group without
 * duplicates draws the count alone: a zero beside every ordinary count would
 * be noise, and the badge's absence is the statement. The two share one cell
 * because the badge is exactly what the `count` role keeps room for; the
 * items wrap, so a badge that does not fit beside a long count moves under it
 * instead of overflowing into the next column.
 *
 * @param group The group whose occurrence count and duplicate evidence are shown.
 * @returns The cell's content.
 */
function renderCountCell(group: RequestGroup): ReactNode {
  return (
    <Stack
      direction="horizontal"
      gap={1}
      align="center"
      justify="end"
      wrap
      className="dg-request-table__duplicates"
    >
      <Text size="sm" numeric>
        {formatCount(group.count)}
      </Text>
      {group.hasDuplicates ? (
        <Tooltip content={describeDuplicates(group)}>
          <Badge
            tone="warning"
            variant="outline"
            className="dg-request-table__duplicate-badge"
            icon={<Copy className="dg-icon" />}
            tabIndex={GRID_CONTROL_TAB_INDEX}
          >
            {formatCount(group.duplicateCount)}
            {/* The column is headed "Occurrences", so the second figure in it
                names itself to a reader who hears the cell without seeing the
                glyph and the tone that set it apart. */}
            <span className="dg-visually-hidden">{` ${DUPLICATE_BADGE_HIDDEN_LABEL}`}</span>
          </Badge>
        </Tooltip>
      ) : null}
    </Stack>
  );
}

/**
 * The duration cell: a group's average, slowest and total durations.
 *
 * A group whose three figures are equal — one occurrence, the ordinary case —
 * draws that one duration alone, since labelling one value three ways says
 * nothing more. Otherwise each figure is a line of its own, its short label
 * before it, in a fixed order (average, slowest, total), end-aligned so the
 * figures compare down the column. Each figure is a `DurationCell` with
 * `severity="auto"`, as each was when it had a column of its own; a line wraps
 * its label above its figure rather than overflow a narrow column.
 *
 * The figures are the aggregate's as received — nothing is re-derived from the
 * occurrences — and a pending occurrence's elapsed time is part of them, which
 * the status cell's Pending note states.
 *
 * @param group The group whose durations are shown.
 * @returns The cell's content.
 */
function renderDurationCell(group: RequestGroup): ReactNode {
  const { averageDurationMs, maxDurationMs, totalDurationMs } = group;

  if (averageDurationMs === maxDurationMs && maxDurationMs === totalDurationMs) {
    return <DurationCell ms={averageDurationMs} severity="auto" size="sm" />;
  }

  const figures: readonly (readonly [label: string, ms: number])[] = [
    [DURATION_AVERAGE_LABEL, averageDurationMs],
    [DURATION_SLOWEST_LABEL, maxDurationMs],
    [DURATION_TOTAL_LABEL, totalDurationMs],
  ];

  return (
    <Stack direction="vertical" gap={0} className="dg-request-table__durations">
      {figures.map(([label, ms]) => (
        <Stack key={label} direction="horizontal" gap={1} align="baseline" justify="end" wrap>
          <Text size="xs" tone="muted">
            {label}
          </Text>
          <DurationCell ms={ms} severity="auto" size="sm" />
        </Stack>
      ))}
    </Stack>
  );
}

/**
 * The transferred-bytes cell.
 *
 * A same-origin response is the only kind whose size the browser exposes, so an
 * absent figure is the ordinary case (the "Computed metrics" section of
 * `docs/ARCHITECTURE.md` records the limit). It is shown as the unavailable
 * label with the reason in a tooltip — never as `0`, which would read as a
 * response that carried nothing.
 *
 * @param group The group whose transfer size is shown.
 * @returns The cell's content.
 */
function renderTransferredCell(group: RequestGroup): ReactNode {
  return group.transferredBytes === undefined ? (
    <Tooltip content={TRANSFER_UNAVAILABLE_NOTE}>
      <Text size="sm" tone="muted" tabIndex={GRID_CONTROL_TAB_INDEX}>
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
 * A caller's label as plain, non-interactive text immediately followed by the
 * source chip its occurrence resolved to, as ONE slot element.
 *
 * One element because both places that show it count their slots: the
 * initiators cell holds exactly its first caller and the count badge, and an
 * occurrence row exactly four slots (see {@link renderOccurrence}). The slot is
 * a plain `Stack` that never wraps, which lets its row shrink with the column
 * instead of breaking onto a second line: the label composes the shared
 * single-line utility — a recorded caller string can be as long as a full path,
 * and without it the label would refuse to shrink below its text — and the
 * chip keeps the column's slot class, which lets it shrink and truncate its own
 * path run. The clip is visual only; the whole label stays in the
 * accessibility tree.
 *
 * The label is no control — plain code text, never a button and never the
 * chip's caption (see {@link renderInitiatorSlot}) — so it cannot be mistaken
 * for the link beside it. A component caller whose occurrence recorded the
 * components that created it is, however, the trigger of a tooltip disclosing
 * {@link callerDisclosure}: its label is often wider than the column
 * (`RecommendationsRail ‹ ProductDetailPage` in a 200 px cell reads
 * `Recommen…`), and the part a reader needs to tell two mounts apart is the
 * part the ellipsis cuts. Such a trigger is `tabIndex={-1}` like every other
 * trigger in the grid, reached by the grid's arrow keys (see
 * {@link GRID_CONTROL_TAB_INDEX}), so the disclosure opens on focus as well as
 * on hover. Any other label has nothing to disclose beyond its own text, which
 * stays whole in the accessibility tree, so it stays plain text: a tooltip
 * repeating it would only make a screen reader announce it twice.
 *
 * @param label The caller label, already reduced to one line.
 * @param chip The source chip for the caller's location.
 * @param disclosure What the label's tooltip discloses, when there is more to
 * say than the label.
 * @returns The slot.
 */
function renderCallerBesideChip(
  label: string,
  chip: ReactNode,
  disclosure: string | undefined,
): ReactNode {
  return (
    <Stack direction="horizontal" gap={1} align="center">
      {disclosure === undefined ? (
        <Code size="sm" className="dg-truncate">
          {label}
        </Code>
      ) : (
        <Tooltip content={disclosure}>
          <Code size="sm" className="dg-truncate" tabIndex={GRID_CONTROL_TAB_INDEX}>
            {label}
          </Code>
        </Tooltip>
      )}
      {chip}
    </Stack>
  );
}

/**
 * The full text behind a component caller's label: the label and the whole
 * chain of components that created the component, nearest first — the label
 * names only as many of them as it takes to tell the group's mounts apart.
 * `undefined` for any other caller, and for a component whose occurrence
 * recorded no creator.
 *
 * @param label The caller label, as recorded.
 * @param occurrence An occurrence the label was taken from, when there is one.
 * @returns The tooltip text, or `undefined` when there is nothing to disclose.
 */
function callerDisclosure(
  label: string,
  occurrence: RequestOccurrence | undefined,
): string | undefined {
  if (occurrence?.initiatorBasis !== 'component') {
    return undefined;
  }
  const owners = occurrence.initiatorOwners ?? [];
  if (owners.length === 0) {
    return undefined;
  }
  const chain = owners.map((owner) => oneLinePreview(owner)).join(CREATOR_CHAIN_SEPARATOR);
  return `${oneLinePreview(label)}. ${CREATED_BY_LABEL} ${chain}.`;
}

/**
 * One caller of a group, as the group row shows it: ONE slot, so the initiators
 * cell holds exactly this slot and, when the group has further callers, the
 * badge counting them.
 *
 * ## The chip names the place it opens, never the caller's label
 *
 * An initiator label is whatever the producer recorded in the request's
 * `initiator` attribute: a component name, a function name, or any other
 * string, including one shaped like a path to somewhere else entirely. Used as
 * the chip's caption it would make the chip say one thing and open another —
 * a label-in-name failure (WCAG 2.5.3) and, for a label that looks like a
 * location, a chip that misdirects. So the two are kept apart:
 *
 *   - A caller with a location → its label as plain, non-interactive monospace
 *     text, immediately followed by the source chip in the same slot
 *     ({@link renderCallerBesideChip}). The chip takes NO `label`: its caption
 *     is derived by `SourceLink` from the resolved location itself — the
 *     symbol, then the compacted `file:line` — and its accessible name is that
 *     caption followed by the full `file:line:column` it opens
 *     (`sourceLinkAccessibleName`). The location is handed to the chip exactly
 *     as the occurrence carried it — the same object, unmodified — because it
 *     is what the click-to-source chain forwards.
 *     A label the aggregate derived from that same location (`initiatorBasis`
 *     `source`: the resolved symbol and `file:line`), or a label that is
 *     exactly the location's symbol, is not repeated beside it — the chip
 *     already reads exactly that.
 *   - A caller without one → its label as a tooltip trigger disclosing the
 *     caller's full text: the captured stack the label was reduced from
 *     (`initiatorStack`) when there is one, the label itself otherwise. The
 *     cell truncates it with CSS, which no string comparison can detect, so the
 *     tooltip is always attached rather than only when the text was shortened
 *     here.
 *
 * The chip and the trigger are `tabIndex={-1}`: the grid's arrow keys reach
 * them (see {@link GRID_CONTROL_TAB_INDEX}).
 *
 * @param group The group the caller belongs to, searched for its location.
 * @param initiator One entry of that group's `initiators`.
 * @returns The caller's slot.
 */
function renderInitiatorSlot(group: RequestGroup, initiator: string): ReactNode {
  const location = locationForInitiator(group, initiator);
  const origin = occurrenceForInitiator(group, initiator);
  const label = oneLinePreview(initiator);

  if (location === undefined) {
    return (
      <Tooltip content={origin?.initiatorStack ?? initiator}>
        <Code size="sm" className="dg-truncate" tabIndex={GRID_CONTROL_TAB_INDEX}>
          {label}
        </Code>
      </Tooltip>
    );
  }

  const chip = (
    <SourceLink
      location={location}
      showSymbol
      className="dg-request-table__initiator"
      tabIndex={GRID_CONTROL_TAB_INDEX}
    />
  );

  // The chip leads with the location's symbol, so a label that is exactly that
  // symbol — a component named alone at its own declaration — says nothing
  // the chip does not already say.
  const repeatsChip =
    origin?.initiatorBasis === 'source' ||
    (location.symbol !== undefined && initiator.trim() === location.symbol);

  return repeatsChip
    ? chip
    : renderCallerBesideChip(label, chip, callerDisclosure(initiator, origin));
}

/**
 * Describe the callers a group row does not show, for the overflow badge's
 * tooltip.
 *
 * Names them in the order received and, when any of them resolved to a
 * location, says where that location can be opened: a tooltip holds text only,
 * and each of those callers is a source chip in the occurrence list.
 *
 * @param group The group whose callers are described.
 * @param others The callers after the first, as received.
 * @returns One or two sentences, safe to show as plain text.
 */
function describeOtherInitiators(group: RequestGroup, others: readonly string[]): string {
  const sentences = [
    `${OTHER_INITIATORS_LABEL} ${others.map((initiator) => oneLinePreview(initiator)).join(', ')}.`,
  ];

  if (others.some((initiator) => locationForInitiator(group, initiator) !== undefined)) {
    sentences.push(OTHER_INITIATORS_SOURCE_NOTE);
  }

  return sentences.join(' ');
}

/**
 * The initiators cell: the first distinct caller the group recorded, and a
 * count of the others with their names in its tooltip.
 *
 * This is the column that makes the third demonstrated question legible — a
 * duplicate group with *two* callers is a different finding from one caller
 * firing twice — so the number of callers is always visible: the first as its
 * slot ({@link renderInitiatorSlot}), and every further one counted by the `+N`
 * badge beside it. One line per row, never wrapped, so every row keeps the same
 * height; the first caller keeps a readable width because the column holds its
 * `label` floor rather than yielding (see {@link COLUMN_WIDTHS}); the full list
 * is the badge's description, and every caller with a location is a source chip
 * in the occurrence list.
 *
 * The cell's stack therefore holds exactly one item, or two when the badge is
 * drawn. The badge is a tooltip trigger, `tabIndex={-1}` like every control in
 * the grid (see {@link GRID_CONTROL_TAB_INDEX}). Place-only callers that
 * resolve to a location another caller already names are folded into it first
 * ({@link distinctInitiators}), so no location is counted as a second caller —
 * while two components that share a line stay two callers.
 *
 * @param group The group whose callers are shown.
 * @returns The cell's content.
 */
function renderInitiatorsCell(group: RequestGroup): ReactNode {
  const [first, ...others] = distinctInitiators(group);

  return (
    <Stack direction="horizontal" gap={1} align="center" className="dg-request-table__initiators">
      {first === undefined ? (
        <Text size="sm" tone="muted">
          {NOT_AVAILABLE_LABEL}
        </Text>
      ) : (
        renderInitiatorSlot(group, first)
      )}
      {others.length === 0 ? null : (
        <Tooltip content={describeOtherInitiators(group, others)}>
          <Badge tone="neutral" variant="soft" tabIndex={GRID_CONTROL_TAB_INDEX}>
            {`+${formatCount(others.length)}`}
          </Badge>
        </Tooltip>
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
 * The occurrence that is the panel's selected event — reported from this row or
 * from any other view that draws the same event — carries the design system's
 * one selected-state class, `dg-is-selected`, on the whole line, and its select
 * control reports `aria-pressed="true"`, so the mark is an attribute as well as
 * a colour. Every other select control reports `false`.
 *
 * The status slot has three forms. An occurrence the producer flagged as
 * pending shows the Pending badge — the flag is the producer's explicit
 * statement that no response had arrived, so it wins over every other field —
 * and its duration is the elapsed time until the capture ended, which the
 * badge's tooltip says. A settled occurrence with a code shows the code; one
 * without a code keeps its span status (`Unreported`, `OK` or `Error`), which is
 * never presented as pending.
 *
 * The row renders EXACTLY FOUR slots, always in this order — the offset, the
 * duration, the status and the initiator — because the occurrence list is one
 * grid of four columns that every occurrence adopts as a subgrid (see
 * `.dg-request-table__occurrences` in `../styles/components.css`). A slot left
 * out would shift every later slot one column to the left and make the list
 * ragged, so the initiator slot is always filled, by
 * {@link renderOccurrenceInitiator}.
 *
 * @param group The group the occurrence belongs to, for its time origin.
 * @param occurrence The occurrence to render.
 * @param onSelect Selection handler, or `undefined` for the inert form.
 * @param selected Whether this occurrence is the panel's selected event.
 * @returns One occurrence row.
 */
function renderOccurrence(
  group: RequestGroup,
  occurrence: RequestOccurrence,
  onSelect: ((occurrence: RequestOccurrence) => void) | undefined,
  selected: boolean,
): ReactNode {
  const offsetText = formatOffset(occurrence.startTime, group.firstStartTime);

  let statusBadge: ReactNode;

  if (occurrence.pending === true) {
    statusBadge = renderPendingBadge(PENDING_LABEL, PENDING_OCCURRENCE_NOTE);
  } else if (occurrence.statusCode === undefined) {
    // The span status in the shared status tone, so a code-less failure reads
    // in the same colour as the timeline's detail chip for the same span.
    statusBadge = (
      <Badge tone={statusTone(occurrence.status)} variant="soft">
        {formatStatusLabel(occurrence.status)}
      </Badge>
    );
  } else {
    statusBadge = renderStatusCodeBadge(occurrence.statusCode);
  }

  // `gap` is the occurrence grid's own column gap, so the subgrid's gutters are
  // the parent's and no slot is offset by a difference between the two. No
  // `wrap`: the slots are columns of a grid, not a line that may break.
  return (
    <Stack
      key={occurrence.id}
      direction="horizontal"
      gap={3}
      align="center"
      className={clsx('dg-request-table__occurrence-row', selected && 'dg-is-selected')}
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
          tabIndex={GRID_CONTROL_TAB_INDEX}
          aria-pressed={selected}
          onClick={() => {
            onSelect(occurrence);
          }}
        >
          {offsetText}
        </Button>
      )}
      <DurationCell ms={occurrence.durationMs} severity="auto" size="sm" />
      {statusBadge}
      {renderOccurrenceInitiator(occurrence)}
    </Stack>
  );
}

/**
 * The initiator slot of one occurrence: ONE element that says who issued it
 * and, when the capture resolved it, where.
 *
 *   - A source location → the compact source chip. Like the group row's chip
 *     it takes NO `label`: its caption is the location's own compact
 *     `file:line`, and its accessible name and tooltip name the location in
 *     full, so what the chip says is where it goes (WCAG 2.5.3). A caller
 *     label the occurrence also carries is shown before the chip, as plain
 *     text in the same slot ({@link renderCallerBesideChip}) — unless that
 *     label only spells the chip's own location ({@link labelNamesLocation}),
 *     which the chip already shows, so no occurrence prints its location
 *     twice. A label naming a DIFFERENT place is always shown, and always as
 *     text beside the chip rather than as its caption, so it cannot pass for
 *     the link. A label the aggregate derived from this very location
 *     (`initiatorBasis` `source`) is shown as its symbol alone, the part the
 *     compact chip leaves out. The location object is handed to the chip by
 *     reference and unmodified, because it is what the click-to-source chain
 *     forwards.
 *   - A label and no location → the label as code, truncated to its column.
 *   - Neither → the unavailable label, muted, so the slot is never empty.
 *
 * Whatever the shape, the slot is ONE element: a label and a chip rendered as
 * two siblings would give the row a fifth slot and push it out of the
 * occurrence list's four columns (see {@link renderOccurrence}). The chip is
 * `tabIndex={-1}` (see {@link GRID_CONTROL_TAB_INDEX}).
 *
 * @param occurrence The occurrence whose initiator is shown.
 * @returns The slot's single element.
 */
function renderOccurrenceInitiator(occurrence: RequestOccurrence): ReactNode {
  const { initiator, initiatorBasis, source } = occurrence;

  if (source !== undefined) {
    const chip = (
      <SourceLink
        location={source}
        compact
        className="dg-request-table__initiator"
        tabIndex={GRID_CONTROL_TAB_INDEX}
      />
    );
    const caller = initiatorBasis === 'source' ? source.symbol : initiator;

    return caller === undefined || labelNamesLocation(caller, source)
      ? chip
      : renderCallerBesideChip(
          oneLinePreview(caller),
          chip,
          callerDisclosure(caller, initiatorBasis === 'source' ? undefined : occurrence),
        );
  }

  if (initiator !== undefined) {
    return (
      <Code size="sm" className="dg-truncate">
        {oneLinePreview(initiator)}
      </Code>
    );
  }

  return (
    <Text size="xs" tone="muted">
      {NOT_AVAILABLE_LABEL}
    </Text>
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
 * Every member but `identity` changes what is requested or what is shown;
 * `identity` is what makes a stale set detectable: a node whose query changed
 * under the same node id gets a fresh view rather than an offset into the
 * result of the query it replaced.
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

  /**
   * The total the service reported for the result the carried pages belong
   * to, or `undefined` when nothing is carried or no total was reported.
   *
   * Recorded when "load more" carries the pages forward, so that while the next
   * page is in flight the footer keeps stating the same coverage ("2 of 7")
   * instead of dropping the total the hook cannot report until it settles.
   */
  readonly carriedTotal: number | undefined;

  /** The ids of the expanded groups. */
  readonly expanded: readonly string[];

  /** Whether the local duplicates-only filter is engaged. */
  readonly duplicatesOnly: boolean;

  /**
   * The view order the loaded groups are arranged in, or `null` while they are
   * shown in the service's order. Not part of the query: it changes how the
   * loaded groups are arranged, never which groups are loaded.
   */
  readonly viewOrder: RequestOrder | null;

  /**
   * Whether the reader has chosen an ordering in this view — from the select or
   * a header. From then on the grid stays mounted through every re-query, so
   * the control they used keeps its element and their focus.
   */
  readonly ordered: boolean;
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
 * @param node The node being rendered.
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
 * carried, nothing expanded, no filter, no view order and no reader ordering.
 *
 * @param node The node being rendered.
 * @param identity Its {@link viewIdentityOf}, already computed by the caller.
 * @returns The initial state for that node.
 */
function initialView(node: RequestTableNode, identity: string): RequestTableView {
  return {
    identity,
    sort: node.query.sort ?? DEFAULT_SORT,
    offset: node.query.offset ?? DATA_QUERY_DEFAULT_OFFSET,
    carried: EMPTY_GROUPS,
    carriedTotal: undefined,
    expanded: EMPTY_IDS,
    duplicatesOnly: false,
    viewOrder: null,
    ordered: false,
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
 * something the capture never said.
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
 * settled page with no groups renders the empty state, worded for the absence
 * it is — a count-only query, a page past the end or inside a positive total, or
 * a capture that really held nothing — and keeps "load more" reachable when the
 * service reported a forward next page (see {@link describeEmptyPage}). A later
 * page that is still resolving keeps the groups already received on screen —
 * neither a stale page nor an invented one: those rows were received, and the
 * footer says how many of the source they cover — and keeps the paging control
 * in place, busy and inert, so the focus the reader pressed it with stays on it.
 *
 * @param props See {@link RequestTableProps}.
 * @returns The node's rendering.
 */
export function RequestTable(props: RequestTableProps): ReactElement {
  const { node, className } = props;

  const actions = usePanelActions();

  // The event the panel has selected — the host's shared selection, or this
  // view's own last one when no host is mounted. An occurrence stands for it,
  // and so does the group row that holds that occurrence: both are marked.
  const { selection, markSelected } = useViewSelection();

  // Hoisted out of the callbacks below so their dependency lists name the one
  // member each of them uses, rather than the whole host object.
  const selectEvent = actions?.onSelectEvent;
  const reportExpand = actions?.onExpand;
  const reportFilter = actions?.onFilterChange;

  // The id of the note that explains an unavailable duplicates filter.
  const duplicatesNoteId = useId();

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

  const { status, data, error, announcement, total, nextOffset, retry } = useQuery(query);

  // The only offset "load more" may ever request: the service's own next
  // offset, and only when it moves forward from the page it answered. A
  // count-only query and a non-advancing echo both leave it `undefined`, so no
  // paging control is offered that could only re-request the same page.
  const forwardNextOffset = forwardNextOffsetOf(status, limit, active.offset, nextOffset);

  // A page that "load more" asked for is in flight behind groups already on
  // screen: groups were carried into this request, and it has not settled. The
  // paging control stays mounted for exactly this window (see the footer).
  const loadingMore = status === 'loading' && active.carried.length > 0;

  // A page that "load more" asked for failed behind groups already on screen.
  // Those groups stay drawn and the failure is reported for the page alone, as
  // every other paged view reports it; its retry re-requests that page, and
  // the carried groups are still in front of it when it lands.
  const nextPageFailed = status === 'error' && active.carried.length > 0;

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
  // as received; it never compares two rows. A view order then arranges what
  // the narrowing kept, by one figure per group (see `arrangeGroups`); the
  // service-ordered `loaded` sequence underneath is never re-ordered.
  const rows = useMemo(() => {
    const kept = active.duplicatesOnly ? loaded.filter((group) => group.hasDuplicates) : loaded;

    return active.viewOrder === null ? kept : arrangeGroups(kept, active.viewOrder);
  }, [active.duplicatesOnly, active.viewOrder, loaded]);

  const applySort = useCallback(
    (sort: DataQuerySort): void => {
      // A new ordering is a new result: the carried pages and the disclosure
      // set describe positions in the old one, so both are dropped and paging
      // restarts at the authored offset. Any view order is dropped with them —
      // the new result arrives in the order just asked for — and the reader has
      // now chosen an ordering, which keeps the grid mounted from here on.
      setView((current) => ({
        ...current,
        sort,
        offset: baseOffset,
        carried: EMPTY_GROUPS,
        carriedTotal: undefined,
        expanded: EMPTY_IDS,
        viewOrder: null,
        ordered: true,
      }));
      reportFilter?.(node.id, { sort, duplicatesOnly: String(active.duplicatesOnly) });
    },
    [active.duplicatesOnly, baseOffset, node.id, reportFilter],
  );

  const applyViewOrder = useCallback(
    (viewOrder: RequestOrder | null): void => {
      // Only the arrangement changes: the same groups stay loaded, nothing is
      // re-queried, and paging continues in the service's order.
      setView((current) => ({ ...current, viewOrder, ordered: true }));
      reportFilter?.(node.id, {
        sort: orderReportOf(active.sort, viewOrder),
        duplicatesOnly: String(active.duplicatesOnly),
      });
    },
    [active.duplicatesOnly, active.sort, node.id, reportFilter],
  );

  const handleSortSelect = useCallback(
    (next: string): void => {
      // The one value outside the contract's vocabulary is the view-order
      // option, which is either the value already shown or disabled: choosing
      // it asks for nothing. The narrowing is otherwise here because the select
      // speaks strings and the query speaks the vocabulary.
      if (!isDataQuerySort(next)) {
        return;
      }

      // The service ordering the loaded groups already arrived in: returning to
      // it from a view order restores their order without a re-query.
      if (next === active.sort) {
        if (active.viewOrder !== null) {
          applyViewOrder(null);
        }
        return;
      }

      applySort(next);
    },
    [active.sort, active.viewOrder, applySort, applyViewOrder],
  );

  const handleTableSortChange = useCallback(
    (next: DataTableSort): void => {
      const key = orderColumnKeyOf(next.key);

      // A key this table never rendered as a sortable column: nothing to order by.
      if (key === undefined) {
        return;
      }

      const requested: RequestOrder = { key, direction: next.direction };
      const serviceSort = serviceSortFor(requested);

      // An order the service cannot apply: arrange the loaded groups instead.
      // The grid always proposes a change, so an unchanged view order is
      // declined rather than reported twice.
      if (serviceSort === undefined) {
        if (!isSameOrder(active.viewOrder, requested)) {
          applyViewOrder(requested);
        }
        return;
      }

      // The service ordering already applied: the loaded groups are in that
      // order as they stand, so returning to it clears the view order without a
      // re-query, and with no view order in force nothing changes at all.
      if (serviceSort === active.sort) {
        if (active.viewOrder !== null) {
          applyViewOrder(null);
        }
        return;
      }

      applySort(serviceSort);
    },
    [active.sort, active.viewOrder, applySort, applyViewOrder],
  );

  const handleDuplicatesToggle = useCallback((): void => {
    const duplicatesOnly = !active.duplicatesOnly;

    setView({ ...active, duplicatesOnly });
    reportFilter?.(node.id, {
      sort: orderReportOf(active.sort, active.viewOrder),
      duplicatesOnly: String(duplicatesOnly),
    });
  }, [active, node.id, reportFilter]);

  const handleLoadMore = useCallback((): void => {
    // Only the forward offset the service reported is ever requested, exactly
    // as reported; an offset derived from the number of rows on screen would
    // drift the moment a limit was clamped. While the page it asked for is in
    // flight the control is still pressable — it stays enabled so it keeps
    // focus — and a press then asks for nothing, so no page is requested twice.
    if (loadingMore || forwardNextOffset === undefined) {
      return;
    }

    setView({ ...active, carried: loaded, carriedTotal: total, offset: forwardNextOffset });
  }, [active, forwardNextOffset, loaded, loadingMore, total]);

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
      // row is not, and never fabricates a coordinate to stand in: it selects
      // one of its own occurrences through this same handler.
      const ref: PanelEventRef = {
        eventId: occurrence.eventId,
        spanId: occurrence.spanId,
        traceId: occurrence.traceId,
      };

      // Recorded here only when no host is mounted (a no-op under one, whose
      // own record of the report below is what every view then marks).
      markSelected(ref);
      selectEvent?.(ref);
    },
    [markSelected, selectEvent],
  );

  const handleRowActivate = useCallback(
    (group: RequestGroup): void => {
      const representative = representativeOccurrenceOf(group);

      // Nothing to select: the aggregate carried no occurrence for this group.
      // Opening the detail says so, rather than leaving the activation silent.
      if (representative === undefined) {
        handleRowToggle(group);
        return;
      }

      handleOccurrenceSelect(representative);
    },
    [handleOccurrenceSelect, handleRowToggle],
  );

  // The loaded group that holds the panel's selected event, whichever view
  // selected it. Matched against the service-ordered `loaded` sequence, so the
  // mark stays on the same group whichever order arranges the rows, and passed
  // to the grid even when it is `null`: rows are selectable, so every row
  // reports `aria-selected`.
  const selectedRowKey = useMemo(() => selectedGroupKeyOf(loaded, selection), [loaded, selection]);

  // The group whose disclosure toggle a successful retry hands focus to.
  const retrySuccessorKey = retrySuccessorKeyOf(status, page, rows);

  const columns = useMemo<readonly DataTableColumn<RequestGroup>[]>(
    () => [
      {
        key: COLUMN_KEY_REQUEST,
        header: 'Request',
        // The identity column: a reader hears the row named by its method and
        // path as they move across it.
        rowHeader: true,
        width: COLUMN_WIDTHS.request,
        // The expanded state is the grid's to report and the toggle's to carry:
        // `aria-expanded` is not valid on a `grid` row, so the row states
        // nothing and the disclosure button below exposes `meta.expanded`, with
        // `aria-controls` naming the detail row while — and only while — the
        // grid has it in the document (see `DataTableCellMeta`).
        cell: (group, _rowIndex, meta) => {
          const { expanded, detailRowId } = meta;
          // Display only. The URL arrives redacted — query values replaced per
          // key, path retained — and is shown as it arrived, shortened for the
          // row with the full redacted value in the tooltip. Nothing here
          // parses, rewrites or reconstructs it.
          const displayUrl = oneLinePreview(group.url);

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
                aria-expanded={expanded}
                aria-controls={detailRowId}
                tabIndex={GRID_CONTROL_TAB_INDEX}
                onClick={() => {
                  handleRowToggle(group);
                }}
                // The row's first control, named by the request it opens: where
                // a successful retry hands focus when this is the first group
                // the settled page brought (see `retrySuccessorKeyOf`).
                {...(group.id === retrySuccessorKey
                  ? RETRY_SUCCESSOR_FOCUS_ATTRIBUTES
                  : NO_FOCUS_ATTRIBUTES)}
              />
              <Badge tone="neutral" variant="outline" className="dg-request-table__method">
                {group.method}
              </Badge>
              {/* Always a tooltip trigger. The column ellipsizes the URL with
                  CSS at whatever width the panel gives it, which no comparison
                  of strings can detect, so the full redacted value is always
                  one hover or one focus away. Focusable in every row but out
                  of the Tab order (see `GRID_CONTROL_TAB_INDEX`): the grid's
                  arrow keys reach it, and the body gains no stop per URL. */}
              <Tooltip content={group.url}>
                <Code className="dg-request-table__url" tabIndex={GRID_CONTROL_TAB_INDEX}>
                  {displayUrl}
                </Code>
              </Tooltip>
              <Tooltip content={GROUPING_NOTES[group.groupedBy]}>
                <Badge
                  tone={GROUPING_TONES[group.groupedBy]}
                  variant="soft"
                  tabIndex={GRID_CONTROL_TAB_INDEX}
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
        width: COLUMN_WIDTHS.status,
        cell: (group) => renderStatusCell(group),
      },
      // The three figure columns are sortable, each first-activated in the
      // direction its figure is read by — largest first — which for
      // Occurrences and Duration is the service's own ordering. The primitive
      // proposes the flip on a second activation; see `handleTableSortChange`.
      {
        key: COLUMN_KEY_COUNT,
        header: ORDER_COLUMN_HEADERS[COLUMN_KEY_COUNT],
        align: 'end',
        width: COLUMN_WIDTHS.count,
        sortable: true,
        defaultSortDirection: 'desc',
        cell: (group) => renderCountCell(group),
      },
      {
        key: COLUMN_KEY_DURATION,
        header: ORDER_COLUMN_HEADERS[COLUMN_KEY_DURATION],
        align: 'end',
        width: COLUMN_WIDTHS.duration,
        sortable: true,
        defaultSortDirection: 'desc',
        cell: (group) => renderDurationCell(group),
      },
      {
        key: COLUMN_KEY_TRANSFERRED,
        header: ORDER_COLUMN_HEADERS[COLUMN_KEY_TRANSFERRED],
        align: 'end',
        width: COLUMN_WIDTHS.transferred,
        sortable: true,
        defaultSortDirection: 'desc',
        cell: (group) => renderTransferredCell(group),
      },
      {
        key: COLUMN_KEY_INITIATORS,
        header: 'Initiated by',
        width: COLUMN_WIDTHS.initiators,
        cell: (group) => renderInitiatorsCell(group),
      },
    ],
    [handleRowToggle, retrySuccessorKey],
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
              // The occurrence carries its own id, trace and span, so it is
              // matched as it is, with no pointer built per row.
              matchesPanelSelection(selection, occurrence),
            ),
          )
        )}
      </Stack>
    ),
    [handleOccurrenceSelect, selectEvent, selection],
  );

  // The ordering select names the order on screen, as the header does: the
  // service ordering, or — while a header arranges the loaded groups — the
  // view-order option labelled with that arrangement.
  const selects = useMemo<readonly ToolbarSelect[]>(
    () => [
      {
        id: `${node.id}:sort`,
        label: SORT_CONTROL_LABEL,
        labelHidden: true,
        value: active.viewOrder === null ? active.sort : VIEW_ORDER_OPTION_VALUE,
        options: sortOptionsFor(active.viewOrder),
        onValueChange: handleSortSelect,
      },
    ],
    [active.sort, active.viewOrder, handleSortSelect, node.id],
  );

  // The local duplicates filter: a toggle, so it carries `aria-pressed` and the
  // design system's pressed state together, exactly as a toolbar action chip
  // does. It is composed here rather than declared as a `ToolbarAction`
  // because its unavailable state needs two things an action chip cannot
  // express: `aria-disabled` beside the native attribute, and a description
  // saying WHY it is unavailable. With no group loaded — while the first page
  // resolves, after it failed, or when the capture holds none — there is
  // nothing for it to filter, so it is disabled, and a visible note beside it,
  // which the control names as its description, says so rather than leaving a
  // dimmed control to be guessed at.
  const duplicatesUnavailable = loaded.length === 0;
  const duplicatesToggle = (
    <>
      <Button
        variant="ghost"
        size="sm"
        icon={<Copy className="dg-icon" />}
        className={active.duplicatesOnly ? 'dg-is-active' : undefined}
        aria-pressed={active.duplicatesOnly}
        disabled={duplicatesUnavailable}
        aria-disabled={duplicatesUnavailable ? true : undefined}
        aria-describedby={duplicatesUnavailable ? duplicatesNoteId : undefined}
        onClick={handleDuplicatesToggle}
      >
        {DUPLICATES_ONLY_LABEL}
      </Button>
      {duplicatesUnavailable ? (
        <Text as="span" size="xs" tone="muted" id={duplicatesNoteId}>
          {DUPLICATES_UNAVAILABLE_NOTE}
        </Text>
      ) : null}
    </>
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
  // While a further page is in flight, or after it failed, the hook reports no
  // total, so the footer keeps the total of the pages on screen: the coverage
  // it states does not change until a page lands.
  const footerTotal = total ?? (loadingMore || nextPageFailed ? active.carriedTotal : undefined);

  // Every group the query matched is loaded: the service reported a total, the
  // node starts at the first item, the loaded groups reach that total, and no
  // further page is offered or in flight. Only then does a view order cover the
  // whole result; anything less and the footer says what the order covers.
  const wholeResultLoaded =
    footerTotal !== undefined &&
    baseOffset === DATA_QUERY_DEFAULT_OFFSET &&
    loaded.length >= footerTotal &&
    forwardNextOffset === undefined &&
    !loadingMore;

  const footerNote = useMemo(() => {
    const sentences = [
      footerTotal === undefined
        ? `${GROUPS_LOADED_LABEL} ${formatCount(loaded.length)}.`
        : `${GROUPS_LOADED_LABEL} ${formatCount(loaded.length)} of ${formatCount(footerTotal)}.`,
    ];

    if (active.duplicatesOnly) {
      sentences.push(
        `${DUPLICATES_MATCHED_LABEL} ${formatCount(rows.length)} of ${formatCount(loaded.length)}.`,
        DUPLICATES_ONLY_SCOPE_NOTE,
      );
    }

    if (active.viewOrder !== null && loaded.length > 0 && !wholeResultLoaded) {
      sentences.push(describeViewOrderScope(loaded.length));
    }

    return sentences.join(' ');
  }, [
    active.duplicatesOnly,
    active.viewOrder,
    footerTotal,
    loaded.length,
    rows.length,
    wholeResultLoaded,
  ]);

  // What an empty settled page says. An empty page is not necessarily an empty
  // capture, so the copy names the absence the query and the reported counters
  // describe; it is drawn only when no group was loaded.
  const emptyCopy = useMemo(
    () =>
      describeEmptyPage({
        limit,
        offset: active.offset,
        total,
        hasNextPage: forwardNextOffset !== undefined,
      }),
    [active.offset, forwardNextOffset, limit, total],
  );

  // The coverage note and, for a forward next page the service reported, the
  // paging control. Built once so a populated page and an empty page that the
  // service says is followed by more draw the same control.
  const footer = (
    <Stack
      direction="horizontal"
      gap={2}
      align="center"
      justify="between"
      wrap
      className="dg-request-table__footer"
    >
      {/* A polite live region: the counts change without focus moving — a
          page appended by "load more", the duplicates filter narrowing the
          loaded groups — and a screen reader hears the new totals once the
          reader is idle rather than having to go looking for them. It holds
          text only, never a control, so an update re-announces nothing
          interactive. */}
      <Text size="xs" tone="muted" aria-live="polite" aria-atomic="true">
        {footerNote}
      </Text>
      {/* Kept mounted, as the same element, while the page it asked for is in
          flight: a focused control that leaves the document, or turns
          `disabled`, hands focus to `<body>`. So it is never disabled; it
          reports the flight through `aria-busy` and its label, and a press
          meanwhile is a no-op (see `handleLoadMore`). When the page lands it
          stays for a further page, or leaves after the last one. */}
      {forwardNextOffset === undefined && !loadingMore ? null : (
        <Button
          variant="secondary"
          size="sm"
          aria-busy={loadingMore}
          onClick={handleLoadMore}
          {...LOAD_MORE_FOCUS_ATTRIBUTES}
        >
          {loadingMore ? LOAD_MORE_BUSY_LABEL : LOAD_MORE_LABEL}
        </Button>
      )}
    </Stack>
  );

  // The toolbar is omitted over one state only: the settled empty capture —
  // the page succeeded, no group is loaded, the service named no forward page
  // and the copy is the nothing-captured one — with the reader's duplicates-only
  // narrowing off. Its order control would reorder nothing and its toggle has
  // nothing to filter, so it would be a row of controls that cannot act. It
  // stays while a page is in flight or failed, so a re-query raised from it
  // never removes it; whenever the reader's own narrowing is in force, so that
  // narrowing can be undone where it was made; and once the reader has chosen
  // an ordering, so the select they used is never taken from under them.
  const toolbarShown = !(
    status === 'success' &&
    loaded.length === 0 &&
    forwardNextOffset === undefined &&
    !active.duplicatesOnly &&
    !active.ordered &&
    emptyCopy === NOTHING_CAPTURED_COPY
  );

  // What stands in for the groups while none is loaded, in the library's
  // precedence: the first page resolving, a failure of the view's own query,
  // or a page that settled empty. `undefined` once a group is loaded.
  let inPlaceOfRows: ReactElement | undefined;

  if (loaded.length === 0) {
    if (status === 'loading') {
      inPlaceOfRows = (
        <LoadingState variant="rows" label={LOADING_LABEL} className="dg-request-table__loading" />
      );
    } else if (status === 'error') {
      // The package's one failure contract: title, the generic lead plus the
      // provider's own cause, its hint and code, the query as `formatDataQuery`
      // prints it, the settled announcement and the retry. With nothing carried
      // this failure stands for the whole body, so it is the view's own; a
      // failed further page is reported below its groups instead.
      inPlaceOfRows = (
        <ErrorState
          {...queryFailureProps({ error, announcement, retry }, query)}
          className="dg-request-table__error"
        />
      );
    } else {
      // A page that settled successfully with nothing carried before it.
      inPlaceOfRows = (
        <EmptyState
          title={emptyCopy.title}
          message={emptyCopy.message}
          icon={emptyCopy === NOTHING_CAPTURED_COPY ? <Globe className="dg-icon" /> : undefined}
          className="dg-request-table__empty"
        />
      );
    }
  }

  // Where that state is drawn. Before the reader has chosen an ordering it
  // replaces the grid, as on first load. Once they have, a re-query empties the
  // loaded groups, and replacing the grid then would unmount the very header
  // control they activated and drop their focus out of the view; so from then
  // on the grid stays mounted, as the same element, with the state in its
  // empty slot — outside its rows, where `DataTable` places it — and the new
  // order already on the header's indicator.
  const showGrid = loaded.length > 0 || active.ordered;

  // A forward next page keeps its control reachable even from an empty page,
  // instead of stranding the reader on a page the service says is followed by
  // more.
  const footerShown = loaded.length > 0 || forwardNextOffset !== undefined;

  let body: ReactNode;

  if (!showGrid) {
    body = (
      <>
        {inPlaceOfRows}
        {footerShown ? footer : null}
      </>
    );
  } else {
    body = (
      <>
        {/* `virtualize` is deliberately omitted: the grid renders a page of
            groups whole and windows a large one on its own policy, and a
            request table's rows vary in height (an expanded detail row),
            which is exactly the case its automatic policy is tuned for. */}
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(group) => group.id}
          caption={node.title ?? CATALOG_ENTRY.label}
          compact
          sort={active.viewOrder ?? TABLE_SORTS[active.sort]}
          onSortChange={handleTableSortChange}
          selectedRowKey={selectedRowKey}
          onRowActivate={handleRowActivate}
          expandedRowKeys={active.expanded}
          onRowToggle={handleRowToggle}
          renderExpandedRow={renderExpandedRow}
          // With groups loaded, reached only when the local filter excluded
          // every one of them, so it says that rather than claiming the
          // capture held no requests; with none loaded, the state above.
          empty={inPlaceOfRows ?? <EmptyState message={FILTERED_EMPTY_MESSAGE} />}
        />
        {footerShown ? footer : null}
        {/* The same contract in the page scope: its title and lead say only the
            next page failed and the groups above are unaffected, and its query
            is that page's, advanced offset and all. */}
        {nextPageFailed ? (
          <ErrorState
            {...queryFailureProps({ error, announcement, retry }, query, { scope: 'page' })}
            className="dg-request-table__error"
          />
        ) : null}
      </>
    );
  }

  return (
    <div className={clsx('dg-request-table', className)}>
      {toolbarShown ? (
        <Toolbar
          label={TOOLBAR_LABEL}
          className="dg-request-table__toolbar"
          compact
          wrap
          selects={selects}
          status={groupingStatuses}
        >
          {duplicatesToggle}
        </Toolbar>
      ) : null}
      {body}
    </div>
  );
}
