/**
 * `PanelView` — the "Debug Generator" DevTools panel's generated-panel region.
 *
 * AAP 0.7.3: "`PanelView` renders the current `PanelSpec` through `PanelHost`".
 * That sentence is the whole job. The specification arrives validated and
 * normalized from the coordination service, the composition root (`../App`)
 * reads it from the session store, and this component hands it — together with
 * the data provider, the actions and the theme the composition root already
 * built — to the renderer's `PanelHost`, unchanged.
 *
 * The one thing it adds is the panel's identity. The injected provider is
 * bound, with the renderer's `bindPanelIdentity`, to the rendered
 * specification's own `id`, so every query a node of this panel makes names
 * the panel it belongs to and the service answers it from the capture that
 * panel was generated from. Without the binding a node would read live
 * evidence — the session's open or most recent capture — and an older panel
 * still on screen after a newer capture started would draw that capture's data
 * under its own findings. The specification itself is not touched.
 *
 * ## What happens one layer down, and therefore not here
 *
 * `PanelHost` already renders, for every specification it is given:
 *
 * - the theme root (`PanelShell`), which is the one element in the design
 *   system that writes the `data-theme` attribute and the one scroll region a
 *   panel has;
 * - the data-provider, session, action and selection contexts every view
 *   resolves its `DataQuery` and reports its interactions through;
 * - the fallback banner, when the specification carries `meta.fallback`;
 * - the summary head (`SummaryHeader`), with observed facts and likely causes
 *   kept apart;
 * - every layout node through `NodeRenderer`, each with its own loading, empty
 *   and error states, and the empty-layout state for a panel with no views.
 *
 * Re-implementing any of those here would be a second copy that could drift
 * from the first, so none of them is.
 *
 * ## Guard rails — read before "improving" the passthrough
 *
 * 1. **No node filtering, re-ordering or substitution (AAP 0.6.5).** The panels
 *    for the demonstrated questions must differ in the views they compose — the
 *    slow-interaction panel and the excessive-render panel share only the
 *    summary head, the metric cards and the source chips. Any allow-list,
 *    per-type branch or re-sort of `spec.layout` here flattens that difference,
 *    and the end-to-end suite that asserts the two node-type sets differ fails.
 *    The layout is rendered exactly as it was generated.
 * 2. **No second `SummaryHeader` (AAP 0.7.3).** `PanelHost` renders the head
 *    from `spec.title` and `spec.summary`; a second one here would print the
 *    observed facts twice.
 * 3. **`meta.fallback` is a success, not an error (AAP 0.5.5).** An invalid
 *    model panel is replaced upstream by a deterministic panel built from the
 *    captured data, and `PanelHost` announces it under its own visible banner.
 *    This component never reads the flag — not to style it, not to hide it and
 *    not to swap it for an error state.
 *
 * The same reasoning covers the rest of the specification: nothing here reads
 * `spec.layout`, `spec.summary`, `spec.title` or `spec.meta` to decide what to
 * render, nothing branches on the session question or the panel title (the
 * hardcoding pattern AAP 0.5.4 forbids), and the specification is never
 * validated, normalized, repaired or mutated — validation belongs to the
 * service, which is the only party that can see the capture it is checked
 * against (AAP 0.5.3).
 *
 * ## The states this component owns
 *
 * Only the ones that exist before a specification does:
 *
 * | Input                                  | Renders                                   |
 * | -------------------------------------- | ----------------------------------------- |
 * | `spec` defined (any `status`)          | `PanelHost`, and nothing else             |
 * | no `spec`, `status` `"generating"`     | `LoadingState` — analysis and panel       |
 * |                                        | generation are in progress                |
 * | no `spec`, `status` `"error"`          | `ErrorState` with the failure and, when   |
 * |                                        | supplied, the retry action                |
 * | no `spec`, nothing in flight           | `null` — `EmptyPanel` owns that copy      |
 *
 * A defined specification wins over every status on purpose: while a
 * follow-up regenerates the panel, or after a later stage fails, the panel
 * already on screen stays readable and the composition root reports the
 * in-flight or failing stage beside it — never instead of it. A generation
 * failure with no panel to show is always an error state, never an empty
 * region (AAP 0.5.5).
 *
 * ## Boundaries
 *
 * Presentational and pure: no state (its one hook is the memo that keeps the
 * panel-bound provider's identity stable), no effect, no store access, no
 * transport (no socket, request or port, and no `DataProvider.query` call of
 * its own — every view resolves its own query through the renderer's query
 * hook) and no `chrome.*` API. It therefore renders unchanged in the panel page opened
 * directly as an extension page with `chrome.devtools` undefined, which is how
 * the browser suite renders a stored specification. It provides no context,
 * because `PanelHost` provides all of them, and it wraps nothing around
 * `PanelHost`: a second shell or scroll container would compete with
 * `PanelShell` for the scrollbar and for the theme attribute.
 *
 * ## Design-system compliance (AAP 0.6.3, 0.6.4)
 *
 * Every visual value comes from a renderer component — `PanelHost`,
 * `LoadingState`, `ErrorState` — and therefore from the `--dg-*` tokens behind
 * them. No inline style, no length, no colour and no class name of its own;
 * `className` is forwarded for placement only. The theme is forwarded to
 * `PanelHost` explicitly so the generated panel and the panel chrome around it
 * (themed on the document root by `../theme`) render from the same token set.
 *
 * @module apps/chrome-extension/src/panel/components/PanelView
 */
import { bindPanelIdentity, ErrorState, LoadingState, PanelHost } from '@debuggen/panel-renderer';
import type { DataProvider, PanelActions } from '@debuggen/panel-renderer';
import type { PanelSpec } from '@debuggen/panel-schema';
import { useMemo } from 'react';
import type { ReactElement } from 'react';

import type { PanelTheme } from '../theme';

/**
 * What the composition root knows about panel generation while no
 * specification is on screen.
 *
 * - `"idle"` — nothing is being generated; the region renders nothing and the
 *   composition root shows its own state (the no-session `EmptyPanel`, or the
 *   session summary while the developer reproduces the issue).
 * - `"generating"` — analysis and panel generation are running.
 * - `"error"` — generation stopped without producing a panel.
 *
 * Ignored whenever a specification is supplied (see the module header).
 */
export type PanelViewStatus = 'idle' | 'generating' | 'error';

/**
 * The failure shown when generation stopped without a panel.
 *
 * Structural on purpose: a relayed protocol `error` payload, a session's
 * failing-stage description or a local failure all carry a `message` and are
 * assignable as they are.
 */
export interface PanelViewError {
  /** What went wrong, in one sentence, as the layer that observed it put it. */
  readonly message: string;
}

/**
 * Props of {@link PanelView}.
 *
 * `dataProvider` and `actions` are built **once** by the composition root and
 * passed down; this component creates neither — it only wraps the provider,
 * memoized, with the rendered panel's identity — and their identities must
 * stay stable across renders because `PanelHost` keys its query effects and
 * memos on them. `theme` is required even though `PanelHost` treats it as optional: the
 * composition root resolved it once for the whole panel document, and
 * forwarding it explicitly keeps the generated panel and the chrome around it
 * from ever rendering in different token sets.
 *
 * Every optional member spells `| undefined` because `exactOptionalPropertyTypes`
 * is in force repository-wide and a caller forwarding a value it may not have —
 * `error={snapshot.lastError}` — must stay legal.
 */
export interface PanelViewProps {
  /**
   * The current validated panel from the session store, or `undefined` when the
   * session has none yet. Rendered through `PanelHost` exactly as given.
   */
  spec: PanelSpec | undefined;

  /**
   * How the views beneath `PanelHost` resolve their data queries. Stable
   * identity. Bound here to the rendered specification's `id` before it
   * reaches `PanelHost`, so every node reads the capture that panel was
   * generated from. The provider passed in is not modified: the composition
   * root's own callers, such as the event drawer, name the panel per call
   * when they read its evidence and read live evidence otherwise.
   */
  dataProvider: DataProvider;

  /** What the panel's interactions do: select an event, open a source location. */
  actions: PanelActions;

  /** The theme the panel document resolved at startup, forwarded to `PanelHost`. */
  theme: PanelTheme;

  /** Generation progress while no specification is available. Defaults to `"idle"`. */
  status?: PanelViewStatus | undefined;

  /** The failure to show when `status` is `"error"` and no specification is available. */
  error?: PanelViewError | undefined;

  /**
   * Offered as the error state's retry action. Omitted, no retry control is
   * rendered, because a control that cannot retry is worse than none.
   */
  onRetry?: (() => void) | undefined;

  /**
   * The event the panel's details drawer is showing, forwarded to `PanelHost`
   * so every view marks the same event the drawer describes. Omitted, the
   * panel keeps its own selection from what its views report; `null` clears it.
   */
  selectedEventId?: string | null | undefined;

  /**
   * Extra classes for the region's root — `PanelHost`'s theme root, or the
   * loading or error state — for placement inside the panel layout only.
   */
  className?: string | undefined;

  /** An `id` for the region's root, for a caller that needs to reference it. */
  id?: string | undefined;
}

/**
 * The first line of the error state: what failed, stated at the level of this
 * region. Generic product vocabulary only (AAP 0.5.4).
 */
const GENERATION_FAILED_TITLE = 'Could not generate the debugging panel';

/**
 * The message used when the failure arrived without a readable one, so the
 * error state never renders a blank line where the explanation belongs.
 */
const GENERATION_FAILED_FALLBACK_MESSAGE =
  'Analysis stopped before a debugging panel was produced.';

/** The announcement of the busy state; `LoadingState` appends the ellipsis. */
const GENERATING_LABEL = 'Generating the debugging panel';

/**
 * The message the error state shows: the caller's own wording when it has any
 * text, and the generic fallback otherwise.
 *
 * @param error The failure the caller supplied, if any.
 * @returns A non-blank sentence.
 */
function failureMessage(error: PanelViewError | undefined): string {
  const message = error?.message.trim();

  return message === undefined || message === '' ? GENERATION_FAILED_FALLBACK_MESSAGE : message;
}

/**
 * Renders the session's current generated panel through `PanelHost`, or — while
 * there is none — the generation's loading or error state, or nothing.
 *
 * @param props The props documented on {@link PanelViewProps}.
 * @returns `PanelHost` for a specification; `LoadingState` or `ErrorState`
 *   while generation is in flight or has failed; `null` otherwise.
 *
 * @example
 * // The composition root, with the provider and actions built once:
 * <PanelView
 *   spec={snapshot.panel?.spec}
 *   dataProvider={dataProvider}
 *   actions={actions}
 *   theme={theme}
 *   status={generationStatus}
 *   error={snapshot.lastError}
 *   onRetry={retryGeneration}
 * />
 */
export function PanelView(props: PanelViewProps): ReactElement | null {
  const {
    spec,
    dataProvider,
    actions,
    theme,
    status = 'idle',
    error,
    onRetry,
    selectedEventId,
    className,
    id,
  } = props;

  // Every node of the rendered panel reads the capture that panel was
  // generated from: the injected provider is bound to the specification's own
  // id, so each query it makes names this panel. Memoized on the provider and
  // the id — before the early returns, as hooks must be — so the bound
  // provider keeps one identity for as long as this panel is on screen (the
  // renderer keys its query effects on it) and a newly rendered panel version
  // gets a new one, which resolves its views again against its own capture.
  const panelId = spec?.id;
  const panelProvider = useMemo(
    () => (panelId === undefined ? dataProvider : bindPanelIdentity(dataProvider, panelId)),
    [dataProvider, panelId],
  );

  // The whole render path for a panel. See the guard rails in the module
  // header: the specification is forwarded as it is — no node is filtered,
  // re-ordered or substituted, no head is added, and `meta.fallback` is left
  // to `PanelHost`'s own banner.
  if (spec !== undefined) {
    return (
      <PanelHost
        spec={spec}
        dataProvider={panelProvider}
        actions={actions}
        selectedEventId={selectedEventId}
        theme={theme}
        className={className}
        id={id}
      />
    );
  }

  if (status === 'generating') {
    return <LoadingState variant="block" label={GENERATING_LABEL} className={className} id={id} />;
  }

  if (status === 'error') {
    return (
      <ErrorState
        title={GENERATION_FAILED_TITLE}
        message={failureMessage(error)}
        onRetry={onRetry}
        className={className}
        id={id}
      />
    );
  }

  return null;
}
