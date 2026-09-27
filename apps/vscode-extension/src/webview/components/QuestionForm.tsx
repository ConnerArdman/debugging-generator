/**
 * `QuestionForm` — question entry for the "Debug Generator" view in VS Code
 * (AAP 0.7.3: "textarea, submit, hint to select an element in DevTools").
 *
 * The developer's first action in the editor flow: type one plain-English
 * question and hand it up. Everything that follows — creating the session,
 * running the six pipeline stages, reporting progress — happens elsewhere.
 * `App.tsx` is the only consumer: it maps `onSubmit` onto the `askQuestion`
 * host message and drives `pending`, `disabled`, `unavailable`, `error`,
 * `onRetry` and `submission` from the session state it receives from the host.
 *
 * ## The question is data, never a decision
 *
 * This component never inspects what the developer wrote (AAP 0.5.4). The two
 * tests it performs — "is anything left after trimming?" and "has the draft
 * reached the limit?" — are length comparisons; it never searches, matches or
 * compares the text against anything, which is the exact pattern
 * `scripts/check-no-hardcoding.mjs` rejects. The text is never logged either
 * (AAP 0.5.2): it is the developer's own prose and may name private code, so
 * this module has no `console` call.
 *
 * ## Length and blank drafts
 *
 * The field's native `maxLength` is `MAX_WEBVIEW_QUESTION_LENGTH` from
 * `../../webview-messages` — the protocol's own question limit, which the host
 * and the service enforce too — so the browser stops typing there and truncates
 * a longer paste. A counter under the field (`1,234 / 2,000 characters`)
 * describes it through `aria-describedby` rather than a live region, so it is
 * heard with the field and never once per keystroke, and turns to the `warning`
 * tone with a sentence saying longer text is cut off once the draft is full.
 * The submit chord pressed on a blank draft marks the field invalid with a
 * short message, cleared as soon as the draft holds text.
 *
 * ## The draft, kept until the question is accepted
 *
 * The draft string is the only content held here. It is not persisted, not
 * mirrored into the webview state and never sent anywhere except through
 * `onSubmit`, so the host remains the single owner of everything the view
 * shows. It survives the error and unavailable states because it lives in this
 * component rather than in the field, which is unmounted while those states
 * are shown; the pending state keeps the field on screen, read-only and
 * showing the draft that was submitted.
 *
 * Submitting does NOT clear it: posting the question, or the service request
 * behind it, can still fail, and the developer must never have to retype a
 * question the host did not take. The parent reports how the submission ended
 * through `submission` — `accepted` clears the draft; `failed` keeps it and
 * shows a retry hint under the field until the next submit. Each outcome is
 * applied exactly once, by its `seq`, with React's "adjust state while
 * rendering" pattern: the last applied `seq` is state and is compared during
 * render, so a re-render that passes the same outcome again changes nothing
 * and no effect is needed. An outcome already present when the form mounts
 * belongs to a submission this instance never made, and is not applied.
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
 *   2. `pending` — while a submitted question is in flight the form stays on
 *      screen: the field is `readOnly` (never `disabled`, so it keeps focus and
 *      its text stays selectable) and shows the submitted draft, the submit
 *      control is disabled, and a visible `role="status"` line in place of the
 *      shortcut hint says the question is being submitted. Pending outranks
 *      `disabled` for the field: the session snapshot that arrives before the
 *      request's own result must not disable the field under the caret.
 *   3. `unavailable` — `EmptyState` with this component's own generic wording,
 *      because `EmptyState` ships no default copy.
 *   4. Otherwise the field, the retry hint when the last submission failed,
 *      the DevTools hint and the submit row.
 *
 * ## Focus
 *
 * Submitting by the chord leaves focus in the field, which stays mounted
 * through the pending state. Submitting by the button leaves it on a control
 * that the pending state disables, and a browser then drops focus to the
 * document. So whenever the pending state begins or ends while the field is on
 * screen and focus has been lost — to the document body, to a detached element
 * or to a disabled control — focus returns to the field, without scrolling.
 * Focus the developer has moved anywhere else is left where it is. The field
 * is addressed by the id this component gives it, because `Input` exposes no
 * ref.
 *
 * ## The active session's question
 *
 * `currentQuestion` is the question the active session was started with, as
 * the host's snapshot carries it. When it holds text it is shown above
 * whichever state is rendered — under a muted label, verbatim, line breaks
 * kept — so the view always says what is being investigated, including while
 * the field below is inert, busy or offered for a new question. It is only
 * displayed: this component never reads it beyond "is anything there?", never
 * copies it into the draft and never submits it.
 *
 * ## Design system
 *
 * Only `@debuggen/panel-renderer` primitives render here — `Input` (multiline)
 * for the text area, `Button`, `Text`, `Kbd`, `ErrorState` and `EmptyState` —
 * and every gap and alignment comes from `Stack` (AAP 0.6.4). The two classes
 * this file adds, `dgv-question-form` and `dgv-question-form__hint`, are
 * declared in `../styles.css` against `--dg-*` tokens, and the session's
 * question uses that stylesheet's shared `dgv-asked__text`; the retry hint is a
 * plain `Text` in the design system's `warning` tone and adds no class. The
 * action row is laid out by `Stack`'s own props rather than by
 * `dgv-question-form__actions`: that rule aligns its box's items to the
 * centre, and on a `Stack` block it would centre the row instead of pinning it
 * to the end.
 *
 * @module apps/vscode-extension/src/webview/components/QuestionForm
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement, ReactNode } from 'react';

import { Button, EmptyState, ErrorState, Input, Kbd, Stack, Text } from '@debuggen/panel-renderer';

import { MAX_WEBVIEW_QUESTION_LENGTH } from '../../webview-messages';
import type { SubmissionOutcome } from '../pending-actions';

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
   * `disabled`, `pending` or `unavailable`. The draft is kept: it is cleared
   * only when {@link QuestionFormProps.submission} reports the submission
   * accepted.
   */
  onSubmit: (question: string) => void;

  /**
   * How the latest submission ended, from `./pending-actions`. Each distinct
   * `seq` is applied once: `accepted` clears the draft; `failed` keeps it and
   * shows a retry hint under the field until the next submit. The parent is
   * expected to hold `pending` while a submission is in flight, so the draft
   * cannot change between the submit and its outcome. An outcome already
   * present when the form mounts is not applied.
   */
  submission?: SubmissionOutcome | undefined;

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
   * A submitted question is in flight: the field stays on screen, read-only
   * and showing the draft, the submit control is disabled, and a visible busy
   * status replaces the shortcut hint. Outranks `disabled` and `unavailable`.
   * Defaults to `false`.
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
   * The active session's question, exactly as the host's snapshot carries it
   * (`SessionRecord.question`). Shown verbatim above the form in every state
   * when it holds any non-whitespace text; absent or blank, nothing is shown.
   * Display only: it never becomes the draft and is never submitted.
   */
  currentQuestion?: string | undefined;

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

/**
 * The session question's text class, shared with the follow-up list and
 * declared in `../styles.css`: it keeps the developer's line breaks and wraps
 * a long token instead of widening the view.
 */
const ASKED_TEXT_CLASS = 'dgv-asked__text';

/** The label above the active session's question. Generic product copy. */
const CURRENT_QUESTION_LABEL = 'This session’s question';

/** Visible label of the text area; also its accessible name. */
const FIELD_LABEL = 'What do you want to debug?';

/** Placeholder of the text area. Generic product vocabulary only (AAP 0.5.4). */
const FIELD_PLACEHOLDER = 'For example: why does this interaction feel slow?';

/** Visible line count reserved for the question before the text area scrolls. */
const FIELD_ROWS = 4;

/**
 * The hint to select an element in DevTools. The DevTools panel picks an
 * element only for the session its tab is bound to, and the service records
 * the pick on that session, whose follow-up questions then use it; a new
 * question starts a session without one. So the hint places the pick after
 * the question, never before it.
 */
const DEVTOOLS_HINT =
  'To target a specific element, pick it in the Debug Generator panel in Chrome DevTools once your session is running; follow-up questions use it.';

/** Label of the submit control; also its accessible name. */
const SUBMIT_LABEL = 'Ask question';

/** Busy announcement while a submitted question is in flight. */
const PENDING_LABEL = 'Submitting your question';

/** First line of the error state. */
const ERROR_TITLE = 'Your question could not be processed';

/**
 * Shown under the field after a submission failed — refused by the host
 * channel, reported failed by the host, or never acknowledged — until the next
 * submit. Generic product vocabulary only (AAP 0.5.4).
 */
const RETRY_HINT = `Your question was not confirmed, so it is kept here. Press “${SUBMIT_LABEL}” to try again.`;

/**
 * Wording of the unavailable state. `EmptyState` deliberately ships no default
 * copy, so this component owns a generic sentence with no project vocabulary.
 */
const UNAVAILABLE_MESSAGE = 'Start the local service to begin a session.';

/** The two submit chords, as printed by `Kbd`. */
const SUBMIT_CHORD_CTRL: readonly string[] = ['Ctrl', 'Enter'];
const SUBMIT_CHORD_CMD: readonly string[] = ['Cmd', 'Enter'];

/**
 * Formats the character counter: the locale's digit grouping and no fraction, the same format
 * `App.tsx` uses when it states the limit in a notice.
 */
const COUNT_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/** The question limit as the counter prints it, e.g. `2,000`. */
const LIMIT_TEXT = COUNT_FORMAT.format(MAX_WEBVIEW_QUESTION_LENGTH);

/**
 * Appended to the counter once the draft holds {@link MAX_WEBVIEW_QUESTION_LENGTH} characters:
 * the field's native `maxLength` stops typing there and cuts a longer paste off, and this is
 * what tells the developer why.
 */
const LIMIT_REACHED_TEXT = 'Limit reached: longer text is cut off.';

/**
 * Appended to the counter when the draft holds more than {@link MAX_WEBVIEW_QUESTION_LENGTH}
 * characters. `maxLength` constrains only the developer's own edits, so this is a value written
 * into the field some other way; nothing was cut off, and `App.tsx` will not send it until it is
 * shortened.
 */
const OVER_LIMIT_TEXT = 'Over the limit: shorten it to ask.';

/**
 * Inline validation shown when the Ctrl/Cmd+Enter chord is pressed on a blank draft, until the
 * draft holds text again. Generic product vocabulary only (AAP 0.5.4).
 */
const BLANK_DRAFT_MESSAGE = 'Type a question before asking.';

/**
 * The counter line under the field, e.g. `1,234 / 2,000 characters`, with the limit-reached
 * sentence once the draft is full and the over-limit sentence past it.
 *
 * @param length The draft's length in UTF-16 code units, the unit `maxLength` counts.
 * @returns The counter text.
 */
function counterText(length: number): string {
  const count = `${COUNT_FORMAT.format(length)} / ${LIMIT_TEXT} characters`;
  if (length > MAX_WEBVIEW_QUESTION_LENGTH) {
    return `${count}. ${OVER_LIMIT_TEXT}`;
  }
  return length === MAX_WEBVIEW_QUESTION_LENGTH ? `${count}. ${LIMIT_REACHED_TEXT}` : count;
}

/**
 * The visible busy line while a submitted question is in flight: the pending label with the
 * single `…` every busy region of the design system ends with.
 */
const PENDING_TEXT = `${PENDING_LABEL}…`;

/**
 * Whether keyboard focus has been lost rather than moved: nothing is focused, the document body
 * is, or the focused element has been removed from the document or disabled. A browser drops
 * focus to the body in both of the last two cases; checking them as well keeps the answer the
 * same in environments that leave `activeElement` on the element.
 *
 * @param active The document's active element.
 * @returns `true` when focus has nowhere useful to be.
 */
function focusWasLost(active: Element | null): boolean {
  if (active === null || active === document.body || !active.isConnected) {
    return true;
  }
  return active instanceof HTMLButtonElement && active.disabled;
}

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
 * Renders the question entry of the editor view — read-only with a busy status
 * while `pending` — or the error or unavailable state that replaces it (see
 * the module note for precedence).
 *
 * @param props See {@link QuestionFormProps}.
 * @returns The form block.
 *
 * @example
 * <QuestionForm
 *   onSubmit={(question) => postToHost({ type: 'askQuestion', question })}
 *   pending={isPending(pendingActions, 'askQuestion')}
 *   submission={pendingActions.outcomes.askQuestion}
 *   disabled={isRunning}
 *   unavailable={!canStartSession}
 *   error={failure?.message}
 *   onRetry={retryFailedStage}
 * />
 */
export function QuestionForm(props: QuestionFormProps): ReactElement {
  const {
    onSubmit,
    submission,
    disabled = false,
    unavailable = false,
    pending = false,
    error,
    onRetry,
    currentQuestion,
    className,
  } = props;

  // Hooks first and unconditionally: every state below renders through the
  // same root, so the draft survives a round trip through pending or error.
  const [draft, setDraft] = useState<string>('');
  // The `seq` of the last submission outcome applied. Initialised from the
  // outcome present at mount, which belongs to no submission of this instance.
  const [appliedSeq, setAppliedSeq] = useState<number | undefined>(submission?.seq);
  // Whether the last applied outcome was a failure the next submit clears.
  const [retryHintShown, setRetryHintShown] = useState<boolean>(false);
  // Whether the submit chord was pressed on a blank draft; cleared once the draft holds text.
  const [blankAttempted, setBlankAttempted] = useState<boolean>(false);
  // The field's id. `Input` exposes no ref, and addressing the control by the
  // id its caller supplied is the focus route that primitive documents.
  const fieldId = useId();
  const devtoolsHintId = useId();
  const shortcutId = useId();
  const retryHintId = useId();
  const counterId = useId();
  const busyId = useId();
  // The `pending` value whose focus consequence has been handled; read and
  // written by the focus effect only.
  const focusHandledPending = useRef<boolean>(pending);

  // Whenever the pending state begins or ends, after it is on screen: a field
  // that is showing gets focus back when focus was lost (see the module note),
  // and only then. A disabled field cannot take it, which is the one case it
  // stays lost: the accepted question's session is running.
  useEffect(() => {
    if (focusHandledPending.current === pending) {
      return;
    }
    focusHandledPending.current = pending;
    const field = document.getElementById(fieldId);
    if (field !== null && focusWasLost(document.activeElement)) {
      field.focus({ preventScroll: true });
    }
  }, [pending, fieldId]);

  // React's "adjust state while rendering" pattern: a new outcome is applied
  // here, once per `seq`, and React re-renders before committing, so neither a
  // stale draft nor a second application ever reaches the screen.
  if (submission !== undefined && submission.seq !== appliedSeq) {
    setAppliedSeq(submission.seq);
    if (submission.status === 'accepted') {
      setDraft('');
      setRetryHintShown(false);
    } else {
      setRetryHintShown(true);
    }
  }

  const trimmed = draft.trim();
  // A blank message is no failure worth a state of its own: treated as absent.
  const errorMessage = error !== undefined && error.trim().length > 0 ? error : undefined;
  // The form is live: a submit would be handed up if the draft held text.
  const acceptsInput = !disabled && !pending && !unavailable && errorMessage === undefined;
  const canSubmit = acceptsInput && trimmed.length > 0;
  // Lengths only (AAP 0.5.4). `maxLength` keeps the draft within the limit, so reaching it is
  // the one state the counter warns about.
  const atLimit = draft.length >= MAX_WEBVIEW_QUESTION_LENGTH;
  const blankShown = blankAttempted && acceptsInput && trimmed.length === 0;

  /**
   * Replaces the draft with what the field now holds, and retires the blank-draft message as
   * soon as the draft holds text again. The flag is cleared only when it is set, for the reason
   * {@link submit} gives about no-op updates.
   *
   * @param next The field's full next value.
   */
  const changeDraft = (next: string): void => {
    setDraft(next);
    if (blankAttempted && next.trim().length > 0) {
      setBlankAttempted(false);
    }
  };

  /**
   * The single submit path, shared by the button and the keyboard chord.
   * Refuses when there is nothing to send or the form is inert. A blank draft
   * submitted by the chord — the disabled button cannot be pressed — shows an
   * inline validation message on the field until the draft holds text; an inert
   * form refuses silently. Otherwise the trimmed text is handed up, the draft is
   * kept until `submission` reports it accepted, and the retry hint of the
   * previous attempt is retired.
   *
   * The hint is retired only when it is showing. A no-op `setState` from an
   * event is not discarded by React: it stays queued and is replayed on the
   * next render, which would then run after — and undo — the render-time
   * application of this very submission's `failed` outcome.
   */
  const submit = (): void => {
    if (!canSubmit) {
      if (acceptsInput && !blankAttempted) {
        setBlankAttempted(true);
      }
      return;
    }
    onSubmit(trimmed);
    if (retryHintShown) {
      setRetryHintShown(false);
    }
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
  } else if (unavailable && !pending) {
    content = <EmptyState message={UNAVAILABLE_MESSAGE} />;
  } else {
    // The data state, or the pending state drawn over it: the field keeps the
    // submitted draft on screen and focus in place, read-only rather than
    // disabled, while the status line replaces the shortcut hint.
    const fieldDescription = [
      counterId,
      ...(retryHintShown ? [retryHintId] : []),
      devtoolsHintId,
      pending ? busyId : shortcutId,
    ].join(' ');
    content = (
      <>
        <Input
          id={fieldId}
          multiline
          fullWidth
          label={FIELD_LABEL}
          placeholder={FIELD_PLACEHOLDER}
          rows={FIELD_ROWS}
          maxLength={MAX_WEBVIEW_QUESTION_LENGTH}
          value={draft}
          onValueChange={changeDraft}
          onKeyDown={handleKeyDown}
          disabled={disabled && !pending}
          readOnly={pending}
          invalid={blankShown}
          errorMessage={BLANK_DRAFT_MESSAGE}
          aria-describedby={fieldDescription}
        />
        {/* Described by the field, not live: announced with it, never once per keystroke. */}
        <Text as="p" size="xs" tone={atLimit ? 'warning' : 'muted'} numeric id={counterId}>
          {counterText(draft.length)}
        </Text>
        {retryHintShown ? (
          <Text as="p" size="xs" tone="warning" id={retryHintId}>
            {RETRY_HINT}
          </Text>
        ) : null}
        <Text as="p" size="xs" tone="secondary" id={devtoolsHintId} className={HINT_CLASS}>
          {DEVTOOLS_HINT}
        </Text>
        <Stack direction="horizontal" gap={2} align="center" justify="end" wrap>
          {pending ? (
            // Visible and announced once, politely, as the request begins.
            <Text size="xs" tone="secondary" role="status" id={busyId}>
              {PENDING_TEXT}
            </Text>
          ) : (
            <Text size="xs" tone="muted" id={shortcutId}>
              Press <Kbd keys={SUBMIT_CHORD_CTRL} /> or <Kbd keys={SUBMIT_CHORD_CMD} /> to ask
            </Text>
          )}
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>
            {SUBMIT_LABEL}
          </Button>
        </Stack>
      </>
    );
  }

  // The active session's question, above every state and in the same position
  // in each, so the state below can change without remounting it. Tested for
  // emptiness only, and rendered as given.
  const sessionQuestion =
    currentQuestion !== undefined && currentQuestion.trim().length > 0 ? (
      <Stack gap={1}>
        <Text as="p" size="xs" tone="muted">
          {CURRENT_QUESTION_LABEL}
        </Text>
        <Text as="p" className={ASKED_TEXT_CLASS}>
          {currentQuestion}
        </Text>
      </Stack>
    ) : null;

  return (
    <Stack gap={3} className={composeRootClass(className)}>
      {sessionQuestion}
      {content}
    </Stack>
  );
}
