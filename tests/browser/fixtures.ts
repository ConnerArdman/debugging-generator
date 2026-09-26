/**
 * Shared Playwright fixtures for the `browser` project.
 *
 * Every spec under `tests/browser/**` that drives the browser imports `test`
 * and `expect` from this module (`fixture-lifecycle.spec.ts`, which exercises
 * the pure lifecycle helpers exported here, imports `@playwright/test`
 * directly so that the automatic `_hygiene` fixture launches no Chromium),
 * and nothing else owns the suite's lifecycle: one persistent Chromium
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
 * ## Fixture lifecycle and constraints
 *
 * - **A private copy per worker.** The fixture app's `next.config.ts` pins
 *   `turbopack.root` to its own directory, so its dependencies must be
 *   installed inside it: another workspace's `next` binary cannot serve it in
 *   place ("Could not find the Next.js package"), and Next would then run
 *   `pnpm install` against the repository lockfile. Each worker serves a
 *   private copy outside the repository,
 *   `<realpath(mkdtemp(<os tmpdir>/debuggen-browser-fixture-))>/sample-next-app`:
 *   a fresh `0700` boundary owned by this account and verified with
 *   `assertSecureDir`, which {@link copyFixtureTree} fills before the copy's
 *   dependencies are installed. Every directory and file is created through a
 *   held, verified directory descriptor (`pinPrivateFileWithinRoot`), never by
 *   path — no-follow reads, exclusive no-follow creates, symlinked or special
 *   entries refused, realpath containment checked — so a directory swapped for
 *   a link mid-copy cannot redirect a write. The tracked fixture tree is only
 *   read, nothing is shared between runs or workers, and teardown removes the
 *   whole boundary once the server has stopped and verifies it is gone.
 * - **Launched through the service.** The service learns a dev server's
 *   address only from its own launcher (`resolveDevServerUrl` in
 *   `apps/local-service/src/server/routes/sessions.ts`: the launcher's
 *   registry, else an earlier session of the same root, else
 *   `DEV_SERVER_UNAVAILABLE`), and `POST /dev-server/launch` carries no URL.
 *   The copy is therefore launched by the service with an explicit command
 *   pinning the served origin's port and hostname, and the launcher attaches
 *   the telemetry preload as it does for any project.
 * - **Served on an origin of its own.** Only a server this worker launched for
 *   its own fresh root can serve its sessions, and adopting another run's
 *   leftover root would take over — and stop — a server this worker does not
 *   own, so nothing is reused. The configured origin (`fixtureAppUrl`) is
 *   identified with two bounded `GET`s (`/` and `/api/ping`) as `none`,
 *   `fixture` or `foreign` ({@link identifyFixtureOrigin}). An occupied origin
 *   — by the fixture app or anything else — is never launched against,
 *   stopped or sent anything more: the worker serves its copy on an alternate
 *   loopback origin (a port the OS reports free, identified as `none` before
 *   use, up to three attempts), noted once on stderr and in
 *   `fixtureApp.displaced`. `fixtureApp.baseUrl` is always the origin actually
 *   served ({@link planFixtureServing}, {@link serveFixtureApp}). A service
 *   without the launcher routes (`404` to a no-op `devServer.stop`) gets a
 *   copy spawned directly without the preload, and `sessions.create()` then
 *   refuses at once with the reason, since the service cannot attribute that
 *   server.
 * - **Diagnostics never quote a server.** Every sentence built from a
 *   response names only its status, its media type and whether the ping
 *   honoured the fixture contract ({@link describeMediaType}); bodies are read,
 *   bounded, for that check alone, and no header value is printed.
 * - **Teardown is an oracle.** No fixture swallows a teardown failure. Test-
 *   scoped fixtures (`sessions`, `appPage`, `openPanelPage`, `_hygiene`) hand
 *   their problems to {@link settleTestTeardown}: a test that passed fails
 *   with them, a test that already failed carries them as `fixture-teardown`
 *   annotations. The `sessions` helper requires every session it created to
 *   end with cleanup `clean`, and stops any capture left open. Worker-scoped
 *   fixtures (`fixtureApp`, `_extension`) throw one aggregated error: the
 *   server this worker started must stop answering its origin, the Chromium
 *   context must report closing and its profile directory must be gone, and
 *   the private copy must be removed.
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
 *   has no other way (such as a `?tabId=` parameter) to learn its tab.
 * - **Pairing** drives the panel's own `PairDialog`, typing only the pairing
 *   code: the dialog's service address field stays at
 *   `DEFAULT_SERVICE_BASE_URL`, so pairing is refused with an explanation when
 *   the suite's service listens elsewhere.
 * - **Panel accessible names.** `PANEL_NAMES` types the capture button,
 *   session summary, event drawer, live tail, pairing-code field and
 *   capture-notice names, and the renderer's `.dg-panel` block class is typed
 *   too, because their owning modules keep them private and a React component
 *   module cannot be evaluated in Node without React and its CSS. The
 *   connection pill's wording is imported from
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
 * Constraints: no credential is written, logged or assembled here — tokens are
 * read from `auth.json` or minted by pairing at runtime; only fixture-app
 * vocabulary appears; helpers expose real observations (service messages,
 * worker storage, panel state); the service runs with the deterministic
 * provider and nothing leaves localhost.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { lstat, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, expect, test as base } from '@playwright/test';
import type {
  BrowserContext,
  LaunchOptions,
  Locator,
  Page,
  TestInfo,
  Worker,
  WorkerInfo,
} from '@playwright/test';

import {
  HttpClient,
  isCompatibleProtocolVersion,
  isMessageOfType,
  ReconnectingWsClient,
  SESSION_LIST_MAX_LIMIT,
} from '@debuggen/protocol';
import type {
  CleanupStatus,
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
  SessionListItem,
  SessionRecord,
  SessionStatus,
  SourceResultPayload,
  WsUnauthorizedDetail,
} from '@debuggen/protocol';
import type { DebuggenError, Result } from '@debuggen/shared';
import {
  assertSecureDir,
  isSameFileIdentity,
  pinPrivateFileWithinRoot,
  readFileNoFollow,
  SECURE_DIR_MODE,
  SECURE_FILE_MODE,
} from '@debuggen/shared/node';
import type { FileIdentity, PinnedFile } from '@debuggen/shared/node';
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

/** Longest single diagnostic (a teardown problem, a foreign server's description) kept in an error or annotation. */
const MAX_DIAGNOSTIC_CHARS = 2_000;

/** How many teardown problems one aggregated error or annotation set lists before it summarises the rest. */
const MAX_REPORTED_PROBLEMS = 20;

/** Bound on one teardown `session.end`, which awaits the whole instrumentation cleanup. */
const SESSION_END_TIMEOUT_MS = 60_000;

/** Window in which teardown retries a `SESSION_INVALID_STATE` answer to `session.end` while another operation of the session settles. */
const SESSION_END_SETTLE_MS = 30_000;

/** Bound on one identification request to the fixture origin: a running fixture app's first request may compile the route. */
const IDENTIFY_TIMEOUT_MS = 30_000;

/** Bound on the response body an identification request reads — for the contract check only, never quoted. */
const MAX_PROBE_BODY_BYTES = 64 * 1024;

/** How many free ports are tried for a worker-owned alternate origin before serving fails (each one is identified first). */
const ALTERNATE_PORT_ATTEMPTS = 3;

/** The lowest port an alternate origin may use: never a privileged one. */
const MIN_ALTERNATE_PORT = 1024;

/** Bound on the no-op `devServer.stop` that tells whether the service has the launcher routes. */
const ROUTE_PROBE_TIMEOUT_MS = 10_000;

/** How long a stopped fixture server has to stop answering its origin (the launcher's grace is 5 s before `SIGKILL`). */
const SERVER_STOP_TIMEOUT_MS = 15_000;

/** Bound on each probe while waiting for the origin to go quiet. */
const QUIET_PROBE_TIMEOUT_MS = 2_000;

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

/** The product's default service origin, used when `DEBUGGEN_HOST` / `DEBUGGEN_PORT` are unset. */
const DEFAULT_SERVICE_HOST = '127.0.0.1';
const DEFAULT_SERVICE_PORT = '43117';

/** The fixture app's own default (`next dev --port 3100` in its `package.json`). */
const DEFAULT_FIXTURE_APP_URL = 'http://localhost:3100';

/** The editor credential file inside `$DEBUGGEN_HOME` (`AUTH_FILE_NAME`, `apps/local-service/src/config.ts`). */
const EDITOR_CREDENTIAL_FILE = 'auth.json';

/** Build output and dependencies of the fixture app — exactly the entries its own `.gitignore` covers. */
const FIXTURE_GENERATED_ENTRIES = new Set(['node_modules', '.next', 'next-env.d.ts']);

/** Prefix of the private, per-worker `mkdtemp` directory the fixture copy lives in. */
const FIXTURE_BOUNDARY_PREFIX = 'debuggen-browser-fixture-';

/** The copy's own directory name inside that boundary: the fixture's basename, which Next and the service see. */
const FIXTURE_COPY_DIR_NAME = 'sample-next-app';

/** The fixture app's contract route: `GET /api/ping` answers `{ reply: string }` after a short delay. */
const FIXTURE_PING_PATH = '/api/ping';

/** The renderer's panel block and its body (`PANEL_CLASS`, `BODY_CLASS` in `packages/panel-renderer/src/host/PanelHost.tsx`). */
const RENDERED_PANEL_SELECTOR = '.dg-panel';
const RENDERED_PANEL_BODY_CHILDREN = '.dg-panel__body > *';

/**
 * Accessible names the panel renders from module-private constants (not
 * exported, and their `.tsx` modules cannot be evaluated in Node; see header):
 * `START_CAPTURE_LABEL` / `STOP_CAPTURE_LABEL` in `CaptureControls.tsx`,
 * `SUMMARY_TITLE` in `SessionSummary.tsx`, `DRAWER_LABEL` /
 * `LIVE_TAIL_REGION_LABEL` in `App.tsx`, `PAIRING_FIELD_LABEL` in
 * `PairDialog.tsx` — the dialog also holds a "Service address" field, so the
 * code field is addressed by its name rather than as the dialog's only textbox —
 * and `NOTICES_LABEL` / `NOTICE_LABELS['page-reloaded']` in `LiveTail.tsx`: the
 * name of the live tail's capture-notices list and the badge wording of the
 * entry a same-origin reload during a capture adds to it.
 */
const PANEL_NAMES = Object.freeze({
  startCapture: 'Start capture',
  stopCapture: 'Stop capture',
  sessionSummary: 'Session',
  eventDetails: 'Selected event',
  liveTail: 'Live event tail',
  pairingCode: 'Pairing code',
  captureNotices: 'Capture notices, newest first',
  pageReloadedNotice: 'Page reloaded during capture',
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
  /**
   * Answer a `source.open` the service forwarded to this connection the way
   * VS Code does: a `source.result` whose `ref` is the forwarded frame's id and
   * whose session is the forward's. The service relays the answer to the
   * DevTools sender under the sender's own `ref`; a forward nobody answers is
   * settled `failed` once the service's editor deadline passes, so a spec that
   * expects a click to succeed answers it. Throws when the frame could not be
   * written.
   */
  answerSourceOpen(forwarded: RecordedMessage<'source.open'>, answer?: SourceOpenAnswer): void;
  /** Close the socket; the service releases this connection's workspace announcement. */
  close(): void;
}

/** `Omit` applied to each member of a union, so the discriminant survives. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * What an editor reports about a forwarded `source.open` — `opened`, or
 * `failed` with its error. `no-editor` is the service's own answer, which an
 * editor may not send.
 */
export type SourceOpenAnswer = DistributiveOmit<
  Exclude<SourceResultPayload, { readonly status: 'no-editor' }>,
  'sessionId' | 'ref'
>;

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
  /** Every page of `GET /sessions` (`nextOffset` walked until `null`): list rows, most recently updated first. */
  listSessions(): Promise<readonly SessionListItem[]>;
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

/**
 * How this worker's fixture app came to be served — always by this worker:
 *
 * - `service-launcher` — the service's launcher started this worker's private
 *   copy (preload attached); this worker stops it through `devServer.stop`.
 * - `fixture-process` — the service has no launcher route, so this file spawned
 *   `next dev` for the copy (no preload) and terminates it. The service cannot
 *   attribute such a server to the copy, so no session can be created for it
 *   (`sessions.create()` says so at once).
 *
 * A server this worker did not start is never adopted: an occupied configured
 * origin is left alone and the copy is served on an alternate origin instead
 * (see {@link planFixtureServing} for why reuse cannot work).
 */
export type FixtureAppServer = 'service-launcher' | 'fixture-process';

/** What occupied the configured origin when this worker served its copy elsewhere. */
export interface FixtureAppDisplacement {
  /** Whether the occupant honoured the fixture contract (`GET /api/ping` → `{ reply: string }`). */
  readonly occupant: 'fixture' | 'foreign';
  /** The occupant's identification: status, media type and contract verdict per request — never a body or header value. */
  readonly description: string;
}

/** The generic fixture app, served from a private per-worker copy outside the repository. */
export interface FixtureAppHandle {
  /**
   * The origin the app actually answers on: the configured one when it was
   * free, else this worker's alternate loopback origin. Specs navigate here.
   */
  readonly baseUrl: string;
  /** The configured origin (`fixtureAppUrl`), whether or not it is the one served. */
  readonly configuredUrl: string;
  /** `undefined` when the configured origin was free; otherwise what occupied it (never touched). */
  readonly displaced: FixtureAppDisplacement | undefined;
  /** The private copy (`<mkdtemp boundary>/sample-next-app`) — the root the service records on every session. */
  readonly projectRoot: string;
  /** The tracked fixture directory the copy was taken from (`tests/fixtures/sample-next-app`). */
  readonly sourceRoot: string;
  /**
   * Always `true`: this worker started the server serving {@link baseUrl},
   * directly or through the launcher, and stops it at teardown. A server it
   * did not start is never adopted (it is {@link displaced} instead).
   */
  readonly startedByFixture: true;
  /** Who started the process serving {@link baseUrl}. */
  readonly servedBy: FixtureAppServer;
  /**
   * Make sure the app still serves `projectRoot` on {@link baseUrl}, per
   * {@link servedBy}: the launcher is asked again (it reuses its ready child
   * and restarts it if ending a session stopped it); a spawned child must
   * still be alive and answering.
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
  /**
   * The live tail's capture-notices list, newest first. The panel renders it
   * only while the tail is expanded and the capture on screen has a notice.
   */
  readonly captureNotices: Locator;
  /**
   * The entries of {@link PanelHandle.captureNotices} whose badge reads
   * "Page reloaded during capture" — one per same-origin reload of the bound
   * tab while a capture was running, which the same capture continues across.
   */
  readonly pageReloadedNotices: Locator;
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

/**
 * Session helpers that track every session they create and end it in
 * teardown. Teardown is an oracle, not a courtesy: every session must end with
 * cleanup `clean`, and anything else — a capture that could not be stopped, an
 * end that was refused, a `partial` or `conflict` cleanup — fails a passing
 * test (see {@link settleTestTeardown}).
 */
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
  /**
   * `capture.start` → `action` → settle → `capture.stop`. When `action` throws,
   * the capture is still stopped and the action's error is rethrown; a stop
   * that fails then is recorded as a teardown problem, never ignored.
   */
  capture(
    id: string,
    action: () => Promise<void>,
    options?: CaptureOptions,
  ): Promise<CaptureOutcome>;
  /** `session.end`; a returned cleanup status other than `clean` is recorded as a teardown problem. */
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

/** `text` cut to `max` characters, with a marker naming how much was dropped. */
function boundDiagnostic(text: string, max = MAX_DIAGNOSTIC_CHARS): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}… [${String(text.length - max)} more characters]`;
}

/** A bounded bullet list of problems: each one truncated, at most {@link MAX_REPORTED_PROBLEMS} listed. */
function formatProblems(problems: readonly string[]): string {
  const listed = problems
    .slice(0, MAX_REPORTED_PROBLEMS)
    .map((problem) => `- ${boundDiagnostic(problem)}`);
  const rest = problems.length - listed.length;
  return [...listed, ...(rest > 0 ? [`- (+${String(rest)} more)`] : [])].join('\n');
}

/**
 * `error` with the problems a cleanup found while handling it appended, the
 * original kept as `cause` — so a failed cleanup after a failed step is
 * reported alongside that failure instead of replacing it or being dropped.
 */
function errorWithProblems(error: unknown, context: string, problems: readonly string[]): Error {
  if (problems.length === 0) {
    return error instanceof Error ? error : new Error(describeError(error));
  }
  return new Error(`${describeError(error)}\n${context}:\n${formatProblems(problems)}`, {
    cause: error,
  });
}

/** Throw one aggregated error when a teardown found problems (the worker-scoped fixtures' contract). */
function throwIfProblems(subject: string, problems: readonly string[]): void {
  if (problems.length > 0) {
    throw new Error(
      `${subject} teardown found ${String(problems.length)} problem(s):\n${formatProblems(problems)}`,
    );
  }
}

/** The part of Playwright's `TestInfo` a test-scoped teardown reads and writes. */
export type TeardownTestInfo = Pick<TestInfo, 'status' | 'expectedStatus' | 'annotations'>;

/**
 * Report the problems a test-scoped fixture's teardown found, without ever
 * swallowing them.
 *
 * - The test ended as expected (`status === expectedStatus`, a pass in
 *   practice): one aggregated error is thrown, which Playwright records as a
 *   failure of that test — a leaked capture, an unclean cleanup or a page that
 *   would not close fails the run instead of passing it.
 * - The test already failed: each problem becomes a `fixture-teardown`
 *   annotation, so the original error stays the reported one and the leak is
 *   still visible next to it.
 *
 * Every message is bounded ({@link boundDiagnostic}, {@link MAX_REPORTED_PROBLEMS}).
 *
 * @param testInfo The running test's info (`status` is set once the body finished).
 * @param subject The fixture whose teardown found the problems, for example `sessions`.
 * @param problems One sentence per problem; nothing happens when empty.
 * @throws When there are problems and the test ended as expected.
 */
export function settleTestTeardown(
  testInfo: TeardownTestInfo,
  subject: string,
  problems: readonly string[],
): void {
  if (problems.length === 0) {
    return;
  }
  if (testInfo.status === testInfo.expectedStatus) {
    throwIfProblems(subject, problems);
  }
  for (const problem of problems.slice(0, MAX_REPORTED_PROBLEMS)) {
    testInfo.annotations.push({
      type: 'fixture-teardown',
      description: `${subject}: ${boundDiagnostic(problem)}`,
    });
  }
  if (problems.length > MAX_REPORTED_PROBLEMS) {
    testInfo.annotations.push({
      type: 'fixture-teardown',
      description: `${subject}: (+${String(problems.length - MAX_REPORTED_PROBLEMS)} more problem(s))`,
    });
  }
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
    answerSourceOpen(forwarded, answer = { status: 'opened' }) {
      const sent = client.send('source.result', {
        ...answer,
        sessionId: forwarded.payload.sessionId,
        ref: forwarded.id,
      });
      if (!sent.ok) {
        throw new Error(
          `The editor connection could not answer source.open ${forwarded.id}: ${sent.error.code} (connection ${live.state}).`,
        );
      }
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

/** The window one `GET /sessions` page request of {@link collectSessionList} carries. */
interface SessionListWindow {
  /** {@link SESSION_LIST_MAX_LIMIT}, the largest page the listing serves. */
  readonly limit: number;
  /** `0`, then each page's `nextOffset`. */
  readonly offset: number;
}

/**
 * Every row of `GET /sessions`: requests pages from offset `0` at
 * {@link SESSION_LIST_MAX_LIMIT}, follows `nextOffset` until it is `null`, and
 * answers the pages' rows concatenated, most recently updated first.
 *
 * The service may leave out a stored row it counts but cannot read or may not
 * show, and still move past it, so the rows number at most `total`. The protocol
 * client already refuses a page that breaks the paging rule; these checks fail
 * loudly, naming the offsets, where a broken or moving list would otherwise loop
 * or pass part of itself off as the whole: each page echoes its requested
 * offset, `total` holds across pages, no session id repeats (the order shifted
 * under the walk, so another row may have been skipped), `nextOffset` advances,
 * and the walk ends within `max(1, total)` pages — every page before the last
 * starts at a distinct offset below `total`.
 *
 * @param fetchPage Fetches one page; a refusal is thrown as a {@link ServiceCallError}.
 * @returns Every row the service answered, in its order.
 * @throws {Error} When the list breaks any rule above.
 */
async function collectSessionList(
  fetchPage: (window: SessionListWindow) => Promise<HttpResponseBody<'session.list'>>,
): Promise<readonly SessionListItem[]> {
  const rows: SessionListItem[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let total: number | undefined;
  let pages = 0;
  for (;;) {
    const page = await fetchPage({ limit: SESSION_LIST_MAX_LIMIT, offset });
    pages += 1;
    if (page.offset !== offset) {
      throw new Error(
        `session.list echoed offset ${String(page.offset)} for a request at offset ${String(offset)}.`,
      );
    }
    if (total === undefined) {
      total = page.total;
    } else if (page.total !== total) {
      throw new Error(
        `session.list total changed from ${String(total)} to ${String(page.total)} on page ${String(pages)} (offset ${String(offset)}) — sessions were created or removed while paging; read the list again once it has settled.`,
      );
    }
    for (const row of page.sessions) {
      if (seen.has(row.id)) {
        throw new Error(
          `session.list answered session ${row.id} again on page ${String(pages)} (offset ${String(offset)}) — the list's order shifted while paging, so another row may have been skipped; read the list again once it has settled.`,
        );
      }
      seen.add(row.id);
      rows.push(row);
    }
    if (page.nextOffset === null) {
      break;
    }
    if (page.nextOffset <= offset) {
      throw new Error(
        `session.list nextOffset ${String(page.nextOffset)} does not advance past offset ${String(offset)}.`,
      );
    }
    if (pages >= Math.max(1, total)) {
      throw new Error(
        `session.list was still paging after ${String(pages)} page(s) of ${String(total)} session(s) (nextOffset ${String(page.nextOffset)}); every page before the last starts at a distinct offset below total, so the service's paging is broken.`,
      );
    }
    offset = page.nextOffset;
  }
  if (rows.length > total) {
    throw new Error(
      `session.list answered ${String(rows.length)} row(s) over ${String(pages)} page(s) but counts ${String(total)}; it may leave a row out, never add one.`,
    );
  }
  return rows;
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
    listSessions() {
      return collectSessionList(async (query) =>
        unwrap('session.list', await call('session.list', { query })),
      );
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

/** The `code` of a Node.js system error (`ENOENT`, `EEXIST`, …), if `error` carries one. */
function errnoCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

/** Whether absolute `child` is `parent` itself or lies below it, compared lexically. */
function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** Whether absolute `child` lies strictly below `parent`. */
function isStrictlyWithin(parent: string, child: string): boolean {
  return child !== parent && isWithin(parent, child);
}

/**
 * Allocate the private boundary one worker's fixture copy lives in: a fresh
 * `mkdtemp` directory under the OS temp directory — unpredictably named and
 * created `0700` by this account — resolved with `realpath`, so every later
 * containment check compares canonical paths, and verified with
 * `assertSecureDir` (a real directory, not a link, owned by this uid, no group
 * or other access). Nothing is ever shared between runs or workers.
 *
 * @returns The boundary's canonical absolute path.
 * @throws When the directory cannot be created or fails the check (it is removed first).
 */
export async function allocateFixtureBoundary(): Promise<string> {
  const boundary = await realpath(await mkdtemp(path.join(os.tmpdir(), FIXTURE_BOUNDARY_PREFIX)));
  try {
    assertSecureDir(boundary);
  } catch (error) {
    const problems: string[] = [];
    try {
      await removeFixtureBoundary(boundary);
    } catch (removeError) {
      problems.push(describeError(removeError));
    }
    throw errorWithProblems(
      error,
      `Removing the refused boundary ${boundary} also failed`,
      problems,
    );
  }
  return boundary;
}

/**
 * Delete a boundary {@link allocateFixtureBoundary} created, with everything
 * in it, and prove it is gone. `rm` removes a link found inside rather than
 * following it; the name check refuses any path this module did not allocate.
 *
 * @param boundary The boundary to delete.
 * @throws When the path is not a fixture boundary, or still exists (or cannot
 * be inspected) after the removal.
 */
export async function removeFixtureBoundary(boundary: string): Promise<void> {
  const boundaryAbs = path.resolve(boundary);
  if (!path.basename(boundaryAbs).startsWith(FIXTURE_BOUNDARY_PREFIX)) {
    throw new Error(
      `removeFixtureBoundary refuses ${boundaryAbs}: only a boundary allocateFixtureBoundary() created (named ${FIXTURE_BOUNDARY_PREFIX}*) is removed.`,
    );
  }
  await rm(boundaryAbs, { recursive: true, force: true });
  try {
    await lstat(boundaryAbs);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return;
    }
    throw new Error(
      `The private fixture copy ${boundaryAbs} could not be confirmed removed: ${describeError(error)}`,
      { cause: error },
    );
  }
  throw new Error(`The private fixture copy ${boundaryAbs} still exists after it was removed.`);
}

/**
 * The seams of {@link copyFixtureTree}, for a test that attacks the copy in the
 * exact window a path-based copy would lose: production passes none.
 */
export interface CopyFixtureTreeHooks {
  /**
   * Runs after the directory that will hold an entry was pinned (its
   * descriptor is held and its identity verified) and before the entry is
   * created in it.
   *
   * @param relativePath The entry, POSIX and relative to the target root (`.` for the root itself).
   * @param kind What is about to be created there.
   */
  readonly afterPin?: ((relativePath: string, kind: 'directory' | 'file') => void) | undefined;
}

/** This account's uid, or `undefined` on a platform without one. */
function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/**
 * A refusal that explains `error` and keeps its errno `code` (`EEXIST` for a
 * planted entry, for example), with the original as `cause`.
 */
function copyRefusal(message: string, error: unknown): Error {
  const refusal = new Error(`${message}: ${describeError(error)}`, { cause: error });
  const code = errnoCode(error);
  return code === undefined ? refusal : Object.assign(refusal, { code });
}

/**
 * Pin the chain of directories that holds `relativePath` below `root`
 * (`pinPrivateFileWithinRoot`: `root` opened `O_DIRECTORY | O_NOFOLLOW`, every
 * component below it relative to its parent's descriptor, each descriptor held
 * to the private policy — a directory owned by this account with no group or
 * other access).
 *
 * @param label The entry's logical path, for the refusal.
 * @throws When the chain cannot be pinned, and when the platform cannot
 * address a descriptor as a path: a degraded pin would detect a swapped
 * directory only after the write, so the copy is refused instead.
 */
function pinForCopy(root: string, relativePath: string, label: string): PinnedFile {
  let pinned: PinnedFile;
  try {
    pinned = pinPrivateFileWithinRoot(root, relativePath);
  } catch (error) {
    throw copyRefusal(
      `The fixture copy refuses ${label}: the directories that would hold it could not be pinned (a symbolic link, a foreign or group/other-accessible directory, or a missing one)`,
      error,
    );
  }
  if (!pinned.enforced) {
    pinned.release();
    throw new Error(
      `The fixture copy refuses ${label}: this platform cannot address an open directory descriptor as a path (no /proc/self/fd), so the copy cannot be pinned against a directory swapped between its check and its write. The browser suite runs on Linux.`,
    );
  }
  return pinned;
}

/**
 * Create the directory `pinned` names, fresh, inside the pinned parent: any
 * existing entry — a planted link or directory included — is a refusal, never
 * reused or followed. The new directory is then opened `O_NOFOLLOW`, checked
 * to be a directory owned by this account, set to exactly `0700` through its
 * descriptor (whatever the umask), and its identity returned.
 */
function createPinnedDirectory(pinned: PinnedFile, label: string): FileIdentity {
  try {
    mkdirSync(pinned.path, { mode: SECURE_DIR_MODE });
  } catch (error) {
    throw copyRefusal(
      `The fixture copy refuses ${label}: the directory could not be created fresh (an existing entry is never reused, followed or overwritten)`,
      error,
    );
  }
  let fd: number;
  try {
    fd = openSync(
      pinned.path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    throw copyRefusal(
      `The fixture copy refuses ${label}: the directory it just created was replaced before it could be opened`,
      error,
    );
  }
  try {
    const stats = fstatSync(fd, { bigint: true });
    const uid = currentUid();
    if (!stats.isDirectory() || (uid !== undefined && stats.uid !== BigInt(uid))) {
      throw new Error(
        `The fixture copy refuses ${label}: the entry it just created is not a directory owned by this account.`,
      );
    }
    fchmodSync(fd, SECURE_DIR_MODE);
    return { dev: stats.dev, ino: stats.ino };
  } finally {
    closeSync(fd);
  }
}

/**
 * Create the file `pinned` names inside the pinned parent with
 * `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` at `0600` (set exactly through the
 * descriptor), write every byte, `fsync` and close. An existing entry — a
 * planted link included — is `EEXIST`, and its target is left untouched.
 */
function createPinnedFile(pinned: PinnedFile, bytes: string | Uint8Array, label: string): void {
  let fd: number;
  try {
    fd = openSync(
      pinned.path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      SECURE_FILE_MODE,
    );
  } catch (error) {
    throw copyRefusal(
      `The fixture copy refuses ${label}: the file could not be created exclusively (an existing entry, a planted link included, is never followed or overwritten)`,
      error,
    );
  }
  try {
    fchmodSync(fd, SECURE_FILE_MODE);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * After a create through `pinned`: the directory's path must still name the
 * pinned inode. The entry itself landed in the pinned directory whatever
 * happened to the path — never outside — but a swapped directory means the
 * copy is no longer the tree its paths describe, so it is refused.
 */
function requirePinnedDirectoryIntact(pinned: PinnedFile, label: string): void {
  if (!pinned.verifyDirectory()) {
    throw new Error(
      `The fixture copy refuses ${label}: the directory holding it was moved or replaced while the entry was created. The entry landed in the pinned directory, not outside it, but the copy can no longer be trusted.`,
    );
  }
}

/** What every level of one {@link copyFixtureTree} walk shares. */
interface FixtureCopyWalk {
  /** The logical target root, for diagnostics. */
  readonly targetRoot: string;
  /**
   * The target root addressed through the held descriptor of its parent
   * (`/proc/self/fd/<n>/<name>`): every entry is pinned from here, so no
   * change to the paths above the target root reaches the walk.
   */
  readonly anchor: string;
  readonly hooks: CopyFixtureTreeHooks | undefined;
}

/**
 * Create one entry of the copy: pin its parent chain from the walk's anchor,
 * require the pinned parent to be the very directory this copy created for it
 * (`parentIdentity`), let the hook run, create the entry through the
 * descriptor and require the parent's path to still name it afterwards.
 */
function createCopyEntry<T>(
  walk: FixtureCopyWalk,
  parentIdentity: FileIdentity,
  relativePath: string,
  kind: 'directory' | 'file',
  create: (pinned: PinnedFile, label: string) => T,
): T {
  const label = path.join(walk.targetRoot, ...relativePath.split('/'));
  const pinned = pinForCopy(walk.anchor, relativePath, label);
  try {
    if (!isSameFileIdentity(pinned.directoryIdentity, parentIdentity)) {
      throw new Error(
        `copyFixtureTree refuses ${label}: the directory that would hold it is no longer the one this copy created for it (it was replaced after it was created).`,
      );
    }
    walk.hooks?.afterPin?.(relativePath, kind);
    const created = create(pinned, label);
    requirePinnedDirectoryIntact(pinned, label);
    return created;
  } finally {
    pinned.release();
  }
}

/** Copy one directory level; see {@link copyFixtureTree} for the rules. */
async function copyFixtureDirectory(
  walk: FixtureCopyWalk,
  sourceDir: string,
  relativeDir: string,
  identity: FileIdentity,
): Promise<void> {
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (FIXTURE_GENERATED_ENTRIES.has(entry.name) || entry.name.endsWith('.tsbuildinfo')) {
      continue;
    }
    const source = path.join(sourceDir, entry.name);
    const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error(
        `copyFixtureTree refuses the symbolic link ${source}: a fixture copy never follows or reproduces a link.`,
      );
    }
    if (entry.isDirectory()) {
      const created = createCopyEntry(walk, identity, relativePath, 'directory', (pinned, label) =>
        createPinnedDirectory(pinned, label),
      );
      await copyFixtureDirectory(walk, source, relativePath, created);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `copyFixtureTree refuses ${source}: it is neither a regular file nor a directory.`,
      );
    }
    if (relativeDir === '' && entry.name === 'package.json') {
      // Written separately from the rewritten manifest (`copyManifest`).
      continue;
    }
    const bytes = readFileNoFollow(source);
    createCopyEntry(walk, identity, relativePath, 'file', (pinned, label) => {
      createPinnedFile(pinned, bytes, label);
    });
  }
}

/**
 * Copy the tracked fixture tree `sourceRoot` to `targetRoot`, a fresh path
 * inside the private `boundary` ({@link allocateFixtureBoundary}), without ever
 * following or overwriting anything — and without a check/use window a
 * process of this account could exploit by swapping a directory (CWE-22,
 * CWE-367):
 *
 * - the chain from the boundary to the target root's parent is pinned once
 *   (`pinPrivateFileWithinRoot`: no-follow, descriptor-relative, every
 *   descriptor held to the private policy) and held for the whole copy; the
 *   target root is created in it and must not exist yet;
 * - every entry below is created through descriptors, never through a path:
 *   its parent chain is pinned from that held descriptor, the pinned parent
 *   must be the very directory inode this copy created, and the entry is then
 *   made in it — a directory with `mkdir` at `0700`, a file with
 *   `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` at `0600`, written in full and
 *   `fsync`ed. An existing entry (a planted link or file) is a refusal
 *   (`EEXIST`) and its target is left byte-for-byte untouched;
 * - after each create the parent's path must still name the pinned inode: a
 *   directory swapped for a link mid-copy received the entry in the pinned
 *   inode (never outside), and the copy is refused;
 * - the pin must be enforced (`/proc/self/fd`); where it cannot be, the copy
 *   is refused rather than run with a detect-only pin;
 * - source entries are read with `lstat` semantics (`readdir` with file types),
 *   and a symbolic link or any entry that is neither a regular file nor a
 *   directory is refused, so a link's target can never be imported; each file
 *   is read `O_NOFOLLOW` (`readFileNoFollow`);
 * - the fixture's generated entries (`node_modules`, `.next`, `next-env.d.ts`,
 *   `*.tsbuildinfo`) are skipped, and so is the root `package.json`, which the
 *   caller writes from `copyManifest()` through the same pinned create
 *   ({@link writeFixtureCopyFile});
 * - finally the canonical `targetRoot` must still lie inside the canonical
 *   boundary.
 *
 * @param sourceRoot The tracked tree to copy; must be a real directory.
 * @param targetRoot Where the copy goes; must lie strictly inside `boundary`,
 * below a parent that already exists there, and must not exist itself.
 * @param boundary The private directory that owns the copy.
 * @param hooks Test seams ({@link CopyFixtureTreeHooks}); production passes none.
 * @throws On the first refused entry or unsafe path. What was already copied
 * stays inside the boundary; nothing outside it is written.
 */
export async function copyFixtureTree(
  sourceRoot: string,
  targetRoot: string,
  boundary: string,
  hooks?: CopyFixtureTreeHooks,
): Promise<void> {
  const sourceAbs = path.resolve(sourceRoot);
  const targetAbs = path.resolve(targetRoot);
  const boundaryAbs = path.resolve(boundary);
  if (!isStrictlyWithin(boundaryAbs, targetAbs)) {
    throw new Error(
      `copyFixtureTree: the target ${targetAbs} does not lie inside its boundary ${boundaryAbs}.`,
    );
  }
  assertSecureDir(boundaryAbs);
  const sourceStats = await lstat(sourceAbs);
  if (!sourceStats.isDirectory()) {
    throw new Error(
      `copyFixtureTree: the source ${sourceAbs} is not a real directory (a symbolic link or a file is refused).`,
    );
  }
  const rootPin = pinForCopy(boundaryAbs, path.relative(boundaryAbs, targetAbs), targetAbs);
  try {
    hooks?.afterPin?.('.', 'directory');
    const rootIdentity = createPinnedDirectory(rootPin, targetAbs);
    requirePinnedDirectoryIntact(rootPin, targetAbs);
    await copyFixtureDirectory(
      { targetRoot: targetAbs, anchor: rootPin.path, hooks },
      sourceAbs,
      '',
      rootIdentity,
    );
  } finally {
    rootPin.release();
  }
  const [realBoundary, realTarget] = await Promise.all([
    realpath(boundaryAbs),
    realpath(targetAbs),
  ]);
  if (!isStrictlyWithin(realBoundary, realTarget)) {
    throw new Error(
      `copyFixtureTree: the copy resolved to ${realTarget}, outside its boundary ${realBoundary}.`,
    );
  }
}

/**
 * Write one file of a fixture copy that {@link copyFixtureTree} leaves to its
 * caller (the rewritten manifest), through the same pinned create: the chain
 * from `boundary` down is pinned and held, the file is made
 * `O_CREAT | O_EXCL | O_NOFOLLOW` at `0600` through the held descriptor, and
 * the directory's path must still name the pinned inode afterwards.
 *
 * @param boundary The copy's private boundary.
 * @param relativePath The file, POSIX and relative to `boundary` (for example `sample-next-app/package.json`).
 * @param bytes The content, written in full and `fsync`ed.
 * @throws On an existing entry (`EEXIST`), an unpinnable chain, a degraded pin or a swapped directory.
 */
function writeFixtureCopyFile(
  boundary: string,
  relativePath: string,
  bytes: string | Uint8Array,
): void {
  const label = path.join(boundary, ...relativePath.split('/'));
  const pinned = pinForCopy(boundary, relativePath, label);
  try {
    createPinnedFile(pinned, bytes, label);
    requirePinnedDirectoryIntact(pinned, label);
  } finally {
    pinned.release();
  }
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

/** One worker's private copy of the fixture app. */
export interface FixtureAppCopy {
  /** The copy's root, `<boundary>/sample-next-app` — the project root the service records. */
  readonly root: string;
  /** The private `mkdtemp` directory that owns the copy; the only thing `remove()` deletes. */
  readonly boundary: string;
  /** Delete the boundary with everything in it and verify it is gone; throws when it is not. */
  remove(): Promise<void>;
}

/**
 * Prepare this worker's private copy of the fixture app: allocate a fresh
 * boundary, copy the tracked tree into `<boundary>/sample-next-app`
 * ({@link copyFixtureTree}), write the rewritten manifest with the same pinned,
 * exclusive, no-follow create ({@link writeFixtureCopyFile}), and install its
 * dependencies there — always, since the copy is new (never into the
 * repository). Nothing survives the worker: the caller removes the copy after
 * its server stopped, and a failure here removes it before the error is
 * rethrown.
 *
 * @returns The copy and its removal.
 */
export async function prepareFixtureAppCopy(): Promise<FixtureAppCopy> {
  const boundary = await allocateFixtureBoundary();
  const root = path.join(boundary, FIXTURE_COPY_DIR_NAME);
  try {
    await copyFixtureTree(FIXTURE_SOURCE_ROOT, root, boundary);
    writeFixtureCopyFile(boundary, `${FIXTURE_COPY_DIR_NAME}/package.json`, await copyManifest());
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
    if (!existsSync(path.join(root, 'node_modules', 'next', 'package.json'))) {
      throw new Error(
        `Installing the fixture app's dependencies into ${root} exited 0 but left no node_modules/next. Output:\n${installed.output}`,
      );
    }
  } catch (error) {
    const problems: string[] = [];
    try {
      await removeFixtureBoundary(boundary);
    } catch (removeError) {
      problems.push(describeError(removeError));
    }
    throw errorWithProblems(
      error,
      'Removing the private fixture copy after that failure also failed',
      problems,
    );
  }
  return { root, boundary, remove: () => removeFixtureBoundary(boundary) };
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
 *
 * Its errors are body-free like every diagnostic here: the last status of `/`,
 * and for the ping its status, media type and contract verdict
 * ({@link describeProbe}) — never the reply itself, whatever it carries.
 *
 * @param baseUrl The origin this worker serves its copy on.
 * @param diagnostics This worker's own account of its server (a spawned child's output, or where the launcher logs it).
 * @throws When `/` does not answer 200 in time, or the ping does not honour `{ reply: string }`.
 */
export async function waitForFixtureApp(baseUrl: string, diagnostics: () => string): Promise<void> {
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
  const ping = await probeOrigin(
    new URL(FIXTURE_PING_PATH, baseUrl).toString(),
    APP_READY_TIMEOUT_MS,
  );
  if (!(ping.kind === 'answered' && ping.status === 200 && isFixturePingReply(ping.body))) {
    throw new Error(
      `The server at ${baseUrl} is not the sample-next-app fixture: GET ${FIXTURE_PING_PATH} ${describeProbe(ping)}, which does not honour the fixture contract { reply: string }. Something other than this worker's copy answers that origin: free the port or set FIXTURE_APP_URL to another one. ${diagnostics()}`,
    );
  }
}

/** What one bounded `GET` of an origin observed. */
type OriginProbe =
  /** A connection-level failure (refused, reset, unresolvable): nothing serves the origin. */
  | { readonly kind: 'unreachable'; readonly reason: string }
  /** Something accepted the request but did not answer within the bound. */
  | { readonly kind: 'stalled'; readonly reason: string }
  /**
   * An HTTP answer. `body` holds at most {@link MAX_PROBE_BODY_BYTES} and is
   * read for the fixture-contract check only: no diagnostic ever quotes it,
   * nor any header value ({@link describeProbe}).
   */
  | {
      readonly kind: 'answered';
      readonly status: number;
      readonly contentType: string | null;
      readonly body: string;
    };

/** Whether a fetch failure is its `AbortSignal.timeout` firing rather than a connection failure. */
function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** At most `maxBytes` of a response body as UTF-8; the rest is cancelled unread. */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const kept = value.subarray(0, maxBytes - total);
      chunks.push(kept);
      total += kept.byteLength;
      if (total >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One bounded `GET url` — no redirect followed — classified (see
 * {@link OriginProbe}); never throws. A connection failure is reported by its
 * error code alone (`ECONNREFUSED`), never by a message that could echo what
 * the peer sent; an unreadable body reads as empty, which fails the contract.
 */
async function probeOrigin(url: string, timeoutMs: number): Promise<OriginProbe> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  } catch (error) {
    if (isTimeoutError(error)) {
      return {
        kind: 'stalled',
        reason: `accepted the connection but did not answer within ${String(timeoutMs)} ms`,
      };
    }
    const cause: unknown = error instanceof Error ? error.cause : undefined;
    return {
      kind: 'unreachable',
      reason:
        errnoCode(cause) ??
        errnoCode(error) ??
        (error instanceof Error ? error.name : 'an unknown failure'),
    };
  }
  let body: string;
  try {
    body = await readBoundedText(response, MAX_PROBE_BODY_BYTES);
  } catch {
    body = '';
  }
  return {
    kind: 'answered',
    status: response.status,
    contentType: response.headers.get('content-type'),
    body,
  };
}

/** A media type (`type/subtype`) in the character set RFC 6838 allows — the only shape a diagnostic prints. */
const PRINTABLE_MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

/** Longest media type a diagnostic prints. */
const MAX_PRINTED_MEDIA_TYPE_CHARS = 100;

/**
 * A `Content-Type` header reduced to what a diagnostic may print: the media
 * type before any `;`, lowercased, and only when it has the RFC 6838 shape and
 * at most {@link MAX_PRINTED_MEDIA_TYPE_CHARS} characters — otherwise
 * `an unrecognised content type`. Parameters (a `charset`, or whatever else a
 * server put there) are never printed.
 *
 * @example
 * ```ts
 * describeMediaType('Text/HTML; charset=utf-8'); // 'text/html'
 * describeMediaType('text/html; x=<secret>'); // 'text/html'
 * describeMediaType('not a media type'); // 'an unrecognised content type'
 * ```
 */
export function describeMediaType(header: string | null): string {
  if (header === null || header.trim() === '') {
    return 'no content type';
  }
  const media = (header.split(';', 1)[0] ?? '').trim().toLowerCase();
  return media.length <= MAX_PRINTED_MEDIA_TYPE_CHARS && PRINTABLE_MEDIA_TYPE.test(media)
    ? media
    : 'an unrecognised content type';
}

/**
 * One probe in a sentence for a diagnostic: the status and the media type
 * ({@link describeMediaType}), or how the connection failed — never a body, a
 * header value or a `Content-Type` parameter, so nothing a server returns
 * (a token in an error page, a header) can reach a Playwright or CI log.
 */
function describeProbe(probe: OriginProbe): string {
  switch (probe.kind) {
    case 'unreachable':
      return `failed at the connection level (${probe.reason})`;
    case 'stalled':
      return probe.reason;
    case 'answered':
      return `answered ${String(probe.status)} (${describeMediaType(probe.contentType)})`;
  }
}

/** Whether a `GET /api/ping` body is the fixture contract's `{ reply: string }`. */
function isFixturePingReply(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) && typeof parsed.reply === 'string';
  } catch {
    return false;
  }
}

/** Who answers an origin before this worker does anything about it. */
export type FixtureOriginIdentity =
  /** Nothing listens there. */
  | { readonly kind: 'none' }
  /** A server that honours the fixture contract (`GET /api/ping` → `{ reply: string }`), described without its bodies. */
  | { readonly kind: 'fixture'; readonly description: string }
  /** Something else, described without its bodies. */
  | { readonly kind: 'foreign'; readonly description: string };

/**
 * Identify what serves `origin` with at most two bounded `GET`s — `/`, then
 * the contract route `GET /api/ping` — and nothing else: no other path, no
 * other method, no redirect followed. Nothing answering `/` at the connection
 * level is `none`; otherwise the fixture contract decides between `fixture`
 * and `foreign`.
 *
 * The description names each request's status and media type and whether the
 * ping honoured the contract, and nothing else: bodies are read, bounded, for
 * the contract check only, and no header value or `Content-Type` parameter is
 * printed, so a secret an occupant returns never reaches a log.
 *
 * @param origin An `http(s)` origin, for example `http://127.0.0.1:3100`.
 * @returns What answers it; never throws for a failed request.
 */
export async function identifyFixtureOrigin(origin: string): Promise<FixtureOriginIdentity> {
  const root = await probeOrigin(new URL('/', origin).toString(), IDENTIFY_TIMEOUT_MS);
  if (root.kind === 'unreachable') {
    return { kind: 'none' };
  }
  const ping = await probeOrigin(
    new URL(FIXTURE_PING_PATH, origin).toString(),
    IDENTIFY_TIMEOUT_MS,
  );
  const honoured = ping.kind === 'answered' && ping.status === 200 && isFixturePingReply(ping.body);
  const description = `GET / ${describeProbe(root)}; GET ${FIXTURE_PING_PATH} ${describeProbe(ping)}, which ${honoured ? 'honours' : 'does not honour'} the fixture contract { reply: string }`;
  return honoured ? { kind: 'fixture', description } : { kind: 'foreign', description };
}

/** Whether the running service serves the dev-server launcher routes; `unknown` until probed. */
export type LauncherRoutes = 'present' | 'missing' | 'unknown';

/**
 * Which origin this worker serves its private copy on: the configured one when
 * nothing answers it, else an alternate loopback origin of its own. The
 * occupant — the fixture app or anything else — is never launched against,
 * stopped or sent anything beyond its two identification `GET`s.
 */
export type FixtureServingTarget =
  | { readonly origin: 'configured' }
  | { readonly origin: 'alternate'; readonly occupant: 'fixture' | 'foreign' };

/** Where and how this worker serves the fixture app — the decision {@link planFixtureServing} makes before anything is launched. */
export type FixtureServingPlan =
  /** Probe the service's launcher routes first (a no-op `devServer.stop`), then plan again. */
  | { readonly target: FixtureServingTarget; readonly action: 'probe-launcher-routes' }
  /** Have the service's launcher start the private copy on the target origin. */
  | {
      readonly target: FixtureServingTarget;
      readonly action: 'launch';
      readonly servedBy: 'service-launcher';
    }
  /** The service cannot launch: spawn `next dev` for the copy on the target origin directly. */
  | {
      readonly target: FixtureServingTarget;
      readonly action: 'spawn';
      readonly servedBy: 'fixture-process';
    };

/**
 * Decide, purely, where and how this worker serves its private copy — before
 * any launch, spawn or stop.
 *
 * | configured origin     | launcher routes | target                   | action                                    |
 * |-----------------------|-----------------|--------------------------|-------------------------------------------|
 * | `none`                | `unknown`       | configured               | probe the routes                          |
 * | `none`                | `present`       | configured               | launch through the service (`service-launcher`) |
 * | `none`                | `missing`       | configured               | spawn directly (`fixture-process`)        |
 * | `fixture` / `foreign` | `unknown`       | alternate, occupant named | probe the routes                         |
 * | `fixture` / `foreign` | `present`       | alternate, occupant named | launch through the service              |
 * | `fixture` / `foreign` | `missing`       | alternate, occupant named | spawn directly                          |
 *
 * An occupied origin is never reused, even when it is the fixture app, because
 * reuse cannot work and cannot be safe. The service attributes a session's dev
 * server only from its launcher's registry for that project root, or from an
 * earlier session of the same root (`resolveDevServerUrl` in
 * `apps/local-service/src/server/routes/sessions.ts`); this worker's root is a
 * fresh private copy, so a server it did not launch for that copy can never be
 * attributed to it, and every session would be refused. Adopting the root of
 * another run's leftover server instead would take over — and at teardown
 * stop — a server this worker does not own.
 *
 * @param configured What answers the configured origin ({@link FixtureOriginIdentity}).
 * @param launcherRoutes Whether the service serves `devServer.launch`/`devServer.stop`.
 * @returns The plan.
 */
export function planFixtureServing(
  configured: FixtureOriginIdentity,
  launcherRoutes: LauncherRoutes,
): FixtureServingPlan {
  const target: FixtureServingTarget =
    configured.kind === 'none'
      ? { origin: 'configured' }
      : { origin: 'alternate', occupant: configured.kind };
  switch (launcherRoutes) {
    case 'unknown':
      return { target, action: 'probe-launcher-routes' };
    case 'present':
      return { target, action: 'launch', servedBy: 'service-launcher' };
    case 'missing':
      return { target, action: 'spawn', servedBy: 'fixture-process' };
  }
}

/** Whether a failed dev-server call means the route itself is absent (an older service), not a refusal by a present route. */
function isRouteMissing(error: DebuggenError): boolean {
  return statusOf(error) === 404 && error.code !== 'PROJECT_NOT_FOUND';
}

/**
 * Whether the service serves the launcher routes, without side effects: a
 * `devServer.stop` for `projectRoot` — the private copy just created, which the
 * service has never seen — answers `{ stopped: false }` when the route exists
 * and `404` when it does not. The route acts only inside a workspace an editor
 * connection announced, and that announcement is recorded asynchronously, so a
 * `PATH_OUTSIDE_PROJECT` refusal is retried within {@link ANNOUNCEMENT_SETTLE_MS}.
 *
 * @throws On any other failure, or when the probe unexpectedly stopped a server.
 */
async function probeLauncherRoutes(
  service: ServiceHandle,
  projectRoot: string,
): Promise<'present' | 'missing'> {
  const retryUntil = Date.now() + ANNOUNCEMENT_SETTLE_MS;
  for (;;) {
    const result = await service.call('devServer.stop', {
      body: { projectRoot },
      timeoutMs: ROUTE_PROBE_TIMEOUT_MS,
    });
    if (result.ok) {
      if (result.value.stopped) {
        throw new Error(
          `Probing the service's launcher with devServer.stop for ${projectRoot}, a root created moments ago, stopped a dev server: the service was not expected to know that root. Check that no other process shares this worker's temp directory.`,
        );
      }
      return 'present';
    }
    if (isRouteMissing(result.error)) {
      return 'missing';
    }
    if (result.error.code !== 'PATH_OUTSIDE_PROJECT' || Date.now() >= retryUntil) {
      throw new Error(
        `Probing the service's dev-server launcher (a no-op devServer.stop for the fresh copy ${projectRoot}) failed: ${new ServiceCallError('devServer.stop', result.error).message}`,
      );
    }
    await delay(POLL_INTERVAL_MS);
  }
}

/**
 * Wait until nothing answers `origin` at the connection level.
 *
 * @returns `undefined` once quiet, else the last probe's body-free description when `timeoutMs` ran out.
 */
async function originStillAnswering(
  origin: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const root = new URL('/', origin).toString();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = await probeOrigin(root, QUIET_PROBE_TIMEOUT_MS);
    if (probe.kind === 'unreachable') {
      return undefined;
    }
    if (Date.now() >= deadline) {
      return describeProbe(probe);
    }
    await delay(POLL_INTERVAL_MS);
  }
}

/** A URL's hostname as `node:net` expects it: an IPv6 literal without its brackets. */
function listenHost(url: URL): string {
  const { hostname } = url;
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Ask the OS for a port nobody holds on `host`: listen on port `0`, read the
 * port it assigned, close the listener. The port is free when this resolves,
 * not reserved — the caller identifies the origin again before using it.
 */
function findFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ port: 0, host, exclusive: true }, () => {
      const address = server.address();
      server.close((closeError) => {
        if (closeError !== undefined) {
          reject(closeError);
          return;
        }
        if (address === null || typeof address === 'string') {
          reject(new Error(`Listening on ${host} port 0 reported no TCP port.`));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

/**
 * Allocate this worker's own origin beside an occupied configured one: the
 * same scheme and hostname, on a port the OS reports free
 * ({@link findFreePort}), which must not be privileged and must then identify
 * as `none` — nothing answers it. A port something else took in between is
 * retried, up to {@link ALTERNATE_PORT_ATTEMPTS} times. The occupant is not
 * contacted.
 *
 * @param configured The configured fixture URL, whose origin is occupied.
 * @returns The alternate origin, as a URL.
 * @throws When the OS offers a privileged port, or every candidate was answered by something.
 */
async function allocateAlternateOrigin(configured: URL): Promise<URL> {
  const host = listenHost(configured);
  const taken: string[] = [];
  for (let attempt = 1; attempt <= ALTERNATE_PORT_ATTEMPTS; attempt += 1) {
    const port = await findFreePort(host);
    if (port < MIN_ALTERNATE_PORT) {
      throw new Error(
        `The OS offered the privileged port ${String(port)} on ${host} for the fixture app's alternate origin; the browser fixtures never serve below port ${String(MIN_ALTERNATE_PORT)}. Check the host's local port range, or free the configured origin ${configured.origin}.`,
      );
    }
    const candidate = new URL(configured.origin);
    candidate.port = String(port);
    const identity = await identifyFixtureOrigin(candidate.origin);
    if (identity.kind === 'none') {
      return new URL(candidate.origin);
    }
    taken.push(
      `${candidate.origin} was answered by the time it was identified (${identity.description})`,
    );
  }
  throw new Error(
    `No alternate origin for the fixture app could be allocated on ${host} in ${String(ALTERNATE_PORT_ATTEMPTS)} attempts, because the configured origin ${configured.origin} is occupied: ${taken.join('; ')}. Free ${configured.origin} or set FIXTURE_APP_URL to a free port.`,
  );
}

/**
 * The one stderr line a displaced worker writes: the configured origin, what
 * occupies it (body-free, {@link identifyFixtureOrigin}) and the origin served
 * instead.
 */
function displacementNotice(
  configuredOrigin: string,
  servedOrigin: string,
  displaced: FixtureAppDisplacement,
): string {
  const who =
    displaced.occupant === 'fixture'
      ? 'a sample-next-app fixture this worker did not start'
      : 'a server that is not the sample-next-app fixture';
  return `[tests/browser/fixtures] ${configuredOrigin} (FIXTURE_APP_URL) is occupied by ${who} (${displaced.description}); it is left untouched, and this worker serves its own copy on ${servedOrigin} instead.\n`;
}

/** The launcher command for the copy: `next dev` pinned to `url`'s port and hostname (the preload and credential arrive through the child's environment). */
function launchCommand(url: URL): string {
  return `NEXT_TELEMETRY_DISABLED=1 "${process.execPath}" node_modules/next/dist/bin/next dev --port ${String(portOf(url))} --hostname ${url.hostname}`;
}

/** The worker-scoped state behind {@link FixtureAppHandle}, as {@link serveFixtureApp} returns it. */
export interface FixtureAppState {
  readonly handle: FixtureAppHandle;
  /**
   * Stop the server this worker started — only that one: an occupant of the
   * configured origin is never stopped or probed — and verify the served
   * origin went quiet, close the anchor connection, then remove the private
   * copy; every step attempted even when an earlier one failed.
   *
   * @returns One sentence per problem; empty when everything was released.
   */
  dispose(): Promise<string[]>;
}

/**
 * Serve the fixture app for this worker, on an origin it owns. Whatever
 * answers the configured origin is never launched against, stopped or sent
 * anything beyond the two identification `GET`s ({@link planFixtureServing}):
 *
 * 1. identify what answers the configured origin (`none`, `fixture` or `foreign`);
 * 2. prepare the private copy and open the anchor editor connection that
 *    announces it (the launch route and every session route act only inside
 *    an announced workspace; the anchor lives as long as the worker);
 * 3. probe the launcher routes with a no-op `devServer.stop`, then plan;
 * 4. choose the origin: the configured one when nothing answers it, else an
 *    alternate loopback origin ({@link allocateAlternateOrigin}), announced by
 *    one body-free stderr notice;
 * 5. launch through the service with an explicit command pinning that origin's
 *    port and hostname — the launcher's `devServerUrl` must be that origin —
 *    or, when the service has no launcher routes, spawn `next dev` there;
 * 6. wait for the app to answer and honour its contract.
 *
 * A failure at any step releases what was set up before the error is rethrown.
 *
 * @param service The running service.
 * @param configuredUrl The configured fixture URL (`fixtureAppUrl`); empty for the fixture's default.
 * @returns The handle and its release.
 */
export async function serveFixtureApp(
  service: ServiceHandle,
  configuredUrl: string,
): Promise<FixtureAppState> {
  const configured = new URL(nonEmptyOption(configuredUrl) ?? DEFAULT_FIXTURE_APP_URL);
  const configuredOrigin = configured.origin;

  const occupant = await identifyFixtureOrigin(configuredOrigin);
  const displaced: FixtureAppDisplacement | undefined =
    occupant.kind === 'none'
      ? undefined
      : { occupant: occupant.kind, description: occupant.description };

  const copy = await prepareFixtureAppCopy();
  const projectRoot = copy.root;

  /** What this worker owns right now; `release()` undoes exactly this. */
  const owned: {
    anchor: EditorClient | undefined;
    /** The origin this worker launched or spawned on — never the occupied configured one. */
    served: URL | undefined;
    launchRequested: boolean;
    spawned: SpawnedServer | undefined;
  } = { anchor: undefined, served: undefined, launchRequested: false, spawned: undefined };

  const launch = async (url: URL): Promise<'served' | 'route-missing'> => {
    owned.launchRequested = true;
    const result = await service.call('devServer.launch', {
      body: { projectRoot, command: launchCommand(url) },
      timeoutMs: APP_READY_TIMEOUT_MS,
    });
    if (!result.ok) {
      if (isRouteMissing(result.error)) {
        owned.launchRequested = false;
        return 'route-missing';
      }
      throw new Error(
        `${new ServiceCallError('devServer.launch', result.error).message}. The dev server's own output is in the service log.`,
      );
    }
    if (originOf(result.value.devServerUrl) !== url.origin) {
      throw new Error(
        `The service launched the fixture app at ${result.value.devServerUrl}, not at the chosen ${url.origin}; the tab would never bind to the session. Check that nothing else took that port.`,
      );
    }
    return 'served';
  };

  const spawnedDiagnostics = (): string =>
    owned.spawned === undefined ? '' : `Dev server output:\n${owned.spawned.output()}`;
  const launcherDiagnostics = (): string =>
    'The dev server was launched by the service; its output is in the service log.';

  const release = async (): Promise<string[]> => {
    const problems: string[] = [];
    const served = owned.served;
    if (owned.launchRequested) {
      owned.launchRequested = false;
      const stopped = await service.call('devServer.stop', {
        body: { projectRoot },
        timeoutMs: SERVER_STOP_TIMEOUT_MS,
      });
      if (!stopped.ok) {
        problems.push(
          `stopping the service-launched fixture app failed: ${new ServiceCallError('devServer.stop', stopped.error).message}`,
        );
      }
      if (served !== undefined) {
        const answering = await originStillAnswering(served.origin, SERVER_STOP_TIMEOUT_MS);
        if (answering !== undefined) {
          problems.push(
            `${served.origin} still answers ${String(SERVER_STOP_TIMEOUT_MS)} ms after devServer.stop (GET / ${answering}): the launcher's dev server leaked`,
          );
        }
      }
    }
    const spawned = owned.spawned;
    if (spawned !== undefined) {
      owned.spawned = undefined;
      try {
        await terminateSpawned(spawned);
      } catch (error) {
        problems.push(`terminating the spawned fixture app failed: ${describeError(error)}`);
      }
      if (spawned.child.exitCode === null && spawned.child.signalCode === null) {
        problems.push(
          `the spawned fixture app (pid ${String(spawned.child.pid)}) is still running after SIGTERM and SIGKILL of its process group`,
        );
      }
      if (served !== undefined) {
        const answering = await originStillAnswering(served.origin, SERVER_STOP_TIMEOUT_MS);
        if (answering !== undefined) {
          problems.push(
            `${served.origin} still answers ${String(SERVER_STOP_TIMEOUT_MS)} ms after the spawned fixture app was terminated (GET / ${answering})`,
          );
        }
      }
    }
    const anchor = owned.anchor;
    if (anchor !== undefined) {
      owned.anchor = undefined;
      try {
        anchor.close();
      } catch (error) {
        problems.push(`closing the anchor editor connection failed: ${describeError(error)}`);
      }
    }
    // Last, so the copy is removed only after its server was stopped.
    try {
      await copy.remove();
    } catch (error) {
      problems.push(describeError(error));
    }
    return problems;
  };

  let servedBy: FixtureAppServer;
  let served: URL;
  try {
    owned.anchor = await service.connectEditor(projectRoot);
    const plan = planFixtureServing(occupant, await probeLauncherRoutes(service, projectRoot));
    if (plan.action === 'probe-launcher-routes') {
      throw new Error(
        'planFixtureServing asked for a launcher probe after one ran; the plan cannot be settled.',
      );
    }
    served =
      plan.target.origin === 'configured'
        ? new URL(configuredOrigin)
        : await allocateAlternateOrigin(configured);
    owned.served = served;
    if (displaced !== undefined) {
      process.stderr.write(displacementNotice(configuredOrigin, served.origin, displaced));
    }
    if (plan.action === 'launch' && (await launch(served)) === 'served') {
      servedBy = plan.servedBy;
      await waitForFixtureApp(served.origin, launcherDiagnostics);
    } else {
      // No launcher routes — or they vanished between the probe and the launch.
      servedBy = 'fixture-process';
      owned.spawned = spawnFixtureAppServer(projectRoot, served);
      await waitForFixtureApp(served.origin, spawnedDiagnostics);
    }
  } catch (error) {
    throw errorWithProblems(
      error,
      'Releasing what this worker had set up for the fixture app also failed',
      await release(),
    );
  }

  const servedUrl = served;
  const ensureServing = async (): Promise<void> => {
    switch (servedBy) {
      case 'service-launcher':
        // The launcher reuses its ready child, and restarts it if ending a
        // session stopped it — always on this worker's own origin.
        if ((await launch(servedUrl)) === 'route-missing') {
          throw new Error(
            `The service at ${service.baseUrl} no longer serves POST /dev-server/launch, which served this worker's fixture app; restart the suite against one service build.`,
          );
        }
        await waitForFixtureApp(servedUrl.origin, launcherDiagnostics);
        return;
      case 'fixture-process': {
        const spawned = owned.spawned;
        if (
          spawned === undefined ||
          spawned.child.exitCode !== null ||
          spawned.child.signalCode !== null
        ) {
          throw new Error(`The fixture app's dev server exited. ${spawnedDiagnostics()}`);
        }
        await waitForFixtureApp(servedUrl.origin, spawnedDiagnostics);
        return;
      }
    }
  };

  const handle: FixtureAppHandle = {
    baseUrl: servedUrl.origin,
    configuredUrl: configuredOrigin,
    displaced,
    projectRoot,
    sourceRoot: FIXTURE_SOURCE_ROOT,
    startedByFixture: true,
    servedBy,
    ensureServing,
    output: () => owned.spawned?.output() ?? '',
  };

  return { handle, dispose: release };
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

/** Remove a Chromium profile directory and prove it is gone; returns one sentence per problem. */
async function removeProfile(userDataDir: string): Promise<string[]> {
  const problems: string[] = [];
  try {
    await rm(userDataDir, { recursive: true, force: true });
  } catch (error) {
    problems.push(`removing the Chromium profile ${userDataDir} failed: ${describeError(error)}`);
  }
  try {
    await lstat(userDataDir);
    problems.push(`the Chromium profile ${userDataDir} still exists after its removal`);
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') {
      problems.push(
        `the Chromium profile ${userDataDir} could not be confirmed removed: ${describeError(error)}`,
      );
    }
  }
  return problems;
}

/**
 * Launch the persistent context with the unpacked extension — extensions load
 * only in a persistent context — and obtain its MV3 worker on whichever path
 * wins the race: already registered, or awaited. `dispose()` attempts the
 * context close and the profile removal independently, verifies both (the
 * context reported `close`, the profile directory is gone) and returns the
 * problems; every error path of this function appends them to its own error.
 */
async function launchExtension(
  configuredPath: string,
  options: BrowserOptions,
  workerInfo: WorkerInfo,
): Promise<ExtensionHarness & { dispose(): Promise<string[]> }> {
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
    throw errorWithProblems(
      error,
      'Removing the unused Chromium profile also failed',
      await removeProfile(userDataDir),
    );
  }

  // Mutated from the event, so held in an object flow analysis does not narrow.
  const lifecycle = { closed: false };
  context.once('close', () => {
    lifecycle.closed = true;
  });
  const disposeContext = async (): Promise<string[]> => {
    const problems: string[] = [];
    try {
      await context.close();
    } catch (error) {
      problems.push(`closing the persistent Chromium context failed: ${describeError(error)}`);
    }
    if (!lifecycle.closed) {
      problems.push(
        'the persistent Chromium context never reported closing, so its browser process may still be running',
      );
    }
    problems.push(...(await removeProfile(userDataDir)));
    return problems;
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
      throw errorWithProblems(
        new Error(
          `The extension's MV3 service worker did not register within ${String(WORKER_READY_TIMEOUT_MS)} ms (extension path ${extensionPath}; extension id ${pageIds[0] ?? 'unresolved'}). Build the extension first with \`pnpm build\`; a manifest that loads but whose worker fails to evaluate shows up as this timeout. ${describeError(error)}`,
          { cause: error },
        ),
        'Disposing the Chromium context also failed',
        await disposeContext(),
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
    throw errorWithProblems(
      new Error(`The extension id could not be read from the worker URL ${serviceWorker.url()}.`),
      'Disposing the Chromium context also failed',
      await disposeContext(),
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
  /**
   * `chrome.devtools.panels.themeName`. The panel maps `'dark'` (and DevTools'
   * `'default'`) to its dark token set and `'light'` to its light one.
   */
  readonly themeName: 'dark' | 'light';
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
 * here) and `panels.themeName` (`theme.ts`, which feature-detects the optional
 * `panels.setThemeChangeHandler` left out here and re-reads `themeName` when
 * the panel is shown instead) — so a panel change that needs
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

/**
 * Close `page` and confirm it closed.
 *
 * @param label What the page is, for the diagnostic (for example `the panel page`).
 * @returns The problem, or `undefined` when the page is closed.
 */
async function closePage(page: Page, label: string): Promise<string | undefined> {
  try {
    await page.close();
  } catch (error) {
    return `closing ${label} (${page.url()}) failed: ${describeError(error)}`;
  }
  return page.isClosed() ? undefined : `${label} (${page.url()}) is still open after page.close()`;
}

/** Close every page, attempting each one; returns one sentence per page that did not close. */
async function closePages(pages: readonly Page[], label: string): Promise<string[]> {
  const problems: string[] = [];
  for (const page of pages) {
    const problem = await closePage(page, label);
    if (problem !== undefined) {
      problems.push(problem);
    }
  }
  return problems;
}

/** Install the requested init scripts in a fresh page and navigate it to the panel document. */
async function preparePanelPage(
  page: Page,
  harness: ExtensionHarness,
  launch: PanelLaunch,
): Promise<void> {
  if (launch.installDevtoolsStub) {
    if (launch.inspectedTabId === undefined) {
      throw new Error('openPanelPage: the chrome.devtools stub needs an inspected tab id.');
    }
    const inspectedUrl = launch.inspectedUrl;
    const announceOrigin = inspectedUrl === undefined ? undefined : originOf(inspectedUrl);
    const args: DevtoolsEmulationArgs = {
      panelPath: PANEL_DOCUMENT_PATH,
      inspectedTabId: launch.inspectedTabId,
      themeName: launch.themeName,
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
  await page.goto(`chrome-extension://${harness.extensionId}${PANEL_DOCUMENT_PATH}`);
}

/**
 * Open the panel document as an extension page and wrap it in a
 * {@link PanelHandle}. A page whose setup failed is closed before the error
 * is rethrown, a failed close appended to it.
 */
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

  try {
    await preparePanelPage(page, harness, launch);
  } catch (error) {
    throw errorWithProblems(
      error,
      'Closing the panel page after that failure also failed',
      await closePages([page], 'the panel page'),
    );
  }

  const header = page.getByRole('banner');
  const labelPattern = new RegExp(
    `^\\s*(${PANEL_CONNECTION_STATUSES.map((status) => escapeRegExp(PANEL_CONNECTION_LABELS[status])).join('|')})`,
  );
  const connectionPill = header.getByRole('status').filter({ hasText: labelPattern });
  const main = page.getByRole('main');
  const panelView = main.locator(RENDERED_PANEL_SELECTOR);
  const liveTail = page.getByRole('region', { name: PANEL_NAMES.liveTail, exact: true });
  const captureNotices = liveTail.getByRole('list', {
    name: PANEL_NAMES.captureNotices,
    exact: true,
  });
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
      // `PanelHost` names no landmark after the panel (its `PanelShell` gets no
      // label); the title is the summary head's heading inside the panel block.
      const target =
        options?.title === undefined
          ? panelView.first()
          : panelView
              .filter({ has: page.getByRole('heading', { name: options.title, exact: true }) })
              .first();
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
    liveTail,
    captureNotices,
    // The badge holds the notice's wording exactly; the entry also carries its
    // time and the new document's path, so the entry is matched by its badge.
    pageReloadedNotices: captureNotices.getByRole('listitem').filter({
      has: page.getByText(PANEL_NAMES.pageReloadedNotice, { exact: true }),
    }),
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
 * from any other origin would be refused (docs/SECURITY.md, section 7.4).
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
    const pairThroughPanel = async (): Promise<void> => {
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
      const codeInput = panel.pairDialog.getByRole('textbox', { name: PANEL_NAMES.pairingCode });
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
    };

    // Every outcome closes the panel page; a close that fails is never dropped.
    let failure: { readonly error: unknown } | undefined;
    try {
      await pairThroughPanel();
    } catch (error) {
      failure = { error };
    }
    const closeProblems = await closePages([panel.page], 'the pairing panel page');
    if (failure !== undefined) {
      throw errorWithProblems(
        failure.error,
        'Closing the pairing panel page also failed',
        closeProblems,
      );
    }
    if (closeProblems.length > 0) {
      throw new Error(
        `Pairing succeeded, but its panel page could not be closed:\n${formatProblems(closeProblems)}`,
      );
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

/** The protocol code of a `409` answered while another operation of the session is still settling. */
const SESSION_INVALID_STATE_CODE = 'SESSION_INVALID_STATE';

/** The protocol code of a session the service does not know. */
const SESSION_NOT_FOUND_CODE = 'SESSION_NOT_FOUND';

/**
 * Build the test-scoped session helper. Its `dispose()` mirrors
 * `SessionTracker.endAll` in `tests/e2e/helpers/session.ts`: newest session
 * first, each one read, its open capture stopped, ended (a
 * `SESSION_INVALID_STATE` answer retried within {@link SESSION_END_SETTLE_MS})
 * and its cleanup required to be `clean`; an already-ended session's stored
 * cleanup is checked the same way. It never throws — it returns one sentence
 * per problem, including those recorded while the test ran — and the
 * `sessions` fixture hands them to {@link settleTestTeardown}.
 */
function createSessionHelper(
  service: ServiceHandle,
  editor: EditorClient,
  fixtureApp: FixtureAppHandle,
): SessionHelper & { dispose(): Promise<string[]> } {
  const createdIds: string[] = [];
  const ended = new Set<string>();
  /** Problems found while the test ran (a failed stop after a failed action, a non-clean end); reported by `dispose()`. */
  const recorded: string[] = [];

  const conflictCount = (count: number): string => `${String(count)} conflict(s)`;

  /** The conflict count the service stored for `id`, or why it could not be read. */
  const conflictsOf = async (id: string): Promise<string> => {
    try {
      return conflictCount((await service.getSession(id)).cleanup.conflicts.length);
    } catch (error) {
      return `conflict count unreadable: ${describeError(error)}`;
    }
  };

  const uncleanEnd = (id: string, status: CleanupStatus, conflicts: string, when: string): string =>
    `session ${id} ${when} with cleanup "${status}" (${conflicts}) — instrumentation may remain in ${fixtureApp.projectRoot}`;

  /** `session.end` for teardown: bounded, retrying `SESSION_INVALID_STATE` while another operation settles. */
  const endSettled = async (id: string): Promise<CleanupStatus> => {
    const settleUntil = Date.now() + SESSION_END_SETTLE_MS;
    for (;;) {
      const result = await service.call('session.end', {
        params: { id },
        body: {},
        timeoutMs: SESSION_END_TIMEOUT_MS,
      });
      if (result.ok) {
        return result.value.cleanup;
      }
      if (result.error.code !== SESSION_INVALID_STATE_CODE) {
        throw new ServiceCallError('session.end', result.error);
      }
      if (Date.now() >= settleUntil) {
        throw new Error(
          `the service still answered ${SESSION_INVALID_STATE_CODE} (another operation of the session settling) after ${String(SESSION_END_SETTLE_MS)} ms: ${new ServiceCallError('session.end', result.error).message}`,
        );
      }
      await delay(POLL_INTERVAL_MS);
    }
  };

  /** Bring one session this helper created to `ended` with a clean cleanup; returns what went wrong. */
  const settleSession = async (id: string): Promise<string[]> => {
    const problems: string[] = [];
    let record: SessionRecord | undefined;
    try {
      record = await service.getSession(id);
    } catch (error) {
      if (error instanceof ServiceCallError && error.code === SESSION_NOT_FOUND_CODE) {
        return [`session ${id} is unknown to the service, so its cleanup cannot be confirmed`];
      }
      // Still attempt the end below: an unreadable session may yet be endable.
      problems.push(`session ${id}: reading it before teardown failed: ${describeError(error)}`);
    }
    if (record?.status === 'ended') {
      if (record.cleanup.status !== 'clean') {
        problems.push(
          uncleanEnd(
            id,
            record.cleanup.status,
            conflictCount(record.cleanup.conflicts.length),
            'had already ended',
          ),
        );
      }
      return problems;
    }
    if (record?.status === 'capturing') {
      try {
        await service.stopCapture(id);
      } catch (error) {
        problems.push(
          `session ${id}: stopping its open capture in teardown failed: ${describeError(error)}`,
        );
      }
    }
    try {
      const cleanup = await endSettled(id);
      if (cleanup !== 'clean') {
        problems.push(uncleanEnd(id, cleanup, await conflictsOf(id), 'ended in teardown'));
      }
    } catch (error) {
      problems.push(`session ${id} could not be ended in teardown: ${describeError(error)}`);
    }
    return problems;
  };

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
      if (fixtureApp.servedBy === 'fixture-process') {
        // The service learns a dev server only from its launcher (or an earlier
        // session of the same root), so it cannot attribute this worker's
        // spawned server and would answer DEV_SERVER_UNAVAILABLE.
        throw new Error(
          `sessions.create() cannot create a session: the service at ${service.baseUrl} does not serve POST /dev-server/launch, so this worker spawned the fixture app on ${fixtureApp.baseUrl} itself, and the service cannot attribute that dev server to ${fixtureApp.projectRoot}. Rebuild and restart the service (\`pnpm build\`) so it serves POST /dev-server/launch.`,
        );
      }
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
        // The action's error is the one the test reports; a stop that fails
        // now is a leaked capture, recorded for teardown rather than dropped.
        try {
          await service.stopCapture(id);
        } catch (stopError) {
          recorded.push(
            `session ${id}: capture ${captureId} could not be stopped after the interaction failed: ${describeError(stopError)}`,
          );
        }
        throw error;
      }
      const stopped = await service.stopCapture(id);
      return { captureId, summary: stopped.summary };
    },
    async end(id) {
      const result = await service.endSession(id);
      ended.add(id);
      if (result.cleanup !== 'clean') {
        recorded.push(uncleanEnd(id, result.cleanup, await conflictsOf(id), 'ended'));
      }
      return result;
    },
    created: () => [...createdIds],
    async dispose() {
      const problems = recorded.splice(0, recorded.length);
      for (const id of [...createdIds].reverse()) {
        if (ended.has(id)) {
          continue;
        }
        problems.push(...(await settleSession(id)));
        // Settled either way: a second dispose() must not end it again.
        ended.add(id);
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
        // A Chromium that would not close or a profile left behind fails the run.
        throwIfProblems('_extension', await harness.dispose());
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
        // A leaked server, port or copy fails the run as a worker teardown error.
        throwIfProblems('fixtureApp', await state.dispose());
      }
    },
    {
      scope: 'worker',
      // Identification of the configured origin (`/` and the ping), that of
      // every alternate-port candidate when it is occupied, the install, the
      // launch, the first answer and the launcher probe, each at its own bound.
      timeout:
        IDENTIFY_TIMEOUT_MS * 2 +
        ALTERNATE_PORT_ATTEMPTS * IDENTIFY_TIMEOUT_MS * 2 +
        INSTALL_TIMEOUT_MS +
        APP_READY_TIMEOUT_MS * 2 +
        ANNOUNCEMENT_SETTLE_MS +
        ROUTE_PROBE_TIMEOUT_MS,
    },
  ],

  pairing: [
    async ({ _extension, service }, use) => {
      await use(createPairing(_extension, service));
    },
    { scope: 'worker' },
  ],

  appPage: async ({ extensionContext, fixtureApp }, use, testInfo) => {
    const page = await extensionContext.newPage();
    try {
      await page.goto(new URL('/', fixtureApp.baseUrl).toString(), {
        timeout: APP_READY_TIMEOUT_MS,
      });
    } catch (error) {
      throw errorWithProblems(
        error,
        'Closing the fixture app tab also failed',
        await closePages([page], 'the fixture app tab'),
      );
    }
    await use(page);
    settleTestTeardown(testInfo, 'appPage', await closePages([page], 'the fixture app tab'));
  },

  openPanelPage: async ({ _extension, appPage }, use, testInfo) => {
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
    settleTestTeardown(
      testInfo,
      'openPanelPage',
      await closePages(
        opened.map((handle) => handle.page),
        'a panel page',
      ),
    );
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
    settleTestTeardown(testInfo, 'sessions', await helper.dispose());
  },

  resetExtensionState: async ({ _extension }, use) => {
    await use(() => clearBindings(_extension));
  },

  _hygiene: [
    async ({ _extension }, use, testInfo) => {
      await use(undefined);
      const problems: string[] = [];
      try {
        await clearBindings(_extension);
      } catch (error) {
        problems.push(`binding reset: ${describeError(error)}`);
      }
      settleTestTeardown(testInfo, '_hygiene', problems);
    },
    { auto: true },
  ],
});
