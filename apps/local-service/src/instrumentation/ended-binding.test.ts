/**
 * Tests for `ProducerReconciler.pageAgentReleased` in `./service.ts`: the page
 * disarm an ended session still owes is settled when the tab that held it is
 * refused a re-bind to it.
 *
 * What is on trial, and why it matters (QA finding INT-F03, AAP §0.5.1):
 *
 * - **An owed page disarm settles on the refusal.** A session that ended while
 *   its tab's DevTools connection was away owes the page agent its dormant
 *   configuration, and the usual replays cannot pay it — they reach a page
 *   agent through a live binding, and an ended session is never bound again.
 *   The refused re-bind is the one moment that tab is seen again, and the
 *   DevTools worker answers it by returning the page agent to dormant, so the
 *   debt is recorded as paid: the pending set empties, dormancy is confirmed
 *   (which upgrades a `partial` cleanup), and a later reconcile finds the page
 *   already dormant.
 * - **Only the page's debt.** The preload's owed disarm stays owed until the
 *   preload itself reconnects; dormancy is confirmed only once both are paid.
 * - **Nothing is invented.** No page disarm outstanding answers
 *   `nothing-owed` and changes nothing; the service sends no frame of its own
 *   on this path; a blank session id is refused.
 *
 * The service is the real `createInstrumentationService`, over recording
 * producer channels and doubles that fail the test if the paths on trial reach
 * a collaborator they have no business with. No filesystem, network or timer.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import type { ProtocolMessage } from '@debuggen/protocol';
import { DebuggenError, err, isErr, isOk, ok } from '@debuggen/shared';
import type { LogFields, Logger } from '@debuggen/shared';

import type { ServiceConfig } from '../config.js';
import type { SessionBroadcaster } from '../sessions/manager.js';
import type { SessionProgress } from '../sessions/progress.js';
import type { ModificationsRepo } from '../store/modifications-repo.js';
import type { BrowserAgentRegistry, ServerAgentReadinessSource } from './readiness.js';
import { createInstrumentationService } from './service.js';
import type {
  AgentConfigChannel,
  InstrumentationDriver,
  ServerAgentConfigChannel,
} from './service.js';
import type { InstrumentationWatcher } from './watcher.js';

// ---------------------------------------------------------------------------
// Fixtures: neutral, obviously synthetic identities
// ---------------------------------------------------------------------------

const SESSION_ID = 'ses_endedbinding0001';
const CAPTURE_ID = 'cap_endedbinding0001';
const PROJECT_ROOT = '/work/sample-project';
const STATE_HOME = '/work/state-home';
const NOW = 1_800_000_000_000;

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields | undefined;
  readonly bindings: LogFields;
}

function createRecordingLogger(entries: LogEntry[], bindings: LogFields = {}): Logger {
  const record =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields, bindings });
    };

  return {
    level: 'trace',
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    child: (extra) => createRecordingLogger(entries, { ...bindings, ...extra }),
  };
}

/**
 * A collaborator the paths on trial must never call: every member is a
 * function that throws, naming the port and the member, so an unexpected
 * reach fails the test with its own name rather than passing silently.
 */
function unreached<T extends object>(port: string): T {
  const handler: ProxyHandler<T> = {
    get: (_target, member) => () => {
      throw new Error(`${port}.${String(member)} is not reached by the ended-binding path`);
    },
  };
  return new Proxy({} as T, handler);
}

interface RecordingAgentChannel extends AgentConfigChannel {
  /** Every frame offered, taken or not, in send order. */
  readonly offered: ProtocolMessage[];
  /** When `true`, every send answers `TRANSPORT_DISCONNECTED`, as for an away tab. */
  refusing: boolean;
}

function createRecordingAgentChannel(): RecordingAgentChannel {
  const offered: ProtocolMessage[] = [];
  const channel: RecordingAgentChannel = {
    offered,
    refusing: true,
    sendToBoundTab(_sessionId, message) {
      offered.push(message);
      return channel.refusing
        ? err(new DebuggenError('TRANSPORT_DISCONNECTED', 'No bound-tab connection took it.'))
        : ok({ delivered: 1 });
    },
  };
  return channel;
}

interface RecordingServerChannel extends ServerAgentConfigChannel {
  /** Every frame offered, taken or not, in send order. */
  readonly offered: ProtocolMessage[];
  /** When `true`, every send answers `SERVER_AGENT_NOT_READY`, as with no preload. */
  refusing: boolean;
}

function createRecordingServerChannel(refusing: boolean): RecordingServerChannel {
  const offered: ProtocolMessage[] = [];
  const channel: RecordingServerChannel = {
    offered,
    refusing,
    sendToServerAgent(_projectRoot, message) {
      offered.push(message);
      return channel.refusing
        ? err(new DebuggenError('SERVER_AGENT_NOT_READY', 'No preload is connected.'))
        : ok(1);
    },
  };
  return channel;
}

function serviceConfig(): ServiceConfig {
  return {
    host: '127.0.0.1',
    port: 20_350,
    logLevel: 'silent',
    retentionDays: 30,
    provider: 'deterministic',
    debuggenHome: STATE_HOME,
    databasePath: `${STATE_HOME}/sessions.sqlite`,
    backupsDir: `${STATE_HOME}/backups`,
    indexCacheDir: `${STATE_HOME}/index`,
    authFilePath: `${STATE_HOME}/auth.json`,
    promptsDir: `${STATE_HOME}/prompts`,
  };
}

interface Harness {
  readonly service: InstrumentationDriver;
  readonly agentChannel: RecordingAgentChannel;
  readonly serverChannel: RecordingServerChannel;
  /** Every session whose dormancy was confirmed, in order. */
  readonly confirmed: string[];
  readonly log: LogEntry[];
}

/**
 * One service whose session {@link SESSION_ID} ended while its tab was away:
 * the capture a restart interrupted is released with the tab's connection
 * refusing, so the page agent is owed its dormant configuration. With
 * `preloadAway`, the preload refuses too and is owed its disabled one.
 */
function endedWhileAway(options: { readonly preloadAway?: boolean } = {}): Harness {
  const log: LogEntry[] = [];
  const agentChannel = createRecordingAgentChannel();
  const serverChannel = createRecordingServerChannel(options.preloadAway === true);
  const service = createInstrumentationService({
    config: serviceConfig(),
    logger: createRecordingLogger(log),
    modifications: unreached<ModificationsRepo>('modifications'),
    progress: unreached<SessionProgress>('progress'),
    broadcaster: unreached<SessionBroadcaster>('broadcaster'),
    agentChannel,
    serverAgentChannel: serverChannel,
    watcher: unreached<InstrumentationWatcher>('watcher'),
    agents: unreached<BrowserAgentRegistry>('agents'),
    serverAgents: unreached<ServerAgentReadinessSource>('serverAgents'),
    now: () => NOW,
  });
  const confirmed: string[] = [];
  service.onDormancyConfirmed((sessionId) => confirmed.push(sessionId));

  const released = service.releaseInterruptedCapture({
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    projectRoot: PROJECT_ROOT,
  });
  expect(isOk(released) && released.value.pageAgent).toBe('unreachable');
  expect(service.pendingDisarms(SESSION_ID)).toEqual(
    options.preloadAway === true ? ['page-agent', 'server-agent'] : ['page-agent'],
  );

  return { service, agentChannel, serverChannel, confirmed, log };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('pageAgentReleased: the refused re-bind of an ended session’s tab', () => {
  it('settles the owed page disarm, confirms dormancy once, and sends nothing itself', () => {
    const h = endedWhileAway();
    const offered = h.agentChannel.offered.length;

    const released = h.service.pageAgentReleased(SESSION_ID);

    expect(isOk(released) && released.value).toBe('settled');
    expect(h.service.pendingDisarms(SESSION_ID)).toEqual([]);
    expect(h.confirmed).toEqual([SESSION_ID]);
    // The worker delivers the dormant configuration on the refusal; the service does not.
    expect(h.agentChannel.offered).toHaveLength(offered);
    const settled = h.log.find((entry) =>
      entry.message.startsWith('The owed page disarm was settled'),
    );
    expect(settled?.level).toBe('info');
    expect(settled?.fields).toMatchObject({ captureId: CAPTURE_ID });
    expect(settled?.bindings).toMatchObject({ sessionId: SESSION_ID });
  });

  it('records the page as dormant, so a later reconcile of the capture sends nothing', () => {
    const h = endedWhileAway();
    h.service.pageAgentReleased(SESSION_ID);
    h.agentChannel.refusing = false;
    const offered = h.agentChannel.offered.length;

    const reconciled = h.service.reconcileBoundSession({
      sessionId: SESSION_ID,
      projectRoot: PROJECT_ROOT,
      lastCaptureId: CAPTURE_ID,
    });

    expect(isOk(reconciled) && reconciled.value).toBe('already-dormant');
    expect(h.agentChannel.offered).toHaveLength(offered);
  });

  it('leaves the preload’s owed disarm owed, confirming dormancy only once the preload takes it', () => {
    const h = endedWhileAway({ preloadAway: true });

    const released = h.service.pageAgentReleased(SESSION_ID);

    expect(isOk(released) && released.value).toBe('settled');
    expect(h.service.pendingDisarms(SESSION_ID)).toEqual(['server-agent']);
    expect(h.confirmed).toEqual([]);

    h.serverChannel.refusing = false;
    const replay = h.service.producerConnected({ kind: 'server-agent', projectRoot: PROJECT_ROOT });

    expect(replay.disarmed).toEqual([SESSION_ID]);
    expect(h.service.pendingDisarms(SESSION_ID)).toEqual([]);
    expect(h.confirmed).toEqual([SESSION_ID]);
  });

  it('answers nothing-owed, changing nothing, when no page disarm is outstanding', () => {
    const h = endedWhileAway();
    h.service.pageAgentReleased(SESSION_ID);

    const again = h.service.pageAgentReleased(SESSION_ID);
    const other = h.service.pageAgentReleased('ses_endedbinding0002');

    expect(isOk(again) && again.value).toBe('nothing-owed');
    expect(isOk(other) && other.value).toBe('nothing-owed');
    expect(h.confirmed).toEqual([SESSION_ID]);
  });

  it('refuses a blank session id, settling nothing', () => {
    const h = endedWhileAway();

    const refused = h.service.pageAgentReleased(' ');

    expect(isErr(refused) && refused.error.code).toBe('INTERNAL');
    expect(h.service.pendingDisarms(SESSION_ID)).toEqual(['page-agent']);
    expect(h.confirmed).toEqual([]);
  });

  it('settles nothing once the service is disposed', async () => {
    const h = endedWhileAway();
    await h.service.dispose();

    const released = h.service.pageAgentReleased(SESSION_ID);

    expect(isOk(released) && released.value).toBe('nothing-owed');
    expect(h.confirmed).toEqual([]);
  });
});
