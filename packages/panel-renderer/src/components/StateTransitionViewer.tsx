/**
 * `StateTransitionViewer` — the `stateTransitions` node of the panel catalog.
 *
 * Each row is one observed transition read old → trigger → new: the component,
 * the hook index or label, the value summary before, the triggering event and
 * the value summary after, with the trigger linking to its event. The columns
 * are that sequence read left to right.
 *
 * It belongs to the distinctive set of the excessive-render panel beside the
 * render table, the component tree and the dependency graph: those four are
 * why a panel answering "why is this updating so often" is a materially
 * different panel from one answering "why was this slow", which
 * `tests/e2e/demo-excessive-renders.spec.ts` asserts by comparing the node-type
 * sets of the two.
 *
 * ## The values are opaque strings, and that is the design
 *
 * `previousValue` and `nextValue` arrive **already scrubbed and already
 * bounded** by the producer: it captures hook state as a category plus a
 * preview of at most 120 code points, passed through the credential patterns
 * first, and no opt-in for full values exists (see `docs/SECURITY.md`,
 * "Never captured"). So this file treats a summary as text and nothing else.
 * Nothing here parses one, expands one, re-serialises one, compares two of
 * them, or offers a control that would show "the rest" — there is no rest to
 * show, and a viewer that behaved as though there were would be inventing the
 * one thing the capture deliberately never took. Shortening for display goes
 * through `../utils/format`'s {@link oneLinePreview}, whose default budget
 * *is* that 120-code-point bound, so the renderer can never present more than
 * the producer was allowed to capture.
 *
 * A table cell is narrower than most summaries, so a cell clips its summary to
 * its own track with an ellipsis rather than letting it paint across the next
 * column. Clipping hides nothing the view does not show elsewhere: a summary
 * shown whole carries its own displayed text as its `title`, and a row's
 * expanded detail repeats both displayed summaries unclipped, wrapped across as
 * many lines as they need. Both repeat exactly the string the row displays —
 * the bounded preview, never the received string when that was longer.
 *
 * ## `changed` is reported, and `false` does not mean "no change"
 *
 * `@debuggen/telemetry`'s aggregate is explicit about this: a producer emits a
 * `state` record for a hook it observed changing, and `changed` says whether
 * that record arrived with something showable — `true` when at least one value
 * summary was readable, `false` when neither was. It is never computed by
 * comparing the two previews, because two values that differ only past the
 * truncation bound have identical previews. This file therefore labels a
 * `false` row as *no values reported* and never as *unchanged*: the render
 * trigger vocabulary keeps `unchanged` and `unknown` apart on purpose (see
 * `docs/ARCHITECTURE.md`, "Computed metrics"), and folding "we could not
 * describe it" into "it did not change" would be exactly the false claim that
 * separation exists to prevent.
 *
 * The same rule covers the aggregate's **truncation sentinel** — a row carrying
 * `truncated` with no transition source and no previews. It is a disclosure
 * that transitions were dropped by a capture bound, so it is drawn as one, with
 * its own chip and its reported count, and never as a value transition.
 *
 * ## Which fields are read, and where that list comes from
 *
 * The catalog entry is the authority:
 * `catalogEntryFor('stateTransitions').reads` requires the span identity
 * fields, `kind`, `name`, `startTime` and the canonical-order fields
 * (`producerId`, `seq`, `ingestSeq`), and reads when present `parentSpanId`,
 * `source`, the lineage keys and the attribute keys of the `state` kind — no
 * duration or tier — `component`, `hookIndex`, `hookLabel`, `previousValue`,
 * `nextValue`, `triggerEventId`, `triggerSpanId`, `transitionSource`,
 * `renderSpanId`, `fiberId`, `truncated`, `droppedTransitions`. Every field
 * this component displays is drawn from that list or is one of the aggregate's
 * two derived row fields (`changed`, `valueType`), and the entry is imported
 * rather than restated so a change to the catalog reaches this file.
 *
 * ## Paging follows the provider's `nextOffset` and appends stable pages
 *
 * `../host/useQuery` resolves **one** page per request. "Load more" requests the
 * next page at exactly the offset the previous response reported as its
 * `nextOffset` — never an offset counted from a page's length and never one
 * inferred from `total` — with the same `limit` on every request of the
 * sequence: the authored page size, clamped into `[0, DATA_QUERY_MAX_LIMIT]`,
 * or `DATA_QUERY_DEFAULT_LIMIT` when the node authored none. That constant
 * bounds **one request**, not how far a reader can go: nothing here caps the
 * rows a sequence can reach, so a capture of any size is traversable page by
 * page, including every offset past 5 000. A response that reports no
 * `nextOffset`, or one that does not move past the page it answered, is the end
 * of the data, and the footer then offers no control.
 *
 * An authored `limit` of `0` is kept as `0`. The query schema makes it an
 * explicit request for a total without rows, so it is sent exactly as authored,
 * answered by a **count-only** empty state that states the reported total, and
 * never paged: a zero-row page cannot move a sequence forward, so no "Load more"
 * is offered for it whatever `nextOffset` the provider echoes, and no second
 * request is made.
 *
 * ## An empty page is not always an empty capture
 *
 * A page with no rows says different things depending on what was asked and
 * what the provider reported, and the empty state says the one that is true
 * (see {@link emptyPageCopy}): a count-only request states its total; a
 * reported total of zero — or no total, on a first page with no page after it
 * — is the nothing-captured answer; a page that starts past the end of a
 * positive total says where it starts and how many matched; a positive total
 * with nothing on this page says so; and any other page with no total says
 * where it starts and claims nothing about the rest. When rows were loaded and
 * the reader's own "changed only" narrowing hid all of them, the empty state
 * says that instead.
 *
 * Pages already received are kept exactly as they arrived and the next one is
 * appended after them, de-duplicated by the grid's row key (first occurrence
 * kept), so the provider's order holds across pages and nothing already on
 * screen is requested or rebuilt again. While a next page is in flight the
 * loaded rows stay on screen and the footer reports the load; when one fails
 * the rows stay and the footer carries the error and its retry. The local
 * derivations — the "changed only" narrowing, the grouping and the component
 * options — run over every row loaded so far.
 *
 * The accumulated pages belong to one request sequence: the node, its source,
 * the filter including the reader's component narrowing, the applied order and
 * the page size, but not the offset, which is the one thing that moves along a
 * sequence. A new order or a new component narrowing is a new sequence and
 * starts again from the node's first page.
 *
 * The accumulator is written only from the "Load more" handler — at the moment
 * of the click the rows on screen and the next offset are both in hand — and
 * cleared only by the handlers that start a new sequence, so nothing is written
 * when data arrives and the React Compiler rules the repository lints with
 * (`react-hooks/set-state-in-effect`) have nothing to forbid. All local state
 * here is written from an event handler, and it is reset by *derivation* —
 * every value is stamped with the identity it was taken against and a stamp
 * that no longer matches is ignored — so no effect exists to reset it either.
 *
 * ## One Tab stop, and every control and explanation reached by arrow keys
 *
 * The grid is ONE stop in the page's Tab order — `DataTable`'s active row — and
 * Tab from it leaves the grid (the APG grid pattern). Every focusable element a
 * cell or the expanded detail renders is therefore `tabIndex={-1}`: the
 * disclosure toggle, the trigger control, both source chips (through
 * `SourceLink`'s `tabIndex` prop) and the four tooltip triggers — the bound
 * behind a shortened summary, why a trigger cannot be opened, what "no values
 * reported" does and does not claim, and what a dropped-transitions count is a
 * floor of. Those triggers are text, code and chip elements, which are not
 * focusable of their own accord; `-1` makes them focusable without adding a
 * stop, so a table of a few hundred rows is still one press of Tab to cross.
 *
 * `DataTable` owns the route to them, and this view adds no key or focus
 * handler of its own: ArrowRight on a collapsed row opens its detail and the
 * next ArrowRight enters the row (F2 enters directly, since Enter selects the
 * row); ArrowLeft/ArrowRight then walk the controls of the row and its open
 * detail in document order, Home/End jump to the first/last of them,
 * ArrowUp/ArrowDown move to the neighbouring row, and Escape returns to the
 * row. `../primitives/Tooltip` opens on any focus, so an arrow key landing on a
 * trigger shows its explanation exactly as a Tab would, and the first Escape
 * closes that bubble before the second returns to the row. Focus that lands on
 * a control by any route, a pointer click included, moves the grid's roving
 * stop to that control's row. Each trigger keeps the `aria-describedby` the
 * tooltip merges onto it, and none sits in a column header.
 *
 * ## What it never does
 *
 * No sorting, filtering or paging arithmetic on a resolved page beyond the one
 * local narrowing the toolbar declares (see the "changed only" toggle, whose
 * scope the footer states) and the removal of a row a later page repeats (see
 * `appendPage`). Ordering is the service's: it applies `filter`, `sort`,
 * `limit` and `offset` where the whole capture is (see `docs/ARCHITECTURE.md`,
 * "Panel data"), and a sort here is a **re-query** mapped onto that
 * vocabulary. No transport either — no `fetch`, no socket, no message port:
 * data arrives through the `DataProvider` interface and interactions leave
 * through `PanelActions` (see `docs/ARCHITECTURE.md`,
 * "The renderer contract"). And no application vocabulary: every name on
 * screen comes from the data.
 *
 * ## Class-name contract
 *
 * Implemented by `../styles/components.css`, which is the defining side. This
 * file contributes class names and no visual value; the only `style` attribute
 * it emits anywhere is none at all.
 *
 * | Class                              | Role                                     |
 * | ---------------------------------- | ---------------------------------------- |
 * | `dg-state-transitions`             | block                                    |
 * | `dg-state-transitions__toolbar`    | element: the filter row                  |
 * | `dg-state-transitions__component`  | element: the row-header cell             |
 * | `dg-state-transitions__hook`       | element: the hook identity cell          |
 * | `dg-state-transitions__previous`   | element: the value-before cell           |
 * | `dg-state-transitions__next`       | element: the value-after cell            |
 * | `dg-state-transitions__trigger`    | element: the trigger control or label    |
 * | `dg-state-transitions__changed`    | element: the reported-state cell         |
 * | `dg-state-transitions__footer`     | element: the paging and scope footer     |
 * | `dg-state-transitions__from`       | companion of `__previous` in the sheet   |
 * | `dg-state-transitions__to`         | companion of `__next` in the sheet       |
 * | `dg-state-transitions__arrow`      | element: the direction glyph             |
 * | `dg-state-transitions__value`      | element: one value summary               |
 * | `dg-state-transitions__detail`     | element: one expanded row's detail       |
 * | `dg-state-transitions__empty`      | element: the empty state                 |
 * | `dg-state-transitions__loading`    | element: the loading state               |
 * | `dg-state-transitions__error`      | element: the error state                 |
 * | `dg-is-changed` / `dg-is-unchanged`| state: whether values were reported      |
 * | `dg-is-truncated`                  | state: a summary shortened for display   |
 *
 * Two of those names are pairs on purpose. The stylesheet spells the
 * value cells `__from`/`__to` while this node's contract spells them
 * `__previous`/`__next`; both are emitted on the same element, so the sheet's
 * existing rules apply and the contract's names are present for a consumer that
 * addresses them. The row's selected state is not written here at all —
 * `DataTable` owns `dg-is-selected` on the row it was told is selected — and
 * which row that is comes from the panel's shared selection, so a record
 * selected in any view or evidence chip marks its transition here, and a
 * transition activated here marks its record everywhere else.
 *
 * @see ../host/useQuery for the one-page-at-a-time resolution contract and the
 * `nextOffset` every "Load more" advances to.
 * @see ../host/PanelActions for the interaction contract.
 * @see ../primitives/DataTable for the ARIA grid, keyboard operation and
 * virtualization this view does not re-implement.
 */

import type { DataQuery, DataQuerySort, StateTransitionsNode } from '@debuggen/panel-schema';
import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
  catalogEntryFor,
  isDataQuerySort,
} from '@debuggen/panel-schema';
import type { SourceLocation } from '@debuggen/shared';
import type { StateTransition } from '@debuggen/telemetry';
import { clsx } from 'clsx';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  GitCompareArrows,
  Scissors,
  Zap,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { useDataProvider } from '../host/DataProvider';
import type { DataProvider } from '../host/DataProvider';
import { matchesPanelSelection, usePanelActions, useViewSelection } from '../host/PanelActions';
import type { PanelEventRef, PanelSelection } from '../host/PanelActions';
import { queryFailureProps, unsupportedQueryProps, useQuery } from '../host/useQuery';
import type { QueryFailureProps } from '../host/useQuery';
import { Stack } from '../layout/Stack';
import type { StackAlign } from '../layout/Stack';
import { Toolbar } from '../layout/Toolbar';
import type { ToolbarAction, ToolbarSelect, ToolbarStatus } from '../layout/Toolbar';
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
import { Tooltip } from '../primitives/Tooltip';
import { kindColorVar } from '../utils/color';
import {
  NOT_AVAILABLE_LABEL,
  formatCount,
  formatKindLabel,
  formatUntrustedText,
  humanizeLabel,
  oneLinePreview,
} from '../utils/format';
import { SourceLink } from './SourceLink';

/*
 * ---------------------------------------------------------------------------
 * The node's own vocabulary
 * ---------------------------------------------------------------------------
 */

/**
 * The one query source this node may read.
 *
 * `catalogEntryFor('stateTransitions').sources` lists exactly this member, and
 * the literal is written here so the compiler can narrow a node's declared
 * source to it — a `DataQuerySource`-typed field cannot be handed to the
 * generic hook as `'stateTransitions'` without that comparison. A node whose
 * query names anything else is reported rather than coerced; see
 * {@link StateTransitionViewer}.
 */
const STATE_TRANSITIONS_SOURCE = 'stateTransitions' as const;

/**
 * A request this view issues: a data query naming the one source it reads.
 *
 * The literal source is what lets `useQuery` type the response as this
 * source's rows rather than as the union over every source.
 */
type StateTransitionsQuery = DataQuery & { source: typeof STATE_TRANSITIONS_SOURCE };

/**
 * The order a transition sequence reads in when no other is asked for.
 *
 * Chronological, because a sequence of state changes is a narrative: the value
 * a hook held, what moved it, and what it holds now only make sense in the
 * order they happened. Ordering belongs to the side that holds the whole
 * capture, so this is the value put on the query, never a local sort.
 */
const DEFAULT_SORT: DataQuerySort = 'start_asc';

/**
 * The sort orders offered, in the order they are offered.
 *
 * Two of the vocabulary's three: `count_desc` ranks *groups* by how many
 * members they have, and this source is not grouped — every row is one observed
 * transition — so offering it would be offering a control that cannot change
 * what is drawn. A node that nonetheless carries it is still displayed
 * faithfully: {@link sortOptionsFor} appends whatever sort the node asked for
 * when it is not already in this list, so the control can never show an order
 * other than the one in force.
 */
const OFFERED_SORTS: readonly DataQuerySort[] = [DEFAULT_SORT, 'duration_desc'];

/**
 * Every sort's label, total over the vocabulary.
 *
 * A `Record` keyed by the closed union rather than an interpolated string: a
 * sort added upstream fails to compile here until it is given wording, which is
 * the point of writing the table out.
 */
const SORT_LABELS: Readonly<Record<DataQuerySort, string>> = {
  start_asc: 'Chronological',
  duration_desc: 'Longest first',
  count_desc: 'Most occurrences',
};

/**
 * The value of the component filter's "everything" option.
 *
 * The empty string cannot collide with a component name, because a name that
 * would produce it is absent from the data rather than blank — the aggregate
 * omits `component` when the producer could not name one, and this file renders
 * that case through its own label instead of as an empty filter value.
 */
const ALL_COMPONENTS = '';

/*
 * ---------------------------------------------------------------------------
 * Copy
 *
 * Product wording only: not one of these strings names a component, a hook, a
 * route or anything else belonging to the application under investigation.
 * Every name on screen arrives in the data.
 * ---------------------------------------------------------------------------
 */

/** The accessible name of the grid when the node carries no title of its own. */
const CATALOG_LABEL = catalogEntryFor(STATE_TRANSITIONS_SOURCE).label;

/** What the empty state says: a real answer, not a failure. */
const EMPTY_MESSAGE = 'No state transitions were captured for this interaction.';

/** The short label above {@link EMPTY_MESSAGE}. */
const EMPTY_TITLE = 'No transitions';

/** What the empty state says when the reader's own narrowing is what emptied it. */
const EMPTY_FILTERED_MESSAGE =
  'No transitions in this page match the current filters. Clear them to see the rest of the page.';

/** The empty state's title for a count-only request, whose answer is a number and no rows. */
const COUNT_ONLY_TITLE = 'Count only';

/** What a count-only request's empty state says when the provider reported no total. */
const COUNT_ONLY_UNKNOWN_MESSAGE =
  'This view requests a count without rows, and no total was reported for its query.';

/** The empty state's title for a page that holds no rows while the result may hold some. */
const EMPTY_PAGE_TITLE = 'Nothing on this page';

/** What this view counts, once, for the sentences that state a number of them. */
const NOUN_SINGULAR = 'state transition';

/** The same, for any count other than one. */
const NOUN_PLURAL = 'state transitions';

/** The loading state's accessible label. */
const LOADING_LABEL = 'Loading state transitions…';

/** Column headers, left to right — the "old → trigger → new" reading order. */
const HEADERS = {
  component: 'Component',
  hook: 'Hook',
  previous: 'Value before',
  trigger: 'Trigger',
  next: 'Value after',
  changed: 'Reported',
} as const;

/** The chip on a row whose producer described the transition it observed. */
const CHANGED_LABEL = 'Changed';

/** The chip on a row whose producer reported no readable summary for either side. */
const UNREPORTED_LABEL = 'No values reported';

/** Why such a row exists, said in full where there is room to say it. */
const UNREPORTED_HINT =
  'The producer recorded this change but could describe neither value, so nothing is shown for either side. This is not a statement that the value stayed the same.';

/**
 * What a shortened summary's tooltip says.
 *
 * It explains the bound rather than offering the rest, because there is no rest
 * in this process: the producer captures only a bounded, redacted preview and
 * no opt-in for a full value exists, so a control promising one would promise
 * something the whole product deliberately cannot deliver.
 */
const VALUE_SHORTENED_HINT =
  'The capture keeps a bounded summary of this value rather than the value itself, and it is shown shortened to fit.';

/** The chip on a row disclosing that a capture bound dropped transitions. */
const TRUNCATED_LABEL = 'Transitions dropped';

/** What that disclosure means, and what its count is a floor of. */
const TRUNCATED_HINT =
  'The capture disclosed that a bound cut this transition list, so it is incomplete. Any count shown is what had been dropped when the disclosure was emitted, not a total.';

/** The trigger cell when no event can be linked to. */
const TRIGGER_UNDETERMINED_LABEL = 'Undetermined';

/** Why the trigger cell can read that way, kept apart from any inference about a cause. */
const TRIGGER_UNDETERMINED_HINT =
  'The capture did not attribute this transition to a record that can be opened. Nothing is claimed about what caused it.';

/** The trigger label when the record is known but lies outside this page. */
const TRIGGER_OUT_OF_SLICE_HINT =
  'The record this transition is attributed to is outside the page loaded here, so it cannot be opened from this row.';

/** The trigger control's label when the attributed record carries neither name nor kind. */
const TRIGGER_GENERIC_LABEL = 'Triggering record';

/**
 * The action of the expand affordance, which discloses one row's detail.
 *
 * Never a name on its own: {@link detailToggleLabel} completes it with the
 * row's identity, so a reader listing the grid's controls hears which
 * transition each toggle opens rather than the same phrase once per row.
 */
const DETAIL_SHOW_LABEL = 'Show details of';

/** The collapse action of the same affordance, completed the same way. */
const DETAIL_HIDE_LABEL = 'Hide details of';

/**
 * Field captions inside an expanded row.
 *
 * The row's identity and its two summaries come first, under the same words
 * as their column headers, because a cell clips what the detail has room to
 * show whole: the component and hook names, and each summary exactly as the
 * row displays it — the bounded preview, never more than the row was given.
 * Then the categories and identifiers the columns have no room for at all.
 */
const DETAIL_LABELS = {
  component: HEADERS.component,
  hook: HEADERS.hook,
  previousValue: HEADERS.previous,
  nextValue: HEADERS.next,
  valueType: 'Value type',
  transitionSource: 'Changed dimension',
  triggerKind: 'Trigger kind',
  eventId: 'Record id',
  spanId: 'Span id',
  traceId: 'Trace id',
  triggerSpanId: 'Trigger span id',
  renderSpanId: 'Render span id',
  fiberId: 'Instance id',
  droppedTransitions: 'Dropped transitions reported',
  source: 'Source location',
} as const;

/** The toolbar's accessible name, which makes it a labelled group. */
const TOOLBAR_LABEL = 'State transition filters';

/**
 * The sort control's label: visible, and the control's accessible name.
 *
 * It names what it orders because a panel places several tables side by side,
 * each with an order control of its own, and a reader who lists a page's form
 * controls — or asks speech input for one by name — must be able to tell them
 * apart. The visible text is the whole name, so what is on screen is what can
 * be said (WCAG 2.5.3).
 */
const SORT_LABEL = 'Order state transitions';

/** The component filter's label, and the wording of its "everything" option. */
const COMPONENT_FILTER_LABEL = 'Component';

/** The option that clears the component filter. */
const ALL_COMPONENTS_LABEL = 'All components';

/** The option shown for rows whose producer could not name a component. */
const UNNAMED_COMPONENT_LABEL = 'Component not named';

/** The "changed only" toggle's label. */
const CHANGED_ONLY_LABEL = 'Changed only';

/** The grouping toggle's label. */
const GROUP_LABEL = 'Group by component';

/** The scope note shown while the "changed only" toggle narrows the loaded page. */
const CHANGED_ONLY_SCOPE_NOTE =
  'The “changed only” filter applies to the rows loaded here, not to the whole capture.';

/** The scope note shown while rows are grouped rather than left in the capture's order. */
const GROUPED_SCOPE_NOTE =
  'Rows are grouped by component; within each component they keep the order the capture returned.';

/** The footer's control that requests the next page of the sequence. */
const LOAD_MORE_LABEL = 'Load more';

/** The same control while that page is in flight, when it cannot be pressed again. */
const LOADING_MORE_LABEL = 'Loading more…';

/*
 * ---------------------------------------------------------------------------
 * Pure helpers
 *
 * All module-private, all total, and none of them touches a value summary
 * beyond handing it to the shared preview formatter.
 * ---------------------------------------------------------------------------
 */

/** The empty page, allocated once so an unresolved render keeps a stable identity. */
const NO_TRANSITIONS: readonly StateTransition[] = Object.freeze([]);

/** No rows expanded, allocated once for the same reason. */
const NO_KEYS: readonly string[] = Object.freeze([]);

/**
 * Clamp an authored page size into the contract's per-request bounds.
 *
 * The query schema bounds one request's `limit` at `[0, DATA_QUERY_MAX_LIMIT]`,
 * and an omitted one defaults to `DATA_QUERY_DEFAULT_LIMIT`. The maximum is a
 * bound on a single page and never on how many rows "Load more" can reach: the
 * result is sent unchanged with every page of a sequence, and the sequence
 * itself goes as far as the provider's `nextOffset` does.
 *
 * Zero is preserved exactly. It is an explicit request for a total without
 * rows, which a node may legitimately make, and the absence of the field is the
 * only thing that means "unset" — so `0` is sent as `limit: 0` and answered by
 * the count-only empty state, and {@link advancedOffset} never pages it, since
 * a zero-row page cannot move a sequence forward. A value that is not finite
 * (which a validated node cannot carry, but a stored one read without
 * validation could) falls back to the default; a fractional one is truncated
 * toward zero; anything outside the bounds is pulled to the nearer bound.
 *
 * @example
 * ```ts
 * clampPageLimit(undefined); // DATA_QUERY_DEFAULT_LIMIT (200)
 * clampPageLimit(0); //         0 — count only, never paged
 * clampPageLimit(9000); //      DATA_QUERY_MAX_LIMIT (5 000)
 * ```
 *
 * @param limit The `limit` the node authored, or `undefined` when it authored none.
 * @returns A page size within `[0, DATA_QUERY_MAX_LIMIT]`.
 */
function clampPageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DATA_QUERY_DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 0), DATA_QUERY_MAX_LIMIT);
}

/**
 * The offset of the page after the one that resolved, or `undefined` at the end
 * of the data.
 *
 * The provider's `nextOffset` is the only thing that moves a sequence on:
 * `../host/useQuery` documents that an offset counted from a page's length
 * drifts the moment a limit is clamped, and a `total` says how much exists, not
 * where the next page starts. Four answers therefore end the sequence:
 *
 * - a page size of `0` — a count-only request asks for no rows on any page, so
 *   a next page would be another request for nothing, whatever `nextOffset`
 *   the provider echoes for it;
 * - no `nextOffset` at all (`undefined`, or a transport's `null`) — the provider
 *   said this page is the last one;
 * - one that is not a non-negative safe integer — no query could carry it, since
 *   the schema's `offset` is exactly such an integer;
 * - one that does not move past the page it answered — equal to or behind its
 *   offset — because requesting it would ask again for rows already on screen,
 *   and a provider that kept answering so would loop "Load more" forever.
 *
 * Deliberately no upper bound: `DATA_QUERY_MAX_LIMIT` caps one request, and an
 * offset of 5 000 or beyond is as legitimate as the first page.
 *
 * @param nextOffset What the resolved page reported.
 * @param offset The offset that page was requested at.
 * @param limit The page size every request of the sequence carries.
 * @returns The next page's offset, or `undefined` when there is none.
 */
function advancedOffset(
  nextOffset: number | undefined,
  offset: number,
  limit: number,
): number | undefined {
  if (
    limit <= 0 ||
    nextOffset === undefined ||
    !Number.isSafeInteger(nextOffset) ||
    nextOffset <= offset
  ) {
    return undefined;
  }

  return nextOffset;
}

/**
 * What an empty page's request and response establish, which decides the
 * sentence its empty state may truthfully say (see {@link emptyPageCopy}).
 */
interface EmptyPageContext {
  /** The page size every request of the sequence carries; `0` is count-only. */
  readonly limit: number;
  /** The offset the empty page was requested at. */
  readonly offset: number;
  /** The total the provider reported for the query, or `undefined` when it reported none. */
  readonly total: number | undefined;
  /** Whether the reader's narrowing — the component choice or "changed only" — is in force. */
  readonly narrowed: boolean;
  /** Whether the provider reported a next page past this one, so "Load more" is offered. */
  readonly morePages: boolean;
}

/** The title and sentence of one empty state. */
interface EmptyPageCopy {
  /** A short label above the sentence, or `undefined` when the sentence stands alone. */
  readonly title: string | undefined;
  /** The sentence itself. */
  readonly message: string;
}

/**
 * The copy of the empty capture: case 2 of {@link emptyPageCopy} with no
 * narrowing of the reader's in force, the one empty page that says nothing was
 * captured. A single frozen value, so the component recognises the case by
 * reference — it is the one empty state that carries the view's glyph, and the
 * one drawn without the toolbar and the footer, since no control could reach
 * anything and there is no count to state beyond the sentence itself.
 */
const NOTHING_CAPTURED_COPY: EmptyPageCopy = Object.freeze({
  title: EMPTY_TITLE,
  message: EMPTY_MESSAGE,
});

/**
 * The noun for a count of state transitions: singular for exactly one.
 *
 * @param count The count the noun follows.
 * @returns The noun, in the number the count takes.
 */
function transitionNounFor(count: number): string {
  return count === 1 ? NOUN_SINGULAR : NOUN_PLURAL;
}

/**
 * The empty state of a page that resolved with no rows and carried none.
 *
 * An empty page is only an empty capture when the evidence says so. The query
 * schema makes `limit: 0` an explicit request for a total without rows, and an
 * offset past the end an empty page rather than an error, so a page with no
 * rows can arrive beside a positive `total`; saying "nothing was captured" then
 * would contradict the provider's own count. The cases, in the order they are
 * decided:
 *
 * 1. **Count only** — the page size is `0`, so no rows were asked for. The total
 *    is the answer and is stated; without one, the sentence says none was
 *    reported instead of implying zero.
 * 2. **Nothing captured** — a reported total of `0`, or no total on the first
 *    page with no page after it. The node's own copy, or the narrowing copy
 *    while the reader's narrowing is in force: this is the one case where "no
 *    state transitions" is the provider's answer.
 * 3. **Past the end** — a positive total and an offset at or beyond it: where the
 *    page starts, one-based, and how many matched.
 * 4. **Not on this page** — a positive total and an offset inside it: how many
 *    matched, and that this page shows none of them.
 * 5. **A page with no total** — a later page, or a first page followed by
 *    another, with no total reported: where the page starts, and nothing claimed
 *    about the rest.
 *
 * Positions are one-based because a reader counts that way; offsets are how
 * many items were skipped, so the first item of a page at offset `n` is item
 * `n + 1`. Generic product wording only: no sentence names anything of the
 * application under investigation.
 *
 * @example
 * ```ts
 * emptyPageCopy({ limit: 0, offset: 0, total: 42, narrowed: false, morePages: false });
 * // { title: 'Count only',
 * //   message: 'This view requests a count without rows: 42 state transitions matched its query.' }
 * ```
 *
 * @param context What the empty page's request and response establish.
 * @returns The title and sentence its empty state shows.
 */
function emptyPageCopy(context: EmptyPageContext): EmptyPageCopy {
  const { limit, offset, total, narrowed, morePages } = context;

  if (limit === 0) {
    return {
      title: COUNT_ONLY_TITLE,
      message:
        total === undefined
          ? COUNT_ONLY_UNKNOWN_MESSAGE
          : `This view requests a count without rows: ${formatCount(total)} ${transitionNounFor(total)} matched its query.`,
    };
  }

  if (total === 0 || (total === undefined && offset === 0 && !morePages)) {
    return narrowed ? { title: undefined, message: EMPTY_FILTERED_MESSAGE } : NOTHING_CAPTURED_COPY;
  }

  const position = formatCount(offset + 1);

  if (total === undefined) {
    return {
      title: EMPTY_PAGE_TITLE,
      message: `This page starts at position ${position} and holds no ${NOUN_PLURAL}; no total was reported for this query.`,
    };
  }

  const matched = `${formatCount(total)} ${transitionNounFor(total)}`;

  return {
    title: EMPTY_PAGE_TITLE,
    message:
      offset >= total
        ? `This page starts at position ${position}, past the end of the ${matched} that matched this query.`
        : `${matched} matched this query, but none are shown on this page.`,
  };
}

/**
 * The rows loaded so far: every earlier page, then the page that resolved.
 *
 * The provider's order is kept across pages and nothing is sorted, merged or
 * re-ranked here. The one thing removed is a row whose key — the `id` the grid
 * keys its rows by — is already loaded, keeping the first occurrence: the
 * contract promises that paging never repeats an item, but a result that changed
 * between two requests can shift a row across a page boundary, and two rows
 * with one key would be two grid rows React cannot tell apart. Identity is kept
 * wherever nothing was added, so the derivations downstream do not recompute for
 * a page that contributed nothing new.
 *
 * @param carried The rows of the earlier pages of this sequence, already de-duplicated.
 * @param page The page that resolved, or `undefined` while none has.
 * @returns The rows to draw from, in the provider's order.
 */
function appendPage(
  carried: readonly StateTransition[],
  page: readonly StateTransition[] | undefined,
): readonly StateTransition[] {
  if (page === undefined || page.length === 0) {
    return carried;
  }

  const seen = new Set<string>();
  for (const row of carried) {
    seen.add(row.id);
  }

  const appended: StateTransition[] = [];
  for (const row of page) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      appended.push(row);
    }
  }

  if (appended.length === 0) {
    return carried;
  }

  if (carried.length === 0 && appended.length === page.length) {
    return page;
  }

  return [...carried, ...appended];
}

/**
 * The identity of a node's data request, for the state stamp described in this
 * module's header.
 *
 * Only the node's own identity and its authored query take part: the reader's
 * local controls are what the stamp protects, so they cannot contribute to it.
 * The result is compared and never parsed, so its exact spelling is nobody's
 * contract.
 *
 * @param node The node whose request identifies this view's state.
 * @returns A string equal for equal requests.
 */
function nodeRequestKey(node: StateTransitionsNode): string {
  return `${node.id}\u0000${serializeQuery(node.query)}`;
}

/**
 * The identity of one request sequence, which stamps the pages accumulated
 * along it (see {@link PageAccumulator}).
 *
 * The node's id and the sequence's query — source, filter with the reader's
 * component narrowing merged in, the applied order and the per-request page
 * size. That query carries no offset: the offset is the one member that moves
 * along a sequence, so it cannot be what tells two sequences apart. Compared,
 * never parsed.
 *
 * @param nodeId The id of the node the sequence belongs to.
 * @param sequence The sequence's query, without an offset.
 * @returns A string equal for equal sequences.
 */
function sequenceIdentityOf(nodeId: string, sequence: DataQuery): string {
  return `${nodeId}\u0000${serializeQuery(sequence)}`;
}

/**
 * A query as a stable string: object keys sorted, absent members omitted.
 *
 * Deliberately not `JSON.stringify` alone — that preserves insertion order, so
 * two queries with the same contents written in a different order would compare
 * unequal and reset the reader's paging for no reason.
 *
 * @param query The query to serialise.
 * @returns Its canonical serialisation.
 */
function serializeQuery(query: DataQuery): string {
  return JSON.stringify(query, (_key: string, value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return value;
    }

    const record: Readonly<Record<string, unknown>> = value as Readonly<Record<string, unknown>>;

    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        const member = record[key];
        if (member !== undefined) {
          sorted[key] = member;
        }

        return sorted;
      }, {});
  });
}

/**
 * The sort orders a control may offer for one node.
 *
 * {@link OFFERED_SORTS} plus, when the node or the reader is on a third order,
 * that order — so the control always has an option matching the state it is in
 * rather than displaying one order while another is in force.
 *
 * @param current The order the next request will carry.
 * @returns Option values in display order.
 */
function sortOptionsFor(current: DataQuerySort): readonly DataQuerySort[] {
  return OFFERED_SORTS.includes(current) ? OFFERED_SORTS : [...OFFERED_SORTS, current];
}

/**
 * Whether a row is the aggregate's truncation sentinel rather than a
 * transition.
 *
 * The shape `@debuggen/telemetry` documents: the disclosure carries `truncated`
 * and describes no value, so it has no transition source and no previews, and
 * its `changed` is `false` by construction. Tested structurally rather than by
 * `truncated` alone, because an ordinary transition may *also* disclose that its
 * list was cut — that row still has values to show and is drawn as a
 * transition, with the disclosure added beside it.
 *
 * @param transition The row to classify.
 * @returns `true` for a disclosure-only row.
 */
function isTruncationDisclosure(transition: StateTransition): boolean {
  return (
    transition.truncated === true &&
    transition.transitionSource === undefined &&
    transition.previousValue === undefined &&
    transition.nextValue === undefined
  );
}

/**
 * One value summary as it is displayed, and whether displaying it shortened it.
 *
 * The received string passes through {@link oneLinePreview}, which collapses
 * whitespace to one line and enforces the 120-code-point privacy bound. The
 * `shortened` flag exists so the cell can *say* that it shortened something —
 * it is never an offer to show more, because the only string this view has is
 * the one it was given.
 *
 * @param summary The producer's preview, or `undefined` when it reported none.
 * @returns The display text and the shortened flag, or `undefined`.
 */
function previewOf(summary: string | undefined): { text: string; shortened: boolean } | undefined {
  if (summary === undefined) {
    return undefined;
  }

  const text = oneLinePreview(summary);

  // The display text has its direction controls revealed, so it is weighed
  // against the summary revealed the same way: a control is not a shortening,
  // and the cell must not claim it shortened a value it showed whole.
  return { text, shortened: text !== formatUntrustedText(summary) };
}

/**
 * A component's display name, or the label for a row whose producer named none.
 *
 * @param transition The row.
 * @returns Text to render in the row header.
 */
function componentLabelOf(transition: StateTransition): string {
  return transition.component ?? UNNAMED_COMPONENT_LABEL;
}

/**
 * A hook's identity as a label, without ever guessing a name.
 *
 * The producer's own `hookLabel` when it inferred one; otherwise the hook's
 * position in the fiber's hook list, printed as the zero-based index it is, so
 * two hooks of one component stay distinguishable; otherwise the package's
 * not-available label. No name is constructed from anything else — a hook's
 * name is not observable, and inventing one would be presenting a guess as
 * evidence.
 *
 * @param transition The row.
 * @returns Text to render in the hook cell.
 */
function hookLabelOf(transition: StateTransition): string {
  if (transition.hookLabel !== undefined) {
    return transition.hookLabel;
  }

  if (transition.hookIndex !== undefined) {
    return `${HEADERS.hook} #${String(transition.hookIndex)}`;
  }

  return NOT_AVAILABLE_LABEL;
}

/**
 * The words that identify a row to a reader who cannot see the grid: the
 * component, then the hook when the producer identified one.
 *
 * Built only from what the row itself displays, through the same two helpers
 * its row header and hook cell render with, so the name a control announces
 * matches the text beside it and never guesses: a hook the producer neither
 * labelled nor indexed contributes nothing rather than a not-available token,
 * and a component it could not name is announced as not named.
 *
 * @example
 * ```ts
 * rowIdentityOf({ component: 'ExampleWidget', hookLabel: 'useExampleValue', … });
 * // 'ExampleWidget useExampleValue'
 * rowIdentityOf({ component: 'ExampleWidget', hookIndex: 2, … }); // 'ExampleWidget Hook #2'
 * rowIdentityOf({ … }); // 'Component not named'
 * ```
 *
 * @param transition The row.
 * @returns The row's identity, as words.
 */
function rowIdentityOf(transition: StateTransition): string {
  const component = componentLabelOf(transition);
  const hookIdentified = transition.hookLabel !== undefined || transition.hookIndex !== undefined;

  return hookIdentified ? `${component} ${hookLabelOf(transition)}` : component;
}

/**
 * The accessible name of a row's disclosure toggle: the action it performs
 * next, and the row it performs it on.
 *
 * The toggle is icon-only, so this name is its only text and there is no
 * visible label for it to diverge from (WCAG 2.5.3). The open state itself is
 * not in the name: the toggle reports it through `aria-expanded`, and the
 * action word is what changes with it.
 *
 * @param expanded Whether the row's detail is open.
 * @param transition The row.
 * @returns For example `Show details of ExampleWidget useExampleValue`.
 */
function detailToggleLabel(expanded: boolean, transition: StateTransition): string {
  return `${expanded ? DETAIL_HIDE_LABEL : DETAIL_SHOW_LABEL} ${rowIdentityOf(transition)}`;
}

/**
 * The trigger's label: the attributed record's own name, else its kind's
 * readable form, else a generic caption.
 *
 * Never a cause. `triggerName` and `triggerKind` are filled only when the
 * attributed record is inside the slice being aggregated, so a row that has
 * neither is a row whose record is elsewhere — which the cell says rather than
 * papering over.
 *
 * @param transition The row.
 * @returns Text for the trigger cell.
 */
function triggerLabelOf(transition: StateTransition): string {
  if (transition.triggerName !== undefined) {
    return transition.triggerName;
  }

  if (transition.triggerKind !== undefined) {
    return formatKindLabel(transition.triggerKind);
  }

  return TRIGGER_GENERIC_LABEL;
}

/**
 * Group rows by component, stably, for readability.
 *
 * First appearance decides a component's position and every row keeps its place
 * within its component, so the capture's order survives inside each group —
 * which is the only order this view may claim, since ordering belongs to the
 * side that holds the whole capture. Nothing is merged, summed or dropped:
 * the output is a permutation of the input and the footer says grouping is on.
 *
 * Rows whose producer named no component share one bucket. They are not being
 * claimed to come from one component — the label says the name is missing — they
 * are simply indistinguishable by the only key this grouping has.
 *
 * @param rows The page, as the provider ordered it.
 * @returns The same rows, grouped.
 */
function groupByComponent(rows: readonly StateTransition[]): readonly StateTransition[] {
  const groups = new Map<string, StateTransition[]>();

  for (const row of rows) {
    const key = row.component ?? ALL_COMPONENTS;
    const bucket = groups.get(key);

    if (bucket === undefined) {
      groups.set(key, [row]);
    } else {
      bucket.push(row);
    }
  }

  return [...groups.values()].flat();
}

/**
 * The component filter's options, derived from the rows actually loaded.
 *
 * Derived rather than enumerated: `@debuggen/telemetry` is a type-only
 * dependency of this package, so there is no vocabulary constant to read, and a
 * component list is capture data in any case. The reader's current choice is
 * kept even if the loaded rows do not contain it — while its first page is
 * still in flight, say — so the control can never display an option that is
 * not in force.
 *
 * @param rows Every row loaded so far.
 * @param current The component currently filtered on, or {@link ALL_COMPONENTS}.
 * @returns Options for the picker, "everything" first.
 */
function componentOptionsFor(
  rows: readonly StateTransition[],
  current: string,
): readonly SelectOption[] {
  const names: string[] = [];

  for (const row of rows) {
    if (row.component !== undefined && !names.includes(row.component)) {
      names.push(row.component);
    }
  }

  if (current !== ALL_COMPONENTS && !names.includes(current)) {
    names.push(current);
  }

  // The value is the captured name, which the filter compares rows against;
  // the label is what the picker prints in a native `<option>`, which reveals
  // nothing on its own, so its direction controls are revealed here.
  return [
    { value: ALL_COMPONENTS, label: ALL_COMPONENTS_LABEL },
    ...names.map((name) => ({ value: name, label: formatUntrustedText(name) })),
  ];
}

/**
 * The pointer a transition row stands for: the captured `state` record it
 * describes, with that record's own span and trace.
 *
 * What an activated row reports, and what the row is matched against the
 * panel's selection by, so the two can never disagree.
 *
 * @param transition The row.
 * @returns The event reference `PanelActions.onSelectEvent` takes.
 */
function transitionRefOf(transition: StateTransition): PanelEventRef {
  return {
    eventId: transition.eventId,
    spanId: transition.spanId,
    traceId: transition.traceId,
  };
}

/**
 * The key of the drawn row that stands for the panel's selected event.
 *
 * Read against the rows the grid is handed — after the reader's "changed only"
 * narrowing and the grouping — because only a drawn row can carry the mark: a
 * selected record this view has not loaded, or has narrowed away, marks nothing
 * rather than a neighbour.
 *
 * @param rows The rows the grid draws, in display order.
 * @param selection The panel's selection, or `undefined` for none.
 * @returns The matching row's key, or `null` when no drawn row stands for it.
 */
function selectedTransitionKeyOf(
  rows: readonly StateTransition[],
  selection: PanelSelection | undefined,
): string | null {
  if (selection === undefined) {
    return null;
  }

  const match = rows.find((row) => matchesPanelSelection(selection, transitionRefOf(row)));

  return match === undefined ? null : match.id;
}

/** The reader's toolbar state, as {@link filterReportOf} reports it. */
interface ToolbarState {
  /** The order the next request carries. */
  readonly sort: DataQuerySort;
  /** The component narrowed to, or {@link ALL_COMPONENTS}. */
  readonly component: string;
  /** Whether the loaded rows are narrowed to rows with reported values. */
  readonly changedOnly: boolean;
  /** Whether rows are grouped by component. */
  readonly grouped: boolean;
}

/**
 * The reader's toolbar state as the plain strings `PanelActions.onFilterChange`
 * carries — the values the toolbar actually holds, and no query shape.
 *
 * A whole snapshot rather than the one control that moved, so a host that
 * remembers a view's filters can restore it from the latest report alone —
 * which is why every toolbar control reports through this one function: the
 * order select, the component select and both toggles. The component narrowing
 * is omitted while every component is shown, which is how the report spells "no
 * narrowing"; the two toggles are spelled `"true"`/`"false"`, as every boolean a
 * filter report carries is.
 *
 * @param state The toolbar state after the change being reported.
 * @returns The filter report.
 */
function filterReportOf(state: ToolbarState): Record<string, string> {
  return {
    sort: state.sort,
    ...(state.component === ALL_COMPONENTS ? {} : { component: state.component }),
    changedOnly: String(state.changedOnly),
    grouped: String(state.grouped),
  };
}

/*
 * ---------------------------------------------------------------------------
 * Local view state
 * ---------------------------------------------------------------------------
 */

/**
 * The pages already received along one request sequence, and the offset of the
 * page requested next.
 *
 * Written **only** from the "Load more" handler, which is what keeps this
 * component free of state written from an effect: at the moment of the click
 * the rows on screen, the `nextOffset` the provider reported and the total it
 * last reported are all in hand, so the accumulator is complete before the next
 * page is even requested. The order and component handlers clear it, because
 * each starts a different sequence.
 *
 * `identity` is the {@link sequenceIdentityOf} the pages were loaded under. An
 * accumulator whose identity no longer matches the current sequence is ignored
 * during render — again with no effect, and with no render able to show rows of
 * one sequence beneath the next page of another.
 */
interface PageAccumulator {
  /** The sequence these pages belong to; offset excluded by construction. */
  readonly identity: string;
  /** Every row received before the page in flight, de-duplicated, in the provider's order. */
  readonly rows: readonly StateTransition[];
  /** The offset of the page in flight: the `nextOffset` of the page before it. */
  readonly offset: number;
  /**
   * The total the provider last reported for this sequence, carried so the
   * footer keeps stating it while the next page is in flight or has failed,
   * instead of momentarily claiming none was ever reported.
   */
  readonly total: number | undefined;
}

/**
 * Everything the reader controls, stamped with the request it belongs to.
 *
 * One object rather than six `useState` calls, because the stamp has to reset
 * all of them together: when the node's request changes, the loaded pages, a
 * component filter and a disclosure taken against the previous request are all
 * meaningless at once. The selected row is deliberately not part of it: it is
 * the panel's shared selection (see `useViewSelection`), which belongs to the
 * panel rather than to this view's request. Held as data and compared during
 * render (see {@link viewFor}), which is how the reset happens without an
 * effect — the repository's React Compiler rules forbid writing state from one,
 * and a reset effect would also render one frame of stale rows before it ran.
 */
interface ViewState {
  /** The {@link nodeRequestKey} this state was taken against. */
  readonly requestKey: string;
  /** The reader's order, or `undefined` to keep the node's own. */
  readonly sort: DataQuerySort | undefined;
  /** The component narrowed to, or {@link ALL_COMPONENTS}. */
  readonly component: string;
  /** Whether the loaded rows are narrowed to rows with reported values. */
  readonly changedOnly: boolean;
  /** Whether rows are grouped by component. */
  readonly grouped: boolean;
  /**
   * The pages loaded before the one in flight, or `undefined` while the
   * sequence's first page is the one requested. See {@link PageAccumulator}.
   */
  readonly pages: PageAccumulator | undefined;
  /** The rows whose detail is disclosed. */
  readonly expandedKeys: readonly string[];
}

/**
 * The state a fresh request starts from.
 *
 * @param requestKey The request this state belongs to.
 * @returns Default local state, stamped.
 */
function initialView(requestKey: string): ViewState {
  return {
    requestKey,
    sort: undefined,
    component: ALL_COMPONENTS,
    changedOnly: false,
    grouped: true,
    pages: undefined,
    expandedKeys: NO_KEYS,
  };
}

/**
 * The state in force for one request: the held state when its stamp matches,
 * defaults otherwise.
 *
 * @param held The state last written.
 * @param requestKey The current request's identity.
 * @returns State belonging to this request.
 */
function viewFor(held: ViewState, requestKey: string): ViewState {
  return held.requestKey === requestKey ? held : initialView(requestKey);
}

/*
 * ---------------------------------------------------------------------------
 * Props
 * ---------------------------------------------------------------------------
 */

/**
 * The props of {@link StateTransitionViewer}.
 *
 * A node and an optional class name — the shape every query-backed component in
 * this package takes. Data is not a prop: it is resolved from the node's own
 * `query` through the ambient `DataProvider`, which is what stops a host surface
 * from handing a view rows that its query never asked for.
 */
export interface StateTransitionViewerProps {
  /**
   * The validated `stateTransitions` node to draw.
   *
   * Its `id` is this view's identity in every {@link PanelActions} callback, its
   * `query` is the request, and its `title` — when it carries one — names the
   * grid for assistive technology.
   */
  node: StateTransitionsNode;

  /** Extra class names, composed after this component's own. */
  className?: string | undefined;
}

/*
 * ---------------------------------------------------------------------------
 * The component
 * ---------------------------------------------------------------------------
 */

/**
 * Hook state changes as rows: what a value moved from, the record that moved it,
 * and what it moved to.
 *
 * @param props The props, as documented on {@link StateTransitionViewerProps}.
 * @returns The grid, or the node's loading, empty or error state.
 *
 * The stateful view is rendered under a `key` that changes exactly when the
 * ambient `DataProvider` is replaced (see {@link useProviderGeneration}). A
 * host that rebinds a mounted panel to another session swaps the provider
 * without remounting the node, and the same node id and query can recur in
 * that session's panel; the accumulated pages, the next offset, the chosen
 * order and narrowing and the open and focused rows of the previous provider —
 * and, outside a panel host, the view's own fallback selection — must not
 * survive into it, so a new provider is a new instance that paints none of them
 * and starts from the authored first page. Under a host the selected row is the
 * panel's shared selection, which the host itself scopes to the panel.
 *
 * @example Inside a panel host that provides a `DataProvider` and `PanelActions`.
 * ```tsx
 * <StateTransitionViewer node={node} />
 * ```
 */
export function StateTransitionViewer(props: StateTransitionViewerProps): ReactElement {
  const providerGeneration = useProviderGeneration();

  return <StateTransitionViewerView key={providerGeneration} {...props} />;
}

/** The provider a view was last rendered under, and how many it has seen. */
interface ProviderBinding {
  /** The ambient `DataProvider` of the latest render. */
  readonly provider: DataProvider | undefined;

  /** Incremented each time that provider is replaced by a different one. */
  readonly generation: number;
}

/**
 * A number that changes exactly when the ambient `DataProvider` is replaced.
 *
 * The binding is adjusted during render, React's documented pattern for state
 * that follows a changed input: the replaced render is discarded before
 * commit, so nothing loaded from the previous provider is ever painted under
 * the new one. Compared by reference, which is what a provider's identity is:
 * a host creates one per session.
 *
 * @returns The current provider's generation.
 */
function useProviderGeneration(): number {
  const provider = useDataProvider();
  const [binding, setBinding] = useState<ProviderBinding>(() => ({ provider, generation: 0 }));

  if (binding.provider !== provider) {
    const next: ProviderBinding = { provider, generation: binding.generation + 1 };
    setBinding(next);
    return next.generation;
  }

  return binding.generation;
}

/**
 * The stateful body of {@link StateTransitionViewer}: one provider's pages,
 * order, narrowing, selection and disclosure for one node. Focus is not among
 * them: `DataTable` owns the grid's roving stop and its keyboard route.
 *
 * @param props The props, as documented on {@link StateTransitionViewerProps}.
 * @returns The grid, or the node's loading, empty or error state.
 */
function StateTransitionViewerView(props: StateTransitionViewerProps): ReactElement {
  const { node, className } = props;

  const actions = usePanelActions();
  // Hoisted so the toolbar handlers' dependency lists name the one member they use.
  const reportFilter = actions?.onFilterChange;
  // The panel's one selection, shared with every other view under the host,
  // and the recorder an activation calls: a no-op under a host, which records
  // the report itself, and this view's own fallback outside one.
  const { selection, markSelected } = useViewSelection();

  // Hooks first and unconditionally, including for a node this view cannot
  // draw: the unsupported-source branch is a `return` at the end of the
  // function, never an early exit past a hook.
  const requestKey = nodeRequestKey(node);
  const [heldView, setHeldView] = useState<ViewState>(() => initialView(requestKey));
  const view = viewFor(heldView, requestKey);

  const sourceSupported = node.query.source === STATE_TRANSITIONS_SOURCE;
  // One page size for every request of a sequence, and the offset its first
  // page starts at. Neither grows: later pages move by `nextOffset` alone. An
  // authored `0` stays `0` — a count-only request, never paged.
  const pageLimit = clampPageLimit(node.query.limit);
  const firstOffset = node.query.offset ?? DATA_QUERY_DEFAULT_OFFSET;
  const sort = view.sort ?? node.query.sort ?? DEFAULT_SORT;

  /**
   * The request sequence this render pages through: the node's query with the
   * reader's order and component narrowing applied and the page size fixed —
   * every member of the request except the offset, which is what moves along
   * it. `undefined` for a node whose source this view cannot draw, which holds
   * the provider back while the branch below reports it.
   *
   * Every member is written out rather than spread from the node's query: the
   * query schema is strict, so these four and the offset are all it can carry,
   * and spreading it would bring the authored offset into a value that must
   * not have one. The authored filter in particular is merged rather than
   * spread through, so an authored `filter: {}` cannot survive beside the
   * merged one: two spellings of "narrow by nothing" would be two sequence
   * identities, and the reader's pages reset on a change of identity.
   */
  const sequenceQuery = useMemo<StateTransitionsQuery | undefined>(() => {
    if (!sourceSupported) {
      return undefined;
    }

    const filter = {
      ...node.query.filter,
      ...(view.component === ALL_COMPONENTS ? {} : { component: view.component }),
    };

    return {
      source: STATE_TRANSITIONS_SOURCE,
      sort,
      limit: pageLimit,
      ...(Object.keys(filter).length === 0 ? {} : { filter }),
    };
  }, [node.query.filter, pageLimit, sort, sourceSupported, view.component]);

  const pagingIdentity =
    sequenceQuery === undefined ? undefined : sequenceIdentityOf(node.id, sequenceQuery);

  // Pages accumulated under another sequence are ignored during render rather
  // than cleared in an effect: the comparison is pure, and it means a re-ordered
  // or re-narrowed view can never paint rows of the previous sequence, not even
  // for one frame. The handlers that start a new sequence also clear them.
  const activePages =
    view.pages !== undefined && view.pages.identity === pagingIdentity ? view.pages : undefined;
  const offset = activePages?.offset ?? firstOffset;

  /** The request this render resolves: the sequence's page at `offset`. */
  const query = useMemo<StateTransitionsQuery | undefined>(
    () => (sequenceQuery === undefined ? undefined : { ...sequenceQuery, offset }),
    [offset, sequenceQuery],
  );

  const { status, data, error, announcement, total, nextOffset, retry } = useQuery(query);

  const carried = activePages?.rows ?? NO_TRANSITIONS;
  // The page that resolved, or `undefined` while one is in flight or has failed
  // — in both of which the rows already loaded stay exactly as they are.
  const page = status === 'success' ? (data ?? NO_TRANSITIONS) : undefined;

  /** Every row loaded along this sequence: earlier pages first, de-duplicated by key. */
  const loaded = useMemo(() => appendPage(carried, page), [carried, page]);

  // What the footer states and offers. The total survives a page in flight;
  // the next offset exists only for a page that resolved, asked for rows and
  // was answered with a `nextOffset` past its own offset.
  const knownTotal = total ?? activePages?.total;
  const nextPageOffset =
    status === 'success' ? advancedOffset(nextOffset, offset, pageLimit) : undefined;

  /** The rows drawn: the reader's local narrowing, then the presentational grouping. */
  const rows = useMemo<readonly StateTransition[]>(() => {
    const narrowed = view.changedOnly ? loaded.filter((row) => row.changed) : loaded;

    return view.grouped ? groupByComponent(narrowed) : narrowed;
  }, [loaded, view.changedOnly, view.grouped]);

  /** The drawn row that stands for the panel's selected event, whichever view selected it. */
  const selectedRowKey = useMemo(() => selectedTransitionKeyOf(rows, selection), [rows, selection]);

  const componentOptions = useMemo(
    () => componentOptionsFor(loaded, view.component),
    [loaded, view.component],
  );

  /** Whether any loaded row discloses that a capture bound dropped transitions. */
  const anyTruncated = useMemo(() => loaded.some((row) => row.truncated === true), [loaded]);

  const chooseOrder = useCallback(
    (next: string): void => {
      // The order the toolbar is left showing, for the report below: read from
      // this render's state for the reason the toggles give, and falling back
      // to the order in force for a value the schema's guard does not accept,
      // exactly as the updater does.
      const reportedSort = isDataQuerySort(next) ? next : sort;

      setHeldView((held) => {
        const current = viewFor(held, requestKey);
        // Narrowed by the schema's own guard rather than by a local list: the
        // control may legitimately offer an order this view does not recommend
        // (see `sortOptionsFor`), and re-deriving the vocabulary here would be a
        // second place for it to be spelled.
        const chosen = isDataQuerySort(next) ? next : current.sort;

        // A new order is a new sequence, so it starts again from the node's
        // first page: rows accumulated under the old ranking describe a
        // different ordering and must not be carried into this one.
        return {
          ...current,
          sort: chosen,
          pages: undefined,
          expandedKeys: NO_KEYS,
        };
      });
      reportFilter?.(
        node.id,
        filterReportOf({
          sort: reportedSort,
          component: view.component,
          changedOnly: view.changedOnly,
          grouped: view.grouped,
        }),
      );
    },
    [node.id, reportFilter, requestKey, sort, view.changedOnly, view.component, view.grouped],
  );

  const handleComponentChange = useCallback(
    (next: string): void => {
      setHeldView((held) => {
        const current = viewFor(held, requestKey);

        // A new narrowing is a new sequence as well, for the same reason.
        return {
          ...current,
          component: next,
          pages: undefined,
          expandedKeys: NO_KEYS,
        };
      });
      reportFilter?.(
        node.id,
        filterReportOf({
          sort,
          component: next,
          changedOnly: view.changedOnly,
          grouped: view.grouped,
        }),
      );
    },
    [node.id, reportFilter, requestKey, sort, view.changedOnly, view.grouped],
  );

  // The two toggles are local narrowings — no page is requested for either —
  // and each reports the toolbar state it leaves behind, as the order and the
  // component narrowing do, so a host that remembers a developer's filters sees
  // every one of them. The new state is read from the state in force for THIS
  // render rather than inside the updater, for the reason `handleRowToggle`
  // gives: the report must name the state the reader asked for, not the one
  // before.
  const handleToggleChangedOnly = useCallback((): void => {
    const changedOnly = !view.changedOnly;

    setHeldView((held) => ({ ...viewFor(held, requestKey), changedOnly }));
    reportFilter?.(
      node.id,
      filterReportOf({ sort, component: view.component, changedOnly, grouped: view.grouped }),
    );
  }, [node.id, reportFilter, requestKey, sort, view.changedOnly, view.component, view.grouped]);

  const handleToggleGrouping = useCallback((): void => {
    const grouped = !view.grouped;

    setHeldView((held) => ({ ...viewFor(held, requestKey), grouped }));
    reportFilter?.(
      node.id,
      filterReportOf({ sort, component: view.component, changedOnly: view.changedOnly, grouped }),
    );
  }, [node.id, reportFilter, requestKey, sort, view.changedOnly, view.component, view.grouped]);

  // The one writer of the accumulator. Everything it records is in hand at the
  // click: the rows on screen become the carried rows, and the offset the
  // provider reported becomes the next request's. The selection and the
  // disclosed rows are left alone, because appending a page changes neither.
  const handleLoadMore = useCallback((): void => {
    if (nextPageOffset === undefined || pagingIdentity === undefined) {
      return;
    }

    const pages: PageAccumulator = {
      identity: pagingIdentity,
      rows: loaded,
      offset: nextPageOffset,
      total: knownTotal,
    };

    setHeldView((held) => ({ ...viewFor(held, requestKey), pages }));
  }, [knownTotal, loaded, nextPageOffset, pagingIdentity, requestKey]);

  const handleRowActivate = useCallback(
    (row: StateTransition): void => {
      const ref = transitionRefOf(row);

      // Recorded first, reported second: under the panel host the report is
      // what moves the shared selection, and outside one the recorder is what
      // marks the row.
      markSelected(ref);
      actions?.onSelectEvent(ref);
    },
    [actions, markSelected],
  );

  const handleRowToggle = useCallback(
    (row: StateTransition): void => {
      // Read from the state in force for THIS render rather than from inside
      // the updater: an updater runs during the next render pass, so a flag
      // computed there would still hold its initial value when the host is
      // notified below — the host would be told the opposite of what happened.
      const open = view.expandedKeys.includes(row.id);

      setHeldView((held) => {
        const current = viewFor(held, requestKey);

        if (open) {
          return {
            ...current,
            expandedKeys: current.expandedKeys.filter((key) => key !== row.id),
          };
        }

        // Guarded rather than appended blindly: two activations batched into one
        // render would otherwise put the same key in the set twice, and
        // `DataTable` would then have two reasons to keep one row open and only
        // one of them would be cleared.
        return {
          ...current,
          expandedKeys: current.expandedKeys.includes(row.id)
            ? current.expandedKeys
            : [...current.expandedKeys, row.id],
        };
      });

      actions?.onExpand?.(node.id, row.id, !open);
    },
    [actions, node.id, requestKey, view.expandedKeys],
  );

  /**
   * Open the record a transition is attributed to.
   *
   * The payload is deliberately the event id alone: a trigger's span may lie
   * outside the loaded slice while its record id still addresses it, and the
   * row's own span and trace describe the *transition*, not the trigger.
   * Attaching them here would tell the host to look for the trigger in the
   * transition's span.
   */
  const handleTriggerSelect = useCallback(
    (eventId: string): void => {
      const ref: PanelEventRef = { eventId };

      // The trigger becomes the panel's selection like any other activation;
      // it marks a row here only if this view also draws that record.
      markSelected(ref);
      actions?.onSelectEvent(ref);
    },
    [actions, markSelected],
  );

  const columns = useMemo<readonly DataTableColumn<StateTransition>[]>(
    () =>
      buildColumns({
        onToggle: handleRowToggle,
        onTriggerSelect: handleTriggerSelect,
        onOpenSource: actions?.onOpenSource,
      }),
    [actions?.onOpenSource, handleRowToggle, handleTriggerSelect],
  );

  const renderDetail = useCallback(
    (row: StateTransition): ReactNode => (
      <TransitionDetail transition={row} onOpenSource={actions?.onOpenSource} />
    ),
    [actions?.onOpenSource],
  );

  // ---------------------------------------------------------------------------
  // States, in precedence: unsupported source, then loading, error, empty and
  // rows for the BODY. The toolbar stays mounted across all four, so a re-query
  // raised from one of its controls does not make that control disappear
  // mid-interaction — with one exception, the settled empty capture reached
  // with no narrowing of the reader's, where no control could reach anything
  // (see `nothingCaptured` below). Loading and error replace the body only for
  // a sequence's FIRST page — nothing is loaded yet, so there is nothing to
  // keep. A later page in flight or failed leaves the loaded rows where they
  // are and is reported by the footer instead, which is rendered whenever a
  // page resolved or rows are loaded, because its counts are claims about rows
  // that exist — except over that same empty capture, whose sentence already
  // states everything its zeros would.
  // ---------------------------------------------------------------------------

  // `query` is `undefined` exactly when the node's source is not this view's
  // (see `sequenceQuery`), so testing it rather than the flag also narrows it for
  // every state below. The mismatch is a defect in the panel, worded from the
  // node catalog by the package's one contract for it, with the node's own query
  // and no retry: asking again cannot change the answer.
  if (query === undefined) {
    return (
      <div className={clsx('dg-state-transitions', className)}>
        <ErrorState
          className="dg-state-transitions__error"
          {...unsupportedQueryProps(node.type, node.query)}
        />
      </div>
    );
  }

  const narrowingActive = view.changedOnly || view.component !== ALL_COMPONENTS;

  const toolbarSelects: readonly ToolbarSelect[] = [
    {
      id: `${node.id}-sort`,
      label: SORT_LABEL,
      value: sort,
      options: sortOptionsFor(sort).map((option) => ({
        value: option,
        label: SORT_LABELS[option],
      })),
      onValueChange: chooseOrder,
    },
    {
      id: `${node.id}-component`,
      label: COMPONENT_FILTER_LABEL,
      value: view.component,
      options: componentOptions,
      onValueChange: handleComponentChange,
    },
  ];

  const toolbarActions: readonly ToolbarAction[] = [
    {
      id: `${node.id}-changed-only`,
      label: CHANGED_ONLY_LABEL,
      onSelect: handleToggleChangedOnly,
      variant: 'ghost',
      pressed: view.changedOnly,
    },
    {
      id: `${node.id}-grouped`,
      label: GROUP_LABEL,
      onSelect: handleToggleGrouping,
      variant: 'ghost',
      pressed: view.grouped,
    },
  ];

  const toolbarStatus: readonly ToolbarStatus[] = anyTruncated
    ? [{ label: TRUNCATED_LABEL, tone: 'warning' }]
    : [];

  const anyLoaded = loaded.length > 0;
  const firstPageLoading = status === 'loading' && !anyLoaded;
  const firstPageFailed = status === 'error' && !anyLoaded;
  // A failure, first page or later, is shown through the package's shared
  // error-state design, the one layout every query-backed node renders its
  // failure with (`queryFailureProps` onto `ErrorState`), together with the
  // request that failed, offset included — what a developer needs to reproduce
  // it. A first page's failure is the view's own; one behind loaded rows is a
  // page failure, whose copy says the rows above it are unaffected.
  const failedResult = { error, announcement, retry };

  // The footer's paging control, read off the status of the page requested
  // last. Loading and failed reach the footer only behind loaded rows (the
  // first page's are the body's), so they describe a NEXT page.
  const nextPage: NextPageState =
    status === 'loading'
      ? { state: 'loading' }
      : status === 'error'
        ? { state: 'failed', failure: queryFailureProps(failedResult, query, { scope: 'page' }) }
        : nextPageOffset === undefined
          ? { state: 'end' }
          : { state: 'available', onLoadMore: handleLoadMore };

  // What an empty body says. Rows were loaded and every one is hidden: only the
  // reader's local "changed only" narrowing can do that (grouping reorders and
  // drops nothing), so that narrowing's copy is the true one. Nothing loaded:
  // the body reaches this branch only for a page that resolved, and what it may
  // claim depends on what was asked and what the provider reported — see
  // `emptyPageCopy`. An empty page with a next page keeps its "Load more" in
  // the footer either way.
  const emptyCopy: EmptyPageCopy = anyLoaded
    ? { title: undefined, message: EMPTY_FILTERED_MESSAGE }
    : emptyPageCopy({
        limit: pageLimit,
        offset,
        total: knownTotal,
        narrowed: narrowingActive,
        morePages: nextPageOffset !== undefined,
      });

  // The settled empty capture: the first page resolved, nothing is loaded, the
  // provider named no further page, and the copy is the nothing-captured one —
  // which `emptyPageCopy` returns only while none of the reader's narrowing is
  // in force. Every control of the toolbar would then act on an empty result
  // (an order, a component choice, a narrowing or a grouping of nothing), and
  // the footer's counts would only restate the sentence as zeros, so both are
  // omitted. A narrowed empty result keeps both, so the narrowing can be undone
  // where it was made, and loading and error keep the toolbar as above.
  const nothingCaptured =
    status === 'success' &&
    !anyLoaded &&
    nextPageOffset === undefined &&
    emptyCopy === NOTHING_CAPTURED_COPY;

  return (
    <div className={clsx('dg-state-transitions', className)}>
      {nothingCaptured ? null : (
        <Toolbar
          className="dg-state-transitions__toolbar"
          label={TOOLBAR_LABEL}
          compact
          wrap
          selects={toolbarSelects}
          actions={toolbarActions}
          status={toolbarStatus}
        />
      )}

      {firstPageLoading ? (
        <LoadingState
          className="dg-state-transitions__loading"
          variant="rows"
          label={LOADING_LABEL}
        />
      ) : firstPageFailed ? (
        <ErrorState
          className="dg-state-transitions__error"
          {...queryFailureProps(failedResult, query)}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          className="dg-state-transitions__empty"
          title={emptyCopy.title}
          message={emptyCopy.message}
          icon={
            emptyCopy === NOTHING_CAPTURED_COPY ? (
              <GitCompareArrows className="dg-icon" />
            ) : undefined
          }
        />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(row) => row.id}
          caption={node.title ?? CATALOG_LABEL}
          compact
          selectedRowKey={selectedRowKey}
          onRowActivate={handleRowActivate}
          expandedRowKeys={view.expandedKeys}
          onRowToggle={handleRowToggle}
          renderExpandedRow={renderDetail}
        />
      )}

      {(status === 'success' || anyLoaded) && !nothingCaptured ? (
        <PagingFooter
          drawn={rows.length}
          loaded={loaded.length}
          total={knownTotal}
          next={nextPage}
          changedOnly={view.changedOnly}
          grouped={view.grouped}
        />
      ) : null}
    </div>
  );
}

/*
 * ---------------------------------------------------------------------------
 * Columns
 *
 * Six, left to right, and that order is the contract: component, hook, the
 * value before, the trigger, the value after, what was reported.
 *
 * Every column declares its width ROLE, never a size (`DataTableColumnWidth`
 * in `../primitives/DataTable`): `DataTable` resolves each role to a track
 * built from the design system's column floor and share tokens, the same track
 * every other table gives content of that kind. The roles follow the content:
 *
 * - the component — the disclosure control, the name and its source chip — is
 *   `name`, the identifier role;
 * - the hook is `label`, a short hook label;
 * - the value before and the value after are `text`, the free-text role with
 *   the widest floor and share: they carry the producer's bounded, redacted
 *   previews, so they need the most room for a readable excerpt;
 * - the trigger — its control and its kind chip — is `name`, since the control
 *   names the record it opens;
 * - what was reported is `label`: one or two short categorical chips
 *   ("Changed", "No values reported", "Transitions dropped"), each carrying
 *   its word as a title or tooltip too (see {@link ChangedCell}).
 *
 * Every role track is a floor and a ratio, which resolves identically in every
 * row — `DataTable` warns that an intrinsic track sizes itself from one row's
 * own content and so stops lining up with its own header, and these cells
 * hold values of wildly varying width. `DataTable` sums the columns' floors
 * and minimums into the grid's own width: a surface just too narrow for every
 * floor narrows the `name` and `text` columns, never below the
 * `--dg-column-yield` fraction of their floor, only as far as the table needs
 * to fit, and a surface too narrow even for that keeps every floor and scrolls
 * the table horizontally with every column readable, instead of squeezing each
 * one to its padding and letting a cell's content paint over its neighbour.
 * ---------------------------------------------------------------------------
 */

/** What {@link buildColumns} needs from the component around it. */
interface ColumnContext {
  /** Discloses or hides one row's detail. */
  readonly onToggle: (transition: StateTransition) => void;
  /** Opens the record a transition is attributed to. */
  readonly onTriggerSelect: (eventId: string) => void;
  /** Opens a project location, when the host offers that action. */
  readonly onOpenSource: ((location: SourceLocation) => void) | undefined;
}

/**
 * Build the column set.
 *
 * A function rather than a constant because the cells need the callbacks; it
 * is memoized by the caller on exactly those inputs. The expansion state is not
 * among them: each cell reads it from the `DataTableCellMeta` the grid hands
 * it. Neither is focus: every control a cell renders is `tabIndex={-1}` in
 * every row, and `DataTable`'s arrow keys reach it (see this module's header).
 *
 * @param context See {@link ColumnContext}.
 * @returns The columns, in reading order.
 */
function buildColumns(context: ColumnContext): readonly DataTableColumn<StateTransition>[] {
  return [
    {
      key: 'component',
      header: HEADERS.component,
      rowHeader: true,
      width: 'name',
      // The disclosure state and the id of the detail row it reveals come from
      // `DataTable` itself, which renders that row: the one source of truth for
      // both, so the toggle can never report a state the grid is not showing.
      cell: (row, _rowIndex, meta) => (
        <ComponentCell
          transition={row}
          expanded={meta.expanded}
          detailRowId={meta.detailRowId}
          onToggle={context.onToggle}
          onOpenSource={context.onOpenSource}
        />
      ),
    },
    {
      key: 'hook',
      header: HEADERS.hook,
      width: 'label',
      cell: (row) => <HookCell transition={row} />,
    },
    {
      key: 'previous',
      header: HEADERS.previous,
      width: 'text',
      cell: (row) => <ValueCell summary={row.previousValue} side="previous" />,
    },
    {
      key: 'trigger',
      header: HEADERS.trigger,
      width: 'name',
      cell: (row) => <TriggerCell transition={row} onSelect={context.onTriggerSelect} />,
    },
    {
      key: 'next',
      header: HEADERS.next,
      width: 'text',
      cell: (row) => <ValueCell summary={row.nextValue} side="next" />,
    },
    {
      key: 'changed',
      header: HEADERS.changed,
      width: 'label',
      cell: (row) => <ChangedCell transition={row} />,
    },
  ];
}

/*
 * ---------------------------------------------------------------------------
 * Cells
 *
 * One component per cell, all module-level and all pure: they read their row
 * and render primitives. None holds state, and none of them touches a value
 * summary except to hand it to the shared preview formatter.
 * ---------------------------------------------------------------------------
 */

/** Props of {@link ComponentCell}. */
interface ComponentCellProps {
  /** The row. */
  readonly transition: StateTransition;
  /** Whether this row's detail is disclosed: `DataTableCellMeta.expanded`. */
  readonly expanded: boolean;
  /**
   * The id of the detail row the toggle reveals, `DataTableCellMeta.detailRowId`:
   * defined only while that row is in the document, so `aria-controls` never
   * names a missing element.
   */
  readonly detailRowId: string | undefined;
  /** Discloses or hides it. */
  readonly onToggle: (transition: StateTransition) => void;
  /** Opens a project location, when the host offers that action. */
  readonly onOpenSource: ((location: SourceLocation) => void) | undefined;
}

/**
 * The row header: the disclosure control, the component's name and its
 * location.
 *
 * The name is the producer's or the package's label for a row that has none —
 * never a guess. `DataTable` puts this cell in `role="rowheader"`. The track
 * is narrower than many names, so the name ellipsizes and carries itself whole
 * as its `title`; the expanded detail shows it whole as well.
 *
 * The disclosure state lives on the toggle, not on the row. ARIA supports
 * `aria-expanded` on a `row` only inside a `treegrid`, and this grid's detail
 * row is a disclosure of one transition's identifiers rather than a child row,
 * so the control follows the APG disclosure pattern: `aria-expanded` states
 * whether the detail is open and `aria-controls` names the detail row
 * `DataTable` renders for it, both taken from the cell's `DataTableCellMeta`.
 *
 * The toggle's name carries the row's identity (see {@link detailToggleLabel}),
 * so each of a grid's toggles is announced as the transition it opens.
 *
 * Both controls — the toggle and the compact source chip — are `tabIndex={-1}`:
 * the grid's arrow keys reach them, and the row stays the grid's one Tab stop.
 *
 * @param props See {@link ComponentCellProps}.
 * @returns The cell.
 */
function ComponentCell(props: ComponentCellProps): ReactElement {
  const { transition, expanded, detailRowId, onToggle, onOpenSource } = props;
  const toggleLabel = detailToggleLabel(expanded, transition);
  const name = componentLabelOf(transition);

  return (
    <Stack
      direction="horizontal"
      gap={1}
      align="center"
      className="dg-state-transitions__component"
    >
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        tabIndex={-1}
        aria-label={toggleLabel}
        aria-expanded={expanded}
        aria-controls={detailRowId}
        icon={
          expanded ? (
            <ChevronDown aria-hidden="true" className="dg-icon" />
          ) : (
            <ChevronRight aria-hidden="true" className="dg-icon" />
          )
        }
        onClick={() => {
          onToggle(transition);
        }}
      >
        {toggleLabel}
      </Button>

      <Text size="sm" truncate title={name}>
        {name}
      </Text>

      {transition.source === undefined ? null : (
        <SourceLink
          location={transition.source}
          compact
          tabIndex={-1}
          {...(onOpenSource === undefined ? {} : { onOpenSource })}
        />
      )}
    </Stack>
  );
}

/** Props of {@link HookCell}. */
interface HookCellProps {
  /** The row. */
  readonly transition: StateTransition;
}

/**
 * The hook's identity, and which dimension the producer said changed.
 *
 * `transitionSource` is the aggregate's own closed vocabulary — the fiber's own
 * hook state, or a context value it consumes — and it is rendered through the
 * shared label humanizer so this file spells none of its members.
 *
 * The two wrap: in a track too narrow for both, the chip moves onto a line of
 * its own instead of being squeezed beside the label, and `DataTable` measures
 * each row, so a taller row is laid out correctly. The label ellipsizes within
 * its line, and the chip clips at its own border in a track narrower than its
 * word; each carries itself whole as its `title`.
 *
 * @param props See {@link HookCellProps}.
 * @returns The cell.
 */
function HookCell(props: HookCellProps): ReactElement {
  const { transition } = props;
  const label = hookLabelOf(transition);
  const dimension =
    transition.transitionSource === undefined
      ? undefined
      : humanizeLabel(transition.transitionSource);

  return (
    <Stack
      direction="horizontal"
      gap={1}
      align="center"
      wrap
      className="dg-state-transitions__hook"
    >
      <Text size="xs" tone="secondary" truncate title={label}>
        {label}
      </Text>

      {dimension === undefined ? null : (
        <Badge variant="outline" title={dimension}>
          {dimension}
        </Badge>
      )}
    </Stack>
  );
}

/** Props of {@link ValueCell}. */
interface ValueCellProps {
  /** The producer's preview of one side of the transition, if it reported one. */
  readonly summary: string | undefined;
  /** Which side this cell is, which decides its classes and its direction glyph. */
  readonly side: 'previous' | 'next';
}

/**
 * One value summary, rendered as the opaque text it is.
 *
 * The received string is handed to {@link oneLinePreview} and to nothing else:
 * no parsing, no expansion, no re-serialisation, no comparison with the other
 * side, because it is the producer's bounded, redacted preview and nothing
 * more. When the formatter shortened it, the cell says so through a state
 * class and a tooltip that explains the bound — it does not offer the rest,
 * because there is no rest to offer. That summary is the tooltip's
 * trigger, focusable at `tabIndex={-1}` so the grid's arrow keys reach it and
 * its focus opens the explanation (see this module's header); a summary shown
 * whole has no tooltip and so no tab index at all.
 *
 * The cell is bounded to its grid track by the stylesheet, so a summary wider
 * than the track ellipsizes inside it. A summary shown whole therefore carries
 * its displayed text — the same bounded string, never a fuller one — as its
 * `title`, so the part the cell clips is readable on hover. A shortened one
 * carries none: its hover already belongs to the tooltip explaining the bound,
 * and a native bubble stacked on that one would compete with it. Both are shown
 * whole, wrapped, in the row's expanded detail.
 *
 * @param props See {@link ValueCellProps}.
 * @returns The cell.
 */
function ValueCell(props: ValueCellProps): ReactElement {
  const { summary, side } = props;

  const preview = previewOf(summary);
  const cellClass = clsx(
    side === 'previous' ? 'dg-state-transitions__previous' : 'dg-state-transitions__next',
    // The stylesheet spells these two cells `__from`/`__to`; both names ride on
    // the element so its existing rules apply and this node's own contract is
    // addressable. See the class table in this module's header.
    side === 'previous' ? 'dg-state-transitions__from' : 'dg-state-transitions__to',
  );

  return (
    <Stack direction="horizontal" gap={1} align="center" className={cellClass}>
      {side === 'next' ? (
        <ArrowRight aria-hidden="true" className="dg-icon dg-state-transitions__arrow" />
      ) : null}

      {preview === undefined ? (
        <Text size="xs" tone="muted">
          {NOT_AVAILABLE_LABEL}
        </Text>
      ) : preview.shortened ? (
        <Tooltip content={VALUE_SHORTENED_HINT}>
          <Code size="sm" className="dg-state-transitions__value dg-is-truncated" tabIndex={-1}>
            {preview.text}
          </Code>
        </Tooltip>
      ) : (
        <Code size="sm" className="dg-state-transitions__value" title={preview.text}>
          {preview.text}
        </Code>
      )}
    </Stack>
  );
}

/** Props of {@link TriggerCell}. */
interface TriggerCellProps {
  /** The row. */
  readonly transition: StateTransition;
  /** Opens the attributed record. */
  readonly onSelect: (eventId: string) => void;
}

/**
 * The bridge back into the timeline and the event log.
 *
 * A control exactly when there is a record to open, and plain text labelled as
 * undetermined when there is not — never a disabled control that looks like a
 * link, and never an inference about what caused the transition. The control's
 * payload is the record id alone; see `handleTriggerSelect` in
 * {@link StateTransitionViewer} for why. The plain label is the trigger of the
 * tooltip saying which of the two facts holds, and it is focusable for that
 * reason alone: focus on it opens the explanation and activates nothing.
 *
 * Both forms are `tabIndex={-1}`, reached by the grid's arrow keys rather than
 * by Tab (see this module's header). The control keeps the browser's own Enter
 * and Space once focus is on it, because `DataTable` leaves those keys to a
 * control inside a row.
 *
 * The control and its kind chip wrap, so in a track too narrow for both the
 * chip takes a line of its own instead of being squeezed beside a long label;
 * `DataTable` measures each row, so the taller row is laid out correctly. The
 * control's label ellipsizes inside the track and carries itself whole as the
 * control's `title` — its accessible name is its label either way — and the
 * chip, which clips at its own border in a track narrower than its word, does
 * the same.
 *
 * @param props See {@link TriggerCellProps}.
 * @returns The cell.
 */
function TriggerCell(props: TriggerCellProps): ReactElement {
  const { transition, onSelect } = props;
  const { triggerEventId, triggerKind } = transition;

  if (triggerEventId === undefined) {
    // Attributed to something whose record is not in this page, or to nothing
    // at all: two different facts, and the tooltip states which.
    const known =
      transition.triggerSpanId !== undefined ||
      transition.triggerName !== undefined ||
      triggerKind !== undefined;

    // No wrapper: one child, no spacing to own, and the cell's own class rides
    // on the text run — a container that adds nothing is a DOM level a reader's
    // assistive technology walks for no reason.
    return (
      <Tooltip content={known ? TRIGGER_OUT_OF_SLICE_HINT : TRIGGER_UNDETERMINED_HINT}>
        <Text
          size="xs"
          tone="muted"
          className="dg-state-transitions__trigger"
          truncate
          tabIndex={-1}
        >
          {known ? triggerLabelOf(transition) : TRIGGER_UNDETERMINED_LABEL}
        </Text>
      </Tooltip>
    );
  }

  const label = triggerLabelOf(transition);

  return (
    <Stack direction="horizontal" gap={1} align="center" wrap>
      <Button
        variant="ghost"
        size="sm"
        className="dg-state-transitions__trigger"
        tabIndex={-1}
        icon={<Zap aria-hidden="true" className="dg-icon" />}
        title={label}
        onClick={() => {
          onSelect(triggerEventId);
        }}
      >
        {label}
      </Button>

      {triggerKind === undefined || transition.triggerName === undefined ? null : (
        <Badge
          variant="outline"
          color={kindColorVar(triggerKind)}
          title={formatKindLabel(triggerKind)}
        >
          {formatKindLabel(triggerKind)}
        </Badge>
      )}
    </Stack>
  );
}

/** Props of {@link ChangedCell}. */
interface ChangedCellProps {
  /** The row. */
  readonly transition: StateTransition;
}

/**
 * What the producer reported, and any disclosure riding on the row.
 *
 * Three cases, and keeping them apart is the honesty this column exists for:
 *
 * - a described transition — the changed chip;
 * - a record whose two summaries were both unreadable — the *no values
 *   reported* chip, which is not a claim that the value stayed the same;
 * - the aggregate's truncation sentinel — the dropped-transitions chip and its
 *   reported floor, which describes a list and no value at all.
 *
 * Each chip carries a glyph and a word as well as a tone, so the state is never
 * conveyed by colour alone. The two chips that carry an explanation are that
 * tooltip's trigger, focusable at `tabIndex={-1}` so the grid's arrow keys
 * reach it (see this module's header); the changed chip explains nothing and
 * takes no tab index. A chip clips at its own border in a track narrower than
 * its word, so the changed chip carries its word as its `title`; the other two
 * already open their tooltip on hover.
 *
 * @param props See {@link ChangedCellProps}.
 * @returns The cell.
 */
function ChangedCell(props: ChangedCellProps): ReactElement {
  const { transition } = props;

  const disclosure =
    transition.truncated === true ? <TruncationChip transition={transition} /> : null;

  if (isTruncationDisclosure(transition)) {
    return (
      <Stack
        direction="horizontal"
        gap={1}
        align="center"
        wrap
        className="dg-state-transitions__changed dg-is-unchanged"
      >
        {disclosure}
      </Stack>
    );
  }

  return (
    <Stack
      direction="horizontal"
      gap={1}
      align="center"
      wrap
      className={clsx(
        'dg-state-transitions__changed',
        transition.changed ? 'dg-is-changed' : 'dg-is-unchanged',
      )}
    >
      {transition.changed ? (
        <Badge
          tone="info"
          icon={<Check aria-hidden="true" className="dg-icon" />}
          title={CHANGED_LABEL}
        >
          {CHANGED_LABEL}
        </Badge>
      ) : (
        <Tooltip content={UNREPORTED_HINT}>
          <Badge
            tone="neutral"
            icon={<CircleSlash aria-hidden="true" className="dg-icon" />}
            tabIndex={-1}
          >
            {UNREPORTED_LABEL}
          </Badge>
        </Tooltip>
      )}
      {disclosure}
    </Stack>
  );
}

/** Props of {@link TruncationChip}. */
interface TruncationChipProps {
  /** The row carrying the disclosure. */
  readonly transition: StateTransition;
}

/**
 * The capture's disclosure that a bound cut a transition list.
 *
 * The count is printed only when the producer disclosed one, and the tooltip
 * states that it is a floor rather than a total — which is what the aggregate
 * says it is. The chip is that tooltip's trigger, focusable at `tabIndex={-1}`
 * and reached by the grid's arrow keys (see this module's header).
 *
 * @param props See {@link TruncationChipProps}.
 * @returns The chip.
 */
function TruncationChip(props: TruncationChipProps): ReactElement {
  const { transition } = props;
  const { droppedTransitions } = transition;

  const label =
    droppedTransitions === undefined
      ? TRUNCATED_LABEL
      : `${TRUNCATED_LABEL}: ${formatCount(droppedTransitions)}`;

  return (
    <Tooltip content={TRUNCATED_HINT}>
      <Badge
        tone="warning"
        icon={<Scissors aria-hidden="true" className="dg-icon" />}
        tabIndex={-1}
      >
        {label}
      </Badge>
    </Tooltip>
  );
}

/*
 * ---------------------------------------------------------------------------
 * The expanded row
 * ---------------------------------------------------------------------------
 */

/** Props of {@link TransitionDetail}. */
interface TransitionDetailProps {
  /** The row whose detail is disclosed. */
  readonly transition: StateTransition;
  /** Opens a project location, when the host offers that action. */
  readonly onOpenSource: ((location: SourceLocation) => void) | undefined;
}

/**
 * One row whole: its identity, its two summaries, its categories and its
 * identifiers.
 *
 * First what the row's cells clip to their tracks, shown here unclipped: the
 * component and hook names, then the value before and the value after, each on
 * a line of its own across the full width of the detail and wrapped rather
 * than ellipsized. Each summary is the row's displayed string exactly — the
 * bounded preview {@link previewOf} produced for the cell — so this block never
 * shows more of a value than the row was given, and a summary the display
 * bound shortened appears here shortened too: there is no rest of it in this
 * process to show.
 *
 * Then the vocabulary the columns have no room for — the value's category, the
 * dimension that changed, the trigger's kind — and the identifiers a developer
 * needs to find the same transition in the timeline, the event log or a stored
 * capture. The instance id is what separates two mounted copies of one
 * component, which the component name alone groups together.
 *
 * The block renders inside `DataTable`'s detail row, which belongs to the same
 * keyboard scope as its data row: the source chip is `tabIndex={-1}` and is the
 * last control ArrowRight reaches from that row. Its full form (symbol and
 * path) is named by `SourceLink` itself, visible text first.
 *
 * @param props See {@link TransitionDetailProps}.
 * @returns The detail block.
 */
function TransitionDetail(props: TransitionDetailProps): ReactElement {
  const { transition, onOpenSource } = props;

  return (
    <Stack direction="vertical" gap={2} className="dg-state-transitions__detail">
      <Stack direction="horizontal" gap={3} align="center" wrap>
        <DetailField label={DETAIL_LABELS.component}>
          <Text size="sm">{componentLabelOf(transition)}</Text>
        </DetailField>
        <DetailField label={DETAIL_LABELS.hook}>
          <Text size="xs" tone="secondary">
            {hookLabelOf(transition)}
          </Text>
        </DetailField>
      </Stack>

      <Stack direction="vertical" gap={1}>
        <DetailField label={DETAIL_LABELS.previousValue} align="baseline">
          <DetailSummary summary={transition.previousValue} />
        </DetailField>
        <DetailField label={DETAIL_LABELS.nextValue} align="baseline">
          <DetailSummary summary={transition.nextValue} />
        </DetailField>
      </Stack>

      <Stack direction="horizontal" gap={2} align="center" wrap>
        {transition.valueType === undefined ? null : (
          <DetailField label={DETAIL_LABELS.valueType}>
            <Badge variant="outline">{humanizeLabel(transition.valueType)}</Badge>
          </DetailField>
        )}
        {transition.transitionSource === undefined ? null : (
          <DetailField label={DETAIL_LABELS.transitionSource}>
            <Badge variant="outline">{humanizeLabel(transition.transitionSource)}</Badge>
          </DetailField>
        )}
        {transition.triggerKind === undefined ? null : (
          <DetailField label={DETAIL_LABELS.triggerKind}>
            <Badge variant="outline" color={kindColorVar(transition.triggerKind)}>
              {formatKindLabel(transition.triggerKind)}
            </Badge>
          </DetailField>
        )}
        {transition.droppedTransitions === undefined ? null : (
          <DetailField label={DETAIL_LABELS.droppedTransitions}>
            <Text size="xs" numeric>
              {formatCount(transition.droppedTransitions)}
            </Text>
          </DetailField>
        )}
      </Stack>

      <Stack direction="horizontal" gap={3} align="center" wrap>
        <DetailField label={DETAIL_LABELS.eventId}>
          <Code size="sm">{transition.eventId}</Code>
        </DetailField>
        <DetailField label={DETAIL_LABELS.spanId}>
          <Code size="sm">{transition.spanId}</Code>
        </DetailField>
        <DetailField label={DETAIL_LABELS.traceId}>
          <Code size="sm">{transition.traceId}</Code>
        </DetailField>
        {transition.triggerSpanId === undefined ? null : (
          <DetailField label={DETAIL_LABELS.triggerSpanId}>
            <Code size="sm">{transition.triggerSpanId}</Code>
          </DetailField>
        )}
        {transition.renderSpanId === undefined ? null : (
          <DetailField label={DETAIL_LABELS.renderSpanId}>
            <Code size="sm">{transition.renderSpanId}</Code>
          </DetailField>
        )}
        {transition.fiberId === undefined ? null : (
          <DetailField label={DETAIL_LABELS.fiberId}>
            <Code size="sm" numeric>
              {String(transition.fiberId)}
            </Code>
          </DetailField>
        )}
      </Stack>

      {transition.source === undefined ? null : (
        <DetailField label={DETAIL_LABELS.source}>
          <SourceLink
            location={transition.source}
            tabIndex={-1}
            {...(onOpenSource === undefined ? {} : { onOpenSource })}
          />
        </DetailField>
      )}
    </Stack>
  );
}

/** Props of {@link DetailField}. */
interface DetailFieldProps {
  /** The field's caption. */
  readonly label: string;
  /**
   * How the caption and the value align across the field's line: `center` for
   * a one-line value such as a chip or an identifier, `baseline` for a value
   * that may wrap onto further lines, so the caption sits on its first line
   * rather than midway down it.
   *
   * @default 'center'
   */
  readonly align?: StackAlign | undefined;
  /** The field's value, already rendered through a primitive. */
  readonly children: ReactNode;
}

/**
 * One captioned field of an expanded row.
 *
 * A caption and its value on one line, spaced by the layout primitive rather
 * than by a margin, so the detail block has no bespoke spacing of its own.
 *
 * @param props See {@link DetailFieldProps}.
 * @returns The field.
 */
function DetailField(props: DetailFieldProps): ReactElement {
  const { label, align = 'center', children } = props;

  return (
    <Stack direction="horizontal" gap={1} align={align}>
      <Text size="xs" tone="muted">
        {label}
      </Text>
      {children}
    </Stack>
  );
}

/** Props of {@link DetailSummary}. */
interface DetailSummaryProps {
  /** The producer's preview of one side of the transition, if it reported one. */
  readonly summary: string | undefined;
}

/**
 * One value summary inside an expanded row: the row's displayed string, whole.
 *
 * The same {@link previewOf} text the row's cell shows — so never more than
 * the row was given — wrapped across as many lines as it needs instead of
 * clipped to a track. It deliberately carries no `dg-state-transitions__value`
 * class: that class addresses a row's own summary, which the stylesheet clips
 * to one line, and this copy is the one that is not clipped. A side the
 * producer did not report reads as the package's not-available label, exactly
 * as its cell does.
 *
 * @param props See {@link DetailSummaryProps}.
 * @returns The summary, or the not-available label.
 */
function DetailSummary(props: DetailSummaryProps): ReactElement {
  const preview = previewOf(props.summary);

  if (preview === undefined) {
    return (
      <Text size="xs" tone="muted">
        {NOT_AVAILABLE_LABEL}
      </Text>
    );
  }

  return (
    <Code size="sm" wrap>
      {preview.text}
    </Code>
  );
}

/*
 * ---------------------------------------------------------------------------
 * The footer
 * ---------------------------------------------------------------------------
 */

/**
 * Where the sequence stands after the page requested last, which decides the
 * footer's paging control.
 *
 * A closed union rather than a set of flags, so the footer can never be asked
 * to offer "Load more" and report a failure at once:
 *
 * - `end` — the provider reported no next page (see `advancedOffset`), so
 *   nothing is offered;
 * - `available` — a next page exists at the reported offset;
 * - `loading` — that page is in flight, behind the rows already on screen;
 * - `failed` — it failed; the rows stay and the retry re-requests the same page.
 */
type NextPageState =
  | { readonly state: 'end' }
  | { readonly state: 'available'; readonly onLoadMore: () => void }
  | { readonly state: 'loading' }
  | {
      readonly state: 'failed';
      /**
       * The failed page in the package's one failure contract, page scope:
       * title, lead and cause, hint, code, the request that failed (offset
       * included), the settled announcement and the retry that requests the
       * same page again.
       */
      readonly failure: QueryFailureProps;
    };

/** Props of {@link PagingFooter}. */
interface PagingFooterProps {
  /** How many rows are drawn after the reader's local narrowing and grouping. */
  readonly drawn: number;
  /** How many rows every page received so far holds together. */
  readonly loaded: number;
  /** How many the source holds after the query's filter, when the provider said. */
  readonly total: number | undefined;
  /** The paging control to offer; see {@link NextPageState}. */
  readonly next: NextPageState;
  /** Whether the "changed only" narrowing is in force. */
  readonly changedOnly: boolean;
  /** Whether rows are grouped by component. */
  readonly grouped: boolean;
}

/**
 * What is on screen, what was loaded, what exists, and how to load more.
 *
 * Three numbers rather than one, because they are three different facts and
 * conflating them is how a view starts overstating its evidence: `drawn` is
 * after the reader's own narrowing, `loaded` is every page the provider
 * returned so far, and `total` is what the source holds after the query's
 * filter — absent whenever the provider did not report it, in which case
 * nothing is claimed about it. The scope notes say plainly which narrowings
 * are local, because a filter that silently applied to only part of the
 * evidence would misrepresent the rest.
 *
 * The paging control follows {@link NextPageState}. While a page is in flight
 * the same control stays in place, disabled and saying so, so it cannot request
 * the page twice; a failed page is reported here as an alert with its retry,
 * beside the counts of the rows it left untouched.
 *
 * The counts sentence is a polite, atomic live region, so a reader who pressed
 * "Load more" or toggled a narrowing hears the new counts without moving focus
 * to find them.
 *
 * @param props See {@link PagingFooterProps}.
 * @returns The footer.
 */
function PagingFooter(props: PagingFooterProps): ReactElement {
  const { drawn, loaded, total, next, changedOnly, grouped } = props;

  const counts =
    total === undefined
      ? `${formatCount(drawn)} shown · ${formatCount(loaded)} loaded`
      : `${formatCount(drawn)} shown · ${formatCount(loaded)} loaded · ${formatCount(total)} in total`;

  return (
    <Stack
      direction="horizontal"
      gap={3}
      align="center"
      justify="between"
      wrap
      className="dg-state-transitions__footer"
    >
      <Stack direction="vertical" gap={0}>
        {/*
         * A polite live region: the counts change when a page is appended or a
         * narrowing is toggled, far from where the reader's focus is, and the
         * change is announced without interrupting them. Atomic, so the whole
         * sentence is read rather than a changed figure out of context. The
         * element is present from the first resolved page, which is what lets
         * assistive technology observe the changes after it.
         */}
        <Text size="xs" tone="muted" numeric aria-live="polite" aria-atomic="true">
          {counts}
        </Text>
        {changedOnly ? (
          <Text size="xs" tone="muted">
            {CHANGED_ONLY_SCOPE_NOTE}
          </Text>
        ) : null}
        {grouped ? (
          <Text size="xs" tone="muted">
            {GROUPED_SCOPE_NOTE}
          </Text>
        ) : null}
      </Stack>

      {next.state === 'available' ? (
        <Button variant="secondary" size="sm" onClick={next.onLoadMore}>
          {LOAD_MORE_LABEL}
        </Button>
      ) : next.state === 'loading' ? (
        <Button variant="secondary" size="sm" disabled>
          {LOADING_MORE_LABEL}
        </Button>
      ) : next.state === 'failed' ? (
        <ErrorState className="dg-state-transitions__error" {...next.failure} />
      ) : null}
    </Stack>
  );
}
