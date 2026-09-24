/**
 * The contract of `components/RelevantFiles` — the investigation's selection in
 * the editor webview (AAP 0.7.3), and the list AAP 0.8.4's first acceptance
 * test reads.
 *
 * Pinned here:
 *
 *   - **Order is the pipeline's.** One row per entry, in the order given, never
 *     re-sorted by score.
 *   - **The payload is untouched.** Activating a row — by pointer or keyboard —
 *     raises `onOpenFile` with the entry's `file` string exactly as received.
 *   - **Faithful text.** Path, symbol and reason render verbatim; the score is
 *     formatted to two decimals; an absent symbol leaves no element behind.
 *   - **Accessible rows.** Each row is a button named by its file (and symbol)
 *     and described by its reason, inside an ordered list.
 *   - **The three states** and their precedence: error > pending > empty > list.
 *
 * The fixture paths and prose are generic vocabulary written for this suite;
 * no inspected project's names appear in it (AAP 0.5.4).
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { RelevantFile } from '@debuggen/protocol';

import { RelevantFiles } from './RelevantFiles';

/** Three entries whose scores are deliberately NOT in descending order. */
const FILES: readonly RelevantFile[] = [
  {
    file: 'src/features/alpha/Widget.tsx',
    symbol: 'onActivate',
    reason: 'Registers the handler the selected element dispatches to.',
    score: 0.42,
  },
  {
    file: 'src/server/beta/handler.ts',
    reason: 'Serves the request the handler issues.',
    score: 0.9,
  },
  {
    file: 'src/lib/gamma.ts',
    symbol: 'loadRecords',
    reason: 'Queries the database on behalf of the handler.',
    score: 0.125,
  },
];

/** A no-op callback for the cases that do not observe activation. */
function noop(): void {
  // Intentionally empty: these cases assert on rendering only.
}

/**
 * The single ordered list the component renders.
 *
 * @returns The `<ol>` element.
 */
function theList(): HTMLElement {
  const list = screen.getByRole('list');
  expect(list.tagName).toBe('OL');
  return list;
}

describe('RelevantFiles list', () => {
  it('renders one row per entry, in the given order, without re-sorting by score', () => {
    render(<RelevantFiles files={FILES} onOpenFile={noop} />);

    const items = within(theList()).getAllByRole('listitem');
    expect(items).toHaveLength(FILES.length);

    const renderedPaths = items.map(
      (item) => item.querySelector('.dgv-files__path')?.textContent ?? '',
    );
    expect(renderedPaths).toEqual(FILES.map((entry) => entry.file));
  });

  it('names each row button by its file and symbol, and describes it by its reason and score', () => {
    render(<RelevantFiles files={FILES} onOpenFile={noop} />);

    const buttons = within(theList()).getAllByRole('button');
    expect(buttons).toHaveLength(FILES.length);

    expect(buttons[0]).toHaveProperty('type', 'button');
    expect(screen.getByRole('button', { name: 'src/features/alpha/Widget.tsx onActivate' })).toBe(
      buttons[0],
    );
    expect(screen.getByRole('button', { name: 'src/server/beta/handler.ts' })).toBe(buttons[1]);
    expect(screen.getByRole('button', { name: 'src/lib/gamma.ts loadRecords' })).toBe(buttons[2]);

    const first = buttons[0];
    if (first === undefined) {
      throw new Error('expected a first row button');
    }
    const describedBy = first.getAttribute('aria-describedby')?.split(' ') ?? [];
    const description = describedBy
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(description).toContain('Registers the handler the selected element dispatches to.');
    expect(description).toContain('0.42');
  });

  it('renders path, symbol and reason verbatim and formats the score to two decimals', () => {
    render(<RelevantFiles files={FILES} onOpenFile={noop} />);

    const [first, , third] = within(theList()).getAllByRole('listitem');
    if (first === undefined || third === undefined) {
      throw new Error('expected three rows');
    }

    const path = first.querySelector('.dgv-files__path');
    expect(path?.tagName).toBe('CODE');
    expect(path?.getAttribute('title')).toBe('src/features/alpha/Widget.tsx');
    expect(within(first).getByText('onActivate')).toBeDefined();
    expect(first.querySelector('.dgv-files__reason')?.textContent).toBe(
      'Registers the handler the selected element dispatches to.',
    );
    expect(first.querySelector('.dgv-files__score')?.textContent).toBe('Relevance score 0.42');
    expect(third.querySelector('.dgv-files__score')?.textContent).toBe('Relevance score 0.13');
  });

  it('leaves no symbol element behind when an entry has no symbol', () => {
    render(<RelevantFiles files={FILES} onOpenFile={noop} />);

    const second = within(theList()).getAllByRole('listitem')[1];
    if (second === undefined) {
      throw new Error('expected a second row');
    }
    const button = within(second).getByRole('button');
    const labelledBy = button.getAttribute('aria-labelledby')?.split(' ') ?? [];
    expect(labelledBy).toHaveLength(1);

    const meta = second.querySelector('.dgv-files__meta');
    expect(meta?.querySelectorAll('.dg-text--accent')).toHaveLength(0);
    expect(second.querySelector('.dgv-files__score')?.textContent).toBe('Relevance score 0.90');
  });

  it('renders no score chip for a non-finite score instead of printing NaN', () => {
    const entry: RelevantFile = { file: 'src/a.ts', reason: 'Listed.', score: Number.NaN };
    render(<RelevantFiles files={[entry]} onOpenFile={noop} />);

    expect(document.querySelector('.dgv-files__score')).toBeNull();
    expect(document.body.textContent).not.toContain('NaN');
    const button = screen.getByRole('button', { name: 'src/a.ts' });
    expect(button.getAttribute('aria-describedby')?.split(' ')).toHaveLength(1);
  });

  it('merges the caller class onto the list after its own', () => {
    render(<RelevantFiles files={FILES} onOpenFile={noop} className="extra-layout" />);

    expect(theList().className).toBe('dgv-files extra-layout');
  });

  it('keeps ids unique across two lists on one page', () => {
    render(
      <>
        <RelevantFiles files={FILES} onOpenFile={noop} />
        <RelevantFiles files={FILES} onOpenFile={noop} />
      </>,
    );

    const ids = Array.from(document.querySelectorAll('[id]'), (element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('RelevantFiles activation', () => {
  it('raises onOpenFile with the untouched file string on click', async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn<(file: string) => void>();
    render(<RelevantFiles files={FILES} onOpenFile={onOpenFile} />);

    await user.click(screen.getByRole('button', { name: 'src/lib/gamma.ts loadRecords' }));

    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith('src/lib/gamma.ts');
  });

  it('is operable from the keyboard with Enter and Space', async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn<(file: string) => void>();
    render(<RelevantFiles files={FILES} onOpenFile={onOpenFile} />);

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'src/features/alpha/Widget.tsx onActivate' }),
    );
    await user.keyboard('{Enter}');

    await user.tab();
    await user.keyboard(' ');

    expect(onOpenFile.mock.calls).toEqual([
      ['src/features/alpha/Widget.tsx'],
      ['src/server/beta/handler.ts'],
    ]);
  });
});

describe('RelevantFiles states', () => {
  it('renders the empty state with generic copy when no files were identified', () => {
    render(<RelevantFiles files={[]} onOpenFile={noop} className="extra-layout" />);

    const status = screen.getByRole('status');
    expect(status.textContent).toBe('No files have been identified yet.');
    expect(status.classList.contains('extra-layout')).toBe(true);
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('renders the loading state while pending, even when files are present', () => {
    render(<RelevantFiles files={FILES} onOpenFile={noop} pending />);

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.textContent).toContain('Loading relevant files…');
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('renders the error state with the message, outranking pending and data', () => {
    render(<RelevantFiles files={FILES} onOpenFile={noop} pending error="Investigation failed." />);

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Investigation failed.')).toBeDefined();
    expect(within(alert).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('offers a retry action in the error state only when onRetry is supplied', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn<() => void>();
    render(
      <RelevantFiles
        files={[]}
        onOpenFile={noop}
        error="Investigation failed."
        onRetry={onRetry}
      />,
    );

    await user.click(within(screen.getByRole('alert')).getByRole('button'));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('treats a blank error as no error', () => {
    render(<RelevantFiles files={FILES} onOpenFile={noop} error="   " />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(theList()).toBeDefined();
  });
});
