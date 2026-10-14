/**
 * `components/FollowUp` — the follow-up question entry of the VS Code view (AAP 0.7.3).
 *
 * What this suite protects:
 *
 *   - the gate: follow-ups exist only once the session has produced a result. The gate is the
 *     `enabled` prop that `App.tsx` computes, never an inference from an analysis object, and
 *     while it is closed the component explains itself with a generic empty state instead of
 *     rendering a field that could not do anything (AAP 0.4.2, 0.5.5), in the sentence the
 *     `unavailableReason` prop selects;
 *   - the asked list: every follow-up already asked is listed above the entry, in every state,
 *     oldest first, its question verbatim and its outcome named in words;
 *   - the exact payload: `onSubmit` receives the trimmed draft, once and alone, and the draft is
 *     KEPT until a `submission` outcome reports it accepted; blank drafts are refused by the button
 *     and by the keyboard chord, the chord marking the field invalid with a short message that
 *     clears once the draft holds text;
 *   - the protocol's question limit on the field: native `maxLength`, a paste cut off at it, and a
 *     counter that describes the field (not a live region) and warns once the limit is reached;
 *   - the submission outcome: `accepted` clears the draft, `failed` keeps it and shows a retry hint
 *     describing the field until the next submit, each `seq` is applied exactly once, an outcome
 *     present at mount is not applied, and focus lost while the field was replaced or its submit
 *     control disabled returns to the field — focus moved elsewhere is left alone;
 *   - the keyboard contract: `Ctrl`/`⌘`+`Enter` submits, plain `Enter` inserts a line break;
 *   - the shortcut hint: the exact sentence, every key a `Kbd` chip, placed in the actions row
 *     immediately before the submit button and describing the field — and identical, in text and
 *     in markup, to the hint of `QuestionForm`, so the view's two question fields never describe
 *     the same shortcut differently;
 *   - the states and their precedence (error > pending > unavailable > ready), each rendered
 *     through its design-system primitive and never as a blank area (AAP 0.5.5);
 *   - the question is data: two wordings travel through identically and nothing is ever written
 *     to the console, in any state (AAP 0.5.4, 0.5.2);
 *   - the webview safety shape: every control is `type="button"` and there is no `<form>`, so no
 *     interaction can submit and navigate the webview document.
 *
 * Harness conventions follow the rest of the repository: the Vitest API is imported explicitly,
 * `cleanup` runs explicitly after every case, elements are found by role, label and accessible
 * name, and — with no `jest-dom` in this repository — state is read from DOM properties on
 * explicitly narrowed elements. All fixtures are inline and their wording is generic product
 * vocabulary written for this suite (AAP 0.5.4).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock, MockInstance } from 'vitest';

import type { FollowUpRecord } from '@debuggen/protocol';

import { MAX_WEBVIEW_QUESTION_LENGTH } from '../../webview-messages';
import type { SubmissionOutcome } from '../pending-actions';

import { FollowUp } from './FollowUp';
import type { FollowUpUnavailableReason } from './FollowUp';
import { QuestionForm } from './QuestionForm';

/** The inline validation of a blank draft submitted by the chord. */
const BLANK_DRAFT_TEXT = 'Type a follow-up question before asking.';

/** Appended to the counter once the draft is full. */
const LIMIT_REACHED_TEXT = 'Limit reached: longer text is cut off.';

/** Appended to the counter when a value written past `maxLength` exceeds the limit. */
const OVER_LIMIT_TEXT = 'Over the limit: shorten it to ask.';

/** Formats a count as the counter does, in the test run's own locale. */
const COUNT_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/**
 * The counter's text for a draft below the limit.
 *
 * @param length The draft's length.
 * @returns `‹length› / ‹limit› characters`.
 */
function counterFor(length: number): string {
  return `${COUNT_FORMAT.format(length)} / ${COUNT_FORMAT.format(MAX_WEBVIEW_QUESTION_LENGTH)} characters`;
}

/**
 * The element the field names first in `aria-describedby`: the counter.
 *
 * @param field The follow-up field.
 * @returns The counter element.
 */
function getCounter(field: HTMLElement): HTMLElement {
  const [firstId] = (field.getAttribute('aria-describedby') ?? '').split(' ');
  const counter = firstId === undefined ? null : document.getElementById(firstId);
  if (counter === null) {
    throw new Error('expected the follow-up field to be described by its counter');
  }
  return counter;
}

/** The field's visible label, which `Input` renders as a real `<label htmlFor>`. */
const FIELD_LABEL = 'Follow-up question';

/** The retry hint shown under the field after a failed submission. */
const RETRY_HINT =
  'Your follow-up question was not confirmed, so it is kept here. Press “Ask follow-up” to try again.';

/** The submit control's accessible name. */
const SUBMIT_NAME = 'Ask follow-up';

/** The generic copy of the gated state. */
const UNAVAILABLE_MESSAGE = 'Ask a follow-up once the first result is ready.';

/** The announced (visually hidden) label of the busy state, without `LoadingState`'s `…`. */
const PENDING_LABEL = 'Processing the follow-up question';

/** The first line of the error state. */
const ERROR_TITLE = 'The follow-up question could not be processed';

/** The block class every state renders on its root. */
const ROOT_CLASS = 'dgv-followup';

/** The shortcut hint as read, word for word the question field's hint. */
const SHORTCUT_HINT_TEXT = 'Press Ctrl+Enter (Cmd+Enter on macOS) to ask. Enter starts a new line.';

/** The question field of `QuestionForm` and its submit control, for the drift guard. */
const QUESTION_FIELD_LABEL = 'What do you want to debug?';
const QUESTION_SUBMIT_NAME = 'Ask question';

/** One `Kbd` chip of a hint: its element, its class list and the keys it prints. */
interface HintChip {
  readonly tag: string;
  readonly className: string;
  readonly keys: readonly string[];
}

/**
 * The `Kbd` chips of the shortcut hint, in order: the two chords, which print one `dg-kbd__key`
 * per key, then the lone Enter, which is itself the `dg-kbd__key`.
 */
const SHORTCUT_HINT_CHIPS: readonly HintChip[] = [
  { tag: 'KBD', className: 'dg-kbd', keys: ['Ctrl', 'Enter'] },
  { tag: 'KBD', className: 'dg-kbd', keys: ['Cmd', 'Enter'] },
  { tag: 'KBD', className: 'dg-kbd dg-kbd__key', keys: ['Enter'] },
];

/**
 * The elements a field names in `aria-describedby`, in order.
 *
 * @param field The field.
 * @returns Each description element; an id that resolves to nothing fails the case.
 */
function descriptionsOf(field: HTMLElement): HTMLElement[] {
  return (field.getAttribute('aria-describedby') ?? '').split(' ').map((id) => {
    const element = document.getElementById(id);
    if (element === null) {
      throw new Error(`expected the description "${id}" to be on display`);
    }
    return element;
  });
}

/**
 * The shortcut hint describing a field: the description that prints keys.
 *
 * @param field The field.
 * @returns The hint element.
 */
function getShortcutHint(field: HTMLElement): HTMLElement {
  const hint = descriptionsOf(field).find((element) => element.querySelector('kbd') !== null);
  if (hint === undefined) {
    throw new Error('expected the field to be described by its shortcut hint');
  }
  return hint;
}

/**
 * The `Kbd` chips a hint holds, in order. Every chord separator must be hidden from assistive
 * technology, or the hint would not be heard as the sentence it prints.
 *
 * @param hint The shortcut hint.
 * @returns One entry per chip.
 */
function hintChips(hint: HTMLElement): HintChip[] {
  return Array.from(hint.children, (chip) => {
    for (const separator of chip.querySelectorAll('.dg-kbd__separator')) {
      expect(separator.getAttribute('aria-hidden')).toBe('true');
    }
    const keys = chip.classList.contains('dg-kbd__key')
      ? [chip.textContent]
      : Array.from(chip.children)
          .filter((key) => key.tagName === 'KBD' && key.classList.contains('dg-kbd__key'))
          .map((key) => key.textContent);
    return { tag: chip.tagName, className: chip.className, keys };
  });
}

/** The five console methods the component must never reach, whatever its state (AAP 0.5.2). */
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

/** The spies installed for the running case, keyed by the method they replace. */
let consoleSpies: ReadonlyArray<readonly [ConsoleMethod, MockInstance]> = [];

beforeEach(() => {
  // Replaced with a no-op so a stray write fails the case below with its arguments, rather
  // than scrolling past in the run output.
  consoleSpies = CONSOLE_METHODS.map(
    (method) => [method, vi.spyOn(console, method).mockImplementation(() => undefined)] as const,
  );
});

afterEach(() => {
  // The tree is unmounted first so the silence check also covers unmounting, and the spies are
  // restored even when that check fails, so one noisy case cannot leak into the next.
  try {
    cleanup();
    for (const [method, spy] of consoleSpies) {
      expect(spy, `console.${method} must never be called`).not.toHaveBeenCalled();
    }
  } finally {
    consoleSpies = [];
    vi.restoreAllMocks();
  }
});

/**
 * A typed `onSubmit` spy.
 *
 * @returns A fresh mock with `FollowUpProps['onSubmit']`'s signature.
 */
function submitSpy(): Mock<(question: string) => void> {
  return vi.fn<(question: string) => void>();
}

/**
 * An outcome for the submission numbered `seq`.
 *
 * @param seq The submission's sequence number.
 * @param status How it ended.
 * @returns The outcome `App.tsx` would pass.
 */
function outcome(seq: number, status: SubmissionOutcome['status']): SubmissionOutcome {
  return { seq, status };
}

/**
 * The retry hint, when it is on display.
 *
 * @returns Its element, or `null`.
 */
function queryRetryHint(): HTMLElement | null {
  return screen.queryByText(RETRY_HINT);
}

/**
 * The follow-up field, found through its label and narrowed to its element type.
 *
 * @returns The `<textarea>` the label names.
 */
function getField(): HTMLTextAreaElement {
  const field = screen.getByLabelText(FIELD_LABEL);
  if (!(field instanceof HTMLTextAreaElement)) {
    throw new Error('expected the follow-up field to be a <textarea>');
  }
  return field;
}

/**
 * The submit control, found by role and name and narrowed to its element type.
 *
 * @returns The `Ask follow-up` button.
 */
function getSubmit(): HTMLButtonElement {
  const button = screen.getByRole('button', { name: SUBMIT_NAME });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('expected the submit control to be a <button>');
  }
  return button;
}

/**
 * Every button in a rendered tree, narrowed to its element type.
 *
 * @param container The render container.
 * @returns The buttons, in document order.
 */
function allButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}

/**
 * Asserts that a rendered tree offers nothing that could accept or send a question.
 *
 * @param container The render container.
 */
function expectNoEntryControls(container: HTMLElement): void {
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByLabelText(FIELD_LABEL)).toBeNull();
  expect(screen.queryByRole('button', { name: SUBMIT_NAME })).toBeNull();
  expect(container.querySelector('textarea, input, select, form')).toBeNull();
}

describe('FollowUp — the gate', () => {
  it('explains why follow-ups are unavailable instead of rendering a dead control', () => {
    const onSubmit = submitSpy();
    const { container } = render(<FollowUp onSubmit={onSubmit} enabled={false} />);

    // The explanatory empty state: a settled status, not a busy one, with the generic copy.
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBeNull();
    expect(status.textContent).toContain(UNAVAILABLE_MESSAGE);
    expect(screen.queryByText(UNAVAILABLE_MESSAGE)).not.toBeNull();

    // No enabled field and no enabled submit control — none at all, in fact.
    expectNoEntryControls(container);
    expect(allButtons(container).filter((button) => !button.disabled)).toEqual([]);

    // Never a blank area.
    expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('never raises onSubmit while gated, whatever the keyboard does', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    render(<FollowUp onSubmit={onSubmit} enabled={false} />);

    await user.keyboard('A question typed at the document{Enter}');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await user.keyboard('{Meta>}{Enter}{/Meta}');

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('offers the labelled field and a submit control once enabled', () => {
    const { container } = render(<FollowUp onSubmit={submitSpy()} enabled />);

    const field = getField();
    expect(field.value).toBe('');
    expect(field.disabled).toBe(false);

    // A real <label for> names the field, never an aria-label substitute.
    const label = container.querySelector(`label[for="${field.id}"]`);
    expect(label?.textContent).toBe(FIELD_LABEL);
    expect(field.getAttribute('aria-label')).toBeNull();

    // The keyboard hint is announced with the field.
    const descriptions = descriptionsOf(field).map((element) => element.textContent);
    expect(descriptions).toContain(SHORTCUT_HINT_TEXT);

    // Nothing to send yet, so the submit control starts disabled.
    expect(getSubmit().disabled).toBe(true);
    expect(screen.queryByText(UNAVAILABLE_MESSAGE)).toBeNull();
  });

  it('keeps an unsent draft while the gate closes and reopens', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    const { rerender, container } = render(<FollowUp onSubmit={onSubmit} enabled />);

    await user.type(getField(), 'A draft written before the gate closed');
    rerender(<FollowUp onSubmit={onSubmit} enabled={false} />);
    expectNoEntryControls(container);

    rerender(<FollowUp onSubmit={onSubmit} enabled />);
    expect(getField().value).toBe('A draft written before the gate closed');
    expect(getSubmit().disabled).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('FollowUp — submission', () => {
  it('hands up the trimmed draft exactly once, alone, and keeps the field until accepted', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    render(<FollowUp onSubmit={onSubmit} enabled />);

    await user.type(getField(), '   How often does this step run?   ');
    expect(getSubmit().disabled).toBe(false);

    await user.click(getSubmit());

    // One call, one argument, the trimmed text — and the text stays until it is confirmed.
    expect(onSubmit.mock.calls).toEqual([['How often does this step run?']]);
    expect(getField().value).toBe('   How often does this step run?   ');
    expect(getSubmit().disabled).toBe(false);
    expect(queryRetryHint()).toBeNull();
  });

  it('leaves focus on the submit control, which the kept draft keeps enabled', async () => {
    const user = userEvent.setup();
    render(<FollowUp onSubmit={submitSpy()} enabled />);

    await user.type(getField(), 'Which step took the longest?');
    await user.click(getSubmit());

    expect(document.activeElement).toBe(getSubmit());
    expect(getSubmit().disabled).toBe(false);
  });

  it('keeps inner line breaks and spacing, trimming only the ends', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    render(<FollowUp onSubmit={onSubmit} enabled />);

    await user.type(getField(), '  First line{Enter}{Enter}  second line  ');
    await user.click(getSubmit());

    expect(onSubmit.mock.calls).toEqual([['First line\n\n  second line']]);
  });

  it('refuses an empty draft', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    render(<FollowUp onSubmit={onSubmit} enabled />);

    expect(getSubmit().disabled).toBe(true);
    fireEvent.click(getSubmit());
    await user.click(getField());
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('refuses a whitespace-only draft and leaves it in place', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    render(<FollowUp onSubmit={onSubmit} enabled />);

    await user.type(getField(), '   {Enter}   ');
    expect(getSubmit().disabled).toBe(true);

    fireEvent.click(getSubmit());
    await user.keyboard('{Control>}{Enter}{/Control}');
    await user.keyboard('{Meta>}{Enter}{/Meta}');

    expect(onSubmit).not.toHaveBeenCalled();
    // The chord never inserts a line break, so the refused draft is exactly what was typed.
    expect(getField().value).toBe('   \n   ');
  });

  it('submits with Ctrl+Enter and Cmd+Enter, while plain and Shift+Enter add a line', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    const { rerender } = render(<FollowUp onSubmit={onSubmit} enabled />);

    await user.click(getField());
    await user.keyboard('First line{Enter}second line{Shift>}{Enter}{/Shift}third line');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(getField().value).toBe('First line\nsecond line\nthird line');

    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onSubmit).toHaveBeenLastCalledWith('First line\nsecond line\nthird line');
    // The chord submitted instead of inserting a line break.
    expect(getField().value).toBe('First line\nsecond line\nthird line');

    rerender(<FollowUp onSubmit={onSubmit} enabled submission={outcome(1, 'accepted')} />);
    expect(getField().value).toBe('');
    // Focus never left the field, so the next question is typed straight in.
    expect(document.activeElement).toBe(getField());

    await user.keyboard('Another question{Meta>}{Enter}{/Meta}');
    expect(onSubmit).toHaveBeenLastCalledWith('Another question');

    expect(onSubmit.mock.calls).toEqual([
      ['First line\nsecond line\nthird line'],
      ['Another question'],
    ]);
  });

  it('does not submit on an Enter that confirms an input-method composition', () => {
    const onSubmit = submitSpy();
    render(<FollowUp onSubmit={onSubmit} enabled />);

    fireEvent.change(getField(), { target: { value: 'A composed question' } });
    fireEvent.keyDown(getField(), { key: 'Enter', ctrlKey: true, isComposing: true });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(getField().value).toBe('A composed question');
  });
});

describe('FollowUp — the shortcut hint', () => {
  it('prints the shortcut hint in Kbd keys immediately before the submit button, describing the field', () => {
    render(<FollowUp onSubmit={submitSpy()} enabled />);

    const hint = getShortcutHint(getField());
    // Heard as exactly the sentence it prints: the chord separators are hidden.
    expect(hint.textContent).toBe(SHORTCUT_HINT_TEXT);
    // Every key a Kbd chip: the two chords, then the single Enter.
    expect(hint.querySelectorAll('kbd.dg-kbd')).toHaveLength(SHORTCUT_HINT_CHIPS.length);
    expect(hintChips(hint)).toEqual(SHORTCUT_HINT_CHIPS);
    // Muted helper text beside the control, no longer the field's own hint line.
    expect(hint.tagName).toBe('SPAN');
    expect(hint.classList.contains('dg-text--xs')).toBe(true);
    expect(hint.classList.contains('dg-text--muted')).toBe(true);
    expect(document.querySelector('.dg-field__hint')).toBeNull();

    // In the actions row, immediately before the submit button.
    const submit = getSubmit();
    expect(hint.nextElementSibling).toBe(submit);
    expect(hint.parentElement).toBe(submit.parentElement);
    expect(hint.parentElement?.classList.contains('dgv-followup__actions')).toBe(true);

    // Announced with the field, after the counter.
    expect(hint.id).not.toBe('');
    expect(getField().getAttribute('aria-describedby')).toBe(
      `${getCounter(getField()).id} ${hint.id}`,
    );
  });

  it('keeps the shortcut hint after the counter and the retry hint in the field description', () => {
    const onSubmit = submitSpy();
    const { rerender } = render(<FollowUp onSubmit={onSubmit} enabled />);

    fireEvent.change(getField(), { target: { value: 'Why does the second step wait?' } });
    fireEvent.click(getSubmit());
    rerender(<FollowUp onSubmit={onSubmit} enabled submission={outcome(1, 'failed')} />);

    const retryHint = queryRetryHint();
    if (retryHint === null) {
      throw new Error('expected the retry hint to be on display');
    }
    const hint = getShortcutHint(getField());
    expect(hint.textContent).toBe(SHORTCUT_HINT_TEXT);
    expect(getField().getAttribute('aria-describedby')).toBe(
      `${getCounter(getField()).id} ${retryHint.id} ${hint.id}`,
    );
  });

  it('reads and renders exactly as the question field’s hint', () => {
    render(
      <>
        <QuestionForm onSubmit={submitSpy()} />
        <FollowUp onSubmit={submitSpy()} enabled />
      </>,
    );

    const questionField = screen.getByRole('textbox', { name: QUESTION_FIELD_LABEL });
    const questionHint = getShortcutHint(questionField);
    const followUpHint = getShortcutHint(getField());
    expect(questionHint).not.toBe(followUpHint);

    // The same words, and the same form: element, classes, Kbd chips and their markup.
    expect(followUpHint.textContent).toBe(SHORTCUT_HINT_TEXT);
    expect(questionHint.textContent).toBe(followUpHint.textContent);
    expect(questionHint.tagName).toBe(followUpHint.tagName);
    expect(questionHint.className).toBe(followUpHint.className);
    expect(hintChips(questionHint)).toEqual(hintChips(followUpHint));
    expect(questionHint.innerHTML).toBe(followUpHint.innerHTML);

    // The same place: immediately before each field's own submit button.
    expect(questionHint.nextElementSibling).toBe(
      screen.getByRole('button', { name: QUESTION_SUBMIT_NAME }),
    );
    expect(followUpHint.nextElementSibling).toBe(getSubmit());
  });
});

describe('FollowUp — the question limit', () => {
  it('bounds the field natively by the protocol question limit', () => {
    render(<FollowUp onSubmit={submitSpy()} enabled />);

    expect(MAX_WEBVIEW_QUESTION_LENGTH).toBe(2000);
    expect(getField().maxLength).toBe(MAX_WEBVIEW_QUESTION_LENGTH);
  });

  it('counts the draft in a counter that describes the field and is not a live region', () => {
    render(<FollowUp onSubmit={submitSpy()} enabled />);

    const counter = getCounter(getField());
    expect(counter.textContent).toBe(counterFor(0));
    expect(counter.getAttribute('aria-live')).toBeNull();
    expect(counter.getAttribute('role')).toBeNull();
    // The keyboard hint still describes the field beside the counter.
    const descriptions = descriptionsOf(getField()).map((element) => element.textContent);
    expect(descriptions).toEqual([counterFor(0), SHORTCUT_HINT_TEXT]);

    fireEvent.change(getField(), { target: { value: 'f'.repeat(1234) } });
    expect(getCounter(getField()).textContent).toBe(counterFor(1234));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('warns once the draft reaches the limit, without refusing it', () => {
    const onSubmit = submitSpy();
    render(<FollowUp onSubmit={onSubmit} enabled />);

    fireEvent.change(getField(), { target: { value: 'f'.repeat(MAX_WEBVIEW_QUESTION_LENGTH) } });

    const counter = getCounter(getField());
    expect(counter.textContent).toBe(
      `${counterFor(MAX_WEBVIEW_QUESTION_LENGTH)}. ${LIMIT_REACHED_TEXT}`,
    );
    expect(counter.classList.contains('dg-text--warning')).toBe(true);
    expect(getField().getAttribute('aria-invalid')).toBeNull();
    fireEvent.click(getSubmit());
    expect(onSubmit.mock.calls).toEqual([['f'.repeat(MAX_WEBVIEW_QUESTION_LENGTH)]]);
  });

  it('cuts a longer paste off at the limit and says why', async () => {
    const user = userEvent.setup();
    render(<FollowUp onSubmit={submitSpy()} enabled />);

    await user.click(getField());
    await user.paste('f'.repeat(20_000));

    expect(getField().value).toHaveLength(MAX_WEBVIEW_QUESTION_LENGTH);
    expect(getCounter(getField()).textContent).toContain(LIMIT_REACHED_TEXT);
  });

  it('says a draft written past the limit is over it, not cut off', () => {
    render(<FollowUp onSubmit={submitSpy()} enabled />);

    // `maxLength` constrains only the developer's own edits; a value set some other way can
    // exceed it, and the counter must not claim the text was cut off.
    fireEvent.change(getField(), {
      target: { value: 'f'.repeat(MAX_WEBVIEW_QUESTION_LENGTH + 10) },
    });

    const counter = getCounter(getField());
    expect(counter.textContent).toBe(
      `${counterFor(MAX_WEBVIEW_QUESTION_LENGTH + 10)}. ${OVER_LIMIT_TEXT}`,
    );
    expect(counter.textContent).not.toContain(LIMIT_REACHED_TEXT);
    expect(counter.classList.contains('dg-text--warning')).toBe(true);
  });
});

describe('FollowUp — blank drafts', () => {
  it('marks a blank draft submitted by the chord invalid, and clears the mark once it holds text', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    render(<FollowUp onSubmit={onSubmit} enabled />);
    expect(screen.queryByText(BLANK_DRAFT_TEXT)).toBeNull();

    await user.click(getField());
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(onSubmit).not.toHaveBeenCalled();
    const message = screen.queryByText(BLANK_DRAFT_TEXT);
    expect(message).not.toBeNull();
    expect(getField().getAttribute('aria-invalid')).toBe('true');
    const describedBy = (getField().getAttribute('aria-describedby') ?? '').split(' ');
    expect(describedBy).toContain(message?.id);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.activeElement).toBe(getField());

    await user.keyboard('Why?');
    expect(screen.queryByText(BLANK_DRAFT_TEXT)).toBeNull();
    expect(getField().getAttribute('aria-invalid')).toBeNull();

    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onSubmit.mock.calls).toEqual([['Why?']]);
    expect(screen.queryByText(BLANK_DRAFT_TEXT)).toBeNull();
  });
});

describe('FollowUp — submission outcome', () => {
  it('clears the draft once the follow-up is accepted', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    const { rerender } = render(<FollowUp onSubmit={onSubmit} enabled />);

    await user.type(getField(), 'Which request came first?');
    await user.click(getSubmit());
    rerender(<FollowUp onSubmit={onSubmit} enabled pending />);
    rerender(<FollowUp onSubmit={onSubmit} enabled submission={outcome(1, 'accepted')} />);

    expect(getField().value).toBe('');
    expect(getSubmit().disabled).toBe(true);
    expect(queryRetryHint()).toBeNull();
  });

  it('keeps the draft after a failed follow-up and shows a retry hint describing the field', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    const { rerender } = render(<FollowUp onSubmit={onSubmit} enabled />);

    await user.type(getField(), 'Which request came first?');
    await user.click(getSubmit());
    rerender(<FollowUp onSubmit={onSubmit} enabled pending />);
    rerender(<FollowUp onSubmit={onSubmit} enabled submission={outcome(1, 'failed')} />);

    expect(getField().value).toBe('Which request came first?');
    expect(getSubmit().disabled).toBe(false);
    const hint = queryRetryHint();
    expect(hint).not.toBeNull();
    const describedBy = (getField().getAttribute('aria-describedby') ?? '').split(' ');
    expect(describedBy).toContain(hint?.id);
    expect(screen.queryByRole('alert')).toBeNull();

    // Retrying sends the same text again.
    await user.click(getSubmit());
    expect(onSubmit.mock.calls).toEqual([
      ['Which request came first?'],
      ['Which request came first?'],
    ]);
  });

  it('hides the retry hint on the next submit', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    const { rerender } = render(<FollowUp onSubmit={onSubmit} enabled />);

    await user.type(getField(), 'Which request came first?');
    await user.click(getSubmit());
    rerender(<FollowUp onSubmit={onSubmit} enabled submission={outcome(1, 'failed')} />);
    expect(queryRetryHint()).not.toBeNull();

    await user.click(getField());
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(queryRetryHint()).toBeNull();
    const describedBy = (getField().getAttribute('aria-describedby') ?? '').split(' ');
    expect(describedBy.every((id) => document.getElementById(id) !== null)).toBe(true);
    expect(getField().value).toBe('Which request came first?');
  });

  it('applies an outcome once: the same seq passed again changes nothing', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    const accepted = outcome(1, 'accepted');
    const { rerender } = render(<FollowUp onSubmit={onSubmit} enabled />);

    await user.type(getField(), 'First follow-up');
    await user.click(getSubmit());
    rerender(<FollowUp onSubmit={onSubmit} enabled submission={accepted} />);
    expect(getField().value).toBe('');

    await user.type(getField(), 'A draft typed afterwards');
    rerender(<FollowUp onSubmit={onSubmit} enabled submission={accepted} />);
    rerender(<FollowUp onSubmit={onSubmit} enabled submission={outcome(1, 'accepted')} />);
    expect(getField().value).toBe('A draft typed afterwards');

    await user.click(getSubmit());
    rerender(<FollowUp onSubmit={onSubmit} enabled submission={outcome(2, 'failed')} />);
    expect(queryRetryHint()).not.toBeNull();
    await user.click(getSubmit());
    expect(queryRetryHint()).toBeNull();
    rerender(<FollowUp onSubmit={onSubmit} enabled submission={outcome(2, 'failed')} />);
    expect(queryRetryHint()).toBeNull();
    expect(getField().value).toBe('A draft typed afterwards');
  });

  it('does not apply an outcome that was already present when it mounted', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    const { rerender } = render(
      <FollowUp onSubmit={onSubmit} enabled submission={outcome(6, 'failed')} />,
    );

    expect(queryRetryHint()).toBeNull();
    expect(document.activeElement).toBe(document.body);
    await user.type(getField(), 'A fresh follow-up');
    rerender(<FollowUp onSubmit={onSubmit} enabled submission={outcome(6, 'failed')} />);

    expect(getField().value).toBe('A fresh follow-up');
    expect(queryRetryHint()).toBeNull();
  });

  it('returns focus to the field when the pending state had taken it away', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    const { rerender } = render(<FollowUp onSubmit={onSubmit} enabled />);

    await user.type(getField(), 'Which request came first?');
    await user.click(getSubmit());
    rerender(<FollowUp onSubmit={onSubmit} enabled pending />);
    rerender(<FollowUp onSubmit={onSubmit} enabled submission={outcome(1, 'failed')} />);

    expect(document.activeElement).toBe(getField());
  });

  it('returns focus to the field when an accepted outcome disables the focused submit control', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    const { rerender } = render(<FollowUp onSubmit={onSubmit} enabled />);

    await user.type(getField(), 'Which step took the longest?');
    await user.click(getSubmit());
    expect(document.activeElement).toBe(getSubmit());

    rerender(<FollowUp onSubmit={onSubmit} enabled submission={outcome(1, 'accepted')} />);

    expect(getSubmit().disabled).toBe(true);
    expect(document.activeElement).toBe(getField());
  });

  it('leaves focus the developer moved elsewhere where it is', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    const view = (props: { pending?: boolean; submission?: SubmissionOutcome }): ReactElement => (
      <>
        <button type="button">Elsewhere</button>
        <FollowUp
          onSubmit={onSubmit}
          enabled
          pending={props.pending}
          submission={props.submission}
        />
      </>
    );
    const { rerender } = render(view({}));

    await user.type(getField(), 'Which request came first?');
    await user.click(getSubmit());
    rerender(view({ pending: true }));
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    rerender(view({ submission: outcome(1, 'failed') }));

    expect(document.activeElement).toBe(elsewhere);
    expect(getField().value).toBe('Which request came first?');
  });

  it('does not take focus later when the outcome arrived while the field was not on screen', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    const { rerender } = render(<FollowUp onSubmit={onSubmit} enabled />);

    await user.type(getField(), 'Which request came first?');
    await user.click(getSubmit());
    rerender(<FollowUp onSubmit={onSubmit} enabled pending />);
    // Accepted while the pipeline is still busy: the field is not on screen to receive focus.
    rerender(<FollowUp onSubmit={onSubmit} enabled pending submission={outcome(1, 'accepted')} />);
    expect(screen.queryByRole('textbox')).toBeNull();

    // The result arrives much later; the field comes back empty and focus is not moved to it.
    rerender(<FollowUp onSubmit={onSubmit} enabled submission={outcome(1, 'accepted')} />);
    expect(getField().value).toBe('');
    expect(document.activeElement).not.toBe(getField());
  });
});

describe('FollowUp — webview safety shape', () => {
  it('renders only type="button" controls and no <form> in every state', async () => {
    const user = userEvent.setup();

    const ready = render(<FollowUp onSubmit={submitSpy()} enabled />);
    await user.type(getField(), 'A drafted question');
    const readyButtons = allButtons(ready.container);
    expect(readyButtons.length).toBeGreaterThan(0);
    expect(readyButtons.map((button) => button.type)).toEqual(readyButtons.map(() => 'button'));
    expect(ready.container.querySelector('form')).toBeNull();
    ready.unmount();

    const failed = render(
      <FollowUp onSubmit={submitSpy()} enabled error="The request failed." onRetry={vi.fn()} />,
    );
    const failedButtons = allButtons(failed.container);
    expect(failedButtons.length).toBeGreaterThan(0);
    expect(failedButtons.map((button) => button.type)).toEqual(failedButtons.map(() => 'button'));
    expect(failed.container.querySelector('form')).toBeNull();
    failed.unmount();

    for (const element of [
      <FollowUp key="pending" onSubmit={submitSpy()} enabled pending />,
      <FollowUp key="gated" onSubmit={submitSpy()} enabled={false} />,
    ]) {
      const { container, unmount } = render(element);
      expect(allButtons(container).every((button) => button.type === 'button')).toBe(true);
      expect(container.querySelector('form')).toBeNull();
      unmount();
    }
  });

  it('composes the root block class with the caller class in every state', () => {
    const states = [
      <FollowUp key="ready" onSubmit={submitSpy()} enabled className="extra-placement" />,
      <FollowUp key="gated" onSubmit={submitSpy()} enabled={false} className="extra-placement" />,
      <FollowUp key="pending" onSubmit={submitSpy()} enabled pending className="extra-placement" />,
      <FollowUp
        key="error"
        onSubmit={submitSpy()}
        enabled
        error="The request failed."
        className="extra-placement"
      />,
    ];

    for (const element of states) {
      const { container, unmount } = render(element);
      const root = container.firstElementChild;
      expect(root?.classList.contains(ROOT_CLASS)).toBe(true);
      expect(root?.classList.contains('extra-placement')).toBe(true);
      unmount();
    }
  });

  it('leaves only the block class when the caller class is blank', () => {
    const { container } = render(<FollowUp onSubmit={submitSpy()} enabled className="   " />);

    expect(container.firstElementChild?.getAttribute('class')).toBe(ROOT_CLASS);
  });
});

describe('FollowUp — error', () => {
  it('shows the host message in an alert with a retry control wired to onRetry', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    const onRetry = vi.fn<() => void>();
    const { container } = render(
      <FollowUp
        onSubmit={onSubmit}
        enabled
        error="The local service rejected the follow-up."
        onRetry={onRetry}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(ERROR_TITLE);
    expect(alert.textContent).toContain('The local service rejected the follow-up.');
    expectNoEntryControls(container);

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('renders no control at all when onRetry is absent', () => {
    const { container } = render(
      <FollowUp onSubmit={submitSpy()} enabled error="The stage failed." />,
    );

    expect(screen.getByRole('alert').textContent).toContain('The stage failed.');
    expect(allButtons(container)).toEqual([]);
  });

  it('treats a blank message as no error', () => {
    render(<FollowUp onSubmit={submitSpy()} enabled error="   " />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(getField().disabled).toBe(false);
  });

  it('keeps an unsent draft across the error state', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    const { rerender } = render(<FollowUp onSubmit={onSubmit} enabled />);

    await user.type(getField(), 'A draft kept through a failure');
    rerender(<FollowUp onSubmit={onSubmit} enabled error="The stage failed." />);
    rerender(<FollowUp onSubmit={onSubmit} enabled />);

    expect(getField().value).toBe('A draft kept through a failure');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('FollowUp — pending', () => {
  it('replaces the field with a busy status, so no second submission can be raised', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    const { container } = render(<FollowUp onSubmit={onSubmit} enabled pending />);

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.textContent).toContain(PENDING_LABEL);
    expectNoEntryControls(container);
    expect(allButtons(container)).toEqual([]);

    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps an unsent draft across the pending state', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    const { rerender } = render(<FollowUp onSubmit={onSubmit} enabled />);

    await user.type(getField(), 'A draft kept while busy');
    rerender(<FollowUp onSubmit={onSubmit} enabled pending />);
    rerender(<FollowUp onSubmit={onSubmit} enabled pending={false} />);

    expect(getField().value).toBe('A draft kept while busy');
    expect(getSubmit().disabled).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('FollowUp — state precedence', () => {
  it('renders only the alert when error, pending and a closed gate coincide', () => {
    const { container } = render(
      <FollowUp onSubmit={submitSpy()} enabled={false} pending error="The stage failed." />,
    );

    expect(screen.getByRole('alert').textContent).toContain('The stage failed.');
    // Both the busy and the unavailable states are role="status"; neither may appear.
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(UNAVAILABLE_MESSAGE)).toBeNull();
    expect(container.textContent).not.toContain(PENDING_LABEL);
    expectNoEntryControls(container);
  });

  it('shows the busy state before the unavailable one', () => {
    const { container } = render(<FollowUp onSubmit={submitSpy()} enabled={false} pending />);

    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText(UNAVAILABLE_MESSAGE)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expectNoEntryControls(container);
  });
});

describe('FollowUp — the closed entry says why', () => {
  const MESSAGES: Readonly<Record<FollowUpUnavailableReason, string>> = {
    awaitingResult: UNAVAILABLE_MESSAGE,
    working:
      'The session is working on its latest question. Ask another follow-up once that result is ready.',
    ended:
      'This session has ended, so it takes no more follow-ups. Ask a new question above to start another session.',
    failed:
      'This session stopped at a failed stage, so it takes no follow-ups. Retry the stage, or ask a new question above.',
    serviceUnavailable: 'Start the local Debug Generator service to ask a follow-up.',
  };
  const REASONS = Object.keys(MESSAGES) as FollowUpUnavailableReason[];

  it.each(REASONS)('shows the %s sentence, and no other, while the gate is closed', (reason) => {
    const { container } = render(
      <FollowUp onSubmit={submitSpy()} enabled={false} unavailableReason={reason} />,
    );

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBeNull();
    expect(status.textContent).toBe(MESSAGES[reason]);
    for (const other of REASONS.filter((candidate) => candidate !== reason)) {
      expect(container.textContent).not.toContain(MESSAGES[other]);
    }
    expectNoEntryControls(container);
  });

  it('defaults to the first-result sentence', () => {
    render(<FollowUp onSubmit={submitSpy()} enabled={false} />);

    expect(screen.getByRole('status').textContent).toBe(UNAVAILABLE_MESSAGE);
  });

  it('ignores the reason while the gate is open', () => {
    render(<FollowUp onSubmit={submitSpy()} enabled unavailableReason="ended" />);

    expect(getField().disabled).toBe(false);
    expect(screen.queryByText(MESSAGES.ended)).toBeNull();
  });
});

describe('FollowUp — what was asked', () => {
  const ANSWERED: FollowUpRecord = {
    question: 'Why did the first step run twice?',
    askedAt: 1_758_000_040_000,
    attemptId: 'fua_first',
    attempt: 1,
    needsNewCapture: false,
    captureId: 'cap_stored',
    analysisId: 'ana_second',
    panelId: 'pnl_second',
  };
  const STORED: FollowUpRecord = {
    question: 'Which step waits on the other?\nAnd for how long?',
    askedAt: 1_758_000_050_000,
    attemptId: 'fua_second',
    attempt: 1,
    needsNewCapture: false,
  };
  const NEW_CAPTURE: FollowUpRecord = {
    question: 'What starts the second request?',
    askedAt: 1_758_000_060_000,
    needsNewCapture: true,
    planVersion: 2,
  };
  const UNDECIDED: FollowUpRecord = {
    question: 'Does the later step reuse the earlier result?',
    askedAt: 1_758_000_070_000,
  };
  const LADDER: readonly FollowUpRecord[] = [ANSWERED, STORED, NEW_CAPTURE, UNDECIDED];
  const OUTCOMES = [
    'Answered',
    'Answering from the stored capture',
    'Needs a new capture',
    'Awaiting an answer',
  ];

  /** The asked list, found by the label that names it. */
  function askedList(): HTMLElement {
    return screen.getByRole('list', { name: 'Asked in this session' });
  }

  it('lists every asked follow-up oldest first, verbatim, each with its outcome in words', () => {
    render(<FollowUp onSubmit={submitSpy()} enabled asked={LADDER} />);

    const list = askedList();
    expect(list.tagName).toBe('OL');
    const items = Array.from(list.querySelectorAll('li'));
    expect(items).toHaveLength(LADDER.length);
    // Byte for byte, line breaks included: the text node is the record's question.
    expect(items.map((item) => item.querySelector('.dgv-asked__text')?.textContent)).toEqual(
      LADDER.map((followUp) => followUp.question),
    );
    expect(items.map((item) => item.querySelector('.dg-badge')?.textContent)).toEqual(OUTCOMES);
    for (const item of items) {
      expect(item.classList.contains('dgv-asked-list__item')).toBe(true);
    }
  });

  it.each([
    ['the ready entry', { enabled: true }],
    ['the closed entry', { enabled: false, unavailableReason: 'ended' as const }],
    ['the busy entry', { enabled: true, pending: true }],
    ['the failed entry', { enabled: true, error: 'The stage failed.' }],
  ])('keeps the list above %s', (_label, props) => {
    const { container } = render(<FollowUp onSubmit={submitSpy()} asked={LADDER} {...props} />);

    const root = container.firstElementChild;
    expect(root?.classList.contains(ROOT_CLASS)).toBe(true);
    const list = askedList();
    // The list sits in the root's first child, ahead of whichever state follows it.
    expect(root?.firstElementChild?.contains(list)).toBe(true);
    expect(list.querySelectorAll('li')).toHaveLength(LADDER.length);
  });

  it('renders no list, and no label, for an absent or empty ladder', () => {
    const { rerender, container } = render(<FollowUp onSubmit={submitSpy()} enabled />);
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByText('Asked in this session')).toBeNull();

    rerender(<FollowUp onSubmit={submitSpy()} enabled asked={[]} />);
    expect(screen.queryByRole('list')).toBeNull();
    expect(container.querySelector('.dgv-asked-list')).toBeNull();
  });

  it('keeps an unsent draft when a follow-up is added to the list', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    const { rerender } = render(<FollowUp onSubmit={onSubmit} enabled />);

    await user.type(getField(), 'A draft written before the list grew');
    rerender(<FollowUp onSubmit={onSubmit} enabled asked={[ANSWERED]} />);

    expect(getField().value).toBe('A draft written before the list grew');
    expect(askedList().querySelectorAll('li')).toHaveLength(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('adds no control: the list is text and badges only', () => {
    const { container } = render(
      <FollowUp onSubmit={submitSpy()} enabled={false} asked={LADDER} />,
    );

    expect(allButtons(container)).toEqual([]);
    expect(askedList().querySelector('a, button, input, textarea')).toBeNull();
  });
});

describe('FollowUp — the question is data', () => {
  it('forwards two different wordings verbatim after trimming, with identical output', async () => {
    const user = userEvent.setup();
    const onSubmit = submitSpy();
    const { container, rerender } = render(<FollowUp onSubmit={onSubmit} enabled />);
    const initialText = container.textContent;

    await user.type(getField(), '  Why did this step run twice?  ');
    expect(getSubmit().disabled).toBe(false);
    await user.click(getSubmit());
    rerender(<FollowUp onSubmit={onSubmit} enabled submission={outcome(1, 'accepted')} />);
    const markupAfterFirst = container.innerHTML;

    // Worded to overlap the component's own state vocabulary: the text still selects nothing.
    await user.type(getField(), ' Could a retry after an error leave this step pending? ');
    expect(getSubmit().disabled).toBe(false);
    await user.click(getSubmit());
    rerender(<FollowUp onSubmit={onSubmit} enabled submission={outcome(2, 'accepted')} />);
    const markupAfterSecond = container.innerHTML;

    expect(onSubmit.mock.calls).toEqual([
      ['Why did this step run twice?'],
      ['Could a retry after an error leave this step pending?'],
    ]);
    // Both submissions leave byte-identical markup behind (same root, so the same `useId` ids;
    // the first is compared with the second rather than with the pristine render because
    // toggling `disabled` off and on again reorders the button's serialized attributes), and
    // the visible copy is still the pristine render's.
    expect(markupAfterSecond).toBe(markupAfterFirst);
    expect(container.textContent).toBe(initialText);
    expect(getField().value).toBe('');
    expect(getSubmit().disabled).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
