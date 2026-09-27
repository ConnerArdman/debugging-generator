/**
 * `debuggen.stopCapture` — closes the active session's capture window.
 *
 * ## Contract
 *
 * One HTTP operation, `capture.stop` (`POST /sessions/:id/capture/stop`, body
 * `{}`), answered with `{ summary: CaptureSummary }` (AAP §0.4.2). The service
 * then broadcasts `capture.stopped { sessionId, captureId, summary }` to every
 * client of the session, and `src/extension.ts` routes that frame into
 * `ExtensionState.applyCaptureStopped`. That broadcast is how the summary
 * reaches the store and the view's `CaptureControls` counter (AAP §0.7.3):
 * this command never calls an `apply*` mutator and keeps no copy of server
 * state.
 *
 * ## Reading the reply
 *
 * The summary is read for one decision only: did the capture yield telemetry?
 * The authoritative field is `CaptureSummary.eventCount`, the number of events
 * the summary was computed from. The protocol validates the summary shallowly,
 * so every count is re-checked as a non-negative safe integer before use:
 *
 * - **Zero events** — the "Capture yielded nothing" row of AAP §0.5.5. The
 *   service skips analysis and returns the session to `ready`. This command
 *   shows the mandated sentence verbatim with a "Capture again" action, which
 *   runs `debuggen.startCapture` to re-arm the same plan.
 * - **Events recorded** — one informational notice with the counts the summary
 *   itself carries (events, traces and the per-tier tallies). No number is
 *   estimated or derived beyond those fields.
 * - **No readable count** — no claim is made. The broadcast still updates the
 *   view.
 *
 * The service's other emptiness rule (events arrived but none was a browser
 * interaction, for a question that needs one) depends on the session's
 * validated understanding and the armed hooks. The service applies it and
 * reports it through its own progress row, so this command does not
 * re-derive it.
 *
 * When the socket is not `open`, the broadcast cannot reach this window. The
 * notice then says that live updates are unavailable until the connection is
 * restored, so a disconnected socket is visible rather than silent.
 *
 * ## Preconditions and refusals
 *
 * - **Active session** — the shared guard renders "No active session." itself.
 * - **Ended session** — a session the store has acknowledged as ended
 *   (`./capture-availability`) gets one informational notice saying its capture
 *   is already closed and how to start another session, and no request is
 *   sent. `ended` is terminal in the store (`ExtensionState.hasAcknowledgedEnd`)
 *   and in the service's state machine, so this is the one cached fact that
 *   may stop the request; nothing else the host caches (`captureState`, any
 *   other status) short-circuits it, so a stale projection never blocks a
 *   legitimate stop.
 * - **State refusal** — `409 SESSION_INVALID_STATE`: no capture is running on
 *   the service (it already stopped, or never started). The service scrubs the
 *   message to a code-level summary, so one warning is worded from the session
 *   status the store reads once the refusal arrived (`captureRefusalNotice`),
 *   with the next step — never the raw `status 409` failure text.
 *
 * The title-bar action is greyed by the command's `enablement` clause
 * (`debuggen.captureCanStop`, kept by `bindCaptureContextKeys`) whenever no
 * capture is running; the webview dispatches the command directly, which
 * `enablement` does not block.
 *
 * ## Invariants
 *
 * - Preconditions, then exactly one request: no retry, no second call.
 * - A state refusal is rendered once through `CommandUi.notify` as a warning;
 *   every other failure is a typed `Err` rendered once through
 *   `CommandUi.notifyFailure`, which carries the service's `hint`. A failure is
 *   never presented as a completed capture, and nothing here throws for an
 *   expected condition.
 * - Privacy (AAP §0.5.2): the log carries only the command id. Summary contents
 *   such as URLs, SQL text, component names and attribute values never reach a
 *   log line or a notice.
 * - No hardcoded behaviour (AAP §0.5.4): no application identifier, route path
 *   or question text appears here.
 *
 * @module
 */

import type { CaptureSummary, TelemetryTier } from '@debuggen/protocol';
import { DebuggenError, assertNever, isErr } from '@debuggen/shared';

import {
  captureAvailabilityOf,
  captureRefusalNotice,
  endedSessionNotice,
  isCaptureStateRefusal,
} from './capture-availability';
import type { CommandContext, CommandId, CommandNotice } from './index';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** This command's id, checked against the contributed-command vocabulary. */
const STOP_CAPTURE_COMMAND = 'debuggen.stopCapture' satisfies CommandId;

/**
 * The command the "Capture again" action runs. The service has returned the
 * session to `ready` with its plan intact, so starting a capture re-arms that
 * same plan (AAP §0.5.5).
 */
const START_CAPTURE_COMMAND = 'debuggen.startCapture' satisfies CommandId;

/**
 * The developer-facing copy of AAP §0.5.5's "Capture yielded nothing" row,
 * character for character. The service's progress row, the DevTools panel and
 * `docs/` use the same sentence, so it must not be reworded here.
 */
const EMPTY_CAPTURE_MESSAGE =
  'No telemetry was captured. Interact with the page while capture is running, then Capture again.';

/** The recovery action offered with {@link EMPTY_CAPTURE_MESSAGE}. */
const CAPTURE_AGAIN_ACTION = 'Capture again';

/** Appended to any notice raised while the service socket is not `open`. */
const LIVE_UPDATES_UNAVAILABLE_DETAIL =
  'Live updates are unavailable until the connection to the local service is restored.';

/** The headline when the capture closed but its summary carried no readable count. */
const CAPTURE_STOPPED_MESSAGE = 'Capture stopped.';

/**
 * The `prefix` of the one failure notice a failed `capture.stop` produces,
 * unless it is a state refusal ({@link captureRefusalNotice}).
 */
const STOP_FAILURE_PREFIX = 'Could not stop capture';

/** The `prefix` used when the "Capture again" action cannot be dispatched. */
const CAPTURE_AGAIN_FAILURE_PREFIX = 'Could not start the capture again';

/**
 * Display labels for the tiers, in the order the notice lists them. Typed
 * against the protocol's `TelemetryTier` union, so adding or renaming a tier
 * fails to compile here instead of dropping out of the notice.
 */
const TIER_LABELS = Object.freeze({
  browser: 'browser',
  server: 'server',
  db: 'database',
}) satisfies Readonly<Record<TelemetryTier, string>>;

/** The tiers in {@link TIER_LABELS} order. */
const TIER_ORDER = Object.freeze(Object.keys(TIER_LABELS) as TelemetryTier[]);

/** Formats counts for display, for example `1,234`. */
const COUNT_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

// ---------------------------------------------------------------------------
// Summary classification
// ---------------------------------------------------------------------------

/** One tier's non-zero event tally, as the summary reported it. */
interface TierTally {
  readonly tier: TelemetryTier;
  readonly count: number;
}

/** The counts a capture that recorded events reports. */
interface CaptureEvidence {
  readonly kind: 'evidence';
  /** `CaptureSummary.eventCount`; always at least one. */
  readonly eventCount: number;
  /** `CaptureSummary.traceCount`, or `undefined` when it is not a readable count. */
  readonly traceCount: number | undefined;
  /** The non-zero `CaptureSummary.tierCounts`, in {@link TIER_ORDER}. */
  readonly tiers: readonly TierTally[];
}

/** What the reply says about the capture's yield. */
type CaptureYield = { readonly kind: 'empty' } | CaptureEvidence | { readonly kind: 'unreadable' };

/** The capture recorded no events. */
const EMPTY_YIELD: CaptureYield = Object.freeze({ kind: 'empty' });

/** The summary carried no readable event count. */
const UNREADABLE_YIELD: CaptureYield = Object.freeze({ kind: 'unreadable' });

/** `value` as a count (a non-negative safe integer), or `undefined`. */
function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Whether `value` is a non-null object that can be indexed by key. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The non-zero tier tallies of `tierCounts`, in {@link TIER_ORDER}. A tier
 * without a readable count is left out, never shown as zero.
 */
function tierTalliesOf(tierCounts: unknown): readonly TierTally[] {
  if (!isRecord(tierCounts)) {
    return [];
  }
  const tallies: TierTally[] = [];
  for (const tier of TIER_ORDER) {
    const count = countOf(tierCounts[tier]);
    if (count !== undefined && count > 0) {
      tallies.push({ tier, count });
    }
  }
  return tallies;
}

/**
 * Decides whether a stopped capture yielded telemetry, using the summary's own
 * `eventCount`.
 *
 * @param summary The `capture.stop` reply's summary. The protocol checks it
 *   only for being a plain object, so each field is validated here.
 */
function classifyCaptureYield(summary: CaptureSummary): CaptureYield {
  const eventCount = countOf(summary.eventCount);
  if (eventCount === undefined) {
    return UNREADABLE_YIELD;
  }
  if (eventCount === 0) {
    return EMPTY_YIELD;
  }
  return {
    kind: 'evidence',
    eventCount,
    traceCount: countOf(summary.traceCount),
    tiers: tierTalliesOf(summary.tierCounts),
  };
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

/** `1 event`, `2 events`, `1,234 events`. */
function quantity(count: number, singular: string, plural: string): string {
  return `${COUNT_FORMAT.format(count)} ${count === 1 ? singular : plural}`;
}

/**
 * The headline for a capture that recorded events. Every number comes from the
 * summary, for example
 * `Capture stopped: 142 events across 3 traces (browser 98 · server 30 · database 14).`
 */
function describeEvidence(evidence: CaptureEvidence): string {
  let text = `Capture stopped: ${quantity(evidence.eventCount, 'event', 'events')}`;
  if (evidence.traceCount !== undefined && evidence.traceCount > 0) {
    text += ` across ${quantity(evidence.traceCount, 'trace', 'traces')}`;
  }
  if (evidence.tiers.length > 0) {
    const tiers = evidence.tiers
      .map(({ tier, count }) => `${TIER_LABELS[tier]} ${COUNT_FORMAT.format(count)}`)
      .join(' · ');
    text += ` (${tiers})`;
  }
  return `${text}.`;
}

/**
 * The single notice for a successful `capture.stop`, or `undefined` when
 * nothing needs saying.
 *
 * @param outcome What the summary says about the capture's yield.
 * @param live Whether the service socket is `open`, so `capture.stopped` will
 *   reach the view.
 */
function noticeFor(outcome: CaptureYield, live: boolean): CommandNotice | undefined {
  const detail = live ? undefined : LIVE_UPDATES_UNAVAILABLE_DETAIL;
  switch (outcome.kind) {
    case 'empty':
      return {
        level: 'warning',
        message: EMPTY_CAPTURE_MESSAGE,
        detail,
        actions: [CAPTURE_AGAIN_ACTION],
      };
    case 'evidence':
      return { level: live ? 'info' : 'warning', message: describeEvidence(outcome), detail };
    case 'unreadable':
      return live ? undefined : { level: 'warning', message: CAPTURE_STOPPED_MESSAGE, detail };
    default:
      return assertNever(outcome, 'Unhandled capture yield');
  }
}

/**
 * Runs the "Capture again" action. `debuggen.startCapture` reports its own
 * failures, so only a failure to dispatch the command is reported here, once.
 */
async function captureAgain(ctx: CommandContext): Promise<void> {
  try {
    await ctx.ui.executeCommand(START_CAPTURE_COMMAND);
  } catch (error) {
    await ctx.ui.notifyFailure(DebuggenError.from(error), {
      prefix: CAPTURE_AGAIN_FAILURE_PREFIX,
    });
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * `debuggen.stopCapture`: stops the active session's capture and reports what
 * it yielded.
 *
 * Resolves after the developer has answered or dismissed any notice that
 * offers an action. It never rejects for an expected condition. For a session
 * the store knows has ended it sends nothing and renders the one ended-session
 * notice.
 *
 * @param ctx The command context built by `registerCommands`.
 * @param args Whatever VS Code invoked the command with, such as a view or
 *   menu context. The command takes no arguments and ignores them. The
 *   capture to stop is always the active session's open capture.
 */
export async function stopCapture(ctx: CommandContext, ...args: readonly unknown[]): Promise<void> {
  void args;

  const active = ctx.guards.requireActiveSession();
  if (!active) {
    return;
  }

  // `ended` is terminal in the store and on the service, so this is the one
  // cached fact that may stop the request (see the module overview).
  if (captureAvailabilityOf(ctx.state, active.sessionId).ended) {
    ctx.logger.info('Capture stop skipped: the session has ended', {
      command: STOP_CAPTURE_COMMAND,
    });
    await ctx.ui.notify(endedSessionNotice('stop'));
    return;
  }

  ctx.logger.info('Capture stop requested', { command: STOP_CAPTURE_COMMAND });
  const stopped = await ctx.client.stopCapture(active.sessionId);
  if (isErr(stopped)) {
    if (isCaptureStateRefusal(stopped.error)) {
      // Worded from the store as it reads now: the capture may have been
      // stopped elsewhere, and its frames may have arrived meanwhile.
      await ctx.ui.notify(
        captureRefusalNotice('stop', captureAvailabilityOf(ctx.state, active.sessionId)),
      );
      return;
    }
    await ctx.ui.notifyFailure(stopped.error, { prefix: STOP_FAILURE_PREFIX });
    return;
  }

  const outcome = classifyCaptureYield(stopped.value.summary);
  const notice = noticeFor(outcome, ctx.client.state === 'open');
  if (notice === undefined) {
    return;
  }
  const choice = await ctx.ui.notify(notice);
  if (outcome.kind === 'empty' && choice === CAPTURE_AGAIN_ACTION) {
    await captureAgain(ctx);
  }
}
