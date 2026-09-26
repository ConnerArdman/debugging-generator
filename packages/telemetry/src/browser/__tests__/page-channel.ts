/**
 * A fake isolated-world bridge for the page channel, version 3 — test support
 * for the telemetry browser suites, and nothing else.
 *
 * **Test-only.** This file sits under `__tests__/` so that every repository
 * convention treats it as test code: `eslint.config.js` applies its test rules
 * (`**\/__tests__/**\/*.ts`), `vitest.config.ts` keeps it out of the coverage
 * report (`**\/__tests__/**`) without collecting it as a suite (the telemetry
 * project runs only `*.test.{ts,tsx}`), and `scripts/check-no-hardcoding.mjs`
 * skips the directory. It is still inside `src/`, so `tsc -b` type-checks it
 * with the rest of the program. No production module imports it, and the
 * agent bundle cannot reach it: `esbuild.agent.mjs` starts from `agent.ts`.
 *
 * **What it does** is exactly what `apps/chrome-extension/src/content/bridge.ts`
 * does on its side of the channel, as `../transport.ts` specifies it:
 *
 * 1. Register a {@link HANDSHAKE_OFFER_EVENT} listener on `window`, dispatch
 *    one {@link HANDSHAKE_REQUEST_EVENT} there, and take the node from the
 *    answer's `relatedTarget`.
 * 2. Listen on that node for {@link AGENT_FRAME_EVENT}, record every frame the
 *    agent dispatches, and acknowledge (`preventDefault()`) the ones its
 *    {@link FakeBridge.claim} policy says to take.
 * 3. Dispatch {@link BRIDGE_FRAME_EVENT} frames on the node — well-formed ones
 *    through {@link FakeBridge.send}, arbitrary `detail` values through
 *    {@link FakeBridge.sendDetail} — and report whether the agent acknowledged
 *    them.
 *
 * Everything it records is read back from the dispatched events themselves,
 * so a suite asserting on it asserts on the wire rather than on the module's
 * internals.
 *
 * @module packages/telemetry/src/browser/__tests__/page-channel
 */

import {
  AGENT_FRAME_EVENT,
  BRIDGE_FRAME_EVENT,
  BRIDGE_SOURCE_TAG,
  CHANNEL_VERSION,
  HANDSHAKE_OFFER_EVENT,
  HANDSHAKE_REQUEST_EVENT,
} from '../transport.js';
import type { BridgeInboundMessage } from '../transport.js';

/*
 * The event constructors as they were when this module was evaluated. A case
 * that stubs `CustomEvent` to make the *agent's* dispatch fail must not make
 * the fake bridge's own dispatches fail with it.
 */
const PageCustomEvent = CustomEvent;

/** The part of a transport module the harness needs: its `subscribe`. */
export interface ChannelTransport {
  /** The transport's own `subscribe`, from whichever module instance is under test. */
  readonly subscribe: (handler: (message: BridgeInboundMessage) => void) => () => void;
}

/** One agent → bridge frame, as the fake bridge received it. */
export interface RecordedAgentFrame {
  /** The event's `detail`, exactly as dispatched. */
  readonly detail: string;
  /** The frame's `source` field. */
  readonly source: unknown;
  /** The frame's `version` field. */
  readonly version: unknown;
  /** The frame's `type` field. */
  readonly type: string;
  /** The frame's `payload` field, as a record (`{}` when it was not one). */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Whether the fake bridge acknowledged it. */
  readonly claimed: boolean;
  /** Whether the event was dispatched as cancelable, as the wire requires. */
  readonly cancelable: boolean;
  /** Whether the event was dispatched as bubbling, which the wire forbids. */
  readonly bubbles: boolean;
}

/**
 * Whether the fake bridge takes a frame: always, never, or per frame.
 *
 * A function receives the frame before it is acknowledged and may itself
 * dispatch frames back — which is how the re-entrancy cases hand the agent a
 * `bridge.gone` or a `bridge.ready` from inside its own dispatch.
 */
export type ClaimPolicy = boolean | ((frame: Omit<RecordedAgentFrame, 'claimed'>) => boolean);

/** The fake bridge, connected to one transport instance. */
export interface FakeBridge {
  /** The channel node the handshake answer carried. */
  readonly node: EventTarget;
  /** Every frame received since the last {@link FakeBridge.clear}, in order. */
  readonly frames: readonly RecordedAgentFrame[];
  /** The claim policy; `true` until a case changes it. */
  claim: ClaimPolicy;
  /** The frames of one type, in order. */
  framesOfType: (type: string) => RecordedAgentFrame[];
  /** The claimed frames of one type, in order. */
  claimedOfType: (type: string) => RecordedAgentFrame[];
  /**
   * Dispatch a well-formed bridge frame on the node.
   *
   * @returns Whether the agent acknowledged it.
   */
  send: (type: string, payload?: unknown) => boolean;
  /**
   * Dispatch a bridge frame with an arbitrary `detail`.
   *
   * @returns Whether the agent acknowledged it.
   */
  sendDetail: (detail: unknown) => boolean;
  /** Forget the frames received so far and restore the default claim policy. */
  clear: () => void;
  /** Stop listening on the node: every later agent frame goes unclaimed. */
  disconnect: () => void;
}

/** What {@link requestChannelNode} saw when it asked. */
export interface HandshakeResult {
  /** Every `relatedTarget` an answer carried, in dispatch order. */
  readonly offers: readonly EventTarget[];
  /** The node, when exactly one answer arrived. */
  readonly node: EventTarget | undefined;
}

/**
 * The well-formed `detail` of one bridge frame.
 *
 * @param type The frame type.
 * @param payload The frame body.
 * @returns The JSON string the bridge would dispatch.
 */
export function bridgeFrameDetail(type: string, payload: unknown = {}): string {
  return JSON.stringify({ source: BRIDGE_SOURCE_TAG, version: CHANNEL_VERSION, type, payload });
}

/**
 * Dispatch one handshake request on `window`, as the bridge — or a page
 * script — would, and collect what answers it.
 *
 * Nothing is subscribed here: the caller decides whether a transport is
 * listening, which is what lets a case ask "does a second request get an
 * answer?" without opening a listener of its own.
 *
 * @returns Every node offered in answer.
 */
export function requestChannelNode(): HandshakeResult {
  const offers: EventTarget[] = [];
  const onOffer = (event: Event): void => {
    const related = (event as MouseEvent).relatedTarget;
    if (related !== null) {
      offers.push(related);
    }
  };

  window.addEventListener(HANDSHAKE_OFFER_EVENT, onOffer);
  try {
    window.dispatchEvent(new PageCustomEvent(HANDSHAKE_REQUEST_EVENT));
  } finally {
    window.removeEventListener(HANDSHAKE_OFFER_EVENT, onOffer);
  }

  return { offers, node: offers.length === 1 ? offers[0] : undefined };
}

/**
 * Read one agent frame's `detail` into a record.
 *
 * @param detail The dispatched `detail`.
 * @returns The parsed frame's fields.
 */
function parseAgentFrame(
  detail: string,
): Pick<RecordedAgentFrame, 'source' | 'version' | 'type' | 'payload'> {
  const parsed: unknown = JSON.parse(detail);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the agent dispatched a frame whose detail is not a JSON object');
  }
  const frame = parsed as Record<string, unknown>;
  const type = frame['type'];
  if (typeof type !== 'string') {
    throw new Error('the agent dispatched a frame with no string type');
  }
  const payload = frame['payload'];
  return {
    source: frame['source'],
    version: frame['version'],
    type,
    payload:
      typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {},
  };
}

/**
 * Perform the bridge's handshake against one transport instance and return
 * the connected fake bridge.
 *
 * The transport is subscribed for the duration of the handshake, because a
 * transport opens its channel — creates the node and listens for the request —
 * on its first subscription; the temporary subscription is released before
 * this returns, and the node, being document-scoped, stays.
 *
 * @param transport The module instance under test.
 * @returns The fake bridge.
 * @throws When no answer, or more than one, arrived: a transport that has
 * already answered its one request, or two live instances in one document.
 */
export function connectFakeBridge(transport: ChannelTransport): FakeBridge {
  const hold = transport.subscribe(() => undefined);
  let result: HandshakeResult;
  try {
    result = requestChannelNode();
  } finally {
    hold();
  }

  const node = result.node;
  if (node === undefined) {
    throw new Error(
      `the handshake request was answered ${String(result.offers.length)} times; exactly one answer carrying the node was expected`,
    );
  }

  const frames: RecordedAgentFrame[] = [];
  const bridge: FakeBridge = {
    node,
    frames,
    claim: true,
    framesOfType: (type) => frames.filter((frame) => frame.type === type),
    claimedOfType: (type) => frames.filter((frame) => frame.type === type && frame.claimed),
    send: (type, payload) => bridge.sendDetail(bridgeFrameDetail(type, payload)),
    sendDetail: (detail) =>
      !node.dispatchEvent(
        new PageCustomEvent<unknown>(BRIDGE_FRAME_EVENT, {
          detail,
          bubbles: false,
          cancelable: true,
        }),
      ),
    clear: () => {
      frames.length = 0;
      bridge.claim = true;
    },
    disconnect: () => {
      node.removeEventListener(AGENT_FRAME_EVENT, onAgentFrame);
    },
  };

  function onAgentFrame(event: Event): void {
    const detail: unknown = (event as CustomEvent<unknown>).detail;
    if (typeof detail !== 'string') {
      throw new Error('the agent dispatched a frame whose detail is not a string');
    }
    const received = {
      detail,
      ...parseAgentFrame(detail),
      cancelable: event.cancelable,
      bubbles: event.bubbles,
    };
    // Recorded before the policy runs, so a frame the policy provokes from
    // inside this dispatch is recorded after the one that provoked it.
    const record: { -readonly [K in keyof RecordedAgentFrame]: RecordedAgentFrame[K] } = {
      ...received,
      claimed: false,
    };
    frames.push(record);
    const policy = bridge.claim;
    const claimed = typeof policy === 'function' ? policy(received) : policy;
    record.claimed = claimed;
    if (claimed) {
      event.preventDefault();
    }
  }

  node.addEventListener(AGENT_FRAME_EVENT, onAgentFrame);
  return bridge;
}
