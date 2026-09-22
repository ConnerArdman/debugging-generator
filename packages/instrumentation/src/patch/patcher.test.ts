/**
 * Tests for `./patcher.ts`: the one sequence in this product that puts bytes
 * into a developer's working tree.
 *
 * Everything else in the monorepo observes. This module writes, and the promise
 * attached to that (AAP §0.5.1) is absolute: whatever happens, the file either
 * comes back byte-for-byte or is left untouched and reported. Two of the ways
 * that promise can be broken are not crashes at all, and they are what most of
 * this file is about.
 *
 * 1. **A path that leaves the project (CWE-22).** `resolveWithinProject` is
 *    pure string work and cannot see a symbolic link; `O_NOFOLLOW` constrains a
 *    path's *final* component only, because the kernel resolves every interior
 *    component before the flag applies. A `src/vendor` inside the project that
 *    links to `/etc` therefore satisfies both — and a sequence that stopped
 *    there would read, back up, journal and overwrite a file outside the
 *    project the tool was pointed at. The refusal has to happen before any of
 *    that, which is what `describe('a symbolic link among the target path
 *    components')` asserts: not merely that the call fails, but that **no I/O
 *    happened outside the project at all** — no read, no backup, no journal
 *    row, no write, and the external file byte-identical afterwards.
 *
 * 2. **A developer saving the file mid-sequence (CWE-367).** Between the read
 *    that produces `originalHash` and the rename that installs the patch sit a
 *    parse, a transform, two digests, a durable backup and a journal append. A
 *    developer can save the same file in that window, and an unconditional
 *    `rename` cannot fail: it discards their edit with no trace, and leaves a
 *    record claiming an `originalHash` for bytes they never had — so a later
 *    "restore" would write content the developer never wrote. The write is
 *    therefore conditional on the bytes *and* the inode that were read, and
 *    `describe('a developer edit racing the write')` drives exactly that race
 *    through the stage observer.
 *
 * Three habits here are deliberate.
 *
 * - **The real patcher, the real backup store, the real transform, real
 *   files.** Nothing about the write path is stubbed: each case copies the
 *   committed fixture project into a fresh `mkdtemp` directory with its own
 *   temporary `$DEBUGGEN_HOME`, and assertions are made against the bytes on
 *   disk. Only the journal is in memory — the service implements that port over
 *   `node:sqlite` and this package never opens a database.
 * - **Byte comparison, not just digests.** A restored or preserved file is
 *   compared with `Buffer.compare` at least once per block as well as by
 *   SHA-256, so a mistake in hashing cannot mask a mistake in content.
 * - **The filesystem port is wrapped, never replaced.** `recordingFileSystem`
 *   delegates to the production primitives and records every path they were
 *   asked about, which is how "performed no I/O outside the project" becomes an
 *   assertion rather than an inference.
 *
 * ## What this suite does not yet cover
 *
 * AAP §0.5.1 additionally requires a **fresh-process** failure-injection matrix
 * — a child killed at each boundary, then the real reconciliation from
 * `../cleanup.ts` asserting byte identity. `../cleanup.ts` does not exist yet,
 * so that half cannot be written against it; the stage observer below drives
 * the same boundaries in-process (it is what `PatchStageObserver` is for), and
 * every case asserts the *state a reconciliation would read*: which record
 * status is on file, and whether the file's digest equals `originalHash`,
 * `instrumentedHash` or neither. When `../cleanup.ts` lands, the matrix is
 * added here and replaces those state assertions with end-to-end restoration.
 */

import { Buffer } from 'node:buffer';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DebuggenError, err, isErr, isOk, newSessionId, ok } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';
import { atomicReplaceFileIfUnchanged, sha256Hex } from '@debuggen/shared/node';

import type {
  ModificationJournal,
  ModificationRecord,
  ModificationStatus,
  ModificationStatusPatch,
} from '../schema/modification.js';

import { createBackupStore } from './backup-store.js';
import type { BackupStore } from './backup-store.js';
import { PATCH_STAGES, createPatcher, defaultPatchFileSystem } from './patcher.js';
import type {
  PatchFileSystem,
  PatchOutcome,
  PatchStage,
  PatchStageEvent,
  Patcher,
} from './patcher.js';

/*
 * ---------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------
 */

/**
 * The committed fixture project every case copies.
 *
 * Resolved from `import.meta.url` rather than `process.cwd()`: this package's
 * Vitest project runs from the repository root, and a relative path would
 * resolve there instead of beside this file.
 */
const FIXTURE_PROJECT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'fixtures',
  'project-a',
);

/** The fixture file every case patches, project-relative POSIX. */
const TARGET_FILE = 'src/server/cone-rules.ts';

/** A named declaration in {@link TARGET_FILE} the transform can wrap. */
const TARGET_SYMBOL = 'assertConeValue';

/** A second one, for the case that needs two targets in one file. */
const OTHER_SYMBOL = 'findRampCeiling';

/** An ordinary source-file mode, so mode preservation has something to preserve. */
const PROJECT_FILE_MODE = 0o644;

/**
 * Content planted outside the project, which nothing in a case may read or
 * write.
 *
 * It holds a **patchable declaration** on purpose. A payload the transform
 * could not wrap would make the containment cases pass for the wrong reason:
 * the sequence would reach the external file, read it, and then refuse because
 * no such symbol was there — indistinguishable, from the assertions, from
 * having refused the path. With a wrappable function in it, a sequence that
 * escapes the project actually rewrites this file, and the byte comparison at
 * the end of each case is what catches it.
 */
const EXTERNAL_CONTENT = 'export function outsideTheProject(): number {\n  return 1;\n}\n';

/**
 * Whether this host lets the test process create a symbolic link.
 *
 * Every containment case needs one, and a platform that refuses the plant
 * (Windows without developer mode) cannot host them. Probed once rather than
 * selected by platform name.
 */
const CAN_CREATE_SYMLINKS = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'debuggen-patcher-link-probe-'));
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
 * Fixtures
 * ---------------------------------------------------------------------------
 */

/** One case's temporary world: a project copy, a state root, and a session. */
interface Sandbox {
  /** The directory holding everything this case created. */
  readonly root: string;

  /** The copied fixture project, which is the patcher's `projectRoot`. */
  readonly projectRoot: string;

  /** The temporary `$DEBUGGEN_HOME` the backup store writes under. */
  readonly debuggenHome: string;

  /** The session every record and backup belongs to. */
  readonly sessionId: string;

  /** The absolute path of {@link TARGET_FILE} inside the copy. */
  readonly targetPath: string;

  /** The target's bytes before anything ran. */
  readonly originalBytes: Buffer;

  /** SHA-256 of {@link Sandbox.originalBytes}. */
  readonly originalHash: string;
}

/** The directory every sandbox of the current case lives in. */
let caseRoot = '';

beforeEach(() => {
  caseRoot = mkdtempSync(join(tmpdir(), 'debuggen-patcher-'));
});

afterEach(() => {
  rmSync(caseRoot, { recursive: true, force: true });
  caseRoot = '';
});

/**
 * Copies the fixture project and prepares a state root and session for it.
 *
 * A copy per case, never the committed fixture itself: the real patcher runs
 * here and writes real bytes, so a case working in place would leave the
 * repository modified — and `git status --porcelain packages/instrumentation`
 * has to be empty after this suite.
 */
function makeSandbox(name = 'project'): Sandbox {
  const root = join(caseRoot, name);
  const projectRoot = join(root, 'project');
  const debuggenHome = join(root, 'home');

  cpSync(FIXTURE_PROJECT, projectRoot, { recursive: true });
  // `0700`, because the backup store asserts its own state root is private and
  // owned by this account before it writes a single original into it.
  mkdirSync(debuggenHome, { recursive: true, mode: 0o700 });
  chmodSync(debuggenHome, 0o700);

  const targetPath = join(projectRoot, TARGET_FILE);
  const originalBytes = readFileSync(targetPath);

  return {
    root,
    projectRoot,
    debuggenHome,
    sessionId: newSessionId(),
    targetPath,
    originalBytes,
    originalHash: sha256Hex(originalBytes),
  };
}

/** The in-memory journal, plus the rows it holds, for assertions. */
interface TestJournal extends ModificationJournal {
  /** Every appended record, in append order, with its current status. */
  readonly rows: readonly ModificationRecord[];
}

/**
 * The `ModificationJournal` port, in memory.
 *
 * The only stubbed dependency in this suite, and legitimately so: the service
 * implements this port over `node:sqlite` and this package never opens a
 * database. What matters for the cases below is *when* a row appears and what
 * status it carries, both of which an array records exactly.
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

  return {
    rows,
    append: (record: ModificationRecord): Promise<Result<ModificationRecord>> => {
      rows.push(record);
      return Promise.resolve(ok(record));
    },
    updateStatus: (
      id: string,
      status: ModificationStatus,
      patch?: ModificationStatusPatch,
    ): Promise<Result<ModificationRecord>> => {
      const found = find(id);

      if (isErr(found)) {
        return Promise.resolve(found);
      }

      const current = rows[found.value];

      if (current === undefined) {
        return Promise.resolve(found as never as Result<ModificationRecord>);
      }

      const updated: ModificationRecord = {
        ...current,
        status,
        ...(patch?.appliedAt !== undefined ? { appliedAt: patch.appliedAt } : {}),
        ...(patch?.diff !== undefined ? { diff: patch.diff } : {}),
      };

      rows[found.value] = updated;
      return Promise.resolve(ok(updated));
    },
    listBySession: (sessionId: string): Promise<Result<ModificationRecord[]>> =>
      Promise.resolve(ok(rows.filter((row) => row.sessionId === sessionId))),
    listOpen: (): Promise<Result<ModificationRecord[]>> =>
      Promise.resolve(ok(rows.filter((row) => row.status === 'pending'))),
  };
}

/** Every path the production primitives were asked about, by operation. */
interface FileSystemLog {
  /** Paths handed to `readFileBytes`. */
  readonly reads: string[];

  /** Paths handed to `readFileSnapshot`. */
  readonly snapshots: string[];

  /** Paths handed to `realPath`. */
  readonly resolutions: string[];

  /** Paths handed to `replaceFileIfUnchanged`. */
  readonly writes: string[];

  /** `(root, relative)` pairs handed to `pinFile`. */
  readonly pins: string[];
}

/**
 * The production filesystem port, wrapped so every path it was asked about is
 * recorded.
 *
 * Delegating rather than faking is the point: the containment cases assert that
 * the *real* read and the *real* write were never reached for a path outside
 * the project, which a fake port could only assert about itself.
 */
function recordingFileSystem(options: RecordingOptions = {}): {
  files: PatchFileSystem;
  log: FileSystemLog;
} {
  const log: FileSystemLog = { reads: [], snapshots: [], resolutions: [], writes: [], pins: [] };

  return {
    log,
    files: {
      readFileBytes: (path) => {
        log.reads.push(path);
        return defaultPatchFileSystem.readFileBytes(path);
      },
      hashBytes: defaultPatchFileSystem.hashBytes,
      realPath: (path) => {
        log.resolutions.push(path);
        return defaultPatchFileSystem.realPath(path);
      },
      pinFile: (rootAbs, relativeFile) => {
        log.pins.push(`${rootAbs}::${relativeFile}`);
        return defaultPatchFileSystem.pinFile(rootAbs, relativeFile);
      },
      readFileSnapshot: (path) => {
        log.snapshots.push(path);
        return defaultPatchFileSystem.readFileSnapshot(path);
      },
      // Calls the shared primitive directly rather than through
      // `defaultPatchFileSystem`, because the install-boundary seam is the
      // primitive's own fourth parameter and deliberately not part of the
      // patcher's port: the patcher never passes it, so the port does not
      // carry it.
      replaceFileIfUnchanged: (path, content, expected) => {
        log.writes.push(path);
        return atomicReplaceFileIfUnchanged(
          path,
          content,
          expected,
          options.onBeforeInstall === undefined
            ? undefined
            : { onBeforeInstall: options.onBeforeInstall },
        );
      },
    },
  };
}

/** What a case asks the recording port to do beyond recording. */
interface RecordingOptions {
  /**
   * Forwarded to `atomicReplaceFileIfUnchanged`'s own seam, so a case can act
   * in the one interval between the precondition holding and the new entry
   * being installed.
   *
   * The patcher never passes this; it is how the suite reaches an interval that
   * lives inside the primitive rather than between two of the patcher's stages.
   */
  readonly onBeforeInstall?: (() => void) | undefined;
}

/** What {@link buildPatcher} was given, so a case can assert against it. */
interface Harness {
  /** The patcher under test. */
  readonly patcher: Patcher;

  /** The journal it appends to. */
  readonly journal: TestJournal;

  /** The backup store it copies originals into. */
  readonly backups: BackupStore;

  /** The recorded filesystem access. */
  readonly log: FileSystemLog;

  /** Every stage the sequence reported, in order. */
  readonly stages: PatchStage[];
}

/** Optional pieces a case supplies. */
interface HarnessOptions {
  /** A hook run after the named stage completes: the race, or a crash point. */
  readonly after?: { readonly stage: PatchStage; readonly run: () => void } | undefined;

  /** The plan version to stamp records with. Defaults to 1. */
  readonly planVersion?: number | undefined;

  /**
   * A hook run inside the replacement, after its precondition has held and the
   * displaced entry has been retained, immediately before the new entry is
   * installed. See {@link RecordingOptions.onBeforeInstall}.
   */
  readonly onBeforeInstall?: (() => void) | undefined;
}

/**
 * Builds a patcher over a sandbox with the real store, transform and
 * filesystem.
 *
 * The `after` hook is how a case becomes a race: the stage observer is awaited
 * between steps, so a callback that rewrites the target after
 * `'journal-pending'` and returns normally is precisely a developer saving the
 * file while the patch was being prepared.
 */
function buildPatcher(sandbox: Sandbox, options: HarnessOptions = {}): Harness {
  const journal = createTestJournal();
  const backups = createBackupStore({
    debuggenHome: sandbox.debuggenHome,
    sessionId: sandbox.sessionId,
  });
  const { files, log } = recordingFileSystem(
    options.onBeforeInstall === undefined ? {} : { onBeforeInstall: options.onBeforeInstall },
  );
  const stages: PatchStage[] = [];

  const patcher = createPatcher({
    projectRoot: sandbox.projectRoot,
    sessionId: sandbox.sessionId,
    planVersion: options.planVersion ?? 1,
    backups,
    journal,
    files,
    onStage: (event: PatchStageEvent) => {
      stages.push(event.stage);

      if (options.after !== undefined && options.after.stage === event.stage) {
        options.after.run();
      }
    },
  });

  return { patcher, journal, backups, log, stages };
}

/*
 * ---------------------------------------------------------------------------
 * Assertion helpers
 * ---------------------------------------------------------------------------
 */

/** The outcome of a successful patch, or a failed test naming the refusal. */
function appliedOutcome(result: Result<PatchOutcome>): PatchOutcome {
  if (isErr(result)) {
    throw new Error(
      `Expected the patch to apply, received ${result.error.code}: ${result.error.message} ${JSON.stringify(result.error.details)}`,
    );
  }
  return result.value;
}

/** The error of a refused patch, or a failed test naming what was applied. */
function refusalOf(result: Result<PatchOutcome>): DebuggenError {
  if (isOk(result)) {
    throw new Error(
      `Expected the patch to be refused, received record ${result.value.record.id} for ${result.value.record.file}`,
    );
  }
  return result.error;
}

/** Asserts the file at `path` holds exactly `expected`, byte for byte. */
function expectFileBytes(path: string, expected: Buffer | Uint8Array): void {
  const actual = readFileSync(path);

  expect(actual.byteLength).toBe(expected.byteLength);
  expect(Buffer.compare(actual, expected)).toBe(0);
}

/** SHA-256 of whatever is on disk at `path`, as the reconciliation table reads it. */
function digestOnDisk(path: string): string {
  return sha256Hex(readFileSync(path));
}

/** The temporary siblings an atomic write leaves behind, which must be none. */
function temporaryLeftoversIn(directory: string): string[] {
  return readdirSync(directory)
    .filter((entry) => entry.endsWith('.tmp'))
    .sort();
}

/** The permission bits of a path. */
function permissionsOf(path: string): number {
  return statSync(path).mode & 0o777;
}

/*
 * ---------------------------------------------------------------------------
 * The write sequence
 * ---------------------------------------------------------------------------
 */

describe('the write sequence', () => {
  it('journals both hashes as pending before the project file changes', async () => {
    const sandbox = makeSandbox();
    const observed: { stage: PatchStage; digest: string; rows: number }[] = [];

    const journal = createTestJournal();
    const patcher = createPatcher({
      projectRoot: sandbox.projectRoot,
      sessionId: sandbox.sessionId,
      planVersion: 1,
      backups: createBackupStore({
        debuggenHome: sandbox.debuggenHome,
        sessionId: sandbox.sessionId,
      }),
      journal,
      onStage: (event) => {
        observed.push({
          stage: event.stage,
          digest: digestOnDisk(sandbox.targetPath),
          rows: journal.rows.length,
        });
      },
    });

    const outcome = appliedOutcome(
      await patcher.patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
    );

    // The linchpoint of AAP §0.5.1: the row exists, with both hashes, while the
    // file still holds its original bytes. Reordering these two steps is what
    // turns a crash after the rename from decidable into ambiguous, and no
    // assertion about the end state would notice.
    const journaled = observed.find((entry) => entry.stage === 'journal-pending');

    expect(journaled?.rows).toBe(1);
    expect(journaled?.digest).toBe(sandbox.originalHash);

    const pending = journal.rows[0];

    expect(pending?.originalHash).toBe(sandbox.originalHash);
    expect(pending?.instrumentedHash).toBe(outcome.instrumentedHash);
    expect(pending?.diff.length).toBeGreaterThan(0);
    expect(pending?.backupPath).toBe(outcome.backup.path);

    // And only then does the file change.
    expect(observed.find((entry) => entry.stage === 'replace-file')?.digest).toBe(
      outcome.instrumentedHash,
    );
    expect(observed.map((entry) => entry.stage)).toEqual([...PATCH_STAGES]);
  });

  it('installs the patch, records it applied and leaves the mode alone', async () => {
    const sandbox = makeSandbox();
    const { patcher, journal } = buildPatcher(sandbox);

    const outcome = appliedOutcome(
      await patcher.patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
    );

    expect(outcome.status).toBe('applied');
    expect(digestOnDisk(sandbox.targetPath)).toBe(outcome.instrumentedHash);
    expect(outcome.originalHash).toBe(sandbox.originalHash);
    expect(outcome.location).toMatchObject({
      file: TARGET_FILE,
      symbol: TARGET_SYMBOL,
      resolvedBy: 'patch',
    });
    expect(journal.rows[0]?.status).toBe('applied');

    // `atomicReplaceFileIfUnchanged` preserves the target's mode, which is why
    // the patcher uses it rather than the 0600-forcing state-file writer: a
    // patch that narrowed a file's permissions would be a modification the
    // product never recorded and cannot revert.
    expect(permissionsOf(sandbox.targetPath)).toBe(PROJECT_FILE_MODE);
    expect(temporaryLeftoversIn(dirname(sandbox.targetPath))).toEqual([]);
  });

  it('copies the original bytes into the backup before writing', async () => {
    const sandbox = makeSandbox();
    const { patcher, backups } = buildPatcher(sandbox);

    const outcome = appliedOutcome(
      await patcher.patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
    );

    const stored = await backups.read(sandbox.originalHash);

    expect(isOk(stored)).toBe(true);
    if (isOk(stored)) {
      expect(Buffer.compare(stored.value, sandbox.originalBytes)).toBe(0);
    }
    expect(outcome.backup.path.startsWith(sandbox.debuggenHome)).toBe(true);
  });

  it('chains a second plan version onto the first record for the same file', async () => {
    const sandbox = makeSandbox();
    const journal = createTestJournal();
    const backups = createBackupStore({
      debuggenHome: sandbox.debuggenHome,
      sessionId: sandbox.sessionId,
    });

    const first = appliedOutcome(
      await createPatcher({
        projectRoot: sandbox.projectRoot,
        sessionId: sandbox.sessionId,
        planVersion: 1,
        backups,
        journal,
      }).patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
    );

    const second = appliedOutcome(
      await createPatcher({
        projectRoot: sandbox.projectRoot,
        sessionId: sandbox.sessionId,
        planVersion: 2,
        backups,
        journal,
      }).patchTarget({ file: TARGET_FILE, symbol: OTHER_SYMBOL }),
    );

    // The chain's invariant: the later record's baseline is the earlier
    // record's result, so cleanup can unwind them in reverse and land on the
    // developer's original bytes.
    expect(second.previousRecordId).toBe(first.record.id);
    expect(second.originalHash).toBe(first.instrumentedHash);
    expect(journal.rows).toHaveLength(2);
    expect(journal.rows[0]?.status).toBe('applied');
  });
});

/*
 * ---------------------------------------------------------------------------
 * A symbolic link among the target path components
 * ---------------------------------------------------------------------------
 *
 * The CWE-22 block. `packages/shared/src/node/safe-fs.test.ts` proves on a real
 * filesystem that the lexical gate accepts such a path and that an interior
 * link is read straight through; these cases prove the patcher does not.
 */

/** A project with a link out of it, and the directory that link points at. */
interface EscapeFixture {
  /** The sandbox the project was copied into. */
  readonly sandbox: Sandbox;

  /** The directory outside the project, which nothing may touch. */
  readonly externalDir: string;

  /** The file in it, whose bytes nothing inside the project may reach. */
  readonly externalFile: string;

  /** The project-relative path that reaches {@link EscapeFixture.externalFile}. */
  readonly escapingRelative: string;
}

/**
 * Plants `src/escape` inside the project as a link to a directory outside it.
 *
 * The planted link is a *directory*, which is the case no flag can defend
 * against: `O_NOFOLLOW` applies to a path's final component, and `escape` is an
 * interior one.
 */
function plantEscapingDirectory(): EscapeFixture {
  const sandbox = makeSandbox();
  const externalDir = join(sandbox.root, 'beyond');
  const externalFile = join(externalDir, 'reachable.ts');

  mkdirSync(externalDir, { recursive: true });
  writeFileSync(externalFile, EXTERNAL_CONTENT);
  symlinkSync(externalDir, join(sandbox.projectRoot, 'src', 'escape'));

  return { sandbox, externalDir, externalFile, escapingRelative: 'src/escape/reachable.ts' };
}

describe('a symbolic link among the target path components', () => {
  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a target reached through a directory link that leaves the project, and touches nothing outside it (requires symlink creation)',
    async () => {
      const { sandbox, externalDir, externalFile, escapingRelative } = plantEscapingDirectory();
      const { patcher, journal, log } = buildPatcher(sandbox);

      const error = refusalOf(
        await patcher.patchTarget({ file: escapingRelative, symbol: 'outsideTheProject' }),
      );

      expect(error.code).toBe('PATH_OUTSIDE_PROJECT');
      expect(error.details?.['reason']).toBe('symlink-escapes-project-root');

      // Zero external I/O, stated as four separate facts rather than inferred
      // from the refusal: nothing was read, nothing was journaled, no backup
      // directory came into existence, and the file outside the project is
      // byte-identical with nothing added beside it.
      expect(log.snapshots).toEqual([]);
      expect(log.reads).toEqual([]);
      expect(log.writes).toEqual([]);
      expect(journal.rows).toEqual([]);
      expect(patcher.journaledRecords()).toEqual([]);
      expect(existsSync(join(sandbox.debuggenHome, 'backups'))).toBe(false);
      expectFileBytes(externalFile, Buffer.from(EXTERNAL_CONTENT));
      expect(readdirSync(externalDir).sort()).toEqual(['reachable.ts']);
      expect(temporaryLeftoversIn(externalDir)).toEqual([]);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses before the sequence starts, at the resolve-target stage (requires symlink creation)',
    async () => {
      const { sandbox, escapingRelative } = plantEscapingDirectory();
      const { patcher, stages } = buildPatcher(sandbox);

      await patcher.patchTarget({ file: escapingRelative, symbol: 'outsideTheProject' });

      // Not one stage completed: the refusal is ahead of `'resolve-target'`
      // itself, so no observer ever saw a target that was going to be read.
      expect(stages).toEqual([]);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a target whose own final component is a link (requires symlink creation)',
    async () => {
      // The half `O_NOFOLLOW` does cover, asserted so the two halves are
      // visibly different refusals rather than one accident.
      const { sandbox, externalFile } = plantEscapingDirectory();
      const linkedTarget = 'src/server/linked-rules.ts';
      symlinkSync(externalFile, join(sandbox.projectRoot, linkedTarget));

      const { patcher, journal } = buildPatcher(sandbox);

      const error = refusalOf(
        await patcher.patchTarget({ file: linkedTarget, symbol: 'outsideTheProject' }),
      );

      expect(error.code).toBe('FS_UNSAFE_PATH');
      expect(error.details?.['reason']).toBe('symlink-at-target');
      expect(journal.rows).toEqual([]);
      expectFileBytes(externalFile, Buffer.from(EXTERNAL_CONTENT));
      expect(lstatSync(join(sandbox.projectRoot, linkedTarget)).isSymbolicLink()).toBe(true);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a target reached through a link that stays inside the project (requires symlink creation)',
    async () => {
      // Contained, so not a containment refusal - but the file would then have
      // two project-relative names, and a record naming one of them describes
      // bytes reached by the other. Refused rather than guessed.
      const sandbox = makeSandbox();
      symlinkSync(join(sandbox.projectRoot, 'src'), join(sandbox.projectRoot, 'alias'));

      const { patcher, journal } = buildPatcher(sandbox);

      const error = refusalOf(
        await patcher.patchTarget({
          file: 'alias/server/cone-rules.ts',
          symbol: TARGET_SYMBOL,
        }),
      );

      expect(error.code).toBe('FS_UNSAFE_PATH');
      expect(error.details?.['reason']).toBe('symlink-inside-project');
      expect(journal.rows).toEqual([]);
      expectFileBytes(sandbox.targetPath, sandbox.originalBytes);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'patches a project whose own root is reached through a link (requires symlink creation)',
    async () => {
      // The regression this block could easily introduce: canonicalising the
      // target but not the root refuses every path in a checkout that sits
      // under a linked parent - a linked home directory, or macOS's /tmp.
      const sandbox = makeSandbox();
      const linkedRoot = join(sandbox.root, 'linked-project');
      symlinkSync(sandbox.projectRoot, linkedRoot);

      const journal = createTestJournal();
      const patcher = createPatcher({
        projectRoot: linkedRoot,
        sessionId: sandbox.sessionId,
        planVersion: 1,
        backups: createBackupStore({
          debuggenHome: sandbox.debuggenHome,
          sessionId: sandbox.sessionId,
        }),
        journal,
      });

      const outcome = appliedOutcome(
        await patcher.patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
      );

      expect(outcome.record.file).toBe(TARGET_FILE);
      expect(digestOnDisk(sandbox.targetPath)).toBe(outcome.instrumentedHash);
    },
  );

  it('refuses a traversal without consulting the filesystem', async () => {
    const sandbox = makeSandbox();
    const { patcher, journal, log } = buildPatcher(sandbox);

    const error = refusalOf(
      await patcher.patchTarget({ file: '../../../etc/passwd', symbol: TARGET_SYMBOL }),
    );

    expect(error.code).toBe('PATH_OUTSIDE_PROJECT');
    expect(error.details?.['reason']).toBe('unsafe-relative-path');
    // The lexical gate runs first, so a hostile target is not even an existence
    // probe: no canonicalisation, no read, no write.
    expect(log.resolutions).toEqual([]);
    expect(log.snapshots).toEqual([]);
    expect(log.writes).toEqual([]);
    expect(journal.rows).toEqual([]);
  });

  it('refuses an absolute target without consulting the filesystem', async () => {
    const sandbox = makeSandbox();
    const { patcher, log } = buildPatcher(sandbox);

    const error = refusalOf(
      await patcher.patchTarget({ file: '/etc/hosts', symbol: TARGET_SYMBOL }),
    );

    expect(error.code).toBe('PATH_OUTSIDE_PROJECT');
    expect(log.resolutions).toEqual([]);
    expect(log.writes).toEqual([]);
  });

  it('reports a target whose directory does not exist as a stale plan', async () => {
    // Canonicalisation cannot resolve the directory, and that is not a
    // containment failure: it is a plan naming a file that is gone, which has a
    // different answer for the developer.
    const sandbox = makeSandbox();
    const { patcher, journal } = buildPatcher(sandbox);

    const error = refusalOf(
      await patcher.patchTarget({ file: 'src/absent/thing.ts', symbol: TARGET_SYMBOL }),
    );

    expect(error.code).toBe('PATCH_TARGET_NOT_FOUND');
    expect(journal.rows).toEqual([]);
  });

  it('reports a missing file in an existing directory as a stale plan', async () => {
    const sandbox = makeSandbox();
    const { patcher, journal } = buildPatcher(sandbox);

    const error = refusalOf(
      await patcher.patchTarget({ file: 'src/server/absent.ts', symbol: TARGET_SYMBOL }),
    );

    expect(error.code).toBe('PATCH_TARGET_NOT_FOUND');
    expect(journal.rows).toEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * A developer edit racing the write
 * ---------------------------------------------------------------------------
 *
 * The CWE-367 block. Each case lets the sequence get as far as its journal row
 * and then changes the target the way a developer's editor would, which is the
 * one window an unconditional `rename` cannot see.
 */

describe('a developer edit racing the write', () => {
  /** What a developer's save leaves in the file, distinguishable byte for byte. */
  const DEVELOPER_EDIT = '\n// edited while the patch was being prepared\n';

  it('declines the write when the content changed after the baseline was read', async () => {
    const sandbox = makeSandbox();
    const developerBytes = Buffer.concat([sandbox.originalBytes, Buffer.from(DEVELOPER_EDIT)]);

    const { patcher, journal, backups, log } = buildPatcher(sandbox, {
      after: {
        stage: 'journal-pending',
        run: () => {
          writeFileSync(sandbox.targetPath, developerBytes);
        },
      },
    });

    const error = refusalOf(
      await patcher.patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
    );

    expect(error.code).toBe('MODIFICATION_CONFLICT');
    expect(error.details?.['reason']).toBe('content-changed');

    // The developer's bytes, exactly as they saved them. This is the assertion
    // the whole block exists for: an unconditional rename passes every other
    // test in this file and fails this one.
    expectFileBytes(sandbox.targetPath, developerBytes);
    // One write attempt, and it went through the pinned path rather than the
    // plain one - see `describe('the pinned target')` for why that matters.
    expect(log.writes).toHaveLength(1);
    expect(basename(log.writes[0] ?? '')).toBe(basename(TARGET_FILE));
    expect(temporaryLeftoversIn(dirname(sandbox.targetPath))).toEqual([]);

    // The record is on file as `failed` with both hashes, and the file matches
    // neither - which is exactly the state reconciliation reads as a conflict:
    // leave the file, keep the backup, report it.
    const record = journal.rows[0];

    expect(record?.status).toBe('failed');
    expect(record?.originalHash).toBe(sandbox.originalHash);
    expect(digestOnDisk(sandbox.targetPath)).not.toBe(record?.originalHash);
    expect(digestOnDisk(sandbox.targetPath)).not.toBe(record?.instrumentedHash);

    // And the bytes the sequence read are durable in the backup, so nothing
    // that was observed is lost either.
    const stored = await backups.read(sandbox.originalHash);

    expect(isOk(stored)).toBe(true);
    if (isOk(stored)) {
      expect(Buffer.compare(stored.value, sandbox.originalBytes)).toBe(0);
    }
  });

  it('reports the failure at the replace stage with nothing written', async () => {
    const sandbox = makeSandbox();
    const { patcher } = buildPatcher(sandbox, {
      after: {
        stage: 'journal-pending',
        run: () => {
          writeFileSync(sandbox.targetPath, `${sandbox.originalBytes.toString('utf8')}// edit\n`);
        },
      },
    });

    const batch = await patcher.patchActions([
      {
        id: 'act_race',
        file: TARGET_FILE,
        symbol: TARGET_SYMBOL,
        type: 'function-timing',
        adapter: 'nextjs',
        mode: 'patch',
        rationale: 'time the named function',
      },
    ]);

    expect(batch.applied).toEqual([]);
    expect(batch.failure?.stage).toBe('replace-file');
    // The flag a rollback reads: the rename never happened, so there is nothing
    // to reverse-restore for this record.
    expect(batch.failure?.fileMayHoldPatch).toBe(false);
    expect(batch.journaled).toHaveLength(1);
    expect(batch.journaled[0]?.status).toBe('failed');
  });

  it('declines the write when the file was replaced by another with identical bytes', async () => {
    // The case a content comparison alone cannot see, and the reason the
    // precondition carries the inode: an editor that saves by writing a
    // temporary file and renaming it over the target produces exactly this,
    // and the bytes may be identical.
    const sandbox = makeSandbox();

    const { patcher, journal } = buildPatcher(sandbox, {
      after: {
        stage: 'journal-pending',
        run: () => {
          const replacement = join(sandbox.projectRoot, 'src', 'server', 'replacement.ts');
          writeFileSync(replacement, sandbox.originalBytes);
          renameSync(replacement, sandbox.targetPath);
        },
      },
    });

    const error = refusalOf(
      await patcher.patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
    );

    expect(error.code).toBe('MODIFICATION_CONFLICT');
    expect(error.details?.['reason']).toBe('identity-changed');
    expectFileBytes(sandbox.targetPath, sandbox.originalBytes);
    expect(journal.rows[0]?.status).toBe('failed');
  });

  it('declines the write when the file was deleted after the baseline was read', async () => {
    const sandbox = makeSandbox();

    const { patcher, journal } = buildPatcher(sandbox, {
      after: {
        stage: 'journal-pending',
        run: () => {
          rmSync(sandbox.targetPath);
        },
      },
    });

    const error = refusalOf(
      await patcher.patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
    );

    expect(error.code).toBe('MODIFICATION_CONFLICT');
    expect(error.details?.['reason']).toBe('target-missing');
    expect(existsSync(sandbox.targetPath)).toBe(false);
    expect(journal.rows[0]?.status).toBe('failed');
  });

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'declines the write when a link took the target path, leaving the file it points at alone (requires symlink creation)',
    async () => {
      // `rename` replaces a path entry, so an unconditional write would swap
      // the link for a regular file and the developer would be left with
      // neither their link nor a warning.
      const sandbox = makeSandbox();
      const victim = join(sandbox.root, 'victim.ts');
      writeFileSync(victim, EXTERNAL_CONTENT);

      const { patcher } = buildPatcher(sandbox, {
        after: {
          stage: 'journal-pending',
          run: () => {
            rmSync(sandbox.targetPath);
            symlinkSync(victim, sandbox.targetPath);
          },
        },
      });

      const error = refusalOf(
        await patcher.patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
      );

      expect(error.code).toBe('MODIFICATION_CONFLICT');
      expect(error.details?.['reason']).toBe('identity-changed');
      expect(lstatSync(sandbox.targetPath).isSymbolicLink()).toBe(true);
      expectFileBytes(victim, Buffer.from(EXTERNAL_CONTENT));
    },
  );

  it('applies the patch when nothing touched the file, so the guard does not over-refuse', async () => {
    // The control. A condition that refused a quiet filesystem would look
    // identical to a correct one in every case above.
    const sandbox = makeSandbox();
    let observed = false;

    const { patcher } = buildPatcher(sandbox, {
      after: {
        stage: 'journal-pending',
        run: () => {
          observed = true;
        },
      },
    });

    const outcome = appliedOutcome(
      await patcher.patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
    );

    expect(observed).toBe(true);
    expect(digestOnDisk(sandbox.targetPath)).toBe(outcome.instrumentedHash);
  });

  it('declines the write when the edit lands as late as the backup stage', async () => {
    // The window is not only the journal append: every step between the read
    // and the rename is part of it, so the guard is asserted at a second
    // boundary rather than at one convenient one.
    const sandbox = makeSandbox();
    const developerBytes = Buffer.concat([sandbox.originalBytes, Buffer.from(DEVELOPER_EDIT)]);

    const { patcher } = buildPatcher(sandbox, {
      after: {
        stage: 'store-backup',
        run: () => {
          writeFileSync(sandbox.targetPath, developerBytes);
        },
      },
    });

    const error = refusalOf(
      await patcher.patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
    );

    expect(error.code).toBe('MODIFICATION_CONFLICT');
    expectFileBytes(sandbox.targetPath, developerBytes);
  });

  it('declines the write when a file appears at the target during the install itself', async () => {
    // The one interval the replacement cannot make atomic: the precondition has
    // held, the displaced entry has been retained, and a write lands before the
    // new entry is installed. The install is a `link`, which refuses to
    // overwrite, so the newcomer survives and the patch is reported as a
    // conflict. A compare-then-rename install passes every other case in this
    // block and destroys the file here.
    const sandbox = makeSandbox();
    const newcomer = '// written during the install\n';

    const { patcher, journal } = buildPatcher(sandbox, {
      onBeforeInstall: () => {
        writeFileSync(sandbox.targetPath, newcomer);
      },
    });

    const error = refusalOf(
      await patcher.patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
    );

    expect(error.code).toBe('MODIFICATION_CONFLICT');
    expectFileBytes(sandbox.targetPath, Buffer.from(newcomer));
    expect(journal.rows[0]?.status).toBe('failed');
    expect(temporaryLeftoversIn(dirname(sandbox.targetPath))).toEqual([]);
  });

  it('installs normally when nothing appears during the install', async () => {
    // The control for the case above.
    const sandbox = makeSandbox();
    let reached = false;

    const { patcher } = buildPatcher(sandbox, {
      onBeforeInstall: () => {
        reached = true;
      },
    });

    const outcome = appliedOutcome(
      await patcher.patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
    );

    expect(reached).toBe(true);
    expect(digestOnDisk(sandbox.targetPath)).toBe(outcome.instrumentedHash);
  });

  it('refuses to patch again over a file left with an unreconciled record', async () => {
    // After a declined write the file's state is undecided until reconciliation
    // has run, and layering a new record on an undecided one is how a chain
    // stops being unwindable.
    const sandbox = makeSandbox();
    const journal = createTestJournal();
    const backups = createBackupStore({
      debuggenHome: sandbox.debuggenHome,
      sessionId: sandbox.sessionId,
    });

    const racing = createPatcher({
      projectRoot: sandbox.projectRoot,
      sessionId: sandbox.sessionId,
      planVersion: 1,
      backups,
      journal,
      onStage: (event) => {
        if (event.stage === 'journal-pending') {
          writeFileSync(sandbox.targetPath, `${sandbox.originalBytes.toString('utf8')}// edit\n`);
        }
      },
    });

    expect(isErr(await racing.patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }))).toBe(
      true,
    );

    const second = createPatcher({
      projectRoot: sandbox.projectRoot,
      sessionId: sandbox.sessionId,
      planVersion: 2,
      backups,
      journal,
    });

    const error = refusalOf(await second.patchTarget({ file: TARGET_FILE, symbol: OTHER_SYMBOL }));

    expect(error.code).toBe('MODIFICATION_CONFLICT');
    expect(error.details?.['reason']).toBe('unreconciled-record');
    expect(journal.rows).toHaveLength(1);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The pinned target
 * ---------------------------------------------------------------------------
 *
 * Canonicalising the target proves where its path led at one instant. These
 * cases are about the instants afterwards: the read happens a moment later and
 * the rename minutes later, and a directory component replaced in between would
 * redirect both to somewhere the check never saw. The sequence therefore holds
 * the containing directory open and addresses that descriptor, so there is no
 * second resolution to redirect.
 */

describe('the pinned target', () => {
  it('pins the canonical root and relative path, and uses the pin for the read and the write', () => {
    const sandbox = makeSandbox();
    const { patcher, log } = buildPatcher(sandbox);

    return patcher.patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }).then((result) => {
      appliedOutcome(result);

      expect(log.pins).toEqual([`${realpathSync(sandbox.projectRoot)}::${TARGET_FILE}`]);
      // The read and the write went to the same path, and it is the pinned one
      // rather than the plain one - on a host that can address a descriptor as
      // a path, that is visibly a different string.
      expect(log.snapshots).toEqual(log.writes);
      expect(basename(log.writes[0] ?? '')).toBe(basename(TARGET_FILE));
      if (existsSync('/proc/self/fd')) {
        expect(log.writes[0]?.startsWith('/proc/self/fd/')).toBe(true);
      }
    });
  });

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'writes nothing outside the project when the target directory is replaced by a link to a decoy after resolution (requires symlink creation)',
    async () => {
      // The remaining half of CWE-22, and the case a containment *check* cannot
      // reach: resolution accepts the path, and only then is the verified
      // directory moved away and a link to a decoy directory - holding a file
      // of the same name - planted in its place. A path-based sequence would
      // rewrite the decoy, a file outside the project that nothing validated.
      const sandbox = makeSandbox();
      const decoyDirectory = join(sandbox.root, 'decoy');
      const decoyFile = join(decoyDirectory, basename(TARGET_FILE));
      const movedDirectory = join(sandbox.root, 'moved-server');
      const realDirectory = dirname(sandbox.targetPath);

      mkdirSync(decoyDirectory, { recursive: true });
      writeFileSync(decoyFile, EXTERNAL_CONTENT);

      const { patcher, journal, log } = buildPatcher(sandbox, {
        after: {
          stage: 'read-original',
          run: () => {
            renameSync(realDirectory, movedDirectory);
            symlinkSync(decoyDirectory, realDirectory);
          },
        },
      });

      const error = refusalOf(
        await patcher.patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
      );

      // Reported rather than written through: the pin would have reached the
      // relocated directory safely, but a plan whose file has moved is a
      // conflict the developer needs to see.
      expect(error.code).toBe('MODIFICATION_CONFLICT');
      expect(error.details?.['reason']).toBe('directory-changed');

      // The decoy - the only thing an escape could have reached - is untouched,
      // and nothing was added beside it.
      expectFileBytes(decoyFile, Buffer.from(EXTERNAL_CONTENT));
      expect(readdirSync(decoyDirectory).sort()).toEqual([basename(TARGET_FILE)]);
      expect(temporaryLeftoversIn(decoyDirectory)).toEqual([]);

      // The real file, wherever it now lives, still holds the developer's
      // bytes, and the record is on file as failed with both hashes.
      expectFileBytes(join(movedDirectory, basename(TARGET_FILE)), sandbox.originalBytes);
      expect(journal.rows[0]?.status).toBe('failed');
      expect(log.writes).toEqual([]);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'writes nothing outside the project when the swap happens before the read (requires symlink creation)',
    async () => {
      // The same swap one stage earlier, so the read is exposed as well as the
      // write. The pinned read reaches the file that was verified - not the
      // decoy - which is what the assertions below pin down.
      const sandbox = makeSandbox();
      const decoyDirectory = join(sandbox.root, 'decoy');
      const decoyFile = join(decoyDirectory, basename(TARGET_FILE));
      const movedDirectory = join(sandbox.root, 'moved-server');
      const realDirectory = dirname(sandbox.targetPath);

      mkdirSync(decoyDirectory, { recursive: true });
      writeFileSync(decoyFile, EXTERNAL_CONTENT);

      const { patcher, journal } = buildPatcher(sandbox, {
        after: {
          stage: 'resolve-target',
          run: () => {
            renameSync(realDirectory, movedDirectory);
            symlinkSync(decoyDirectory, realDirectory);
          },
        },
      });

      const error = refusalOf(
        await patcher.patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
      );

      expect(error.code).toBe('MODIFICATION_CONFLICT');
      expectFileBytes(decoyFile, Buffer.from(EXTERNAL_CONTENT));
      expect(readdirSync(decoyDirectory).sort()).toEqual([basename(TARGET_FILE)]);
      expectFileBytes(join(movedDirectory, basename(TARGET_FILE)), sandbox.originalBytes);
      // Nothing was backed up either: the decoy's bytes never entered the
      // session's backup tree.
      expect(journal.rows.every((row) => row.originalHash === sandbox.originalHash)).toBe(true);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a directory component that is a link at pin time (requires symlink creation)',
    async () => {
      // Belt and braces with the containment gate above: even if a path
      // survived canonicalisation, the pin walk opens every component with
      // O_NOFOLLOW and refuses a link at any of them.
      const sandbox = makeSandbox();
      const { patcher, journal } = buildPatcher(sandbox);
      const realDirectory = dirname(sandbox.targetPath);
      const moved = join(sandbox.root, 'moved-server');

      renameSync(realDirectory, moved);
      symlinkSync(moved, realDirectory);

      const error = refusalOf(
        await patcher.patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
      );

      expect(['FS_UNSAFE_PATH', 'PATH_OUTSIDE_PROJECT']).toContain(error.code);
      expect(journal.rows).toEqual([]);
      expectFileBytes(join(moved, basename(TARGET_FILE)), sandbox.originalBytes);
    },
  );
});
