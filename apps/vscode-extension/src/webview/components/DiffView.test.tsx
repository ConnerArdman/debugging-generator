/**
 * The contract of `components/DiffView` - the unified diff of one
 * instrumentation modification, shown under `ModificationsList`'s "View diff"
 * control in the editor webview (AAP 0.7.3).
 *
 * The component is the on-screen half of AAP 0.5.1's guarantee that every
 * modification is tracked and visible, so this suite pins fidelity first:
 *
 *   - **Classification.** `classifyDiffLine` sorts file and hunk headers before
 *     content, so `--- a/x` / `+++ b/x` never read as removed / added lines;
 *     inside a hunk body the renderer resolves header-looking content from the
 *     hunk's line counts.
 *   - **Byte fidelity.** One row per recorded line; only the line terminator is
 *     dropped; the marker column plus the text column reproduce each line
 *     exactly - indentation, tabs, trailing whitespace and carriage returns
 *     intact, nothing trimmed, nothing numbered.
 *   - **Meaning beyond colour.** The `+`, `-` or space marker is real, visible,
 *     announced text, never `aria-hidden` or visually hidden.
 *   - **Styling.** Class names only; no inline `style` in any state (AAP 0.6.4).
 *   - **The three states** and their precedence, error > pending > empty > diff,
 *     so the view never renders a blank area (AAP 0.5.5).
 *   - **Privacy.** Nothing is logged in any state (AAP 0.5.2).
 *
 * Every fixture is neutral, synthetic content written for this suite; no
 * inspected project's names or routes appear in it (AAP 0.5.4).
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyDiffLine, DiffView } from './DiffView';
import type { DiffLineKind, DiffViewProps } from './DiffView';

// `@testing-library/react` registers its automatic cleanup only on a global
// `afterEach`; registering it explicitly keeps this suite correct whether or not
// the Vitest project exposes globals. Spies are restored in the same hook so a
// failing assertion can never leak a patched `console` into the next case.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Every presentation kind, in the order a row's variant class is searched. */
const KINDS: readonly DiffLineKind[] = ['added', 'removed', 'context', 'meta'];

/** The project-relative path shown above the diff. */
const FILE_LABEL = 'src/lib/sample.ts';

/**
 * A minimal, well-formed hunk: a header, one removed, one added and one context
 * line whose own text is indented by three spaces (the diff adds the fourth,
 * the context marker). The header's counts match the body (two old-side and two
 * new-side lines), so every row is classified inside the hunk.
 */
const SAMPLE_LINES: readonly string[] = [
  '@@ -1,2 +1,2 @@',
  '-const value = 1;',
  '+const value = 2;',
  '    return value;',
];

/** The expected row for each line of {@link SAMPLE_LINES}, in order. */
const SAMPLE_ROWS: readonly ExpectedRow[] = [
  { kind: 'meta', marker: '', text: '@@ -1,2 +1,2 @@' },
  { kind: 'removed', marker: '-', text: 'const value = 1;' },
  { kind: 'added', marker: '+', text: 'const value = 2;' },
  { kind: 'context', marker: ' ', text: '   return value;' },
];

/** {@link SAMPLE_LINES} as the service records it: terminated by a newline. */
const SAMPLE_DIFF = `${SAMPLE_LINES.join('\n')}\n`;

/** The generic error message a caller forwards when the diff cannot be read. */
const ERROR_MESSAGE = 'The recorded diff could not be read.';

/** The empty-state copy the component owns (see its module header). */
const EMPTY_MESSAGE = 'No diff is available for this modification.';

/** The error-state title the component owns. */
const ERROR_TITLE = 'Could not show this diff';

/** One rendered row as this suite expects it. */
interface ExpectedRow {
  readonly kind: DiffLineKind;
  readonly marker: string;
  readonly text: string;
}

/** One named render of the component, used by the cross-state cases. */
interface StateCase {
  readonly name: string;
  readonly props: DiffViewProps;
}

/** One render per state, each carrying a caller class to follow through. */
const STATE_CASES: readonly StateCase[] = [
  { name: 'diff', props: { diff: SAMPLE_DIFF, fileLabel: FILE_LABEL, className: 'extra-layout' } },
  {
    name: 'error',
    props: {
      diff: SAMPLE_DIFF,
      fileLabel: FILE_LABEL,
      error: ERROR_MESSAGE,
      className: 'extra-layout',
    },
  },
  {
    name: 'pending',
    props: { diff: '', fileLabel: FILE_LABEL, pending: true, className: 'extra-layout' },
  },
  { name: 'empty', props: { diff: '', className: 'extra-layout' } },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The component's root element inside a render container.
 *
 * @param container The container `render` returned.
 * @returns The single element the component rendered.
 */
function rootOf(container: HTMLElement): HTMLElement {
  const root = container.firstElementChild;
  if (!(root instanceof HTMLElement)) {
    throw new Error('expected DiffView to render a root element');
  }
  expect(container.children).toHaveLength(1);
  return root;
}

/**
 * Every rendered diff row, in document order.
 *
 * @param scope The element to search, defaulting to the whole document.
 * @returns The `.dgv-diff__line` elements.
 */
function rowsIn(scope: ParentNode = document): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>('.dgv-diff__line'));
}

/**
 * The marker or text column of one row.
 *
 * @param row A `.dgv-diff__line` element.
 * @param column Which column to return.
 * @returns The column element; throws when the row lacks it.
 */
function columnOf(row: HTMLElement, column: 'marker' | 'text'): HTMLElement {
  const matches = Array.from(row.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains(`dgv-diff__${column}`),
  );
  const [element] = matches;
  if (element === undefined || matches.length !== 1) {
    throw new Error(`expected the row to carry exactly one dgv-diff__${column} column`);
  }
  return element;
}

/**
 * The kind variants a row carries. A correct row carries exactly one.
 *
 * @param row A `.dgv-diff__line` element.
 * @returns Every kind whose `dgv-diff__line--<kind>` class is present.
 */
function variantsOf(row: HTMLElement): DiffLineKind[] {
  return KINDS.filter((kind) => row.classList.contains(`dgv-diff__line--${kind}`));
}

/**
 * The row at one position, failing the case instead of returning `undefined`.
 *
 * @param rows The rendered rows.
 * @param index The position to read.
 * @returns The row element.
 */
function rowAt(rows: readonly HTMLElement[], index: number): HTMLElement {
  const row = rows[index];
  if (row === undefined) {
    throw new Error(`expected a row at position ${String(index)}`);
  }
  return row;
}

/**
 * Whether an element, or an ancestor below `boundary`, is removed from the
 * accessibility tree or painted invisibly.
 *
 * @param element The element to test.
 * @param boundary The ancestor at which the walk stops (exclusive).
 * @returns `true` when the element would not be perceived.
 */
function isHiddenFromReaders(element: Element, boundary: Element): boolean {
  let node: Element | null = element;
  while (node !== null && node !== boundary) {
    if (
      node.getAttribute('aria-hidden') === 'true' ||
      node.hasAttribute('hidden') ||
      node.classList.contains('dg-visually-hidden')
    ) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

/**
 * Asserts that the rendered rows are exactly `expected`, column by column, and
 * that each row's full text is the recorded line with nothing added.
 *
 * @param rows The rendered rows.
 * @param expected The expected rows, in order.
 */
function expectRows(rows: readonly HTMLElement[], expected: readonly ExpectedRow[]): void {
  expect(rows).toHaveLength(expected.length);

  expected.forEach((want, index) => {
    const row = rowAt(rows, index);
    expect(row.classList.contains('dgv-diff__line')).toBe(true);
    expect(variantsOf(row)).toEqual([want.kind]);
    expect(row.children).toHaveLength(2);
    expect(columnOf(row, 'marker').textContent).toBe(want.marker);
    expect(columnOf(row, 'text').textContent).toBe(want.text);
    expect(row.textContent).toBe(`${want.marker}${want.text}`);
  });
}

// ---------------------------------------------------------------------------
// classifyDiffLine
// ---------------------------------------------------------------------------

/** One classification case: a single line, without its terminator. */
interface ClassificationCase {
  readonly line: string;
  readonly kind: DiffLineKind;
}

/** Every classification the component relies on, one line per case. */
const CLASSIFICATION_CASES: readonly ClassificationCase[] = [
  // File and hunk headers, mode lines and notices.
  { line: 'diff --git a/x b/x', kind: 'meta' },
  { line: 'index 0000000..1111111 100644', kind: 'meta' },
  { line: '--- a/x', kind: 'meta' },
  { line: '+++ b/x', kind: 'meta' },
  { line: '@@ -1,4 +1,8 @@', kind: 'meta' },
  { line: '@@ -3 +3 @@ export function compute() {', kind: 'meta' },
  { line: 'new file mode 100644', kind: 'meta' },
  { line: 'deleted file mode 100644', kind: 'meta' },
  { line: 'old mode 100644', kind: 'meta' },
  { line: 'new mode 100755', kind: 'meta' },
  { line: 'similarity index 90%', kind: 'meta' },
  { line: 'rename from src/a.ts', kind: 'meta' },
  { line: 'rename to src/b.ts', kind: 'meta' },
  { line: '\\ No newline at end of file', kind: 'meta' },
  { line: 'Binary files differ', kind: 'meta' },
  // Added content.
  { line: '+const value = 1;', kind: 'added' },
  { line: '+', kind: 'added' },
  // Removed content.
  { line: '-const value = 1;', kind: 'removed' },
  { line: '-', kind: 'removed' },
  // Context: a leading space, an empty line, or anything unrecognised.
  { line: ' unchanged line', kind: 'context' },
  { line: '', kind: 'context' },
  { line: 'no prefix at all', kind: 'context' },
];

describe('classifyDiffLine', () => {
  it.each(CLASSIFICATION_CASES)('classifies "$line" as $kind', ({ line, kind }) => {
    expect(classifyDiffLine(line)).toBe(kind);
  });

  it('classifies the --- and +++ file headers as meta, never as removed or added content', () => {
    for (const header of ['--- a/x', '+++ b/x', '--- /dev/null', '+++ b/src/lib/sample.ts']) {
      const kind = classifyDiffLine(header);
      expect(kind).toBe('meta');
      expect(kind).not.toBe('added');
      expect(kind).not.toBe('removed');
    }
  });

  it('reads a header-like prefix without its separating space as content', () => {
    // `+++` is an added `++`, `---` a removed `--`: the trailing space is what
    // makes a file header, so neither of these is one.
    expect(classifyDiffLine('+++')).toBe('added');
    expect(classifyDiffLine('+++counter;')).toBe('added');
    expect(classifyDiffLine('---')).toBe('removed');
    expect(classifyDiffLine('----------')).toBe('removed');
    expect(classifyDiffLine('+index = 0;')).toBe('added');
    expect(classifyDiffLine('indexed value')).toBe('context');
  });

  it('never treats a marker behind leading whitespace as a marker', () => {
    expect(classifyDiffLine(' +not added')).toBe('context');
    expect(classifyDiffLine(' -not removed')).toBe('context');
    expect(classifyDiffLine('\t+not added')).toBe('context');
    expect(classifyDiffLine(' @@ not a hunk header')).toBe('context');
  });

  it('is case-sensitive about header prefixes', () => {
    expect(classifyDiffLine('Index: src/lib/sample.ts')).toBe('context');
    expect(classifyDiffLine('DIFF --git a/x b/x')).toBe('context');
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('DiffView rendering', () => {
  it('renders one row per recorded line, each with the base class and exactly one kind variant', () => {
    render(<DiffView diff={SAMPLE_DIFF} />);

    const rows = rowsIn();
    expect(rows).toHaveLength(SAMPLE_LINES.length);
    expectRows(rows, SAMPLE_ROWS);
  });

  it('drops only the terminating newline: a terminated and an unterminated diff render the same rows', () => {
    render(<DiffView diff={SAMPLE_LINES.join('\n')} />);
    expectRows(rowsIn(), SAMPLE_ROWS);
    cleanup();

    render(<DiffView diff={SAMPLE_DIFF} />);
    expectRows(rowsIn(), SAMPLE_ROWS);
  });

  it('keeps a genuine empty last line: only one terminator is ever dropped', () => {
    render(<DiffView diff={'+first\n\n'} />);

    expectRows(rowsIn(), [
      { kind: 'added', marker: '+', text: 'first' },
      { kind: 'context', marker: '', text: '' },
    ]);
  });

  it('shows the +, - or space marker as visible, announced text in its own column', () => {
    render(<DiffView diff={SAMPLE_DIFF} />);

    const rows = rowsIn();
    const expectedMarkers = ['-', '+', ' '];
    const contentRows = rows.slice(1);
    expect(contentRows).toHaveLength(expectedMarkers.length);

    contentRows.forEach((row, index) => {
      const marker = columnOf(row, 'marker');
      expect(marker.textContent).toBe(expectedMarkers[index]);
      expect(marker.getAttribute('aria-hidden')).toBeNull();
      expect(isHiddenFromReaders(marker, document.body)).toBe(false);
      expect(marker.className).toContain('dgv-diff__marker');
    });
  });

  it('shows the text column byte for byte: indentation intact, nothing trimmed, no line numbers', () => {
    render(<DiffView diff={SAMPLE_DIFF} />);

    const rows = rowsIn();
    const context = rowAt(rows, 3);
    expect(variantsOf(context)).toEqual(['context']);
    expect(columnOf(context, 'text').textContent).toBe('   return value;');
    expect(context.textContent).toBe('    return value;');

    // Joining the marker and text columns gives back every recorded line.
    expect(rows.map((row) => row.textContent)).toEqual([...SAMPLE_LINES]);
    for (const row of rows) {
      expect(row.textContent).not.toMatch(/^\s*\d+\s+[-+ @]/u);
    }
  });

  it('preserves tabs, runs of spaces, trailing whitespace and carriage returns', () => {
    const lines = [
      '@@ -1,2 +1,3 @@',
      '-\tconst  spaced = true;   ',
      '+\tconst  spaced = false;\r',
      '+\t\t',
      ' \ttrailing tab\t',
    ];
    render(<DiffView diff={`${lines.join('\n')}\n`} />);

    expectRows(rowsIn(), [
      { kind: 'meta', marker: '', text: '@@ -1,2 +1,3 @@' },
      { kind: 'removed', marker: '-', text: '\tconst  spaced = true;   ' },
      { kind: 'added', marker: '+', text: '\tconst  spaced = false;\r' },
      { kind: 'added', marker: '+', text: '\t\t' },
      { kind: 'context', marker: ' ', text: '\ttrailing tab\t' },
    ]);
  });

  it('keeps every row inside one named, focusable scroll region', () => {
    const { container } = render(<DiffView diff={SAMPLE_DIFF} />);

    const regions = container.querySelectorAll('.dgv-diff__scroll');
    expect(regions).toHaveLength(1);
    const region = regions.item(0);
    expect(region.getAttribute('role')).toBe('group');
    expect(region.getAttribute('aria-label')).toBe('Diff');
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('group', { name: 'Diff' })).toBe(region);
    expect(rowsIn(region)).toHaveLength(SAMPLE_LINES.length);
    expect(rowsIn(container)).toHaveLength(SAMPLE_LINES.length);
  });

  it('renders the file label above the diff and names the scroll region after it', () => {
    const { container } = render(<DiffView diff={SAMPLE_DIFF} fileLabel={FILE_LABEL} />);

    const root = rootOf(container);
    const label = root.querySelector('.dgv-diff__file');
    expect(label).not.toBeNull();
    expect(label?.textContent).toBe(FILE_LABEL);
    expect(root.firstElementChild).toBe(label);
    expect(screen.queryByText(FILE_LABEL)).not.toBeNull();

    const region = screen.getByRole('group', { name: `Diff of ${FILE_LABEL}` });
    expect(region.className).toBe('dgv-diff__scroll');
  });

  it('renders no file label for an absent or blank label', () => {
    const { container } = render(<DiffView diff={SAMPLE_DIFF} fileLabel="   " />);

    expect(container.querySelector('.dgv-diff__file')).toBeNull();
    expect(screen.getByRole('group', { name: 'Diff' })).not.toBeNull();
    cleanup();

    const second = render(<DiffView diff={SAMPLE_DIFF} fileLabel={undefined} />);
    expect(second.container.querySelector('.dgv-diff__file')).toBeNull();
  });

  it('resolves header-looking content inside a hunk body from the hunk counts', () => {
    const lines = [
      'diff --git a/src/one.ts b/src/one.ts',
      'index 0000000..1111111 100644',
      '--- a/src/one.ts',
      '+++ b/src/one.ts',
      '@@ -1,2 +1,2 @@',
      '--- legacy note',
      '+++ counter',
      ' unchanged();',
      '\\ No newline at end of file',
      'diff --git a/src/two.ts b/src/two.ts',
      '--- a/src/two.ts',
      '+++ b/src/two.ts',
      '@@ -3 +3 @@',
      '-before',
      '+after',
    ];
    render(<DiffView diff={`${lines.join('\n')}\n`} />);

    expectRows(rowsIn(), [
      { kind: 'meta', marker: '', text: 'diff --git a/src/one.ts b/src/one.ts' },
      { kind: 'meta', marker: '', text: 'index 0000000..1111111 100644' },
      { kind: 'meta', marker: '', text: '--- a/src/one.ts' },
      { kind: 'meta', marker: '', text: '+++ b/src/one.ts' },
      { kind: 'meta', marker: '', text: '@@ -1,2 +1,2 @@' },
      // A removed `-- legacy note` and an added `++ counter`: content, because
      // the hunk header still owes one old-side and one new-side line.
      { kind: 'removed', marker: '-', text: '-- legacy note' },
      { kind: 'added', marker: '+', text: '++ counter' },
      { kind: 'context', marker: ' ', text: 'unchanged();' },
      { kind: 'meta', marker: '', text: '\\ No newline at end of file' },
      // Once the counts are spent, the next file's headers are headers again.
      { kind: 'meta', marker: '', text: 'diff --git a/src/two.ts b/src/two.ts' },
      { kind: 'meta', marker: '', text: '--- a/src/two.ts' },
      { kind: 'meta', marker: '', text: '+++ b/src/two.ts' },
      { kind: 'meta', marker: '', text: '@@ -3 +3 @@' },
      { kind: 'removed', marker: '-', text: 'before' },
      { kind: 'added', marker: '+', text: 'after' },
    ]);
  });

  it('keeps a no-newline annotation out of the hunk counts', () => {
    const lines = [
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
    ];
    render(<DiffView diff={`${lines.join('\n')}\n`} />);

    expectRows(rowsIn(), [
      { kind: 'meta', marker: '', text: '@@ -1 +1 @@' },
      { kind: 'removed', marker: '-', text: 'old' },
      { kind: 'meta', marker: '', text: '\\ No newline at end of file' },
      { kind: 'added', marker: '+', text: 'new' },
      { kind: 'meta', marker: '', text: '\\ No newline at end of file' },
    ]);
  });

  it('renders a patch banner as whole-line rows with an empty marker column', () => {
    const banner = 'Index: src/lib/sample.ts';
    const rule = '===================================================================';
    const lines = [
      banner,
      rule,
      `--- ${FILE_LABEL}\toriginal`,
      `+++ ${FILE_LABEL}\tinstrumented`,
      '@@ -1 +1,2 @@',
      '+const started = 0;',
      ' const value = 1;',
    ];
    render(<DiffView diff={`${lines.join('\n')}\n`} />);

    expectRows(rowsIn(), [
      { kind: 'context', marker: '', text: banner },
      { kind: 'context', marker: '', text: rule },
      { kind: 'meta', marker: '', text: `--- ${FILE_LABEL}\toriginal` },
      { kind: 'meta', marker: '', text: `+++ ${FILE_LABEL}\tinstrumented` },
      { kind: 'meta', marker: '', text: '@@ -1 +1,2 @@' },
      { kind: 'added', marker: '+', text: 'const started = 0;' },
      { kind: 'context', marker: ' ', text: 'const value = 1;' },
    ]);
  });

  it('composes the caller class after its own on the root', () => {
    const { container } = render(<DiffView diff={SAMPLE_DIFF} className="extra-layout" />);

    expect(rootOf(container).className).toBe('dgv-diff extra-layout');
  });
});

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

describe('DiffView states', () => {
  it('renders the error state in place of the diff, with the file named inside it', () => {
    const { container } = render(
      <DiffView diff={SAMPLE_DIFF} fileLabel={FILE_LABEL} error={ERROR_MESSAGE} />,
    );

    const alert = screen.getByRole('alert');
    expect(within(alert).queryByText(ERROR_TITLE)).not.toBeNull();
    expect(within(alert).queryByText(ERROR_MESSAGE)).not.toBeNull();
    expect(within(alert).getByRole('group', { name: 'Modified file' }).textContent).toBe(
      FILE_LABEL,
    );

    expect(rootOf(container).className).toBe('dgv-diff dgv-diff--error');
    expect(rowsIn()).toHaveLength(0);
    expect(container.querySelector('.dgv-diff__scroll')).toBeNull();
    expect(container.querySelector('.dgv-diff__file')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders the loading state while pending, even when a diff is already present', () => {
    const { container } = render(<DiffView diff={SAMPLE_DIFF} fileLabel={FILE_LABEL} pending />);

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.textContent).toContain('Loading diff');
    expect(rowsIn()).toHaveLength(0);
    expect(container.querySelector('.dgv-diff__scroll')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    // The file being resolved stays named while the diff loads.
    expect(container.querySelector('.dgv-diff__file')?.textContent).toBe(FILE_LABEL);
  });

  it.each([
    { name: 'an empty diff', diff: '' },
    { name: 'a whitespace-only diff', diff: '  \n\t\n \r\n' },
  ])('renders the generic empty state for $name', ({ diff }) => {
    const { container } = render(<DiffView diff={diff} />);

    const status = screen.getByRole('status');
    expect(status.textContent).toBe(EMPTY_MESSAGE);
    expect(status.getAttribute('aria-busy')).toBeNull();
    expect(rowsIn()).toHaveLength(0);
    expect(container.querySelector('.dgv-diff__scroll')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lets the error outrank pending and an empty diff: only the alert renders', () => {
    const { container } = render(<DiffView diff="" pending error={ERROR_MESSAGE} />);

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
    expect(container.querySelector('[aria-busy]')).toBeNull();
    expect(rowsIn()).toHaveLength(0);
  });

  it('lets pending outrank an empty diff: only the loading state renders', () => {
    const { container } = render(<DiffView diff="" pending />);

    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.querySelector('.dgv-diff__scroll')).toBeNull();
  });

  it('treats a blank error as no error and an explicit pending={false} as settled', () => {
    render(<DiffView diff={SAMPLE_DIFF} error="   " pending={false} />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expectRows(rowsIn(), SAMPLE_ROWS);
  });

  it.each(STATE_CASES)('never renders a blank area in the $name state', ({ props }) => {
    const { container } = render(<DiffView {...props} />);

    const root = rootOf(container);
    expect(root.children.length).toBeGreaterThan(0);
    expect((root.textContent ?? '').trim()).not.toBe('');
  });

  it.each(STATE_CASES)('applies the caller class to the root in the $name state', ({ props }) => {
    const { container } = render(<DiffView {...props} />);

    const classes = rootOf(container).className.split(' ');
    expect(classes[0]).toBe('dgv-diff');
    expect(classes).toContain('extra-layout');
  });

  it.each(STATE_CASES)('emits no inline style in the $name state', ({ props }) => {
    const { container } = render(<DiffView {...props} />);

    expect(container.querySelectorAll('[style]')).toHaveLength(0);
    for (const element of Array.from(container.querySelectorAll('*'))) {
      expect(element.getAttribute('style')).toBeNull();
    }
  });

  it('logs nothing in any state', () => {
    const methods = ['log', 'warn', 'error', 'info', 'debug'] as const;
    const spies = methods.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );

    for (const { props } of STATE_CASES) {
      render(<DiffView {...props} />);
      cleanup();
    }
    render(<DiffView diff="" pending error={ERROR_MESSAGE} />);
    cleanup();
    render(<DiffView diff="  \n" />);

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
