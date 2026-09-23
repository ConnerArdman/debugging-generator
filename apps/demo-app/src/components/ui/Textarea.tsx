/**
 * Textarea - the multi-line text field of the Lumen Supply storefront.
 *
 * One place in this application collects a paragraph rather than a line: the checkout page's
 * "Notes for the warehouse", where a buyer writes dock hours on one line and a purchase-order
 * reference on the next. This is the control for it, and it is a component of its own for the same
 * reason `Input` and `Select` are separate: this folder's primitives wrap one native element each,
 * forward every attribute untouched, and leave the label and the messages to `FormField`.
 *
 * It is deliberately not a variant of `Input`. A single component covering both elements has to
 * take a union of their props, and a union of props is a component whose `onChange` cannot be
 * contextually typed - every caller of the single-line field, in this folder and in every other,
 * would have to annotate its own event parameter to keep `strict` satisfied. Two components, one
 * per element, keep both call sites inferring their own event type.
 *
 * What it shares with `Input` is its appearance, and it shares it rather than restating it.
 * `Textarea.module.css` composes that stylesheet's `.root`, so the box, border, radius, focus ring,
 * read-only and disabled treatments and the invalid emphasis are the same declarations, and this
 * module adds only what a text area needs on top of them: a floor under its height and a resize
 * handle that works in one direction. A buyer therefore sees one field, two lines tall.
 *
 * The three variant props are `Input`'s, spelled the same way and emitted as the same data
 * attributes, so a form that mixes the two controls states its states identically in both; and
 * `invalid` drives `aria-invalid` as well as the stylesheet, from one prop, so the state a reader
 * sees and the state a screen reader announces cannot drift apart.
 *
 * No `'use client'` directive. The component holds no state and subscribes to nothing, so it
 * renders inside a server component as happily as inside a client one; a parent that owns the value
 * carries its own client boundary and this field is simply part of that parent's tree.
 */
import clsx from 'clsx';
import type { ComponentPropsWithRef, JSX } from 'react';

import styles from './Textarea.module.css';

/**
 * The field's own props, on top of everything a native `<textarea>` accepts.
 *
 * `className` is dropped from the inherited set and redeclared so that the composition in the
 * component below is the only route by which it is applied: the caller's classes are merged after
 * the module's `.root`, so a caller adds to the field's appearance instead of replacing it.
 *
 * Kept local and unexported on purpose, exactly as `Input`'s is: the repository's hardcoding guard
 * harvests this workspace's multi-token identifiers into a policy no product file may then contain,
 * so this workspace must not put a `TextareaProps` name into circulation. A consumer that needs the
 * shape writes `React.ComponentProps<typeof Textarea>`.
 */
interface Props extends Omit<ComponentPropsWithRef<'textarea'>, 'className'> {
  /**
   * Field density, on the same scale as the single-line field: `'md'` is the base metric set,
   * `'sm'` the dense variant. Emitted as `data-size` in both cases even though only `'sm'` carries
   * a rule, so the rendered field always states which scale it is in.
   *
   * Named `scale` rather than `size` to match `Input`, where that name had to be left to the native
   * attribute. A text area has no `size` attribute of its own, but one name for one thing across
   * two controls is worth more than the freedom to call it something else here.
   */
  scale?: 'sm' | 'md';

  /**
   * The current value failed validation.
   *
   * Drives the stylesheet's error border *and* `aria-invalid`, from this one prop. The message
   * itself is `FormField`'s job: the border is emphasis, never the only signal.
   */
  invalid?: boolean;

  /** Additional classes, merged after `.root`. */
  className?: string;
}

/**
 * Renders the field.
 *
 * `rows` is not defaulted here. It is the number of lines a caller wants visible, which depends on
 * what the field is for, and the native default of two is a sensible floor for a caller that says
 * nothing - so the attribute passes straight through with the rest.
 *
 * Everything else is spread on unchanged - `id`, `name`, `value`, `defaultValue`, `onChange`,
 * `onBlur`, `placeholder`, `required`, `readOnly`, `disabled`, `autoComplete`,
 * `aria-describedby`, `rows`, `cols`, and `ref`, which React 19 passes as an ordinary prop and this
 * component consequently forwards without `forwardRef`. The spread comes last, so an attribute a
 * caller states explicitly wins over the defaults computed here.
 *
 * `undefined` rather than `'false'` for the two boolean states, so an unset state leaves no
 * attribute behind at all, which keeps the rendered markup and the stylesheet's `[data-…='true']`
 * selectors reading the same way. The one value behind both error attributes is annotated rather
 * than inferred, because React types `aria-invalid` as a closed set of literals and a fresh object
 * literal would widen `'true' | undefined` to `string | undefined`.
 */
export function Textarea({
  scale = 'md',
  invalid = false,
  className,
  ...rest
}: Props): JSX.Element {
  const flag: 'true' | undefined = invalid ? 'true' : undefined;

  return (
    <textarea
      className={clsx(styles.root, className)}
      data-size={scale}
      data-invalid={flag}
      aria-invalid={flag}
      {...rest}
    />
  );
}
