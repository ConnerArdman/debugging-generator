'use client';

/*
 * QuantityStepper - the quantity control of one cart line.
 *
 * Rendered by `./CartLineRow.tsx` into its `.controls` cell, and by nothing else: a decrement
 * button, a numeric field and an increment button, with a visually-hidden label and a polite
 * status region beside them. The shopper changes how many units of one product the cart holds;
 * everything else about that line - the thumbnail, the price, the line total and the remove
 * control - belongs to the row.
 *
 * ONE COMMIT PER DECISION, NEVER ONE PER KEYSTROKE
 * Typing into the field changes local state and nothing else. `onCommit` fires from exactly three
 * places - a press of either button, Enter in the field, and the field losing focus - and only
 * when the value it would send actually differs from the `quantity` prop, so tabbing through the
 * row, or blurring a field nobody edited, mutates nothing. That matters more here than it looks:
 * a cart mutation is a request, a re-render and a total to recompute, and a control that fired one
 * per character would put five of them on the wire for "12" and make the interaction under
 * investigation impossible to read.
 *
 * WHO OWNS THE VALUE
 * The `quantity` prop is authoritative; the string in the field is a draft of the shopper's next
 * decision. The two are reconciled in two directions:
 *
 *   - Down, when the prop changes: the draft is replaced, so a quantity changed from anywhere else
 *     (another surface, a server reconciliation, this row's own accepted mutation) is what the
 *     field shows. That reconciliation is the render-time adjustment React documents for adjusting
 *     state when a prop changes (https://react.dev/learn/you-might-not-need-an-effect), guarded by
 *     the previous value it has already seen, NOT an effect: an effect that called `setDraft` in
 *     its body would cascade a second render for a value this component already has in hand, which
 *     is both slower and what `react-hooks/set-state-in-effect` (error under this repository's lint
 *     gate) exists to prevent.
 *   - Up, on every commit: the draft returns to the authoritative value immediately. If the
 *     mutation is accepted, the new `quantity` arrives and the adjustment above shows it; if it is
 *     rejected - out of stock, a failed request, a cart the server trimmed - the field shows the
 *     quantity that is really in the cart rather than the number the shopper typed. A control that
 *     kept the typed text would be quietly lying about the cart's contents.
 *
 * NO MEMOIZATION, DELIBERATELY
 * No `memo`, no `useMemo`, no `useCallback`, no derived-state cache, and handlers that are new
 * functions on every render. `CartProvider` republishes its context value at
 * `ShippingEtaProvider`'s 250 ms cadence, so this control re-renders about four times a second
 * while the cart is open. That is AAP 0.8.2's second seeded defect propagating through exactly
 * this path, and it is the behaviour the tool under development is meant to find and explain:
 * memoizing here would damp the symptom in one component and hide it, which is a worse outcome
 * than the renders themselves. Local `useState` is the only hook in the file.
 *
 * Nothing here reads a clock, a random source, `window` or `document`, and nothing schedules a
 * timer, so the markup the server renders and the markup the browser first produces agree, and a
 * capture of this interaction records no hydration warning to explain away.
 *
 * APPEARANCE AND ACCESSIBILITY ARE BOTH SOMEONE ELSE'S
 * `./QuantityStepper.module.css` owns the layout and exports exactly four classes - `.root`,
 * `.label`, `.field`, `.status` - and reads two states off the root element, `data-busy` while a
 * mutation is in flight and `data-invalid` while the entered value is out of range; both are
 * written below and neither is spelled anywhere else. The controls' own chrome, and the one focus
 * ring the application draws (`--ls-focus`, from `app/globals.css`), belong to `../ui/Button` and
 * `../ui/Input`: this file sets no `tabIndex`, suppresses no focus style and chooses no colour,
 * so the field and both buttons are reachable and operable by keyboard exactly as every other
 * control in the storefront is. The accessible names are real text through `../ui/VisuallyHidden`
 * rather than `aria-label` strings, so they are translatable markup, and the glyphs the buttons
 * paint are `aria-hidden` - a screen reader hears "Decrease quantity of <product>", never "minus".
 */

import clsx from 'clsx';
import type { ReactElement } from 'react';
import { useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import { formatQuantityLabel } from '@/lib/format';

import styles from './QuantityStepper.module.css';

/**
 * The smallest quantity a cart line may hold. A line is removed, never zeroed: this control
 * therefore has no route to 0, and reaching it is the remove button's job on the row above.
 */
const MIN_LINE_QUANTITY = 1;

/**
 * The ceiling applied when a caller states none. Two digits is what `.field` is sized for, and a
 * B2B line beyond it is a quote rather than a cart edit.
 */
const DEFAULT_MAX_LINE_QUANTITY = 99;

/**
 * Bring any number a shopper can produce into the line's permitted range, as a whole number of
 * units.
 *
 * Pure and module-level, so it is the same function for every row and can be reasoned about
 * without a component in hand. Non-finite input - an empty field, letters, `Infinity` - answers
 * the minimum rather than throwing; callers that must distinguish "nothing was entered" from "1
 * was entered" check that before asking, which `commit` below does.
 *
 * The ceiling is applied before the floor on purpose. For every `max` at or above
 * `MIN_LINE_QUANTITY` the order makes no difference, but it means a caller that passes a smaller
 * one - 0, or a negative - still cannot make this function answer a quantity that would empty the
 * line, so "never commit 0" holds without depending on a prop nobody validated.
 */
function clampQuantity(value: number, max: number): number {
  if (!Number.isFinite(value)) {
    return MIN_LINE_QUANTITY;
  }

  return Math.max(Math.min(Math.trunc(value), max), MIN_LINE_QUANTITY);
}

/**
 * Props of `QuantityStepper`, intentionally local and unexported: `packages/panel-renderer`
 * publishes its own component catalog and this repository's hardcoding guard harvests this
 * workspace's multi-token identifiers into a policy no product file may then contain, so this
 * workspace puts exactly one new name - `QuantityStepper` - into circulation. A caller that needs
 * this shape reads it back with `React.ComponentProps<typeof QuantityStepper>`.
 */
interface Props {
  /**
   * Identity of the cart line this control edits, used only to derive the field's DOM id. The row
   * can derive the same id from the same line, which is why it is a prop rather than a `useId()`
   * value: a caller that wants to move focus into this field, or point its own copy at it, needs
   * the id to be predictable.
   */
  lineId: string;

  /** The quantity the cart currently holds for this line. Authoritative; never a draft. */
  quantity: number;

  /** Upper bound, typically the available stock. Defaults to {@link DEFAULT_MAX_LINE_QUANTITY}. */
  max?: number;

  /** The line cannot be edited at all - a closed cart, a discontinued product. */
  disabled?: boolean;

  /**
   * A quantity mutation for this line is in flight. Dims the group, holds both buttons and the
   * field, and is announced through `aria-busy`; it is deliberately separate from `disabled`,
   * which means "not editable" rather than "working".
   */
  busy?: boolean;

  /**
   * The product's name. Used only to build the accessible names of the field and the two buttons,
   * so a shopper with a screen reader hears which line they are changing in a cart of many.
   */
  itemLabel: string;

  /**
   * Accept a new quantity for this line. Called with a whole number inside the permitted range,
   * only when it differs from `quantity`, and never with 0 - removing a line is the row's
   * affordance, not this one's. Synchronous by contract: the caller owns the request, the optimism
   * and the `busy` flag it passes back.
   */
  onCommit: (quantity: number) => void;

  /** Additional classes, merged after `.root`. */
  className?: string;
}

/**
 * Renders the stepper.
 *
 * @example One line of the cart drawer. The row owns the mutation and reports it back as `busy`,
 * and the stepper reports only the quantity the shopper asked for.
 * ```tsx
 * <QuantityStepper
 *   lineId={line.id}
 *   quantity={line.quantity}
 *   max={line.availableUnits}
 *   busy={pendingLineId === line.id}
 *   itemLabel={line.productName}
 *   onCommit={(next) => updateLineQuantity(line.id, next)}
 * />
 * ```
 */
export function QuantityStepper({
  lineId,
  quantity,
  max = DEFAULT_MAX_LINE_QUANTITY,
  disabled = false,
  busy = false,
  itemLabel,
  onCommit,
  className,
}: Props): ReactElement {
  // What the shopper has typed, as typed - not a number, because "" and "1" are different states
  // of an entry in progress and `Number('')` is 0, which is not a quantity this control can hold.
  const [draft, setDraft] = useState<string>(String(quantity));

  // The `quantity` the draft above was built from. Its only purpose is the comparison below.
  const [syncedQuantity, setSyncedQuantity] = useState<number>(quantity);

  // Prop -> state reconciliation, during render rather than in an effect (see the header). React
  // re-runs this component immediately and discards this pass without touching the DOM, so the
  // field never paints a stale value, and the guard makes it a no-op on the ~4 renders a second
  // this control takes from its provider while the quantity itself is unchanged.
  if (syncedQuantity !== quantity) {
    setSyncedQuantity(quantity);
    setDraft(String(quantity));
  }

  const quantityFieldId = `cart-qty-${lineId}`;
  const quantityHintId = `${quantityFieldId}-status`;

  // `Number.parseInt` is the same reading the commit path takes, so what the field reports as
  // invalid and what a commit would clamp cannot disagree.
  //
  // Two entries are deliberately NOT invalid. An empty or unparseable box is unfinished, not
  // wrong, and flagging it while the shopper is still clearing it would be noise. And an entry
  // that still equals the cart's own quantity is never flagged either, whatever `max` says: a
  // ceiling that has dropped below a quantity the cart already holds - stock sold out from under
  // an open cart - is a stock problem for the row to report, and telling the shopper that the
  // truth is out of range, with `aria-invalid` on a field they have not touched, would be this
  // control contradicting the cart it is editing.
  const entered = Number.parseInt(draft, 10);
  const edited = draft !== String(quantity);
  const enteredOutOfRange =
    edited && Number.isFinite(entered) && (entered < MIN_LINE_QUANTITY || entered > max);

  const locked = disabled || busy;

  /**
   * Route every commit through one place: restore the field, reject what is not a number, and ask
   * the caller only for a change it does not already have.
   *
   * The field's own two commit points additionally require `edited`, so an untouched entry cannot
   * mutate anything. In ordinary use that is already true of this function - a clamped quantity
   * equals itself - but it is not true when `max` has fallen below the quantity the cart holds:
   * without that guard, tabbing through such a line would clamp it down to the new ceiling and
   * trim the cart on the way past, which is a mutation nobody asked for. The buttons are exempt
   * because pressing one IS the request.
   */
  function commit(next: number): void {
    // Unconditional, and first: whatever the shopper typed, the field goes back to showing the
    // cart's own quantity. An accepted mutation arrives as a new prop and replaces it in the same
    // React batch, so there is no intermediate frame; a rejected one leaves the truth on screen.
    setDraft(String(quantity));

    if (!Number.isFinite(next)) {
      // An empty box or a stray keystroke committed on blur. The field is restored above and the
      // cart is left alone - the shopper asked for nothing.
      return;
    }

    const wanted = clampQuantity(next, max);

    if (wanted !== quantity) {
      onCommit(wanted);
    }
  }

  return (
    <div
      className={clsx(styles.root, className)}
      data-busy={busy ? 'true' : undefined}
      data-invalid={enteredOutOfRange ? 'true' : undefined}
      aria-busy={busy}
    >
      {/* `.label` is `display: contents`, and the text inside is clipped and out of flow, so this
          element names the field for assistive technology at no cost to the row's layout. */}
      <label htmlFor={quantityFieldId} className={styles.label}>
        <VisuallyHidden>{`Quantity for ${itemLabel}`}</VisuallyHidden>
      </label>

      <Button
        variant="secondary"
        size="sm"
        disabled={locked || quantity <= MIN_LINE_QUANTITY}
        onClick={() => {
          commit(quantity - 1);
        }}
      >
        <span aria-hidden="true">&minus;</span>
        <VisuallyHidden>{`Decrease quantity of ${itemLabel}`}</VisuallyHidden>
      </Button>

      <Input
        id={quantityFieldId}
        // `clsx` rather than the class directly: a CSS-module lookup is `string | undefined` under
        // this repository's `noUncheckedIndexedAccess`, and `Input` declares `className?: string`.
        className={clsx(styles.field)}
        // `scale`, the field's density prop - not `numeric`, whose right alignment would outrank
        // the centred digits `.field` declares.
        scale="sm"
        type="number"
        inputMode="numeric"
        min={MIN_LINE_QUANTITY}
        max={max}
        step={1}
        autoComplete="off"
        value={draft}
        disabled={locked}
        invalid={enteredOutOfRange}
        aria-describedby={enteredOutOfRange ? quantityHintId : undefined}
        onChange={(event) => {
          // The draft, and only the draft. No mutation, no request, no debounce to reason about.
          setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            // Committing is this control's answer to Enter; submitting the surrounding form is
            // not, and a cart drawer inside a checkout form would do exactly that.
            event.preventDefault();

            if (edited) {
              commit(Number.parseInt(draft, 10));
            }
          }
        }}
        onBlur={() => {
          // Only an entry the shopper actually changed is worth a commit: focus passing through
          // a row is not a decision about it (see `commit`).
          if (edited) {
            commit(Number.parseInt(draft, 10));
          }
        }}
      />

      <Button
        variant="secondary"
        size="sm"
        disabled={locked || quantity >= max}
        onClick={() => {
          commit(quantity + 1);
        }}
      >
        <span aria-hidden="true">+</span>
        <VisuallyHidden>{`Increase quantity of ${itemLabel}`}</VisuallyHidden>
      </Button>

      {/* Mounted at all times, so a change to its text is what gets announced rather than the
          region appearing. It carries the committed quantity - read from the prop, never from the
          draft, so nothing is announced until the cart has actually changed - and turns into a
          visible range hint while the entry is out of range, which is the state `.status` is
          coloured for and the reason the field points `aria-describedby` here. The wording carries
          the meaning; the colour only emphasises it. */}
      <span id={quantityHintId} role="status" aria-live="polite" className={styles.status}>
        {enteredOutOfRange ? (
          `Enter ${formatQuantityLabel(MIN_LINE_QUANTITY)}\u2013${formatQuantityLabel(max)}`
        ) : (
          <VisuallyHidden>{formatQuantityLabel(quantity)}</VisuallyHidden>
        )}
      </span>
    </div>
  );
}
