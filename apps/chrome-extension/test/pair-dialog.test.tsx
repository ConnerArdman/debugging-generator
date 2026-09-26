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
 * **Harness.** Collected by the root `vitest.config.ts` into the
 * `chrome-extension` project (happy-dom). The accessor is the real
 * `createServiceEndpointAccessor` over an in-memory storage area, so the
 * validation under test is `parseServiceEndpoint` itself; the `chrome` global
 * is stubbed only in the case that proves the default accessor. Addresses and
 * the pairing code are neutral synthetic values.
 */

import type { Result } from '@debuggen/shared';
import { DebuggenError, err } from '@debuggen/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServiceEndpointAccessor } from '../src/background/auth';
import {
  createServiceEndpointAccessor,
  SERVICE_ENDPOINT_STORAGE_KEY,
} from '../src/background/auth';
import { PairDialog } from '../src/panel/components/PairDialog';
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
  readonly user: ReturnType<typeof userEvent.setup>;
}

/**
 * Render an open dialog over an accessor for `storage`, recording the order of
 * every save and submit. `accessor: 'platform'` injects none, so the dialog
 * resolves its default.
 */
function renderDialog(
  options: {
    readonly stored?: unknown;
    readonly accessor?: 'injected' | 'platform';
    readonly write?: ServiceEndpointAccessor['write'];
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
  const user = userEvent.setup();
  render(
    <PairDialog
      open
      onClose={onClose}
      submitCode={submitCode}
      serviceEndpoint={options.accessor === 'platform' ? undefined : { read: accessor.read, write }}
    />,
  );
  return { storage, calls, write, submitCode, onClose, user };
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
