/**
 * `cleanup-conflict` — the reversibility guarantee of AAP §0.5.1, proved through the real service:
 * **patch → external edit → end ⇒ conflict**, with the developer's bytes preserved, the backup
 * retained, `cleanup.status = conflict` and `cleanup.completed` carrying `conflicts[]` (AAP §0.8.3,
 * §0.5.1, §0.5.5).
 *
 * ## Why this suite exists beside the unit suites
 *
 * `packages/instrumentation/src/{cleanup,installer}.test.ts`, `src/cleanup/cleanup.test.ts` and
 * `src/instrumentation/watcher.test.ts` already pin these mechanics in isolation, over in-memory
 * journals and synthetic watch events. What only this suite can show is the same guarantee end to
 * end: a session created over HTTP, a plan chosen by the deterministic pipeline and installed by
 * the real `installPlan` behind `InstrumentationService.install`, the journal in a real
 * `node:sqlite` store, the backups under a real `$DEBUGGEN_HOME`, the live `fs.watch` conflict
 * detector, `POST /sessions/:id/end` running the real `cleanupSession`, and the real
 * `reconcileModifications` running during a genuine service restart.
 *
 * ## Rules this file keeps (AAP §0.10 baseline; `review_rules` reports no user rules)
 *
 * - **Nothing here writes instrumentation.** Every patched byte is produced by the product: the
 *   pipeline's plan stage installs it, or — for the crash rows of the reconciliation table, which
 *   no running service can produce on demand — the real write sequence (`createPatcher`) is run
 *   against the service's own journal and backup store and interrupted at a boundary through its
 *   documented failure-injection seam (`onStage`). The only bytes this suite writes into a project
 *   are the *developer edits* it simulates, always inside an `fs.mkdtemp` copy of
 *   `test/fixtures/sample-project`; the committed corpus is never touched.
 * - **No literal vocabulary where a constant exists.** Record, cleanup and session statuses are read
 *   from `MODIFICATION_STATUSES`, `CLEANUP_STATUSES` and `SESSION_STATUSES` through
 *   {@link vocabulary}; the instrumentation markers from `@debuggen/instrumentation`; the conflict
 *   sentence from `buildConflictMessage`.
 * - **No secret-shaped literal.** Every credential is minted by the harness through the real auth
 *   service.
 * - **Nothing leaks.** Every harness is stopped and proven closed; every temporary home and project
 *   copy is removed.
 *
 * @module
 */

import { realpathSync } from 'node:fs';
import {
  access,
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DISABLED_SERVER_AGENT_SIGNALS,
  DORMANT_AGENT_HOOK_CONFIG,
  HELPER_TYPE_ALIAS_TEXT,
  INSTRUMENTATION_MARKERS,
  MODIFICATION_CONFLICT_REASONS,
  MODIFICATION_STATUSES,
  OPEN_MODIFICATION_STATUSES,
  SPAN_HELPER_GLOBAL,
  SPAN_HELPER_TYPE_NAME,
  buildConflictReport,
  createBackupStore,
  createPatcher,
  needsHelperTypeAlias,
  parseModificationRecord,
} from '@debuggen/instrumentation';
import type {
  ModificationConflict,
  ModificationJournal,
  ModificationRecord,
  PatchStage,
} from '@debuggen/instrumentation';
import {
  CLEANUP_STATUSES,
  PROGRESS_STAGES,
  SESSION_STATUSES,
  cleanupCompletedPayloadSchema,
  isMessageOfType,
} from '@debuggen/protocol';
import type { MessageType, SessionRecord } from '@debuggen/protocol';
import { DebuggenError, err, isErr, newId, newProducerId, toPosix } from '@debuggen/shared';
import { sha256OfFile } from '@debuggen/shared/node';

import { aggregateCleanupStatus } from '../../src/cleanup/cleanup.js';
import {
  DEFAULT_CONFLICT_DEBOUNCE_MS,
  buildConflictMessage,
} from '../../src/instrumentation/watcher.js';
import {
  HARNESS_TIMEOUTS,
  assertTreeUnchanged,
  copyFixtureProject,
  createHarnessClock,
  diffTreeSnapshots,
  readTelemetryBatch,
  snapshotTree,
  startHarness,
  waitFor,
  waitUntil,
} from './harness.js';
import type {
  FixtureProjectCopy,
  Harness,
  HarnessMessage,
  HarnessWsClient,
  TreeSnapshot,
} from './harness.js';

/* -------------------------------------------------------------------------------------------------
 * Vocabulary
 * ---------------------------------------------------------------------------------------------- */

/** A closed string vocabulary as an object whose every key maps to itself. */
type Vocabulary<T extends readonly string[]> = { readonly [K in T[number]]: K };

/**
 * Turns a vocabulary tuple into `{ value: value }`, so a status is spelled `MODIFICATION.applied`
 * — a value read from the owning constant — rather than as a string literal that could drift from
 * it.
 */
function vocabulary<const T extends readonly string[]>(values: T): Vocabulary<T> {
  return Object.freeze(Object.fromEntries(values.map((value) => [value, value]))) as Vocabulary<T>;
}

/** Journal statuses, from `@debuggen/instrumentation`. */
const MODIFICATION = vocabulary(MODIFICATION_STATUSES);

/** `session.cleanup.status` values, from `@debuggen/protocol`. */
const CLEANUP = vocabulary(CLEANUP_STATUSES);

/** Session statuses, from `@debuggen/protocol`. */
const SESSION = vocabulary(SESSION_STATUSES);

/** Pipeline stages a failure is attributed to, from `@debuggen/protocol`. */
const STAGE = vocabulary(PROGRESS_STAGES);

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The questions that steer the deterministic pipeline over `sample-project`. Each is ordinary
 * developer phrasing; which files the plan instruments is the pipeline's own decision, read back
 * from the journal — never assumed here. The comments say what the plan settles on today, only so
 * a reader can follow the scenario.
 */
const QUESTIONS = Object.freeze({
  /** One route handler timing (`app/api/trail-report/route.ts` → `GET`). */
  routeLatency: 'Why is the trail report slow to load?',
  /** One database helper timing (`src/server/db/pool.ts`). */
  queryLatency: 'Why is queryTrailConditionReports slow?',
  /** Timings across two files: the route handler and a chain of two in the service module. */
  twoTierLatency: 'Why does summarizeConditions take so long in loadTrailReport and GET?',
});

/**
 * Real, patchable symbols of the corpus, in the order the crash rows try them. A crash row is
 * injected into a file its session's plan did not already patch, so the interrupted write sequence
 * starts from the file's original bytes, exactly as a first install would.
 */
const CRASH_TARGETS: readonly { readonly file: string; readonly symbol: string }[] = Object.freeze([
  { file: 'src/server/services/trail-report.service.ts', symbol: 'loadTrailReport' },
  { file: 'src/server/db/pool.ts', symbol: 'queryTrailConditionReports' },
  { file: 'app/api/trail-report/route.ts', symbol: 'GET' },
]);

/** The telemetry fixture that carries a capture from `capturing` to `generated`. */
const CAPTURE_FIXTURE = 'telemetry-trace-cross-tier.json';

/** One day, in milliseconds, for moving a restarted service past the retention window. */
const DAY_MS = 86_400_000;

/**
 * How long to keep listening after a conflict was reported, to prove no second report follows for
 * the same burst: several debounce windows, comfortably inside the per-test budget.
 */
const QUIET_PERIOD_MS = DEFAULT_CONFLICT_DEBOUNCE_MS * 4;

/** The gap between the writes of one simulated save burst — well inside one debounce window. */
const BURST_GAP_MS = Math.max(1, Math.floor(DEFAULT_CONFLICT_DEBOUNCE_MS / 10));

/** The prefix of the caller-owned `$DEBUGGEN_HOME` the restart block shares across lifetimes. */
const SHARED_HOME_PREFIX = 'debuggen-it-cleanup-home-';

/* -------------------------------------------------------------------------------------------------
 * Filesystem helpers
 * ---------------------------------------------------------------------------------------------- */

/** The absolute path of a project-relative file. */
function projectFile(root: string, file: string): string {
  return join(root, file);
}

/** The SHA-256 of a project file's raw bytes. */
function hashOf(root: string, file: string): Promise<string> {
  return sha256OfFile(projectFile(root, file));
}

/** Whether a path exists (without following a failure into an exception). */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The files left in a session's backup directory; none when the directory itself is gone. */
async function backupEntries(home: string, sessionId: string): Promise<string[]> {
  try {
    return await readdir(join(home, 'backups', sessionId));
  } catch {
    return [];
  }
}

/** Where AAP §0.2.3 puts a record's original: `$DEBUGGEN_HOME/backups/<sessionId>/<originalHash>`. */
function expectedBackupPath(home: string, record: ModificationRecord): string {
  return toPosix(join(home, 'backups', record.sessionId, record.originalHash));
}

/** A line no editor, formatter or tool would write — the fingerprint of one simulated edit. */
function developerLine(): string {
  return `// ${newId('edit')}: a note the developer added while the file was instrumented`;
}

/**
 * A developer's save burst with ordinary writes: the line is appended in three chunks, each well
 * inside one debounce window, the way an editor flushes a buffer.
 */
async function editInPlace(absolutePath: string, line: string): Promise<void> {
  await appendFile(absolutePath, '\n');
  await sleep(BURST_GAP_MS);
  await appendFile(absolutePath, line);
  await sleep(BURST_GAP_MS);
  await appendFile(absolutePath, '\n');
}

/**
 * A developer's atomic save — the pattern the directory-watch design exists to catch: the new
 * content is written to a sibling temporary file, which is then renamed over the target, replacing
 * its inode.
 */
async function editByAtomicRename(absolutePath: string, line: string): Promise<void> {
  const current = await readFile(absolutePath);
  const temporary = join(dirname(absolutePath), `.${basename(absolutePath)}.${newId('save')}.tmp`);
  await writeFile(temporary, Buffer.concat([current, Buffer.from(`\n${line}\n`)]));
  await rename(temporary, absolutePath);
  expect(await exists(temporary)).toBe(false);
}

/* -------------------------------------------------------------------------------------------------
 * Journal and message helpers
 * ---------------------------------------------------------------------------------------------- */

/** Parses a journal row with the one definition of the record, failing the test on a mismatch. */
function parsedRecord(value: unknown): ModificationRecord {
  const parsed = parseModificationRecord(value);
  if (isErr(parsed)) {
    throw new Error(`A modification record did not parse: ${parsed.error.message}`);
  }
  return parsed.value;
}

/** A session's journal rows, in append order, each re-parsed with `parseModificationRecord`. */
async function journalOf(h: Harness, sessionId: string): Promise<ModificationRecord[]> {
  const listed = await h.repos.modifications.listBySession(sessionId);
  if (isErr(listed)) {
    throw new Error(`The journal of ${sessionId} could not be listed: ${listed.error.message}`);
  }
  return listed.value.map(parsedRecord);
}

/** One journal row, which must exist. */
async function journalRecord(h: Harness, id: string): Promise<ModificationRecord> {
  const read = await h.repos.modifications.get(id);
  if (isErr(read)) {
    throw new Error(`The modification ${id} could not be read: ${read.error.message}`);
  }
  if (read.value === undefined) {
    throw new Error(`The modification ${id} is not in the journal.`);
  }
  return parsedRecord(read.value);
}

/** Every open journal row across every session — the reconciliation set of AAP §0.5.1. */
async function allOpenRecords(h: Harness): Promise<ModificationRecord[]> {
  const listed = await h.repos.modifications.listAllOpen();
  if (isErr(listed)) {
    throw new Error(`The open journal rows could not be listed: ${listed.error.message}`);
  }
  return listed.value.map(parsedRecord);
}

/** A session as the store holds it, or `undefined` when its row is gone. */
function storedSession(h: Harness, sessionId: string): SessionRecord | undefined {
  const read = h.repos.sessions.get(sessionId);
  if (isErr(read)) {
    throw new Error(`The session ${sessionId} could not be read: ${read.error.message}`);
  }
  return read.value;
}

/** Waits until a journal row carries `status`. */
function recordReaches(
  h: Harness,
  id: string,
  status: ModificationRecord['status'],
  timeoutMs: number = HARNESS_TIMEOUTS.capture,
): Promise<ModificationRecord> {
  return waitUntil(
    async () => {
      const record = await journalRecord(h, id);
      return record.status === status ? record : undefined;
    },
    `modification ${id} is ${status}`,
    timeoutMs,
  );
}

/** Every message of `type` a client received at or after transcript index `from`. */
function received<K extends MessageType>(
  client: HarnessWsClient,
  type: K,
  from = 0,
): HarnessMessage<K>[] {
  return client.received
    .slice(from)
    .filter((message): message is HarnessMessage<K> => isMessageOfType(message, type));
}

/**
 * A schema-valid conflict report about `record`, built by `@debuggen/instrumentation`'s own
 * `buildConflictReport`. The reason is immaterial to the sentence below, which names only the file
 * and the backup path, so the first member of the closed vocabulary is used.
 */
function conflictReportFor(record: ModificationRecord): ModificationConflict {
  const report = buildConflictReport({
    record,
    reason: MODIFICATION_CONFLICT_REASONS[0],
    detectedAt: record.appliedAt,
    message: `${record.file} diverged from the instrumented content.`,
  });
  if (isErr(report)) {
    throw new Error(`A conflict report could not be composed: ${report.error.message}`);
  }
  return report.value;
}

/**
 * The AAP §0.5.5 sentence the watcher sends for a conflict on `record` — "‹file› was edited while
 * instrumented. Debug Generator will not overwrite it. Original saved at ‹backup path›." — composed
 * by the service's own `buildConflictMessage`, so the suite never carries a copy of the wording.
 */
function conflictSentence(record: ModificationRecord): string {
  return buildConflictMessage(record, conflictReportFor(record));
}

/** The `session.progress` rows carrying the conflict sentence for `record`. */
function conflictRows(
  client: HarnessWsClient,
  record: ModificationRecord,
  from = 0,
): HarnessMessage<'session.progress'>[] {
  const sentence = conflictSentence(record);
  return received(client, 'session.progress', from).filter(
    (row) => row.payload.sessionId === record.sessionId && row.payload.message === sentence,
  );
}

/** The `cleanup.completed` envelopes a client received for one session. */
function cleanupReports(
  client: HarnessWsClient,
  sessionId: string,
  from = 0,
): HarnessMessage<'cleanup.completed'>[] {
  return received(client, 'cleanup.completed', from).filter(
    (message) => message.payload.sessionId === sessionId,
  );
}

/** Parses a `cleanup.completed` payload with protocol's schema, failing the test on a mismatch. */
function parsedCleanupPayload(
  message: HarnessMessage<'cleanup.completed'>,
): HarnessMessage<'cleanup.completed'>['payload'] {
  const parsed = cleanupCompletedPayloadSchema.safeParse(message.payload);
  expect(parsed.success).toBe(true);
  if (!parsed.success) {
    throw new Error('The cleanup.completed payload did not match its schema.');
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------------------------------
 * Driving a session through the real pipeline
 * ---------------------------------------------------------------------------------------------- */

/** How {@link driveSession} takes a session. */
interface DriveOptions {
  /**
   * The inspected tab to bind. When given, a DevTools client binds it, the page agent's
   * `agent.ready` is relayed for it, and the session is driven all the way to `ready`.
   */
  readonly tabId?: number | undefined;
  /** Whether to connect the project's dev-server preload (`server-agent`) before the session. */
  readonly serverAgent?: boolean | undefined;
}

/** A session driven through the real pipeline, and every client that watched it. */
interface DrivenSession {
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly devServerUrl: string;
  /** The session record at the status the drive reached. */
  readonly session: SessionRecord;
  /** The records the installer applied, as the journal holds them after `instrumentation.ready`. */
  readonly records: readonly ModificationRecord[];
  /** The `instrumentation.ready` frame the editor received. */
  readonly ready: HarnessMessage<'instrumentation.ready'>;
  readonly editor: HarnessWsClient;
  readonly devtools: HarnessWsClient | undefined;
  readonly serverAgent: HarnessWsClient | undefined;
  /** The project-scoped server-agent credential, when one was issued. */
  readonly serverAgentToken: string | undefined;
}

/**
 * Creates a session over HTTP and lets the deterministic pipeline understand, investigate, plan
 * and install — the real `installPlan` behind `InstrumentationService.install` — then, when a tab
 * is given, binds it and relays the page agent's `agent.ready` so the readiness gate admits
 * `ready`.
 */
async function driveSession(
  h: Harness,
  projectRoot: string,
  question: string,
  options: DriveOptions = {},
): Promise<DrivenSession> {
  const launched = await h.launchDevServer(projectRoot);
  if (isErr(launched)) {
    throw new Error(`The dev server could not be launched: ${launched.error.message}`);
  }
  const { devServerUrl } = launched.value;

  let serverAgent: HarnessWsClient | undefined;
  let serverAgentToken: string | undefined;
  if (options.serverAgent === true) {
    serverAgentToken = h.issueServerAgentCredential(projectRoot).token;
    serverAgent = await h.ws({ client: 'server-agent', projectRoot, token: serverAgentToken });
    expect(serverAgent.authenticated).toBe(true);
  }

  const editor = await h.editor(projectRoot);
  const created = await h.createSession({ projectRoot, question });
  const ready = await waitFor(
    editor,
    'instrumentation.ready',
    (message) => message.payload.sessionId === created.id,
    HARNESS_TIMEOUTS.pipeline,
  );
  let session = await h.waitForSession(
    created.id,
    (record) => record.status === SESSION.instrumenting || record.status === SESSION.ready,
  );
  const records = await journalOf(h, created.id);

  let devtools: HarnessWsClient | undefined;
  if (options.tabId !== undefined) {
    const { tabId } = options;
    devtools = (await h.connectDevtools({ tabId })).client;
    const bound = await h.bindTab(devtools, {
      tabId,
      url: devServerUrl,
      origin: new URL(devServerUrl).origin,
      sessionId: created.id,
    });
    if (isErr(bound)) {
      throw new Error(`The tab could not be bound: ${bound.error.message}`);
    }
    const relayed = devtools.send('agent.ready', {
      tabId,
      documentId: newId('doc'),
      producerId: newProducerId(),
      url: devServerUrl,
      installedBeforeReact: true,
      reactDetected: true,
    });
    if (isErr(relayed.result)) {
      throw new Error(`agent.ready could not be relayed: ${relayed.result.error.message}`);
    }
    session = await h.waitForSession(created.id, (record) => record.status === SESSION.ready);
  }

  return {
    sessionId: created.id,
    projectRoot,
    devServerUrl,
    session,
    records,
    ready,
    editor,
    devtools,
    serverAgent,
    serverAgentToken,
  };
}

/** The session's current record over `GET /sessions/:id`. */
function currentSession(h: Harness, sessionId: string): Promise<SessionRecord> {
  return h.waitForSession(sessionId, () => true);
}

/** Starts a capture over HTTP and returns its id. */
async function startCapture(h: Harness, sessionId: string): Promise<string> {
  const started = await h.startCapture(sessionId);
  if (isErr(started)) {
    throw new Error(`capture.start was refused (${started.error.code}): ${started.error.message}`);
  }
  return started.value.captureId;
}

/** Ends a session over HTTP (`POST /sessions/:id/end`) and returns the reported cleanup status. */
async function endSession(h: Harness, sessionId: string): Promise<string> {
  const ended = await h.endSession(sessionId);
  if (isErr(ended)) {
    throw new Error(`session.end was refused (${ended.error.code}): ${ended.error.message}`);
  }
  return ended.value.cleanup;
}

/**
 * Carries a `ready` session through a real capture to `generated`: the committed cross-tier batch
 * is relayed for the bound tab (browser tier) and posted by the project's server agent (server and
 * database tiers), the capture is stopped, and the deterministic analysis and panel stages run.
 */
async function captureToGenerated(h: Harness, driven: DrivenSession): Promise<SessionRecord> {
  const { devtools, serverAgentToken } = driven;
  if (devtools === undefined || serverAgentToken === undefined) {
    throw new Error('A capture to "generated" needs a bound tab and a server-agent credential.');
  }
  await startCapture(h, driven.sessionId);
  const batch = readTelemetryBatch(CAPTURE_FIXTURE);
  const relayed = await h.ingestFromAgent(
    devtools,
    batch.filter((event) => event.tier === 'browser'),
  );
  expect(relayed.settled).toBe(true);
  expect(relayed.errors).toEqual([]);
  const posted = await h.ingestFromServerAgent({
    token: serverAgentToken,
    projectRoot: driven.projectRoot,
    events: batch.filter((event) => event.tier !== 'browser'),
  });
  expect(isErr(posted)).toBe(false);
  const stopped = await h.stopCapture(driven.sessionId);
  if (isErr(stopped)) {
    throw new Error(`capture.stop was refused (${stopped.error.code}): ${stopped.error.message}`);
  }
  return h.waitForSession(driven.sessionId, (record) => record.status === SESSION.generated);
}

/** What {@link interruptWriteSequence} leaves behind. */
interface InterruptedWrite {
  /** The one record the interrupted sequence journaled, as the journal holds it now. */
  readonly record: ModificationRecord;
  /** The target's inode and modification time right after the interruption. */
  readonly inode: number;
  readonly mtimeMs: number;
}

/**
 * Runs the product's own crash-safe write sequence (`createPatcher`, the patch layer `installPlan`
 * drives) against the service's journal and the session's backup store, and kills it after `stage`
 * through the sequence's failure-injection seam — the only way to produce the `pending`/`failed`
 * rows of the reconciliation table without killing the service mid-install.
 *
 * With `journalDies`, the journal refuses the patcher's closing status write as well, as it would
 * for a process that died on the spot: the record then stays `pending` instead of being marked
 * `failed` by the patcher's own failure handling.
 *
 * The target is the first of {@link CRASH_TARGETS} the session's plan did not already patch, so
 * the sequence starts from the file's original bytes.
 */
async function interruptWriteSequence(
  h: Harness,
  driven: DrivenSession,
  stage: PatchStage,
  journalDies: boolean,
): Promise<InterruptedWrite> {
  const patched = new Set(driven.records.map((record) => record.file));
  const target = CRASH_TARGETS.find((candidate) => !patched.has(candidate.file));
  if (target === undefined) {
    throw new Error('Every crash target is already instrumented by this session.');
  }
  const repo = h.repos.modifications;
  const journal: ModificationJournal = journalDies
    ? {
        append: (record) => repo.append(record),
        updateStatus: () =>
          Promise.resolve(
            err(
              new DebuggenError(
                'STORE_ERROR',
                'The process ended before the journal could record the outcome.',
              ),
            ),
          ),
        listBySession: (sessionId) => repo.listBySession(sessionId),
        listOpen: () => repo.listOpen(),
      }
    : repo;
  const planVersion = driven.records[0]?.planVersion ?? 1;
  const patcher = createPatcher({
    projectRoot: driven.projectRoot,
    sessionId: driven.sessionId,
    planVersion,
    backups: createBackupStore({
      debuggenHome: h.config.debuggenHome,
      sessionId: driven.sessionId,
    }),
    journal,
    onStage: (event) => {
      if (event.stage === stage) {
        throw new Error(`The process ended right after the "${event.stage}" step.`);
      }
    },
  });

  const outcome = await patcher.patchTarget({ file: target.file, symbol: target.symbol });
  expect(isErr(outcome)).toBe(true);
  const journaled = patcher.journaledRecords();
  expect(journaled).toHaveLength(1);
  const record = await journalRecord(h, journaled[0]!.id);
  const facts = await stat(projectFile(driven.projectRoot, record.file));
  return { record, inode: facts.ino, mtimeMs: facts.mtimeMs };
}

/* -------------------------------------------------------------------------------------------------
 * Assertions shared by the scenarios
 * ---------------------------------------------------------------------------------------------- */

/** The records of each file, in append order, keyed by project-relative path. */
function recordsByFile(records: readonly ModificationRecord[]): Map<string, ModificationRecord[]> {
  const byFile = new Map<string, ModificationRecord[]>();
  for (const record of records) {
    byFile.set(record.file, [...(byFile.get(record.file) ?? []), record]);
  }
  return byFile;
}

/** The newest record of a chain: the one no other record of the set is layered on. */
function chainHead(records: readonly ModificationRecord[]): ModificationRecord {
  const head = records.find(
    (record) => !records.some((other) => other.previousRecordId === record.id),
  );
  if (head === undefined) {
    throw new Error('A chain of modification records has no head.');
  }
  return head;
}

/** The oldest record of a chain: the one layered on nothing of the set. */
function chainRoot(records: readonly ModificationRecord[]): ModificationRecord {
  const ids = new Set(records.map((record) => record.id));
  const root = records.find(
    (record) => record.previousRecordId === undefined || !ids.has(record.previousRecordId),
  );
  if (root === undefined) {
    throw new Error('A chain of modification records has no root.');
  }
  return root;
}

/** Asserts that none of the instrumentation markers is left in a file. */
async function expectNoMarkers(root: string, file: string): Promise<void> {
  const text = await readFile(projectFile(root, file), 'utf8');
  for (const marker of INSTRUMENTATION_MARKERS) {
    expect(text).not.toContain(marker);
  }
}

/** Asserts that `root` differs from its pre-session snapshot in exactly `changed`, nothing else. */
async function expectTreeChangedOnly(
  root: string,
  snapshot: TreeSnapshot,
  changed: readonly string[],
): Promise<void> {
  const difference = diffTreeSnapshots(snapshot, await snapshotTree(root));
  expect(difference).toEqual({ added: [], removed: [], changed: [...changed].sort() });
}

/** One edited file of a conflict scenario: its chain-head record and the edit made to it. */
interface EditedFile {
  readonly record: ModificationRecord;
  readonly line: string;
  /** The SHA-256 of the developer's bytes, taken before the session is ended. */
  readonly editedHash: string;
}

/**
 * Ends a session whose `edited` files the developer changed while they were instrumented, and
 * proves AAP §0.5.1's promise for both halves of the session:
 *
 * - every edited file still holds **exactly the developer's bytes** — compared with the hash taken
 *   after the edit, not with the original, because an overwrite with the original would pass a
 *   comparison against the original;
 * - its record stays `conflict` (never `reverted`), its backup stays at
 *   `$DEBUGGEN_HOME/backups/<sessionId>/<originalHash>` holding the original, and
 *   `cleanup.completed` names it with a reason from `MODIFICATION_CONFLICT_REASONS` and the
 *   three-way diff;
 * - every `untouched` record is restored byte for byte and its backup deleted;
 * - the session's verdict is what `aggregateCleanupStatus` maps these counts to.
 *
 * @returns The `cleanup.completed` payload the editor received.
 */
async function endWithConflicts(
  h: Harness,
  project: FixtureProjectCopy,
  driven: DrivenSession,
  edited: readonly EditedFile[],
  untouched: readonly ModificationRecord[],
): Promise<HarnessMessage<'cleanup.completed'>['payload']> {
  const home = h.config.debuggenHome;
  const { editor, devtools } = driven;
  const marks = { editor: editor.received.length, devtools: devtools?.received.length ?? 0 };
  for (const file of edited) {
    expect(await hashOf(project.root, file.record.file)).toBe(file.editedHash);
  }

  const expectedStatus = aggregateCleanupStatus({
    restored: untouched.length,
    conflicts: edited.length,
    skipped: 0,
    failed: 0,
  });
  expect(CLEANUP_STATUSES).toContain(expectedStatus);
  expect(await endSession(h, driven.sessionId)).toBe(expectedStatus);

  // The developer's work, exactly as they left it; the original, exactly where the notice said.
  for (const file of edited) {
    expect(await hashOf(project.root, file.record.file)).toBe(file.editedHash);
    const after = await journalRecord(h, file.record.id);
    expect(after.status).toBe(MODIFICATION.conflict);
    expect(after.status).not.toBe(MODIFICATION.reverted);
    expect(after.backupPath).toBe(expectedBackupPath(home, after));
    expect(await sha256OfFile(after.backupPath)).toBe(after.originalHash);
  }

  // Everything else put back, byte for byte, its backup removed only after that verified.
  for (const record of untouched) {
    const after = await journalRecord(h, record.id);
    expect(after.status).toBe(MODIFICATION.reverted);
    expect(await exists(after.backupPath)).toBe(false);
  }
  for (const [file, records] of recordsByFile(untouched)) {
    expect(await hashOf(project.root, file)).toBe(chainRoot(records).originalHash);
    expect(await hashOf(project.root, file)).toBe(project.snapshot.get(file));
    await expectNoMarkers(project.root, file);
  }
  await expectTreeChangedOnly(
    project.root,
    project.snapshot,
    edited.map((file) => file.record.file),
  );

  // The session's verdict and the one report both user interfaces receive.
  const ended = await currentSession(h, driven.sessionId);
  expect(ended.status).toBe(SESSION.ended);
  expect(ended.cleanup.status).toBe(expectedStatus);
  expect(ended.cleanup.completedAt).toEqual(expect.any(Number));

  const report = await waitFor(
    editor,
    'cleanup.completed',
    (message, index) => index >= marks.editor && message.payload.sessionId === driven.sessionId,
  );
  expect(cleanupReports(editor, driven.sessionId)).toHaveLength(1);
  if (devtools !== undefined) {
    await waitFor(
      devtools,
      'cleanup.completed',
      (message, index) => index >= marks.devtools && message.payload.sessionId === driven.sessionId,
    );
    expect(cleanupReports(devtools, driven.sessionId)).toHaveLength(1);
  }

  const payload = parsedCleanupPayload(report);
  expect(payload.status).toBe(expectedStatus);
  expect(payload.conflicts).toEqual(ended.cleanup.conflicts);
  expect(payload.conflicts.map((conflict) => conflict.recordId).sort()).toEqual(
    edited.map((file) => file.record.id).sort(),
  );
  for (const file of edited) {
    const conflict = payload.conflicts.find(
      (candidate: ModificationConflict) => candidate.recordId === file.record.id,
    );
    expect(conflict).toBeDefined();
    if (conflict === undefined) {
      continue;
    }
    expect(conflict.sessionId).toBe(driven.sessionId);
    expect(conflict.file).toBe(file.record.file);
    expect(MODIFICATION_CONFLICT_REASONS).toContain(conflict.reason);
    expect(conflict.expectedHash).toBe(file.record.instrumentedHash);
    expect(conflict.actualHash).toBe(file.editedHash);
    expect(conflict.backupPath).toBe(file.record.backupPath);
    // The three-way view behind "Open diff": what the tool did, what the developer did on top of
    // it, and the net divergence from the pristine file.
    expect(conflict.diffs?.originalToInstrumented).toContain(SPAN_HELPER_GLOBAL);
    expect(conflict.diffs?.instrumentedToCurrent).toContain(file.line);
    expect(conflict.diffs?.originalToCurrent).toContain(file.line);
    // The sentence the watcher sent while the file was live is the one this report composes to.
    expect(buildConflictMessage(file.record, conflict)).toBe(conflictSentence(file.record));
  }
  return payload;
}

/**
 * Waits for the live watcher to mark `record` as `conflict` after an edit, then keeps listening
 * for {@link QUIET_PERIOD_MS} to prove the burst produced exactly one transition and exactly one
 * AAP §0.5.5 notice per user interface, with its "Open diff" pointer to the record.
 */
async function expectOneConflictNotice(
  h: Harness,
  driven: DrivenSession,
  record: ModificationRecord,
  marks: { readonly editor: number; readonly devtools: number },
): Promise<void> {
  const conflicted = await recordReaches(h, record.id, MODIFICATION.conflict);
  await sleep(QUIET_PERIOD_MS);
  expect(await journalRecord(h, record.id)).toEqual(conflicted);

  const { devtools } = driven;
  if (devtools === undefined) {
    throw new Error('A conflict notice is asserted on both user interfaces; bind a tab first.');
  }
  const clients: readonly (readonly [HarnessWsClient, number])[] = [
    [driven.editor, marks.editor],
    [devtools, marks.devtools],
  ];
  for (const [client, mark] of clients) {
    // Filtered on the exact sentence `buildConflictMessage` composes for this record.
    const rows = conflictRows(client, record, mark);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    // The "Open diff" action: the second line points at the record whose stored diff it opens.
    expect(row?.payload.detail).toContain(record.id);
    expect(row?.payload.detail).toMatch(/open diff/i);
  }
}

/* -------------------------------------------------------------------------------------------------
 * One service lifetime: install, clean end, conflicts
 * ---------------------------------------------------------------------------------------------- */

describe('cleanup-conflict within one service lifetime', () => {
  let harness: Harness;
  let lastTabId = 100;

  /** A tab id no other session of this harness has bound. */
  const nextTabId = (): number => {
    lastTabId += 1;
    return lastTabId;
  };

  beforeAll(async () => {
    harness = await startHarness({ fixtureProject: false });
  });

  afterAll(async () => {
    await harness.assertNoLeaks();
  });

  describe('an install followed by a clean end', () => {
    let project: FixtureProjectCopy;
    let driven: DrivenSession;

    it('installs a patch-mode timing through the real installer and journals it before writing', async () => {
      project = await harness.copyFixtureProject();
      const { root, snapshot } = project;
      driven = await driveSession(harness, root, QUESTIONS.routeLatency, {
        tabId: nextTabId(),
        serverAgent: true,
      });
      const home = harness.config.debuggenHome;
      expect(driven.session.status).toBe(SESSION.ready);

      // The plan the pipeline validated asks for at least one named-symbol timing, patched.
      const plan = driven.session.plans.at(-1);
      expect(plan).toBeDefined();
      const patchActions = (plan?.instrumentationTargets ?? []).filter(
        (action) => action.mode === 'patch' && action.type === 'function-timing',
      );
      expect(patchActions.length).toBeGreaterThan(0);
      expect(driven.records.length).toBeGreaterThan(0);
      expect(new Set(driven.records.map((record) => record.file))).toEqual(
        new Set(patchActions.map((action) => action.file)),
      );

      // `instrumentation.ready` carries exactly what the journal holds, record for record.
      expect(driven.ready.payload.applied.map(parsedRecord)).toEqual(driven.records);

      for (const record of driven.records) {
        expect(record.status).toBe(MODIFICATION.applied);
        expect(record.originalHash).not.toBe(record.instrumentedHash);
        expect(record.diff.length).toBeGreaterThan(0);
        expect(record.diff).toContain(SPAN_HELPER_GLOBAL);
        expect(record.backupPath).toBe(expectedBackupPath(home, record));
        // The original is filed before anything is written: 0600, byte-exact, content-addressed.
        expect(await sha256OfFile(record.backupPath)).toBe(record.originalHash);
        expect((await stat(record.backupPath)).mode & 0o777).toBe(0o600);
      }

      for (const [file, records] of recordsByFile(driven.records)) {
        const head = chainHead(records);
        // The journal knew the post-write digest before the rename: the committed row's
        // `instrumentedHash` is exactly what the file hashes to now (AAP §0.5.1 ordering).
        expect(await hashOf(root, file)).toBe(head.instrumentedHash);
        expect(chainRoot(records).originalHash).toBe(snapshot.get(file));
        const text = await readFile(projectFile(root, file), 'utf8');
        expect(text).toContain(SPAN_HELPER_GLOBAL);
        if (needsHelperTypeAlias(file)) {
          expect(text).toContain(HELPER_TYPE_ALIAS_TEXT);
          expect(text).toContain(SPAN_HELPER_TYPE_NAME);
        }
      }
      expect((await backupEntries(home, driven.sessionId)).sort()).toEqual(
        [...new Set(driven.records.map((record) => record.originalHash))].sort(),
      );

      // The same records over the real route.
      const listed = await harness
        .http()
        .request('modifications.list', { params: { id: driven.sessionId } });
      if (isErr(listed)) {
        throw new Error(`modifications.list was refused: ${listed.error.message}`);
      }
      expect(listed.value.modifications.map(parsedRecord)).toEqual(driven.records);
    });

    it('restores every file byte for byte, disarms both producers and reports once on end', async () => {
      const { editor, devtools, serverAgent } = driven;
      if (devtools === undefined || serverAgent === undefined) {
        throw new Error('The clean-end session needs a bound tab and a server agent.');
      }
      const home = harness.config.debuggenHome;
      const sessionId = driven.sessionId;

      // Arm both producers, so the end has something real to disarm.
      const captureId = await startCapture(harness, sessionId);
      const armedPage = await waitFor(
        devtools,
        'agent.config',
        (message) => message.payload.captureId === captureId,
      );
      expect(Object.values(armedPage.payload.hooks)).toContain(true);
      const armedServer = await waitFor(
        serverAgent,
        'server-agent.config',
        (message) => message.payload.captureId === captureId,
      );
      expect(armedServer.payload.sessionId).toBe(sessionId);

      const marks = {
        editor: editor.received.length,
        devtools: devtools.received.length,
        serverAgent: serverAgent.received.length,
      };
      expect(await endSession(harness, sessionId)).toBe(CLEANUP.clean);

      // Byte-identical to the committed corpus, and no marker anywhere.
      await assertTreeUnchanged(project.root, project.snapshot);
      for (const file of recordsByFile(driven.records).keys()) {
        await expectNoMarkers(project.root, file);
      }
      for (const record of driven.records) {
        const after = await journalRecord(harness, record.id);
        expect(after.status).toBe(MODIFICATION.reverted);
        // Deleted only after the restored bytes verified against `originalHash` — which they do.
        expect(await exists(after.backupPath)).toBe(false);
      }
      expect(await backupEntries(home, sessionId)).toEqual([]);

      // The recorded verdict.
      const ended = await currentSession(harness, sessionId);
      expect(ended.status).toBe(SESSION.ended);
      expect(ended.cleanup.status).toBe(CLEANUP.clean);
      expect(ended.cleanup.completedAt).toEqual(expect.any(Number));
      expect(ended.cleanup.conflicts).toEqual([]);

      // One `cleanup.completed` to each user interface, matching the stored verdict.
      const toEditor = await waitFor(
        editor,
        'cleanup.completed',
        (message, index) => index >= marks.editor && message.payload.sessionId === sessionId,
      );
      const toDevtools = await waitFor(
        devtools,
        'cleanup.completed',
        (message, index) => index >= marks.devtools && message.payload.sessionId === sessionId,
      );
      for (const report of [toEditor, toDevtools]) {
        expect(parsedCleanupPayload(report)).toEqual({
          sessionId,
          status: CLEANUP.clean,
          conflicts: [],
        });
      }

      // The page agent is sent dormant and the preload a capture-less configuration — by the
      // instrumentation service, before any file was restored and before the report went out.
      const disabled = await waitFor(
        serverAgent,
        'server-agent.config',
        (message, index) => index >= marks.serverAgent && message.payload.captureId === undefined,
      );
      expect(disabled.payload).toEqual({ signals: DISABLED_SERVER_AGENT_SIGNALS });

      // Cleanup's own writes are never read as developer edits: listen for several debounce
      // windows, then prove no conflict transition and no conflict notice happened.
      await sleep(QUIET_PERIOD_MS);
      for (const record of driven.records) {
        expect((await journalRecord(harness, record.id)).status).toBe(MODIFICATION.reverted);
        expect(conflictRows(editor, record)).toEqual([]);
        expect(conflictRows(devtools, record)).toEqual([]);
      }

      const dormant = received(devtools, 'agent.config', marks.devtools).filter(
        (message) => message.payload.sessionId === sessionId,
      );
      expect(dormant).toHaveLength(1);
      expect(dormant[0]?.payload).toEqual({
        sessionId,
        captureId,
        hooks: DORMANT_AGENT_HOOK_CONFIG,
      });
      expect(devtools.received.indexOf(dormant[0]!)).toBeLessThan(
        devtools.received.indexOf(toDevtools),
      );
      const capturelessConfigs = received(serverAgent, 'server-agent.config', marks.serverAgent);
      expect(capturelessConfigs).toEqual([disabled]);

      // Exactly one report per user interface, and `session.cleanup` written once: every
      // `session.updated` carrying the verdict carries the same completion stamp.
      expect(cleanupReports(editor, sessionId)).toHaveLength(1);
      expect(cleanupReports(devtools, sessionId)).toHaveLength(1);
      const stamps = new Set(
        received(editor, 'session.updated', marks.editor)
          .filter(
            (message) =>
              message.payload.session.id === sessionId &&
              message.payload.session.cleanup.completedAt !== undefined,
          )
          .map((message) => message.payload.session.cleanup.completedAt),
      );
      expect([...stamps]).toEqual([ended.cleanup.completedAt]);
    });
  });

  describe('a developer edit while instrumented', () => {
    it('reports an in-place save burst once and never overwrites it', async () => {
      const project = await harness.copyFixtureProject();
      const driven = await driveSession(harness, project.root, QUESTIONS.routeLatency, {
        tabId: nextTabId(),
      });
      const byFile = recordsByFile(driven.records);
      const [file, records] = [...byFile.entries()][0]!;
      const record = chainHead(records);
      const untouched = driven.records.filter((candidate) => candidate.file !== file);

      const marks = {
        editor: driven.editor.received.length,
        devtools: driven.devtools?.received.length ?? 0,
      };
      const line = developerLine();
      await editInPlace(projectFile(project.root, file), line);
      await expectOneConflictNotice(harness, driven, record, marks);
      for (const other of untouched) {
        expect((await journalRecord(harness, other.id)).status).toBe(MODIFICATION.applied);
      }

      const editedHash = await hashOf(project.root, file);
      expect(editedHash).not.toBe(record.instrumentedHash);
      expect(editedHash).not.toBe(record.originalHash);
      await endWithConflicts(harness, project, driven, [{ record, line, editedHash }], untouched);
    });

    it('catches an atomic save that renames a temporary file over the target', async () => {
      const project = await harness.copyFixtureProject();
      const driven = await driveSession(harness, project.root, QUESTIONS.routeLatency, {
        tabId: nextTabId(),
      });
      const [file, records] = [...recordsByFile(driven.records).entries()][0]!;
      const record = chainHead(records);
      const untouched = driven.records.filter((candidate) => candidate.file !== file);
      const inodeBefore = (await stat(projectFile(project.root, file))).ino;

      const marks = {
        editor: driven.editor.received.length,
        devtools: driven.devtools?.received.length ?? 0,
      };
      const line = developerLine();
      await editByAtomicRename(projectFile(project.root, file), line);
      // The save really replaced the inode — the case a watch on the file itself goes deaf to.
      expect((await stat(projectFile(project.root, file))).ino).not.toBe(inodeBefore);
      await expectOneConflictNotice(harness, driven, record, marks);

      const editedHash = await hashOf(project.root, file);
      await endWithConflicts(harness, project, driven, [{ record, line, editedHash }], untouched);
    });

    it('restores the untouched file and preserves the edited one in a mixed session', async () => {
      const project = await harness.copyFixtureProject();
      const driven = await driveSession(harness, project.root, QUESTIONS.twoTierLatency, {
        tabId: nextTabId(),
      });
      const byFile = [...recordsByFile(driven.records).entries()].sort(
        ([left, leftRecords], [right, rightRecords]) =>
          leftRecords.length - rightRecords.length || (left < right ? -1 : left > right ? 1 : 0),
      );
      // Two instrumented files: the one edited holds a single record; the other may hold a chain.
      expect(byFile.length).toBeGreaterThanOrEqual(2);
      const [editedFile, editedRecords] = byFile[0]!;
      expect(editedRecords).toHaveLength(1);
      const record = editedRecords[0]!;
      const untouched = driven.records.filter((candidate) => candidate.file !== editedFile);
      expect(untouched.length).toBeGreaterThan(0);

      const marks = {
        editor: driven.editor.received.length,
        devtools: driven.devtools?.received.length ?? 0,
      };
      const line = developerLine();
      await editInPlace(projectFile(project.root, editedFile), line);
      await expectOneConflictNotice(harness, driven, record, marks);
      // The file nobody touched is not mistaken for an edit.
      for (const other of untouched) {
        expect((await journalRecord(harness, other.id)).status).toBe(MODIFICATION.applied);
        expect(conflictRows(driven.editor, other)).toEqual([]);
      }

      const editedHash = await hashOf(project.root, editedFile);
      const payload = await endWithConflicts(
        harness,
        project,
        driven,
        [{ record, line, editedHash }],
        untouched,
      );
      // The mapping `aggregateCleanupStatus` applies to "restored some, one conflict".
      expect(payload.status).toBe(
        aggregateCleanupStatus({ restored: untouched.length, conflicts: 1, skipped: 0, failed: 0 }),
      );
      expect(payload.conflicts).toHaveLength(1);
    });
  });
});

/* -------------------------------------------------------------------------------------------------
 * Across a restart: start-up reconciliation, then retention
 * ---------------------------------------------------------------------------------------------- */

describe('cleanup-conflict across a service restart', () => {
  /**
   * The `$DEBUGGEN_HOME` every lifetime of this block shares. Caller-owned — not the harness's own
   * temporary home, which `Harness.stop()` removes — so the journal, the backups and `auth.json`
   * outlive the service exactly as they outlive a real crash.
   */
  let home: string;
  /** Caller-owned project copies, so `Harness.stop()` leaves them for the next lifetime. */
  const projects: FixtureProjectCopy[] = [];
  /** Every lifetime started, for teardown. */
  const lifetimes: Harness[] = [];
  let lastTabId = 300;

  /** The sessions the first lifetime leaves behind, one per owning status. */
  let capturing: DrivenSession;
  let failed: DrivenSession;
  let generated: DrivenSession;
  let ended: DrivenSession;
  /** Interrupted write sequences: `pending` + original, `failed` + instrumented, `failed` + edited. */
  let pendingUnwritten: InterruptedWrite;
  let failedWritten: InterruptedWrite;
  let failedThenEdited: InterruptedWrite;
  /** The record the live watcher marked `conflict` while the first lifetime was running. */
  let watchedConflict: EditedFile;
  /** Edits the developer made while no service was running. */
  let appliedEditedWhileDown: EditedFile;
  let failedEditedWhileDown: EditedFile;
  /** The journal as the first lifetime left it. */
  let openBefore: ModificationRecord[];
  let revertedBefore: ModificationRecord[];
  /** Where the next lifetime's clock resumes, so every stamp it writes is later than the last. */
  let resumeAt: number;

  const nextTabId = (): number => {
    lastTabId += 1;
    return lastTabId;
  };

  /** A project copy that survives a `Harness.stop()`. */
  const ownedCopy = async (): Promise<FixtureProjectCopy> => {
    const copy = await copyFixtureProject();
    projects.push(copy);
    return copy;
  };

  /** One service lifetime over the shared home, its clock seeded at `seedMs` when given. */
  const startLifetime = async (seedMs?: number): Promise<Harness> => {
    const lifetime = await startHarness({
      env: { DEBUGGEN_HOME: home },
      fixtureProject: false,
      now: seedMs === undefined ? undefined : createHarnessClock(seedMs).now,
    });
    lifetimes.push(lifetime);
    expect(lifetime.config.debuggenHome).toBe(home);
    return lifetime;
  };

  /**
   * Stops a lifetime the way a crash would find it — sessions open, journal untouched — and
   * proves it is gone. A graceful `close()` ends every live session and restores its files, so
   * the service is closed with `liveSessions: 'retain'` first: exactly what a crashed process
   * leaves. The harness's own teardown then awaits that same memoised close.
   */
  const stopLifetime = async (lifetime: Harness): Promise<void> => {
    await lifetime.service.close({ liveSessions: 'retain' });
    expect(await lifetime.stop()).toEqual({ clean: true, problems: [] });
    await lifetime.assertNoLeaks();
  };

  beforeAll(async () => {
    home = await mkdtemp(join(realpathSync(tmpdir()), SHARED_HOME_PREFIX));
  });

  afterAll(async () => {
    for (const lifetime of lifetimes) {
      await lifetime.stop();
    }
    for (const project of projects) {
      await project.dispose();
      expect(await exists(project.container)).toBe(false);
    }
    await rm(home, { recursive: true, force: true });
    expect(await exists(home)).toBe(false);
  });

  it('leaves open records behind in capturing, failed and generated sessions when it stops', async () => {
    const first = await startLifetime();

    // `capturing`: the plan's patch is on disk, a capture is open, and a second write sequence
    // died right after journaling — `pending`, with nothing written.
    const capturingProject = await ownedCopy();
    capturing = await driveSession(first, capturingProject.root, QUESTIONS.routeLatency, {
      tabId: nextTabId(),
    });
    await startCapture(first, capturing.sessionId);
    await first.waitForSession(
      capturing.sessionId,
      (record) => record.status === SESSION.capturing,
    );
    pendingUnwritten = await interruptWriteSequence(first, capturing, 'journal-pending', true);
    expect(pendingUnwritten.record.status).toBe(MODIFICATION.pending);
    expect(await hashOf(capturing.projectRoot, pendingUnwritten.record.file)).toBe(
      pendingUnwritten.record.originalHash,
    );

    // `failed`: a write sequence died right after its rename — `failed`, patched bytes on disk —
    // and the session itself failed at the instrument stage.
    const failedProject = await ownedCopy();
    failed = await driveSession(first, failedProject.root, QUESTIONS.queryLatency);
    failedWritten = await interruptWriteSequence(first, failed, 'replace-file', false);
    expect(failedWritten.record.status).toBe(MODIFICATION.failed);
    expect(await hashOf(failed.projectRoot, failedWritten.record.file)).toBe(
      failedWritten.record.instrumentedHash,
    );
    const failure = await first.manager.fail(failed.sessionId, {
      stage: STAGE.instrument,
      code: 'AGENT_NOT_READY',
      message: 'The page agent never reported for the bound tab, so the capture could not start.',
    });
    if (isErr(failure)) {
      throw new Error(`The session could not be failed: ${failure.error.message}`);
    }
    expect(failure.value.status).toBe(SESSION.failed);

    // `generated`: a real capture analysed into a panel; then the developer edits the patched
    // file while the service is live (the watcher marks it `conflict`), and one more write
    // sequence dies after its rename.
    const generatedProject = await ownedCopy();
    generated = await driveSession(first, generatedProject.root, QUESTIONS.routeLatency, {
      tabId: nextTabId(),
      serverAgent: true,
    });
    expect((await captureToGenerated(first, generated)).status).toBe(SESSION.generated);
    const [watchedFile, watchedRecords] = [...recordsByFile(generated.records).entries()][0]!;
    const watchedRecord = chainHead(watchedRecords);
    const marks = {
      editor: generated.editor.received.length,
      devtools: generated.devtools?.received.length ?? 0,
    };
    const watchedLine = developerLine();
    await editInPlace(projectFile(generated.projectRoot, watchedFile), watchedLine);
    await expectOneConflictNotice(first, generated, watchedRecord, marks);
    watchedConflict = {
      record: await journalRecord(first, watchedRecord.id),
      line: watchedLine,
      editedHash: await hashOf(generated.projectRoot, watchedFile),
    };
    failedThenEdited = await interruptWriteSequence(first, generated, 'replace-file', false);
    expect(failedThenEdited.record.status).toBe(MODIFICATION.failed);

    // `ended`: the control — cleaned up while the service ran, so every record is `reverted`.
    const endedProject = await ownedCopy();
    ended = await driveSession(first, endedProject.root, QUESTIONS.routeLatency);
    expect(await endSession(first, ended.sessionId)).toBe(CLEANUP.clean);
    revertedBefore = await journalOf(first, ended.sessionId);
    expect(revertedBefore.map((record) => record.status)).toEqual(
      revertedBefore.map(() => MODIFICATION.reverted),
    );

    // The reconciliation set, as the journal will hand it to the next start.
    openBefore = await allOpenRecords(first);
    for (const record of openBefore) {
      expect(OPEN_MODIFICATION_STATUSES).toContain(record.status);
    }
    expect(OPEN_MODIFICATION_STATUSES).not.toContain(MODIFICATION.reverted);
    expect(new Set(openBefore.map((record) => record.sessionId))).toEqual(
      new Set([capturing.sessionId, failed.sessionId, generated.sessionId]),
    );
    expect(storedSession(first, capturing.sessionId)?.status).toBe(SESSION.capturing);
    expect(storedSession(first, failed.sessionId)?.status).toBe(SESSION.failed);
    expect(storedSession(first, generated.sessionId)?.status).toBe(SESSION.generated);

    // The service goes away without ending anything, as a crash or a killed process would.
    resumeAt = first.now() + 60_000;
    await stopLifetime(first);

    // While no service runs, the developer keeps working.
    const [appliedFile, appliedRecords] = [...recordsByFile(failed.records).entries()][0]!;
    const appliedLine = developerLine();
    await editInPlace(projectFile(failed.projectRoot, appliedFile), appliedLine);
    appliedEditedWhileDown = {
      record: chainHead(appliedRecords),
      line: appliedLine,
      editedHash: await hashOf(failed.projectRoot, appliedFile),
    };
    const failedLine = developerLine();
    await editInPlace(projectFile(generated.projectRoot, failedThenEdited.record.file), failedLine);
    failedEditedWhileDown = {
      record: failedThenEdited.record,
      line: failedLine,
      editedHash: await hashOf(generated.projectRoot, failedThenEdited.record.file),
    };
  });

  it('reconciles every open record from listAllOpen on the next start, whatever its session’s status', async () => {
    const second = await startLifetime(resumeAt);
    const report = second.service.startup.reconciliation;

    // Driven by `listAllOpen()`: every open record of every session, and nothing else — the
    // `reverted` control is not even looked at.
    expect(report.scanned).toBe(openBefore.length);
    expect(Object.keys(report.bySession).sort()).toEqual(
      [...new Set(openBefore.map((record) => record.sessionId))].sort(),
    );
    expect(Object.keys(report.bySession)).not.toContain(ended.sessionId);
    expect(report.aborted).toBe(false);
    expect(report.errors).toEqual([]);

    // pending, hashing to `originalHash` → closed with nothing written: same bytes, same inode,
    // same modification time.
    const closed = await journalRecord(second, pendingUnwritten.record.id);
    expect(closed.status).toBe(MODIFICATION.reverted);
    expect(await hashOf(capturing.projectRoot, closed.file)).toBe(closed.originalHash);
    const closedFacts = await stat(projectFile(capturing.projectRoot, closed.file));
    expect(closedFacts.ino).toBe(pendingUnwritten.inode);
    expect(closedFacts.mtimeMs).toBe(pendingUnwritten.mtimeMs);

    // applied, hashing to `instrumentedHash` → restored from the backup, which is then deleted.
    for (const record of capturing.records) {
      const restored = await journalRecord(second, record.id);
      expect(restored.status).toBe(MODIFICATION.reverted);
      expect(await exists(restored.backupPath)).toBe(false);
    }
    for (const [file, records] of recordsByFile(capturing.records)) {
      expect(await hashOf(capturing.projectRoot, file)).toBe(chainRoot(records).originalHash);
      await expectNoMarkers(capturing.projectRoot, file);
    }

    // failed, hashing to `instrumentedHash` → restored from the backup.
    const restoredCrash = await journalRecord(second, failedWritten.record.id);
    expect(restoredCrash.status).toBe(MODIFICATION.reverted);
    expect(await hashOf(failed.projectRoot, restoredCrash.file)).toBe(restoredCrash.originalHash);
    expect(await exists(restoredCrash.backupPath)).toBe(false);
    await expectNoMarkers(failed.projectRoot, restoredCrash.file);

    // applied or failed, hashing to anything else → conflict: the developer's bytes stay, the
    // original stays in the backup.
    const divergent: readonly (readonly [EditedFile, string])[] = [
      [appliedEditedWhileDown, failed.projectRoot],
      [failedEditedWhileDown, generated.projectRoot],
    ];
    for (const [edit, root] of divergent) {
      const after = await journalRecord(second, edit.record.id);
      expect(after.status).toBe(MODIFICATION.conflict);
      expect(await hashOf(root, after.file)).toBe(edit.editedHash);
      expect(await sha256OfFile(after.backupPath)).toBe(after.originalHash);
    }

    // conflict → retained, its backup kept, and re-reported.
    const retained = await journalRecord(second, watchedConflict.record.id);
    expect(retained.status).toBe(MODIFICATION.conflict);
    expect(await hashOf(generated.projectRoot, retained.file)).toBe(watchedConflict.editedHash);
    expect(await sha256OfFile(retained.backupPath)).toBe(retained.originalHash);

    // reverted → untouched: the rows are exactly as the first lifetime left them.
    expect(await journalOf(second, ended.sessionId)).toEqual(revertedBefore);
    for (const [file, records] of recordsByFile(revertedBefore)) {
      expect(await hashOf(ended.projectRoot, file)).toBe(chainRoot(records).originalHash);
    }

    // Per session, the counts and the verdict `aggregateCleanupStatus` maps them to.
    const summaries = report.bySession;
    expect(summaries[capturing.sessionId]).toMatchObject({
      restored: capturing.records.length,
      closed: 1,
      conflicts: 0,
      status: aggregateCleanupStatus({
        restored: capturing.records.length + 1,
        conflicts: 0,
        skipped: 0,
        failed: 0,
      }),
    });
    expect(summaries[failed.sessionId]).toMatchObject({
      restored: 1,
      closed: 0,
      conflicts: 1,
      status: aggregateCleanupStatus({ restored: 1, conflicts: 1, skipped: 0, failed: 0 }),
    });
    expect(summaries[generated.sessionId]).toMatchObject({
      restored: 0,
      closed: 0,
      conflicts: 2,
      status: aggregateCleanupStatus({ restored: 0, conflicts: 2, skipped: 0, failed: 0 }),
    });
    expect(report.status).toBe(CLEANUP.conflict);

    // Reconciliation never touches a session's status; it records each verdict on the session.
    // The start's second half then settles the sessions the crash interrupted: a capture whose
    // patches were just removed cannot continue, so its session is failed at `instrument` rather
    // than left claiming a capture it can no longer make; every other status is left alone. Its
    // files are restored, but the producers the crashed process armed for that capture may still
    // hold it and none has reconnected yet, so its cleanup is held at `partial`, not `clean`.
    const afterCapturing = storedSession(second, capturing.sessionId);
    expect(afterCapturing?.status).toBe(SESSION.failed);
    expect(afterCapturing?.cleanup.status).toBe(CLEANUP.partial);
    expect(afterCapturing?.cleanup.conflicts).toEqual([]);
    expect(second.service.startup.interruptedSessions).toMatchObject({
      examined: 1,
      failed: [
        {
          sessionId: capturing.sessionId,
          status: SESSION.capturing,
          reason: 'instrumentation-removed',
        },
      ],
      errors: [],
      aborted: false,
    });

    const afterFailed = storedSession(second, failed.sessionId);
    expect(afterFailed?.status).toBe(SESSION.failed);
    expect(afterFailed?.cleanup.status).toBe(CLEANUP.conflict);
    expect(afterFailed?.cleanup.conflicts.map((conflict) => conflict.recordId)).toEqual([
      appliedEditedWhileDown.record.id,
    ]);

    const afterGenerated = storedSession(second, generated.sessionId);
    expect(afterGenerated?.status).toBe(SESSION.generated);
    expect(afterGenerated?.cleanup.status).toBe(CLEANUP.conflict);
    expect(afterGenerated?.cleanup.conflicts.map((conflict) => conflict.recordId).sort()).toEqual(
      [watchedConflict.record.id, failedEditedWhileDown.record.id].sort(),
    );
    for (const conflict of [
      ...(afterFailed?.cleanup.conflicts ?? []),
      ...(afterGenerated?.cleanup.conflicts ?? []),
    ]) {
      expect(MODIFICATION_CONFLICT_REASONS).toContain(conflict.reason);
    }

    expect(storedSession(second, ended.sessionId)?.status).toBe(SESSION.ended);

    resumeAt = second.now() + (second.config.retentionDays + 1) * DAY_MS;
    await stopLifetime(second);
  });

  it('keeps conflicted sessions through a retention sweep that removes the settled rest, the capture a restart failed included', async () => {
    // A start after the retention window: every session here has aged out.
    const third = await startLifetime(resumeAt);
    const conflicts = [watchedConflict, appliedEditedWhileDown, failedEditedWhileDown];

    // Reconciliation ran first and found only the three unresolved conflicts, which it re-reports
    // and leaves exactly as they are.
    const reconciliation = third.service.startup.reconciliation;
    expect(reconciliation.scanned).toBe(conflicts.length);
    expect(reconciliation.conflicts).toBe(conflicts.length);
    expect(reconciliation.restored).toBe(0);
    expect(reconciliation.closed).toBe(0);
    expect(reconciliation.status).toBe(CLEANUP.conflict);

    // Retention then swept the settled sessions and kept the two that still hold a conflict. The
    // session that was capturing when the first lifetime stopped is settled too: a capture never
    // resumes across a restart, so the second start failed it at `instrument`, its window closed
    // and every record of it restored — a resting session that ages out like any other. Nothing is
    // retained as active: at start-up no session is in a pipeline stage or holds an open window
    // (an in-flight session is retained however old it is; `../../src/store/retention.test.ts`).
    const retention = third.service.startup.retention;
    expect(retention).toBeDefined();
    expect([...(retention?.sessionIdsDeleted ?? [])].sort()).toEqual(
      [capturing.sessionId, ended.sessionId].sort(),
    );
    expect([...(retention?.sessionsRetainedForConflicts ?? [])].sort()).toEqual(
      [failed.sessionId, generated.sessionId].sort(),
    );
    expect(retention?.sessionsRetainedActive).toEqual([]);
    expect(storedSession(third, capturing.sessionId)).toBeUndefined();
    expect(storedSession(third, ended.sessionId)).toBeUndefined();
    expect(storedSession(third, failed.sessionId)?.cleanup.status).toBe(CLEANUP.conflict);
    expect(storedSession(third, generated.sessionId)?.cleanup.status).toBe(CLEANUP.conflict);

    // Every unresolved conflict keeps its record, its developer bytes and its original.
    const roots = new Map([
      [failed.sessionId, failed.projectRoot],
      [generated.sessionId, generated.projectRoot],
    ]);
    for (const edit of conflicts) {
      const record = await journalRecord(third, edit.record.id);
      expect(record.status).toBe(MODIFICATION.conflict);
      expect(record.backupPath).toBe(expectedBackupPath(home, record));
      expect(await sha256OfFile(record.backupPath)).toBe(record.originalHash);
      expect(await hashOf(roots.get(record.sessionId) ?? '', record.file)).toBe(edit.editedHash);
    }
    // The purged sessions' backup directories went with their rows.
    expect(await backupEntries(home, capturing.sessionId)).toEqual([]);
    expect(await backupEntries(home, ended.sessionId)).toEqual([]);

    await stopLifetime(third);
  });
});
