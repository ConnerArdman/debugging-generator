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
 * 2. Provides the ambient contracts — the data provider, the session the
 *    specification belongs to, and the action contract — around the whole
 *    subtree, so that every view beneath it reaches its evidence and reports its
 *    interactions without any of them being threaded through each intervening
 *    layer (AAP 0.6.2). The session is `spec.sessionId`, the document's own
 *    statement of which capture it describes; every query a view makes is
 *    addressed to it (`POST /sessions/:id/panel-data`, AAP 0.4.2).
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
 * **It does not re-render what did not change.** A host surface re-renders this
 * component for reasons that have nothing to do with the panel — a selection in
 * its details drawer, a connection pill, a fresh `actions` object built from the
 * same callbacks — and a panel is a dozen tables and SVG views deep. So the
 * action context is rebuilt only when one of its callbacks changes identity,
 * the head only when the title, the summary or its two callbacks change, and
 * the rendered layout only when `spec.layout` itself is a different value. The
 * data and session contexts carry values that are already stable (the injected
 * provider, and a string). A replaced specification still re-renders exactly
 * what it replaced: every memo below is keyed on the document's own objects,
 * never on an id that a regenerated panel could share with its predecessor.
 *
 * **It does not let a view outlive the panel it was drawn for.** Re-rendering
 * less is only safe while the mounted views belong to the document on screen.
 * The panel column is therefore keyed on the document's session, id and
 * generation, so a specification for another session — or another panel, or a
 * regenerated one — unmounts every view of the previous panel and mounts fresh
 * ones, instead of reusing views whose paged rows, next-page offsets and
 * filters were accumulated against a different capture. A re-delivery of the
 * same panel keeps the key, and with it every mounted view (see
 * `panelIdentityKey` below).
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
import { useMemo } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { PanelShell } from '../layout/PanelShell';
import { SummaryHeader } from '../layout/SummaryHeader';
import { EmptyState } from '../primitives/EmptyState';
import type { HeadingLevel } from '../primitives/Heading';
import { Text } from '../primitives/Text';
import type { PanelTheme } from '../tokens/theme';
import { DataProviderContext, PanelSessionContext } from './DataProvider';
import type { DataProvider } from './DataProvider';
import { renderPanelNodes } from './NodeRenderer';
import {
  PanelActionsContext,
  isPanelHostActions,
  toPanelHostActions,
  toPanelViewActions,
} from './PanelActions';
import type { PanelActions, PanelHostActions, PanelViewActions } from './PanelActions';

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
 * Outline levels
 * ---------------------------------------------------------------------------
 */

/**
 * The level of the panel's own title: **2**, the summary head's documented
 * default, stated here so the relationship with the layout below is written in
 * one file rather than inferred across two. A surface's own chrome — a product
 * wordmark, an editor view title — sits above it.
 */
const PANEL_TITLE_HEADING_LEVEL: HeadingLevel = 2;

/**
 * The level the layout's top-level nodes render their headings at: **3**, one
 * below {@link PANEL_TITLE_HEADING_LEVEL}.
 *
 * A panel's sections are parts of the panel, so their headings belong under its
 * title — beside the head's own "Observed" and "Likely cause" regions, which sit
 * at the same depth — and never beside it. `./NodeRenderer` hands this level to
 * every top-level node, container or labelled leaf, and one level deeper to the
 * children of each container whose title it renders, so the whole outline below
 * the title follows from this one value without a skipped or repeated level.
 */
const LAYOUT_HEADING_LEVEL: HeadingLevel = 3;

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
 * Panel identity
 * ---------------------------------------------------------------------------
 */

/**
 * The React key of the panel column: which capture, which panel and which
 * generation of that panel the mounted views belong to.
 *
 * **Why the column is keyed at all — cross-session isolation.** Several views
 * hold component-local state that outlives a render: the rows they have paged
 * in so far and the offset of the next page (the event log, the span, render,
 * request and query tables, the state-transition viewer, the timeline, the
 * waterfall), a filter or sort chosen in their toolbar, an expanded row. That
 * state is keyed by what the *view* can see — its node, its query, the
 * provider — and none of those name a session. Without this key, a host that
 * swaps in a panel for another session whose layout happens to carry the same
 * node ids and queries (a reopened session of another project, a regenerated
 * panel of the same shape) would keep every view mounted, so a table could
 * keep drawing the previous capture's rows under the new session's title and
 * ask for *its* next page at the previous capture's offset. Keying the column
 * on the document's identity makes React unmount every view of the old panel —
 * aborting its in-flight requests through the query hook's cleanup — and mount
 * fresh ones that start from their first page, under the new session.
 *
 * **What is in the key, and what is deliberately not.**
 *
 * - `sessionId` — the capture every query beneath is addressed to. Another
 *   session is another project's evidence, and nothing a view accumulated may
 *   cross into it.
 * - `id` — another panel of the same session is another document; its views
 *   answer another question and inherit nothing from this one's.
 * - `panelVersion` — a regenerated panel is a new generation of the document,
 *   validated against the capture afresh, so its views start clean as well.
 *
 * Nothing else. A re-delivery of the same panel — a new specification object, a
 * retitled head, a reordered layout, a fresh `actions` object — keeps the same
 * key, so mounted views, their pages and their open disclosures survive it,
 * which is what the render memos below and the node renderer's id keys exist
 * to preserve.
 *
 * Built with `JSON.stringify` over a tuple rather than by joining with a
 * separator, so no identifier can collide with another by containing the
 * separator (`"a|b" + "c"` against `"a" + "b|c"`): an ambiguous key would be a
 * way for two sessions to share a mounted view.
 *
 * @param spec The panel being rendered.
 * @returns A string equal for, and only for, the same session, panel and
 * generation.
 */
function panelIdentityKey(spec: PanelSpec): string {
  return JSON.stringify([spec.sessionId, spec.id, spec.panelVersion]);
}

/*
 * ---------------------------------------------------------------------------
 * The two action forms
 * ---------------------------------------------------------------------------
 */

/**
 * The callbacks a surface supplied, flattened out of whichever form it used.
 *
 * Exactly one of the two required pairs is set — `selectEvent`/`openSource`
 * for the host form, `onSelectEvent`/`onOpenSource` for the view form — and the
 * other is `undefined`. Flattened so the host can memoize on the callbacks'
 * own identities rather than on the object that carried them.
 */
interface SuppliedActionMembers {
  /** The host form's selection callback, or `undefined` for a view-form value. */
  readonly selectEvent: PanelHostActions['selectEvent'] | undefined;

  /** The host form's navigation callback, or `undefined` for a view-form value. */
  readonly openSource: PanelHostActions['openSource'] | undefined;

  /** The view form's selection callback, or `undefined` for a host-form value. */
  readonly onSelectEvent: PanelViewActions['onSelectEvent'] | undefined;

  /** The view form's navigation callback, or `undefined` for a host-form value. */
  readonly onOpenSource: PanelViewActions['onOpenSource'] | undefined;

  /** The optional disclosure report, shared by both forms. */
  readonly onExpand: PanelHostActions['onExpand'];

  /** The optional filter report, shared by both forms. */
  readonly onFilterChange: PanelHostActions['onFilterChange'];
}

/** Both forms of one surface's actions, as the host hands them on. */
interface PanelActionForms {
  /** What the summary head reports through: `selectEvent` and `openSource`. */
  readonly host: PanelHostActions | undefined;

  /** What the action context carries for the views: `onSelectEvent` and `onOpenSource`. */
  readonly view: PanelViewActions | undefined;
}

/**
 * Rebuilds the supplied actions from their callbacks and derives the other form
 * through the compatibility adapters of `./PanelActions`.
 *
 * The form the surface supplied is rebuilt as a plain object holding the very
 * same callbacks (optional members only where present); the other form is its
 * adaptation. So a host-form surface's `openSource` is the function the views'
 * `onOpenSource` calls, and a view-form surface's `onOpenSource` is the
 * function the head's `openSource` calls — the location reaches the surface by
 * reference either way.
 *
 * A value that carries neither complete pair — impossible for a type-checked
 * surface, reachable only from an untyped caller — yields no actions at all,
 * which renders every affordance in its inert form: a chip that is plainly not
 * a link, never a control that throws when pressed.
 *
 * @param members The supplied callbacks, flattened.
 * @returns The host and view forms, both absent only for an incomplete value.
 */
function panelActionForms(members: SuppliedActionMembers): PanelActionForms {
  const { selectEvent, openSource, onSelectEvent, onOpenSource, onExpand, onFilterChange } =
    members;
  const optional = {
    ...(onExpand === undefined ? {} : { onExpand }),
    ...(onFilterChange === undefined ? {} : { onFilterChange }),
  };

  if (selectEvent !== undefined && openSource !== undefined) {
    const host: PanelHostActions = { selectEvent, openSource, ...optional };

    return { host, view: toPanelViewActions(host) };
  }

  if (onSelectEvent !== undefined && onOpenSource !== undefined) {
    const view: PanelViewActions = { onSelectEvent, onOpenSource, ...optional };

    return { host: toPanelHostActions(view), view };
  }

  return { host: undefined, view: undefined };
}

/*
 * ---------------------------------------------------------------------------
 * The host
 * ---------------------------------------------------------------------------
 */

/**
 * The inputs of one rendered panel.
 *
 * Three required members and three conveniences. The document (which names its
 * own session), the data contract and the action contract are the whole of what
 * a panel needs: the provider and the actions are *injected* rather than
 * constructed here, which is the boundary that keeps this tier free of any
 * transport (AAP 0.1.2).
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
   * with it. `spec.meta?.fallback === true` is the one field it branches on,
   * and `spec.sessionId` is the session every query beneath it is addressed to.
   */
  spec: PanelSpec;

  /**
   * How every view beneath this panel resolves the `DataQuery` its node
   * carries, for the session named by `spec.sessionId`.
   *
   * Provided as context, so the reference must be **stable** across renders:
   * it is part of the query effect's dependencies in `./useQuery`, and a
   * provider rebuilt per render would refetch every node forever. The session
   * travels on each call rather than inside the provider, so one provider per
   * host surface serves every session it shows.
   */
  dataProvider: DataProvider;

  /**
   * What this panel's interactions do — selecting an event, opening a place in
   * the project, and the two optional disclosure and filter reports.
   *
   * Host surfaces supply the host form, `PanelHostActions` —
   * `selectEvent(eventId, coordinates?)` and `openSource(location)`, the
   * contract the DevTools panel and the editor webview implement. The view
   * form (`onSelectEvent`/`onOpenSource`) is accepted as well and behaves
   * identically.
   *
   * The views receive the view form through the action context, and the head's
   * two plain callbacks are wired to the host form (see {@link PanelHost}).
   * Both are keyed on the callbacks' own identities rather than on this
   * object's, so a host may pass a freshly built object on every render without
   * re-rendering a view — as long as the callbacks inside it are stable.
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
 * The theme root, the three ambient contracts, the fallback notice when the
 * document carries one, the head, and the layout — in that order and nothing
 * else. Presentational: no state, no effect, no write to the specification.
 * Its only hooks are the three memos described in this module's header, which
 * keep an unrelated host render from reaching the views, and the one key on
 * the panel column, which keeps a view from outliving its session or panel.
 *
 * Five details are decisions rather than mechanics:
 *
 * - **Queries are addressed to the document's own session.** The session
 *   context carries `spec.sessionId` and nothing else: not a session the host
 *   surface happens to have selected, and not one remembered by the provider.
 *   A reopened session's panel therefore reads its own capture even while the
 *   surface is bound to a newer one, and a panel for another session — or
 *   another panel, or another generation of this one — remounts every view the
 *   moment it is swapped in, so each starts from its first page under the new
 *   session and nothing it drew for the previous capture is shown or paged on.
 * - **The head's callbacks are wired, not re-implemented.** `../layout/SummaryHeader`
 *   imports nothing from this folder by design, so it declares two plain
 *   callbacks over the schema's own citation and location types — the host
 *   form's `selectEvent(eventId, coordinates)` and `openSource(location)`.
 *   For a surface that supplied the host form they are its own members, passed
 *   through; for one that supplied the view form they are the compatibility
 *   adapter's, whose `openSource` is the surface's `onOpenSource` itself.
 *   Either way the guarantee that matters at the far end of the click-to-source
 *   chain holds: what a hypothesis suggested is what the host receives, the
 *   same object (AAP 0.4.2).
 * - **The views read the view form.** The action context carries
 *   `onSelectEvent`/`onOpenSource` — the names the components call — adapted
 *   from the host form when that is what the surface supplied, so no component
 *   knows which surface it is in.
 * - **The outline is stated once, here.** The title renders at
 *   {@link PANEL_TITLE_HEADING_LEVEL} and the layout's top-level nodes one level
 *   below it, at {@link LAYOUT_HEADING_LEVEL}; `./NodeRenderer` carries the level
 *   down, one step per titled container, into every container's own heading as
 *   well as every labelled leaf's.
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
 *   dataProvider={surfaceDataProvider}
 *   actions={hostActions}
 *   theme={resolvedTheme}
 * />
 * ```
 */
export function PanelHost(props: PanelHostProps): ReactElement {
  const { spec, dataProvider, actions, theme, className, id } = props;
  const { sessionId, title, summary, layout } = spec;

  // The supplied callbacks, flattened out of whichever form the surface used:
  // one required pair is set and the other is `undefined`, and the optional
  // pair is shared by both forms.
  const hostForm = isPanelHostActions(actions);
  const suppliedSelectEvent = hostForm ? actions.selectEvent : undefined;
  const suppliedOpenSource = hostForm ? actions.openSource : undefined;
  const suppliedOnSelectEvent = hostForm ? undefined : actions.onSelectEvent;
  const suppliedOnOpenSource = hostForm ? undefined : actions.onOpenSource;
  const { onExpand, onFilterChange } = actions;

  // Both action forms, keyed on the callbacks rather than on the object that
  // carried them. A host that rebuilds `actions` on every render from stable
  // callbacks — the natural way to write it — then changes nothing any view
  // reads, and a host that genuinely swaps a callback still reaches every
  // consumer. The supplied form keeps its callbacks as they are and the other
  // is its adaptation, so what a view or the head reports is what the host
  // receives, location by reference (AAP 0.4.2).
  const forms = useMemo(
    () =>
      panelActionForms({
        selectEvent: suppliedSelectEvent,
        openSource: suppliedOpenSource,
        onSelectEvent: suppliedOnSelectEvent,
        onOpenSource: suppliedOnOpenSource,
        onExpand,
        onFilterChange,
      }),
    [
      suppliedSelectEvent,
      suppliedOpenSource,
      suppliedOnSelectEvent,
      suppliedOnOpenSource,
      onExpand,
      onFilterChange,
    ],
  );
  const viewActions = forms.view;
  const selectEvent = forms.host?.selectEvent;
  const openSource = forms.host?.openSource;

  // The head, re-rendered only when what it draws or what it reports to has
  // changed. It reports through the host form — `selectEvent(eventId,
  // coordinates)` and `openSource(location)` — whose members are stable for as
  // long as the supplied callbacks are.
  const head = useMemo<ReactElement>(
    () => (
      <SummaryHeader
        title={title}
        summary={summary}
        headingLevel={PANEL_TITLE_HEADING_LEVEL}
        selectEvent={selectEvent}
        openSource={openSource}
        className={SUMMARY_CLASS}
      />
    ),
    [title, summary, selectEvent, openSource],
  );

  // The layout, rendered once per `spec.layout` value. Handing React the very
  // same element objects on a later render is what lets it skip every node
  // beneath: nothing a host render changes reaches a table or an SVG view
  // unless it changed a context that view reads. A new specification brings a
  // new `layout` array, so a replaced panel is always re-rendered in full.
  const body = useMemo<ReactNode>(
    () =>
      layout.length > 0 ? (
        renderPanelNodes(layout, { headingLevel: LAYOUT_HEADING_LEVEL })
      ) : (
        <EmptyState
          message={EMPTY_LAYOUT_MESSAGE}
          icon={<LayoutTemplate className={ICON_CLASS} />}
        />
      ),
    [layout],
  );

  return (
    <PanelShell theme={theme} className={className} id={id}>
      {/* All three contracts wrap the head as well as the layout. The head is
          handed its two callbacks directly, because it imports nothing from
          this folder, but a component it composes still reads the ambient
          contracts — and a tree where only part of the panel can reach the host
          is the harder failure to notice. Each value is stable for as long as
          what it stands for is: the injected provider, the document's session
          string, and the memoized view form of the actions. */}
      <DataProviderContext.Provider value={dataProvider}>
        <PanelSessionContext.Provider value={sessionId}>
          <PanelActionsContext.Provider value={viewActions}>
            {/* Keyed on the document's session, id and generation (see
                `panelIdentityKey`): a panel for another session, or another
                panel, remounts every view beneath, so no page, offset or
                filter a view accumulated survives into a capture it was not
                drawn from. The shell and the three providers stay mounted. */}
            <div key={panelIdentityKey(spec)} className={PANEL_CLASS}>
              {/* Above the summary, so the provenance of what follows is read
                  first. The explicit `=== true` is the reading `PanelMeta`
                  prescribes: the flag is absent on an ordinary generated panel
                  and is never defaulted on parse. */}
              {spec.meta?.fallback === true ? renderFallbackBanner() : null}

              {head}

              <div className={BODY_CLASS}>{body}</div>
            </div>
          </PanelActionsContext.Provider>
        </PanelSessionContext.Provider>
      </DataProviderContext.Provider>
    </PanelShell>
  );
}
