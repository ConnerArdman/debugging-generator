/**
 * The first extension-host suite of `pnpm test:vscode`: it proves, inside a
 * real VS Code, that `debuggen.debug-generator` activates, that it contributes
 * exactly what its manifest claims — the Debug Generator activity-bar
 * container with its webview view and Sessions tree, and only the two
 * activation events it needs — and that it stays graceful when the local
 * service is absent (AAP 0.5.5).
 *
 * What "graceful" means here is asserted, not inferred from a missing throw:
 *
 * - the effective configuration of this window is checked first, as a
 *   precondition. The fixture workspace pins `debuggen.autoStartService` to
 *   `false` and `debuggen.serviceUrl` to a loopback URL the product itself
 *   refuses to start a service for, so a settings change that would let this
 *   suite spawn a real service fails here instead of turning the suite into a
 *   no-op or a leak;
 * - a lifecycle manager built from `src/service/process.ts` with this window's
 *   own settings and recording seams only ever health-probes: its status never
 *   reaches a reachable state, and neither the spawn seam nor the credential
 *   store is touched, for an automatic request and for the developer's explicit
 *   one alike;
 * - `debuggen.startService`, run for real, resolves and reports the failure as
 *   exactly one error notification, without creating or rewriting the editor
 *   credential (the only side effect a launch performs before spawning) and
 *   without waiting out the service start-up timeout a spawned child would
 *   impose;
 * - no promise rejection goes unhandled while activation, the command and the
 *   view reveal run.
 *
 * Only two commands are executed: `workbench.view.extension.debuggen` and
 * `debuggen.startService`. Registration of the twelve contributed commands is
 * `commands.test.ts`'s job, and the session-scoped or destructive commands are
 * never run here.
 *
 * The suite is hermetic: the only workspace is `test/fixtures/workspace`, the
 * state directory is the run's throwaway `DEBUGGEN_HOME` from
 * `.vscode-test.mjs` (asserted before it is read), nothing listens on the
 * configured port, and no process is started.
 *
 * Mocha's `bdd` interface is supplied as globals by the `@vscode/test-cli`
 * runner and this workspace declares no `@types/mocha` (see the
 * `compilerOptions.types` notes in `tsconfig.json`), so the globals this suite
 * calls are declared below, in module scope, with the slice of Mocha's context
 * they use — the same convention as the other suites in this folder.
 *
 * @module apps/vscode-extension/test/suite/activation
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { DebuggenError, err, isErr } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';
import * as vscode from 'vscode';

import { resolveAuthFilePath } from '../../src/service/auth';
import {
  DEFAULT_HEALTH_PROBE_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  createServiceProcess,
  isServiceReachable,
  parseServiceListenAddress,
} from '../../src/service/process';
import type {
  ServiceCredentialPort,
  ServiceHealthProbe,
  ServiceOutputChannel,
  ServiceProcessState,
  ServiceStatus,
  SpawnLike,
} from '../../src/service/process';
import { SESSION_VIEW_ID as PROVIDER_SESSION_VIEW_ID } from '../../src/views/session-view-provider';
import { SESSIONS_VIEW_ID as TREE_SESSIONS_VIEW_ID } from '../../src/views/sessions-tree';
import {
  EXTENSION_ID,
  SCRATCH_PREFIX,
  SESSIONS_VIEW_ID,
  SESSION_VIEW_ID,
  activateExtensionOnce,
  cleanupScratch,
  closeAllEditors,
  fixtureFile,
  fixtureWorkspaceRoot,
  getExtensionOrFail,
  manifestConfigurationProperties,
  readExtensionManifest,
  stopTrackedProcesses,
} from '../helpers';
import type { ExtensionManifest, ManifestView } from '../helpers';

// ---------------------------------------------------------------------------
// Mocha's bdd globals, as provided by the @vscode/test-cli runner
// ---------------------------------------------------------------------------

/** The part of Mocha's test and hook context (`this`) this suite uses. */
interface MochaRunnableContext {
  timeout(ms: number): unknown;
}

/** A test or hook body: synchronous, or a promise mocha awaits. */
type MochaRunnable = (this: MochaRunnableContext) => void | Promise<void>;

declare function describe(title: string, body: (this: MochaRunnableContext) => void): void;
declare function it(title: string, body: MochaRunnable): void;
declare function before(body: MochaRunnable): void;
declare function after(body: MochaRunnable): void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The activity-bar container the manifest contributes. */
const VIEW_CONTAINER_ID = 'debuggen';

/** The workbench command VS Code registers to reveal {@link VIEW_CONTAINER_ID}. */
const REVEAL_CONTAINER_COMMAND = `workbench.view.extension.${VIEW_CONTAINER_ID}`;

/** The one contributed command this suite executes. */
const START_SERVICE_COMMAND = 'debuggen.startService';

/**
 * The complete activation-event list. Contributed commands activate the
 * extension on their own since VS Code 1.74 (AAP 0.2.4), so any `onCommand:`
 * entry would be redundant; the webview view activates it on first reveal and
 * the `vscode://` handler on its first link.
 */
const EXPECTED_ACTIVATION_EVENTS: readonly string[] = Object.freeze([
  'onUri',
  `onView:${SESSION_VIEW_ID}`,
]);

/** The prefix of an activation event this manifest must never declare. */
const ON_COMMAND_PREFIX = 'onCommand:';

/** The fixture workspace's pinned settings, relative to its root. */
const FIXTURE_SETTINGS_FILE = '.vscode/settings.json';

/** The four settings the fixture pins, in the order they are asserted. */
const PINNED_SETTING_KEYS = Object.freeze([
  'debuggen.autoStartService',
  'debuggen.serviceUrl',
  'debuggen.devServerUrl',
  'debuggen.provider',
] as const);

/**
 * The only states a lifecycle manager may pass through when it is refused a
 * spawn: at rest, the launch attempt it opens, and the latched failure.
 */
const STATES_WITHOUT_SPAWN: readonly ServiceProcessState[] = Object.freeze([
  'idle',
  'starting',
  'failed',
]);

/**
 * How long the activation-time background start-up may still be settling. It
 * is one health probe, which the product bounds by
 * {@link DEFAULT_HEALTH_PROBE_TIMEOUT_MS} plus a half-second race margin; the
 * extra second leaves room for the rejection to reach the process event.
 */
const STARTUP_SETTLE_MS = DEFAULT_HEALTH_PROBE_TIMEOUT_MS + 1_000;

/** The bound on activation, which reads settings and registers providers only. */
const ACTIVATION_TIMEOUT_MS = 60_000;

/**
 * The bound on the start command: comfortably above the start-up timeout a
 * spawned child would impose, so a regression that spawns fails on the
 * elapsed-time assertion with its own message rather than on the mocha
 * timeout.
 */
const START_COMMAND_TIMEOUT_MS = DEFAULT_STARTUP_TIMEOUT_MS + 30_000;

// ---------------------------------------------------------------------------
// Recording seams
// ---------------------------------------------------------------------------

/** A notification level, named after the `vscode.window` function that shows it. */
type NotificationLevel = 'info' | 'warning' | 'error';

/** One notification the product asked `vscode.window` to show. */
interface RecordedNotification {
  readonly level: NotificationLevel;
  readonly args: readonly unknown[];
}

/**
 * The slice of `vscode.window` the product's notifications go through, typed
 * as function properties so replacing and restoring them needs no binding.
 */
interface NotificationWindow {
  showInformationMessage: (...args: unknown[]) => Thenable<unknown>;
  showWarningMessage: (...args: unknown[]) => Thenable<unknown>;
  showErrorMessage: (...args: unknown[]) => Thenable<unknown>;
}

/**
 * Runs `body` with the three `vscode.window.show*Message` functions replaced by
 * recorders that dismiss every notification (resolve `undefined`, as closing
 * it would), and restores the originals in a `finally`, whatever `body` does.
 *
 * The extension and this suite receive the same `vscode` API object (both load
 * from the extension's own directory), so the product's notifications land
 * here; a regression in that assumption shows up as zero recorded
 * notifications, never as a silent pass.
 */
async function withRecordedNotifications<T>(
  recorded: RecordedNotification[],
  body: () => Thenable<T>,
): Promise<T> {
  const editorWindow = vscode.window as unknown as NotificationWindow;
  const originals: NotificationWindow = {
    showInformationMessage: editorWindow.showInformationMessage,
    showWarningMessage: editorWindow.showWarningMessage,
    showErrorMessage: editorWindow.showErrorMessage,
  };
  const recorder =
    (level: NotificationLevel) =>
    (...args: unknown[]): Thenable<unknown> => {
      recorded.push({ level, args });
      return Promise.resolve(undefined);
    };
  editorWindow.showInformationMessage = recorder('info');
  editorWindow.showWarningMessage = recorder('warning');
  editorWindow.showErrorMessage = recorder('error');
  try {
    return await body();
  } finally {
    editorWindow.showInformationMessage = originals.showInformationMessage;
    editorWindow.showWarningMessage = originals.showWarningMessage;
    editorWindow.showErrorMessage = originals.showErrorMessage;
  }
}

/** Everything a lifecycle manager asked of its injected seams. */
interface SeamRecord {
  probes: number;
  readonly spawns: { readonly command: string; readonly args: readonly string[] }[];
  readonly credentialCalls: string[];
  readonly statuses: ServiceStatus[];
  readonly output: string[];
}

/** The failure every recording credential seam answers with; it is never expected to be asked. */
function unexpectedCredentialCall(member: string): DebuggenError {
  return new DebuggenError(
    'INTERNAL',
    `activation suite: the editor credential store was asked for ${member}(), which only a launch that is about to spawn does.`,
  );
}

/**
 * A lifecycle manager from `src/service/process.ts` that reads this window's
 * real `debuggen.*` settings (its default reader) and the extension's real
 * bundled entry, with recording seams for everything that could reach outside
 * the process: the health probe answers "nothing listens" without any I/O,
 * the spawn seam records and refuses, and the credential store records and
 * refuses.
 */
function createRecordingServiceProcess(extensionRoot: vscode.Uri): {
  readonly serviceProcess: ReturnType<typeof createServiceProcess>;
  readonly seams: SeamRecord;
} {
  const seams: SeamRecord = {
    probes: 0,
    spawns: [],
    credentialCalls: [],
    statuses: [],
    output: [],
  };
  const probe: ServiceHealthProbe = {
    health: (): Promise<Result<unknown, DebuggenError>> => {
      seams.probes += 1;
      return Promise.resolve(
        err(
          new DebuggenError(
            'TRANSPORT_DISCONNECTED',
            'activation suite: no service listens at the configured address.',
          ),
        ),
      );
    },
  };
  const credential: ServiceCredentialPort = {
    paths: () => {
      seams.credentialCalls.push('paths');
      return err(unexpectedCredentialCall('paths'));
    },
    ensure: () => {
      seams.credentialCalls.push('ensure');
      return Promise.resolve(err(unexpectedCredentialCall('ensure')));
    },
    waitForCredential: () => {
      seams.credentialCalls.push('waitForCredential');
      return Promise.resolve(err(unexpectedCredentialCall('waitForCredential')));
    },
  };
  const spawn: SpawnLike = (command, args) => {
    seams.spawns.push({ command, args: [...args] });
    throw new Error('activation suite: the spawn seam refuses every call.');
  };
  const outputChannel: ServiceOutputChannel = {
    append: (value) => {
      seams.output.push(value);
    },
    appendLine: (value) => {
      seams.output.push(`${value}\n`);
    },
    clear: () => {
      seams.output.length = 0;
    },
    show: () => {
      seams.output.push('[shown]\n');
    },
    dispose: () => {
      seams.output.push('[disposed]\n');
    },
  };
  const serviceProcess = createServiceProcess({
    paths: {
      serviceMain: vscode.Uri.joinPath(extensionRoot, 'dist', 'service', 'main.js').fsPath,
      servicePromptsDir: vscode.Uri.joinPath(extensionRoot, 'dist', 'service', 'prompts').fsPath,
    },
    probe,
    credential,
    spawn,
    createOutputChannel: () => outputChannel,
  });
  return { serviceProcess, seams };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The views the manifest contributes to `container`, or none. */
function viewsIn(manifest: ExtensionManifest, container: string): readonly ManifestView[] {
  return manifest.contributes.views[container] ?? [];
}

/** The fixture workspace's `.vscode/settings.json`, parsed as the object it must be. */
function readPinnedFixtureSettings(): Readonly<Record<string, unknown>> {
  const file = fixtureFile(FIXTURE_SETTINGS_FILE);
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
    `${file} must hold a JSON object of settings.`,
  );
  return parsed as Readonly<Record<string, unknown>>;
}

/**
 * The run's throwaway `DEBUGGEN_HOME`, after checking it is the one
 * `.vscode-test.mjs` created — `<realpath(os.tmpdir())>/debuggen-vscode-test-XXXXXX/home`
 * — so this suite never reads the developer's real state directory.
 */
function throwawayDebuggenHome(): string {
  const configured = process.env.DEBUGGEN_HOME;
  assert.ok(
    configured !== undefined && path.isAbsolute(configured),
    'DEBUGGEN_HOME must be the absolute throwaway directory .vscode-test.mjs injects; run this suite through `pnpm test:vscode`.',
  );
  const home = fs.realpathSync(configured);
  const tempRoot = fs.realpathSync(os.tmpdir());
  assert.ok(
    home.startsWith(`${tempRoot}${path.sep}`) &&
      path.basename(path.dirname(home)).startsWith(SCRATCH_PREFIX),
    `DEBUGGEN_HOME (${home}) is not a throwaway ${SCRATCH_PREFIX}* directory under ${tempRoot}.`,
  );
  return home;
}

/**
 * The editor credential file's identity — absent, or its inode, size and
 * modification time — so a before/after comparison shows whether anything
 * created, replaced or rewrote it.
 */
function snapshotCredentialFile(): string {
  const file = resolveAuthFilePath();
  assert.ok(!isErr(file), 'the editor credential path must resolve from DEBUGGEN_HOME.');
  const stats = fs.statSync(file.value, { throwIfNoEntry: false });
  return stats === undefined
    ? 'absent'
    : `inode ${String(stats.ino)}, ${String(stats.size)} bytes, modified ${String(stats.mtimeMs)}`;
}

/** A one-line description of a rejection reason, for a failure message. */
function describeRejection(reason: unknown): string {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}`;
  }
  return typeof reason === 'string' ? reason : `a non-Error value (${typeof reason})`;
}

/** The `details.reason` a product failure carries, or `undefined`. */
function failureReason(error: DebuggenError): unknown {
  return error.details?.reason;
}

/** `items`, comma-separated, or `none`. */
function listOrNone(items: readonly string[]): string {
  return items.length === 0 ? 'none' : items.join(', ');
}

/**
 * The window's effective configuration keeps the service absent: every value
 * the fixture pins is in force, `debuggen.autoStartService` is off, and
 * `debuggen.serviceUrl` is a plain-HTTP IPv4 loopback URL — not the product
 * default, which would name a real service port — that the product's own
 * listen-address rule refuses, so no launch can ever get past its address
 * step. Checked by the precondition test and again by every test that runs the
 * lifecycle, so a failed precondition can never be followed by a real start.
 *
 * @returns The configured service URL.
 */
function assertServiceAbsentConfiguration(manifest: ExtensionManifest): string {
  const pinned = readPinnedFixtureSettings();
  const effective = vscode.workspace.getConfiguration();
  for (const key of PINNED_SETTING_KEYS) {
    assert.ok(key in pinned, `${FIXTURE_SETTINGS_FILE} must pin ${key}.`);
    assert.deepEqual(
      effective.get<unknown>(key),
      pinned[key],
      `the effective ${key} must be the value ${FIXTURE_SETTINGS_FILE} pins.`,
    );
  }

  const settings = vscode.workspace.getConfiguration('debuggen');
  assert.equal(
    settings.get<unknown>('autoStartService'),
    false,
    'debuggen.autoStartService must be false: it is what keeps activation from spawning the service.',
  );

  const serviceUrl = settings.get<unknown>('serviceUrl');
  assert.ok(typeof serviceUrl === 'string', 'debuggen.serviceUrl must be a string.');
  const declaredDefault = manifestConfigurationProperties(manifest)['debuggen.serviceUrl']?.default;
  assert.notEqual(
    serviceUrl,
    declaredDefault,
    'the machine-scoped debuggen.serviceUrl must reach this window (.vscode-test.mjs seeds it into the throwaway user settings); the default names a real service port.',
  );
  const url = new URL(serviceUrl);
  assert.equal(url.protocol, 'http:', `debuggen.serviceUrl (${serviceUrl}) must use plain http.`);
  assert.equal(
    url.hostname,
    '127.0.0.1',
    `debuggen.serviceUrl (${serviceUrl}) must stay on the IPv4 loopback address.`,
  );
  const refused = parseServiceListenAddress(serviceUrl);
  assert.ok(
    isErr(refused),
    `the product must refuse to start a service for debuggen.serviceUrl (${serviceUrl}); this suite relies on that refusal to spawn nothing.`,
  );
  assert.equal(refused.error.code, 'CONFIG_INVALID');
  assert.equal(failureReason(refused.error), 'service-url');

  assert.equal(settings.get<unknown>('provider'), 'deterministic');
  assert.equal(process.env.DEBUGGEN_PROVIDER, 'deterministic');
  throwawayDebuggenHome();
  return serviceUrl;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe('Debug Generator activation (src/extension.ts)', () => {
  /** Every rejection nobody handled while this suite ran. */
  const unhandledRejections: unknown[] = [];
  const collectUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };

  let manifest: ExtensionManifest | undefined;

  /** The manifest `before` read; a failed `before` fails every test anyway. */
  function requireManifest(): ExtensionManifest {
    assert.ok(manifest !== undefined, 'the before hook must have read the extension manifest.');
    return manifest;
  }

  before(() => {
    process.on('unhandledRejection', collectUnhandledRejection);
    // Guard on the .vscode-test.mjs contract: the window has the generic
    // fixture workspace open and a throwaway state directory.
    fixtureWorkspaceRoot();
    throwawayDebuggenHome();
    manifest = readExtensionManifest();
  });

  after(async function () {
    this.timeout(ACTIVATION_TIMEOUT_MS);
    process.off('unhandledRejection', collectUnhandledRejection);
    try {
      await closeAllEditors();
    } finally {
      try {
        await cleanupScratch();
      } finally {
        await stopTrackedProcesses();
      }
    }
  });

  it('resolves debuggen.debug-generator and activates it from its built entry point', async function () {
    this.timeout(ACTIVATION_TIMEOUT_MS);
    const found = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(
      found !== undefined,
      `vscode.extensions.getExtension("${EXTENSION_ID}") must resolve.`,
    );
    const declared = requireManifest();
    assert.equal(
      `${declared.publisher}.${declared.name}`,
      EXTENSION_ID,
      'the manifest publisher and name must form the id the suites resolve.',
    );
    const entry = path.join(found.extensionUri.fsPath, declared.main);
    assert.equal(
      fs.statSync(entry, { throwIfNoEntry: false })?.isFile(),
      true,
      `the manifest's main entry ${entry} must be built before the run.`,
    );

    const activated = await activateExtensionOnce();
    assert.equal(activated.id, EXTENSION_ID);
    assert.equal(
      activated.isActive,
      true,
      'the extension must be active once activate() resolved.',
    );

    // Activation is host-wide and idempotent: a fresh lookup sees it, and a
    // second activate() resolves against the same activation.
    const again = getExtensionOrFail();
    await again.activate();
    assert.equal(again.isActive, true);
  });

  it('declares exactly the onUri and onView activation events, and no onCommand entry', () => {
    const events = requireManifest().activationEvents;
    const onCommand = events.filter((event) => event.startsWith(ON_COMMAND_PREFIX));
    assert.deepEqual(
      onCommand,
      [],
      `activationEvents must not list ${ON_COMMAND_PREFIX} entries — contributed commands activate the extension on their own since VS Code 1.74; found: ${listOrNone(onCommand)}.`,
    );

    const expected = new Set(EXPECTED_ACTIVATION_EVENTS);
    const actual = new Set(events);
    const unexpected = [...actual].filter((event) => !expected.has(event));
    const missing = [...expected].filter((event) => !actual.has(event));
    assert.deepEqual(
      { unexpected, missing },
      { unexpected: [], missing: [] },
      `activationEvents must be exactly ${EXPECTED_ACTIVATION_EVENTS.join(', ')}; unexpected: ${listOrNone(unexpected)}; missing: ${listOrNone(missing)}.`,
    );
    assert.equal(
      events.length,
      actual.size,
      `activationEvents repeats an entry: ${events.join(', ')}.`,
    );
  });

  it('contributes the debuggen activity-bar container holding the webview view and the Sessions tree', () => {
    const declared = requireManifest();
    const containers = declared.contributes.viewsContainers?.activitybar ?? [];
    const ours = containers.filter((container) => container.id === VIEW_CONTAINER_ID);
    assert.equal(
      ours.length,
      1,
      `exactly one activity-bar container must have the id ${VIEW_CONTAINER_ID}; found ${String(ours.length)}.`,
    );

    const views = viewsIn(declared, VIEW_CONTAINER_ID);
    assert.deepEqual(
      views.map((view) => view.id),
      [SESSION_VIEW_ID, SESSIONS_VIEW_ID],
      `the ${VIEW_CONTAINER_ID} container must hold exactly the session view and the Sessions tree.`,
    );
    const sessionView = views.find((view) => view.id === SESSION_VIEW_ID);
    assert.equal(sessionView?.type, 'webview', `${SESSION_VIEW_ID} must be a webview view.`);
    const sessionsView = views.find((view) => view.id === SESSIONS_VIEW_ID);
    assert.ok(
      sessionsView !== undefined &&
        (sessionsView.type === undefined || sessionsView.type === 'tree'),
      `${SESSIONS_VIEW_ID} must be a tree view (no type, or "tree"); found ${String(sessionsView?.type)}.`,
    );

    const elsewhere = Object.entries(declared.contributes.views)
      .filter(([container]) => container !== VIEW_CONTAINER_ID)
      .flatMap(([container, list]) =>
        list
          .filter((view) => view.id === SESSION_VIEW_ID || view.id === SESSIONS_VIEW_ID)
          .map((view) => `${container}/${view.id}`),
      );
    assert.deepEqual(
      elsewhere,
      [],
      `no other view container may claim either id; found ${listOrNone(elsewhere)}.`,
    );
  });

  it('restates the view ids identically in the helpers, the view modules and the manifest', () => {
    assert.equal(
      PROVIDER_SESSION_VIEW_ID,
      SESSION_VIEW_ID,
      'src/views/session-view-provider.ts registers the webview view under an id test/helpers.ts does not know.',
    );
    assert.equal(
      TREE_SESSIONS_VIEW_ID,
      SESSIONS_VIEW_ID,
      'src/views/sessions-tree.ts registers the Sessions tree under an id test/helpers.ts does not know.',
    );
    const declared = requireManifest();
    const manifestIds = viewsIn(declared, VIEW_CONTAINER_ID).map((view) => view.id);
    assert.ok(
      manifestIds.includes(PROVIDER_SESSION_VIEW_ID) && manifestIds.includes(TREE_SESSIONS_VIEW_ID),
      `the manifest must declare the ids the providers register under; it declares ${listOrNone(manifestIds)}.`,
    );
    assert.ok(
      declared.activationEvents.includes(`onView:${PROVIDER_SESSION_VIEW_ID}`),
      'the onView activation event must name the id the webview view provider registers under.',
    );
  });

  it('runs with the service absent: auto-start off and a service URL the product refuses to start for', () => {
    assertServiceAbsentConfiguration(requireManifest());
  });

  it("lets the lifecycle manager, fed this window's settings, only probe: nothing spawned, no credential touched", async function () {
    this.timeout(ACTIVATION_TIMEOUT_MS);
    assertServiceAbsentConfiguration(requireManifest());
    const extension = await activateExtensionOnce();
    const serviceMain = vscode.Uri.joinPath(extension.extensionUri, 'dist', 'service', 'main.js');
    assert.equal(
      fs.statSync(serviceMain.fsPath, { throwIfNoEntry: false })?.isFile(),
      true,
      `the bundled service ${serviceMain.fsPath} must exist, so the refusal below is about the address and not a missing bundle.`,
    );

    const { serviceProcess, seams } = createRecordingServiceProcess(extension.extensionUri);
    const subscription = serviceProcess.onDidChangeStatus((status) => {
      seams.statuses.push(status);
    });
    try {
      // What activation does: an automatic request, which must only probe.
      const automatic = await serviceProcess.ensureRunning();
      assert.ok(isErr(automatic), 'an automatic start must fail while nothing listens.');
      assert.equal(automatic.error.code, 'TRANSPORT_DISCONNECTED');
      assert.equal(failureReason(automatic.error), 'auto-start-disabled');
      assert.equal(serviceProcess.status.state, 'idle');
      assert.equal(seams.probes, 1, 'an automatic start must probe exactly once.');

      // What debuggen.startService does: the developer's explicit request,
      // which may spawn — and must refuse to, for this address.
      const explicit = await serviceProcess.ensureRunning({ userInitiated: true });
      assert.ok(isErr(explicit), 'an explicit start must fail for this service URL.');
      assert.equal(explicit.error.code, 'CONFIG_INVALID');
      assert.equal(failureReason(explicit.error), 'service-url');
      assert.equal(serviceProcess.status.state, 'failed');
      assert.equal(serviceProcess.status.pid, undefined);
      assert.equal(seams.probes, 2, 'an explicit start must probe exactly once before refusing.');

      assert.deepEqual(seams.spawns, [], 'the spawn seam must never be called.');
      assert.deepEqual(
        seams.credentialCalls,
        [],
        'the editor credential store must never be asked.',
      );
      assert.ok(seams.statuses.length > 0, 'the status stream must report the transitions.');
      const offending = seams.statuses
        .filter(
          (status) =>
            isServiceReachable(status) ||
            status.pid !== undefined ||
            !STATES_WITHOUT_SPAWN.includes(status.state),
        )
        .map((status) =>
          status.pid === undefined ? status.state : `${status.state} (pid ${String(status.pid)})`,
        );
      assert.deepEqual(
        offending,
        [],
        `the status must stay within ${STATES_WITHOUT_SPAWN.join(', ')} with no pid; it reported ${listOrNone(offending)}.`,
      );
      assert.equal(seams.statuses.at(-1)?.state, 'failed');
    } finally {
      subscription.dispose();
      serviceProcess.dispose();
    }
  });

  it('resolves debuggen.startService with exactly one error notification and spawns nothing', async function () {
    this.timeout(START_COMMAND_TIMEOUT_MS);
    assertServiceAbsentConfiguration(requireManifest());
    await activateExtensionOnce();
    const registered = await vscode.commands.getCommands(true);
    assert.ok(
      registered.includes(START_SERVICE_COMMAND),
      `${START_SERVICE_COMMAND} must be registered once the extension is active.`,
    );

    const credentialBefore = snapshotCredentialFile();
    const notifications: RecordedNotification[] = [];
    const startedAt = Date.now();
    const result = await withRecordedNotifications(notifications, () =>
      vscode.commands.executeCommand<unknown>(START_SERVICE_COMMAND),
    );
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result, undefined, `${START_SERVICE_COMMAND} must resolve without a value.`);
    assert.equal(
      notifications.length,
      1,
      `exactly one notification must report the failure; got ${String(notifications.length)} (${listOrNone(notifications.map((notice) => notice.level))}).`,
    );
    const [notice] = notifications;
    assert.ok(notice !== undefined);
    assert.equal(notice.level, 'error', 'the failure must be reported as an error notification.');
    const [text, ...actions] = notice.args;
    assert.ok(
      typeof text === 'string' && text.trim() !== '',
      'the notification must carry a developer-facing message.',
    );
    assert.ok(
      actions.every((action) => typeof action === 'string'),
      'every offered action must be a label.',
    );
    assert.equal(
      actions.length,
      1,
      'only the output action may be offered: a restart is offered only for a running service of this window, and none may be running.',
    );
    assert.ok(
      elapsedMs < DEFAULT_STARTUP_TIMEOUT_MS,
      `${START_SERVICE_COMMAND} took ${String(elapsedMs)} ms: a launch waited out the ${String(DEFAULT_STARTUP_TIMEOUT_MS)} ms start-up timeout of a spawned child.`,
    );
    assert.equal(
      snapshotCredentialFile(),
      credentialBefore,
      'the editor credential must be neither created nor rewritten: that is the last step a launch takes before it spawns.',
    );
  });

  it('has both views registered with the workbench and reveals their container', async function () {
    this.timeout(ACTIVATION_TIMEOUT_MS);
    await activateExtensionOnce();
    const commands = new Set(await vscode.commands.getCommands(true));
    const focusCommands = [`${SESSION_VIEW_ID}.focus`, `${SESSIONS_VIEW_ID}.focus`];
    const missing = focusCommands.filter((command) => !commands.has(command));
    assert.deepEqual(
      missing,
      [],
      `VS Code registers <view id>.focus for every contributed view; missing: ${listOrNone(missing)}.`,
    );
    assert.ok(
      commands.has(REVEAL_CONTAINER_COMMAND),
      `VS Code registers ${REVEAL_CONTAINER_COMMAND} for the contributed container.`,
    );

    await vscode.commands.executeCommand<unknown>(REVEAL_CONTAINER_COMMAND);
    assert.equal(getExtensionOrFail().isActive, true);
  });

  it('leaves no promise rejection unhandled across activation, the start command and the view reveal', async function () {
    this.timeout(STARTUP_SETTLE_MS + 10_000);
    // Activation's background start-up is one bounded health probe; wait it
    // out so a rejection from it has reached the process event.
    await delay(STARTUP_SETTLE_MS);
    assert.deepEqual(
      unhandledRejections.map(describeRejection),
      [],
      'no promise may be rejected without a handler while the extension activates and runs.',
    );
  });
});
