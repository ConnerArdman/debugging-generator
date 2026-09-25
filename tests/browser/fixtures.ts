/**
 * Shared Playwright fixtures for the `browser` project (AAP §0.8.3 "Browser").
 *
 * Every spec under `tests/browser/**` imports `test` and `expect` from this
 * module and nothing else owns the suite's lifecycle: one persistent Chromium
 * context with the built MV3 extension loaded, its service worker, a typed
 * client of the already-running local service, the generic fixture app
 * (`tests/fixtures/sample-next-app`), the one-time pairing of the extension, a
 * panel page opened directly as an extension page, an editor-role WebSocket
 * observer and a session helper that ends every session it created. The file
 * declares no `test(...)` block; its name keeps it outside the project's
 * `**\/*.spec.ts` `testMatch`.
 *
 * The working order the product requires, and which {@link SessionHelper}
 * encodes:
 *
 * 1. open the fixture app page (`appPage`);
 * 2. create the session with the editor credential for the served fixture root
 *    (the dev server must already be one the service knows, see below);
 * 3. open the panel page — its emulated DevTools page announces the inspected
 *    tab, which is what makes the service worker bind the tab by origin;
 * 4. wait for `session.bound`, then for the session to reach `ready`
 *    (observed through `session.updated` / `GET /sessions/:id`, never slept);
 * 5. `capture.start` → interact → settle → `capture.stop`;
 * 6. await `analysis.completed` / `panel.generated` as the spec requires.
 *
 * ## Fallbacks chosen where the planned contract and the code disagree
 *
 * - **Fixture app lifecycle.** The fixture app's `next.config.ts` pins
 *   `turbopack.root` to its own directory, so borrowing another workspace's
 *   `next` binary in place fails ("Could not find the Next.js package") and
 *   Next then runs `pnpm install` against the repository lockfile. The app is
 *   therefore served from a *copy* outside the repository
 *   (`<os tmpdir>/debuggen-browser-suite/<repo hash>/sample-next-app`) with its
 *   own `node_modules`, and the tracked fixture tree is only ever read.
 * - **Who starts the fixture app.** The service learns a dev server's address
 *   only from its own launcher (`apps/local-service/src/server/routes/sessions.ts`,
 *   `resolveDevServerUrl`: the launcher's registry, else an earlier session of
 *   the same root, else `DEV_SERVER_UNAVAILABLE`); `POST /dev-server/launch`
 *   carries no URL, so a server this file started on its own would never be
 *   probed and no session could be created for it. The fixture app is
 *   therefore launched *through the service* with an explicit command pinning
 *   the configured port — which also means the launcher attaches the telemetry
 *   preload, exactly as it does for any project. Only when the running service
 *   does not serve the launch route at all (`404`) is the app spawned directly,
 *   without the preload, and sessions are then expected to be refused.
 * - **`fixtureApp.projectRoot`** is the served copy — the root the service
 *   records on every session — and `fixtureApp.sourceRoot` the tracked
 *   directory; project-relative paths are identical in both, which is what
 *   {@link readFixtureSource} relies on.
 * - **DevTools emulation.** A panel document opened as an extension page has no
 *   `chrome.devtools` and no DevTools page announcing its inspected tab. An
 *   init script installs exactly the three members the panel reads
 *   (`inspectedWindow.tabId`, callback-form `inspectedWindow.eval`,
 *   `panels.themeName`) and plays the DevTools page's part by opening the
 *   `PORT_DEVTOOLS` port and sending its `devtools.hello` frame; the panel
 *   offers no real affordance (no `?tabId=` parameter) that could replace it.
 * - **Pairing** drives the panel's own `PairDialog` (rung 1 of the plan). The
 *   service worker only ever dials `DEFAULT_SERVICE_BASE_URL`, so pairing is
 *   refused with an explanation when the suite's service listens elsewhere.
 * - **Panel accessible names.** `PANEL_NAMES` types the capture button,
 *   session summary, event drawer and live tail names, and the renderer's
 *   `.dg-panel` block class is typed too, because their owning modules keep
 *   them private and a React component module cannot be evaluated in Node
 *   without React and its CSS. The connection pill's wording is imported from
 *   `@debuggen/chrome-extension/messages` (`PANEL_CONNECTION_LABELS`).
 * - **`auth.json`** is named here because `AUTH_FILE_NAME` lives inside
 *   `apps/local-service`, which this directory cannot import; the service home
 *   is the `debuggenHome` the Playwright config hands its `webServer`.
 * - **Recording.** The context is worker-scoped, so the test-scoped `viewport`
 *   option is read from the project configuration and applied at launch.
 *   `trace` and `screenshot` need nothing here: Playwright's artifacts recorder
 *   instruments every context of the worker process, this persistent one
 *   included. `video` is not recorded, because recording is fixed when a
 *   context is created and this one lives for the whole run.
 *
 * Constraints (AAP §0.3.4, §0.5.4, §0.8.4, §0.8.5, §0.9.2): no credential is
 * written, logged or assembled here — tokens are read from `auth.json` or
 * minted by pairing at runtime; only fixture-app vocabulary appears; helpers
 * expose real observations (service messages, worker storage, panel state);
 * the service runs with the deterministic provider and nothing leaves
 * localhost.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, expect, test as base } from '@playwright/test';
import type {
  BrowserContext,
  LaunchOptions,
  Locator,
  Page,
  Worker,
  WorkerInfo,
} from '@playwright/test';

import {
  HttpClient,
  isCompatibleProtocolVersion,
  isMessageOfType,
  ReconnectingWsClient,
} from '@debuggen/protocol';
import type {
  ConnectionState,
  DataQuery,
  DataQuerySource,
  DataResult,
  DataResultFor,
  HttpOperation,
  HttpRequestArgs,
  HttpResponseBody,
  MessageType,
  ProtocolMessage,
  SessionRecord,
  SessionStatus,
  WsUnauthorizedDetail,
} from '@debuggen/protocol';
import type { DebuggenError, Result } from '@debuggen/shared';
import {
  DEFAULT_SERVICE_BASE_URL,
  EXTENSION_CHANNEL,
  PANEL_CONNECTION_LABELS,
  PANEL_CONNECTION_STATUSES,
  PORT_DEVTOOLS,
  PORT_PROTOCOL_VERSION,
} from '@debuggen/chrome-extension/messages';
import type {
  DevtoolsUpstreamMessage,
  PanelConnectionStatus,
} from '@debuggen/chrome-extension/messages';
import {
  DEVTOOLS_TOKEN_STORAGE_KEY,
  STORED_CREDENTIAL_VERSION,
} from '@debuggen/chrome-extension/auth';
import { BINDING_STORAGE_KEY } from '@debuggen/chrome-extension/tab-registry';

import { debuggenHome as configuredDebuggenHome } from '../../playwright.config';
import type { DebuggenTestOptions } from '../../playwright.config';

export { expect };
export {
  BINDING_STORAGE_KEY,
  DEFAULT_SERVICE_BASE_URL,
  DEVTOOLS_TOKEN_STORAGE_KEY,
  PANEL_CONNECTION_LABELS,
};
export type { PanelConnectionStatus };

// ---------------------------------------------------------------------------
// Shared timing constants — specs use these instead of magic numbers.
// ---------------------------------------------------------------------------

/** How long `GET /health` may take to answer: the config's `webServer` has already started the service, so this only covers a busy host. */
export const SERVICE_READY_TIMEOUT_MS = 30_000;

/** A cold `next dev` compile of the fixture app, after a dependency install into its copy, on a loaded CI machine. */
export const APP_READY_TIMEOUT_MS = 120_000;

/** Chromium registers an unpacked MV3 worker within a second or two; fifteen seconds only absorbs a slow host. */
export const WORKER_READY_TIMEOUT_MS = 15_000;

/** Understanding, investigation, planning and instrumentation with the deterministic provider over a one-page app. */
export const SESSION_READY_TIMEOUT_MS = 60_000;

/**
 * Settle time between the last interaction and `capture.stop`: several of the
 * page agent's 250 ms flush intervals (`FLUSH_INTERVAL_MS` in
 * `packages/telemetry/src/browser/transport.ts`) plus the bridge → worker →
 * service relay, so the post-response React commit is ingested before the
 * capture closes.
 */
export const CAPTURE_SETTLE_MS = 1_500;

/** Polling cadence for state that has no push signal (worker storage, `GET /sessions/:id`, the panel's DOM). */
export const POLL_INTERVAL_MS = 250;

/** Default bound for a single awaited observation — the config's `expect` timeout. */
export const DEFAULT_WAIT_TIMEOUT_MS = 15_000;

/** How long `pairing.ensurePaired()` waits for the worker to report the connected pill after a code is submitted. */
export const PAIRING_TIMEOUT_MS = 30_000;

/** How long an editor connection may take to open its socket and send `client.hello` (the service closes after 3 s without one). */
export const EDITOR_CONNECT_TIMEOUT_MS = 10_000;

/** How long after `open` an editor connection waits for a 4401 refusal of its `client.hello` (the service decides synchronously on receipt). */
const HELLO_VERDICT_GRACE_MS = 500;

/** Window after an editor connection opens during which a `PATH_OUTSIDE_PROJECT` refusal is retried: the announcement is recorded asynchronously and no frame acknowledges it. */
const ANNOUNCEMENT_SETTLE_MS = 3_000;

/** Grace period between SIGTERM and SIGKILL for a dev server this file spawned itself. */
const CHILD_TERMINATION_GRACE_MS = 5_000;

/** Bound on buffered child output kept for diagnostics. */
const MAX_CHILD_OUTPUT_CHARS = 64 * 1024;

/** Longest a dependency install into the fixture copy may take (a cold store downloads four packages). */
const INSTALL_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Paths and file-name contracts
// ---------------------------------------------------------------------------

/** Repository root, from this module's own location — never from `process.cwd()`. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The tracked generic fixture app; read, never written. */
const FIXTURE_SOURCE_ROOT = path.join(REPO_ROOT, 'tests', 'fixtures', 'sample-next-app');

/** The unpacked extension `pnpm build` emits (`apps/chrome-extension/vite.config.ts`, `outDir: dist`). */
const DEFAULT_EXTENSION_PATH = path.join(REPO_ROOT, 'apps', 'chrome-extension', 'dist');

/** The panel document, an explicit Rollup input of `apps/chrome-extension/vite.config.ts`, emitted at this path. */
const PANEL_DOCUMENT_PATH = '/src/panel/panel.html';

/** The product's default service origin (AAP §0.3.4: `DEBUGGEN_HOST`, `DEBUGGEN_PORT`). */
const DEFAULT_SERVICE_HOST = '127.0.0.1';
const DEFAULT_SERVICE_PORT = '43117';

/** The fixture app's own default (`next dev --port 3100` in its `package.json`). */
const DEFAULT_FIXTURE_APP_URL = 'http://localhost:3100';

/** The editor credential file inside `$DEBUGGEN_HOME` (`AUTH_FILE_NAME`, `apps/local-service/src/config.ts`). */
const EDITOR_CREDENTIAL_FILE = 'auth.json';

/** Build output and dependencies of the fixture app — exactly the entries its own `.gitignore` covers. */
const FIXTURE_GENERATED_ENTRIES = new Set(['node_modules', '.next', 'next-env.d.ts']);

/** Files the copy owns beyond the tracked tree: the rewritten manifest's lockfile and this file's install stamp. */
const COPY_OWNED_ENTRIES = new Set(['pnpm-lock.yaml', '.debuggen-install-stamp']);

/** The fixture app's contract route: `GET /api/ping` answers `{ reply: string }` after a short delay. */
const FIXTURE_PING_PATH = '/api/ping';

/** The renderer's panel block and its body (`PANEL_CLASS`, `BODY_CLASS` in `packages/panel-renderer/src/host/PanelHost.tsx`). */
const RENDERED_PANEL_SELECTOR = '.dg-panel';
const RENDERED_PANEL_BODY_CHILDREN = '.dg-panel__body > *';

/**
 * Accessible names the panel renders from module-private constants (not
 * exported, and their `.tsx` modules cannot be evaluated in Node; see header):
 * `START_CAPTURE_LABEL` / `STOP_CAPTURE_LABEL` in `CaptureControls.tsx`,
 * `SUMMARY_TITLE` in `SessionSummary.tsx`, and `DRAWER_LABEL` /
 * `LIVE_TAIL_REGION_LABEL` in `App.tsx`.
 */
const PANEL_NAMES = Object.freeze({
  startCapture: 'Start capture',
  stopCapture: 'Stop capture',
  sessionSummary: 'Session',
  eventDetails: 'Selected event',
  liveTail: 'Live event tail',
});

/** Why the stubbed `chrome.devtools.inspectedWindow.eval` refuses, surfaced by the panel's element-selection path. */
const DEVTOOLS_EVAL_REFUSAL =
  'chrome.devtools.inspectedWindow.eval is not available in the browser suite: the panel page is opened directly as an extension page, not inside DevTools.';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options every waiter accepts. */
export interface WaitOptions {
  /** Upper bound for the wait; each waiter documents its default. */
  readonly timeoutMs?: number | undefined;
}

/**
 * One inbound frame an {@link EditorClient} received, in arrival order: the
 * validated protocol envelope (`id`, `type`, `sessionId?`, `ts` — the sender's
 * epoch-millisecond timestamp — and `payload`) plus when this process received it.
 */
export type RecordedMessage<K extends MessageType = MessageType> = Extract<
  ProtocolMessage,
  { readonly type: K }
> & {
  /** When this process received the frame (epoch milliseconds). */
  readonly receivedAt: number;
};

/** A connected editor-role (`vscode`) WebSocket observer with an ordered log of every inbound frame. */
export interface EditorClient {
  /** The project root announced in `client.hello`. */
  readonly projectRoot: string;
  /** The underlying reconnecting client's state. */
  state(): ConnectionState;
  /**
   * Resolves with the first frame of `type` matching `predicate` — including
   * frames recorded before the call, so a spec cannot lose a race. Rejects
   * with the types seen so far when nothing matched in time.
   */
  waitFor<K extends MessageType>(
    type: K,
    predicate?: (message: RecordedMessage<K>) => boolean,
    options?: WaitOptions,
  ): Promise<RecordedMessage<K>>;
  /**
   * Resolves when no frame of `type` matching `predicate` arrives within
   * `withinMs`, counting frames already recorded; rejects naming the frame
   * that did arrive.
   */
  expectNoMessage<K extends MessageType>(
    type: K,
    predicate: ((message: RecordedMessage<K>) => boolean) | undefined,
    withinMs: number,
  ): Promise<void>;
  /** Every recorded frame, optionally of one type, oldest first. */
  all(): readonly RecordedMessage[];
  all<K extends MessageType>(type: K): readonly RecordedMessage<K>[];
  /** Forget every recorded frame. */
  clear(): void;
  /** Resolves on the next recorded frame, or after `withinMs` with `undefined`. */
  next(withinMs: number): Promise<RecordedMessage | undefined>;
  /** Close the socket; the service releases this connection's workspace announcement. */
  close(): void;
}

/** A failed service call, carrying protocol's error body. */
export class ServiceCallError extends Error {
  /** The operation that failed. */
  readonly operation: string;
  /** The protocol error code. */
  readonly code: string;
  /** The HTTP status, when the service answered with one. */
  readonly status: number | undefined;
  /** The service's developer-facing hint, when present. */
  readonly hint: string | undefined;

  constructor(operation: string, error: DebuggenError) {
    const status = statusOf(error);
    const hint = typeof error.hint === 'string' ? error.hint : undefined;
    super(
      `${operation} failed with ${error.code}${status === undefined ? '' : ` (HTTP ${String(status)})`}: ${error.message}${hint === undefined ? '' : ` — ${hint}`}`,
    );
    this.name = 'ServiceCallError';
    this.operation = operation;
    this.code = error.code;
    this.status = status;
    this.hint = hint;
  }
}

/** The `session.create` request body. */
export type SessionCreateInput = NonNullable<HttpRequestArgs<'session.create'>['body']>;

/** A `DataQuery` naming one source, so its result type follows the source. */
export type DataQueryFor<S extends DataQuerySource> = DataQuery & { readonly source: S };

/** Typed client of the local service the config's `webServer` started (never spawned here). */
export interface ServiceHandle {
  /** The service origin, for example `http://127.0.0.1:43117`. */
  readonly baseUrl: string;
  /** The service's `$DEBUGGEN_HOME`, where `auth.json` was read. */
  readonly debuggenHome: string;
  /** The protocol client, authenticated with the editor credential. */
  readonly http: HttpClient;
  /** Any operation, unwrapped into a `Result` — for specs asserting a refusal. */
  call<O extends HttpOperation>(
    operation: O,
    args?: HttpRequestArgs<O>,
  ): Promise<Result<HttpResponseBody<O>, DebuggenError>>;
  health(): Promise<HttpResponseBody<'health'>>;
  pairStart(): Promise<HttpResponseBody<'pair.start'>>;
  createSession(input: SessionCreateInput): Promise<SessionRecord>;
  getSession(id: string): Promise<SessionRecord>;
  listSessions(): Promise<readonly SessionRecord[]>;
  startCapture(id: string): Promise<HttpResponseBody<'capture.start'>>;
  stopCapture(id: string): Promise<HttpResponseBody<'capture.stop'>>;
  endSession(id: string): Promise<HttpResponseBody<'session.end'>>;
  /** One page of `POST /sessions/:id/panel-data`, typed by the query's source (`total`/`nextOffset` included). */
  queryPanelData<S extends DataQuerySource>(
    id: string,
    query: DataQueryFor<S>,
  ): Promise<DataResultFor<S>>;
  getCurrentPanel(id: string): Promise<HttpResponseBody<'panel.get'>>;
  /** Open an editor-role WebSocket announcing `projectRoot` and recording every inbound frame. */
  connectEditor(projectRoot: string, options?: WaitOptions): Promise<EditorClient>;
}

/** How the fixture app came to be served. */
export type FixtureAppServer = 'service-launcher' | 'fixture-process';

/** The generic fixture app, served from a copy outside the repository. */
export interface FixtureAppHandle {
  /** The configured origin the app answers on (`fixtureAppUrl`). */
  readonly baseUrl: string;
  /** The served root — the copy the service records on every session. */
  readonly projectRoot: string;
  /** The tracked fixture directory the copy mirrors (`tests/fixtures/sample-next-app`). */
  readonly sourceRoot: string;
  /** Whether this worker caused the server to start (and therefore stops it). */
  readonly startedByFixture: boolean;
  /** Who started the process currently serving `baseUrl`. */
  readonly servedBy: FixtureAppServer;
  /**
   * Make sure the service still serves the app for `projectRoot`. The
   * launcher reuses its ready child, so this is cheap; it restarts the child
   * if ending a session stopped it.
   */
  ensureServing(): Promise<void>;
  /** Output of a server this file spawned itself (the launcher logs its child to the service log). */
  output(): string;
}

/** The pairing of the extension with the service (worker-scoped, memoised). */
export interface PairingHandle {
  /** Idempotent: returns at once when a credential is stored and the worker reports the connected pill. */
  ensurePaired(): Promise<void>;
  /** Remove the stored devtools credential; `ensurePaired()` pairs again afterwards. */
  unpair(): Promise<void>;
  /** Whether a credential of the stored shape is present (its value is never read out). */
  isPaired(): Promise<boolean>;
}

/** The persisted binding of one tab (`BINDING_STORAGE_KEY` in `chrome.storage.session`). */
export interface TabBindingView {
  readonly tabId: number;
  readonly sessionId: string;
  readonly url: string;
  readonly origin: string;
  readonly boundAt: number;
  readonly captureId: string | undefined;
}

/** Options of `openPanelPage`. */
export interface OpenPanelOptions {
  /** The page whose tab the panel inspects; defaults to the test's `appPage`. */
  readonly inspect?: Page | undefined;
  /** An explicit inspected tab id, overriding `inspect`. */
  readonly tabId?: number | undefined;
  /** The DevTools theme the stub reports (`chrome.devtools.panels.themeName`). */
  readonly themeName?: 'dark' | 'light' | undefined;
  /** Install the `chrome.devtools` stub (default `true`); without it the panel runs as outside DevTools. */
  readonly installDevtoolsStub?: boolean | undefined;
  /** Play the DevTools page's part — open `PORT_DEVTOOLS` and send `devtools.hello` (default `true`). */
  readonly announceDevtools?: boolean | undefined;
  /** Extra init scripts, run before the panel bundle and after the stub. */
  readonly initScripts?: readonly string[] | undefined;
}

/** The panel document opened as an extension page. */
export interface PanelHandle {
  readonly page: Page;
  /** The inspected tab the stub reports, or `undefined` when no stub was installed. */
  readonly tabId: number | undefined;
  /** The pill's current label, one of {@link PANEL_CONNECTION_LABELS}. */
  connectionStatus(): Promise<PanelConnectionStatus | undefined>;
  waitForConnectionStatus(status: PanelConnectionStatus, options?: WaitOptions): Promise<void>;
  waitForConnected(options?: WaitOptions): Promise<void>;
  waitForNotPaired(options?: WaitOptions): Promise<void>;
  /** Resolves with the worker's persisted binding of this panel's tab (to `sessionId`, when given). */
  waitForBound(sessionId?: string, options?: WaitOptions): Promise<TabBindingView>;
  /** Resolves when a rendered panel is present (titled `title`, when given); returns its node count. */
  waitForPanelSpec(
    options?: WaitOptions & { readonly title?: string | undefined },
  ): Promise<number>;
  startCapture(): Promise<void>;
  stopCapture(): Promise<void>;
  /** Disconnect the emulated DevTools page, which unbinds the tab. */
  closeDevtools(): Promise<void>;
  /** Console errors and uncaught exceptions of the panel page, in order. */
  consoleErrors(): readonly string[];
  readonly header: Locator;
  readonly connectionPill: Locator;
  readonly captureControls: Locator;
  readonly main: Locator;
  readonly sessionSummary: Locator;
  readonly panelView: Locator;
  readonly eventDetails: Locator;
  readonly liveTail: Locator;
  readonly pairDialog: Locator;
}

/** Options of {@link SessionHelper.capture}. */
export interface CaptureOptions {
  /** Settle time between the interaction and `capture.stop` (default {@link CAPTURE_SETTLE_MS}). */
  readonly settleMs?: number | undefined;
}

/** The outcome of one capture window. */
export interface CaptureOutcome {
  readonly captureId: string;
  readonly summary: HttpResponseBody<'capture.stop'>['summary'];
}

/** Session helpers that track every session they create and end it in teardown. */
export interface SessionHelper {
  create(
    question: string,
    options?: { readonly target?: SessionCreateInput['target'] },
  ): Promise<SessionRecord>;
  waitForStatus(
    id: string,
    status: SessionStatus | readonly SessionStatus[],
    options?: WaitOptions,
  ): Promise<SessionRecord>;
  waitForReady(id: string, options?: WaitOptions): Promise<SessionRecord>;
  capture(
    id: string,
    action: () => Promise<void>,
    options?: CaptureOptions,
  ): Promise<CaptureOutcome>;
  end(id: string): Promise<HttpResponseBody<'session.end'>>;
  /** Every session id this helper created in the current test, oldest first. */
  created(): readonly string[];
}

/** How the persistent context was obtained, for diagnostics. */
export interface ExtensionLaunchInfo {
  readonly extensionPath: string;
  readonly userDataDir: string;
  /** Which path produced the MV3 worker handle: it was already registered, or it was awaited. */
  readonly serviceWorkerDiscovery: 'already-running' | 'awaited';
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The HTTP status a protocol client error recorded in its details, if any. */
function statusOf(error: DebuggenError): number | undefined {
  const details: unknown = error.details;
  if (isRecord(details) && typeof details.status === 'number') {
    return details.status;
  }
  return undefined;
}

/** Unwrap a service call, throwing a readable {@link ServiceCallError}. */
function unwrap<T>(operation: string, result: Result<T, DebuggenError>): T {
  if (result.ok) {
    return result.value;
  }
  throw new ServiceCallError(operation, result.error);
}

/** Append to a bounded diagnostic buffer, keeping the most recent output. */
function appendBounded(buffer: string, chunk: string): string {
  const next = buffer + chunk;
  return next.length > MAX_CHILD_OUTPUT_CHARS
    ? next.slice(next.length - MAX_CHILD_OUTPUT_CHARS)
    : next;
}

/** Poll `probe` until it yields a value, or throw `describe()`'s account on timeout. */
async function pollFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  describe: () => Promise<string> | string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(await describe());
    }
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
}

/** `GET url` with a bound, answering the status (or `undefined` when nothing answered). */
async function probeStatus(url: string, timeoutMs = 2_000): Promise<number | undefined> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    await response.arrayBuffer();
    return response.status;
  } catch {
    return undefined;
  }
}

/** A non-empty trimmed string option, else `undefined`. */
function nonEmptyOption(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/** The origin of `url`, or `undefined` when it does not parse. */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** The port of an `http(s)` URL, its scheme default included. */
function portOf(url: URL): number {
  if (url.port !== '') {
    return Number(url.port);
  }
  return url.protocol === 'https:' ? 443 : 80;
}

/** The project's `viewport` option: an explicit size, `null` for none, `undefined` for Playwright's default. */
function viewportOf(use: unknown): { width: number; height: number } | null | undefined {
  const raw = isRecord(use) ? use.viewport : undefined;
  if (raw === null) {
    return null;
  }
  if (isRecord(raw) && typeof raw.width === 'number' && typeof raw.height === 'number') {
    return { width: raw.width, height: raw.height };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Fixture source helpers (for runtime-derived expectations)
// ---------------------------------------------------------------------------

/**
 * Read a file of the tracked fixture app. `source-navigation.spec.ts` derives
 * the expected `SourceLocation.line` of a call site from this at runtime
 * instead of hardcoding a line number.
 *
 * @param relativePath A POSIX path relative to `tests/fixtures/sample-next-app`.
 * @returns The text and its lines (without terminators).
 */
export async function readFixtureSource(
  relativePath: string,
): Promise<{ readonly text: string; readonly lines: readonly string[] }> {
  const resolved = path.resolve(FIXTURE_SOURCE_ROOT, ...relativePath.split('/'));
  const relative = path.relative(FIXTURE_SOURCE_ROOT, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `readFixtureSource: ${relativePath} does not name a file inside tests/fixtures/sample-next-app`,
    );
  }
  const text = await readFile(resolved, 'utf8');
  return { text, lines: text.split(/\r?\n/) };
}

/**
 * The 1-based line number of the first line containing `needle`.
 *
 * @throws When no line contains it, so a moved call site fails loudly.
 */
export function findLineContaining(text: string, needle: string): number {
  const index = text.split(/\r?\n/).findIndex((line) => line.includes(needle));
  if (index < 0) {
    throw new Error(`findLineContaining: no line contains ${JSON.stringify(needle)}`);
  }
  return index + 1;
}

// ---------------------------------------------------------------------------
// Editor-role observer (built on @debuggen/protocol's ReconnectingWsClient)
// ---------------------------------------------------------------------------

/** Counts of recorded frame types, for timeout diagnostics. */
function summarizeTypes(frames: readonly RecordedMessage[]): string {
  if (frames.length === 0) {
    return 'no frames at all';
  }
  const counts = new Map<string, number>();
  for (const frame of frames) {
    counts.set(frame.type, (counts.get(frame.type) ?? 0) + 1);
  }
  return [...counts].map(([type, count]) => `${type}×${String(count)}`).join(', ');
}

/**
 * Open an editor-role WebSocket. `globalThis.WebSocket` (Node 24) is handed to
 * the protocol client as its constructor, which is why this directory needs no
 * `ws` dependency; the first frame is `client.hello { client: 'vscode',
 * projectRoot, version, token }`, sent by the client itself.
 */
async function connectEditorClient(
  baseUrl: string,
  token: string,
  projectRoot: string,
  timeoutMs: number,
): Promise<EditorClient> {
  const frames: RecordedMessage[] = [];
  const listeners = new Set<() => void>();
  let epoch = 0;
  // Mutated from the client's callbacks, so held in an object that flow
  // analysis does not narrow.
  const live: { state: ConnectionState; unauthorized: WsUnauthorizedDetail | undefined } = {
    state: 'connecting',
    unauthorized: undefined,
  };
  const protocolErrors: string[] = [];

  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  /** Resolves on the next recorded frame or state change, or after `ms`. */
  const nextChange = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        listeners.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      listeners.add(done);
    });

  const unauthorizedError = (detail: WsUnauthorizedDetail): Error =>
    new Error(
      `The service closed the editor connection with ${String(detail.code)} (${detail.reason}): the editor credential in ${EDITOR_CREDENTIAL_FILE} was refused. It is rewritten when the service's token is rotated; restart the suite so the fixture reads the current file.`,
    );

  const client = new ReconnectingWsClient({
    url: baseUrl,
    webSocketConstructor: WebSocket,
    identity: { client: 'vscode', projectRoot },
    token,
    onStateChange: (next) => {
      live.state = next;
      notify();
    },
    onMessage: (message) => {
      frames.push({ ...message, receivedAt: Date.now() });
      notify();
    },
    onUnauthorized: (detail) => {
      live.unauthorized = detail;
      notify();
    },
    onProtocolError: (error) => {
      protocolErrors.push(error.message);
    },
  });
  if (client.configurationError !== undefined) {
    throw new Error(
      `The editor WebSocket could not be configured for ${baseUrl}: ${client.configurationError.message}`,
    );
  }
  client.connect();

  const deadline = Date.now() + timeoutMs;
  while (live.state !== 'open' && live.unauthorized === undefined && Date.now() < deadline) {
    await nextChange(deadline - Date.now());
  }
  // The service authorises `client.hello` only after the socket opened and
  // acknowledges an accepted one with no frame, so a refused credential shows
  // up as a 4401 close shortly after `open`: wait a short grace for it.
  const verdictDeadline = Date.now() + HELLO_VERDICT_GRACE_MS;
  while (live.state === 'open' && live.unauthorized === undefined && Date.now() < verdictDeadline) {
    await nextChange(verdictDeadline - Date.now());
  }
  if (live.unauthorized !== undefined) {
    client.close();
    throw unauthorizedError(live.unauthorized);
  }
  if (live.state !== 'open') {
    client.close();
    throw new Error(
      `The editor WebSocket to ${baseUrl} did not open within ${String(timeoutMs)} ms (state ${live.state}, last close code ${String(client.lastCloseCode)}). The running service may not serve its WebSocket endpoint yet; rebuild it with \`pnpm build\`.`,
    );
  }

  function framesOf<K extends MessageType>(type: K): RecordedMessage<K>[] {
    const matching: RecordedMessage<K>[] = [];
    for (const frame of frames) {
      if (isMessageOfType(frame, type)) {
        matching.push(frame);
      }
    }
    return matching;
  }

  function all(): readonly RecordedMessage[];
  function all<K extends MessageType>(type: K): readonly RecordedMessage<K>[];
  function all<K extends MessageType>(type?: K): readonly RecordedMessage[] {
    return type === undefined ? [...frames] : framesOf(type);
  }

  /** The first frame at or after `from` that matches, with the index scanned up to. */
  function scan<K extends MessageType>(
    from: number,
    type: K,
    predicate: ((message: RecordedMessage<K>) => boolean) | undefined,
  ): { readonly match: RecordedMessage<K> | undefined; readonly scanned: number } {
    for (let index = from; index < frames.length; index += 1) {
      const frame = frames[index];
      if (frame !== undefined && isMessageOfType(frame, type) && (predicate?.(frame) ?? true)) {
        return { match: frame, scanned: index + 1 };
      }
    }
    return { match: undefined, scanned: frames.length };
  }

  return {
    projectRoot,
    state: () => live.state,
    async waitFor(type, predicate, options) {
      const limit = options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      const waitDeadline = Date.now() + limit;
      let seenEpoch = epoch;
      let from = 0;
      for (;;) {
        if (seenEpoch !== epoch) {
          seenEpoch = epoch;
          from = 0;
        }
        const { match, scanned } = scan(from, type, predicate);
        if (match !== undefined) {
          return match;
        }
        from = scanned;
        if (live.unauthorized !== undefined) {
          throw unauthorizedError(live.unauthorized);
        }
        const remaining = waitDeadline - Date.now();
        if (remaining <= 0) {
          const ofType = framesOf(type).length;
          throw new Error(
            `Timed out after ${String(limit)} ms waiting for a matching ${type} frame on the editor connection (${String(ofType)} ${type} frame(s) arrived but none matched; connection ${live.state}; recorded: ${summarizeTypes(frames)}${protocolErrors.length > 0 ? `; protocol errors: ${protocolErrors.join(' | ')}` : ''}).`,
          );
        }
        await nextChange(remaining);
      }
    },
    async expectNoMessage(type, predicate, withinMs) {
      const quietDeadline = Date.now() + withinMs;
      for (;;) {
        const { match } = scan(0, type, predicate);
        if (match !== undefined) {
          throw new Error(
            `Expected no matching ${type} frame within ${String(withinMs)} ms, but one arrived: ${JSON.stringify(match.payload)}`,
          );
        }
        const remaining = quietDeadline - Date.now();
        if (remaining <= 0) {
          return;
        }
        await nextChange(remaining);
      }
    },
    all,
    clear() {
      frames.length = 0;
      epoch += 1;
    },
    async next(withinMs) {
      const startEpoch = epoch;
      const before = frames.length;
      const nextDeadline = Date.now() + withinMs;
      const index = (): number => (epoch === startEpoch ? before : 0);
      while (frames.length <= index() && Date.now() < nextDeadline) {
        await nextChange(nextDeadline - Date.now());
      }
      return frames[index()];
    },
    close() {
      client.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Service handle (reuses the running service; never spawns one)
// ---------------------------------------------------------------------------

/** The service origin: the config's `serviceUrl`, else the product default from the environment. */
function resolveServiceUrl(configured: string): string {
  const explicit = nonEmptyOption(configured);
  if (explicit !== undefined) {
    return explicit;
  }
  const host = nonEmptyOption(process.env.DEBUGGEN_HOST) ?? DEFAULT_SERVICE_HOST;
  const port = nonEmptyOption(process.env.DEBUGGEN_PORT) ?? DEFAULT_SERVICE_PORT;
  return `http://${host}:${port}`;
}

/** The service home: the one the config hands its `webServer`, else `DEBUGGEN_HOME`, else `~/.debuggen`. */
function resolveDebuggenHome(): string {
  const configured = nonEmptyOption(configuredDebuggenHome);
  if (configured !== undefined) {
    return configured;
  }
  return nonEmptyOption(process.env.DEBUGGEN_HOME) ?? path.join(os.homedir(), '.debuggen');
}

/**
 * Read the editor credential the service wrote to `$DEBUGGEN_HOME/auth.json`
 * (`{ version, token, issuedAt }`). Only its shape is checked; the value is
 * never logged or echoed in an error.
 */
async function readEditorToken(home: string, timeoutMs: number): Promise<string> {
  const file = path.join(home, EDITOR_CREDENTIAL_FILE);
  const outcome = await pollFor<{ readonly token: string } | { readonly problem: string }>(
    async () => {
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch {
        return undefined;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { problem: 'is not valid JSON' };
      }
      if (!isRecord(parsed) || typeof parsed.token !== 'string') {
        return { problem: 'carries no string `token` field' };
      }
      if (parsed.token.length < 32) {
        return { problem: 'carries a `token` shorter than the service mints' };
      }
      return { token: parsed.token };
    },
    timeoutMs,
    () =>
      `The editor credential ${file} did not appear within ${String(timeoutMs)} ms. The service mints it on first start; check that the running service uses DEBUGGEN_HOME=${home} (the Playwright config's webServer sets it; a reused local service may have been started with another home).`,
  );
  if ('problem' in outcome) {
    throw new Error(
      `The editor credential ${file} ${outcome.problem}. The service mints it on first start; delete the file and restart the service so it writes a fresh one.`,
    );
  }
  return outcome.token;
}

/** Whether a result is the page of one source. */
function isResultFor<S extends DataQuerySource>(
  result: DataResult,
  source: S,
): result is DataResultFor<S> {
  return result.source === source;
}

/**
 * Connect to the service the config's `webServer` started: probe
 * `GET /health` (and its protocol version), then read the editor credential.
 */
async function createServiceHandle(baseUrl: string, home: string): Promise<ServiceHandle> {
  const anonymous = new HttpClient({ baseUrl });
  if (anonymous.configurationError !== undefined) {
    throw new Error(
      `The service URL ${baseUrl} was refused by the protocol client: ${anonymous.configurationError.message}`,
    );
  }
  let lastHealthError = 'nothing answered';
  const health = await pollFor(
    async () => {
      const result = await anonymous.health({ timeoutMs: 2_000 });
      if (result.ok) {
        return result.value;
      }
      lastHealthError = `${result.error.code}: ${result.error.message}`;
      return undefined;
    },
    SERVICE_READY_TIMEOUT_MS,
    () =>
      `The local service at ${baseUrl} did not answer GET /health within ${String(SERVICE_READY_TIMEOUT_MS)} ms (${lastHealthError}). This fixture never starts a service: the Playwright config's webServer runs \`node apps/local-service/dist/main.js\`, so build it first with \`pnpm build\` and check that DEBUGGEN_HOST/DEBUGGEN_PORT agree with the config's serviceUrl.`,
  );
  if (!isCompatibleProtocolVersion(health.protocolVersion)) {
    throw new Error(
      `The service at ${baseUrl} speaks protocol ${health.protocolVersion}, which this build does not; a stale service is running — stop it or rebuild with \`pnpm build\`.`,
    );
  }

  const token = await readEditorToken(home, SERVICE_READY_TIMEOUT_MS);
  const http = new HttpClient({ baseUrl, token });

  const call = <O extends HttpOperation>(
    operation: O,
    args?: HttpRequestArgs<O>,
  ): Promise<Result<HttpResponseBody<O>, DebuggenError>> => http.request(operation, args);

  return {
    baseUrl,
    debuggenHome: home,
    http,
    call,
    async health() {
      return unwrap('health', await http.health());
    },
    async pairStart() {
      return unwrap('pair.start', await call('pair.start', { body: {} }));
    },
    async createSession(input) {
      // The editor connection's workspace announcement is recorded
      // asynchronously and never acknowledged, so a refusal for scope right
      // after an announcing connection opened is retried briefly.
      const retryUntil = Date.now() + ANNOUNCEMENT_SETTLE_MS;
      for (;;) {
        const result = await call('session.create', { body: input });
        if (result.ok) {
          return result.value;
        }
        if (result.error.code !== 'PATH_OUTSIDE_PROJECT' || Date.now() >= retryUntil) {
          throw new ServiceCallError('session.create', result.error);
        }
        await delay(POLL_INTERVAL_MS);
      }
    },
    async getSession(id) {
      return unwrap('session.get', await call('session.get', { params: { id } }));
    },
    async listSessions() {
      return unwrap('session.list', await call('session.list')).sessions;
    },
    async startCapture(id) {
      return unwrap('capture.start', await call('capture.start', { params: { id }, body: {} }));
    },
    async stopCapture(id) {
      return unwrap('capture.stop', await call('capture.stop', { params: { id }, body: {} }));
    },
    async endSession(id) {
      return unwrap('session.end', await call('session.end', { params: { id }, body: {} }));
    },
    async queryPanelData(id, query) {
      const result = unwrap(
        'panel.data',
        await call('panel.data', { params: { id }, body: query }),
      );
      if (!isResultFor(result, query.source)) {
        throw new Error(
          `panel.data answered a ${result.source} page for a ${query.source} query of session ${id}.`,
        );
      }
      return result;
    },
    async getCurrentPanel(id) {
      return unwrap('panel.get', await call('panel.get', { params: { id } }));
    },
    connectEditor(projectRoot, options) {
      return connectEditorClient(
        baseUrl,
        token,
        projectRoot,
        options?.timeoutMs ?? EDITOR_CONNECT_TIMEOUT_MS,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture app: a copy outside the repository, served through the service
// ---------------------------------------------------------------------------

/** The environment for processes this file starts: no telemetry preload, no service credential. */
function childEnvironment(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  for (const name of Object.keys(env)) {
    if (name.startsWith('DEBUGGEN_')) {
      delete env[name];
    }
  }
  return { ...env, ...extra };
}

/** Run a short-lived command to completion, bounded, collecting its output. */
function runToCompletion(
  file: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ readonly code: number | null; readonly output: string }> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const child = spawn(file, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (chunk: Buffer): void => {
      output = appendBounded(output, chunk.toString('utf8'));
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      output = appendBounded(output, `\n[fixtures] killed after ${String(timeoutMs)} ms\n`);
      child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (code: number | null): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code, output });
      }
    };
    child.on('error', (error) => {
      output = appendBounded(output, `\n[fixtures] ${error.message}\n`);
      finish(null);
    });
    child.on('close', (code) => {
      finish(code);
    });
  });
}

/** How to run pnpm: the one running this suite when it is pnpm, else `pnpm` from PATH. */
function pnpmInvocation(): { readonly file: string; readonly prefix: readonly string[] } {
  const execPath = nonEmptyOption(process.env.npm_execpath);
  if (execPath !== undefined && /pnpm/i.test(path.basename(execPath)) && existsSync(execPath)) {
    return /\.(c|m)?js$/i.test(execPath)
      ? { file: process.execPath, prefix: [execPath] }
      : { file: execPath, prefix: [] };
  }
  return { file: 'pnpm', prefix: [] };
}

/** Mirror the tracked fixture tree into `target`, writing only what differs. */
async function mirrorTree(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  const sourceEntries = await readdir(source, { withFileTypes: true });
  const kept = new Set<string>();
  for (const entry of sourceEntries) {
    if (FIXTURE_GENERATED_ENTRIES.has(entry.name) || entry.name.endsWith('.tsbuildinfo')) {
      continue;
    }
    kept.add(entry.name);
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await mirrorTree(from, to);
    } else if (
      entry.isFile() &&
      !(source === FIXTURE_SOURCE_ROOT && entry.name === 'package.json')
    ) {
      await writeIfChanged(to, await readFile(from));
    }
  }
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const owned =
      FIXTURE_GENERATED_ENTRIES.has(entry.name) ||
      (target === fixtureCopyRoot() && COPY_OWNED_ENTRIES.has(entry.name));
    if (!kept.has(entry.name) && !owned) {
      await rm(path.join(target, entry.name), { recursive: true, force: true });
    }
  }
}

async function writeIfChanged(file: string, content: Buffer): Promise<boolean> {
  try {
    const current = await readFile(file);
    if (current.equals(content)) {
      return false;
    }
  } catch {
    // Absent: written below.
  }
  await writeFile(file, content);
  return true;
}

/** Where this clone's fixture copy lives: stable per repository clone, so a reused service's launch is reused too. */
function fixtureCopyRoot(): string {
  const repoKey = createHash('sha256').update(REPO_ROOT).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), 'debuggen-browser-suite', repoKey, 'sample-next-app');
}

/**
 * The copy's `package.json`: the tracked manifest plus the repository's own
 * `typescript` and `@types/node` versions, so `next dev` does not install
 * versions of its choosing on first start.
 */
async function copyManifest(): Promise<string> {
  const manifest: unknown = JSON.parse(
    await readFile(path.join(FIXTURE_SOURCE_ROOT, 'package.json'), 'utf8'),
  );
  const rootManifest: unknown = JSON.parse(
    await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  );
  if (!isRecord(manifest)) {
    throw new Error('tests/fixtures/sample-next-app/package.json is not a JSON object.');
  }
  const rootDev = isRecord(rootManifest) ? rootManifest.devDependencies : undefined;
  const pinned: Record<string, string> = {};
  for (const name of ['typescript', '@types/node']) {
    const version = isRecord(rootDev) ? rootDev[name] : undefined;
    if (typeof version === 'string') {
      pinned[name] = version;
    }
  }
  const ownDev = isRecord(manifest.devDependencies) ? manifest.devDependencies : {};
  return `${JSON.stringify({ ...manifest, devDependencies: { ...ownDev, ...pinned } }, null, 2)}\n`;
}

/**
 * Prepare the fixture app's copy: mirror the tracked tree and install its
 * dependencies there (never into the repository). Idempotent; the install runs
 * only when the manifest changed or `next` is missing.
 *
 * @returns The copy's absolute root.
 */
export async function prepareFixtureAppCopy(): Promise<string> {
  const root = fixtureCopyRoot();
  await mirrorTree(FIXTURE_SOURCE_ROOT, root);
  const manifest = await copyManifest();
  await writeIfChanged(path.join(root, 'package.json'), Buffer.from(manifest, 'utf8'));
  const stampFile = path.join(root, '.debuggen-install-stamp');
  const stamp = createHash('sha256').update(manifest).digest('hex');
  const previous = await readFile(stampFile, 'utf8').then(
    (text) => text.trim(),
    () => '',
  );
  if (previous === stamp && existsSync(path.join(root, 'node_modules', 'next', 'package.json'))) {
    return root;
  }
  const pnpm = pnpmInvocation();
  const installed = await runToCompletion(
    pnpm.file,
    [...pnpm.prefix, 'install', '--ignore-workspace', '--prefer-offline', '--no-frozen-lockfile'],
    root,
    childEnvironment({ CI: 'true' }),
    INSTALL_TIMEOUT_MS,
  );
  if (installed.code !== 0) {
    throw new Error(
      `Installing the fixture app's dependencies into ${root} failed (exit ${String(installed.code)}); pnpm must be available (corepack enable). Output:\n${installed.output}`,
    );
  }
  await writeFile(stampFile, `${stamp}\n`);
  return root;
}

/** A dev server this file spawned itself (the fallback when the service cannot launch one). */
interface SpawnedServer {
  readonly child: ChildProcess;
  output(): string;
}

/**
 * Start `next dev` for the copy directly — without the telemetry preload —
 * as its own process group, so teardown reaches Next's server worker too.
 */
export function spawnFixtureAppServer(root: string, url: URL): SpawnedServer {
  let output = '';
  const nextBin = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
  const child = spawn(
    process.execPath,
    [nextBin, 'dev', root, '--port', String(portOf(url)), '--hostname', url.hostname],
    {
      cwd: root,
      env: childEnvironment({ NEXT_TELEMETRY_DISABLED: '1' }),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const collect = (chunk: Buffer): void => {
    output = appendBounded(output, chunk.toString('utf8'));
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  child.on('error', (error) => {
    output = appendBounded(output, `\n[fixtures] ${error.message}\n`);
  });
  return { child, output: () => output };
}

/** SIGTERM the child's process group, then SIGKILL after the grace period. */
async function terminateSpawned(server: SpawnedServer): Promise<void> {
  const { child } = server;
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal);
    } catch {
      // The group is already gone.
    }
  };
  signalGroup('SIGTERM');
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(CHILD_TERMINATION_GRACE_MS).then(() => false),
  ]);
  if (!graceful) {
    signalGroup('SIGKILL');
    await Promise.race([exited, delay(CHILD_TERMINATION_GRACE_MS)]);
  }
}

/**
 * Wait until the fixture app answers `/`, then pre-warm `/` and the contract
 * route once — so the first spec's click does not measure a first compile —
 * and confirm the server really is the fixture app.
 */
async function waitForFixtureApp(baseUrl: string, diagnostics: () => string): Promise<void> {
  const root = new URL('/', baseUrl).toString();
  let lastStatus: number | undefined;
  await pollFor(
    async () => {
      lastStatus = await probeStatus(root, 10_000);
      return lastStatus === 200 ? true : undefined;
    },
    APP_READY_TIMEOUT_MS,
    () =>
      `The fixture app at ${root} did not answer 200 within ${String(APP_READY_TIMEOUT_MS)} ms (last status ${String(lastStatus)}). ${diagnostics()}`,
  );
  const ping = new URL(FIXTURE_PING_PATH, baseUrl).toString();
  let reply: unknown;
  try {
    const response = await fetch(ping, { signal: AbortSignal.timeout(APP_READY_TIMEOUT_MS) });
    reply = response.ok ? await response.json() : undefined;
  } catch (error) {
    reply = describeError(error);
  }
  if (!isRecord(reply) || typeof reply.reply !== 'string') {
    throw new Error(
      `The server at ${baseUrl} is not the sample-next-app fixture: GET ${FIXTURE_PING_PATH} did not answer { reply: string } (got ${JSON.stringify(reply)}). Free the port or point FIXTURE_APP_URL at another one. ${diagnostics()}`,
    );
  }
}

/** The worker-scoped state behind {@link FixtureAppHandle}. */
interface FixtureAppState {
  readonly handle: FixtureAppHandle;
  dispose(): Promise<string[]>;
}

/**
 * Serve the fixture app. The service is asked to launch the copy with an
 * explicit command pinning the configured port (it reuses its own ready child
 * for the same root); only a service without the launch route (`404`) makes
 * this file spawn the app itself.
 */
async function serveFixtureApp(
  service: ServiceHandle,
  configuredUrl: string,
): Promise<FixtureAppState> {
  const baseUrl = nonEmptyOption(configuredUrl) ?? DEFAULT_FIXTURE_APP_URL;
  const url = new URL(baseUrl);
  const origin = url.origin;
  const projectRoot = await prepareFixtureAppCopy();
  const preexisting = (await probeStatus(new URL('/', origin).toString())) !== undefined;

  // The launch route (and every session route) acts only under a workspace an
  // open editor connection announced; this one lives as long as the worker.
  const anchor = await service.connectEditor(projectRoot);
  const command = `NEXT_TELEMETRY_DISABLED=1 "${process.execPath}" node_modules/next/dist/bin/next dev --port ${String(portOf(url))} --hostname ${url.hostname}`;

  const launch = async (): Promise<'served' | 'route-missing'> => {
    const result = await service.call('devServer.launch', {
      body: { projectRoot, command },
      timeoutMs: APP_READY_TIMEOUT_MS,
    });
    if (!result.ok) {
      if (statusOf(result.error) === 404) {
        return 'route-missing';
      }
      const occupied = preexisting
        ? ` Something already answered on ${origin} before the launch — the service can only use a dev server it started, so free that port or set FIXTURE_APP_URL to another one.`
        : '';
      throw new Error(
        `${new ServiceCallError('devServer.launch', result.error).message}.${occupied} The dev server's own output is in the service log.`,
      );
    }
    if (originOf(result.value.devServerUrl) !== origin) {
      throw new Error(
        `The service launched the fixture app at ${result.value.devServerUrl}, not at the configured ${origin}; the tab would never bind to the session. Check FIXTURE_APP_URL and that nothing else holds its port.`,
      );
    }
    return 'served';
  };

  let spawned: SpawnedServer | undefined;
  let servedBy: FixtureAppServer = 'service-launcher';
  try {
    if ((await launch()) === 'route-missing') {
      servedBy = 'fixture-process';
      if (!preexisting) {
        spawned = spawnFixtureAppServer(projectRoot, url);
      }
    }
    const diagnostics = (): string =>
      spawned !== undefined
        ? `Dev server output:\n${spawned.output()}`
        : 'The dev server was launched by the service; its output is in the service log.';
    await waitForFixtureApp(origin, diagnostics);
  } catch (error) {
    if (spawned !== undefined) {
      await terminateSpawned(spawned);
    }
    anchor.close();
    throw error;
  }

  const startedByFixture = !preexisting;
  const handle: FixtureAppHandle = {
    baseUrl: origin,
    projectRoot,
    sourceRoot: FIXTURE_SOURCE_ROOT,
    startedByFixture,
    servedBy,
    async ensureServing() {
      if (servedBy === 'service-launcher') {
        await launch();
      } else if (
        spawned !== undefined &&
        (spawned.child.exitCode !== null || spawned.child.signalCode !== null)
      ) {
        throw new Error(`The fixture app's dev server exited. Output:\n${spawned.output()}`);
      }
      await waitForFixtureApp(origin, () =>
        spawned === undefined ? 'See the service log.' : spawned.output(),
      );
    },
    output: () => spawned?.output() ?? '',
  };

  return {
    handle,
    async dispose() {
      const problems: string[] = [];
      if (servedBy === 'service-launcher' && startedByFixture) {
        const stopped = await service.call('devServer.stop', { body: { projectRoot } });
        if (!stopped.ok) {
          problems.push(new ServiceCallError('devServer.stop', stopped.error).message);
        }
      }
      if (spawned !== undefined) {
        await terminateSpawned(spawned);
      }
      anchor.close();
      return problems;
    },
  };
}

// ---------------------------------------------------------------------------
// Persistent context, extension load and the MV3 service worker
// ---------------------------------------------------------------------------

/** The worker-scoped browser state. */
interface ExtensionHarness {
  readonly context: BrowserContext;
  readonly extensionId: string;
  readonly serviceWorker: Worker;
  readonly info: ExtensionLaunchInfo;
  /** The extension's current worker — the one captured at launch unless Chromium restarted it. */
  liveWorker(): Promise<Worker>;
}

/** Built-in worker options this file honours. */
interface BrowserOptions {
  readonly headless: boolean;
  readonly channel: string | undefined;
  readonly launchOptions: LaunchOptions;
}

const EXTENSION_SCHEME = 'chrome-extension:';

function isExtensionUrl(url: string): boolean {
  try {
    return new URL(url).protocol === EXTENSION_SCHEME;
  } catch {
    return false;
  }
}

/**
 * Launch the persistent context with the unpacked extension — extensions load
 * only in a persistent context — and obtain its MV3 worker on whichever path
 * wins the race: already registered, or awaited.
 */
async function launchExtension(
  configuredPath: string,
  options: BrowserOptions,
  workerInfo: WorkerInfo,
): Promise<ExtensionHarness & { dispose(): Promise<void> }> {
  const extensionPath = path.resolve(nonEmptyOption(configuredPath) ?? DEFAULT_EXTENSION_PATH);
  if (!existsSync(path.join(extensionPath, 'manifest.json'))) {
    throw new Error(
      `The built Chrome extension is missing: ${path.join(extensionPath, 'manifest.json')} does not exist. Build it first with \`pnpm build\` (or \`pnpm --filter @debuggen/chrome-extension... build\`).`,
    );
  }
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'debuggen-browser-profile-'));
  const { args: extraArgs, ...launchOptions } = options.launchOptions;
  const viewport = viewportOf(workerInfo.project.use);
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      ...launchOptions,
      headless: options.headless,
      channel: options.channel ?? 'chromium',
      args: [
        ...(extraArgs ?? []),
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
      ...(viewport === undefined ? {} : { viewport }),
    });
  } catch (error) {
    await rm(userDataDir, { recursive: true, force: true });
    throw error;
  }

  const disposeContext = async (): Promise<void> => {
    await context.close().catch(() => undefined);
    await rm(userDataDir, { recursive: true, force: true });
  };

  let serviceWorker = context.serviceWorkers().find((candidate) => isExtensionUrl(candidate.url()));
  let serviceWorkerDiscovery: ExtensionLaunchInfo['serviceWorkerDiscovery'] = 'already-running';
  if (serviceWorker === undefined) {
    serviceWorkerDiscovery = 'awaited';
    try {
      serviceWorker = await context.waitForEvent('serviceworker', {
        timeout: WORKER_READY_TIMEOUT_MS,
        predicate: (candidate) => isExtensionUrl(candidate.url()),
      });
    } catch (error) {
      const pageIds = context
        .pages()
        .map((page) => page.url())
        .filter(isExtensionUrl)
        .map((url) => new URL(url).host);
      await disposeContext();
      throw new Error(
        `The extension's MV3 service worker did not register within ${String(WORKER_READY_TIMEOUT_MS)} ms (extension path ${extensionPath}; extension id ${pageIds[0] ?? 'unresolved'}). Build the extension first with \`pnpm build\`; a manifest that loads but whose worker fails to evaluate shows up as this timeout. ${describeError(error)}`,
        { cause: error },
      );
    }
  }

  let extensionId = new URL(serviceWorker.url()).host;
  if (extensionId === '') {
    // Fallback: any extension document of the context names the same id.
    const fromPage = context
      .pages()
      .map((page) => page.url())
      .find(isExtensionUrl);
    extensionId = fromPage === undefined ? '' : new URL(fromPage).host;
  }
  if (extensionId === '') {
    await disposeContext();
    throw new Error(
      `The extension id could not be read from the worker URL ${serviceWorker.url()}.`,
    );
  }

  const initialWorker = serviceWorker;
  const liveWorker = async (): Promise<Worker> => {
    const current = context
      .serviceWorkers()
      .find((candidate) => new URL(candidate.url()).host === extensionId);
    if (current !== undefined) {
      return current;
    }
    return context.waitForEvent('serviceworker', {
      timeout: WORKER_READY_TIMEOUT_MS,
      predicate: (candidate) => new URL(candidate.url()).host === extensionId,
    });
  };

  return {
    context,
    extensionId,
    serviceWorker: initialWorker,
    info: { extensionPath, userDataDir, serviceWorkerDiscovery },
    liveWorker,
    dispose: disposeContext,
  };
}

/** A `chrome.storage` area, as the worker exposes it (only what these helpers call). */
interface WorkerStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  remove(key: string): Promise<void>;
}

/** Read one key of a `chrome.storage` area in the extension's worker. */
async function readWorkerStorage(
  worker: Worker,
  area: 'local' | 'session',
  key: string,
): Promise<unknown> {
  return worker.evaluate(
    async ({ area: name, key: item }) => {
      const host = globalThis as unknown as {
        chrome: { storage: Record<'local' | 'session', WorkerStorageArea> };
      };
      const items = await host.chrome.storage[name].get(item);
      return items[item];
    },
    { area, key },
  );
}

/** Remove one key of a `chrome.storage` area in the extension's worker. */
async function removeWorkerStorage(
  worker: Worker,
  area: 'local' | 'session',
  key: string,
): Promise<void> {
  await worker.evaluate(
    async ({ area: name, key: item }) => {
      const host = globalThis as unknown as {
        chrome: { storage: Record<'local' | 'session', WorkerStorageArea> };
      };
      await host.chrome.storage[name].remove(item);
    },
    { area, key },
  );
}

/** One tab as `chrome.tabs.query` reports it (the manifest grants `tabs`). */
interface TabView {
  readonly id: number;
  readonly url: string;
  readonly active: boolean;
}

async function queryTabs(worker: Worker): Promise<readonly TabView[]> {
  return worker.evaluate(async () => {
    const host = globalThis as unknown as {
      chrome: {
        tabs: {
          query(
            queryInfo: Record<string, never>,
          ): Promise<{ id?: number; url?: string; active: boolean }[]>;
        };
      };
    };
    const tabs = await host.chrome.tabs.query({});
    return tabs.map((tab) => ({ id: tab.id ?? -1, url: tab.url ?? '', active: tab.active }));
  });
}

/** The tab id of `page`, resolved from the worker by URL (activating the page when several match). */
async function tabIdOf(worker: Worker, page: Page): Promise<number> {
  const url = page.url();
  let matching = (await queryTabs(worker)).filter((tab) => tab.url === url && tab.id >= 0);
  if (matching.length > 1) {
    await page.bringToFront();
    matching = (await queryTabs(worker)).filter(
      (tab) => tab.url === url && tab.id >= 0 && tab.active,
    );
  }
  const [only] = matching;
  if (only === undefined || matching.length !== 1) {
    const all = await queryTabs(worker);
    throw new Error(
      `Could not resolve the tab of ${url}: ${String(matching.length)} candidate tab(s) among ${JSON.stringify(all)}. Pass openPanelPage({ tabId }) explicitly.`,
    );
  }
  return only.id;
}

/** The persisted binding of `tabId`, when the worker recorded one. */
async function readBinding(worker: Worker, tabId: number): Promise<TabBindingView | undefined> {
  const snapshot = await readWorkerStorage(worker, 'session', BINDING_STORAGE_KEY);
  const record = isRecord(snapshot) ? snapshot[String(tabId)] : undefined;
  if (
    !isRecord(record) ||
    typeof record.sessionId !== 'string' ||
    typeof record.url !== 'string' ||
    typeof record.origin !== 'string' ||
    typeof record.boundAt !== 'number'
  ) {
    return undefined;
  }
  return {
    tabId,
    sessionId: record.sessionId,
    url: record.url,
    origin: record.origin,
    boundAt: record.boundAt,
    captureId: typeof record.captureId === 'string' ? record.captureId : undefined,
  };
}

/**
 * Clear the persisted per-tab bindings (`BINDING_STORAGE_KEY` in
 * `chrome.storage.session`) while keeping the paired credential in
 * `chrome.storage.local`. The live registry forgets a tab when its DevTools
 * port disconnects, which closing a panel page does; this clears what a
 * restarted worker would otherwise re-associate.
 */
async function clearBindings(harness: ExtensionHarness): Promise<void> {
  await removeWorkerStorage(await harness.liveWorker(), 'session', BINDING_STORAGE_KEY);
}

/** Whether the worker holds a devtools credential of the stored shape; the token itself is never returned. */
async function hasStoredCredential(harness: ExtensionHarness): Promise<boolean> {
  const worker = await harness.liveWorker();
  return worker
    .evaluate(async (key) => {
      const host = globalThis as unknown as {
        chrome: { storage: { local: WorkerStorageArea } };
      };
      const items = await host.chrome.storage.local.get(key);
      const stored = items[key];
      if (typeof stored !== 'object' || stored === null) {
        return { version: undefined, tokenLength: 0 };
      }
      const record = stored as { version?: unknown; token?: unknown };
      return {
        version: record.version,
        tokenLength: typeof record.token === 'string' ? record.token.length : 0,
      };
    }, DEVTOOLS_TOKEN_STORAGE_KEY)
    .then((shape) => shape.version === STORED_CREDENTIAL_VERSION && shape.tokenLength >= 32);
}

// ---------------------------------------------------------------------------
// The panel page and its DevTools emulation
// ---------------------------------------------------------------------------

/** What the init script needs; serialised into the page, so plain data only. */
interface DevtoolsEmulationArgs {
  /** Only the top-level panel document is emulated, never a sub-frame or another page. */
  readonly panelPath: string;
  /** `chrome.devtools.inspectedWindow.tabId`. */
  readonly inspectedTabId: number;
  /** `chrome.devtools.panels.themeName`: `'default'` (light) or `'dark'`. */
  readonly themeName: 'default' | 'dark';
  /** The refusal `inspectedWindow.eval` reports. */
  readonly evalRefusal: string;
  /** The DevTools page's port name and `devtools.hello` frame, when the tab is announced. */
  readonly announce: {
    readonly portName: string;
    readonly frame: DevtoolsUpstreamMessage<'devtools.hello'>;
  } | null;
}

/**
 * Runs in the panel document before its bundle. It supplies exactly the
 * `chrome.devtools` members `apps/chrome-extension/src/panel/**` reads —
 * `inspectedWindow.tabId` (`state/connection.ts` `readInspectedTabId`),
 * callback-form `inspectedWindow.eval` (`App.tsx`, element selection; refused
 * here) and `panels.themeName` (`theme.ts`) — so a panel change that needs
 * another DevTools API fails visibly instead of rendering empty. It then plays
 * the DevTools page (`src/devtools/devtools.ts`): opens the `PORT_DEVTOOLS`
 * port and sends `devtools.hello`, which is what makes the worker bind the
 * inspected tab. The port is kept referenced for the page's lifetime; its
 * disconnect is the worker's `session.unbind` signal.
 */
function installDevtoolsEmulation(args: DevtoolsEmulationArgs): void {
  if (window.top !== window || window.location.pathname !== args.panelPath) {
    return;
  }
  interface EmulatedPort {
    postMessage(message: unknown): void;
    disconnect(): void;
  }
  const host = globalThis as unknown as {
    chrome?: {
      runtime?: { connect?: (connectInfo: { name: string }) => EmulatedPort };
    };
  };
  const chromeApi = host.chrome;
  if (chromeApi === undefined) {
    return;
  }
  const isCallback = (value: unknown): value is (result: unknown, exceptionInfo: unknown) => void =>
    typeof value === 'function';
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
    panels: Object.freeze({ themeName: args.themeName }),
  });
  Object.defineProperty(chromeApi, 'devtools', {
    value: devtools,
    configurable: true,
    enumerable: true,
  });
  const connect = chromeApi.runtime?.connect;
  if (args.announce !== null && typeof connect === 'function') {
    const port = connect({ name: args.announce.portName });
    port.postMessage(args.announce.frame);
    Object.defineProperty(window, '__debuggenEmulatedDevtoolsPort', {
      value: port,
      configurable: true,
    });
  }
}

/** Disconnect the emulated DevTools page's port (runs in the panel document). */
function disconnectEmulatedDevtools(): boolean {
  const holder = window as unknown as {
    __debuggenEmulatedDevtoolsPort?: { disconnect(): void };
  };
  const port = holder.__debuggenEmulatedDevtoolsPort;
  if (port === undefined) {
    return false;
  }
  port.disconnect();
  delete holder.__debuggenEmulatedDevtoolsPort;
  return true;
}

/** Escape a literal for a `RegExp`. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolved `openPanelPage` inputs. */
interface PanelLaunch {
  readonly inspectedTabId: number | undefined;
  readonly inspectedUrl: string | undefined;
  readonly themeName: 'dark' | 'light';
  readonly installDevtoolsStub: boolean;
  readonly announceDevtools: boolean;
  readonly initScripts: readonly string[];
}

/** Open the panel document as an extension page and wrap it in a {@link PanelHandle}. */
async function openPanel(harness: ExtensionHarness, launch: PanelLaunch): Promise<PanelHandle> {
  const page = await harness.context.newPage();
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console.error: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    errors.push(`uncaught ${error.name}: ${error.message}`);
  });

  if (launch.installDevtoolsStub) {
    if (launch.inspectedTabId === undefined) {
      await page.close();
      throw new Error('openPanelPage: the chrome.devtools stub needs an inspected tab id.');
    }
    const inspectedUrl = launch.inspectedUrl;
    const announceOrigin = inspectedUrl === undefined ? undefined : originOf(inspectedUrl);
    const args: DevtoolsEmulationArgs = {
      panelPath: PANEL_DOCUMENT_PATH,
      inspectedTabId: launch.inspectedTabId,
      themeName: launch.themeName === 'light' ? 'default' : 'dark',
      evalRefusal: DEVTOOLS_EVAL_REFUSAL,
      announce: launch.announceDevtools
        ? {
            portName: PORT_DEVTOOLS,
            frame: {
              channel: EXTENSION_CHANNEL,
              version: PORT_PROTOCOL_VERSION,
              direction: 'upstream',
              type: 'devtools.hello',
              payload: {
                tabId: launch.inspectedTabId,
                ...(inspectedUrl === undefined ? {} : { url: inspectedUrl }),
                ...(announceOrigin === undefined ? {} : { origin: announceOrigin }),
              },
            },
          }
        : null,
    };
    await page.addInitScript(installDevtoolsEmulation, args);
  }
  for (const content of launch.initScripts) {
    await page.addInitScript({ content });
  }
  const panelUrl = `chrome-extension://${harness.extensionId}${PANEL_DOCUMENT_PATH}`;
  await page.goto(panelUrl);

  const header = page.getByRole('banner');
  const labelPattern = new RegExp(
    `^\\s*(${PANEL_CONNECTION_STATUSES.map((status) => escapeRegExp(PANEL_CONNECTION_LABELS[status])).join('|')})`,
  );
  const connectionPill = header.getByRole('status').filter({ hasText: labelPattern });
  const main = page.getByRole('main');
  const panelView = main.locator(RENDERED_PANEL_SELECTOR);
  const tabId = launch.installDevtoolsStub ? launch.inspectedTabId : undefined;

  const readStatus = async (): Promise<PanelConnectionStatus | undefined> => {
    const text =
      (await connectionPill
        .first()
        .textContent({ timeout: 1_000 })
        .catch(() => null)) ?? '';
    return PANEL_CONNECTION_STATUSES.find((status) =>
      text.trim().startsWith(PANEL_CONNECTION_LABELS[status]),
    );
  };
  const errorsSuffix = (): string =>
    errors.length === 0 ? '' : ` Panel errors: ${errors.join(' | ')}`;

  const waitForConnectionStatus = async (
    status: PanelConnectionStatus,
    options?: WaitOptions,
  ): Promise<void> => {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    let seen: PanelConnectionStatus | undefined;
    await pollFor(
      async () => {
        seen = await readStatus();
        return seen === status ? true : undefined;
      },
      timeoutMs,
      () =>
        `The panel's connection pill did not read "${PANEL_CONNECTION_LABELS[status]}" within ${String(timeoutMs)} ms; it reads ${seen === undefined ? 'nothing recognisable' : `"${PANEL_CONNECTION_LABELS[seen]}"`}.${errorsSuffix()}`,
    );
  };

  const clickCaptureButton = async (name: string): Promise<void> => {
    const button = header.getByRole('button', { name, exact: true });
    try {
      await expect(button).toBeEnabled({ timeout: DEFAULT_WAIT_TIMEOUT_MS });
    } catch (error) {
      throw new Error(
        `The panel's "${name}" button did not become available (connection ${String(await readStatus())}): ${describeError(error)}${errorsSuffix()}`,
        { cause: error },
      );
    }
    await button.click();
  };

  return {
    page,
    tabId,
    connectionStatus: readStatus,
    waitForConnectionStatus,
    waitForConnected: (options) => waitForConnectionStatus('connected', options),
    waitForNotPaired: (options) => waitForConnectionStatus('not-paired', options),
    async waitForBound(sessionId, options) {
      if (tabId === undefined) {
        throw new Error('waitForBound: this panel page inspects no tab (no chrome.devtools stub).');
      }
      const timeoutMs = options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      let seen: TabBindingView | undefined;
      return pollFor(
        async () => {
          seen = await readBinding(await harness.liveWorker(), tabId);
          return seen !== undefined && (sessionId === undefined || seen.sessionId === sessionId)
            ? seen
            : undefined;
        },
        timeoutMs,
        async () =>
          `Tab ${String(tabId)} was not bound${sessionId === undefined ? '' : ` to session ${sessionId}`} within ${String(timeoutMs)} ms: the worker's binding is ${seen === undefined ? 'absent' : `to session ${seen.sessionId} (${seen.origin})`}; connection pill ${String(await readStatus())}.${errorsSuffix()}`,
      );
    },
    async waitForPanelSpec(options) {
      const timeoutMs = options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      const target =
        options?.title === undefined
          ? panelView.first()
          : main.getByRole('region', { name: options.title, exact: true });
      try {
        await target.waitFor({ state: 'visible', timeout: timeoutMs });
      } catch {
        const mainText = ((await main.textContent().catch(() => null)) ?? '').trim().slice(0, 400);
        throw new Error(
          `No rendered panel${options?.title === undefined ? '' : ` titled "${options.title}"`} appeared within ${String(timeoutMs)} ms (${String(await panelView.count())} panel block(s) present; main reads: "${mainText}").${errorsSuffix()}`,
        );
      }
      return panelView.first().locator(RENDERED_PANEL_BODY_CHILDREN).count();
    },
    startCapture: () => clickCaptureButton(PANEL_NAMES.startCapture),
    stopCapture: () => clickCaptureButton(PANEL_NAMES.stopCapture),
    async closeDevtools() {
      await page.evaluate(disconnectEmulatedDevtools);
    },
    consoleErrors: () => [...errors],
    header,
    connectionPill,
    captureControls: header.getByRole('button', {
      name: new RegExp(
        `^(${escapeRegExp(PANEL_NAMES.startCapture)}|${escapeRegExp(PANEL_NAMES.stopCapture)})$`,
      ),
    }),
    main,
    sessionSummary: main.getByRole('region', { name: PANEL_NAMES.sessionSummary, exact: true }),
    panelView,
    eventDetails: page.getByRole('complementary', { name: PANEL_NAMES.eventDetails, exact: true }),
    liveTail: page.getByRole('region', { name: PANEL_NAMES.liveTail, exact: true }),
    pairDialog: page.getByRole('dialog'),
  };
}

// ---------------------------------------------------------------------------
// Pairing (the devtools credential is minted at runtime)
// ---------------------------------------------------------------------------

/**
 * Pair through the panel's own `PairDialog`: `POST /pair/start` with the
 * editor credential yields the one-time code, which is typed into the dialog;
 * the service worker then calls `POST /pair/complete` from its
 * `chrome-extension://` origin and stores the devtools credential. This
 * process never calls `/pair/complete` itself — a devtools credential minted
 * from any other origin would be refused (AAP §0.5.6).
 */
function createPairing(harness: ExtensionHarness, service: ServiceHandle): PairingHandle {
  let memo: Promise<void> | undefined;

  const pairOnce = async (): Promise<void> => {
    const dialled = originOf(DEFAULT_SERVICE_BASE_URL);
    if (originOf(service.baseUrl) !== dialled) {
      throw new Error(
        `The extension's service worker only dials ${String(dialled)} (DEFAULT_SERVICE_BASE_URL), but the suite's service listens on ${service.baseUrl}. Run the browser suite with DEBUGGEN_HOST/DEBUGGEN_PORT naming ${String(dialled)}, or the worker can neither pair nor connect.`,
      );
    }
    const panel = await openPanel(harness, {
      inspectedTabId: undefined,
      inspectedUrl: undefined,
      themeName: 'dark',
      installDevtoolsStub: false,
      announceDevtools: false,
      initScripts: [],
    });
    try {
      // Let the pill settle: a stored credential either connects, or is
      // refused by the service (a rotated token, a fresh DEBUGGEN_HOME) and
      // cleared by the worker, which shows as "not paired".
      let settledOn: PanelConnectionStatus | undefined;
      await pollFor(
        async () => {
          settledOn = await panel.connectionStatus();
          return settledOn === 'connected' || settledOn === 'not-paired' ? true : undefined;
        },
        PAIRING_TIMEOUT_MS,
        () =>
          `The panel's connection pill did not settle on "${PANEL_CONNECTION_LABELS.connected}" or "${PANEL_CONNECTION_LABELS['not-paired']}" within ${String(PAIRING_TIMEOUT_MS)} ms; it reads ${settledOn === undefined ? 'nothing recognisable' : `"${PANEL_CONNECTION_LABELS[settledOn]}"`}${settledOn === 'service-not-running' ? ` — nothing answers ${String(dialled)} from Chromium` : ''}.`,
      );
      if (settledOn === 'connected' && (await hasStoredCredential(harness))) {
        return;
      }
      if (await hasStoredCredential(harness)) {
        await removeWorkerStorage(await harness.liveWorker(), 'local', DEVTOOLS_TOKEN_STORAGE_KEY);
        await panel.waitForNotPaired({ timeoutMs: PAIRING_TIMEOUT_MS });
      }

      const { code } = await service.pairStart();
      if (!(await panel.pairDialog.isVisible())) {
        await panel.header.locator('button[aria-haspopup="dialog"]').click();
      }
      const codeInput = panel.pairDialog.getByRole('textbox');
      await codeInput.fill(code);
      await codeInput.press('Enter');

      try {
        await panel.waitForConnected({ timeoutMs: PAIRING_TIMEOUT_MS });
      } catch {
        const status = await panel.connectionStatus();
        const dialogOpen = await panel.pairDialog.isVisible();
        const dialogText = dialogOpen
          ? ((await panel.pairDialog.textContent()) ?? '').replace(/\s+/g, ' ').trim()
          : '';
        const reason =
          status === 'service-not-running'
            ? `service unreachable: the worker reports "${PANEL_CONNECTION_LABELS[status]}" — nothing answers ${String(dialled)} from Chromium`
            : dialogOpen
              ? `code rejected: the pairing dialog is still open and reads "${dialogText}"`
              : `worker not connected: the pill reads "${status === undefined ? 'nothing recognisable' : PANEL_CONNECTION_LABELS[status]}" after the code was accepted`;
        throw new Error(
          `Pairing the extension did not reach "${PANEL_CONNECTION_LABELS.connected}" within ${String(PAIRING_TIMEOUT_MS)} ms (${reason}).${panel.consoleErrors().length === 0 ? '' : ` Panel errors: ${panel.consoleErrors().join(' | ')}`}`,
        );
      }
      if (!(await hasStoredCredential(harness))) {
        throw new Error(
          `The panel reports "${PANEL_CONNECTION_LABELS.connected}" but no devtools credential is stored under ${DEVTOOLS_TOKEN_STORAGE_KEY}.`,
        );
      }
    } finally {
      await panel.page.close().catch(() => undefined);
    }
  };

  return {
    async ensurePaired() {
      if (memo !== undefined) {
        try {
          await memo;
          if (await hasStoredCredential(harness)) {
            return;
          }
        } catch {
          // Fall through and pair again.
        }
        memo = undefined;
      }
      const attempt = pairOnce();
      memo = attempt;
      try {
        await attempt;
      } catch (error) {
        memo = undefined;
        throw error;
      }
    },
    async unpair() {
      memo = undefined;
      await removeWorkerStorage(await harness.liveWorker(), 'local', DEVTOOLS_TOKEN_STORAGE_KEY);
    },
    isPaired: () => hasStoredCredential(harness),
  };
}

// ---------------------------------------------------------------------------
// Sessions (tracked and ended in teardown)
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES: readonly SessionStatus[] = ['ended', 'failed'];

function createSessionHelper(
  service: ServiceHandle,
  editor: EditorClient,
  fixtureApp: FixtureAppHandle,
): SessionHelper & { dispose(): Promise<string[]> } {
  const createdIds: string[] = [];
  const ended = new Set<string>();

  /** The newest status the editor connection reported for `id`, if any. */
  const pushedStatus = (id: string): SessionRecord | undefined => {
    const updates = editor
      .all('session.updated')
      .filter((message) => message.payload.session.id === id);
    return updates.at(-1)?.payload.session;
  };

  const progressOf = (id: string): string => {
    const rows = editor
      .all('session.progress')
      .filter((message) => message.payload.sessionId === id)
      .map(
        (message) =>
          `${message.payload.stage}:${message.payload.status} ${message.payload.message}`,
      );
    return rows.length === 0 ? 'no progress rows' : rows.slice(-8).join(' | ');
  };

  const waitForStatus = async (
    id: string,
    status: SessionStatus | readonly SessionStatus[],
    options?: WaitOptions,
  ): Promise<SessionRecord> => {
    const wanted: readonly SessionStatus[] = typeof status === 'string' ? [status] : status;
    const timeoutMs = options?.timeoutMs ?? SESSION_READY_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let latest: SessionRecord | undefined;
    for (;;) {
      latest = pushedStatus(id) ?? latest;
      if (latest === undefined || !wanted.includes(latest.status)) {
        latest = await service.getSession(id);
      }
      if (wanted.includes(latest.status)) {
        return latest;
      }
      if (TERMINAL_STATUSES.includes(latest.status)) {
        throw new Error(
          `Session ${id} reached ${latest.status} while waiting for ${wanted.join(' or ')} (progress: ${progressOf(id)}).`,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Session ${id} did not reach ${wanted.join(' or ')} within ${String(timeoutMs)} ms; it is ${latest.status} (progress: ${progressOf(id)}).`,
        );
      }
      // Woken by the next pushed frame; the GET above is the backstop.
      await editor.next(Math.min(remaining, POLL_INTERVAL_MS * 4));
    }
  };

  return {
    async create(question, options) {
      await fixtureApp.ensureServing();
      const record = await service.createSession({
        projectRoot: fixtureApp.projectRoot,
        question,
        ...(options?.target === undefined ? {} : { target: options.target }),
      });
      createdIds.push(record.id);
      return record;
    },
    waitForStatus,
    waitForReady: (id, options) =>
      waitForStatus(id, 'ready', { timeoutMs: options?.timeoutMs ?? SESSION_READY_TIMEOUT_MS }),
    async capture(id, action, options) {
      const { captureId } = await service.startCapture(id);
      try {
        await action();
        await delay(options?.settleMs ?? CAPTURE_SETTLE_MS);
      } catch (error) {
        await service.stopCapture(id).catch(() => undefined);
        throw error;
      }
      const stopped = await service.stopCapture(id);
      return { captureId, summary: stopped.summary };
    },
    async end(id) {
      const result = await service.endSession(id);
      ended.add(id);
      return result;
    },
    created: () => [...createdIds],
    async dispose() {
      const problems: string[] = [];
      for (const id of createdIds) {
        if (ended.has(id)) {
          continue;
        }
        try {
          const record = await service.getSession(id);
          if (record.status === 'capturing') {
            await service.stopCapture(id).catch(() => undefined);
          }
          if (record.status !== 'ended') {
            await service.endSession(id);
          }
          ended.add(id);
        } catch (error) {
          problems.push(`session ${id}: ${describeError(error)}`);
        }
      }
      return problems;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Worker-scoped: `workers: 1` and `fullyParallel: false` share one browser, one service and one `DEBUGGEN_HOME` across the run. */
export interface WorkerFixtures extends DebuggenTestOptions {
  /** Where the context came from and how its worker was found. */
  extensionLaunch: ExtensionLaunchInfo;
  /** The persistent Chromium context with the unpacked extension loaded. */
  extensionContext: BrowserContext;
  /** The extension id, read from the MV3 worker's URL. */
  extensionId: string;
  /** The MV3 service worker as it was registered at launch. */
  serviceWorker: Worker;
  /** The running local service. */
  service: ServiceHandle;
  /** The fixture app, served through the service. */
  fixtureApp: FixtureAppHandle;
  /** The one-time pairing of the extension, memoised. */
  pairing: PairingHandle;
  /** Internal: the browser harness behind the four fixtures above. */
  _extension: ExtensionHarness;
}

/** Test-scoped fixtures. */
export interface TestFixtures {
  /** A fresh tab on the fixture app's `/`, closed on teardown. */
  appPage: Page;
  /** Open the panel document as an extension page (closed on teardown); inspects `appPage` by default. */
  openPanelPage: (options?: OpenPanelOptions) => Promise<PanelHandle>;
  /** An editor-role observer connected for this test, announcing the fixture app's root. */
  editorClient: EditorClient;
  /** Session helpers; every session created is ended on teardown. */
  sessions: SessionHelper;
  /** Clear the worker's persisted tab bindings, keeping the paired credential. */
  resetExtensionState: () => Promise<void>;
  /** Internal: per-test hygiene — the binding snapshot is cleared after every test. */
  _hygiene: undefined;
}

/** Record a teardown problem on the test instead of throwing over its own result. */
function reportTeardown(
  testInfo: { annotations: { type: string; description?: string }[] },
  problems: readonly string[],
): void {
  for (const description of problems) {
    testInfo.annotations.push({ type: 'fixture-teardown', description });
  }
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // Options the Playwright config's `use` block supplies (`DebuggenTestOptions`).
  extensionPath: ['', { option: true, scope: 'worker' }],
  serviceUrl: ['', { option: true, scope: 'worker' }],
  demoUrl: ['', { option: true, scope: 'worker' }],
  fixtureAppUrl: ['', { option: true, scope: 'worker' }],

  _extension: [
    async ({ extensionPath, headless, channel, launchOptions }, use, workerInfo) => {
      const harness = await launchExtension(
        extensionPath,
        { headless, channel, launchOptions },
        workerInfo,
      );
      try {
        await use(harness);
      } finally {
        await harness.dispose();
      }
    },
    { scope: 'worker', timeout: 60_000 },
  ],

  extensionLaunch: [
    async ({ _extension }, use) => {
      await use(_extension.info);
    },
    { scope: 'worker' },
  ],

  extensionContext: [
    async ({ _extension }, use) => {
      await use(_extension.context);
    },
    { scope: 'worker' },
  ],

  extensionId: [
    async ({ _extension }, use) => {
      await use(_extension.extensionId);
    },
    { scope: 'worker' },
  ],

  serviceWorker: [
    async ({ _extension }, use) => {
      await use(_extension.serviceWorker);
    },
    { scope: 'worker' },
  ],

  service: [
    async ({ serviceUrl }, use) => {
      await use(await createServiceHandle(resolveServiceUrl(serviceUrl), resolveDebuggenHome()));
    },
    { scope: 'worker', timeout: SERVICE_READY_TIMEOUT_MS * 3 },
  ],

  fixtureApp: [
    async ({ service, fixtureAppUrl }, use) => {
      const state = await serveFixtureApp(service, fixtureAppUrl);
      try {
        await use(state.handle);
      } finally {
        const problems = await state.dispose();
        for (const problem of problems) {
          process.stderr.write(`[tests/browser/fixtures] fixture app teardown: ${problem}\n`);
        }
      }
    },
    { scope: 'worker', timeout: INSTALL_TIMEOUT_MS + APP_READY_TIMEOUT_MS * 2 },
  ],

  pairing: [
    async ({ _extension, service }, use) => {
      await use(createPairing(_extension, service));
    },
    { scope: 'worker' },
  ],

  appPage: async ({ extensionContext, fixtureApp }, use) => {
    const page = await extensionContext.newPage();
    try {
      await page.goto(new URL('/', fixtureApp.baseUrl).toString(), {
        timeout: APP_READY_TIMEOUT_MS,
      });
      await use(page);
    } finally {
      await page.close().catch(() => undefined);
    }
  },

  openPanelPage: async ({ _extension, appPage }, use) => {
    const opened: PanelHandle[] = [];
    await use(async (options) => {
      const inspect = options?.inspect ?? appPage;
      const installDevtoolsStub = options?.installDevtoolsStub ?? true;
      const inspectedTabId =
        options?.tabId ??
        (installDevtoolsStub ? await tabIdOf(await _extension.liveWorker(), inspect) : undefined);
      const handle = await openPanel(_extension, {
        inspectedTabId,
        inspectedUrl: options?.tabId === undefined ? inspect.url() : undefined,
        themeName: options?.themeName ?? 'dark',
        installDevtoolsStub,
        announceDevtools: installDevtoolsStub && (options?.announceDevtools ?? true),
        initScripts: options?.initScripts ?? [],
      });
      opened.push(handle);
      return handle;
    });
    for (const handle of opened) {
      await handle.page.close().catch(() => undefined);
    }
  },

  editorClient: async ({ service, fixtureApp }, use) => {
    const client = await service.connectEditor(fixtureApp.projectRoot);
    try {
      await use(client);
    } finally {
      client.clear();
      client.close();
    }
  },

  sessions: async ({ service, editorClient, fixtureApp }, use, testInfo) => {
    const helper = createSessionHelper(service, editorClient, fixtureApp);
    await use(helper);
    reportTeardown(testInfo, await helper.dispose());
  },

  resetExtensionState: async ({ _extension }, use) => {
    await use(() => clearBindings(_extension));
  },

  _hygiene: [
    async ({ _extension }, use, testInfo) => {
      await use(undefined);
      try {
        await clearBindings(_extension);
      } catch (error) {
        reportTeardown(testInfo, [`binding reset: ${describeError(error)}`]);
      }
    },
    { auto: true },
  ],
});
