/**
 * `host/PanelHost` — the entry point of the renderer: one validated panel
 * specification in, one live panel out.
 *
 * Two surfaces mount this component and nothing else of this tier: the Chrome
 * DevTools panel and the editor webview. Everything a generated panel is
 * allowed to be, it is because of what happens here.
 *
 * ## What this component does
 *
 * Four things, in this order, and no fifth:
 *
 * 1. Mounts the theme root (`../layout/PanelShell`), which is the one module in
 *    the package that writes the theme attribute and the one scroll region a
 *    panel has.
 * 2. Provides the two ambient contracts — the data provider and the action
 *    contract — around the whole subtree, so that every view beneath it reaches
 *    its evidence and reports its interactions without either being threaded
 *    through each intervening layer (AAP 0.6.2).
 * 3. Renders the head (`../layout/SummaryHeader`), which is where the
 *    observed/inferred separation lives.
 * 4. Renders the layout, node by node, through `./NodeRenderer`.
 *
 * A specification that arrived as the deterministic fallback is announced
 * above all of it, by the banner below.
 *
 * ## What this component does NOT do, on purpose
 *
 * **It does not validate.** No parse, no normalisation, no repair, no
 * defaulting: a specification reaches this component having already been parsed
 * against the schema and, for a generated panel, checked against the capture it
 * claims to describe, by the coordination service that owns both steps. A
 * second, partial check here would be a second opinion about what a valid
 * document is — and the weaker one, because this component cannot see the
 * capture.
 *
 * **It does not mutate.** The specification is read, never sorted, filtered,
 * cloned-and-edited or written into. It is a document that is generated once
 * and then travels: the same object is held by the store, carried by the
 * transport and rendered by two surfaces at once, so a convenience sort here
 * would change what a developer sees in the other one.
 *
 * **It does not fetch.** No socket, no request, no host API. Data arrives
 * through the injected provider and interactions leave through the injected
 * actions, which is what lets one panel render identically in an inspected page
 * and in an editor, and what keeps this tier testable without a transport
 * (AAP 0.1.2, 0.4.2).
 *
 * **It does not present a failure as an answer.** A fallback panel carries
 * `meta.fallback`, and this component draws it under a visible banner that says
 * so, above the summary, in words rather than as a colour — while still
 * rendering every view beneath it, because a deterministic summary of a real
 * capture is worth reading (AAP 0.5.5).
 *
 * ## Class names
 *
 * `dg-panel` is the block, with `dg-panel__banner`/`--fallback` for the notice,
 * `dg-panel__summary` composed onto the head and `dg-panel__body` around the
 * layout. The rules behind those names live in `../styles/components.css`
 * against `--dg-*` tokens; this file names classes and never carries a visual
 * value of its own (AAP 0.6.4).
 *
 * Relative specifiers are extensionless: this workspace resolves with
 * `moduleResolution: "bundler"`, unlike the `.js`-suffixed convention of the
 * Node-targeted packages.
 *
 * @module
 */

import type { PanelSpec } from '@debuggen/panel-schema';
import { LayoutTemplate, TriangleAlert } from 'lucide-react';
import type { ReactElement } from 'react';

import { PanelShell } from '../layout/PanelShell';
import { SummaryHeader } from '../layout/SummaryHeader';
import { EmptyState } from '../primitives/EmptyState';
import { Text } from '../primitives/Text';
import type { PanelTheme } from '../tokens/theme';
import { DataProviderContext } from './DataProvider';
import type { DataProvider } from './DataProvider';
import { renderPanelNodes } from './NodeRenderer';
import { PanelActionsContext } from './PanelActions';
import type { PanelActions } from './PanelActions';

/*
 * ---------------------------------------------------------------------------
 * Class names and wording
 * ---------------------------------------------------------------------------
 */

/** The panel block: the flow column inside the shell's scroll viewport. */
const PANEL_CLASS = 'dg-panel';

/**
 * Composed onto the head's own block class, which is why it is passed as
 * `className` rather than wrapped around it: one element fewer between the
 * panel column and the head, and the head keeps its `header` semantics.
 */
const SUMMARY_CLASS = 'dg-panel__summary';

/** The column the layout's nodes, or the empty state, sit in. */
const BODY_CLASS = 'dg-panel__body';

/**
 * The fallback notice. Both classes: the element class carries the shared
 * banner box, the variant carries the warning edge that makes the notice
 * impossible to mistake for the panel's ordinary surface.
 */
const FALLBACK_BANNER_CLASS = 'dg-panel__banner dg-panel__banner--fallback';

/**
 * The global icon utility of `../styles/base.css`: a `1em` square in
 * `currentColor`, so a glyph scales with the type role around it instead of
 * carrying a size of its own (AAP 0.6.4 permits no hardcoded dimension).
 */
const ICON_CLASS = 'dg-icon';

/**
 * The developer-facing wording of AAP 0.5.5, verbatim.
 *
 * It states two things a shorter notice would drop, and both are the point: the
 * generated panel *failed validation* (so the views below are not an answer to
 * the question that was asked), and what is on screen was *built from captured
 * data* (so it is not invented either). Product copy, not analysis — it makes
 * no claim about the capture, which is what keeps it out of the summary's fact
 * register.
 */
const FALLBACK_BANNER_MESSAGE =
  'Generated panel failed validation; showing a fallback view built from captured data.';

/**
 * The wording for a validated specification whose layout is legitimately empty.
 *
 * Deliberately not an error and deliberately not the fallback notice: a panel
 * may carry a summary and no views — the schema allows it, and for a capture
 * that yielded little it is the honest document — so this states the fact
 * plainly and leaves the reader with the summary that *is* there. Generic
 * product vocabulary only; nothing read out of an inspected project ever
 * reaches a string in this package (AAP 0.5.4).
 */
const EMPTY_LAYOUT_MESSAGE = 'This panel specifies no views, so the summary above is all of it.';

/*
 * ---------------------------------------------------------------------------
 * The fallback notice
 * ---------------------------------------------------------------------------
 */

/**
 * Renders the fallback notice.
 *
 * A plain function rather than a component, matching `./NodeRenderer`'s own
 * failure helper: it takes no input, holds no state and exists only to keep the
 * host's return readable, so an extra element in the tree would buy nothing.
 *
 * `role="status"` with `aria-live="polite"`: the notice is advisory rather than
 * interrupting — the panel beneath it is worth reading — and a regenerated
 * panel that arrives as a fallback is exactly the change a reader needs told
 * without losing their place. The same pairing `../primitives/LoadingState`
 * uses, and deliberately not the assertive `role="alert"` of
 * `../primitives/ErrorState`: this is not a failed render, it is a panel of a
 * different provenance.
 *
 * The glyph is hidden from assistive technology and the whole meaning is in the
 * sentence beside it, because colour and iconography are never the sole
 * carriers of a state in this design system (AAP 0.6.4).
 *
 * @returns The notice, as one banner element.
 */
function renderFallbackBanner(): ReactElement {
  return (
    <div className={FALLBACK_BANNER_CLASS} role="status" aria-live="polite">
      <TriangleAlert className={ICON_CLASS} aria-hidden="true" />
      <Text as="p" size="sm">
        {FALLBACK_BANNER_MESSAGE}
      </Text>
    </div>
  );
}

/*
 * ---------------------------------------------------------------------------
 * The host
 * ---------------------------------------------------------------------------
 */

/**
 * The inputs of one rendered panel.
 *
 * Three required members and three conveniences. The document, the data
 * contract and the action contract are the whole of what a panel needs: the
 * provider and the actions are *injected* rather than constructed here, which
 * is the boundary that keeps this tier free of any transport (AAP 0.1.2).
 *
 * Every optional member spells `| undefined` explicitly, because
 * `exactOptionalPropertyTypes` is in force repository-wide and a host
 * forwarding a value it may not have — `theme={resolvedTheme}` from a host
 * signal that has not arrived yet — has to stay legal.
 *
 * There is deliberately no `spec`-adjacent escape hatch: no `validate` flag, no
 * `onError`, no node override map, no style or token prop. A panel that needs
 * a view this package does not have needs a node type, and a value that is not
 * in the token set is not a value this design system renders.
 */
export interface PanelHostProps {
  /**
   * The validated, normalized panel to draw.
   *
   * Read only — see this module's header on what this component does not do
   * with it. `spec.meta?.fallback === true` is the one field it branches on.
   */
  spec: PanelSpec;

  /**
   * How every view beneath this panel resolves the `DataQuery` its node
   * carries.
   *
   * Provided as context, so the reference must be **stable** across renders:
   * it is part of the query effect's dependencies in `./useQuery`, and a
   * provider rebuilt per render would refetch every node forever. Create one
   * per session and keep it.
   */
  dataProvider: DataProvider;

  /**
   * What this panel's interactions do — selecting an event, opening a place in
   * the project, and the two optional disclosure and filter reports.
   *
   * Provided as context for the views, and wired directly into the head's two
   * plain callbacks (see {@link PanelHost}). Stable for the same reason as
   * {@link PanelHostProps.dataProvider}.
   */
  actions: PanelActions;

  /**
   * The token value set to render, forwarded to the theme root untouched.
   *
   * Omitted, the shell applies the product default. Resolving a host signal —
   * a DevTools theme name, an editor body class — into a theme belongs to the
   * host surface that owns that API; `../tokens/theme` carries the two
   * translations.
   */
  theme?: PanelTheme | undefined;

  /**
   * Additional class names for the theme root, for positioning the panel inside
   * its host frame.
   *
   * Composition, never an escape hatch for a visual value: a class named here
   * is defined against `--dg-*` tokens like every other class in this package.
   */
  className?: string | undefined;

  /** An `id` for the theme root, for a host that needs to reference it. */
  id?: string | undefined;
}

/**
 * Renders a validated panel specification.
 *
 * The theme root, the two ambient contracts, the fallback notice when the
 * document carries one, the head, and the layout — in that order and nothing
 * else. Pure and presentational: no state, no effect, no hook, no memoization,
 * nothing read from the document while rendering, and no write to the
 * specification.
 *
 * Three details are decisions rather than mechanics:
 *
 * - **The head's callbacks are wired, not re-implemented.** `../layout/SummaryHeader`
 *   imports nothing from this folder by design, so it declares two plain
 *   callbacks over the schema's own citation and location types; they are
 *   satisfied straight from the injected actions. Passing the members through
 *   rather than wrapping them keeps the guarantee that matters at the far end
 *   of the click-to-source chain: what a hypothesis suggested is what the host
 *   receives, field for field (AAP 0.4.2).
 * - **The layout renders at the node tier's own outline level.** No
 *   `headingLevel` is passed to `./NodeRenderer`: a container node's heading
 *   comes from the layout primitive the registry selects, at that primitive's
 *   own level, and the recursion steps one level deeper per labelled container
 *   from there. Overriding the top level here would leave a container's title
 *   where it is and push its children one level further, which is how an
 *   outline acquires a skipped heading level.
 * - **An empty layout is a state, not a gap.** A validated specification may
 *   carry no views, so the body renders the library's empty state with a
 *   neutral sentence — never a blank area, and never an error, which is what a
 *   failed *validation* looks like and this is not.
 *
 * @param props - See {@link PanelHostProps}.
 * @returns The whole panel: theme root, contexts, notice, head and layout.
 *
 * @example A host surface mounting one session's current panel.
 * ```tsx
 * <PanelHost
 *   spec={currentPanel}
 *   dataProvider={sessionDataProvider}
 *   actions={hostActions}
 *   theme={resolvedTheme}
 * />
 * ```
 */
export function PanelHost(props: PanelHostProps): ReactElement {
  const { spec, dataProvider, actions, theme, className, id } = props;

  return (
    <PanelShell theme={theme} className={className} id={id}>
      {/* Both contracts wrap the head as well as the layout. The head is handed
          its two callbacks directly, because it imports nothing from this
          folder, but a component it composes still reads the ambient pair — and
          a tree where only part of the panel can reach the host is the harder
          failure to notice. The values are the props themselves: no object is
          built here, so nothing beneath re-renders for an identity this
          component invented. */}
      <DataProviderContext.Provider value={dataProvider}>
        <PanelActionsContext.Provider value={actions}>
          <div className={PANEL_CLASS}>
            {/* Above the summary, so the provenance of what follows is read
                first. The explicit `=== true` is the reading `PanelMeta`
                prescribes: the flag is absent on an ordinary generated panel
                and is never defaulted on parse. */}
            {spec.meta?.fallback === true ? renderFallbackBanner() : null}

            <SummaryHeader
              title={spec.title}
              summary={spec.summary}
              onSelectEvent={actions.onSelectEvent}
              onOpenSource={actions.onOpenSource}
              className={SUMMARY_CLASS}
            />

            <div className={BODY_CLASS}>
              {spec.layout.length > 0 ? (
                renderPanelNodes(spec.layout)
              ) : (
                <EmptyState
                  message={EMPTY_LAYOUT_MESSAGE}
                  icon={<LayoutTemplate className={ICON_CLASS} />}
                />
              )}
            </div>
          </div>
        </PanelActionsContext.Provider>
      </DataProviderContext.Provider>
    </PanelShell>
  );
}
