/*
 * Select - the dropdown primitive of the Lumen Supply storefront.
 *
 * One native `<select>`, wearing `Select.module.css`'s `.root` class, with the two appearance
 * choices expressed as the data attributes that stylesheet selects on (`data-size`, `data-invalid`)
 * and every other attribute forwarded to the platform untouched. Three places mount it: the catalog
 * toolbar's sort-order and page-size dropdowns and the checkout form's shipping-option dropdown.
 *
 * WHY THE PLATFORM'S CONTROL, AND NOT A CUSTOM LISTBOX. A hand-built dropdown would have to
 * re-implement, correctly, everything the native one already does: roving focus with the arrow
 * keys, Enter and Space to open, Escape to dismiss, type-ahead over the option labels,
 * `aria-activedescendant` bookkeeping, and a focus trap while the list is open. It would also need
 * a portal to escape its scroll container, which on this storefront means competing with the cart
 * drawer's stacking context. The native control gets all of that right for free, in every engine,
 * and `appearance: none` in the stylesheet restyles the closed control without touching the popup -
 * so the role, the keyboard behaviour and the assistive-technology semantics here are the
 * platform's, not this file's. It is also the only option available: this workspace is an
 * instrumentation target that depends on `clsx`, `next`, `react` and nothing else, and may add no
 * dependency.
 *
 * DIVISION OF LABOUR. This component owns the control's own box and nothing around it.
 *
 *   * `FormField` renders the label, the hint and the error message, associates the label with
 *     `for`/`id` and wires `aria-describedby`. It is why `invalid` here is only an attribute pair:
 *     the meaning of the error is carried by FormField's words, never by this border's colour
 *     alone. Clicking that label focuses this control, because the control is a real form element.
 *   * The caller supplies the `<option>` and `<optgroup>` children and owns the value. Nothing here
 *     injects a placeholder option, re-orders, filters or counts the children, holds a value in
 *     state, or reads the DOM - so a controlled caller stays controlled and an uncontrolled one
 *     (`defaultValue`) stays uncontrolled, which is what keeps hydration quiet.
 *
 * `scale`, NOT `size`. `<select>` has a native `size` attribute - the number of rows a list box
 * shows - so the visual density prop is named `scale` and the native attribute keeps its meaning
 * and its type through the spread. `Input` makes the same trade for the same reason.
 *
 * Server component by default: this file opens with no client-component directive. The parent that
 * owns `value` and `onChange` carries the client boundary, so this module renders from either side.
 */

import clsx from 'clsx';
import type { ComponentPropsWithRef } from 'react';

import styles from './Select.module.css';

/**
 * Every attribute the platform's `<select>` takes - including `ref`, which React 19 passes as an
 * ordinary prop, so this component needs no ref-forwarding wrapper - plus the two choices, and
 * `className` re-declared after being omitted because it composes with `.root` rather than
 * replacing it.
 *
 * Local, and deliberately not exported under any name. A `SelectProps` declared here would be demo
 * vocabulary that `scripts/check-no-hardcoding.mjs --update` harvests into
 * `scripts/no-hardcoding.policy.json`, after which no product file could contain that literal - and
 * `packages/panel-renderer` has a `Select` primitive of its own. A caller that needs this shape
 * writes `ComponentProps<typeof Select>`.
 */
interface Props extends Omit<ComponentPropsWithRef<'select'>, 'className'> {
  /**
   * Density of the closed control: `'sm'` for a toolbar row, `'md'` for a form field. `'md'` is the
   * stylesheet's base, so it carries no rule of its own and a control rendered without the
   * attribute would look identical; the attribute is still written, so the rendered DOM states
   * which variant was asked for.
   */
  scale?: 'sm' | 'md';

  /**
   * Whether the field failed validation. Sets `data-invalid` for the stylesheet's red edge and
   * `aria-invalid` for assistive technology; the message that explains the failure is
   * `FormField`'s.
   */
  invalid?: boolean;

  /**
   * Classes from the caller - placement in a grid or a flex row, a width override. Composed after
   * `.root`, so it adds to the control's appearance instead of erasing it.
   */
  className?: string;
}

/**
 * Render the dropdown.
 *
 * Two details in the markup below are load-bearing rather than stylistic:
 *
 *   * `clsx` composes the class list. `Select.module.css` is typed by Next.js as an index
 *     signature, and `noUncheckedIndexedAccess` therefore makes `styles.root` `string | undefined`;
 *     `clsx` drops an absent value where a template string would interpolate the word "undefined"
 *     into the attribute. That is why this is `clsx` and not concatenation, and why no non-null
 *     assertion is needed.
 *   * `{...rest}` comes last, so an attribute the caller states explicitly wins over the defaults
 *     computed here. A field that needs finer ARIA than a boolean - `aria-invalid="spelling"` on a
 *     contact field, say - can state it and have it survive.
 *
 * @example Catalog toolbar sort order: the parent owns the value, so the parent is the client
 * component.
 * ```tsx
 * <Select scale="sm" value={sort} onChange={(event) => setSort(event.target.value)}>
 *   <option value="relevance">Most relevant</option>
 *   <option value="price-asc">Price: low to high</option>
 * </Select>
 * ```
 *
 * @example A field in error. The wrapper it sits inside supplies the label and the message that
 * explains the failure; this control supplies the red edge and `aria-invalid`.
 * ```tsx
 * <Select id="shipping" invalid required defaultValue="">
 *   <option value="">Choose a shipping option</option>
 *   <option value="ground">Ground - 5 business days</option>
 * </Select>
 * ```
 */
export function Select({ scale = 'md', invalid = false, className, children, ...rest }: Props) {
  return (
    <select
      className={clsx(styles.root, className)}
      data-size={scale}
      data-invalid={invalid ? 'true' : undefined}
      aria-invalid={invalid ? 'true' : undefined}
      {...rest}
    >
      {children}
    </select>
  );
}
