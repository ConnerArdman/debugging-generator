'use client';

/*
 * WarehouseFilter - the inventory dashboard's filter row, and the one interactive component on
 * that page.
 *
 * Its three siblings (`InventoryKpiCards`, `InventoryLevelsTable`, `LowStockList`) are server
 * components fed by props, so every choice a reader makes about what the dashboard reports is made
 * here. A choice is expressed as a change to the page's own query string: the dashboard is
 * rendered dynamically and reads those parameters server-side, so rewriting the URL is what
 * re-runs the inventory query and re-renders all three siblings. This component therefore requests
 * nothing itself - there is no `fetch` here, no data hook and no client cache - and it holds no
 * copy of anything the dashboard shows.
 *
 * THE QUERY PARAMETERS ARE THE CONTRACT. Every `name` below and every key written into the URL is
 * copied verbatim from `src/server/validation/inventory.ts`, the single schema that
 * `GET /api/inventory/summary` and the dashboard page both parse their query with: `warehouseId`,
 * `threshold`, `state` and `movement`. The location is named by its identifier, exactly as the
 * parameter's name says, while the dropdown shows that location's short code beside its name -
 * the code is wording for a reader and never a value this row submits. The numeric bounds are that
 * schema's too - a default of ten units, a floor of zero and a ceiling of ten thousand - and they
 * are restated here rather than imported, because a client component may not import server code.
 * `page` is deliberately never written: changing a filter should answer with the first page of the
 * new listing, and omitting the parameter is how the schema's default of `1` applies.
 *
 * PROGRESSIVE ENHANCEMENT IS THE BACKBONE, not a fallback bolted on afterwards. The controls live
 * in a `<form method="get">` with no `action`, so the browser's own submission builds exactly the
 * query string this component would have built - the same keys, the same values, the page
 * parameter absent - and the schema parses it unchanged. Scripting only makes that submission
 * quieter: a dropdown applies its choice without the reader reaching for Apply, and the enhanced
 * path routes through the same navigation the Apply button performs. Nothing the enhanced path
 * writes into the URL differs from what the browser would have submitted, the location a reader
 * cannot see in the list included - see {@link buildInventoryQuery}.
 *
 * APPLY TIMING IS A PRODUCT DECISION, AND IT IS THE SAME DECISION FOR EVERY CONTROL: a choice is
 * applied once the reader has made it, and never while they are still making it.
 *
 * A location, a stock state and a movement kind are discrete choices, so each applies as soon as
 * it is chosen - one navigation per choice, which is what a reader expects from a dropdown, and
 * what keeps the three selects usable without anyone having to find Apply. Choosing is not the
 * same as passing over, though, and a closed `<select>` reports both as a `change`: arrowing from
 * one end of the movement list to the other steps through every kind in between, and applying
 * each of them would ask the server for four dashboards nobody asked to see. So a change made
 * with a key that steps the options shows on screen and waits, and the reader's next blur, Enter
 * or Apply sends it. `STEPPING_KEYS` below carries the rest of that reasoning.
 *
 * The numeric headroom field has always worked that way for the same reason: applying it per
 * keystroke would fire a burst of near-identical requests for "1", "12" and "125" on the way to
 * "1250", so it applies on blur, on Enter (which the form turns into an ordinary submission) or
 * through Apply. `requested` below is what makes a blur immediately followed by an Apply click -
 * one gesture, since pressing the button is what blurs the field - ask for one navigation rather
 * than two, and what makes re-applying an unchanged filter ask for none at all.
 *
 * This dashboard is the honest control surface of this application and carries no defect of its
 * own; a chatty filter row would read as one.
 *
 * WHAT IT HOLDS. The four controls' current text, seeded from the applied props and thereafter
 * owned here, so a choice stays on screen while the server answers instead of snapping back to the
 * value that is still in the URL. It is re-seeded in exactly one situation - the filter changed
 * without this row doing it, which is the recovery link on the failure notice, a navigation link to
 * this route, or the Back button - because controls that keep describing a filter the page is no
 * longer reporting under disagree with the address bar. That re-seeding is a render-phase
 * adjustment guarded against undoing a choice still being answered, not an effect: there is no
 * effect of any kind here, nothing runs on mount, and there is no timer, interval or subscription.
 * The status line is read from the props rather than from that state, so it always names the filter
 * the figures beside it were actually produced under; the one thing it adds is that a change to
 * that filter is in flight, which is a fact about the request rather than about the answer.
 *
 * DIVISION OF LABOUR, as everywhere in this storefront's forms. `@/components/ui/FormField` owns
 * each field's `<label htmlFor>`, its hint and the `aria-describedby` that ties them to the
 * control; its child is a function, so those values come back here and are forwarded onto the
 * control. `@/components/ui/Select`, `@/components/ui/Input` and `@/components/ui/Button` own
 * their own boxes - height, padding, border, the select's caret, the focus ring drawn from
 * `--ls-focus` - and are given no `className` from here. `WarehouseFilter.module.css` owns the row:
 * how the labelled columns share the width, where the Apply group sits, and how the row reads while
 * a change is in flight. The row's status line is visible, so it needs no screen-reader-only
 * counterpart; `aria-live="polite"` is what announces it once the change has landed.
 *
 * THE ROW SPEAKS FOR THE FIGURES IT GOVERNS, which is why it takes them as `children`. A filter
 * change here is a navigation, and a navigation inside a transition keeps the page that is already
 * mounted on screen while the server produces the next one: React does not fall back to the
 * suspense boundary's placeholder for a boundary that has already resolved, so the figures a
 * reader is looking at during a filter change are the PREVIOUS filter's figures, and nothing in
 * that markup says so. Sighted readers have the row's own dim and progress cursor. A reader who
 * cannot see either had, until this slot existed, no signal at all: the figures were stale, the
 * table was stale, and the only announcement came after the answer had already landed.
 *
 * So the regions this row's choices govern are rendered inside it, wrapped in an element carrying
 * `aria-busy`, and the status line says that the figures are being updated while they are. The
 * wrapper is a plain element with a class from the caller - the page owns the layout of its own
 * stack, and this component adds no spacing of its own to it - and it holds no heading and no
 * landmark, because each region inside it already names itself. A caller with nothing to mark
 * passes no children and gets no wrapper: the dashboard's failure state is that caller, and a
 * notice is not a stale figure.
 *
 * WHY EVERY CLASS GOES THROUGH `clsx`, even a single one. Next.js types a CSS module as an index
 * signature, so `noUncheckedIndexedAccess` makes `styles.field` `string | undefined`, and
 * `FormField`'s `className` is an optional `string` that `exactOptionalPropertyTypes` will not let
 * `undefined` reach. `clsx` drops an absent value and always answers a string, which is what makes
 * one class and three compose the same way here - and what keeps the word "undefined" out of a
 * rendered class attribute, where a template string would have put it.
 */

import clsx from 'clsx';
import { usePathname, useRouter } from 'next/navigation';
import type { ChangeEvent, FormEvent, KeyboardEvent, ReactNode } from 'react';
import { useRef, useState, useTransition } from 'react';

import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { formatMovementTypeLabel, formatQuantityLabel } from '@/lib/format';
import type { MovementType, StockState, WarehouseSummary } from '@/lib/types';

import styles from './WarehouseFilter.module.css';

/* -------------------------------------------------------------------------------------------------
 * The query the dashboard reads
 * ---------------------------------------------------------------------------------------------- */

/**
 * Which stocking location to report on, by identifier. Absent means every location.
 */
const WAREHOUSE_PARAM = 'warehouseId';

/** How much headroom above a reorder point still counts as low, in units. */
const THRESHOLD_PARAM = 'threshold';

/** Report only the stock lines in one selling state. Absent applies no constraint. */
const STATE_PARAM = 'state';

/** Report only the recorded stock changes of one kind. Absent applies no constraint. */
const MOVEMENT_PARAM = 'movement';

/**
 * The headroom figure the dashboard opens on, and the range the schema accepts around it.
 *
 * The default is what makes the parameter omissible: a URL without it reports the same figures as
 * a URL carrying `threshold=10`, so this row writes the parameter only when a reader has moved
 * away from the default and every unfiltered dashboard URL stays short. The floor and the ceiling
 * reach the reader twice - as `min`/`max` on the field, where the browser's own validation blocks
 * an out-of-range submission, and through {@link readThreshold}, which clamps the value a script
 * would otherwise send past a ceiling the schema rejects.
 */
const DEFAULT_THRESHOLD = 10;
const MIN_THRESHOLD = 0;
const MAX_THRESHOLD = 10_000;
const THRESHOLD_STEP = 1;

/* -------------------------------------------------------------------------------------------------
 * Field identity and option vocabulary
 * ---------------------------------------------------------------------------------------------- */

/*
 * Literal ids, because `FormField` takes the id from its caller: a fixed string is identical in the
 * markup the server sends and the markup the browser first produces, which is the property that
 * keeps hydration quiet, and it leaves a legible DOM to inspect - `#inventory-warehouse-field`.
 * The dashboard mounts one filter row, so four fixed ids cannot collide.
 */
const WAREHOUSE_FIELD_ID = 'inventory-warehouse-field';
const THRESHOLD_FIELD_ID = 'inventory-threshold-field';
const STATE_FIELD_ID = 'inventory-state-field';
const MOVEMENT_FIELD_ID = 'inventory-movement-field';

/**
 * The value of every "no constraint" option.
 *
 * An empty string, not a sentinel word: the schema normalises an empty parameter onto its default,
 * so an unconstrained control submits something the server already understands on the
 * no-scripting path, and this row simply omits the key on the enhanced one.
 */
const UNCONSTRAINED = '';

/**
 * What the dropdown adds after the identifier of a location it was not given, and what the status
 * line says in place of a location's name in the same situation.
 *
 * The two exist because the address bar can ask for a location this row cannot name: a bookmark
 * kept past a location's retirement, a hand-typed identifier, or the dashboard's failure state,
 * where the payload that would have listed the locations is the payload that did not arrive. The
 * row's answer is to show what was asked for and say that it cannot name it - the identifier is
 * the only thing about that location the row knows, and it is also what the reader can see in the
 * address bar, so printing it is what lets the two be compared. Silently reading the parameter as
 * "every location" would be a figure-less dashboard under a dropdown claiming to show them all.
 */
const UNLISTED_OPTION_NOTE = '(not listed)';
const UNLISTED_LOCATION = 'a location this dashboard does not list';

/**
 * What the status line adds while the server is answering a filter change.
 *
 * Present tense and about the figures rather than about the row, because the figures are what the
 * reader is waiting for and what is still showing the previous filter's answer while they wait.
 * It leaves the row when the new figures arrive, which is the same moment the rest of the line
 * changes to describe them.
 */
const UPDATING_FIGURES = 'updating the figures';

/**
 * The keys that move a closed `<select>` from one option to the next, rather than choosing one.
 *
 * A browser fires `change` on a closed dropdown for every one of these presses, so a reader
 * arrowing from the last movement kind back to "Any movement" passes through four values that were
 * never asked for. Each of those was a dashboard request: the same query, the same figures and the
 * same cost as the one the reader meant, four times over, and the answers to all but the last were
 * discarded on arrival. The row therefore shows every press - a control that lags its own keyboard
 * is worse than a slow one - and asks the server only once the reader has finished, on blur, on
 * Enter, or through Apply.
 *
 * `Home`, `End`, `PageUp` and `PageDown` belong here for the same reason as the arrows: they land
 * on an option by moving, not by naming it. A letter key is deliberately absent - type-ahead names
 * the option it jumps to, which is a choice, and it applies at once like a pick from the open
 * dropdown does.
 */
const STEPPING_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/**
 * The key that finishes with a control: the one press that means "that is my answer".
 *
 * The headroom field needs no handler for it: the browser turns a press there into this form's
 * own submission, which {@link WarehouseFilter} applies. A `<select>` gets no such submission -
 * the browser spends the press on its own option picker instead - so the row watches for the key
 * itself, on the way down and again on the way up, for the reasons given at each. Naming it once
 * here is what keeps those two places and the headroom field's path answering to the same key.
 */
const COMMIT_KEY = 'Enter';

/**
 * The selling states the filter offers, with the wording its dropdown shows.
 *
 * `Record<StockState, string>` is what makes the list complete: add a state to the union in
 * `@/lib/types` and this object stops compiling until the dropdown has wording for it. The wording
 * is stated here rather than taken from `formatStockLabel`, which prints the units a state has to
 * promise beside its name ("In stock (128)") - right for a badge on a product, wrong for an option
 * that stands for every line in that state.
 */
const STOCK_STATE_LABELS: Record<StockState, string> = {
  IN_STOCK: 'In stock',
  LOW_STOCK: 'Low stock',
  OUT_OF_STOCK: 'Out of stock',
};

/**
 * The movement kinds the filter offers, each named by the storefront's one movement formatter, so
 * the dropdown reads exactly as the movement column of any table that lists them.
 */
const MOVEMENT_TYPE_LABELS: Record<MovementType, string> = {
  RECEIPT: formatMovementTypeLabel('RECEIPT'),
  SHIPMENT: formatMovementTypeLabel('SHIPMENT'),
  ADJUSTMENT: formatMovementTypeLabel('ADJUSTMENT'),
  TRANSFER: formatMovementTypeLabel('TRANSFER'),
  RESERVATION: formatMovementTypeLabel('RESERVATION'),
};

/**
 * Narrow the `string` a `<select>` reports to a selling state.
 *
 * A type predicate over the label map's own keys, checked at runtime, where an assertion would only
 * have silenced the compiler and let a value that is not a state reach the URL - which the schema
 * would then reject, turning an ordinary filter change into a failed page.
 */
function isStockState(value: string): value is StockState {
  return Object.hasOwn(STOCK_STATE_LABELS, value);
}

/** Narrow the `string` a `<select>` reports to a movement kind, for the same reason. */
function isMovementType(value: string): value is MovementType {
  return Object.hasOwn(MOVEMENT_TYPE_LABELS, value);
}

/* -------------------------------------------------------------------------------------------------
 * Reading what the controls hold
 * ---------------------------------------------------------------------------------------------- */

/**
 * Find the listed location a `warehouseId` parameter names, or `undefined` when it names none.
 *
 * The parameter carries an identifier - the `id` of one of the locations passed in - and is matched
 * against nothing else, which is the one reading the schema behind the feed accepts too: the short
 * code beside a location in the dropdown is how it is displayed, not a second name it answers to.
 *
 * `undefined` for a value that matches nothing is a statement about the LIST, not about the URL:
 * this row has no location to name, which is the answer the status line and the dropdown need. It
 * is deliberately not read as "every location" anywhere. That reading is how a stale bookmark
 * ended up showing a dropdown that said "All locations" over a notice about a filter, and how a
 * Clear click from that state compared equal to the URL it was trying to leave. The parameter is
 * carried instead - see {@link draftFromApplied} and {@link buildInventoryQuery} - and the reader
 * is told the location is not listed.
 */
function findWarehouse(
  warehouses: readonly WarehouseSummary[],
  named: string | null,
): WarehouseSummary | undefined {
  if (named === null) {
    return undefined;
  }

  const wanted = named.trim();

  if (wanted.length === 0) {
    return undefined;
  }

  return warehouses.find((warehouse) => warehouse.id === wanted);
}

/**
 * Read the headroom field's text as the whole number of units the schema accepts, or `null` when it
 * says nothing.
 *
 * Total: no input makes it throw. An empty field, a field holding only spaces and a field holding
 * something that is not a number all answer `null`, which this row reports by omitting the
 * parameter and letting the schema's default apply. Anything numeric is truncated to whole units
 * and clamped into the accepted range, so the value that reaches the URL is one the schema parses -
 * a reader who types past the ceiling gets the ceiling rather than a rejected page.
 */
function readThreshold(text: string): number | null {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return null;
  }

  const parsed = Number(trimmed);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.min(Math.max(Math.trunc(parsed), MIN_THRESHOLD), MAX_THRESHOLD);
}

/**
 * What the four controls currently hold, as text, exactly as a `<select>` and an `<input>` report
 * it. Values are judged on their way into the URL rather than on their way into this shape, so the
 * field a reader is still editing is never second-guessed under them.
 */
interface Draft {
  warehouseId: string;
  thresholdText: string;
  state: string;
  movement: string;
}

/**
 * The draft that describes an applied filter: what the controls should show for the dashboard the
 * reader is looking at.
 *
 * Used twice, from the same arguments, which is why it is a function rather than an object literal
 * written out in each place: once to seed the controls when the row mounts, and once each render to
 * derive the query the URL already carries, so that a comparison against it cannot drift from the
 * values the controls were seeded with.
 *
 * The location arrives as the parameter itself rather than as a location resolved against the
 * list, and that is the decision this shape exists to make. The controls are the reader's copy of
 * the address bar: a dropdown showing "All locations" while the URL asks for a location the
 * payload does not list disagrees with the address bar twice over - it misreports what the figures
 * beside it were produced under, and it makes choosing "All locations" a change of nothing, so the
 * one control that would recover fires no event. Carrying the parameter keeps the two in step; the
 * dropdown below renders an option for a value it does not list, and says that it does not.
 *
 * Trimmed on the way in, because that is what the schema did on the way out: the value handed back
 * has to be the value the URL carries, or the comparison the row makes before navigating would
 * read an untouched row as changed.
 */
function draftFromApplied(
  named: string | null,
  threshold: number,
  stockState: StockState | null,
  movementType: MovementType | null,
): Draft {
  return {
    warehouseId: named === null ? UNCONSTRAINED : named.trim(),
    thresholdText: String(threshold),
    state: stockState ?? UNCONSTRAINED,
    movement: movementType ?? UNCONSTRAINED,
  };
}

/**
 * Build the query string a draft asks for: the parameters that constrain something, and nothing
 * else.
 *
 * Three rules, and each is a decision about the URL rather than about this component. A filter
 * left unconstrained is omitted, so an unfiltered dashboard is addressed by its bare path. A
 * headroom figure equal to the schema's default is omitted too, because the parameter would say
 * exactly what its absence already says. `page` is never written, which is how changing a filter
 * returns to the first page of the new listing.
 *
 * The location is written as the control holds it, and is deliberately not checked against the
 * list first. Two properties follow, and both are load-bearing. The browser's own submission of
 * this `<form method="get">` submits the select's value, so writing anything else here would make
 * the enhanced path and the no-scripting path disagree about the same choice. And what this
 * function answers for the applied props is then, character for character, the query string the
 * address bar carries - which is what lets `commit` decide to navigate by asking whether the URL
 * would change, rather than by comparing two values it has already reinterpreted.
 */
function buildInventoryQuery(draft: Draft): string {
  const params = new URLSearchParams();
  const wanted = draft.warehouseId.trim();

  if (wanted.length > 0) {
    params.set(WAREHOUSE_PARAM, wanted);
  }

  const threshold = readThreshold(draft.thresholdText);

  if (threshold !== null && threshold !== DEFAULT_THRESHOLD) {
    params.set(THRESHOLD_PARAM, String(threshold));
  }

  if (isStockState(draft.state)) {
    params.set(STATE_PARAM, draft.state);
  }

  if (isMovementType(draft.movement)) {
    params.set(MOVEMENT_PARAM, draft.movement);
  }

  return params.toString();
}

/* -------------------------------------------------------------------------------------------------
 * The row
 * ---------------------------------------------------------------------------------------------- */

/**
 * The filter row's props: the locations it lists, and the filter the dashboard's figures were
 * produced under.
 *
 * The applied values arrive as props rather than being read from the address bar, because the page
 * has already parsed them to produce everything beside this row: passing them down keeps one
 * reading of the query string on the page and spares this component the suspense boundary that
 * reading it again would require. Each is optional and nullable in the shape the schema produces,
 * so `query.warehouseId`, `query.state` and `query.movement` can be handed over as they are.
 */
interface Props {
  /** Every stocking location the dashboard can report on, in the order it should list them. */
  warehouses: readonly WarehouseSummary[];

  /**
   * The applied `warehouseId` parameter - a stocking location's identifier. Absent means every one.
   */
  selectedWarehouseId?: string | null;

  /** The applied headroom figure, in units above a reorder point. */
  threshold: number;

  /** The applied selling-state constraint, or absent for no constraint. */
  stockState?: StockState | null;

  /** The applied movement-kind constraint, or absent for no constraint. */
  movementType?: MovementType | null;

  /**
   * The regions these controls govern - the figures, the stock table, the low-stock list - which
   * the row renders inside a wrapper it marks as busy while a filter change is in flight.
   *
   * Optional, and absent means no wrapper is rendered at all rather than an empty one. A caller
   * whose regions failed to arrive passes nothing: there is no stale figure to mark, and a notice
   * that is already announced politely must not be announced a second time as busy.
   */
  children?: ReactNode;

  /**
   * Classes for the element wrapping {@link Props.children}, which is the caller's to style: the
   * regions were the caller's own layout before they were passed here, and this component adds no
   * spacing, width or rhythm of its own to them.
   */
  bodyClassName?: string;

  /** Additional classes for the row, merged after `.root`. */
  className?: string;
}

/**
 * Render the row: the four labelled controls, the Apply group, the line that names the filter now
 * in force, and - where the caller passed them - the regions that filter governs, marked busy
 * while a change to it is in flight.
 */
export function WarehouseFilter({
  warehouses,
  selectedWarehouseId = null,
  threshold,
  stockState = null,
  movementType = null,
  children,
  bodyClassName,
  className,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  // What the controls would show for the dashboard on screen: the applied props, in the shape the
  // controls report. Computed every render and used for two different things - the values the
  // controls open on, and the query the address bar carries - so that neither can drift from the
  // other. React reads the `useState` argument on the first render only, which is what makes this
  // a seed rather than a mirror: a choice stays on screen while the server answers.
  const seed = draftFromApplied(selectedWarehouseId, threshold, stockState, movementType);
  const [draft, setDraft] = useState<Draft>(seed);

  // The applied location, or `undefined` when the parameter names a location this row was not
  // given - a stale bookmark, or a payload that failed to arrive and so listed none. The
  // difference matters to the wording below and to the dropdown, and to nothing else.
  const applied = findWarehouse(warehouses, seed.warehouseId);

  // The query most recently asked of the router, or `null` while this row has asked for nothing.
  // It is what makes a repeated request a no-op while the first one is still being answered:
  // clicking Apply blurs the headroom field first, so without it the blur and the click would send
  // the same navigation twice - the duplicate-request pattern this dashboard must not exhibit. It
  // is consulted only for as long as that answer is outstanding, for the reason given where it is
  // read. Written and read only in the handlers below, never during rendering.
  const requested = useRef<string | null>(null);

  // Whether the key currently held down is one that steps a closed dropdown through its options.
  // Set while such a key is down and cleared when it comes up, so it is true for exactly the
  // window in which that key's own `change` event arrives - which is what lets a change be read
  // as "passing over an option" or as "choosing one" without guessing from timing. A pick from an
  // open dropdown, by mouse or by Enter, arrives with no stepping key held and so applies at once.
  // A ref rather than state, because nothing on screen depends on it: re-rendering the row on a
  // key press would be work no reader can see.
  const stepping = useRef(false);

  // What the URL already carries, built from the applied parameters themselves. It is the
  // comparison to make before this row has navigated at all, so arriving at the dashboard and
  // immediately blurring an untouched field asks for nothing.
  //
  // Built from the raw URL parameters rather than from anything resolved against the location
  // list, so it stays correct when the URL names a location the payload does not list. A
  // comparator built from resolved values would read that state as "nothing is filtered", and the
  // Clear that recovers from it would compare equal to the URL it leaves and be dropped. Because
  // this string is the query string, a navigation is asked for exactly when it would change the
  // address bar.
  const appliedInventoryQuery = buildInventoryQuery(seed);

  // What the controls are asking for, in the same form: the query string the address bar would
  // carry if this draft were applied. Read twice below - to decide whether Clear has anything to
  // do, and to tell this row's own navigation landing apart from a filter change made elsewhere.
  const draftInventoryQuery = buildInventoryQuery(draft);

  // The applied query the controls were last seeded from, and the re-seeding it governs.
  //
  // The filter can change without this row doing it: the recovery link on the failure notice, a
  // navigation link to this route, the browser's Back button. The row stays mounted across all of
  // those - it is the same element in the same place of the same route - so nothing would
  // otherwise replace what the controls hold, and they would go on describing a filter the page is
  // no longer reporting under. That is a dropdown disagreeing with the address bar, which is the
  // defect this row exists to not have.
  //
  // A render-phase adjustment rather than an effect, which is React's own answer to "reset state
  // when a prop changes": the controls are correct in the first paint after the navigation instead
  // of one paint later, and no effect has to be kept in step with the props it mirrors.
  //
  // Two guards keep it from undoing the reason the draft exists at all - a choice must stay on
  // screen while the server answers, never snap back to the value still in the URL. A draft that
  // already describes the applied query needs no re-seeding: that is this row's own navigation
  // landing, and re-seeding would replace equal values with equal values. And while this row has a
  // navigation of its own in flight, the query that just landed answers an EARLIER choice rather
  // than the reader's latest one, so the controls keep what the reader last asked for and the
  // answer to it re-seeds them when it arrives.
  const [seeded, setSeeded] = useState(appliedInventoryQuery);

  if (seeded !== appliedInventoryQuery) {
    setSeeded(appliedInventoryQuery);

    if (!isPending && draftInventoryQuery !== appliedInventoryQuery) {
      setDraft(seed);
    }
  }

  // Whether Clear has anything to do, which is the question of whether this row is showing
  // anything other than the dashboard's opening state.
  //
  // Both sides are asked, and each catches a case the other misses. The applied query is what the
  // address bar carries, so a filtered dashboard is clearable however the reader got there,
  // including from a bookmark. The draft's own query is what the controls hold: a reader who has
  // typed a headroom figure or stepped a dropdown without applying it has something to reset even
  // though the URL is still bare, and Clear is the control that resets it - it puts the controls
  // back to the opening values, and asks for no navigation, because `commit` finds the URL it
  // would ask for is the URL already on screen.
  //
  // On the opening dashboard both sides are empty, and Clear then says so: `aria-disabled` on the
  // control below, which is the treatment this application already gives a dead control - the
  // stock table's pager marks its unavailable direction the same way, and `Button.module.css`
  // dims it, drops the pointer and takes the press away from that one attribute. The native
  // `disabled` attribute is deliberately NOT used: it would take the control out of the tab order,
  // so a reader moving through the row by keyboard would find the button missing rather than
  // find it and be told it is unavailable.
  const clearable = appliedInventoryQuery.length > 0 || draftInventoryQuery.length > 0;

  /**
   * Show a draft, and ask the router for the dashboard it describes.
   *
   * `replace` rather than `push`: trying three locations in a row is one intent, not three pages to
   * step back through. `scroll: false` keeps the reader's position, because the filtered figures
   * appear in the same place on the page. The navigation runs inside a transition, which is what
   * keeps the current figures on screen - dimmed by `.pending` - while the server produces the new
   * ones, rather than blanking the page.
   *
   * Nothing is asked for unless the URL would change, which is the whole of this row's request
   * cost: `query` is the query string the address bar would carry, `requested.current` is the last
   * one asked for and `appliedInventoryQuery` is the one on screen, so a draft that describes the
   * dashboard already being shown is shown and not fetched. Re-committing an unchanged value
   * therefore costs nothing, and a blur immediately followed by an Apply click - which is one
   * gesture, since pressing the button is what blurs the field - is one navigation rather than two.
   *
   * Worth knowing when counting requests against this row in development, because it looks like a
   * defect here and is not: Next.js answers the FIRST navigation to this route's bare path with an
   * empty flight response and then asks again for the payload, so a bare-path navigation can be
   * seen twice in the network panel. It is the router establishing a route tree it has no prefetch
   * for - `next dev` disables the prefetch wave that a production build performs - and it happens
   * once per session, to the searchless path only. Neither a `router.prefetch` here nor writing
   * default parameters into the URL would remove it; both would add a request to every visit
   * instead, and the second would cost the short bookmarkable URL the dashboard is worth having.
   */
  function commit(next: Draft): void {
    setDraft(next);
    stepping.current = false;

    const query = buildInventoryQuery(next);

    // What asking again would be asking for twice, which is one of two things depending on whether
    // an answer is outstanding. While a navigation of this row's is in flight the props still
    // describe the previous filter, so the query it asked for is the comparison to make - that is
    // the window the Apply-after-blur duplicate lives in, and the only window in which it does.
    // Otherwise the filter on screen is the comparison, and it is the only safe one: a query asked
    // for earlier and since navigated away from by a link or the Back button must not suppress a
    // navigation that genuinely changes the address bar, which is what consulting a spent request
    // outside its own window would do.
    const asked =
      isPending && requested.current !== null ? requested.current : appliedInventoryQuery;

    if (query === asked) {
      return;
    }

    requested.current = query;
    const href = query.length === 0 ? pathname : `${pathname}?${query}`;

    startTransition(() => {
      router.replace(href, { scroll: false });
    });
  }

  /**
   * A dropdown reported a new value: show it, and apply it unless the reader is still moving
   * through the options.
   *
   * The discrete choices still apply on change, which is what a reader expects from a dropdown and
   * what keeps the three selects usable without finding Apply. What does not happen any more is
   * applying an option the reader only passed over: see {@link STEPPING_KEYS} for what that costs
   * and how the difference is known. An unapplied draft is not a lost one - it is on screen, the
   * status line still names the filter the figures were produced under, and the next blur, Enter
   * or Apply sends it.
   */
  function choose(next: Draft): void {
    if (stepping.current) {
      setDraft(next);
      return;
    }

    commit(next);
  }

  function handleWarehouseChange(event: ChangeEvent<HTMLSelectElement>): void {
    choose({ ...draft, warehouseId: event.target.value });
  }

  function handleStockStateChange(event: ChangeEvent<HTMLSelectElement>): void {
    choose({ ...draft, state: event.target.value });
  }

  function handleMovementTypeChange(event: ChangeEvent<HTMLSelectElement>): void {
    choose({ ...draft, movement: event.target.value });
  }

  /**
   * Note whether the key now going down is one that steps a dropdown through its options, before
   * the `change` event that key produces arrives - and answer Enter, which is the press that means
   * the stepping is over.
   *
   * The note is assigned rather than only set, so any other key - a letter, Tab, Escape - clears it
   * in the same breath. Auto-repeat presses it again and again while the key is held, which is
   * exactly the run of changes this is here to keep quiet.
   *
   * ENTER IS ANSWERED ON THE WAY DOWN, and it has to be. Chrome opens a closed `<select>`'s own
   * option picker as the default action of this keydown, and that picker then takes the keyboard:
   * the press that opened it delivers no `keyup` to the page at all, so a row that waited for one
   * would leave a reader who arrowed to an option and pressed Enter looking at their choice
   * unapplied, with the figures and the status line still describing the previous filter, until
   * they pressed Enter a second time. Applying it here is also the behaviour a form control is
   * expected to have: Enter in a form means submit, which for this row means apply.
   *
   * It is answered only when there is something to apply, which is what keeps the native gesture
   * intact. With an untouched dropdown Enter is left to the browser, so it opens the picker as it
   * always did - and a choice made in there arrives as a `change` with no stepping key held, which
   * {@link choose} applies at once. Space and Alt+ArrowDown open the picker either way.
   */
  function handleSelectKeyDown(event: KeyboardEvent<HTMLSelectElement>): void {
    stepping.current = STEPPING_KEYS.has(event.key);

    if (event.key !== COMMIT_KEY || draftInventoryQuery === appliedInventoryQuery) {
      return;
    }

    event.preventDefault();
    commit(draft);
  }

  /**
   * The key is up: the reader has either finished stepping or finished choosing.
   *
   * Clearing the note first is what keeps the window this row treats as "still moving" no longer
   * than the press itself, so a mouse pick made straight afterwards applies immediately rather
   * than waiting for a blur.
   *
   * Enter is answered here as well as on the way down, because the two presses that reach the page
   * are different presses. {@link handleSelectKeyDown} sees the one made with the picker closed,
   * which is the arrowed choice being applied. This sees the one that CLOSED the picker - its own
   * keydown went to the picker rather than to the page - and the choice made in there has already
   * arrived as a `change`, so the commit is a second statement of a filter this row is already
   * asking for. Sending the same query twice is not a risk: {@link commit} asks for nothing when
   * the URL would not change, so both that press and an Enter that moved nothing cost nothing.
   */
  function handleSelectKeyUp(event: KeyboardEvent<HTMLSelectElement>): void {
    stepping.current = false;

    if (event.key === COMMIT_KEY) {
      commit(draft);
    }
  }

  /**
   * Finished with a dropdown: apply what it holds.
   *
   * This is where a stepped-through choice lands, and it is the same rule the headroom field has
   * always followed - a control applies when the reader has finished with it. Reaching Apply, the
   * next control or anywhere else on the page all blur this one, and each of those is the reader
   * moving on from a choice they have made.
   */
  function handleSelectBlur(): void {
    commit(draft);
  }

  /** Typing only shows what was typed. Nothing is applied until the field is finished with. */
  function handleThresholdChange(event: ChangeEvent<HTMLInputElement>): void {
    setDraft({ ...draft, thresholdText: event.target.value });
  }

  /**
   * Finish with the headroom field: normalise what it holds to the figure that will be applied -
   * so the field agrees with the dashboard beside it - and apply it.
   */
  function handleThresholdCommit(): void {
    const units = readThreshold(draft.thresholdText);

    commit({
      ...draft,
      thresholdText: units === null ? String(DEFAULT_THRESHOLD) : String(units),
    });
  }

  /**
   * The enhanced submission: Apply, and Enter in the headroom field, which the browser turns into
   * an ordinary submission. Both take the same path as finishing with that field, so a reader who
   * types a figure and presses Enter gets exactly what a reader who types it and clicks Apply gets.
   */
  function handleFilterSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    handleThresholdCommit();
  }

  /**
   * Clear every constraint: the bare dashboard, addressed by its own path.
   *
   * A scripting convenience rather than the only way out - without it, choosing each control's
   * unconstrained option and pressing Apply clears the filter just as well, which is what a reader
   * without scripting does.
   *
   * The guard is what makes the control's unavailability real rather than cosmetic. Its
   * `aria-disabled` attribute tells a reader the control is unavailable and the stylesheet takes
   * the pointer away from it, but neither stops Enter or Space from activating a button that is
   * still - correctly - in the tab order, so the decision is taken here as well as said there.
   */
  function handleClearFilters(): void {
    if (!clearable) {
      return;
    }

    commit({
      warehouseId: UNCONSTRAINED,
      thresholdText: String(DEFAULT_THRESHOLD),
      state: UNCONSTRAINED,
      movement: UNCONSTRAINED,
    });
  }

  // Whether the dropdown holds a value it has no option for: an identifier this row was not given
  // a location for. Read from the draft rather than from the applied parameter, because it is the
  // draft the `<select>` renders - a control whose `value` matches no option would show the first
  // option instead, and the row would be back to claiming a location it is not reporting on.
  const unlisted =
    draft.warehouseId.length > 0 && findWarehouse(warehouses, draft.warehouseId) === undefined;

  // How the status line names the location the figures beside it were produced under. Three cases:
  // a listed location by its code and name, no location parameter as "every location", and a
  // parameter this row cannot resolve as a location this dashboard does not list - never as
  // "every location", which would describe a different dashboard.
  const location =
    applied !== undefined
      ? `${applied.code} - ${applied.name}`
      : seed.warehouseId.length === 0
        ? 'every location'
        : UNLISTED_LOCATION;

  // The line under the controls: the filter the figures beside it were produced under, read from
  // the applied props rather than from the draft, so it never describes a dashboard that is not on
  // screen yet.
  //
  // The last part is the exception, and the only part that speaks about the request rather than
  // about the answer. While a change is in flight this paragraph is the one thing a reader who
  // cannot see the row's dim is told, and being told only once the figures have landed is being
  // told too late - it leaves the wait itself silent, with stale figures on screen and nothing
  // saying so. The politeness is deliberate: a filter change is the reader's own doing, so it is
  // queued behind whatever they are reading rather than interrupting it.
  const statusParts = [
    `Showing ${location}`,
    `low stock within ${formatQuantityLabel(threshold)} units of the reorder point`,
    stockState === null ? null : `state ${STOCK_STATE_LABELS[stockState]}`,
    // Specific on purpose: a movement kind bounds the units-moved figure alone, so the wording says
    // which figure it counts rather than implying the whole view is filtered to that kind.
    movementType === null
      ? null
      : `units moved counts ${MOVEMENT_TYPE_LABELS[movementType]} changes only`,
    isPending ? UPDATING_FIGURES : null,
  ];
  const status = statusParts.filter((part): part is string => part !== null).join(' \u00b7 ');

  return (
    <>
      <form
        className={clsx(styles.root, isPending && styles.pending, className)}
        method="get"
        onSubmit={handleFilterSubmit}
      >
        <FormField id={WAREHOUSE_FIELD_ID} label="Stocking location" className={clsx(styles.field)}>
          {({ id, describedBy }) => (
            <Select
              id={id}
              name={WAREHOUSE_PARAM}
              aria-describedby={describedBy}
              value={draft.warehouseId}
              onChange={handleWarehouseChange}
              onKeyDown={handleSelectKeyDown}
              onKeyUp={handleSelectKeyUp}
              onBlur={handleSelectBlur}
              scale="sm"
            >
              <option value={UNCONSTRAINED}>All locations</option>
              {warehouses.map((warehouse) => (
                <option key={warehouse.id} value={warehouse.id}>
                  {`${warehouse.code} - ${warehouse.name}`}
                </option>
              ))}
              {/*
                The option that holds a location the row was not given, rendered only while the
                control actually holds such a value - so the dropdown offers it as somewhere to
                come back from, never as somewhere to go. It carries the identifier because that is
                all the row knows about it, and it keeps the control's value a value it has an
                option for: choosing "All locations" over it is then a real change, which is what
                makes the one control that recovers from a stale filter fire an event at all.
              */}
              {unlisted ? (
                <option value={draft.warehouseId}>
                  {`${draft.warehouseId} ${UNLISTED_OPTION_NOTE}`}
                </option>
              ) : null}
            </Select>
          )}
        </FormField>

        <FormField
          id={THRESHOLD_FIELD_ID}
          label="Low-stock headroom"
          hint="Units above the reorder point"
          className={clsx(styles.field, styles.fieldNarrow)}
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              name={THRESHOLD_PARAM}
              aria-describedby={describedBy}
              type="number"
              inputMode="numeric"
              min={MIN_THRESHOLD}
              max={MAX_THRESHOLD}
              step={THRESHOLD_STEP}
              value={draft.thresholdText}
              onChange={handleThresholdChange}
              onBlur={handleThresholdCommit}
              scale="sm"
              numeric
            />
          )}
        </FormField>

        <FormField id={STATE_FIELD_ID} label="Stock state" className={clsx(styles.field)}>
          {({ id, describedBy }) => (
            <Select
              id={id}
              name={STATE_PARAM}
              aria-describedby={describedBy}
              value={draft.state}
              onChange={handleStockStateChange}
              onKeyDown={handleSelectKeyDown}
              onKeyUp={handleSelectKeyUp}
              onBlur={handleSelectBlur}
              scale="sm"
            >
              <option value={UNCONSTRAINED}>Any state</option>
              {Object.entries(STOCK_STATE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </FormField>

        <FormField id={MOVEMENT_FIELD_ID} label="Movement kind" className={clsx(styles.field)}>
          {({ id, describedBy }) => (
            <Select
              id={id}
              name={MOVEMENT_PARAM}
              aria-describedby={describedBy}
              value={draft.movement}
              onChange={handleMovementTypeChange}
              onKeyDown={handleSelectKeyDown}
              onKeyUp={handleSelectKeyUp}
              onBlur={handleSelectBlur}
              scale="sm"
            >
              <option value={UNCONSTRAINED}>Any movement</option>
              {Object.entries(MOVEMENT_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </FormField>

        <div className={styles.actions}>
          <Button type="submit" size="sm">
            Apply
          </Button>
          {/*
            `aria-disabled` rather than `disabled`, and the attribute is simply passed through:
            `Button` spreads what it does not destructure onto the `<button>`, and its stylesheet
            already carries the unavailable treatment for that attribute. Absent rather than
            `"false"` while the control is available, which is the form the rest of this application
            states an unavailable control in.
          */}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-disabled={clearable ? undefined : 'true'}
            onClick={handleClearFilters}
          >
            Clear
          </Button>
        </div>

        <p className={styles.status} aria-live="polite">
          {status}
        </p>
      </form>

      {/*
        The regions this row governs, marked busy for exactly as long as the server is answering a
        change to it. `aria-busy` is stated in both directions rather than left absent when the
        answer has landed, because a region that has finished updating is a fact worth stating to
        a reader who was told it started - and an attribute that appears and disappears is harder
        to observe than one that changes value.

        It sits outside the `<form>` on purpose. The form holds the four labelled fields, the
        Apply group and the status line, and its stylesheet lays those out as a wrapping row of
        columns; a region of figures inside it would be a fifth column of the filter row.
      */}
      {children === undefined ? null : (
        <div className={clsx(bodyClassName)} aria-busy={isPending ? 'true' : 'false'}>
          {children}
        </div>
      )}
    </>
  );
}
