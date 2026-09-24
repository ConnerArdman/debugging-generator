/**
 * `TargetBadge` — the editor-side view of the element the developer selected in
 * the Chrome DevTools "Debug Generator" panel (AAP 0.7.3: "selected
 * element/component or 'No target'").
 *
 * ## What it renders
 *
 * The payload is the `SelectedTarget` that `target.selected` carries (AAP
 * 0.4.2): `selector`, `tagName`, an optional visible `text` label, the React
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
 *   - A control that asks the DevTools panel to enter picker mode again.
 *
 * ## States (AAP 0.5.5 — never a blank area)
 *
 * Precedence is error > pending > empty > data, so a failed pick is never
 * masked by a stale target and a pick in flight never shows the target it is
 * about to replace:
 *
 *   1. `error` (non-blank) — `ErrorState` with that message, announced as an
 *      alert by the primitive, with a retry that requests a new pick.
 *   2. `pending` — `LoadingState` while a pick is requested and awaited; the
 *      primitive owns `role="status"` and `aria-busy`.
 *   3. no `target` — the explicit "No target" `EmptyState`, whose action is the
 *      pick `Button`. `EmptyState` ships no copy of its own, so the wording is
 *      this component's, and it is deliberately generic.
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
 * re-pick) and from the error state's retry. The parent relays it through the
 * host to the service, which sends `target.request` to the DevTools panel
 * bound to the session; this component opens no socket, posts nothing to
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
import { useId } from 'react';
import type { ReactElement } from 'react';

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
  'No element is selected, so questions are investigated from the current page. Pick an element in the Debug Generator panel in Chrome DevTools to focus on it.';

/** Accessible name and label of the pick control when no target exists. */
const PICK_LABEL = 'Pick element';

/** Accessible name and label of the pick control when a target is shown. */
const REPICK_LABEL = 'Pick another element';

/** Announced by `LoadingState` while a pick is awaited (it appends the ellipsis). */
const PENDING_LABEL = 'Waiting for an element to be picked in Chrome DevTools';

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
   * The element selected in the DevTools panel, as `target.selected` delivered
   * it. Absent when nothing has been picked, which renders the "No target"
   * state.
   */
  target?: SelectedTarget | undefined;

  /**
   * Asks for a new pick — relayed until the service sends `target.request` and
   * the DevTools panel enters picker mode. Called with no arguments, from the
   * no-target action,
   * the re-pick control and the error state's retry.
   */
  onRequestTarget: () => void;

  /**
   * A pick has been requested and its result is awaited. Takes precedence over
   * `target` and the no-target state, and yields to `error`.
   *
   * @default false
   */
  pending?: boolean | undefined;

  /**
   * Why the last pick failed. A non-blank value renders the error state, which
   * takes precedence over every other state; a blank one is ignored.
   */
  error?: string | undefined;

  /** Extra classes for the root element, appended after `dgv-target`. */
  className?: string | undefined;
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
  readonly onPick: () => void;
  readonly className: string;
}

/**
 * The selected element: identity row, visible text, component chain, page URL
 * and the re-pick control, stacked in that order.
 *
 * A separate component so that its `useId` call is unconditional — the parent
 * returns early for the three other states.
 *
 * @param props See {@link SelectedTargetViewProps}.
 * @returns The root `Stack` of the target-present state.
 */
function SelectedTargetView(props: SelectedTargetViewProps): ReactElement {
  const { target, onPick, className } = props;
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

      {/* A row of its own so the control keeps its intrinsic width instead of
          stretching across the column the outer Stack lays out. */}
      <Stack direction="horizontal" gap={2}>
        <Button variant="ghost" size="sm" onClick={onPick}>
          {REPICK_LABEL}
        </Button>
      </Stack>
    </Stack>
  );
}

/**
 * Renders the selected DevTools target, or the pending, error or "No target"
 * state, with a control that requests a new pick.
 *
 * @param props See {@link TargetBadgeProps}.
 * @returns The component's root in its current state.
 *
 * @example
 * <TargetBadge
 *   target={session.target}
 *   pending={pickPending}
 *   error={pickError}
 *   onRequestTarget={requestTarget}
 * />
 */
export function TargetBadge(props: TargetBadgeProps): ReactElement {
  const { target, onRequestTarget, pending = false, error, className } = props;
  const rootClassName = joinClassNames(ROOT_CLASS, className);

  // Wrapped so the callback is invoked with no arguments: the primitives hand
  // their click handlers a React event, which is not part of this contract.
  const requestTarget = (): void => {
    onRequestTarget();
  };

  if (hasText(error)) {
    return (
      <ErrorState
        className={rootClassName}
        title={ERROR_TITLE}
        message={error}
        onRetry={requestTarget}
        retryLabel={RETRY_LABEL}
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
        message={NO_TARGET_MESSAGE}
        action={
          <Button variant="secondary" size="sm" onClick={requestTarget}>
            {PICK_LABEL}
          </Button>
        }
      />
    );
  }

  return <SelectedTargetView target={target} onPick={requestTarget} className={rootClassName} />;
}
