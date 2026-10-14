/**
 * Tests for `./session-view-provider.ts`: the view's "Pick element" action
 * (`requestTarget`), driven through the provider's real message entry point.
 *
 * The view is resolved with a substitute `vscode.WebviewView` whose
 * `onDidReceiveMessage` listener the suite captures and whose `postMessage`
 * records every host→webview frame, so a case sends exactly the frame the
 * React app sends and reads back exactly what the view would render.
 *
 * Nothing between the frame and the wire is substituted: the provider runs
 * with the real `ExtensionState` store and the real `ServiceClient` from
 * `../service/client`, whose only fake is its HTTP transport (`fetch`). That is
 * what lets a case pin both halves of the contract at once — the request the
 * editor actually sends (`POST /sessions/:id/target/request`, body `{}`, the
 * editor bearer credential) and the notice each of the route's answers
 * produces, including the protocol client's own mapping of a refusal into a
 * typed `DebuggenError`.
 *
 * The frame is the view's request as `src/webview-messages.ts` defines it —
 * `{ type: 'requestTarget', requestId }` — and the session is made active the
 * one way the store allows, `ExtensionState.adoptSession`, as the commands do
 * once the service has answered for the session.
 *
 * Pinned here:
 *
 *   - **Every action is answered once.** The request's own `actionResult`
 *     echoes its id: `accepted` after the picker-mode notice, `failed` after a
 *     refusal's or the no-session notice.
 *   - **No session, no request.** Without an active session the action is
 *     answered with the no-session notice and nothing reaches the service.
 *   - **One request per action.** With a session, `client.requestTarget` runs
 *     exactly once with that session's id, and no contributed command runs.
 *   - **Success is a picker-mode notice**, never a claim that an element was
 *     picked, and it carries no credential, URL or tab id.
 *   - **Every refusal is an error notice with a next step** (AAP §0.5.5): a
 *     `TAB_NOT_BOUND` or an offline bound panel names the DevTools panel, and a
 *     service that could not be reached keeps the client's "not running" hint,
 *     because the two `TRANSPORT_DISCONNECTED` meanings need different remedies.
 *
 * ## The `vscode` substitute
 *
 * The editor supplies the `vscode` module at runtime and no installable
 * package provides it, so `vi.mock` registers a factory for the bare
 * specifier (as `../uri-handler.test.ts` does). It carries only what the three
 * real modules reach on these paths: `Uri.joinPath` (the provider's resource
 * root and bundle URIs), `EventEmitter` (the store's change event), and
 * `commands`/`window` members that fail loudly if a case ever reaches them.
 */

import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  FetchLike,
  HttpFetchInit,
  HttpResponseLike,
  SessionRecord,
  TargetRequestResponse,
} from '@debuggen/protocol';
import { ok } from '@debuggen/shared';
import type { LogFields, Logger } from '@debuggen/shared';

import { createServiceClient } from '../service/client';
import type { ServiceClient, ServiceCredential } from '../service/client';
import { ExtensionState } from '../state';
import type {
  ActionResultStatus,
  HostToWebviewMessage,
  HostToWebviewMessageOf,
} from '../webview-messages';

import { SessionViewProvider } from './session-view-provider';

// ---------------------------------------------------------------------------
// The `vscode` substitute
// ---------------------------------------------------------------------------

/**
 * Builders shared by the hoisted `vi.mock` factory and the cases. `vi.hoisted`
 * runs before the imports above, so nothing in it may reference them.
 */
const substitutes = vi.hoisted(() => {
  /**
   * A `vscode.Uri` for one path: every member the interface declares, with
   * `toString()` in a form the provider's attribute-safety check accepts.
   *
   * @param path The URI path.
   * @returns The substitute URI.
   */
  function makeUri(path: string): vscode.Uri {
    const uri: vscode.Uri = {
      scheme: 'file',
      authority: '',
      path,
      query: '',
      fragment: '',
      fsPath: path,
      with: (change) => makeUri(change.path ?? path),
      toString: () => `file://${path}`,
      toJSON: () => ({ scheme: 'file', path }),
    };
    return uri;
  }

  /** The store's change event: `event`, `fire` and `dispose`, synchronously. */
  class EventEmitter<T> {
    readonly #listeners = new Set<(value: T) => void>();

    readonly event = (listener: (value: T) => void): vscode.Disposable => {
      this.#listeners.add(listener);
      return {
        dispose: () => {
          this.#listeners.delete(listener);
        },
      };
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

  return { makeUri, EventEmitter };
});

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (base: vscode.Uri, ...segments: string[]): vscode.Uri =>
      substitutes.makeUri([base.path, ...segments].join('/')),
  },
  EventEmitter: substitutes.EventEmitter,
  commands: {
    executeCommand: (): Promise<never> =>
      Promise.reject(new Error('the view suite injects its own command runner')),
  },
  window: {
    registerWebviewViewProvider: (): never => {
      throw new Error('the view suite resolves the provider directly');
    },
  },
  workspace: {
    getConfiguration: (): never => {
      throw new Error('the view suite injects the service URL configuration');
    },
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The service origin the client is configured with; nothing listens on it. */
const SERVICE_URL = 'http://127.0.0.1:43117';

/** The editor credential the fake store hands out. Never a real secret. */
const EDITOR_TOKEN = 'editor-credential-for-view-tests';

/** The active session's id, in the product's `<prefix>_<16 alphanumerics>` form. */
const SESSION_ID = 'ses_PickTargetTest01';

/** The DevTools tab the service reports it asked. */
const BOUND_TAB_ID = 314;

/**
 * A complete, schema-shaped session record in a state that accepts a target.
 * Neutral vocabulary only: no inspected project's names or routes.
 *
 * @returns A fresh record for {@link SESSION_ID}.
 */
function makeSession(): SessionRecord {
  return {
    id: SESSION_ID,
    projectRoot: '/workspace/sample-project',
    projectName: 'sample-project',
    devServerUrl: 'http://127.0.0.1:4000',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    status: 'ready',
    question: 'Why does the list take long to appear?',
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
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** One HTTP request the client sent. */
interface SentRequest {
  readonly url: string;
  readonly init: HttpFetchInit | undefined;
}

/** How the fake transport answers the next request. */
type Reply =
  | { readonly kind: 'reply'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'unreachable' };

/** One log record the provider or the client wrote. */
interface LogRecord {
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields: LogFields;
}

/** Everything a case drives and reads. */
interface Harness {
  /** The real client, with `requestTarget` spied on. */
  readonly client: ServiceClient;
  /** The real store. */
  readonly state: ExtensionState;
  /** Every request the transport received, in order. */
  readonly sent: SentRequest[];
  /** Every host→webview frame, in order. */
  readonly posted: HostToWebviewMessage[];
  /** Every command the provider asked VS Code to run. */
  readonly commands: string[];
  /** Every info, warning and error record. */
  readonly logs: LogRecord[];
  /** Sets how the transport answers. */
  reply(next: Reply): void;
  /**
   * Sends the "Pick element" request to the provider exactly as the webview
   * posts it: `{ type: 'requestTarget', requestId }` with a fresh id.
   *
   * @returns The id the request carried, which its `actionResult` echoes.
   */
  pickElement(): string;
}

/**
 * A logger that records info, warning and error lines, and discards the rest.
 *
 * @param logs Where the records go.
 * @returns The logger; its children write to the same list.
 */
function recordingLogger(logs: LogRecord[]): Logger {
  const discard = (): void => undefined;
  const logger: Logger = {
    level: 'debug',
    trace: discard,
    debug: discard,
    info: (message, fields) => {
      logs.push({ level: 'info', message, fields: fields ?? {} });
    },
    warn: (message, fields) => {
      logs.push({ level: 'warn', message, fields: fields ?? {} });
    },
    error: (message, fields) => {
      logs.push({ level: 'error', message, fields: fields ?? {} });
    },
    fatal: discard,
    child: () => logger,
  };
  return logger;
}

/** A disposable that holds nothing. */
function inertDisposable(): vscode.Disposable {
  return { dispose: () => undefined };
}

/**
 * The fake HTTP transport: records each request and answers with the scripted
 * reply, as a JSON body or as the rejection `fetch` produces when nothing
 * listens on the port.
 */
function scriptedFetch(sent: SentRequest[], current: () => Reply): FetchLike {
  return (url, init) => {
    sent.push({ url, init });
    const reply = current();
    if (reply.kind === 'unreachable') {
      return Promise.reject(new TypeError('fetch failed'));
    }
    const response: HttpResponseLike = {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: () => Promise.resolve(JSON.stringify(reply.body)),
    };
    return Promise.resolve(response);
  };
}

/**
 * Builds the provider over the real store and client and resolves its view.
 *
 * @returns The harness; the view is resolved and listening.
 */
function createHarness(): Harness {
  const sent: SentRequest[] = [];
  const posted: HostToWebviewMessage[] = [];
  const commands: string[] = [];
  const logs: LogRecord[] = [];
  const logger = recordingLogger(logs);

  let next: Reply = { kind: 'reply', status: 200, body: {} };
  const credential: ServiceCredential = {
    token: () => EDITOR_TOKEN,
    read: () => Promise.resolve(ok(EDITOR_TOKEN)),
    refresh: () => Promise.resolve(ok(EDITOR_TOKEN)),
  };
  const client = createServiceClient({
    credential,
    logger,
    configuration: {
      readServiceUrl: () => SERVICE_URL,
      onDidChangeServiceUrl: () => inertDisposable(),
    },
    fetch: scriptedFetch(sent, () => next),
  });
  const state = new ExtensionState({ serviceUrl: SERVICE_URL, provider: 'deterministic' });

  const provider = new SessionViewProvider({
    extensionUri: substitutes.makeUri('/extension'),
    state,
    client,
    logger,
    executeCommand: <T>(command: string): Thenable<T> => {
      commands.push(command);
      return Promise.reject(new Error('no command is expected on this path'));
    },
  });

  let receive: ((raw: unknown) => unknown) | undefined;
  let requestCount = 0;
  const webview: vscode.Webview = {
    options: {},
    html: '',
    cspSource: 'https://webview.test',
    onDidReceiveMessage: (listener: (raw: unknown) => unknown): vscode.Disposable => {
      receive = listener;
      return {
        dispose: () => {
          receive = undefined;
        },
      };
    },
    postMessage: (message: HostToWebviewMessage): Thenable<boolean> => {
      posted.push(message);
      return Promise.resolve(true);
    },
    asWebviewUri: (uri) => uri,
  };
  const view: vscode.WebviewView = {
    viewType: 'debuggen.session',
    webview,
    visible: true,
    onDidDispose: () => inertDisposable(),
    onDidChangeVisibility: () => inertDisposable(),
    show: () => undefined,
  };
  const token: vscode.CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: () => inertDisposable(),
  };
  provider.resolveWebviewView(view, { state: undefined }, token);

  cleanups.push(() => {
    provider.dispose();
    state.dispose();
    client.dispose();
  });

  return {
    client,
    state,
    sent,
    posted,
    commands,
    logs,
    reply: (reply) => {
      next = reply;
    },
    pickElement: () => {
      if (receive === undefined) {
        throw new Error('the provider is not listening to the view');
      }
      requestCount += 1;
      // The request-id alphabet of `src/webview-messages.ts`, distinct per request.
      const requestId = `pick-element-${String(requestCount)}`;
      receive({ type: 'requestTarget', requestId });
      return requestId;
    },
  };
}

/**
 * The `notice` frames among the posted ones, in order.
 *
 * @param posted Every frame the provider posted.
 * @returns The notices only.
 */
function notices(posted: readonly HostToWebviewMessage[]): HostToWebviewMessageOf<'notice'>[] {
  return posted.filter(
    (frame): frame is HostToWebviewMessageOf<'notice'> => frame.type === 'notice',
  );
}

/**
 * Waits until the provider has posted exactly one notice, and returns it.
 *
 * @param harness The case's harness.
 * @returns The single notice.
 */
async function onlyNotice(harness: Harness): Promise<HostToWebviewMessageOf<'notice'>> {
  await vi.waitFor(() => {
    expect(notices(harness.posted)).toHaveLength(1);
  });
  const [notice] = notices(harness.posted);
  if (notice === undefined) {
    throw new Error('expected a notice');
  }
  return notice;
}

/**
 * Waits until the provider has answered request `requestId` with exactly one
 * `actionResult`, and returns that result's status.
 *
 * @param harness The case's harness.
 * @param requestId The id the request carried.
 * @returns How the provider says the request's handling ended.
 */
async function resultOf(harness: Harness, requestId: string): Promise<ActionResultStatus> {
  const answers = (): HostToWebviewMessageOf<'actionResult'>[] =>
    harness.posted.filter(
      (frame): frame is HostToWebviewMessageOf<'actionResult'> =>
        frame.type === 'actionResult' && frame.requestId === requestId,
    );
  await vi.waitFor(() => {
    expect(answers()).toHaveLength(1);
  });
  const [answer] = answers();
  if (answer === undefined) {
    throw new Error('expected an action result');
  }
  expect(answer.action).toBe('requestTarget');
  return answer.status;
}

/**
 * The whole text a notice shows.
 *
 * @param notice The notice frame.
 * @returns Its message and hint, joined.
 */
function shownText(notice: HostToWebviewMessageOf<'notice'>): string {
  return `${notice.message}\n${notice.hint ?? ''}`;
}

/** Teardown of every harness built in the current case. */
const cleanups: Array<() => void> = [];

beforeEach(() => {
  cleanups.length = 0;
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// No active session
// ---------------------------------------------------------------------------

describe('SessionViewProvider requestTarget without an active session', () => {
  it('answers with the no-session notice and sends nothing to the service', async () => {
    const harness = createHarness();
    const requestTarget = vi.spyOn(harness.client, 'requestTarget');

    const pick = harness.pickElement();

    const notice = await onlyNotice(harness);
    expect(notice.level).toBe('warning');
    expect(notice.message).toMatch(/no active session/i);
    expect(await resultOf(harness, pick)).toBe('failed');
    expect(requestTarget).not.toHaveBeenCalled();
    expect(harness.sent).toHaveLength(0);
    expect(harness.commands).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Active session
// ---------------------------------------------------------------------------

describe('SessionViewProvider requestTarget with an active session', () => {
  it('sends one authorized target request for the session and reports picker mode', async () => {
    const harness = createHarness();
    harness.state.adoptSession(makeSession(), SERVICE_URL);
    const accepted: TargetRequestResponse = { sessionId: SESSION_ID, tabId: BOUND_TAB_ID };
    harness.reply({ kind: 'reply', status: 200, body: accepted });
    const requestTarget = vi.spyOn(harness.client, 'requestTarget');

    const pick = harness.pickElement();

    const notice = await onlyNotice(harness);
    expect(requestTarget).toHaveBeenCalledTimes(1);
    expect(requestTarget).toHaveBeenCalledWith(SESSION_ID);
    expect(harness.commands).toEqual([]);

    // The wire: the protocol's route, an empty body, the editor credential.
    expect(harness.sent).toHaveLength(1);
    const [request] = harness.sent;
    expect(request?.url).toBe(`${SERVICE_URL}/sessions/${SESSION_ID}/target/request`);
    expect(request?.init?.method).toBe('POST');
    expect(request?.init?.body).toBe('{}');
    expect(request?.init?.headers?.authorization).toBe(`Bearer ${EDITOR_TOKEN}`);

    // Picker mode was asked of the DevTools panel — never "an element was
    // picked", and never "the panel is in picker mode": the reply proves the
    // request reached the panel, not that the page could arm its picker.
    expect(notice.level).toBe('info');
    expect(notice.message).toMatch(/picker mode/i);
    expect(notice.message).not.toMatch(/\bis (now )?in picker mode/i);
    expect(shownText(notice)).toMatch(/chrome devtools/i);
    expect(shownText(notice)).not.toMatch(/\b(was|is|has been) (picked|selected)\b/i);
    // An informational notice settles nothing: the request is accepted after it.
    expect(await resultOf(harness, pick)).toBe('accepted');

    // Nothing credential-bearing or identifying is shown or logged.
    expect(shownText(notice)).not.toContain(EDITOR_TOKEN);
    expect(shownText(notice)).not.toContain(SERVICE_URL);
    expect(shownText(notice)).not.toContain(String(BOUND_TAB_ID));
    expect(JSON.stringify(harness.logs)).not.toContain(EDITOR_TOKEN);
  });

  it('reports TAB_NOT_BOUND as an error that sends the developer to the DevTools panel', async () => {
    const harness = createHarness();
    harness.state.adoptSession(makeSession(), SERVICE_URL);
    harness.reply({
      kind: 'reply',
      status: 409,
      body: { code: 'TAB_NOT_BOUND', message: 'No DevTools tab is bound to this session' },
    });
    const requestTarget = vi.spyOn(harness.client, 'requestTarget');

    const pick = harness.pickElement();

    const notice = await onlyNotice(harness);
    expect(requestTarget).toHaveBeenCalledTimes(1);
    expect(notice.level).toBe('error');
    expect(notice.message).toMatch(/devtools/i);
    expect(notice.hint).toMatch(/devtools/i);
    expect(notice.hint).toMatch(/debug generator panel/i);
    expect(notices(harness.posted).some((frame) => frame.level === 'info')).toBe(false);
    expect(shownText(notice)).not.toMatch(/picker mode/i);
    expect(shownText(notice)).not.toContain(EDITOR_TOKEN);
    expect(await resultOf(harness, pick)).toBe('failed');

    const warning = harness.logs.find((record) => record.level === 'warn');
    expect(warning?.fields).toMatchObject({ action: 'requestTarget', code: 'TAB_NOT_BOUND' });
    expect(JSON.stringify(harness.logs)).not.toContain(EDITOR_TOKEN);
  });

  it('reports an offline bound panel (503) as a reconnect step, not a service failure', async () => {
    const harness = createHarness();
    harness.state.adoptSession(makeSession(), SERVICE_URL);
    harness.reply({
      kind: 'reply',
      status: 503,
      body: { code: 'TRANSPORT_DISCONNECTED', message: 'The bound DevTools tab is offline' },
    });

    const pick = harness.pickElement();

    const notice = await onlyNotice(harness);
    expect(notice.level).toBe('error');
    expect(notice.hint).toMatch(/devtools/i);
    expect(notice.hint).toMatch(/connected/i);
    // The protocol client's generic 5xx advice would blame the service.
    expect(notice.hint).not.toMatch(/service failed/i);
    expect(await resultOf(harness, pick)).toBe('failed');
  });

  it('keeps the client hint when the service itself cannot be reached', async () => {
    const harness = createHarness();
    harness.state.adoptSession(makeSession(), SERVICE_URL);
    harness.reply({ kind: 'unreachable' });

    const pick = harness.pickElement();

    const notice = await onlyNotice(harness);
    expect(harness.sent).toHaveLength(1);
    expect(notice.level).toBe('error');
    expect(notice.hint).toMatch(/not be running/i);
    expect(notice.hint).not.toMatch(/debug generator panel/i);
    expect(await resultOf(harness, pick)).toBe('failed');
  });

  it.each([
    { status: 409, code: 'SESSION_INVALID_STATE', message: 'The session has ended' },
    { status: 404, code: 'SESSION_NOT_FOUND', message: 'No such session' },
  ])('reports $code with a step that starts a new session', async ({ status, code, message }) => {
    const harness = createHarness();
    harness.state.adoptSession(makeSession(), SERVICE_URL);
    harness.reply({ kind: 'reply', status, body: { code, message } });

    const pick = harness.pickElement();

    const notice = await onlyNotice(harness);
    expect(notice.level).toBe('error');
    expect(notice.hint).toMatch(/start a new session/i);
    expect(await resultOf(harness, pick)).toBe('failed');
  });
});
