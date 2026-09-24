/**
 * The contract of `components/ProgressSteps` — the live progress list of the
 * editor view (AAP 0.7.3), which must display exactly the `session.progress`
 * rows the host received and nothing else (AAP 0.5.4).
 *
 * A progress list is the easiest place in the product to fake a result, so
 * this suite makes "renders exactly what arrived, in the order it arrived"
 * mechanically true. Pinned here:
 *
 *   - **One-for-one fidelity.** The rendered rows are the given entries, in the
 *     order given, compared as whole arrays: an input in a non-pipeline order is
 *     not re-sorted, a repeated stage joins its first group without moving it,
 *     rows delivered twice are not de-duplicated, and nothing is padded in.
 *   - **Verbatim text.** Messages and details render exactly as received.
 *   - **Status markers.** Each status yields exactly one marker modifier, a
 *     decorative glyph hidden from assistive technology and an announced word;
 *     a failed stage is always drawn as failed (AAP 0.5.5).
 *   - **The call to action** appears only while a capture is armed.
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

/** A fixed receive time; the component never reads it. */
const TS = 1_700_000_000_000;

/** The empty-state sentence the component owns. */
const EMPTY_MESSAGE = 'No progress yet. Ask a question to start a session.';

/** The call to action while a capture is armed (AAP 0.7.3). */
const CTA_MESSAGE = 'Reproduce the issue now.';

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
 * The rendered row elements, in document order.
 *
 * @param container The render container, or any part of it.
 * @returns Every `dgv-progress__row` element.
 */
function rows(container: ParentNode): Element[] {
  return Array.from(container.querySelectorAll('.dgv-progress__row'));
}

/**
 * The rendered row labels, in document order.
 *
 * @param container The render container, or any part of it.
 * @returns Each row's label text.
 */
function rowLabels(container: ParentNode): string[] {
  return rows(container).map((row) => row.querySelector('.dgv-progress__label')?.textContent ?? '');
}

/**
 * The rendered group titles, in document order.
 *
 * @param container The render container.
 * @returns Each group's title text.
 */
function groupTitles(container: ParentNode): string[] {
  return Array.from(container.querySelectorAll('.dgv-progress__group-title')).map(
    (node) => node.textContent ?? '',
  );
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

describe('ProgressSteps rows', () => {
  it('renders one row per entry, in the order given', () => {
    const { container } = render(<ProgressSteps entries={SEQUENTIAL} />);

    expect(rows(container)).toHaveLength(SEQUENTIAL.length);
    expect(rowLabels(container)).toEqual(messagesOf(SEQUENTIAL));
  });

  it('does not re-sort an input that is out of pipeline order', () => {
    const outOfOrder: readonly ProgressEntry[] = [
      makeEntry({ stage: 'analyze', message: 'Summarised the capture' }),
      makeEntry({ stage: 'understand', message: 'Read the question' }),
      makeEntry({ stage: 'plan', status: 'failed', message: 'No adapter accepted the plan' }),
    ];
    const { container } = render(<ProgressSteps entries={outOfOrder} />);

    expect(groupTitles(container)).toEqual(['Analyze', 'Understand', 'Plan']);
    expect(rowLabels(container)).toEqual(messagesOf(outOfOrder));
  });

  it('joins a repeated stage to its first group without moving that group', () => {
    const interleaved: readonly ProgressEntry[] = [
      makeEntry({ stage: 'understand', message: 'first' }),
      makeEntry({ stage: 'investigate', status: 'running', message: 'second' }),
      makeEntry({ stage: 'understand', message: 'third' }),
    ];
    const { container } = render(<ProgressSteps entries={interleaved} />);

    const groups = Array.from(container.querySelectorAll('.dgv-progress__group'));
    expect(groups).toHaveLength(2);
    expect(groupTitles(container)).toEqual(['Understand', 'Investigate']);

    const [firstGroup, secondGroup] = groups;
    expect(firstGroup === undefined ? [] : rowLabels(firstGroup)).toEqual(['first', 'third']);
    expect(secondGroup === undefined ? [] : rowLabels(secondGroup)).toEqual(['second']);
    // Nothing dropped, nothing added.
    expect(rows(container)).toHaveLength(interleaved.length);
  });

  it('keeps rows that the host delivered twice rather than de-duplicating them', () => {
    const repeated: readonly ProgressEntry[] = [
      makeEntry({ stage: 'capture', status: 'running', message: 'Listening' }),
      makeEntry({ stage: 'capture', status: 'running', message: 'Listening' }),
    ];
    const { container } = render(<ProgressSteps entries={repeated} />);

    expect(rowLabels(container)).toEqual(messagesOf(repeated));
  });

  it('renders a single entry as exactly one row, with nothing padded around it', () => {
    const only = makeEntry({ stage: 'understand', message: 'Read the question' });
    const { container } = render(<ProgressSteps entries={[only]} />);

    expect(rows(container)).toHaveLength(1);
    expect(rowLabels(container)).toEqual([only.message]);
    expect(container.querySelectorAll('.dgv-progress__group')).toHaveLength(1);
    expect(container.querySelectorAll('.dgv-progress__marker')).toHaveLength(1);
    // One group item and one row item: no placeholder or "pending" step.
    const groupsList = screen.getByRole('list', { name: 'Session progress' });
    expect(within(groupsList).getAllByRole('listitem')).toHaveLength(2);
    // No state affordance and no call to action beside the one row.
    expect(container.querySelector('.dg-loading-state')).toBeNull();
    expect(container.querySelector('.dg-empty-state')).toBeNull();
    expect(container.querySelector('.dgv-progress__cta')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    // Every character on screen is accounted for by the one entry: its stage's
    // title, its marker's glyph and announced word, and its message.
    expect(container.textContent).toBe(`Understand✓Done${only.message}`);
  });

  it('renders messages and details verbatim', () => {
    const odd = makeEntry({
      stage: 'instrument',
      message: '  lower-case start, mIxEd CaSe, `code`, “quotes”; and  double  spaces… ',
      detail: 'x/Y.ts:12 — (see below)',
    });
    const { container } = render(<ProgressSteps entries={[odd]} />);

    expect(required(container, '.dgv-progress__label').textContent).toBe(odd.message);
    expect(required(container, '.dgv-progress__detail').textContent).toBe(odd.detail);
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

  it('derives group titles from the raw stage with a generic transform only', () => {
    const { container } = render(
      <ProgressSteps
        entries={[makeEntry({ stage: 'generate-panel', status: 'running', message: 'Composing' })]}
      />,
    );

    expect(groupTitles(container)).toEqual(['Generate panel']);
  });

  it('shows a new row only when new props arrive', () => {
    const { container, rerender } = render(<ProgressSteps entries={SEQUENTIAL.slice(0, 2)} />);
    expect(rowLabels(container)).toEqual(messagesOf(SEQUENTIAL.slice(0, 2)));

    rerender(<ProgressSteps entries={SEQUENTIAL} />);
    expect(rowLabels(container)).toEqual(messagesOf(SEQUENTIAL));
  });
});

describe('ProgressSteps status markers', () => {
  const MODIFIERS = [
    'dgv-progress__marker--running',
    'dgv-progress__marker--done',
    'dgv-progress__marker--failed',
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
    expect(rowLabels(container)).toEqual(['Could not summarise']);
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

describe('ProgressSteps semantics', () => {
  it('uses ordered lists, a polite live region and title-named row lists', () => {
    const { container } = render(<ProgressSteps entries={SEQUENTIAL} />);

    const groupsList = required(container, '.dgv-progress__groups');
    expect(groupsList.tagName).toBe('OL');
    expect(groupsList.getAttribute('aria-live')).toBe('polite');

    const understandRows = screen.getByRole('list', { name: 'Understand' });
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
    expect(rowLabels(container)).toEqual(messagesOf(SEQUENTIAL));
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

    expect(rowLabels(container)).toEqual(messagesOf(SEQUENTIAL));
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
    expect(rowLabels(container)).toEqual(messagesOf(failing));
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
