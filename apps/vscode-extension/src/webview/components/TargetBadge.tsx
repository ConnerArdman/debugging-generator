/**
 * `TargetBadge` — the editor-side view of the element the developer selected in
 * the Chrome DevTools "Debug Generator" panel (AAP 0.7.3: "selected
 * element/component or 'No target'").
 *
 * ## What it renders
 *
 * The payload is a `SelectedTarget` (AAP 0.4.2) — the shape the DevTools panel
 * sends the service in `target.selected`, which reaches the editor as the
 * session record's `target` in `session.created`/`session.updated`:
 * `selector`, `tagName`, an optional visible `text` label, the React
 * `componentChain` above the element and the document `url`. Every value on
 * screen comes from that object and nothing else — this file holds no example
 * selector, component name or route (AAP 0.5.4).
 *
 *   - `tagName` as a soft accent `Badge`, beside the `selector` as monospace
 *     `Code`. The selector is shown byte-for-byte and in full: it wraps rather
 *     than truncating, because a clipped selector can name a different element
 *     than the one that was picked.
 *   - `text`, when the producer sent one, as secondary `Text`.
 *   - `componentChain` as an ordered list (`<ol>`), in the order given. The
 *     contract of `@debuggen/instrumentation`'s schema is **nearest-first** —
 *     index 0 is the closest composite component — so the list is labelled
 *     that way and is never reversed here. The list semantics are what convey
 *     the order to assistive technology; the `›` separators are decorative and
 *     `aria-hidden`. An empty chain is a valid, honest answer (a page without
 *     React, a node React never rendered, a production build), so it renders
 *     as a sentence saying so rather than as an empty list.
 *   - `url` as monospace `Code`, exactly as received.
 *   - A control that asks the DevTools panel bound to the session to enter
 *     picker mode again — or, when no pick can be requested, a muted note
 *     saying why in its place.
 *
 * ## When a pick can be requested (`pickAvailability`)
 *
 * A pick is asked of the DevTools panel bound to the running session, so it
 * needs a live session and a reachable local service. `App.tsx` reads which
 * of those holds from the snapshot and passes it as `pickAvailability`:
 * `available` (the default), `noSession`, `serviceUnavailable`, `ended` or
 * `failed`. Anything but `available` withholds every pick control — the pick,
 * the re-pick and the error state's retry — rather than offering one the host
 * could only refuse, and the component says why in words instead: the "No
 * target" state carries a sentence for that reason, and a selected target is
 * shown read-only with a short note where the re-pick control would be.
 *
 * ## States (AAP 0.5.5 — never a blank area)
 *
 * Precedence is error > pending > empty > data, so a failed pick is never
 * masked by a stale target and a pick in flight never shows the target it is
 * about to replace:
 *
 *   1. `error` (non-blank) — `ErrorState` with that message, announced as an
 *      alert by the primitive, with a retry that requests a new pick while a
 *      pick is available.
 *   2. `pending` — `LoadingState` while the pick request is on its way to the
 *      bound DevTools panel and the host has not answered yet; the primitive
 *      owns `role="status"` and `aria-busy`.
 *   3. no `target` — the explicit "No target" `EmptyState`, whose action is the
 *      pick `Button` while a pick is available. `EmptyState` ships no copy of
 *      its own, so the wording is this component's, one sentence per
 *      availability, and it is deliberately generic.
 *   4. otherwise — the selected target.
 *
 * Every state carries the `dgv-target` root class plus `className`, on the
 * state primitive itself or on the root `Stack`, so a parent can place the
 * component without knowing which state it is in.
 *
 * ## Contract and boundaries
 *
 * Props in, one callback out: `onRequestTarget()` is invoked with no
 * arguments in both the no-target and target-present cases (pick versus
 * re-pick) and from the error state's retry, and never while
 * `pickAvailability` withholds the pick. The parent relays it to the host,
 * which calls the service's `target.request` operation; the service pushes
 * `target.request` to the DevTools panel bound to the session, and the host
 * answers with a notice saying the panel was asked to enter picker mode or why
 * it could not be asked. This component opens no socket, posts nothing to
 * the host and performs no request (the webview talks to the host only through
 * the typed union in `src/webview-messages.ts`, which `App` owns).
 *
 * `SelectedTarget` is imported as a type from the `@debuggen/protocol` barrel,
 * the single import site for it in this workspace, so the webview takes no
 * dependency on `@debuggen/instrumentation` and redeclares no shape.
 *
 * ## Privacy (AAP 0.5.2)
 *
 * `url` arrives query-redacted and `text` arrives scrubbed and truncated by the
 * producer. Both are rendered as given: nothing here redacts again, rebuilds a
 * URL, decodes a value or writes any of it to a log.
 *
 * ## Styling (AAP 0.6.4)
 *
 * Design-system primitives only (`Badge`, `Code`, `Text`, `Button`,
 * `EmptyState`, `LoadingState`, `ErrorState`) with every spacing decision made
 * by `Stack`. The only raw elements are the `<ol>`/`<li>` of the component
 * chain and its decorative separator, styled by the `dgv-target__*` block of
 * `../styles.css`. No inline style, no hardcoded value, no heading element —
 * the surrounding section owns the document outline.
 */

import {
  Badge,
  Button,
  Code,
  EmptyState,
  ErrorState,
  LoadingState,
  Stack,
  Text,
} from '@debuggen/panel-renderer';
import type { SelectedTarget } from '@debuggen/protocol';
import { assertNever } from '@debuggen/shared';
import { useId } from 'react';
import type { ReactElement } from 'react';

/**
 * Whether the view can ask for a pick now, and if not, why — as `App.tsx`
 * reads it from the host's snapshot.
 *
 * - `available` — a session is running and the local service is reachable.
 * - `noSession` — no session exists yet, so there is no bound panel to ask.
 * - `serviceUnavailable` — the local service is not reachable, so the request
 *   could not be delivered.
 * - `ended` — the session has ended; its target, if any, is history.
 * - `failed` — the session stopped at a failed stage.
 */
export type TargetPickAvailability =
  'available' | 'noSession' | 'serviceUnavailable' | 'ended' | 'failed';

/** Root class of every state; declared in `../styles.css`. */
const ROOT_CLASS = 'dgv-target';

/** The ordered component list and its entries; declared in `../styles.css`. */
const CHAIN_CLASS = 'dgv-target__chain';
const CHAIN_ITEM_CLASS = 'dgv-target__chain-item';
const CHAIN_SEPARATOR_CLASS = 'dgv-target__chain-separator';

/** Visible between two chain entries; decorative, hidden from assistive technology. */
const CHAIN_SEPARATOR = '›';

/** Title of the no-target state, in the wording AAP 0.7.3 uses. */
const NO_TARGET_TITLE = 'No target';

/**
 * Body of the no-target state. Generic by construction: it names the product's
 * own surfaces and nothing about any application under investigation.
 */
const NO_TARGET_MESSAGE =
  'No element is selected, so questions are investigated from the current page. "Pick element" puts the Debug Generator panel in Chrome DevTools into picker mode, so you can click the element to focus on.';

/**
 * Bodies of the no-target state while no pick can be requested, one per
 * {@link TargetPickAvailability} other than `available`. Each says why the
 * pick control is absent and what makes it available; generic product copy.
 */
const NO_TARGET_NO_SESSION_MESSAGE =
  'No element is selected. Once a session is running, "Pick element" puts the Debug Generator panel in Chrome DevTools into picker mode, so you can click the element to focus on.';
const NO_TARGET_SERVICE_MESSAGE =
  'No element is selected. Picking one needs the local Debug Generator service; start it, and "Pick element" returns here.';
const NO_TARGET_ENDED_MESSAGE = 'No element was selected for this session, which has ended.';
const NO_TARGET_FAILED_MESSAGE =
  'No element is selected. This session stopped at a failed stage; ask a new question to start another session.';

/**
 * Shown under a selected target, in place of the re-pick control, while no
 * pick can be requested — one per {@link TargetPickAvailability} other than
 * `available`. Generic product copy.
 */
const TARGET_NO_SESSION_NOTE =
  'Picking another element becomes possible once a session is running.';
const TARGET_SERVICE_NOTE =
  'Picking another element needs the local Debug Generator service; start it to pick again.';
const TARGET_ENDED_NOTE = 'Selected for this session, which has ended.';
const TARGET_FAILED_NOTE = 'Selected for this session, which stopped at a failed stage.';

/** Accessible name and label of the pick control when no target exists. */
const PICK_LABEL = 'Pick element';

/** Accessible name and label of the pick control when a target is shown. */
const REPICK_LABEL = 'Pick another element';

/**
 * Announced by `LoadingState` while the pick request is being sent (it appends
 * the ellipsis). The request only switches the panel into picker mode, so the
 * label never claims an element is being picked.
 */
const PENDING_LABEL = 'Asking Chrome DevTools to enter picker mode';

/** Skeleton rows while pending: one for the element line, one for the chain. */
const PENDING_ROWS = 2;

/** Title of the error state, replacing the primitive's data-loading default. */
const ERROR_TITLE = 'Could not select a target';

/** Label of the error state's retry, which requests a new pick. */
const RETRY_LABEL = 'Pick element again';

/** Visible name of the component list, which also labels the `<ol>`. */
const CHAIN_LABEL = 'Components, nearest first';

/** Shown instead of the list when the producer found no component above the element. */
const NO_CHAIN_MESSAGE = 'No React component information for this element.';

/** Visible label of the document URL row. */
const URL_LABEL = 'Page';

/**
 * Inputs of {@link TargetBadge}.
 *
 * Every optional property admits `undefined` explicitly: the repository runs
 * with `exactOptionalPropertyTypes`, and a parent routinely forwards values it
 * derived as possibly-undefined (the session's current target, the last pick
 * error).
 */
export interface TargetBadgeProps {
  /**
   * The element selected in the DevTools panel, as the session record's
   * `target` carries it in `session.created`/`session.updated`. Absent when
   * nothing has been picked, which renders the "No target" state.
   */
  target?: SelectedTarget | undefined;

  /**
   * Asks for a new pick: the host calls the service's `target.request`
   * operation, and the service pushes `target.request` to the DevTools panel
   * bound to the session, which enters picker mode. Called with no arguments,
   * from the no-target action, the re-pick control and the error state's retry.
   */
  onRequestTarget: () => void;

  /**
   * The pick request has been sent and the host has not answered it yet.
   * Takes precedence over `target` and the no-target state, and yields to
   * `error`.
   *
   * @default false
   */
  pending?: boolean | undefined;

  /**
   * Why the last pick failed. A non-blank value renders the error state, which
   * takes precedence over every other state; a blank one is ignored.
   */
  error?: string | undefined;

  /**
   * Whether a pick can be requested now, as the parent reads it from the
   * session and the service connection. Anything but `available` renders no
   * pick, re-pick or retry control and says why instead: the no-target state
   * with a sentence for the reason, a selected target read-only with a note.
   *
   * @default 'available'
   */
  pickAvailability?: TargetPickAvailability | undefined;

  /** Extra classes for the root element, appended after `dgv-target`. */
  className?: string | undefined;
}

/** How one {@link TargetPickAvailability} presents: its control and its copy. */
interface PickPresentation {
  /** Whether the pick, re-pick and retry controls render. */
  readonly canPick: boolean;
  /** The body of the "No target" state. */
  readonly noTargetMessage: string;
  /** The note shown in place of the re-pick control; absent while a pick is possible. */
  readonly targetNote: string | undefined;
}

/**
 * What each pick availability renders. Closed by `assertNever`, so an
 * availability added to {@link TargetPickAvailability} is a compile error here
 * until it says what it looks like.
 *
 * @param availability Whether, and why not, a pick can be requested.
 * @returns Whether the controls render, and the copy that stands in for them.
 */
function describePickAvailability(availability: TargetPickAvailability): PickPresentation {
  switch (availability) {
    case 'available':
      return { canPick: true, noTargetMessage: NO_TARGET_MESSAGE, targetNote: undefined };
    case 'noSession':
      return {
        canPick: false,
        noTargetMessage: NO_TARGET_NO_SESSION_MESSAGE,
        targetNote: TARGET_NO_SESSION_NOTE,
      };
    case 'serviceUnavailable':
      return {
        canPick: false,
        noTargetMessage: NO_TARGET_SERVICE_MESSAGE,
        targetNote: TARGET_SERVICE_NOTE,
      };
    case 'ended':
      return {
        canPick: false,
        noTargetMessage: NO_TARGET_ENDED_MESSAGE,
        targetNote: TARGET_ENDED_NOTE,
      };
    case 'failed':
      return {
        canPick: false,
        noTargetMessage: NO_TARGET_FAILED_MESSAGE,
        targetNote: TARGET_FAILED_NOTE,
      };
    default:
      return assertNever(availability, 'Unhandled target pick availability');
  }
}

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
 * Joins class names, dropping absent and blank entries. `clsx` is not a
 * dependency of this workspace, and two optional parts need nothing more.
 *
 * @param parts Class names in order; `undefined` entries are skipped.
 * @returns A space-separated class list.
 */
function joinClassNames(...parts: ReadonlyArray<string | undefined>): string {
  return parts.filter(hasText).join(' ');
}

/** Inputs of the target-present view. */
interface SelectedTargetViewProps {
  readonly target: SelectedTarget;
  /** Requests a re-pick; `undefined` while no pick can be requested. */
  readonly onPick: (() => void) | undefined;
  /** Why no pick can be requested, shown in place of the re-pick control. */
  readonly note: string | undefined;
  readonly className: string;
}

/**
 * The selected element: identity row, visible text, component chain, page URL
 * and the re-pick control — or, while no pick can be requested, the note that
 * says why — stacked in that order.
 *
 * A separate component so that its `useId` call is unconditional — the parent
 * returns early for the three other states.
 *
 * @param props See {@link SelectedTargetViewProps}.
 * @returns The root `Stack` of the target-present state.
 */
function SelectedTargetView(props: SelectedTargetViewProps): ReactElement {
  const { target, onPick, note, className } = props;
  const chainLabelId = useId();

  // Blank entries cannot occur in a schema-valid target; dropping them keeps a
  // malformed one from rendering empty chips while preserving the given order.
  const chain = target.componentChain.filter((name) => hasText(name));

  return (
    <Stack gap={2} className={className}>
      <Stack direction="horizontal" wrap gap={2} align="center">
        <Badge variant="soft" tone="accent">
          {target.tagName}
        </Badge>
        <Code size="sm" wrap>
          {target.selector}
        </Code>
      </Stack>

      {hasText(target.text) ? (
        <Text as="p" size="sm" tone="secondary">
          {target.text}
        </Text>
      ) : null}

      {chain.length > 0 ? (
        <Stack gap={1}>
          <Text as="p" id={chainLabelId} size="xs" tone="muted">
            {CHAIN_LABEL}
          </Text>
          <ol className={CHAIN_CLASS} aria-labelledby={chainLabelId}>
            {chain.map((name, index) => (
              // The index is part of the key because display names repeat
              // legitimately (two anonymous wrappers, a recursive component).
              // `title` sits on the chip rather than the item so it exposes a
              // name the item's ellipsis has clipped without also becoming the
              // list item's accessible name.
              <li key={`${String(index)}:${name}`} className={CHAIN_ITEM_CLASS}>
                {index > 0 ? (
                  <span className={CHAIN_SEPARATOR_CLASS} aria-hidden="true">
                    {CHAIN_SEPARATOR}
                  </span>
                ) : null}
                <Code size="sm" title={name}>
                  {name}
                </Code>
              </li>
            ))}
          </ol>
        </Stack>
      ) : (
        <Text as="p" size="xs" tone="muted">
          {NO_CHAIN_MESSAGE}
        </Text>
      )}

      <Stack direction="horizontal" wrap gap={2} align="baseline">
        <Text size="xs" tone="muted">
          {URL_LABEL}
        </Text>
        <Code size="sm" wrap>
          {target.url}
        </Code>
      </Stack>

      {onPick === undefined ? (
        // Read-only: no control that the host could only refuse, and the
        // reason in words where the control would be.
        hasText(note) ? (
          <Text as="p" size="xs" tone="muted">
            {note}
          </Text>
        ) : null
      ) : (
        // A row of its own so the control keeps its intrinsic width instead of
        // stretching across the column the outer Stack lays out.
        <Stack direction="horizontal" gap={2}>
          <Button variant="ghost" size="sm" onClick={onPick}>
            {REPICK_LABEL}
          </Button>
        </Stack>
      )}
    </Stack>
  );
}

/**
 * Renders the selected DevTools target, or the pending, error or "No target"
 * state, with a control that requests a new pick while one can be requested
 * and the reason in words while one cannot.
 *
 * @param props See {@link TargetBadgeProps}.
 * @returns The component's root in its current state.
 *
 * @example
 * <TargetBadge
 *   target={session.target}
 *   pending={pickPending}
 *   error={pickError}
 *   pickAvailability={session.status === 'ended' ? 'ended' : 'available'}
 *   onRequestTarget={requestTarget}
 * />
 */
export function TargetBadge(props: TargetBadgeProps): ReactElement {
  const {
    target,
    onRequestTarget,
    pending = false,
    error,
    pickAvailability = 'available',
    className,
  } = props;
  const rootClassName = joinClassNames(ROOT_CLASS, className);
  const presentation = describePickAvailability(pickAvailability);

  // Wrapped so the callback is invoked with no arguments: the primitives hand
  // their click handlers a React event, which is not part of this contract.
  // Absent while no pick can be requested, so no state renders a control the
  // host could only refuse.
  const requestTarget = presentation.canPick
    ? (): void => {
        onRequestTarget();
      }
    : undefined;

  if (hasText(error)) {
    return (
      <ErrorState
        className={rootClassName}
        title={ERROR_TITLE}
        message={error}
        onRetry={requestTarget}
        retryLabel={requestTarget === undefined ? undefined : RETRY_LABEL}
      />
    );
  }

  if (pending) {
    return (
      <LoadingState
        className={rootClassName}
        variant="rows"
        rows={PENDING_ROWS}
        label={PENDING_LABEL}
      />
    );
  }

  if (target === undefined) {
    return (
      <EmptyState
        className={rootClassName}
        title={NO_TARGET_TITLE}
        message={presentation.noTargetMessage}
        action={
          requestTarget === undefined ? undefined : (
            <Button variant="secondary" size="sm" onClick={requestTarget}>
              {PICK_LABEL}
            </Button>
          )
        }
      />
    );
  }

  return (
    <SelectedTargetView
      target={target}
      onPick={requestTarget}
      note={presentation.targetNote}
      className={rootClassName}
    />
  );
}
