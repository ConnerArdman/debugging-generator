/**
 * Unit spec for the service address field of
 * `../src/panel/components/PairDialog.tsx` — the one setting the dialog reads
 * and writes, and the place the developer points the extension at a local
 * service on a port other than the default.
 *
 * Three guarantees, each a case below:
 *
 * - **Saved before the code is sent.** An edited address is validated and
 *   saved (in canonical form) before `submitCode` runs, so the worker — which
 *   re-reads the setting before it redeems — sends the code to that address.
 * - **Refused on the field, not sent.** An address the validator refuses, or a
 *   save storage refuses, is shown on the field (`aria-invalid`, its message)
 *   with focus on it, and the code is not submitted. The message never quotes
 *   the value.
 * - **No field without storage.** Where the document has no
 *   `chrome.storage.local` and no accessor is injected, the field is not
 *   rendered and the dialog behaves exactly as before.
 *
 * And for the address mode, which changes the address of a panel that is
 * already paired:
 *
 * - **The address alone.** No code field; the address field takes focus on
 *   open and after a refusal; an edited address is saved in canonical form,
 *   then `onAddressSaved` and `onClose` run — and `submitCode` never does.
 * - **Only what needs saving is saved.** An untouched, usable address closes
 *   the dialog without a write; an unusable saved value is rewritten, and a
 *   blank field restores the default. A refusal stays on the field.
 * - **No storage, no pretence.** Without an accessor the dialog says the
 *   address cannot be changed from this page and offers "Cancel" alone.
 *
 * **Harness.** Collected by the root `vitest.config.ts` into the
 * `chrome-extension` project (happy-dom). The accessor is the real
 * `createServiceEndpointAccessor` over an in-memory storage area, so the
 * validation under test is `parseServiceEndpoint` itself; the `chrome` global
 * is stubbed only in the case that proves the default accessor. Addresses and
 * the pairing code are neutral synthetic values.
 */

import type { Result } from '@debuggen/shared';
import { DebuggenError, err, ok } from '@debuggen/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServiceEndpointAccessor } from '../src/background/auth';
import {
  createServiceEndpointAccessor,
  SERVICE_ENDPOINT_STORAGE_KEY,
} from '../src/background/auth';
import { PairDialog, resolveServiceEndpointAccessor } from '../src/panel/components/PairDialog';
import type { PairDialogMode } from '../src/panel/components/PairDialog';
import { DEFAULT_SERVICE_BASE_URL } from '../src/shared/messages';
import { checkPairingCode } from '../src/shared/pairing-code';

/**
 * An obviously synthetic, well-formed pairing code: eight characters of the
 * service's alphabet (no `0`/`O`, no `1`/`I`), already upper-case. The dialog
 * submits only a code `checkPairingCode` accepts, so a malformed one would be
 * refused on the code field before the address behaviour under test is ever
 * reached.
 */
const CODE = 'TEST2345';

/** A service on a loopback port other than the default one. */
const OTHER_SERVICE_URL = 'http://127.0.0.1:20150';

/** An address the extension cannot reach: https is not granted. */
const REFUSED_ADDRESS = 'https://127.0.0.1:20150';

/** An in-memory `chrome.storage.local` whose three methods are recording mocks. */
interface MemoryStorage {
  readonly items: Map<string, unknown>;
  readonly get: Mock<(key: string) => Promise<Record<string, unknown>>>;
  readonly set: Mock<(next: Readonly<Record<string, unknown>>) => Promise<void>>;
  readonly remove: Mock<(key: string) => Promise<void>>;
}

function createMemoryStorage(initial: Readonly<Record<string, unknown>> = {}): MemoryStorage {
  const items = new Map<string, unknown>(Object.entries(initial));
  return {
    items,
    get: vi.fn((key: string) =>
      Promise.resolve<Record<string, unknown>>(items.has(key) ? { [key]: items.get(key) } : {}),
    ),
    set: vi.fn((next: Readonly<Record<string, unknown>>) => {
      for (const [key, value] of Object.entries(next)) {
        items.set(key, value);
      }
      return Promise.resolve();
    }),
    remove: vi.fn((key: string) => {
      items.delete(key);
      return Promise.resolve();
    }),
  };
}

/** Everything a case drives or inspects. */
interface DialogHarness {
  readonly storage: MemoryStorage;
  /** The order the save and the submit happened in. */
  readonly calls: string[];
  readonly write: Mock<ServiceEndpointAccessor['write']>;
  readonly submitCode: Mock<(code: string) => Promise<void>>;
  readonly onClose: Mock<() => void>;
  readonly onAddressSaved: Mock<() => void>;
  readonly user: ReturnType<typeof userEvent.setup>;
}

/**
 * Render an open dialog over an accessor for `storage`, recording the order of
 * every save and submit. `accessor: 'platform'` injects none, so the dialog
 * resolves its default; `mode` is forwarded as given, so omitting it proves
 * the default.
 */
function renderDialog(
  options: {
    readonly stored?: unknown;
    readonly accessor?: 'injected' | 'platform';
    readonly write?: ServiceEndpointAccessor['write'];
    readonly mode?: PairDialogMode;
  } = {},
): DialogHarness {
  const storage = createMemoryStorage(
    options.stored === undefined ? {} : { [SERVICE_ENDPOINT_STORAGE_KEY]: options.stored },
  );
  const accessor = createServiceEndpointAccessor(storage);
  const calls: string[] = [];
  const write = vi.fn<ServiceEndpointAccessor['write']>((raw) => {
    calls.push('write');
    return (options.write ?? accessor.write)(raw);
  });
  const submitCode = vi.fn<(code: string) => Promise<void>>(() => {
    calls.push('submit');
    return Promise.resolve();
  });
  const onClose = vi.fn<() => void>();
  const onAddressSaved = vi.fn<() => void>();
  const user = userEvent.setup();
  render(
    <PairDialog
      open
      mode={options.mode}
      onClose={onClose}
      submitCode={submitCode}
      onAddressSaved={onAddressSaved}
      serviceEndpoint={options.accessor === 'platform' ? undefined : { read: accessor.read, write }}
    />,
  );
  return { storage, calls, write, submitCode, onClose, onAddressSaved, user };
}

function codeField(): HTMLElement {
  return screen.getByRole('textbox', { name: /pairing code/i });
}

function addressField(): HTMLInputElement {
  const field = screen.getByRole('textbox', { name: /service address/i });
  if (!(field instanceof HTMLInputElement)) {
    throw new Error('the service address field is not an input');
  }
  return field;
}

function pairButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Pair' });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the pairing-code fixture', () => {
  it('is a code the dialog submits unchanged', () => {
    expect(checkPairingCode(CODE)).toEqual({ valid: true, code: CODE });
  });
});

describe('PairDialog: the service address field', () => {
  it('saves an edited address in canonical form before the code is submitted', async () => {
    const h = renderDialog();

    await h.user.type(codeField(), CODE);
    await h.user.type(addressField(), ' http://localhost:20150/ ');
    await h.user.click(pairButton());

    await waitFor(() => {
      expect(h.submitCode).toHaveBeenCalledWith(CODE);
    });
    expect(h.calls).toEqual(['write', 'submit']);
    expect(h.storage.items.get(SERVICE_ENDPOINT_STORAGE_KEY)).toBe('http://localhost:20150');
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it('refuses an unusable address on the field — without submitting the code — and takes focus there', async () => {
    const h = renderDialog({ stored: OTHER_SERVICE_URL });
    await waitFor(() => {
      expect(addressField().value).toBe(OTHER_SERVICE_URL);
    });

    await h.user.type(codeField(), CODE);
    await h.user.clear(addressField());
    await h.user.type(addressField(), REFUSED_ADDRESS);
    await h.user.click(pairButton());

    await waitFor(() => {
      expect(addressField().getAttribute('aria-invalid')).toBe('true');
    });
    expect(h.submitCode).not.toHaveBeenCalled();
    expect(h.storage.set).not.toHaveBeenCalled();
    expect(h.storage.items.get(SERVICE_ENDPOINT_STORAGE_KEY)).toBe(OTHER_SERVICE_URL);
    expect(document.activeElement).toBe(addressField());
    expect(screen.getByText(/must use http/i)).toBeTruthy();
    // The value is in the field's own `value` only, never in the rendered text.
    expect(document.body.textContent).not.toContain(REFUSED_ADDRESS);

    // Editing clears the refusal; a usable address then saves and submits.
    await h.user.clear(addressField());
    expect(addressField().getAttribute('aria-invalid')).toBeNull();
    await h.user.type(addressField(), 'http://127.0.0.1:20160');
    await h.user.click(pairButton());
    await waitFor(() => {
      expect(h.submitCode).toHaveBeenCalledWith(CODE);
    });
    expect(h.storage.items.get(SERVICE_ENDPOINT_STORAGE_KEY)).toBe('http://127.0.0.1:20160');
  });

  it('prefills the saved address, keeps focus on the code field, and leaves an untouched address alone', async () => {
    const h = renderDialog({ stored: OTHER_SERVICE_URL });

    await waitFor(() => {
      expect(addressField().value).toBe(OTHER_SERVICE_URL);
    });
    expect(document.activeElement).toBe(codeField());
    expect(addressField().placeholder).toBe(DEFAULT_SERVICE_BASE_URL);

    await h.user.type(codeField(), CODE);
    await h.user.click(pairButton());

    await waitFor(() => {
      expect(h.submitCode).toHaveBeenCalledWith(CODE);
    });
    expect(h.write).not.toHaveBeenCalled();
    expect(h.storage.items.get(SERVICE_ENDPOINT_STORAGE_KEY)).toBe(OTHER_SERVICE_URL);
  });

  it('says why a saved address is unusable, and restores the default when the field is submitted blank', async () => {
    const h = renderDialog({ stored: 'http://[::1]:20150' });

    await waitFor(() => {
      expect(addressField().getAttribute('aria-invalid')).toBe('true');
    });
    expect(addressField().value).toBe('');
    expect(document.activeElement).toBe(codeField());

    await h.user.type(codeField(), CODE);
    await h.user.click(pairButton());

    await waitFor(() => {
      expect(h.submitCode).toHaveBeenCalledWith(CODE);
    });
    expect(h.calls).toEqual(['write', 'submit']);
    expect(h.storage.items.has(SERVICE_ENDPOINT_STORAGE_KEY)).toBe(false);
  });

  it('shows a save that storage refused on the field, without submitting the code', async () => {
    const refused: Result<string | undefined, DebuggenError> = err(
      new DebuggenError(
        'STORE_ERROR',
        'The service address could not be saved in extension storage.',
      ),
    );
    const h = renderDialog({ write: () => Promise.resolve(refused) });

    await h.user.type(codeField(), CODE);
    await h.user.type(addressField(), OTHER_SERVICE_URL);
    await h.user.click(pairButton());

    await waitFor(() => {
      expect(addressField().getAttribute('aria-invalid')).toBe('true');
    });
    expect(screen.getByText(/could not be saved/i)).toBeTruthy();
    expect(h.submitCode).not.toHaveBeenCalled();
  });

  it('contains an injected accessor that throws, as a failed save', async () => {
    const h = renderDialog({
      write: () => Promise.reject(new Error('the accessor broke')),
    });

    await h.user.type(codeField(), CODE);
    await h.user.type(addressField(), OTHER_SERVICE_URL);
    await h.user.click(pairButton());

    await waitFor(() => {
      expect(addressField().getAttribute('aria-invalid')).toBe('true');
    });
    expect(h.submitCode).not.toHaveBeenCalled();
  });

  it('renders no address field where the document has no chrome.storage, and pairs exactly as before', async () => {
    expect(typeof (globalThis as { chrome?: unknown }).chrome).toBe('undefined');
    const h = renderDialog({ accessor: 'platform' });

    expect(screen.queryByRole('textbox', { name: /service address/i })).toBeNull();
    expect(document.activeElement).toBe(codeField());
    await h.user.type(codeField(), CODE);
    await h.user.click(pairButton());

    await waitFor(() => {
      expect(h.submitCode).toHaveBeenCalledWith(CODE);
    });
    expect(h.calls).toEqual(['submit']);
  });

  it("uses this document's chrome.storage.local by default, resolved when the dialog opens", async () => {
    const storage = createMemoryStorage({ [SERVICE_ENDPOINT_STORAGE_KEY]: OTHER_SERVICE_URL });
    vi.stubGlobal('chrome', { storage: { local: storage } });
    const h = renderDialog({ accessor: 'platform' });

    await waitFor(() => {
      expect(addressField().value).toBe(OTHER_SERVICE_URL);
    });
    await h.user.type(codeField(), CODE);
    await h.user.clear(addressField());
    await h.user.type(addressField(), 'http://localhost:20160');
    await h.user.click(pairButton());

    await waitFor(() => {
      expect(h.submitCode).toHaveBeenCalledWith(CODE);
    });
    expect(storage.items.get(SERVICE_ENDPOINT_STORAGE_KEY)).toBe('http://localhost:20160');
  });

  it('still closes on Escape from the address field', async () => {
    const h = renderDialog();

    await h.user.click(addressField());
    await h.user.keyboard('{Escape}');

    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.submitCode).not.toHaveBeenCalled();
  });
});

/** The address mode's primary action at rest. */
function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Save address' });
}

/** A write that settles only when the case says so. */
function deferredWrite(): {
  readonly write: ServiceEndpointAccessor['write'];
  readonly settle: (result: Result<string | undefined, DebuggenError>) => void;
} {
  let settle: (result: Result<string | undefined, DebuggenError>) => void = () => undefined;
  const pending = new Promise<Result<string | undefined, DebuggenError>>((resolve) => {
    settle = resolve;
  });
  return {
    write: () => pending,
    settle: (result) => {
      settle(result);
    },
  };
}

describe('PairDialog: address mode', () => {
  it('offers the address field alone, focused, and saves an edited address without submitting a code', async () => {
    const h = renderDialog({ mode: 'address' });

    expect(screen.getByRole('dialog', { name: 'Change the service address' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /pairing code/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pair' })).toBeNull();
    expect(document.activeElement).toBe(addressField());
    expect(addressField().placeholder).toBe(DEFAULT_SERVICE_BASE_URL);

    await h.user.type(addressField(), ' http://localhost:20150/ ');
    await h.user.click(saveButton());

    await waitFor(() => {
      expect(h.onClose).toHaveBeenCalledTimes(1);
    });
    expect(h.storage.items.get(SERVICE_ENDPOINT_STORAGE_KEY)).toBe('http://localhost:20150');
    expect(h.calls).toEqual(['write']);
    expect(h.submitCode).not.toHaveBeenCalled();
    expect(h.onAddressSaved).toHaveBeenCalledTimes(1);
    const [savedOrder] = h.onAddressSaved.mock.invocationCallOrder;
    const [closedOrder] = h.onClose.mock.invocationCallOrder;
    expect(savedOrder).toBeLessThan(closedOrder ?? Number.NaN);
  });

  it('is busy while the save is in flight, and saves once however often it is submitted', async () => {
    const deferred = deferredWrite();
    const h = renderDialog({ mode: 'address', write: deferred.write });

    await h.user.type(addressField(), OTHER_SERVICE_URL);
    await h.user.click(saveButton());

    const busy = screen.getByRole('button', { name: 'Saving…' });
    expect(busy instanceof HTMLButtonElement && busy.disabled).toBe(true);
    expect(addressField().disabled).toBe(true);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-busy')).toBe('true');
    // Focus is parked on the dialog, so Escape still reaches it.
    expect(document.activeElement).toBe(dialog);
    const form = dialog.querySelector('form');
    if (form === null) {
      throw new Error('the address mode renders no form');
    }
    fireEvent.submit(form);
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.onClose).not.toHaveBeenCalled();

    deferred.settle(ok(OTHER_SERVICE_URL));

    await waitFor(() => {
      expect(h.onClose).toHaveBeenCalledTimes(1);
    });
    expect(h.onAddressSaved).toHaveBeenCalledTimes(1);
    expect(h.submitCode).not.toHaveBeenCalled();
  });

  it('refuses an unusable address on the field, with focus there, and saves nothing', async () => {
    const h = renderDialog({ mode: 'address', stored: OTHER_SERVICE_URL });
    await waitFor(() => {
      expect(addressField().value).toBe(OTHER_SERVICE_URL);
    });

    await h.user.clear(addressField());
    await h.user.type(addressField(), `${REFUSED_ADDRESS}{Enter}`);

    await waitFor(() => {
      expect(addressField().getAttribute('aria-invalid')).toBe('true');
    });
    expect(document.activeElement).toBe(addressField());
    expect(screen.getByText(/must use http/i)).toBeTruthy();
    expect(document.body.textContent).not.toContain(REFUSED_ADDRESS);
    expect(h.storage.set).not.toHaveBeenCalled();
    expect(h.storage.items.get(SERVICE_ENDPOINT_STORAGE_KEY)).toBe(OTHER_SERVICE_URL);
    expect(h.onClose).not.toHaveBeenCalled();
    expect(h.onAddressSaved).not.toHaveBeenCalled();
    expect(saveButton()).toBeTruthy();

    // The same refused value submitted again is refused again, focus included.
    await h.user.click(saveButton());
    await waitFor(() => {
      expect(document.activeElement).toBe(addressField());
    });
    expect(addressField().getAttribute('aria-invalid')).toBe('true');
    expect(h.write).toHaveBeenCalledTimes(2);
    expect(h.storage.set).not.toHaveBeenCalled();
  });

  it('shows a save that storage refused, or an accessor that throws, on the field', async () => {
    const refused: Result<string | undefined, DebuggenError> = err(
      new DebuggenError(
        'STORE_ERROR',
        'The service address could not be saved in extension storage.',
      ),
    );
    const refusing = renderDialog({ mode: 'address', write: () => Promise.resolve(refused) });

    await refusing.user.type(addressField(), `${OTHER_SERVICE_URL}{Enter}`);

    await waitFor(() => {
      expect(addressField().getAttribute('aria-invalid')).toBe('true');
    });
    expect(screen.getByText(/could not be saved/i)).toBeTruthy();
    expect(document.activeElement).toBe(addressField());
    expect(refusing.onClose).not.toHaveBeenCalled();
    cleanup();

    const throwing = renderDialog({
      mode: 'address',
      write: () => Promise.reject(new Error('the accessor broke')),
    });

    await throwing.user.type(addressField(), `${OTHER_SERVICE_URL}{Enter}`);

    await waitFor(() => {
      expect(addressField().getAttribute('aria-invalid')).toBe('true');
    });
    expect(document.activeElement).toBe(addressField());
    expect(throwing.onClose).not.toHaveBeenCalled();
    expect(throwing.onAddressSaved).not.toHaveBeenCalled();
  });

  it('closes without writing when the address is untouched and usable', async () => {
    const h = renderDialog({ mode: 'address', stored: OTHER_SERVICE_URL });
    await waitFor(() => {
      expect(addressField().value).toBe(OTHER_SERVICE_URL);
    });

    await h.user.click(saveButton());

    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.onAddressSaved).not.toHaveBeenCalled();
    expect(h.storage.items.get(SERVICE_ENDPOINT_STORAGE_KEY)).toBe(OTHER_SERVICE_URL);
  });

  it('says why a saved address is unusable, and restores the default when the field is saved blank', async () => {
    const h = renderDialog({ mode: 'address', stored: 'http://[::1]:20150' });

    await waitFor(() => {
      expect(addressField().getAttribute('aria-invalid')).toBe('true');
    });
    expect(addressField().value).toBe('');
    expect(document.activeElement).toBe(addressField());

    await h.user.click(saveButton());

    await waitFor(() => {
      expect(h.onClose).toHaveBeenCalledTimes(1);
    });
    expect(h.calls).toEqual(['write']);
    expect(h.storage.remove).toHaveBeenCalledWith(SERVICE_ENDPOINT_STORAGE_KEY);
    expect(h.storage.items.has(SERVICE_ENDPOINT_STORAGE_KEY)).toBe(false);
    expect(h.onAddressSaved).toHaveBeenCalledTimes(1);
  });

  it('keeps focus inside, returning it to the address field, and closes on Escape without saving', async () => {
    const outside = document.createElement('button');
    outside.textContent = 'Outside';
    document.body.append(outside);
    try {
      const h = renderDialog({ mode: 'address' });

      outside.focus();
      expect(document.activeElement).toBe(addressField());

      await h.user.type(addressField(), OTHER_SERVICE_URL);
      await h.user.keyboard('{Escape}');

      expect(h.onClose).toHaveBeenCalledTimes(1);
      expect(h.write).not.toHaveBeenCalled();
      expect(h.submitCode).not.toHaveBeenCalled();
    } finally {
      outside.remove();
    }
  });

  it('says the address cannot be changed where the document has no chrome.storage, and offers Cancel alone', async () => {
    expect(typeof (globalThis as { chrome?: unknown }).chrome).toBe('undefined');
    const h = renderDialog({ mode: 'address', accessor: 'platform' });

    const dialog = screen.getByRole('dialog', { name: 'Change the service address' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save address' })).toBeNull();
    const describedBy = dialog.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toMatch(
      /cannot be changed from this page/i,
    );
    // No field to take focus: the dialog element holds it, so Escape still works.
    expect(document.activeElement).toBe(dialog);

    const cancel = screen.getByRole('button', { name: 'Cancel' });
    await h.user.tab();
    expect(document.activeElement).toBe(cancel);

    await h.user.click(cancel);
    expect(h.onClose).toHaveBeenCalledTimes(1);
    await h.user.keyboard('{Escape}');
    expect(h.onClose).toHaveBeenCalledTimes(2);
    expect(h.submitCode).not.toHaveBeenCalled();
  });

  it("uses this document's chrome.storage.local by default, resolved when the dialog opens", async () => {
    const storage = createMemoryStorage({ [SERVICE_ENDPOINT_STORAGE_KEY]: OTHER_SERVICE_URL });
    vi.stubGlobal('chrome', { storage: { local: storage } });
    const h = renderDialog({ mode: 'address', accessor: 'platform' });

    await waitFor(() => {
      expect(addressField().value).toBe(OTHER_SERVICE_URL);
    });
    await h.user.clear(addressField());
    await h.user.type(addressField(), 'http://localhost:20160{Enter}');

    await waitFor(() => {
      expect(h.onClose).toHaveBeenCalledTimes(1);
    });
    expect(storage.items.get(SERVICE_ENDPOINT_STORAGE_KEY)).toBe('http://localhost:20160');
    expect(h.submitCode).not.toHaveBeenCalled();
  });
});

describe('resolveServiceEndpointAccessor', () => {
  it('answers undefined where the document has no chrome.storage.local', () => {
    expect(resolveServiceEndpointAccessor()).toBeUndefined();
    vi.stubGlobal('chrome', {});
    expect(resolveServiceEndpointAccessor()).toBeUndefined();
  });

  it("builds an accessor over this document's chrome.storage.local, reading nothing until used", async () => {
    const storage = createMemoryStorage({ [SERVICE_ENDPOINT_STORAGE_KEY]: OTHER_SERVICE_URL });
    vi.stubGlobal('chrome', { storage: { local: storage } });

    const accessor = resolveServiceEndpointAccessor();

    expect(storage.get).not.toHaveBeenCalled();
    expect(await accessor?.read()).toEqual(ok(OTHER_SERVICE_URL));
  });
});
