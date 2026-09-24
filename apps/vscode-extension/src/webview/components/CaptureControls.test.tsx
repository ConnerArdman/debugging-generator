/**
 * `components/CaptureControls` — starting and stopping the capture from the VS Code view.
 *
 * What this suite protects:
 *
 *   - the callbacks: `onStart` and `onStop` fire exactly once, with no arguments, and never
 *     from a disabled control;
 *   - the disabled combinations driven by `canStart` and `canStop`, and `pending` replacing the
 *     controls so no action can be raised twice;
 *   - the capture state region: a polite status live region whose indicator carries the
 *     capturing class and is always accompanied by a text label, referenced by both controls;
 *   - the event-count ruling: no digit is ever rendered, because the editor never receives the
 *     telemetry stream (AAP 0.4.2, 0.5.4);
 *   - the "Reproduce the issue now." prompt while armed and not yet capturing;
 *   - the states of AAP 0.5.5 and their precedence (error > pending > unavailable > controls);
 *   - focus following the action across the pending state, without stealing it;
 *   - the design-system shape: no heading, no inline style, the root block class composed with
 *     the caller's, and every rendered button a `type="button"` so the webview never submits;
 *   - silence: nothing reaches the console in any state (AAP 0.5.2).
 *
 * Harness conventions follow the rest of the repository: the Vitest API is imported explicitly,
 * `cleanup` is registered explicitly, a fresh `userEvent.setup()` drives each interactive case,
 * elements are found by role and accessible name, and — with no `jest-dom` in this repository —
 * state is read from DOM properties. Fixture strings are generic product vocabulary written for
 * this suite; no inspected project's names or routes appear in it (AAP 0.5.4).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { CaptureControls } from './CaptureControls';
import type { CaptureControlsProps } from './CaptureControls';

const START_NAME = 'Start capture';
const STOP_NAME = 'Stop capture';
const RETRY_NAME = 'Capture again';
const ARMED_PROMPT = 'Reproduce the issue now.';
const PENDING_TEXT = 'Updating the capture…';
const UNAVAILABLE_MESSAGE = 'Capture becomes available once instrumentation is ready.';

/** A number followed by event vocabulary — the shape any live counter would take. */
const EVENT_COUNT_PATTERN = /\d+\s*(events?|captured)/i;

/** The five console methods the component must never reach, whatever its state (AAP 0.5.2). */
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

/** The spies installed for the running case, paired with the method they replace. */
let consoleSpies: ReadonlyArray<readonly [ConsoleMethod, MockInstance]> = [];

beforeEach(() => {
  // Replaced with a no-op so a stray write fails the case below with its arguments, rather than
  // scrolling past in the run output.
  consoleSpies = CONSOLE_METHODS.map(
    (method) => [method, vi.spyOn(console, method).mockImplementation(() => undefined)] as const,
  );
});

afterEach(() => {
  // The tree is unmounted first so the silence check also covers unmounting, and the spies and
  // timers are restored even when that check fails, so one noisy case cannot leak into the next.
  try {
    cleanup();
    for (const [method, spy] of consoleSpies) {
      expect(spy, `console.${method} must never be called`).not.toHaveBeenCalled();
    }
  } finally {
    consoleSpies = [];
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

/** Props for a session that is ready to capture, with fresh spies for both callbacks. */
function readyProps(overrides: Partial<CaptureControlsProps> = {}): CaptureControlsProps {
  return {
    capturing: false,
    canStart: true,
    canStop: false,
    onStart: vi.fn<() => void>(),
    onStop: vi.fn<() => void>(),
    ...overrides,
  };
}

/** Props for a session whose capture window is open. */
function capturingProps(overrides: Partial<CaptureControlsProps> = {}): CaptureControlsProps {
  return readyProps({ capturing: true, canStart: false, canStop: true, ...overrides });
}

/** A control by its accessible name, narrowed to its element type. */
function getButton(name: string): HTMLButtonElement {
  const button = screen.getByRole('button', { name });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`expected "${name}" to be a <button>`);
  }
  return button;
}

/** The capture state region: the polite live region that carries the label. */
function getStateRegion(container: HTMLElement): HTMLElement {
  const region = container.querySelector<HTMLElement>('.dgv-capture__state');
  if (region === null) {
    throw new Error('expected the capture state region to be rendered');
  }
  return region;
}

/** The indicator dot inside the state region. */
function getIndicator(container: HTMLElement): HTMLElement {
  const indicator = container.querySelector<HTMLElement>('.dgv-capture__indicator');
  if (indicator === null) {
    throw new Error('expected the capture indicator to be rendered');
  }
  return indicator;
}

describe('CaptureControls — controls', () => {
  it('renders both controls as buttons, under the root block class composed with the caller class', () => {
    const { container } = render(<CaptureControls {...readyProps()} className="extra-placement" />);

    const root = container.firstElementChild;
    expect(root?.classList.contains('dgv-capture')).toBe(true);
    expect(root?.classList.contains('extra-placement')).toBe(true);

    const start = getButton(START_NAME);
    const stop = getButton(STOP_NAME);
    expect(start.type).toBe('button');
    expect(stop.type).toBe('button');
    expect(start.classList.contains('dg-button--primary')).toBe(true);
    expect(stop.classList.contains('dg-button--secondary')).toBe(true);

    // Distinct actions, not a toggle.
    expect(start.hasAttribute('aria-pressed')).toBe(false);
    expect(stop.hasAttribute('aria-pressed')).toBe(false);
  });

  it('leaves no stray class when the caller class is blank', () => {
    const { container } = render(<CaptureControls {...readyProps()} className="  " />);

    const root = container.firstElementChild;
    expect(root?.getAttribute('class')).toBe('dgv-capture');
  });

  it('raises onStart exactly once with no arguments', async () => {
    const user = userEvent.setup();
    const props = readyProps();
    render(<CaptureControls {...props} />);

    await user.click(getButton(START_NAME));

    expect(props.onStart).toHaveBeenCalledTimes(1);
    expect(props.onStart).toHaveBeenCalledWith();
    expect(props.onStop).not.toHaveBeenCalled();
  });

  it('raises onStart from the keyboard as well', async () => {
    const user = userEvent.setup();
    const props = readyProps();
    render(<CaptureControls {...props} />);

    getButton(START_NAME).focus();
    await user.keyboard('{Enter}');

    expect(props.onStart).toHaveBeenCalledTimes(1);
    expect(props.onStart).toHaveBeenCalledWith();
    expect(props.onStop).not.toHaveBeenCalled();
  });

  it('raises onStop exactly once with no arguments', async () => {
    const user = userEvent.setup();
    const props = capturingProps();
    render(<CaptureControls {...props} />);

    await user.click(getButton(STOP_NAME));

    expect(props.onStop).toHaveBeenCalledTimes(1);
    expect(props.onStop).toHaveBeenCalledWith();
    expect(props.onStart).not.toHaveBeenCalled();
  });

  it('enables only the start control while a capture can start', () => {
    render(<CaptureControls {...readyProps()} />);

    expect(getButton(START_NAME).disabled).toBe(false);
    expect(getButton(STOP_NAME).disabled).toBe(true);
  });

  it('enables only the stop control while a capture can stop', () => {
    render(<CaptureControls {...capturingProps()} />);

    expect(getButton(START_NAME).disabled).toBe(true);
    expect(getButton(STOP_NAME).disabled).toBe(false);
  });

  it('enables both controls when the caller permits both', () => {
    render(<CaptureControls {...readyProps({ canStop: true })} />);

    expect(getButton(START_NAME).disabled).toBe(false);
    expect(getButton(STOP_NAME).disabled).toBe(false);
  });

  it('keeps a running capture visible with both controls disabled when neither is permitted', () => {
    const { container } = render(<CaptureControls {...capturingProps({ canStop: false })} />);

    expect(getButton(START_NAME).disabled).toBe(true);
    expect(getButton(STOP_NAME).disabled).toBe(true);
    expect(getStateRegion(container).textContent).toBe('Capturing');
  });

  it('raises nothing from a disabled control', async () => {
    const user = userEvent.setup();
    const props = readyProps({ canStart: false, canStop: false, capturing: true });
    render(<CaptureControls {...props} />);

    await user.click(getButton(START_NAME));
    await user.click(getButton(STOP_NAME));
    fireEvent.click(getButton(START_NAME));
    fireEvent.click(getButton(STOP_NAME));

    expect(props.onStart).not.toHaveBeenCalled();
    expect(props.onStop).not.toHaveBeenCalled();
  });

  it('disables both actions while a request is pending, by replacing the controls', async () => {
    const user = userEvent.setup();
    // Both actions would otherwise be permitted: `pending` alone must take them away.
    const props = readyProps({ canStop: true, pending: true });
    render(<CaptureControls {...props} />);

    // The component documents that the busy placeholder REPLACES the controls, so neither action
    // exists to be raised a second time before the host reports the outcome.
    expect(screen.queryByRole('button', { name: START_NAME })).toBeNull();
    expect(screen.queryByRole('button', { name: STOP_NAME })).toBeNull();
    expect(screen.queryAllByRole('button')).toEqual([]);

    await user.keyboard('{Enter}');
    await user.keyboard(' ');

    expect(props.onStart).not.toHaveBeenCalled();
    expect(props.onStop).not.toHaveBeenCalled();
  });

  it('renders every button as type="button" in every state, so the webview never submits', () => {
    const states: CaptureControlsProps[] = [
      readyProps(),
      readyProps({ armed: true }),
      readyProps({ canStop: true }),
      capturingProps(),
      capturingProps({ canStop: false }),
      readyProps({ error: 'The capture could not start.', onRetry: vi.fn<() => void>() }),
    ];

    for (const state of states) {
      const { container, unmount } = render(<CaptureControls {...state} />);
      const buttons = Array.from(container.querySelectorAll('button'));
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) {
        expect(button.type).toBe('button');
        expect(button.getAttribute('type')).toBe('button');
      }
      unmount();
    }
  });
});

describe('CaptureControls — capture state region', () => {
  it('is a polite status region that both controls reference', () => {
    const { container } = render(<CaptureControls {...readyProps()} />);

    const region = getStateRegion(container);
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.id).not.toBe('');
    // A capture transition is routine news, never an interruption.
    expect(region.getAttribute('role')).not.toBe('alert');
    expect(region.getAttribute('aria-live')).not.toBe('assertive');
    expect(screen.queryByRole('alert')).toBeNull();

    expect(getButton(START_NAME).getAttribute('aria-describedby')).toBe(region.id);
    expect(getButton(STOP_NAME).getAttribute('aria-describedby')).toBe(region.id);
  });

  it('marks the indicator as capturing and labels it in text while a capture runs', () => {
    const { container } = render(<CaptureControls {...capturingProps()} />);

    const indicator = getIndicator(container);
    expect(indicator.classList.contains('dgv-capture__indicator--capturing')).toBe(true);
    expect(indicator.getAttribute('aria-hidden')).toBe('true');

    // Colour alone never carries the meaning (AAP 0.6.4): the dot is hidden, the words are not,
    // and they sit in the same polite region as the dot.
    const region = getStateRegion(container);
    expect(region.contains(indicator)).toBe(true);
    expect((region.textContent ?? '').trim().length).toBeGreaterThan(0);
    expect(region.textContent).toBe('Capturing');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the resting indicator with its own label while no capture runs', () => {
    const { container } = render(<CaptureControls {...readyProps()} />);

    const indicator = getIndicator(container);
    expect(indicator.classList.contains('dgv-capture__indicator--capturing')).toBe(false);
    expect(getStateRegion(container).textContent).toBe('Not capturing');
  });

  it('updates the same live region when the capture starts and stops', () => {
    const props = readyProps();
    const { container, rerender } = render(<CaptureControls {...props} />);
    const region = getStateRegion(container);

    rerender(<CaptureControls {...props} capturing canStart={false} canStop />);
    expect(getStateRegion(container)).toBe(region);
    expect(region.textContent).toBe('Capturing');

    rerender(<CaptureControls {...props} />);
    expect(getStateRegion(container)).toBe(region);
    expect(region.textContent).toBe('Not capturing');
  });

  /*
   * THE NO-EVENT-COUNT RULING. The editor shows THAT a capture is running, never HOW MUCH has
   * arrived: the service routes `telemetry.tail` to the DevTools panel only, so the extension host
   * receives no event stream (AAP 0.4.2) and any number rendered here would be fabricated, which
   * AAP 0.5.4 forbids. The DevTools panel's own capture controls legitimately show a live counter;
   * these cases fail the moment someone "improves" the editor's controls with one.
   */
  it('never renders a numeric event count while capturing', () => {
    const { container } = render(<CaptureControls {...capturingProps({ armed: true })} />);

    const root = container.firstElementChild;
    const rootText = root?.textContent ?? '';
    expect(rootText).toMatch(/Capturing/);
    expect(rootText).not.toMatch(EVENT_COUNT_PATTERN);
    expect(container.textContent ?? '').not.toMatch(EVENT_COUNT_PATTERN);

    // Stricter: the state region holds no digit sequence at all, and neither does the block.
    expect(getStateRegion(container).textContent ?? '').not.toMatch(/\d/);
    expect(rootText).not.toMatch(/\d/);

    // No element of the block carries a digit, visible or visually hidden, nor in an accessible
    // name or description an assistive technology would read out instead of the text.
    const withDigits = Array.from(container.querySelectorAll('*')).filter((element) =>
      Array.from(element.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && /\d/.test(node.textContent ?? ''),
      ),
    );
    expect(withDigits).toEqual([]);
    const spokenAttributes = ['aria-label', 'aria-valuenow', 'aria-valuetext', 'title'];
    for (const element of Array.from(container.querySelectorAll('*'))) {
      for (const attribute of spokenAttributes) {
        expect(element.getAttribute(attribute) ?? '').not.toMatch(/\d/);
      }
    }
  });

  it('ignores count-bearing values a caller might forward, rendering none of them', () => {
    // Deliberately wider than `CaptureControlsProps`: if a count prop is ever added and wired up,
    // the number forwarded here would surface and this case would fail. JSX spread performs no
    // excess-property check, so the stray members reach the component exactly as a careless
    // caller's would.
    const stray = {
      ...capturingProps(),
      count: 7304,
      eventCount: 7304,
      eventsCaptured: 7304,
      capturedEvents: 7304,
      total: 7304,
    };
    const { container } = render(<CaptureControls {...stray} />);

    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\d/);
    expect(text).not.toMatch(EVENT_COUNT_PATTERN);
    expect(getStateRegion(container).textContent).toBe('Capturing');
  });

  it('counts nothing locally: the capture state is unchanged after a long capture window', () => {
    vi.useFakeTimers();
    const { container } = render(<CaptureControls {...capturingProps()} />);
    const before = container.innerHTML;

    // Ten minutes of simulated capture: a local ticker or elapsed-time counter would change the
    // markup or schedule a timer; neither is permitted.
    act(() => {
      vi.advanceTimersByTime(10 * 60 * 1000);
    });

    expect(container.innerHTML).toBe(before);
    expect(container.textContent ?? '').not.toMatch(/\d/);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('CaptureControls — arming prompt', () => {
  it('asks the developer to reproduce the issue while armed and not yet capturing', () => {
    const { container } = render(<CaptureControls {...readyProps({ armed: true })} />);

    expect(screen.getByText(ARMED_PROMPT)).toBeTruthy();
    expect(getStateRegion(container).textContent).toBe('Ready to capture');
  });

  it('hides the prompt once the capture is running', () => {
    render(<CaptureControls {...capturingProps({ armed: true })} />);

    expect(screen.queryByText(ARMED_PROMPT)).toBeNull();
  });

  it('shows no prompt while the session is not armed', () => {
    const notArmed: CaptureControlsProps[] = [
      readyProps(),
      readyProps({ armed: false }),
      readyProps({ armed: undefined }),
    ];

    for (const state of notArmed) {
      const { container, unmount } = render(<CaptureControls {...state} />);
      expect(screen.queryByText(ARMED_PROMPT)).toBeNull();
      expect(getStateRegion(container).textContent).toBe('Not capturing');
      unmount();
    }
  });
});

describe('CaptureControls — states', () => {
  it('replaces the controls with a busy placeholder while a request is pending', () => {
    const { container } = render(<CaptureControls {...readyProps({ pending: true })} />);

    expect(screen.queryAllByRole('button')).toEqual([]);
    const busy = screen.getByRole('status');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.textContent).toBe(PENDING_TEXT);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.firstElementChild?.classList.contains('dgv-capture')).toBe(true);
  });

  it('shows the pending state ahead of the unavailable state', () => {
    render(<CaptureControls {...readyProps({ canStart: false, canStop: false, pending: true })} />);

    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText(/instrumentation is ready/)).toBeNull();
  });

  it('explains why capture is unavailable instead of rendering inert controls', () => {
    const { container } = render(
      <CaptureControls {...readyProps({ canStart: false, canStop: false })} />,
    );

    expect(screen.queryAllByRole('button')).toEqual([]);
    const empty = screen.getByRole('status');
    expect(empty.textContent).toContain(UNAVAILABLE_MESSAGE);
    expect(empty.getAttribute('aria-busy')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.firstElementChild?.classList.contains('dgv-capture')).toBe(true);
  });

  it('renders the caller error verbatim as an alert with a "Capture again" control', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn<() => void>();
    // Supplied by the caller, as the service's recovery copy is (AAP 0.5.5); the component
    // composes no diagnosis of its own.
    const message = 'No telemetry was captured. Interact with the page, then Capture again.';
    const props = readyProps({ error: message, onRetry });
    render(<CaptureControls {...props} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(message);
    // Verbatim: one element holds exactly the caller's string, neither trimmed nor rephrased.
    const rendered = screen.getByText(message);
    expect(rendered.textContent).toBe(message);
    expect(alert.contains(rendered)).toBe(true);
    expect(screen.queryByRole('button', { name: START_NAME })).toBeNull();
    expect(screen.queryByRole('button', { name: STOP_NAME })).toBeNull();

    await user.click(getButton(RETRY_NAME));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(props.onStart).not.toHaveBeenCalled();
    expect(props.onStop).not.toHaveBeenCalled();
  });

  it('renders whatever wording the caller supplies, unaltered', () => {
    // A second, differently shaped caller string - the capture held by another session - so the
    // case cannot pass against copy the component happens to share with one fixture.
    const message = 'Another session is already capturing this project. End it, then try again.';
    render(<CaptureControls {...readyProps({ error: message })} />);

    expect(screen.getByText(message).textContent).toBe(message);
    expect(screen.getByRole('alert').textContent).toContain(message);
  });

  it('offers no retry control when the caller supplies no retry', () => {
    render(<CaptureControls {...readyProps({ error: 'The capture could not start.' })} />);

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('shows only the alert when error, pending and the unavailable combination coincide', () => {
    const { container } = render(
      <CaptureControls
        {...readyProps({ canStart: false, canStop: false, pending: true, error: 'Failed.' })}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Failed.');
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    // Neither the busy nor the unavailable placeholder, nor the controls, render beside it.
    expect(screen.queryByText(PENDING_TEXT)).toBeNull();
    expect(screen.queryByText(UNAVAILABLE_MESSAGE)).toBeNull();
    expect(screen.queryAllByRole('status')).toEqual([]);
    expect(container.querySelector('[aria-busy]')).toBeNull();
    expect(container.querySelector('.dgv-capture__state')).toBeNull();
    expect(screen.queryAllByRole('button')).toEqual([]);

    // The block holds the alert and nothing else.
    const root = container.firstElementChild;
    expect(root?.children).toHaveLength(1);
    expect(root?.firstElementChild).toBe(alert);
  });

  it('ignores a blank error', () => {
    render(<CaptureControls {...readyProps({ error: '   ' })} />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(getButton(START_NAME).disabled).toBe(false);
  });
});

describe('CaptureControls — focus', () => {
  it('moves focus to the stop control once a capture started from here is running', async () => {
    const user = userEvent.setup();
    const props = readyProps();
    const { rerender } = render(<CaptureControls {...props} />);

    await user.click(getButton(START_NAME));
    rerender(<CaptureControls {...props} pending />);
    rerender(<CaptureControls {...props} capturing canStart={false} canStop />);

    expect(document.activeElement).toBe(getButton(STOP_NAME));
  });

  it('moves focus back to the start control once a capture stopped from here has ended', async () => {
    const user = userEvent.setup();
    const props = capturingProps();
    const { rerender } = render(<CaptureControls {...props} />);

    await user.click(getButton(STOP_NAME));
    rerender(<CaptureControls {...props} pending />);
    rerender(<CaptureControls {...props} capturing={false} canStart canStop={false} />);

    expect(document.activeElement).toBe(getButton(START_NAME));
  });

  it('keeps waiting for the outcome across renders that do not yet report it', async () => {
    const user = userEvent.setup();
    const props = readyProps();
    const { rerender } = render(<CaptureControls {...props} />);

    await user.click(getButton(START_NAME));
    rerender(<CaptureControls {...props} />);
    expect(document.activeElement).toBe(getButton(START_NAME));

    rerender(<CaptureControls {...props} capturing canStart={false} canStop />);
    expect(document.activeElement).toBe(getButton(STOP_NAME));
  });

  it('does not pull focus away from where the developer moved it', async () => {
    const user = userEvent.setup();
    const props = readyProps();
    const { rerender } = render(
      <>
        <CaptureControls {...props} />
        <textarea aria-label="Elsewhere" />
      </>,
    );

    await user.click(getButton(START_NAME));
    rerender(
      <>
        <CaptureControls {...props} pending />
        <textarea aria-label="Elsewhere" />
      </>,
    );
    const elsewhere = screen.getByRole('textbox', { name: 'Elsewhere' });
    elsewhere.focus();
    rerender(
      <>
        <CaptureControls {...props} capturing canStart={false} canStop />
        <textarea aria-label="Elsewhere" />
      </>,
    );

    expect(document.activeElement).toBe(elsewhere);
  });

  it('does not move focus for a capture started elsewhere', () => {
    const props = readyProps();
    const { rerender } = render(<CaptureControls {...props} />);

    rerender(<CaptureControls {...props} capturing canStart={false} canStop />);

    expect(document.activeElement).toBe(document.body);
  });

  it('drops the pending focus move when the outcome is an error', async () => {
    const user = userEvent.setup();
    const props = readyProps();
    const { rerender } = render(<CaptureControls {...props} />);

    await user.click(getButton(START_NAME));
    rerender(<CaptureControls {...props} error="The capture could not start." />);
    rerender(<CaptureControls {...props} capturing canStart={false} canStop />);

    expect(document.activeElement).toBe(document.body);
  });
});

describe('CaptureControls — placeholders fill the row they replace', () => {
  it('passes the placeholder block to the error, busy and unavailable primitives', () => {
    const cases: [CaptureControlsProps, string][] = [
      [readyProps({ error: 'Failed.' }), '.dg-error-state'],
      [readyProps({ pending: true }), '.dg-loading-state'],
      [readyProps({ canStart: false, canStop: false }), '.dg-empty-state'],
    ];

    for (const [state, selector] of cases) {
      const { container, unmount } = render(<CaptureControls {...state} />);
      const placeholder = container.querySelector(selector);
      expect(placeholder?.classList.contains('dgv-capture__placeholder')).toBe(true);
      unmount();
    }
  });

  it('keeps the placeholder block off the controls', () => {
    const { container } = render(<CaptureControls {...readyProps()} />);

    expect(container.querySelector('.dgv-capture__placeholder')).toBeNull();
  });
});

describe('CaptureControls — design-system shape', () => {
  it('renders no heading and no inline style in any state', () => {
    const states: CaptureControlsProps[] = [
      readyProps({ armed: true }),
      capturingProps(),
      readyProps({ pending: true }),
      readyProps({ canStart: false, canStop: false }),
      readyProps({ error: 'Failed.', onRetry: vi.fn<() => void>() }),
    ];

    for (const state of states) {
      const { container, unmount } = render(<CaptureControls {...state} />);
      expect(container.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]')).toBeNull();
      expect(container.querySelector('[style]')).toBeNull();
      expect(container.firstElementChild?.classList.contains('dgv-capture')).toBe(true);
      unmount();
    }
  });
});

describe('CaptureControls — silence', () => {
  it('writes nothing to the console in any state, across transitions and unmounting', async () => {
    const user = userEvent.setup();
    const props = readyProps({ armed: true, onRetry: vi.fn<() => void>() });
    const { rerender, unmount } = render(<CaptureControls {...props} />);

    // Every state the component can take, in the order a session walks through them.
    await user.click(getButton(START_NAME));
    rerender(<CaptureControls {...props} pending />);
    rerender(<CaptureControls {...props} capturing canStart={false} canStop />);
    await user.click(getButton(STOP_NAME));
    rerender(<CaptureControls {...props} capturing={false} canStart={false} canStop={false} />);
    rerender(<CaptureControls {...props} error="The capture yielded nothing." />);
    await user.click(getButton(RETRY_NAME));
    rerender(<CaptureControls {...props} error="  " />);
    unmount();

    // Checked here as well as after every case, so this case names the state walk it covers.
    for (const [method, spy] of consoleSpies) {
      expect(spy, `console.${method} must never be called`).not.toHaveBeenCalled();
    }
    expect(consoleSpies.map(([method]) => method)).toEqual([...CONSOLE_METHODS]);
  });
});
