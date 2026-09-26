/**
 * Component spec for `../src/panel/components/PairDialog.tsx` — the dialog that
 * takes the one-time pairing code shown in VS Code.
 *
 * What this suite protects:
 *
 *   - only a well-formed code leaves the dialog: an empty, wrong-length or
 *     disallowed-character value never reaches `submitCode`, and the refusal is
 *     the renderer `Input`'s accessible error — `aria-invalid` on the control
 *     and the message linked through `aria-describedby`;
 *   - the feedback timing: a value typing cannot repair is flagged at once, a
 *     value still being typed only after a submit attempt, and `Enter` in the
 *     field always answers;
 *   - what is submitted: the normalised code (trimmed, upper-cased), once;
 *   - true modality: focus moved anywhere outside the dialog is pulled back
 *     inside, `Escape` closes from inside and from the document body (but not
 *     while an IME composition is ending), the opener gets focus back on close
 *     — under StrictMode's effect replay too — and the listeners are gone once
 *     the dialog is;
 *   - the composition root's half of modality: while the dialog is open,
 *     `App` makes the header, the body, the drawer and the live tail `inert`,
 *     keeps the dialog outside every inert subtree, and on close returns focus
 *     to the header's "Pair…" control or, for a dialog that opened by itself,
 *     to the panel body.
 *
 * Harness conventions follow the rest of the repository: the Vitest API is
 * imported explicitly, `cleanup` and `vi.restoreAllMocks` are registered
 * explicitly, elements are found by role, label and accessible name, and —
 * with no `jest-dom` in this repository — state is read from DOM properties.
 * The dialog touches no `chrome.*` API, so no extension fake is needed for its
 * cases. The `App` cases replace only `../src/panel/state/connection` — the
 * runtime port — with inert stand-ins and drive the real session store, so the
 * panel renders exactly as it would in DevTools with the worker reporting "Not
 * paired". happy-dom does not implement `inert` itself, which is why the
 * dialog's own focus containment is observable here: a programmatic `focus()`
 * on an inert element succeeds in happy-dom and is then pulled back. Every
 * code, session and event here is synthetic.
 */
import { sessionRecordSchema } from '@debuggen/protocol';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useState } from 'react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/panel/App';
import { Header } from '../src/panel/components/Header';
import { PairDialog } from '../src/panel/components/PairDialog';
import type * as ConnectionModule from '../src/panel/state/connection';
import {
  applySessionSnapshot,
  resetPanelStore,
  selectEvent,
  setConnectionStatus,
} from '../src/panel/state/session-store';

/** The port stand-in's request function, observed by the `App` cases. */
const panelRequestMock = vi.hoisted(() => vi.fn());

// The runtime port is the only piece of the panel replaced: no connection is
// opened, `resync` is a no-op, and every port request resolves.
vi.mock('../src/panel/state/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionModule>();
  return {
    ...actual,
    startPanelConnection: () => ({ stop: () => undefined }),
    getPanelConnection: () => ({ resync: () => undefined }),
    panelRequest: panelRequestMock,
  };
});

const FIELD_NAME = 'Pairing code';
const PAIR_NAME = 'Pair';
const CANCEL_NAME = 'Cancel';

const TOO_SHORT_MESSAGE = 'A pairing code has 8 characters; the code entered has 5.';
const TOO_LONG_MESSAGE = 'A pairing code has 8 characters; the code entered has 9.';
const EMPTY_MESSAGE_PREFIX = 'Enter the pairing code shown in VS Code.';
const CHARACTERS_MESSAGE_PREFIX = 'A pairing code contains only the digits 2–9';

afterEach(cleanup);
afterEach(() => {
  vi.restoreAllMocks();
});

/** The code field, narrowed to its element type. */
function getField(): HTMLInputElement {
  const field = screen.getByRole('textbox', { name: FIELD_NAME });
  if (!(field instanceof HTMLInputElement)) {
    throw new Error('expected the pairing code field to be an <input>');
  }
  return field;
}

/** The dialog's primary action, narrowed to its element type. */
function getPairButton(): HTMLButtonElement {
  const button = screen.getByRole('button', { name: PAIR_NAME });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('expected the Pair action to be a <button>');
  }
  return button;
}

/** Replace the field's value, as a paste into the controlled field would. */
function typeCode(text: string): void {
  fireEvent.change(getField(), { target: { value: text } });
}

/**
 * The field's validation message as assistive technology receives it: the text
 * of the element its `aria-describedby` names last (the error follows the hint),
 * or `undefined` while the field is not invalid.
 */
function describedError(field: HTMLInputElement): string | undefined {
  if (field.getAttribute('aria-invalid') !== 'true') {
    return undefined;
  }
  const ids = (field.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  const errorId = ids.find((id) => id.endsWith('-error'));
  if (errorId === undefined) {
    throw new Error('an invalid field must link its error through aria-describedby');
  }
  const element = document.getElementById(errorId);
  if (element === null) {
    throw new Error(`aria-describedby names "${errorId}", which is not in the document`);
  }
  return element.textContent;
}

/** Render an open dialog with fresh spies. */
function renderDialog(submitCode = vi.fn<(code: string) => Promise<void>>()) {
  const onClose = vi.fn<() => void>();
  const onPaired = vi.fn<() => void>();
  const view = render(
    <PairDialog open onClose={onClose} submitCode={submitCode} onPaired={onPaired} />,
  );
  return { ...view, submitCode, onClose, onPaired };
}

describe('PairDialog — refusing an ill-formed code', () => {
  it('opens with the field focused, valid, and Pair enabled', () => {
    renderDialog();
    const field = getField();
    expect(document.activeElement).toBe(field);
    expect(describedError(field)).toBeUndefined();
    expect(getPairButton().disabled).toBe(false);
  });

  it('does not submit a too-short code, and says why once a submit is attempted', async () => {
    const user = userEvent.setup();
    const { submitCode } = renderDialog();

    typeCode('ABCD2');
    // Still being typed: no complaint yet.
    expect(describedError(getField())).toBeUndefined();

    await user.click(getPairButton());

    expect(submitCode).not.toHaveBeenCalled();
    const field = getField();
    expect(describedError(field)).toBe(TOO_SHORT_MESSAGE);
    expect(document.activeElement).toBe(field);
  });

  it('refuses Enter in the field with an ill-formed code — implicit submission still answers', async () => {
    const user = userEvent.setup();
    const { submitCode } = renderDialog();

    await user.type(getField(), 'abcd2{Enter}');

    expect(submitCode).not.toHaveBeenCalled();
    expect(describedError(getField())).toBe(TOO_SHORT_MESSAGE);
  });

  it('refuses an empty submit and names where a code comes from', async () => {
    const user = userEvent.setup();
    const { submitCode } = renderDialog();

    await user.click(getPairButton());

    expect(submitCode).not.toHaveBeenCalled();
    expect(describedError(getField())).toMatch(new RegExp(`^${EMPTY_MESSAGE_PREFIX}`));
  });

  it('flags a too-long code as it is typed, before any submit', () => {
    const { submitCode } = renderDialog();

    typeCode('ABCD23456');

    expect(describedError(getField())).toBe(TOO_LONG_MESSAGE);
    expect(submitCode).not.toHaveBeenCalled();
  });

  it.each([
    ['a dash', 'ABCD-234'],
    ['an inner space', 'ABCD 234'],
    ['the digit 0', 'ABCD2340'],
    ['the letter O', 'abcd234o'],
    ['the digit 1', 'ABCD2341'],
    ['the letter I', 'ABCD234I'],
  ])('flags %s as it is typed and never submits it', async (_label, input) => {
    const user = userEvent.setup();
    const { submitCode } = renderDialog();

    typeCode(input);
    expect(describedError(getField())).toMatch(new RegExp(`^${CHARACTERS_MESSAGE_PREFIX}`));

    await user.click(getPairButton());
    expect(submitCode).not.toHaveBeenCalled();
  });

  it('clears the message as soon as the value is well-formed', async () => {
    const user = userEvent.setup();
    renderDialog();

    typeCode('ABCD2');
    await user.click(getPairButton());
    expect(describedError(getField())).toBe(TOO_SHORT_MESSAGE);

    typeCode('ABCD2345');
    const field = getField();
    expect(describedError(field)).toBeUndefined();
    expect(field.hasAttribute('aria-invalid')).toBe(false);
  });

  it('never writes the typed value into the validation message', async () => {
    const user = userEvent.setup();
    renderDialog();

    typeCode('QWXZ');
    await user.click(getPairButton());

    const message = describedError(getField());
    expect(message).toBe('A pairing code has 8 characters; the code entered has 4.');
    expect(message).not.toContain('QWXZ');
  });
});

describe('PairDialog — submitting a well-formed code', () => {
  it('submits a lower-case, whitespace-padded code upper-cased and trimmed, once', async () => {
    const user = userEvent.setup();
    const submitCode = vi.fn<(code: string) => Promise<void>>().mockResolvedValue(undefined);
    const { onClose, onPaired } = renderDialog(submitCode);

    typeCode('  abcd2345 ');
    await user.click(getPairButton());

    expect(submitCode).toHaveBeenCalledTimes(1);
    expect(submitCode).toHaveBeenCalledWith('ABCD2345');
    expect(onPaired).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('disables Pair only while the submit is in flight, and shows a refusal from the service', async () => {
    let reject: (reason: unknown) => void = () => undefined;
    const submitCode = vi.fn<(code: string) => Promise<void>>(
      () =>
        new Promise<void>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    renderDialog(submitCode);

    typeCode('abcd2345');
    fireEvent.click(getPairButton());

    const busy = screen.getByRole('button', { name: 'Pairing…' });
    expect(busy instanceof HTMLButtonElement && busy.disabled).toBe(true);
    expect(submitCode).toHaveBeenCalledWith('ABCD2345');

    await act(async () => {
      reject(new Error('The pairing code has already been used.'));
      await Promise.resolve();
    });

    expect(screen.getByRole('alert').textContent).toContain(
      'The pairing code has already been used.',
    );
    expect(getPairButton().disabled).toBe(false);
    // The retry re-submits the same well-formed code.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(submitCode).toHaveBeenCalledTimes(2);
    expect(submitCode).toHaveBeenLastCalledWith('ABCD2345');
  });

  it('withdraws the retry once the value was edited into an ill-formed one', async () => {
    const submitCode = vi
      .fn<(code: string) => Promise<void>>()
      .mockRejectedValue(new Error('The pairing code has expired.'));
    renderDialog(submitCode);

    typeCode('ABCD2345');
    await act(async () => {
      fireEvent.click(getPairButton());
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();

    typeCode('ABCD');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByRole('button', { name: CANCEL_NAME })).toBeDefined();
  });
});

/** The dialog element, found by its accessible name. */
function getDialog(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Pair this panel with VS Code' });
}

/** The one element of `selector` in `container`, failing the test when absent. */
function requireElement(container: ParentNode, selector: string): HTMLElement {
  const element = container.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`expected an element matching ${selector}`);
  }
  return element;
}

/** Props of {@link DialogHarness}. */
interface DialogHarnessProps {
  readonly submitCode?: ((code: string) => Promise<void>) | undefined;
}

/**
 * An owner in miniature: an opener control, a control outside the dialog, and
 * the dialog, opened by the first and closed through `onClose`.
 */
function DialogHarness(props: DialogHarnessProps): ReactElement {
  const { submitCode = () => Promise.resolve() } = props;
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open pairing
      </button>
      <button type="button">Outside</button>
      <PairDialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        submitCode={submitCode}
      />
    </>
  );
}

describe('PairDialog — focus containment and dismissal', () => {
  it('pulls focus moved outside the dialog back to the field', async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole('button', { name: 'Open pairing' }));
    const field = getField();
    expect(document.activeElement).toBe(field);

    screen.getByRole('button', { name: 'Outside' }).focus();

    expect(document.activeElement).toBe(field);
  });

  it('pulls focus back to the dialog element while the field is disabled by a submit', async () => {
    const user = userEvent.setup();
    const pending = new Promise<void>(() => undefined);
    render(<DialogHarness submitCode={() => pending} />);
    await user.click(screen.getByRole('button', { name: 'Open pairing' }));
    typeCode('ABCD2345');
    fireEvent.click(getPairButton());
    expect(getField().disabled).toBe(true);

    screen.getByRole('button', { name: 'Outside' }).focus();

    expect(document.activeElement).toBe(getDialog());
  });

  it('closes on Escape from the field and from an action', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    screen.getByRole('button', { name: CANCEL_NAME }).focus();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('closes on Escape while focus has fallen to the document body', () => {
    const { onClose } = renderDialog();
    getField().blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves an Escape that ends an IME composition to the composition', () => {
    const { onClose } = renderDialog();

    fireEvent.keyDown(getField(), { key: 'Escape', isComposing: true });
    fireEvent.keyDown(document.body, { key: 'Escape', isComposing: true });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('returns focus to the opener on close, and stops containing focus once gone', async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const opener = screen.getByRole('button', { name: 'Open pairing' });

    await user.click(opener);
    expect(document.activeElement).toBe(getField());
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);

    const outside = screen.getByRole('button', { name: 'Outside' });
    outside.focus();
    expect(document.activeElement).toBe(outside);
  });

  it('returns focus to the opener under StrictMode, whose effect replay moves no focus', async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <DialogHarness />
      </StrictMode>,
    );
    const opener = screen.getByRole('button', { name: 'Open pairing' });

    await user.click(opener);
    // The replay kept focus in the dialog rather than bouncing it to the opener.
    expect(document.activeElement).toBe(getField());

    await user.click(screen.getByRole('button', { name: CANCEL_NAME }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    // One listener pair was registered and it was removed: nothing pulls focus now.
    const outside = screen.getByRole('button', { name: 'Outside' });
    outside.focus();
    expect(document.activeElement).toBe(outside);
  });
});

describe('Header — inert while a modal is open', () => {
  it('forwards inert to its <header> and omits the attribute otherwise', () => {
    const { container, rerender } = render(<Header connectionStatus="Connected" inert />);
    expect(requireElement(container, 'header').hasAttribute('inert')).toBe(true);

    rerender(<Header connectionStatus="Connected" inert={false} />);
    expect(requireElement(container, 'header').hasAttribute('inert')).toBe(false);

    rerender(<Header connectionStatus="Connected" />);
    expect(requireElement(container, 'header').hasAttribute('inert')).toBe(false);
  });
});

/** A synthetic, schema-valid session record, so the body and the live tail render. */
const SYNTHETIC_SESSION = sessionRecordSchema.parse({
  id: 'session-synthetic-1',
  projectRoot: '/workspace/synthetic',
  projectName: 'synthetic',
  devServerUrl: 'http://127.0.0.1:20999',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  status: 'ready',
  question: 'Why is the synthetic control slow?',
  followUps: [],
  relevantFiles: [],
  plans: [],
  modifications: [],
  captures: [],
  panelIds: [],
  analyses: [],
  cleanup: { status: 'pending', conflicts: [] },
  promptVersions: {},
  provider: { id: 'deterministic' },
});

describe('App — the pairing dialog is modal', () => {
  beforeEach(() => {
    resetPanelStore({ includeConnection: true });
    panelRequestMock.mockReset();
    panelRequestMock.mockResolvedValue({ paired: true });
  });
  afterEach(() => {
    // Unmount first: resetting the store under a mounted panel is an update
    // outside `act`, and nothing of this describe block may leak into the next.
    cleanup();
    resetPanelStore({ includeConnection: true });
  });

  it('makes the header, body, drawer and live tail inert while the dialog is open, and only then', async () => {
    const user = userEvent.setup();
    act(() => {
      applySessionSnapshot({
        session: SYNTHETIC_SESSION,
        connection: { status: 'not-paired' },
        binding: { kind: 'unbound' },
      });
    });
    const { container } = render(<App theme="dark" />);

    const dialog = getDialog();
    const header = requireElement(container, 'header');
    const main = requireElement(container, 'main');
    const liveTail = requireElement(container, 'section[aria-label="Live event tail"]');
    expect(header.hasAttribute('inert')).toBe(true);
    expect(main.hasAttribute('inert')).toBe(true);
    expect(liveTail.hasAttribute('inert')).toBe(true);
    expect(dialog.closest('[inert]')).toBeNull();
    expect(document.activeElement).toBe(getField());

    // An event selected behind the dialog opens an inert drawer, and the
    // drawer's own attempt to take focus is pulled back into the dialog.
    act(() => {
      selectEvent({ eventId: 'event-synthetic-1' });
    });
    const drawer = requireElement(container, 'aside');
    expect(drawer.hasAttribute('inert')).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);

    // A background control focused by script is pulled back as well.
    within(header).getByRole('button', { name: 'Pair…' }).focus();
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: CANCEL_NAME }));

    expect(screen.queryByRole('dialog')).toBeNull();
    for (const region of [header, main, liveTail, requireElement(container, 'aside')]) {
      expect(region.hasAttribute('inert')).toBe(false);
    }
  });

  it('sends a dialog that opened by itself back to the panel body on close', async () => {
    const user = userEvent.setup();
    act(() => {
      setConnectionStatus('not-paired');
    });
    const { container } = render(<App theme="dark" />);

    await user.click(within(getDialog()).getByRole('button', { name: CANCEL_NAME }));

    expect(document.activeElement).toBe(requireElement(container, 'main'));
  });

  it('returns focus to the header control that reopened the dialog', async () => {
    const user = userEvent.setup();
    act(() => {
      setConnectionStatus('not-paired');
    });
    const { container } = render(<App theme="dark" />);
    await user.click(within(getDialog()).getByRole('button', { name: CANCEL_NAME }));

    const header = requireElement(container, 'header');
    const pairControl = within(header).getByRole('button', { name: 'Pair…' });
    await user.click(pairControl);

    expect(header.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(getField());

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(header.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(pairControl);
  });

  it('redeems only the normalised code through the pair.complete port request', async () => {
    const user = userEvent.setup();
    act(() => {
      setConnectionStatus('not-paired');
    });
    render(<App theme="dark" />);

    await user.type(getField(), 'abcd{Enter}');
    expect(panelRequestMock).not.toHaveBeenCalledWith('pair.complete', expect.anything());

    await user.type(getField(), '2345{Enter}');

    expect(panelRequestMock).toHaveBeenCalledWith('pair.complete', { code: 'ABCD2345' });
  });
});
