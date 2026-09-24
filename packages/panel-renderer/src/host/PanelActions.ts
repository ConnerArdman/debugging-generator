/**
 * `PanelActions` — the one interaction surface of `@debuggen/panel-renderer`,
 * and the second hop of the product's click-to-source chain.
 *
 * Every visualization component in this package is a pure view over data it was
 * handed: it renders spans, rows, bars, cards and tree nodes, and when the
 * developer activates one of them it has exactly one way to say so — a callback
 * on this contract, reached either from a prop or from
 * {@link PanelActionsContext}. Nothing below the host layer opens a socket,
 * posts a message, calls `fetch` or knows a message name (AAP 0.1.2: "avoid
 * tightly coupling UI components directly to WebSocket implementation
 * details"; AAP 0.6.2: components "receive interactions through `PanelActions`"
 * and never open sockets or fetch). That is what lets the same thirteen
 * components render inside the Chrome DevTools panel, which reaches the local
 * service over a runtime port and a WebSocket, and inside the editor webview,
 * which reaches it through the extension host's own message channel — with no
 * component knowing the difference.
 *
 * ## One contract, two spellings: what a host implements, what a view calls
 *
 * The specification names the same two intents twice, from two sides, and this
 * module publishes both names rather than choosing one and breaking the other:
 *
 *   - **The host form, {@link PanelHostActions}** — `selectEvent(eventId)` and
 *     `openSource(location)`. This is the contract the two surfaces implement:
 *     the DevTools panel's `panel/actions.ts` and the editor webview (AAP 0.4.2
 *     names the hop `PanelActions.openSource`; the selection intent is keyed by
 *     the schema's own `EventRef.eventId`). It is what a surface hands to the
 *     panel host.
 *   - **The view form, {@link PanelViewActions}** — `onSelectEvent(ref)` and
 *     `onOpenSource(location)`. This is the call surface the thirteen
 *     components use (AAP 0.6.2 names every component interaction
 *     `onSelectEvent`/`onOpenSource`), and the only form
 *     {@link usePanelActions} ever returns.
 *
 * {@link PanelActions} is the union of the two — what a surface may supply to
 * the panel host or to {@link PanelActionsContext} — and each form declares the
 * other's two members as `?: never`, so a value is unambiguously one form and
 * {@link isPanelHostActions} can tell which at runtime. The explicit
 * compatibility adapters {@link toPanelViewActions} and
 * {@link toPanelHostActions} translate between them: pure, allocation-only,
 * returning the very object they were given when it is already in the asked-for
 * form, and forwarding a location **by reference** in both directions. The
 * event reference a view reports is reduced to `eventId` plus whichever of the
 * schema's `traceId`/`spanId` coordinates it actually held, so no field is
 * invented on the way and none a view had is dropped.
 *
 * ## The click-to-source chain, and this module's place in it
 *
 * A source chip in a generated panel becomes an editor selection through a
 * fixed sequence of hops (AAP 0.2.3, 0.4.2):
 *
 * ```text
 * a source chip → PanelActions.openSource  ← THIS MODULE, hop 2
 *   (a view reports it as onOpenSource; the adapter hands the host's
 *   openSource the same location object)
 *   → the DevTools panel's actions module → a runtime port
 *   → the extension's background worker → the `source.open` message
 *   → the local service, which re-validates containment against the session's
 *     project root
 *   → the editor client, which opens the document with a selection
 * ```
 *
 * **The `SourceLocation` is forwarded unmodified, field for field.** No path
 * rewriting, no separator normalisation, no line or column arithmetic, no
 * dropping of `symbol`, `endLine`, `resolvedBy` or `confidence`, and no
 * re-validation. This is a deliberate non-goal rather than an omission:
 *
 *   - Validation and containment are enforced where they can actually be
 *     enforced — by the schema that parsed the location in the first place, by
 *     the local service against the session's project root, and independently
 *     by the editor's URI handler with a real path resolution, because any web
 *     page can trigger that URI. A check here would be a fourth, weaker copy
 *     that cannot see a symlink and cannot see a project root.
 *   - Arithmetic here is how an off-by-one reaches the editor. Everything on
 *     the wire is 1-based on both axes, and the single subtraction that turns a
 *     line into an editor position lives in the editor extension. A "helpful"
 *     adjustment in this file would land the developer one line away from the
 *     evidence they clicked, in a product whose entire promise is that the
 *     runtime item and the source agree.
 *
 * So: pass the object through. If a location looks wrong, the resolver that
 * produced it is wrong, and that is where the fix belongs.
 *
 * ## Why {@link usePanelActions} returns `undefined` instead of throwing
 *
 * The obvious shape for a context hook is "throw if no provider is mounted",
 * and it is the wrong shape here. Two real callers need the opposite:
 *
 *   - The source chip resolves its handler in a fixed order — an explicit
 *     `onOpenSource` prop, then the context handler, then **a non-interactive
 *     chip** — and must never throw when neither exists. A panel is generated
 *     from captured evidence and rendered in whatever surface asked for it; a
 *     missing provider is a surface that cannot navigate, not a broken panel,
 *     and a thrown error would replace a complete analysis with an error
 *     boundary over a formatting detail.
 *   - The editor webview reuses the primitives and several views to render its
 *     own summary without mounting a provider at all.
 *
 * Hence the hook reads the context and returns what it finds — adapted to the
 * view form when a surface provided the host form. Callers use
 * optional chaining (`actions?.onExpand?.(…)`) and, where an affordance only
 * makes sense if it leads somewhere, render the inert variant instead of a
 * control that silently does nothing. For the same reason this module exports
 * **no no-op actions object**: a no-op `onOpenSource` would make a chip look
 * clickable and then do nothing, which is a worse outcome than a chip that
 * plainly is not a link.
 *
 * ## Constraints this module works under
 *
 *   - **Contract only.** Two event-pointer types, the two forms and their
 *     union, one type guard, two pure adapters, one context and one hook. No
 *     state, no effect, no timer, no storage, no environment read, and no side
 *     effect at import time beyond the `createContext` call that *is* the
 *     context.
 *   - **Schema types reused, never restated.** The event pointer is picked from
 *     the schema's own `EventRef`, so a citation's field names and optionality
 *     have one definition (AAP 0.2.3); the renderer depends on the schema,
 *     never the reverse (AAP 0.6.2).
 *   - **Browser-safe.** The sibling `tsup.config.ts` builds with
 *     `platform: 'browser'`, so no Node builtin and no Node-only global appears
 *     here — and none is needed by a file that declares callbacks.
 *   - **Transport-blind.** The wire-protocol package is not a dependency of
 *     this package and must not become one (AAP 0.2.2, enforced by the root
 *     ESLint configuration): the protocol layer sits above the renderer, and
 *     the two host applications own every socket.
 *   - **Extensionless relative specifiers** throughout this workspace, which
 *     resolves with `moduleResolution: "bundler"` — unlike the `.js`-suffixed
 *     convention of the Node-targeted packages.
 */

import type { EventRef } from '@debuggen/panel-schema';
import type { SourceLocation } from '@debuggen/shared';
import { createContext, useContext, useMemo } from 'react';

/*
 * ---------------------------------------------------------------------------
 * Event pointers
 * ---------------------------------------------------------------------------
 */

/**
 * The optional coordinates that travel beside a selected event's id: the trace
 * it belongs to and the span it is, when the view holds them.
 *
 * Picked from the schema's own `EventRef`, so the field names, their
 * optionality and the explicit `| undefined` that `exactOptionalPropertyTypes`
 * requires of a caller forwarding `spanId: maybeSpanId` are the schema's, not a
 * second declaration of them. Both are **hints**: they save the receiver a
 * lookup and let it scope trace-filtered views immediately, and a receiver that
 * needs neither may ignore them.
 *
 * This is the second argument of {@link PanelHostActions.selectEvent}. When the
 * renderer calls it, the object holds **only the coordinates the view actually
 * held** — a key is never written with an `undefined` value, and never
 * fabricated for a view that has none.
 */
export type PanelEventCoordinates = Pick<EventRef, 'traceId' | 'spanId'>;

/**
 * What a component names when the developer activates something that stands for
 * a captured event: a timeline bar, a waterfall row, a log line, a flame cell,
 * a table row, an evidence chip in the summary header. The argument of
 * {@link PanelViewActions.onSelectEvent}.
 *
 * **`eventId` is the only required field, on purpose.** It is the one
 * coordinate every consumer can act on — the details drawer resolves the stored
 * event by it, and the panel-data route filters by it — and it is the only one
 * some views genuinely hold. A view that renders an aggregate (a component's
 * render count, a group of identical requests, a statement's execution count)
 * has a representative event id and no single span or trace, and a view driven
 * by a citation has whatever the citation recorded. Requiring more would force
 * those views to invent a span id, and a fabricated coordinate is worse than an
 * absent one: it resolves to nothing, or to the wrong thing, in a drawer the
 * developer is reading as evidence.
 *
 * `spanId` and `traceId` are therefore the optional hints of
 * {@link PanelEventCoordinates}.
 *
 * **Picked from the schema's `EventRef`, never restated.** The citation type is
 * defined once, in `@debuggen/panel-schema`, and this pointer is exactly its
 * addressing subset: a validated citation is assignable to it as it stands, and
 * a field renamed in the schema renames here in the same edit. `kind` and
 * `label` are not picked — they are the chip's display sugar, not coordinates a
 * receiver acts on — and neither is anything of the captured event itself: the
 * event shape is defined once, in `@debuggen/telemetry`, and a copy travelling
 * inside an interaction callback would be an unredacted, never-refreshed
 * duplicate of the evidence it points at. This is a pointer; resolution belongs
 * to the host.
 */
export type PanelEventRef = Pick<EventRef, 'eventId' | 'traceId' | 'spanId'>;

/*
 * ---------------------------------------------------------------------------
 * The two forms of the contract
 * ---------------------------------------------------------------------------
 */

/**
 * The action contract a **host surface implements**: the DevTools panel's
 * `panel/actions.ts` and the editor webview (AAP 0.4.2, 0.7.3).
 *
 * Four members, and no fifth: the two a panel cannot be useful without are
 * required, and the two that only some views offer are optional, so a host that
 * supports selection and navigation is a complete host. Every member is a plain
 * callback — the interface names an *intent*, never a transport — and a host
 * implements it by doing whatever its surface does with that intent.
 *
 * Handed to the panel host, which adapts it once for the views
 * ({@link toPanelViewActions}) and wires its two required members straight into
 * the summary head. Handlers are called during a user gesture (a click, an
 * Enter or Space activation, a disclosure toggle, a filter change) and are
 * expected to return promptly; anything slow belongs behind the host's own
 * asynchronous work, not in the gesture, because the renderer awaits nothing
 * here and reports no result.
 *
 * `onSelectEvent` and `onOpenSource` are declared `?: never`: they belong to the
 * view form, and a value carrying members of both forms would be ambiguous about
 * which pair a view's report reaches.
 *
 * @example The shape a surface implements. The two functions it delegates to
 * are the surface's own — a drawer it renders, and whatever channel carries a
 * location, together with the session it belongs to, to its coordination
 * service. Neither is known to this package.
 * ```ts
 * const hostActions: PanelHostActions = {
 *   selectEvent: (eventId, coordinates) => {
 *     showEventDetails(eventId, coordinates?.traceId);
 *   },
 *   openSource: (location) => {
 *     requestSourceOpen(location);
 *   },
 * };
 * ```
 */
export interface PanelHostActions {
  /**
   * The developer selected something that stands for a captured event.
   *
   * Drives the details drawer: the host resolves `eventId` against the capture
   * and shows the event's attributes, kind and tier badges, duration, parent
   * chain and source chip (AAP 0.7.3). Reached from every view whose items are
   * addressable — timeline and waterfall bars, log lines, flame cells, table
   * rows, tree nodes, and the summary header's evidence chips.
   *
   * `eventId` is the schema's own `EventRef.eventId`. `coordinates` carries the
   * trace and span hints the view held; the renderer always passes it, holding
   * only the keys that were present (possibly none), so an implementation may
   * read `coordinates?.traceId` or be written `(eventId) => …` and ignore it.
   *
   * Required, because a panel whose evidence cannot be inspected is a picture
   * of a capture rather than a way into it.
   */
  selectEvent: (eventId: EventRef['eventId'], coordinates?: PanelEventCoordinates) => void;

  /**
   * The developer asked to open a place in their project.
   *
   * Hop 2 of the chain documented at the top of this module. The host forwards
   * `location` onward **exactly as received** — see that note for why no field
   * is rewritten, adjusted, dropped or re-validated here. The object it
   * receives is the very object the chip was rendered with: the adapter hands
   * it on by reference.
   *
   * Required, because click-to-source is one of the product's two headline
   * behaviours: every runtime item that resolved to a location offers a chip,
   * and a chip that leads nowhere is the feature failing quietly.
   */
  openSource: (location: SourceLocation) => void;

  /**
   * A row, group or tree node was expanded or collapsed.
   *
   * `nodeId` is the id of the panel node the component renders, so a host with
   * several instances of the same view can tell them apart; `itemId` identifies
   * the row, group or node within that view; `expanded` is the state after the
   * gesture, not a request to toggle — which keeps the report idempotent and
   * lets a host persist disclosure state without tracking a parity.
   *
   * Optional: views without disclosure never call it, and a view that has it
   * still expands on its own, so a host that does not care about persisting
   * disclosure simply omits the member.
   */
  onExpand?: ((nodeId: string, itemId: string, expanded: boolean) => void) | undefined;

  /**
   * A component-local filter, sort or search value changed.
   *
   * `nodeId` is again the panel node's id, and `filter` is the component's
   * current selection as plain strings — the values a toolbar actually holds
   * (a chosen kind, a sort key, a search term, a threshold as typed).
   *
   * **No data query is built here.** Turning a selection into a query is the
   * component's own job, against the query it was configured with, and keeping
   * this report free of query shapes is what stops a filter control from
   * needing to know the data-source vocabulary. The host uses it for what a
   * host can do with it — remembering a developer's filters across a re-render
   * or a reopened session — and nothing in the renderer depends on it being
   * handled.
   *
   * Optional, for the same reason as {@link PanelHostActions.onExpand}.
   */
  onFilterChange?: ((nodeId: string, filter: Record<string, string>) => void) | undefined;

  /** The view form's member; never present on a host-form value. */
  onSelectEvent?: never;

  /** The view form's member; never present on a host-form value. */
  onOpenSource?: never;
}

/**
 * The call surface a **view uses**: what {@link usePanelActions} returns and
 * what the thirteen components raise their interactions through (AAP 0.6.2
 * names them `onSelectEvent` and `onOpenSource`).
 *
 * Same four intents as {@link PanelHostActions}, with the two required members
 * spelled the way the components call them:
 *
 * - `onSelectEvent(ref)` takes a {@link PanelEventRef} — the id plus whichever
 *   coordinates the view holds — because a view builds the pointer from the
 *   row, bar or cell it drew and hands it over whole.
 * - `onOpenSource(location)` is the host's `openSource`, the same function, so
 *   the location travels by reference.
 * - `onExpand` and `onFilterChange` are the host's own members, unchanged.
 *
 * Components reach an instance either from an explicit prop, which always wins,
 * or from {@link PanelActionsContext} through {@link usePanelActions}. A surface
 * may still supply this form directly — a component suite, a surface that
 * embeds individual views — and the panel host accepts it as well.
 *
 * `selectEvent` and `openSource` are declared `?: never`, mirroring the host
 * form, so the two forms are mutually exclusive.
 */
export interface PanelViewActions {
  /**
   * The developer selected something that stands for a captured event. See
   * {@link PanelHostActions.selectEvent} for what the host does with it.
   */
  onSelectEvent: (ref: PanelEventRef) => void;

  /**
   * The developer asked to open a place in their project. See
   * {@link PanelHostActions.openSource}: `location` is forwarded unmodified.
   */
  onOpenSource: (location: SourceLocation) => void;

  /** See {@link PanelHostActions.onExpand}. */
  onExpand?: ((nodeId: string, itemId: string, expanded: boolean) => void) | undefined;

  /** See {@link PanelHostActions.onFilterChange}. */
  onFilterChange?: ((nodeId: string, filter: Record<string, string>) => void) | undefined;

  /** The host form's member; never present on a view-form value. */
  selectEvent?: never;

  /** The host form's member; never present on a view-form value. */
  openSource?: never;
}

/**
 * Everything a rendered panel can ask its host to do, in either spelling: what
 * a surface may hand to the panel host or provide through
 * {@link PanelActionsContext}.
 *
 * Host surfaces supply {@link PanelHostActions}; {@link PanelViewActions} is
 * accepted too, so a surface or suite written against the view names keeps
 * working unchanged. Views never receive the union — {@link usePanelActions}
 * always resolves it to the view form.
 */
export type PanelActions = PanelHostActions | PanelViewActions;

/*
 * ---------------------------------------------------------------------------
 * Telling the forms apart, and translating between them
 * ---------------------------------------------------------------------------
 */

/**
 * Whether an actions value is in the host form.
 *
 * A runtime check rather than a tag, because the forms are plain objects a
 * surface writes by hand: a value is the host form exactly when both of its
 * required members are callable. Anything else is treated as the view form,
 * which is what the `?: never` members make the only other possibility a
 * type-checked value can be.
 *
 * @param actions A value in either form.
 * @returns `true` when `actions` carries callable `selectEvent` and `openSource`.
 */
export function isPanelHostActions(actions: PanelActions): actions is PanelHostActions {
  return typeof actions.selectEvent === 'function' && typeof actions.openSource === 'function';
}

/**
 * The trace and span coordinates of a pointer, holding only the keys whose
 * values are present.
 *
 * Never writes a key as `undefined` — a receiver comparing key sets, or one
 * spreading the object into a filter, must see exactly the hints the view held
 * — and never copies anything else: an `EventRef`'s `kind` or `label` is not a
 * coordinate.
 *
 * @param ref Anything carrying the optional coordinates.
 * @returns A fresh object with the present coordinates, possibly empty.
 */
function presentCoordinates(ref: PanelEventCoordinates): PanelEventCoordinates {
  const { traceId, spanId } = ref;

  return {
    ...(traceId === undefined ? {} : { traceId }),
    ...(spanId === undefined ? {} : { spanId }),
  };
}

/**
 * The two optional members, with a key written only for a member that is
 * present, so an adapted object has exactly the members its source had.
 *
 * @param actions The value whose optional members are carried over.
 * @returns A fresh object holding the present optional members, possibly empty.
 */
function presentOptionalMembers(
  actions: PanelActions,
): Pick<PanelHostActions, 'onExpand' | 'onFilterChange'> {
  const { onExpand, onFilterChange } = actions;

  return {
    ...(onExpand === undefined ? {} : { onExpand }),
    ...(onFilterChange === undefined ? {} : { onFilterChange }),
  };
}

/**
 * The view form of an actions value — the explicit compatibility adapter from
 * what a host implements to what a view calls.
 *
 * - A value already in the view form is returned **as it is**, the same object,
 *   so a memoized value keeps its identity and no consumer re-renders.
 * - A host-form value becomes a new object whose `onSelectEvent(ref)` calls
 *   `selectEvent(ref.eventId, coordinates)` with only the coordinates `ref`
 *   holds, whose `onOpenSource` **is** the host's `openSource` (so the
 *   location reaches it by reference, unwrapped), and which carries the
 *   host's `onExpand` and `onFilterChange` only where the host supplied them.
 *
 * Pure: it calls nothing it was given, and allocates a new object on every
 * host-form call — callers that provide the result as context memoize it on
 * the value's identity, as {@link usePanelActions} and the panel host do.
 *
 * @param actions A value in either form.
 * @returns The same value, or its view-form adaptation.
 *
 * @example A component-level harness reusing a surface's host actions.
 * ```tsx
 * const viewActions = useMemo(() => toPanelViewActions(hostActions), [hostActions]);
 * <PanelActionsContext.Provider value={viewActions}>{views}</PanelActionsContext.Provider>
 * ```
 */
export function toPanelViewActions(actions: PanelActions): PanelViewActions {
  if (!isPanelHostActions(actions)) {
    return actions;
  }

  const { selectEvent, openSource } = actions;

  return {
    onSelectEvent: (ref) => {
      selectEvent(ref.eventId, presentCoordinates(ref));
    },
    onOpenSource: openSource,
    ...presentOptionalMembers(actions),
  };
}

/**
 * The host form of an actions value — the explicit compatibility adapter from
 * what a view calls to what a host implements.
 *
 * - A value already in the host form is returned **as it is**, the same object.
 * - A view-form value becomes a new object whose `selectEvent(eventId,
 *   coordinates)` calls `onSelectEvent({ eventId, ...coordinates })` with only
 *   the coordinates that are present, whose `openSource` **is** the view's
 *   `onOpenSource` (the location travels by reference), and which carries the
 *   optional members only where they were supplied.
 *
 * This is how the panel host serves a surface that handed it the view form:
 * the summary head reports through the host form either way.
 *
 * @param actions A value in either form.
 * @returns The same value, or its host-form adaptation.
 */
export function toPanelHostActions(actions: PanelActions): PanelHostActions {
  if (isPanelHostActions(actions)) {
    return actions;
  }

  const { onSelectEvent, onOpenSource } = actions;

  return {
    selectEvent: (eventId, coordinates) => {
      onSelectEvent({
        eventId,
        ...(coordinates === undefined ? {} : presentCoordinates(coordinates)),
      });
    },
    openSource: onOpenSource,
    ...presentOptionalMembers(actions),
  };
}

/*
 * ---------------------------------------------------------------------------
 * The context and the hook
 * ---------------------------------------------------------------------------
 */

/**
 * The context a host mounts so that every component beneath it can report
 * interactions without being handed callbacks through each intervening layer.
 *
 * The panel host provides it once, around the whole layout, and always in the
 * view form; a surface that embeds individual components may provide it too —
 * in either form — or pass callbacks as props instead. Props always win, so
 * both compose.
 *
 * **What the value's identity means.** Every component that reads this context
 * re-renders whenever the provided object changes identity, so the panel host
 * never provides the `actions` prop it was handed: it provides a view-form
 * object it memoizes on the callbacks' own identities. A surface may therefore
 * rebuild its actions object on every render (an object literal in JSX is fine)
 * without re-rendering a single visualization, **as long as the callbacks
 * themselves are stable** — define them once, or wrap them in `useCallback`. A
 * callback that is a fresh closure on every render is a real change and
 * re-renders every consumer, which is correct: the handler the views would call
 * has changed. A surface that provides this context itself, outside the panel
 * host, should memoize its value the same way; a host-form value is adapted by
 * {@link usePanelActions} once per value identity, so a stable value stays
 * stable through the adapter.
 *
 * Its default is `undefined`, and that value is meaningful rather than a
 * placeholder: it is exactly what a component sees when no host is present, and
 * what the degradation path described on {@link usePanelActions} keys off.
 */
export const PanelActionsContext = createContext<PanelActions | undefined>(undefined);

/**
 * Reads the actions of the nearest host **in the view form**, or `undefined`
 * when no host is mounted.
 *
 * Whatever form the nearest provider supplied, the caller reads
 * {@link PanelViewActions}: a view-form value is returned as it is, and a
 * host-form value is adapted by {@link toPanelViewActions}, memoized on the
 * provided value's identity so an unchanged provider yields an unchanged
 * object. Components therefore call `onSelectEvent(ref)` and
 * `onOpenSource(location)` without knowing which surface they are in.
 *
 * **This hook never throws.** That is the contract, not an implementation
 * detail — see the note on this module for the two callers that depend on it
 * (the source chip's non-interactive fallback, and the editor webview's
 * provider-less reuse of these components). A future edit that turns a missing
 * provider into an error replaces complete, correct panels with an error
 * boundary in exactly the surfaces that were working.
 *
 * Callers therefore always treat the result as possibly absent:
 *
 * ```ts
 * const actions = usePanelActions();
 *
 * // An affordance that only makes sense if it leads somewhere: render the
 * // inert variant when nothing will handle it.
 * const openSource = onOpenSourceProp ?? actions?.onOpenSource;
 *
 * // An optional member of a present host: chain both.
 * actions?.onExpand?.(nodeId, itemId, true);
 * ```
 *
 * @returns The nearest host's actions in the view form, or `undefined` outside
 * a provider.
 */
export function usePanelActions(): PanelViewActions | undefined {
  const provided = useContext(PanelActionsContext);

  return useMemo(
    () => (provided === undefined ? undefined : toPanelViewActions(provided)),
    [provided],
  );
}
