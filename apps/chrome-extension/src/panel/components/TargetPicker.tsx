/**
 * `TargetPicker` — the header's element-targeting controls in the "Debug
 * Generator" DevTools panel (AAP 0.7.3: "'Pick element' toggles picker mode;
 * 'Use selected element' reads" the Elements panel's current selection), plus
 * the descriptor of whatever element is the session's target right now.
 *
 * ## Two routes into picker mode, one prop
 *
 * Picker mode is entered either by the developer pressing "Pick element" or by
 * the service asking for it (the relayed `target.request` push of AAP 0.4.2,
 * which the store records as `PanelTargetSlice.pickRequested`). Both arrive
 * here as the single `pickerActive` prop, and this component keeps no picker
 * state of its own — which is precisely what makes the two routes agree: the
 * toggle shows the same pressed state whichever of them turned it on.
 *
 * ## What happens on a click, and what does not happen here
 *
 * - "Pick element" calls `onPick`; "Use selected element" calls
 *   `onUseSelected`. The composition root binds them to the worker's
 *   `target.pick` and `target.selected` port requests. This file opens no port,
 *   no socket and no HTTP request, and writes nothing to the panel store.
 * - Reading the Elements panel's selection is not this component's job
 *   (AAP 0.1.1, 0.7.1 Group 4). This file never evaluates anything in the
 *   inspected page and reads no `chrome` global at all: the composition root
 *   owns host detection and the evaluation, so this component renders the same
 *   way in DevTools, in a plain extension page and under a unit test.
 *
 * ## When the controls are unavailable
 *
 * Two facts the composition root knows decide it, in this order, and each has
 * its own `Tooltip` explanation:
 *
 * 1. **DevTools is absent** (`devtoolsAvailable` false). AAP 0.8.3:
 *    `tests/browser/panel-render.spec.ts` opens `panel.html` as a plain
 *    extension page, where `chrome.devtools` is undefined; nothing throws and
 *    nothing blanks.
 * 2. **No session is bound to the inspected tab** (`sessionBound` false). Both
 *    requests address the bound session, and the worker refuses either one
 *    for a tab no session holds, so pressing them could only fail. The
 *    tooltip says what to do instead.
 *
 * ## One element-targeting request at a time
 *
 * "Pick element" and "Use selected element" both change the session's target,
 * so they share a single in-flight state: while a promise returned by either
 * callback is pending, **both** controls are unavailable, report `aria-busy`
 * and ignore presses, and the status region announces the wait. Neither can
 * race the other, and the sibling of the pressed control says so too. The
 * in-flight flag is a ref as well as state: two presses within one frame both
 * run before React re-renders, and the second must see the first.
 *
 * A request can also outlive the promise its callback returned: "Use selected
 * element" resolves on the service's verdict, but the optimistic pick stays on
 * screen until the session record confirming it reaches the store. The
 * composition root tracks that wait and passes it as the `busy` prop, which
 * puts both controls in the same busy state. The two sources are combined,
 * never substituted: the controls are busy while either one says so, and this
 * component clears only the state it tracks itself.
 *
 * ## Unavailable controls stay reachable
 *
 * A natively `disabled` button leaves the tab order, so a keyboard user could
 * never focus it and the tooltip carrying its reason would never open. The
 * unavailable controls are therefore `aria-disabled` — still focusable, still
 * described by the tooltip through its merged `aria-describedby` — and their
 * click handler is guarded, so Enter, Space and a pointer all do nothing. Their
 * appearance is the design system's own disabled treatment, reached through
 * the `dg-is-disabled` state class that `Button`'s class contract declares and
 * `components.css` implements (`.dg-button.dg-is-disabled`), coupled to the
 * real `aria-disabled` state — no class of this file's invention and no
 * variant swap. The pressed toggle likewise takes the stylesheet's
 * `dg-is-active` state beside `aria-pressed`, as the renderer's own toolbar
 * toggles do.
 *
 * ## Status is never colour alone (AAP 0.6.4)
 *
 * While picker mode is on, a "Picker on" badge spells it out beside the pressed
 * surface, and a visually hidden polite status region announces the change —
 * the only way a screen-reader user learns that the service switched picker
 * mode on while focus was elsewhere. The visible badge is hidden from
 * assistive technology so that the state is announced once.
 *
 * ## The descriptor
 *
 * Every value comes from the `SelectedTarget` the service confirmed or the
 * panel optimistically picked, and nothing else: `tagName` as a `Badge`, the
 * `selector` and the `url` as given in `Code`, the optional visible `text` as
 * single-line `Text` with the full value in its `title`, and the
 * `componentChain` — the React owner chain, nearest first — in the array's own
 * order with decorative separators. An absent `text` renders nothing; an empty
 * chain is the honest "no component information" answer and says so.
 *
 * The composition root hands this component a descriptor that is already
 * bounded by the shared `$0` descriptor parser and prepared for display
 * (AAP 0.5.2): credential shapes are removed from every page-controlled field —
 * `text`, `selector`, `tagName`, each component name, and the URL's userinfo,
 * path and query keys — and query values and the fragment are masked. It is
 * rendered as given, never redacted again, rebuilt, decoded or logged here.
 *
 * ## Failures belong to the caller
 *
 * A callback may return a promise. When it settles either way the controls are
 * operable again. A synchronous throw or a rejection is handed, with the
 * control that raised it, to `onActionError` — the composition root's error
 * sink — and to nothing else: no detached promise is left rejecting, so the
 * document never sees an unhandled rejection, and this component renders no
 * error of its own.
 *
 * ## Design-system compliance (AAP 0.6.4)
 *
 * `Button`, `Tooltip`, `Badge`, `Code` and `Text` for every element, `Stack`
 * for every gap and alignment. No inline style, no length, no colour, no CSS
 * file; the only class names written here are the design system's declared
 * state classes and its `dg-visually-hidden` utility. All copy is generic
 * product vocabulary and names nothing from any inspected application
 * (AAP 0.5.4).
 *
 * @module apps/chrome-extension/src/panel/components/TargetPicker
 */
import { Badge, Button, Code, Stack, Text, Tooltip } from '@debuggen/panel-renderer';
import type { SelectedTarget } from '@debuggen/protocol';
import { useCallback, useRef, useState } from 'react';
import type { ReactElement } from 'react';

/*
 * ===========================================================================
 * Copy — the panel's own wording for these controls
 * ===========================================================================
 */

/** The toggle's name. Constant on purpose: a toggle's pressed state, not its label, says whether it is on. */
const PICK_LABEL = 'Pick element';

/** What the toggle does, shown in its tooltip while DevTools is available. */
const PICK_DESCRIPTION =
  "Turns picker mode on or off. While it is on, the element you select next in the Elements panel becomes the session's target.";

/** The one-shot control's name. */
const USE_SELECTED_LABEL = 'Use selected element';

/** What the one-shot control does, shown in its tooltip while DevTools is available. */
const USE_SELECTED_DESCRIPTION =
  "Uses the element currently selected in the Elements panel as the session's target.";

/** Why both controls are unavailable when the panel is not hosted by DevTools. */
const UNAVAILABLE_DESCRIPTION =
  'Element selection needs the Debug Generator panel in Chrome DevTools. Open DevTools on the page you are debugging and choose the Debug Generator tab.';

/** Why both controls are unavailable while no session is bound to the inspected tab. */
const NO_SESSION_DESCRIPTION =
  'Element selection needs a Debug Generator session bound to this tab. Start one from the Debug Generator view in VS Code; these controls become available once this panel is bound.';

/** Why both controls are unavailable while an element-targeting request is in flight. */
const BUSY_DESCRIPTION = 'Waiting for the current element-targeting request to finish.';

/** Announced politely while an element-targeting request is in flight. */
const BUSY_ANNOUNCEMENT = 'Updating the session target.';

/** The visible word for picker mode being on, beside the pressed surface. */
const PICKER_ON_LABEL = 'Picker on';

/** Announced politely when picker mode turns on, whichever route turned it on. */
const PICKER_ON_ANNOUNCEMENT = 'Picker mode on. Select an element in the Elements panel.';

/** Shown in place of a descriptor while the session has no target. */
const NO_TARGET_LABEL = 'No element selected';

/** Leads the descriptor, so it reads apart from the controls beside it. */
const TARGET_LABEL = 'Target';

/** Names the component chain and its order — the order the schema defines. */
const CHAIN_LABEL = 'Components, nearest first';

/** An empty chain: a page without React, a node React never rendered, or unreachable fibers. */
const NO_CHAIN_LABEL = 'No component information';

/** Names the document URL at the moment of selection. */
const URL_LABEL = 'Page';

/** Drawn between two chain entries; decorative and hidden from assistive technology. */
const CHAIN_SEPARATOR = '›';

/*
 * ===========================================================================
 * Design-system class names — declared by the renderer, never invented here
 * ===========================================================================
 */

/** `Button`'s pressed state (`.dg-button.dg-is-active` in `components.css`). */
const ACTIVE_STATE_CLASS = 'dg-is-active';

/** `Button`'s disabled treatment (`.dg-button.dg-is-disabled` in `components.css`). */
const DISABLED_STATE_CLASS = 'dg-is-disabled';

/** The global utility in `base.css` that keeps a live region's text announced but unpainted. */
const VISUALLY_HIDDEN_CLASS = 'dg-visually-hidden';

/*
 * ===========================================================================
 * Public API
 * ===========================================================================
 */

/** Which of the two controls raised a failure handed to `onActionError`. */
export type TargetPickerAction = 'pick' | 'useSelected';

/**
 * Props of {@link TargetPicker}.
 *
 * Optional members spell `| undefined` because `exactOptionalPropertyTypes` is
 * on repository-wide and the composition root forwards values it may not have.
 */
export interface TargetPickerProps {
  /**
   * The element that is the session's target: the optimistic pick while it
   * awaits confirmation, otherwise the confirmed `SessionRecord.target`.
   * `undefined` renders the "no element selected" indication.
   */
  target: SelectedTarget | undefined;

  /**
   * Whether picker mode is on — because the developer pressed "Pick element"
   * or because the service sent `target.request`. Rendered as the toggle's
   * `aria-pressed` and pressed surface, and as the "Picker on" badge.
   */
  pickerActive: boolean;

  /**
   * Toggles picker mode. The caller decides the new state from `pickerActive`
   * and relays it as the worker's `target.pick` request.
   */
  onPick: () => Promise<void> | void;

  /**
   * Makes the Elements panel's current selection the session's target,
   * relayed as the worker's `target.selected` request.
   */
  onUseSelected: () => Promise<void> | void;

  /**
   * Whether the panel is hosted by DevTools, as the composition root detected
   * it. `false` renders both controls unavailable with an explanation; this
   * component never reads a `chrome` global to find out for itself.
   */
  devtoolsAvailable: boolean;

  /**
   * Whether a session is bound to the inspected tab. Both requests address the
   * bound session, so `false` renders both controls unavailable with an
   * explanation of how to start one, instead of letting a press fail.
   */
  sessionBound: boolean;

  /**
   * The composition root's error sink: receives a callback's synchronous throw
   * or rejection, with the control that raised it. It must not throw. Nothing
   * else sees the failure — this component neither re-raises it nor renders it.
   */
  onActionError: (action: TargetPickerAction, cause: unknown) => void;

  /**
   * Whether an element-targeting request the composition root tracks is still
   * in flight after the callback's own promise settled — the optimistic pick
   * of "Use selected element" awaiting the session record that confirms it.
   * While `true`, both controls take the same busy state as for a pending
   * callback: `aria-busy`, unavailable, presses ignored, the wait announced.
   * The caller owns this flag and clears it; omitted, only the callbacks'
   * promises make the controls busy.
   *
   * @default false
   */
  busy?: boolean | undefined;

  /** Extra classes for the root `Stack`; a renderer class, never a visual value. */
  className?: string | undefined;
}

/*
 * ===========================================================================
 * Helpers
 * ===========================================================================
 */

/**
 * Whether a string carries something worth rendering.
 *
 * @param value A possibly-absent string.
 * @returns `true` for a string with at least one non-whitespace character.
 */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/**
 * Joins class names, dropping the ones a condition switched off.
 *
 * @param parts Class names, or `false` for a state that does not apply.
 * @returns A space-separated list, or `undefined` when nothing applies, so the
 *   element carries no empty `class` attribute.
 */
function joinClassNames(...parts: ReadonlyArray<string | false>): string | undefined {
  const joined = parts.filter((part): part is string => part !== false).join(' ');
  return joined === '' ? undefined : joined;
}

/**
 * Whether a callback's return value is a promise to wait for.
 *
 * @param value What the callback returned.
 * @returns `true` for any thenable.
 */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

/**
 * Why both controls are unavailable, or `undefined` when they can be used — in
 * the documented precedence: DevTools absent, then no bound session.
 *
 * @param devtoolsAvailable Whether DevTools hosts the panel.
 * @param sessionBound Whether a session is bound to the inspected tab.
 */
function unavailableReason(devtoolsAvailable: boolean, sessionBound: boolean): string | undefined {
  if (!devtoolsAvailable) {
    return UNAVAILABLE_DESCRIPTION;
  }
  if (!sessionBound) {
    return NO_SESSION_DESCRIPTION;
  }
  return undefined;
}

/** The one in-flight element-targeting request both controls share. */
interface SharedTargetAction {
  /** The control whose returned promise has not settled yet, or `undefined`. */
  readonly running: TargetPickerAction | undefined;
  /** Invokes `callback` for `action` unless unavailable or a request is in flight. */
  readonly run: (action: TargetPickerAction, callback: () => Promise<void> | void) => void;
}

/**
 * Tracks the element-targeting request of **both** controls in one state, so
 * that while a promise returned by either callback is pending, neither
 * control starts another one and both can say so.
 *
 * The in-flight flag is a ref as well as state: two presses within one frame
 * both run before React re-renders, and the second must see the first.
 *
 * Failures are settled here rather than re-raised: a synchronous throw, or a
 * rejection, is handed to `onActionError` with the control that raised it. The
 * returned promise is consumed with both `then` branches, so settling the
 * pending state never creates a second, detached promise that rejects — which
 * `finally` would, and which the document would report as an unhandled
 * rejection.
 *
 * @param unavailable Whether presses are refused regardless of this hook's own
 *   request: the controls are unavailable, or the caller tracks a request that
 *   is still in flight.
 * @param onActionError The composition root's error sink.
 * @returns The running control and the guarded invoker.
 */
function useSharedTargetAction(
  unavailable: boolean,
  onActionError: (action: TargetPickerAction, cause: unknown) => void,
): SharedTargetAction {
  const [running, setRunning] = useState<TargetPickerAction | undefined>(undefined);
  const inFlightRef = useRef(false);

  const run = useCallback(
    (action: TargetPickerAction, callback: () => Promise<void> | void): void => {
      if (unavailable || inFlightRef.current) {
        return;
      }
      let outcome: unknown;
      try {
        outcome = callback();
      } catch (cause: unknown) {
        onActionError(action, cause);
        return;
      }
      if (!isPromiseLike(outcome)) {
        return;
      }
      inFlightRef.current = true;
      setRunning(action);
      const settle = (): void => {
        inFlightRef.current = false;
        setRunning(undefined);
      };
      void Promise.resolve(outcome).then(settle, (cause: unknown) => {
        settle();
        onActionError(action, cause);
      });
    },
    [unavailable, onActionError],
  );

  return { running, run };
}

/*
 * ===========================================================================
 * The descriptor
 * ===========================================================================
 */

/** Props of {@link ComponentChain}. */
interface ComponentChainProps {
  /** Display names, nearest first, exactly as the descriptor carried them. */
  readonly chain: readonly string[];
}

/**
 * The React owner chain above the target, in the array's own order — never
 * reversed and never re-labelled. The separators are decorative; the label says
 * which end is nearest.
 */
function ComponentChain(props: ComponentChainProps): ReactElement {
  const { chain } = props;

  if (chain.length === 0) {
    return (
      <Text size="xs" tone="muted">
        {NO_CHAIN_LABEL}
      </Text>
    );
  }

  return (
    <Stack direction="horizontal" gap={1} align="center" wrap>
      <Text size="xs" tone="muted">
        {CHAIN_LABEL}
      </Text>
      {chain.map((name, index) => (
        // The index is part of the key: display names legitimately repeat (a
        // recursive component, two wrappers of one name).
        <Stack key={`${String(index)}:${name}`} direction="horizontal" gap={1} align="center">
          {index > 0 ? (
            <Text size="xs" tone="muted" aria-hidden="true">
              {CHAIN_SEPARATOR}
            </Text>
          ) : null}
          <Code size="sm">{name}</Code>
        </Stack>
      ))}
    </Stack>
  );
}

/** Props of {@link TargetDescriptor}. */
interface TargetDescriptorProps {
  /** The session's target. */
  readonly target: SelectedTarget;
}

/**
 * The target element: tag, selector, visible text when it has any, component
 * chain and page URL, in that order.
 */
function TargetDescriptor(props: TargetDescriptorProps): ReactElement {
  const { target } = props;
  // Blank names cannot occur in a schema-valid descriptor; dropping one keeps a
  // malformed entry from rendering an empty chip, and keeps the given order.
  const chain = target.componentChain.filter((name) => hasText(name));

  return (
    <Stack direction="horizontal" gap={2} align="center" wrap>
      <Text size="xs" tone="muted">
        {TARGET_LABEL}
      </Text>
      <Badge tone="accent">{target.tagName}</Badge>
      {/* In full and wrapping, never clipped: a shortened selector can name a
          different element than the one that was picked. */}
      <Code size="sm" wrap>
        {target.selector}
      </Code>
      {hasText(target.text) ? (
        <Text size="sm" tone="secondary" truncate title={target.text}>
          {target.text}
        </Text>
      ) : null}
      <ComponentChain chain={chain} />
      <Stack direction="horizontal" gap={1} align="center">
        <Text size="xs" tone="muted">
          {URL_LABEL}
        </Text>
        <Code size="sm" wrap>
          {target.url}
        </Code>
      </Stack>
    </Stack>
  );
}

/*
 * ===========================================================================
 * The component
 * ===========================================================================
 */

/**
 * Renders "Pick element" and "Use selected element", the picker-mode
 * indication, and the descriptor of the session's target.
 *
 * @param props See {@link TargetPickerProps}.
 * @returns A horizontal, wrapping row for the panel header.
 *
 * @example
 * // The composition root, reading the store and binding the port requests:
 * <TargetPicker
 *   target={displayTarget}
 *   pickerActive={snapshot.target.pickRequested}
 *   busy={snapshot.target.pending !== undefined}
 *   onPick={togglePicker}
 *   onUseSelected={adoptSelectedElement}
 *   devtoolsAvailable={devtoolsAvailable}
 *   sessionBound={snapshot.connection.binding.kind === 'bound'}
 *   onActionError={reportTargetActionFailure}
 * />
 */
export function TargetPicker(props: TargetPickerProps): ReactElement {
  const {
    target,
    pickerActive,
    onPick,
    onUseSelected,
    devtoolsAvailable,
    sessionBound,
    onActionError,
    busy: trackedByCaller = false,
    className,
  } = props;

  const reason = unavailableReason(devtoolsAvailable, sessionBound);
  const shared = useSharedTargetAction(reason !== undefined || trackedByCaller, onActionError);
  // Busy while either source says so: a callback's promise this component
  // tracks, or a request the composition root still tracks after it settled.
  const busy = shared.running !== undefined || trackedByCaller;
  // Unavailable for either cause, or waiting on a request of either control:
  // both controls take the same state, so neither invites a racing press.
  const blocked = reason !== undefined || busy;
  const { run } = shared;

  const handlePick = useCallback((): void => {
    run('pick', onPick);
  }, [run, onPick]);
  const handleUseSelected = useCallback((): void => {
    run('useSelected', onUseSelected);
  }, [run, onUseSelected]);

  const pickDescription = reason ?? (busy ? BUSY_DESCRIPTION : PICK_DESCRIPTION);
  const useSelectedDescription = reason ?? (busy ? BUSY_DESCRIPTION : USE_SELECTED_DESCRIPTION);
  let announcement = '';
  if (busy) {
    announcement = BUSY_ANNOUNCEMENT;
  } else if (pickerActive) {
    announcement = PICKER_ON_ANNOUNCEMENT;
  }

  return (
    <Stack direction="horizontal" gap={2} align="center" wrap className={className}>
      <Tooltip content={pickDescription}>
        <Button
          variant="secondary"
          size="sm"
          aria-pressed={pickerActive}
          aria-disabled={blocked ? true : undefined}
          aria-busy={busy ? true : undefined}
          className={joinClassNames(
            pickerActive && ACTIVE_STATE_CLASS,
            blocked && DISABLED_STATE_CLASS,
          )}
          onClick={handlePick}
        >
          {PICK_LABEL}
        </Button>
      </Tooltip>

      <Tooltip content={useSelectedDescription}>
        <Button
          variant="secondary"
          size="sm"
          aria-disabled={blocked ? true : undefined}
          aria-busy={busy ? true : undefined}
          className={joinClassNames(blocked && DISABLED_STATE_CLASS)}
          onClick={handleUseSelected}
        >
          {USE_SELECTED_LABEL}
        </Button>
      </Tooltip>

      {pickerActive ? (
        <Badge tone="accent" variant="outline" aria-hidden="true">
          {PICKER_ON_LABEL}
        </Badge>
      ) : null}

      {/* Always mounted, so a change of content is announced; out of flow, so
          it takes no gap in the row. */}
      <Text role="status" className={VISUALLY_HIDDEN_CLASS}>
        {announcement}
      </Text>

      {target === undefined ? (
        <Badge tone="neutral">{NO_TARGET_LABEL}</Badge>
      ) : (
        <TargetDescriptor target={target} />
      )}
    </Stack>
  );
}
