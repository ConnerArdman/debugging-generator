/**
 * `PairDialog` — the modal that takes the one-time pairing code shown in VS
 * Code and hands it to the service worker.
 *
 * ## Why this dialog exists
 *
 * The local service refuses every client that does not present a credential
 * (AAP 0.5.6), and a DevTools panel cannot read the editor's credential file.
 * The Chrome extension therefore pairs: the VS Code command "Pair Chrome
 * DevTools Panel" (`debuggen.pairChrome`) asks the service for a short-lived,
 * single-use code and shows it in the Debug Generator view; the developer types
 * that code **here**; the **service worker** redeems it with `POST
 * /pair/complete` from its own `chrome-extension://<id>` origin and keeps the
 * returned devtools credential in `chrome.storage.local`. AAP 0.7.3 puts this
 * dialog behind the connection pill's "Not paired" state.
 *
 * ## The security boundary this file keeps
 *
 * The split of duties *is* the security property: the panel knows the code,
 * the worker knows the token.
 *
 * - The only outbound call is the injected {@link PairDialogProps.submitCode}.
 *   The composition root binds it to the extension-internal `pair.complete`
 *   port request (`../../shared/messages`), whose success payload is
 *   `{ paired: true }` — no credential ever travels back to the panel, so this
 *   component cannot render, log or keep one. It opens no socket, performs no
 *   `fetch`, touches no `chrome.*` API and reads or writes no storage, which is
 *   also why it renders unchanged when the panel page is opened directly with
 *   `chrome.devtools` undefined.
 * - The code lives in component state for exactly as long as the dialog is
 *   open. `PairDialog` renders nothing while closed, so closing unmounts the
 *   body and discards the typed text; a successful pairing clears it before
 *   the dialog asks to close.
 * - A failed attempt is surfaced verbatim and never retried automatically:
 *   codes are single-use and the service rate-limits the route (five failures,
 *   then a lockout), so a silent retry loop would burn attempts the developer
 *   needs. The retry control re-submits only on an explicit click.
 * - No client-side format or length rule is applied. The worker and the
 *   service validate the code; a rule invented here would reject a valid code
 *   the day the format changes upstream. Surrounding whitespace is trimmed and
 *   an empty value keeps the submit control disabled — nothing more.
 * - The code is never written into an error message, a log line or any
 *   attribute other than the field's own controlled `value`.
 *
 * ## States (AAP 0.6.2, 0.5.5)
 *
 * - **idle** — the field and both actions are enabled; "Pair" is disabled
 *   while the trimmed value is empty.
 * - **submitting** — the field and "Pair" are disabled (natively, so they are
 *   genuinely inert), "Pair" reads "Pairing…" and the dialog carries
 *   `aria-busy`. `LoadingState` is deliberately not used: it owns a
 *   `role="status"` live region that would compete with the error alert, and
 *   the busy button already shows that work is in progress.
 * - **failed** — the renderer's `ErrorState` (`role="alert"`, so the failure
 *   is announced) shows the service's message, its hint and its error code,
 *   with a "Try again" action that re-submits the current value. A failure is
 *   never presented as success, and success is never inferred from anything
 *   but the resolved `submitCode` promise.
 *
 * ## Accessibility (AAP 0.6.4)
 *
 * - `role="dialog"` with `aria-modal="true"`, named by its level-2 `Heading`
 *   through `aria-labelledby` and described by the instruction through
 *   `aria-describedby`.
 * - Focus moves to the code field on open and returns to the element that had
 *   it before the dialog opened when the dialog closes — provided focus is
 *   still inside the dialog (or was dropped to the document body), so a close
 *   never steals focus the developer already moved elsewhere. The mount effect
 *   is symmetric, so React StrictMode's mount → unmount → mount replay ends in
 *   the same place as a single mount.
 * - `Escape` closes from anywhere inside the dialog, including while a submit
 *   is in flight. Tab and Shift+Tab cycle between the dialog's first and last
 *   enabled controls; because `Escape` always exits, the cycle is not a
 *   keyboard trap.
 * - `Enter` in the field submits through native implicit form submission, and
 *   a disabled submit button makes implicit submission a no-op, which is the
 *   "empty value cannot be submitted" rule enforced by the platform itself.
 * - Every control is a renderer primitive, so every keyboard focus shows the
 *   token ring `--dg-focus-ring` from the renderer's global `:focus-visible`
 *   rule.
 *
 * ## Design-system compliance (AAP 0.6.4)
 *
 * Every visual value resolves through a renderer component — `Section`,
 * `Stack`, `Heading`, `Text`, `Input`, `Button`, `ErrorState` and `Kbd` — and
 * therefore through the `--dg-*` tokens behind them. This file sets no inline
 * style, writes no length, colour or keyword value and declares no class name
 * of its own; the raw elements it uses are a `<div>` (the dialog role needs a
 * host element, and no primitive renders one) and a `<form>` (for native
 * implicit submission), neither of which carries a visual value.
 *
 * Design-system gap: the renderer ships no overlay, backdrop or viewport
 * positioning primitive, and fixed positioning cannot be expressed through a
 * `--dg-*` token, so the dialog renders in document flow as a token-styled
 * card rather than floating over a scrim. Where it appears is the composition
 * root's decision (it renders the dialog in place of the panel body while the
 * panel is not paired); the modal semantics above hold regardless of
 * placement.
 *
 * @module apps/chrome-extension/src/panel/components/PairDialog
 */
import {
  Button,
  ErrorState,
  Heading,
  Input,
  Kbd,
  Section,
  Stack,
  Text,
} from '@debuggen/panel-renderer';
import { DebuggenError } from '@debuggen/shared';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  SubmitEvent as ReactSubmitEvent,
} from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import type { PortRequestPayloads } from '../../shared/messages';

/*
 * ===========================================================================
 * Copy — generic product vocabulary only (AAP 0.5.4)
 * ===========================================================================
 */

/** The dialog's accessible name and visible title. */
const PAIR_DIALOG_TITLE = 'Pair this panel with VS Code';

/**
 * The one-sentence instruction: where the code comes from, and that it is
 * single-use and short-lived. The validity window is the service's policy, so
 * it is described rather than quoted as a number that could drift.
 */
const PAIR_DIALOG_INSTRUCTION =
  'Enter the one-time code shown in the Debug Generator view in VS Code (run “Pair Chrome DevTools Panel” to get one); each code works once and expires after a few minutes.';

/** The field's visible label. */
const PAIRING_FIELD_LABEL = 'Pairing code';

/** Help text below the field. */
const PAIRING_FIELD_HINT = 'Type or paste the code exactly as VS Code shows it.';

/** The primary action at rest. */
const PAIR_ACTION_LABEL = 'Pair';

/** The primary action while the worker redeems the code. */
const PAIR_ACTION_BUSY_LABEL = 'Pairing…';

/** The secondary action. */
const CANCEL_ACTION_LABEL = 'Cancel';

/** The failure's title, replacing `ErrorState`'s data-view default. */
const FAILURE_TITLE = 'Pairing failed';

/** The failure message when the rejection carried no usable text. */
const FAILURE_FALLBACK_MESSAGE = 'The extension could not complete pairing with the local service.';

/** The failure hint when the rejection carried none. */
const FAILURE_FALLBACK_HINT =
  'Get a fresh code from the Debug Generator view in VS Code and try again.';

/** The label of the failure's explicit retry control. */
const RETRY_ACTION_LABEL = 'Try again';

/** The key the dialog advertises for dismissal, rendered through `Kbd`. */
const DISMISS_CHORD = ['Esc'] as const;

/*
 * ===========================================================================
 * Types
 * ===========================================================================
 */

/**
 * The code as the `pair.complete` port request carries it — its `code` field,
 * indexed out of the extension's message contract rather than retyped, so the
 * prop follows the contract if its field type ever changes.
 */
type PairingCodeValue = PortRequestPayloads['pair.complete']['code'];

/**
 * Props of {@link PairDialog}.
 *
 * Every optional member states `| undefined` explicitly because
 * `exactOptionalPropertyTypes` is on repository-wide and a caller forwarding a
 * value it may not have must stay legal.
 */
export interface PairDialogProps {
  /**
   * Whether the dialog is shown. While `false` nothing is rendered, so no
   * hidden dialog stays mounted and no typed code survives a close.
   */
  open: boolean;

  /**
   * Asks the owner to close the dialog: raised by "Cancel", by `Escape`, and
   * after a successful pairing. The owner controls visibility; this component
   * never hides itself.
   */
  onClose: () => void;

  /**
   * Submits one trimmed, non-empty code to the service worker and settles when
   * the worker answers. The composition root binds it to the `pair.complete`
   * port request; resolve on `{ paired: true }` and reject with the failure —
   * ideally the `DebuggenError` the panel connection produces, whose message,
   * hint and code are shown as they are. Called only on an explicit submit or
   * retry, never on a timer.
   */
  submitCode: (code: PairingCodeValue) => Promise<void>;

  /** Raised after `submitCode` resolved, immediately before `onClose`. */
  onPaired?: (() => void) | undefined;

  /**
   * Extra classes for the dialog element. Composition only: any class named
   * here is a renderer class defined against the `--dg-*` tokens, never a
   * vehicle for a visual value.
   */
  className?: string | undefined;
}

/** What a failed attempt shows, derived from the rejection. */
interface PairFailure {
  /** The sentence the developer reads first. */
  readonly message: string;
  /** What to do about it. */
  readonly hint: string;
  /** The closed-vocabulary error code, when the rejection carried one. */
  readonly errorCode?: string | undefined;
}

/** The dialog's attempt state, discriminated on `kind`. */
type PairPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'failed'; readonly failure: PairFailure };

/** The shared idle phase. */
const IDLE_PHASE: PairPhase = { kind: 'idle' };

/** The shared submitting phase. */
const SUBMITTING_PHASE: PairPhase = { kind: 'submitting' };

/*
 * ===========================================================================
 * Pure helpers
 * ===========================================================================
 */

/** `value` when it holds visible text, otherwise `fallback`. */
function textOr(value: string | undefined, fallback: string): string {
  return value !== undefined && value.trim() !== '' ? value : fallback;
}

/**
 * The developer-facing description of a rejected `submitCode` promise.
 *
 * A `DebuggenError` — what the panel connection rejects with, carrying the
 * service's or the worker's own refusal (an invalid, expired or already-used
 * code, a rate-limit lockout, a lost port) — is shown with its message, hint
 * and code. Any other `Error` contributes its message only, and anything else
 * falls back to generic copy. Nothing is logged: the rejection is shown, and
 * the code the developer typed is never part of the text.
 *
 * @param error What `submitCode` rejected with.
 * @returns The failure to render.
 */
function describePairFailure(error: unknown): PairFailure {
  if (DebuggenError.is(error)) {
    return {
      message: textOr(error.message, FAILURE_FALLBACK_MESSAGE),
      hint: textOr(error.hint, FAILURE_FALLBACK_HINT),
      errorCode: error.code,
    };
  }
  if (error instanceof Error) {
    return {
      message: textOr(error.message, FAILURE_FALLBACK_MESSAGE),
      hint: FAILURE_FALLBACK_HINT,
    };
  }
  return { message: FAILURE_FALLBACK_MESSAGE, hint: FAILURE_FALLBACK_HINT };
}

/**
 * Elements that can take sequential focus. Filtered further by
 * {@link listTabbable}, which drops disabled controls, negative tab indexes
 * and anything inside a hidden or inert subtree.
 */
const TABBABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'iframe',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[tabindex]',
].join(', ');

/** Whether a form control is natively disabled. */
function isDisabledControl(element: HTMLElement): boolean {
  return (
    (element instanceof HTMLButtonElement ||
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement) &&
    element.disabled
  );
}

/**
 * The dialog's tabbable descendants, in document order.
 *
 * @param container The dialog element.
 * @returns Every descendant a Tab press can land on.
 */
function listTabbable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !isDisabledControl(element) &&
      element.closest('[hidden], [inert]') === null,
  );
}

/**
 * Move focus to the code field, if it is present and enabled.
 *
 * `Input` exposes no `ref` — its rendered element varies — and documents
 * looking the control up by the `id` the caller supplied as the sanctioned
 * route; `getElementById` takes React's generated id verbatim, with no
 * selector escaping.
 *
 * @param doc The dialog's document.
 * @param fieldId The id passed to the field.
 */
function focusField(doc: Document, fieldId: string): void {
  const field = doc.getElementById(fieldId);
  if (field instanceof HTMLElement && !isDisabledControl(field)) {
    field.focus();
  }
}

/**
 * Keep Tab and Shift+Tab inside the dialog by cycling between its first and
 * last tabbable controls.
 *
 * This is not a keyboard trap (AAP 0.6.4): `Escape` always closes the dialog,
 * from any control and in every state, so the developer can always leave.
 * Presses that stay between two inner controls are left to the browser; only
 * the wrap-around at either end, and a press made while focus sits on the
 * dialog element itself (where a submit parks it), is redirected.
 *
 * @param event The Tab keydown, observed on the dialog element.
 */
function cycleFocus(event: ReactKeyboardEvent<HTMLDivElement>): void {
  const dialog = event.currentTarget;
  const tabbable = listTabbable(dialog);
  const first = tabbable[0];
  const last = tabbable[tabbable.length - 1];

  if (first === undefined || last === undefined) {
    // Nothing inside can take focus (every control disabled): hold focus on
    // the dialog rather than letting it leave.
    event.preventDefault();
    dialog.focus();
    return;
  }

  const active = dialog.ownerDocument.activeElement;
  const onDialogOrOutside = active === null || active === dialog || !dialog.contains(active);

  if (event.shiftKey) {
    if (onDialogOrOutside || active === first) {
      event.preventDefault();
      last.focus();
    }
    return;
  }

  if (onDialogOrOutside || active === last) {
    event.preventDefault();
    first.focus();
  }
}

/*
 * ===========================================================================
 * Components
 * ===========================================================================
 */

/** Props of the mounted body: everything except the visibility flag. */
type PairDialogBodyProps = Omit<PairDialogProps, 'open'>;

/**
 * The open dialog. Mounted only while `open` is `true`, so its state — the
 * typed code and the attempt phase — begins empty on every open and is
 * discarded on every close.
 *
 * @param props Everything {@link PairDialog} received except `open`.
 * @returns The dialog.
 */
function PairDialogBody(props: PairDialogBodyProps): ReactElement {
  const { onClose, submitCode, onPaired, className } = props;

  const baseId = useId();
  const headingId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;
  const fieldId = `${baseId}-code`;

  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<PairPhase>(IDLE_PHASE);

  const dialogRef = useRef<HTMLDivElement>(null);
  /**
   * The double-submit guard. A ref rather than the phase, because it is set
   * synchronously before the first await: a second Enter or click in the same
   * frame arrives before React has re-rendered the disabled button.
   */
  const inFlightRef = useRef(false);
  /**
   * Whether this body is mounted. An answer that arrives after the developer
   * closed the dialog is dropped: the worker is paired regardless, and the
   * connection pill learns that from the worker's own push.
   */
  const mountedRef = useRef(false);

  // Focus in on open; focus back out on close. The opener is read before the
  // field is focused, and restored only while focus is still inside the dialog
  // (or was dropped to the body when the dialog's node was removed), so a
  // close never takes focus from wherever the developer moved it. The effect
  // is symmetric — StrictMode's replayed mount restores the opener, then reads
  // it again and refocuses the field — so a double invocation is harmless.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return undefined;
    }
    const doc = dialog.ownerDocument;
    const previous = doc.activeElement;
    const opener = previous instanceof HTMLElement && !dialog.contains(previous) ? previous : null;

    mountedRef.current = true;
    focusField(doc, fieldId);

    return () => {
      mountedRef.current = false;
      const current = doc.activeElement;
      const focusWasInside = current === null || current === doc.body || dialog.contains(current);
      if (opener !== null && opener.isConnected && focusWasInside) {
        opener.focus();
      }
    };
  }, [fieldId]);

  // After a failure the field is enabled again: return focus to it so the
  // developer can correct the code or paste a fresh one — but only when focus
  // is still where the submit parked it, never away from a control the
  // developer moved to meanwhile.
  useEffect(() => {
    if (phase.kind !== 'failed') {
      return;
    }
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    const doc = dialog.ownerDocument;
    const active = doc.activeElement;
    if (active === null || active === dialog || active === doc.body) {
      focusField(doc, fieldId);
    }
  }, [phase, fieldId]);

  const trimmedCode = code.trim();
  const submitting = phase.kind === 'submitting';
  const canSubmit = trimmedCode !== '' && !submitting;
  const failure = phase.kind === 'failed' ? phase.failure : undefined;

  /**
   * Hand one code to the worker and settle the phase from its answer.
   *
   * The callbacks run outside the `try`, so a fault in the owner's `onPaired`
   * or `onClose` can never be reported as a refused code — a success is
   * never shown as a failure, just as a failure is never shown as a success.
   */
  async function redeem(candidate: PairingCodeValue): Promise<void> {
    try {
      await submitCode(candidate);
    } catch (error: unknown) {
      inFlightRef.current = false;
      if (mountedRef.current) {
        setPhase({ kind: 'failed', failure: describePairFailure(error) });
      }
      return;
    }

    inFlightRef.current = false;
    if (!mountedRef.current) {
      return;
    }
    // Drop the capability before anything else happens.
    setCode('');
    setPhase(IDLE_PHASE);
    onPaired?.();
    onClose();
  }

  /** Submit the current value once, from an explicit submit or retry. */
  function submit(): void {
    const candidate = code.trim();
    if (candidate === '' || inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    // Park focus on the dialog element before the field and the submit
    // control become disabled: a disabled element drops focus to the document
    // body, where `Escape` would no longer reach the dialog's key handler.
    dialogRef.current?.focus();
    setPhase(SUBMITTING_PHASE);
    void redeem(candidate);
  }

  function handleSubmit(event: ReactSubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    submit();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      // An Escape that ends an IME composition belongs to the composition.
      if (event.nativeEvent.isComposing) {
        return;
      }
      event.preventDefault();
      // Consumed here: DevTools' extension host can forward an unhandled
      // Escape from a panel document to the DevTools front end, which would
      // toggle its drawer as well as closing this dialog.
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'Tab') {
      cycleFocus(event);
    }
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      aria-busy={submitting ? true : undefined}
      tabIndex={-1}
      className={className}
      onKeyDown={handleKeyDown}
    >
      <Section variant="card" gap={3}>
        <Stack gap={1}>
          <Heading level={2} id={headingId}>
            {PAIR_DIALOG_TITLE}
          </Heading>
          <Text as="p" size="sm" tone="secondary" id={descriptionId}>
            {PAIR_DIALOG_INSTRUCTION}
          </Text>
        </Stack>

        <form noValidate onSubmit={handleSubmit}>
          <Stack gap={3}>
            <Input
              id={fieldId}
              label={PAIRING_FIELD_LABEL}
              hint={PAIRING_FIELD_HINT}
              value={code}
              onValueChange={setCode}
              disabled={submitting}
              required
              fullWidth
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />

            {failure === undefined ? null : (
              <ErrorState
                title={FAILURE_TITLE}
                message={failure.message}
                hint={failure.hint}
                code={failure.errorCode}
                onRetry={trimmedCode === '' ? undefined : submit}
                retryLabel={RETRY_ACTION_LABEL}
              />
            )}

            <Stack direction="horizontal" gap={2} align="center" justify="between" wrap>
              <Text size="xs" tone="muted">
                Press <Kbd keys={DISMISS_CHORD} /> to cancel
              </Text>
              <Stack direction="horizontal" gap={2} align="center">
                <Button variant="secondary" onClick={onClose}>
                  {CANCEL_ACTION_LABEL}
                </Button>
                <Button variant="primary" type="submit" disabled={!canSubmit}>
                  {submitting ? PAIR_ACTION_BUSY_LABEL : PAIR_ACTION_LABEL}
                </Button>
              </Stack>
            </Stack>
          </Stack>
        </form>
      </Section>
    </div>
  );
}

/**
 * The pairing dialog: takes the one-time code shown in VS Code and hands it to
 * the service worker through the injected `submitCode`.
 *
 * Renders nothing while `open` is `false`. See this module's header for the
 * security boundary, the three states and the keyboard contract.
 *
 * @param props The props documented on {@link PairDialogProps}.
 * @returns The dialog, or `null` while closed.
 *
 * @example
 * // The composition root, while the connection pill reads "Not paired":
 * <PairDialog
 *   open={pairDialogOpen}
 *   onClose={() => setPairDialogOpen(false)}
 *   submitCode={async (code) => {
 *     await connection.request('pair.complete', { code });
 *   }}
 * />
 */
export function PairDialog(props: PairDialogProps): ReactElement | null {
  const { open, ...body } = props;
  if (!open) {
    return null;
  }
  return <PairDialogBody {...body} />;
}
