/**
 * `Button` — the interactive primitive of the in-repo design system
 * (AAP 0.6.2, 0.6.3, 0.6.4).
 *
 * AAP 0.6.4 leaves no room for a raw control above this layer: "library
 * primitives over raw `<button>`, `<input>`, `<select>`, `<table>` and heading
 * elements". Every clickable affordance of the product therefore resolves to
 * this one component — the capture controls and the element picker of the
 * DevTools panel, the retry action of `ErrorState`, the sort control of
 * `DataTable`, the expand affordance of every visualization component, and the
 * question, diff, pairing, follow-up and end-session actions of the editor
 * webview.
 *
 * ## The four variants, and when each applies
 *
 *   `primary`    The single main action of a surface (submit the question,
 *                start the capture). Filled with `--dg-accent`, so more than
 *                one per surface makes none of them primary.
 *   `secondary`  The default, and what an unqualified `<Button>` renders: a
 *                bordered control on `--dg-surface-elevated` for every ordinary
 *                action that sits beside a primary one.
 *   `ghost`      Chrome-free, for dense contexts where a border would become
 *                the visual noise — a toolbar row, a table's sort control, a
 *                row's expand toggle.
 *   `danger`     Destructive and irreversible in the session's terms (ending a
 *                session, discarding captured evidence), coloured from
 *                `--dg-danger`. The label always names the consequence, because
 *                colour is never the sole carrier of meaning (AAP 0.6.4).
 *
 * ## Appearance is class names, and nothing else
 *
 * Not one length, colour, radius or shadow appears in this module: the class
 * names below are the whole of it, and `src/styles/components.css` resolves
 * every one of them to a `var(--dg-*)` token (AAP 0.6.3). There is no inline
 * `style`, no CSS import and no component-scoped custom property here, which is
 * what lets a theme switch on the panel root restyle every button by cascade
 * alone. The class contract this file DECLARES, and that `components.css` must
 * implement:
 *
 *   dg-button                 the block — an inline-flex chip, label and
 *                             leading icon centred, gap and padding from
 *                             `--dg-space-*`, `--dg-radius-sm`/`-md`
 *   dg-button--primary        `--dg-accent` fill; `--dg-accent-muted` on hover
 *   dg-button--secondary      `--dg-surface-elevated` on `--dg-border-subtle`
 *   dg-button--ghost          transparent until hover, `--dg-text-secondary`
 *   dg-button--danger         `--dg-danger`
 *   dg-button--sm             the `--dg-text-sm` role, tighter `--dg-space-*`
 *   dg-button--md             the `--dg-text-md` role (the default)
 *   dg-button--icon-only      a square chip with no label box
 *   dg-button--full           `inline-size: 100%` for a stacked form action
 *   dg-button__icon           the leading-icon box
 *   dg-button__label          the label box
 *   dg-is-disabled            the disabled state, always written coupled to the
 *                             block (`.dg-button.dg-is-disabled`)
 *
 * Two classes are reused from `src/styles/base.css` and must never be
 * redefined: `dg-icon`, which gives a glyph its `1em` square and
 * `currentColor`, and `dg-visually-hidden`, which carries the accessible name
 * of an icon-only control. The focus ring needs no class at all — base.css
 * applies `--dg-focus-ring` to every `:focus-visible` element, so this
 * component inherits the high-contrast theme's thicker ring by construction and
 * never suppresses an indicator (AAP 0.6.4).
 *
 * ## Geometry belongs to the caller
 *
 * The chip is self-contained: no margin, no `display: block`, no width of its
 * own unless `fullWidth` is asked for. `DataTable` renders this component as a
 * ghost button *inside* a `role="columnheader"` cell and sets `aria-sort` on
 * the cell rather than on the button, so a button that assumed it owned its
 * container would break that composition. Spacing between controls comes from
 * the layout primitives (`Toolbar`, `Stack`, `Split`), never from here.
 *
 * ## `type` defaults to `"button"`
 *
 * A `<button>` with no `type` is a submit button in every browser. The editor
 * webview renders its controls inside a form-like question view, where a stray
 * submit navigates the webview document and destroys the session view's state,
 * so the default is inverted here: `"button"` unless the caller says otherwise,
 * and a caller-supplied `type` always wins.
 *
 * ## Presentational only
 *
 * The component raises `onClick` and renders. It never fetches, never opens a
 * socket and never touches a `DataProvider`: data reaches the renderer through
 * the host's provider interface and interactions leave through `PanelActions`
 * (AAP 0.4.2).
 */

import { clsx } from 'clsx';
import type { ButtonHTMLAttributes, ReactElement, ReactNode, Ref } from 'react';

/**
 * The visual weights of the design system's button, in descending prominence.
 *
 * Each value maps to exactly one class in {@link VARIANT_CLASS}; the tokens
 * behind them are listed in this module's header.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/**
 * The two densities of the button.
 *
 * `md` is the interface body role (`--dg-text-md`) and the default. `sm`
 * (`--dg-text-sm`) exists for the dense rows the product is full of — toolbar
 * strips, table headers, event-log rows — and is the only other size: a third
 * would be a design decision the token table does not carry.
 */
export type ButtonSize = 'sm' | 'md';

/**
 * The variant classes, as a total lookup rather than an interpolated string.
 *
 * A `Record` keyed by the finite union is what makes the mapping checkable: a
 * new variant fails to compile until its class exists, and indexing with a
 * `ButtonVariant` is total, so `noUncheckedIndexedAccess` does not widen the
 * result to `string | undefined`. Interpolation (`` `dg-button--${variant}` ``)
 * would type-check while producing a class no stylesheet defines.
 */
const VARIANT_CLASS: Readonly<Record<ButtonVariant, string>> = {
  primary: 'dg-button--primary',
  secondary: 'dg-button--secondary',
  ghost: 'dg-button--ghost',
  danger: 'dg-button--danger',
};

/** The size classes, total over {@link ButtonSize} for the same reason. */
const SIZE_CLASS: Readonly<Record<ButtonSize, string>> = {
  sm: 'dg-button--sm',
  md: 'dg-button--md',
};

/** The variant an unqualified `<Button>` renders. */
const DEFAULT_VARIANT: ButtonVariant = 'secondary';

/** The density an unqualified `<Button>` renders. */
const DEFAULT_SIZE: ButtonSize = 'md';

/**
 * The props of {@link Button}.
 *
 * Extending `ButtonHTMLAttributes<HTMLButtonElement>` is deliberate and is what
 * keeps this interface short: `onClick`, `onKeyDown`, `disabled`, `title`,
 * `form`, `name`, `value`, every `aria-*` attribute (`aria-pressed` for the
 * picker and capture toggles, `aria-expanded`/`aria-controls` for a row's
 * expand affordance, `aria-label` for an icon-only control) and every `data-*`
 * attribute pass straight through to the element without being enumerated
 * here. Only the props the design system adds are declared below.
 *
 * Every added prop spells `| undefined`: `exactOptionalPropertyTypes` is in
 * force repository-wide (tsconfig.base.json), and a caller that forwards an
 * optional value it may not have — `variant={props.variant}` — must remain
 * legal. React's own attribute types are written the same way.
 */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * The visual weight. Defaults to `"secondary"`.
   *
   * `primary` fills with `--dg-accent`, `secondary` sits on
   * `--dg-surface-elevated` inside `--dg-border-subtle`, `ghost` is
   * chrome-free `--dg-text-secondary`, and `danger` carries `--dg-danger`.
   */
  variant?: ButtonVariant | undefined;

  /**
   * The density. Defaults to `"md"`.
   *
   * `md` resolves to the `--dg-text-md` role and the standard `--dg-space-*`
   * padding pair; `sm` to `--dg-text-sm` and the tighter pair.
   */
  size?: ButtonSize | undefined;

  /**
   * A **leading** glyph, rendered before the label inside a
   * `dg-button__icon` box that is always `aria-hidden` — an icon is never the
   * accessible name (AAP 0.6.4).
   *
   * Pass the glyph already carrying the global `dg-icon` class —
   * `icon={<SomeIcon className="dg-icon" />}` — so it takes its `1em` square
   * and `currentColor` from base.css and scales with the button's type role.
   * Never pass an icon library's numeric `size` or `color` prop: those are
   * hardcoded values, which AAP 0.6.4 forbids.
   *
   * A trailing icon is not offered. Iconography sits before the label
   * throughout this design system, and a second slot would let two callers
   * disagree about the same control.
   */
  icon?: ReactNode | undefined;

  /**
   * Render the glyph alone, with no visible label — the square chip form a
   * dense toolbar or a row affordance uses.
   *
   * The control still needs an accessible name, and this component will not
   * emit an unnamed one. Supply it in one of two ways:
   *
   *   1. `aria-label` (or `aria-labelledby`), which is the usual form when
   *      there is no text to reuse; `children` may then be omitted entirely.
   *   2. `children`, which this component moves into a `dg-visually-hidden`
   *      span when neither ARIA attribute is present, so the name survives in
   *      the accessibility tree while the surface shows only the glyph. This
   *      is the form `Toolbar` and `EventDetails` rely on, because it keeps
   *      the name beside the label text a wider layout would show.
   *
   * A blank or whitespace-only `aria-label` counts as no name and falls back to
   * form 2, since it names nothing in the accessibility tree. Supplying neither
   * form is a caller defect this component cannot repair — there is no text to
   * announce — so every icon-only call site passes one of the two.
   *
   * Defaults to `false`.
   */
  iconOnly?: boolean | undefined;

  /**
   * Stretch the chip to its container's inline size — the stacked form action
   * of the question view and of a dialog's footer. Defaults to `false`, which
   * leaves the chip intrinsically sized.
   */
  fullWidth?: boolean | undefined;

  /**
   * A ref to the underlying element, for the callers that must focus or
   * measure it (returning focus after a dialog closes, scrolling a toolbar
   * control into view).
   *
   * React 19 passes `ref` as an ordinary prop, so this component is a plain
   * function and `forwardRef` is neither needed nor used.
   */
  ref?: Ref<HTMLButtonElement> | undefined;
}

/**
 * Whether an ARIA string attribute actually names something.
 *
 * `aria-label=""` and a whitespace-only value are both *present* and both name
 * nothing, so they must not satisfy the naming requirement of
 * {@link ButtonProps.iconOnly}; treating them as a name is how an icon-only
 * control ends up announced as "button" and nothing else.
 *
 * @param value The attribute value as the caller passed it, if at all.
 * @returns `true` when the value contributes an accessible name.
 */
function namesSomething(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

/**
 * Whether a node would render anything a reader could perceive.
 *
 * `null`, `undefined` and both booleans render nothing in React, and the empty
 * string renders no text, so none of them justifies a label box — and none of
 * them can serve as the accessible name of an icon-only control either. `0` is
 * renderable and stays renderable (AAP 0.6.4's defensive rule: never render
 * "null" or "undefined" as visible text).
 *
 * @param node The `children` the caller supplied, if any.
 * @returns `true` when the node contributes visible or announced content.
 */
function isRenderable(node: ReactNode): boolean {
  return node !== null && node !== undefined && typeof node !== 'boolean' && node !== '';
}

/**
 * The button primitive.
 *
 * See this module's header for the variants, the class contract and the
 * `type="button"` default; see {@link ButtonProps} for the props and their
 * tokens.
 *
 * Keyboard operation is the browser's own: a real `<button>` activates on
 * Enter and Space, is in the tab order, and is removed from it by the native
 * `disabled` attribute. No key handler re-implements any of that, no
 * `tabIndex` is set, no `role` is declared — a `<button>` already is one — and
 * `aria-disabled` is never substituted for the real attribute, which would
 * leave the control clickable.
 *
 * @param props The props, as documented on {@link ButtonProps}.
 * @returns The rendered control.
 */
export function Button(props: ButtonProps): ReactElement {
  const {
    variant = DEFAULT_VARIANT,
    size = DEFAULT_SIZE,
    icon,
    iconOnly = false,
    fullWidth = false,
    type = 'button',
    disabled = false,
    className,
    children,
    ref,
    ...rest
  } = props;

  // Read the ARIA naming attributes off `props` instead of destructuring them:
  // left in `rest`, they reach the element unchanged, and this component only
  // needs to know WHETHER the caller named the control.
  const namedByCaller =
    namesSomething(props['aria-label']) || namesSomething(props['aria-labelledby']);

  const hasLabelContent = isRenderable(children);

  // Three label shapes, and they are mutually exclusive. A labelled button
  // shows its text; an icon-only button the caller named needs no label node
  // at all; an icon-only button the caller did not name keeps its text in the
  // accessibility tree so the control is never announced unnamed.
  const showVisibleLabel = !iconOnly && hasLabelContent;
  const showHiddenLabel = iconOnly && !namedByCaller && hasLabelContent;

  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled}
      className={clsx(
        'dg-button',
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        iconOnly && 'dg-button--icon-only',
        fullWidth && 'dg-button--full',
        disabled && 'dg-is-disabled',
        className,
      )}
    >
      {isRenderable(icon) ? (
        <span className="dg-button__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {showVisibleLabel ? <span className="dg-button__label">{children}</span> : null}
      {showHiddenLabel ? <span className="dg-visually-hidden">{children}</span> : null}
    </button>
  );
}
