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
 * ## An accessible name is not optional — the type requires one
 *
 * Accessibility outranks everything below it in AAP 0.6.4's precedence order,
 * and the name of a control is the part of it a screen-reader user has. So the
 * requirement is carried by {@link ButtonProps} itself rather than by a
 * convention: the props are the design system's own props
 * ({@link ButtonOwnProps}) intersected with {@link ButtonAccessibleName}, a
 * union of the three ways a name can arrive — renderable `children`, a
 * `string` `aria-label`, or a `string` `aria-labelledby`. Supplying none of
 * them does not compile, which is what makes `<Button iconOnly icon={…} />`
 * and the equally unnamed `<Button variant="primary" />` caller defects the
 * compiler catches rather than defects a user discovers.
 *
 * The rule deliberately covers both forms. An icon-only chip is the obvious
 * unnamed case, but a button with no label at all is just as unnamed, and one
 * rule over every call site is simpler to honour — and simpler to read at a
 * call site — than a rule that applies only when a particular prop is true.
 *
 * What a type cannot see is a name that is present but empty at runtime
 * (`aria-label={row.title}` where the title is blank, `children={label}` where
 * the label resolved to `''` or `null`). {@link reportMissingAccessibleName}
 * covers exactly that residue: the component reports the caller defect on the
 * console, once per distinct call shape, and changes nothing about what it
 * renders. It never invents a name, never shows fallback text and never lets
 * the `aria-hidden` icon box become the name — an icon is never the accessible
 * name (AAP 0.6.4).
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
 * The `type` an unqualified `<Button>` renders — see this module's header for
 * why it is `"button"` and not the browser's `"submit"`.
 *
 * Named rather than inlined because two places read it: the default of the
 * destructuring below, and the call signature
 * {@link reportMissingAccessibleName} builds, which must describe the button
 * that was actually rendered.
 *
 * Typed from React's own attribute union with the `undefined` stripped off, so
 * that a future value has to be one HTML actually accepts and the destructured
 * default never widens back to "possibly unset".
 */
const DEFAULT_TYPE: NonNullable<ButtonHTMLAttributes<HTMLButtonElement>['type']> = 'button';

/**
 * Everything {@link ButtonProps} carries except the three props that name the
 * control, which {@link ButtonAccessibleName} owns.
 *
 * Extending `ButtonHTMLAttributes<HTMLButtonElement>` is deliberate and is what
 * keeps this interface short: `onClick`, `onKeyDown`, `disabled`, `title`,
 * `form`, `name`, `value`, every other `aria-*` attribute (`aria-pressed` for
 * the picker and capture toggles, `aria-expanded`/`aria-controls` for a row's
 * expand affordance) and every `data-*` attribute pass straight through to the
 * element without being enumerated here. Only the props the design system adds
 * are declared below.
 *
 * `children`, `aria-label` and `aria-labelledby` are the three the `Omit`
 * removes, because React's own attribute types make all three optional and
 * that is precisely the combination — all three absent — that yields an
 * unnamed control. They come back through {@link ButtonAccessibleName}, which
 * requires one of them, and the intersection of the two is
 * {@link ButtonProps}.
 *
 * Every added prop spells `| undefined`: `exactOptionalPropertyTypes` is in
 * force repository-wide (tsconfig.base.json), and a caller that forwards an
 * optional value it may not have — `variant={props.variant}` — must remain
 * legal. React's own attribute types are written the same way.
 */
export interface ButtonOwnProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'aria-label' | 'aria-labelledby'
> {
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
   * The control still needs an accessible name, and it cannot be the glyph:
   * the `dg-button__icon` box is always `aria-hidden`. The name arrives in one
   * of two ways, both of which {@link ButtonAccessibleName} already requires
   * of every call site, icon-only or not:
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
   * form does not type-check, so the unnamed icon chip cannot be written; a
   * form that is present in the type but empty at runtime is reported by
   * {@link reportMissingAccessibleName} instead, because nothing this
   * component could render in its place would be the name the caller meant.
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
 * Naming route 1 — the control is named by its `children`.
 *
 * `children` is **required**, which is what rejects `<Button />`. The text is
 * shown in a `dg-button__label` box normally, and moved into a
 * `dg-visually-hidden` box when `iconOnly` is set and the caller supplied no
 * ARIA attribute, so the same call site reads the same way in both forms.
 *
 * Both ARIA attributes stay available and optional here: a caller may name the
 * control by `aria-label` *and* render children (a chip whose visible text is
 * shorter than the name it announces), and when it does, the ARIA attribute
 * wins in the accessibility tree exactly as the ARIA specification says.
 */
export interface ButtonNamedByChildren {
  /** The label content. Required: it is this route's accessible name. */
  children: ReactNode;

  /** An optional ARIA name that overrides the children in the a11y tree. */
  'aria-label'?: string | undefined;

  /** An optional ARIA name by reference, with the same override semantics. */
  'aria-labelledby'?: string | undefined;
}

/**
 * Naming route 2 — the control is named by `aria-label`.
 *
 * The usual route for an icon-only chip, where there is no text to reuse.
 * `aria-label` is a required `string`, so `aria-label={maybeUndefined}` does
 * not satisfy it and does not compile: a name the caller only *might* have is
 * not a name. A caller holding an optional value narrows it first, which is
 * the point at which it has to decide what the empty case should announce.
 */
export interface ButtonNamedByAriaLabel {
  /** Optional here: the ARIA name already names the control. */
  children?: ReactNode | undefined;

  /** The accessible name. Required, and required to be a `string`. */
  'aria-label': string;

  /** An optional reference-based name, which takes precedence per ARIA. */
  'aria-labelledby'?: string | undefined;
}

/**
 * Naming route 3 — the control is named by `aria-labelledby`.
 *
 * For the controls whose name is already on screen in another element: a
 * section heading, a table column header, the summary line of a row. The id
 * reference is a required `string` for the same reason `aria-label` is in
 * {@link ButtonNamedByAriaLabel}.
 */
export interface ButtonNamedByAriaLabelledBy {
  /** Optional here: the referenced element already names the control. */
  children?: ReactNode | undefined;

  /** An optional literal name; `aria-labelledby` still wins per ARIA. */
  'aria-label'?: string | undefined;

  /** The id reference that names the control. Required. */
  'aria-labelledby': string;
}

/**
 * The accessible-name requirement of {@link Button}, as a type.
 *
 * A union rather than three optional props: a union is satisfied by at least
 * one constituent, so "children, or `aria-label`, or `aria-labelledby`" is
 * expressible without a discriminant prop the caller would have to set. Any
 * combination of the three is still legal — the constituents overlap on
 * purpose — but the empty combination belongs to no constituent and therefore
 * does not compile.
 *
 * `title` is deliberately NOT a route here even though HTML-AAM makes it the
 * last-resort name computation: a tooltip is invisible to touch users, absent
 * for keyboard users, and untranslated in several assistive technologies, so
 * it is not something this design system lets a caller rely on. It is honoured
 * only by {@link reportMissingAccessibleName}, which must not report a control
 * the platform does end up naming.
 */
export type ButtonAccessibleName =
  ButtonNamedByChildren | ButtonNamedByAriaLabel | ButtonNamedByAriaLabelledBy;

/**
 * The props of {@link Button}: its own props plus the naming requirement.
 *
 * An intersection of an interface and a union distributes as a reader expects
 * — `ButtonOwnProps & ButtonNamedByChildren`, or `& ButtonNamedByAriaLabel`,
 * or `& ButtonNamedByAriaLabelledBy` — so every prop of
 * {@link ButtonOwnProps} is available on all three routes.
 *
 * @example Named by its visible label.
 * ```tsx
 * <Button variant="primary" onClick={onSubmit}>Ask</Button>
 * ```
 * @example An icon-only chip named by `aria-label`.
 * ```tsx
 * <Button iconOnly variant="ghost" icon={<XIcon className="dg-icon" />} aria-label="Dismiss" />
 * ```
 * @example An icon-only chip whose name is its children, hidden visually.
 * ```tsx
 * <Button iconOnly icon={<SortIcon className="dg-icon" />}>Sort by duration</Button>
 * ```
 * @example Named by an element that is already on screen.
 * ```tsx
 * <Button aria-labelledby={headingId} icon={<ExpandIcon className="dg-icon" />} iconOnly />
 * ```
 */
export type ButtonProps = ButtonOwnProps & ButtonAccessibleName;

/**
 * The same props with all three naming props optional again — the shape the
 * component destructures, and nothing a caller ever writes.
 *
 * Destructuring a union does not admit a rest element (TypeScript has no
 * single object type to subtract the named properties from), so the pattern is
 * annotated with this all-optional supertype instead. Every constituent of
 * {@link ButtonAccessibleName} is assignable to it, which is what makes the
 * annotation sound without a cast, an `any` or a non-null assertion: inside
 * the component the naming props are genuinely only *possibly* present, and
 * the code below treats them that way.
 */
interface ButtonResolvedProps extends ButtonOwnProps {
  /** Possibly-absent label content, per {@link ButtonAccessibleName}. */
  children?: ReactNode | undefined;

  /** Possibly-absent literal ARIA name. */
  'aria-label'?: string | undefined;

  /** Possibly-absent reference-based ARIA name. */
  'aria-labelledby'?: string | undefined;
}

/**
 * Whether an ARIA string attribute actually names something.
 *
 * `aria-label=""` and a whitespace-only value are both *present* and both name
 * nothing, so they must not satisfy the requirement of
 * {@link ButtonAccessibleName}; treating them as a name is how an icon-only
 * control ends up announced as "button" and nothing else. It is also why the
 * type-level requirement is not the whole guarantee: the compiler sees a
 * `string`, and only this function sees that the string is blank.
 *
 * Also applied to `title` inside {@link Button}, which is a `string` prop of
 * the same shape — see {@link ButtonAccessibleName} for why `title` is a
 * runtime consideration and never a type-level naming route.
 *
 * @param value The attribute value as the caller passed it, if at all.
 * @returns `true` when the value contributes an accessible name.
 */
function namesSomething(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

/**
 * Whether a node is a list of child nodes rather than a single one.
 *
 * Written as a type guard over the `Iterable<ReactNode>` member of `ReactNode`
 * so that {@link isRenderable} can walk it without a cast. Strings are
 * iterable too, which is why {@link isRenderable} decides the string case
 * before reaching here.
 *
 * @param node The node to classify.
 * @returns `true` when the node can be iterated for child nodes.
 */
function isNodeList(node: ReactNode): node is Iterable<ReactNode> {
  return typeof node === 'object' && node !== null && Symbol.iterator in node;
}

/**
 * Whether a node would render anything a reader could perceive.
 *
 * `null`, `undefined` and both booleans render nothing in React, so none of
 * them justifies a label box — and none of them can serve as the accessible
 * name of an icon-only control either. A string that trims to nothing (`''`,
 * `' '`, `'\n'`) is treated the same way: whitespace occupies no accessible
 * name, and an empty box in the accessibility tree is worse than no box,
 * because it makes an unnamed control look named. `0` is renderable and stays
 * renderable, as does any other number and any `bigint` (AAP 0.6.4's
 * defensive rule: never render "null" or "undefined" as visible text, and
 * never drop a legitimate zero).
 *
 * A list of children — `children={[icon, label]}`, or the array JSX builds
 * from `<Button>{icon}{label}</Button>` — is renderable when at least one of
 * its members is, scanned recursively so a nested list behaves like a flat
 * one. That case is the reason this function is not a single expression:
 * `[null, '']` is a non-null `children` value that renders nothing at all.
 *
 * What it cannot judge: an element, a portal or a promise, all of which it
 * reports as renderable. This component cannot look inside a child element to
 * find out whether it will produce text, and must not try — so a caller that
 * passes `children={<span />}` as the name of an icon-only control has named
 * nothing, and no guard here can tell. The contract is that `children` used as
 * a name carries text.
 *
 * @param node The `children` (or `icon`) the caller supplied, if any.
 * @returns `true` when the node contributes visible or announced content.
 */
function isRenderable(node: ReactNode): boolean {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return false;
  }

  if (typeof node === 'string') {
    return node.trim() !== '';
  }

  if (isNodeList(node)) {
    for (const child of node) {
      if (isRenderable(child)) {
        return true;
      }
    }

    return false;
  }

  return true;
}

/**
 * The prefix every diagnostic this module writes carries, matching the
 * `[debuggen-preload]` convention the Node telemetry sink uses: a message on a
 * host console shares that console with the application under investigation,
 * so it has to say which tool produced it.
 */
const DIAGNOSTIC_PREFIX = '[debuggen/panel-renderer] Button:';

/**
 * How many distinct unnamed call shapes {@link reportMissingAccessibleName}
 * remembers before it forgets all of them.
 *
 * The set exists so that one defective call site rendered in a loop, or
 * re-rendered by React's StrictMode double invocation, reports once instead of
 * once per render — the console this writes to is the one the product's users
 * are reading. The cap is what keeps that memory from becoming a leak in a
 * long-lived panel: at the cap the set is cleared rather than left to grow, so
 * a surface that genuinely has more than this many distinct defective shapes
 * repeats its reports occasionally instead of going permanently silent, and
 * the memory held is bounded by the cap either way.
 */
const MAX_REMEMBERED_UNNAMED_SHAPES = 64;

/**
 * The unnamed call shapes already reported, keyed by the signature
 * {@link buildCallSignature} builds. Module-level on purpose: deduplication
 * must survive unmounting and remounting the control, which per-instance state
 * would not.
 */
const reportedUnnamedShapes = new Set<string>();

/**
 * A stable key for the *kind* of call, not the instance.
 *
 * Built from the props that distinguish one call site from another — the
 * variant, the density, the rendered `type`, the caller's `className`, whether
 * the chip is icon-only and whether an icon was supplied. Two rows of the same
 * table render the same signature, which is what makes deduplication useful;
 * two different defective controls on one surface differ in at least one of
 * these, which is what keeps the second one from being swallowed.
 *
 * @param props The props as the caller supplied them.
 * @returns The signature, safe to log — it holds no caller content.
 */
function buildCallSignature(props: ButtonResolvedProps): string {
  return [
    props.variant ?? DEFAULT_VARIANT,
    props.size ?? DEFAULT_SIZE,
    props.type ?? DEFAULT_TYPE,
    props.className ?? '',
    props.iconOnly === true ? 'icon-only' : 'with-label',
    isRenderable(props.icon) ? 'with-icon' : 'no-icon',
  ].join('|');
}

/**
 * How a single ARIA naming attribute failed, in words a caller can act on.
 *
 * Called only from {@link reportMissingAccessibleName}, and therefore only for
 * a value {@link namesSomething} has already rejected: it is either absent, or
 * present and empty once trimmed. Those are the two cases a caller has to tell
 * apart, because they point at different mistakes — a route never wired up
 * versus a route wired to a value that arrived blank.
 *
 * @param value The attribute value as the caller passed it, if at all.
 * @returns `"absent"`, or `"present but blank"` for an empty or blank value.
 */
function describeAriaGap(value: string | undefined): string {
  return value === undefined ? 'absent' : 'present but blank';
}

/**
 * Report, once per call shape, that a rendered button has no accessible name.
 *
 * {@link ButtonAccessibleName} already rejects the call that supplies no
 * naming prop at all, so this covers only what a type cannot see: a naming
 * prop that is present in the type and empty at the moment of rendering —
 * `aria-label={row.heading}` where the heading is `''`, or
 * `children={label}` where the label resolved to `null`, `' '` or `[null, '']`.
 *
 * It reports and returns. It does not repair: inventing a name would put a
 * word the caller did not choose into the accessibility tree, rendering
 * fallback text would change the surface, and throwing would take down a panel
 * over a label. The message names no application identifier (AAP 0.5.4) —
 * every value in it comes from this design system's own vocabulary.
 *
 * Written to run during render rather than from an effect, so the report sits
 * next to the render it describes in the console and appears even for a tree
 * that renders but never commits — a discarded or suspended render is exactly
 * the case an effect would miss. It is idempotent with respect to what the
 * user sees, which is what makes running it during render safe.
 *
 * It is not gated behind a development-only flag, and cannot be: this package
 * is browser-only by contract — tsup builds it with `platform: "browser"` and
 * its tsconfig forbids any module here from reading `process` or an
 * `import.meta` environment — so there is no build-time flag to branch on. An
 * ungated report is the right trade in any case, because the deduplication
 * above bounds it to one line per distinct defective call shape: a developer
 * running a packaged panel still learns that one of its controls is unnamed,
 * and nobody pays more than those few lines.
 *
 * @param props The props as the caller supplied them.
 */
function reportMissingAccessibleName(props: ButtonResolvedProps): void {
  const signature = buildCallSignature(props);

  if (reportedUnnamedShapes.has(signature)) {
    return;
  }

  if (reportedUnnamedShapes.size >= MAX_REMEMBERED_UNNAMED_SHAPES) {
    reportedUnnamedShapes.clear();
  }

  reportedUnnamedShapes.add(signature);

  console.error(
    `${DIAGNOSTIC_PREFIX} rendered a control with no accessible name, which assistive ` +
      'technology announces as "button" and nothing else. None of the three naming routes ' +
      `carried a name: children ${props.children === undefined ? 'absent' : 'render nothing'}` +
      `, aria-label ${describeAriaGap(props['aria-label'])}` +
      `, aria-labelledby ${describeAriaGap(props['aria-labelledby'])}. ` +
      'Pass label text as children, or aria-label with the name, or aria-labelledby ' +
      'referencing the element that already names this control. The icon cannot serve: its ' +
      `box is aria-hidden by contract. Call shape: ${signature}`,
  );
}

/**
 * The button primitive.
 *
 * See this module's header for the variants, the class contract, the
 * `type="button"` default and the accessible-name requirement; see
 * {@link ButtonProps} for the props and their tokens.
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
    type = DEFAULT_TYPE,
    disabled = false,
    className,
    children,
    ref,
    ...rest
  }: ButtonResolvedProps = props;

  // Read the ARIA naming attributes off `props` instead of destructuring them:
  // left in `rest`, they reach the element unchanged, and this component only
  // needs to know WHETHER the caller named the control.
  const namedByCaller =
    namesSomething(props['aria-label']) || namesSomething(props['aria-labelledby']);

  const hasLabelContent = isRenderable(children);

  // The type guarantees a naming prop was PASSED; only the runtime can tell
  // whether it names anything. `title` joins the check here — and nowhere in
  // the type — because the platform's own name computation falls back to it,
  // so a control carrying one is not the unnamed control this reports.
  if (!namedByCaller && !hasLabelContent && !namesSomething(props.title)) {
    reportMissingAccessibleName(props);
  }

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
