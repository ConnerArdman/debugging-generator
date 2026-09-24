/**
 * Tests for `./watcher.ts`: the live conflict detector that watches every file
 * the installer patched and moves a modification record from `applied` to
 * `conflict` the moment the developer's bytes diverge from what the tool wrote.
 *
 * What is on trial, and why it matters:
 *
 * - **Detection is exact and raw-byte** (AAP §0.5.1). Any digest other than the
 *   chain head's `instrumentedHash` is a conflict — a trailing newline, an
 *   LF → CRLF conversion, a deletion, a symbolic link planted at the path, even
 *   the developer restoring the original bytes by hand — while rewriting the
 *   identical bytes is not.
 * - **The notice is the AAP §0.5.5 sentence**, with its "Open diff" action, and
 *   carries no file content, no diff text and no digest beyond the backup
 *   path's own file name.
 * - **Atomic saves stay visible.** Editors write a temporary file and rename it
 *   over the target; the watch must survive that, which is why the module
 *   watches directories. The rename regression below fails for a file watch.
 * - **Chain heads and the self-write bracket.** A follow-up delta install
 *   rewrites an instrumented file; suspended, refreshed and resumed around it,
 *   that write is never reported, while a real edit afterwards still is.
 * - **Degradation is data.** A path escaping the project, a symbolic link on
 *   the way to it, a refused or lost watch, a vanished directory and a lost
 *   `updateStatus` race are recorded or absorbed — never thrown, never retried,
 *   never announced twice.
 * - **The module writes nothing.** Its one permitted mutation is a single
 *   journal transition; the headline assertion snapshots every byte of the
 *   sandbox project and `$DEBUGGEN_HOME` around a full scenario, and a scan of
 *   the module's code refuses any write API.
 *
 * Every test runs in its own `mkdtemp` sandbox under the OS temporary
 * directory with a real `BackupStore`, an in-memory journal, recording
 * progress, listener and logger doubles, an injected clock and a 20 ms
 * debounce. `fs.watch` events are genuinely asynchronous, so positives are
 * awaited with `vi.waitFor`, and every "nothing happened" assertion is taken
 * after a bounded quiet period — preceded, where one exists, by a positive
 * signal proving the watch was live. The vocabulary is invented and generic.
 *
 * @module
 */

import { readFileSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MODIFICATION_CONFLICT_REASONS,
  createBackupStore,
  createModificationRecord,
  parseModificationConflict,
  type BackupStore,
  type ModificationJournal,
  type ModificationRecord,
  type ModificationStatus,
  type ModificationStatusPatch,
} from '@debuggen/instrumentation';
import {
  MESSAGE_TYPES,
  sessionProgressPayloadSchema,
  type SessionProgressPayload,
} from '@debuggen/protocol';
import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  err,
  isErr,
  ok,
  type LogFields,
  type Logger,
} from '@debuggen/shared';
import { sha256Hex, sha256OfFile } from '@debuggen/shared/node';

import type { SessionProgress } from '../sessions/progress.js';
import {
  canTransitionModificationStatus,
  type ModificationsRepo,
} from '../store/modifications-repo.js';
import {
  DEFAULT_CONFLICT_DEBOUNCE_MS,
  buildConflictMessage,
  createInstrumentationWatcher,
  type InstrumentationWatcher,
  type InstrumentationWatcherDeps,
  type ModificationConflictListener,
  type WatchHandleLike,
  type WatchLike,
  type WatcherModifications,
} from './watcher.js';

// ---------------------------------------------------------------------------
// Fixtures: identities, clock, timing
// ---------------------------------------------------------------------------

const SESSION_ID = 'ses_watchersuite0001';
const OTHER_SESSION_ID = 'ses_watchersuite0002';

/** The injected epoch-millisecond clock every report must be stamped with. */
const NOW = 1_800_000_000_000;
const clock = (): number => NOW;

/** The injected debounce: small, so the suite stays fast. */
const DEBOUNCE_MS = 20;

/** How long a positive is awaited before the test fails. */
const WAIT = Object.freeze({ timeout: 4_000, interval: 10 });

/** The bounded quiet period behind every "nothing happened" assertion: many debounces long. */
const QUIET_MS = 100;

/** The debug record every evaluation that finds the instrumented bytes intact emits. */
const EVALUATED_UNCHANGED = 'an instrumented file still holds the instrumented content';

/** The AAP §0.5.5 sentence, with the two values it names captured. */
const CONFLICT_SENTENCE =
  /^(.+) was edited while instrumented\. Debug Generator will not overwrite it\. Original saved at (.+)\.$/;

/** A SHA-256 digest anywhere in a string. */
const DIGEST_PATTERN = /[0-9a-f]{64}/;

// ---------------------------------------------------------------------------
// Fixtures: the sandbox project's files (invented vocabulary)
// ---------------------------------------------------------------------------

const LEDGER_FILE = 'src/ledger/orchard-ledger.ts';
const TALLY_FILE = 'src/ledger/lantern-tally.ts';
const NOTES_FILE = 'src/ledger/notes.md';
const SPROUT_FILE = 'lib/meadow/sprout-gauge.ts';

const LEDGER_ORIGINAL = [
  'export interface OrchardRow {',
  '  readonly label: string;',
  '  readonly crates: number;',
  '}',
  '',
  'export function sumOrchardCrates(rows: readonly OrchardRow[]): number {',
  '  return rows.reduce((total, row) => total + row.crates, 0);',
  '}',
  '',
].join('\n');

const TALLY_ORIGINAL = [
  'export function tallyLanterns(lit: number, unlit: number): number {',
  '  return lit + unlit;',
  '}',
  '',
].join('\n');

const SPROUT_ORIGINAL = [
  'export function gaugeSprouts(heights: readonly number[]): number {',
  '  return Math.max(0, ...heights);',
  '}',
  '',
].join('\n');

/** The line the "installer" appends; distinctive, so a leak of file content is detectable. */
const PROBE_LINE = "export const timingProbeLabel = 'orchard-probe-7c1';";

/** A second, later instrumentation layer, for the follow-up chain cases. */
const DELTA_LINE = "export const deltaProbeLabel = 'orchard-delta-3b9';";

/** A developer's edit; distinctive, so a leak of the edit is detectable. */
const DEVELOPER_LINE = '// developer note: recheck the crate rounding before release';

/** The instrumented form of `original`: the original with one line appended. */
function instrumentedOf(original: string, line: string = PROBE_LINE): string {
  return `${original}${line}\n`;
}

/**
 * A real unified diff for an append-only change, the shape the patcher
 * journals: every original line as context, then the appended lines.
 */
function appendDiff(file: string, original: string, instrumented: string): string {
  if (!instrumented.startsWith(original) || !original.endsWith('\n')) {
    throw new Error('appendDiff expects an append-only change over newline-terminated text');
  }

  const kept = original.slice(0, -1).split('\n');
  const added = instrumented.slice(original.length, -1).split('\n');
  const header = [
    `--- ${file}`,
    `+++ ${file}`,
    `@@ -1,${kept.length} +1,${kept.length + added.length} @@`,
  ];

  return `${[...header, ...kept.map((line) => ` ${line}`), ...added.map((line) => `+${line}`)].join('\n')}\n`;
}

/**
 * A secret-shaped value, assembled at run time so this tracked file contains no
 * contiguous credential for `pnpm check:secrets` to find.
 */
const PLANTED_SECRET = ['s', 'k-ant-', 'Zq9'.repeat(8), 'Wv'].join('');

// ---------------------------------------------------------------------------
// Harness: the sandbox
// ---------------------------------------------------------------------------

interface Sandbox {
  /** The `mkdtemp` directory everything lives in. */
  readonly root: string;
  /** The fake project root the watcher resolves records against. */
  readonly projectRoot: string;
  /** The temporary `$DEBUGGEN_HOME`, mode 0700, holding the backup tree. */
  readonly debuggenHome: string;
  /** A directory beside the project, for the escaping-path cases. */
  readonly outside: string;
}

async function createSandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'debuggen-watcher-'));
  const projectRoot = join(root, 'project');
  const debuggenHome = join(root, 'home');
  const outside = join(root, 'outside');

  await mkdir(join(projectRoot, 'src', 'ledger'), { recursive: true });
  await mkdir(debuggenHome, { mode: 0o700 });
  await chmod(debuggenHome, 0o700);
  await mkdir(outside);
  await writeFile(
    join(projectRoot, NOTES_FILE),
    '# Ledger notes\n\nNothing here is instrumented.\n',
  );
  await writeFile(join(outside, 'stray.ts'), 'export const strayValue = 1;\n');

  return { root, projectRoot, debuggenHome, outside };
}

// ---------------------------------------------------------------------------
// Harness: the in-memory journal
// ---------------------------------------------------------------------------

/** One `updateStatus` call as the journal received it, with its guard and outcome. */
interface UpdateStatusCall {
  readonly id: string;
  readonly status: ModificationStatus;
  /** The optional patch — the only guard the port offers beyond the transition table. */
  readonly patch: ModificationStatusPatch | undefined;
  /** The status the record carried when the call arrived. */
  readonly from: ModificationStatus | undefined;
  readonly outcome: 'ok' | 'err';
}

/** A read the suite can hold open, to land a suspend or a stop mid-evaluation. */
interface HeldReads {
  /** Settles once a held read has been requested. */
  readonly reached: Promise<void>;
  /** Lets every held read (and every later one) answer. */
  release(): void;
}

/**
 * The `ModificationJournal` port plus the `ModificationsRepo` queries the
 * watcher reads, over a `Map`. Same semantics as the store on every point the
 * watcher depends on: append order, `statuses` narrowing, chain heads that
 * skip `reverted` layers, the transition table, and `Result`s instead of
 * throws. Returned records are copies.
 */
interface JournalDouble extends ModificationJournal {
  listBySession: ModificationsRepo['listBySession'];
  listByFile: ModificationsRepo['listByFile'];
  latestRecordForFile: ModificationsRepo['latestRecordForFile'];
  get: ModificationsRepo['get'];
  updateStatus: ModificationsRepo['updateStatus'];
  /** Every `updateStatus` call, in order. */
  readonly updateCalls: UpdateStatusCall[];
  /** Per-method read counts. */
  readonly reads: { listBySession: number; latestRecordForFile: number; get: number };
  /** Another writer moves a record (cleanup, a rollback) — never the watcher. */
  setStatus(id: string, status: ModificationStatus): void;
  /** The next `updateStatus` loses a race: the record moves to `status` first. */
  loseNextUpdateTo(status: ModificationStatus): void;
  /** Holds every `latestRecordForFile` read until released. */
  holdLatestReads(): HeldReads;
  /** The record as stored now. */
  current(id: string): ModificationRecord | undefined;
}

function createJournal(): JournalDouble {
  const records = new Map<string, ModificationRecord>();
  const updateCalls: UpdateStatusCall[] = [];
  const reads = { listBySession: 0, latestRecordForFile: 0, get: 0 };
  let pendingRace: ModificationStatus | undefined;
  let gate: Promise<void> | undefined;
  let signalReached: (() => void) | undefined;

  const copy = (record: ModificationRecord): ModificationRecord => ({ ...record });
  const all = (): ModificationRecord[] => [...records.values()];

  function headOf(sessionId: string, file: string): ModificationRecord | undefined {
    const forFile = all().filter(
      (record) => record.sessionId === sessionId && record.file === file,
    );
    const live = forFile.filter((record) => record.status !== 'reverted');
    const pool = live.length > 0 ? live : forFile;
    const parents = new Set(pool.map((record) => record.previousRecordId));
    const heads = pool.filter((record) => !parents.has(record.id));

    return heads.at(-1) ?? pool.at(-1);
  }

  const journal: JournalDouble = {
    updateCalls,
    reads,

    append(record) {
      if (records.has(record.id)) {
        return Promise.resolve(err(new DebuggenError('STORE_ERROR', 'Duplicate modification id.')));
      }

      records.set(record.id, copy(record));

      return Promise.resolve(ok(copy(record)));
    },

    updateStatus(id, status, patch) {
      const stored = records.get(id);
      const race = pendingRace;
      pendingRace = undefined;

      if (stored !== undefined && race !== undefined) {
        records.set(id, { ...stored, status: race });
        updateCalls.push({ id, status, patch, from: stored.status, outcome: 'err' });

        return Promise.resolve(
          err(
            new DebuggenError('STORE_ERROR', 'The record moved before this write; re-read it.', {
              details: { reason: 'status-moved' },
            }),
          ),
        );
      }

      if (stored === undefined || !canTransitionModificationStatus(stored.status, status)) {
        updateCalls.push({ id, status, patch, from: stored?.status, outcome: 'err' });

        return Promise.resolve(err(new DebuggenError('STORE_ERROR', 'Refused status write.')));
      }

      const next: ModificationRecord = { ...stored, ...(patch ?? {}), status };
      records.set(id, next);
      updateCalls.push({ id, status, patch, from: stored.status, outcome: 'ok' });

      return Promise.resolve(ok(copy(next)));
    },

    listBySession(sessionId, options) {
      reads.listBySession += 1;
      const statuses = options?.statuses;
      const listed = all().filter(
        (record) =>
          record.sessionId === sessionId &&
          (statuses === undefined || statuses.includes(record.status)),
      );

      return Promise.resolve(ok(listed.map(copy)));
    },

    listOpen() {
      return Promise.resolve(
        ok(
          all()
            .filter((record) => record.status !== 'reverted')
            .map(copy),
        ),
      );
    },

    listByFile(sessionId, file) {
      return Promise.resolve(
        ok(
          all()
            .filter((r) => r.sessionId === sessionId && r.file === file)
            .map(copy),
        ),
      );
    },

    async latestRecordForFile(sessionId, file) {
      reads.latestRecordForFile += 1;

      if (gate !== undefined) {
        signalReached?.();
        await gate;
      }

      const head = headOf(sessionId, file);

      return ok(head === undefined ? undefined : copy(head));
    },

    get(id) {
      reads.get += 1;
      const stored = records.get(id);

      return Promise.resolve(ok(stored === undefined ? undefined : copy(stored)));
    },

    setStatus(id, status) {
      const stored = records.get(id);

      if (stored === undefined) {
        throw new Error(`no record ${id}`);
      }

      records.set(id, { ...stored, status });
    },

    loseNextUpdateTo(status) {
      pendingRace = status;
    },

    holdLatestReads() {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        signalReached = resolve;
      });

      return {
        reached,
        release() {
          gate = undefined;
          release();
        },
      };
    },

    current(id) {
      const stored = records.get(id);

      return stored === undefined ? undefined : copy(stored);
    },
  };

  return journal;
}

// ---------------------------------------------------------------------------
// Harness: progress, listener, logger and watch doubles
// ---------------------------------------------------------------------------

interface ProgressDouble {
  readonly progress: Pick<SessionProgress, 'emit'>;
  /** Every row the protocol schema accepted, addressed. */
  readonly emitted: SessionProgressPayload[];
  /** Rows the protocol schema refused — always expected to stay empty. */
  readonly refused: unknown[];
}

/** Validates each row against protocol's own `session.progress` schema, as the real emitter does. */
function createProgress(): ProgressDouble {
  const emitted: SessionProgressPayload[] = [];
  const refused: unknown[] = [];

  return {
    emitted,
    refused,
    progress: {
      emit(sessionId, row) {
        const parsed = sessionProgressPayloadSchema.safeParse({ sessionId, ...row });

        if (!parsed.success) {
          refused.push({ sessionId, ...row });

          return err(new DebuggenError('PROTOCOL_INVALID_MESSAGE', 'Progress row refused.'));
        }

        emitted.push(parsed.data);

        return ok(parsed.data);
      },
    },
  };
}

type ConflictInput = Parameters<ModificationConflictListener['onModificationConflict']>[0];

interface ListenerDouble {
  readonly listener: ModificationConflictListener;
  readonly calls: ConflictInput[];
}

function createListener(behaviour: 'record' | 'throw' | 'reject' = 'record'): ListenerDouble {
  const calls: ConflictInput[] = [];

  return {
    calls,
    listener: {
      onModificationConflict(input) {
        calls.push(input);

        if (behaviour === 'throw') {
          throw new Error('listener exploded');
        }

        if (behaviour === 'reject') {
          return Promise.reject(new Error('listener rejected'));
        }

        return undefined;
      },
    },
  };
}

interface CapturedLog {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields;
}

/** A `Logger` at `trace` that captures every record, bindings merged, into one array. */
function createRecordingLogger(records: CapturedLog[], bindings: LogFields = {}): Logger {
  const write =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      records.push({ level, message, fields: { ...bindings, ...(fields ?? {}) } });
    };

  return {
    level: 'trace',
    trace: write('trace'),
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    fatal: write('fatal'),
    child: (extra) => createRecordingLogger(records, { ...bindings, ...extra }),
  };
}

interface WatchProbe {
  /** A `WatchLike` over the real `fs.watch`, counting what it opens and closes. */
  readonly watch: WatchLike;
  /** Every watch opened, with the options it was opened with. */
  readonly opened: {
    readonly path: string;
    readonly persistent: boolean;
    readonly recursive: boolean;
  }[];
  /** The underlying `fs.watch` handles, in opening order, for the watch-lost case. */
  readonly handles: FSWatcher[];
  /** Handles opened and not yet closed. */
  openCount(): number;
}

function createWatchProbe(): WatchProbe {
  const opened: WatchProbe['opened'] = [];
  const handles: FSWatcher[] = [];
  let open = 0;

  const watch: WatchLike = (path, options, listener) => {
    const inner = fsWatch(
      path,
      { persistent: options.persistent, recursive: options.recursive },
      listener,
    );
    opened.push({ path, persistent: options.persistent, recursive: options.recursive });
    handles.push(inner);
    open += 1;
    let closed = false;

    const handle: WatchHandleLike = {
      close() {
        if (!closed) {
          closed = true;
          open -= 1;
        }

        inner.close();
      },
      on(event, errorListener) {
        inner.on(event, errorListener);

        return handle;
      },
    };

    return handle;
  };

  return { watch, opened, handles, openCount: () => open };
}

// ---------------------------------------------------------------------------
// Harness: one watcher over one sandbox
// ---------------------------------------------------------------------------

interface Harness {
  readonly sandbox: Sandbox;
  readonly journal: JournalDouble;
  readonly progress: ProgressDouble;
  readonly listener: ListenerDouble;
  readonly logs: CapturedLog[];
  readonly probe: WatchProbe;
  readonly watcher: InstrumentationWatcher;
  /** The real backup store of one session under the sandbox `$DEBUGGEN_HOME`. */
  storeFor(sessionId: string): BackupStore;
  /** A project file's absolute path. */
  pathOf(file: string): string;
}

interface HarnessOptions {
  /** Use the production `fs.watch` instead of the counting probe. */
  readonly productionWatch?: boolean;
  readonly listenerBehaviour?: 'record' | 'throw' | 'reject';
  /** Replace the progress emitter (the failure-isolation case). */
  readonly progress?: Pick<SessionProgress, 'emit'>;
  /** Share a sandbox and journal with another harness (the two-watcher case). */
  readonly sandbox?: Sandbox;
  readonly journal?: JournalDouble;
  /** Override the injected debounce (the fallback-to-default case). */
  readonly debounceMs?: number;
  /** Replace the directory-watch primitive (the platform-refusal case). */
  readonly watch?: WatchLike;
}

/** Cleanups registered by the current test, run in reverse by `afterEach`. */
let cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  cleanups = [];
});

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }

  cleanups = [];
});

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const sandbox = options.sandbox ?? (await createSandbox());

  if (options.sandbox === undefined) {
    cleanups.push(() => rm(sandbox.root, { recursive: true, force: true }));
  }

  const journal = options.journal ?? createJournal();
  const progress = createProgress();
  const listener = createListener(options.listenerBehaviour);
  const logs: CapturedLog[] = [];
  const probe = createWatchProbe();
  const stores = new Map<string, BackupStore>();

  const modifications: WatcherModifications = journal;
  const deps: InstrumentationWatcherDeps = {
    modifications,
    progress: options.progress ?? progress.progress,
    listener: listener.listener,
    config: { debuggenHome: sandbox.debuggenHome },
    logger: createRecordingLogger(logs),
    now: clock,
    debounceMs: options.debounceMs ?? DEBOUNCE_MS,
    ...(options.watch !== undefined
      ? { watch: options.watch }
      : options.productionWatch === true
        ? {}
        : { watch: probe.watch }),
  };
  const watcher = createInstrumentationWatcher(deps);

  cleanups.push(() => watcher.dispose());

  return {
    sandbox,
    journal,
    progress,
    listener,
    logs,
    probe,
    watcher,
    storeFor(sessionId) {
      let store = stores.get(sessionId);

      if (store === undefined) {
        store = createBackupStore({ debuggenHome: sandbox.debuggenHome, sessionId });
        stores.set(sessionId, store);
      }

      return store;
    },
    pathOf: (file) => join(sandbox.projectRoot, file),
  };
}

interface InstrumentInput {
  readonly file: string;
  readonly original: string;
  readonly instrumented: string;
  readonly sessionId?: string;
  readonly planVersion?: number;
  /** The record this one layers on, for a follow-up chain. */
  readonly previous?: ModificationRecord;
}

/**
 * Does what the patcher does, minus the patching: writes the instrumented
 * bytes, files the original bytes in the real backup store, and journals an
 * `applied` record whose two digests are the real SHA-256 of those bytes.
 */
async function instrument(harness: Harness, input: InstrumentInput): Promise<ModificationRecord> {
  const sessionId = input.sessionId ?? SESSION_ID;
  const absolute = harness.pathOf(input.file);

  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, input.instrumented);

  const originalBytes = Buffer.from(input.original, 'utf8');
  const originalHash = sha256Hex(originalBytes);
  const stored = await harness.storeFor(sessionId).put(originalHash, originalBytes);

  if (isErr(stored)) {
    throw stored.error;
  }

  const instrumentedHash = await sha256OfFile(absolute);
  expect(instrumentedHash).toBe(sha256Hex(input.instrumented));

  if (input.previous !== undefined) {
    expect(originalHash).toBe(input.previous.instrumentedHash);
  }

  const created = createModificationRecord(
    {
      sessionId,
      planVersion: input.planVersion ?? 1,
      file: input.file,
      originalHash,
      backupPath: stored.value.path,
      instrumentedHash,
      diff: appendDiff(input.file, input.original, input.instrumented),
      status: 'applied',
      ...(input.previous === undefined ? {} : { previousRecordId: input.previous.id }),
    },
    { now: () => NOW - 60_000 },
  );

  if (isErr(created)) {
    throw created.error;
  }

  const appended = await harness.journal.append(created.value);

  if (isErr(appended)) {
    throw appended.error;
  }

  return appended.value;
}

/** The two standard instrumented files of the sandbox. */
async function instrumentLedgerAndTally(
  harness: Harness,
): Promise<{ readonly ledger: ModificationRecord; readonly tally: ModificationRecord }> {
  const ledger = await instrument(harness, {
    file: LEDGER_FILE,
    original: LEDGER_ORIGINAL,
    instrumented: instrumentedOf(LEDGER_ORIGINAL),
  });
  const tally = await instrument(harness, {
    file: TALLY_FILE,
    original: TALLY_ORIGINAL,
    instrumented: instrumentedOf(TALLY_ORIGINAL),
  });

  return { ledger, tally };
}

// ---------------------------------------------------------------------------
// Harness: waiting
// ---------------------------------------------------------------------------

/** A bounded quiet period, for "nothing happened" assertions. */
function quiet(ms: number = QUIET_MS): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** How many evaluations of `file` found its instrumented bytes intact (optionally against one record). */
function unchangedEvaluations(harness: Harness, file: string, recordId?: string): number {
  return harness.logs.filter(
    (record) =>
      record.message === EVALUATED_UNCHANGED &&
      record.fields['file'] === file &&
      (recordId === undefined || record.fields['recordId'] === recordId),
  ).length;
}

/** Waits until `file` has been found intact at least `atLeast` times: proof the watch is live. */
async function waitForUnchangedEvaluations(
  harness: Harness,
  file: string,
  atLeast: number,
  recordId?: string,
): Promise<void> {
  await vi.waitFor(() => {
    expect(unchangedEvaluations(harness, file, recordId)).toBeGreaterThanOrEqual(atLeast);
  }, WAIT);
}

/** Starts watching the session and waits for every listed file's initial, no-op evaluation. */
async function startWatching(
  harness: Harness,
  files: readonly string[],
  sessionId: string = SESSION_ID,
): Promise<void> {
  const started = await harness.watcher.watchSession({
    sessionId,
    projectRoot: harness.sandbox.projectRoot,
  });

  expect(started.ok).toBe(true);

  for (const file of files) {
    await waitForUnchangedEvaluations(harness, file, 1);
  }
}

/** Waits until the listener has heard `count` conflicts. */
async function waitForConflicts(harness: Harness, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(harness.listener.calls).toHaveLength(count);
  }, WAIT);
}

/** Writes `content` beside `absolute` and renames it over the target: an editor's atomic save. */
async function atomicSave(absolute: string, content: string, tag: string): Promise<void> {
  const temporary = join(dirname(absolute), `.${basename(absolute)}.${tag}.tmp`);

  await writeFile(temporary, content);
  await rename(temporary, absolute);
}

/** The `updateStatus` calls that moved a record into `conflict`. */
function conflictTransitions(harness: Harness): UpdateStatusCall[] {
  return harness.journal.updateCalls.filter((call) => call.status === 'conflict');
}

/** The single conflict the listener heard, with its notice. */
function onlyConflict(harness: Harness): ConflictInput {
  expect(harness.listener.calls).toHaveLength(1);

  return harness.listener.calls[0]!;
}

/** Every file (and directory) under `root`, relative, mapped to its kind and SHA-256. */
async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();

  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);

      if (entry.isDirectory()) {
        snapshot.set(relative, 'directory');
        await walk(absolute, relative);
      } else if (entry.isSymbolicLink()) {
        snapshot.set(relative, 'symbolic-link');
      } else if (entry.isFile()) {
        snapshot.set(relative, `file:${sha256Hex(await readFile(absolute))}`);
      } else {
        snapshot.set(relative, 'other');
      }
    }
  }

  await walk(root, '');

  return snapshot;
}

// ---------------------------------------------------------------------------
// The harness itself
// ---------------------------------------------------------------------------

describe('the harness', () => {
  it('journals records whose digests are the real bytes on disk and whose backup holds the original', async () => {
    const harness = await createHarness();
    const { ledger } = await instrumentLedgerAndTally(harness);

    expect(ledger.status).toBe('applied');
    expect(await sha256OfFile(harness.pathOf(LEDGER_FILE))).toBe(ledger.instrumentedHash);
    expect(ledger.originalHash).toBe(sha256Hex(LEDGER_ORIGINAL));
    expect(await readFile(ledger.backupPath, 'utf8')).toBe(LEDGER_ORIGINAL);
    expect(ledger.backupPath.startsWith(harness.sandbox.debuggenHome)).toBe(true);
    expect(DEBOUNCE_MS).toBeLessThan(DEFAULT_CONFLICT_DEBOUNCE_MS);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — the no-op path
// ---------------------------------------------------------------------------

describe('the no-op path', () => {
  it('rewriting the identical instrumented bytes produces no transition, no row and no listener call', async () => {
    const harness = await createHarness();
    const { ledger } = await instrumentLedgerAndTally(harness);
    await startWatching(harness, [LEDGER_FILE, TALLY_FILE]);
    const before = unchangedEvaluations(harness, LEDGER_FILE);

    await writeFile(harness.pathOf(LEDGER_FILE), instrumentedOf(LEDGER_ORIGINAL));
    await waitForUnchangedEvaluations(harness, LEDGER_FILE, before + 1);
    await quiet();

    expect(harness.journal.updateCalls).toEqual([]);
    expect(harness.progress.emitted).toEqual([]);
    expect(harness.listener.calls).toEqual([]);
    expect(harness.journal.current(ledger.id)?.status).toBe('applied');
    expect(
      harness.watcher
        .watchedFiles(SESSION_ID)
        .map((watched) => watched.file)
        .sort(),
    ).toEqual([TALLY_FILE, LEDGER_FILE].sort());
  });

  it('events for an unrelated file — or a sibling — in a watched directory evaluate nothing', async () => {
    const harness = await createHarness();
    await instrumentLedgerAndTally(harness);
    await startWatching(harness, [LEDGER_FILE, TALLY_FILE]);
    const ledgerBefore = unchangedEvaluations(harness, LEDGER_FILE);
    const tallyBefore = unchangedEvaluations(harness, TALLY_FILE);
    const readsBefore = harness.journal.reads.latestRecordForFile;

    await appendFile(harness.pathOf(NOTES_FILE), 'A line nobody instrumented.\n');
    await writeFile(join(harness.sandbox.projectRoot, 'src/ledger/scratch.txt'), 'scratch\n');
    await atomicSave(harness.pathOf(NOTES_FILE), '# Ledger notes, rewritten\n', 'notes');
    await quiet();

    expect(unchangedEvaluations(harness, LEDGER_FILE)).toBe(ledgerBefore);
    expect(unchangedEvaluations(harness, TALLY_FILE)).toBe(tallyBefore);
    expect(harness.journal.reads.latestRecordForFile).toBe(readsBefore);

    // The sentinel: the watch was live all along, and an event naming one
    // sibling evaluates that sibling only.
    await writeFile(harness.pathOf(LEDGER_FILE), instrumentedOf(LEDGER_ORIGINAL));
    await waitForUnchangedEvaluations(harness, LEDGER_FILE, ledgerBefore + 1);
    await quiet();

    expect(unchangedEvaluations(harness, TALLY_FILE)).toBe(tallyBefore);
    expect(harness.journal.updateCalls).toEqual([]);
    expect(harness.progress.emitted).toEqual([]);
    expect(harness.listener.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — the conflict path
// ---------------------------------------------------------------------------

describe('the conflict path', () => {
  it('coalesces a burst of five writes into exactly one applied → conflict transition, row and listener call', async () => {
    const harness = await createHarness();
    const { ledger, tally } = await instrumentLedgerAndTally(harness);
    await startWatching(harness, [LEDGER_FILE, TALLY_FILE]);

    for (let write = 0; write < 5; write += 1) {
      await appendFile(harness.pathOf(LEDGER_FILE), `${DEVELOPER_LINE} (${String(write)})\n`);
    }

    await waitForConflicts(harness, 1);
    await quiet();

    expect(conflictTransitions(harness)).toEqual([
      { id: ledger.id, status: 'conflict', patch: undefined, from: 'applied', outcome: 'ok' },
    ]);
    expect(harness.journal.updateCalls).toHaveLength(1);
    expect(harness.progress.emitted).toHaveLength(1);
    expect(harness.listener.calls).toHaveLength(1);
    expect(harness.journal.current(ledger.id)?.status).toBe('conflict');
    expect(harness.journal.current(tally.id)?.status).toBe('applied');
    expect(harness.watcher.watchedFiles(SESSION_ID).map((watched) => watched.recordId)).toEqual([
      tally.id,
    ]);
  });

  it('announces the AAP §0.5.5 sentence with its Open diff action, and no content, diff or digest', async () => {
    const harness = await createHarness();
    const { ledger } = await instrumentLedgerAndTally(harness);
    await startWatching(harness, [LEDGER_FILE, TALLY_FILE]);
    const edited = `${instrumentedOf(LEDGER_ORIGINAL)}${DEVELOPER_LINE}\n`;

    await writeFile(harness.pathOf(LEDGER_FILE), edited);
    await waitForConflicts(harness, 1);

    const { sessionId, record, conflict, notice } = onlyConflict(harness);

    // The structured report: schema-valid and about this record.
    expect(sessionId).toBe(SESSION_ID);
    expect(record.id).toBe(ledger.id);
    expect(record.status).toBe('conflict');
    expect(parseModificationConflict(conflict).ok).toBe(true);
    expect(MODIFICATION_CONFLICT_REASONS).toContain(conflict.reason);
    expect(conflict).toMatchObject({
      recordId: ledger.id,
      sessionId: SESSION_ID,
      file: LEDGER_FILE,
      reason: 'content-changed',
      expectedHash: ledger.instrumentedHash,
      actualHash: sha256Hex(edited),
      backupPath: ledger.backupPath,
      detectedAt: NOW,
    });

    // The notice: the one sentence, verbatim, and its action.
    expect(notice.message).toBe(buildConflictMessage(record, conflict));
    const sentence = CONFLICT_SENTENCE.exec(notice.message);
    expect(sentence?.[1]).toBe(LEDGER_FILE);
    expect(sentence?.[2]).toBe(ledger.backupPath);
    expect(notice).toMatchObject({
      action: 'open-diff',
      recordId: ledger.id,
      file: LEDGER_FILE,
      backupPath: ledger.backupPath,
      reason: 'content-changed',
      observation: 'content-changed',
      backupVerified: true,
    });
    expect(notice.detail).toContain('Open diff');
    expect(notice.detail).toContain(ledger.id);

    // The persisted, broadcast row carries exactly the notice.
    expect(harness.progress.refused).toEqual([]);
    expect(harness.progress.emitted).toEqual([
      {
        sessionId: SESSION_ID,
        stage: 'instrument',
        status: 'running',
        message: notice.message,
        detail: notice.detail,
      },
    ]);

    // Nothing of the file, the diff or a digest reaches the sentence or the detail
    // (the backup path's own file name is the one digest AAP §0.5.5 requires).
    for (const text of [notice.message, notice.detail]) {
      expect(text).not.toContain(DEVELOPER_LINE);
      expect(text).not.toContain(PROBE_LINE);
      expect(text).not.toContain('sumOrchardCrates');
      expect(text).not.toContain('@@ -1');
      expect(text).not.toContain(ledger.diff);
      expect(text).not.toContain(ledger.instrumentedHash);
      expect(text).not.toContain(sha256Hex(edited));
    }
    expect(notice.message.replace(ledger.backupPath, '‹backup›')).not.toMatch(DIGEST_PATTERN);
    expect(notice.detail).not.toMatch(DIGEST_PATTERN);

    // Detected, never acted on: the edit stays, and so does the original.
    expect(await readFile(harness.pathOf(LEDGER_FILE), 'utf8')).toBe(edited);
    expect(await readFile(ledger.backupPath, 'utf8')).toBe(LEDGER_ORIGINAL);
  });

  it('opens one non-persistent, non-recursive watch on the parent directory, never on a file', async () => {
    const harness = await createHarness();
    await instrumentLedgerAndTally(harness);
    await startWatching(harness, [LEDGER_FILE, TALLY_FILE]);

    expect(harness.probe.opened).toEqual([
      { path: dirname(harness.pathOf(LEDGER_FILE)), persistent: false, recursive: false },
    ]);
    expect(harness.probe.openCount()).toBe(1);
  });

  it('detects both of two atomic saves in a row (write a temporary file, rename it over the target)', async () => {
    // The production fs.watch: a watch on the file would hold the replaced inode
    // and go deaf after the first save, so the second — the real edit — would
    // never be reported and this test would time out.
    const harness = await createHarness({ productionWatch: true });
    const { ledger } = await instrumentLedgerAndTally(harness);
    await startWatching(harness, [LEDGER_FILE, TALLY_FILE]);
    const before = unchangedEvaluations(harness, LEDGER_FILE);

    await atomicSave(harness.pathOf(LEDGER_FILE), instrumentedOf(LEDGER_ORIGINAL), 'first');
    await waitForUnchangedEvaluations(harness, LEDGER_FILE, before + 1);
    expect(harness.listener.calls).toEqual([]);

    const edited = `${instrumentedOf(LEDGER_ORIGINAL)}${DEVELOPER_LINE}\n`;
    await atomicSave(harness.pathOf(LEDGER_FILE), edited, 'second');
    await waitForConflicts(harness, 1);

    const { conflict } = onlyConflict(harness);
    expect(conflict.recordId).toBe(ledger.id);
    expect(conflict.actualHash).toBe(sha256Hex(edited));
    expect(conflictTransitions(harness)).toHaveLength(1);
  });

  it('hashes raw bytes: a trailing-newline-only change and an LF → CRLF conversion are both conflicts', async () => {
    const harness = await createHarness();
    const { ledger, tally } = await instrumentLedgerAndTally(harness);
    await startWatching(harness, [LEDGER_FILE, TALLY_FILE]);
    const withNewline = `${instrumentedOf(LEDGER_ORIGINAL)}\n`;
    const crlf = instrumentedOf(TALLY_ORIGINAL).replaceAll('\n', '\r\n');

    await writeFile(harness.pathOf(LEDGER_FILE), withNewline);
    await writeFile(harness.pathOf(TALLY_FILE), crlf);
    await waitForConflicts(harness, 2);

    const byRecord = new Map(harness.listener.calls.map((call) => [call.record.id, call]));
    expect(byRecord.get(ledger.id)?.conflict.actualHash).toBe(sha256Hex(withNewline));
    expect(byRecord.get(tally.id)?.conflict.actualHash).toBe(sha256Hex(crlf));

    for (const call of harness.listener.calls) {
      expect(call.conflict.reason).toBe('content-changed');
      expect(call.notice.observation).toBe('content-changed');
    }

    expect(
      conflictTransitions(harness)
        .map((call) => call.id)
        .sort(),
    ).toEqual([ledger.id, tally.id].sort());
  });

  it('reports the developer restoring the original bytes by hand, told apart from an edit', async () => {
    const harness = await createHarness();
    const { ledger, tally } = await instrumentLedgerAndTally(harness);
    await startWatching(harness, [LEDGER_FILE, TALLY_FILE]);

    await writeFile(harness.pathOf(LEDGER_FILE), LEDGER_ORIGINAL);
    await appendFile(harness.pathOf(TALLY_FILE), `${DEVELOPER_LINE}\n`);
    await waitForConflicts(harness, 2);

    const byRecord = new Map(harness.listener.calls.map((call) => [call.record.id, call]));
    const restored = byRecord.get(ledger.id)!;
    const edited = byRecord.get(tally.id)!;

    // Still a conflict under AAP §0.5.5's literal rule: the tool did not write these bytes.
    expect(restored.record.status).toBe('conflict');
    expect(restored.conflict.actualHash).toBe(ledger.originalHash);
    expect(restored.conflict.diffs?.originalToInstrumented).toBe(ledger.diff);
    expect(MODIFICATION_CONFLICT_REASONS).toContain(restored.conflict.reason);
    expect(restored.notice.message).toBe(buildConflictMessage(restored.record, restored.conflict));

    // …but distinguishable from content divergence.
    expect(restored.notice.observation).toBe('reverted-to-original');
    expect(edited.notice.observation).toBe('content-changed');
    expect(restored.notice.detail).toContain('original, uninstrumented contents');
    expect(edited.notice.detail).not.toContain('original, uninstrumented contents');
    expect(restored.notice.detail).not.toBe(edited.notice.detail);

    expect(await readFile(harness.pathOf(LEDGER_FILE), 'utf8')).toBe(LEDGER_ORIGINAL);
  });

  it('reports a deleted instrumented file as a file-missing conflict, without throwing', async () => {
    const harness = await createHarness();
    const { ledger } = await instrumentLedgerAndTally(harness);
    await startWatching(harness, [LEDGER_FILE, TALLY_FILE]);

    await unlink(harness.pathOf(LEDGER_FILE));
    await waitForConflicts(harness, 1);

    const { conflict, notice } = onlyConflict(harness);
    expect(MODIFICATION_CONFLICT_REASONS).toContain('file-missing');
    expect(conflict.reason).toBe('file-missing');
    expect(conflict.actualHash).toBeUndefined();
    expect(notice).toMatchObject({
      observation: 'file-missing',
      recordId: ledger.id,
      reason: 'file-missing',
    });
    expect(notice.detail).toContain('deleted or moved');
    expect(harness.progress.emitted).toHaveLength(1);
    expect(await readFile(ledger.backupPath, 'utf8')).toBe(LEDGER_ORIGINAL);
  });

  it('reports a symbolic link planted at the path as a conflict, and never follows it', async () => {
    const harness = await createHarness();
    const { ledger } = await instrumentLedgerAndTally(harness);
    await startWatching(harness, [LEDGER_FILE, TALLY_FILE]);
    const target = join(harness.sandbox.outside, 'stray.ts');
    const planted = join(dirname(harness.pathOf(LEDGER_FILE)), '.planted-link');

    await symlink(target, planted);
    await rename(planted, harness.pathOf(LEDGER_FILE));
    await waitForConflicts(harness, 1);

    const { conflict, notice } = onlyConflict(harness);
    expect(conflict.recordId).toBe(ledger.id);
    expect(conflict.reason).toBe('content-changed');
    expect(conflict.actualHash).toBeUndefined();
    expect(notice.observation).toBe('not-a-regular-file');
    expect(notice.backupVerified).toBe(false);
    expect(await readFile(target, 'utf8')).toBe('export const strayValue = 1;\n');
  });
});

describe('the conflict path — refusals and races', () => {
  it('refuses a record whose path escapes the project root before any watch, returning PATH_OUTSIDE_PROJECT as data', async () => {
    const harness = await createHarness();
    const store = harness.storeFor(SESSION_ID);
    const originalHash = sha256Hex('export const strayValue = 0;\n');
    const backupPath = store.locate(originalHash);

    if (isErr(backupPath)) {
      throw backupPath.error;
    }

    const escaping: ModificationRecord[] = [];

    for (const file of ['../outside/stray.ts', join(harness.sandbox.outside, 'stray.ts')]) {
      const valid = createModificationRecord(
        {
          sessionId: SESSION_ID,
          planVersion: 1,
          file: 'src/ledger/stray-source.ts',
          originalHash,
          backupPath: backupPath.value,
          instrumentedHash: sha256Hex('export const strayValue = 1;\n'),
          diff: '',
          status: 'applied',
        },
        { now: clock },
      );

      if (isErr(valid)) {
        throw valid.error;
      }

      // A journal row the schema would refuse, as a corrupted store could hold it.
      const record: ModificationRecord = { ...valid.value, file };
      escaping.push(record);
      await harness.journal.append(record);
    }

    const started = await harness.watcher.watchSession({
      sessionId: SESSION_ID,
      projectRoot: harness.sandbox.projectRoot,
    });

    expect(started.ok && started.value).toEqual([]);
    expect(harness.probe.opened).toEqual([]);
    expect(harness.watcher.watchedFiles(SESSION_ID)).toEqual([]);

    const issues = harness.watcher.watchIssues(SESSION_ID);
    expect(DEBUGGEN_ERROR_CODES).toContain('PATH_OUTSIDE_PROJECT');
    expect(issues.map((issue) => [issue.recordId, issue.file, issue.kind, issue.code])).toEqual(
      escaping.map((record) => [record.id, record.file, 'outside-project', 'PATH_OUTSIDE_PROJECT']),
    );

    for (const issue of issues) {
      expect(issue.sessionId).toBe(SESSION_ID);
      expect(issue.detectedAt).toBe(NOW);
      expect(issue.message).not.toContain(harness.sandbox.root);
    }

    const readsAfterStart = harness.journal.reads.latestRecordForFile;
    await appendFile(join(harness.sandbox.outside, 'stray.ts'), `${DEVELOPER_LINE}\n`);
    await quiet();

    expect(harness.journal.reads.latestRecordForFile).toBe(readsAfterStart);
    expect(harness.journal.updateCalls).toEqual([]);
    expect(harness.listener.calls).toEqual([]);
  });

  it.each(['conflict', 'reverted'] as const)(
    'absorbs losing the updateStatus race to a record already moved to %s: no retry, no notification, no throw',
    async (movedTo) => {
      const harness = await createHarness();
      const { ledger } = await instrumentLedgerAndTally(harness);
      await startWatching(harness, [LEDGER_FILE, TALLY_FILE]);

      harness.journal.loseNextUpdateTo(movedTo);
      await appendFile(harness.pathOf(LEDGER_FILE), `${DEVELOPER_LINE}\n`);
      await vi.waitFor(() => {
        expect(harness.journal.updateCalls).toHaveLength(1);
      }, WAIT);
      await quiet();

      expect(harness.journal.updateCalls).toEqual([
        { id: ledger.id, status: 'conflict', patch: undefined, from: 'applied', outcome: 'err' },
      ]);
      expect(harness.journal.current(ledger.id)?.status).toBe(movedTo);
      expect(harness.progress.emitted).toEqual([]);
      expect(harness.listener.calls).toEqual([]);

      // A later event finds the record owned elsewhere and lets the file go
      // (an event that arrived mid-evaluation may already have done so).
      await appendFile(harness.pathOf(LEDGER_FILE), `${DEVELOPER_LINE} (again)\n`);
      await vi.waitFor(() => {
        expect(harness.watcher.watchedFiles(SESSION_ID).map((watched) => watched.file)).toEqual([
          TALLY_FILE,
        ]);
      }, WAIT);
      await quiet();

      expect(harness.journal.updateCalls).toHaveLength(1);
      expect(harness.progress.emitted).toEqual([]);
      expect(harness.listener.calls).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Phase 4 — chain heads, suspend/resume and refresh
// ---------------------------------------------------------------------------

describe('chain heads, suspend/resume and refresh', () => {
  it('evaluates only the chain head: bytes matching the head are a no-op though they differ from the older link', async () => {
    const harness = await createHarness();
    const first = await instrument(harness, {
      file: LEDGER_FILE,
      original: LEDGER_ORIGINAL,
      instrumented: instrumentedOf(LEDGER_ORIGINAL),
    });
    const delta = await instrument(harness, {
      file: LEDGER_FILE,
      original: instrumentedOf(LEDGER_ORIGINAL),
      instrumented: instrumentedOf(instrumentedOf(LEDGER_ORIGINAL), DELTA_LINE),
      planVersion: 2,
      previous: first,
    });

    expect(delta.previousRecordId).toBe(first.id);
    expect(delta.originalHash).toBe(first.instrumentedHash);
    expect(await sha256OfFile(harness.pathOf(LEDGER_FILE))).not.toBe(first.instrumentedHash);

    await startWatching(harness, []);
    await waitForUnchangedEvaluations(harness, LEDGER_FILE, 1, delta.id);
    await quiet();

    expect(harness.watcher.watchedFiles(SESSION_ID)).toEqual([
      {
        sessionId: SESSION_ID,
        recordId: delta.id,
        file: LEDGER_FILE,
        absolutePath: harness.pathOf(LEDGER_FILE),
        instrumentedHash: delta.instrumentedHash,
        planVersion: 2,
      },
    ]);
    expect(unchangedEvaluations(harness, LEDGER_FILE, first.id)).toBe(0);
    expect(harness.journal.updateCalls).toEqual([]);
    expect(harness.listener.calls).toEqual([]);

    await appendFile(harness.pathOf(LEDGER_FILE), `${DEVELOPER_LINE}\n`);
    await waitForConflicts(harness, 1);

    expect(conflictTransitions(harness).map((call) => call.id)).toEqual([delta.id]);
    expect(onlyConflict(harness).conflict.expectedHash).toBe(delta.instrumentedHash);
    expect(harness.journal.current(first.id)?.status).toBe('applied');
  });

  it('follow-up delta regression: suspend → rewrite + new head → refresh → resume reports nothing, then a real edit is caught', async () => {
    const harness = await createHarness();
    const first = await instrument(harness, {
      file: LEDGER_FILE,
      original: LEDGER_ORIGINAL,
      instrumented: instrumentedOf(LEDGER_ORIGINAL),
    });
    await startWatching(harness, [LEDGER_FILE]);

    harness.watcher.suspend(SESSION_ID);
    // The installer's delta: the file is rewritten to a new digest and the new
    // chain head is journaled while the watch still names the old head.
    const delta = await instrument(harness, {
      file: LEDGER_FILE,
      original: instrumentedOf(LEDGER_ORIGINAL),
      instrumented: instrumentedOf(instrumentedOf(LEDGER_ORIGINAL), DELTA_LINE),
      planVersion: 2,
      previous: first,
    });
    await quiet();
    expect(harness.journal.updateCalls).toEqual([]);

    const refreshed = await harness.watcher.refresh(SESSION_ID);
    const expected = [
      { recordId: delta.id, instrumentedHash: delta.instrumentedHash, planVersion: 2 },
    ];

    expect(refreshed.ok).toBe(true);
    expect(
      (refreshed.ok ? refreshed.value : []).map(({ recordId, instrumentedHash, planVersion }) => ({
        recordId,
        instrumentedHash,
        planVersion,
      })),
    ).toEqual(expected);
    expect(
      harness.watcher
        .watchedFiles(SESSION_ID)
        .map(({ recordId, instrumentedHash, planVersion }) => ({
          recordId,
          instrumentedHash,
          planVersion,
        })),
    ).toEqual(expected);

    harness.watcher.resume(SESSION_ID);
    await waitForUnchangedEvaluations(harness, LEDGER_FILE, 1, delta.id);
    await quiet();

    expect(harness.journal.updateCalls).toEqual([]);
    expect(harness.progress.emitted).toEqual([]);
    expect(harness.listener.calls).toEqual([]);

    await appendFile(harness.pathOf(LEDGER_FILE), `${DEVELOPER_LINE}\n`);
    await waitForConflicts(harness, 1);

    expect(conflictTransitions(harness).map((call) => call.id)).toEqual([delta.id]);
    expect(onlyConflict(harness).conflict.expectedHash).toBe(delta.instrumentedHash);
  });

  it('nests suspensions, and the last resume still catches an edit made while suspended', async () => {
    const harness = await createHarness();
    const { ledger } = await instrumentLedgerAndTally(harness);
    await startWatching(harness, [LEDGER_FILE, TALLY_FILE]);

    harness.watcher.resume(SESSION_ID); // without a suspension: a no-op
    harness.watcher.suspend(SESSION_ID);
    harness.watcher.suspend(SESSION_ID);
    await appendFile(harness.pathOf(LEDGER_FILE), `${DEVELOPER_LINE}\n`);
    await quiet();
    expect(harness.journal.updateCalls).toEqual([]);

    harness.watcher.resume(SESSION_ID);
    await quiet();
    expect(harness.journal.updateCalls).toEqual([]);
    expect(harness.listener.calls).toEqual([]);

    harness.watcher.resume(SESSION_ID);
    await waitForConflicts(harness, 1);

    expect(conflictTransitions(harness).map((call) => call.id)).toEqual([ledger.id]);
  });

  it('abandons an evaluation in flight when a suspend lands, before it can mutate anything', async () => {
    const harness = await createHarness();
    const { ledger } = await instrumentLedgerAndTally(harness);
    await startWatching(harness, [LEDGER_FILE, TALLY_FILE]);
    const held = harness.journal.holdLatestReads();

    await appendFile(harness.pathOf(LEDGER_FILE), `${DEVELOPER_LINE}\n`);
    await held.reached;
    harness.watcher.suspend(SESSION_ID);
    held.release();
    await quiet();

    expect(harness.journal.updateCalls).toEqual([]);
    expect(harness.progress.emitted).toEqual([]);
    expect(harness.listener.calls).toEqual([]);

    harness.watcher.resume(SESSION_ID);
    await waitForConflicts(harness, 1);
    expect(conflictTransitions(harness).map((call) => call.id)).toEqual([ledger.id]);
  });

  it('refresh adds a newly instrumented file in an unwatched directory and drops a reverted one', async () => {
    const harness = await createHarness();
    const ledger = await instrument(harness, {
      file: LEDGER_FILE,
      original: LEDGER_ORIGINAL,
      instrumented: instrumentedOf(LEDGER_ORIGINAL),
    });
    await startWatching(harness, [LEDGER_FILE]);
    expect(harness.probe.openCount()).toBe(1);

    const sprout = await instrument(harness, {
      file: SPROUT_FILE,
      original: SPROUT_ORIGINAL,
      instrumented: instrumentedOf(SPROUT_ORIGINAL),
    });
    const added = await harness.watcher.refresh(SESSION_ID);

    expect(added.ok && added.value.map((watched) => watched.recordId).sort()).toEqual(
      [ledger.id, sprout.id].sort(),
    );
    expect(harness.probe.opened.map((opened) => opened.path)).toContain(
      dirname(harness.pathOf(SPROUT_FILE)),
    );
    expect(harness.probe.openCount()).toBe(2);
    await waitForUnchangedEvaluations(harness, SPROUT_FILE, 1);

    // Cleanup restored the ledger file and closed its record.
    harness.journal.setStatus(ledger.id, 'reverted');
    const dropped = await harness.watcher.refresh(SESSION_ID);

    expect(dropped.ok && dropped.value.map((watched) => watched.recordId)).toEqual([sprout.id]);
    expect(harness.probe.openCount()).toBe(1);

    await appendFile(harness.pathOf(LEDGER_FILE), `${DEVELOPER_LINE}\n`);
    await quiet();
    expect(harness.journal.updateCalls).toEqual([]);

    await appendFile(harness.pathOf(SPROUT_FILE), `${DEVELOPER_LINE}\n`);
    await waitForConflicts(harness, 1);
    expect(conflictTransitions(harness).map((call) => call.id)).toEqual([sprout.id]);
  });

  it('refuses to refresh a session it never watched, and to watch a blank session id', async () => {
    const harness = await createHarness();

    const refreshed = await harness.watcher.refresh('ses_neverwatched01');
    expect(refreshed.ok).toBe(false);
    expect(refreshed.ok ? undefined : refreshed.error.code).toBe('SESSION_NOT_FOUND');

    const blank = await harness.watcher.watchSession({
      sessionId: '',
      projectRoot: harness.sandbox.projectRoot,
    });
    expect(blank.ok ? undefined : blank.error.code).toBe('SESSION_NOT_FOUND');
    expect(harness.probe.opened).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Degradation: every file that cannot be watched or judged is data, not a throw
// ---------------------------------------------------------------------------

/** Journals an `applied` record for a file the test does not write, with a real backup. */
async function journalUnwrittenFile(harness: Harness, file: string): Promise<ModificationRecord> {
  const original = 'export const vanishedGauge = 0;\n';
  const originalBytes = Buffer.from(original, 'utf8');
  const originalHash = sha256Hex(originalBytes);
  const stored = await harness.storeFor(SESSION_ID).put(originalHash, originalBytes);

  if (isErr(stored)) {
    throw stored.error;
  }

  const instrumented = instrumentedOf(original);
  const created = createModificationRecord(
    {
      sessionId: SESSION_ID,
      planVersion: 1,
      file,
      originalHash,
      backupPath: stored.value.path,
      instrumentedHash: sha256Hex(instrumented),
      diff: appendDiff(file, original, instrumented),
      status: 'applied',
    },
    { now: clock },
  );

  if (isErr(created)) {
    throw created.error;
  }

  const appended = await harness.journal.append(created.value);

  if (isErr(appended)) {
    throw appended.error;
  }

  return appended.value;
}

describe('degradation is reported as data, never thrown', () => {
  it('refuses to watch through a symbolic link inside the project (unsafe-path)', async () => {
    const harness = await createHarness();
    await symlink(harness.sandbox.outside, join(harness.sandbox.projectRoot, 'linked'));
    const record = await journalUnwrittenFile(harness, 'linked/stray.ts');

    const started = await harness.watcher.watchSession({
      sessionId: SESSION_ID,
      projectRoot: harness.sandbox.projectRoot,
    });

    expect(started.ok && started.value).toEqual([]);
    expect(harness.probe.opened).toEqual([]);
    expect(harness.watcher.watchIssues(SESSION_ID)).toMatchObject([
      { recordId: record.id, file: 'linked/stray.ts', kind: 'unsafe-path', code: 'FS_UNSAFE_PATH' },
    ]);
    expect(harness.watcher.watchIssues(SESSION_ID)[0]?.message).not.toContain(harness.sandbox.root);

    await appendFile(join(harness.sandbox.outside, 'stray.ts'), `${DEVELOPER_LINE}\n`);
    await quiet();
    expect(harness.journal.updateCalls).toEqual([]);
    expect(harness.listener.calls).toEqual([]);
  });

  it('records a platform refusal of the directory watch (watch-failed) and still answers', async () => {
    const refusingWatch: WatchLike = () => {
      throw Object.assign(new Error('the platform watch budget is exhausted'), { code: 'ENOSPC' });
    };
    const harness = await createHarness({ watch: refusingWatch });
    const { ledger } = await instrumentLedgerAndTally(harness);

    const started = await harness.watcher.watchSession({
      sessionId: SESSION_ID,
      projectRoot: harness.sandbox.projectRoot,
    });

    expect(started.ok && started.value).toEqual([]);
    expect(harness.watcher.watchedFiles(SESSION_ID)).toEqual([]);

    const issues = harness.watcher.watchIssues(SESSION_ID);
    expect(issues.map((issue) => [issue.kind, issue.code, issue.errno])).toEqual([
      ['watch-failed', 'INSTRUMENTATION_UNAVAILABLE', 'ENOSPC'],
      ['watch-failed', 'INSTRUMENTATION_UNAVAILABLE', 'ENOSPC'],
    ]);
    expect(issues.map((issue) => issue.recordId)).toContain(ledger.id);
  });

  it('closes a watch that reports an error (watch-lost), records it and re-checks the files once', async () => {
    const harness = await createHarness();
    const { ledger } = await instrumentLedgerAndTally(harness);
    await startWatching(harness, [LEDGER_FILE, TALLY_FILE]);
    const before = unchangedEvaluations(harness, LEDGER_FILE);

    harness.probe.handles[0]!.emit(
      'error',
      Object.assign(new Error('the watched directory was revoked'), { code: 'EPERM' }),
    );

    expect(harness.probe.openCount()).toBe(0);
    expect(harness.watcher.watchedFiles(SESSION_ID)).toEqual([]);
    expect(
      harness.watcher
        .watchIssues(SESSION_ID)
        .filter((issue) => issue.kind === 'watch-lost')
        .map((issue) => [issue.recordId, issue.errno]),
    ).toContainEqual([ledger.id, 'EPERM']);

    await waitForUnchangedEvaluations(harness, LEDGER_FILE, before + 1);
    expect(harness.journal.updateCalls).toEqual([]);
  });

  it('checks a file whose directory is gone once, and reports it missing (directory-missing)', async () => {
    const harness = await createHarness();
    const record = await journalUnwrittenFile(harness, 'lib/vanished/gauge.ts');

    const started = await harness.watcher.watchSession({
      sessionId: SESSION_ID,
      projectRoot: harness.sandbox.projectRoot,
    });

    expect(started.ok && started.value).toEqual([]);
    expect(harness.watcher.watchIssues(SESSION_ID)).toMatchObject([
      { recordId: record.id, kind: 'directory-missing', code: 'PATCH_TARGET_NOT_FOUND' },
    ]);

    await waitForConflicts(harness, 1);
    const { conflict, notice } = onlyConflict(harness);
    expect(conflict.reason).toBe('file-missing');
    expect(notice.observation).toBe('file-missing');
    expect(harness.probe.opened).toEqual([]);
  });

  it('answers an unreadable journal with an Err and watches nothing', async () => {
    const journal = createJournal();
    const failing: JournalDouble = {
      ...journal,
      listBySession: () =>
        Promise.resolve(err(new DebuggenError('STORE_ERROR', 'The session store is closed.'))),
    };
    const harness = await createHarness({ journal: failing });

    const started = await harness.watcher.watchSession({
      sessionId: SESSION_ID,
      projectRoot: harness.sandbox.projectRoot,
    });

    expect(started.ok ? undefined : started.error.code).toBe('STORE_ERROR');
    expect(harness.probe.opened).toEqual([]);
    expect(harness.watcher.watchedFiles(SESSION_ID)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — lifecycle
// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  it('stopSession is idempotent, safe for an unknown session, cancels a pending evaluation and closes every handle', async () => {
    const harness = await createHarness();
    await instrumentLedgerAndTally(harness);
    await startWatching(harness, [LEDGER_FILE, TALLY_FILE]);
    expect(harness.probe.openCount()).toBe(1);

    // The edit's debounce is still pending when the stop lands.
    await appendFile(harness.pathOf(LEDGER_FILE), `${DEVELOPER_LINE}\n`);
    await harness.watcher.stopSession(SESSION_ID);
    await harness.watcher.stopSession(SESSION_ID);
    await harness.watcher.stopSession('ses_neverwatched02');

    expect(harness.probe.openCount()).toBe(0);
    expect(harness.watcher.watchedFiles(SESSION_ID)).toEqual([]);
    expect(harness.watcher.watchIssues(SESSION_ID)).toEqual([]);

    await appendFile(harness.pathOf(TALLY_FILE), `${DEVELOPER_LINE}\n`);
    await quiet();

    expect(harness.journal.updateCalls).toEqual([]);
    expect(harness.progress.emitted).toEqual([]);
    expect(harness.listener.calls).toEqual([]);
  });

  it('stopSession drains an evaluation in flight, and nothing transitions once it resolves', async () => {
    const harness = await createHarness();
    await instrumentLedgerAndTally(harness);
    await startWatching(harness, [LEDGER_FILE, TALLY_FILE]);
    const held = harness.journal.holdLatestReads();

    await appendFile(harness.pathOf(LEDGER_FILE), `${DEVELOPER_LINE}\n`);
    await held.reached;
    const stopping = harness.watcher.stopSession(SESSION_ID);
    held.release();
    await stopping;
    await quiet();

    expect(harness.journal.updateCalls).toEqual([]);
    expect(harness.listener.calls).toEqual([]);
    expect(harness.probe.openCount()).toBe(0);
  });

  it('stopAll and dispose stop every session, idempotently', async () => {
    const harness = await createHarness();
    await instrument(harness, {
      file: LEDGER_FILE,
      original: LEDGER_ORIGINAL,
      instrumented: instrumentedOf(LEDGER_ORIGINAL),
    });
    await instrument(harness, {
      file: SPROUT_FILE,
      original: SPROUT_ORIGINAL,
      instrumented: instrumentedOf(SPROUT_ORIGINAL),
      sessionId: OTHER_SESSION_ID,
    });
    await startWatching(harness, [LEDGER_FILE]);
    await startWatching(harness, [SPROUT_FILE], OTHER_SESSION_ID);

    expect(
      harness.watcher
        .watchedFiles()
        .map((watched) => watched.sessionId)
        .sort(),
    ).toEqual([OTHER_SESSION_ID, SESSION_ID].sort());
    expect(harness.probe.openCount()).toBe(2);

    await harness.watcher.stopAll();
    await harness.watcher.dispose();
    await harness.watcher.stopAll();

    expect(harness.probe.openCount()).toBe(0);
    expect(harness.watcher.watchedFiles()).toEqual([]);
    expect(harness.watcher.watchIssues()).toEqual([]);

    await appendFile(harness.pathOf(LEDGER_FILE), `${DEVELOPER_LINE}\n`);
    await appendFile(harness.pathOf(SPROUT_FILE), `${DEVELOPER_LINE}\n`);
    await quiet();

    expect(harness.journal.updateCalls).toEqual([]);
    expect(harness.listener.calls).toEqual([]);
  });

  it('keeps no module-level state: two watchers over one directory never interfere', async () => {
    const first = await createHarness();
    const second = await createHarness({ sandbox: first.sandbox });
    const ledger = await instrument(first, {
      file: LEDGER_FILE,
      original: LEDGER_ORIGINAL,
      instrumented: instrumentedOf(LEDGER_ORIGINAL),
    });
    const tally = await instrument(second, {
      file: TALLY_FILE,
      original: TALLY_ORIGINAL,
      instrumented: instrumentedOf(TALLY_ORIGINAL),
      sessionId: OTHER_SESSION_ID,
    });
    await startWatching(first, [LEDGER_FILE]);
    await startWatching(second, [TALLY_FILE], OTHER_SESSION_ID);

    expect(first.watcher.watchedFiles().map((watched) => watched.recordId)).toEqual([ledger.id]);
    expect(second.watcher.watchedFiles().map((watched) => watched.recordId)).toEqual([tally.id]);
    expect(first.probe.openCount()).toBe(1);
    expect(second.probe.openCount()).toBe(1);

    await first.watcher.stopAll();
    expect(first.probe.openCount()).toBe(0);
    expect(second.probe.openCount()).toBe(1);

    await appendFile(second.pathOf(TALLY_FILE), `${DEVELOPER_LINE}\n`);
    await waitForConflicts(second, 1);
    await appendFile(first.pathOf(LEDGER_FILE), `${DEVELOPER_LINE}\n`);
    await quiet();

    expect(conflictTransitions(second).map((call) => call.id)).toEqual([tally.id]);
    expect(first.journal.updateCalls).toEqual([]);
    expect(first.listener.calls).toEqual([]);
    expect(second.listener.calls).toHaveLength(1);
  });

  it('catches an edit made before the watch began with the initial evaluation', async () => {
    const harness = await createHarness();
    const { ledger } = await instrumentLedgerAndTally(harness);

    await appendFile(harness.pathOf(LEDGER_FILE), `${DEVELOPER_LINE}\n`);
    const started = await harness.watcher.watchSession({
      sessionId: SESSION_ID,
      projectRoot: harness.sandbox.projectRoot,
    });

    expect(started.ok).toBe(true);
    await waitForConflicts(harness, 1);
    expect(conflictTransitions(harness).map((call) => call.id)).toEqual([ledger.id]);
  });

  it('replaces an unusable debounce with the default quiet period', async () => {
    const harness = await createHarness({ debounceMs: -1 });
    const { ledger } = await instrumentLedgerAndTally(harness);
    await startWatching(harness, [LEDGER_FILE, TALLY_FILE]);

    await appendFile(harness.pathOf(LEDGER_FILE), `${DEVELOPER_LINE}\n`);
    // Nothing can be evaluated sooner than the default debounce after the write.
    await quiet(DEFAULT_CONFLICT_DEBOUNCE_MS / 2);
    expect(harness.journal.updateCalls).toEqual([]);

    await waitForConflicts(harness, 1);
    expect(conflictTransitions(harness).map((call) => call.id)).toEqual([ledger.id]);
  });

  it.each([
    ['a throwing progress emitter and a rejecting listener', 'reject', true],
    ['a throwing listener', 'throw', false],
  ] as const)(
    'isolates the notification channels from each other and from the journal: %s',
    async (_label, listenerBehaviour, progressThrows) => {
      const harness = await createHarness({
        listenerBehaviour,
        ...(progressThrows
          ? {
              progress: {
                emit(): never {
                  throw new Error('progress channel down');
                },
              },
            }
          : {}),
      });
      const { ledger } = await instrumentLedgerAndTally(harness);
      await startWatching(harness, [LEDGER_FILE, TALLY_FILE]);

      await appendFile(harness.pathOf(LEDGER_FILE), `${DEVELOPER_LINE}\n`);
      await waitForConflicts(harness, 1);
      await quiet();

      expect(conflictTransitions(harness)).toHaveLength(1);
      expect(harness.journal.current(ledger.id)?.status).toBe('conflict');
      expect(harness.progress.emitted).toHaveLength(progressThrows ? 0 : 1);
      expect(harness.logs.some((record) => record.level === 'warn')).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Static reading of the module under test
// ---------------------------------------------------------------------------

/** `./watcher.ts`, as written. */
const WATCHER_SOURCE = readFileSync(
  fileURLToPath(new URL('./watcher.ts', import.meta.url)),
  'utf8',
);

/** A source file split into its code (comments removed, literals emptied) and its string literals. */
interface ScannedSource {
  readonly code: string;
  readonly strings: readonly string[];
}

/**
 * Separates TypeScript code from its comments and string literals, so a scan
 * for an API name is not fooled by documentation that says "rename" and a scan
 * for a message name sees only real literals. Handles line and block comments,
 * single- and double-quoted strings and template literals with nested `${…}`
 * expressions (whose code is kept). The module under test has no regular
 * expression literals, which the last guard below pins.
 */
function scanSource(source: string): ScannedSource {
  const strings: string[] = [];
  const expressionDepths: number[] = [];
  let code = '';
  let depth = 0;
  let index = 0;

  const readTemplateText = (): void => {
    let text = '';

    while (index < source.length) {
      const character = source[index]!;

      if (character === '\\') {
        text += source.slice(index, index + 2);
        index += 2;
      } else if (character === '`') {
        index += 1;
        strings.push(text);
        code += '`';

        return;
      } else if (character === '$' && source[index + 1] === '{') {
        index += 2;
        strings.push(text);
        code += '${';
        expressionDepths.push(depth);
        depth += 1;

        return;
      } else {
        text += character;
        index += 1;
      }
    }
  };

  while (index < source.length) {
    const character = source[index]!;
    const following = source[index + 1];

    if (character === '/' && following === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
    } else if (character === '/' && following === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      code += ' ';
    } else if (character === "'" || character === '"') {
      let text = '';
      index += 1;

      while (index < source.length && source[index] !== character) {
        if (source[index] === '\\') {
          text += source.slice(index, index + 2);
          index += 2;
        } else {
          text += source[index]!;
          index += 1;
        }
      }

      index += 1;
      strings.push(text);
      code += `${character}${character}`;
    } else if (character === '`') {
      index += 1;
      code += '`';
      readTemplateText();
    } else if (character === '{') {
      depth += 1;
      code += character;
      index += 1;
    } else if (character === '}') {
      depth -= 1;
      index += 1;

      if (expressionDepths.length > 0 && expressionDepths[expressionDepths.length - 1] === depth) {
        expressionDepths.pop();
        code += '}';
        readTemplateText();
      } else {
        code += character;
      }
    } else {
      code += character;
      index += 1;
    }
  }

  return { code, strings };
}

/** Every filesystem API that writes, renames, truncates, deletes or changes metadata. */
const WRITE_API_PATTERN =
  /\b(?:writeFile\w*|appendFile\w*|atomicReplaceFile|writeSecureFileAtomic|copyFile\w*|cp|cpSync|rm|rmSync|rmdir\w*|unlink\w*|rename\w*|truncate\w*|ftruncate\w*|mkdir\w*|mkdtemp\w*|symlink\w*|link|linkSync|chmod\w*|chown\w*|utimes\w*|createWriteStream|openSync|removeRecorded|removeSessionDirectory)\b/g;

function writeApisIn(source: string): string[] {
  return [...scanSource(source).code.matchAll(WRITE_API_PATTERN)].map((match) => match[0]);
}

/** Every module specifier `./watcher.ts` imports or re-exports. */
function importSpecifiersOf(source: string): string[] {
  const patterns = [
    /^import\s[\s\S]*?\sfrom\s'([^']+)';$/gm,
    /^export\s[\s\S]*?\sfrom\s'([^']+)';$/gm,
    /^import\s'([^']+)';$/gm,
  ];

  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]!));
}

// ---------------------------------------------------------------------------
// Phase 5 — the module writes nothing, and says nothing it should not
// ---------------------------------------------------------------------------

describe('non-mutation', () => {
  it('changes no byte of the project or $DEBUGGEN_HOME beyond the edits the developer made (headline)', async () => {
    const harness = await createHarness();
    const { ledger, tally } = await instrumentLedgerAndTally(harness);
    await startWatching(harness, [LEDGER_FILE, TALLY_FILE]);

    const before = await snapshotTree(harness.sandbox.root);
    const expected = new Map(before);
    const key = (file: string): string => `project/${file}`;

    // The backups the conflict report points at are part of what must survive.
    const backupEntries = [...before.keys()].filter((entry) => entry.startsWith('home/backups/'));
    expect(backupEntries).toContain(`home/backups/${SESSION_ID}/${ledger.originalHash}`);
    expect(backupEntries).toContain(`home/backups/${SESSION_ID}/${tally.originalHash}`);

    // 1. A no-op save.
    const unchangedBefore = unchangedEvaluations(harness, LEDGER_FILE);
    await writeFile(harness.pathOf(LEDGER_FILE), instrumentedOf(LEDGER_ORIGINAL));
    await waitForUnchangedEvaluations(harness, LEDGER_FILE, unchangedBefore + 1);

    // 2. An unrelated file.
    const notes = '# Ledger notes\n\nRewritten by the developer.\n';
    await writeFile(harness.pathOf(NOTES_FILE), notes);
    expected.set(key(NOTES_FILE), `file:${sha256Hex(notes)}`);

    // 3. An edit, reported as a conflict.
    const edited = `${instrumentedOf(LEDGER_ORIGINAL)}${DEVELOPER_LINE}\n`;
    await writeFile(harness.pathOf(LEDGER_FILE), edited);
    expected.set(key(LEDGER_FILE), `file:${sha256Hex(edited)}`);
    await waitForConflicts(harness, 1);

    // 4. A deletion, reported as a conflict.
    await unlink(harness.pathOf(TALLY_FILE));
    expected.delete(key(TALLY_FILE));
    await waitForConflicts(harness, 2);

    await quiet();
    await harness.watcher.stopSession(SESSION_ID);

    const after = await snapshotTree(harness.sandbox.root);
    expect(Object.fromEntries(after)).toEqual(Object.fromEntries(expected));
    expect(
      conflictTransitions(harness)
        .map((call) => call.id)
        .sort(),
    ).toEqual([ledger.id, tally.id].sort());
  });

  it('holds no write API in its code: no write, rename, truncate, delete or metadata change', () => {
    // The scanner itself: it sees a call, and it is not fooled by prose.
    expect(writeApisIn('await fsPromises.rename(from, to);')).toEqual(['rename']);
    expect(writeApisIn("// never renames or truncates\nconst label = 'rm unlink';")).toEqual([]);

    expect(writeApisIn(WATCHER_SOURCE)).toEqual([]);

    const { code } = scanSource(WATCHER_SOURCE);
    const fsMembers = new Set([...code.matchAll(/\bfsPromises\.(\w+)/g)].map((match) => match[1]));
    expect([...fsMembers].sort()).toEqual(['lstat', 'stat']);
    expect(WATCHER_SOURCE).toMatch(
      /^import \{ promises as fsPromises, watch as nodeWatch \} from 'node:fs';$/m,
    );
  });

  it('keeps file content, diff text, digests, backup paths and secrets out of every log record and row', async () => {
    const harness = await createHarness();
    const { ledger } = await instrumentLedgerAndTally(harness);
    await startWatching(harness, [LEDGER_FILE, TALLY_FILE]);
    const edited = `${instrumentedOf(LEDGER_ORIGINAL)}const planted = '${PLANTED_SECRET}';\n${DEVELOPER_LINE}\n`;

    await writeFile(harness.pathOf(LEDGER_FILE), edited);
    await waitForConflicts(harness, 1);
    await unlink(harness.pathOf(TALLY_FILE));
    await waitForConflicts(harness, 2);
    await quiet();

    const secretPrefix = new RegExp(['s', 'k-ant-'].join(''));
    const forbidden = [
      PLANTED_SECRET,
      DEVELOPER_LINE,
      PROBE_LINE,
      'sumOrchardCrates',
      'tallyLanterns',
      '@@ -1',
      ledger.diff,
    ];
    const logText = JSON.stringify(harness.logs);

    expect(harness.logs.length).toBeGreaterThan(0);
    expect(logText).not.toMatch(DIGEST_PATTERN);
    expect(logText).not.toMatch(secretPrefix);
    expect(logText).not.toContain(harness.sandbox.root);
    expect(logText).not.toContain(ledger.backupPath);

    const rows = harness.progress.emitted;
    const notices = harness.listener.calls.map((call) => call.notice);
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      const backupPath = CONFLICT_SENTENCE.exec(row.message)?.[2] ?? '';
      expect(backupPath.startsWith(harness.sandbox.debuggenHome)).toBe(true);
      expect(row.message.replace(backupPath, '‹backup›')).not.toMatch(DIGEST_PATTERN);
      expect(row.detail ?? '').not.toMatch(DIGEST_PATTERN);
    }

    const texts = [
      logText,
      JSON.stringify(rows),
      ...notices.flatMap((notice) => [notice.message, notice.detail]),
      ...harness.listener.calls.map((call) => call.conflict.message),
    ];

    for (const text of texts) {
      expect(text).not.toMatch(secretPrefix);

      for (const fragment of forbidden) {
        expect(text).not.toContain(fragment);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 6 — the structural guard
// ---------------------------------------------------------------------------

describe('module boundaries', () => {
  const specifiers = importSpecifiersOf(WATCHER_SOURCE);
  const { code, strings } = scanSource(WATCHER_SOURCE);
  const allowedPackages = new Set([
    '@debuggen/protocol',
    '@debuggen/telemetry',
    '@debuggen/instrumentation',
    '@debuggen/code-analysis',
    '@debuggen/shared',
    '@debuggen/shared/node',
  ]);

  it('reads its own imports', () => {
    expect(specifiers).toContain('node:fs');
    expect(specifiers).toContain('@debuggen/instrumentation');
    expect(specifiers).toContain('../store/modifications-repo.js');
  });

  it('imports neither its consumer nor its sibling readiness gate', () => {
    expect(specifiers).not.toContain('./service.js');
    expect(specifiers).not.toContain('./readiness.js');
  });

  it('spells every relative import with its .js extension', () => {
    const relative = specifiers.filter((specifier) => specifier.startsWith('.'));

    expect(relative.length).toBeGreaterThan(0);
    expect(relative.filter((specifier) => !specifier.endsWith('.js'))).toEqual([]);
  });

  it('imports only the permitted @debuggen packages and node: builtins', () => {
    const packages = specifiers.filter((specifier) => !specifier.startsWith('.'));

    expect(
      packages.filter(
        (specifier) => !specifier.startsWith('node:') && !allowedPackages.has(specifier),
      ),
    ).toEqual([]);
    expect(code).not.toMatch(/\bimport\s*\(/);
    expect(code).not.toMatch(/\brequire\s*\(/);
  });

  it('reads no environment, writes to no console and names no path of the demo application', () => {
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toMatch(/\bconsole\./);
    expect(WATCHER_SOURCE).not.toContain('apps/demo-app');
    expect(WATCHER_SOURCE).not.toMatch(/export default/);
  });

  it('invents no protocol message name and sends no frame of its own', () => {
    const messageShaped = strings.filter((literal) =>
      /^[a-z][a-z-]*(?:\.[a-z][a-z-]*)+$/.test(literal),
    );
    const known: readonly string[] = MESSAGE_TYPES;

    expect(messageShaped.filter((literal) => !known.includes(literal))).toEqual([]);
    expect(code).not.toMatch(/\.send\(|broadcast/);
  });

  it('holds no regular-expression literal, which keeps the scanner above exact', () => {
    expect(code).not.toMatch(/(?:^|[=(,:;!&|?{}]|\breturn)\s*\/(?![/*])[^/\n]+\/[dgimsuvy]*/m);
  });
});
