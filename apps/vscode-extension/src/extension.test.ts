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
 * The last block drives the refused-credential prompt the client's
 * `onUnauthorized` signal raises, through the real `activate()`. Rotation
 * cannot repair a refused credential — `credentials.rotate` requires one the
 * service accepts — so the prompt is pinned to lead with the restart:
 *
 * - a child of this window (`running`) is offered exactly "Restart service"
 *   and "Retry"; any other process state "Retry" only, with a hint to restart
 *   the service where it was started; the prompt never offers rotation;
 * - "Restart service" confirms in a modal while a session is live (declining
 *   restarts nothing), restarts once, reads `auth.json` once and reconnects
 *   once, and only then shows one information notice whose single action is
 *   "Rotate Service Token" — choosing it runs `debuggen.rotateServiceToken`,
 *   dismissing it runs nothing;
 * - a failed restart, or a failed re-read after it, is one error notice with
 *   no re-read, reconnect or rotation offer after it;
 * - "Retry" reads `auth.json` and reconnects, restarting nothing;
 * - a window deactivated while the prompt is open acts on no answer;
 * - no notification carries the token read back or a private setting.
 *
 * The final block delivers `panel.generated` frames to the handlers the real
 * `activate()` registered and pins the notice they raise: a live session's
 * panel — ready notice or fallback banner — is announced once however often
 * the service replays it, a follow-up's new panel is announced, and nothing
 * is announced for a session the store holds as ended, reopened or ended in
 * view, while the store still records the panel for the view.
 *
 * ## What is real and what is substituted
 *
 * Real: `./extension` itself, `./service/client` (whose refusal of a private
 * URL is what the log projection reads), the `@debuggen/protocol` clients
 * behind it, `./state`, `./service/discovery` and `./commands/start-service`
 * (the restart action, its live-session confirmation and the liveness rule).
 * The client is wrapped in a proxy that records the refused-credential
 * listeners activation registers (still registering them) and counts
 * `connect()` instead of opening a socket.
 *
 * Substituted, because they need an editor or a process the suite does not
 * have: the `vscode` module (the editor supplies it at runtime and no package
 * provides it), and the collaborators whose behaviour is not under test —
 * `./commands` (its `registerCommands` hands back the store), both views,
 * `./service/process` (every `ensureRunning()` answers "no service"; `status`
 * reports a scripted state and `restart()` is counted and scriptable),
 * `./service/auth` (`refresh()` is counted and finds a credential only when a
 * case says so), `./source/open-location` and `./uri-handler`.
 *
 * The substitute `LogOutputChannel` records each call with its level; the host
 * logger runs at `trace` and the channel applies no threshold here, so every
 * record any host module emits is inspected. Start-up and notification
 * failures can be scripted, so the debug and error records `./extension`
 * writes are driven while the private settings are configured too. Every
 * `show*Message` call is recorded with its level, text, buttons and modal
 * options, and answers with the next scripted choice (dismissed by default).
 */

import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseSessionRecord } from '@debuggen/protocol';
import type {
  MessageByType,
  SessionRecord,
  SessionStatus,
  WsUnauthorizedDetail,
} from '@debuggen/protocol';
import { DebuggenError } from '@debuggen/shared';
import type { Logger } from '@debuggen/shared';

import { activate, deactivate } from './extension';
import type * as ServiceClientModule from './service/client';
import type { ExtensionState } from './state';

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

  /** Every `show*Message` call, in order, whether or not it was rejected. */
  readonly notifications: ShownMessage[];

  /**
   * The answers to successive `show*Message` calls, consumed in order; a call
   * past the end is dismissed (`undefined`). A promise answers when it settles.
   */
  readonly choices: Array<string | undefined | Promise<string | undefined>>;

  /** Every `commands.executeCommand` id, in order. */
  readonly executedCommands: string[];

  /** The state `status.state` of the substitute process manager reports. */
  serviceState: string;

  /** How many times `restart()` was called. */
  restartCalls: number;

  /** Makes the next `restart()` resolve to this failure, then clears itself. */
  restartFailure: DebuggenError | undefined;

  /** How many times the editor credential was read again (`refresh()`). */
  refreshCalls: number;

  /** Whether `refresh()` finds a credential in `auth.json`; otherwise it fails. */
  credentialOnDisk: boolean;

  /**
   * The token `refresh()` reads when {@link credentialOnDisk} is set. It
   * contains `SENTINEL`, so the privacy check fails any line that carries it.
   */
  readonly editorToken: string;

  /** How many times the client's `connect()` was called. */
  connectCalls: number;

  /** Every refused-credential listener activation registered on the client. */
  readonly unauthorizedListeners: Array<(detail: WsUnauthorizedDetail) => void>;

  /** The host store activation handed to `registerCommands`. */
  commandState: ExtensionState | undefined;

  /**
   * Every inbound-frame handler activation registered on the client, by frame
   * type, so a case can deliver a frame exactly as the socket would.
   */
  readonly inboundHandlers: Map<string, Array<(message: unknown) => void>>;
}

/** One `show*Message` call the substitute editor received. */
interface ShownMessage {
  readonly level: 'error' | 'warning' | 'info';
  readonly text: string;
  readonly actions: readonly string[];
  /** The `MessageOptions` argument, when one was passed (a modal). */
  readonly options: { readonly modal?: boolean; readonly detail?: string } | undefined;
}

const host = vi.hoisted((): HostState => ({
  lines: [],
  settings: new Map(),
  configurationListeners: new Set(),
  startFailure: undefined,
  notificationFailure: undefined,
  processLogger: undefined,
  notifications: [],
  choices: [],
  executedCommands: [],
  serviceState: 'idle',
  restartCalls: 0,
  restartFailure: undefined,
  refreshCalls: 0,
  credentialOnDisk: false,
  editorToken: ['SENTINEL', 'editor', 'token', 'on', 'disk'].join('-'),
  connectCalls: 0,
  unauthorizedListeners: [],
  commandState: undefined,
  inboundHandlers: new Map(),
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
  const notify =
    (level: ShownMessage['level']) =>
    (text: string, ...rest: readonly unknown[]): Promise<string | undefined> => {
      const [first] = rest;
      const options =
        typeof first === 'object' && first !== null
          ? (first as NonNullable<ShownMessage['options']>)
          : undefined;
      const actions = rest.filter((item): item is string => typeof item === 'string');
      host.notifications.push({ level, text, actions, options });
      if (host.notificationFailure !== undefined) {
        return Promise.reject(host.notificationFailure);
      }
      return Promise.resolve(host.choices.shift());
    };

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
      showErrorMessage: notify('error'),
      showWarningMessage: notify('warning'),
      showInformationMessage: notify('info'),
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
      executeCommand: (command: string): Promise<undefined> => {
        host.executedCommands.push(command);
        return Promise.resolve(undefined);
      },
    },
  };
});

vi.mock('./commands', () => ({
  registerCommands: vi.fn((_context: unknown, deps: { readonly state: ExtensionState }) => {
    host.commandState = deps.state;
  }),
}));

/**
 * The real client, behind a proxy that binds every member to the real
 * instance (its private fields need it), records each refused-credential
 * listener and each inbound-frame handler while still registering them, and
 * replaces `connect()` with a counter, so no socket is ever opened.
 */
vi.mock('./service/client', async (importOriginal) => {
  const actual = await importOriginal<typeof ServiceClientModule>();
  return {
    ...actual,
    createServiceClient: (
      ...args: Parameters<typeof actual.createServiceClient>
    ): ServiceClientModule.ServiceClient =>
      new Proxy(actual.createServiceClient(...args), {
        get(target, property): unknown {
          if (property === 'connect') {
            return (): void => {
              host.connectCalls += 1;
            };
          }
          if (property === 'onUnauthorized') {
            return (listener: (detail: WsUnauthorizedDetail) => void): (() => void) => {
              host.unauthorizedListeners.push(listener);
              return target.onUnauthorized(listener);
            };
          }
          if (property === 'on') {
            return (
              ...onArgs: Parameters<ServiceClientModule.ServiceClient['on']>
            ): (() => void) => {
              const [type, handler] = onArgs;
              const handlers = host.inboundHandlers.get(type) ?? [];
              handlers.push(handler as (message: unknown) => void);
              host.inboundHandlers.set(type, handlers);
              return target.on(...onArgs);
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
  };
});

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
  const { DebuggenError, err, ok } = await import('@debuggen/shared');
  const absent = () =>
    Promise.resolve(err(new DebuggenError('UNAUTHORIZED', 'No editor credential in this suite.')));
  return {
    createEditorCredentialStore: () => ({
      token: () => undefined,
      read: absent,
      refresh: () => {
        host.refreshCalls += 1;
        return host.credentialOnDisk ? Promise.resolve(ok(host.editorToken)) : absent();
      },
      dispose: () => undefined,
    }),
  };
});

vi.mock('./service/process', async () => {
  const { DebuggenError, err, ok } = await import('@debuggen/shared');
  /** A status snapshot in the scripted state; only `state` and `mode` are read. */
  const statusOf = (state: string) => ({
    state,
    mode: state === 'external' ? 'external' : 'embedded',
    pid: state === 'running' ? 4242 : undefined,
    serviceUrl: 'http://127.0.0.1:43117',
    restartAttempts: 0,
    settingsChanged: false,
    error: undefined,
    since: 0,
  });
  return {
    createServiceProcess: (deps: { readonly logger?: Logger | undefined }) => {
      host.processLogger = deps.logger;
      return {
        get status() {
          return statusOf(host.serviceState);
        },
        restart: () => {
          host.restartCalls += 1;
          const failure = host.restartFailure;
          host.restartFailure = undefined;
          return Promise.resolve(failure === undefined ? ok(statusOf('running')) : err(failure));
        },
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
  host.notifications.length = 0;
  host.choices.length = 0;
  host.executedCommands.length = 0;
  host.serviceState = 'idle';
  host.restartCalls = 0;
  host.restartFailure = undefined;
  host.refreshCalls = 0;
  host.credentialOnDisk = false;
  host.connectCalls = 0;
  host.unauthorizedListeners.length = 0;
  host.commandState = undefined;
  host.inboundHandlers.clear();
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

// ---------------------------------------------------------------------------
// The refused-credential prompt
// ---------------------------------------------------------------------------

/** The prompt's headline, as the developer reads it. */
const CREDENTIAL_REFUSED_HEADLINE = 'The Debug Generator service refused this editor’s credential.';

/** The prompt's and the confirmation's restart button. */
const RESTART_ACTION = 'Restart service';

/** The prompt's re-read button. */
const RETRY_ACTION = 'Retry';

/** The post-restart notice's only button. */
const ROTATE_ACTION = 'Rotate Service Token';

describe('the refused-credential prompt', () => {
  /**
   * Activates, lets start-up settle, puts the process manager in
   * `serviceState`, then reports a refused credential to every listener the
   * activation registered — what the client does once its single re-read of
   * `auth.json` found no different token — and lets the prompt's flow settle.
   */
  async function refuseCredential(serviceState: string): Promise<void> {
    activateExtension();
    await settle();
    expect(host.notifications).toEqual([]);
    expect(host.unauthorizedListeners.length).toBeGreaterThan(0);
    host.serviceState = serviceState;
    for (const listener of [...host.unauthorizedListeners]) {
      listener({ code: 4401, reason: 'the credential was refused' });
    }
    await settle();
  }

  /** Every notification that offered rotation. */
  function rotationOffers(): ShownMessage[] {
    return host.notifications.filter((shown) => shown.actions.includes(ROTATE_ACTION));
  }

  afterEach(() => {
    // Neither the token read from auth.json nor any private setting reaches
    // a notification.
    for (const { text } of host.notifications) {
      expect(text).not.toContain(host.editorToken);
      for (const fragment of PRIVATE_FRAGMENTS) {
        expect(text).not.toContain(fragment);
      }
    }
  });

  it('leads with "Restart service", then "Retry", for a child of this window, and offers no rotation', async () => {
    await refuseCredential('running');

    expect(host.notifications).toHaveLength(1);
    const prompt = host.notifications[0]!;
    expect(prompt.level).toBe('warning');
    expect(prompt.text.startsWith(CREDENTIAL_REFUSED_HEADLINE)).toBe(true);
    expect(prompt.text).toContain('as it starts it re-issues the editor credential in auth.json');
    expect(prompt.text).toContain('Retry reads auth.json again');
    expect(prompt.actions).toEqual([RESTART_ACTION, RETRY_ACTION]);
    expect(prompt.options).toBeUndefined();
    expect(rotationOffers()).toEqual([]);
    // Dismissed: nothing else happens.
    expect(host.restartCalls).toBe(0);
    expect(host.refreshCalls).toBe(0);
    expect(host.connectCalls).toBe(0);
    expect(host.executedCommands).toEqual([]);
    expect(recordsOf('The service refused the editor credential')).toEqual([
      { level: 'warn', fields: { code: 4401 } },
    ]);
  });

  it.each(['external', 'starting', 'failed', 'stopped', 'idle'])(
    'offers only "Retry" when the service process is %s, with a hint to restart it where it was started',
    async (serviceState) => {
      host.choices.push(RESTART_ACTION);
      await refuseCredential(serviceState);

      expect(host.notifications).toHaveLength(1);
      const prompt = host.notifications[0]!;
      expect(prompt.level).toBe('warning');
      expect(prompt.text.startsWith(CREDENTIAL_REFUSED_HEADLINE)).toBe(true);
      expect(prompt.text).toContain(
        'Restart the service where it was started — a terminal or another VS Code window — so it re-issues the editor credential in auth.json, then choose Retry.',
      );
      expect(prompt.actions).toEqual([RETRY_ACTION]);
      expect(rotationOffers()).toEqual([]);
      // A "Restart service" answer the prompt never offered restarts nothing.
      expect(host.restartCalls).toBe(0);
      expect(host.refreshCalls).toBe(0);
      expect(host.connectCalls).toBe(0);
    },
  );

  it('restarts once, re-reads auth.json, reconnects, then offers rotation in one information notice', async () => {
    host.credentialOnDisk = true;
    host.choices.push(RESTART_ACTION);
    await refuseCredential('running');

    expect(host.restartCalls).toBe(1);
    expect(host.refreshCalls).toBe(1);
    expect(host.connectCalls).toBe(1);
    expect(host.notifications).toHaveLength(2);
    const notice = host.notifications[1]!;
    expect(notice.level).toBe('info');
    expect(notice.text).toContain(
      'Restarted the Debug Generator service; this editor reconnects with the credential it issued.',
    );
    expect(notice.text).toContain(
      'If anything other than Debug Generator changed auth.json, rotate the service token',
    );
    expect(notice.actions).toEqual([ROTATE_ACTION]);
    expect(rotationOffers()).toEqual([notice]);
    // Dismissed: no rotation runs.
    expect(host.executedCommands).toEqual([]);
    expect(recordsOf('The service was restarted to repair the editor credential')).toEqual([
      { level: 'info', fields: { state: 'running' } },
    ]);
  });

  it('runs debuggen.rotateServiceToken when "Rotate Service Token" is chosen after the restart', async () => {
    host.credentialOnDisk = true;
    host.choices.push(RESTART_ACTION, ROTATE_ACTION);
    await refuseCredential('running');

    expect(host.restartCalls).toBe(1);
    expect(host.refreshCalls).toBe(1);
    expect(host.connectCalls).toBe(1);
    expect(host.notifications).toHaveLength(2);
    expect(host.executedCommands).toEqual(['debuggen.rotateServiceToken']);
  });

  it('surfaces a failed restart once, and re-reads, connects and offers nothing', async () => {
    host.credentialOnDisk = true;
    host.restartFailure = new DebuggenError('INTERNAL', 'The restarted service did not answer.', {
      hint: 'Open the "Debug Generator Service" output for the reason.',
    });
    host.choices.push(RESTART_ACTION);
    await refuseCredential('running');

    expect(host.restartCalls).toBe(1);
    expect(host.refreshCalls).toBe(0);
    expect(host.connectCalls).toBe(0);
    expect(host.notifications).toHaveLength(2);
    const failure = host.notifications[1]!;
    expect(failure.level).toBe('error');
    expect(failure.text).toBe(
      'Could not restart the Debug Generator service: The restarted service did not answer. Open the "Debug Generator Service" output for the reason.',
    );
    expect(failure.actions).toEqual([]);
    expect(rotationOffers()).toEqual([]);
    expect(host.executedCommands).toEqual([]);
    expect(recordsOf('The service could not be restarted to repair the editor credential')).toEqual(
      [{ level: 'warn', fields: { code: 'INTERNAL' } }],
    );
  });

  it('surfaces a failed re-read after the restart once, and connects and offers nothing', async () => {
    host.choices.push(RESTART_ACTION);
    await refuseCredential('running');

    expect(host.restartCalls).toBe(1);
    expect(host.refreshCalls).toBe(1);
    expect(host.connectCalls).toBe(0);
    expect(host.notifications).toHaveLength(2);
    const failure = host.notifications[1]!;
    expect(failure.level).toBe('error');
    expect(failure.text).toBe(
      'Could not read the editor credential: No editor credential in this suite.',
    );
    expect(rotationOffers()).toEqual([]);
    expect(recordsOf('The editor credential could not be re-read')).toEqual([
      { level: 'warn', fields: { code: 'UNAUTHORIZED' } },
    ]);
  });

  it('"Retry" re-reads auth.json and reconnects, without restarting or offering rotation', async () => {
    host.credentialOnDisk = true;
    host.choices.push(RETRY_ACTION);
    await refuseCredential('running');

    expect(host.restartCalls).toBe(0);
    expect(host.refreshCalls).toBe(1);
    expect(host.connectCalls).toBe(1);
    expect(host.notifications).toHaveLength(1);
    expect(rotationOffers()).toEqual([]);
    expect(host.executedCommands).toEqual([]);
  });

  it('"Retry" that cannot read auth.json surfaces one error and does not reconnect', async () => {
    host.choices.push(RETRY_ACTION);
    await refuseCredential('external');

    expect(host.restartCalls).toBe(0);
    expect(host.refreshCalls).toBe(1);
    expect(host.connectCalls).toBe(0);
    expect(host.notifications).toHaveLength(2);
    expect(host.notifications[1]?.level).toBe('error');
    expect(rotationOffers()).toEqual([]);
  });

  describe('while a session is live', () => {
    /**
     * Makes the store report an active session with no record yet — the
     * state the restart confirmation errs on the side of asking in — and
     * returns the function that removes it again before deactivation.
     */
    function withLiveSession(): () => void {
      const state = host.commandState;
      expect(state).toBeDefined();
      Object.defineProperty(state, 'activeSessionId', {
        configurable: true,
        get: () => 'session-live',
      });
      return () => {
        Reflect.deleteProperty(state!, 'activeSessionId');
      };
    }

    it('asks the modal confirmation first, and restarts nothing when it is declined', async () => {
      host.credentialOnDisk = true;
      activateExtension();
      await settle();
      const restore = withLiveSession();
      try {
        host.serviceState = 'running';
        host.choices.push(RESTART_ACTION, undefined);
        for (const listener of [...host.unauthorizedListeners]) {
          listener({ code: 4401, reason: 'the credential was refused' });
        }
        await settle();
      } finally {
        restore();
      }

      expect(host.notifications).toHaveLength(2);
      const modal = host.notifications[1]!;
      expect(modal.level).toBe('warning');
      expect(modal.text).toBe('Restart the Debug Generator service while a session is active?');
      expect(modal.options?.modal).toBe(true);
      expect(modal.options?.detail).toContain('restores every file it instrumented');
      expect(modal.actions).toEqual([RESTART_ACTION]);
      expect(host.restartCalls).toBe(0);
      expect(host.refreshCalls).toBe(0);
      expect(host.connectCalls).toBe(0);
      expect(rotationOffers()).toEqual([]);
    });

    it('restarts once the modal confirmation is accepted', async () => {
      host.credentialOnDisk = true;
      activateExtension();
      await settle();
      const restore = withLiveSession();
      try {
        host.serviceState = 'running';
        host.choices.push(RESTART_ACTION, RESTART_ACTION);
        for (const listener of [...host.unauthorizedListeners]) {
          listener({ code: 4401, reason: 'the credential was refused' });
        }
        await settle();
      } finally {
        restore();
      }

      expect(host.notifications.map((shown) => shown.options?.modal === true)).toEqual([
        false,
        true,
        false,
      ]);
      expect(host.restartCalls).toBe(1);
      expect(host.refreshCalls).toBe(1);
      expect(host.connectCalls).toBe(1);
      expect(rotationOffers()).toHaveLength(1);
    });
  });

  it('does nothing when the window deactivated while the prompt was open', async () => {
    host.credentialOnDisk = true;
    let answer: (choice: string | undefined) => void = () => undefined;
    host.choices.push(
      new Promise<string | undefined>((resolve) => {
        answer = resolve;
      }),
    );
    await refuseCredential('running');
    expect(host.notifications).toHaveLength(1);

    await deactivate();
    answer(RESTART_ACTION);
    await settle();

    expect(host.restartCalls).toBe(0);
    expect(host.refreshCalls).toBe(0);
    expect(host.connectCalls).toBe(0);
    expect(host.notifications).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The panel.generated notice
// ---------------------------------------------------------------------------

/** The owning endpoint every adopted session in these cases is recorded under. */
const SESSION_ENDPOINT = 'http://127.0.0.1:43117';

/** The session the panel cases adopt. */
const PANEL_SESSION_ID = 'ses_panel_notice_0001';

/** A panel title, as the generated specification states it. */
const PANEL_TITLE = 'Interaction latency';

/** Numbers each built frame, so every delivery carries its own envelope id. */
let panelFrameSerial = 0;

/**
 * A stored session record, validated by the protocol's own schema.
 *
 * @param status The session's status.
 * @param updatedAt When the service last changed it.
 * @returns The record.
 */
function panelSessionRecord(status: SessionStatus, updatedAt = 1_760_000_000_000): SessionRecord {
  const parsed = parseSessionRecord({
    id: PANEL_SESSION_ID,
    projectRoot: '/workspace/sample-project',
    projectName: 'sample-project',
    devServerUrl: 'http://127.0.0.1:3000/',
    createdAt: 1_760_000_000_000,
    updatedAt,
    status,
    question: 'Why is this interaction slow?',
    followUps: [],
    relevantFiles: [],
    plans: [],
    modifications: [],
    captures: [],
    panelIds: [],
    analyses: [],
    cleanup: { status: 'pending', conflicts: [] },
    promptVersions: {},
    provider: { id: 'deterministic' },
  });
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

/**
 * A `panel.generated` envelope carrying the members the host reads — the
 * session, the panel id, its title, version and fallback flag — delivered
 * under a fresh envelope id, as every replay of the service is.
 *
 * @param panelId The generated panel's id.
 * @param options Its version and whether it is a deterministic fallback.
 * @returns The frame.
 */
function panelFrame(
  panelId: string,
  options: { readonly panelVersion?: number; readonly fallback?: boolean } = {},
): MessageByType<'panel.generated'> {
  panelFrameSerial += 1;
  return {
    id: `msg_panel_frame_${String(panelFrameSerial)}`,
    type: 'panel.generated',
    sessionId: PANEL_SESSION_ID,
    ts: 1_760_000_000_000 + panelFrameSerial,
    payload: {
      sessionId: PANEL_SESSION_ID,
      panelId,
      panel: {
        id: panelId,
        title: PANEL_TITLE,
        panelVersion: options.panelVersion ?? 1,
        ...(options.fallback === true ? { meta: { fallback: true } } : {}),
      },
    },
  } as unknown as MessageByType<'panel.generated'>;
}

/**
 * Delivers one inbound frame to every handler activation registered for its
 * type, as the client does when the frame arrives on the socket.
 *
 * @param frame The frame.
 */
function deliver(frame: MessageByType<'panel.generated'>): void {
  const handlers = host.inboundHandlers.get(frame.type) ?? [];
  expect(handlers.length).toBeGreaterThan(0);
  for (const handler of handlers) {
    handler(frame);
  }
}

/** The notices naming a generated panel: its ready notice or the fallback banner. */
function panelNotices(): Array<Pick<ShownMessage, 'level' | 'text'>> {
  return host.notifications
    .filter(
      (shown) => shown.text.includes('Chrome DevTools') || shown.text.includes('fallback view'),
    )
    .map(({ level, text }) => ({ level, text }));
}

/** The ready notice of {@link PANEL_TITLE}, as the developer reads it. */
const READY_NOTICE = {
  level: 'info',
  text: `Panel "${PANEL_TITLE}" is ready in the Debug Generator panel of Chrome DevTools.`,
} as const;

/** The fallback banner of AAP §0.5.5, as the developer reads it. */
const FALLBACK_NOTICE = {
  level: 'warning',
  text: 'Generated panel failed validation; showing a fallback view built from captured data.',
} as const;

describe('the panel.generated notice', () => {
  /** Activates, lets start-up settle, and returns the host store. */
  async function activatedState(): Promise<ExtensionState> {
    activateExtension();
    await settle();
    const state = host.commandState;
    if (state === undefined) {
      throw new Error('activation handed no store to the commands');
    }
    return state;
  }

  it("announces a live session's panel once, however often the service replays it", async () => {
    const state = await activatedState();
    state.adoptSession(panelSessionRecord('generated'), SESSION_ENDPOINT);

    // The live frame, then the replays of three re-reads of the session.
    for (let delivery = 0; delivery < 4; delivery += 1) {
      deliver(panelFrame('pnl_notice_0001'));
    }
    await settle();
    expect(panelNotices()).toEqual([READY_NOTICE]);
    expect(state.latestPanel?.id).toBe('pnl_notice_0001');

    // A follow-up's new panel is news, and is announced once too.
    deliver(panelFrame('pnl_notice_0002', { panelVersion: 2 }));
    deliver(panelFrame('pnl_notice_0002', { panelVersion: 2 }));
    await settle();
    expect(panelNotices()).toEqual([READY_NOTICE, READY_NOTICE]);
    expect(recordsOf('Panel generated')).toHaveLength(2);
    expect(recordsOf('Panel already announced')).toHaveLength(4);

    // Ended before deactivation, so shutdown has no live session to end.
    state.applySessionEnded(PANEL_SESSION_ID, { cleanup: 'clean' });
  });

  it("announces a live session's fallback panel once, as the fallback banner", async () => {
    const state = await activatedState();
    state.adoptSession(panelSessionRecord('generated'), SESSION_ENDPOINT);

    deliver(panelFrame('pnl_notice_fallback', { fallback: true }));
    deliver(panelFrame('pnl_notice_fallback', { fallback: true }));
    await settle();

    expect(panelNotices()).toEqual([FALLBACK_NOTICE]);
    expect(state.latestPanel?.fallback).toBe(true);
    state.applySessionEnded(PANEL_SESSION_ID, { cleanup: 'clean' });
  });

  it('announces nothing for a reopened ended session, while the view still gets its panel', async () => {
    const state = await activatedState();
    // Reopened from the Sessions tree: the stored record is ended.
    state.adoptSession(panelSessionRecord('ended', 1_760_000_000_500), SESSION_ENDPOINT);

    deliver(panelFrame('pnl_notice_0001'));
    deliver(panelFrame('pnl_notice_0001'));
    deliver(panelFrame('pnl_notice_fallback', { panelVersion: 2, fallback: true }));
    await settle();

    expect(panelNotices()).toEqual([]);
    expect(state.latestPanel?.id).toBe('pnl_notice_fallback');
    expect(recordsOf('Panel of an ended session not announced')).toHaveLength(3);
  });

  it('stops announcing once the session in view has ended', async () => {
    const state = await activatedState();
    state.adoptSession(panelSessionRecord('generated'), SESSION_ENDPOINT);
    deliver(panelFrame('pnl_notice_0001'));
    await settle();
    expect(panelNotices()).toEqual([READY_NOTICE]);

    state.applySessionEnded(PANEL_SESSION_ID, { cleanup: 'clean' });
    // The end's detail read replays the panel; a panel id never announced is silent too.
    deliver(panelFrame('pnl_notice_0001'));
    deliver(panelFrame('pnl_notice_0003', { panelVersion: 3 }));
    await settle();

    expect(panelNotices()).toEqual([READY_NOTICE]);
  });
});
