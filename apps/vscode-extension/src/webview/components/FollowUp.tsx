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
 * host's snapshot, never an inference made here by looking at an analysis object.
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
 *   disabled  `EmptyState` explaining that follow-ups open once a result exists (`enabled` is
 *             false). An enabled-looking field that could not do anything is never rendered.
 *   ready     the labelled multi-line field and its submit control.
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
 * retry hint is a `Text` in the design system's `warning` tone and adds no class.
 */
import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Text,
} from '@debuggen/panel-renderer';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';

import type { SubmissionOutcome } from '../pending-actions';

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

/** Persistent help under the field, announced with it through `aria-describedby`. */
const FIELD_HINT = 'Press Ctrl+Enter (⌘+Enter on macOS) to ask. Enter starts a new line.';

/** Visible line count of the field; a follow-up is usually a sentence or two. */
const FIELD_ROWS = 3;

/** The submit control's label, which is also its accessible name. */
const SUBMIT_LABEL = 'Ask follow-up';

/** The copy of the disabled state - generic product vocabulary only (AAP 0.5.4). */
const UNAVAILABLE_MESSAGE = 'Ask a follow-up once the first result is ready.';

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
 * Renders the follow-up entry in whichever of its four states the props select.
 *
 * @param props See {@link FollowUpProps}.
 * @returns The `dgv-followup` block holding the error, busy, unavailable or ready state.
 */
export function FollowUp(props: FollowUpProps): ReactElement {
  const { onSubmit, submission, enabled, pending = false, error, onRetry, className } = props;

  // The draft, kept until an accepted outcome clears it. Declared before any branch, as a hook
  // must be, so the draft survives the component switching between states.
  const [draft, setDraft] = useState<string>('');
  // The `seq` of the last submission outcome applied. Initialised from the outcome present at
  // mount, which belongs to no submission of this instance.
  const [appliedSeq, setAppliedSeq] = useState<number | undefined>(submission?.seq);
  // Whether the last applied outcome was a failure the next submit clears.
  const [retryHintShown, setRetryHintShown] = useState<boolean>(false);
  // The outcome whose focus consequence has been handled; read and written by the effect only.
  const focusHandledSeq = useRef<number | undefined>(appliedSeq);

  // The field's id. `Input` exposes no ref, and addressing the control by the id its caller
  // supplied is the focus route that primitive documents; see the focus effect below.
  const fieldId = useId();
  const retryHintId = useId();

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

  if (error !== undefined && error.trim().length > 0) {
    return (
      <div className={rootClassName}>
        <ErrorState title={ERROR_TITLE} message={error} onRetry={onRetry} />
      </div>
    );
  }

  if (pending) {
    return (
      <div className={rootClassName}>
        <LoadingState variant="block" label={PENDING_LABEL} />
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className={rootClassName}>
        <EmptyState message={UNAVAILABLE_MESSAGE} />
      </div>
    );
  }

  const trimmedDraft = draft.trim();
  const isBlank = trimmedDraft.length === 0;

  /**
   * Hand the trimmed draft up, keeping it until `submission` reports it accepted, and retire the
   * previous attempt's retry hint. A blank draft is refused silently: the submit control is
   * already disabled for it, and the chord simply does nothing.
   *
   * Focus stays where it is: the kept draft keeps the submit control enabled. The hint is retired
   * only when it is showing — a no-op `setState` from an event stays queued in React and is
   * replayed on the next render, where it would undo the render-time application of this very
   * submission's `failed` outcome.
   */
  const submitDraft = (): void => {
    if (isBlank) {
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
      <Input
        id={fieldId}
        multiline
        fullWidth
        rows={FIELD_ROWS}
        label={FIELD_LABEL}
        hint={FIELD_HINT}
        value={draft}
        onValueChange={setDraft}
        onKeyDown={handleKeyDown}
        aria-describedby={retryHintShown ? retryHintId : undefined}
      />
      {retryHintShown ? (
        <Text as="p" size="xs" tone="warning" id={retryHintId}>
          {RETRY_HINT}
        </Text>
      ) : null}
      <div className="dgv-followup__actions">
        <Button variant="secondary" disabled={isBlank} onClick={submitDraft}>
          {SUBMIT_LABEL}
        </Button>
      </div>
    </div>
  );
}
