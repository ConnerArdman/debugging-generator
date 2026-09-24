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
  it('renders one row per entry, in the given order, without re-sorting by score', () => {
    render(<RelevantFiles files={FILES} onOpenFile={noop} />);

    const items = within(theList()).getAllByRole('listitem');
    expect(items).toHaveLength(FILES.length);

    const renderedPaths = items.map(
      (item) => item.querySelector('.dgv-files__path')?.textContent ?? '',
    );
    expect(renderedPaths).toEqual(FILES.map((entry) => entry.file));
  });

  it('keeps ascending scores ascending: the ranking given is the order rendered', () => {
    render(<RelevantFiles files={ASCENDING} onOpenFile={noop} />);

    const items = within(theList()).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items.map((item) => partText(item, 'dgv-files__path'))).toEqual([
      'src/modules/first/one.ts',
      'src/modules/second/two.tsx',
      'src/modules/third/three.ts',
    ]);
    expect(items.map((item) => partText(item, 'dgv-files__score'))).toEqual([
      'Relevance score 0.10',
      'Relevance score 0.50',
      'Relevance score 0.95',
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
      const path = item.querySelector('.dgv-files__path');
      expect(path?.tagName).toBe('CODE');
      expect(path?.textContent).toBe(entry.file);
      expect(path?.getAttribute('title')).toBe(entry.file);

      expect(partText(item, 'dgv-files__reason')).toBe(entry.reason);
      expect(partText(item, 'dgv-files__score')).toBe(`Relevance score ${entry.score.toFixed(2)}`);

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
    expect(item.textContent).toBe(`src/modules/solo/module.tsRelevance score 0.30${entry.reason}`);

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
    expect(document.querySelector('.dgv-files__path')).toBeNull();
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
