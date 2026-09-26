/**
 * The contract of `components/TargetBadge` — the editor's view of the element
 * selected in the Chrome DevTools panel (the `SelectedTarget` of AAP 0.4.2, as
 * the session record's `target` carries it) and the control that asks that
 * panel to enter picker mode again (`target.request`, AAP 0.7.3).
 *
 * Pinned here:
 *
 *   - **Every field of the descriptor renders, verbatim.** `tagName`,
 *     `selector`, `text`, each `componentChain` entry and `url` appear exactly
 *     as received — no case folding, no selector rewriting, no URL rebuilt
 *     through a parser.
 *   - **The chain keeps its order.** It is the React ownership path,
 *     nearest-first, rendered as an ordered list; asserting it as an ordered
 *     array is what stops a refactor from silently re-sorting it.
 *   - **One callback, no arguments.** The pick, re-pick and retry controls all
 *     raise `onRequestTarget()` exactly once per activation, with nothing
 *     passed — never the React event the primitives hand their handlers.
 *   - **Four states, never a blank or half-filled badge** (AAP 0.5.5), with
 *     the precedence error > pending > "No target" > target.
 *   - **Nothing is logged** (AAP 0.5.2): a descriptor carries a page URL, so
 *     no state may write to any `console` method.
 *
 * Every fixture value is neutral vocabulary written for this suite; no
 * inspected project's component names or routes appear in it (AAP 0.5.4).
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import type { SelectedTarget } from '@debuggen/protocol';

import { TargetBadge } from './TargetBadge';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/** Class the component puts on each entry of the component chain. */
const CHAIN_ITEM_SELECTOR = '.dgv-target__chain-item';

/** Class every state of the component carries on its root element. */
const ROOT_CLASS = 'dgv-target';

/** The nearest-first owner chain of the default fixture; deliberately not alphabetical. */
const CHAIN: readonly string[] = ['InnerTile', 'MiddleLayer', 'OuterFrame'];

/**
 * A complete, schema-shaped descriptor with any field overridden.
 *
 * The URL is in the query-redacted form the service forwards (every parameter
 * value replaced by `?`), which is the only form the webview ever receives.
 *
 * @param overrides Fields to replace in the default descriptor.
 * @returns A fresh `SelectedTarget`; the chain is copied so no case can mutate another's.
 */
function makeTarget(overrides?: Partial<SelectedTarget>): SelectedTarget {
  return {
    selector: 'main > section.pane:nth-of-type(2) > button[data-role="primary"]',
    tagName: 'button',
    text: 'Run the sample task',
    componentChain: [...CHAIN],
    url: 'http://localhost:4000/workspace/items?view=?&mode=?',
    ...overrides,
  };
}

/**
 * The same descriptor with the optional `text` key omitted, as the producer
 * sends it for an element that has no visible label.
 *
 * @param target The descriptor to copy.
 * @returns A copy without the `text` key.
 */
function withoutText(target: SelectedTarget): SelectedTarget {
  const { selector, tagName, componentChain, url } = target;
  return { selector, tagName, componentChain, url };
}

/**
 * The text of an element as assistive technology reads it: its `textContent`
 * with every `aria-hidden` subtree (the decorative chain separators) removed.
 *
 * @param element The element to read.
 * @returns The visible, announced text.
 */
function announcedText(element: Element): string {
  const copy = element.cloneNode(true);
  if (!(copy instanceof Element)) {
    throw new Error('expected an element clone');
  }
  copy.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => {
    hidden.remove();
  });
  return copy.textContent;
}

/**
 * The `textContent` of every `<code>` the component rendered, in document order.
 * The selector, each chain entry and the URL are all rendered through `Code`,
 * so this is how the suite checks them byte for byte, without the whitespace
 * normalisation `getByText` applies.
 *
 * @param container The render container.
 * @returns One string per `<code>` element.
 */
function codeTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('code'), (code) => code.textContent);
}

/**
 * The root element of the rendered state.
 *
 * @param container The render container.
 * @returns The component's single top-level element.
 */
function rootOf(container: HTMLElement): Element {
  const root = container.firstElementChild;
  if (root === null) {
    throw new Error('expected the component to render a root element');
  }
  expect(container.childElementCount).toBe(1);
  return root;
}

/** The five `console` methods a component could leak a descriptor through. */
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

/** Spies installed on every `console` method before each case. */
let consoleSpies: ReadonlyMap<ConsoleMethod, MockInstance>;

/**
 * Replaces each `console` method with a silent spy, so a call is both recorded
 * and kept out of the test output.
 *
 * @returns The spies, keyed by method.
 */
function spyOnConsole(): ReadonlyMap<ConsoleMethod, MockInstance> {
  return new Map(
    CONSOLE_METHODS.map((method) => [
      method,
      vi.spyOn(console, method).mockImplementation(() => undefined),
    ]),
  );
}

/**
 * Every recorded `console` call, keyed by method, so a failure names the
 * method that was used.
 *
 * @returns The number of calls per method.
 */
function consoleCallCounts(): Record<ConsoleMethod, number> {
  const counts: Record<ConsoleMethod, number> = { log: 0, info: 0, warn: 0, error: 0, debug: 0 };
  for (const [method, spy] of consoleSpies) {
    counts[method] = spy.mock.calls.length;
  }
  return counts;
}

const NO_CONSOLE_CALLS: Record<ConsoleMethod, number> = {
  log: 0,
  info: 0,
  warn: 0,
  error: 0,
  debug: 0,
};

beforeEach(() => {
  consoleSpies = spyOnConsole();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// A selected target
// ---------------------------------------------------------------------------

describe('TargetBadge with a selected target', () => {
  it('renders the tag name, selector, text, every chain entry and the URL', () => {
    const target = makeTarget();
    const { container } = render(<TargetBadge target={target} onRequestTarget={vi.fn()} />);

    expect(screen.queryByText(target.tagName)).not.toBeNull();
    expect(screen.queryByText(target.selector)).not.toBeNull();
    expect(screen.queryByText('Run the sample task')).not.toBeNull();
    for (const name of CHAIN) {
      expect(screen.queryByText(name)).not.toBeNull();
    }
    expect(screen.queryByText(target.url)).not.toBeNull();

    const codes = codeTexts(container);
    expect(codes).toContain(target.selector);
    expect(codes).toContain(target.url);
  });

  it('renders the owner chain as an ordered list, in the order given', () => {
    const { container } = render(<TargetBadge target={makeTarget()} onRequestTarget={vi.fn()} />);

    const list = screen.getByRole('list', { name: /components/i });
    expect(list.tagName).toBe('OL');

    const listItems = within(list).getAllByRole('listitem');
    expect(listItems).toHaveLength(CHAIN.length);

    const chainItems = Array.from(container.querySelectorAll(CHAIN_ITEM_SELECTOR));
    expect(chainItems).toEqual(listItems);
    expect(chainItems.map(announcedText)).toEqual(CHAIN);
  });

  it('keeps the chain separators decorative and between entries only', () => {
    const { container } = render(<TargetBadge target={makeTarget()} onRequestTarget={vi.fn()} />);

    const chainItems = Array.from(container.querySelectorAll(CHAIN_ITEM_SELECTOR));
    const first = chainItems[0];
    if (first === undefined) {
      throw new Error('expected a first chain entry');
    }
    expect(first.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0);
    for (const item of chainItems.slice(1)) {
      expect(item.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
    }
  });

  it('keeps repeated display names as separate entries, in position', () => {
    const chain = ['RepeatedShell', 'RepeatedShell', 'OuterFrame'];
    const { container } = render(
      <TargetBadge target={makeTarget({ componentChain: chain })} onRequestTarget={vi.fn()} />,
    );

    const chainItems = Array.from(container.querySelectorAll(CHAIN_ITEM_SELECTOR));
    expect(chainItems.map(announcedText)).toEqual(chain);
  });

  it('renders every value verbatim, without normalising the selector, tag name or URL', () => {
    // A URL parser would lower-case the host and drop the default port, and a
    // selector formatter would reflow the combinators; neither may happen.
    const target = makeTarget({
      selector: 'ul.items > li:nth-of-type(3) + li ~ li[data-state="open"]',
      tagName: 'DIV',
      url: 'http://LOCALHOST:80/Section/Item?view=?',
    });
    const { container } = render(<TargetBadge target={target} onRequestTarget={vi.fn()} />);

    const codes = codeTexts(container);
    expect(codes).toContain('ul.items > li:nth-of-type(3) + li ~ li[data-state="open"]');
    expect(codes).toContain('http://LOCALHOST:80/Section/Item?view=?');
    expect(codes).not.toContain(new URL(target.url).href);
    expect(screen.getByText('DIV').textContent).toBe('DIV');
  });

  it('omits the text line when the descriptor carries no text', () => {
    const target = withoutText(makeTarget());
    const { container } = render(<TargetBadge target={target} onRequestTarget={vi.fn()} />);

    expect(screen.queryByText('Run the sample task')).toBeNull();
    expect(container.querySelectorAll(CHAIN_ITEM_SELECTOR)).toHaveLength(CHAIN.length);
    expect(codeTexts(container)).toContain(target.selector);
  });

  it('says there is no component information instead of rendering an empty list', () => {
    const { container } = render(
      <TargetBadge target={makeTarget({ componentChain: [] })} onRequestTarget={vi.fn()} />,
    );

    expect(screen.queryByRole('list')).toBeNull();
    expect(container.querySelectorAll(CHAIN_ITEM_SELECTOR)).toHaveLength(0);
    expect(screen.queryByText(/no react component information/i)).not.toBeNull();
  });

  it('calls onRequestTarget exactly once, with no arguments, when the re-pick control is clicked', async () => {
    const user = userEvent.setup();
    const onRequestTarget = vi.fn<() => void>();
    render(<TargetBadge target={makeTarget()} onRequestTarget={onRequestTarget} />);

    expect(screen.getAllByRole('button')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /pick another element/i }));

    expect(onRequestTarget).toHaveBeenCalledTimes(1);
    expect(onRequestTarget.mock.calls).toEqual([[]]);
  });

  it('activates the re-pick control from the keyboard', async () => {
    const user = userEvent.setup();
    const onRequestTarget = vi.fn<() => void>();
    render(<TargetBadge target={makeTarget()} onRequestTarget={onRequestTarget} />);

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /pick another element/i }),
    );
    await user.keyboard('{Enter}');

    expect(onRequestTarget.mock.calls).toEqual([[]]);
  });

  it('carries the root class and appends the caller class', () => {
    const { container } = render(
      <TargetBadge target={makeTarget()} onRequestTarget={vi.fn()} className="host-slot" />,
    );

    const root = rootOf(container);
    expect(root.className).toContain(ROOT_CLASS);
    expect(root.className).toContain('host-slot');
  });
});

// ---------------------------------------------------------------------------
// No target
// ---------------------------------------------------------------------------

describe('TargetBadge without a target', () => {
  it('renders the explicit "No target" state with its generic message', () => {
    const { container } = render(<TargetBadge target={undefined} onRequestTarget={vi.fn()} />);

    expect(screen.queryByText('No target')).not.toBeNull();
    expect(screen.queryByText(/no element is selected/i)).not.toBeNull();
    // Honest about what the control does: it puts the DevTools panel into
    // picker mode, and names no application route or identifier.
    const message = screen.getByText(/no element is selected/i).textContent;
    expect(message).toMatch(/picker mode/i);
    expect(message).toMatch(/chrome devtools/i);
    expect(message).not.toMatch(/\/api\b/i);

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBeNull();
    expect(rootOf(container)).toBe(status);
    expect(status.className).toContain(ROOT_CLASS);
  });

  it('calls onRequestTarget exactly once, with no arguments, from its pick control', async () => {
    const user = userEvent.setup();
    const onRequestTarget = vi.fn<() => void>();
    render(<TargetBadge onRequestTarget={onRequestTarget} />);

    expect(screen.getAllByRole('button')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /^pick element$/i }));

    expect(onRequestTarget).toHaveBeenCalledTimes(1);
    expect(onRequestTarget.mock.calls).toEqual([[]]);
  });

  it('renders no part of a descriptor: no chain, no selector, no URL', () => {
    const { container } = render(<TargetBadge target={undefined} onRequestTarget={vi.fn()} />);

    expect(container.querySelectorAll(CHAIN_ITEM_SELECTOR)).toHaveLength(0);
    expect(screen.queryByRole('list')).toBeNull();
    expect(codeTexts(container)).toEqual([]);
    expect(screen.queryByText(/pick another element/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Error, pending and their precedence
// ---------------------------------------------------------------------------

describe('TargetBadge error and pending states', () => {
  it('renders the error as an alert and hides every target field', () => {
    const target = makeTarget();
    const { container } = render(
      <TargetBadge
        target={target}
        error="The picked node left the page."
        onRequestTarget={vi.fn()}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(rootOf(container)).toBe(alert);
    expect(alert.className).toContain(ROOT_CLASS);
    expect(within(alert).queryByText('The picked node left the page.')).not.toBeNull();

    expect(screen.queryByText(target.tagName)).toBeNull();
    expect(screen.queryByText(target.selector)).toBeNull();
    expect(screen.queryByText(target.url)).toBeNull();
    expect(screen.queryByText('Run the sample task')).toBeNull();
    expect(container.querySelectorAll(CHAIN_ITEM_SELECTOR)).toHaveLength(0);
    expect(codeTexts(container)).toEqual([]);
  });

  it('retries from the error state with exactly one argument-free call', async () => {
    const user = userEvent.setup();
    const onRequestTarget = vi.fn<() => void>();
    render(<TargetBadge error="The pick was cancelled." onRequestTarget={onRequestTarget} />);

    const alert = screen.getByRole('alert');
    expect(within(alert).getAllByRole('button')).toHaveLength(1);
    await user.click(within(alert).getByRole('button'));

    expect(onRequestTarget).toHaveBeenCalledTimes(1);
    expect(onRequestTarget.mock.calls).toEqual([[]]);
  });

  it('ignores a blank error and renders the target', () => {
    const target = makeTarget();
    const { container } = render(
      <TargetBadge target={target} error="   " onRequestTarget={vi.fn()} />,
    );

    expect(screen.queryByRole('alert')).toBeNull();
    expect(codeTexts(container)).toContain(target.selector);
  });

  it('renders a busy status while a pick is pending, instead of the previous target', () => {
    const target = makeTarget();
    const { container } = render(<TargetBadge target={target} pending onRequestTarget={vi.fn()} />);

    const status = screen.getByRole('status');
    expect(rootOf(container)).toBe(status);
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.className).toContain(ROOT_CLASS);
    // The request only switches the bound panel into picker mode; the label
    // must say that, never that an element is already being picked.
    expect(status.textContent).toMatch(/asking chrome devtools to enter picker mode/i);
    expect(status.textContent).not.toMatch(/waiting for an element/i);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(container.querySelectorAll(CHAIN_ITEM_SELECTOR)).toHaveLength(0);
    expect(codeTexts(container)).toEqual([]);
  });

  it('renders the busy status rather than "No target" when nothing is selected yet', () => {
    render(<TargetBadge pending onRequestTarget={vi.fn()} />);

    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText('No target')).toBeNull();
  });

  it('renders only the alert when error, pending and no target coincide', () => {
    const { container } = render(
      <TargetBadge
        target={undefined}
        pending
        error="The inspected tab was closed."
        onRequestTarget={vi.fn()}
      />,
    );

    expect(rootOf(container)).toBe(screen.getByRole('alert'));
    expect(screen.queryByRole('status')).toBeNull();
    expect(container.querySelector('[aria-busy]')).toBeNull();
    expect(screen.queryByText('No target')).toBeNull();
    expect(container.querySelectorAll(CHAIN_ITEM_SELECTOR)).toHaveLength(0);
  });

  it('lets the error win over a pending pick of a present target', () => {
    const target = makeTarget();
    const { container } = render(
      <TargetBadge target={target} pending error="The pick timed out." onRequestTarget={vi.fn()} />,
    );

    expect(rootOf(container)).toBe(screen.getByRole('alert'));
    expect(container.querySelector('[aria-busy]')).toBeNull();
    expect(codeTexts(container)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

describe('TargetBadge privacy', () => {
  it('writes nothing to any console method in any state or interaction', async () => {
    const user = userEvent.setup();
    const onRequestTarget = vi.fn<() => void>();
    const target = makeTarget({ componentChain: ['RepeatedShell', 'RepeatedShell'] });

    const { rerender } = render(<TargetBadge target={target} onRequestTarget={onRequestTarget} />);
    await user.click(screen.getByRole('button', { name: /pick another element/i }));

    rerender(<TargetBadge target={target} pending onRequestTarget={onRequestTarget} />);
    rerender(<TargetBadge target={undefined} onRequestTarget={onRequestTarget} />);
    await user.click(screen.getByRole('button', { name: /^pick element$/i }));

    rerender(
      <TargetBadge target={target} error="The pick failed." onRequestTarget={onRequestTarget} />,
    );
    await user.click(within(screen.getByRole('alert')).getByRole('button'));

    rerender(<TargetBadge target={withoutText(target)} onRequestTarget={onRequestTarget} />);

    expect(onRequestTarget).toHaveBeenCalledTimes(3);
    expect(consoleCallCounts()).toEqual(NO_CONSOLE_CALLS);
  });
});
