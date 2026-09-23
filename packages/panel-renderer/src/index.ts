/**
 * `@debuggen/panel-renderer` — the in-repo design system of the Debug Generator.
 *
 * This file is the package's single `"."` entry and the only JavaScript door
 * into it: `package.json` publishes exactly one JavaScript condition, pointing
 * at `dist/index.js` with `dist/index.d.ts` beside it, and `tsup.config.ts`
 * builds both from this module alone by following its imports. Two surfaces
 * read it, and they are the reason the package exists in the shape it does —
 * the Chrome DevTools panel (`apps/chrome-extension/src/panel`) and the VS Code
 * webview (`apps/vscode-extension/src/webview`), each bundling it with Vite so
 * that one generated panel reads identically in an inspected page and in an
 * editor.
 *
 * ## The stylesheet is a SECOND artefact, not an import from here
 *
 * The visual values this package renders with do not travel through
 * JavaScript. They travel through `dist/styles.css`, published behind the
 * separate `"./styles.css"` condition and assembled by the `onSuccess` hook of
 * `tsup.config.ts` from three inputs in one fixed order:
 * `src/tokens/tokens.css` (generated from `src/tokens/tokens.ts` by
 * `scripts/build-tokens.mjs` in `prebuild`), then `src/styles/base.css`, then
 * `src/styles/components.css`. A consumer imports it once, at its own entry, as
 * `"@debuggen/panel-renderer/styles.css"`.
 *
 * Nothing in this package imports a `.css` file, and this barrel must not
 * become the first thing that does. `"sideEffects": ["**\/*.css"]` in
 * `package.json` exists so that both Vite bundles can tree-shake this module;
 * a stylesheet import here would put a style side effect inside
 * `dist/index.js` and drag the whole sheet through the JavaScript graph of a
 * consumer that imported one primitive, defeating both. The workspace declares
 * no ambient `*.css` module either, so the mistake is a compile error rather
 * than a silent regression.
 *
 * ## What lives behind this entry
 *
 * Every module under `src/**` that is not a colocated test, re-exported below
 * in dependency order:
 *
 * - `tokens/tokens` — the single source of truth for every visual value in the
 *   product (AAP 0.6.1, 0.6.3): the three complete token sets (`dark`, the
 *   default; `light`; `highContrast`), the `TokenKey` union they define, and
 *   `cssVarName`/`cssVar`, which is how a component names a `--dg-*` custom
 *   property instead of inlining a colour or a length.
 * - `tokens/theme` — theme identity rather than token values: the `PanelTheme`
 *   union structurally locked to that token table, the `data-theme` attribute
 *   name and its per-theme value, and the two host mappers that translate a
 *   Chrome DevTools theme name and a VS Code body class into a theme.
 *   Detection belongs to the two consumers, which own those host APIs; only the
 *   translation lives here, so the surfaces cannot disagree about what a host
 *   signal means.
 * - `utils/format`, `utils/color`, `utils/scale` — the deterministic
 *   presentation layer. Locale-independent text for durations, byte sizes,
 *   counts, percentages, compact paths, bounded previews and the closed
 *   telemetry vocabularies; the colour decisions that fold those vocabularies
 *   and duration severity onto token keys, together with the WCAG contrast
 *   arithmetic the token suite measures every theme with; and the SVG geometry
 *   written for the timeline, waterfall, flame and dependency-graph views —
 *   time scales, span and row placement, axis ticks, trace-row flattening and
 *   layered graph layout — computed in one place so two views of one capture
 *   cannot drift apart.
 * - the fourteen UI primitives, from `Badge` to `Tooltip`. AAP 0.6.2 names
 *   them and AAP 0.6.4 makes them mandatory: no raw `<button>`, `<input>`,
 *   `<select>`, `<table>` or heading element is permitted above this layer, so
 *   these — including the sortable, virtualized, keyboard-navigable
 *   `DataTable` and the `EmptyState`/`LoadingState`/`ErrorState` trio every
 *   data-backed view needs — are what a panel is built from.
 * - the layout primitives `PanelShell`, the theme root and scrolling region and
 *   the only module in the package that writes the theme attribute, `Stack`,
 *   the flow container that carries this tier's shared spacing and alignment
 *   vocabulary (`SPACE_STEPS`, `SpaceStep`, `StackDirection`, `StackAlign`,
 *   `StackJustify`), `Section`, the titled and optionally framed container the
 *   schema's `section` node renders to, `Split`, the side-by-side division the
 *   `split` node renders to, and `Toolbar`, the filter/sort/search row a panel
 *   composes instead of hand-rolling one.
 *
 * No name collides across the flat re-export: the exported names of these
 * modules are pairwise distinct, so each is re-exported with `export *` and no
 * symbol is renamed, hidden behind an alias or reachable under two spellings.
 *
 * `@debuggen/shared`, `@debuggen/telemetry` and the vocabularies they own are
 * not re-exported. Consumers depend on them directly, so a shape this package
 * borrows — `SourceLocation`, the aggregate result types the views render —
 * keeps a single import path rather than acquiring a second one through this
 * barrel.
 *
 * Importing this module has no side effect: every statement below is an
 * `export` declaration, there is no default export, and nothing runs at load
 * time — no environment read, no global mutation, no timer, no console write.
 * Relative specifiers are extensionless throughout `src/**` because this
 * workspace resolves with `moduleResolution: "bundler"`, unlike the `.js`-
 * suffixed convention of the Node-targeted packages.
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// tokens — the one source of every visual value, and theme identity
// ---------------------------------------------------------------------------
export * from './tokens/tokens';
export * from './tokens/theme';

// ---------------------------------------------------------------------------
// utils — text, colour and geometry; deterministic, and never a CSS literal
// ---------------------------------------------------------------------------
export * from './utils/format';
export * from './utils/color';
export * from './utils/scale';

// ---------------------------------------------------------------------------
// primitives — the fourteen UI primitives that stand in for raw HTML controls
// ---------------------------------------------------------------------------
export * from './primitives/Badge';
export * from './primitives/Button';
export * from './primitives/Code';
export * from './primitives/DataTable';
export * from './primitives/DurationCell';
export * from './primitives/EmptyState';
export * from './primitives/ErrorState';
export * from './primitives/Heading';
export * from './primitives/Input';
export * from './primitives/Kbd';
export * from './primitives/LoadingState';
export * from './primitives/Select';
export * from './primitives/Text';
export * from './primitives/Tooltip';

// ---------------------------------------------------------------------------
// layout — the theme root, the titled/divided/flow containers and the toolbar
// ---------------------------------------------------------------------------
export * from './layout/PanelShell';
export * from './layout/Section';
export * from './layout/Split';
export * from './layout/Stack';
export * from './layout/Toolbar';
