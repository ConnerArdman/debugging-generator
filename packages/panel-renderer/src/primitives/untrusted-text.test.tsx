/**
 * `primitives/untrusted-text` and the primitives that render through it: the
 * guarantee that what the design system puts on screen is the logical text.
 *
 * An invisible Unicode direction control inside captured or model-authored
 * text reorders the glyphs after it, so an escaped `</td><script>` is drawn
 * backwards while `textContent` still holds the truth. Pinned here:
 *
 *   - **The node formatter.** `formatUntrustedNode` reveals every string leaf
 *     of a node, maps arrays recursively with every element object — and so
 *     every key — preserved, returns an unchanged array as the same array, and
 *     leaves every other node exactly as given.
 *   - **One definition.** The string helpers re-exported here, and published
 *     through the barrel, are the very functions of `../utils/format`.
 *   - **Every text primitive.** `Text`, `Code` (inline and block), `Heading`,
 *     `Badge`, `Button` and `Tooltip` render the QA payload with printable
 *     markers, leave no raw control in the rendered text or in a `title` or
 *     `aria-label`, and create no element from the payload's markup. `data-*`
 *     attributes stay raw, because they are data rather than display.
 *   - **Machine text is isolated.** `Code` carries a default `dir="ltr"` on
 *     both forms, and a caller's own `dir` replaces it.
 *   - **The field, table and toolbar primitives.** `Select` (label, options,
 *     placeholder, hint, error), `Input` (label, hint, error), a `DataTable`
 *     cell whose renderer returns a bare string, and a `Toolbar` group name
 *     reveal the same way, while the values a caller reads back — a selected
 *     option's value, the typed text — stay raw.
 *
 * Every control below is written as an escape, never as the character, so
 * this suite is not itself a carrier of one.
 */

import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import * as barrel from '../index';
import * as format from '../utils/format';

import { Toolbar } from '../layout/Toolbar';

import { Badge } from './Badge';
import { Button } from './Button';
import { Code } from './Code';
import { DataTable } from './DataTable';
import type { DataTableColumn } from './DataTable';
import { Heading } from './Heading';
import { Input } from './Input';
import { Select } from './Select';
import { Text } from './Text';
import { Tooltip } from './Tooltip';
import {
  containsDirectionControl,
  formatUntrustedNode,
  formatUntrustedText,
} from './untrusted-text';

/** The QA report's payload: an override that draws an escaped script tag backwards. */
const PAYLOAD = 'QA_BIDI \u202E</td><script>alert(7)</script>\u202C';

/** The payload as it must display: both controls as the six printable characters of their escape. */
const REVEALED = 'QA_BIDI \\u202E</td><script>alert(7)</script>\\u202C';

/** The right-to-left override on its own, and its marker. */
const RLO = '\u202E';
const MARKER = '\\u202E';

/** The two attributes a reader hovers or hears, which must match the visible text. */
const DISPLAY_ATTRIBUTES = ['title', 'aria-label'] as const;

/**
 * Asserts the rendered subtree displays nothing a direction control could
 * reorder: no raw control in its text, and none in any element's `title` or
 * `aria-label` — and that the payload's markup stayed text.
 *
 * @param root The element `render` mounted into.
 */
function expectNothingReorders(root: HTMLElement): void {
  expect(containsDirectionControl(root.textContent)).toBe(false);
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attribute of DISPLAY_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value !== null) {
        expect(containsDirectionControl(value)).toBe(false);
      }
    }
  }
  expect(root.querySelector('script')).toBeNull();
  expect(root.querySelector('td')).toBeNull();
}

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  // No render here may warn: not a missing key from a mapped child list, not an
  // unnamed control from a revealed label.
  expect(consoleError).not.toHaveBeenCalled();
  consoleError.mockRestore();
});

describe('formatUntrustedNode', () => {
  it('reveals a string, and returns a string with no control as the same string', () => {
    expect(formatUntrustedNode(PAYLOAD)).toBe(REVEALED);
    expect(formatUntrustedNode('plain')).toBe('plain');
    expect(formatUntrustedNode('')).toBe('');
  });

  it('maps arrays recursively, keeping every element object and key', () => {
    const chip = <Code key="chip">{RLO}</Code>;
    const strong = <strong key="strong">x</strong>;
    const node: ReactNode = ['GET ', chip, [` ${RLO}slow`, strong, [RLO, 3]], null, false];

    const shown = formatUntrustedNode(node);

    expect(shown).toEqual(['GET ', chip, [` ${MARKER}slow`, strong, [MARKER, 3]], null, false]);
    if (!Array.isArray(shown)) {
      throw new Error('an array node was not mapped to an array');
    }
    const members: readonly ReactNode[] = shown;
    expect(members[1]).toBe(chip);
    expect(chip.key).toBe('chip');
    const nested = members[2];
    if (!Array.isArray(nested)) {
      throw new Error('a nested array was not mapped to an array');
    }
    const inner: readonly ReactNode[] = nested;
    expect(inner[1]).toBe(strong);
  });

  it('returns an array with nothing to reveal as the same array', () => {
    const node: ReactNode = ['a', <em key="e">b</em>, ['c', 1]];

    expect(formatUntrustedNode(node)).toBe(node);
  });

  it('leaves every node that is not a string or an array exactly as given', () => {
    const element = <span>{RLO}</span>;
    const set = new Set<ReactNode>([RLO]);

    expect(formatUntrustedNode(element)).toBe(element);
    expect(formatUntrustedNode(set)).toBe(set);
    expect(formatUntrustedNode(7)).toBe(7);
    expect(formatUntrustedNode(7n)).toBe(7n);
    expect(formatUntrustedNode(true)).toBe(true);
    expect(formatUntrustedNode(null)).toBeNull();
    expect(formatUntrustedNode(undefined)).toBeUndefined();
  });
});

describe('one definition of the reveal', () => {
  it('re-exports the string helpers of ../utils/format, not copies of them', () => {
    expect(formatUntrustedText).toBe(format.formatUntrustedText);
    expect(containsDirectionControl).toBe(format.containsDirectionControl);
  });

  it('publishes all three through the package barrel', () => {
    expect(barrel.formatUntrustedText).toBe(formatUntrustedText);
    expect(barrel.containsDirectionControl).toBe(containsDirectionControl);
    expect(barrel.formatUntrustedNode).toBe(formatUntrustedNode);
  });
});

describe('Text', () => {
  it('renders the payload, its title and its accessible name revealed', () => {
    const { container } = render(
      <Text title={PAYLOAD} aria-label={PAYLOAD}>
        {PAYLOAD}
      </Text>,
    );
    const text = container.querySelector('.dg-text');

    expect(text?.textContent).toBe(REVEALED);
    expect(text?.getAttribute('title')).toBe(REVEALED);
    expect(text?.getAttribute('aria-label')).toBe(REVEALED);
    expectNothingReorders(container);
  });

  it('reveals every string of a mixed child list and renders its elements unchanged', () => {
    const { container } = render(
      <Text as="p">
        {`${RLO}lead `}
        <strong>kept</strong>
        {[` ${RLO}a`, <em key="b">b</em>]}
      </Text>,
    );

    expect(container.textContent).toBe(`${MARKER}lead kept ${MARKER}ab`);
    expect(container.querySelector('strong')?.textContent).toBe('kept');
    expectNothingReorders(container);
  });

  it('keeps data attributes raw, because they are data rather than display', () => {
    const { container } = render(<Text data-value={PAYLOAD}>{PAYLOAD}</Text>);

    expect(container.querySelector('.dg-text')?.getAttribute('data-value')).toBe(PAYLOAD);
    expect(container.textContent).toBe(REVEALED);
  });

  it('adds no attribute a caller did not pass', () => {
    const { container } = render(<Text>plain</Text>);
    const text = container.querySelector('.dg-text');

    expect(text?.hasAttribute('title')).toBe(false);
    expect(text?.hasAttribute('aria-label')).toBe(false);
    expect(text?.textContent).toBe('plain');
  });
});

describe('Code', () => {
  it('renders the inline form revealed and left-to-right isolated', () => {
    const { container } = render(
      <Code title={PAYLOAD} aria-label={PAYLOAD}>
        {PAYLOAD}
      </Code>,
    );
    const code = container.querySelector('code');

    expect(code?.textContent).toBe(REVEALED);
    expect(code?.getAttribute('dir')).toBe('ltr');
    expect(code?.getAttribute('title')).toBe(REVEALED);
    expect(code?.getAttribute('aria-label')).toBe(REVEALED);
    expectNothingReorders(container);
  });

  it('renders the block form revealed, left-to-right isolated, with whitespace kept', () => {
    const statement = `SELECT 1\n  FROM ${RLO}t`;
    const { container } = render(
      <Code block title={statement} aria-label={statement}>
        {statement}
      </Code>,
    );
    const pre = container.querySelector('pre');

    expect(pre?.getAttribute('dir')).toBe('ltr');
    expect(pre?.querySelector('code')?.textContent).toBe(`SELECT 1\n  FROM ${MARKER}t`);
    expect(pre?.getAttribute('title')).toBe(`SELECT 1\n  FROM ${MARKER}t`);
    expect(pre?.getAttribute('tabindex')).toBe('0');
    expectNothingReorders(container);
  });

  it("lets a caller's own dir replace the default on both forms", () => {
    const { container } = render(
      <>
        <Code dir="rtl">inline</Code>
        <Code block dir="auto">
          block
        </Code>
      </>,
    );

    expect(container.querySelector('code:not(pre code)')?.getAttribute('dir')).toBe('rtl');
    expect(container.querySelector('pre')?.getAttribute('dir')).toBe('auto');
  });
});

describe('Heading', () => {
  it('renders the payload, its title and its accessible name revealed', () => {
    render(
      <Heading level={2} title={PAYLOAD} aria-label={PAYLOAD}>
        {PAYLOAD}
      </Heading>,
    );
    const heading = screen.getByRole('heading', { level: 2 });

    expect(heading.textContent).toBe(REVEALED);
    expect(heading.getAttribute('title')).toBe(REVEALED);
    expect(heading.getAttribute('aria-label')).toBe(REVEALED);
    expectNothingReorders(heading);
  });
});

describe('Badge', () => {
  it('renders the label, a string glyph, its title and its accessible name revealed', () => {
    const { container } = render(
      <Badge icon={RLO} title={PAYLOAD} aria-label={PAYLOAD}>
        {PAYLOAD}
      </Badge>,
    );
    const badge = container.querySelector('.dg-badge');

    expect(badge?.querySelector('.dg-badge__icon')?.textContent).toBe(MARKER);
    expect(badge?.textContent).toBe(`${MARKER}${REVEALED}`);
    expect(badge?.getAttribute('title')).toBe(REVEALED);
    expect(badge?.getAttribute('aria-label')).toBe(REVEALED);
    expectNothingReorders(container);
  });
});

describe('Button', () => {
  it('renders a visible label and its title revealed, named by the revealed text', () => {
    render(<Button title={PAYLOAD}>{PAYLOAD}</Button>);
    const button = screen.getByRole('button', { name: REVEALED });

    expect(within(button).getByText(REVEALED).className).toBe('dg-button__label');
    expect(button.getAttribute('title')).toBe(REVEALED);
    expectNothingReorders(button);
  });

  it('reveals an aria-label, so the accessible name matches what a sighted reader sees', () => {
    render(<Button aria-label={PAYLOAD}>{PAYLOAD}</Button>);
    const button = screen.getByRole('button', { name: REVEALED });

    expect(button.getAttribute('aria-label')).toBe(REVEALED);
    expectNothingReorders(button);
  });

  it('reveals the visually hidden name of an icon-only control', () => {
    const { container } = render(
      <Button iconOnly icon={<svg className="dg-icon" />}>
        {PAYLOAD}
      </Button>,
    );

    expect(container.querySelector('.dg-visually-hidden')?.textContent).toBe(REVEALED);
    expect(screen.getByRole('button', { name: REVEALED })).toBeDefined();
    expectNothingReorders(container);
  });

  it('keeps an absent title and aria-label absent', () => {
    render(<Button>Run</Button>);
    const button = screen.getByRole('button', { name: 'Run' });

    expect(button.hasAttribute('title')).toBe(false);
    expect(button.hasAttribute('aria-label')).toBe(false);
  });
});

describe('Tooltip', () => {
  it('shows its content revealed and leaves its trigger to render its own text', () => {
    const { container } = render(
      <Tooltip content={PAYLOAD}>
        <span data-trigger="yes">trigger</span>
      </Tooltip>,
    );

    const bubble = screen.getByRole('tooltip', { hidden: true });
    expect(bubble.textContent).toBe(REVEALED);
    expect(container.querySelector('[data-trigger="yes"]')?.textContent).toBe('trigger');
    expectNothingReorders(container);
  });

  it('reveals a composed description, string by string', () => {
    render(
      <Tooltip content={[`${RLO}GET `, <Code key="url">{`/api/${RLO}x`}</Code>]}>
        <Text tabIndex={-1}>{`row ${RLO}`}</Text>
      </Tooltip>,
    );
    const bubble = screen.getByRole('tooltip', { hidden: true });

    expect(bubble.textContent).toBe(`${MARKER}GET /api/${MARKER}x`);
    // A primitive trigger reveals its own text.
    expect(screen.getByText(`row ${MARKER}`)).toBeDefined();
  });
});

describe('Select', () => {
  it('reveals its label, option labels, placeholder, hint and error, and reports raw values', () => {
    const onValueChange = vi.fn<(next: string) => void>();
    const { container } = render(
      <Select
        label={PAYLOAD}
        value=""
        placeholder={PAYLOAD}
        hint={PAYLOAD}
        invalid
        errorMessage={PAYLOAD}
        options={[{ value: PAYLOAD, label: PAYLOAD }]}
        onValueChange={onValueChange}
      />,
    );
    const select = container.querySelector('select');
    const options = Array.from(container.querySelectorAll('option'));

    expect(container.querySelector('label')?.textContent).toBe(REVEALED);
    expect(options.map((option) => option.textContent)).toEqual([REVEALED, REVEALED]);
    expect(container.querySelector('.dg-field__hint')?.textContent).toBe(REVEALED);
    expect(container.querySelector('.dg-field__error')?.textContent).toBe(REVEALED);
    expectNothingReorders(container);

    // The option's value is data: it stays raw and is what the caller hears back.
    const option = options[1];
    expect(option?.getAttribute('value')).toBe(PAYLOAD);
    if (select === null || option === undefined) {
      throw new Error('the select and its option must render');
    }
    select.value = PAYLOAD;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onValueChange).toHaveBeenCalledWith(PAYLOAD);
  });
});

describe('Input', () => {
  it('reveals its label, hint and error, and leaves the typed value raw', () => {
    const { container } = render(
      <Input
        label={PAYLOAD}
        value={PAYLOAD}
        hint={PAYLOAD}
        invalid
        errorMessage={PAYLOAD}
        onValueChange={() => undefined}
      />,
    );

    expect(container.querySelector('label')?.textContent).toBe(REVEALED);
    expect(container.querySelector('.dg-field__hint')?.textContent).toBe(REVEALED);
    expect(container.querySelector('.dg-field__error')?.textContent).toBe(REVEALED);
    expectNothingReorders(container);
    // The developer's own input round-trips byte for byte.
    expect(container.querySelector('input')?.value).toBe(PAYLOAD);
  });
});

describe('DataTable', () => {
  interface Row {
    readonly id: string;
    readonly name: string;
  }

  const columns: readonly DataTableColumn<Row>[] = [
    { key: 'name', header: 'Name', rowHeader: true, cell: (row) => row.name },
  ];

  it('reveals a cell whose renderer returns a bare string, keyed by the raw row id', () => {
    const { container } = render(
      <DataTable
        caption="Operations"
        rows={[{ id: PAYLOAD, name: PAYLOAD }]}
        rowKey={(row) => row.id}
        columns={columns}
      />,
    );
    const cell = container.querySelector('.dg-data-table__cell');

    expect(cell?.textContent).toBe(REVEALED);
    expectNothingReorders(container);
  });
});

describe('Toolbar', () => {
  it('names its group with the revealed label', () => {
    render(<Toolbar label={PAYLOAD}>{null}</Toolbar>);
    const group = screen.getByRole('group', { name: REVEALED });

    expect(group.getAttribute('aria-label')).toBe(REVEALED);
    expectNothingReorders(group);
  });
});
