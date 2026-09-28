/**
 * Tests for `./cleanup.ts`: the inverse of the only sequence in this product
 * that writes into a developer's working tree.
 *
 * This suite is the unit-level proof of the cleanup guarantee, and the claim it
 * has to establish is narrow enough to state in one line: **a file comes back
 * byte-for-byte, and a developer's edit is never overwritten**. Everything
 * below is one of those two halves, or the bookkeeping that makes them provable
 * later — the per-status reconciliation table, the reverse-order unwinding of a
 * chain across plan versions, and the rule that a backup is deleted only after
 * the restored content verified against the digest it was recorded under.
 *
 * ## Three habits, each load-bearing
 *
 * - **The real patcher creates the state cleanup undoes.** Every case copies
 *   the committed fixture project into a fresh `mkdtemp` directory with its own
 *   temporary `$DEBUGGEN_HOME`, then runs `./patch/patcher.ts` over it with the
 *   real transform and the real content-addressed backup store. A hand-written
 *   "patched" fixture would hash differently, would carry a diff nothing
 *   produced, and would skip the journal ordering the whole reconciliation
 *   depends on — so the one thing this suite never does is write a file into
 *   the shape a patch would have left it in. Only the journal is in memory:
 *   that port is implemented over `node:sqlite` in the service, and this
 *   package never opens a database.
 * - **Byte comparison as well as digests.** A restored or preserved file is
 *   compared with `Buffer.compare` as well as by SHA-256, so a mistake in
 *   hashing cannot mask a mistake in content — and the CRLF case exists
 *   because hashing normalises nothing and restoration must not either.
 * - **The filesystem port is wrapped, never replaced.** `recordingFileSystem`
 *   delegates to the production primitives and records every path they were
 *   asked about, with the digest each write was made conditional on and the
 *   digest of the bytes it wrote. That is what turns "nothing was written",
 *   "each link of the chain was verified before its own write" and "the second
 *   pass did no I/O at all" into assertions rather than inferences.
 *
 * ## A conflict is a pass, not a failure
 *
 * Half of these cases end with a record in `conflict` and a cleanup status of
 * `conflict` — whatever else the same pass restored — and each of them is
 * asserting success: the
 * developer's bytes survived untouched, the pristine original is still
 * recoverable from the backup directory, and both user interfaces were handed a
 * report to show. The failure this suite is built to catch is the opposite one —
 * a restore that wrote over an edit — which is why every conflict case asserts
 * the file's exact content and an empty write log, not merely a status.
 */

import { Buffer } from 'node:buffer';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DebuggenError, createConsoleLogger, err, isErr, ok } from '@debuggen/shared';
import type { LogRecord, Result } from '@debuggen/shared';
import { sha256Hex } from '@debuggen/shared/node';
import type {
  AtomicCreateVerdict,
  AtomicReplaceExpectation,
  AtomicReplaceVerdict,
  FileSnapshot,
} from '@debuggen/shared/node';

import {
  RECONCILE_DISPOSITIONS,
  cleanupSession,
  defaultCleanupFileSystem,
  orderRestorationChain,
  reconcileDispositionFor,
  reconcileModifications,
  restoreChain,
  restoreModification,
} from './cleanup.js';
import type { CleanupContext, CleanupFileSystem, CleanupStatus, RecordScope } from './cleanup.js';
import { createBackupStore } from './patch/backup-store.js';
import type { BackupStore, RecordedBackup } from './patch/backup-store.js';
import { createPatcher } from './patch/patcher.js';
import type { PatchOutcome } from './patch/patcher.js';
import { SPAN_HELPER_GLOBAL } from './patch/wrap-template.js';
import { MODIFICATION_STATUSES } from './schema/modification.js';
import type {
  ModificationConflictReason,
  ModificationJournal,
  ModificationRecord,
  ModificationStatus,
  ModificationStatusPatch,
} from './schema/modification.js';

/*
 * ---------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------
 */

/**
 * The committed fixture project every case copies.
 *
 * Resolved from `import.meta.url` rather than `process.cwd()`: this package's
 * Vitest project runs from the repository root, so a relative path would
 * resolve there instead of beside this file.
 */
const FIXTURE_PROJECT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'project-a',
);

/** The fixture file most cases patch, project-relative POSIX. */
const TARGET_FILE = 'src/server/cycle-planner.ts';

/** A named declaration in {@link TARGET_FILE} the transform can wrap. */
const TARGET_SYMBOL = 'planCycleSegments';

/**
 * A second declaration in the same file.
 *
 * What makes the chain case possible: a follow-up plan version patching this
 * symbol writes over content the first version produced, so its record's
 * `originalHash` is the first record's `instrumentedHash`.
 */
const SECOND_SYMBOL = 'estimateSoakMinutes';

/** A second fixture file, for the pass that must end `partial`. */
const OTHER_FILE = 'src/server/cone-rules.ts';

/** A named declaration in {@link OTHER_FILE}. */
const OTHER_SYMBOL = 'assertConeValue';

/**
 * A second declaration in {@link OTHER_FILE}.
 *
 * With {@link OTHER_THIRD_SYMBOL} it is what lets one file carry three plan
 * versions: each version wraps one more declaration of the bytes the previous
 * version wrote, so the chain is three real patches rather than fabricated
 * records.
 */
const OTHER_SECOND_SYMBOL = 'findConeProfile';

/** A third declaration in {@link OTHER_FILE}. See {@link OTHER_SECOND_SYMBOL}. */
const OTHER_THIRD_SYMBOL = 'findRampCeiling';

/** A plain-JavaScript fixture file: the variant patched without a type alias. */
const LEGACY_FILE = 'src/legacy/bisque-schedule.js';

/** A named declaration in {@link LEGACY_FILE}. */
const LEGACY_SYMBOL = 'planBisqueRamp';

/** A file this suite writes with CRLF line endings, to prove raw-byte fidelity. */
const CRLF_FILE = 'src/server/crlf-notes.ts';

/** The declaration in {@link CRLF_FILE}. */
const CRLF_SYMBOL = 'tallyCrlfNotes';

/** {@link CRLF_FILE}'s content: ordinary source, every line ended with CRLF. */
const CRLF_BYTES = Buffer.from(
  [
    '/** Counts the notes pinned to one schedule sheet. */',
    `export function ${CRLF_SYMBOL}(count: number): number {`,
    '  return count + 1;',
    '}',
    '',
  ].join('\r\n'),
  'utf8',
);

/**
 * Content planted outside the project, which no case may read or write.
 *
 * It holds a declaration the transform could wrap, so a pass that escaped the
 * project root would actually rewrite this file and the byte comparison at the
 * end of the containment cases would catch it.
 */
const OUTSIDE_CONTENT = Buffer.from(
  '/** Outside the project. */\nexport function outsideTheProject(): number {\n  return 1;\n}\n',
  'utf8',
);

/** The name of the file planted outside the project. */
const OUTSIDE_FILE = 'outside-notes.ts';

/** The line a developer is taken to have saved on top of an instrumented file. */
const DEVELOPER_EDIT = '\n// Reviewer: keep this line. It is the developer’s own edit.\n';

/**
 * The reading every injected clock returns.
 *
 * Fixed so `ModificationConflict.detectedAt`, the `appliedAt` of a status
 * transition and `CleanupOutcome.completedAt` can be asserted exactly rather
 * than bounded — and so a pass that read the system clock instead of the
 * injected one is visible.
 */
const FIXED_NOW = 1_777_000_000_000;

/**
 * Statuses an owning session may be in while its records are reconciled.
 *
 * A reconciliation pass must act on an open record *whatever* state its
 * session is in, and `./cleanup.ts` cannot even ask: `ModificationJournal`
 * exposes no session status. Each case therefore notes one of these on the
 * journal as metadata the port cannot reach, and asserts the pass acted anyway —
 * `'ended'` is deliberately absent from the list.
 */
const OPEN_SESSION_STATUSES = Object.freeze([
  'instrumenting',
  'ready',
  'capturing',
  'analyzing',
  'generated',
  'failed',
] as const);

/*
 * ---------------------------------------------------------------------------
 * The in-memory journal
 * ---------------------------------------------------------------------------
 */

/** One call a pass made on the journal, in the order it was made. */
type JournalCall =
  | { readonly kind: 'append'; readonly recordId: string }
  | {
      readonly kind: 'updateStatus';
      readonly recordId: string;
      readonly status: ModificationStatus;
    }
  | { readonly kind: 'listBySession'; readonly sessionId: string }
  | { readonly kind: 'listOpen' };

/** One status transition a pass journaled. */
interface JournalTransition {
  /** The record that moved. */
  readonly recordId: string;

  /** Where it moved to. */
  readonly status: ModificationStatus;
}

/** The journal port, plus what a case needs to arrange and inspect it. */
interface TestJournal extends ModificationJournal {
  /** Every call, in order, so reverse-order restoration is assertable. */
  readonly calls: JournalCall[];

  /** Every record, in append order, as the journal currently holds it. */
  readonly rows: () => ModificationRecord[];

  /** One record by id, or a failed test naming the id. */
  readonly row: (id: string) => ModificationRecord;

  /**
   * The status transitions of {@link TestJournal.calls}, in order.
   *
   * @param from The call index to start from, as {@link World.mark} reports it.
   * The patcher journals a `pending` append and an `applied` transition of its
   * own, so a case that wants only what the pass under test did marks the log
   * first.
   */
  readonly transitions: (from?: number) => JournalTransition[];

  /**
   * Replaces a row **without recording a call**.
   *
   * How a case arranges the state a crash, an earlier pass or another process
   * would have left behind — a record still `pending` after its write landed, a
   * record carried over in `conflict` — without putting a transition in the log
   * that the pass under test did not make.
   */
  readonly arrange: (record: ModificationRecord) => void;

  /** Notes the owning session's status, which the port deliberately cannot expose. */
  readonly noteSessionStatus: (sessionId: string, status: string) => void;

  /** What {@link TestJournal.noteSessionStatus} was told, for the independence assertion. */
  readonly sessionStatusOf: (sessionId: string) => string | undefined;
}

/** What a case varies about the journal. */
interface TestJournalOptions {
  /**
   * Whether `listOpen` wrongly includes `reverted` records.
   *
   * The port's contract excludes them, and the default here honours it. One
   * case turns this on, because `./cleanup.ts` filters by its own disposition
   * table rather than trusting the query — a port implemented twice is a port
   * that can answer wrongly, and this pass is the one that must not act on a
   * wrong answer.
   */
  readonly listOpenIncludesReverted?: boolean | undefined;
}

/**
 * A journal that stores records in memory and applies status transitions.
 *
 * Insertion order is preserved, `listBySession` returns one session's records in
 * that order, `listOpen` excludes `reverted` records, `updateStatus` applies the
 * patch and returns the updated record, nothing is mutated in place and an
 * unknown id comes back as `err(STORE_ERROR)` rather than as an exception —
 * which is the whole of the port's required semantics.
 *
 * @param options Whether `listOpen` should answer wrongly.
 * @returns The journal.
 */
function createTestJournal(options: TestJournalOptions = {}): TestJournal {
  const rows = new Map<string, ModificationRecord>();
  const sessionStatuses = new Map<string, string>();
  const calls: JournalCall[] = [];

  const missing = (id: string, status?: ModificationStatus): DebuggenError =>
    new DebuggenError('STORE_ERROR', 'The suite journal holds no record under that id.', {
      hint: 'A pass asked to update a record that was never appended.',
      details: { recordId: id, ...(status === undefined ? {} : { status }) },
    });

  return {
    calls,
    rows: (): ModificationRecord[] => [...rows.values()],
    row: (id: string): ModificationRecord => {
      const found = rows.get(id);

      if (found === undefined) {
        throw new Error(`The suite journal holds no record under the id ${id}.`);
      }

      return found;
    },
    transitions: (from = 0): JournalTransition[] =>
      calls
        .slice(from)
        .filter((call): call is Extract<JournalCall, { kind: 'updateStatus' }> => {
          return call.kind === 'updateStatus';
        })
        .map((call) => ({ recordId: call.recordId, status: call.status })),
    arrange: (record: ModificationRecord): void => {
      rows.set(record.id, record);
    },
    noteSessionStatus: (sessionId: string, status: string): void => {
      sessionStatuses.set(sessionId, status);
    },
    sessionStatusOf: (sessionId: string): string | undefined => sessionStatuses.get(sessionId),
    append: (record: ModificationRecord): Promise<Result<ModificationRecord>> => {
      calls.push({ kind: 'append', recordId: record.id });
      rows.set(record.id, record);

      return Promise.resolve(ok(record));
    },
    updateStatus: (
      id: string,
      status: ModificationStatus,
      patch?: ModificationStatusPatch,
    ): Promise<Result<ModificationRecord>> => {
      calls.push({ kind: 'updateStatus', recordId: id, status });

      const current = rows.get(id);

      if (current === undefined) {
        return Promise.resolve(err(missing(id, status)));
      }

      // A fresh object, never an edit of the stored one: a caller that kept a
      // reference must not observe a status the journal never handed it.
      const next: ModificationRecord = {
        ...current,
        ...(patch?.instrumentedHash === undefined
          ? {}
          : { instrumentedHash: patch.instrumentedHash }),
        ...(patch?.diff === undefined ? {} : { diff: patch.diff }),
        ...(patch?.appliedAt === undefined ? {} : { appliedAt: patch.appliedAt }),
        ...(patch?.backupPath === undefined ? {} : { backupPath: patch.backupPath }),
        status,
      };

      rows.set(id, next);

      return Promise.resolve(ok(next));
    },
    listBySession: (sessionId: string): Promise<Result<ModificationRecord[]>> => {
      calls.push({ kind: 'listBySession', sessionId });

      return Promise.resolve(ok([...rows.values()].filter((row) => row.sessionId === sessionId)));
    },
    listOpen: (): Promise<Result<ModificationRecord[]>> => {
      calls.push({ kind: 'listOpen' });

      return Promise.resolve(
        ok(
          [...rows.values()].filter(
            (row) => options.listOpenIncludesReverted === true || row.status !== 'reverted',
          ),
        ),
      );
    },
  };
}

/*
 * ---------------------------------------------------------------------------
 * The recording filesystem
 * ---------------------------------------------------------------------------
 */

/** One write a pass performed, with the digests that authorised it. */
interface WriteAttempt {
  /** The absolute path written. */
  readonly path: string;

  /**
   * SHA-256 of the bytes the write was made conditional on.
   *
   * For a conditional replacement this is the digest of the content the pass
   * had just read, which must equal that record's `instrumentedHash` — the
   * authority for "this file is still ours". `undefined` for the no-clobber
   * create that recreates a target that is no longer there, whose only
   * condition is that the path is still empty.
   */
  readonly expectedHash: string | undefined;

  /** SHA-256 of the bytes the pass asked to write, which must be the recorded original. */
  readonly contentHash: string;
}

/** Every path the production primitives were asked about, by operation. */
interface FileSystemLog {
  /** Paths handed to `readFileBytes`. */
  readonly reads: string[];

  /** Paths handed to `readFileSnapshot`. */
  readonly snapshots: string[];

  /** Paths handed to `realPath`. */
  readonly resolutions: string[];

  /** Conditional replacements, in order. */
  readonly writes: WriteAttempt[];

  /**
   * No-clobber creates — a target that was gone and had to be recreated — each
   * with the verdict the production primitive returned.
   */
  readonly creates: CreateAttempt[];
}

/** One no-clobber create a pass asked for, and what the filesystem answered. */
interface CreateAttempt extends WriteAttempt {
  /** `created` when the original was installed, `exists` when nothing was written. */
  readonly verdict: AtomicCreateVerdict['kind'];
}

/** What a case asks the recording port to do beyond recording. */
interface RecordingFileSystemOptions {
  /**
   * Appends a byte to every conditional replacement, so the restored content
   * cannot hash to `originalHash`.
   *
   * The only way to reach the verification branch: a filesystem that wrote
   * something other than what it was handed. Nothing else in the sequence can
   * produce content that passes the backup's own digest check and then fails
   * the post-write one.
   */
  readonly corruptWrite?: boolean | undefined;

  /**
   * Runs immediately after the numbered conditional replacement lands.
   *
   * How a case becomes a race the way it happens in practice: a callback that
   * appends a line after the first write of a chain is precisely a developer
   * saving the file between two restores.
   */
  readonly afterWrite?: ((attempt: number, path: string) => void) | undefined;

  /**
   * Runs immediately before a no-clobber create is delegated, after the pass
   * decided the target was missing.
   *
   * How the recreate race becomes a case: a callback that writes the path here
   * is precisely a developer recreating the file between cleanup's observation
   * that it was gone and the write that would have put the original back.
   */
  readonly beforeCreate?: ((path: string) => void) | undefined;
}

/**
 * The production filesystem port, wrapped so every path it was asked about is
 * recorded.
 *
 * Delegating rather than faking is the point. "Nothing was written" and "no I/O
 * happened outside the project at all" are claims about the *real* primitives;
 * a fake port could only make them about itself.
 *
 * @param options Corruption and race hooks, all off by default.
 * @returns The port, its log, and a reset for a case that measures two passes
 * separately.
 */
function recordingFileSystem(options: RecordingFileSystemOptions = {}): {
  readonly files: CleanupFileSystem;
  readonly log: FileSystemLog;
  readonly reset: () => void;
} {
  const log: FileSystemLog = { reads: [], snapshots: [], resolutions: [], writes: [], creates: [] };
  // Counted separately from the log so `reset` cannot renumber the race hook.
  let attempts = 0;

  const files: CleanupFileSystem = {
    readFileBytes: (path: string): Uint8Array => {
      log.reads.push(path);

      return defaultCleanupFileSystem.readFileBytes(path);
    },
    hashBytes: defaultCleanupFileSystem.hashBytes,
    realPath: (path: string): string => {
      log.resolutions.push(path);

      return defaultCleanupFileSystem.realPath(path);
    },
    readFileSnapshot: (path: string): FileSnapshot => {
      log.snapshots.push(path);

      return defaultCleanupFileSystem.readFileSnapshot(path);
    },
    replaceFileIfUnchanged: (
      path: string,
      content: Uint8Array,
      expected: AtomicReplaceExpectation,
    ): AtomicReplaceVerdict => {
      attempts += 1;
      log.writes.push({
        path,
        expectedHash: sha256Hex(expected.bytes),
        contentHash: sha256Hex(content),
      });

      const bytes =
        options.corruptWrite === true
          ? Buffer.concat([Buffer.from(content), Buffer.from('\n', 'utf8')])
          : content;
      const verdict = defaultCleanupFileSystem.replaceFileIfUnchanged(path, bytes, expected);

      if (verdict.kind === 'replaced' && options.afterWrite !== undefined) {
        options.afterWrite(attempts, path);
      }

      return verdict;
    },
    createFileIfAbsent: (path: string, content: Uint8Array): AtomicCreateVerdict => {
      options.beforeCreate?.(path);

      const verdict = defaultCleanupFileSystem.createFileIfAbsent(path, content);

      log.creates.push({
        path,
        expectedHash: undefined,
        contentHash: sha256Hex(content),
        verdict: verdict.kind,
      });

      return verdict;
    },
  };

  return {
    files,
    log,
    reset: (): void => {
      log.reads.length = 0;
      log.snapshots.length = 0;
      log.resolutions.length = 0;
      log.writes.length = 0;
      log.creates.length = 0;
    },
  };
}

/** One `BackupStore.remove` call, with what the filesystem held when it was made. */
interface BackupRemoval {
  /** The digest whose backup was being deleted. */
  readonly digest: string;

  /** The digest the caller declared it had restored, if it declared one. */
  readonly restoredContentHash: string | undefined;

  /**
   * SHA-256 of the watched file at the moment of the call, or `undefined` when
   * no file is watched or it is not there.
   *
   * This is the proof of deletion order: a backup may be deleted only *after*
   * the restored content verified, so at the moment of the delete the file must
   * already hold the recorded original.
   */
  readonly watchedDigest: string | undefined;
}

/**
 * The real backup store, wrapped so deletions are observable.
 *
 * Every other operation is delegated untouched, so a backup is still written,
 * read back and digest-checked by the production store: only the moment of a
 * deletion is reported, and it is reported *before* it happens, which is what
 * lets a case sample the filesystem as the store saw it. Both deletion routes
 * are observed — the digest-keyed `remove` and the record-path
 * `removeRecorded` cleanup takes for the backup a journal row names — so a
 * case's removal count does not depend on which one a pass used.
 *
 * @param store The store to delegate to.
 * @param onRemove Called before each deletion is delegated, with the digest and
 * the restored-content digest the caller declared.
 * @returns A store with the same behaviour and observed deletions.
 */
function spyBackupStore(
  store: BackupStore,
  onRemove: (digest: string, restoredContentHash: string | undefined) => void,
): BackupStore {
  return {
    sessionId: store.sessionId,
    sessionDirectory: store.sessionDirectory,
    locate: (digest: string) => store.locate(digest),
    locateRecorded: (recordedPath: string, digest: string) =>
      store.locateRecorded(recordedPath, digest),
    put: (digest: string, content: Uint8Array) => store.put(digest, content),
    read: (digest: string) => store.read(digest),
    readRecorded: (recordedPath: string, digest: string) =>
      store.readRecorded(recordedPath, digest),
    has: (digest: string) => store.has(digest),
    verify: (digest: string) => store.verify(digest),
    remove: (digest, removeOptions) => {
      onRemove(digest, removeOptions?.restoredContentHash);

      return store.remove(digest, removeOptions);
    },
    removeRecorded: (recordedPath, digest, removeOptions) => {
      onRemove(digest, removeOptions?.restoredContentHash);

      return store.removeRecorded(recordedPath, digest, removeOptions);
    },
    removeSessionDirectory: () => store.removeSessionDirectory(),
  };
}

/*
 * ---------------------------------------------------------------------------
 * The sandbox
 * ---------------------------------------------------------------------------
 */

/** One case's temporary world: a project copy, a state root, a journal and a session. */
interface World {
  /** The directory holding everything this case created. */
  readonly root: string;

  /** The copied fixture project, which is every pass's `projectRoot`. */
  readonly projectRoot: string;

  /** The temporary `$DEBUGGEN_HOME` the backup stores write under. */
  readonly debuggenHome: string;

  /** The session the context belongs to. */
  readonly sessionId: string;

  /** The journal every patcher appends to and every pass reads. */
  readonly journal: TestJournal;

  /** {@link World.sessionId}'s backup store, as the context carries it. */
  readonly backups: BackupStore;

  /** Any session's backup store, memoised — a service-start pass spans sessions. */
  readonly storeFor: (sessionId: string) => BackupStore;

  /** The context a pass is given: the recording filesystem and the fixed clock. */
  readonly context: CleanupContext;

  /** What the recording filesystem was asked to do. */
  readonly log: FileSystemLog;

  /** Every backup deletion any of this world's stores performed, in order. */
  readonly removals: BackupRemoval[];

  /** Absolute path of a project-relative file inside the copy. */
  readonly pathOf: (relative: string) => string;

  /** Absolute path a digest's backup occupies in {@link World.sessionId}'s directory. */
  readonly backupPathOf: (digest: string) => string;

  /** Samples this file's digest on every backup deletion from now on. */
  readonly watch: (relative: string) => void;

  /**
   * Where the journal's call log currently ends.
   *
   * Taken before a pass, so `journal.transitions(mark)` reports what *that
   * pass* journaled rather than also the patcher's own `applied` transitions.
   */
  readonly mark: () => number;

  /**
   * Clears the filesystem log and the observed backup deletions, so two passes
   * can be measured separately.
   */
  readonly resetLog: () => void;
}

/** What a case varies about its world. */
interface WorldOptions {
  /** Corruption and race hooks for the recording filesystem. */
  readonly files?: RecordingFileSystemOptions | undefined;

  /** Whether the journal answers `listOpen` wrongly. */
  readonly journal?: TestJournalOptions | undefined;

  /** A name for the sandbox directory, where a case builds more than one. */
  readonly name?: string | undefined;

  /**
   * Runs after each backup deletion is recorded and before it is delegated.
   *
   * The one interval that is genuinely *between* two records of a chain: the
   * earlier record's restore has been written, verified and journaled, and the
   * next record's has not begun. A callback that edits the project file here is
   * a developer saving it between two restores — which is where the chain has
   * to stop rather than write an earlier version's backup over it.
   *
   * The project root is passed in rather than read off the world, so a case can
   * install the hook while it is still building the world.
   */
  readonly afterBackupRemoval?: ((removal: BackupRemoval, projectRoot: string) => void) | undefined;
}

/** The directory every sandbox of the current case lives in. */
let caseRoot = '';

/** The session ids handed out so far, so each is unique and readable in a failure. */
let sessionCounter = 0;

// Every case here runs the real patcher and the real filesystem primitives —
// ts-morph parses, `fsync`s, renames — several times over, and a chain case
// does it once per link. On a shared, loaded runner that legitimately takes
// longer than Vitest's 5 s default, so the budget is the one the installer
// suite gives the same work; a case that hangs still fails.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

beforeEach(() => {
  caseRoot = mkdtempSync(join(tmpdir(), 'debuggen-cleanup-'));
  sessionCounter = 0;
});

afterEach(() => {
  // Every byte this suite wrote lived under here: the project copy, the state
  // root, the backups. The committed fixture is never touched, which is what
  // keeps `git status --porcelain packages/instrumentation` empty after a run.
  rmSync(caseRoot, { recursive: true, force: true });
  caseRoot = '';
});

/**
 * A session id that is unique within the case and readable in a failure
 * message.
 *
 * Not `newSessionId()`: a random id tells nobody which patch a record came
 * from when an assertion fails, and the schema accepts any non-blank id without
 * control characters precisely so a fixture may spell one.
 *
 * @param label A short word naming the session's role in the case.
 * @returns The id.
 */
function nextSessionId(label = 'case'): string {
  sessionCounter += 1;

  return `ses_${label}_${String(sessionCounter).padStart(4, '0')}`;
}

/**
 * Copies the fixture project and wires a journal, a backup store, a recording
 * filesystem and a fixed clock over it.
 *
 * A copy per case, never the committed fixture itself: the real patcher runs
 * here and writes real bytes.
 *
 * @param options Filesystem hooks, journal behaviour and a directory name.
 * @returns The world.
 */
function makeWorld(options: WorldOptions = {}): World {
  const root = join(caseRoot, options.name ?? 'world');
  const projectRoot = join(root, 'project');
  const debuggenHome = join(root, 'home');

  cpSync(FIXTURE_PROJECT, projectRoot, { recursive: true });
  // `0700`, because the backup store asserts its own state root is private and
  // owned by this account before it writes a single original into it.
  mkdirSync(debuggenHome, { recursive: true, mode: 0o700 });
  chmodSync(debuggenHome, 0o700);

  const sessionId = nextSessionId();
  const journal = createTestJournal(options.journal ?? {});
  const { files, log, reset } = recordingFileSystem(options.files ?? {});
  const removals: BackupRemoval[] = [];
  const stores = new Map<string, BackupStore>();
  const watched: { relative: string | undefined } = { relative: undefined };

  const storeFor = (id: string): BackupStore => {
    const existing = stores.get(id);

    if (existing !== undefined) {
      return existing;
    }

    const created = spyBackupStore(
      createBackupStore({ debuggenHome, sessionId: id }),
      (digest, restoredContentHash) => {
        const path =
          watched.relative === undefined ? undefined : join(projectRoot, watched.relative);

        const removal: BackupRemoval = {
          digest,
          restoredContentHash,
          watchedDigest: path === undefined || !existsSync(path) ? undefined : digestOf(path),
        };

        removals.push(removal);
        options.afterBackupRemoval?.(removal, projectRoot);
      },
    );

    stores.set(id, created);

    return created;
  };

  const backups = storeFor(sessionId);

  return {
    root,
    projectRoot,
    debuggenHome,
    sessionId,
    journal,
    backups,
    storeFor,
    context: {
      projectRoot,
      backups,
      journal,
      files,
      now: (): number => FIXED_NOW,
    },
    log,
    removals,
    pathOf: (relative: string): string => join(projectRoot, relative),
    backupPathOf: (digest: string): string => join(debuggenHome, 'backups', sessionId, digest),
    watch: (relative: string): void => {
      watched.relative = relative;
    },
    mark: (): number => journal.calls.length,
    resetLog: (): void => {
      reset();
      removals.length = 0;
    },
  };
}

/** What a case asks the real patcher to install. */
interface PatchRequest {
  /** The project-relative file to patch. */
  readonly file: string;

  /** The declaration in it to wrap. */
  readonly symbol: string;

  /** The plan version to stamp the record with. Defaults to 1. */
  readonly planVersion?: number | undefined;

  /** The owning session. Defaults to the world's own. */
  readonly sessionId?: string | undefined;
}

/** What one real patch produced, with the bytes on either side of it. */
interface PatchedFile {
  /** The journaled record, in its `applied` state. */
  readonly record: ModificationRecord;

  /** Everything else the patcher reported, including the transform's result. */
  readonly outcome: PatchOutcome;

  /** The absolute path of the patched file. */
  readonly path: string;

  /** Its project-relative path. */
  readonly file: string;

  /** The file's bytes before the patch: what cleanup has to bring back. */
  readonly originalBytes: Buffer;

  /** The file's bytes after it: what cleanup must find before it writes. */
  readonly instrumentedBytes: Buffer;
}

/**
 * Installs one patch with the **real** patcher, the real transform and the real
 * backup store.
 *
 * This is the only way state under test is created. A fixture written into the
 * shape a patch would have left it in would hash differently, carry a diff
 * nothing produced, and leave the journal without the record ordering
 * restoration depends on.
 *
 * @param world The sandbox to patch inside.
 * @param request The file, symbol, plan version and owning session.
 * @returns The record and the bytes on either side of the patch.
 */
async function patchSymbol(world: World, request: PatchRequest): Promise<PatchedFile> {
  const sessionId = request.sessionId ?? world.sessionId;
  const path = world.pathOf(request.file);
  const originalBytes = readFileSync(path);

  const patcher = createPatcher({
    projectRoot: world.projectRoot,
    sessionId,
    planVersion: request.planVersion ?? 1,
    backups: world.storeFor(sessionId),
    journal: world.journal,
  });

  const result = await patcher.patchTarget({ file: request.file, symbol: request.symbol });

  if (isErr(result)) {
    throw new Error(
      `Expected ${request.file}#${request.symbol} to be patched, received ${result.error.code}: ${result.error.message} ${JSON.stringify(result.error.details)}`,
    );
  }

  return {
    record: result.value.record,
    outcome: result.value,
    path,
    file: request.file,
    originalBytes,
    instrumentedBytes: readFileSync(path),
  };
}

/*
 * ---------------------------------------------------------------------------
 * Assertion helpers
 * ---------------------------------------------------------------------------
 */

/** SHA-256 of whatever is on disk at `path`, as the reconciliation table reads it. */
function digestOf(path: string): string {
  return sha256Hex(readFileSync(path));
}

/** Asserts the file at `path` holds exactly `expected`, byte for byte. */
function expectFileBytes(path: string, expected: Buffer | Uint8Array): void {
  const actual = readFileSync(path);

  expect(actual.byteLength).toBe(expected.byteLength);
  expect(Buffer.compare(actual, Buffer.from(expected))).toBe(0);
}

/** The single element of `items`, or a failed test naming what was there instead. */
function only<T>(items: readonly T[], what: string): T {
  expect(items, `expected exactly one ${what}`).toHaveLength(1);

  const first = items[0];

  if (first === undefined) {
    throw new Error(`Expected exactly one ${what}, received none.`);
  }

  return first;
}

/** The value of a successful result, or a failed test naming the refusal. */
function expectOk<T>(result: Result<T>, what: string): T {
  if (isErr(result)) {
    throw new Error(
      `Expected ${what}, received ${result.error.code}: ${result.error.message} ${JSON.stringify(result.error.details)}`,
    );
  }

  return result.value;
}

/** The error of a refused result, or a failed test naming what it produced instead. */
function refusalOf<T>(result: Result<T>, what: string): DebuggenError {
  if (!isErr(result)) {
    throw new Error(`Expected ${what} to be refused, received ${JSON.stringify(result.value)}`);
  }

  return result.error;
}

/** Asserts that nothing at all was written through the recording port. */
function expectNothingWritten(log: FileSystemLog): void {
  expect(log.writes).toEqual([]);
  expect(log.creates).toEqual([]);
}

/** Asserts that the port was not touched at all: no read, no resolution, no write. */
function expectNoFileSystemAccess(log: FileSystemLog): void {
  expect(log.reads).toEqual([]);
  expect(log.snapshots).toEqual([]);
  expect(log.resolutions).toEqual([]);
  expectNothingWritten(log);
}

/** Appends a line to a file the way a developer saving it would, and returns the new bytes. */
function developerEdits(path: string): Buffer {
  const edited = Buffer.concat([readFileSync(path), Buffer.from(DEVELOPER_EDIT, 'utf8')]);

  writeFileSync(path, edited);

  return edited;
}

/*
 * ---------------------------------------------------------------------------
 * Apply, revert, byte-equality
 * ---------------------------------------------------------------------------
 */

describe('applying a patch and reverting it', () => {
  it('brings the file back byte-for-byte, marks the record reverted and deletes the backup', async () => {
    const world = makeWorld();

    world.journal.noteSessionStatus(world.sessionId, 'capturing');

    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    // The patch really did change the file, and the change is on the record as
    // a unified diff — "every modification tracked and visible" is what makes
    // the revert below meaningful rather than a no-op that always passes.
    expect(Buffer.compare(patched.instrumentedBytes, patched.originalBytes)).not.toBe(0);
    expect(digestOf(patched.path)).toBe(patched.record.instrumentedHash);
    expect(patched.record.originalHash).toBe(sha256Hex(patched.originalBytes));
    expect(patched.record.status).toBe('applied');
    expect(patched.record.diff).toContain(`--- ${TARGET_FILE}`);
    expect(patched.record.diff).toContain(`+++ ${TARGET_FILE}`);
    expect(
      patched.record.diff
        .split('\n')
        .some((line) => line.startsWith('+') && !line.startsWith('+++')),
    ).toBe(true);
    expect(existsSync(world.backupPathOf(patched.record.originalHash))).toBe(true);

    world.watch(TARGET_FILE);
    world.resetLog();

    const mark = world.mark();
    const outcome = await cleanupSession(world.sessionId, world.context);

    expect(outcome.sessionId).toBe(world.sessionId);
    expect(outcome.status).toBe('clean');
    expect(outcome.completedAt).toBe(FIXED_NOW);
    expect(outcome.restored.map((record) => record.id)).toEqual([patched.record.id]);
    expect(only(outcome.restored, 'restored record').status).toBe('reverted');
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.failures).toEqual([]);

    // The cleanup guarantee, asserted on the bytes and on the digest.
    expectFileBytes(patched.path, patched.originalBytes);
    expect(digestOf(patched.path)).toBe(patched.record.originalHash);

    // The write was conditional on the instrumented content and wrote the
    // recorded original: the two digests that authorise a restore.
    const write = only(world.log.writes, 'conditional write');
    expect(write.path.endsWith(TARGET_FILE)).toBe(true);
    expect(write.expectedHash).toBe(patched.record.instrumentedHash);
    expect(write.contentHash).toBe(patched.record.originalHash);
    expect(world.log.creates).toEqual([]);

    expect(world.journal.row(patched.record.id).status).toBe('reverted');
    expect(world.journal.row(patched.record.id).appliedAt).toBe(FIXED_NOW);
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: patched.record.id, status: 'reverted' },
    ]);

    // The backup is gone, and it went only after the restored content verified.
    expect(existsSync(world.backupPathOf(patched.record.originalHash))).toBe(false);
    const removal = only(world.removals, 'backup deletion');
    expect(removal.digest).toBe(patched.record.originalHash);
    expect(removal.restoredContentHash).toBe(patched.record.originalHash);
    expect(removal.watchedDigest).toBe(patched.record.originalHash);

    // Housekeeping: a clean pass leaves nothing behind in the product's own
    // state directory either.
    expect(existsSync(world.backups.sessionDirectory)).toBe(false);
    expect(world.journal.sessionStatusOf(world.sessionId)).toBe('capturing');
  });

  it('keeps the session backup directory when the caller asks for it, having still deleted the backup', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    const outcome = await cleanupSession(world.sessionId, world.context, {
      keepBackupDirectory: true,
    });

    expect(outcome.status).toBe('clean');
    expectFileBytes(patched.path, patched.originalBytes);
    expect(existsSync(world.backupPathOf(patched.record.originalHash))).toBe(false);
    expect(existsSync(world.backups.sessionDirectory)).toBe(true);
  });

  it('reverts a single record on its own, for the installer unwinding a failed delta', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    world.watch(TARGET_FILE);
    world.resetLog();

    const outcome = expectOk(
      await restoreModification(patched.record, world.context),
      'a restore outcome',
    );

    expect(outcome.kind).toBe('restored');
    expect(outcome.wrote).toBe(true);
    expect(outcome.recreated).toBe(false);
    expect(outcome.backup).toBe('deleted');
    expect(outcome.conflict).toBeUndefined();
    expect(outcome.record.status).toBe('reverted');
    expect(outcome.file).toBe(TARGET_FILE);
    expect(outcome.completedAt).toBe(FIXED_NOW);
    expectFileBytes(patched.path, patched.originalBytes);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The backup directory of an ended session
 * ---------------------------------------------------------------------------
 */

/**
 * `store` with its directory removals counted, everything else delegated.
 *
 * @param store The session's store.
 * @returns The counting store and a reading of how often it was asked.
 */
function countingDirectoryRemovals(store: BackupStore): {
  readonly store: BackupStore;
  readonly removals: () => number;
} {
  let removals = 0;

  return {
    store: {
      ...store,
      removeSessionDirectory: () => {
        removals += 1;

        return store.removeSessionDirectory();
      },
    },
    removals: () => removals,
  };
}

describe('the backup directory of an ended session', () => {
  it('is removed once an install rollback reverted every record, though the pass restores nothing', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    // The installer unwinding a failed install: the record is reverted and its
    // backup deleted as verified, which leaves the session's directory empty.
    expect(
      expectOk(await restoreModification(patched.record, world.context), 'the rollback').kind,
    ).toBe('restored');
    expect(world.journal.row(patched.record.id).status).toBe('reverted');
    expect(readdirSync(world.backups.sessionDirectory)).toEqual([]);

    world.resetLog();

    const mark = world.mark();
    const counted = countingDirectoryRemovals(world.backups);
    const outcome = await cleanupSession(world.sessionId, {
      ...world.context,
      backups: counted.store,
    });

    expect(outcome.status).toBe('clean');
    expect(outcome.restored).toEqual([]);
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.failures).toEqual([]);

    // Nothing of the project was looked at, nothing journaled, no backup
    // deleted — only the emptied directory went.
    expectNoFileSystemAccess(world.log);
    expect(world.journal.transitions(mark)).toEqual([]);
    expect(world.removals).toEqual([]);
    expect(counted.removals()).toBe(1);
    expect(existsSync(world.backups.sessionDirectory)).toBe(false);
    expectFileBytes(patched.path, patched.originalBytes);

    // Once it is gone, a repeated end does not ask the store anything.
    const again = await cleanupSession(world.sessionId, {
      ...world.context,
      backups: counted.store,
    });

    expect(again.status).toBe('clean');
    expect(counted.removals()).toBe(1);
    expectNoFileSystemAccess(world.log);
  });

  it('keeps a rollback-emptied directory when the caller asks for it', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    expectOk(await restoreModification(patched.record, world.context), 'the rollback');

    const outcome = await cleanupSession(world.sessionId, world.context, {
      keepBackupDirectory: true,
    });

    expect(outcome.status).toBe('clean');
    expect(existsSync(world.backups.sessionDirectory)).toBe(true);
    expect(readdirSync(world.backups.sessionDirectory)).toEqual([]);
  });

  it('takes a superseded layer’s backup a chain close left behind with the directory on the next end', async () => {
    const world = makeWorld();
    const pristine = readFileSync(world.pathOf(TARGET_FILE));
    const first = await patchSymbol(world, {
      file: TARGET_FILE,
      symbol: TARGET_SYMBOL,
      planVersion: 1,
    });
    const second = await patchSymbol(world, {
      file: TARGET_FILE,
      symbol: SECOND_SYMBOL,
      planVersion: 2,
    });

    // A chain walked on its own closes over the pristine file and removes no
    // directory: the tip's backup — content the file does not hold — stays.
    world.journal.arrange({ ...world.journal.row(second.record.id), status: 'pending' });
    writeFileSync(second.path, pristine);

    const chain = await restoreChain(
      [first.record, second.record].map((record) => world.journal.row(record.id)),
      world.context,
    );

    expect(chain.closed.map((record) => record.id)).toEqual([second.record.id, first.record.id]);
    expect(readdirSync(world.backups.sessionDirectory)).toEqual([second.record.originalHash]);

    world.resetLog();

    const outcome = await cleanupSession(world.sessionId, world.context);

    expect(outcome.status).toBe('clean');
    expect(outcome.restored).toEqual([]);
    expectNoFileSystemAccess(world.log);
    expect(existsSync(world.backups.sessionDirectory)).toBe(false);
    expectFileBytes(second.path, pristine);
  });

  it('leaves alone the directory of a session the journal holds no record of', async () => {
    const world = makeWorld();
    const stranger = nextSessionId('stranger');
    const store = world.storeFor(stranger);
    const bytes = Buffer.from('a backup whose record was never journaled\n', 'utf8');

    // A backup is written before its record is appended, so a directory with no
    // record behind it may belong to an install still in flight.
    expectOk(await store.put(sha256Hex(bytes), bytes), 'a backup with no record');

    const outcome = await cleanupSession(stranger, { ...world.context, backups: store });

    expect(outcome.status).toBe('clean');
    expect(outcome.restored).toEqual([]);
    expect(readdirSync(store.sessionDirectory)).toEqual([sha256Hex(bytes)]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * A developer edit after the patch
 * ---------------------------------------------------------------------------
 */

describe('a developer edit on top of an instrumented file', () => {
  it('is never overwritten: the record conflicts, the backup is kept and a three-way diff is reported', async () => {
    const world = makeWorld();

    world.journal.noteSessionStatus(world.sessionId, 'generated');

    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const edited = developerEdits(patched.path);

    world.resetLog();

    const mark = world.mark();
    const outcome = await cleanupSession(world.sessionId, world.context);

    // The whole point, asserted first: the bytes on disk are the developer's.
    expectFileBytes(patched.path, edited);
    expectNothingWritten(world.log);

    expect(outcome.status).toBe('conflict');
    expect(outcome.restored).toEqual([]);
    expect(outcome.completedAt).toBe(FIXED_NOW);
    expect(outcome.skipped.map((record) => record.id)).toEqual([patched.record.id]);
    expect(only(outcome.skipped, 'skipped record').status).toBe('conflict');
    expect(outcome.failures).toEqual([]);

    const conflict = only(outcome.conflicts, 'conflict report');
    expect(conflict.reason).toBe('content-changed');
    expect(conflict.recordId).toBe(patched.record.id);
    expect(conflict.sessionId).toBe(world.sessionId);
    expect(conflict.file).toBe(TARGET_FILE);
    expect(conflict.expectedHash).toBe(patched.record.instrumentedHash);
    expect(conflict.actualHash).toBe(sha256Hex(edited));
    expect(conflict.detectedAt).toBe(FIXED_NOW);
    expect(conflict.backupPath).toBe(patched.record.backupPath);
    expect(conflict.message).toContain(TARGET_FILE);

    // The three-way view of a conflict: what the tool did, what the developer
    // did on top of it, and the net divergence from the pristine file.
    expect(conflict.diffs?.originalToInstrumented).toBeTypeOf('string');
    expect(conflict.diffs?.instrumentedToCurrent).toContain(DEVELOPER_EDIT.trim());
    expect(conflict.diffs?.originalToCurrent).toContain(DEVELOPER_EDIT.trim());

    // The record stays open, so the next service start reports it again.
    expect(world.journal.row(patched.record.id).status).toBe('conflict');
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: patched.record.id, status: 'conflict' },
    ]);

    // And the pristine original is still recoverable, byte for byte, from the
    // directory the developer was pointed at.
    const backupPath = world.backupPathOf(patched.record.originalHash);
    expect(existsSync(backupPath)).toBe(true);
    expectFileBytes(backupPath, patched.originalBytes);
    expect(existsSync(world.backups.sessionDirectory)).toBe(true);
    expect(world.removals).toEqual([]);
    expect(world.journal.sessionStatusOf(world.sessionId)).toBe('generated');
  });

  it('re-reports the same conflict on the next pass and still writes nothing', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const edited = developerEdits(patched.path);

    const first = await cleanupSession(world.sessionId, world.context);
    expect(first.status).toBe('conflict');

    world.resetLog();

    const mark = world.mark();
    const second = await cleanupSession(world.sessionId, world.context);

    expect(second.status).toBe('conflict');
    expect(only(second.conflicts, 'conflict report').recordId).toBe(patched.record.id);
    expect(second.restored).toEqual([]);
    expectNothingWritten(world.log);
    expectFileBytes(patched.path, edited);
    expect(existsSync(world.backupPathOf(patched.record.originalHash))).toBe(true);

    // Already in `conflict` and the edit is still there, so the retained row
    // moves nowhere: a conflict stays open for as long as it diverges.
    expect(world.journal.row(patched.record.id).status).toBe('conflict');
    expect(world.journal.transitions(mark)).toEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * A chain across plan versions
 * ---------------------------------------------------------------------------
 */

/**
 * Three real plan versions over {@link OTHER_FILE}, each wrapping one more
 * declaration of the bytes the previous version wrote.
 *
 * Nothing is fabricated: the real patcher resolves each version's parent from
 * the journal, hashes the file it finds, backs it up and journals the record,
 * so the chain carries the digests and backups a follow-up install really
 * leaves behind.
 *
 * @param world The sandbox to patch inside.
 * @returns The three links, oldest first.
 */
async function patchThreeLinks(world: World): Promise<[PatchedFile, PatchedFile, PatchedFile]> {
  const first = await patchSymbol(world, {
    file: OTHER_FILE,
    symbol: OTHER_SYMBOL,
    planVersion: 1,
  });
  const second = await patchSymbol(world, {
    file: OTHER_FILE,
    symbol: OTHER_SECOND_SYMBOL,
    planVersion: 2,
  });
  const third = await patchSymbol(world, {
    file: OTHER_FILE,
    symbol: OTHER_THIRD_SYMBOL,
    planVersion: 3,
  });

  return [first, second, third];
}

/** What the journal and the filesystem said at the moment one backup was deleted. */
interface RemovalSnapshot {
  /** The digest whose backup was being deleted. */
  readonly digest: string;

  /** How many conditional writes had landed by then. */
  readonly writes: number;

  /** Each link's status at that moment, oldest link first. */
  readonly statuses: ModificationStatus[];
}

describe('a chain of plan versions over one file', () => {
  it('links the later record to the earlier one through the hash it replaced', async () => {
    const world = makeWorld();
    const first = await patchSymbol(world, {
      file: TARGET_FILE,
      symbol: TARGET_SYMBOL,
      planVersion: 1,
    });
    const second = await patchSymbol(world, {
      file: TARGET_FILE,
      symbol: SECOND_SYMBOL,
      planVersion: 2,
    });

    // A delta on an already-instrumented file chains onto the earlier record:
    // it replaced the earlier patch's output, so its `originalHash` is that
    // output's digest and its backup holds the once-patched bytes rather than
    // the pristine ones.
    expect(second.record.previousRecordId).toBe(first.record.id);
    expect(second.record.originalHash).toBe(first.record.instrumentedHash);
    expect(second.record.planVersion).toBe(2);
    expectFileBytes(world.backupPathOf(second.record.originalHash), first.instrumentedBytes);
    expectFileBytes(world.backupPathOf(first.record.originalHash), first.originalBytes);

    // Reverse order is the only sound order, and it is decided before anything
    // is read: last applied first.
    const ordered = expectOk(
      orderRestorationChain([first.record, second.record]),
      'a restoration order',
    );
    expect(ordered.map((record) => record.id)).toEqual([second.record.id, first.record.id]);
  });

  it('restores strictly in reverse order, verifying each record’s own hash before its write', async () => {
    const world = makeWorld();

    world.journal.noteSessionStatus(world.sessionId, 'analyzing');

    const pristine = readFileSync(world.pathOf(TARGET_FILE));
    const first = await patchSymbol(world, {
      file: TARGET_FILE,
      symbol: TARGET_SYMBOL,
      planVersion: 1,
    });
    const second = await patchSymbol(world, {
      file: TARGET_FILE,
      symbol: SECOND_SYMBOL,
      planVersion: 2,
    });

    world.resetLog();

    const mark = world.mark();
    const outcome = await cleanupSession(world.sessionId, world.context);

    expect(outcome.status).toBe('clean');
    expect(outcome.restored.map((record) => record.id)).toEqual([
      second.record.id,
      first.record.id,
    ]);
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.failures).toEqual([]);

    // Each write was made conditional on *that* record's instrumented content
    // and wrote *that* record's original: the chain is verified link by link
    // rather than assumed.
    expect(world.log.writes.map((write) => write.expectedHash)).toEqual([
      second.record.instrumentedHash,
      first.record.instrumentedHash,
    ]);
    expect(world.log.writes.map((write) => write.contentHash)).toEqual([
      second.record.originalHash,
      first.record.originalHash,
    ]);
    expect(world.log.creates).toEqual([]);

    // The journal saw the same order, which is what the service's modification
    // list and `cleanup.completed` report.
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: second.record.id, status: 'reverted' },
      { recordId: first.record.id, status: 'reverted' },
    ]);

    // And the file is the file the developer started the session with.
    expectFileBytes(world.pathOf(TARGET_FILE), pristine);
    expect(digestOf(world.pathOf(TARGET_FILE))).toBe(first.record.originalHash);
    expect(existsSync(world.backupPathOf(first.record.originalHash))).toBe(false);
    expect(existsSync(world.backupPathOf(second.record.originalHash))).toBe(false);
    expect(world.journal.sessionStatusOf(world.sessionId)).toBe('analyzing');
  });

  it('unwinds a three-link chain strictly 3 → 2 → 1, deleting each backup only once its own restore verified', async () => {
    // Filled in once the world and the links exist; the hook only fires during
    // the pass under test, because patching deletes no backup.
    const holder: { world: World | undefined; links: readonly PatchedFile[] } = {
      world: undefined,
      links: [],
    };
    const snapshots: RemovalSnapshot[] = [];
    const world = makeWorld({
      afterBackupRemoval: (removal): void => {
        const current = holder.world;

        if (current !== undefined) {
          snapshots.push({
            digest: removal.digest,
            writes: current.log.writes.length,
            statuses: holder.links.map((link) => current.journal.row(link.record.id).status),
          });
        }
      },
    });

    holder.world = world;

    const pristine = readFileSync(world.pathOf(OTHER_FILE));
    const [first, second, third] = await patchThreeLinks(world);

    holder.links = [first, second, third];

    // Each link continues from exactly the bytes the previous one wrote, and
    // its backup holds those bytes — the middle link's backup is the first
    // patch's output, not the pristine file.
    expect([first, second, third].map((link) => link.record.planVersion)).toEqual([1, 2, 3]);
    expect(first.record.previousRecordId).toBeUndefined();
    expect(second.record.previousRecordId).toBe(first.record.id);
    expect(third.record.previousRecordId).toBe(second.record.id);
    expect(second.record.originalHash).toBe(first.record.instrumentedHash);
    expect(third.record.originalHash).toBe(second.record.instrumentedHash);

    for (const link of [first, second, third]) {
      expect(link.record.originalHash).toBe(sha256Hex(link.originalBytes));
      expect(link.record.instrumentedHash).toBe(sha256Hex(link.instrumentedBytes));
      expectFileBytes(world.backupPathOf(link.record.originalHash), link.originalBytes);
    }

    expect(Buffer.compare(second.originalBytes, first.instrumentedBytes)).toBe(0);
    expect(Buffer.compare(third.originalBytes, second.instrumentedBytes)).toBe(0);
    expect(first.record.originalHash).toBe(sha256Hex(pristine));

    // Last applied first, whatever order the records arrive in.
    for (const given of [
      [first.record, second.record, third.record],
      [second.record, third.record, first.record],
    ]) {
      expect(
        expectOk(orderRestorationChain(given), 'a restoration order').map((r) => r.id),
      ).toEqual([third.record.id, second.record.id, first.record.id]);
    }

    world.watch(OTHER_FILE);
    world.resetLog();

    const mark = world.mark();
    const outcome = await cleanupSession(world.sessionId, world.context);

    expect(outcome.status).toBe('clean');
    expect(outcome.restored.map((record) => record.id)).toEqual([
      third.record.id,
      second.record.id,
      first.record.id,
    ]);
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.failures).toEqual([]);
    expect(outcome.forks).toEqual([]);

    // Each write was conditional on *that* link's instrumented content and
    // wrote *that* link's original, in strict reverse order.
    expect(world.log.writes.map((write) => write.expectedHash)).toEqual([
      third.record.instrumentedHash,
      second.record.instrumentedHash,
      first.record.instrumentedHash,
    ]);
    expect(world.log.writes.map((write) => write.contentHash)).toEqual([
      third.record.originalHash,
      second.record.originalHash,
      first.record.originalHash,
    ]);
    expect(world.log.creates).toEqual([]);
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: third.record.id, status: 'reverted' },
      { recordId: second.record.id, status: 'reverted' },
      { recordId: first.record.id, status: 'reverted' },
    ]);

    // Staged deletion: each backup went only after its own link's restore was
    // written, re-read against its original and journaled — and before the next
    // link's write began.
    expect(world.removals.map((removal) => removal.digest)).toEqual([
      third.record.originalHash,
      second.record.originalHash,
      first.record.originalHash,
    ]);
    expect(world.removals.map((removal) => removal.restoredContentHash)).toEqual([
      third.record.originalHash,
      second.record.originalHash,
      first.record.originalHash,
    ]);
    expect(world.removals.map((removal) => removal.watchedDigest)).toEqual([
      third.record.originalHash,
      second.record.originalHash,
      first.record.originalHash,
    ]);
    expect(snapshots).toEqual([
      {
        digest: third.record.originalHash,
        writes: 1,
        statuses: ['applied', 'applied', 'reverted'],
      },
      {
        digest: second.record.originalHash,
        writes: 2,
        statuses: ['applied', 'reverted', 'reverted'],
      },
      {
        digest: first.record.originalHash,
        writes: 3,
        statuses: ['reverted', 'reverted', 'reverted'],
      },
    ]);

    // The file is the file the session started with, byte for byte.
    expectFileBytes(world.pathOf(OTHER_FILE), pristine);
    expect(digestOf(world.pathOf(OTHER_FILE))).toBe(sha256Hex(pristine));

    for (const link of [first, second, third]) {
      expect(existsSync(world.backupPathOf(link.record.originalHash))).toBe(false);
    }

    expect(existsSync(world.backups.sessionDirectory)).toBe(false);
  });

  it('stops at the middle link when the file is edited after link 3 is restored, moving link 1 into conflict with it', async () => {
    let interference: Buffer | undefined;

    const world = makeWorld({
      afterBackupRemoval: (_removal, projectRoot): void => {
        // Fires once, after link 3's restore was written, verified and
        // journaled and before link 2 is looked at: a developer saving the file
        // between the two restores.
        if (interference === undefined) {
          interference = developerEdits(join(projectRoot, OTHER_FILE));
        }
      },
    });
    const [first, second, third] = await patchThreeLinks(world);

    world.resetLog();

    const mark = world.mark();
    const outcome = await cleanupSession(world.sessionId, world.context);

    // Link 3 came back, but link 2's conflict is outstanding, and an
    // outstanding conflict makes the verdict `conflict`.
    expect(outcome.status).toBe('conflict');
    expect(outcome.restored.map((record) => record.id)).toEqual([third.record.id]);
    expect(outcome.skipped.map((record) => record.id)).toEqual([second.record.id, first.record.id]);
    expect(outcome.failures).toEqual([]);

    const conflict = only(outcome.conflicts, 'conflict report');
    expect(conflict.recordId).toBe(second.record.id);
    expect(conflict.reason).toBe('content-changed');
    expect(conflict.expectedHash).toBe(second.record.instrumentedHash);
    expect(interference, 'the interference hook must have run').toBeDefined();
    expect(conflict.actualHash).toBe(sha256Hex(interference ?? Buffer.alloc(0)));

    // One write — link 3's. Neither link 2's nor link 1's backup went over the
    // developer's line.
    expect(world.log.writes.map((write) => write.expectedHash)).toEqual([
      third.record.instrumentedHash,
    ]);
    expectFileBytes(world.pathOf(OTHER_FILE), interference ?? Buffer.alloc(0));

    // Link 3 closed, link 2 reported, link 1 never judged: the file holds none
    // of its output either, so it moves into `conflict` beside link 2 rather
    // than staying `applied`, and the next pass judges both again.
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: third.record.id, status: 'reverted' },
      { recordId: second.record.id, status: 'conflict' },
      { recordId: first.record.id, status: 'conflict' },
    ]);
    expect(world.journal.row(third.record.id).status).toBe('reverted');
    expect(world.journal.row(second.record.id).status).toBe('conflict');
    expect(world.journal.row(first.record.id).status).toBe('conflict');

    // Only link 3's backup was deleted; links 2 and 1 keep theirs.
    expect(world.removals.map((removal) => removal.digest)).toEqual([third.record.originalHash]);
    expect(existsSync(world.backupPathOf(third.record.originalHash))).toBe(false);
    expectFileBytes(world.backupPathOf(second.record.originalHash), second.originalBytes);
    expectFileBytes(world.backupPathOf(first.record.originalHash), first.originalBytes);
    expect(existsSync(world.backups.sessionDirectory)).toBe(true);
  });

  it('stops at the middle link when its backup cannot be read back, leaving link 1 unresolved', async () => {
    const world = makeWorld();
    const [first, second, third] = await patchThreeLinks(world);

    // Link 2's original — the first patch's output — is gone from the store.
    rmSync(world.backupPathOf(second.record.originalHash));
    world.resetLog();

    const mark = world.mark();
    // Given in append order on purpose: the walker orders them itself.
    const chain = await restoreChain(
      [first.record, second.record, third.record].map((record) => world.journal.row(record.id)),
      world.context,
    );

    expect(chain.file).toBe(OTHER_FILE);
    expect(chain.fork).toBeUndefined();
    expect(chain.stoppedAt?.id).toBe(second.record.id);
    expect(chain.outcomes.map((outcome) => outcome.kind)).toEqual(['restored', 'conflict']);
    expect(chain.restored.map((record) => record.id)).toEqual([third.record.id]);
    expect(chain.retained.map((record) => record.id)).toEqual([second.record.id]);
    expect(chain.skipped.map((record) => record.id)).toEqual([first.record.id]);
    expect(chain.closed).toEqual([]);
    expect(chain.failures).toEqual([]);

    const conflict = only(chain.conflicts, 'conflict report');
    expect(conflict.recordId).toBe(second.record.id);
    expect(conflict.reason).toBe('backup-missing');
    expect(conflict.actualHash).toBe(second.record.instrumentedHash);

    // Link 3 came back to the bytes link 2 wrote, and stopped there.
    expect(world.log.writes.map((write) => write.expectedHash)).toEqual([
      third.record.instrumentedHash,
    ]);
    expectFileBytes(world.pathOf(OTHER_FILE), second.instrumentedBytes);
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: third.record.id, status: 'reverted' },
      { recordId: second.record.id, status: 'conflict' },
    ]);
    expect(world.journal.row(first.record.id).status).toBe('applied');
    expectFileBytes(world.backupPathOf(first.record.originalHash), first.originalBytes);
    expect(existsSync(world.backupPathOf(third.record.originalHash))).toBe(false);
  });

  it('stops at a conflict introduced between the two restores and leaves the earlier record open', async () => {
    let interference: Buffer | undefined;

    const world = makeWorld({
      afterBackupRemoval: (_removal, projectRoot): void => {
        // Fires once, in the interval after the tip's restore was written,
        // verified and journaled: exactly a developer saving the file between
        // two restores.
        if (interference === undefined) {
          interference = developerEdits(join(projectRoot, TARGET_FILE));
        }
      },
    });

    const first = await patchSymbol(world, {
      file: TARGET_FILE,
      symbol: TARGET_SYMBOL,
      planVersion: 1,
    });
    const second = await patchSymbol(world, {
      file: TARGET_FILE,
      symbol: SECOND_SYMBOL,
      planVersion: 2,
    });

    world.resetLog();

    const mark = world.mark();
    const outcome = await cleanupSession(world.sessionId, world.context);

    // The tip came back; the earlier version could not, and was not forced.
    // Its conflict is outstanding, so the pass reports `conflict`.
    expect(outcome.status).toBe('conflict');
    expect(outcome.restored.map((record) => record.id)).toEqual([second.record.id]);
    expect(outcome.skipped.map((record) => record.id)).toEqual([first.record.id]);
    expect(outcome.failures).toEqual([]);

    const conflict = only(outcome.conflicts, 'conflict report');
    expect(conflict.recordId).toBe(first.record.id);
    expect(conflict.reason).toBe('content-changed');
    expect(conflict.expectedHash).toBe(first.record.instrumentedHash);

    // One write only — the tip's. The earlier record's backup was never
    // written over the developer's line.
    expect(world.log.writes.map((write) => write.expectedHash)).toEqual([
      second.record.instrumentedHash,
    ]);
    expect(interference, 'the interference hook must have run').toBeDefined();
    expectFileBytes(world.pathOf(TARGET_FILE), interference ?? Buffer.alloc(0));

    expect(world.journal.transitions(mark)).toEqual([
      { recordId: second.record.id, status: 'reverted' },
      { recordId: first.record.id, status: 'conflict' },
    ]);

    // The pristine original is still there to be restored by hand, and the
    // directory the developer is pointed at survives the pass.
    expect(existsSync(world.backupPathOf(first.record.originalHash))).toBe(true);
    expectFileBytes(world.backupPathOf(first.record.originalHash), first.originalBytes);
    expect(existsSync(world.backups.sessionDirectory)).toBe(true);
  });

  it('refuses the whole chain when its tip no longer holds what it wrote', async () => {
    const world = makeWorld();
    const first = await patchSymbol(world, {
      file: TARGET_FILE,
      symbol: TARGET_SYMBOL,
      planVersion: 1,
    });
    const second = await patchSymbol(world, {
      file: TARGET_FILE,
      symbol: SECOND_SYMBOL,
      planVersion: 2,
    });
    const edited = developerEdits(world.pathOf(TARGET_FILE));

    world.resetLog();

    const mark = world.mark();
    // Given in append order on purpose: the walker orders them itself.
    const chain = await restoreChain([first.record, second.record], world.context);

    expect(chain.file).toBe(TARGET_FILE);
    expect(chain.stoppedAt?.id).toBe(second.record.id);
    expect(chain.restored).toEqual([]);
    expect(chain.closed).toEqual([]);
    expect(chain.retained.map((record) => record.id)).toEqual([second.record.id, first.record.id]);
    expect(chain.retained.map((record) => record.status)).toEqual(['conflict', 'conflict']);
    expect(chain.conflicts.map((report) => report.recordId)).toEqual([second.record.id]);
    expect(chain.skipped).toEqual([]);
    expect(chain.failures).toEqual([]);
    expect(chain.outcomes.map((outcome) => outcome.kind)).toEqual(['conflict']);

    // Nothing was written, and the record behind the conflict was not judged:
    // its expectation cannot hold while the file is what it now is, so it is
    // moved into `conflict` with the tip instead of being left `applied`.
    expectNothingWritten(world.log);
    expectFileBytes(world.pathOf(TARGET_FILE), edited);
    expect(world.journal.row(first.record.id).status).toBe('conflict');
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: second.record.id, status: 'conflict' },
      { recordId: first.record.id, status: 'conflict' },
    ]);
    expect(existsSync(world.backupPathOf(first.record.originalHash))).toBe(true);
    expect(existsSync(world.backupPathOf(second.record.originalHash))).toBe(true);
  });

  it('points the conflict of an edited chain at the chain root’s pristine backup, not the tip’s own', async () => {
    const world = makeWorld();
    const pristine = readFileSync(world.pathOf(TARGET_FILE));
    const first = await patchSymbol(world, {
      file: TARGET_FILE,
      symbol: TARGET_SYMBOL,
      planVersion: 1,
    });
    const second = await patchSymbol(world, {
      file: TARGET_FILE,
      symbol: SECOND_SYMBOL,
      planVersion: 2,
    });
    const edited = developerEdits(world.pathOf(TARGET_FILE));

    world.resetLog();

    const outcome = await cleanupSession(world.sessionId, world.context);

    expect(outcome.status).toBe('conflict');
    expect(outcome.restored).toEqual([]);
    expect(outcome.skipped.map((record) => record.id)).toEqual([second.record.id, first.record.id]);
    expectNothingWritten(world.log);
    expectFileBytes(world.pathOf(TARGET_FILE), edited);

    const conflict = only(outcome.conflicts, 'conflict report');

    // The tip's own backup is plan version 1's output — it still carries the
    // wrapper — so the pristine file the developer is pointed at is the chain
    // root's backup.
    expect(conflict.recordId).toBe(second.record.id);
    expect(conflict.backupPath).toBe(second.record.backupPath);
    expect(conflict.originalBackupPath).toBe(first.record.backupPath);
    expect(readFileSync(second.record.backupPath, 'utf8')).toContain(SPAN_HELPER_GLOBAL);
    expectFileBytes(first.record.backupPath, pristine);
    expect(conflict.message).toContain(first.record.backupPath);
    expect(conflict.message).not.toContain(second.record.backupPath);

    // "Open diff" starts from the pristine file: nothing the tool-change view
    // removes carries the marker, and the net divergence is shown from it too.
    const toolChange = conflict.diffs?.originalToInstrumented ?? '';
    const netChange = conflict.diffs?.originalToCurrent ?? '';

    expect(toolChange).not.toBe('');
    expect(toolChange).not.toBe(second.record.diff);
    expect(
      toolChange
        .split('\n')
        .some(
          (line) =>
            line.startsWith('-') && !line.startsWith('---') && line.includes(SPAN_HELPER_GLOBAL),
        ),
    ).toBe(false);
    expect(netChange).toContain(DEVELOPER_EDIT.trim());
    expect(
      netChange
        .split('\n')
        .some(
          (line) =>
            line.startsWith('-') && !line.startsWith('---') && line.includes(SPAN_HELPER_GLOBAL),
        ),
    ).toBe(false);

    // The root gets no report of its own — the tip's covers the file — but it
    // is no longer left `applied` behind it: it is in `conflict` too, and its
    // pristine backup is kept with the directory it lives in.
    expect(world.journal.row(first.record.id).status).toBe('conflict');
    expect(world.journal.row(second.record.id).status).toBe('conflict');
    expect(world.removals).toEqual([]);
    expect(existsSync(world.backups.sessionDirectory)).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * A conflict whose file comes back to a recorded digest
 * ---------------------------------------------------------------------------
 */

describe('a conflict whose file comes back to a recorded digest', () => {
  /** A second copy of {@link TARGET_FILE}, so two records share one original. */
  const TWIN_FILE = 'src/server/cycle-planner-twin.ts';

  /** The ids of a pass's list, in the order the pass reported them. */
  const ids = (records: readonly ModificationRecord[]): string[] =>
    records.map((record) => record.id);

  it('is restored once the developer undoes the edit, and its backup is deleted after the restore verified', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    developerEdits(patched.path);

    const first = await cleanupSession(world.sessionId, world.context);

    expect(first.status).toBe('conflict');
    expect(world.journal.row(patched.record.id).status).toBe('conflict');

    // The developer undoes the edit: the file is byte-identical to what the
    // patch wrote, so it hashes to `instrumentedHash` again.
    writeFileSync(patched.path, patched.instrumentedBytes);
    expect(digestOf(patched.path)).toBe(patched.record.instrumentedHash);

    world.watch(TARGET_FILE);
    world.resetLog();

    const mark = world.mark();
    const second = await cleanupSession(world.sessionId, world.context);

    expect(second.status).toBe('clean');
    expect(second.conflicts).toEqual([]);
    expect(second.skipped).toEqual([]);
    expect(second.failures).toEqual([]);
    expect(only(second.restored, 'restored record').id).toBe(patched.record.id);
    expect(only(second.restored, 'restored record').status).toBe('reverted');

    // The same conditional write as for any applied record: only while the file
    // still holds the instrumented bytes, and with the recorded original.
    expectFileBytes(patched.path, patched.originalBytes);
    const write = only(world.log.writes, 'conditional write');
    expect(write.expectedHash).toBe(patched.record.instrumentedHash);
    expect(write.contentHash).toBe(patched.record.originalHash);

    // `conflict → reverted`, and the backup deleted only once the file held the
    // original again.
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: patched.record.id, status: 'reverted' },
    ]);
    const removal = only(world.removals, 'backup deletion');
    expect(removal.restoredContentHash).toBe(patched.record.originalHash);
    expect(removal.watchedDigest).toBe(patched.record.originalHash);
    expect(existsSync(world.backupPathOf(patched.record.originalHash))).toBe(false);
    expect(existsSync(world.backups.sessionDirectory)).toBe(false);
  });

  it('is restored by a start-up reconciliation when the edit was undone while no service ran', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    developerEdits(patched.path);

    const first = await reconcileModifications(world.context);

    expect(first.status).toBe('conflict');
    expect(ids(first.retained)).toEqual([patched.record.id]);

    writeFileSync(patched.path, patched.instrumentedBytes);
    world.resetLog();

    const mark = world.mark();
    const second = await reconcileModifications(world.context);

    expect(second.status).toBe('clean');
    expect(second.examined).toBe(1);
    expect(ids(second.restored)).toEqual([patched.record.id]);
    expect(second.closed).toEqual([]);
    expect(second.retained).toEqual([]);
    expect(second.conflicts).toEqual([]);
    expectFileBytes(patched.path, patched.originalBytes);
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: patched.record.id, status: 'reverted' },
    ]);
    expect(existsSync(world.backupPathOf(patched.record.originalHash))).toBe(false);
  });

  it('is closed without a write once the developer puts the original back by hand', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    developerEdits(patched.path);
    expect((await cleanupSession(world.sessionId, world.context)).status).toBe('conflict');

    writeFileSync(patched.path, patched.originalBytes);
    world.resetLog();

    const mark = world.mark();
    const second = await cleanupSession(world.sessionId, world.context);

    expect(second.status).toBe('clean');
    expect(only(second.restored, 'closed record').id).toBe(patched.record.id);
    expect(second.conflicts).toEqual([]);

    // Nothing to write: the file already is the original. The hash comparison
    // that closed the record is the verification its backup's deletion needs.
    expectNothingWritten(world.log);
    expectFileBytes(patched.path, patched.originalBytes);
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: patched.record.id, status: 'reverted' },
    ]);
    expect(only(world.removals, 'backup deletion').restoredContentHash).toBe(
      patched.record.originalHash,
    );
    expect(existsSync(world.backupPathOf(patched.record.originalHash))).toBe(false);
  });

  it('is restored by restoreModification on its own, as for any record whose file is ours', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    world.journal.arrange({ ...world.journal.row(patched.record.id), status: 'conflict' });

    const outcome = expectOk(
      await restoreModification(world.journal.row(patched.record.id), world.context),
      'a restore of a conflict whose file holds the patch',
    );

    expect(outcome.kind).toBe('restored');
    expect(outcome.record.status).toBe('reverted');
    expect(outcome.backup).toBe('deleted');
    expectFileBytes(patched.path, patched.originalBytes);
  });

  it('resumes the reverse walk through the earlier links once the edit on the head is undone', async () => {
    const world = makeWorld();
    const pristine = readFileSync(world.pathOf(OTHER_FILE));
    const [first, second, third] = await patchThreeLinks(world);

    developerEdits(third.path);

    const blocked = await cleanupSession(world.sessionId, world.context);

    // The edit holds none of the chain's output, so the whole chain is in
    // `conflict` — and a record in `conflict` is still restored the moment its
    // file hashes to what it wrote.
    expect(blocked.status).toBe('conflict');
    expect(world.journal.row(third.record.id).status).toBe('conflict');
    expect(world.journal.row(second.record.id).status).toBe('conflict');
    expect(world.journal.row(first.record.id).status).toBe('conflict');

    writeFileSync(third.path, third.instrumentedBytes);
    world.resetLog();

    const mark = world.mark();
    const outcome = await cleanupSession(world.sessionId, world.context);

    expect(outcome.status).toBe('clean');
    expect(ids(outcome.restored)).toEqual([third.record.id, second.record.id, first.record.id]);

    // Each link still verified against its own `instrumentedHash` before its
    // own backup was written.
    expect(world.log.writes.map((write) => write.expectedHash)).toEqual([
      third.record.instrumentedHash,
      second.record.instrumentedHash,
      first.record.instrumentedHash,
    ]);
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: third.record.id, status: 'reverted' },
      { recordId: second.record.id, status: 'reverted' },
      { recordId: first.record.id, status: 'reverted' },
    ]);
    expectFileBytes(world.pathOf(OTHER_FILE), pristine);

    for (const link of [first, second, third]) {
      expect(existsSync(world.backupPathOf(link.record.originalHash))).toBe(false);
    }
  });

  it('keeps a backup it shares with a restored record while its own edit is still there', async () => {
    const world = makeWorld();
    cpSync(world.pathOf(TARGET_FILE), world.pathOf(TWIN_FILE));

    const target = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const twin = await patchSymbol(world, { file: TWIN_FILE, symbol: TARGET_SYMBOL });
    const digest = target.record.originalHash;

    expect(twin.record.originalHash).toBe(digest);
    expect(twin.outcome.backup.reused).toBe(true);

    // The twin was edited and the watcher marked it, as a live session would.
    const edited = developerEdits(twin.path);
    world.journal.arrange({ ...world.journal.row(twin.record.id), status: 'conflict' });
    world.resetLog();

    const outcome = await cleanupSession(world.sessionId, world.context);

    expect(outcome.status).toBe('conflict');
    expect(ids(outcome.restored)).toEqual([target.record.id]);
    expect(only(outcome.conflicts, 'conflict report').recordId).toBe(twin.record.id);
    expectFileBytes(target.path, target.originalBytes);
    expectFileBytes(twin.path, edited);

    // The one copy both records share is the copy the conflict points at.
    expect(world.removals).toEqual([]);
    expectFileBytes(world.backupPathOf(digest), target.originalBytes);
    expect(world.journal.row(twin.record.id).status).toBe('conflict');
  });

  it('deletes a backup it shares with another record only once both are restored', async () => {
    // What the twin held at each deletion of the shared copy, sampled before
    // the store acts. Patching deletes no backup, so only the pass fills it.
    const twinAtRemoval: (string | undefined)[] = [];
    const world = makeWorld({
      afterBackupRemoval: (_removal, projectRoot): void => {
        const path = join(projectRoot, TWIN_FILE);

        twinAtRemoval.push(existsSync(path) ? digestOf(path) : undefined);
      },
    });
    cpSync(world.pathOf(TARGET_FILE), world.pathOf(TWIN_FILE));

    const target = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const twin = await patchSymbol(world, { file: TWIN_FILE, symbol: TARGET_SYMBOL });
    const digest = target.record.originalHash;

    expect(twin.record.originalHash).toBe(digest);

    // Edited, marked by the watcher, then undone.
    developerEdits(twin.path);
    world.journal.arrange({ ...world.journal.row(twin.record.id), status: 'conflict' });
    writeFileSync(twin.path, twin.instrumentedBytes);

    world.watch(TARGET_FILE);
    world.resetLog();

    const mark = world.mark();
    const outcome = await cleanupSession(world.sessionId, world.context);

    expect(outcome.status).toBe('clean');
    expect(new Set(ids(outcome.restored))).toEqual(new Set([target.record.id, twin.record.id]));
    expectFileBytes(target.path, target.originalBytes);
    expectFileBytes(twin.path, twin.originalBytes);
    const transitions = world.journal.transitions(mark);
    expect(transitions).toHaveLength(2);
    expect(transitions).toEqual(
      expect.arrayContaining([
        { recordId: target.record.id, status: 'reverted' },
        { recordId: twin.record.id, status: 'reverted' },
      ]),
    );

    // Every deletion of the shared copy came after both restores verified:
    // both files already held the original when the store was asked.
    expect(world.removals.length).toBeGreaterThan(0);
    for (const removal of world.removals) {
      expect(removal.restoredContentHash).toBe(digest);
      expect(removal.watchedDigest).toBe(digest);
    }
    expect(twinAtRemoval).toEqual(world.removals.map(() => digest));
    expect(existsSync(world.backupPathOf(digest))).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * A conflicted chain whose file is put back to an earlier version's original
 * ---------------------------------------------------------------------------
 */

/** Two real plan versions over {@link TARGET_FILE}, and the bytes from before either. */
interface TwoLinkChain {
  /** The file as the session found it: what the chain root backed up. */
  readonly pristine: Buffer;

  /** Plan version 1, the chain root. */
  readonly first: PatchedFile;

  /** Plan version 2, layered on version 1's output. */
  readonly second: PatchedFile;
}

/**
 * Patches {@link TARGET_FILE} twice with the real patcher, the shape one plan
 * wrapping two functions of one file leaves behind: a chain root holding the
 * pristine backup, and a tip whose backup is the root's instrumented output.
 *
 * @param world The sandbox to patch inside.
 * @returns Both links and the pristine bytes.
 */
async function patchTwoLinks(world: World): Promise<TwoLinkChain> {
  const pristine = readFileSync(world.pathOf(TARGET_FILE));
  const first = await patchSymbol(world, {
    file: TARGET_FILE,
    symbol: TARGET_SYMBOL,
    planVersion: 1,
  });
  const second = await patchSymbol(world, {
    file: TARGET_FILE,
    symbol: SECOND_SYMBOL,
    planVersion: 2,
  });

  expect(second.record.previousRecordId).toBe(first.record.id);
  expect(second.record.originalHash).toBe(first.record.instrumentedHash);

  return { pristine, first, second };
}

/**
 * Ends the session over an edited tip — the conflict a developer saving the
 * file mid-session produces — and asserts what that leaves: the tip in
 * `conflict` with the only report, the root moved into `conflict` behind it
 * (the edit holds none of the chain's output, so nothing may go on claiming
 * the file is `applied`), both backups kept.
 *
 * @param world The sandbox.
 * @param chain The two links over the file.
 */
async function conflictOnTip(world: World, chain: TwoLinkChain): Promise<void> {
  developerEdits(chain.second.path);

  const ended = await cleanupSession(world.sessionId, world.context);

  expect(ended.status).toBe('conflict');
  expect(only(ended.conflicts, 'conflict report').originalBackupPath).toBe(
    chain.first.record.backupPath,
  );
  expect(world.journal.row(chain.second.record.id).status).toBe('conflict');
  expect(world.journal.row(chain.first.record.id).status).toBe('conflict');
  expectFileBytes(chain.first.record.backupPath, chain.pristine);
  expect(existsSync(chain.second.record.backupPath)).toBe(true);
}

describe('a conflicted chain whose file is put back to an earlier plan version’s original', () => {
  /** The ids of a pass's list, in the order the pass reported them. */
  const ids = (records: readonly ModificationRecord[]): string[] =>
    records.map((record) => record.id);

  it('closes every record without a write once the file saved as the original is put back', async () => {
    const records: LogRecord[] = [];
    const logger = createConsoleLogger({
      level: 'trace',
      sink: (record) => {
        records.push(record);
      },
    });
    const world = makeWorld();
    const chain = await patchTwoLinks(world);
    const { first, second } = chain;

    await conflictOnTip(world, chain);

    // What the conflict notice tells the developer to do: put back the file
    // saved at its `originalBackupPath`.
    writeFileSync(second.path, readFileSync(first.record.backupPath));
    expect(digestOf(second.path)).toBe(first.record.originalHash);

    world.watch(TARGET_FILE);
    world.resetLog();

    const mark = world.mark();
    const outcome = await cleanupSession(world.sessionId, { ...world.context, logger });

    expect(outcome.status).toBe('clean');
    expect(ids(outcome.restored)).toEqual([second.record.id, first.record.id]);
    expect(outcome.restored.map((record) => record.status)).toEqual(['reverted', 'reverted']);
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.failures).toEqual([]);
    expect(outcome.forks).toEqual([]);

    // The file already is the original: nothing to write, and nothing was.
    expectNothingWritten(world.log);
    expectFileBytes(second.path, chain.pristine);

    // `conflict → reverted` for the tip and for the root the edit had moved
    // into `conflict` with it: neither is left open behind a resolved conflict.
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: second.record.id, status: 'reverted' },
      { recordId: first.record.id, status: 'reverted' },
    ]);

    // Only the root's backup is deleted as verified — the file hashes to its
    // original. The tip's backup, which the file does not hold, is removed with
    // the session directory rather than through the verified deletion.
    const removal = only(world.removals, 'verified backup deletion');
    expect(removal.digest).toBe(first.record.originalHash);
    expect(removal.restoredContentHash).toBe(first.record.originalHash);
    expect(removal.watchedDigest).toBe(first.record.originalHash);
    expect(existsSync(world.backups.sessionDirectory)).toBe(false);

    // One decision, logged once, and no "not reverted" warning for the tip.
    const close = records.filter(
      (record) =>
        record.message ===
        'a chained file holds content from before these modifications; they are closed without a write',
    );
    expect(close).toHaveLength(1);
    expect(close[0]?.fields['recordId']).toBe(second.record.id);
    expect(close[0]?.fields['matchedRecordId']).toBe(first.record.id);
    expect(
      records.some(
        (record) =>
          record.message === 'a modification was not reverted; the file was left exactly as it is',
      ),
    ).toBe(false);

    // Ending the session once more is the idempotent no-op it always was.
    world.resetLog();

    const again = await cleanupSession(world.sessionId, world.context);

    expect(again.status).toBe('clean');
    expect(again.restored).toEqual([]);
    expectNoFileSystemAccess(world.log);
  });

  it('is closed the same way by a start-up reconciliation', async () => {
    const world = makeWorld();
    const chain = await patchTwoLinks(world);
    const { first, second } = chain;

    await conflictOnTip(world, chain);
    writeFileSync(second.path, chain.pristine);
    world.resetLog();

    const mark = world.mark();
    const outcome = await reconcileModifications(world.context);

    expect(outcome.status).toBe('clean');
    expect(outcome.examined).toBe(2);
    expect(ids(outcome.closed)).toEqual([second.record.id, first.record.id]);
    expect(outcome.restored).toEqual([]);
    expect(outcome.retained).toEqual([]);
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.failures).toEqual([]);
    expectNothingWritten(world.log);
    expectFileBytes(second.path, chain.pristine);
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: second.record.id, status: 'reverted' },
      { recordId: first.record.id, status: 'reverted' },
    ]);
    expect(only(world.removals, 'verified backup deletion').restoredContentHash).toBe(
      first.record.originalHash,
    );
    expect(existsSync(world.backups.sessionDirectory)).toBe(false);
  });

  it('closes the layers above the version the file was put back to, then restores the rest in reverse', async () => {
    const world = makeWorld();
    const pristine = readFileSync(world.pathOf(OTHER_FILE));
    const [first, second, third] = await patchThreeLinks(world);

    developerEdits(third.path);
    expect((await cleanupSession(world.sessionId, world.context)).status).toBe('conflict');
    expect(world.journal.row(third.record.id).status).toBe('conflict');

    // Put back to plan version 1's output — what version 2 replaced — rather
    // than to the pristine file.
    writeFileSync(third.path, first.instrumentedBytes);
    expect(digestOf(third.path)).toBe(second.record.originalHash);

    world.watch(OTHER_FILE);
    world.resetLog();

    const mark = world.mark();
    const outcome = await cleanupSession(world.sessionId, world.context);

    expect(outcome.status).toBe('clean');
    // Restored records first, then the closed ones, as the session outcome
    // always lists them.
    expect(ids(outcome.restored)).toEqual([first.record.id, third.record.id, second.record.id]);
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.failures).toEqual([]);

    // Versions 3 and 2 closed without a write; version 1's backup then went
    // back over the output it wrote, conditional on exactly that output.
    const write = only(world.log.writes, 'conditional write');
    expect(write.expectedHash).toBe(first.record.instrumentedHash);
    expect(write.contentHash).toBe(first.record.originalHash);
    expect(world.log.creates).toEqual([]);
    expectFileBytes(third.path, pristine);
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: third.record.id, status: 'reverted' },
      { recordId: second.record.id, status: 'reverted' },
      { recordId: first.record.id, status: 'reverted' },
    ]);

    // Version 2's backup was deleted as verified while the file held exactly
    // it, and version 1's once its own restore verified; version 3's backup —
    // content the file never held again — left with the session directory.
    expect(world.removals.map((removal) => removal.digest)).toEqual([
      second.record.originalHash,
      first.record.originalHash,
    ]);
    expect(world.removals.map((removal) => removal.restoredContentHash)).toEqual([
      second.record.originalHash,
      first.record.originalHash,
    ]);
    expect(world.removals.map((removal) => removal.watchedDigest)).toEqual([
      second.record.originalHash,
      first.record.originalHash,
    ]);
    expect(existsSync(world.backups.sessionDirectory)).toBe(false);
  });

  it.each(['pending', 'failed'] as const)(
    'closes a %s head over the pristine file on the first pass, never through conflict',
    async (status) => {
      const world = makeWorld();
      const chain = await patchTwoLinks(world);
      const { first, second } = chain;

      world.journal.arrange({ ...world.journal.row(second.record.id), status });
      writeFileSync(second.path, chain.pristine);
      world.watch(TARGET_FILE);
      world.resetLog();

      const mark = world.mark();
      const outcome = await restoreChain(
        [first.record, second.record].map((record) => world.journal.row(record.id)),
        world.context,
      );

      expect(outcome.file).toBe(TARGET_FILE);
      expect(outcome.stoppedAt).toBeUndefined();
      expect(outcome.fork).toBeUndefined();
      expect(outcome.outcomes.map((step) => step.kind)).toEqual([
        'already-original',
        'already-original',
      ]);
      expect(ids(outcome.closed)).toEqual([second.record.id, first.record.id]);
      expect(outcome.restored).toEqual([]);
      expect(outcome.retained).toEqual([]);
      expect(outcome.conflicts).toEqual([]);
      expect(outcome.skipped).toEqual([]);
      expect(outcome.failures).toEqual([]);

      // The head's backup is not what the file holds, so it is kept for the
      // session directory's removal; the root's goes as verified.
      expect(outcome.outcomes.map((step) => step.backup)).toEqual(['retained', 'deleted']);
      expectFileBytes(second.record.backupPath, first.instrumentedBytes);
      expect(existsSync(first.record.backupPath)).toBe(false);
      expect(only(world.removals, 'verified backup deletion').watchedDigest).toBe(
        first.record.originalHash,
      );

      expectNothingWritten(world.log);
      expect(world.journal.transitions(mark)).toEqual([
        { recordId: second.record.id, status: 'reverted' },
        { recordId: first.record.id, status: 'reverted' },
      ]);
    },
  );

  it('reports an applied head over the pristine file as a conflict first, and closes the chain on the next pass', async () => {
    const world = makeWorld();
    const chain = await patchTwoLinks(world);
    const { first, second } = chain;

    // Put back behind the tool's back while the tip was still `applied`: news
    // to a record that believes its bytes are on disk, so reported first.
    writeFileSync(second.path, chain.pristine);
    world.resetLog();

    const firstMark = world.mark();
    const reported = await cleanupSession(world.sessionId, world.context);

    expect(reported.status).toBe('conflict');
    expect(reported.restored).toEqual([]);
    expect(ids(reported.skipped)).toEqual([second.record.id, first.record.id]);

    const conflict = only(reported.conflicts, 'conflict report');
    expect(conflict.recordId).toBe(second.record.id);
    expect(conflict.reason).toBe('content-changed');
    expect(conflict.actualHash).toBe(first.record.originalHash);
    expect(conflict.backupPath).toBe(second.record.backupPath);
    expect(conflict.originalBackupPath).toBe(first.record.backupPath);
    expectNothingWritten(world.log);
    // The pristine file is not the root's output either, so the root goes into
    // `conflict` with the tip instead of staying `applied` over bytes that are
    // not on disk.
    expect(world.journal.transitions(firstMark)).toEqual([
      { recordId: second.record.id, status: 'conflict' },
      { recordId: first.record.id, status: 'conflict' },
    ]);
    expect(world.journal.row(first.record.id).status).toBe('conflict');
    expect(world.removals).toEqual([]);

    world.resetLog();

    const secondMark = world.mark();
    const closed = await cleanupSession(world.sessionId, world.context);

    expect(closed.status).toBe('clean');
    expect(ids(closed.restored)).toEqual([second.record.id, first.record.id]);
    expectNothingWritten(world.log);
    expectFileBytes(second.path, chain.pristine);
    expect(world.journal.transitions(secondMark)).toEqual([
      { recordId: second.record.id, status: 'reverted' },
      { recordId: first.record.id, status: 'reverted' },
    ]);
    expect(existsSync(world.backups.sessionDirectory)).toBe(false);
  });

  it('does not close a chain whose links disagree about the bytes between them', async () => {
    const world = makeWorld();
    const chain = await patchTwoLinks(world);
    const { first, second } = chain;

    await conflictOnTip(world, chain);

    // The root's journaled output is no longer what the tip replaced, so the
    // journal cannot prove the file holds the content from before both.
    world.journal.arrange({
      ...world.journal.row(first.record.id),
      instrumentedHash: sha256Hex(Buffer.from('not what plan version 2 replaced', 'utf8')),
    });
    writeFileSync(second.path, chain.pristine);
    world.resetLog();

    const mark = world.mark();
    const outcome = await cleanupSession(world.sessionId, world.context);

    expect(outcome.status).toBe('conflict');
    expect(outcome.restored).toEqual([]);
    expect(ids(outcome.skipped)).toEqual([second.record.id, first.record.id]);

    const conflict = only(outcome.conflicts, 'conflict report');
    expect(conflict.recordId).toBe(second.record.id);
    expect(conflict.reason).toBe('content-changed');
    expect(conflict.actualHash).toBe(first.record.originalHash);

    expectNothingWritten(world.log);
    expectFileBytes(second.path, chain.pristine);
    // Both records were already in `conflict` from the first end, and stay
    // there without a journal write.
    expect(world.journal.transitions(mark)).toEqual([]);
    expect(world.journal.row(second.record.id).status).toBe('conflict');
    expect(world.journal.row(first.record.id).status).toBe('conflict');
    expect(world.removals).toEqual([]);
    expectFileBytes(first.record.backupPath, chain.pristine);
    expect(existsSync(second.record.backupPath)).toBe(true);
  });

  it('keeps the rest of the chain open when the journal refuses to close part of it', async () => {
    const world = makeWorld();
    const chain = await patchTwoLinks(world);
    const { first, second } = chain;

    await conflictOnTip(world, chain);
    writeFileSync(second.path, chain.pristine);

    const refusal = new DebuggenError('STORE_ERROR', 'The suite journal refuses this write.', {
      details: { recordId: first.record.id },
    });
    const journal: ModificationJournal = {
      ...world.journal,
      updateStatus: (id, status, patch) =>
        id === first.record.id
          ? Promise.resolve(err(refusal))
          : world.journal.updateStatus(id, status, patch),
    };

    world.resetLog();

    const mark = world.mark();
    const outcome = await cleanupSession(world.sessionId, { ...world.context, journal });

    // The tip closed; the root could not be, is reported as a failure rather
    // than with a report of its own, and keeps its pristine backup and its
    // directory. It is still in `conflict` — where the first end put it —
    // and an open `conflict` record keeps the verdict `conflict`.
    expect(outcome.status).toBe('conflict');
    expect(ids(outcome.restored)).toEqual([second.record.id]);
    expect(ids(outcome.skipped)).toEqual([first.record.id]);
    expect(outcome.conflicts).toEqual([]);

    const failure = only(outcome.failures, 'failure');
    expect(failure.recordId).toBe(first.record.id);
    expect(failure.error.code).toBe('STORE_ERROR');
    expect(failure.error.details?.['reason']).toBe('journal-transition-failed');

    expectNothingWritten(world.log);
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: second.record.id, status: 'reverted' },
    ]);
    expect(world.journal.row(first.record.id).status).toBe('conflict');
    expect(world.removals).toEqual([]);
    expectFileBytes(first.record.backupPath, chain.pristine);
    expect(existsSync(world.backups.sessionDirectory)).toBe(true);

    // With a journal that answers, the root — now the head, in `conflict` over
    // its own original — is closed without a write by the very next pass.
    world.resetLog();

    const settled = await cleanupSession(world.sessionId, world.context);

    expect(settled.status).toBe('clean');
    expect(ids(settled.restored)).toEqual([first.record.id]);
    expectNothingWritten(world.log);
    expectFileBytes(second.path, chain.pristine);
    expect(existsSync(world.backups.sessionDirectory)).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The chain beneath a conflicted record
 * ---------------------------------------------------------------------------
 */

/** The one line a walk logs when it moves the records beneath a conflict into `conflict`. */
const CHAIN_RETENTION_LOG =
  'the records beneath a conflicted modification were moved to conflict with it; their backups are kept';

/**
 * A logger that keeps every record it is handed, at every level.
 *
 * @returns The logger and the records, in emission order.
 */
function capturingLogger(): {
  readonly logger: ReturnType<typeof createConsoleLogger>;
  readonly records: LogRecord[];
} {
  const records: LogRecord[] = [];
  const logger = createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      records.push(record);
    },
  });

  return { logger, records };
}

/** The chain-retention lines among `records`. */
function retentionLines(records: readonly LogRecord[]): LogRecord[] {
  return records.filter((record) => record.message === CHAIN_RETENTION_LOG);
}

describe('the chain beneath a conflicted record', () => {
  /** The ids of a pass's list, in the order the pass reported them. */
  const ids = (records: readonly ModificationRecord[]): string[] =>
    records.map((record) => record.id);

  it('moves the root into conflict with an edited tip, keeps its pristine backup and reports the file once', async () => {
    const { logger, records } = capturingLogger();
    const world = makeWorld();
    const chain = await patchTwoLinks(world);
    const { first, second } = chain;
    const edited = developerEdits(second.path);

    world.resetLog();

    const mark = world.mark();
    const outcome = await cleanupSession(world.sessionId, { ...world.context, logger });

    expect(outcome.status).toBe('conflict');
    expect(outcome.restored).toEqual([]);
    expect(outcome.failures).toEqual([]);
    expect(outcome.forks).toEqual([]);
    // A session outcome lists its retained records with the skipped ones: the
    // tip and the root, both now in `conflict`.
    expect(ids(outcome.skipped)).toEqual([second.record.id, first.record.id]);
    expect(outcome.skipped.map((record) => record.status)).toEqual(['conflict', 'conflict']);

    // One report for the file: the tip's, naming the root's pristine backup.
    const conflict = only(outcome.conflicts, 'conflict report');
    expect(conflict.recordId).toBe(second.record.id);
    expect(conflict.reason).toBe('content-changed');
    expect(conflict.actualHash).toBe(sha256Hex(edited));
    expect(conflict.originalBackupPath).toBe(first.record.backupPath);

    // The root no longer claims the file is `applied`: it moved to `conflict`
    // at the same instant the tip was reported.
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: second.record.id, status: 'conflict' },
      { recordId: first.record.id, status: 'conflict' },
    ]);
    expect(world.journal.row(first.record.id).status).toBe('conflict');
    expect(world.journal.row(first.record.id).appliedAt).toBe(FIXED_NOW);

    // Nothing was written, and every backup is where it was.
    expectNothingWritten(world.log);
    expectFileBytes(second.path, edited);
    expect(world.removals).toEqual([]);
    expectFileBytes(first.record.backupPath, chain.pristine);
    expectFileBytes(second.record.backupPath, first.instrumentedBytes);
    expect(existsSync(world.backups.sessionDirectory)).toBe(true);

    // One line for the chain, identifiers and counts only.
    const line = only(retentionLines(records), 'chain retention log line');
    expect(line.level).toBe('info');
    expect(line.fields).toEqual({
      sessionId: world.sessionId,
      recordId: second.record.id,
      reason: 'content-changed',
      moved: 1,
      kept: 0,
      refused: 0,
    });

    // A walk of the chain as it now stands partitions it as retained, not
    // skipped, and journals nothing: the root is already in `conflict`.
    world.resetLog();

    const repeatMark = world.mark();
    const repeat = await restoreChain(
      [first.record, second.record].map((record) => world.journal.row(record.id)),
      { ...world.context, logger },
    );

    expect(ids(repeat.retained)).toEqual([second.record.id, first.record.id]);
    expect(repeat.skipped).toEqual([]);
    expect(repeat.failures).toEqual([]);
    expect(repeat.stoppedAt?.id).toBe(second.record.id);
    expect(only(repeat.conflicts, 'renewed report').recordId).toBe(second.record.id);
    expect(world.journal.transitions(repeatMark)).toEqual([]);
    expectNothingWritten(world.log);
    expect(retentionLines(records).at(-1)?.fields).toMatchObject({ moved: 0, kept: 1 });
    expect(existsSync(first.record.backupPath)).toBe(true);
  });

  it('closes the whole chain without a write once the file is put back to the root’s original', async () => {
    const world = makeWorld();
    const chain = await patchTwoLinks(world);
    const { first, second } = chain;

    await conflictOnTip(world, chain);

    // Resolved the way version control resolves it: the committed file.
    const committed = readFileSync(join(FIXTURE_PROJECT, TARGET_FILE));

    expect(sha256Hex(committed)).toBe(first.record.originalHash);
    writeFileSync(second.path, committed);
    world.watch(TARGET_FILE);
    world.resetLog();

    const mark = world.mark();
    const settled = await cleanupSession(world.sessionId, world.context);

    expect(settled.status).toBe('clean');
    expect(ids(settled.restored)).toEqual([second.record.id, first.record.id]);
    expect(settled.restored.map((record) => record.status)).toEqual(['reverted', 'reverted']);
    expect(settled.conflicts).toEqual([]);
    expect(settled.skipped).toEqual([]);
    expect(settled.failures).toEqual([]);

    // Both `conflict → reverted`, without a byte written: the file already is
    // the original, and stays exactly the developer's copy of it.
    expectNothingWritten(world.log);
    expectFileBytes(second.path, committed);
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: second.record.id, status: 'reverted' },
      { recordId: first.record.id, status: 'reverted' },
    ]);
    expect(only(world.removals, 'verified backup deletion').watchedDigest).toBe(
      first.record.originalHash,
    );
    expect(existsSync(world.backups.sessionDirectory)).toBe(false);
  });

  it('restores the chain link by link once the developer undoes the edit on the tip', async () => {
    const world = makeWorld();
    const chain = await patchTwoLinks(world);
    const { first, second } = chain;

    await conflictOnTip(world, chain);

    writeFileSync(second.path, second.instrumentedBytes);
    world.watch(TARGET_FILE);
    world.resetLog();

    const mark = world.mark();
    const settled = await cleanupSession(world.sessionId, world.context);

    expect(settled.status).toBe('clean');
    expect(ids(settled.restored)).toEqual([second.record.id, first.record.id]);
    expect(settled.conflicts).toEqual([]);
    expect(settled.skipped).toEqual([]);
    expect(settled.failures).toEqual([]);

    // A root in `conflict` is restored like any record whose file holds what
    // it wrote: each write conditional on that link's own output.
    expect(world.log.writes.map((write) => write.expectedHash)).toEqual([
      second.record.instrumentedHash,
      first.record.instrumentedHash,
    ]);
    expect(world.log.writes.map((write) => write.contentHash)).toEqual([
      second.record.originalHash,
      first.record.originalHash,
    ]);
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: second.record.id, status: 'reverted' },
      { recordId: first.record.id, status: 'reverted' },
    ]);
    expectFileBytes(second.path, chain.pristine);
    expect(existsSync(first.record.backupPath)).toBe(false);
    expect(existsSync(second.record.backupPath)).toBe(false);
    expect(existsSync(world.backups.sessionDirectory)).toBe(false);
  });

  it('moves the root into conflict the same way in a start-up reconciliation', async () => {
    const world = makeWorld();

    world.journal.noteSessionStatus(world.sessionId, 'generated');

    const chain = await patchTwoLinks(world);
    const { first, second } = chain;
    const edited = developerEdits(second.path);

    world.resetLog();

    const mark = world.mark();
    const outcome = await reconcileModifications(world.context);

    expect(outcome.status).toBe('conflict');
    expect(outcome.examined).toBe(2);
    expect(ids(outcome.retained)).toEqual([second.record.id, first.record.id]);
    expect(outcome.retained.map((record) => record.status)).toEqual(['conflict', 'conflict']);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.restored).toEqual([]);
    expect(outcome.closed).toEqual([]);
    expect(outcome.failures).toEqual([]);

    const conflict = only(outcome.conflicts, 'conflict report');
    expect(conflict.recordId).toBe(second.record.id);
    expect(conflict.originalBackupPath).toBe(first.record.backupPath);

    expect(world.journal.transitions(mark)).toEqual([
      { recordId: second.record.id, status: 'conflict' },
      { recordId: first.record.id, status: 'conflict' },
    ]);
    expectNothingWritten(world.log);
    expectFileBytes(second.path, edited);
    expectFileBytes(first.record.backupPath, chain.pristine);
    expect(existsSync(world.backups.sessionDirectory)).toBe(true);
    expect(world.journal.sessionStatusOf(world.sessionId)).toBe('generated');
  });

  it('moves every link beneath an edited tip into conflict, however deep the chain, and closes them all together', async () => {
    const world = makeWorld();
    const pristine = readFileSync(world.pathOf(OTHER_FILE));
    const [first, second, third] = await patchThreeLinks(world);
    const edited = developerEdits(third.path);

    world.resetLog();

    const mark = world.mark();
    const chain = await restoreChain(
      [first.record, second.record, third.record].map((record) => world.journal.row(record.id)),
      world.context,
    );

    expect(chain.stoppedAt?.id).toBe(third.record.id);
    expect(chain.outcomes.map((outcome) => outcome.kind)).toEqual(['conflict']);
    expect(ids(chain.retained)).toEqual([third.record.id, second.record.id, first.record.id]);
    expect(chain.retained.map((record) => record.status)).toEqual([
      'conflict',
      'conflict',
      'conflict',
    ]);
    expect(chain.skipped).toEqual([]);
    expect(chain.failures).toEqual([]);

    const conflict = only(chain.conflicts, 'conflict report');
    expect(conflict.recordId).toBe(third.record.id);
    expect(conflict.originalBackupPath).toBe(first.record.backupPath);

    expect(world.journal.transitions(mark)).toEqual([
      { recordId: third.record.id, status: 'conflict' },
      { recordId: second.record.id, status: 'conflict' },
      { recordId: first.record.id, status: 'conflict' },
    ]);
    expectNothingWritten(world.log);
    expectFileBytes(third.path, edited);

    for (const link of [first, second, third]) {
      expectFileBytes(link.record.backupPath, link.originalBytes);
    }

    // Put back to the pristine file: a start-up pass closes all three at once.
    writeFileSync(third.path, pristine);
    world.resetLog();

    const closeMark = world.mark();
    const closed = await reconcileModifications(world.context);

    expect(closed.status).toBe('clean');
    expect(ids(closed.closed)).toEqual([third.record.id, second.record.id, first.record.id]);
    expect(closed.retained).toEqual([]);
    expect(closed.conflicts).toEqual([]);
    expectNothingWritten(world.log);
    expectFileBytes(third.path, pristine);
    expect(world.journal.transitions(closeMark)).toEqual([
      { recordId: third.record.id, status: 'reverted' },
      { recordId: second.record.id, status: 'reverted' },
      { recordId: first.record.id, status: 'reverted' },
    ]);
    expect(existsSync(world.backups.sessionDirectory)).toBe(false);
  });

  it.each(['pending', 'failed'] as const)(
    'moves a %s record beneath an edited tip into conflict as well',
    async (status) => {
      const world = makeWorld();
      const chain = await patchTwoLinks(world);
      const { first, second } = chain;

      world.journal.arrange({ ...world.journal.row(first.record.id), status });
      developerEdits(second.path);
      world.resetLog();

      const mark = world.mark();
      const outcome = await restoreChain(
        [first.record, second.record].map((record) => world.journal.row(record.id)),
        world.context,
      );

      expect(ids(outcome.retained)).toEqual([second.record.id, first.record.id]);
      expect(outcome.skipped).toEqual([]);
      expect(world.journal.transitions(mark)).toEqual([
        { recordId: second.record.id, status: 'conflict' },
        { recordId: first.record.id, status: 'conflict' },
      ]);
      expectNothingWritten(world.log);
      expectFileBytes(first.record.backupPath, chain.pristine);
    },
  );

  it('moves the root into conflict when the tip’s file and its directory are gone', async () => {
    const { logger, records } = capturingLogger();
    const world = makeWorld();
    const chain = await patchTwoLinks(world);
    const { first, second } = chain;

    rmSync(dirname(second.path), { recursive: true, force: true });
    world.resetLog();

    const mark = world.mark();
    const outcome = await restoreChain(
      [first.record, second.record].map((record) => world.journal.row(record.id)),
      { ...world.context, logger },
    );

    const conflict = only(outcome.conflicts, 'conflict report');
    expect(conflict.recordId).toBe(second.record.id);
    expect(conflict.reason).toBe('file-missing');
    expect(conflict.actualHash).toBeUndefined();

    expect(ids(outcome.retained)).toEqual([second.record.id, first.record.id]);
    expect(outcome.skipped).toEqual([]);
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: second.record.id, status: 'conflict' },
      { recordId: first.record.id, status: 'conflict' },
    ]);
    expectNothingWritten(world.log);
    expect(existsSync(second.path)).toBe(false);
    expectFileBytes(first.record.backupPath, chain.pristine);
    expect(only(retentionLines(records), 'chain retention log line').fields).toMatchObject({
      reason: 'file-missing',
      moved: 1,
    });
  });

  it('leaves the root applied and skipped when the tip’s backup cannot be read back', async () => {
    const { logger, records } = capturingLogger();
    const world = makeWorld();
    const chain = await patchTwoLinks(world);
    const { first, second } = chain;

    // The file still holds the tip's output, so it is not the file that says
    // anything about the root: only the tip's original is gone.
    rmSync(second.record.backupPath);
    world.resetLog();

    const mark = world.mark();
    const outcome = await restoreChain(
      [first.record, second.record].map((record) => world.journal.row(record.id)),
      { ...world.context, logger },
    );

    expect(only(outcome.conflicts, 'conflict report').reason).toBe('backup-missing');
    expect(ids(outcome.retained)).toEqual([second.record.id]);
    expect(ids(outcome.skipped)).toEqual([first.record.id]);
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: second.record.id, status: 'conflict' },
    ]);
    expect(world.journal.row(first.record.id).status).toBe('applied');
    expectNothingWritten(world.log);
    expectFileBytes(second.path, second.instrumentedBytes);
    expectFileBytes(first.record.backupPath, chain.pristine);
    expect(retentionLines(records)).toEqual([]);
  });

  it('leaves the root applied when an applied tip’s file holds the bytes it replaced — the root’s own output', async () => {
    const world = makeWorld();
    const chain = await patchTwoLinks(world);
    const { first, second } = chain;

    // Put back to plan version 1's output behind the tool's back: reported for
    // the `applied` tip as `content-changed`, but the root's bytes are on disk
    // and the root must stay restorable as it is.
    writeFileSync(second.path, first.instrumentedBytes);
    world.resetLog();

    const mark = world.mark();
    const reported = await cleanupSession(world.sessionId, world.context);

    expect(reported.status).toBe('conflict');

    const conflict = only(reported.conflicts, 'conflict report');
    expect(conflict.recordId).toBe(second.record.id);
    expect(conflict.reason).toBe('content-changed');
    expect(conflict.actualHash).toBe(first.record.instrumentedHash);
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: second.record.id, status: 'conflict' },
    ]);
    expect(world.journal.row(first.record.id).status).toBe('applied');
    expectNothingWritten(world.log);

    // The next pass closes the tip over the bytes it replaced and restores the
    // root from its own backup.
    world.resetLog();

    const settleMark = world.mark();
    const settled = await cleanupSession(world.sessionId, world.context);

    expect(settled.status).toBe('clean');
    expect(ids(settled.restored)).toEqual([first.record.id, second.record.id]);
    expect(only(world.log.writes, 'conditional write').expectedHash).toBe(
      first.record.instrumentedHash,
    );
    expect(world.journal.transitions(settleMark)).toEqual([
      { recordId: second.record.id, status: 'reverted' },
      { recordId: first.record.id, status: 'reverted' },
    ]);
    expectFileBytes(second.path, chain.pristine);
  });

  it('keeps a record whose move into conflict the journal refused, and every record beneath it, as they were', async () => {
    const { logger, records } = capturingLogger();
    const world = makeWorld();
    const [first, second, third] = await patchThreeLinks(world);

    developerEdits(third.path);

    const refusal = new DebuggenError('STORE_ERROR', 'The suite journal refuses this write.', {
      details: { recordId: second.record.id },
    });
    const journal: ModificationJournal = {
      ...world.journal,
      updateStatus: (id, status, patch) =>
        id === second.record.id && status === 'conflict'
          ? Promise.resolve(err(refusal))
          : world.journal.updateStatus(id, status, patch),
    };

    world.resetLog();

    const mark = world.mark();
    const outcome = await cleanupSession(world.sessionId, { ...world.context, journal, logger });

    // The pass resolved rather than threw: the tip's conflict is reported, the
    // refusal is a failure of the middle link, and the root was not touched.
    expect(outcome.status).toBe('conflict');
    expect(only(outcome.conflicts, 'conflict report').recordId).toBe(third.record.id);
    expect(ids(outcome.skipped)).toEqual([third.record.id, second.record.id, first.record.id]);

    const failure = only(outcome.failures, 'failure');
    expect(failure.recordId).toBe(second.record.id);
    expect(failure.error.code).toBe('STORE_ERROR');
    expect(failure.error.details?.['reason']).toBe('journal-transition-failed');
    expect(failure.error.details?.['status']).toBe('conflict');

    expect(world.journal.transitions(mark)).toEqual([
      { recordId: third.record.id, status: 'conflict' },
    ]);
    expect(world.journal.row(second.record.id).status).toBe('applied');
    expect(world.journal.row(first.record.id).status).toBe('applied');
    expectNothingWritten(world.log);

    for (const link of [first, second, third]) {
      expect(existsSync(link.record.backupPath)).toBe(true);
    }

    expect(only(retentionLines(records), 'chain retention log line').fields).toMatchObject({
      recordId: third.record.id,
      moved: 0,
      kept: 0,
      refused: 1,
      refusedRecordId: second.record.id,
    });

    // With a journal that answers, the next pass finishes the move.
    const retryMark = world.mark();
    const retried = await cleanupSession(world.sessionId, world.context);

    expect(retried.status).toBe('conflict');
    expect(retried.failures).toEqual([]);
    expect(world.journal.transitions(retryMark)).toEqual([
      { recordId: second.record.id, status: 'conflict' },
      { recordId: first.record.id, status: 'conflict' },
    ]);
  });

  it('lets a new session instrument the file again once the developer restores it', async () => {
    const world = makeWorld();
    const chain = await patchTwoLinks(world);
    const { first, second } = chain;

    await conflictOnTip(world, chain);

    // The developer restores the committed file, and the next session plans
    // the same two wraps before anybody ends the old session again. Its first
    // patch reproduces the old root's output byte for byte — a deterministic
    // transform — and that root, in `conflict`, holds nothing.
    writeFileSync(second.path, chain.pristine);

    const next = nextSessionId('next');
    const nextFirst = await patchSymbol(world, {
      file: TARGET_FILE,
      symbol: TARGET_SYMBOL,
      sessionId: next,
    });
    const nextSecond = await patchSymbol(world, {
      file: TARGET_FILE,
      symbol: SECOND_SYMBOL,
      planVersion: 2,
      sessionId: next,
    });

    expect(nextFirst.record.instrumentedHash).toBe(first.record.instrumentedHash);
    expect(nextSecond.record.previousRecordId).toBe(nextFirst.record.id);
    expect(nextSecond.record.status).toBe('applied');

    // The new session's end puts the file back, and a repeated end of the old
    // one then closes its chain over the pristine file.
    const nextEnded = await cleanupSession(next, {
      ...world.context,
      backups: world.storeFor(next),
    });

    expect(nextEnded.status).toBe('clean');
    expectFileBytes(second.path, chain.pristine);

    const oldEnded = await cleanupSession(world.sessionId, world.context);

    expect(oldEnded.status).toBe('clean');
    expect(ids(oldEnded.restored)).toEqual([second.record.id, first.record.id]);
    expectFileBytes(second.path, chain.pristine);
    expect(existsSync(world.backups.sessionDirectory)).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Another session's live claim on the same bytes
 * ---------------------------------------------------------------------------
 */

/** The line a pass logs once when it closes a chain beside another session's claim. */
const CLAIM_CLOSE_LOG =
  'another session holds these bytes over the same original; this session’s modifications are closed without a write';

/** The line a pass logs once when it withholds a restore because of another session's claim. */
const CLAIM_REFUSAL_LOG =
  'another session holds the bytes this restore would replace; nothing was written';

/**
 * An old session's chain in `conflict` under a later session's identical,
 * live chain over the same file — the state the documented recovery from a
 * conflict leads to: restore the committed file, then start a new session.
 */
interface StaleChainUnderLiveSession {
  /** The old session's chain, both links in `conflict`; its session is the world's. */
  readonly stale: TwoLinkChain;

  /** The later session. */
  readonly liveSessionId: string;

  /** The later session's first link, byte-identical to the stale root's output. */
  readonly liveFirst: PatchedFile;

  /** The later session's second link, byte-identical to the stale tip's output. */
  readonly liveSecond: PatchedFile;
}

/**
 * Builds {@link StaleChainUnderLiveSession} with the real patcher: the world's
 * session chains two wraps over {@link TARGET_FILE}, ends over an edit (both
 * links move to `conflict`), the developer puts the committed file back, and a
 * new session plans the same two wraps. The deterministic transform makes the
 * new chain reproduce the old one's digests exactly, and the file holds the
 * new tip's bytes — which are also the old tip's `instrumentedHash`.
 *
 * @param world The sandbox.
 * @returns Both chains.
 */
async function staleChainUnderLiveSession(world: World): Promise<StaleChainUnderLiveSession> {
  const stale = await patchTwoLinks(world);

  await conflictOnTip(world, stale);
  writeFileSync(stale.second.path, stale.pristine);

  const liveSessionId = nextSessionId('live');
  const liveFirst = await patchSymbol(world, {
    file: TARGET_FILE,
    symbol: TARGET_SYMBOL,
    sessionId: liveSessionId,
  });
  const liveSecond = await patchSymbol(world, {
    file: TARGET_FILE,
    symbol: SECOND_SYMBOL,
    planVersion: 2,
    sessionId: liveSessionId,
  });

  expect(liveFirst.record.instrumentedHash).toBe(stale.first.record.instrumentedHash);
  expect(liveSecond.record.instrumentedHash).toBe(stale.second.record.instrumentedHash);
  expect(liveSecond.record.previousRecordId).toBe(liveFirst.record.id);
  expect(liveSecond.record.status).toBe('applied');
  expect(digestOf(stale.second.path)).toBe(stale.second.record.instrumentedHash);

  return { stale, liveSessionId, liveFirst, liveSecond };
}

/**
 * The world's context with every session placed in the world's one project,
 * which is where every patch of these cases landed.
 *
 * @param world The sandbox.
 * @param sessionId Whose backup store the context carries; the world's own by default.
 * @returns The context.
 */
function placedContext(world: World, sessionId = world.sessionId): CleanupContext {
  return {
    ...world.context,
    backups: world.storeFor(sessionId),
    projectRootOf: (): string => world.projectRoot,
  };
}

/**
 * A scope resolver placing every session's records in the world's one project,
 * each with its own session's backup store.
 *
 * @param world The sandbox.
 * @returns The resolver.
 */
function worldScopes(world: World): (record: ModificationRecord) => Result<RecordScope> {
  return (record: ModificationRecord): Result<RecordScope> =>
    ok({ projectRoot: world.projectRoot, backups: world.storeFor(record.sessionId) });
}

/** How many times a pass asked the journal for every open record, from `from` on. */
function openListings(world: World, from: number): number {
  return world.journal.calls.slice(from).filter((call) => call.kind === 'listOpen').length;
}

/** A journal that answers every call like `journal`, except `listOpen`, which fails. */
function journalWithoutListing(journal: TestJournal): {
  readonly journal: ModificationJournal;
  readonly listings: () => number;
} {
  let listings = 0;

  return {
    journal: {
      append: (record) => journal.append(record),
      updateStatus: (id, status, patch) => journal.updateStatus(id, status, patch),
      listBySession: (sessionId) => journal.listBySession(sessionId),
      listOpen: (): Promise<Result<ModificationRecord[]>> => {
        listings += 1;

        return Promise.resolve(
          err(
            new DebuggenError('STORE_ERROR', 'The suite journal cannot list open records.', {
              hint: 'A case failing the cross-session listing on purpose.',
            }),
          ),
        );
      },
    },
    listings: (): number => listings,
  };
}

describe('another session’s live claim on the bytes a restore would replace', () => {
  /** The ids of a pass's list, in the order the pass reported them. */
  const ids = (records: readonly ModificationRecord[]): string[] =>
    records.map((record) => record.id);

  it('closes a stale chain reached first by a start-up reconciliation without a write, then restores the live one', async () => {
    const samples: string[] = [];
    const records: LogRecord[] = [];
    const world = makeWorld();
    const { stale, liveSessionId, liveFirst, liveSecond } = await staleChainUnderLiveSession(world);
    const path = stale.second.path;
    const logger = createConsoleLogger({
      level: 'trace',
      sink: (record) => {
        records.push(record);

        // The file as it stands when the stale chain's decision is taken.
        if (record.message === CLAIM_CLOSE_LOG) {
          samples.push(digestOf(path));
        }
      },
    });

    // The stale session's group is the latest-touched, so the pass reaches it
    // before the live session's.
    const later = Math.max(liveFirst.record.appliedAt, liveSecond.record.appliedAt) + 60_000;

    for (const link of [stale.first, stale.second]) {
      world.journal.arrange({ ...world.journal.row(link.record.id), appliedAt: later });
    }

    world.resetLog();

    const mark = world.mark();
    const outcome = await reconcileModifications(
      { ...world.context, logger },
      { scopeFor: worldScopes(world) },
    );

    expect(outcome.status).toBe('clean');
    expect(outcome.examined).toBe(4);
    expect(ids(outcome.closed)).toEqual([stale.second.record.id, stale.first.record.id]);
    expect(ids(outcome.restored)).toEqual([liveSecond.record.id, liveFirst.record.id]);
    expect(outcome.retained).toEqual([]);
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.failures).toEqual([]);

    // The stale chain closed first, and wrote nothing: the file still held the
    // live tip's bytes when it was decided, and the only two writes are the
    // live session's own restores, which then took the file back to pristine.
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: stale.second.record.id, status: 'reverted' },
      { recordId: stale.first.record.id, status: 'reverted' },
      { recordId: liveSecond.record.id, status: 'reverted' },
      { recordId: liveFirst.record.id, status: 'reverted' },
    ]);
    expect(samples).toEqual([liveSecond.record.instrumentedHash]);
    expect(world.log.writes.map((write) => write.expectedHash)).toEqual([
      liveSecond.record.instrumentedHash,
      liveFirst.record.instrumentedHash,
    ]);
    expectFileBytes(path, stale.pristine);

    // No false conflict for the live session, one listing for the whole pass,
    // and one decision line carrying identifiers only.
    expect(world.journal.row(liveSecond.record.id).status).toBe('reverted');
    expect(openListings(world, mark)).toBe(1);
    expect(
      only(
        records.filter((record) => record.message === CLAIM_CLOSE_LOG),
        'claim close line',
      ).fields,
    ).toEqual({
      recordId: stale.second.record.id,
      sessionId: world.sessionId,
      status: 'conflict',
      holderRecordIds: [liveSecond.record.id],
      holderSessionIds: [liveSessionId],
      closed: 2,
    });

    // Both sessions left clean, so both backup directories are gone.
    expect(existsSync(world.backups.sessionDirectory)).toBe(false);
    expect(existsSync(world.storeFor(liveSessionId).sessionDirectory)).toBe(false);
  });

  it('is clean in one pass when the live session’s group comes first: restored, then the stale chain closes', async () => {
    const world = makeWorld();
    const { stale, liveFirst, liveSecond } = await staleChainUnderLiveSession(world);
    const earlier = Math.min(liveFirst.record.appliedAt, liveSecond.record.appliedAt) - 60_000;

    for (const link of [stale.first, stale.second]) {
      world.journal.arrange({ ...world.journal.row(link.record.id), appliedAt: earlier });
    }

    world.resetLog();

    const mark = world.mark();
    const outcome = await reconcileModifications(world.context, { scopeFor: worldScopes(world) });

    expect(outcome.status).toBe('clean');
    expect(ids(outcome.restored)).toEqual([liveSecond.record.id, liveFirst.record.id]);
    expect(ids(outcome.closed)).toEqual([stale.second.record.id, stale.first.record.id]);
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.failures).toEqual([]);
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: liveSecond.record.id, status: 'reverted' },
      { recordId: liveFirst.record.id, status: 'reverted' },
      { recordId: stale.second.record.id, status: 'reverted' },
      { recordId: stale.first.record.id, status: 'reverted' },
    ]);
    expect(world.log.writes).toHaveLength(2);
    expectFileBytes(stale.second.path, stale.pristine);
    expect(openListings(world, mark)).toBe(1);
  });

  it('closes a stale chain on its session’s end while the live session holds the bytes, and leaves the live chain alone', async () => {
    const { logger, records } = capturingLogger();
    const world = makeWorld();
    const { stale, liveSessionId, liveFirst, liveSecond } = await staleChainUnderLiveSession(world);
    const liveRows = [liveFirst, liveSecond].map((link) => world.journal.row(link.record.id));

    world.resetLog();

    const mark = world.mark();
    const outcome = await cleanupSession(world.sessionId, { ...placedContext(world), logger });

    expect(outcome.status).toBe('clean');
    expect(ids(outcome.restored)).toEqual([stale.second.record.id, stale.first.record.id]);
    expect(outcome.restored.map((record) => record.status)).toEqual(['reverted', 'reverted']);
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.failures).toEqual([]);

    // Not a byte written: the file is still the live session's patch, and the
    // live session's records are exactly as they were.
    expectNothingWritten(world.log);
    expectFileBytes(stale.second.path, liveSecond.instrumentedBytes);
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: stale.second.record.id, status: 'reverted' },
      { recordId: stale.first.record.id, status: 'reverted' },
    ]);
    expect([liveFirst, liveSecond].map((link) => world.journal.row(link.record.id))).toEqual(
      liveRows,
    );

    // No verified deletion was queued — the file does not hold the stale
    // chain's original — and its backups left with its directory.
    expect(world.removals).toEqual([]);
    expect(existsSync(world.backups.sessionDirectory)).toBe(false);
    expect(existsSync(liveFirst.record.backupPath)).toBe(true);
    expect(existsSync(liveSecond.record.backupPath)).toBe(true);

    // One lazy listing, one decision line, no per-record close wording and no
    // warning.
    expect(openListings(world, mark)).toBe(1);
    expect(records.filter((record) => record.message === CLAIM_CLOSE_LOG)).toHaveLength(1);
    expect(
      records.some((record) => record.message.startsWith('a superseded modification was closed')),
    ).toBe(false);
    expect(records.filter((record) => record.level === 'warn')).toEqual([]);

    // The live session's own end then restores the file.
    const liveEnded = await cleanupSession(liveSessionId, placedContext(world, liveSessionId));

    expect(liveEnded.status).toBe('clean');
    expect(ids(liveEnded.restored)).toEqual([liveSecond.record.id, liveFirst.record.id]);
    expect(liveEnded.conflicts).toEqual([]);
    expectFileBytes(stale.second.path, stale.pristine);
    expect(existsSync(world.storeFor(liveSessionId).sessionDirectory)).toBe(false);
  });

  it('closes a single stale record the same way, and the live session’s end restores the file', async () => {
    const world = makeWorld();
    const stale = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    developerEdits(stale.path);
    expect((await cleanupSession(world.sessionId, world.context)).status).toBe('conflict');
    expect(world.journal.row(stale.record.id).status).toBe('conflict');
    writeFileSync(stale.path, stale.originalBytes);

    const liveSessionId = nextSessionId('live');
    const live = await patchSymbol(world, {
      file: TARGET_FILE,
      symbol: TARGET_SYMBOL,
      sessionId: liveSessionId,
    });

    expect(live.record.instrumentedHash).toBe(stale.record.instrumentedHash);
    expect(live.record.previousRecordId).toBeUndefined();

    world.resetLog();

    const mark = world.mark();
    const outcome = await cleanupSession(world.sessionId, placedContext(world));

    expect(outcome.status).toBe('clean');
    expect(ids(outcome.restored)).toEqual([stale.record.id]);
    expect(outcome.failures).toEqual([]);
    expectNothingWritten(world.log);
    expectFileBytes(stale.path, live.instrumentedBytes);
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: stale.record.id, status: 'reverted' },
    ]);
    expect(world.journal.row(live.record.id).status).toBe('applied');
    expect(world.removals).toEqual([]);
    expect(existsSync(world.backups.sessionDirectory)).toBe(false);

    const liveEnded = await cleanupSession(liveSessionId, placedContext(world, liveSessionId));

    expect(liveEnded.status).toBe('clean');
    expect(ids(liveEnded.restored)).toEqual([live.record.id]);
    expectFileBytes(stale.path, stale.originalBytes);
  });

  it('writes nothing and closes nothing beside a claim that descends from a different original', async () => {
    const { logger, records } = capturingLogger();
    const world = makeWorld();
    const { stale, liveSessionId, liveFirst, liveSecond } = await staleChainUnderLiveSession(world);

    // The live chain's root is journaled as having started from other bytes
    // than the stale chain's pristine file. No run of the deterministic
    // transform produces that beside identical output — a wrap records where
    // its function sat in the file it was given — so the journal is arranged
    // the way another tool version or a hand-edited journal could leave it:
    // the two sessions' backups then cannot stand in for each other.
    const otherOriginal = sha256Hex(Buffer.concat([stale.pristine, Buffer.from(DEVELOPER_EDIT)]));

    world.journal.arrange({
      ...world.journal.row(liveFirst.record.id),
      originalHash: otherOriginal,
    });

    const liveRows = [liveFirst, liveSecond].map((link) => world.journal.row(link.record.id));

    world.resetLog();

    const mark = world.mark();
    const context = { ...placedContext(world), logger };
    const outcome = await cleanupSession(world.sessionId, context);

    expect(outcome.status).toBe('conflict');
    expect(outcome.restored).toEqual([]);
    expect(outcome.conflicts).toEqual([]);
    expect(ids(outcome.skipped)).toEqual([stale.second.record.id, stale.first.record.id]);
    expect(outcome.skipped.map((record) => record.status)).toEqual(['conflict', 'conflict']);

    const failure = only(outcome.failures, 'withheld restore');
    expect(failure.recordId).toBe(stale.second.record.id);
    expect(failure.error.code).toBe('CLEANUP_PARTIAL');
    expect(failure.error.details).toMatchObject({
      reason: 'claim-over-another-original',
      recordId: stale.second.record.id,
      holderRecordIds: [liveSecond.record.id],
      holderSessionIds: [liveSessionId],
    });

    // Nothing written, nothing journaled, every backup where it was, and the
    // live chain exactly as it stood.
    expectNothingWritten(world.log);
    expectFileBytes(stale.second.path, liveSecond.instrumentedBytes);
    expect(world.journal.transitions(mark)).toEqual([]);
    expect(world.removals).toEqual([]);
    expectFileBytes(stale.first.record.backupPath, stale.pristine);
    expect(existsSync(stale.second.record.backupPath)).toBe(true);
    expect([liveFirst, liveSecond].map((link) => world.journal.row(link.record.id))).toEqual(
      liveRows,
    );
    expect(
      only(
        records.filter((record) => record.message === CLAIM_REFUSAL_LOG),
        'refusal line',
      ).fields,
    ).toEqual({
      recordId: stale.second.record.id,
      sessionId: world.sessionId,
      status: 'conflict',
      reason: 'claim-over-another-original',
      holderRecordIds: [liveSecond.record.id],
      holderSessionIds: [liveSessionId],
    });

    // The other two entry points refuse the same write the same way, and so
    // does the same pass run again: the refusal is state, not luck.
    const rows = [stale.first, stale.second].map((link) => world.journal.row(link.record.id));
    const chained = await restoreChain(rows, context);

    expect(chained.restored).toEqual([]);
    expect(chained.closed).toEqual([]);
    expect(ids(chained.skipped)).toEqual([stale.second.record.id, stale.first.record.id]);
    expect(only(chained.failures, 'withheld chain restore').error.details?.['reason']).toBe(
      'claim-over-another-original',
    );

    const single = refusalOf(
      await restoreModification(world.journal.row(stale.second.record.id), context),
      'the stale tip on its own',
    );

    expect(single.details?.['reason']).toBe('claim-over-another-original');

    const again = await cleanupSession(world.sessionId, context);

    expect(again.status).toBe('conflict');
    expect(only(again.failures, 'withheld restore, again').error.details?.['reason']).toBe(
      'claim-over-another-original',
    );
    expectNothingWritten(world.log);
    expect(world.journal.transitions(mark)).toEqual([]);
    expectFileBytes(stale.second.path, liveSecond.instrumentedBytes);
  });

  it('never defers to another session’s record in conflict: the live session’s own end restores normally', async () => {
    const world = makeWorld();
    const { stale, liveSessionId, liveFirst, liveSecond } = await staleChainUnderLiveSession(world);

    // Journaled after the live chain, so only their status — not their age —
    // keeps the stale records from counting as a claim.
    const later = Math.max(liveFirst.record.appliedAt, liveSecond.record.appliedAt) + 60_000;

    for (const link of [stale.first, stale.second]) {
      world.journal.arrange({ ...world.journal.row(link.record.id), appliedAt: later });
    }

    world.resetLog();

    const mark = world.mark();
    const liveEnded = await cleanupSession(liveSessionId, placedContext(world, liveSessionId));

    expect(liveEnded.status).toBe('clean');
    expect(ids(liveEnded.restored)).toEqual([liveSecond.record.id, liveFirst.record.id]);
    expect(liveEnded.failures).toEqual([]);
    expect(world.log.writes.map((write) => write.expectedHash)).toEqual([
      liveSecond.record.instrumentedHash,
      liveFirst.record.instrumentedHash,
    ]);
    expectFileBytes(stale.second.path, stale.pristine);

    // The stale chain was neither written for nor touched.
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: liveSecond.record.id, status: 'reverted' },
      { recordId: liveFirst.record.id, status: 'reverted' },
    ]);
    expect(world.journal.row(stale.second.record.id).status).toBe('conflict');
    expect(world.journal.row(stale.first.record.id).status).toBe('conflict');
  });

  it('refuses every write that needs the listing when the other sessions’ records cannot be read', async () => {
    const world = makeWorld();
    const chain = await patchTwoLinks(world);
    const other = await patchSymbol(world, { file: OTHER_FILE, symbol: OTHER_SYMBOL });
    const failing = journalWithoutListing(world.journal);

    world.resetLog();

    const mark = world.mark();
    const outcome = await cleanupSession(world.sessionId, {
      ...world.context,
      journal: failing.journal,
    });

    expect(outcome.status).toBe('partial');
    expect(outcome.restored).toEqual([]);
    expect(outcome.conflicts).toEqual([]);
    expect(ids(outcome.skipped)).toEqual([
      other.record.id,
      chain.second.record.id,
      chain.first.record.id,
    ]);
    expect(outcome.failures.map((failure) => failure.recordId)).toEqual([
      other.record.id,
      chain.second.record.id,
    ]);

    for (const failure of outcome.failures) {
      expect(failure.error.code).toBe('STORE_ERROR');
      expect(failure.error.details?.['reason']).toBe('open-records-unreadable');
    }

    // One listing for the pass, however many files needed it, and nothing
    // written or journaled for any of them.
    expect(failing.listings()).toBe(1);
    expectNothingWritten(world.log);
    expect(world.journal.transitions(mark)).toEqual([]);
    expect(world.removals).toEqual([]);
    expectFileBytes(chain.second.path, chain.second.instrumentedBytes);
    expectFileBytes(other.path, other.instrumentedBytes);

    for (const record of [other.record, chain.first.record, chain.second.record]) {
      expect(world.journal.row(record.id).status).toBe('applied');
      expect(existsSync(record.backupPath)).toBe(true);
    }

    // The installer's single-record rollback refuses the same way.
    const single = refusalOf(
      await restoreModification(world.journal.row(other.record.id), {
        ...world.context,
        journal: failing.journal,
      }),
      'a rollback without the listing',
    );

    expect(single.details?.['reason']).toBe('open-records-unreadable');
    expectNothingWritten(world.log);

    // A journal that answers again restores everything.
    expect((await cleanupSession(world.sessionId, world.context)).status).toBe('clean');
    expectFileBytes(chain.second.path, chain.pristine);
    expectFileBytes(other.path, other.originalBytes);
  });

  it('refuses a claim it cannot place, in the per-session shape a start-up pass takes, writing and closing nothing', async () => {
    const world = makeWorld();
    const { stale, liveSessionId, liveSecond } = await staleChainUnderLiveSession(world);

    world.resetLog();

    const mark = world.mark();

    // The service's start-up shape: one session at a time, no resolver.
    const reconciled = await reconcileModifications(world.context, {
      sessionIds: [world.sessionId],
    });

    expect(reconciled.status).toBe('conflict');
    expect(reconciled.closed).toEqual([]);
    expect(reconciled.restored).toEqual([]);
    expect(ids(reconciled.skipped)).toEqual([stale.second.record.id, stale.first.record.id]);
    expect(only(reconciled.failures, 'unplaced claim').error.details).toMatchObject({
      reason: 'claim-unplaced',
      holderRecordIds: [liveSecond.record.id],
      holderSessionIds: [liveSessionId],
    });

    const ended = await cleanupSession(world.sessionId, world.context);

    expect(ended.status).toBe('conflict');
    expect(ended.restored).toEqual([]);
    expect(only(ended.failures, 'unplaced claim').error.details?.['reason']).toBe('claim-unplaced');
    expectNothingWritten(world.log);
    expect(world.journal.transitions(mark)).toEqual([]);
    expectFileBytes(stale.second.path, liveSecond.instrumentedBytes);
    expect(existsSync(world.backups.sessionDirectory)).toBe(true);

    // The live session's end restores the file; the stale chain then closes
    // over the pristine file on its next pass, still without a resolver.
    const liveEnded = await cleanupSession(liveSessionId, {
      ...world.context,
      backups: world.storeFor(liveSessionId),
    });

    expect(liveEnded.status).toBe('clean');
    expectFileBytes(stale.second.path, stale.pristine);

    const again = await cleanupSession(world.sessionId, world.context);

    expect(again.status).toBe('clean');
    expect(ids(again.restored)).toEqual([stale.second.record.id, stale.first.record.id]);
    expectFileBytes(stale.second.path, stale.pristine);
  });

  it('restores its own project over identical bytes another session holds in a copy of it', async () => {
    const world = makeWorld();
    const copy = join(world.root, 'copy');

    cpSync(FIXTURE_PROJECT, copy, { recursive: true });

    const own = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const elsewhere = nextSessionId('copy');
    const patched = await createPatcher({
      projectRoot: copy,
      sessionId: elsewhere,
      planVersion: 1,
      backups: world.storeFor(elsewhere),
      journal: world.journal,
    }).patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const theirs = expectOk(patched, 'the copy’s patch').record;
    const copyBytes = readFileSync(join(copy, TARGET_FILE));

    expect(theirs.file).toBe(own.record.file);
    expect(theirs.instrumentedHash).toBe(own.record.instrumentedHash);
    expect(theirs.appliedAt).toBeGreaterThanOrEqual(own.record.appliedAt);

    world.resetLog();

    // Unplaced, the copy's claim could be this very file: nothing is written.
    const unplaced = await cleanupSession(world.sessionId, world.context);

    expect(unplaced.status).toBe('partial');
    expect(only(unplaced.failures, 'unplaced claim').error.details?.['reason']).toBe(
      'claim-unplaced',
    );
    expectNothingWritten(world.log);
    expectFileBytes(own.path, own.instrumentedBytes);

    // Placed, it is another file: this project is restored, the copy is not
    // touched.
    const placed = await cleanupSession(world.sessionId, {
      ...world.context,
      projectRootOf: (sessionId: string): string =>
        sessionId === elsewhere ? copy : world.projectRoot,
    });

    expect(placed.status).toBe('clean');
    expect(ids(placed.restored)).toEqual([own.record.id]);
    expect(placed.failures).toEqual([]);
    expectFileBytes(own.path, own.originalBytes);
    expectFileBytes(join(copy, TARGET_FILE), copyBytes);
    expect(world.journal.row(theirs.id).status).toBe('applied');
  });

  it('restores a live record over an older claim of another session that went stale', async () => {
    const world = makeWorld();
    const staleSessionId = nextSessionId('stale');
    const stale = await patchSymbol(world, {
      file: TARGET_FILE,
      symbol: TARGET_SYMBOL,
      sessionId: staleSessionId,
    });

    // The developer put the committed file back while that record still says
    // `applied` — the state a journal written before chain retention can hold.
    writeFileSync(stale.path, stale.originalBytes);

    const live = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    expect(live.record.instrumentedHash).toBe(stale.record.instrumentedHash);
    world.journal.arrange({
      ...world.journal.row(stale.record.id),
      appliedAt: live.record.appliedAt - 60_000,
    });
    world.resetLog();

    // The installer unwinding the live record it just applied.
    const rolledBack = expectOk(
      await restoreModification(world.journal.row(live.record.id), placedContext(world)),
      'the rollback of the live record',
    );

    expect(rolledBack.kind).toBe('restored');
    expect(rolledBack.wrote).toBe(true);
    expectFileBytes(live.path, live.originalBytes);
    expect(world.journal.row(stale.record.id).status).toBe('applied');
  });

  it('closes a stale applied record beside a newer live claim of another session on the same original', async () => {
    const world = makeWorld();
    const staleSessionId = nextSessionId('stale');
    const stale = await patchSymbol(world, {
      file: TARGET_FILE,
      symbol: TARGET_SYMBOL,
      sessionId: staleSessionId,
    });

    writeFileSync(stale.path, stale.originalBytes);

    const live = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    world.journal.arrange({
      ...world.journal.row(stale.record.id),
      appliedAt: live.record.appliedAt - 60_000,
    });
    world.resetLog();

    const staleEnded = await cleanupSession(staleSessionId, placedContext(world, staleSessionId));

    expect(staleEnded.status).toBe('clean');
    expect(ids(staleEnded.restored)).toEqual([stale.record.id]);
    expectNothingWritten(world.log);
    expectFileBytes(live.path, live.instrumentedBytes);
    expect(world.journal.row(live.record.id).status).toBe('applied');

    const liveEnded = await cleanupSession(world.sessionId, placedContext(world));

    expect(liveEnded.status).toBe('clean');
    expect(ids(liveEnded.restored)).toEqual([live.record.id]);
    expectFileBytes(live.path, live.originalBytes);
  });
});

/*
 * ---------------------------------------------------------------------------
 * A file whose records do not form a single chain
 * ---------------------------------------------------------------------------
 */

/** A fork over {@link OTHER_FILE}, and the bytes it left on disk. */
interface ForkedFile {
  /** The record both branches are layered on, `applied`. */
  readonly parent: PatchedFile;

  /** The first branch, rolled back and then re-opened as `applied`. */
  readonly left: ModificationRecord;

  /** The second branch, whose patch is what the file holds. */
  readonly right: PatchedFile;

  /** The absolute path of the forked file. */
  readonly path: string;
}

/**
 * Builds a fork on a shared parent out of three real patches.
 *
 * The parent patches {@link OTHER_FILE}; the left branch is layered on it and
 * rolled back the way the installer unwinds a failed delta, which returns the
 * file to the parent's bytes; the right branch is then layered on the same
 * parent. Re-opening the left branch as `applied` produces exactly what a
 * journal written before single-child chains were enforced could hold: two
 * open records naming one `previousRecordId`, each with a real backup behind
 * it, and a file holding one branch's patch.
 *
 * @param world The sandbox to build it in.
 * @returns The three records and the file.
 */
async function forkOnSharedParent(world: World): Promise<ForkedFile> {
  const parent = await patchSymbol(world, {
    file: OTHER_FILE,
    symbol: OTHER_SYMBOL,
    planVersion: 1,
  });
  const left = await patchSymbol(world, {
    file: OTHER_FILE,
    symbol: OTHER_SECOND_SYMBOL,
    planVersion: 2,
  });

  expect(left.record.previousRecordId).toBe(parent.record.id);
  expect(
    expectOk(await restoreModification(left.record, world.context), 'the left branch rollback')
      .kind,
  ).toBe('restored');
  expectFileBytes(left.path, parent.instrumentedBytes);

  const right = await patchSymbol(world, {
    file: OTHER_FILE,
    symbol: OTHER_THIRD_SYMBOL,
    planVersion: 3,
  });

  expect(right.record.previousRecordId).toBe(parent.record.id);
  expect(right.record.originalHash).toBe(parent.record.instrumentedHash);

  world.journal.arrange({ ...world.journal.row(left.record.id), status: 'applied' });

  return { parent, left: world.journal.row(left.record.id), right, path: right.path };
}

/** The ids of `records`, sorted, for a comparison that does not depend on order. */
function sortedIds(records: readonly { readonly id: string }[]): string[] {
  return records.map((record) => record.id).sort();
}

/** The paths the recording filesystem was asked about at all, reads and writes alike. */
function touchedPaths(log: FileSystemLog): string[] {
  return [
    ...log.reads,
    ...log.snapshots,
    ...log.resolutions,
    ...log.writes.map((write) => write.path),
    ...log.creates.map((write) => write.path),
  ];
}

describe('a file whose records do not form a single chain', () => {
  it('is refused whole when two records share a parent: nothing read or written, every backup kept', async () => {
    const world = makeWorld();
    const fork = await forkOnSharedParent(world);
    const records = [fork.parent.record, fork.left, fork.right.record];

    world.resetLog();

    const mark = world.mark();
    const outcome = await cleanupSession(world.sessionId, world.context);

    // The file is exactly what it was, and nothing of it was even resolved.
    expectFileBytes(fork.path, fork.right.instrumentedBytes);
    expectNoFileSystemAccess(world.log);

    expect(outcome.status).toBe('conflict');
    expect(outcome.restored).toEqual([]);
    expect(outcome.failures).toEqual([]);
    expect(sortedIds(outcome.skipped)).toEqual(sortedIds(records));

    // Every involved record is reported, with the file, the record's own
    // expectation and the backup the developer is pointed at.
    expect(outcome.conflicts.map((conflict) => conflict.recordId).sort()).toEqual(
      sortedIds(records),
    );

    for (const conflict of outcome.conflicts) {
      // Its own reason, never 'content-changed': nobody edited this file.
      expect(conflict.reason).toBe('record-chain-fork');
      expect(conflict.file).toBe(OTHER_FILE);
      expect(conflict.detectedAt).toBe(FIXED_NOW);
      expect(conflict.message).toContain('layered on the same earlier record');
      expect(conflict.message).toContain(conflict.recordId);

      // Each branch still descends from one pristine original — the parent's
      // backup — and its report names it beside the branch's own backup, which
      // holds the parent's instrumented output. The parent's own backup already
      // is the pristine file, so its report adds nothing.
      if (conflict.recordId === fork.parent.record.id) {
        expect(conflict.originalBackupPath).toBeUndefined();
        expect(conflict.backupPath).toBe(fork.parent.record.backupPath);
      } else {
        expect(conflict.originalBackupPath).toBe(fork.parent.record.backupPath);
        expect(conflict.backupPath).toBe(world.backupPathOf(fork.right.record.originalHash));
        expect(conflict.message).toContain(fork.parent.record.backupPath);
      }
    }

    // The structured account, with the stable reason.
    const reported = only(outcome.forks, 'fork report');
    expect(reported.reason).toBe('record-chain-fork');
    expect(reported.sessionId).toBe(world.sessionId);
    expect(reported.file).toBe(OTHER_FILE);
    expect([...reported.recordIds].sort()).toEqual(sortedIds(records));
    expect(reported.sharedPreviousRecordIds).toEqual([fork.parent.record.id]);
    expect(reported.rootRecordIds).toEqual([fork.parent.record.id]);

    // Moved to `conflict`, so the next pass retains them instead of trying.
    for (const record of records) {
      expect(world.journal.row(record.id).status).toBe('conflict');
    }

    expect(world.journal.transitions(mark)).toHaveLength(3);
    expect(new Set(world.journal.transitions(mark).map((move) => move.status))).toEqual(
      new Set(['conflict']),
    );

    // Both originals survive: the pristine one and the parent's output, which
    // the two branches share.
    expect(world.removals).toEqual([]);
    expectFileBytes(world.backupPathOf(fork.parent.record.originalHash), fork.parent.originalBytes);
    expectFileBytes(
      world.backupPathOf(fork.right.record.originalHash),
      fork.parent.instrumentedBytes,
    );
    expect(fork.left.originalHash).toBe(fork.right.record.originalHash);
    expect(existsSync(world.backups.sessionDirectory)).toBe(true);
  });

  it('still restores an unrelated file in the same pass', async () => {
    const world = makeWorld();
    const fork = await forkOnSharedParent(world);
    const unrelated = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const forked = [fork.parent.record, fork.left, fork.right.record];

    world.resetLog();

    const outcome = await reconcileModifications(world.context);

    // The unrelated file came back, and the refused fork is still an
    // outstanding conflict.
    expect(outcome.status).toBe('conflict');
    expect(outcome.examined).toBe(4);
    expect(outcome.restored.map((record) => record.id)).toEqual([unrelated.record.id]);
    expect(outcome.closed).toEqual([]);
    expect(outcome.failures).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    expect(sortedIds(outcome.retained)).toEqual(sortedIds(forked));
    expect(outcome.conflicts.map((conflict) => conflict.recordId).sort()).toEqual(
      sortedIds(forked),
    );
    expect(only(outcome.forks, 'fork report').file).toBe(OTHER_FILE);

    // One write, to the unrelated file; the forked one was not even looked at.
    expectFileBytes(unrelated.path, unrelated.originalBytes);
    expectFileBytes(fork.path, fork.right.instrumentedBytes);
    expect(world.log.writes.map((write) => write.expectedHash)).toEqual([
      unrelated.record.instrumentedHash,
    ]);
    expect(touchedPaths(world.log).filter((path) => path.endsWith(OTHER_FILE))).toEqual([]);

    expect(world.journal.row(unrelated.record.id).status).toBe('reverted');
    expect(existsSync(world.backupPathOf(unrelated.record.originalHash))).toBe(false);
    expect(existsSync(world.backupPathOf(fork.parent.record.originalHash))).toBe(true);
    expect(existsSync(world.backupPathOf(fork.right.record.originalHash))).toBe(true);
  });

  it('treats a rolled-back layer as history, not a fork: the live layer, then its parent', async () => {
    // Follow-up rollback then retry: plan version 2 was layered on the applied
    // root and rolled back by the installer (reverted, the root still applied),
    // and plan version 3 was then layered on the same root. One parent, two
    // children — but only one of them live, so the file has one reverse order.
    const world = makeWorld();
    const pristine = readFileSync(world.pathOf(OTHER_FILE));
    const parent = await patchSymbol(world, {
      file: OTHER_FILE,
      symbol: OTHER_SYMBOL,
      planVersion: 1,
    });
    const rolledBack = await patchSymbol(world, {
      file: OTHER_FILE,
      symbol: OTHER_SECOND_SYMBOL,
      planVersion: 2,
    });

    expect(rolledBack.record.previousRecordId).toBe(parent.record.id);
    expect(
      expectOk(
        await restoreModification(rolledBack.record, world.context),
        'the installer rollback of the delta',
      ).kind,
    ).toBe('restored');
    expectFileBytes(rolledBack.path, parent.instrumentedBytes);

    const retry = await patchSymbol(world, {
      file: OTHER_FILE,
      symbol: OTHER_THIRD_SYMBOL,
      planVersion: 3,
    });

    expect(retry.record.previousRecordId).toBe(parent.record.id);
    expect(world.journal.row(rolledBack.record.id).status).toBe('reverted');

    // Handed every record, the reverted one included, as a direct caller may.
    const chain = await restoreChain(
      [
        world.journal.row(parent.record.id),
        world.journal.row(rolledBack.record.id),
        world.journal.row(retry.record.id),
      ],
      world.context,
    );

    expect(chain.fork).toBeUndefined();
    expect(chain.conflicts).toEqual([]);
    expect(chain.failures).toEqual([]);
    expect(chain.restored.map((record) => record.id)).toEqual([retry.record.id, parent.record.id]);
    expectFileBytes(world.pathOf(OTHER_FILE), pristine);

    for (const record of [parent.record, rolledBack.record, retry.record]) {
      expect(world.journal.row(record.id).status).toBe('reverted');
    }
  });

  it('is refused whole when two open chains start over one file', async () => {
    const world = makeWorld();
    const first = await patchSymbol(world, { file: OTHER_FILE, symbol: OTHER_SYMBOL });

    // Rolled back, then the file is instrumented afresh: the patcher starts a
    // new root because the only earlier record is reverted.
    expectOk(await restoreModification(first.record, world.context), 'the first root rollback');

    const second = await patchSymbol(world, { file: OTHER_FILE, symbol: OTHER_SECOND_SYMBOL });

    expect(second.record.previousRecordId).toBeUndefined();

    // Re-opened: two open roots, as a bypassing writer could leave them.
    world.journal.arrange({ ...world.journal.row(first.record.id), status: 'applied' });
    world.resetLog();

    const mark = world.mark();
    const chain = await restoreChain(
      [world.journal.row(first.record.id), world.journal.row(second.record.id)],
      world.context,
    );

    expect(chain.file).toBe(OTHER_FILE);
    expect(chain.fork?.reason).toBe('record-chain-fork');
    expect(chain.fork?.sharedPreviousRecordIds).toEqual([]);
    expect(chain.fork?.rootRecordIds).toEqual([first.record.id, second.record.id].sort());
    expect(chain.restored).toEqual([]);
    expect(chain.closed).toEqual([]);
    expect(chain.skipped).toEqual([]);
    expect(chain.failures).toEqual([]);
    expect(sortedIds(chain.retained)).toEqual(sortedIds([first.record, second.record]));
    expect(chain.outcomes.map((outcome) => outcome.kind)).toEqual(['conflict', 'conflict']);
    expect(chain.outcomes.map((outcome) => outcome.path)).toEqual([undefined, undefined]);
    expect(chain.stoppedAt?.id).toBe(chain.fork?.recordIds[0]);

    for (const conflict of chain.conflicts) {
      expect(conflict.message).toContain('more than one open chain');
    }

    expectNoFileSystemAccess(world.log);
    expectFileBytes(second.path, second.instrumentedBytes);
    expect(world.journal.transitions(mark)).toHaveLength(2);
    expect(world.journal.row(first.record.id).status).toBe('conflict');
    expect(world.journal.row(second.record.id).status).toBe('conflict');
    expectFileBytes(world.backupPathOf(second.record.originalHash), second.originalBytes);
  });

  it('keeps a record whose conflict the journal refused open, and reports the refusal', async () => {
    const world = makeWorld();
    const fork = await forkOnSharedParent(world);
    const refusal = new DebuggenError('STORE_ERROR', 'The suite journal refuses this write.', {
      details: { recordId: fork.right.record.id },
    });
    const journal: ModificationJournal = {
      ...world.journal,
      updateStatus: (id, status, patch) =>
        id === fork.right.record.id
          ? Promise.resolve(err(refusal))
          : world.journal.updateStatus(id, status, patch),
    };

    world.resetLog();

    const outcome = await cleanupSession(world.sessionId, { ...world.context, journal });

    expect(outcome.status).toBe('conflict');
    expect(only(outcome.forks, 'fork report').file).toBe(OTHER_FILE);
    expect(outcome.conflicts.map((conflict) => conflict.recordId).sort()).toEqual(
      sortedIds([fork.parent.record, fork.left]),
    );

    const failure = only(outcome.failures, 'failure');
    expect(failure.recordId).toBe(fork.right.record.id);
    expect(failure.error.code).toBe('STORE_ERROR');
    expect(failure.error.details?.['reason']).toBe('journal-transition-failed');

    expect(world.journal.row(fork.right.record.id).status).toBe('applied');
    expect(world.journal.row(fork.parent.record.id).status).toBe('conflict');
    expectNoFileSystemAccess(world.log);
    expect(world.removals).toEqual([]);
  });

  it('writes nothing to the journal either when the pass is aborted, but still names the fork', async () => {
    const world = makeWorld();
    const fork = await forkOnSharedParent(world);

    world.resetLog();

    const mark = world.mark();
    const outcome = await cleanupSession(world.sessionId, {
      ...world.context,
      signal: AbortSignal.abort(),
    });

    expect(outcome.status).toBe('conflict');
    expect(outcome.conflicts).toEqual([]);
    expect(sortedIds(outcome.skipped)).toEqual(
      sortedIds([fork.parent.record, fork.left, fork.right.record]),
    );
    expect(only(outcome.forks, 'fork report').sharedPreviousRecordIds).toEqual([
      fork.parent.record.id,
    ]);
    expect(world.journal.transitions(mark)).toEqual([]);
    expectNoFileSystemAccess(world.log);
    expect(world.journal.row(fork.right.record.id).status).toBe('applied');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The reconciliation table: one verdict per record status and file state
 * ---------------------------------------------------------------------------
 */

/** What a case arranges the file to hold before the pass runs. */
type ArrangedFileState = 'instrumented' | 'original' | 'edited';

/** Which of a pass's lists the record is expected to land in. */
type ExpectedDisposition = 'restored' | 'closed' | 'retained' | 'none';

/** One row of the reconciliation table, as a case. */
interface ReconcileCase {
  /** What the row asserts, in the words of the table. */
  readonly name: string;

  /** The status the pass meets the record in. */
  readonly status: ModificationStatus;

  /** What the file holds when the pass starts. */
  readonly file: ArrangedFileState;

  /** Where the record is expected to land. */
  readonly disposition: ExpectedDisposition;

  /** The pass's verdict. */
  readonly outcome: CleanupStatus;

  /** The status the record is expected to end in. */
  readonly recordEndsAs: ModificationStatus;

  /** Whether the pass is expected to have written anything. */
  readonly wrote: boolean;

  /** The reason of the expected conflict report, where one is expected. */
  readonly conflictReason: ModificationConflictReason | undefined;

  /** Whether the file is expected to hold the recorded original, or what it already held. */
  readonly fileEndsAs: 'original' | 'unchanged';

  /** Whether the backup is expected to survive the pass. */
  readonly backupKept: boolean;

  /**
   * Whether the journal wrongly offers `reverted` records to `listOpen`.
   *
   * Only the `reverted` row needs it: the port's contract excludes those
   * records, so the only way to prove `./cleanup.ts` filters by its own table
   * rather than trusting the query is to have the query answer wrongly.
   */
  readonly listOpenIncludesReverted?: boolean | undefined;
}

/**
 * The reconciliation table, one row per branch.
 *
 * `pending` and `failed` share the three-way reading — the write may or may not
 * have landed — while `applied` is restore-only, because for that record the
 * write is known to have landed and content that is no longer ours means
 * something outside this product changed the file. `conflict` is judged again
 * (AAP §0.5.1): retained and re-reported while the file still diverges,
 * restored once it holds the instrumented content again, and closed without a
 * write once it holds the original. `reverted` is finished business that is not
 * even read.
 */
const RECONCILE_CASES: readonly ReconcileCase[] = Object.freeze([
  {
    name: 'a pending record whose file holds the original is closed without a write',
    status: 'pending',
    file: 'original',
    disposition: 'closed',
    outcome: 'clean',
    recordEndsAs: 'reverted',
    wrote: false,
    conflictReason: undefined,
    fileEndsAs: 'unchanged',
    backupKept: false,
  },
  {
    name: 'a pending record whose file holds the patch is restored from its backup',
    status: 'pending',
    file: 'instrumented',
    disposition: 'restored',
    outcome: 'clean',
    recordEndsAs: 'reverted',
    wrote: true,
    conflictReason: undefined,
    fileEndsAs: 'original',
    backupKept: false,
  },
  {
    name: 'a pending record whose file holds neither digest conflicts',
    status: 'pending',
    file: 'edited',
    disposition: 'retained',
    outcome: 'conflict',
    recordEndsAs: 'conflict',
    wrote: false,
    conflictReason: 'content-changed',
    fileEndsAs: 'unchanged',
    backupKept: true,
  },
  {
    name: 'a failed record whose file holds the original is closed without a write',
    status: 'failed',
    file: 'original',
    disposition: 'closed',
    outcome: 'clean',
    recordEndsAs: 'reverted',
    wrote: false,
    conflictReason: undefined,
    fileEndsAs: 'unchanged',
    backupKept: false,
  },
  {
    name: 'a failed record whose file holds the patch is restored from its backup',
    status: 'failed',
    file: 'instrumented',
    disposition: 'restored',
    outcome: 'clean',
    recordEndsAs: 'reverted',
    wrote: true,
    conflictReason: undefined,
    fileEndsAs: 'original',
    backupKept: false,
  },
  {
    name: 'a failed record whose file holds neither digest conflicts',
    status: 'failed',
    file: 'edited',
    disposition: 'retained',
    outcome: 'conflict',
    recordEndsAs: 'conflict',
    wrote: false,
    conflictReason: 'content-changed',
    fileEndsAs: 'unchanged',
    backupKept: true,
  },
  {
    name: 'an applied record whose file holds the patch is restored from its backup',
    status: 'applied',
    file: 'instrumented',
    disposition: 'restored',
    outcome: 'clean',
    recordEndsAs: 'reverted',
    wrote: true,
    conflictReason: undefined,
    fileEndsAs: 'original',
    backupKept: false,
  },
  {
    name: 'an applied record whose file already holds the original is reported, not closed',
    status: 'applied',
    file: 'original',
    disposition: 'retained',
    outcome: 'conflict',
    recordEndsAs: 'conflict',
    wrote: false,
    conflictReason: 'content-changed',
    fileEndsAs: 'unchanged',
    backupKept: true,
  },
  {
    name: 'an applied record whose file holds neither digest conflicts',
    status: 'applied',
    file: 'edited',
    disposition: 'retained',
    outcome: 'conflict',
    recordEndsAs: 'conflict',
    wrote: false,
    conflictReason: 'content-changed',
    fileEndsAs: 'unchanged',
    backupKept: true,
  },
  {
    name: 'a record already in conflict is retained, its backup kept and the report renewed',
    status: 'conflict',
    file: 'edited',
    disposition: 'retained',
    outcome: 'conflict',
    recordEndsAs: 'conflict',
    wrote: false,
    conflictReason: 'content-changed',
    fileEndsAs: 'unchanged',
    backupKept: true,
  },
  {
    name: 'a record in conflict whose file holds the patch again is restored from its backup',
    status: 'conflict',
    file: 'instrumented',
    disposition: 'restored',
    outcome: 'clean',
    recordEndsAs: 'reverted',
    wrote: true,
    conflictReason: undefined,
    fileEndsAs: 'original',
    backupKept: false,
  },
  {
    name: 'a record in conflict whose file holds the original is closed without a write',
    status: 'conflict',
    file: 'original',
    disposition: 'closed',
    outcome: 'clean',
    recordEndsAs: 'reverted',
    wrote: false,
    conflictReason: undefined,
    fileEndsAs: 'unchanged',
    backupKept: false,
  },
  {
    name: 'a reverted record is not acted on, and not even read',
    status: 'reverted',
    file: 'instrumented',
    disposition: 'none',
    outcome: 'clean',
    recordEndsAs: 'reverted',
    wrote: false,
    conflictReason: undefined,
    fileEndsAs: 'unchanged',
    backupKept: true,
    listOpenIncludesReverted: true,
  },
]);

/**
 * Puts the file into the state a row describes, and answers with the bytes it
 * now holds.
 *
 * @param patched The real patch this row's record belongs to.
 * @param state What the file should hold when the pass starts.
 * @returns The bytes on disk afterwards.
 */
function arrangeFileState(patched: PatchedFile, state: ArrangedFileState): Buffer {
  if (state === 'instrumented') {
    return patched.instrumentedBytes;
  }

  if (state === 'original') {
    writeFileSync(patched.path, patched.originalBytes);

    return patched.originalBytes;
  }

  return developerEdits(patched.path);
}

describe('the reconciliation table', () => {
  it('dispatches on the record status alone, exhaustively', () => {
    expect(reconcileDispositionFor('pending')).toBe('restore-or-close');
    expect(reconcileDispositionFor('failed')).toBe('restore-or-close');
    expect(reconcileDispositionFor('applied')).toBe('restore-only');
    expect(reconcileDispositionFor('conflict')).toBe('retain');
    expect(reconcileDispositionFor('reverted')).toBe('none');

    // Every status has a reading, and every reading is reachable: a status
    // added to the schema without a decision here would fail this.
    const dispositions = MODIFICATION_STATUSES.map(reconcileDispositionFor);
    expect(new Set(dispositions)).toEqual(new Set(RECONCILE_DISPOSITIONS));
  });

  for (const [index, row] of RECONCILE_CASES.entries()) {
    // Each row's owning session is in a different state, none of them `ended`:
    // a pass keys off the record, and `ModificationJournal` cannot even tell it
    // what the session is doing.
    const sessionStatus =
      OPEN_SESSION_STATUSES[index % OPEN_SESSION_STATUSES.length] ?? 'capturing';

    it(`${row.name} (owning session: ${sessionStatus})`, async () => {
      const world = makeWorld(
        row.listOpenIncludesReverted === true
          ? { journal: { listOpenIncludesReverted: true } }
          : {},
      );

      world.journal.noteSessionStatus(world.sessionId, sessionStatus);

      const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
      const arranged = arrangeFileState(patched, row.file);

      world.journal.arrange({ ...patched.record, status: row.status });
      world.resetLog();

      const mark = world.mark();
      const outcome = await reconcileModifications(world.context);

      expect(outcome.status).toBe(row.outcome);
      expect(outcome.examined).toBe(1);
      expect(outcome.completedAt).toBe(FIXED_NOW);
      expect(outcome.failures).toEqual([]);

      const ids = (records: readonly ModificationRecord[]): string[] =>
        records.map((record) => record.id);
      const expectedIn = (disposition: ExpectedDisposition): string[] =>
        row.disposition === disposition ? [patched.record.id] : [];

      expect(ids(outcome.restored)).toEqual(expectedIn('restored'));
      expect(ids(outcome.closed)).toEqual(expectedIn('closed'));
      expect(ids(outcome.retained)).toEqual(expectedIn('retained'));
      expect(ids(outcome.skipped)).toEqual([]);

      if (row.conflictReason === undefined) {
        expect(outcome.conflicts).toEqual([]);
      } else {
        const conflict = only(outcome.conflicts, 'conflict report');
        expect(conflict.reason).toBe(row.conflictReason);
        expect(conflict.recordId).toBe(patched.record.id);
        expect(conflict.detectedAt).toBe(FIXED_NOW);
      }

      expect(world.log.writes).toHaveLength(row.wrote ? 1 : 0);
      expect(world.log.creates).toEqual([]);

      if (row.disposition === 'none') {
        // Finished business is not resolved, read or hashed, which is what
        // makes a repeated pass free as well as safe.
        expectNoFileSystemAccess(world.log);
        expect(world.journal.transitions(mark)).toEqual([]);
      }

      expect(world.journal.row(patched.record.id).status).toBe(row.recordEndsAs);
      expectFileBytes(
        patched.path,
        row.fileEndsAs === 'original' ? patched.originalBytes : arranged,
      );
      expect(existsSync(world.backupPathOf(patched.record.originalHash))).toBe(row.backupKept);
      expect(world.journal.sessionStatusOf(world.sessionId)).toBe(sessionStatus);
      expect(sessionStatus).not.toBe('ended');
    });
  }

  it('acts on every open record whatever state its owning session is in', async () => {
    const world = makeWorld();
    const capturing = nextSessionId('capturing');
    const failed = nextSessionId('failed');
    const generated = nextSessionId('generated');

    world.journal.noteSessionStatus(capturing, 'capturing');
    world.journal.noteSessionStatus(failed, 'failed');
    world.journal.noteSessionStatus(generated, 'generated');

    const patched = [
      await patchSymbol(world, {
        file: TARGET_FILE,
        symbol: TARGET_SYMBOL,
        sessionId: capturing,
      }),
      await patchSymbol(world, { file: OTHER_FILE, symbol: OTHER_SYMBOL, sessionId: failed }),
      await patchSymbol(world, {
        file: LEGACY_FILE,
        symbol: LEGACY_SYMBOL,
        sessionId: generated,
      }),
    ];

    // A record carries a project-relative file and a session id and nothing
    // else about where it belongs, so a pass spanning sessions is given the
    // resolver that places each one.
    const scopeFor = vi.fn((record: ModificationRecord): Result<RecordScope> => {
      return ok({ projectRoot: world.projectRoot, backups: world.storeFor(record.sessionId) });
    });

    world.resetLog();

    const outcome = await reconcileModifications(world.context, { scopeFor });

    expect(outcome.status).toBe('clean');
    expect(outcome.examined).toBe(3);
    expect(world.journal.rows()).toHaveLength(3);
    expect(outcome.failures).toEqual([]);
    expect(outcome.conflicts).toEqual([]);
    expect(new Set(outcome.restored.map((record) => record.sessionId))).toEqual(
      new Set([capturing, failed, generated]),
    );
    expect(scopeFor).toHaveBeenCalledTimes(3);
    expect(world.log.writes).toHaveLength(3);

    for (const file of patched) {
      expectFileBytes(file.path, file.originalBytes);
      expect(world.journal.row(file.record.id).status).toBe('reverted');
    }

    expect([
      world.journal.sessionStatusOf(capturing),
      world.journal.sessionStatusOf(failed),
      world.journal.sessionStatusOf(generated),
    ]).toEqual(['capturing', 'failed', 'generated']);
  });

  it('skips a record it cannot place, and leaves its file alone', async () => {
    const world = makeWorld();
    const foreign = nextSessionId('foreign');
    const patched = await patchSymbol(world, {
      file: TARGET_FILE,
      symbol: TARGET_SYMBOL,
      sessionId: foreign,
    });

    world.resetLog();

    // No resolver, and the context's store belongs to another session: writing
    // one session's content with another's root is the one failure mode worse
    // than leaving a file patched.
    const outcome = await reconcileModifications(world.context);

    // A record that could not be attempted, and no conflict observed: the
    // next start, given a resolver, settles it.
    expect(outcome.status).toBe('partial');
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.restored).toEqual([]);
    expect(outcome.skipped.map((record) => record.id)).toEqual([patched.record.id]);
    expect(only(outcome.failures, 'failure').error.code).toBe('SESSION_NOT_FOUND');
    expectNoFileSystemAccess(world.log);
    expectFileBytes(patched.path, patched.instrumentedBytes);
    expect(world.journal.row(patched.record.id).status).toBe('applied');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The session backup directory after a start-up reconciliation
 * ---------------------------------------------------------------------------
 */

describe('the backup directory of a reconciled session', () => {
  it('is removed once the pass reverts every open record of the session, as session.end does', async () => {
    const world = makeWorld();
    const target = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const other = await patchSymbol(world, { file: OTHER_FILE, symbol: OTHER_SYMBOL });

    expect(existsSync(world.backups.sessionDirectory)).toBe(true);

    const outcome = await reconcileModifications(world.context);

    expect(outcome.status).toBe('clean');
    expect(outcome.restored).toHaveLength(2);
    expectFileBytes(target.path, target.originalBytes);
    expectFileBytes(other.path, other.originalBytes);

    // Every backup deleted as its restore verified, and then the emptied
    // directory itself.
    expect(world.removals.map((removal) => removal.restoredContentHash).sort()).toEqual(
      [target.record.originalHash, other.record.originalHash].sort(),
    );
    expect(existsSync(world.backups.sessionDirectory)).toBe(false);
    expect(existsSync(join(world.debuggenHome, 'backups'))).toBe(true);
  });

  it('is removed when the pass only closed records, nothing having been written', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    // The crash between the journal append and the rename: `pending`, and the
    // file still the original.
    writeFileSync(patched.path, patched.originalBytes);
    world.journal.arrange({ ...world.journal.row(patched.record.id), status: 'pending' });
    world.resetLog();

    const outcome = await reconcileModifications(world.context);

    expect(outcome.status).toBe('clean');
    expect(outcome.closed.map((record) => record.id)).toEqual([patched.record.id]);
    expectNothingWritten(world.log);
    expect(existsSync(world.backups.sessionDirectory)).toBe(false);
  });

  it('is kept whole while any record of the session is still in conflict', async () => {
    const world = makeWorld();
    const target = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const other = await patchSymbol(world, { file: OTHER_FILE, symbol: OTHER_SYMBOL });

    developerEdits(other.path);

    const outcome = await reconcileModifications(world.context);

    expect(outcome.status).toBe('conflict');
    expect(outcome.restored.map((record) => record.id)).toEqual([target.record.id]);
    expect(outcome.retained.map((record) => record.id)).toEqual([other.record.id]);

    // The restored record's backup is gone; the conflict's is exactly where the
    // report points, inside the directory that was therefore kept.
    expect(existsSync(world.backupPathOf(target.record.originalHash))).toBe(false);
    expectFileBytes(world.backupPathOf(other.record.originalHash), other.originalBytes);
    expect(existsSync(world.backups.sessionDirectory)).toBe(true);
  });

  it('is removed for the session the pass settled and kept for the one it could not place', async () => {
    const world = makeWorld();
    const foreign = nextSessionId('foreign');
    const settled = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const unplaced = await patchSymbol(world, {
      file: OTHER_FILE,
      symbol: OTHER_SYMBOL,
      sessionId: foreign,
    });
    const foreignDirectory = world.storeFor(foreign).sessionDirectory;

    // Only the context's own session can be placed; the foreign one is skipped
    // with a failure, exactly as a session whose row is gone would be.
    const scopeFor = (record: ModificationRecord): Result<RecordScope> =>
      record.sessionId === world.sessionId
        ? ok({ projectRoot: world.projectRoot, backups: world.backups })
        : err(new DebuggenError('SESSION_NOT_FOUND', 'The suite cannot place this session.'));

    const outcome = await reconcileModifications(world.context, { scopeFor });

    expect(outcome.status).toBe('partial');
    expect(outcome.restored.map((record) => record.id)).toEqual([settled.record.id]);
    expect(outcome.skipped.map((record) => record.id)).toEqual([unplaced.record.id]);

    expect(existsSync(world.backups.sessionDirectory)).toBe(false);
    expect(existsSync(foreignDirectory)).toBe(true);
    expectFileBytes(join(foreignDirectory, unplaced.record.originalHash), unplaced.originalBytes);
    expectFileBytes(unplaced.path, unplaced.instrumentedBytes);
  });

  it('is left alone by a pass that reverted nothing of the session', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    developerEdits(patched.path);

    const first = await reconcileModifications(world.context);
    const second = await reconcileModifications(world.context);

    expect([first.status, second.status]).toEqual(['conflict', 'conflict']);
    expect(existsSync(world.backups.sessionDirectory)).toBe(true);
    expectFileBytes(world.backupPathOf(patched.record.originalHash), patched.originalBytes);
  });

  it('is only a warning when the store cannot remove it: the pass stays clean and never throws', async () => {
    const records: LogRecord[] = [];
    const logger = createConsoleLogger({
      level: 'trace',
      sink: (record) => {
        records.push(record);
      },
    });
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const refusing: BackupStore = {
      ...world.backups,
      removeSessionDirectory: () => Promise.reject(new Error('The suite refuses to list it.')),
    };

    const outcome = await reconcileModifications({
      ...world.context,
      backups: refusing,
      logger,
    });

    expect(outcome.status).toBe('clean');
    expect(outcome.failures).toEqual([]);
    expectFileBytes(patched.path, patched.originalBytes);
    expect(existsSync(world.backupPathOf(patched.record.originalHash))).toBe(false);

    const warning = records.find(
      (record) =>
        record.level === 'warn' &&
        record.message === 'the session backup directory was not removed',
    );
    expect(warning?.fields['sessionId']).toBe(world.sessionId);
    expect(warning?.fields['directory']).toBe(world.backups.sessionDirectory);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The backup's lifecycle
 * ---------------------------------------------------------------------------
 */

describe('the backup of a restored file', () => {
  it('is deleted only once the restored content has been read back and verified', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    world.watch(TARGET_FILE);
    world.resetLog();

    const outcome = await cleanupSession(world.sessionId, world.context, {
      keepBackupDirectory: true,
    });

    expect(outcome.status).toBe('clean');

    const removal = only(world.removals, 'backup deletion');
    // The store is told which digest was restored and enforces the match
    // itself, and the file already held that content when it was told.
    expect(removal.restoredContentHash).toBe(patched.record.originalHash);
    expect(removal.watchedDigest).toBe(patched.record.originalHash);
    expect(removal.watchedDigest).not.toBe(patched.record.instrumentedHash);
    expect(existsSync(world.backupPathOf(patched.record.originalHash))).toBe(false);

    // The verification read happened, and it was a read of the path that had
    // just been written.
    expect(world.log.reads.some((path) => path.endsWith(TARGET_FILE))).toBe(true);
  });

  it('survives when the restored content does not hash to the recorded original', async () => {
    // A filesystem that writes something other than what it was handed is the
    // only way to reach the post-write verification branch.
    const world = makeWorld({ files: { corruptWrite: true } });
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    world.resetLog();

    const mark = world.mark();
    const outcome = await cleanupSession(world.sessionId, world.context);

    expect(outcome.status).toBe('conflict');
    expect(outcome.restored).toEqual([]);

    const conflict = only(outcome.conflicts, 'conflict report');
    expect(conflict.reason).toBe('restore-verification-failed');
    expect(conflict.recordId).toBe(patched.record.id);
    // The developer is given something to search the journal with, and told
    // where their original still is.
    expect(conflict.message).toContain(patched.record.id);
    expect(conflict.message).toContain(patched.record.backupPath);

    // The record is not closed and the backup is not deleted: those are the two
    // things that would make the file unrecoverable.
    expect(world.journal.row(patched.record.id).status).toBe('conflict');
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: patched.record.id, status: 'conflict' },
    ]);
    expect(world.removals).toEqual([]);
    expect(existsSync(world.backupPathOf(patched.record.originalHash))).toBe(true);
    expectFileBytes(world.backupPathOf(patched.record.originalHash), patched.originalBytes);
    expect(existsSync(world.backups.sessionDirectory)).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * A missing file, and a missing backup
 * ---------------------------------------------------------------------------
 */

describe('a target that is no longer there', () => {
  it('is recreated from its verified backup, because the guarantee is about the bytes', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    rmSync(patched.path);
    expect(existsSync(patched.path)).toBe(false);

    world.resetLog();

    const outcome = expectOk(
      await restoreModification(patched.record, world.context),
      'a restore outcome',
    );

    expect(outcome.kind).toBe('restored');
    expect(outcome.recreated).toBe(true);
    expect(outcome.wrote).toBe(true);
    expect(outcome.backup).toBe('deleted');
    expect(outcome.conflict).toBeUndefined();

    // Recreated through the no-clobber create, since an absent target has no
    // content to make a conditional replacement out of — and the create is the
    // one that installed it.
    expect(world.log.writes).toEqual([]);

    const create = only(world.log.creates, 'no-clobber create');
    expect(create.contentHash).toBe(patched.record.originalHash);
    expect(create.verdict).toBe('created');

    expectFileBytes(patched.path, patched.originalBytes);
    expect(world.journal.row(patched.record.id).status).toBe('reverted');
  });

  it('keeps a file the developer recreates before the original lands, and conflicts with the backup kept', async () => {
    const recreated = Buffer.from(
      'export const draftPlan = [];\n// Recreated by the developer while cleanup was running.\n',
      'utf8',
    );
    const world = makeWorld({
      files: {
        // The race at the only instant it matters: after the pass decided the
        // target was gone, before the create that would put the original back.
        beforeCreate: (path: string): void => {
          writeFileSync(path, recreated);
        },
      },
    });
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const backupPath = world.backupPathOf(patched.record.originalHash);

    rmSync(patched.path);
    const siblingsBefore = readdirSync(dirname(patched.path));

    world.resetLog();
    const mark = world.mark();

    const outcome = expectOk(
      await restoreModification(patched.record, world.context),
      'a restore outcome',
    );

    expect(outcome.kind).toBe('conflict');
    expect(outcome.wrote).toBe(false);
    expect(outcome.recreated).toBe(false);
    expect(outcome.backup).toBe('retained');
    // Re-detected against what now occupies the path, so the report describes
    // the developer's file rather than the absence the pass first saw.
    expect(outcome.conflict?.reason).toBe('content-changed');
    expect(outcome.conflict?.actualHash).toBe(sha256Hex(recreated));

    // One create was asked for, and the filesystem refused it: nothing of the
    // original was written over the developer's file, and no conditional
    // replacement was attempted either.
    expect(world.log.writes).toEqual([]);

    const create = only(world.log.creates, 'no-clobber create');
    expect(create.contentHash).toBe(patched.record.originalHash);
    expect(create.verdict).toBe('exists');

    // Their file is exactly what they wrote, and no staged copy of the original
    // was left beside it.
    expectFileBytes(patched.path, recreated);
    expect([...readdirSync(dirname(patched.path))].sort()).toEqual(
      [...siblingsBefore, basename(patched.path)].sort(),
    );

    // The record is in conflict, and the original is still where it was.
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: patched.record.id, status: 'conflict' },
    ]);
    expect(world.removals).toEqual([]);
    expectFileBytes(backupPath, patched.originalBytes);
  });

  it('names the race when what reappeared would not have been a conflict on its own', async () => {
    // An editor re-saving the buffer it still had open puts the instrumented
    // bytes back. The detector alone would call that restorable, but the pass
    // had already committed to a create, which refused to write over it — so
    // the report says why nothing happened instead of claiming an edit.
    const reappearing: { bytes: Buffer | undefined } = { bytes: undefined };
    const world = makeWorld({
      files: {
        beforeCreate: (path: string): void => {
          if (reappearing.bytes !== undefined) {
            writeFileSync(path, reappearing.bytes);
          }
        },
      },
    });
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    reappearing.bytes = patched.instrumentedBytes;
    rmSync(patched.path);
    world.resetLog();

    const outcome = expectOk(
      await restoreModification(patched.record, world.context),
      'a restore outcome',
    );

    expect(outcome.kind).toBe('conflict');
    expect(outcome.wrote).toBe(false);
    expect(outcome.backup).toBe('retained');
    expect(outcome.conflict?.reason).toBe('content-changed');
    expect(outcome.conflict?.message).toContain('target-appeared');
    expect(outcome.conflict?.message).toContain(patched.record.backupPath);

    expect(only(world.log.creates, 'no-clobber create').verdict).toBe('exists');
    expectFileBytes(patched.path, patched.instrumentedBytes);
    expect(world.journal.row(patched.record.id).status).toBe('conflict');
    expect(world.removals).toEqual([]);
    expectFileBytes(world.backupPathOf(patched.record.originalHash), patched.originalBytes);
  });
});

describe('a backup that cannot be read back', () => {
  it('conflicts with the record named, and never reports success', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const backupPath = world.backupPathOf(patched.record.originalHash);

    rmSync(backupPath);
    expect(existsSync(backupPath)).toBe(false);

    world.resetLog();

    const outcome = await cleanupSession(world.sessionId, world.context);

    // There are no verified original bytes to write, so nothing is written and
    // nothing is closed: silence here would leave a patched file behind a
    // record that claims to be finished.
    expect(outcome.status).toBe('conflict');
    expect(outcome.restored).toEqual([]);
    expectNothingWritten(world.log);

    const conflict = only(outcome.conflicts, 'conflict report');
    expect(conflict.reason).toBe('backup-missing');
    expect(conflict.recordId).toBe(patched.record.id);
    expect(conflict.file).toBe(TARGET_FILE);
    expect(conflict.backupPath).toBe(patched.record.backupPath);
    expect(conflict.actualHash).toBe(patched.record.instrumentedHash);

    expect(world.journal.row(patched.record.id).status).toBe('conflict');
    expectFileBytes(patched.path, patched.instrumentedBytes);
  });
});

describe('a backup that is there but no longer hashes to its digest', () => {
  it('conflicts as backup-corrupt, writes nothing and keeps the untrusted backup', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const backupPath = world.backupPathOf(patched.record.originalHash);
    const tampered = Buffer.from('this is not the original content\n', 'utf8');

    writeFileSync(backupPath, tampered);
    world.resetLog();

    const outcome = await cleanupSession(world.sessionId, world.context);

    expect(outcome.status).toBe('conflict');
    expect(outcome.restored).toEqual([]);
    expectNothingWritten(world.log);

    // Named for what was observed: the file is there and was read, it simply
    // is not the original — not "missing", and not "could not be read back".
    const conflict = only(outcome.conflicts, 'conflict report');
    expect(conflict.reason).toBe('backup-corrupt');
    expect(conflict.recordId).toBe(patched.record.id);
    expect(conflict.backupPath).toBe(patched.record.backupPath);
    expect(conflict.message).toContain('no longer hashes to the digest it was filed under');
    expect(conflict.message).not.toContain('could not be read back');
    expect(conflict.message).not.toContain(sha256Hex(tampered));

    // The developer's project file and the untrusted backup are both exactly
    // as they were: nothing was restored from it, and nothing deleted it.
    expectFileBytes(patched.path, patched.instrumentedBytes);
    expectFileBytes(backupPath, tampered);
    expect(world.removals).toEqual([]);
    expect(world.journal.row(patched.record.id).status).toBe('conflict');
  });

  /**
   * The world's store, answering the conflict detector's read (the first) with
   * the real backup and the restoration's own read (the second) with `second`:
   * the backup changed between the verdict and the write.
   */
  function storeChangingOnSecondRead(
    world: World,
    second: (real: RecordedBackup) => Result<RecordedBackup>,
  ): BackupStore {
    let reads = 0;

    return {
      ...world.backups,
      readRecorded: async (recordedPath: string, digest: string) => {
        reads += 1;

        const real = await world.backups.readRecorded(recordedPath, digest);

        return reads < 2 || isErr(real) ? real : second(real.value);
      },
    };
  }

  it('refuses a backup whose bytes changed after the verdict, as backup-corrupt', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const backups = storeChangingOnSecondRead(world, (real) =>
      ok({ ...real, bytes: Buffer.from('swapped after the verdict\n', 'utf8') }),
    );

    world.resetLog();

    const outcome = expectOk(
      await restoreModification(patched.record, { ...world.context, backups }),
      'a restore outcome',
    );

    expect(outcome.kind).toBe('conflict');
    expect(outcome.wrote).toBe(false);
    expect(outcome.conflict?.reason).toBe('backup-corrupt');
    expect(outcome.conflict?.message).toContain('does not match the digest it was filed under');
    expect(outcome.conflict?.message).not.toContain('could not be read back');
    expectNothingWritten(world.log);
    expectFileBytes(patched.path, patched.instrumentedBytes);
    expectFileBytes(world.backupPathOf(patched.record.originalHash), patched.originalBytes);
  });

  it('reads a store-reported digest mismatch at restore time as backup-corrupt', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const backups = storeChangingOnSecondRead(world, () =>
      err(
        new DebuggenError('STORE_ERROR', 'The stored backup does not match its digest.', {
          details: { reason: 'stored-digest-mismatch' },
        }),
      ),
    );

    world.resetLog();

    const outcome = expectOk(
      await restoreModification(patched.record, { ...world.context, backups }),
      'a restore outcome',
    );

    expect(outcome.kind).toBe('conflict');
    expect(outcome.conflict?.reason).toBe('backup-corrupt');
    expect(outcome.conflict?.message).not.toContain('could not be read back');
    expectNothingWritten(world.log);
    expectFileBytes(patched.path, patched.instrumentedBytes);
  });
});

describe('a backup the journal says was moved', () => {
  /** A copy of the fixture's target file, so two records are filed under one digest. */
  const TWIN_FILE = 'src/server/cycle-planner-twin.ts';

  /** A neighbouring session's directory name under the same state root. */
  const NEIGHBOUR_SESSION = 'ses_neighbour';

  /** `<debuggenHome>/backups/<sessionId>/quarantine`, for any session. */
  function quarantinePathOf(world: World, sessionId = world.sessionId): string {
    return join(world.debuggenHome, 'backups', sessionId, 'quarantine');
  }

  /**
   * The world session's quarantine directory, created private like the rest of
   * the backup tree: a subdirectory of the session's own directory the store
   * did not compose, which is the one place a relocation is honoured.
   */
  function quarantineOf(world: World): string {
    const quarantine = quarantinePathOf(world);

    mkdirSync(quarantine, { recursive: true, mode: 0o700 });
    chmodSync(quarantine, 0o700);

    return quarantine;
  }

  /**
   * Moves a record's backup into the quarantine directory and journals where it
   * went, the way `ModificationStatusPatch.backupPath` lets the service do.
   *
   * @returns The new, journaled backup path.
   */
  function relocateBackup(world: World, patched: PatchedFile): string {
    const relocated = join(quarantineOf(world), patched.record.originalHash);

    renameSync(world.backupPathOf(patched.record.originalHash), relocated);
    world.journal.arrange({ ...world.journal.row(patched.record.id), backupPath: relocated });

    return relocated;
  }

  it('restores from where the record says the backup is, then deletes it from there', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const relocated = relocateBackup(world, patched);

    expect(existsSync(world.backupPathOf(patched.record.originalHash))).toBe(false);

    world.watch(TARGET_FILE);
    world.resetLog();

    const outcome = await cleanupSession(world.sessionId, world.context);

    // A read by digest would have found nothing at the composed path and
    // stranded the patched file behind a `backup-missing` conflict.
    expect(outcome.status).toBe('clean');
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.failures).toEqual([]);
    expectFileBytes(patched.path, patched.originalBytes);
    expect(world.journal.row(patched.record.id).status).toBe('reverted');

    // Deleted from where it was moved to, only once the restore verified.
    const removal = only(world.removals, 'backup deletion');
    expect(removal.restoredContentHash).toBe(patched.record.originalHash);
    expect(removal.watchedDigest).toBe(patched.record.originalHash);
    expect(existsSync(relocated)).toBe(false);
  });

  it('restores a single relocated record for the installer unwinding a failed delta', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const relocated = relocateBackup(world, patched);

    world.resetLog();

    const outcome = expectOk(
      await restoreModification(world.journal.row(patched.record.id), world.context),
      'a restore outcome',
    );

    expect(outcome.kind).toBe('restored');
    expect(outcome.backup).toBe('deleted');
    expectFileBytes(patched.path, patched.originalBytes);
    expect(existsSync(relocated)).toBe(false);
  });

  it('refuses a relocated backup reached through a symbolic link, writing and deleting nothing', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    // The quarantine directory is a link out of the state root. Lexically the
    // recorded path is inside the session's own directory; only the pinned
    // walk the store performs before opening it can see that it is not.
    const elsewhere = join(world.root, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    chmodSync(elsewhere, 0o700);

    const outsideCopy = join(elsewhere, patched.record.originalHash);
    renameSync(world.backupPathOf(patched.record.originalHash), outsideCopy);

    const linked = quarantinePathOf(world);
    symlinkSync(elsewhere, linked, 'dir');

    const relocated = join(linked, patched.record.originalHash);
    world.journal.arrange({ ...world.journal.row(patched.record.id), backupPath: relocated });

    world.resetLog();
    const mark = world.mark();

    const outcome = await cleanupSession(world.sessionId, world.context);

    expect(outcome.status).toBe('conflict');
    expect(outcome.restored).toEqual([]);
    expectNothingWritten(world.log);

    const conflict = only(outcome.conflicts, 'conflict report');
    expect(conflict.recordId).toBe(patched.record.id);
    expect(conflict.reason).toBe('backup-missing');
    expect(conflict.backupPath).toBe(relocated);

    expect(world.journal.transitions(mark)).toEqual([
      { recordId: patched.record.id, status: 'conflict' },
    ]);
    expect(world.removals).toEqual([]);
    expectFileBytes(patched.path, patched.instrumentedBytes);
    // What the link pointed at was neither trusted nor touched.
    expectFileBytes(outsideCopy, patched.originalBytes);
  });

  /**
   * Recorded paths the store will not open: they are replaced by its own
   * composed location for the digest, so the planted decoy at each one is never
   * read, never deleted and never written into the project.
   */
  const FOREIGN_PATHS: readonly {
    readonly name: string;
    readonly recorded: (world: World, digest: string) => string;
    readonly decoy: (world: World, digest: string) => string;
  }[] = Object.freeze([
    {
      name: 'a path under another state root',
      recorded: (world: World, digest: string): string =>
        join(world.root, 'another-home', 'backups', world.sessionId, digest),
      decoy: (world: World, digest: string): string =>
        join(world.root, 'another-home', 'backups', world.sessionId, digest),
    },
    {
      name: 'a path in another session’s directory',
      recorded: (world: World, digest: string): string =>
        join(world.debuggenHome, 'backups', NEIGHBOUR_SESSION, digest),
      decoy: (world: World, digest: string): string =>
        join(world.debuggenHome, 'backups', NEIGHBOUR_SESSION, digest),
    },
    {
      name: 'a path in another session’s quarantine',
      recorded: (world: World, digest: string): string =>
        join(quarantinePathOf(world, NEIGHBOUR_SESSION), digest),
      decoy: (world: World, digest: string): string =>
        join(quarantinePathOf(world, NEIGHBOUR_SESSION), digest),
    },
    {
      name: 'a quarantine outside every session',
      recorded: (world: World, digest: string): string =>
        join(world.debuggenHome, 'backups', 'quarantine', digest),
      decoy: (world: World, digest: string): string =>
        join(world.debuggenHome, 'backups', 'quarantine', digest),
    },
    {
      name: 'a file in the session’s own quarantine not named by the digest',
      recorded: (world: World): string => join(quarantinePathOf(world), 'original.ts'),
      decoy: (world: World): string => join(quarantinePathOf(world), 'original.ts'),
    },
    {
      name: 'a traversal out of the backup tree',
      recorded: (world: World, digest: string): string =>
        `${quarantinePathOf(world)}/../../../../escaped/${digest}`,
      decoy: (world: World, digest: string): string => join(world.root, 'escaped', digest),
    },
  ]);

  for (const foreign of FOREIGN_PATHS) {
    it(`never opens ${foreign.name}, and restores from the store's own location`, async () => {
      const world = makeWorld();
      const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
      const decoyPath = foreign.decoy(world, patched.record.originalHash);
      const decoyBytes = Buffer.from('export const decoy = true;\n', 'utf8');

      mkdirSync(dirname(decoyPath), { recursive: true, mode: 0o700 });
      writeFileSync(decoyPath, decoyBytes);
      world.journal.arrange({
        ...world.journal.row(patched.record.id),
        backupPath: foreign.recorded(world, patched.record.originalHash),
      });

      world.resetLog();

      const outcome = await cleanupSession(world.sessionId, world.context);

      expect(outcome.status).toBe('clean');
      expectFileBytes(patched.path, patched.originalBytes);
      expect(only(world.removals, 'backup deletion').restoredContentHash).toBe(
        patched.record.originalHash,
      );
      // The composed backup was the one read and deleted; the decoy is intact.
      expect(existsSync(world.backupPathOf(patched.record.originalHash))).toBe(false);
      expectFileBytes(decoyPath, decoyBytes);
    });
  }

  it('deletes two backups filed under one digest from their own paths, each after its restore', async () => {
    const world = makeWorld();
    cpSync(world.pathOf(TARGET_FILE), world.pathOf(TWIN_FILE));

    const first = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const twin = await patchSymbol(world, { file: TWIN_FILE, symbol: TARGET_SYMBOL });
    const digest = first.record.originalHash;

    // Identical originals share one content-addressed backup; the first
    // record's copy is then moved aside, so the two records name two files.
    expect(twin.record.originalHash).toBe(digest);
    expect(twin.outcome.backup.reused).toBe(true);

    const relocated = join(quarantineOf(world), digest);
    cpSync(world.backupPathOf(digest), relocated);
    chmodSync(relocated, 0o600);
    world.journal.arrange({ ...world.journal.row(first.record.id), backupPath: relocated });

    world.watch(TARGET_FILE);
    world.resetLog();

    const outcome = await cleanupSession(world.sessionId, world.context);

    expect(outcome.status).toBe('clean');
    expectFileBytes(first.path, first.originalBytes);
    expectFileBytes(twin.path, twin.originalBytes);

    // Both files are gone, each deleted from the path its own record names —
    // and never before both restores had verified, because the digest they
    // share kept either deletion waiting until its last holder was done.
    expect(world.removals).toHaveLength(2);
    for (const removal of world.removals) {
      expect(removal.restoredContentHash).toBe(digest);
      expect(removal.watchedDigest).toBe(digest);
    }
    expect(existsSync(relocated)).toBe(false);
    expect(existsSync(world.backupPathOf(digest))).toBe(false);
  });

  /*
   * One session's record never reaches another session's backups (N1).
   */

  it('never deletes another session’s retained original for a record that already holds its own', async () => {
    const world = makeWorld();
    const holder = nextSessionId('holder');
    world.journal.noteSessionStatus(holder, 'generated');

    // Session B: an unresolved conflict whose backup is the only copy of its
    // original.
    const retained = await patchSymbol(world, {
      file: OTHER_FILE,
      symbol: OTHER_SYMBOL,
      sessionId: holder,
    });
    const retainedBackup = join(
      world.debuggenHome,
      'backups',
      holder,
      retained.record.originalHash,
    );
    world.journal.arrange({ ...world.journal.row(retained.record.id), status: 'conflict' });

    // Session A: a record whose file already holds its original — the crash
    // between the journal append and the rename — journaled as though its
    // backup were B's. That record closes without a byte written, and its
    // backup is then deleted as verified.
    const closing = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    writeFileSync(closing.path, closing.originalBytes);
    world.journal.arrange({
      ...world.journal.row(closing.record.id),
      status: 'pending',
      backupPath: retainedBackup,
    });

    world.resetLog();

    const outcome = await cleanupSession(world.sessionId, world.context);

    expect(outcome.status).toBe('clean');
    expect(world.journal.row(closing.record.id).status).toBe('reverted');
    expectFileBytes(closing.path, closing.originalBytes);

    // Only A's own backup was deleted, from the location A's store composes.
    expect(only(world.removals, 'backup deletion').digest).toBe(closing.record.originalHash);
    expect(existsSync(world.backupPathOf(closing.record.originalHash))).toBe(false);

    // B's original is exactly where B's record says it is, and B is untouched.
    expectFileBytes(retainedBackup, retained.originalBytes);
    expect(world.journal.row(retained.record.id).status).toBe('conflict');
    expectFileBytes(retained.path, retained.instrumentedBytes);
  });

  for (const placement of [
    { name: 'the top level of another session’s directory', inQuarantine: false },
    { name: 'another session’s quarantine', inQuarantine: true },
  ] as const) {
    it(`does not honour a backup moved into ${placement.name}`, async () => {
      const world = makeWorld();
      const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
      const digest = patched.record.originalHash;

      const directory = placement.inQuarantine
        ? quarantinePathOf(world, NEIGHBOUR_SESSION)
        : join(world.debuggenHome, 'backups', NEIGHBOUR_SESSION);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);

      const moved = join(directory, digest);
      renameSync(world.backupPathOf(digest), moved);
      world.journal.arrange({ ...world.journal.row(patched.record.id), backupPath: moved });

      world.resetLog();
      const mark = world.mark();

      const outcome = await cleanupSession(world.sessionId, world.context);

      // Where a neighbour's sweep could delete it, the file is not this
      // session's to trust: the store's own location was read instead and is
      // empty, so the record is reported rather than restored from it.
      expect(outcome.status).toBe('conflict');
      expect(outcome.restored).toEqual([]);
      expectNothingWritten(world.log);

      const conflict = only(outcome.conflicts, 'conflict report');
      expect(conflict.recordId).toBe(patched.record.id);
      expect(conflict.reason).toBe('backup-missing');

      expect(world.journal.transitions(mark)).toEqual([
        { recordId: patched.record.id, status: 'conflict' },
      ]);
      expect(world.removals).toEqual([]);
      expectFileBytes(patched.path, patched.instrumentedBytes);
      expectFileBytes(moved, patched.originalBytes);
    });
  }

  it('keeps a relocated file that does not hash to the record digest', async () => {
    const world = makeWorld();
    const closing = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const digest = closing.record.originalHash;

    // Named by the digest, inside the session's own quarantine, and not the
    // original: a file the store would delete in the record's name if it
    // trusted the name alone.
    const relocated = join(quarantineOf(world), digest);
    const foreignBytes = Buffer.from('export const notTheOriginal = true;\n', 'utf8');
    writeFileSync(relocated, foreignBytes, { mode: 0o600 });

    writeFileSync(closing.path, closing.originalBytes);
    world.journal.arrange({
      ...world.journal.row(closing.record.id),
      status: 'pending',
      backupPath: relocated,
    });

    world.resetLog();

    const outcome = expectOk(
      await restoreModification(world.journal.row(closing.record.id), world.context),
      'a restore outcome',
    );

    expect(outcome.kind).toBe('already-original');
    expect(outcome.backup).toBe('retained');
    expectFileBytes(closing.path, closing.originalBytes);
    expectFileBytes(relocated, foreignBytes);
    // The composed backup was never a candidate for this deletion either.
    expectFileBytes(world.backupPathOf(digest), closing.originalBytes);
  });

  it('keeps a relocated backup out of the session directory’s sweep, and restores from it after', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const relocated = relocateBackup(world, patched);

    // The sweep deletes only digest-named files at the session directory's own
    // level, and reports the quarantine subdirectory it will not enter.
    const swept = await world.backups.removeSessionDirectory();
    expect(isErr(swept)).toBe(true);
    expectFileBytes(relocated, patched.originalBytes);

    world.resetLog();

    const outcome = await cleanupSession(world.sessionId, world.context);

    expect(outcome.status).toBe('clean');
    expectFileBytes(patched.path, patched.originalBytes);
    expect(existsSync(relocated)).toBe(false);
  });

  /*
   * A directory swapped for a link after it was judged redirects nothing (N2).
   */

  /**
   * A store over the world's state root and session whose relocated-backup
   * seam runs `swap` on its `on`-th call: the instant after a pin was judged
   * and before the read or the unlink goes through it.
   *
   * A restore of a relocated record reaches the seam in a fixed order: the
   * conflict detector's read of the backup (1), the restoration's own read (2)
   * and the verified delete (3).
   */
  function storeSwappingAt(
    world: World,
    on: number,
    swap: () => void,
  ): { readonly store: BackupStore; readonly calls: () => number } {
    let calls = 0;

    const store = createBackupStore({
      debuggenHome: world.debuggenHome,
      sessionId: world.sessionId,
      onRelocatedBackupPinned: (): void => {
        calls += 1;

        if (calls === on) {
          swap();
        }
      },
    });

    return { store, calls: (): number => calls };
  }

  /**
   * Moves the world session's judged quarantine aside and puts a link to
   * `elsewhere` at its path.
   *
   * @returns Where the judged directory now is.
   */
  function swapQuarantineForLink(world: World, elsewhere: string): string {
    const quarantine = quarantinePathOf(world);
    const judged = `${quarantine}-judged`;

    renameSync(quarantine, judged);
    symlinkSync(elsewhere, quarantine, 'dir');

    return judged;
  }

  /** A developer's own file named by `digest`, outside the backup tree. */
  function plantExternalFile(world: World, digest: string): { path: string; bytes: Buffer } {
    const elsewhere = join(world.root, 'developer-files');
    mkdirSync(elsewhere, { recursive: true, mode: 0o700 });

    const path = join(elsewhere, digest);
    const bytes = Buffer.from('export const developerOwned = true;\n', 'utf8');
    writeFileSync(path, bytes);

    return { path, bytes };
  }

  it('reads the backup from the directory it judged when that directory is swapped for a link before the read', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const digest = patched.record.originalHash;
    relocateBackup(world, patched);

    const external = plantExternalFile(world, digest);
    let judged = '';
    const swapping = storeSwappingAt(world, 2, () => {
      judged = swapQuarantineForLink(world, dirname(external.path));
    });

    world.resetLog();

    const outcome = expectOk(
      await restoreModification(world.journal.row(patched.record.id), {
        ...world.context,
        backups: swapping.store,
      }),
      'a restore outcome',
    );

    // A read that re-resolved the path would have followed the link, found the
    // developer's file, and refused it as a digest mismatch; the pinned read
    // reached the judged directory and restored the real original.
    expect(outcome.kind).toBe('restored');
    expectFileBytes(patched.path, patched.originalBytes);

    // The delete pinned the path afresh, met the link before reaching the seam,
    // and kept the backup.
    expect(swapping.calls()).toBe(2);
    expect(outcome.backup).toBe('retained');
    expectFileBytes(join(judged, digest), patched.originalBytes);
    expectFileBytes(external.path, external.bytes);
  });

  it('deletes the backup from the directory it judged when that directory is swapped for a link before the unlink', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const digest = patched.record.originalHash;
    relocateBackup(world, patched);

    const external = plantExternalFile(world, digest);
    let judged = '';
    const swapping = storeSwappingAt(world, 3, () => {
      judged = swapQuarantineForLink(world, dirname(external.path));
    });

    world.resetLog();

    const outcome = expectOk(
      await restoreModification(world.journal.row(patched.record.id), {
        ...world.context,
        backups: swapping.store,
      }),
      'a restore outcome',
    );

    expect(outcome.kind).toBe('restored');
    expectFileBytes(patched.path, patched.originalBytes);

    // The third call was the delete, which unlinked the verified backup inside
    // the judged directory — never the developer's file the link now leads to.
    expect(swapping.calls()).toBe(3);
    expect(outcome.backup).toBe('deleted');
    expect(existsSync(join(judged, digest))).toBe(false);
    expectFileBytes(external.path, external.bytes);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Path containment
 * ---------------------------------------------------------------------------
 */

describe('a record whose file is not inside the project', () => {
  /** The spellings of an escape a record could carry, all refused the same way. */
  const ESCAPES = Object.freeze([
    `../${OUTSIDE_FILE}`,
    `src/../../${OUTSIDE_FILE}`,
    '/etc/hosts',
  ] as const);

  for (const escape of ESCAPES) {
    it(`is refused before any I/O: '${escape}'`, async () => {
      const world = makeWorld();
      const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
      const outsidePath = join(world.root, OUTSIDE_FILE);

      writeFileSync(outsidePath, OUTSIDE_CONTENT);

      world.resetLog();

      const mark = world.mark();
      // A record is normally kept safe by its schema; this one arrives from a
      // store, another process or an older version, and the pass does not rely
      // on a caller having validated it.
      const escaping: ModificationRecord = { ...patched.record, file: escape };
      const error = refusalOf(
        await restoreModification(escaping, world.context),
        'a restore of an escaping record',
      );

      expect(error.code).toBe('PATH_OUTSIDE_PROJECT');

      // Refused *before* anything happened: no resolution, no read, no write,
      // and no journal transition.
      expectNoFileSystemAccess(world.log);
      expect(world.journal.transitions(mark)).toEqual([]);
      expectFileBytes(outsidePath, OUTSIDE_CONTENT);
      expect(world.journal.row(patched.record.id).status).toBe('applied');
    });
  }

  it('is reported as a failure of the session pass, with nothing written', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const outsidePath = join(world.root, OUTSIDE_FILE);

    writeFileSync(outsidePath, OUTSIDE_CONTENT);
    world.journal.arrange({ ...patched.record, file: `../${OUTSIDE_FILE}` });
    world.resetLog();

    const outcome = await cleanupSession(world.sessionId, world.context);

    // A failure, not a conflict: nothing was found to have diverged.
    expect(outcome.status).toBe('partial');
    expect(outcome.restored).toEqual([]);
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.skipped.map((record) => record.id)).toEqual([patched.record.id]);

    const failure = only(outcome.failures, 'failure');
    expect(failure.recordId).toBe(patched.record.id);
    expect(failure.sessionId).toBe(world.sessionId);
    expect(failure.error.code).toBe('PATH_OUTSIDE_PROJECT');

    expectNothingWritten(world.log);
    expectFileBytes(outsidePath, OUTSIDE_CONTENT);
    expect(existsSync(world.backupPathOf(patched.record.originalHash))).toBe(true);
  });

  it('still reports conflict when the record it could not re-report is already in conflict', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    // An unresolved conflict from an earlier pass, whose path this pass refuses
    // before it can compose a fresh report: no report is renewed, and the
    // conflict is still outstanding.
    world.journal.arrange({ ...patched.record, status: 'conflict', file: `../${OUTSIDE_FILE}` });
    world.resetLog();

    const outcome = await cleanupSession(world.sessionId, world.context);

    expect(outcome.status).toBe('conflict');
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.restored).toEqual([]);
    expect(only(outcome.skipped, 'skipped record').status).toBe('conflict');
    expect(only(outcome.failures, 'failure').error.code).toBe('PATH_OUTSIDE_PROJECT');
    expectNothingWritten(world.log);
    expect(world.journal.row(patched.record.id).status).toBe('conflict');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Repeating a pass, and a pass that half succeeds
 * ---------------------------------------------------------------------------
 */

describe('a repeated pass', () => {
  it('reports clean and performs no work at all', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    const first = await cleanupSession(world.sessionId, world.context);
    expect(first.status).toBe('clean');
    expectFileBytes(patched.path, patched.originalBytes);

    const digest = digestOf(patched.path);
    const modifiedAt = statSync(patched.path).mtimeMs;

    world.resetLog();

    const mark = world.mark();
    const second = await cleanupSession(world.sessionId, world.context);

    expect(second.status).toBe('clean');
    expect(second.restored).toEqual([]);
    expect(second.conflicts).toEqual([]);
    expect(second.skipped).toEqual([]);
    expect(second.failures).toEqual([]);
    expect(second.completedAt).toBe(FIXED_NOW);

    // A `reverted` record's disposition is `none`, so the second pass reads the
    // journal once and touches nothing else — which is what makes a retried
    // cleanup after a crashed service safe rather than merely harmless.
    expect(world.journal.calls.slice(mark)).toEqual([
      { kind: 'listBySession', sessionId: world.sessionId },
    ]);
    expectNoFileSystemAccess(world.log);
    expect(world.removals).toEqual([]);
    expect(digestOf(patched.path)).toBe(digest);
    expect(statSync(patched.path).mtimeMs).toBe(modifiedAt);
  });
});

describe('a pass over two files, one of which was edited', () => {
  it('reports conflict with both lists populated and the time it finished', async () => {
    const world = makeWorld();
    const untouched = await patchSymbol(world, { file: OTHER_FILE, symbol: OTHER_SYMBOL });
    const edited = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const developerBytes = developerEdits(edited.path);

    world.resetLog();

    const outcome = await cleanupSession(world.sessionId, world.context);

    // The restore beside it does not soften the verdict: an edited file was
    // left alone, so `cleanup.status` is `conflict`.
    expect(outcome.status).toBe('conflict');
    expect(outcome.completedAt).toBe(FIXED_NOW);
    expect(outcome.restored.map((record) => record.file)).toEqual([OTHER_FILE]);
    expect(outcome.skipped.map((record) => record.file)).toEqual([TARGET_FILE]);
    expect(only(outcome.conflicts, 'conflict report').file).toBe(TARGET_FILE);
    expect(outcome.failures).toEqual([]);

    // The restorable file came back; the edited one was left exactly as the
    // developer saved it, and only one write happened.
    expectFileBytes(untouched.path, untouched.originalBytes);
    expectFileBytes(edited.path, developerBytes);
    expect(world.log.writes.map((write) => write.expectedHash)).toEqual([
      untouched.record.instrumentedHash,
    ]);

    expect(world.journal.row(untouched.record.id).status).toBe('reverted');
    expect(world.journal.row(edited.record.id).status).toBe('conflict');

    // The restored file's backup is gone; the conflicting one's is the copy the
    // developer was pointed at, so it and its directory stay.
    expect(existsSync(world.backupPathOf(untouched.record.originalHash))).toBe(false);
    expect(existsSync(world.backupPathOf(edited.record.originalHash))).toBe(true);
    expect(existsSync(world.backups.sessionDirectory)).toBe(true);
  });

  it('reports conflict on the first pass and on a second pass over the same state', async () => {
    const world = makeWorld();
    const untouched = await patchSymbol(world, { file: OTHER_FILE, symbol: OTHER_SYMBOL });
    const edited = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const developerBytes = developerEdits(edited.path);

    world.resetLog();

    const first = await cleanupSession(world.sessionId, world.context);

    expect(first.status).toBe('conflict');
    expect(first.restored.map((record) => record.id)).toEqual([untouched.record.id]);
    expect(only(first.conflicts, 'first-pass conflict').reason).toBe('content-changed');
    expectFileBytes(untouched.path, untouched.originalBytes);
    expectFileBytes(edited.path, developerBytes);

    world.resetLog();

    const second = await cleanupSession(world.sessionId, world.context);

    // Identical state, identical verdict: the status describes what is
    // outstanding, not what the pass happened to restore.
    expect(second.status).toBe(first.status);
    expect(second.restored).toEqual([]);
    expect(only(second.conflicts, 'second-pass conflict').recordId).toBe(edited.record.id);
    expect(second.skipped.map((record) => record.id)).toEqual([edited.record.id]);
    expectNothingWritten(world.log);
    expectFileBytes(untouched.path, untouched.originalBytes);
    expectFileBytes(edited.path, developerBytes);
    expect(world.journal.row(edited.record.id).status).toBe('conflict');
    expect(existsSync(world.backupPathOf(edited.record.originalHash))).toBe(true);
  });
});

describe('a pass that restores one file and cannot attempt another', () => {
  it('reports partial when the outstanding record is a failure and nothing conflicted', async () => {
    const world = makeWorld();
    const restorable = await patchSymbol(world, { file: OTHER_FILE, symbol: OTHER_SYMBOL });
    const escaping = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    writeFileSync(join(world.root, OUTSIDE_FILE), OUTSIDE_CONTENT);
    world.journal.arrange({ ...escaping.record, file: `../${OUTSIDE_FILE}` });
    world.resetLog();

    const outcome = await cleanupSession(world.sessionId, world.context);

    expect(outcome.status).toBe('partial');
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.forks).toEqual([]);
    expect(outcome.restored.map((record) => record.id)).toEqual([restorable.record.id]);
    expect(outcome.skipped.map((record) => record.id)).toEqual([escaping.record.id]);
    expect(only(outcome.failures, 'failure').error.code).toBe('PATH_OUTSIDE_PROJECT');

    // One write, to the restorable file; the refused record is still open with
    // its backup, for a pass that can place it.
    expect(world.log.writes.map((write) => write.expectedHash)).toEqual([
      restorable.record.instrumentedHash,
    ]);
    expectFileBytes(restorable.path, restorable.originalBytes);
    expectFileBytes(join(world.root, OUTSIDE_FILE), OUTSIDE_CONTENT);
    expect(world.journal.row(escaping.record.id).status).toBe('applied');
    expect(existsSync(world.backupPathOf(escaping.record.originalHash))).toBe(true);
  });
});

describe('a journal that will not answer', () => {
  /** A copy of the world's journal whose listings fail, as a locked store's would. */
  function unanswering(world: World): ModificationJournal {
    const refusal = new DebuggenError('STORE_ERROR', 'The suite journal refuses to list.', {
      details: { reason: 'suite-listing-refused' },
    });

    return {
      ...world.journal,
      listBySession: () => Promise.resolve(err(refusal)),
      listOpen: () => Promise.resolve(err(refusal)),
    };
  }

  it('makes a session pass partial, not conflict: nothing was attempted and nothing diverged', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    world.resetLog();

    const outcome = await cleanupSession(world.sessionId, {
      ...world.context,
      journal: unanswering(world),
    });

    expect(outcome.status).toBe('partial');
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.restored).toEqual([]);
    expect(only(outcome.failures, 'failure').error.code).toBe('STORE_ERROR');
    expectNoFileSystemAccess(world.log);
    expectFileBytes(patched.path, patched.instrumentedBytes);
  });

  it('makes a start-up reconciliation partial, not conflict', async () => {
    const world = makeWorld();
    const patched = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });

    world.resetLog();

    const outcome = await reconcileModifications({ ...world.context, journal: unanswering(world) });

    expect(outcome.status).toBe('partial');
    expect(outcome.examined).toBe(0);
    expect(outcome.conflicts).toEqual([]);
    expect(only(outcome.failures, 'failure').error.code).toBe('STORE_ERROR');
    expectNoFileSystemAccess(world.log);
    expectFileBytes(patched.path, patched.instrumentedBytes);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Raw bytes: a JavaScript target, and CRLF line endings
 * ---------------------------------------------------------------------------
 */

describe('restoration is indifferent to language and line endings', () => {
  it('restores a JavaScript target, whose patch carries no type alias', async () => {
    const world = makeWorld();
    const typescript = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const javascript = await patchSymbol(world, { file: LEGACY_FILE, symbol: LEGACY_SYMBOL });

    // The two variants differ in exactly the way the template says they do: the
    // helper type alias is inserted into a TypeScript file and omitted from a
    // JavaScript one, so this case exercises the shorter patch.
    expect(typescript.outcome.patch.language).toBe('typescript');
    expect(typescript.outcome.patch.helperTypeAliasInserted).toBe(true);
    expect(javascript.outcome.patch.language).toBe('javascript');
    expect(javascript.outcome.patch.helperTypeAliasInserted).toBe(false);
    expect(addedTypeAliasLines(typescript.record.diff)).toHaveLength(1);
    expect(addedTypeAliasLines(javascript.record.diff)).toEqual([]);

    const outcome = await cleanupSession(world.sessionId, world.context);

    expect(outcome.status).toBe('clean');
    expect(outcome.restored).toHaveLength(2);
    expectFileBytes(javascript.path, javascript.originalBytes);
    expectFileBytes(typescript.path, typescript.originalBytes);
  });

  it('restores CRLF content exactly, because hashing normalises nothing', async () => {
    const world = makeWorld();
    const crlfPath = world.pathOf(CRLF_FILE);

    writeFileSync(crlfPath, CRLF_BYTES);

    const patched = await patchSymbol(world, { file: CRLF_FILE, symbol: CRLF_SYMBOL });

    // The patch itself kept the file's line endings, so the digests on the
    // record describe CRLF content on both sides.
    expect(patched.record.originalHash).toBe(sha256Hex(CRLF_BYTES));
    expect(lineFeedsOf(patched.instrumentedBytes)).toEqual(
      carriageReturnLineFeedsOf(patched.instrumentedBytes),
    );

    const outcome = await cleanupSession(world.sessionId, world.context);

    expect(outcome.status).toBe('clean');
    expectFileBytes(crlfPath, CRLF_BYTES);
    expect(digestOf(crlfPath)).toBe(sha256Hex(CRLF_BYTES));
  });
});

/** The `type` declarations a unified diff adds, which the JavaScript patch has none of. */
function addedTypeAliasLines(diff: string): string[] {
  return diff.split('\n').filter((line) => line.startsWith('+type '));
}

/** How many line feeds `bytes` contains. */
function lineFeedsOf(bytes: Buffer): number {
  return bytes.toString('utf8').split('\n').length - 1;
}

/** How many CRLF pairs `bytes` contains; equal to {@link lineFeedsOf} for CRLF content. */
function carriageReturnLineFeedsOf(bytes: Buffer): number {
  return bytes.toString('utf8').split('\r\n').length - 1;
}
