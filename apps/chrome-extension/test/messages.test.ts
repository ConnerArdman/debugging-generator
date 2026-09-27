/**
 * Unit spec for the panel ↔ worker half of `../src/shared/messages.ts` and for
 * the worker's failure builder `portErr` in `../src/background/messages.ts`.
 *
 * What it proves:
 *
 * - **Every panel-bound frame is parsed, not narrowed (CWE-20).** A response is
 *   admitted only when its kind's own check accepts the payload — the
 *   protocol's wire schemas for wire bodies, an exact structural check for the
 *   extension-internal answers — and a push only when its content parses; the
 *   parsers answer the parsed value, never the input object, and a frame that
 *   is recognisably a response or a push but fails its parse is classified as
 *   malformed (with its correlation, when readable) rather than dropped
 *   silently or forwarded.
 * - **The capture-conflict detail crosses the port, and nothing else does.**
 *   `portErr` copies the schema-valid `owningSessionId` of a `capture.start`
 *   refused with `CAPTURE_ALREADY_ACTIVE`, and no other `details` field, and
 *   the panel's parser admits that detail on that answer only.
 * - **The reload offer vocabulary is closed.**
 * - **Picker mode's two new frames mean one thing each.** The `picker` push
 *   admits exactly `{ active: boolean }`; `target.request` admits a `cancel`
 *   flag that is absent or exactly `true`, on the page channel and on the
 *   bridge port alike, and the bridge port still requires the request id.
 *
 * Every fixture is built from the protocol's own constructors (`createEnvelope`)
 * and the shared id minters, so ids and envelopes are exactly what the running
 * extension exchanges.
 */
import { describe, expect, it } from 'vitest';

import { CAPTURE_CONFLICT_ERROR_CODE, createEnvelope } from '@debuggen/protocol';
import { DebuggenError, newCaptureId, newSessionId } from '@debuggen/shared';

import { portErr } from '../src/background/messages';
import {
  BRIDGE_SOURCE_TAG,
  EXTENSION_CHANNEL,
  PAGE_CHANNEL_VERSION,
  PAGE_RELOAD_ACTION_LABEL,
  PANEL_RELOAD_NOT_NEEDED,
  PANEL_RELOAD_REASONS,
  PORT_PROTOCOL_VERSION,
  PORT_PUSH_KINDS,
  classifyPanelPortFrame,
  isBridgeChannelMessage,
  isBridgeDownstreamMessage,
  isPanelReloadState,
  isPortPush,
  isPortRequest,
  isPortResponse,
  newPortRequestId,
  parsePortPush,
  parsePortResponse,
  parseRelayedMessage,
  portErrorOwningSessionId,
  readPortResponseCorrelation,
} from '../src/shared/messages';
import type { PortRequestFrame, PortRequestKind } from '../src/shared/messages';

const SESSION = newSessionId();
const OTHER_SESSION = newSessionId();
const CAPTURE = newCaptureId();

const FRAMING = {
  channel: EXTENSION_CHANNEL,
  version: PORT_PROTOCOL_VERSION,
} as const;

/** A worker → panel success frame of `kind` carrying `payload` verbatim. */
function success(
  kind: PortRequestKind,
  payload: unknown,
  requestId = 'req-1',
): Readonly<Record<string, unknown>> {
  return { ...FRAMING, direction: 'response', requestId, kind, ok: true, payload };
}

/** A worker → panel failure frame of `kind` carrying `error` verbatim. */
function failure(
  kind: PortRequestKind,
  error: unknown,
  requestId = 'req-1',
): Readonly<Record<string, unknown>> {
  return { ...FRAMING, direction: 'response', requestId, kind, ok: false, error };
}

/** A worker → panel push frame. */
function push(fields: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return { ...FRAMING, direction: 'push', ...fields };
}

/** A panel → worker `capture.start` request, as the hub hands it to `portErr`. */
function captureStartRequest(): PortRequestFrame<'capture.start'> {
  return {
    ...FRAMING,
    direction: 'request',
    requestId: newPortRequestId(),
    kind: 'capture.start',
    payload: { sessionId: SESSION },
  };
}

/** A panel → worker `capture.stop` request, as the hub hands it to `portErr`. */
function captureStopRequest(): PortRequestFrame<'capture.stop'> {
  return {
    ...FRAMING,
    direction: 'request',
    requestId: newPortRequestId(),
    kind: 'capture.stop',
    payload: { sessionId: SESSION },
  };
}

/** A valid, empty metrics page — the smallest wire `DataResult`. */
const METRICS_PAGE = {
  source: 'metrics',
  metrics: [],
  total: 0,
  limit: 200,
  offset: 0,
  nextOffset: null,
} as const;

const CONNECTED = { status: 'connected' } as const;
const UNBOUND = { kind: 'unbound' } as const;

describe('parsePortResponse — success answers are parsed by their kind', () => {
  it('admits a well-formed answer of every structural kind and returns a new object', () => {
    const frames: readonly [PortRequestKind, unknown][] = [
      ['source.open', { forwarded: true }],
      ['target.pick', { active: false }],
      ['target.selected', { accepted: true }],
      ['pair.complete', { paired: true }],
      ['capture.start', { captureId: CAPTURE }],
      ['panelData.query', METRICS_PAGE],
      ['session.snapshot', { connection: CONNECTED, binding: UNBOUND }],
      [
        'page.reload',
        { documentId: 'doc-reloaded', installedBeforeReact: true, reactDetected: true },
      ],
    ];
    for (const [kind, payload] of frames) {
      const frame = success(kind, payload);
      const parsed = parsePortResponse(frame);
      expect(parsed, kind).toEqual(frame);
      expect(parsed, kind).not.toBe(frame);
      expect(isPortResponse(frame), kind).toBe(true);
    }
  });

  it('never reads an empty, partial or widened answer as a completed pairing', () => {
    for (const payload of [
      {},
      { paired: false },
      { paired: 'yes' },
      { paired: true, token: 'x' },
    ]) {
      expect(parsePortResponse(success('pair.complete', payload))).toBeUndefined();
    }
  });

  it('refuses a one-flag answer with a wrong type, a missing flag or an extra key', () => {
    expect(parsePortResponse(success('source.open', { forwarded: 1 }))).toBeUndefined();
    expect(parsePortResponse(success('target.pick', {}))).toBeUndefined();
    expect(
      parsePortResponse(success('target.selected', { accepted: true, extra: 1 })),
    ).toBeUndefined();
  });

  it('parses wire bodies with the protocol schemas', () => {
    expect(parsePortResponse(success('capture.start', {}))).toBeUndefined();
    expect(parsePortResponse(success('capture.start', { captureId: '' }))).toBeUndefined();
    expect(parsePortResponse(success('capture.stop', { summary: 'nope' }))).toBeUndefined();
    expect(parsePortResponse(success('panelData.query', { source: 'metrics' }))).toBeUndefined();
    expect(
      parsePortResponse(success('panelData.query', { ...METRICS_PAGE, source: 'unknown' })),
    ).toBeUndefined();
  });

  it('parses every part of a session snapshot, and refuses the whole snapshot when one part fails', () => {
    const offered = { kind: 'offered', reason: 'agent-missing' } as const;
    expect(
      parsePortResponse(
        success('session.snapshot', { connection: CONNECTED, binding: UNBOUND, reload: offered }),
      ),
    ).toEqual(
      success('session.snapshot', { connection: CONNECTED, binding: UNBOUND, reload: offered }),
    );
    const malformedParts: readonly Readonly<Record<string, unknown>>[] = [
      { binding: UNBOUND },
      { connection: { status: 'online' }, binding: UNBOUND },
      { connection: CONNECTED, binding: { kind: 'bound' } },
      { connection: CONNECTED, binding: UNBOUND, session: { id: SESSION } },
      { connection: CONNECTED, binding: UNBOUND, panel: { title: 'x' } },
      { connection: CONNECTED, binding: UNBOUND, analysis: {} },
      { connection: CONNECTED, binding: UNBOUND, reload: { kind: 'offered' } },
      { connection: CONNECTED, binding: UNBOUND, unexpected: true },
    ];
    for (const payload of malformedParts) {
      expect(parsePortResponse(success('session.snapshot', payload))).toBeUndefined();
    }
  });

  it('rebuilds the connection and binding states from their declared fields only', () => {
    const parsed = parsePortResponse(
      success('session.snapshot', {
        connection: { status: 'reconnecting', retryInMs: 500, hasCredential: true },
        binding: {
          kind: 'bound',
          sessionId: SESSION,
          tabId: 7,
          url: 'http://127.0.0.1:3000/',
          x: 1,
        },
      }),
    );
    expect(parsed).toMatchObject({
      ok: true,
      payload: {
        connection: { status: 'reconnecting', retryInMs: 500 },
        binding: { kind: 'bound', sessionId: SESSION, tabId: 7, url: 'http://127.0.0.1:3000/' },
      },
    });
    if (parsed?.ok !== true || parsed.kind !== 'session.snapshot') {
      throw new Error('expected a parsed snapshot');
    }
    expect(Object.keys(parsed.payload.connection)).toEqual(['status', 'retryInMs']);
    expect(Object.keys(parsed.payload.binding)).toEqual(['kind', 'sessionId', 'tabId', 'url']);
  });

  it('refuses a page.reload answer that is incomplete or mistyped', () => {
    expect(
      parsePortResponse(success('page.reload', { documentId: 'doc', installedBeforeReact: true })),
    ).toBeUndefined();
    expect(
      parsePortResponse(
        success('page.reload', { documentId: '', installedBeforeReact: true, reactDetected: true }),
      ),
    ).toBeUndefined();
  });

  it('refuses a frame with an extra framing key, a missing request id or an unknown kind', () => {
    const frame = success('source.open', { forwarded: true });
    expect(parsePortResponse({ ...frame, extra: 1 })).toBeUndefined();
    expect(parsePortResponse({ ...frame, requestId: '' })).toBeUndefined();
    expect(parsePortResponse({ ...frame, kind: 'session.delete' })).toBeUndefined();
    expect(parsePortResponse({ ...frame, version: PORT_PROTOCOL_VERSION + 1 })).toBeUndefined();
  });
});

describe('parsePortResponse — failure answers', () => {
  it('admits the protocol error payload and refuses a code outside the vocabulary', () => {
    const error = { code: 'TAB_NOT_BOUND', message: 'No tab.', ref: 'req-9' };
    expect(parsePortResponse(failure('target.pick', error))).toEqual(failure('target.pick', error));
    expect(
      parsePortResponse(failure('target.pick', { code: 'NOT_A_CODE', message: 'x' })),
    ).toBeUndefined();
    expect(parsePortResponse(failure('target.pick', { code: 'INTERNAL' }))).toBeUndefined();
  });

  it('admits the owning session of a capture conflict on a capture.start answer only', () => {
    const conflict = {
      code: CAPTURE_CONFLICT_ERROR_CODE,
      message: 'Another session is capturing this project.',
      owningSessionId: OTHER_SESSION,
    };
    const parsed = parsePortResponse(failure('capture.start', conflict));
    expect(parsed).toEqual(failure('capture.start', conflict));
    if (parsed?.ok !== false) {
      throw new Error('expected a failure');
    }
    expect(portErrorOwningSessionId(parsed.error)).toBe(OTHER_SESSION);

    expect(parsePortResponse(failure('capture.stop', conflict))).toBeUndefined();
    expect(
      parsePortResponse(failure('capture.start', { ...conflict, code: 'SESSION_INVALID_STATE' })),
    ).toBeUndefined();
  });

  it('reads no owning session from a plain error', () => {
    expect(portErrorOwningSessionId({ code: 'INTERNAL', message: 'x' })).toBeUndefined();
  });
});

describe('parsePortPush — pushes are parsed, relayed frames with the protocol union', () => {
  it('admits a relayed protocol envelope and answers the parsed envelope', () => {
    const envelope = createEnvelope(
      'capture.started',
      { sessionId: SESSION, captureId: CAPTURE },
      { sessionId: SESSION },
    );
    const frame = push({ kind: 'protocol', message: envelope });
    const parsed = parsePortPush(frame);
    expect(parsed).toEqual(frame);
    expect(parsed).not.toBe(frame);
    expect(parseRelayedMessage(envelope)).toEqual(envelope);
    expect(isPortPush(frame)).toBe(true);
  });

  it('refuses an envelope whose payload fails its schema, or whose type is not relayed', () => {
    const envelope = createEnvelope(
      'capture.started',
      { sessionId: SESSION, captureId: CAPTURE },
      { sessionId: SESSION },
    );
    expect(
      parsePortPush(push({ kind: 'protocol', message: { ...envelope, payload: {} } })),
    ).toBeUndefined();
    expect(
      parsePortPush(
        push({ kind: 'protocol', message: { ...envelope, payload: { sessionId: SESSION } } }),
      ),
    ).toBeUndefined();
    const notRelayed = createEnvelope('tab.navigated', { tabId: 3, url: 'http://127.0.0.1:3000/' });
    expect(parsePortPush(push({ kind: 'protocol', message: notRelayed }))).toBeUndefined();
    expect(parseRelayedMessage(notRelayed)).toBeUndefined();
  });

  it('admits and rebuilds the connection, binding and reload states', () => {
    expect(
      parsePortPush(push({ kind: 'connection', state: { status: 'not-paired', x: 1 } })),
    ).toEqual(push({ kind: 'connection', state: { status: 'not-paired' } }));
    expect(
      parsePortPush(push({ kind: 'binding', state: { kind: 'tab-left', origin: 'http://a' } })),
    ).toEqual(push({ kind: 'binding', state: { kind: 'tab-left', origin: 'http://a' } }));
    expect(parsePortPush(push({ kind: 'reload', state: { kind: 'reloading' } }))).toEqual(
      push({ kind: 'reload', state: { kind: 'reloading' } }),
    );
  });

  it('refuses a malformed state, an extra frame key and an unknown push kind', () => {
    expect(parsePortPush(push({ kind: 'connection', state: { status: 'up' } }))).toBeUndefined();
    expect(parsePortPush(push({ kind: 'binding', state: { kind: 'bound' } }))).toBeUndefined();
    expect(
      parsePortPush(push({ kind: 'reload', state: { kind: 'offered', reason: 'because' } })),
    ).toBeUndefined();
    expect(
      parsePortPush(push({ kind: 'reload', state: { kind: 'reloading' }, extra: true })),
    ).toBeUndefined();
    expect(parsePortPush(push({ kind: 'toast', state: {} }))).toBeUndefined();
  });
});

describe('the picker push — the worker says the page’s picker is on or off', () => {
  it('is a known push kind', () => {
    expect(PORT_PUSH_KINDS).toContain('picker');
  });

  it('admits exactly a boolean `active` and answers a rebuilt frame', () => {
    for (const active of [false, true]) {
      const frame = push({ kind: 'picker', state: { active } });
      const parsed = parsePortPush(frame);
      expect(parsed).toEqual(frame);
      expect(parsed).not.toBe(frame);
      expect(isPortPush(frame)).toBe(true);
      expect(classifyPanelPortFrame(frame)).toEqual({ kind: 'push', push: frame });
    }
  });

  it('refuses a state that is not exactly one boolean, and an extra frame key', () => {
    for (const state of [
      {},
      { active: 'false' },
      { active: 0 },
      { active: null },
      { active: false, target: null },
      null,
      [],
      false,
    ]) {
      const frame = push({ kind: 'picker', state });
      expect(parsePortPush(frame)).toBeUndefined();
      expect(classifyPanelPortFrame(frame)).toEqual({ kind: 'malformed-push', pushKind: 'picker' });
    }
    expect(
      parsePortPush(push({ kind: 'picker', state: { active: false }, extra: true })),
    ).toBeUndefined();
    expect(parsePortPush(push({ kind: 'picker' }))).toBeUndefined();
  });
});

describe('target.request — arming a page pick, or cancelling it', () => {
  const requestId = newPortRequestId();

  /** A bridge → page `target.request` frame, as the bridge posts it on the channel node. */
  function pageRequest(
    payload: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    return {
      source: BRIDGE_SOURCE_TAG,
      version: PAGE_CHANNEL_VERSION,
      type: 'target.request',
      payload,
    };
  }

  /** A worker → bridge `target.request` frame, as the worker posts it on the bridge port. */
  function downstreamRequest(
    payload: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    return { ...FRAMING, direction: 'downstream', type: 'target.request', payload };
  }

  it('admits an arming request and a cancelling one on the page channel', () => {
    expect(isBridgeChannelMessage(pageRequest({ requestId }))).toBe(true);
    expect(isBridgeChannelMessage(pageRequest({}))).toBe(true);
    expect(isBridgeChannelMessage(pageRequest({ requestId, cancel: true }))).toBe(true);
    expect(isBridgeChannelMessage(pageRequest({ cancel: true }))).toBe(true);
  });

  it('refuses a page-channel cancel flag that is not exactly true', () => {
    for (const cancel of [false, 'true', 1, null, {}]) {
      expect(isBridgeChannelMessage(pageRequest({ requestId, cancel }))).toBe(false);
    }
    expect(isBridgeChannelMessage(pageRequest({ requestId: '', cancel: true }))).toBe(false);
  });

  it('admits an arming request and a cancelling one on the bridge port, each with its id', () => {
    expect(isBridgeDownstreamMessage(downstreamRequest({ requestId }))).toBe(true);
    expect(isBridgeDownstreamMessage(downstreamRequest({ requestId, cancel: true }))).toBe(true);
  });

  it('refuses a bridge-port request without an id, or with a cancel flag that is not exactly true', () => {
    expect(isBridgeDownstreamMessage(downstreamRequest({ cancel: true }))).toBe(false);
    expect(isBridgeDownstreamMessage(downstreamRequest({}))).toBe(false);
    for (const cancel of [false, 'true', 1, null, {}]) {
      expect(isBridgeDownstreamMessage(downstreamRequest({ requestId, cancel }))).toBe(false);
    }
  });
});

describe('classifyPanelPortFrame — the panel’s single admission point', () => {
  it('answers the parsed response or push', () => {
    const response = success('target.pick', { active: true });
    expect(classifyPanelPortFrame(response)).toEqual({ kind: 'response', response });
    const state = { kind: 'reload', state: { kind: 'offered', reason: 'hook-after-react' } };
    expect(classifyPanelPortFrame(push(state))).toEqual({ kind: 'push', push: push(state) });
  });

  it('classifies a malformed but correlatable response with its correlation', () => {
    const frame = success('pair.complete', {}, 'req-42');
    expect(classifyPanelPortFrame(frame)).toEqual({
      kind: 'malformed-response',
      correlation: { requestId: 'req-42', kind: 'pair.complete' },
    });
    expect(readPortResponseCorrelation(frame)).toEqual({
      requestId: 'req-42',
      kind: 'pair.complete',
    });
    const unknownKind = {
      ...FRAMING,
      direction: 'response',
      requestId: 'r',
      kind: 'nope',
      ok: true,
    };
    expect(classifyPanelPortFrame(unknownKind)).toEqual({
      kind: 'malformed-response',
      correlation: undefined,
    });
  });

  it('classifies a malformed push with its kind only when the kind is known', () => {
    expect(classifyPanelPortFrame(push({ kind: 'binding', state: {} }))).toEqual({
      kind: 'malformed-push',
      pushKind: 'binding',
    });
    expect(classifyPanelPortFrame(push({ kind: 'script', state: {} }))).toEqual({
      kind: 'malformed-push',
      pushKind: undefined,
    });
  });

  it('leaves frames not addressed to the panel unrecognised', () => {
    for (const value of [
      null,
      'text',
      [],
      { ...FRAMING, direction: 'request', requestId: 'r', kind: 'capture.start', payload: {} },
      { channel: 'other', version: PORT_PROTOCOL_VERSION, direction: 'push', kind: 'binding' },
    ]) {
      expect(classifyPanelPortFrame(value)).toEqual({ kind: 'unrecognised' });
    }
  });
});

describe('portErr — the one whitelisted failure detail', () => {
  it('forwards the schema-valid owning session of a capture.start conflict, and nothing else', () => {
    const error = new DebuggenError(
      CAPTURE_CONFLICT_ERROR_CODE,
      'Another session holds the capture.',
      {
        details: { owningSessionId: OTHER_SESSION, projectRoot: '/home/dev/app', status: 409 },
        hint: 'Stop the other capture first.',
      },
    );
    const frame = portErr(captureStartRequest(), error);
    expect(frame.error).toEqual({
      code: CAPTURE_CONFLICT_ERROR_CODE,
      message: 'Another session holds the capture.',
      owningSessionId: OTHER_SESSION,
    });
    const parsed = parsePortResponse(frame);
    expect(parsed).toEqual(frame);
    if (parsed?.ok !== false) {
      throw new Error('expected a failure');
    }
    expect(portErrorOwningSessionId(parsed.error)).toBe(OTHER_SESSION);
  });

  it('forwards no owning session for another kind, another code, or an invalid id', () => {
    const conflict = (owningSessionId: unknown): DebuggenError =>
      new DebuggenError(CAPTURE_CONFLICT_ERROR_CODE, 'Held.', { details: { owningSessionId } });
    expect(portErr(captureStopRequest(), conflict(OTHER_SESSION)).error).toEqual({
      code: CAPTURE_CONFLICT_ERROR_CODE,
      message: 'Held.',
    });
    expect(
      portErr(
        captureStartRequest(),
        new DebuggenError('SESSION_INVALID_STATE', 'Busy.', {
          details: { owningSessionId: OTHER_SESSION },
        }),
      ).error,
    ).toEqual({ code: 'SESSION_INVALID_STATE', message: 'Busy.' });
    for (const invalid of ['', 'x'.repeat(4096), 42, undefined]) {
      expect(portErr(captureStartRequest(), conflict(invalid)).error).toEqual({
        code: CAPTURE_CONFLICT_ERROR_CODE,
        message: 'Held.',
      });
    }
  });

  it('substitutes the code for an empty message so the panel can still parse the answer', () => {
    const frame = portErr(captureStopRequest(), new DebuggenError('INTERNAL', ''));
    expect(frame.error).toEqual({ code: 'INTERNAL', message: 'INTERNAL' });
    expect(parsePortResponse(frame)).toEqual(frame);
  });
});

describe('the reload offer vocabulary', () => {
  it('is closed, with a frozen not-needed state and a stable action label', () => {
    expect(PANEL_RELOAD_REASONS).toEqual(['agent-missing', 'hook-after-react']);
    expect(PANEL_RELOAD_NOT_NEEDED).toEqual({ kind: 'not-needed' });
    expect(Object.isFrozen(PANEL_RELOAD_NOT_NEEDED)).toBe(true);
    expect(PAGE_RELOAD_ACTION_LABEL).toBe('Reload page');
  });

  it('accepts exactly the three states', () => {
    expect(isPanelReloadState({ kind: 'not-needed' })).toBe(true);
    expect(isPanelReloadState({ kind: 'reloading' })).toBe(true);
    for (const reason of PANEL_RELOAD_REASONS) {
      expect(isPanelReloadState({ kind: 'offered', reason })).toBe(true);
    }
    for (const value of [
      null,
      {},
      { kind: 'offered' },
      { kind: 'offered', reason: 'agent-missing', tabId: 1 },
      { kind: 'reloading', since: 1 },
      { kind: 'done' },
    ]) {
      expect(isPanelReloadState(value)).toBe(false);
    }
  });
});

describe('the page.reload request — a consent names the tab it was given for', () => {
  const sessionId = newSessionId();
  const frame = (payload: unknown): Readonly<Record<string, unknown>> => ({
    channel: EXTENSION_CHANNEL,
    version: PORT_PROTOCOL_VERSION,
    direction: 'request',
    requestId: newPortRequestId(),
    kind: 'page.reload',
    payload,
  });

  it('admits exactly a session and the inspected tab', () => {
    expect(isPortRequest(frame({ sessionId, tabId: 7 }))).toBe(true);
    expect(isPortRequest(frame({ sessionId, tabId: 0 }))).toBe(true);
  });

  it('refuses a consent that names no tab, a malformed tab, or anything more', () => {
    for (const payload of [
      { sessionId },
      { sessionId, tabId: -1 },
      { sessionId, tabId: 1.5 },
      { sessionId, tabId: '7' },
      { sessionId: '', tabId: 7 },
      { tabId: 7 },
      { sessionId, tabId: 7, url: 'http://127.0.0.1:3000/' },
    ]) {
      expect(isPortRequest(frame(payload)), JSON.stringify(payload)).toBe(false);
    }
  });
});
