/**
 * The live-response render oracle of `panel-data.test.ts` (AAP §0.4.2, §0.8.3):
 * mounts `PanelHost` from `@debuggen/panel-renderer` over a DataProvider whose
 * every answer is a real `POST /sessions/:id/panel-data` response from the
 * in-process service, and reports, per node of the specification, which of the
 * renderer's states the node settled in.
 *
 * ## Why this file exists, and why it is the only one of its kind
 *
 * The service renders nothing (AAP §0.2.2): no file under `src/**` imports the
 * renderer, and the renderer, React, react-dom and happy-dom are
 * devDependencies of this workspace only. This helper is the single exception,
 * and it is scoped twice: `eslint.config.js` admits `@debuggen/panel-renderer`
 * for `test/integration/render/**` alone, and `tsconfig.json` references the
 * renderer project for this file alone. Every renderer, React and DOM import of
 * the integration suite lives here, so the suites import plain report types.
 *
 * ## The DOM exists for the duration of one mount
 *
 * The integration project runs under Vitest's `node` environment, and it must:
 * the in-process service answers through hono on Node's `Request`/`Response`,
 * talks `ws` and holds a `node:sqlite` store, all of which expect Node's
 * globals. So no DOM environment is configured for the file. Instead
 * {@link mountLivePanel} creates one happy-dom `Window` per mount and installs
 * its globals only while the panel is mounted:
 *
 * - `window` and `document` always, and every other key of the window that
 *   `globalThis` does not already have. What Node already provides — `fetch`,
 *   `Request`, `Response`, `Headers`, `URL`, `AbortController`, `Event`,
 *   `EventTarget`, `WebSocket`, `navigator`, the timers — stays Node's, so the
 *   service and protocol's `HttpClient` behave exactly as in every other suite.
 * - `IS_REACT_ACT_ENVIRONMENT = true`, so React accepts the `act` calls below.
 * - Exactly those keys are removed again afterwards, on failure too, and the
 *   window is closed after the root is unmounted, cancelling its timers.
 *
 * react-dom computes whether a DOM exists (`canUseDOM`) when its module is
 * first evaluated, so `react`, `react-dom/client` and the renderer are imported
 * dynamically, after the globals exist. Only type imports of them are static,
 * and those are erased (`verbatimModuleSyntax`).
 *
 * ## What "settled" and "populated" mean here
 *
 * Read off the renderer's own markup, never off an invented marker:
 *
 * - `host/NodeRenderer.tsx` wraps every node in `div.dg-panel__node` carrying
 *   `data-node-path` — the node's path joined with `.`, which for a normalized
 *   panel is its id — and adds `dg-panel__node-error` to that frame when it
 *   cannot draw the node (a registry miss, unreadable container children).
 * - `primitives/LoadingState.tsx` renders `.dg-loading-state` as the one busy
 *   `role="status"` (`aria-busy="true"`); `primitives/ErrorState.tsx` renders
 *   `.dg-error-state` (`role="alert"`, or `role="status"` for a polite repeat);
 *   `primitives/EmptyState.tsx` renders `.dg-empty-state`. These are the markers
 *   `host/registry.test.ts` reads in `expectSettledSuccess`.
 *
 * A node's state is judged from its own frame's content, excluding every
 * nested node frame, so a container is not blamed for a child's state and a
 * child's populated table does not vouch for its container.
 *
 * ## Privacy
 *
 * Nothing here logs. The report carries node ids, types, the queries the spec
 * declared and the service's parsed answers; the suite decides what it asserts
 * on, and never puts a captured value into an assertion message.
 *
 * @example
 * ```ts
 * const report = await mountLivePanel({
 *   spec,
 *   client: harness.http(),
 *   documentUrl: harness.url,
 *   settleTimeoutMs: HARNESS_TIMEOUTS.request,
 * });
 * expect(report.nodes.filter((node) => node.state !== 'populated')).toEqual([]);
 * ```
 */

import { setTimeout as delay } from 'node:timers/promises';

import { Window } from 'happy-dom';
import type { Element as DomElement } from 'happy-dom';

import type { PanelHostActions } from '@debuggen/panel-renderer';
import { walkPanelNodes } from '@debuggen/panel-schema';
import type { DataQuery, PanelNodeType, PanelSpec } from '@debuggen/panel-schema';
import { HTTP_ROUTES } from '@debuggen/protocol';
import type { DataResult, HttpClient } from '@debuggen/protocol';
import { isErr } from '@debuggen/shared';
import type { DebuggenErrorCode } from '@debuggen/shared';

import { PANEL_DATA_OPERATION } from '../../../src/server/routes/panel-data.js';

/* -------------------------------------------------------------------------------------------------
 * Public report shapes
 * ---------------------------------------------------------------------------------------------- */

/**
 * The state one node settled in, read from its frame:
 *
 * - `populated` — the node drew its content: none of the three state
 *   primitives in its own frame, and the frame is not empty.
 * - `empty` — its own frame holds the renderer's `EmptyState`.
 * - `error` — its own frame holds the renderer's `ErrorState`.
 * - `loading` — its own frame still holds the renderer's `LoadingState`.
 * - `unrendered` — `NodeRenderer` drew its failure frame instead of the node
 *   (a type the registry has no component for, unreadable children).
 * - `blank` — a frame with no content at all, which `NodeRenderer` promises
 *   never happens.
 * - `absent` — no frame carries the node's path.
 */
export type LiveNodeState =
  'populated' | 'empty' | 'error' | 'loading' | 'unrendered' | 'blank' | 'absent';

/** One node of the mounted specification and what it rendered. */
export interface LiveNodeReport {
  /** The node's `id`, as the specification names it. */
  readonly id: string;
  /** The node's document path joined with `.` — the frame's `data-node-path`. */
  readonly path: string;
  /** The node's type, from the specification. */
  readonly type: PanelNodeType;
  /** The query the node carries, or `undefined` for a container or a source link. */
  readonly query: DataQuery | undefined;
  /** How many children the specification gives the node; `0` for a leaf. */
  readonly childCount: number;
  /** How many node frames were rendered directly inside this node's frame. */
  readonly renderedChildCount: number;
  /** The state the node settled in. */
  readonly state: LiveNodeState;
}

/** The outcome of one request the live DataProvider sent. */
export type LiveExchangeOutcome =
  | { readonly ok: true; readonly result: DataResult }
  | { readonly ok: false; readonly code: DebuggenErrorCode };

/** One request/response pair, recorded in the order the requests settled. */
export interface LiveExchange {
  /** The session the request was addressed to: the specification's own. */
  readonly sessionId: string;
  /** The query exactly as the renderer handed it to the provider. */
  readonly query: DataQuery;
  /** The service's parsed answer, or the code it was refused with. */
  readonly outcome: LiveExchangeOutcome;
}

/** Everything one mount observed. */
export interface LivePanelReport {
  /**
   * Whether the panel settled before the timeout: no request in flight and no
   * node frame still showing its loading state.
   */
  readonly settled: boolean;
  /** How long mounting and settling took, in milliseconds. */
  readonly elapsedMs: number;
  /** Every node of the specification, in document pre-order. */
  readonly nodes: readonly LiveNodeReport[];
  /** Every request the provider sent, with its answer. */
  readonly exchanges: readonly LiveExchange[];
  /** How many interactions the panel reported to its host actions while mounted. */
  readonly interactions: number;
  /** How many global keys were installed for the mount and removed afterwards. */
  readonly installedGlobals: number;
}

/** What {@link mountLivePanel} needs. */
export interface LivePanelMountOptions {
  /** The validated, normalized specification to mount. Its `sessionId` addresses every query. */
  readonly spec: PanelSpec;
  /** The protocol client the provider sends every `panel.data` request through. */
  readonly client: HttpClient;
  /** The URL of the happy-dom document the panel is mounted in. */
  readonly documentUrl: string;
  /** How long the panel may take to settle; {@link DEFAULT_SETTLE_TIMEOUT_MS} when omitted. */
  readonly settleTimeoutMs?: number | undefined;
}

/** How long a mount waits for every node to settle when the caller names no bound. */
export const DEFAULT_SETTLE_TIMEOUT_MS = 15_000;

/* -------------------------------------------------------------------------------------------------
 * The renderer's markup, as its sources define it
 * ---------------------------------------------------------------------------------------------- */

/** `NodeRenderer.tsx` `NODE_CLASS`, as a selector: every node's frame. */
const NODE_FRAME_SELECTOR = '.dg-panel__node';

/** The attribute `NodeRenderer.tsx` writes each frame's document path under. */
const NODE_PATH_ATTRIBUTE = 'data-node-path';

/** The class `NodeRenderer.tsx` adds to a frame it could not draw the node in. */
const NODE_FAILURE_CLASS = 'dg-panel__node-error';

/**
 * The three state primitives, each by its root class and, where it owns one,
 * its live-region role — checked in this order, so a failure is never
 * reported as something milder.
 */
const STATE_SELECTORS: readonly (readonly [LiveNodeState, string])[] = Object.freeze([
  ['error', '.dg-error-state, [role="alert"]'],
  ['loading', '.dg-loading-state, [aria-busy="true"]'],
  ['empty', '.dg-empty-state'],
]);

/** How often the settle loop re-reads the document, advancing React inside `act` in between. */
const SETTLE_POLL_INTERVAL_MS = 20;

/** The path parameter `panel.data` is addressed by, from protocol's route table. */
const SESSION_PARAM = HTTP_ROUTES[PANEL_DATA_OPERATION].params[0];

/** The flag React reads to accept `act` outside a test renderer. */
const ACT_ENVIRONMENT_FLAG = 'IS_REACT_ACT_ENVIRONMENT';

/** The two keys installed whether or not `globalThis` already holds them. */
const ALWAYS_INSTALLED_KEYS = Object.freeze(['window', 'document'] as const);

/* -------------------------------------------------------------------------------------------------
 * DOM globals, for one mount
 * ---------------------------------------------------------------------------------------------- */

/** The globals one mount installed, and the way back. */
interface InstalledGlobals {
  /** How many keys were defined on `globalThis`, the act flag included. */
  readonly count: number;
  /** Removes every key that was added and restores every key that was replaced. */
  restore(): void;
}

/**
 * Every string-named property of the window along its prototype chain, below
 * `Object.prototype`: the classes, accessors and methods a page would see.
 */
function windowKeys(window: Window): readonly string[] {
  const keys = new Set<string>();
  let level: object | null = window;
  while (level !== null && level !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(level)) {
      if (key !== 'constructor') {
        keys.add(key);
      }
    }
    level = Reflect.getPrototypeOf(level);
  }
  return [...keys];
}

/**
 * Whether a key names a constructor: the DOM's classes are capitalized, and a
 * class must be handed over as itself rather than bound.
 */
function isClassLikeKey(key: string): boolean {
  return /^[A-Z]/u.test(key);
}

/**
 * Installs the window's globals on `globalThis` as accessors that read the
 * window at call time — so a value the window changes (`scrollY`, `event`) is
 * current — with methods bound to the window, and assignments kept in an
 * override the accessor then answers with.
 */
function installDomGlobals(window: Window): InstalledGlobals {
  const added: string[] = [];
  const replaced = new Map<string, PropertyDescriptor>();
  const bound = new Map<string, unknown>();
  const overrides = new Map<string, unknown>();

  const read = (key: string): unknown => {
    if (overrides.has(key)) {
      return overrides.get(key);
    }
    const value: unknown = Reflect.get(window, key);
    if (typeof value !== 'function' || isClassLikeKey(key)) {
      return value;
    }
    const cached = bound.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const method: unknown = value.bind(window);
    bound.set(key, method);
    return method;
  };

  const define = (key: string): void => {
    const previous = Reflect.getOwnPropertyDescriptor(globalThis, key);
    const defined = Reflect.defineProperty(globalThis, key, {
      configurable: true,
      enumerable: false,
      get: () => read(key),
      set: (value: unknown) => {
        overrides.set(key, value);
      },
    });
    if (!defined) {
      throw new Error(`The DOM global ${key} could not be installed for the mount.`);
    }
    if (previous === undefined) {
      added.push(key);
    } else {
      replaced.set(key, previous);
    }
  };

  const restore = (): void => {
    const unrestored = [...replaced].filter(
      ([key, descriptor]) => !Reflect.defineProperty(globalThis, key, descriptor),
    );
    const leftover = added.filter(
      (key) =>
        !Reflect.deleteProperty(globalThis, key) ||
        Reflect.getOwnPropertyDescriptor(globalThis, key) !== undefined,
    );
    if (leftover.length > 0 || unrestored.length > 0) {
      throw new Error(
        `${String(leftover.length)} DOM globals survived the mount and ${String(unrestored.length)} could not be restored.`,
      );
    }
  };

  try {
    for (const key of ALWAYS_INSTALLED_KEYS) {
      define(key);
    }
    for (const key of windowKeys(window)) {
      if (!(key in globalThis)) {
        define(key);
      }
    }
    const previousFlag = Reflect.getOwnPropertyDescriptor(globalThis, ACT_ENVIRONMENT_FLAG);
    const flagged = Reflect.defineProperty(globalThis, ACT_ENVIRONMENT_FLAG, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: true,
    });
    if (!flagged) {
      throw new Error(`${ACT_ENVIRONMENT_FLAG} could not be set for the mount.`);
    }
    if (previousFlag === undefined) {
      added.push(ACT_ENVIRONMENT_FLAG);
    } else {
      replaced.set(ACT_ENVIRONMENT_FLAG, previousFlag);
    }
  } catch (error) {
    restore();
    throw error;
  }

  return { count: added.length + replaced.size, restore };
}

/* -------------------------------------------------------------------------------------------------
 * The live data provider's transport
 * ---------------------------------------------------------------------------------------------- */

/** The resolver half of the live provider, and what it saw. */
interface ExchangeRecorder {
  /** Every settled request, in settle order. */
  readonly exchanges: readonly LiveExchange[];
  /** How many requests are sent and not yet answered. */
  inFlight(): number;
  /** Resolves once every request sent so far has settled, whatever its outcome. */
  drain(): Promise<void>;
  /**
   * The `PanelDataResolver` handed to the renderer's `createPanelDataProvider`:
   * one real `panel.data` request per call, addressed to the session the
   * renderer names, with the renderer's abort signal. It answers the parsed
   * wire body untouched — the factory maps it into the view form — and rejects
   * with the service's typed `DebuggenError` when the request is refused.
   */
  resolve(
    query: DataQuery,
    context: { readonly sessionId: string; readonly signal?: AbortSignal | undefined },
  ): Promise<DataResult>;
}

/** Builds the recording resolver over one protocol client. */
function createExchangeRecorder(client: HttpClient): ExchangeRecorder {
  const exchanges: LiveExchange[] = [];
  const pending = new Set<Promise<unknown>>();

  const send = async (
    query: DataQuery,
    sessionId: string,
    signal: AbortSignal | undefined,
  ): Promise<DataResult> => {
    const answered = await client.request(PANEL_DATA_OPERATION, {
      params: { [SESSION_PARAM]: sessionId },
      body: query,
      signal,
    });
    if (isErr(answered)) {
      exchanges.push({ sessionId, query, outcome: { ok: false, code: answered.error.code } });
      throw answered.error;
    }
    exchanges.push({ sessionId, query, outcome: { ok: true, result: answered.value } });
    return answered.value;
  };

  return {
    exchanges,
    inFlight: () => pending.size,
    drain: async () => {
      await Promise.allSettled([...pending]);
    },
    resolve: (query, { sessionId, signal }) => {
      const request = send(query, sessionId, signal);
      pending.add(request);
      const forget = (): void => {
        pending.delete(request);
      };
      request.then(forget, forget);
      return request;
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * Reading the rendered document
 * ---------------------------------------------------------------------------------------------- */

/** One node of the specification, as the walk found it. */
interface PlannedNode {
  readonly id: string;
  readonly path: string;
  readonly type: PanelNodeType;
  readonly query: DataQuery | undefined;
  readonly childCount: number;
}

/** Every node of the specification in document pre-order, with the path `NodeRenderer` writes. */
function plannedNodes(spec: PanelSpec): readonly PlannedNode[] {
  const planned: PlannedNode[] = [];
  walkPanelNodes(spec.layout, (node, path) => {
    planned.push({
      id: node.id,
      path: path.join('.'),
      type: node.type,
      query: 'query' in node ? node.query : undefined,
      childCount: 'children' in node ? node.children.length : 0,
    });
  });
  return planned;
}

/** The node frame an element belongs to: its nearest enclosing frame, itself included. */
function frameOf(element: DomElement): DomElement | null {
  return element.closest(NODE_FRAME_SELECTOR);
}

/** Whether `frame` holds an element matching `selector` that belongs to no nested frame. */
function ownsMatch(frame: DomElement, selector: string): boolean {
  return Array.from(frame.querySelectorAll(selector)).some((element) => frameOf(element) === frame);
}

/** The state one frame shows, judged from its own content. */
function frameState(frame: DomElement): LiveNodeState {
  if (frame.classList.contains(NODE_FAILURE_CLASS)) {
    return 'unrendered';
  }
  for (const [state, selector] of STATE_SELECTORS) {
    if (ownsMatch(frame, selector)) {
      return state;
    }
  }
  return frame.children.length === 0 && (frame.textContent ?? '').trim() === ''
    ? 'blank'
    : 'populated';
}

/** Every node of the plan, read from the document as it stands. */
function readNodes(container: DomElement, planned: readonly PlannedNode[]): LiveNodeReport[] {
  const frames = new Map<string, DomElement>();
  const childFrames = new Map<DomElement, number>();
  for (const frame of Array.from(container.querySelectorAll(NODE_FRAME_SELECTOR))) {
    const path = frame.getAttribute(NODE_PATH_ATTRIBUTE);
    if (path !== null && !frames.has(path)) {
      frames.set(path, frame);
    }
    const parent = frame.parentElement === null ? null : frameOf(frame.parentElement);
    if (parent !== null) {
      childFrames.set(parent, (childFrames.get(parent) ?? 0) + 1);
    }
  }
  return planned.map((node) => {
    const frame = frames.get(node.path);
    return {
      ...node,
      renderedChildCount: frame === undefined ? 0 : (childFrames.get(frame) ?? 0),
      state: frame === undefined ? 'absent' : frameState(frame),
    };
  });
}

/** Whether nothing is left to wait for: no request in flight, no node still loading. */
function isSettled(nodes: readonly LiveNodeReport[], recorder: ExchangeRecorder): boolean {
  return recorder.inFlight() === 0 && nodes.every((node) => node.state !== 'loading');
}

/* -------------------------------------------------------------------------------------------------
 * The mount
 * ---------------------------------------------------------------------------------------------- */

/**
 * Mounts `spec` in a fresh happy-dom document through `PanelHost`, over the
 * renderer's own `createPanelDataProvider` whose resolver performs every
 * request against the real service, waits until every node has settled (or
 * `settleTimeoutMs` has passed), and reports what each node rendered.
 *
 * The panel is unmounted, every in-flight request is drained, the window is
 * closed and the DOM globals are removed before this resolves — on failure
 * too — so nothing of the mount outlives the call.
 *
 * @param options See {@link LivePanelMountOptions}.
 * @returns The per-node report, the recorded exchanges and the settle verdict.
 */
export async function mountLivePanel(options: LivePanelMountOptions): Promise<LivePanelReport> {
  const { spec, client, documentUrl } = options;
  const settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  const planned = plannedNodes(spec);
  const startedAt = Date.now();
  const window = new Window({ url: documentUrl });
  let globals: InstalledGlobals | undefined;

  try {
    globals = installDomGlobals(window);
    const [{ act, createElement }, { createRoot }, renderer] = await Promise.all([
      import('react'),
      import('react-dom/client'),
      import('@debuggen/panel-renderer'),
    ]);

    const recorder = createExchangeRecorder(client);
    const dataProvider = renderer.createPanelDataProvider((query, context) =>
      recorder.resolve(query, context),
    );
    let interactions = 0;
    const actions: PanelHostActions = {
      selectEvent: () => {
        interactions += 1;
      },
      openSource: () => {
        interactions += 1;
      },
    };

    const container = window.document.createElement('div');
    window.document.body.appendChild(container);
    const root = createRoot(container);
    const advance = async (milliseconds: number): Promise<void> => {
      await act(async () => {
        await delay(milliseconds);
      });
    };

    try {
      await act(async () => {
        root.render(
          createElement(renderer.PanelHost, {
            spec,
            dataProvider,
            actions,
            theme: renderer.DEFAULT_PANEL_THEME,
          }),
        );
        await delay(0);
      });

      const deadline = startedAt + settleTimeoutMs;
      let nodes = readNodes(container, planned);
      while (!isSettled(nodes, recorder) && Date.now() < deadline) {
        await advance(SETTLE_POLL_INTERVAL_MS);
        nodes = readNodes(container, planned);
      }

      return {
        settled: isSettled(nodes, recorder),
        elapsedMs: Date.now() - startedAt,
        nodes,
        exchanges: [...recorder.exchanges],
        interactions,
        installedGlobals: globals.count,
      };
    } finally {
      await act(async () => {
        root.unmount();
        await delay(0);
      });
      await recorder.drain();
    }
  } finally {
    try {
      await window.happyDOM.close();
    } finally {
      globals?.restore();
    }
  }
}
