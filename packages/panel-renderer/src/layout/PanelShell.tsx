/**
 * The outermost layout primitive of the in-repo design system
 * `@debuggen/panel-renderer`: the theme root, and the panel's scrolling
 * region.
 *
 * Three properties define this module, and all three are deliberate.
 *
 * ## 1. It is the theme root
 *
 * The design system ships three complete token value sets — the default dark
 * set, which the generated stylesheet emits under `:root`, plus a light set and
 * a set for elevated contrast, each behind a theme attribute selector (AAP
 * 0.6.3). Every colour, spacing, type-role, radius, elevation and focus value
 * in the package is a `--dg-*` custom property resolved from that cascade, so
 * the attribute on this element is what decides whether a surface renders in
 * the requested theme or silently in the default one. This is the only module in the package that
 * writes it, and it writes it through `../tokens/theme` rather than as a
 * literal: the attribute *name* comes from `PANEL_THEME_ATTRIBUTE` and the
 * attribute *value* from `panelThemeAttributeValue`, whose mapping the token
 * suite checks against the selectors the generated stylesheet actually
 * declares. Writing either by hand is the one mistake that produces a fully
 * rendered, entirely unstyled panel — the theme key and its DOM value are not
 * the same string for every theme.
 *
 * ## 2. It applies a theme; it never detects one
 *
 * The theme arrives as a prop. Nothing here reads a host global — no
 * browser-extension API, no editor webview bridge, no media-query preference
 * and no inspection of the rendered page — because the two host surfaces learn
 * their theme through entirely different host signals and own those APIs
 * themselves (AAP 0.6.3): each host resolves its signal with the mapping
 * helpers `../tokens/theme` exports and passes the result down. Keeping
 * detection out of the library is what lets the same component render in a
 * browser tool panel, in an editor webview and in a test with no host stubs,
 * and it keeps a single source of truth — the attribute on this element —
 * rather than a second, drifting copy in a React context.
 *
 * ## 3. It owns the panel's scrolling region
 *
 * A generated panel is arbitrarily tall while the surfaces embedding it are
 * short — a docked browser tool panel has very little vertical room. The shell
 * is therefore the one place panel content scrolls, and nested components are
 * built to grow instead of scrolling inside a fixed box. Two exceptions are
 * sanctioned by the stylesheet rather than by any component: the shared
 * virtualization triplet (`dg-virtual-viewport` / `dg-virtual-canvas` /
 * `dg-virtual-row`) that the table and log views drive inside a bounded height,
 * and the bounded viewports the SVG views declare for their own horizontal
 * panning. Anything else that reaches for `overflow` is working around a layout
 * it should be composing with `Stack`, `Split` and `Section` instead.
 *
 * ## Class-name contract implemented by `../styles/components.css`
 *
 * No value — no length, colour, font, shadow or z-index — is written in this
 * file, and there is no inline style and no `style` prop: appearance is selected
 * by class name only (AAP 0.6.4), so a token change reaches both host surfaces
 * without touching a component.
 *
 * - `dg-panel-shell` — the block, and the element that carries the theme
 *   attribute. The stylesheet gives it the base surface and the primary text
 *   tone, makes it fill the frame that embeds it with relational values only,
 *   establishes the panel's stacking base, and binds the themed scroll
 *   behaviour (the same four declarations as the global `dg-scroll` helper) so
 *   the block and its viewport together form one scrolling region.
 * - `dg-panel-shell__viewport` — the content flow region inside the block, and
 *   the region's focus stop. The focus indicator comes from the global
 *   `:focus-visible` rule in `../styles/base.css`, which also owns the reset,
 *   the document-level surface and font bindings, the reduced-motion block and
 *   the `dg-visually-hidden` utility this module reuses through `Heading`;
 *   none of that is restated here.
 *
 * The block name is `dg-panel-shell`, not `dg-panel` — the latter belongs to the
 * panel host that renders this shell, and the two must not collide.
 *
 * ## Position in the package
 *
 * A tier-one layout primitive. It imports React, `clsx`, the theme identities
 * and one primitive, and nothing else: no sibling layout primitive, no
 * visualization component, no host module, no workspace package, no transport.
 * In particular it never imports the panel host, even though the host renders
 * it — the dependency runs host to layout only, so the editor surface can reuse
 * the shell for its own views without a data provider, and the module graph
 * stays acyclic. It holds no state, resolves no data, manages no focus and
 * scrolls nothing programmatically; a surface that needs such a policy owns it
 * above this component.
 *
 * @example The common case: a panel in the default theme, named by its own
 * visible heading further down the tree.
 * ```tsx
 * <PanelShell>
 *   <SummaryHeader … />
 *   <Stack>{nodes}</Stack>
 * </PanelShell>
 * ```
 *
 * @example A host that has resolved its theme, and a scroll region that needs an
 * accessible name of its own.
 * ```tsx
 * <PanelShell theme={themeFromDevToolsThemeName(hostThemeName)} label="Generated view">
 *   {children}
 * </PanelShell>
 * ```
 *
 * @module
 */

import clsx from 'clsx';
import { useId } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { Heading } from '../primitives/Heading';
import {
  DEFAULT_PANEL_THEME,
  PANEL_THEME_ATTRIBUTE,
  panelThemeAttributeValue,
} from '../tokens/theme';
import type { PanelTheme } from '../tokens/theme';

/**
 * Props of {@link PanelShell}.
 *
 * Deliberately narrow. There is no `style` prop, no `ref`, no data or query
 * prop, no interaction callback and no `onThemeChange`: the component is a pure
 * applier of a theme it is handed, and every other concern — data, actions,
 * focus, the visible title — belongs to a component above or below it.
 */
export interface PanelShellProps {
  /**
   * The token value set to render. Omitted, it is {@link DEFAULT_PANEL_THEME},
   * which is the product default and also the set the generated stylesheet
   * serves from `:root`.
   *
   * Typed with the shared {@link PanelTheme} union rather than a local string
   * union: that union is derived from the token table itself, so a theme added
   * to the tokens cannot leave this prop behind, and a value this component
   * could not resolve cannot be passed in the first place.
   */
  theme?: PanelTheme | undefined;

  /**
   * The panel content. Rendered verbatim into the viewport, in order, with no
   * wrapper of its own per child — spacing between children is the business of
   * the layout primitives the content composes.
   */
  children?: ReactNode | undefined;

  /**
   * An accessible name for the scroll region.
   *
   * Supplying it makes the viewport a named `region` landmark labelled by a
   * heading that is present in the document outline and in the accessibility
   * tree but not on the visual surface. Omitting it — the usual case — leaves
   * the viewport a plain container, which is the correct outcome rather than a
   * gap: an unnamed `region` is an ARIA anti-pattern, and a default name
   * invented inside a library would be wording the product never chose. A
   * panel's *visible* title is rendered by the summary header inside the
   * content, so the two never compete for the same accessible name.
   */
  label?: string | undefined;

  /**
   * Additional class names for the block, appended after the system's own so a
   * caller can position the shell inside its host frame without displacing the
   * contract above.
   */
  className?: string | undefined;

  /**
   * An `id` for the block, for a host that needs to reference the shell — from
   * a skip link, for instance.
   */
  id?: string | undefined;
}

/**
 * The theme attribute as a spreadable single-property object.
 *
 * `PANEL_THEME_ATTRIBUTE` is a constant, and a constant cannot be written as a
 * JSX attribute name, so the attribute is built as an object and spread onto the
 * element. The key type is `typeof PANEL_THEME_ATTRIBUTE` — the string literal
 * the theme module declares — so this stays a precisely typed one-property
 * record rather than an open `Record<string, string>` that would accept any
 * attribute at all, and no cast or `any` is involved anywhere.
 */
type PanelThemeAttribute = Readonly<Record<typeof PANEL_THEME_ATTRIBUTE, string>>;

/**
 * Builds the theme attribute for a theme.
 *
 * The attribute is written for every theme, the default included: it costs one
 * attribute, it keeps the component branch-free, and it makes the applied theme
 * observable in the DOM — and therefore assertable — instead of inferable only
 * from an attribute's absence. That is safe because the default theme's value
 * selects nothing: its token set is already the stylesheet's `:root` block.
 */
function panelThemeAttribute(theme: PanelTheme): PanelThemeAttribute {
  return { [PANEL_THEME_ATTRIBUTE]: panelThemeAttributeValue(theme) };
}

/**
 * The theme root and scroll container every panel surface mounts as its
 * outermost element.
 *
 * Renders exactly two nested elements — the themed block and its viewport —
 * plus, only when {@link PanelShellProps.label} is supplied, a visually hidden
 * heading that names the viewport. The heading sits inside the block and
 * immediately before the viewport: the utility that hides it takes it out of
 * flow, so it can neither add a row to the block's layout nor extend the
 * scrollable area, and `aria-labelledby` resolves to it from anywhere in the
 * document.
 *
 * The viewport carries `tabIndex={0}` unconditionally. A region that scrolls but
 * cannot receive focus is unreachable by keyboard: everything below the fold
 * becomes inaccessible to anyone not using a pointer, because arrow keys scroll
 * the nearest scrollable ancestor of the focused element and there is no way to
 * put focus inside it when the content itself holds no control. The scrollable
 * block form of the `Code` primitive is focusable for exactly the same reason.
 * The focus ring is the global `:focus-visible` indicator, so a pointer user
 * never sees it.
 *
 * @param props - See {@link PanelShellProps}.
 * @returns The themed panel shell wrapping its content in the scroll viewport.
 */
export function PanelShell(props: PanelShellProps): ReactElement {
  const { theme = DEFAULT_PANEL_THEME, children, label, className, id } = props;

  // Called unconditionally, as a hook must be, and used only when a label was
  // supplied. A blank or whitespace-only label is treated as no label: it would
  // produce a named region whose name announces as nothing, which is worse for
  // a screen-reader user than the unnamed container.
  const generatedId = useId();
  const named = label !== undefined && label.trim() !== '';
  const headingId = named ? generatedId : undefined;

  return (
    <div className={clsx('dg-panel-shell', className)} {...panelThemeAttribute(theme)} id={id}>
      {named ? (
        <Heading level={2} visuallyHidden id={headingId}>
          {label}
        </Heading>
      ) : null}
      <div
        className="dg-panel-shell__viewport"
        tabIndex={0}
        role={named ? 'region' : undefined}
        aria-labelledby={headingId}
      >
        {children}
      </div>
    </div>
  );
}
