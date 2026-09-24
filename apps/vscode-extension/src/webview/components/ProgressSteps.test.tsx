/**
 * The contract of `components/ProgressSteps` — the live progress list of the
 * editor view (AAP 0.7.3), which must display exactly the `session.progress`
 * rows the host received and nothing else (AAP 0.5.4).
 *
 * Pinned here:
 *
 *   - **One-for-one fidelity.** The rendered rows are the given entries, in the
 *     order given; an input in a non-pipeline order is not re-sorted, and a
 *     repeated stage joins its first group without moving it.
 *   - **Verbatim text.** Messages and details render exactly as received.
 *   - **Status markers.** Each status yields exactly one marker modifier, a
 *     decorative glyph hidden from assistive technology and an announced word.
 *   - **The call to action** appears only while a capture is armed.
 *   - **The three states** and their precedence: error > pending > empty, with
 *     arrived rows kept visible under an error or a pending pipeline.
 *
 * Fixture messages are generic vocabulary written for this suite; no inspected
 * project's names appear in it (AAP 0.5.4).
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ProgressEntry } from '../../webview-messages';

import { ProgressSteps } from './ProgressSteps';

/** A fixed receive time; the component never reads it. */
const TS = 1_700_000_000_000;

/**
 * Builds one entry.
 *
 * @param stage The reporting stage.
 * @param status The stage's status.
 * @param message The line the service composed.
 * @param detail An optional second line.
 * @returns The entry.
 */
function entry(
  stage: string,
  status: ProgressEntry['status'],
  message: string,
  detail?: string,
): ProgressEntry {
  return detail === undefined
    ? { stage, status, message, ts: TS }
    : { stage, status, message, detail, ts: TS };
}

/** Entries in the order a session reports them, one stage after another. */
const SEQUENTIAL: readonly ProgressEntry[] = [
  entry('understand', 'done', 'Found the selected element'),
  entry('understand', 'done', 'Traced event handler'),
  entry('investigate', 'done', 'Found the request route', 'src/server/alpha/route.ts'),
  entry('plan', 'running', 'Choosing signals'),
];

/**
 * The rendered row labels, in document order.
 *
 * @param container The render container, or any part of it.
 * @returns Each row's label text.
 */
function rowLabels(container: ParentNode): string[] {
  return Array.from(container.querySelectorAll('.dgv-progress__row .dgv-progress__label')).map(
    (node) => node.textContent ?? '',
  );
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

    expect(container.querySelectorAll('.dgv-progress__row')).toHaveLength(SEQUENTIAL.length);
    expect(rowLabels(container)).toEqual(SEQUENTIAL.map((item) => item.message));
  });

  it('does not re-sort an input that is out of pipeline order', () => {
    const outOfOrder: readonly ProgressEntry[] = [
      entry('analyze', 'done', 'Summarised the capture'),
      entry('understand', 'done', 'Read the question'),
      entry('plan', 'failed', 'No adapter accepted the plan'),
    ];
    const { container } = render(<ProgressSteps entries={outOfOrder} />);

    expect(groupTitles(container)).toEqual(['Analyze', 'Understand', 'Plan']);
    expect(rowLabels(container)).toEqual(outOfOrder.map((item) => item.message));
  });

  it('joins a repeated stage to its first group without moving that group', () => {
    const interleaved: readonly ProgressEntry[] = [
      entry('understand', 'done', 'first'),
      entry('investigate', 'running', 'second'),
      entry('understand', 'done', 'third'),
    ];
    const { container } = render(<ProgressSteps entries={interleaved} />);

    const groups = Array.from(container.querySelectorAll('.dgv-progress__group'));
    expect(groups).toHaveLength(2);
    expect(groupTitles(container)).toEqual(['Understand', 'Investigate']);

    const [firstGroup, secondGroup] = groups;
    expect(firstGroup === undefined ? [] : rowLabels(firstGroup)).toEqual(['first', 'third']);
    expect(secondGroup === undefined ? [] : rowLabels(secondGroup)).toEqual(['second']);
    // Nothing dropped, nothing added.
    expect(container.querySelectorAll('.dgv-progress__row')).toHaveLength(interleaved.length);
  });

  it('keeps rows that the host delivered twice rather than de-duplicating them', () => {
    const repeated: readonly ProgressEntry[] = [
      entry('capture', 'running', 'Listening'),
      entry('capture', 'running', 'Listening'),
    ];
    const { container } = render(<ProgressSteps entries={repeated} />);

    expect(rowLabels(container)).toEqual(['Listening', 'Listening']);
  });

  it('renders messages and details verbatim', () => {
    const odd = entry(
      'instrument',
      'done',
      '  lower-case, `code` and  double  spaces ',
      'x/y.ts:12',
    );
    const { container } = render(<ProgressSteps entries={[odd]} />);

    expect(required(container, '.dgv-progress__label').textContent).toBe(odd.message);
    expect(required(container, '.dgv-progress__detail').textContent).toBe('x/y.ts:12');
  });

  it('renders the detail line only when the entry carries one', () => {
    const { container } = render(<ProgressSteps entries={SEQUENTIAL} />);

    const details = Array.from(container.querySelectorAll('.dgv-progress__detail'));
    expect(details.map((node) => node.textContent)).toEqual(['src/server/alpha/route.ts']);
    const rows = Array.from(container.querySelectorAll('.dgv-progress__row'));
    expect(rows[2]?.querySelector('.dgv-progress__detail')).not.toBeNull();
    expect(rows[0]?.querySelector('.dgv-progress__detail')).toBeNull();
  });

  it('derives group titles from the raw stage with a generic transform only', () => {
    const { container } = render(
      <ProgressSteps entries={[entry('generate-panel', 'running', 'Composing the view')]} />,
    );

    expect(groupTitles(container)).toEqual(['Generate panel']);
  });

  it('shows a new row only when new props arrive', () => {
    const { container, rerender } = render(<ProgressSteps entries={SEQUENTIAL.slice(0, 2)} />);
    expect(rowLabels(container)).toHaveLength(2);

    rerender(<ProgressSteps entries={SEQUENTIAL} />);
    expect(rowLabels(container)).toEqual(SEQUENTIAL.map((item) => item.message));
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
    const { container } = render(<ProgressSteps entries={[entry('plan', status, 'A step')]} />);

    const marker = required(container, '.dgv-progress__marker');
    const present = MODIFIERS.filter((name) => marker.classList.contains(name));
    expect(present).toEqual([modifier]);

    // The status is announced in words, not carried by colour alone.
    expect(required(marker, '.dg-visually-hidden').textContent).toBe(spoken);
    expect(required(marker, '[aria-hidden="true"]')).toBeDefined();
  });

  it('draws a check, a cross and a spinner as decoration', () => {
    const { container } = render(
      <ProgressSteps
        entries={[
          entry('plan', 'done', 'one'),
          entry('plan', 'failed', 'two'),
          entry('plan', 'running', 'three'),
        ]}
      />,
    );

    const glyphs = Array.from(container.querySelectorAll('.dgv-progress__marker > [aria-hidden]'));
    expect(glyphs.map((node) => node.textContent)).toEqual(['✓', '✕', '']);
    expect(glyphs[2]?.querySelector('.dg-spinner')).not.toBeNull();
  });

  it('does not raise a page-level alert for a failed row on its own', () => {
    render(<ProgressSteps entries={[entry('analyze', 'failed', 'Could not summarise')]} />);

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

    rerender(<ProgressSteps entries={SEQUENTIAL} captureArmed />);
    expect(required(container, '.dgv-progress__cta').textContent).toBe('Reproduce the issue now.');
  });

  it('is withheld while an error is shown', () => {
    const { container } = render(
      <ProgressSteps entries={SEQUENTIAL} captureArmed error="The service stopped responding." />,
    );

    expect(container.querySelector('.dgv-progress__cta')).toBeNull();
  });

  it('stands in for the empty sentence when armed with no rows', () => {
    const { container } = render(<ProgressSteps entries={[]} captureArmed />);

    expect(required(container, '.dgv-progress__cta')).toBeDefined();
    expect(container.querySelector('.dg-empty-state')).toBeNull();
  });
});

describe('ProgressSteps states', () => {
  it('renders the empty state when nothing has arrived', () => {
    const { container } = render(<ProgressSteps entries={[]} />);

    expect(screen.getByText('No progress yet. Ask a question to start a session.')).toBeDefined();
    expect(container.querySelector('.dgv-progress__groups')).toBeNull();
  });

  it('renders the loading state in place of an empty list while pending', () => {
    const { container } = render(<ProgressSteps entries={[]} pending />);

    const loading = required(container, '.dg-loading-state');
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('.dg-empty-state')).toBeNull();
    expect(container.querySelector('.dgv-progress__groups')).toBeNull();
  });

  it('keeps arrived rows visible and appends the loading state while pending', () => {
    const { container } = render(<ProgressSteps entries={SEQUENTIAL} pending />);

    expect(rowLabels(container)).toEqual(SEQUENTIAL.map((item) => item.message));
    const loading = required(container, '.dg-loading-state');
    // Appended after the list, and outside its live region.
    expect(required(container, '.dgv-progress__groups').contains(loading)).toBe(false);
  });

  it('renders the error state above pending and keeps the failed row', () => {
    const rows = [...SEQUENTIAL, entry('plan', 'failed', 'Plan rejected')];
    const { container } = render(
      <ProgressSteps entries={rows} pending error="The plan could not be validated." />,
    );

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('The plan could not be validated.')).toBeDefined();
    expect(container.querySelector('.dg-loading-state')).toBeNull();

    const failedMarkers = container.querySelectorAll('.dgv-progress__marker--failed');
    expect(failedMarkers).toHaveLength(1);
    expect(rowLabels(container)).toEqual(rows.map((item) => item.message));
  });

  it('renders the error state in place of an empty list', () => {
    const { container } = render(<ProgressSteps entries={[]} pending error="Session failed." />);

    expect(screen.getByRole('alert')).toBeDefined();
    expect(container.querySelector('.dg-empty-state')).toBeNull();
    expect(container.querySelector('.dg-loading-state')).toBeNull();
  });

  it('treats a blank error as no error', () => {
    const { container } = render(<ProgressSteps entries={[]} error="   " />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.querySelector('.dg-empty-state')).not.toBeNull();
  });

  it('offers a retry only when onRetry is supplied, and raises it', async () => {
    const { rerender } = render(<ProgressSteps entries={[]} error="Stage failed." />);
    expect(screen.queryByRole('button')).toBeNull();

    const onRetry = vi.fn();
    rerender(<ProgressSteps entries={[]} error="Stage failed." onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
