/**
 * Input - the text-entry primitive of `@debuggen/panel-renderer`.
 *
 * Every place a developer types inside this product lands here. No raw `<input>` is written
 * anywhere in the product - library primitives replace raw `<button>`, `<input>`, `<select>`,
 * `<table>` and heading elements wherever a primitive exists - so this component is the only text
 * field in existence: the filter and search boxes of the panel toolbar above the event log and the
 * sortable tables, the numeric threshold filters beside them, and, through `multiline`, the two
 * prose fields of the editor view.
 *
 * WHY THE MULTI-LINE CASE LIVES IN THIS FILE
 * This folder holds a fixed set of fourteen UI primitives with no separate text-area primitive,
 * while the editor surface needs a multi-line question box and a multi-line follow-up field, and
 * neither may be hand-rolled from raw elements. The multi-line case is therefore an option of this
 * component (`multiline`), rendering a `<textarea>` through exactly the same wrapper, label, hint
 * and error wiring as the single-line case. Adding a fifteenth primitive file to "separate
 * concerns" would break the fixed primitive list; this is the sanctioned shape.
 *
 * WHY THE WRAPPER MARKUP IS DUPLICATED IN `Select.tsx`
 * The `dg-field*` wrapper structure below - wrapper, label, control row, hint, error - is declared
 * identically by this file and by the select primitive so that a toolbar row of a text field and a
 * dropdown aligns on one grid. That duplication is DELIBERATE and must not be "fixed" by
 * extracting a shared field helper: the primitive list is fixed at fourteen files, so no fifteenth
 * helper module may be created, and design-system compliance ranks above code quality when the two
 * disagree. The stylesheet is the shared artefact instead: one `dg-field*` rule set in
 * `../styles/components.css` serves both components.
 *
 * ALWAYS CONTROLLED
 * `value` plus `onValueChange` is the only data path. The component keeps no text state of its own,
 * debounces nothing, transforms nothing and offers no uncontrolled path: what it renders is exactly
 * the `value` it was handed, and every keystroke raises `onValueChange` with the full next string
 * read from `event.currentTarget.value`. A caller that wants a debounce or a draft buffer owns it,
 * which is what keeps a filter box in a toolbar and a question box in a webview interchangeable.
 * The raw change event is deliberately not part of the API (`onChange` is omitted from the
 * extended attribute set for that reason), so no consumer can reach the DOM event and start
 * treating the field as its own state.
 *
 * NO `ref`
 * The rendered element changes with `multiline` - `HTMLInputElement` in one case,
 * `HTMLTextAreaElement` in the other - so no single ref type is sound, and a union ref would push
 * a narrowing burden onto every caller. React 19 hands `ref` to a component as an ordinary prop, so
 * no ref-forwarding wrapper is needed to expose one and none is used here: a caller that must place
 * focus uses `autoFocus`, or looks the control up by the `id` it supplied.
 *
 * STYLING
 * Class names only. This file chooses no colour, spacing, radius or type size and sets no inline
 * style; `../styles/components.css` implements the classes declared here, resolving every visual
 * value to a `--dg-*` token, and the `::placeholder` colour comes from `../styles/base.css`.
 * Keyboard focus is always indicated by `--dg-focus-ring`: for this field the stylesheet draws the
 * ring on the `dg-field__control` box - the field's visible edge - instead of on the borderless
 * native control inside it, which is why the control must stay inside that box. The ring is
 * relocated, never removed.
 *
 * @see ../styles/base.css for the global `dg-visually-hidden` and `dg-icon` utilities reused here.
 * @see ../tokens/tokens.ts for the token source the classes below resolve against.
 */
import clsx from 'clsx';
import type { ChangeEvent, HTMLAttributes, ReactElement, ReactNode } from 'react';
import { useId } from 'react';

/**
 * Field density.
 *
 * `'md'` is the base metric set of the design system (`--dg-space-2`/`--dg-space-3` padding,
 * `--dg-text-md` type); `'sm'` is the dense variant a toolbar row and a table cell use
 * (`--dg-space-1`/`--dg-space-2`, `--dg-text-sm`). Both values always reach the DOM as a wrapper
 * variant class, so the rendered field states which scale it is in.
 */
export type InputControlSize = 'sm' | 'md';

/**
 * Wrapper variant class per density, so the density prop cannot drift from the stylesheet.
 *
 * A record keyed by the union - rather than a conditional - is what makes a new density value a
 * compile error here instead of a silently missing class at runtime.
 */
const FIELD_SIZE_CLASS: Readonly<Record<InputControlSize, string>> = {
  sm: 'dg-field--sm',
  md: 'dg-field--md',
};

/**
 * Visible line count of the multi-line control when the caller names none.
 *
 * `rows` is an HTML attribute (a line count), not a CSS length, which is why a plain integer is
 * admissible here while no dimension of any kind may be expressed from this file: the field's
 * block size still comes from the stylesheet's token-based metrics, and this attribute only tells
 * the user agent how many lines of text to reserve before scrolling.
 */
const DEFAULT_MULTILINE_ROWS = 3;

/**
 * Props of the text field.
 *
 * Extending `HTMLAttributes<HTMLElement>` rather than `InputHTMLAttributes<HTMLInputElement>` is
 * deliberate and load-bearing: `HTMLAttributes<HTMLElement>` is the common ancestor of the `<input>`
 * and `<textarea>` attribute types, so the unrecognised remainder of the caller's props can be
 * spread onto either element without a cast - and this package admits no `as`. Every form attribute
 * the field genuinely supports is therefore declared explicitly below, which also makes the
 * supported surface readable in one place instead of inherited from an element the component may
 * not even render.
 *
 * `children` and `onChange` are removed from the inherited set: the field's content is its `value`,
 * and its change path is `onValueChange`.
 */
export interface InputProps extends Omit<HTMLAttributes<HTMLElement>, 'children' | 'onChange'> {
  /**
   * The field's accessible name, always rendered as a real `<label htmlFor>` bound to the control.
   *
   * Required, because a field without a programmatic label is a defect: accessibility ranks above
   * visual fidelity. Use `labelHidden` when the design has no room for it; the label stays in the
   * DOM and in the accessibility tree either way.
   */
  label: string;

  /**
   * Remove the label from the visual surface while keeping it in the accessibility tree.
   *
   * Implemented by adding the global `dg-visually-hidden` utility to the `<label>` - never by
   * dropping the element and never by degrading to `aria-label`, so the control keeps a real
   * labelled-by relationship and a pointing-device user keeps the enlarged hit area a `<label>`
   * gives. Defaults to `false`.
   */
  labelHidden?: boolean;

  /**
   * The text the field shows. The component is always controlled; see the file note.
   */
  value: string;

  /**
   * Raised on every keystroke with the full next string, read from `event.currentTarget.value`.
   *
   * The next value, not a DOM event: the field has no opinion about what the caller does with it,
   * and the caller cannot reach the event to give the field state of its own.
   */
  onValueChange: (next: string) => void;

  /**
   * Single-line entry mode, forwarded as the native `type` attribute. Defaults to `'text'` and is
   * ignored when `multiline` is set, because a text area has no type.
   *
   * `'search'` gets the user agent's search affordances; `'number'` gets its numeric keypad and
   * spin buttons for the threshold filters. The value handed to `onValueChange` is a string in every
   * mode - a numeric field that is mid-edit legitimately holds text no number can represent, and
   * parsing belongs to the caller that knows what the number means.
   */
  type?: 'text' | 'search' | 'number';

  /** Native form control name, forwarded unchanged. */
  name?: string;

  /**
   * Placeholder text, forwarded unchanged and rendered in `--dg-text-muted` by the global
   * `::placeholder` rule of `../styles/base.css`.
   *
   * There is no default: a placeholder is content, and this component ships none, because the
   * design system carries no application vocabulary anywhere. A placeholder is never a substitute
   * for `label`, which is why it cannot be set without one.
   */
  placeholder?: string;

  /**
   * Disable the control.
   *
   * Sets the NATIVE `disabled` attribute - not `aria-disabled` - so the control is genuinely inert
   * and unfocusable rather than merely announced as unavailable, and adds `dg-is-disabled` to the
   * wrapper so the label, hint and error dim with it. The stylesheet gives the field the design
   * system's one disabled treatment, the same as a disabled `Button` and `Select`: the enabled
   * box's elevated surface, a `--dg-border-subtle` edge, `--dg-text-muted` text and a not-allowed
   * cursor, never `opacity`. Defaults to `false`.
   */
  disabled?: boolean;

  /** Native `readOnly`: the value is selectable and focusable but not editable. */
  readOnly?: boolean;

  /** Native `required`, which also makes the control `aria-required` to assistive technology. */
  required?: boolean;

  /**
   * Focus the control when it mounts.
   *
   * The sanctioned focus route for this component, since it exposes no `ref`. Use it only where the
   * field IS the reason the surface appeared - a dialog that exists to take one answer - never on a
   * field that merely happens to be first.
   */
  autoFocus?: boolean;

  /** Native `maxLength`, forwarded unchanged. */
  maxLength?: number;

  /**
   * Native `min` of a `type="number"` field: the lowest value the spin buttons and the arrow keys
   * step to, and the lower bound the user agent's constraint validation reports.
   *
   * Forwarded to the single-line `<input>` only - a text area has no numeric bounds. The bound
   * guides entry; it does not clamp what the caller receives: `onValueChange` still hands over
   * exactly what the field holds, so the caller that knows what the number means decides what an
   * out-of-range value resolves to.
   */
  min?: number;

  /** Native `max` of a `type="number"` field; see {@link min} for how a bound is applied. */
  max?: number;

  /**
   * Native `step` of a `type="number"` field: `1` for a whole-number field, `'any'` to accept any
   * precision. Forwarded to the single-line `<input>` only, like {@link min}.
   */
  step?: number | 'any';

  /**
   * The current value failed validation.
   *
   * Drives three things from one prop, so the state a reader sees and the state a screen reader
   * hears cannot drift apart: `dg-is-invalid` on the wrapper (the `--dg-danger` border and
   * message colour), `aria-invalid="true"` on the control, and the rendering of `errorMessage`.
   * Colour is never the only signal - the message carries the meaning. Defaults to `false`.
   */
  invalid?: boolean;

  /**
   * Persistent help text below the control, in `--dg-text-muted` at `--dg-text-sm`.
   *
   * Rendered whenever it is set and associated with the control through `aria-describedby`, so it
   * is announced with the field rather than stranded beside it. Blank and whitespace-only strings
   * are treated as absent, which keeps an empty element and a dangling description id out of the
   * DOM.
   */
  hint?: string;

  /**
   * What is wrong with the current value, rendered below the control in `--dg-danger` when - and
   * only when - `invalid` is also set. An error state with no message is a colour change nobody can
   * act on, and a message without `invalid` would announce a failure the field is not in.
   *
   * It is associated through `aria-describedby` and deliberately carries NO `role="alert"`: the
   * description relationship is already announced when the field takes focus, while a live region
   * would interrupt the user on every keystroke of a field that is invalid while being typed into.
   * Blank and whitespace-only strings are treated as absent.
   */
  errorMessage?: string;

  /**
   * Decorative glyph rendered at the leading edge, inside the control row and before the control.
   *
   * The caller supplies the node - this component ships no default icon - and the component wraps
   * it in a `dg-input__icon` span marked `aria-hidden="true"`, so the glyph never reaches the
   * accessibility tree (an icon is decoration; `label` is the name). The glyph itself carries the
   * global `dg-icon` utility of `../styles/base.css`, which is the design system's only icon
   * metric: it makes the element a square of the surrounding type role, takes `currentColor` and
   * turns off pointer events. Pass it as `<SomeIcon className="dg-icon" />` and never with numeric
   * size or colour props - sizing or colouring a glyph from TSX is a hardcoded CSS value, and every
   * visual value resolves to a `--dg-*` token.
   *
   * The wrapper is rendered BEFORE the control inside the control row, which is the order
   * `../styles/components.css` relies on to inset the control's leading padding when a glyph is
   * present.
   */
  leadingIcon?: ReactNode;

  /**
   * Render a `<textarea>` instead of an `<input>`; see the file note for why this is an option of
   * this component rather than a primitive of its own. Everything else - label, hint, error,
   * density, invalid state, the controlled contract - behaves identically. Defaults to `false`.
   */
  multiline?: boolean;

  /**
   * Visible line count of the multi-line control, forwarded as the native `rows` attribute and
   * ignored when `multiline` is not set. Defaults to three lines.
   */
  rows?: number;

  /**
   * Field density; see {@link InputControlSize}. Defaults to `'md'`.
   *
   * Named `controlSize`, and not `size`, on purpose: `<input>` has a native `size` attribute - its
   * width in characters - and a visual prop of that name would have swallowed it.
   */
  controlSize?: InputControlSize;

  /**
   * Let the field grow to the inline size of its container instead of taking its natural width,
   * for a search box that spans a toolbar or a question box that spans a side bar.
   */
  fullWidth?: boolean;
}

/**
 * Renders the field: wrapper, label, control row with an optional glyph and the control itself,
 * then the hint and the error message.
 *
 * The props are destructured in the body rather than in the signature so the exported signature
 * stays `Input(props: InputProps)`, and so that `id`, `className` and `aria-describedby` are
 * lifted out of the remainder before it is spread - each of those three is composed rather than
 * forwarded, and forwarding one as well would apply it twice with the second copy winning.
 *
 * Attribute precedence inside each control is deliberate: the caller's remaining props go on
 * FIRST, and the controlled attributes follow, so nothing a caller passes can clobber the value,
 * the change handler, the resolved id or the merged description. Everything else it passes - event
 * handlers, `title`, `inputMode`, `autoComplete`, data attributes - lands untouched.
 *
 * @param props The field's props; see {@link InputProps}.
 * @returns The rendered field.
 */
export function Input(props: InputProps): ReactElement {
  /**
   * Called unconditionally, before any branch or early return, because it is a hook. The value is
   * used as a DOM id and in `htmlFor`/`aria-describedby` only: React's generated ids contain
   * characters that would have to be escaped in a selector, so no CSS selector is ever built from
   * it (the package's class-names-only rule says the same thing from the styling side).
   */
  const generatedId = useId();

  const {
    label,
    labelHidden = false,
    value,
    onValueChange,
    type = 'text',
    name,
    placeholder,
    disabled = false,
    readOnly = false,
    required = false,
    autoFocus = false,
    maxLength,
    min,
    max,
    step,
    invalid = false,
    hint,
    errorMessage,
    leadingIcon,
    multiline = false,
    rows = DEFAULT_MULTILINE_ROWS,
    controlSize = 'md',
    fullWidth = false,
    id,
    className,
    'aria-describedby': callerDescription,
    ...rest
  } = props;

  /** A caller-supplied id wins, so a caller that must address the control can name it. */
  const fieldId = id ?? generatedId;
  const hintElementId = `${fieldId}-hint`;
  const errorElementId = `${fieldId}-error`;

  /**
   * Message text, or `undefined` when there is nothing to say. Whitespace-only strings collapse to
   * `undefined` on purpose: an empty message element would otherwise take vertical space and
   * publish a description id that resolves to no text. The error message is suppressed entirely
   * unless `invalid` is set, so the announced state and the rendered state always agree.
   */
  const hintText = hint !== undefined && hint.trim() !== '' ? hint : undefined;
  const errorText =
    invalid && errorMessage !== undefined && errorMessage.trim() !== '' ? errorMessage : undefined;

  /**
   * The description MERGE - the detail this component exists to get right.
   *
   * A caller (a toolbar that explains what its filter does, a form that points at a shared
   * instruction) legitimately passes its own `aria-describedby`, and this field adds the ids of the
   * hint and the error it renders. Overwriting the caller's value would silently drop its
   * description; dropping the field's would leave the hint and the error announced nowhere. So the
   * tokens are concatenated in reading order - caller first, then hint, then error - separated by a
   * single space, and the attribute is omitted altogether when nothing describes the control, since
   * `aria-describedby=""` is a reference to an element that does not exist.
   */
  const describedByTokens: string[] = [];
  const callerTokens = callerDescription?.trim() ?? '';
  if (callerTokens !== '') {
    describedByTokens.push(callerTokens);
  }
  if (hintText !== undefined) {
    describedByTokens.push(hintElementId);
  }
  if (errorText !== undefined) {
    describedByTokens.push(errorElementId);
  }
  const describedByValue = describedByTokens.length === 0 ? undefined : describedByTokens.join(' ');

  /**
   * One handler for both elements: the parameter type is the union of the two change events, which
   * is a supertype of each element's own event type and therefore assignable to either element's
   * handler slot without a cast. `currentTarget` is the element the handler is attached to, so its
   * `value` is this field's text no matter what the event passed through on the way.
   */
  const handleChange = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    onValueChange(event.currentTarget.value);
  };

  /**
   * `null` and `undefined` are the two ways a caller says "no glyph"; any other node - including a
   * fragment of several elements - is wrapped and rendered.
   */
  const hasLeadingIcon = leadingIcon !== undefined && leadingIcon !== null;

  /** Only ever `true` or absent: `aria-invalid="false"` is noise on a field that is simply valid. */
  const ariaInvalid = invalid ? true : undefined;

  return (
    <div
      className={clsx(
        'dg-field',
        FIELD_SIZE_CLASS[controlSize],
        invalid && 'dg-is-invalid',
        disabled && 'dg-is-disabled',
        fullWidth && 'dg-field--full',
        className,
      )}
    >
      <label
        className={clsx('dg-field__label', labelHidden && 'dg-visually-hidden')}
        htmlFor={fieldId}
      >
        {label}
      </label>

      <div className="dg-field__control">
        {hasLeadingIcon ? (
          <span className="dg-input__icon" aria-hidden="true">
            {leadingIcon}
          </span>
        ) : null}

        {multiline ? (
          <textarea
            {...rest}
            className={clsx('dg-input', 'dg-input--multiline')}
            id={fieldId}
            name={name}
            rows={rows}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            readOnly={readOnly}
            required={required}
            autoFocus={autoFocus}
            maxLength={maxLength}
            aria-invalid={ariaInvalid}
            aria-describedby={describedByValue}
            onChange={handleChange}
          />
        ) : (
          <input
            {...rest}
            className="dg-input"
            id={fieldId}
            type={type}
            name={name}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            readOnly={readOnly}
            required={required}
            autoFocus={autoFocus}
            maxLength={maxLength}
            min={min}
            max={max}
            step={step}
            aria-invalid={ariaInvalid}
            aria-describedby={describedByValue}
            onChange={handleChange}
          />
        )}
      </div>

      {hintText !== undefined ? (
        <p className="dg-field__hint" id={hintElementId}>
          {hintText}
        </p>
      ) : null}

      {errorText !== undefined ? (
        <p className="dg-field__error" id={errorElementId}>
          {errorText}
        </p>
      ) : null}
    </div>
  );
}
