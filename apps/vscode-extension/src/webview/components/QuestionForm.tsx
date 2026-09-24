/**
 * `QuestionForm` — question entry for the "Debug Generator" view in VS Code
 * (AAP 0.7.3: "textarea, submit, hint to select an element in DevTools").
 *
 * The developer's first action in the editor flow: type one plain-English
 * question and hand it up. Everything that follows — creating the session,
 * running the six pipeline stages, reporting progress — happens elsewhere.
 * `App.tsx` is the only consumer: it maps `onSubmit` onto the `askQuestion`
 * host message and drives `pending`, `disabled`, `unavailable`, `error` and
 * `onRetry` from the session state it receives from the host.
 *
 * ## The question is data, never a decision
 *
 * This component never inspects what the developer wrote (AAP 0.5.4). The one
 * test it performs is "is anything left after trimming?", expressed as a
 * length comparison; it never searches, matches or compares the text against
 * anything, which is the exact pattern `scripts/check-no-hardcoding.mjs`
 * rejects. The text is never logged either (AAP 0.5.2): it is the developer's
 * own prose and may name private code, so this module has no `console` call.
 *
 * ## One piece of state
 *
 * The draft string is the only state here. It is not persisted, not mirrored
 * into the webview state and never sent anywhere except through `onSubmit`, so
 * the host remains the single owner of everything the view shows. It survives
 * the pending and error states because it lives in this component rather than
 * in the field, which is unmounted while those states are shown.
 *
 * ## No `<form>` element, on purpose
 *
 * A form submission navigates the webview document, which would blank the
 * whole view. `Button` defaults to `type="button"`, so a form-free layout can
 * never submit-and-reload; submission happens only through the button's
 * `onClick` and the Ctrl/Cmd+Enter chord in the text area. Plain Enter keeps
 * inserting a newline, because a question may span several lines.
 *
 * ## States, in precedence order (AAP 0.5.5 — never a blank area)
 *
 *   1. `error` (non-blank) — `ErrorState` with the failure message and, when
 *      `onRetry` is supplied, its retry control. The primitive owns
 *      `role="alert"`.
 *   2. `pending` — `LoadingState` in place of the field and its controls while
 *      a submitted question is in flight. The primitive owns `role="status"`
 *      and `aria-busy`.
 *   3. `unavailable` — `EmptyState` with this component's own generic wording,
 *      because `EmptyState` ships no default copy.
 *   4. Otherwise the field, the DevTools hint and the submit row.
 *
 * ## Design system
 *
 * Only `@debuggen/panel-renderer` primitives render here — `Input` (multiline)
 * for the text area, `Button`, `Text`, `Kbd` and the three state components —
 * and every gap and alignment comes from `Stack` (AAP 0.6.4). The two classes
 * this file adds, `dgv-question-form` and `dgv-question-form__hint`, are
 * declared in `../styles.css` against `--dg-*` tokens. The action row is laid
 * out by `Stack`'s own props rather than by `dgv-question-form__actions`: that
 * rule aligns its box's items to the centre, and on a `Stack` block it would
 * centre the row instead of pinning it to the end.
 *
 * @module apps/vscode-extension/src/webview/components/QuestionForm
 */
import { useId, useState } from 'react';
import type { KeyboardEvent, ReactElement, ReactNode } from 'react';

import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  Kbd,
  LoadingState,
  Stack,
  Text,
} from '@debuggen/panel-renderer';

/**
 * Props of {@link QuestionForm}.
 *
 * Every optional member spells `| undefined`: `exactOptionalPropertyTypes` is
 * in force repository-wide, and `App.tsx` forwards values it may not have —
 * `error={failure?.message}` — which must stay legal.
 */
export interface QuestionFormProps {
  /**
   * Raised with the trimmed question when the developer submits a non-blank
   * draft, by the submit button or by Ctrl/Cmd+Enter in the text area. Never
   * raised for an empty or whitespace-only draft, and never while the form is
   * `disabled`, `pending` or `unavailable`. The draft is cleared after the
   * callback returns; if the callback throws, the draft is kept.
   */
  onSubmit: (question: string) => void;

  /**
   * The session is mid-pipeline: the field and the submit control stay
   * visible but inert. Defaults to `false`.
   */
  disabled?: boolean | undefined;

  /**
   * No session can be started yet (the local service is not reachable): an
   * empty state replaces the field. Defaults to `false`.
   */
  unavailable?: boolean | undefined;

  /**
   * A submitted question is in flight: a loading state replaces the field and
   * its controls. Defaults to `false`.
   */
  pending?: boolean | undefined;

  /**
   * The failure of the last submission or pipeline stage, as a one-sentence
   * message. A non-blank value takes precedence over every other state.
   */
  error?: string | undefined;

  /**
   * Retries the failed step. When supplied alongside `error`, the error state
   * renders a retry control that raises it; otherwise the error state is
   * informational.
   */
  onRetry?: (() => void) | undefined;

  /**
   * Extra classes composed after `dgv-question-form`, for the placement the
   * surrounding view owns. Defined in `../styles.css` against `--dg-*` tokens.
   */
  className?: string | undefined;
}

/** Root block class, declared in `../styles.css`. */
const ROOT_CLASS = 'dgv-question-form';

/** Hint element class, declared in `../styles.css`. */
const HINT_CLASS = 'dgv-question-form__hint';

/** Visible label of the text area; also its accessible name. */
const FIELD_LABEL = 'What do you want to debug?';

/** Placeholder of the text area. Generic product vocabulary only (AAP 0.5.4). */
const FIELD_PLACEHOLDER = 'For example: why does this interaction feel slow?';

/** Visible line count reserved for the question before the text area scrolls. */
const FIELD_ROWS = 4;

/** The DevTools targeting hint of AAP 0.7.3. */
const DEVTOOLS_HINT =
  'To target a specific element, select it in the Debug Generator panel in Chrome DevTools before asking.';

/** Label of the submit control; also its accessible name. */
const SUBMIT_LABEL = 'Ask question';

/** Busy announcement while a submitted question is in flight. */
const PENDING_LABEL = 'Submitting your question';

/** First line of the error state. */
const ERROR_TITLE = 'Your question could not be processed';

/**
 * Wording of the unavailable state. `EmptyState` deliberately ships no default
 * copy, so this component owns a generic sentence with no project vocabulary.
 */
const UNAVAILABLE_MESSAGE = 'Start the local service to begin a session.';

/** The two submit chords, as printed by `Kbd`. */
const SUBMIT_CHORD_CTRL: readonly string[] = ['Ctrl', 'Enter'];
const SUBMIT_CHORD_CMD: readonly string[] = ['Cmd', 'Enter'];

/**
 * Composes the root class list without `clsx` (not a dependency of this
 * workspace): the block class first, then any non-blank caller classes.
 *
 * @param className The caller's extra classes, if any.
 * @returns The class attribute value.
 */
function composeRootClass(className: string | undefined): string {
  return [ROOT_CLASS, className]
    .filter((part): part is string => part !== undefined && part.trim().length > 0)
    .join(' ');
}

/**
 * Whether the chord in `event` is the submit shortcut: Enter together with
 * Ctrl (Windows, Linux) or Cmd (macOS), and not part of an IME composition,
 * where Enter confirms the composed characters instead.
 *
 * @param event The keydown event raised by the text area.
 * @returns `true` when the event should submit the draft.
 */
function isSubmitChord(event: KeyboardEvent<HTMLElement>): boolean {
  return (
    event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing
  );
}

/**
 * Renders the question entry of the editor view, or the error, pending or
 * unavailable state that replaces it (see the module note for precedence).
 *
 * @param props See {@link QuestionFormProps}.
 * @returns The form block.
 *
 * @example
 * <QuestionForm
 *   onSubmit={(question) => postToHost({ type: 'askQuestion', question })}
 *   pending={isAsking}
 *   disabled={isRunning}
 *   unavailable={!canStartSession}
 *   error={failure?.message}
 *   onRetry={retryFailedStage}
 * />
 */
export function QuestionForm(props: QuestionFormProps): ReactElement {
  const {
    onSubmit,
    disabled = false,
    unavailable = false,
    pending = false,
    error,
    onRetry,
    className,
  } = props;

  // Hooks first and unconditionally: every state below renders through the
  // same root, so the draft survives a round trip through pending or error.
  const [draft, setDraft] = useState<string>('');
  const devtoolsHintId = useId();
  const shortcutId = useId();

  const trimmed = draft.trim();
  // A blank message is no failure worth a state of its own: treated as absent.
  const errorMessage = error !== undefined && error.trim().length > 0 ? error : undefined;
  const canSubmit =
    !disabled && !pending && !unavailable && errorMessage === undefined && trimmed.length > 0;

  /**
   * The single submit path, shared by the button and the keyboard chord.
   * Refuses silently when there is nothing to send or the form is inert — the
   * disabled button already says so — and otherwise hands the trimmed text up
   * and clears the draft.
   */
  const submit = (): void => {
    if (!canSubmit) {
      return;
    }
    onSubmit(trimmed);
    setDraft('');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!isSubmitChord(event)) {
      return;
    }
    // The chord is the form's own shortcut whatever the draft holds, so it
    // never reaches the text area or the editor as a keystroke of its own.
    event.preventDefault();
    submit();
  };

  let content: ReactNode;

  if (errorMessage !== undefined) {
    content = <ErrorState title={ERROR_TITLE} message={errorMessage} onRetry={onRetry} />;
  } else if (pending) {
    content = <LoadingState variant="block" label={PENDING_LABEL} />;
  } else if (unavailable) {
    content = <EmptyState message={UNAVAILABLE_MESSAGE} />;
  } else {
    content = (
      <>
        <Input
          multiline
          fullWidth
          label={FIELD_LABEL}
          placeholder={FIELD_PLACEHOLDER}
          rows={FIELD_ROWS}
          value={draft}
          onValueChange={setDraft}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          aria-describedby={`${devtoolsHintId} ${shortcutId}`}
        />
        <Text as="p" size="xs" tone="secondary" id={devtoolsHintId} className={HINT_CLASS}>
          {DEVTOOLS_HINT}
        </Text>
        <Stack direction="horizontal" gap={2} align="center" justify="end" wrap>
          <Text size="xs" tone="muted" id={shortcutId}>
            Press <Kbd keys={SUBMIT_CHORD_CTRL} /> or <Kbd keys={SUBMIT_CHORD_CMD} /> to ask
          </Text>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>
            {SUBMIT_LABEL}
          </Button>
        </Stack>
      </>
    );
  }

  return (
    <Stack gap={3} className={composeRootClass(className)}>
      {content}
    </Stack>
  );
}
