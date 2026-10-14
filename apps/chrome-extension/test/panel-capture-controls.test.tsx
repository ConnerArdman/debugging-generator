/**
 * The contract of `src/panel/components/CaptureControls` — "Start capture / Stop capture" and the
 * live event counter in the header of the "Debug Generator" DevTools panel (AAP 0.7.3).
 *
 * Pinned here:
 *
 *   - **Only permitted transitions.** A start is asked for once, and only from `ready`; a stop
 *     once, and only from `capturing`. No other status — nor no status at all — calls either.
 *   - **Failures reach the explicit reporter and end there.** A rejecting callback and a
 *     synchronously throwing one are each handed to `onActionError` exactly once with the action
 *     that failed, the control is released for a retry, and neither an unhandled rejection nor an
 *     uncaught error follows. A reporter that itself throws is delivered to the platform's root
 *     reporter, `globalThis.reportError` — or, where that is absent or throws, rethrown on a task
 *     of its own rather than out of the click or into the promise chain.
 *   - **The progress announcement.** An always-mounted, visually hidden, polite and atomic
 *     `role="status"` region announces a start and a stop at once, throttles count changes to one
 *     sentence per interval with the latest count while the visible counter updates on every
 *     render, says nothing about a capture only ever seen stopped, clears itself when the capture
 *     id goes away, and leaves no timer behind on unmount.
 *   - **A clean console.** No case makes React (or the component) warn.
 *
 * ## Harness
 *
 * Harness functions are imported explicitly and every mounted tree is cleaned up by this file's
 * own `afterEach`, so the suite does not depend on the project's `globals` setting for Testing
 * Library's automatic cleanup. Spies, stubbed globals and fake timers are restored in the same
 * hook, so a failing assertion cannot leak any of them into the next case. Assertions read DOM
 * properties directly; no custom matchers are installed.
 *
 * Fixture values are generic vocabulary written for this suite; no inspected project's names
 * appear in it (AAP 0.5.4).
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock, MockInstance } from 'vitest';

import { SESSION_STATUSES } from '@debuggen/protocol';
import type { SessionStatus } from '@debuggen/protocol';
import { StrictMode } from 'react';
import type { ReactElement } from 'react';

import { CaptureControls } from '../src/panel/components/CaptureControls';
import type { CaptureAction, CaptureControlsProps } from '../src/panel/components/CaptureControls';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A generic capture id, as the store's capture slice would carry it. */
const FIRST_CAPTURE = 'capture-1';

/** A second generic capture id, for a capture that replaces the first. */
const SECOND_CAPTURE = 'capture-2';

/**
 * A long wait, in ms: longer than any schedule the region could have. Waited through to prove
 * that nothing further is ever said, not merely that it has not been said yet.
 */
const LONG_WAIT_MS = 60_000;

/** The visible counter's accessible name while a capture runs. */
const LIVE_COUNTER_NAME = 'Events received during the running capture';

/** The visible counter's accessible name once the capture it counts has stopped. */
const LAST_COUNTER_NAME = 'Events received by the last capture';

/** The renderer's visually hidden utility the announcement region composes. */
const VISUALLY_HIDDEN_CLASS = 'dg-visually-hidden';

/** Every status from which neither action may be asked for. */
const INERT_STATUSES: readonly SessionStatus[] = SESSION_STATUSES.filter(
  (status) => status !== 'ready' && status !== 'capturing',
);

/**
 * The count as the component formats it — with the viewer's locale grouping — so the suite
 * holds in every locale the runner might use.
 */
const COUNT_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/** "1 event", "0 events", "1,204 events": the grouped count with its unit word. */
function events(count: number): string {
  return `${COUNT_FORMAT.format(count)} ${count === 1 ? 'event' : 'events'}`;
}

/** The sentence announced when a capture starts: it states no count. */
const START_SENTENCE = 'Capture running.';

/** The sentence announced when the capture stops. */
function stopSentence(count: number): string {
  return `Capture stopped. ${events(count)} captured.`;
}

/** The sentence for a stopped capture's total corrected after its stop was announced. */
function totalSentence(count: number): string {
  return `${events(count)} captured.`;
}

/** Every run of digits a sentence states — the numbers a screen reader would hear. */
function numbersIn(sentence: string): string[] {
  return sentence.match(/\d[\d.,\u00a0\u202f ]*/gu) ?? [];
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A promise the test rejects by hand, for holding a request in flight until it fails. */
interface Deferred {
  readonly promise: Promise<void>;
  readonly reject: (reason: unknown) => void;
}

/** Creates a {@link Deferred}; the executor runs synchronously, so the settler is bound. */
function deferred(): Deferred {
  const settlers: { reject?: (reason: unknown) => void } = {};
  const promise = new Promise<void>((_resolve, reject) => {
    settlers.reject = reject;
  });
  return {
    promise,
    reject: (reason: unknown) => settlers.reject?.(reason),
  };
}

/** The three callbacks of every render, as spies. */
interface Callbacks {
  readonly onStartCapture: Mock<() => Promise<void> | void>;
  readonly onStopCapture: Mock<() => Promise<void> | void>;
  readonly onActionError: Mock<(error: unknown, action: CaptureAction) => void>;
}

/** Fresh spies; each test overrides the implementation it exercises. */
function callbacks(): Callbacks {
  return {
    onStartCapture: vi.fn<() => Promise<void> | void>(),
    onStopCapture: vi.fn<() => Promise<void> | void>(),
    onActionError: vi.fn<(error: unknown, action: CaptureAction) => void>(),
  };
}

/** The capture-related props a case varies. */
interface CaptureState {
  readonly sessionStatus: SessionStatus | undefined;
  readonly captureId: string | undefined;
  readonly eventCount: number;
  readonly disabledReason?: string | undefined;
}

/** The element under test, with the given state and spies. */
function controls(state: CaptureState, spies: Callbacks): ReactElement {
  const props: CaptureControlsProps = { ...state, ...spies };
  return <CaptureControls {...props} />;
}

/**
 * Mounts the controls, optionally wrapped, and returns `update` — which re-renders them with a
 * new state and the same spies, the way the composition root re-renders on every store change —
 * and `unmount`.
 */
function mount(
  state: CaptureState,
  spies: Callbacks = callbacks(),
  wrap: (element: ReactElement) => ReactElement = (element) => element,
): { readonly update: (next: CaptureState) => void; readonly unmount: () => void } {
  const view = render(wrap(controls(state, spies)));
  return {
    update: (next) => {
      view.rerender(wrap(controls(next, spies)));
    },
    unmount: () => {
      view.unmount();
    },
  };
}

/** The single action button. */
function actionButton(): HTMLElement {
  return screen.getByRole('button');
}

/** The announcement region. */
function region(): HTMLElement {
  return screen.getByRole('status');
}

/** Advances fake time and flushes the React updates the fired timers made. */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Lets every pending promise job and one macrotask run, under real timers. */
async function flushTasks(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

let consoleError: MockInstance<typeof console.error>;
let consoleWarn: MockInstance<typeof console.warn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error');
  consoleWarn = vi.spyOn(console, 'warn');
});

afterEach(() => {
  try {
    cleanup();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  } finally {
    // Restored even when the console assertion fails, so nothing leaks into the next case.
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

describe('CaptureControls — permitted transitions', () => {
  it('asks for a start exactly once from ready', async () => {
    const user = userEvent.setup();
    const spies = callbacks();
    mount({ sessionStatus: 'ready', captureId: undefined, eventCount: 0 }, spies);

    expect(actionButton().textContent).toBe('Start capture');
    await user.click(actionButton());
    // The request is now awaiting the session's confirmation: a second click is refused.
    await user.click(actionButton());

    expect(spies.onStartCapture).toHaveBeenCalledTimes(1);
    expect(spies.onStopCapture).not.toHaveBeenCalled();
    expect(spies.onActionError).not.toHaveBeenCalled();
    expect(actionButton().textContent).toBe('Starting capture…');
    expect(actionButton().getAttribute('aria-busy')).toBe('true');
  });

  it('asks for a stop exactly once from capturing', async () => {
    const user = userEvent.setup();
    const spies = callbacks();
    mount({ sessionStatus: 'capturing', captureId: FIRST_CAPTURE, eventCount: 3 }, spies);

    expect(actionButton().textContent).toBe('Stop capture');
    await user.click(actionButton());
    await user.click(actionButton());

    expect(spies.onStopCapture).toHaveBeenCalledTimes(1);
    expect(spies.onStartCapture).not.toHaveBeenCalled();
    expect(spies.onActionError).not.toHaveBeenCalled();
  });

  it.each(INERT_STATUSES)('asks for nothing from %s', async (status) => {
    const user = userEvent.setup();
    const spies = callbacks();
    mount({ sessionStatus: status, captureId: FIRST_CAPTURE, eventCount: 0 }, spies);

    await user.click(actionButton());

    expect(actionButton().getAttribute('aria-disabled')).toBe('true');
    expect(spies.onStartCapture).not.toHaveBeenCalled();
    expect(spies.onStopCapture).not.toHaveBeenCalled();
  });

  it('asks for nothing without a session or with an explicit reason', async () => {
    const user = userEvent.setup();
    const spies = callbacks();
    const { update } = mount(
      { sessionStatus: undefined, captureId: undefined, eventCount: 0 },
      spies,
    );

    await user.click(actionButton());
    update({
      sessionStatus: 'ready',
      captureId: undefined,
      eventCount: 0,
      disabledReason: 'The panel is not connected.',
    });
    await user.click(actionButton());

    expect(actionButton().getAttribute('aria-disabled')).toBe('true');
    expect(spies.onStartCapture).not.toHaveBeenCalled();
    expect(spies.onStopCapture).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Failure reporting
// ---------------------------------------------------------------------------

describe('CaptureControls — failure reporting', () => {
  const unhandledRejection = vi.fn();
  const windowError = vi.fn();

  beforeEach(() => {
    unhandledRejection.mockReset();
    windowError.mockReset();
    process.on('unhandledRejection', unhandledRejection);
    window.addEventListener('error', windowError);
  });

  afterEach(() => {
    process.off('unhandledRejection', unhandledRejection);
    window.removeEventListener('error', windowError);
  });

  it('reports a rejected start once, releases the control and leaves nothing unhandled', async () => {
    const user = userEvent.setup();
    const failure = new Error('start request failed');
    const spies = callbacks();
    const request = deferred();
    spies.onStartCapture.mockImplementationOnce(() => request.promise);
    mount({ sessionStatus: 'ready', captureId: undefined, eventCount: 0 }, spies);

    await user.click(actionButton());
    expect(actionButton().getAttribute('aria-busy')).toBe('true');
    expect(actionButton().textContent).toBe('Starting capture…');

    await act(async () => {
      request.reject(failure);
      await request.promise.catch(() => undefined);
    });
    await flushTasks();

    expect(spies.onActionError).toHaveBeenCalledTimes(1);
    expect(spies.onActionError).toHaveBeenCalledWith(failure, 'start');
    expect(actionButton().getAttribute('aria-busy')).toBeNull();
    expect(actionButton().getAttribute('aria-disabled')).toBeNull();
    expect(actionButton().textContent).toBe('Start capture');
    expect(unhandledRejection).not.toHaveBeenCalled();
    expect(windowError).not.toHaveBeenCalled();

    // Still usable: a retry asks again.
    await user.click(actionButton());
    expect(spies.onStartCapture).toHaveBeenCalledTimes(2);
  });

  it('reports a synchronously throwing stop without throwing out of the click', async () => {
    const user = userEvent.setup();
    const failure = new Error('stop request failed');
    const spies = callbacks();
    spies.onStopCapture.mockImplementation(() => {
      throw failure;
    });
    mount({ sessionStatus: 'capturing', captureId: FIRST_CAPTURE, eventCount: 2 }, spies);

    await user.click(actionButton());
    await flushTasks();

    expect(spies.onActionError).toHaveBeenCalledTimes(1);
    expect(spies.onActionError).toHaveBeenCalledWith(failure, 'stop');
    expect(windowError).not.toHaveBeenCalled();
    expect(unhandledRejection).not.toHaveBeenCalled();
    // Nothing is held: the control is available again at once.
    expect(actionButton().textContent).toBe('Stop capture');
    expect(actionButton().getAttribute('aria-busy')).toBeNull();
    expect(actionButton().getAttribute('aria-disabled')).toBeNull();

    await user.click(actionButton());
    expect(spies.onStopCapture).toHaveBeenCalledTimes(2);
    expect(spies.onActionError).toHaveBeenCalledTimes(2);
  });

  it('delivers a throwing reporter to globalThis.reportError, for a rejection and a throw', async () => {
    const user = userEvent.setup();
    const platformReporter = vi.fn<(error: unknown) => void>();
    vi.stubGlobal('reportError', platformReporter);
    const reporterFailure = new Error('reporter failed');
    const spies = callbacks();
    spies.onActionError.mockImplementation(() => {
      throw reporterFailure;
    });
    spies.onStartCapture.mockImplementationOnce(() =>
      Promise.reject(new Error('start request failed')),
    );
    spies.onStopCapture.mockImplementationOnce(() => {
      throw new Error('stop request failed');
    });
    const { update } = mount(
      { sessionStatus: 'ready', captureId: undefined, eventCount: 0 },
      spies,
    );

    await user.click(actionButton());
    await flushTasks();

    expect(spies.onActionError).toHaveBeenCalledTimes(1);
    expect(platformReporter).toHaveBeenCalledTimes(1);
    expect(platformReporter).toHaveBeenCalledWith(reporterFailure);

    update({ sessionStatus: 'capturing', captureId: FIRST_CAPTURE, eventCount: 0 });
    await user.click(actionButton());
    await flushTasks();

    expect(spies.onActionError).toHaveBeenCalledTimes(2);
    expect(platformReporter).toHaveBeenCalledTimes(2);
    expect(platformReporter).toHaveBeenLastCalledWith(reporterFailure);
    expect(unhandledRejection).not.toHaveBeenCalled();
    expect(windowError).not.toHaveBeenCalled();
  });
});

describe('CaptureControls — platform reporter fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /** Mounts a running capture whose stop throws, with its start sentence already announced. */
  function mountThrowingStop(reporterFailure: Error): Callbacks {
    const spies = callbacks();
    spies.onStopCapture.mockImplementation(() => {
      throw new Error('stop request failed');
    });
    spies.onActionError.mockImplementation(() => {
      throw reporterFailure;
    });
    mount({ sessionStatus: 'capturing', captureId: FIRST_CAPTURE, eventCount: 0 }, spies);
    advance(0);
    return spies;
  }

  it('rethrows a throwing reporter on a fresh task where reportError is absent', () => {
    vi.stubGlobal('reportError', undefined);
    const reporterFailure = new Error('reporter failed');
    const spies = mountThrowingStop(reporterFailure);

    // Nothing escapes the click itself; the failure waits on a task of its own.
    fireEvent.click(actionButton());
    expect(spies.onActionError).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    expect(() => {
      vi.runOnlyPendingTimers();
    }).toThrow(reporterFailure);
  });

  it('delivers both errors together when reportError itself throws', () => {
    const platformFailure = new Error('platform reporter failed');
    vi.stubGlobal(
      'reportError',
      vi.fn(() => {
        throw platformFailure;
      }),
    );
    const reporterFailure = new Error('reporter failed');
    mountThrowingStop(reporterFailure);

    fireEvent.click(actionButton());

    let delivered: unknown;
    try {
      vi.runOnlyPendingTimers();
    } catch (error: unknown) {
      delivered = error;
    }
    expect(delivered).toBeInstanceOf(AggregateError);
    expect((delivered as AggregateError).errors).toEqual([reporterFailure, platformFailure]);
  });
});

// ---------------------------------------------------------------------------
// The progress announcement
// ---------------------------------------------------------------------------

describe('CaptureControls — progress announcement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('keeps a polite, atomic, visually hidden status region mounted before any capture', () => {
    mount({ sessionStatus: 'ready', captureId: undefined, eventCount: 0 });

    const live = region();
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.getAttribute('aria-atomic')).toBe('true');
    expect(live.classList.contains(VISUALLY_HIDDEN_CLASS)).toBe(true);
    expect(live.textContent).toBe('');
    // The visible counter appears only with a capture id, and is not itself a live region.
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('announces a capture that starts, promptly, and a new capture that replaces it', () => {
    const { update } = mount({ sessionStatus: 'ready', captureId: undefined, eventCount: 0 });
    const live = region();

    update({ sessionStatus: 'capturing', captureId: FIRST_CAPTURE, eventCount: 0 });
    // The region existed before its text changes, and the text changes from a timer.
    expect(live.textContent).toBe('');
    advance(0);
    expect(live.textContent).toBe(START_SENTENCE);
    expect(region()).toBe(live);

    update({ sessionStatus: 'capturing', captureId: SECOND_CAPTURE, eventCount: 1 });
    advance(0);
    expect(live.textContent).toBe(START_SENTENCE);
  });

  it('never states a running count, so the visible counter is the one running number', () => {
    const { update } = mount({
      sessionStatus: 'capturing',
      captureId: FIRST_CAPTURE,
      eventCount: 0,
    });
    advance(0);
    const live = region();
    expect(live.textContent).toBe(START_SENTENCE);
    expect(numbersIn(live.textContent)).toEqual([]);

    // Forty updates 100 ms apart, then a long wait: the region never speaks a count, while the
    // visible counter is current on every render.
    for (let step = 1; step <= 40; step += 1) {
      const count = step * 31;
      update({ sessionStatus: 'capturing', captureId: FIRST_CAPTURE, eventCount: count });
      expect(screen.getByRole('group', { name: LIVE_COUNTER_NAME }).textContent).toBe(
        events(count),
      );
      advance(100);
      expect(live.textContent).toBe(START_SENTENCE);
    }
    advance(LONG_WAIT_MS);
    expect(live.textContent).toBe(START_SENTENCE);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('announces the stop promptly with the latest count, then a corrected total at once', () => {
    const { update } = mount({
      sessionStatus: 'capturing',
      captureId: FIRST_CAPTURE,
      eventCount: 1,
    });
    advance(0);
    const live = region();
    expect(live.textContent).toBe(START_SENTENCE);

    update({ sessionStatus: 'capturing', captureId: FIRST_CAPTURE, eventCount: 5 });
    advance(1_000);
    update({ sessionStatus: 'analyzing', captureId: FIRST_CAPTURE, eventCount: 7 });
    // A total that moves before the stop sentence is spoken is folded into it.
    update({ sessionStatus: 'analyzing', captureId: FIRST_CAPTURE, eventCount: 8 });
    advance(0);
    expect(live.textContent).toBe(stopSentence(8));
    expect(screen.getByRole('group', { name: LAST_COUNTER_NAME }).textContent).toBe(
      `${events(8)} captured`,
    );

    // The store's stored count arrives after the stop: the region follows the counter at once.
    update({ sessionStatus: 'analyzing', captureId: FIRST_CAPTURE, eventCount: 9_000 });
    expect(screen.getByRole('group', { name: LAST_COUNTER_NAME }).textContent).toBe(
      `${events(9_000)} captured`,
    );
    advance(0);
    expect(live.textContent).toBe(totalSentence(9_000));

    // An unchanged total says nothing more.
    update({ sessionStatus: 'generated', captureId: FIRST_CAPTURE, eventCount: 9_000 });
    advance(LONG_WAIT_MS);
    expect(live.textContent).toBe(totalSentence(9_000));
  });

  it('says nothing about a capture only ever seen stopped', () => {
    const { update } = mount({
      sessionStatus: 'generated',
      captureId: FIRST_CAPTURE,
      eventCount: 30,
    });
    const live = region();
    advance(LONG_WAIT_MS);
    expect(live.textContent).toBe('');

    update({ sessionStatus: 'generated', captureId: FIRST_CAPTURE, eventCount: 31 });
    advance(LONG_WAIT_MS);
    expect(live.textContent).toBe('');
    expect(screen.getByRole('group', { name: LAST_COUNTER_NAME }).textContent).toBe(
      `${events(31)} captured`,
    );
  });

  it('clears the previous sentence on a switch to a capture only seen stopped', () => {
    const { update } = mount({
      sessionStatus: 'capturing',
      captureId: FIRST_CAPTURE,
      eventCount: 2,
    });
    advance(0);
    const live = region();
    expect(live.textContent).toBe(START_SENTENCE);

    update({ sessionStatus: 'ready', captureId: SECOND_CAPTURE, eventCount: 3 });
    advance(0);
    expect(live.textContent).toBe('');
    advance(LONG_WAIT_MS);
    expect(live.textContent).toBe('');
  });

  it('clears the sentence when the capture id is cleared', () => {
    const { update } = mount({
      sessionStatus: 'capturing',
      captureId: FIRST_CAPTURE,
      eventCount: 6,
    });
    advance(0);
    const live = region();
    expect(live.textContent).toBe(START_SENTENCE);

    update({ sessionStatus: 'ready', captureId: undefined, eventCount: 0 });
    advance(0);
    expect(region()).toBe(live);
    expect(live.textContent).toBe('');
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('announces once under StrictMode and leaves no timer behind on unmount', () => {
    const { update, unmount } = mount(
      { sessionStatus: 'capturing', captureId: FIRST_CAPTURE, eventCount: 0 },
      callbacks(),
      (element) => <StrictMode>{element}</StrictMode>,
    );
    advance(0);
    expect(region().textContent).toBe(START_SENTENCE);

    // A stop schedules its sentence; unmounting cancels it.
    update({ sessionStatus: 'analyzing', captureId: FIRST_CAPTURE, eventCount: 8 });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
