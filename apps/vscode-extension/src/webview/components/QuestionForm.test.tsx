/**
 * `components/QuestionForm` — the question entry of the VS Code view.
 *
 * What this suite protects:
 *
 *   - the exact payload: `onSubmit` receives the trimmed draft, once, and the
 *     draft is KEPT until a `submission` outcome reports it accepted;
 *   - the submission outcome: `accepted` clears the draft, `failed` keeps it
 *     and shows a retry hint that describes the field until the next submit,
 *     each `seq` is applied exactly once, and an outcome present at mount is
 *     not applied;
 *   - refusal of an empty or whitespace-only draft, by the button and by the
 *     keyboard chord alike, without an error;
 *   - the three states of AAP 0.5.5 and their precedence (error > pending >
 *     unavailable > data), each rendered through its design-system primitive
 *     and never as a blank area;
 *   - the inert form while `disabled`, and the draft surviving a round trip
 *     through `disabled`, `pending` and `error`;
 *   - the design-system shape: a labelled multi-line field, no `<form>`, every
 *     button `type="button"`, and the root block class composed with the
 *     caller's;
 *   - the no-hardcoding guarantee at component level (AAP 0.5.4): two
 *     questions that differ only in wording behave and render identically;
 *   - privacy (AAP 0.5.2): typing and submitting a question writes nothing to
 *     the console.
 *
 * Harness conventions follow the rest of the repository: the Vitest API is
 * imported explicitly, `cleanup` and `vi.restoreAllMocks` are registered
 * explicitly, elements are found by role, label and accessible name, and —
 * with no `jest-dom` in this repository — state is read from DOM properties.
 * Fixture wording is neutral and synthetic (AAP 0.5.4).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SubmissionOutcome } from '../pending-actions';

import { QuestionForm } from './QuestionForm';

const FIELD_NAME = 'What do you want to debug?';
const SUBMIT_NAME = 'Ask question';
const UNAVAILABLE_TEXT = 'Start the local service to begin a session.';
const RETRY_HINT_TEXT =
  'Your question was not confirmed, so it is kept here. Press “Ask question” to try again.';

/** An outcome for the submission numbered `seq`. */
function outcome(seq: number, status: SubmissionOutcome['status']): SubmissionOutcome {
  return { seq, status };
}

/** The retry hint, when it is on display. */
function queryRetryHint(): HTMLElement | null {
  return screen.queryByText(RETRY_HINT_TEXT);
}

/** The console methods a question must never reach (AAP 0.5.2). */
const CONSOLE_METHODS = ['log', 'warn', 'error', 'info', 'debug'] as const;

afterEach(cleanup);
afterEach(() => {
  vi.restoreAllMocks();
});

/** The text area, narrowed to its element type. */
function getField(): HTMLTextAreaElement {
  const field = screen.getByRole('textbox', { name: FIELD_NAME });
  if (!(field instanceof HTMLTextAreaElement)) {
    throw new Error('expected the question field to be a <textarea>');
  }
  return field;
}

/** The submit control, narrowed to its element type. */
function getSubmit(): HTMLButtonElement {
  const button = screen.getByRole('button', { name: SUBMIT_NAME });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('expected the submit control to be a <button>');
  }
  return button;
}

/** Replaces the draft, as a keystroke into the controlled field would. */
function typeDraft(text: string): void {
  fireEvent.change(getField(), { target: { value: text } });
}

describe('QuestionForm — default state', () => {
  it('renders a labelled multi-line field, the DevTools hint and a disabled submit control', () => {
    const { container } = render(<QuestionForm onSubmit={vi.fn()} />);

    const field = getField();
    expect(field.tagName).toBe('TEXTAREA');
    expect(field.value).toBe('');
    expect(field.disabled).toBe(false);

    // A real <label for> names the field, never an aria-label substitute.
    const label = container.querySelector(`label[for="${field.id}"]`);
    expect(label?.textContent).toBe(FIELD_NAME);
    expect(field.getAttribute('aria-label')).toBeNull();

    expect(
      screen.getByText(/select it in the Debug Generator panel in Chrome DevTools/),
    ).toBeTruthy();

    const submit = getSubmit();
    expect(submit.type).toBe('button');
    expect(submit.disabled).toBe(true);

    // No <form>: a form submission would navigate the webview document.
    expect(container.querySelector('form')).toBeNull();
  });

  it('names the field through its visible label', () => {
    render(<QuestionForm onSubmit={vi.fn()} />);

    // `Input` renders a real `<label htmlFor>`, so the label query resolves to
    // the very element the role query finds.
    const byLabel = screen.getByLabelText(FIELD_NAME);
    expect(byLabel).toBe(getField());
  });

  it('renders every button as type="button", in the data and the error state', () => {
    const { rerender } = render(<QuestionForm onSubmit={vi.fn()} />);

    const dataButtons = screen.getAllByRole('button');
    expect(dataButtons.length).toBeGreaterThan(0);
    for (const button of dataButtons) {
      expect((button as HTMLButtonElement).type).toBe('button');
    }

    rerender(<QuestionForm onSubmit={vi.fn()} error="Stage failed." onRetry={vi.fn()} />);

    const errorButtons = screen.getAllByRole('button');
    expect(errorButtons.length).toBeGreaterThan(0);
    for (const button of errorButtons) {
      expect((button as HTMLButtonElement).type).toBe('button');
    }
  });

  it('describes the field with the DevTools hint and the keyboard shortcut', () => {
    render(<QuestionForm onSubmit={vi.fn()} />);

    const describedBy = (getField().getAttribute('aria-describedby') ?? '').split(' ');
    const descriptions = describedBy.map((id) => document.getElementById(id)?.textContent ?? '');

    expect(descriptions.some((text) => text.includes('Chrome DevTools'))).toBe(true);
    expect(descriptions.some((text) => text.includes('to ask'))).toBe(true);
  });

  it('composes the root block class with the caller class', () => {
    const { container } = render(<QuestionForm onSubmit={vi.fn()} className="extra-placement" />);

    const root = container.firstElementChild;
    expect(root?.classList.contains('dgv-question-form')).toBe(true);
    expect(root?.classList.contains('extra-placement')).toBe(true);
  });

  it('leaves no stray class when the caller class is blank', () => {
    const { container } = render(<QuestionForm onSubmit={vi.fn()} className="  " />);

    const root = container.firstElementChild;
    expect(root?.classList.contains('dgv-question-form')).toBe(true);
    expect(root?.getAttribute('class')?.includes('  ')).toBe(false);
  });
});

describe('QuestionForm — submission', () => {
  it('hands up the trimmed draft exactly once and keeps the field until it is accepted', () => {
    const onSubmit = vi.fn<(question: string) => void>();
    render(<QuestionForm onSubmit={onSubmit} />);

    typeDraft('   Why does this list take so long to appear?  \n');
    expect(getSubmit().disabled).toBe(false);

    fireEvent.click(getSubmit());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('Why does this list take so long to appear?');
    // Nothing has confirmed the question yet, so the text stays exactly as typed.
    expect(getField().value).toBe('   Why does this list take so long to appear?  \n');
    expect(queryRetryHint()).toBeNull();
  });

  it('hands up the trimmed draft when typed and clicked through user-event', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(question: string) => void>();
    render(<QuestionForm onSubmit={onSubmit} />);

    await user.type(getField(), '   Where does the time go after the first click?   ');
    await user.click(getSubmit());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('Where does the time go after the first click?');
    expect(getField().value).toBe('   Where does the time go after the first click?   ');
  });

  it('refuses an untouched field by the button and by the keyboard chord', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(question: string) => void>();
    render(<QuestionForm onSubmit={onSubmit} />);

    expect(getField().value).toBe('');
    expect(getSubmit().disabled).toBe(true);

    await user.click(getSubmit());
    fireEvent.click(getSubmit());
    fireEvent.keyDown(getField(), { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(getField(), { key: 'Enter', metaKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('refuses a draft of three spaces', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(question: string) => void>();
    render(<QuestionForm onSubmit={onSubmit} />);

    await user.type(getField(), '   ');
    expect(getField().value).toBe('   ');
    expect(getSubmit().disabled).toBe(true);

    await user.click(getSubmit());
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps inner line breaks of a multi-line question', () => {
    const onSubmit = vi.fn<(question: string) => void>();
    render(<QuestionForm onSubmit={onSubmit} />);

    typeDraft('\nFirst line of context\nSecond line of context\n');
    fireEvent.click(getSubmit());

    expect(onSubmit).toHaveBeenCalledWith('First line of context\nSecond line of context');
  });

  it('refuses a whitespace-only draft without raising the callback', () => {
    const onSubmit = vi.fn<(question: string) => void>();
    render(<QuestionForm onSubmit={onSubmit} />);

    typeDraft(' \n\t  ');
    expect(getSubmit().disabled).toBe(true);

    fireEvent.click(getSubmit());
    fireEvent.keyDown(getField(), { key: 'Enter', ctrlKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
    // The refused draft stays where the developer left it.
    expect(getField().value).toBe(' \n\t  ');
  });

  it('submits with Ctrl+Enter and with Cmd+Enter, but not with plain Enter', () => {
    const onSubmit = vi.fn<(question: string) => void>();
    render(<QuestionForm onSubmit={onSubmit} />);

    typeDraft('First question');
    fireEvent.keyDown(getField(), { key: 'Enter' });
    fireEvent.keyDown(getField(), { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(getField(), { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenLastCalledWith('First question');

    typeDraft('Second question');
    fireEvent.keyDown(getField(), { key: 'Enter', metaKey: true });
    expect(onSubmit).toHaveBeenLastCalledWith('Second question');

    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('does not submit while an input method is composing', () => {
    const onSubmit = vi.fn<(question: string) => void>();
    render(<QuestionForm onSubmit={onSubmit} />);

    typeDraft('Composed question');
    fireEvent.keyDown(getField(), { key: 'Enter', ctrlKey: true, isComposing: true });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(getField().value).toBe('Composed question');
  });

  it('submits real keystrokes typed through the keyboard', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(question: string) => void>();
    render(<QuestionForm onSubmit={onSubmit} />);

    await user.click(getField());
    await user.keyboard('What happens after this step?{Enter}More context');
    // Plain Enter inserted a newline rather than submitting.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(getField().value).toBe('What happens after this step?\nMore context');

    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('What happens after this step?\nMore context');
  });

  it('forwards two different wordings verbatim, with identical behaviour', () => {
    const onSubmit = vi.fn<(question: string) => void>();
    const { container, rerender } = render(<QuestionForm onSubmit={onSubmit} />);

    // The component-level counterpart of AAP 0.5.4: the text is data, so two
    // wordings of one question must meet the same controls, reach the callback
    // untransformed and leave the same markup behind once accepted. Markup is
    // compared between the two rounds rather than against the first render,
    // because toggling `disabled` legitimately reorders the button's attributes.
    const wordings = ['Why is this view slow?', 'What makes this view slow?'] as const;
    const markupAfterSubmit: string[] = [];

    wordings.forEach((wording, index) => {
      typeDraft(`  ${wording}  `);
      expect(getSubmit().disabled).toBe(false);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();

      fireEvent.click(getSubmit());
      rerender(<QuestionForm onSubmit={onSubmit} submission={outcome(index + 1, 'accepted')} />);

      expect(onSubmit).toHaveBeenLastCalledWith(wording);
      expect(getField().value).toBe('');
      expect(getSubmit().disabled).toBe(true);
      markupAfterSubmit.push(container.innerHTML);
    });

    expect(onSubmit.mock.calls).toEqual([[wordings[0]], [wordings[1]]]);
    expect(markupAfterSubmit[1]).toBe(markupAfterSubmit[0]);
  });

  it('keeps the draft when the callback throws', () => {
    // React 19 reports an event-handler error through `console.error` instead
    // of rethrowing it from the dispatch, so the report is captured here to
    // keep the run's output clean, and the throw is read off the mock.
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onSubmit = vi.fn<(question: string) => void>(() => {
      throw new Error('host unreachable');
    });
    try {
      render(<QuestionForm onSubmit={onSubmit} />);

      typeDraft('Kept question');
      fireEvent.keyDown(getField(), { key: 'Enter', ctrlKey: true });

      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit.mock.results[0]?.type).toBe('throw');
      expect(getField().value).toBe('Kept question');
      expect(getSubmit().disabled).toBe(false);
    } finally {
      reported.mockRestore();
    }
  });
});

describe('QuestionForm — submission outcome', () => {
  it('clears the draft once the submission is accepted', () => {
    const onSubmit = vi.fn<(question: string) => void>();
    const { rerender } = render(<QuestionForm onSubmit={onSubmit} />);

    typeDraft('Why does the second step wait?');
    fireEvent.click(getSubmit());
    rerender(<QuestionForm onSubmit={onSubmit} pending />);
    expect(screen.queryByRole('textbox')).toBeNull();

    rerender(<QuestionForm onSubmit={onSubmit} submission={outcome(1, 'accepted')} />);

    expect(getField().value).toBe('');
    expect(getSubmit().disabled).toBe(true);
    expect(queryRetryHint()).toBeNull();
  });

  it('keeps the draft after a failed submission and shows a retry hint describing the field', () => {
    const onSubmit = vi.fn<(question: string) => void>();
    const { rerender } = render(<QuestionForm onSubmit={onSubmit} />);

    typeDraft('Why does the second step wait?');
    fireEvent.click(getSubmit());
    rerender(<QuestionForm onSubmit={onSubmit} pending />);
    rerender(<QuestionForm onSubmit={onSubmit} submission={outcome(1, 'failed')} />);

    expect(getField().value).toBe('Why does the second step wait?');
    expect(getSubmit().disabled).toBe(false);
    const hint = queryRetryHint();
    expect(hint).not.toBeNull();
    const describedBy = (getField().getAttribute('aria-describedby') ?? '').split(' ');
    expect(describedBy).toContain(hint?.id);
    // The hint is guidance, not a failure state: the field stays, no alert is raised.
    expect(screen.queryByRole('alert')).toBeNull();

    // Retrying hands the same question up again.
    fireEvent.click(getSubmit());
    expect(onSubmit.mock.calls).toEqual([
      ['Why does the second step wait?'],
      ['Why does the second step wait?'],
    ]);
  });

  it('hides the retry hint on the next submit', () => {
    const onSubmit = vi.fn<(question: string) => void>();
    const { rerender } = render(<QuestionForm onSubmit={onSubmit} />);

    typeDraft('Why does the second step wait?');
    fireEvent.click(getSubmit());
    rerender(<QuestionForm onSubmit={onSubmit} submission={outcome(1, 'failed')} />);
    expect(queryRetryHint()).not.toBeNull();

    fireEvent.keyDown(getField(), { key: 'Enter', ctrlKey: true });

    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(queryRetryHint()).toBeNull();
    const describedBy = (getField().getAttribute('aria-describedby') ?? '').split(' ');
    expect(describedBy.every((id) => document.getElementById(id) !== null)).toBe(true);
    expect(getField().value).toBe('Why does the second step wait?');
  });

  it('applies an outcome once: the same seq passed again changes nothing', () => {
    const onSubmit = vi.fn<(question: string) => void>();
    const accepted = outcome(1, 'accepted');
    const { rerender } = render(<QuestionForm onSubmit={onSubmit} />);

    typeDraft('First question');
    fireEvent.click(getSubmit());
    rerender(<QuestionForm onSubmit={onSubmit} submission={accepted} />);
    expect(getField().value).toBe('');

    // A new draft survives re-renders carrying the already-applied outcome,
    // whether it is the same object or an equal copy.
    typeDraft('A draft typed afterwards');
    rerender(<QuestionForm onSubmit={onSubmit} submission={accepted} />);
    rerender(<QuestionForm onSubmit={onSubmit} submission={outcome(1, 'accepted')} />);
    expect(getField().value).toBe('A draft typed afterwards');

    // A failed outcome's hint, once retired by a submit, does not come back
    // when the same outcome is passed again.
    fireEvent.click(getSubmit());
    rerender(<QuestionForm onSubmit={onSubmit} submission={outcome(2, 'failed')} />);
    expect(queryRetryHint()).not.toBeNull();
    fireEvent.click(getSubmit());
    expect(queryRetryHint()).toBeNull();
    rerender(<QuestionForm onSubmit={onSubmit} submission={outcome(2, 'failed')} />);
    expect(queryRetryHint()).toBeNull();
    expect(getField().value).toBe('A draft typed afterwards');
  });

  it('clears a kept draft and its hint when a later submission is accepted', () => {
    const onSubmit = vi.fn<(question: string) => void>();
    const { rerender } = render(<QuestionForm onSubmit={onSubmit} />);

    typeDraft('Why does the second step wait?');
    fireEvent.click(getSubmit());
    rerender(<QuestionForm onSubmit={onSubmit} submission={outcome(1, 'failed')} />);
    fireEvent.click(getSubmit());
    rerender(<QuestionForm onSubmit={onSubmit} submission={outcome(2, 'accepted')} />);

    expect(getField().value).toBe('');
    expect(queryRetryHint()).toBeNull();
  });

  it('does not apply an outcome that was already present when the form mounted', () => {
    const onSubmit = vi.fn<(question: string) => void>();
    const { rerender } = render(
      <QuestionForm onSubmit={onSubmit} submission={outcome(4, 'failed')} />,
    );

    expect(queryRetryHint()).toBeNull();
    typeDraft('A fresh draft');
    rerender(<QuestionForm onSubmit={onSubmit} submission={outcome(4, 'failed')} />);

    expect(getField().value).toBe('A fresh draft');
    expect(queryRetryHint()).toBeNull();
  });

  it('keeps the hint and the draft while the form is unavailable, and shows both again after', () => {
    const onSubmit = vi.fn<(question: string) => void>();
    const { rerender } = render(<QuestionForm onSubmit={onSubmit} />);

    typeDraft('Why does the second step wait?');
    fireEvent.click(getSubmit());
    rerender(<QuestionForm onSubmit={onSubmit} submission={outcome(1, 'failed')} unavailable />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(queryRetryHint()).toBeNull();

    rerender(<QuestionForm onSubmit={onSubmit} submission={outcome(1, 'failed')} />);
    expect(getField().value).toBe('Why does the second step wait?');
    expect(queryRetryHint()).not.toBeNull();
  });
});

describe('QuestionForm — disabled', () => {
  it('makes the field and the submit control inert, and keeps the draft', () => {
    const onSubmit = vi.fn<(question: string) => void>();
    const { rerender } = render(<QuestionForm onSubmit={onSubmit} />);

    typeDraft('Draft in progress');
    rerender(<QuestionForm onSubmit={onSubmit} disabled />);

    expect(getField().disabled).toBe(true);
    expect(getSubmit().disabled).toBe(true);
    fireEvent.click(getSubmit());
    fireEvent.keyDown(getField(), { key: 'Enter', ctrlKey: true });
    expect(onSubmit).not.toHaveBeenCalled();

    rerender(<QuestionForm onSubmit={onSubmit} disabled={false} />);
    expect(getField().value).toBe('Draft in progress');
    expect(getSubmit().disabled).toBe(false);
  });
});

describe('QuestionForm — pending', () => {
  it('replaces the field and its controls with a loading state', () => {
    render(<QuestionForm onSubmit={vi.fn()} pending />);

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.textContent).toContain('Submitting your question');

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: SUBMIT_NAME })).toBeNull();
  });

  it('keeps the draft across the pending state and never submits during it', () => {
    const onSubmit = vi.fn<(question: string) => void>();
    const { rerender } = render(<QuestionForm onSubmit={onSubmit} />);

    typeDraft('Unsent draft');
    rerender(<QuestionForm onSubmit={onSubmit} pending />);
    expect(onSubmit).not.toHaveBeenCalled();

    rerender(<QuestionForm onSubmit={onSubmit} pending={false} />);
    expect(getField().value).toBe('Unsent draft');
    expect(getSubmit().disabled).toBe(false);
  });
});

describe('QuestionForm — unavailable', () => {
  it('shows a generic empty state instead of the field', () => {
    render(<QuestionForm onSubmit={vi.fn()} unavailable />);

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBeNull();
    expect(status.textContent).toContain(UNAVAILABLE_TEXT);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('QuestionForm — error', () => {
  it('shows the message and a retry control wired to onRetry', () => {
    const onRetry = vi.fn();
    render(
      <QuestionForm
        onSubmit={vi.fn()}
        error="The local service rejected the request."
        onRetry={onRetry}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Your question could not be processed');
    expect(alert.textContent).toContain('The local service rejected the request.');
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders no retry control when onRetry is absent', () => {
    render(<QuestionForm onSubmit={vi.fn()} error="Stage failed." />);

    expect(screen.getByRole('alert').textContent).toContain('Stage failed.');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('takes precedence over pending and unavailable', () => {
    render(<QuestionForm onSubmit={vi.fn()} error="Stage failed." pending unavailable />);

    expect(screen.getByRole('alert').textContent).toContain('Stage failed.');
    // Only the alert: no loading state, no empty state, no field.
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText('Submitting your question')).toBeNull();
    expect(screen.queryByText(UNAVAILABLE_TEXT)).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: SUBMIT_NAME })).toBeNull();
  });

  it('treats a blank message as no error', () => {
    render(<QuestionForm onSubmit={vi.fn()} error="   " />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(getField()).toBeTruthy();
  });

  it('keeps the draft across the error state', () => {
    const onSubmit = vi.fn<(question: string) => void>();
    const { rerender } = render(<QuestionForm onSubmit={onSubmit} />);

    typeDraft('Draft before failure');
    rerender(<QuestionForm onSubmit={onSubmit} error="Stage failed." />);
    rerender(<QuestionForm onSubmit={onSubmit} />);

    expect(getField().value).toBe('Draft before failure');
  });
});

describe('QuestionForm — state precedence', () => {
  it('shows pending before unavailable', () => {
    render(<QuestionForm onSubmit={vi.fn()} pending unavailable />);

    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText(UNAVAILABLE_TEXT)).toBeNull();
  });
});

describe('QuestionForm — privacy', () => {
  it('writes nothing to the console while a question is typed and submitted', async () => {
    const spies = CONSOLE_METHODS.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const user = userEvent.setup();
    const onSubmit = vi.fn<(question: string) => void>();
    const { rerender } = render(<QuestionForm onSubmit={onSubmit} />);

    await user.type(getField(), 'Which step of this flow waits the longest?');
    await user.click(getSubmit());
    rerender(<QuestionForm onSubmit={onSubmit} submission={outcome(1, 'accepted')} />);
    await user.type(getField(), 'And what happens right after it?');
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    rerender(<QuestionForm onSubmit={onSubmit} submission={outcome(1, 'accepted')} pending />);
    rerender(<QuestionForm onSubmit={onSubmit} submission={outcome(2, 'failed')} />);
    rerender(
      <QuestionForm
        onSubmit={onSubmit}
        submission={outcome(2, 'failed')}
        error="Stage failed."
        onRetry={vi.fn()}
      />,
    );

    expect(onSubmit.mock.calls).toEqual([
      ['Which step of this flow waits the longest?'],
      ['And what happens right after it?'],
    ]);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
