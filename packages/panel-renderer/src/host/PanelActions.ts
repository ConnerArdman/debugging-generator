/**
 * `PanelActions` — the one interaction surface of `@debuggen/panel-renderer`,
 * and the second hop of the product's click-to-source chain.
 *
 * Every visualization component in this package is a pure view over data it was
 * handed: it renders spans, rows, bars, cards and tree nodes, and when the
 * developer activates one of them it has exactly one way to say so — a callback
 * on this interface, reached either from a prop or from
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
 * ## The click-to-source chain, and this module's place in it
 *
 * A source chip in a generated panel becomes an editor selection through a
 * fixed sequence of hops (AAP 0.2.3, 0.4.2):
 *
 * ```text
 * a source chip → PanelActions.onOpenSource  ← THIS MODULE, hop 2
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
 * Hence the hook reads the context and returns what it finds. Callers use
 * optional chaining (`actions?.onExpand?.(…)`) and, where an affordance only
 * makes sense if it leads somewhere, render the inert variant instead of a
 * control that silently does nothing. For the same reason this module exports
 * **no no-op actions object**: a no-op `onOpenSource` would make a chip look
 * clickable and then do nothing, which is a worse outcome than a chip that
 * plainly is not a link.
 *
 * ## Constraints this module works under
 *
 *   - **Contract only.** Two interfaces, one context, one hook, and one
 *     compile-time proof. No state, no effect, no timer, no storage, no
 *     environment read, and no side effect at import time beyond the
 *     `createContext` call that *is* the context.
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
import { createContext, useContext } from 'react';

/**
 * What a component names when the developer activates something that stands for
 * a captured event: a timeline bar, a waterfall row, a log line, a flame cell,
 * a table row, an evidence chip in the summary header.
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
 * `spanId` and `traceId` are therefore optional hints that save the receiver a
 * lookup and let it scope trace-filtered views immediately. Both declare
 * `| undefined` explicitly because this workspace compiles with
 * `exactOptionalPropertyTypes`: a caller that has computed
 * `spanId: maybeSpanId` may pass it as it stands rather than deleting the key.
 *
 * Deliberately **not** a restatement of a captured event. The event shape is
 * defined once, in `@debuggen/telemetry`, and a second copy travelling inside
 * an interaction callback would be an unredacted, never-refreshed duplicate of
 * the evidence it points at. This is a pointer; resolution belongs to the host.
 */
export interface PanelEventRef {
  /** The id of the event the activated item stands for. */
  eventId: string;

  /** The span the item is, when the view holds it. */
  spanId?: string | undefined;

  /** The trace the item belongs to, when the view holds it. */
  traceId?: string | undefined;
}

/**
 * Constrains `Source` to be assignable to `Target`, so that instantiating it
 * with an incompatible pair is a compile error. Used immediately below as an
 * assignability proof, mirroring the exhaustiveness proof in `../tokens/theme`.
 */
type AssertAssignable<Target, Source extends Target> = Source;

/**
 * Compile-time proof that a validated `EventRef` is a {@link PanelEventRef}.
 *
 * The summary header deliberately imports nothing from this folder: it declares
 * a plain `onSelectEvent?: (ref: EventRef) => void` prop over the schema's
 * citation type, and the panel host wires it directly from
 * {@link PanelActions.onSelectEvent}. Under `strictFunctionTypes` that
 * assignment only type-checks while `EventRef` remains assignable to
 * {@link PanelEventRef}, and the failure would otherwise surface in the host,
 * one layer away from the declaration that caused it.
 *
 * This alias moves the failure here. A required field added to the schema's
 * citation type — or an optional one whose spelling stops matching — fails the
 * typecheck beside the interface that has to accommodate it, which is where the
 * decision (widen {@link PanelEventRef}) actually gets made. The schema is
 * never narrowed to suit the renderer: the renderer depends on the schema,
 * never the reverse (AAP 0.6.2).
 */
export type EventRefIsPanelEventRef = AssertAssignable<PanelEventRef, EventRef>;

/**
 * Everything a rendered panel can ask its host to do.
 *
 * Four members, and no fifth: the two a panel cannot be useful without are
 * required, and the two that only some views offer are optional, so a host that
 * supports selection and navigation is a complete host. Every member is a plain
 * callback — the interface names an *intent*, never a transport — and a host
 * implements it by doing whatever its surface does with that intent.
 *
 * Components reach an instance either from an explicit prop, which always wins,
 * or from {@link PanelActionsContext} through {@link usePanelActions}. Handlers
 * are called during a user gesture (a click, an Enter or Space activation, a
 * disclosure toggle, a filter change) and are expected to return promptly;
 * anything slow belongs behind the host's own asynchronous work, not in the
 * gesture, because the renderer awaits nothing here and reports no result.
 */
export interface PanelActions {
  /**
   * The developer selected something that stands for a captured event.
   *
   * Drives the details drawer: the host resolves `ref.eventId` against the
   * capture and shows the event's attributes, kind and tier badges, duration,
   * parent chain and source chip (AAP 0.7.3). Called by every view whose items
   * are addressable — timeline and waterfall bars, log lines, flame cells,
   * table rows, tree nodes, and the summary header's evidence chips.
   *
   * Required, because a panel whose evidence cannot be inspected is a picture
   * of a capture rather than a way into it.
   */
  onSelectEvent: (ref: PanelEventRef) => void;

  /**
   * The developer asked to open a place in their project.
   *
   * Hop 2 of the chain documented at the top of this module. The host forwards
   * `location` onward **exactly as received** — see that note for why no field
   * is rewritten, adjusted, dropped or re-validated here.
   *
   * Required, because click-to-source is one of the product's two headline
   * behaviours: every runtime item that resolved to a location offers a chip,
   * and a chip that leads nowhere is the feature failing quietly.
   */
  onOpenSource: (location: SourceLocation) => void;

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
   * Optional, for the same reason as {@link PanelActions.onExpand}.
   */
  onFilterChange?: ((nodeId: string, filter: Record<string, string>) => void) | undefined;
}

/**
 * The context a host mounts so that every component beneath it can report
 * interactions without being handed callbacks through each intervening layer.
 *
 * The panel host provides it once, around the whole layout; a surface that
 * embeds individual components may provide it too, or pass callbacks as props
 * instead — props always win, so both compose.
 *
 * **What the value's identity means.** Every component that reads this context
 * re-renders whenever the provided object changes identity, so the panel host
 * never provides the `actions` prop it was handed: it provides an object it
 * memoizes on the four callbacks' identities. A surface may therefore rebuild
 * its actions object on every render (an object literal in JSX is fine) without
 * re-rendering a single visualization, **as long as the callbacks themselves
 * are stable** — define them once, or wrap them in `useCallback`. A callback
 * that is a fresh closure on every render is a real change and re-renders every
 * consumer, which is correct: the handler the views would call has changed. A
 * surface that provides this context itself, outside the panel host, should
 * memoize its value the same way.
 *
 * Its default is `undefined`, and that value is meaningful rather than a
 * placeholder: it is exactly what a component sees when no host is present, and
 * what the degradation path described on {@link usePanelActions} keys off.
 */
export const PanelActionsContext = createContext<PanelActions | undefined>(undefined);

/**
 * Reads the {@link PanelActions} of the nearest host, or `undefined` when no
 * host is mounted.
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
 * @returns The nearest host's actions, or `undefined` outside a provider.
 */
export function usePanelActions(): PanelActions | undefined {
  return useContext(PanelActionsContext);
}
