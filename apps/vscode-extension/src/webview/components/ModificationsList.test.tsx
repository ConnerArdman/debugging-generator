/**
 * The contract of `components/ModificationsList` — every file the session
 * instrumented, in the editor webview (AAP 0.7.3), and the list AAP 0.8.4's
 * cleanup acceptance test reads.
 *
 * Pinned here:
 *
 *   - **One row per record, in the given order**, each named by its file and
 *     carrying its status badge's text label — colour is never alone. The
 *     badge's tone is the design system's shared `MODIFICATION_STATUS_TONE`,
 *     the table the DevTools `SessionSummary` draws from as well.
 *   - **"View diff" is a disclosure** that routes the record's own `diff` into
 *     `DiffView` inside the grid's detail row, wires `aria-expanded` and
 *     `aria-controls`, collapses on a second activation, and moves to another
 *     row when that row's diff is opened. On a conflict row the same control
 *     reads "Open diff", AAP 0.5.5's recovery action. The grid's keyboard
 *     toggle drives the same state.
 *   - **The grid stays one Tab stop**: every control in a cell or in an open
 *     detail row, the diff's labelled `<pre>` region included, is
 *     `tabIndex={-1}`, and the grid's arrow keys walk from the row onto that
 *     region.
 *   - **The open-file payload is untouched**, and the control exists only when
 *     a callback is supplied.
 *   - **A conflict is never reported as a revert**: its row states AAP 0.5.5's
 *     message exactly — "‹file› was edited while instrumented. Debug Generator
 *     will not overwrite it. Original saved at ‹backup path›." — with both
 *     values from the record, and no detail row repeats the backup path.
 *   - **The grid is the design system's**: `DataTable` owns `role="grid"` and
 *     the component adds no competing table role of its own.
 *   - **The three states** and their precedence: error > pending > empty > table.
 *     The empty state is a neutral outcome — a runtime-only plan modifies no
 *     file — so it is never presented as an alert.
 *   - **Missing records are stated**: a `total` above the rows given renders
 *     "Showing ‹N› of ‹M› recorded file modifications" as a polite status above
 *     the grid — or in place of the empty state, which never claims that no file
 *     was modified while records are missing — with a "Load all modifications"
 *     control outside the grid, disabled while its load is in flight. Error and
 *     loading still outrank it.
 *   - **Nothing reaches the console** in any state, with a diff open included:
 *     diffs carry source code, and the hashes and backup path are local
 *     file-system details (AAP 0.5.2).
 *
 * `DataTable` is rendered for real, never mocked: under happy-dom the
 * virtualizer measures zero-sized rects and reports no items, and the
 * primitive's measurement-unavailable fallback then renders every row, which
 * is what makes the row and ARIA assertions below meaningful.
 *
 * The fixture paths, hashes and diffs are generic vocabulary written for this
 * suite; no inspected project's names appear in it (AAP 0.5.4).
 */

import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MODIFICATION_STATUS_TONE } from '@debuggen/panel-renderer';
import type { BadgeTone } from '@debuggen/panel-renderer';
import { createEnvelope, MODIFICATION_STATUSES, parseMessage } from '@debuggen/protocol';
import type { ModificationRecord, ModificationStatus } from '@debuggen/protocol';

import { ModificationsList } from './ModificationsList';

// `@testing-library/react` registers its automatic cleanup only on a global
// `afterEach`; registering it explicitly keeps this suite correct whether or not
// the Vitest project exposes globals. Spies are restored in the same hook so a
// failing assertion can never leak a patched `console` into the next case.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * A small, well-formed unified diff for one file: one removed and one added
 * line inside a hunk whose counts are exact (three lines on each side), so
 * `DiffView` classifies both content lines rather than treating the hunk as
 * over.
 */
function diffFor(file: string, removed: string, added: string): string {
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1,3 +1,3 @@',
    ' export function run() {',
    `-  ${removed}`,
    `+  ${added}`,
    ' }',
    '',
  ].join('\n');
}

/** A SHA-256-shaped digest built from one repeated hexadecimal digit. */
function digest(digit: string): string {
  return digit.repeat(64);
}

/** The file a record names when an override does not name one. */
const DEFAULT_FILE = 'src/lib/sample/module.ts';

/**
 * Builds one record against the real protocol type; every default is a value
 * the schema accepts. The default diff is derived from the record's (possibly
 * overridden) file, so a record's diff headers always name its own path.
 */
function makeRecord(overrides?: Partial<ModificationRecord>): ModificationRecord {
  const file = overrides?.file ?? DEFAULT_FILE;

  return {
    id: 'mod_0000000000000000',
    sessionId: 'ses_fixture',
    planVersion: 1,
    file,
    originalHash: digest('a'),
    backupPath: `/home/dev/.debuggen/backups/ses_fixture/${digest('a')}`,
    instrumentedHash: digest('b'),
    appliedAt: Date.UTC(2026, 0, 15, 9, 30, 0),
    status: 'applied',
    diff: diffFor(file, 'return 0;', 'return 1;'),
    ...overrides,
  };
}

/**
 * A record numbered `n`: a distinct id and a diff whose two content lines are
 * unique to it, so a diff routed into the wrong row is detectable.
 */
function numberedRecord(
  n: number,
  file: string,
  status: ModificationStatus,
  extra?: Partial<ModificationRecord>,
): ModificationRecord {
  const marker = `marker${String(n)}`;

  return makeRecord({
    id: `mod_${String(n).padStart(16, '0')}`,
    file,
    status,
    diff: diffFor(file, `const ${marker} = false;`, `const ${marker} = true;`),
    ...extra,
  });
}

/**
 * One record per status, deliberately NOT in alphabetical order of file or
 * status, so an accidental sort would be visible.
 */
const RECORDS: readonly ModificationRecord[] = [
  numberedRecord(1, 'src/server/zeta/handler.ts', 'applied'),
  numberedRecord(2, 'src/features/alpha/Widget.tsx', 'conflict'),
  numberedRecord(3, 'src/lib/mid/loader.ts', 'reverted', {
    planVersion: 2,
    previousRecordId: 'mod_0000000000000001',
    originalHash: digest('b'),
    instrumentedHash: digest('c'),
  }),
  numberedRecord(4, 'src/lib/beta/queue.ts', 'pending'),
  numberedRecord(5, 'src/server/eta/jobs.ts', 'failed'),
];

/**
 * The record at `index` of {@link RECORDS}, failing the test when it is absent
 * (`noUncheckedIndexedAccess` types every index read as possibly undefined).
 */
function fixture(index: number): ModificationRecord {
  const entry = RECORDS[index];
  if (entry === undefined) {
    throw new Error(`expected a fixture record at index ${String(index)}`);
  }
  return entry;
}

/**
 * The expected presentation of every status: its badge label and tone class.
 * A `Record` over the union, so a status added to the protocol is a compile
 * error here until the suite states what it must look like.
 */
const STATUS_PRESENTATION: Readonly<
  Record<ModificationStatus, { readonly label: string; readonly toneClass: string }>
> = {
  pending: { label: 'Pending', toneClass: 'dg-badge--neutral' },
  applied: { label: 'Applied', toneClass: 'dg-badge--info' },
  reverted: { label: 'Reverted', toneClass: 'dg-badge--success' },
  conflict: { label: 'Conflict', toneClass: 'dg-badge--warning' },
  failed: { label: 'Failed', toneClass: 'dg-badge--danger' },
};

/**
 * The shared status→tone table, adopted the way the component adopts it:
 * typed against the protocol's union, so a status the design system's table
 * does not cover fails to compile here too.
 */
const SHARED_TONE: Readonly<Record<ModificationStatus, BadgeTone>> = MODIFICATION_STATUS_TONE;

/** The five console methods the privacy cases watch. */
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/** The diff lines of one kind inside `root`, as their text. */
function diffLineTexts(root: ParentNode, kind: 'added' | 'removed'): string[] {
  return Array.from(root.querySelectorAll(`.dgv-diff__line--${kind}`)).map(
    (line) => line.textContent ?? '',
  );
}

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

describe('ModificationsList fixtures', () => {
  it('are records the protocol itself accepts on an instrumentation.ready frame', () => {
    // A fixture the service could never send would make every case below test
    // a shape that does not occur, so the records go through the real schema.
    const parsed = parseMessage(
      createEnvelope('instrumentation.ready', {
        sessionId: 'ses_fixture',
        applied: [...RECORDS, makeRecord()],
        runtimeHooks: [],
        unavailable: [],
      }),
    );

    expect(parsed.ok).toBe(true);
  });
});

describe('ModificationsList table', () => {
  it('renders the design system grid and adds no competing table role', () => {
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    const grids = screen.queryAllByRole('grid');
    expect(grids).toHaveLength(1);
    expect(grids[0]?.closest('.dg-data-table')).not.toBeNull();
    expect(container.querySelector('[role="table"]')).toBeNull();
    expect(container.querySelector('table')).toBeNull();
  });

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
    const bare = numberedRecord(8, 'README.md', 'applied');
    const { container } = render(<ModificationsList modifications={[fixture(1), bare]} />);

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

    RECORDS.forEach((entry, index) => {
      const { label, toneClass } = STATUS_PRESENTATION[entry.status];
      const badge = rowAt(container, index).querySelector('.dg-badge');
      expect(badge?.textContent).toBe(label);
      expect(badge?.classList.contains(toneClass)).toBe(true);
    });
  });

  it.each(MODIFICATION_STATUSES.map((status) => [status]))(
    'renders a %s record with its own non-empty text label',
    (status) => {
      const { container } = render(
        <ModificationsList modifications={[numberedRecord(6, 'src/lib/solo/entry.ts', status)]} />,
      );

      const badges = rowAt(container, 0).querySelectorAll('.dg-badge');
      expect(badges).toHaveLength(1);
      const text = badges[0]?.textContent ?? '';
      expect(text.trim()).not.toBe('');
      expect(text).toBe(STATUS_PRESENTATION[status].label);
    },
  );

  it.each(MODIFICATION_STATUSES.map((status) => [status]))(
    'draws a %s badge in the design system’s shared status tone',
    (status) => {
      const { container } = render(
        <ModificationsList modifications={[numberedRecord(6, 'src/lib/solo/entry.ts', status)]} />,
      );

      // The DevTools panel's `SessionSummary` reads the same table, so the
      // tone asserted here is the one both surfaces draw.
      const badge = rowAt(container, 0).querySelector('.dg-badge');
      const expected = `dg-badge--${SHARED_TONE[status]}`;
      expect(expected).toBe(STATUS_PRESENTATION[status].toneClass);
      expect(badge?.classList.contains(expected)).toBe(true);
      const toneClasses = Array.from(badge?.classList ?? []).filter((name) =>
        /^dg-badge--(?:neutral|accent|success|warning|danger|info)$/u.test(name),
      );
      expect(toneClasses).toEqual([expected]);
    },
  );

  it('gives the five statuses five distinct tones, a conflict a warning rather than a danger', () => {
    const tones = MODIFICATION_STATUSES.map((status) => SHARED_TONE[status]);
    expect(new Set(tones).size).toBe(MODIFICATION_STATUSES.length);
    expect(SHARED_TONE.conflict).toBe('warning');
    expect(SHARED_TONE.failed).toBe('danger');
    expect(Object.isFrozen(MODIFICATION_STATUS_TONE)).toBe(true);
  });

  it('gives the five statuses five distinct, non-blank labels', () => {
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    // The fixture must cover the whole vocabulary for this case to mean anything.
    expect(new Set(RECORDS.map((entry) => entry.status))).toEqual(new Set(MODIFICATION_STATUSES));

    const labels = dataRows(container).map(
      (row) => row.querySelector('.dg-badge')?.textContent?.trim() ?? '',
    );
    expect(labels).toHaveLength(MODIFICATION_STATUSES.length);
    expect(labels.every((label) => label !== '')).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('never labels a conflict the way it labels a revert', () => {
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    const conflictBadge = rowAt(container, 1).querySelector('.dg-badge')?.textContent ?? '';
    const revertedBadge = rowAt(container, 2).querySelector('.dg-badge')?.textContent ?? '';
    expect(fixture(1).status).toBe('conflict');
    expect(fixture(2).status).toBe('reverted');
    expect(conflictBadge).not.toBe('');
    expect(conflictBadge).not.toBe(revertedBadge);
    expect(conflictBadge).not.toMatch(/revert/iu);
  });

  it('states the conflict message in the row itself, with the record’s file and backup path', () => {
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    // No row is expanded: the message is the row's own text, not its detail.
    expect(detailRows(container)).toHaveLength(0);
    const conflictRow = rowAt(container, 1);
    const note = conflictRow.querySelector('.dgv-modifications__note');
    expect(note?.textContent).toBe(
      `${fixture(1).file} was edited while instrumented. Debug Generator will not overwrite it. ` +
        `Original saved at ${fixture(1).backupPath}.`,
    );

    // Both values render through the byte-faithful `Code` primitive, wrapping.
    const values = Array.from(note?.querySelectorAll('code') ?? []);
    expect(values.map((code) => code.textContent)).toEqual([
      fixture(1).file,
      fixture(1).backupPath,
    ]);
    for (const code of values) {
      expect(code.classList.contains('dg-code--wrap')).toBe(true);
    }

    expect(conflictRow.textContent ?? '').not.toMatch(/revert/iu);

    // Applied and reverted rows carry no note: their labels say everything.
    expect(rowAt(container, 0).querySelector('.dgv-modifications__note')).toBeNull();
    expect(rowAt(container, 2).querySelector('.dgv-modifications__note')).toBeNull();
    expect(rowAt(container, 3).querySelector('.dgv-modifications__note')).not.toBeNull();
    expect(rowAt(container, 4).querySelector('.dgv-modifications__note')).not.toBeNull();
  });

  it('omits only the saved-at sentence for a conflict whose backup path is blank', () => {
    const file = 'src/lib/nobackup/entry.ts';
    const orphan = numberedRecord(13, file, 'conflict', { backupPath: '  ' });
    const { container } = render(<ModificationsList modifications={[orphan]} />);

    const note = rowAt(container, 0).querySelector('.dgv-modifications__note');
    expect(note?.textContent).toBe(
      `${file} was edited while instrumented. Debug Generator will not overwrite it.`,
    );
    // Nothing stands in for the missing value: no constructed path, no label.
    expect(container.textContent ?? '').not.toContain('Original saved at');
    expect(container.textContent ?? '').not.toContain('.debuggen/backups');
  });

  it('labels a conflict row’s disclosure "Open diff" and every other row’s "View diff"', () => {
    render(<ModificationsList modifications={RECORDS} />);

    RECORDS.forEach((entry) => {
      const label = entry.status === 'conflict' ? 'Open diff' : 'View diff';
      const toggle = screen.getByRole('button', { name: `${label} of ${entry.file}` });
      expect(toggle.textContent).toBe(label);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });
    expect(screen.getAllByRole('button', { name: /^Open diff of /u })).toHaveLength(1);
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
    const odd = numberedRecord(9, 'src/lib/odd.ts', 'applied', { appliedAt: Number.MAX_VALUE });
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
    expect(scroll?.tagName).toBe('PRE');
    expect(scroll?.getAttribute('tabindex')).toBe('-1');
  });

  it('reaches the diff’s labelled region from the row with the grid’s own arrow keys', async () => {
    const user = userEvent.setup();
    const file = 'src/server/zeta/handler.ts';
    const { container } = render(
      <ModificationsList modifications={RECORDS} onOpenFile={vi.fn()} />,
    );

    // The grid is the one Tab stop; the region's `tabIndex={-1}` is what the
    // table's caller contract asks for, and this is the path its keys take.
    focusRow(rowAt(container, 0));

    // ArrowRight on a collapsed row expands it.
    await user.keyboard('{ArrowRight}');
    expect(detailRows(container)).toHaveLength(1);

    // ArrowRight on the expanded row moves into it: its first control.
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: `Hide diff of ${file}` }),
    );

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: `Open file ${file}` }));

    // The next control in document order is the diff's region in the detail row.
    await user.keyboard('{ArrowRight}');
    const region = screen.getByRole('region', { name: `Diff of ${file}` });
    expect(document.activeElement).toBe(region);
    expect(region.tagName).toBe('PRE');
    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('tabindex')).toBe('-1');
    expect(detailRows(container)[0]?.contains(region)).toBe(true);
  });

  it('reaches a long diff’s window control before its region, and pages it by keyboard, all tabIndex -1', async () => {
    const user = userEvent.setup();
    const file = 'src/lib/long/generated.ts';
    const lines = Array.from({ length: 1200 }, (_, index) => `+const line${String(index)} = 0;`);
    const long = numberedRecord(14, file, 'applied', { diff: `${lines.join('\n')}\n` });
    const { container } = render(<ModificationsList modifications={[long]} onOpenFile={vi.fn()} />);

    focusRow(rowAt(container, 0));
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: `Open file ${file}` }));

    // The control precedes the horizontally scrolling region, so the grid's
    // ArrowRight reaches it before the region keeps the inline-axis keys.
    await user.keyboard('{ArrowRight}');
    const next = screen.getByRole('button', { name: 'Show next 200 lines' });
    expect(document.activeElement).toBe(next);
    expect(next.getAttribute('tabindex')).toBe('-1');

    await user.keyboard('{ArrowRight}');
    const region = screen.getByRole('region', { name: `Diff of ${file}` });
    expect(document.activeElement).toBe(region);
    expect(container.querySelectorAll('.dgv-diff__line')).toHaveLength(1000);

    // Enter on the control moves the window to the last 200 lines; the control
    // has reached its end, so it unmounts and focus lands on the region rather
    // than on the document body.
    next.focus();
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(region);
    expect(container.querySelectorAll('.dgv-diff__line')).toHaveLength(200);
    expect(screen.queryByRole('button', { name: /^Show next /u })).toBeNull();
    expect(screen.getByRole('button', { name: /^Show previous /u })).toBeDefined();

    // Every focusable element in the grid, the window controls included, is -1.
    const grid = screen.getByRole('grid');
    for (const element of Array.from(
      grid.querySelectorAll<HTMLElement>('button, [tabindex]:not(.dg-data-table__row)'),
    )) {
      expect(element.getAttribute('tabindex')).toBe('-1');
    }
  });
});

describe('ModificationsList "View diff"', () => {
  it('routes the record’s own diff into DiffView and collapses on a second activation', async () => {
    const user = userEvent.setup();
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    // The conflict row: its disclosure is the message's "Open diff" action.
    const toggle = screen.getByRole('button', {
      name: 'Open diff of src/features/alpha/Widget.tsx',
    });
    expect(toggle.textContent).toBe('Open diff');
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

    const region = within(detail).getByRole('region', {
      name: 'Diff of src/features/alpha/Widget.tsx',
    });
    const lines = Array.from(region.querySelectorAll('.dgv-diff__line')).map(
      (line) => line.textContent ?? '',
    );
    expect(lines.join('\n') + '\n').toBe(fixture(1).diff);
    expect(diffLineTexts(region, 'removed')).toEqual(['-  const marker2 = false;']);
    expect(diffLineTexts(region, 'added')).toEqual(['+  const marker2 = true;']);

    await user.click(opened);

    expect(detailRows(container)).toHaveLength(0);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.hasAttribute('aria-controls')).toBe(false);
    expect(toggle.textContent).toBe('Open diff');
  });

  it('renders the expanded record’s own diff and never another record’s', async () => {
    const user = userEvent.setup();
    const first = numberedRecord(11, 'src/lib/first/source.ts', 'applied', {
      diff: diffFor('src/lib/first/source.ts', 'const firstValue = 1;', 'const firstValue = 2;'),
    });
    const second = numberedRecord(12, 'src/lib/second/source.ts', 'applied', {
      diff: diffFor('src/lib/second/source.ts', 'const secondValue = 3;', 'const secondValue = 4;'),
    });
    const { container } = render(<ModificationsList modifications={[first, second]} />);

    // The second row is opened deliberately: a list that routes the first
    // record's diff into every detail row fails here.
    await user.click(screen.getByRole('button', { name: 'View diff of src/lib/second/source.ts' }));

    let detail = detailRows(container)[0];
    expect(detail).toBeDefined();
    expect(diffLineTexts(detail ?? container, 'removed')).toEqual(['-  const secondValue = 3;']);
    expect(diffLineTexts(detail ?? container, 'added')).toEqual(['+  const secondValue = 4;']);
    expect(container.textContent ?? '').not.toContain('firstValue');

    await user.click(screen.getByRole('button', { name: 'View diff of src/lib/first/source.ts' }));

    detail = detailRows(container)[0];
    expect(detailRows(container)).toHaveLength(1);
    expect(diffLineTexts(detail ?? container, 'removed')).toEqual(['-  const firstValue = 1;']);
    expect(diffLineTexts(detail ?? container, 'added')).toEqual(['+  const firstValue = 2;']);
    expect(container.textContent ?? '').not.toContain('secondValue');
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
      within(details[0] ?? container).getByRole('region', {
        name: 'Diff of src/lib/mid/loader.ts',
      }),
    ).toBeDefined();
    expect(
      screen
        .getByRole('button', { name: 'View diff of src/server/zeta/handler.ts' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('shows the hashes, and never repeats the backup path in a detail row', async () => {
    const user = userEvent.setup();
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    await user.click(
      screen.getByRole('button', { name: 'Open diff of src/features/alpha/Widget.tsx' }),
    );
    let detail = detailRows(container)[0];
    // The conflict row already states where the original is saved; its detail
    // holds the hashes and the diff only.
    expect(detail?.textContent ?? '').not.toContain('Original preserved at');
    expect(detail?.textContent ?? '').not.toContain('Original saved at');
    expect(detail?.textContent ?? '').not.toContain('.debuggen/backups');
    expect(rowAt(container, 1).textContent ?? '').toContain(
      `Original saved at ${fixture(1).backupPath}.`,
    );

    const hashes = detail?.querySelector('.dgv-modifications__hashes');
    expect(hashes?.textContent ?? '').toContain(`Original SHA-256 ${digest('a').slice(0, 12)}`);
    expect(hashes?.textContent ?? '').toContain(`Instrumented SHA-256 ${digest('b').slice(0, 12)}`);
    const fullHash = Array.from(hashes?.querySelectorAll('code') ?? []).map((code) =>
      code.getAttribute('title'),
    );
    expect(fullHash).toEqual([digest('a'), digest('b')]);

    await user.click(screen.getByRole('button', { name: 'View diff of src/lib/mid/loader.ts' }));
    detail = detailRows(container)[0];
    expect(detail?.textContent ?? '').not.toContain('Original preserved at');
    expect(detail?.textContent ?? '').not.toContain('.debuggen/backups');
    // Only a conflict row names a backup at all.
    expect(rowAt(container, 2).textContent ?? '').not.toContain('.debuggen/backups');
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
    const blank = numberedRecord(7, 'src/lib/blank.ts', 'applied', { diff: '' });
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

  it('passes a path with spaces and dotted segments through byte for byte', async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn<(file: string) => void>();
    const file = '.config/some dir/entry.test-helper.ts';
    render(
      <ModificationsList
        modifications={[numberedRecord(10, file, 'reverted')]}
        onOpenFile={onOpenFile}
      />,
    );

    await user.click(screen.getByRole('button', { name: `Open file ${file}` }));

    expect(onOpenFile.mock.calls).toEqual([[file]]);
  });

  it('renders no open control when no callback is supplied', () => {
    render(<ModificationsList modifications={RECORDS} />);

    expect(screen.queryByRole('button', { name: /^Open file/u })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^(?:View|Open) diff of /u })).toHaveLength(
      RECORDS.length,
    );
  });
});

describe('ModificationsList states', () => {
  it('renders the neutral empty state, and no grid, when nothing was modified', () => {
    const { container } = render(<ModificationsList modifications={[]} className="extra" />);

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('No files were modified for this session.');
    // A runtime-only plan modifies nothing, which is the good outcome: the
    // empty state is neither an alert nor a load in progress.
    expect(status.getAttribute('aria-busy')).not.toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('grid')).toBeNull();
    expect(container.querySelector('.dg-badge')).toBeNull();
    expect(container.firstElementChild?.className).toBe('dgv-modifications extra');
  });

  it('renders the loading state while pending, even when records are present', () => {
    const { container } = render(<ModificationsList modifications={RECORDS} pending />);

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('grid')).toBeNull();
    expect(dataRows(container)).toHaveLength(0);
    expect(container.textContent ?? '').not.toContain('src/server/zeta/handler.ts');
    expect(container.firstElementChild?.classList.contains('dgv-modifications')).toBe(true);
  });

  it('renders only the alert when error, pending and an empty list coincide', () => {
    const { container } = render(
      <ModificationsList modifications={[]} pending error="The service did not answer." />,
    );

    const alerts = screen.queryAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent ?? '').toContain('The service did not answer.');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('grid')).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.textContent ?? '').not.toContain('No files were modified for this session.');
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

describe('ModificationsList missing records', () => {
  /** The warning line for `shown` of `total` records. */
  function shortfallLine(shown: number, total: number): HTMLElement {
    const noun = total === 1 ? 'file modification' : 'file modifications';
    return screen.getByText(
      `Showing ${String(shown)} of ${String(total)} recorded ${noun}; the rest have not been loaded.`,
    );
  }

  it('states how many of the journal’s records are shown, above the full grid, as a polite status', () => {
    const { container } = render(
      <ModificationsList modifications={RECORDS} total={RECORDS.length + 2} />,
    );

    const line = shortfallLine(RECORDS.length, RECORDS.length + 2);
    expect(line.getAttribute('role')).toBe('status');
    expect(line.closest('[role="grid"]')).toBeNull();
    expect(dataRows(container)).toHaveLength(RECORDS.length);
    const grid = screen.getByRole('grid');
    expect(line.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Without a load callback there is nothing to press.
    expect(screen.queryByRole('button', { name: 'Load all modifications' })).toBeNull();
  });

  it('offers "Load all modifications" as an ordinary Tab stop that asks for the rest', async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn<() => void>();
    render(
      <ModificationsList
        modifications={RECORDS}
        total={RECORDS.length + 1}
        onLoadMore={onLoadMore}
      />,
    );

    const load = screen.getByRole('button', { name: 'Load all modifications' });
    expect(load.closest('[role="grid"]')).toBeNull();
    expect(load.getAttribute('tabindex')).not.toBe('-1');
    expect((load as HTMLButtonElement).disabled).toBe(false);

    await user.click(load);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('disables the load control while that load is in flight', async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn<() => void>();
    render(
      <ModificationsList
        modifications={RECORDS}
        total={RECORDS.length + 1}
        onLoadMore={onLoadMore}
        loadingMore
      />,
    );

    const load = screen.getByRole('button', { name: 'Load all modifications' });
    expect((load as HTMLButtonElement).disabled).toBe(true);
    expect(load.getAttribute('aria-busy')).toBe('true');

    await user.click(load);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('never claims that no file was modified while the journal holds records the list lacks', async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn<() => void>();
    const { container } = render(
      <ModificationsList modifications={[]} total={1} onLoadMore={onLoadMore} />,
    );

    expect(shortfallLine(0, 1).getAttribute('role')).toBe('status');
    expect(container.textContent ?? '').not.toContain('No files were modified for this session.');
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Load all modifications' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('shows no warning once the list holds every counted record, or more', () => {
    const { rerender, container } = render(
      <ModificationsList modifications={RECORDS} total={RECORDS.length} onLoadMore={vi.fn()} />,
    );
    expect(container.textContent ?? '').not.toContain('Showing');
    expect(screen.queryByRole('button', { name: 'Load all modifications' })).toBeNull();

    rerender(
      <ModificationsList modifications={RECORDS} total={RECORDS.length - 1} onLoadMore={vi.fn()} />,
    );
    expect(container.textContent ?? '').not.toContain('Showing');

    rerender(<ModificationsList modifications={[]} total={0} onLoadMore={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toContain(
      'No files were modified for this session.',
    );
  });

  it('keeps error and loading above the warning', () => {
    const { rerender, container } = render(
      <ModificationsList modifications={[]} total={3} error="The service did not answer." />,
    );
    expect(screen.getByRole('alert').textContent).toContain('The service did not answer.');
    expect(container.textContent ?? '').not.toContain('Showing');

    rerender(<ModificationsList modifications={[]} total={3} pending />);
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    expect(container.textContent ?? '').not.toContain('Showing');
  });
});

describe('ModificationsList privacy', () => {
  /** One silenced console method and the calls it recorded. */
  interface ConsoleSpy {
    readonly method: (typeof CONSOLE_METHODS)[number];
    readonly calls: () => number;
  }

  let spies: ConsoleSpy[] = [];

  // Installed per test and removed by the file-wide `vi.restoreAllMocks()`.
  beforeEach(() => {
    spies = CONSOLE_METHODS.map((method) => {
      const spy = vi.spyOn(console, method).mockImplementation(() => undefined);
      return { method, calls: () => spy.mock.calls.length };
    });
  });

  /** Asserts that no console method was called, naming the one that was. */
  function expectConsoleSilent(): void {
    expect(spies).toHaveLength(CONSOLE_METHODS.length);
    for (const { method, calls } of spies) {
      expect({ method, calls: calls() }).toEqual({ method, calls: 0 });
    }
  }

  it('writes nothing to the console while rendering rows and opening a conflict’s diff', async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn<(file: string) => void>();
    const { container } = render(
      <ModificationsList modifications={RECORDS} onOpenFile={onOpenFile} />,
    );

    // The open conflict row carries all three sensitive values at once: the
    // local backup path in its message, and the source diff and both hashes in
    // its detail.
    await user.click(
      screen.getByRole('button', { name: 'Open diff of src/features/alpha/Widget.tsx' }),
    );
    expect(rowAt(container, 1).textContent ?? '').toContain(fixture(1).backupPath);
    expect(detailRows(container)[0]?.querySelector('.dgv-modifications__hashes')).not.toBeNull();
    expect(diffLineTexts(container, 'added')).toEqual(['+  const marker2 = true;']);

    await user.click(
      screen.getByRole('button', { name: 'Open file src/features/alpha/Widget.tsx' }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Hide diff of src/features/alpha/Widget.tsx' }),
    );

    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expectConsoleSilent();
  });

  it('writes nothing to the console in the loading state', () => {
    render(<ModificationsList modifications={RECORDS} pending />);

    expect(screen.queryByRole('status')).not.toBeNull();
    expectConsoleSilent();
  });

  it('writes nothing to the console in the empty state', () => {
    render(<ModificationsList modifications={[]} />);

    expect(screen.queryByRole('status')).not.toBeNull();
    expectConsoleSilent();
  });

  it('writes nothing to the console in the error state, retry included', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn<() => void>();
    render(<ModificationsList modifications={RECORDS} error="Unavailable." onRetry={onRetry} />);

    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: /retry/iu }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expectConsoleSilent();
  });
});
