/**
 * The contract of `components/ModificationsList` — every file the session
 * instrumented, in the editor webview (AAP 0.7.3), and the list AAP 0.8.4's
 * cleanup acceptance test reads.
 *
 * Pinned here:
 *
 *   - **One row per record, in the given order**, each named by its file and
 *     carrying its status badge's text label — colour is never alone.
 *   - **"View diff" is a disclosure** that routes the record's own `diff` into
 *     `DiffView` inside the grid's detail row, wires `aria-expanded` and
 *     `aria-controls`, collapses on a second activation, and moves to another
 *     row when that row's diff is opened. The grid's keyboard toggle drives the
 *     same state.
 *   - **The grid stays one Tab stop**: every control in a cell or in an open
 *     detail row, the diff's scroll region included, is `tabIndex={-1}`.
 *   - **The open-file payload is untouched**, and the control exists only when
 *     a callback is supplied.
 *   - **A conflict is never reported as a revert**, and only a conflict row
 *     shows where its original is preserved.
 *   - **The three states** and their precedence: error > pending > empty > table.
 *
 * The fixture paths, hashes and diffs are generic vocabulary written for this
 * suite; no inspected project's names appear in it (AAP 0.5.4).
 */

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ModificationRecord } from '@debuggen/protocol';

import { ModificationsList } from './ModificationsList';

/** A small, well-formed unified diff for one file. */
function diffFor(file: string, added: string): string {
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1,3 +1,4 @@',
    ' export function run() {',
    `+  ${added}`,
    '   return 1;',
    ' }',
    '',
  ].join('\n');
}

/** A SHA-256-shaped digest built from one repeated hexadecimal digit. */
function digest(digit: string): string {
  return digit.repeat(64);
}

/** Builds one record; every field is a value the schema accepts. */
function record(
  suffix: string,
  file: string,
  status: ModificationRecord['status'],
  extra: Partial<ModificationRecord> = {},
): ModificationRecord {
  return {
    id: `mod_${suffix.padStart(16, '0')}`,
    sessionId: 'ses_fixture',
    planVersion: 1,
    file,
    originalHash: digest('a'),
    backupPath: `/home/dev/.debuggen/backups/ses_fixture/${digest('a')}`,
    instrumentedHash: digest('b'),
    appliedAt: Date.UTC(2026, 0, 15, 9, 30, 0),
    status,
    diff: diffFor(file, `const marker${suffix} = true;`),
    ...extra,
  };
}

/**
 * One record per status, deliberately NOT in alphabetical order of file or
 * status, so an accidental sort would be visible.
 */
const RECORDS: readonly ModificationRecord[] = [
  record('1', 'src/server/zeta/handler.ts', 'applied'),
  record('2', 'src/features/alpha/Widget.tsx', 'conflict'),
  record('3', 'src/lib/mid/loader.ts', 'reverted', {
    planVersion: 2,
    previousRecordId: 'mod_0000000000000001',
    originalHash: digest('b'),
    instrumentedHash: digest('c'),
  }),
  record('4', 'src/lib/beta/queue.ts', 'pending'),
  record('5', 'src/server/eta/jobs.ts', 'failed'),
];

/** The design system's data rows (never the header or a detail row). */
function dataRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.dg-data-table__row'));
}

/** The data row at `index`, failing the test when it is absent. */
function rowAt(container: HTMLElement, index: number): HTMLElement {
  const row = dataRows(container)[index];
  if (row === undefined) {
    throw new Error(`expected a data row at index ${String(index)}`);
  }
  return row;
}

/**
 * Moves focus onto a data row directly. Wrapped in `act` because the grid
 * records the row it gained focus on as its roving stop, a state update.
 */
function focusRow(row: HTMLElement): void {
  act(() => {
    row.focus();
  });
}

/** The open detail rows. */
function detailRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.dg-data-table__expanded'));
}

describe('ModificationsList table', () => {
  it('renders one row per record, in the given order, named by its file', () => {
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    const grid = screen.getByRole('grid', { name: 'Modified files' });
    const headers = within(grid).getAllByRole('rowheader');
    expect(headers).toHaveLength(RECORDS.length);
    expect(dataRows(container)).toHaveLength(RECORDS.length);

    const paths = headers.map(
      (header) => header.querySelector('.dgv-modifications__file')?.textContent ?? '',
    );
    expect(paths).toEqual(RECORDS.map((entry) => entry.file));

    const firstPath = headers[0]?.querySelector('.dgv-modifications__file');
    expect(firstPath?.tagName).toBe('CODE');
    expect(firstPath?.getAttribute('title')).toBe('src/server/zeta/handler.ts');
  });

  it('splits the path so the file name survives truncation, without altering its text', () => {
    const bare = record('8', 'README.md', 'applied');
    const { container } = render(<ModificationsList modifications={[RECORDS[1] ?? bare, bare]} />);

    const nested = rowAt(container, 0).querySelector('.dgv-modifications__file');
    expect(nested?.querySelector('.dgv-modifications__directory')?.textContent).toBe(
      'src/features/alpha/',
    );
    expect(nested?.querySelector('.dgv-modifications__name')?.textContent).toBe('Widget.tsx');
    expect(nested?.textContent).toBe('src/features/alpha/Widget.tsx');

    const flat = rowAt(container, 1).querySelector('.dgv-modifications__file');
    expect(flat?.querySelector('.dgv-modifications__directory')).toBeNull();
    expect(flat?.querySelector('.dgv-modifications__name')?.textContent).toBe('README.md');
  });

  it('labels every status with text on a toned badge', () => {
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    const expected: readonly [string, string][] = [
      ['Applied', 'dg-badge--info'],
      ['Conflict', 'dg-badge--danger'],
      ['Reverted', 'dg-badge--success'],
      ['Pending', 'dg-badge--neutral'],
      ['Failed', 'dg-badge--danger'],
    ];

    expected.forEach(([label, toneClass], index) => {
      const badge = rowAt(container, index).querySelector('.dg-badge');
      expect(badge?.textContent).toBe(label);
      expect(badge?.classList.contains(toneClass)).toBe(true);
    });
  });

  it('says a conflicting file was left untouched with its original preserved, never reverted', () => {
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    const conflictRow = rowAt(container, 1);
    const note = conflictRow.querySelector('.dgv-modifications__note')?.textContent ?? '';
    expect(note).toContain('left it untouched');
    expect(note).toContain('original is preserved');
    expect(conflictRow.textContent ?? '').not.toMatch(/revert/iu);

    // Applied and reverted rows carry no note: their labels say everything.
    expect(rowAt(container, 0).querySelector('.dgv-modifications__note')).toBeNull();
    expect(rowAt(container, 2).querySelector('.dgv-modifications__note')).toBeNull();
    expect(rowAt(container, 3).querySelector('.dgv-modifications__note')).not.toBeNull();
    expect(rowAt(container, 4).querySelector('.dgv-modifications__note')).not.toBeNull();
  });

  it('shows the plan version, the layering and a machine-readable time in the meta line', () => {
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    const layered = rowAt(container, 2).querySelector('.dgv-modifications__meta');
    expect(layered?.textContent ?? '').toContain('Plan v2');
    expect(layered?.textContent ?? '').toContain('Layered on an earlier change');

    const plain = rowAt(container, 0).querySelector('.dgv-modifications__meta');
    expect(plain?.textContent ?? '').toContain('Plan v1');
    expect(plain?.textContent ?? '').not.toContain('Layered');

    const time = plain?.querySelector('time');
    expect(time?.getAttribute('dateTime')).toBe('2026-01-15T09:30:00.000Z');
    expect(time?.textContent).not.toBe('');
  });

  it('renders no time for a timestamp no Date can represent', () => {
    const odd = record('9', 'src/lib/odd.ts', 'applied', { appliedAt: Number.MAX_VALUE });
    const { container } = render(<ModificationsList modifications={[odd]} />);

    expect(rowAt(container, 0).querySelector('time')).toBeNull();
    expect(container.textContent ?? '').not.toContain('Invalid Date');
  });

  it('keeps the grid a single Tab stop: every control inside it is tabIndex -1', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ModificationsList modifications={RECORDS} onOpenFile={vi.fn()} />,
    );

    await user.click(
      screen.getByRole('button', { name: 'View diff of src/server/zeta/handler.ts' }),
    );

    const grid = screen.getByRole('grid');
    const focusable = Array.from(
      grid.querySelectorAll<HTMLElement>('button, [tabindex]:not(.dg-data-table__row)'),
    );
    expect(focusable.length).toBeGreaterThan(RECORDS.length);
    for (const element of focusable) {
      expect(element.getAttribute('tabindex')).toBe('-1');
    }

    const scroll = detailRows(container)[0]?.querySelector('.dgv-diff__scroll');
    expect(scroll?.getAttribute('tabindex')).toBe('-1');
  });
});

describe('ModificationsList "View diff"', () => {
  it('routes the record’s own diff into DiffView and collapses on a second activation', async () => {
    const user = userEvent.setup();
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    const toggle = screen.getByRole('button', {
      name: 'View diff of src/features/alpha/Widget.tsx',
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.hasAttribute('aria-controls')).toBe(false);
    expect(detailRows(container)).toHaveLength(0);

    await user.click(toggle);

    const opened = screen.getByRole('button', {
      name: 'Hide diff of src/features/alpha/Widget.tsx',
    });
    expect(opened).toBe(toggle);
    expect(opened.textContent).toBe('Hide diff');
    expect(opened.getAttribute('aria-expanded')).toBe('true');

    const details = detailRows(container);
    expect(details).toHaveLength(1);
    const detail = details[0];
    if (detail === undefined) {
      throw new Error('expected an open detail row');
    }
    expect(opened.getAttribute('aria-controls')).toBe(detail.id);
    expect(detail.querySelector('[aria-colspan]')?.getAttribute('aria-colspan')).toBe('3');

    const region = within(detail).getByRole('group', {
      name: 'Diff of src/features/alpha/Widget.tsx',
    });
    const lines = Array.from(region.querySelectorAll('.dgv-diff__line')).map(
      (line) => line.textContent ?? '',
    );
    expect(lines.join('\n') + '\n').toBe(RECORDS[1]?.diff);
    expect(region.querySelector('.dgv-diff__line--added')?.textContent).toBe(
      '+  const marker2 = true;',
    );

    await user.click(opened);

    expect(detailRows(container)).toHaveLength(0);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.hasAttribute('aria-controls')).toBe(false);
    expect(toggle.textContent).toBe('View diff');
  });

  it('keeps one diff open at a time, moving the disclosure to the row activated last', async () => {
    const user = userEvent.setup();
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    await user.click(
      screen.getByRole('button', { name: 'View diff of src/server/zeta/handler.ts' }),
    );
    await user.click(screen.getByRole('button', { name: 'View diff of src/lib/mid/loader.ts' }));

    const details = detailRows(container);
    expect(details).toHaveLength(1);
    expect(
      within(details[0] ?? container).getByRole('group', { name: 'Diff of src/lib/mid/loader.ts' }),
    ).toBeDefined();
    expect(
      screen
        .getByRole('button', { name: 'View diff of src/server/zeta/handler.ts' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('shows the hashes, and the preserved original only for a conflict', async () => {
    const user = userEvent.setup();
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    await user.click(
      screen.getByRole('button', { name: 'View diff of src/features/alpha/Widget.tsx' }),
    );
    let detail = detailRows(container)[0];
    const preserved = detail?.querySelector('.dgv-modifications__preserved');
    expect(preserved?.textContent).toBe(`Original preserved at ${RECORDS[1]?.backupPath ?? ''}`);

    const hashes = detail?.querySelector('.dgv-modifications__hashes');
    expect(hashes?.textContent ?? '').toContain(`Original SHA-256 ${digest('a').slice(0, 12)}`);
    expect(hashes?.textContent ?? '').toContain(`Instrumented SHA-256 ${digest('b').slice(0, 12)}`);
    const fullHash = Array.from(hashes?.querySelectorAll('code') ?? []).map((code) =>
      code.getAttribute('title'),
    );
    expect(fullHash).toEqual([digest('a'), digest('b')]);

    await user.click(screen.getByRole('button', { name: 'View diff of src/lib/mid/loader.ts' }));
    detail = detailRows(container)[0];
    expect(detail?.querySelector('.dgv-modifications__preserved')).toBeNull();
    expect(detail?.textContent ?? '').not.toContain('.debuggen/backups');
  });

  it('opens and closes a row’s diff from the grid’s own keyboard toggle', async () => {
    const user = userEvent.setup();
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    focusRow(rowAt(container, 0));
    await user.keyboard('{ArrowRight}');
    expect(detailRows(container)).toHaveLength(1);
    expect(
      screen
        .getByRole('button', { name: 'Hide diff of src/server/zeta/handler.ts' })
        .getAttribute('aria-expanded'),
    ).toBe('true');

    focusRow(rowAt(container, 0));
    await user.keyboard('{ArrowLeft}');
    expect(detailRows(container)).toHaveLength(0);
  });

  it('renders the diff’s own empty state for a record whose diff is blank', async () => {
    const user = userEvent.setup();
    const blank = record('7', 'src/lib/blank.ts', 'applied', { diff: '' });
    const { container } = render(<ModificationsList modifications={[blank]} />);

    await user.click(screen.getByRole('button', { name: 'View diff of src/lib/blank.ts' }));

    const detail = detailRows(container)[0];
    expect(within(detail ?? container).getByRole('status').textContent).toContain(
      'No diff is available for this modification.',
    );
  });
});

describe('ModificationsList open file', () => {
  it('raises onOpenFile with the record’s file exactly as received', async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    render(<ModificationsList modifications={RECORDS} onOpenFile={onOpenFile} />);

    const open = screen.getByRole('button', { name: 'Open file src/lib/beta/queue.ts' });
    expect(open.textContent).toBe('Open file');
    await user.click(open);

    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith('src/lib/beta/queue.ts');
  });

  it('renders no open control when no callback is supplied', () => {
    render(<ModificationsList modifications={RECORDS} />);

    expect(screen.queryByRole('button', { name: /^Open file/u })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^View diff of /u })).toHaveLength(RECORDS.length);
  });
});

describe('ModificationsList states', () => {
  it('renders the neutral empty state, and no grid, when nothing was modified', () => {
    const { container } = render(<ModificationsList modifications={[]} className="extra" />);

    expect(screen.getByRole('status').textContent).toContain(
      'No files were modified for this session.',
    );
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.firstElementChild?.className).toBe('dgv-modifications extra');
  });

  it('renders the loading state while pending, even when records are present', () => {
    const { container } = render(<ModificationsList modifications={RECORDS} pending />);

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('grid')).toBeNull();
    expect(container.firstElementChild?.classList.contains('dgv-modifications')).toBe(true);
  });

  it('renders the error state above every other state, with retry when supplied', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <ModificationsList
        modifications={RECORDS}
        pending
        error="The service did not answer."
        onRetry={onRetry}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The service did not answer.');
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();

    await user.click(within(alert).getByRole('button', { name: /retry/iu }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers no retry control when no retry callback is supplied', () => {
    render(<ModificationsList modifications={[]} error="Unavailable." />);

    const alert = screen.getByRole('alert');
    expect(within(alert).queryByRole('button')).toBeNull();
  });

  it('ignores a blank error and renders the table', () => {
    render(<ModificationsList modifications={RECORDS} error="   " />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('grid')).toBeDefined();
  });

  it('drops a blank caller class from the root when the table renders', () => {
    const { container } = render(<ModificationsList modifications={RECORDS} className="  " />);

    expect(container.firstElementChild?.className).toBe('dgv-modifications');
  });
});
