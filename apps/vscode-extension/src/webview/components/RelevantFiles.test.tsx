/**
 * The contract of `components/RelevantFiles` — the investigation's selection in
 * the editor webview (AAP 0.7.3), and the list AAP 0.8.4's first acceptance
 * test reads.
 *
 * Pinned here:
 *
 *   - **Order is the pipeline's.** One row per file, in the order each file
 *     first appears, never re-sorted by score.
 *   - **One row per file.** Entries naming the same file become one row that
 *     keeps every distinct symbol and reason and the file's best score; files
 *     are compared as exact strings.
 *   - **The payload is untouched.** Activating a row — by pointer or keyboard —
 *     raises `onOpenFile` with the entry's `file` string exactly as received.
 *   - **Faithful text.** Path, symbol and reason render verbatim; the score is
 *     formatted to two decimals after a visible "Relevance" label; an absent
 *     symbol leaves no element behind.
 *   - **Paths stay apart when shortened.** Each chip splits its path into the
 *     `.dgv-path` lead, context and file name, with a tail that no other file
 *     of the list ends in, so same-named files never render the same tail; the
 *     chip is `aria-hidden` with the whole path as its tooltip, and a visually
 *     hidden copy of the whole path names the row.
 *   - **Accessible rows.** Each row is a button named by its file (and symbol)
 *     and described by its reason, inside an ordered list.
 *   - **Direction controls are shown, never obeyed.** A U+202E/U+202C pair in
 *     the path, symbol, a 500-character reason or an error prints as visible
 *     `\u202E`/`\u202C` escapes in every part, tooltip and accessible name,
 *     while `onOpenFile` still receives the raw file string.
 *   - **The three states** and their precedence: error > pending > empty > list.
 *   - **Silence.** Paths and reasons are the developer's content, so no state
 *     writes anything to any console (AAP 0.5.2).
 *
 * Harness conventions follow the rest of the repository: the Vitest API is
 * imported explicitly, `cleanup` is registered explicitly, and — with no
 * `jest-dom` in this repository — state is read from DOM properties. The
 * fixture paths and prose are generic vocabulary written for this suite; no
 * inspected project's names appear in it (AAP 0.5.4).
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RelevantFile } from '@debuggen/protocol';

import { RelevantFiles } from './RelevantFiles';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Builds one relevant-file entry against the real protocol type.
 *
 * The defaults are neutral synthetic values; each case overrides only what it
 * is about, so the property under test is the one that reads differently.
 *
 * @param overrides The members this case pins.
 * @returns A complete {@link RelevantFile}.
 */
function makeFile(overrides?: Partial<RelevantFile>): RelevantFile {
  return {
    file: 'src/modules/sample/entry.ts',
    symbol: 'sampleEntry',
    reason: 'Defines the entry point the question refers to.',
    score: 0.5,
    ...overrides,
  };
}

/**
 * Three entries whose scores ASCEND: a component that sorted by relevance —
 * the natural "helpful" mistake — would render them reversed.
 */
const ASCENDING: readonly RelevantFile[] = [
  makeFile({
    file: 'src/modules/first/one.ts',
    symbol: 'firstStep',
    reason: 'Starts the flow.',
    score: 0.1,
  }),
  makeFile({
    file: 'src/modules/second/two.tsx',
    symbol: undefined,
    reason: 'Renders the result of the flow.',
    score: 0.5,
  }),
  makeFile({
    file: 'src/modules/third/three.ts',
    symbol: 'thirdStep',
    reason: 'Finishes the flow.',
    score: 0.95,
  }),
];

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

/**
 * Every button in the document, narrowed to its element type.
 *
 * @returns The `<button>` elements, in document order.
 */
function allButtons(): HTMLButtonElement[] {
  return screen.queryAllByRole('button').map((element) => {
    if (!(element instanceof HTMLButtonElement)) {
      throw new Error('expected every button role to be a <button> element');
    }
    return element;
  });
}

/**
 * The text of one row's part, read by its class.
 *
 * @param row The `<li>` of the row.
 * @param part The part's class name, without the leading dot.
 * @returns The part's text, or `null` when the row renders no such part.
 */
function partText(row: HTMLElement, part: string): string | null {
  return row.querySelector(`.${part}`)?.textContent ?? null;
}

/** The five console methods a component could leak developer content through. */
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

describe('RelevantFiles list', () => {
  it('renders one row per distinct file, in the given order, without re-sorting by score', () => {
    render(<RelevantFiles files={FILES} onOpenFile={noop} />);

    const items = within(theList()).getAllByRole('listitem');
    expect(items).toHaveLength(FILES.length);

    const renderedPaths = items.map((item) => item.querySelector('.dgv-path')?.textContent ?? '');
    expect(renderedPaths).toEqual(FILES.map((entry) => entry.file));
  });

  it('keeps ascending scores ascending: the ranking given is the order rendered', () => {
    render(<RelevantFiles files={ASCENDING} onOpenFile={noop} />);

    const items = within(theList()).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items.map((item) => partText(item, 'dgv-path'))).toEqual([
      'src/modules/first/one.ts',
      'src/modules/second/two.tsx',
      'src/modules/third/three.ts',
    ]);
    expect(items.map((item) => partText(item, 'dgv-files__score'))).toEqual([
      'Relevance 0.10',
      'Relevance 0.50',
      'Relevance 0.95',
    ]);
  });

  it('renders every row in full: exact path, symbol when present, verbatim reason, fixed score', () => {
    render(<RelevantFiles files={ASCENDING} onOpenFile={noop} />);

    const items = within(theList()).getAllByRole('listitem');
    expect(items).toHaveLength(ASCENDING.length);

    ASCENDING.forEach((entry, index) => {
      const item = items[index];
      if (item === undefined) {
        throw new Error(`expected a row at position ${String(index)}`);
      }

      // `toBe` on the whole string: the DOM carries the full path, so any
      // shortening is the stylesheet's, never a sliced string.
      const path = item.querySelector('.dgv-path');
      expect(path?.tagName).toBe('CODE');
      expect(path?.textContent).toBe(entry.file);
      expect(path?.getAttribute('title')).toBe(entry.file);
      expect(path?.getAttribute('aria-hidden')).toBe('true');

      expect(partText(item, 'dgv-files__reason')).toBe(entry.reason);
      expect(partText(item, 'dgv-files__score')).toBe(`Relevance ${entry.score.toFixed(2)}`);

      const symbolElements = item.querySelectorAll('.dgv-files__meta .dg-text--accent');
      if (entry.symbol === undefined) {
        expect(symbolElements).toHaveLength(0);
      } else {
        expect(symbolElements).toHaveLength(1);
        expect(symbolElements[0]?.textContent).toBe(entry.symbol);
      }
    });
  });

  it('renders an explicit `symbol: undefined` with no empty symbol element and no stray text', () => {
    const entry = makeFile({ file: 'src/modules/solo/module.ts', symbol: undefined, score: 0.3 });
    render(<RelevantFiles files={[entry]} onOpenFile={noop} />);

    const item = within(theList()).getByRole('listitem');
    expect(item.querySelectorAll('.dg-text--accent')).toHaveLength(0);
    expect(item.textContent).not.toContain('undefined');
    // The path twice and nothing else of its own: the visually hidden copy that
    // names the row, then the aria-hidden chip.
    expect(item.textContent).toBe(
      `src/modules/solo/module.tssrc/modules/solo/module.tsRelevance 0.30${entry.reason}`,
    );

    const button = within(item).getByRole('button');
    expect(button.getAttribute('aria-labelledby')?.split(' ')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'src/modules/solo/module.ts' })).toBe(button);
  });

  it('exposes list semantics so the order reaches assistive technology', () => {
    render(<RelevantFiles files={ASCENDING} onOpenFile={noop} />);

    const list = theList();
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(ASCENDING.length);
    for (const item of items) {
      expect(item.tagName).toBe('LI');
      expect(item.parentElement).toBe(list);
    }
  });

  it('names each row button by its file and symbol, and describes it by its reason and score', () => {
    render(<RelevantFiles files={FILES} onOpenFile={noop} />);

    const buttons = within(theList()).getAllByRole('button');
    expect(buttons).toHaveLength(FILES.length);

    // `type="button"` on every row: a default `submit` button inside any
    // ancestor form would submit — and navigate — the webview document.
    const rendered = allButtons();
    expect(rendered).toHaveLength(FILES.length);
    for (const button of rendered) {
      expect(button.type).toBe('button');
    }
    expect(screen.getByRole('button', { name: 'src/features/alpha/Widget.tsx onActivate' })).toBe(
      buttons[0],
    );
    expect(screen.getByRole('button', { name: 'src/server/beta/handler.ts' })).toBe(buttons[1]);
    expect(screen.getByRole('button', { name: 'src/lib/gamma.ts loadRecords' })).toBe(buttons[2]);

    const first = buttons[0];
    if (first === undefined) {
      throw new Error('expected a first row button');
    }
    const descriptionIds = first.getAttribute('aria-describedby')?.split(' ') ?? [];
    const description = descriptionIds
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

    const path = first.querySelector('.dgv-path');
    expect(path?.tagName).toBe('CODE');
    expect(path?.getAttribute('title')).toBe('src/features/alpha/Widget.tsx');
    expect(within(first).getByText('onActivate')).toBeDefined();
    expect(first.querySelector('.dgv-files__reason')?.textContent).toBe(
      'Registers the handler the selected element dispatches to.',
    );
    expect(first.querySelector('.dgv-files__score')?.textContent).toBe('Relevance 0.42');
    expect(third.querySelector('.dgv-files__score')?.textContent).toBe('Relevance 0.13');
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
    expect(second.querySelector('.dgv-files__score')?.textContent).toBe('Relevance 0.90');
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

describe('RelevantFiles grouping', () => {
  /**
   * The shape the investigation produces: each file selected once as a route
   * handler and again, lower down, for a symbol it declares.
   */
  const REPEATED: readonly RelevantFile[] = [
    {
      file: 'src/routes/alpha/handler.ts',
      symbol: '/alpha',
      reason: 'Handles the alpha route.',
      score: 0.5,
    },
    {
      file: 'src/routes/beta/handler.ts',
      symbol: '/beta',
      reason: 'Handles the beta route.',
      score: 0.5,
    },
    {
      file: 'src/routes/alpha/handler.ts',
      symbol: 'POST',
      reason: 'Declares the alpha method.',
      score: 0.1,
    },
    {
      file: 'src/routes/beta/handler.ts',
      symbol: 'GET',
      reason: 'Declares the beta method.',
      score: 0.1,
    },
  ];

  it('lists each file once, in the order it first appears', () => {
    render(<RelevantFiles files={REPEATED} onOpenFile={noop} />);

    const items = within(theList()).getAllByRole('listitem');
    expect(items.map((item) => partText(item, 'dgv-path'))).toEqual([
      'src/routes/alpha/handler.ts',
      'src/routes/beta/handler.ts',
    ]);
    expect(allButtons()).toHaveLength(2);
  });

  it('keeps every symbol and every reason of a file, in ranking order, and its best score', () => {
    render(<RelevantFiles files={REPEATED} onOpenFile={noop} />);

    const [alpha] = within(theList()).getAllByRole('listitem');
    if (alpha === undefined) {
      throw new Error('expected the alpha row');
    }
    const symbols = alpha.querySelectorAll('.dgv-files__meta .dg-text--accent');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.textContent).toBe('/alpha, POST');
    expect(
      Array.from(alpha.querySelectorAll('.dgv-files__reason'), (reason) => reason.textContent),
    ).toEqual(['Handles the alpha route.', 'Declares the alpha method.']);
    expect(partText(alpha, 'dgv-files__score')).toBe('Relevance 0.50');

    const button = within(alpha).getByRole('button');
    expect(screen.getByRole('button', { name: 'src/routes/alpha/handler.ts /alpha, POST' })).toBe(
      button,
    );
    const description = (button.getAttribute('aria-describedby')?.split(' ') ?? [])
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(description).toBe('Handles the alpha route. Declares the alpha method. Relevance 0.50');
  });

  it('takes the best score even when a later entry of the file carries it', () => {
    render(
      <RelevantFiles
        files={[
          makeFile({ file: 'src/a.ts', symbol: 'first', reason: 'Listed first.', score: 0.2 }),
          makeFile({ file: 'src/b.ts', symbol: 'other', reason: 'Listed between.', score: 0.6 }),
          makeFile({ file: 'src/a.ts', symbol: 'later', reason: 'Listed later.', score: 0.8 }),
          makeFile({ file: 'src/a.ts', symbol: 'last', reason: 'Listed last.', score: Number.NaN }),
        ]}
        onOpenFile={noop}
      />,
    );

    const items = within(theList()).getAllByRole('listitem');
    expect(items.map((item) => partText(item, 'dgv-path'))).toEqual(['src/a.ts', 'src/b.ts']);
    expect(items.map((item) => partText(item, 'dgv-files__score'))).toEqual([
      'Relevance 0.80',
      'Relevance 0.60',
    ]);
    expect(document.body.textContent).not.toContain('NaN');
  });

  it('collects a repeated symbol or reason once and drops blank ones', () => {
    render(
      <RelevantFiles
        files={[
          makeFile({ file: 'src/a.ts', symbol: 'shared', reason: 'Same reason.', score: 0.4 }),
          makeFile({ file: 'src/a.ts', symbol: 'shared', reason: 'Same reason.', score: 0.3 }),
          makeFile({ file: 'src/a.ts', symbol: '  ', reason: '   ', score: 0.2 }),
        ]}
        onOpenFile={noop}
      />,
    );

    const item = within(theList()).getByRole('listitem');
    expect(item.querySelector('.dgv-files__meta .dg-text--accent')?.textContent).toBe('shared');
    expect(item.querySelectorAll('.dgv-files__reason')).toHaveLength(1);
    // The whole path twice — the hidden copy that names the row, then the chip.
    expect(item.textContent).toBe('src/a.tssrc/a.tssharedRelevance 0.40Same reason.');
  });

  it('keeps two spellings of one path as two rows: grouping never normalises a path', () => {
    render(
      <RelevantFiles
        files={[
          makeFile({ file: 'src/a.ts', symbol: undefined, reason: 'Plain.', score: 0.4 }),
          makeFile({ file: './src/a.ts', symbol: undefined, reason: 'Dotted.', score: 0.3 }),
        ]}
        onOpenFile={noop}
      />,
    );

    expect(
      within(theList())
        .getAllByRole('listitem')
        .map((item) => partText(item, 'dgv-path')),
    ).toEqual(['src/a.ts', './src/a.ts']);
  });

  it('opens a grouped file with its file string unchanged', async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn<(file: string) => void>();
    render(<RelevantFiles files={REPEATED} onOpenFile={onOpenFile} />);

    await user.click(screen.getByRole('button', { name: 'src/routes/beta/handler.ts /beta, GET' }));

    expect(onOpenFile.mock.calls).toEqual([['src/routes/beta/handler.ts']]);
  });

  it('describes a row with neither a reason nor a score by nothing at all', () => {
    render(
      <RelevantFiles
        files={[{ file: 'src/bare.ts', reason: ' ', score: Number.NaN }]}
        onOpenFile={noop}
      />,
    );

    const button = screen.getByRole('button', { name: 'src/bare.ts' });
    expect(button.hasAttribute('aria-describedby')).toBe(false);
    expect(document.querySelector('.dgv-files__reason')).toBeNull();
    expect(document.querySelector('.dgv-files__score')).toBeNull();
  });
});

describe('RelevantFiles path display', () => {
  /**
   * The shapes that rendered identical chips once shortened: a file and its
   * namesake in a subdirectory, and namesakes under identical long directory
   * runs that differ in one outer segment. Plus one file whose name is unique
   * and one bare file name.
   */
  const NAMESAKES: readonly RelevantFile[] = [
    makeFile({ file: 'app/api/widgets/route.ts', symbol: 'GET', score: 0.92 }),
    makeFile({ file: 'app/api/widgets/parts/route.ts', symbol: 'POST', score: 0.81 }),
    makeFile({ file: 'src/views/first/ExtremelyLongNestedDirectoryName/Pane.tsx', score: 0.7 }),
    makeFile({ file: 'src/views/second/ExtremelyLongNestedDirectoryName/Pane.tsx', score: 0.6 }),
    makeFile({ file: 'src/lib/format.ts', symbol: undefined, score: 0.4 }),
    makeFile({ file: 'README.md', symbol: undefined, score: 0.2 }),
  ];

  /** One chip's parts, `null` for a part the chip does not render. */
  interface ChipParts {
    readonly lead: string | null;
    readonly tail: string | null;
    readonly context: string | null;
    readonly name: string | null;
  }

  /**
   * Reads the rendered parts of one row's path chip.
   *
   * @param row The `<li>` of the row.
   * @returns The text of each part.
   */
  function chipParts(row: HTMLElement): ChipParts {
    const chip = row.querySelector('.dgv-path');
    if (chip === null) {
      throw new Error('expected a path chip in the row');
    }
    const text = (part: string): string | null =>
      chip.querySelector(`.dgv-path__${part}`)?.textContent ?? null;
    return { lead: text('lead'), tail: text('tail'), context: text('context'), name: text('name') };
  }

  it('starts each tail at the part that tells same-named files apart, and keeps the file name', () => {
    render(<RelevantFiles files={NAMESAKES} onOpenFile={noop} />);

    const rows = within(theList()).getAllByRole('listitem');
    expect(rows.map(chipParts)).toEqual([
      { lead: 'app/api/', tail: 'widgets/route.ts', context: 'widgets/', name: 'route.ts' },
      { lead: 'app/api/widgets/', tail: 'parts/route.ts', context: 'parts/', name: 'route.ts' },
      {
        lead: 'src/views/',
        tail: 'first/ExtremelyLongNestedDirectoryName/Pane.tsx',
        context: 'first/ExtremelyLongNestedDirectoryName/',
        name: 'Pane.tsx',
      },
      {
        lead: 'src/views/',
        tail: 'second/ExtremelyLongNestedDirectoryName/Pane.tsx',
        context: 'second/ExtremelyLongNestedDirectoryName/',
        name: 'Pane.tsx',
      },
      // A unique name is its own tail: no context element is left behind.
      { lead: 'src/lib/', tail: 'format.ts', context: null, name: 'format.ts' },
      // A bare name has no lead element either.
      { lead: null, tail: 'README.md', context: null, name: 'README.md' },
    ]);

    // No two chips share a tail: the part that survives a narrow view differs.
    const tails = rows.map((row) => chipParts(row).tail);
    expect(new Set(tails).size).toBe(tails.length);
  });

  it('keeps each chip byte-faithful and tooltipped with the whole path', () => {
    render(<RelevantFiles files={NAMESAKES} onOpenFile={noop} />);

    const rows = within(theList()).getAllByRole('listitem');
    rows.forEach((row, index) => {
      const file = NAMESAKES[index]?.file;
      const chip = row.querySelector('.dgv-path');
      expect(chip?.tagName).toBe('CODE');
      expect(chip?.textContent).toBe(file);
      expect(chip?.getAttribute('title')).toBe(file);
      expect(chip?.getAttribute('aria-hidden')).toBe('true');
    });
  });

  it('names each row by a visually hidden copy of the whole path, never by the split chip', () => {
    render(<RelevantFiles files={NAMESAKES} onOpenFile={noop} />);

    expect(screen.getByRole('button', { name: 'app/api/widgets/route.ts GET' })).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'app/api/widgets/parts/route.ts POST' }),
    ).toBeDefined();

    for (const button of allButtons()) {
      const [pathId] = button.getAttribute('aria-labelledby')?.split(' ') ?? [];
      const copy = pathId === undefined ? null : document.getElementById(pathId);
      expect(copy?.classList.contains('dg-visually-hidden')).toBe(true);
      expect(copy?.closest('[aria-hidden="true"]')).toBeNull();
      expect(copy?.closest('.dgv-path')).toBeNull();
    }
    const copies = allButtons().map((button) => {
      const [pathId] = button.getAttribute('aria-labelledby')?.split(' ') ?? [];
      return pathId === undefined ? null : document.getElementById(pathId)?.textContent;
    });
    expect(copies).toEqual(NAMESAKES.map((entry) => entry.file));
  });

  it('raises onOpenFile with the whole, untouched path from a shortened row', async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn<(file: string) => void>();
    render(<RelevantFiles files={NAMESAKES} onOpenFile={onOpenFile} />);

    await user.click(screen.getByRole('button', { name: 'app/api/widgets/parts/route.ts POST' }));
    await user.click(screen.getByRole('button', { name: 'app/api/widgets/route.ts GET' }));

    expect(onOpenFile.mock.calls).toEqual([
      ['app/api/widgets/parts/route.ts'],
      ['app/api/widgets/route.ts'],
    ]);
  });

  it('splits a file listed twice, under two symbols, once, in its one row', () => {
    const twice: readonly RelevantFile[] = [
      makeFile({ file: 'src/a/entry.ts', symbol: 'first' }),
      makeFile({ file: 'src/b/entry.ts', symbol: 'other' }),
      makeFile({ file: 'src/a/entry.ts', symbol: 'second' }),
    ];
    render(<RelevantFiles files={twice} onOpenFile={noop} />);

    const rows = within(theList()).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const [first, other] = rows.map(chipParts);
    expect(first).toEqual({ lead: 'src/', tail: 'a/entry.ts', context: 'a/', name: 'entry.ts' });
    expect(other?.tail).toBe('b/entry.ts');
    expect(screen.getByRole('button', { name: 'src/a/entry.ts first, second' })).toBeDefined();
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

  it('hands back a deeply nested path byte for byte: no prefix, no separator rewrite, no line suffix', async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn<(file: string) => void>();
    const nested = makeFile({
      file: 'src/modules/outer/inner/deepest/nested-entry.module.tsx',
      symbol: 'nestedEntry',
    });
    render(<RelevantFiles files={[makeFile(), nested]} onOpenFile={onOpenFile} />);

    await user.click(
      screen.getByRole('button', {
        name: 'src/modules/outer/inner/deepest/nested-entry.module.tsx nestedEntry',
      }),
    );

    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith(nested.file);

    const payload = onOpenFile.mock.calls[0]?.[0];
    expect(payload).toBe('src/modules/outer/inner/deepest/nested-entry.module.tsx');
    expect(payload).not.toMatch(/:\d+(:\d+)?$/);
    expect(payload).not.toMatch(/^(\.\/|\/)/);
    expect(payload).not.toContain('\\');
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

describe('RelevantFiles direction controls', () => {
  /**
   * A right-to-left override (U+202E) and its pop (U+202C) around markup.
   * Escaping keeps the markup inert, but the override alone would draw the text
   * between them backwards — `</td><script>` read as `>tpircs<>dt/<`. Every
   * code point is written as an escape so this suite is not itself a carrier.
   */
  const SPOOF = '\u202E</td><script>alert(7)</script>\u202C';

  /** Any of the twelve Unicode bidirectional formatting controls, raw. */
  const RAW_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

  /**
   * What a reader must see: each control of {@link SPOOF} printed as its
   * visible escape and every other character untouched. Spelled out here
   * rather than by calling the formatter, so the suite pins the output.
   */
  function revealed(text: string): string {
    return text.replaceAll('\u202E', '\\u202E').replaceAll('\u202C', '\\u202C');
  }

  /**
   * The path's `/` separators split the spoof across the chip's lead and its
   * file name, so each part must be revealed on its own.
   */
  const FILE = `src/spoof/${SPOOF}.ts`;
  const SYMBOL = `handle${SPOOF}`;

  /** The protocol's longest reason: exactly 500 characters, the pair inside. */
  const REASON = `Serves the request ${SPOOF} that the selected element issues.`.padEnd(500, '.');

  const ENTRY: RelevantFile = { file: FILE, symbol: SYMBOL, reason: REASON, score: 0.75 };

  it('shows each control as a visible escape in the chip, the hidden name, the symbol and the reason', () => {
    expect(REASON).toHaveLength(500);
    render(<RelevantFiles files={[ENTRY]} onOpenFile={noop} />);

    const row = within(theList()).getByRole('listitem');
    const chip = row.querySelector('.dgv-path');
    expect(chip?.tagName).toBe('CODE');
    expect(chip?.getAttribute('dir')).toBe('ltr');
    expect(chip?.textContent).toBe(revealed(FILE));
    expect(chip?.getAttribute('title')).toBe(revealed(FILE));
    // The spoof straddles two parts of the split; each shows its own marker.
    expect(partText(row, 'dgv-path__lead')).toBe('src/spoof/\\u202E</td><script>alert(7)</');
    expect(partText(row, 'dgv-path__name')).toBe('script>\\u202C.ts');

    const symbol = row.querySelector('.dgv-files__meta .dg-text--accent');
    expect(symbol?.textContent).toBe(revealed(SYMBOL));
    expect(symbol?.getAttribute('title')).toBe(revealed(SYMBOL));
    expect(partText(row, 'dgv-files__reason')).toBe(revealed(REASON));

    expect(
      screen.getByRole('button', { name: `${revealed(FILE)} ${revealed(SYMBOL)}` }),
    ).toBeDefined();
  });

  it('leaves no raw control in any text, tooltip or accessible name, and no markup behind', () => {
    const { container } = render(<RelevantFiles files={[ENTRY]} onOpenFile={noop} />);

    expect(container.textContent).toContain('\\u202E');
    expect(container.textContent).toContain('\\u202C');
    expect(container.textContent).not.toMatch(RAW_CONTROL);

    const labelled = container.querySelectorAll('[title], [aria-label]');
    expect(labelled.length).toBeGreaterThan(0);
    for (const element of labelled) {
      expect(element.getAttribute('title') ?? '').not.toMatch(RAW_CONTROL);
      expect(element.getAttribute('aria-label') ?? '').not.toMatch(RAW_CONTROL);
    }

    // The markup is text, never elements.
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('td')).toBeNull();
  });

  it('raises onOpenFile with the raw file string, controls included', async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn<(file: string) => void>();
    render(<RelevantFiles files={[ENTRY]} onOpenFile={onOpenFile} />);

    await user.click(screen.getByRole('button', { name: `${revealed(FILE)} ${revealed(SYMBOL)}` }));

    expect(onOpenFile.mock.calls).toEqual([[FILE]]);
    expect(onOpenFile.mock.calls[0]?.[0]).toMatch(RAW_CONTROL);
  });

  it('shows the controls of an error message as visible escapes', () => {
    render(<RelevantFiles files={[]} onOpenFile={noop} error={`Investigation failed: ${SPOOF}`} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(revealed(`Investigation failed: ${SPOOF}`));
    expect(alert.textContent).not.toMatch(RAW_CONTROL);
  });
});

describe('RelevantFiles states', () => {
  it('renders the empty state with generic copy when no files were identified', () => {
    render(<RelevantFiles files={[]} onOpenFile={noop} className="extra-layout" />);

    const status = screen.getByRole('status');
    expect(status.textContent).toBe('No files have been identified yet.');
    expect(status.classList.contains('extra-layout')).toBe(true);
    expect(screen.queryByRole('list')).toBeNull();

    // The copy is the component's own, and it invents no path: no separator
    // and no file extension of its own making.
    expect(status.textContent).not.toMatch(/[/\\]/);
    expect(status.textContent).not.toMatch(/\.[a-z]{1,4}\b/i);
    expect(allButtons()).toHaveLength(0);
  });

  it('renders the loading state while pending, even when files are present', () => {
    render(<RelevantFiles files={FILES} onOpenFile={noop} pending />);

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.textContent).toContain('Loading relevant files…');
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(document.querySelector('.dgv-path')).toBeNull();
    for (const entry of FILES) {
      expect(document.body.textContent).not.toContain(entry.file);
    }
  });

  it('renders only the alert when error, pending and an empty list coincide', () => {
    render(<RelevantFiles files={[]} onOpenFile={noop} pending error="Investigation failed." />);

    const alert = screen.queryByRole('alert');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('Investigation failed.');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
    expect(document.body.textContent).not.toContain('Loading relevant files…');
    expect(document.body.textContent).not.toContain('No files have been identified yet.');
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

    const retry = within(screen.getByRole('alert')).getByRole('button');
    expect(allButtons()).toEqual([retry]);
    for (const button of allButtons()) {
      expect(button.type).toBe('button');
    }

    await user.click(retry);

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('treats a blank error as no error', () => {
    render(<RelevantFiles files={FILES} onOpenFile={noop} error="   " />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(theList()).toBeDefined();
  });
});

describe('RelevantFiles privacy', () => {
  /** One silenced console method and the calls it recorded. */
  interface ConsoleSpy {
    method: (typeof CONSOLE_METHODS)[number];
    calls: () => number;
  }

  let spies: ConsoleSpy[] = [];

  // Installed per test and removed by the file-wide `vi.restoreAllMocks()`.
  beforeEach(() => {
    spies = CONSOLE_METHODS.map((method) => {
      const spy = vi.spyOn(console, method).mockImplementation(noop);
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

  it('writes nothing to the console while rendering and activating rows', async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn<(file: string) => void>();
    render(<RelevantFiles files={ASCENDING} onOpenFile={onOpenFile} />);

    await user.click(screen.getByRole('button', { name: 'src/modules/first/one.ts firstStep' }));
    await user.tab();
    await user.keyboard('{Enter}');

    expect(onOpenFile).toHaveBeenCalledTimes(2);
    expectConsoleSilent();
  });

  it('writes nothing to the console in the loading state', () => {
    render(<RelevantFiles files={ASCENDING} onOpenFile={noop} pending />);

    expect(screen.queryByRole('status')).not.toBeNull();
    expectConsoleSilent();
  });

  it('writes nothing to the console in the empty state', () => {
    render(<RelevantFiles files={[]} onOpenFile={noop} />);

    expect(screen.queryByRole('status')).not.toBeNull();
    expectConsoleSilent();
  });

  it('writes nothing to the console in the error state, including on retry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn<() => void>();
    render(
      <RelevantFiles
        files={ASCENDING}
        onOpenFile={noop}
        pending
        error="Investigation failed."
        onRetry={onRetry}
      />,
    );

    await user.click(within(screen.getByRole('alert')).getByRole('button'));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expectConsoleSilent();
  });
});
