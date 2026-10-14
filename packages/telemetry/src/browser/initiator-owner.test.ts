// @vitest-environment happy-dom
/**
 * Colocated tests for `./initiator-owner.ts` — which React component started a
 * request — and for its one wiring point, the `initiatorComponent` /
 * `initiatorOwners` attributes `./fetch.ts` writes on a request event.
 *
 * What is proven here is the property AAP §0.8.2 defect 3 needs and a stack
 * cannot give: **one component mounted under two parents makes its requests
 * from identical code, yet the two mounts are named apart.** The proof runs a
 * real React 19 development renderer under happy-dom with the developer-tools
 * hook installed before React loads — the ordering the page agent guarantees
 * by running at `document_start` — so the renderer injects the internals whose
 * `getCurrentFiber()` this module reads. Nothing is simulated about React.
 *
 * The component vocabulary (an orbit console's readings rail, header, detail
 * view) is invented and shares no name with the demo application.
 */

import { installRDTHook } from 'bippy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { redactEvent } from '../redaction/redactor.js';
import { FETCH_ATTRIBUTE_KEYS, XHR_ATTRIBUTE_KEYS } from '../schema/attributes.js';
import { parseTelemetryEventIngress } from '../schema/event.js';
import type { EventDraft } from './transport.js';

/** Every request draft the patched transports emitted, in order. */
const drafts: EventDraft[] = [];

vi.mock('./transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./transport.js')>();
  return {
    ...actual,
    emit: (draft: EventDraft): void => {
      drafts.push(draft);
      actual.emit(draft);
    },
  };
});

// Installed before React is loaded, exactly as the page agent installs it: a
// renderer injects itself into the hook only if the hook is already there.
installRDTHook();

const react = await import('react');
const { createRoot } = await import('react-dom/client');
const { MAX_INITIATOR_NAME_LENGTH, MAX_INITIATOR_OWNERS, captureInitiatorOwner } =
  await import('./initiator-owner.js');
const { MAX_OWNER_CHAIN } = await import('./react.js');
const { attachFetch, detachFetch } = await import('./fetch.js');
const { getProducerId, newEventId } = await import('./ids.js');

type InitiatorOwner = ReturnType<typeof captureInitiatorOwner>;

const { createElement: h, act, memo, forwardRef, useEffect } = react;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The request URL every rendered case issues; invented. */
const READINGS_URL = '/api/readings';

/** Renders `element` into a fresh container, flushing effects, and returns its unmount. */
async function render(element: ReturnType<typeof h>): Promise<() => Promise<void>> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
  return async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  };
}

/**
 * The invented console: one `ReadingsRail` in the header and one in the gauge
 * detail view, each calling `probe` from the same effect — the same code, the
 * same stack frames, two different places in the tree.
 */
function consoleTree(probe: () => void) {
  function ReadingsRail() {
    useEffect(() => {
      probe();
    }, []);
    return h('aside', null, 'readings');
  }
  function ConsoleHeader() {
    return h('header', null, h('nav', null, h(ReadingsRail)));
  }
  function GaugeDetail() {
    return h('main', null, h('section', null, h(ReadingsRail)));
  }
  function ConsolePage() {
    return h('div', null, h(ConsoleHeader), h(GaugeDetail));
  }
  return h(ConsolePage);
}

describe('captureInitiatorOwner', () => {
  it('names the component whose effect is running and its composite ancestors, nearest first', async () => {
    const seen: InitiatorOwner[] = [];
    const unmount = await render(consoleTree(() => seen.push(captureInitiatorOwner())));

    expect(seen).toEqual([
      { component: 'ReadingsRail', owners: ['ConsoleHeader', 'ConsolePage'] },
      { component: 'ReadingsRail', owners: ['GaugeDetail', 'ConsolePage'] },
    ]);
    await unmount();
  });

  it('names the component whose event handler is running, above the element it is bound to', async () => {
    const seen: InitiatorOwner[] = [];
    function RefreshButton() {
      return h(
        'button',
        { type: 'button', onClick: () => seen.push(captureInitiatorOwner()) },
        'Refresh',
      );
    }
    function GaugeToolbar() {
      return h('div', { role: 'toolbar' }, h('span', null, h(RefreshButton)));
    }
    const unmount = await render(h(GaugeToolbar));

    await act(async () => {
      document.querySelector('button')?.click();
      await Promise.resolve();
    });
    expect(seen).toEqual([{ component: 'RefreshButton', owners: ['GaugeToolbar'] }]);
    await unmount();
  });

  it('answers nothing outside React work, and after an await inside it', async () => {
    const seen: InitiatorOwner[] = [];
    function LateReader() {
      useEffect(() => {
        void Promise.resolve().then(() => seen.push(captureInitiatorOwner()));
      }, []);
      return null;
    }
    const unmount = await render(h(LateReader));

    expect(captureInitiatorOwner()).toBeUndefined();
    expect(seen).toEqual([undefined]);
    await unmount();
  });

  it('spells a memo or forwardRef component by the display name its wrapper carries', async () => {
    const seen: InitiatorOwner[] = [];
    const Dial = memo(function DialImpl() {
      useEffect(() => {
        seen.push(captureInitiatorOwner());
      }, []);
      return null;
    });
    Dial.displayName = 'Dial';
    const Frame = forwardRef<HTMLDivElement>(function FrameImpl(_props, ref) {
      return h('div', { ref }, h(Dial));
    });
    Frame.displayName = 'GaugeFrame';
    const unmount = await render(h(Frame));

    expect(seen).toEqual([{ component: 'Dial', owners: ['GaugeFrame'] }]);
    await unmount();
  });

  it('bounds the owner chain and every name', async () => {
    expect(MAX_INITIATOR_OWNERS).toBe(MAX_OWNER_CHAIN);

    const seen: InitiatorOwner[] = [];
    function Leaf() {
      useEffect(() => {
        seen.push(captureInitiatorOwner());
      }, []);
      return null;
    }
    Leaf.displayName = 'L'.repeat(MAX_INITIATOR_NAME_LENGTH + 40);
    let element = h(Leaf);
    for (let level = 0; level < MAX_INITIATOR_OWNERS + 4; level += 1) {
      const child = element;
      const Level = () => child;
      Object.defineProperty(Level, 'name', { value: `Level${String(level)}` });
      element = h(Level);
    }
    const unmount = await render(element);

    const [owner] = seen;
    expect(owner?.component).toHaveLength(MAX_INITIATOR_NAME_LENGTH);
    expect(owner?.owners).toHaveLength(MAX_INITIATOR_OWNERS);
    expect(owner?.owners[0]).toBe('Level0');
    await unmount();
  });

  it('names the components that wrote the element, not the providers it is nested in', async () => {
    // `ReadingsRail` is written by `ConsoleHeader` but nested, through
    // `children`, inside a provider: its `return` parents are the provider and
    // then the header, its creator is the header alone. The creator chain is
    // the one that says which mount made the request.
    const seen: InitiatorOwner[] = [];
    function ReadingsRail() {
      useEffect(() => {
        seen.push(captureInitiatorOwner());
      }, []);
      return null;
    }
    function SignalProvider({ children }: { readonly children?: ReturnType<typeof h> }) {
      return h('div', null, children);
    }
    function ConsoleHeader() {
      return h(SignalProvider, null, h(ReadingsRail));
    }
    const unmount = await render(h(ConsoleHeader));

    expect(seen).toEqual([{ component: 'ReadingsRail', owners: ['ConsoleHeader'] }]);
    await unmount();
  });

  describe('a creator rendered on the server', () => {
    const hookKey = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('names Server Component creators through the info objects React records for them', () => {
      // What a development renderer reports for a client component a Server
      // Component rendered: the fiber's creator is the server component's info
      // object, whose own creator is another info object.
      function ReadingsRail(): null {
        return null;
      }
      const serverLayout = { name: 'ConsoleLayout', env: 'Server', owner: null };
      const serverPage = { name: 'GaugeDetailPage', env: 'Server', owner: serverLayout };
      const fiber = { tag: 0, type: ReadingsRail, return: null, _debugOwner: serverPage };
      vi.stubGlobal(hookKey, {
        renderers: new Map([[1, { bundleType: 1, getCurrentFiber: () => fiber }]]),
      });

      expect(captureInitiatorOwner()).toEqual({
        component: 'ReadingsRail',
        owners: ['GaugeDetailPage', 'ConsoleLayout'],
      });
    });

    it('falls back to the composite parents when the build records no creator', () => {
      function ReadingsRail(): null {
        return null;
      }
      function ConsoleHeader(): null {
        return null;
      }
      const parent = { tag: 0, type: ConsoleHeader, return: null };
      const host = { tag: 5, type: 'nav', return: parent };
      const fiber = { tag: 0, type: ReadingsRail, return: host };
      vi.stubGlobal(hookKey, {
        renderers: new Map([[1, { bundleType: 1, getCurrentFiber: () => fiber }]]),
      });

      expect(captureInitiatorOwner()).toEqual({
        component: 'ReadingsRail',
        owners: ['ConsoleHeader'],
      });
    });
  });

  describe('a renderer that reports no running fiber', () => {
    const hookKey = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('answers nothing without a developer-tools hook', () => {
      vi.stubGlobal(hookKey, undefined);
      expect(captureInitiatorOwner()).toBeUndefined();
    });

    it('answers nothing for a production renderer, which injects no getCurrentFiber', () => {
      vi.stubGlobal(hookKey, { renderers: new Map([[1, { bundleType: 0 }]]) });
      expect(captureInitiatorOwner()).toBeUndefined();
    });

    it('never throws when a renderer does', () => {
      vi.stubGlobal(hookKey, {
        renderers: new Map([
          [
            1,
            {
              bundleType: 1,
              getCurrentFiber: () => {
                throw new TypeError('a renderer that misbehaves by design');
              },
            },
          ],
        ]),
      });
      expect(() => captureInitiatorOwner()).not.toThrow();
      expect(captureInitiatorOwner()).toBeUndefined();
    });
  });
});

describe('the request attributes fetch.ts writes', () => {
  beforeEach(() => {
    drafts.length = 0;
    window.fetch = vi.fn<typeof fetch>(() => Promise.resolve(new Response('[]', { status: 200 })));
    attachFetch();
  });

  afterEach(() => {
    detachFetch();
  });

  /** The request drafts emitted so far, once every pending settle has run. */
  async function settledRequests(): Promise<EventDraft[]> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return drafts.filter((draft) => draft.kind === 'fetch' || draft.kind === 'xhr');
  }

  it('are declared for both request transports alike', () => {
    for (const key of ['initiatorComponent', 'initiatorOwners'] as const) {
      expect(FETCH_ATTRIBUTE_KEYS).toContain(key);
      expect(XHR_ATTRIBUTE_KEYS).toContain(key);
    }
  });

  it('name the two mounts of one component apart on requests their shared effect makes', async () => {
    const unmount = await render(consoleTree(() => void window.fetch(READINGS_URL)));
    const requests = await settledRequests();

    expect(requests).toHaveLength(2);
    expect(requests.map((draft) => draft.attributes['initiatorComponent'])).toEqual([
      'ReadingsRail',
      'ReadingsRail',
    ]);
    expect(requests.map((draft) => draft.attributes['initiatorOwners'])).toEqual([
      ['ConsoleHeader', 'ConsolePage'],
      ['GaugeDetail', 'ConsolePage'],
    ]);
    // The stacks carry no such distinction: both came from the same effect.
    expect(typeof requests[0]?.attributes['initiator']).toBe('string');
    await unmount();
  });

  it('are absent on a request no React work made', async () => {
    await window.fetch(READINGS_URL);
    const [request] = await settledRequests();

    expect(request?.attributes).toBeDefined();
    expect(request?.attributes).not.toHaveProperty('initiatorComponent');
    expect(request?.attributes).not.toHaveProperty('initiatorOwners');
  });

  it('survive the ingest schema and the ingest redaction pass unchanged', async () => {
    const unmount = await render(consoleTree(() => void window.fetch(READINGS_URL)));
    const [request] = await settledRequests();
    await unmount();
    if (request === undefined) {
      throw new Error('no request was emitted');
    }

    // Completed the way the transport completes a draft, then parsed and
    // redacted the way the service's ingest does, in that order.
    const parsed = parseTelemetryEventIngress({
      ...request,
      id: newEventId(),
      producerId: getProducerId(),
      seq: 0,
      tier: 'browser',
    });
    if (!parsed.ok) {
      throw new Error(`the completed draft did not parse: ${parsed.error.message}`);
    }
    const redacted = redactEvent(parsed.value);
    expect(redacted.attributes['initiatorComponent']).toBe('ReadingsRail');
    expect(redacted.attributes['initiatorOwners']).toEqual(['ConsoleHeader', 'ConsolePage']);
  });
});
