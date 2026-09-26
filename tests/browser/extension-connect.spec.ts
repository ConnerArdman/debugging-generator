/**
 * `extension-connect` — the browser project's connection spec: the service
 * worker connects, its `client.hello` is received, and the inspected tab is
 * bound.
 *
 * Pairing is the prerequisite of every connection (docs/SECURITY.md, section
 * 7.4 "Pairing the Chrome extension"): the service refuses a socket that
 * carries no devtools credential, and that credential exists only after
 * `POST /pair/start` (editor credential) and `POST /pair/complete { code }`
 * (from the extension's own origin). The spec therefore proves the
 * prerequisite rather than assuming it: first that an unpaired extension is
 * refused visibly and binds nothing, then that pairing makes the worker
 * connect, and finally that the connected worker binds the inspected tab to
 * the session and releases it when DevTools closes.
 *
 * What this spec deliberately does NOT assert, and who does:
 *
 * - the built manifest's fields, worlds, permissions and content-script order —
 *   `apps/chrome-extension/test/manifest.test.ts`;
 * - pairing-code reuse, expiry and rate limiting, and the role/scope matrix of
 *   every credential — `apps/local-service/test/integration/auth.test.ts`;
 * - replacement binds and same- or cross-origin navigation semantics —
 *   `apps/local-service/test/integration/binding.test.ts` and
 *   `apps/chrome-extension/test/tab-registry.test.ts`.
 *
 * Shared-state discipline (`workers: 1`, `fullyParallel: false`): one
 * persistent Chromium context, one service and one `DEBUGGEN_HOME` serve the
 * whole run, so every test starts from an empty editor log, filters every
 * observation by the session and tab it created itself, leaves session cleanup
 * to the `sessions` fixture, and leaves the extension paired for later specs.
 * Each test establishes its own pairing state, so the file has no ordering
 * dependency between its tests.
 *
 * Constraints: no credential is written, printed or attached — the stored
 * token is only ever measured inside the extension page; only the generic
 * fixture app (`tests/fixtures/sample-next-app`) is driven; every assertion
 * names identifiers and fields rather than mere existence; the service runs
 * the deterministic provider and nothing leaves localhost.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';

import { CLIENT_HELLO_TIMEOUT_MS, isCompatibleProtocolVersion } from '@debuggen/protocol';

import {
  BINDING_STORAGE_KEY,
  DEFAULT_WAIT_TIMEOUT_MS,
  DEVTOOLS_TOKEN_STORAGE_KEY,
  PANEL_CONNECTION_LABELS,
  POLL_INTERVAL_MS,
  expect,
  test,
} from './fixtures';
import type { PanelConnectionStatus, PanelHandle } from './fixtures';

// ---------------------------------------------------------------------------
// Named constants
// ---------------------------------------------------------------------------

/** Chrome's extension-id alphabet: 32 characters drawn from `a`–`p` (a base-16 digest spelled with letters). */
const CHROME_EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

/**
 * The service mints every credential from 32 CSPRNG bytes rendered base64url
 * without padding (`CREDENTIAL_TOKEN_BYTES` in `apps/local-service/src/server/auth.ts`),
 * so a stored devtools token is exactly this many characters long.
 */
const SERVICE_TOKEN_BYTES = 32;
const SERVICE_TOKEN_BASE64URL_LENGTH = Math.ceil((SERVICE_TOKEN_BYTES * 8) / 6);

/**
 * How long an unpaired extension must stay silent. With an open socket a bind
 * is answered within milliseconds of the DevTools page's `devtools.hello`, so
 * a window of more than the service's whole handshake budget
 * (`CLIENT_HELLO_TIMEOUT_MS`) plus a margin is far beyond any real answer.
 */
const UNPAIRED_QUIET_WINDOW_MS = CLIENT_HELLO_TIMEOUT_MS + 2_000;

/**
 * How long the pill must hold "Connected" after pairing. The pill turns
 * connected as soon as the transport opens, before the service has judged the
 * `client.hello`; a refused hello is closed with 4401 within
 * `CLIENT_HELLO_TIMEOUT_MS`, which clears the stored credential and turns the
 * pill back to "Not paired". Holding past that deadline rules the refusal out.
 */
const CONNECTED_SETTLE_WINDOW_MS = CLIENT_HELLO_TIMEOUT_MS + 1_500;

/** The questions the binding tests ask: generic vocabulary, naming nothing of any application. */
const UNPAIRED_QUESTION = 'Why does this button take so long to respond?';
const BOUND_QUESTION = 'Why is this button slow?';

/** Repository root, from this module's location. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The single source of the extension's manifest, read for its authored background entry. */
const MANIFEST_SOURCE = path.join(REPO_ROOT, 'apps', 'chrome-extension', 'manifest.config.ts');

// ---------------------------------------------------------------------------
// Spec-local observations (no lifecycle: the fixtures own every launch,
// pairing and session; these only read what the extension already holds)
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/** How a status reads on the pill, for failure messages. */
function describeStatus(status: PanelConnectionStatus | undefined): string {
  return status === undefined ? 'nothing recognisable' : `"${PANEL_CONNECTION_LABELS[status]}"`;
}

/** The message every harness-level failure carries: this is a setup fault, not a product fault. */
function harnessFailure(detail: string): string {
  return `${detail} This is a harness failure, not a product failure: the service is started by the webServer entry of playwright.config.ts (\`node apps/local-service/dist/main.js\`), so build it first with \`pnpm build\` and check that DEBUGGEN_HOST/DEBUGGEN_PORT agree with the config's serviceUrl.`;
}

/**
 * Origin plus path without trailing slashes, so `http://host:1/` and
 * `http://host:1` compare equal while any other path or origin differs.
 */
function comparableUrl(raw: string): string {
  const url = new URL(raw);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * The background entry `manifest.config.ts` authors (`background.service_worker`),
 * read from the source text: the module is a Vite plugin input that cannot be
 * evaluated from this directory.
 */
async function readAuthoredWorkerEntry(): Promise<string> {
  const text = await readFile(MANIFEST_SOURCE, 'utf8');
  const match = /\bbackground\s*:\s*\{[^}]*?\bservice_worker\s*:\s*(['"])([^'"]+)\1/.exec(text);
  const entry = match?.[2];
  if (entry === undefined) {
    throw new Error(
      `${MANIFEST_SOURCE} does not author background.service_worker as a string literal; the worker entry cannot be compared.`,
    );
  }
  return entry;
}

/**
 * The `chrome.runtime` members the worker-side callbacks read. This program has
 * no `@types/chrome` (see `tests/tsconfig.json`), so the callbacks type the
 * global structurally, exactly as `fixtures.ts` does.
 */
interface WorkerChrome {
  readonly runtime: {
    readonly id: string | undefined;
    getManifest(): { readonly background?: { readonly service_worker?: unknown } };
    getURL(path: string): string;
  };
}

/** The static module specifiers of a script (`import '…'` and `import … from '…'`). */
function staticImportSpecifiers(script: string): readonly string[] {
  const specifiers: string[] = [];
  for (const match of script.matchAll(/\bimport\s*(?:[^'";]*?\bfrom\s*)?(['"])([^'"]+)\1/g)) {
    const specifier = match[2];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

/** The shape of the stored devtools credential — never its value. */
interface StoredCredentialShape {
  readonly present: boolean;
  readonly tokenLength: number;
  readonly tokenIsBase64Url: boolean;
}

/**
 * Measure the paired credential inside an extension page. The token is read
 * and measured in the page and never crosses into this process, so no report,
 * trace or log can carry it.
 */
async function readStoredCredentialShape(page: Page): Promise<StoredCredentialShape> {
  return page.evaluate(async (key) => {
    const host = globalThis as unknown as {
      chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
    };
    const stored = (await host.chrome.storage.local.get(key))[key];
    const token =
      typeof stored === 'object' && stored !== null
        ? (stored as { readonly token?: unknown }).token
        : undefined;
    if (typeof token !== 'string') {
      return { present: false, tokenLength: 0, tokenIsBase64Url: false };
    }
    return {
      present: true,
      tokenLength: token.length,
      tokenIsBase64Url: /^[A-Za-z0-9_-]+$/.test(token),
    };
  }, DEVTOOLS_TOKEN_STORAGE_KEY);
}

/** One tab's record under `BINDING_STORAGE_KEY`, as the worker persisted it. */
interface StoredBinding {
  readonly sessionId: string;
  readonly url: string | undefined;
  readonly origin: string | undefined;
}

/**
 * Read the worker's persisted binding of `tabId` from `chrome.storage.session`
 * in an extension page — the registry's authoritative, suspension-surviving
 * state, keyed by the tab id's decimal string.
 */
async function readStoredBinding(page: Page, tabId: number): Promise<StoredBinding | undefined> {
  return page.evaluate(
    async ({ key, tab }) => {
      const host = globalThis as unknown as {
        chrome: { storage: { session: { get(key: string): Promise<Record<string, unknown>> } } };
      };
      const snapshot = (await host.chrome.storage.session.get(key))[key];
      if (typeof snapshot !== 'object' || snapshot === null) {
        return undefined;
      }
      const record = (snapshot as Record<string, unknown>)[String(tab)];
      if (typeof record !== 'object' || record === null) {
        return undefined;
      }
      const { sessionId, url, origin } = record as {
        readonly sessionId?: unknown;
        readonly url?: unknown;
        readonly origin?: unknown;
      };
      if (typeof sessionId !== 'string') {
        return undefined;
      }
      return {
        sessionId,
        url: typeof url === 'string' ? url : undefined,
        origin: typeof origin === 'string' ? origin : undefined,
      };
    },
    { key: BINDING_STORAGE_KEY, tab: tabId },
  );
}

/**
 * Resolve the tab showing `url` through `chrome.tabs` from an extension page,
 * independently of the id the `chrome.devtools` stub reports — so a stub that
 * inspects the wrong tab cannot also supply the expected value.
 */
async function resolveTabIdByUrl(page: Page, url: string): Promise<number> {
  const tabs = await page.evaluate(async () => {
    const host = globalThis as unknown as {
      chrome: {
        tabs: {
          query(queryInfo: Record<string, never>): Promise<{ id?: number; url?: string }[]>;
        };
      };
    };
    const all = await host.chrome.tabs.query({});
    return all.map((tab) => ({ id: tab.id ?? -1, url: tab.url ?? '' }));
  });
  const matching = tabs.filter((tab) => tab.id >= 0 && tab.url === url);
  const [only] = matching;
  if (only === undefined || matching.length !== 1) {
    throw new Error(
      `Expected exactly one tab showing ${url}, found ${String(matching.length)} among ${JSON.stringify(tabs)}.`,
    );
  }
  return only.id;
}

/**
 * Sample the panel's pill every {@link POLL_INTERVAL_MS} for `windowMs` and
 * fail on the first reading that is not `expected` — an explicit "stays"
 * assertion rather than a sleep followed by a single look.
 */
async function expectStatusThroughout(
  panel: PanelHandle,
  expected: PanelConnectionStatus,
  windowMs: number,
  why: string,
): Promise<void> {
  const started = Date.now();
  const deadline = started + windowMs;
  for (;;) {
    const status = await panel.connectionStatus();
    if (status !== expected) {
      const errors = panel.consoleErrors();
      throw new Error(
        `The panel's connection pill left ${describeStatus(expected)} after ${String(Date.now() - started)} ms of a ${String(windowMs)} ms window: it reads ${describeStatus(status)}. ${why}${errors.length === 0 ? '' : ` Panel errors: ${errors.join(' | ')}`}`,
      );
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return;
    }
    await delay(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

test.describe('extension-connect', () => {
  // Later specs start from a paired extension; restore it whatever happened here.
  test.afterAll(async ({ pairing }) => {
    await pairing.ensurePaired();
  });

  test("preconditions: the local service answers GET /health and the extension id has Chrome's shape", async ({
    service,
    extensionId,
    serviceWorker,
  }) => {
    const health = await service.call('health');
    if (!health.ok) {
      throw new Error(
        harnessFailure(
          `GET ${service.baseUrl}/health did not answer (${health.error.code}: ${health.error.message}).`,
        ),
      );
    }
    expect(
      isCompatibleProtocolVersion(health.value.protocolVersion),
      harnessFailure(
        `GET ${service.baseUrl}/health answered ${JSON.stringify(health.value)}, whose protocolVersion this build does not speak — a stale service is answering.`,
      ),
    ).toBe(true);
    expect(
      health.value.version.trim(),
      `GET /health answered ${JSON.stringify(health.value)} without a service version.`,
    ).not.toBe('');

    // Every later `chrome-extension://<id>/…` navigation relies on this id,
    // which the fixture derives from the service worker's URL.
    expect(
      extensionId,
      `The extension id derived from the service worker URL ${serviceWorker.url()} is not a Chrome extension id.`,
    ).toMatch(CHROME_EXTENSION_ID_PATTERN);
  });

  test("the MV3 service worker is the extension's own background worker and is alive", async ({
    serviceWorker,
    extensionId,
    extensionContext,
  }) => {
    const workerUrl = new URL(serviceWorker.url());
    expect(
      workerUrl.protocol,
      `The worker ${serviceWorker.url()} is not an extension worker.`,
    ).toBe('chrome-extension:');
    expect(
      workerUrl.host,
      `The worker ${serviceWorker.url()} belongs to another extension than ${extensionId}.`,
    ).toBe(extensionId);
    expect(
      extensionContext.serviceWorkers(),
      `The service worker handle captured at launch (${serviceWorker.url()}) is no longer registered in the context; Chromium replaced the worker, so specs driving the launch-time handle would talk to a dead target.`,
    ).toContain(serviceWorker);

    // Alive and usable: a trivial expression evaluates in the worker.
    expect(
      await serviceWorker.evaluate(() => {
        const host = globalThis as unknown as { chrome: WorkerChrome };
        return typeof host.chrome.runtime.id;
      }),
      `The worker ${serviceWorker.url()} did not evaluate an expression.`,
    ).toBe('string');

    // The worker's script path against the entry `manifest.config.ts` authors.
    // The build rewrites that authored TypeScript entry: @crxjs/vite-plugin
    // emits a loader module under the manifest's background entry, and the
    // loader's only import is the chunk it emitted for the authored file
    // (`<file name>-<hash>.js`). Both hops are path comparisons; no file
    // content is compared with anything.
    const authoredEntry = await readAuthoredWorkerEntry();
    const loaded = await serviceWorker.evaluate(async () => {
      const { runtime } = (globalThis as unknown as { chrome: WorkerChrome }).chrome;
      const entry: unknown = runtime.getManifest().background?.service_worker;
      if (typeof entry !== 'string') {
        return { runtimeId: runtime.id, entry: undefined, script: '' };
      }
      const response = await fetch(runtime.getURL(entry));
      return { runtimeId: runtime.id, entry, script: await response.text() };
    });
    expect(loaded.runtimeId, 'chrome.runtime.id inside the worker').toBe(extensionId);
    expect(
      loaded.entry,
      'The running extension declares no background.service_worker entry.',
    ).toBeDefined();
    expect(
      workerUrl.pathname,
      `The registered worker is not the extension's background entry "${String(loaded.entry)}".`,
    ).toBe(`/${String(loaded.entry)}`);

    const authoredFileName = path.posix.basename(authoredEntry);
    const importedPaths = staticImportSpecifiers(loaded.script).map(
      (specifier) => new URL(specifier, workerUrl).pathname,
    );
    const runsAuthoredEntry =
      loaded.entry === authoredEntry ||
      importedPaths.some((imported) =>
        path.posix.basename(imported).startsWith(`${authoredFileName}-`),
      );
    expect(
      runsAuthoredEntry,
      `The worker ${workerUrl.pathname} does not run the entry manifest.config.ts authors ("${authoredEntry}"): it is neither that path nor a loader importing the chunk emitted for "${authoredFileName}" (it imports ${JSON.stringify(importedPaths)}).`,
    ).toBe(true);
  });

  test('an unpaired extension is refused visibly and binds no tab', async ({
    pairing,
    editorClient,
    sessions,
    openPanelPage,
    appPage,
  }) => {
    editorClient.clear();
    await pairing.unpair();
    let panel: PanelHandle | undefined;
    try {
      expect(
        await pairing.isPaired(),
        'pairing.unpair() left a devtools credential of the stored shape in chrome.storage.local.',
      ).toBe(false);

      // The editor credential still creates the session; only the extension is unpaired.
      const session = await sessions.create(UNPAIRED_QUESTION);
      panel = await openPanelPage({ inspect: appPage });
      const inspectedTabId = panel.tabId;
      if (inspectedTabId === undefined) {
        throw new Error('The chrome.devtools stub reports no inspected tab for the fixture app.');
      }

      await panel.waitForNotPaired();
      await expect(panel.connectionPill.first()).toContainText(
        PANEL_CONNECTION_LABELS['not-paired'],
      );
      // The recovery path is offered: the pairing dialog opens on "Not paired".
      await expect(panel.pairDialog).toBeVisible();

      // Absence, asserted explicitly: over the whole window no binding of this
      // session or of this tab reaches the editor, and the pill never claims a
      // connection. Pairing-code reuse, expiry and the rate limit are the
      // service's rules and are asserted by
      // apps/local-service/test/integration/auth.test.ts.
      await Promise.all([
        editorClient.expectNoMessage(
          'session.bound',
          (message) =>
            message.payload.sessionId === session.id || message.payload.tabId === inspectedTabId,
          UNPAIRED_QUIET_WINDOW_MS,
        ),
        expectStatusThroughout(
          panel,
          'not-paired',
          UNPAIRED_QUIET_WINDOW_MS,
          'An extension without a devtools credential must never report a connection.',
        ),
      ]);
      expect(
        await readStoredBinding(panel.page, inspectedTabId),
        `The worker persisted a binding of tab ${String(inspectedTabId)} while unpaired.`,
      ).toBeUndefined();
    } finally {
      // Close the inspecting panel first: a worker that reconnects re-requests a
      // binding for every tab whose DevTools page is still announced. Then
      // restore the pairing later tests rely on.
      await panel?.page.close().catch(() => undefined);
      await pairing.ensurePaired();
    }
  });

  test('after pairing, the worker connects and its client.hello is accepted', async ({
    pairing,
    openPanelPage,
  }) => {
    // The real path: POST /pair/start with the editor credential, the code typed
    // into the panel's PairDialog, and POST /pair/complete from the
    // chrome-extension:// origin by the worker. This process never calls
    // /pair/complete: a devtools credential minted from another origin is
    // refused by design (docs/SECURITY.md, section 7.4).
    await pairing.ensurePaired();

    // No chrome.devtools stub: this panel inspects no tab, so nothing binds.
    const panel = await openPanelPage({ installDevtoolsStub: false });

    const credential = await readStoredCredentialShape(panel.page);
    expect(
      credential,
      `The devtools credential under ${DEVTOOLS_TOKEN_STORAGE_KEY} does not have the shape the service mints (a ${String(SERVICE_TOKEN_BASE64URL_LENGTH)}-character base64url token).`,
    ).toEqual({
      present: true,
      tokenLength: SERVICE_TOKEN_BASE64URL_LENGTH,
      tokenIsBase64Url: true,
    });

    await panel.waitForConnected();
    await expect(panel.connectionPill.first()).toContainText(PANEL_CONNECTION_LABELS.connected);
    await expect(panel.pairDialog).toBeHidden();

    // Why this proves the hello was accepted: the pill reads "Connected" as
    // soon as the socket opens, before the service has judged the
    // `client.hello { client: 'devtools', token, version }` it sent first. A
    // refused hello is closed with 4401 within CLIENT_HELLO_TIMEOUT_MS, and the
    // worker then clears the stored credential, schedules no reconnect and
    // shows "Not paired". Holding "Connected" past that deadline with the
    // credential still stored rules the refusal out; the `session.bound` of the
    // next test is the conclusive consequence, since only an accepted devtools
    // connection can bind a tab. The worker keeps its bridge state in module
    // scope and exposes none on its global object, so there is no internal
    // state to corroborate this with.
    await expectStatusThroughout(
      panel,
      'connected',
      CONNECTED_SETTLE_WINDOW_MS,
      'A 4401 refusal of client.hello turns the pill to "Not paired".',
    );
    expect(
      await pairing.isPaired(),
      "The devtools credential disappeared after connecting: the service refused the worker's client.hello with 4401.",
    ).toBe(true);
  });

  test('the inspected tab is bound to the session, and unbound when DevTools closes', async ({
    pairing,
    service,
    editorClient,
    sessions,
    openPanelPage,
    appPage,
    fixtureApp,
  }) => {
    await pairing.ensurePaired();
    editorClient.clear();

    // The order the fixture prescribes: app page open → session created with
    // the editor credential for the served fixture root → panel opened with the
    // chrome.devtools stub announcing the app tab → session.bind → session.bound.
    const session = await sessions.create(BOUND_QUESTION);
    expect(session.projectRoot).toBe(fixtureApp.projectRoot);

    const panel = await openPanelPage({ inspect: appPage });
    const appTabId = await resolveTabIdByUrl(panel.page, appPage.url());
    expect(panel.tabId, 'The chrome.devtools stub does not inspect the fixture app tab.').toBe(
      appTabId,
    );

    const bound = await editorClient
      .waitFor(
        'session.bound',
        (message) =>
          message.payload.sessionId === session.id &&
          (message.payload.reason ?? 'bound') === 'bound',
        { timeoutMs: DEFAULT_WAIT_TIMEOUT_MS },
      )
      .catch(async (error: unknown) => {
        throw new Error(
          `The service never announced a binding of session ${session.id} to tab ${String(appTabId)}; the panel's pill reads ${describeStatus(await panel.connectionStatus())} and it inspects tab ${String(panel.tabId)}. ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      });
    expect(bound.payload.sessionId).toBe(session.id);
    expect(bound.payload.tabId, "session.bound names another tab than the fixture app's.").toBe(
      appTabId,
    );
    expect(comparableUrl(bound.payload.url)).toBe(comparableUrl(appPage.url()));

    // Extension side: the worker's registry persisted tab → session.
    const persisted = await panel.waitForBound(session.id);
    expect(persisted.tabId).toBe(appTabId);
    expect(persisted.origin).toBe(new URL(fixtureApp.baseUrl).origin);
    const stored = await readStoredBinding(panel.page, appTabId);
    expect(
      stored?.sessionId,
      `${BINDING_STORAGE_KEY} in chrome.storage.session does not map tab ${String(appTabId)} to session ${session.id}.`,
    ).toBe(session.id);
    expect(comparableUrl(stored?.url ?? '')).toBe(comparableUrl(appPage.url()));

    // Service side: the session record mirrors the bound tab.
    const record = await service.getSession(session.id);
    expect(record.boundTab?.tabId, `Session ${session.id} does not record the bound tab.`).toBe(
      appTabId,
    );

    // UI: the connected panel renders the bound session's question in its
    // header and its session summary, with the project it belongs to.
    await expect(panel.connectionPill.first()).toContainText(PANEL_CONNECTION_LABELS.connected);
    await expect(panel.header).toContainText(session.question);
    await expect(panel.sessionSummary).toContainText(session.question);
    await expect(panel.sessionSummary).toContainText(session.projectName);

    // Unbind: closing the (emulated) DevTools page makes the worker send
    // session.unbind; the service announces the drop and the worker forgets the
    // tab. Replacement binds and navigation are owned by the service's binding
    // integration test and the extension's tab-registry test.
    await panel.closeDevtools();
    const unbound = await editorClient
      .waitFor(
        'session.bound',
        (message) =>
          message.payload.sessionId === session.id &&
          message.payload.tabId === appTabId &&
          message.payload.reason === 'unbound',
        { timeoutMs: DEFAULT_WAIT_TIMEOUT_MS },
      )
      .catch(async (error: unknown) => {
        const still = await readStoredBinding(panel.page, appTabId);
        throw new Error(
          `The service never announced that tab ${String(appTabId)} was unbound from session ${session.id} after DevTools closed; the worker ${still === undefined ? 'no longer persists a binding of the tab, so its session.unbind went unanswered' : `still persists the tab's binding to session ${still.sessionId}, so it never sent session.unbind`}. ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      });
    expect(comparableUrl(unbound.payload.url)).toBe(comparableUrl(appPage.url()));
    await expect
      .poll(async () => readStoredBinding(panel.page, appTabId), {
        message: `The worker still persists a binding of tab ${String(appTabId)} after DevTools closed.`,
        timeout: DEFAULT_WAIT_TIMEOUT_MS,
      })
      .toBeUndefined();
    await expect
      .poll(async () => (await service.getSession(session.id)).boundTab, {
        message: `Session ${session.id} still records a bound tab after the unbind.`,
        timeout: DEFAULT_WAIT_TIMEOUT_MS,
      })
      .toBeUndefined();
  });
});
