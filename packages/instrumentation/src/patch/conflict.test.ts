/**
 * Tests for `./conflict.ts`: the module that decides whether a file this
 * product instrumented may be written to, and the reason nobody's edit is ever
 * discarded.
 *
 * `./patcher.ts` is the only code in the monorepo that puts bytes into a
 * developer's working tree, and `../cleanup.ts` is the only code that takes
 * them back out. Neither of them decides *whether* to write — this module does,
 * and it decides by hashing raw bytes. So the failure this suite exists to
 * catch is not a crash. It is a detector that looks perfectly correct and is
 * quietly too generous: one that normalises whitespace before comparing, that
 * decodes to text and compares strings, that compares a chained record against
 * "the original" instead of against its own recorded output, or that helpfully
 * repairs the file it was only asked about. Each of those reads as a passing
 * restore and costs a developer work they will not get back.
 *
 * ## The four assertions of the headline case are a set
 *
 * AAP §0.5.1 states the promise: a file whose bytes match what the tool wrote
 * is restored from its backup; a file that differs is **left untouched**, the
 * original **stays** in the backup directory, and the conflict is reported with
 * a three-way diff. `describe('a developer edit on top of an instrumented
 * file')` asserts all four — the verdict, the file's bytes, the backup's
 * survival, and a report a user interface can actually render — because
 * dropping any one of them lets through a regression the others do not see. In
 * particular **"the file is byte-identical to what the developer left"** is the
 * only one of the four that catches a detector that restored: the verdict would
 * still say `content-changed`, the backup would still be there, and the diff
 * would still be right, while the edit was gone.
 *
 * ## Three habits, each load-bearing
 *
 * - **The real patcher creates the state under test.** Every case copies the
 *   committed fixture project into a fresh `mkdtemp` directory with its own
 *   temporary `$DEBUGGEN_HOME`, then runs `./patcher.ts` over it with the real
 *   `./function-timing.ts` transform and the real content-addressed backup
 *   store. A hand-written "instrumented" file would hash to something no patch
 *   produced and carry a diff nothing rendered — and the point of driving the
 *   patcher is that this suite fails the day the patcher and the detector stop
 *   agreeing about what was written. Only the journal is in memory: the service
 *   implements that port over `node:sqlite` and this package never opens a
 *   database.
 * - **Bytes, not just digests.** Every "untouched" assertion compares content
 *   with `Buffer.compare` as well as by SHA-256, so a mistake in hashing cannot
 *   mask a mistake in content — which is exactly the mistake the
 *   trailing-newline and CRLF cases are built around.
 * - **The ports are wrapped, never replaced.** The filesystem reader and the
 *   backup store delegate to the production implementations and record every
 *   call. That is what turns "detection wrote nothing", "detection read nothing
 *   outside the project" and "detection never moved a record's status" into
 *   assertions rather than inferences.
 *
 * ## A conflict is a pass
 *
 * Most cases below end in a conflict verdict, and every one of them is
 * asserting success: the developer's bytes survived, the pristine original is
 * still recoverable by hand, and both user interfaces were handed a report to
 * show. A conflict is returned as **data inside a successful `Result`** — never
 * thrown, never an `Err` a caller might log and forget — and `Err` is reserved
 * for the conditions that make the question unanswerable, each of which must
 * also leave the file and the backup exactly as they were.
 *
 * This suite is the unit-level half of acceptance test 3 (AAP §0.8.4). The
 * session-level halves are `../cleanup.test.ts`, the service's
 * `cleanup-conflict` integration test and `tests/e2e/cleanup.spec.ts`.
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
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyPatch } from 'diff';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { DebuggenError, createConsoleLogger, err, isErr, newSessionId, ok } from '@debuggen/shared';
import type { LogRecord, Logger, Result } from '@debuggen/shared';
import { sha256Hex } from '@debuggen/shared/node';

import {
  MODIFICATION_CONFLICT_REASONS,
  modificationConflictSchema,
} from '../schema/modification.js';
import type {
  ModificationConflict,
  ModificationJournal,
  ModificationRecord,
  ModificationStatus,
  ModificationStatusPatch,
} from '../schema/modification.js';

import { createBackupStore } from './backup-store.js';
import type { BackupStore, RemoveBackupOptions } from './backup-store.js';
import { FunctionTimingPatcher } from './function-timing.js';
import { createPatcher } from './patcher.js';
import type { PatchOutcome } from './patcher.js';
import { SPAN_HELPER_GLOBAL, SPAN_HELPER_TYPE_NAME } from './wrap-template.js';
import {
  BACKUP_UNAVAILABLE_REASONS,
  CONFLICT_DIFF_CHARACTER_LIMIT,
  CONFLICT_DIFF_OMISSION_REASONS,
  CONFLICT_DIFF_VIEWS,
  CONFLICT_VERDICT_KINDS,
  buildConflictReport,
  defaultConflictFileReader,
  detectConflict,
  isConflictVerdict,
  isRestorableVerdict,
} from './conflict.js';
import type {
  AlreadyRevertedVerdict,
  BackupUnavailableVerdict,
  ConflictDetectionContext,
  ConflictDiffView,
  ConflictFileReader,
  ConflictVerdict,
  ConflictingVerdict,
  ContentChangedVerdict,
  FileMissingVerdict,
  RestorableVerdict,
} from './conflict.js';

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
 * resolve there instead of beside this file. It is never `import`ed either —
 * the package tsconfig excludes `test/fixtures/**` from the program precisely
 * because the fixture is patching *input*, not code this project compiles.
 */
const FIXTURE_PROJECT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'fixtures',
  'project-a',
);

/**
 * A digest of every byte of the committed fixture tree.
 *
 * Computed by walking the tree in a stable order and hashing each file's path
 * beside its own digest, so a changed byte, an added file and a removed file
 * are all visible in one value. Captured at module load — before any case has
 * run — and asserted again by the last case in this file, which is the cheapest
 * possible guard against a case addressing the committed fixture instead of its
 * own copy: the real patcher runs here, and `git status --porcelain
 * packages/instrumentation` has to be empty afterwards.
 */
function digestOfFixtureTree(): string {
  const lines: string[] = [];

  const walk = (directory: string, prefix: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );

    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

      if (entry.isDirectory()) {
        walk(absolute, relative);
        continue;
      }

      lines.push(`${relative} ${sha256Hex(readFileSync(absolute))}`);
    }
  };

  walk(FIXTURE_PROJECT, '');

  return sha256Hex(lines.join('\n'));
}

/** The fixture tree as it stood before this file's first case ran. */
const FIXTURE_TREE_DIGEST = digestOfFixtureTree();

/**
 * The fixture file most cases patch, project-relative POSIX.
 *
 * It carries exactly two independently patchable exported functions, which is
 * what lets one file hold a two-version chain (AAP §0.4.2) without a second
 * file's state bleeding into the comparison.
 */
const TARGET_FILE = 'src/server/cycle-planner.ts';

/** The symbol plan version 1 wraps in {@link TARGET_FILE}. */
const FIRST_SYMBOL = 'planCycleSegments';

/** The symbol plan version 2 wraps in {@link TARGET_FILE}, for the chain cases. */
const SECOND_SYMBOL = 'estimateSoakMinutes';

/** A plain-JavaScript target, so the decision is proven for a `.js` file too. */
const JS_FILE = 'src/legacy/bisque-schedule.js';

/** A named declaration in {@link JS_FILE}. */
const JS_SYMBOL = 'planBisqueRamp';

/**
 * The clock every detection is driven with, so `detectedAt` is assertable.
 *
 * A fixed, finite, positive epoch-millisecond reading: the conflict schema
 * requires all three, and injecting it keeps the timestamp out of the set of
 * things a case has to tolerate variation in.
 */
const FIXED_NOW = 1_800_000_000_000;

/**
 * The line a case appends to stand in for a developer saving the file.
 *
 * Distinctive on purpose, and it appears in no fixture and no patch template,
 * so "the developer's specific edit is in the instrumented→current view" and
 * "no file content reached a log record" are both assertions about a token that
 * can only have come from here.
 */
const DEVELOPER_EDIT_LINE = "const kilnDoorLatchNote = 'verify-latch-before-firing';\n";

/**
 * A token present in the pristine fixture source and in nothing else.
 *
 * The privacy case scans every captured log record for it. Deliberately not a
 * path fragment: `file` and `backupPath` legitimately appear in log fields, so
 * a marker that were part of either would make the assertion fail for the wrong
 * reason.
 */
const PRISTINE_SOURCE_TOKEN = 'SOAK_MINUTES_PER_CONE';

/**
 * Content planted outside the project, which no detection may read or write.
 *
 * Hashed before and after every containment case, so a detector that resolved a
 * `'..'` path and read it is caught by the bytes rather than by an inference
 * from the error code alone.
 */
const EXTERNAL_CONTENT = 'export function outsideTheProject(): number {\n  return 1;\n}\n';

/** The spellings of `record.file` that must be refused before anything is read. */
const ESCAPING_FILES = Object.freeze([
  '../escaped.ts',
  'src/../../escaped.ts',
  '/etc/passwd',
] as const);

/**
 * Whether this host lets the test process create a symbolic link.
 *
 * The no-follow read case needs one, and a platform that refuses the plant
 * (Windows without developer mode) cannot host it. Probed once rather than
 * selected by platform name.
 */
const CAN_CREATE_SYMLINKS = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'debuggen-conflict-link-probe-'));

  try {
    symlinkSync(join(probe, 'absent'), join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

/*
 * ---------------------------------------------------------------------------
 * Per-case temporary world
 * ---------------------------------------------------------------------------
 */

/** The directory everything the current case created lives in. */
let caseRoot = '';

beforeEach(() => {
  caseRoot = mkdtempSync(join(tmpdir(), 'debuggen-conflict-'));
});

afterEach(() => {
  // Unconditional, and in `afterEach` rather than at the end of each case, so a
  // failing or throwing case still takes its temporary trees with it and
  // repeated runs accumulate nothing under `os.tmpdir()`.
  rmSync(caseRoot, { recursive: true, force: true });
  caseRoot = '';
});

/*
 * ---------------------------------------------------------------------------
 * The journal port, in memory
 * ---------------------------------------------------------------------------
 */

/** The signature of {@link ModificationJournal.append}, named for the spy. */
type JournalAppend = (record: ModificationRecord) => Promise<Result<ModificationRecord>>;

/** The signature of {@link ModificationJournal.updateStatus}, named for the spy. */
type JournalUpdateStatus = (
  id: string,
  status: ModificationStatus,
  patch?: ModificationStatusPatch,
) => Promise<Result<ModificationRecord>>;

/** The in-memory journal, with its two mutating operations spied on. */
interface TestJournal extends ModificationJournal {
  /** Every appended record, in append order, at its current status. */
  readonly rows: readonly ModificationRecord[];

  /** Spied, so "detection appended nothing" is an assertion. */
  readonly append: Mock<JournalAppend>;

  /** Spied, so "detection moved no record's status" is an assertion. */
  readonly updateStatus: Mock<JournalUpdateStatus>;
}

/**
 * The `ModificationJournal` port, in memory and spied.
 *
 * The only substituted dependency in this suite, and legitimately so: the
 * service implements this port over `node:sqlite` and this package never opens
 * a database. Both mutating methods are `vi.fn`s because a *negative* is being
 * asserted — `detectConflict` takes no journal at all and must therefore move
 * no status, which is only observable by watching the port the rest of the
 * sequence writes through.
 */
function createTestJournal(): TestJournal {
  const rows: ModificationRecord[] = [];

  const find = (id: string): Result<number> => {
    const index = rows.findIndex((row) => row.id === id);

    return index >= 0
      ? ok(index)
      : err(
          new DebuggenError('STORE_ERROR', 'No modification record with that id.', {
            hint: 'The suite asked to update a record it never appended.',
            details: { recordId: id },
          }),
        );
  };

  const append = vi.fn<JournalAppend>((record) => {
    rows.push(record);

    return Promise.resolve(ok(record));
  });

  const updateStatus = vi.fn<JournalUpdateStatus>((id, status, patch) => {
    const found = find(id);

    if (isErr(found)) {
      return Promise.resolve(found);
    }

    const current = rows[found.value];

    if (current === undefined) {
      return Promise.resolve(
        err(
          new DebuggenError('STORE_ERROR', 'A journal row vanished between lookup and update.', {
            hint: 'This is a defect in the suite’s own journal, not in the code under test.',
            details: { recordId: id },
          }),
        ),
      );
    }

    const updated: ModificationRecord = {
      ...current,
      status,
      ...(patch?.appliedAt === undefined ? {} : { appliedAt: patch.appliedAt }),
      ...(patch?.diff === undefined ? {} : { diff: patch.diff }),
      ...(patch?.backupPath === undefined ? {} : { backupPath: patch.backupPath }),
      ...(patch?.instrumentedHash === undefined
        ? {}
        : { instrumentedHash: patch.instrumentedHash }),
    };

    rows[found.value] = updated;

    return Promise.resolve(ok(updated));
  });

  return {
    rows,
    append,
    updateStatus,
    listBySession: (sessionId: string): Promise<Result<ModificationRecord[]>> =>
      Promise.resolve(ok(rows.filter((row) => row.sessionId === sessionId))),
    // Everything except `reverted`: AAP §0.5.1 reconciles an open record
    // whatever state its owning session is in.
    listOpen: (): Promise<Result<ModificationRecord[]>> =>
      Promise.resolve(ok(rows.filter((row) => row.status !== 'reverted'))),
  };
}

/*
 * ---------------------------------------------------------------------------
 * The filesystem reader, wrapped
 * ---------------------------------------------------------------------------
 */

/** Every path the production primitives were asked about, by operation. */
interface FileReaderLog {
  /** Absolute paths handed to `readFileBytes`. */
  readonly reads: string[];

  /** Byte lengths handed to `hashBytes`, which is all a digest reveals. */
  readonly hashedByteLengths: number[];
}

/** The production reader, plus what it was asked. */
interface RecordingFileReader {
  /** The port handed to {@link detectConflict} through its context. */
  readonly files: ConflictFileReader;

  /** What that port was asked about. */
  readonly log: FileReaderLog;
}

/**
 * {@link defaultConflictFileReader}, wrapped so every path it was asked about
 * is recorded.
 *
 * Delegating rather than faking is the point: the containment cases assert that
 * the **real** no-follow read was never reached for a path outside the project,
 * which a fake port could only assert about itself. Byte fidelity is therefore
 * the production behaviour throughout — `readFileNoFollow` and `sha256Hex`,
 * with no decoding and no newline normalisation anywhere in the path.
 */
function recordingFileReader(): RecordingFileReader {
  const log: FileReaderLog = { reads: [], hashedByteLengths: [] };

  return {
    log,
    files: {
      readFileBytes: (path) => {
        log.reads.push(path);

        return defaultConflictFileReader.readFileBytes(path);
      },
      hashBytes: (bytes) => {
        log.hashedByteLengths.push(bytes.byteLength);

        return defaultConflictFileReader.hashBytes(bytes);
      },
    },
  };
}

/*
 * ---------------------------------------------------------------------------
 * The backup store, wrapped
 * ---------------------------------------------------------------------------
 */

/** Every call the backup store received, by operation. */
interface BackupStoreLog {
  /** Digests handed to `locate` or `locateRecorded`. */
  readonly locates: string[];

  /** Digests handed to `read` or `readRecorded`. */
  readonly reads: string[];

  /** Recorded paths handed to `locateRecorded` or `readRecorded`, in call order. */
  readonly recordedPaths: string[];

  /** Digests handed to `verify`. */
  readonly verifies: string[];

  /** Digests handed to `has`. */
  readonly existenceChecks: string[];

  /** Digests handed to `put`: a write, which detection must never perform. */
  readonly puts: string[];

  /**
   * Digests handed to `remove` or `removeRecorded`: a delete, which detection
   * must never perform.
   */
  readonly removes: string[];

  /** One entry per `removeSessionDirectory` call, for the same reason. */
  readonly directoryRemovals: string[];
}

/** The real store, plus what it was asked. */
interface RecordingBackupStore {
  /** The port handed to the patcher and to {@link detectConflict}. */
  readonly store: BackupStore;

  /** What that port was asked. */
  readonly log: BackupStoreLog;
}

/**
 * The real content-addressed backup store, wrapped so every call is recorded.
 *
 * The store is what makes "the original must remain recoverable by hand" and
 * "detection never wrote" both checkable: the first by reading the backup back
 * through it, the second by observing that `put`, `remove`, `removeRecorded`
 * and `removeSessionDirectory` were never reached. The record-path operations
 * log into the same digest lists as their digest-keyed counterparts, so an
 * assertion that detection located or read nothing covers both routes.
 */
function recordingBackupStore(real: BackupStore): RecordingBackupStore {
  const log: BackupStoreLog = {
    locates: [],
    reads: [],
    recordedPaths: [],
    verifies: [],
    existenceChecks: [],
    puts: [],
    removes: [],
    directoryRemovals: [],
  };

  return {
    log,
    store: {
      sessionId: real.sessionId,
      sessionDirectory: real.sessionDirectory,
      locate: (originalHash: string): Result<string> => {
        log.locates.push(originalHash);

        return real.locate(originalHash);
      },
      locateRecorded: (recordedPath: string, originalHash: string) => {
        log.locates.push(originalHash);
        log.recordedPaths.push(recordedPath);

        return real.locateRecorded(recordedPath, originalHash);
      },
      put: (originalHash: string, content: Uint8Array) => {
        log.puts.push(originalHash);

        return real.put(originalHash, content);
      },
      read: (originalHash: string) => {
        log.reads.push(originalHash);

        return real.read(originalHash);
      },
      readRecorded: (recordedPath: string, originalHash: string) => {
        log.reads.push(originalHash);
        log.recordedPaths.push(recordedPath);

        return real.readRecorded(recordedPath, originalHash);
      },
      has: (originalHash: string) => {
        log.existenceChecks.push(originalHash);

        return real.has(originalHash);
      },
      verify: (originalHash: string) => {
        log.verifies.push(originalHash);

        return real.verify(originalHash);
      },
      remove: (originalHash: string, options?: RemoveBackupOptions) => {
        log.removes.push(originalHash);

        return real.remove(originalHash, options);
      },
      removeRecorded: (
        recordedPath: string,
        originalHash: string,
        options?: RemoveBackupOptions,
      ) => {
        log.removes.push(originalHash);

        return real.removeRecorded(recordedPath, originalHash, options);
      },
      removeSessionDirectory: () => {
        log.directoryRemovals.push(real.sessionDirectory);

        return real.removeSessionDirectory();
      },
    },
  };
}

/*
 * ---------------------------------------------------------------------------
 * The logger, capturing
 * ---------------------------------------------------------------------------
 */

/** A logger that keeps its records instead of printing them. */
interface CapturingLogger {
  /** Handed to {@link detectConflict} through its context. */
  readonly logger: Logger;

  /** Every record that passed the threshold, in emission order. */
  readonly records: LogRecord[];
}

/**
 * A `trace`-level {@link Logger} over an array sink.
 *
 * `trace` rather than the default `info`, so the `debug` lines of the restore
 * and no-op paths are captured too: the privacy assertion has to cover every
 * line this module can emit, and a threshold that dropped half of them would
 * make it pass by not looking.
 */
function capturingLogger(): CapturingLogger {
  const records: LogRecord[] = [];

  return {
    records,
    logger: createConsoleLogger({
      level: 'trace',
      name: 'conflict-test',
      sink: (record) => {
        records.push(record);
      },
    }),
  };
}

/*
 * ---------------------------------------------------------------------------
 * The world one case works in
 * ---------------------------------------------------------------------------
 */

/** One case's temporary world: a project copy, a state root, and a session. */
interface World {
  /** The directory holding everything this world created. */
  readonly root: string;

  /** The copied fixture project: the `projectRoot` every path resolves inside. */
  readonly projectRoot: string;

  /** The temporary `$DEBUGGEN_HOME` the backup store writes under. */
  readonly debuggenHome: string;

  /** The session every record and backup belongs to. */
  readonly sessionId: string;

  /** The in-memory journal the patcher appends to. */
  readonly journal: TestJournal;

  /** The wrapped backup store. */
  readonly backups: RecordingBackupStore;

  /** The wrapped filesystem reader handed to detection. */
  readonly files: RecordingFileReader;

  /** The capturing logger handed to detection. */
  readonly logs: CapturingLogger;

  /** The absolute path of a project-relative file inside the copy. */
  pathOf(file: string): string;

  /** Where a backup for `originalHash` is filed, composed independently. */
  backupPathOf(originalHash: string): string;

  /** Installs one patch with the real patcher, transform and backup store. */
  patch(request: PatchRequest): Promise<PatchedFile>;

  /** Forgets every recorded call, so a case observes detection alone. */
  resetLogs(): void;
}

/** What {@link World.patch} needs beyond the world itself. */
interface PatchRequest {
  /** The target file, project-relative POSIX. */
  readonly file: string;

  /** The symbol to wrap, spelled as the declaration spells it. */
  readonly symbol: string;

  /** The plan version to stamp the record with. Defaults to 1. */
  readonly planVersion?: number;
}

/** What one real patch produced, with the bytes on either side of it. */
interface PatchedFile {
  /** The journaled record, in its `applied` state. */
  readonly record: ModificationRecord;

  /** Everything else the patcher reported, including the transform's result. */
  readonly outcome: PatchOutcome;

  /** The target's project-relative path. */
  readonly file: string;

  /** The target's absolute path inside the copy. */
  readonly path: string;

  /** The bytes before the patch: what the backup must still hold. */
  readonly originalBytes: Buffer;

  /** The bytes after it: what detection must find to authorise a restore. */
  readonly instrumentedBytes: Buffer;
}

/**
 * Copies the fixture project and prepares a state root, a session and the three
 * wrapped ports for it.
 *
 * A copy per case, never the committed fixture itself: the real patcher runs
 * here and writes real bytes, so a case working in place would leave the
 * repository modified. The state root is created `0700` because the backup
 * store asserts its own directory is private and owned by this account before
 * it writes a single original into it.
 */
function makeWorld(name = 'world'): World {
  const root = join(caseRoot, name);
  const projectRoot = join(root, 'project');
  const debuggenHome = join(root, 'home');

  cpSync(FIXTURE_PROJECT, projectRoot, { recursive: true });
  mkdirSync(debuggenHome, { recursive: true, mode: 0o700 });
  chmodSync(debuggenHome, 0o700);

  const sessionId = newSessionId();
  const journal = createTestJournal();
  const backups = recordingBackupStore(createBackupStore({ debuggenHome, sessionId }));
  const files = recordingFileReader();
  const logs = capturingLogger();

  // One transform per world, shared by every patcher built below: building the
  // ts-morph project is the expensive half of a patch, and the injected
  // instance is the shape `./patcher.ts` documents for a caller that patches
  // more than one file.
  const transform = new FunctionTimingPatcher({ projectRoot });

  const world: World = {
    root,
    projectRoot,
    debuggenHome,
    sessionId,
    journal,
    backups,
    files,
    logs,
    pathOf: (file) => join(projectRoot, file),
    backupPathOf: (originalHash) => join(debuggenHome, 'backups', sessionId, originalHash),
    patch: async (request) => {
      const path = join(projectRoot, request.file);
      const originalBytes = readFileSync(path);

      const patcher = createPatcher({
        projectRoot,
        sessionId,
        planVersion: request.planVersion ?? 1,
        backups: backups.store,
        journal,
        transform,
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
        file: request.file,
        path,
        originalBytes,
        instrumentedBytes: readFileSync(path),
      };
    },
    resetLogs: () => {
      journal.append.mockClear();
      journal.updateStatus.mockClear();
      files.log.reads.length = 0;
      files.log.hashedByteLengths.length = 0;
      backups.log.locates.length = 0;
      backups.log.reads.length = 0;
      backups.log.recordedPaths.length = 0;
      backups.log.verifies.length = 0;
      backups.log.existenceChecks.length = 0;
      backups.log.puts.length = 0;
      backups.log.removes.length = 0;
      backups.log.directoryRemovals.length = 0;
      logs.records.length = 0;
    },
  };

  return world;
}

/** What a case overrides on the detection context, if anything. */
interface ContextOverrides {
  /** A store belonging to another session, for the mismatch refusal. */
  readonly backups?: BackupStore;

  /** A reader that fails on demand, for the unreadable-target refusal. */
  readonly files?: ConflictFileReader;

  /** The developer-facing sentence, which the service normally owns. */
  readonly message?: string;

  /** A clock, for the one case that asserts an unusable reading is refused. */
  readonly now?: () => number;
}

/**
 * The context {@link detectConflict} is asked with: the world's ports, the
 * fixed clock, and whatever the case overrode.
 *
 * Optional members are spread conditionally rather than assigned `undefined`,
 * because `exactOptionalPropertyTypes` is on across this repository and an
 * explicit `undefined` is not the same value as an absent key.
 */
function contextOf(world: World, overrides: ContextOverrides = {}): ConflictDetectionContext {
  return {
    projectRoot: world.projectRoot,
    backups: overrides.backups ?? world.backups.store,
    logger: world.logs.logger,
    now: overrides.now ?? ((): number => FIXED_NOW),
    files: overrides.files ?? world.files.files,
    ...(overrides.message === undefined ? {} : { message: overrides.message }),
  };
}

/*
 * ---------------------------------------------------------------------------
 * Assertion helpers
 * ---------------------------------------------------------------------------
 */

/** The verdict of a successful detection, or a failed test naming the refusal. */
function verdictOf(result: Result<ConflictVerdict>): ConflictVerdict {
  if (isErr(result)) {
    throw new Error(
      `Expected a verdict, received ${result.error.code}: ${result.error.message} ${JSON.stringify(result.error.details)}`,
    );
  }

  return result.value;
}

/** The error of a refused detection, or a failed test naming the verdict it gave. */
function refusalOf(result: Result<ConflictVerdict>): DebuggenError {
  if (!isErr(result)) {
    throw new Error(
      `Expected the detection to be refused, received the '${result.value.kind}' verdict for ${result.value.file}`,
    );
  }

  return result.error;
}

/**
 * The verdict narrowed to one that carries a report, or a failed test.
 *
 * Goes through the module's own {@link isConflictVerdict} rather than comparing
 * `kind` here, so the suite and the caller ask the same question the same way.
 */
function conflictingVerdictOf(verdict: ConflictVerdict): ConflictingVerdict {
  if (!isConflictVerdict(verdict)) {
    throw new Error(`Expected a verdict carrying a conflict report, received '${verdict.kind}'.`);
  }

  return verdict;
}

/**
 * The five per-kind narrowings, so a case can read the fields its verdict
 * actually has.
 *
 * Written out one by one rather than as one generic helper with a type
 * assertion: the whole reason the module returns a discriminated union instead
 * of a boolean is that a caller which forgets a case stops compiling, and a
 * suite that asserted its way around the discriminant would be the first place
 * that guarantee was given up.
 */
function restorableVerdictOf(verdict: ConflictVerdict): RestorableVerdict {
  if (verdict.kind !== 'restorable') {
    throw new Error(`Expected a 'restorable' verdict, received '${verdict.kind}'.`);
  }

  return verdict;
}

/** See {@link restorableVerdictOf}. */
function alreadyRevertedVerdictOf(verdict: ConflictVerdict): AlreadyRevertedVerdict {
  if (verdict.kind !== 'already-reverted') {
    throw new Error(`Expected an 'already-reverted' verdict, received '${verdict.kind}'.`);
  }

  return verdict;
}

/** See {@link restorableVerdictOf}. */
function contentChangedVerdictOf(verdict: ConflictVerdict): ContentChangedVerdict {
  if (verdict.kind !== 'content-changed') {
    throw new Error(`Expected a 'content-changed' verdict, received '${verdict.kind}'.`);
  }

  return verdict;
}

/** See {@link restorableVerdictOf}. */
function fileMissingVerdictOf(verdict: ConflictVerdict): FileMissingVerdict {
  if (verdict.kind !== 'file-missing') {
    throw new Error(`Expected a 'file-missing' verdict, received '${verdict.kind}'.`);
  }

  return verdict;
}

/** See {@link restorableVerdictOf}. */
function backupUnavailableVerdictOf(verdict: ConflictVerdict): BackupUnavailableVerdict {
  if (verdict.kind !== 'backup-unavailable') {
    throw new Error(`Expected a 'backup-unavailable' verdict, received '${verdict.kind}'.`);
  }

  return verdict;
}

/** One diff view of a report, or a failed test naming what was delivered. */
function viewOf(verdict: ConflictingVerdict, view: ConflictDiffView): string {
  const patch = verdict.conflict.diffs?.[view];

  if (patch === undefined) {
    throw new Error(
      `Expected the '${view}' view to be present, received ${JSON.stringify(verdict.omittedDiffs)}`,
    );
  }

  return patch;
}

/** Why a view was left out, or `undefined` when the report carries it. */
function omissionOf(verdict: ConflictingVerdict, view: ConflictDiffView): string | undefined {
  return verdict.omittedDiffs.find((omission) => omission.view === view)?.reason;
}

/** SHA-256 of whatever is on disk at `path`, as the decision table reads it. */
function digestOf(path: string): string {
  return sha256Hex(readFileSync(path));
}

/** Asserts the file at `path` holds exactly `expected`, byte for byte. */
function expectFileBytes(path: string, expected: Buffer | Uint8Array): void {
  const actual = readFileSync(path);

  expect(actual.byteLength).toBe(expected.byteLength);
  expect(Buffer.compare(actual, Buffer.from(expected))).toBe(0);
}

/**
 * Asserts that detection performed no write of any kind.
 *
 * Three ports at once, because "nothing was written" has three meanings that a
 * single one of them would miss: no byte reached the project (the backup store
 * is the only writer this module could reach, and its writers were never
 * called), no backup was created or deleted, and no record changed status —
 * which belongs to `../cleanup.ts` and `./patcher.ts` and not here.
 */
function expectDetectionWroteNothing(world: World): void {
  expect(world.backups.log.puts).toEqual([]);
  expect(world.backups.log.removes).toEqual([]);
  expect(world.backups.log.directoryRemovals).toEqual([]);
  expect(world.journal.append).not.toHaveBeenCalled();
  expect(world.journal.updateStatus).not.toHaveBeenCalled();
}

/**
 * Asserts a report satisfies the schema it travels under, and returns it.
 *
 * Parsed rather than shape-checked by hand: `cleanup.completed` carries this
 * object to both user interfaces, which parse it before rendering it, so the
 * only assertion worth making is the one they make.
 */
function expectSchemaValidConflict(verdict: ConflictingVerdict): void {
  const parsed = modificationConflictSchema.safeParse(verdict.conflict);

  expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'))).toEqual(
    [],
  );
  expect(parsed.success).toBe(true);
  expect(MODIFICATION_CONFLICT_REASONS).toContain(verdict.conflict.reason);
  expect(CONFLICT_VERDICT_KINDS).toContain(verdict.kind);
}

/** Appends a line the way a developer saving the file would, and returns the new bytes. */
function developerEdits(path: string): Buffer {
  const edited = Buffer.concat([readFileSync(path), Buffer.from(DEVELOPER_EDIT_LINE, 'utf8')]);

  writeFileSync(path, edited);

  return edited;
}

/**
 * Converts every bare line feed in `bytes` to a carriage-return/line-feed pair,
 * operating on **raw bytes**.
 *
 * Deliberately not `text.split('\n').join('\r\n')`: decoding to a string and
 * re-encoding it is exactly the mistake this suite is built to catch, and a
 * helper that did it would build its input the same way a broken detector reads
 * it. A byte loop cannot accidentally normalise anything.
 */
function toCarriageReturnLineFeed(bytes: Buffer): Buffer {
  const out: number[] = [];

  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index];

    if (byte === undefined) {
      continue;
    }

    if (byte === 0x0a && bytes[index - 1] !== 0x0d) {
      out.push(0x0d);
    }

    out.push(byte);
  }

  return Buffer.from(out);
}

/**
 * Applies a rendered view to the text it claims to start from, and returns the
 * result.
 *
 * This is how the three views are proven to be the three *transitions* they are
 * named for rather than three plausible-looking patches: applying
 * `originalToCurrent` to the original must yield the current text exactly, and
 * so on for the other two. `fuzzFactor: 0` and `autoConvertLineEndings: false`
 * because an application that fitted mismatched context, or that converted line
 * endings on the way, would prove nothing about the patch that was delivered.
 */
function applyView(from: string, patch: string): string {
  const applied = applyPatch(from, patch, { fuzzFactor: 0, autoConvertLineEndings: false });

  if (applied === false) {
    throw new Error('Expected the rendered view to apply cleanly to the text it starts from.');
  }

  return applied;
}

/** The added lines of a unified diff, without their `+` marker. */
function addedLinesOf(patch: string): string[] {
  return patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1));
}

/** The removed lines of a unified diff, without their `-` marker. */
function removedLinesOf(patch: string): string[] {
  return patch
    .split('\n')
    .filter((line) => line.startsWith('-') && !line.startsWith('---'))
    .map((line) => line.slice(1));
}

/** `bytes` decoded as UTF-8, for the text side of a view assertion. */
function textOf(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

/** Whether a value is an `Error` instance, anywhere inside a report. */
function containsErrorInstance(value: unknown): boolean {
  if (value instanceof Error) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some(containsErrorInstance);
  }

  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(containsErrorInstance);
  }

  return false;
}

/*
 * ---------------------------------------------------------------------------
 * The headline case: an edit on top of a patch
 * ---------------------------------------------------------------------------
 *
 * AAP §0.5.1's four promises, in one case each: the verdict, the file's bytes,
 * the backup's survival, and a report both user interfaces can render. They are
 * split into separate `it`s over one shared setup helper so that a regression
 * names which promise it broke — and they are a *set*: the file-bytes case is
 * the only one that catches a detector which restored.
 */

/** The state every case in the headline block starts from. */
interface EditedWorld {
  /** The world the patch and the edit happened in. */
  readonly world: World;

  /** The patch that was applied. */
  readonly patched: PatchedFile;

  /** The exact bytes the developer left on disk. */
  readonly editedBytes: Buffer;

  /** SHA-256 of {@link EditedWorld.editedBytes}. */
  readonly editedHash: string;

  /** The verdict detection gave, narrowed to one carrying a report. */
  readonly verdict: ConflictingVerdict;
}

/**
 * Patches a fixture target with the real patcher, edits it the way a developer
 * saving the file would, and detects.
 *
 * The patch assertions are here rather than in each case because they are the
 * setup's own preconditions: if the transform ever stopped changing the file,
 * every assertion below would pass for the wrong reason — an unedited,
 * unpatched file trivially matches nothing.
 */
async function patchThenEdit(file: string, symbol: string): Promise<EditedWorld> {
  const world = makeWorld();
  const patched = await world.patch({ file, symbol });

  expect(Buffer.compare(patched.instrumentedBytes, patched.originalBytes)).not.toBe(0);
  expect(patched.record.status).toBe('applied');
  expect(patched.record.originalHash).toBe(sha256Hex(patched.originalBytes));
  expect(patched.record.instrumentedHash).toBe(sha256Hex(patched.instrumentedBytes));
  expect(digestOf(patched.path)).toBe(patched.record.instrumentedHash);
  expect(patched.record.diff.length).toBeGreaterThan(0);

  const editedBytes = developerEdits(patched.path);

  world.resetLogs();

  const verdict = conflictingVerdictOf(
    verdictOf(await detectConflict(patched.record, contextOf(world))),
  );

  return { world, patched, editedBytes, editedHash: sha256Hex(editedBytes), verdict };
}

describe('a developer edit on top of an instrumented file', () => {
  it('is reported as a conflict, returned as data rather than thrown', async () => {
    const { patched, verdict } = await patchThenEdit(TARGET_FILE, FIRST_SYMBOL);

    // `detectConflict` resolved rather than rejected, and `verdictOf` accepted
    // the result, which together are the "data, not an error" claim: a conflict
    // is an expected outcome of asking, and `Err` is reserved for the
    // conditions that make the question unanswerable.
    expect(verdict.kind).toBe('content-changed');
    expect(isRestorableVerdict(verdict)).toBe(false);
    expect(isConflictVerdict(verdict)).toBe(true);

    const changed = contentChangedVerdictOf(verdict);

    expect(changed.actualHash).not.toBe(patched.record.instrumentedHash);
    expect(changed.actualHash).not.toBe(patched.record.originalHash);
    expect(changed.expectedHash).toBe(patched.record.instrumentedHash);
    expect(changed.originalHash).toBe(patched.record.originalHash);
    expect(changed.recordId).toBe(patched.record.id);
    expect(changed.sessionId).toBe(patched.record.sessionId);
    expect(changed.file).toBe(TARGET_FILE);
    expect(changed.path).toBe(patched.path);
    expect(changed.detectedAt).toBe(FIXED_NOW);
  });

  it('leaves the file byte-identical to what the developer left', async () => {
    const { world, patched, editedBytes, editedHash, verdict } = await patchThenEdit(
      TARGET_FILE,
      FIRST_SYMBOL,
    );

    // The one assertion of the four that catches a detector which "helpfully"
    // restored: every other promise would still look kept.
    expectFileBytes(patched.path, editedBytes);
    expect(digestOf(patched.path)).toBe(editedHash);
    expect(contentChangedVerdictOf(verdict).actualHash).toBe(editedHash);

    // And the developer's line is still the last thing in the file, so the
    // comparison above is not passing on a coincidence of length.
    expect(textOf(readFileSync(patched.path)).endsWith(DEVELOPER_EDIT_LINE)).toBe(true);
    expectDetectionWroteNothing(world);
  });

  it('keeps the recorded original recoverable at the path the report names', async () => {
    const { world, patched, verdict } = await patchThenEdit(TARGET_FILE, FIRST_SYMBOL);
    const backupPath = world.backupPathOf(patched.record.originalHash);

    // The path is composed independently of the record, then compared with it:
    // AAP §0.5.5 quotes this value to the developer, so the report and the
    // filesystem have to agree about where the original is.
    expect(patched.record.backupPath).toBe(backupPath);
    expect(verdict.conflict.backupPath).toBe(backupPath);
    expect(existsSync(backupPath)).toBe(true);

    // Recoverable by hand means recoverable byte for byte, which is the digest
    // it is filed under.
    expectFileBytes(backupPath, patched.originalBytes);
    expect(digestOf(backupPath)).toBe(patched.record.originalHash);

    // And the verdict says so without the caller having to ask the store a
    // second question.
    expect(verdict.backup.available).toBe(true);
    expect(verdict.backup.path).toBe(backupPath);
    expectDetectionWroteNothing(world);
  });

  it('carries a three-way diff whose three views are the three transitions', async () => {
    const { patched, editedBytes, verdict } = await patchThenEdit(TARGET_FILE, FIRST_SYMBOL);

    expectSchemaValidConflict(verdict);
    expect(verdict.omittedDiffs).toEqual([]);

    const original = textOf(patched.originalBytes);
    const instrumented = textOf(patched.instrumentedBytes);
    const current = textOf(editedBytes);

    const originalToInstrumented = viewOf(verdict, 'originalToInstrumented');
    const instrumentedToCurrent = viewOf(verdict, 'instrumentedToCurrent');
    const originalToCurrent = viewOf(verdict, 'originalToCurrent');

    // `diff` 9.0.0 exposes no diff3, so the "three-way" view is three composed
    // two-way patches — and the way to assert a composition is to apply each
    // one to the text it claims to start from. Each of the three below would
    // fail if the module had rendered the right-looking patch between the wrong
    // pair of texts.
    expect(applyView(original, originalToInstrumented)).toBe(instrumented);
    expect(applyView(instrumented, instrumentedToCurrent)).toBe(current);
    expect(applyView(original, originalToCurrent)).toBe(current);

    // The views are genuinely three different things, not one patch repeated.
    expect(new Set([originalToInstrumented, instrumentedToCurrent, originalToCurrent]).size).toBe(
      3,
    );

    // What the tool did: the record's own diff, used verbatim because the
    // patcher rendered it over the exact bytes it hashed.
    expect(originalToInstrumented).toBe(patched.record.diff);
    expect(addedLinesOf(originalToInstrumented).join('\n')).toContain(SPAN_HELPER_GLOBAL);

    // What the developer did, which is the hunk set "Open diff" shows: their
    // line and nothing of the tool's.
    expect(addedLinesOf(instrumentedToCurrent)).toContain(DEVELOPER_EDIT_LINE.trimEnd());
    expect(addedLinesOf(instrumentedToCurrent).join('\n')).not.toContain(SPAN_HELPER_GLOBAL);
    expect(removedLinesOf(instrumentedToCurrent)).toEqual([]);

    // The net divergence: both changes at once.
    expect(addedLinesOf(originalToCurrent)).toContain(DEVELOPER_EDIT_LINE.trimEnd());
    expect(addedLinesOf(originalToCurrent).join('\n')).toContain(SPAN_HELPER_GLOBAL);
  });

  it('carries a report that survives the JSON frame it travels in', async () => {
    const { patched, verdict } = await patchThenEdit(TARGET_FILE, FIRST_SYMBOL);
    const { conflict } = verdict;

    // It rides inside `cleanup.completed` to the DevTools panel and the VS Code
    // webview, so an `Error` instance anywhere in it would arrive as `{}`.
    expect(containsErrorInstance(conflict)).toBe(false);
    expect(JSON.parse(JSON.stringify(conflict))).toEqual(conflict);

    // Everything AAP §0.5.5's message and its "Open diff" action need, present
    // on the object rather than looked up by the receiver.
    expect(conflict.recordId).toBe(patched.record.id);
    expect(conflict.sessionId).toBe(patched.record.sessionId);
    expect(conflict.file).toBe(TARGET_FILE);
    expect(conflict.backupPath).toBe(patched.record.backupPath);
    expect(conflict.expectedHash).toBe(patched.record.instrumentedHash);
    expect(conflict.detectedAt).toBe(FIXED_NOW);
    expect(conflict.message.trim().length).toBeGreaterThan(0);
    expect(conflict.message).toContain(TARGET_FILE);
    expect(conflict.message).toContain(patched.record.backupPath);
  });

  it('uses the developer-facing wording its caller supplies, verbatim', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });

    developerEdits(patched.path);
    world.resetLogs();

    const message = `'${TARGET_FILE}' was edited while instrumented. Debug Generator will not overwrite it. Original saved at '${patched.record.backupPath}'.`;
    const verdict = conflictingVerdictOf(
      verdictOf(await detectConflict(patched.record, contextOf(world, { message }))),
    );

    // The wording of a conflict belongs to the service and the adapters, which
    // know what the developer was doing and can offer the recovery action; the
    // module's own default exists only so a report can never arrive blank.
    expect(verdict.conflict.message).toBe(message);
    expectSchemaValidConflict(verdict);
  });

  it('reports the same conflict again on a second pass, still writing nothing', async () => {
    const { world, patched, editedBytes, verdict } = await patchThenEdit(TARGET_FILE, FIRST_SYMBOL);

    world.resetLogs();

    const second = conflictingVerdictOf(
      verdictOf(await detectConflict(patched.record, contextOf(world))),
    );

    // A conflict is not consumed by being reported: the record stays open, so
    // the next service start reports it again until the developer resolves it.
    expect(second.kind).toBe(verdict.kind);
    expect(second.conflict).toEqual(verdict.conflict);
    expectFileBytes(patched.path, editedBytes);
    expectDetectionWroteNothing(world);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The other four verdicts
 * ---------------------------------------------------------------------------
 *
 * Exactly one verdict authorises a write. The other four authorise nothing, and
 * each has to be distinguishable from both `'restorable'` and the headline
 * conflict: collapsing any of them into either would mean either a lost edit or
 * a file left instrumented with nobody told.
 */

describe('a file that still holds exactly what the tool wrote', () => {
  it('is the one verdict that authorises a restore — and detection still wrote nothing', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });

    world.resetLogs();

    const verdict = restorableVerdictOf(
      verdictOf(await detectConflict(patched.record, contextOf(world))),
    );

    expect(isRestorableVerdict(verdict)).toBe(true);
    expect(isConflictVerdict(verdict)).toBe(false);
    expect(verdict.actualHash).toBe(patched.record.instrumentedHash);
    expect(verdict.expectedHash).toBe(patched.record.instrumentedHash);

    // A restorable verdict is only reached with a *verified* backup, and the
    // verdict narrows to say so, so a caller about to write never has to ask.
    expect(verdict.backup.available).toBe(true);
    expect(verdict.backup.byteLength).toBe(patched.originalBytes.byteLength);
    expect(verdict.backup.path).toBe(patched.record.backupPath);

    // The authorisation is the caller's to act on: this module read the file
    // and the backup and put nothing anywhere.
    expectFileBytes(patched.path, patched.instrumentedBytes);
    expectDetectionWroteNothing(world);
    expect(world.files.log.reads).toEqual([patched.path]);
  });
});

describe('a file that already holds the recorded original', () => {
  it('is reported as nothing to do rather than as a conflict', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });

    // The legitimate post-crash and manual-revert state: the process may have
    // died between the rename and the status update, an earlier pass may have
    // restored the file without closing the record, or the developer may simply
    // have reverted it themselves.
    writeFileSync(patched.path, patched.originalBytes);
    world.resetLogs();

    const verdict = alreadyRevertedVerdictOf(
      verdictOf(await detectConflict(patched.record, contextOf(world))),
    );

    expect(verdict.actualHash).toBe(patched.record.originalHash);
    expect(isRestorableVerdict(verdict)).toBe(false);
    expect(isConflictVerdict(verdict)).toBe(false);
    expectFileBytes(patched.path, patched.originalBytes);
    expectDetectionWroteNothing(world);
  });

  it('stays nothing to do even once its backup has been deleted', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });

    writeFileSync(patched.path, patched.originalBytes);
    unlinkSync(world.backupPathOf(patched.record.originalHash));
    world.resetLogs();

    const verdict = alreadyRevertedVerdictOf(
      verdictOf(await detectConflict(patched.record, contextOf(world))),
    );

    // A backup is only needed to *write* the original back, and the original is
    // already there — so its absence is reported on the verdict without
    // becoming a conflict a developer would have to resolve.
    expect(verdict.backup.available).toBe(false);
    expect(verdict.actualHash).toBe(patched.record.originalHash);
    expectDetectionWroteNothing(world);
  });
});

describe('a file that is no longer there', () => {
  it('is its own verdict, with the original still recoverable and no view of the file', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });

    unlinkSync(patched.path);
    world.resetLogs();

    const verdict = fileMissingVerdictOf(
      verdictOf(await detectConflict(patched.record, contextOf(world))),
    );

    expect(isRestorableVerdict(verdict)).toBe(false);
    expect(isConflictVerdict(verdict)).toBe(true);
    expect(verdict.conflict.reason).toBe('file-missing');
    expectSchemaValidConflict(verdict);

    // No bytes, so no digest: an absent field rather than a blank one, because
    // a blank digest is a value that looks like an answer.
    expect(verdict.conflict.actualHash).toBeUndefined();
    expect(Object.hasOwn(verdict.conflict, 'actualHash')).toBe(false);

    // "Can this be restored at all" is a different question from "does the file
    // still match", and a caller needs both answers at once.
    expect(verdict.backup.available).toBe(true);
    expectFileBytes(world.backupPathOf(patched.record.originalHash), patched.originalBytes);

    // What the tool did is still reportable; the two views that need the file
    // are omitted rather than approximated.
    expect(viewOf(verdict, 'originalToInstrumented')).toBe(patched.record.diff);
    expect(omissionOf(verdict, 'instrumentedToCurrent')).toBe('text-unavailable');
    expect(omissionOf(verdict, 'originalToCurrent')).toBe('text-unavailable');
    expect(existsSync(patched.path)).toBe(false);
    expectDetectionWroteNothing(world);
  });
});

describe('a recorded original that cannot be read back', () => {
  it('surfaces the record instead of closing it when the backup is gone', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });
    const backupPath = world.backupPathOf(patched.record.originalHash);

    unlinkSync(backupPath);
    world.resetLogs();

    const verdict = backupUnavailableVerdictOf(
      verdictOf(await detectConflict(patched.record, contextOf(world))),
    );

    // The content on disk is ours, but there is nothing verified to write back,
    // so the file is left instrumented and the developer is told — never
    // "restored" from content nobody could check.
    expect(verdict.actualHash).toBe(patched.record.instrumentedHash);
    expect(isRestorableVerdict(verdict)).toBe(false);
    expect(verdict.conflict.reason).toBe('backup-missing');
    expect(verdict.backup.available).toBe(false);
    expect(verdict.backup.reason).toBe('missing');
    expect(BACKUP_UNAVAILABLE_REASONS).toContain(verdict.backup.reason);
    expect(verdict.conflict.backupPath).toBe(backupPath);
    expectSchemaValidConflict(verdict);
    expectFileBytes(patched.path, patched.instrumentedBytes);
    expectDetectionWroteNothing(world);
  });

  it('refuses to trust a backup whose bytes no longer hash to its own name', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });
    const backupPath = world.backupPathOf(patched.record.originalHash);
    const corrupted = Buffer.from('this is not the original content of the file\n', 'utf8');

    writeFileSync(backupPath, corrupted);
    world.resetLogs();

    const verdict = backupUnavailableVerdictOf(
      verdictOf(await detectConflict(patched.record, contextOf(world))),
    );

    // A backup that cannot be trusted must never be written over a developer's
    // file, which is why verification failure is a distinct reason from absence
    // and not merely "no backup".
    expect(verdict.backup.available).toBe(false);
    expect(verdict.backup.reason).toBe('digest-mismatch');
    expect(verdict.backup.detail).toBe(sha256Hex(corrupted));
    expect(verdict.conflict.reason).toBe('backup-missing');
    expectSchemaValidConflict(verdict);

    // Neither copy was touched: the corrupt backup is still the only copy of
    // whatever it holds, and the project file is still instrumented.
    expectFileBytes(backupPath, corrupted);
    expectFileBytes(patched.path, patched.instrumentedBytes);
    expectDetectionWroteNothing(world);
  });
});

describe('a recorded original the journal says was moved', () => {
  /** The warning a record whose path the store would not open produces. */
  const SUBSTITUTED_WARNING = 'a record names a backup path this store would not compose';

  /**
   * `<debuggenHome>/backups/<sessionId>/quarantine`, private like the rest of
   * the tree: a subdirectory of the session's own directory, the one place a
   * relocation is honoured.
   */
  function quarantineOf(world: World): string {
    const quarantine = join(world.debuggenHome, 'backups', world.sessionId, 'quarantine');

    mkdirSync(quarantine, { recursive: true, mode: 0o700 });
    chmodSync(quarantine, 0o700);

    return quarantine;
  }

  it('is read from where the record says it is, and authorises the restore', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });
    const relocated = join(quarantineOf(world), patched.record.originalHash);

    renameSync(world.backupPathOf(patched.record.originalHash), relocated);
    const record: ModificationRecord = { ...patched.record, backupPath: relocated };
    world.resetLogs();

    const verdict = restorableVerdictOf(verdictOf(await detectConflict(record, contextOf(world))));

    // Nothing is at the composed path, so a read by digest would have called
    // this backup missing and turned a restorable record into a conflict.
    expect(existsSync(world.backupPathOf(patched.record.originalHash))).toBe(false);
    expect(verdict.backup.available).toBe(true);
    expect(verdict.backup.path).toBe(relocated);
    expect(verdict.backup.byteLength).toBe(patched.originalBytes.byteLength);
    expect(world.backups.log.recordedPaths).toContain(relocated);
    expect(world.logs.records.some((entry) => entry.message === SUBSTITUTED_WARNING)).toBe(false);

    expectFileBytes(relocated, patched.originalBytes);
    expectDetectionWroteNothing(world);
  });

  it('is not trusted when a directory above it is a symbolic link', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });
    const elsewhere = join(world.root, 'elsewhere');

    mkdirSync(elsewhere, { mode: 0o700 });
    chmodSync(elsewhere, 0o700);
    renameSync(
      world.backupPathOf(patched.record.originalHash),
      join(elsewhere, patched.record.originalHash),
    );

    const linked = join(world.debuggenHome, 'backups', world.sessionId, 'quarantine');
    symlinkSync(elsewhere, linked, 'dir');

    const relocated = join(linked, patched.record.originalHash);
    const record: ModificationRecord = { ...patched.record, backupPath: relocated };
    world.resetLogs();

    const verdict = backupUnavailableVerdictOf(
      verdictOf(await detectConflict(record, contextOf(world))),
    );

    // The walk from the state root down refused the linked directory before
    // anything below it was opened.
    expect(verdict.backup.available).toBe(false);
    expect(verdict.backup.reason).toBe('unreadable');
    expect(verdict.backup.detail).toBe('symlink-component');
    expect(verdict.backup.path).toBe(relocated);
    expect(verdict.conflict.reason).toBe('backup-missing');
    expectSchemaValidConflict(verdict);
    expectFileBytes(patched.path, patched.instrumentedBytes);
    expectDetectionWroteNothing(world);
  });

  it('falls back to the store’s own location for a path outside the backup tree, and says so', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });
    const foreign = join(world.root, 'another-home', 'backups', 'ses_other', 'original');
    const decoy = Buffer.from('export const decoy = true;\n', 'utf8');

    mkdirSync(dirname(foreign), { recursive: true });
    writeFileSync(foreign, decoy);
    const record: ModificationRecord = { ...patched.record, backupPath: foreign };
    world.resetLogs();

    const verdict = restorableVerdictOf(verdictOf(await detectConflict(record, contextOf(world))));

    // The composed backup was read and verified; the foreign path was never
    // opened, so its bytes could not have been mistaken for the original.
    expect(verdict.backup.available).toBe(true);
    expect(verdict.backup.byteLength).toBe(patched.originalBytes.byteLength);
    expect(verdict.backup.path).toBe(foreign);

    const warnings = world.logs.records.filter((entry) => entry.message === SUBSTITUTED_WARNING);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields['recordedPath']).toBe(foreign);
    expect(warnings[0]?.fields['storePath']).toBe(world.backupPathOf(patched.record.originalHash));

    expectFileBytes(foreign, decoy);
    expectDetectionWroteNothing(world);
  });

  it('does not read a backup moved into another session’s directory, and says so', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });
    const digest = patched.record.originalHash;

    // Moved into a neighbour session's quarantine under the same state root:
    // inside the backup tree, named by the digest, and still not this
    // session's to read — one session's record never reaches another's backups.
    const neighbour = join(world.debuggenHome, 'backups', 'ses_neighbour', 'quarantine');
    mkdirSync(neighbour, { recursive: true, mode: 0o700 });
    chmodSync(neighbour, 0o700);

    const moved = join(neighbour, digest);
    renameSync(world.backupPathOf(digest), moved);
    const record: ModificationRecord = { ...patched.record, backupPath: moved };
    world.resetLogs();

    const verdict = backupUnavailableVerdictOf(
      verdictOf(await detectConflict(record, contextOf(world))),
    );

    // The store's own location was consulted instead, and it is empty.
    expect(verdict.backup.available).toBe(false);
    expect(verdict.backup.reason).toBe('missing');
    expect(verdict.conflict.reason).toBe('backup-missing');
    expectSchemaValidConflict(verdict);

    const warnings = world.logs.records.filter((entry) => entry.message === SUBSTITUTED_WARNING);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields['recordedPath']).toBe(moved);
    expect(warnings[0]?.fields['storePath']).toBe(world.backupPathOf(digest));

    expectFileBytes(moved, patched.originalBytes);
    expectFileBytes(patched.path, patched.instrumentedBytes);
    expectDetectionWroteNothing(world);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The refusals: questions that cannot be answered
 * ---------------------------------------------------------------------------
 */

describe('a record whose file is not inside the project', () => {
  for (const escape of ESCAPING_FILES) {
    it(`is refused before anything is read: '${escape}'`, async () => {
      const world = makeWorld();
      const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });

      // Planted where '../escaped.ts' resolves to, holding a real declaration,
      // so a detector that escaped the project would actually read this file
      // and the byte comparison below would catch it.
      const external = join(world.root, 'escaped.ts');

      writeFileSync(external, EXTERNAL_CONTENT);
      world.resetLogs();

      // The record is real in every other respect — only `file` escapes, which
      // is the shape a malformed or hand-edited journal row would have. The
      // record schema rejects such a path, so it is spelled here directly.
      const escaping: ModificationRecord = { ...patched.record, file: escape };
      const error = refusalOf(await detectConflict(escaping, contextOf(world)));

      expect(error).toBeInstanceOf(DebuggenError);
      expect(error.code).toBe('PATH_OUTSIDE_PROJECT');
      expect(['unsafe-relative-path', 'outside-project-root']).toContain(error.details?.reason);

      // Nothing was read, hashed or located: containment is checked first, so
      // the backup store was never even asked to compose a path.
      expect(world.files.log.reads).toEqual([]);
      expect(world.files.log.hashedByteLengths).toEqual([]);
      expect(world.backups.log.locates).toEqual([]);
      expect(world.backups.log.reads).toEqual([]);
      expectDetectionWroteNothing(world);

      // And both files are exactly as they were.
      expectFileBytes(external, Buffer.from(EXTERNAL_CONTENT, 'utf8'));
      expectFileBytes(patched.path, patched.instrumentedBytes);
    });
  }
});

describe('a backup store belonging to another session', () => {
  it('is refused rather than allowed to report an intact backup as missing', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });
    const otherSession = createBackupStore({
      debuggenHome: world.debuggenHome,
      sessionId: newSessionId(),
    });

    world.resetLogs();

    const error = refusalOf(
      await detectConflict(patched.record, contextOf(world, { backups: otherSession })),
    );

    // The one failure mode that would turn this module's caution into a false
    // alarm: a store scoped elsewhere composes paths under another session's
    // directory, so every lookup would miss and a restorable record would be
    // reported as a conflict.
    expect(error.code).toBe('STORE_ERROR');
    expect(error.details?.reason).toBe('backup-store-session-mismatch');
    expectDetectionWroteNothing(world);
  });
});

describe('a target that cannot be read at all', () => {
  it('reports the errno and treats nothing as decided', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });

    world.resetLogs();

    const denied: ConflictFileReader = {
      readFileBytes: () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
      hashBytes: defaultConflictFileReader.hashBytes,
    };

    const error = refusalOf(
      await detectConflict(patched.record, contextOf(world, { files: denied })),
    );

    // Neither a verdict nor a guess: an unreadable file is a question that
    // cannot be answered, and the record stays open for the next pass.
    expect(error.code).toBe('INTERNAL');
    expect(error.details?.errno).toBe('EACCES');
    expectFileBytes(patched.path, patched.instrumentedBytes);
    expectDetectionWroteNothing(world);
  });

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a symbolic link planted at the target instead of reading through it',
    async () => {
      const world = makeWorld();
      const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });
      const external = join(world.root, 'linked.ts');

      writeFileSync(external, EXTERNAL_CONTENT);
      unlinkSync(patched.path);
      symlinkSync(external, patched.path);
      world.resetLogs();

      const error = refusalOf(await detectConflict(patched.record, contextOf(world)));

      // `resolveWithinProject` is pure string work and cannot see a link, so
      // the no-follow read is what stands between a planted link and
      // attacker-chosen bytes being compared against a recorded digest.
      expect(error.code).toBe('FS_UNSAFE_PATH');
      expect(error.details?.reason).toBe('symlink-at-target');
      expectFileBytes(external, Buffer.from(EXTERNAL_CONTENT, 'utf8'));
      expectDetectionWroteNothing(world);
    },
  );
});

/*
 * ---------------------------------------------------------------------------
 * Byte-level strictness
 * ---------------------------------------------------------------------------
 *
 * The cheapest and highest-value cases in this file. A detector that normalised
 * whitespace, stripped a carriage return or decoded to text before comparing
 * looks perfectly correct on every case above and silently discards a
 * developer's work on the two below — and `packages/shared/src/node/hash.test.ts`
 * already pins that CRLF and LF content hash differently, so a normalising
 * comparison could only have been introduced here.
 *
 * Both variants are built by manipulating **raw bytes**, never by re-writing a
 * decoded string with a different newline setting: a helper that decoded would
 * be making the same mistake it is meant to catch.
 */

describe('a change to whitespace alone', () => {
  it('conflicts when only the trailing newline is removed', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });

    // The premise: the patcher left a final newline, so dropping exactly one
    // byte is a change no diff viewer would show as content.
    expect(patched.instrumentedBytes[patched.instrumentedBytes.byteLength - 1]).toBe(0x0a);

    const shortened = Buffer.from(
      patched.instrumentedBytes.subarray(0, patched.instrumentedBytes.byteLength - 1),
    );

    writeFileSync(patched.path, shortened);
    world.resetLogs();

    const verdict = contentChangedVerdictOf(
      verdictOf(await detectConflict(patched.record, contextOf(world))),
    );

    // One byte is a conflict, and the verdict says which digest it is not.
    expect(verdict.actualHash).toBe(sha256Hex(shortened));
    expect(verdict.actualHash).not.toBe(patched.record.instrumentedHash);
    expect(isRestorableVerdict(verdict)).toBe(false);
    expect(verdict.conflict.reason).toBe('content-changed');

    // The rendered view has to *show* the change too: a patch produced with
    // `ignoreWhitespace` or `stripTrailingCr` would come back empty and be
    // reported as 'no-differences', which would contradict the digest that
    // refused the write.
    expect(omissionOf(verdict, 'instrumentedToCurrent')).toBeUndefined();
    expect(viewOf(verdict, 'instrumentedToCurrent')).toContain('\\ No newline at end of file');

    expectFileBytes(patched.path, shortened);
    expectDetectionWroteNothing(world);
  });

  it('conflicts when line feeds are converted to carriage-return pairs', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });
    const converted = toCarriageReturnLineFeed(patched.instrumentedBytes);

    // The premise: the conversion added a byte per line and changed nothing a
    // reader would call content.
    expect(converted.byteLength).toBeGreaterThan(patched.instrumentedBytes.byteLength);
    expect(textOf(converted).split('\r\n').length).toBe(
      textOf(patched.instrumentedBytes).split('\n').length,
    );

    writeFileSync(patched.path, converted);
    world.resetLogs();

    const verdict = contentChangedVerdictOf(
      verdictOf(await detectConflict(patched.record, contextOf(world))),
    );

    expect(verdict.actualHash).toBe(sha256Hex(converted));
    expect(verdict.actualHash).not.toBe(patched.record.instrumentedHash);
    expect(isRestorableVerdict(verdict)).toBe(false);
    expect(verdict.conflict.reason).toBe('content-changed');

    // And the view is rendered over the bytes as they are, so applying it to
    // the instrumented text reproduces the CRLF file exactly.
    expect(
      applyView(textOf(patched.instrumentedBytes), viewOf(verdict, 'instrumentedToCurrent')),
    ).toBe(textOf(converted));

    expectFileBytes(patched.path, converted);
    expectDetectionWroteNothing(world);
  });
});

describe('a file holding bytes that are not valid UTF-8', () => {
  it('is still judged correctly, and the views that would need text are omitted', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });

    // `0xff` never appears in valid UTF-8, and `0x80` is a continuation byte
    // with nothing to continue: a strict decoder refuses both.
    const invalid = Buffer.concat([
      patched.instrumentedBytes,
      Buffer.from([0xff, 0xfe, 0x80, 0x0a]),
    ]);

    writeFileSync(patched.path, invalid);
    world.resetLogs();

    const verdict = contentChangedVerdictOf(
      verdictOf(await detectConflict(patched.record, contextOf(world))),
    );

    // The verdict comes from SHA-256 over raw bytes, so it is unaffected — a
    // decode-then-compare implementation would have thrown or lost the
    // difference in replacement characters instead.
    expect(verdict.actualHash).toBe(sha256Hex(invalid));
    expect(verdict.conflict.reason).toBe('content-changed');

    // Only the *explanatory* patch is dropped, and the report says which view
    // and why rather than describing lines that do not exist in the file.
    expect(omissionOf(verdict, 'instrumentedToCurrent')).toBe('not-utf8');
    expect(omissionOf(verdict, 'originalToCurrent')).toBe('not-utf8');
    for (const omission of verdict.omittedDiffs) {
      expect(CONFLICT_DIFF_OMISSION_REASONS).toContain(omission.reason);
      expect(CONFLICT_DIFF_VIEWS).toContain(omission.view);
    }

    expect(viewOf(verdict, 'originalToInstrumented')).toBe(patched.record.diff);
    expectSchemaValidConflict(verdict);
    expectFileBytes(patched.path, invalid);
    expectDetectionWroteNothing(world);
  });
});

describe('a plain-JavaScript target', () => {
  it('is judged by the same byte comparison, with no type alias in its patch', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: JS_FILE, symbol: JS_SYMBOL });

    // The two language variants of the template differ, and the shorter one
    // must not change the decision: `.js` files carry no helper type alias.
    expect(patched.outcome.patch.language).toBe('javascript');
    expect(patched.outcome.patch.helperTypeAliasInserted).toBe(false);
    expect(patched.record.diff).not.toContain(SPAN_HELPER_TYPE_NAME);

    world.resetLogs();

    expect(
      restorableVerdictOf(verdictOf(await detectConflict(patched.record, contextOf(world))))
        .actualHash,
    ).toBe(patched.record.instrumentedHash);

    const editedBytes = developerEdits(patched.path);

    world.resetLogs();

    const verdict = contentChangedVerdictOf(
      verdictOf(await detectConflict(patched.record, contextOf(world))),
    );

    expect(verdict.actualHash).toBe(sha256Hex(editedBytes));
    expect(addedLinesOf(viewOf(verdict, 'instrumentedToCurrent'))).toContain(
      DEVELOPER_EDIT_LINE.trimEnd(),
    );
    expectFileBytes(patched.path, editedBytes);
    expectDetectionWroteNothing(world);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Chains across plan versions
 * ---------------------------------------------------------------------------
 *
 * A follow-up question produces plan version n + 1 as the previous plan plus
 * additive actions (AAP §0.4.2), so one file can carry two records: the second
 * one's `originalHash` is the first one's `instrumentedHash`, and its backup
 * holds *already-instrumented* bytes. Judging each record against **its own**
 * recorded output is what makes cleanup's strict reverse-order unwind correct —
 * and a detector that compared against "the original" would report a false
 * conflict for every chained record and never unwind anything.
 */

/** A two-version chain over one file, both patches applied. */
interface Chain {
  /** The world both patches happened in. */
  readonly world: World;

  /** Plan version 1: the first symbol wrapped. */
  readonly first: PatchedFile;

  /** Plan version 2: the second symbol wrapped, on top of the first patch. */
  readonly second: PatchedFile;
}

/** Applies plan version 1 and then plan version 2 to {@link TARGET_FILE}. */
async function makeChain(): Promise<Chain> {
  const world = makeWorld();
  const first = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL, planVersion: 1 });
  const second = await world.patch({ file: TARGET_FILE, symbol: SECOND_SYMBOL, planVersion: 2 });

  return { world, first, second };
}

describe('a chain of plan versions over one file', () => {
  it('links the later record to the earlier one through the hash it replaced', async () => {
    const { world, first, second } = await makeChain();

    expect(second.record.previousRecordId).toBe(first.record.id);
    expect(second.record.originalHash).toBe(first.record.instrumentedHash);
    expect(second.record.planVersion).toBe(2);
    expect(first.record.previousRecordId).toBeUndefined();

    // Two backups, filed under the two digests: the pristine file and the
    // version-1 output. Both have to survive, because the unwind writes them
    // in reverse order.
    expectFileBytes(world.backupPathOf(first.record.originalHash), first.originalBytes);
    expectFileBytes(world.backupPathOf(second.record.originalHash), first.instrumentedBytes);
  });

  it('judges each record against its own instrumented hash, not against the original', async () => {
    const { world, first, second } = await makeChain();

    world.resetLogs();

    // The tip of the chain matches what it wrote, so it is restorable: this is
    // the step a reverse-order unwind performs first.
    const tip = restorableVerdictOf(
      verdictOf(await detectConflict(second.record, contextOf(world))),
    );

    expect(tip.actualHash).toBe(second.record.instrumentedHash);
    expect(tip.expectedHash).toBe(second.record.instrumentedHash);
    expect(tip.originalHash).toBe(first.record.instrumentedHash);

    // The earlier record is *not* restorable while the later patch is still on
    // disk, which is precisely what stops an unwind from skipping a step. A
    // detector comparing against "the original" would have called this
    // restorable and written version 1's backup over version 2's content.
    const earlier = verdictOf(await detectConflict(first.record, contextOf(world)));

    expect(isRestorableVerdict(earlier)).toBe(false);
    expect(earlier.kind).toBe('content-changed');

    const changed = contentChangedVerdictOf(earlier);

    expect(changed.actualHash).toBe(second.record.instrumentedHash);
    expect(changed.expectedHash).toBe(first.record.instrumentedHash);
    expectSchemaValidConflict(changed);

    // The report for the earlier record still explains itself in full: its own
    // instrumented text is reconstructed from its own backup and diff, so the
    // instrumented→current view is exactly the later version's delta.
    expect(
      applyView(textOf(first.instrumentedBytes), viewOf(changed, 'instrumentedToCurrent')),
    ).toBe(textOf(second.instrumentedBytes));

    expectFileBytes(first.path, second.instrumentedBytes);
    expectDetectionWroteNothing(world);
  });

  it('halts at the tip when a developer edit lands on top of the chain', async () => {
    const { world, first, second } = await makeChain();
    const editedBytes = developerEdits(second.path);

    world.resetLogs();

    // Cleanup unwinds last-applied-first, so the tip is the record it consults
    // first — and a conflict there stops the whole chain rather than letting it
    // unwind through an edited file.
    const tip = contentChangedVerdictOf(
      verdictOf(await detectConflict(second.record, contextOf(world))),
    );

    expect(tip.actualHash).toBe(sha256Hex(editedBytes));
    expect(tip.conflict.reason).toBe('content-changed');
    expect(tip.conflict.recordId).toBe(second.record.id);
    expect(addedLinesOf(viewOf(tip, 'instrumentedToCurrent'))).toContain(
      DEVELOPER_EDIT_LINE.trimEnd(),
    );

    // The earlier record is no more restorable than it was, so neither link
    // authorises a write.
    expect(
      isRestorableVerdict(verdictOf(await detectConflict(first.record, contextOf(world)))),
    ).toBe(false);

    expectFileBytes(second.path, editedBytes);
    expectFileBytes(world.backupPathOf(first.record.originalHash), first.originalBytes);
    expectFileBytes(world.backupPathOf(second.record.originalHash), first.instrumentedBytes);
    expectDetectionWroteNothing(world);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Bounds
 * ---------------------------------------------------------------------------
 */

describe('a divergence too large to render', () => {
  it('omits the oversized view rather than embedding an unbounded patch', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });

    // Sized off the module's own exported cap rather than a magic number, so
    // this case follows the bound if the bound ever moves. One enormous line
    // is enough: the renderer is line-wise, so the patch it produces is at
    // least as long as the line it has to carry.
    const oversized = Buffer.concat([
      patched.instrumentedBytes,
      Buffer.from(`// ${'k'.repeat(CONFLICT_DIFF_CHARACTER_LIMIT)}\n`, 'utf8'),
    ]);

    writeFileSync(patched.path, oversized);
    world.resetLogs();

    const verdict = contentChangedVerdictOf(
      verdictOf(await detectConflict(patched.record, contextOf(world))),
    );

    // The verdict is unaffected: it comes from a digest over raw bytes, which
    // has no size bound at all.
    expect(verdict.actualHash).toBe(sha256Hex(oversized));
    expect(verdict.conflict.reason).toBe('content-changed');

    // The conflict shape carries no truncation flag, so the two views that
    // would have been oversized are left out and accounted for — an absent
    // view reads honestly as "nothing to show here", while a clipped one
    // would claim to be the whole change.
    expect(omissionOf(verdict, 'instrumentedToCurrent')).toBe('exceeds-length-limit');
    expect(omissionOf(verdict, 'originalToCurrent')).toBe('exceeds-length-limit');
    expect(verdict.conflict.diffs?.instrumentedToCurrent).toBeUndefined();
    expect(verdict.conflict.diffs?.originalToCurrent).toBeUndefined();

    // What the tool did still fits, and every view that *was* delivered is
    // within the bound the transport enforces.
    expect(viewOf(verdict, 'originalToInstrumented')).toBe(patched.record.diff);
    for (const view of CONFLICT_DIFF_VIEWS) {
      expect(verdict.conflict.diffs?.[view]?.length ?? 0).toBeLessThanOrEqual(
        CONFLICT_DIFF_CHARACTER_LIMIT,
      );
    }

    // And the omission is stated in words as well, because the developer
    // reading the report has no other way to learn a view is missing.
    expect(verdict.conflict.message).toContain(String(CONFLICT_DIFF_CHARACTER_LIMIT));
    expect(verdict.conflict.message).toContain('omitted');

    // The report is still deliverable, which is the point of the bound: the
    // schema would reject an over-cap member outright.
    expectSchemaValidConflict(verdict);
    expectFileBytes(patched.path, oversized);
    expectDetectionWroteNothing(world);
  }, 30_000);
});

/*
 * ---------------------------------------------------------------------------
 * Hygiene: what detection must not do
 * ---------------------------------------------------------------------------
 */

describe('detection as a read-only operation', () => {
  it('never moves a record’s status, whatever it decides', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });

    world.resetLogs();

    // Every verdict that can be reached for one record, in one pass, so the
    // negative below covers the whole decision table rather than one branch.
    expect(
      restorableVerdictOf(verdictOf(await detectConflict(patched.record, contextOf(world)))).kind,
    ).toBe('restorable');

    writeFileSync(patched.path, patched.originalBytes);
    expect(verdictOf(await detectConflict(patched.record, contextOf(world))).kind).toBe(
      'already-reverted',
    );

    developerEdits(patched.path);
    expect(verdictOf(await detectConflict(patched.record, contextOf(world))).kind).toBe(
      'content-changed',
    );

    unlinkSync(patched.path);
    expect(verdictOf(await detectConflict(patched.record, contextOf(world))).kind).toBe(
      'file-missing',
    );

    // Status transitions belong to `../cleanup.ts` and `./patcher.ts`.
    // `detectConflict` takes no journal at all and must therefore have reached
    // neither method — and it read the backup without ever writing one.
    expect(world.journal.updateStatus).not.toHaveBeenCalled();
    expect(world.journal.append).not.toHaveBeenCalled();
    expect(world.journal.rows).toHaveLength(1);
    expect(world.journal.rows[0]?.status).toBe('applied');
    expect(world.backups.log.reads.length).toBeGreaterThan(0);
    expectDetectionWroteNothing(world);
  });

  it('logs paths, digests, ids and reasons — never a byte of file content', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });
    const backupPath = world.backupPathOf(patched.record.originalHash);

    world.resetLogs();

    // Walk every branch that logs, including the two `debug` lines the restore
    // and no-op paths emit: a threshold that dropped half of them would make
    // this assertion pass by not looking.
    await detectConflict(patched.record, contextOf(world));

    writeFileSync(patched.path, patched.originalBytes);
    await detectConflict(patched.record, contextOf(world));

    writeFileSync(patched.path, patched.instrumentedBytes);
    writeFileSync(backupPath, Buffer.from('not the original\n', 'utf8'));
    await detectConflict(patched.record, contextOf(world));

    writeFileSync(backupPath, patched.originalBytes);
    developerEdits(patched.path);
    await detectConflict(patched.record, contextOf(world));

    unlinkSync(patched.path);
    await detectConflict(patched.record, contextOf(world));

    // The logger is genuinely wired up, so the scan below is not vacuous.
    expect(world.logs.records.length).toBeGreaterThan(0);
    expect(
      world.logs.records.some(
        (record) =>
          record.fields['recordId'] === patched.record.id && record.fields['file'] === TARGET_FILE,
      ),
    ).toBe(true);

    const serialized = world.logs.records.map((record) =>
      JSON.stringify({ message: record.message, fields: record.fields, name: record.name }),
    );

    // A developer's source is their own (AAP §0.5.2), and a log line is
    // persisted, forwarded and rendered. Four markers: the two the patch
    // template writes into the file, a token from the pristine source, and the
    // developer's own edit.
    for (const line of serialized) {
      expect(line).not.toContain(SPAN_HELPER_GLOBAL);
      expect(line).not.toContain(SPAN_HELPER_TYPE_NAME);
      expect(line).not.toContain(PRISTINE_SOURCE_TOKEN);
      expect(line).not.toContain(DEVELOPER_EDIT_LINE.trim());
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * The report composer
 * ---------------------------------------------------------------------------
 *
 * `buildConflictReport` is the one part of this module `detectConflict` cannot
 * exercise on its own: `'restore-verification-failed'` only becomes true after
 * a restore has been written, which a read-only detector can never observe.
 * `../cleanup.ts` composes that report through this function so every conflict
 * a developer sees arrives in one shape, under one bounding policy, having
 * passed one validation.
 */

/** The report of a successful composition, or a failed test naming the refusal. */
function reportOf(result: Result<ModificationConflict>): ModificationConflict {
  if (isErr(result)) {
    throw new Error(
      `Expected a conflict report, received ${result.error.code}: ${result.error.message} ${JSON.stringify(result.error.details)}`,
    );
  }

  return result.value;
}

describe('composing a report for a failure only a writer can see', () => {
  it('validates it, and drops a view past the cap rather than shortening it', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });
    const message = 'The restored content did not hash to the recorded original.';

    const report = reportOf(
      buildConflictReport({
        record: patched.record,
        reason: 'restore-verification-failed',
        detectedAt: FIXED_NOW,
        actualHash: patched.record.instrumentedHash,
        message,
        diffs: {
          originalToInstrumented: patched.record.diff,
          // Two members the bound must treat differently: one past the cap, and
          // one empty — an empty string says nothing an absent member does not
          // say better.
          instrumentedToCurrent: 'x'.repeat(CONFLICT_DIFF_CHARACTER_LIMIT + 1),
          originalToCurrent: '',
        },
      }),
    );

    expect(modificationConflictSchema.safeParse(report).success).toBe(true);
    expect(report.reason).toBe('restore-verification-failed');
    expect(MODIFICATION_CONFLICT_REASONS).toContain(report.reason);
    expect(report.message).toBe(message);
    expect(report.recordId).toBe(patched.record.id);
    expect(report.backupPath).toBe(patched.record.backupPath);
    expect(report.diffs?.originalToInstrumented).toBe(patched.record.diff);
    expect(report.diffs?.instrumentedToCurrent).toBeUndefined();
    expect(report.diffs?.originalToCurrent).toBeUndefined();
    expect(containsErrorInstance(report)).toBe(false);
  });

  it('refuses a report with nothing to show the developer', async () => {
    const world = makeWorld();
    const patched = await world.patch({ file: TARGET_FILE, symbol: FIRST_SYMBOL });

    const result = buildConflictReport({
      record: patched.record,
      reason: 'restore-verification-failed',
      detectedAt: FIXED_NOW,
      message: '   \n  ',
    });

    // A blank row in the VS Code `ModificationsList` would be a conflict the
    // developer is never told about, which is the failure the whole module
    // exists to prevent.
    if (!isErr(result)) {
      throw new Error(`Expected a blank message to be refused, received ${result.value.message}`);
    }

    expect(result.error).toBeInstanceOf(DebuggenError);
    expect(result.error.code).toBe('INTERNAL');
    expect(result.error.details?.reason).toBe('blank-conflict-message');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The committed fixture
 * ---------------------------------------------------------------------------
 */

describe('the committed fixture project', () => {
  it('is byte-identical to what it was before this file ran', () => {
    // The real patcher writes real bytes in every case above, so the one thing
    // that must never happen is a case addressing the committed fixture instead
    // of its own `mkdtemp` copy of it. This is the cheapest possible guard, and
    // it is what keeps `git status --porcelain packages/instrumentation` empty.
    expect(digestOfFixtureTree()).toBe(FIXTURE_TREE_DIGEST);
    expect(existsSync(join(FIXTURE_PROJECT, TARGET_FILE))).toBe(true);
    expect(readFileSync(join(FIXTURE_PROJECT, TARGET_FILE), 'utf8')).not.toContain(
      SPAN_HELPER_GLOBAL,
    );
    expect(readFileSync(join(FIXTURE_PROJECT, JS_FILE), 'utf8')).not.toContain(SPAN_HELPER_GLOBAL);
  });
});
