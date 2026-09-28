/**
 * The signal report a DevTools panel is shown — which capture signals the
 * session's instrumentation enabled — kept true to the bound tab's page,
 * proven through the real routes, pushes, installer, adapters and readiness
 * gate of a harness-booted service (AAP §0.4.2, §0.5.5, §0.7.1).
 *
 * ## What this suite proves
 *
 * The runtime browser adapters judge a page by the page-agent report on file
 * when the install builds its context. A panel commonly binds, and its page
 * agent reports, while the pipeline is already running, so that report is
 * routinely missing when the adapters are asked; the readiness gate then waits
 * for it and settles on it. Two routes make the report the user sees follow:
 *
 * - **A page agent that reports while the install's readiness settles.** The
 *   install's `instrumentation.ready` names the browser signals as not enabled
 *   ("no page agent has reported"); once the gate settles on the report that
 *   arrived, the runtime adapters are asked again and exactly one corrected
 *   `instrumentation.ready` follows, every browser signal is checked ✓, and no
 *   row presents a browser signal as one that could not be enabled.
 * - **A panel that binds after the install.** The bind replays the session's
 *   latest `instrumentation.ready` to the panel — the stored-state replay
 *   carries the record, the rows, the analysis and the panel, never the signal
 *   report — and, once the bound tab's page agent reports, a corrected
 *   `instrumentation.ready` reaches both user interfaces with ✓ rows for the
 *   signals it now confirms. A re-bind of the same tab replays the corrected
 *   report, never the stale one.
 *
 * And one boundary the report must keep (AAP §0.5.6, §0.7.1 Group 2):
 *
 * - **Two paired browsers whose bound tabs share an id.** Chrome numbers tabs
 *   per browser, so two DevTools credentials each bind *their own* tab of one
 *   id to two sessions served from one dev-server origin. Readiness rests on
 *   the bound tab's own page agent: one browser's `agent.ready` makes its own
 *   session ready and leaves the other session `instrumenting`, with no
 *   "Ready to capture" and no corrected report, until the other browser's
 *   page agent reports for itself.
 *
 * Every route ends with every modification removed by the real cleanup and
 * the copied corpus byte-identical to its snapshot.
 *
 * ## Rules ruling
 *
 * - **User rules (AAP §0.10).** `review_rules` answers "No user rules
 *   provided."; no user rule governs this file, so the §0.10 baseline does.
 * - **Gate membership.** Collected by `pnpm test:integration`
 *   (`vitest run --project local-service-integration`) inside `pnpm verify`,
 *   compiled by `tsc -b`, linted with `--max-warnings 0` and formatted by
 *   `prettier --check .`.
 * - **Generic questions (AAP §0.5.4).** The question names nothing in the
 *   corpus, and no adapter id, signal-to-adapter table or demo name appears:
 *   which signals are browser signals is read from the reports themselves.
 * - **Reversible, recorded file changes.** Every patch comes from the real
 *   installer and goes back through the real cleanup; the committed corpus is
 *   only ever copied (`harness.copyFixtureProject`) and each copy is compared
 *   against its snapshot with `assertTreeUnchanged`.
 * - **No committed secrets.** Every credential is minted by the harness through
 *   the service's own auth service; no secret-shaped literal appears here.
 * - **Closed dependency set.** `@debuggen/*` (never `panel-renderer`),
 *   `node:*`, `vitest` and the harness. No `zod`, no DOM types.
 *
 * @module
 */

import { createServer } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isCaptureSignal } from '@debuggen/instrumentation';
import {
  CLEANUP_STATUSES,
  PROGRESS_STAGES,
  PROGRESS_STATUSES,
  SESSION_STATUSES,
  isMessageOfType,
} from '@debuggen/protocol';
import type { ProtocolMessage, SessionRecord } from '@debuggen/protocol';
import { isErr } from '@debuggen/shared';

import { CAPTURE_SIGNAL_LABELS, READY_TO_CAPTURE_MESSAGE } from '../../src/sessions/progress.js';
import { HARNESS_TIMEOUTS, assertTreeUnchanged, startHarness, waitUntil } from './harness.js';
import type { FixtureProjectCopy, Harness, HarnessMessage, HarnessWsClient } from './harness.js';

/* -------------------------------------------------------------------------------------------------
 * Vocabularies — every status and stage is taken from its owning package
 * ---------------------------------------------------------------------------------------------- */

/**
 * One member of a published vocabulary, checked by the compiler (a rename
 * upstream fails `tsc -b` here) and at run time (a value removed from a frozen
 * tuple fails with the vocabulary named).
 */
function memberOf<const T extends string>(vocabulary: readonly T[], value: NoInfer<T>): T {
  if (!vocabulary.includes(value)) {
    throw new Error(`"${value}" is not a member of [${vocabulary.join(', ')}].`);
  }
  return value;
}

const STATUS_READY = memberOf(SESSION_STATUSES, 'ready');
const STATUS_INSTRUMENTING = memberOf(SESSION_STATUSES, 'instrumenting');
const INSTRUMENT_STAGE = memberOf(PROGRESS_STAGES, 'instrument');
const ROW_DONE = memberOf(PROGRESS_STATUSES, 'done');
const ROW_FAILED = memberOf(PROGRESS_STATUSES, 'failed');
const CLEANUP_CLEAN = memberOf(CLEANUP_STATUSES, 'clean');

/** A generic question: it names nothing in the corpus (AAP §0.5.4). */
const QUESTION = 'Why is this interaction slow?';

/** The inspected tabs, one per route, distinct from every other suite's. */
const TAB = Object.freeze({ lateAgent: 4_711, lateBind: 4_712, collidingIds: 4_713 });

/**
 * How long a session is watched for a `ready` it must not reach. The path it
 * guards against — a report of the other browser's tab answering this
 * session's pending readiness wait — moves the session to `ready` within
 * milliseconds of that report, so this window covers it many times over
 * while staying well inside the gate's own reload wait.
 */
const NOT_READY_WINDOW_MS = 2_000;

/** The message the instrumentation service logs once an install has settled. */
const INSTALLED_LOG = 'Instrumentation installed';

/* -------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

type ReadyFrame = HarnessMessage<'instrumentation.ready'>;
type ProgressFrame = HarnessMessage<'session.progress'>;
type Gap = ReadyFrame['payload']['unavailable'][number];

let harness: Harness;

/** The `instrumentation.ready` frames a client received for `sessionId`, from index `from`. */
function readyFramesOf(client: HarnessWsClient, sessionId: string, from = 0): ReadyFrame[] {
  return client.received
    .slice(from)
    .filter(
      (message): message is ReadyFrame =>
        isMessageOfType(message, 'instrumentation.ready') &&
        message.payload.sessionId === sessionId,
    );
}

/** The instrument-stage progress frames a client received for `sessionId`, from index `from`. */
function instrumentRowsOf(client: HarnessWsClient, sessionId: string, from = 0): ProgressFrame[] {
  return client.received
    .slice(from)
    .filter(
      (message): message is ProgressFrame =>
        isMessageOfType(message, 'session.progress') &&
        message.payload.sessionId === sessionId &&
        message.payload.stage === INSTRUMENT_STAGE,
    );
}

/** The transcript index of the first message satisfying `predicate`, or -1. */
function indexWhere(client: HarnessWsClient, predicate: (message: ProtocolMessage) => boolean) {
  return client.received.findIndex(predicate);
}

/** Whether two gaps are the same report of the same signal. */
function sameGap(left: Gap, right: Gap): boolean {
  return left.signal === right.signal && left.reason === right.reason;
}

/**
 * The gaps of `stale` that `corrected` no longer reports: the signals the
 * page's report cleared. Read from the reports, so no signal is named here.
 */
function clearedGaps(stale: readonly Gap[], corrected: readonly Gap[]): Gap[] {
  return stale.filter((gap) => !corrected.some((kept) => sameGap(kept, gap)));
}

/**
 * The row label of each gap's signal, without repeats. The wire types a gap's
 * signal as text; a gap the adapters report always names a capture signal, so
 * any other value fails the test here, by name.
 */
function labelsOf(gaps: readonly Gap[]): string[] {
  return [
    ...new Set(
      gaps.map((gap) => {
        if (!isCaptureSignal(gap.signal)) {
          throw new Error(`"${gap.signal}" is not a capture signal.`);
        }
        return CAPTURE_SIGNAL_LABELS[gap.signal];
      }),
    ),
  ];
}

/** Whether a row presents one of `labels` as a signal that could not be enabled. */
function failsOneOf(frame: ProgressFrame, labels: readonly string[]): boolean {
  return labels.some((label) => frame.payload.message.startsWith(`Could not enable ${label}:`));
}

/** Waits for the next `count` `instrumentation.ready` frames of `sessionId` after `from`. */
async function waitForReadyFrames(
  client: HarnessWsClient,
  sessionId: string,
  count: number,
  from = 0,
): Promise<ReadyFrame[]> {
  return client.until(
    () => {
      const frames = readyFramesOf(client, sessionId, from);
      return frames.length >= count ? frames : undefined;
    },
    HARNESS_TIMEOUTS.pipeline,
    () => `${String(count)} instrumentation.ready frame(s) of ${sessionId}`,
  );
}

/** Waits until the service logged that the session's install has settled. */
async function waitForInstalled(sessionId: string): Promise<void> {
  await waitUntil(
    () =>
      harness.logger
        .withMessage(INSTALLED_LOG)
        .some((record) => record.fields['sessionId'] === sessionId)
        ? true
        : undefined,
    `the install of ${sessionId} settled`,
    HARNESS_TIMEOUTS.pipeline,
  );
}

/** A session on its own corpus copy, with a stand-in dev server, a preload and an editor. */
interface OpenSession {
  readonly copy: FixtureProjectCopy;
  readonly origin: string;
  readonly editor: HarnessWsClient;
  readonly record: SessionRecord;
}

/**
 * Creates a session over a fresh copy of the corpus: the real launcher starts a
 * stand-in dev server, a server-agent connection stands for the preload, and
 * the editor announces the copy's root. No tab is bound here.
 */
async function openSession(): Promise<OpenSession> {
  const copy = await harness.copyFixtureProject();
  const launched = await harness.launchDevServer(copy.root);
  if (isErr(launched)) {
    throw new Error(`the dev server did not launch (${launched.error.code})`);
  }
  const credential = harness.issueServerAgentCredential(copy.root);
  const serverAgent = await harness.ws({
    client: 'server-agent',
    projectRoot: copy.root,
    token: credential.token,
  });
  expect(serverAgent.authenticated).toBe(true);
  const editor = await harness.editor(copy.root);
  const record = await harness.createSession({ projectRoot: copy.root, question: QUESTION });
  return { copy, origin: new URL(launched.value.devServerUrl).origin, editor, record };
}

/** A loopback HTTP server standing in for one dev server several sessions are pointed at. */
interface SharedDevServer {
  /** Where it answers, in the `origin/` form a session records. */
  readonly url: string;
  /** Stops it and drops every connection. Idempotent. */
  close(): Promise<void>;
}

/** Starts a {@link SharedDevServer} on an ephemeral loopback port. */
async function startSharedDevServer(): Promise<SharedDevServer> {
  const server = createServer((_request, response) => {
    response.end('shared dev server');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The shared dev server did not bind a TCP port.');
  }
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${String(address.port)}/`,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      });
      return closing;
    },
  };
}

/**
 * Creates a session over a fresh copy of the corpus, recording `devServerUrl`
 * as its dev server — so several sessions share one dev-server origin — with a
 * server-agent connection standing for the copy's preload and an editor
 * announcing the copy's root. No tab is bound here.
 */
async function openSessionServedBy(devServerUrl: string): Promise<OpenSession> {
  const copy = await harness.copyFixtureProject();
  const credential = harness.issueServerAgentCredential(copy.root);
  const serverAgent = await harness.ws({
    client: 'server-agent',
    projectRoot: copy.root,
    token: credential.token,
  });
  expect(serverAgent.authenticated).toBe(true);
  const editor = await harness.editor(copy.root);
  const record = await harness.createSession({
    projectRoot: copy.root,
    question: QUESTION,
    devServerUrl,
  });
  return { copy, origin: new URL(devServerUrl).origin, editor, record };
}

/** The session's status as the manager holds it now. */
function statusOf(sessionId: string): SessionRecord['status'] | undefined {
  const record = harness.manager.get(sessionId);
  if (isErr(record)) {
    throw new Error(`the session record was unreadable (${record.error.code})`);
  }
  return record.value?.status;
}

/** Whether a client received the "Ready to capture" row for `sessionId`. */
function announcedReady(client: HarnessWsClient, sessionId: string): boolean {
  return instrumentRowsOf(client, sessionId).some(
    (frame) =>
      frame.payload.status === ROW_DONE && frame.payload.message === READY_TO_CAPTURE_MESSAGE,
  );
}

/** Binds `tabId` to the session through `client`, failing the test on a refusal. */
async function bind(client: HarnessWsClient, session: OpenSession, tabId: number): Promise<void> {
  const bound = await harness.bindTab(client, {
    tabId,
    url: `${session.origin}/`,
    origin: session.origin,
    sessionId: session.record.id,
  });
  if (isErr(bound)) {
    throw new Error(`session.bind was refused (${bound.error.code}): ${bound.error.message}`);
  }
}

/**
 * Relays the tab's page-agent report on its DevTools connection, as the
 * service worker does. `producerId` defaults to one per tab id; two browsers
 * whose tab ids collide pass their own.
 */
async function reportPageAgent(
  client: HarnessWsClient,
  session: OpenSession,
  tabId: number,
  documentId: string,
  producerId = `prd_signalready_${String(tabId)}`,
): Promise<void> {
  const report = client.send('agent.ready', {
    tabId,
    documentId,
    producerId,
    url: `${session.origin}/`,
    installedBeforeReact: true,
    reactDetected: true,
  });
  expect(await client.flush()).toBe(true);
  expect(client.errorsFor(report.id)).toEqual([]);
}

/** Ends the session through the real cleanup and proves the copy byte-identical again. */
async function endAndVerify(session: OpenSession): Promise<void> {
  const ended = await harness.endSession(session.record.id);
  if (isErr(ended)) {
    throw new Error(`session.end was refused (${ended.error.code}): ${ended.error.message}`);
  }
  expect(ended.value.cleanup).toBe(CLEANUP_CLEAN);
  await assertTreeUnchanged(session.copy.root, session.copy.snapshot);
}

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  await harness.assertNoLeaks();
});

/* -------------------------------------------------------------------------------------------------
 * A page agent that reports while the install's readiness settles
 * ---------------------------------------------------------------------------------------------- */

describe('a bound tab whose page agent reports after the install asked its adapters', () => {
  it('sends one corrected instrumentation.ready, checks every cleared signal and fails none of them', async () => {
    const session = await openSession();
    const sessionId = session.record.id;
    const { client: devtools } = await harness.connectDevtools({ tabId: TAB.lateAgent });
    await bind(devtools, session, TAB.lateAgent);

    // The install asked its adapters before any page agent reported …
    const [stale] = await waitForReadyFrames(devtools, sessionId, 1);
    expect(stale).toBeDefined();
    const staleGaps = stale?.payload.unavailable ?? [];
    expect(staleGaps.length).toBeGreaterThan(0);

    // … and the page agent reports while the gate settles.
    await reportPageAgent(devtools, session, TAB.lateAgent, 'doc_signalready_late01');
    await harness.waitForSession(sessionId, (record) => record.status === STATUS_READY);
    await waitForInstalled(sessionId);

    // Exactly one corrected report follows, to both user interfaces.
    for (const client of [session.editor, devtools]) {
      expect(await client.flush()).toBe(true);
      expect(readyFramesOf(client, sessionId)).toHaveLength(2);
    }
    const [first, corrected] = readyFramesOf(session.editor, sessionId);
    expect(first?.payload).toEqual(stale?.payload);
    expect(readyFramesOf(devtools, sessionId)[1]?.payload).toEqual(corrected?.payload);
    const correctedGaps = corrected?.payload.unavailable ?? [];
    const cleared = clearedGaps(staleGaps, correctedGaps);
    expect(cleared.length).toBeGreaterThan(0);
    expect(correctedGaps.every((gap) => staleGaps.some((was) => sameGap(was, gap)))).toBe(true);
    expect(corrected?.payload.applied).toEqual(stale?.payload.applied);
    expect(corrected?.payload.runtimeHooks).toEqual(
      expect.arrayContaining(stale?.payload.runtimeHooks ?? []),
    );
    expect(corrected?.payload.runtimeHooks.length).toBeGreaterThan(
      stale?.payload.runtimeHooks.length ?? 0,
    );

    // No row says a cleared signal could not be enabled; each has its ✓, and
    // the group closes with "Ready to capture". `waitForSession` reads through
    // `session.get`, which replays the stored rows to the editor, so the rows
    // below are the live ones and the stored ones: both are checked.
    const labels = labelsOf(cleared);
    const rows = instrumentRowsOf(session.editor, sessionId);
    expect(rows.filter((frame) => failsOneOf(frame, labels))).toEqual([]);
    expect(rows.filter((frame) => frame.payload.status === ROW_FAILED)).toEqual([]);
    const checked = rows
      .filter((frame) => frame.payload.status === ROW_DONE)
      .map((frame) => frame.payload.message);
    expect(checked).toEqual(expect.arrayContaining(labels));
    expect(checked).toContain(READY_TO_CAPTURE_MESSAGE);

    await endAndVerify(session);
  });
});

/* -------------------------------------------------------------------------------------------------
 * A panel that binds after the install
 * ---------------------------------------------------------------------------------------------- */

describe('a panel that binds after the install', () => {
  it('is replayed the latest instrumentation.ready, and both interfaces get the report corrected once the page reports', async () => {
    const session = await openSession();
    const sessionId = session.record.id;

    // The install settles with no tab bound: the browser signals are not enabled.
    const [stale] = await waitForReadyFrames(session.editor, sessionId, 1);
    await waitForInstalled(sessionId);
    const staleGaps = stale?.payload.unavailable ?? [];
    expect(staleGaps.length).toBeGreaterThan(0);
    // The service logged the install before its last rows reached the editor:
    // the barrier makes every row of the install land before the mark.
    expect(await session.editor.flush()).toBe(true);
    const editorMark = session.editor.received.length;

    // The bind replays the held report to the panel, after the bind announcement.
    const { client: devtools } = await harness.connectDevtools({ tabId: TAB.lateBind });
    await bind(devtools, session, TAB.lateBind);
    const replayed = await waitForReadyFrames(devtools, sessionId, 1);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.payload).toEqual(stale?.payload);
    const boundAt = indexWhere(
      devtools,
      (message) =>
        isMessageOfType(message, 'session.bound') && message.payload.sessionId === sessionId,
    );
    const replayedAt = indexWhere(
      devtools,
      (message) =>
        isMessageOfType(message, 'instrumentation.ready') &&
        message.payload.sessionId === sessionId,
    );
    expect(boundAt).toBeGreaterThanOrEqual(0);
    expect(replayedAt).toBeGreaterThan(boundAt);
    // The replay went to the panel alone: the editor was not sent it again.
    expect(await session.editor.flush()).toBe(true);
    expect(readyFramesOf(session.editor, sessionId, editorMark)).toEqual([]);

    // The tab's page agent reports: the report is corrected for both interfaces.
    await reportPageAgent(devtools, session, TAB.lateBind, 'doc_signalready_bind01');
    const [corrected] = await waitForReadyFrames(session.editor, sessionId, 1, editorMark);
    const correctedGaps = corrected?.payload.unavailable ?? [];
    const cleared = clearedGaps(staleGaps, correctedGaps);
    expect(cleared.length).toBeGreaterThan(0);
    expect(correctedGaps.every((gap) => staleGaps.some((was) => sameGap(was, gap)))).toBe(true);
    expect(corrected?.payload.applied).toEqual(stale?.payload.applied);
    const onPanel = await waitForReadyFrames(devtools, sessionId, 2);
    expect(onPanel[1]?.payload).toEqual(corrected?.payload);

    // Each signal the report now confirms gets its ✓, and none is shown as failed.
    const labels = labelsOf(cleared);
    await session.editor.until(
      () => {
        const checked = instrumentRowsOf(session.editor, sessionId, editorMark)
          .filter((frame) => frame.payload.status === ROW_DONE)
          .map((frame) => frame.payload.message);
        return labels.every((label) => checked.includes(label)) ? true : undefined;
      },
      HARNESS_TIMEOUTS.pipeline,
      () => `a ✓ row for each of ${labels.join(', ')}`,
    );
    const laterRows = instrumentRowsOf(session.editor, sessionId, editorMark);
    expect(laterRows.filter((frame) => frame.payload.status === ROW_FAILED)).toEqual([]);
    expect(laterRows.filter((frame) => failsOneOf(frame, labels))).toEqual([]);
    await harness.waitForSession(sessionId, (record) => record.status === STATUS_READY);

    // A re-bind of the same tab replays the corrected report, never the stale one.
    const rebindMark = devtools.received.length;
    await bind(devtools, session, TAB.lateBind);
    const rebound = await waitForReadyFrames(devtools, sessionId, 1, rebindMark);
    expect(rebound).toHaveLength(1);
    expect(rebound[0]?.payload).toEqual(corrected?.payload);

    await endAndVerify(session);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Two paired browsers whose bound tabs share an id
 * ---------------------------------------------------------------------------------------------- */

describe('two paired browsers whose bound tabs share an id, on one dev-server origin', () => {
  it('makes a session ready on its own browser’s page-agent report only, never on the other browser’s', async () => {
    const devServer = await startSharedDevServer();
    try {
      const first = await openSessionServedBy(devServer.url);
      const second = await openSessionServedBy(devServer.url);
      expect(second.origin).toBe(first.origin);
      expect(second.copy.root).not.toBe(first.copy.root);

      // Two paired extensions, each with its own credential. Chrome numbers
      // tabs per browser, so each inspects — and binds — its own tab 4713.
      const tabId = TAB.collidingIds;
      const firstCredential = harness.issueDevtoolsCredential();
      const secondCredential = harness.issueDevtoolsCredential();
      expect(secondCredential.extensionId).not.toBe(firstCredential.extensionId);
      const { client: firstBrowser } = await harness.connectDevtools({
        tabId,
        credential: firstCredential,
      });
      const { client: secondBrowser } = await harness.connectDevtools({
        tabId,
        credential: secondCredential,
      });
      await bind(firstBrowser, first, tabId);
      await bind(secondBrowser, second, tabId);

      // Both installs asked their adapters before any page agent reported, and
      // both sessions wait for their bound tab's page.
      const [firstStale] = await waitForReadyFrames(firstBrowser, first.record.id, 1);
      const [secondStale] = await waitForReadyFrames(secondBrowser, second.record.id, 1);
      expect(firstStale?.payload.unavailable.length).toBeGreaterThan(0);
      expect(secondStale?.payload.unavailable.length).toBeGreaterThan(0);
      expect(statusOf(first.record.id)).toBe(STATUS_INSTRUMENTING);
      expect(statusOf(second.record.id)).toBe(STATUS_INSTRUMENTING);

      // Only the first browser's page agent reports: its own session is ready …
      await reportPageAgent(
        firstBrowser,
        first,
        tabId,
        'doc_signalready_firstbrowser01',
        'prd_signalready_firstbrowser',
      );
      await harness.waitForSession(first.record.id, (record) => record.status === STATUS_READY);
      await waitForInstalled(first.record.id);

      // … and the other browser's session is not: it keeps waiting on its own
      // page agent, with no "Ready to capture" and no corrected report.
      const becameReady = await harness
        .waitForSession(second.record.id, (record) => record.status === STATUS_READY, {
          timeoutMs: NOT_READY_WINDOW_MS,
        })
        .then(
          () => true,
          () => false,
        );
      expect(becameReady).toBe(false);
      expect(statusOf(second.record.id)).toBe(STATUS_INSTRUMENTING);
      for (const client of [second.editor, secondBrowser]) {
        expect(await client.flush()).toBe(true);
        expect(announcedReady(client, second.record.id)).toBe(false);
        expect(readyFramesOf(client, second.record.id)).toHaveLength(1);
      }
      expect(readyFramesOf(secondBrowser, second.record.id)[0]?.payload).toEqual(
        secondStale?.payload,
      );
      expect(await first.editor.flush()).toBe(true);
      expect(announcedReady(first.editor, first.record.id)).toBe(true);

      // The second browser's own page agent reports: now its session is ready.
      await reportPageAgent(
        secondBrowser,
        second,
        tabId,
        'doc_signalready_secondbrowser01',
        'prd_signalready_secondbrowser',
      );
      await harness.waitForSession(second.record.id, (record) => record.status === STATUS_READY);
      await waitForInstalled(second.record.id);
      await second.editor.until(
        () => (announcedReady(second.editor, second.record.id) ? true : undefined),
        HARNESS_TIMEOUTS.pipeline,
        () => `the "${READY_TO_CAPTURE_MESSAGE}" row of ${second.record.id}`,
      );

      await endAndVerify(first);
      await endAndVerify(second);
    } finally {
      await devServer.close();
    }
  });
});
