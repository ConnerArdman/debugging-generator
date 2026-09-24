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
 * ## One-way data, one piece of local state
 *
 * Everything the component shows arrives as props from `App.tsx`, which owns the whole webview
 * snapshot; the only state kept here is the unsent draft. The component posts nothing, fetches
 * nothing and opens no socket (AAP 0.4.2), and the gate is a prop: whether a result exists is
 * `App.tsx`'s decision from the host's snapshot, never an inference made here by looking at an
 * analysis object.
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
 * `dgv-followup` block of `../styles.css`, whose declarations resolve to `--dg-*` tokens only.
 */
import { Button, EmptyState, ErrorState, Input, LoadingState } from '@debuggen/panel-renderer';
import { useId, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';

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
   * `App.tsx` maps it onto the `askFollowUp` webview-to-host message.
   */
  onSubmit: (question: string) => void;

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
 * Renders the follow-up entry in whichever of its four states the props select.
 *
 * @param props See {@link FollowUpProps}.
 * @returns The `dgv-followup` block holding the error, busy, unavailable or ready state.
 */
export function FollowUp(props: FollowUpProps): ReactElement {
  const { onSubmit, enabled, pending = false, error, onRetry, className } = props;

  // The unsent draft - the only state this component keeps. Declared before any branch, as a
  // hook must be, so the draft survives the component switching between states.
  const [draft, setDraft] = useState<string>('');

  // The field's id. `Input` exposes no ref, and addressing the control by the id its caller
  // supplied is the focus route that primitive documents; see `submitDraft`.
  const fieldId = useId();

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
   * Hand the trimmed draft up and clear the field. A blank draft is refused silently: the submit
   * control is already disabled for it, and the chord simply does nothing.
   *
   * Focus returns to the field afterwards. Clearing the draft disables the submit control, and a
   * control that becomes disabled while focused drops keyboard focus to the document body, which
   * would strand a keyboard user who submitted with the button. After the chord the field already
   * holds focus, so the call changes nothing there.
   */
  const submitDraft = (): void => {
    if (isBlank) {
      return;
    }
    onSubmit(trimmedDraft);
    setDraft('');
    document.getElementById(fieldId)?.focus();
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
      />
      <div className="dgv-followup__actions">
        <Button variant="secondary" disabled={isBlank} onClick={submitDraft}>
          {SUBMIT_LABEL}
        </Button>
      </div>
    </div>
  );
}
