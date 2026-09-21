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
 * quieter: the selects apply as soon as they change, and the enhanced path routes through the same
 * navigation the Apply button performs.
 *
 * APPLY TIMING IS A PRODUCT DECISION. A location, a stock state and a movement kind are discrete
 * choices, so each applies on change - one navigation per choice, which is what a reader expects
 * from a dropdown. The numeric headroom field is different: applying it per keystroke would fire a
 * burst of near-identical dashboard requests for "1", "12" and "125" on the way to "1250". It
 * therefore applies only when the reader has finished with it - on blur, on Enter (which the form
 * turns into an ordinary submission) or through Apply - and `requested` below makes a blur
 * immediately followed by an Apply click ask for one navigation rather than two. This dashboard is
 * the honest control surface of this application and carries no defect of its own; a chatty filter
 * row would read as one.
 *
 * WHAT IT HOLDS. The four controls' current text, seeded from the applied props and thereafter
 * owned here, so a choice stays on screen while the server answers instead of snapping back to the
 * value that is still in the URL. There is no effect of any kind - nothing mirrors props into
 * state, nothing runs on mount - and no timer, interval or subscription. The status line is read
 * from the props rather than from that state, so it always names the filter the figures beside it
 * were actually produced under.
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
 * WHY EVERY CLASS GOES THROUGH `clsx`, even a single one. Next.js types a CSS module as an index
 * signature, so `noUncheckedIndexedAccess` makes `styles.field` `string | undefined`, and
 * `FormField`'s `className` is an optional `string` that `exactOptionalPropertyTypes` will not let
 * `undefined` reach. `clsx` drops an absent value and always answers a string, which is what makes
 * one class and three compose the same way here - and what keeps the word "undefined" out of a
 * rendered class attribute, where a template string would have put it.
 */

import clsx from 'clsx';
import { usePathname, useRouter } from 'next/navigation';
import type { ChangeEvent, FormEvent } from 'react';
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
 * A value that matches nothing resolves to "every location" rather than being passed on, which is
 * what keeps a stale bookmark from asking for a location that no longer exists.
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
 */
function draftFromApplied(
  location: WarehouseSummary | undefined,
  threshold: number,
  stockState: StockState | null,
  movementType: MovementType | null,
): Draft {
  return {
    warehouseId: location === undefined ? UNCONSTRAINED : location.id,
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
 */
function buildInventoryQuery(draft: Draft, warehouses: readonly WarehouseSummary[]): string {
  const params = new URLSearchParams();
  const location = findWarehouse(warehouses, draft.warehouseId);

  if (location !== undefined) {
    params.set(WAREHOUSE_PARAM, location.id);
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

  /** Additional classes for the row, merged after `.root`. */
  className?: string;
}

/**
 * Render the row: the four labelled controls, the Apply group, and the line that names the filter
 * now in force.
 */
export function WarehouseFilter({
  warehouses,
  selectedWarehouseId = null,
  threshold,
  stockState = null,
  movementType = null,
  className,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const applied = findWarehouse(warehouses, selectedWarehouseId);
  const [draft, setDraft] = useState<Draft>(() =>
    draftFromApplied(applied, threshold, stockState, movementType),
  );

  // The query most recently asked of the router, or `null` while this row has asked for nothing.
  // It is what makes a repeated request a no-op: clicking Apply blurs the headroom field first, so
  // without it the blur and the click would send the same navigation twice - the duplicate-request
  // pattern this dashboard must not exhibit. Written and read only in the handlers below, never
  // during rendering.
  const requested = useRef<string | null>(null);

  // What the URL already carries, derived from the applied props. It is the comparison to make
  // before this row has navigated at all, so arriving at the dashboard and immediately blurring an
  // untouched field asks for nothing.
  const appliedInventoryQuery = buildInventoryQuery(
    draftFromApplied(applied, threshold, stockState, movementType),
    warehouses,
  );

  /**
   * Show a draft, and ask the router for the dashboard it describes.
   *
   * `replace` rather than `push`: trying three locations in a row is one intent, not three pages to
   * step back through. `scroll: false` keeps the reader's position, because the filtered figures
   * appear in the same place on the page. The navigation runs inside a transition, which is what
   * keeps the current figures on screen - dimmed by `.pending` - while the server produces the new
   * ones, rather than blanking the page.
   */
  function commit(next: Draft): void {
    setDraft(next);

    const query = buildInventoryQuery(next, warehouses);

    if (query === (requested.current ?? appliedInventoryQuery)) {
      return;
    }

    requested.current = query;
    const href = query.length === 0 ? pathname : `${pathname}?${query}`;

    startTransition(() => {
      router.replace(href, { scroll: false });
    });
  }

  function handleWarehouseChange(event: ChangeEvent<HTMLSelectElement>): void {
    commit({ ...draft, warehouseId: event.target.value });
  }

  function handleStockStateChange(event: ChangeEvent<HTMLSelectElement>): void {
    commit({ ...draft, state: event.target.value });
  }

  function handleMovementTypeChange(event: ChangeEvent<HTMLSelectElement>): void {
    commit({ ...draft, movement: event.target.value });
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
   */
  function handleClearFilters(): void {
    commit({
      warehouseId: UNCONSTRAINED,
      thresholdText: String(DEFAULT_THRESHOLD),
      state: UNCONSTRAINED,
      movement: UNCONSTRAINED,
    });
  }

  const statusParts = [
    `Showing ${applied === undefined ? 'every location' : `${applied.code} - ${applied.name}`}`,
    `low stock within ${formatQuantityLabel(threshold)} units of the reorder point`,
    stockState === null ? null : `state ${STOCK_STATE_LABELS[stockState]}`,
    movementType === null ? null : `movements ${MOVEMENT_TYPE_LABELS[movementType]}`,
  ];
  const status = statusParts.filter((part): part is string => part !== null).join(' \u00b7 ');

  return (
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
            scale="sm"
          >
            <option value={UNCONSTRAINED}>All locations</option>
            {warehouses.map((warehouse) => (
              <option key={warehouse.id} value={warehouse.id}>
                {`${warehouse.code} - ${warehouse.name}`}
              </option>
            ))}
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
        <Button type="button" variant="secondary" size="sm" onClick={handleClearFilters}>
          Clear
        </Button>
      </div>

      <p className={styles.status} aria-live="polite">
        {status}
      </p>
    </form>
  );
}
