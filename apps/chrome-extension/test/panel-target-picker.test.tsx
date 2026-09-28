/**
 * The contract of the target display in `src/panel/components/TargetPicker` — what the header of
 * the "Debug Generator" DevTools panel shows about the session's target (AAP 0.7.3), kept to one
 * summary line so that selecting an element never stacks the header into descriptor rows.
 *
 * Pinned here:
 *
 *   - **One summary line.** A target renders as the "Target" label, the tag, the nearest component
 *     (`componentChain[0]`, blank names skipped) and the whole selector — clipped only when
 *     painted, through the renderer's `dg-truncate` utility, with its full value as the chip's
 *     `title` and in its text. The summary holds nothing else: no further chain entry, no page URL
 *     and no visible text. The innermost header stack holding the exact "Target" label is that
 *     summary and its text contains the selector — the contract `tests/e2e/helpers/chrome.ts`
 *     `targetDescriptor` relies on.
 *   - **The rest on request.** A "Target details" disclosure — a real button with `aria-expanded`
 *     and `aria-controls` — reveals the full selector, the visible text, the component chain in
 *     its own order and the page URL. The region stays mounted but hidden while collapsed, so
 *     `aria-controls` always names an element in the document and the descriptor stays in the
 *     document text; it is collapsed by default, it opens and closes on a click, on Enter and on
 *     Space, and focus stays on the toggle throughout.
 *   - **The developer's choice survives a new target.** The disclosure is neither reset nor
 *     remounted when the target changes; the open region shows the new target.
 *   - **Everything else is unchanged.** No target still reads "No element selected" and offers no
 *     disclosure; the disclosure stays operable while the element-targeting controls are busy or
 *     unavailable; the picker toggle, its badge and the single status region behave as before.
 *   - **A clean console.** Rendering and toggling make React warn about nothing.
 *   - **Hostile page text stays legible (QA-SEC F02).** Markup and a right-to-left override pair in
 *     the selector, the visible text, the component chain and the page URL render as text, each
 *     direction control printed as its visible `\u202E`-style escape in the chips, their titles
 *     and the details, and every code-like value isolated left-to-right.
 *
 * ## Harness
 *
 * Collected into the `chrome-extension` Vitest project (happy-dom). The component is rendered on
 * its own with recording callbacks, so no port, store or `chrome` global is involved. Every
 * mounted tree is cleaned up and every spy restored by this file's own `afterEach`. Fixture values
 * are generic vocabulary written for this suite; no inspected project's names appear in it
 * (AAP 0.5.4).
 */

import { containsDirectionControl } from '@debuggen/panel-renderer';
import type { SelectedTarget } from '@debuggen/protocol';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { TargetPicker } from '../src/panel/components/TargetPicker';
import type { TargetPickerProps } from '../src/panel/components/TargetPicker';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A target with every descriptor field, its owner chain nearest first. */
const TARGET: SelectedTarget = Object.freeze({
  selector: 'main.workspace > section.panel:nth-of-type(2) > form > div > button.submit > span',
  tagName: 'span',
  text: 'Submit the form',
  componentChain: ['SubmitButton', 'FormFooter', 'SettingsForm', 'SettingsPage'],
  url: 'http://127.0.0.1:4100/workspace/settings',
});

/** The same element described without visible text. */
const TARGET_WITHOUT_TEXT: SelectedTarget = Object.freeze({
  selector: TARGET.selector,
  tagName: TARGET.tagName,
  componentChain: TARGET.componentChain,
  url: TARGET.url,
});

/** A second target, for a change of selection. */
const OTHER_TARGET: SelectedTarget = Object.freeze({
  selector: 'nav > a.home',
  tagName: 'a',
  text: 'Home',
  componentChain: ['NavLink', 'NavigationBar'],
  url: 'http://127.0.0.1:4100/workspace',
});

/** The disclosure's accessible name, and the name of the region it reveals. */
const DETAILS_NAME = 'Target details';

/** The pressed-surface state class `Button` takes while the disclosure is open. */
const ACTIVE_STATE_CLASS = 'dg-is-active';

/** The renderer's single-line clip utility the summary's chips carry. */
const TRUNCATE_CLASS = 'dg-truncate';

/** The capped variant of that clip the renderer publishes for a host's control row. */
const CAPPED_TRUNCATE_CLASS = 'dg-truncate--capped';

/**
 * Props with recording callbacks and every control available.
 *
 * @param overrides The props a case changes.
 */
function props(overrides: Partial<TargetPickerProps> = {}): TargetPickerProps {
  return {
    target: TARGET,
    pickerActive: false,
    onPick: vi.fn(),
    onUseSelected: vi.fn(),
    devtoolsAvailable: true,
    sessionBound: true,
    onActionError: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** The "Target details" disclosure. */
function detailsToggle(): HTMLElement {
  return screen.getByRole('button', { name: DETAILS_NAME });
}

/**
 * The region the disclosure controls, found through its `aria-controls` — whether it is shown or
 * hidden.
 */
function detailsRegion(): HTMLElement {
  const id = detailsToggle().getAttribute('aria-controls');
  expect(id).toBeTruthy();
  const region = document.getElementById(id ?? '');
  expect(region).not.toBeNull();
  return region as HTMLElement;
}

/** The summary line: the stack that holds the exact "Target" label. */
function summaryLine(): HTMLElement {
  const label = screen.getByText('Target', { exact: true });
  const stack = label.closest<HTMLElement>('.dg-stack');
  expect(stack).not.toBeNull();
  return stack as HTMLElement;
}

/**
 * The stack `tests/e2e/helpers/chrome.ts` resolves as `targetDescriptor`: the last `.dg-stack`,
 * in document order, that contains an element whose whole text is "Target".
 *
 * @param container The rendered tree.
 */
function e2eTargetDescriptor(container: HTMLElement): HTMLElement | undefined {
  const holding = Array.from(container.querySelectorAll<HTMLElement>('.dg-stack')).filter((stack) =>
    Array.from(stack.querySelectorAll<HTMLElement>('*')).some(
      (element) => element.textContent.trim() === 'Target',
    ),
  );
  return holding.at(-1);
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

let consoleError: MockInstance<typeof console.error>;
let consoleWarn: MockInstance<typeof console.warn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error');
  consoleWarn = vi.spyOn(console, 'warn');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Asserts that nothing so far made React, or the component, warn. */
function expectCleanConsole(): void {
  expect(consoleError).not.toHaveBeenCalled();
  expect(consoleWarn).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------
// The summary line
// ---------------------------------------------------------------------------

describe('TargetPicker — the target summary line', () => {
  it('shows the Target label, the tag, the nearest component and the whole selector', () => {
    render(<TargetPicker {...props()} />);
    const summary = summaryLine();
    const text = summary.textContent;

    expect(text).toContain('Target');
    expect(text).toContain(TARGET.tagName);
    expect(text).toContain('SubmitButton');
    expect(text).toContain(TARGET.selector);

    // Only the nearest component, and none of the fields the details hold.
    for (const farther of ['FormFooter', 'SettingsForm', 'SettingsPage']) {
      expect(text).not.toContain(farther);
    }
    expect(text).not.toContain(TARGET.url);
    expect(text).not.toContain('Submit the form');
    expect(summary.contains(detailsToggle())).toBe(false);
    expectCleanConsole();
  });

  it('clips the selector and the component only when painted, keeping each whole in its chip', () => {
    render(<TargetPicker {...props()} />);
    const chips = Array.from(summaryLine().querySelectorAll<HTMLElement>('code'));

    expect(chips.map((chip) => chip.textContent)).toEqual(['SubmitButton', TARGET.selector]);
    for (const chip of chips) {
      expect(chip.classList.contains(TRUNCATE_CLASS)).toBe(true);
      expect(chip.getAttribute('title')).toBe(chip.textContent);
    }
  });

  it('caps only the selector chip at a field measure, so a long selector cannot claim the header row', () => {
    render(<TargetPicker {...props()} />);
    const [component, selector] = Array.from(summaryLine().querySelectorAll<HTMLElement>('code'));

    expect(selector?.classList.contains(CAPPED_TRUNCATE_CLASS)).toBe(true);
    // The component name is short by nature; it keeps the plain clip.
    expect(component?.classList.contains(CAPPED_TRUNCATE_CLASS)).toBe(false);
  });

  it('names the component and the selector for assistive technology without painting the names', () => {
    render(<TargetPicker {...props()} />);
    const leadIns = Array.from(
      summaryLine().querySelectorAll<HTMLElement>('.dg-visually-hidden'),
    ).map((element) => element.textContent);

    expect(leadIns).toEqual(['Nearest component:', 'Selector:']);
  });

  it('is the stack the end-to-end helper reads as the target descriptor', () => {
    const { container } = render(<TargetPicker {...props()} />);
    const descriptor = e2eTargetDescriptor(container);

    expect(descriptor).toBe(summaryLine());
    expect(descriptor?.textContent).toContain(TARGET.selector);
  });

  it('skips blank component names and omits the component chip when no name remains', () => {
    const { rerender } = render(
      <TargetPicker
        {...props({ target: { ...TARGET, componentChain: ['  ', 'OwnerPanel', 'Shell'] } })}
      />,
    );
    const firstChip = summaryLine().querySelector<HTMLElement>('code');
    expect(firstChip?.textContent).toBe('OwnerPanel');

    rerender(<TargetPicker {...props({ target: { ...TARGET, componentChain: [] } })} />);
    const chips = Array.from(summaryLine().querySelectorAll<HTMLElement>('code'));
    expect(chips.map((chip) => chip.textContent)).toEqual([TARGET.selector]);
    expect(summaryLine().textContent).not.toContain('Nearest component:');
    expect(detailsRegion().textContent).toContain('No component information');
  });
});

// ---------------------------------------------------------------------------
// The details disclosure
// ---------------------------------------------------------------------------

describe('TargetPicker — the target details disclosure', () => {
  it('keeps the full descriptor mounted but hidden until the developer opens it', () => {
    render(<TargetPicker {...props()} />);
    const toggle = detailsToggle();
    const region = detailsRegion();

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.classList.contains(ACTIVE_STATE_CLASS)).toBe(false);
    expect(region.hidden).toBe(true);
    // Hidden from the accessibility tree while collapsed…
    expect(screen.queryByRole('group', { name: DETAILS_NAME })).toBeNull();
    // …yet whole in the document text.
    const text = region.textContent;
    expect(text).toContain(TARGET.selector);
    expect(text).toContain('Submit the form');
    expect(text).toContain(TARGET.url);
    expect(text).toContain('Components, nearest first');
  });

  it('opens and closes on a click, reporting its state, while focus stays on the toggle', async () => {
    const user = userEvent.setup();
    render(<TargetPicker {...props()} />);
    const toggle = detailsToggle();

    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.classList.contains(ACTIVE_STATE_CLASS)).toBe(true);
    expect(detailsRegion().hidden).toBe(false);
    expect(screen.getByRole('group', { name: DETAILS_NAME })).toBe(detailsRegion());
    expect(document.activeElement).toBe(toggle);

    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.classList.contains(ACTIVE_STATE_CLASS)).toBe(false);
    expect(detailsRegion().hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
    expectCleanConsole();
  });

  it('is operable from the keyboard with Enter and Space', async () => {
    const user = userEvent.setup();
    render(<TargetPicker {...props()} />);
    const toggle = detailsToggle();

    // Tab order: "Pick element", "Use selected element", then the disclosure.
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(toggle);

    await user.keyboard('{Enter}');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(detailsRegion().hidden).toBe(false);

    await user.keyboard(' ');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(detailsRegion().hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
  });

  it('shows the selector in full, the visible text, the chain in its own order and the page', async () => {
    const user = userEvent.setup();
    render(<TargetPicker {...props()} />);
    await user.click(detailsToggle());
    const region = screen.getByRole('group', { name: DETAILS_NAME });

    const values = Array.from(region.querySelectorAll<HTMLElement>('code')).map(
      (code) => code.textContent,
    );
    expect(values).toEqual([TARGET.selector, ...TARGET.componentChain, TARGET.url]);
    for (const code of Array.from(region.querySelectorAll<HTMLElement>('code'))) {
      expect(code.classList.contains(TRUNCATE_CLASS)).toBe(false);
    }
    const text = region.textContent;
    for (const label of ['Selector', 'Visible text', 'Components, nearest first', 'Page']) {
      expect(text).toContain(label);
    }
    expect(text).toContain('Submit the form');
  });

  it('leaves out the visible text line when the target has no text', () => {
    render(<TargetPicker {...props({ target: TARGET_WITHOUT_TEXT })} />);

    expect(detailsRegion().textContent).not.toContain('Visible text');
    expect(detailsRegion().textContent).toContain(TARGET.selector);
  });

  it('keeps the disclosure as the developer left it when the target changes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TargetPicker {...props()} />);
    const toggle = detailsToggle();
    await user.click(toggle);

    rerender(<TargetPicker {...props({ target: OTHER_TARGET })} />);
    expect(detailsToggle()).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const region = detailsRegion();
    expect(region.hidden).toBe(false);
    expect(region.textContent).toContain(OTHER_TARGET.selector);
    expect(region.textContent).not.toContain(TARGET.selector);
    expect(summaryLine().textContent).toContain(OTHER_TARGET.selector);
  });

  it('stays operable while the element-targeting controls are busy or unavailable', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TargetPicker {...props({ busy: true })} />);
    const toggle = detailsToggle();

    expect(toggle.getAttribute('aria-disabled')).toBeNull();
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    rerender(<TargetPicker {...props({ sessionBound: false })} />);
    expect(screen.getByRole('button', { name: 'Pick element' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// Unchanged behaviour
// ---------------------------------------------------------------------------

describe('TargetPicker — what the summary leaves unchanged', () => {
  it('reads "No element selected" and offers no disclosure without a target', () => {
    const { container } = render(<TargetPicker {...props({ target: undefined })} />);

    expect(screen.getByText('No element selected')).toBeTruthy();
    expect(screen.queryByRole('button', { name: DETAILS_NAME })).toBeNull();
    expect(screen.queryByText('Target', { exact: true })).toBeNull();
    expect(container.querySelector('[aria-controls]')).toBeNull();
    expect(container.querySelector('[role="group"]')).toBeNull();
  });

  it('keeps the picker toggle, its badge and the single status region beside the summary', () => {
    const { rerender } = render(<TargetPicker {...props()} />);
    const pick = screen.getByRole('button', { name: 'Pick element' });

    expect(pick.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Use selected element' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('');
    expect(screen.queryByText('Picker on')).toBeNull();

    rerender(<TargetPicker {...props({ pickerActive: true })} />);
    expect(pick.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Picker on')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(
      'Picker mode on. Click an element in the inspected page, or press Escape there to cancel.',
    );
    expect(summaryLine().textContent).toContain(TARGET.selector);
    expectCleanConsole();
  });

  it('passes the caller class name to its root column and nowhere else', () => {
    const { container } = render(<TargetPicker {...props({ className: 'picker-under-test' })} />);
    const root = container.firstElementChild;

    expect(root?.classList.contains('picker-under-test')).toBe(true);
    expect(root?.classList.contains('dg-stack--vertical')).toBe(true);
    expect(container.querySelectorAll('.picker-under-test')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Hostile page text: markup and direction controls (QA-SEC F02)
// ---------------------------------------------------------------------------

/**
 * The label QA-SEC F02 ingested: markup wrapped in U+202E RIGHT-TO-LEFT OVERRIDE and U+202C POP
 * DIRECTIONAL FORMATTING, which drew its tail reversed while `textContent` stayed logical.
 */
const BIDI_LABEL = 'QA_BIDI \u202E</td><script>alert(7)</script>\u202C';

/** The same label as the picker prints it: each control as its visible escape. */
const REVEALED_LABEL = 'QA_BIDI \\u202E</td><script>alert(7)</script>\\u202C';

/** A target whose every page-controlled field carries {@link BIDI_LABEL}. */
const BIDI_TARGET: SelectedTarget = Object.freeze({
  selector: `main > [data-label="${BIDI_LABEL}"]`,
  tagName: 'span',
  text: `Visible ${BIDI_LABEL}`,
  componentChain: [`Nearest ${BIDI_LABEL}`, `Outer ${BIDI_LABEL}`],
  url: `http://127.0.0.1:4100/workspace?label=${BIDI_LABEL}`,
});

/**
 * Asserts that no text a reader sees, hovers or hears under `root` carries a raw direction
 * control: its text content, and every attribute but the `data-*` ones, which are data rather
 * than presentation and keep raw values by contract.
 *
 * @param root The subtree to read; the document body, so a portalled tooltip is read too.
 */
function expectNoRawDirectionControl(root: Element): void {
  expect(containsDirectionControl(root.textContent)).toBe(false);
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const attribute of Array.from(element.attributes)) {
      if (!attribute.name.startsWith('data-')) {
        expect(
          containsDirectionControl(attribute.value),
          `${element.tagName.toLowerCase()}[${attribute.name}]`,
        ).toBe(false);
      }
    }
  }
}

describe('TargetPicker — hostile page text', () => {
  it('prints each direction control as its visible escape in the summary and the details', async () => {
    // The fixture is hostile: the raw controls are in the descriptor the picker receives.
    expect(containsDirectionControl(BIDI_TARGET.selector)).toBe(true);
    const user = userEvent.setup();
    render(<TargetPicker {...props({ target: BIDI_TARGET })} />);

    // The summary's two clipped chips: text and title both revealed, each isolated.
    const chips = Array.from(summaryLine().querySelectorAll<HTMLElement>('code'));
    const selector = `main > [data-label="${REVEALED_LABEL}"]`;
    const nearest = `Nearest ${REVEALED_LABEL}`;
    expect(chips.map((chip) => chip.textContent)).toEqual([nearest, selector]);
    expect(chips.map((chip) => chip.getAttribute('title'))).toEqual([nearest, selector]);
    for (const chip of chips) {
      expect(chip.closest('[dir="ltr"]')).not.toBeNull();
    }

    await user.click(detailsToggle());
    const details = detailsRegion().textContent;
    for (const shown of [
      selector,
      `Visible ${REVEALED_LABEL}`,
      nearest,
      `Outer ${REVEALED_LABEL}`,
      `http://127.0.0.1:4100/workspace?label=${REVEALED_LABEL}`,
    ]) {
      expect(details, shown).toContain(shown);
    }

    // The markup stayed text: nothing was parsed out of it.
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('td')).toBeNull();
    expectNoRawDirectionControl(document.body);
    expectCleanConsole();
  });
});
