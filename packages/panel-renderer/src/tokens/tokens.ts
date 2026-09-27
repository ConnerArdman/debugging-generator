/**
 * Design tokens — the single source of truth for every visual value in this
 * design system, in three complete value sets: dark, light and high contrast
 * (see "The renderer contract" in docs/ARCHITECTURE.md).
 *
 * No third-party component library or design system is used, so this module
 * *is* the value layer: every colour, space, font, weight, radius, glyph and
 * control size, shadow, focus ring, motion duration, easing function and
 * stacking level that either host surface renders resolves to a `--dg-*`
 * custom property whose value originates here, once. Nothing downstream may
 * define a colour, a metric or a motion constant of its own: a component may
 * write only the literals `0`, `none`, `auto`, `inherit`, `currentColor` and
 * `transparent`, so a value that is missing here has no legal way to be
 * expressed — the fix is to add it here, never to inline it in a component.
 *
 * There is likewise no second namespace and no "internal constant" escape
 * hatch. A value declared beside these — under any other prefix, in any other
 * file — sits outside the drift, completeness, theme and contrast checks that
 * are the only reason this table can be trusted, and it takes whatever consumes
 * it outside them too.
 *
 * ## The generated stylesheet
 *
 * The sibling `src/tokens/tokens.css` is GENERATED from this module by
 * `scripts/build-tokens.mjs` (this package's `prebuild` step) and must never be
 * hand-edited: its bytes are compared against a fresh regeneration by
 * `src/tokens/tokens.test.ts`, and it is deliberately exempt from Prettier and
 * ESLint so that comparison is meaningful. The generator emits three selector
 * blocks — `:root` for `dark`, `[data-theme="light"]` for `light` and
 * `[data-theme="high-contrast"]` for `highContrast` — each declaring every
 * token, in the key order of the dark set below. **That insertion order is a
 * contract**: reordering a key silently rewrites the stylesheet.
 *
 * ## Why this file looks so plain
 *
 * The generator imports this module directly and runs it under the runtime's
 * built-in type stripping, which makes two constraints absolute:
 *
 *   1. **Erasable syntax only** — type aliases, interfaces, `as const`,
 *      `satisfies`, `export type`. No `enum`, no `namespace`, no constructor
 *      parameter properties, no decorators.
 *   2. **No imports at all**, not even `import type`. This module is a leaf:
 *      everything it needs, it declares. In particular it must never import
 *      from `../utils/color`, which imports `TokenKey`, `cssVar` and
 *      `cssVarName` from here — that edge is one-way, and a cycle would break
 *      type stripping as well as the layering.
 *
 * It is also free of side effects: importing it reads nothing, writes nothing
 * and touches no global.
 *
 * ## Themes
 *
 * `dark` is the product default. `light` is a complete second value set, not a
 * set of overrides. `highContrast` is the dark set with exactly three
 * deltas — borders raised to the primary text colour, a 2 px focus ring, and
 * no elevation shadows — and is byte-identical to `dark` everywhere else; the
 * token test asserts precisely that, so no other high-contrast value may vary.
 *
 * The colour values are load-bearing rather than decorative: the WCAG ratios
 * the token test pins (worst dark text pair 5.09:1, worst light text pair
 * 4.82:1, worst status-as-text 4.86:1, worst span-kind fill 3.21:1 with a
 * margin of only 0.21, worst relationship edge 4.82:1 against the 3:1 non-text
 * bar, worst label ink on a span-kind fill 4.67:1 — the light fetch fill —
 * and primary text on the selected-row fill 7.99:1) were computed against these
 * exact values. Re-picking or rounding one is a product-wide accessibility
 * regression.
 *
 * ## Sizes
 *
 * Every visual dimension a stylesheet renders is a token too — the spacing
 * scale and its inverse steps, the radii (the round one included), the two
 * border widths, the glyph, spinner, icon-only control and hidden-box sizes,
 * the one-line block size and the inset that centres a glyph in it, the unit a
 * measured coordinate is given, the proportions a box fills or centres by, the
 * column geometry of every data table, the stroke weights and dash patterns of
 * drawn charts, the extents of every scroll cap, state box and loading
 * silhouette, and the geometry of a split layout. The glyph, line and column sizes are font-relative (`em`, `lh`
 * and `ch`) and every extent is a multiple of a space token. The token test
 * forbids any number other than zero — a length, a percentage, a ratio, a
 * factor, a stroke weight — and any border-width keyword anywhere in the
 * authored stylesheets, so a glyph box, a hairline, a scroll cap or a table
 * track can no more be written inline than a colour can.
 *
 * ## Table columns
 *
 * A data table's columns are sized by ROLE, never by a number a component
 * picks: `src/primitives/DataTable.tsx` maps each semantic column role
 * (ordinal, count, quantity, status, label, name, text, standard) to a grid
 * track built from one `columnMin*` token — the readable minimum of that kind
 * of content, in `ch` of the table's own type — and one `columnShare*` token —
 * the share of spare width it takes. The two truncating roles (name and text)
 * may narrow to `columnYield` of their floor, and only when that makes the
 * table fit: a panel just too narrow for every floor truncates its names and
 * free text and keeps its figures, statuses and controls in view without
 * scrolling, and a panel too narrow even for the yielded floors keeps every
 * floor and scrolls. Both extension surfaces and every visualization table
 * therefore agree on how wide a duration or a path column is, and one edit
 * here re-densifies all of them at once.
 */

/**
 * The dark value set — the default theme, emitted as the stylesheet's `:root`
 * block. This object is also the canonical key list and the canonical key
 * *order* for all three themes and for the generated CSS.
 */
const darkTokens = {
  // --- Surfaces -------------------------------------------------------------
  /** Page background of a panel. */
  surfaceBase: '#0f1115',
  /** Cards, tables and the details drawer. */
  surfaceElevated: '#161a22',
  /** Tooltips and menus; the darkest surface text is measured against. */
  surfaceOverlay: '#1d2230',

  // --- Borders --------------------------------------------------------------
  /** Dividers and default control outlines. */
  borderSubtle: '#262c3a',
  /** Emphasised separation, such as a table header rule. */
  borderStrong: '#3a4356',

  // --- Border widths --------------------------------------------------------
  // The two stroke weights every edge is drawn in. They are the CSS width
  // keywords the browser resolves device-crisply (a hairline stays one device
  // pixel wide at any zoom), stated here so a stylesheet names the ROLE of an
  // edge rather than its weight. Theme-invariant: the high-contrast theme
  // raises border colours, never border widths.
  /** Dividers, table rules, control and card outlines. */
  borderWidthHairline: 'thin',
  /**
   * The emphasis edge: the inline-start marker of an active or selected row,
   * the accent edge of a callout, and the ring of the progress spinner.
   */
  borderWidthMarker: 'medium',

  // --- Text -----------------------------------------------------------------
  /** Body and heading text. */
  textPrimary: '#e6e9f0',
  /** Labels and supporting text. */
  textSecondary: '#a6adbd',
  /** De-emphasised metadata; the lowest-contrast permitted text colour. */
  textMuted: '#8a92a6',

  // --- Accent ---------------------------------------------------------------
  /** Selection, focus ring and links. */
  accent: '#6ea8ff',
  /** Selected-row and active-chip fill behind accent-coloured content. */
  accentMuted: '#2b4470',

  // --- Status ---------------------------------------------------------------
  success: '#3ecf8e',
  warning: '#f5b83d',
  danger: '#ff6b6b',
  info: '#7dd3fc',

  // --- Span kinds -----------------------------------------------------------
  // The categorical scale for timeline lanes, hierarchy blocks and graph
  // nodes. Used as fills carrying text labels, so the scale is held to the
  // 3:1 bar rather than the 4.5:1 text bar.
  kindInteraction: '#c084fc',
  kindRender: '#60a5fa',
  kindFetch: '#34d399',
  kindHttp: '#fbbf24',
  kindFunction: '#f97316',
  kindDb: '#f472b6',
  kindError: '#ef4444',
  // Two families the seven core kinds above leave unrepresented, so the
  // dependency graph's six participant classes can each own a colour and
  // agree with the span views: server-side work behind a request boundary
  // (the route handler) and a request the server makes onwards to another
  // system. Supplementary members of the same scale, under the same 3:1 fill
  // bar; they add colours without changing any of the seven core values.
  /** Server-side work behind a request boundary (a route handler). */
  kindService: '#22d3ee',
  /** A request the server makes onwards to another system. */
  kindExternal: '#a3e635',

  // --- Span-kind label ink --------------------------------------------------
  // The colour of text drawn *on* a span-kind fill — a flame block's label.
  // One ink per fill, chosen per theme by contrast so every pair clears the
  // 4.5:1 text bar: a fill cannot carry text in one fixed colour across the
  // scale, because the light scale spans fills that need light ink and one
  // (fetch) that needs dark ink. Aliases, never colours of their own, so an
  // ink stays in step with the surface or text token it names.
  /** Alias of the base surface: dark ink on every dark-theme fill. */
  kindInteractionInk: 'var(--dg-surface-base)',
  /** Alias of the base surface. */
  kindRenderInk: 'var(--dg-surface-base)',
  /** Alias of the base surface. */
  kindFetchInk: 'var(--dg-surface-base)',
  /** Alias of the base surface. */
  kindHttpInk: 'var(--dg-surface-base)',
  /** Alias of the base surface. */
  kindFunctionInk: 'var(--dg-surface-base)',
  /** Alias of the base surface. */
  kindDbInk: 'var(--dg-surface-base)',
  /** Alias of the base surface. */
  kindErrorInk: 'var(--dg-surface-base)',
  /** Alias of the base surface. */
  kindServiceInk: 'var(--dg-surface-base)',
  /** Alias of the base surface. */
  kindExternalInk: 'var(--dg-surface-base)',

  // --- Duration severity ----------------------------------------------------
  // Real aliases rather than duplicated colour values: each severity step
  // points at the token it is defined as, so every theme stays in sync by
  // construction. The bucket boundaries that choose between them live in
  // `src/utils/color.ts`, not here.
  /** Alias of the muted text colour. */
  durationFast: 'var(--dg-text-muted)',
  /** Alias of the primary text colour. */
  durationNormal: 'var(--dg-text-primary)',
  /** Alias of the warning colour. */
  durationSlow: 'var(--dg-warning)',
  /** Alias of the danger colour. */
  durationCritical: 'var(--dg-danger)',

  // --- Relationship edges ---------------------------------------------------
  // The stroke of a connector drawn between two plotted items — a
  // dependency-graph relationship, a timeline parent-to-child edge. Such a line
  // is an essential non-text graphic, so it is held to the 3:1 non-text bar on
  // every surface, which neither border colour reaches. It is an alias rather
  // than a colour of its own: a connector reads in the same muted tone as the
  // count label printed on it, and it stays in step with that tone in every
  // theme by construction. Because it is not a border, the high-contrast set
  // carries the dark value, as it does for every other non-border colour.
  /** Alias of the muted text colour. */
  graphEdge: 'var(--dg-text-muted)',

  // --- Spacing --------------------------------------------------------------
  // A dense scale: these surfaces show dense, data-heavy views.
  space0: '2px',
  space1: '4px',
  space2: '6px',
  space3: '8px',
  space4: '12px',
  space5: '16px',
  space6: '20px',
  space7: '24px',

  // --- Inverse spacing ------------------------------------------------------
  // A step of the scale pulled the other way: a margin or an offset that moves
  // an edge back toward its start by exactly one space step. Stated as the
  // negation of the step it mirrors, so it tracks that step through any change
  // to the scale; a stylesheet names it instead of multiplying a step by a
  // number of its own.
  /**
   * The smallest step inward: the outline offset that draws the focus ring
   * inside an element's box where a scroll container's edge, or a sticky
   * header above it, would otherwise hide a ring drawn outside.
   */
  spaceInverse0: 'calc(var(--dg-space-0) * -1)',
  /**
   * One `space1` step back toward the start: the bleed of a control that gives
   * its own padding back to the cell it fills, and the signed gap of a tooltip
   * placed before its trigger.
   */
  spaceInverse1: 'calc(var(--dg-space-1) * -1)',

  // --- Typography -----------------------------------------------------------
  /** Interface font stack. */
  fontUi: '-apple-system, "Segoe UI", Inter, sans-serif',
  /**
   * Monospace stack for code, statements, paths and numeric columns. Contexts
   * that use it also declare `font-variant-numeric: tabular-nums`, which is a
   * CSS keyword declaration applied in `src/styles` and in the primitives that
   * render code and durations — deliberately not a token of its own.
   */
  fontMono: '"JetBrains Mono", "SF Mono", Menlo, monospace',
  /**
   * The raised interface weight, as a weight on its own.
   *
   * The type roles below are complete `font` shorthands, and the shorthand
   * RESETS weight — so a rule that wants a role's size and line-height but a
   * heavier face has to restate the weight in a declaration of its own. That
   * declaration needs a token, because a numeral written in a stylesheet is a
   * visual value outside this table and the design system admits none. This is
   * that token, and it is the same weight the `textLg` role carries; the token
   * test pins the two together so they cannot drift apart.
   */
  fontWeightMedium: '500',
  // Type roles are complete `font` shorthands, so a rule can set a role with
  // one declaration: `font: var(--dg-text-sm);`.
  textXs: '400 11px/16px var(--dg-font-ui)',
  textSm: '400 12px/16px var(--dg-font-ui)',
  textMd: '400 13px/18px var(--dg-font-ui)',
  textLg: '500 15px/20px var(--dg-font-ui)',
  heading: '600 16px/22px var(--dg-font-ui)',
  /** Monospace role; weight stated because the shorthand requires it. */
  monoSm: '400 11px/16px var(--dg-font-mono)',
  /** Monospace role; weight stated because the shorthand requires it. */
  monoMd: '400 12px/16px var(--dg-font-mono)',

  // --- Radius ---------------------------------------------------------------
  radiusSm: '2px',
  radiusMd: '4px',
  radiusLg: '6px',
  /**
   * The radius that rounds a square into a circle — a status dot, the
   * progress spinner's ring. Half of each side, so the corners meet exactly at
   * the middle of every edge whatever size the square is given.
   */
  radiusRound: '50%',

  // --- Glyph and control sizes ----------------------------------------------
  // Font-relative on purpose: a glyph, a spinner and an icon-only control scale
  // with the type role of the context they sit in, which is what keeps a small
  // button's glyph small and a heading's glyph large without a size per role.
  // A custom property holds its value as written, so `1em` resolves against
  // the font of the element that CONSUMES the token, never against the root
  // that declares it.
  /** The square an icon glyph occupies. */
  iconSize: '1em',
  /** The inline progress spinner: the square of the glyph it stands in for. */
  spinnerSize: 'var(--dg-icon-size)',
  /**
   * The inline size of an icon-only button: its glyph, the icon-only inline
   * padding on either side (`space1`) and its two `borderWidthHairline`
   * borders, which together add the scale's smallest step (`space0`). This is
   * the box `.dg-button--icon-only` renders, stated once so an element that
   * reserves that control's room tracks it through any token change.
   */
  iconButtonSize: 'calc(var(--dg-icon-size) + var(--dg-space-1) * 2 + var(--dg-space-0))',
  /**
   * The block size of one line of text in the consuming element's own type
   * role — the floor of a row that must stay one line tall even when it is
   * empty, such as a blank line of a diff. Font-relative like the glyph sizes
   * above: `1lh` resolves against the element that consumes the token.
   */
  lineBlockSize: '1lh',
  /**
   * The block margin that centres a glyph square (`iconSize`) in one line box
   * (`lineBlockSize`): half the difference between the two, on either side.
   * A glyph that must hold a line open on its own — the only item left on the
   * first line of a source chip whose runs have wrapped out of view — takes it
   * as a margin rather than a taller box, so its margin box spans the line and
   * centres it where a glyph beside text sits, while its own box, and the
   * baseline a flex container synthesizes from that box, stay the glyph
   * square's. Font-relative through both operands.
   */
  glyphLineInset: 'calc((var(--dg-line-block-size) - var(--dg-icon-size)) / 2)',
  /**
   * The box of content removed from the visual surface but kept in the
   * accessibility tree (the visually hidden utility). It paints nothing —
   * `clip-path` removes it entirely — and exists only so the out-of-flow box
   * can never extend a scrollable area; font-relative like the glyph square,
   * so it stays a small box beside any type role.
   */
  hiddenBoxSize: '1em',

  // --- Measured geometry ----------------------------------------------------
  /**
   * One CSS pixel: the unit a component's MEASURED geometry is given. A
   * virtualizer offset, a canvas height and a tooltip coordinate are numbers
   * the DOM reports in CSS pixels; a component hands them to the stylesheet
   * UNITLESS through a `--dgc-*` property, and the stylesheet multiplies them
   * by this token (`calc(var(--dgc-…, 0) * var(--dg-pixel-unit))`). It encodes
   * no design decision — the number is the value — which is why the token test
   * pins it to exactly `1px`: any other value would misplace every measured
   * element by the same factor.
   */
  pixelUnit: '1px',

  // --- Proportions ----------------------------------------------------------
  // Shares of the containing block, for the boxes that fill, cap or centre
  // against their container rather than taking a size of their own. They are
  // named so that a stylesheet states the relationship — "as wide as its
  // container", "half of it" — and writes no percentage itself.
  /** The whole of the containing block: a box that fills or is capped at it. */
  sizeFull: '100%',
  /** Half of the containing block: an inset that meets itself in the middle. */
  sizeHalf: '50%',

  // --- Table columns: readable minimums -------------------------------------
  // The floor of each semantic column role, in `ch` of the table's own type,
  // sized for the role's widest ordinary content plus the cell's inline
  // padding. A table sums its columns' floors into its own minimum width, so a
  // surface narrower than that sum scrolls horizontally with every column
  // still readable instead of painting one cell over the next.
  /** A short position number: an event sequence number, a plan version. */
  columnMinOrdinal: '8ch',
  /**
   * An integer tally, with room for a compact badge beside it and for its
   * column header — a one-word label such as "Occurrences" with its sort
   * indicator — so a table held at its floor never clips a heading.
   */
  columnMinCount: '12ch',
  /** A formatted measurement with its unit: a duration, a time, a byte size. */
  columnMinQuantity: '14ch',
  /**
   * A short status word or badge, a tier, or one compact action control, with
   * the badge's own inline padding.
   */
  columnMinStatus: '13ch',
  /**
   * A short categorical label: a kind chip, a key, a system name, or a
   * two-word status chip such as "Transitions dropped".
   */
  columnMinLabel: '20ch',
  /** An identifier: a component, operation or file name, a source chip. */
  columnMinName: '24ch',
  /** Long free text that truncates: a statement, a URL, a value preview. */
  columnMinText: '32ch',
  /** A column declared with no role: room for a short label or a figure. */
  columnMinStandard: '10ch',

  // --- Table columns: spare-width shares ------------------------------------
  // How the width left over after every floor is shared out. Figures take a
  // little, labels an equal part, names and free text the most, so a wide
  // panel spends its room where content is longest.
  /** Counts, quantities and statuses. */
  columnShareCompact: '0.6fr',
  /** Labels, unsized columns, and a single track that fills its grid. */
  columnShareDefault: '1fr',
  /** Names. */
  columnShareWide: '2fr',
  /** Free text. */
  columnShareWidest: '3fr',

  // --- Table columns: yield -------------------------------------------------
  /**
   * The fraction of its readable floor a TRUNCATING column role (`name`,
   * `text`) can narrow to when that makes its table fit a panel too narrow for
   * every floor. Names and free text truncate with an ellipsis and stay
   * identifiable, while figures, statuses and action controls do not survive
   * being cut, so such a panel narrows the truncating columns and keeps the
   * compact ones — a row's controls included — in view. A table too narrow
   * even for the yielded floors gains nothing from truncating and keeps every
   * floor. A unitless factor: it scales a `columnMin*` floor and carries no
   * unit.
   */
  columnYield: '0.5',
  /**
   * How abruptly a table too narrow even for its yielded floors takes the
   * yield back: its grid grows this many pixels for every pixel of that
   * shortfall, up to the readable floors, so a fraction of a pixel below the
   * width at which the yielded floors fit, every column is back at its
   * readable floor and the table scrolls exactly as a table with no truncating
   * column does. Large enough that the change of regime spans less than a
   * pixel for any table's yield; a unitless factor, like the split layout's
   * grow scale.
   */
  columnYieldReturnScale: '1000',

  // --- SVG strokes ----------------------------------------------------------
  // The stroke weights and dash patterns of drawn chart geometry — timeline
  // bars and connectors, hierarchy frames, graph nodes and edges. Unitless:
  // an SVG stroke is measured in the user units of the drawing it belongs to,
  // which is why these are not the border widths above. Theme-invariant for
  // the same reason a border width is: a theme recolours a stroke, never
  // reweighs it.
  /** Gridlines, axis ticks, lanes, resting bars, frames and connectors. */
  strokeWidthHairline: '1',
  /** A selected or hovered bar or frame, and a graph participant's outline. */
  strokeWidthEmphasis: '2',
  /**
   * The halo painted beneath a chart label (`paint-order: stroke`) so it stays
   * legible where a connector or gridline runs behind it.
   */
  strokeWidthHalo: '3',
  /** An ambiguous relationship: dashes, so it never reads as a measured one. */
  strokeDashDashed: '4 3',
  /** An orphaned relationship: dots, the weakest line the charts draw. */
  strokeDashDotted: '1 3',

  // --- Component extents ----------------------------------------------------
  // The box sizes of the containers and silhouettes the components draw:
  // scroll caps that keep a long result inside its own section, the floors of
  // state boxes and loading silhouettes, and the legible minimum of a chart.
  // Each is a multiple of the largest space token, so every extent stays on the
  // design scale and moves with it; the multiple is the design decision, and
  // it is stated here, once, rather than in a stylesheet.
  /** The scroll cap of a data table's rows. */
  scrollCapLg: 'calc(var(--dg-space-7) * 18)',
  /** The scroll cap of a chart's plotting area: a timeline, a graph. */
  scrollCapMd: 'calc(var(--dg-space-7) * 16)',
  /** The scroll cap of a log or a hierarchy: an event log, a flame view. */
  scrollCapSm: 'calc(var(--dg-space-7) * 14)',
  /** The scroll cap of a block of code. */
  codeBlockMaxBlockSize: 'calc(var(--dg-space-7) * 8)',
  /** The scroll cap of the failing query an error state quotes. */
  errorQueryMaxBlockSize: 'calc(var(--dg-space-7) * 5)',
  /** The floor of an empty or error state box, so a state never collapses. */
  stateMinBlockSize: 'calc(var(--dg-space-7) * 4)',
  /** The floor of a loading state box. */
  loadingMinBlockSize: 'calc(var(--dg-space-7) * 3)',
  /** The height of a solid loading silhouette: a card group awaiting data. */
  skeletonBlockSize: 'calc(var(--dg-space-7) * 3)',
  /** The height of a chart's loading silhouette: the plotting area awaiting data. */
  skeletonChartBlockSize: 'calc(var(--dg-space-7) * 6)',
  /** The shortest bar of a list silhouette, so a stack of bars reads as a list. */
  skeletonRowShort: '70%',
  /** The middle bar length of a list silhouette. */
  skeletonRowMedium: '85%',
  /** The widest a tooltip bubble grows before its text wraps. */
  tooltipMaxInlineSize: 'calc(var(--dg-space-7) * 10)',
  /** The widest a toolbar's search field grows. */
  searchMaxInlineSize: 'calc(var(--dg-space-7) * 12)',
  /**
   * The legible minimum of a scaled chart canvas (timeline, flame view): below
   * it the canvas stops shrinking and its viewport scrolls instead, so an axis
   * label never renders too small to read.
   */
  chartMinInlineSize: 'calc(var(--dg-space-7) * 32)',
  /** The narrowest a metric tile gets before the tile grid wraps a track. */
  metricCardMinInlineSize: 'calc(var(--dg-space-7) * 6)',
  /**
   * The floor of a waterfall's time track: the design strip its tick labels
   * are fitted to, so a tick set is never drawn on a strip too narrow for it.
   */
  waterfallAxisMinInlineSize: 'calc(var(--dg-space-7) * 7)',
  /** A waterfall row's share of spare width for the operation's label. */
  waterfallLabelShare: '2fr',
  /** A waterfall row's share of spare width for the time track, against the label's. */
  waterfallBarShare: '5fr',

  // --- Split layout ---------------------------------------------------------
  /**
   * The basis unit of a split pane: the width one unit of weight asks for, and
   * so the width at which a division stops fitting on one line and its panes
   * fall into a column.
   */
  splitPaneBasis: 'calc(var(--dg-space-7) * 20)',
  /** The weight of a pane given none of its own: every unweighted pane is equal. */
  splitPaneWeight: '1',
  /**
   * The constant a pane's weight is scaled by to become its grow factor, so
   * the factors on any line sum to at least one and a pane that wrapped onto a
   * line of its own always fills it. Unitless, and never a visible size.
   */
  splitGrowScale: '1000',

  // --- Elevation ------------------------------------------------------------
  shadow0: 'none',
  shadow1: '0 1px 2px rgba(0, 0, 0, 0.4)',
  shadow2: '0 4px 12px rgba(0, 0, 0, 0.5)',

  // --- Focus ----------------------------------------------------------------
  /** Applied through `:focus-visible`, so pointer clicks show no ring. */
  focusRing: '1px solid var(--dg-accent)',

  // --- Motion ---------------------------------------------------------------
  // Motion is a design decision like any other, so it is stated here rather
  // than in a stylesheet: every transition and animation in `src/styles`
  // resolves its duration and easing to one of these three, which is what keeps
  // hover, focus and selection feedback consistent across every component and
  // keeps the values inside the drift, completeness and theme checks the token
  // test applies to the rest of the table. `@media (prefers-reduced-motion:
  // reduce)` in `src/styles/base.css` switches motion off wholesale and is
  // unaffected by these values.
  /** One interactive state transition — hover, focus, selection. */
  motionDuration: '160ms',
  /** Decelerating easing for feedback that settles rather than overshoots. */
  motionEasing: 'ease-out',
  /** One sweep of a loading skeleton's shimmer. */
  shimmerDuration: '1200ms',
  /**
   * The size of a loading skeleton's shimmer gradient against the element it
   * sweeps: twice its width, so one sweep carries the highlight fully across.
   */
  shimmerBackgroundSize: '200% 100%',
  /** One turn of the progress spinner: continuous rather than frantic. */
  spinDuration: '800ms',
  /** The rotation of one spinner turn. */
  spinRotation: '1turn',

  // --- Stacking -------------------------------------------------------------
  zBase: '0',
  zOverlay: '100',
  zTooltip: '200',
} as const;

/**
 * Every token name, derived from the dark set so the union can never drift
 * from the values that back it.
 */
export type TokenKey = keyof typeof darkTokens;

/**
 * One theme's complete flat value map.
 *
 * A `Record` over the finite key union rather than an index signature: under
 * `noUncheckedIndexedAccess` a lookup with a `TokenKey` therefore yields
 * `string` instead of `string | undefined`, and annotating a theme with this
 * type makes a missing key a compile error and a misspelled key an excess
 * property.
 */
export type TokenValues = Readonly<Record<TokenKey, string>>;

/**
 * The light value set — a complete second palette, emitted under
 * `[data-theme="light"]`. Theme-invariant families (border widths, spacing
 * and its inverse steps, font stacks, type roles, radii, glyph and line sizes,
 * measured geometry, proportions, table column geometry, SVG strokes,
 * component extents, split layout, motion, duration aliases and stacking
 * levels) repeat the dark values verbatim, which is what lets the generator
 * emit three self-contained blocks and lets the token test assert those
 * families are identical.
 */
const lightTokens: TokenValues = {
  // --- Surfaces -------------------------------------------------------------
  surfaceBase: '#ffffff',
  surfaceElevated: '#f4f6fa',
  surfaceOverlay: '#e9edf3',

  // --- Borders --------------------------------------------------------------
  borderSubtle: '#d9dee7',
  borderStrong: '#b6bfcc',

  // --- Border widths --------------------------------------------------------
  borderWidthHairline: 'thin',
  borderWidthMarker: 'medium',

  // --- Text -----------------------------------------------------------------
  textPrimary: '#16191f',
  textSecondary: '#4b5563',
  textMuted: '#5f677a',

  // --- Accent ---------------------------------------------------------------
  accent: '#1f5fd6',
  accentMuted: '#dbe7ff',

  // --- Status ---------------------------------------------------------------
  success: '#146c3f',
  warning: '#8a5a00',
  danger: '#c22b2b',
  info: '#0b6aa8',

  // --- Span kinds -----------------------------------------------------------
  // The tightest contrast in the whole system sits in this group: the fetch
  // fill measures 3.21:1 on the light overlay surface, a margin of 0.21 over
  // the 3:1 bar. No value here may be adjusted.
  kindInteraction: '#7c3aed',
  kindRender: '#2563eb',
  kindFetch: '#059669',
  kindHttp: '#b45309',
  kindFunction: '#c2410c',
  kindDb: '#be185d',
  kindError: '#dc2626',
  kindService: '#0e7490',
  kindExternal: '#4d7c0f',

  // --- Span-kind label ink --------------------------------------------------
  // White (the base surface) clears 4.5:1 on every light fill but one: on the
  // fetch fill it measures 3.77:1, so fetch labels take the primary text
  // colour instead (4.67:1). Every other light fill keeps white, which is the
  // higher-contrast ink for it.
  kindInteractionInk: 'var(--dg-surface-base)',
  kindRenderInk: 'var(--dg-surface-base)',
  kindFetchInk: 'var(--dg-text-primary)',
  kindHttpInk: 'var(--dg-surface-base)',
  kindFunctionInk: 'var(--dg-surface-base)',
  kindDbInk: 'var(--dg-surface-base)',
  kindErrorInk: 'var(--dg-surface-base)',
  kindServiceInk: 'var(--dg-surface-base)',
  kindExternalInk: 'var(--dg-surface-base)',

  // --- Duration severity ----------------------------------------------------
  durationFast: 'var(--dg-text-muted)',
  durationNormal: 'var(--dg-text-primary)',
  durationSlow: 'var(--dg-warning)',
  durationCritical: 'var(--dg-danger)',

  // --- Relationship edges ---------------------------------------------------
  graphEdge: 'var(--dg-text-muted)',

  // --- Spacing --------------------------------------------------------------
  space0: '2px',
  space1: '4px',
  space2: '6px',
  space3: '8px',
  space4: '12px',
  space5: '16px',
  space6: '20px',
  space7: '24px',

  // --- Inverse spacing ------------------------------------------------------
  spaceInverse0: 'calc(var(--dg-space-0) * -1)',
  spaceInverse1: 'calc(var(--dg-space-1) * -1)',

  // --- Typography -----------------------------------------------------------
  fontUi: '-apple-system, "Segoe UI", Inter, sans-serif',
  fontMono: '"JetBrains Mono", "SF Mono", Menlo, monospace',
  fontWeightMedium: '500',
  textXs: '400 11px/16px var(--dg-font-ui)',
  textSm: '400 12px/16px var(--dg-font-ui)',
  textMd: '400 13px/18px var(--dg-font-ui)',
  textLg: '500 15px/20px var(--dg-font-ui)',
  heading: '600 16px/22px var(--dg-font-ui)',
  monoSm: '400 11px/16px var(--dg-font-mono)',
  monoMd: '400 12px/16px var(--dg-font-mono)',

  // --- Radius ---------------------------------------------------------------
  radiusSm: '2px',
  radiusMd: '4px',
  radiusLg: '6px',
  radiusRound: '50%',

  // --- Glyph and control sizes ----------------------------------------------
  iconSize: '1em',
  spinnerSize: 'var(--dg-icon-size)',
  iconButtonSize: 'calc(var(--dg-icon-size) + var(--dg-space-1) * 2 + var(--dg-space-0))',
  lineBlockSize: '1lh',
  glyphLineInset: 'calc((var(--dg-line-block-size) - var(--dg-icon-size)) / 2)',
  hiddenBoxSize: '1em',

  // --- Measured geometry ----------------------------------------------------
  pixelUnit: '1px',

  // --- Proportions ----------------------------------------------------------
  sizeFull: '100%',
  sizeHalf: '50%',

  // --- Table columns: readable minimums -------------------------------------
  columnMinOrdinal: '8ch',
  columnMinCount: '12ch',
  columnMinQuantity: '14ch',
  columnMinStatus: '13ch',
  columnMinLabel: '20ch',
  columnMinName: '24ch',
  columnMinText: '32ch',
  columnMinStandard: '10ch',

  // --- Table columns: spare-width shares ------------------------------------
  columnShareCompact: '0.6fr',
  columnShareDefault: '1fr',
  columnShareWide: '2fr',
  columnShareWidest: '3fr',

  // --- Table columns: yield -------------------------------------------------
  columnYield: '0.5',
  columnYieldReturnScale: '1000',

  // --- SVG strokes ----------------------------------------------------------
  strokeWidthHairline: '1',
  strokeWidthEmphasis: '2',
  strokeWidthHalo: '3',
  strokeDashDashed: '4 3',
  strokeDashDotted: '1 3',

  // --- Component extents ----------------------------------------------------
  scrollCapLg: 'calc(var(--dg-space-7) * 18)',
  scrollCapMd: 'calc(var(--dg-space-7) * 16)',
  scrollCapSm: 'calc(var(--dg-space-7) * 14)',
  codeBlockMaxBlockSize: 'calc(var(--dg-space-7) * 8)',
  errorQueryMaxBlockSize: 'calc(var(--dg-space-7) * 5)',
  stateMinBlockSize: 'calc(var(--dg-space-7) * 4)',
  loadingMinBlockSize: 'calc(var(--dg-space-7) * 3)',
  skeletonBlockSize: 'calc(var(--dg-space-7) * 3)',
  skeletonChartBlockSize: 'calc(var(--dg-space-7) * 6)',
  skeletonRowShort: '70%',
  skeletonRowMedium: '85%',
  tooltipMaxInlineSize: 'calc(var(--dg-space-7) * 10)',
  searchMaxInlineSize: 'calc(var(--dg-space-7) * 12)',
  chartMinInlineSize: 'calc(var(--dg-space-7) * 32)',
  metricCardMinInlineSize: 'calc(var(--dg-space-7) * 6)',
  waterfallAxisMinInlineSize: 'calc(var(--dg-space-7) * 7)',
  waterfallLabelShare: '2fr',
  waterfallBarShare: '5fr',

  // --- Split layout ---------------------------------------------------------
  splitPaneBasis: 'calc(var(--dg-space-7) * 20)',
  splitPaneWeight: '1',
  splitGrowScale: '1000',

  // --- Elevation ------------------------------------------------------------
  // Same geometry as dark, tinted for a light background.
  shadow0: 'none',
  shadow1: '0 1px 2px rgba(16, 24, 40, 0.08)',
  shadow2: '0 4px 12px rgba(16, 24, 40, 0.16)',

  // --- Focus ----------------------------------------------------------------
  focusRing: '1px solid var(--dg-accent)',

  // --- Motion ---------------------------------------------------------------
  motionDuration: '160ms',
  motionEasing: 'ease-out',
  shimmerDuration: '1200ms',
  shimmerBackgroundSize: '200% 100%',
  spinDuration: '800ms',
  spinRotation: '1turn',

  // --- Stacking -------------------------------------------------------------
  zBase: '0',
  zOverlay: '100',
  zTooltip: '200',
};

/**
 * The high-contrast value set, emitted under `[data-theme="high-contrast"]`.
 *
 * It is the dark set with exactly three deltas, and the token test asserts
 * every other key is byte-identical to `dark`:
 *
 *   1. both border colours are raised to the primary text colour;
 *   2. the focus ring is 2 px instead of 1 px;
 *   3. elevation shadows are removed, so separation is carried by borders.
 *
 * The colours are therefore dark's colours, which is why its contrast ratios
 * equal dark's and need no separate verification.
 */
const highContrastTokens: TokenValues = {
  // --- Surfaces (as dark) ---------------------------------------------------
  surfaceBase: '#0f1115',
  surfaceElevated: '#161a22',
  surfaceOverlay: '#1d2230',

  // --- Borders (delta 1: raised to the primary text colour) -----------------
  borderSubtle: '#e6e9f0',
  borderStrong: '#e6e9f0',

  // --- Border widths (as dark) ----------------------------------------------
  // Delta 1 raises border COLOURS only; every edge keeps its dark weight.
  borderWidthHairline: 'thin',
  borderWidthMarker: 'medium',

  // --- Text (as dark) -------------------------------------------------------
  textPrimary: '#e6e9f0',
  textSecondary: '#a6adbd',
  textMuted: '#8a92a6',

  // --- Accent (as dark) -----------------------------------------------------
  accent: '#6ea8ff',
  accentMuted: '#2b4470',

  // --- Status (as dark) -----------------------------------------------------
  success: '#3ecf8e',
  warning: '#f5b83d',
  danger: '#ff6b6b',
  info: '#7dd3fc',

  // --- Span kinds (as dark) -------------------------------------------------
  kindInteraction: '#c084fc',
  kindRender: '#60a5fa',
  kindFetch: '#34d399',
  kindHttp: '#fbbf24',
  kindFunction: '#f97316',
  kindDb: '#f472b6',
  kindError: '#ef4444',
  kindService: '#22d3ee',
  kindExternal: '#a3e635',

  // --- Span-kind label ink (as dark) ----------------------------------------
  kindInteractionInk: 'var(--dg-surface-base)',
  kindRenderInk: 'var(--dg-surface-base)',
  kindFetchInk: 'var(--dg-surface-base)',
  kindHttpInk: 'var(--dg-surface-base)',
  kindFunctionInk: 'var(--dg-surface-base)',
  kindDbInk: 'var(--dg-surface-base)',
  kindErrorInk: 'var(--dg-surface-base)',
  kindServiceInk: 'var(--dg-surface-base)',
  kindExternalInk: 'var(--dg-surface-base)',

  // --- Duration severity (as dark) ------------------------------------------
  durationFast: 'var(--dg-text-muted)',
  durationNormal: 'var(--dg-text-primary)',
  durationSlow: 'var(--dg-warning)',
  durationCritical: 'var(--dg-danger)',

  // --- Relationship edges (as dark) -----------------------------------------
  // Not a border, so not raised: the edge keeps the dark set's alias, and with
  // it the dark set's contrast on every surface.
  graphEdge: 'var(--dg-text-muted)',

  // --- Spacing (as dark) ----------------------------------------------------
  space0: '2px',
  space1: '4px',
  space2: '6px',
  space3: '8px',
  space4: '12px',
  space5: '16px',
  space6: '20px',
  space7: '24px',

  // --- Inverse spacing (as dark) --------------------------------------------
  spaceInverse0: 'calc(var(--dg-space-0) * -1)',
  spaceInverse1: 'calc(var(--dg-space-1) * -1)',

  // --- Typography (as dark) -------------------------------------------------
  fontUi: '-apple-system, "Segoe UI", Inter, sans-serif',
  fontMono: '"JetBrains Mono", "SF Mono", Menlo, monospace',
  fontWeightMedium: '500',
  textXs: '400 11px/16px var(--dg-font-ui)',
  textSm: '400 12px/16px var(--dg-font-ui)',
  textMd: '400 13px/18px var(--dg-font-ui)',
  textLg: '500 15px/20px var(--dg-font-ui)',
  heading: '600 16px/22px var(--dg-font-ui)',
  monoSm: '400 11px/16px var(--dg-font-mono)',
  monoMd: '400 12px/16px var(--dg-font-mono)',

  // --- Radius (as dark) -----------------------------------------------------
  radiusSm: '2px',
  radiusMd: '4px',
  radiusLg: '6px',
  radiusRound: '50%',

  // --- Glyph and control sizes (as dark) ------------------------------------
  iconSize: '1em',
  spinnerSize: 'var(--dg-icon-size)',
  iconButtonSize: 'calc(var(--dg-icon-size) + var(--dg-space-1) * 2 + var(--dg-space-0))',
  lineBlockSize: '1lh',
  glyphLineInset: 'calc((var(--dg-line-block-size) - var(--dg-icon-size)) / 2)',
  hiddenBoxSize: '1em',

  // --- Measured geometry (as dark) ------------------------------------------
  pixelUnit: '1px',

  // --- Proportions (as dark) ------------------------------------------------
  sizeFull: '100%',
  sizeHalf: '50%',

  // --- Table columns: readable minimums (as dark) ---------------------------
  columnMinOrdinal: '8ch',
  columnMinCount: '12ch',
  columnMinQuantity: '14ch',
  columnMinStatus: '13ch',
  columnMinLabel: '20ch',
  columnMinName: '24ch',
  columnMinText: '32ch',
  columnMinStandard: '10ch',

  // --- Table columns: spare-width shares (as dark) --------------------------
  columnShareCompact: '0.6fr',
  columnShareDefault: '1fr',
  columnShareWide: '2fr',
  columnShareWidest: '3fr',

  // --- Table columns: yield (as dark) ---------------------------------------
  columnYield: '0.5',
  columnYieldReturnScale: '1000',

  // --- SVG strokes (as dark) ------------------------------------------------
  strokeWidthHairline: '1',
  strokeWidthEmphasis: '2',
  strokeWidthHalo: '3',
  strokeDashDashed: '4 3',
  strokeDashDotted: '1 3',

  // --- Component extents (as dark) ------------------------------------------
  scrollCapLg: 'calc(var(--dg-space-7) * 18)',
  scrollCapMd: 'calc(var(--dg-space-7) * 16)',
  scrollCapSm: 'calc(var(--dg-space-7) * 14)',
  codeBlockMaxBlockSize: 'calc(var(--dg-space-7) * 8)',
  errorQueryMaxBlockSize: 'calc(var(--dg-space-7) * 5)',
  stateMinBlockSize: 'calc(var(--dg-space-7) * 4)',
  loadingMinBlockSize: 'calc(var(--dg-space-7) * 3)',
  skeletonBlockSize: 'calc(var(--dg-space-7) * 3)',
  skeletonChartBlockSize: 'calc(var(--dg-space-7) * 6)',
  skeletonRowShort: '70%',
  skeletonRowMedium: '85%',
  tooltipMaxInlineSize: 'calc(var(--dg-space-7) * 10)',
  searchMaxInlineSize: 'calc(var(--dg-space-7) * 12)',
  chartMinInlineSize: 'calc(var(--dg-space-7) * 32)',
  metricCardMinInlineSize: 'calc(var(--dg-space-7) * 6)',
  waterfallAxisMinInlineSize: 'calc(var(--dg-space-7) * 7)',
  waterfallLabelShare: '2fr',
  waterfallBarShare: '5fr',

  // --- Split layout (as dark) -----------------------------------------------
  splitPaneBasis: 'calc(var(--dg-space-7) * 20)',
  splitPaneWeight: '1',
  splitGrowScale: '1000',

  // --- Elevation (delta 3: no elevation shadows) ----------------------------
  shadow0: 'none',
  shadow1: 'none',
  shadow2: 'none',

  // --- Focus (delta 2: a 2 px ring) -----------------------------------------
  focusRing: '2px solid var(--dg-accent)',

  // --- Motion (as dark) -----------------------------------------------------
  // Reducing motion is a user preference rather than a theme, so the
  // high-contrast set carries the default durations and the
  // `prefers-reduced-motion` block in `src/styles/base.css` remains the one
  // place motion is switched off.
  motionDuration: '160ms',
  motionEasing: 'ease-out',
  shimmerDuration: '1200ms',
  shimmerBackgroundSize: '200% 100%',
  spinDuration: '800ms',
  spinRotation: '1turn',

  // --- Stacking (as dark) ---------------------------------------------------
  zBase: '0',
  zOverlay: '100',
  zTooltip: '200',
};

/**
 * The three complete value sets of the design system.
 *
 * `src/tokens/theme.ts` derives its theme union as `keyof DesignTokens`, so
 * these three keys are theme identity for the whole package: adding a fourth
 * becomes a compile error there until its attribute mapping is supplied, and
 * the stylesheet generator emits one selector block per key.
 */
export interface DesignTokens {
  /** Default theme; the stylesheet's `:root` block. */
  readonly dark: TokenValues;
  /** Emitted under `[data-theme="light"]`. */
  readonly light: TokenValues;
  /** Emitted under `[data-theme="high-contrast"]`. */
  readonly highContrast: TokenValues;
}

/**
 * The design system's token table: the value every `--dg-*` custom property
 * is generated from, in every theme.
 *
 * Key order within a theme is the generated stylesheet's declaration order and
 * is therefore part of the committed artifact.
 */
export const DESIGN_TOKENS: DesignTokens = {
  dark: darkTokens,
  light: lightTokens,
  highContrast: highContrastTokens,
};

/**
 * The same table under the name the stylesheet generator looks for.
 *
 * `scripts/build-tokens.mjs` loads this module and reads its `tokens` export;
 * `DESIGN_TOKENS` is the canonical name every other consumer imports. This is
 * an alias to the identical object, not a second copy — there is exactly one
 * token table.
 */
export const tokens: DesignTokens = DESIGN_TOKENS;

/**
 * The custom property name a token is emitted as, for example
 * `surfaceBase` → `--dg-surface-base` and `space0` → `--dg-space-0`.
 *
 * The conversion inserts a boundary before each uppercase letter *and* before
 * each digit that follows a letter, then lowercases the result. The digit
 * boundary is the case a plain camel-to-kebab rule gets wrong: it would yield
 * `--dg-space0` and `--dg-shadow1`, which match nothing in the stylesheet.
 *
 * This is the same mapping the stylesheet generator applies, and the token
 * test asserts the two agree for every key.
 */
export function cssVarName(key: TokenKey): string {
  const kebab = key.replace(/([A-Z])/g, '-$1').replace(/([A-Za-z])(\d)/g, '$1-$2');
  return `--dg-${kebab.toLowerCase()}`;
}

/**
 * A token as a CSS value reference, for example
 * `cssVar('surfaceBase')` → `var(--dg-surface-base)`.
 *
 * This is how inline geometry computed in TypeScript — a scale, a lane offset,
 * a severity colour — reaches the stylesheet's values without any component
 * restating one.
 */
export function cssVar(key: TokenKey): string {
  return `var(${cssVarName(key)})`;
}
