/**
 * `components/QuestionForm` — the question entry of the VS Code view.
 *
 * What this suite protects:
 *
 *   - the exact payload: `onSubmit` receives the trimmed draft, once, and the
 *     draft is cleared afterwards;
 *   - refusal of an empty or whitespace-only draft, by the button and by the
 *     keyboard chord alike, without an error;
 *   - the three states of AAP 0.5.5 and their precedence (error > pending >
 *     unavailable > data), each rendered through its design-system primitive
 *     and never as a blank area;
 *   - the inert form while `disabled`, and the draft surviving a round trip
 *     through `disabled`, `pending` and `error`;
 *   - the design-system shape: a labelled multi-line field, no `<form>`, and
 *     the root block class composed with the caller's.
 *
 * Harness conventions follow the rest of the repository: the Vitest API is
 * imported explicitly, `cleanup` is registered explicitly, elements are found
 * by role and accessible name, and — with no `jest-dom` in this repository —
 * state is read from DOM properties. Fixture wording is generic (AAP 0.5.4).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QuestionForm } from './QuestionForm';

const FIELD_NAME = 'What do you want to debug?';
const SUBMIT_NAME = 'Ask question';

afterEach(cleanup);

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
  it('hands up the trimmed draft exactly once and clears the field', () => {
    const onSubmit = vi.fn<(question: string) => void>();
    render(<QuestionForm onSubmit={onSubmit} />);

    typeDraft('   Why does this list take so long to appear?  \n');
    expect(getSubmit().disabled).toBe(false);

    fireEvent.click(getSubmit());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('Why does this list take so long to appear?');
    expect(getField().value).toBe('');
    expect(getSubmit().disabled).toBe(true);
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
    await user.keyboard('Why is this slow?{Enter}More context');
    // Plain Enter inserted a newline rather than submitting.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(getField().value).toBe('Why is this slow?\nMore context');

    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('Why is this slow?\nMore context');
  });

  it('forwards two different wordings verbatim, with identical behaviour', () => {
    const onSubmit = vi.fn<(question: string) => void>();
    render(<QuestionForm onSubmit={onSubmit} />);

    typeDraft('Why is this view slow?');
    fireEvent.click(getSubmit());
    typeDraft('What makes this view slow?');
    fireEvent.click(getSubmit());

    expect(onSubmit.mock.calls).toEqual([
      ['Why is this view slow?'],
      ['What makes this view slow?'],
    ]);
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
    expect(status.textContent).toContain('Start the local service to begin a session.');
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
    expect(screen.queryByRole('status')).toBeNull();
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
    expect(screen.queryByText('Start the local service to begin a session.')).toBeNull();
  });
});
