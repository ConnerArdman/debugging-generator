/**
 * The dismiss control of `primitives/ErrorState` — the second, optional
 * control of the action row.
 *
 * A non-blocking failure notice (the DevTools panel's last-failure notice) is
 * the reader's to close. Its close control must be part of the box it closes,
 * so a reader can tell which failure it acts on, which is why the control is a
 * member of the error state rather than a sibling a caller places beside it.
 * Pinned here:
 *
 *   - **Only when asked for.** No dismiss control without `onDismiss`, and no
 *     action row at all when neither callback is supplied.
 *   - **Inside the box, after the retry.** Both controls share the one
 *     `dg-error-state__action` row, retry first.
 *   - **Raised once per click, nothing more.** The component calls the callback
 *     and keeps no state of its own.
 *   - **Named.** A blank label falls back to the default, so the control never
 *     announces as nothing; only the retry carries the focus key.
 *
 * The copy below is generic product vocabulary written for this suite.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ErrorState, ERROR_STATE_RETRY_FOCUS_KEY, FOCUS_KEY_ATTRIBUTE } from './ErrorState';

/** The required sentence every case renders. */
const MESSAGE = 'The request did not complete.';

/** The rendered container: the one element carrying the block class. */
function containerOf(root: HTMLElement): HTMLElement {
  const block = root.querySelector<HTMLElement>('.dg-error-state');
  if (block === null) {
    throw new Error('ErrorState rendered no .dg-error-state container');
  }
  return block;
}

describe('ErrorState — the dismiss control', () => {
  it('renders no action row when neither callback is supplied', () => {
    const { container } = render(<ErrorState message={MESSAGE} />);

    expect(container.querySelector('.dg-error-state__action')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders no dismiss control without onDismiss', () => {
    render(<ErrorState message={MESSAGE} onRetry={vi.fn()} />);

    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Retry']);
  });

  it('places the dismiss control inside the box, in the action row after the retry', () => {
    const { container } = render(
      <ErrorState message={MESSAGE} onRetry={vi.fn()} onDismiss={vi.fn()} />,
    );

    const block = containerOf(container);
    const rows = block.querySelectorAll<HTMLElement>('.dg-error-state__action');
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) {
      throw new Error('no action row');
    }
    expect(
      within(row)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Retry', 'Dismiss']);
    expect(block.lastElementChild).toBe(row);
  });

  it('renders the dismiss control alone when there is nothing to retry', () => {
    const { container } = render(<ErrorState message={MESSAGE} onDismiss={vi.fn()} />);

    const row = containerOf(container).querySelector<HTMLElement>('.dg-error-state__action');
    expect(row).not.toBeNull();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Dismiss']);
  });

  it('raises onDismiss once per click and never onRetry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    render(<ErrorState message={MESSAGE} onRetry={onRetry} onDismiss={onDismiss} />);

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('uses the given label, and falls back to the default for a blank one', () => {
    const { rerender } = render(
      <ErrorState message={MESSAGE} onDismiss={vi.fn()} dismissLabel="Close notice" />,
    );
    expect(screen.getByRole('button', { name: 'Close notice' })).toBeTruthy();

    rerender(<ErrorState message={MESSAGE} onDismiss={vi.fn()} dismissLabel="   " />);
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });

  it('keeps the focus key on the retry control only', () => {
    render(<ErrorState message={MESSAGE} onRetry={vi.fn()} onDismiss={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Retry' }).getAttribute(FOCUS_KEY_ATTRIBUTE)).toBe(
      ERROR_STATE_RETRY_FOCUS_KEY,
    );
    expect(screen.getByRole('button', { name: 'Dismiss' }).hasAttribute(FOCUS_KEY_ATTRIBUTE)).toBe(
      false,
    );
  });
});
