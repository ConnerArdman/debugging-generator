/**
 * `panel-render` — the built extension's panel document renders a stored
 * `PanelSpec` that holds **every** catalogued node type.
 *
 * ## What this spec proves, and what it leaves to others
 *
 * The unit suites of `packages/panel-renderer` render each component under
 * happy-dom and `host/registry.test.ts` pins the registry to the catalog. What
 * none of them can show is that the **shipped** bundle — `apps/chrome-extension/
 * dist`, loaded unpacked into a real Chromium — boots its React panel app,
 * receives a panel over the extension's own port contract, asks for each node's
 * data through its `DataProvider`, and draws every node type, its summary, its
 * source chips, its fallback banner and its theme — and, for a panel whose
 * nodes carry no titles, the catalogue-label heading every view is still
 * named by. That is this file's subject.
 * The built manifest belongs to `apps/chrome-extension/test/manifest.test.ts`,
 * and the service-side click-to-source round trip to `source-navigation.spec.ts`.
 *
 * ## Catalog-driven, never a list
 *
 * The expected node-type set is `expectedRenderedNodeTypes()`, which reads the
 * keys of `@debuggen/panel-schema`'s `PANEL_NODE_CATALOG` at run time, and the
 * document is `buildCatalogPanelSpec()`, which iterates that same catalog. This
 * file names no node type: a catalog addition joins both the delivered panel and
 * the expectation without an edit here, so it cannot silently go unrendered.
 * Nodes are addressed by their document path and their title, and data checks
 * are keyed by the protocol's closed `DataResult` vocabulary.
 *
 * ## How the panel receives the spec
 *
 * The spec is injected, because no product path can deliver it: the
 * deterministic pipeline never composes every catalogued node type in one
 * panel, and the service serves only panels its own pipeline generated.
 *
 * The channel is a test-owned `chrome.runtime` port. An init script replaces
 * `chrome.runtime.connect` for the `PORT_PANEL` port only, before the panel
 * bundle boots; any other port still reaches the real worker. Every frame the
 * panel posts reaches {@link FakePanelWorker} here, which checks it with the
 * extension's own `isPortRequest`, answers with frames typed by the
 * extension's `PortRpcContract`, serves every `panelData.query` from
 * `resolvePanelDataFixture` (whose results are validated against the
 * protocol's `DataResult` schema), and pushes `panel.generated` as a
 * `PortProtocolPush` built by the protocol's `createEnvelope` and checked by
 * `isPortPush` and `parseMessage`. A change to that contract therefore breaks
 * this spec instead of passing silently. A push the panel's port admission
 * refuses — one carrying a specification that bypassed validation — is never
 * applied: the panel keeps what it shows and announces the refusal, which the
 * invalid-specification test asserts in the shipped bundle.
 *
 * Only the transport is substituted: the React panel app, `PanelView`,
 * `PanelHost`, the component registry and every visualization component run
 * exactly as shipped, and no markup is injected. The assertions therefore
 * prove what the shipped panel does with a spec delivered over its own port
 * contract; the worker's relay and the service are not on this path, and
 * `source-navigation.spec.ts` exercises them with a panel the real pipeline
 * generated.
 *
 * ## Why the shared `openPanelPage` fixture is not used
 *
 * `openPanelPage` inspects `appPage`, which starts the fixture app through the
 * local service and reads the editor credential — none of which this spec
 * reads — and it lets the panel's real port reach the real worker, which would
 * answer `session.snapshot` from the service and bind a real tab. This spec
 * needs neither: it opens the panel document directly in the shared extension
 * context (`extensionContext`, `extensionId`) with a DevTools stub equivalent
 * to the fixture's — `inspectedWindow.tabId`, a refusing callback-form
 * `inspectedWindow.eval`, and `panels.themeName` — plus
 * `panels.setThemeChangeHandler`, through which a test switches the DevTools
 * theme after mount, and the fake port above.
 *
 * ## Shared-state discipline
 *
 * The `browser` project runs `workers: 1`, `fullyParallel: false`. Every page
 * opened here is closed by the {@link test} fixture below, which also attaches
 * the page's console output and the fake worker's traffic when a test fails.
 * Init scripts are per page, so the fake channel never reaches another spec's
 * page; the real worker never sees this spec's panel port, so no session is
 * created and the extension's pairing and tab bindings are left untouched.
 *
 * ## Privacy and vocabulary
 *
 * Every value rendered comes from `panel-spec.fixture.ts`, which models
 * already-redacted telemetry of `tests/fixtures/sample-next-app`, in that
 * app's own vocabulary and nothing of any other application: parameterized
 * SQL, no header values, no bodies, no credentials (the product's redaction
 * rules are in docs/SECURITY.md, section 3 "Redaction").
 */

import { isDeepStrictEqual } from 'node:util';

import type { BrowserContext, Locator, Page } from '@playwright/test';

import {
  EXTENSION_CHANNEL,
  PANEL_CONNECTION_LABELS,
  PORT_PANEL,
  PORT_PROTOCOL_VERSION,
  classifyPanelPortFrame,
  isPortPush,
  isPortRequest,
} from '@debuggen/chrome-extension/messages';
import type {
  PanelSessionSnapshot,
  PortFailureResponse,
  PortPush,
  PortRequest,
  PortRequestKind,
  PortResponse,
  PortResponsePayloads,
  PortSuccessResponse,
} from '@debuggen/chrome-extension/messages';
import {
  PANEL_NODE_CATALOG,
  isKnownPanelNodeType,
  validatePanelSpec,
  walkPanelNodes,
} from '@debuggen/panel-schema';
import type {
  DataQuery,
  PanelNode,
  PanelNodePath,
  PanelNodeType,
  PanelSpec,
} from '@debuggen/panel-schema';
import { createEnvelope, parseMessage, parsePanelGeneratedPayload } from '@debuggen/protocol';
import type { DataResult } from '@debuggen/protocol';
import type { DebuggenErrorCode, SourceLocation } from '@debuggen/shared';

import { expect, test as extensionTest } from './fixtures';
import {
  CATALOG_NODE_TYPES,
  EMPTY_DATA_SOURCES,
  FIXTURE_EVENT_IDS,
  FIXTURE_PANEL_HEADLINE,
  FIXTURE_PANEL_TITLE,
  FIXTURE_SESSION_ID,
  FIXTURE_SOURCE_LINK_LOCATION,
  buildCatalogPanelSpec,
  buildPanelDataFixtures,
  expectedRenderedNodeTypes,
  fixtureEventFor,
  resolvePanelDataFixture,
} from './panel-spec.fixture';

// ---------------------------------------------------------------------------
// Constants: the DOM and transport contract this spec reads
// ---------------------------------------------------------------------------

/**
 * The panel document as the extension build emits it. `vite.config.ts` lists
 * `src/panel/panel.html` (`PANEL_HTML`) as an explicit Rollup input because the
 * manifest never references it — `chrome.devtools.panels.create` opens it at run
 * time — so it lands at `dist/src/panel/panel.html`, reachable as
 * `chrome-extension://<id>/src/panel/panel.html`.
 */
const PANEL_DOCUMENT_PATH = '/src/panel/panel.html';

/** The tab the stubbed `chrome.devtools.inspectedWindow` reports and the fake binding names. */
const INSPECTED_TAB_ID = 4_101;

/** The page-global name of the Node callback every panel → worker frame is handed to. */
const WORKER_BINDING_NAME = '__debuggenPanelRenderWorker';

/** The page-global name of the fake port's control surface (pushes and counters). */
const WORKER_CONTROL_NAME = '__debuggenPanelRenderControl';

/**
 * The page-global name of the stubbed DevTools theme-change channel: the test
 * delivers a theme switch through the callback the panel registered with
 * `chrome.devtools.panels.setThemeChangeHandler`.
 */
const DEVTOOLS_THEME_HOOK_NAME = '__debuggenPanelRenderDevtoolsTheme';

/** What the stubbed `inspectedWindow.eval` reports: no page is inspected here. */
const DEVTOOLS_EVAL_REFUSAL =
  'panel-render.spec.ts inspects no page, so chrome.devtools.inspectedWindow.eval is refused.';

/** `App.tsx`: the `EventDetails` drawer is an `aside` with this accessible name. */
const EVENT_DRAWER_NAME = 'Selected event';

/** `EventDetails.tsx`: the drawer's heading. */
const EVENT_DRAWER_HEADING = 'Event details';

/** `EventDetails.tsx`: the drawer's close control. */
const EVENT_DRAWER_CLOSE = 'Close event details';

/** `NodeRenderer.tsx`: the title of the failure a registry miss renders. */
const RENDER_FAILURE_TITLE = 'Could not render this part of the panel';

/** `ErrorState.tsx`: the default title of a data view whose query failed. */
const LOAD_FAILURE_TITLE = 'Could not load this view';

/** `App.tsx`: the title of the notice a failed panel → worker request raises. */
const REQUEST_FAILURE_TITLE = 'A Debug Generator request did not complete';

/** `PanelHost.tsx`: the banner over a `meta.fallback` panel, matched on its key phrase. */
const FALLBACK_BANNER_PATTERN = /fallback view/i;

/** `SummaryHeader.tsx`: the summary's two separately headed halves, facts apart from causes. */
const OBSERVED_HEADING = 'Observed';
const LIKELY_CAUSE_HEADING = 'Likely cause';

/**
 * `PanelHost.tsx`: the outline level of a layout's top-level nodes, directly
 * below the panel title's level 2. An untitled container adds no level, so in a
 * panel whose nodes carry no titles every view's heading sits here.
 */
const LAYOUT_HEADING_LEVEL = 3;

/**
 * A node type name that is deliberately outside the vocabulary, for the
 * invalid-specification test. Checked against the catalog at run time rather
 * than compared with any list of types.
 */
const UNKNOWN_NODE_TYPE = 'uncataloguedView';

/**
 * The panel's mapping of `chrome.devtools.panels.themeName` onto the
 * renderer's token themes (`src/panel/theme.ts` `panelThemeFromDevToolsThemeName`).
 * Dark mode is the product default, so DevTools' `'default'` selects `dark`
 * even though Chrome documents it as its light theme; `'light'` is the one
 * name that selects the light token set.
 */
const TOKEN_THEME_FOR_DEVTOOLS_THEME = Object.freeze({
  default: 'dark',
  dark: 'dark',
  light: 'light',
} as const);

/** A `chrome.devtools.panels.themeName` value. */
type DevtoolsThemeName = keyof typeof TOKEN_THEME_FOR_DEVTOOLS_THEME;

// ---------------------------------------------------------------------------
// Page-side init scripts (serialised into the panel document: self-contained)
// ---------------------------------------------------------------------------

/** Arguments of {@link installDevtoolsStub}; plain data only. */
interface DevtoolsStubArgs {
  readonly panelPath: string;
  readonly inspectedTabId: number;
  readonly themeName: DevtoolsThemeName;
  readonly evalRefusal: string;
  readonly themeHookName: string;
}

/** What {@link installDevtoolsStub} exposes to the test on `window[themeHookName]`. */
interface DevtoolsThemeHook {
  /** Whether the panel currently holds a registered theme-change callback. */
  registered(): boolean;
  /** Call the registered callback with `themeName`, as DevTools does on a switch. */
  emit(themeName: string): void;
}

/**
 * Supplies exactly the `chrome.devtools` members the panel reads —
 * `inspectedWindow.tabId`, callback-form `inspectedWindow.eval` (refused),
 * `panels.themeName` and `panels.setThemeChangeHandler` — on the top-level
 * panel document only, mirroring `tests/browser/fixtures.ts`'s emulation
 * without announcing a tab to the real worker. A panel change that needs
 * another DevTools API fails visibly here.
 *
 * `setThemeChangeHandler` keeps the one callback the panel registers (a call
 * without a function unsets it, as in DevTools), and {@link DevtoolsThemeHook}
 * on `window[themeHookName]` lets the test switch the DevTools theme after the
 * panel mounted. `themeName` itself stays the value the page opened with, as a
 * host that never refreshes it would.
 */
function installDevtoolsStub(args: DevtoolsStubArgs): void {
  if (window.top !== window || window.location.pathname !== args.panelPath) {
    return;
  }
  const chromeApi = (globalThis as unknown as { chrome?: object }).chrome;
  if (chromeApi === undefined) {
    return;
  }
  const isCallback = (value: unknown): value is (result: unknown, info: unknown) => void =>
    typeof value === 'function';
  const isThemeCallback = (value: unknown): value is (themeName: string) => void =>
    typeof value === 'function';
  let themeChangeCallback: ((themeName: string) => void) | undefined;
  const themeHook: DevtoolsThemeHook = Object.freeze({
    registered: () => themeChangeCallback !== undefined,
    emit(themeName: string): void {
      if (themeChangeCallback === undefined) {
        throw new Error('The panel registered no DevTools theme-change handler.');
      }
      themeChangeCallback(themeName);
    },
  });
  Object.defineProperty(window, args.themeHookName, { value: themeHook, configurable: true });
  const devtools = Object.freeze({
    inspectedWindow: Object.freeze({
      tabId: args.inspectedTabId,
      eval(_expression: string, optionsOrCallback?: unknown, maybeCallback?: unknown): void {
        const callback = isCallback(optionsOrCallback) ? optionsOrCallback : maybeCallback;
        if (isCallback(callback)) {
          setTimeout(() => {
            callback(undefined, {
              isError: true,
              code: 'E_NOTSUPPORTED',
              description: args.evalRefusal,
              details: [],
              isException: false,
              value: args.evalRefusal,
            });
          }, 0);
        }
      },
    }),
    panels: Object.freeze({
      themeName: args.themeName,
      setThemeChangeHandler(callback?: unknown): void {
        themeChangeCallback = isThemeCallback(callback) ? callback : undefined;
      },
    }),
  });
  Object.defineProperty(chromeApi, 'devtools', {
    value: devtools,
    configurable: true,
    enumerable: true,
  });
}

/** Arguments of {@link installFakePanelWorker}; plain data only. */
interface FakeWorkerArgs {
  readonly panelPath: string;
  readonly portName: string;
  readonly bindingName: string;
  readonly controlName: string;
}

/** What {@link installFakePanelWorker} exposes to the test on `window[controlName]`. */
interface FakeWorkerControl {
  /** Deliver one worker → panel frame on the fake port, asynchronously. */
  push(frame: unknown): void;
  /** Counters for the transport assertions. */
  stats(): { installed: boolean; connects: number; disconnects: number; bindingMisses: number };
}

/**
 * Replaces `chrome.runtime.connect` for the panel's `PORT_PANEL` port with a
 * port whose other end is the test: every posted frame is handed to the exposed
 * Node callback, whose answer (if any) is delivered back asynchronously, as a
 * real port does. Any other port name still reaches the real worker. Runs
 * before the panel bundle, on the top-level panel document only.
 */
function installFakePanelWorker(args: FakeWorkerArgs): void {
  if (window.top !== window || window.location.pathname !== args.panelPath) {
    return;
  }
  type MessageListener = (message: unknown, port: unknown) => void;
  type DisconnectListener = (port: unknown) => void;
  const stats = { installed: false, connects: 0, disconnects: 0, bindingMisses: 0 };
  const control = {
    push(frame: unknown): void {
      deliver(frame);
    },
    stats: () => ({ ...stats }),
  };
  Object.defineProperty(window, args.controlName, { value: control, configurable: true });

  const runtime = (
    globalThis as unknown as {
      chrome?: { runtime?: { connect?: (...params: unknown[]) => unknown } };
    }
  ).chrome?.runtime;
  const realConnect = runtime?.connect;
  if (runtime === undefined || typeof realConnect !== 'function') {
    return;
  }

  const messageListeners = new Set<MessageListener>();
  const disconnectListeners = new Set<DisconnectListener>();
  let port: object | undefined;

  function deliver(frame: unknown): void {
    setTimeout(() => {
      if (port === undefined) {
        return;
      }
      for (const listener of [...messageListeners]) {
        listener(structuredClone(frame), port);
      }
    }, 0);
  }

  function forward(frame: unknown): void {
    const binding = (window as unknown as Record<string, unknown>)[args.bindingName];
    if (typeof binding !== 'function') {
      stats.bindingMisses += 1;
      return;
    }
    void (binding as (value: unknown) => Promise<unknown>)(frame).then((answer) => {
      if (answer !== null && answer !== undefined) {
        deliver(answer);
      }
    });
  }

  const namesPanelPort = (value: unknown): boolean =>
    typeof value === 'object' &&
    value !== null &&
    (value as { name?: unknown }).name === args.portName;

  Object.defineProperty(runtime, 'connect', {
    configurable: true,
    writable: true,
    value: function connect(...params: unknown[]): unknown {
      if (!params.some(namesPanelPort)) {
        return realConnect.apply(runtime, params);
      }
      stats.connects += 1;
      const opened = {
        name: args.portName,
        postMessage(message: unknown): void {
          forward(structuredClone(message));
        },
        disconnect(): void {
          stats.disconnects += 1;
          port = undefined;
        },
        onMessage: {
          addListener: (listener: MessageListener) => {
            messageListeners.add(listener);
          },
          removeListener: (listener: MessageListener) => {
            messageListeners.delete(listener);
          },
          hasListener: (listener: MessageListener) => messageListeners.has(listener),
        },
        onDisconnect: {
          addListener: (listener: DisconnectListener) => {
            disconnectListeners.add(listener);
          },
          removeListener: (listener: DisconnectListener) => {
            disconnectListeners.delete(listener);
          },
          hasListener: (listener: DisconnectListener) => disconnectListeners.has(listener),
        },
      };
      port = opened;
      return opened;
    },
  });
  stats.installed = true;
}

// ---------------------------------------------------------------------------
// The fake worker: the Node end of the PORT_PANEL port
// ---------------------------------------------------------------------------

/** The binding the fake worker reports for the inspected tab. */
interface FakeBinding {
  readonly sessionId: string;
  readonly tabId: number;
  readonly url: string;
}

/** One `panelData.query` the fake worker answered, with exactly what it answered. */
interface AnsweredQuery {
  readonly query: DataQuery;
  /** The rendered panel the query was sent for, as the request named it. */
  readonly panelId: string | undefined;
  readonly result: DataResult;
}

/** A panel → worker request of one kind. */
type RequestOf<K extends PortRequestKind> = Extract<PortRequest, { readonly kind: K }>;

/** A successful answer, framed exactly as `PortRpcContract` types it. */
function success<K extends PortRequestKind>(
  requestId: string,
  kind: K,
  payload: PortResponsePayloads[K],
): PortSuccessResponse<K> {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'response',
    requestId,
    kind,
    ok: true,
    payload,
  };
}

/** A failed answer carrying the protocol's closed error vocabulary. */
function failure<K extends PortRequestKind>(
  requestId: string,
  kind: K,
  code: DebuggenErrorCode,
  message: string,
): PortFailureResponse<K> {
  return {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'response',
    requestId,
    kind,
    ok: false,
    error: { code, message },
  };
}

/** A short, value-free description of an unexpected value, for failure messages. */
function describeValue(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return typeof value;
  }
  return `object with keys [${Object.keys(value).join(', ')}]`;
}

/** `error.message` for an `Error`, else a type description. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : describeValue(error);
}

/**
 * The test's end of the panel's port. It plays the service worker's part of
 * the `PortRpcContract` for the four request kinds a rendered panel issues on
 * its own — `session.snapshot`, `panelData.query`, `source.open` — and records
 * every other kind, and every frame that fails `isPortRequest`, as a contract
 * violation the tests assert is absent.
 */
class FakePanelWorker {
  /** Every well-formed request the panel posted, in order. */
  readonly requests: PortRequest[] = [];
  /** Every data query answered, with its result. */
  readonly answeredQueries: AnsweredQuery[] = [];
  /** Frames and requests that broke the contract; asserted empty. */
  readonly violations: string[] = [];

  private panel: PanelSpec | undefined;
  private heldQueries: (() => void)[] | undefined;

  /**
   * @param binding The binding every snapshot reports.
   * @param holdDataQueries Hold every `panelData.query` answer until
   *   {@link releaseDataQueries}, so the loading state can be observed.
   */
  constructor(
    private readonly binding: FakeBinding,
    holdDataQueries: boolean,
  ) {
    this.heldQueries = holdDataQueries ? [] : undefined;
  }

  /**
   * Remember the panel the service would now hold for the session, so a later
   * `session.snapshot` reports it — as the real worker's snapshot does.
   */
  rememberPanel(spec: PanelSpec): void {
    this.panel = spec;
  }

  /** Answer every held data query, and stop holding new ones. */
  releaseDataQueries(): void {
    const waiting = this.heldQueries ?? [];
    this.heldQueries = undefined;
    for (const release of waiting) {
      release();
    }
  }

  /** The requests of one kind, in order. */
  requestsOf<K extends PortRequestKind>(kind: K): RequestOf<K>[] {
    return this.requests.filter((request): request is RequestOf<K> => request.kind === kind);
  }

  /** The first answered query that targets what an authored query asks for. */
  answerFor(authored: DataQuery): AnsweredQuery | undefined {
    return this.answeredQueries.find((answered) => targetsSameData(answered.query, authored));
  }

  /**
   * Handle one panel → worker frame.
   *
   * @returns The response frame, or `null` for a frame that is not a request
   *   (it has no request id to answer to, so it is only recorded).
   */
  async answer(frame: unknown): Promise<PortResponse | null> {
    if (!isPortRequest(frame)) {
      this.violations.push(`posted a frame isPortRequest refuses: ${describeValue(frame)}`);
      return null;
    }
    this.requests.push(frame);

    switch (frame.kind) {
      case 'session.snapshot':
        return success(frame.requestId, frame.kind, this.snapshot());
      case 'panelData.query':
        if (this.heldQueries !== undefined) {
          const held = this.heldQueries;
          await new Promise<void>((resolve) => {
            held.push(resolve);
          });
        }
        return this.answerDataQuery(frame);
      case 'source.open':
        if (frame.payload.sessionId !== this.binding.sessionId) {
          this.violations.push(`source.open named session ${frame.payload.sessionId}`);
          return failure(frame.requestId, frame.kind, 'TAB_NOT_BOUND', 'Not the bound session.');
        }
        return success(frame.requestId, frame.kind, { forwarded: true });
      default:
        this.violations.push(`posted an unexpected ${frame.kind} request`);
        return failure(
          frame.requestId,
          frame.kind,
          'NOT_IMPLEMENTED',
          `panel-render.spec.ts does not answer ${frame.kind}.`,
        );
    }
  }

  /** The snapshot a real worker would build for a bound, connected tab. */
  private snapshot(): PanelSessionSnapshot {
    return {
      connection: { status: 'connected' },
      binding: {
        kind: 'bound',
        sessionId: this.binding.sessionId,
        tabId: this.binding.tabId,
        url: this.binding.url,
      },
      ...(this.panel === undefined ? {} : { panel: this.panel }),
    };
  }

  /**
   * Serve one data query from the synthetic capture.
   *
   * The request names the rendered panel beside its query (`panelId`, as the
   * service worker forwards it to `POST /sessions/:id/panel-data`); like the
   * service's route, the fake lifts the id off and reads the `DataQuery` alone.
   */
  private answerDataQuery(frame: RequestOf<'panelData.query'>): PortResponse {
    const { sessionId, query: request } = frame.payload;
    if (sessionId !== this.binding.sessionId) {
      this.violations.push(`panelData.query named session ${sessionId}`);
      return failure(frame.requestId, frame.kind, 'SESSION_NOT_FOUND', 'Not the bound session.');
    }
    const { panelId, ...query } = request;
    try {
      const result = resolvePanelDataFixture(query);
      this.answeredQueries.push({ query, panelId, result });
      return success(frame.requestId, frame.kind, result);
    } catch (error) {
      this.violations.push(`the fixture refused a ${query.source} query: ${describeError(error)}`);
      return failure(frame.requestId, frame.kind, 'PROTOCOL_INVALID_MESSAGE', describeError(error));
    }
  }
}

/**
 * Whether a query the panel sent asks for the data an authored node query
 * names: the same source and filter, and the authored sort and limit when the
 * node carries them. Paging fields the `DataProvider` fills in are ignored.
 */
function targetsSameData(sent: DataQuery, authored: DataQuery): boolean {
  return (
    sent.source === authored.source &&
    isDeepStrictEqual(sent.filter, authored.filter) &&
    (authored.sort === undefined || sent.sort === authored.sort) &&
    (authored.limit === undefined || sent.limit === authored.limit)
  );
}

// ---------------------------------------------------------------------------
// Frames the fake worker pushes
// ---------------------------------------------------------------------------

/**
 * The `panel.generated` push for a validated spec, built as the service builds
 * it — the payload parsed by the protocol's own schema, then enveloped — and
 * checked against both contracts.
 */
function panelGeneratedPush(spec: PanelSpec): PortPush {
  const payload = parsePanelGeneratedPayload({
    sessionId: spec.sessionId,
    panelId: spec.id,
    panel: spec,
  });
  if (!payload.ok) {
    throw new Error(`The protocol refuses the fixture panel: ${payload.error.message}`);
  }
  const message = createEnvelope('panel.generated', payload.value);
  const parsed = parseMessage(message);
  expect(parsed.ok, 'the protocol accepts the panel.generated envelope').toBe(true);
  const push: PortPush = {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'push',
    kind: 'protocol',
    message,
  };
  expect(isPortPush(push), 'the extension accepts the panel.generated push').toBe(true);
  return push;
}

/**
 * A `panel.generated` push carrying a document that bypassed
 * `validatePanelSpec`. The protocol refuses it (asserted), and so does the
 * panel's port admission (asserted): `classifyPanelPortFrame` parses every
 * relayed envelope with the protocol's own union, so this frame is classified
 * `malformed-push` and never reaches the store or the renderer (CWE-20).
 */
function unvalidatedPanelGeneratedPush(
  sessionId: string,
  panelId: string,
  panel: unknown,
): Record<string, unknown> {
  expect(
    parsePanelGeneratedPayload({ sessionId, panelId, panel }).ok,
    'the protocol refuses the unvalidated panel',
  ).toBe(false);
  // The envelope fields (id, ts, type, sessionId) come from the protocol's own
  // `createEnvelope`; only the payload is swapped for the unvalidated one.
  const valid = panelGeneratedPush(buildCatalogPanelSpec({ sessionId, id: panelId }));
  if (valid.kind !== 'protocol') {
    throw new Error('panelGeneratedPush built a non-protocol push.');
  }
  const envelope = { ...valid.message, payload: { sessionId, panelId, panel } };
  expect(parseMessage(envelope).ok, 'the protocol refuses the unvalidated envelope').toBe(false);
  const push = {
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'push',
    kind: 'protocol',
    message: envelope,
  };
  expect(isPortPush(push), 'the port admission refuses it').toBe(false);
  expect(classifyPanelPortFrame(push), 'the panel classifies it as a malformed push').toEqual({
    kind: 'malformed-push',
    pushKind: 'protocol',
  });
  return push;
}

// ---------------------------------------------------------------------------
// The rendered panel under test
// ---------------------------------------------------------------------------

/** How {@link RenderedPanelFactory} opens a panel page. */
interface RenderedPanelOptions {
  /** `chrome.devtools.panels.themeName`. Defaults to `'dark'`. */
  readonly themeName?: DevtoolsThemeName | undefined;
  /** Hold data-query answers until released, to observe the loading state. */
  readonly holdDataQueries?: boolean | undefined;
}

/** One opened panel document and the fake worker behind its port. */
interface RenderedPanel {
  readonly page: Page;
  /** The panel's `main` landmark, which holds the rendered specification. */
  readonly main: Locator;
  readonly worker: FakePanelWorker;
  /** Every console line and uncaught error, for the failure attachment. */
  readonly consoleLog: readonly string[];
  /** Console errors and uncaught exceptions only; asserted empty. */
  readonly errors: readonly string[];
  /** Wait for the pill to read Connected, which means the snapshot was applied. */
  waitForConnected(): Promise<void>;
  /** Push a validated spec as `panel.generated` and wait for its title. */
  deliver(spec: PanelSpec): Promise<void>;
  /** Push an already-framed push frame as is. */
  pushFrame(frame: unknown): Promise<void>;
  /** The fake port's counters. */
  transportStats(): Promise<ReturnType<FakeWorkerControl['stats']>>;
  /**
   * Switch the DevTools theme after mount: wait for the panel's theme-change
   * callback to be registered, then deliver `themeName` through it.
   */
  switchDevtoolsTheme(themeName: DevtoolsThemeName): Promise<void>;
  /** The wrapper the renderer draws around the node at a document path. */
  frameOf(pathKey: string): Locator;
}

/** The test-scoped factory. */
type RenderedPanelFactory = (options?: RenderedPanelOptions) => Promise<RenderedPanel>;

/** Open the panel document with the DevTools stub and the fake worker installed. */
async function openRenderedPanel(
  context: BrowserContext,
  extensionId: string,
  bindingUrl: string,
  options: RenderedPanelOptions,
): Promise<RenderedPanel> {
  const worker = new FakePanelWorker(
    { sessionId: FIXTURE_SESSION_ID, tabId: INSPECTED_TAB_ID, url: bindingUrl },
    options.holdDataQueries === true,
  );
  const page = await context.newPage();
  const consoleLog: string[] = [];
  const errors: string[] = [];
  page.on('console', (message) => {
    const line = `console.${message.type()}: ${message.text()}`;
    consoleLog.push(line);
    if (message.type() === 'error') {
      errors.push(line);
    }
  });
  page.on('pageerror', (error) => {
    const line = `uncaught ${error.name}: ${error.message}`;
    consoleLog.push(line);
    errors.push(line);
  });

  try {
    await page.exposeFunction(WORKER_BINDING_NAME, (frame: unknown) => worker.answer(frame));
    await page.addInitScript(installDevtoolsStub, {
      panelPath: PANEL_DOCUMENT_PATH,
      inspectedTabId: INSPECTED_TAB_ID,
      themeName: options.themeName ?? 'dark',
      evalRefusal: DEVTOOLS_EVAL_REFUSAL,
      themeHookName: DEVTOOLS_THEME_HOOK_NAME,
    } satisfies DevtoolsStubArgs);
    await page.addInitScript(installFakePanelWorker, {
      panelPath: PANEL_DOCUMENT_PATH,
      portName: PORT_PANEL,
      bindingName: WORKER_BINDING_NAME,
      controlName: WORKER_CONTROL_NAME,
    } satisfies FakeWorkerArgs);
    await page.goto(`chrome-extension://${extensionId}${PANEL_DOCUMENT_PATH}`);
  } catch (error) {
    await page.close().catch(() => undefined);
    throw error;
  }

  const main = page.getByRole('main');
  const pushFrame = async (frame: unknown): Promise<void> => {
    await page.evaluate(
      ({ controlName, value }) => {
        const control = (window as unknown as Record<string, FakeWorkerControl | undefined>)[
          controlName
        ];
        if (control === undefined) {
          throw new Error('The fake PORT_PANEL port is not installed in this document.');
        }
        control.push(value);
      },
      { controlName: WORKER_CONTROL_NAME, value: frame },
    );
  };

  return {
    page,
    main,
    worker,
    consoleLog,
    errors,
    async waitForConnected() {
      await expect(
        page
          .getByRole('banner')
          .getByRole('status', { name: PANEL_CONNECTION_LABELS.connected, exact: true }),
      ).toBeVisible();
      expect(worker.requestsOf('session.snapshot').length).toBeGreaterThanOrEqual(1);
    },
    async deliver(spec) {
      worker.rememberPanel(spec);
      await pushFrame(panelGeneratedPush(spec));
      await expect(
        main.getByRole('heading', { level: 2, name: spec.title, exact: true }),
      ).toBeVisible();
    },
    pushFrame,
    transportStats: () =>
      page.evaluate((controlName) => {
        const control = (window as unknown as Record<string, FakeWorkerControl | undefined>)[
          controlName
        ];
        if (control === undefined) {
          throw new Error('The fake PORT_PANEL port is not installed in this document.');
        }
        return control.stats();
      }, WORKER_CONTROL_NAME),
    async switchDevtoolsTheme(themeName) {
      await expect
        .poll(
          () =>
            page.evaluate((hookName) => {
              const hook = (window as unknown as Record<string, DevtoolsThemeHook | undefined>)[
                hookName
              ];
              if (hook === undefined) {
                throw new Error('The chrome.devtools stub is not installed in this document.');
              }
              return hook.registered();
            }, DEVTOOLS_THEME_HOOK_NAME),
          { message: 'the panel registers a DevTools theme-change handler' },
        )
        .toBe(true);
      await page.evaluate(
        ({ hookName, name }) => {
          const hook = (window as unknown as Record<string, DevtoolsThemeHook | undefined>)[
            hookName
          ];
          if (hook === undefined) {
            throw new Error('The chrome.devtools stub is not installed in this document.');
          }
          hook.emit(name);
        },
        { hookName: DEVTOOLS_THEME_HOOK_NAME, name: themeName },
      );
    },
    frameOf: (pathKey) => main.locator(`[data-node-path="${pathKey}"]`),
  };
}

/**
 * The spec's own fixture: `openRenderedPanel` opens panel pages in the shared
 * extension context and closes every one on teardown, attaching the console
 * output and the port traffic of each when the test did not pass.
 */
const test = extensionTest.extend<{ openRenderedPanel: RenderedPanelFactory }>({
  openRenderedPanel: async ({ extensionContext, extensionId, fixtureAppUrl }, use, testInfo) => {
    const opened: RenderedPanel[] = [];
    const bindingUrl = new URL('/', fixtureAppUrl).toString();
    await use(async (options = {}) => {
      const panel = await openRenderedPanel(extensionContext, extensionId, bindingUrl, options);
      opened.push(panel);
      return panel;
    });
    for (const [index, panel] of opened.entries()) {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach(`panel-${String(index + 1)}-console.txt`, {
          body: panel.consoleLog.length === 0 ? '(no console output)' : panel.consoleLog.join('\n'),
          contentType: 'text/plain',
        });
        await testInfo.attach(`panel-${String(index + 1)}-port-traffic.json`, {
          body: JSON.stringify(
            {
              requests: panel.worker.requests.map((request) => request.kind),
              violations: panel.worker.violations,
            },
            null,
            2,
          ),
          contentType: 'application/json',
        });
      }
      await panel.page.close().catch(() => undefined);
    }
  },
});

// ---------------------------------------------------------------------------
// The specification side: nodes by document path
// ---------------------------------------------------------------------------

/** One node of a specification, where it sits and how it is named. */
interface PlacedNode {
  readonly node: PanelNode;
  readonly path: PanelNodePath;
  /** The path as the renderer writes it on the node's wrapper (`data-node-path`). */
  readonly pathKey: string;
  /** The node's title, which is its region's accessible name. */
  readonly title: string;
}

/** A node that reads captured data, with the query it was authored with. */
interface QueriedNode extends PlacedNode {
  readonly query: DataQuery;
}

/** Every node of a layout in document order, walked with the schema's own walker. */
function placedNodes(spec: PanelSpec): PlacedNode[] {
  const placed: PlacedNode[] = [];
  walkPanelNodes(spec.layout, (node, path) => {
    const title = node.title;
    if (title === undefined || title.trim() === '') {
      throw new Error(`Node ${path.join('.')} has no title, so it cannot be found by name.`);
    }
    placed.push({ node, path, pathKey: path.join('.'), title });
  });
  return placed;
}

/** The node's data query, when it reads captured data. */
function queryOf(node: PanelNode): DataQuery | undefined {
  return 'query' in node ? node.query : undefined;
}

/** The node's direct source location, when it is a location leaf. */
function locationOf(node: PanelNode): SourceLocation | undefined {
  return 'location' in node ? node.location : undefined;
}

/** The nodes that read captured data. */
function queriedNodes(placed: readonly PlacedNode[]): QueriedNode[] {
  return placed.flatMap((entry) => {
    const query = queryOf(entry.node);
    return query === undefined ? [] : [{ ...entry, query }];
  });
}

/** How many nodes a tree of `children` arrays holds. */
function countTree(nodes: readonly { readonly children: readonly unknown[] }[]): number {
  let total = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) {
      break;
    }
    total += 1;
    for (const child of next.children) {
      stack.push(child as { readonly children: readonly unknown[] });
    }
  }
  return total;
}

/** How many items a data result carries: the size of what its node must draw. */
function resultSize(result: DataResult): number {
  switch (result.source) {
    case 'trace':
      return result.trace?.nodeCount ?? 0;
    case 'componentTree':
      return result.componentTree === null ? 0 : countTree(result.componentTree.roots);
    case 'graph':
      return result.graph.nodes.length;
    case 'spans':
      return result.spans.length;
    case 'events':
      return result.events.length;
    case 'renders':
      return result.renders.length;
    case 'requests':
      return result.requests.length;
    case 'queries':
      return result.queries.length;
    case 'stateTransitions':
      return result.stateTransitions.length;
    case 'metrics':
      return result.metrics.length;
  }
}

/**
 * A copy of a validated spec with every node's title removed: the shape a
 * generated panel arrives in when its author titled nothing. Titles are
 * optional, so the copy is still a valid panel.
 */
function withoutTitles(spec: PanelSpec): PanelSpec {
  const copy = structuredClone(spec);
  walkPanelNodes(copy.layout, (node) => {
    Reflect.deleteProperty(node, 'title');
  });
  return copy;
}

/**
 * A copy of a validated spec with one node's type replaced — deliberately
 * outside `validatePanelSpec`, for the invalid-specification test.
 */
function withNodeType(spec: PanelSpec, path: PanelNodePath, type: string): unknown {
  const copy: unknown = structuredClone(spec);
  let cursor: unknown = copy;
  for (const segment of path) {
    if (typeof cursor !== 'object' || cursor === null) {
      throw new Error(`The path ${path.join('.')} does not resolve in the spec.`);
    }
    cursor = (cursor as Record<string, unknown>)[String(segment)];
  }
  if (typeof cursor !== 'object' || cursor === null) {
    throw new Error(`The path ${path.join('.')} does not name a node.`);
  }
  (cursor as Record<string, unknown>)['type'] = type;
  return copy;
}

/** Escape a literal for a `RegExp`. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The accessible name a metric tile is expected to carry, as an anchored
 * pattern: the tile's heading, then — for a tier duration only — the
 * parenthesised line under the heading that says it is wall-clock time
 * (`Database duration (wall clock: overlapping statements counted once)`),
 * then `: ` and the figure the caller matches with `figure` (a regular
 * expression source). The qualifier's wording is the renderer's own and is
 * pinned by its unit tests; here it is required to be present on exactly the
 * durations and absent on every other metric, so a count tile's name stays
 * `Requests: 2`.
 */
function metricTileName(metric: { id: string; label: string }, figure: string): RegExp {
  const qualifier = metric.id.endsWith('_duration') ? ' \\([^()]+\\)' : '';
  return new RegExp(`^${escapeRegExp(metric.label)}${qualifier}: ${figure}`);
}

// ---------------------------------------------------------------------------
// The DOM side: what a node drew
// ---------------------------------------------------------------------------

/** A grid's data rows: every row with at least one data cell (header rows have none). */
function dataRows(grid: Locator): Locator {
  return grid.getByRole('row').filter({ has: grid.page().getByRole('gridcell') });
}

/** The largest number of data rows or tree items any grid or tree in a node drew. */
async function drawnItemCount(frame: Locator): Promise<number> {
  let largest = 0;
  for (const grid of await frame.getByRole('grid').all()) {
    largest = Math.max(largest, await dataRows(grid).count());
  }
  for (const tree of await frame.getByRole('tree').all()) {
    largest = Math.max(largest, await tree.getByRole('treeitem').count());
  }
  return largest;
}

/** Expand every collapsed nesting in a node, so every item it holds is drawn. */
async function expandAll(frame: Locator): Promise<void> {
  const expanders = frame.getByRole('button', { name: /^Expand\b/ });
  for (let round = 0; round < 100; round += 1) {
    if ((await expanders.count()) === 0) {
      return;
    }
    await expanders.first().click();
  }
  throw new Error('A node kept offering nested items to expand after 100 expansions.');
}

/** The cell of a data row under the column with a given header. */
async function cellInColumn(grid: Locator, row: Locator, header: string): Promise<Locator> {
  const headers = (await grid.getByRole('columnheader').allInnerTexts()).map((text) => text.trim());
  const index = headers.indexOf(header);
  expect(
    index,
    `the grid has a "${header}" column (it has: ${headers.join(', ')})`,
  ).toBeGreaterThanOrEqual(0);
  return row.locator(':scope > *').nth(index);
}

/**
 * A node whose source resolved to nothing must say so in its own words: an
 * `EmptyState` (`role="status"`) whose message names what is missing — the
 * node's catalog label — and no data view (docs/ARCHITECTURE.md, section 10.4
 * "The renderer contract": a missing signal renders a node-specific empty
 * state, never a blank area).
 */
async function expectEmptyState(frame: Locator, entry: QueriedNode): Promise<void> {
  const label = PANEL_NODE_CATALOG[entry.node.type].label;
  await expect(
    frame.getByRole('status').filter({ hasText: new RegExp(escapeRegExp(label), 'i') }),
    `node "${entry.title}" shows an EmptyState naming ${label}`,
  ).toBeVisible();
  await expect(frame.getByRole('grid')).toHaveCount(0);
  await expect(frame.getByRole('tree')).toHaveCount(0);
}

/**
 * A node whose source resolved to data must draw that data: the checks below
 * are keyed by the protocol's closed `DataResult` vocabulary and compare what is
 * on screen with exactly what the fake worker answered.
 */
async function expectResultDrawn(
  frame: Locator,
  entry: QueriedNode,
  answered: AnsweredQuery,
): Promise<void> {
  const what = `node "${entry.title}" (${answered.result.source})`;
  await expect(
    frame.getByRole('status').filter({ hasText: /\S/ }),
    `${what} is not empty`,
  ).toHaveCount(0);
  const result = answered.result;

  switch (result.source) {
    case 'trace': {
      const spans = result.trace?.nodeCount ?? 0;
      // A trace is drawn as a figure (the timeline's or the flame chart's
      // canvas) whose bars and frames are named images.
      await expect(frame.getByRole('figure').first(), `${what} draws a chart`).toBeVisible();
      await expect.poll(() => drawnItemCount(frame), `${what} draws every span`).toBe(spans);
      return;
    }
    case 'spans': {
      const spans = result.spans;
      if (entry.query.limit !== undefined || entry.query.sort !== undefined) {
        // A ranked, paged view: the page the worker returned, in its order.
        expect(answered.query.limit, `${what} asked for its limit`).toBe(entry.query.limit);
        expect(answered.query.sort, `${what} asked for its sort`).toBe(entry.query.sort);
        expect(spans.length).toBe(Math.min(entry.query.limit ?? spans.length, result.total));
        if (entry.query.sort === 'duration_desc') {
          for (let index = 1; index < spans.length; index += 1) {
            expect(spans[index]!.duration).toBeLessThanOrEqual(spans[index - 1]!.duration);
          }
        }
        const rows = dataRows(frame.getByRole('grid').first());
        await expect(rows, `${what} shows the limited page`).toHaveCount(spans.length);
        for (const [index, span] of spans.entries()) {
          await expect(rows.nth(index), `${what} row ${String(index + 1)}`).toContainText(
            span.name,
          );
        }
        if (result.nextOffset !== null) {
          await expect(frame, `${what} reports the full count`).toContainText(String(result.total));
          await expect(frame.getByRole('button', { name: /load more/i })).toBeVisible();
        }
        return;
      }
      await expandAll(frame);
      await expect.poll(() => drawnItemCount(frame), `${what} draws every span`).toBe(spans.length);
      return;
    }
    case 'events':
      await expect
        .poll(() => drawnItemCount(frame), `${what} lists every event`)
        .toBe(result.events.length);
      return;
    case 'renders': {
      const grid = frame.getByRole('grid').first();
      await expect(dataRows(grid), `${what} has a row per component`).toHaveCount(
        result.renders.length,
      );
      for (const stat of result.renders) {
        await expect(grid).toContainText(stat.component);
      }
      return;
    }
    case 'componentTree': {
      const nodes = result.componentTree === null ? 0 : countTree(result.componentTree.roots);
      await expect(frame.getByRole('tree').first().getByRole('treeitem')).toHaveCount(nodes);
      return;
    }
    case 'requests': {
      const grid = frame.getByRole('grid').first();
      const rows = dataRows(grid);
      await expect(rows, `${what} has a row per request group`).toHaveCount(result.requests.length);
      const duplicated = result.requests.filter((group) => group.duplicateCount >= 2);
      expect(duplicated.length, 'the capture holds a duplicated request group').toBeGreaterThan(0);
      for (const group of duplicated) {
        const row = rows.filter({ hasText: group.path });
        await expect(row).toHaveCount(1);
        // One cell carries both figures: the occurrence count, then — for a group
        // with redundant occurrences — the duplicate badge beside it, which names
        // itself as the redundant count.
        const occurrences = await cellInColumn(grid, row, 'Occurrences');
        await expect(
          occurrences.locator('.dg-stack__items > .dg-text').first(),
          `${what} counts every occurrence`,
        ).toHaveText(String(group.count));
        await expect(
          occurrences.locator('.dg-request-table__duplicate-badge'),
          `${what} badges the duplicate count`,
        ).toHaveText(new RegExp(`^${String(group.duplicateCount)}(?!\\d)`));
      }
      return;
    }
    case 'queries': {
      const grid = frame.getByRole('grid').first();
      await expect(dataRows(grid), `${what} has a row per statement`).toHaveCount(
        result.queries.length,
      );
      for (const group of result.queries) {
        // Parameterized text only, never inline literals: the statement carries placeholders.
        expect(group.statement).toMatch(/\$\d+/);
        await expect(grid).toContainText(group.statement);
      }
      return;
    }
    case 'stateTransitions':
      await expect(dataRows(frame.getByRole('grid').first())).toHaveCount(
        result.stateTransitions.length,
      );
      return;
    case 'graph':
      await expect(frame.getByRole('img').first(), `${what} draws the graph`).toBeVisible();
      await expect(dataRows(frame.getByRole('grid').first())).toHaveCount(
        result.graph.nodes.length,
      );
      return;
    case 'metrics': {
      const requested = 'metrics' in entry.node ? entry.node.metrics : undefined;
      const shown = result.metrics.filter(
        (metric) => requested === undefined || requested.includes(metric.id),
      );
      const cards = frame.getByRole('list').first().getByRole('listitem');
      await expect(cards, `${what} draws a card per metric`).toHaveCount(shown.length);
      const unavailable = shown.filter((metric) => !metric.available);
      expect(unavailable.length, 'the capture leaves a metric unmeasured').toBeGreaterThan(0);
      for (const metric of shown) {
        if (!metric.available) {
          await expect(
            frame.getByRole('listitem', { name: metricTileName(metric, 'n/a$') }),
          ).toBeVisible();
        } else if (metric.unit === 'count' && metric.value !== undefined) {
          await expect(
            frame.getByRole('listitem', {
              name: metricTileName(metric, `${escapeRegExp(String(metric.value))}$`),
            }),
          ).toBeVisible();
        } else {
          await expect(
            frame.getByRole('listitem', { name: metricTileName(metric, '\\S') }),
          ).toBeVisible();
        }
      }
      return;
    }
  }
}

/**
 * The text of every node wrapper that holds a render-failure notice instead of
 * its view, so a registry miss fails the test naming the node type it hit.
 * Only innermost wrappers are read: a failed node draws no nested nodes.
 */
async function renderFailureTexts(panel: RenderedPanel): Promise<string[]> {
  const texts = await panel.main
    .locator('[data-node-path]')
    .filter({ hasText: RENDER_FAILURE_TITLE, hasNot: panel.page.locator('[data-node-path]') })
    .allInnerTexts();
  return texts.map((text) => text.replace(/\s+/g, ' ').trim());
}

/** Assert that nothing on the page reports a rendering, loading or transport failure. */
async function expectNoFailures(panel: RenderedPanel): Promise<void> {
  expect(await renderFailureTexts(panel), 'no node failed to render').toEqual([]);
  await expect(panel.page.getByRole('alert'), 'no assertive ErrorState').toHaveCount(0);
  await expect(panel.main.getByText(RENDER_FAILURE_TITLE)).toHaveCount(0);
  await expect(panel.main.getByText(LOAD_FAILURE_TITLE)).toHaveCount(0);
  await expect(panel.page.getByText(REQUEST_FAILURE_TITLE)).toHaveCount(0);
  expect(panel.worker.violations, 'the panel kept the PORT_PANEL contract').toEqual([]);
  expect(panel.errors, 'no console error or uncaught exception in the panel page').toEqual([]);
}

/** The list item of the summary claim whose statement is `statement`. */
function claimItem(region: Locator, statement: string): Locator {
  return region
    .getByRole('listitem')
    .filter({ has: region.page().getByText(statement, { exact: true }) });
}

/** The evidence chips of one summary claim, in citation order. */
function evidenceChips(item: Locator): Locator {
  return item.getByRole('list').getByRole('button');
}

/** The accessible name of the button that opens a suggested location. */
function openLocationName(location: SourceLocation): string {
  return `Open ${location.file}:${String(location.line)}:${String(location.column)}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('panel-render: a stored PanelSpec in the built panel document', () => {
  test('the fixture is deterministic, valid and holds each catalogued node type once', () => {
    const spec = buildCatalogPanelSpec();
    expect(buildCatalogPanelSpec(), 'two builds are deeply equal').toEqual(spec);
    expect(buildCatalogPanelSpec({ fallback: true })).toEqual(
      buildCatalogPanelSpec({ fallback: true }),
    );
    expect(buildPanelDataFixtures(), 'two data builds are deeply equal').toEqual(
      buildPanelDataFixtures(),
    );

    const validated = validatePanelSpec(spec);
    expect(validated.ok, 'the stored spec passes the product validator').toBe(true);
    expect(spec.meta?.fallback).not.toBe(true);
    expect(buildCatalogPanelSpec({ fallback: true }).meta?.fallback).toBe(true);
    expect(spec.title).toBe(FIXTURE_PANEL_TITLE);
    expect(spec.summary.headline).toBe(FIXTURE_PANEL_HEADLINE);

    // The expectation is the catalog itself, read at run time.
    const catalogTypes = new Set<string>(Object.keys(PANEL_NODE_CATALOG));
    expect(catalogTypes.size).toBeGreaterThan(0);
    expect(new Set<string>(expectedRenderedNodeTypes())).toEqual(catalogTypes);
    expect(new Set<string>(CATALOG_NODE_TYPES)).toEqual(catalogTypes);

    // One node per type, each titled uniquely, so a title identifies a type on screen.
    const placed = placedNodes(spec);
    const perType = new Map<PanelNodeType, number>();
    for (const entry of placed) {
      perType.set(entry.node.type, (perType.get(entry.node.type) ?? 0) + 1);
    }
    expect(new Set<string>(perType.keys())).toEqual(catalogTypes);
    expect([...perType.values()].every((count) => count === 1)).toBe(true);
    expect(new Set(placed.map((entry) => entry.title)).size).toBe(placed.length);

    // The deliberately empty sources really resolve to nothing, and nothing else does.
    expect(EMPTY_DATA_SOURCES.length).toBeGreaterThan(0);
    for (const entry of queriedNodes(placed)) {
      const size = resultSize(resolvePanelDataFixture(entry.query));
      expect(size === 0, `"${entry.title}" reads ${entry.query.source}`).toBe(
        EMPTY_DATA_SOURCES.includes(entry.query.source),
      );
    }
  });

  test('renders every catalogued node type, each resolving its data', async ({
    openRenderedPanel,
  }) => {
    const spec = buildCatalogPanelSpec();
    const placed = placedNodes(spec);
    const queried = queriedNodes(placed);
    const panel = await openRenderedPanel({ holdDataQueries: true });

    await panel.waitForConnected();
    await panel.deliver(spec);

    // A node type the registry cannot draw fails here, by name, before anything else.
    expect(await renderFailureTexts(panel), 'no node failed to render').toEqual([]);

    // Every data-backed node asked the DataProvider for its own query, and shows
    // its LoadingState while the answer is held.
    const unqueried = (): string[] =>
      queried
        .filter(
          (entry) =>
            !panel.worker
              .requestsOf('panelData.query')
              .some((request) => targetsSameData(request.payload.query, entry.query)),
        )
        .map((entry) => `${entry.title} (${entry.node.type})`);
    await expect.poll(unqueried, 'every data-backed node queried its data').toEqual([]);
    for (const entry of queried) {
      await expect(
        panel.frameOf(entry.pathKey).locator('[aria-busy="true"]').first(),
        `node "${entry.title}" (${entry.node.type}) shows its LoadingState while its data is pending`,
      ).toBeVisible();
    }
    panel.worker.releaseDataQueries();
    await expect(
      panel.main.locator('[aria-busy="true"]'),
      'every LoadingState resolved',
    ).toHaveCount(0);

    // Exactly the catalogued node types are on screen: one wrapper per node of
    // the document, no more and no fewer, each holding the region its title names.
    const frames = panel.main.locator('[data-node-path]');
    await expect(frames).toHaveCount(placed.length);
    const drawnPaths = await frames.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-node-path')),
    );
    expect(new Set(drawnPaths)).toEqual(new Set(placed.map((entry) => entry.pathKey)));
    const renderedTypes = new Set<PanelNodeType>();
    for (const entry of placed) {
      await expect(
        panel
          .frameOf(entry.pathKey)
          .getByRole('region', { name: entry.title, exact: true })
          .first(),
        `node "${entry.title}" (${entry.node.type}) is drawn under its title`,
      ).toBeVisible();
      renderedTypes.add(entry.node.type);
    }
    expect(renderedTypes).toEqual(expectedRenderedNodeTypes());

    // Each data-backed node ends populated or in its EmptyState, never blank.
    for (const entry of queried) {
      const answered = panel.worker.answerFor(entry.query);
      if (answered === undefined) {
        throw new Error(`No answered query targets node "${entry.title}".`);
      }
      expect(answered.panelId, `node "${entry.title}" reads its own panel's capture`).toBe(spec.id);
      const frame = panel.frameOf(entry.pathKey);
      if (resultSize(answered.result) === 0) {
        expect(EMPTY_DATA_SOURCES).toContain(entry.query.source);
        await expectEmptyState(frame, entry);
      } else {
        expect(EMPTY_DATA_SOURCES).not.toContain(entry.query.source);
        await expectResultDrawn(frame, entry, answered);
      }
    }
    for (const source of EMPTY_DATA_SOURCES) {
      expect(queried.some((entry) => entry.query.source === source)).toBe(true);
    }

    // The transport stayed on the fake port, and every query the panel sent
    // was one of its nodes' queries, for the bound session.
    for (const request of panel.worker.requestsOf('panelData.query')) {
      expect(request.payload.sessionId).toBe(spec.sessionId);
      // Bound to the rendered panel, so the service reads the capture it was
      // generated from rather than whichever capture is live.
      expect(request.payload.query.panelId, 'the query names the rendered panel').toBe(spec.id);
      expect(
        queried.some((entry) => targetsSameData(request.payload.query, entry.query)),
        `the ${request.payload.query.source} query belongs to a node`,
      ).toBe(true);
    }
    const stats = await panel.transportStats();
    expect(stats.installed).toBe(true);
    expect(stats.bindingMisses).toBe(0);
    expect(stats.connects - stats.disconnects, 'one live PORT_PANEL port').toBe(1);
    await expect(
      panel.main.getByRole('status').filter({ hasText: FALLBACK_BANNER_PATTERN }),
    ).toHaveCount(0);
    await expectNoFailures(panel);
  });

  test('heads every untitled view with its catalogue label, and no untitled chip or container', async ({
    openRenderedPanel,
  }) => {
    const spec = withoutTitles(buildCatalogPanelSpec());
    expect(validatePanelSpec(spec).ok, 'the untitled copy is still a valid panel').toBe(true);
    const nodes: { readonly node: PanelNode; readonly pathKey: string }[] = [];
    walkPanelNodes(spec.layout, (node, path) => {
      expect(node.title, `node ${path.join('.')} is untitled`).toBeUndefined();
      nodes.push({ node, pathKey: path.join('.') });
    });
    const panel = await openRenderedPanel();
    await panel.waitForConnected();
    await panel.deliver(spec);
    await expect(
      panel.main.locator('[aria-busy="true"]'),
      'every LoadingState resolved',
    ).toHaveCount(0);

    for (const { node, pathKey } of nodes) {
      const entry = PANEL_NODE_CATALOG[node.type];
      const frame = panel.frameOf(pathKey);
      // The headings this node drew itself: those whose nearest node frame is
      // its own, so a container is not credited with its children's.
      const ownHeadings = await frame.evaluate((element) =>
        [...element.querySelectorAll('h1, h2, h3, h4, h5, h6')]
          .filter((heading) => heading.closest('[data-node-path]') === element)
          .map((heading) => ({
            level: Number(heading.tagName.slice(1)),
            text: (heading.textContent ?? '').trim(),
          })),
      );
      if (entry.kind === 'visualization' && entry.requiresQuery) {
        // A view of captured evidence: one heading, reading the catalogue label
        // at the layout's level, naming the region the view is drawn in.
        expect(ownHeadings, `the untitled ${node.type} view is headed by its label`).toEqual([
          { level: LAYOUT_HEADING_LEVEL, text: entry.label },
        ]);
        await expect(
          frame.getByRole('region', { name: entry.label, exact: true }),
          `the untitled ${node.type} view is a region named "${entry.label}"`,
        ).toBeVisible();
        await expect(
          frame.getByRole('heading', {
            level: LAYOUT_HEADING_LEVEL,
            name: entry.label,
            exact: true,
          }),
        ).toBeVisible();
      } else {
        // The source-link chip and the untitled containers name nothing.
        expect(ownHeadings, `the untitled ${node.type} node draws no heading`).toEqual([]);
        if (!entry.supportsChildren) {
          await expect(
            frame.getByRole('region'),
            `the untitled ${node.type} leaf is no region`,
          ).toHaveCount(0);
        }
      }
    }
    await expectNoFailures(panel);
  });

  test('keeps observed facts and likely causes apart, and an evidence chip selects its event', async ({
    openRenderedPanel,
  }) => {
    const spec = buildCatalogPanelSpec();
    const { observed, likelyCauses } = spec.summary;
    expect(observed.length).toBeGreaterThan(0);
    expect(likelyCauses.length).toBeGreaterThan(0);
    const panel = await openRenderedPanel();
    await panel.waitForConnected();
    await panel.deliver(spec);

    const headline = spec.summary.headline ?? '';
    await expect(panel.main.getByText(headline, { exact: true })).toBeVisible();
    const observedRegion = panel.main.getByRole('region', { name: OBSERVED_HEADING, exact: true });
    const causesRegion = panel.main.getByRole('region', {
      name: LIKELY_CAUSE_HEADING,
      exact: true,
    });
    await expect(observedRegion.getByRole('heading', { name: OBSERVED_HEADING })).toBeVisible();
    await expect(causesRegion.getByRole('heading', { name: LIKELY_CAUSE_HEADING })).toBeVisible();
    // The headline is prose, never evidence: it sits in neither half.
    await expect(observedRegion.getByText(headline)).toHaveCount(0);
    await expect(causesRegion.getByText(headline)).toHaveCount(0);

    for (const fact of observed) {
      const item = claimItem(observedRegion, fact.statement);
      await expect(item, `fact "${fact.statement}" is observed`).toHaveCount(1);
      await expect(causesRegion.getByText(fact.statement, { exact: true })).toHaveCount(0);
      const chips = evidenceChips(item);
      await expect(chips, 'one chip per evidence reference').toHaveCount(fact.evidence.length);
      for (const [index, ref] of fact.evidence.entries()) {
        if (ref.label !== undefined) {
          await expect(chips.nth(index)).toHaveAccessibleName(ref.label);
        }
      }
      await expect(item.getByRole('button', { name: /^Open / })).toHaveCount(0);
    }

    for (const cause of likelyCauses) {
      const item = claimItem(causesRegion, cause.statement);
      await expect(item, `cause "${cause.statement}" is a likely cause`).toHaveCount(1);
      await expect(observedRegion.getByText(cause.statement, { exact: true })).toHaveCount(0);
      await expect(item, 'each hypothesis shows its confidence').toContainText(cause.confidence);
      await expect(evidenceChips(item)).toHaveCount(cause.evidence.length);
      const location = cause.suggestedLocation;
      if (location === undefined) {
        await expect(item.getByRole('button', { name: /^Open / })).toHaveCount(0);
      } else {
        await expect(
          item.getByRole('button', { name: openLocationName(location), exact: true }),
        ).toBeVisible();
      }
    }
    expect(likelyCauses.some((cause) => cause.suggestedLocation !== undefined)).toBe(true);

    // Clicking an evidence chip selects the event it cites (PanelActions.onSelectEvent).
    const event = fixtureEventFor('pingFetch');
    expect(event.id).toBe(FIXTURE_EVENT_IDS.pingFetch);
    const fact = observed.find((claim) => claim.evidence.some((ref) => ref.eventId === event.id));
    if (fact === undefined) {
      throw new Error(`No observed fact cites ${event.id}.`);
    }
    const chipIndex = fact.evidence.findIndex((ref) => ref.eventId === event.id);
    const chip = evidenceChips(claimItem(observedRegion, fact.statement)).nth(chipIndex);
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await chip.click();

    const drawer = panel.page.getByRole('complementary', { name: EVENT_DRAWER_NAME, exact: true });
    await expect(drawer.getByRole('heading', { name: EVENT_DRAWER_HEADING })).toBeVisible();
    await expect(drawer).toContainText(event.name);
    for (const badge of [event.tier, event.kind, event.status]) {
      await expect(drawer.getByText(badge, { exact: true }).first()).toBeVisible();
    }
    await expect(drawer).toContainText(event.duration.toFixed(2));
    await expect(drawer.getByText(event.id, { exact: true }).first()).toBeVisible();
    const attributes = drawer.getByRole('grid');
    const keys = Object.keys(event.attributes);
    expect(keys.length).toBeGreaterThan(0);
    await expect(dataRows(attributes.first()), 'one row per attribute').toHaveCount(keys.length);
    for (const key of keys) {
      await expect(attributes.first().getByText(key, { exact: true })).toBeVisible();
    }
    await expect
      .poll(
        () =>
          panel.worker
            .requestsOf('panelData.query')
            .some(
              (request) =>
                request.payload.query.source === 'events' &&
                request.payload.query.filter?.traceId === event.traceId,
            ),
        "the drawer loaded the event's trace",
      )
      .toBe(true);

    // Every chip citing the selected event shows it pressed, and only those.
    const citing = [...observed, ...likelyCauses]
      .flatMap((claim) => claim.evidence)
      .filter((ref) => ref.eventId === event.id).length;
    const pressed = async (): Promise<number> =>
      (await observedRegion.locator('[aria-pressed="true"]').count()) +
      (await causesRegion.locator('[aria-pressed="true"]').count());
    await expect.poll(pressed, 'the chips citing the event are pressed').toBe(citing);

    await drawer.getByRole('button', { name: EVENT_DRAWER_CLOSE }).click();
    await expect(panel.page.getByRole('heading', { name: EVENT_DRAWER_HEADING })).toHaveCount(0);
    await expect.poll(pressed, 'closing the drawer clears the selection').toBe(0);
    await expectNoFailures(panel);
  });

  test('a location leaf renders its source chip, and clicking a chip asks to open that source', async ({
    openRenderedPanel,
  }) => {
    const spec = buildCatalogPanelSpec();
    const leaves = placedNodes(spec).flatMap((entry) => {
      const location = locationOf(entry.node);
      return location === undefined ? [] : [{ entry, location }];
    });
    expect(leaves.length, 'the catalog declares a location leaf').toBeGreaterThan(0);
    const panel = await openRenderedPanel();
    await panel.waitForConnected();
    await panel.deliver(spec);

    for (const { entry, location } of leaves) {
      expect(location).toEqual(FIXTURE_SOURCE_LINK_LOCATION);
      const region = panel
        .frameOf(entry.pathKey)
        .getByRole('region', { name: entry.title, exact: true });
      const target = `${location.file}:${String(location.line)}:${String(location.column)}`;
      const button = region.getByRole('button', {
        name: new RegExp(`${escapeRegExp(target)}$`),
      });
      await expect(button).toHaveCount(1);
      const fileName = location.file.split('/').pop() ?? location.file;
      const chip = button
        .locator('code')
        .filter({ hasText: `${fileName}:${String(location.line)}` });
      await expect(chip, 'a file:line chip').toBeVisible();
      const fontFamily = await chip.evaluate((element) => getComputedStyle(element).fontFamily);
      expect(fontFamily, 'the chip is set in the monospace family').toMatch(/monospace/);
      if (location.symbol !== undefined) {
        await expect(button).toContainText(location.symbol);
      }

      const before = panel.worker.requestsOf('source.open').length;
      await button.click();
      await expect.poll(() => panel.worker.requestsOf('source.open').length).toBe(before + 1);
      const sent = panel.worker.requestsOf('source.open')[before];
      expect(sent?.payload, 'source.open carries the chip location untouched').toEqual({
        sessionId: spec.sessionId,
        location,
      });
      expect(sent?.payload.location.file).toBe(location.file);
      expect(sent?.payload.location.line).toBe(location.line);
      expect(sent?.payload.location.column).toBe(location.column);
    }

    // A hypothesis's suggested location opens through the same action.
    const cause = spec.summary.likelyCauses.find((claim) => claim.suggestedLocation !== undefined);
    const suggested = cause?.suggestedLocation;
    if (cause === undefined || suggested === undefined) {
      throw new Error('No likely cause carries a suggested location.');
    }
    const before = panel.worker.requestsOf('source.open').length;
    await claimItem(
      panel.main.getByRole('region', { name: LIKELY_CAUSE_HEADING, exact: true }),
      cause.statement,
    )
      .getByRole('button', { name: openLocationName(suggested), exact: true })
      .click();
    await expect.poll(() => panel.worker.requestsOf('source.open').length).toBe(before + 1);
    expect(panel.worker.requestsOf('source.open')[before]?.payload).toEqual({
      sessionId: spec.sessionId,
      location: suggested,
    });
    await expectNoFailures(panel);
  });

  test('a fallback panel carries the fallback banner, and a normal panel replaces it without one', async ({
    openRenderedPanel,
  }) => {
    const fallback = buildCatalogPanelSpec({ fallback: true });
    expect(fallback.meta?.fallback).toBe(true);
    const panel = await openRenderedPanel();
    await panel.waitForConnected();
    await panel.deliver(fallback);

    const banner = panel.main.getByRole('status').filter({ hasText: FALLBACK_BANNER_PATTERN });
    await expect(banner, 'the fallback view is announced').toHaveCount(1);
    await expect(banner).toBeVisible();
    await expect(panel.main.locator('[data-node-path]')).toHaveCount(placedNodes(fallback).length);

    const normal = buildCatalogPanelSpec();
    expect(normal.meta?.fallback).not.toBe(true);
    await panel.deliver(normal);
    await expect(banner, 'a validated, non-fallback panel shows no banner').toHaveCount(0);
    await expect(panel.main.locator('[data-node-path]')).toHaveCount(placedNodes(normal).length);
    await expectNoFailures(panel);
  });

  test('follows the DevTools theme onto the token theme', async ({ openRenderedPanel }) => {
    const spec = buildCatalogPanelSpec();
    const themes = Object.keys(TOKEN_THEME_FOR_DEVTOOLS_THEME) as DevtoolsThemeName[];
    // Both token themes the panel may select are reached by some DevTools name,
    // so the loop below exercises dark and light alike.
    expect(new Set(themes.map((name) => TOKEN_THEME_FOR_DEVTOOLS_THEME[name]))).toEqual(
      new Set(['dark', 'light']),
    );
    for (const themeName of themes) {
      const expected = TOKEN_THEME_FOR_DEVTOOLS_THEME[themeName];
      const panel = await openRenderedPanel({ themeName });
      await panel.waitForConnected();
      await panel.deliver(spec);
      await expect(panel.page.locator('html'), `themeName ${themeName}`).toHaveAttribute(
        'data-theme',
        expected,
      );
      await expect(panel.main.locator('[data-theme]').first()).toHaveAttribute(
        'data-theme',
        expected,
      );
      await expectNoFailures(panel);
      await panel.page.close();
    }
  });

  test('follows a DevTools theme switch made after the panel mounted', async ({
    openRenderedPanel,
  }) => {
    const spec = buildCatalogPanelSpec();
    const panel = await openRenderedPanel({ themeName: 'default' });
    await panel.waitForConnected();
    await panel.deliver(spec);
    const documentRoot = panel.page.locator('html');
    const generatedRoot = panel.main.locator('[data-theme]').first();
    await expect(documentRoot, 'the theme it opened with').toHaveAttribute(
      'data-theme',
      TOKEN_THEME_FOR_DEVTOOLS_THEME.default,
    );
    await expect(generatedRoot).toHaveAttribute(
      'data-theme',
      TOKEN_THEME_FOR_DEVTOOLS_THEME.default,
    );

    // To light and back, through each DevTools name: the document root (the
    // panel chrome) and the generated panel's own theme root move together.
    const switches: readonly DevtoolsThemeName[] = ['light', 'dark', 'light', 'default'];
    for (const themeName of switches) {
      await panel.switchDevtoolsTheme(themeName);
      const expected = TOKEN_THEME_FOR_DEVTOOLS_THEME[themeName];
      await expect(documentRoot, `after switching to ${themeName}`).toHaveAttribute(
        'data-theme',
        expected,
      );
      await expect(generatedRoot, `after switching to ${themeName}`).toHaveAttribute(
        'data-theme',
        expected,
      );
    }
    // The switches re-themed the panel in place: it is still the same panel.
    await expect(
      panel.main.getByRole('heading', { level: 2, name: spec.title, exact: true }),
    ).toBeVisible();
    await expect(panel.main.locator('[data-node-path]')).toHaveCount(placedNodes(spec).length);
    await expectNoFailures(panel);
  });

  test('an uncatalogued node type is refused before rendering and announced, never a blank area', async ({
    openRenderedPanel,
  }) => {
    expect(isKnownPanelNodeType(UNKNOWN_NODE_TYPE)).toBe(false);
    expect(Object.keys(PANEL_NODE_CATALOG)).not.toContain(UNKNOWN_NODE_TYPE);
    const spec = buildCatalogPanelSpec();
    const placed = placedNodes(spec);
    const target = placed.find(
      (entry) => PANEL_NODE_CATALOG[entry.node.type].kind === 'visualization',
    );
    if (target === undefined) {
      throw new Error('The catalog declares no visualization node type.');
    }
    const invalid = withNodeType(spec, target.path, UNKNOWN_NODE_TYPE);
    expect(validatePanelSpec(invalid).ok, 'the product validator refuses it').toBe(false);

    // A validated panel is on screen first, so "never a blank area" is observable: the refused
    // update must leave it exactly as it was.
    const panel = await openRenderedPanel();
    await panel.waitForConnected();
    await panel.deliver(spec);
    await expect(panel.main.locator('[data-node-path]')).toHaveCount(placed.length);

    await panel.pushFrame(unvalidatedPanelGeneratedPush(spec.sessionId, spec.id, invalid));

    // The refusal is announced through the panel's non-blocking failure notice, by the protocol's
    // own code, instead of the update vanishing silently.
    const refusal = panel.main
      .getByRole('status')
      .filter({ hasText: 'PROTOCOL_INVALID_MESSAGE' satisfies DebuggenErrorCode });
    await expect(refusal, 'the refused update is announced').toBeVisible();

    // The tampered document reached neither the store nor the renderer: no node failed, the
    // unknown type appears nowhere, and the panel still shows the validated spec under its title.
    await expect(
      panel.main.getByRole('heading', { level: 2, name: spec.title, exact: true }),
    ).toBeVisible();
    await expect(panel.main).not.toContainText(`"${UNKNOWN_NODE_TYPE}"`);
    expect(await renderFailureTexts(panel), 'no node was rendered as a failure').toEqual([]);

    // Every node, the one the tampered copy targeted included, still renders under its title.
    await expect(panel.main.locator('[data-node-path]')).toHaveCount(placed.length);
    for (const entry of placed) {
      await expect(
        panel
          .frameOf(entry.pathKey)
          .getByRole('region', { name: entry.title, exact: true })
          .first(),
      ).toBeVisible();
    }
    expect(panel.worker.violations).toEqual([]);
    expect(panel.errors, 'no uncaught exception').toEqual([]);
  });
});
