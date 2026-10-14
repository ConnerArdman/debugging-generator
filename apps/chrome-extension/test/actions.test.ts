/**
 * Unit spec for `../src/panel/actions.ts` — the DevTools panel's
 * `onOpenSource`, from the worker's answer to what the developer sees.
 *
 * Two product guarantees are held here:
 *
 * - **No editor still opens the source (AAP §0.2.3).** When the worker answers
 *   `forwarded: false` — the service reported that no VS Code window is
 *   connected — the panel dispatches exactly the protocol's
 *   `buildEditorOpenUri(location)`, through an injected dispatcher or through
 *   its default transient anchor, and leaves nothing behind in the DOM. A
 *   location with no such URI, or a dispatch that fails, is surfaced with fixed
 *   copy. `forwarded: true` — the editor opened it — dismisses the failure this
 *   module surfaced before.
 * - **No raw error text reaches the panel (CWE-209).** Every failure is shown
 *   with fixed, code-specific copy: a rejection whose message (or hint)
 *   carries a private sentinel never puts that sentinel on screen or in a log.
 *   An unexpected code, a non-`DebuggenError` rejection and a throwing session
 *   reader show one fixed sentence with a reference that is also logged.
 *
 * **Harness.** Collected by the root `vitest.config.ts` into the
 * `chrome-extension` project (happy-dom, which supplies the `document` the
 * default dispatcher clicks an anchor in). `createPanelActions` is fully
 * injectable, so every dependency is a recording fake local to this file; the
 * store's `lastError` is a plain variable read back through `getLastError`.
 * `HTMLAnchorElement.prototype.click` is spied on (and made inert) wherever the
 * default dispatcher runs, so nothing navigates. Paths and ids are neutral
 * synthetic values (AAP §0.5.4).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { buildEditorOpenUri } from '@debuggen/protocol';
import type { ErrorPayload } from '@debuggen/protocol';
import { DebuggenError, formatSourceLocation } from '@debuggen/shared';
import type {
  DebuggenErrorCode,
  LogFields,
  Logger,
  LogLevel,
  SessionId,
  SourceLocation,
} from '@debuggen/shared';

import { createPanelActions, OPEN_FAILURE_REASONS } from '../src/panel/actions';
import type {
  DevtoolsPanelActions,
  PanelActionsOptions,
  SourceOpenRequest,
  SourceOpenResponsePayload,
} from '../src/panel/actions';

/*
 * ===========================================================================
 * Fixtures
 * ===========================================================================
 */

const SESSION_ID: SessionId = 'ses_actions_a';

const LOCATION: SourceLocation = {
  file: 'src/lib/a+b query.ts',
  line: 42,
  column: 7,
  symbol: 'loadRows',
  resolvedBy: 'code-graph',
  confidence: 0.8,
};

/** The chip label every failure sentence starts from. */
const LABEL = formatSourceLocation(LOCATION);

/** A private value no panel sentence and no log line may ever contain. */
const SENTINEL = '/home/secret/token=abc';

/** The fixed sentence prefix every open failure is built on. */
function openFailure(reason: string): string {
  return `Could not open ${LABEL} in the editor: ${reason}`;
}

/** The URI the fallback must dispatch, from the protocol's one builder. */
function expectedUri(location: SourceLocation = LOCATION): string {
  const built = buildEditorOpenUri(location);
  if (!built.ok) {
    throw new Error('the fixture location must have an editor-open URI');
  }
  return built.value;
}

/*
 * ===========================================================================
 * Fakes
 * ===========================================================================
 */

interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

function createRecordingLogger(entries: LogEntry[], bindings: LogFields = {}): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields: { ...bindings, ...fields } });
    };
  return {
    level: 'trace',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: (more) => createRecordingLogger(entries, { ...bindings, ...more }),
  };
}

/** Everything a case drives or inspects. */
interface Harness {
  readonly actions: DevtoolsPanelActions;
  readonly request: Mock<SourceOpenRequest>;
  readonly getSessionId: Mock<() => SessionId | undefined>;
  readonly reportError: Mock<(error: ErrorPayload | undefined) => void>;
  readonly openExternalUri: Mock<(uri: string) => boolean> | undefined;
  readonly logs: LogEntry[];
  /** The store's current non-blocking failure. */
  readonly lastError: () => ErrorPayload | undefined;
}

interface HarnessOptions {
  /** Inject a recording dispatcher (the default) or leave the module's own. */
  readonly injectDispatcher?: boolean;
  /** The dispatcher's answer when injected. */
  readonly dispatchResult?: boolean;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const logs: LogEntry[] = [];
  let lastError: ErrorPayload | undefined;

  const request = vi.fn<SourceOpenRequest>(() => Promise.resolve({ forwarded: true }));
  const getSessionId = vi.fn<() => SessionId | undefined>(() => SESSION_ID);
  const reportError = vi.fn<(error: ErrorPayload | undefined) => void>((error) => {
    lastError = error;
  });
  const openExternalUri =
    options.injectDispatcher === false
      ? undefined
      : vi.fn<(uri: string) => boolean>(() => options.dispatchResult ?? true);

  const actionOptions: PanelActionsOptions = {
    request,
    getSessionId,
    selectEvent: vi.fn(),
    reportError,
    getLastError: () => lastError,
    logger: createRecordingLogger(logs),
    ...(openExternalUri === undefined ? {} : { openExternalUri }),
  };

  return {
    actions: createPanelActions(actionOptions),
    request,
    getSessionId,
    reportError,
    openExternalUri,
    logs,
    lastError: () => lastError,
  };
}

/** Let the fire-and-forget request settle and its handlers run. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Answer the next request with a worker response. */
function answerWith(harness: Harness, response: SourceOpenResponsePayload): void {
  harness.request.mockImplementationOnce(() => Promise.resolve(response));
}

/** Reject the next request with `cause`. */
function rejectWith(harness: Harness, cause: Error): void {
  harness.request.mockImplementationOnce(() => Promise.reject(cause));
}

/** Click a source chip and let everything settle. */
async function click(harness: Harness, location: SourceLocation = LOCATION): Promise<void> {
  harness.actions.onOpenSource(location);
  await flush();
}

/** Assert nothing private reached the panel or the log. */
function expectNoLeak(harness: Harness, ...secrets: readonly string[]): void {
  const shown = JSON.stringify(harness.reportError.mock.calls);
  const logged = JSON.stringify(harness.logs);
  for (const secret of secrets) {
    expect(shown, 'nothing private is shown in the panel').not.toContain(secret);
    expect(logged, 'nothing private is logged').not.toContain(secret);
  }
}

/*
 * ===========================================================================
 * Cases
 * ===========================================================================
 */

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('createPanelActions — the editor opened the location (forwarded: true)', () => {
  it('dismisses the failure this module surfaced, and dispatches no URI', async () => {
    const harness = createHarness();
    rejectWith(harness, new DebuggenError('TRANSPORT_DISCONNECTED', 'down'));
    await click(harness);
    expect(harness.lastError()?.code).toBe('TRANSPORT_DISCONNECTED');

    answerWith(harness, { forwarded: true });
    await click(harness);

    expect(harness.lastError()).toBeUndefined();
    expect(harness.openExternalUri).not.toHaveBeenCalled();
  });

  it('leaves an unrelated failure on screen', async () => {
    const harness = createHarness();
    const unrelated: ErrorPayload = { code: 'CAPTURE_EMPTY', message: 'Nothing captured.' };
    rejectWith(harness, new DebuggenError('TRANSPORT_DISCONNECTED', 'down'));
    await click(harness);
    harness.reportError(unrelated);

    answerWith(harness, { forwarded: true });
    await click(harness);

    expect(harness.lastError()).toBe(unrelated);
  });

  it('sends the location by reference, with the session id', async () => {
    const harness = createHarness();
    await click(harness);

    expect(harness.request).toHaveBeenCalledTimes(1);
    const [kind, payload] = harness.request.mock.calls[0] ?? [];
    expect(kind).toBe('source.open');
    expect(payload?.sessionId).toBe(SESSION_ID);
    expect(payload?.location).toBe(LOCATION);
  });
});

describe('createPanelActions — no editor is connected (forwarded: false)', () => {
  it('dispatches exactly buildEditorOpenUri(location) through the injected dispatcher', async () => {
    const harness = createHarness();
    answerWith(harness, { forwarded: false });
    await click(harness);

    expect(harness.openExternalUri).toHaveBeenCalledTimes(1);
    expect(harness.openExternalUri).toHaveBeenCalledWith(expectedUri());
    expect(harness.lastError()).toBeUndefined();
    expect(
      harness.logs.some((entry) => entry.level === 'info' && entry.message.includes('URI handler')),
    ).toBe(true);
    expectNoLeak(harness, LOCATION.file, expectedUri());
  });

  it('dismisses the failure this module surfaced once the hand-off succeeds', async () => {
    const harness = createHarness();
    rejectWith(harness, new DebuggenError('TRANSPORT_DISCONNECTED', 'down'));
    await click(harness);
    expect(harness.lastError()).toBeDefined();

    answerWith(harness, { forwarded: false });
    await click(harness);

    expect(harness.lastError()).toBeUndefined();
  });

  it('dispatches through a transient anchor by default and leaves nothing in the DOM', async () => {
    const seen: { href: string | null; rel: string; connected: boolean }[] = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      seen.push({
        href: this.getAttribute('href'),
        rel: this.rel,
        connected: this.isConnected,
      });
    });
    const harness = createHarness({ injectDispatcher: false });
    const anchorsBefore = document.querySelectorAll('a').length;
    answerWith(harness, { forwarded: false });
    await click(harness);

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ href: expectedUri(), rel: 'noopener noreferrer', connected: true }]);
    expect(document.querySelectorAll('a')).toHaveLength(anchorsBefore);
    expect(harness.lastError()).toBeUndefined();
  });

  it('removes the default anchor even when its click throws, and surfaces fixed copy', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error(SENTINEL);
    });
    const harness = createHarness({ injectDispatcher: false });
    answerWith(harness, { forwarded: false });
    await click(harness);

    expect(document.querySelectorAll('a')).toHaveLength(0);
    expect(harness.lastError()?.code).toBe('TRANSPORT_DISCONNECTED');
    expectNoLeak(harness, SENTINEL);
  });

  it('touches no document until the fallback is needed', async () => {
    const createElement = vi.spyOn(document, 'createElement');
    const harness = createHarness({ injectDispatcher: false });
    await click(harness);

    expect(createElement).not.toHaveBeenCalled();
  });

  it('reports a failed hand-off where no document exists', async () => {
    const harness = createHarness({ injectDispatcher: false });
    vi.stubGlobal('document', undefined);
    answerWith(harness, { forwarded: false });
    await click(harness);
    vi.unstubAllGlobals();

    expect(harness.lastError()?.code).toBe('TRANSPORT_DISCONNECTED');
  });

  it('surfaces fixed TRANSPORT_DISCONNECTED copy when the dispatcher refuses', async () => {
    const harness = createHarness({ dispatchResult: false });
    answerWith(harness, { forwarded: false });
    await click(harness);

    const shown = harness.lastError();
    expect(shown?.code).toBe('TRANSPORT_DISCONNECTED');
    expect(shown?.message).toBe(
      openFailure(
        'VS Code is not connected to the local Debug Generator service, and the panel could not hand the location to VS Code directly. Open the project in VS Code and start a session from the Debug Generator view, then click the source link again.',
      ),
    );
    expect(shown?.ref).toBeUndefined();
  });

  it('surfaces the same fixed copy when the dispatcher throws, logging only its name', async () => {
    const harness = createHarness();
    harness.openExternalUri?.mockImplementation(() => {
      throw new TypeError(SENTINEL);
    });
    answerWith(harness, { forwarded: false });
    await click(harness);

    expect(harness.lastError()?.code).toBe('TRANSPORT_DISCONNECTED');
    expect(harness.lastError()?.message).toContain('VS Code is not connected');
    expect(harness.logs.some((entry) => entry.fields.error === 'TypeError')).toBe(true);
    expectNoLeak(harness, SENTINEL);
  });

  it.each<[string, SourceLocation]>([
    ['an absolute path', { ...LOCATION, file: '/etc/hosts' }],
    ['a traversal', { ...LOCATION, file: '../outside.ts' }],
    ['a zero line', { ...LOCATION, line: 0 }],
    ['a lone surrogate', { ...LOCATION, file: 'src/\ud800.ts' }],
  ])(
    'surfaces fixed PROTOCOL_INVALID_MESSAGE copy for %s, dispatching nothing',
    async (_label, location) => {
      const harness = createHarness();
      answerWith(harness, { forwarded: false });
      await click(harness, location);

      expect(harness.openExternalUri).not.toHaveBeenCalled();
      const shown = harness.lastError();
      expect(shown?.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(shown?.message).toBe(
        `Could not open ${formatSourceLocation(location)} in the editor: VS Code is not connected to the local Debug Generator service, and this location cannot be handed to VS Code directly. Open the project in VS Code and start a session from the Debug Generator view, then click the source link again.`,
      );
    },
  );
});

describe('createPanelActions — failure copy never carries raw error text (CWE-209)', () => {
  /** The codes the source-open path produces, each with fixed copy. */
  const ALLOWLISTED: readonly DebuggenErrorCode[] = [
    'PATH_OUTSIDE_PROJECT',
    'FS_UNSAFE_PATH',
    'PROJECT_NOT_FOUND',
    'SESSION_NOT_FOUND',
    'TAB_NOT_BOUND',
    'UNAUTHORIZED',
    'PROTOCOL_INVALID_MESSAGE',
    'TRANSPORT_DISCONNECTED',
    'RATE_LIMITED',
  ];

  /** The fixed sentence for an allowlisted code. */
  function reasonFor(code: DebuggenErrorCode): string {
    const reason = OPEN_FAILURE_REASONS[code];
    if (reason === undefined) {
      throw new Error(`no fixed copy for ${code}`);
    }
    return reason;
  }

  /** The WARN records the actions wrote. */
  function warnings(harness: Harness): readonly LogEntry[] {
    return harness.logs.filter((entry) => entry.level === 'warn');
  }

  /** The reference an unexpected-error sentence shows. */
  function shownReference(message: string | undefined): string | undefined {
    return /\(reference ([A-Za-z0-9_-]+)\)/u.exec(message ?? '')?.[1];
  }

  it('allowlists exactly the codes the source-open path produces', () => {
    expect(Object.keys(OPEN_FAILURE_REASONS).sort()).toEqual([...ALLOWLISTED].sort());
    expect(Object.isFrozen(OPEN_FAILURE_REASONS)).toBe(true);
  });

  it.each(ALLOWLISTED)(
    'shows fixed %s copy with its next step, never the message or hint',
    async (code) => {
      const harness = createHarness();
      rejectWith(
        harness,
        new DebuggenError(code, `Refused ${SENTINEL} because of SELECT * FROM secrets`, {
          hint: `Try ${SENTINEL}`,
          details: { reason: 'refused', ref: 'msg_worker_ref_1' },
        }),
      );
      await click(harness);

      const shown = harness.lastError();
      expect(shown).toEqual({
        code,
        message: openFailure(reasonFor(code)),
        ref: 'msg_worker_ref_1',
      });
      expect(shown?.message).toMatch(
        /(?:click the source link again|try again|if you need it)\.$/u,
      );
      expectNoLeak(harness, SENTINEL, 'SELECT * FROM secrets');
      expect(warnings(harness)).toEqual([
        {
          level: 'warn',
          message: 'A source-open request failed.',
          fields: { code, reason: 'refused', ref: 'msg_worker_ref_1' },
        },
      ]);
    },
  );

  it('pins the transport and containment sentences', () => {
    expect(OPEN_FAILURE_REASONS.TRANSPORT_DISCONNECTED).toBe(
      'the extension could not get an answer from the local Debug Generator service. Check that the service is running and the panel shows Connected, then click the source link again.',
    );
    expect(OPEN_FAILURE_REASONS.PATH_OUTSIDE_PROJECT).toBe(
      "the location is outside the session's project folder, so Debug Generator will not open it. Open the file from VS Code's Explorer if you need it.",
    );
  });

  it.each(['refused', 'timeout', 'disconnected'])(
    'shows the fixed transport copy for a TRANSPORT_DISCONNECTED rejection (%s)',
    async (reason) => {
      const harness = createHarness();
      rejectWith(
        harness,
        new DebuggenError(
          'TRANSPORT_DISCONNECTED',
          `The worker could not reach ${SENTINEL} within 15000 ms.`,
          { details: { reason } },
        ),
      );
      await click(harness);

      expect(harness.lastError()).toEqual({
        code: 'TRANSPORT_DISCONNECTED',
        message: openFailure(reasonFor('TRANSPORT_DISCONNECTED')),
      });
      expectNoLeak(harness, SENTINEL);
    },
  );

  it('drops a ref that is not an opaque id instead of storing it', async () => {
    const harness = createHarness();
    rejectWith(
      harness,
      new DebuggenError('PATH_OUTSIDE_PROJECT', 'Refused.', {
        details: { reason: 'refused', ref: SENTINEL },
      }),
    );
    await click(harness);

    expect(harness.lastError()?.ref).toBeUndefined();
    expectNoLeak(harness, SENTINEL);
  });

  it.each<DebuggenErrorCode>(['INTERNAL', 'STORE_ERROR', 'MODEL_UNAVAILABLE'])(
    'shows the fixed unexpected sentence for %s with the failure ref, also logged',
    async (code) => {
      const harness = createHarness();
      rejectWith(
        harness,
        new DebuggenError(code, `Crashed at ${SENTINEL}`, {
          hint: SENTINEL,
          details: { reason: 'refused', ref: 'msg_worker_ref_2' },
        }),
      );
      await click(harness);

      const shown = harness.lastError();
      expect(shown?.code).toBe(code);
      expect(shown?.ref).toBe('msg_worker_ref_2');
      expect(shown?.message).toBe(
        openFailure(
          'Debug Generator hit an unexpected error (reference msg_worker_ref_2). Reload the Debug Generator panel and click the source link again; if it keeps failing, report this reference.',
        ),
      );
      expect(warnings(harness)).toEqual([
        {
          level: 'warn',
          message: 'A source-open request failed unexpectedly.',
          fields: { code, reason: 'refused', ref: 'msg_worker_ref_2', error: 'DebuggenError' },
        },
      ]);
      expectNoLeak(harness, SENTINEL);
    },
  );

  it('mints a fresh reference for an unexpected failure that carried none', async () => {
    const harness = createHarness();
    rejectWith(harness, new DebuggenError('INTERNAL', SENTINEL));
    await click(harness);
    const first = harness.lastError();
    rejectWith(harness, new DebuggenError('INTERNAL', SENTINEL));
    await click(harness);
    const second = harness.lastError();

    const firstRef = shownReference(first?.message);
    expect(firstRef).toMatch(/^msg_/u);
    expect(first?.ref).toBe(firstRef);
    expect(shownReference(second?.message)).not.toBe(firstRef);
    expect(warnings(harness).map((entry) => entry.fields.ref)).toEqual([
      firstRef,
      shownReference(second?.message),
    ]);
    expectNoLeak(harness, SENTINEL);
  });

  it('mints a reference instead of echoing a ref that is not an opaque id', async () => {
    const harness = createHarness();
    rejectWith(
      harness,
      new DebuggenError('INTERNAL', 'Crashed.', { details: { reason: 'refused', ref: SENTINEL } }),
    );
    await click(harness);

    expect(shownReference(harness.lastError()?.message)).toMatch(/^msg_/u);
    expectNoLeak(harness, SENTINEL);
  });

  it('treats a rejection that is not a DebuggenError as INTERNAL and unexpected', async () => {
    const harness = createHarness();
    rejectWith(harness, new RangeError(SENTINEL));
    await click(harness);

    const shown = harness.lastError();
    expect(shown?.code).toBe('INTERNAL');
    const ref = shownReference(shown?.message);
    expect(ref).toMatch(/^msg_/u);
    expect(shown?.ref).toBe(ref);
    expect(warnings(harness)).toEqual([
      {
        level: 'warn',
        message: 'A source-open request failed unexpectedly.',
        fields: { code: 'INTERNAL', reason: 'untyped-rejection', ref, error: 'RangeError' },
      },
    ]);
    expectNoLeak(harness, SENTINEL);
  });

  it('treats a throwing session reader as an unexpected INTERNAL fault, sending nothing', async () => {
    const harness = createHarness();
    harness.getSessionId.mockImplementation(() => {
      throw new Error(SENTINEL);
    });
    await click(harness);

    expect(harness.request).not.toHaveBeenCalled();
    const shown = harness.lastError();
    expect(shown?.code).toBe('INTERNAL');
    const ref = shownReference(shown?.message);
    expect(ref).toMatch(/^msg_/u);
    expect(warnings(harness)).toEqual([
      {
        level: 'warn',
        message: 'A source-open request failed unexpectedly.',
        fields: { code: 'INTERNAL', reason: 'session-reader-threw', ref, error: 'Error' },
      },
    ]);
    expectNoLeak(harness, SENTINEL);
  });

  it('keeps a session reader that throws a typed error unexpected too', async () => {
    const harness = createHarness();
    harness.getSessionId.mockImplementation(() => {
      throw new DebuggenError('PATH_OUTSIDE_PROJECT', SENTINEL);
    });
    await click(harness);

    expect(harness.lastError()?.code).toBe('INTERNAL');
    expect(shownReference(harness.lastError()?.message)).toMatch(/^msg_/u);
    expectNoLeak(harness, SENTINEL);
  });

  it('shows fixed TAB_NOT_BOUND copy for a panel without a session, sending nothing', async () => {
    const harness = createHarness();
    harness.getSessionId.mockReturnValue(undefined);
    await click(harness);

    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.lastError()).toEqual({
      code: 'TAB_NOT_BOUND',
      message: openFailure(reasonFor('TAB_NOT_BOUND')),
    });
  });

  it('bounds the sentence for a very long location label', async () => {
    const harness = createHarness();
    const location: SourceLocation = { ...LOCATION, file: `src/${'a'.repeat(3000)}.ts` };
    rejectWith(harness, new DebuggenError('PROJECT_NOT_FOUND', SENTINEL));
    await click(harness, location);

    const message = harness.lastError()?.message ?? '';
    expect(message.length).toBeLessThanOrEqual(2000);
    expect(message.endsWith('\u2026')).toBe(true);
  });
});
