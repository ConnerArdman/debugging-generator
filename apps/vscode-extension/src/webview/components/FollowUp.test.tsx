/**
 * `components/FollowUp` — the follow-up question entry of the VS Code view (AAP 0.7.3).
 *
 * What this suite protects:
 *
 *   - the gate: follow-ups exist only once the session has produced a result. The gate is the
 *     `enabled` prop that `App.tsx` computes, never an inference from an analysis object, and
 *     while it is closed the component explains itself with a generic empty state instead of
 *     rendering a field that could not do anything (AAP 0.4.2, 0.5.5);
 *   - the exact payload: `onSubmit` receives the trimmed draft, once and alone, and the draft is
 *     KEPT until a `submission` outcome reports it accepted; blank drafts are refused by the button
 *     and by the keyboard chord;
 *   - the submission outcome: `accepted` clears the draft, `failed` keeps it and shows a retry hint
 *     describing the field until the next submit, each `seq` is applied exactly once, an outcome
 *     present at mount is not applied, and focus lost while the field was replaced or its submit
 *     control disabled returns to the field — focus moved elsewhere is left alone;
 *   - the keyboard contract: `Ctrl`/`⌘`+`Enter` submits, plain `Enter` inserts a line break;
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

import type { SubmissionOutcome } from '../pending-actions';

import { FollowUp } from './FollowUp';

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
    const describedBy = (field.getAttribute('aria-describedby') ?? '').split(' ');
    const descriptions = describedBy.map((id) => document.getElementById(id)?.textContent ?? '');
    expect(descriptions.some((text) => text.includes('Ctrl+Enter'))).toBe(true);

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
