/*
 * FormField - the label-and-message wrapper every form control in the Lumen Supply storefront sits
 * inside: the checkout address and contact fields, the cart's quantity boxes, and the catalog
 * toolbar's search, sort and page-size controls.
 *
 * It exists because of a division of labour this folder settles once. `Input` and `Select` render
 * one native control each and forward every attribute untouched; they deliberately do NOT own their
 * label association, and `aria-describedby` is an ordinary forwarded prop on both. This component
 * owns the other half: the `<label htmlFor>`, the optional hint, the optional validation message,
 * the optional character counter, the ids that tie those three messages to the control, and the
 * vertical rhythm between them.
 *
 * THE CHILD IS A FUNCTION, AND THAT IS THE WHOLE DESIGN. The field hands the caller the control id
 * and the finished `aria-describedby` value and takes the control back:
 *
 *   <FormField id="postal" label="Postal code" hint="We use this for freight quotes." error={problem}>
 *     {(field) => (
 *       <Input
 *         id={field.id}
 *         aria-describedby={field.describedBy}
 *         invalid={problem !== undefined}
 *         name="postal"
 *       />
 *     )}
 *   </FormField>
 *
 * Every other shape leaks the contract. A plain `ReactNode` child would leave the caller to
 * re-derive `"postal-error postal-hint"` by hand from a documented convention, and a caller who
 * forgets it ships an error message that is rendered but never announced - worse than no message,
 * because the field looks handled. Cloning the child instead (`cloneElement`) would guess at which
 * element wants the attribute, fight React 19's prop typings, and silently drop props on a child
 * that is a fragment, a wrapper or a component of the caller's own. Passing the values down is the
 * only version where the wiring cannot be half-done.
 *
 * NO `useId`. The id is required and caller-supplied. `useId` is a hook, so reaching for it would
 * put a `'use client'` boundary on this module and therefore on every page that renders a form -
 * including the checkout form, which is a server component. Ids derived purely from the `id` prop
 * also make the server and client markup identical by construction, so no field here can produce a
 * hydration mismatch. Callers use stable, human-readable ids ("postal", "email", "catalog-sort"),
 * which is what makes the rendered DOM legible while debugging this application.
 *
 * NOTHING ELSE. No state, no effects, no `'use client'`, no `style` prop, no inspection of the
 * children: the control the caller returns is rendered exactly as it arrives, and appearance comes
 * from `FormField.module.css` (this wrapper) plus `Input.module.css` / `Select.module.css` (the
 * control's own box).
 */

import clsx from 'clsx';
import type { ReactNode } from 'react';

import { formatQuantityLabel } from '@/lib/format';

import styles from './FormField.module.css';

/**
 * How much of a field's allowance has to be spent before its counter appears.
 *
 * A capped field that shows `0/120` from the first keystroke turns a calm form
 * into a row of meters, and the number is useless while the value is nowhere
 * near the bound. It becomes useful as the bound approaches, which is what this
 * fraction picks out: the counter is silent for the first four fifths of the
 * allowance and visible - and then, past the bound, emphatic - for the last
 * fifth, which is the only stretch where a writer needs to know how much room
 * is left.
 */
const COUNTER_SHARE = 0.8;

/**
 * The field's props.
 *
 * Kept local and deliberately not exported under any name. A `FormFieldProps` declared here would
 * become demo vocabulary that `scripts/check-no-hardcoding.mjs --update` harvests into
 * `scripts/no-hardcoding.policy.json`, after which no product file may contain that literal. A
 * caller that needs this shape writes `ComponentProps<typeof FormField>`.
 *
 * `hint` and `error` are optional rather than `ReactNode | undefined` properties because
 * `ReactNode` already includes `undefined`: `error={problem}` with a `string | undefined` value is
 * legal under `exactOptionalPropertyTypes`, which is exactly how a validated form passes its
 * messages in.
 */
interface Props {
  /**
   * The control's `id`. Used verbatim for the label's `htmlFor` and as the stem of the two message
   * ids (`<id>-hint`, `<id>-error`), so it must match the `id` the child puts on its control - which
   * it does by construction, because the child receives it from this component.
   */
  id: string;

  /** The label's content. Rendered inside the `<label>`; clicking it focuses the control. */
  label: ReactNode;

  /**
   * Supporting guidance under the control - a format example, a units note. Announced with the
   * control through `aria-describedby`, never as a loose paragraph.
   */
  hint?: ReactNode;

  /**
   * The validation message. Its presence is what puts the field in error visually and what adds the
   * first `aria-describedby` reference; the control's own red edge and `aria-invalid` come from the
   * `invalid` prop the caller passes to `Input` or `Select`, so a field in error states it in both
   * places from one piece of caller state.
   *
   * The paragraph it renders carries `role="alert"`, so a message that appears while the reader is
   * working through the form is announced when it appears rather than only when the control is
   * focused again. That is the whole reason the role is on this element and not on the wrapper: the
   * paragraph exists only while there is something wrong, so the live region's content is never
   * anything but the problem.
   */
  error?: ReactNode;

  /**
   * How much of a bounded field's allowance the current value spends, as `{ length, max }` in
   * characters.
   *
   * Supplied by a caller that caps a field's length in its own validation - the checkout form is
   * the one that does - and it exists because the alternative is worse. A `maxLength` attribute
   * enforces the same bound by discarding keystrokes silently: the value stops growing, no event
   * fires that the application can see, `validity.tooLong` stays `false`, and the message the
   * caller wrote about the bound can never be reached. So the control takes the whole of what is
   * typed, the caller's validation reports a value that is too long, and this counter shows the
   * reader where they are before it happens.
   *
   * Omit it for a field with no bound: an absent counter renders nothing and adds no
   * `aria-describedby` reference.
   */
  count?: { length: number; max: number };

  /**
   * Whether to draw the asterisk after the label text. Decoration only: the marker is hidden from
   * the accessibility tree, and requiredness reaches assistive technology through the control's own
   * native `required` attribute, which the caller sets.
   */
  required?: boolean;

  /** Additional classes for the field column, merged after `.root`. */
  className?: string;

  /**
   * Render the control. Receives the id to put on it and the `aria-describedby` value to forward,
   * which is `undefined` when the field has neither a hint nor an error - so the attribute is
   * absent from the DOM rather than present and empty.
   */
  children: (field: { id: string; describedBy: string | undefined }) => ReactNode;
}

/**
 * Render the field: label, the caller's control, then the hint, the error message and the counter.
 *
 * The three message ids are derived only where their message is actually rendered, so
 * `aria-describedby` can never point at an element that is not in the document. They are listed
 * error first: a screen-reader user hears what is wrong before hearing the guidance that was
 * already there when the value was entered, and the counter comes last because it is the least of
 * the three - a number that only matters while the value is close to its bound. The filter carries
 * an inline type predicate, which is what narrows the list to `string[]` under `strict` with no
 * cast, no non-null assertion and no array indexing, and the trailing `|| undefined` turns the
 * empty join - a field with none of the three - into an omitted attribute rather than
 * `aria-describedby=""`.
 *
 * The counter's own two states are derived the same way. `shown` is what keeps it out of the way
 * until the last fifth of the allowance (see {@link COUNTER_SHARE}); `over` is the value having
 * passed the bound, which the stylesheet turns from a quiet number into a warning one. The count
 * is rendered through `@/lib/format`, which pins the locale, so the figure the server sent and the
 * figure this page hydrates are the same string.
 *
 * `clsx` composes the class list because Next.js types a CSS module as an index signature, which
 * `noUncheckedIndexedAccess` turns into `string | undefined`; `clsx` drops an absent value where a
 * template string would interpolate the word "undefined" into the attribute.
 */
export function FormField({
  id,
  label,
  hint,
  error,
  count,
  required = false,
  className,
  children,
}: Props) {
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const shown = count !== undefined && count.length >= Math.ceil(count.max * COUNTER_SHARE);
  const over = count !== undefined && count.length > count.max;
  const counter = shown ? `${id}-count` : undefined;
  const describedBy =
    [errorId, hintId, counter].filter((value): value is string => value !== undefined).join(' ') ||
    undefined;

  return (
    <div className={clsx(styles.root, className)}>
      <label className={styles.label} htmlFor={id}>
        {label}
        {required ? (
          <span className={styles.required} aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children({ id, describedBy })}
      {hint === undefined ? null : (
        <p className={styles.hint} id={hintId}>
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p className={styles.error} id={errorId} role="alert">
          {error}
        </p>
      )}
      {count === undefined || !shown ? null : (
        <p className={styles.counter} id={counter} data-over={over ? 'true' : undefined}>
          {`${formatQuantityLabel(count.length)}/${formatQuantityLabel(count.max)} characters`}
        </p>
      )}
    </div>
  );
}
