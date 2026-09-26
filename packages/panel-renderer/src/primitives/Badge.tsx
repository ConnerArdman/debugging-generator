/**
 * `Badge` — the status and label chip of `@debuggen/panel-renderer`.
 *
 * ## Why this primitive exists
 *
 * A generated panel is dense with short, colour-coded labels: the tier a span
 * belongs to, the kind of an event, how many times a request repeated or a
 * component rendered, whether a recorded file modification is applied,
 * reverted or in conflict, where a session stands, how confident a hypothesis
 * is, and whether the panel is connected to its session at all. This component
 * is the single sanctioned way to draw any of them (AAP 0.6.2), so the same
 * fact reads identically wherever it appears — in a summary header, in a table
 * cell, in a detail drawer, in the Chrome DevTools panel and in the VS Code
 * webview.
 *
 * It renders one `<span>`: no wrapper, no margin and no layout of its own.
 * Chips sit inside table rows, toolbars and heading lines where an unexpected
 * box would break the row's alignment, so spacing between a chip and its
 * neighbours belongs to the layout primitive around them.
 *
 * ## Tier
 *
 * Tier 1 atom. It imports nothing from this package — only React's types and
 * `clsx` — so no primitive, layout element or visualization component can
 * create an import cycle through it.
 *
 * ## The two colouring routes, and why there are two
 *
 * AAP 0.6.3 defines two disjoint colour families, with different contrast
 * guarantees, and this component exposes one route for each.
 *
 * 1. **`tone` — the status family.** Six semantic values resolving to
 *    `--dg-success`, `--dg-warning`, `--dg-danger`, `--dg-info`,
 *    `--dg-accent`/`--dg-accent-muted` and the neutral surface, border and
 *    text tokens. Every status colour is documented to measure at least
 *    4.86:1 against every surface of its theme, so it is safe as the chip's
 *    own text colour. This is the route for anything whose meaning is a state.
 *
 * 2. **`color` — the span-kind scale.** The separate seven-value set
 *    `--dg-kind-interaction`, `--dg-kind-render`, `--dg-kind-fetch`,
 *    `--dg-kind-http`, `--dg-kind-function`, `--dg-kind-db` and
 *    `--dg-kind-error`, which AAP 0.6.3 holds to 3:1 only *because it is used
 *    as a fill behind a text label*. A chip coloured from that scale therefore
 *    keeps its label in a text tone and spends the kind colour on its fill,
 *    its hairline or its dot — never on the glyphs. That rule is implemented
 *    by the stylesheet rules behind `--dgc-badge-color` (see the contract
 *    below); this file supplies the value and never a colour of its own.
 *
 * The split is not cosmetic: it is what keeps this primitive schema-agnostic.
 * The vocabularies that decide which kind colour a row gets — telemetry kinds,
 * tiers, dependency-graph participant classes, render triggers — belong to
 * `@debuggen/telemetry`, and folding one of them onto the token scale belongs
 * to `../utils/color`. Importing either here would drag the event model into an
 * atom that has no business knowing it, so the fold happens at the call site
 * and arrives as an opaque string:
 *
 * ```tsx
 * <Badge color={kindColorVar(event.kind)}>{formatKind(event.kind)}</Badge>
 * ```
 *
 * Every export of `../utils/color` answers with a token key or a
 * `var(--dg-*)` reference and never with a literal colour, which is what keeps
 * `color` compatible with AAP 0.6.4's prohibition on hardcoded CSS values. A
 * literal — a hex triplet, an `rgb`/`hsl` function value, a named colour, a
 * gradient — passed here would violate that
 * rule and would also defeat theming, since a token reference is how a chip
 * follows the `data-theme` cascade. Nothing in this file defaults `color` or
 * falls back to a literal: when it is absent no inline value is emitted at
 * all and the stylesheet's own `var(--dg-*)` fallback applies.
 *
 * ## Domain vocabularies are mapped by the caller, with one shared exception
 *
 * A confidence level, a tier, a modification status and a session status are
 * all *domain* vocabularies owned by the packages that define them
 * (`@debuggen/panel-schema`, `@debuggen/telemetry`, `@debuggen/instrumentation`
 * and `@debuggen/protocol`). Each consumer maps its own vocabulary onto `tone`
 * before it renders — `../layout/SummaryHeader` turns a hypothesis confidence
 * level into a tone and a per-level glyph beside each likely cause, so the
 * levels differ by shape as well as by colour, and the visualization components
 * in `../components` turn a tier, a status or a duplicate count into one — so
 * that this atom stays free of every one of those types. A `tone` union
 * enumerating domain states, or a `kind` prop, would invert that and is
 * deliberately not offered.
 *
 * One table is the exception, and it is exported rather than applied:
 * {@link MODIFICATION_STATUS_TONE}, the tone of each of the five journal
 * statuses of a recorded file modification. The same journal status is drawn
 * by two surfaces in two apps — the editor webview's `ModificationsList` and
 * the DevTools panel's `SessionSummary` — and this package is the only module
 * both depend on, so a mapping kept anywhere else would be two mappings free to
 * drift apart and draw one status in two colours. The table still keeps the
 * atom free of the domain type: its keys are the five status literals and
 * nothing here imports the vocabulary that defines them. Each consumer assigns
 * it to a `Readonly<Record<ModificationStatus, BadgeTone>>` of its own, so a
 * status added upstream is a compile error at every surface until this table
 * covers it. `Badge` itself never reads the table; the words beside the colour
 * stay the consumer's.
 *
 * ## Markup and accessibility
 *
 * A `<span>` with text inside, and nothing more:
 *
 * - **Colour is never the sole carrier of meaning** (AAP 0.6.4). A chip always
 *   prints its meaning as text, or is named by an `aria-label` the caller
 *   passes through. A coloured chip with no accessible name is not a label,
 *   and this component will not synthesise one from a tone — see
 *   {@link BadgeProps.children}.
 * - **The icon is decorative.** Its box always carries `aria-hidden="true"`,
 *   so a glyph can never become the name of the chip.
 * - **No `role`, no `tabIndex`, no handler of its own.** A badge is a label,
 *   not a live region and not a control: `role="status"` would make every
 *   re-render announce itself, and the surfaces that genuinely need a live
 *   region (the analysis summary, the connection pill) own that semantics
 *   themselves at the level where the announcement makes sense. A chip that
 *   must be clickable is a `Button` with the chip's own styling, not this
 *   component with a handler attached.
 * - `id`, `title`, `aria-label`, `aria-describedby`, `data-*` and every other
 *   HTML attribute pass straight through, because a chip is frequently the
 *   thing a tooltip describes or a test selects.
 *
 * ## Class-name and custom-property contract declared by this file
 *
 * The rules for these names live in `../styles/components.css`; this file
 * contributes class names and one token reference, never a literal length,
 * colour or any other inline value (AAP 0.6.4).
 *
 * | Name                    | Role                                              |
 * | ----------------------- | ------------------------------------------------- |
 * | `dg-badge`              | block: the chip itself                            |
 * | `dg-badge--neutral`     | tone: surface and border tokens, secondary text    |
 * | `dg-badge--accent`      | tone: `--dg-accent` / `--dg-accent-muted`          |
 * | `dg-badge--success`     | tone: `--dg-success`                               |
 * | `dg-badge--warning`     | tone: `--dg-warning`                               |
 * | `dg-badge--danger`      | tone: `--dg-danger`                                |
 * | `dg-badge--info`        | tone: `--dg-info`                                  |
 * | `dg-badge--solid`       | fill: tone colour as the surface                   |
 * | `dg-badge--soft`        | fill: tinted surface, tone-coloured text           |
 * | `dg-badge--outline`     | fill: no surface, tone-coloured hairline and text  |
 * | `dg-badge__icon`        | element: the decorative glyph box                  |
 *
 * And one component-scoped custom property: `--dgc-badge-color`, set inline
 * only when {@link BadgeProps.color} is passed, and consumed by the stylesheet
 * as `var(--dgc-badge-color, var(--dg-*))` so that a chip with no colour of its
 * own still resolves to a token.
 *
 * Exactly one tone class and one fill class are always present, so the
 * stylesheet never has to encode a default in a bare `.dg-badge` rule and a
 * chip cannot render un-toned. The `--dgc-` prefix is this package's
 * established namespace for "a value only the component knows, handed to CSS
 * with a token fallback", as `../styles/base.css` documents.
 *
 * Tokens those rules resolve to, and the only values a chip may take: the
 * status and neutral colours listed above, `--dg-text-xs`/`--dg-text-sm` for
 * the label (`--dg-mono-sm` where a chip prints an identifier), `--dg-space-*`
 * for its padding and the gap before its label, `--dg-radius-sm` for its
 * corners and `--dg-border-subtle`/`--dg-border-strong` for its hairline.
 *
 * ## Numbers
 *
 * Counts are the most common chip content — repeats of one request, renders of
 * one component, executions of one statement — and they are formatted before
 * they arrive. `../utils/format` turns a count into its printed form and
 * `Text`'s `numeric` option supplies tabular figures where a column of chips
 * has to align; this component adds no formatting of its own, so a caller that
 * passes a raw number gets exactly that number printed.
 */

import { clsx } from 'clsx';
import type { CSSProperties, HTMLAttributes, ReactElement, ReactNode, Ref } from 'react';

/**
 * The semantic status families a chip can carry.
 *
 * Each value maps to exactly one class in {@link TONE_CLASS} and to the status,
 * accent or neutral tokens named in this module's header. The union is
 * deliberately semantic rather than chromatic: a caller asks for "danger", not
 * for a colour, so the same state is drawn the same way in both themes and in
 * the high-contrast theme.
 *
 * It is also deliberately *not* a domain vocabulary. A tier, a session status
 * and a confidence level are each mapped onto one of these six by the
 * component that owns that vocabulary; a modification status is mapped once,
 * for both surfaces, by {@link MODIFICATION_STATUS_TONE}.
 */
export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

/**
 * The badge tone of each journal status of a recorded file modification — the
 * one domain mapping this module publishes (see the module header for why).
 *
 * Five statuses, five distinct tones, so no two statuses share a colour and
 * the text label beside each colour still carries the meaning on its own:
 *
 * - `pending` → `neutral`: recorded before the write; nothing to act on yet.
 * - `applied` → `info`: the instrumentation is in place, as intended.
 * - `reverted` → `success`: restored and verified — the tone a `clean`
 *   cleanup carries on both surfaces.
 * - `conflict` → `warning`: the tool refused to overwrite the developer's
 *   edit. That needs attention but is not a failure — the tone a `conflict`
 *   cleanup carries on both surfaces.
 * - `failed` → `danger`: the change could not be completed.
 *
 * Keyed by the five status literals rather than by the `ModificationStatus`
 * type, which this package does not depend on. Frozen, so no consumer can
 * re-colour a status for every other surface at run time.
 *
 * @example Adopting the table in a consumer, typed against the domain union so
 * a status added upstream is a compile error here until the table covers it.
 * ```tsx
 * const STATUS_TONE: Readonly<Record<ModificationStatus, BadgeTone>> =
 *   MODIFICATION_STATUS_TONE;
 *
 * <Badge tone={STATUS_TONE[record.status]}>{statusLabel(record.status)}</Badge>
 * ```
 */
export const MODIFICATION_STATUS_TONE = Object.freeze({
  pending: 'neutral',
  applied: 'info',
  reverted: 'success',
  conflict: 'warning',
  failed: 'danger',
} as const satisfies Readonly<Record<string, BadgeTone>>);

/**
 * How strongly a chip is filled, in descending prominence.
 *
 * `solid` spends the tone colour on the surface and prints its label in the
 * contrasting text tone — the weight reserved for a state a reader must not
 * miss. `soft` is the default: a tinted surface with the label in the tone
 * colour, legible in a dense table without pulling the eye off the data.
 * `outline` drops the surface entirely and keeps a tone-coloured hairline and
 * label, for a chip that sits on an already-tinted row and would otherwise read
 * as a second background.
 *
 * Each value maps to exactly one class in {@link VARIANT_CLASS}.
 */
export type BadgeVariant = 'solid' | 'soft' | 'outline';

/**
 * The tone classes, as a total lookup rather than an interpolated string.
 *
 * A `Record` keyed by the finite union is what makes the mapping checkable: a
 * tone added to {@link BadgeTone} fails to compile until its class exists, and
 * indexing with a `BadgeTone` is total, so `noUncheckedIndexedAccess` does not
 * widen the result to `string | undefined`. Interpolation
 * (`` `dg-badge--${tone}` ``) would type-check while producing a class no
 * stylesheet defines.
 */
const TONE_CLASS: Readonly<Record<BadgeTone, string>> = {
  neutral: 'dg-badge--neutral',
  accent: 'dg-badge--accent',
  success: 'dg-badge--success',
  warning: 'dg-badge--warning',
  danger: 'dg-badge--danger',
  info: 'dg-badge--info',
};

/** The fill classes, total over {@link BadgeVariant} for the same reason. */
const VARIANT_CLASS: Readonly<Record<BadgeVariant, string>> = {
  solid: 'dg-badge--solid',
  soft: 'dg-badge--soft',
  outline: 'dg-badge--outline',
};

/**
 * The tone an unqualified `<Badge>` renders: the neutral surface, which states
 * nothing about severity. A chip that means something is asked to say so.
 */
const DEFAULT_TONE: BadgeTone = 'neutral';

/**
 * The fill an unqualified `<Badge>` renders. `soft` is the density the product
 * is built at — chips appear by the dozen in tables and summaries, where a
 * solid fill in every row would compete with the data it annotates.
 */
const DEFAULT_VARIANT: BadgeVariant = 'soft';

/**
 * A style object that may also carry CSS custom properties.
 *
 * React's `CSSProperties` declares no index signature, so a literal holding a
 * `--dgc-*` key does not satisfy it. A pattern index signature over
 * `--${string}` widens the type by exactly the custom properties and nothing
 * else, which keeps the one inline value this component sets free of a cast —
 * no `as`, no `any`, no `Record<string, string>` escape hatch. File-local and
 * not exported: it describes an implementation detail of this chip, and
 * `DataTable` declares the same shape for its own computed properties.
 *
 * Nothing but a `--dgc-*` value may appear in an object of this type here. A
 * geometric or chromatic literal would be the hardcoded CSS value AAP 0.6.4
 * forbids, and a value the stylesheet could compute itself belongs in
 * `../styles/components.css` instead.
 */
type CssVariableStyle = CSSProperties & Record<`--${string}`, string>;

/**
 * Whether a supplied glyph would actually paint something.
 *
 * `ReactNode` admits the values a conditional call site produces —
 * `icon={hasSource && <SomeIcon className="dg-icon" />}` yields `false`, and a
 * computed label can be an empty string — and React renders none of them. The
 * check exists so that such a value leaves out the `dg-badge__icon` box
 * entirely rather than emitting an empty one, which would still carry the box's
 * gap and pull the label off the chip's centre. `0` is deliberately renderable:
 * it prints.
 */
function isRenderableIcon(node: ReactNode): boolean {
  if (node === undefined || node === null || typeof node === 'boolean') {
    return false;
  }

  if (typeof node === 'string') {
    return node.trim().length > 0;
  }

  return true;
}

/**
 * Props of {@link Badge}.
 *
 * Extending `HTMLAttributes<HTMLSpanElement>` is what keeps this interface
 * short: `id`, `title`, `lang`, `aria-label`, `aria-describedby`, `role` (for
 * the rare caller that genuinely needs one), every `data-*` attribute and
 * `style` pass through to the rendered element without being enumerated here.
 * Only the props the design system adds are declared below.
 *
 * Every added prop spells `| undefined`: `exactOptionalPropertyTypes` is in
 * force repository-wide (tsconfig.base.json), and a caller that forwards an
 * optional value it may not have — `tone={row.tone}` — must remain legal.
 * React's own attribute types are written the same way.
 */
export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /**
   * The semantic status family. Defaults to `"neutral"`.
   *
   * `neutral` draws on `--dg-surface-elevated`/`--dg-surface-overlay` inside
   * `--dg-border-subtle` with `--dg-text-secondary` glyphs; `accent` carries
   * `--dg-accent` (with `--dg-accent-muted` as its soft surface); `success`,
   * `warning`, `danger` and `info` carry `--dg-success`, `--dg-warning`,
   * `--dg-danger` and `--dg-info`. All six are safe as text on every surface
   * of their theme, which is why a tone may colour the label itself.
   */
  tone?: BadgeTone | undefined;

  /**
   * How strongly the chip is filled. Defaults to `"soft"`. See
   * {@link BadgeVariant} for what each value spends the tone colour on.
   */
  variant?: BadgeVariant | undefined;

  /**
   * A colour from the span-kind scale, as a **CSS custom-property reference**,
   * for a chip whose subject is a kind or a tier rather than a status.
   *
   * The only values this prop is meant to receive are the ones
   * `../utils/color` returns — `kindColorVar(kind)`, `tierColorVar(tier)` and
   * their siblings — each of which is a `var(--dg-*)` reference built from the
   * token table and never a literal colour. Passing it here is how a kind or a
   * tier reaches this chip without this primitive importing the telemetry
   * vocabularies that define them (see this module's header).
   *
   * The value is published to the stylesheet as the `--dgc-badge-color`
   * custom property on the element and consumed with a token fallback, so the
   * kind colour lands on the chip's fill, hairline or dot while its label keeps
   * a text tone — the contrast rule AAP 0.6.3 attaches to that scale, which is
   * held to 3:1 precisely because it sits *behind* a label.
   *
   * Two things this prop is not. It is not a way to pass a literal colour: a
   * hex triplet, `rgb`/`hsl` function value or named colour is the hardcoded
   * CSS value AAP 0.6.4
   * forbids, would ignore the `data-theme` cascade, and is neither defaulted
   * nor fallen back to anywhere in this file. And it is not an alternative to
   * {@link BadgeProps.tone}: the two compose, because the tone class still
   * decides the chip's text colour and its neutral geometry.
   *
   * When absent, no `style` attribute is emitted at all and the stylesheet's
   * own `var(--dg-*)` fallback applies.
   */
  color?: string | undefined;

  /**
   * A **leading** glyph, rendered before the label inside a `dg-badge__icon`
   * box that is always `aria-hidden` — an icon is never the accessible name
   * (AAP 0.6.4).
   *
   * Pass the glyph already carrying the global `dg-icon` class —
   * `icon={<SomeIcon className="dg-icon" />}` — so it takes its `1em` square
   * and `currentColor` from `../styles/base.css` and scales with the chip's
   * type role. Never pass an icon library's numeric `size` or `color` prop:
   * those are hardcoded values, which AAP 0.6.4 forbids, and `color` would
   * additionally break the chip's tone in the other theme.
   *
   * A trailing slot is not offered. Iconography sits before the label
   * throughout this design system, and a second slot would let two callers
   * disagree about the same chip.
   */
  icon?: ReactNode | undefined;

  /**
   * The chip's label — the text that carries its meaning.
   *
   * Effectively required in practice: colour may never be the sole carrier of
   * meaning (AAP 0.6.4), so a chip with no children must be named by an
   * `aria-label` (or `aria-labelledby`) passed through the inherited HTML
   * attributes. It stays optional in the type because the icon-plus-`aria-label`
   * form is legitimate — a dot that marks a lane's colour in a legend, named in
   * words for assistive technology — but a chip with neither children nor an
   * ARIA name is an unlabelled colour swatch, and this component will not
   * invent a name from its tone to paper over one.
   */
  children?: ReactNode | undefined;

  /**
   * A ref to the underlying element, for the callers that must measure or
   * scroll to it.
   *
   * React 19 passes `ref` as an ordinary prop, so this component is a plain
   * function and `forwardRef` is neither needed nor used.
   */
  ref?: Ref<HTMLSpanElement> | undefined;
}

/**
 * Renders a short, colour-coded label as a chip.
 *
 * See the file-level documentation for the two colouring routes, the
 * class-name and custom-property contract, and the tokens a chip resolves to.
 *
 * @example A modification whose file was edited while instrumented: a refusal
 * to overwrite, drawn in the shared status tone with its word beside it.
 * ```tsx
 * <Badge tone={MODIFICATION_STATUS_TONE.conflict}>Conflict</Badge>
 * ```
 *
 * @example A hypothesis confidence level, mapped to a tone and a glyph by the
 * caller, so the level reads by shape and by word as well as by colour.
 * ```tsx
 * <Badge
 *   tone={confidenceTone(hypothesis.confidence)}
 *   icon={confidenceIcon(hypothesis.confidence)}
 * >
 *   {hypothesis.confidence}
 * </Badge>
 * ```
 *
 * @example A kind chip, coloured from the span-kind scale through `../utils/color`.
 * ```tsx
 * <Badge color={kindColorVar(event.kind)}>{formatKind(event.kind)}</Badge>
 * ```
 *
 * @example A count, formatted by the caller and aligned in a dense column.
 * ```tsx
 * <Badge tone="warning" title="Identical requests in one interaction">
 *   {formatCount(group.occurrences)}
 * </Badge>
 * ```
 *
 * @example A legend dot with no visible text, named in words.
 * ```tsx
 * <Badge
 *   color={tierColorVar(lane.tier)}
 *   icon={<CircleIcon className="dg-icon" />}
 *   aria-label={lane.label}
 * />
 * ```
 */
export function Badge(props: BadgeProps): ReactElement {
  const {
    tone = DEFAULT_TONE,
    variant = DEFAULT_VARIANT,
    color,
    icon,
    children,
    className,
    style: styleProp,
    ref,
    ...rest
  } = props;

  // The caller's token reference, published as the component-scoped custom
  // property the stylesheet consumes with a `var(--dg-*)` fallback. Built by
  // merging over any `style` the caller passed rather than replacing it, so a
  // chip placed by a grid track keeps its placement and still gets its kind
  // colour. `undefined` when no colour was asked for, which is what keeps the
  // rendered element free of a `style` attribute in the common case.
  const colorStyle: CssVariableStyle | undefined =
    color === undefined ? undefined : { ...styleProp, '--dgc-badge-color': color };

  // Two steps rather than one, and not a stylistic choice: `CSSProperties` is an
  // interface, so TypeScript infers no implicit index signature for it and a
  // value of that type is NOT assignable to `CssVariableStyle`
  // (TS2322, "Index signature for type `--${string}` is missing"). Narrowing the
  // custom-property object on its own keeps the merge free of a cast, and the
  // union below is what carries the caller's plain style through untouched.
  //
  // Nothing else may join either object: no width, no padding, no colour
  // literal. Every other value a chip takes comes from the stylesheet.
  const style: CssVariableStyle | CSSProperties | undefined = colorStyle ?? styleProp;

  return (
    <span
      className={clsx('dg-badge', TONE_CLASS[tone], VARIANT_CLASS[variant], className)}
      style={style}
      ref={ref}
      {...rest}
    >
      {isRenderableIcon(icon) ? (
        <span className="dg-badge__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}
