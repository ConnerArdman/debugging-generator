/**
 * FollowUp - the follow-up question entry of the "Debug Generator" VS Code view (AAP 0.7.3).
 *
 * Once a session has produced a result, the developer can ask a further question about it. The
 * local service's follow-up stage (AAP 0.4.2) then decides whether the stored capture already
 * answers it - regenerating the analysis and panel as new versions - or whether an additive
 * capture is needed. None of that is decided here: this component's single job is to collect the
 * new question and hand it up through `onSubmit`, which `App.tsx` maps onto the `askFollowUp`
 * webview-to-host message. The copy that asks the developer to reproduce the issue again belongs
 * to the progress and capture components, and is deliberately not repeated here.
 *
 * ## One-way data, local state for the draft only
 *
 * Everything the component shows arrives as props from `App.tsx`, which owns the whole webview
 * snapshot; the only content kept here is the draft, with the bookkeeping of the last submission
 * outcome applied to it. The component posts nothing, fetches nothing and opens no socket
 * (AAP 0.4.2), and the gate is a prop: whether a result exists is `App.tsx`'s decision from the
 * host's snapshot, never an inference made here by looking at an analysis object. So is the
 * reason the gate is closed (`unavailableReason`), which only selects the sentence that explains
 * it.
 *
 * ## What was asked stays on screen
 *
 * The follow-ups already asked in the session (`asked`, the record's `followUps`) are listed
 * above the entry, oldest first, in every state — so the question a regenerated analysis answers
 * is never missing from the view, and the busy, error or closed entry below it never hides what
 * was asked. Each question is rendered verbatim with its outcome as a badge whose text names it
 * (answered, needs a new capture, answering from the stored capture, awaiting an answer), so the
 * outcome is never carried by colour alone. The outcome is read from the record's outcome links
 * (`analysisId`, `needsNewCapture`) by presence, never from the question's wording.
 *
 * ## The draft is kept until the follow-up is accepted
 *
 * Submitting hands the trimmed text up and KEEPS the draft: the post to the host, or the service
 * request behind it, can still fail, and a failed send must never force the developer to retype.
 * `App.tsx` reports how the submission ended through `submission`: `accepted` clears the draft;
 * `failed` keeps it and shows a retry hint under the field until the next submit. Each outcome is
 * applied once, by its `seq`, with React's "adjust state while rendering" pattern — the last
 * applied `seq` is state, compared during render — so no effect sets state and a re-render that
 * passes the same outcome again changes nothing. An outcome already present when the component
 * mounts belongs to a submission this instance never made, and is not applied.
 *
 * ## Length and blank drafts
 *
 * The field's native `maxLength` is `MAX_WEBVIEW_QUESTION_LENGTH` from `../../webview-messages` —
 * the protocol's own question limit, which the host and the service enforce too — so the browser
 * stops typing there and truncates a longer paste. A counter under the field (`1,234 / 2,000
 * characters`) describes it through `aria-describedby` rather than a live region, so it is heard
 * with the field and never once per keystroke, and turns to the `warning` tone with a sentence
 * saying longer text is cut off once the draft is full. The submit chord pressed on a blank draft
 * marks the field invalid with a short message, cleared as soon as the draft holds text.
 *
 * ## The shortcut hint
 *
 * The actions row says how the keyboard works, in the same words and the same form as the question
 * field of `QuestionForm.tsx`: "Press Ctrl+Enter (Cmd+Enter on macOS) to ask. Enter starts a new
 * line." Every key is a `Kbd` chip, whose chord separators are hidden from assistive technology,
 * so the hint is heard as exactly that sentence; "Cmd" is spelled out because every screen reader
 * speaks it, which a "⌘" glyph does not guarantee. It is a muted `Text` placed immediately before
 * the submit button and it describes the field through `aria-describedby`, after the counter and
 * the retry hint. The two components share no runtime module, so each declares the key constants
 * and the sentence itself; `FollowUp.test.tsx` renders both hints and fails when they drift apart.
 *
 * ## Focus
 *
 * While a follow-up is pending, `App.tsx` replaces the field with the busy state, so the control
 * that held focus unmounts; and an accepted outcome clears the draft, which disables a focused
 * submit control. Either way keyboard focus would fall to the document. So when an outcome is
 * applied while the field is on screen and focus has been lost — to the document body, to a
 * detached element or to a disabled control — focus returns to the field, without scrolling. Focus
 * the developer has moved anywhere else is left where it is.
 *
 * ## The states, in precedence order (AAP 0.5.5)
 *
 *   error     `ErrorState`, which owns `role="alert"`, with its retry control when `onRetry` is
 *             supplied.
 *   pending   `LoadingState`, which owns `role="status"` and `aria-busy`, while the follow-up is
 *             being processed - so a second submission cannot be raised in the meantime.
 *   disabled  `EmptyState` explaining why no follow-up can be asked now (`enabled` is false),
 *             in the sentence `unavailableReason` selects: no result yet, the latest question
 *             still being answered, the session ended or failed, or the local service not
 *             running. An enabled-looking field that could not do anything is never rendered.
 *   ready     the labelled multi-line field and its submit control.
 *
 * The asked list, when there is one, sits above whichever state is shown.
 *
 * ## The question is data, never a decision (AAP 0.5.4, 0.5.2)
 *
 * The text is trimmed and checked for emptiness - by length, so nothing compares it with a
 * literal - and is otherwise passed through verbatim. No search, match or comparison against its
 * wording exists in this file (`scripts/check-no-hardcoding.mjs` enforces the rule statically),
 * and nothing is written to the console, because the question is developer content that may name
 * private code.
 *
 * ## Design system (AAP 0.6.4)
 *
 * Only `@debuggen/panel-renderer` primitives render controls - `Input` with `multiline` is the
 * sanctioned text area and `Button` the only button - and no raw form element, heading or inline
 * style appears. There is no `<form>` element at all: `Button` renders `type="button"` by
 * default, so nothing here can submit and navigate the webview document. Layout comes from the
 * `dgv-followup` block of `../styles.css`, whose declarations resolve to `--dg-*` tokens only; the
 * retry hint is a `Text` in the design system's `warning` tone and adds no class. The asked list
 * is the one raw list in the file — an `<ol>`, so its length and order are announced — styled by
 * the shared `dgv-asked-list` / `dgv-asked__text` rules of the same stylesheet.
 */
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Input,
  Kbd,
  LoadingState,
  Stack,
  Text,
} from '@debuggen/panel-renderer';
import type { BadgeTone } from '@debuggen/panel-renderer';
import type { FollowUpRecord } from '@debuggen/protocol';
import { assertNever } from '@debuggen/shared';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';

import { MAX_WEBVIEW_QUESTION_LENGTH } from '../../webview-messages';
import type { SubmissionOutcome } from '../pending-actions';

/**
 * Why the follow-up entry is closed, as `App.tsx` reads it from the session. It selects the
 * sentence of the disabled state and nothing else; it never opens the gate, which `enabled` owns.
 *
 * - `awaitingResult` — the session has not produced its first result yet.
 * - `working` — a result exists, but the session is working on its latest question (a follow-up
 *   being re-analysed or re-captured), so another one waits for that answer.
 * - `ended` — the session has ended and takes no further question.
 * - `failed` — the session stopped at a failed stage.
 * - `serviceUnavailable` — the local service is not reachable, so nothing could be sent.
 */
export type FollowUpUnavailableReason =
  'awaitingResult' | 'working' | 'ended' | 'failed' | 'serviceUnavailable';

/**
 * Props of {@link FollowUp}.
 *
 * Every optional member spells `| undefined` because `exactOptionalPropertyTypes` is in force
 * repository-wide: `App.tsx` forwards values it may not have (`error={failure?.message}`), and
 * that must stay legal.
 */
export interface FollowUpProps {
  /**
   * Raised with the trimmed follow-up question when the developer submits a non-blank draft.
   * `App.tsx` maps it onto the `askFollowUp` webview-to-host message. The draft is kept: it is
   * cleared only when {@link FollowUpProps.submission} reports the follow-up accepted.
   */
  onSubmit: (question: string) => void;

  /**
   * How the latest follow-up submission ended, from `../pending-actions`. Each distinct `seq` is
   * applied once: `accepted` clears the draft; `failed` keeps it and shows a retry hint under the
   * field until the next submit. `App.tsx` holds `pending` while a submission is in flight, so the
   * draft cannot change between the submit and its outcome. An outcome already present when the
   * component mounts is not applied.
   */
  submission?: SubmissionOutcome | undefined;

  /**
   * Whether the session has produced a result a follow-up can refer to. `App.tsx` decides this
   * from the host's snapshot; while it is `false` the component explains why the field is not
   * offered instead of rendering a control that could not do anything.
   */
  enabled: boolean;

  /**
   * Why the entry is closed while `enabled` is `false`, which selects the sentence the disabled
   * state shows. Ignored while `enabled` is `true`.
   *
   * @default 'awaitingResult'
   */
  unavailableReason?: FollowUpUnavailableReason | undefined;

  /**
   * The follow-ups already asked in the session, oldest first — the session record's
   * `followUps`, as the host sent it. Listed above the entry in every state when non-empty, each
   * question verbatim with its outcome in words; an absent or empty ladder renders no list.
   */
  asked?: readonly FollowUpRecord[] | undefined;

  /** A follow-up is being processed. Replaces the field with a busy placeholder. */
  pending?: boolean | undefined;

  /**
   * Why the last follow-up failed, as the host reported it. A non-blank value takes precedence
   * over every other state.
   */
  error?: string | undefined;

  /** Retries the failed follow-up. The retry control renders only when this is supplied. */
  onRetry?: (() => void) | undefined;

  /** Extra classes composed after the `dgv-followup` block, for the layout `App.tsx` owns. */
  className?: string | undefined;
}

/** The block class every state renders on its root, so `App.tsx` places each state alike. */
const ROOT_CLASS = 'dgv-followup';

/** The visible label of the field, rendered as a real `<label htmlFor>` by `Input`. */
const FIELD_LABEL = 'Follow-up question';

/**
 * The keys the shortcut hint prints through `Kbd`: the two submit chords — Ctrl+Enter, then
 * Cmd+Enter for macOS — and the lone Enter that inserts a new line. `QuestionForm.tsx` declares the
 * same three and prints the same sentence (see the module note).
 */
const SUBMIT_CHORD_CTRL: readonly string[] = ['Ctrl', 'Enter'];
const SUBMIT_CHORD_CMD: readonly string[] = ['Cmd', 'Enter'];
const NEW_LINE_KEY = 'Enter';

/** Visible line count of the field; a follow-up is usually a sentence or two. */
const FIELD_ROWS = 3;

/** The submit control's label, which is also its accessible name. */
const SUBMIT_LABEL = 'Ask follow-up';

/**
 * The copy of the disabled state, one sentence per {@link FollowUpUnavailableReason} — generic
 * product vocabulary only (AAP 0.5.4). Each says why the entry is closed and what reopens it.
 */
const AWAITING_RESULT_MESSAGE = 'Ask a follow-up once the first result is ready.';
const WORKING_MESSAGE =
  'The session is working on its latest question. Ask another follow-up once that result is ready.';
const ENDED_MESSAGE =
  'This session has ended, so it takes no more follow-ups. Ask a new question above to start another session.';
const FAILED_MESSAGE =
  'This session stopped at a failed stage, so it takes no follow-ups. Retry the stage, or ask a new question above.';
const SERVICE_UNAVAILABLE_MESSAGE = 'Start the local Debug Generator service to ask a follow-up.';

/** The visible label of the asked list, which also names the `<ol>` through `aria-labelledby`. */
const ASKED_LABEL = 'Asked in this session';

/** The outcome badge of each state a recorded follow-up can be in, named in words. */
const ANSWERED_LABEL = 'Answered';
const NEEDS_CAPTURE_LABEL = 'Needs a new capture';
const STORED_CAPTURE_LABEL = 'Answering from the stored capture';
const AWAITING_ANSWER_LABEL = 'Awaiting an answer';

/** How one recorded follow-up's outcome is presented: its badge tone and the words it carries. */
interface OutcomePresentation {
  readonly tone: BadgeTone;
  readonly label: string;
}

/** Announced, not painted, while a follow-up is processed; `LoadingState` appends the `…`. */
const PENDING_LABEL = 'Processing the follow-up question';

/** The first line of the error state, replacing `ErrorState`'s generic view-loading title. */
const ERROR_TITLE = 'The follow-up question could not be processed';

/**
 * Shown under the field after a follow-up submission failed — refused by the host channel,
 * reported failed by the host, or never acknowledged — until the next submit. Generic product
 * vocabulary only (AAP 0.5.4).
 */
const RETRY_HINT = `Your follow-up question was not confirmed, so it is kept here. Press “${SUBMIT_LABEL}” to try again.`;

/**
 * Formats the character counter: the locale's digit grouping and no fraction, the same format
 * `App.tsx` uses when it states the limit in a notice.
 */
const COUNT_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/** The question limit as the counter prints it, e.g. `2,000`. */
const LIMIT_TEXT = COUNT_FORMAT.format(MAX_WEBVIEW_QUESTION_LENGTH);

/**
 * Appended to the counter once the draft holds {@link MAX_WEBVIEW_QUESTION_LENGTH} characters:
 * the field's native `maxLength` stops typing there and cuts a longer paste off, and this is what
 * tells the developer why.
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
 * Inline validation shown when the Ctrl/⌘+Enter chord is pressed on a blank draft, until the
 * draft holds text again. Generic product vocabulary only (AAP 0.5.4).
 */
const BLANK_DRAFT_MESSAGE = 'Type a follow-up question before asking.';

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
 * Compose the root class list without `clsx`, which is not a dependency of this workspace.
 *
 * @param className The caller's extra classes, if any.
 * @returns `dgv-followup`, followed by the caller's classes when they are not blank.
 */
function composeRootClassName(className: string | undefined): string {
  const extra = className?.trim() ?? '';
  return extra.length === 0 ? ROOT_CLASS : `${ROOT_CLASS} ${extra}`;
}

/**
 * Whether a keystroke is the submit chord: `Enter` with `Ctrl` or `⌘`.
 *
 * Plain `Enter` is not the chord - it inserts a newline in a multi-line question - and neither is
 * an `Enter` that confirms an input-method composition, which belongs to the IME rather than to
 * this field.
 *
 * @param event The key-down event raised by the field.
 * @returns `true` when the keystroke should submit the draft.
 */
function isSubmitChord(event: KeyboardEvent<HTMLElement>): boolean {
  return (
    event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing
  );
}

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
 * The sentence of the disabled state for one reason. Closed by `assertNever`, so a reason added to
 * {@link FollowUpUnavailableReason} is a compile error here until it has its own sentence.
 *
 * @param reason Why the entry is closed.
 * @returns The generic sentence explaining it.
 */
function unavailableMessage(reason: FollowUpUnavailableReason): string {
  switch (reason) {
    case 'awaitingResult':
      return AWAITING_RESULT_MESSAGE;
    case 'working':
      return WORKING_MESSAGE;
    case 'ended':
      return ENDED_MESSAGE;
    case 'failed':
      return FAILED_MESSAGE;
    case 'serviceUnavailable':
      return SERVICE_UNAVAILABLE_MESSAGE;
    default:
      return assertNever(reason, 'Unhandled follow-up unavailable reason');
  }
}

/**
 * The outcome of one recorded follow-up, read from its outcome links by presence — never from its
 * question. An analysis produced for it means it was answered; otherwise the follow-up stage's
 * decision says which path is answering it; with neither, it has not been decided yet.
 *
 * @param followUp One entry of the session's follow-up ladder.
 * @returns The badge tone and the words that name the outcome.
 */
function describeOutcome(followUp: FollowUpRecord): OutcomePresentation {
  if (followUp.analysisId !== undefined) {
    return { tone: 'success', label: ANSWERED_LABEL };
  }
  if (followUp.needsNewCapture === true) {
    return { tone: 'info', label: NEEDS_CAPTURE_LABEL };
  }
  if (followUp.needsNewCapture === false) {
    return { tone: 'info', label: STORED_CAPTURE_LABEL };
  }
  return { tone: 'neutral', label: AWAITING_ANSWER_LABEL };
}

/**
 * The key of one asked follow-up: its attempt identity when the record carries one (unique within
 * a session's ladder), otherwise its position and time, which a ladder never repeats.
 *
 * @param followUp The entry.
 * @param index Its position in the ladder.
 * @returns A key stable across snapshots of the same ladder.
 */
function askedKey(followUp: FollowUpRecord, index: number): string {
  return followUp.attemptId ?? `${String(index)}:${String(followUp.askedAt)}`;
}

/** Props of {@link AskedFollowUps}. */
interface AskedFollowUpsProps {
  /** The non-empty ladder, oldest first. */
  readonly asked: readonly FollowUpRecord[];
}

/**
 * The follow-ups asked so far: a muted label naming an ordered list, one item per follow-up with
 * its question verbatim — line breaks kept by `dgv-asked__text` — over its outcome badge. A
 * component of its own so its `useId` call is unconditional.
 *
 * @param props See {@link AskedFollowUpsProps}.
 * @returns The labelled list.
 */
function AskedFollowUps(props: AskedFollowUpsProps): ReactElement {
  const { asked } = props;
  const askedHeadingId = useId();
  return (
    <Stack gap={1}>
      <Text as="p" size="xs" tone="muted" id={askedHeadingId}>
        {ASKED_LABEL}
      </Text>
      <ol className="dgv-asked-list" aria-labelledby={askedHeadingId}>
        {asked.map((followUp, index) => {
          const outcome = describeOutcome(followUp);
          return (
            <li key={askedKey(followUp, index)} className="dgv-asked-list__item">
              <Text as="p" size="sm" className="dgv-asked__text">
                {followUp.question}
              </Text>
              <Badge tone={outcome.tone}>{outcome.label}</Badge>
            </li>
          );
        })}
      </ol>
    </Stack>
  );
}

/**
 * Renders the follow-ups asked so far, then the follow-up entry in whichever of its four states
 * the props select.
 *
 * @param props See {@link FollowUpProps}.
 * @returns The `dgv-followup` block holding the asked list, when there is one, and the error,
 *   busy, unavailable or ready state.
 *
 * @example
 * <FollowUp
 *   onSubmit={askFollowUp}
 *   submission={pendingActions.outcomes.askFollowUp}
 *   enabled={phase.acceptsFollowUp && !serviceUnavailable}
 *   unavailableReason={session.status === 'ended' ? 'ended' : 'awaitingResult'}
 *   asked={session.followUps}
 *   pending={followUpPending}
 * />
 */
export function FollowUp(props: FollowUpProps): ReactElement {
  const {
    onSubmit,
    submission,
    enabled,
    unavailableReason = 'awaitingResult',
    asked,
    pending = false,
    error,
    onRetry,
    className,
  } = props;

  // The draft, kept until an accepted outcome clears it. Declared before any branch, as a hook
  // must be, so the draft survives the component switching between states.
  const [draft, setDraft] = useState<string>('');
  // The `seq` of the last submission outcome applied. Initialised from the outcome present at
  // mount, which belongs to no submission of this instance.
  const [appliedSeq, setAppliedSeq] = useState<number | undefined>(submission?.seq);
  // Whether the last applied outcome was a failure the next submit clears.
  const [retryHintShown, setRetryHintShown] = useState<boolean>(false);
  // Whether the submit chord was pressed on a blank draft; cleared once the draft holds text.
  const [blankAttempted, setBlankAttempted] = useState<boolean>(false);
  // The outcome whose focus consequence has been handled; read and written by the effect only.
  const focusHandledSeq = useRef<number | undefined>(appliedSeq);

  // The field's id. `Input` exposes no ref, and addressing the control by the id its caller
  // supplied is the focus route that primitive documents; see the focus effect below.
  const fieldId = useId();
  const retryHintId = useId();
  const counterId = useId();
  const shortcutId = useId();

  // React's "adjust state while rendering" pattern: a new outcome is applied here, once per
  // `seq`, and React re-renders before committing, so neither a stale draft nor a second
  // application ever reaches the screen.
  if (submission !== undefined && submission.seq !== appliedSeq) {
    setAppliedSeq(submission.seq);
    if (submission.status === 'accepted') {
      setDraft('');
      setRetryHintShown(false);
    } else {
      setRetryHintShown(true);
    }
  }

  // Once per applied outcome, after it is on screen: a field that is showing gets focus back when
  // focus was lost (see the module note), and only then.
  useEffect(() => {
    if (focusHandledSeq.current === appliedSeq) {
      return;
    }
    focusHandledSeq.current = appliedSeq;
    const field = document.getElementById(fieldId);
    if (field !== null && focusWasLost(document.activeElement)) {
      field.focus({ preventScroll: true });
    }
  }, [appliedSeq, fieldId]);

  const rootClassName = composeRootClassName(className);

  // First in every state, so what was asked is never replaced by the entry's busy, error or
  // closed state, and in the same position, so switching states never remounts it.
  const history = asked !== undefined && asked.length > 0 ? <AskedFollowUps asked={asked} /> : null;

  if (error !== undefined && error.trim().length > 0) {
    return (
      <div className={rootClassName}>
        {history}
        <ErrorState title={ERROR_TITLE} message={error} onRetry={onRetry} />
      </div>
    );
  }

  if (pending) {
    return (
      <div className={rootClassName}>
        {history}
        <LoadingState variant="block" label={PENDING_LABEL} />
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className={rootClassName}>
        {history}
        <EmptyState message={unavailableMessage(unavailableReason)} />
      </div>
    );
  }

  const trimmedDraft = draft.trim();
  const isBlank = trimmedDraft.length === 0;
  // Lengths only (AAP 0.5.4). `maxLength` keeps the draft within the limit, so reaching it is the
  // one state the counter warns about.
  const atLimit = draft.length >= MAX_WEBVIEW_QUESTION_LENGTH;
  const blankShown = blankAttempted && isBlank;
  // The field's own descriptions, in reading order: the counter, the retry hint while it shows,
  // then the shortcut hint of the actions row. `Input` appends the blank-draft message's id while
  // the field is marked invalid.
  const fieldDescription = retryHintShown
    ? `${counterId} ${retryHintId} ${shortcutId}`
    : `${counterId} ${shortcutId}`;

  /**
   * Replace the draft with what the field now holds, and retire the blank-draft message as soon as
   * the draft holds text again. The flag is cleared only when it is set, for the reason
   * `submitDraft` gives about no-op updates.
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
   * Hand the trimmed draft up, keeping it until `submission` reports it accepted, and retire the
   * previous attempt's retry hint. A blank draft is refused: the submit control is already
   * disabled for it, and the chord shows an inline validation message on the field until the
   * draft holds text again.
   *
   * Focus stays where it is: the kept draft keeps the submit control enabled. The hint is retired
   * only when it is showing — a no-op `setState` from an event stays queued in React and is
   * replayed on the next render, where it would undo the render-time application of this very
   * submission's `failed` outcome.
   */
  const submitDraft = (): void => {
    if (isBlank) {
      if (!blankAttempted) {
        setBlankAttempted(true);
      }
      return;
    }
    onSubmit(trimmedDraft);
    if (retryHintShown) {
      setRetryHintShown(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!isSubmitChord(event)) {
      return;
    }
    // The chord never inserts a line break, whether or not the draft is sent.
    event.preventDefault();
    submitDraft();
  };

  return (
    <div className={rootClassName}>
      {history}
      <Input
        id={fieldId}
        multiline
        fullWidth
        rows={FIELD_ROWS}
        label={FIELD_LABEL}
        maxLength={MAX_WEBVIEW_QUESTION_LENGTH}
        value={draft}
        onValueChange={changeDraft}
        onKeyDown={handleKeyDown}
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
      <div className="dgv-followup__actions">
        {/* Reads "Press Ctrl+Enter (Cmd+Enter on macOS) to ask. Enter starts a new line.", word
            for word the question field's hint. */}
        <Text size="xs" tone="muted" id={shortcutId}>
          Press <Kbd keys={SUBMIT_CHORD_CTRL} /> (<Kbd keys={SUBMIT_CHORD_CMD} /> on macOS) to ask.{' '}
          <Kbd>{NEW_LINE_KEY}</Kbd> starts a new line.
        </Text>
        <Button variant="secondary" disabled={isBlank} onClick={submitDraft}>
          {SUBMIT_LABEL}
        </Button>
      </div>
    </div>
  );
}
