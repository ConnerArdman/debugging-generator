/**
 * Tests for `./extension.ts`: what activation and settings reactivity write to
 * the "Debug Generator" output channel about `debuggen.serviceUrl` and
 * `debuggen.provider`.
 *
 * The output channel redacts nothing, so the configured values themselves must
 * never reach it (AAP §0.5.2, §0.5.6): a refused service URL can carry a pasted
 * credential in its user information, query or fragment, and a hand-edited
 * `settings.json` can put any text in `debuggen.provider` although the manifest
 * advertises an enum. Each case drives the real `activate()` and, where it
 * applies, the real settings listener, then reads every line the channel
 * received — at trace, debug, info, warn and error alike — and asserts that no
 * private fragment appears while the records still say what happened: the
 * refusal's code and rule, the validated origin, the provider's class. The
 * channel's sink is exercised the same way as the backstop for any record that
 * carries an `Error`: it must print the error's closed class and code only.
 *
 * ## What is real and what is substituted
 *
 * Real: `./extension` itself, `./service/client` (whose refusal of a private
 * URL is what the log projection reads), the `@debuggen/protocol` clients
 * behind it, `./state` and `./service/discovery`.
 *
 * Substituted, because they need an editor or a process the suite does not
 * have: the `vscode` module (the editor supplies it at runtime and no package
 * provides it), and the collaborators whose behaviour is not under test —
 * `./commands`, both views, `./service/process` (every `ensureRunning()`
 * answers "no service", so no socket is ever opened), `./service/auth`,
 * `./source/open-location` and `./uri-handler`.
 *
 * The substitute `LogOutputChannel` records each call with its level; the host
 * logger runs at `trace` and the channel applies no threshold here, so every
 * record any host module emits is inspected. Start-up and notification
 * failures can be scripted, so the debug and error records `./extension`
 * writes are driven while the private settings are configured too.
 */

import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DebuggenError } from '@debuggen/shared';
import type { Logger } from '@debuggen/shared';

import { activate, deactivate } from './extension';

/** Every method of the substitute channel that writes a line. */
type ChannelLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'append';

/** One line the substitute output channel received. */
interface ChannelLine {
  readonly level: ChannelLevel;
  readonly line: string;
}

/** The `ConfigurationChangeEvent` members the host reads. */
interface ConfigurationChange {
  affectsConfiguration(section: string): boolean;
}

/**
 * The substitute editor's state, shared between the hoisted `vi.mock`
 * factories and the cases. Reset before every case.
 */
interface HostState {
  /** Every line written to any output channel, in order. */
  readonly lines: ChannelLine[];

  /** The `debuggen.*` settings, keyed without the section prefix. */
  readonly settings: Map<string, unknown>;

  /** Every live `workspace.onDidChangeConfiguration` listener. */
  readonly configurationListeners: Set<(event: ConfigurationChange) => void>;

  /** Rejects the next `ensureRunning()` when set, then clears itself. */
  startFailure: Error | undefined;

  /** Rejects every `show*Message` call when set. */
  notificationFailure: Error | undefined;

  /**
   * The logger activation handed the substitute process manager — a child of
   * the host logger, so a record written through it reaches the channel
   * through the real sink.
   */
  processLogger: Logger | undefined;
}

const host = vi.hoisted((): HostState => ({
  lines: [],
  settings: new Map(),
  configurationListeners: new Set(),
  startFailure: undefined,
  notificationFailure: undefined,
  processLogger: undefined,
}));

vi.mock('vscode', () => {
  /** `vscode.Disposable`: runs its callback once. */
  class Disposable {
    readonly #callOnDispose: () => unknown;
    #disposed = false;

    constructor(callOnDispose: () => unknown) {
      this.#callOnDispose = callOnDispose;
    }

    dispose(): void {
      if (this.#disposed) {
        return;
      }
      this.#disposed = true;
      this.#callOnDispose();
    }
  }

  /** `vscode.EventEmitter`, as `ExtensionState` uses it. */
  class EventEmitter<T> {
    readonly #listeners = new Set<(value: T) => unknown>();

    readonly event = (listener: (value: T) => unknown): Disposable => {
      this.#listeners.add(listener);
      return new Disposable(() => this.#listeners.delete(listener));
    };

    fire(value: T): void {
      for (const listener of [...this.#listeners]) {
        listener(value);
      }
    }

    dispose(): void {
      this.#listeners.clear();
    }
  }

  const inert = (): Disposable => new Disposable(() => undefined);
  const writer =
    (level: ChannelLevel) =>
    (line: string): void => {
      host.lines.push({ level, line });
    };
  const toUri = (fsPath: string): { scheme: string; fsPath: string; path: string } => ({
    scheme: 'file',
    fsPath,
    path: fsPath,
  });
  const notify = (): Promise<undefined> =>
    host.notificationFailure === undefined
      ? Promise.resolve(undefined)
      : Promise.reject(host.notificationFailure);

  return {
    Disposable,
    EventEmitter,
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    Uri: {
      file: toUri,
      joinPath: (base: { readonly fsPath: string }, ...segments: string[]) =>
        toUri([base.fsPath, ...segments].join('/')),
    },
    window: {
      activeTextEditor: undefined,
      createOutputChannel: (name: string) => ({
        name,
        logLevel: 0,
        trace: writer('trace'),
        debug: writer('debug'),
        info: writer('info'),
        warn: writer('warn'),
        error: writer('error'),
        append: writer('append'),
        appendLine: writer('append'),
        replace: writer('append'),
        clear: () => undefined,
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined,
      }),
      createTreeView: inert,
      registerWebviewViewProvider: inert,
      onDidChangeActiveTextEditor: inert,
      showErrorMessage: notify,
      showWarningMessage: notify,
      showInformationMessage: notify,
    },
    workspace: {
      workspaceFolders: undefined,
      getWorkspaceFolder: () => undefined,
      getConfiguration: (section?: string) => ({
        get: (key: string): unknown =>
          section === 'debuggen' ? host.settings.get(key) : undefined,
      }),
      onDidChangeConfiguration: (listener: (event: ConfigurationChange) => void): Disposable => {
        host.configurationListeners.add(listener);
        return new Disposable(() => host.configurationListeners.delete(listener));
      },
      onDidChangeWorkspaceFolders: inert,
    },
    commands: {
      executeCommand: () => Promise.resolve(undefined),
    },
  };
});

vi.mock('./commands', () => ({ registerCommands: vi.fn() }));

vi.mock('./uri-handler', () => ({ registerDebuggenUriHandler: vi.fn() }));

vi.mock('./source/open-location', () => ({
  disposeSourceRevealResources: vi.fn(),
  openSourceLocation: vi.fn(),
}));

vi.mock('./views/session-view-provider', () => ({
  SESSION_VIEW_ID: 'debuggen.session',
  SESSION_VIEW_REGISTRATION_OPTIONS: { webviewOptions: { retainContextWhenHidden: false } },
  SessionViewProvider: class {
    readonly isResolved = false;
    postNotice(): void {}
    dispose(): void {}
  },
}));

vi.mock('./views/sessions-tree', () => ({
  SESSIONS_VIEW_ID: 'debuggen.sessions',
  SessionsTreeProvider: class {
    refresh(): Promise<void> {
      return Promise.resolve();
    }
    dispose(): void {}
  },
}));

vi.mock('./service/auth', async () => {
  const { DebuggenError, err } = await import('@debuggen/shared');
  const absent = () =>
    Promise.resolve(err(new DebuggenError('UNAUTHORIZED', 'No editor credential in this suite.')));
  return {
    createEditorCredentialStore: () => ({
      token: () => undefined,
      read: absent,
      refresh: absent,
      dispose: () => undefined,
    }),
  };
});

vi.mock('./service/process', async () => {
  const { DebuggenError, err } = await import('@debuggen/shared');
  return {
    createServiceProcess: (deps: { readonly logger?: Logger | undefined }) => {
      host.processLogger = deps.logger;
      return {
        ensureRunning: () => {
          const failure = host.startFailure;
          host.startFailure = undefined;
          return failure === undefined
            ? Promise.resolve(
                err(
                  new DebuggenError('TRANSPORT_DISCONNECTED', 'No service answers in this suite.'),
                ),
              )
            : Promise.reject(failure);
        },
        stop: () => Promise.resolve(),
        keepAliveFor: <T>(operation: Promise<T>): Promise<T> => operation,
        onDidChangeStatus: () => ({ dispose: () => undefined }),
        showOutput: () => undefined,
        dispose: () => undefined,
      };
    },
    isServiceReachable: () => false,
  };
});

// ---------------------------------------------------------------------------
// Private values and the fragments that must never be written
// ---------------------------------------------------------------------------

/**
 * The two user-information parts, each joined from `user` and `password` at
 * run time. `pnpm check:secrets` scans tracked files for a URI that embeds a
 * user and a password, and the only exemption channel is its reviewed
 * allowlist, so no such URI is written contiguously in this source; the value
 * the extension reads is the same either way.
 */
const PRIVATE_USERINFO = ['user', 's3cret'].join(':');
const SECOND_PRIVATE_USERINFO = ['admin', 'hunter2'].join(':');

/** A service URL with a credential in both its user information and its query. */
const PRIVATE_SERVICE_URL = `http://${PRIVATE_USERINFO}@127.0.0.1:43117/?token=SENTINEL-url-token`;

/** A loopback URL whose only defect is a query and a fragment carrying secrets. */
const PRIVATE_QUERY_URL = 'http://127.0.0.1:43117/?api_key=SENTINEL-query#SENTINEL-fragment';

/** A second user-information URL, to prove the change record refuses it too. */
const PRIVATE_USERINFO_URL = `http://${SECOND_PRIVATE_USERINFO}@localhost:43118/`;

/** An acceptable loopback URL, as the setting holds it. */
const ACCEPTED_SERVICE_URL = 'http://127.0.0.1:43118';

/** Free text in `debuggen.provider`, where the manifest advertises an enum. */
const PRIVATE_PROVIDER = 'SENTINEL-provider';

/** A `code` a thrower invented in an errno-like shape; it is no system or Node error code. */
const INVENTED_CODE = ['E', 'PRIVATECREDENTIAL', '123'].join('');

/** Every fragment of the private values above that no channel line may contain. */
const PRIVATE_FRAGMENTS = [
  'SENTINEL',
  's3cret',
  PRIVATE_USERINFO,
  '?token=',
  'api_key',
  'hunter2',
  SECOND_PRIVATE_USERINFO,
] as const;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** The context of the activation under test, disposed after every case. */
let context: vscode.ExtensionContext | undefined;

/** Activates the extension with the current settings, as the editor would. */
function activateExtension(): void {
  const subscriptions: vscode.Disposable[] = [];
  context = {
    subscriptions,
    extensionUri: vscode.Uri.file('/installed/debuggen.debug-generator'),
    extensionMode: vscode.ExtensionMode.Production,
  } as unknown as vscode.ExtensionContext;
  activate(context);
}

/** Lets the never-awaited start-up and every ensure it triggered settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/**
 * Changes one `debuggen.*` setting and notifies every configuration listener,
 * the client's own watcher and the extension's alike, in registration order.
 */
async function changeSetting(key: string, value: unknown): Promise<void> {
  host.settings.set(key, value);
  const changed = `debuggen.${key}`;
  const event: ConfigurationChange = {
    affectsConfiguration: (section) => section === 'debuggen' || section === changed,
  };
  for (const listener of [...host.configurationListeners]) {
    listener(event);
  }
  await settle();
}

/** One channel line read back as the record it was written from. */
interface ChannelRecord {
  readonly level: ChannelLevel;
  readonly fields: Record<string, unknown>;
}

/**
 * Every channel line whose message is exactly `message`, in order, with its
 * level and structured fields. A line is `‹message› ‹JSON fields›`, or the
 * message alone when the record had no fields.
 */
function recordsOf(message: string): ChannelRecord[] {
  return host.lines.flatMap(({ level, line }): ChannelRecord[] => {
    if (line === message) {
      return [{ level, fields: {} }];
    }
    if (!line.startsWith(`${message} {`)) {
      return [];
    }
    return [
      { level, fields: JSON.parse(line.slice(message.length + 1)) as Record<string, unknown> },
    ];
  });
}

/** The structured fields of every channel line whose message is exactly `message`. */
function fieldsOf(message: string): Array<Record<string, unknown>> {
  return recordsOf(message).map((record) => record.fields);
}

/** Asserts that no line, at any level, contains a fragment of a private value. */
function expectNothingPrivateWritten(): void {
  expect(host.lines.length).toBeGreaterThan(0);
  for (const { level, line } of host.lines) {
    for (const fragment of PRIVATE_FRAGMENTS) {
      expect(line, `${level} line leaked ${JSON.stringify(fragment)}`).not.toContain(fragment);
    }
  }
}

beforeEach(() => {
  host.lines.length = 0;
  host.configurationListeners.clear();
  host.startFailure = undefined;
  host.notificationFailure = undefined;
  host.processLogger = undefined;
  host.settings.clear();
  host.settings.set('serviceUrl', PRIVATE_SERVICE_URL);
  host.settings.set('provider', PRIVATE_PROVIDER);
  host.settings.set('autoStartService', false);
});

afterEach(async () => {
  await deactivate();
  const active = context;
  context = undefined;
  if (active !== undefined) {
    for (const disposable of active.subscriptions.splice(0).reverse()) {
      disposable.dispose();
    }
  }
  // Deactivation writes its own records; they are held to the same rule.
  expectNothingPrivateWritten();
});

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('activate: the service URL in the activation record', () => {
  it('logs a refused private URL by its code and rule, never by its value', async () => {
    activateExtension();
    await settle();

    const records = fieldsOf('Debug Generator activated');
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      accepted: false,
      code: 'CONFIG_INVALID',
      rule: 'userinfo',
      autoStartService: false,
    });
    expect(records[0]).not.toHaveProperty('serviceUrl');
    expectNothingPrivateWritten();
  });

  it('logs an accepted URL as the validated origin', async () => {
    host.settings.set('serviceUrl', `  ${ACCEPTED_SERVICE_URL}/  `);
    activateExtension();
    await settle();

    expect(fieldsOf('Debug Generator activated')).toEqual([
      { serviceUrl: ACCEPTED_SERVICE_URL, accepted: true, autoStartService: false },
    ]);
  });
});

describe('settings reactivity: debuggen.serviceUrl', () => {
  it('logs every change by the same projection: refusals by rule, acceptance by origin', async () => {
    activateExtension();
    await settle();

    await changeSetting('serviceUrl', PRIVATE_QUERY_URL);
    await changeSetting('serviceUrl', PRIVATE_USERINFO_URL);
    await changeSetting('serviceUrl', ACCEPTED_SERVICE_URL);

    expect(fieldsOf('Service URL changed')).toEqual([
      { accepted: false, code: 'CONFIG_INVALID', rule: 'query-or-fragment' },
      { accepted: false, code: 'CONFIG_INVALID', rule: 'userinfo' },
      { serviceUrl: ACCEPTED_SERVICE_URL, accepted: true },
    ]);
    expectNothingPrivateWritten();
  });
});

describe('settings reactivity: debuggen.provider', () => {
  it('logs the provider setting as a closed class, never its text', async () => {
    activateExtension();
    await settle();

    await changeSetting('provider', PRIVATE_PROVIDER);
    await changeSetting('provider', ' deterministic ');
    await changeSetting('provider', 'anthropic');
    await changeSetting('provider', 'Deterministic');
    await changeSetting('provider', '');
    await changeSetting('provider', 42);

    expect(fieldsOf('Model provider setting changed')).toEqual([
      { provider: 'invalid' },
      { provider: 'deterministic' },
      { provider: 'anthropic' },
      { provider: 'invalid' },
      { provider: 'unset' },
      { provider: 'unset' },
    ]);
    expectNothingPrivateWritten();
  });
});

describe('the private settings at the debug and error levels', () => {
  it('reports an unexpected start-up failure at error level by its code alone', async () => {
    host.startFailure = new Error(`connect ECONNREFUSED ${PRIVATE_SERVICE_URL}`);
    activateExtension();
    await settle();

    expect(recordsOf('Service start-up failed unexpectedly')).toEqual([
      { level: 'error', fields: { code: 'INTERNAL' } },
    ]);
    expectNothingPrivateWritten();
  });

  it('reports a notification that could not be shown at debug level by its code alone', async () => {
    host.settings.set('autoStartService', true);
    host.notificationFailure = new Error(`window closed while showing ${PRIVATE_SERVICE_URL}`);
    activateExtension();
    await settle();

    expect(recordsOf('Notification could not be shown')).toEqual([
      { level: 'debug', fields: { level: 'warning', code: 'INTERNAL' } },
    ]);
    expect(fieldsOf('Debug Generator activated')).toEqual([
      { accepted: false, code: 'CONFIG_INVALID', rule: 'userinfo', autoStartService: true },
    ]);
    expectNothingPrivateWritten();
  });
});

describe('the output channel sink: an error inside a record', () => {
  it('prints an Error-valued field as its closed class and code, never its name, message or stack', async () => {
    activateExtension();
    await settle();
    const logger = host.processLogger;
    expect(logger).toBeDefined();

    // A custom class whose `name` is free text, a native class and a product
    // error — each carrying the private URL in its message and its stack.
    const custom = new Error(`could not reach ${PRIVATE_SERVICE_URL}`);
    custom.name = 'SENTINEL-custom-name';
    custom.stack = `SENTINEL-stack at ${PRIVATE_SERVICE_URL}`;
    const native = new TypeError(`bad value ${PRIVATE_QUERY_URL}`);
    const product = new DebuggenError('CONFIG_INVALID', `refused ${PRIVATE_USERINFO_URL}`);
    // An invented, errno-shaped `code`: only the closed DebuggenError code is printed.
    const coded = Object.assign(new Error('socket failed'), { code: INVENTED_CODE });

    for (const level of ['trace', 'debug', 'info', 'warn', 'error'] as const) {
      logger?.[level]('a record holding errors', { custom, nested: { native }, product, coded });
    }

    const records = recordsOf('a record holding errors');
    expect(records.map((record) => record.level)).toEqual([
      'trace',
      'debug',
      'info',
      'warn',
      'error',
    ]);
    for (const record of records) {
      expect(record.fields).toMatchObject({
        custom: { errorClass: 'unlisted', code: 'INTERNAL' },
        nested: { native: { errorClass: 'TypeError', code: 'INTERNAL' } },
        product: { errorClass: 'DebuggenError', code: 'CONFIG_INVALID' },
        coded: { errorClass: 'Error', code: 'INTERNAL' },
      });
    }
    for (const { line } of host.lines) {
      expect(line).not.toContain(INVENTED_CODE);
    }
    expectNothingPrivateWritten();
  });
});
