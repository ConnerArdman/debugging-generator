/**
 * Input - the text-field primitive of the Lumen Supply storefront.
 *
 * Every place a buyer types lands here: the site header's catalog search, the checkout address and
 * contact fields, and the quantity boxes in the cart. The component is deliberately thin. It
 * renders one native `<input>`, applies this folder's stylesheet to it, and forwards everything
 * else untouched - so the field behaves like the HTML element it is, and the two things that
 * usually get tangled up in a form primitive stay where they belong:
 *
 *   * The value belongs to the caller. There is no internal state, no debounce and no
 *     transformation of what is typed, which is what makes the field equally usable controlled
 *     (`value` with `onChange`) and uncontrolled (`defaultValue`, or neither).
 *   * The label, the hint and the error message belong to `FormField`. It renders the
 *     `<label htmlFor>` and the two message paragraphs and tells the caller which element ids to
 *     pass back here as `aria-describedby` - which is precisely why that attribute is an ordinary
 *     forwarded prop below rather than something this component computes.
 *
 * Appearance is owned entirely by `Input.module.css`, which exports a single `.root` class and
 * expresses every variant as an attribute selector. Hover, focus, read-only and disabled are keyed
 * off the pseudo-classes the browser already sets; density, the error emphasis and numeric
 * alignment are keyed off the three data attributes written below. There is no class-name lookup
 * map to keep in step with the stylesheet, and this component therefore chooses no colours,
 * spacing or type sizes of its own.
 *
 * No `'use client'` directive. The component holds no state and subscribes to nothing, so it
 * renders inside a server component as happily as inside a client one; a parent that owns the
 * value carries its own client boundary and this field is simply part of that parent's tree.
 */
import clsx from 'clsx';
import type { ComponentPropsWithRef, JSX } from 'react';

import styles from './Input.module.css';

/**
 * The field's own props, on top of everything a native `<input>` accepts.
 *
 * `className` is dropped from the inherited set and redeclared so that the composition in the
 * component below is the only route by which it is applied: the caller's classes are merged after
 * the module's `.root`, so a caller adds to the field's appearance instead of replacing it.
 *
 * Kept local and unexported on purpose. `packages/panel-renderer` publishes an `Input` primitive of
 * its own, and the repository's hardcoding guard harvests this workspace's multi-token identifiers
 * into a policy no product file may then contain, so this workspace must not put an `InputProps`
 * name into circulation. A consumer that needs the type writes `React.ComponentProps<typeof Input>`
 * and stays correct no matter what is added here.
 */
interface Props extends Omit<ComponentPropsWithRef<'input'>, 'className'> {
  /**
   * Field density. `'md'` is the stylesheet's base metric set; `'sm'` is the dense variant for a
   * toolbar or a table cell. Emitted as `data-size` in both cases even though only `'sm'` carries
   * a rule, so the rendered field always states which scale it is in.
   *
   * Named `scale`, and not `size`, because `<input>` already has a native `size` attribute - the
   * field's width in characters, which the cart's quantity boxes rely on. A visual prop of that
   * name would have swallowed the real attribute; as written, `size` passes straight through with
   * the rest of the native props.
   */
  scale?: 'sm' | 'md';

  /**
   * The current value failed validation.
   *
   * Drives the stylesheet's error border *and* `aria-invalid`, from this one prop, so the state a
   * reader sees and the state a screen reader announces cannot drift apart. The message itself is
   * `FormField`'s job: the border is emphasis, never the only signal.
   */
  invalid?: boolean;

  /**
   * Quantity-style entry: tabular figures, aligned to the trailing edge, so a column of numbers
   * lines up digit for digit. It changes nothing else about the field.
   */
  numeric?: boolean;

  /** Additional classes, merged after `.root`. */
  className?: string;
}

/**
 * Renders the field.
 *
 * The three variant props become data attributes and `invalid` additionally becomes `aria-invalid`;
 * `undefined` is used rather than `'false'` for the two boolean states so an unset state leaves no
 * attribute behind at all, which keeps the rendered markup and the stylesheet's `[data-…='true']`
 * selectors reading the same way.
 *
 * Everything else is spread on unchanged - `id`, `name`, `type`, `value`, `defaultValue`,
 * `onChange`, `placeholder`, `required`, `readOnly`, `disabled`, `inputMode`, `autoComplete`,
 * `aria-describedby`, the native `size`, and `ref`, which React 19 passes as an ordinary prop and
 * this component consequently forwards without `forwardRef`.
 */
export function Input({
  scale = 'md',
  invalid = false,
  numeric = false,
  className,
  ...rest
}: Props): JSX.Element {
  return (
    <input
      className={clsx(styles.root, className)}
      data-size={scale}
      data-invalid={invalid ? 'true' : undefined}
      data-numeric={numeric ? 'true' : undefined}
      aria-invalid={invalid ? 'true' : undefined}
      {...rest}
    />
  );
}
