/**
 * `PairDialog` — the modal that takes the one-time pairing code shown in VS
 * Code and hands it to the service worker, and, in its address mode, changes
 * the local service's address for a panel that is already paired.
 *
 * ## Modes
 *
 * - **`pair`** (the default) — the code field, the service address field, and
 *   "Pair". The composition root opens it while the connection pill reads
 *   "Not paired".
 * - **`address`** — the service address field alone, and "Save address". The
 *   composition root opens it from the pill's "Change service address…"
 *   control while the pill reads "Reconnecting…" or "Service not running", so
 *   a developer whose service moved to another port points the extension at
 *   it without pairing again. The dialog saves the setting and closes; the
 *   service worker follows the stored address as it changes and reconnects
 *   the socket and every HTTP call there with the credential it already holds.
 *   `submitCode` is never called in this mode.
 *
 * A mode holds for one open: the body is keyed by it, so a caller that
 * switches modes gets a fresh dialog with empty fields rather than one mode's
 * state carried into the other.
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
 *   `fetch`, never reads or writes the credential, and touches no `chrome.*`
 *   API but one, described next — which is also why it renders unchanged when
 *   the panel page is opened directly with `chrome.devtools` undefined.
 * - It reads and writes exactly one setting, which is not a secret: the local
 *   service's address, through a {@link ServiceEndpointAccessor}
 *   ({@link PairDialogProps.serviceEndpoint}). By default that accessor is the
 *   pure helper pair of `../../background/auth` over `chrome.storage.local`,
 *   resolved when the dialog opens — never at import — and absent where
 *   `chrome.storage` is not available, in which case the field is not
 *   rendered. The value is validated and saved **before** the code is
 *   submitted, so the worker redeems the code at the address the developer
 *   entered; a refused or unsaved address is shown on the field and the code
 *   is not submitted. A refusal never quotes the value (it may be a paste that
 *   carries anything); the field's own controlled `value` is the only place
 *   the text appears. In address mode saving that setting is all the dialog
 *   does: no code is asked for and nothing is sent to the worker, which
 *   learns of the new address from storage itself. Without an accessor the
 *   address mode says the address cannot be changed from this page and
 *   offers only "Cancel".
 * - The code lives in component state for exactly as long as the dialog is
 *   open. `PairDialog` renders nothing while closed, so closing unmounts the
 *   body and discards the typed text; a successful pairing clears it before
 *   the dialog asks to close.
 * - A failed attempt is surfaced verbatim and never retried automatically:
 *   codes are single-use and the service rate-limits the route (five failures,
 *   then a lockout), so a silent retry loop would burn attempts the developer
 *   needs. The retry control re-submits only on an explicit click.
 * - Only a well-formed code is ever submitted. The value is checked by
 *   `checkPairingCode` (`../../shared/pairing-code`), which mirrors the
 *   service's rule — eight characters of the service's 32-symbol alphabet,
 *   after trimming and upper-casing — and a value that breaks it is refused
 *   here, with the reason on the field, before it can cost one of the five
 *   attempts the rate limit allows. What is submitted is the normalised code
 *   (trimmed, upper-cased), which is exactly what the service redeems. The
 *   check is a pre-flight filter only: the worker keeps its own length check,
 *   and the service alone decides whether a well-formed code is genuine,
 *   unexpired and unused.
 * - The code is never written into an error message, a log line or any
 *   attribute other than the field's own controlled `value`; a validation
 *   message names the rule and, for a wrong length, the length — never a
 *   character of the value.
 *
 * ## States (AAP 0.6.2, 0.5.5)
 *
 * - **idle** — the fields and both actions are enabled. The service address
 *   field is prefilled with the saved address, shows the default as its
 *   placeholder when none is saved, and shows why a saved address is unusable
 *   when it is. "Pair" stays enabled whatever the code field holds, so
 *   pressing it — or `Enter` in a field — always answers: a well-formed code
 *   is submitted, anything else is refused with the reason shown on the code
 *   field and focus moved to it.
 * - **invalid** (within idle) — the code field carries the renderer `Input`'s
 *   `invalid` state and its `errorMessage`. A value that can no longer become
 *   valid by typing on — a disallowed character, or more than eight
 *   characters — is flagged as it is typed; an empty or still-too-short value
 *   is flagged only once a submit was attempted, so the field does not
 *   complain while the developer is midway through the code. After a submit
 *   attempt the message follows every edit, and it disappears as soon as the
 *   value is well-formed.
 * - **submitting** — the fields and "Pair" are disabled (natively, so they are
 *   genuinely inert), "Pair" reads "Pairing…" and the dialog carries
 *   `aria-busy`. An edited service address is saved first; a refusal returns
 *   the dialog to idle with the reason on the address field (`invalid` plus
 *   its error message) and focus on it, and the code is not submitted.
 *   `LoadingState` is deliberately not used: it owns a
 *   `role="status"` live region that would compete with the error alert, and
 *   the busy button already shows that work is in progress.
 * - **failed** — the renderer's `ErrorState` (`role="alert"`, so the failure
 *   is announced) shows the service's message, its hint and its error code,
 *   with a "Try again" action that re-submits the current value, offered while
 *   that value is well-formed. A failure is
 *   never presented as success, and success is never inferred from anything
 *   but the resolved `submitCode` promise.
 *
 * In address mode the same field-level states apply to the address alone:
 *
 * - **idle** — the address field (prefilled, placeholder and unusable-value
 *   message exactly as above) and both actions are enabled. "Save address", or
 *   `Enter` in the field, always answers: an edited address — or any value
 *   while the saved one is unusable — is validated and saved; an untouched,
 *   usable address is left alone and the dialog simply closes.
 * - **saving** — the field and "Save address" are disabled, the action reads
 *   "Saving…" and the dialog carries `aria-busy`, with the same double-submit
 *   guard as a pairing submit.
 * - **refused** (within idle) — the validator's or storage's refusal (a
 *   throwing accessor included) is shown on the field as `invalid` plus its
 *   error message, never quoting the value, and focus moves to the field.
 *   Nothing is saved.
 * - **saved** — {@link PairDialogProps.onAddressSaved}, then `onClose`. A
 *   save is success only when the accessor's `write` resolved `ok`.
 * - **unavailable** — with no accessor, a sentence saying the address cannot
 *   be changed from this page, "Cancel", and no primary action.
 *
 * ## Accessibility (AAP 0.6.4)
 *
 * - `role="dialog"` with `aria-modal="true"`, named by its level-2 `Heading`
 *   through `aria-labelledby` and described by the instruction through
 *   `aria-describedby`.
 * - The modality is real, not only declared. The owner makes everything
 *   behind the dialog `inert` while it is open (the panel's `App` does so for
 *   the header, the body, the drawer and the live tail), so the background can
 *   be neither focused, clicked nor reached by assistive technology. The
 *   dialog adds containment of its own on top: a document-level `focusin`
 *   listener (capture phase) returns focus that lands anywhere outside the
 *   dialog — moved there by script, say — to the mode's field (the code field
 *   when pairing, the address field in address mode), or to the dialog
 *   element while that field is disabled or absent. That listener and the
 *   document-level `Escape` listener described below are added and removed by
 *   one symmetric effect, so a StrictMode replay leaves exactly one of each.
 * - Focus moves to the mode's field on open — to the dialog element itself
 *   when the address mode has no field to offer — and, when the dialog is removed,
 *   returns to the element that held it before the dialog opened (never the
 *   document body) — provided focus is still inside the dialog or was dropped
 *   to the body with its node, so a close never steals focus the developer
 *   already moved elsewhere. The opener is kept across React StrictMode's
 *   mount → unmount → mount replay, which removes no node and therefore moves
 *   no focus: the replay ends where a single mount does, even though the
 *   opener is inert — and so cannot take focus — for as long as the dialog is
 *   open.
 * - `Escape` closes from anywhere inside the dialog, including while a submit
 *   is in flight, and also while focus has fallen to the document body (a
 *   click on an empty stretch of the page), because the key is then observed
 *   on the document. An `Escape` that ends an IME composition is left to the
 *   composition. Tab and Shift+Tab cycle between the dialog's first and last
 *   enabled controls; because `Escape` always exits, the cycle is not a
 *   keyboard trap.
 * - `Enter` in the field submits through native implicit form submission. The
 *   submit button is disabled only while a submit is in flight — a disabled
 *   default button would turn implicit submission into a silent no-op — so an
 *   ill-formed value always reaches the check and always produces a visible
 *   reason.
 * - A validation error is the `Input` primitive's own: `aria-invalid` on the
 *   control and the message linked through `aria-describedby`, after the
 *   field's hint. It is deliberately not a live region, which would interrupt
 *   on every keystroke; a refused submit instead moves focus to the field, so
 *   the message is read with it.
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
 * root's decision (the panel renders it directly under its header while it is
 * open, in either mode). Without a scrim, modality is enforced by the owner's
 * inert background together with this dialog's focus containment and
 * `Escape` handling, so the modal semantics above hold regardless of
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
import type { DebuggenErrorCode, Result } from '@debuggen/shared';
import { DebuggenError, err, isErr } from '@debuggen/shared';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode,
  SubmitEvent as ReactSubmitEvent,
} from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import type { ServiceEndpointAccessor } from '../../background/auth';
import { createServiceEndpointAccessor } from '../../background/auth';
import type { PortRequestPayloads } from '../../shared/messages';
import { DEFAULT_SERVICE_BASE_URL } from '../../shared/messages';
import { PAIRING_CODE_LENGTH, checkPairingCode } from '../../shared/pairing-code';
import type { PairingCodeCheck } from '../../shared/pairing-code';

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

/**
 * Help text below the field. States the length up front, so the rule a refused
 * submit reports is never a surprise; the length is the shared constant, so the
 * hint and the check cannot disagree.
 */
const PAIRING_FIELD_HINT = `Type or paste the ${String(PAIRING_CODE_LENGTH)}-character code exactly as VS Code shows it.`;

/** The service address field's visible label. */
const SERVICE_ADDRESS_FIELD_LABEL = 'Service address';

/** Help text below the service address field. */
const SERVICE_ADDRESS_FIELD_HINT = `The loopback address the local service listens on. Leave it blank for the default, ${DEFAULT_SERVICE_BASE_URL}.`;

/** The field's message when the address could not be validated or saved and carried no text. */
const SERVICE_ADDRESS_FALLBACK_MESSAGE = 'The service address could not be saved.';

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

/**
 * The error code of a refusal while the service has paused pairing after too
 * many wrong codes — the one refusal a fresh code does not fix, because the
 * pause refuses every code, a valid one included, until it ends.
 */
const PAUSED_ERROR_CODE = 'RATE_LIMITED' satisfies DebuggenErrorCode;

/** The failure's title while pairing is paused. */
const PAUSED_TITLE = 'Pairing paused';

/**
 * The message while pairing is paused, when the refusal carried no usable
 * text. The length of the pause is the service's policy and reaches the
 * dialog in the service's own message, so it is not restated here as a number
 * that could drift.
 */
const PAUSED_FALLBACK_MESSAGE =
  'Too many incorrect codes were entered, so the local service paused pairing for a short while.';

/**
 * What to do while pairing is paused. Replaces the generic hint, which would
 * send the developer for a fresh code that the pause refuses too.
 */
const PAUSED_HINT =
  'Wait until the pause ends, then choose Try again with the current code; a new code from VS Code is refused until then too.';

/** The label of the failure's explicit retry control. */
const RETRY_ACTION_LABEL = 'Try again';

/** The key the dialog advertises for dismissal, rendered through `Kbd`. */
const DISMISS_CHORD = ['Esc'] as const;

/** The address mode's accessible name and visible title. */
const ADDRESS_DIALOG_TITLE = 'Change the service address';

/**
 * The address mode's one-sentence instruction: what the address is, and that
 * saving it keeps the pairing — the worker reconnects there with the
 * credential it already holds, so no new code is needed.
 */
const ADDRESS_DIALOG_INSTRUCTION =
  'Enter the loopback address the local Debug Generator service listens on; the extension reconnects to the saved address with its current pairing.';

/** The address mode's sentence when this document has no extension storage to save to. */
const ADDRESS_UNAVAILABLE_MESSAGE =
  'The service address cannot be changed from this page: extension storage is not available to it.';

/** The address mode's primary action at rest. */
const SAVE_ADDRESS_ACTION_LABEL = 'Save address';

/** The address mode's primary action while the address is being saved. */
const SAVE_ADDRESS_ACTION_BUSY_LABEL = 'Saving…';

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
 * What an open dialog is for: `'pair'` redeems a one-time code (saving an
 * edited service address first), `'address'` saves the service address alone
 * for a panel that is already paired. See this module's header.
 */
export type PairDialogMode = 'pair' | 'address';

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
   * What the dialog is for. Omitted, `'pair'`: the code and address fields
   * and "Pair". `'address'` renders the address field and "Save address" only,
   * and never calls `submitCode`. Changing it remounts the dialog's body, so
   * no state crosses from one mode to the other.
   */
  mode?: PairDialogMode | undefined;

  /**
   * Asks the owner to close the dialog: raised by "Cancel", by `Escape`,
   * after a successful pairing, and in address mode after the address was
   * saved or when an untouched, usable address is submitted. The owner
   * controls visibility; this component never hides itself.
   */
  onClose: () => void;

  /**
   * Submits one well-formed code — normalised by `checkPairingCode`: trimmed,
   * upper-cased, eight characters of the service's alphabet — to the service
   * worker and settles when the worker answers. An ill-formed value is refused
   * in the dialog and never reaches this callback. The composition root binds
   * it to the `pair.complete` port request; resolve on `{ paired: true }` and
   * reject with the failure — ideally the `DebuggenError` the panel connection
   * produces, whose message, hint and code are shown as they are. Called only
   * on an explicit submit or retry in pair mode, never on a timer and never in
   * address mode.
   */
  submitCode: (code: PairingCodeValue) => Promise<void>;

  /** Raised after `submitCode` resolved, immediately before `onClose`. */
  onPaired?: (() => void) | undefined;

  /**
   * Address mode only: raised after the accessor's `write` resolved `ok`,
   * immediately before `onClose`. Not raised when the dialog was closed while
   * the save was in flight (the setting is saved regardless, and the worker
   * follows it from storage), nor when an untouched address closes the dialog
   * without a write.
   */
  onAddressSaved?: (() => void) | undefined;

  /**
   * Where the service address setting is read from and saved to. Omitted, the
   * dialog resolves {@link resolveServiceEndpointAccessor} when it opens:
   * `chrome.storage.local` through `../../background/auth`'s helpers when this
   * document has it — and, when it does not, no address field in pair mode and
   * the "cannot be changed from this page" sentence in address mode. `write`
   * validates (`parseServiceEndpoint`) before it stores; a blank value
   * restores the default.
   */
  serviceEndpoint?: ServiceEndpointAccessor | undefined;

  /**
   * Extra classes for the dialog element. Composition only: any class named
   * here is a renderer class defined against the `--dg-*` tokens, never a
   * vehicle for a visual value.
   */
  className?: string | undefined;
}

/** What a failed attempt shows, derived from the rejection. */
interface PairFailure {
  /** The heading of the failure notice. */
  readonly title: string;
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
 * The platform's {@link ServiceEndpointAccessor}: one over this document's
 * `chrome.storage.local`, or `undefined` where there is none (the panel page
 * opened outside the extension, a unit test's document).
 *
 * Read when called, never at import, and reads no storage itself: the
 * accessor it builds touches storage only when a member is called. The
 * dialog calls it once per open when its owner injected no accessor; an owner
 * that must know beforehand whether the address can be changed at all — to
 * offer the "Change service address…" control only where it can — calls it
 * too, and passes the result to the dialog so both work with the same
 * setting.
 *
 * @returns The accessor, or `undefined` where this document has no
 * `chrome.storage.local`.
 *
 * @example
 * const [serviceEndpoint] = useState(() => resolveServiceEndpointAccessor());
 * <PairDialog mode="address" serviceEndpoint={serviceEndpoint} … />
 */
export function resolveServiceEndpointAccessor(): ServiceEndpointAccessor | undefined {
  if (typeof chrome === 'undefined') {
    return undefined;
  }
  const namespace: Partial<typeof chrome> = chrome;
  const local = namespace.storage?.local;
  return local === undefined ? undefined : createServiceEndpointAccessor(local);
}

/**
 * The sentence shown on the address field for a refused or unsaved address:
 * the refusal's message and its hint. Both are constants of the validator or
 * of the storage wrapper, never built from the value.
 */
function describeAddressFailure(error: DebuggenError): string {
  const message = textOr(error.message, SERVICE_ADDRESS_FALLBACK_MESSAGE);
  return error.hint === undefined || error.hint.trim() === ''
    ? message
    : `${message} ${error.hint}`;
}

/**
 * Settle an accessor call into a `Result`, whatever it does: an injected
 * accessor is not bound by the helpers' never-rejects contract.
 */
async function settleAccessor<T>(
  run: () => Promise<Result<T, DebuggenError>>,
): Promise<Result<T, DebuggenError>> {
  try {
    return await run();
  } catch (thrown: unknown) {
    return err(DebuggenError.from(thrown, 'STORE_ERROR'));
  }
}

/**
 * The validation message the field shows for the current value, or `undefined`
 * while it shows none.
 *
 * A well-formed value never shows one. A value that typing on cannot repair —
 * a disallowed character, or more than {@link PAIRING_CODE_LENGTH} characters —
 * shows its message at once. An empty or still-too-short value is a code being
 * typed, so its message waits until a submit was attempted; from then on every
 * message follows the value as it is edited.
 *
 * @param check The current value's {@link checkPairingCode} result.
 * @param submitAttempted Whether a submit of this dialog's value was attempted.
 * @returns The message to render through `Input`'s `errorMessage`, or
 * `undefined`.
 */
function visibleValidationMessage(
  check: PairingCodeCheck,
  submitAttempted: boolean,
): string | undefined {
  if (check.valid) {
    return undefined;
  }
  const beyondRepairByTyping =
    check.problem === 'characters' ||
    (check.problem === 'length' && check.receivedLength > PAIRING_CODE_LENGTH);
  return submitAttempted || beyondRepairByTyping ? check.message : undefined;
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
 * A lockout (`RATE_LIMITED`) is titled "Pairing paused" and, since the port
 * carries no hint, gets {@link PAUSED_HINT} rather than the generic advice to
 * fetch a fresh code, which the pause would refuse as well. Its message is the
 * service's, which states how long pairing is paused.
 *
 * @param error What `submitCode` rejected with.
 * @returns The failure to render.
 */
function describePairFailure(error: unknown): PairFailure {
  if (DebuggenError.is(error)) {
    if (error.code === PAUSED_ERROR_CODE) {
      return {
        title: PAUSED_TITLE,
        message: textOr(error.message, PAUSED_FALLBACK_MESSAGE),
        hint: textOr(error.hint, PAUSED_HINT),
        errorCode: error.code,
      };
    }
    return {
      title: FAILURE_TITLE,
      message: textOr(error.message, FAILURE_FALLBACK_MESSAGE),
      hint: textOr(error.hint, FAILURE_FALLBACK_HINT),
      errorCode: error.code,
    };
  }
  if (error instanceof Error) {
    return {
      title: FAILURE_TITLE,
      message: textOr(error.message, FAILURE_FALLBACK_MESSAGE),
      hint: FAILURE_FALLBACK_HINT,
    };
  }
  return { title: FAILURE_TITLE, message: FAILURE_FALLBACK_MESSAGE, hint: FAILURE_FALLBACK_HINT };
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
 * Move focus to a field — the code field, or the address field — if it is
 * present and enabled.
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
 * Return focus to the dialog after it landed outside, or on open: on the
 * mode's field when it is enabled, otherwise on the dialog element itself —
 * where a submit parks focus while the field is disabled, and where focus
 * rests when the address mode has no field — so `Escape` keeps reaching the
 * dialog's key handler.
 *
 * @param dialog The dialog element.
 * @param fieldId The id passed to the mode's field.
 */
function returnFocusInside(dialog: HTMLElement, fieldId: string): void {
  const doc = dialog.ownerDocument;
  focusField(doc, fieldId);
  if (!dialog.contains(doc.activeElement)) {
    dialog.focus();
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
 * The open dialog. Mounted only while `open` is `true`, and keyed by its mode,
 * so its state — the typed code, the address and the attempt phase — begins
 * empty on every open and is discarded on every close.
 *
 * @param props Everything {@link PairDialog} received except `open`.
 * @returns The dialog.
 */
function PairDialogBody(props: PairDialogBodyProps): ReactElement {
  const {
    mode = 'pair',
    onClose,
    submitCode,
    onPaired,
    onAddressSaved,
    className,
    serviceEndpoint,
  } = props;
  const addressMode = mode === 'address';

  const baseId = useId();
  const headingId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;
  const fieldId = `${baseId}-code`;
  const addressFieldId = `${baseId}-service-address`;
  /**
   * The field focus goes to on open, is returned to by containment, and
   * returns to after a refusal: the code field when pairing, the address field
   * in address mode.
   */
  const focusTargetId = addressMode ? addressFieldId : fieldId;

  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<PairPhase>(IDLE_PHASE);
  /**
   * Whether a submit of this dialog's value was attempted, which is what lets
   * an empty or still-too-short value show its validation message (see
   * {@link visibleValidationMessage}).
   */
  const [submitAttempted, setSubmitAttempted] = useState(false);

  /**
   * The platform's address setting, resolved once when the dialog opens and
   * only when the caller supplied none.
   */
  const [platformEndpoint] = useState(() =>
    serviceEndpoint === undefined ? resolveServiceEndpointAccessor() : undefined,
  );
  /** The setting this open works with; without one, no address field is rendered. */
  const endpointAccessor = serviceEndpoint ?? platformEndpoint;
  const [address, setAddress] = useState('');
  /** Why the address shown is unusable or could not be saved, when it is. */
  const [addressError, setAddressError] = useState<string | undefined>(undefined);
  /**
   * Whether the address must be saved — before the code is submitted, or, in
   * address mode, before the dialog closes: the developer edited it, or the
   * saved one is unusable. An untouched, valid address is left alone, so a
   * slow read can never be overwritten by a field that had not been prefilled
   * yet.
   */
  const addressNeedsSaveRef = useRef(false);

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
  /**
   * The element that held focus when the dialog opened, returned focus to when
   * the dialog is removed. A ref rather than an effect-local, so StrictMode's
   * replayed mount — which finds focus already on the field — keeps the opener
   * the first mount recorded.
   */
  const openerRef = useRef<HTMLElement | null>(null);

  // Containment: while the dialog is mounted, focus that lands anywhere outside
  // it is returned inside, and an `Escape` whose target is outside it (focus
  // fell to the document body) still closes it. Both listeners sit on the
  // document in the capture phase, so they observe every focus move and key
  // before any handler of the page can act on it. Declared before the focus
  // effect below so that on unmount the listeners are gone before the opener
  // takes focus back; one effect adds both and removes both, so a StrictMode
  // replay leaves exactly one of each.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return undefined;
    }
    const doc = dialog.ownerDocument;

    const containFocus = (event: FocusEvent): void => {
      const target = event.target;
      if (!dialog.isConnected || (target instanceof Node && dialog.contains(target))) {
        return;
      }
      returnFocusInside(dialog, focusTargetId);
    };

    const closeOnEscapeOutside = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) {
        return;
      }
      const target = event.target;
      if (target instanceof Node && dialog.contains(target)) {
        // Inside the dialog: its own key handler takes the key.
        return;
      }
      event.preventDefault();
      // Consumed for the same reason the dialog's own handler consumes it: an
      // unhandled Escape can be forwarded to the DevTools front end.
      event.stopPropagation();
      onClose();
    };

    doc.addEventListener('focusin', containFocus, true);
    doc.addEventListener('keydown', closeOnEscapeOutside, true);
    return () => {
      doc.removeEventListener('focusin', containFocus, true);
      doc.removeEventListener('keydown', closeOnEscapeOutside, true);
    };
  }, [focusTargetId, onClose]);

  // Focus in on open; focus back out on close. The opener is read before the
  // field is focused — never the document body, which is not a destination —
  // and restored only when the dialog's node has actually been removed and
  // focus is still inside the dialog or was dropped to the body with it, so a
  // close never takes focus from wherever the developer moved it. StrictMode's
  // replay removes no node, so it moves no focus: the field keeps it, and the
  // opener — inert behind the modal, so unable to take focus anyway — stays
  // recorded for the real close. Focus goes in through `returnFocusInside`, so
  // an address mode with no field to offer still puts focus in the dialog
  // (on its element) rather than leaving it on the now-inert opener; with the
  // field present and enabled, as it always is on open, that is the field.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return undefined;
    }
    const doc = dialog.ownerDocument;
    const previous = doc.activeElement;
    if (previous instanceof HTMLElement && previous !== doc.body && !dialog.contains(previous)) {
      openerRef.current = previous;
    }

    mountedRef.current = true;
    returnFocusInside(dialog, focusTargetId);

    return () => {
      mountedRef.current = false;
      if (dialog.isConnected) {
        return;
      }
      const opener = openerRef.current;
      openerRef.current = null;
      const current = doc.activeElement;
      const focusWasInside = current === null || current === doc.body || dialog.contains(current);
      if (opener !== null && opener.isConnected && focusWasInside) {
        opener.focus();
      }
    };
  }, [focusTargetId]);

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

  // Prefill the address field with the saved address, or say why the saved
  // one is unusable. An answer that arrives after the developer started
  // typing, or after the dialog closed, is dropped.
  useEffect(() => {
    if (endpointAccessor === undefined) {
      return undefined;
    }
    let current = true;
    void settleAccessor(() => endpointAccessor.read()).then((stored) => {
      if (!current || addressNeedsSaveRef.current) {
        return;
      }
      if (isErr(stored)) {
        addressNeedsSaveRef.current = stored.error.code !== 'STORE_ERROR';
        setAddressError(describeAddressFailure(stored.error));
        return;
      }
      setAddress(stored.value ?? '');
    });
    return () => {
      current = false;
    };
  }, [endpointAccessor]);

  // After a refused address the field is enabled again: move focus to it —
  // only from where the submit parked it, as for a failed code.
  useEffect(() => {
    if (addressError === undefined || phase.kind !== 'idle') {
      return;
    }
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    const doc = dialog.ownerDocument;
    const active = doc.activeElement;
    if (active === null || active === dialog || active === doc.body) {
      focusField(doc, addressFieldId);
    }
  }, [addressError, phase, addressFieldId]);

  const check = checkPairingCode(code);
  const submitting = phase.kind === 'submitting';
  const validationMessage = visibleValidationMessage(check, submitAttempted);
  // `Input` declares `invalid` and `errorMessage` without `| undefined`
  // (`exactOptionalPropertyTypes`), so the pair is present together or not at
  // all — which is also the primitive's own contract: no message without the
  // invalid state, and no invalid state without a message.
  const validationProps =
    validationMessage === undefined ? {} : { invalid: true, errorMessage: validationMessage };
  const failure = phase.kind === 'failed' ? phase.failure : undefined;

  /**
   * Hand one code to the worker and settle the phase from its answer.
   *
   * The callbacks run outside the `try`, so a fault in the owner's `onPaired`
   * or `onClose` can never be reported as a refused code — a success is
   * never shown as a failure, just as a failure is never shown as a success.
   */
  async function redeem(candidate: PairingCodeValue, enteredAddress: string): Promise<void> {
    if (endpointAccessor !== undefined && addressNeedsSaveRef.current) {
      // Saved first, so the worker — which re-reads the setting before it
      // redeems — sends the code to the address the developer entered.
      const saved = await settleAccessor(() => endpointAccessor.write(enteredAddress));
      if (isErr(saved)) {
        inFlightRef.current = false;
        if (mountedRef.current) {
          setAddressError(describeAddressFailure(saved.error));
          setPhase(IDLE_PHASE);
        }
        return;
      }
      addressNeedsSaveRef.current = false;
      if (!mountedRef.current) {
        // Closed while saving: the developer cancelled, so no code is sent.
        inFlightRef.current = false;
        return;
      }
      setAddress(saved.value ?? '');
    }

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
    // Drop the capability before anything else happens. The attempt flag goes
    // with it, so a dialog its owner keeps open starts over without flagging
    // the now-empty field.
    setCode('');
    setSubmitAttempted(false);
    setPhase(IDLE_PHASE);
    onPaired?.();
    onClose();
  }

  /**
   * Submit the current value once, from an explicit submit or retry — but only
   * a well-formed one. An ill-formed value never reaches `submitCode`: the
   * attempt reveals the field's validation message and moves focus to the
   * field, so the reason is read with it and the developer can correct it in
   * place.
   */
  function submit(): void {
    if (inFlightRef.current) {
      return;
    }
    setSubmitAttempted(true);
    const checked = checkPairingCode(code);
    if (!checked.valid) {
      const dialog = dialogRef.current;
      if (dialog !== null) {
        focusField(dialog.ownerDocument, fieldId);
      }
      return;
    }
    const candidate: PairingCodeValue = checked.code;
    inFlightRef.current = true;
    // Park focus on the dialog element before the field and the submit
    // control become disabled: a disabled element drops focus to the document
    // body, where `Escape` would no longer reach the dialog's key handler.
    dialogRef.current?.focus();
    setPhase(SUBMITTING_PHASE);
    void redeem(candidate, address);
  }

  /**
   * Address mode: save one address and settle the phase from the answer.
   *
   * A refusal — the validator's, storage's, or a throwing accessor's, all
   * settled into an `Err` by {@link settleAccessor} — returns the dialog to
   * idle with the reason on the field, and nothing is saved. On success the
   * field shows the canonical value that was stored, and the owner's
   * callbacks run last, outside every refusal path, so a fault in them is
   * never reported as a refused address.
   *
   * @param accessor The setting this open works with.
   * @param enteredAddress The field's value when the save was asked for.
   */
  async function saveAddress(
    accessor: ServiceEndpointAccessor,
    enteredAddress: string,
  ): Promise<void> {
    const saved = await settleAccessor(() => accessor.write(enteredAddress));
    inFlightRef.current = false;
    if (isErr(saved)) {
      if (mountedRef.current) {
        setAddressError(describeAddressFailure(saved.error));
        setPhase(IDLE_PHASE);
      }
      return;
    }
    addressNeedsSaveRef.current = false;
    if (!mountedRef.current) {
      // Closed while saving: the setting is stored regardless, and the worker
      // follows it from storage; there is no dialog left to update.
      return;
    }
    setAddress(saved.value ?? '');
    setPhase(IDLE_PHASE);
    onAddressSaved?.();
    onClose();
  }

  /**
   * Address mode's submit, from "Save address" or `Enter` in the field: save
   * the address when it needs saving — the developer edited it, or the saved
   * one is unusable — and otherwise just close, so an untouched, usable
   * address is never rewritten. Never calls `submitCode`.
   */
  function submitAddress(): void {
    if (inFlightRef.current || endpointAccessor === undefined) {
      return;
    }
    if (!addressNeedsSaveRef.current) {
      onClose();
      return;
    }
    inFlightRef.current = true;
    // Parked on the dialog element for the reason `submit` gives: the field
    // and the action are about to be disabled.
    dialogRef.current?.focus();
    setPhase(SUBMITTING_PHASE);
    void saveAddress(endpointAccessor, address);
  }

  /** The developer edited the address: it is saved on the next submit. */
  function handleAddressChange(next: string): void {
    addressNeedsSaveRef.current = true;
    setAddress(next);
    setAddressError(undefined);
  }

  function handleSubmit(event: ReactSubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (addressMode) {
      submitAddress();
      return;
    }
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

  // One address field for both modes, so the two can never word, validate or
  // wire it differently.
  const addressInput =
    endpointAccessor === undefined ? null : (
      <Input
        id={addressFieldId}
        label={SERVICE_ADDRESS_FIELD_LABEL}
        hint={SERVICE_ADDRESS_FIELD_HINT}
        placeholder={DEFAULT_SERVICE_BASE_URL}
        value={address}
        onValueChange={handleAddressChange}
        disabled={submitting}
        invalid={addressError !== undefined}
        {...(addressError === undefined ? {} : { errorMessage: addressError })}
        fullWidth
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
    );

  let title: string;
  let instruction: string;
  let content: ReactElement;
  if (!addressMode) {
    title = PAIR_DIALOG_TITLE;
    instruction = PAIR_DIALOG_INSTRUCTION;
    content = (
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
            {...validationProps}
          />

          {addressInput}

          {/* The retry re-submits the current value, so it is offered only
              while that value is well-formed; an edited, ill-formed value
              shows its own reason on the field instead. */}
          {failure === undefined ? null : (
            <ErrorState
              title={failure.title}
              message={failure.message}
              hint={failure.hint}
              code={failure.errorCode}
              onRetry={check.valid ? submit : undefined}
              retryLabel={RETRY_ACTION_LABEL}
            />
          )}

          {renderDialogActions(
            onClose,
            // Disabled only while a submit is in flight: an ill-formed value
            // must still reach `submit`, which says why it is refused, and a
            // disabled default button would make `Enter` in the field
            // silently do nothing.
            <Button variant="primary" type="submit" disabled={submitting}>
              {submitting ? PAIR_ACTION_BUSY_LABEL : PAIR_ACTION_LABEL}
            </Button>,
          )}
        </Stack>
      </form>
    );
  } else if (addressInput === null) {
    // Nothing to save to: say so, and offer the way out alone.
    title = ADDRESS_DIALOG_TITLE;
    instruction = ADDRESS_UNAVAILABLE_MESSAGE;
    content = renderDialogActions(onClose, null);
  } else {
    title = ADDRESS_DIALOG_TITLE;
    instruction = ADDRESS_DIALOG_INSTRUCTION;
    content = (
      <form noValidate onSubmit={handleSubmit}>
        <Stack gap={3}>
          {addressInput}
          {renderDialogActions(
            onClose,
            // Disabled only while a save is in flight, for the reason the
            // pairing action gives: `Enter` in the field must always answer.
            <Button variant="primary" type="submit" disabled={submitting}>
              {submitting ? SAVE_ADDRESS_ACTION_BUSY_LABEL : SAVE_ADDRESS_ACTION_LABEL}
            </Button>,
          )}
        </Stack>
      </form>
    );
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
            {title}
          </Heading>
          <Text as="p" size="sm" tone="secondary" id={descriptionId}>
            {instruction}
          </Text>
        </Stack>

        {content}
      </Section>
    </div>
  );
}

/**
 * The dialog's bottom row, the same in every mode: the `Escape` hint, then
 * "Cancel" and the mode's primary action, if it has one.
 *
 * A plain function rather than a component, so it adds no layer to the React
 * tree and the rendered markup is exactly the row it returns.
 *
 * @param onCancel What "Cancel" raises — the owner's `onClose`.
 * @param primary The mode's submit button, or `null` where the mode has none.
 * @returns The row.
 */
function renderDialogActions(onCancel: () => void, primary: ReactNode): ReactElement {
  return (
    <Stack direction="horizontal" gap={2} align="center" justify="between" wrap>
      <Text size="xs" tone="muted">
        Press <Kbd keys={DISMISS_CHORD} /> to cancel
      </Text>
      <Stack direction="horizontal" gap={2} align="center">
        <Button variant="secondary" onClick={onCancel}>
          {CANCEL_ACTION_LABEL}
        </Button>
        {primary}
      </Stack>
    </Stack>
  );
}

/**
 * The pairing dialog: takes the one-time code shown in VS Code and hands it to
 * the service worker through the injected `submitCode` — or, in address mode,
 * saves the local service's address for a panel that is already paired.
 *
 * Renders nothing while `open` is `false`. See this module's header for the
 * modes, the security boundary, the states and the keyboard contract.
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
 *
 * @example
 * // Paired, from the pill's "Change service address…" control; the worker
 * // follows the saved address and reconnects with its current pairing. The
 * // accessor is resolved once, so its identity is stable across renders:
 * const [serviceEndpoint] = useState(() => resolveServiceEndpointAccessor());
 * <PairDialog
 *   mode="address"
 *   open={addressDialogOpen}
 *   onClose={() => setAddressDialogOpen(false)}
 *   submitCode={submitPairingCode}
 *   serviceEndpoint={serviceEndpoint}
 * />
 */
export function PairDialog(props: PairDialogProps): ReactElement | null {
  const { open, ...body } = props;
  if (!open) {
    return null;
  }
  // Keyed by mode, so a switch between modes while open starts a fresh body.
  return <PairDialogBody key={body.mode ?? 'pair'} {...body} />;
}
