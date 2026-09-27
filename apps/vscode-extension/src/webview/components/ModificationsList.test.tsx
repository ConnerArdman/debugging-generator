/**
 * The contract of `components/ModificationsList` — every file the session
 * instrumented, in the editor webview (AAP 0.7.3), and the list AAP 0.8.4's
 * cleanup acceptance test reads.
 *
 * Pinned here:
 *
 *   - **One item per record, in the given order**, in an ordered list named
 *     "Modified files", each named by its file and carrying its status badge's
 *     text label — colour is never alone. The badge's tone is the design
 *     system's shared `MODIFICATION_STATUS_TONE`, the table the DevTools
 *     `SessionSummary` draws from as well.
 *   - **Same-named files stay apart when shortened**: each path chip splits
 *     into the `.dgv-path` lead, context and file name around the shortest
 *     tail no other file of the list ends in, recomputed when the list
 *     changes; the chip is byte-faithful, `aria-hidden` and tooltipped with
 *     the whole path, and a visually hidden copy of the whole path stands in
 *     for it in the accessibility tree.
 *   - **No grid, no nested scroller**: the list is page content, each open
 *     diff sits inside its own item directly under the controls, and nothing
 *     of the design system's capped `DataTable` viewport is rendered — so a
 *     narrow sidebar never pushes a control off-screen and no record hides
 *     behind an inner scroll area.
 *   - **"View diff" is a disclosure** that routes the record's own `diff`
 *     into `DiffView`, labelled as the change Debug Generator made, wires
 *     `aria-expanded` and `aria-controls`, collapses on a second activation,
 *     and moves to another item when that item's diff is opened.
 *   - **A conflict's "Open diff" shows the developer's edit** — the conflict
 *     entry's `instrumentedToCurrent`, else `originalToCurrent` — never the
 *     tool's own change, and is absent when the entry carries neither.
 *   - **Every control is an ordinary Tab stop**, the diff's labelled `<pre>`
 *     region included, so it can be scrolled from the keyboard; Tab from the
 *     control before the list walks every item's "View diff" and "Open file"
 *     in item order and leaves after the last, and Shift+Tab walks back.
 *   - **The open-file payload is untouched**, and the control exists only when
 *     a callback is supplied.
 *   - **A conflict is never reported as a revert**: its callout states AAP
 *     0.5.5's message exactly — "‹file› was edited while instrumented. Debug
 *     Generator will not overwrite it. Original saved at ‹backup path›." — with
 *     both values from the record, or the service's own message for any other
 *     reason, and no detail repeats the backup path.
 *   - **A failed record says why**, beside its saved original.
 *   - **"Copy path" copies the backup path exactly**, says so, and when the
 *     clipboard refuses selects the path for the platform's copy shortcut.
 *   - **The three states** and their precedence: error > pending > empty > list.
 *   - **Missing records are stated** as a polite status above the list, or in
 *     place of the empty state, with a "Load all modifications" control.
 *   - **Nothing reaches the console** in any state (AAP 0.5.2).
 *
 * The fixture paths, hashes and diffs are generic vocabulary written for this
 * suite; no inspected project's names appear in it (AAP 0.5.4).
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Button, MODIFICATION_STATUS_TONE } from '@debuggen/panel-renderer';
import type { BadgeTone } from '@debuggen/panel-renderer';
import { createEnvelope, MODIFICATION_STATUSES, parseMessage } from '@debuggen/protocol';
import type {
  ModificationConflict,
  ModificationRecord,
  ModificationStatus,
} from '@debuggen/protocol';

import { ModificationsList } from './ModificationsList';

// `@testing-library/react` registers its automatic cleanup only on a global
// `afterEach`; registering it explicitly keeps this suite correct whether or not
// the Vitest project exposes globals. Spies are restored in the same hook so a
// failing assertion can never leak a patched `console` into the next case.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(window.navigator, 'clipboard');
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
 * unique to it, so a diff routed into the wrong item is detectable.
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

/** The developer's edit on top of the conflict fixture's instrumentation. */
const EDIT_DIFF = diffFor(
  'src/features/alpha/Widget.tsx',
  'const marker2 = true;',
  'const editedByHand = 3;',
);

/** The conflict fixture's whole divergence from its saved original. */
const CURRENT_DIFF = diffFor(
  'src/features/alpha/Widget.tsx',
  'const marker2 = false;',
  'const editedByHand = 3;',
);

/**
 * The service's conflict entry for the conflict fixture, as `cleanup.conflicts`
 * carries it; every default is a value the schema accepts.
 */
function makeConflict(overrides?: Partial<ModificationConflict>): ModificationConflict {
  const record = fixture(1);

  return {
    recordId: record.id,
    sessionId: record.sessionId,
    file: record.file,
    reason: 'content-changed',
    expectedHash: record.instrumentedHash,
    actualHash: digest('d'),
    backupPath: record.backupPath,
    detectedAt: Date.UTC(2026, 0, 15, 9, 45, 0),
    message: `'${record.file}' was changed after it was instrumented, so nothing was written to it.`,
    diffs: { instrumentedToCurrent: EDIT_DIFF, originalToCurrent: CURRENT_DIFF },
    ...overrides,
  };
}

/** A conflict entry without any diff, as the service sends one it could not diff. */
function conflictWithoutDiffs(overrides?: Partial<ModificationConflict>): ModificationConflict {
  const conflict = { ...makeConflict(overrides) };
  delete conflict.diffs;
  return conflict;
}

/**
 * Settles the clipboard write a click started: its promise, the awaiting
 * function and the `then` that records the outcome are a few microtasks deep.
 */
async function settleCopy(): Promise<void> {
  await act(async () => {
    for (let hop = 0; hop < 5; hop += 1) {
      await Promise.resolve();
    }
  });
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

/** The failed record's explanation, exactly. */
const FAILED_NOTE =
  'Writing this change stopped part-way, before it was confirmed. Cleanup restores the saved original if the change reached the file, and reports the file instead of overwriting it if it no longer matches either version.';

/** The diff lines of one kind inside `root`, as their text. */
function diffLineTexts(root: ParentNode, kind: 'added' | 'removed'): string[] {
  return Array.from(root.querySelectorAll(`.dgv-diff__line--${kind}`)).map(
    (line) => line.textContent ?? '',
  );
}

/** The list's items, one per record. */
function items(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.dgv-modifications__item'));
}

/** The item at `index`, failing the test when it is absent. */
function itemAt(container: HTMLElement, index: number): HTMLElement {
  const item = items(container)[index];
  if (item === undefined) {
    throw new Error(`expected an item at index ${String(index)}`);
  }
  return item;
}

/** The open diff details. */
function details(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.dgv-modifications__detail'));
}

/** The only open detail, failing the test when there is not exactly one. */
function onlyDetail(container: HTMLElement): HTMLElement {
  const open = details(container);
  const [detail] = open;
  if (open.length !== 1 || detail === undefined) {
    throw new Error(`expected exactly one open detail, found ${String(open.length)}`);
  }
  return detail;
}

/** Replaces the clipboard with one whose `writeText` is `writeText`. */
function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

describe('ModificationsList fixtures', () => {
  it('are records and a conflict the protocol itself accepts', () => {
    // A fixture the service could never send would make every case below test
    // a shape that does not occur, so the records go through the real schema.
    const ready = parseMessage(
      createEnvelope('instrumentation.ready', {
        sessionId: 'ses_fixture',
        applied: [...RECORDS, makeRecord()],
        runtimeHooks: [],
        unavailable: [],
      }),
    );
    expect(ready.ok).toBe(true);

    const cleaned = parseMessage(
      createEnvelope('cleanup.completed', {
        sessionId: 'ses_fixture',
        status: 'conflict',
        conflicts: [makeConflict()],
      }),
    );
    expect(cleaned.ok).toBe(true);
  });
});

describe('ModificationsList list', () => {
  it('renders one ordered list and no grid, table or capped table viewport', () => {
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    const list = screen.getByRole('list', { name: 'Modified files' });
    expect(list.tagName).toBe('OL');
    expect(screen.queryByRole('grid')).toBeNull();
    expect(container.querySelector('[role="table"]')).toBeNull();
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('.dg-data-table')).toBeNull();
    expect(container.querySelector('.dg-virtual-viewport')).toBeNull();
  });

  it('renders one item per record, in the given order, named by its file', () => {
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    const list = screen.getByRole('list', { name: 'Modified files' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(RECORDS.length);
    expect(items(container)).toHaveLength(RECORDS.length);

    const paths = items(container).map(
      (item) => item.querySelector('.dgv-path')?.textContent ?? '',
    );
    expect(paths).toEqual(RECORDS.map((entry) => entry.file));

    const firstPath = itemAt(container, 0).querySelector('.dgv-path');
    expect(firstPath?.tagName).toBe('CODE');
    expect(firstPath?.getAttribute('title')).toBe('src/server/zeta/handler.ts');
  });

  it('splits the path so the file name survives truncation, without altering its text', () => {
    const bare = numberedRecord(8, 'README.md', 'applied');
    const { container } = render(<ModificationsList modifications={[fixture(1), bare]} />);

    const nested = itemAt(container, 0).querySelector('.dgv-path');
    expect(nested?.querySelector('.dgv-path__lead')?.textContent).toBe('src/features/alpha/');
    expect(nested?.querySelector('.dgv-path__tail')?.textContent).toBe('Widget.tsx');
    expect(nested?.querySelector('.dgv-path__context')).toBeNull();
    expect(nested?.querySelector('.dgv-path__name')?.textContent).toBe('Widget.tsx');
    expect(nested?.textContent).toBe('src/features/alpha/Widget.tsx');

    const flat = itemAt(container, 1).querySelector('.dgv-path');
    expect(flat?.querySelector('.dgv-path__lead')).toBeNull();
    expect(flat?.querySelector('.dgv-path__context')).toBeNull();
    expect(flat?.querySelector('.dgv-path__name')?.textContent).toBe('README.md');
    expect(flat?.textContent).toBe('README.md');
  });

  it('gives same-named files distinct tails that keep the file name', () => {
    const namesakes = [
      numberedRecord(11, 'app/api/widgets/route.ts', 'applied'),
      numberedRecord(12, 'app/api/widgets/parts/route.ts', 'applied'),
      numberedRecord(13, 'src/views/first/ExtremelyLongNestedDirectoryName/Pane.tsx', 'applied'),
      numberedRecord(14, 'src/views/second/ExtremelyLongNestedDirectoryName/Pane.tsx', 'applied'),
      numberedRecord(15, 'src/lib/format.ts', 'applied'),
    ];
    const { container } = render(<ModificationsList modifications={namesakes} />);

    const parts = namesakes.map((_record, index) => {
      const chip = itemAt(container, index).querySelector('.dgv-path');
      const text = (part: string): string | null =>
        chip?.querySelector(`.dgv-path__${part}`)?.textContent ?? null;
      return { lead: text('lead'), context: text('context'), name: text('name') };
    });
    expect(parts).toEqual([
      { lead: 'app/api/', context: 'widgets/', name: 'route.ts' },
      { lead: 'app/api/widgets/', context: 'parts/', name: 'route.ts' },
      {
        lead: 'src/views/',
        context: 'first/ExtremelyLongNestedDirectoryName/',
        name: 'Pane.tsx',
      },
      {
        lead: 'src/views/',
        context: 'second/ExtremelyLongNestedDirectoryName/',
        name: 'Pane.tsx',
      },
      { lead: 'src/lib/', context: null, name: 'format.ts' },
    ]);

    const tails = namesakes.map(
      (_record, index) =>
        itemAt(container, index).querySelector('.dgv-path__tail')?.textContent ?? '',
    );
    expect(new Set(tails).size).toBe(namesakes.length);
    namesakes.forEach((record, index) => {
      const chip = itemAt(container, index).querySelector('.dgv-path');
      expect(chip?.textContent).toBe(record.file);
      expect(chip?.getAttribute('title')).toBe(record.file);
    });
  });

  it('names each item by a visually hidden copy of the whole path, never the split chip', () => {
    const namesakes = [
      numberedRecord(11, 'app/api/widgets/route.ts', 'applied'),
      numberedRecord(12, 'app/api/widgets/parts/route.ts', 'conflict'),
    ];
    const { container } = render(<ModificationsList modifications={namesakes} />);

    namesakes.forEach((record, index) => {
      const item = itemAt(container, index);
      const chip = item.querySelector('.dgv-path');
      expect(chip?.getAttribute('aria-hidden')).toBe('true');

      const copy = item.querySelector('.dg-visually-hidden');
      expect(copy?.textContent).toBe(record.file);
      expect(copy?.closest('[aria-hidden="true"]')).toBeNull();
    });
  });

  it('recomputes the split when the list changes', () => {
    const alone = [numberedRecord(11, 'app/api/widgets/route.ts', 'applied')];
    const { container, rerender } = render(<ModificationsList modifications={alone} />);

    expect(itemAt(container, 0).querySelector('.dgv-path__tail')?.textContent).toBe('route.ts');

    rerender(
      <ModificationsList
        modifications={[...alone, numberedRecord(12, 'app/api/widgets/parts/route.ts', 'applied')]}
      />,
    );

    expect(itemAt(container, 0).querySelector('.dgv-path__tail')?.textContent).toBe(
      'widgets/route.ts',
    );
    expect(itemAt(container, 1).querySelector('.dgv-path__tail')?.textContent).toBe(
      'parts/route.ts',
    );
  });

  it('puts the path and its badge on one wrapping head line, the actions after the note', () => {
    const { container } = render(
      <ModificationsList modifications={RECORDS} onOpenFile={vi.fn()} />,
    );

    const item = itemAt(container, 4);
    const head = item.querySelector('.dgv-modifications__head');
    expect(head?.querySelector('.dgv-path')).not.toBeNull();
    expect(head?.querySelector('.dgv-modifications__status')?.textContent).toBe('Failed');
    expect(head?.classList.contains('dg-stack--wrap')).toBe(true);

    // The note spans the item: it is not inside the head, and the actions come
    // after it, wrapping, so every control stays inside the item's width.
    const note = item.querySelector('.dgv-modifications__note');
    const actions = item.querySelector('.dgv-modifications__actions');
    expect(note).not.toBeNull();
    expect(head?.contains(note ?? null)).toBe(false);
    expect(actions?.classList.contains('dg-stack--wrap')).toBe(true);
    expect(
      (note?.compareDocumentPosition(actions ?? item) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('labels every status with text on a toned badge', () => {
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    RECORDS.forEach((entry, index) => {
      const { label, toneClass } = STATUS_PRESENTATION[entry.status];
      const badge = itemAt(container, index).querySelector('.dg-badge');
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

      const badges = itemAt(container, 0).querySelectorAll('.dg-badge');
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
      const badge = itemAt(container, 0).querySelector('.dg-badge');
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

    const labels = items(container).map(
      (item) => item.querySelector('.dg-badge')?.textContent?.trim() ?? '',
    );
    expect(labels).toHaveLength(MODIFICATION_STATUSES.length);
    expect(labels.every((label) => label !== '')).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('never labels a conflict the way it labels a revert', () => {
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    const conflictBadge = itemAt(container, 1).querySelector('.dg-badge')?.textContent ?? '';
    const revertedBadge = itemAt(container, 2).querySelector('.dg-badge')?.textContent ?? '';
    expect(fixture(1).status).toBe('conflict');
    expect(fixture(2).status).toBe('reverted');
    expect(conflictBadge).not.toBe('');
    expect(conflictBadge).not.toBe(revertedBadge);
    expect(conflictBadge).not.toMatch(/revert/iu);
  });

  it('states the conflict message at the item’s full width, with the record’s file and backup path', () => {
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    // No diff is open: the message is the item's own text, not its detail.
    expect(details(container)).toHaveLength(0);
    const conflictItem = itemAt(container, 1);
    const callout = conflictItem.querySelector('.dgv-modifications__note');
    expect(callout?.classList.contains('dgv-modifications__callout--warning')).toBe(true);
    const message = callout?.querySelector('.dgv-modifications__message');
    expect(message?.tagName).toBe('P');
    expect(message?.textContent).toBe(
      `${fixture(1).file} was edited while instrumented. Debug Generator will not overwrite it. ` +
        `Original saved at ${fixture(1).backupPath}.`,
    );

    // Both values render through the byte-faithful `Code` primitive, wrapping.
    const values = Array.from(message?.querySelectorAll('code') ?? []);
    expect(values.map((code) => code.textContent)).toEqual([
      fixture(1).file,
      fixture(1).backupPath,
    ]);
    for (const code of values) {
      expect(code.classList.contains('dg-code--wrap')).toBe(true);
    }

    // The backup path can be copied from the callout itself.
    expect(
      within(conflictItem).getByRole('button', {
        name: `Copy path of the saved original of ${fixture(1).file}`,
      }).textContent,
    ).toBe('Copy path');

    expect(conflictItem.textContent ?? '').not.toMatch(/revert/iu);

    // Applied and reverted items carry no note: their labels say everything.
    expect(itemAt(container, 0).querySelector('.dgv-modifications__note')).toBeNull();
    expect(itemAt(container, 2).querySelector('.dgv-modifications__note')).toBeNull();
    expect(itemAt(container, 3).querySelector('.dgv-modifications__note')).not.toBeNull();
    expect(itemAt(container, 4).querySelector('.dgv-modifications__note')).not.toBeNull();
  });

  it('omits only the saved-at sentence and its copy control for a conflict whose backup path is blank', () => {
    const file = 'src/lib/nobackup/entry.ts';
    const orphan = numberedRecord(13, file, 'conflict', { backupPath: '  ' });
    const { container } = render(<ModificationsList modifications={[orphan]} />);

    const message = itemAt(container, 0).querySelector('.dgv-modifications__message');
    expect(message?.textContent).toBe(
      `${file} was edited while instrumented. Debug Generator will not overwrite it.`,
    );
    // Nothing stands in for the missing value: no constructed path, no label.
    expect(container.textContent ?? '').not.toContain('Original saved at');
    expect(container.textContent ?? '').not.toContain('.debuggen/backups');
    expect(screen.queryByRole('button', { name: /^Copy path/u })).toBeNull();
  });

  it('gives a failed record its reason and its saved original, with a copy control', () => {
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    const failedItem = itemAt(container, 4);
    const callout = failedItem.querySelector('.dgv-modifications__note');
    expect(callout?.classList.contains('dgv-modifications__callout--danger')).toBe(true);
    expect(callout?.querySelector('.dgv-modifications__message')?.textContent).toBe(FAILED_NOTE);
    expect(callout?.textContent ?? '').toContain(`Original saved at ${fixture(4).backupPath}.`);
    expect(
      within(failedItem).getByRole('button', {
        name: `Copy path of the saved original of ${fixture(4).file}`,
      }),
    ).toBeDefined();

    // A pending record keeps its plain sentence; nothing else names a backup.
    const pendingNote = itemAt(container, 3).querySelector('.dgv-modifications__note');
    expect(pendingNote?.textContent).toBe(
      'Recorded before writing; the change has not been confirmed as applied yet.',
    );
    expect(itemAt(container, 0).textContent ?? '').not.toContain('.debuggen/backups');
    expect(itemAt(container, 2).textContent ?? '').not.toContain('.debuggen/backups');
    expect(itemAt(container, 3).textContent ?? '').not.toContain('.debuggen/backups');
  });

  it('labels every item’s change "View diff", and offers no "Open diff" without a conflict entry', () => {
    render(<ModificationsList modifications={RECORDS} />);

    RECORDS.forEach((entry) => {
      const toggle = screen.getByRole('button', { name: `View diff of ${entry.file}` });
      expect(toggle.textContent).toBe('View diff');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.hasAttribute('aria-controls')).toBe(false);
    });
    expect(screen.queryByRole('button', { name: /^Open diff/u })).toBeNull();
  });

  it('shows the plan version, the layering and a machine-readable time in the meta line', () => {
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    const layered = itemAt(container, 2).querySelector('.dgv-modifications__meta');
    expect(layered?.textContent ?? '').toContain('Plan v2');
    expect(layered?.textContent ?? '').toContain('Layered on an earlier change');

    const plain = itemAt(container, 0).querySelector('.dgv-modifications__meta');
    expect(plain?.textContent ?? '').toContain('Plan v1');
    expect(plain?.textContent ?? '').not.toContain('Layered');

    const time = plain?.querySelector('time');
    expect(time?.getAttribute('dateTime')).toBe('2026-01-15T09:30:00.000Z');
    expect(time?.textContent).not.toBe('');
  });

  it('renders no time for a timestamp no Date can represent', () => {
    const odd = numberedRecord(9, 'src/lib/odd.ts', 'applied', { appliedAt: Number.MAX_VALUE });
    const { container } = render(<ModificationsList modifications={[odd]} />);

    expect(itemAt(container, 0).querySelector('time')).toBeNull();
    expect(container.textContent ?? '').not.toContain('Invalid Date');
  });
});

describe('ModificationsList keyboard', () => {
  it('makes every control a Tab stop and reaches the open diff’s region with Tab', async () => {
    const user = userEvent.setup();
    const file = 'src/server/zeta/handler.ts';
    const { container } = render(
      <ModificationsList modifications={[fixture(0)]} onOpenFile={vi.fn()} />,
    );

    await user.tab();
    const view = screen.getByRole('button', { name: `View diff of ${file}` });
    expect(document.activeElement).toBe(view);

    await user.keyboard('{Enter}');
    expect(details(container)).toHaveLength(1);
    expect(document.activeElement).toBe(view);
    expect(view.getAttribute('aria-expanded')).toBe('true');

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: `Open file ${file}` }));

    // The diff's labelled `<pre>` is a Tab stop of its own, so the arrow keys
    // scroll a wide line once it has focus.
    await user.tab();
    const region = screen.getByRole('region', {
      name: `Diff of ${file} (Change made by Debug Generator)`,
    });
    expect(document.activeElement).toBe(region);
    expect(region.tagName).toBe('PRE');
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(onlyDetail(container).contains(region)).toBe(true);

    // Nothing inside the list is taken out of the Tab order.
    expect(container.querySelector('[tabindex="-1"]')).toBeNull();

    // Space on the disclosure closes it again.
    view.focus();
    await user.keyboard(' ');
    expect(details(container)).toHaveLength(0);
    expect(view.getAttribute('aria-expanded')).toBe('false');
  });

  it('reaches a long diff’s window control before its region, and pages it by keyboard', async () => {
    const user = userEvent.setup();
    const file = 'src/lib/long/generated.ts';
    const lines = Array.from({ length: 1200 }, (_, index) => `+const line${String(index)} = 0;`);
    const long = numberedRecord(14, file, 'applied', { diff: `${lines.join('\n')}\n` });
    const { container } = render(<ModificationsList modifications={[long]} onOpenFile={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: `View diff of ${file}` }));
    screen.getByRole('button', { name: `Open file ${file}` }).focus();

    await user.tab();
    const next = screen.getByRole('button', { name: 'Show next 200 lines' });
    expect(document.activeElement).toBe(next);
    expect(next.getAttribute('tabindex')).toBe('0');

    await user.tab();
    const region = screen.getByRole('region', {
      name: `Diff of ${file} (Change made by Debug Generator)`,
    });
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
  });
});

/** The visible text of the stop rendered before the list in the Tab-route cases. */
const BEFORE_LIST = 'Before list';

/** The visible text of the stop rendered after the list in the Tab-route cases. */
const AFTER_LIST = 'After list';

/**
 * Renders the list between two ordinary Tab stops, so a Tab has somewhere to
 * come from and somewhere to go.
 */
function renderBetweenStops(onOpenFile: (file: string) => void): HTMLElement {
  const { container } = render(
    <>
      <Button>{BEFORE_LIST}</Button>
      <ModificationsList modifications={RECORDS} onOpenFile={onOpenFile} />
      <Button>{AFTER_LIST}</Button>
    </>,
  );

  act(() => {
    screen.getByRole('button', { name: BEFORE_LIST }).focus();
  });

  return container;
}

describe('ModificationsList Tab route to the item actions', () => {
  it('reaches each item’s diff and open-file actions with Tab, in item order, and leaves after the last', async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn<(file: string) => void>();
    renderBetweenStops(onOpenFile);
    const applied = fixture(0).file;
    const conflict = fixture(1).file;
    const after = screen.getByRole('button', { name: AFTER_LIST });

    const visited: Element[] = [];
    for (let step = 0; step < 64 && document.activeElement !== after; step += 1) {
      await user.tab();
      if (document.activeElement !== null) {
        visited.push(document.activeElement);
      }
    }
    expect(visited.at(-1)).toBe(after);

    const view = screen.getByRole('button', { name: `View diff of ${applied}` });
    const openApplied = screen.getByRole('button', { name: `Open file ${applied}` });
    const openConflict = screen.getByRole('button', { name: `Open file ${conflict}` });
    expect(visited[0]).toBe(view);
    expect(visited.indexOf(openApplied)).toBeGreaterThan(visited.indexOf(view));
    expect(visited.indexOf(openConflict)).toBeGreaterThan(visited.indexOf(openApplied));

    // Enter on an item's "Open file" raises the record's own path.
    openConflict.focus();
    await user.keyboard('{Enter}');
    expect(onOpenFile.mock.calls).toEqual([[conflict]]);

    // Shift+Tab walks the same route backwards.
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(visited[visited.indexOf(openConflict) - 1]);
  });
});

describe('ModificationsList "View diff"', () => {
  it('routes the record’s own diff into DiffView in its item and collapses on a second activation', async () => {
    const user = userEvent.setup();
    const { container } = render(<ModificationsList modifications={RECORDS} />);
    const file = 'src/features/alpha/Widget.tsx';

    const toggle = screen.getByRole('button', { name: `View diff of ${file}` });
    expect(toggle.textContent).toBe('View diff');
    expect(details(container)).toHaveLength(0);

    await user.click(toggle);

    const opened = screen.getByRole('button', { name: `Hide diff of ${file}` });
    expect(opened).toBe(toggle);
    expect(opened.textContent).toBe('Hide diff');
    expect(opened.getAttribute('aria-expanded')).toBe('true');

    const detail = onlyDetail(container);
    expect(detail.id).not.toBe('');
    expect(opened.getAttribute('aria-controls')).toBe(detail.id);
    // The diff sits in its own item, directly after that item's actions.
    expect(detail.closest('.dgv-modifications__item')).toBe(itemAt(container, 1));
    expect(detail.previousElementSibling?.classList.contains('dgv-modifications__actions')).toBe(
      true,
    );

    const region = within(detail).getByRole('region', {
      name: `Diff of ${file} (Change made by Debug Generator)`,
    });
    expect(detail.querySelector('.dgv-diff__subject')?.textContent).toBe(
      'Change made by Debug Generator',
    );
    const lines = Array.from(region.querySelectorAll('.dgv-diff__line')).map(
      (line) => line.textContent ?? '',
    );
    expect(lines.join('\n') + '\n').toBe(fixture(1).diff);
    expect(diffLineTexts(region, 'removed')).toEqual(['-  const marker2 = false;']);
    expect(diffLineTexts(region, 'added')).toEqual(['+  const marker2 = true;']);

    await user.click(opened);

    expect(details(container)).toHaveLength(0);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.hasAttribute('aria-controls')).toBe(false);
    expect(toggle.textContent).toBe('View diff');
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

    // The second item is opened deliberately: a list that routes the first
    // record's diff into every detail fails here.
    await user.click(screen.getByRole('button', { name: 'View diff of src/lib/second/source.ts' }));

    let detail = onlyDetail(container);
    expect(detail.closest('.dgv-modifications__item')).toBe(itemAt(container, 1));
    expect(diffLineTexts(detail, 'removed')).toEqual(['-  const secondValue = 3;']);
    expect(diffLineTexts(detail, 'added')).toEqual(['+  const secondValue = 4;']);
    expect(container.textContent ?? '').not.toContain('firstValue');

    await user.click(screen.getByRole('button', { name: 'View diff of src/lib/first/source.ts' }));

    detail = onlyDetail(container);
    expect(detail.closest('.dgv-modifications__item')).toBe(itemAt(container, 0));
    expect(diffLineTexts(detail, 'removed')).toEqual(['-  const firstValue = 1;']);
    expect(diffLineTexts(detail, 'added')).toEqual(['+  const firstValue = 2;']);
    expect(container.textContent ?? '').not.toContain('secondValue');
  });

  it('keeps one diff open at a time, moving the disclosure to the item activated last', async () => {
    const user = userEvent.setup();
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    await user.click(
      screen.getByRole('button', { name: 'View diff of src/server/zeta/handler.ts' }),
    );
    await user.click(screen.getByRole('button', { name: 'View diff of src/lib/mid/loader.ts' }));

    const detail = onlyDetail(container);
    expect(
      within(detail).getByRole('region', {
        name: 'Diff of src/lib/mid/loader.ts (Change made by Debug Generator)',
      }),
    ).toBeDefined();
    expect(
      screen
        .getByRole('button', { name: 'View diff of src/server/zeta/handler.ts' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('shows the hashes, and never repeats the backup path in a detail', async () => {
    const user = userEvent.setup();
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    await user.click(
      screen.getByRole('button', { name: 'View diff of src/features/alpha/Widget.tsx' }),
    );
    let detail = onlyDetail(container);
    // The conflict callout already states where the original is saved; the
    // detail holds the hashes and the diff only.
    expect(detail.textContent ?? '').not.toContain('Original saved at');
    expect(detail.textContent ?? '').not.toContain('.debuggen/backups');
    expect(itemAt(container, 1).textContent ?? '').toContain(
      `Original saved at ${fixture(1).backupPath}.`,
    );

    const hashes = detail.querySelector('.dgv-modifications__hashes');
    expect(hashes?.textContent ?? '').toContain(`Original SHA-256 ${digest('a').slice(0, 12)}`);
    expect(hashes?.textContent ?? '').toContain(`Instrumented SHA-256 ${digest('b').slice(0, 12)}`);
    const fullHash = Array.from(hashes?.querySelectorAll('code') ?? []).map((code) =>
      code.getAttribute('title'),
    );
    expect(fullHash).toEqual([digest('a'), digest('b')]);

    await user.click(screen.getByRole('button', { name: 'View diff of src/lib/mid/loader.ts' }));
    detail = onlyDetail(container);
    expect(detail.textContent ?? '').not.toContain('.debuggen/backups');
    // Only a conflict or failed item names a backup at all.
    expect(itemAt(container, 2).textContent ?? '').not.toContain('.debuggen/backups');
  });

  it('renders the diff’s own empty state for a record whose diff is blank', async () => {
    const user = userEvent.setup();
    const blank = numberedRecord(7, 'src/lib/blank.ts', 'applied', { diff: '' });
    const { container } = render(<ModificationsList modifications={[blank]} />);

    await user.click(screen.getByRole('button', { name: 'View diff of src/lib/blank.ts' }));

    expect(within(onlyDetail(container)).getByRole('status').textContent).toContain(
      'No diff is available for this modification.',
    );
  });
});

describe('ModificationsList conflict "Open diff"', () => {
  const FILE = 'src/features/alpha/Widget.tsx';

  it('opens the developer’s edit, not the tool’s change, labelled as the edit', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ModificationsList modifications={RECORDS} conflicts={[makeConflict()]} />,
    );

    // Only the conflict item offers it, before its "View diff".
    const openDiff = screen.getByRole('button', { name: `Open diff of your edit to ${FILE}` });
    expect(screen.getAllByRole('button', { name: /^Open diff/u })).toHaveLength(1);
    expect(openDiff.textContent).toBe('Open diff');
    expect(openDiff.getAttribute('aria-expanded')).toBe('false');
    expect(within(itemAt(container, 1)).getAllByRole('button')[1]).toBe(openDiff);

    await user.click(openDiff);

    expect(openDiff.getAttribute('aria-expanded')).toBe('true');
    expect(openDiff.textContent).toBe('Hide diff');
    const detail = onlyDetail(container);
    expect(openDiff.getAttribute('aria-controls')).toBe(detail.id);
    const region = within(detail).getByRole('region', {
      name: `Diff of ${FILE} (Your edit since instrumentation)`,
    });
    expect(diffLineTexts(region, 'removed')).toEqual(['-  const marker2 = true;']);
    expect(diffLineTexts(region, 'added')).toEqual(['+  const editedByHand = 3;']);
    // The edit carries no hashes of the tool's change.
    expect(detail.querySelector('.dgv-modifications__hashes')).toBeNull();

    // "View diff" on the same item swaps to the tool's own change.
    const viewDiff = screen.getByRole('button', { name: `View diff of ${FILE}` });
    await user.click(viewDiff);
    expect(openDiff.getAttribute('aria-expanded')).toBe('false');
    expect(openDiff.hasAttribute('aria-controls')).toBe(false);
    expect(viewDiff.getAttribute('aria-expanded')).toBe('true');
    const change = onlyDetail(container);
    expect(diffLineTexts(change, 'added')).toEqual(['+  const marker2 = true;']);
    expect(container.textContent ?? '').not.toContain('editedByHand');
  });

  it('falls back to the divergence from the saved original, labelled as such', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ModificationsList
        modifications={RECORDS}
        conflicts={[makeConflict({ diffs: { originalToCurrent: CURRENT_DIFF } })]}
      />,
    );

    await user.click(screen.getByRole('button', { name: `Open diff of your edit to ${FILE}` }));

    const region = within(onlyDetail(container)).getByRole('region', {
      name: `Diff of ${FILE} (Changes since the saved original)`,
    });
    expect(diffLineTexts(region, 'removed')).toEqual(['-  const marker2 = false;']);
  });

  it('offers no "Open diff" and says so when the entry carries no diff of the edit', () => {
    const { container } = render(
      <ModificationsList
        modifications={RECORDS}
        conflicts={[makeConflict({ diffs: { originalToInstrumented: fixture(1).diff } })]}
      />,
    );

    expect(screen.queryByRole('button', { name: /^Open diff/u })).toBeNull();
    expect(itemAt(container, 1).textContent ?? '').toContain(
      'A diff of the edit is not available.',
    );
    expect(screen.getByRole('button', { name: `View diff of ${FILE}` })).toBeDefined();
  });

  it('states the service’s own message for a reason other than an edit', () => {
    const message = `'${FILE}' is missing, so nothing was written; the original is retained.`;
    const { container } = render(
      <ModificationsList
        modifications={RECORDS}
        conflicts={[conflictWithoutDiffs({ reason: 'file-missing', message })]}
      />,
    );

    const callout = itemAt(container, 1).querySelector('.dgv-modifications__note');
    expect(callout?.querySelector('.dgv-modifications__message')?.textContent).toBe(message);
    expect(callout?.textContent ?? '').not.toContain('was edited while instrumented');
    expect(callout?.textContent ?? '').toContain(`Original saved at ${fixture(1).backupPath}.`);
    expect(callout?.textContent ?? '').not.toContain('A diff of the edit is not available.');
  });

  it('names no backup path when the service reports the backup missing', () => {
    const message = `The recorded original of '${FILE}' is missing, so the file was left as it is.`;
    const { container } = render(
      <ModificationsList
        modifications={RECORDS}
        conflicts={[conflictWithoutDiffs({ reason: 'backup-missing', message })]}
      />,
    );

    const callout = itemAt(container, 1).querySelector('.dgv-modifications__note');
    expect(callout?.textContent ?? '').toContain(message);
    expect(callout?.textContent ?? '').not.toContain('Original saved at');
    expect(within(itemAt(container, 1)).queryByRole('button', { name: /^Copy path/u })).toBeNull();
  });

  it('ignores a conflict entry for a record that is not in conflict', () => {
    render(
      <ModificationsList
        modifications={RECORDS}
        conflicts={[makeConflict({ recordId: fixture(0).id, file: fixture(0).file })]}
      />,
    );

    expect(screen.queryByRole('button', { name: /^Open diff/u })).toBeNull();
  });
});

describe('ModificationsList "Copy path"', () => {
  const COPY_CONFLICT = `Copy path of the saved original of ${fixture(1).file}`;

  it('copies the backup path exactly, confirms it, and clears the confirmation', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    stubClipboard(writeText);
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    const status = itemAt(container, 1).querySelector('.dgv-copy-path__status');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.textContent).toBe('');

    fireEvent.click(screen.getByRole('button', { name: COPY_CONFLICT }));
    await settleCopy();

    expect(writeText.mock.calls).toEqual([[fixture(1).backupPath]]);
    expect(status?.textContent).toBe('Copied.');

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(status?.textContent).toBe('');
  });

  it('selects the path and says so when the clipboard refuses', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')));
    const { container } = render(<ModificationsList modifications={RECORDS} />);

    fireEvent.click(screen.getByRole('button', { name: COPY_CONFLICT }));
    await settleCopy();

    const status = itemAt(container, 1).querySelector('.dgv-copy-path__status');
    expect(status?.textContent).toBe(
      'Could not copy. The path is selected; copy it with your copy shortcut.',
    );
    expect(window.getSelection()?.toString()).toBe(fixture(1).backupPath);
  });

  it('copies a failed record’s backup path', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    stubClipboard(writeText);
    render(<ModificationsList modifications={RECORDS} />);

    fireEvent.click(
      screen.getByRole('button', { name: `Copy path of the saved original of ${fixture(4).file}` }),
    );
    await settleCopy();

    expect(writeText.mock.calls).toEqual([[fixture(4).backupPath]]);
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
    expect(screen.getAllByRole('button', { name: /^View diff of /u })).toHaveLength(RECORDS.length);
  });
});

describe('ModificationsList states', () => {
  it('renders the neutral empty state, and no list, when nothing was modified', () => {
    const { container } = render(<ModificationsList modifications={[]} className="extra" />);

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('No files were modified for this session.');
    // A runtime-only plan modifies nothing, which is the good outcome: the
    // empty state is neither an alert nor a load in progress.
    expect(status.getAttribute('aria-busy')).not.toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Modified files' })).toBeNull();
    expect(container.querySelector('.dg-badge')).toBeNull();
    expect(container.firstElementChild?.className).toBe('dgv-modifications extra');
  });

  it('says nothing has been modified yet, not that nothing was, before instrumentation', () => {
    render(<ModificationsList modifications={[]} awaitingPlan />);

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('No files have been modified yet.');
    expect(status.textContent).toContain('once the plan is applied');
    expect(status.textContent).not.toContain('No files were modified for this session.');
    expect(status.getAttribute('aria-busy')).not.toBe('true');
    expect(screen.queryByRole('list', { name: 'Modified files' })).toBeNull();
  });

  it('shows the records, not the pre-plan sentence, when records already exist', () => {
    const { container } = render(<ModificationsList modifications={RECORDS} awaitingPlan />);

    expect(screen.getByRole('list', { name: 'Modified files' })).toBeDefined();
    expect(items(container)).toHaveLength(RECORDS.length);
    expect(container.textContent ?? '').not.toContain('No files have been modified yet.');
  });

  it('keeps the missing-records warning in place of the pre-plan sentence', () => {
    render(<ModificationsList modifications={[]} total={2} awaitingPlan />);

    expect(screen.queryByText(/No files have been modified yet\./u)).toBeNull();
    expect(
      screen.getByText(
        'Showing 0 of 2 recorded file modifications; the rest have not been loaded.',
      ),
    ).toBeDefined();
  });

  it('renders the loading state while pending, even when records are present', () => {
    const { container } = render(<ModificationsList modifications={RECORDS} pending />);

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('list', { name: 'Modified files' })).toBeNull();
    expect(items(container)).toHaveLength(0);
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
    expect(items(container)).toHaveLength(0);
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.textContent ?? '').not.toContain('No files were modified for this session.');
  });

  it('renders the error state above every other state, with retry when supplied', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { container } = render(
      <ModificationsList
        modifications={RECORDS}
        pending
        error="The service did not answer."
        onRetry={onRetry}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The service did not answer.');
    expect(items(container)).toHaveLength(0);
    expect(screen.queryByRole('status')).toBeNull();

    await user.click(within(alert).getByRole('button', { name: /retry/iu }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers no retry control when no retry callback is supplied', () => {
    render(<ModificationsList modifications={[]} error="Unavailable." />);

    const alert = screen.getByRole('alert');
    expect(within(alert).queryByRole('button')).toBeNull();
  });

  it('ignores a blank error and renders the list', () => {
    render(<ModificationsList modifications={RECORDS} error="   " />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('list', { name: 'Modified files' })).toBeDefined();
  });

  it('drops a blank caller class from the root when the list renders', () => {
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

  it('states how many of the journal’s records are shown, above the full list, as a polite status', () => {
    const { container } = render(
      <ModificationsList modifications={RECORDS} total={RECORDS.length + 2} />,
    );

    const line = shortfallLine(RECORDS.length, RECORDS.length + 2);
    expect(line.getAttribute('role')).toBe('status');
    expect(line.closest('.dgv-modifications__list')).toBeNull();
    expect(items(container)).toHaveLength(RECORDS.length);
    const list = screen.getByRole('list', { name: 'Modified files' });
    expect(line.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    expect(load.closest('.dgv-modifications__list')).toBeNull();
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
    expect(screen.queryByRole('list', { name: 'Modified files' })).toBeNull();
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

  it('writes nothing to the console while opening both of a conflict’s diffs and copying its path', async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn<(file: string) => void>();
    stubClipboard(() => Promise.reject(new Error('denied')));
    const file = 'src/features/alpha/Widget.tsx';
    const { container } = render(
      <ModificationsList
        modifications={RECORDS}
        conflicts={[makeConflict()]}
        onOpenFile={onOpenFile}
      />,
    );

    // The conflict item carries every sensitive value at once: the local
    // backup path in its callout, and the source diffs and hashes in its
    // details.
    await user.click(screen.getByRole('button', { name: `Open diff of your edit to ${file}` }));
    expect(diffLineTexts(container, 'added')).toEqual(['+  const editedByHand = 3;']);
    await user.click(screen.getByRole('button', { name: `View diff of ${file}` }));
    expect(onlyDetail(container).querySelector('.dgv-modifications__hashes')).not.toBeNull();
    expect(itemAt(container, 1).textContent ?? '').toContain(fixture(1).backupPath);

    await user.click(
      screen.getByRole('button', { name: `Copy path of the saved original of ${file}` }),
    );
    await user.click(screen.getByRole('button', { name: `Open file ${file}` }));
    await user.click(screen.getByRole('button', { name: `Hide diff of ${file}` }));

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
