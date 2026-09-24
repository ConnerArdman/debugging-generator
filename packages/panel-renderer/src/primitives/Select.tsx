/**
 * Select - the option-choice primitive of `@debuggen/panel-renderer`.
 *
 * Every place a developer picks one value out of a known set lands here. AAP
 * 0.6.4 forbids a raw `<select>` anywhere in the product - "library primitives
 * over raw `<button>`, `<input>`, `<select>`, `<table>` and heading elements" -
 * so this component is the only picker in existence: the sort order and the
 * kind and tier filters a toolbar row offers above the event log, the sortable
 * tables and the visualization components.
 *
 * THE PLATFORM CONTROL, DELIBERATELY
 * What this component renders is a native `<select>`, and that is the
 * load-bearing decision in this file. The two surfaces that host this design
 * system - a Chrome DevTools panel and a VS Code webview - are very different
 * embedding environments, and the user agent's own picker is the only control
 * guaranteed to be operable by keyboard and announced by a screen reader in
 * both without a line of custom code: type-ahead, Home/End, the platform's own
 * popup placement and its pointer and touch affordances all come for free. So
 * there is no custom listbox here, no key handler, no `role`, and no component
 * state mirroring what the user agent already tracks. Only the chrome around
 * the control is styled; the popup itself belongs to the platform.
 *
 * FLAT LIST ONLY
 * AAP 0.6.2 specifies a flat option list, and that is exactly what this
 * component accepts: an ordered array of value/label pairs rendered as sibling
 * `<option>` elements. There is no grouping facility, no group element is ever
 * emitted, and none may be added - a grouped picker is a design decision the
 * fixed primitive list does not carry, and a caller that needs one is
 * describing a different component.
 *
 * ALWAYS CONTROLLED
 * `value` plus `onValueChange` is the only data path. The component keeps no
 * selection state of its own and offers no uncontrolled path: what it renders
 * as selected is exactly the `value` it was handed, and every change raises
 * `onValueChange` with the next value read from `event.currentTarget.value`. A
 * caller that does not feed the new value back therefore sees the selection
 * snap straight back, which is the correct behaviour for a filter whose state
 * lives in the surface around it rather than inside the control. The raw change
 * event is deliberately not part of the API (`onChange` is omitted from the
 * extended attribute set for that reason), so no consumer can reach the DOM
 * event and start treating the picker as its own state.
 *
 * SCHEMA-AGNOSTIC BY CONSTRUCTION
 * The vocabularies this picker is pointed at in practice - the sort orders of a
 * panel specification's data query, which live in `@debuggen/panel-schema`, and
 * the event kinds and tiers of a capture, which live in `@debuggen/telemetry` -
 * are deliberately absent from this file, which imports neither package. The
 * component takes a plain, typed option list and nothing else; the caller maps
 * its own domain vocabulary onto {@link SelectOption} and maps the chosen
 * string back. That is what lets one picker serve a sort order, a kind filter,
 * a tier filter and whatever a later node type needs, and it is why no union of
 * schema values appears anywhere in this signature.
 *
 * WHY THE WRAPPER MARKUP IS DUPLICATED FROM `Input.tsx`
 * The `dg-field*` wrapper structure below - wrapper, label, control row, hint,
 * error - is declared identically by this file and by the text-entry primitive
 * so that a toolbar row of a text field and a picker aligns on one grid. That
 * duplication is DELIBERATE and must not be "fixed" by extracting a shared
 * field helper: the primitive list of AAP 0.6.2 is fixed at fourteen files, so
 * no fifteenth helper module may be created, and AAP 0.6.4 ranks design-system
 * compliance above code quality when the two disagree. The stylesheet is the
 * shared artefact instead: one `dg-field*` rule set in
 * `../styles/components.css` serves both components, which is also why the two
 * files' wrapper markup and class usage must stay comparable line for line.
 *
 * STYLING
 * Class names only. This file chooses no colour, spacing, radius or type size
 * and sets no inline style; `../styles/components.css` implements the classes
 * declared here - `dg-field`, `dg-field--sm`, `dg-field--md`, `dg-field--full`,
 * `dg-is-invalid`, `dg-is-disabled`, `dg-field__label`, `dg-field__control`,
 * `dg-field__hint`, `dg-field__error`, and this component's own `dg-select`,
 * `dg-select__native` and `dg-select__chevron` - against the token set of AAP
 * 0.6.3. Suppressing the user agent's own picker chrome and reserving the inline
 * space the chevron occupies are that stylesheet's work, never this file's.
 * Keyboard focus is always indicated by `--dg-focus-ring`: for this field the
 * stylesheet draws the ring on the `dg-field__control` box - the field's
 * visible edge - instead of on the borderless native `<select>` inside it,
 * which is why the control must stay inside that box. The ring is relocated,
 * never removed.
 *
 * TWO REQUIREMENTS THE STYLESHEET MUST HONOUR, measured in a browser rather
 * than assumed, because the markup below cannot express either without an
 * inline style AAP 0.6.4 forbids:
 *
 *   1. `.dg-select__chevron` must be POINTER-INERT (`pointer-events: none`).
 *      The glyph is positioned over the control's inline end, so a pointer
 *      press that lands on it must fall through to the control underneath; a
 *      chevron that swallows the press is a drop-down affordance that does not
 *      drop down. The global `dg-icon` utility makes the svg itself inert, but
 *      the positioned span is a separate element and needs the rule of its own.
 *   2. `.dg-select__native` must reserve inline-end padding at least as wide as
 *      the chevron plus its inset, so the longest label can never render under
 *      the glyph.
 *
 * @see ../styles/base.css for the global `dg-visually-hidden` and `dg-icon` utilities reused here.
 * @see ../tokens/tokens.ts for the token source the classes below resolve against.
 */
import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import type { ChangeEvent, ReactElement, Ref, SelectHTMLAttributes } from 'react';
import { useId } from 'react';

/**
 * One choice offered by the picker.
 *
 * `value` is the string the component reports through `onValueChange` and the
 * string a caller hands back as `value` to render it as selected; `label` is
 * what the option reads as on screen. They are separate because the wire
 * vocabulary of a filter and the words a developer should see rarely coincide,
 * and because the label is the only part of an option that may be translated or
 * reworded without changing what the surface around the picker does.
 *
 * The fields are `readonly` so an option list can be declared once as a module
 * constant and shared by every render without a caller being able to mutate a
 * shared entry through the array it passed in.
 *
 * `disabled` spells `| undefined` for the same reason every optional prop in
 * this package does: `exactOptionalPropertyTypes` is in force repository-wide
 * (tsconfig.base.json), so a caller that builds an option from a value it may
 * not have - `disabled: row.unavailable` where that field is itself optional -
 * must remain legal.
 */
export interface SelectOption {
  /** The value reported through `onValueChange` and matched against `value`. */
  readonly value: string;

  /** The human-readable text of the option, rendered as the option's content. */
  readonly label: string;

  /**
   * Render the option as present but unselectable - a choice the current data
   * cannot support, such as a sort order for a column the capture has no values
   * for. Showing it disabled rather than dropping it keeps the set of choices
   * stable, so the list does not reorder itself under the user between renders.
   * Defaults to absent, which is selectable.
   */
  readonly disabled?: boolean | undefined;
}

/**
 * Field density.
 *
 * `'md'` is the base metric set of the design system (`--dg-space-2`/`--dg-space-3`
 * padding, `--dg-text-md` type); `'sm'` is the dense variant a toolbar row and a
 * table cell use (`--dg-space-1`/`--dg-space-2`, `--dg-text-sm`). Both values
 * always reach the DOM as a wrapper variant class, so the rendered field states
 * which scale it is in.
 */
export type SelectControlSize = 'sm' | 'md';

/**
 * Wrapper variant class per density, so the density prop cannot drift from the
 * stylesheet.
 *
 * A record keyed by the union - rather than a conditional or an interpolated
 * string - is what makes a new density value a compile error here instead of a
 * silently missing class at runtime, and what keeps indexing total so
 * `noUncheckedIndexedAccess` does not widen the result to `string | undefined`.
 */
const FIELD_SIZE_CLASS: Readonly<Record<SelectControlSize, string>> = {
  sm: 'dg-field--sm',
  md: 'dg-field--md',
};

/**
 * Props of the picker.
 *
 * Extending `SelectHTMLAttributes<HTMLSelectElement>` is what keeps this
 * interface short: `name`, `required`, `autoFocus`, `form`, `onBlur`,
 * `onKeyDown`, every `aria-*` attribute and every `data-*` attribute pass
 * straight through to the element without being enumerated here. Five members
 * are removed from the inherited set, each for a reason:
 *
 *   - `value` and `onChange`, because the controlled contract replaces them with
 *     `value: string` and `onValueChange`, and because the DOM event must not be
 *     part of the API (see the file note).
 *   - `children`, because the content of this control is its `options`; markup a
 *     caller nested inside it would bypass the typed option list entirely.
 *   - `size`, because the native attribute of that name is a visible row count
 *     for a list box, and a design prop sharing the name would have swallowed
 *     it. The density prop is {@link SelectProps.controlSize} instead.
 *   - `multiple`, because a flat single-choice list is the required behaviour
 *     (AAP 0.6.2). Multiple selection needs a different value type, a different
 *     change signature and a different keyboard story, so it is a separate
 *     component if it is ever wanted - never a flag on this one.
 *
 * Every prop declared below spells `| undefined`: `exactOptionalPropertyTypes`
 * is in force repository-wide (tsconfig.base.json), and a caller that forwards
 * an optional value it may not have - `hint={props.hint}` - must remain legal.
 * React's own attribute types are written the same way.
 */
export interface SelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'value' | 'onChange' | 'size' | 'children' | 'multiple'
> {
  /**
   * The picker's accessible name, always rendered as a real `<label htmlFor>`
   * bound to the control and coloured `--dg-text-secondary` at the density's
   * type role.
   *
   * Required, because a control without a programmatic label is a defect (AAP
   * 0.6.4 ranks accessibility above visual fidelity). Use `labelHidden` when the
   * design has no room for it; the label stays in the DOM and in the
   * accessibility tree either way.
   */
  label: string;

  /**
   * Remove the label from the visual surface while keeping it in the
   * accessibility tree.
   *
   * Implemented by adding the global `dg-visually-hidden` utility to the
   * `<label>` - never by dropping the element and never by degrading to
   * `aria-label`, so the control keeps a real labelled-by relationship and a
   * pointing-device user keeps the enlarged hit area a `<label>` gives. This is
   * the form a dense toolbar row uses, where the column heading already says
   * what the picker is for. Defaults to `false`.
   */
  labelHidden?: boolean | undefined;

  /**
   * The value rendered as selected. The component is always controlled; see the
   * file note.
   *
   * The empty string is the canonical "nothing chosen yet" value and is the only
   * value for which `placeholder` is shown.
   */
  value: string;

  /**
   * Raised with the next value whenever the user picks a different option, read
   * from `event.currentTarget.value`.
   *
   * The next value, not a DOM event: the picker has no opinion about what the
   * caller does with it, and the caller cannot reach the event to give the
   * picker state of its own.
   */
  onValueChange: (next: string) => void;

  /**
   * The choices, in the order they are offered, rendered as a flat list of
   * sibling `<option>` elements against `--dg-surface-elevated` and
   * `--dg-text-primary`.
   *
   * There is no default: the options are content, and this component ships none
   * (AAP 0.5.4 - no application vocabulary anywhere in the design system). An
   * empty array is a legitimate, non-exceptional state - a filter whose domain
   * has no values yet, which is normal while a capture is still running - and
   * renders a disabled control rather than throwing.
   */
  options: readonly SelectOption[];

  /**
   * Text for the "nothing chosen yet" state, rendered as a disabled first
   * option in `--dg-text-muted`.
   *
   * Shown only while `value` is the empty string, and gone from the list the
   * moment a real value is selected, so it can never be chosen again and can
   * never be reported through `onValueChange`. Blank and whitespace-only strings
   * are treated as absent, which keeps an option that shows nothing out of the
   * list. There is no default, and a placeholder is never a substitute for
   * `label` - which is why it cannot be set without one.
   */
  placeholder?: string | undefined;

  /**
   * Disable the control.
   *
   * Sets the NATIVE `disabled` attribute - not `aria-disabled` - so the picker
   * is genuinely inert and unfocusable rather than merely announced as
   * unavailable, and adds `dg-is-disabled` to the wrapper so the label, hint and
   * error dim with it. The stylesheet gives the field the design system's one
   * disabled treatment, the same as a disabled `Button` and `Input`: the enabled
   * box's elevated surface, a `--dg-border-subtle` edge, `--dg-text-muted` text
   * and a not-allowed cursor. It also cancels the user agent's own translucency
   * for a disabled `<select>`, so the state is never signalled by `opacity`. An
   * empty `options` array disables the control on the same two channels,
   * because a picker with nothing to pick is unavailable whatever this prop
   * says. Defaults to `false`.
   */
  disabled?: boolean | undefined;

  /**
   * The current selection failed validation.
   *
   * Drives three things from one prop, so the state a reader sees and the state
   * a screen reader hears cannot drift apart: `dg-is-invalid` on the wrapper
   * (the `--dg-danger` border and message colour), `aria-invalid="true"` on the
   * control, and the rendering of `errorMessage`. Colour is never the only
   * signal - the message carries the meaning. Defaults to `false`.
   */
  invalid?: boolean | undefined;

  /**
   * Persistent help text below the control, in `--dg-text-muted` at
   * `--dg-text-sm`.
   *
   * Rendered whenever it is set and associated with the control through
   * `aria-describedby`, so it is announced with the picker rather than stranded
   * beside it. Blank and whitespace-only strings are treated as absent, which
   * keeps an empty element and a dangling description id out of the DOM.
   */
  hint?: string | undefined;

  /**
   * What is wrong with the current selection, rendered below the control in
   * `--dg-danger` when - and only when - `invalid` is also set. An error state
   * with no message is a colour change nobody can act on, and a message without
   * `invalid` would announce a failure the control is not in.
   *
   * It is associated through `aria-describedby` and deliberately carries NO
   * `role="alert"`: the description relationship is already announced when the
   * control takes focus, while a live region would interrupt the user on every
   * change of a picker that is invalid while being changed. Blank and
   * whitespace-only strings are treated as absent.
   */
  errorMessage?: string | undefined;

  /**
   * Field density; see {@link SelectControlSize}. Defaults to `'md'`.
   *
   * Named `controlSize`, and not `size`, on purpose: `<select>` has a native
   * `size` attribute - the number of rows a list box shows - and a visual prop
   * of that name would have swallowed it. The native attribute is omitted from
   * this API altogether, because a flat drop-down is the required behaviour.
   */
  controlSize?: SelectControlSize | undefined;

  /**
   * Let the picker grow to the inline size of its container instead of taking
   * its natural width, for a filter that spans a side bar rather than sitting in
   * a toolbar strip. Defaults to `false`.
   */
  fullWidth?: boolean | undefined;

  /**
   * A ref to the underlying element, for the callers that must focus or measure
   * it (returning focus to the filter that opened a dialog, scrolling a toolbar
   * control into view).
   *
   * React 19 passes `ref` as an ordinary prop, so this component is a plain
   * function and `forwardRef` is neither needed nor used. One element is always
   * rendered - a `<select>` - so a single ref type is sound here, unlike in the
   * text-entry primitive whose element varies with its props.
   */
  ref?: Ref<HTMLSelectElement> | undefined;
}

/**
 * Whether a string prop carries text worth rendering.
 *
 * `''` and a whitespace-only value are both *present* and both render nothing,
 * so they must not produce an element: an empty hint or error takes vertical
 * space and publishes a description id that resolves to no text, and an empty
 * placeholder adds a blank row to the list. Collapsing them to `undefined` in
 * one helper keeps that judgement identical for all three.
 *
 * @param text The prop value to test.
 * @returns The trimmed-non-empty original string, or `undefined`.
 */
function textOrUndefined(text: string | undefined): string | undefined {
  return text !== undefined && text.trim() !== '' ? text : undefined;
}

/**
 * Renders the picker: wrapper, label, control row with the native control and
 * its decorative chevron, then the hint and the error message.
 *
 * The props are destructured in the body rather than in the signature so the
 * exported signature stays `Select(props: SelectProps)`, and so that `id`,
 * `className` and `aria-describedby` are lifted out of the remainder before it
 * is spread - each of those three is composed rather than forwarded, and
 * forwarding one as well would apply it twice with the second copy winning.
 *
 * Attribute precedence inside the control is deliberate: the caller's remaining
 * props go on FIRST and the controlled attributes follow, so nothing a caller
 * passes can clobber the value, the change handler, the resolved id, the merged
 * description or the disabled state. Everything else it passes - `name`,
 * `required`, `autoFocus`, `onBlur`, `title`, data attributes - lands untouched.
 *
 * @param props The picker's props; see {@link SelectProps}.
 * @returns The rendered picker.
 */
export function Select(props: SelectProps): ReactElement {
  /**
   * Called unconditionally, before any branch or early return, because it is a
   * hook. The value is used as a DOM id and in `htmlFor`/`aria-describedby`
   * only: React's generated ids contain characters that would have to be escaped
   * in a selector, so no CSS selector is ever built from it (AAP 0.6.4's
   * class-names-only rule says the same thing from the styling side).
   */
  const generatedId = useId();

  const {
    label,
    labelHidden = false,
    value,
    onValueChange,
    options,
    placeholder,
    disabled = false,
    invalid = false,
    hint,
    errorMessage,
    controlSize = 'md',
    fullWidth = false,
    id,
    className,
    'aria-describedby': callerDescription,
    ref,
    ...rest
  } = props;

  /** A caller-supplied id wins, so a caller that must address the control can name it. */
  const fieldId = id ?? generatedId;
  const hintElementId = `${fieldId}-hint`;
  const errorElementId = `${fieldId}-error`;

  /**
   * Message text, or `undefined` when there is nothing to say. The error message
   * is suppressed entirely unless `invalid` is set, so the announced state and
   * the rendered state always agree.
   */
  const hintText = textOrUndefined(hint);
  const errorText = invalid ? textOrUndefined(errorMessage) : undefined;

  /**
   * The description MERGE - the detail this component shares with the text-entry
   * primitive and must get right.
   *
   * A caller (a toolbar that explains what its filter does, a form that points
   * at a shared instruction) legitimately passes its own `aria-describedby`, and
   * this field adds the ids of the hint and the error it renders. Overwriting the
   * caller's value would silently drop its description; dropping the field's
   * would leave the hint and the error announced nowhere. So the tokens are
   * concatenated in reading order - caller first, then hint, then error -
   * separated by a single space, and the attribute is omitted altogether when
   * nothing describes the control, since `aria-describedby=""` is a reference to
   * an element that does not exist.
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
   * The placeholder is a first option, not a value: it is rendered only while
   * nothing is chosen, and it is `disabled`, so the user agent shows it as the
   * current selection but refuses to let it be chosen. Once a real value
   * arrives the option is gone from the list entirely, which is why no
   * `onValueChange` can ever carry the empty string back out of this component.
   */
  const placeholderText = textOrUndefined(placeholder);
  const showPlaceholder = placeholderText !== undefined && value === '';

  /**
   * A picker with nothing to pick is unavailable, whatever `disabled` says: it
   * is rendered inert rather than as an empty popup the user can open and learn
   * nothing from, and rather than as an error - an empty domain is a normal
   * state while a capture is still filling up. The same derived value drives the
   * native attribute and the wrapper class, so the two cannot disagree.
   */
  const controlDisabled = disabled || options.length === 0;

  /**
   * `currentTarget` is the element the handler is attached to, so its `value` is
   * this picker's selection no matter what the event passed through on the way.
   */
  const handleChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    onValueChange(event.currentTarget.value);
  };

  /** Only ever `true` or absent: `aria-invalid="false"` is noise on a valid control. */
  const ariaInvalid = invalid ? true : undefined;

  return (
    <div
      className={clsx(
        'dg-field',
        FIELD_SIZE_CLASS[controlSize],
        invalid && 'dg-is-invalid',
        controlDisabled && 'dg-is-disabled',
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

      <div className={clsx('dg-field__control', 'dg-select')}>
        <select
          {...rest}
          ref={ref}
          className="dg-select__native"
          id={fieldId}
          value={value}
          disabled={controlDisabled}
          aria-invalid={ariaInvalid}
          aria-describedby={describedByValue}
          onChange={handleChange}
        >
          {showPlaceholder ? (
            <option value="" disabled>
              {placeholderText}
            </option>
          ) : null}

          {/* Mapped rather than indexed: `noUncheckedIndexedAccess` would widen
              every `options[i]` to `SelectOption | undefined`, and the only ways
              out of that are a non-null assertion or a widening cast, neither of
              which this package admits. The key is the value, which is the one
              field an option list must keep unique. */}
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>

        {/* Decoration, and marked as such: the accessible name is `label`, so the
            glyph is kept out of the accessibility tree. It carries the global
            `dg-icon` utility of `../styles/base.css` - a font-relative square in
            `currentColor`, inert to pointers - and never the icon library's
            numeric size or colour props, which would be the hardcoded CSS AAP
            0.6.4 forbids. The library's own `width`/`height` attributes survive
            in the markup and are overridden by that class, which is why the
            rendered glyph measures one em of the surrounding type role rather
            than the library's default square. The positioned span itself must be
            made pointer-inert by the stylesheet; see requirement 1 in the file
            note. */}
        <span className="dg-select__chevron" aria-hidden="true">
          <ChevronDown className="dg-icon" />
        </span>
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
