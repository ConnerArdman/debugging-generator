/**
 * PairingCode - the editor half of the Chrome pairing flow in the "Debug Generator" VS Code view
 * (AAP 0.5.6, 0.7.3).
 *
 * The Chrome extension cannot read the service credential file the editor reads, so it is paired
 * instead: the `debuggen.pairChrome` command asks the local service for a one-time code, this
 * component shows that code, the developer types it into the DevTools panel's pair dialog, and the
 * extension's service worker exchanges it for a devtools credential scoped to that extension. This
 * file owns code *display* only; code *entry* belongs to the DevTools panel, so there is no input
 * here.
 *
 * ## The code is a capability - displayed, never logged (AAP 0.5.2, 0.5.6)
 *
 * A pairing code is eight random characters, valid for five minutes and accepted once. Whoever holds
 * it while it is live can pair a browser, so it is treated as sensitive-but-displayed:
 *
 * - it is rendered byte-for-byte through `Code` as ordinary, selectable text - never masked, trimmed
 *   or split into boxes that would break selection - because the developer has to retype it exactly;
 * - nothing in this file writes to the console, serialises its props, puts the code in a `data-*`
 *   attribute or an error message, or reports anything anywhere;
 * - an expired code is never shown as though it still works: the moment `expiresAt` passes, the code
 *   itself is removed from the screen and replaced by an explicit "expired" notice and the control
 *   that requests a new one.
 *
 * ## One-way data
 *
 * Everything arrives as props from `App.tsx`, which projects the host's `PairingState` (see
 * `../../webview-messages`) and maps `onPair` onto the `pairChrome` webview-to-host message and
 * `onDismiss` onto `dismissPairing`. The component never requests a code itself: it has no
 * `fetch`, no socket and no host bridge, and it raises both callbacks with no arguments.
 *
 * ## Expiry without a ticking clock
 *
 * The expiry line is an absolute local time ("Expires at 14:32"), which stays true however long it
 * stays on screen, so nothing needs to tick once a second. What does change is whether the code is
 * still usable, and that is read from the clock through `useSyncExternalStore`: the store's snapshot
 * is the boolean "has `expiresAt` passed?", and its subscription arms exactly one timer for the
 * moment of expiry (re-armed only when a delay exceeds what `setTimeout` can hold). The render body
 * therefore never reads the clock itself, a code that is already stale when it arrives renders as
 * expired on the very first paint, and the timer is released whenever the code or the component
 * goes away.
 *
 * ## States, in precedence order (AAP 0.5.5 - never a blank area)
 *
 *   1. `error` (non-blank) - `ErrorState` with the host's message and a retry control that requests
 *      a new code. The primitive owns `role="alert"`; the code is never part of the text.
 *   2. `pending` - `LoadingState` while a code is being requested. The primitive owns
 *      `role="status"` and `aria-busy`.
 *   3. no code - `EmptyState` with this component's own generic copy, because `EmptyState` ships
 *      none, and the control that requests a code as its action.
 *   4. otherwise the instructions, the code (or the expired notice), the expiry line and the
 *      request-again control, with "Hide code" beside a live code and "Dismiss" beside an expired
 *      notice, which has no code left to hide. The code region is a polite `role="status"` live
 *      region, so a newly issued code - and its expiry - is announced without interrupting.
 *
 * ## Copying the code
 *
 * A live code carries a "Copy" control (named "Copy pairing code") that writes the code to the
 * system clipboard through `navigator.clipboard.writeText`, so it can be pasted into the pair dialog
 * rather than retyped. The outcome is a line of text inside the code's live region - "Copied" or,
 * when the clipboard is unavailable or refuses the write, an instruction to select the code
 * instead - announced politely and drawn without animation. The outcome is remembered together
 * with the code it copied, so it is shown only beside that same code: a replacement code, an
 * expiry or a dismissal clears it without a timer. The write is a user-initiated action on data
 * already on screen; nothing about it, including a failure, is logged.
 *
 * ## Design system (AAP 0.6.4)
 *
 * Only `@debuggen/panel-renderer` primitives render content - `Code`, `Text`, `Badge`, `Button` and
 * the three state components - and every gap and alignment comes from `Stack`. The five classes
 * used here, `dgv-pairing`, `dgv-pairing__code`, `dgv-pairing__copy`, `dgv-pairing__copy-status`
 * and `dgv-pairing__expiry`, are declared in `../styles.css` against `--dg-*` tokens only; that
 * stylesheet also sets the code in the heading role's size in the monospace face. There is no
 * inline style and no raw control or heading element. All copy is generic product vocabulary (AAP
 * 0.5.4) and names no route.
 *
 * @module apps/vscode-extension/src/webview/components/PairingCode
 */
import { useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactElement, ReactNode } from 'react';

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

/**
 * Props of {@link PairingCode}.
 *
 * Every optional member spells `| undefined` because `exactOptionalPropertyTypes` is in force
 * repository-wide: `App.tsx` forwards values it may not have (`code={pairing?.code}`), and that
 * must stay legal.
 */
export interface PairingCodeProps {
  /**
   * The one-time code on display, exactly as the service issued it. Absent (or blank) while no
   * code has been requested, which renders the request state instead.
   */
  code?: string | undefined;

  /**
   * When the code stops being accepted, in Unix epoch milliseconds - the product's canonical time
   * base (AAP 0.2.3). When it is absent or not a representable time, the expiry is reported as
   * unknown rather than guessed.
   */
  expiresAt?: number | undefined;

  /**
   * Requests a pairing code - the first one, a replacement, or a retry after a failure. Raised with
   * no arguments; `App.tsx` maps it onto the `pairChrome` webview-to-host message.
   */
  onPair: () => void;

  /**
   * Hides the code on display. Raised with no arguments; `App.tsx` maps it onto the
   * `dismissPairing` webview-to-host message.
   */
  onDismiss: () => void;

  /** A code is being requested. Replaces the content with a busy placeholder. */
  pending?: boolean | undefined;

  /**
   * Why the last request for a code failed, as the host reported it. A non-blank value takes
   * precedence over every other state.
   */
  error?: string | undefined;

  /** Extra classes composed after the `dgv-pairing` block, for the layout `App.tsx` owns. */
  className?: string | undefined;
}

// ---------------------------------------------------------------------------
// Classes - declared in ../styles.css against --dg-* tokens
// ---------------------------------------------------------------------------

/** The block class every state renders on its root, so `App.tsx` places each state alike. */
const ROOT_CLASS = 'dgv-pairing';

/** The surface the code (or the expired notice) sits on; also the polite live region. */
const CODE_CLASS = 'dgv-pairing__code';

/** The expiry line under the code. */
const EXPIRY_CLASS = 'dgv-pairing__expiry';

/** The control that copies the code, placed at the end of the code row. */
const COPY_CLASS = 'dgv-pairing__copy';

/** The outcome line of the last copy, on its own line inside the code region. */
const COPY_STATUS_CLASS = 'dgv-pairing__copy-status';

// ---------------------------------------------------------------------------
// Copy - generic product vocabulary only (AAP 0.5.4); no route, no identifier
// ---------------------------------------------------------------------------

/** The first line of the request state. */
const EMPTY_TITLE = 'Pair Chrome DevTools';

/** Why a code is needed, shown while none is on display. */
const EMPTY_MESSAGE =
  'The Debug Generator panel in Chrome DevTools needs a one-time pairing code before it can connect.';

/** The control that requests the first code; also its accessible name. */
const REQUEST_LABEL = 'Get pairing code';

/** The control that requests a replacement code; also its accessible name. */
const RENEW_LABEL = 'Get a new code';

/** The control that hides a live code; also its accessible name. */
const DISMISS_LABEL = 'Hide code';

/**
 * The control that closes the expired notice; also its accessible name. An expired code is no
 * longer on screen, so there is no code to hide.
 */
const DISMISS_EXPIRED_LABEL = 'Dismiss';

/** The visible label of the copy control. */
const COPY_LABEL = 'Copy';

/** The accessible name of the copy control, which begins with its visible label (WCAG 2.5.3). */
const COPY_NAME = 'Copy pairing code';

/** The outcome line after the code was written to the clipboard. */
const COPIED_MESSAGE = 'Copied';

/** The outcome line when the clipboard is unavailable or refused the write. */
const COPY_FAILED_MESSAGE = 'Could not copy the code. Select it and copy it instead.';

/** Announced, not painted, while a code is requested; `LoadingState` appends the `…`. */
const PENDING_LABEL = 'Requesting a pairing code';

/** The first line of the error state, replacing `ErrorState`'s generic view-loading title. */
const ERROR_TITLE = 'Could not get a pairing code';

/** The retry control of the error state, which requests a code again. */
const RETRY_LABEL = 'Try again';

/** What to do with a live code. */
const LIVE_INSTRUCTIONS =
  'Enter this code in the Debug Generator panel in Chrome DevTools. It can be used once.';

/** What to do once the code on display has expired. */
const EXPIRED_INSTRUCTIONS =
  'Get a new code, then enter it in the Debug Generator panel in Chrome DevTools.';

/** The visible label beside the code, read with it by the live region. */
const CODE_LABEL = 'Pairing code';

/** The badge that replaces the code once it has expired; text, so tone is never the only cue. */
const EXPIRED_BADGE = 'Expired';

/** The notice that replaces the code once it has expired. */
const EXPIRED_MESSAGE = 'This pairing code has expired and can no longer be used.';

/** The expiry line when the service reported no usable expiry time. */
const UNKNOWN_EXPIRY = 'Expiry time not reported.';

/** Leads the expiry time while the code is live. */
const EXPIRES_PREFIX = 'Expires at';

/** Leads the expiry time once the code has expired. */
const EXPIRED_PREFIX = 'Expired at';

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * The largest absolute epoch-millisecond value a `Date` can represent (ECMA-262 §21.4.1.1). Beyond
 * it `toISOString()` and `Intl.DateTimeFormat#format` throw, so such a value is treated as an
 * unknown expiry rather than allowed to break the render.
 */
const MAX_DATE_MS = 8.64e15;

/**
 * The longest delay `setTimeout` honours (a signed 32-bit millisecond count, about 24.8 days).
 * A longer delay fires immediately, so a far-off expiry is waited for in hops of at most this.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Formats the expiry as a local wall-clock time (hours and minutes) in the webview's locale.
 * Created once: the locale cannot change under a loaded webview.
 */
const EXPIRY_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * Whether an expiry is a time this component can reason about and display.
 *
 * @param expiresAt The expiry in epoch milliseconds, if any.
 * @returns `true` for a finite value inside the range a `Date` can represent.
 */
function isKnownExpiry(expiresAt: number | undefined): expiresAt is number {
  return (
    expiresAt !== undefined && Number.isFinite(expiresAt) && Math.abs(expiresAt) <= MAX_DATE_MS
  );
}

/** The unsubscribe function of a subscription that armed nothing. */
function releaseNothing(): void {
  // No timer was armed, so there is nothing to release.
}

/** How the clock is read and watched for one expiry, in the shape `useSyncExternalStore` takes. */
interface ExpiryStore {
  /** Arms the expiry timer and returns the function that releases it. */
  subscribe: (onChange: () => void) => () => void;
  /** Whether the expiry has passed, read from the clock at call time. */
  readExpired: () => boolean;
}

/**
 * Builds the clock store for one expiry.
 *
 * The snapshot is a boolean, so React compares successive readings by value and re-renders only
 * when the answer flips. The subscription arms a single timer for the moment of expiry; a timer
 * that fires early (a clamped hop, or a clock that moved) simply re-arms for what remains.
 *
 * @param expiresAt The expiry in epoch milliseconds, if any.
 * @returns The store; for an unknown expiry it never reports expiry and arms nothing.
 */
function createExpiryStore(expiresAt: number | undefined): ExpiryStore {
  if (!isKnownExpiry(expiresAt)) {
    return {
      subscribe: () => releaseNothing,
      readExpired: () => false,
    };
  }

  const deadline = expiresAt;

  return {
    subscribe: (onChange) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const arm = (): void => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          timer = undefined;
          onChange();
          return;
        }
        timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
      };

      arm();

      return () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
    },
    readExpired: () => deadline <= Date.now(),
  };
}

/**
 * Whether the code's expiry has passed, kept current by one timer rather than a ticking clock.
 *
 * @param expiresAt The expiry in epoch milliseconds, if any.
 * @returns `true` once `expiresAt` is at or before the current time; always `false` for an unknown
 *   expiry.
 */
function useHasExpired(expiresAt: number | undefined): boolean {
  const store = useMemo(() => createExpiryStore(expiresAt), [expiresAt]);
  return useSyncExternalStore(store.subscribe, store.readExpired, store.readExpired);
}

/**
 * Renders the expiry line's content: the lead-in and a machine-readable `<time>`.
 *
 * @param expiresAt The expiry in epoch milliseconds, if any.
 * @param expired Whether the expiry has passed, which selects the lead-in.
 * @returns The line's content; the unknown-expiry copy when there is no usable time.
 */
function renderExpiry(expiresAt: number | undefined, expired: boolean): ReactNode {
  if (!isKnownExpiry(expiresAt)) {
    return UNKNOWN_EXPIRY;
  }
  const moment = new Date(expiresAt);
  return (
    <>
      {expired ? EXPIRED_PREFIX : EXPIRES_PREFIX}{' '}
      <time dateTime={moment.toISOString()}>{EXPIRY_TIME_FORMAT.format(moment)}</time>
    </>
  );
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/** How the last copy ended, and for which code. */
interface CopyResult {
  /** The code that was copied; the outcome is shown only while this code is on display. */
  readonly code: string;
  /** Whether the clipboard accepted the write. */
  readonly copied: boolean;
}

/**
 * Writes text to the system clipboard.
 *
 * The clipboard is absent outside a secure context and may refuse a write (a denied permission, a
 * lost user activation), so every failure - absence, a synchronous throw or a rejection - settles
 * the returned promise with `false` rather than rejecting it. Nothing is logged.
 *
 * @param text The text to write.
 * @returns A promise that settles with `true` once the clipboard holds the text, `false` otherwise;
 *   it never rejects.
 */
function writeToClipboard(text: string): Promise<boolean> {
  // Declared wider than the DOM typing, which assumes a secure context: the clipboard is
  // `undefined` in an insecure one.
  const clipboard: Clipboard | undefined = navigator.clipboard;
  if (clipboard === undefined) {
    return Promise.resolve(false);
  }
  try {
    return clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether a string carries anything beyond whitespace.
 *
 * @param value The string, if any.
 * @returns `true` for a non-blank string.
 */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/**
 * Composes the root class list without `clsx`, which is not a dependency of this workspace.
 *
 * @param className The caller's extra classes, if any.
 * @returns `dgv-pairing`, followed by the caller's classes when they are not blank.
 */
function composeRootClassName(className: string | undefined): string {
  const extra = className?.trim() ?? '';
  return extra.length === 0 ? ROOT_CLASS : `${ROOT_CLASS} ${extra}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders the pairing code in whichever of its states the props select.
 *
 * @param props See {@link PairingCodeProps}.
 * @returns The `dgv-pairing` block holding the error, busy, request or code state.
 */
export function PairingCode(props: PairingCodeProps): ReactElement {
  const { code, expiresAt, onPair, onDismiss, pending = false, error, className } = props;

  // Whether a code is on display at all. Only then is the expiry watched, so a stale `expiresAt`
  // left beside an absent code arms no timer.
  const hasCode = hasText(code);

  // Declared before any branch, as a hook must be, so switching between states never changes the
  // hook order.
  const expired = useHasExpired(hasCode ? expiresAt : undefined);
  const [copyResult, setCopyResult] = useState<CopyResult | undefined>(undefined);

  const rootClassName = composeRootClassName(className);

  // Both callbacks are raised with no arguments: the click event is the view's business, not the
  // host's, and `App.tsx` maps each onto a payload-free webview-to-host message. Each also forgets
  // the last copy outcome, which belongs to the code being replaced or hidden.
  const requestCode = (): void => {
    setCopyResult(undefined);
    onPair();
  };
  const dismiss = (): void => {
    setCopyResult(undefined);
    onDismiss();
  };

  // Copies the code on display and records the outcome against that code, so an answer that
  // arrives after the code was replaced is never shown beside the replacement.
  const copyCode = (): void => {
    if (!hasText(code)) {
      return;
    }
    const copiedCode = code;
    void writeToClipboard(copiedCode).then((copied) => {
      setCopyResult({ code: copiedCode, copied });
    });
  };

  // The outcome line belongs to the code it copied, and to a live one only.
  const copyStatus =
    copyResult !== undefined && copyResult.code === code && !expired
      ? copyResult.copied
        ? COPIED_MESSAGE
        : COPY_FAILED_MESSAGE
      : undefined;

  let content: ReactNode;

  if (hasText(error)) {
    content = (
      <ErrorState
        title={ERROR_TITLE}
        message={error}
        onRetry={requestCode}
        retryLabel={RETRY_LABEL}
      />
    );
  } else if (pending) {
    content = <LoadingState variant="block" label={PENDING_LABEL} />;
  } else if (!hasCode) {
    content = (
      <EmptyState
        title={EMPTY_TITLE}
        message={EMPTY_MESSAGE}
        action={
          <Button variant="primary" onClick={requestCode}>
            {REQUEST_LABEL}
          </Button>
        }
      />
    );
  } else {
    // The four children keep their positions whether or not the code has expired, so React keeps
    // the same live-region element across the change and the expiry is announced in place.
    content = (
      <>
        <Text as="p" size="sm" tone="secondary">
          {expired ? EXPIRED_INSTRUCTIONS : LIVE_INSTRUCTIONS}
        </Text>
        <div className={CODE_CLASS} role="status" aria-live="polite">
          {expired ? (
            <>
              <Badge tone="warning">{EXPIRED_BADGE}</Badge>
              <Text size="sm">{EXPIRED_MESSAGE}</Text>
            </>
          ) : (
            <>
              <Text size="sm" tone="secondary">
                {CODE_LABEL}
              </Text>
              <Code size="md" translate="no">
                {code}
              </Code>
              <Button
                variant="secondary"
                size="sm"
                className={COPY_CLASS}
                aria-label={COPY_NAME}
                onClick={copyCode}
              >
                {COPY_LABEL}
              </Button>
              {copyStatus === undefined ? null : (
                <Text
                  size="xs"
                  tone={copyStatus === COPIED_MESSAGE ? 'success' : 'warning'}
                  className={COPY_STATUS_CLASS}
                >
                  {copyStatus}
                </Text>
              )}
            </>
          )}
        </div>
        <Text as="p" size="xs" tone="secondary" className={EXPIRY_CLASS}>
          {renderExpiry(expiresAt, expired)}
        </Text>
        <Stack direction="horizontal" gap={2} align="center" justify="end" wrap>
          <Button variant={expired ? 'primary' : 'secondary'} onClick={requestCode}>
            {RENEW_LABEL}
          </Button>
          <Button variant="ghost" onClick={dismiss}>
            {expired ? DISMISS_EXPIRED_LABEL : DISMISS_LABEL}
          </Button>
        </Stack>
      </>
    );
  }

  return (
    <Stack gap={2} className={rootClassName}>
      {content}
    </Stack>
  );
}
