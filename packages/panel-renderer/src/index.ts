/**
 * `@debuggen/panel-renderer` — the in-repo design system and panel renderer.
 *
 * This module is the package's `"."` entry and its only JavaScript door. The
 * manifest publishes exactly one JavaScript condition — `dist/index.js`, with
 * `dist/index.d.ts` beside it — and `tsup.config.ts` builds both from this file
 * alone by following its imports, so a symbol that is not re-exported below
 * does not exist for a consumer. This file therefore *is* the library's public
 * surface, and the lists in it are meant to be read against the node catalogue
 * and the component inventory of the design system (AAP 0.6.1, 0.6.2) by eye.
 *
 * Two surfaces read it, and they are the reason the package has the shape it
 * has: the Chrome DevTools panel, which mounts the whole {@link PanelHost} to
 * draw a generated panel over a capture, and the editor webview, which composes
 * the same tokens, primitives and {@link SummaryHeader} so that one analysis of
 * one session reads identically in an inspected page and in an editor. Both
 * bundle this module with Vite.
 *
 * ## The stylesheet is a second artefact, never an import from here
 *
 * None of the visual values this library renders with travel through
 * JavaScript. They travel through `dist/styles.css`, published behind the
 * separate `"./styles.css"` condition and assembled by `tsup.config.ts` from
 * three inputs in one fixed order: `src/tokens/tokens.css` (generated from
 * `src/tokens/tokens.ts` by `scripts/build-tokens.mjs` before the build), then
 * `src/styles/base.css`, then `src/styles/components.css`. A consumer imports
 * it once, at its own entry, as `'@debuggen/panel-renderer/styles.css'`.
 *
 * Nothing in this package imports a `.css` file, and this barrel must not
 * become the first thing that does. `"sideEffects": ["**\/*.css"]` in the
 * manifest exists so that both consumer bundles can tree-shake this module; a
 * stylesheet import here would put a style side effect inside `dist/index.js`
 * and drag the whole sheet through the JavaScript graph of a surface that
 * imported a single primitive, defeating both. The workspace declares no
 * ambient `*.css` module either, so the mistake is a compile error rather than
 * a silent regression.
 *
 * ## What lives behind this entry
 *
 * Re-exported below in five sections, in this order:
 *
 * 1. **Tokens and theme.** `./tokens/tokens` is the single source of truth for
 *    every visual value in the product (AAP 0.6.1, 0.6.3): the three complete
 *    token sets — `dark`, the default, plus `light` and `highContrast` — the
 *    `TokenKey` union they define, and `cssVarName`/`cssVar`, which is how
 *    geometry computed in TypeScript names a `--dg-*` custom property instead
 *    of inlining a colour or a length. `./tokens/theme` carries theme identity
 *    rather than token values: the `PanelTheme` union locked to that table, the
 *    `data-theme` attribute and its per-theme value, and the two mappers that
 *    translate a browser devtools theme name and an editor body class into a
 *    theme. Host detection belongs to the two consumers, which own those host
 *    APIs; only the translation lives here, so the surfaces cannot disagree
 *    about what a host signal means.
 * 2. **The fourteen UI primitives**, `Button` through `ErrorState`. AAP 0.6.2
 *    names them and AAP 0.6.4 makes them mandatory: no raw `<button>`,
 *    `<input>`, `<select>`, `<table>` or heading element is permitted above
 *    this layer. Each is exported with its own `Props` interface and its option
 *    types, so a consumer composes them in typed code rather than re-deriving a
 *    variant union — and never has to reach for the element they stand in for.
 *    The sortable, virtualized, keyboard-navigable `DataTable` and the
 *    `EmptyState`/`LoadingState`/`ErrorState` trio that every data-backed view
 *    needs for its three states are part of that set.
 * 3. **The six layout primitives.** `PanelShell`, the theme root and the one
 *    scroll region a panel has; `Section`, `Split` and `Stack`, which are what
 *    the specification's three container node types render to and the only way
 *    spacing and alignment are expressed; `Toolbar`, the filter, sort and search
 *    row a view composes instead of hand-rolling one; and `SummaryHeader`,
 *    where the separation between observed facts and inferred likely causes is
 *    rendered (AAP 0.8.4).
 * 4. **The thirteen visualization components** of the node catalogue, from the
 *    correlated trace views through the render, request, query and state
 *    tables to the `SourceLink` chip. Twelve are query-backed and draw whatever
 *    the data query on their node resolves to; the chip carries a source
 *    location directly and is the first hop of the click-to-source chain, which
 *    is why `SourceLinkProps` is embedded in rows and cells by both consumer
 *    surfaces as well as by the views here.
 * 5. **The host surface.** `PanelHost` renders one already-validated
 *    specification; `NodeRenderer` and `renderPanelNodes` dispatch its nodes
 *    recursively; `PANEL_COMPONENT_REGISTRY` is the reviewed allow-list pairing
 *    each catalogued node type with the component that draws it, so nothing a
 *    specification says can put an uncatalogued thing on screen (AAP 0.6.4);
 *    `DataProvider` and `PanelActions` are the two seams a host implements —
 *    evidence in, interactions out. A surface implements the actions' host
 *    form, `PanelHostActions` (`selectEvent(eventId)`, `openSource(location)`);
 *    the views call the view form, `PanelViewActions` (`onSelectEvent`,
 *    `onOpenSource`); `isPanelHostActions`, `toPanelHostActions` and
 *    `toPanelViewActions` are the published compatibility adapters between
 *    the two. The host also owns the panel's one shared selection and provides
 *    it through `PanelSelectionContext`; views read it with `useViewSelection`
 *    (which falls back to a view's own selection outside a host) or
 *    `usePanelSelection`/`useSelectedEventId`, and mark matching items with
 *    `matchesPanelSelection`, so every view of one event agrees on what is
 *    selected. `useQuery` is the only module in the
 *    library that calls a provider at all, addressing every query to the
 *    session the host places in `PanelSessionContext`. No component here opens
 *    a socket, calls `fetch` or knows a message name (AAP 0.4.2).
 *
 * ## What is deliberately not re-exported
 *
 * - `./utils/**` — the text, colour and geometry helpers — is internal. Its
 *   output reaches a consumer through the components that already apply it
 *   (`DurationCell` for a duration, `Code` and `Text` for a path or a bounded
 *   preview, the views for their own axes and lanes); publishing the helpers
 *   would make presentation arithmetic part of the design system's contract and
 *   invite a surface to format a value twice, in two ways.
 * - The token table's generator alias in `./tokens/tokens`. It is the same
 *   object under a second name, read by the stylesheet generator from the
 *   module directly; `DESIGN_TOKENS` is the one name every consumer imports, so
 *   the table has exactly one spelling here.
 * - The compile-time exhaustiveness proofs a few modules export so that their
 *   assertion is observable (in `./tokens/theme` and `./components/RenderTable`).
 *   Each resolves to `never` and asserts something about its own module's
 *   internals, so it has nothing to say to a consumer.
 * - Anything owned by `@debuggen/panel-schema`, `@debuggen/telemetry` or
 *   `@debuggen/shared`. Panel specifications, the node catalogue and data
 *   queries; telemetry events and the aggregate result shapes the views render;
 *   the source-location contract — each has exactly one definition and one
 *   import path (AAP 0.2.3), and a second spelling reached through this barrel
 *   is how two surfaces end up disagreeing about one shape. The three paging
 *   limits below are not an exception to that rule but an application of it:
 *   they are re-exported by `./host/DataProvider` from the schema package
 *   itself, so they keep one identity and are not restated, and they pass
 *   through here because the editor webview depends on this package and not on
 *   the schema package.
 *
 * ## No side effects, no default export
 *
 * Every statement below is an `export` declaration. Importing this module reads
 * no environment, mutates no global, starts no timer, writes no console line
 * and performs no I/O, so a bundler is free to drop whatever a consumer does
 * not use. There is no default export: a design system with one anonymous
 * entry point would hide which of these names a surface actually depends on.
 *
 * Relative specifiers are extensionless throughout `src/**` because this
 * workspace resolves with `moduleResolution: 'bundler'` — the opposite of the
 * `.js`-suffixed convention the Node-targeted sibling packages must use.
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Tokens and theme — the one source of every visual value, and theme identity
// ---------------------------------------------------------------------------

export { cssVar, cssVarName, DESIGN_TOKENS } from './tokens/tokens';
export type { DesignTokens, TokenKey, TokenValues } from './tokens/tokens';

export {
  DEFAULT_PANEL_THEME,
  PANEL_THEME_ATTRIBUTE,
  PANEL_THEME_ATTRIBUTE_VALUES,
  PANEL_THEMES,
  panelThemeAttributeValue,
  panelThemeFromAttributeValue,
  themeFromDevToolsThemeName,
  themeFromVsCodeBodyClass,
} from './tokens/theme';
export type { PanelTheme } from './tokens/theme';

// ---------------------------------------------------------------------------
// UI primitives — the fourteen controls that stand in for raw HTML elements
// ---------------------------------------------------------------------------

export { Button } from './primitives/Button';
export type {
  ButtonAccessibleName,
  ButtonNamedByAriaLabel,
  ButtonNamedByAriaLabelledBy,
  ButtonNamedByChildren,
  ButtonOwnProps,
  ButtonProps,
  ButtonSize,
  ButtonVariant,
} from './primitives/Button';

export { Input } from './primitives/Input';
export type { InputControlSize, InputProps } from './primitives/Input';

export { Select } from './primitives/Select';
export type { SelectControlSize, SelectOption, SelectProps } from './primitives/Select';

export { Badge } from './primitives/Badge';
export type { BadgeProps, BadgeTone, BadgeVariant } from './primitives/Badge';

export { DataTable } from './primitives/DataTable';
export type {
  DataTableCellMeta,
  DataTableColumn,
  DataTableProps,
  DataTableSort,
  DataTableSortDirection,
  DataTableVirtualizeOptions,
} from './primitives/DataTable';

export { Heading } from './primitives/Heading';
export type { HeadingLevel, HeadingProps, HeadingSize, HeadingTone } from './primitives/Heading';

export { Text } from './primitives/Text';
export type { TextElement, TextProps, TextSize, TextTone } from './primitives/Text';

export { Code } from './primitives/Code';
export type { CodeProps, CodeSize } from './primitives/Code';

export { Tooltip } from './primitives/Tooltip';
export type { TooltipPlacement, TooltipProps } from './primitives/Tooltip';

export { DurationCell } from './primitives/DurationCell';
export type {
  DurationCellProps,
  DurationCellSeverity,
  DurationCellSize,
} from './primitives/DurationCell';

export { Kbd } from './primitives/Kbd';
export type { KbdProps } from './primitives/Kbd';

export { EmptyState } from './primitives/EmptyState';
export type { EmptyStateProps } from './primitives/EmptyState';

export { LoadingState } from './primitives/LoadingState';
export type { LoadingStateProps, LoadingStateVariant } from './primitives/LoadingState';

export { ErrorState } from './primitives/ErrorState';
export type { ErrorStateProps } from './primitives/ErrorState';

// ---------------------------------------------------------------------------
// Layout primitives — the theme root, the container nodes, the toolbar and the
// summary head every panel is composed from
// ---------------------------------------------------------------------------

export { PanelShell } from './layout/PanelShell';
export type { PanelShellProps } from './layout/PanelShell';

export { Section } from './layout/Section';
export type { SectionProps, SectionVariant } from './layout/Section';

export { Split } from './layout/Split';
export type { SplitProps } from './layout/Split';

export { SPACE_STEPS, Stack } from './layout/Stack';
export type {
  SpaceStep,
  StackAlign,
  StackDirection,
  StackJustify,
  StackProps,
} from './layout/Stack';

export { Toolbar } from './layout/Toolbar';
export type {
  ToolbarAction,
  ToolbarProps,
  ToolbarSearch,
  ToolbarSelect,
  ToolbarStatus,
} from './layout/Toolbar';

export { SummaryHeader } from './layout/SummaryHeader';
export type { SummaryHeaderProps } from './layout/SummaryHeader';

// ---------------------------------------------------------------------------
// Visualization components — the thirteen catalogued views a generated panel
// composes, plus the source chip every row and cell embeds
// ---------------------------------------------------------------------------

export { Timeline } from './components/Timeline';
export type { TimelineProps } from './components/Timeline';

export { Waterfall } from './components/Waterfall';
export type { WaterfallProps } from './components/Waterfall';

export { EventLog } from './components/EventLog';
export type { EventLogProps } from './components/EventLog';

export { MetricCards } from './components/MetricCards';
export type { MetricCardsProps } from './components/MetricCards';

export { FlameChart } from './components/FlameChart';
export type { FlameChartProps } from './components/FlameChart';

export { SpanTable } from './components/SpanTable';
export type { SpanTableProps } from './components/SpanTable';

export { RenderTable } from './components/RenderTable';
export type { RenderTableProps } from './components/RenderTable';

export { ComponentTree } from './components/ComponentTree';
export type { ComponentTreeProps } from './components/ComponentTree';

export { RequestTable } from './components/RequestTable';
export type { RequestTableProps } from './components/RequestTable';

export { QueryTable } from './components/QueryTable';
export type { QueryTableProps } from './components/QueryTable';

export { StateTransitionViewer } from './components/StateTransitionViewer';
export type { StateTransitionViewerProps } from './components/StateTransitionViewer';

export { DependencyGraph } from './components/DependencyGraph';
export type { DependencyGraphProps } from './components/DependencyGraph';

export { SourceLink } from './components/SourceLink';
export type { SourceLinkProps } from './components/SourceLink';

// ---------------------------------------------------------------------------
// Host surface — the panel entry point, the node dispatcher, the reviewed
// node-type allow-list and the two seams a host implements
// ---------------------------------------------------------------------------

export { PanelHost } from './host/PanelHost';
export type { PanelHostProps } from './host/PanelHost';

export { NodeRenderer, renderPanelNodes } from './host/NodeRenderer';
export type { NodeRendererProps, RenderPanelNodesOptions } from './host/NodeRenderer';

export { componentForNodeType, PANEL_COMPONENT_REGISTRY } from './host/registry';
export type {
  PanelComponentRegistry,
  PanelNodeComponent,
  PanelNodeComponentProps,
} from './host/registry';

export {
  checkDataQueryResponse,
  createDataProvider,
  createPanelDataProvider,
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_DEFAULT_OFFSET,
  DATA_QUERY_MAX_LIMIT,
  DataProviderContext,
  mapPanelDataResult,
  PanelSessionContext,
  useDataProvider,
  usePanelSessionId,
} from './host/DataProvider';
export type {
  AnyDataQueryResponse,
  DataProvider,
  DataQueryOptions,
  DataQueryResolver,
  DataQueryResolverContext,
  DataQueryResponse,
  DataResultFor,
  DataResultMap,
  PanelDataPage,
  PanelDataResolver,
  PanelDataResult,
  PanelDataResultFor,
} from './host/DataProvider';

export {
  isPanelHostActions,
  matchesPanelSelection,
  PanelActionsContext,
  PanelSelectionContext,
  toPanelHostActions,
  toPanelViewActions,
  usePanelActions,
  usePanelSelection,
  useSelectedEventId,
  useViewSelection,
} from './host/PanelActions';
export type {
  PanelActions,
  PanelEventCoordinates,
  PanelEventRef,
  PanelHostActions,
  PanelSelection,
  PanelSelectionState,
  PanelViewActions,
  ViewSelection,
} from './host/PanelActions';

export { useQuery } from './host/useQuery';
export type { UseQueryOptions, UseQueryResult } from './host/useQuery';
