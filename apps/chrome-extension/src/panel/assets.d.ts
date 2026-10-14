/**
 * Ambient type declaration for the one stylesheet the DevTools panel imports.
 *
 * `./main.tsx` imports `@debuggen/panel-renderer/styles.css` for its side
 * effect: the design system's generated `--dg-*` tokens and component classes,
 * published as the renderer's separate `./styles.css` export (AAP 0.6.1). Vite
 * bundles that file into the panel document's stylesheet, but TypeScript 6
 * checks side-effect imports (`noUncheckedSideEffectImports`), and a `.css`
 * file is no module it can resolve, so the import needs a declaration.
 *
 * The declaration names that single specifier rather than `*.css` on purpose:
 * the renderer stylesheet is the panel's only styling act (AAP 0.6.4), so any
 * other stylesheet import stays a compile error instead of type-checking
 * silently. This is also why the workspace does not add `vite/client` to its
 * `types` or relax the compiler option — either would admit every CSS and
 * asset import across the whole program.
 */
declare module '@debuggen/panel-renderer/styles.css';
