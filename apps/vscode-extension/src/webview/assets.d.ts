/**
 * Ambient type declarations for the two stylesheets the webview entry imports.
 *
 * `./main.tsx` imports `@debuggen/panel-renderer/styles.css` (the design system's generated
 * `--dg-*` tokens plus its base and component styles, published as the renderer's separate
 * `./styles.css` export, AAP 0.6.1) and then `./styles.css` (this surface's own `dgv-*` layout)
 * for their side effects. Vite bundles both into `dist/webview/main.css`, but TypeScript 6 checks
 * side-effect imports (`noUncheckedSideEffectImports`) and a `.css` file is no module it can
 * resolve, so each import needs a declaration.
 *
 * The declarations stay as narrow as TypeScript allows, exactly as the DevTools panel's
 * `src/panel/assets.d.ts` does: the renderer stylesheet is named by its exact specifier, and the
 * surface's own sheet — whose relative specifier an ambient declaration cannot name (TS2436) — by
 * a pattern that admits only a file called `styles.css`. Any other stylesheet or asset import stays
 * a compile error, which is why this program neither adds `vite/client` to its `types` nor relaxes
 * the compiler option: either would admit every CSS and asset import across the whole webview.
 */
declare module '@debuggen/panel-renderer/styles.css';
declare module '*/styles.css';
