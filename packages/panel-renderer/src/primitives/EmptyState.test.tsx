/**
 * The contract of `primitives/EmptyState` — the settled "nothing of that kind
 * here" state every visualization component renders.
 *
 * Four properties are pinned, each because a component suite cannot see it on
 * its own:
 *
 *   - **The announcement.** The container is a polite `role="status"` by
 *     default, distinct from `LoadingState`'s BUSY status, and a caller's own
 *     `role` replaces the default rather than joining it.
 *   - **The parts and their order.** Glyph, title, message, action — each
 *     optional part leaves no box behind when it is omitted.
 *   - **The glyph is decorative.** Its wrapper is hidden from assistive
 *     technology, so the copy alone carries the meaning.
 *   - **No heading.** An empty state cannot know its outline depth, so the
 *     title is body text and no heading element is emitted in any form.
 *
 * The copy below is generic product vocabulary written for this suite; no
 * inspected project's names appear in it, because the product holds no
 * knowledge of a target application.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Inbox } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';

import { Button } from './Button';
import { EmptyState } from './EmptyState';

/** The required sentence every case renders. */
const MESSAGE = 'No records of this kind were captured.';

/** The optional first line. */
const TITLE = 'No records';

/** The label of the optional action. */
const ACTION_LABEL = 'Capture again';

/** The element class of each part, in the order the contract fixes. */
const PART_CLASSES = [
  'dg-empty-state__icon',
  'dg-empty-state__title',
  'dg-empty-state__message',
  'dg-empty-state__action',
] as const;

/**
 * The rendered container: the one element carrying the block class.
 *
 * @param root The element `render` mounted into.
 */
function containerOf(root: HTMLElement): HTMLElement {
  const block = root.querySelector<HTMLElement>('.dg-empty-state');
  if (block === null) {
    throw new Error('EmptyState rendered no .dg-empty-state container');
  }
  return block;
}

describe('EmptyState announcement', () => {
  it('is a polite status by default, and not a busy one', () => {
    render(<EmptyState message={MESSAGE} />);

    const status = screen.getByRole('status');

    // The settled answer of a query: the container itself, carrying the copy,
    // and never mistaken for the loading state that preceded it.
    expect(status.classList.contains('dg-empty-state')).toBe(true);
    expect(status.textContent).toContain(MESSAGE);
    expect(status.hasAttribute('aria-busy')).toBe(false);
    expect(screen.queryByRole('status', { busy: true })).toBeNull();

    // The role implies the polite announcement; nothing restates it.
    expect(status.hasAttribute('aria-live')).toBe(false);
    expect(status.hasAttribute('aria-atomic')).toBe(false);
  });

  it("uses a caller's role instead of the default", () => {
    const { container } = render(<EmptyState message={MESSAGE} role="note" />);

    // Replaced, not joined: exactly one role, and it is the caller's.
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('note')).toBe(containerOf(container));
  });

  it('keeps the default when a caller forwards an absent role', () => {
    // `exactOptionalPropertyTypes` makes forwarding `undefined` legal, and a
    // forwarded absence must not strip the announcement.
    const forwarded: { role?: string | undefined } = { role: undefined };

    render(<EmptyState message={MESSAGE} {...forwarded} />);

    expect(screen.getByRole('status').textContent).toContain(MESSAGE);
  });

  it('passes every other attribute through to the container unchanged', () => {
    const { container } = render(
      <EmptyState
        message={MESSAGE}
        id="empty-state-under-test"
        className="dg-extra"
        data-node="records"
        aria-label={TITLE}
      />,
    );

    const block = containerOf(container);

    expect(block.id).toBe('empty-state-under-test');
    expect(block.getAttribute('data-node')).toBe('records');
    expect(screen.getByRole('status', { name: TITLE })).toBe(block);

    // Composition after the block class, and no inline style of any kind.
    expect(block.className).toBe('dg-empty-state dg-extra');
    expect(block.hasAttribute('style')).toBe(false);
    expect(block.hasAttribute('tabindex')).toBe(false);
  });
});

describe('EmptyState parts', () => {
  it('renders glyph, title, message and action in that order', async () => {
    const onAction = vi.fn<() => void>();
    const user = userEvent.setup();

    const { container } = render(
      <EmptyState
        icon={<Inbox className="dg-icon" />}
        title={TITLE}
        message={MESSAGE}
        action={
          <Button variant="secondary" size="sm" onClick={onAction}>
            {ACTION_LABEL}
          </Button>
        }
      />,
    );

    const block = containerOf(container);

    // Each child named by the part class it carries: `Text` composes its own
    // type-role classes beside the element class, so the order of names on one
    // element is not part of this contract — the order of the parts is.
    expect(
      Array.from(block.children, (child) =>
        PART_CLASSES.find((name) => child.classList.contains(name)),
      ),
    ).toEqual([...PART_CLASSES]);
    expect(block.querySelector('.dg-empty-state__title')?.textContent).toBe(TITLE);
    expect(block.querySelector('.dg-empty-state__message')?.textContent).toBe(MESSAGE);

    // The action is the caller's control, positioned here and raised by it.
    await user.click(within(block).getByRole('button', { name: ACTION_LABEL }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('hides the glyph from assistive technology and keeps it out of the name', () => {
    const { container } = render(
      <EmptyState icon={<Inbox className="dg-icon" />} title={TITLE} message={MESSAGE} />,
    );

    const glyphBox = containerOf(container).querySelector('.dg-empty-state__icon');

    expect(glyphBox?.getAttribute('aria-hidden')).toBe('true');
    expect(glyphBox?.querySelector('svg.dg-icon')).not.toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('leaves no box behind for an omitted, empty or non-rendering part', () => {
    const { container, rerender } = render(<EmptyState message={MESSAGE} />);

    const expectMessageOnly = (): void => {
      const block = containerOf(container);
      expect(block.children).toHaveLength(1);
      expect(block.firstElementChild?.classList.contains('dg-empty-state__message')).toBe(true);
    };

    expectMessageOnly();

    rerender(<EmptyState message={MESSAGE} title="" icon={null} action={false} />);
    expectMessageOnly();

    rerender(<EmptyState message={MESSAGE} title={undefined} icon="" action={undefined} />);
    expectMessageOnly();
  });

  it('keeps a renderable zero as content rather than dropping it', () => {
    const { container } = render(<EmptyState message={MESSAGE} action={0} />);

    expect(containerOf(container).querySelector('.dg-empty-state__action')?.textContent).toBe('0');
  });

  it('emits no heading element, whatever parts it carries', () => {
    const { container } = render(
      <EmptyState icon={<Inbox className="dg-icon" />} title={TITLE} message={MESSAGE} />,
    );

    // The title is a paragraph with a raised weight, never an outline level.
    expect(screen.queryByRole('heading')).toBeNull();
    expect(container.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    expect(screen.getByText(TITLE).tagName).toBe('P');
  });
});
