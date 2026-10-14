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
 * A second suite, `Debug Generator activation: service process supervision
 * and shutdown`, holds the lifecycle manager and deactivation's
 * `stopServiceForShutdown` to the ordering AAP 0.5.1 depends on, through fully
 * fake seams — a fake child process that records every signal, a health probe
 * that follows the configured URL the way the real client does and answers
 * only where a fake responder listens, settings held in memory — so nothing is
 * spawned, no socket is opened and no file is touched. It asserts that a child
 * exiting while a stop waits is not restarted; that a changed
 * `debuggen.serviceUrl` never stops, signals or replaces the live child and
 * never attributes another origin's answer to it, while `restart()` still
 * moves it; and that deactivation's stop signals the child only after the end
 * request's bound, force-stops it only when the end concluded, keeps
 * ownership of the child when `dispose()` follows at once, and finishes
 * inside the extension host's shutdown window.
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

import { DebuggenError, createConsoleLogger, err, isErr, isOk, ok } from '@debuggen/shared';
import type { LogRecord, Logger, Result } from '@debuggen/shared';
import * as vscode from 'vscode';

import {
  DEACTIVATE_BUDGET_MS,
  DEACTIVATE_END_SESSION_TIMEOUT_MS,
  DEACTIVATE_QUIESCE_TIMEOUT_MS,
  DEACTIVATE_STOP_GRACE_MS,
  stopServiceForShutdown,
} from '../../src/extension';
import type { ShutdownEndOutcome } from '../../src/extension';
import { resolveAuthFilePath } from '../../src/service/auth';
import {
  DEFAULT_HEALTH_PROBE_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  createServiceProcess,
  isServiceReachable,
  parseServiceListenAddress,
} from '../../src/service/process';
import type {
  ChildProcessLike,
  ServiceCredentialPort,
  ServiceHealthProbe,
  ServiceOutputChannel,
  ServiceProcess,
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
  createScratchDir,
  fixtureFile,
  fixtureWorkspaceRoot,
  getExtensionOrFail,
  manifestConfigurationProperties,
  readExtensionManifest,
  stopTrackedProcesses,
  writeFixtureFile,
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

// ---------------------------------------------------------------------------
// Service process supervision and shutdown: fake seams
// ---------------------------------------------------------------------------

/**
 * The service URL every supervised manager starts with. A plain-HTTP IPv4
 * loopback URL whose port `parseServiceListenAddress` accepts (it is not one
 * the Fetch standard blocks); nothing ever listens on it, because the fake
 * spawn seam starts no process.
 */
const SUPERVISED_SERVICE_URL = 'http://127.0.0.1:20047';

/** Where `debuggen.serviceUrl` moves to in the address-move tests. */
const MOVED_SERVICE_URL = 'http://127.0.0.1:20048';

/**
 * How long the extension host lets deactivation run before VS Code
 * terminates it — the window `DEACTIVATE_BUDGET_MS` must stay inside.
 */
const EXTENSION_HOST_SHUTDOWN_MS = 5_000;

/** The supervised manager's own timings: short enough for a suite, ordered enough to be deterministic. */
const SUPERVISION_TIMINGS = Object.freeze({
  restartDelayMs: 50,
  stopGraceMs: 200,
  quiesceTimeoutMs: 500,
  healthPollIntervalMs: 20,
  slowStartPollIntervalMs: 50,
  healthProbeTimeoutMs: 200,
  startupTimeoutMs: 2_000,
});

/**
 * How long a test keeps watching after the point where a regression would have
 * spawned a replacement: several restart delays, so a scheduled restart has
 * certainly fired, probed and spawned by then.
 */
const RESPAWN_WATCH_MS = SUPERVISION_TIMINGS.restartDelayMs * 8;

/**
 * Timer slack for lower-bound assertions: a timer never fires early, but two
 * `Date.now()` readings on either side of it may disagree by a few
 * milliseconds.
 */
const TIMER_TOLERANCE_MS = 25;

/** The editor credential the fake store hands out; not secret-shaped, never persisted. */
const FAKE_EDITOR_TOKEN = 'supervision-suite-editor-token';

/** How a fake child answers `SIGTERM`: exit at once, or keep running (only `SIGKILL` ends it then). */
type SigtermBehaviour = 'exit' | 'ignore';

/** The listener shape of a child's `exit` event. */
type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

/** One signal a fake child received, and when. */
interface ReceivedSignal {
  readonly signal: NodeJS.Signals;
  readonly atMs: number;
}

/**
 * A child process that exists only in this suite: it "listens" on the origin
 * it was told to bind (the probe answers there while it is alive), records
 * every signal with its arrival time, and exits the way a real child does —
 * asynchronously after `kill()`, or when a test ends it with
 * {@link FakeServiceChild.emitExit}. It never fails to spawn, so its `error`
 * listeners are accepted and never called.
 *
 * {@link FakeServiceChild.serveEndRequest} models the one behaviour of the
 * real service the shutdown tests turn on: `POST /sessions/:id/end` is served
 * to completion after its client stopped waiting (the route observes no
 * disconnect; it waits for a cancelled install to settle, then restores), and
 * any signal interrupts it (today's `SIGTERM` shutdown disposes the cleanup
 * runner; `SIGKILL` ends everything).
 */
class FakeServiceChild implements ChildProcessLike {
  readonly pid: number;
  readonly origin: string;
  readonly stdout = null;
  readonly stderr = null;
  readonly signals: ReceivedSignal[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly #sigterm: SigtermBehaviour;
  readonly #exitListeners: ExitListener[] = [];
  #exited = false;
  #cancelEndRequest: (() => void) | undefined;
  #endRequestInterrupted = false;

  constructor(pid: number, origin: string, sigterm: SigtermBehaviour) {
    this.pid = pid;
    this.origin = origin;
    this.#sigterm = sigterm;
  }

  /** Whether the process has not exited yet, i.e. still answers at its origin. */
  get alive(): boolean {
    return !this.#exited;
  }

  /** The names of the signals received, in order. */
  get signalNames(): NodeJS.Signals[] {
    return this.signals.map((received) => received.signal);
  }

  /** Whether a signal or an exit arrived while an accepted end request was still being served. */
  get endRequestInterrupted(): boolean {
    return this.#endRequestInterrupted;
  }

  /**
   * Accepts an end request whose restore — `restore`, run once — completes
   * `afterMs` from now, unless a signal or an exit interrupts it first.
   */
  serveEndRequest(afterMs: number, restore: () => void): void {
    const timer = setTimeout(() => {
      this.#cancelEndRequest = undefined;
      restore();
    }, afterMs);
    this.#cancelEndRequest = () => {
      clearTimeout(timer);
      this.#cancelEndRequest = undefined;
      this.#endRequestInterrupted = true;
    };
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    const name: NodeJS.Signals = typeof signal === 'string' ? signal : 'SIGTERM';
    this.signals.push({ signal: name, atMs: Date.now() });
    if (this.#exited) {
      return false;
    }
    this.#cancelEndRequest?.();
    if (name === 'SIGKILL' || this.#sigterm === 'exit') {
      setImmediate(() => {
        this.emitExit(null, name);
      });
    }
    return true;
  }

  on(event: 'exit', listener: ExitListener): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit' | 'error', listener: ExitListener | ((error: Error) => void)): this {
    if (event === 'exit') {
      this.#exitListeners.push(listener as ExitListener);
    }
    return this;
  }

  /** Ends the process — a crash, a finished shutdown — once; later calls do nothing. */
  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exited) {
      return;
    }
    this.#cancelEndRequest?.();
    this.#exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    for (const listener of [...this.#exitListeners]) {
      listener(code, signal);
    }
  }
}

/** A manager from `src/service/process.ts` wired to fake seams, and the handles a test drives it with. */
interface SupervisionHarness {
  readonly serviceProcess: ServiceProcess;
  /** Every fake child spawned, oldest first. */
  readonly children: FakeServiceChild[];
  /** Every record the manager (and the shutdown helper, when handed {@link logger}) logged. */
  readonly logs: LogRecord[];
  /** A logger writing into {@link logs}. */
  readonly logger: Logger;
  /** Health probes issued so far. */
  readonly probeCount: () => number;
  /** Moves `debuggen.serviceUrl`; the probe follows it at once, as `client.ts` does. */
  setServiceUrl(url: string): void;
  /** Registers a service this manager did not start, answering at `url`'s origin. */
  addExternalResponder(url: string): void;
  /** Makes every later probe take `ms` before it answers. */
  setProbeDelay(ms: number): void;
  /** The only child spawned so far; fails the test when there is not exactly one. */
  onlyChild(): FakeServiceChild;
  /** Disposes the manager and ends every fake child still alive, so no test leaves one behind. */
  dispose(): void;
}

/**
 * Builds a {@link SupervisionHarness}: auto-start on, the provider default
 * `deterministic`, a fake bundle whose files all "exist", a configured Node
 * runtime that "is executable", a credential store that always succeeds, and
 * no configuration events (the manager's own handling is what is exercised).
 */
function createSupervisionHarness(sigterm: SigtermBehaviour = 'exit'): SupervisionHarness {
  const children: FakeServiceChild[] = [];
  const externalOrigins = new Set<string>();
  const logs: LogRecord[] = [];
  const logger = createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      logs.push(record);
    },
  });
  let serviceUrl = SUPERVISED_SERVICE_URL;
  let probeDelayMs = 0;
  let probes = 0;
  let nextPid = 7_001;

  const answersAt = (origin: string): boolean =>
    externalOrigins.has(origin) || children.some((child) => child.alive && child.origin === origin);

  const probe: ServiceHealthProbe = {
    health: async (): Promise<Result<unknown, DebuggenError>> => {
      probes += 1;
      // Read when the request is issued: the real client sends it to the base
      // URL it holds at that moment.
      const target = new URL(serviceUrl).origin;
      if (probeDelayMs > 0) {
        await delay(probeDelayMs);
      }
      return answersAt(target)
        ? ok({ status: 'ok' })
        : err(
            new DebuggenError(
              'TRANSPORT_DISCONNECTED',
              `supervision suite: nothing answers at ${target}.`,
            ),
          );
    },
  };

  const spawn: SpawnLike = (command, args, options) => {
    const host = options.env.DEBUGGEN_HOST;
    const port = options.env.DEBUGGEN_PORT;
    assert.ok(
      host !== undefined && port !== undefined,
      `the service must be told where to listen (spawned ${command} ${args.join(' ')}).`,
    );
    const child = new FakeServiceChild(nextPid, new URL(`http://${host}:${port}`).origin, sigterm);
    nextPid += 1;
    children.push(child);
    return child;
  };

  const credential: ServiceCredentialPort = {
    paths: () =>
      ok({
        debuggenHome: '/supervision-suite/home',
        authFilePath: '/supervision-suite/home/auth.json',
      }),
    ensure: () => Promise.resolve(ok(FAKE_EDITOR_TOKEN)),
    waitForCredential: () => Promise.resolve(ok(FAKE_EDITOR_TOKEN)),
  };

  // The service output channel is not what these tests assert on (the log
  // records are); it only has to accept writes.
  const outputChannel: ServiceOutputChannel = {
    append: () => undefined,
    appendLine: () => undefined,
    clear: () => undefined,
    show: () => undefined,
    dispose: () => undefined,
  };

  const serviceProcess = createServiceProcess({
    paths: {
      serviceMain: '/supervision-suite/extension/dist/service/main.js',
      servicePromptsDir: '/supervision-suite/extension/dist/service/prompts',
    },
    probe,
    credential,
    nodePath: '/supervision-suite/bin/node',
    isExecutable: () => true,
    pathKind: (target) => (target.endsWith('prompts') ? 'directory' : 'file'),
    env: { PATH: '/supervision-suite/bin' },
    spawn,
    readSettings: () => ({
      autoStartService: true,
      serviceUrl,
      providerExplicit: undefined,
      providerDefault: 'deterministic',
    }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    createOutputChannel: () => outputChannel,
    logger,
    restartPolicy: {
      initialDelayMs: SUPERVISION_TIMINGS.restartDelayMs,
      maxDelayMs: SUPERVISION_TIMINGS.restartDelayMs * 4,
      factor: 2,
      maxAttempts: 3,
      stableAfterMs: 60_000,
    },
    startupTimeoutMs: SUPERVISION_TIMINGS.startupTimeoutMs,
    healthPollIntervalMs: SUPERVISION_TIMINGS.healthPollIntervalMs,
    slowStartPollIntervalMs: SUPERVISION_TIMINGS.slowStartPollIntervalMs,
    healthProbeTimeoutMs: SUPERVISION_TIMINGS.healthProbeTimeoutMs,
    stopGraceMs: SUPERVISION_TIMINGS.stopGraceMs,
    quiesceTimeoutMs: SUPERVISION_TIMINGS.quiesceTimeoutMs,
  });

  return {
    serviceProcess,
    children,
    logs,
    logger,
    probeCount: () => probes,
    setServiceUrl: (url) => {
      serviceUrl = url;
    },
    addExternalResponder: (url) => {
      externalOrigins.add(new URL(url).origin);
    },
    setProbeDelay: (ms) => {
      probeDelayMs = ms;
    },
    onlyChild: () => {
      assert.equal(
        children.length,
        1,
        `exactly one service child must have been spawned; got ${String(children.length)}.`,
      );
      const [child] = children;
      assert.ok(child !== undefined);
      return child;
    },
    dispose: () => {
      serviceProcess.dispose();
      for (const child of children) {
        child.emitExit(0, null);
      }
    },
  };
}

/** A promise and the function that resolves it. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

/** A promise a test settles when it chooses — an end request still in flight, say. */
function deferred<T>(): Deferred<T> {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value) => settle(value) };
}

/** Polls `condition` every few milliseconds until it holds, failing after `timeoutMs`. */
async function waitUntil(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(
      Date.now() < deadline,
      `timed out after ${String(timeoutMs)} ms waiting for ${what}.`,
    );
    await delay(5);
  }
}

/** Starts the harness's service and asserts it is this window's `running` child. */
async function startSupervisedChild(harness: SupervisionHarness): Promise<FakeServiceChild> {
  const started = await harness.serviceProcess.ensureRunning();
  assert.ok(
    isOk(started),
    `the supervised service must start: ${isErr(started) ? started.error.message : ''}`,
  );
  const child = harness.onlyChild();
  assert.equal(harness.serviceProcess.status.state, 'running');
  assert.equal(harness.serviceProcess.status.mode, 'embedded');
  assert.equal(harness.serviceProcess.status.pid, child.pid);
  assert.equal(child.origin, new URL(SUPERVISED_SERVICE_URL).origin);
  return child;
}

/** Whether any log record's message contains `fragment` at `level`. */
function logged(logs: readonly LogRecord[], level: LogRecord['level'], fragment: string): boolean {
  return logs.some((record) => record.level === level && record.message.includes(fragment));
}

// ---------------------------------------------------------------------------
// Service process supervision and shutdown: the suite
// ---------------------------------------------------------------------------

describe('Debug Generator activation: service process supervision and shutdown', () => {
  after(async function () {
    this.timeout(ACTIVATION_TIMEOUT_MS);
    // The slow-install test writes a real file under a scratch directory.
    await cleanupScratch();
  });

  it('carves every deactivation step out of one budget inside the extension host shutdown window', () => {
    assert.ok(
      DEACTIVATE_QUIESCE_TIMEOUT_MS + DEACTIVATE_STOP_GRACE_MS <= DEACTIVATE_BUDGET_MS,
      `the quiesce bound (${String(DEACTIVATE_QUIESCE_TIMEOUT_MS)} ms) and the stop grace (${String(DEACTIVATE_STOP_GRACE_MS)} ms) must fit the ${String(DEACTIVATE_BUDGET_MS)} ms budget.`,
    );
    assert.ok(
      DEACTIVATE_BUDGET_MS < EXTENSION_HOST_SHUTDOWN_MS,
      `the deactivation budget (${String(DEACTIVATE_BUDGET_MS)} ms) must end before VS Code terminates the extension host.`,
    );
    assert.ok(
      DEACTIVATE_END_SESSION_TIMEOUT_MS < DEACTIVATE_QUIESCE_TIMEOUT_MS,
      "the stop must wait out the end request's own bound before it acts on the child, so a timed-out end is known to be in progress.",
    );
    assert.ok(DEACTIVATE_STOP_GRACE_MS > 0, 'the child must get a grace window after SIGTERM.');
  });

  it('does not restart a child that exits while stop() waits for an in-flight end request', async function () {
    this.timeout(15_000);
    const harness = createSupervisionHarness();
    try {
      const child = await startSupervisedChild(harness);
      const endRequest = deferred<undefined>();
      const stopping = harness.serviceProcess.stop({
        awaitInFlight: endRequest.promise,
        quiesceTimeoutMs: 10_000,
      });

      // The service crashes while the stop is still quiescing.
      child.emitExit(1, null);
      await delay(RESPAWN_WATCH_MS);
      assert.equal(
        harness.children.length,
        1,
        'a child that exited during stop() must not be replaced while the stop waits.',
      );
      assert.equal(harness.serviceProcess.status.state, 'stopped');

      endRequest.resolve(undefined);
      await stopping;
      await delay(RESPAWN_WATCH_MS);
      assert.equal(
        harness.children.length,
        1,
        'nothing may be spawned after stop() resolved either.',
      );
      assert.equal(harness.serviceProcess.status.state, 'stopped');
      assert.equal(harness.serviceProcess.status.pid, undefined);
      assert.deepEqual(child.signalNames, [], 'a child that already exited is never signalled.');
      assert.ok(logged(harness.logs, 'info', 'exited while it was being stopped'));

      // The stop keeps holding off automatic starts.
      const automatic = await harness.serviceProcess.ensureRunning();
      assert.ok(isErr(automatic), 'an automatic start must not undo a requested stop.');
      assert.equal(failureReason(automatic.error), 'stopped');
      assert.equal(harness.children.length, 1);
    } finally {
      harness.dispose();
    }
  });

  it('abandons a scheduled restart whose probe is still running when stop() is called', async function () {
    this.timeout(15_000);
    const harness = createSupervisionHarness();
    try {
      const child = await startSupervisedChild(harness);
      const probeDelayMs = SUPERVISION_TIMINGS.restartDelayMs * 6;
      harness.setProbeDelay(probeDelayMs);
      const probesBefore = harness.probeCount();

      // A crash schedules a restart; its timer fires and its probe begins.
      child.emitExit(1, null);
      assert.equal(harness.serviceProcess.status.state, 'starting');
      await waitUntil(
        () => harness.probeCount() > probesBefore,
        5_000,
        'the scheduled restart to probe',
      );

      await harness.serviceProcess.stop();
      assert.equal(harness.serviceProcess.status.state, 'stopped');

      await delay(probeDelayMs + RESPAWN_WATCH_MS);
      assert.equal(
        harness.children.length,
        1,
        'a restart whose probe was running when stop() was called must not launch a child.',
      );
      assert.equal(harness.serviceProcess.status.state, 'stopped');
      assert.ok(logged(harness.logs, 'info', 'a stop was requested before the scheduled restart'));
    } finally {
      harness.dispose();
    }
  });

  it('keeps the running child when debuggen.serviceUrl moves to an address where nothing answers, until restart() moves it', async function () {
    this.timeout(15_000);
    const harness = createSupervisionHarness();
    try {
      const child = await startSupervisedChild(harness);
      harness.setServiceUrl(MOVED_SERVICE_URL);

      for (const userInitiated of [false, true]) {
        const label = userInitiated ? 'a user-initiated' : 'an automatic';
        const result = await harness.serviceProcess.ensureRunning({ userInitiated });
        assert.ok(isErr(result), `${label} ensureRunning must report the move, not succeed.`);
        assert.equal(result.error.code, 'TRANSPORT_DISCONNECTED');
        assert.equal(failureReason(result.error), 'service-url-changed');
        assert.ok(
          result.error.message.includes(new URL(MOVED_SERVICE_URL).origin) &&
            result.error.message.includes(child.origin),
          `the failure must name both origins; it says: ${result.error.message}`,
        );
        const status = harness.serviceProcess.status;
        assert.equal(status.state, 'running', `${label} call must leave the child reported.`);
        assert.equal(status.mode, 'embedded');
        assert.equal(status.pid, child.pid, `${label} call must not replace the child.`);
        assert.equal(status.settingsChanged, true);
        assert.equal(
          harness.children.length,
          1,
          `${label} call must not spawn a replacement for the moved child.`,
        );
        assert.deepEqual(
          child.signalNames,
          [],
          `${label} call must never signal the child: it may still hold a session to end.`,
        );
      }

      // The developer's explicit restart is what moves it.
      const restarted = await harness.serviceProcess.restart();
      assert.ok(
        isOk(restarted),
        `restart() must move the service: ${isErr(restarted) ? restarted.error.message : ''}`,
      );
      assert.deepEqual(child.signalNames, ['SIGTERM'], 'restart() stops the old child gracefully.');
      assert.equal(child.alive, false);
      assert.equal(harness.children.length, 2, 'restart() spawns exactly one replacement.');
      const replacement = harness.children[1];
      assert.ok(replacement !== undefined);
      assert.equal(replacement.origin, new URL(MOVED_SERVICE_URL).origin);
      assert.equal(harness.serviceProcess.status.state, 'running');
      assert.equal(harness.serviceProcess.status.pid, replacement.pid);
      assert.equal(harness.serviceProcess.status.settingsChanged, false);
    } finally {
      harness.dispose();
    }
  });

  it('classifies a service answering at the new debuggen.serviceUrl as external and restores the child when the URL is set back', async function () {
    this.timeout(15_000);
    const harness = createSupervisionHarness();
    try {
      const child = await startSupervisedChild(harness);
      harness.addExternalResponder(MOVED_SERVICE_URL);
      harness.setServiceUrl(MOVED_SERVICE_URL);

      const moved = await harness.serviceProcess.ensureRunning();
      assert.ok(isOk(moved), 'the service answering at the new URL must be usable.');
      assert.equal(moved.value.state, 'external');
      assert.equal(moved.value.mode, 'external');
      assert.equal(
        moved.value.pid,
        undefined,
        "another origin's answer must not be attributed to this window's child.",
      );
      assert.equal(moved.value.settingsChanged, true);
      assert.deepEqual(child.signalNames, [], 'the child must be kept, not signalled.');
      assert.equal(child.alive, true);
      assert.equal(harness.children.length, 1);

      harness.setServiceUrl(SUPERVISED_SERVICE_URL);
      const reverted = await harness.serviceProcess.ensureRunning();
      assert.ok(isOk(reverted), 'the kept child must answer again once the URL names it.');
      assert.equal(reverted.value.state, 'running');
      assert.equal(reverted.value.mode, 'embedded');
      assert.equal(reverted.value.pid, child.pid);
      assert.equal(reverted.value.error, undefined);
      assert.deepEqual(child.signalNames, []);
      assert.equal(harness.children.length, 1);
    } finally {
      harness.dispose();
    }
  });

  it('lets a slow-install end finish past the shutdown budget: the child is released unsignalled and restores the file without a service start', async function () {
    this.timeout(20_000);
    // The real SIGTERM shutdown ends the service (and disposes its cleanup
    // runner), so a signal here would interrupt the restore.
    const harness = createSupervisionHarness('exit');
    try {
      const child = await startSupervisedChild(harness);
      const workspace = createScratchDir('supervision-slow-install-');
      const original = 'export function placeOrder(): string {\n  return "original";\n}\n';
      const instrumented = `${original}// instrumented by the supervision suite\n`;
      const file = writeFixtureFile(workspace, 'src/orders.ts', instrumented);

      // The service accepted `POST /sessions/:id/end`: it waits for a
      // cancelled install to settle, then restores the file — later than the
      // editor's whole shutdown budget.
      const restoreAfterMs = DEACTIVATE_BUDGET_MS + 1_000;
      child.serveEndRequest(restoreAfterMs, () => {
        fs.writeFileSync(file, original);
      });
      // What `endActiveSession` resolves to once the client's own timeout
      // fired (`details.cancelled === 'timeout'`), registered with the manager.
      const ending = harness.serviceProcess.keepAliveFor(
        delay(DEACTIVATE_END_SESSION_TIMEOUT_MS).then((): ShutdownEndOutcome => 'in-progress'),
      );

      const startedAt = Date.now();
      const stopping = stopServiceForShutdown(harness.serviceProcess, ending, harness.logger);
      // VS Code disposes context.subscriptions right after deactivate() returned its promise.
      harness.serviceProcess.dispose();
      const outcome = await stopping;
      const elapsedMs = Date.now() - startedAt;

      assert.equal(outcome, 'in-progress');
      assert.ok(
        elapsedMs >= DEACTIVATE_END_SESSION_TIMEOUT_MS - TIMER_TOLERANCE_MS,
        `the stop acted on the child ${String(elapsedMs)} ms in, before the end request's ${String(DEACTIVATE_END_SESSION_TIMEOUT_MS)} ms bound.`,
      );
      assert.ok(
        elapsedMs < EXTENSION_HOST_SHUTDOWN_MS,
        `the shutdown stop took ${String(elapsedMs)} ms; it must finish before VS Code terminates the host.`,
      );
      assert.deepEqual(child.signalNames, [], 'an end still being served must not be signalled.');
      assert.equal(child.alive, true, 'the released child keeps running to finish the end.');
      assert.equal(
        fs.readFileSync(file, 'utf8'),
        instrumented,
        'the restore is still pending when the editor has finished shutting down.',
      );
      assert.equal(harness.serviceProcess.status.state, 'stopped');
      assert.equal(harness.serviceProcess.status.pid, undefined);
      assert.ok(logged(harness.logs, 'warn', 'left running, unsignalled'));
      assert.ok(logged(harness.logs, 'warn', 'was still in progress at shutdown'));

      // The service finishes on its own schedule, with nothing restarted.
      await waitUntil(
        () => fs.readFileSync(file, 'utf8') === original,
        restoreAfterMs + 2_000,
        'the released service to restore the instrumented file',
      );
      assert.equal(child.endRequestInterrupted, false, 'the end request ran to completion.');
      assert.deepEqual(child.signalNames, [], 'nothing signalled the child while it restored.');
      assert.equal(harness.children.length, 1, 'restoring needed no service start.');

      // It then exits on its own; the released child is not supervised.
      child.emitExit(0, null);
      await delay(RESPAWN_WATCH_MS);
      assert.equal(harness.children.length, 1, 'a released child that exits is not restarted.');
    } finally {
      harness.dispose();
    }
  });

  it('releases a child whose end request has not settled by the quiesce bound, and keeps it released when dispose() follows', async function () {
    this.timeout(20_000);
    const harness = createSupervisionHarness('exit');
    const endRequest = deferred<ShutdownEndOutcome>();
    try {
      const child = await startSupervisedChild(harness);
      child.serveEndRequest(DEACTIVATE_BUDGET_MS * 3, () => undefined);
      const ending = harness.serviceProcess.keepAliveFor(endRequest.promise);

      const startedAt = Date.now();
      const stopping = stopServiceForShutdown(harness.serviceProcess, ending, harness.logger);
      harness.serviceProcess.dispose();

      // Past the manager's own quiesce bound and grace window, which a
      // termination started by dispose() would have used.
      await delay(DEACTIVATE_QUIESCE_TIMEOUT_MS - 500);
      assert.deepEqual(child.signalNames, [], 'nothing may signal the child within the bound.');

      const outcome = await stopping;
      const elapsedMs = Date.now() - startedAt;
      assert.equal(outcome, undefined, 'the end had not settled when the stop acted.');
      assert.ok(elapsedMs >= DEACTIVATE_QUIESCE_TIMEOUT_MS - TIMER_TOLERANCE_MS);
      assert.ok(elapsedMs < EXTENSION_HOST_SHUTDOWN_MS);
      assert.ok(logged(harness.logs, 'warn', 'left running, unsignalled'));
      assert.ok(logged(harness.logs, 'warn', 'was still in progress at shutdown'));

      // No late signal from the stop's grace window or from dispose().
      await delay(DEACTIVATE_STOP_GRACE_MS + SUPERVISION_TIMINGS.stopGraceMs * 3);
      assert.deepEqual(child.signalNames, []);
      assert.equal(child.alive, true);
      assert.equal(child.endRequestInterrupted, false);
      assert.equal(harness.children.length, 1);
    } finally {
      endRequest.resolve('in-progress');
      harness.dispose();
    }
  });

  it('sends a child whose end was refused SIGTERM only, never SIGKILL', async function () {
    this.timeout(20_000);
    const harness = createSupervisionHarness('ignore');
    try {
      const child = await startSupervisedChild(harness);
      const ending = harness.serviceProcess.keepAliveFor(
        delay(50).then((): ShutdownEndOutcome => 'not-ended'),
      );

      const startedAt = Date.now();
      const stopping = stopServiceForShutdown(harness.serviceProcess, ending, harness.logger);
      harness.serviceProcess.dispose();
      const outcome = await stopping;
      const elapsedMs = Date.now() - startedAt;

      assert.equal(outcome, 'not-ended');
      assert.deepEqual(
        child.signalNames,
        ['SIGTERM'],
        'a refused end leaves the service to run its own shutdown: SIGTERM, never SIGKILL.',
      );
      const [sigterm] = child.signals;
      assert.ok(sigterm !== undefined);
      assert.ok(
        sigterm.atMs - startedAt < DEACTIVATE_QUIESCE_TIMEOUT_MS,
        'a settled end must let the stop act without waiting out the quiesce bound.',
      );
      assert.ok(elapsedMs < EXTENSION_HOST_SHUTDOWN_MS);
      assert.ok(logged(harness.logs, 'warn', 'leaving it to finish shutting down on its own'));
      assert.ok(logged(harness.logs, 'warn', 'did not conclude before shutdown'));
      assert.ok(!logged(harness.logs, 'warn', 'left running, unsignalled'));

      await delay(SUPERVISION_TIMINGS.stopGraceMs * 3);
      assert.deepEqual(child.signalNames, ['SIGTERM'], 'no late escalation either.');
      assert.equal(harness.children.length, 1);
    } finally {
      harness.dispose();
    }
  });

  it('stops rather than releases a child that debuggen.serviceUrl no longer names', async function () {
    this.timeout(15_000);
    const harness = createSupervisionHarness('exit');
    try {
      const child = await startSupervisedChild(harness);
      // The awaited request went to the new address, so this child is not
      // the one carrying it out.
      harness.setServiceUrl(MOVED_SERVICE_URL);

      await harness.serviceProcess.stop({
        release: true,
        graceMs: SUPERVISION_TIMINGS.stopGraceMs,
      });

      assert.deepEqual(child.signalNames, ['SIGTERM']);
      assert.equal(child.alive, false);
      assert.equal(harness.serviceProcess.status.state, 'stopped');
      assert.ok(logged(harness.logs, 'info', 'no longer listens where the awaited request went'));
      assert.ok(!logged(harness.logs, 'warn', 'left running, unsignalled'));
    } finally {
      harness.dispose();
    }
  });

  it('treats a release decision that throws as a release', async function () {
    this.timeout(15_000);
    const harness = createSupervisionHarness('exit');
    try {
      const child = await startSupervisedChild(harness);
      await harness.serviceProcess.stop({
        release: () => {
          throw new Error('supervision suite: the release decision failed.');
        },
      });
      assert.deepEqual(
        child.signalNames,
        [],
        'an undecidable release must not interrupt a restore.',
      );
      assert.equal(child.alive, true);
      assert.equal(harness.serviceProcess.status.state, 'stopped');
      assert.ok(logged(harness.logs, 'warn', 'deciding whether to release the service failed'));
    } finally {
      harness.dispose();
    }
  });

  it('never signals a released child again: ensureRunning uses it as external, and stop(), restart() and dispose() leave it running', async function () {
    this.timeout(15_000);
    const harness = createSupervisionHarness('exit');
    try {
      const child = await startSupervisedChild(harness);
      await harness.serviceProcess.stop({ release: true });
      assert.deepEqual(child.signalNames, []);

      const found = await harness.serviceProcess.ensureRunning();
      assert.ok(isOk(found), 'the released service still answers and must be usable.');
      assert.equal(found.value.state, 'external');
      assert.equal(found.value.mode, 'external');
      assert.equal(found.value.pid, undefined, 'a released child is no longer reported as ours.');

      await harness.serviceProcess.stop({ graceMs: SUPERVISION_TIMINGS.stopGraceMs });
      const restarted = await harness.serviceProcess.restart();
      assert.ok(isErr(restarted), 'a released child is not restarted from this window.');
      assert.equal(failureReason(restarted.error), 'external');

      harness.serviceProcess.dispose();
      await delay(SUPERVISION_TIMINGS.quiesceTimeoutMs + SUPERVISION_TIMINGS.stopGraceMs * 3);
      assert.deepEqual(child.signalNames, [], 'no later stop, restart or dispose signals it.');
      assert.equal(child.alive, true);
      assert.equal(harness.children.length, 1, 'nothing was spawned beside it.');
    } finally {
      harness.dispose();
    }
  });

  it('force-stops a child that ignores SIGTERM once the grace window passes after the end concluded', async function () {
    this.timeout(20_000);
    const harness = createSupervisionHarness('ignore');
    try {
      const child = await startSupervisedChild(harness);
      const ending = harness.serviceProcess.keepAliveFor(
        delay(50).then((): ShutdownEndOutcome => 'ended'),
      );

      const startedAt = Date.now();
      const stopping = stopServiceForShutdown(harness.serviceProcess, ending, harness.logger);
      harness.serviceProcess.dispose();
      const outcome = await stopping;
      const elapsedMs = Date.now() - startedAt;

      assert.equal(outcome, 'ended');
      assert.deepEqual(child.signalNames, ['SIGTERM', 'SIGKILL']);
      assert.equal(child.alive, false);
      const [sigterm, sigkill] = child.signals;
      assert.ok(sigterm !== undefined && sigkill !== undefined);
      assert.ok(
        sigterm.atMs - startedAt < DEACTIVATE_QUIESCE_TIMEOUT_MS,
        'a concluded end must let the stop signal the child without waiting out the quiesce bound.',
      );
      assert.ok(
        sigkill.atMs - sigterm.atMs >= DEACTIVATE_STOP_GRACE_MS - TIMER_TOLERANCE_MS,
        `SIGKILL followed SIGTERM after ${String(sigkill.atMs - sigterm.atMs)} ms, inside the ${String(DEACTIVATE_STOP_GRACE_MS)} ms grace window.`,
      );
      assert.ok(elapsedMs < EXTENSION_HOST_SHUTDOWN_MS);
      assert.ok(!logged(harness.logs, 'warn', 'did not conclude before shutdown'));
      assert.ok(!logged(harness.logs, 'warn', 'left running, unsignalled'));
      assert.equal(harness.children.length, 1);
    } finally {
      harness.dispose();
    }
  });

  it('treats an escalation decision that throws as a refusal to force-stop', async function () {
    this.timeout(15_000);
    const harness = createSupervisionHarness('ignore');
    try {
      const child = await startSupervisedChild(harness);
      await harness.serviceProcess.stop({
        graceMs: SUPERVISION_TIMINGS.stopGraceMs,
        escalate: () => {
          throw new Error('supervision suite: the escalation decision failed.');
        },
      });
      assert.deepEqual(child.signalNames, ['SIGTERM']);
      assert.equal(child.alive, true);
      assert.equal(harness.serviceProcess.status.state, 'stopped');
      assert.ok(logged(harness.logs, 'warn', 'it is not force-stopped'));
      assert.ok(logged(harness.logs, 'warn', 'leaving it to finish shutting down on its own'));
    } finally {
      harness.dispose();
    }
  });
});
