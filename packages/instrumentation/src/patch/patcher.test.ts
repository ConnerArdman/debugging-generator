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
 * ## The fresh-process matrix
 *
 * AAP §0.5.1 asks for more than an in-process boundary: a **child killed at
 * each boundary**, then the real reconciliation from `../cleanup.ts`, proving
 * the developer's file comes back byte-for-byte.
 * `describe('a process killed mid-sequence')` is that matrix, and the kill is
 * abrupt by construction: the worker sends itself `SIGKILL`, so no `finally`,
 * no `process.on('exit')`, no buffered write and no ts-morph teardown can run.
 * A `try`/`catch` in one process would prove something weaker — that a handler
 * cleaned up — which is the opposite of the guarantee.
 *
 * Two pieces make that observable.
 *
 * - **A durable journal.** An in-memory journal dies with the worker, and
 *   "crashed after the journal, before the write" then looks exactly like
 *   "crashed before the journal" — the very distinction the ordering of step 4
 *   and step 5 exists to create. So the worker and the parent share
 *   {@link openFileJournal}: the `ModificationJournal` port over an append-only
 *   JSONL log whose every line is `fsync`ed before the call returns, which is
 *   what `apps/local-service/src/store/modifications-repo.ts` achieves over
 *   `node:sqlite`. Each replayed line is parsed with `parseModificationRecord`,
 *   so a row that survived a crash is also proven to satisfy the schema.
 * - **A worker built from these same sources.** It is generated into the case's
 *   own temporary directory and run through `tsx` (the root's pinned
 *   devDependency), importing `./patcher.ts` and `./backup-store.ts` by
 *   `file://` URL — never a `dist/` build, so the matrix cannot pass against
 *   stale output and does not couple this suite to build order. It is generated
 *   rather than committed because its whole content is this file's business,
 *   and a `.mts` extension rather than `.ts` because a `.ts` file under
 *   `os.tmpdir()` has no `package.json` above it and would be transformed as
 *   CommonJS, where top-level `await` is an error.
 *
 * Each crash case then asserts what the reconciliation table of AAP §0.5.1
 * promises for that boundary — which record status is on file, whether the
 * digest equals `originalHash`, `instrumentedHash` or neither, and that the
 * backup is deleted only *after* the restored bytes were verified against
 * `originalHash`, observed through a recording backup store rather than
 * inferred from the end state.
 */

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { applyPatch } from 'diff';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DebuggenError, err, isErr, isOk, newActionId, newSessionId, ok } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';
import { atomicReplaceFileIfUnchanged, sha256Hex } from '@debuggen/shared/node';

import { reconcileModifications, restoreModification } from '../cleanup.js';
import type { ReconcileOutcome, RestoreOutcome } from '../cleanup.js';
import { MODIFICATION_ID_PATTERN, parseModificationRecord } from '../schema/modification.js';
import type {
  ModificationJournal,
  ModificationRecord,
  ModificationStatus,
  ModificationStatusPatch,
} from '../schema/modification.js';
import type { InstrumentationAction } from '../schema/plan.js';

import { createBackupStore } from './backup-store.js';
import type {
  BackupStore,
  RecordedBackup,
  RemoveBackupOptions,
  StoredBackup,
} from './backup-store.js';
import { FunctionTimingPatcher } from './function-timing.js';
import { SPAN_HELPER_GLOBAL, SPAN_HELPER_TYPE_NAME } from './wrap-template.js';
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

/**
 * A digest of every byte of the committed fixture tree.
 *
 * Computed by walking the tree in a stable order and hashing each file's path
 * beside its own digest, so a changed byte, an added file and a removed file
 * are all visible in one value. Captured at module load — before any case has
 * run — and asserted again by the last case in the file, which is the cheapest
 * possible guard against a case addressing the committed fixture instead of its
 * own copy of it.
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

/** The fixture file every case patches, project-relative POSIX. */
const TARGET_FILE = 'src/server/cone-rules.ts';

/** A named declaration in {@link TARGET_FILE} the transform can wrap. */
const TARGET_SYMBOL = 'assertConeValue';

/** A second one, for the case that needs two targets in one file. */
const OTHER_SYMBOL = 'findRampCeiling';

/** An ordinary source-file mode, so mode preservation has something to preserve. */
const PROJECT_FILE_MODE = 0o644;

/**
 * The fixture file the crash matrix and the chain cases work on, and the two
 * symbols in it they wrap.
 *
 * A second file, rather than {@link TARGET_FILE} again, so the two plan
 * versions of a chain have two distinct symbols to instrument in one file and
 * the matrix is not reading state a neighbouring block also touches.
 */
const CHAIN_FILE = 'src/server/cycle-planner.ts';

/** The symbol plan version 1 wraps in {@link CHAIN_FILE}. */
const CHAIN_FIRST_SYMBOL = 'planCycleSegments';

/** The symbol plan version 2 wraps in {@link CHAIN_FILE}. */
const CHAIN_SECOND_SYMBOL = 'estimateSoakMinutes';

/** A plain-JavaScript fixture target, so the write path is proven for `.js` too. */
const JS_FILE = 'src/legacy/bisque-schedule.js';

/** A named declaration in {@link JS_FILE}. */
const JS_SYMBOL = 'planBisqueRamp';

/** A generator declaration: a form the transform must refuse rather than wrap. */
const GENERATOR_FILE = 'src/server/segment-stream.ts';

/** The generator in {@link GENERATOR_FILE}. */
const GENERATOR_SYMBOL = 'walkRampSegments';

/**
 * How long a crash worker may take before the case fails rather than stalls.
 *
 * A worker spawn measures around a second on a warm machine (`tsx` start, two
 * dynamic imports, one ts-morph transform); the bound is generous enough for a
 * loaded CI runner and finite so a worker that hangs — a `SIGKILL` that never
 * arrives, an import that never resolves — is a red test and not a red suite.
 */
const WORKER_TIMEOUT_MS = 60_000;

/**
 * The per-test bound for a case that spawns a worker.
 *
 * The `instrumentation` Vitest project takes the default 5 s, which a spawn
 * plus a reconciliation pass can exceed on a busy host; this is stated per case
 * rather than raised for the whole project, so the fast cases keep the tight
 * default.
 */
const CRASH_CASE_TIMEOUT_MS = 90_000;

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
    // Everything except `reverted`, which is the port's contract rather than a
    // convenience: a `pending` row left by a crash and a `conflict` row that
    // was never resolved both have to keep coming back to a reconciliation
    // pass, whatever state their session ended in.
    listOpen: (): Promise<Result<ModificationRecord[]>> =>
      Promise.resolve(ok(rows.filter((row) => row.status !== 'reverted'))),
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

/** A file's bytes and digest as they stood before anything ran. */
interface Pristine {
  /** The project-relative POSIX path, as a plan would spell it. */
  readonly file: string;

  /** The absolute path inside the sandbox copy. */
  readonly path: string;

  /** The exact bytes. */
  readonly bytes: Buffer;

  /** SHA-256 of {@link Pristine.bytes}. */
  readonly hash: string;
}

/**
 * Snapshots a file in the sandbox before the patcher has run.
 *
 * {@link Sandbox} snapshots {@link TARGET_FILE} only; the crash matrix, the
 * chain and the byte-fidelity cases work on other files, and every one of them
 * has to hold the developer's exact bytes from before the sequence started —
 * that snapshot is what "byte-identical" is measured against.
 */
function pristineFile(sandbox: Sandbox, file: string): Pristine {
  const path = join(sandbox.projectRoot, file);
  const bytes = readFileSync(path);

  return { file, path, bytes, hash: sha256Hex(bytes) };
}

/** Asserts a file holds exactly the bytes it held before the suite touched it. */
function expectPristine(pristine: Pristine): void {
  expect(existsSync(pristine.path)).toBe(true);
  expectFileBytes(pristine.path, pristine.bytes);
  expect(digestOnDisk(pristine.path)).toBe(pristine.hash);
}

/*
 * ---------------------------------------------------------------------------
 * The durable journal
 * ---------------------------------------------------------------------------
 *
 * The `ModificationJournal` port over an append-only JSONL log, `fsync`ed per
 * line. Two processes use it — a worker that is about to be killed and the
 * parent that reconciles afterwards — which is the whole reason it exists: the
 * in-memory journal above cannot survive the `SIGKILL` that makes the matrix
 * meaningful, and the boundary "after the journal, before the write" is
 * unobservable without a row that outlives the process that wrote it.
 */

/** One durable line of the log. */
type JournalLogEntry =
  | { readonly op: 'append'; readonly record: unknown }
  | {
      readonly op: 'status';
      readonly id: string;
      readonly status: ModificationStatus;
      readonly patch: ModificationStatusPatch | null;
    }
  | { readonly op: 'crash'; readonly at: string }
  | { readonly op: 'finished'; readonly ok: boolean };

/** The journal, plus the log-level questions a case asks of it. */
interface FileJournal extends ModificationJournal {
  /** Where the log lives. */
  readonly path: string;

  /** Every record the log describes, in append order, at its current status. */
  rows(): ModificationRecord[];

  /** The boundary the worker died at, when it recorded one. */
  crashPoint(): string | undefined;

  /** Whether the worker reached the end of the sequence. */
  finished(): boolean;
}

/** The log path for a sandbox, inside its private `$DEBUGGEN_HOME`. */
function journalPathFor(sandbox: Sandbox): string {
  return join(sandbox.debuggenHome, 'modifications.jsonl');
}

/**
 * Appends one line and flushes it to the platform before returning.
 *
 * `fsync` rather than a bare write, because the process that wrote the line is
 * about to be killed: a line still sitting in a buffer would make a crash after
 * the journal append look exactly like a crash before it.
 */
function appendJournalLine(path: string, entry: JournalLogEntry): void {
  const fd = openSync(path, 'a', 0o600);

  try {
    writeSync(fd, `${JSON.stringify(entry)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Every line of the log, or none when nothing has been written yet. */
function readJournalLog(path: string): JournalLogEntry[] {
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JournalLogEntry);
}

/** The fields a status transition may legitimately revise, as an object. */
function appliedPatch(patch: ModificationStatusPatch | null): Partial<ModificationRecord> {
  if (patch === null) {
    return {};
  }

  return {
    ...(patch.instrumentedHash !== undefined ? { instrumentedHash: patch.instrumentedHash } : {}),
    ...(patch.diff !== undefined ? { diff: patch.diff } : {}),
    ...(patch.appliedAt !== undefined ? { appliedAt: patch.appliedAt } : {}),
    ...(patch.backupPath !== undefined ? { backupPath: patch.backupPath } : {}),
  };
}

/**
 * Replays the log into the records it describes.
 *
 * Every appended line is put through `parseModificationRecord`, so a row that
 * crossed a process boundary as JSON is also proven to satisfy
 * `modificationRecordSchema` — which is what the service's store does with a
 * row it reads back, and the cheapest place to catch a record the sequence
 * journaled in a shape no consumer would accept.
 */
function replayJournalLog(entries: readonly JournalLogEntry[]): ModificationRecord[] {
  const rows: ModificationRecord[] = [];

  for (const entry of entries) {
    if (entry.op === 'append') {
      const parsed = parseModificationRecord(entry.record);

      if (isErr(parsed)) {
        throw new Error(
          `The journal log holds an appended line that is not a modification record: ${parsed.error.message} ${JSON.stringify(parsed.error.details)}`,
        );
      }

      rows.push(parsed.value);
      continue;
    }

    if (entry.op === 'status') {
      const index = rows.findIndex((row) => row.id === entry.id);
      const current = rows[index];

      if (current === undefined) {
        throw new Error(`The journal log moves a record it never appended: ${entry.id}`);
      }

      rows[index] = { ...current, ...appliedPatch(entry.patch), status: entry.status };
    }
  }

  return rows;
}

/**
 * Opens the journal over an existing log, replaying whatever is in it.
 *
 * Constructed *after* a worker has run, so the parent's view starts from the
 * rows the killed process left behind. Its own mutations are appended to the
 * same log and flushed, so a second journal opened over the same path sees
 * them — which is how the idempotence case proves the first pass persisted.
 */
function openFileJournal(path: string): FileJournal {
  const entries = readJournalLog(path);
  const rows = replayJournalLog(entries);
  const clone = (record: ModificationRecord): ModificationRecord => ({ ...record });

  return {
    path,
    rows: () => rows.map(clone),
    crashPoint: () => {
      const crash = readJournalLog(path).find((entry) => entry.op === 'crash');

      return crash?.op === 'crash' ? crash.at : undefined;
    },
    finished: () => readJournalLog(path).some((entry) => entry.op === 'finished'),
    append: (record: ModificationRecord): Promise<Result<ModificationRecord>> => {
      appendJournalLine(path, { op: 'append', record });
      rows.push(clone(record));

      return Promise.resolve(ok(clone(record)));
    },
    updateStatus: (
      id: string,
      status: ModificationStatus,
      patch?: ModificationStatusPatch,
    ): Promise<Result<ModificationRecord>> => {
      const index = rows.findIndex((row) => row.id === id);
      const current = rows[index];

      if (current === undefined) {
        return Promise.resolve(
          err(
            new DebuggenError('STORE_ERROR', 'No modification record with that id.', {
              hint: 'The journal was asked to move a record it never appended.',
              details: { recordId: id },
            }),
          ),
        );
      }

      appendJournalLine(path, { op: 'status', id, status, patch: patch ?? null });

      const updated: ModificationRecord = {
        ...current,
        ...appliedPatch(patch ?? null),
        status,
      };

      rows[index] = updated;

      return Promise.resolve(ok(clone(updated)));
    },
    listBySession: (sessionId: string): Promise<Result<ModificationRecord[]>> =>
      Promise.resolve(ok(rows.filter((row) => row.sessionId === sessionId).map(clone))),
    // Everything except `reverted`, which is the port's contract and what
    // `reconcileModifications` relies on: a `conflict` row must keep coming
    // back, and a `pending` row left by a crash must be found whatever state
    // its session ended in.
    listOpen: (): Promise<Result<ModificationRecord[]>> =>
      Promise.resolve(ok(rows.filter((row) => row.status !== 'reverted').map(clone))),
  };
}

/*
 * ---------------------------------------------------------------------------
 * The fresh-process harness
 * ---------------------------------------------------------------------------
 */

/**
 * The five boundaries of AAP §0.5.1's failure-injection matrix, each mapped to
 * the stage whose completion is the kill signal.
 *
 * One table rather than a list beside a map, so a boundary cannot be named in
 * one place and missing from the other.
 *
 * `'mid-replace'` maps to no stage on purpose: it lives *inside* step 5,
 * between the temporary file being written and the new entry being installed,
 * which no stage boundary can express — the worker reaches it through
 * `atomicReplaceFileIfUnchanged`'s own `onBeforeInstall` seam instead.
 */
const CRASH_STAGE = Object.freeze({
  'after-backup': 'store-backup',
  'after-journal': 'journal-pending',
  'mid-replace': '',
  'after-rename': 'replace-file',
  'after-mark': 'mark-applied',
} as const satisfies Readonly<Record<string, PatchStage | ''>>);

/** One boundary of {@link CRASH_STAGE}. */
type CrashPoint = keyof typeof CRASH_STAGE;

/**
 * The worker, generated into the case's temporary directory and run by `tsx`.
 *
 * Plain JavaScript in a `.mts` file: `tsx` compiles it as an ES module, so
 * top-level `await` works, and nothing here needs a type annotation that a
 * transform would only erase. It imports `./patcher.ts` and
 * `./backup-store.ts` by absolute `file://` URL — their own bare imports
 * (`@debuggen/shared`, `ts-morph`, `diff`) resolve from *their* location, so
 * the worker needs no `node_modules` of its own and never touches `dist/`.
 *
 * `process.kill(process.pid, 'SIGKILL')` rather than `process.exit`: `exit`
 * runs `'exit'` listeners and flushes what it can, and the guarantee under test
 * is that nothing ran. The journal is written and flushed before the signal, so
 * the log is exactly as durable as the sequence made it.
 */
const CRASH_WORKER_SOURCE = `
// Generated by packages/instrumentation/src/patch/patcher.test.ts. Not committed.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';

const NEWLINE = String.fromCharCode(10);
const config = JSON.parse(process.argv[2]);

const { createPatcher, defaultPatchFileSystem } = await import(config.patcherUrl);
const { createBackupStore } = await import(config.backupStoreUrl);

const appendLine = (entry) => {
  const fd = openSync(config.journalPath, 'a', 0o600);
  try {
    writeSync(fd, JSON.stringify(entry) + NEWLINE);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

const rows = [];

if (existsSync(config.journalPath)) {
  for (const line of readFileSync(config.journalPath, 'utf8').split(NEWLINE)) {
    if (line.trim().length === 0) continue;
    const entry = JSON.parse(line);
    if (entry.op === 'append') rows.push(entry.record);
    if (entry.op === 'status') {
      const index = rows.findIndex((row) => row.id === entry.id);
      if (index >= 0) {
        rows[index] = { ...rows[index], ...(entry.patch || {}), status: entry.status };
      }
    }
  }
}

const die = (at) => {
  appendLine({ op: 'crash', at });
  process.kill(process.pid, 'SIGKILL');
};

const journal = {
  append: (record) => {
    appendLine({ op: 'append', record });
    rows.push(record);
    return Promise.resolve({ ok: true, value: record });
  },
  updateStatus: (id, status, patch) => {
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) {
      return Promise.resolve({ ok: false, error: new Error('unknown record ' + id) });
    }
    appendLine({ op: 'status', id, status, patch: patch || null });
    const updated = { ...rows[index], ...(patch || {}), status };
    rows[index] = updated;
    return Promise.resolve({ ok: true, value: updated });
  },
  listBySession: (sessionId) =>
    Promise.resolve({
      ok: true,
      value: rows.filter((row) => row.sessionId === sessionId).map((row) => ({ ...row })),
    }),
  listOpen: () =>
    Promise.resolve({
      ok: true,
      value: rows.filter((row) => row.status !== 'reverted').map((row) => ({ ...row })),
    }),
};

const files = {
  ...defaultPatchFileSystem,
  replaceFileIfUnchanged: (path, content, expected) =>
    defaultPatchFileSystem.replaceFileIfUnchanged(
      path,
      content,
      expected,
      config.crashAt === 'mid-replace' ? { onBeforeInstall: () => die('mid-replace') } : undefined,
    ),
};

const patcher = createPatcher({
  projectRoot: config.projectRoot,
  sessionId: config.sessionId,
  planVersion: config.planVersion,
  backups: createBackupStore({ debuggenHome: config.debuggenHome, sessionId: config.sessionId }),
  journal,
  files,
  onStage: (event) => {
    if (config.crashStage !== '' && event.stage === config.crashStage) {
      die(config.crashAt);
    }
  },
});

const result = await patcher.patchTarget({ file: config.file, symbol: config.symbol });

appendLine({ op: 'finished', ok: result.ok === true });
process.exit(result.ok === true ? 0 : 3);
`;

/** The `tsx` CLI, resolved from this file so the root's pinned copy is used. */
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

/** What the parent asks a worker to do. */
interface CrashRunOptions {
  /** The file to patch, project-relative POSIX. */
  readonly file: string;

  /** The symbol to wrap. */
  readonly symbol: string;

  /** Where the worker dies. */
  readonly crashAt: CrashPoint;

  /** The plan version to stamp the record with. Defaults to 1. */
  readonly planVersion?: number | undefined;
}

/** How a worker ended. */
interface CrashRun {
  /** The signal that killed it, when a signal did. */
  readonly signal: string | null;

  /** Its exit code, when it exited. */
  readonly code: number | null;

  /** Whatever it wrote to stderr, for a failure message worth reading. */
  readonly stderr: string;
}

/**
 * Runs the real sequence in a fresh process and kills it at `crashAt`.
 *
 * Bounded: a worker that has not ended within {@link WORKER_TIMEOUT_MS} is
 * killed and the call throws, so a hung child fails its own case instead of
 * stalling the suite. Every child is awaited to `'close'`, so none is left
 * unreaped when the case returns.
 *
 * @returns How the worker ended, after asserting that it ended abruptly.
 */
async function killDuringPatch(sandbox: Sandbox, options: CrashRunOptions): Promise<CrashRun> {
  const workerPath = join(caseRoot, `crash-worker-${options.crashAt}-${options.symbol}.mts`);

  writeFileSync(workerPath, CRASH_WORKER_SOURCE, { mode: 0o600 });

  const here = dirname(fileURLToPath(import.meta.url));
  const config = {
    patcherUrl: pathToFileURL(join(here, 'patcher.ts')).href,
    backupStoreUrl: pathToFileURL(join(here, 'backup-store.ts')).href,
    projectRoot: sandbox.projectRoot,
    debuggenHome: sandbox.debuggenHome,
    sessionId: sandbox.sessionId,
    journalPath: journalPathFor(sandbox),
    file: options.file,
    symbol: options.symbol,
    planVersion: options.planVersion ?? 1,
    crashAt: options.crashAt,
    crashStage: CRASH_STAGE[options.crashAt],
  };

  const child = spawn(process.execPath, [TSX_CLI, workerPath, JSON.stringify(config)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdout?.resume();

  const ended = await new Promise<CrashRun>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `The crash worker for '${options.crashAt}' did not end within ${WORKER_TIMEOUT_MS} ms. stderr: ${stderr}`,
        ),
      );
    }, WORKER_TIMEOUT_MS);

    child.once('error', (cause: Error) => {
      clearTimeout(timer);
      reject(cause);
    });

    child.once('close', (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });

  // The kill has to have been abrupt for the case to mean anything: a worker
  // that exited normally ran its own teardown, and then "no handler cleaned up
  // after us" is untested. 137 is the shell's spelling of the same signal, for
  // a host that reports the code rather than the signal.
  if (ended.signal !== 'SIGKILL' && ended.code !== 137) {
    throw new Error(
      `The crash worker for '${options.crashAt}' was expected to die by SIGKILL; it ended with code ${String(ended.code)} and signal ${String(ended.signal)}. stderr: ${ended.stderr}`,
    );
  }

  return ended;
}

/*
 * ---------------------------------------------------------------------------
 * Reconciliation, and watching it dispose of a backup
 * ---------------------------------------------------------------------------
 */

/** One observed call into the backup store during a reconciliation pass. */
interface BackupEvent {
  /** Which operation. */
  readonly op: 'read' | 'remove';

  /** The digest the backup is filed under. */
  readonly originalHash: string;

  /** What the caller said it had restored, for `remove`. */
  readonly restoredContentHash: string | undefined;

  /** What the target file hashed to at the moment of the call. */
  readonly targetDigest: string | undefined;
}

/**
 * Wraps a backup store so the order of "restore, verify, then delete" is
 * observable.
 *
 * AAP §0.5.1 requires the backup to be deleted only *after* the restored
 * content has been verified against `originalHash`. An implementation that
 * deleted first and restored second would leave the same end state, so the end
 * state cannot prove the ordering: this records what the target file held at
 * the instant `remove` was called, and `remove`'s own
 * `restoredContentHash` argument, which is the verification being demanded.
 * The record-path operations (`readRecorded`, `removeRecorded`) — the route
 * cleanup takes, since it reads and deletes the backup the journal names —
 * record the same events as their digest-keyed counterparts.
 */
function recordingBackupStore(
  store: BackupStore,
  targetPath: string,
  events: BackupEvent[],
): BackupStore {
  const digest = (): string | undefined =>
    existsSync(targetPath) ? digestOnDisk(targetPath) : undefined;

  return {
    sessionId: store.sessionId,
    sessionDirectory: store.sessionDirectory,
    locate: (originalHash: string) => store.locate(originalHash),
    locateRecorded: (recordedPath: string, originalHash: string) =>
      store.locateRecorded(recordedPath, originalHash),
    put: (originalHash: string, content: Uint8Array): Promise<Result<StoredBackup>> =>
      store.put(originalHash, content),
    read: (originalHash: string): Promise<Result<Buffer>> => {
      events.push({
        op: 'read',
        originalHash,
        restoredContentHash: undefined,
        targetDigest: digest(),
      });

      return store.read(originalHash);
    },
    readRecorded: (recordedPath: string, originalHash: string): Promise<Result<RecordedBackup>> => {
      events.push({
        op: 'read',
        originalHash,
        restoredContentHash: undefined,
        targetDigest: digest(),
      });

      return store.readRecorded(recordedPath, originalHash);
    },
    has: (originalHash: string) => store.has(originalHash),
    verify: (originalHash: string) => store.verify(originalHash),
    remove: (originalHash: string, options?: RemoveBackupOptions): Promise<Result<boolean>> => {
      events.push({
        op: 'remove',
        originalHash,
        restoredContentHash: options?.restoredContentHash,
        targetDigest: digest(),
      });

      return store.remove(originalHash, options);
    },
    removeRecorded: (
      recordedPath: string,
      originalHash: string,
      options?: RemoveBackupOptions,
    ): Promise<Result<boolean>> => {
      events.push({
        op: 'remove',
        originalHash,
        restoredContentHash: options?.restoredContentHash,
        targetDigest: digest(),
      });

      return store.removeRecorded(recordedPath, originalHash, options);
    },
    removeSessionDirectory: () => store.removeSessionDirectory(),
  };
}

/** What one reconciliation pass did, and what it did to the backup tree. */
interface ReconcilePass {
  /** The pass's own result. */
  readonly outcome: ReconcileOutcome;

  /** Every backup-store call it made, in order. */
  readonly backupEvents: BackupEvent[];

  /** The journal it ran against, now holding the statuses it wrote. */
  readonly journal: FileJournal;
}

/**
 * Runs the **real** reconciliation of `../cleanup.ts` over a sandbox.
 *
 * The journal is opened fresh from the log each time, so the pass reads exactly
 * the rows a killed worker left durable rather than anything this process still
 * remembers.
 */
async function reconcileSandbox(sandbox: Sandbox, targetPath: string): Promise<ReconcilePass> {
  const journal = openFileJournal(journalPathFor(sandbox));
  const backupEvents: BackupEvent[] = [];
  const backups = recordingBackupStore(
    createBackupStore({ debuggenHome: sandbox.debuggenHome, sessionId: sandbox.sessionId }),
    targetPath,
    backupEvents,
  );

  const outcome = await reconcileModifications({
    projectRoot: sandbox.projectRoot,
    backups,
    journal,
  });

  return { outcome, backupEvents, journal };
}

/** The backup a record names, if it is still on disk. */
function backupExists(record: ModificationRecord): boolean {
  return existsSync(record.backupPath);
}

/**
 * Asserts the verification-before-deletion ordering for a restored record.
 *
 * Two things at once, both from the recorded call rather than the end state:
 * the deletion named the digest it had restored, and the file on disk already
 * held those bytes when the deletion was asked for.
 */
function expectBackupDeletedAfterVerification(
  events: readonly BackupEvent[],
  originalHash: string,
): void {
  const removal = events.find((event) => event.op === 'remove');

  expect(removal).toBeDefined();
  expect(removal?.restoredContentHash).toBe(originalHash);
  expect(removal?.targetDigest).toBe(originalHash);

  // And when bytes were restored at all, they were read out of the backup
  // before the deletion was asked for. A record closed because nothing was
  // written reads nothing — the comparison that closed it *is* the
  // verification — so the ordering is only asserted where a read happened.
  const readAt = events.findIndex((event) => event.op === 'read');

  if (readAt >= 0) {
    expect(readAt).toBeLessThan(events.findIndex((event) => event.op === 'remove'));
  }
}

/** The single record a journal holds, or a failed test saying what it holds. */
function onlyRow(journal: FileJournal): ModificationRecord {
  const rows = journal.rows();

  if (rows.length !== 1 || rows[0] === undefined) {
    throw new Error(
      `Expected exactly one journaled record, found ${rows.length}: ${JSON.stringify(rows.map((row) => ({ id: row.id, file: row.file, status: row.status })))}`,
    );
  }

  return rows[0];
}

/** A patch-mode function-timing action for a file and symbol. */
function patchAction(file: string, symbol: string): InstrumentationAction {
  return {
    id: newActionId(),
    file,
    symbol,
    type: 'function-timing',
    adapter: 'nextjs',
    mode: 'patch',
    rationale: 'The suite needs a patch-mode action for this symbol.',
  };
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
    // And nothing was copied into the session's backup tree either, which is
    // where the bytes of a file outside the project would have ended up.
    expect(existsSync(join(sandbox.debuggenHome, 'backups', sandbox.sessionId))).toBe(false);
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

/*
 * ---------------------------------------------------------------------------
 * The record and the backup the sequence leaves behind
 * ---------------------------------------------------------------------------
 *
 * The block above proves the *order* of the sequence. This one proves that what
 * it wrote down is usable by everything downstream of it: a backup filed where
 * the record says and private to this account, a record the schema accepts
 * whichever process reads it back, and a diff that really is the difference
 * between the two hashes it sits beside.
 */

describe('the journaled record and its backup', () => {
  it('files the original under a private backup directory it can hash back', async () => {
    const sandbox = makeSandbox();
    const { patcher, backups } = buildPatcher(sandbox);

    const outcome = appliedOutcome(
      await patcher.patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
    );

    // The path AAP §0.2.3 specifies, composed rather than reported: filed under
    // the digest, so two records that saw identical content share one copy and
    // the write is idempotent.
    const expectedPath = join(
      sandbox.debuggenHome,
      'backups',
      sandbox.sessionId,
      sandbox.originalHash,
    );

    expect(outcome.backup.path).toBe(expectedPath);
    expect(outcome.backup.originalHash).toBe(sandbox.originalHash);
    expect(outcome.backup.byteLength).toBe(sandbox.originalBytes.byteLength);
    expect(existsSync(expectedPath)).toBe(true);
    expect(sha256Hex(readFileSync(expectedPath))).toBe(sandbox.originalHash);
    expect(outcome.record.backupPath).toBe(expectedPath);

    // `0600` under `0700`: the developer's source is in there, so it is as
    // private as the state directory it lives in. Skipped where the host cannot
    // report an owner, the pattern `packages/shared/src/node/safe-fs.test.ts`
    // uses for the same reason.
    if (typeof process.getuid === 'function') {
      expect(permissionsOf(expectedPath)).toBe(0o600);
      expect(permissionsOf(dirname(expectedPath))).toBe(0o700);
      expect(permissionsOf(join(sandbox.debuggenHome, 'backups'))).toBe(0o700);
    }

    // And nothing else was put in there.
    expect(readdirSync(dirname(expectedPath))).toEqual([sandbox.originalHash]);
    const verified = await backups.verify(sandbox.originalHash);

    expect(isOk(verified)).toBe(true);
  });

  it('journals a record the schema accepts, with a minted id', async () => {
    const sandbox = makeSandbox();
    const { patcher, journal } = buildPatcher(sandbox);

    const outcome = appliedOutcome(
      await patcher.patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
    );

    // The record travels as JSON — into a SQLite text column, out through
    // `instrumentation.ready`, back into a cleanup pass — so what matters is
    // that the shape survives the round trip, not that this process holds a
    // typed value.
    const roundTripped = parseModificationRecord(
      JSON.parse(JSON.stringify(outcome.record)) as unknown,
    );

    expect(isOk(roundTripped)).toBe(true);
    expect(MODIFICATION_ID_PATTERN.test(outcome.record.id)).toBe(true);
    expect(outcome.record).toMatchObject({
      sessionId: sandbox.sessionId,
      planVersion: 1,
      file: TARGET_FILE,
      originalHash: sandbox.originalHash,
      instrumentedHash: outcome.instrumentedHash,
      status: 'applied',
    });
    // Refreshed at the `applied` transition, in the same epoch-millisecond
    // base as a telemetry event's `startTime`, so the two are comparable when
    // the session's modification list is read beside its capture.
    expect(outcome.record.appliedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(outcome.record.appliedAt).toBeLessThanOrEqual(Date.now());
    // A first record for a file carries no chain link at all, rather than a
    // null one: an absent key is the representation every layer agrees on.
    expect('previousRecordId' in outcome.record).toBe(false);
    expect(journal.rows[0]).toStrictEqual(outcome.record);
  });

  it('records a diff that turns the original into exactly what was installed', async () => {
    const sandbox = makeSandbox();
    const { patcher } = buildPatcher(sandbox);

    const outcome = appliedOutcome(
      await patcher.patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
    );

    const originalText = sandbox.originalBytes.toString('utf8');
    const installedText = readFileSync(sandbox.targetPath, 'utf8');

    expect(outcome.diffTruncated).toBe(false);
    // Applied, not merely inspected: this is the field both user interfaces
    // render as "what the tool did to my file", and a diff that does not
    // reconstruct the installed content is a lie told in a review panel.
    expect(applyPatch(originalText, outcome.record.diff)).toBe(installedText);
    // It describes *this* file and not whatever else it might fit: applied to
    // another of the fixture's sources there is no context to match.
    expect(
      applyPatch(readFileSync(join(sandbox.projectRoot, CHAIN_FILE), 'utf8'), outcome.record.diff),
    ).toBe(false);

    // Produced over the exact bytes that were hashed, with no
    // whitespace-insensitive option: every context line of the diff is a line
    // of the original verbatim, indentation included. A normalising diff would
    // hand the developer hunks that do not match their file.
    const originalLines = new Set(originalText.split('\n'));
    const contextLines = outcome.record.diff
      .split('\n')
      .filter((line) => line.startsWith(' ') && line.trim().length > 0)
      .map((line) => line.slice(1));

    expect(contextLines.length).toBeGreaterThan(0);
    expect(contextLines.filter((line) => !originalLines.has(line))).toEqual([]);

    expect(outcome.record.diff).toContain(TARGET_SYMBOL);
    expect(outcome.record.diff).toContain(SPAN_HELPER_GLOBAL);
  });
});

/*
 * ---------------------------------------------------------------------------
 * A process killed mid-sequence
 * ---------------------------------------------------------------------------
 *
 * AAP §0.5.1's failure-injection matrix, in full. Five boundaries, each in its
 * own process, each killed with `SIGKILL` so nothing in that process could have
 * tidied up after it, and each followed by the real `reconcileModifications`
 * from `../cleanup.ts` over the journal the dead process left on disk.
 *
 * The assertion that matters is the same one every time and it is about bytes,
 * not statuses: the developer's file is exactly what it was. The statuses are
 * asserted too, because they are how a human is told what happened, and because
 * a pass that restored the right bytes by luck rather than by reading the table
 * would get them wrong.
 */

describe('a process killed mid-sequence', () => {
  it(
    'leaves an orphaned backup and an untouched file when it dies after the backup',
    async () => {
      const sandbox = makeSandbox();
      const pristine = pristineFile(sandbox, CHAIN_FILE);

      await killDuringPatch(sandbox, {
        file: CHAIN_FILE,
        symbol: CHAIN_FIRST_SYMBOL,
        crashAt: 'after-backup',
      });

      const before = openFileJournal(journalPathFor(sandbox));

      expect(before.crashPoint()).toBe('after-backup');
      expect(before.finished()).toBe(false);
      // No row at all: the backup is durable, but nothing has claimed a write
      // is in flight, and nothing was written.
      expect(before.rows()).toEqual([]);
      expectPristine(pristine);

      const backupPath = join(sandbox.debuggenHome, 'backups', sandbox.sessionId, pristine.hash);

      expect(existsSync(backupPath)).toBe(true);

      const pass = await reconcileSandbox(sandbox, pristine.path);

      // Nothing to reconcile, and nothing done: no record, so no pass may write
      // to the project on the strength of it.
      expect(pass.outcome.examined).toBe(0);
      expect(pass.outcome.status).toBe('clean');
      expect(pass.outcome.restored).toEqual([]);
      expect(pass.outcome.conflicts).toEqual([]);
      expect(pass.outcome.failures).toEqual([]);
      expect(pass.backupEvents).toEqual([]);
      expectPristine(pristine);

      // The orphan is deliberately left: reaping a backup with no record is
      // `apps/local-service/src/store/retention.ts`'s job, after seven days,
      // because a copy of the developer's source is the last thing to discard
      // on a guess.
      expect(existsSync(backupPath)).toBe(true);
      expect(temporaryLeftoversIn(dirname(pristine.path))).toEqual([]);
    },
    CRASH_CASE_TIMEOUT_MS,
  );

  it(
    'closes the pending record without writing when it dies after the journal',
    async () => {
      const sandbox = makeSandbox();
      const pristine = pristineFile(sandbox, CHAIN_FILE);

      await killDuringPatch(sandbox, {
        file: CHAIN_FILE,
        symbol: CHAIN_FIRST_SYMBOL,
        crashAt: 'after-journal',
      });

      const before = openFileJournal(journalPathFor(sandbox));
      const pending = onlyRow(before);

      // The row that makes every later crash decidable, exactly as AAP §0.5.1
      // requires it: both hashes, the backup path and the diff, written while
      // the file still holds the developer's bytes.
      expect(before.crashPoint()).toBe('after-journal');
      expect(pending.status).toBe('pending');
      expect(pending.originalHash).toBe(pristine.hash);
      expect(pending.instrumentedHash).not.toBe(pristine.hash);
      expect(pending.file).toBe(CHAIN_FILE);
      expect(pending.diff.length).toBeGreaterThan(0);
      expect(backupExists(pending)).toBe(true);
      expectPristine(pristine);

      const mtimeBefore = statSync(pristine.path).mtimeMs;
      const pass = await reconcileSandbox(sandbox, pristine.path);

      // "Nothing was written" is the branch, and `closed` rather than
      // `restored` is how the table says so: a pass that wrote the backup back
      // over an identical file would be indistinguishable in content and wrong
      // in what it told the developer.
      expect(pass.outcome.status).toBe('clean');
      expect(pass.outcome.closed.map((record) => record.id)).toEqual([pending.id]);
      expect(pass.outcome.restored).toEqual([]);
      expect(pass.outcome.conflicts).toEqual([]);
      expect(onlyRow(pass.journal).status).toBe('reverted');
      expect(statSync(pristine.path).mtimeMs).toBe(mtimeBefore);
      expectPristine(pristine);

      // The bytes on disk already hashed to `originalHash`, which *is* the
      // verification the deletion requires, so the backup may go.
      expectBackupDeletedAfterVerification(pass.backupEvents, pristine.hash);
      expect(backupExists(pending)).toBe(false);
    },
    CRASH_CASE_TIMEOUT_MS,
  );

  it(
    'recreates the target from the backup when it dies inside the replacement',
    async () => {
      const sandbox = makeSandbox();
      const pristine = pristineFile(sandbox, CHAIN_FILE);

      await killDuringPatch(sandbox, {
        file: CHAIN_FILE,
        symbol: CHAIN_FIRST_SYMBOL,
        crashAt: 'mid-replace',
      });

      const before = openFileJournal(journalPathFor(sandbox));
      const pending = onlyRow(before);

      expect(before.crashPoint()).toBe('mid-replace');
      expect(pending.status).toBe('pending');
      expect(pending.originalHash).toBe(pristine.hash);

      // The state an abrupt kill inside `atomicReplaceFileIfUnchanged` leaves,
      // documented rather than wished away: the primitive renames the displaced
      // entry aside *before* installing the new one, so a `SIGKILL` in that
      // interval leaves the target momentarily absent with two temporary
      // siblings — the patched content and the retained original — and no
      // chance to remove either. Nothing is lost, because the original is also
      // in the backup, which is what the pass restores from.
      expect(existsSync(pristine.path)).toBe(false);
      expect(temporaryLeftoversIn(dirname(pristine.path)).length).toBeGreaterThan(0);
      expect(backupExists(pending)).toBe(true);

      const pass = await reconcileSandbox(sandbox, pristine.path);

      expect(pass.outcome.status).toBe('clean');
      expect(pass.outcome.restored.map((record) => record.id)).toEqual([pending.id]);
      expect(pass.outcome.conflicts).toEqual([]);
      expect(pass.outcome.failures).toEqual([]);
      expect(onlyRow(pass.journal).status).toBe('reverted');

      // A real file at the target path, holding the developer's exact bytes -
      // not a temporary sibling standing in for it.
      expect(lstatSync(pristine.path).isFile()).toBe(true);
      expectPristine(pristine);
      expectBackupDeletedAfterVerification(pass.backupEvents, pristine.hash);
    },
    CRASH_CASE_TIMEOUT_MS,
  );

  it(
    'restores from the backup when it dies after the rename and before the mark',
    async () => {
      // The case the whole ordering of steps 4 and 5 exists for. The patch is
      // on disk and no record says so beyond `pending` — and because the row
      // already carries `instrumentedHash`, reconciliation can tell that from
      // "nothing was written" and from "the developer changed it", and restore.
      const sandbox = makeSandbox();
      const pristine = pristineFile(sandbox, CHAIN_FILE);

      await killDuringPatch(sandbox, {
        file: CHAIN_FILE,
        symbol: CHAIN_FIRST_SYMBOL,
        crashAt: 'after-rename',
      });

      const before = openFileJournal(journalPathFor(sandbox));
      const pending = onlyRow(before);

      expect(before.crashPoint()).toBe('after-rename');
      // Never marked applied: the sequence marks only after the rename has
      // returned, and this process did not get that far.
      expect(pending.status).toBe('pending');
      expect(digestOnDisk(pristine.path)).toBe(pending.instrumentedHash);
      expect(readFileSync(pristine.path, 'utf8')).toContain(SPAN_HELPER_GLOBAL);

      const pass = await reconcileSandbox(sandbox, pristine.path);

      expect(pass.outcome.status).toBe('clean');
      expect(pass.outcome.restored.map((record) => record.id)).toEqual([pending.id]);
      expect(pass.outcome.closed).toEqual([]);
      expect(pass.outcome.conflicts).toEqual([]);
      expect(onlyRow(pass.journal).status).toBe('reverted');

      // Byte identity, by raw comparison as well as by digest, so a mistake in
      // hashing cannot hide a mistake in content.
      expectFileBytes(pristine.path, pristine.bytes);
      expect(Buffer.compare(readFileSync(pristine.path), pristine.bytes)).toBe(0);
      expect(readFileSync(pristine.path, 'utf8')).not.toContain(SPAN_HELPER_GLOBAL);
      expect(digestOnDisk(pristine.path)).toBe(pristine.hash);

      expectBackupDeletedAfterVerification(pass.backupEvents, pristine.hash);
      expect(backupExists(pending)).toBe(false);
      expect(temporaryLeftoversIn(dirname(pristine.path))).toEqual([]);
    },
    CRASH_CASE_TIMEOUT_MS,
  );

  it(
    'restores an applied record when it dies after the mark',
    async () => {
      const sandbox = makeSandbox();
      const pristine = pristineFile(sandbox, CHAIN_FILE);

      await killDuringPatch(sandbox, {
        file: CHAIN_FILE,
        symbol: CHAIN_FIRST_SYMBOL,
        crashAt: 'after-mark',
      });

      const before = openFileJournal(journalPathFor(sandbox));
      const applied = onlyRow(before);

      // The ordinary end of a session that never got to end: the record says
      // what the disk says, and the session died anyway. AAP §0.5.1 requires
      // the next service start to act on it whatever state the session is in.
      expect(before.crashPoint()).toBe('after-mark');
      expect(applied.status).toBe('applied');
      expect(applied.appliedAt).toBeGreaterThan(0);
      expect(digestOnDisk(pristine.path)).toBe(applied.instrumentedHash);

      const pass = await reconcileSandbox(sandbox, pristine.path);

      expect(pass.outcome.status).toBe('clean');
      expect(pass.outcome.restored.map((record) => record.id)).toEqual([applied.id]);
      expect(onlyRow(pass.journal).status).toBe('reverted');
      expectPristine(pristine);
      expectBackupDeletedAfterVerification(pass.backupEvents, pristine.hash);
    },
    CRASH_CASE_TIMEOUT_MS,
  );

  it(
    'reconciles the same crash twice without writing a second time',
    async () => {
      // A service can be started twice, and a pass can be interrupted and run
      // again. The second pass must find nothing to do — and find it in the
      // journal on disk, not in this process's memory, which is why the pass
      // helper opens the log afresh each time.
      const sandbox = makeSandbox();
      const pristine = pristineFile(sandbox, CHAIN_FILE);

      await killDuringPatch(sandbox, {
        file: CHAIN_FILE,
        symbol: CHAIN_FIRST_SYMBOL,
        crashAt: 'after-mark',
      });

      const first = await reconcileSandbox(sandbox, pristine.path);

      expect(first.outcome.restored).toHaveLength(1);
      expectPristine(pristine);

      const mtimeAfterFirst = statSync(pristine.path).mtimeMs;
      const second = await reconcileSandbox(sandbox, pristine.path);

      expect(second.outcome.examined).toBe(0);
      expect(second.outcome.status).toBe('clean');
      expect(second.outcome.restored).toEqual([]);
      expect(second.outcome.closed).toEqual([]);
      expect(second.outcome.conflicts).toEqual([]);
      expect(second.outcome.failures).toEqual([]);
      // No write at all the second time: the record is `reverted`, which the
      // table answers with "nothing to do" and which `listOpen` does not even
      // return.
      expect(second.backupEvents).toEqual([]);
      expect(statSync(pristine.path).mtimeMs).toBe(mtimeAfterFirst);
      expectPristine(pristine);
      expect(onlyRow(second.journal).status).toBe('reverted');
    },
    CRASH_CASE_TIMEOUT_MS,
  );

  it(
    'reports a conflict and preserves the developer bytes when the file was edited after the crash',
    async () => {
      // The interleaving AAP §0.5.5 promises an answer for: the patch landed,
      // the process died, and the developer then edited the instrumented file
      // before anything reconciled it. The bytes on disk are theirs and
      // nothing may overwrite them — not even a restore that believes it is
      // helping.
      const sandbox = makeSandbox();
      const pristine = pristineFile(sandbox, CHAIN_FILE);

      await killDuringPatch(sandbox, {
        file: CHAIN_FILE,
        symbol: CHAIN_FIRST_SYMBOL,
        crashAt: 'after-rename',
      });

      const pending = onlyRow(openFileJournal(journalPathFor(sandbox)));
      const developerBytes = Buffer.from(
        `${readFileSync(pristine.path, 'utf8')}\n// edited before anything reconciled this\n`,
        'utf8',
      );

      writeFileSync(pristine.path, developerBytes);

      const pass = await reconcileSandbox(sandbox, pristine.path);

      expect(pass.outcome.status).toBe('conflict');
      expect(pass.outcome.restored).toEqual([]);
      expect(pass.outcome.conflicts).toHaveLength(1);

      const conflict = pass.outcome.conflicts[0];

      expect(conflict).toMatchObject({
        recordId: pending.id,
        sessionId: sandbox.sessionId,
        file: CHAIN_FILE,
        reason: 'content-changed',
        expectedHash: pending.instrumentedHash,
        backupPath: pending.backupPath,
      });
      expect(conflict?.actualHash).toBe(sha256Hex(developerBytes));
      expect(conflict?.message.length).toBeGreaterThan(0);

      // Their bytes, exactly, and the original still recoverable from the
      // backup the conflict points them at.
      expectFileBytes(pristine.path, developerBytes);
      expect(onlyRow(pass.journal).status).toBe('conflict');
      expect(backupExists(pending)).toBe(true);
      expect(sha256Hex(readFileSync(pending.backupPath))).toBe(pristine.hash);

      // And a second pass keeps reporting it rather than deciding for them.
      const again = await reconcileSandbox(sandbox, pristine.path);

      expect(again.outcome.status).toBe('conflict');
      expect(again.outcome.retained.map((record) => record.id)).toEqual([pending.id]);
      expectFileBytes(pristine.path, developerBytes);
      expect(backupExists(pending)).toBe(true);
    },
    CRASH_CASE_TIMEOUT_MS,
  );
});

/*
 * ---------------------------------------------------------------------------
 * A chain over one file, unwound in reverse
 * ---------------------------------------------------------------------------
 *
 * A follow-up question produces plan version n + 1 as the previous plan plus
 * additive actions (AAP §0.4.2), and a delta action can land on a file an
 * earlier version already patched. The later record's baseline is then the
 * earlier record's *output*, its backup holds already-instrumented bytes, and
 * only an unwind in strict reverse order lands on the developer's original —
 * with each step verified against that record's own `instrumentedHash` before
 * anything is written.
 */

describe('a chain of plan versions over one file', () => {
  it('layers the second record on the first and unwinds to the original bytes', async () => {
    const sandbox = makeSandbox();
    const pristine = pristineFile(sandbox, CHAIN_FILE);
    const journal = openFileJournal(journalPathFor(sandbox));
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
      }).patchTarget({ file: CHAIN_FILE, symbol: CHAIN_FIRST_SYMBOL }),
    );

    // What plan version 1 left on disk: the bytes plan version 2 is about to
    // treat as its baseline, and the bytes its backup must hold.
    const afterFirst = readFileSync(pristine.path);

    expect(sha256Hex(afterFirst)).toBe(first.instrumentedHash);

    const second = appliedOutcome(
      await createPatcher({
        projectRoot: sandbox.projectRoot,
        sessionId: sandbox.sessionId,
        planVersion: 2,
        backups,
        journal,
      }).patchTarget({ file: CHAIN_FILE, symbol: CHAIN_SECOND_SYMBOL }),
    );

    // The chain's wiring, read from the journal rather than from the outcome,
    // because the journal is what a cleanup pass will see.
    const rows = journal.rows();

    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe(first.record.id);
    expect(rows[1]?.previousRecordId).toBe(first.record.id);
    expect(rows[1]?.originalHash).toBe(first.instrumentedHash);
    expect(rows[1]?.planVersion).toBe(2);

    // Applying plan 2 left plan 1's record exactly as it was: a delta install
    // adds, it never edits or drops what an earlier version recorded.
    expect(rows[0]).toStrictEqual(first.record);

    // And plan 2's backup holds the already-instrumented bytes, which is
    // correct: those are the bytes it replaced.
    const chainedBackup = await backups.read(second.originalHash);

    expect(isOk(chainedBackup)).toBe(true);
    if (isOk(chainedBackup)) {
      expect(Buffer.compare(chainedBackup.value, afterFirst)).toBe(0);
    }

    // Two distinct backups: the developer's original and the first patch's
    // output, each filed under its own digest.
    expect(readdirSync(join(sandbox.debuggenHome, 'backups', sandbox.sessionId)).sort()).toEqual(
      [pristine.hash, first.instrumentedHash].sort(),
    );

    const pass = await reconcileSandbox(sandbox, pristine.path);

    expect(pass.outcome.status).toBe('clean');
    expect(pass.outcome.restored).toHaveLength(2);
    expect(pass.outcome.conflicts).toEqual([]);
    expect(pass.outcome.failures).toEqual([]);

    // Strict reverse order, observed rather than assumed: the pass read plan
    // 2's backup — the one filed under the first patch's digest — before plan
    // 1's. The other order would try to write the developer's original over a
    // file holding two patches, find a hash it did not expect, and report a
    // conflict where there is none.
    // Collapsed to the order the two backups were *first* reached, because a
    // record's backup is legitimately read more than once — once for the
    // restore-versus-conflict decision and once for the bytes.
    const reads = pass.backupEvents
      .filter((event) => event.op === 'read')
      .map((event) => event.originalHash)
      .filter((hash, index, all) => all.indexOf(hash) === index);

    expect(reads).toEqual([second.originalHash, first.originalHash]);
    expect(pass.journal.rows().map((row) => row.status)).toEqual(['reverted', 'reverted']);

    // The developer's file, byte for byte, after two patches and two restores.
    expectFileBytes(pristine.path, pristine.bytes);
    expect(Buffer.compare(readFileSync(pristine.path), pristine.bytes)).toBe(0);

    // Both copies of the developer's content are gone, each after its own
    // restore was verified. The session directory itself is left behind by a
    // reconciliation pass — removing it belongs to `cleanupSession`, the
    // `session.end` entry point — so it is the files that are asserted, not the
    // directory.
    const sessionBackups = join(sandbox.debuggenHome, 'backups', sandbox.sessionId);

    expect(existsSync(sessionBackups) ? readdirSync(sessionBackups) : []).toEqual([]);
    expect(pass.journal.rows().filter(backupExists)).toEqual([]);
    expect(temporaryLeftoversIn(dirname(pristine.path))).toEqual([]);
  });

  it('refuses a second patch of a file that drifted after the first', async () => {
    // Pre-existing drift, which is not the same thing as a mid-sequence race:
    // the first patch is recorded and applied, and *then* the developer edits
    // the file. A second patch must not layer a record whose `originalHash`
    // describes bytes nobody can restore to, so it refuses before touching
    // anything.
    const sandbox = makeSandbox();
    const pristine = pristineFile(sandbox, CHAIN_FILE);
    const journal = openFileJournal(journalPathFor(sandbox));
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
      }).patchTarget({ file: CHAIN_FILE, symbol: CHAIN_FIRST_SYMBOL }),
    );

    const drifted = Buffer.from(
      `${readFileSync(pristine.path, 'utf8')}\n// the developer's own edit\n`,
      'utf8',
    );

    writeFileSync(pristine.path, drifted);

    const { files, log } = recordingFileSystem();
    const error = refusalOf(
      await createPatcher({
        projectRoot: sandbox.projectRoot,
        sessionId: sandbox.sessionId,
        planVersion: 2,
        backups,
        journal,
        files,
      }).patchTarget({ file: CHAIN_FILE, symbol: CHAIN_SECOND_SYMBOL }),
    );

    expect(error.code).toBe('MODIFICATION_CONFLICT');
    // Nothing written, nothing journaled, no new backup: the refusal is the
    // whole of the second attempt's effect.
    expect(log.writes).toEqual([]);
    expect(journal.rows()).toHaveLength(1);
    expect(journal.rows()[0]?.id).toBe(first.record.id);
    expect(readdirSync(join(sandbox.debuggenHome, 'backups', sandbox.sessionId))).toEqual([
      pristine.hash,
    ]);
    expectFileBytes(pristine.path, drifted);
  });

  it("records every layered record's position in the developer's own text", async () => {
    // A1-F01. Each later patch of a file is computed against bytes that already
    // carry the alias and the earlier wrappers, so a position read from them
    // lands below the line the developer — and the code graph — sees. The
    // position must be the one in the chain root's backup: the developer's
    // original.
    const sandbox = makeSandbox();
    const pristine = pristineFile(sandbox, TARGET_FILE);
    const developerText = pristine.bytes.toString('utf8');
    const journal = openFileJournal(journalPathFor(sandbox));
    const backups = createBackupStore({
      debuggenHome: sandbox.debuggenHome,
      sessionId: sandbox.sessionId,
    });
    const patchVersion = async (planVersion: number, symbol: string): Promise<PatchOutcome> =>
      appliedOutcome(
        await createPatcher({
          projectRoot: sandbox.projectRoot,
          sessionId: sandbox.sessionId,
          planVersion,
          backups,
          journal,
        }).patchTarget({ file: TARGET_FILE, symbol }),
      );

    const symbols = [TARGET_SYMBOL, 'findConeProfile', OTHER_SYMBOL] as const;
    const outcomes: PatchOutcome[] = [];

    for (const [index, symbol] of symbols.entries()) {
      outcomes.push(await patchVersion(index + 1, symbol));
    }

    expect(journal.rows().map((row) => row.previousRecordId)).toEqual([
      undefined,
      outcomes[0]?.record.id,
      outcomes[1]?.record.id,
    ]);

    for (const [index, symbol] of symbols.entries()) {
      const outcome = outcomes[index];
      const declaration = new RegExp(`^export function ${symbol}\\(`, 'mu').exec(developerText);

      expect(declaration, symbol).not.toBeNull();

      const nameOffset = (declaration?.index ?? 0) + 'export function '.length;
      const before = developerText.slice(0, nameOffset);

      expect({ line: outcome?.location.line, column: outcome?.location.column }, symbol).toEqual({
        line: before.split('\n').length,
        column: nameOffset - before.lastIndexOf('\n'),
      });

      // The literal in the file carries the same numbers, which is what the
      // span a capture records — and the panel's source link — is built from.
      expect(readFileSync(pristine.path, 'utf8'), symbol).toContain(
        `line: ${String(outcome?.location.line)}, column: ${String(outcome?.location.column)}, symbol: "${symbol}"`,
      );
    }

    // Reading the position from the root's backup changed nothing about the
    // bytes: the chain still unwinds to the developer's file exactly.
    const pass = await reconcileSandbox(sandbox, pristine.path);

    expect(pass.outcome.status).toBe('clean');
    expect(pass.outcome.restored).toHaveLength(3);
    expectFileBytes(pristine.path, pristine.bytes);
  });

  it('refuses a layered patch whose chain root can no longer be read, writing nothing', async () => {
    // Three links, because with two the parent *is* the root and its backup is
    // checked first by the baseline check. Here the parent's backup is intact
    // and the root's — the developer's original, the only text the position
    // can be read from — is gone.
    const sandbox = makeSandbox();
    const pristine = pristineFile(sandbox, TARGET_FILE);
    const journal = openFileJournal(journalPathFor(sandbox));
    const backups = createBackupStore({
      debuggenHome: sandbox.debuggenHome,
      sessionId: sandbox.sessionId,
    });
    const patcherFor = (planVersion: number, files?: PatchFileSystem): Patcher =>
      createPatcher({
        projectRoot: sandbox.projectRoot,
        sessionId: sandbox.sessionId,
        planVersion,
        backups,
        journal,
        ...(files !== undefined ? { files } : {}),
      });

    const first = appliedOutcome(
      await patcherFor(1).patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
    );

    appliedOutcome(
      await patcherFor(2).patchTarget({ file: TARGET_FILE, symbol: 'findConeProfile' }),
    );

    const beforeThird = readFileSync(pristine.path);

    rmSync(join(sandbox.debuggenHome, 'backups', sandbox.sessionId, first.originalHash));

    const { files, log } = recordingFileSystem();
    const error = refusalOf(
      await patcherFor(3, files).patchTarget({ file: TARGET_FILE, symbol: OTHER_SYMBOL }),
    );

    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.reason).toBe('chain-root-unreadable');
    expect(error.details?.cause).toBe('backup-unreadable');
    expect(typeof error.hint).toBe('string');
    expect(log.writes).toEqual([]);
    expect(journal.rows()).toHaveLength(2);
    expectFileBytes(pristine.path, beforeThird);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Journal reads along a chain
 * ---------------------------------------------------------------------------
 *
 * A chained patch needs the session's journal for two things: choosing the
 * parent — the last `applied` record for the file — and walking that parent's
 * ancestry back to the chain root, whose backup holds the developer's text.
 * Every listing carries each record in full, diffs included, so the walk runs
 * over the listing the parent was chosen from instead of a second one, a parent
 * that is itself the root needs no walk at all, and only a parent the caller
 * supplied — which nothing has listed — costs the walk a read of its own.
 *
 * These cases count the listings through a delegating probe and, by rewriting
 * what one listing returns, plant each broken ancestry the walk must still
 * refuse — so reusing the listing is proven to have kept every check the walk
 * made when it read its own.
 */

/** A delegating journal that counts its listings. */
interface ListingProbe {
  /** The journal to hand the patcher. */
  readonly journal: ModificationJournal;

  /** How many times `listBySession` has been called through this probe. */
  listings(): number;
}

/**
 * Wraps a journal so every `listBySession` call is counted and, optionally,
 * what it returns is rewritten.
 *
 * Delegating rather than replacing, like {@link recordingFileSystem}: appends
 * and status moves reach the real journal, so a rewrite changes only what the
 * patcher *reads* in one attempt — which is how a case plants a broken ancestry
 * the durable log never holds.
 */
function probeListings(
  inner: ModificationJournal,
  rewrite: (records: ModificationRecord[]) => Result<ModificationRecord[]> = (records) =>
    ok(records),
): ListingProbe {
  let calls = 0;

  return {
    journal: {
      append: (record) => inner.append(record),
      updateStatus: (id, status, patch) => inner.updateStatus(id, status, patch),
      listBySession: async (sessionId) => {
        calls += 1;

        const listed = await inner.listBySession(sessionId);

        return isErr(listed) ? listed : rewrite(listed.value);
      },
      listOpen: () => inner.listOpen(),
    },
    listings: () => calls,
  };
}

/** One chain case's world: a sandbox, its durable journal and its backup store. */
interface ChainWorld {
  /** The case's sandbox. */
  readonly sandbox: Sandbox;

  /** {@link TARGET_FILE} as the developer left it, before any patch. */
  readonly pristine: Pristine;

  /** The durable journal every plan version's records land in. */
  readonly journal: FileJournal;

  /** The session's backup store. */
  readonly backups: BackupStore;

  /**
   * A patcher for one plan version, reaching the journal through `through` —
   * {@link ChainWorld.journal} itself, or a probe over it.
   */
  patcherFor(planVersion: number, through: ModificationJournal, files?: PatchFileSystem): Patcher;
}

/** A {@link ChainWorld} over a fresh sandbox. */
function chainWorld(): ChainWorld {
  const sandbox = makeSandbox();
  const backups = createBackupStore({
    debuggenHome: sandbox.debuggenHome,
    sessionId: sandbox.sessionId,
  });

  return {
    sandbox,
    pristine: pristineFile(sandbox, TARGET_FILE),
    journal: openFileJournal(journalPathFor(sandbox)),
    backups,
    patcherFor: (planVersion, through, files) =>
      createPatcher({
        projectRoot: sandbox.projectRoot,
        sessionId: sandbox.sessionId,
        planVersion,
        backups,
        journal: through,
        ...(files !== undefined ? { files } : {}),
      }),
  };
}

/** The backup files the world's session holds, sorted. */
function sessionBackupsOf(world: ChainWorld): string[] {
  return readdirSync(join(world.sandbox.debuggenHome, 'backups', world.sandbox.sessionId)).sort();
}

/**
 * Asserts a patch recorded `symbol`'s position in the developer's own text —
 * the line and column of its name in {@link ChainWorld.pristine}, which is what
 * the root walk exists to supply — and wrote the same numbers into the file.
 */
function expectDeveloperPosition(world: ChainWorld, outcome: PatchOutcome, symbol: string): void {
  const developerText = world.pristine.bytes.toString('utf8');
  const declaration = new RegExp(`^export function ${symbol}\\(`, 'mu').exec(developerText);

  expect(declaration, symbol).not.toBeNull();

  const nameOffset = (declaration?.index ?? 0) + 'export function '.length;
  const before = developerText.slice(0, nameOffset);
  const line = before.split('\n').length;
  const column = nameOffset - before.lastIndexOf('\n');

  expect({ line: outcome.location.line, column: outcome.location.column }, symbol).toEqual({
    line,
    column,
  });
  expect(readFileSync(world.pristine.path, 'utf8'), symbol).toContain(
    `line: ${String(line)}, column: ${String(column)}, symbol: "${symbol}"`,
  );
}

/** The first two links of a chain over {@link TARGET_FILE}. */
interface TwoLinks {
  /** Plan version 1's outcome: the chain root. */
  readonly first: PatchOutcome;

  /** Plan version 2's outcome, layered on the root. */
  readonly second: PatchOutcome;
}

/** Lays {@link TwoLinks} through the journal directly, unprobed. */
async function layTwoLinks(world: ChainWorld): Promise<TwoLinks> {
  const first = appliedOutcome(
    await world
      .patcherFor(1, world.journal)
      .patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
  );
  const second = appliedOutcome(
    await world
      .patcherFor(2, world.journal)
      .patchTarget({ file: TARGET_FILE, symbol: 'findConeProfile' }),
  );

  expect(second.previousRecordId).toBe(first.record.id);

  return { first, second };
}

/**
 * Runs plan version 3 over {@link OTHER_SYMBOL} with its one listing
 * rewritten, and asserts the root walk refused it with `cause` having written
 * nothing: no project write, no journal row, no new backup, the file's bytes
 * as plan version 2 left them.
 *
 * The refusal is pinned to the walk, not merely to the attempt. It names plan
 * version 2's record as the parent — so the rewritten listing still chose it —
 * and `chain-root-unreadable` is produced only once that parent's baseline was
 * confirmed.
 */
async function expectRootWalkRefusal(
  world: ChainWorld,
  links: TwoLinks,
  rewrite: (records: ModificationRecord[]) => ModificationRecord[],
  cause: string,
): Promise<DebuggenError> {
  const beforeThird = readFileSync(world.pristine.path);
  const backupsBefore = sessionBackupsOf(world);
  const probe = probeListings(world.journal, (records) => ok(rewrite(records)));
  const { files, log } = recordingFileSystem();

  const error = refusalOf(
    await world
      .patcherFor(3, probe.journal, files)
      .patchTarget({ file: TARGET_FILE, symbol: OTHER_SYMBOL }),
  );

  expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
  expect(error.details?.reason).toBe('chain-root-unreadable');
  expect(error.details?.cause).toBe(cause);
  expect(error.details?.recordId).toBe(links.second.record.id);
  expect(typeof error.hint).toBe('string');
  expect(probe.listings()).toBe(1);

  expect(log.writes).toEqual([]);
  expect(world.journal.rows()).toHaveLength(2);
  expect(sessionBackupsOf(world)).toEqual(backupsBefore);
  expectFileBytes(world.pristine.path, beforeThird);

  return error;
}

describe('journal reads along a chain of plan versions', () => {
  it('lists the journal once per patch, however many links the chain already has', async () => {
    // The first patch has no parent, the second's parent is the root itself,
    // and the third walks one link — over the listing its parent came from,
    // where it used to list the session a second time.
    const world = chainWorld();
    const probe = probeListings(world.journal);
    const symbols = [TARGET_SYMBOL, 'findConeProfile', OTHER_SYMBOL] as const;
    const outcomes: PatchOutcome[] = [];

    for (const [index, symbol] of symbols.entries()) {
      const before = probe.listings();
      const outcome = appliedOutcome(
        await world.patcherFor(index + 1, probe.journal).patchTarget({ file: TARGET_FILE, symbol }),
      );

      expect(probe.listings() - before, symbol).toBe(1);
      expectDeveloperPosition(world, outcome, symbol);
      outcomes.push(outcome);
    }

    expect(world.journal.rows().map((row) => row.previousRecordId)).toEqual([
      undefined,
      outcomes[0]?.record.id,
      outcomes[1]?.record.id,
    ]);

    // Reading fewer listings changed nothing about what was recorded: the chain
    // still unwinds to the developer's file exactly.
    const pass = await reconcileSandbox(world.sandbox, world.pristine.path);

    expect(pass.outcome.status).toBe('clean');
    expect(pass.outcome.restored).toHaveLength(3);
    expectFileBytes(world.pristine.path, world.pristine.bytes);
  });

  it('lists nothing for a supplied parent that is the root, and once for one with ancestors', async () => {
    const world = chainWorld();
    const first = appliedOutcome(
      await world
        .patcherFor(1, world.journal)
        .patchTarget({ file: TARGET_FILE, symbol: TARGET_SYMBOL }),
    );

    // The caller names the root: there is no parent to look up and no
    // ancestry to walk, so the journal is not read at all.
    const rootAsParent = probeListings(world.journal);
    const second = appliedOutcome(
      await world
        .patcherFor(2, rootAsParent.journal)
        .patchTarget(
          { file: TARGET_FILE, symbol: 'findConeProfile' },
          { previousRecord: first.record },
        ),
    );

    expect(rootAsParent.listings()).toBe(0);
    expect(second.previousRecordId).toBe(first.record.id);
    expectDeveloperPosition(world, second, 'findConeProfile');

    // The caller names a parent with an ancestor: nothing has been listed yet,
    // so the walk lists the session itself — once.
    const withAncestor = probeListings(world.journal);
    const third = appliedOutcome(
      await world
        .patcherFor(3, withAncestor.journal)
        .patchTarget(
          { file: TARGET_FILE, symbol: OTHER_SYMBOL },
          { previousRecord: second.record },
        ),
    );

    expect(withAncestor.listings()).toBe(1);
    expect(third.previousRecordId).toBe(second.record.id);
    expectDeveloperPosition(world, third, OTHER_SYMBOL);
    expect(world.journal.rows().map((row) => row.previousRecordId)).toEqual([
      undefined,
      first.record.id,
      second.record.id,
    ]);
  });

  it("returns the journal's own error when the listing a supplied parent needs fails, writing nothing", async () => {
    const world = chainWorld();
    const links = await layTwoLinks(world);
    const beforeThird = readFileSync(world.pristine.path);
    const backupsBefore = sessionBackupsOf(world);
    const storeFailure = new DebuggenError('STORE_ERROR', 'The session could not be listed.', {
      hint: 'The suite refused the listing on purpose.',
      details: { reason: 'listing-refused' },
    });
    const probe = probeListings(world.journal, () => err(storeFailure));
    const { files, log } = recordingFileSystem();

    const error = refusalOf(
      await world
        .patcherFor(3, probe.journal, files)
        .patchTarget(
          { file: TARGET_FILE, symbol: OTHER_SYMBOL },
          { previousRecord: links.second.record },
        ),
    );

    expect(error).toBe(storeFailure);
    expect(probe.listings()).toBe(1);
    expect(log.writes).toEqual([]);
    expect(world.journal.rows()).toHaveLength(2);
    expect(sessionBackupsOf(world)).toEqual(backupsBefore);
    expectFileBytes(world.pristine.path, beforeThird);
  });

  it('refuses a walk whose root is missing from the listing', async () => {
    const world = chainWorld();
    const links = await layTwoLinks(world);

    const error = await expectRootWalkRefusal(
      world,
      links,
      (records) => records.filter((row) => row.id !== links.first.record.id),
      'chain-link-missing',
    );

    expect(error.details?.missingRecordId).toBe(links.first.record.id);
  });

  it('refuses a walk whose root links back to the parent', async () => {
    // The root still names this file and is still `applied`, so the parent
    // lookup passes over it to plan version 2's record exactly as before.
    const world = chainWorld();
    const links = await layTwoLinks(world);

    const error = await expectRootWalkRefusal(
      world,
      links,
      (records) =>
        records.map((row) =>
          row.id === links.first.record.id
            ? { ...row, previousRecordId: links.second.record.id }
            : row,
        ),
      'chain-cycle',
    );

    expect(error.details?.linkRecordId).toBe(links.second.record.id);
  });

  it('refuses a walk whose root describes another file', async () => {
    // The parent lookup skips a record of another file, so plan version 2's
    // record is still the parent; the walk then reaches that record by id.
    const world = chainWorld();
    const links = await layTwoLinks(world);

    const error = await expectRootWalkRefusal(
      world,
      links,
      (records) =>
        records.map((row) =>
          row.id === links.first.record.id ? { ...row, file: CHAIN_FILE } : row,
        ),
      'chain-link-other-file',
    );

    expect(error.details?.linkRecordId).toBe(links.first.record.id);
  });

  it("refuses a root backup whose bytes no longer hash to the root's original", async () => {
    // The listing is untouched; the root's backup keeps its name and mode but
    // holds other bytes. The parent's own backup — the one the baseline check
    // reads — is intact, so only the walk's digest check can refuse this.
    const world = chainWorld();
    const links = await layTwoLinks(world);
    const rootBackup = links.first.record.backupPath;
    const mode = permissionsOf(rootBackup);

    expect(sha256Hex(readFileSync(rootBackup))).toBe(world.pristine.hash);

    writeFileSync(
      rootBackup,
      Buffer.from(`${world.pristine.bytes.toString('utf8')}// not the developer's text\n`, 'utf8'),
    );

    expect(permissionsOf(rootBackup)).toBe(mode);
    expect(sha256Hex(readFileSync(rootBackup))).not.toBe(world.pristine.hash);

    const error = await expectRootWalkRefusal(
      world,
      links,
      (records) => records,
      'backup-digest-mismatch',
    );

    expect(error.details?.rootRecordId).toBe(links.first.record.id);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Targets and requests the sequence refuses
 * ---------------------------------------------------------------------------
 *
 * Each of these is gated somewhere upstream as well — `../feasibility.ts`
 * filters a plan's actions, `../installer.ts` orders them — and each is
 * asserted here anyway, because "the caller checked" is not a property of this
 * module and the file being written to belongs to somebody else.
 */

describe('requests the sequence refuses outright', () => {
  it('refuses a generator without reading, backing up or writing anything', async () => {
    const sandbox = makeSandbox();
    const pristine = pristineFile(sandbox, GENERATOR_FILE);
    const { patcher, journal, log } = buildPatcher(sandbox);

    const error = refusalOf(
      await patcher.patchTarget({ file: GENERATOR_FILE, symbol: GENERATOR_SYMBOL }),
    );

    // A wrapper that calls the body as a function cannot preserve `yield`, so
    // there is no template for this shape and guessing one would change what
    // the developer's code does.
    expect(error.code).toBe('PATCH_UNSUPPORTED');
    expect(error.details?.['reason']).toBe('unsupported-generator');
    expect(log.writes).toEqual([]);
    expect(journal.rows).toEqual([]);
    // The transform ran — it had to, to see the shape — but nothing was
    // recorded and no copy of the file was taken.
    expect(existsSync(join(sandbox.debuggenHome, 'backups', sandbox.sessionId))).toBe(false);
    expectPristine(pristine);
  });

  it('refuses the same file and symbol twice in one plan version', async () => {
    // Two records for one symbol in one plan version would each claim to own
    // the same edit, and the chain over that file would stop being unwindable.
    const sandbox = makeSandbox();
    const pristine = pristineFile(sandbox, CHAIN_FILE);
    const { patcher, journal } = buildPatcher(sandbox);
    const action = patchAction(CHAIN_FILE, CHAIN_FIRST_SYMBOL);

    const batch = await patcher.patchActions([action, { ...action, id: newActionId() }]);

    expect(batch.applied).toHaveLength(1);
    expect(batch.failure?.error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(batch.failure?.error.details?.['reason']).toBe('duplicate-action');
    expect(batch.failure?.stage).toBe('resolve-target');
    // Refused before anything was read for the second action, so the first
    // action's record is the only one and the file holds exactly its patch.
    expect(batch.journaled).toHaveLength(1);
    expect(journal.rows).toHaveLength(1);
    expect(digestOnDisk(pristine.path)).toBe(batch.applied[0]?.instrumentedHash);
    expect(temporaryLeftoversIn(dirname(pristine.path))).toEqual([]);
  });

  it('refuses a runtime-mode action, which asks for a hook rather than an edit', async () => {
    const sandbox = makeSandbox();
    const pristine = pristineFile(sandbox, CHAIN_FILE);
    const { patcher, journal, log } = buildPatcher(sandbox);

    const error = refusalOf(
      await patcher.patchAction({
        ...patchAction(CHAIN_FILE, CHAIN_FIRST_SYMBOL),
        type: 'react-render-tracking',
        adapter: 'react',
        mode: 'runtime',
      }),
    );

    expect(error.code).toBe('PATCH_UNSUPPORTED');
    expect(log.writes).toEqual([]);
    expect(journal.rows).toEqual([]);
    expectPristine(pristine);
  });
});

/*
 * ---------------------------------------------------------------------------
 * A cancelled install
 * ---------------------------------------------------------------------------
 */

describe('an install cancelled between stages', () => {
  it('stops at a stage boundary and leaves a state reconciliation restores', async () => {
    // `../installer.ts` aborts a failing install between actions. The signal is
    // honoured at stage boundaries only — never inside the rename, which is the
    // one interruption that could leave a half-known state — so the sequence
    // stops with the journal in a state the table already has an answer for.
    const sandbox = makeSandbox();
    const pristine = pristineFile(sandbox, CHAIN_FILE);
    const journal = openFileJournal(journalPathFor(sandbox));
    const controller = new AbortController();
    const stages: PatchStage[] = [];

    const error = refusalOf(
      await createPatcher({
        projectRoot: sandbox.projectRoot,
        sessionId: sandbox.sessionId,
        planVersion: 1,
        backups: createBackupStore({
          debuggenHome: sandbox.debuggenHome,
          sessionId: sandbox.sessionId,
        }),
        journal,
        signal: controller.signal,
        onStage: (event: PatchStageEvent) => {
          stages.push(event.stage);

          // Cancelled once the backup is durable. The signal is read at the
          // *next* stage boundary, which is the check that sits between the
          // journal append and the write — so this is the hardest boundary for
          // a cancellation to arrive at: a record exists by the time it is
          // seen, and it must not be left claiming a write is in flight.
          if (event.stage === 'store-backup') {
            controller.abort();
          }
        },
      }).patchTarget({ file: CHAIN_FILE, symbol: CHAIN_FIRST_SYMBOL }),
    );

    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.details?.['reason']).toBe('aborted');
    // Stopped at the boundary between the journal append and the write, which
    // is where the signal is read — never inside the rename, the one
    // interruption that could leave a half-known state.
    expect(error.details?.['stage']).toBe('journal-pending');
    expect(stages).toEqual([
      'resolve-target',
      'read-original',
      'baseline-check',
      'build-patch',
      'store-backup',
    ]);

    const row = onlyRow(journal);

    // `failed` rather than a `pending` row claiming a write is in flight — and
    // the table treats the two identically, so a cancelled install and a dead
    // process reconcile the same way.
    expect(row.status).toBe('failed');
    expectPristine(pristine);

    const pass = await reconcileSandbox(sandbox, pristine.path);

    expect(pass.outcome.status).toBe('clean');
    expect(pass.outcome.closed.map((record) => record.id)).toEqual([row.id]);
    expect(pass.outcome.restored).toEqual([]);
    expect(onlyRow(pass.journal).status).toBe('reverted');
    expectPristine(pristine);
    expect(backupExists(row)).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Byte fidelity across file kinds
 * ---------------------------------------------------------------------------
 *
 * Hashes are SHA-256 over raw bytes with no newline or encoding normalisation,
 * because the restore-versus-conflict decision is a comparison of those
 * digests. `packages/shared/src/node/hash.test.ts` pins that CRLF and LF
 * content hash differently; these cases are where that matters end to end — a
 * sequence that normalised line endings anywhere would hand back a file that is
 * *equivalent* to the developer's and not identical to it, and their next
 * `git diff` would show every line of it.
 *
 * A UTF-8 byte-order mark is the other encoding detail an editor leaves at the
 * front of a file, and `./patcher.ts` promises it is preserved **exactly once,
 * at byte 0** — never stripped, moved or duplicated — through the patch, the
 * journaled diff, a crash and the restore. The mark is planted in each case's
 * own sandbox copy, never in the committed fixture, and every marked file is
 * judged three ways: against the bytes the same sequence installs in an
 * unmarked copy (the mark is the *only* difference), against its pre-session
 * snapshot after the real `../cleanup.ts` has restored it (`Buffer.compare`
 * and SHA-256), and by counting the marks it holds (one, first).
 */

/** The three bytes a UTF-8 byte-order mark is written as. */
const UTF8_BYTE_ORDER_MARK = Buffer.from([0xef, 0xbb, 0xbf]);

/** The mark as a decoder that keeps it yields it: one U+FEFF code unit. */
const BYTE_ORDER_MARK_CHARACTER = '\uFEFF';

/**
 * Decodes bytes the way `./patcher.ts` reads them — strictly, and keeping a
 * leading byte-order mark as U+FEFF — so a comparison of texts is a comparison
 * of what the sequence itself read and wrote. The `TextDecoder` default would
 * strip the mark and make every assertion below blind to it.
 */
function decodeKeepingMark(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

/** Asserts `bytes` start with one UTF-8 byte-order mark and hold no other. */
function expectSingleLeadingMark(bytes: Buffer): void {
  expect(bytes.indexOf(UTF8_BYTE_ORDER_MARK)).toBe(0);
  expect(bytes.indexOf(UTF8_BYTE_ORDER_MARK, UTF8_BYTE_ORDER_MARK.length)).toBe(-1);
}

/**
 * Rewrites a sandbox file as an editor that writes a BOM saves it, then
 * snapshots it.
 *
 * The sandbox copy only, never the committed fixture — the last case in this
 * file digests that tree. The fixture file is asserted not to carry a mark of
 * its own, so the case is exercising the mark it planted rather than one it
 * happened to find.
 *
 * @param leading What to put in front of the file: one mark by default, or a
 * longer run of U+FEFF code units for the case that needs one.
 */
function plantByteOrderMark(
  sandbox: Sandbox,
  file: string,
  leading: Buffer = UTF8_BYTE_ORDER_MARK,
): Pristine {
  const path = join(sandbox.projectRoot, file);
  const unmarked = readFileSync(path);

  expect(unmarked.includes(UTF8_BYTE_ORDER_MARK)).toBe(false);

  writeFileSync(path, Buffer.concat([leading, unmarked]));
  chmodSync(path, PROJECT_FILE_MODE);

  const pristine = pristineFile(sandbox, file);

  expect(pristine.bytes.subarray(0, leading.length).equals(leading)).toBe(true);
  expect(pristine.bytes.indexOf(UTF8_BYTE_ORDER_MARK, leading.length)).toBe(-1);
  expect(pristine.hash).not.toBe(sha256Hex(unmarked));

  return pristine;
}

/**
 * What the real sequence installs for the same target in a second, unmarked
 * copy of the fixture.
 *
 * The yardstick for "the mark is the only difference": the transform addresses
 * positions in source text, so a marked file patched correctly is exactly the
 * mark followed by these bytes. A skew of even one code unit — a brace pulled
 * against the parameter list, a character dropped at the end of the wrapped
 * body — makes the comparison fail even where the result still parses.
 */
async function installedWithoutMark(file: string, symbol: string): Promise<Buffer> {
  const twin = makeSandbox('unmarked-twin');
  const { patcher } = buildPatcher(twin);

  appliedOutcome(await patcher.patchTarget({ file, symbol }));

  return readFileSync(join(twin.projectRoot, file));
}

/**
 * The lines a unified diff adds or removes, without their `+`/`-` prefix.
 *
 * Read from the first hunk header onwards, so the `---`/`+++` file headers are
 * never mistaken for changes and a changed line whose own text starts with `++`
 * or `--` is never mistaken for a header.
 */
function changedLinesOf(diff: string): string[] {
  const lines = diff.split('\n');
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));

  if (firstHunk < 0) {
    return [];
  }

  return lines
    .slice(firstHunk)
    .filter((line) => line.startsWith('+') || line.startsWith('-'))
    .map((line) => line.slice(1));
}

/**
 * Asserts the journaled diff describes exactly the marked bytes the two hashes
 * were taken over.
 *
 * Applied, not merely inspected — both user interfaces render it as "what the
 * tool did to my file" — and with the mark on both sides: the diff is rendered
 * from the full texts, so it must turn the marked original into the marked
 * patched text, and it must never add or remove the mark itself. Only line 1
 * carries it, so a changed line containing it would mean the patch moved,
 * dropped or doubled it.
 */
function expectDiffKeepsMark(diff: string, original: Buffer, installed: Buffer): void {
  expect(applyPatch(decodeKeepingMark(original), diff)).toBe(decodeKeepingMark(installed));

  const changed = changedLinesOf(diff);

  expect(changed.length).toBeGreaterThan(0);
  expect(changed.filter((line) => line.includes(BYTE_ORDER_MARK_CHARACTER))).toEqual([]);
}

/** The outcome of a successful restore, or a failed test naming the refusal. */
function restoredOutcome(result: Result<RestoreOutcome>): RestoreOutcome {
  if (isErr(result)) {
    throw new Error(
      `Expected the restore to succeed, received ${result.error.code}: ${result.error.message} ${JSON.stringify(result.error.details)}`,
    );
  }
  return result.value;
}

/**
 * Asserts a marked file holds exactly its pre-session bytes, mark first, after
 * a restore: by raw comparison and by digest, so a mistake in hashing cannot
 * hide a mistake in content, and with the mode the developer's file had.
 */
function expectMarkedFileRestored(pristine: Pristine): void {
  const restored = readFileSync(pristine.path);

  expectFileBytes(pristine.path, pristine.bytes);
  expect(Buffer.compare(restored, pristine.bytes)).toBe(0);
  expect(sha256Hex(restored)).toBe(pristine.hash);
  expect(restored.subarray(0, UTF8_BYTE_ORDER_MARK.length).equals(UTF8_BYTE_ORDER_MARK)).toBe(true);
  expectSingleLeadingMark(restored);
  expect(decodeKeepingMark(restored)).not.toContain(SPAN_HELPER_GLOBAL);
  expect(permissionsOf(pristine.path)).toBe(PROJECT_FILE_MODE);
  expect(temporaryLeftoversIn(dirname(pristine.path))).toEqual([]);
}

describe('byte fidelity across file kinds', () => {
  it('patches a plain JavaScript target without emitting TypeScript syntax', async () => {
    const sandbox = makeSandbox();
    const pristine = pristineFile(sandbox, JS_FILE);
    const { patcher, journal } = buildPatcher(sandbox);

    const outcome = appliedOutcome(await patcher.patchTarget({ file: JS_FILE, symbol: JS_SYMBOL }));

    const installed = readFileSync(pristine.path, 'utf8');

    expect(outcome.record.file).toBe(JS_FILE);
    expect(digestOnDisk(pristine.path)).toBe(outcome.instrumentedHash);
    expect(installed).toContain(SPAN_HELPER_GLOBAL);
    // The one-line type alias the template inserts into `.ts` and `.tsx` files
    // has no business in a `.js` file: it would not parse, and the dev server
    // would fail to compile the developer's project.
    expect(installed).not.toContain(SPAN_HELPER_TYPE_NAME);
    expect(installed).not.toContain(' as {');
    expect(journal.rows[0]?.status).toBe('applied');
    expect(permissionsOf(pristine.path)).toBe(PROJECT_FILE_MODE);
    expect(temporaryLeftoversIn(dirname(pristine.path))).toEqual([]);
  });

  it(
    'restores a plain JavaScript target byte for byte after a crash',
    async () => {
      const sandbox = makeSandbox();
      const pristine = pristineFile(sandbox, JS_FILE);

      await killDuringPatch(sandbox, {
        file: JS_FILE,
        symbol: JS_SYMBOL,
        crashAt: 'after-rename',
      });

      const pending = onlyRow(openFileJournal(journalPathFor(sandbox)));

      expect(pending.file).toBe(JS_FILE);
      expect(digestOnDisk(pristine.path)).toBe(pending.instrumentedHash);

      const pass = await reconcileSandbox(sandbox, pristine.path);

      expect(pass.outcome.status).toBe('clean');
      expect(pass.outcome.restored.map((record) => record.id)).toEqual([pending.id]);
      expectFileBytes(pristine.path, pristine.bytes);
      expect(Buffer.compare(readFileSync(pristine.path), pristine.bytes)).toBe(0);
      expectBackupDeletedAfterVerification(pass.backupEvents, pristine.hash);
    },
    CRASH_CASE_TIMEOUT_MS,
  );

  it(
    'restores CRLF content byte for byte, including the line endings',
    async () => {
      const sandbox = makeSandbox();
      const targetPath = join(sandbox.projectRoot, CHAIN_FILE);
      const lfBytes = readFileSync(targetPath);

      // A file as a Windows-configured editor left it. Written before anything
      // is snapshotted, so these bytes are what "the developer's file" means
      // for this case.
      writeFileSync(targetPath, lfBytes.toString('utf8').replace(/\n/g, '\r\n'));
      chmodSync(targetPath, PROJECT_FILE_MODE);

      const pristine = pristineFile(sandbox, CHAIN_FILE);

      expect(pristine.bytes.includes('\r\n')).toBe(true);
      // The distinction the whole guarantee rests on: the same text with
      // different line endings is different content.
      expect(pristine.hash).not.toBe(sha256Hex(lfBytes));

      await killDuringPatch(sandbox, {
        file: CHAIN_FILE,
        symbol: CHAIN_FIRST_SYMBOL,
        crashAt: 'after-mark',
      });

      const applied = onlyRow(openFileJournal(journalPathFor(sandbox)));

      expect(applied.status).toBe('applied');
      expect(applied.originalHash).toBe(pristine.hash);
      expect(sha256Hex(readFileSync(applied.backupPath))).toBe(pristine.hash);

      const pass = await reconcileSandbox(sandbox, pristine.path);

      expect(pass.outcome.status).toBe('clean');
      expect(pass.outcome.restored.map((record) => record.id)).toEqual([applied.id]);

      const restored = readFileSync(pristine.path);

      expect(Buffer.compare(restored, pristine.bytes)).toBe(0);
      expect(restored.includes('\r\n')).toBe(true);
      expect(sha256Hex(restored)).toBe(pristine.hash);
      expect(sha256Hex(restored)).not.toBe(sha256Hex(lfBytes));
      expect(permissionsOf(pristine.path)).toBe(PROJECT_FILE_MODE);
    },
    CRASH_CASE_TIMEOUT_MS,
  );

  it('patches a TypeScript target that starts with a byte-order mark and restores it byte for byte', async () => {
    const sandbox = makeSandbox();
    const pristine = plantByteOrderMark(sandbox, CHAIN_FILE);
    const { patcher, journal, backups } = buildPatcher(sandbox);

    // Applied at all: TypeScript tooling reads the mark as an encoding mark
    // rather than source text, and a sequence that handed it to the transform
    // had every marked TypeScript file refused as an introduced diagnostic.
    const outcome = appliedOutcome(
      await patcher.patchTarget({ file: CHAIN_FILE, symbol: CHAIN_FIRST_SYMBOL }),
    );
    const installed = readFileSync(pristine.path);

    expect(decodeKeepingMark(installed)).toContain(SPAN_HELPER_GLOBAL);
    expect(decodeKeepingMark(installed)).toContain(SPAN_HELPER_TYPE_NAME);

    // One mark, first, and nothing else different from the same patch of an
    // unmarked copy — so it was neither moved nor doubled, and no offset of
    // the patch was skewed by it.
    expectSingleLeadingMark(installed);
    expect(
      Buffer.compare(
        installed,
        Buffer.concat([
          UTF8_BYTE_ORDER_MARK,
          await installedWithoutMark(CHAIN_FILE, CHAIN_FIRST_SYMBOL),
        ]),
      ),
    ).toBe(0);

    // Both digests are over the marked bytes, and the backup holds them.
    expect(outcome.record.originalHash).toBe(pristine.hash);
    expect(outcome.originalHash).toBe(pristine.hash);
    expect(sha256Hex(installed)).toBe(outcome.instrumentedHash);
    expect(outcome.record.instrumentedHash).toBe(outcome.instrumentedHash);

    const backup = readFileSync(outcome.record.backupPath);

    expect(Buffer.compare(backup, pristine.bytes)).toBe(0);
    expect(sha256Hex(backup)).toBe(pristine.hash);

    // The transform's own result is relative to the text without the mark, as
    // `PatchOutcome.patch` documents, and the file is that result behind it.
    expect(outcome.patch.originalText).toBe(
      decodeKeepingMark(pristine.bytes).slice(BYTE_ORDER_MARK_CHARACTER.length),
    );
    expect(
      Buffer.compare(
        installed.subarray(UTF8_BYTE_ORDER_MARK.length),
        Buffer.from(outcome.patch.patchedText, 'utf8'),
      ),
    ).toBe(0);

    expectDiffKeepsMark(outcome.record.diff, pristine.bytes, installed);

    // The real restore, through the cleanup API the service calls.
    const restored = restoredOutcome(
      await restoreModification(outcome.record, {
        projectRoot: sandbox.projectRoot,
        backups,
        journal,
      }),
    );

    expect(restored.kind).toBe('restored');
    expect(restored.wrote).toBe(true);
    expect(restored.backup).toBe('deleted');
    expect(restored.conflict).toBeUndefined();
    expect(restored.record.status).toBe('reverted');
    expect(journal.rows[0]?.status).toBe('reverted');
    expectMarkedFileRestored(pristine);
    expect(existsSync(outcome.record.backupPath)).toBe(false);
  });

  it('patches a plain JavaScript target that starts with a byte-order mark and restores it byte for byte', async () => {
    // The kind a skewed transform does not refuse: plain JavaScript has no
    // type check to trip, so one code unit of skew is written out as a file
    // that still parses. The unmarked twin is what catches it.
    const sandbox = makeSandbox();
    const pristine = plantByteOrderMark(sandbox, JS_FILE);
    const { patcher, journal, backups } = buildPatcher(sandbox);

    const outcome = appliedOutcome(await patcher.patchTarget({ file: JS_FILE, symbol: JS_SYMBOL }));
    const installed = readFileSync(pristine.path);

    expect(decodeKeepingMark(installed)).toContain(SPAN_HELPER_GLOBAL);
    expect(decodeKeepingMark(installed)).not.toContain(SPAN_HELPER_TYPE_NAME);
    expectSingleLeadingMark(installed);
    expect(
      Buffer.compare(
        installed,
        Buffer.concat([UTF8_BYTE_ORDER_MARK, await installedWithoutMark(JS_FILE, JS_SYMBOL)]),
      ),
    ).toBe(0);

    expect(outcome.record.originalHash).toBe(pristine.hash);
    expect(sha256Hex(installed)).toBe(outcome.instrumentedHash);
    expect(Buffer.compare(readFileSync(outcome.record.backupPath), pristine.bytes)).toBe(0);
    expectDiffKeepsMark(outcome.record.diff, pristine.bytes, installed);

    const restored = restoredOutcome(
      await restoreModification(outcome.record, {
        projectRoot: sandbox.projectRoot,
        backups,
        journal,
      }),
    );

    expect(restored.kind).toBe('restored');
    expect(restored.wrote).toBe(true);
    expect(restored.backup).toBe('deleted');
    expect(journal.rows[0]?.status).toBe('reverted');
    expectMarkedFileRestored(pristine);
  });

  it(
    'restores a TypeScript target that starts with a byte-order mark after a crash between the rename and the mark',
    async () => {
      // The worker imports `./patcher.ts` by file URL, so this is the same
      // mark-preserving sequence in a process that is killed with the patch on
      // disk and the record still `pending`.
      const sandbox = makeSandbox();
      const pristine = plantByteOrderMark(sandbox, CHAIN_FILE);

      await killDuringPatch(sandbox, {
        file: CHAIN_FILE,
        symbol: CHAIN_FIRST_SYMBOL,
        crashAt: 'after-rename',
      });

      const before = openFileJournal(journalPathFor(sandbox));
      const pending = onlyRow(before);
      const onDisk = readFileSync(pristine.path);

      expect(before.crashPoint()).toBe('after-rename');
      expect(pending.status).toBe('pending');
      expect(pending.originalHash).toBe(pristine.hash);
      expect(digestOnDisk(pristine.path)).toBe(pending.instrumentedHash);
      expect(decodeKeepingMark(onDisk)).toContain(SPAN_HELPER_GLOBAL);
      expectSingleLeadingMark(onDisk);
      expect(sha256Hex(readFileSync(pending.backupPath))).toBe(pristine.hash);
      // The diff that outlived the process describes the marked bytes on disk.
      expectDiffKeepsMark(pending.diff, pristine.bytes, onDisk);

      const pass = await reconcileSandbox(sandbox, pristine.path);

      expect(pass.outcome.status).toBe('clean');
      expect(pass.outcome.restored.map((record) => record.id)).toEqual([pending.id]);
      expect(pass.outcome.closed).toEqual([]);
      expect(pass.outcome.conflicts).toEqual([]);
      expect(pass.outcome.failures).toEqual([]);
      expect(onlyRow(pass.journal).status).toBe('reverted');
      expectMarkedFileRestored(pristine);
      expectBackupDeletedAfterVerification(pass.backupEvents, pristine.hash);
      expect(backupExists(pending)).toBe(false);
    },
    CRASH_CASE_TIMEOUT_MS,
  );

  it('keeps a mark followed by a zero-width no-break space exactly as the file held them', async () => {
    // ts-morph drops one leading U+FEFF per parse, so a sequence that set
    // aside only the first of two would hand the transform text that still
    // began with one and reintroduce the skew one code unit later. The whole
    // leading run is set aside and put back, so the file keeps both.
    const leadingRun = Buffer.concat([UTF8_BYTE_ORDER_MARK, UTF8_BYTE_ORDER_MARK]);
    const sandbox = makeSandbox();
    const pristine = plantByteOrderMark(sandbox, JS_FILE, leadingRun);
    const { patcher, journal, backups } = buildPatcher(sandbox);

    const outcome = appliedOutcome(await patcher.patchTarget({ file: JS_FILE, symbol: JS_SYMBOL }));
    const installed = readFileSync(pristine.path);

    expect(
      Buffer.compare(
        installed,
        Buffer.concat([leadingRun, await installedWithoutMark(JS_FILE, JS_SYMBOL)]),
      ),
    ).toBe(0);
    expect(installed.indexOf(UTF8_BYTE_ORDER_MARK, leadingRun.length)).toBe(-1);
    expect(sha256Hex(installed)).toBe(outcome.instrumentedHash);
    expect(applyPatch(decodeKeepingMark(pristine.bytes), outcome.record.diff)).toBe(
      decodeKeepingMark(installed),
    );

    const restored = restoredOutcome(
      await restoreModification(outcome.record, {
        projectRoot: sandbox.projectRoot,
        backups,
        journal,
      }),
    );

    expect(restored.kind).toBe('restored');
    expect(Buffer.compare(readFileSync(pristine.path), pristine.bytes)).toBe(0);
    expect(digestOnDisk(pristine.path)).toBe(pristine.hash);
  });

  it('drops a mark the transform itself emits, so the file never carries two', async () => {
    // The real transform never emits one; this is the guard that keeps a
    // transform which did from writing the mark twice. It is handed text with
    // no mark, and whatever mark leads its output is replaced by the file's own.
    const sandbox = makeSandbox();
    const pristine = plantByteOrderMark(sandbox, CHAIN_FILE);
    const real = new FunctionTimingPatcher({ projectRoot: sandbox.projectRoot });
    const handed: (string | undefined)[] = [];

    const outcome = appliedOutcome(
      await createPatcher({
        projectRoot: sandbox.projectRoot,
        sessionId: sandbox.sessionId,
        planVersion: 1,
        backups: createBackupStore({
          debuggenHome: sandbox.debuggenHome,
          sessionId: sandbox.sessionId,
        }),
        journal: createTestJournal(),
        transform: (request) => {
          handed.push(request.text);

          const patched = real.patch(request);

          return isErr(patched)
            ? patched
            : ok({
                ...patched.value,
                patchedText: `${BYTE_ORDER_MARK_CHARACTER}${patched.value.patchedText}`,
              });
        },
      }).patchTarget({ file: CHAIN_FILE, symbol: CHAIN_FIRST_SYMBOL }),
    );
    const installed = readFileSync(pristine.path);

    expect(handed).toHaveLength(1);
    expect(handed[0]?.startsWith(BYTE_ORDER_MARK_CHARACTER)).toBe(false);
    expectSingleLeadingMark(installed);
    expect(
      Buffer.compare(
        installed,
        Buffer.concat([
          UTF8_BYTE_ORDER_MARK,
          await installedWithoutMark(CHAIN_FILE, CHAIN_FIRST_SYMBOL),
        ]),
      ),
    ).toBe(0);
    expect(sha256Hex(installed)).toBe(outcome.instrumentedHash);
    expectDiffKeepsMark(outcome.record.diff, pristine.bytes, installed);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The committed fixture
 * ---------------------------------------------------------------------------
 */

describe('the committed fixture project', () => {
  it('is byte-identical after the whole suite has run against copies of it', () => {
    // The real patcher, the real backup store and the real cleanup have run
    // dozens of times by now, each on a copy. If any of them ever addressed the
    // committed tree instead, `git status --porcelain packages/instrumentation`
    // would stop being empty and this repository would carry instrumentation in
    // its own fixtures. The digest is taken at module load — before any case
    // runs — and compared here, which is the last case in the file.
    expect(digestOfFixtureTree()).toBe(FIXTURE_TREE_DIGEST);
  });
});
