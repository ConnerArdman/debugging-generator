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
 * - Reading the Elements panel's selection is the devtools page's job
 *   (AAP 0.1.1, 0.7.1 Group 4). This file never evaluates anything in the
 *   inspected page and calls no `chrome.devtools` method: a second copy of that
 *   evaluation would drift from the one that matters, and would put a
 *   DevTools-only API into a document that must render without DevTools.
 *
 * ## Rendering without DevTools (AAP 0.8.3)
 *
 * `tests/browser/panel-render.spec.ts` opens `panel.html` as a plain extension
 * page, where `chrome.devtools` is undefined. The composition root normally
 * says whether DevTools is present through `devtoolsAvailable`; only when it
 * does not, a defensive read decides — a `typeof` guard on `chrome`, then the
 * store's own never-throwing `readInspectedTabId`, which reads properties and
 * calls nothing. Absent DevTools, both controls render unavailable with a
 * `Tooltip` saying why; nothing throws and nothing blanks.
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
 * `selector` and the `url` byte-for-byte in `Code`, the optional visible `text`
 * as single-line `Text` with the full value in its `title`, and the
 * `componentChain` — the React owner chain, nearest first — in the array's own
 * order with decorative separators. An absent `text` renders nothing; an empty
 * chain is the honest "no component information" answer and says so.
 *
 * The descriptor arrives already redacted (AAP 0.5.2): it is rendered as given,
 * never redacted again, rebuilt, decoded or logged.
 *
 * ## Failures belong to the caller
 *
 * A callback may return a promise. While it is pending the control reports
 * `aria-busy` and ignores further presses; when it settles either way the
 * control is operable again. A rejection is not caught here: it is re-surfaced
 * unchanged to the composition root, which owns error presentation — this
 * component neither swallows it nor renders an error of its own.
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

import { readInspectedTabId } from '../state/connection';

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
   * Whether the panel is hosted by DevTools, as the composition root knows it.
   * When omitted, a defensive local read of `chrome.devtools` decides.
   */
  devtoolsAvailable?: boolean | undefined;

  /**
   * An element-targeting request the caller tracks is in flight: both controls
   * report `aria-busy` and ignore presses until it clears.
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
 * The `chrome.devtools` namespace when this document has one, else `undefined`.
 *
 * AAP 0.8.3: `tests/browser/panel-render.spec.ts` opens `panel.html` as a plain
 * extension page, where `chrome.devtools` is undefined, and a unit suite may run
 * with no `chrome` global at all — hence the `typeof` guard before any read.
 * Only properties are read, by {@link readInspectedTabId}; nothing is called.
 */
function readChromeDevtools(): unknown {
  return typeof chrome === 'undefined' ? undefined : chrome.devtools;
}

/**
 * The fallback answer to "is this panel hosted by DevTools": only when an
 * inspected tab id can be read. Never throws — `readInspectedTabId` treats a
 * missing or throwing API as absent.
 */
function detectDevtoolsAvailable(): boolean {
  return readInspectedTabId(readChromeDevtools) !== undefined;
}

/** A control's callback, tracked while the promise it returned is pending. */
interface TrackedAction {
  /** Whether a promise returned by the callback has not settled yet. */
  readonly pending: boolean;
  /** Invokes the callback unless blocked or already in flight. */
  readonly run: () => void;
}

/**
 * Tracks one control's callback so the control can report `aria-busy` while
 * the promise it returned is pending, and ignore presses meanwhile.
 *
 * The in-flight flag is a ref as well as state: two presses within one frame
 * both run before React re-renders, and the second must see the first.
 *
 * A synchronous throw propagates out of the handler untouched. A rejection is
 * re-surfaced, not caught: `finally` clears the busy state and hands back a
 * promise that rejects with the caller's own reason, so an error the caller
 * did not handle reaches the document exactly as it would without this
 * component in between.
 *
 * @param action The injected callback.
 * @param blocked Whether presses are currently refused (unavailable or busy).
 * @returns The pending flag and the guarded handler.
 */
function useTrackedAction(action: () => Promise<void> | void, blocked: boolean): TrackedAction {
  const [pending, setPending] = useState(false);
  const inFlightRef = useRef(false);

  const run = useCallback(() => {
    if (blocked || inFlightRef.current) {
      return;
    }
    const outcome = action();
    if (!isPromiseLike(outcome)) {
      return;
    }
    inFlightRef.current = true;
    setPending(true);
    const settle = (): void => {
      inFlightRef.current = false;
      setPending(false);
    };
    void Promise.resolve(outcome).finally(settle);
  }, [action, blocked]);

  return { pending, run };
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
 *   target={snapshot.target.pending ?? snapshot.session?.target}
 *   pickerActive={pickerActive}
 *   onPick={togglePicker}
 *   onUseSelected={applySelectedElement}
 * />
 */
export function TargetPicker(props: TargetPickerProps): ReactElement {
  const {
    target,
    pickerActive,
    onPick,
    onUseSelected,
    devtoolsAvailable,
    busy = false,
    className,
  } = props;

  // The composition root's answer wins; the defensive read is the fallback only.
  const available = devtoolsAvailable ?? detectDevtoolsAvailable();
  const blocked = !available || busy;

  const pickAction = useTrackedAction(onPick, blocked);
  const selectedAction = useTrackedAction(onUseSelected, blocked);

  return (
    <Stack direction="horizontal" gap={2} align="center" wrap className={className}>
      <Tooltip content={available ? PICK_DESCRIPTION : UNAVAILABLE_DESCRIPTION}>
        <Button
          variant="secondary"
          size="sm"
          aria-pressed={pickerActive}
          aria-disabled={available ? undefined : true}
          aria-busy={available && (busy || pickAction.pending) ? true : undefined}
          className={joinClassNames(
            pickerActive && ACTIVE_STATE_CLASS,
            !available && DISABLED_STATE_CLASS,
          )}
          onClick={pickAction.run}
        >
          {PICK_LABEL}
        </Button>
      </Tooltip>

      <Tooltip content={available ? USE_SELECTED_DESCRIPTION : UNAVAILABLE_DESCRIPTION}>
        <Button
          variant="secondary"
          size="sm"
          aria-disabled={available ? undefined : true}
          aria-busy={available && (busy || selectedAction.pending) ? true : undefined}
          className={joinClassNames(!available && DISABLED_STATE_CLASS)}
          onClick={selectedAction.run}
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
        {pickerActive ? PICKER_ON_ANNOUNCEMENT : ''}
      </Text>

      {target === undefined ? (
        <Badge tone="neutral">{NO_TARGET_LABEL}</Badge>
      ) : (
        <TargetDescriptor target={target} />
      )}
    </Stack>
  );
}
