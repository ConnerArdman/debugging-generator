/**
 * The contract of `components/ProgressSteps` — the live progress list of the
 * editor view (AAP 0.7.3), which must display exactly the `session.progress`
 * rows the host received and nothing else (AAP 0.5.4).
 *
 * A progress list is the easiest place in the product to fake a result, so
 * this suite makes "renders exactly what arrived, in the order it arrived"
 * mechanically true. Pinned here:
 *
 *   - **One-for-one fidelity.** Every given entry is on screen exactly once,
 *     compared as whole arrays: an input in a non-pipeline order is not
 *     re-sorted, unknown stages keep their arrival order, rows delivered twice
 *     are not de-duplicated, and nothing is padded in.
 *   - **The Step-8 shape.** Sections are contiguous runs headed by the
 *     service's own stage header rows — "Understanding problem" holding the
 *     investigation findings, "Preparing instrumentation" holding planning,
 *     the armed signals and "Ready to capture" — with no synthesised title; a
 *     follow-up's second plan and instrumentation appear after the follow-up.
 *   - **Verbatim text.** Messages and details render exactly as received.
 *   - **Direction controls are shown, never obeyed**: a U+202E/U+202C pair in
 *     a message, a detail line or a stage failure prints as visible escapes.
 *   - **Status markers.** Each status yields exactly one marker modifier, a
 *     decorative glyph hidden from assistive technology and an announced word;
 *     a failed stage is always drawn as failed (AAP 0.5.5).
 *   - **Notice rows.** A `done` row after the header of the capture or panel
 *     stage — incomplete evidence, an empty capture, the fallback banner — is
 *     drawn as a warning, never as a success check; headings and every other
 *     stage's `done` rows stay checks.
 *   - **The call to action** appears only while a capture is armed, and reads
 *     "again" instead of "now" only for a capture a follow-up requested.
 *   - **The live window.** Sections older than the latest six collapse to
 *     their heading behind a disclosure control and mount their rows only on
 *     request; a section holding a failure never collapses.
 *   - **Reconciliation.** Row elements survive a re-render with equal content,
 *     a running-to-done update and the host dropping its oldest rows.
 *   - **Host compaction.** When the host's bound shrinks older episodes to
 *     their header rows or drops them whole, every remaining section keeps
 *     the service header as its heading, and an expanded follow-up stays the
 *     expanded one even when rows labelled like its own leave before it.
 *   - **The three states** and their precedence: error > pending > empty, with
 *     arrived rows kept visible under an error or a pending pipeline.
 *   - **Silence.** No state writes to any console method, because progress
 *     lines can name the developer's own files (AAP 0.5.2).
 *
 * Environment: collected by the root Vitest project `vscode-extension-webview`
 * (happy-dom) and type-checked by `tsconfig.webview.json`. The harness is
 * imported explicitly and `cleanup` is run explicitly after every case, so the
 * suite is correct whether or not the project enables Vitest globals.
 *
 * Fixture messages are neutral vocabulary written for this suite; no inspected
 * project's names and no request paths appear in it (AAP 0.5.4).
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import type { ProgressEntry } from '../../webview-messages';

import { ProgressSteps } from './ProgressSteps';

/** The five console methods the component must never reach, in any state (AAP 0.5.2). */
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

/** The spies installed for the running case, keyed by the method they replace. */
let consoleSpies: ReadonlyArray<readonly [ConsoleMethod, MockInstance]> = [];

beforeEach(() => {
  // Replaced with a no-op so a stray write fails the case below with its
  // arguments, rather than scrolling past in the run output.
  consoleSpies = CONSOLE_METHODS.map(
    (method) => [method, vi.spyOn(console, method).mockImplementation(() => undefined)] as const,
  );
});

afterEach(() => {
  // The tree is unmounted first so the silence check also covers unmounting,
  // and the spies are restored even when that check fails, so one noisy case
  // cannot leak into the next.
  try {
    cleanup();
    for (const [method, spy] of consoleSpies) {
      expect(spy, `console.${method} must never be called`).not.toHaveBeenCalled();
    }
  } finally {
    consoleSpies = [];
    vi.restoreAllMocks();
  }
});

/**
 * A fixed receive time. The component keys rows by stage and receipt time
 * plus an occurrence count, so fixtures sharing this time still get distinct
 * keys; cases about identity across host compaction use the distinct
 * {@link stamped} times the host gives every row it holds instead.
 */
const TS = 1_700_000_000_000;

/** The empty-state sentence the component owns. */
const EMPTY_MESSAGE = 'No progress yet. Ask a question to start a session.';

/** The call to action while a capture is armed (AAP 0.7.3). */
const CTA_MESSAGE = 'Reproduce the issue now.';

/** The call to action while the capture a follow-up asked for is armed (AAP 0.4.2). */
const CTA_AGAIN_MESSAGE = 'Reproduce the issue again.';

/**
 * Builds one entry against the real {@link ProgressEntry} contract.
 *
 * Only `message` is required, so every case states the line it asserts on;
 * `stage`, `status` and `ts` default to neutral values. `detail` is present
 * only when a case supplies it, because `exactOptionalPropertyTypes` makes an
 * absent key and an `undefined` value two different things.
 *
 * @param overrides The fields the case cares about.
 * @returns The entry.
 */
function makeEntry(
  overrides: Partial<ProgressEntry> & Pick<ProgressEntry, 'message'>,
): ProgressEntry {
  return { stage: 'understand', status: 'done', ts: TS, ...overrides };
}

/** Entries in the order a session reports them, one stage after another. */
const SEQUENTIAL: readonly ProgressEntry[] = [
  makeEntry({ stage: 'understand', message: 'Read the question' }),
  makeEntry({ stage: 'understand', message: 'Resolved the selected element' }),
  makeEntry({
    stage: 'investigate',
    message: 'Located a request handler',
    detail: 'lib/sample/module.ts:42',
  }),
  makeEntry({ stage: 'plan', status: 'running', message: 'Choosing signals' }),
];

/**
 * The messages of a fixture, in fixture order — what the rows must read.
 *
 * @param entries The fixture.
 * @returns Each entry's message.
 */
function messagesOf(entries: readonly ProgressEntry[]): string[] {
  return entries.map((item) => item.message);
}

/**
 * The rendered row elements, in document order: every section heading and
 * every row beneath one, since both are drawn on the row grid.
 *
 * @param container The render container, or any part of it.
 * @returns Every `dgv-progress__row` element.
 */
function rows(container: ParentNode): Element[] {
  return Array.from(container.querySelectorAll('.dgv-progress__row'));
}

/**
 * The text each rendered row shows, in document order — a heading's title or
 * a row's label. One entry of the input is one line of the output.
 *
 * @param container The render container, or any part of it.
 * @returns Each row's text.
 */
function lines(container: ParentNode): string[] {
  return rows(container).map(
    (row) =>
      row.querySelector('.dgv-progress__label, .dgv-progress__group-title')?.textContent ?? '',
  );
}

/**
 * The rendered section headings, in document order.
 *
 * @param container The render container.
 * @returns Each section heading's title text.
 */
function headings(container: ParentNode): string[] {
  return Array.from(
    container.querySelectorAll('.dgv-progress__heading .dgv-progress__group-title'),
  ).map((node) => node.textContent ?? '');
}

/** One rendered section: its heading's title and its rows' labels. */
interface RenderedSection {
  readonly heading: string;
  readonly rows: readonly string[];
}

/**
 * The rendered sections, in document order.
 *
 * @param container The render container.
 * @returns Each section's heading and row labels.
 */
function sections(container: ParentNode): RenderedSection[] {
  return Array.from(container.querySelectorAll('.dgv-progress__group')).map((section) => ({
    heading: section.querySelector('.dgv-progress__group-title')?.textContent ?? '',
    rows: Array.from(section.querySelectorAll('.dgv-progress__rows .dgv-progress__label')).map(
      (node) => node.textContent ?? '',
    ),
  }));
}

/**
 * The first element matching a selector, failing the test when there is none.
 *
 * @param root Where to search.
 * @param selector The CSS selector.
 * @returns The element.
 */
function required(root: ParentNode, selector: string): Element {
  const found = root.querySelector(selector);
  expect(found, `expected an element matching ${selector}`).not.toBeNull();
  if (found === null) {
    throw new Error(`missing ${selector}`);
  }
  return found;
}

/**
 * The complete Step-8 progress of a first run, as the host holds it once every
 * stage header has settled in place (prompt §11, AAP 0.1.2): each stage's
 * header row carries the service's stage title, finding and signal rows follow
 * their stage's header, and "Ready to capture" closes instrumentation.
 */
const STEP_EIGHT: readonly ProgressEntry[] = [
  makeEntry({ stage: 'understand', message: 'Understanding problem' }),
  makeEntry({ stage: 'investigate', message: 'Investigating code' }),
  makeEntry({ stage: 'investigate', message: 'Found sample component' }),
  makeEntry({ stage: 'investigate', message: 'Traced event handler' }),
  makeEntry({ stage: 'investigate', message: 'Found sample route' }),
  makeEntry({ stage: 'investigate', message: 'Found database dependency' }),
  makeEntry({ stage: 'plan', message: 'Planning instrumentation' }),
  makeEntry({ stage: 'instrument', message: 'Preparing instrumentation' }),
  makeEntry({ stage: 'instrument', message: 'Browser performance' }),
  makeEntry({ stage: 'instrument', message: 'React renders' }),
  makeEntry({ stage: 'instrument', message: 'Network tracing' }),
  makeEntry({ stage: 'instrument', message: 'Server spans' }),
  makeEntry({ stage: 'instrument', message: 'Database tracing' }),
  makeEntry({ stage: 'instrument', message: 'Ready to capture' }),
];

/** The sections {@link STEP_EIGHT} must render as. */
const STEP_EIGHT_SECTIONS: readonly RenderedSection[] = [
  {
    heading: 'Understanding problem',
    rows: [
      'Investigating code',
      'Found sample component',
      'Traced event handler',
      'Found sample route',
      'Found database dependency',
    ],
  },
  {
    heading: 'Preparing instrumentation',
    rows: [
      'Planning instrumentation',
      'Browser performance',
      'React renders',
      'Network tracing',
      'Server spans',
      'Database tracing',
      'Ready to capture',
    ],
  },
];

/** What a first run adds after {@link STEP_EIGHT}, through the generated panel. */
const FIRST_RUN_TAIL: readonly ProgressEntry[] = [
  makeEntry({ stage: 'capture', message: 'Capturing runtime evidence' }),
  makeEntry({ stage: 'analyze', message: 'Analyzing captured evidence' }),
  makeEntry({ stage: 'generate-panel', message: 'Generating debugging panel' }),
];

/** A follow-up that needs a new capture, as the host appends it after the first run. */
const NEW_CAPTURE_FOLLOW_UP: readonly ProgressEntry[] = [
  makeEntry({ stage: 'followup', message: 'Evaluating follow-up question' }),
  makeEntry({ stage: 'plan', message: 'Planning instrumentation' }),
  makeEntry({ stage: 'instrument', message: 'Preparing instrumentation' }),
  makeEntry({ stage: 'instrument', message: 'Server spans' }),
  makeEntry({ stage: 'instrument', message: 'Ready to capture' }),
];

describe('ProgressSteps rows', () => {
  it('renders one row per entry, in the order given', () => {
    const { container } = render(<ProgressSteps entries={SEQUENTIAL} />);

    expect(rows(container)).toHaveLength(SEQUENTIAL.length);
    expect(lines(container)).toEqual(messagesOf(SEQUENTIAL));
  });

  it('does not re-sort an input that is out of pipeline order', () => {
    const outOfOrder: readonly ProgressEntry[] = [
      makeEntry({ stage: 'analyze', message: 'Summarised the capture' }),
      makeEntry({ stage: 'understand', message: 'Read the question' }),
      makeEntry({ stage: 'plan', status: 'failed', message: 'No adapter accepted the plan' }),
    ];
    const { container } = render(<ProgressSteps entries={outOfOrder} />);

    expect(headings(container)).toEqual(messagesOf(outOfOrder));
    expect(lines(container)).toEqual(messagesOf(outOfOrder));
  });

  it('opens a new section when a stage reports again after another, keeping arrival order', () => {
    const interleaved: readonly ProgressEntry[] = [
      makeEntry({ stage: 'capture', message: 'first' }),
      makeEntry({ stage: 'analyze', status: 'running', message: 'second' }),
      makeEntry({ stage: 'capture', message: 'third' }),
    ];
    const { container } = render(<ProgressSteps entries={interleaved} />);

    expect(sections(container)).toEqual([
      { heading: 'first', rows: [] },
      { heading: 'second', rows: [] },
      { heading: 'third', rows: [] },
    ]);
    // Nothing dropped, nothing added, nothing moved.
    expect(lines(container)).toEqual(messagesOf(interleaved));
  });

  it('gives unknown stages sections of their own, in the order they arrived', () => {
    const unknown: readonly ProgressEntry[] = [
      makeEntry({ stage: 'custom-step', message: 'Alpha' }),
      makeEntry({ stage: 'custom-step', message: 'Beta' }),
      makeEntry({ stage: 'another_step', message: 'Gamma' }),
      makeEntry({ stage: 'custom-step', message: 'Delta' }),
    ];
    const { container } = render(<ProgressSteps entries={unknown} />);

    expect(sections(container)).toEqual([
      { heading: 'Alpha', rows: ['Beta'] },
      { heading: 'Gamma', rows: [] },
      { heading: 'Delta', rows: [] },
    ]);
    expect(lines(container)).toEqual(messagesOf(unknown));
  });

  it('keeps rows that the host delivered twice rather than de-duplicating them', () => {
    const repeated: readonly ProgressEntry[] = [
      makeEntry({ stage: 'capture', status: 'running', message: 'Listening' }),
      makeEntry({ stage: 'capture', status: 'running', message: 'Listening' }),
    ];
    const { container } = render(<ProgressSteps entries={repeated} />);

    expect(lines(container)).toEqual(messagesOf(repeated));
  });

  it('renders a single entry as exactly one heading, with nothing padded around it', () => {
    const only = makeEntry({ stage: 'understand', message: 'Read the question' });
    const { container } = render(<ProgressSteps entries={[only]} />);

    expect(rows(container)).toHaveLength(1);
    expect(headings(container)).toEqual([only.message]);
    expect(container.querySelectorAll('.dgv-progress__group')).toHaveLength(1);
    expect(container.querySelectorAll('.dgv-progress__marker')).toHaveLength(1);
    // One section item and no rows list: no placeholder or "pending" step.
    const groupsList = screen.getByRole('list', { name: 'Session progress' });
    expect(within(groupsList).getAllByRole('listitem')).toHaveLength(1);
    expect(container.querySelector('.dgv-progress__rows')).toBeNull();
    // No state affordance and no call to action beside the one row.
    expect(container.querySelector('.dg-loading-state')).toBeNull();
    expect(container.querySelector('.dg-empty-state')).toBeNull();
    expect(container.querySelector('.dgv-progress__cta')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    // Every character on screen is accounted for by the one entry: its
    // marker's glyph and announced word, and its message. No title is made up.
    expect(container.textContent).toBe(`✓Done${only.message}`);
  });

  it('renders messages and details verbatim, in headings and rows alike', () => {
    const odd = makeEntry({
      stage: 'instrument',
      message: '  lower-case start, mIxEd CaSe, `code`, “quotes”; and  double  spaces… ',
      detail: 'x/Y.ts:12 — (see below)',
    });
    const oddRow = makeEntry({
      stage: 'instrument',
      message: ' another  line, with   runs of spaces ',
      detail: '  trailing detail ',
    });
    const { container } = render(<ProgressSteps entries={[odd, oddRow]} />);

    const heading = required(container, '.dgv-progress__heading');
    expect(required(heading, '.dgv-progress__group-title').textContent).toBe(odd.message);
    expect(required(heading, '.dgv-progress__detail').textContent).toBe(odd.detail);
    const row = required(container, '.dgv-progress__rows .dgv-progress__row');
    expect(required(row, '.dgv-progress__label').textContent).toBe(oddRow.message);
    expect(required(row, '.dgv-progress__detail').textContent).toBe(oddRow.detail);
  });

  it('renders the detail line only when the entry carries one', () => {
    const { container } = render(<ProgressSteps entries={SEQUENTIAL} />);

    const details = Array.from(container.querySelectorAll('.dgv-progress__detail'));
    expect(details.map((node) => node.textContent)).toEqual(['lib/sample/module.ts:42']);
    const rendered = rows(container);
    expect(rendered[2]?.querySelector('.dgv-progress__detail')).not.toBeNull();
    expect(rendered[0]?.querySelector('.dgv-progress__detail')).toBeNull();
    expect(rendered[1]?.querySelector('.dgv-progress__detail')).toBeNull();
    expect(rendered[3]?.querySelector('.dgv-progress__detail')).toBeNull();
  });

  it('never synthesises a title: a section is headed by a row the service sent', () => {
    const { container } = render(
      <ProgressSteps
        entries={[makeEntry({ stage: 'generate-panel', status: 'running', message: 'Composing' })]}
      />,
    );

    expect(headings(container)).toEqual(['Composing']);
    expect(container.textContent).not.toContain('Generate panel');
  });

  it('shows a new row only when new props arrive', () => {
    const { container, rerender } = render(<ProgressSteps entries={SEQUENTIAL.slice(0, 2)} />);
    expect(lines(container)).toEqual(messagesOf(SEQUENTIAL.slice(0, 2)));

    rerender(<ProgressSteps entries={SEQUENTIAL} />);
    expect(lines(container)).toEqual(messagesOf(SEQUENTIAL));
  });
});

describe('ProgressSteps Step-8 sections', () => {
  it('heads each section with the service header row and composes the findings under it', () => {
    const { container } = render(<ProgressSteps entries={STEP_EIGHT} />);

    expect(sections(container)).toEqual(STEP_EIGHT_SECTIONS);
    // Every entry is on screen exactly once.
    expect(rows(container)).toHaveLength(STEP_EIGHT.length);
    // Each heading is the header row itself, marker and all.
    const headingRows = Array.from(container.querySelectorAll('.dgv-progress__heading'));
    expect(headingRows).toHaveLength(2);
    for (const heading of headingRows) {
      expect(required(heading, '.dgv-progress__marker--done')).toBeDefined();
      expect(required(heading, '.dg-visually-hidden').textContent).toBe('Done');
    }
    // No generic stage names are invented beside the service's titles.
    for (const synthesised of ['Understand', 'Investigate', 'Plan', 'Instrument']) {
      expect(lines(container)).not.toContain(synthesised);
      expect(headings(container)).not.toContain(synthesised);
    }
  });

  it('names each rows list by its section heading', () => {
    render(<ProgressSteps entries={STEP_EIGHT} />);

    const understanding = screen.getByRole('list', { name: 'Understanding problem' });
    expect(understanding.tagName).toBe('OL');
    expect(within(understanding).getAllByRole('listitem')).toHaveLength(5);
    const preparing = screen.getByRole('list', { name: 'Preparing instrumentation' });
    expect(within(preparing).getAllByRole('listitem')).toHaveLength(7);
  });

  it('heads a section by its first row until the lead stage reports, then by the lead header', () => {
    const early: readonly ProgressEntry[] = [
      makeEntry({ stage: 'understand', message: 'Understanding problem' }),
      makeEntry({ stage: 'investigate', message: 'Investigating code' }),
      makeEntry({ stage: 'plan', status: 'running', message: 'Planning instrumentation' }),
    ];
    const { container, rerender } = render(<ProgressSteps entries={early} />);
    expect(sections(container)).toEqual([
      { heading: 'Understanding problem', rows: ['Investigating code'] },
      { heading: 'Planning instrumentation', rows: [] },
    ]);

    const later: readonly ProgressEntry[] = [
      ...early,
      makeEntry({ stage: 'instrument', status: 'running', message: 'Preparing instrumentation' }),
    ];
    rerender(<ProgressSteps entries={later} />);
    expect(sections(container)).toEqual([
      { heading: 'Understanding problem', rows: ['Investigating code'] },
      { heading: 'Preparing instrumentation', rows: ['Planning instrumentation'] },
    ]);
  });

  it('draws a follow-up capture after the follow-up: generated, follow-up, planning, ready', async () => {
    const user = userEvent.setup();
    const entries = [...STEP_EIGHT, ...FIRST_RUN_TAIL, ...NEW_CAPTURE_FOLLOW_UP];
    const { container } = render(<ProgressSteps entries={entries} />);
    // Seven sections: the oldest is past the live window, so it opens on request.
    await user.click(screen.getByRole('button', { name: 'Show 5 steps' }));

    expect(headings(container)).toEqual([
      'Understanding problem',
      'Preparing instrumentation',
      'Capturing runtime evidence',
      'Analyzing captured evidence',
      'Generating debugging panel',
      'Evaluating follow-up question',
      'Preparing instrumentation',
    ]);
    expect(sections(container).at(-1)).toEqual({
      heading: 'Preparing instrumentation',
      rows: ['Planning instrumentation', 'Server spans', 'Ready to capture'],
    });
    // Chronological: the second plan and readiness come after the follow-up.
    const shown = lines(container);
    const generated = shown.indexOf('Generating debugging panel');
    const followUp = shown.indexOf('Evaluating follow-up question');
    const replanned = shown.lastIndexOf('Planning instrumentation');
    const ready = shown.lastIndexOf('Ready to capture');
    expect(generated).toBeLessThan(followUp);
    expect(followUp).toBeLessThan(replanned);
    expect(replanned).toBeLessThan(ready);
    // The first run's sections are unchanged by the follow-up.
    expect(sections(container).slice(0, 2)).toEqual(STEP_EIGHT_SECTIONS);
    expect(rows(container)).toHaveLength(entries.length);
  });
});

/**
 * A session with `count` sections, each a heading and one row, alternating
 * between two stages so that every pair of neighbours is a new section.
 *
 * @param count How many sections to produce.
 * @returns The entries in arrival order.
 */
function alternatingSections(count: number): ProgressEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const stage = index % 2 === 0 ? 'capture' : 'analyze';
    return [
      makeEntry({ stage, message: `Stage run ${String(index)}` }),
      makeEntry({ stage, message: `Observation ${String(index)}` }),
    ];
  }).flat();
}

/** The live window `ProgressSteps` keeps fully drawn (`LIVE_SECTION_WINDOW`). */
const LIVE_SECTION_WINDOW = 6;

describe('ProgressSteps live window', () => {
  it('draws every section in full while the session fits the live window', () => {
    const { container } = render(
      <ProgressSteps entries={alternatingSections(LIVE_SECTION_WINDOW)} />,
    );

    expect(screen.queryByRole('button')).toBeNull();
    expect(rows(container)).toHaveLength(LIVE_SECTION_WINDOW * 2);
  });

  it('collapses older sections to their heading and mounts their rows only on request', async () => {
    const user = userEvent.setup();
    const entries = alternatingSections(LIVE_SECTION_WINDOW + 2);
    const { container } = render(<ProgressSteps entries={entries} />);

    // Every heading stays on screen, in order; the two oldest sections hide their rows.
    expect(headings(container)).toHaveLength(LIVE_SECTION_WINDOW + 2);
    expect(sections(container).slice(0, 3)).toEqual([
      { heading: 'Stage run 0', rows: [] },
      { heading: 'Stage run 1', rows: [] },
      { heading: 'Stage run 2', rows: ['Observation 2'] },
    ]);
    expect(lines(container)).not.toContain('Observation 0');
    expect(screen.queryByRole('list', { name: 'Stage run 0' })).toBeNull();

    const toggles = screen.getAllByRole('button', { name: 'Show 1 step' });
    expect(toggles).toHaveLength(2);
    const [oldest] = toggles;
    if (oldest === undefined) {
      throw new Error('missing the oldest section toggle');
    }
    expect(oldest.getAttribute('aria-expanded')).toBe('false');
    // Collapsed, the rows list is not mounted, so the control names no element.
    expect(oldest.hasAttribute('aria-controls')).toBe(false);
    expect(oldest.closest('.dgv-progress__group')?.textContent).toContain('Stage run 0');

    await user.click(oldest);
    expect(oldest.getAttribute('aria-expanded')).toBe('true');
    expect(oldest.textContent).toBe('Hide steps');
    const opened = screen.getByRole('list', { name: 'Stage run 0' });
    const controlled = oldest.getAttribute('aria-controls') ?? '';
    expect(controlled).not.toBe('');
    expect(opened.id).toBe(controlled);
    expect(within(opened).getAllByRole('listitem')).toHaveLength(1);
    expect(sections(container)[0]).toEqual({ heading: 'Stage run 0', rows: ['Observation 0'] });
    // Only the section asked for opened.
    expect(sections(container)[1]).toEqual({ heading: 'Stage run 1', rows: [] });

    await user.click(oldest);
    expect(oldest.getAttribute('aria-expanded')).toBe('false');
    expect(oldest.hasAttribute('aria-controls')).toBe(false);
    expect(screen.queryByRole('list', { name: 'Stage run 0' })).toBeNull();
  });

  it('counts the hidden rows in the control', () => {
    const entries = [...STEP_EIGHT, ...alternatingSections(LIVE_SECTION_WINDOW)];
    render(<ProgressSteps entries={entries} />);

    expect(screen.getByRole('button', { name: 'Show 5 steps' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Show 7 steps' })).toBeDefined();
  });

  it('never collapses an older section that holds a failed row', () => {
    const entries: ProgressEntry[] = [
      makeEntry({ stage: 'plan', message: 'Planning instrumentation' }),
      makeEntry({ stage: 'plan', status: 'failed', message: 'No adapter accepted the plan' }),
      ...alternatingSections(LIVE_SECTION_WINDOW),
    ];
    const { container } = render(<ProgressSteps entries={entries} />);

    expect(sections(container)[0]).toEqual({
      heading: 'Planning instrumentation',
      rows: ['No adapter accepted the plan'],
    });
    const failedSection = container.querySelector('.dgv-progress__group');
    expect(failedSection?.querySelector('button')).toBeNull();
    expect(failedSection?.querySelector('.dgv-progress__marker--failed')).not.toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('never collapses an older section whose heading failed', () => {
    const entries: ProgressEntry[] = [
      makeEntry({ stage: 'analyze', status: 'failed', message: 'Could not summarise' }),
      makeEntry({ stage: 'analyze', message: 'Partial observation' }),
      ...alternatingSections(LIVE_SECTION_WINDOW),
    ];
    const { container } = render(<ProgressSteps entries={entries} />);

    expect(sections(container)[0]).toEqual({
      heading: 'Could not summarise',
      rows: ['Partial observation'],
    });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers no control for an older section that has no rows beyond its heading', () => {
    const entries: ProgressEntry[] = [
      makeEntry({ stage: 'followup', message: 'Evaluating follow-up question' }),
      ...alternatingSections(LIVE_SECTION_WINDOW),
    ];
    const { container } = render(<ProgressSteps entries={entries} />);

    expect(sections(container)[0]).toEqual({ heading: 'Evaluating follow-up question', rows: [] });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps an expanded section open as new rows arrive, and forgets it across sessions', async () => {
    const user = userEvent.setup();
    const entries = alternatingSections(LIVE_SECTION_WINDOW + 1);
    const { container, rerender } = render(<ProgressSteps entries={entries} />);
    await user.click(screen.getByRole('button', { name: 'Show 1 step' }));

    rerender(
      <ProgressSteps entries={[...entries, makeEntry({ stage: 'capture', message: 'Later' })]} />,
    );
    expect(sections(container)[0]).toEqual({ heading: 'Stage run 0', rows: ['Observation 0'] });

    // The host clears the list when another session starts or is reopened.
    rerender(<ProgressSteps entries={[]} />);
    rerender(<ProgressSteps entries={entries} />);
    expect(sections(container)[0]).toEqual({ heading: 'Stage run 0', rows: [] });
    expect(screen.getByRole('button', { name: 'Show 1 step' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
  });
});

describe('ProgressSteps reconciliation', () => {
  it('keeps every row element across a re-render with equal content', () => {
    const { container, rerender } = render(<ProgressSteps entries={STEP_EIGHT} />);
    const before = rows(container);

    // The host posts a fresh structured clone with every snapshot.
    rerender(<ProgressSteps entries={structuredClone(STEP_EIGHT)} />);

    const after = rows(container);
    expect(after).toHaveLength(before.length);
    after.forEach((element, index) => {
      expect(element).toBe(before[index]);
    });
  });

  it('updates a row in place when it moves from running to done', () => {
    const header = makeEntry({ stage: 'understand', message: 'Understanding problem' });
    const { container, rerender } = render(
      <ProgressSteps
        entries={[
          header,
          makeEntry({ stage: 'investigate', status: 'running', message: 'Investigating code' }),
        ]}
      />,
    );
    const row = required(container, '.dgv-progress__rows .dgv-progress__row');
    expect(row.querySelector('.dgv-progress__marker--running')).not.toBeNull();

    rerender(
      <ProgressSteps
        entries={[
          header,
          makeEntry({ stage: 'investigate', message: 'Investigating code' }),
          makeEntry({ stage: 'investigate', message: 'Found sample component' }),
        ]}
      />,
    );

    expect(required(container, '.dgv-progress__rows .dgv-progress__row')).toBe(row);
    expect(row.querySelector('.dgv-progress__marker--done')).not.toBeNull();
    expect(row.querySelector('.dgv-progress__marker--running')).toBeNull();
  });

  it('keeps a row mounted when the host settles it in place under a new message', () => {
    const header = makeEntry({
      stage: 'instrument',
      status: 'running',
      message: 'Preparing instrumentation',
      ts: TS,
    });
    const signal = makeEntry({ stage: 'instrument', message: 'Browser performance', ts: TS + 1 });
    const { container, rerender } = render(<ProgressSteps entries={[header, signal]} />);
    const heading = required(container, '.dgv-progress__heading');
    const row = required(container, '.dgv-progress__rows .dgv-progress__row');
    expect(heading.querySelector('.dgv-progress__marker--running')).not.toBeNull();

    // The host replaced the header in place: same stage and receipt time, the
    // failed stage's own wording and status.
    rerender(
      <ProgressSteps
        entries={[
          {
            ...header,
            status: 'failed',
            message:
              'Preparing instrumentation failed: The planned instrumentation is not available here.',
          },
          signal,
        ]}
      />,
    );

    expect(required(container, '.dgv-progress__heading')).toBe(heading);
    expect(required(container, '.dgv-progress__rows .dgv-progress__row')).toBe(row);
    expect(heading.querySelector('.dgv-progress__marker--failed')).not.toBeNull();
    expect(heading.querySelector('.dgv-progress__marker--running')).toBeNull();
    expect(headings(container)).toEqual([
      'Preparing instrumentation failed: The planned instrumentation is not available here.',
    ]);
    expect(rows(container)).toHaveLength(2);
  });

  it('keeps the remaining rows mounted when the host drops the oldest ones', () => {
    // Stamped as the host holds them: every row a distinct receipt time.
    const entries = stamped(alternatingSections(3));
    const { container, rerender } = render(<ProgressSteps entries={entries} />);
    // The rows of the second and third sections: everything after the first section.
    const kept = rows(container).slice(2);

    // The host's bound drops the oldest rows first; here, the whole first section.
    rerender(<ProgressSteps entries={entries.slice(2)} />);

    const after = rows(container);
    expect(after).toHaveLength(kept.length);
    after.forEach((element, index) => {
      expect(element).toBe(kept[index]);
    });
  });

  it('keeps earlier sections mounted when a follow-up appends new ones', () => {
    const firstRun = [...STEP_EIGHT, ...FIRST_RUN_TAIL];
    const { container, rerender } = render(<ProgressSteps entries={firstRun} />);
    const firstHeading = required(container, '.dgv-progress__heading');

    rerender(<ProgressSteps entries={[...firstRun, ...NEW_CAPTURE_FOLLOW_UP]} />);

    expect(required(container, '.dgv-progress__heading')).toBe(firstHeading);
  });
});

/**
 * Stamps entries with the distinct, increasing receipt times the host gives
 * the rows it holds (`../../state.ts`), in list order.
 *
 * @param entries The entries, in arrival order.
 * @returns Copies carrying `TS`, `TS + 1`, … as their receipt times.
 */
function stamped(entries: readonly ProgressEntry[]): ProgressEntry[] {
  return entries.map((entry, index) => ({ ...entry, ts: TS + index }));
}

/**
 * A new-capture follow-up whose instrumentation reports one signal row naming
 * the follow-up, so each follow-up's section is recognisable on screen.
 *
 * @param cycle Which follow-up this is, from 1.
 * @returns Its entries, in arrival order.
 */
function numberedFollowUp(cycle: number): ProgressEntry[] {
  return [
    makeEntry({ stage: 'followup', message: 'Evaluating follow-up question' }),
    makeEntry({ stage: 'plan', message: 'Planning instrumentation' }),
    makeEntry({ stage: 'instrument', message: 'Preparing instrumentation' }),
    makeEntry({
      stage: 'instrument',
      message: 'Function timing',
      detail: `Follow-up ${String(cycle)}`,
    }),
    makeEntry({ stage: 'instrument', message: 'Ready to capture' }),
  ];
}

/**
 * A first run followed by five new-capture follow-ups, stamped as the host
 * holds them: fifteen sections, of which the nine oldest are collapsed.
 */
const LONG_SESSION: readonly ProgressEntry[] = stamped([
  ...STEP_EIGHT,
  ...FIRST_RUN_TAIL,
  ...[1, 2, 3, 4, 5].flatMap(numberedFollowUp),
]);

/** How many entries of {@link LONG_SESSION} its first run holds. */
const LONG_SESSION_FIRST_RUN = STEP_EIGHT.length + FIRST_RUN_TAIL.length;

/**
 * The section a follow-up's instrumentation renders as: the one whose text
 * names that follow-up, when its rows are mounted.
 *
 * @param container The render container.
 * @param cycle Which follow-up.
 * @returns The section element, or `undefined` when no mounted row names it.
 */
function followUpSection(container: ParentNode, cycle: number): Element | undefined {
  return Array.from(container.querySelectorAll('.dgv-progress__group')).find((section) =>
    (section.textContent ?? '').includes(`Follow-up ${String(cycle)}`),
  );
}

describe('ProgressSteps across host compaction', () => {
  it('keeps a follow-up expanded when the host drops older episodes with the same labels', async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(<ProgressSteps entries={LONG_SESSION} />);

    // The first and second follow-ups' instrumentation sections are collapsed.
    const collapsed = screen.getAllByRole('button', { name: 'Show 3 steps' });
    expect(collapsed).toHaveLength(2);
    const [firstFollowUp, secondFollowUp] = collapsed;
    if (firstFollowUp === undefined || secondFollowUp === undefined) {
      throw new Error('missing the follow-up section toggles');
    }
    await user.click(secondFollowUp);
    const opened = followUpSection(container, 2);
    expect(opened).toBeDefined();
    const openedHeading = opened?.querySelector('.dgv-progress__heading');
    expect(followUpSection(container, 1)).toBeUndefined();

    // The host's bound drops the first run's understanding and instrumentation
    // episodes whole — rows labelled exactly like every follow-up's own.
    rerender(<ProgressSteps entries={LONG_SESSION.slice(STEP_EIGHT.length)} />);

    // The same follow-up is still the expanded one, drawn by the same elements.
    const stillOpen = followUpSection(container, 2);
    expect(stillOpen).toBe(opened);
    expect(stillOpen?.querySelector('.dgv-progress__heading')).toBe(openedHeading);
    expect(secondFollowUp.getAttribute('aria-expanded')).toBe('true');
    // No other follow-up took over its disclosure.
    expect(followUpSection(container, 1)).toBeUndefined();
    expect(firstFollowUp.getAttribute('aria-expanded')).toBe('false');
    const stillCollapsed = screen.getAllByRole('button', { name: 'Show 3 steps' });
    expect(stillCollapsed).toHaveLength(1);
    expect(stillCollapsed[0]).toBe(firstFollowUp);
  });

  it('keeps the service header of every compacted section as its heading', async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(<ProgressSteps entries={LONG_SESSION} />);
    const before = headings(container);

    // The host compacts the first run's episodes to their header rows.
    const serviceHeaders = new Set([
      'Understanding problem',
      'Investigating code',
      'Planning instrumentation',
      'Preparing instrumentation',
    ]);
    const compacted = LONG_SESSION.filter(
      (entry, index) =>
        index >= LONG_SESSION_FIRST_RUN ||
        !(
          ['understand', 'investigate', 'plan', 'instrument'].includes(entry.stage) &&
          !serviceHeaders.has(entry.message)
        ),
    );
    rerender(<ProgressSteps entries={compacted} />);

    expect(headings(container)).toEqual(before);
    expect(headings(container)).not.toContain('Found sample component');
    const summaries = screen.getAllByRole('button', { name: 'Show 1 step' });
    expect(summaries).toHaveLength(2);
    for (const summary of summaries) {
      await user.click(summary);
    }
    expect(sections(container).slice(0, 2)).toEqual([
      { heading: 'Understanding problem', rows: ['Investigating code'] },
      { heading: 'Preparing instrumentation', rows: ['Planning instrumentation'] },
    ]);

    // Once the understanding episode leaves whole, the next section is headed
    // by its own service header, never by a finding.
    rerender(<ProgressSteps entries={compacted.slice(1)} />);
    expect(headings(container)[0]).toBe('Investigating code');
  });
});

describe('ProgressSteps status markers', () => {
  const MODIFIERS = [
    'dgv-progress__marker--running',
    'dgv-progress__marker--done',
    'dgv-progress__marker--failed',
    'dgv-progress__marker--warning',
  ] as const;

  it.each([
    ['running', 'dgv-progress__marker--running', 'In progress'],
    ['done', 'dgv-progress__marker--done', 'Done'],
    ['failed', 'dgv-progress__marker--failed', 'Failed'],
  ] as const)('draws a %s entry with exactly its own modifier', (status, modifier, spoken) => {
    const { container } = render(
      <ProgressSteps entries={[makeEntry({ stage: 'plan', status, message: 'A step' })]} />,
    );

    const marker = required(container, '.dgv-progress__marker');
    expect(marker.classList.contains('dgv-progress__marker')).toBe(true);
    const present = MODIFIERS.filter((name) => marker.classList.contains(name));
    expect(present).toEqual([modifier]);

    // The status is announced in words, not carried by colour alone: the
    // marker's accessible text is non-empty, names the status, and sits
    // outside the glyph that assistive technology is told to skip.
    const spokenNode = required(marker, '.dg-visually-hidden');
    const spokenText = spokenNode.textContent ?? '';
    expect(spokenText.trim()).not.toBe('');
    expect(spokenText).toBe(spoken);
    const glyph = required(marker, '[aria-hidden="true"]');
    expect(glyph.contains(spokenNode)).toBe(false);
  });

  it('draws a check, a cross and a spinner as decoration', () => {
    const { container } = render(
      <ProgressSteps
        entries={[
          makeEntry({ stage: 'plan', status: 'done', message: 'one' }),
          makeEntry({ stage: 'plan', status: 'failed', message: 'two' }),
          makeEntry({ stage: 'plan', status: 'running', message: 'three' }),
        ]}
      />,
    );

    const glyphs = Array.from(
      container.querySelectorAll('.dgv-progress__marker > [aria-hidden="true"]'),
    );
    expect(glyphs.map((node) => node.textContent)).toEqual(['✓', '✕', '']);
    expect(glyphs[2]?.querySelector('.dg-spinner')).not.toBeNull();
  });

  it('draws a failed entry as failed, never as done', () => {
    const { container } = render(
      <ProgressSteps
        entries={[
          makeEntry({ stage: 'analyze', status: 'failed', message: 'Could not summarise' }),
        ]}
      />,
    );

    expect(container.querySelectorAll('.dgv-progress__marker--failed')).toHaveLength(1);
    expect(container.querySelector('.dgv-progress__marker--done')).toBeNull();
    expect(lines(container)).toEqual(['Could not summarise']);
  });

  it('does not raise a page-level alert for a failed row on its own', () => {
    render(
      <ProgressSteps
        entries={[
          makeEntry({ stage: 'analyze', status: 'failed', message: 'Could not summarise' }),
        ]}
      />,
    );

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Could not summarise')).toBeDefined();
  });
});

describe('ProgressSteps notice rows', () => {
  /** The capture stage's header row, settled: the stage title. */
  const CAPTURE_HEADER = 'Capturing runtime evidence';

  /** The panel stage's header row, settled: the stage title. */
  const PANEL_HEADER = 'Generating debugging panel';

  /** The service's notice about incomplete evidence, sent as a `done` capture row. */
  const INCOMPLETE_EVIDENCE = 'Capture evidence is incomplete. Some events were dropped.';

  /** The empty-capture sentence, which closes the capture group in place of its title (AAP 0.5.5). */
  const EMPTY_CAPTURE =
    'No telemetry was captured. Interact with the page while capture is running, then Capture again.';

  /** The fallback-panel banner, sent as a `done` panel row (AAP 0.5.5). */
  const FALLBACK_BANNER =
    'Generated panel failed validation; showing a fallback view built from captured data.';

  /**
   * The marker of the rendered row or heading whose text is `label`.
   *
   * @param container The render container.
   * @param label The row's message.
   * @returns The row's marker element.
   */
  function markerOf(container: ParentNode, label: string): Element {
    const row = rows(container).find(
      (candidate) =>
        candidate.querySelector('.dgv-progress__label, .dgv-progress__group-title')?.textContent ===
        label,
    );
    expect(row, `expected a row reading "${label}"`).toBeDefined();
    if (row === undefined) {
      throw new Error(`missing row "${label}"`);
    }
    return required(row, '.dgv-progress__marker');
  }

  /**
   * The marker modifiers an element carries, of the four the component draws.
   *
   * @param marker A marker element.
   * @returns Its modifiers.
   */
  function modifiersOf(marker: Element): string[] {
    return Array.from(marker.classList).filter((name) => name.startsWith('dgv-progress__marker--'));
  }

  it('draws a done capture row after the header as a warning, with its own glyph and word', () => {
    const { container } = render(
      <ProgressSteps
        entries={[
          makeEntry({ stage: 'capture', message: CAPTURE_HEADER }),
          makeEntry({ stage: 'capture', message: INCOMPLETE_EVIDENCE }),
        ]}
      />,
    );

    const marker = markerOf(container, INCOMPLETE_EVIDENCE);
    expect(modifiersOf(marker)).toEqual(['dgv-progress__marker--warning']);
    expect(required(marker, '[aria-hidden="true"]').textContent).toBe('!');
    const spoken = required(marker, '.dg-visually-hidden');
    expect(spoken.textContent).toBe('Warning');
    expect(required(marker, '[aria-hidden="true"]').contains(spoken)).toBe(false);
    // The notice is rendered verbatim, never re-worded.
    expect(lines(container)).toEqual([CAPTURE_HEADER, INCOMPLETE_EVIDENCE]);
  });

  it('keeps the capture header row a done check', () => {
    const { container } = render(
      <ProgressSteps
        entries={[
          makeEntry({ stage: 'capture', message: CAPTURE_HEADER }),
          makeEntry({ stage: 'capture', message: INCOMPLETE_EVIDENCE }),
        ]}
      />,
    );

    expect(modifiersOf(markerOf(container, CAPTURE_HEADER))).toEqual([
      'dgv-progress__marker--done',
    ]);
  });

  it('draws the empty-capture sentence that closes the group as a warning', () => {
    const { container } = render(
      <ProgressSteps
        entries={[
          makeEntry({ stage: 'capture', message: CAPTURE_HEADER }),
          makeEntry({ stage: 'capture', message: EMPTY_CAPTURE }),
        ]}
      />,
    );

    expect(modifiersOf(markerOf(container, EMPTY_CAPTURE))).toEqual([
      'dgv-progress__marker--warning',
    ]);
  });

  it('draws the fallback-panel banner as a warning under a done panel header', () => {
    const { container } = render(
      <ProgressSteps
        entries={[
          makeEntry({ stage: 'generate-panel', message: PANEL_HEADER }),
          makeEntry({ stage: 'generate-panel', message: FALLBACK_BANNER }),
        ]}
      />,
    );

    expect(modifiersOf(markerOf(container, FALLBACK_BANNER))).toEqual([
      'dgv-progress__marker--warning',
    ]);
    expect(modifiersOf(markerOf(container, PANEL_HEADER))).toEqual(['dgv-progress__marker--done']);
  });

  it('keeps the done findings of every other stage done checks', () => {
    const { container } = render(<ProgressSteps entries={[...STEP_EIGHT, ...FIRST_RUN_TAIL]} />);

    expect(container.querySelector('.dgv-progress__marker--warning')).toBeNull();
    expect(modifiersOf(markerOf(container, 'Found sample component'))).toEqual([
      'dgv-progress__marker--done',
    ]);
    expect(modifiersOf(markerOf(container, 'Ready to capture'))).toEqual([
      'dgv-progress__marker--done',
    ]);
  });

  it('keeps failed and running rows of a notice stage failed and running', () => {
    const { container } = render(
      <ProgressSteps
        entries={[
          makeEntry({ stage: 'capture', status: 'running', message: CAPTURE_HEADER }),
          makeEntry({ stage: 'capture', status: 'running', message: 'Listening for events' }),
          makeEntry({ stage: 'capture', status: 'failed', message: 'Capture stopped early' }),
          makeEntry({ stage: 'generate-panel', status: 'failed', message: 'Panel not stored' }),
        ]}
      />,
    );

    expect(modifiersOf(markerOf(container, 'Listening for events'))).toEqual([
      'dgv-progress__marker--running',
    ]);
    expect(modifiersOf(markerOf(container, 'Capture stopped early'))).toEqual([
      'dgv-progress__marker--failed',
    ]);
    expect(modifiersOf(markerOf(container, 'Panel not stored'))).toEqual([
      'dgv-progress__marker--failed',
    ]);
    expect(container.querySelector('.dgv-progress__marker--warning')).toBeNull();
  });
});

describe('ProgressSteps semantics', () => {
  it('uses ordered lists, a polite live region and title-named row lists', () => {
    const { container } = render(<ProgressSteps entries={SEQUENTIAL} />);

    const groupsList = required(container, '.dgv-progress__groups');
    expect(groupsList.tagName).toBe('OL');
    expect(groupsList.getAttribute('aria-live')).toBe('polite');

    // The first section is headed by its first row, which names the rows below it.
    const understandRows = screen.getByRole('list', { name: 'Read the question' });
    expect(understandRows.tagName).toBe('OL');
    expect(within(understandRows).getAllByRole('listitem')).toHaveLength(2);
  });

  it('keeps the list a polite region, never an assertive alert', () => {
    const { container } = render(
      <ProgressSteps
        entries={[
          ...SEQUENTIAL,
          makeEntry({ stage: 'plan', status: 'failed', message: 'Plan rejected' }),
        ]}
      />,
    );

    const groupsList = required(container, '.dgv-progress__groups');
    expect(groupsList.getAttribute('role')).not.toBe('alert');
    expect(groupsList.getAttribute('aria-live')).not.toBe('assertive');
    expect(groupsList.closest('[role="alert"]')).toBeNull();
    expect(groupsList.querySelector('[role="alert"]')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders no heading element', () => {
    const { container } = render(<ProgressSteps entries={SEQUENTIAL} captureArmed />);

    expect(container.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
  });

  it('composes the caller class after its own on the root', () => {
    const { container } = render(<ProgressSteps entries={SEQUENTIAL} className="extra" />);

    expect(container.firstElementChild?.className).toBe('dgv-progress extra');
  });
});

describe('ProgressSteps call to action', () => {
  it('appears only while a capture is armed', () => {
    const { container, rerender } = render(<ProgressSteps entries={SEQUENTIAL} />);
    expect(container.querySelector('.dgv-progress__cta')).toBeNull();

    rerender(<ProgressSteps entries={SEQUENTIAL} captureArmed={false} />);
    expect(container.querySelector('.dgv-progress__cta')).toBeNull();

    rerender(<ProgressSteps entries={SEQUENTIAL} captureArmed />);
    const cta = required(container, '.dgv-progress__cta');
    expect(cta.textContent).toBe(CTA_MESSAGE);
    // A polite announcement that sits outside the list, not a row of it.
    expect(cta.getAttribute('role')).toBe('status');
    expect(required(container, '.dgv-progress__groups').contains(cta)).toBe(false);
    expect(lines(container)).toEqual(messagesOf(SEQUENTIAL));
  });

  it('is withheld while an error is shown', () => {
    const { container } = render(
      <ProgressSteps entries={SEQUENTIAL} captureArmed error="The service stopped responding." />,
    );

    expect(container.querySelector('.dgv-progress__cta')).toBeNull();
  });

  it('stands in for the empty sentence when armed with no rows', () => {
    const { container } = render(<ProgressSteps entries={[]} captureArmed />);

    expect(required(container, '.dgv-progress__cta').textContent).toBe(CTA_MESSAGE);
    expect(container.querySelector('.dg-empty-state')).toBeNull();
    expect(rows(container)).toHaveLength(0);
  });

  it('asks to reproduce the issue again for the capture a follow-up requested', () => {
    const entries = [...STEP_EIGHT, ...FIRST_RUN_TAIL, ...NEW_CAPTURE_FOLLOW_UP];
    const { container } = render(<ProgressSteps entries={entries} captureArmed followUpCapture />);

    const cta = required(container, '.dgv-progress__cta');
    expect(cta.textContent).toBe(CTA_AGAIN_MESSAGE);
    expect(cta.getAttribute('role')).toBe('status');
    expect(container.textContent).not.toContain(CTA_MESSAGE);
  });

  it('says "now" for the first capture and "again" only for a follow-up capture', () => {
    const { container, rerender } = render(<ProgressSteps entries={STEP_EIGHT} captureArmed />);
    expect(required(container, '.dgv-progress__cta').textContent).toBe(CTA_MESSAGE);

    rerender(<ProgressSteps entries={STEP_EIGHT} captureArmed followUpCapture={false} />);
    expect(required(container, '.dgv-progress__cta').textContent).toBe(CTA_MESSAGE);

    rerender(<ProgressSteps entries={STEP_EIGHT} captureArmed followUpCapture />);
    expect(required(container, '.dgv-progress__cta').textContent).toBe(CTA_AGAIN_MESSAGE);
  });

  it('shows no call to action for a follow-up capture that is not armed, or beside an error', () => {
    const { container, rerender } = render(<ProgressSteps entries={STEP_EIGHT} followUpCapture />);
    expect(container.querySelector('.dgv-progress__cta')).toBeNull();

    rerender(
      <ProgressSteps
        entries={STEP_EIGHT}
        captureArmed
        followUpCapture
        error="The service stopped responding."
      />,
    );
    expect(container.querySelector('.dgv-progress__cta')).toBeNull();
    expect(container.textContent).not.toContain(CTA_AGAIN_MESSAGE);
  });
});

describe('ProgressSteps states', () => {
  it('renders the empty state when nothing has arrived', () => {
    const { container } = render(<ProgressSteps entries={[]} />);

    const status = screen.getByRole('status');
    expect(within(status).getByText(EMPTY_MESSAGE)).toBeDefined();
    expect(status.getAttribute('aria-busy')).toBeNull();
    expect(container.querySelector('.dgv-progress__groups')).toBeNull();
    expect(rows(container)).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders the loading state in place of an empty list while pending', () => {
    const { container } = render(<ProgressSteps entries={[]} pending />);

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.classList.contains('dg-loading-state')).toBe(true);
    expect(container.querySelector('.dg-empty-state')).toBeNull();
    expect(container.querySelector('.dgv-progress__groups')).toBeNull();
    expect(rows(container)).toHaveLength(0);
  });

  it('keeps arrived rows visible and appends the loading state while pending', () => {
    const { container } = render(<ProgressSteps entries={SEQUENTIAL} pending />);

    expect(lines(container)).toEqual(messagesOf(SEQUENTIAL));
    const loading = required(container, '.dg-loading-state');
    // Appended after the list, and outside its live region.
    expect(required(container, '.dgv-progress__groups').contains(loading)).toBe(false);
  });

  it('shows the alert and keeps the failed row when a stage fails', () => {
    const failing = [
      ...SEQUENTIAL,
      makeEntry({ stage: 'plan', status: 'failed', message: 'Plan rejected' }),
    ];
    const { container } = render(
      <ProgressSteps entries={failing} pending error="The plan could not be validated." />,
    );

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('The plan could not be validated.')).toBeDefined();
    expect(container.querySelector('.dg-loading-state')).toBeNull();

    // The failure is never hidden behind the alert: its own row stays, drawn failed.
    const failedMarkers = Array.from(container.querySelectorAll('.dgv-progress__marker--failed'));
    expect(failedMarkers).toHaveLength(1);
    const failedRow = failedMarkers[0]?.closest('.dgv-progress__row');
    expect(failedRow?.querySelector('.dgv-progress__label')?.textContent).toBe('Plan rejected');
    expect(lines(container)).toEqual(messagesOf(failing));
    expect(required(container, '.dgv-progress__groups').contains(alert)).toBe(false);
  });

  it('renders only the alert for an error on an empty, pending list', () => {
    const { container } = render(<ProgressSteps entries={[]} pending error="Session failed." />);

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(within(alerts[0] ?? container).getByText('Session failed.')).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();
    expect(container.querySelector('.dg-empty-state')).toBeNull();
    expect(container.querySelector('.dg-loading-state')).toBeNull();
    expect(container.querySelector('.dgv-progress__groups')).toBeNull();
    expect(rows(container)).toHaveLength(0);
  });

  it('treats a blank error as no error', () => {
    const { container } = render(<ProgressSteps entries={[]} error="   " />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.querySelector('.dg-empty-state')).not.toBeNull();
  });

  it('offers a retry only when onRetry is supplied, and raises it once', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ProgressSteps entries={[]} error="Stage failed." />);
    expect(screen.queryByRole('button')).toBeNull();

    const onRetry = vi.fn();
    rerender(<ProgressSteps entries={[]} error="Stage failed." onRetry={onRetry} />);
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('ProgressSteps privacy', () => {
  it('writes nothing to any console method in any state', async () => {
    const user = userEvent.setup();
    const detailed = makeEntry({
      stage: 'investigate',
      message: 'Located a request handler',
      detail: 'lib/sample/private-module.ts:7',
    });
    const onRetry = vi.fn();

    const { rerender, unmount } = render(<ProgressSteps entries={[]} />);
    rerender(<ProgressSteps entries={[]} pending />);
    rerender(<ProgressSteps entries={[detailed]} pending />);
    rerender(<ProgressSteps entries={[...SEQUENTIAL, detailed]} captureArmed />);
    rerender(
      <ProgressSteps
        entries={[
          ...SEQUENTIAL,
          makeEntry({ stage: 'plan', status: 'failed', message: 'Stopped' }),
        ]}
        error="The pipeline could not continue."
        onRetry={onRetry}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    unmount();

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(consoleSpies).toHaveLength(CONSOLE_METHODS.length);
    for (const [method, spy] of consoleSpies) {
      expect(spy, `console.${method} must never be called`).not.toHaveBeenCalled();
    }
  });
});

describe('ProgressSteps direction controls', () => {
  /**
   * A right-to-left override (U+202E) and its pop (U+202C) around markup: a
   * progress line names components, routes and files the pipeline found in
   * the project. Every code point is written as an escape so this suite is
   * not itself a carrier of what it defends against.
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

  const ENTRIES: readonly ProgressEntry[] = [
    makeEntry({ stage: 'understand', message: `Read the question ${SPOOF}` }),
    makeEntry({
      stage: 'investigate',
      message: `Located the component ${SPOOF}`,
      detail: `src/spoof/${SPOOF}.tsx:12`,
      ts: TS + 1,
    }),
  ];

  it('shows each control of a message and a detail line as a visible escape', () => {
    const { container } = render(<ProgressSteps entries={ENTRIES} />);

    expect(lines(container)).toEqual(messagesOf(ENTRIES).map(revealed));
    expect(container.querySelector('.dgv-progress__detail')?.textContent).toBe(
      revealed(`src/spoof/${SPOOF}.tsx:12`),
    );

    expect(container.textContent).not.toMatch(RAW_CONTROL);
    for (const element of Array.from(container.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.value).not.toMatch(RAW_CONTROL);
      }
    }
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('td')).toBeNull();
  });

  it('shows the controls of a stage failure as visible escapes', () => {
    render(<ProgressSteps entries={ENTRIES} error={`The plan stage failed: ${SPOOF}`} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(revealed(`The plan stage failed: ${SPOOF}`));
    expect(alert.textContent).not.toMatch(RAW_CONTROL);
  });
});
