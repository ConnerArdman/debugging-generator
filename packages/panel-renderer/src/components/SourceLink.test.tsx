/**
 * `components/SourceLink` — the chip that starts the product's click-to-source
 * chain, and the harness the other component suites in this folder follow.
 *
 * ## What this suite is actually protecting
 *
 * A chip is hop 1 of a five-hop chain (AAP 0.4.2): the chip raises
 * `onOpenSource`, the host carries the location to the coordination service,
 * the service re-validates it against the session's project root, and the
 * editor opens the document with a selection. Every hop after this one is
 * blind — it acts on the object it receives — so **the object the chip emits
 * has to be the object it was given, field for field**. A dropped `symbol`, a
 * "normalised" separator or a line silently turned into a 0-based offset lands
 * the developer somewhere other than the evidence they clicked, which is the
 * one failure the product's headline behaviour cannot survive (acceptance test
 * 1, AAP 0.8.4). That is why the payload case below asserts the argument's key
 * set and its reference identity rather than just "was called".
 *
 * The second thing it protects is the component's *two* host shapes.
 * `../layout/SummaryHeader` renders this chip for a hypothesis's suggested
 * location while importing nothing from `../host`, and the editor webview
 * reuses these components with no provider mounted at all; the DevTools panel
 * renders them inside one. Both paths have to work — an inert chip in the first
 * case, an interactive control in the second — so the provider-less case is
 * asserted here rather than left to an integration test that only exercises the
 * panel.
 *
 * ## No empty / loading / error state, deliberately
 *
 * AAP 0.8.3 asks each component suite in this package for those three states.
 * `sourceLink` is the one catalog node with no `DataQuery`: its content was
 * resolved before the panel was assembled, it touches no `DataProvider`, and it
 * has nothing to be pending or failed about. No stub provider is invented here
 * to manufacture states the component cannot have. Its degenerate cases are the
 * real ones — no handler, no symbol, and a coordinate that never passed the
 * shared schema — and each has a case below.
 *
 * ## Harness conventions (this file establishes them for the folder)
 *
 *   - **Test API imported explicitly** from `vitest`. The `panel-renderer`
 *     project does enable `globals`, but only so that
 *     `@testing-library/react` can register its automatic cleanup on a global
 *     `afterEach`; every suite in this repository still names what it uses.
 *   - **`afterEach(cleanup)` registered explicitly**, for the same reason: the
 *     automatic registration is a property of the runner's configuration, not
 *     of this file, and a suite that leaks a mounted tree between cases fails
 *     later with a multiple-match error that reads like a component bug.
 *   - **In-file synthetic builders, no fixture files.** {@link makeLocation}
 *     returns a valid location and takes overrides; nothing here is read from
 *     disk or shared with another suite.
 *   - **Generic fixture vocabulary only** (AAP 0.5.4): a path, a symbol and a
 *     caption that belong to no application. `scripts/check-no-hardcoding.mjs`
 *     scans this text along with the rest of `packages/**`.
 *   - **Queries by role and accessible name**, or by exact visible text. Where
 *     a class genuinely is the contract — the compact and inert variants — the
 *     element is obtained semantically first and the class read off it. No
 *     `jest-dom` matcher is available in this repository, so class and
 *     attribute assertions go through `classList` and `getAttribute`.
 *   - **No timers, no `waitFor`, no snapshots.** Every case is synchronous
 *     apart from the `userEvent` activations it awaits.
 *
 * @see ./SourceLink for the component, its class contract and its three forms.
 * @see ../host/PanelActions for the interaction contract this suite exercises.
 */

import { formatSourceLocation } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { PanelActionsContext } from '../host/PanelActions';
import type { PanelActions, PanelEventRef } from '../host/PanelActions';
import { NOT_AVAILABLE_LABEL } from '../utils/format';
import { SourceLink } from './SourceLink';

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 *
 * Two paths, because the component has two shapes to be observed in. The
 * default one has three segments, so the non-compact chip is genuinely
 * abbreviated by `formatCompactPath` (which keeps the last two) and the
 * difference between the visible text and the announced target is observable;
 * {@link SHORT_LOCATION_FILE} has two, which survives that shortening and is
 * the only way to reach the chip that needs no description. Every value is
 * application-neutral by AAP 0.5.4.
 * ---------------------------------------------------------------------------
 */

/** The fixture's project-relative, POSIX file path. */
const LOCATION_FILE = 'src/example/widget.ts';

/** The fixture's symbol: the name the chip renders in its own run. */
const LOCATION_SYMBOL = 'handleAction';

/** The fixture's 1-based line. */
const LOCATION_LINE = 42;

/** The fixture's 1-based column. */
const LOCATION_COLUMN = 7;

/** The fixture's region end, which must never reach the screen. */
const LOCATION_END_LINE = 58;

/** The visible text of the default chip: the compacted path and the line. */
const CHIP_TEXT = '…/example/widget.ts:42';

/** The visible text of the compact chip: the file name and the line. */
const COMPACT_CHIP_TEXT = 'widget.ts:42';

/**
 * A two-segment path, which `formatCompactPath` returns unshortened.
 *
 * The one fixture that produces a chip showing everything its description
 * would: nothing is abbreviated, so nothing has to be recoverable from a
 * tooltip.
 */
const SHORT_LOCATION_FILE = 'src/widget.ts';

/** The visible text — and the whole truth — of a chip built on that path. */
const SHORT_CHIP_TEXT = 'src/widget.ts:42';

/** A caller-supplied caption, replacing the derived visible text. */
const CALLER_LABEL = 'Inspect the call site';

/** A caller-supplied class, which must be appended rather than substituted. */
const CALLER_CLASS = 'custom-chip-class';

/**
 * The accessible name the interactive chip must announce, spelled out rather
 * than derived through `formatSourceLocation`, so that this suite pins the
 * `Open <file>:<line>:<column>` shape instead of restating whatever the helper
 * currently returns.
 */
const ACCESSIBLE_NAME = `Open ${LOCATION_FILE}:${String(LOCATION_LINE)}:${String(LOCATION_COLUMN)}`;

/** A complete location: both optional fields present, both coordinates usable. */
const BASE_LOCATION: SourceLocation = {
  file: LOCATION_FILE,
  line: LOCATION_LINE,
  column: LOCATION_COLUMN,
  symbol: LOCATION_SYMBOL,
  endLine: LOCATION_END_LINE,
  resolvedBy: 'code-graph',
  confidence: 0.85,
};

/**
 * Overrides accepted by {@link makeLocation}.
 *
 * The two *optional* fields admit `undefined` explicitly — which `Partial`
 * does not under this repository's `exactOptionalPropertyTypes` — because
 * passing `{ symbol: undefined }` is how a case asks for a location *without*
 * that field, and the builder drops the key rather than storing the value.
 *
 * The five required fields stay non-nullable on purpose: a location with no
 * file or no line is not a location, and admitting `undefined` there would only
 * move the compiler's complaint out of a caller and into the builder's own
 * return type.
 */
type LocationOverrides = Partial<
  Pick<SourceLocation, 'file' | 'line' | 'column' | 'resolvedBy' | 'confidence'>
> & {
  readonly symbol?: string | undefined;
  readonly endLine?: number | undefined;
};

/**
 * A location for a case to render.
 *
 * @param overrides Fields to replace, or `undefined` to omit an optional one.
 * @returns A fresh location built from {@link BASE_LOCATION}.
 */
function makeLocation(overrides: LocationOverrides = {}): SourceLocation {
  const { file, line, column, symbol, endLine, resolvedBy, confidence } = {
    ...BASE_LOCATION,
    ...overrides,
  };

  return {
    file,
    line,
    column,
    resolvedBy,
    confidence,
    ...(symbol === undefined ? {} : { symbol }),
    ...(endLine === undefined ? {} : { endLine }),
  };
}

/**
 * An independent copy of a location, taken before a render so that the render
 * can be proved not to have touched it.
 *
 * Rebuilding through {@link makeLocation} is a *deep* copy for this shape: all
 * seven fields are primitives, so there is nothing below the top level to
 * share.
 *
 * @param location The location to copy.
 * @returns An equal object that is not the same object.
 */
function cloneLocation(location: SourceLocation): SourceLocation {
  return makeLocation(location);
}

/** The handler shape the chip resolves, from a prop or from the host. */
type OpenSourceHandler = (location: SourceLocation) => void;

/** A typed spy standing in for a host's `onOpenSource`. */
type OpenSourceSpy = Mock<OpenSourceHandler>;

/**
 * A spy for the open-source intent.
 *
 * Typed rather than bare, so a case that reads `spy.mock.calls` gets a
 * `SourceLocation` back instead of `any` and the assertions below stay
 * type-checked by `tsc -b` (this package's tests are program inputs).
 *
 * @returns A fresh spy.
 */
function makeOpenSourceSpy(): OpenSourceSpy {
  return vi.fn<OpenSourceHandler>();
}

/**
 * A complete host `PanelActions` whose `onOpenSource` is the given spy.
 *
 * Both required members are supplied — a host missing either is not a host —
 * and `onSelectEvent` is a spy too, so a case can assert that activating a
 * chip does not also announce an event selection.
 *
 * @param onOpenSource The open-source spy to install.
 * @param onSelectEvent The event-selection spy to install.
 * @returns The actions object to provide through {@link PanelActionsContext}.
 */
function makeActions(
  onOpenSource: OpenSourceSpy,
  onSelectEvent: Mock<(ref: PanelEventRef) => void>,
): PanelActions {
  return { onOpenSource, onSelectEvent };
}

/**
 * The single location a spy was called with.
 *
 * Fails the case when the handler did not run exactly once, which is the other
 * half of the payload contract: a chip that opens two editors per click is as
 * wrong as one that opens none.
 *
 * @param spy The spy to read.
 * @returns The location argument of its only call.
 */
function soleLocation(spy: OpenSourceSpy): SourceLocation {
  expect(spy).toHaveBeenCalledTimes(1);

  const [call] = spy.mock.calls;
  if (call === undefined) {
    throw new Error('the open-source handler recorded no call');
  }

  return call[0];
}

/**
 * The chip's root element, reached from an element inside it.
 *
 * Used for the inert form, which has no role to query by: a case finds the
 * visible text semantically and then reads the class contract off the root it
 * belongs to.
 *
 * @param inner An element inside the chip, obtained by a semantic query.
 * @returns The `.dg-source-link` root.
 */
function chipRootOf(inner: HTMLElement): HTMLElement {
  const root = inner.closest('.dg-source-link');
  if (!(root instanceof HTMLElement)) {
    throw new Error('the chip content is not inside a .dg-source-link root');
  }

  return root;
}

/**
 * Activates the chip named by the given accessible name.
 *
 * @param name The accessible name of the control to click.
 */
async function clickChip(name: string): Promise<void> {
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name }));
}

// Explicit, per the harness note above: automatic cleanup belongs to the
// runner's configuration, this guarantee belongs to the suite. Restoring spies
// in the same place keeps a `console` spy from one case out of the next.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SourceLink activation payload', () => {
  it('hands the prop handler the very location it was given, field for field', async () => {
    const location = makeLocation();
    const onOpenSource = makeOpenSourceSpy();

    // Taken BEFORE the render, and compared against afterwards. Comparing the
    // emitted object's keys against the live input alone would be satisfied by
    // a component that added a field to the input in place, because both sides
    // of that comparison would then be the mutated object.
    const expectedKeys = Object.keys(cloneLocation(location)).sort();

    render(<SourceLink location={location} onOpenSource={onOpenSource} />);

    const chip = screen.getByRole('button', { name: ACCESSIBLE_NAME });
    expect(chip.classList.contains('dg-is-static')).toBe(false);

    // Rendering a chip is not activating it: nothing opens an editor until the
    // developer asks. A chip that navigated on mount would hijack every panel
    // that contains one.
    expect(onOpenSource).toHaveBeenCalledTimes(0);

    await clickChip(ACCESSIBLE_NAME);

    const received = soleLocation(onOpenSource);

    // Equal, and the same key set: a dropped `symbol`/`endLine`/`resolvedBy`/
    // `confidence` and an invented extra field both fail here.
    expect(received).toEqual(location);
    expect(Object.keys(received).sort()).toEqual(Object.keys(location).sort());
    expect(Object.keys(received).sort()).toEqual(expectedKeys);
    expect(Object.keys(received).sort()).toEqual([
      'column',
      'confidence',
      'endLine',
      'file',
      'line',
      'resolvedBy',
      'symbol',
    ]);

    // And the same object. The component closes over what it was given and
    // forwards it by reference; a copy would be a place for a future "helpful"
    // normalisation to hide.
    expect(received).toBe(location);

    // The path is not rewritten: still project-relative, still POSIX.
    expect(received.file).toBe(LOCATION_FILE);
    expect(received.file.startsWith('/')).toBe(false);
    expect(received.file).not.toContain('\\');

    // Both axes are still 1-based and unadjusted; the editor owns that
    // subtraction, and a chip that pre-empted it would be off by one.
    expect(received.line).toBe(LOCATION_LINE);
    expect(received.column).toBe(LOCATION_COLUMN);
    expect(received.endLine).toBe(LOCATION_END_LINE);
    expect(received.symbol).toBe(LOCATION_SYMBOL);
    expect(received.resolvedBy).toBe('code-graph');
    expect(received.confidence).toBe(0.85);

    // The canonical label the rest of the product prints for this location is
    // the one the control announced.
    expect(chip.getAttribute('aria-label')).toBe(`Open ${formatSourceLocation(location)}`);
  });

  it("falls back to the host's actions when no handler prop is given", async () => {
    const location = makeLocation();
    const onOpenSource = makeOpenSourceSpy();
    const onSelectEvent = vi.fn<(ref: PanelEventRef) => void>();

    render(
      <PanelActionsContext.Provider value={makeActions(onOpenSource, onSelectEvent)}>
        <SourceLink location={location} />
      </PanelActionsContext.Provider>,
    );

    await clickChip(ACCESSIBLE_NAME);

    const received = soleLocation(onOpenSource);
    expect(received).toEqual(location);
    expect(Object.keys(received).sort()).toEqual(Object.keys(location).sort());
    expect(received).toBe(location);

    // Opening source is not selecting an event; the two intents stay separate.
    expect(onSelectEvent).toHaveBeenCalledTimes(0);
  });

  it('prefers the handler prop over the host actions', async () => {
    const location = makeLocation();
    const fromProp = makeOpenSourceSpy();
    const fromHost = makeOpenSourceSpy();
    const onSelectEvent = vi.fn<(ref: PanelEventRef) => void>();

    render(
      <PanelActionsContext.Provider value={makeActions(fromHost, onSelectEvent)}>
        <SourceLink location={location} onOpenSource={fromProp} />
      </PanelActionsContext.Provider>,
    );

    await clickChip(ACCESSIBLE_NAME);

    expect(soleLocation(fromProp)).toBe(location);
    expect(fromHost).toHaveBeenCalledTimes(0);
    expect(onSelectEvent).toHaveBeenCalledTimes(0);
  });
});

describe('SourceLink without a resolvable handler', () => {
  it('renders a static chip rather than a control that leads nowhere', () => {
    const location = makeLocation();

    // The editor webview's path: no provider above it, no handler prop. It has
    // to render, and it has to render as a label.
    expect(() => render(<SourceLink location={location} />)).not.toThrow();

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();

    const fileRun = screen.getByText(CHIP_TEXT);
    expect(fileRun.textContent).toBe(CHIP_TEXT);
    expect(screen.getByText(LOCATION_SYMBOL).textContent).toBe(LOCATION_SYMBOL);

    const root = chipRootOf(fileRun);
    expect(root.tagName).toBe('SPAN');
    expect(root.classList.contains('dg-source-link')).toBe(true);
    expect(root.classList.contains('dg-is-static')).toBe(true);

    // Not a dead control: no role, no tab stop, nothing to activate.
    expect(root.getAttribute('role')).toBeNull();
    expect(root.getAttribute('tabindex')).toBeNull();
    expect(root.querySelector('button')).toBeNull();

    // The full target stays reachable through the tooltip's description, which
    // is in the accessibility tree even while the bubble is closed.
    expect(
      screen.getByText(`${LOCATION_SYMBOL} — ${formatSourceLocation(location)}`),
    ).toBeDefined();
  });

  it('marks the interactive chip as not static', () => {
    render(<SourceLink location={makeLocation()} onOpenSource={makeOpenSourceSpy()} />);

    const chip = screen.getByRole('button', { name: ACCESSIBLE_NAME });
    expect(chip.tagName).toBe('BUTTON');
    expect(chip.getAttribute('type')).toBe('button');
    expect(chip.classList.contains('dg-is-static')).toBe(false);
  });
});

describe('SourceLink tooltip wrapping', () => {
  it('describes a chip whose visible text hides part of the target', () => {
    const location = makeLocation();

    render(<SourceLink location={location} onOpenSource={makeOpenSourceSpy()} />);

    // The path lost its first segment on screen, so the full symbol-first form
    // has to stay reachable - which, for a closed bubble, means staying in the
    // accessibility tree rather than appearing on hover alone.
    const description = screen.getByRole('tooltip');
    expect(description.textContent).toBe(`${LOCATION_SYMBOL} — ${formatSourceLocation(location)}`);

    const chip = screen.getByRole('button', { name: ACCESSIBLE_NAME });
    expect(chip.getAttribute('aria-describedby')).toBe(description.getAttribute('id'));
  });

  it('leaves a chip that shows everything unwrapped', () => {
    const location = makeLocation({ file: SHORT_LOCATION_FILE });

    render(<SourceLink location={location} onOpenSource={makeOpenSourceSpy()} />);

    // Two segments survive `formatCompactPath` intact and the symbol is on
    // screen, so the chip and its description would say the same thing. No
    // bubble is rendered, and the control carries no description to resolve.
    expect(screen.getByText(SHORT_CHIP_TEXT).textContent).toBe(SHORT_CHIP_TEXT);
    expect(screen.queryByRole('tooltip')).toBeNull();

    const chip = screen.getByRole('button', {
      name: `Open ${formatSourceLocation(location)}`,
    });
    expect(chip.getAttribute('aria-describedby')).toBeNull();
    expect(chip.closest('.dg-tooltip')).toBeNull();
  });
});

describe('SourceLink accessible name', () => {
  it('announces the file, the line and the column of the target', () => {
    const location = makeLocation();

    render(<SourceLink location={location} onOpenSource={makeOpenSourceSpy()} />);

    const chip = screen.getByRole('button', { name: ACCESSIBLE_NAME });
    expect(chip.getAttribute('aria-label')).toBe(ACCESSIBLE_NAME);

    // The visible text is abbreviated; the announced target is not. Both facts
    // in one place, because the point of the name is that it survives the
    // abbreviation.
    expect(chip.textContent).toContain(CHIP_TEXT);
    expect(chip.textContent).not.toContain(ACCESSIBLE_NAME);
    expect(chip.textContent).not.toContain(`:${String(LOCATION_COLUMN)}`);
  });

  it('keeps that name when compact, showSymbol or a label abbreviate the chip', () => {
    const location = makeLocation();

    const abbreviations: readonly ReactElement[] = [
      <SourceLink location={location} compact onOpenSource={makeOpenSourceSpy()} />,
      <SourceLink location={location} showSymbol={false} onOpenSource={makeOpenSourceSpy()} />,
      <SourceLink location={location} label={CALLER_LABEL} onOpenSource={makeOpenSourceSpy()} />,
      <SourceLink
        location={location}
        compact
        showSymbol={false}
        label={CALLER_LABEL}
        onOpenSource={makeOpenSourceSpy()}
      />,
    ];

    for (const element of abbreviations) {
      const view = render(element);

      expect(screen.getByRole('button', { name: ACCESSIBLE_NAME }).getAttribute('aria-label')).toBe(
        ACCESSIBLE_NAME,
      );

      view.unmount();
    }
  });
});

describe('SourceLink variants', () => {
  it('shows the symbol run by default and hides it on request', () => {
    const location = makeLocation();

    const withSymbol = render(
      <SourceLink location={location} onOpenSource={makeOpenSourceSpy()} />,
    );
    expect(screen.getByText(LOCATION_SYMBOL).classList.contains('dg-source-link__symbol')).toBe(
      true,
    );
    withSymbol.unmount();

    render(
      <SourceLink location={location} showSymbol={false} onOpenSource={makeOpenSourceSpy()} />,
    );

    expect(screen.queryByText(LOCATION_SYMBOL)).toBeNull();
    expect(screen.getByText(CHIP_TEXT).textContent).toBe(CHIP_TEXT);
  });

  it('reduces the chip to the file name and the line in the compact variant', () => {
    render(<SourceLink location={makeLocation()} compact onOpenSource={makeOpenSourceSpy()} />);

    const chip = screen.getByRole('button', { name: ACCESSIBLE_NAME });
    expect(chip.classList.contains('dg-source-link--compact')).toBe(true);
    expect(screen.getByText(COMPACT_CHIP_TEXT).textContent).toBe(COMPACT_CHIP_TEXT);
    expect(screen.queryByText(CHIP_TEXT)).toBeNull();
    expect(screen.queryByText(LOCATION_SYMBOL)).toBeNull();
  });

  it('omits the compact class when the caller did not ask for it', () => {
    render(<SourceLink location={makeLocation()} onOpenSource={makeOpenSourceSpy()} />);

    expect(
      screen
        .getByRole('button', { name: ACCESSIBLE_NAME })
        .classList.contains('dg-source-link--compact'),
    ).toBe(false);
  });

  it("replaces the chip's visible text with a caller label", () => {
    render(
      <SourceLink
        location={makeLocation()}
        label={CALLER_LABEL}
        onOpenSource={makeOpenSourceSpy()}
      />,
    );

    const chip = screen.getByRole('button', { name: ACCESSIBLE_NAME });
    expect(screen.getByText(CALLER_LABEL).textContent).toBe(CALLER_LABEL);
    expect(screen.queryByText(CHIP_TEXT)).toBeNull();
    expect(screen.queryByText(LOCATION_SYMBOL)).toBeNull();
    expect(chip.getAttribute('aria-label')).toBe(ACCESSIBLE_NAME);
  });

  it("appends the caller's class after the chip's own", () => {
    render(
      <SourceLink
        location={makeLocation()}
        className={CALLER_CLASS}
        onOpenSource={makeOpenSourceSpy()}
      />,
    );

    const chip = screen.getByRole('button', { name: ACCESSIBLE_NAME });
    const classes = Array.from(chip.classList);

    expect(classes).toContain('dg-source-link');
    expect(classes).toContain(CALLER_CLASS);
    expect(classes.at(-1)).toBe(CALLER_CLASS);
  });

  it('renders the path and the line alone when the location carries no symbol', async () => {
    const location = makeLocation({ symbol: undefined, endLine: undefined });
    expect(Object.keys(location).sort()).toEqual([
      'column',
      'confidence',
      'file',
      'line',
      'resolvedBy',
    ]);

    const onOpenSource = makeOpenSourceSpy();
    render(<SourceLink location={location} onOpenSource={onOpenSource} />);

    expect(screen.queryByText(LOCATION_SYMBOL)).toBeNull();
    expect(screen.getByText(CHIP_TEXT).textContent).toBe(CHIP_TEXT);

    await clickChip(ACCESSIBLE_NAME);

    // A five-field location travels as a five-field location: the absent
    // optional fields are not filled in on the way out.
    const received = soleLocation(onOpenSource);
    expect(received).toBe(location);
    expect(Object.keys(received).sort()).toEqual(Object.keys(location).sort());
    expect('symbol' in received).toBe(false);
    expect('endLine' in received).toBe(false);
  });
});

describe('SourceLink unresolved coordinates', () => {
  it('omits a line it cannot use instead of printing NaN or a zero position', () => {
    // Values a validated location can never hold, and exactly what reaches a
    // renderer from an object that never passed the shared schema.
    const unusableLines: readonly number[] = [Number.NaN, 0, -3, 4.5];
    const expectedName = `Open ${LOCATION_FILE}:${NOT_AVAILABLE_LABEL}:${String(LOCATION_COLUMN)}`;

    for (const line of unusableLines) {
      const location = makeLocation({ line });
      const view = render(<SourceLink location={location} onOpenSource={makeOpenSourceSpy()} />);

      const chip = screen.getByRole('button', { name: expectedName });
      const visible = chip.textContent ?? '';

      // The file is still identified, the unusable coordinate simply is not
      // shown - not as `NaN`, not as `0`, and not as the raw value.
      expect(visible).toContain('…/example/widget.ts');
      expect(visible).not.toContain('NaN');
      expect(visible).not.toContain(':0');
      expect(visible).not.toContain(String(line));

      // And nothing anywhere in the rendered tree - chip, tooltip description,
      // accessible name - says `NaN` either.
      expect(view.container.textContent ?? '').not.toContain('NaN');
      expect(chip.getAttribute('aria-label')).toBe(expectedName);

      view.unmount();
    }
  });

  it('names an unusable column with the package label as well', () => {
    const location = makeLocation({ column: Number.NaN });
    const expectedName = `Open ${LOCATION_FILE}:${String(LOCATION_LINE)}:${NOT_AVAILABLE_LABEL}`;

    const view = render(<SourceLink location={location} onOpenSource={makeOpenSourceSpy()} />);

    // The line is usable, so it stays on the chip; only the column is absent.
    expect(screen.getByText(CHIP_TEXT).textContent).toBe(CHIP_TEXT);
    expect(screen.getByRole('button', { name: expectedName }).getAttribute('aria-label')).toBe(
      expectedName,
    );
    expect(view.container.textContent ?? '').not.toContain('NaN');
  });
});

describe('SourceLink purity', () => {
  it('does not modify the location it forwards', async () => {
    const location = makeLocation();
    const snapshot = cloneLocation(location);
    expect(snapshot).not.toBe(location);

    const onOpenSource = makeOpenSourceSpy();
    render(<SourceLink location={location} onOpenSource={onOpenSource} />);

    await clickChip(ACCESSIBLE_NAME);

    expect(soleLocation(onOpenSource)).toBe(location);
    expect(location).toEqual(snapshot);
    expect(Object.keys(location).sort()).toEqual(Object.keys(snapshot).sort());
  });

  it('writes nothing to the console in either form', async () => {
    // A component that renders inside a developer tool must not narrate: the
    // panel's console is the developer's own debugging surface (AAP 0.5.2), and
    // the only console path in this subtree is the button primitive's unnamed-
    // control diagnostic, which a named chip must never trip.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const location = makeLocation();
    const interactive = render(
      <SourceLink location={location} onOpenSource={makeOpenSourceSpy()} />,
    );
    await clickChip(ACCESSIBLE_NAME);
    interactive.unmount();

    render(<SourceLink location={location} />);
    expect(screen.getByText(CHIP_TEXT).textContent).toBe(CHIP_TEXT);

    expect(errorSpy).toHaveBeenCalledTimes(0);
    expect(warnSpy).toHaveBeenCalledTimes(0);
    expect(logSpy).toHaveBeenCalledTimes(0);
  });
});
