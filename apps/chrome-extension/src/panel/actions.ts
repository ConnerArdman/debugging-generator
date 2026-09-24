/**
 * The DevTools panel's implementation of `@debuggen/panel-renderer`'s
 * `PanelActions` contract: what happens when the developer selects a captured
 * event, and what happens when they ask to open a place in their project.
 *
 * ## Where this module sits
 *
 * Every visualization in a generated panel is a pure view. When the developer
 * activates something in one, the view raises exactly one of two intents
 * through `PanelActions` — never a socket, never a message name (AAP §0.1.2,
 * §0.6.2). This module is the DevTools panel's answer to both, and it is hops
 * 2 and 3 of the click-to-source chain (AAP §0.2.3, §0.4.2):
 *
 * ```text
 * SourceLink chip → PanelActions.onOpenSource        ← THIS MODULE (hop 2)
 *   → the panel's runtime port (`./state/connection`) ← THIS MODULE (hop 3)
 *   → the MV3 service worker → WS `source.open`
 *   → the local service (refuses paths outside the session's projectRoot)
 *   → the VS Code client → showTextDocument with a selection
 * ```
 *
 * ## The two intents
 *
 * - **`onSelectEvent(ref)`** records the selection in `./state/session-store`,
 *   which is the one owner of "which event does the `EventDetails` drawer
 *   show". The call is **local only**: no port message, no I/O. The store
 *   already treats a repeated selection — even through a fresh object — as a
 *   no-op that notifies nobody, so calling this twice with the same reference
 *   is idempotent by construction. The drawer's open/closed state is the
 *   store's selection itself; {@link DevtoolsPanelActions.clearSelectedEvent}
 *   closes it through the same dispatch.
 * - **`onOpenSource(location)`** sends one `source.open` request over the
 *   panel's port, carrying the session id and the `SourceLocation` **exactly as
 *   received** — the same object, by reference. No path normalisation, no line
 *   or column arithmetic, no clamping of `confidence`, no dropping of `symbol`
 *   or `endLine`, no key re-ordering and no re-validation. Containment and
 *   bounds are enforced where they can be enforced: by the local service
 *   against the session's project root, and independently by the editor's URI
 *   handler with a real path resolution. A third check here could see neither
 *   a project root nor a symlink, and any "helpful" adjustment would land the
 *   developer one line away from the evidence they clicked;
 *   `tests/browser/source-navigation.spec.ts` asserts that the location the
 *   service observes equals the one clicked, field for field.
 *
 * ## Why the view form
 *
 * `PanelActions` is published in two spellings — the host form
 * (`selectEvent`/`openSource`) and the view form
 * (`onSelectEvent`/`onOpenSource`) — and `PanelHost` accepts either. This
 * module returns the **view form** because the same object is handed to three
 * consumers: `PanelHost`, and the `EventDetails` drawer and `LiveTail` pane,
 * which render outside `PanelHost` and therefore see no `PanelActionsContext`.
 * Those two take `onOpenSource` and `onSelectEvent` as explicit props — a
 * `SourceLink` resolves its handler as *explicit prop → context → inert chip*,
 * so without the explicit prop a chip in the drawer would silently become a
 * dead label. The declared return type, {@link DevtoolsPanelActions}, keeps
 * both members required so those props type-check without a cast, and it is
 * assignable to `PanelActions` as it stands.
 *
 * `onExpand` and `onFilterChange` are deliberately not implemented: both are
 * optional in the contract, every view keeps its own disclosure and filter
 * state without them, the panel store holds no slice for either, and neither
 * may re-query — components own their `DataQuery` through `useQuery`. An
 * implementation that only discarded the reports would add nothing.
 *
 * ## Failure policy (AAP §0.5.5)
 *
 * The renderer's callbacks are fire-and-forget: they return `void` and the
 * renderer awaits nothing. So `onOpenSource` never throws and never lets a
 * rejected promise escape as an unhandled rejection — and it never swallows a
 * failure silently or presents one as success either. Every failure is logged
 * through the injected logger and surfaced through the store's non-blocking
 * `lastError`, which the panel chrome renders as an error state, never as
 * analysis:
 *
 * | Condition | Code surfaced |
 * | --- | --- |
 * | no session for this panel | `TAB_NOT_BOUND` |
 * | the worker could not hand the frame to its socket (`forwarded: false`) | `TRANSPORT_DISCONNECTED` |
 * | the port closed, timed out, or no extension runtime exists | the rejection's own code (`TRANSPORT_DISCONNECTED`) |
 * | the worker refused the request with a typed failure | the worker's code, message and `ref` |
 * | the injected session reader threw | `INTERNAL` |
 *
 * A later successful open dismisses the failure this module surfaced — and
 * only that one: an unrelated error relayed from the service stays on screen.
 *
 * ## Constraints
 *
 * - **No transport of its own.** No `WebSocket`, no `fetch`, no HTTP client, no
 *   `chrome.runtime.connect`: the request function is injected, and
 *   `./state/connection` owns the one port. Every dependency is injected, so
 *   the factory is pure and unit-testable without a browser.
 * - **No React.** Plain functions over injected dependencies, so `App.tsx`
 *   builds the object once with `useMemo` and passes the same identity to
 *   `PanelHost`, `EventDetails` and `LiveTail`; memoized renderer components
 *   do not re-render because the actions changed.
 * - **Nothing at import time.** Declarations only: no `chrome.*` access at all
 *   (so the panel page opened directly as an extension page, with no
 *   `chrome.devtools`, loads it unchanged), no timer, no listener.
 * - **Types-only protocol use.** `@debuggen/protocol` contributes the
 *   `ErrorPayload` type; the wire shapes of the port come from
 *   `../shared/messages`.
 *
 * @example Wiring in the panel's composition root (`./App.tsx`):
 * ```tsx
 * const actions = useMemo(
 *   () =>
 *     createPanelActions({
 *       request: panelRequest,
 *       getSessionId,
 *       selectEvent,
 *       reportError: setLastError,
 *       getLastError: () => getPanelSnapshot().lastError,
 *     }),
 *   [],
 * );
 *
 * <PanelHost spec={spec} dataProvider={dataProvider} actions={actions} />
 * <EventDetails event={event} onOpenSource={actions.onOpenSource} onSelectEvent={actions.onSelectEvent} onClose={actions.clearSelectedEvent} />
 * <LiveTail actions={actions} … />
 * ```
 *
 * @module apps/chrome-extension/src/panel/actions
 */

import type { PanelEventRef, PanelViewActions } from '@debuggen/panel-renderer';
import type { ErrorPayload } from '@debuggen/protocol';
import { DebuggenError, formatSourceLocation, noopLogger } from '@debuggen/shared';
import type { DebuggenErrorCode, Logger, SessionId, SourceLocation } from '@debuggen/shared';

import type { PortRequestPayloads, PortResponsePayloads } from '../shared/messages';

import type { PanelRequestFunction } from './state/connection';
import type { PanelSnapshot } from './state/session-store';

/*
 * ===========================================================================
 * Section A — the injection surface
 * ===========================================================================
 */

/**
 * The event pointer the store's selection slice holds — the panel schema's
 * `EventRef`, derived from the store's own declaration so the selection has a
 * single definition. A view's `PanelEventRef` (the id plus whichever trace and
 * span coordinates it held) is assignable to it as it stands.
 */
export type PanelSelectedEventRef = NonNullable<PanelSnapshot['selectedEvent']>;

/** The `source.open` port request payload: `{ sessionId, location }`. */
export type SourceOpenRequestPayload = PortRequestPayloads['source.open'];

/** The `source.open` port response payload: `{ forwarded }`. */
export type SourceOpenResponsePayload = PortResponsePayloads['source.open'];

/**
 * The one port request this module sends, typed narrowly: least privilege for
 * the injected dependency, and a signature a unit suite can satisfy with a
 * plain mock.
 *
 * `./state/connection`'s module-stable `panelRequest` — equally
 * `getPanelConnection().request` — satisfies it, as
 * {@link PanelRequestSatisfiesSourceOpenRequest} proves at compile time. Like
 * `panelRequest`, an implementation resolves with the worker's answer and
 * rejects with a `DebuggenError` whose `details.reason` names why.
 */
export type SourceOpenRequest = (
  kind: 'source.open',
  payload: SourceOpenRequestPayload,
) => Promise<SourceOpenResponsePayload>;

/**
 * Fails to compile unless its argument is exactly `true` — the drift-assertion
 * idiom the extension's other modules use.
 */
type AssertTrue<Assertion extends true> = Assertion;

/**
 * Compile-time proof that the panel connection's typed request function can be
 * injected as {@link PanelActionsOptions.request} with no cast, so a change to
 * the port contract that breaks the wiring fails `tsc -b` here rather than in
 * the composition root. Type-level only.
 */
export type PanelRequestSatisfiesSourceOpenRequest = AssertTrue<
  PanelRequestFunction extends SourceOpenRequest ? true : false
>;

/**
 * Everything {@link createPanelActions} needs, injected rather than acquired.
 *
 * The composition root passes the panel's module-level functions —
 * `panelRequest` from `./state/connection`, and `getSessionId`, `selectEvent`,
 * `setLastError` and a `lastError` reader from `./state/session-store` — and a
 * unit suite passes fakes. Nothing here is read until an action is invoked.
 */
export interface PanelActionsOptions {
  /**
   * Sends the `source.open` port request. Must not open a port of its own:
   * `./state/connection` is the panel's only `chrome.runtime.connect` site.
   */
  readonly request: SourceOpenRequest;

  /**
   * The session this panel is showing, or `undefined` when there is none —
   * read at click time, so a binding that changes after the actions were built
   * is honoured.
   */
  readonly getSessionId: () => SessionId | undefined;

  /**
   * The store's event-selection dispatch: a reference opens the `EventDetails`
   * drawer on that event, `undefined` closes it. Expected to be idempotent for
   * a repeated reference, as the store's `selectEvent` is.
   */
  readonly selectEvent: (ref: PanelSelectedEventRef | undefined) => void;

  /**
   * Surfaces a non-blocking failure through the store (`setLastError`), or
   * dismisses the current one with `undefined`.
   */
  readonly reportError: (error: ErrorPayload | undefined) => void;

  /**
   * Reads the store's current non-blocking failure. When supplied, a
   * successful open dismisses the failure this module surfaced last — and only
   * when it is still the one on screen, so an unrelated error relayed from the
   * service is never cleared by a click. When omitted, a surfaced failure stays
   * until something else dismisses it.
   */
  readonly getLastError?: (() => ErrorPayload | undefined) | undefined;

  /**
   * Where diagnostics go. Defaults to the silent `noopLogger`. Log records name
   * an error code and a failure reason only — never a location, a payload, a
   * token or a URL.
   */
  readonly logger?: Logger | undefined;
}

/**
 * What {@link createPanelActions} returns: the renderer's view-form actions
 * with both required members present, plus the drawer's close action.
 *
 * Assignable to `PanelActions` (the `PanelHost` prop) as it stands, and its
 * `onOpenSource`/`onSelectEvent` members satisfy the explicit props of the
 * `EventDetails` drawer and the `LiveTail` pane, which render outside
 * `PanelHost`. The object is frozen, so its identity and members never change.
 */
export interface DevtoolsPanelActions extends PanelViewActions {
  /**
   * Closes the `EventDetails` drawer by clearing the store's selection. Local
   * only, like `onSelectEvent`; a no-op when nothing is selected.
   */
  readonly clearSelectedEvent: () => void;
}

/*
 * ===========================================================================
 * Section B — private helpers
 * ===========================================================================
 */

/**
 * The longest message the protocol's `ErrorPayload` schema accepts. Mirrors
 * the module-private bound of `@debuggen/protocol`'s `messages/error.ts`, which
 * does not export it; a message longer than this is shortened rather than
 * handed to the store as a payload the protocol would refuse.
 */
const MAX_ERROR_MESSAGE_LENGTH = 2000;

/** Appended to a shortened message: a single U+2026 HORIZONTAL ELLIPSIS. */
const ELLIPSIS = '\u2026';

/** A value's error name for a log field — never its message or contents. */
function errorName(cause: unknown): string {
  return cause instanceof Error ? cause.name : typeof cause;
}

/**
 * The failure reason `./state/connection` recorded on a rejection
 * (`details.reason`), or `undefined` for a rejection that carries none.
 */
function failureReason(error: DebuggenError): string | undefined {
  const reason = error.details?.reason;
  return typeof reason === 'string' ? reason : undefined;
}

/**
 * The correlation reference a worker-refused rejection carried
 * (`details.ref`), or `undefined`.
 */
function failureRef(error: DebuggenError): string | undefined {
  const ref = error.details?.ref;
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined;
}

/**
 * `message`, shortened to {@link MAX_ERROR_MESSAGE_LENGTH} with a trailing
 * ellipsis when it is longer. Never splits a UTF-16 surrogate pair.
 */
function boundMessage(message: string): string {
  if (message.length <= MAX_ERROR_MESSAGE_LENGTH) {
    return message;
  }
  let end = MAX_ERROR_MESSAGE_LENGTH - ELLIPSIS.length;
  const lastCodeUnit = message.charCodeAt(end - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    end -= 1;
  }
  return `${message.slice(0, end)}${ELLIPSIS}`;
}

/**
 * The developer-facing sentence for a failed open, naming the location by its
 * canonical `file:line:column` label — the same string the chip shows — so
 * the developer can tell which click failed. Display only: the location that
 * travels is never derived from this.
 */
function openFailureMessage(location: SourceLocation, reason: string): string {
  return boundMessage(`Could not open ${formatSourceLocation(location)} in the editor: ${reason}`);
}

/** A frozen `ErrorPayload`, with `ref` present only when there is one. */
function errorRecord(code: DebuggenErrorCode, message: string, ref?: string): ErrorPayload {
  return Object.freeze(ref === undefined ? { code, message } : { code, message, ref });
}

/** Whether two error records say the same thing — the store's own equality. */
function sameErrorRecord(left: ErrorPayload, right: ErrorPayload): boolean {
  return left.code === right.code && left.message === right.message && left.ref === right.ref;
}

/*
 * ===========================================================================
 * Section C — the factory
 * ===========================================================================
 */

/**
 * Build the DevTools panel's actions over injected dependencies.
 *
 * Pure: calling it reads nothing, sends nothing and cannot throw; every
 * dependency is used only when an action is invoked. Call it once per panel
 * document (the composition root memoizes it) so the returned identity stays
 * stable for the memoized renderer components it flows into.
 *
 * @param options The injected request function, session reader, store
 * dispatches and optional logger.
 * @returns A frozen view-form actions object; see {@link DevtoolsPanelActions}.
 */
export function createPanelActions(options: PanelActionsOptions): DevtoolsPanelActions {
  const { request, getSessionId, selectEvent, reportError, getLastError } = options;
  const log = options.logger ?? noopLogger;

  /**
   * The failure this instance surfaced most recently and has not yet seen
   * superseded — what a successful open may dismiss.
   */
  let surfaced: ErrorPayload | undefined;

  /** Record a failure in the store; a store that throws is logged, not rethrown. */
  const surface = (error: ErrorPayload): void => {
    surfaced = error;
    try {
      reportError(error);
    } catch (cause: unknown) {
      log.error('Surfacing a source-open failure in the panel failed.', {
        code: error.code,
        error: errorName(cause),
      });
    }
  };

  /**
   * After a successful open: dismiss the failure this instance surfaced, but
   * only while it is still the store's current one.
   */
  const dismissSurfaced = (): void => {
    const previous = surfaced;
    surfaced = undefined;
    if (previous === undefined || getLastError === undefined) {
      return;
    }
    try {
      const current = getLastError();
      if (current !== undefined && sameErrorRecord(current, previous)) {
        reportError(undefined);
      }
    } catch (cause: unknown) {
      log.error('Dismissing a resolved source-open failure failed.', { error: errorName(cause) });
    }
  };

  /** The worker answered: forwarded to the service, or not taken by its socket. */
  const onDelivered = (location: SourceLocation, response: SourceOpenResponsePayload): void => {
    if (response.forwarded) {
      log.debug('Forwarded a source-open request to the local service.');
      dismissSurfaced();
      return;
    }
    log.warn('The service worker could not forward a source-open request.', {
      code: 'TRANSPORT_DISCONNECTED',
    });
    surface(
      errorRecord(
        'TRANSPORT_DISCONNECTED',
        openFailureMessage(
          location,
          'the extension is not connected to the local Debug Generator service. Wait for the connection to return, then try again.',
        ),
      ),
    );
  };

  /**
   * The request was rejected, or an injected function threw. A rejection from
   * the panel connection is already a `DebuggenError` and keeps its own code;
   * `fallbackCode` classifies anything else.
   */
  const onFailed = (
    location: SourceLocation,
    cause: unknown,
    fallbackCode: DebuggenErrorCode,
  ): void => {
    const error = DebuggenError.from(cause, fallbackCode);
    log.warn('A source-open request failed.', {
      code: error.code,
      reason: failureReason(error),
    });
    surface(
      errorRecord(error.code, openFailureMessage(location, error.message), failureRef(error)),
    );
  };

  const onSelectEvent = (ref: PanelEventRef): void => {
    try {
      selectEvent(ref);
    } catch (cause: unknown) {
      log.error('Recording the selected event failed.', { error: errorName(cause) });
    }
  };

  const clearSelectedEvent = (): void => {
    try {
      selectEvent(undefined);
    } catch (cause: unknown) {
      log.error('Clearing the selected event failed.', { error: errorName(cause) });
    }
  };

  const onOpenSource = (location: SourceLocation): void => {
    let sessionId: SessionId | undefined;
    try {
      sessionId = getSessionId();
    } catch (cause: unknown) {
      // A failing session read is a panel fault, not a transport loss.
      onFailed(location, cause, 'INTERNAL');
      return;
    }

    if (sessionId === undefined) {
      log.warn('A source-open request needs a session, and this panel has none.', {
        code: 'TAB_NOT_BOUND',
      });
      surface(
        errorRecord(
          'TAB_NOT_BOUND',
          openFailureMessage(
            location,
            'this panel is not bound to a Debug Generator session. Start a session from the Debug Generator view in VS Code, then try again.',
          ),
        ),
      );
      return;
    }

    // The location travels by reference, untouched. The executor runs
    // synchronously, so the request is sent within the click, and a
    // synchronous throw from the injected function becomes a rejection handled
    // below like any other failure.
    const payload: SourceOpenRequestPayload = { sessionId, location };
    const delivery = new Promise<SourceOpenResponsePayload>((resolve) => {
      resolve(request('source.open', payload));
    });
    void delivery.then(
      (response) => {
        onDelivered(location, response);
      },
      (cause: unknown) => {
        onFailed(location, cause, 'TRANSPORT_DISCONNECTED');
      },
    );
  };

  return Object.freeze({ onSelectEvent, onOpenSource, clearSelectedEvent });
}
