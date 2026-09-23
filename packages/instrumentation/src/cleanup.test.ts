/**
 * Tests for `./cleanup.ts`: the inverse of the only sequence in this product
 * that writes into a developer's working tree.
 *
 * This suite is the unit-level proof of acceptance test 3 (AAP §0.8.4), and the
 * claim it has to establish is narrow enough to state in one line: **a file
 * comes back byte-for-byte, and a developer's edit is never overwritten**.
 * Everything below is one of those two halves, or the bookkeeping that makes
 * them provable later — the per-status reconciliation table, the reverse-order
 * unwinding of a chain across plan versions, and the rule that a backup is
 * deleted only after the restored content verified against the digest it was
 * recorded under (AAP §0.5.1, §0.4.2, §0.8.3).
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
 * `conflict` or `partial`, and each of them is asserting success: the
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
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DebuggenError, err, isErr, ok } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';
import { sha256Hex } from '@debuggen/shared/node';
import type {
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
import type { BackupStore } from './patch/backup-store.js';
import { createPatcher } from './patch/patcher.js';
import type { PatchOutcome } from './patch/patcher.js';
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
 * `originalHash` is the first record's `instrumentedHash` (AAP §0.4.2).
 */
const SECOND_SYMBOL = 'estimateSoakMinutes';

/** A second fixture file, for the pass that must end `partial`. */
const OTHER_FILE = 'src/server/cone-rules.ts';

/** A named declaration in {@link OTHER_FILE}. */
const OTHER_SYMBOL = 'assertConeValue';

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
 * AAP §0.5.1 requires a pass to act on an open record *whatever* state its
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
   * authority for "this file is still ours". `undefined` for the unconditional
   * write that recreates a target that is no longer there.
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

  /** Unconditional writes — a target that was gone and had to be recreated. */
  readonly creates: WriteAttempt[];
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
}

/**
 * The production filesystem port, wrapped so every path it was asked about is
 * recorded.
 *
 * Delegating rather than faking is the point. "Nothing was written" and "no I/O
 * happened outside the project at all" are claims about the *real* primitives;
 * a fake port could only make them about itself.
 *
 * @param options Corruption and race hooks, both off by default.
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
    replaceFile: (path: string, content: Uint8Array): void => {
      log.creates.push({ path, expectedHash: undefined, contentHash: sha256Hex(content) });

      defaultCleanupFileSystem.replaceFile(path, content);
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
   * This is the ordering proof AAP §0.5.1 asks for: a backup may be deleted
   * only *after* the restored content verified, so at the moment of the delete
   * the file must already hold the recorded original.
   */
  readonly watchedDigest: string | undefined;
}

/**
 * The real backup store, wrapped so deletions are observable.
 *
 * Every other operation is delegated untouched, so a backup is still written,
 * read back and digest-checked by the production store: only the moment of a
 * deletion is reported, and it is reported *before* it happens, which is what
 * lets a case sample the filesystem as the store saw it.
 *
 * @param store The store to delegate to.
 * @param onRemove Called before each deletion is delegated, with the digest and
 * the restored-content digest the caller declared.
 * @returns A store with the same behaviour and an observed `remove`.
 */
function spyBackupStore(
  store: BackupStore,
  onRemove: (digest: string, restoredContentHash: string | undefined) => void,
): BackupStore {
  return {
    sessionId: store.sessionId,
    sessionDirectory: store.sessionDirectory,
    locate: (digest: string) => store.locate(digest),
    put: (digest: string, content: Uint8Array) => store.put(digest, content),
    read: (digest: string) => store.read(digest),
    has: (digest: string) => store.has(digest),
    verify: (digest: string) => store.verify(digest),
    remove: (digest, removeOptions) => {
      onRemove(digest, removeOptions?.restoredContentHash);

      return store.remove(digest, removeOptions);
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

    // The claim of acceptance test 3, asserted on the bytes and on the digest.
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

    // The three-way view of AAP 0.5.1: what the tool did, what the developer
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

    // Already in `conflict`, so the retained row moves nowhere: closing a
    // conflict is the developer's decision, not a pass's.
    expect(world.journal.row(patched.record.id).status).toBe('conflict');
    expect(world.journal.transitions(mark)).toEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * A chain across plan versions
 * ---------------------------------------------------------------------------
 */

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

    // AAP 0.4.2: the delta's record replaced the earlier patch's output, so its
    // `originalHash` is that output's digest and its backup holds the
    // once-patched bytes rather than the pristine ones.
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
    expect(outcome.status).toBe('partial');
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
    expect(chain.retained.map((record) => record.id)).toEqual([second.record.id]);
    expect(chain.conflicts.map((report) => report.recordId)).toEqual([second.record.id]);
    expect(chain.skipped.map((record) => record.id)).toEqual([first.record.id]);
    expect(chain.failures).toEqual([]);
    expect(chain.outcomes.map((outcome) => outcome.kind)).toEqual(['conflict']);

    // Nothing was written, and the record behind the conflict was not even
    // asked: its expectation cannot hold while the file is what it now is.
    expectNothingWritten(world.log);
    expectFileBytes(world.pathOf(TARGET_FILE), edited);
    expect(world.journal.row(first.record.id).status).toBe('applied');
    expect(world.journal.transitions(mark)).toEqual([
      { recordId: second.record.id, status: 'conflict' },
    ]);
    expect(existsSync(world.backupPathOf(first.record.originalHash))).toBe(true);
    expect(existsSync(world.backupPathOf(second.record.originalHash))).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The reconciliation table of AAP 0.5.1
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
 * The table of AAP §0.5.1, one row per branch.
 *
 * `pending` and `failed` share the three-way reading — the write may or may not
 * have landed — while `applied` is restore-only, because for that record the
 * write is known to have landed and content that is no longer ours means
 * something outside this product changed the file. `conflict` is retained and
 * re-reported, and `reverted` is finished business that is not even read.
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
    name: 'a record in conflict whose file is still instrumented is still not written to',
    status: 'conflict',
    file: 'instrumented',
    disposition: 'retained',
    outcome: 'conflict',
    recordEndsAs: 'conflict',
    wrote: false,
    conflictReason: 'content-changed',
    fileEndsAs: 'unchanged',
    backupKept: true,
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

    expect(outcome.status).toBe('conflict');
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

    // Recreated through the unconditional write, since an absent target has no
    // content to make a conditional one out of.
    expect(world.log.writes).toEqual([]);
    expect(only(world.log.creates, 'unconditional write').contentHash).toBe(
      patched.record.originalHash,
    );

    expectFileBytes(patched.path, patched.originalBytes);
    expect(world.journal.row(patched.record.id).status).toBe('reverted');
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

    expect(outcome.status).toBe('conflict');
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
  it('reports partial with both lists populated and the time it finished', async () => {
    const world = makeWorld();
    const untouched = await patchSymbol(world, { file: OTHER_FILE, symbol: OTHER_SYMBOL });
    const edited = await patchSymbol(world, { file: TARGET_FILE, symbol: TARGET_SYMBOL });
    const developerBytes = developerEdits(edited.path);

    world.resetLog();

    const outcome = await cleanupSession(world.sessionId, world.context);

    expect(outcome.status).toBe('partial');
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
